// 原生系统通知封装。目前用于：项目进程崩溃/异常退出时提醒。
// 点击通知把主窗口唤到前台。

import { BrowserWindow, Notification } from "electron";

/**
 * 弹一条「进程崩溃」系统通知。
 * @param {string} name    项目名（标题里展示）
 * @param {string} message 简短原因（通知正文）
 */
export function notifyProcessCrash(name, message) {
  if (!Notification.isSupported()) return;
  try {
    const notification = new Notification({
      title: `⚠️ ${name} 崩溃了`,
      body: message || "进程异常退出，点击查看日志",
    });
    notification.on("click", () => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    });
    notification.show();
  } catch (err) {
    // 通知失败不致命（无权限/无桌面环境等），只打日志
    console.error("[notify]", err);
  }
}
