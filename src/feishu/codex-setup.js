// OpenAI Codex CLI（codex）的接入配置。
//
// claude 那边 MCP 是 --mcp-config 临时注入的，用完即走。
// codex 的 MCP 服务需要注册到全局配置中（写入 ~/.codex/config.toml）。
// 面板上点「一键配置」即可自动执行 `codex mcp add` 注册 vjtools-docking。

import os from "node:os";
import path from "node:path";
import electron from "electron";
const app = electron?.app || (typeof electron === "object" ? electron.default?.app : null);
import { SRC_DIR } from "../paths.js";
import { runCommand } from "./lark-cli.js";

/** MCP server 在 codex 里注册的名字 */
export const CODEX_SERVER_NAME = "vjtools-docking";

/** codex 是否装了、server 是否注册过 */
export async function probeCodex() {
  const version = await runCommand("codex", ["--version"], { timeout: 10000 });
  if (version.notFound) {
    return {
      installed: false,
      error: "找不到 codex，请先全局安装 @openai/codex",
      installCmd: "npm install -g @openai/codex",
      desc: "Codex CLI，用于在终端运行无头 Agent 与 MCP 扩展",
    };
  }

  const list = await runCommand("codex", ["mcp", "list"], { timeout: 15000 });
  const registered = list.stdout.includes(CODEX_SERVER_NAME);

  return {
    installed: true,
    version: (version.stdout || "").trim(),
    registered,
    ready: registered,
    installCmd: "npm install -g @openai/codex",
  };
}

/**
 * 注册 MCP server。幂等：`codex mcp add` 本身会覆盖已有同名配置。
 */
export async function setupCodex() {
  const mcpServer = path.join(SRC_DIR, "feishu", "mcp-server.mjs");

  // 用 Electron 自身当 node 跑，打包进 asar 后外部 node 读不到
  const added = await runCommand(
    "codex",
    [
      "mcp",
      "add",
      CODEX_SERVER_NAME,
      "--env",
      "ELECTRON_RUN_AS_NODE=1",
      "--env",
      `VJTOOLS_USER_DATA_DIR=${
        typeof app?.getPath === "function"
          ? app.getPath("userData")
          : os.tmpdir()
      }`,
      "--",
      process.execPath,
      mcpServer,
    ],
    { timeout: 20000 },
  );
  if (!added.ok) {
    throw new Error(added.error || "注册 MCP server 失败");
  }

  return probeCodex();
}

/** 撤销：移除 server 配置 */
export async function teardownCodex() {
  await runCommand("codex", ["mcp", "remove", CODEX_SERVER_NAME], {
    timeout: 20000,
  });

  return probeCodex();
}
