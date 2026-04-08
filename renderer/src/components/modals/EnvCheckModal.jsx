import { useEffect, useState } from "react";
import { ENV_ICONS } from "../../constants";

export default function EnvCheckModal({ open, onClose, onError }) {
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]);

  const runEnvCheck = async () => {
    setLoading(true);
    try {
      const rows = await window.electronAPI.checkEnv();
      setResults(Array.isArray(rows) ? rows : []);
    } catch (err) {
      onError?.(err?.message || "未知错误");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    runEnvCheck();
  }, [open]);

  if (!open) return null;

  const missingCount = results.filter(
    (item) => item.status === "missing",
  ).length;

  const tipText = loading
    ? "检测中…"
    : missingCount === 0
      ? `全部正常 (${results.length}/${results.length})`
      : `${missingCount} 项未安装`;

  const tipColor = loading
    ? "#94a3b8"
    : missingCount === 0
      ? "#4ade80"
      : "#f87171";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0, 0, 0, 0.55)", backdropFilter: "blur(2px)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="bg-panel border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{ width: 560, maxWidth: "92vw" }}
      >
        <div className="flex items-center gap-2.5 px-5 py-3.5 border-b border-border flex-shrink-0">
          <h2 className="text-sm font-semibold text-slate-200">
            🔍 开发环境体检
          </h2>
          <span className="text-xs ml-1" style={{ color: tipColor }}>
            {tipText}
          </span>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={runEnvCheck}
              disabled={loading}
              className="px-3 py-1 rounded-md border text-xs font-medium cursor-pointer transition-all bg-card text-slate-400 border-border hover:bg-hover hover:text-slate-200 disabled:opacity-50"
            >
              🔄 重新检测
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-slate-500 hover:text-slate-200 transition-colors text-lg leading-none cursor-pointer"
              aria-label="关闭体检弹窗"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="px-5 py-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {loading ? (
            <div className="col-span-2 sm:col-span-3 text-center py-6 text-slate-600 text-xs">
              正在检测，请稍候…
            </div>
          ) : (
            results.map((item) => {
              const ok = item.status === "ok";
              return (
                <div
                  key={item.id}
                  className={`flex flex-col gap-1.5 rounded-lg border px-4 py-3 ${
                    ok
                      ? "bg-card border-border"
                      : "bg-red-500/5 border-red-500/20"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span
                      className={`text-sm font-semibold ${ok ? "text-slate-200" : "text-red-400"}`}
                    >
                      {ENV_ICONS[item.id] || "🔧"} {item.label}
                    </span>
                    <span
                      className={`status-dot ${ok ? "running" : "error"}`}
                      style={{ flexShrink: 0 }}
                    />
                  </div>

                  <span
                    className={`font-mono text-[11px] ${ok ? "text-slate-300" : "text-red-400/70"}`}
                  >
                    {ok ? item.version : "未安装"}
                  </span>
                  <span className="text-[10px] text-slate-600 font-mono truncate">
                    {item.cmd}
                  </span>
                </div>
              );
            })
          )}
        </div>

        <div className="flex justify-end px-5 py-3 border-t border-border flex-shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-md border text-xs font-medium cursor-pointer transition-all bg-card text-slate-400 border-border hover:bg-hover hover:text-slate-200"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
