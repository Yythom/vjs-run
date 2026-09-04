import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import clsx from "../utils/clsx";
import {
  cancelDockingJob,
  clearLastRunDone,
  setActiveJobId,
  useDockingActiveJobId,
  useDockingJobLogs,
  useDockingLastRunDone,
  useDockingQueue,
  useDockingRun,
  useDockingTasks,
} from "../stores/docking-store";

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function DockingFloatingBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const queue = useDockingQueue();
  const jobLogs = useDockingJobLogs();
  const activeJobId = useDockingActiveJobId();
  const run = useDockingRun();
  const tasks = useDockingTasks();
  const lastRunDone = useDockingLastRunDone();

  const [now, setNow] = useState(() => Date.now());

  const runningJobs = useMemo(() => queue?.running || [], [queue?.running]);
  const queuedJobs = useMemo(() => queue?.queued || [], [queue?.queued]);
  const totalActive = runningJobs.length + queuedJobs.length;

  // 秒表计时刷新
  useEffect(() => {
    if (runningJobs.length === 0 && !run.running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [runningJobs.length, run.running]);

  // 完成提示 6 秒后自动隐去
  useEffect(() => {
    if (!lastRunDone) return;
    const timer = window.setTimeout(() => {
      clearLastRunDone();
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [lastRunDone]);

  // 选中的当前 Job（优先 activeJobId，若无取第一个 running 或 queued）
  const currentJob = useMemo(() => {
    if (activeJobId) {
      const found =
        runningJobs.find((j) => j.id === activeJobId) ||
        queuedJobs.find((j) => j.id === activeJobId);
      if (found) return found;
    }
    return runningJobs[0] || queuedJobs[0] || null;
  }, [activeJobId, runningJobs, queuedJobs]);

  // 获取当前正在处理的任务信息
  const activeTasks = useMemo(() => {
    if (currentJob) {
      return (currentJob.taskIds || [])
        .map((id) => tasks.find((t) => t.id === id))
        .filter(Boolean);
    }
    const ids = run.running ? run.taskIds : lastRunDone?.taskIds || [];
    return ids.map((id) => tasks.find((t) => t.id === id)).filter(Boolean);
  }, [currentJob, run.running, run.taskIds, lastRunDone, tasks]);

  // 当前 Job 的最新一条日志
  const latestLog = useMemo(() => {
    if (!currentJob) return null;
    const logs = jobLogs[currentJob.id];
    if (!logs || logs.length === 0) return null;
    const last = logs[logs.length - 1];
    return last?.text || "";
  }, [currentJob, jobLogs]);

  const handleOpenDetails = () => {
    const isOtherRoute = location.pathname !== "/docking";
    if (isOtherRoute) {
      navigate("/docking");
    }
    const taskId =
      currentJob?.taskIds?.[0] ||
      lastRunDone?.taskIds?.[0] ||
      activeTasks[0]?.id;
    if (taskId) {
      setTimeout(
        () => {
          const el = document.getElementById(`task-card-${taskId}`);
          if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            el.classList.add("ring-2", "ring-sky-400");
            setTimeout(
              () => el.classList.remove("ring-2", "ring-sky-400"),
              2000,
            );
          }
        },
        isOtherRoute ? 250 : 50,
      );
    }
  };

  // 既没有活跃任务也没有完成提示，不渲染
  if (totalActive === 0 && !run.running && !lastRunDone) {
    return null;
  }

  const isRunning = currentJob ? currentJob.status === "running" : run.running;
  const isQueued = currentJob?.status === "queued";

  const elapsed =
    isRunning && currentJob?.startTime
      ? Math.max(0, Math.floor((now - currentJob.startTime) / 1000))
      : isRunning && run.startTime
        ? Math.max(0, Math.floor((now - run.startTime) / 1000))
        : 0;

  const activeEngine = currentJob?.engine || lastRunDone?.engine || run.engine || "claude";
  const engineLabel =
    activeEngine === "agy"
      ? "Antigravity"
      : activeEngine === "codex"
        ? "Codex"
        : "Claude Code";

  const taskTitleText =
    activeTasks.length === 1
      ? `#${activeTasks[0].seq} ${activeTasks[0].title}`
      : activeTasks.length > 1
        ? `批量处理 ${activeTasks.length} 条需求`
        : "需求处理中…";

  const modifiedCount = currentJob
    ? currentJob.modifiedFiles?.length || 0
    : run.running
      ? run.modifiedFiles?.length || 0
      : lastRunDone?.modifiedFiles?.length || 0;

  return (
    <div className="fixed bottom-4 right-4 z-50 animate-in fade-in slide-in-from-bottom-3 duration-200 select-none">
      <div className="flex flex-col gap-2 px-3.5 py-2.5 rounded-xl bg-slate-900/94 backdrop-blur-md border border-slate-700/70 shadow-2xl text-white min-w-[360px] max-w-[500px]">
        {/* 多任务切换 Tab 栏 */}
        {totalActive > 1 && (
          <div className="flex items-center gap-1.5 pb-1 border-b border-slate-800 overflow-x-auto text-[10px]">
            <span className="text-slate-400 font-medium shrink-0">
              队列 ({runningJobs.length} 运行 · {queuedJobs.length} 排队):
            </span>
            {runningJobs.map((j, idx) => {
              const firstTask = tasks.find((t) => t.id === j.taskIds[0]);
              const label = firstTask ? `#${firstTask.seq}` : `Job ${idx + 1}`;
              const isSelected = currentJob?.id === j.id;
              return (
                <button
                  key={j.id}
                  type="button"
                  className={clsx(
                    "px-1.5 py-0.5 rounded cursor-pointer transition flex items-center gap-1",
                    isSelected
                      ? "bg-emerald-900/80 text-emerald-300 border border-emerald-600 font-medium"
                      : "bg-slate-800 text-slate-400 hover:text-slate-200 border border-slate-700",
                  )}
                  onClick={() => setActiveJobId(j.id)}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  <span>{label}</span>
                </button>
              );
            })}
            {queuedJobs.map((j, idx) => {
              const firstTask = tasks.find((t) => t.id === j.taskIds[0]);
              const label = firstTask ? `#${firstTask.seq}` : `Queued ${idx + 1}`;
              const isSelected = currentJob?.id === j.id;
              return (
                <button
                  key={j.id}
                  type="button"
                  className={clsx(
                    "px-1.5 py-0.5 rounded cursor-pointer transition flex items-center gap-1",
                    isSelected
                      ? "bg-amber-950/80 text-amber-300 border border-amber-600 font-medium"
                      : "bg-slate-800 text-slate-400 hover:text-slate-200 border border-slate-700",
                  )}
                  onClick={() => setActiveJobId(j.id)}
                >
                  <span className="text-[9px]">⏳</span>
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* 主行信息 */}
        <div className="flex items-center gap-3">
          {/* 左侧状态图标 */}
          <div className="shrink-0 flex items-center justify-center">
            {isRunning ? (
              <div className="relative flex items-center justify-center w-6 h-6">
                <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-30 animate-ping" />
                <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500 shadow-sm" />
              </div>
            ) : isQueued ? (
              <span className="text-amber-400 text-base">⏳</span>
            ) : lastRunDone?.code === 0 ? (
              <span className="text-emerald-400 text-base">✅</span>
            ) : (
              <span className="text-rose-400 text-base">⚠️</span>
            )}
          </div>

          {/* 中间信息区 */}
          <div className="min-w-0 flex-1 flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5 text-xs">
              <span className="font-semibold text-slate-100 truncate max-w-[180px]">
                {taskTitleText}
              </span>
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-800 text-sky-400 border border-slate-700 shrink-0 font-medium">
                {engineLabel}
              </span>
              {isRunning && (
                <span className="text-[11px] text-slate-400 font-mono shrink-0 ml-auto mr-1">
                  ⏱ {formatDuration(elapsed)}
                </span>
              )}
              {isQueued && (
                <span className="text-[11px] text-amber-400 font-medium shrink-0 ml-auto mr-1">
                  等待执行槽位…
                </span>
              )}
            </div>

            <div className="text-[11px] text-slate-400 truncate flex items-center gap-1.5">
              {isRunning ? (
                <>
                  <span className="truncate">
                    {latestLog ? `▸ ${latestLog}` : "正在分析需求链路…"}
                  </span>
                  {modifiedCount > 0 && (
                    <span className="shrink-0 text-[10px] text-emerald-400 bg-emerald-950/60 border border-emerald-800 px-1 py-0.2 rounded">
                      改动 {modifiedCount}
                    </span>
                  )}
                </>
              ) : isQueued ? (
                <span>排队中（Repo 互斥锁或并发等待中）</span>
              ) : (
                <span>
                  {lastRunDone?.code === 0
                    ? `处理完成${modifiedCount > 0 ? ` · 已修改 ${modifiedCount} 个文件` : ""}`
                    : `异常退出 (${lastRunDone?.code})`}
                </span>
              )}
            </div>
          </div>

          {/* 右侧操作按钮 */}
          <div className="shrink-0 flex items-center gap-1.5 ml-1">
            <button
              type="button"
              className="text-[11px] px-2.5 py-1 rounded-md bg-sky-600 hover:bg-sky-500 text-white font-medium transition cursor-pointer shadow-xs"
              onClick={handleOpenDetails}
            >
              {isRunning || isQueued ? "查看" : "详情"}
            </button>
            {currentJob ? (
              <button
                type="button"
                className="text-[11px] px-2 py-1 rounded-md border border-slate-700 hover:bg-rose-900/40 text-rose-400 hover:text-rose-300 font-medium transition cursor-pointer"
                title={isQueued ? "取消排队" : "中断执行"}
                onClick={() => cancelDockingJob(currentJob.id)}
              >
                {isQueued ? "取消" : "中断"}
              </button>
            ) : totalActive === 0 && lastRunDone ? (
              <button
                type="button"
                className="text-slate-400 hover:text-slate-200 px-1.5 py-1 text-xs cursor-pointer"
                title="关闭"
                onClick={clearLastRunDone}
              >
                ✕
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
