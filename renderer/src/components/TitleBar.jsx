export default function TitleBar({
  onOpenSettings,
  onKillPorts,
  onCloseAgentBrowserSessions,
  onStopAll,
  onOpenEnvCheck,
  onOpenPortChecker,
  closingAgentBrowserSessions,
}) {
  return (
    <div className="drag-region h-10 shrink-0 bg-panel border-b border-border flex items-center pl-20 pr-4 gap-2.5">
      <h1 className="text-xs font-semibold text-slate-400 tracking-wide">
        ⚡ vjtools
      </h1>
      <div className="no-drag-region ml-auto flex gap-2">
        <button
          onClick={onCloseAgentBrowserSessions}
          disabled={closingAgentBrowserSessions}
          className="inline-flex items-center gap-1 px-3 py-1 rounded-md border text-xs font-medium bg-card text-slate-400 border-border hover:bg-hover hover:text-slate-200 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {closingAgentBrowserSessions ? "⏳ 关闭中..." : "🧹 Agent-Browser Sessions"}
        </button>
        <button
          onClick={onKillPorts}
          className="inline-flex items-center gap-1 px-3 py-1 rounded-md border text-xs font-medium bg-card text-slate-400 border-border hover:bg-hover hover:text-slate-200"
        >
          🔌 释放端口
        </button>
        <button
          onClick={onStopAll}
          className="inline-flex items-center gap-1 px-3 py-1 rounded-md border text-xs font-medium bg-red-400/10 text-red-400 border-red-400/30 hover:bg-red-400/20"
        >
          ⏹ 全部停止
        </button>
        <button
          onClick={onOpenEnvCheck}
          className="inline-flex items-center gap-1 px-3 py-1 rounded-md border text-xs font-medium bg-card text-slate-400 border-border hover:bg-hover hover:text-slate-200"
        >
          🔍 体检
        </button>
        <button
          onClick={onOpenPortChecker}
          className="inline-flex items-center gap-1 px-3 py-1 rounded-md border text-xs font-medium bg-card text-slate-400 border-border hover:bg-hover hover:text-slate-200"
        >
          🔌 端口
        </button>
        <button
          onClick={onOpenSettings}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border text-xs font-medium bg-card text-slate-400 border-border hover:bg-hover hover:text-slate-200"
        >
          ⚙️
        </button>
      </div>
    </div>
  );
}
