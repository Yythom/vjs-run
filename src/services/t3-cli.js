// 调用 T3 Code 的命令行 `t3`：起线程、发消息、查线程。改动测试台靠它把 commit-range-test
// 派给 T3 里的 agent 去跑，vjtools 自己不跑 AI。
//
// 实测过的行为（t3 v0.1.11）：
//   - `thread start/send ... --json` 不带 --wait 时立即返回一行 JSON（threadId / runId）
//   - `thread show --json` 返回 { thread, messages }；失败原因是最后一条 assistant 消息
//   - agent 用提问工具时 pendingRequestCount > 0，`send` 答不了，只能去 T3 界面里回答

import { spawn } from "node:child_process";
import { buildSpawnEnv } from "../shell-env.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export class T3Error extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** 把 t3 的失败归成几类，界面按类给出该怎么办 */
export function classifyT3Failure({ spawnErrorCode, stdout = "", stderr = "" }) {
  if (spawnErrorCode === "ENOENT") {
    return new T3Error(
      "T3_NOT_INSTALLED",
      "找不到 t3 命令：先安装 T3 Code，并确认终端里能直接运行 t3",
    );
  }
  const text = `${stderr}\n${stdout}`.trim();
  if (/MODEL_NOT_IN_PLAN/.test(text)) {
    return new T3Error("MODEL_NOT_IN_PLAN", `模型不在当前套餐里，换一个模型：${firstLine(text)}`);
  }
  if (/ECONNREFUSED|not running|no running|could not connect|failed to connect/i.test(text)) {
    return new T3Error("T3_NOT_RUNNING", `连不上 T3 Code 服务，先打开 T3 Code 桌面端：${firstLine(text)}`);
  }
  return new T3Error("T3_FAILED", text ? firstLine(text, 400) : "t3 命令失败，没有输出");
}

function firstLine(text, max = 200) {
  const line = text.split("\n").find((l) => l.trim()) || "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** t3 --json 的输出里第一行 JSON；--wait 时 JSON 后面还会跟一行说明文字 */
export function parseJsonOutput(stdout) {
  for (const line of String(stdout).split("\n")) {
    const s = line.trim();
    if (s.startsWith("{") || s.startsWith("[")) {
      try {
        return JSON.parse(s);
      } catch {
        // 一行放不下的大 JSON（show 带很多消息时）走下面的整段解析
        break;
      }
    }
  }
  const start = String(stdout).search(/[[{]/);
  if (start < 0) return null;
  try {
    return JSON.parse(String(stdout).slice(start));
  } catch {
    return null;
  }
}

async function runT3(args, { input, cwd, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  // buildSpawnEnv 默认开了 FORCE_COLOR，这里关掉，免得 --json 输出里混进颜色码
  const env = await buildSpawnEnv({ FORCE_COLOR: "0", NO_COLOR: "1" });
  return new Promise((resolve, reject) => {
    const child = spawn("t3", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new T3Error("T3_TIMEOUT", `t3 ${args.slice(0, 2).join(" ")} 超过 ${timeoutMs / 1000} 秒没有返回`)));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) =>
      finish(() => reject(classifyT3Failure({ spawnErrorCode: err.code, stderr: err.message }))),
    );
    child.on("close", (code) =>
      finish(() => {
        if (code !== 0) {
          reject(classifyT3Failure({ stdout, stderr }));
          return;
        }
        const json = parseJsonOutput(stdout);
        if (!json) {
          reject(new T3Error("T3_BAD_OUTPUT", `t3 的输出不是 JSON：${firstLine(stdout || stderr)}`));
          return;
        }
        resolve(json);
      }),
    );
    child.stdin.end(input ?? "");
  });
}

/** 在 projectPath 所在的 T3 项目里起一个线程，首条消息从 stdin 传。返回 { threadId, runId } */
export function startThread({ projectPath, message, title, provider, model }) {
  const args = ["thread", "start", projectPath, "-", "--json"];
  if (title) args.push("--title", title);
  if (provider && model) args.push("--provider", provider, "--model", model);
  return runT3(args, { input: message, cwd: projectPath });
}

/** 给线程发一条消息；线程忙时排成下一轮。返回 { threadId, link, runId, status } */
export function sendMessage({ threadId, message }) {
  return runT3(["thread", "send", threadId, "-", "--json"], { input: message });
}

/** 查线程状态和最近几条消息。返回 { thread, messages } */
export function showThread({ threadId, messages = 2 }) {
  return runT3(["thread", "show", threadId, "--messages", String(messages), "--json"]);
}

/**
 * 把 `thread show` 的结果归成界面用的状态：
 *   failed        失败（原因在最后一条 assistant 消息里）
 *   needs-answer  agent 用了提问工具在等回答，只能去 T3 里答
 *   running       在跑，或消息排着队（status=waiting/queued）
 *   idle          这一轮结束了
 */
export function deriveThreadState(thread) {
  if (!thread) return "unknown";
  if (thread.pendingRequestCount > 0) return "needs-answer";
  if (thread.status === "failed") return "failed";
  if (thread.activeRunId || ["running", "waiting", "queued", "starting"].includes(thread.status)) {
    return "running";
  }
  return "idle";
}

/** 线程摘要：给界面用，只留需要的字段 */
export function summarizeThread(show) {
  const thread = show?.thread;
  if (!thread) return null;
  const lastAssistant = [...(show.messages || [])].reverse().find((m) => m.role === "assistant");
  return {
    threadId: thread.threadId,
    link: thread.link || "",
    status: thread.status,
    state: deriveThreadState(thread),
    provider: thread.providerInstanceId || "",
    model: thread.model || "",
    runCount: thread.runCount || 0,
    updatedAt: thread.updatedAt || "",
    lastMessage: lastAssistant?.text || "",
  };
}
