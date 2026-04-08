import { PROXY_ID } from "../constants";

function WelcomePanel() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3.5 text-slate-500">
      <div className="text-[44px] opacity-35">🚀</div>
      <h2 className="text-[17px] font-semibold text-slate-400">
        选择一个项目或服务端
      </h2>
      <p className="text-sm">从左侧列表选择，点击 ▶ / 🚀 启动</p>
    </div>
  );
}

export default function DetailPanel({
  selectedId,
  detail,
  logs,
  debugCommand,
  setDebugCommand,
  onStart,
  onStop,
  onDeploy,
  onProxyStop,
  onClearLog,
  onRunDebugCommand,
}) {
  if (!selectedId || !detail) return <WelcomePanel />;

  const isProxy = selectedId === PROXY_ID;
  const isActive = detail.status === "running" || detail.status === "starting";
  const currentLogs = logs[selectedId] || [];

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 顶部详情栏 */}
      <div className="flex-shrink-0 flex items-center gap-2.5 px-4 h-[50px] border-b border-border">
        <div className="text-sm font-semibold">{detail.name}</div>
        <div className="text-[11px] text-slate-500 font-mono truncate max-w-xs">
          {detail.filter}
        </div>
        <span
          className={`status-badge ${detail.badgeClass} flex-shrink-0 px-2 py-0.5 rounded-full text-[11px] font-semibold tracking-wide`}
        >
          {detail.label}
        </span>

        {!isProxy && isActive && (
          <div className="flex items-center gap-1.5 flex-shrink-0 font-mono bg-slate-800/60 border border-border rounded-md px-2.5 py-0.5">
            <span className="text-[10px] text-slate-500 mr-0.5">资源</span>
            <span className="text-[11px] text-cyan-400/80 tabular-nums">
              CPU {detail.cpu ?? "—"}%
            </span>
            <span className="text-[9px] text-slate-600">·</span>
            <span className="text-[11px] text-emerald-400/80 tabular-nums">
              MEM {detail.mem ?? "—"} MB
            </span>
          </div>
        )}

        <div className="ml-auto flex gap-1.5 flex-shrink-0">
          <button
            onClick={onClearLog}
            className="inline-flex items-center gap-1 px-3 py-1 rounded-md border text-xs font-medium cursor-pointer transition-all bg-card text-slate-400 border-border hover:bg-hover hover:text-slate-200"
          >
            🗑 清空
          </button>

          {!isProxy && !isActive && (
            <button
              onClick={onStart}
              className="inline-flex items-center gap-1 px-3 py-1 rounded-md border text-xs font-medium cursor-pointer transition-all bg-green-400/10 text-green-400 border-green-400/30 hover:bg-green-400/20"
            >
              ▶ 启动
            </button>
          )}

          {!isProxy && isActive && (
            <button
              onClick={onStop}
              className="inline-flex items-center gap-1 px-3 py-1 rounded-md border text-xs font-medium cursor-pointer transition-all bg-red-400/10 text-red-400 border-red-400/30 hover:bg-red-400/20"
            >
              ⏹ 停止
            </button>
          )}

          {isProxy && (
            <button
              onClick={onDeploy}
              className="inline-flex items-center gap-1 px-3 py-1 rounded-md border text-xs font-medium cursor-pointer transition-all bg-violet-400/10 text-violet-400 border-violet-400/35 hover:bg-violet-400/20"
            >
              🚀 重新部署
            </button>
          )}

          {isProxy && isActive && (
            <button
              onClick={onProxyStop}
              className="inline-flex items-center gap-1 px-3 py-1 rounded-md border text-xs font-medium cursor-pointer transition-all bg-red-400/10 text-red-400 border-red-400/30 hover:bg-red-400/20"
            >
              ⏹ 停止 proxy
            </button>
          )}
        </div>
      </div>

      {/* 日志终端 */}
      <div
        className="flex-1 overflow-hidden flex flex-col"
        style={{ background: "#09111e" }}
      >
        {/* macOS 风格终端标题栏 */}
        <div
          className="flex-shrink-0 flex items-center gap-2 px-3.5 py-1.5 border-b border-border"
          style={{ background: "#0d1929" }}
        >
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
          <span className="flex-1 text-center text-[11.5px] text-slate-500 font-mono">
            {detail.logTitle}
          </span>
        </div>

        {/* 日志内容区 */}
        <div
          id="log-output"
          className="flex-1 overflow-y-auto px-3.5 py-2.5 font-mono text-xs leading-relaxed text-[#c9d1d9] whitespace-pre-wrap break-all"
        >
          {currentLogs.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-slate-500">
              <svg
                width="38"
                height="38"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="opacity-25"
              >
                <polyline points="4 17 10 11 4 5"></polyline>
                <line x1="12" y1="19" x2="20" y2="19"></line>
              </svg>
              <p className="text-sm">启动后日志将在此显示…</p>
            </div>
          ) : (
            currentLogs.map((line, i) => (
              <span
                key={`${selectedId}-${i}`}
                dangerouslySetInnerHTML={{ __html: line }}
              />
            ))
          )}
        </div>

        {/* 调试命令输入，仅项目可见 */}
        {!isProxy && (
          <div
            className="flex-shrink-0 flex items-center gap-2 px-3.5 py-2 border-t border-border"
            style={{ background: "#0d1929" }}
          >
            <input
              value={debugCommand}
              onChange={(e) => setDebugCommand(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && onRunDebugCommand()}
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="在当前项目目录执行命令（例如: pnpm -v）"
              className="flex-1 min-w-0 bg-card border border-border rounded-md px-3 py-1.5 text-xs font-mono text-slate-200 placeholder-slate-600 outline-none focus:border-slate-500 transition-colors"
            />
            <button
              onClick={onRunDebugCommand}
              className="inline-flex items-center gap-1 px-3 py-1 rounded-md border text-xs font-medium cursor-pointer transition-all bg-blue-500/20 text-blue-400 border-blue-500/40 hover:bg-blue-500/30"
            >
              ▶ 执行
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
