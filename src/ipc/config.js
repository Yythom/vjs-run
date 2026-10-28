// 配置读写 IPC：get-config 直接吐 live config，set-config 合并保存。
// 改了 mock 关键字段不用这里管：mock 后台进程自己监听 config.json 并重启，app 的订阅会自动重连。

import { app, ipcMain } from "electron";
import { ipcSafe } from "./safe.js";
import {
  getConfig,
  onExternalConfigChange,
  saveConfig,
} from "../config/store.js";
import { sendToAllWindows } from "../ui-channel.js";
import { stopAllProcesses } from "../process-manager.js";

export function registerConfigIpc() {
  // config.json 被外部（如 AI 用 vjtools mock config 命令）改写：推给渲染层刷新
  onExternalConfigChange((_prev, next) => {
    sendToAllWindows("config-changed", { ...next, _appVersion: app.getVersion() });
  });

  ipcMain.handle("get-config", () => ({
    ...getConfig(),
    _appVersion: app.getVersion(),
  }));

  ipcSafe("set-config", async (_, partial) => {
    if (partial.frontendProjectGroups) {
      stopAllProcesses();
    }

    const next = saveConfig(partial);

    // 渲染进程拿到返回值后会整体替换 config state，这里必须把 _appVersion 一起带上，
    // 否则侧边栏的版本号会在保存配置后丢失、回落到兜底值。
    return { config: { ...next, _appVersion: app.getVersion() } };
  });
}
