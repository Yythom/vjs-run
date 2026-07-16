// 自动升级核心模块：基于 electron-updater + GitHub Releases。
//
// 设计要点：
//   - autoDownload = false：不自动下载，等用户点击「检查更新」后手动触发。
//   - dev 模式下跳过（autoUpdater.checkForUpdates 会抛错，因为没有 app-update.yml）。
//   - 所有升级状态通过 IPC 推送给 renderer，由 renderer 展示 toast / 进度。

import { app, shell, session } from "electron";
import pkg from "electron-updater";
const { autoUpdater } = pkg;
import { sendToAllWindows } from "../ui-channel.js";
import path from "node:path";

// ── 配置 ────────────────────────────────────────────────────────────────────────
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;
// 日志写到 electron 的 userData/logs，方便排查
autoUpdater.logger = console;

let latestDmgUrl = null;
let activeDownloadItem = null;

// ── 状态推送 ─────────────────────────────────────────────────────────────────────
// 所有事件统一包装成 { status, ...payload } 推给 renderer。
// status: "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error"

autoUpdater.on("checking-for-update", () => {
  sendToAllWindows("update-status", { status: "checking" });
});

autoUpdater.on("update-available", async (info) => {
  try {
    const provider = await autoUpdater.clientPromise;
    const resolvedFiles = provider.resolveFiles(info);
    
    // 找出以 .dmg 结尾的安装包
    const dmgFile = resolvedFiles.find((f) => {
      const urlStr = typeof f.url === "string" ? f.url : (f.url.href || f.url.toString() || "");
      return urlStr.toLowerCase().endsWith(".dmg");
    });
    
    if (dmgFile) {
      latestDmgUrl = typeof dmgFile.url === "string" ? dmgFile.url : dmgFile.url.href;
      console.log("[AutoUpdater] Resolved DMG URL:", latestDmgUrl);
    } else {
      latestDmgUrl = null;
      console.warn("[AutoUpdater] No DMG file found in update info.");
    }
  } catch (err) {
    latestDmgUrl = null;
    console.error("[AutoUpdater] Failed to resolve DMG URL:", err);
  }

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

// 针对未签名 macOS 应用：下载 DMG 并在下载完成后直接唤起 Finder 打开
export function downloadUpdate() {
  if (!latestDmgUrl) {
    // 如果没有解析到 DMG URL，兜底直接用浏览器打开 Releases 页面
    shell.openExternal("https://github.com/Yythom/vjs-run/releases");
    sendToAllWindows("update-status", { status: "not-available" });
    return Promise.resolve(null);
  }

  if (activeDownloadItem) {
    console.warn("[AutoUpdater] Download already in progress.");
    return Promise.resolve(null);
  }

  sendToAllWindows("update-status", { status: "downloading" });

  const currentSession = session.defaultSession;
  
  // 注册单次下载监听
  currentSession.once("will-download", (event, item) => {
    activeDownloadItem = item;
    const fileName = item.getFilename();
    const savePath = path.join(app.getPath("downloads"), fileName);
    item.setSavePath(savePath);

    item.on("updated", (event, state) => {
      if (state === "interrupted") {
        sendToAllWindows("update-status", { status: "error", message: "下载被中断" });
        activeDownloadItem = null;
      } else if (state === "progressing") {
        if (!item.isPaused()) {
          const total = item.getTotalBytes();
          const transferred = item.getReceivedBytes();
          const percent = total > 0 ? (transferred / total) * 100 : 0;
          
          sendToAllWindows("update-progress", {
            percent,
            transferred,
            total,
          });
        }
      }
    });

    item.once("done", (event, state) => {
      activeDownloadItem = null;
      if (state === "completed") {
        sendToAllWindows("update-status", { status: "downloaded" });
        // 下载完成后，直接用系统默认程序打开/挂载 DMG 安装包
        shell.openPath(savePath);
      } else {
        sendToAllWindows("update-status", { status: "error", message: `下载失败: ${state}` });
      }
    });
  });

  currentSession.downloadURL(latestDmgUrl);
  return Promise.resolve(null);
}

export function quitAndInstall() {
  // 未签名应用无需 quitAndInstall
}
