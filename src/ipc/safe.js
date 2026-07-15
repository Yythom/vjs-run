// 把"返回 success/error 统一壳"的 IPC handler 模板抽出来，避免每个 handler
// 各写一份 try/catch。handler 抛错时返回 { success: false, error, ...errorFallback }；
// 正常返回的对象会和 { success: true } 合并。

import { ipcMain } from "electron";

export function ipcSafe(channel, handler, errorFallback = null) {
  ipcMain.handle(channel, async (...args) => {
    try {
      const result = await handler(...args);
      return { success: true, ...(result || {}) };
    } catch (err) {
      return { success: false, error: err.message, ...(errorFallback || {}) };
    }
  });
}
