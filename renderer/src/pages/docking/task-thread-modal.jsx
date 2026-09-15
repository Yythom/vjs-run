import clsx from "../../utils/clsx";
import Modal from "../../components/modal";
import { showToast } from "../../utils/toast";
import {
  patchTask,
  useJobForTask,
  useTaskById,
} from "../../stores/docking-store";
import { RUN_MODES, STATUS_BADGE } from "./constants";
import { formatTime } from "./utils";
import WorktreePanel from "./worktree-panel";

// ─── 话题详情弹窗 ────────────────────────────────────────────────────────────
/**
 * 一条需求的完整来往：附件、多轮对话流、改动文件、动作栏。
 *
 * 原来是在卡片里内联展开的，一条聊了十几轮的任务能把列表撑到看不到别的，
 * 想比对两条需求还得先把上一条收起来。改成近全屏弹窗后长对话自己滚，
 * 列表始终保持一屏能扫完的密度。
 */
export default function TaskThreadModal({
  taskId,
  onClose,
  onAsk,
  onReplySolution,
  onRun,
  onDelete,
  onCancelJob,
  onViewHistory,
}) {
  // 接 id 而不是 task 快照：任务被 AI 回写后这里跟着更新，
  // 同时页面不必为了查这一条而订阅整个 tasks 数组
  const task = useTaskById(taskId);
  const runningJob = useJobForTask(taskId, "running");

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
      open
      onClose={onClose}
      title={`#${task.seq} ${task.title}`}
      srOnly={false}
      className="w-[1080px] max-w-[95vw] h-[88vh] p-0"
      headerAction={
        <div className="flex items-center gap-1.5 mr-1">
          <span
            className={clsx(
              "text-[10px] px-1.5 py-0.5 rounded border",
              badge.cls,
            )}
          >
            {badge.text}
          </span>
          {onViewHistory && (
            <button
              type="button"
              className="text-[10px] text-slate-700 hover:text-sky-800 bg-slate-100 hover:bg-sky-50 border border-slate-300 hover:border-sky-300 px-2 py-0.5 rounded font-medium transition cursor-pointer flex items-center gap-1"
              title="查看该需求的历次 AI 调用历史记录（指令与结果）"
              onClick={() => onViewHistory(task.id)}
            >
              <span>📜</span>
              <span>调用历史</span>
            </button>
          )}
        </div>
      }
    >
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3.5 space-y-3">
        {/* 正在执行状态横幅 */}
        {runningJob && (
          <div className="rounded-lg bg-emerald-50/80 border border-emerald-300 p-2.5 flex items-center justify-between text-emerald-900 shadow-2xs">
            <div className="flex items-center gap-2 text-xs flex-wrap">
              <span className="w-2 h-2 rounded-full bg-emerald-600 animate-pulse shrink-0" />
              <span className="font-bold">⚡ AI 正在后台分析处理中</span>
              <span className="text-emerald-700 font-medium">
                ({runningJob.engine === "agy" ? "Antigravity" : runningJob.engine === "codex" ? "Codex" : "Claude Code"} · {RUN_MODES.find((m) => m.key === runningJob.mode)?.label || runningJob.mode})
              </span>
              {runningJob.branchName && (
                <span className="font-mono text-[11px] bg-white border border-emerald-300 px-1.5 py-0.5 rounded text-emerald-800">
                  🌿 {runningJob.branchName}
                </span>
              )}
            </div>
            <button
              type="button"
              className="text-xs px-2.5 py-1 rounded border border-rose-300 bg-white hover:bg-rose-50 text-rose-700 font-semibold cursor-pointer shadow-2xs transition shrink-0"
              onClick={() => onCancelJob?.(runningJob.id)}
            >
              中断执行
            </button>
          </div>
        )}
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
              title={
                task.worktreePath
                  ? `隔离分支: ${task.branchName}\nworktree: ${task.worktreePath}\n（点击复制 worktree 路径）`
                  : `隔离分支: ${task.branchName} (点击复制)`
              }
              onClick={() => {
                const text = task.worktreePath || task.branchName;
                navigator.clipboard.writeText(text);
                showToast(
                  task.worktreePath ? "已复制 worktree 路径" : `已复制分支: ${text}`,
                  "success",
                );
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
              className="text-[11px] px-2 py-[2px] rounded bg-white hover:bg-sky-100 text-slate-700 hover:text-sky-800 border border-sky-200 font-mono transition flex items-center gap-1 cursor-pointer"
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
                        const realIdx = newThread.findIndex(
                          (t) =>
                            t.at === entry.at && t.text === entry.text,
                        );
                        if (realIdx >= 0) newThread.splice(realIdx, 1);
                        const patch = { thread: newThread };
                        if (task.note && entry.text === task.note) {
                          patch.note = "";
                        }
                        patchTask(task.id, patch);
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
                        const realIdx = newThread.findIndex(
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
                      const realIdx = newThread.findIndex(
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

      {/* 隔离 worktree 现状与清理 */}
      {task.branchName && task.repoPath && (
        <div className="px-4 pb-3 shrink-0">
          <WorktreePanel task={task} busy={Boolean(runningJob)} />
        </div>
      )}

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

