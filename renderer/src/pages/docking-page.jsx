import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "../utils/clsx";
import PageShell from "../components/page-shell";
import Modal from "../components/modal";
import useConfirm from "../hooks/use-confirm";
import { useAppConfig } from "../stores/app-config-store";
import { showToast } from "../utils/toast";
import { generateDockingReport } from "../utils/docking-report";
import {
  askRequester,
  replySolution,
  cancelDockingJob,
  clearRunLog,
  clearSelected,
  createTask,
  installDockingCli,
  loadRunStatus,
  loadSettings,
  loadStatus,
  loadTasks,
  patchTask,
  probeClaude,
  probeCodex,
  probeLark,
  removeTask,
  removeTasks,
  saveSettings,
  setActiveJobId,
  setRunModalOpen,
  setRunTargets,
  setSelectedIds,
  startListening,
  startRun,
  stopListening,
  toggleSelected,
  useDockingActiveJobId,
  useDockingJobLogs,
  useDockingQueue,
  useDockingRunLog,
  useDockingRunModalOpen,
  useDockingRunTargets,
  useDockingSelectedIds,
  useDockingSettings,
  useDockingStatus,
  useDockingTasks,
} from "../stores/docking-store";

/** CLI 缺失提示与一键安装卡片组件 */
function CliInstallCard({
  title,
  desc,
  installCmd,
  onInstall,
  installing,
  btnText = "一键安装",
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!installCmd) return;
    try {
      await navigator.clipboard.writeText(installCmd);
      setCopied(true);
      showToast(`已复制命令: ${installCmd}`, "success");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast("复制失败", "error");
    }
  };

  return (
    <div className="border border-amber-200 bg-amber-50/90 text-amber-900 rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-medium text-xs text-amber-900">
          <span>⚠️</span>
          <span>{title}</span>
        </div>
        {onInstall && (
          <button
            type="button"
            disabled={installing}
            onClick={onInstall}
            className="text-[11px] px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-700 text-white font-medium cursor-pointer disabled:opacity-50 transition shadow-2xs flex items-center gap-1 shrink-0"
          >
            {installing ? (
              <>
                <span className="w-2.5 h-2.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                <span>正在安装…</span>
              </>
            ) : (
              <>
                <span>⚡</span>
                <span>{btnText}</span>
              </>
            )}
          </button>
        )}
      </div>

      {desc && (
        <p className="text-[11px] text-amber-700 leading-relaxed">{desc}</p>
      )}

      {installCmd && (
        <div className="flex items-center justify-between gap-2 bg-white/90 border border-amber-200 rounded px-2.5 py-1.5 font-mono text-[11px]">
          <code className="text-amber-900 truncate select-all">
            {installCmd}
          </code>
          <button
            type="button"
            onClick={handleCopy}
            className="shrink-0 text-[10px] px-2 py-0.5 rounded bg-amber-100 hover:bg-amber-200 text-amber-900 font-sans font-medium transition cursor-pointer"
          >
            {copied ? "✓ 已复制" : "📋 复制命令"}
          </button>
        </div>
      )}
    </div>
  );
}

function pickSmartRepo(tasksToRun, repos, lastCwd) {
  if (!repos || !repos.length) return "";
  // 1. 如果单条任务记录了关联 repoPath
  if (tasksToRun.length === 1 && tasksToRun[0]?.repoPath) {
    const matched = repos.find((r) => r.path === tasksToRun[0].repoPath);
    if (matched) return matched.path;
  }
  // 2. 根据任务标题与内容匹配 repo label 或目录名
  const combined = tasksToRun
    .map((t) => `${t.title || ""} ${t.content || ""}`)
    .join(" ")
    .toLowerCase();
  for (const r of repos) {
    const label = (r.label || "").toLowerCase();
    const basename = (r.path || "").split(/[\\/]/).pop().toLowerCase();
    if (label && combined.includes(label)) return r.path;
    if (basename && basename.length > 2 && combined.includes(basename))
      return r.path;
  }
  // 3. 上次使用的目录
  if (lastCwd && repos.some((r) => r.path === lastCwd)) {
    return lastCwd;
  }
  // 4. 默认第一个
  return repos[0]?.path || "";
}

// 状态筛选页签。inbox 是默认视图——新需求进来待处理的都在这
const FILTERS = [
  { key: "inbox", label: "待处理" },
  { key: "unfiled", label: "未识别" },
  { key: "awaiting", label: "已反问" },
  { key: "doing", label: "进行中" },
  { key: "done", label: "已完成" },
  { key: "ignored", label: "已忽略" },
  { key: "all", label: "全部" },
];

const STATUS_BADGE = {
  inbox: {
    text: "待处理",
    cls: "bg-sky-50 text-sky-700 border-sky-300 font-medium",
  },
  unfiled: {
    text: "未识别",
    cls: "bg-slate-100 text-slate-700 border-slate-300 font-medium",
  },
  awaiting: {
    text: "等回复",
    cls: "bg-amber-50 text-amber-800 border-amber-300 font-medium",
  },
  doing: {
    text: "进行中",
    cls: "bg-violet-50 text-violet-700 border-violet-300 font-medium",
  },
  done: {
    text: "已完成",
    cls: "bg-emerald-50 text-emerald-700 border-emerald-300 font-medium",
  },
  ignored: {
    text: "已忽略",
    cls: "bg-slate-100 text-slate-600 border-slate-300 font-medium",
  },
};

function formatTime(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

// 可用的无头引擎
const ENGINES = [
  { key: "claude", label: "Claude Code", desc: "临时注入 MCP，用完即走" },
  { key: "agy", label: "Antigravity", desc: "需预先配置 MCP 权限" },
  { key: "codex", label: "Codex", desc: "OpenAI 官方 CLI，需注册 MCP" },
];

// 执行力度。越往下越自动，也越意味着外部飞书消息能直接驱动本地改动
const RUN_MODES = [
  {
    key: "analyze",
    label: "只读分析 / 逻辑排查",
    desc: "只读检索代码、梳理逻辑链路并给出结论，不修改任何文件（逻辑排查与咨询首选）",
  },
  {
    key: "edit",
    label: "允许改代码",
    desc: "自动修改代码实现需求或修复问题，并在结论中附带修改说明与受影响文件",
  },
  {
    key: "full",
    label: "全自动执行",
    desc: "无人值守全自动处理，包含代码修改与命令验证。建议先确认 git 工作区干净",
  },
];

// ─── 处理过程日志 ────────────────────────────────────────────────────────────
function RunLog({ entries, running }) {
  const endRef = useRef(null);

  // 新日志进来自动滚到底
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [entries.length]);

  return (
    <div className="h-[420px] overflow-y-auto rounded bg-slate-50 border border-border p-3 space-y-1.5 font-mono">
      {entries.map((entry, i) => (
        <div
          key={i}
          className={clsx(
            "text-[12px] whitespace-pre-wrap break-words",
            entry.kind === "tool" && "text-sky-700 font-semibold",
            entry.kind === "error" && "text-rose-700 font-semibold",
            entry.kind === "meta" && "text-slate-600 font-mono",
            entry.kind === "text" && "text-slate-800 font-sans",
          )}
        >
          {entry.kind === "tool" ? `▸ ${entry.text}` : entry.text}
        </div>
      ))}
      {running && <div className="text-[12px] text-slate-600 font-bold">…</div>}
      <div ref={endRef} />
    </div>
  );
}

// ─── 话题详情弹窗 ────────────────────────────────────────────────────────────
/**
 * 一条需求的完整来往：附件、多轮对话流、改动文件、动作栏。
 *
 * 原来是在卡片里内联展开的，一条聊了十几轮的任务能把列表撑到看不到别的，
 * 想比对两条需求还得先把上一条收起来。改成近全屏弹窗后长对话自己滚，
 * 列表始终保持一屏能扫完的密度。
 */
function TaskThreadModal({
  task,
  open,
  onClose,
  runningJob,
  onAsk,
  onReplySolution,
  onRun,
  onDelete,
  onOpenJob,
}) {
  if (!task) return null;

  const threadItems = task.thread || [];
  const initialContent = task.content || threadItems[0]?.text || "";
  const followupItems = threadItems.slice(1);

  // 兼容历史老数据中尚未写入 thread 的 task.note
  const hasNoteInThread = followupItems.some(
    (it) => it.role === "assistant" && it.text === task.note,
  );
  const displayFollowups = [...followupItems];
  if (task.note && !hasNoteInThread) {
    displayFollowups.splice(0, 0, {
      role: "assistant",
      text: task.note,
      at: task.updatedAt || task.createdAt,
      modifiedFiles: task.modifiedFiles,
    });
  }

  const badge = STATUS_BADGE[task.status] || STATUS_BADGE.inbox;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`#${task.seq} ${task.title}`}
      srOnly={false}
      className="w-[1080px] max-w-[95vw] h-[88vh] p-0"
      headerAction={
        <span
          className={clsx(
            "text-[10px] px-1.5 py-0.5 rounded border mr-1",
            badge.cls,
          )}
        >
          {badge.text}
        </span>
      }
    >
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3.5 space-y-3">
        {/* 提出人 / 时间 / 项目 / 分支 等元信息，弹窗里看不到卡片了得补一行 */}
        <div className="flex items-center gap-2 flex-wrap text-[11px] text-slate-600">
          <span className="text-slate-800 font-medium">
            {task.requester?.name || task.requester?.id || "未知发起人"}
          </span>
          <span className="text-slate-300">·</span>
          <span className="text-slate-500">{formatTime(task.createdAt)}</span>
          {task.repoPath && (
            <span
              className="text-[10px] text-slate-700 bg-slate-100 border border-slate-300 px-1.5 py-0.5 rounded font-medium"
              title={task.repoPath}
            >
              📁 {task.repoPath.split(/[\\/]/).pop()}
            </span>
          )}
          {task.branchName && (
            <span
              className="text-[10px] text-emerald-900 bg-emerald-50 border border-emerald-300 px-1.5 py-0.5 rounded font-mono font-medium cursor-pointer"
              title={`隔离分支: ${task.branchName} (点击复制)`}
              onClick={() => {
                navigator.clipboard.writeText(task.branchName);
                showToast(`已复制分支: ${task.branchName}`, "success");
              }}
            >
              🌿 {task.branchName}
            </span>
          )}
        </div>

      {/* 附件与截图列表 */}
      {task.attachments && task.attachments.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap p-2 rounded bg-sky-50/70 border border-sky-200/80">
          <span className="text-[11px] text-sky-800 font-medium shrink-0 flex items-center gap-1">
            <span>📎</span>
            <span>需求附件与截图 ({task.attachments.length})：</span>
          </span>
          {task.attachments.map((att, i) => (
            <button
              key={i}
              type="button"
              className="text-[11px] px-2 py-0.8 rounded bg-white hover:bg-sky-100 text-slate-700 hover:text-sky-800 border border-sky-200 font-mono transition flex items-center gap-1 cursor-pointer"
              title={`点击复制本地文件路径:\n${att.path || att.name}`}
              onClick={() => {
                if (att.path) {
                  navigator.clipboard.writeText(att.path);
                  showToast(`已复制附件路径: ${att.name}`, "success");
                }
              }}
            >
              <span>{att.type === "image" ? "🖼️" : "📄"}</span>
              <span className="max-w-[160px] truncate">{att.name}</span>
              {att.size ? (
                <span className="text-[10px] text-slate-400">
                  ({(att.size / 1024).toFixed(0)}KB)
                </span>
              ) : null}
            </button>
          ))}
        </div>
      )}

      {/* 你来我往的飞书话题多轮对话流 (Timeline) */}
      <div className="space-y-2.5">
        {/* 第 1 轮：需求发起 */}
        <div className="rounded-lg bg-sky-50/50 border border-sky-200/80 p-3 space-y-1.5">
          <div className="flex items-center justify-between text-[11px]">
            <div className="flex items-center gap-1.5 font-bold text-sky-900">
              <span>👤</span>
              <span>
                {task.requester?.name || task.requester?.id || "提出人"}{" "}
                · 需求发起
              </span>
            </div>
            <span className="text-[10px] text-slate-500 font-sans">
              {formatTime(task.createdAt)}
            </span>
          </div>
          <pre className="text-[12px] text-slate-900 whitespace-pre-wrap break-words font-sans leading-relaxed">
            {initialContent}
          </pre>
        </div>

        {/* 后续轮次：AI 分析答复、对方追问、我方回复 */}
        {displayFollowups.map((entry, idx) => {
          if (entry.role === "assistant") {
            return (
              <div
                key={idx}
                className="group rounded-lg bg-amber-50/60 border border-amber-200/80 p-3 space-y-2 transition"
              >
                <div className="flex items-center justify-between text-[11px]">
                  <div className="flex items-center gap-1.5 font-bold text-amber-900">
                    <span>🤖</span>
                    <span>AI 分析排查 / 处理答复</span>
                    {entry.at && (
                      <span className="text-[10px] text-slate-500 font-normal ml-1">
                        ({formatTime(entry.at)})
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      className="text-[10px] px-2 py-0.5 rounded bg-amber-600 hover:bg-amber-700 text-white font-medium transition cursor-pointer shadow-2xs flex items-center gap-1"
                      onClick={() =>
                        onReplySolution({ ...task, note: entry.text })
                      }
                    >
                      <span>💬</span>
                      <span>飞书回送</span>
                    </button>
                    <button
                      type="button"
                      className="text-[10px] px-2 py-0.5 rounded bg-white hover:bg-amber-100 text-amber-900 border border-amber-300 font-medium transition cursor-pointer shadow-2xs"
                      onClick={() => {
                        navigator.clipboard.writeText(entry.text);
                        showToast("已复制该轮答复内容", "success");
                      }}
                    >
                      复制
                    </button>
                    <button
                      type="button"
                      className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-rose-600 text-xs shrink-0 cursor-pointer p-0.5 transition ml-1"
                      title="删除该条记录"
                      onClick={() => {
                        const newThread = [...(task.thread || [])];
                        const realIdx = task.thread.findIndex(
                          (t) =>
                            t.at === entry.at && t.text === entry.text,
                        );
                        if (realIdx >= 0) newThread.splice(realIdx, 1);
                        patchTask(task.id, { thread: newThread });
                        showToast("已删除该条回复", "success");
                      }}
                    >
                      ✕
                    </button>
                  </div>
                </div>
                <div className="text-[12px] text-slate-900 whitespace-pre-wrap break-words font-sans bg-white/95 rounded p-2.5 border border-amber-100/80 leading-relaxed select-text">
                  {entry.text}
                </div>
              </div>
            );
          }

          if (entry.role === "them") {
            return (
              <div
                key={idx}
                className="group rounded-lg bg-white border border-slate-200 p-2.5 space-y-1 hover:border-slate-300 transition"
              >
                <div className="flex items-center justify-between text-[11px]">
                  <div className="flex items-center gap-1.5 font-bold text-slate-800">
                    <span>👤</span>
                    <span>
                      {task.requester?.name || "对方"} · 追问 / 指令
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-slate-400 font-sans">
                      {formatTime(entry.at)}
                    </span>
                    <button
                      type="button"
                      className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-rose-600 text-xs shrink-0 cursor-pointer p-0.5 transition"
                      title="删除该条记录"
                      onClick={() => {
                        const newThread = [...(task.thread || [])];
                        const realIdx = task.thread.findIndex(
                          (t) =>
                            t.at === entry.at && t.text === entry.text,
                        );
                        if (realIdx >= 0) newThread.splice(realIdx, 1);
                        patchTask(task.id, { thread: newThread });
                        showToast("已删除该条记录", "success");
                      }}
                    >
                      ✕
                    </button>
                  </div>
                </div>
                <div className="text-[12px] text-slate-900 whitespace-pre-wrap break-words leading-relaxed pl-5 font-sans">
                  {entry.text}
                </div>
              </div>
            );
          }

          // entry.role === "me"
          return (
            <div
              key={idx}
              className="group rounded-lg bg-sky-50/40 border border-sky-200/70 p-2.5 space-y-1"
            >
              <div className="flex items-center justify-between text-[11px]">
                <div className="flex items-center gap-1.5 font-bold text-sky-800">
                  <span>💬</span>
                  <span>我回复提出人</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-slate-400 font-sans">
                    {formatTime(entry.at)}
                  </span>
                  <button
                    type="button"
                    className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-rose-600 text-xs shrink-0 cursor-pointer p-0.5 transition"
                    title="删除该条记录"
                    onClick={() => {
                      const newThread = [...(task.thread || [])];
                      const realIdx = task.thread.findIndex(
                        (t) =>
                          t.at === entry.at && t.text === entry.text,
                      );
                      if (realIdx >= 0) newThread.splice(realIdx, 1);
                      patchTask(task.id, { thread: newThread });
                      showToast("已删除该条记录", "success");
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>
              <div className="text-[12px] text-slate-900 whitespace-pre-wrap break-words leading-relaxed pl-5 font-sans">
                {entry.text}
              </div>
            </div>
          );
        })}

        {/* 正在执行状态气泡 */}
        {runningJob && (
          <div className="rounded-lg bg-emerald-50/70 border border-emerald-300 p-2.5 flex items-center justify-between text-emerald-900">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-600 animate-pulse" />
              <span className="text-xs font-bold">
                ⚡ AI 正在根据最新对话流处理中…
              </span>
            </div>
            <button
              type="button"
              className="text-xs px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-semibold cursor-pointer shadow-xs"
              onClick={() => onOpenJob(runningJob)}
            >
              查看实时进度
            </button>
          </div>
        )}
      </div>

      {/* 累计改动文件列表 */}
      {task.modifiedFiles && task.modifiedFiles.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap p-2 rounded bg-emerald-50/60 border border-emerald-200">
          <span className="text-[11px] text-emerald-900 font-bold shrink-0 flex items-center gap-1">
            <span>🛠️</span>
            <span>累计改动文件 ({task.modifiedFiles.length})：</span>
          </span>
          {task.modifiedFiles.map((f, i) => (
            <button
              key={i}
              type="button"
              className="text-[11px] px-1.5 py-0.5 rounded bg-white hover:bg-emerald-100 text-emerald-900 border border-emerald-200 hover:border-emerald-300 font-mono transition flex items-center gap-1 cursor-pointer"
              title="点击复制文件相对路径"
              onClick={() => {
                navigator.clipboard.writeText(f);
                showToast(`已复制: ${f}`, "success");
              }}
            >
              <span>📄</span>
              <span>{f}</span>
            </button>
          ))}
        </div>
      )}
      </div>

      {/* 底部功能动作栏：钉在下面，长对话滚动时不跟着走 */}
      <div className="shrink-0 flex flex-wrap gap-2 px-4 py-3 border-t border-border bg-slate-50/50">
      {task.status === "unfiled" && (
        <button
          type="button"
          className="text-[11px] px-2 py-1 rounded border border-sky-300 bg-sky-50 text-sky-600 hover:bg-sky-100 cursor-pointer font-medium"
          onClick={() => patchTask(task.id, { status: "inbox" })}
        >
          转为需求
        </button>
      )}
      <button
        type="button"
        className="text-[11px] px-2.5 py-1 rounded border border-sky-200 text-sky-700 hover:bg-sky-50 font-medium flex items-center gap-1 cursor-pointer"
        onClick={() => onAsk(task)}
      >
        <span>💬</span>
        <span>话题回复 / 反问</span>
      </button>
      <button
        type="button"
        className="text-[11px] px-2.5 py-1 rounded bg-sky-600 text-white hover:bg-sky-700 font-medium flex items-center gap-1 cursor-pointer shadow-2xs"
        onClick={() => onRun(task)}
      >
        <span>⚡</span>
        <span>交给 AI 处理</span>
      </button>
      <button
        type="button"
        className="text-[11px] px-2 py-1 rounded border border-border text-slate-700 hover:bg-slate-50 cursor-pointer font-medium"
        onClick={() => patchTask(task.id, { status: "doing" })}
      >
        标为进行中
      </button>
      <button
        type="button"
        className="text-[11px] px-2 py-1 rounded border border-border text-slate-700 hover:bg-slate-50 cursor-pointer font-medium"
        onClick={() => patchTask(task.id, { status: "done" })}
      >
        标为完成
      </button>
      <button
        type="button"
        className="text-[11px] px-2 py-1 rounded border border-border text-slate-700 hover:bg-slate-50 cursor-pointer font-medium"
        onClick={() => patchTask(task.id, { status: "ignored" })}
      >
        忽略
      </button>
      <button
        type="button"
        className="text-[11px] px-2.5 py-1 rounded border border-rose-300 text-rose-600 hover:text-rose-700 hover:bg-rose-50 font-medium transition cursor-pointer ml-auto flex items-center gap-1 shadow-2xs"
        onClick={() => onDelete(task)}
        title="删除该聊天话题与需求"
      >
        <span>🗑️</span>
        <span>删除话题</span>
      </button>
      </div>
    </Modal>
  );
}

// ─── 单条任务卡片 ────────────────────────────────────────────────────────────
function TaskCard({
  task,
  checked,
  onToggle,
  onAsk,
  onReplySolution,
  onRun,
  onDelete,
  onViewHistory,
  runningJob,
  queuedJob,
  onCancelJob,
  onOpenJob,
}) {
  const [expanded, setExpanded] = useState(false);
  const badge = STATUS_BADGE[task.status] || STATUS_BADGE.inbox;
  const clarifications = (task.thread || []).slice(1);

  return (
    <div className="border border-border rounded-lg bg-white overflow-hidden shadow-2xs">
      <div className="flex items-start gap-3 p-3">
        <input
          type="checkbox"
          className="mt-1 shrink-0 accent-sky-600 cursor-pointer"
          checked={checked}
          onChange={() => onToggle(task.id)}
        />
        <button
          type="button"
          className="min-w-0 flex-1 text-left cursor-pointer"
          title="点击查看完整话题往来"
          onClick={() => setExpanded(true)}
        >
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-slate-900 truncate">
              {task.title}
            </span>
            <span
              className={clsx(
                "shrink-0 text-[10px] px-1.5 py-0.5 rounded border",
                badge.cls,
              )}
            >
              {badge.text}
            </span>
            {task.autoDispatched && (
              <span
                className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-indigo-300 bg-indigo-50 text-indigo-800 font-medium"
                title="收到需求后根据预设规则自动派发 AI"
              >
                🤖 自动派发
              </span>
            )}
            {runningJob && (
              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-emerald-300 bg-emerald-50 text-emerald-800 font-medium flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 animate-pulse" />
                <span>⚡ AI处理中</span>
              </span>
            )}
            {queuedJob && (
              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-amber-300 bg-amber-50 text-amber-800 font-medium flex items-center gap-1">
                <span>⏳</span>
                <span>排队中</span>
              </span>
            )}
            {clarifications.length > 0 && (
              <span className="shrink-0 text-[10px] text-slate-700 font-medium bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200">
                {clarifications.length} 条追问回复
              </span>
            )}
          </div>
          <div className="mt-1.5 flex items-center gap-2 text-[11px] text-slate-600 truncate">
            <span className="font-mono font-semibold text-slate-800">
              #{task.seq}
            </span>
            <span className="text-slate-300">·</span>
            <span className="text-slate-800 font-medium">
              {task.requester?.name || task.requester?.id || "未知发起人"}
            </span>
            <span className="text-slate-300">·</span>
            <span className="text-slate-500">{formatTime(task.createdAt)}</span>
            {task.repoPath && (
              <span
                className="shrink-0 text-[10px] text-slate-700 bg-slate-100 border border-slate-300 px-1.5 py-0.5 rounded font-medium"
                title={task.repoPath}
              >
                📁 {task.repoPath.split(/[\\/]/).pop()}
              </span>
            )}
            {task.branchName && (
              <span
                className="shrink-0 text-[10px] text-emerald-900 bg-emerald-50 border border-emerald-300 px-1.5 py-0.5 rounded font-mono font-medium flex items-center gap-0.5"
                title={`隔离分支: ${task.branchName} (点击复制)`}
                onClick={(e) => {
                  e.stopPropagation();
                  navigator.clipboard.writeText(task.branchName);
                  showToast(`已复制分支: ${task.branchName}`, "success");
                }}
              >
                <span>🌿</span>
                <span>{task.branchName}</span>
              </span>
            )}
            {task.attachments && task.attachments.length > 0 && (
              <span className="shrink-0 text-[10px] text-sky-800 bg-sky-50 border border-sky-300 px-1.5 py-0.5 rounded font-medium">
                📎 {task.attachments.length} 附件
              </span>
            )}
            {task.note && (
              <span className="shrink-0 text-[10px] text-amber-900 bg-amber-50 border border-amber-300 px-1.5 py-0.5 rounded font-medium">
                💡 有结论/解答
              </span>
            )}
            <button
              type="button"
              className="shrink-0 text-[10px] text-slate-700 hover:text-sky-800 bg-slate-100 hover:bg-sky-50 border border-slate-300 hover:border-sky-300 px-1.5 py-0.5 rounded font-medium transition cursor-pointer flex items-center gap-0.5"
              title="查看该需求的历次 AI 调用历史记录（指令与结果）"
              onClick={(e) => {
                e.stopPropagation();
                onViewHistory?.(task.id);
              }}
            >
              <span>📜</span>
              <span>调用历史</span>
            </button>
          </div>
        </button>

        {/* 主操作放在收起态就能点到的位置，不用先展开 */}
        {runningJob ? (
          <button
            type="button"
            className="shrink-0 text-[11px] px-2.5 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer font-medium shadow-xs"
            onClick={() => onOpenJob(runningJob)}
          >
            查看进度
          </button>
        ) : queuedJob ? (
          <button
            type="button"
            className="shrink-0 text-[11px] px-2.5 py-1.5 rounded border border-amber-300 hover:bg-amber-50 text-amber-700 cursor-pointer font-medium"
            onClick={() => onCancelJob(queuedJob.id)}
          >
            取消排队
          </button>
        ) : (
          <button
            type="button"
            className="shrink-0 text-[11px] px-2.5 py-1.5 rounded bg-sky-600 text-white hover:bg-sky-700 cursor-pointer font-medium"
            onClick={() => onRun(task)}
          >
            交给 AI
          </button>
        )}
      </div>

      <TaskThreadModal
        task={task}
        open={expanded}
        onClose={() => setExpanded(false)}
        runningJob={runningJob}
        onAsk={onAsk}
        onReplySolution={onReplySolution}
        onRun={onRun}
        onDelete={onDelete}
        onOpenJob={onOpenJob}
      />
    </div>
  );
}

// ─── AI 调用历史回看弹窗 ──────────────────────────────────────────────────
function JobHistoryModal({
  open,
  onClose,
  historyList,
  total,
  selectedJobId,
  selectedJobDetail,
  onSelectJob,
  onDeleteJob,
  onClearHistory,
  filterTaskId,
  onFilterTaskChange,
  filterEngine,
  onFilterEngineChange,
  filterStatus,
  onFilterStatusChange,
}) {
  const [activeTab, setActiveTab] = useState("prompt"); // "prompt" | "logs" | "result"
  const [searchFilter, setSearchFilter] = useState("");

  const filteredList = useMemo(() => {
    if (!searchFilter.trim()) return historyList;
    const q = searchFilter.trim().toLowerCase();
    return historyList.filter(
      (it) =>
        it.id.toLowerCase().includes(q) ||
        (it.taskTitles || []).some((t) => t.toLowerCase().includes(q)) ||
        (it.promptPreview || "").toLowerCase().includes(q) ||
        (it.cwd || "").toLowerCase().includes(q),
    );
  }, [historyList, searchFilter]);

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`📜 AI 调用历史回看 (${total})`}
      srOnly={false}
      className="w-[980px] max-w-[95vw] h-[82vh] p-4 flex flex-col"
    >
      <div className="flex-1 min-h-0 flex gap-4 pt-1">
        {/* 左侧：调用历史列表与过滤 */}
        <div className="w-[320px] shrink-0 flex flex-col border-r border-slate-200 pr-3 min-h-0">
          {/* 过滤筛选栏 */}
          <div className="space-y-2 pb-2 border-b border-slate-200 shrink-0">
            <div className="relative">
              <input
                type="text"
                placeholder="搜索历史记录/任务短号/Prompt..."
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                className="w-full text-xs pl-7 pr-2 py-1.5 border border-slate-300 rounded bg-white text-slate-800 placeholder:text-slate-500 font-medium focus:outline-none focus:ring-1 focus:ring-sky-400"
              />
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500 text-xs">
                🔍
              </span>
            </div>

            <div className="flex items-center gap-1.5 text-xs">
              <select
                value={filterEngine}
                onChange={(e) => onFilterEngineChange(e.target.value)}
                className="flex-1 text-[11px] border border-slate-300 rounded px-1.5 py-1 bg-white text-slate-800 font-medium"
              >
                <option value="">全部引擎</option>
                <option value="claude">Claude Code</option>
                <option value="agy">Antigravity</option>
                <option value="codex">Codex</option>
              </select>
              <select
                value={filterStatus}
                onChange={(e) => onFilterStatusChange(e.target.value)}
                className="flex-1 text-[11px] border border-slate-300 rounded px-1.5 py-1 bg-white text-slate-800 font-medium"
              >
                <option value="">全部状态</option>
                <option value="done">✓ 成功</option>
                <option value="error">✕ 错误</option>
                <option value="aborted">⏹️ 中断</option>
              </select>
            </div>

            {filterTaskId && (
              <div className="flex items-center justify-between text-[11px] px-2 py-1 bg-sky-50 text-sky-800 border border-sky-200 rounded font-medium">
                <span>仅显示当前需求历史</span>
                <button
                  type="button"
                  className="text-sky-600 hover:text-sky-950 cursor-pointer font-bold ml-1"
                  onClick={() => onFilterTaskChange("")}
                >
                  ✕ 全部
                </button>
              </div>
            )}
          </div>

          {/* 列表条目 */}
          <div className="flex-1 min-h-0 overflow-y-auto space-y-1.5 pt-2">
            {filteredList.length === 0 ? (
              <div className="text-center text-xs text-slate-400 py-12">
                暂无历史记录
              </div>
            ) : (
              filteredList.map((item) => {
                const isSelected = item.id === selectedJobId;
                const isSuccess = item.status === "done" && item.exitCode === 0;
                const durationSec = ((item.durationMs || 0) / 1000).toFixed(1);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onSelectJob(item.id)}
                    className={clsx(
                      "w-full text-left p-2 rounded-lg border transition cursor-pointer flex flex-col gap-1",
                      isSelected
                        ? "border-sky-500 bg-sky-50/80 ring-1 ring-sky-400"
                        : "border-slate-200 hover:border-slate-300 hover:bg-slate-50 bg-white",
                    )}
                  >
                    <div className="flex items-center justify-between text-[11px]">
                      <div className="flex items-center gap-1 font-bold">
                        <span
                          className={clsx(
                            "w-1.5 h-1.5 rounded-full shrink-0",
                            isSuccess
                              ? "bg-emerald-500"
                              : item.status === "aborted"
                                ? "bg-amber-500"
                                : "bg-rose-500",
                          )}
                        />
                        <span
                          className={
                            isSelected ? "text-sky-900" : "text-slate-800"
                          }
                        >
                          {item.engine === "agy"
                            ? "Antigravity"
                            : item.engine === "codex"
                              ? "Codex"
                              : "Claude Code"}
                        </span>
                        <span className="text-[10px] px-1 rounded bg-slate-100 text-slate-700 border border-slate-200 font-normal">
                          {item.mode === "analyze"
                            ? "只读分析"
                            : item.mode === "edit"
                              ? "改代码"
                              : "全自动"}
                        </span>
                      </div>
                      <span className="text-[10px] text-slate-400 font-mono">
                        {durationSec}s
                      </span>
                    </div>

                    <div className="text-xs text-slate-900 font-semibold truncate">
                      {(item.taskTitles || []).join("、") || "任务处理"}
                    </div>

                    <div className="flex items-center justify-between text-[10px] text-slate-500 pt-0.5">
                      <span>
                        {formatTime(item.createdAt || item.startTime)}
                      </span>
                      {item.modifiedFilesCount > 0 && (
                        <span className="text-emerald-700 font-medium">
                          🛠️ {item.modifiedFilesCount} 改动
                        </span>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>

          {/* 底部清空全部历史按钮 */}
          {historyList.length > 0 && (
            <div className="pt-2 border-t border-slate-200 shrink-0">
              <button
                type="button"
                className="w-full text-center text-[11px] py-1 text-slate-500 hover:text-rose-600 hover:bg-rose-50 rounded transition font-medium cursor-pointer"
                onClick={onClearHistory}
              >
                🗑️ 清空所有历史记录
              </button>
            </div>
          )}
        </div>

        {/* 右侧：选中记录的完整详情 */}
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          {selectedJobDetail ? (
            <div className="flex-1 min-h-0 flex flex-col space-y-3">
              {/* 顶部元信息卡片 */}
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg shrink-0 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span
                      className={clsx(
                        "text-xs px-2 py-0.5 rounded font-bold border",
                        selectedJobDetail.status === "done" &&
                          selectedJobDetail.exitCode === 0
                          ? "bg-emerald-100 text-emerald-800 border-emerald-300"
                          : selectedJobDetail.status === "aborted"
                            ? "bg-amber-100 text-amber-800 border-amber-300"
                            : "bg-rose-100 text-rose-800 border-rose-300",
                      )}
                    >
                      {selectedJobDetail.status === "done" &&
                      selectedJobDetail.exitCode === 0
                        ? "✓ 执行成功"
                        : selectedJobDetail.status === "aborted"
                          ? "⏹️ 用户中断"
                          : `✕ 异常退出 (${selectedJobDetail.exitCode})`}
                    </span>
                    <span className="text-sm font-bold text-slate-900">
                      {selectedJobDetail.engine === "agy"
                        ? "Antigravity CLI"
                        : selectedJobDetail.engine === "codex"
                          ? "Codex CLI"
                          : "Claude Code CLI"}
                    </span>
                    <span className="text-xs text-slate-500">
                      · 耗时:{" "}
                      {((selectedJobDetail.durationMs || 0) / 1000).toFixed(1)}s
                    </span>
                  </div>

                  <button
                    type="button"
                    className="text-xs px-2.5 py-1 text-rose-600 hover:bg-rose-50 border border-rose-200 rounded font-medium cursor-pointer transition flex items-center gap-1"
                    onClick={() => onDeleteJob(selectedJobDetail.id)}
                  >
                    <span>🗑️</span>
                    <span>删除该条记录</span>
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-700 pt-1">
                  <div>
                    <span className="text-slate-400">执行模式：</span>
                    <span className="font-semibold text-slate-800">
                      {selectedJobDetail.mode === "analyze"
                        ? "只读分析 / 逻辑排查"
                        : selectedJobDetail.mode === "edit"
                          ? "允许改代码"
                          : "全自动"}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400">开始时间：</span>
                    <span className="font-mono text-slate-800">
                      {formatTime(selectedJobDetail.startTime)}
                    </span>
                  </div>
                  {selectedJobDetail.cwd && (
                    <div className="col-span-2 truncate">
                      <span className="text-slate-400">工作目录：</span>
                      <span
                        className="font-mono text-slate-800"
                        title={selectedJobDetail.cwd}
                      >
                        {selectedJobDetail.cwd}
                      </span>
                    </div>
                  )}
                  {selectedJobDetail.branchName && (
                    <div>
                      <span className="text-slate-400">隔离分支：</span>
                      <span className="font-mono text-emerald-800 font-bold">
                        🌿 {selectedJobDetail.branchName}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* 标签切换页签 */}
              <div className="flex items-center gap-2 border-b border-slate-200 shrink-0">
                <button
                  type="button"
                  className={clsx(
                    "px-3 py-1.5 text-xs font-bold border-b-2 cursor-pointer transition flex items-center gap-1",
                    activeTab === "prompt"
                      ? "border-sky-600 text-sky-700"
                      : "border-transparent text-slate-600 hover:text-slate-900",
                  )}
                  onClick={() => setActiveTab("prompt")}
                >
                  <span>⚡</span>
                  <span>输入指令与 Prompt</span>
                </button>
                <button
                  type="button"
                  className={clsx(
                    "px-3 py-1.5 text-xs font-bold border-b-2 cursor-pointer transition flex items-center gap-1",
                    activeTab === "logs"
                      ? "border-sky-600 text-sky-700"
                      : "border-transparent text-slate-600 hover:text-slate-900",
                  )}
                  onClick={() => setActiveTab("logs")}
                >
                  <span>📜</span>
                  <span>
                    执行日志与终端输出 ({selectedJobDetail.logs?.length || 0})
                  </span>
                </button>
                <button
                  type="button"
                  className={clsx(
                    "px-3 py-1.5 text-xs font-bold border-b-2 cursor-pointer transition flex items-center gap-1",
                    activeTab === "result"
                      ? "border-sky-600 text-sky-700"
                      : "border-transparent text-slate-600 hover:text-slate-900",
                  )}
                  onClick={() => setActiveTab("result")}
                >
                  <span>🛠️</span>
                  <span>改动文件与答复结论</span>
                  {selectedJobDetail.modifiedFiles?.length > 0 && (
                    <span className="text-[10px] px-1.5 py-0.2 bg-emerald-100 text-emerald-800 rounded-full font-bold ml-1">
                      {selectedJobDetail.modifiedFiles.length}
                    </span>
                  )}
                </button>
              </div>

              {/* 内容区域 */}
              <div className="flex-1 min-h-0 overflow-y-auto">
                {activeTab === "prompt" && (
                  <div className="space-y-2 h-full flex flex-col">
                    <div className="flex items-center justify-between shrink-0">
                      <span className="text-xs text-slate-600 font-medium">
                        当时喂给 AI 的完整多轮会话 Prompt 与上下文指令：
                      </span>
                      <button
                        type="button"
                        className="text-xs px-2.5 py-1 rounded bg-white hover:bg-slate-100 border border-slate-300 text-slate-800 font-medium cursor-pointer shadow-2xs"
                        onClick={() => {
                          navigator.clipboard.writeText(
                            selectedJobDetail.prompt || "",
                          );
                          showToast("已复制输入 Prompt 指令", "success");
                        }}
                      >
                        📋 复制完整 Prompt
                      </button>
                    </div>
                    <pre className="flex-1 text-[12px] whitespace-pre-wrap break-words bg-slate-50 border border-slate-200 rounded-lg p-3 font-sans text-slate-900 overflow-y-auto leading-relaxed select-text">
                      {selectedJobDetail.prompt || "(无指令内容)"}
                    </pre>
                  </div>
                )}

                {activeTab === "logs" && (
                  <div className="space-y-2 h-full flex flex-col">
                    <div className="flex items-center justify-between shrink-0">
                      <span className="text-xs text-slate-600 font-medium">
                        清晰的终端执行与工具调用日志（已过滤内部思考过程）：
                      </span>
                      <button
                        type="button"
                        className="text-xs px-2.5 py-1 rounded bg-white hover:bg-slate-100 border border-slate-300 text-slate-800 font-medium cursor-pointer shadow-2xs"
                        onClick={() => {
                          const logStr = (selectedJobDetail.logs || [])
                            .map(
                              (l) =>
                                `[${formatTime(l.at)}] [${l.kind}] ${l.text}`,
                            )
                            .join("\n");
                          navigator.clipboard.writeText(logStr);
                          showToast("已复制全部执行日志", "success");
                        }}
                      >
                        📋 复制全量日志
                      </button>
                    </div>
                    <div className="flex-1 bg-slate-950 text-slate-100 font-mono text-[11px] p-3 rounded-lg overflow-y-auto space-y-1 select-text">
                      {!selectedJobDetail.logs ||
                      selectedJobDetail.logs.length === 0 ? (
                        <div className="text-slate-500">暂无日志记录</div>
                      ) : (
                        selectedJobDetail.logs.map((log, li) => (
                          <div
                            key={li}
                            className={clsx(
                              "whitespace-pre-wrap break-words leading-relaxed",
                              log.kind === "error"
                                ? "text-rose-400 font-bold"
                                : log.kind === "meta"
                                  ? "text-sky-300 font-bold"
                                  : "text-slate-200",
                            )}
                          >
                            <span className="text-slate-600 mr-2 select-none">
                              {formatTime(log.at)}
                            </span>
                            {log.text}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}

                {activeTab === "result" && (
                  <div className="space-y-4">
                    {/* 改动文件 */}
                    <div>
                      <div className="font-bold text-xs text-slate-800 mb-2 flex items-center gap-1.5">
                        <span>🛠️</span>
                        <span>本次调用改动的文件列表：</span>
                      </div>
                      {!selectedJobDetail.modifiedFiles ||
                      selectedJobDetail.modifiedFiles.length === 0 ? (
                        <div className="text-xs text-slate-500 bg-slate-50 p-2.5 rounded border border-slate-200">
                          本次调用未修改任何代码文件（例如只读排查模式或未产生变更）
                        </div>
                      ) : (
                        <div className="space-y-1.5">
                          {selectedJobDetail.modifiedFiles.map((f, fi) => (
                            <div
                              key={fi}
                              className="flex items-center justify-between text-xs bg-emerald-50/60 border border-emerald-200 rounded p-2 text-emerald-900 font-mono"
                            >
                              <span>📄 {f}</span>
                              <button
                                type="button"
                                className="text-[11px] px-2 py-0.5 rounded bg-white hover:bg-emerald-100 border border-emerald-300 font-sans cursor-pointer transition"
                                onClick={() => {
                                  navigator.clipboard.writeText(f);
                                  showToast(`已复制路径: ${f}`, "success");
                                }}
                              >
                                复制路径
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* 处理答复与结论 */}
                    {selectedJobDetail.resultNote && (
                      <div>
                        <div className="font-bold text-xs text-slate-800 mb-2 flex items-center gap-1.5">
                          <span>💡</span>
                          <span>写回的答复结论：</span>
                        </div>
                        <div className="p-3 bg-amber-50/70 border border-amber-200 rounded-lg text-xs text-slate-900 whitespace-pre-wrap break-words font-sans leading-relaxed select-text">
                          {selectedJobDetail.resultNote}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-xs text-slate-400">
              👈 请在左侧选择一条历史记录回看
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ─── 页面 ────────────────────────────────────────────────────────────────────
export default function DockingPage() {
  const tasks = useDockingTasks();
  const status = useDockingStatus();
  const settings = useDockingSettings();
  const selectedIds = useDockingSelectedIds();
  const queue = useDockingQueue();
  const jobLogs = useDockingJobLogs();
  const activeJobId = useDockingActiveJobId();
  const runLog = useDockingRunLog();
  const appConfig = useAppConfig();
  const repos = appConfig?.frontendProjectGroups || [];
  const { confirm, confirmDialog } = useConfirm();

  const [filter, setFilter] = useState("inbox");
  const [searchKeyword, setSearchKeyword] = useState("");
  const [probe, setProbe] = useState(null);
  const [larkInstalling, setLarkInstalling] = useState(false);
  const [claudeProbe, setClaudeProbe] = useState(null);
  const [claudeInstalling, setClaudeInstalling] = useState(false);
  const [askTarget, setAskTarget] = useState(null);
  const [question, setQuestion] = useState("");
  const [sending, setSending] = useState(false);
  const [prompt, setPrompt] = useState("");

  // 新建需求弹窗状态
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");
  const [newRequester, setNewRequester] = useState("");
  const [newRepoPath, setNewRepoPath] = useState("");
  const [creating, setCreating] = useState(false);

  // 自动处理：runTargets 是当前要处理的任务数组（支持单条或多条批量）
  const runTargets = useDockingRunTargets();
  const runModalOpen = useDockingRunModalOpen();
  const [cwd, setCwd] = useState("");
  const [mode, setMode] = useState("analyze");
  const [engine, setEngine] = useState("claude");
  const [createBranch, setCreateBranch] = useState(false);
  // agy / codex 要预先注册 MCP 才能回写状态，这里存探测结果
  const [agyProbe, setAgyProbe] = useState(null);
  const [agyBusy, setAgyBusy] = useState(false);
  const [codexProbe, setCodexProbe] = useState(null);
  const [codexBusy, setCodexBusy] = useState(false);
  const [codexInstalling, setCodexInstalling] = useState(false);

  // 一键飞书回复排查解答状态
  const [solutionTarget, setSolutionTarget] = useState(null);
  const [solutionText, setSolutionText] = useState("");
  const [solutionMarkDone, setSolutionMarkDone] = useState(true);
  const [solutionSending, setSolutionSending] = useState(false);

  // 工作量周报状态
  const [reportModalOpen, setReportModalOpen] = useState(false);
  const [reportRange, setReportRange] = useState("this_week");

  // 自动派发 AI 预设规则弹窗状态
  const [autoDispatchModalOpen, setAutoDispatchModalOpen] = useState(false);
  const [autoCwd, setAutoCwd] = useState("auto");
  const [autoMode, setAutoMode] = useState("analyze");
  const [autoEngine, setAutoEngine] = useState("claude");
  const [autoCreateBranch, setAutoCreateBranch] = useState(true);
  // 力度自动提权：默认关。开了之后，话题里对方的新指令命中关键词才会
  // 把「只读分析」提到「允许改代码」
  const [autoEscalate, setAutoEscalate] = useState(false);
  const [escalateKeywords, setEscalateKeywords] = useState("");
  // 允许触发本机自动执行的飞书 open_id，留空 = 不限制
  const [allowedRequesters, setAllowedRequesters] = useState("");

  // ── AI 调用历史记录回看状态 ──
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const [historyList, setHistoryList] = useState([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [selectedJobId, setSelectedJobId] = useState(null);
  const [selectedJobDetail, setSelectedJobDetail] = useState(null);
  const [historyFilterTaskId, setHistoryFilterTaskId] = useState("");
  const [historyFilterEngine, setHistoryFilterEngine] = useState("");
  const [historyFilterStatus, setHistoryFilterStatus] = useState("");

  const runningJobs = useMemo(() => queue?.running || [], [queue?.running]);
  const queuedJobs = useMemo(() => queue?.queued || [], [queue?.queued]);
  const allActiveJobs = useMemo(
    () => [...runningJobs, ...queuedJobs],
    [runningJobs, queuedJobs],
  );

  const modalJob = useMemo(() => {
    if (activeJobId) {
      const found = allActiveJobs.find((j) => j.id === activeJobId);
      if (found) return found;
    }
    return runningJobs[0] || queuedJobs[0] || null;
  }, [activeJobId, allActiveJobs, runningJobs, queuedJobs]);

  const refreshAllProbes = () => {
    probeLark().then((p) => setProbe(p));
    probeClaude().then((p) => setClaudeProbe(p));
    window.electronAPI.dockingAgyProbe().then((r) => setAgyProbe(r?.probe));
    probeCodex().then((p) => setCodexProbe(p));
  };

  const fetchHistory = async ({
    taskId = historyFilterTaskId,
    engine = historyFilterEngine,
    status = historyFilterStatus,
  } = {}) => {
    try {
      const res = await window.electronAPI.dockingGetHistory({
        taskId: taskId || undefined,
        engine: engine || undefined,
        status: status || undefined,
        limit: 100,
      });
      const items = res?.items || [];
      setHistoryList(items);
      setHistoryTotal(res?.total || 0);
      if (items.length > 0) {
        if (!selectedJobId || !items.some((it) => it.id === selectedJobId)) {
          loadJobDetail(items[0].id);
        }
      } else {
        setSelectedJobId(null);
        setSelectedJobDetail(null);
      }
    } catch (err) {
      console.error("加载 AI 历史记录失败:", err);
    }
  };

  const loadJobDetail = async (jobId) => {
    setSelectedJobId(jobId);
    try {
      const res = await window.electronAPI.dockingGetHistoryDetail(jobId);
      setSelectedJobDetail(res?.record || null);
    } catch (err) {
      console.error("加载调用详情失败:", err);
    }
  };

  const handleDeleteHistoryJob = async (jobId) => {
    const ok = await confirm({
      title: "删除历史记录",
      message: "确定要删除该条 AI 调用历史记录吗？",
      danger: true,
    });
    if (!ok) return;
    await window.electronAPI.dockingDeleteHistory(jobId);
    showToast("已删除该条调用记录", "success");
    fetchHistory();
  };

  const handleClearAllHistory = async () => {
    const ok = await confirm({
      title: "清空所有调用历史",
      message: "确定要清空全部 AI 调用历史记录吗？",
      danger: true,
    });
    if (!ok) return;
    await window.electronAPI.dockingClearHistory();
    showToast("已清空所有历史记录", "success");
    fetchHistory();
  };

  const openHistoryForTask = (taskId) => {
    setHistoryFilterTaskId(taskId);
    fetchHistory({ taskId });
    setHistoryModalOpen(true);
  };

  useEffect(() => {
    loadTasks();
    loadStatus();
    loadSettings().then((r) => {
      if (r?.settings?.runEngine) setEngine(r.settings.runEngine);
      if (r?.settings?.createBranch !== undefined) {
        setCreateBranch(r.settings.createBranch);
      }
      if (r?.settings?.autoDispatchCwd !== undefined) {
        setAutoCwd(r.settings.autoDispatchCwd);
      }
      if (r?.settings?.autoDispatchMode) {
        setAutoMode(r.settings.autoDispatchMode);
      }
      if (r?.settings?.autoDispatchEngine) {
        setAutoEngine(r.settings.autoDispatchEngine);
      }
      if (r?.settings?.autoDispatchCreateBranch !== undefined) {
        setAutoCreateBranch(r.settings.autoDispatchCreateBranch);
      }
      if (r?.settings?.autoEscalateMode !== undefined) {
        setAutoEscalate(r.settings.autoEscalateMode);
      }
      if (r?.settings?.escalateKeywords) {
        setEscalateKeywords((r.settings.escalateKeywords || []).join("、"));
      }
      if (r?.settings?.allowedRequesters) {
        setAllowedRequesters((r.settings.allowedRequesters || []).join("\n"));
      }
    });
    loadRunStatus();
    refreshAllProbes();
    fetchHistory();

    const offHistory = window.electronAPI.onDockingHistoryUpdated?.(() => {
      fetchHistory();
    });
    return () => {
      offHistory?.();
    };
  }, []);

  const handleInstallLark = async () => {
    setLarkInstalling(true);
    try {
      const res = await installDockingCli("lark-cli");
      if (res?.success) {
        showToast("lark-cli 安装成功！已就绪", "success");
        const p = await probeLark();
        setProbe(p);
      } else {
        showToast(`安装失败: ${res?.error || "未知错误"}`, "error");
      }
    } catch (err) {
      showToast(`安装异常: ${err.message}`, "error");
    } finally {
      setLarkInstalling(false);
    }
  };

  const handleInstallClaude = async () => {
    setClaudeInstalling(true);
    try {
      const res = await installDockingCli("claude");
      if (res?.success) {
        showToast("Claude Code CLI 安装成功！已就绪", "success");
        const p = await probeClaude();
        setClaudeProbe(p);
      } else {
        showToast(`安装失败: ${res?.error || "未知错误"}`, "error");
      }
    } catch (err) {
      showToast(`安装异常: ${err.message}`, "error");
    } finally {
      setClaudeInstalling(false);
    }
  };

  const handleInstallCodex = async () => {
    setCodexInstalling(true);
    try {
      const res = await installDockingCli("codex");
      if (res?.success) {
        showToast("Codex CLI 安装成功！已就绪", "success");
        const p = await probeCodex();
        setCodexProbe(p);
      } else {
        showToast(`安装失败: ${res?.error || "未知错误"}`, "error");
      }
    } catch (err) {
      showToast(`安装异常: ${err.message}`, "error");
    } finally {
      setCodexInstalling(false);
    }
  };

  const visible = useMemo(() => {
    let list =
      filter === "all" ? tasks : tasks.filter((t) => t.status === filter);
    if (searchKeyword.trim()) {
      const q = searchKeyword.trim().toLowerCase();
      const isSeqQuery = q.startsWith("#") ? q.slice(1) : q;
      list = list.filter((t) => {
        const matchSeq = String(t.seq) === isSeqQuery;
        const matchTitle = (t.title || "").toLowerCase().includes(q);
        const matchContent = (t.content || "").toLowerCase().includes(q);
        const matchSender =
          (t.requester?.name || "").toLowerCase().includes(q) ||
          (t.requester?.id || "").toLowerCase().includes(q);
        const matchNote = (t.note || "").toLowerCase().includes(q);
        return (
          matchSeq || matchTitle || matchContent || matchSender || matchNote
        );
      });
    }
    return list;
  }, [tasks, filter, searchKeyword]);

  const counts = useMemo(() => {
    const map = {};
    for (const t of tasks) map[t.status] = (map[t.status] || 0) + 1;
    map.all = tasks.length;
    return map;
  }, [tasks]);

  const toggleListening = async () => {
    if (!status.running && probe && !probe.installed) {
      const ok = await confirm({
        title: "未检测到 lark-cli",
        message:
          "监听飞书消息需要本地全局安装 @larksuite/cli。是否立即一键安装？",
        confirmText: "一键安装",
        cancelText: "取消",
      });
      if (ok) {
        handleInstallLark();
      }
      return;
    }
    const result = status.running
      ? await stopListening()
      : await startListening();
    if (!result?.success) showToast(`操作失败: ${result?.error}`, "error");
  };

  const handleBuildPrompt = async () => {
    const result = await window.electronAPI.dockingBuildPrompt(
      selectedIds,
      true,
    );
    if (!result?.success) {
      showToast(`生成失败: ${result?.error}`, "error");
      return;
    }
    setPrompt(result.prompt);
    showToast(
      `已生成 ${result.count} 条需求的 prompt，并复制到剪贴板`,
      "success",
    );
  };

  const openRun = (taskOrTasks) => {
    const targets = Array.isArray(taskOrTasks) ? taskOrTasks : [taskOrTasks];
    if (!targets.length) return;
    const smartCwd = pickSmartRepo(targets, repos, settings.lastCwd);
    setCwd(smartCwd);
    setMode(settings.runMode || "analyze");
    setEngine(settings.runEngine || "claude");
    setCreateBranch(settings.createBranch ?? false);
    // 清掉上一条的日志，否则开新任务时直接看到旧记录而不是选项界面
    clearRunLog();
    setRunTargets(targets);
    setRunModalOpen(true);
    probeClaude().then((p) => setClaudeProbe(p));
    window.electronAPI.dockingAgyProbe().then((r) => setAgyProbe(r?.probe));
    probeCodex().then((p) => setCodexProbe(p));
  };

  const handleAgySetup = async () => {
    setAgyBusy(true);
    const result = await window.electronAPI.dockingAgySetup();
    setAgyBusy(false);
    if (result?.success) {
      setAgyProbe(result.probe);
      showToast("agy 接入已配置", "success");
    } else {
      showToast(`配置失败: ${result?.error}`, "error");
    }
  };

  const handleCodexSetup = async () => {
    setCodexBusy(true);
    const result = await window.electronAPI.dockingCodexSetup();
    setCodexBusy(false);
    if (result?.success) {
      setCodexProbe(result.probe);
      showToast("Codex 接入已配置", "success");
    } else {
      showToast(`配置失败: ${result?.error}`, "error");
    }
  };

  const handleRun = async () => {
    if (!cwd) {
      showToast("先选一个工作目录", "warning");
      return;
    }
    if (engine === "claude" && claudeProbe && !claudeProbe.installed) {
      showToast("请先安装 Claude Code CLI 后再启动", "warning");
      return;
    }
    if (engine === "agy" && agyProbe && !agyProbe.installed) {
      showToast("请先安装 Antigravity CLI 后再启动", "warning");
      return;
    }
    if (engine === "agy" && agyProbe && !agyProbe.ready) {
      showToast("请先点击「一键配置」接入 agy MCP 权限后再启动", "warning");
      return;
    }
    if (engine === "codex" && codexProbe && !codexProbe.installed) {
      showToast("请先安装 Codex CLI 后再启动", "warning");
      return;
    }
    if (engine === "codex" && codexProbe && !codexProbe.ready) {
      showToast("请先点击「一键配置」接入 Codex MCP 后再启动", "warning");
      return;
    }
    const ids = runTargets.map((t) => t.id);
    // full 档是无人值守地让外部消息驱动本地改动，发车前确认一次
    if (mode === "full") {
      const currentEngineLabel =
        ENGINES.find((e) => e.key === engine)?.label || engine;
      const targetNames =
        runTargets.length === 1
          ? `「${runTargets[0].title}」`
          : `${runTargets.length} 条需求`;
      const ok = await confirm({
        title: "确认全自动执行",
        message:
          `${currentEngineLabel} 将在 ${cwd} 无人值守地处理 ${targetNames}，` +
          "可以改文件、跑命令，全程不再询问。建议先确认 git 工作区是干净的。",
        confirmText: "开始",
        danger: true,
      });
      if (!ok) return;
    }
    const result = await startRun(ids, cwd, mode, engine, createBranch);
    if (result?.success) {
      saveSettings({
        lastCwd: cwd,
        runMode: mode,
        runEngine: engine,
        createBranch,
      });
      // 记录任务关联的 repoPath
      for (const t of runTargets) {
        if (!t.repoPath || t.repoPath !== cwd) {
          patchTask(t.id, { repoPath: cwd });
        }
      }
      setRunTargets([]);
      showToast(
        result.status === "queued"
          ? "已加入执行队列排队中"
          : "已启动 AI 任务处理",
        "success",
      );
    } else {
      showToast(`启动失败: ${result?.error}`, "error");
    }
  };

  const handleReplySolution = async () => {
    if (!solutionTarget || !solutionText.trim()) return;
    setSolutionSending(true);
    const result = await replySolution(
      solutionTarget.id,
      solutionText.trim(),
      solutionMarkDone,
    );
    setSolutionSending(false);
    if (result?.success) {
      showToast("已成功将排查解答回送给对方", "success");
      setSolutionTarget(null);
      setSolutionText("");
    } else {
      showToast(`发送失败: ${result?.error}`, "error");
    }
  };

  const handleCreateTask = async () => {
    const content = newContent.trim() || newTitle.trim();
    if (!content) {
      showToast("请填写需求内容", "warning");
      return;
    }
    setCreating(true);
    const result = await createTask({
      title: newTitle.trim() || undefined,
      content,
      senderName: newRequester.trim() || "手动录入",
      repoPath: newRepoPath || "",
      status: "inbox",
    });
    setCreating(false);
    if (result?.success) {
      showToast(`已创建需求 #${result.task.seq}`, "success");
      setCreateModalOpen(false);
      setNewTitle("");
      setNewContent("");
      setNewRequester("");
      setNewRepoPath("");
    } else {
      showToast(`创建失败: ${result?.error}`, "error");
    }
  };

  const handleAsk = async () => {
    const text = question.trim();
    if (!text || !askTarget) return;

    setSending(true);
    const result = await askRequester(askTarget.id, text);
    setSending(false);
    if (result?.success) {
      showToast(
        "已发送至飞书原消息话题 (Thread)，等对方回复后会自动挂回",
        "success",
      );
      setAskTarget(null);
      setQuestion("");
    } else {
      showToast(`发送失败: ${result?.error}`, "error");
    }
  };

  const handleBulkDelete = async () => {
    const ok = await confirm({
      title: `批量移除 ${selectedIds.length} 条需求话题`,
      message: `确定要从本工具列表中移除选中的 ${selectedIds.length} 条需求吗？\n（仅在本软件中删除记录，飞书 App 里的聊天记录与消息完全不受影响）`,
      danger: true,
    });
    if (!ok) return;
    const result = await removeTasks(selectedIds);
    if (result?.success) {
      showToast(`已移除 ${result.removed} 条`, "success");
    } else {
      showToast(`删除失败: ${result?.error}`, "error");
    }
  };

  const handleDelete = async (task) => {
    const ok = await confirm({
      title: "移除需求话题",
      message: `确定要从本工具列表中移除话题 #${task.seq}「${task.title}」吗？\n（仅在本软件中删除记录，飞书 App 里的聊天记录与消息完全不受影响）`,
      danger: true,
    });
    if (ok) {
      await removeTask(task.id);
      showToast(`已移除话题 #${task.seq}`, "success");
    }
  };

  const selectAllVisible = () => {
    const visibleIds = visible.map((t) => t.id);
    const allSelected = visibleIds.every((id) => selectedIds.includes(id));
    setSelectedIds(allSelected ? [] : visibleIds);
  };

  return (
    <PageShell
      title="赛博牛马"
      subtitle="飞书需求与逻辑咨询入列 · 勾选交给 AI 分析或实现 · 原路飞书回复沟通"
      noCard
      actions={
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="text-xs px-3 py-1.5 rounded border border-border text-slate-700 bg-white hover:bg-slate-50 font-medium cursor-pointer flex items-center gap-1.5 shadow-2xs"
            onClick={() => {
              setHistoryFilterTaskId("");
              fetchHistory({ taskId: "" });
              setHistoryModalOpen(true);
            }}
          >
            <span>📜</span>
            <span>AI 调用历史</span>
            {historyTotal > 0 && (
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-slate-100 text-slate-700 font-bold border border-slate-200">
                {historyTotal}
              </span>
            )}
          </button>
          <button
            type="button"
            className="text-xs px-3 py-1.5 rounded border border-border text-slate-700 bg-white hover:bg-slate-50 font-medium cursor-pointer flex items-center gap-1.5"
            onClick={() => setReportModalOpen(true)}
          >
            <span>📊</span>
            <span>工作量周报</span>
          </button>
          <button
            type="button"
            className="text-xs px-3 py-1.5 rounded border border-sky-200 text-sky-600 bg-sky-50 hover:bg-sky-100 font-medium cursor-pointer"
            onClick={() => setCreateModalOpen(true)}
          >
            + 新建需求 / 咨询
          </button>
          <button
            type="button"
            className={clsx(
              "text-xs px-3 py-1.5 rounded border cursor-pointer",
              status.running
                ? "border-emerald-200 text-emerald-600 bg-emerald-50"
                : "border-border text-slate-600 hover:bg-slate-50",
            )}
            onClick={toggleListening}
          >
            {status.running ? "监听中 · 点击停止" : "开始监听飞书"}
          </button>
        </div>
      }
    >
      <div className="max-w-4xl mx-auto w-full flex flex-col gap-3 p-2">
        {/* 环境与连接状态 */}
        {probe && !probe.installed && (
          <CliInstallCard
            title="未检测到飞书 CLI (lark-cli)"
            desc="赛博牛马需要本地全局安装 @larksuite/cli 来监听飞书私聊消息、发送回执与话题反问卡片。"
            installCmd={probe.installCmd || "npm install -g @larksuite/cli"}
            onInstall={handleInstallLark}
            installing={larkInstalling}
            btnText="一键安装 lark-cli"
          />
        )}
        {status.lastError && (
          <div className="text-[12px] border border-rose-200 bg-rose-50 text-rose-600 rounded-lg px-3 py-2 whitespace-pre-wrap">
            {status.lastError}
            {status.retrying && " · 正在自动重连"}
          </div>
        )}

        {/* 飞书快捷指令说明栏 */}
        <div className="flex items-center justify-between text-[11px] text-slate-700 bg-slate-50 border border-slate-200/80 rounded-lg px-3 py-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-slate-700 font-bold">💡 飞书指令：</span>
            <span>
              <code className="text-sky-700 font-mono font-semibold">
                /r 内容
              </code>{" "}
              提需求/问逻辑
            </span>
            <span className="text-slate-400">·</span>
            <span>
              <code className="text-sky-700 font-mono font-semibold">/u</code>{" "}
              查任务
            </span>
            <span className="text-slate-400">·</span>
            <span>
              <code className="text-sky-700 font-mono font-semibold">
                /u 7 补充
              </code>{" "}
              补充到 #7
            </span>
            <span className="text-slate-400">·</span>
            <span>
              <code className="text-sky-700 font-mono font-semibold">/h</code>{" "}
              看帮助
            </span>
          </div>
          <span className="text-[10px] text-slate-600 font-medium shrink-0 ml-2">
            未带指令的普通消息自动归入「未识别」
          </span>
        </div>

        {/* 自动化与通知策略配置栏 */}
        <div className="flex items-center justify-between gap-3 text-xs bg-white border border-border rounded-lg px-3 py-2 flex-wrap shadow-2xs">
          {/* 飞书通知策略 */}
          <div className="flex items-center gap-3">
            <span className="text-[11px] font-bold text-slate-700 shrink-0">
              飞书通知
            </span>
            <label
              className="flex items-center gap-1.5 cursor-pointer text-slate-800 font-medium hover:text-slate-950"
              title="收到 /r 需求时自动发送「已记录 #N」飞书卡片"
            >
              <input
                type="checkbox"
                className="accent-sky-600 rounded"
                checked={settings.ackEnabled ?? true}
                onChange={(e) => saveSettings({ ackEnabled: e.target.checked })}
              />
              <span>自动回执</span>
            </label>
            <label
              className="flex items-center gap-1.5 cursor-pointer text-slate-800 font-medium hover:text-slate-950"
              title="任务标记为完成或忽略时自动通知提出人"
            >
              <input
                type="checkbox"
                className="accent-sky-600 rounded"
                checked={settings.notifyOnComplete ?? true}
                onChange={(e) =>
                  saveSettings({ notifyOnComplete: e.target.checked })
                }
              />
              <span>完成通知</span>
            </label>
          </div>

          <div className="h-3.5 w-px bg-slate-200 hidden sm:block" />

          {/* AI 协同与自动派发 */}
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-[11px] font-bold text-slate-700 shrink-0">
              AI 协同
            </span>
            <label
              className="flex items-center gap-1.5 cursor-pointer text-slate-800 font-medium hover:text-slate-950"
              title="仅对「已反问、等回复」的任务生效：对方回答了我的反问后，自动唤醒 AI 接着往下跑。话题里的普通新指令归上面的「收到需求自动交给 AI」管。"
            >
              <input
                type="checkbox"
                className="accent-sky-600 rounded"
                checked={settings.autoResumeOnClarification ?? true}
                onChange={(e) =>
                  saveSettings({ autoResumeOnClarification: e.target.checked })
                }
              />
              <span>反问被回复后 AI 自动继续</span>
            </label>

            <div className="flex items-center gap-1.5 pl-1">
              <label
                className="flex items-center gap-1.5 cursor-pointer font-medium"
                title="收到 /r 需求后自动根据预设规则派发 AI 执行"
              >
                <input
                  type="checkbox"
                  className="accent-indigo-600 rounded"
                  checked={settings.autoDispatchEnabled ?? false}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    saveSettings({ autoDispatchEnabled: checked });
                    if (checked) {
                      showToast("已开启收到需求自动交给 AI 处理", "info");
                    }
                  }}
                />
                <span
                  className={clsx(
                    settings.autoDispatchEnabled
                      ? "text-indigo-700 font-bold"
                      : "text-slate-800",
                  )}
                >
                  📥 收到需求自动交给 AI
                </span>
              </label>
              <button
                type="button"
                className="text-[11px] px-1.5 py-0.5 rounded border border-slate-300 hover:border-slate-400 bg-slate-50 hover:bg-white text-slate-700 hover:text-slate-900 font-medium cursor-pointer flex items-center gap-0.5 transition"
                title="配置自动派发 AI 的默认项目、模式与引擎"
                onClick={() => setAutoDispatchModalOpen(true)}
              >
                <span>⚙️</span>
                <span>预设规则</span>
              </button>
            </div>
          </div>
        </div>

        {/* 自动派发状态提示条 */}
        {settings.autoDispatchEnabled && (
          <div className="flex items-center justify-between text-[11px] bg-indigo-50 border border-indigo-200 text-indigo-900 rounded-lg px-3 py-1.5 font-medium">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-indigo-600 animate-pulse" />
              <span>
                <strong>⚡ 无人值守赛博牛马已就绪</strong>：收到 /r
                需求后将自动派发 AI（
                {settings.autoDispatchMode === "analyze"
                  ? "只读排查"
                  : settings.autoDispatchMode === "edit"
                    ? "改代码"
                    : "全自动"}{" "}
                ·{" "}
                {settings.autoDispatchEngine === "agy"
                  ? "Antigravity"
                  : settings.autoDispatchEngine === "codex"
                    ? "Codex"
                    : "Claude Code"}{" "}
                ·{" "}
                {settings.autoDispatchCwd === "auto" ||
                !settings.autoDispatchCwd
                  ? "智能匹配项目"
                  : settings.autoDispatchCwd.split(/[\\/]/).pop()}
                ）
              </span>
            </div>
            <button
              type="button"
              className="text-indigo-700 hover:text-indigo-900 underline font-semibold cursor-pointer ml-2"
              onClick={() => setAutoDispatchModalOpen(true)}
            >
              修改预设规则
            </button>
          </div>
        )}

        {/* 搜索与筛选工具栏 */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <input
              type="text"
              className="w-full text-xs pl-7 pr-7 py-1.5 rounded-lg border border-slate-300 bg-white placeholder:text-slate-500 text-slate-800 focus:outline-none focus:ring-1 focus:ring-sky-400"
              placeholder="搜索需求、短号(#7)、发起人、关键词…"
              value={searchKeyword}
              onChange={(e) => setSearchKeyword(e.target.value)}
            />
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 text-xs">
              🔍
            </span>
            {searchKeyword && (
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-700 text-xs cursor-pointer"
                onClick={() => setSearchKeyword("")}
              >
                ✕
              </button>
            )}
          </div>

          {/* 状态筛选页签 */}
          <div className="flex items-center gap-1 flex-wrap">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                className={clsx(
                  "text-[11px] px-2.5 py-1 rounded-full border cursor-pointer transition",
                  filter === f.key
                    ? "border-sky-400 bg-sky-50 text-sky-700 font-semibold ring-1 ring-sky-300"
                    : "border-slate-300 text-slate-700 hover:text-slate-900 hover:bg-slate-100 font-medium",
                )}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
                {counts[f.key] ? ` ${counts[f.key]}` : ""}
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-2 shrink-0">
            {selectedIds.length > 0 && (
              <button
                type="button"
                className="text-[11px] px-2.5 py-1 rounded border border-rose-300 text-rose-600 hover:text-rose-700 hover:bg-rose-50 font-medium cursor-pointer flex items-center gap-1 transition shadow-2xs"
                onClick={handleBulkDelete}
              >
                <span>🗑️</span>
                <span>批量删除 ({selectedIds.length})</span>
              </button>
            )}
            <button
              type="button"
              className="text-[11px] text-slate-600 hover:text-slate-900 font-medium cursor-pointer"
              onClick={selectAllVisible}
            >
              全选/取消
            </button>
          </div>
        </div>

        {/* 任务列表 */}
        {visible.length === 0 ? (
          <div className="text-center text-[12px] text-slate-600 font-medium py-16 border border-dashed border-slate-300 rounded-lg bg-slate-50/50">
            {searchKeyword
              ? "没有找到匹配的需求"
              : status.running
                ? "监听中，等后端同学飞书私聊你……"
                : "还没有任务。可点击右上角「+ 新建需求」或「开始监听飞书」"}
          </div>
        ) : (
          <div className="space-y-2">
            {visible.map((task) => {
              const runningJob = (queue?.running || []).find((j) =>
                j.taskIds.includes(task.id),
              );
              const queuedJob = (queue?.queued || []).find((j) =>
                j.taskIds.includes(task.id),
              );
              return (
                <TaskCard
                  key={task.id}
                  task={task}
                  checked={selectedIds.includes(task.id)}
                  onToggle={toggleSelected}
                  runningJob={runningJob}
                  queuedJob={queuedJob}
                  onCancelJob={cancelDockingJob}
                  onOpenJob={(j) => {
                    setActiveJobId(j.id);
                    const activeTasks = (j.taskIds || [])
                      .map((id) => tasks.find((t) => t.id === id))
                      .filter(Boolean);
                    setRunTargets(activeTasks);
                    setRunModalOpen(true);
                  }}
                  onRun={openRun}
                  onAsk={(t) => {
                    setAskTarget(t);
                    setQuestion("");
                  }}
                  onReplySolution={(t) => {
                    setSolutionTarget(t);
                    setSolutionText(t.note || "");
                    setSolutionMarkDone(true);
                  }}
                  onDelete={handleDelete}
                  onViewHistory={openHistoryForTask}
                />
              );
            })}
          </div>
        )}

        {/* 派活条 */}
        {selectedIds.length > 0 && (
          <div className="sticky bottom-0 flex items-center gap-2 bg-white border border-border rounded-lg px-3 py-2 shadow-sm">
            <span className="text-[12px] text-slate-500">
              已选 {selectedIds.length} 条
            </span>
            <button
              type="button"
              className="ml-auto text-[11px] text-slate-400 hover:text-slate-600 cursor-pointer"
              onClick={clearSelected}
            >
              清空
            </button>
            <button
              type="button"
              className="text-xs px-3 py-1.5 rounded border border-rose-200 text-rose-500 hover:bg-rose-50 cursor-pointer"
              onClick={handleBulkDelete}
            >
              删除
            </button>
            <button
              type="button"
              className="text-xs px-3 py-1.5 rounded border border-border text-slate-600 hover:bg-slate-50 cursor-pointer"
              onClick={handleBuildPrompt}
            >
              复制 prompt
            </button>
            <button
              type="button"
              className="text-xs px-3 py-1.5 rounded bg-sky-600 text-white hover:bg-sky-700 cursor-pointer font-medium"
              onClick={() => {
                const selectedTasks = selectedIds
                  .map((id) => tasks.find((t) => t.id === id))
                  .filter(Boolean);
                openRun(selectedTasks);
              }}
            >
              交给 AI 处理 ({selectedIds.length})
            </button>
          </div>
        )}
      </div>

      {/* 新建需求 / 咨询弹窗 */}
      <Modal
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        title="新建需求 / 逻辑排查咨询"
        srOnly={false}
        className="w-[560px] p-4"
      >
        <div className="space-y-3">
          <div>
            <label className="block text-[11px] font-bold text-slate-800 mb-1">
              简述 / 标题
            </label>
            <input
              type="text"
              className="w-full text-[12px] border border-slate-300 rounded p-2 focus:outline-none focus:ring-1 focus:ring-sky-400 bg-white text-slate-900 placeholder:text-slate-500 font-medium"
              placeholder="例如：排查登录态过期跳转逻辑 / 对接批量打标签接口"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold text-slate-800 mb-1">
              详细描述 / 业务疑问 / 接口参数{" "}
              <span className="text-rose-500">*</span>
            </label>
            <textarea
              className="w-full text-[12px] border border-slate-300 rounded p-2 min-h-[100px] resize-y focus:outline-none focus:ring-1 focus:ring-sky-400 bg-white text-slate-900 placeholder:text-slate-500 font-medium"
              placeholder="粘贴需求说明、业务疑问、报错信息、排查要求或接口参数…"
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-bold text-slate-800 mb-1">
                提出人 / 来源
              </label>
              <input
                type="text"
                className="w-full text-[12px] border border-slate-300 rounded p-2 focus:outline-none focus:ring-1 focus:ring-sky-400 bg-white text-slate-900 placeholder:text-slate-500 font-medium"
                placeholder="默认：手动录入"
                value={newRequester}
                onChange={(e) => setNewRequester(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-slate-800 mb-1">
                关联项目 (Repo)
              </label>
              <select
                className="w-full text-[12px] border border-slate-300 rounded p-2 focus:outline-none focus:ring-1 focus:ring-sky-400 bg-white text-slate-900 font-medium"
                value={newRepoPath}
                onChange={(e) => setNewRepoPath(e.target.value)}
              >
                <option value="">未指定（派活时再选）</option>
                {repos.map((r) => (
                  <option key={r.key} value={r.path}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <button
            type="button"
            className="text-xs px-3 py-1.5 rounded border border-slate-300 text-slate-700 hover:bg-slate-100 font-medium cursor-pointer"
            onClick={() => setCreateModalOpen(false)}
          >
            取消
          </button>
          <button
            type="button"
            disabled={creating || (!newContent.trim() && !newTitle.trim())}
            className="text-xs px-3.5 py-1.5 rounded bg-sky-600 hover:bg-sky-700 text-white disabled:opacity-40 cursor-pointer font-semibold shadow-xs"
            onClick={handleCreateTask}
          >
            {creating ? "创建中…" : "创建需求"}
          </button>
        </div>
      </Modal>

      {/* 回复提出人弹窗 */}
      <Modal
        open={Boolean(askTarget)}
        onClose={() => setAskTarget(null)}
        title="💬 飞书 Thread 话题追问 / 确认"
        srOnly={false}
        className="w-[540px] p-4"
      >
        <p className="text-[12px] text-slate-700 mb-2.5 leading-relaxed">
          将在需求 #{askTarget?.seq}「{askTarget?.title}」的
          <strong className="text-sky-700 font-semibold">
            {" "}
            飞书原消息话题 (Thread){" "}
          </strong>
          下以卡片回复提出人{" "}
          <strong className="text-slate-900">
            {askTarget?.requester?.name || askTarget?.requester?.id || ""}
          </strong>
          。对方直接在飞书该消息下回复，内容将自动同步回本任务。
        </p>
        <textarea
          className="w-full text-[13px] border border-slate-300 rounded p-2 min-h-[120px] resize-y focus:outline-none focus:ring-1 focus:ring-sky-400 bg-white text-slate-900 placeholder:text-slate-500 font-medium"
          placeholder="想对提出人回复或说明什么？例如：该逻辑排查结论已完成；或者需要对方提供具体的测试入参…"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <div className="flex justify-end gap-2 mt-3">
          <button
            type="button"
            className="text-xs px-3 py-1.5 rounded border border-slate-300 text-slate-700 hover:bg-slate-100 font-medium cursor-pointer"
            onClick={() => setAskTarget(null)}
          >
            取消
          </button>
          <button
            type="button"
            disabled={sending || !question.trim()}
            className="text-xs px-3.5 py-1.5 rounded bg-sky-600 hover:bg-sky-700 text-white disabled:opacity-40 cursor-pointer font-medium"
            onClick={handleAsk}
          >
            {sending ? "发送中…" : "发送回复"}
          </button>
        </div>
      </Modal>

      {/* 自动处理 */}
      <Modal
        open={runModalOpen || runTargets.length > 0}
        onClose={() => {
          setRunModalOpen(false);
          setRunTargets([]);
        }}
        title={
          runTargets.length > 0
            ? runTargets.length === 1
              ? `交给 ${ENGINES.find((e) => e.key === engine)?.label || "Agent"} · #${runTargets[0].seq} ${runTargets[0].title}`
              : `交给 ${ENGINES.find((e) => e.key === engine)?.label || "Agent"} · 批量处理 ${runTargets.length} 条需求`
            : modalJob
              ? `AI 处理中心 · ${allActiveJobs.length} 个任务调度中`
              : "AI 处理详情"
        }
        srOnly={false}
        className="w-[780px] p-4"
      >
        {/* 多任务调度 Tab 栏 */}
        {allActiveJobs.length > 0 && (
          <div className="flex items-center gap-1.5 pb-2.5 mb-3 border-b border-border overflow-x-auto text-[11px]">
            <span className="text-slate-400 font-medium shrink-0">任务池:</span>
            {allActiveJobs.map((j) => {
              const firstTask = tasks.find((t) => t.id === j.taskIds[0]);
              const label = firstTask
                ? `#${firstTask.seq} ${firstTask.title}`
                : `Job ${j.id.slice(0, 6)}`;
              const isSelected =
                modalJob?.id === j.id && runTargets.length === 0;
              const isRunning = j.status === "running";
              return (
                <button
                  key={j.id}
                  type="button"
                  className={clsx(
                    "px-2.5 py-1 rounded cursor-pointer transition flex items-center gap-1.5 shrink-0 max-w-[200px] truncate",
                    isSelected
                      ? isRunning
                        ? "bg-emerald-50 text-emerald-700 border border-emerald-300 font-medium shadow-2xs"
                        : "bg-amber-50 text-amber-700 border border-amber-300 font-medium shadow-2xs"
                      : "bg-slate-50 text-slate-600 hover:bg-slate-100 border border-border",
                  )}
                  onClick={() => {
                    setRunTargets([]);
                    setActiveJobId(j.id);
                  }}
                >
                  {isRunning ? (
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
                  ) : (
                    <span className="text-[10px] shrink-0">⏳</span>
                  )}
                  <span className="truncate">{label}</span>
                </button>
              );
            })}
            {selectedIds.length > 0 && (
              <button
                type="button"
                className={clsx(
                  "px-2.5 py-1 rounded cursor-pointer transition flex items-center gap-1 shrink-0 ml-auto text-[11px]",
                  runTargets.length > 0
                    ? "bg-sky-50 text-sky-700 border border-sky-300 font-medium"
                    : "bg-white text-sky-600 hover:bg-sky-50 border border-sky-200",
                )}
                onClick={() => {
                  const selectedTasks = selectedIds
                    .map((id) => tasks.find((t) => t.id === id))
                    .filter(Boolean);
                  openRun(selectedTasks);
                }}
              >
                <span>+ 派发所选 ({selectedIds.length})</span>
              </button>
            )}
          </div>
        )}

        {runTargets.length > 0 ? (
          <>
            <p className="text-[11px] text-slate-400 mb-2">
              {ENGINES.find((e) => e.key === engine)?.label || "Agent"}{" "}
              会在选定目录里处理需求，自己回写完成状态；
              需求说不清时直接飞书反问提出人。
            </p>

            {runTargets.length > 1 && (
              <div className="mb-2.5 p-2 rounded bg-slate-50 border border-slate-200">
                <div className="text-[11px] font-medium text-slate-600 mb-1">
                  选中的 {runTargets.length} 条需求：
                </div>
                <div className="flex flex-wrap gap-1 max-h-[80px] overflow-y-auto">
                  {runTargets.map((t) => (
                    <span
                      key={t.id}
                      className="text-[10px] px-1.5 py-0.5 rounded bg-white border border-slate-200 text-slate-700"
                    >
                      #{t.seq} {t.title}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {repos.length === 0 ? (
              <p className="text-[12px] text-amber-600 py-6 text-center">
                还没配置任何 Repo，先去「项目管理」加一个。
              </p>
            ) : (
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  工作目录 (Repo)
                </label>
                <div className="space-y-1 max-h-[160px] overflow-y-auto">
                  {repos.map((repo) => (
                    <button
                      key={repo.key}
                      type="button"
                      className={clsx(
                        "w-full text-left px-3 py-2 rounded border text-[12px] cursor-pointer",
                        cwd === repo.path
                          ? "border-sky-300 bg-sky-50"
                          : "border-border hover:bg-slate-50",
                      )}
                      onClick={() => setCwd(repo.path)}
                    >
                      <div className="font-medium text-slate-700">
                        {repo.label}
                      </div>
                      <div className="text-[11px] text-slate-400 truncate">
                        {repo.path}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* 引擎选择 */}
            <div className="mt-3 flex items-center gap-1">
              {ENGINES.map((e) => (
                <button
                  key={e.key}
                  type="button"
                  className={clsx(
                    "text-[11px] px-2.5 py-1 rounded-full border cursor-pointer transition flex items-center gap-1",
                    engine === e.key
                      ? "border-sky-300 bg-sky-50 text-sky-600 font-medium"
                      : "border-border text-slate-500 hover:bg-slate-50",
                  )}
                  onClick={() => {
                    setEngine(e.key);
                    saveSettings({ runEngine: e.key });
                    if (e.key === "claude") {
                      probeClaude().then((p) => setClaudeProbe(p));
                    } else if (e.key === "agy") {
                      window.electronAPI
                        .dockingAgyProbe()
                        .then((r) => setAgyProbe(r?.probe));
                    } else if (e.key === "codex") {
                      probeCodex().then((p) => setCodexProbe(p));
                    }
                  }}
                >
                  <span>{e.label}</span>
                  {e.key === "claude" &&
                    claudeProbe &&
                    !claudeProbe.installed && (
                      <span className="text-[9px] px-1 py-0.2 rounded bg-amber-100 text-amber-800 border border-amber-300">
                        未安装
                      </span>
                    )}
                  {e.key === "agy" && agyProbe && !agyProbe.installed && (
                    <span className="text-[9px] px-1 py-0.2 rounded bg-amber-100 text-amber-800 border border-amber-300">
                      未安装
                    </span>
                  )}
                  {e.key === "agy" &&
                    agyProbe?.installed &&
                    !agyProbe?.ready && (
                      <span className="text-[9px] px-1 py-0.2 rounded bg-amber-100 text-amber-800 border border-amber-300">
                        未配置
                      </span>
                    )}
                  {e.key === "codex" && codexProbe && !codexProbe.installed && (
                    <span className="text-[9px] px-1 py-0.2 rounded bg-amber-100 text-amber-800 border border-amber-300">
                      未安装
                    </span>
                  )}
                  {e.key === "codex" &&
                    codexProbe?.installed &&
                    !codexProbe?.ready && (
                      <span className="text-[9px] px-1 py-0.2 rounded bg-amber-100 text-amber-800 border border-amber-300">
                        未配置
                      </span>
                    )}
                </button>
              ))}
            </div>

            {/* claude 必须先安装 CLI */}
            {engine === "claude" && claudeProbe && !claudeProbe.installed && (
              <div className="mt-2">
                <CliInstallCard
                  title="未检测到 Claude Code CLI (claude)"
                  desc="执行 AI 需求处理需要本地全局安装 @anthropic-ai/claude-code。"
                  installCmd={
                    claudeProbe.installCmd ||
                    "npm install -g @anthropic-ai/claude-code"
                  }
                  onInstall={handleInstallClaude}
                  installing={claudeInstalling}
                  btnText="一键安装 Claude CLI"
                />
              </div>
            )}

            {/* agy 必须先安装 CLI 并注册 MCP */}
            {engine === "agy" && agyProbe && !agyProbe.ready && (
              <div className="mt-2">
                {!agyProbe.installed ? (
                  <CliInstallCard
                    title="未检测到 Antigravity CLI (agy)"
                    desc="执行 AI 需求处理需要本地安装 Antigravity CLI 工具。"
                    installCmd="agy"
                  />
                ) : (
                  <div className="text-[11px] border border-amber-200 bg-amber-50 text-amber-700 rounded px-3 py-2 flex items-center justify-between gap-2">
                    <span className="min-w-0">
                      agy 还没接入：需要注册 MCP server 并在它的 settings.json
                      放行，否则它没法回写任务状态、也不能自动反问。
                    </span>
                    <button
                      type="button"
                      disabled={agyBusy}
                      className="shrink-0 px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-700 text-white font-medium disabled:opacity-40 cursor-pointer shadow-2xs"
                      onClick={handleAgySetup}
                    >
                      {agyBusy ? "配置中…" : "一键配置"}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* codex 必须先安装 CLI 并注册 MCP */}
            {engine === "codex" && codexProbe && !codexProbe.ready && (
              <div className="mt-2">
                {!codexProbe.installed ? (
                  <CliInstallCard
                    title="未检测到 Codex CLI (codex)"
                    desc="执行 AI 需求处理需要本地全局安装 @openai/codex。"
                    installCmd={
                      codexProbe.installCmd || "npm install -g @openai/codex"
                    }
                    onInstall={handleInstallCodex}
                    installing={codexInstalling}
                    btnText="一键安装 Codex CLI"
                  />
                ) : (
                  <div className="text-[11px] border border-amber-200 bg-amber-50 text-amber-700 rounded px-3 py-2 flex items-center justify-between gap-2">
                    <span className="min-w-0">
                      Codex 还没接入：需要向全局 ~/.codex/config.toml 注册
                      vjtools-docking MCP server，否则它没法回写任务状态、也不能自动反问。
                    </span>
                    <button
                      type="button"
                      disabled={codexBusy}
                      className="shrink-0 px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-700 text-white font-medium disabled:opacity-40 cursor-pointer shadow-2xs"
                      onClick={handleCodexSetup}
                    >
                      {codexBusy ? "配置中…" : "一键配置"}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* 档位选择 */}
            <div className="mt-3 space-y-1">
              {RUN_MODES.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  className={clsx(
                    "w-full text-left px-3 py-2 rounded border text-[12px] cursor-pointer",
                    mode === m.key
                      ? "border-sky-300 bg-sky-50"
                      : "border-border hover:bg-slate-50",
                  )}
                  onClick={() => setMode(m.key)}
                >
                  <div className="font-medium text-slate-700">{m.label}</div>
                  <div className="text-[11px] text-slate-400">{m.desc}</div>
                </button>
              ))}
            </div>

            {/* 隔离分支开关 */}
            <div className="mt-3 p-2.5 rounded-lg border border-slate-200 bg-slate-50/80 flex items-center justify-between">
              <div>
                <div className="text-[12px] font-medium text-slate-700 flex items-center gap-1">
                  <span>🌿</span>
                  <span>自动创建临时隔离分支</span>
                </div>
                <div className="text-[11px] text-slate-400">
                  执行代码修改前自动切出独立分支 (如{" "}
                  <code>docking/seq-7-...</code>)，防止污染当前分支
                </div>
              </div>
              <input
                type="checkbox"
                className="w-4 h-4 accent-sky-600 rounded cursor-pointer"
                checked={createBranch}
                onChange={(e) => setCreateBranch(e.target.checked)}
              />
            </div>

            <div className="flex justify-end gap-2 mt-3">
              <button
                type="button"
                className="text-xs px-3 py-1.5 rounded border border-border text-slate-600 cursor-pointer"
                onClick={() => {
                  setRunModalOpen(false);
                  setRunTargets([]);
                }}
              >
                取消
              </button>
              <button
                type="button"
                disabled={!cwd}
                className="text-xs px-3 py-1.5 rounded bg-sky-600 text-white disabled:opacity-40 cursor-pointer font-medium"
                onClick={handleRun}
              >
                加入队列开始
              </button>
            </div>
          </>
        ) : modalJob ? (
          <>
            <div className="flex items-center gap-2 mb-2">
              <span
                className={clsx(
                  "text-[10px] px-1.5 py-0.5 rounded border font-medium",
                  modalJob.status === "running"
                    ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                    : "border-amber-300 bg-amber-50 text-amber-700",
                )}
              >
                {modalJob.status === "running"
                  ? "⚡ AI执行中"
                  : "⏳ 队列排队中"}
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200 text-slate-600 font-medium">
                {modalJob.engine === "agy"
                  ? "Antigravity"
                  : modalJob.engine === "codex"
                    ? "Codex"
                    : "Claude Code"}
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200 text-slate-600">
                {RUN_MODES.find((m) => m.key === modalJob.mode)?.label ||
                  modalJob.mode}
              </span>
              {modalJob.branchName && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 border border-emerald-200 text-emerald-800 font-mono">
                  🌿 {modalJob.branchName}
                </span>
              )}
              <span className="text-[11px] text-slate-400 truncate max-w-[220px]">
                {modalJob.cwd}
              </span>
              <button
                type="button"
                className="ml-auto text-[11px] px-2 py-1 rounded border border-rose-200 text-rose-500 hover:bg-rose-50 cursor-pointer"
                onClick={() => cancelDockingJob(modalJob.id)}
              >
                {modalJob.status === "queued" ? "取消排队" : "中断任务"}
              </button>
            </div>

            {/* 实时改动文件列表展示 */}
            {modalJob.modifiedFiles && modalJob.modifiedFiles.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap p-2 mb-2 rounded bg-emerald-50/70 border border-emerald-200/80">
                <span className="text-[11px] text-emerald-800 font-medium shrink-0 flex items-center gap-1">
                  <span>🛠️</span>
                  <span>已修改文件 ({modalJob.modifiedFiles.length})：</span>
                </span>
                {modalJob.modifiedFiles.map((f, i) => (
                  <button
                    key={i}
                    type="button"
                    className="text-[11px] px-1.5 py-0.5 rounded bg-white hover:bg-emerald-100 text-emerald-900 border border-emerald-200 font-mono transition flex items-center gap-1 cursor-pointer"
                    title="点击复制文件相对路径"
                    onClick={() => {
                      navigator.clipboard.writeText(f);
                      showToast(`已复制: ${f}`, "success");
                    }}
                  >
                    <span>📄</span>
                    <span>{f}</span>
                  </button>
                ))}
              </div>
            )}

            <RunLog
              entries={jobLogs[modalJob.id] || runLog}
              running={modalJob.status === "running"}
            />
          </>
        ) : (
          <div className="text-center py-10 text-slate-400 text-[12px]">
            暂无正在执行的任务，可在任务列表中勾选需求并点击「交给 AI」。
          </div>
        )}
      </Modal>

      {/* 回复排查解答弹窗 */}
      <Modal
        open={Boolean(solutionTarget)}
        onClose={() => setSolutionTarget(null)}
        title="💬 飞书回送排查解答 (Thread 话题回复)"
        srOnly={false}
        className="w-[560px] p-4"
      >
        <p className="text-[12px] text-slate-700 mb-2.5 leading-relaxed">
          将在需求 #{solutionTarget?.seq}「{solutionTarget?.title}」的
          <strong className="text-emerald-700 font-semibold">
            {" "}
            飞书原消息话题 (Thread){" "}
          </strong>
          下以结构化卡片回送排查解答给{" "}
          <strong className="text-slate-900">
            {solutionTarget?.requester?.name ||
              solutionTarget?.requester?.id ||
              "提出人"}
          </strong>
          。
        </p>
        <textarea
          className="w-full text-[12px] border border-slate-300 rounded p-2.5 min-h-[140px] resize-y focus:outline-none focus:ring-1 focus:ring-sky-400 font-sans text-slate-800"
          placeholder="排查解答内容（可在线微调修改）..."
          value={solutionText}
          onChange={(e) => setSolutionText(e.target.value)}
        />
        <div className="mt-2.5 flex items-center justify-between">
          <label className="flex items-center gap-1.5 text-xs text-slate-700 font-medium cursor-pointer">
            <input
              type="checkbox"
              className="accent-sky-600"
              checked={solutionMarkDone}
              onChange={(e) => setSolutionMarkDone(e.target.checked)}
            />
            <span>发送后同时将任务标记为「已完成」</span>
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              className="text-xs px-3 py-1.5 rounded border border-slate-300 text-slate-700 hover:bg-slate-100 font-medium cursor-pointer"
              onClick={() => setSolutionTarget(null)}
            >
              取消
            </button>
            <button
              type="button"
              disabled={solutionSending || !solutionText.trim()}
              className="text-xs px-3.5 py-1.5 rounded bg-sky-600 hover:bg-sky-700 text-white disabled:opacity-40 cursor-pointer font-semibold shadow-xs"
              onClick={handleReplySolution}
            >
              {solutionSending ? "发送中…" : "确认发送"}
            </button>
          </div>
        </div>
      </Modal>

      {/* 工作量周报生成器 */}
      <Modal
        open={reportModalOpen}
        onClose={() => setReportModalOpen(false)}
        title="📊 赛博牛马工作量周报 / 汇总"
        srOnly={false}
        className="w-[720px] p-4"
      >
        {(() => {
          const report = generateDockingReport(tasks, reportRange);
          return (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1">
                  {[
                    { key: "this_week", label: "本周" },
                    { key: "7days", label: "近 7 天" },
                    { key: "this_month", label: "本月" },
                    { key: "all", label: "全部" },
                  ].map((tab) => (
                    <button
                      key={tab.key}
                      type="button"
                      className={clsx(
                        "text-[11px] px-2.5 py-1 rounded-full border cursor-pointer transition",
                        reportRange === tab.key
                          ? "border-sky-400 bg-sky-50 text-sky-700 font-bold ring-1 ring-sky-300"
                          : "border-slate-300 text-slate-700 hover:bg-slate-100 font-medium",
                      )}
                      onClick={() => setReportRange(tab.key)}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2 text-[11px] text-slate-700 font-medium">
                  <span>
                    完成:{" "}
                    <strong className="text-emerald-700 font-bold">
                      {report.metrics.done}
                    </strong>{" "}
                    / {report.metrics.total}
                  </span>
                  <span className="text-slate-300">·</span>
                  <span>
                    改动文件:{" "}
                    <strong className="text-sky-700 font-bold">
                      {report.metrics.filesCount}
                    </strong>
                  </span>
                </div>
              </div>

              <pre className="text-[12px] whitespace-pre-wrap break-words bg-slate-50 border border-slate-200 rounded p-3 max-h-[50vh] overflow-y-auto font-sans text-slate-800 select-text leading-relaxed">
                {report.markdown}
              </pre>

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  className="text-xs px-3 py-1.5 rounded border border-slate-300 text-slate-700 hover:bg-slate-100 font-medium cursor-pointer"
                  onClick={() => setReportModalOpen(false)}
                >
                  关闭
                </button>
                <button
                  type="button"
                  className="text-xs px-3.5 py-1.5 rounded bg-sky-600 hover:bg-sky-700 text-white font-semibold cursor-pointer shadow-xs"
                  onClick={() => {
                    navigator.clipboard.writeText(report.markdown);
                    showToast("周报内容已复制到剪贴板", "success");
                  }}
                >
                  复制周报 Markdown
                </button>
              </div>
            </div>
          );
        })()}
      </Modal>

      {/* 自动派发 AI 预设规则弹窗 */}
      <Modal
        open={autoDispatchModalOpen}
        onClose={() => setAutoDispatchModalOpen(false)}
        title="⚙️ 收到需求自动交给 AI 预设规则"
        srOnly={false}
        className="w-[580px] max-w-[95vw] max-h-[85vh] p-0"
      >
        {/* 内容比一屏高，滚动区自己滚，底部按钮钉在下面不跟着走 */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4 text-xs">
          <p className="text-[12px] text-slate-700 leading-relaxed">
            开启后，飞书收到{" "}
            <code className="text-sky-700 font-semibold font-mono">/r</code>{" "}
            需求时将
            <strong>无需人工手动派发</strong>
            ，系统自动根据以下预设规则入列并唤醒 AI 进行排查解答。
          </p>

          {/* 工作目录选择 */}
          <div>
            <label className="block font-bold text-slate-800 mb-1">
              默认工作目录 (Repo)
            </label>
            <select
              className="w-full text-xs border border-slate-300 rounded px-2.5 py-1.5 bg-white text-slate-800 font-medium focus:outline-none focus:ring-1 focus:ring-sky-400"
              value={autoCwd}
              onChange={(e) => setAutoCwd(e.target.value)}
            >
              <option value="auto">
                ✨ 智能匹配项目（推荐，根据需求标题与内容自动识别）
              </option>
              {repos.map((r) => (
                <option key={r.path} value={r.path}>
                  📁 {r.label || r.key} ({r.path.split(/[\\/]/).pop()})
                </option>
              ))}
            </select>
          </div>

          {/* 执行力度 Mode */}
          <div>
            <label className="block font-bold text-slate-800 mb-1">
              默认执行力度
            </label>
            <div className="grid grid-cols-3 gap-2">
              {RUN_MODES.map((item) => (
                <label
                  key={item.key}
                  className={clsx(
                    "flex flex-col gap-1 p-2.5 rounded-lg border cursor-pointer transition",
                    autoMode === item.key
                      ? "border-sky-500 bg-sky-50/70 text-sky-950 ring-1 ring-sky-400"
                      : "border-slate-300 hover:bg-slate-50 text-slate-800",
                  )}
                >
                  <div className="flex items-center gap-1.5 font-bold">
                    <input
                      type="radio"
                      name="auto-mode"
                      className="accent-sky-600"
                      checked={autoMode === item.key}
                      onChange={() => setAutoMode(item.key)}
                    />
                    <span>{item.label}</span>
                  </div>
                  <span className="text-[11px] text-slate-600 leading-tight">
                    {item.desc}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* 模型引擎 Engine */}
          <div>
            <label className="block font-bold text-slate-800 mb-1">
              默认模型引擎
            </label>
            <div className="grid grid-cols-3 gap-2">
              {ENGINES.map((item) => {
                const isClaude = item.key === "claude";
                const isAgy = item.key === "agy";
                const isCodex = item.key === "codex";
                const notInstalled =
                  (isClaude && claudeProbe && !claudeProbe.installed) ||
                  (isAgy && agyProbe && !agyProbe.installed) ||
                  (isCodex && codexProbe && !codexProbe.installed);
                const notReady =
                  (isAgy && agyProbe?.installed && !agyProbe?.ready) ||
                  (isCodex && codexProbe?.installed && !codexProbe?.ready);
                return (
                  <label
                    key={item.key}
                    className={clsx(
                      "flex items-center gap-2 p-2.5 rounded-lg border cursor-pointer transition",
                      autoEngine === item.key
                        ? "border-sky-500 bg-sky-50/70 text-sky-950 ring-1 ring-sky-400"
                        : "border-slate-300 hover:bg-slate-50 text-slate-800",
                    )}
                  >
                    <input
                      type="radio"
                      name="auto-engine"
                      className="accent-sky-600"
                      checked={autoEngine === item.key}
                      onChange={() => setAutoEngine(item.key)}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="font-bold text-xs flex items-center justify-between">
                        <span>{item.label}</span>
                        {notInstalled ? (
                          <span className="text-[9px] px-1 rounded bg-amber-100 text-amber-800 border border-amber-300 font-medium">
                            未安装
                          </span>
                        ) : notReady ? (
                          <span className="text-[9px] px-1 rounded bg-amber-100 text-amber-800 border border-amber-300 font-medium">
                            未配置
                          </span>
                        ) : (
                          <span className="text-[9px] px-1 rounded bg-emerald-50 text-emerald-800 border border-emerald-300 font-semibold">
                            ✓ 已就绪
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-600 truncate mt-0.5">
                        {item.desc || (isClaude
                          ? "Claude Code CLI 引擎"
                          : isAgy
                            ? "Antigravity CLI 引擎"
                            : "Codex CLI 引擎")}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          {/* 隔离分支 */}
          <div className="pt-1">
            <label className="flex items-center gap-2 cursor-pointer text-slate-800">
              <input
                type="checkbox"
                className="accent-emerald-600 rounded"
                checked={autoCreateBranch}
                onChange={(e) => setAutoCreateBranch(e.target.checked)}
              />
              <span className="font-bold">🌿 自动创建临时隔离分支</span>
              <span className="text-[11px] text-slate-600">
                （若为改代码或全自动模式，自动切出独立分支）
              </span>
            </label>
            <p className="text-[11px] text-slate-500 mt-1 pl-6 leading-relaxed">
              工作区必须干净：有未提交改动时会中止本次派发并把任务放回待处理，
              不会带着你没提交的改动切分支。
            </p>
          </div>

          {/* 力度自动提权 */}
          <div className="pt-1 border-t border-slate-200">
            <label className="flex items-center gap-2 cursor-pointer text-slate-800 mt-2">
              <input
                type="checkbox"
                className="accent-amber-600 rounded"
                checked={autoEscalate}
                onChange={(e) => setAutoEscalate(e.target.checked)}
              />
              <span className="font-bold">⚡ 按关键词自动提升执行力度</span>
            </label>
            <p className="text-[11px] text-slate-500 mt-1 pl-6 leading-relaxed">
              关闭时（默认），力度只由上面选的档位决定，飞书消息改不了它。
              开启后，话题里对方发来的新指令命中下列任一关键词，会把
              <strong>「只读分析」临时提升为「允许改代码」</strong>
              （最多升到这一级， 不会升到全自动）。
            </p>
            <input
              type="text"
              className="mt-1.5 ml-6 w-[calc(100%-1.5rem)] text-xs border border-slate-300 rounded px-2.5 py-1.5 bg-white text-slate-800 font-medium focus:outline-none focus:ring-1 focus:ring-amber-400 disabled:bg-slate-100 disabled:text-slate-400"
              placeholder="修改、改一下、实现、修复、写代码、接入、对接、重构"
              value={escalateKeywords}
              disabled={!autoEscalate}
              onChange={(e) => setEscalateKeywords(e.target.value)}
            />
            <p className="text-[11px] text-slate-400 mt-1 pl-6">
              用「、」或逗号、换行分隔。留空 = 不提升。词别设得太泛，
              像「处理」「更新」这种日常对话里几乎必中。
            </p>
          </div>

          {/* 发起人白名单 */}
          <div className="pt-2 border-t border-slate-200">
            <label className="block font-bold text-slate-800 mb-1">
              🔒 允许触发自动执行的人（open_id 白名单）
            </label>
            <textarea
              rows={2}
              className="w-full text-xs border border-slate-300 rounded px-2.5 py-1.5 bg-white text-slate-800 font-mono focus:outline-none focus:ring-1 focus:ring-rose-400"
              placeholder="留空 = 不限制（任何能给机器人发消息的人都能触发）&#10;ou_xxxxxxxx"
              value={allowedRequesters}
              onChange={(e) => setAllowedRequesters(e.target.value)}
            />
            <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">
              一行一个 open_id。配了之后，名单外的人照常能提需求入库，但
              <strong>不会自动拉起 AI</strong>——改代码 /
              全自动档下，自动派发等于
              「一条飞书消息可以直接改这台机器上的代码」。
            </p>
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="shrink-0 flex justify-end gap-2 px-4 py-3 border-t border-slate-200 bg-slate-50/50">
          <button
            type="button"
            className="text-xs px-3 py-1.5 rounded border border-slate-300 text-slate-700 hover:bg-slate-100 font-medium cursor-pointer"
            onClick={() => setAutoDispatchModalOpen(false)}
          >
            取消
          </button>
          <button
            type="button"
            className="text-xs px-3.5 py-1.5 rounded bg-indigo-600 hover:bg-indigo-700 text-white font-semibold cursor-pointer shadow-xs"
            onClick={() => {
              saveSettings({
                autoDispatchEnabled: true,
                autoDispatchCwd: autoCwd,
                autoDispatchMode: autoMode,
                autoDispatchEngine: autoEngine,
                autoDispatchCreateBranch: autoCreateBranch,
                autoEscalateMode: autoEscalate,
                escalateKeywords,
                allowedRequesters,
              });
              setAutoDispatchModalOpen(false);
              showToast("已保存并启用自动派发 AI 预设规则", "success");
            }}
          >
            保存并启用预设
          </button>
        </div>
      </Modal>

      {/* prompt 预览 */}
      <Modal
        open={Boolean(prompt)}
        onClose={() => setPrompt("")}
        title="生成的 prompt"
        srOnly={false}
        className="w-[720px] p-4"
      >
        <pre className="text-[12px] whitespace-pre-wrap break-words bg-slate-50 rounded p-3 max-h-[60vh] overflow-y-auto font-sans">
          {prompt}
        </pre>
        <p className="text-[11px] text-slate-400 mt-2">已复制到剪贴板。</p>
      </Modal>

      {/* AI 调用历史回看与记录弹窗 */}
      <JobHistoryModal
        open={historyModalOpen}
        onClose={() => setHistoryModalOpen(false)}
        historyList={historyList}
        total={historyTotal}
        selectedJobId={selectedJobId}
        selectedJobDetail={selectedJobDetail}
        onSelectJob={loadJobDetail}
        onDeleteJob={handleDeleteHistoryJob}
        onClearHistory={handleClearAllHistory}
        filterTaskId={historyFilterTaskId}
        onFilterTaskChange={(tid) => {
          setHistoryFilterTaskId(tid);
          fetchHistory({ taskId: tid });
        }}
        filterEngine={historyFilterEngine}
        onFilterEngineChange={(eng) => {
          setHistoryFilterEngine(eng);
          fetchHistory({ engine: eng });
        }}
        filterStatus={historyFilterStatus}
        onFilterStatusChange={(st) => {
          setHistoryFilterStatus(st);
          fetchHistory({ status: st });
        }}
      />

      {confirmDialog}
    </PageShell>
  );
}
