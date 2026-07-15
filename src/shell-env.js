// 打包后的 Electron 进程拿不到用户 shell 启动文件里导出的变量（PATH/PNPM_HOME/Volta/nvm 等），
// 这里主动从 `zsh -ilc 'command env -0'` 提取一份并缓存，所有子进程共用。
// 零依赖手写实现——曾用 shell-env 包，但它的 strip-ansi→ansi-regex 链在 electron-builder
// 打包 pnpm 项目时收集不全，导致打包后 ERR_MODULE_NOT_FOUND，故回退。

import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

let cachedShellEnv = null;

function mergePathSegments(...segmentsList) {
  const uniq = [];
  for (const segments of segmentsList) {
    for (const seg of segments || []) {
      const v = String(seg || "").trim();
      if (!v) continue;
      if (!uniq.includes(v)) uniq.push(v);
    }
  }
  return uniq.join(path.delimiter);
}

function getHydratedShellEnv() {
  if (cachedShellEnv) return cachedShellEnv;

  const env = {};
  try {
    // `command env` 规避用户把 env 设成别名/函数；`-0` 用 NUL 分隔（值里可能含换行/空格）。
    const shellOut = execSync("/bin/zsh -ilc 'command env -0'", {
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1024 * 1024 * 4,
      // 抑制 oh-my-zsh 自动更新提示 / tmux 插件自启，避免阻塞这次取值
      env: {
        ...process.env,
        DISABLE_AUTO_UPDATE: "true",
        ZSH_TMUX_AUTOSTART: "false",
      },
    });
    // 注意是 NUL 分隔，不是空格——否则多条 env 会被拼进一个值，触发 Node「值含 \0」校验
    for (const entry of shellOut.toString("utf8").split("\0")) {
      if (!entry) continue;
      const eqIndex = entry.indexOf("=");
      if (eqIndex <= 0) continue;
      env[entry.slice(0, eqIndex)] = entry.slice(eqIndex + 1);
    }
  } catch (_) {
    // 读不到 shell env 不致命，退化为空对象继续走 PATH 兜底
  }

  cachedShellEnv = env;
  return cachedShellEnv;
}

export function buildSpawnEnv(extra = {}) {
  const shellEnv = getHydratedShellEnv();
  const basePath = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const shellPath = (shellEnv.PATH || "").split(path.delimiter).filter(Boolean);
  const guessed = [
    process.env.PNPM_HOME,
    shellEnv.PNPM_HOME,
    path.join(os.homedir(), ".local/share/pnpm"),
    path.join(os.homedir(), ".volta/bin"),
    path.join(os.homedir(), ".nvm/versions/node/current/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/opt/homebrew/sbin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].filter(Boolean);
  const hydratedPath = mergePathSegments(basePath, shellPath, guessed);
  const env = {
    ...process.env,
    ...shellEnv,
    PATH: hydratedPath,
    FORCE_COLOR: "1",
    TERM: "xterm-256color",
    ...extra,
  };

  if (!env.PNPM_HOME) {
    const pnpmHome = env.PATH.split(path.delimiter).find((p) =>
      /(?:^|\/)\.local\/share\/pnpm$/.test(p),
    );
    if (pnpmHome) env.PNPM_HOME = pnpmHome;
  }

  return env;
}
