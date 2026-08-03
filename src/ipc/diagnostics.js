// 杂项诊断/调试类 IPC：
//   - check-env：体检面板，检测 node/pnpm/git 等工具是否就绪
//   - check-ports / kill-single-port：端口占用查看器
//   - run-project-command：在项目目录里执行调试命令（流式日志）

import { exec, execSync } from "node:child_process";
import { ipcMain, dialog } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ipcSafe } from "./safe.js";
import { buildSpawnEnv } from "../shell-env.js";
import { killPort } from "../port-utils.js";
import { getProjectById, getProjectRepo } from "../config/lookup.js";
import { getConfig, saveConfig } from "../config/store.js";
import {
  normalizeNodeProvider,
  normalizeNodeVersion,
} from "../config/normalize.js";
import {
  detectNodeManager,
  findNodeVersion,
  getNvmDir,
  getSelectedNodeInfo,
  listNodeProviders,
  listNodeVersions,
} from "../node-manager.js";
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

/** node 实际解析到哪个可执行文件。PATH 已被 buildSpawnEnv 处理过，结果即真实生效的那个 */
function resolveBinPath(bin) {
  return new Promise((resolve) => {
    exec(`command -v ${bin}`, { env: buildSpawnEnv() }, (err, stdout) => {
      resolve(err ? "" : stdout.trim().split("\n")[0] || "");
    });
  });
}

/**
 * 给 node 卡片补上版本管理信息：来源、可切换版本列表（nvm + n）、当前选中值。
 * 一个版本都没探测到时 nodeVersions 为空数组，前端据此隐藏切换下拉。
 */
/**
 * 给 node 卡片补上版本管理信息：来源、可切换版本列表（nvm）、当前选中值。
 * 一个版本都没探测到时 nodeVersions 为空数组。
 */
async function withNodeManagerInfo(row) {
  const binPath = await resolveBinPath("node");
  const selected = getSelectedNodeInfo();
  return {
    ...row,
    binPath,
    manager: detectNodeManager(binPath),
    providers: listNodeProviders(),
    nodeVersions: listNodeVersions().map(({ version, provider }) => ({
      version,
      provider,
    })),
    selectedProvider: selected?.provider || getConfig().nodeProvider || "nvm",
    selectedVersion: selected?.version || "",
    nvmInstalled: fs.existsSync(path.join(getNvmDir(), "nvm.sh")),
  };
}

// ─── nvm 版本安装（install-nvm / install-node-version）──────────────────────

// 官方安装脚本 + 立刻装一个 LTS。分成两步是因为 install.sh 只把 nvm 本体装到
// ~/.nvm 并往 ~/.zshrc 追加初始化代码，此时一个 node 版本都还没有；必须在同一个
// bash 里 source 出 nvm 函数再 nvm install，装完 ~/.nvm/versions/node/ 才有东西，
// 体检页重新检测才能在下拉里看到它。
// 用 master 而非 pinned tag，免去定期手动升级版本号。
const NVM_INSTALL_SCRIPT = [
  "set -e",
  "unset npm_config_prefix",
  "unset NPM_CONFIG_PREFIX",
  "[ -f \"$HOME/.npmrc\" ] && sed -i '' '/^prefix=/d; /^globalconfig=/d' \"$HOME/.npmrc\" 2>/dev/null || true",
  'curl -fsSL -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash',
  'export NVM_DIR="$HOME/.nvm"',
  '. "$NVM_DIR/nvm.sh"',
  "nvm install --lts",
  "nvm use --delete-prefix lts/*",
  "nvm alias default lts/*",
].join("\n");

// 伪 projectId：复用 runStreaming 的日志广播，体检页按这个 id 过滤 process-log
export const ENV_INSTALL_LOG_ID = "__env-install__";

async function installNvm() {
  if (fs.existsSync(path.join(getNvmDir(), "nvm.sh"))) {
    throw new Error("nvm 已安装，无需重复安装");
  }
  sendLog(ENV_INSTALL_LOG_ID, null);
  sendLog(ENV_INSTALL_LOG_ID, "\x1b[35m⬇ 正在安装 nvm 并拉取最新 LTS…\x1b[0m\n");

  const { code } = await runStreaming(
    ENV_INSTALL_LOG_ID,
    // 脚本走 stdin，避免多行内容被拼进命令行时的引号转义问题
    `/bin/bash -s <<'VJTOOLS_NVM_EOF'\n${NVM_INSTALL_SCRIPT}\nVJTOOLS_NVM_EOF`,
    { cwd: os.homedir() },
  );

  if (code !== 0) {
    // raw.githubusercontent.com 在国内经常连不通，这是最常见的失败原因
    throw new Error(
      `安装失败（退出码 ${code}）。若卡在 curl，多半是访问 raw.githubusercontent.com 受阻，可挂代理后重试或手动执行安装命令`,
    );
  }
  sendLog(ENV_INSTALL_LOG_ID, "\x1b[32m✔ nvm 安装完成\x1b[0m\n");
  return { versions: listNodeVersions().map((item) => item.version) };
}

async function uninstallNvm() {
  const nvmDir = getNvmDir();
  sendLog(ENV_INSTALL_LOG_ID, null);
  sendLog(ENV_INSTALL_LOG_ID, "\x1b[35m🗑️ 正在一键清理 nvm 目录及 shell 配置文件…\x1b[0m\n");

  if (fs.existsSync(nvmDir)) {
    fs.rmSync(nvmDir, { recursive: true, force: true });
  }

  const profileFiles = [
    path.join(os.homedir(), ".zshrc"),
    path.join(os.homedir(), ".bash_profile"),
    path.join(os.homedir(), ".bashrc"),
  ];

  for (const file of profileFiles) {
    if (fs.existsSync(file)) {
      try {
        const content = fs.readFileSync(file, "utf8");
        const cleanLines = content
          .split("\n")
          .filter(
            (line) =>
              !line.includes("NVM_DIR") &&
              !line.includes("nvm.sh") &&
              !line.includes("nvm bash_completion"),
          );
        fs.writeFileSync(file, cleanLines.join("\n"), "utf8");
      } catch (_) {
        // 忽略单文件读写异常
      }
    }
  }

  saveConfig({ nodeProvider: "", nodeVersion: "" });
  sendLog(ENV_INSTALL_LOG_ID, "\x1b[32m✔ nvm 已成功彻底卸载，配置文件已清理\x1b[0m\n");
  return { success: true };
}

async function installPnpmVersion(_, { version }) {
  const raw = String(version || "").trim();
  if (!raw || !/^(latest|lts|[vV]?\d+(\.\d+){0,2})$/i.test(raw)) {
    throw new Error("请输入有效的 pnpm 版本号（例如 9.15.0 或 10）");
  }
  const cleanVer = raw.replace(/^v/i, "");
  const pkgTarget = /^\d/.test(cleanVer) ? `pnpm@${cleanVer}` : `pnpm@${cleanVer}`;

  sendLog(ENV_INSTALL_LOG_ID, null);
  sendLog(
    ENV_INSTALL_LOG_ID,
    `\x1b[35m⬇ 正在通过 npm 全局安装 ${pkgTarget}…\x1b[0m\n`,
  );

  const script = [
    "set -e",
    "unset npm_config_prefix",
    "unset NPM_CONFIG_PREFIX",
    '[ -f "$HOME/.npmrc" ] && sed -i \'\' \'/^prefix=/d; /^globalconfig=/d\' "$HOME/.npmrc" 2>/dev/null || true',
    `export NVM_DIR="${getNvmDir()}"`,
    '. "$NVM_DIR/nvm.sh"',
    `npm install -g ${pkgTarget}`,
  ].join("\n");

  const { code } = await runStreaming(
    ENV_INSTALL_LOG_ID,
    `/bin/bash -s <<'VJTOOLS_PNPM_EOF'\n${script}\nVJTOOLS_PNPM_EOF`,
    { cwd: os.homedir() },
  );

  if (code !== 0) {
    throw new Error(`安装 ${pkgTarget} 失败（退出码 ${code}）`);
  }

  sendLog(
    ENV_INSTALL_LOG_ID,
    `\x1b[32m✔ ${pkgTarget} 已成功安装并生效\x1b[0m\n`,
  );
  return { success: true, version: cleanVer };
}

async function installNodeVersion(_, { version }) {
  const raw = String(version || "").trim();
  if (!raw || !/^(lts|latest|[vV]?\d+(\.\d+){0,2})$/i.test(raw)) {
    throw new Error("请输入有效的 Node 版本号（例如 18.20.0 或 22）");
  }

  const nvmSh = path.join(getNvmDir(), "nvm.sh");
  if (!fs.existsSync(nvmSh)) {
    throw new Error("未检测到 nvm，请先一键安装 nvm");
  }

  const isLts = raw.toLowerCase() === "lts";
  const cleanVer = isLts ? "LTS" : raw.replace(/^v/i, "");
  const nvmInstallTarget = isLts ? "--lts" : cleanVer;
  const nvmUseTarget = isLts ? "lts/*" : cleanVer;

  sendLog(ENV_INSTALL_LOG_ID, null);
  sendLog(
    ENV_INSTALL_LOG_ID,
    `\x1b[35m⬇ 正在通过 nvm 配置/覆盖 Node (${cleanVer}) 为默认版本…\x1b[0m\n`,
  );

  const script = [
    "set -e",
    "unset npm_config_prefix",
    "unset NPM_CONFIG_PREFIX",
    "[ -f \"$HOME/.npmrc\" ] && sed -i '' '/^prefix=/d; /^globalconfig=/d' \"$HOME/.npmrc\" 2>/dev/null || true",
    `export NVM_DIR="${getNvmDir()}"`,
    '. "$NVM_DIR/nvm.sh"',
    `nvm install ${nvmInstallTarget}`,
    `nvm use --delete-prefix ${nvmUseTarget}`,
    `nvm alias default ${nvmUseTarget}`,
  ].join("\n");

  const { code } = await runStreaming(
    ENV_INSTALL_LOG_ID,
    `/bin/bash -s <<'VJTOOLS_NODE_EOF'\n${script}\nVJTOOLS_NODE_EOF`,
    { cwd: os.homedir() },
  );

  if (code !== 0) {
    throw new Error(`Node ${cleanVer} 配置失败（退出码 ${code}）`);
  }

  // 匹配新安装/已生效的版本号，自动切换
  const installedList = listNodeVersions();
  const matched = isLts
    ? installedList.find((item) => item.provider === "nvm")
    : installedList.find(
        (item) =>
          item.provider === "nvm" &&
          (item.version === cleanVer || item.version.startsWith(`${cleanVer}.`)),
      ) || installedList.find((item) => item.provider === "nvm");

  if (matched) {
    saveConfig({ nodeProvider: "nvm", nodeVersion: matched.version });
    ensureIsolatedPnpm(matched.version);
  }

  sendLog(
    ENV_INSTALL_LOG_ID,
    `\x1b[32m✔ Node ${matched?.version || cleanVer} 已成功配置为 nvm 默认版本，已准备好隔离的 pnpm\x1b[0m\n`,
  );
  return { provider: "nvm", version: matched?.version || cleanVer };
}

/**
 * 自动清除旧的 ~/.npm-global 以及非 nvm 的全局 pnpm 残留，并确保所有已安装的 nvm node 版本下都含有专属隔离的 pnpm
 */
function ensureIsolatedPnpm() {
  // 1. 清理旧的全局 ~/.npm-global 目录与 shell 配置文件 (.zshrc, .bash_profile) 干扰残留
  const legacyDir = path.join(os.homedir(), ".npm-global");
  if (fs.existsSync(legacyDir)) {
    try {
      fs.rmSync(legacyDir, { recursive: true, force: true });
    } catch (_) {
      // 容错处理
    }
  }

  const profileFiles = [
    path.join(os.homedir(), ".zshrc"),
    path.join(os.homedir(), ".bash_profile"),
    path.join(os.homedir(), ".bashrc"),
  ];
  for (const file of profileFiles) {
    if (fs.existsSync(file)) {
      try {
        const content = fs.readFileSync(file, "utf8");
        if (content.includes(".npm-global")) {
          const cleanLines = content
            .split("\n")
            .filter((line) => !line.includes(".npm-global"));
          fs.writeFileSync(file, cleanLines.join("\n"), "utf8");
        }
      } catch (_) {
        // 容错处理
      }
    }
  }

  // 2. 使用 which pnpm 动态嗅探：如果当前 which 指向的不是 nvm 目录下的 pnpm，自动进行清理
  try {
    const currentWhich = execSync("which pnpm", {
      encoding: "utf8",
      env: process.env,
    }).trim();
    if (currentWhich && !currentWhich.includes("/.nvm/versions/node/")) {
      if (fs.existsSync(currentWhich)) {
        fs.rmSync(currentWhich, { force: true });
      }
    }
  } catch (_) {
    // 忽略 which 未找到的异常
  }

  // 3. 为所有已安装的 nvm node 版本都补充安装专属隔离版 pnpm
  const allVersions = listNodeVersions();
  for (const { version } of allVersions) {
    const targetBin = path.join(
      getNvmDir(),
      "versions",
      "node",
      `v${version}`,
      "bin",
    );
    const pnpmBin = path.join(targetBin, "pnpm");

    if (fs.existsSync(targetBin) && !fs.existsSync(pnpmBin)) {
      const script = [
        "unset npm_config_prefix",
        "unset NPM_CONFIG_PREFIX",
        `export NVM_DIR="${getNvmDir()}"`,
        '. "$NVM_DIR/nvm.sh"',
        `nvm use ${version}`,
        "npm install -g pnpm",
      ].join("\n");
      try {
        execSync(`/bin/bash -c "${script.replace(/"/g, '\\"')}"`, {
          cwd: os.homedir(),
          stdio: "ignore",
        });
      } catch (_) {
        // 容错处理
      }
    }
  }
}

async function uninstallNodeVersion(_, { version }) {
  const cleanVer = normalizeNodeVersion(version);
  if (!cleanVer) {
    throw new Error("无效的版本号");
  }

  const nvmSh = path.join(getNvmDir(), "nvm.sh");
  if (!fs.existsSync(nvmSh)) {
    throw new Error("未检测到 nvm");
  }

  const targetDir = path.join(getNvmDir(), "versions", "node", `v${cleanVer}`);
  const targetDirNoV = path.join(getNvmDir(), "versions", "node", cleanVer);

  sendLog(ENV_INSTALL_LOG_ID, null);
  sendLog(
    ENV_INSTALL_LOG_ID,
    `\x1b[35m🗑️ 正在通过 nvm 卸载 Node ${cleanVer}…\x1b[0m\n`,
  );

  const script = [
    "set -e",
    "unset npm_config_prefix",
    "unset NPM_CONFIG_PREFIX",
    "[ -f \"$HOME/.npmrc\" ] && sed -i '' '/^prefix=/d; /^globalconfig=/d' \"$HOME/.npmrc\" 2>/dev/null || true",
    `export NVM_DIR="${getNvmDir()}"`,
    '. "$NVM_DIR/nvm.sh"',
    `nvm uninstall ${cleanVer}`,
  ].join("\n");

  try {
    await runStreaming(
      ENV_INSTALL_LOG_ID,
      `/bin/bash -s <<'VJTOOLS_NODE_EOF'\n${script}\nVJTOOLS_NODE_EOF`,
      { cwd: os.homedir() },
    );
  } catch (_) {
    // 即使 nvm uninstall 脚本部分失败，也物理删除该版本目录做兜底
  }

  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
  if (fs.existsSync(targetDirNoV)) {
    fs.rmSync(targetDirNoV, { recursive: true, force: true });
  }

  // 如果卸载的是当前选中的版本，回退配置
  const cfg = getConfig();
  if (cfg.nodeVersion === cleanVer) {
    const remaining = listNodeVersions();
    saveConfig({
      nodeProvider: remaining.length > 0 ? "nvm" : "",
      nodeVersion: remaining[0]?.version || "",
    });
  }

  sendLog(
    ENV_INSTALL_LOG_ID,
    `\x1b[32m✔ Node ${cleanVer} 已成功卸载\x1b[0m\n`,
  );

  return { success: true, version: cleanVer };
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
  ipcMain.handle("check-env", async () => {
    const rows = await Promise.all(ENV_TOOLS.map(checkOneEnvTool));
    return Promise.all(
      rows.map((row) => (row.id === "node" ? withNodeManagerInfo(row) : row)),
    );
  });

  // 切换 node 版本：写 config，并同步更新 nvm default 别名。
  // 实际生效靠 buildSpawnEnv() 把该版本 bin 前置到 PATH。
  ipcSafe("set-node-version", async (_, { provider, version }) => {
    const nodeProvider = normalizeNodeProvider(provider);
    const nodeVersion = normalizeNodeVersion(version);
    if (!nodeProvider) {
      saveConfig({ nodeProvider: "", nodeVersion: "" });
      return { provider: "", version: "" };
    }
    // 允许仅保存管理器（此时 nodeVersion 为空），例如选中 nvm 但尚未安装 nvm 时
    if (nodeVersion && !findNodeVersion(nodeProvider, nodeVersion)) {
      throw new Error(
        `${nodeProvider} 下未安装 node ${nodeVersion}`,
      );
    }
    saveConfig({ nodeProvider, nodeVersion });

    // 自动清洗旧的 ~/.npm-global 干扰，并确保目标版本拥有专属隔离的 pnpm
    if (nodeProvider === "nvm" && nodeVersion) {
      ensureIsolatedPnpm(nodeVersion);

      // 同步更新 nvm 的 default 别名，使外部系统终端（Terminal / iTerm）新开窗口时也同步生效
      const script = [
        "unset npm_config_prefix",
        "unset NPM_CONFIG_PREFIX",
        '[ -f "$HOME/.npmrc" ] && sed -i \'\' \'/^prefix=/d; /^globalconfig=/d\' "$HOME/.npmrc" 2>/dev/null || true',
        `export NVM_DIR="${getNvmDir()}"`,
        '. "$NVM_DIR/nvm.sh"',
        `nvm alias default ${nodeVersion} >/dev/null 2>&1 || true`,
      ].join("\n");
      exec(`/bin/bash -c "${script.replace(/"/g, '\\"')}"`, { cwd: os.homedir() });
    }

    return { provider: nodeProvider, version: nodeVersion };
  });

  // nvm 一键安装。日志走 process-log 频道，projectId 为 ENV_INSTALL_LOG_ID
  ipcSafe("install-nvm", installNvm);

  // nvm 一键卸载
  ipcSafe("uninstall-nvm", uninstallNvm);

  // 通过 nvm 安装指定 Node 版本
  ipcSafe("install-node-version", installNodeVersion);

  // 通过 nvm 卸载指定 Node 版本
  ipcSafe("uninstall-node-version", uninstallNodeVersion);

  // 安装/指定 pnpm 版本号
  ipcSafe("install-pnpm-version", installPnpmVersion);

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
