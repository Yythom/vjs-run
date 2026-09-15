// AI 工单台面板 IPC。
//
// 数据流：飞书私聊 →(lark-cli event consume) listener → task-store → 面板勾选
//        → buildPrompt 拼一段 prompt 给我复制走（不自动执行模型）
//        → 需求含糊时 → docking-ask 用 lark-cli 原路回问提出人。
//
// 「发消息」是唯一的外发动作，只在渲染层显式点按钮时触发，主进程不主动发。

import fs from "node:fs";
import path from "node:path";
import { clipboard, shell } from "electron";
import { ipcSafe } from "./safe.js";
import {
  probeLarkCli,
  probeClaudeCli,
  installCliPackage,
  sendMessage,
} from "../feishu/lark-cli.js";
import {
  getListenerStatus,
  startListener,
  stopListener,
} from "../feishu/listener.js";
import { buildPrompt } from "../feishu/prompt.js";
import { COMMANDS } from "../feishu/commands.js";
import { probeAgy, setupAgy, teardownAgy } from "../feishu/agy-setup.js";
import { probeCodex, setupCodex, teardownCodex } from "../feishu/codex-setup.js";
import {
  buildAskCard,
  buildDoneCard,
  buildIgnoredCard,
  buildSolutionReplyCard,
} from "../feishu/cards.js";
import {
  cancelJob,
  enqueueJob,
  getQueueStatus,
  getRunStatus,
  hasActiveJobForTask,
  stopAllJobs,
} from "../feishu/runner.js";
import { cleanupTaskWorktree, getWorktreeInfo } from "../feishu/worktree.js";
import {
  addTask,
  appendThread,
  deleteTask,
  deleteTasks,
  getSettings,
  getTask,
  listTasks,
  setSettings,
  updateTask,
} from "../feishu/task-store.js";
import {
  listJobRuns,
  getJobRunDetail,
  deleteJobRun,
  clearJobRuns,
} from "../feishu/history-store.js";

export function registerDockingIpc() {
  // ── 监听器 ──────────────────────────────────────────────────────────────────
  ipcSafe("docking-probe", async () => ({ probe: await probeLarkCli() }));
  ipcSafe("docking-get-status", () => ({ status: getListenerStatus() }));
  ipcSafe("docking-start", () => ({ status: startListener() }));
  ipcSafe("docking-stop", () => ({ status: stopListener() }));

  // ── 运行时开关 ──────────────────────────────────────────────────────────────
  ipcSafe("docking-get-settings", () => ({ settings: getSettings() }));
  ipcSafe("docking-set-settings", (_e, { patch }) => ({
    settings: setSettings(patch || {}),
  }));

  // ── 任务列表 ────────────────────────────────────────────────────────────────
  // 面板顶部的指令提示栏用它渲染。指令定义在主进程（listener 才是解析的那一方），
  // 面板只负责展示，这样加指令不会漏改 UI
  ipcSafe("docking-commands", () => ({ commands: COMMANDS }));

  ipcSafe("docking-list-tasks", () => ({ tasks: listTasks() }));

  ipcSafe("docking-add-task", (_e, { title, content, senderName, repoPath, status }) => {
    if (!content && !title) throw new Error("需求内容不能为空");
    const task = addTask({
      title: title || undefined,
      content: content || title,
      senderName: senderName || "手动录入",
      repoPath: repoPath || "",
      status: status || "inbox",
      source: "manual",
    });
    return { task };
  });

  ipcSafe("docking-update-task", async (_e, { id, patch }) => {
    const prev = getTask(id);
    if (!prev) throw new Error("任务不存在");
    const prevStatus = prev.status;
    const task = updateTask(id, patch || {});
    if (!task) throw new Error("任务不存在");

    const nextStatus = patch?.status;
    if (
      (nextStatus === "done" || nextStatus === "ignored") &&
      prevStatus !== nextStatus
    ) {
      const settings = getSettings();
      if (settings.notifyOnComplete ?? true) {
        const cleanNote = String(task.note || patch?.note || "").trim();
        const fallbackMsg =
          nextStatus === "done"
            ? `✅【完成】你提的 #${task.seq}「${task.title}」已处理完成。${
                cleanNote ? `\n\n处理说明：\n${cleanNote}` : ""
              }`
            : `⏸️【忽略】你提的 #${task.seq}「${task.title}」已置为忽略。${
                cleanNote ? `\n\n原因说明：\n${cleanNote}` : ""
              }`;
        const card =
          nextStatus === "done"
            ? buildDoneCard({
                task,
                note: cleanNote,
                modifiedFiles: task.modifiedFiles || [],
                branchName: task.branchName || "",
              })
            : buildIgnoredCard({ task, reason: cleanNote });

        sendMessage({
          chatId: task.chatId,
          openId: task.requester?.id,
          card,
          text: fallbackMsg,
          replyMessageId: task.messageId,
        }).catch((err) => console.error("[docking] 发送完成回执失败", err));
        appendThread(task.id, { role: "me", text: fallbackMsg });
      }
    }

    return { task: getTask(id) || task };
  });

  ipcSafe("docking-delete-task", (_e, { id }) => ({ deleted: deleteTask(id) }));

  ipcSafe("docking-delete-tasks", (_e, { ids = [] }) => ({
    removed: deleteTasks(ids),
  }));

  // ── 需求池工作包的 plan ─────────────────────────────────────────────────────
  // plan.md 写在工作包目录（userData/req-workpacks 下），不进被分析的代码库。
  // 路径只从任务上的 workpackDir 推，不接受渲染层传路径，免得变成任意读文件
  const planFileOf = (id) => {
    const task = getTask(id);
    if (!task) throw new Error("任务不存在");
    if (!task.workpackDir) throw new Error("这条任务没有工作包，也就没有 plan");
    return path.join(task.workpackDir, "plan.md");
  };

  ipcSafe("docking-read-plan", (_e, { id }) => {
    const file = planFileOf(id);
    if (!fs.existsSync(file)) return { exists: false, path: file };
    return {
      exists: true,
      path: file,
      content: fs.readFileSync(file, "utf8"),
      updatedAt: fs.statSync(file).mtimeMs,
    };
  });

  ipcSafe("docking-open-plan", async (_e, { id }) => {
    const file = planFileOf(id);
    if (!fs.existsSync(file)) throw new Error("plan 还没写出来");
    const error = await shell.openPath(file);
    if (error) throw new Error(error);
    return {};
  });

  // ── 隔离 worktree：查看现状、打开目录、清理 ─────────────────────────────────
  // 同一个 worktree / 分支可能挂着好几条任务（批量派发），其中任一条在跑都算忙
  const isWorktreeBusy = (task) =>
    listTasks().some(
      (t) =>
        (t.id === task.id ||
          (t.repoPath === task.repoPath &&
            ((task.worktreePath && t.worktreePath === task.worktreePath) ||
              (task.branchName && t.branchName === task.branchName)))) &&
        hasActiveJobForTask(t.id),
    );

  ipcSafe("docking-worktree-info", (_e, { id }) => {
    const task = getTask(id);
    if (!task) throw new Error("任务不存在");
    const busy = isWorktreeBusy(task);
    return { info: getWorktreeInfo(task), busy };
  });

  ipcSafe("docking-worktree-open", async (_e, { id }) => {
    const info = getWorktreeInfo(getTask(id) || {});
    if (!info.exists) throw new Error("worktree 目录不存在");
    const error = await shell.openPath(info.path);
    if (error) throw new Error(error);
    return {};
  });

  ipcSafe("docking-worktree-cleanup", (_e, { id, deleteBranch = false }) => {
    const task = getTask(id);
    if (!task) throw new Error("任务不存在");
    // AI 还在里面改文件时删目录，等于把它脚下的地抽掉
    const busy = isWorktreeBusy(task);
    if (busy) throw new Error("AI 正在这个 worktree 里处理，先中断或等它跑完");
    return { result: cleanupTaskWorktree(task, { deleteBranch }), task: getTask(id) };
  });

  // ── 派给模型：只生成 prompt，不执行 ─────────────────────────────────────────
  ipcSafe("docking-build-prompt", (_e, { ids = [], copy = false }) => {
    const tasks = ids.map((id) => getTask(id)).filter(Boolean);
    if (!tasks.length) throw new Error("没有勾选任何任务");
    const prompt = buildPrompt(tasks);
    if (copy) clipboard.writeText(prompt);
    return { prompt, count: tasks.length };
  });

  // ── 交给模型自动处理（调度队列） ──────────────────────────────────────────
  ipcSafe("docking-run-start", (_e, { ids, cwd, mode, engine, createBranch, freshSession }) =>
    enqueueJob({ ids, cwd, mode, engine, createBranch, freshSession }),
  );

  ipcSafe("docking-job-cancel", (_e, { jobId }) => ({
    cancelled: cancelJob(jobId),
    queue: getQueueStatus(),
  }));

  ipcSafe("docking-queue-status", () => ({ queue: getQueueStatus() }));

  // 探测各 CLI 状态与一键安装
  ipcSafe("docking-claude-probe", async () => ({ probe: await probeClaudeCli() }));
  ipcSafe("docking-install-cli", async (_e, { name }) => {
    const result = await installCliPackage(name);
    return { result };
  });

  // agy 需要预先注册 MCP + 放行权限，这两处是用户的全局工具配置，
  // 所以只在面板显式点击时才写
  ipcSafe("docking-agy-probe", async () => ({ probe: await probeAgy() }));
  ipcSafe("docking-agy-setup", async () => ({ probe: await setupAgy() }));
  ipcSafe("docking-agy-teardown", async () => ({ probe: await teardownAgy() }));

  // codex 需要预先注册 MCP（写入 ~/.codex/config.toml）
  ipcSafe("docking-codex-probe", async () => ({ probe: await probeCodex() }));
  ipcSafe("docking-codex-setup", async () => ({ probe: await setupCodex() }));
  ipcSafe("docking-codex-teardown", async () => ({ probe: await teardownCodex() }));
  ipcSafe("docking-run-stop", (_e, { jobId } = {}) => ({
    stopped: jobId ? cancelJob(jobId) : stopAllJobs(),
  }));
  ipcSafe("docking-run-status", () => ({ run: getRunStatus() }));

  // ── AI 调用历史记录回看与管理 ───────────────────────────────────────────────
  ipcSafe("docking-history-list", (_e, { taskId, engine, status, limit, offset } = {}) =>
    listJobRuns({ taskId, engine, status, limit, offset }),
  );
  ipcSafe("docking-history-get", (_e, { jobId }) => ({
    record: getJobRunDetail(jobId),
  }));
  ipcSafe("docking-history-delete", (_e, { jobId }) => ({
    success: deleteJobRun(jobId),
  }));
  ipcSafe("docking-history-clear", () => ({
    success: clearJobRuns(),
  }));

  // ── 反问提出人 ──────────────────────────────────────────────────────────────
  ipcSafe("docking-ask", async (_e, { id, question }) => {
    const task = getTask(id);
    if (!task) throw new Error("任务不存在");
    const text = String(question || "").trim();
    if (!text) throw new Error("反问内容不能为空");

    const card = buildAskCard({ task, question: text });
    const fallbackBody = `【确认】关于你提的「${task.title}」：\n${text}`;
    const res = await sendMessage({
      chatId: task.chatId,
      openId: task.requester?.id,
      card,
      text: fallbackBody,
      replyMessageId: task.messageId,
    });
    if (!res.ok) throw new Error(res.error || "飞书发送失败");

    appendThread(id, { role: "me", text });
    const updated = updateTask(id, { status: "awaiting", askedAt: Date.now() });
    return { task: updated };
  });

  // ── 人工一键飞书回复排查解答给提出人 ─────────────────────────────────────────
  ipcSafe("docking-reply-solution", async (_e, { id, text, markDone = false }) => {
    const task = getTask(id);
    if (!task) throw new Error("任务不存在");
    const cleanText = String(text || "").trim();
    if (!cleanText) throw new Error("答复内容不能为空");

    const card = buildSolutionReplyCard({ task, text: cleanText });
    const fallbackText = `【解答】关于你提的「${task.title}」：\n${cleanText}`;

    const res = await sendMessage({
      chatId: task.chatId,
      openId: task.requester?.id,
      card,
      text: fallbackText,
      replyMessageId: task.messageId,
    });
    if (!res.ok) throw new Error(res.error || "飞书发送失败");

    appendThread(id, { role: "me", text: cleanText });
    const patch = { note: cleanText };
    if (markDone) patch.status = "done";
    const updated = updateTask(id, patch);
    return { task: updated || getTask(id) };
  });
}
