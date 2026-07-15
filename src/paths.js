// ESM 下 __dirname / __filename 没有，集中派生一次给全项目用。
// 顺手暴露内置 mock 资源目录路径，避免多文件各自拼。

import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);

/** src/ 目录本身的绝对路径 */
export const SRC_DIR = path.dirname(__filename);

/** 内置 mock 资源（mock-rules.json / mock-data/）所在目录。
 *  打包后位于 .app 包内只读，仅作为首次启动的种子；
 *  实际可写副本由 ensureUserMockAssets 复制到 userData。 */
export const BUILTIN_MOCK_ASSETS_DIR = path.join(SRC_DIR, "mock", "assets");

/** preload 脚本路径（必须 .cjs，Electron 推荐 preload 用 CJS） */
export const PRELOAD_PATH = path.join(SRC_DIR, "preload.cjs");

/** 应用图标（dev 下设置 dock 图标用；打包后由 electron-builder 直接读 build/icon.icns） */
export const APP_ICON_PATH = path.join(SRC_DIR, "..", "build", "icon.png");

/** renderer 打包产物 index.html */
export const RENDERER_INDEX_HTML = path.join(
  SRC_DIR,
  "..",
  "renderer",
  "dist",
  "index.html",
);
