import { useState } from "react";
import { showToast } from "../../utils/toast";


/** CLI 缺失提示与一键安装卡片组件 */
export default function CliInstallCard({
  title,
  desc,
  installCmd,
  onInstall,
  installing,
  btnText = "一键安装",
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!installCmd) return;
    try {
      await navigator.clipboard.writeText(installCmd);
      setCopied(true);
      showToast(`已复制命令: ${installCmd}`, "success");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast("复制失败", "error");
    }
  };

  return (
    <div className="border border-amber-200 bg-amber-50/90 text-amber-900 rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-medium text-xs text-amber-900">
          <span>⚠️</span>
          <span>{title}</span>
        </div>
        {onInstall && (
          <button
            type="button"
            disabled={installing}
            onClick={onInstall}
            className="text-[11px] px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-700 text-white font-medium cursor-pointer disabled:opacity-50 transition shadow-2xs flex items-center gap-1 shrink-0"
          >
            {installing ? (
              <>
                <span className="w-2.5 h-2.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                <span>正在安装…</span>
              </>
            ) : (
              <>
                <span>⚡</span>
                <span>{btnText}</span>
              </>
            )}
          </button>
        )}
      </div>

      {desc && (
        <p className="text-[11px] text-amber-700 leading-relaxed">{desc}</p>
      )}

      {installCmd && (
        <div className="flex items-center justify-between gap-2 bg-white/90 border border-amber-200 rounded px-2.5 py-1.5 font-mono text-[11px]">
          <code className="text-amber-900 truncate select-all">
            {installCmd}
          </code>
          <button
            type="button"
            onClick={handleCopy}
            className="shrink-0 text-[10px] px-2 py-0.5 rounded bg-amber-100 hover:bg-amber-200 text-amber-900 font-sans font-medium transition cursor-pointer"
          >
            {copied ? "✓ 已复制" : "📋 复制命令"}
          </button>
        </div>
      )}
    </div>
  );
}
