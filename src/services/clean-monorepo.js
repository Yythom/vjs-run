// 清理 monorepo：删除指定 repo 下的 node_modules / dist / .turbo / build 目录，
// 可选附带 pnpm install。日志/状态都打到 CLEAN_LOG_ID 这一个独立面板。

import { sendLog, sendStatus } from "../ui-channel.js";
import { runStreaming } from "../process-manager.js";

export const CLEAN_LOG_ID = "__clean__";
const CLEAN_TARGETS = ["node_modules", "dist", ".turbo", "build"];

// 当前正在执行的清理子进程 + 用户是否已请求终止。整个序列同一时刻只跑一个，单例即可。
let currentCleanChild = null;
let cleanAborted = false;

/** 终止进行中的清理：杀掉当前子进程并打断后续步骤。无进行中任务时为 no-op。 */
export function abortCleanSequence() {
  cleanAborted = true;
  if (currentCleanChild) {
    try {
      currentCleanChild.kill("SIGTERM");
    } catch (_) {}
  }
}

export async function runCleanSequence(repo, { withInstall = false } = {}) {
  if (!repo.path) throw new Error(`${repo.label} 路径未配置`);
  cleanAborted = false;
  sendStatus(CLEAN_LOG_ID, "starting");
  sendLog(
    CLEAN_LOG_ID,
    `\x1b[36m🧹 开始清理 ${repo.label}: ${repo.path}\x1b[0m\n`,
  );
  const track = (proc) => {
    currentCleanChild = proc;
  };

  try {
    for (const name of CLEAN_TARGETS) {
      if (cleanAborted) return endAborted();
      await runStreaming(
        CLEAN_LOG_ID,
        `find . -name "${name}" -type d -prune -exec rm -rf '{}' +`,
        { cwd: repo.path, onChild: track },
      );
    }
    if (cleanAborted) return endAborted();

    if (withInstall) {
      sendLog(CLEAN_LOG_ID, `\n\x1b[36m📦 执行 pnpm install\x1b[0m\n`);
      await runStreaming(CLEAN_LOG_ID, "pnpm install", {
        cwd: repo.path,
        onChild: track,
      });
      if (cleanAborted) return endAborted();
      sendLog(CLEAN_LOG_ID, `\n\x1b[32m✔ 重装完成\x1b[0m\n`);
    } else {
      sendLog(CLEAN_LOG_ID, `\x1b[32m✔ 清理完成\x1b[0m\n`);
    }
    sendStatus(CLEAN_LOG_ID, "stopped");
  } finally {
    currentCleanChild = null;
  }
}

function endAborted() {
  sendLog(CLEAN_LOG_ID, `\n\x1b[33m■ 已终止清理\x1b[0m\n`);
  sendStatus(CLEAN_LOG_ID, "stopped");
}

/** 把错误日志/状态写到清理面板后继续抛，让 ipcSafe 统一处理 success/error 壳 */
export async function withCleanLogging(fn) {
  try {
    await fn();
  } catch (err) {
    sendLog(CLEAN_LOG_ID, `\x1b[31m✗ ${err.message}\x1b[0m\n`);
    sendStatus(CLEAN_LOG_ID, "error");
    throw err;
  }
}
