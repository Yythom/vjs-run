// 桌面通知。
//
// 单独成文件是为了断开 runner ↔ listener 的循环引用：runner 只用得到这一个函数，
// 以前从 listener 导入，谁先被加载就看 IPC 的注册顺序——runner 先加载时，
// listener 顶层调 setJobSettledHook 会撞上 runner 里还没初始化的变量，主进程启动即崩。
//
// electron 按需动态导入：测试环境没有 Notification，静默跳过。

let electronModule = null;
async function getElectron() {
  if (!electronModule) {
    try {
      electronModule = await import("electron");
    } catch {
      electronModule = null;
    }
  }
  return electronModule;
}

export async function showDesktopNotification({ title, body }) {
  try {
    const electron = await getElectron();
    const NotificationClass = electron?.Notification;
    if (NotificationClass && typeof NotificationClass.isSupported === "function" && NotificationClass.isSupported()) {
      const notif = new NotificationClass({
        title,
        body: body ? String(body).slice(0, 200) : "",
        silent: false,
      });
      notif.on("click", () => {
        const windows = electron?.BrowserWindow?.getAllWindows?.() || [];
        if (windows.length > 0) {
          const win = windows[0];
          if (win.isMinimized?.()) win.restore?.();
          win.focus?.();
        }
      });
      notif.show();
    }
  } catch (err) {
    console.error("[docking] 发送桌面通知失败", err);
  }
}
