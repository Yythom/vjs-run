import { useEffect, useState } from "react";

export default function PortCheckerModal({
  open,
  defaultWatchedPorts = [],
  onClose,
  onToast,
}) {
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState([]);
  const [watchedPorts, setWatchedPorts] = useState(defaultWatchedPorts);
  const [customPort, setCustomPort] = useState("");

  useEffect(() => {
    setWatchedPorts(defaultWatchedPorts || []);
  }, [defaultWatchedPorts]);

  const runPortCheck = async () => {
    setLoading(true);
    try {
      const result = await window.electronAPI.checkPorts(watchedPorts);
      setRows(result || []);
    } finally {
      setLoading(false);
    }
  };

  const addCustomPort = () => {
    const port = Number(customPort.trim());
    if (!port || port < 1 || port > 65535) {
      onToast?.("请输入 1–65535 范围内的端口号", "warning");
      return;
    }

    if (watchedPorts.includes(port)) {
      onToast?.(`端口 ${port} 已在列表中`, "info");
      setCustomPort("");
      return;
    }

    setWatchedPorts((prev) => [...prev, port]);
    setCustomPort("");
  };

  const handleKillPort = async (port) => {
    const result = await window.electronAPI.killSinglePort(port);
    if (result.success) {
      onToast?.(`端口 ${port} 已释放`, "success");
      await runPortCheck();
    } else {
      onToast?.(`kill 失败: ${result.error}`, "error");
    }
  };

  useEffect(() => {
    if (!open) return;
    runPortCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, watchedPorts]);

  if (!open) return null;

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
        style={{ width: 560, maxWidth: "92vw", maxHeight: "90vh" }}
      >
        <div className="flex items-center gap-2.5 px-5 py-3.5 border-b border-border flex-shrink-0">
          <h2 className="text-sm font-semibold text-slate-200">
            🔌 端口占用查看器
          </h2>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={runPortCheck}
              disabled={loading}
              className="px-3 py-1 rounded-md border text-xs font-medium cursor-pointer transition-all bg-card text-slate-400 border-border hover:bg-hover hover:text-slate-200 disabled:opacity-50"
            >
              🔄 刷新
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-slate-500 hover:text-slate-200 transition-colors text-lg leading-none cursor-pointer"
              aria-label="关闭端口查看器"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="flex items-center px-5 py-2 border-b border-border bg-card text-[11px] text-slate-500 font-medium uppercase tracking-wide">
            <span className="w-20">端口</span>
            <span className="w-20">状态</span>
            <span className="flex-1">进程</span>
            <span className="w-16 text-center">PID</span>
            <span className="w-16 text-right">操作</span>
          </div>

          {loading ? (
            <div className="px-5 py-6 text-center text-slate-600 text-xs">
              扫描中…
            </div>
          ) : !rows || rows.length === 0 ? (
            <div className="px-5 py-6 text-center text-slate-600 text-xs">
              暂无端口数据
            </div>
          ) : (
            rows.map((row) => (
              <div
                key={row.port}
                className="flex items-center px-5 py-2.5 border-b border-border last:border-0 hover:bg-card/50 transition-colors"
              >
                <span className="w-20 font-mono text-xs text-slate-200 font-semibold">
                  {row.port}
                </span>

                <span className="w-20">
                  <span
                    className={`inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded ${
                      row.inUse
                        ? "text-red-400 bg-red-400/10"
                        : "text-green-400 bg-green-400/10"
                    }`}
                  >
                    <span
                      className={`status-dot ${row.inUse ? "error" : "stopped"}`}
                      style={{ width: 6, height: 6, minWidth: 6 }}
                    />
                    {row.inUse ? "占用" : "空闲"}
                  </span>
                </span>

                <span
                  className={`flex-1 text-xs font-mono truncate ${
                    row.inUse ? "text-slate-300" : "text-slate-600"
                  }`}
                >
                  {row.inUse && row.name ? row.name : "—"}
                </span>

                <span
                  className={`w-16 text-center text-xs font-mono ${
                    row.inUse ? "text-slate-400" : "text-slate-600"
                  }`}
                >
                  {row.inUse && row.pid ? row.pid : "—"}
                </span>

                <span className="w-16 text-right">
                  {row.inUse ? (
                    <button
                      type="button"
                      onClick={() => handleKillPort(row.port)}
                      className="text-[11px] px-2 py-0.5 rounded border cursor-pointer text-red-400 border-red-400/30 bg-red-400/10 hover:bg-red-400/20 transition-colors"
                    >
                      kill
                    </button>
                  ) : null}
                </span>
              </div>
            ))
          )}
        </div>

        <div className="flex items-center gap-2 px-5 py-3 border-t border-border flex-shrink-0">
          <input
            value={customPort}
            onChange={(e) => setCustomPort(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addCustomPort();
            }}
            type="number"
            min="1"
            max="65535"
            placeholder="添加端口…"
            className="w-32 bg-card border border-border rounded-md px-3 py-1.5 text-xs font-mono text-slate-200 placeholder-slate-600 outline-none focus:border-slate-500 transition-colors"
          />
          <button
            type="button"
            onClick={addCustomPort}
            className="px-3 py-1.5 rounded-md border text-xs font-medium cursor-pointer transition-all bg-card text-slate-400 border-border hover:bg-hover hover:text-slate-200"
          >
            + 添加
          </button>

          <div className="ml-auto">
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
    </div>
  );
}
