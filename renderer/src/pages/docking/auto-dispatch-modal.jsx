import { useState } from "react";
import clsx from "../../utils/clsx";
import Modal from "../../components/modal";
import { showToast } from "../../utils/toast";
import {
  saveSettings,
  useDockingSettings,
  useDockingSettingsLoaded,
} from "../../stores/docking-store";
import useEngineProbes from "./use-engine-probes";
import { AUTO_DISPATCH_MODES, ENGINES } from "./constants";

/**
 * 自动派发预设规则弹窗。
 *
 * 八个表单字段从页面顶层搬到这里。初值直接取 store 里的 settings——页面原来靠
 * mount 时的 loadSettings 回填这一堆 state，等于把一份只有弹窗用得到的副本
 * 挂在了整页上，任一字段改动都要带着全部任务卡重渲染。
 */
/**
 * 外壳：settings 没拉回来之前不挂载表单。
 *
 * 表单的 8 个字段都是挂载瞬间从 settings 取的初值，一旦在默认值状态下挂上去，
 * 用户什么都不改点一下「保存并启用」，就会把真实的派发规则覆盖成默认值。
 */
export default function AutoDispatchModal({ open, onClose, repos = [] }) {
  const loaded = useDockingSettingsLoaded();

  if (!loaded) {
    return (
      <Modal
        open={open}
        onClose={onClose}
        title="⚙️ 收到需求自动交给 AI 预设规则"
        srOnly={false}
        className="w-[580px] max-w-[95vw] p-6"
      >
        <div className="text-xs text-slate-500 text-center py-6">
          正在读取当前预设…
        </div>
      </Modal>
    );
  }
  return <AutoDispatchForm open={open} onClose={onClose} repos={repos} />;
}

function AutoDispatchForm({ open, onClose, repos }) {
  const settings = useDockingSettings();
  // 引擎徽标要显示「未安装 / 未配置」，探测状态跟派活弹窗共用同一个 hook
  const { claudeProbe, agyProbe, codexProbe } = useEngineProbes();
  const [autoCwd, setAutoCwd] = useState(() => settings.autoDispatchCwd ?? "auto");
  const [autoMode, setAutoMode] = useState(
    () => settings.autoDispatchMode || "analyze",
  );
  const [autoEngine, setAutoEngine] = useState(
    () => settings.autoDispatchEngine || "claude",
  );
  const [autoCreateBranch, setAutoCreateBranch] = useState(
    () => settings.autoDispatchCreateBranch ?? true,
  );
  const [autoEscalate, setAutoEscalate] = useState(
    () => settings.autoEscalateMode ?? false,
  );
  const [escalateKeywords, setEscalateKeywords] = useState(() =>
    (settings.escalateKeywords || []).join("、"),
  );
  const [allowedRequesters, setAllowedRequesters] = useState(() =>
    (settings.allowedRequesters || []).join("\n"),
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
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
            {AUTO_DISPATCH_MODES.map((item) => (
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

        {/* /plan 说明：它没有开关，但会用这里的一部分设置 */}
        <div className="pt-1 border-t border-slate-200">
          <p className="text-[11px] text-slate-500 mt-2 leading-relaxed">
            <strong className="text-slate-700">📐 关于 /plan</strong>
            ：它没有开关——有人发 <code>/plan 需求文档链接</code> 就会备料并开跑，
            走「产实施 plan」档 + Claude Code，不看上面选的力度与引擎（三个引擎都能跑这一档，
            但 claude 的边界最紧，无人值守用它最稳）。
            但<strong>默认项目、隔离分支、下面的白名单</strong>对它同样生效。
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
          onClick={onClose}
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
            onClose();
            showToast("已保存并启用自动派发 AI 预设规则", "success");
          }}
        >
          保存并启用预设
        </button>
      </div>
    </Modal>
  );
}
