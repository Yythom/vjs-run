// 杂项诊断/调试类 IPC：
//   - check-env：体检面板，检测 node/pnpm/git 等工具是否就绪
//   - install-cli / uninstall-cli：把 app 内置的 vjtools 命令装到 PATH / 从 PATH 移除（见 services/cli-shim.js）
//   - check-ports / kill-single-port：端口占用查看器
//   - run-project-command：在项目目录里执行调试命令（流式日志）

import { exec, execFile } from "node:child_process";
import { app, ipcMain, dialog } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ipcSafe } from "./safe.js";
import { buildSpawnEnv } from "../shell-env.js";
import { killPort } from "../port-utils.js";
import { getProjectById, getProjectRepo } from "../config/lookup.js";
import { runStreaming } from "../process-manager.js";
import { sendLog } from "../ui-channel.js";
import {
  cliShimPath,
  findCliLinks,
  getCliStatus,
  installCliLink,
  uninstallCliLink,
} from "../services/cli-shim.js";

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
}

// ─── 体检（check-env）────────────────────────────────────────────────────────

// mock-rules skill 的全局安装位置：`npx skills add -g` 落在 ~/.agents/skills 并软链进 ~/.claude/skills，
// agy 读 ~/.gemini/config/skills。只认用户目录——仓库自带的 .claude/skills 只对 vjs-run 自己生效，
// 算进来会让开发模式下永远显示「已就绪」
const MOCK_SKILL_DIRS = [
  [".claude", "skills"],
  [".agents", "skills"],
  [".gemini", "config", "skills"],
  [".config", "skills"],
];

function detectMockSkill() {
  const home = os.homedir();
  // 认 SKILL.md 而不是目录：软链断了或只剩空目录都算没装
  return MOCK_SKILL_DIRS.some((dir) =>
    fs.existsSync(path.join(home, ...dir, "mock-rules", "SKILL.md")),
  );
}

// vjtools 命令行：AI（mock-rules skill）用 mock 全靠它。来源有两种——app 内置（体检页点「安装到命令行」）
// 或单独 npm i -g vjtools-cli；PATH 上有任意一种即可
async function inspectVjtoolsCli() {
  const env = await buildSpawnEnv();
  const shimPath = cliShimPath(app.getPath("userData"));
  const status = getCliStatus({ shimPath, pathEnv: env.PATH });
  // 有本 app 装的软链就能移除；PATH 上排第一的可能是 npm 装的，也可能根本不在 PATH 上（授权装进 /usr/local/bin 时）
  const canUninstall = findCliLinks({ shimPath, pathEnv: env.PATH }).length > 0;
  if (!status.onPath) {
    return {
      status: "missing",
      version: null,
      cmd: status.shimReady ? `内置命令已就绪，未加入 PATH：${shimPath}` : "终端里还没有 vjtools 命令",
      // 开发模式不生成内置命令（见 main.js），只能提示 npm 安装
      canInstall: status.shimReady,
      canUninstall,
    };
  }
  const version = await new Promise((resolve) => {
    execFile(status.onPath, ["--version"], { env, timeout: 15_000 }, (err, stdout) =>
      resolve(err ? null : stdout.trim().split("\n")[0]),
    );
  });
  return {
    status: version ? "ok" : "missing",
    version: version && `${version}（${status.source === "app" ? "app 内置" : "单独安装"}）`,
    cmd: status.onPath,
    canInstall: false,
    canUninstall,
  };
}

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
    id: "mock-skill",
    label: "Mock Skill",
    // 不是命令行工具，没有版本号可查：cmd 只给卡片展示检测位置，实际由 detect 判断
    cmd: "~/.claude/skills/mock-rules 等目录",
    install:
      "npx skills add https://github.com/Yythom/vjs-run/tree/main/.claude/skills/mock-rules -g -y",
    detect: detectMockSkill,
  },
  {
    id: "vjtools-cli",
    label: "vjtools 命令行",
    // 缺失时卡片优先给「安装到命令行」按钮（app 内置）；这条是不想用内置时的替代方案
    install: "npm i -g vjtools-cli",
    inspect: inspectVjtoolsCli,
  },
];

async function checkOneEnvTool({ id, label, cmd, install, detect, inspect }) {
  if (inspect) return { id, label, install, ...(await inspect()) };
  if (detect) {
    const ok = detect();
    return {
      id,
      label,
      cmd,
      install,
      version: ok ? "已就绪 (mock-rules)" : null,
      status: ok ? "ok" : "missing",
    };
  }

  const env = await buildSpawnEnv();
  return new Promise((resolve) => {
    exec(cmd, { env }, (err, stdout) => {
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

async function inspectOnePort(port) {
  const env = await buildSpawnEnv();
  return new Promise((resolve) => {
    // lsof -P 不解析端口名，-n 不解析主机名，速度更快
    exec(
      `/usr/sbin/lsof -iTCP:${port} -sTCP:LISTEN -P -n`,
      { env },
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

  // 把 app 内置的 vjtools 命令软链进 PATH；可能弹系统授权框（PATH 上没有可写的常规目录时）
  ipcSafe("install-cli", async () => {
    const env = await buildSpawnEnv();
    return installCliLink({ shimPath: cliShimPath(app.getPath("userData")), pathEnv: env.PATH });
  });

  // 删掉 app 装进 PATH 的 vjtools 软链（npm 装的不碰）；目录不可写时同样弹授权框
  ipcSafe("uninstall-cli", async () => {
    const env = await buildSpawnEnv();
    return uninstallCliLink({ shimPath: cliShimPath(app.getPath("userData")), pathEnv: env.PATH });
  });

  // 查询指定端口列表的占用情况
  ipcMain.handle("check-ports", async (_, payload = {}) => {
    const ports = Array.isArray(payload?.ports) ? payload.ports : [];
    if (!ports.length) return [];
    return Promise.all(ports.map(inspectOnePort));
  });

  // 单端口 kill（端口查看器中逐行操作使用）
  ipcSafe("kill-single-port", async (_, { port }) => {
    // mock server 在主进程内跑，killPort 会排除 process.pid（否则杀掉自己闪退），
    // 这里提前识别并给出提示，避免"什么都没杀却提示已释放"。
    const info = await inspectOnePort(port);
    if (info.inUse && info.pid === process.pid) {
      throw new Error(
        `端口 ${port} 被本应用的 Mock 服务占用，请到 Mock 页面停止服务来释放`,
      );
    }
    return killPort(port);
  });

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
