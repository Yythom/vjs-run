import { useEffect, useState } from "react";

export default function CleanModal({
  open,
  state,
  logs,
  repoLabel,
  repoPath,
  onRun,
  onClose,
}) {
  const [autoInstall, setAutoInstall] = useState(false);

  useEffect(() => {
    if (open) setAutoInstall(false);
  }, [open]);

  if (!open) return null;

  const running = state === "starting" || state === "running";

  const statusText =
    state === "starting"
      ? "清理中…"
      : state === "stopped"
        ? "清理完成"
        : state === "error"
          ? "出错"
          : "就绪";

  const dotClass =
    state === "starting"
      ? "starting"
      : state === "stopped"
        ? "running"
        : state === "error"
          ? "error"
          : "stopped";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0, 0, 0, 0.55)", backdropFilter: "blur(2px)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !running) onClose();
      }}
    >
      <div
        className="bg-panel border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{ width: 640, maxWidth: "92vw", height: 480, maxHeight: "90vh" }}
      >
        <div className="flex items-center gap-2.5 px-5 py-3.5 border-b border-border flex-shrink-0">
          <span className={`status-dot ${dotClass}`}></span>
          <h2 className="text-sm font-semibold text-slate-200">
            🧹 清理 Monorepo
          </h2>
          <span className="text-xs text-slate-500 ml-1">{statusText}</span>

          <div className="ml-auto flex items-center gap-2">
            {(state === "stopped" || state === "error") && (
              <button
                type="button"
                onClick={() => onRun({ autoInstall })}
                className="px-3 py-1 rounded-md border text-xs font-medium cursor-pointer transition-all bg-card text-slate-400 border-border hover:bg-hover hover:text-slate-200"
              >
                🧹 清理
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              disabled={running}
              className="text-slate-500 hover:text-slate-200 transition-colors text-lg leading-none cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
              aria-label="关闭清理弹窗"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="px-5 py-2 border-b border-border flex-shrink-0 flex gap-3 flex-wrap">
          <span className="text-[11px] text-slate-400">{repoLabel}</span>
          {repoPath ? (
            <span className="text-[11px] text-slate-600 font-mono truncate max-w-full">
              {repoPath}
            </span>
          ) : (
            <span className="text-[11px] text-amber-400">
              请先在设置中配置仓库路径
            </span>
          )}
        </div>

        <div className="px-5 py-2 border-b border-border flex-shrink-0 flex gap-3 flex-wrap">
          <span className="text-[11px] text-slate-600 font-mono">
            node_modules
          </span>
          <span className="text-[11px] text-slate-700">·</span>
          <span className="text-[11px] text-slate-600 font-mono">dist</span>
          <span className="text-[11px] text-slate-700">·</span>
          <span className="text-[11px] text-slate-600 font-mono">.turbo</span>
          <span className="text-[11px] text-slate-700">·</span>
          <span className="text-[11px] text-slate-600 font-mono">build</span>
        </div>

        <div
          className="flex-1 overflow-y-auto px-4 py-3 font-mono text-[12px] leading-relaxed text-slate-300 whitespace-pre-wrap break-all"
          style={{ background: "#090f1a" }}
        >
          {logs.length === 0 ? (
            <span className="text-slate-600 text-xs">
              点击「🧹 清理」按钮开始清理…
            </span>
          ) : (
            logs.map((line, index) => (
              <span
                key={`clean-log-${index}`}
                dangerouslySetInnerHTML={{ __html: line }}
              />
            ))
          )}
        </div>

        <div className="flex items-center justify-between px-5 py-3 border-t border-border flex-shrink-0">
          <label className="flex items-center gap-2 cursor-pointer select-none group">
            <input
              type="checkbox"
              checked={autoInstall}
              onChange={(e) => setAutoInstall(e.target.checked)}
              className="accent-violet-500 w-3.5 h-3.5 cursor-pointer"
            />
            <span className="text-xs text-slate-500 group-hover:text-slate-300 transition-colors">
              清理完成后自动执行 pnpm install
            </span>
          </label>

          <button
            type="button"
            onClick={onClose}
            disabled={running}
            className="px-4 py-1.5 rounded-md border text-xs font-medium cursor-pointer transition-all bg-card text-slate-400 border-border hover:bg-hover hover:text-slate-200 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
