// mock-rules.json / mock-data 必须放到用户可写目录（userData），不能写到 .app 包内
// （macOS 已签名/quarantined 应用包是只读的）。首次启动时把内置资源复制过去作为种子。
// 需在 app.whenReady 后调用。

import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { BUILTIN_MOCK_ASSETS_DIR } from "../paths.js";

export function ensureUserMockAssets() {
  const userDir = path.join(app.getPath("userData"), "mock-assets");
  if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });

  const rulesFile = path.join(userDir, "mock-rules.json");
  if (!fs.existsSync(rulesFile)) {
    const seed = path.join(BUILTIN_MOCK_ASSETS_DIR, "mock-rules.json");
    try {
      if (fs.existsSync(seed)) fs.copyFileSync(seed, rulesFile);
      else fs.writeFileSync(rulesFile, "[]\n");
    } catch (_) {
      fs.writeFileSync(rulesFile, "[]\n");
    }
  }

  const dataDir = path.join(userDir, "mock-data");
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  return { userDir, rulesFile, dataDir };
}
