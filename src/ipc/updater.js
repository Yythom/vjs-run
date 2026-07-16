// 升级相关 IPC handler：检查更新 / 下载 / 安装重启。
// renderer 通过 preload 暴露的 electronAPI 调用。

import { ipcMain } from "electron";
import {
  checkForUpdates,
  downloadUpdate,
  quitAndInstall,
} from "../services/auto-updater.js";

export function registerUpdaterIpc() {
  ipcMain.handle("check-for-updates", () => checkForUpdates());
  ipcMain.handle("download-update", () => downloadUpdate());
  ipcMain.handle("quit-and-install", () => quitAndInstall());
}
