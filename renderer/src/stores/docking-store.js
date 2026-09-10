import { create } from "zustand";
import { showToast } from "../utils/toast";

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
  // AI 调用历史的总条数。只有这个数字要在面板关着时也保持新鲜（顶栏菜单角标），
  // 列表本身归 JobHistoryModal 自己管，别让它把整页拖进重渲染
  historyTotal: 0,
  // 控制 AI 处理运行弹窗
  runModalOpen: false,
  runTargets: [],
  // settings 是否已从主进程拉回（拿它做表单初值的弹窗要等这个）
  settingsLoaded: false,
  // 三个无头引擎的可用性探测结果。装没装 claude 是机器级的事实，不是某个弹窗的
  // 私事——放 store 里，派活弹窗和预设规则弹窗共用一份，别各探各的
  engineProbes: { claude: null, agy: null, codex: null },
  // 勾选态只活在渲染层：它是「这一次要派给模型哪几条」的临时选择，不值得落盘
  selectedIds: [],
}));

export const useDockingTasks = () => useDockingStore((s) => s.tasks);
export const useDockingStatus = () => useDockingStore((s) => s.status);
export const useDockingSelectedIds = () => useDockingStore((s) => s.selectedIds);
export const useDockingSettings = () => useDockingStore((s) => s.settings);
/**
 * settings 是否已经从主进程拉回来。
 *
 * 拿 settings 做表单初值的弹窗必须等它为 true 再挂载：初值是挂载瞬间冻结的，
 * 在 settings 还是默认值时挂上去，用户什么都没改点一下保存，就把真实配置
 * 覆盖成默认值了。主进程正忙着跑 CLI 时这个窗口能拉到几百毫秒。
 */
export const useDockingSettingsLoaded = () =>
  useDockingStore((s) => s.settingsLoaded);

/** 单个引擎的探测结果（claude / agy / codex） */
export const useEngineProbe = (key) =>
  useDockingStore((s) => s.engineProbes[key] ?? null);

function putEngineProbe(key, probe) {
  useDockingStore.setState((s) => ({
    engineProbes: { ...s.engineProbes, [key]: probe ?? null },
  }));
}

/** 重探一个引擎（安装完、配置完，或用户切到它时调） */
export async function refreshEngineProbe(key) {
  if (key === "claude") putEngineProbe("claude", await probeClaude());
  else if (key === "agy") {
    const r = await window.electronAPI.dockingAgyProbe();
    putEngineProbe("agy", r?.probe);
  } else if (key === "codex") putEngineProbe("codex", await probeCodex());
}

// 探测在飞的时候不要再发一轮：StrictMode 下 effect 跑两次，弹窗开开关关也会
// 连着调，而这一次探测是要 spawn 三个子进程的
let probingPromise = null;

/** 探还没探过的那些。已经有结果或正在探就不再 spawn 子进程 */
export async function ensureEngineProbes() {
  if (probingPromise) return probingPromise;
  const { engineProbes } = useDockingStore.getState();
  const missing = ["claude", "agy", "codex"].filter(
    (k) => engineProbes[k] == null,
  );
  if (missing.length === 0) return;
  probingPromise = Promise.all(missing.map((k) => refreshEngineProbe(k)))
    .finally(() => {
      probingPromise = null;
    });
  return probingPromise;
}

export { putEngineProbe };
export const useDockingQueue = () => useDockingStore((s) => s.queue);
/**
 * 整张 jobLogs 表。慎用：它每来一条日志就换引用，订阅它的组件会跟着 CLI 的
 * 输出频率重渲染。只要某个 job 的最新一行时用 useJobLatestLogText。
 */
export const useDockingJobLogs = () => useDockingStore((s) => s.jobLogs);
/**
 * 单个 Job 的最新一行日志。
 *
 * 任务卡片只需要这一行文本，别订阅整张 jobLogs 表：那是个每来一条日志就换引用的
 * 对象，谁订阅谁就跟着 CLI 输出的频率重渲染。这里 selector 返回字符串，
 * 引用天然稳定，只有真正变化的那张卡会重渲染。
 */
export const useJobLatestLogText = (jobId) =>
  useDockingStore((s) =>
    jobId ? (s.jobLogs[jobId]?.at(-1)?.text ?? null) : null,
  );
/**
 * 队列里还占着 CLI 子进程的 job 数（跑着的 + 排队的）。
 *
 * 只要一个数字的地方别订阅 useDockingQueue()——主进程每次推送都是整个新对象，
 * 订阅它就等于跟着队列心跳重渲染。返回 number，引用天然稳定。
 */
/** 待处理（inbox + awaiting）的任务数。侧边栏角标要的就是这一个数字 */
export const usePendingTaskCount = () =>
  useDockingStore(
    (s) =>
      s.tasks.filter((t) => t.status === "inbox" || t.status === "awaiting")
        .length,
  );

export const useDockingActiveJobCount = () =>
  useDockingStore(
    (s) => (s.queue?.running?.length || 0) + (s.queue?.queued?.length || 0),
  );

/** 按 id 取单条任务。列表之外的消费者（详情弹窗）用它，别去订阅整个 tasks 数组 */
export const useTaskById = (taskId) =>
  useDockingStore((s) => (taskId ? s.tasks.find((t) => t.id === taskId) : null) ?? null);

/** 某条任务当前占用的 job（运行中优先，其次排队中）。取不到返回 null */
export const useJobForTask = (taskId, status = "running") =>
  useDockingStore(
    (s) =>
      (taskId
        ? (s.queue?.[status] || []).find((j) => j.taskIds?.includes(taskId))
        : null) ?? null,
  );

export const useDockingHistoryTotal = () =>
  useDockingStore((s) => s.historyTotal);
export const useDockingRunModalOpen = () => useDockingStore((s) => s.runModalOpen);
export const useDockingRunTargets = () => useDockingStore((s) => s.runTargets);

/** 只拉总数，不拉列表——顶栏角标要的就是这一个数字 */
export async function loadHistoryTotal() {
  try {
    const res = await window.electronAPI.dockingGetHistory({ limit: 1 });
    useDockingStore.setState({ historyTotal: res?.total || 0 });
  } catch (err) {
    console.error("加载 AI 历史总数失败:", err);
  }
}

export function setRunModalOpen(open) {
  useDockingStore.setState({ runModalOpen: Boolean(open) });
}

export function setRunTargets(targets) {
  useDockingStore.setState({ runTargets: targets || [] });
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
  if (result?.success) {
    useDockingStore.setState({ settings: result.settings, settingsLoaded: true });
  }
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
  if (result?.success && result.queue) {
    useDockingStore.setState({ queue: result.queue });
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

/**
 * 任务跑完的提示。
 *
 * 原来是靠常驻的全局悬浮条显示 6 秒后自渐隐，为了这一条提示，整条悬浮条
 * （连同它订阅的 tasks / queue / 日志）就得一直挂在每一个页面上。改成 toast 后
 * 提示还在，常驻成本没了。
 */
function notifyJobDone(payload) {
  const code = payload?.code ?? 0;
  const changed = payload?.modifiedFiles?.length || 0;
  if (code === 0) {
    showToast(
      `✅ AI 处理完成${changed > 0 ? ` · 已修改 ${changed} 个文件` : ""}`,
      "success",
    );
  } else {
    showToast(`⚠️ AI 执行异常退出 (${code})`, "error");
  }
}

// ─── 日志批处理 ─────────────────────────────────────────────────────────────
/**
 * 日志行由 CLI 决定节奏，一秒几十上百行是常态。每来一行就 setState 一次，
 * 就是每行一次 React 渲染——IPC 回调各自处在独立的事件循环 tick 里，
 * React 18 的自动批处理管不到这种跨 tick 的更新。
 *
 * 所以这里按帧攒一批再写进 store：渲染次数被压到每帧最多一次；页面不可见时
 * requestAnimationFrame 自己会停，日志攒着不渲染，等回到前台一次性补上。
 * 批内还按 jobId 分组，同一个 job 的 N 行只拷贝一次数组，而不是 N 次。
 */
const LOG_LIMIT = 500;
let pendingLogs = [];
let flushHandle = 0;

function flushJobLogs() {
  flushHandle = 0;
  const batch = pendingLogs;
  pendingLogs = [];
  if (batch.length === 0) return;

  const byJob = new Map();
  for (const entry of batch) {
    const list = byJob.get(entry.jobId);
    if (list) list.push(entry);
    else byJob.set(entry.jobId, [entry]);
  }

  useDockingStore.setState((s) => {
    const nextJobLogs = { ...s.jobLogs };
    for (const [jobId, entries] of byJob) {
      const merged = (nextJobLogs[jobId] || []).concat(entries);
      nextJobLogs[jobId] =
        merged.length > LOG_LIMIT ? merged.slice(-LOG_LIMIT) : merged;
    }
    return { jobLogs: nextJobLogs };
  });
}

function queueJobLog(entry) {
  if (!entry || !entry.jobId) return;
  pendingLogs.push(entry);
  // 页面长时间不可见时 rAF 不触发，这里兜住内存：反正每个 job 只留最后 LOG_LIMIT 行
  if (pendingLogs.length > LOG_LIMIT * 4) {
    pendingLogs = pendingLogs.slice(-LOG_LIMIT * 2);
  }
  if (flushHandle) return;
  flushHandle = window.requestAnimationFrame(flushJobLogs);
}

/** 任务收尾等时刻强制落盘，别让最后几行卡在缓冲里 */
function flushJobLogsNow() {
  if (flushHandle) {
    window.cancelAnimationFrame(flushHandle);
    flushHandle = 0;
  }
  flushJobLogs();
}

// ─── IPC 接线（模块首次 import 时执行一次，防 HMR 重复 attach）──────────────────
if (
  typeof window !== "undefined" &&
  window.electronAPI?.onDockingTask &&
  !window.__DOCKING_WIRED__
) {
  window.electronAPI.onDockingTask(({ task }) => upsert(task));

  // 历史记录变动：只同步总数，列表由打开着的面板自己拉
  if (window.electronAPI.onDockingHistoryUpdated) {
    window.electronAPI.onDockingHistoryUpdated(() => loadHistoryTotal());
  }

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
    window.electronAPI.onDockingJobLog(queueJobLog);
  }

  // run 通道的状态已不再进 store，只留「跑完了刷一次任务列表」这个副作用
  window.electronAPI.onDockingRunStatus((run) => {
    if (!run?.running) loadTasks();
  });

  if (window.electronAPI.onDockingJobDone) {
    window.electronAPI.onDockingJobDone((payload) => {
      flushJobLogsNow();
      notifyJobDone(payload);
      loadTasks();
      loadQueueStatus();
    });
  } else if (window.electronAPI.onDockingRunDone) {
    window.electronAPI.onDockingRunDone((payload) => {
      flushJobLogsNow();
      notifyJobDone(payload);
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
