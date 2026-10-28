// mock 进程生命周期：serve（前台）/ start（后台守护）/ stop / restart / status / logs。
//
// mock 只有一种运行方式：独立的后台进程（`vjtools mock serve --daemon`）。vjtools mock start
// 和 app 的「启动」按钮都通过 startDaemon 拉起它，app 再订阅它的 /__mock/events 做界面——
// 所以谁启动的都一样，app 退出后 mock 继续跑，AI / 终端照用。
//
// startDaemon 等 mock-runtime.json 出现且 /__mock/health 的 pid 对上才返回，调用方拿到的
// 是确定结果，不用自己猜「起来没有」。app 调用时传 Electron 二进制 + ELECTRON_RUN_AS_NODE=1。
//
// 不调 killPort：旧版 app 的 mock 跑在 Electron 主进程里，按端口杀进程会把整个 app 杀掉。

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import chokidar from "chokidar";
import { startMockServer } from "../mock/server.js";
import { clearMockHistory, getMockHistory, recordMockRequest } from "../mock/history.js";
import { seedMockAssets } from "../mock/seed-assets.js";
import {
  clearMockRuntime,
  fetchMockHealth,
  findLiveMockRuntime,
  isPidAlive,
  mockBaseUrl,
  readMockRuntime,
  writeMockRuntime,
} from "../mock/runtime.js";
import { cliPaths } from "./user-data.js";
import { MOCK_RESTART_FIELDS, assertSpecReady, readMockConfig } from "./config.js";
import { CliError, clockTime, cliVersion, printJson, sleep } from "./util.js";

const CLI_ENTRY = fileURLToPath(new URL("./index.js", import.meta.url));
const START_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 5_000;

export const NOT_RUNNING_EXIT_CODE = 3;

/** owner=cli 是后台进程（startedBy 区分谁拉起的）；app / unknown 是旧版 app 在进程内跑的 */
export function ownerLabel(running) {
  if (running.owner === "cli") {
    return running.startedBy === "app" ? "vjtools app（后台进程）" : "命令行（vjtools mock start）";
  }
  if (running.owner === "app") return "旧版 vjtools app（在 app 进程里运行）";
  return "未知来源（端口上有 mock，但没有运行记录，可能是旧版 vjtools app）";
}

/**
 * 当前在跑的 mock：优先看运行记录；没有记录但配置端口上有 mock 也算（owner=unknown）。
 * @returns {Promise<null | {owner, pid, url, health, logFile?, startedAt?, version?}>}
 */
export async function detectRunningMock(paths, config) {
  const live = await findLiveMockRuntime(paths.mockAssetsDir);
  if (live) return live;
  const url = mockBaseUrl(config.host, config.port);
  const health = await fetchMockHealth(url);
  if (health) return { owner: "unknown", pid: health.pid ?? null, url, health };
  return null;
}

function portInUseMessage(port) {
  return (
    `端口 ${port} 已被占用。\n` +
    `  · 查看占用者：lsof -nP -iTCP:${port} -sTCP:LISTEN\n` +
    "  · 或换个端口：vjtools mock config --port <端口>"
  );
}

// ─── serve：前台运行（start 拉起的守护进程也是它）──────────────────────────────

export async function serve({ daemon = false } = {}) {
  const paths = cliPaths();
  const { rulesFile, dataDir } = seedMockAssets(paths.userDataDir);

  const existing = await detectRunningMock(paths, readMockConfig(paths.configFile));
  if (existing) {
    throw new CliError(
      `mock 已在运行：${existing.url}（${ownerLabel(existing)}，pid ${existing.pid ?? "?"}）`,
    );
  }

  // 事件总线：新请求、日志推给 /__mock/events 的订阅方（app 的历史面板、日志、录制都靠它）
  const subscribers = new Set();
  const emit = (event, data) => {
    for (const send of subscribers) {
      try {
        send(event, data);
      } catch {
        // 订阅方断开时的写失败不影响其它订阅方
      }
    }
  };
  const subscribe = (send) => {
    subscribers.add(send);
    return () => subscribers.delete(send);
  };
  const log = (message) => {
    const line = `${clockTime()} ${message}`;
    console.log(line);
    emit("log", line);
  };
  let service = null;
  let current = null;

  const startServer = async () => {
    const config = readMockConfig(paths.configFile);
    assertSpecReady(config);
    try {
      service = await startMockServer({
        specPath: config.specPath,
        host: config.host,
        port: config.port,
        serviceAddress: config.serviceAddress,
        mockDataDir: dataDir,
        mockRulesFile: rulesFile,
        backendBaseUrl: config.backendBaseUrl,
        mockAll: config.mockAll,
        onLog: log,
        onRecord: (entry) => emit("request", recordMockRequest(entry)),
        getHistory: getMockHistory,
        clearHistory: clearMockHistory,
        subscribe,
      });
    } catch (err) {
      if (err?.code === "EADDRINUSE") throw new CliError(portInUseMessage(config.port));
      throw err;
    }
    current = config;
    const info = writeMockRuntime(paths.mockAssetsDir, {
      pid: process.pid,
      owner: "cli",
      host: config.host,
      port: config.port,
      logFile: daemon ? paths.logFile : null,
      version: cliVersion().version,
      // app 拉起时会带上这个环境变量，status 据此显示「vjtools app（后台进程）」
      startedBy: process.env.VJTOOLS_STARTED_BY === "app" ? "app" : "cli",
    });
    log(
      `✔ mock 已启动 ${info.url}（${service.routes.length} 条路由，${service.sources.length} 个 spec 文件）`,
    );
    log(`  spec    ${config.specPath}`);
    log(`  后端    ${config.backendBaseUrl || "(未配置，未命中 mock 的接口返回 404/502)"}`);
    log(`  规则    ${rulesFile}`);
  };

  const stopServer = async () => {
    if (!service) return;
    const { server, watchers } = service;
    service = null;
    await Promise.allSettled((watchers || []).map((w) => w.close()));
    await new Promise((resolve) => {
      server.close(() => resolve());
      // keep-alive 连接（vite 代理、浏览器）不断开的话 close 回调永远等不到
      server.closeAllConnections?.();
    });
  };

  let configWatcher = null;
  let exiting = false;
  const shutdown = async (code) => {
    if (exiting) return;
    exiting = true;
    await configWatcher?.close().catch(() => {});
    await stopServer().catch(() => {});
    clearMockRuntime(paths.mockAssetsDir, process.pid);
    log(code === 0 ? "■ mock 已停止" : "■ mock 异常退出");
    process.exit(code);
  };

  await startServer();

  // config.json 里影响 server 的字段变了就自动重启（不管是 app 设置页还是 vjtools mock config 改的）。
  // 重启会断开 /__mock/events，订阅方（app）自己重连。重启串行化，避免连续改动并发启停。
  let restartChain = Promise.resolve();
  configWatcher = chokidar.watch(paths.configFile, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });
  configWatcher.on("all", () => {
    restartChain = restartChain.then(async () => {
      if (exiting) return;
      let next;
      try {
        next = readMockConfig(paths.configFile);
      } catch (err) {
        log(`⚠ 读取 config.json 失败，忽略本次变更：${err.message}`);
        return;
      }
      const changed = MOCK_RESTART_FIELDS.filter((key) => next[key] !== current?.[key]);
      if (!changed.length) return;
      log(`⚙ 配置变更（${changed.join(", ")}），重启 mock`);
      await stopServer();
      try {
        await startServer();
      } catch (err) {
        log(`✗ 重启失败：${err.message}`);
        await shutdown(1);
      }
    });
  });
  configWatcher.on("error", (err) => log(`⚠ config watcher：${err?.message || err}`));

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  process.on("uncaughtException", (err) => {
    log(`✗ ${err?.stack || err}`);
    shutdown(1);
  });
  if (!daemon) log("Ctrl+C 停止");
}

// ─── start：后台启动 ─────────────────────────────────────────────────────────

function tailText(file, lines) {
  try {
    return fs.readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function printRunning(running) {
  console.log(`● mock 运行中 ${running.url}`);
  console.log(`  启动方式  ${ownerLabel(running)}`);
  if (running.pid) console.log(`  pid       ${running.pid}`);
  if (running.health) {
    console.log(`  路由      ${running.health.routes} 条（${running.health.files} 个 spec 文件）`);
    console.log(`  后端      ${running.health.backendBaseUrl || "(未配置)"}`);
  }
  if (running.startedAt) console.log(`  启动时间  ${new Date(running.startedAt).toLocaleString("zh-CN")}`);
  if (running.logFile) console.log(`  日志      ${running.logFile}`);
}

/**
 * 拉起后台进程并等它就绪。vjtools mock start 和 app 的「启动」按钮共用。
 * @param {object} [options]
 * @param {object} [options.paths]    cliPaths(userData)
 * @param {string} [options.execPath] app 传 Electron 二进制
 * @param {object} [options.env]      app 传 ELECTRON_RUN_AS_NODE=1、VJTOOLS_USER_DATA_DIR、VJTOOLS_STARTED_BY
 * @returns {Promise<{ status: "already" | "started", running: object }>}
 */
export async function startDaemon({ paths = cliPaths(), execPath = process.execPath, env = process.env } = {}) {
  seedMockAssets(paths.userDataDir);
  const config = readMockConfig(paths.configFile);

  const running = await detectRunningMock(paths, config);
  if (running) return { status: "already", running };
  // 子进程里也会校验，这里先挡一次，错误信息能直接回到调用方而不是埋在日志里
  assertSpecReady(config);

  fs.mkdirSync(path.dirname(paths.logFile), { recursive: true });
  const fd = fs.openSync(paths.logFile, "w");
  const child = spawn(execPath, [CLI_ENTRY, "mock", "serve", "--daemon"], {
    detached: true,
    stdio: ["ignore", fd, fd],
    env,
    windowsHide: true,
  });
  fs.closeSync(fd);
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  child.unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(200);
    if (exited) {
      throw new CliError(`mock 启动失败：\n${tailText(paths.logFile, 20) || "(没有日志输出)"}`);
    }
    const info = readMockRuntime(paths.mockAssetsDir);
    if (info?.pid !== child.pid) continue;
    const health = await fetchMockHealth(info.url);
    if (health?.pid === child.pid) return { status: "started", running: { ...info, health } };
  }
  throw new CliError(
    `等待 mock 启动超时（${START_TIMEOUT_MS / 1000}s），进程 pid ${child.pid} 可能仍在加载。\n` +
      `  · 查看日志：vjtools mock logs\n  · 放弃：kill ${child.pid}`,
  );
}

export async function start() {
  const { status, running } = await startDaemon();
  console.log(status === "already" ? "mock 已经在运行，无需重复启动。" : "✔ mock 已在后台启动");
  printRunning(running);
  return 0;
}

// ─── stop / restart ──────────────────────────────────────────────────────────

/**
 * 停掉后台进程（不管是命令行还是 app 拉起的）。
 * @returns {Promise<{ status: "not-running" } | { status: "foreign", running } | { status: "stopped", pid }>}
 *   foreign：端口上的 mock 不是后台进程（旧版 app 在进程内跑的，或别的来源），不能停
 */
export async function stopDaemon({ paths = cliPaths() } = {}) {
  const running = await detectRunningMock(paths, readMockConfig(paths.configFile));
  if (!running) return { status: "not-running" };
  if (running.owner !== "cli") return { status: "foreign", running };

  process.kill(running.pid, "SIGTERM");
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (isPidAlive(running.pid) && Date.now() < deadline) await sleep(100);
  if (isPidAlive(running.pid)) {
    process.kill(running.pid, "SIGKILL");
    await sleep(200);
  }
  clearMockRuntime(paths.mockAssetsDir, running.pid);
  return { status: "stopped", pid: running.pid };
}

export async function stop() {
  const result = await stopDaemon();
  if (result.status === "not-running") {
    console.log("mock 未在运行。");
    return 0;
  }
  if (result.status === "foreign") {
    throw new CliError(
      `这个 mock 是由${ownerLabel(result.running)}启动的（${result.running.url}），请在 vjtools app 里停止。`,
    );
  }
  console.log(`✔ mock 已停止（pid ${result.pid}）`);
  return 0;
}

export async function restart() {
  await stop();
  return start();
}

// ─── status ──────────────────────────────────────────────────────────────────

export async function status({ json = false } = {}) {
  const paths = cliPaths();
  const config = readMockConfig(paths.configFile);
  const running = await detectRunningMock(paths, config);

  if (json) {
    printJson({
      running: Boolean(running),
      owner: running?.owner ?? null,
      startedBy: running?.startedBy ?? null,
      pid: running?.pid ?? null,
      url: running?.url ?? mockBaseUrl(config.host, config.port),
      routes: running?.health?.routes ?? null,
      files: running?.health?.files ?? null,
      backendBaseUrl: running ? running.health?.backendBaseUrl ?? null : config.backendBaseUrl || null,
      mockAll: running ? running.health?.mockAll ?? null : config.mockAll,
      startedAt: running?.startedAt ?? null,
      logFile: running?.logFile ?? null,
      specPath: config.specPath || null,
      rulesFile: paths.rulesFile,
      configFile: paths.configFile,
    });
  } else if (running) {
    printRunning(running);
  } else {
    console.log(`○ mock 未运行（配置地址 ${mockBaseUrl(config.host, config.port)}）`);
    console.log("  启动：vjtools mock start");
  }
  return running ? 0 : NOT_RUNNING_EXIT_CODE;
}

// ─── logs ────────────────────────────────────────────────────────────────────

export async function logs({ lines = 50, follow = false } = {}) {
  const paths = cliPaths();
  const running = await detectRunningMock(paths, readMockConfig(paths.configFile));
  if (running && running.owner !== "cli") {
    console.log(`当前 mock 由${ownerLabel(running)}运行，日志在 app 的 mock 面板里。`);
    return 0;
  }
  if (!fs.existsSync(paths.logFile)) {
    console.log("暂无日志（只有 vjtools mock start 后台启动的 mock 会写日志文件）。");
    return 0;
  }

  const text = tailText(paths.logFile, lines);
  if (text) console.log(text);
  if (!follow) return 0;

  let offset = fs.statSync(paths.logFile).size;
  fs.watchFile(paths.logFile, { interval: 300 }, (curr) => {
    if (curr.size < offset) offset = 0; // 重启 mock 时日志被截断重写
    if (curr.size === offset) return;
    const stream = fs.createReadStream(paths.logFile, { start: offset, end: curr.size - 1 });
    offset = curr.size;
    stream.pipe(process.stdout, { end: false });
  });
  // 一直跟随到 Ctrl+C
  await new Promise(() => {});
}
