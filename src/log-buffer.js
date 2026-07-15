// 主进程日志缓冲区，用于缓存各个项目和服务的历史日志。
// 当新开窗口（或重新加载页面）时，渲染进程能向主进程请求拉取已有的历史日志，避免日志丢失。

const MAX_LOG_LENGTH = 150_000; // 单个项目缓存字符上限，防止内存泄露
const logBuffers = new Map(); // projectId -> string

export function appendLog(projectId, chunk) {
  if (!chunk) return;
  const current = logBuffers.get(projectId) || "";
  const next = current + chunk;
  if (next.length > MAX_LOG_LENGTH) {
    // 保留最新的日志段
    logBuffers.set(projectId, next.slice(next.length - MAX_LOG_LENGTH));
  } else {
    logBuffers.set(projectId, next);
  }
}

export function getLog(projectId) {
  return logBuffers.get(projectId) || "";
}

export function clearLog(projectId) {
  logBuffers.delete(projectId);
}
