// 把勾选的需求交给无头 Agent（Claude Code / Antigravity / Codex）自动处理。
//
// 闭环靠 MCP：Agent 通过 mcp-server.mjs 暴露的工具读任务详情、回写状态、
// 需求含糊时直接飞书反问提出人。所以「标记完成」「自动反问」不是我们写死的
// 后处理，而是它自己在处理过程中该做就做。
//
// 三档执行力度（面板可选，默认最保守的 analyze）：
//   analyze —— 能读代码、能标状态、能反问，但不许改文件、不许跑命令
//   edit    —— 允许改文件，仍不给 Bash
//   full    —— 全放开，无人值守
// 越往下越自动，也越意味着「外部飞书消息能直接驱动本地改动」，慎选。
//
// 支持三个引擎：
//   claude —— MCP 走 --mcp-config 临时注入，用完即走，不落任何配置文件；
//             力度靠 --allowedTools / --disallowedTools 精确控制。
//   agy    —— 没有 --mcp-config，MCP 必须预先注册到全局配置并在 settings.json
//             里放行（面板上的「配置 agy」按钮干这事）；力度只能靠 --mode，
//             analyze 档借力于「headless 无法弹权限确认，写操作会被自动拒绝」。
//   codex  —— OpenAI Codex CLI，MCP 预先注册到全局 ~/.codex/config.toml
//             （面板上的「配置 codex」按钮干这事）；以 exec --json 驱动。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { setupWorktree } from "./worktree.js";
import { killProcessTree } from "../kill-tree.js";
import electron from "electron";
const app = electron?.app || (typeof electron === "object" ? electron.default?.app : null);
import PQueue from "p-queue";
import { SRC_DIR } from "../paths.js";
import { buildSpawnEnvSync } from "../shell-env.js";
import { sendToAllWindows } from "../ui-channel.js";
import { buildPrompt } from "./prompt.js";
import { appendThread, getTask, updateTask } from "./task-store.js";
import { saveJobRun } from "./history-store.js";
import { showDesktopNotification } from "./notify.js";
import { sendMessage } from "./lark-cli.js";

let spawnImpl = spawn;
export function setSpawnImpl(fn) {
  spawnImpl = fn || spawn;
}

// worktree 的建立与清理在 worktree.js；这两个在这里再导出一次，老调用方与测试不用改
export { sanitizeBranchSlug, setupWorktree } from "./worktree.js";

const MCP_SERVER = path.join(SRC_DIR, "feishu", "mcp-server.mjs");

const MCP_TOOLS = [
  "mcp__docking__get_task",
  "mcp__docking__update_task",
  "mcp__docking__ask_requester",
  "mcp__docking__req_scan",
];

// 只读档：显式禁掉所有会动到工作区的工具，MCP 工具照常可用。
// 名单必须写全——漏一个（比如 MultiEdit）只读档就穿了。
// 不用 --permission-mode plan：plan 档会把 MCP 工具一起挡掉，
// update_task / ask_requester 一没了，整个闭环就断了。
const READONLY_DENY = [
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "Bash",
  "BashOutput",
  "KillShell",
  "KillBash",
];

// 可改代码档：只挡命令执行
const EDIT_DENY = ["Bash", "BashOutput", "KillShell", "KillBash"];

// 产 plan 档：只读档 + 一支笔。
//
// 影响面扫描不再靠 agent 自己起 node 子进程，改走 MCP 的 req_scan——参数是结构化的
// （命令枚举 + 关键词 + scope），仓库路径由任务的 repoPath 决定，agent 指定不了。
// 所以这一档可以跟只读档一样整个禁掉 Bash，唯一放开的是 Write（写 plan.md）。
//
// 之前用的是 allowedTools 里的 "Bash(node:*)" 白名单，实测那个在无头 -p 模式下
// 根本不过滤：只放行 Bash(git:*) 时 node 命令照跑，不给白名单也照跑。
// 真正生效的只有 disallowedTools 的工具名黑名单，所以那一档其实是「任意命令都能跑」。
const PLAN_DENY = READONLY_DENY.filter((tool) => tool !== "Write");

const EDIT_TOOLS = new Set([
  "Edit",
  "Write",
  "NotebookEdit",
  "replace_file_content",
  "write_to_file",
]);

function extractFilePath(input, cwd) {
  if (!input || typeof input !== "object") return null;
  const rawPath =
    input.file_path ||
    input.TargetFile ||
    input.path ||
    input.file ||
    input.filePath ||
    input.targetFile;
  if (!rawPath || typeof rawPath !== "string") return null;

  if (cwd && path.isAbsolute(rawPath)) {
    if (rawPath.startsWith(cwd)) {
      return path.relative(cwd, rawPath) || rawPath;
    }
  }
  return rawPath;
}

const MODES = {
  analyze: { permissionMode: "acceptEdits", deny: READONLY_DENY, allow: [] },
  plan: { permissionMode: "acceptEdits", deny: PLAN_DENY, allow: [] },
  edit: { permissionMode: "acceptEdits", deny: EDIT_DENY, allow: [] },
  full: { permissionMode: "bypassPermissions", deny: [], allow: [] },
};


/**
 * agy 的力度映射。无头（-p）模式下无法交互式确认权限，统一使用 --dangerously-skip-permissions，
 * 具体力度通过 buildInstructions 中的 Prompt 指令强约束控制。
 */
const AGY_MODES = {
  analyze: ["--dangerously-skip-permissions"],
  // 产 plan 已固定走 claude（enqueueJob 里强制），这条正常走不到，留着只是别让
  // AGY_MODES[mode] 取出 undefined。真要放开时也别用 agy 自带的 --mode plan：
  // 语义没文档，可能连 plan.md 都写不出来，还可能把 MCP 工具一起挡掉。
  plan: ["--dangerously-skip-permissions"],
  edit: ["--dangerously-skip-permissions"],
  full: ["--dangerously-skip-permissions"],
};

/**
 * codex 的力度映射。无头（exec）模式下统一 bypass approval 并允许跳过 git 仓库检查，
 * 具体力度通过 buildInstructions 中的 Prompt 指令强约束控制。
 */
const CODEX_MODES = {
  analyze: ["--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check"],
  // 同 AGY_MODES.plan：产 plan 固定走 claude，这条走不到。留着的话至少是收紧的
  // （workspace-write 只在 cwd + --add-dir 的工作包内可写），不会把整台机器敞开。
  plan: ["--sandbox", "workspace-write", "--skip-git-repo-check"],
  edit: ["--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check"],
  full: ["--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check"],
};

// ─── 调度队列与任务池 ────────────────────────────────────────────────────────
// 单个 job 的墙钟上限。claude 侧没有 agy 的 --print-timeout 那种参数，
// 卡住的话会一直占着 concurrency 里的一个名额，后面排队的永远轮不上
const JOB_TIMEOUT_MS = 60 * 60 * 1000;
// SIGTERM 之后等这么久还没退，就 SIGKILL
const KILL_GRACE_MS = 10 * 1000;
// 已结束的 job 留多少条在内存里（面板只展示最近 30 条）
const MAX_FINISHED_JOBS = 50;
// 单个 job 最多留多少条日志，防止长跑把内存撑爆
const MAX_JOB_LOGS = 5000;

const queue = new PQueue({ concurrency: 2 });
const jobs = new Map(); // jobId -> Job
const repoLocks = new Map(); // 工作目录 -> Promise chain (写操作互斥锁)
let lastEngine = "claude";

/** 结束的 job 攒太多会一直占着内存（每个还挂着几千条日志），按结束时间淘汰 */
function pruneFinishedJobs() {
  const finished = Array.from(jobs.values())
    .filter((j) => j.status === "done" || j.status === "error" || j.status === "aborted")
    .sort((a, b) => (b.endTime || 0) - (a.endTime || 0));
  for (const job of finished.slice(MAX_FINISHED_JOBS)) {
    jobs.delete(job.id);
  }
}

/** 先礼后兵：SIGTERM 给它收尾的机会，超时不退再 SIGKILL */
function killProc(job) {
  const proc = job.proc;
  if (!proc) return;
  killProcessTree(proc, "SIGTERM");
  const timer = setTimeout(() => {
    if (job.proc === proc) killProcessTree(proc, "SIGKILL");
  }, KILL_GRACE_MS);
  if (typeof timer.unref === "function") timer.unref();
}

/**
 * 某个任务当前是否已经有 job 在排队或运行。
 *
 * 同一个任务同时只允许一个 AI 在跑：一个话题就是一条任务，话题里连发两条指令
 * 不该起两个进程去抢同一份上下文和同一个工作区。跨任务（跨话题）才走并行。
 */
export function hasActiveJobForTask(taskId) {
  if (!taskId) return false;
  for (const job of jobs.values()) {
    if (
      (job.status === "queued" || job.status === "running") &&
      Array.isArray(job.taskIds) &&
      job.taskIds.includes(taskId)
    ) {
      return true;
    }
  }
  return false;
}

// job 收尾回调。listener 用它把本轮运行期间攒下的追问合并成下一轮。
// 做成注册式而不是让 runner 反向 import listener，避免两个模块循环依赖。
let jobSettledHook = null;
export function setJobSettledHook(fn) {
  jobSettledHook = typeof fn === "function" ? fn : null;
}

/** 通知 listener 这个 job 收尾了。调用点都放在 job.status 落定之后 */
function fireJobSettled(job) {
  if (!jobSettledHook) return;
  try {
    jobSettledHook({ jobId: job.id, taskIds: job.taskIds, status: job.status });
  } catch (err) {
    console.error("[runner] job 收尾回调失败:", err);
  }
}

function serializeJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    taskIds: job.taskIds || [],
    cwd: job.cwd || "",
    mode: job.mode || "analyze",
    engine: job.engine || "claude",
    createBranch: Boolean(job.createBranch),
    branchName: job.branchName || "",
    workdir: job.workdir || job.cwd || "",
    status: job.status, // "queued" | "running" | "done" | "error" | "aborted"
    createdAt: job.createdAt || 0,
    startTime: job.startTime || 0,
    endTime: job.endTime || 0,
    exitCode: job.exitCode,
    error: job.error || "",
    modifiedFiles: job.modifiedFiles ? Array.from(job.modifiedFiles) : [],
    // 面板「Agent 进程」列表要用：pid 方便去活动监视器 / kill 核对，
    // lastLogAt 用来判断这个 job 是真在干活还是已经卡住不出声了
    pid: job.proc?.pid || 0,
    lastLogAt: job.logs?.length ? job.logs[job.logs.length - 1].at || 0 : 0,
  };
}

export function getQueueStatus() {
  const all = Array.from(jobs.values()).map(serializeJob);
  const running = all.filter((j) => j.status === "running");
  const queued = all.filter((j) => j.status === "queued");
  const history = all
    .filter((j) => j.status === "done" || j.status === "error" || j.status === "aborted")
    .sort((a, b) => (b.endTime || 0) - (a.endTime || 0))
    .slice(0, 30);
  return {
    running,
    queued,
    history,
    size: queue.size,
    pending: queue.pending,
    jobs: all,
  };
}

export function getRunStatus() {
  const allJobs = Array.from(jobs.values());
  const running = allJobs.find((j) => j.status === "running");
  const queued = allJobs.filter((j) => j.status === "queued");

  return {
    running: Boolean(running),
    jobId: running?.id || null,
    taskIds: running?.taskIds || [],
    cwd: running?.cwd || "",
    engine: running?.engine || lastEngine,
    mode: running?.mode || "analyze",
    createBranch: Boolean(running?.createBranch),
    branchName: running?.branchName || "",
    startTime: running?.startTime || 0,
    modifiedFiles: running?.modifiedFiles ? Array.from(running.modifiedFiles) : [],
    queueLength: queued.length,
  };
}

/**
 * 在 spawn 用的 PATH 里解析 bin 的绝对路径（纯查表，不额外起进程）。
 * 只用于日志诊断，找不到返回空字符串。
 */
function resolveBinPath(bin) {
  try {
    const env = buildSpawnEnvSync();
    for (const dir of String(env.PATH || "").split(path.delimiter)) {
      if (!dir) continue;
      const full = path.join(dir, bin);
      if (fs.existsSync(full)) return full;
    }
  } catch (_) {}
  return "";
}

function emitQueueStatus() {
  sendToAllWindows("docking-queue-status", getQueueStatus());
}

function emitRunStatus() {
  sendToAllWindows("docking-run-status", getRunStatus());
}

function emitJobLog(jobId, kind, text) {
  const job = jobs.get(jobId);
  if (job) {
    if (!job.logs) job.logs = [];
    job.logs.push({ at: Date.now(), kind, text });
    if (job.logs.length > MAX_JOB_LOGS) {
      job.logs.splice(0, job.logs.length - MAX_JOB_LOGS);
    }
  }
  sendToAllWindows("docking-job-log", { jobId, kind, text, at: Date.now() });
}

/**
 * 把一次 job 的完整记录落到 AI 调用历史。
 *
 * finish（子进程跑完/异常退出）和 bail（还没起子进程就失败，比如切分支失败、
 * 启动失败）都必须走这里——否则失败得越早的 job 在历史里越查不到，
 * 而那恰恰是最需要回看日志定位的一类。
 */
function persistJobRun(job, code, modifiedFiles = []) {
  const taskTitles = job.taskIds
    .map((tid) => {
      const t = getTask(tid);
      return t ? `#${t.seq} ${t.title}` : "";
    })
    .filter(Boolean);

  try {
    saveJobRun({
      id: job.id,
      taskIds: job.taskIds,
      taskTitles,
      engine: job.engine,
      mode: job.mode,
      cwd: job.cwd,
      branchName: job.branchName,
      workdir: job.workdir || job.cwd,
      status: job.status,
      exitCode: code,
      error: job.error,
      createdAt: job.createdAt,
      startTime: job.startTime,
      endTime: job.endTime,
      durationMs: (job.endTime || Date.now()) - (job.startTime || Date.now()),
      prompt: job.prompt || "",
      logs: job.logs || [],
      modifiedFiles,
      resultNote: job.resultNote || "",
      sessionId: job.sessionId || "",
      resumedFrom: job.resumedFrom || "",
    });
  } catch (err) {
    console.error("[runner] 持久化历史记录失败:", err);
  }

  sendToAllWindows("docking-history-updated", { jobId: job.id });
}

/**
 * job 没能正常跑完时，把还停在 doing 的任务放回 inbox。
 * 否则任务会永远显示「进行中」——队列里其实什么都没有，面板和飞书两头都看不出异常。
 */
function rollbackDoingTasks(taskIds = [], reason = "") {
  for (const tid of taskIds) {
    const task = getTask(tid);
    if (!task || task.status !== "doing") continue;
    updateTask(tid, { status: "inbox" });
    if (reason) {
      appendThread(tid, { role: "system", text: `本次自动处理未完成：${reason}`, at: Date.now() });
      if (task.messageId || task.chatId || task.requester?.id) {
        sendMessage({
          chatId: task.chatId,
          openId: task.requester?.id,
          replyMessageId: task.messageId,
          text: `❌ #${task.seq}「${task.title}」自动处理未完成：${reason}。\n任务已放回待处理，请在电脑端确认后再试。`,
        }).catch((err) => {
          console.warn("[runner] 飞书未完成通知发送失败:", err?.message || err);
        });
      }
    }
  }
}

/**
 * job 正常退出，但 AI 没用 update_task / ask_requester 回写状态，任务还停在 doing。
 *
 * 退出码 0 只说明 CLI 跑完了，不说明闭环走完了——agy / codex 忘了调 MCP 很常见，
 * claude 偶尔也会把结论只写在最后一段回复里。不处理的话任务永远显示「进行中」，
 * 队列里却早就没有它了。放回 inbox，把 AI 最后说的话留进沟通记录，人来判断。
 *
 * 不发飞书：结论还没人确认过，对提出人说「未完成」或「完成」都可能是错的。
 */
function settleUnreportedTasks(job) {
  const unreported = [];
  for (const tid of job.taskIds) {
    const task = getTask(tid);
    if (!task || task.status !== "doing") continue;
    updateTask(tid, { status: "inbox" });
    const tail = String(job.lastText || "").trim().slice(-1500);
    appendThread(tid, {
      role: "system",
      text: tail
        ? `AI 已结束，但没有回写任务状态，已放回待处理。它最后的输出：\n${tail}`
        : "AI 已结束，但没有回写任务状态，也没有留下结论，已放回待处理。",
      at: Date.now(),
    });
    unreported.push(`#${task.seq} ${task.title}`);
  }
  if (unreported.length) {
    emitJobLog(job.id, "error", `AI 未回写状态，已放回待处理：${unreported.join("、")}`);
    showDesktopNotification({
      title: "【AI 未回写结论】",
      body: `${unreported.join("、")} 已放回待处理，请人工确认`,
    });
  }
  return unreported;
}

// ─── 会话续接（仅 claude） ───────────────────────────────────────────────────
//
// 反问被回复、话题里追加指令、运行期间攒下的 followup，都会对同一任务再派一轮。
// 冷启动的话上一轮读过的代码、推理过程全丢，只能靠 get_task 把 thread 再读一遍。
// claude 的 -p 会话默认落盘，--resume 就能接着聊。
//
// 只对单任务 job 记会话：批量 job 的会话里混着好几条需求，拿去续其中一条会串味。
// agy / codex 暂不支持（codex 走 --ephemeral，agy 没有等价参数）。

/** claude 把会话存在 <config>/projects/<cwd 非字母数字换成 -> 下 */
function claudeSessionExists(sessionId, cwd) {
  if (!sessionId || !cwd) return false;
  const configDir =
    buildSpawnEnvSync().CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const dirs = new Set([cwd]);
  try {
    dirs.add(fs.realpathSync(cwd));
  } catch (_) {}
  for (const dir of dirs) {
    const encoded = dir.replace(/[^a-zA-Z0-9]/g, "-");
    if (fs.existsSync(path.join(configDir, "projects", encoded, `${sessionId}.jsonl`))) {
      return true;
    }
  }
  return false;
}

/**
 * 这一轮能不能续上一轮的会话。任何一条不满足就冷启动——
 * 续错会话（换了仓库、会话文件被清）比冷启动更糟，AI 会基于错的上下文干活。
 */
function pickResumeSession(job, tasks) {
  if (job.freshSession || job.engine !== "claude" || tasks.length !== 1) return null;
  const session = tasks[0].agentSession;
  // claude 按进程 cwd 存会话，所以比的是实际跑的目录（开了隔离就是 worktree）
  if (!session?.id || session.engine !== "claude" || session.cwd !== job.workdir) return null;
  return claudeSessionExists(session.id, job.workdir) ? session : null;
}

/**
 * job 收尾时记下（或作废）任务的会话。
 *   - 正常跑完、拿到了 session_id → 记下，下一轮续它
 *   - 续接轮失败/被中断 → 作废，下一轮冷启动。会话可能停在半截工具调用上，再续大概率还是坏的
 *   - 冷启动轮失败 → 不动（本来就没有可续的）
 */
function recordAgentSession(job) {
  if (job.engine !== "claude" || job.taskIds.length !== 1) return;
  const [tid] = job.taskIds;
  if (job.status === "done" && job.sessionId) {
    updateTask(tid, {
      agentSession: {
        engine: "claude",
        id: job.sessionId,
        cwd: job.workdir || job.cwd,
        endedAt: Date.now(),
      },
    });
  } else if (job.resumedFrom) {
    updateTask(tid, { agentSession: null });
  }
}

/**
 * 在隔离 worktree 里跑时补给 Agent 的说明。
 * node_modules 是软链到主仓库的：装包、删包会直接改到主仓库，必须明说。
 */
function worktreeNotice(job) {
  if (!job.workdir || job.workdir === job.cwd) return [];
  return [
    "",
    "隔离工作区：",
    `- 你在隔离 worktree \`${job.workdir}\`（分支 \`${job.branchName}\`）里工作，主仓库 \`${job.cwd}\` 不要动。`,
    "- 这里的 node_modules 是软链到主仓库的，**不要安装、升级或删除依赖**（pnpm/npm install 之类会直接改到主仓库）；",
    "  确实缺依赖时在 note 里说明，由人来装。",
  ];
}

/** 各档力度的约束与收尾规则 */
function modeGuidelinesFor(mode = "analyze") {
  const modeGuidelines = {
    analyze: [
      "【当前为「只读分析 / 逻辑排查」模式】",
      "- 严禁修改、创建或删除任何代码与文件，严禁执行任何产生变更副作用的命令。",
      "- 专用于代码逻辑排查、业务疑问解答或改动方案可行性分析。",
      "- 分析完成后，必须调用 update_task 把排查解答结论详细写入 note（包含关键文件路径、函数名、流转逻辑与最终结论），并将状态置为 done；如需求或疑问不明用 ask_requester 反问提出人。",
    ],
    plan: [
      "【当前为「产实施 plan」模式】",
      "- 产出是一份 markdown 实施计划，不是代码改动：严禁修改任何业务代码。",
      // 这一档固定走 claude，Bash 是真 deny 掉的，说「没有」不是虚张声势
      "- **没有 Bash，跑不了任何命令**。影响面扫描用 req_scan 工具：",
      "  工作规范里写成 `node .../req scan locate \"文案\" --scope \"目录\"` 的，",
      "  在这里一律改成 req_scan({ seq, command: \"locate\", target: \"文案\", scope: \"目录\" })；",
      "  siblings / mirror / twins 同理。别因为命令跑不通就退回用 Grep 猜。",
      "- 规范里的接口对账命令这一档跑不了，把要对的接口写进待澄清清单。",
      "- 唯一该写的文件是工作包里的 plan.md。",
      "- plan 写完后，必须调用 update_task 在 note 里给出摘要（影响面结论、待澄清项、plan.md 的路径），并将状态置为 done；需求含糊时用 ask_requester 反问提出人。",
    ],
    edit: [
      "【当前为「允许改代码」模式】",
      "- 允许直接修改代码实现需求或修复问题，但不要随意执行外部非必要命令。",
      "- 修改完成后，必须调用 update_task 在 note 中清晰说明改动了哪些文件、做了什么修改，并标记完成状态（done）。",
    ],
    full: [
      "【当前为「全自动」模式】",
      "- 无人值守全自动处理，允许修改代码文件、执行测试及验证命令。",
      "- 处理完成后，必须调用 update_task 在 note 中总结改动内容与测试结果，并标记完成状态（done）。",
    ],
  };

  return modeGuidelines[mode] || modeGuidelines.analyze;
}

/** 首轮和续接轮共用的收尾约定 */
function conventionsFor(tasks) {
  return [
    "处理约定：",
    `- 这些任务的短号分别是：${tasks.map((t) => `#${t.seq}`).join("、")}`,
    "- 需要更完整的上下文（含历次澄清记录）时，用 get_task 按短号取。",
    "- **信息不足或逻辑疑问未明确时不要猜**：用 ask_requester 直接飞书问提出人，问完这条就停在那，等他回复。",
    "- 每条任务处理完，必须用 update_task 回写：做完/答复完毕置 done，做不了置 ignored；",
    "  note 里写清楚逻辑排查解答、或者改了哪些文件做了什么修改、或者为什么做不了。",
  ];
}

/** 给 Agent 的执行指引。需求正文由 buildPrompt 生成，并根据 mode 注入约束与收尾规则 */
function buildInstructions(tasks, mode = "analyze") {
  const guidelines = modeGuidelinesFor(mode);

  // 工作包类任务（req-to-plan 从需求池备的料）：目录已 --add-dir 放行，
  // 里面的 skill.md 也已注入 system prompt，这里只把「哪条任务对应哪个目录」说清楚
  const packs = tasks.filter((t) => t.workpackDir);
  const workpackSection = packs.length
    ? [
        "",
        "工作包（需求池备料，目录已放行）：",
        ...packs.map((t) => `- #${t.seq} → ${t.workpackDir}`),
        "- 入口是各自目录下的 context.md；plan 写到同目录的 plan.md。",
        "- skill.md 的内容已经注入到你的工作规范里，不用再去读一遍。",
      ]
    : [];

  return [
    buildPrompt(tasks),
    "",
    "---",
    "",
    ...guidelines,
    ...workpackSection,
    "",
    ...conventionsFor(tasks),
  ].join("\n");
}

/**
 * 续接轮的 prompt：上一轮的需求正文和推理都在会话里了，只送「之后发生了什么」。
 * 力度可能变了（关键词提权、面板上换档），所以约束整段重发，并明确以本轮为准。
 */
function buildResumeInstructions(task, session, mode = "analyze") {
  const whoOf = (role) =>
    role === "me"
      ? "我追问/说明"
      : role === "assistant"
        ? "AI 回复"
        : role === "system"
          ? "系统记录"
          : `${task.requester?.name || "提出人"}回复/指令`;
  const since = session.endedAt || 0;
  const fresh = (task.thread || []).filter((e) => (e.at || 0) > since);
  const updates = fresh.length
    ? fresh.map((e) => `- **[${whoOf(e.role)}]**：${String(e.text || "").trim()}`)
    : ["- 上一轮结束后没有新消息，是人工重新派的活：请检查上一轮结论是否完整，没做完的接着做。"];

  return [
    `继续处理 #${task.seq}「${task.title}」。你上一轮的上下文仍然有效，下面是之后的新进展：`,
    "",
    ...updates,
    "",
    "---",
    "",
    "本轮力度以下面为准，与上一轮不同时覆盖上一轮的约束：",
    ...modeGuidelinesFor(mode),
    "",
    ...conventionsFor([task]),
  ].join("\n");
}

/**
 * 工作包类任务的两件事：目录放行 + 规范注入。
 *
 * 工作包在被分析仓库之外（.requirements/<record_id>/），不 --add-dir 的话 agent 读不到
 * context.md 也写不出 plan.md。目录里的 skill.md 走 --append-system-prompt 而不是让 agent
 * 「自己去读一个文件」——注入 system prompt 它跳不掉，读文件它可能嫌长就略过了。
 */
function collectWorkpacks(tasks = []) {
  const dirs = [...new Set(tasks.map((t) => t.workpackDir).filter(Boolean))];
  const skills = [];
  for (const dir of dirs) {
    try {
      const text = fs.readFileSync(path.join(dir, "skill.md"), "utf8").trim();
      if (text) skills.push(text);
    } catch (_) {
      // 工作包没带规范就算了，context.md 里也写清楚了该干什么
    }
  }
  return { dirs, systemPrompt: skills.join("\n\n---\n\n") };
}

/** claude：MCP 配置直接拼进命令行，不落文件 */
function claudeArgs(prompt, mode, { addDirs = [], systemPrompt = "", resumeSessionId = "" } = {}) {
  const conf = MODES[mode] || MODES.analyze;
  const mcpConfig = JSON.stringify({
    mcpServers: {
      docking: {
        command: process.execPath,
        args: [MCP_SERVER],
        // Electron 当 node 用，才读得到打包进 asar 的 mcp-server
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          VJTOOLS_USER_DATA_DIR:
            typeof app?.getPath === "function" ? app.getPath("userData") : process.cwd(),
        },
      },
    },
  });

  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--mcp-config",
    mcpConfig,
    "--permission-mode",
    conf.permissionMode,
    "--allowedTools",
    ...MCP_TOOLS,
    ...(conf.allow || []),
  ];
  if (conf.deny.length) args.push("--disallowedTools", ...conf.deny);
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  // 工作包在仓库外，不放行就既读不到 context.md 也写不出 plan.md
  for (const dir of addDirs) args.push("--add-dir", dir);
  if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
  return args;
}

/** agy：MCP 靠预先注册（面板配置过），这里只管力度与超时保护（放宽至 1 小时） */
function agyArgs(prompt, mode, { addDirs = [] } = {}) {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--print-timeout",
    "60m",
    ...(AGY_MODES[mode] || AGY_MODES.analyze),
  ];
  for (const dir of addDirs) args.push("--add-dir", dir);
  return args;
}

/** codex：MCP 靠预先注册在 ~/.codex/config.toml，通过 exec --json 驱动 */
function codexArgs(prompt, mode, { addDirs = [] } = {}) {
  const args = ["exec", "--json", "--ephemeral", ...(CODEX_MODES[mode] || CODEX_MODES.analyze)];
  for (const dir of addDirs) args.push("--add-dir", dir);
  // prompt 是位置参数，必须排在所有选项后面
  args.push(prompt);
  return args;
}

/**
 * 压入调度队列
 */
export function enqueueJob({
  ids = [],
  cwd,
  mode = "analyze",
  engine = "claude",
  createBranch = false,
  // 人在面板上明确要求从头来：不续上一轮会话
  freshSession = false,
}) {
  if (!cwd) throw new Error("必须指定工作目录");
  const tasks = ids.map((id) => getTask(id)).filter(Boolean);
  if (!tasks.length) throw new Error("没有勾选任何任务");

  // 产 plan 固定走 claude：这一档要的是「只读扫影响面 + 写一份 plan.md」，
  // 只有 claude 能按工具名把 Bash 整个禁掉（codex 只能挑沙箱策略，agy 无头下只有全自动批准）。
  // 在这儿兜底，UI、/plan 自动派发、旧的 startRun 入口就都不会再漏。
  if (mode === "plan") engine = "claude";

  lastEngine = engine;
  const jobId = crypto.randomUUID();
  const job = {
    id: jobId,
    taskIds: ids,
    cwd,
    mode,
    engine,
    createBranch: Boolean(createBranch),
    freshSession: Boolean(freshSession),
    branchName: "",
    workdir: cwd,
    status: "queued",
    createdAt: Date.now(),
    startTime: 0,
    endTime: 0,
    exitCode: null,
    error: "",
    modifiedFiles: new Set(),
    proc: null,
  };

  jobs.set(jobId, job);
  emitQueueStatus();
  emitRunStatus();

  // 记录任务运行配置与关联 repoPath，方便后续澄清回复后自动恢复
  for (const t of tasks) {
    updateTask(t.id, {
      lastRunConfig: {
        cwd,
        mode,
        engine,
        createBranch: Boolean(createBranch),
        branchName: t.branchName || "",
      },
      repoPath: cwd,
    });
  }

  // 压入 p-queue 异步执行池
  queue.add(async () => {
    if (job.status === "aborted") return;

    // 写操作互斥锁：会动文件的 job，同一个工作目录必须串行。
    // 开了隔离 worktree 的，每条任务一个独立目录，锁到任务粒度——同一仓库的不同任务可以并行；
    // 同一任务的前后两轮仍然串行（它们落在同一个 worktree 里）
    let releaseLock = () => {};
    if (mode !== "analyze") {
      const lockKey = createBranch
        ? `${cwd}::${tasks.find((t) => t.branchName)?.branchName || tasks[0].id}`
        : cwd;
      const prevLock = repoLocks.get(lockKey) || Promise.resolve();
      let currentRelease;
      const currentLock = new Promise((resolve) => {
        currentRelease = resolve;
      });
      const chain = prevLock.then(() => currentLock);
      repoLocks.set(lockKey, chain);
      releaseLock = () => {
        currentRelease();
        // 我是这把锁上最后一个排队的，就把 key 一起清掉，
        // 否则 promise 链和 Map 只增不减
        if (repoLocks.get(lockKey) === chain) repoLocks.delete(lockKey);
      };
      await prevLock;
    }

    if (job.status === "aborted") {
      releaseLock();
      return;
    }

    try {
      await runJobProcess(job, tasks);
    } finally {
      releaseLock();
    }
  });

  return { jobId, status: job.status, queue: getQueueStatus() };
}

/**
 * 实际运行子进程
 */
function runJobProcess(job, tasks) {
  return new Promise((resolve) => {
    job.status = "running";
    job.startTime = Date.now();
    emitQueueStatus();
    emitRunStatus();

    // 还没起子进程就失败的统一出口：标错、回滚任务状态、通知渲染层
    const bail = (message) => {
      job.status = "error";
      job.error = message;
      job.endTime = Date.now();
      emitJobLog(job.id, "error", message);
      rollbackDoingTasks(job.taskIds, message);
      emitQueueStatus();
      emitRunStatus();
      persistJobRun(job, 1, []);
      const payload = {
        jobId: job.id,
        code: 1,
        taskIds: job.taskIds,
        engine: job.engine,
        modifiedFiles: [],
        error: message,
      };
      sendToAllWindows("docking-job-done", payload);
      sendToAllWindows("docking-run-done", payload);
      pruneFinishedJobs();
      // 放在最后：此时 job.status 已落定，hasActiveJobForTask 不再把它算作占用，
      // 回调里可以直接派下一轮
      fireJobSettled(job);
      resolve();
    };

    // 先建隔离 worktree，再起 Agent。建不出来就别跑——宁可不做，也不能闷头改在主仓库里
    const branch = setupWorktree({
      cwd: job.cwd,
      tasks,
      createBranch: job.createBranch,
      mode: job.mode,
      emitLog: (kind, text) => emitJobLog(job.id, kind, text),
    });
    if (!branch.ok) {
      bail(branch.error || "创建隔离 worktree 失败");
      return;
    }
    job.branchName = branch.branchName;
    // job.cwd 始终是主仓库（锁、lastRunConfig、repoPath 都按它），Agent 实际在 workdir 里跑
    job.workdir = branch.workdir || job.cwd;

    // 读最新的任务快照：enqueue 之后、真正开跑之前，thread 里可能又进了新消息
    const freshTasks = tasks.map((t) => getTask(t.id) || t);
    const resumeSession = pickResumeSession(job, freshTasks);
    job.resumedFrom = resumeSession?.id || "";
    const prompt = [
      resumeSession
        ? buildResumeInstructions(freshTasks[0], resumeSession, job.mode)
        : buildInstructions(freshTasks, job.mode),
      ...worktreeNotice(job),
    ].join("\n");
    job.prompt = prompt;
    const isAgy = job.engine === "agy";
    const isCodex = job.engine === "codex";
    const isClaude = !isAgy && !isCodex;
    const bin = isAgy ? "agy" : isCodex ? "codex" : "claude";
    const workpacks = collectWorkpacks(tasks);
    // 工作包自带的工作规范（skill.md）怎么送进去，三个引擎不一样：
    //   claude —— --append-system-prompt，注进 system prompt，agent 跳不掉
    //   agy / codex —— 没有对应参数（查过 --help），只能拼在 prompt 正文最前面。
    //                  约束力弱一些，但 8800 字的规范摆在那儿总比没有强。
    const inlineSkill = !isClaude && workpacks.systemPrompt;
    const finalPrompt = inlineSkill
      ? `${workpacks.systemPrompt}\n\n---\n\n${prompt}`
      : prompt;

    const args = isAgy
      ? agyArgs(finalPrompt, job.mode, { addDirs: workpacks.dirs })
      : isCodex
        ? codexArgs(finalPrompt, job.mode, { addDirs: workpacks.dirs })
        : claudeArgs(finalPrompt, job.mode, {
            addDirs: workpacks.dirs,
            systemPrompt: workpacks.systemPrompt,
            resumeSessionId: job.resumedFrom,
          });

    let proc;
    try {
      proc = spawnImpl(bin, args, {
        cwd: job.workdir,
        env: buildSpawnEnvSync(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        // claude / codex / agy 都会再拉起自己的一串子进程（CLI 核心、ripgrep、
        // Bash 工具、MCP server…）。自成进程组，killProcessTree 才能整组收掉，
        // 否则那些孙进程会变成孤儿占着 /tmp 里的 socket 和仓库文件锁
        detached: true,
      });
      job.proc = proc;
    } catch (err) {
      bail(`启动失败: ${err.message}`);
      return;
    }

    emitJobLog(
      job.id,
      "meta",
      `${bin} ${isCodex ? "exec" : "-p"}（${job.mode} 模式）· ${job.workdir}${
        job.branchName ? ` · 🌿 ${job.branchName}` : ""
      }`,
    );
    // 异常退出时第一件要排除的事：跑的到底是不是我们以为的那个二进制。
    // 打包后的 Electron PATH 和登录 shell 的 PATH 未必一致，解析结果要能回看。
    emitJobLog(job.id, "meta", `可执行文件: ${resolveBinPath(bin) || "未在 PATH 中找到"}`);
    if (job.resumedFrom) {
      emitJobLog(job.id, "meta", `♻️ 续接上一轮会话: ${job.resumedFrom}`);
    }
    if (workpacks.dirs.length) {
      emitJobLog(
        job.id,
        "meta",
        `📦 工作包已放行: ${workpacks.dirs.join("、")}${
          workpacks.systemPrompt
            ? `（skill.md ${workpacks.systemPrompt.length} 字符，${
                inlineSkill ? "拼进 prompt 正文" : "注入 system prompt"
              }）`
            : "（无 skill.md）"
        }`,
      );
    }

    // 兜底超时。agy 有 --print-timeout，claude 没有，统一在这层管
    const timeoutTimer = setTimeout(() => {
      if (job.status !== "running") return;
      job.status = "aborted";
      job.error = `超过 ${Math.round(JOB_TIMEOUT_MS / 60000)} 分钟未结束，已强制中断`;
      emitJobLog(job.id, "error", job.error);
      killProc(job);
    }, JOB_TIMEOUT_MS);
    if (typeof timeoutTimer.unref === "function") timeoutTimer.unref();

    const textBuffer = new Map();
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed[0] !== "{") return;
      try {
        const evt = JSON.parse(trimmed);
        if (isAgy) renderAgyEvent(evt, job, textBuffer);
        else if (isCodex) renderCodexEvent(evt, job);
        else renderEvent(evt, job);
      } catch {
        // 忽略非 JSON 行
      }
    });

    const stderrTail = [];
    proc.stderr.on("data", (chunk) => {
      const t = chunk.toString().trim();
      if (!t) return;
      emitJobLog(job.id, "error", t);
      stderrTail.push(t);
      if (stderrTail.length > 20) stderrTail.shift();
    });

    let settled = false;
    const finish = (code = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      try {
        rl.close();
      } catch {}
      job.proc = null;
      job.endTime = Date.now();
      job.exitCode = code;

      if (job.status !== "aborted") {
        job.status = code === 0 ? "done" : "error";
      }

      // 历史列表只展示 error 字段，非零退出时它却一直是空的——
      // 把 stderr 尾巴带上，不用点进详情就知道死在哪
      if (code !== 0 && !job.error) {
        const tail = stderrTail.join("\n").slice(-2000);
        job.error = tail ? `异常退出（${code}）：${tail}` : `异常退出（${code}）`;
      }

      emitJobLog(
        job.id,
        code === 0 ? "meta" : "error",
        code === 0 ? "处理结束" : `异常退出（${code}）`,
      );

      // 异常退出或被中断时，AI 多半没来得及用 update_task 回写状态，
      // 任务会一直挂在 doing。放回 inbox，人才看得见它需要重新派
      if (job.status !== "done") {
        rollbackDoingTasks(
          job.taskIds,
          job.status === "aborted" ? "已被手动中断" : job.error || `异常退出（${code}）`,
        );
      } else {
        settleUnreportedTasks(job);
      }

      const modifiedFilesArr = Array.from(job.modifiedFiles);

      // 将改动文件持久化写入关联任务中并同步至会话流
      if (modifiedFilesArr.length > 0) {
        for (const tid of job.taskIds) {
          const existing = getTask(tid);
          if (existing) {
            const merged = Array.from(
              new Set([...(existing.modifiedFiles || []), ...modifiedFilesArr]),
            );
            const latestThread = existing.thread || [];
            const lastEntry = latestThread[latestThread.length - 1];
            if (
              !lastEntry ||
              lastEntry.role !== "assistant" ||
              (lastEntry.at || 0) < job.startTime
            ) {
              const fileListText = modifiedFilesArr
                .map((f) => `- \`${f}\``)
                .join("\n");
              appendThread(tid, {
                role: "assistant",
                text: `已根据指令完成代码修改，共改动 ${modifiedFilesArr.length} 个文件：\n${fileListText}`,
                at: Date.now(),
              });
            }
            updateTask(tid, { modifiedFiles: merged });
          }
        }
      }

      if (code === 0 && job.status === "done") {
        const taskNames = job.taskIds
          .map((tid) => {
            const t = getTask(tid);
            return t ? `#${t.seq} ${t.title}` : "";
          })
          .filter(Boolean)
          .join("、");
        showDesktopNotification({
          title: "【AI 处理完成】",
          body: `${taskNames || "任务处理完成"}${
            modifiedFilesArr.length > 0
              ? ` · 改动了 ${modifiedFilesArr.length} 个文件`
              : ""
          }`,
        });
      }

      // 放在所有回写 thread 的收尾之后：endedAt 是续接轮筛「新进展」的分界线，
      // 我们自己补的系统记录、改动文件清单不该算进下一轮的新消息
      recordAgentSession(job);

      emitQueueStatus();
      emitRunStatus();

      // 持久化保存本次 AI 调用的完整记录（指令、参数、清洗后的日志、改动文件）
      persistJobRun(job, code, modifiedFilesArr);

      const donePayload = {
        jobId: job.id,
        code,
        taskIds: job.taskIds,
        engine: job.engine,
        modifiedFiles: modifiedFilesArr,
      };
      sendToAllWindows("docking-job-done", donePayload);
      sendToAllWindows("docking-run-done", donePayload);

      pruneFinishedJobs();
      // 放在最后：此时 job.status 已落定，hasActiveJobForTask 不再把它算作占用，
      // 回调里可以直接派下一轮
      fireJobSettled(job);
      resolve();
    };

    proc.on("error", (err) => {
      job.error = err.message;
      emitJobLog(job.id, "error", `进程错误: ${err.message}`);
      finish(1);
    });

    proc.on("close", (code) => {
      finish(code ?? 0);
    });
  });
}

export function onQueueIdle() {
  return queue.onIdle();
}

/**
 * 取消指定 Job
 */
export function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return false;

  if (job.status === "queued") {
    job.status = "aborted";
    job.endTime = Date.now();
    emitJobLog(job.id, "meta", "已从排队队列中取消");
    rollbackDoingTasks(job.taskIds, "已从排队队列中取消");
    emitQueueStatus();
    emitRunStatus();
    return true;
  }

  if (job.status === "running" && job.proc) {
    job.status = "aborted";
    job.endTime = Date.now();
    emitJobLog(job.id, "error", "任务被用户手动中断");
    killProc(job);
    emitQueueStatus();
    emitRunStatus();
    return true;
  }

  return false;
}

/**
 * 停止所有正在运行或排队中的任务
 */
export function stopAllJobs() {
  let count = 0;
  for (const job of jobs.values()) {
    if (job.status === "queued" || job.status === "running") {
      cancelJob(job.id);
      count++;
    }
  }
  return count > 0;
}

/**
 * 退出前的同步强杀：直接对所有在跑的进程组下 SIGKILL。
 *
 * stopAllJobs 走的是「SIGTERM + 10s 后补 SIGKILL」，可 app 退出时那个补刀定时器
 * 根本没机会执行——Electron 不等 before-quit 里的异步收尾。于是收不到 / 不理会
 * SIGTERM 的 CLI 就成了孤儿，socket 和文件锁一直留着，下次启动新会话被挡住。
 * 退出这一刻没有「体面收尾」可言，直接整组 SIGKILL。
 */
export function killAllJobsNow() {
  let count = 0;
  for (const job of jobs.values()) {
    if (job.proc) {
      killProcessTree(job.proc, "SIGKILL");
      count++;
    }
  }
  return count;
}

/**
 * 向下兼容的 startRun / stopRun 接口
 */
export function startRun({
  ids = [],
  cwd,
  mode = "analyze",
  engine = "claude",
  createBranch = false,
}) {
  enqueueJob({ ids, cwd, mode, engine, createBranch });
  return getRunStatus();
}

export function stopRun() {
  return stopAllJobs();
}

/** 把 stream-json 事件翻译成人能看的一行 */
function renderEvent(evt, job) {
  // init / assistant / result 事件都带 session_id，取第一次出现的
  if (evt.session_id && !job.sessionId) job.sessionId = evt.session_id;
  if (evt.type === "assistant") {
    for (const block of evt.message?.content || []) {
      if (block.type === "text" && block.text.trim()) {
        job.lastText = block.text.trim();
        emitJobLog(job.id, "text", block.text.trim());
      } else if (block.type === "tool_use") {
        const name = String(block.name || "").replace(/^mcp__docking__/, "");
        if (EDIT_TOOLS.has(name) || EDIT_TOOLS.has(block.name)) {
          const fp = extractFilePath(block.input, job.workdir);
          if (fp) job.modifiedFiles.add(fp);
        }
        emitJobLog(job.id, "tool", `${name} ${summarizeInput(block.input)}`.trim());
      }
    }
  } else if (evt.type === "result") {
    if (!evt.is_error && typeof evt.result === "string" && evt.result.trim()) {
      job.lastText = evt.result.trim();
    }
    if (evt.is_error) emitJobLog(job.id, "error", evt.result || "执行出错");
  }
}

function renderAgyEvent(evt, job, textBuffer) {
  if (evt.event === "step_update") {
    const su = evt.step_update || {};

    if (su.step_type === "tool" && su.state === "ACTIVE") {
      const params = su.tool_info?.parameters || {};
      const name = su.tool_name === "call_mcp_tool" ? params.ToolName : su.tool_name;
      const input = su.tool_name === "call_mcp_tool" ? params.Arguments : params;
      if (EDIT_TOOLS.has(name) || EDIT_TOOLS.has(su.tool_name)) {
        const fp = extractFilePath(input, job.workdir);
        if (fp) job.modifiedFiles.add(fp);
      }
      emitJobLog(job.id, "tool", `${name || "tool"} ${summarizeInput(input)}`.trim());
      return;
    }

    if (su.step_type === "agent_response") {
      const key = su.step_index;
      if (su.text_delta) {
        textBuffer.set(key, (textBuffer.get(key) || "") + su.text_delta);
      }
      if (su.state === "DONE") {
        const text = (textBuffer.get(key) || "").trim();
        textBuffer.delete(key);
        if (text) {
          job.lastText = text;
          emitJobLog(job.id, "text", text);
        }
      }
    }
    return;
  }

  if (evt.event === "result") {
    textBuffer.clear();
    const r = evt.result || {};
    if (r.status === "SUCCESS" && typeof r.response === "string" && r.response.trim()) {
      job.lastText = r.response.trim();
    }
    if (r.status && r.status !== "SUCCESS") {
      emitJobLog(job.id, "error", r.response || `执行结束：${r.status}`);
    }
  }
}

function renderCodexEvent(evt, job) {
  if (evt.type === "item.completed") {
    const item = evt.item || {};
    if (item.type === "agent_message" && item.text) {
      const text = item.text.trim();
      if (text) {
        job.lastText = text;
        emitJobLog(job.id, "text", text);
      }
    } else if (item.type === "mcp_tool_call") {
      const name = String(item.tool || item.name || "").replace(/^mcp__docking__/, "");
      const input = item.arguments || item.input || {};
      if (EDIT_TOOLS.has(name) || EDIT_TOOLS.has(item.tool || item.name)) {
        const fp = extractFilePath(input, job.workdir);
        if (fp) job.modifiedFiles.add(fp);
      }
      emitJobLog(job.id, "tool", `${name || "mcp"} ${summarizeInput(input)}`.trim());
    } else if (item.type === "apply_patch" || item.type === "file_change" || item.type === "patch") {
      const fp = extractFilePath(item, job.workdir);
      if (fp) job.modifiedFiles.add(fp);
      emitJobLog(job.id, "tool", `apply_patch ${fp || summarizeInput(item)}`.trim());
    } else if (item.type === "command_execution") {
      if (item.exit_code !== null && item.exit_code !== 0) {
        emitJobLog(
          job.id,
          "error",
          `命令执行失败 (${item.exit_code}): ${item.command || ""}`.trim(),
        );
      }
    }
    return;
  }

  if (evt.type === "item.started") {
    const item = evt.item || {};
    if (item.type === "command_execution" && item.command) {
      emitJobLog(job.id, "tool", `bash: ${item.command}`.trim());
    } else if (item.type === "mcp_tool_call") {
      const name = String(item.tool || item.name || "").replace(/^mcp__docking__/, "");
      const input = item.arguments || item.input || {};
      emitJobLog(job.id, "tool", `${name || "mcp"} ${summarizeInput(input)}`.trim());
    }
    return;
  }

  if (evt.type === "error" || evt.type === "turn.failed") {
    const msg = evt.message || evt.error?.message || "执行出错";
    job.error = msg;
    emitJobLog(job.id, "error", msg);
  }
}

function summarizeInput(input) {
  if (!input || typeof input !== "object") return "";
  const parts = [];
  if (input.seq) parts.push(`#${input.seq}`);
  if (input.status) parts.push(input.status);
  if (input.question) parts.push(`「${String(input.question).slice(0, 40)}」`);
  if (input.file_path) parts.push(path.basename(String(input.file_path)));
  return parts.join(" ");
}
