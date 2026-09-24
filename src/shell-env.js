// 打包后的 Electron 进程拿不到用户 shell 启动文件里导出的变量（PATH/PNPM_HOME/Volta/nvm 等），
// 这里主动从 `zsh -ilc 'command env -0'` 提取一份并缓存，所有子进程共用。
// 零依赖手写实现——曾用 shell-env 包，但它的 strip-ansi→ansi-regex 链在 electron-builder
// 打包 pnpm 项目时收集不全，导致打包后 ERR_MODULE_NOT_FOUND，故回退。

import path from "node:path";
import os from "node:os";
import { execFile, execFileSync } from "node:child_process";

// 缓存的是 Promise 而不是结果：预热和首次启动项目几乎同时发生时共用同一次 zsh 调用
let shellEnvPromise = null;
// 解析完成后的结果，给同步调用方（buildSpawnEnvSync）直接取
let shellEnvResolved = null;

const ZSH_ARGS = ["-ilc", "command env -0"];

function zshEnv() {
  // 抑制 oh-my-zsh 自动更新提示 / tmux 插件自启，避免阻塞这次取值
  return { ...process.env, DISABLE_AUTO_UPDATE: "true", ZSH_TMUX_AUTOSTART: "false" };
}

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

function parseEnvOutput(buffer) {
  const env = {};
  // 注意是 NUL 分隔，不是空格——否则多条 env 会被拼进一个值，触发 Node「值含 \0」校验
  for (const entry of buffer.toString("utf8").split("\0")) {
    if (!entry) continue;
    const eqIndex = entry.indexOf("=");
    if (eqIndex <= 0) continue;
    env[entry.slice(0, eqIndex)] = entry.slice(eqIndex + 1);
  }
  return env;
}

// 异步执行：重 zshrc（nvm/oh-my-zsh/p10k 等）要 1-3 秒，用 execSync 会把整个主进程
// 事件循环卡住，期间渲染层的所有 IPC（拉 config、项目列表）都得排队。
function getHydratedShellEnv() {
  if (shellEnvPromise) return shellEnvPromise;
  shellEnvPromise = new Promise((resolve) => {
    // `command env` 规避用户把 env 设成别名/函数；`-0` 用 NUL 分隔（值里可能含换行/空格）。
    const child = execFile(
      "/bin/zsh",
      ZSH_ARGS,
      { encoding: "buffer", maxBuffer: 1024 * 1024 * 4, env: zshEnv() },
      (err, stdout) => {
        // 读不到 shell env 不致命，退化为空对象继续走 PATH 兜底
        if (!shellEnvResolved) shellEnvResolved = err ? {} : parseEnvOutput(stdout);
        resolve(shellEnvResolved);
      },
    );
    // execFile 的 stdin 默认是 pipe：立即关掉，等同原来的 stdio "ignore"，
    // 防止 zshrc 里有读 stdin 的东西把这次调用挂住
    child.stdin?.end();
  });
  return shellEnvPromise;
}

// 同步版：main 启动时已预热，正常情况下直接命中缓存；预热还没回来时才阻塞跑一次 zsh 兜底。
// 仅给没法改成 async 的调用方用（同步返回进程句柄 / 同步判断），其余一律用 buildSpawnEnv。
function getHydratedShellEnvSync() {
  if (shellEnvResolved) return shellEnvResolved;
  try {
    shellEnvResolved = parseEnvOutput(
      execFileSync("/bin/zsh", ZSH_ARGS, {
        maxBuffer: 1024 * 1024 * 4,
        env: zshEnv(),
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch (_) {
    shellEnvResolved = {};
  }
  return shellEnvResolved;
}

export async function buildSpawnEnv(extra = {}) {
  return composeSpawnEnv(await getHydratedShellEnv(), extra);
}

export function buildSpawnEnvSync(extra = {}) {
  return composeSpawnEnv(getHydratedShellEnvSync(), extra);
}

function composeSpawnEnv(shellEnv, extra) {
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
