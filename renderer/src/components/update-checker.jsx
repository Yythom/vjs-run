import { useEffect, useRef, useState } from "react";
import { showToast, toast } from "../utils/toast";

export default function UpdateChecker({ className, children }) {
  const [checking, setChecking] = useState(false);
  const toastIdRef = useRef(null);

  useEffect(() => {
    const offStatus = window.electronAPI.onUpdateStatus((data) => {
      switch (data.status) {
        case "checking":
          toastIdRef.current = toast.loading("正在检查更新…");
          break;
        case "available":
          toast.dismiss(toastIdRef.current);
          toast.info(`发现新版本 v${data.version}`, {
            duration: Infinity,
            action: {
              label: "下载更新",
              onClick: () => {
                window.electronAPI.downloadUpdate();
              },
            },
          });
          setChecking(false);
          break;
        case "downloading":
          toast.dismiss(toastIdRef.current);
          toastIdRef.current = toast.loading("正在下载更新… 0%");
          break;
        case "not-available":
          toast.dismiss(toastIdRef.current);
          showToast("当前已是最新版本 ✓", "success");
          setChecking(false);
          break;
        case "downloaded":
          toast.dismiss(toastIdRef.current);
          toast.success("下载完成！已自动为您打开安装包，请拖动覆盖安装。");
          setChecking(false);
          break;
        case "error":
          toast.dismiss(toastIdRef.current);
          showToast(`检查更新失败: ${data.message}`, "error");
          setChecking(false);
          break;
        case "dev-skip":
          toast.dismiss(toastIdRef.current);
          showToast("开发模式下不支持自动更新", "warning");
          setChecking(false);
          break;
      }
    });

    const offProgress = window.electronAPI.onUpdateProgress((data) => {
      const pct = Math.round(data.percent);
      if (toastIdRef.current) {
        toast.loading(`正在下载更新… ${pct}%`, { id: toastIdRef.current });
      } else {
        toastIdRef.current = toast.loading(`正在下载更新… ${pct}%`);
      }
    });

    return () => {
      offStatus();
      offProgress();
    };
  }, []);

  const handleCheckUpdate = () => {
    if (checking) return;
    setChecking(true);
    window.electronAPI.checkForUpdates();
  };

  return (
    <button
      type="button"
      onClick={handleCheckUpdate}
      disabled={checking}
      className={
        className ||
        "px-2 py-1 rounded border text-[10.5px] font-semibold bg-white border-border text-slate-600 hover:text-slate-900 hover:bg-slate-50 active:bg-slate-100 disabled:opacity-50 disabled:cursor-default cursor-pointer transition-colors shadow-sm"
      }
    >
      {checking ? "正在检查…" : (children || "检查更新")}
    </button>
  );
}
