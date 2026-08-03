// 打包后的 Electron 进程拿不到用户 shell 启动文件里导出的变量（PATH/PNPM_HOME/Volta/nvm 等），
// 这里主动从 `zsh -ilc 'command env -0'` 提取一份并缓存，所有子进程共用。
// 零依赖手写实现——曾用 shell-env 包，但它的 strip-ansi→ansi-regex 链在 electron-builder
// 打包 pnpm 项目时收集不全，导致打包后 ERR_MODULE_NOT_FOUND，故回退。

import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { getSelectedNodeInfo } from "./node-manager.js";

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

  // 回写 NVM_DIR / N_PREFIX：GUI 启动的 Electron 主进程 process.env 里没有它们，而
  // node-manager.js 为了避免循环依赖只读 process.env。这里补上，自定义安装位置的
  // 用户才能被正确识别。
  if (env.NVM_DIR && !process.env.NVM_DIR) process.env.NVM_DIR = env.NVM_DIR;
  if (env.N_PREFIX && !process.env.N_PREFIX) process.env.N_PREFIX = env.N_PREFIX;

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
  // 体检页选中的 node 版本要压过 shell 启动文件里的默认版本，所以放在最前面
  // （mergePathSegments 去重时保留首次出现，前置即生效）。未选中时为空数组，
  // PATH 与改造前完全一致。
  const selectedNode = getSelectedNodeInfo();
  const selectedNodeBin = selectedNode?.binDir || "";
  const hydratedPath = mergePathSegments(
    selectedNodeBin ? [selectedNodeBin] : [],
    basePath,
    shellPath,
    guessed,
  );
  const env = {
    ...process.env,
    ...shellEnv,
    PATH: hydratedPath,
    FORCE_COLOR: "1",
    TERM: "xterm-256color",
    ...extra,
  };

  // 放在 shellEnv 展开之后，否则会被 shell 启动文件里的旧值盖回去。
  // node-gyp / node-addon-api 靠这两个变量找头文件，漏了会编到别的版本上。
  // 清除 npm_config_prefix 避免 nvm 与自定义 npm 前缀设置冲突
  if (selectedNode?.provider === "nvm") {
    env.NVM_BIN = selectedNodeBin;
    env.NVM_INC = path.join(path.dirname(selectedNodeBin), "include", "node");
    delete env.npm_config_prefix;
    delete env.NPM_CONFIG_PREFIX;
  }

  if (!env.PNPM_HOME) {
    const pnpmHome = env.PATH.split(path.delimiter).find((p) =>
      /(?:^|\/)\.local\/share\/pnpm$/.test(p),
    );
    if (pnpmHome) env.PNPM_HOME = pnpmHome;
  }

  return env;
}
