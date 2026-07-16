// 自动升级核心模块：基于 electron-updater + GitHub Releases。
//
// 设计要点：
//   - autoDownload = false：不自动下载，等用户点击「检查更新」后手动触发。
//   - dev 模式下跳过（autoUpdater.checkForUpdates 会抛错，因为没有 app-update.yml）。
//   - 所有升级状态通过 IPC 推送给 renderer，由 renderer 展示 toast / 进度。

import { app, shell } from "electron";
import pkg from "electron-updater";
const { autoUpdater } = pkg;
import { sendToAllWindows } from "../ui-channel.js";

// ── 配置 ────────────────────────────────────────────────────────────────────────
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;
// 日志写到 electron 的 userData/logs，方便排查
autoUpdater.logger = console;

// ── 状态推送 ─────────────────────────────────────────────────────────────────────
// 所有事件统一包装成 { status, ...payload } 推给 renderer。
// status: "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error"

autoUpdater.on("checking-for-update", () => {
  sendToAllWindows("update-status", { status: "checking" });
});

autoUpdater.on("update-available", (info) => {
  sendToAllWindows("update-status", {
    status: "available",
    version: info.version,
    releaseNotes: info.releaseNotes,
    releaseDate: info.releaseDate,
  });
});

autoUpdater.on("update-not-available", (info) => {
  sendToAllWindows("update-status", {
    status: "not-available",
    version: info.version,
  });
});

autoUpdater.on("download-progress", (progress) => {
  sendToAllWindows("update-progress", {
    percent: progress.percent,
    bytesPerSecond: progress.bytesPerSecond,
    transferred: progress.transferred,
    total: progress.total,
  });
});

autoUpdater.on("update-downloaded", (info) => {
  sendToAllWindows("update-status", {
    status: "downloaded",
    version: info.version,
  });
});

autoUpdater.on("error", (err) => {
  sendToAllWindows("update-status", {
    status: "error",
    message: err?.message || String(err),
  });
});

// ── 暴露给 IPC 层的方法 ──────────────────────────────────────────────────────────

export function checkForUpdates() {
  if (!app.isPackaged) {
    // dev 模式直接告知：不可用
    sendToAllWindows("update-status", { status: "dev-skip" });
    return Promise.resolve(null);
  }
  return autoUpdater.checkForUpdates();
}

// 针对未签名 macOS 应用：不走热更新，直接调用系统默认浏览器打开 GitHub 下载页面
export function downloadUpdate() {
  // 也可以根据 package.json 中的配置动态获取，这里直接使用 GitHub Releases 地址
  shell.openExternal("https://github.com/Yythom/vjs-run/releases");
  return Promise.resolve(null);
}

export function quitAndInstall() {
  // 未签名应用无需 quitAndInstall
}

