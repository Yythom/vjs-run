// 配置读写 IPC：get-config 直接吐 live config，set-config 合并保存。
// set-config 还兼任：改了 mock 关键字段时自动重启 mock 服务。

import { app, ipcMain } from "electron";
import { ipcSafe } from "./safe.js";
import { getConfig, saveConfig } from "../config/store.js";
import { sendLog } from "../ui-channel.js";
import { stopAllProcesses } from "../process-manager.js";

import {
  MOCK_ID,
  isMockRunning,
  startSwaggerMock,
} from "../mock/service.js";

// 改这些 mock 字段需要重启 mock service 才能生效（它们都是 startMockServer 启动时读入的）
const MOCK_FIELDS_REQUIRING_RESTART = [
  "mockSpecPath",
  "mockHost",
  "mockPort",
  "mockServiceAddress",
  "mockBackendBaseUrl",
  "mockAll",
];

export function registerConfigIpc() {
  ipcMain.handle("get-config", () => ({
    ...getConfig(),
    _appVersion: app.getVersion(),
  }));

  ipcSafe("set-config", async (_, partial) => {
    if (partial.frontendProjectGroups) {
      stopAllProcesses();
    }

    const prev = getConfig();
    const next = saveConfig(partial);



    const mockChanged = MOCK_FIELDS_REQUIRING_RESTART.some(
      (key) => prev[key] !== next[key],
    );
    if (isMockRunning() && mockChanged) {
      sendLog(
        MOCK_ID,
        `\x1b[36m⚙ 检测到 mock 配置改动，自动重启 Swagger Mock\x1b[0m\n`,
      );
      try {
        await startSwaggerMock(MOCK_ID);
      } catch (_) {
        // startSwaggerMock 内部已经写过错误日志，这里不抛出，避免影响 set-config 的成功状态
      }
    }

    return { config: next };
  });
}
