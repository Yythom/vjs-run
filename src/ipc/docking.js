// 赛博牛马面板 IPC。
//
// 数据流：飞书私聊 →(lark-cli event consume) listener → task-store → 面板勾选
//        → buildPrompt 拼一段 prompt 给我复制走（不自动执行模型）
//        → 需求含糊时 → docking-ask 用 lark-cli 原路回问提出人。
//
// 「发消息」是唯一的外发动作，只在渲染层显式点按钮时触发，主进程不主动发。

import { clipboard } from "electron";
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
  stopAllJobs,
} from "../feishu/runner.js";
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

  // ── 派给模型：只生成 prompt，不执行 ─────────────────────────────────────────
  ipcSafe("docking-build-prompt", (_e, { ids = [], copy = false }) => {
    const tasks = ids.map((id) => getTask(id)).filter(Boolean);
    if (!tasks.length) throw new Error("没有勾选任何任务");
    const prompt = buildPrompt(tasks);
    if (copy) clipboard.writeText(prompt);
    return { prompt, count: tasks.length };
  });

  // ── 交给模型自动处理（调度队列） ──────────────────────────────────────────
  ipcSafe("docking-run-start", (_e, { ids, cwd, mode, engine, createBranch }) =>
    enqueueJob({ ids, cwd, mode, engine, createBranch }),
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
