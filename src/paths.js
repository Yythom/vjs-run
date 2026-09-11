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
 * 留在 asar 里不 unpack：读它的只有两处——listener 起 req prepare、mcp-server 的
 * req_scan 执行扫描——两处都是拿 Electron 当 node 跑（ELECTRON_RUN_AS_NODE=1），
 * 读得了 asar（实测过）。
 *
 * 曾经 unpack 过，因为那时影响面扫描要 agent 自己用系统 node 跑 context.md 里的命令，
 * 而系统 node 读不了 asar。扫描改走 MCP 之后这个理由没了，连带那段
 * asar → unpacked 的路径换算也删掉——它曾经因为两处各换一次滚成
 * app.asar.unpacked.unpacked，是实打实栽过的坑。
 *
 * 留下的已知代价：打包后工作包里 context.md / skill.md 写的命令路径指向 asar 内部，
 * 复制出来用系统 node 直接跑会 Cannot find module。产 plan 该走 req_scan 工具
 * （plan 档下 claude 根本没有 Bash），要手动排查就在仓库里跑 bin/req。
 */
export const REQ_TO_PLAN_DIR = path.join(SRC_DIR, "req-to-plan");

/** req-to-plan 的 CLI 入口 */
export const REQ_BIN = path.join(REQ_TO_PLAN_DIR, "bin", "req");
