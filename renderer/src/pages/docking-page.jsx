import { Fragment, useEffect, useMemo, useState } from "react";
import clsx from "../utils/clsx";
import PageShell from "../components/page-shell";
import AgentProcessesModal from "../components/agent-processes-modal";
import { confirm } from "../components/confirm-host";
import useEventCallback from "../hooks/use-event-callback";
import { useAppConfig } from "../stores/app-config-store";
import { showToast } from "../utils/toast";
import {
  cancelDockingJob,
  installDockingCli,
  loadQueueStatus,
  loadSettings,
  loadHistoryTotal,
  loadStatus,
  loadCommands,
  loadTasks,
  probeLark,
  removeTask,
  saveSettings,
  setRunModalOpen,
  setRunTargets,
  startListening,
  stopListening,
  useDockingActiveJobCount,
  useDockingRunTargets,
  useDockingCommands,
  useDockingSettings,
  useDockingStatus,
} from "../stores/docking-store";
import { RUN_MODE_SHORT } from "./docking/constants";
import AskRequesterModal from "./docking/ask-requester-modal";
import AutoDispatchModal from "./docking/auto-dispatch-modal";
import CliInstallCard from "./docking/cli-install-card";
import CreateTaskModal from "./docking/create-task-modal";
import JobHistoryModal from "./docking/job-history-modal";
import PromptPreviewModal from "./docking/prompt-preview-modal";
import ReplySolutionModal from "./docking/reply-solution-modal";
import ReportModal from "./docking/report-modal";
import RunDispatchModal from "./docking/run-dispatch-modal";
import TaskListSection from "./docking/task-list-section";
import TaskThreadModal from "./docking/task-thread-modal";
import WorkbenchMenu from "./docking/workbench-menu";

// ─── 页面 ────────────────────────────────────────────────────────────────────

export default function DockingPage() {
  const status = useDockingStatus();
  const settings = useDockingSettings();
  const commands = useDockingCommands();
  const appConfig = useAppConfig();
  // memo 掉：不 memo 的话每次渲染都是一个新数组，将来给这几个弹窗加 memo 会白加
  const repos = useMemo(
    () => appConfig?.frontendProjectGroups || [],
    [appConfig?.frontendProjectGroups],
  );

  const [probe, setProbe] = useState(null);
  const [larkInstalling, setLarkInstalling] = useState(false);
  const [askTarget, setAskTarget] = useState(null);
  // 话题详情弹窗做成页面级单例：以前每张卡都挂一个，N 条任务就是 N 份弹窗与展开态。
  // 存 id 而不是 task 快照，任务被 AI 回写后弹窗里的内容才跟着更新
  const [threadTaskId, setThreadTaskId] = useState(null);
  const [prompt, setPrompt] = useState("");

  // 新建需求弹窗状态
  const [procModalOpen, setProcModalOpen] = useState(false);
  // 顶栏徽标：还占着 CLI 子进程的 job 数。订阅的是一个数字而不是整个 queue 对象——
  // 主进程每次推队列都是新对象，订阅它就等于跟着队列心跳重渲染整页
  const activeJobCount = useDockingActiveJobCount();
  const [createModalOpen, setCreateModalOpen] = useState(false);

  // 自动处理：runTargets 是当前要处理的任务数组（支持单条或多条批量）
  const runTargets = useDockingRunTargets();
  // agy / codex 要预先注册 MCP 才能回写状态，这里存探测结果

  // 一键飞书回复排查解答状态
  const [solutionTarget, setSolutionTarget] = useState(null);

  // 工作量周报状态
  const [reportModalOpen, setReportModalOpen] = useState(false);

  // 自动派发 AI 预设规则弹窗状态
  const [autoDispatchModalOpen, setAutoDispatchModalOpen] = useState(false);
  // 力度自动提权：默认关。开了之后，话题里对方的新指令命中关键词才会
  // 把「只读分析」提到「允许改代码」
  // 允许触发本机自动执行的飞书 open_id，留空 = 不限制

  // ── AI 调用历史记录回看状态 ──
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const [historyFilterTaskId, setHistoryFilterTaskId] = useState("");

  const refreshAllProbes = () => {
    probeLark().then((p) => setProbe(p));
  };

  const openHistoryForTask = useEventCallback((taskId) => {
    setHistoryFilterTaskId(taskId);
    setHistoryModalOpen(true);
  });

  useEffect(() => {
    loadTasks();
    loadCommands();
    loadStatus();
    // settings 拉回 store 即可，弹窗各自挂载时从 store 取初值，不再往页面 state 回填
    loadSettings();
    loadQueueStatus();
    refreshAllProbes();
    // 历史总数归 store（顶栏角标要），列表归 JobHistoryModal 自己
    loadHistoryTotal();
  }, []);

  // 任务库是磁盘上的一个文件，外部进程也在写它：MCP server 回写状态、req-to-plan 的桥
  // 往里塞需求池工作包。这些写入没有 IPC 增量可推，回到窗口时对一次账。
  // loadTasks 里有签名比对，没变化就不会 setState，所以 alt-tab 频繁触发也不会掉帧。
  // 监听已健康运行时说明 lark-cli 事实上已就绪，不再对外暴露过期的 probe.error；
  // 没装好或没配好时，人多半是切去终端处理了，回来顺手重探一次，
  // 提示卡片才不会挂着过期的结论；好了之后就不探——每次切窗口都起两个 lark-cli 不值当
  const isHealthy = Boolean(status.connected);
  const probeError = isHealthy ? "" : probe?.error || "";
  const setupCmd = isHealthy ? "" : probe?.setupCmd || "";
  const larkNotReady = Boolean(probe && (!probe.installed || probeError));
  useEffect(() => {
    const onFocus = () => {
      loadTasks();
      if (larkNotReady) probeLark().then((p) => setProbe(p));
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [larkNotReady]);

  const handleInstallLark = async () => {
    setLarkInstalling(true);
    try {
      const res = await installDockingCli("lark-cli");
      if (res?.success) {
        const p = await probeLark();
        setProbe(p);
        // 刚装上的 lark-cli 在新电脑上必然还没配置，这时候说「已就绪」是误导
        if (p?.error) {
          showToast("lark-cli 已安装，还需要配置飞书应用", "warning");
        } else {
          showToast("lark-cli 安装成功！已就绪", "success");
        }
      } else {
        showToast(`安装失败: ${res?.error || "未知错误"}`, "error");
      }
    } catch (err) {
      showToast(`安装异常: ${err.message}`, "error");
    } finally {
      setLarkInstalling(false);
    }
  };

  // 重连中也算在监听：失败的监听会一直退避重试到退出应用，这时候按钮得是「停止」
  const listening = status.running || status.retrying;

  const toggleListening = async () => {
    if (!listening && probe && !probe.installed) {
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
    const result = listening ? await stopListening() : await startListening();
    if (!result?.success) showToast(`操作失败: ${result?.error}`, "error");
  };

  // 目录、引擎、力度与三个引擎的探测都归 RunDispatchModal 自己管，
  // 它按 runTargets 条件挂载，挂载时读 settings 取初值
  const openThread = useEventCallback((task) => setThreadTaskId(task.id));

  const openRun = useEventCallback((taskOrTasks) => {
    const targets = Array.isArray(taskOrTasks) ? taskOrTasks : [taskOrTasks];
    if (!targets.length) return;
    setRunTargets(targets);
    setRunModalOpen(true);
  });

  const handleDelete = useEventCallback(async (task) => {
    const ok = await confirm({
      title: "移除需求话题",
      message: `确定要从本工具列表中移除话题 #${task.seq}「${task.title}」吗？\n（仅在本软件中删除记录，飞书 App 里的聊天记录与消息完全不受影响）`,
      danger: true,
    });
    if (ok) {
      await removeTask(task.id);
      if (threadTaskId === task.id) setThreadTaskId(null);
      showToast(`已移除话题 #${task.seq}`, "success");
    }
  });

  return (
    <PageShell
      title="AI 工单台"
      subtitle="飞书需求与逻辑咨询入列 · 勾选交给 AI 分析或实现 · 原路飞书回复沟通"
      noCard
      actions={
        <div className="flex items-center gap-2">
          <WorkbenchMenu
            activeJobCount={activeJobCount}
            onOpenProcesses={() => setProcModalOpen(true)}
            onOpenHistory={() => {
              setHistoryFilterTaskId("");
              setHistoryModalOpen(true);
            }}
            onOpenReport={() => setReportModalOpen(true)}
          />
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
              status.retrying
                ? "border-amber-200 text-amber-700 bg-amber-50"
                : status.running
                  ? "border-emerald-200 text-emerald-600 bg-emerald-50"
                  : "border-border text-slate-600 hover:bg-slate-50",
            )}
            onClick={toggleListening}
          >
            {status.retrying
              ? "重连中 · 点击停止"
              : status.running
                ? "监听中 · 点击停止"
                : "开始监听飞书"}
          </button>
        </div>
      }
    >
      <div className="max-w-4xl mx-auto w-full flex flex-col gap-3 p-2">
        {/* 环境与连接状态 */}
        {probe && !probe.installed && (
          <CliInstallCard
            title="未检测到飞书 CLI (lark-cli)"
            desc="AI 工单台需要本地全局安装 @larksuite/cli 来监听飞书私聊消息、发送回执与话题反问卡片。"
            installCmd={probe.installCmd || "npm install -g @larksuite/cli"}
            onInstall={handleInstallLark}
            installing={larkInstalling}
            btnText="一键安装 lark-cli"
          />
        )}
        {probe?.installed && probeError && (
          <CliInstallCard
            title="lark-cli 已安装，但还不能用"
            desc={probeError}
            installCmd={setupCmd}
          />
        )}
        {status.lastError && (
          <div className="text-[12px] border border-rose-200 bg-rose-50 text-rose-600 rounded-lg px-3 py-2 whitespace-pre-wrap">
            {status.lastError}
            {status.retrying && " · 正在自动重连"}
          </div>
        )}

        {/* 飞书快捷指令说明栏。指令表来自主进程（src/feishu/commands.js），
            /h 的帮助文案也由同一份生成——加指令不会只改一边。拉不到就整条不渲染 */}
        {commands.length > 0 && (
          <div className="flex items-center justify-between text-[11px] text-slate-700 bg-slate-50 border border-slate-200/80 rounded-lg px-3 py-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-slate-700 font-bold">💡 飞书指令：</span>
              {commands.map((c, i) => (
                <Fragment key={c.key}>
                  {i > 0 && <span className="text-slate-400">·</span>}
                  <span title={c.help}>
                    <code className="text-sky-700 font-mono font-semibold">
                      {c.hint.code}
                    </code>{" "}
                    {c.hint.label}
                  </span>
                </Fragment>
              ))}
            </div>
            <span className="text-[10px] text-slate-600 font-medium shrink-0 ml-2">
              未带指令的普通消息自动归入「未识别」
            </span>
          </div>
        )}

        {/* 自动化与通知策略配置栏 */}
        <div className="flex items-center justify-between gap-3 text-xs bg-white border border-border rounded-lg px-3 py-2 flex-wrap shadow-2xs">
          {/* 飞书通知策略 */}
          <div className="flex items-center gap-3">
            <span className="text-[11px] font-bold text-slate-700 shrink-0">
              飞书通知
            </span>
            <label
              className="flex items-center gap-1.5 cursor-pointer text-slate-800 font-medium hover:text-slate-950"
              title="机器人主动回执：/r 的「已记录 #N」卡片、/plan 的备料结果、AI 的反问。你发 /u、/h 属于问必答，不受它影响"
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
                <strong>⚡ 无人值守 AI 工单台已就绪</strong>：收到 /r
                需求后将自动派发 AI（
                {RUN_MODE_SHORT[settings.autoDispatchMode] ||
                  settings.autoDispatchMode}{" "}
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
        <TaskListSection
          onRun={openRun}
          onOpenThread={openThread}
          onViewHistory={openHistoryForTask}
          onPromptGenerated={setPrompt}
        />
      </div>

      {threadTaskId && (
        <TaskThreadModal
          taskId={threadTaskId}
          onClose={() => setThreadTaskId(null)}
          onAsk={setAskTarget}
          onReplySolution={setSolutionTarget}
          onRun={openRun}
          onDelete={handleDelete}
          onCancelJob={cancelDockingJob}
          onViewHistory={openHistoryForTask}
        />
      )}

      {/* Agent 进程面板：谁在占着 CLI 子进程，哪个卡住了，逐条可终止 */}
      {procModalOpen && (
        <AgentProcessesModal onClose={() => setProcModalOpen(false)} />
      )}

      {/* 新建需求 / 咨询弹窗 */}
      {createModalOpen && (
        <CreateTaskModal
          open
          onClose={() => setCreateModalOpen(false)}
          repos={repos}
        />
      )}

      {/* 回复提出人弹窗 */}
      {askTarget && (
        <AskRequesterModal
          task={askTarget}
          onClose={() => setAskTarget(null)}
        />
      )}

      {/* 派发给 AI 设置弹窗 */}
      {runTargets.length > 0 && <RunDispatchModal repos={repos} />}

      {/* 回复排查解答弹窗 */}
      {solutionTarget && (
        <ReplySolutionModal
          task={solutionTarget}
          onClose={() => setSolutionTarget(null)}
        />
      )}

      {/* 工作量周报生成器 */}
      {reportModalOpen && (
        <ReportModal open onClose={() => setReportModalOpen(false)} />
      )}

      {/* 自动派发 AI 预设规则弹窗 */}
      {autoDispatchModalOpen && (
        <AutoDispatchModal
          open
          onClose={() => setAutoDispatchModalOpen(false)}
          repos={repos}
        />
      )}

      {/* prompt 预览 */}
      <PromptPreviewModal prompt={prompt} onClose={() => setPrompt("")} />

      {/* AI 调用历史回看与记录弹窗 */}
      {historyModalOpen && (
        <JobHistoryModal
          // initialTaskId 是 useState 初值，只在挂载时生效——用它当 key，
          // 面板已开着时换一条需求看历史也能重新按新 id 筛选
          key={historyFilterTaskId}
          onClose={() => setHistoryModalOpen(false)}
          initialTaskId={historyFilterTaskId}
        />
      )}

    </PageShell>
  );
}
