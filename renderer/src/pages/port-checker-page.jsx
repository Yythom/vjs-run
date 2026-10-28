import { useState } from "react";
import clsx from "../utils/clsx";
import PageShell from "../components/page-shell";
import { DEFAULT_WATCHED_PORTS } from "../constants";
import useResource from "../hooks/use-resource";
import { showToast } from "../utils/toast";
import { useAppConfig, updateAppConfig } from "../stores/app-config-store";
import { isEnterKey } from "../utils/keyboard";

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
          className="px-3 py-1.5 rounded-lg border text-xs font-semibold cursor-pointer transition-all bg-white text-slate-700 border-slate-200 hover:bg-slate-50 hover:text-slate-900 disabled:opacity-50 shadow-2xs flex items-center gap-1.5"
        >
          <svg
            className={clsx("w-3.5 h-3.5 text-slate-500", loading && "animate-spin")}
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"
            />
          </svg>
          <span>刷新状态</span>
        </button>
      }
    >
      <div className="flex flex-col gap-4">
        {/* 表格容器 */}
        <div className="border border-slate-200/90 rounded-xl overflow-hidden shadow-2xs bg-white">
          <div className="flex items-center px-4 py-2.5 border-b border-border bg-slate-50/70 text-[11px] text-slate-500 font-semibold tracking-wide">
            <span className="w-24 shrink-0">监控端口</span>
            <span className="w-24 shrink-0">当前状态</span>
            <span className="flex-1 min-w-0">运行进程</span>
            <span className="w-20 shrink-0 text-center">PID</span>
            <span className="w-28 shrink-0 text-right">操作</span>
          </div>

          {loading ? (
            <div className="px-4 py-10 text-center text-slate-400 text-xs flex flex-col items-center justify-center gap-2">
              <svg className="w-5 h-5 text-slate-400 animate-spin" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
              </svg>
              <span>正在扫描本地端口占用…</span>
            </div>
          ) : !rows || rows.length === 0 ? (
            <div className="px-4 py-10 text-center text-slate-400 text-xs flex flex-col items-center justify-center gap-2">
              <svg className="w-6 h-6 text-slate-300" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
              </svg>
              <span>列表为空，请在下方输入端口号添加监控</span>
            </div>
          ) : (
            rows.map((row) => (
              <div
                key={row.port}
                className="flex items-center px-4 py-2.5 border-b border-slate-100 last:border-0 hover:bg-slate-50/60 transition-colors"
              >
                <span className="w-24 shrink-0 text-xs text-slate-800 font-semibold font-mono">
                  :{row.port}
                </span>

                <span className="w-24 shrink-0">
                  <span
                    className={clsx(
                      "inline-flex items-center gap-1.5 text-[10.5px] font-semibold px-2 py-0.5 rounded-full border shadow-2xs",
                      row.inUse
                        ? "text-red-700 bg-red-50 border-red-200/80"
                        : "text-emerald-700 bg-emerald-50 border-emerald-200/80",
                    )}
                  >
                    <span
                      className={clsx("status-dot", row.inUse ? "error" : "stopped")}
                      style={{ width: 6, height: 6, minWidth: 6 }}
                    />
                    {row.inUse ? "占用中" : "空闲"}
                  </span>
                </span>

                <span
                  className={clsx(
                    "flex-1 min-w-0 text-xs truncate font-mono",
                    row.inUse ? "text-slate-800 font-medium" : "text-slate-400",
                  )}
                >
                  {row.inUse && row.name ? row.name : "—"}
                </span>

                <span
                  className={clsx(
                    "w-20 shrink-0 text-center text-xs font-mono",
                    row.inUse ? "text-slate-600 font-medium" : "text-slate-400",
                  )}
                >
                  {row.inUse && row.pid ? row.pid : "—"}
                </span>

                <span className="w-28 shrink-0 text-right flex items-center justify-end gap-1.5">
                  {row.inUse ? (
                    <button
                      type="button"
                      onClick={() => handleKillPort(row.port)}
                      className="text-[10px] px-2 py-1 rounded-md border cursor-pointer font-semibold text-red-700 border-red-200 bg-red-50 hover:bg-red-100 transition-colors shadow-2xs"
                    >
                      释放占用
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => handleRemovePort(row.port)}
                    className="text-[10px] px-2 py-1 rounded-md border cursor-pointer text-slate-500 border-slate-200 bg-white hover:bg-slate-50 hover:text-slate-900 transition-colors shadow-2xs"
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
        <div className="flex items-center gap-2.5 p-3 bg-slate-50/80 border border-slate-200/80 rounded-xl">
          <div className="relative">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 font-mono text-xs select-none">
              :
            </span>
            <input
              value={customPort}
              onChange={(e) => setCustomPort(e.target.value)}
              onKeyDown={(e) => {
                if (isEnterKey(e)) addCustomPort();
              }}
              type="number"
              min="1"
              max="65535"
              placeholder="输入端口 (如 8080)"
              className="w-48 bg-white border border-slate-200 rounded-lg pl-6 pr-3 py-1.5 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500/20 transition-all font-mono"
            />
          </div>
          <button
            type="button"
            onClick={addCustomPort}
            className="px-3.5 py-1.5 rounded-lg border text-xs font-semibold cursor-pointer transition-all bg-white text-slate-700 border-slate-200 hover:bg-slate-50 hover:text-slate-900 shadow-2xs flex items-center gap-1.5"
          >
            <svg className="w-3.5 h-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            <span>添加端口监控</span>
          </button>
        </div>
      </div>
    </PageShell>
  );
}
