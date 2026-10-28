// mock-rules.json / mock-data 必须放到用户可写目录（userData），不能写到 .app 包内
// （macOS 已签名/quarantined 应用包是只读的）。首次启动时把内置资源复制过去作为种子。
// 需在 app.whenReady 后调用。实际逻辑在 seed-assets.js（vjtools CLI 也要用，不能碰 electron）。

import { app } from "electron";
import { seedMockAssets } from "./seed-assets.js";

export function ensureUserMockAssets() {
  return seedMockAssets(app.getPath("userData"));
}
