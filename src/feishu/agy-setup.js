// Antigravity CLI（agy）的接入配置。
//
// claude 那边 MCP 是 --mcp-config 临时注入的，用完即走。agy 没有这个参数，
// MCP 必须预先注册到全局配置，并且在 settings.json 里显式放行——否则 headless
// 下工具调用会被自动拒绝（它没法弹框问人）。
//
// 这两处都是用户的全局工具配置，所以不在后台偷偷写：面板上点「配置 agy 接入」
// 才会执行，检测结果也如实显示。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import electron from "electron";
const app = electron?.app || (typeof electron === "object" ? electron.default?.app : null);
import { SRC_DIR } from "../paths.js";
import { runCommand } from "./lark-cli.js";

/** MCP server 在 agy 里注册的名字。allow 规则和事件解析都按它匹配 */
export const AGY_SERVER_NAME = "vjtools-docking";

const SETTINGS_PATH = path.join(
  os.homedir(),
  ".gemini",
  "antigravity-cli",
  "settings.json",
);

const ALLOW_RULE = `mcp(${AGY_SERVER_NAME}/*)`;

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    // 文件不存在或损坏：当空配置处理，写回时会重建
    return {};
  }
}

/** agy 是否装了、server 是否注册过、权限是否放行 */
export async function probeAgy() {
  const version = await runCommand("agy", ["--version"], { timeout: 10000 });
  if (version.notFound) {
    return {
      installed: false,
      error: "找不到 agy，请先安装 Antigravity CLI",
      installCmd: "agy",
      desc: "Antigravity CLI，用于在终端运行无头 Agent 与 MCP 扩展",
    };
  }

  const list = await runCommand("agy", ["mcp", "list"], { timeout: 15000 });
  const registered = list.stdout.includes(AGY_SERVER_NAME);

  const allowed = (readSettings().permissions?.allow || []).includes(ALLOW_RULE);

  return {
    installed: true,
    version: (version.stdout || "").trim(),
    registered,
    allowed,
    ready: registered && allowed,
    installCmd: "agy",
  };
}

/**
 * 注册 MCP server 并放行权限。幂等：`agy mcp add` 本身是 add-or-update，
 * allow 规则去重后写回。
 */
export async function setupAgy() {
  const mcpServer = path.join(SRC_DIR, "feishu", "mcp-server.mjs");

  // 用 Electron 自身当 node 跑，打包进 asar 后外部 node 读不到
  const added = await runCommand(
    "agy",
    [
      "mcp",
      "add",
      "-e",
      "ELECTRON_RUN_AS_NODE=1",
      "-e",
      `VJTOOLS_USER_DATA_DIR=${
        typeof app?.getPath === "function"
          ? app.getPath("userData")
          : os.tmpdir()
      }`,
      AGY_SERVER_NAME,
      process.execPath,
      mcpServer,
    ],
    { timeout: 20000 },
  );
  if (!added.ok) {
    throw new Error(added.error || "注册 MCP server 失败");
  }

  const settings = readSettings();
  const allow = new Set(settings.permissions?.allow || []);
  allow.add(ALLOW_RULE);
  settings.permissions = { ...settings.permissions, allow: [...allow] };

  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8");

  return probeAgy();
}

/** 撤销：移除 server 并去掉 allow 规则，把环境还原 */
export async function teardownAgy() {
  await runCommand("agy", ["mcp", "remove", AGY_SERVER_NAME], {
    timeout: 20000,
  });

  const settings = readSettings();
  if (settings.permissions?.allow) {
    const rest = settings.permissions.allow.filter((rule) => rule !== ALLOW_RULE);
    if (rest.length) {
      settings.permissions.allow = rest;
    } else {
      // 规则空了就把字段收干净，别留 {"allow": []} 这种空壳在用户配置里
      delete settings.permissions.allow;
      if (!Object.keys(settings.permissions).length) delete settings.permissions;
    }
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8");
  }

  return probeAgy();
}
