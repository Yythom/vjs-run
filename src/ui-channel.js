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

function send(channel, payload) {
  for (const win of windows) {
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

import { appendLog, clearLog } from "./log-buffer.js";

export function sendLog(projectId, data) {
  if (data === null) {
    clearLog(projectId);
  } else {
    appendLog(projectId, data);
  }
  send("process-log", { projectId, data });
}

export function sendStatus(projectId, status) {
  send("process-status", { projectId, status });
}

// Mock server 每处理完一个请求推一条结构化记录（请求历史面板实时更新）
export function sendMockRequest(entry) {
  send("mock-request", entry);
}

// 录制状态变化（开始/停止/新录到一条）推给渲染层
export function sendMockRecording(status) {
  send("mock-recording", status);
}
