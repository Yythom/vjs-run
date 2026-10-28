// 把内置 mock 资源（mock-rules.json / mock-data）作为种子复制到 <userData>/mock-assets。
// 纯 node 实现，app（user-assets.js 传 app.getPath("userData")）和 vjtools CLI 共用。

import fs from "node:fs";
import path from "node:path";
import { BUILTIN_MOCK_ASSETS_DIR } from "../paths.js";

export function seedMockAssets(userDataDir) {
  const userDir = path.join(userDataDir, "mock-assets");
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
