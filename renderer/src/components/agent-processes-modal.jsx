import { useEffect, useMemo, useState } from "react";
import Modal from "./modal";
import clsx from "../utils/clsx";
import { showToast } from "../utils/toast";
import {
  cancelDockingJob,
  loadQueueStatus,
  stopRun,
  useDockingQueue,
  useDockingTasks,
  useJobLatestLogText,
} from "../stores/docking-store";

// 超过这么久没有新日志，就认为这个 Agent 已经不在干活了。
// claude / codex 正常跑的时候日志是持续在出的，几分钟一声不吭基本就是卡住了
// （等一个永远不会来的输入、被文件锁堵住、网络挂起…）
const STALE_MS = 5 * 60 * 1000;

const ENGINE_LABEL = { agy: "Antigravity", claude: "Claude Code", codex: "Codex" };
const MODE_LABEL = { analyze: "只读分析", edit: "允许改代码", full: "全自动" };

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function JobRow({ job, tasks, now, onKill, onLocate, killing }) {
  // 每行只订阅自己那个 job 的最新日志。父组件订阅整张 jobLogs 表的话，
  // 任意一个 job 出一行日志就要把所有行重渲染一遍
  const latestLog = useJobLatestLogText(job.id) ?? "";
  const isQueued = job.status === "queued";
  const jobTasks = (job.taskIds || [])
    .map((id) => tasks.find((t) => t.id === id))
    .filter(Boolean);
  const title =
    jobTasks.length === 1
      ? `#${jobTasks[0].seq} ${jobTasks[0].title}`
      : jobTasks.length > 1
        ? `批量处理 ${jobTasks.length} 条需求`
        : "（任务已被删除）";

  // 还没出过日志的按启动时间算，否则刚起步的 job 会被误判成卡住
  const silentSince = job.lastLogAt || job.startTime || 0;
  const silentMs = silentSince ? now - silentSince : 0;
  const isStale = !isQueued && silentSince > 0 && silentMs > STALE_MS;

  return (
    <div
      className={clsx(
        "flex flex-col gap-1.5 px-3 py-2.5 rounded-lg border",
        isStale
          ? "border-amber-300 bg-amber-50"
          : "border-border bg-white",
      )}
    >
      <div className="flex items-center gap-2">
        {isQueued ? (
          <span className="text-amber-500 text-xs shrink-0">⏳</span>
        ) : (
          <span
            className={clsx(
              "w-2 h-2 rounded-full shrink-0",
              isStale ? "bg-amber-500" : "bg-emerald-500 animate-pulse",
            )}
          />
        )}
        <span className="text-xs font-semibold text-slate-800 truncate flex-1 min-w-0">
          {title}
        </span>
        {isStale && (
          <span className="text-[10px] px-1.5 py-[1px] rounded bg-amber-100 text-amber-700 border border-amber-300 font-medium shrink-0">
            疑似挂起
          </span>
        )}
        {jobTasks.length > 0 && (
          <button
            type="button"
            className="text-[11px] px-2 py-1 rounded border border-border text-slate-600 bg-white hover:bg-slate-50 font-medium transition cursor-pointer shrink-0"
            title="在列表中定位到这条需求"
            onClick={() => onLocate(jobTasks[0].id)}
          >
            定位
          </button>
        )}
        <button
          type="button"
          disabled={killing}
          className={clsx(
            "text-[11px] px-2 py-1 rounded border font-medium transition shrink-0",
            killing
              ? "border-border text-slate-400 cursor-not-allowed"
              : "border-rose-200 text-rose-600 bg-rose-50 hover:bg-rose-100 cursor-pointer",
          )}
          onClick={() => onKill(job.id)}
        >
          {killing ? "终止中…" : isQueued ? "取消排队" : "终止进程"}
        </button>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap text-[10px] text-slate-500">
        <span className="px-1.5 py-[1px] rounded bg-slate-100 border border-slate-200 text-sky-700 font-medium">
          {ENGINE_LABEL[job.engine] || job.engine}
        </span>
        <span className="px-1.5 py-[1px] rounded bg-slate-100 border border-slate-200">
          {MODE_LABEL[job.mode] || job.mode}
        </span>
        {job.pid > 0 && (
          <span className="px-1.5 py-[1px] rounded bg-slate-100 border border-slate-200 font-mono">
            PID {job.pid}
          </span>
        )}
        {job.branchName && (
          <span className="px-1.5 py-[1px] rounded bg-slate-100 border border-slate-200 font-mono truncate max-w-[180px]">
            🌿 {job.branchName}
          </span>
        )}
        {!isQueued && job.startTime > 0 && (
          <span className="font-mono">⏱ {formatDuration(now - job.startTime)}</span>
        )}
        {job.modifiedFiles?.length > 0 && (
          <span className="px-1.5 py-[1px] rounded bg-emerald-50 border border-emerald-200 text-emerald-700 font-medium">
            改动 {job.modifiedFiles.length}
          </span>
        )}
      </div>

      <div className="text-[10px] text-slate-400 font-mono truncate" title={job.cwd}>
        {job.cwd || "（未指定 repo）"}
      </div>

      <div
        className={clsx(
          "text-[11px] truncate",
          isStale ? "text-amber-700" : "text-slate-500",
        )}
      >
        {isQueued
          ? "排队中 · 等待执行槽位（repo 互斥锁或并发上限）"
          : isStale
            ? `已 ${formatDuration(silentMs)} 没有任何输出${
                latestLog ? ` · 最后一条：${latestLog}` : ""
              }`
            : latestLog
              ? `▸ ${latestLog}`
              : "正在启动…"}
      </div>
    </div>
  );
}

/**
 * 「Agent 进程」面板：把当前还占着 CLI 子进程的 job 摊开列出来，逐条可终止。
 *
 * 存在的意义是卡住的那种情况——job 还挂在队列里占着并发名额和 repo 锁，
 * 面板上的任务一直是「进行中」，但底下的 claude / codex 其实早就不出声了。
 * 光看任务列表看不出这件事，所以这里显式标出静默时长和 PID。
 */
export default function AgentProcessesModal({ onClose }) {
  const queue = useDockingQueue();
  const tasks = useDockingTasks();
  const [now, setNow] = useState(() => Date.now());
  const [killingId, setKillingId] = useState("");
  const [killingAll, setKillingAll] = useState(false);

  const runningJobs = useMemo(() => queue?.running || [], [queue?.running]);
  const queuedJobs = useMemo(() => queue?.queued || [], [queue?.queued]);
  const allJobs = useMemo(
    () => [...runningJobs, ...queuedJobs],
    [runningJobs, queuedJobs],
  );

  // 挂载期间自己刷：lastLogAt / pid 都在 queue 里，事件推送之外再兜一层轮询，
  // 免得进程静默时列表上的时长也跟着不动。
  // 组件由调用方按 open 条件挂载，所以这里不用再判断 open——关掉即卸载，
  // 定时器和 queue / 日志订阅一起消失。
  useEffect(() => {
    const tick = () => {
      setNow(Date.now());
      loadQueueStatus();
    };
    const first = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);

  // 关掉面板并把对应的需求卡滚到视野中央闪一下。
  // 这是原来全局悬浮条上的「查看」，面板本来就开在赛博牛马页里，同页滚动即可
  const handleLocate = (taskId) => {
    onClose();
    window.setTimeout(() => {
      const el = document.getElementById(`task-card-${taskId}`);
      // 卡片可能被当前筛选挡住（跑着的任务是 doing，而默认页签是 inbox）
      if (!el) {
        showToast("该需求不在当前筛选结果里，切到「全部」再看", "warning");
        return;
      }
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("ring-2", "ring-sky-400");
      window.setTimeout(() => el.classList.remove("ring-2", "ring-sky-400"), 2000);
    }, 80);
  };

  const handleKill = async (jobId) => {
    setKillingId(jobId);
    try {
      await cancelDockingJob(jobId);
      await loadQueueStatus();
    } finally {
      setKillingId("");
    }
  };

  const handleKillAll = async () => {
    setKillingAll(true);
    try {
      await stopRun();
      await loadQueueStatus();
    } finally {
      setKillingAll(false);
    }
  };

  const staleCount = runningJobs.filter((j) => {
    const since = j.lastLogAt || j.startTime || 0;
    return since > 0 && now - since > STALE_MS;
  }).length;

  return (
    <Modal
      open
      onClose={onClose}
      title="Agent 进程"
      srOnly={false}
      className="w-[640px] max-h-[80vh]"
      headerAction={
        allJobs.length > 0 && (
          <button
            type="button"
            disabled={killingAll}
            className={clsx(
              "text-xs px-2.5 py-1 rounded border font-medium transition",
              killingAll
                ? "border-border text-slate-400 cursor-not-allowed"
                : "border-rose-200 text-rose-600 bg-rose-50 hover:bg-rose-100 cursor-pointer",
            )}
            onClick={handleKillAll}
          >
            {killingAll ? "终止中…" : "全部终止"}
          </button>
        )
      }
    >
      <div className="px-4 py-2 border-b border-border text-[11px] text-slate-500 shrink-0">
        {allJobs.length === 0
          ? "当前没有任务占用 Agent 进程"
          : `${runningJobs.length} 个在跑 · ${queuedJobs.length} 个排队${
              staleCount > 0 ? ` · ${staleCount} 个疑似挂起` : ""
            }`}
      </div>

      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2 min-h-[120px]">
        {allJobs.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-xs text-slate-400 py-8">
            没有正在运行或排队的 Agent
          </div>
        ) : (
          allJobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              tasks={tasks}
              now={now}
              onKill={handleKill}
              onLocate={handleLocate}
              killing={killingId === job.id}
            />
          ))
        )}
      </div>

      <div className="px-4 py-2.5 border-t border-border text-[10px] text-slate-400 leading-relaxed">
        终止会对整个进程组发信号（SIGTERM，10 秒不退补 SIGKILL），CLI 自己拉起来的
        子进程会一并收掉。任务状态会退回「待处理」，可以重新派。
      </div>
    </Modal>
  );
}
