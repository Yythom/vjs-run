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
import { detectRunningMock, ownerLabel, startDaemon, stopDaemon } from "../cli/mock-daemon.js";

export const MOCK_ID = "__mock__";

// 改配置触发的重启要重新加载全部 spec，留足时间
const RECONNECT_TIMEOUT_MS = 60_000;
const RECONNECT_POLL_MS = 300;
const REPLAY_LOG_LINES = 200;

let status = "stopped";
let current = null; // 当前连着的后台进程（mock-runtime 记录 + health）
let watching = null; // { controller: AbortController }

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
  const running = await detectRunningMock(daemonPaths(), toMockConfig(getConfig()));
  if (running) attach(running);
  return running;
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
  try {
    const text = fs.readFileSync(file, "utf8").trimEnd().split("\n").slice(-REPLAY_LOG_LINES).join("\n");
    if (text) log(text);
  } catch {
    // 日志文件不存在：没什么可补的
  }
}

async function watchLoop(initial, signal) {
  let running = initial;
  while (!signal.aborted) {
    current = running;
    setStatus("running");
    const outcome = await streamEvents(running.url, signal);
    if (signal.aborted) return;
    if (outcome === "unsupported") {
      log("⚠ 当前 mock 不支持事件推送（旧版本），请求历史和录制暂不可用，重启一次 mock 即可");
      await waitUntilGone(running, signal);
      if (signal.aborted) return;
    }

    // 连接断了：要么后台进程在重启（改了配置，pid 不变），要么已经退出
    setStatus("starting");
    running = await waitForMock(running, signal);
    if (signal.aborted) return;
    if (!running) {
      current = null;
      watching = null;
      sendLog(MOCK_ID, "\x1b[33m■ mock 后台进程已退出\x1b[0m\n");
      setStatus("stopped");
      return;
    }
  }
}

async function waitForMock(previous, signal) {
  const deadline = Date.now() + RECONNECT_TIMEOUT_MS;
  while (!signal.aborted && Date.now() < deadline) {
    const live = await findLiveMockRuntime(daemonPaths().mockAssetsDir);
    if (live) return live;
    if (previous.pid && !isPidAlive(previous.pid)) return null;
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_POLL_MS));
  }
  return null;
}

// 旧版本不推事件时，只能靠进程还在不在来判断
async function waitUntilGone(running, signal) {
  while (!signal.aborted && (!running.pid || isPidAlive(running.pid))) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/** @returns {Promise<"closed" | "unsupported">} */
async function streamEvents(url, signal) {
  let res;
  try {
    res = await fetch(`${url}/__mock/events`, { signal });
  } catch {
    return "closed";
  }
  if (res.status === 404) return "unsupported";
  if (!res.ok || !res.body) return "closed";

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
  return "closed";
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
