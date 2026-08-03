// node 多版本探测与切换，支持 nvm 管理器。
//
// 关键背景：nvm 的「切换」没法直接被应用复用——
//   nvm 是 shell function 而不是可执行文件，`exec("nvm use 18")` 必然 command not found；
//   即便用 `zsh -lc 'source nvm.sh && nvm use 18'` 绕过去，它也只改那个一次性子 shell 的 PATH。
//
// 所以这里直接找到 nvm 下「某个版本的 bin 目录」，把它前置到子进程 PATH（见 shell-env.js）。
// 布局：$NVM_DIR/versions/node/v20.11.0/bin
// 对外统一用不带 v 的版本号（"20.11.0"），config 里存的也是这个。
//
// 本模块只做文件系统探测，不 import shell-env.js —— 否则会和 buildSpawnEnv 形成循环依赖。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getConfig } from "./config/store.js";
import { normalizeNodeVersion } from "./config/normalize.js";

const VERSION_DIR_RE = /^v?\d+\.\d+\.\d+$/;

export function getNvmDir() {
  return process.env.NVM_DIR || path.join(os.homedir(), ".nvm");
}

function compareVersionsDesc(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pb[i] - pa[i];
  }
  return 0;
}

/**
 * nvm 已安装的可切换 node 版本列表
 */
export function listNodeVersions() {
  const list = [];
  const dir = path.join(getNvmDir(), "versions", "node");
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return list;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !VERSION_DIR_RE.test(entry.name)) continue;
    const binDir = path.join(dir, entry.name, "bin");
    if (!fs.existsSync(path.join(binDir, "node"))) continue;
    const version = normalizeNodeVersion(entry.name);
    if (version) list.push({ version, provider: "nvm", binDir });
  }

  return list.sort((a, b) => compareVersionsDesc(a.version, b.version));
}

export function listNodeProviders() {
  return listNodeVersions().length > 0 ? ["nvm"] : [];
}

export function findNodeVersion(provider, version) {
  const normalized = normalizeNodeVersion(version);
  if (!normalized) return null;
  const list = listNodeVersions().filter((item) => item.version === normalized);
  return list[0] || null;
}

export function getSelectedNodeInfo() {
  const { nodeProvider, nodeVersion } = getConfig();
  let found = findNodeVersion(nodeProvider, nodeVersion);
  if (found) return found;

  // 兜底：如果配置文件中未显式选中版本，读取 nvm 的 default 别名 ($NVM_DIR/alias/default)
  try {
    const aliasDefault = path.join(getNvmDir(), "alias", "default");
    if (fs.existsSync(aliasDefault)) {
      const defaultVer = fs.readFileSync(aliasDefault, "utf8").trim();
      const normalizedDefault = normalizeNodeVersion(defaultVer);
      if (normalizedDefault) {
        found = findNodeVersion("nvm", normalizedDefault);
        if (found) return found;
      }
    }
  } catch (_) {
    // 忽略
  }

  const list = listNodeVersions();
  return list[0] || null;
}

export function getSelectedNodeVersion() {
  return getSelectedNodeInfo()?.version || "";
}

export function detectNodeManager(binPath) {
  const p = String(binPath || "");
  if (!p) return "unknown";
  if (p.includes("/.nvm/versions/node/")) return "nvm";
  if (p.includes("/.volta/")) return "volta";
  if (p.includes("/.fnm/") || p.includes("/fnm_multishells/")) return "fnm";
  if (p.includes("/n/versions/node/") || p.includes("/.n/n/versions/node/")) return "n";
  if (p.includes("/Cellar/") || p.startsWith("/opt/homebrew/")) return "homebrew";
  if (p === "/usr/local/bin/node") return "pkg";
  return "unknown";
}

export const NODE_MANAGER_LABELS = {
  nvm: "nvm",
  n: "n",
  volta: "Volta",
  fnm: "fnm",
  homebrew: "Homebrew",
  pkg: "官方安装包",
  unknown: "未知来源",
};
