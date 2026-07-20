import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import clsx from "clsx";
import useResource from "../hooks/use-resource";
import {
  clearMockHistory,
  loadMockHistory,
  useMockHistory,
} from "../stores/mock-history-store";
import {
  loadMockRecording,
  startMockRecording,
  stopMockRecording,
  useMockRecording,
} from "../stores/mock-recording-store";
import { useStatus } from "../stores/status-store";
import { MOCK_ID } from "../constants";
import { prettyJson } from "./mock-config/utils";
import { showToast } from "../utils/toast";
import Modal from "../components/modal";

const KIND_META = {
  mock: {
    label: "MOCK",
    className: "text-emerald-700 bg-emerald-400/10 border-emerald-400/35",
  },
  proxy: {
    label: "PROXY",
    className: "text-sky-700 bg-sky-400/10 border-sky-400/35",
  },
  "proxy-error": {
    label: "PROXY✗",
    className: "text-red-700 bg-red-400/10 border-red-400/30",
  },
  miss: {
    label: "MISS",
    className: "text-amber-700 bg-amber-400/10 border-amber-400/40",
  },
};

const FILTERS = [
  { key: "all", label: "全部" },
  { key: "mock", label: "MOCK" },
  { key: "proxy", label: "PROXY" },
  { key: "error", label: "异常" },
  { key: "miss", label: "MISS" },
];

function matchFilter(entry, filter) {
  if (filter === "all") return true;
  if (filter === "proxy") return entry.kind === "proxy" || entry.kind === "proxy-error";
  if (filter === "error") return (entry.status && entry.status >= 400) || entry.kind === "proxy-error";
  return entry.kind === filter;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

function KindBadge({ kind }) {
  const meta = KIND_META[kind] || KIND_META.miss;
  return (
    <span
      className={clsx(
        "text-[10px] font-semibold px-1.5 py-0.5 rounded border shrink-0",
        meta.className,
      )}
    >
      {meta.label}
    </span>
  );
}

function HistoryListItem({ entry, selected, checked, onSelect, onToggleCheck }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect()}
      className={clsx(
        "w-full text-left rounded-lg border px-2.5 py-2 mb-1.5 transition-colors cursor-pointer",
        selected
          ? "bg-sky-400/[0.08] border-sky-400/30"
          : "bg-card border-border hover:bg-hover",
      )}
    >
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={checked}
          onClick={(e) => e.stopPropagation()}
          onChange={onToggleCheck}
          title="选中以便批量存入场景"
          className="accent-sky-500 shrink-0"
        />
        <KindBadge kind={entry.kind} />
        <span className="text-[10px] font-semibold text-slate-500 shrink-0 w-11">
          {entry.method}
        </span>
        <span className="text-xs text-slate-900 font-medium truncate">
          {entry.path}
        </span>
      </div>
      <div className="flex items-center gap-2 mt-1 text-[10.5px] text-slate-500">
        <span
          className={clsx(
            "font-medium",
            entry.status >= 400 ? "text-red-600" : "text-slate-600",
          )}
        >
          {entry.status}
        </span>
        <span>{entry.durationMs}ms</span>
        <span className="ml-auto">{formatTime(entry.ts)}</span>
      </div>
    </div>
  );
}

// 把 text 中匹配 keyword（大小写不敏感）的片段包成 <mark>，返回 React 节点数组和命中数。
// activeIndex 指定当前高亮项，activeRef 挂到该项上以便滚动定位。
function highlightMatches(text, keyword, activeIndex, activeRef) {
  if (!keyword) return { nodes: text, count: 0 };
  const lower = text.toLowerCase();
  const kw = keyword.toLowerCase();
  const nodes = [];
  let from = 0;
  let idx;
  let count = 0;
  while ((idx = lower.indexOf(kw, from)) !== -1) {
    if (idx > from) nodes.push(text.slice(from, idx));
    const isActive = count === activeIndex;
    nodes.push(
      <mark
        key={idx}
        ref={isActive ? activeRef : undefined}
        className={clsx(
          "rounded-sm text-slate-900",
          isActive ? "bg-orange-400 ring-1 ring-orange-500" : "bg-amber-300/70",
        )}
      >
        {text.slice(idx, idx + kw.length)}
      </mark>,
    );
    from = idx + kw.length;
    count += 1;
  }
  if (from < text.length) nodes.push(text.slice(from));
  return { nodes, count };
}

function JsonBlock({ title, value, copyable, searchable }) {
  const text = typeof value === "string" ? value : prettyJson(value);
  const [copied, setCopied] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const activeRef = useRef(null);

  const trimmed = keyword.trim();
  const { nodes, count } = searchable
    ? highlightMatches(text || "", trimmed, activeIndex, activeRef)
    : { nodes: text, count: 0 };

  // 关键字变化后回到第一处匹配
  useEffect(() => {
    setActiveIndex(0);
  }, [trimmed]);

  // 当前匹配项滚动进可视区
  useEffect(() => {
    if (activeRef.current) {
      activeRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [activeIndex, trimmed]);

  if (!text) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      showToast(`复制失败: ${err?.message || "未知错误"}`, "error");
    }
  };

  const goTo = (delta) => {
    if (count === 0) return;
    setActiveIndex((prev) => (prev + delta + count) % count);
  };

  return (
    <div className="flex flex-col gap-1.5 min-h-0">
      <div className="flex items-center gap-2">
        <div className="text-xs font-medium text-slate-600">{title}</div>
        {searchable && (
          <div className="ml-auto flex items-center gap-1">
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  goTo(e.shiftKey ? -1 : 1);
                }
              }}
              placeholder="查找关键字"
              className="w-36 bg-card border border-border rounded px-2 py-0.5 text-[11px] text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500"
            />
            {trimmed && (
              <span className="text-[10.5px] text-slate-400 tabular-nums min-w-[52px] text-center">
                {count > 0 ? `${activeIndex + 1}/${count}` : "无匹配"}
              </span>
            )}
            <button
              type="button"
              onClick={() => goTo(-1)}
              disabled={count === 0}
              title="上一个 (Shift+Enter)"
              className="px-1.5 py-0.5 rounded border text-[10.5px] font-medium bg-card text-slate-600 border-border hover:bg-hover disabled:opacity-40 disabled:cursor-not-allowed"
            >
              ↑
            </button>
            <button
              type="button"
              onClick={() => goTo(1)}
              disabled={count === 0}
              title="下一个 (Enter)"
              className="px-1.5 py-0.5 rounded border text-[10.5px] font-medium bg-card text-slate-600 border-border hover:bg-hover disabled:opacity-40 disabled:cursor-not-allowed"
            >
              ↓
            </button>
          </div>
        )}
        {copyable && (
          <button
            type="button"
            onClick={copy}
            className={clsx(
              "px-2 py-0.5 rounded border text-[10.5px] font-medium bg-card text-slate-600 border-border hover:bg-hover",
              searchable ? "" : "ml-auto",
            )}
          >
            {copied ? "✓ 已复制" : "📋 复制"}
          </button>
        )}
      </div>
      <pre className="text-[11px] leading-relaxed font-mono text-slate-800 bg-[#fafbfc] border border-border rounded-lg p-3 overflow-auto max-h-72 whitespace-pre-wrap break-all">
        {nodes}
      </pre>
    </div>
  );
}

function defaultSceneName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `录制 ${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// 把一条历史转成 mock 规则；响应体超限未记录的无法固化，返回 null 由调用方跳过。
function entryToRule(entry) {
  if (entry.responseTruncated || entry.responseBody === undefined) return null;
  return {
    enabled: true,
    method: entry.method,
    // 命中过 swagger 路由的用带 {param} 的模板，规则能覆盖同类请求
    path: entry.matchedPath || entry.path,
    ...(entry.status && entry.status !== 200 && entry.kind !== "miss"
      ? { status: entry.status }
      : {}),
    response: entry.responseBody,
  };
}

/**
 * 批量「存入场景」弹窗：新建一个场景，或选一个已有场景把选中接口按
 * method + path 覆盖进去（场景里的其它规则保留）。
 */
function SaveToSceneModal({ entries, onClose, onSaved }) {
  const [mode, setMode] = useState("create");
  const [name, setName] = useState(defaultSceneName);
  const [scenes, setScenes] = useState([]);
  const [target, setTarget] = useState("");
  const [saving, setSaving] = useState(false);

  // 只在挂载时拉一次场景列表（父组件按 open 条件挂载，每次打开都是新实例）
  useEffect(() => {
    window.electronAPI.listMockScenes().then((result) => {
      setScenes(result?.scenes || []);
    });
  }, []);

  const rules = entries.map(entryToRule).filter(Boolean);
  const skipped = entries.length - rules.length;
  const sceneName = mode === "create" ? name.trim() : target;
  const canSave = !!sceneName && rules.length > 0 && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    const result = await window.electronAPI.addRulesToMockScene(
      sceneName,
      rules,
      mode === "create" ? "create" : "merge",
    );
    setSaving(false);
    if (!result?.success) {
      showToast(`存入场景失败: ${result?.error || "未知错误"}`, "error");
      return;
    }
    showToast(
      mode === "create"
        ? `已创建场景「${result.name}」，写入 ${result.total} 条规则`
        : `已写入场景「${result.name}」：新增 ${result.added} 条，覆盖 ${result.overwritten} 条`,
      "success",
    );
    onSaved();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="存入场景"
      srOnly={false}
      className="w-[460px] max-w-[calc(100vw-2rem)]"
    >
      <div className="p-5 flex flex-col gap-4">
        <div className="text-xs text-slate-500">
          已选 <span className="font-semibold text-slate-700">{entries.length}</span> 条请求，
          其中 <span className="font-semibold text-slate-700">{rules.length}</span> 条可固化成规则
          {skipped > 0 && (
            <span className="text-amber-700">（{skipped} 条响应体未记录，将跳过）</span>
          )}
        </div>

        <div className="flex items-center rounded-md border border-border overflow-hidden self-start">
          {[
            { key: "create", label: "新建场景" },
            { key: "merge", label: "写入已有场景" },
          ].map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setMode(item.key)}
              className={clsx(
                "px-3 py-1 text-[11px] font-medium transition-colors",
                mode === item.key
                  ? "bg-sky-400/15 text-sky-700"
                  : "bg-card text-slate-500 hover:bg-hover hover:text-slate-900",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        {mode === "create" ? (
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-600">场景名</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
              }}
              placeholder="场景名"
              className="w-full bg-card border border-border rounded-md px-3 py-1.5 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500 transition-colors"
            />
            <span className="text-[11px] text-slate-400">
              场景名已存在时会保存失败，改用「写入已有场景」。
            </span>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-600">选择场景</label>
            {scenes.length === 0 ? (
              <div className="text-[11px] text-slate-400 py-2">
                还没有任何场景，先用「新建场景」创建一个。
              </div>
            ) : (
              <div className="max-h-52 overflow-y-auto flex flex-col gap-1 border border-border rounded-md p-1">
                {scenes.map((scene) => (
                  <label
                    key={scene.name}
                    className={clsx(
                      "flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors",
                      target === scene.name ? "bg-sky-400/[0.08]" : "hover:bg-hover",
                    )}
                  >
                    <input
                      type="radio"
                      name="scene-target"
                      checked={target === scene.name}
                      onChange={() => setTarget(scene.name)}
                      className="accent-sky-500"
                    />
                    <span className="text-xs text-slate-900 truncate">{scene.name}</span>
                    <span className="ml-auto text-[10.5px] text-slate-400 shrink-0">
                      {scene.ruleCount} 条
                    </span>
                  </label>
                ))}
              </div>
            )}
            <span className="text-[11px] text-slate-400">
              场景里已有同 method + path 的接口就替换掉那一条，没有就新增一条；
              其它规则原样保留。
            </span>
          </div>
        )}
      </div>

      <div className="shrink-0 flex items-center justify-end gap-2 px-5 py-3.5 border-t border-border bg-slate-50/50">
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 rounded-md border text-xs font-medium bg-card text-slate-600 border-border hover:bg-hover transition-colors"
        >
          取消
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!canSave}
          className="px-3 py-1.5 rounded-md border text-xs font-semibold bg-emerald-400/10 text-emerald-700 border-emerald-400/35 hover:bg-emerald-400/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
    </Modal>
  );
}

/**
 * 录制控件：未录制时是「⏺ 录制」按钮（mock 未运行则禁用）；
 * 点击后就地展开场景名输入；录制中变成红色停止按钮 + 实时计数。
 */
function RecordingControl() {
  const recording = useMockRecording();
  const mockStatus = useStatus(MOCK_ID);
  const [configuring, setConfiguring] = useState(false);
  const [name, setName] = useState("");
  const [excludeMock, setExcludeMock] = useState(false);
  const mockRunning = mockStatus === "running";

  const openConfig = () => {
    setName(defaultSceneName());
    setExcludeMock(false);
    setConfiguring(true);
  };

  const start = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const result = await startMockRecording(trimmed, excludeMock);
    if (!result?.success) {
      showToast(`开始录制失败: ${result?.error || "未知错误"}`, "error");
      return;
    }
    setConfiguring(false);
    showToast(
      excludeMock
        ? `开始录制到场景「${trimmed}」，仅固化经过代理的真实响应`
        : `开始录制到场景「${trimmed}」，代理响应与命中的 mock 都会被固化`,
      "success",
    );
  };

  const stop = async () => {
    const result = await stopMockRecording();
    if (!result?.success) {
      showToast(`停止失败: ${result?.error || "未知错误"}`, "error");
      return;
    }
    showToast(
      `录制结束：${result.count ?? 0} 条规则已存入场景「${result.sceneName}」`,
      "success",
    );
  };

  if (recording.enabled) {
    return (
      <button
        type="button"
        onClick={stop}
        title={`正在录制到场景「${recording.sceneName}」，点击停止`}
        className="px-3 py-1 rounded-md border text-xs font-medium bg-red-400/15 text-red-700 border-red-400/40 hover:bg-red-400/25 animate-pulse"
      >
        ⏹ 停止录制 · {recording.count || 0} 条
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        disabled={!mockRunning}
        onClick={openConfig}
        title={
          mockRunning
            ? "把请求响应录制成 mock 场景（默认含命中的 mock，可配置排除；在 Mock 配置页可应用）"
            : "需要 mock 运行中才能录制"
        }
        className="px-3 py-1 rounded-md border text-xs font-medium bg-red-400/10 text-red-700 border-red-400/30 hover:bg-red-400/20 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        ⏺ 录制
      </button>

      <Modal
        open={configuring}
        onClose={() => setConfiguring(false)}
        title="配置录制"
        srOnly={false}
        className="w-[440px] max-w-[calc(100vw-2rem)]"
      >
        <div className="p-5 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-600">场景名</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") start();
              }}
              placeholder="场景名"
              className="w-full bg-card border border-border rounded-md px-3 py-1.5 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500 transition-colors"
            />
          </div>

          <label className="flex items-start gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={excludeMock}
              onChange={(e) => setExcludeMock(e.target.checked)}
              className="accent-red-500 mt-0.5"
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-xs font-medium text-slate-700">排除 mock</span>
              <span className="text-[11px] text-slate-400 leading-snug">
                默认不勾：代理响应与命中的 mock 都会被固化。勾选后只录经过代理的真实后端响应，跳过命中现有 mock 规则的请求。
              </span>
            </span>
          </label>
        </div>

        <div className="shrink-0 flex items-center justify-end gap-2 px-5 py-3.5 border-t border-border bg-slate-50/50">
          <button
            type="button"
            onClick={() => setConfiguring(false)}
            className="px-3 py-1.5 rounded-md border text-xs font-medium bg-card text-slate-600 border-border hover:bg-hover transition-colors"
          >
            取消
          </button>
          <button
            type="button"
            onClick={start}
            disabled={!name.trim()}
            className="px-3 py-1.5 rounded-md border text-xs font-semibold bg-red-400/10 text-red-700 border-red-400/30 hover:bg-red-400/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            ⏺ 开始录制
          </button>
        </div>
      </Modal>
    </>
  );
}

function HistoryDetail({ entry }) {
  const navigate = useNavigate();

  if (!entry) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-slate-400">
        选择一条请求查看详情
      </div>
    );
  }

  // MISS 也允许生成规则——这正是「接口不在 swagger 里但想 mock」的场景，
  // 只是没有响应体可预填。响应体超限（truncated）时才禁用。
  const canGenerate = !entry.responseTruncated;

  const generateRule = () => {
    navigate("/mock-config", {
      state: {
        draft: {
          method: entry.method,
          // 命中过 route 的用带 {param} 的模板路径，规则能覆盖同类请求
          path: entry.matchedPath || entry.path,
          ...(entry.status && entry.status !== 200 && entry.kind !== "miss"
            ? { status: entry.status }
            : {}),
          ...(entry.responseBody !== undefined
            ? { response: entry.responseBody }
            : {}),
        },
      },
    });
  };

  return (
    <div className="min-w-0 min-h-0 flex flex-col overflow-hidden">
      <div className="p-4 border-b border-border flex items-center gap-2.5">
        <KindBadge kind={entry.kind} />
        <span className="text-xs font-semibold text-slate-900">
          {entry.method}
        </span>
        <span className="text-xs text-slate-900 truncate" title={entry.path}>
          {entry.path}
        </span>
        <button
          type="button"
          onClick={generateRule}
          disabled={!canGenerate}
          title={
            canGenerate
              ? "以这次请求的 method / path / 响应为初始值创建 mock 规则"
              : "响应体过大未记录，无法生成规则"
          }
          className={clsx(
            "ml-auto shrink-0 px-3 py-1.5 rounded-md border text-xs font-medium",
            "bg-emerald-400/10 text-emerald-700 border-emerald-400/35 hover:bg-emerald-400/20",
            "disabled:opacity-40 disabled:cursor-not-allowed",
          )}
        >
          ⚡ 生成 mock 规则
        </button>
      </div>

      <div className="px-4 py-2.5 border-b border-border flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
        <span>
          状态{" "}
          <span
            className={clsx(
              "font-medium",
              entry.status >= 400 ? "text-red-600" : "text-slate-700",
            )}
          >
            {entry.status}
          </span>
        </span>
        <span>
          耗时 <span className="text-slate-700">{entry.durationMs}ms</span>
        </span>
        <span>
          时间 <span className="text-slate-700">{formatTime(entry.ts)}</span>
        </span>
        {entry.matchedPath && entry.matchedPath !== entry.path && (
          <span>
            匹配路由 <span className="text-slate-700">{entry.matchedPath}</span>
          </span>
        )}
        {entry.source && (
          <span className="truncate max-w-full">
            来源 <span className="text-slate-700">{entry.source}</span>
          </span>
        )}
        {entry.variant && (
          <span className="truncate max-w-full">
            变体 <span className="text-violet-700">{entry.variant}</span>
          </span>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-4">
        {Object.keys(entry.query || {}).length > 0 && (
          <JsonBlock title="Query" value={entry.query} />
        )}
        {entry.requestBody !== undefined && (
          <JsonBlock title="Request Body" value={entry.requestBody} />
        )}
        {entry.responseTruncated && entry.responseBody === undefined ? (
          <div className="text-[11px] text-amber-700 bg-amber-400/10 border border-amber-400/40 rounded-lg px-3 py-2">
            响应体超过记录上限，未保存内容
          </div>
        ) : (
          <JsonBlock title="Response" value={entry.responseBody} copyable searchable />
        )}
        {entry.kind === "miss" && (
          <div className="text-[11px] text-slate-500">
            该请求未命中任何 swagger 路由。点「生成 mock 规则」可以为它补一条自定义
            mock。
          </div>
        )}
      </div>
    </div>
  );
}

export default function MockHistoryPage() {
  const entries = useMockHistory();
  const [selectedId, setSelectedId] = useState(null);
  const [filter, setFilter] = useState("all");
  const [keyword, setKeyword] = useState("");
  // 批量勾选（存入场景用），与详情选中的 selectedId 相互独立
  const [checkedIds, setCheckedIds] = useState([]);
  const [savingScene, setSavingScene] = useState(false);

  // 打开面板时全量拉一次（历史 + 录制状态），补齐打开前 / 窗口刷新前的状态；之后靠事件推送
  const { loading } = useResource(
    () => Promise.all([loadMockHistory(), loadMockRecording()]),
    [],
  );

  const normalizedKeyword = keyword.trim().toLowerCase();
  const filtered = entries.filter(
    (entry) =>
      matchFilter(entry, filter) &&
      (!normalizedKeyword ||
        `${entry.method} ${entry.path}`.toLowerCase().includes(normalizedKeyword)),
  );
  // 最新的排最上面
  const listed = [...filtered].reverse();
  const selected = entries.find((entry) => entry.id === selectedId) || null;

  // 勾选过但已被筛掉 / 被历史上限挤掉的记录不参与批量操作
  const checkedEntries = listed.filter((entry) => checkedIds.includes(entry.id));
  const allChecked = listed.length > 0 && checkedEntries.length === listed.length;

  const toggleCheck = (id) => {
    setCheckedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  };

  const toggleCheckAll = () => {
    setCheckedIds(allChecked ? [] : listed.map((entry) => entry.id));
  };

  const handleClear = async () => {
    const result = await clearMockHistory();
    if (!result?.success) {
      showToast(`清空失败: ${result?.error || "未知错误"}`, "error");
      return;
    }
    setSelectedId(null);
    setCheckedIds([]);
    showToast("请求历史已清空", "success");
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-base">
      <header className="h-[50px] shrink-0 flex items-center gap-3 px-4 border-b border-border">
        <div>
          <div className="text-sm font-semibold text-slate-900">请求历史</div>
          <div className="text-[11px] text-slate-500">
            mock server 最近 {entries.length} 条请求
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <RecordingControl />
          <div className="flex items-center rounded-md border border-border overflow-hidden">
            {FILTERS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setFilter(item.key)}
                className={clsx(
                  "px-2.5 py-1 text-[11px] font-medium transition-colors",
                  filter === item.key
                    ? "bg-sky-400/15 text-sky-700"
                    : "bg-card text-slate-500 hover:bg-hover hover:text-slate-900",
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索 method / path"
            className="w-44 bg-card border border-border rounded-md px-2.5 py-1 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500"
          />
          <button
            type="button"
            onClick={handleClear}
            disabled={entries.length === 0}
            className="px-3 py-1 rounded-md border text-xs font-medium bg-red-400/10 text-red-700 border-red-400/30 hover:bg-red-400/20 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            清空
          </button>
        </div>
      </header>

      <div className="flex-1 min-h-0 grid grid-cols-[360px_1fr] overflow-hidden">
        <div className="min-h-0 flex flex-col border-r border-border">
          {listed.length > 0 && (
            <div className="shrink-0 flex items-center gap-2 px-2.5 py-1.5 border-b border-border bg-card">
              <label className="flex items-center gap-1.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={toggleCheckAll}
                  className="accent-sky-500"
                />
                <span className="text-[11px] text-slate-500">全选</span>
              </label>
              {checkedEntries.length > 0 && (
                <>
                  <span className="text-[11px] text-slate-500">
                    已选 {checkedEntries.length} 条
                  </span>
                  <button
                    type="button"
                    onClick={() => setCheckedIds([])}
                    className="text-[11px] text-slate-400 hover:text-slate-700"
                  >
                    取消
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => setSavingScene(true)}
                disabled={checkedEntries.length === 0}
                title="把选中的接口存成新场景，或写入已有场景（只替换同名接口）"
                className="ml-auto px-2.5 py-1 rounded-md border text-[11px] font-medium bg-emerald-400/10 text-emerald-700 border-emerald-400/35 hover:bg-emerald-400/20 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                📥 存入场景
              </button>
            </div>
          )}

          <div className="flex-1 min-h-0 overflow-y-auto p-2">
          {listed.length === 0 && (
            <div className="px-2 py-8 text-center text-xs text-slate-400">
              {loading
                ? "加载中…"
                : entries.length === 0
                  ? "还没有请求记录。启动 mock 后，经过它的每个请求都会出现在这里。"
                  : "没有匹配当前筛选的请求"}
            </div>
          )}
          {listed.map((entry) => (
            <HistoryListItem
              key={entry.id}
              entry={entry}
              selected={entry.id === selectedId}
              checked={checkedIds.includes(entry.id)}
              onSelect={() => setSelectedId(entry.id)}
              onToggleCheck={() => toggleCheck(entry.id)}
            />
          ))}
          </div>
        </div>

        <HistoryDetail entry={selected} />
      </div>

      {savingScene && (
        <SaveToSceneModal
          entries={checkedEntries}
          onClose={() => setSavingScene(false)}
          onSaved={() => {
            setSavingScene(false);
            setCheckedIds([]);
          }}
        />
      )}
    </div>
  );
}
