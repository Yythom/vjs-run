import LogTerminal from "../components/log-terminal";
import * as logStore from "../stores/log-store";
import { showToast } from "../utils/toast";

/**
 * 通用的「右侧详情面板」外壳：顶部 meta + 终端 + 可选 debug 输入。
 * 不绑定具体业务（项目 / mock），由调用方组装 detail + handlers。
 */
export default function DetailPanel({
  paneKey,
  detail,
  primaryAction, // { label, onClick, variant }，启动或停止按钮
  onClearLog,
  debugInput, // 可选：{ value, onChange, onRun, placeholder }
  extraActions, // 可选：自定义的额外操作按钮
}) {
  const handleExportLog = async () => {
    const logText = logStore.get(paneKey);
    if (!logText) {
      showToast("没有日志可导出", "warning");
      return;
    }
    const cleanName = detail.name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, "_");
    const defaultFilename = `${cleanName}_${new Date().toISOString().slice(0, 10)}.log`;
    try {
      const result = await window.electronAPI.exportLog(logText, defaultFilename);
      if (result.success) {
        showToast(`日志已成功导出`, "success");
      } else if (result.error !== "canceled") {
        showToast(`导出失败: ${result.error}`, "error");
      }
    } catch (err) {
      showToast(`导出失败: ${err.message}`, "error");
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="shrink-0 flex items-center gap-2.5 px-4 h-12.5 border-b border-border">
        <div className="text-sm font-semibold">{detail.name}</div>
        <div className="text-[11px] text-slate-500 truncate max-w-xs">
          {detail.filter}
        </div>
        <span
          className={`status-badge ${detail.badgeClass} shrink-0 px-2 py-0.5 rounded-full text-[11px] font-semibold tracking-wide`}
        >
          {detail.label}
        </span>

        <div className="ml-auto flex gap-1.5 shrink-0">
          {extraActions}
          <button
            onClick={handleExportLog}
            className="inline-flex items-center gap-1 px-3 py-1 rounded-md border text-xs font-medium cursor-pointer transition-all bg-card text-slate-600 border-border hover:bg-hover hover:text-slate-900"
            title="导出当前面板的所有终端日志"
          >
            📥 导出日志
          </button>

          <button
            onClick={onClearLog}
            className="inline-flex items-center gap-1 px-3 py-1 rounded-md border text-xs font-medium cursor-pointer transition-all bg-card text-slate-600 border-border hover:bg-hover hover:text-slate-900"
          >
            🗑 清空
          </button>

          {primaryAction && (
            <button
              onClick={primaryAction.onClick}
              className={
                primaryAction.variant === "stop"
                  ? "inline-flex items-center gap-1 px-3 py-1 rounded-md border text-xs font-medium cursor-pointer transition-all bg-red-400/10 text-red-700 border-red-400/30 hover:bg-red-400/20"
                  : primaryAction.variant === "mock-start"
                    ? "inline-flex items-center gap-1 px-3 py-1 rounded-md border text-xs font-medium cursor-pointer transition-all bg-emerald-400/10 text-emerald-700 border-emerald-400/35 hover:bg-emerald-400/20"
                    : "inline-flex items-center gap-1 px-3 py-1 rounded-md border text-xs font-medium cursor-pointer transition-all bg-green-400/10 text-green-700 border-green-400/30 hover:bg-green-400/20"
              }
            >
              {primaryAction.label}
            </button>
          )}
        </div>
      </div>

      <div
        className="flex-1 overflow-hidden flex flex-col"
        style={{ background: "#fafbfc" }}
      >
        <LogTerminal paneKey={paneKey} logTitle={detail.logTitle} />

        {debugInput && (
          <div
            className="shrink-0 flex items-center gap-2 px-3.5 py-2 border-t border-border"
            style={{ background: "#f1f5f9" }}
          >
            <input
              value={debugInput.value}
              onChange={(e) => debugInput.onChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  debugInput.onRun();
                  e.target.value = "";
                }
              }}
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder={debugInput.placeholder}
              className="flex-1 min-w-0 bg-card border border-border rounded-md px-3 py-1.5 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500 transition-colors"
            />
            <button
              onClick={debugInput.onRun}
              className="inline-flex items-center gap-1 px-3 py-1 rounded-md border text-xs font-medium cursor-pointer transition-all bg-blue-500/20 text-blue-700 border-blue-500/40 hover:bg-blue-500/30"
            >
              ▶ 执行
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
