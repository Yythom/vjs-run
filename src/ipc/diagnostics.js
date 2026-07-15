// 杂项诊断/调试类 IPC：
//   - check-env：体检面板，检测 node/pnpm/git 等工具是否就绪
//   - check-ports / kill-single-port：端口占用查看器
//   - run-project-command：在项目目录里执行调试命令（流式日志）

import { exec } from "node:child_process";
import { ipcMain, dialog } from "electron";
import fs from "node:fs";
import { ipcSafe } from "./safe.js";
import { buildSpawnEnv } from "../shell-env.js";
import { killPort } from "../port-utils.js";
import { getProjectById, getProjectRepo } from "../config/lookup.js";
import { runStreaming } from "../process-manager.js";
import { sendLog } from "../ui-channel.js";

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
}

// ─── 体检（check-env）────────────────────────────────────────────────────────

// install: 缺失时显示的安装命令（macOS-only 应用，优先 brew，brew 自身用官方一行脚本）
const ENV_TOOLS = [
  {
    id: "node",
    label: "Node.js",
    cmd: "node -v",
    // 用 nvm 安装：一行包含「装 nvm + 装 Node LTS」，已装过 nvm 也安全（脚本会跳过）
    // 用 master 而非 pinned tag，免去定期手动升级版本号
    install:
      "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash && nvm install --lts",
  },
  {
    id: "pnpm",
    label: "pnpm",
    cmd: "pnpm -v",
    install: "brew install pnpm && pnpm setup",
  },
  {
    id: "git",
    label: "Git",
    cmd: "git --version",
    install: "xcode-select --install",
  },
  {
    id: "brew",
    label: "Homebrew",
    cmd: "brew --version",
    install:
      '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
  },
  {
    id: "pm2",
    label: "pm2",
    cmd: "pm2 --version",
    install: "npm install -g pm2",
  },
];

function checkOneEnvTool({ id, label, cmd, install }) {
  return new Promise((resolve) => {
    exec(cmd, { env: buildSpawnEnv() }, (err, stdout) => {
      if (err || !stdout.trim()) {
        resolve({ id, label, cmd, install, version: null, status: "missing" });
        return;
      }
      // 只取第一行，避免 brew 等多行输出干扰
      resolve({
        id,
        label,
        cmd,
        install,
        version: stdout.trim().split("\n")[0],
        status: "ok",
      });
    });
  });
}

// ─── 端口占用查看（check-ports）────────────────────────────────────────────────

function inspectOnePort(port) {
  return new Promise((resolve) => {
    // lsof -P 不解析端口名，-n 不解析主机名，速度更快
    exec(
      `/usr/sbin/lsof -iTCP:${port} -sTCP:LISTEN -P -n`,
      { env: buildSpawnEnv() },
      (err, stdout) => {
        if (err || !stdout.trim()) {
          resolve({ port, inUse: false, pid: null, name: null });
          return;
        }
        // 跳过 lsof 标题行，取第一条匹配
        const line = stdout.trim().split("\n").slice(1)[0];
        if (!line) {
          resolve({ port, inUse: false, pid: null, name: null });
          return;
        }
        const parts = line.trim().split(/\s+/);
        resolve({
          port,
          inUse: true,
          name: parts[0] || null,
          pid: parts[1] ? parseInt(parts[1], 10) : null,
        });
      },
    );
  });
}

// ─── 调试命令（run-project-command）─────────────────────────────────────────

async function execDebugCommand(_, { projectId, command }) {
  const id = String(projectId);
  const project = getProjectById(id);
  if (!project) return { success: false, error: "Project not found" };

  const cmd = String(command || "").trim();
  if (!cmd) return { success: false, error: "Command is empty" };

  const repo = getProjectRepo(project);
  if (!repo.path) return { success: false, error: `${repo.label} 路径未配置` };

  // 记录命令头，方便在同一日志面板区分手动调试输出
  sendLog(id, `\x1b[35m🛠 Debug command (${project.name})\x1b[0m\n`);

  try {
    const { code } = await runStreaming(id, cmd, { cwd: repo.path });
    sendLog(
      id,
      code === 0
        ? `\x1b[32m✔ Debug command finished (code ${code})\x1b[0m\n`
        : `\x1b[31m✗ Debug command exited with code ${code}\x1b[0m\n`,
    );
    return { success: code === 0, code };
  } catch (err) {
    sendLog(id, `\x1b[31m✗ Debug command error: ${err.message}\x1b[0m\n`);
    return { success: false, error: err.message };
  }
}

// ─── 注册入口 ────────────────────────────────────────────────────────────────

export function registerDiagnosticsIpc() {
  // 并发执行所有版本检测，返回结果数组
  ipcMain.handle("check-env", () =>
    Promise.all(ENV_TOOLS.map(checkOneEnvTool)),
  );

  // 查询指定端口列表的占用情况
  ipcMain.handle("check-ports", async (_, payload = {}) => {
    const ports = Array.isArray(payload?.ports) ? payload.ports : [];
    if (!ports.length) return [];
    return Promise.all(ports.map(inspectOnePort));
  });

  // 单端口 kill（端口查看器中逐行操作使用）
  ipcSafe("kill-single-port", (_, { port }) => killPort(port));

  // 在项目目录执行调试命令（注意保留原 ipcMain.handle 形态以维持 { success, code } 返回）
  ipcMain.handle("run-project-command", execDebugCommand);

  // 导出日志到本地文件，去除 ANSI 颜色控制字符
  ipcMain.handle("export-log", async (_, { logText, defaultFilename }) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: "导出日志",
      defaultPath: defaultFilename || "terminal.log",
      filters: [{ name: "Log Files", extensions: ["log", "txt"] }],
    });
    if (canceled || !filePath) {
      return { success: false, error: "canceled" };
    }
    try {
      const cleanText = stripAnsi(logText);
      fs.writeFileSync(filePath, cleanText, "utf8");
      return { success: true, filePath };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}
