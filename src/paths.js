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

/**
 * req-to-plan 的根目录与入口。
 *
 * 它随 src/** 一起打包，但走 asarUnpack 落在 app.asar.unpacked/ 下——必须 unpack：
 * 工作包的 context.md / skill.md 里写着给 agent 参考的影响面扫描命令，系统 node
 * 读不了 asar。
 *
 * 换算只在这里做一次。从这个真实路径启动后，req-to-plan 内部由 import.meta.url
 * 派生的 packageRoot 自然全程是 unpacked，它不必也不该知道 asar 的存在。
 * 用 path.sep 包起来匹配：app.asar.unpacked 里也含 app.asar 子串，
 * 光用 /\bapp\.asar\b/ 会二次命中，滚成 app.asar.unpacked.unpacked。
 */
export const REQ_TO_PLAN_DIR = path
  .join(SRC_DIR, "req-to-plan")
  .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);

/** req-to-plan 的 CLI 入口 */
export const REQ_BIN = path.join(REQ_TO_PLAN_DIR, "bin", "req");
