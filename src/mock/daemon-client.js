// app 作为 mock 后台进程的客户端：启动 / 停止 / 接上已在跑的 / 断线重连。
//
// mock 只有一种运行方式——后台进程（见 src/cli/mock-daemon.js），app 用自带的 Electron
// （ELECTRON_RUN_AS_NODE）拉起它，再订阅它的 /__mock/events，把事件转成原来的 IPC 事件
// （process-status / process-log / mock-request），渲染层不用改。
//
// 录制留在 app：后台进程只推请求记录，这里收到后交给 recorder.js，和以前进程内跑 mock 时一样。
// app 退出时只断开订阅、不停后台进程——AI / 终端还在用，下次打开 app 直接接上。
//
// 不 import electron：userData 由 mockRulesFile（固定在 <userData>/mock-assets/ 下）推出来，
// 方便在纯 node 里测。

import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { getConfig } from "../config/store.js";
import { sendLog, sendMockRequest, sendStatus } from "../ui-channel.js";
import { handleRecordedEntry } from "./recorder.js";
import { findLiveMockRuntime, isPidAlive } from "./runtime.js";
import { cliPaths } from "../cli/user-data.js";
import { toMockConfig } from "../cli/config.js";
import { detectRunningMock, otherDataDirHint, ownerLabel, startDaemon, stopDaemon } from "../cli/mock-daemon.js";

export const MOCK_ID = "__mock__";

// 改配置触发的重启要重新加载全部 spec，留足时间
const RECONNECT_TIMEOUT_MS = 60_000;
const RECONNECT_POLL_MS = 300;
// 事件订阅被拒（HTTP 403 等）时的重试退避上限
const REJECTED_RETRY_MAX_MS = 30_000;
const REPLAY_LOG_LINES = 200;

let status = "stopped";
let current = null; // 当前连着的后台进程（mock-runtime 记录 + health）
let watching = null; // { controller: AbortController }
// 日志面板已经显示到后台进程日志文件的哪个位置（字节）：断线重连 / 进程退出时从这里补齐漏掉的内容。
// 按字节记而不是按「最后一行的内容」去找：时间戳只到秒，同一秒内重启时前后两段启动日志一字不差，按内容会找错位置
let shownLog = { file: null, offset: 0 };

function userDataDir() {
  return path.dirname(path.dirname(getConfig().mockRulesFile));
}

function daemonPaths() {
  return cliPaths(userDataDir());
}

function log(message) {
  sendLog(MOCK_ID, `\x1b[2m${message}\x1b[0m\n`);
}

function setStatus(next) {
  if (status === next) return;
  status = next;
  sendStatus(MOCK_ID, next);
}

export function isMockRunning() {
  return status === "running";
}

// ─── 启停 ─────────────────────────────────────────────────────────────────────

export async function startMock() {
  if (!getConfig().mockSpecPath) throw new Error("Mock spec 路径未配置，请到设置中填写");
  setStatus("starting");
  log("▶ 启动 mock 后台进程");
  try {
    const { status: result, running } = await startDaemon({
      paths: daemonPaths(),
      execPath: process.execPath,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        VJTOOLS_USER_DATA_DIR: userDataDir(),
        VJTOOLS_STARTED_BY: "app",
      },
    });
    if (result === "already") log(`mock 已在运行（${ownerLabel(running)}），直接接上`);
    attach(running);
    return running;
  } catch (err) {
    sendLog(MOCK_ID, `\x1b[31m✗ Swagger Mock 启动失败: ${err.message}\x1b[0m\n`);
    setStatus("error");
    throw err;
  }
}

export async function stopMock() {
  detachMock();
  const result = await stopDaemon({ paths: daemonPaths() });
  if (result.status === "foreign") {
    // 别的数据目录的进程：不接上（它的规则、历史都不是这边的）
    if (result.running.owner === "other") throw new Error(`端口上的 mock 不是这个数据目录的。${otherDataDirHint(result.running)}`);
    // 旧版 app 在进程内跑的 mock：后台进程管不了它
    attach(result.running);
    throw new Error(`端口上的 mock 是${ownerLabel(result.running)}，这里停不了，请在启动它的地方停止`);
  }
  current = null;
  sendLog(MOCK_ID, "\x1b[32m✔ Swagger Mock 已停止\x1b[0m\n");
  setStatus("stopped");
}

/** app 启动时调用：已有后台进程在跑（命令行或上次 app 拉起的）就直接接上 */
export async function attachIfRunning() {
  const found = await detectRunningMock(daemonPaths(), toMockConfig(getConfig()));
  // 别的数据目录的进程恰好占着同一个端口：不接上，当作这边没在跑（启动时会报端口被它占用）
  const running = found?.owner === "other" ? null : found;
  if (running) attach(running);
  return running;
}

/**
 * 重新检查后台进程。app 开着时在终端 vjtools mock start，app 收不到通知，靠这里（界面上的「重新检查」）补上。
 * 已经连着的不用查：断开、退出都由 watchLoop 自己感知；启动 / 重连中的也不插手，免得重复接上
 * @returns {Promise<{ status: string, running: object|null }>}
 */
export async function refreshMockStatus() {
  if (watching || status === "starting") return { status, running: current };
  const running = await attachIfRunning();
  // 没在跑：顺带把上次启动失败留下的「出错」清掉
  if (!running) setStatus("stopped");
  return { status, running: running ? { ...running, ownerLabel: ownerLabel(running) } : null };
}

/** 只断开订阅，不停后台进程（app 退出时用） */
export function detachMock() {
  watching?.controller.abort();
  watching = null;
}

// ─── 订阅与重连 ───────────────────────────────────────────────────────────────

function attach(running) {
  detachMock();
  const controller = new AbortController();
  watching = { controller };
  replayLogFile(running.logFile);
  watchLoop(running, controller.signal).catch((err) => console.error("[mock-daemon-client]", err));
}

// 接上时把后台进程已有的日志补进 app 的日志面板（之后的日志走事件推送）
function replayLogFile(file) {
  if (!file) return;
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return; // 日志文件不存在：没什么可补的
  }
  const text = buf.toString("utf8").trimEnd().split("\n").slice(-REPLAY_LOG_LINES).join("\n");
  if (text) log(text);
  shownLog = { file, offset: buf.length };
}

// 后台进程按新配置重启时会先断开事件流：这期间的日志（重启后的新地址、重启失败的原因）只写进了日志文件，
// app 收不到。重连上或发现它退出时，把日志文件里已显示位置之后的内容补上
function replayMissedLog(file) {
  if (!file) return;
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return;
  }
  // 换了文件 / 文件被截断重写（vjtools mock start 起了新进程）：从头补（最多 REPLAY_LOG_LINES 行）
  if (file !== shownLog.file || buf.length < shownLog.offset) {
    shownLog = { file, offset: 0 };
  }
  let start = shownLog.offset;
  // 日志文件里还可能有不经事件流的输出（console.error 等），已显示位置会略微落后、落在某行中间：
  // 从下一行开头补，宁可重复一两行也不截出半行
  if (start > 0 && buf[start - 1] !== 0x0a) {
    const next = buf.indexOf(0x0a, start);
    start = next < 0 ? buf.length : next + 1;
  }
  const text = buf.subarray(start).toString("utf8").trimEnd().split("\n").slice(-REPLAY_LOG_LINES).join("\n");
  if (text) log(text);
  shownLog = { file, offset: buf.length };
}

async function watchLoop(initial, signal) {
  let running = initial;
  let rejectedRetryMs = 0;
  while (!signal.aborted) {
    current = running;
    setStatus("running");
    const { outcome, httpStatus } = await streamEvents(running.url, signal);
    if (signal.aborted) return;
    if (outcome === "rejected") {
      // mock 在跑、只是拒绝订阅：立刻重连会和 health 探活原地打转（打满 CPU、状态来回闪）。
      // mock 本身是好的，状态不动，退避后重试；进程退出 / 换端口重启时下一轮连不上，走下面的正常流程
      if (!rejectedRetryMs) {
        log(`⚠ mock 拒绝了事件订阅（HTTP ${httpStatus}），请求日志、历史推送和录制暂不可用，稍后自动重试`);
      }
      rejectedRetryMs = Math.min(rejectedRetryMs * 2 || 1000, REJECTED_RETRY_MAX_MS);
      await delay(rejectedRetryMs, signal);
      continue;
    }
    rejectedRetryMs = 0;
    if (outcome === "unsupported") {
      log("⚠ 当前 mock 不支持事件推送（旧版本），请求历史和录制暂不可用，重启一次 mock 即可");
      await waitUntilGone(running, signal);
      if (signal.aborted) return;
    }

    // 连接断了：要么后台进程在重启（改了配置，pid 不变），要么已经退出
    setStatus("starting");
    const previous = running;
    running = await waitForMock(running, signal);
    if (signal.aborted) return;
    // 断线期间写进日志文件的内容（重启后的「✔ mock 已启动 …」、失败原因）补进面板，再接着订阅
    replayMissedLog((running || previous).logFile);
    if (!running) {
      current = null;
      watching = null;
      sendLog(MOCK_ID, "\x1b[33m■ mock 后台进程已退出\x1b[0m\n");
      setStatus("stopped");
      return;
    }
  }
}

// 先等再查：事件流不管因为什么一断上就立刻 health 通过，也不会无休眠地重连
async function waitForMock(previous, signal) {
  const deadline = Date.now() + RECONNECT_TIMEOUT_MS;
  while (!signal.aborted && Date.now() < deadline) {
    await delay(RECONNECT_POLL_MS, signal);
    if (signal.aborted) return null;
    const live = await findLiveMockRuntime(daemonPaths().mockAssetsDir);
    if (live) return live;
    if (previous.pid && !isPidAlive(previous.pid)) return null;
  }
  return null;
}

/** 可被 detach 打断的等待：app 退出 / 重新接上时不用等满退避时间 */
function delay(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

// 旧版本不推事件时，只能靠进程还在不在来判断
async function waitUntilGone(running, signal) {
  while (!signal.aborted && (!running.pid || isPidAlive(running.pid))) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/**
 * @returns {Promise<{ outcome: "closed" | "unsupported" | "rejected", httpStatus?: number }>}
 *   rejected：mock 在线但拒绝订阅（如 403），重连之前要退避
 */
async function streamEvents(url, signal) {
  let res;
  try {
    res = await fetch(`${url}/__mock/events`, { signal });
  } catch {
    return { outcome: "closed" };
  }
  if (res.status === 404) return { outcome: "unsupported" };
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return { outcome: "rejected", httpStatus: res.status };
  }
  if (!res.body) return { outcome: "closed" };

  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        handleEvent(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
      }
    }
  } catch {
    // 主动断开或后台进程退出
  }
  return { outcome: "closed" };
}

function handleEvent(block) {
  let event = "message";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7);
    else if (line.startsWith("data: ")) data += line.slice(6);
  }
  if (!data) return; // 注释行 / 心跳
  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    return;
  }
  if (event === "request") {
    sendMockRequest(payload);
    handleRecordedEntry(payload);
  } else if (event === "log") {
    log(payload);
    // 后台进程写日志文件就是 console.log(line)：文件里多了 line + 换行这么多字节
    shownLog.offset += Buffer.byteLength(String(payload)) + 1;
  }
}

// ─── 请求历史（存在后台进程里）────────────────────────────────────────────────

export async function fetchMockHistory() {
  if (!current) return [];
  try {
    const res = await fetch(`${current.url}/__mock/history`);
    return res.ok ? await res.json() : [];
  } catch {
    return [];
  }
}

export async function clearMockHistory() {
  if (!current) return;
  await fetch(`${current.url}/__mock/history`, { method: "DELETE" }).catch(() => {});
}
