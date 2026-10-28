import LogTerminal from "../components/log-terminal";
import * as logStore from "../stores/log-store";
import { showToast } from "../utils/toast";
import { isEnterKey } from "../utils/keyboard";
import clsx from "../utils/clsx";

/**
 * 通用的「右侧详情面板」外壳：顶部 meta + 终端 + 可选 debug 输入。
 * 不绑定具体业务（项目 / mock），由调用方组装 detail + handlers。
 */
export default function DetailPanel({
  paneKey,
  detail,
  primaryAction, // { label, onClick, variant }，启动或停止按钮；variant 为 "stop" 时显示停止样式
  onClearLog,
  debugInput, // 可选：{ value, onChange, onRun, placeholder }
  extraActions, // 可选：自定义的额外操作按钮
}) {
  const handleExportLog = async () => {
    const logText = logStore.get(paneKey);
    if (!logText || !logText.trim()) {
      showToast("当前面板没有可导出的日志", "warning");
      return;
    }
    const defaultFilename = `${detail.name || paneKey}-log-${new Date().toISOString().slice(0, 10)}.log`;
    try {
      // preload 签名是 (logText, defaultFilename) 两个位置参数，不是对象
      const result = await window.electronAPI.exportLog(logText, defaultFilename);
      if (result.success) {
        showToast(`日志已保存至: ${result.filePath}`, "success");
      } else if (result.error !== "canceled") {
        showToast(`导出失败: ${result.error}`, "error");
      }
    } catch (err) {
      showToast(`导出失败: ${err.message}`, "error");
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-white">
      {/* 头部状态条 */}
      <div className="shrink-0 flex items-center gap-2.5 px-4 h-12.5 border-b border-border bg-slate-50/60">
        <div className="text-xs font-bold text-slate-800">{detail.name}</div>
        <div className="text-[11px] text-slate-400 truncate max-w-xs font-mono">
          {detail.filter}
        </div>
        <span
          className={`status-badge ${detail.badgeClass} shrink-0 px-2 py-0.5 rounded-full text-[10.5px] font-semibold tracking-wide border shadow-2xs`}
        >
          {detail.label}
        </span>

        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          {extraActions}
          <button
            type="button"
            onClick={handleExportLog}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-medium cursor-pointer transition-all bg-white text-slate-700 border-slate-200 hover:bg-slate-50 hover:text-slate-900 shadow-2xs"
            title="导出当前面板的所有终端日志"
          >
            <svg className="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
            <span>导出日志</span>
          </button>

          <button
            type="button"
            onClick={onClearLog}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-medium cursor-pointer transition-all bg-white text-slate-700 border-slate-200 hover:bg-slate-50 hover:text-slate-900 shadow-2xs"
            title="清空当前日志面板"
          >
            <svg className="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
            </svg>
            <span>清空</span>
          </button>

          {primaryAction && (
            <button
              type="button"
              onClick={primaryAction.onClick}
              className={clsx(
                "inline-flex items-center gap-1.5 px-3 py-1 rounded-md border text-xs font-semibold cursor-pointer transition-all shadow-2xs",
                primaryAction.variant === "stop"
                  ? "bg-red-50 text-red-700 border-red-200 hover:bg-red-100"
                  : "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100",
              )}
            >
              {primaryAction.variant === "stop" ? (
                <svg className="w-2.5 h-2.5 fill-current" viewBox="0 0 24 24">
                  <rect x="5" y="5" width="14" height="14" rx="2" />
                </svg>
              ) : (
                <svg className="w-2.5 h-2.5 fill-current" viewBox="0 0 24 24">
                  <path d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z" />
                </svg>
              )}
              <span>{primaryAction.label}</span>
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
            className="shrink-0 flex items-center gap-2 px-3.5 py-2 border-t border-border bg-slate-50"
          >
            <input
              value={debugInput.value}
              onChange={(e) => debugInput.onChange(e.target.value)}
              onKeyDown={(e) => {
                if (isEnterKey(e)) {
                  debugInput.onRun();
                  e.target.value = "";
                }
              }}
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder={debugInput.placeholder}
              className="flex-1 min-w-0 bg-white border border-slate-200 rounded-md px-3 py-1.5 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-sky-500 font-mono transition-colors"
            />
            <button
              type="button"
              onClick={debugInput.onRun}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold cursor-pointer transition-all bg-sky-600 text-white hover:bg-sky-700 shadow-2xs"
            >
              <svg className="w-2.5 h-2.5 fill-current" viewBox="0 0 24 24">
                <path d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z" />
              </svg>
              <span>执行</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
