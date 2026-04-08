import { useEffect, useState } from "react";

export default function SettingsModal({
  open,
  onClose,
  onSaved,
  onSaveError,
  onValidateError,
}) {
  const [proxyPath, setProxyPath] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;

    let active = true;
    const loadConfig = async () => {
      const cfg = await window.electronAPI.getConfig();
      if (!active) return;
      setProxyPath(cfg?.proxyPath || "");
    };

    loadConfig();

    return () => {
      active = false;
    };
  }, [open]);

  const handleSave = async () => {
    if (saving) return;

    const nextProxyPath = proxyPath.trim();

    if (!nextProxyPath) {
      onValidateError?.();
      return;
    }

    setSaving(true);
    try {
      const result = await window.electronAPI.setConfig({
        proxyPath: nextProxyPath,
      });

      if (result?.success) {
        onSaved?.(result.config);
      } else {
        onSaveError?.(result?.error || "未知错误");
      }
    } catch (error) {
      onSaveError?.(error?.message || String(error));
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0, 0, 0, 0.55)", backdropFilter: "blur(2px)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div
        className="bg-panel border border-border rounded-xl shadow-2xl w-[520px] flex flex-col overflow-hidden"
        style={{ maxWidth: "90vw" }}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
          <h2 className="text-sm font-semibold text-slate-200">⚙️ Proxy 配置</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="text-slate-500 hover:text-slate-200 transition-colors text-lg leading-none cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label="关闭设置"
          >
            ✕
          </button>
        </div>

        <div className="px-5 py-5 flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-400">
              服务端 Proxy 根目录
              <span className="ml-1 text-slate-600 font-normal">
                (PROXY_PATH)
              </span>
            </label>
            <input
              type="text"
              value={proxyPath}
              onChange={(e) => setProxyPath(e.target.value)}
              placeholder="/Users/yourname/Documents/work/dev-api-proxy"
              className="w-full bg-card border border-border rounded-md px-3 py-2 text-xs font-mono text-slate-200 placeholder-slate-600 outline-none focus:border-slate-500 transition-colors"
            />
            <p className="text-[11px] text-slate-600">
              git pull / pm2 start 的工作目录
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3.5 border-t border-border">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-4 py-1.5 rounded-md border text-xs font-medium cursor-pointer transition-all bg-card text-slate-400 border-border hover:bg-hover hover:text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 rounded-md border text-xs font-medium cursor-pointer transition-all bg-blue-500/20 text-blue-400 border-blue-500/40 hover:bg-blue-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
