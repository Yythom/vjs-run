// 「app 内置」的 vjtools 命令：不用装 npm 包，用 app 自带的 Electron 以 node 模式
// （ELECTRON_RUN_AS_NODE）运行安装包里的 src/cli/index.js。只装了 app 的用户也能让 AI 用 mock。
//
//   1. writeCliShim：app 每次启动在 <userData>/bin/vjtools 写一个 sh 小脚本，指向当前 app 的位置。
//      不需要任何权限；app 被挪动 / 升级后下次启动自动修正。AI skill 找不到 vjtools 时用这个固定路径兜底。
//   2. installCliLink：用户点「安装到命令行」时，把上面的脚本软链进 PATH 上的目录，终端里就能直接敲 vjtools。
//      只挑登录 shell PATH 里、当前用户可写的几个常规目录；都不行就请管理员权限写 /usr/local/bin
//      （macOS 的 /etc/paths 默认带它）。
//
// 纯 node 模块，路径都由调用方传入（userData、PATH 由 IPC 层从 electron / 登录 shell 取），方便直测。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

export const CLI_NAME = "vjtools";

// 软链候选目录，按优先级。不能随便挑 PATH 上任意可写目录：比如 ~/.nvm/versions/node/vX/bin
// 可写也在 PATH 上，但换 node 版本就没了
const LINK_DIR_CANDIDATES = ["/usr/local/bin", "/opt/homebrew/bin", "~/.local/bin", "~/bin"];
const ADMIN_LINK_DIR = "/usr/local/bin";

export function cliShimPath(userDataDir) {
  return path.join(userDataDir, "bin", CLI_NAME);
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function buildCliShim({ execPath, cliEntry }) {
  return [
    "#!/bin/sh",
    "# 由 vjtools app 自动生成，请勿手改：用 app 自带的 Electron 以 node 模式运行 vjtools 命令行。",
    "# app 被移动 / 删除后会失效，重新打开一次 app 即自动修正。",
    `APP_EXEC=${shQuote(execPath)}`,
    `CLI_ENTRY=${shQuote(cliEntry)}`,
    'if [ ! -x "$APP_EXEC" ]; then',
    '  echo "✗ 找不到 vjtools app：$APP_EXEC（被移动或删除了？重新打开一次 app 会自动修正，或改用 npm i -g vjtools-cli）" >&2',
    "  exit 1",
    "fi",
    'ELECTRON_RUN_AS_NODE=1 exec "$APP_EXEC" "$CLI_ENTRY" "$@"',
    "",
  ].join("\n");
}

/** 内容没变就不写，避免每次启动都改 mtime */
export function writeCliShim({ shimPath, execPath, cliEntry }) {
  const content = buildCliShim({ execPath, cliEntry });
  try {
    if (fs.readFileSync(shimPath, "utf8") === content) return { shimPath, changed: false };
  } catch {
    // 不存在：往下写
  }
  fs.mkdirSync(path.dirname(shimPath), { recursive: true });
  const tmp = `${shimPath}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o755 });
  fs.renameSync(tmp, shimPath);
  return { shimPath, changed: true };
}

// ─── PATH 探测 ───────────────────────────────────────────────────────────────

function pathDirs(pathEnv) {
  return String(pathEnv || "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.resolve(dir));
}

function realpathOrNull(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

/** 按 PATH 顺序找第一个可执行的 vjtools（等价 command -v） */
export function whichCli(pathEnv) {
  for (const dir of pathDirs(pathEnv)) {
    const file = path.join(dir, CLI_NAME);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // 不在这个目录
    }
  }
  return null;
}

function isOurLink(file, shimPath) {
  const real = realpathOrNull(file);
  return Boolean(real) && real === realpathOrNull(shimPath);
}

/**
 * @returns {{ onPath: string|null, source: "app"|"external"|null, shimPath: string, shimReady: boolean }}
 *   source=app：PATH 上的 vjtools 就是本 app 的内置命令；external：别的来源（多半是 npm i -g vjtools-cli）
 */
export function getCliStatus({ shimPath, pathEnv }) {
  const onPath = whichCli(pathEnv);
  return {
    onPath,
    source: onPath ? (isOurLink(onPath, shimPath) ? "app" : "external") : null,
    shimPath,
    shimReady: fs.existsSync(shimPath),
  };
}

export function pickLinkDir(pathEnv, { home = os.homedir(), candidates = LINK_DIR_CANDIDATES } = {}) {
  const onPath = new Set(pathDirs(pathEnv));
  for (const raw of candidates) {
    const dir = raw.startsWith("~/") ? path.join(home, raw.slice(2)) : raw;
    if (!onPath.has(dir)) continue;
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      // 不可写：换下一个
    }
  }
  return null;
}

// ─── 安装软链 ────────────────────────────────────────────────────────────────

function appleScriptString(text) {
  return `"${String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 弹系统授权框执行；用户取消时 resolve false */
function runAsAdmin(command) {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/osascript",
      ["-e", `do shell script ${appleScriptString(command)} with administrator privileges`],
      (err, _stdout, stderr) => {
        if (!err) return resolve(true);
        // -128 = 用户在授权框点了取消
        if (/-128/.test(String(stderr)) || /User canceled/i.test(String(stderr))) return resolve(false);
        reject(new Error(String(stderr || err.message).trim()));
      },
    );
  });
}

/**
 * 把内置命令软链进 PATH。
 * @returns {Promise<{ status: "already"|"external"|"installed"|"canceled", linkPath?: string }>}
 *   external：PATH 上已有别的来源的 vjtools（如 npm 装的），不覆盖，免得两个版本打架
 */
export async function installCliLink({ shimPath, pathEnv, home, candidates, admin = runAsAdmin }) {
  if (!fs.existsSync(shimPath)) {
    throw new Error(`内置命令还没生成：${shimPath}（重新打开一次 app 再试）`);
  }
  const status = getCliStatus({ shimPath, pathEnv });
  if (status.source === "app") return { status: "already", linkPath: status.onPath };
  if (status.source === "external") return { status: "external", linkPath: status.onPath };

  const dir = pickLinkDir(pathEnv, { home, candidates });
  if (dir) {
    const linkPath = path.join(dir, CLI_NAME);
    // whichCli 没找到却存在同名文件：多半是坏掉的软链（指向已删除的东西），只清理软链，不碰真文件
    const stale = fs.lstatSync(linkPath, { throwIfNoEntry: false });
    if (stale && !stale.isSymbolicLink()) throw new Error(`${linkPath} 已存在且不是软链，未覆盖`);
    if (stale) fs.unlinkSync(linkPath);
    fs.symlinkSync(shimPath, linkPath);
    return { status: "installed", linkPath };
  }

  const linkPath = path.join(ADMIN_LINK_DIR, CLI_NAME);
  const link = shQuote(linkPath);
  // 同上：已有的真文件不覆盖，只替换软链
  const ok = await admin(
    `if [ -e ${link} ] && [ ! -L ${link} ]; then echo "${linkPath} 已存在且不是软链，未覆盖" >&2; exit 1; fi; ` +
      `mkdir -p ${shQuote(ADMIN_LINK_DIR)} && ln -sfn ${shQuote(shimPath)} ${link}`,
  );
  if (!ok) return { status: "canceled" };
  // /usr/local/bin 不在登录 shell 的 PATH 上（极少见）时提示用户自己加
  return { status: "installed", linkPath, admin: true, onPath: pathDirs(pathEnv).includes(ADMIN_LINK_DIR) };
}
