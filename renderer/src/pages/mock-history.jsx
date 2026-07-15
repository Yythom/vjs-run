import { useState } from "react";
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

function HistoryListItem({ entry, selected, onSelect }) {
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

function JsonBlock({ title, value }) {
  const text = typeof value === "string" ? value : prettyJson(value);
  if (!text) return null;
  return (
    <div className="flex flex-col gap-1.5 min-h-0">
      <div className="text-xs font-medium text-slate-600">{title}</div>
      <pre className="text-[11px] leading-relaxed font-mono text-slate-800 bg-[#fafbfc] border border-border rounded-lg p-3 overflow-auto max-h-72 whitespace-pre-wrap break-all">
        {text}
      </pre>
    </div>
  );
}

function defaultSceneName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `录制 ${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/**
 * 录制控件：未录制时是「⏺ 录制」按钮（mock 未运行则禁用）；
 * 点击后就地展开场景名输入；录制中变成红色停止按钮 + 实时计数。
 */
function RecordingControl() {
  const recording = useMockRecording();
  const mockStatus = useStatus(MOCK_ID);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const mockRunning = mockStatus === "running";

  const start = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const result = await startMockRecording(trimmed);
    if (!result?.success) {
      showToast(`开始录制失败: ${result?.error || "未知错误"}`, "error");
      return;
    }
    setNaming(false);
    showToast(`开始录制到场景「${trimmed}」，经过代理的响应会被自动固化`, "success");
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

  if (naming) {
    return (
      <div className="flex items-center gap-1.5">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") start();
            if (e.key === "Escape") setNaming(false);
          }}
          placeholder="场景名"
          className="w-40 bg-card border border-border rounded-md px-2.5 py-1 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500"
        />
        <button
          type="button"
          onClick={start}
          disabled={!name.trim()}
          className="px-2.5 py-1 rounded-md border text-xs font-medium bg-red-400/10 text-red-700 border-red-400/30 hover:bg-red-400/20 disabled:opacity-40"
        >
          开始
        </button>
        <button
          type="button"
          onClick={() => setNaming(false)}
          className="px-2.5 py-1 rounded-md border text-xs font-medium bg-card text-slate-600 border-border hover:bg-hover"
        >
          取消
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      disabled={!mockRunning}
      onClick={() => {
        setName(defaultSceneName());
        setNaming(true);
      }}
      title={
        mockRunning
          ? "把代理到后端的真实响应录制成 mock 场景（在 Mock 配置页可应用）"
          : "需要 mock 运行中才能录制"
      }
      className="px-3 py-1 rounded-md border text-xs font-medium bg-red-400/10 text-red-700 border-red-400/30 hover:bg-red-400/20 disabled:opacity-40 disabled:cursor-not-allowed"
    >
      ⏺ 录制
    </button>
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
          <JsonBlock title="Response" value={entry.responseBody} />
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

  const handleClear = async () => {
    const result = await clearMockHistory();
    if (!result?.success) {
      showToast(`清空失败: ${result?.error || "未知错误"}`, "error");
      return;
    }
    setSelectedId(null);
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
        <div className="min-h-0 overflow-y-auto p-2 border-r border-border">
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
              onSelect={() => setSelectedId(entry.id)}
            />
          ))}
        </div>

        <HistoryDetail entry={selected} />
      </div>
    </div>
  );
}
