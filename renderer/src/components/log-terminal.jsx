import { useState, useLayoutEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import * as logStore from "../stores/log-store";

/**
 * 终端组件 —— 包含日志检索。
 *   - 不接受 buffer prop：直接从 logStore 读 + 订阅
 *   - paneKey 变化时清屏 + 重写 store 里对应 buffer
 *   - 日志增量来自 logStore.subscribe，React 不参与每次更新
 *   - 支持基于 @xterm/addon-search 的日志全文检索与高亮
 *   - 自动保持默认系统终端的滚动行为：正常输出时滚动，用户往上翻阅时不打扰
 */
export default function LogTerminal({ paneKey, className, style, logTitle }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const searchAddonRef = useRef(null);

  const [searchText, setSearchText] = useState("");
  const [prevPaneKey, setPrevPaneKey] = useState(paneKey);

  // 当切换项目/服务时，重置搜索词（使用 render-phase state update 避免 ESLint 报错）
  if (paneKey !== prevPaneKey) {
    setPrevPaneKey(paneKey);
    setSearchText("");
  }

  useLayoutEffect(() => {
    if (!paneKey) return;

    const term = new Terminal({
      fontFamily: "Menlo, Consolas, 'Liberation Mono', monospace",
      fontSize: 12,
      lineHeight: 1.35,
      cursorBlink: false,
      cursorStyle: "bar",
      disableStdin: true,
      convertEol: true,
      scrollback: 5000,
      theme: {
        background: "#fafbfc",
        foreground: "#334155",
        cursor: "#94a3b8",
        selectionBackground: "#cbd5e1",
        black: "#1e293b",
        red: "#dc2626",
        green: "#16a34a",
        yellow: "#ca8a04",
        blue: "#2563eb",
        magenta: "#c026d3",
        cyan: "#0891b2",
        white: "#e2e8f0",
      },
    });

    const fit = new FitAddon();
    term.loadAddon(fit);

    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);

    termRef.current = term;
    searchAddonRef.current = searchAddon;

    term.open(containerRef.current);
    fit.fit();

    // 1. 写入当前 buffer 的快照，若本地为空则向主进程拉取历史缓冲区
    const initial = logStore.get(paneKey);
    if (initial) {
      term.write(initial);
    } else if (window.electronAPI?.getProjectLog) {
      window.electronAPI.getProjectLog(paneKey).then((history) => {
        if (history) {
          logStore.append(paneKey, history);
        }
      });
    }

    requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {}
    });

    // 2. 订阅增量；chunk === null 表示需要重置（截断 / clear）
    const off = logStore.subscribe(paneKey, (chunk, full) => {
      if (chunk === null) {
        term.reset();
        if (full) term.write(full);
      } else {
        term.write(chunk);
      }
    });

    // 容器尺寸变化时 fit
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {}
    });
    ro.observe(containerRef.current);

    return () => {
      off();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      searchAddonRef.current = null;
    };
  }, [paneKey]);

  const handleSearch = (text, isNext = true) => {
    if (!searchAddonRef.current) return;
    if (!text) {
      termRef.current?.clearSelection();
      return;
    }
    if (isNext) {
      searchAddonRef.current.findNext(text, { incremental: true });
    } else {
      searchAddonRef.current.findPrevious(text);
    }
  };

  return (
    <div
      className="flex-1 min-h-0 flex flex-col overflow-hidden"
      style={style || { background: "#fafbfc" }}
    >
      {/* macOS 风格终端标题栏 & 搜索框 (仅在传入 logTitle 时渲染) */}
      {logTitle && (
        <div
          className="shrink-0 flex items-center justify-between px-3.5 py-1.5 border-b border-border bg-slate-100 gap-3 text-xs select-none"
        >
          {/* 左侧 macOS dots 与标题 */}
          <div className="flex items-center gap-2 shrink-0">
            <span
              className="w-2.5 h-2.5 rounded-full"
              style={{ background: "#ff5f57" }}
            />
            <span
              className="w-2.5 h-2.5 rounded-full"
              style={{ background: "#febc2e" }}
            />
            <span
              className="w-2.5 h-2.5 rounded-full"
              style={{ background: "#28c840" }}
            />
            <span className="ml-1 text-[11px] text-slate-500 font-medium truncate max-w-[200px] md:max-w-xs" title={logTitle}>
              {logTitle}
            </span>
          </div>

          {/* 右侧搜索输入框 */}
          <div className="flex items-center gap-1.5 max-w-[240px] flex-1">
            <div className="relative flex-1">
              <input
                type="text"
                value={searchText}
                onChange={(e) => {
                  setSearchText(e.target.value);
                  handleSearch(e.target.value, true);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleSearch(searchText, !e.shiftKey);
                  }
                }}
                placeholder="🔍 搜索日志..."
                className="w-full bg-card border border-border rounded px-2.5 py-0.5 pr-12 text-[10.5px] text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500 focus:bg-card transition-all"
              />
              {searchText && (
                <span className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => handleSearch(searchText, false)}
                    className="w-3.5 h-3.5 flex items-center justify-center rounded hover:bg-hover text-slate-500 cursor-pointer text-[9px]"
                    title="上一个 (Shift+Enter)"
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSearch(searchText, true)}
                    className="w-3.5 h-3.5 flex items-center justify-center rounded hover:bg-hover text-slate-500 cursor-pointer text-[9px]"
                    title="下一个 (Enter)"
                  >
                    ▼
                  </button>
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      <div
        ref={containerRef}
        className={className || "flex-1 min-h-0 px-2 py-2"}
      />
    </div>
  );
}
