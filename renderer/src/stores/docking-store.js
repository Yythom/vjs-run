import { create } from "zustand";

/**
 * 赛博牛马 store。任务真身落在主进程的 docking-tasks.json，这里只做镜像：
 * 打开面板时 loadTasks 拉一次，之后由主进程推 docking-task / docking-status 增量更新。
 */

const useDockingStore = create(() => ({
  tasks: [],
  status: { running: false, retrying: false, lastError: "" },
  settings: {
    ackEnabled: true,
    notifyOnComplete: true,
    createBranch: false,
    autoResumeOnClarification: true,
    autoDispatchEnabled: false,
    autoDispatchCwd: "auto",
    autoDispatchMode: "analyze",
    autoDispatchEngine: "claude",
    autoDispatchCreateBranch: true,
    lastCwd: "",
    runMode: "analyze",
    runEngine: "claude",
  },
  // 并发调度队列与任务池
  queue: {
    running: [],
    queued: [],
    history: [],
  },
  // 独立 Job 日志池：{ [jobId]: LogEntry[] }
  jobLogs: {},
  // 当前聚焦查看的 Job ID
  activeJobId: null,
  // 自动处理的运行态与过程日志（向下兼容）
  run: {
    running: false,
    taskIds: [],
    cwd: "",
    engine: "claude",
    mode: "analyze",
    startTime: 0,
    modifiedFiles: [],
  },
  runLog: [],
  // 控制 AI 处理运行弹窗（全局悬浮条可唤起）
  runModalOpen: false,
  runTargets: [],
  // 刚执行完成的运行摘要（供悬浮条展示几秒）
  lastRunDone: null,
  // 勾选态只活在渲染层：它是「这一次要派给模型哪几条」的临时选择，不值得落盘
  selectedIds: [],
}));

export const useDockingTasks = () => useDockingStore((s) => s.tasks);
export const useDockingStatus = () => useDockingStore((s) => s.status);
export const useDockingSelectedIds = () => useDockingStore((s) => s.selectedIds);
export const useDockingSettings = () => useDockingStore((s) => s.settings);
export const useDockingQueue = () => useDockingStore((s) => s.queue);
export const useDockingJobLogs = () => useDockingStore((s) => s.jobLogs);
export const useDockingActiveJobId = () => useDockingStore((s) => s.activeJobId);
export const useDockingRun = () => useDockingStore((s) => s.run);
export const useDockingRunLog = () => useDockingStore((s) => s.runLog);
export const useDockingRunModalOpen = () => useDockingStore((s) => s.runModalOpen);
export const useDockingRunTargets = () => useDockingStore((s) => s.runTargets);
export const useDockingLastRunDone = () => useDockingStore((s) => s.lastRunDone);

export function setActiveJobId(jobId) {
  useDockingStore.setState({ activeJobId: jobId || null });
}

export function setRunModalOpen(open) {
  useDockingStore.setState({ runModalOpen: Boolean(open) });
}

export function setRunTargets(targets) {
  useDockingStore.setState({ runTargets: targets || [] });
}

export function clearLastRunDone() {
  useDockingStore.setState({ lastRunDone: null });
}

export function clearJobLogs(jobId) {
  if (!jobId) return;
  useDockingStore.setState((s) => {
    const next = { ...s.jobLogs };
    delete next[jobId];
    return { jobLogs: next };
  });
}

function upsert(task) {
  if (!task) return;
  useDockingStore.setState((s) => {
    const index = s.tasks.findIndex((t) => t.id === task.id);
    if (index === -1) return { tasks: [task, ...s.tasks] };
    const tasks = [...s.tasks];
    tasks[index] = task;
    return { tasks };
  });
}

export async function loadTasks() {
  const result = await window.electronAPI.dockingListTasks();
  if (result?.success) {
    useDockingStore.setState({ tasks: result.tasks || [] });
  }
  return result;
}

export async function createTask(payload) {
  const result = await window.electronAPI.dockingAddTask(payload);
  if (result?.success && result.task) {
    upsert(result.task);
  }
  return result;
}

export async function loadStatus() {
  const result = await window.electronAPI.dockingGetStatus();
  if (result?.success) useDockingStore.setState({ status: result.status });
  return result;
}

export async function loadSettings() {
  const result = await window.electronAPI.dockingGetSettings();
  if (result?.success) useDockingStore.setState({ settings: result.settings });
  return result;
}

export async function probeLark() {
  if (!window.electronAPI?.dockingProbe) return null;
  const result = await window.electronAPI.dockingProbe();
  return result?.probe || null;
}

export async function probeClaude() {
  if (!window.electronAPI?.dockingClaudeProbe) return null;
  const result = await window.electronAPI.dockingClaudeProbe();
  return result?.probe || null;
}

export async function probeCodex() {
  if (!window.electronAPI?.dockingCodexProbe) return null;
  const result = await window.electronAPI.dockingCodexProbe();
  return result?.probe || null;
}

export async function installDockingCli(name) {
  if (!window.electronAPI?.dockingInstallCli) return null;
  return window.electronAPI.dockingInstallCli(name);
}

export async function saveSettings(patch) {
  const result = await window.electronAPI.dockingSetSettings(patch);
  if (result?.success) useDockingStore.setState({ settings: result.settings });
  return result;
}

export async function startListening() {
  const result = await window.electronAPI.dockingStart();
  if (result?.success) useDockingStore.setState({ status: result.status });
  return result;
}

export async function stopListening() {
  const result = await window.electronAPI.dockingStop();
  if (result?.success) useDockingStore.setState({ status: result.status });
  return result;
}

export function clearRunLog() {
  useDockingStore.setState({ runLog: [] });
}

export async function loadQueueStatus() {
  if (!window.electronAPI?.dockingQueueStatus) return null;
  const result = await window.electronAPI.dockingQueueStatus();
  if (result?.success) useDockingStore.setState({ queue: result.queue });
  return result;
}

export async function cancelDockingJob(jobId) {
  if (!window.electronAPI?.dockingJobCancel) return null;
  const result = await window.electronAPI.dockingJobCancel(jobId);
  if (result?.success && result.queue) {
    useDockingStore.setState({ queue: result.queue });
  }
  return result;
}

export async function startRun(ids, cwd, mode, engine, createBranch = false) {
  const result = await window.electronAPI.dockingRunStart(
    ids,
    cwd,
    mode,
    engine,
    createBranch,
  );
  if (result?.success) {
    if (result.jobId) useDockingStore.setState({ activeJobId: result.jobId });
    if (result.queue) useDockingStore.setState({ queue: result.queue });
  }
  return result;
}

export async function stopRun(jobId) {
  const result = await window.electronAPI.dockingRunStop(jobId);
  if (result?.success) {
    loadQueueStatus();
  }
  return result;
}

export async function loadRunStatus() {
  loadQueueStatus();
  const result = await window.electronAPI.dockingRunStatus();
  if (result?.success) useDockingStore.setState({ run: result.run });
  return result;
}

export async function patchTask(id, patch) {
  const result = await window.electronAPI.dockingUpdateTask(id, patch);
  if (result?.success) upsert(result.task);
  return result;
}

export async function removeTask(id) {
  const result = await window.electronAPI.dockingDeleteTask(id);
  if (result?.success) {
    useDockingStore.setState((s) => ({
      tasks: s.tasks.filter((t) => t.id !== id),
      selectedIds: s.selectedIds.filter((sid) => sid !== id),
    }));
  }
  return result;
}

export async function removeTasks(ids) {
  const result = await window.electronAPI.dockingDeleteTasks(ids);
  if (result?.success) {
    const gone = new Set(ids);
    useDockingStore.setState((s) => ({
      tasks: s.tasks.filter((t) => !gone.has(t.id)),
      selectedIds: s.selectedIds.filter((id) => !gone.has(id)),
    }));
  }
  return result;
}

export async function askRequester(id, question) {
  const result = await window.electronAPI.dockingAsk(id, question);
  if (result?.success) upsert(result.task);
  return result;
}

export async function replySolution(id, text, markDone = false) {
  const result = await window.electronAPI.dockingReplySolution(id, text, markDone);
  if (result?.success) upsert(result.task);
  return result;
}

export function toggleSelected(id) {
  useDockingStore.setState((s) => ({
    selectedIds: s.selectedIds.includes(id)
      ? s.selectedIds.filter((sid) => sid !== id)
      : [...s.selectedIds, id],
  }));
}

export function setSelectedIds(ids) {
  useDockingStore.setState({ selectedIds: ids });
}

export function clearSelected() {
  useDockingStore.setState({ selectedIds: [] });
}

// ─── IPC 接线（模块首次 import 时执行一次，防 HMR 重复 attach）──────────────────
if (
  typeof window !== "undefined" &&
  window.electronAPI?.onDockingTask &&
  !window.__DOCKING_WIRED__
) {
  window.electronAPI.onDockingTask(({ task }) => upsert(task));

  // 调度队列推送
  if (window.electronAPI.onDockingQueueStatus) {
    window.electronAPI.onDockingQueueStatus((queue) => {
      useDockingStore.setState({
        queue: queue || { running: [], queued: [], history: [] },
      });
    });
  }

  // Job 独立日志流
  if (window.electronAPI.onDockingJobLog) {
    window.electronAPI.onDockingJobLog((entry) => {
      if (!entry || !entry.jobId) return;
      useDockingStore.setState((s) => {
        const existing = s.jobLogs[entry.jobId] || [];
        const nextJobLogs = {
          ...s.jobLogs,
          [entry.jobId]: [...existing, entry].slice(-500),
        };
        // 若当前处于激活查看的 Job，同步到 runLog
        const isCurrentActive = s.activeJobId === entry.jobId;
        return {
          jobLogs: nextJobLogs,
          runLog: isCurrentActive
            ? [...s.runLog, entry].slice(-500)
            : s.runLog,
        };
      });
    });
  }

  // 处理过程的日志行（向下兼容）
  window.electronAPI.onDockingRunLog((entry) => {
    useDockingStore.setState((s) => ({
      runLog: [...s.runLog, entry].slice(-500),
    }));
  });

  window.electronAPI.onDockingRunStatus((run) => {
    useDockingStore.setState({ run: run || { running: false, taskIds: [] } });
    if (!run?.running) loadTasks();
  });

  if (window.electronAPI.onDockingJobDone) {
    window.electronAPI.onDockingJobDone((payload) => {
      useDockingStore.setState({
        lastRunDone: {
          code: payload?.code ?? 0,
          taskIds: payload?.taskIds || [],
          engine: payload?.engine || "claude",
          modifiedFiles: payload?.modifiedFiles || [],
          at: Date.now(),
        },
      });
      loadTasks();
      loadQueueStatus();
    });
  } else if (window.electronAPI.onDockingRunDone) {
    window.electronAPI.onDockingRunDone((payload) => {
      useDockingStore.setState({
        lastRunDone: {
          code: payload?.code ?? 0,
          taskIds: payload?.taskIds || [],
          engine: payload?.engine || "claude",
          modifiedFiles: payload?.modifiedFiles || [],
          at: Date.now(),
        },
      });
      loadTasks();
    });
  }

  window.electronAPI.onDockingStatus((status) => {
    useDockingStore.setState({
      status: status || { running: false, retrying: false, lastError: "" },
    });
  });

  window.__DOCKING_WIRED__ = true;
}
