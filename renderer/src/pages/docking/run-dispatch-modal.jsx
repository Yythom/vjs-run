import { useState } from "react";
import clsx from "../../utils/clsx";
import Modal from "../../components/modal";
import { confirm } from "../../components/confirm-host";
import { showToast } from "../../utils/toast";
import {
  patchTask,
  saveSettings,
  setRunModalOpen,
  setRunTargets,
  startRun,
  useDockingRunTargets,
  useDockingSettings,
  useDockingSettingsLoaded,
} from "../../stores/docking-store";
import CliInstallCard from "./cli-install-card";
import useEngineProbes from "./use-engine-probes";
import { ENGINES, PLAN_MODE_LIMIT, RUN_MODES } from "./constants";
import { pickSmartRepo } from "./utils";

/**
 * 派活弹窗：选目录、引擎、执行力度，然后发车。
 *
 * 三个引擎的 probe / 安装 / 一键配置状态只有这里用得到，原来却和 cwd、mode、
 * engine 一起挂在页面顶层。搬进来后页面顶层少掉 11 个 state，探测结果回来时
 * 也不会再牵动整张任务列表重渲染。
 */
/**
 * 外壳：settings 没拉回来之前不挂载表单。
 * cwd / mode / engine / createBranch 都是挂载瞬间从 settings 取的初值，
 * 在默认值状态下挂上去，用户发车时就会把上次的选择写回成默认值。
 */
export default function RunDispatchModal({ repos = [] }) {
  const loaded = useDockingSettingsLoaded();
  if (!loaded) {
    return (
      <Modal
        open
        onClose={() => {
          setRunModalOpen(false);
          setRunTargets([]);
        }}
        title="交给 AI 处理"
        srOnly={false}
        className="w-[720px] p-6"
      >
        <div className="text-xs text-slate-500 text-center py-6">
          正在读取上次的派活配置…
        </div>
      </Modal>
    );
  }
  return <RunDispatchForm repos={repos} />;
}

function RunDispatchForm({ repos }) {
  const runTargets = useDockingRunTargets();
  const settings = useDockingSettings();

  // 页面按 runTargets 条件挂载本组件，所以初值在这儿算一次就够，不需要 effect 回填
  const [cwd, setCwd] = useState(() =>
    pickSmartRepo(runTargets, repos, settings.lastCwd),
  );
  const hasWorkpack = runTargets.some((t) => t.workpackDir);
  const [mode, setMode] = useState(() => {
    if (hasWorkpack) return "plan";
    return settings.runMode || "analyze";
  });
  // 引擎的「人选了什么」和「这次实际用什么」是两回事：产 plan 档固定走 claude
  // （主进程 enqueueJob 里也兜底），但别把这次的强制值写回成下次的默认选择。
  const [engineChoice, setEngineChoice] = useState(
    () => settings.runEngine || "claude",
  );
  const planLocked = mode === "plan";
  const engine = planLocked ? "claude" : engineChoice;
  const [createBranch, setCreateBranch] = useState(
    () => settings.createBranch ?? false,
  );
  // 不续接上一轮会话。只在这次派活有效，不记进 settings：
  // 「从头来」是针对某条任务的临时决定，记住了会让之后每次派活都白丢上下文
  const [freshSession, setFreshSession] = useState(false);
  // 续接条件的前半截在这儿判断（引擎、单条、同仓库），会话文件还在不在由主进程查
  const resumable =
    engine === "claude" &&
    runTargets.length === 1 &&
    runTargets[0].agentSession?.engine === "claude" &&
    runTargets[0].agentSession?.cwd === cwd;

  const {
    claudeProbe,
    claudeInstalling,
    agyProbe,
    agyBusy,
    codexProbe,
    codexBusy,
    codexInstalling,
    refreshProbe,
    handleInstallClaude,
    handleInstallCodex,
    handleAgySetup,
    handleCodexSetup,
  } = useEngineProbes();

  const handleClose = () => {
    setRunModalOpen(false);
    setRunTargets([]);
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
    const result = await startRun(
      ids,
      cwd,
      mode,
      engine,
      createBranch,
      resumable && freshSession,
    );
    if (result?.success) {
      saveSettings({
        lastCwd: cwd,
        runMode: mode === "plan" ? (settings.runMode || "analyze") : mode,
        runEngine: engineChoice,
        createBranch,
      });
      // 记录任务关联的 repoPath
      for (const t of runTargets) {
        if (!t.repoPath || t.repoPath !== cwd) {
          patchTask(t.id, { repoPath: cwd });
        }
      }
      handleClose();
      showToast(
        result.status === "queued"
          ? "已加入执行队列排队中"
          : "⚡ 已启动 AI 任务处理，可在卡片与顶部工作台查看进展",
        "success",
      );
    } else {
      showToast(`启动失败: ${result?.error}`, "error");
    }
  };

  return (
    <Modal
      open={runTargets.length > 0}
      onClose={handleClose}
      title={
        runTargets.length === 1
          ? `交给 ${ENGINES.find((e) => e.key === engine)?.label || "Agent"} · #${runTargets[0].seq} ${runTargets[0].title}`
          : `交给 ${ENGINES.find((e) => e.key === engine)?.label || "Agent"} · 批量派发 ${runTargets.length} 条需求`
      }
      srOnly={false}
      className="w-[720px] p-4"
    >
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
                <div className="font-medium text-slate-700">{repo.label}</div>
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
              planLocked &&
                e.key !== "claude" &&
                "opacity-40 cursor-not-allowed hover:bg-transparent",
            )}
            disabled={planLocked && e.key !== "claude"}
            onClick={() => {
              setEngineChoice(e.key);
              saveSettings({ runEngine: e.key });
              refreshProbe(e.key);
            }}
          >
            <span>{e.label}</span>
            {e.key === "claude" && claudeProbe && !claudeProbe.installed && (
              <span className="text-[9px] px-1 py-[1px] rounded bg-amber-100 text-amber-800 border border-amber-300">
                未安装
              </span>
            )}
            {e.key === "agy" && agyProbe && !agyProbe.installed && (
              <span className="text-[9px] px-1 py-[1px] rounded bg-amber-100 text-amber-800 border border-amber-300">
                未安装
              </span>
            )}
            {e.key === "agy" && agyProbe?.installed && !agyProbe?.ready && (
              <span className="text-[9px] px-1 py-[1px] rounded bg-amber-100 text-amber-800 border border-amber-300">
                未配置
              </span>
            )}
            {e.key === "codex" && codexProbe && !codexProbe.installed && (
              <span className="text-[9px] px-1 py-[1px] rounded bg-amber-100 text-amber-800 border border-amber-300">
                未安装
              </span>
            )}
            {e.key === "codex" &&
              codexProbe?.installed &&
              !codexProbe?.ready && (
                <span className="text-[9px] px-1 py-[1px] rounded bg-amber-100 text-amber-800 border border-amber-300">
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
                vjtools-docking MCP
                server，否则它没法回写任务状态、也不能自动反问。
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

      {/* 产 plan 固定用 claude，说清楚为什么别的引擎这会儿点不动 */}
      {planLocked && (
        <div className="mt-2 p-2.5 rounded-lg border border-amber-200 bg-amber-50/70 text-[11px] text-amber-900 leading-relaxed">
          <strong>产 plan 固定走 Claude Code</strong>
          ：这一档要的是只读扫影响面 + 写一份 plan.md，只有 claude
          能按工具名把 Bash 整个禁掉。边界·{PLAN_MODE_LIMIT.level}：
          {PLAN_MODE_LIMIT.text}
        </div>
      )}

      {/* 隔离 worktree 开关 */}
      <div className="mt-3 p-2.5 rounded-lg border border-slate-200 bg-slate-50/80 flex items-center justify-between">
        <div>
          <div className="text-[12px] font-medium text-slate-700 flex items-center gap-1">
            <span>🌿</span>
            <span>在隔离 worktree 里执行</span>
          </div>
          <div className="text-[11px] text-slate-400">
            为任务单独建一个工作目录与分支 (如 <code>docking/seq-7-...</code>
            )，主仓库不动、不要求工作区干净；node_modules 软链复用主仓库
          </div>
        </div>
        <input
          type="checkbox"
          className="w-4 h-4 accent-sky-600 rounded cursor-pointer"
          checked={createBranch}
          onChange={(e) => setCreateBranch(e.target.checked)}
        />
      </div>

      {/* 续接开关：只有真的会续接时才出现 */}
      {resumable && (
        <label className="mt-2 p-2.5 rounded-lg border border-slate-200 bg-slate-50/80 flex items-center justify-between cursor-pointer">
          <div>
            <div className="text-[12px] font-medium text-slate-700 flex items-center gap-1">
              <span>♻️</span>
              <span>不续接上一轮会话，从头开始</span>
            </div>
            <div className="text-[11px] text-slate-400">
              默认会接着上一轮的上下文继续，只把之后的新消息发给 AI；
              上一轮方向跑偏或上下文太乱时勾上
            </div>
          </div>
          <input
            type="checkbox"
            className="w-4 h-4 accent-sky-600 rounded cursor-pointer"
            checked={freshSession}
            onChange={(e) => setFreshSession(e.target.checked)}
          />
        </label>
      )}

      <div className="flex justify-end gap-2 mt-3">
        <button
          type="button"
          className="text-xs px-3 py-1.5 rounded border border-border text-slate-600 cursor-pointer"
          onClick={() => {
            handleClose();
          }}
        >
          取消
        </button>
        <button
          type="button"
          disabled={!cwd}
          className="text-xs px-3.5 py-1.5 rounded bg-sky-600 hover:bg-sky-700 text-white disabled:opacity-40 cursor-pointer font-medium shadow-2xs"
          onClick={handleRun}
        >
          启动处理
        </button>
      </div>
    </Modal>
  );
}
