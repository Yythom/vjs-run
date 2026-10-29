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
  isWildcardHost,
  mockBaseUrl,
  mockLanUrls,
  readMockRuntime,
  writeMockRuntime,
} from "../mock/runtime.js";
import { cliPaths } from "./user-data.js";
import { MOCK_RESTART_FIELDS, assertSpecReady, readMockConfig } from "./config.js";
import { CliError, clockTime, cliVersion, printJson, sleep } from "./util.js";

const CLI_ENTRY = fileURLToPath(new URL("./index.js", import.meta.url));
// 重启也要重新加载 spec，和首次启动用同一个上限
const START_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 5_000;

export const NOT_RUNNING_EXIT_CODE = 3;

/**
 * owner=cli 是后台进程（startedBy 区分谁拉起的）；app / unknown 是旧版 app 在进程内跑的；
 * other 是另一个数据目录（VJTOOLS_USER_DATA_DIR 隔离环境等）的后台进程，恰好配了同一个端口
 */
export function ownerLabel(running) {
  if (running.owner === "cli") {
    return running.startedBy === "app" ? "vjtools app（后台进程）" : "命令行（vjtools mock start）";
  }
  if (running.owner === "app") return "旧版 vjtools app（在 app 进程里运行）";
  if (running.owner === "other") return `另一个数据目录的 vjtools（${running.userDataDir}）`;
  return "未知来源（端口上有 mock，但没有运行记录，可能是旧版 vjtools app）";
}

/** 别的数据目录的 mock 怎么停：给出带 VJTOOLS_USER_DATA_DIR 的命令 */
export function otherDataDirHint(running) {
  return `它属于另一个数据目录，请在那边操作：VJTOOLS_USER_DATA_DIR='${running.userDataDir}' vjtools mock stop`;
}

// 同一个规则文件才是同一个数据目录（/tmp 与 /private/tmp 这类软链按真实路径比）
function sameFile(a, b) {
  if (!a || !b) return false;
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

/**
 * 当前在跑的 mock：优先看运行记录；没有记录但配置端口上有 mock 也算（owner=unknown）。
 * @param {object|null} config 读不出配置时传 null：只看运行记录，不探测端口
 * @returns {Promise<null | {owner, pid, url, health, logFile?, startedAt?, version?}>}
 */
export async function detectRunningMock(paths, config) {
  const live = await findLiveMockRuntime(paths.mockAssetsDir);
  if (live) return live;
  if (!config) return null;
  const url = mockBaseUrl(config.host, config.port);
  const health = await fetchMockHealth(url);
  if (!health) return null;
  if (health.owner === "cli" && isPidAlive(health.pid)) {
    // 运行记录丢了 / 坏了，但端口上就是本数据目录的 CLI 后台进程（health 自报身份 + 规则文件对得上）：
    // 照样当自己起的处理，stop 停得掉。规则文件对不上的是别的数据目录的进程，绝不能当成自己的去停
    if (sameFile(health.mockRulesFile, paths.rulesFile)) {
      const { pid, startedBy, logFile = null, version } = health;
      return { owner: "cli", pid, startedBy, logFile, version, host: config.host, port: config.port, url, health };
    }
    const userDataDir = path.dirname(path.dirname(String(health.mockRulesFile || "")));
    return { owner: "other", pid: health.pid, userDataDir, url, health };
  }
  return { owner: "unknown", pid: health.pid ?? null, url, health };
}

/**
 * 只是找在跑的进程（stop / logs / history）时用：config.json 写坏了也不能罢工——守护进程遇到坏配置
 * 会忽略变更继续跑，这时用户最需要的就是能停掉它、看它的日志
 */
export function detectRunningMockLenient(paths) {
  let config = null;
  try {
    config = readMockConfig(paths.configFile);
  } catch {
    // 坏配置：只看运行记录
  }
  return detectRunningMock(paths, config);
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
  // 写进运行记录的身份信息，同时经 /__mock/health 自报（运行记录丢了也认得出）
  const identity = {
    owner: "cli",
    logFile: daemon ? paths.logFile : null,
    version: cliVersion().version,
    // app 拉起时会带上这个环境变量，status 据此显示「vjtools app（后台进程）」
    startedBy: process.env.VJTOOLS_STARTED_BY === "app" ? "app" : "cli",
  };

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
        identity,
      });
    } catch (err) {
      if (err?.code === "EADDRINUSE") throw new CliError(portInUseMessage(config.port));
      throw err;
    }
    current = config;
    // 先写日志、再写运行记录：app 以「运行记录出现 + health 通过」判定重连成功，随即从日志文件补齐断线期间的内容。
    // 反过来的话它可能抢在这几行写进文件之前去读，「已启动 + 新地址」就丢了（stdout 写文件是同步的）
    log(
      `✔ mock 已启动 ${mockBaseUrl(config.host, config.port)}（${service.routes.length} 条路由，${service.sources.length} 个 spec 文件）`,
    );
    log(`  spec    ${config.specPath}`);
    log(`  后端    ${config.backendBaseUrl || "(未配置，未命中 mock 的接口返回 404/502)"}`);
    log(`  规则    ${rulesFile}`);
    writeMockRuntime(paths.mockAssetsDir, {
      ...identity,
      pid: process.pid,
      host: config.host,
      port: config.port,
    });
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
  // 配的 0.0.0.0：上面是本机访问用的地址，这里说明实际监听在所有网卡，并列出局域网地址
  if (running.host && isWildcardHost(running.host)) {
    console.log(`  监听      ${running.host}:${running.port}（所有网卡）`);
    for (const url of mockLanUrls(running.host, running.port)) console.log(`  局域网    ${url}`);
  }
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
  return withStartLock(paths, async () => {
    // 拿到锁之后再查：等锁期间可能别人已经起好了
    const config = readMockConfig(paths.configFile);
    const running = await detectRunningMock(paths, config);
    if (running?.owner === "other") {
      // 那个进程用的是别的规则和配置，当成「已在运行」接上只会让人对着不生效的规则排查半天
      throw new CliError(
        `端口 ${config.port} 被${ownerLabel(running)}的 mock 占用了。\n` +
          `  · ${otherDataDirHint(running)}\n  · 或换个端口：vjtools mock config --port <端口>`,
      );
    }
    if (running) return { status: "already", running };
    // 子进程里也会校验，这里先挡一次，错误信息能直接回到调用方而不是埋在日志里
    assertSpecReady(config);
    return spawnDaemon(paths, execPath, env);
  });
}

/**
 * 同一时刻只让一个 startDaemon 真正去拉进程（app 和命令行、两个 AI 调用可能同时 start）。不加锁时
 * 两边都判定「没在跑」各拉一个：后拉的撞端口退出，还用 "w" 截断了共用的日志文件，发起它的一方误报「启动失败」。
 * 锁文件里记持有者 pid，持有者已经不在、或锁比启动超时还老，就当残留清掉。
 */
async function withStartLock(paths, fn) {
  const lockFile = path.join(paths.mockAssetsDir, "mock-starting.lock");
  const deadline = Date.now() + START_TIMEOUT_MS + 5_000;
  for (;;) {
    if (tryCreateLock(lockFile)) break;
    let holder;
    let ageMs;
    try {
      holder = Number(fs.readFileSync(lockFile, "utf8"));
      ageMs = Date.now() - fs.statSync(lockFile).mtimeMs;
    } catch {
      continue; // 刚好被释放：重新抢
    }
    // 读不出 pid（手动建的空文件等）只按年龄判残留，不能当成「持有者已退出」立刻删
    const stale = Number.isInteger(holder) && holder > 0 ? !isPidAlive(holder) : ageMs > 2_000;
    if (stale || ageMs > START_TIMEOUT_MS + 5_000) {
      fs.rmSync(lockFile, { force: true });
      continue;
    }
    if (Date.now() > deadline) throw new CliError(`等待另一个 mock 启动操作超时（pid ${holder}）`);
    await sleep(200);
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
}

// 原子地建锁：pid 先写进临时文件，再 link 成锁文件（已存在则 EEXIST）。直接 writeFileSync(wx) 会有
// 「文件建好了、pid 还没写进去」的空窗，别人这时读到空内容会误判成残留锁删掉，两边就都去拉进程了
let lockTmpSeq = 0;

function tryCreateLock(lockFile) {
  // pid + 进程内序号保证唯一：同一进程（app）同一毫秒里并发 start 也不会共用同一个临时文件
  const tmp = `${lockFile}.${process.pid}.${++lockTmpSeq}`;
  fs.writeFileSync(tmp, String(process.pid));
  try {
    fs.linkSync(tmp, lockFile);
    return true;
  } catch (err) {
    if (err.code === "EEXIST") return false;
    throw err;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function spawnDaemon(paths, execPath, env) {

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
  let spawnError = null;
  child.on("exit", () => {
    exited = true;
  });
  // 可执行文件不存在 / 没权限时 spawn 不抛，而是异步发 error：不接住整个进程（app 主进程）会崩
  child.on("error", (err) => {
    spawnError = err;
    exited = true;
  });
  child.unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(200);
    if (spawnError) throw new CliError(`mock 启动失败：无法运行 ${execPath}（${spawnError.message}）`);
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
  const running = await detectRunningMockLenient(paths);
  if (!running) return { status: "not-running" };
  if (running.owner !== "cli") return { status: "foreign", running };

  killQuietly(running.pid, "SIGTERM");
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (isPidAlive(running.pid) && Date.now() < deadline) await sleep(100);
  if (isPidAlive(running.pid)) {
    killQuietly(running.pid, "SIGKILL");
    await sleep(200);
  }
  clearMockRuntime(paths.mockAssetsDir, running.pid);
  return { status: "stopped", pid: running.pid };
}

// 探测到它在跑、到发信号之间它可能刚好自己退出了（ESRCH）：目的已经达到，不算失败
function killQuietly(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (err) {
    if (err.code !== "ESRCH") throw err;
  }
}

export async function stop() {
  const result = await stopDaemon();
  if (result.status === "not-running") {
    console.log("mock 未在运行。");
    return 0;
  }
  if (result.status === "foreign") {
    const { running } = result;
    throw new CliError(
      running.owner === "other"
        ? `端口上的 mock 不是这个数据目录的（${running.url}）。${otherDataDirHint(running)}`
        : `这个 mock 是由${ownerLabel(running)}启动的（${running.url}），请在 vjtools app 里停止。`,
    );
  }
  console.log(`✔ mock 已停止（pid ${result.pid}）`);
  return 0;
}

export async function restart() {
  // 先确认新进程起得来再停旧的：配置写坏 / spec 目录没了时，原本正常跑着的 mock 不该先被杀掉
  assertSpecReady(readMockConfig(cliPaths().configFile));
  await stop();
  return start();
}

/**
 * 改了 config.json 里影响 server 的字段后，等后台进程按新配置重启完。重启失败（端口被占、spec 目录
 * 不存在…）时进程会直接退出，这里如实报错，免得调用方以为「会自动重启」就万事大吉。
 * @param {object} running 改配置之前 detectRunningMock 拿到的记录（owner=cli）
 * @returns {Promise<object>} 重启后的运行记录（附 health）
 */
export async function waitForDaemonRestart({ paths = cliPaths(), running }) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(200);
    if (!isPidAlive(running.pid)) {
      const log = running.logFile ? tailText(running.logFile, 6) : "";
      throw new CliError(
        `配置已写入，但 mock 按新配置重启失败，已退出${log ? `：\n${log}` : "（原因见运行 vjtools mock serve 的终端）"}\n` +
          "  改好配置后重新启动：vjtools mock start",
      );
    }
    const info = readMockRuntime(paths.mockAssetsDir);
    if (info?.pid !== running.pid || info.startedAt === running.startedAt) continue;
    const health = await fetchMockHealth(info.url);
    if (health?.pid === running.pid) return { ...info, health };
  }
  throw new CliError(
    `配置已写入，但 ${START_TIMEOUT_MS / 1000}s 内没等到 mock 按新配置重启完成。\n  · 查看日志：vjtools mock logs`,
  );
}

// ─── status ──────────────────────────────────────────────────────────────────

export async function status({ json = false } = {}) {
  const paths = cliPaths();
  const config = readMockConfig(paths.configFile);
  const found = await detectRunningMock(paths, config);
  // 端口被别的数据目录的进程占着：对这个数据目录来说 mock 没在跑（退出码 3），但要说清楚端口被谁占了
  const occupiedBy = found?.owner === "other" ? found : null;
  const running = occupiedBy ? null : found;

  if (json) {
    printJson({
      running: Boolean(running),
      occupiedBy: occupiedBy ? ownerLabel(occupiedBy) : null,
      owner: running?.owner ?? null,
      startedBy: running?.startedBy ?? null,
      pid: running?.pid ?? null,
      url: running?.url ?? mockBaseUrl(config.host, config.port),
      host: running ? running.host ?? null : config.host,
      lanUrls: running?.host ? mockLanUrls(running.host, running.port) : [],
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
  } else if (occupiedBy) {
    console.log(`○ mock 未运行；配置的端口 ${config.port} 被${ownerLabel(occupiedBy)}占用`);
    console.log(`  ${otherDataDirHint(occupiedBy)}，或换个端口：vjtools mock config --port <端口>`);
  } else {
    console.log(`○ mock 未运行（配置地址 ${mockBaseUrl(config.host, config.port)}）`);
    console.log("  启动：vjtools mock start");
  }
  return running ? 0 : NOT_RUNNING_EXIT_CODE;
}

// ─── logs ────────────────────────────────────────────────────────────────────

export async function logs({ lines = 50, follow = false } = {}) {
  const paths = cliPaths();
  const running = await detectRunningMockLenient(paths);
  if (running?.owner === "other") {
    console.log(`当前端口上的 mock 属于${ownerLabel(running)}，日志在那个数据目录的 logs/ 下。`);
    return 0;
  }
  if (running && running.owner !== "cli") {
    console.log(`当前 mock 由${ownerLabel(running)}运行，日志在 app 的 mock 面板里。`);
    return 0;
  }
  // 前台 vjtools mock serve 不写日志文件：磁盘上的 mock-cli.log 是以前后台运行留下的，打出来只会误导
  if (running && !running.logFile) {
    console.log("当前 mock 在前台运行（vjtools mock serve），日志直接输出在它所在的终端里。");
    return 0;
  }
  const logFile = running?.logFile || paths.logFile;
  if (!fs.existsSync(logFile)) {
    console.log("暂无日志（只有 vjtools mock start 后台启动的 mock 会写日志文件）。");
    return 0;
  }

  const text = tailText(logFile, lines);
  if (text) console.log(text);
  if (!follow) return 0;

  let offset = fs.statSync(logFile).size;
  fs.watchFile(logFile, { interval: 300 }, (curr) => {
    if (curr.size < offset) offset = 0; // 重启 mock 时日志被截断重写
    if (curr.size === offset) return;
    const stream = fs.createReadStream(logFile, { start: offset, end: curr.size - 1 });
    offset = curr.size;
    stream.pipe(process.stdout, { end: false });
  });
  // 一直跟随到 Ctrl+C
  await new Promise(() => {});
}
