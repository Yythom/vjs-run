// ─── 引入模块 ──────────────────────────────────────────────────────────────────
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, exec, execSync } = require("child_process");
const isDev = !app.isPackaged;

// ─── 全局变量 ─────────────────────────────────────────────────────────────────

// 主窗口实例
let mainWindow;

// 正在运行的前端子进程，键为 projectId，值为 ChildProcess
const runningProcesses = {};

// ─── 配置：前端项目列表 ────────────────────────────────────────────────────────
// 前端仓库与项目共用同一份配置，支持持久化动态增删。
const DEFAULT_FRONTEND_PROJECT_GROUPS = [
  {
    key: "main",
    label: "vjs-monorepo",
    path: "/Users/yeyuteng/Documents/work/vjs-monorepo",
    projects: [
      {
        key: "video",
        name: "video",
        command: "pnpm run dev --filter @gc-app/remix-video",
      },
      {
        key: "backend",
        name: "backend",
        command: "pnpm run dev --filter @gc-app/remix-backend",
      },
      {
        key: "music",
        name: "music",
        command: "pnpm run dev --filter @gc-app/remix-music",
      },
      {
        key: "studio",
        name: "studio",
        command: "pnpm run dev --filter @gc-app/remix-studio",
      },
      {
        key: "copyright",
        name: "copyright",
        command: "pnpm run dev --filter @gc-app/remix-copyright",
      },
      {
        key: "foto",
        name: "foto",
        command: "pnpm run dev --filter @gc-app/foto",
      },
      {
        key: "vision",
        name: "vision",
        command: "pnpm run dev --filter @gc-app/remix-vision",
      },
      {
        key: "seo",
        name: "seo",
        command: "pnpm run dev --filter @gc-app/remix-seo",
      },
    ],
  },
];

function buildProjectId(groupKey, project) {
  return `${groupKey}:${project.key || project.name}`;
}

function normalizeProject(project = {}, index = 0) {
  const key =
    String(project.key || project.name || `project-${index + 1}`).trim() ||
    `project-${index + 1}`;
  const name = String(project.name || key).trim() || key;
  return {
    key,
    name,
    command: String(project.command || "").trim(),
  };
}

function normalizeGroup(group = {}, index = 0) {
  const key = String(group.key || `repo-${index + 1}`).trim() || `repo-${index + 1}`;
  return {
    key,
    label: String(group.label || key).trim() || key,
    path: String(group.path || group.defaultPath || "").trim(),
    projects: Array.isArray(group.projects)
      ? group.projects
          .map((project, projectIndex) => normalizeProject(project, projectIndex))
          .filter((project) => project.key || project.name || project.command)
      : [],
  };
}

function migrateLegacyProjectGroups(raw = {}) {
  const legacyRepoPaths = raw.frontendRepos || {};
  return DEFAULT_FRONTEND_PROJECT_GROUPS.map((group, index) => ({
    ...normalizeGroup(group, index),
    path:
      String(
        legacyRepoPaths[group.key] ||
          (index === 0 ? raw.monoRepoPath : "") ||
          group.path ||
          "",
      ).trim() || "",
  }));
}

function validateFrontendProjectGroups(groups = []) {
  const seenGroupKeys = new Set();
  for (const group of groups) {
    if (!group.key) throw new Error("Repo key 不能为空");
    if (!group.label) throw new Error(`Repo ${group.key} 的名称不能为空`);
    if (!group.path) throw new Error(`Repo ${group.label} 的路径不能为空`);
    if (seenGroupKeys.has(group.key)) {
      throw new Error(`Repo key 重复: ${group.key}`);
    }
    seenGroupKeys.add(group.key);

    const seenProjectIds = new Set();
    for (const project of group.projects || []) {
      if (!project.key) {
        throw new Error(`Repo ${group.label} 存在项目 key 为空`);
      }
      if (!project.name) {
        throw new Error(`Repo ${group.label} 存在项目名称为空`);
      }
      if (!project.command) {
        throw new Error(`Repo ${group.label} 下项目 ${project.name} 的命令不能为空`);
      }
      const projectId = buildProjectId(group.key, project);
      if (seenProjectIds.has(projectId)) {
        throw new Error(`Repo ${group.label} 下项目 id 重复: ${projectId}`);
      }
      seenProjectIds.add(projectId);
    }
  }
}

function getAllProjects(runtimeConfig = config) {
  return (runtimeConfig.frontendProjectGroups || []).flatMap((group) =>
    (group.projects || []).map((project) => ({
      ...project,
      id: buildProjectId(group.key, project),
      repoKey: group.key,
      repoLabel: group.label,
      repoPath: group.path,
    })),
  );
}

function getProjectById(projectId, runtimeConfig = config) {
  return getAllProjects(runtimeConfig).find(
    (project) => project.id === String(projectId),
  );
}

// ─── 配置：服务端 proxy 环境列表 ───────────────────────────────────────────────
// id           : 环境唯一标识
// label        : 侧边栏显示的按钮文字
// scriptSuffix : pm2 start 时的脚本后缀，空字符串表示直接执行 pnpm start
const PROXY_ENVS = [
  { id: "default", label: "默认", scriptSuffix: "" },
  { id: "t1", label: "t1", scriptSuffix: "t1" },
  { id: "t2", label: "t2", scriptSuffix: "t2" },
  { id: "t3", label: "t3", scriptSuffix: "t3" },
  { id: "t4", label: "t4", scriptSuffix: "t4" },
  { id: "mock", label: "mock", scriptSuffix: "mock" },
];

// ─── 配置：路径与端口 ──────────────────────────────────────────────────────────

// 默认配置（首次运行或配置文件缺失时使用）
const DEFAULT_CONFIG = {
  frontendProjectGroups: migrateLegacyProjectGroups(),
  proxyPath: "/Users/xieyuteng/Documents/work/dev-api-proxy",
};

function normalizeConfig(raw = {}) {
  const frontendProjectGroups =
    Array.isArray(raw.frontendProjectGroups)
      ? raw.frontendProjectGroups.map((group, index) => normalizeGroup(group, index))
      : migrateLegacyProjectGroups(raw);

  validateFrontendProjectGroups(frontendProjectGroups);

  return {
    frontendProjectGroups,
    proxyPath: raw.proxyPath || DEFAULT_CONFIG.proxyPath,
  };
}

function getRepoDefinition(repoKey, runtimeConfig = config) {
  const groups = runtimeConfig.frontendProjectGroups || [];
  return (
    groups.find((group) => group.key === repoKey) ||
    groups[0] ||
    null
  );
}

function getRepoRuntime(repoKey, runtimeConfig = config) {
  const repo = getRepoDefinition(repoKey, runtimeConfig);
  if (!repo) {
    return {
      key: String(repoKey || ""),
      label: "当前 Repo",
      path: "",
      projects: [],
    };
  }
  return {
    ...repo,
    path: repo?.path || "",
  };
}

function getProjectRepo(project, runtimeConfig = config) {
  return getRepoRuntime(project?.repoKey, runtimeConfig);
}

// 获取用户配置文件路径（存放在 Electron userData 目录，如 ~/Library/Application Support/pdown/config.json）
function getConfigFilePath() {
  return path.join(app.getPath("userData"), "config.json");
}

// 从磁盘加载配置，合并默认值（保证新增字段有默认值）
function loadConfig() {
  try {
    const raw = fs.readFileSync(getConfigFilePath(), "utf-8");
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return normalizeConfig();
  }
}

// 将配置写入磁盘，返回最新配置
function saveConfig(partial) {
  const current = loadConfig();
  const merged = normalizeConfig({ ...current, ...partial });
  fs.writeFileSync(
    getConfigFilePath(),
    JSON.stringify(merged, null, 2),
    "utf-8",
  );
  return merged;
}

// 运行时配置对象（在应用启动后的 ready 事件中初始化）
let config = { ...DEFAULT_CONFIG };

// 启动前需要释放的端口列表
const KILL_PORTS = [8801, 3000, 3001];

// ─── 打包环境 PATH/工具链补全 ────────────────────────────────────────────────

let cachedShellEnv = null;

/** 去重并合并 PATH 字符串 */
function mergePathSegments(...segmentsList) {
  const uniq = [];
  for (const segments of segmentsList) {
    for (const seg of segments || []) {
      const v = String(seg || "").trim();
      if (!v) continue;
      if (!uniq.includes(v)) uniq.push(v);
    }
  }
  return uniq.join(path.delimiter);
}

/**
 * 从 bash 的交互式登录 shell 中提取完整环境变量。
 * 打包后的 Electron 进程往往拿不到用户在 bash 启动文件里导出的变量，
 * 这里主动从 `bash -il` 读取并缓存一份，供后续所有子进程复用。
 */
function getHydratedShellEnv() {
  if (cachedShellEnv) return cachedShellEnv;

  const env = {};
  try {
    const shellOut = execSync("/bin/zsh -ilc 'env -0'", {
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1024 * 1024 * 4,
    });
    for (const entry of shellOut.toString("utf8").split("\u0000")) {
      if (!entry) continue;
      const eqIndex = entry.indexOf("=");
      if (eqIndex <= 0) continue;
      const key = entry.slice(0, eqIndex);
      const value = entry.slice(eqIndex + 1);
      env[key] = value;
    }
  } catch (_) {}

  cachedShellEnv = env;
  return cachedShellEnv;
}

/**
 * 统一构建子进程环境变量，确保打包后也能找到 node/pnpm/git 等工具
 */
function buildSpawnEnv(extra = {}) {
  const shellEnv = getHydratedShellEnv();
  const basePath = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const shellPath = (shellEnv.PATH || "").split(path.delimiter).filter(Boolean);
  const guessed = [
    process.env.PNPM_HOME,
    shellEnv.PNPM_HOME,
    path.join(os.homedir(), ".local/share/pnpm"),
    path.join(os.homedir(), ".volta/bin"),
    path.join(os.homedir(), ".nvm/versions/node/current/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/opt/homebrew/sbin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].filter(Boolean);
  const hydratedPath = mergePathSegments(basePath, shellPath, guessed);
  const env = {
    ...process.env,
    ...shellEnv,
    PATH: hydratedPath,
    FORCE_COLOR: "1",
    TERM: "xterm-256color",
    ...extra,
  };

  // 若 PATH 中包含 pnpm 目录，顺便补齐 PNPM_HOME，便于部分脚本识别
  if (!env.PNPM_HOME) {
    const pnpmHome = env.PATH.split(path.delimiter).find((p) =>
      /(?:^|\/)\.local\/share\/pnpm$/.test(p),
    );
    if (pnpmHome) env.PNPM_HOME = pnpmHome;
  }

  return env;
}

// ─── 窗口管理 ─────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    // macOS 隐藏原生标题栏，使用自定义拖拽区
    titleBarStyle: "hiddenInset",
    // 与 CSS 背景色一致，避免启动时白闪
    backgroundColor: "#0f172a",
    webPreferences: {
      // 禁用 Node.js 直接注入渲染进程，提升安全性
      nodeIntegration: false,
      // 开启上下文隔离，配合 preload 使用 contextBridge
      contextIsolation: true,
      // 预加载脚本：安全地向渲染进程暴露 API
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // 加载渲染层：
  // - 开发环境：连接 Vite dev server
  // - 生产环境：加载 renderer/dist/index.html
  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
  } else {
    mainWindow.loadFile(
      path.join(__dirname, "..", "renderer", "dist", "index.html"),
    );
  }

  // 窗口关闭时清理：释放引用并终止所有子进程
  mainWindow.on("closed", () => {
    mainWindow = null;
    stopAllProcesses();
  });
}

// ─── 端口管理工具 ─────────────────────────────────────────────────────────────

/**
 * 释放指定端口：通过 lsof 找到占用进程并 kill
 * 忽略没有进程占用时的错误（xargs kill 在无输入时会报错）
 */
function killPort(port) {
  return new Promise((resolve) => {
    exec(
      `lsof -nP -i :${port} | awk '{print $2}' | tail -n +2 | xargs kill 2>/dev/null || true`,
      { shell: "/bin/zsh" },
      () => resolve(), // 无论成功与否都 resolve，不阻塞后续流程
    );
  });
}

/**
 * 并发释放所有配置端口
 */
async function killAllPorts() {
  await Promise.all(KILL_PORTS.map(killPort));
}

// ─── 子进程管理工具 ───────────────────────────────────────────────────────────

/**
 * 停止指定项目的子进程
 * 优先通过进程组 SIGTERM 终止（确保子进程树一并退出），
 * 失败时兜底直接 kill 进程本身
 */
function stopProcess(projectId) {
  const proc = runningProcesses[projectId];
  if (proc) {
    try {
      // 负 pid 表示发送信号给整个进程组
      process.kill(-proc.pid, "SIGTERM");
    } catch (_) {
      // 进程组 kill 失败（如进程未 detached）则直接 kill
      try {
        proc.kill("SIGTERM");
      } catch (__) {}
    }
    // 从运行列表中移除，并通知渲染进程更新状态
    delete runningProcesses[projectId];
    sendStatus(projectId, "stopped");
  }
}

/**
 * 停止所有正在运行的前端子进程
 */
function stopAllProcesses() {
  Object.keys(runningProcesses).forEach(stopProcess);
}

// ─── 渲染进程通信工具 ─────────────────────────────────────────────────────────

/**
 * 向渲染进程推送日志文本
 * @param {string} projectId - 项目 id 或 "__proxy__"
 * @param {string} data      - 原始文本（含 ANSI 转义）
 */
function sendLog(projectId, data) {
  // 窗口销毁后不再发送，防止崩溃
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("process-log", { projectId, data });
  }
}

/**
 * 向渲染进程推送进程状态变更
 * @param {string} projectId - 项目 id 或 "__proxy__"
 * @param {string} status    - "starting" | "running" | "stopped" | "error"
 */
function sendStatus(projectId, status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("process-status", { projectId, status });
  }
}

// ─── 进程资源监控 ─────────────────────────────────────────────────────────────

/** 资源采集定时器句柄 */
let statsInterval = null;

/**
 * 通过 ps 汇总某进程组（PGID === pid）的聚合 CPU% 与内存（MB）
 * detached 子进程会成为进程组 leader，其 PGID === 自身 PID，
 * 所有子孙进程继承同一 PGID，因此可以准确累加整组资源占用。
 * @param {number} pid - spawn 返回的子进程 PID
 * @returns {Promise<{cpu: number, memory: number}>}
 */
function getProcessGroupStats(pid) {
  return new Promise((resolve) => {
    // pgid= pcpu= rss=  ——去掉列标题；rss 单位 KB
    exec(
      `ps -A -o pgid=,pcpu=,rss= 2>/dev/null`,
      { shell: "/bin/zsh" },
      (err, stdout) => {
        if (err || !stdout.trim()) return resolve({ cpu: 0, memory: 0 });
        let totalCpu = 0;
        let totalRss = 0;
        for (const line of stdout.trim().split("\n")) {
          const parts = line.trim().split(/\s+/);
          if (parts.length < 3) continue;
          if (parseInt(parts[0], 10) === pid) {
            totalCpu += parseFloat(parts[1]) || 0;
            totalRss += parseInt(parts[2], 10) || 0;
          }
        }
        resolve({
          cpu: Math.round(totalCpu * 10) / 10,
          memory: Math.round((totalRss / 1024) * 10) / 10, // KB → MB
        });
      },
    );
  });
}

/**
 * 采集所有运行中进程的资源占用，广播到渲染进程
 * 若运行列表为空则自动停止定时器
 */
async function broadcastStats() {
  const ids = Object.keys(runningProcesses);
  if (!ids.length) {
    stopStatsMonitor();
    return;
  }
  const statsMap = {};
  await Promise.all(
    ids.map(async (id) => {
      const proc = runningProcesses[id];
      if (proc && proc.pid) {
        statsMap[id] = await getProcessGroupStats(proc.pid);
      }
    }),
  );
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("process-stats", statsMap);
  }
}

/** 启动 2 秒定时采集（已在运行则跳过，避免重复启动） */
function startStatsMonitor() {
  if (statsInterval) return;
  statsInterval = setInterval(broadcastStats, 2000);
}

/** 停止定时采集并清除句柄 */
function stopStatsMonitor() {
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }
}

// ─── 前端项目：启动 ───────────────────────────────────────────────────────────

/**
 * 启动指定前端项目的开发服务器（执行项目配置中的 command）
 * 日志实时流式推送到渲染进程
 */
function startProject(project) {
  const { id, command } = project;
  const repo = getProjectRepo(project);

  // 如果该项目已在运行，先停止旧进程再重启
  if (runningProcesses[id]) stopProcess(id);

  // 立即将状态设为 starting，让 UI 显示启动中动画
  sendStatus(id, "starting");
  sendLog(
    id,
    `\x1b[36m▶ Starting ${project.name} in ${repo.label}...\x1b[0m\n`,
  );

  // 启动 pnpm dev，detached:true 使子进程在独立进程组运行，
  // 方便后续通过进程组 kill 一并退出所有子孙进程
  sendLog(id, `\x1b[2m$ ${command}\x1b[0m\n`);
  const proc = spawn(command, [], {
    cwd: repo.path,
    // 打包环境下补全 PATH，避免 pnpm/node ENOENT
    env: buildSpawnEnv(),
    shell: "/bin/zsh",
    detached: true,
  });

  // 记录到运行列表
  runningProcesses[id] = proc;

  // 有进程启动时确保资源监控定时器在运行
  startStatsMonitor();

  // 监听 stdout：实时转发日志，并通过关键词判断服务是否已就绪
  proc.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    sendLog(id, text);
    // 检测 dev server 已成功启动的特征输出
    if (
      text.includes("Local:") || // vite
      text.includes("localhost") ||
      text.includes("ready") ||
      text.includes("started server") || // remix
      text.includes("listening")
    ) {
      sendStatus(id, "running");
    }
  });

  // 监听 stderr：同样转发到日志面板（很多工具把正常日志也写到 stderr）
  proc.stderr.on("data", (chunk) => sendLog(id, chunk.toString()));

  // 进程启动失败（如找不到可执行文件）
  proc.on("error", (err) => {
    if (err && err.code === "ENOENT") {
      sendLog(
        id,
        `\x1b[31m✗ Error: ${err.message}\x1b[0m\n` +
          `\x1b[33m⚠ 未找到命令。请确认依赖工具已安装，或在应用启动环境中补充 PATH / PNPM_HOME。\x1b[0m\n`,
      );
    } else {
      sendLog(id, `\x1b[31m✗ Error: ${err.message}\x1b[0m\n`);
    }
    sendStatus(id, "error");
    delete runningProcesses[id];
  });

  // 进程退出：根据退出码更新状态
  proc.on("close", (code) => {
    // 只在仍被追踪时处理（用户主动停止时已从列表移除，不重复处理）
    if (runningProcesses[id]) {
      delete runningProcesses[id];
      if (code === 0 || code === null) {
        // 正常退出（null 表示被信号终止）
        sendLog(id, `\x1b[33m■ Process exited (code ${code})\x1b[0m\n`);
        sendStatus(id, "stopped");
      } else {
        // 异常退出
        sendLog(id, `\x1b[31m✗ Process exited with code ${code}\x1b[0m\n`);
        sendStatus(id, "error");
      }
    }
  });

  // 兜底：5 秒后如果进程仍存活但未检测到就绪关键词，强制标记为 running
  setTimeout(() => {
    if (runningProcesses[id] && !proc.killed) sendStatus(id, "running");
  }, 5000);
}

// ─── 服务端 Proxy：通用流式命令执行 ──────────────────────────────────────────

/**
 * 在 PROXY_PATH 下执行一条 shell 命令，
 * 将 stdout/stderr 实时流式推送到渲染进程的指定日志面板
 *
 * @param {string} projectId - 日志归属的面板 id（proxy 固定传 "__proxy__"）
 * @param {string} cmd       - 要执行的 shell 命令
 * @param {object} opts      - 可选：{ cwd } 覆盖工作目录
 * @returns {Promise<{code: number}>} 进程退出码
 */
function runStreaming(projectId, cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    // 在日志中显示执行的命令，方便调试
    sendLog(projectId, `\x1b[2m$ ${cmd}\x1b[0m\n`);

    const proc = spawn(cmd, [], {
      cwd: opts.cwd || config.proxyPath,
      env: buildSpawnEnv(),
      // 使用 bash 解析命令，支持管道等 shell 特性
      shell: "/bin/zsh",
      detached: false,
    });

    // 实时转发标准输出
    proc.stdout.on("data", (chunk) => sendLog(projectId, chunk.toString()));
    // 实时转发标准错误
    proc.stderr.on("data", (chunk) => sendLog(projectId, chunk.toString()));
    // 启动失败（如命令不存在）
    proc.on("error", (err) => reject(err));
    // 正常退出，将退出码传递给调用方判断
    proc.on("close", (code) => resolve({ code }));
  });
}

// ─── 服务端 Proxy：部署流程 ───────────────────────────────────────────────────

/**
 * 完整的 proxy 部署序列，对应原 bash 脚本逻辑：
 *   ① git pull              —— 拉取最新代码
 *   ② pm2 delete koa-proxy  —— 删除旧的 pm2 进程（不存在时忽略错误）
 *   ③ pm2 start pnpm ...    —— 以指定 script 启动新进程
 *
 * @param {string} projectId    - 日志面板 id，固定为 "__proxy__"
 * @param {string} scriptSuffix - pnpm script 后缀，空字符串则执行 pnpm start
 */
async function deployProxy(projectId, scriptSuffix) {
  // 立即将状态改为 starting，UI 显示部署进度动画
  sendStatus(projectId, "starting");

  try {
    // ① 拉取最新代码
    sendLog(projectId, `\x1b[36m① git pull\x1b[0m\n`);
    await runStreaming(projectId, "git pull");

    // ② 删除旧 pm2 进程（首次部署时该进程不存在，catch 掉错误继续执行）
    sendLog(projectId, `\x1b[36m② pm2 delete koa-proxy\x1b[0m\n`);
    await runStreaming(projectId, "pm2 delete koa-proxy").catch(() => {});

    // ③ 启动新 pm2 进程，根据 scriptSuffix 决定执行哪个 pnpm script
    //    有后缀：pnpm start-<suffix>（如 pnpm start-t1）
    //    无后缀：pnpm start
    const startCmd = scriptSuffix
      ? `pm2 start pnpm --name "koa-proxy" -- start-${scriptSuffix}`
      : `pm2 start pnpm --name "koa-proxy" -- start`;
    sendLog(projectId, `\x1b[36m③ ${startCmd}\x1b[0m\n`);
    const { code } = await runStreaming(projectId, startCmd);

    // 根据 pm2 start 的退出码判断是否成功
    if (code === 0) {
      sendLog(projectId, `\x1b[32m✔ koa-proxy 已启动\x1b[0m\n`);
      sendStatus(projectId, "running");
    } else {
      sendLog(projectId, `\x1b[31m✗ pm2 start 退出码 ${code}\x1b[0m\n`);
      sendStatus(projectId, "error");
    }
  } catch (err) {
    // 捕获 runStreaming 抛出的异常（如命令不存在）
    sendLog(projectId, `\x1b[31m✗ ${err.message}\x1b[0m\n`);
    sendStatus(projectId, "error");
  }
}

// ─── 服务端 Proxy：停止 ───────────────────────────────────────────────────────

/**
 * 停止 proxy：执行 pm2 delete koa-proxy
 */
async function stopProxy(projectId) {
  sendLog(projectId, `\x1b[33m⏹ pm2 delete koa-proxy\x1b[0m\n`);
  try {
    await runStreaming(projectId, "pm2 delete koa-proxy");
    sendLog(projectId, `\x1b[32m✔ koa-proxy 已停止\x1b[0m\n`);
    sendStatus(projectId, "stopped");
  } catch (err) {
    sendLog(projectId, `\x1b[31m✗ ${err.message}\x1b[0m\n`);
    sendStatus(projectId, "error");
  }
}

// ─── IPC：数据查询 ────────────────────────────────────────────────────────────

// 返回前端项目列表，供渲染进程渲染侧边栏
ipcMain.handle("get-projects", () =>
  getAllProjects(config).map((project) => ({
    ...project,
    repoLabel: getRepoDefinition(project.repoKey, config).label,
  })),
);

// 返回当前配置（路径等），供渲染进程展示和编辑
ipcMain.handle("get-config", () => config);

// 更新配置：渲染进程传入需要修改的字段，保存并热更新运行时 config 对象
ipcMain.handle("set-config", (_, partial) => {
  try {
    if (partial.frontendProjectGroups) {
      stopAllProcesses();
      stopStatsMonitor();
    }
    config = saveConfig(partial);
    return { success: true, config };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 返回 proxy 环境列表，供渲染进程渲染环境选择器
ipcMain.handle("get-proxy-envs", () => PROXY_ENVS);

// 返回当前正在运行的项目 id 列表，供窗口刷新时同步状态
ipcMain.handle("get-running", () => Object.keys(runningProcesses));

// ─── IPC：前端项目操作 ────────────────────────────────────────────────────────

// 启动前端项目：先释放端口，再 spawn pnpm dev
ipcMain.handle("start-project", async (_, projectId) => {
  const project = getProjectById(projectId, config);
  if (!project) return { success: false, error: "Project not found" };
  const repo = getProjectRepo(project);
  if (!repo.path) {
    return { success: false, error: `${repo.label} 路径未配置` };
  }
  try {
    // 释放端口，避免 EADDRINUSE 错误
    await killAllPorts();
    startProject(project);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 停止前端项目：kill 子进程，再释放端口
ipcMain.handle("stop-project", async (_, projectId) => {
  try {
    stopProcess(String(projectId));
    await killAllPorts();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 停止所有前端项目、服务端 proxy 并释放端口（顶部「全部停止」按钮）
ipcMain.handle("stop-all", async () => {
  try {
    stopAllProcesses();
    await stopProxy("__proxy__");
    await killAllPorts();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 仅释放端口，不停止进程（顶部「释放端口」按钮）
ipcMain.handle("kill-ports", async () => {
  try {
    await killAllPorts();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 批量关闭全部 agent-browser 会话
ipcMain.handle("close-agent-browser-sessions", async () => {
  const cmd =
    "agent-browser session list | tail -n +2 | sed 's/^  //' | while read -r s; do agent-browser --session \"$s\" close; done";

  try {
    const result = await new Promise((resolve, reject) => {
      exec(
        cmd,
        {
          env: buildSpawnEnv(),
          shell: "/bin/zsh",
          maxBuffer: 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new Error(
                stderr?.trim() || stdout?.trim() || error.message || "执行失败",
              ),
            );
            return;
          }
          resolve({
            stdout: stdout.trim(),
            stderr: stderr.trim(),
          });
        },
      );
    });

    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC：服务端 Proxy 操作 ───────────────────────────────────────────────────

// 部署 proxy：根据 envId（或自定义后缀）执行完整部署序列
ipcMain.handle("deploy-proxy", async (_, { envId }) => {
  try {
    let scriptSuffix;

    // 判断是否为自定义后缀格式（前端自定义输入框传来 "__custom__:staging"）
    if (typeof envId === "string" && envId.startsWith("__custom__:")) {
      // 截取冒号后面的实际后缀
      scriptSuffix = envId.slice("__custom__:".length).trim();
    } else {
      // 从预设环境列表中查找对应的 scriptSuffix
      const env = PROXY_ENVS.find((e) => e.id === envId);
      if (!env) return { success: false, error: `Unknown env: ${envId}` };
      scriptSuffix = env.scriptSuffix;
    }

    // 执行部署，日志面板固定使用 "__proxy__" 虚拟 id
    await deployProxy("__proxy__", scriptSuffix);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 清理 monorepo：删除所有 node_modules / dist / .turbo / build 目录
ipcMain.handle("clean-monorepo", async (_, payload = {}) => {
  const id = "__clean__";
  const repo = getRepoRuntime(payload.repoKey);
  const cmds = [
    "find . -name \"node_modules\" -type d -prune -exec rm -rf '{}' +",
    "find . -name \"dist\" -type d -prune -exec rm -rf '{}' +",
    "find . -name \".turbo\" -type d -prune -exec rm -rf '{}' +",
    "find . -name \"build\" -type d -prune -exec rm -rf '{}' +",
  ];
  try {
    if (!repo.path) throw new Error(`${repo.label} 路径未配置`);
    sendStatus(id, "starting");
    sendLog(id, `\x1b[36m🧹 开始清理 ${repo.label}: ${repo.path}\x1b[0m\n`);
    for (const cmd of cmds) {
      await runStreaming(id, cmd, { cwd: repo.path });
    }
    sendLog(id, `\x1b[32m✔ 清理完成\x1b[0m\n`);
    sendStatus(id, "stopped");
    return { success: true };
  } catch (err) {
    sendLog(id, `\x1b[31m✗ ${err.message}\x1b[0m\n`);
    sendStatus(id, "error");
    return { success: false, error: err.message };
  }
});

// ─── 一键重装（清理 + pnpm install）─────────────────────────────────────────

// 复用 __clean__ 日志通道，先执行四条 find 清理，再跑 pnpm install
ipcMain.handle("reinstall-monorepo", async (_, payload = {}) => {
  const id = "__clean__";
  const repo = getRepoRuntime(payload.repoKey);
  const cleanCmds = [
    "find . -name \"node_modules\" -type d -prune -exec rm -rf '{}' +",
    "find . -name \"dist\" -type d -prune -exec rm -rf '{}' +",
    "find . -name \".turbo\" -type d -prune -exec rm -rf '{}' +",
    "find . -name \"build\" -type d -prune -exec rm -rf '{}' +",
  ];
  try {
    if (!repo.path) throw new Error(`${repo.label} 路径未配置`);
    sendStatus(id, "starting");
    sendLog(id, `\x1b[36m🧹 开始清理 ${repo.label}: ${repo.path}\x1b[0m\n`);
    for (const cmd of cleanCmds) {
      await runStreaming(id, cmd, { cwd: repo.path });
    }
    sendLog(id, `\n\x1b[36m📦 执行 pnpm install\x1b[0m\n`);
    await runStreaming(id, "pnpm install", { cwd: repo.path });
    sendLog(id, `\n\x1b[32m✔ 重装完成\x1b[0m\n`);
    sendStatus(id, "stopped");
    return { success: true };
  } catch (err) {
    sendLog(id, `\x1b[31m✗ ${err.message}\x1b[0m\n`);
    sendStatus(id, "error");
    return { success: false, error: err.message };
  }
});

// ─── 开发环境体检 ──────────────────────────────────────────────────────────

// 待检测的工具列表
const ENV_TOOLS = [
  { id: "node", label: "Node.js", cmd: "node -v" },
  { id: "pnpm", label: "pnpm", cmd: "pnpm -v" },
  { id: "git", label: "Git", cmd: "git --version" },
  { id: "brew", label: "Homebrew", cmd: "brew --version" },
  { id: "pm2", label: "pm2", cmd: "pm2 --version" },
];

// 并发执行所有版本检测，返回结果数组
ipcMain.handle("check-env", async () => {
  const results = await Promise.all(
    ENV_TOOLS.map(
      ({ id, label, cmd }) =>
        new Promise((resolve) => {
          exec(cmd, { env: buildSpawnEnv() }, (err, stdout) => {
            if (err || !stdout.trim()) {
              resolve({ id, label, cmd, version: null, status: "missing" });
            } else {
              // 只取第一行，避免 brew 等多行输出干扰
              resolve({
                id,
                label,
                cmd,
                version: stdout.trim().split("\n")[0],
                status: "ok",
              });
            }
          });
        }),
    ),
  );
  return results;
});

// ─── 端口占用查看器 ────────────────────────────────────────────────────────

// 查询指定端口列表的占用情况
ipcMain.handle("check-ports", async (_, { ports }) => {
  const results = await Promise.all(
    ports.map(
      (port) =>
        new Promise((resolve) => {
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
        }),
    ),
  );
  return results;
});

// 单端口 kill（端口查看器中逐行操作使用）
ipcMain.handle("kill-single-port", async (_, { port }) => {
  try {
    await killPort(port);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 主动查询所有运行中进程的当前资源占用（供渲染进程按需拉取）
ipcMain.handle("get-process-stats", async () => {
  const ids = Object.keys(runningProcesses);
  if (!ids.length) return {};
  const statsMap = {};
  await Promise.all(
    ids.map(async (id) => {
      const proc = runningProcesses[id];
      if (proc && proc.pid) {
        statsMap[id] = await getProcessGroupStats(proc.pid);
      }
    }),
  );
  return statsMap;
});

// 停止 proxy 服务
ipcMain.handle("stop-proxy", async () => {
  try {
    await stopProxy("__proxy__");
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC：调试终端命令执行（流式日志）──────────────────────────────────────────

/**
 * 在指定前端项目目录执行一条调试命令，并将 stdout/stderr 流式推送到对应项目日志面板。
 * 注意：该接口用于打包后问题排查，按项目维度执行，避免误用。
 *
 * @param {string} projectId - 前端项目 id
 * @param {string} command          - 要执行的 shell 命令
 */
ipcMain.handle("run-project-command", async (_, { projectId, command }) => {
  const id = String(projectId);
  const project = getProjectById(id, config);

  if (!project) {
    return { success: false, error: "Project not found" };
  }

  const cmd = String(command || "").trim();
  const repo = getProjectRepo(project);
  if (!cmd) {
    return { success: false, error: "Command is empty" };
  }
  if (!repo.path) {
    return { success: false, error: `${repo.label} 路径未配置` };
  }

  try {
    // 记录命令头，方便在同一日志面板区分手动调试输出
    sendLog(
      id,
      `\x1b[35m🛠 Debug command (${project.name})\x1b[0m\n` +
        `\x1b[2m$ ${cmd}\x1b[0m\n`,
    );

    const proc = spawn(cmd, [], {
      cwd: repo.path,
      env: buildSpawnEnv(),
      shell: "/bin/zsh",
      detached: false,
    });

    proc.stdout.on("data", (chunk) => sendLog(id, chunk.toString()));
    proc.stderr.on("data", (chunk) => sendLog(id, chunk.toString()));

    const code = await new Promise((resolve, reject) => {
      proc.on("error", reject);
      proc.on("close", resolve);
    });

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
});

// ─── 应用生命周期 ─────────────────────────────────────────────────────────────

// Electron 初始化完成后：先加载用户配置，再创建主窗口
app.whenReady().then(() => {
  config = loadConfig();
  createWindow();
});

// 所有窗口关闭时：非 macOS 直接退出；macOS 保留进程（Dock 点击可重新打开）
app.on("window-all-closed", () => {
  stopAllProcesses();
  if (process.platform !== "darwin") app.quit();
});

// macOS：点击 Dock 图标且无窗口时，重新创建窗口
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// 应用退出前确保所有子进程都被终止，避免孤儿进程
app.on("before-quit", () => {
  stopAllProcesses();
});
