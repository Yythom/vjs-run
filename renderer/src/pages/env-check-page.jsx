import { useState } from "react";
import clsx from "../utils/clsx";
import PageShell from "../components/page-shell";
import useResource from "../hooks/use-resource";
import { showToast } from "../utils/toast";

const ENV_ICONS = {
  node: "⬡",
  pnpm: "📦",
  git: "🌿",
  brew: "🍺",
  pm2: "⚙️",
};

/** copied 提示只影响按钮自身，state 收在叶子里，点复制不重画整页卡片列表 */
function CopyInstallButton({ item }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(item.install);
      setCopied(true);
      showToast(`已复制 ${item.label} 安装命令`, "success");
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      showToast(`复制失败: ${err?.message || "未知错误"}`, "error");
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      className="w-full text-center py-1.5 rounded border text-[10px] font-semibold bg-white text-slate-600 border-border hover:bg-slate-50 hover:text-slate-900 transition-colors cursor-pointer"
    >
      {copied ? "✓ 已复制" : "📋 复制安装命令"}
    </button>
  );
}

export default function EnvCheckPage() {
  const {
    data,
    loading,
    reload: runEnvCheck,
  } = useResource(async () => {
    try {
      const rows = await window.electronAPI.checkEnv();
      return Array.isArray(rows) ? rows : [];
    } catch (err) {
      showToast(`环境检测失败: ${err?.message || "未知错误"}`, "error");
      return [];
    }
  }, []);
  const results = data ?? [];

  const missingCount = results.filter((item) => item.status === "missing").length;
  
  const subtitleText = loading
    ? "正在体检本地开发工具链，请稍候..."
    : missingCount === 0
      ? `所有环境项配置正常 (共检测 ${results.length} 项)`
      : `环境存在部分缺失项 (共有 ${missingCount} 项未检测到有效版本，请对照下方指引配置)`;

  return (
    <PageShell
      title="开发环境体检"
      subtitle={subtitleText}
      actions={
        <button
          type="button"
          onClick={runEnvCheck}
          disabled={loading}
          className="px-3 py-1.5 rounded-md border text-xs font-medium cursor-pointer transition-all bg-white text-slate-600 border-border hover:bg-slate-50 hover:text-slate-900 disabled:opacity-50"
        >
          🔄 重新检测
        </button>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {loading ? (
          <div className="col-span-full text-center py-10 text-slate-400 text-xs">
            正在扫描本地工具链，请稍候…
          </div>
        ) : (
          results.map((item) => {
            const ok = item.status === "ok";
            return (
              <div
                key={item.id}
                className={clsx(
                  "flex flex-col gap-1.5 rounded-lg border px-4 py-3",
                  ok ? "bg-slate-50 border-border" : "bg-red-500/5 border-red-500/20",
                )}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={clsx(
                      "text-sm font-semibold",
                      ok ? "text-slate-900" : "text-red-700",
                    )}
                  >
                    {ENV_ICONS[item.id] || "🔧"} {item.label}
                  </span>
                  <span
                    className={clsx("status-dot", ok ? "running" : "error")}
                    style={{ flexShrink: 0 }}
                  />
                </div>

                <span
                  className={clsx(
                    "text-[11px]",
                    ok ? "text-slate-800" : "text-red-600",
                  )}
                >
                  {ok ? item.version : "未安装"}
                </span>
                <span className="text-[10px] text-slate-400 truncate">
                  {item.cmd}
                </span>

                {!ok && item.install && (
                  <div className="mt-1 flex flex-col gap-1.5 rounded-md border border-red-500/20 bg-red-500/5 p-2">
                    <code
                      className="text-[10px] text-red-700 break-all select-all font-mono"
                      title={item.install}
                    >
                      {item.install}
                    </code>
                    <CopyInstallButton item={item} />
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </PageShell>
  );
}
