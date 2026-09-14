import { memo } from "react";
import clsx from "../../utils/clsx";
import { showToast } from "../../utils/toast";
import { useJobLatestLogText } from "../../stores/docking-store";
import ElapsedTime from "../../components/elapsed-time";
import { RUN_MODES, STATUS_BADGE } from "./constants";
import { formatTime } from "./utils";

// ─── 单条任务卡片 ────────────────────────────────────────────────────────────
function TaskCard({
  task,
  checked,
  onToggle,
  onRun,
  onViewHistory,
  runningJob,
  queuedJob,
  onCancelJob,
  onOpenThread,
  onViewPlan,
}) {
  // 只订阅本卡片对应 Job 的最新一行日志，而不是页面级的整张 jobLogs 表
  const latestLog = useJobLatestLogText(runningJob?.id);
  const badge = STATUS_BADGE[task.status] || STATUS_BADGE.inbox;
  const clarifications = (task.thread || []).slice(1);

  return (
    <div
      id={`task-card-${task.id}`}
      className="border border-border rounded-lg bg-white overflow-hidden shadow-2xs transition"
    >
      <div className="flex items-start gap-3 p-3">
        <input
          type="checkbox"
          className="mt-1 shrink-0 accent-sky-600 cursor-pointer"
          checked={checked}
          onChange={() => onToggle(task.id)}
        />
        {/* 这块可点区域里还嵌着「调用历史」按钮，所以不能用 <button>——
            button 套 button 是非法嵌套。用 div + role/tabIndex 自己补键盘可达性 */}
        <div
          role="button"
          tabIndex={0}
          className="min-w-0 flex-1 text-left cursor-pointer"
          title="点击查看完整话题往来与答复"
          onClick={() => onOpenThread(task)}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onOpenThread(task);
            }
          }}
        >
          <div className="flex items-center gap-2 flex-wrap">
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
              <span className="shrink-0 text-[10px] px-2 py-0.5 rounded-full border border-emerald-300 bg-emerald-50 text-emerald-800 font-medium flex items-center gap-1.5 shadow-2xs">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 animate-pulse" />
                <span className="font-semibold">AI 处理中</span>
                <span className="font-mono text-emerald-700">
                  (<ElapsedTime startTime={runningJob.startTime} />)
                </span>
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
          <div className="mt-1.5 flex items-center gap-2 text-[11px] text-slate-600 truncate flex-wrap">
            <span className="font-mono font-semibold text-slate-800">
              #{task.seq}
            </span>
            {/* 需求池工作包：扫列表时要一眼分得出它跟 IM 提问不是一回事，所以紧跟短号 */}
            {task.workpackDir && (
              <span
                className="shrink-0 text-[10px] text-indigo-900 bg-indigo-50 border border-indigo-300 px-1.5 py-0.5 rounded font-medium flex items-center gap-0.5 cursor-pointer"
                title={`需求池工作包：${task.workpackDir}\n（点击复制路径）`}
                onClick={(e) => {
                  e.stopPropagation();
                  navigator.clipboard.writeText(task.workpackDir);
                  showToast("已复制工作包路径", "success");
                }}
              >
                <span>📐</span>
                <span>工作包</span>
              </span>
            )}
            {task.workpackDir && (
              <button
                type="button"
                className="shrink-0 text-[10px] text-sky-800 bg-sky-50 border border-sky-300 hover:bg-sky-100 px-1.5 py-0.5 rounded font-medium flex items-center gap-0.5 cursor-pointer"
                title="查看 AI 写出的实施 plan（plan.md 在软件目录的工作包里，不在代码库）"
                onClick={(e) => {
                  e.stopPropagation();
                  onViewPlan(task);
                }}
              >
                <span>📄</span>
                <span>查看 plan</span>
              </button>
            )}
            <span className="text-slate-300">·</span>
            <span className="text-slate-800 font-medium">
              {task.requester?.name || task.requester?.id || "未知发起人"}
            </span>
            <span className="text-slate-300">·</span>
            <span className="text-slate-500">{formatTime(task.createdAt)}</span>
            {runningJob && (
              <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-emerald-200 bg-emerald-50/60 text-emerald-900 font-medium">
                {runningJob.engine === "agy"
                  ? "Antigravity"
                  : runningJob.engine === "codex"
                    ? "Codex"
                    : "Claude Code"}{" "}
                ·{" "}
                {RUN_MODES.find((m) => m.key === runningJob.mode)?.label ||
                  runningJob.mode}
              </span>
            )}
            {runningJob && latestLog && (
              <span
                className="shrink-0 text-[10px] text-emerald-800 bg-emerald-50/90 border border-emerald-200 px-1.5 py-0.5 rounded font-mono truncate max-w-[260px]"
                title={latestLog}
              >
                ▸ {latestLog}
              </span>
            )}
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
        </div>

        {/* 主操作放在收起态就能点到的位置，不用先展开 */}
        {runningJob ? (
          <button
            type="button"
            className="shrink-0 text-[11px] px-2.5 py-1.5 rounded border border-rose-300 bg-rose-50 hover:bg-rose-100 text-rose-700 cursor-pointer font-medium transition shadow-2xs flex items-center gap-1"
            title="中断当前正在执行的 AI 任务"
            onClick={(e) => {
              e.stopPropagation();
              onCancelJob(runningJob.id);
            }}
          >
            <span>⏹</span>
            <span>中断任务</span>
          </button>
        ) : queuedJob ? (
          <button
            type="button"
            className="shrink-0 text-[11px] px-2.5 py-1.5 rounded border border-amber-300 hover:bg-amber-50 text-amber-700 cursor-pointer font-medium"
            onClick={(e) => {
              e.stopPropagation();
              onCancelJob(queuedJob.id);
            }}
          >
            取消排队
          </button>
        ) : (
          <button
            type="button"
            className="shrink-0 text-[11px] px-2.5 py-1.5 rounded bg-sky-600 text-white hover:bg-sky-700 cursor-pointer font-medium"
            onClick={(e) => {
              e.stopPropagation();
              onRun(task);
            }}
          >
            交给 AI
          </button>
        )}
      </div>

    </div>
  );
}

/**
 * memo 起来：列表里最多几十张卡，页面上任何一处 state 变动（搜索框打字、
 * 筛选切换、历史面板加载）都不该带着它们全部重渲染一遍。
 * 前提是父组件传进来的回调引用稳定——见 use-event-callback。
 */
export default memo(TaskCard);
