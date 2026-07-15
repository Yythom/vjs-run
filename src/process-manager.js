// 前端项目子进程的启动/停止 + 通用流式命令工具。
// 对 UI 的依赖通过 ui-channel 推送，对 PATH 等环境的依赖通过 shell-env 注入，
// 业务配置（如项目 repo 路径）由调用方在调用时传入，避免反向依赖 main.js。

import { spawn } from "node:child_process";
import { sendLog, sendStatus } from "./ui-channel.js";
import { buildSpawnEnv } from "./shell-env.js";
import { notifyProcessCrash } from "./services/notify.js";

const runningProcesses = new Map();

// SIGTERM 后留给进程的体面退出时间，超时对进程组补 SIGKILL
const FORCE_KILL_DELAY_MS = 3000;

export function getRunningIds() {
  return Array.from(runningProcesses.keys());
}

/**
 * 优先通过进程组发信号（确保子进程树一并退出），失败时兜底 kill 进程本身。
 */
function killProcessTree(proc, signal) {
  try {
    process.kill(-proc.pid, signal);
  } catch (_) {
    try {
      proc.kill(signal);
    } catch (__) {}
  }
}

function hasExited(proc) {
  return proc.exitCode !== null || proc.signalCode !== null;
}

/** 等待进程退出；超时或已退出则直接 resolve，绝不 reject。 */
function waitForExit(proc, timeoutMs) {
  if (hasExited(proc)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export function stopProcess(projectId) {
  const proc = runningProcesses.get(projectId);
  if (!proc) return;
  killProcessTree(proc, "SIGTERM");
  // 有些 dev server 会忽略 SIGTERM（或已经卡死）：限时不退就对进程组补 SIGKILL，
  // 避免留下占着端口的孤儿进程。
  if (!hasExited(proc)) {
    const forceKill = setTimeout(
      () => killProcessTree(proc, "SIGKILL"),
      FORCE_KILL_DELAY_MS,
    );
    forceKill.unref?.();
    proc.once("exit", () => clearTimeout(forceKill));
  }
  runningProcesses.delete(projectId);
  sendStatus(projectId, "stopped");
}

export function stopAllProcesses() {
  for (const id of getRunningIds()) stopProcess(id);
}

/**
 * @param {{id:string,name:string,command:string}} project
 * @param {{label:string,path:string}} repo
 */
export async function startProject(project, repo) {
  const { id, command } = project;

  const existing = runningProcesses.get(id);
  if (existing) {
    stopProcess(id);
    // 等旧进程真正退出再 spawn，避免快速重启时端口还没释放。
    // 超时略长于 SIGKILL 兜底延迟，保证强杀有机会先生效。
    await waitForExit(existing, FORCE_KILL_DELAY_MS + 500);
  }

  sendLog(
    id,
    `\x1b[36m▶ Starting ${project.name} in ${repo.label}...\x1b[0m\n`,
  );
  sendLog(id, `\x1b[2m$ ${command}\x1b[0m\n`);



  const proc = spawn(command, [], {
    cwd: repo.path,
    env: buildSpawnEnv(),
    shell: "/bin/zsh",
    detached: true,
  });

  runningProcesses.set(id, proc);
  // spawn 同步返回 ChildProcess，直接标 running；命令找不到等错误会在下一个 tick
  // 通过 proc.on('error') 改成 error，无须再靠 stdout 关键词或 setTimeout 兜底。
  sendStatus(id, "running");

  proc.stdout.on("data", (chunk) => sendLog(id, chunk.toString()));

  // stderr 默认裹一层暗红色，下游工具自带 ANSI 颜色的话会就地覆盖
  proc.stderr.on("data", (chunk) =>
    sendLog(id, `\x1b[31m${chunk.toString()}\x1b[0m`),
  );

  proc.on("error", (err) => {
    if (err && err.code === "ENOENT") {
      sendLog(
        id,
        `\x1b[31m✗ Error: ${err.message}\x1b[0m\n` +
          `\x1b[33m⚠ 未找到命令。请确认依赖工具已安装，或在应用启动环境中补充 PATH / PNPM_HOME。\x1b[0m\n`,
      );
    } else {
      sendLog(id, `\x1b[31m✗ Error: ${err.message}\x1b[0m\n`);
    }
    sendStatus(id, "error");
    if (runningProcesses.get(id) === proc) runningProcesses.delete(id);
    notifyProcessCrash(
      project.name,
      err?.code === "ENOENT" ? "未找到命令，请检查依赖/PATH" : err.message,
    );
  });

  proc.on("close", (code) => {
    // 必须比对身份而非只查 key：重启场景下同一 id 可能已换成新进程，
    // 旧进程迟到的 close 不应误删新进程的记录 / 误报状态
    if (runningProcesses.get(id) === proc) {
      runningProcesses.delete(id);
      if (code === 0 || code === null) {
        sendLog(id, `\x1b[33m■ Process exited (code ${code})\x1b[0m\n`);
        sendStatus(id, "stopped");
      } else {
        sendLog(id, `\x1b[31m✗ Process exited with code ${code}\x1b[0m\n`);
        sendStatus(id, "error");
        // 仍在 runningProcesses 里时退出 = 非用户主动停止（手动停止会先 delete）→ 视为崩溃
        notifyProcessCrash(project.name, `进程异常退出 (code ${code})`);
      }
    }
  });
}

/**
 * 在给定 cwd 下执行命令，stdout/stderr 实时流到指定日志面板。
 */
export function runStreaming(projectId, cmd, { cwd, onChild } = {}) {
  return new Promise((resolve, reject) => {
    sendLog(projectId, `\x1b[2m$ ${cmd}\x1b[0m\n`);
    const proc = spawn(cmd, [], {
      cwd,
      env: buildSpawnEnv(),
      shell: "/bin/zsh",
      detached: false,
    });
    // 把子进程交给调用方，便于在清理序列中途终止
    if (onChild) onChild(proc);
    proc.stdout.on("data", (chunk) => sendLog(projectId, chunk.toString()));
    proc.stderr.on("data", (chunk) =>
      sendLog(projectId, `\x1b[31m${chunk.toString()}\x1b[0m`),
    );
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => resolve({ code }));
  });
}

