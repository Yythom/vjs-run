import { useEffect, useState } from "react";
import PageShell from "../components/page-shell";
import { showToast } from "../utils/toast";
import * as logStore from "../stores/log-store";

// 可清理项。danger=true 为破坏性操作（丢用户数据）；sizeKey 对应 get-cleanup-info 返回的字段。
// scope="renderer" 的项在渲染层直接清，其余项通过 run-cleanup 交给主进程。
const OPTIONS = [
  {
    id: "appCache",
    label: "应用缓存",
    desc: "Chromium 网络缓存 + 代码缓存，删除后自动重建",
    sizeKey: "appCacheBytes",
  },
  {
    id: "dmgInstallers",
    label: "已下载安装包",
    desc: "删除系统下载目录中已下载的 vjtools 安装包 (.dmg)",
    sizeKey: "dmgInstallersBytes",
  },
  {
    id: "crashReports",
    label: "崩溃报告与日志",
    desc: "清除应用崩溃时自动生成的诊断报告与日志文件",
    sizeKey: "crashReportsBytes",
  },
  {
    id: "webviewStorage",
    label: "浏览器缓存扩展项",
    desc: "清除 SharedStorage、Trust Tokens 和安全证书状态等扩展缓存",
    sizeKey: "webviewStorageBytes",
  },
  {
    id: "allLogs",
    label: "所有面板日志",
    desc: "清空全部项目 / Mock 的终端输出（仅内存）",
    scope: "renderer",
  },
  {
    id: "windowState",
    label: "窗口位置记忆",
    desc: "下次启动恢复默认窗口大小与位置",
  },
  {
    id: "mockData",
    label: "Mock 规则与数据",
    desc: "重置为内置默认，丢失你自定义的 mock 规则",
    sizeKey: "mockAssetsBytes",
    danger: true,
  },
  {
    id: "config",
    label: "全部配置（恢复出厂）",
    desc: "清空所有项目 / 仓库 / Mock 规则与场景 / 窗口位置及本地界面状态，完成后自动重启",
    danger: true,
  },
];

function formatBytes(n) {
  if (!n || n < 1024) return `${n || 0} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export default function CleanupPage() {
  const [info, setInfo] = useState(null);
  const [selected, setSelected] = useState({}); // id → bool，默认全不勾
  const [running, setRunning] = useState(false);

  useEffect(() => {
    window.electronAPI
      .getCleanupInfo()
      .then((res) => res?.success && setInfo(res.info))
      .catch(() => {});
  }, []);

  const toggle = (id) =>
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }));

  const chosen = OPTIONS.filter((o) => selected[o.id]);
  const hasDanger = chosen.some((o) => o.danger);
  const nothingChosen = chosen.length === 0;

  const handleRun = async () => {
    if (nothingChosen || running) return;
    setRunning(true);
    try {
      // 渲染层内存项
      if (selected.allLogs) logStore.clearAll();

      // 主进程项
      const mainTargets = chosen
        .filter((o) => o.scope !== "renderer")
        .map((o) => o.id);

      let reclaimed = 0;
      let needsRestart = false;
      let relaunching = false;
      if (mainTargets.length) {
        const res = await window.electronAPI.runCleanup(mainTargets);
        if (!res?.success) throw new Error(res?.error || "清理失败");
        reclaimed = res.reclaimedBytes || 0;
        needsRestart = res.needsRestart;
        relaunching = res.relaunching;
      }

      // 恢复出厂：主进程会在稍后自动重启，此处只提示，不再拉取存储信息（进程即将退出）
      if (relaunching) {
        showToast("已恢复出厂设置，正在重启应用…", "success");
        return;
      }

      const parts = [];
      if (reclaimed) parts.push(`释放 ${formatBytes(reclaimed)}`);
      showToast(
        `清理完成${parts.length ? `，${parts.join("、")}` : ""}`,
        "success",
      );
      if (needsRestart) {
        showToast("配置 / 窗口相关改动将在重启应用后完全生效", "info");
      }

      // 清理后重新拉取存储信息
      const infoRes = await window.electronAPI.getCleanupInfo();
      if (infoRes?.success) setInfo(infoRes.info);
      setSelected({});
    } catch (err) {
      showToast(err.message || "清理失败", "error");
    } finally {
      setRunning(false);
    }
  };

  return (
    <PageShell
      title="应用存储清理"
      subtitle="选择并清理应用缓存数据或进行恢复出厂设置"
      actions={
        <button
          type="button"
          onClick={handleRun}
          disabled={nothingChosen || running}
          className={`px-4.5 py-1.5 rounded-md border text-xs font-semibold cursor-pointer transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
            hasDanger
              ? "bg-red-500/10 text-red-700 border-red-500/30 hover:bg-red-500/20"
              : "bg-violet-500/10 text-violet-700 border-violet-500/30 hover:bg-violet-500/20"
          }`}
        >
          {running
            ? "清理中…"
            : hasDanger
              ? "⚠️ 确认清理"
              : "开始清理"}
        </button>
      }
    >
      <div className="flex flex-col gap-4">
        {/* 可选项列表 */}
        <div className="space-y-1.5">
          {OPTIONS.map((o) => {
            const size =
              o.sizeKey && info ? formatBytes(info[o.sizeKey]) : null;
            return (
              <label
                key={o.id}
                className="flex items-start gap-3 px-3.5 py-3 rounded-lg cursor-pointer hover:bg-slate-50 transition-colors border border-transparent hover:border-border"
              >
                <input
                  type="checkbox"
                  checked={!!selected[o.id]}
                  onChange={() => toggle(o.id)}
                  className="mt-0.5 accent-violet-500 w-3.5 h-3.5 cursor-pointer shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-[13px] font-semibold ${
                        o.danger ? "text-red-700" : "text-slate-800"
                      }`}
                    >
                      {o.danger ? "⚠️ " : ""}
                      {o.label}
                    </span>
                    {size && (
                      <span className="text-[11px] text-slate-400 shrink-0 font-mono">
                        {size}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5">{o.desc}</div>
                </div>
              </label>
            );
          })}
        </div>

        {/* 提示信息栏 */}
        <div className="p-3 bg-slate-50 border border-border rounded-lg text-xs leading-relaxed">
          {hasDanger ? (
            <span className="text-red-700 font-semibold">
              ⚠️ 警告：你选择的项目中含有破坏性清除（如配置或规则重置），执行后对应数据将不可恢复！
            </span>
          ) : (
            <span className="text-slate-500">
              提示：缓存和日志清理是非常安全的，不会影响你的配置文件和项目列表，缓存会在下次加载时自动重建。
            </span>
          )}
        </div>
      </div>
    </PageShell>
  );
}
