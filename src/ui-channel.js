// 集中持有所有活动窗口的引用，对外暴露往所有渲染层广播日志/状态的方法。
// 支持多窗口订阅，以便在主面板和独立日志窗口同步收到日志和状态变更。

const windows = new Set();

export function setMainWindow(win) {
  if (win) {
    windows.add(win);
  }
}

export function addWindow(win) {
  if (win) {
    windows.add(win);
  }
}

export function removeWindow(win) {
  windows.delete(win);
}

export function sendToAllWindows(channel, payload) {
  for (const win of windows) {
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

import { appendLog, clearLog } from "./log-buffer.js";

// dev server 输出密集时 stdout 每秒能来上百个小 chunk，逐个 IPC 会让主进程和渲染层
// 都忙于收发。这里按 projectId 攒一小段时间再合并成一条发出去，肉眼察觉不到延迟。
const LOG_FLUSH_INTERVAL_MS = 30;
const pendingLogs = new Map(); // projectId -> string[]
let flushTimer = null;

export function flushLogs() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  for (const [projectId, chunks] of pendingLogs) {
    const data = chunks.join("");
    appendLog(projectId, data);
    sendToAllWindows("process-log", { projectId, data });
  }
  pendingLogs.clear();
}

export function sendLog(projectId, data) {
  if (data === null) {
    // 清空必须排在之前攒下的日志后面，否则清空后又冒出旧日志
    flushLogs();
    clearLog(projectId);
    sendToAllWindows("process-log", { projectId, data });
    return;
  }
  if (!data) return;
  const chunks = pendingLogs.get(projectId);
  if (chunks) chunks.push(data);
  else pendingLogs.set(projectId, [data]);
  flushTimer ??= setTimeout(flushLogs, LOG_FLUSH_INTERVAL_MS);
}

export function sendStatus(projectId, status) {
  // 状态变化前先把日志推完，保证「■ Process exited」这类收尾日志先于状态到达
  flushLogs();
  sendToAllWindows("process-status", { projectId, status });
}

// Mock server 每处理完一个请求推一条结构化记录（请求历史面板实时更新）
export function sendMockRequest(entry) {
  sendToAllWindows("mock-request", entry);
}

// 录制状态变化（开始/停止/新录到一条）推给渲染层
export function sendMockRecording(status) {
  sendToAllWindows("mock-recording", status);
}
