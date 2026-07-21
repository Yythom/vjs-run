import { useState } from "react";
import clsx from "../utils/clsx";
import PageShell from "../components/page-shell";
import { DEFAULT_WATCHED_PORTS } from "../constants";
import useResource from "../hooks/use-resource";
import { showToast } from "../utils/toast";
import { useAppConfig, updateAppConfig } from "../stores/app-config-store";

export default function PortCheckerPage() {
  const config = useAppConfig();
  const watchedPorts = config.watchedPorts || DEFAULT_WATCHED_PORTS;
  const [customPort, setCustomPort] = useState("");

  const {
    data: rows = [],
    loading,
    reload: runPortCheck,
  } = useResource(
    async () => (await window.electronAPI.checkPorts(watchedPorts)) || [],
    [watchedPorts],
  );

  const addCustomPort = async () => {
    const port = Number(customPort.trim());
    if (!port || port < 1 || port > 65535) {
      showToast("请输入 1–65535 范围内的端口号", "warning");
      return;
    }
    if (watchedPorts.includes(port)) {
      showToast(`端口 ${port} 已在列表中`, "info");
      setCustomPort("");
      return;
    }
    try {
      await updateAppConfig({ watchedPorts: [...watchedPorts, port] });
      setCustomPort("");
    } catch (err) {
      showToast(`保存端口失败: ${err.message}`, "error");
    }
  };

  const handleRemovePort = async (port) => {
    try {
      await updateAppConfig({
        watchedPorts: watchedPorts.filter((p) => p !== port),
      });
      showToast(`端口 ${port} 已从列表中移除`, "success");
    } catch (err) {
      showToast(`移除端口失败: ${err.message}`, "error");
    }
  };

  const handleKillPort = async (port) => {
    const result = await window.electronAPI.killSinglePort(port);
    if (result.success) {
      showToast(`端口 ${port} 已释放`, "success");
      await runPortCheck();
    } else {
      showToast(`kill 失败: ${result.error}`, "error");
    }
  };

  return (
    <PageShell
      title="端口占用管理器"
      subtitle="实时监控并一键清理本地端口占用的工具"
      actions={
        <button
          type="button"
          onClick={runPortCheck}
          disabled={loading}
          className="px-3 py-1.5 rounded-md border text-xs font-medium cursor-pointer transition-all bg-white text-slate-600 border-border hover:bg-slate-50 hover:text-slate-900 disabled:opacity-50"
        >
          🔄 刷新状态
        </button>
      }
    >
      <div className="flex flex-col gap-4">
        {/* 表格容器 */}
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="flex items-center px-4 py-2 border-b border-border bg-slate-50 text-[11px] text-slate-500 font-semibold uppercase tracking-wide">
            <span className="w-20 shrink-0">端口</span>
            <span className="w-20 shrink-0">状态</span>
            <span className="flex-1 min-w-0">运行进程</span>
            <span className="w-16 shrink-0 text-center">PID</span>
            <span className="w-28 shrink-0 text-right">操作</span>
          </div>

          {loading ? (
            <div className="px-4 py-8 text-center text-slate-400 text-xs">正在扫描本地端口占用…</div>
          ) : !rows || rows.length === 0 ? (
            <div className="px-4 py-8 text-center text-slate-400 text-xs">
              列表为空，请在下方添加需要监控的端口号
            </div>
          ) : (
            rows.map((row) => (
              <div
                key={row.port}
                className="flex items-center px-4 py-2.5 border-b border-border last:border-0 hover:bg-slate-50/50 transition-colors"
              >
                <span className="w-20 shrink-0 text-xs text-slate-900 font-semibold font-mono">
                  {row.port}
                </span>

                <span className="w-20 shrink-0">
                  <span
                    className={clsx(
                      "inline-flex items-center gap-1 text-[10.5px] font-medium px-1.5 py-0.5 rounded-full",
                      row.inUse
                        ? "text-red-700 bg-red-400/10"
                        : "text-emerald-700 bg-emerald-400/10",
                    )}
                  >
                    <span
                      className={clsx("status-dot", row.inUse ? "error" : "stopped")}
                      style={{ width: 5, height: 5, minWidth: 5 }}
                    />
                    {row.inUse ? "占用" : "空闲"}
                  </span>
                </span>

                <span
                  className={clsx(
                    "flex-1 min-w-0 text-xs truncate font-mono",
                    row.inUse ? "text-slate-800" : "text-slate-400",
                  )}
                >
                  {row.inUse && row.name ? row.name : "—"}
                </span>

                <span
                  className={clsx(
                    "w-16 shrink-0 text-center text-xs font-mono",
                    row.inUse ? "text-slate-600" : "text-slate-400",
                  )}
                >
                  {row.inUse && row.pid ? row.pid : "—"}
                </span>

                <span className="w-28 shrink-0 text-right flex items-center justify-end gap-1.5">
                  {row.inUse ? (
                    <button
                      type="button"
                      onClick={() => handleKillPort(row.port)}
                      className="text-[10px] px-2 py-1 rounded border cursor-pointer font-semibold text-red-700 border-red-400/30 bg-red-400/10 hover:bg-red-400/20 transition-colors"
                    >
                      释放占用
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => handleRemovePort(row.port)}
                    className="text-[10px] px-2 py-1 rounded border cursor-pointer text-slate-500 border-border bg-slate-50 hover:bg-slate-100 hover:text-slate-900 transition-colors"
                    title="从列表中移除"
                  >
                    移除
                  </button>
                </span>
              </div>
            ))
          )}
        </div>

        {/* 添加监控端口输入框 */}
        <div className="flex items-center gap-2 p-3 bg-slate-50 border border-border rounded-lg">
          <input
            value={customPort}
            onChange={(e) => setCustomPort(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addCustomPort();
            }}
            type="number"
            min="1"
            max="65535"
            placeholder="监控端口号 (例: 8080)"
            className="w-48 bg-white border border-border rounded-md px-3 py-1.5 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500 transition-colors"
          />
          <button
            type="button"
            onClick={addCustomPort}
            className="px-4.5 py-1.5 rounded-md border text-xs font-semibold cursor-pointer transition-all bg-white text-slate-700 border-border hover:bg-slate-50 hover:text-slate-900"
          >
            ＋ 添加端口监控
          </button>
        </div>
      </div>
    </PageShell>
  );
}
