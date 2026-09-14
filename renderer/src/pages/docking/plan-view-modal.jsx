import { useEffect, useState } from "react";
import Modal from "../../components/modal";
import { showToast } from "../../utils/toast";
import { formatTime } from "./utils";

/**
 * 需求池工作包的 plan 查看弹窗。
 *
 * plan.md 落在软件目录的工作包里，不进代码库，所以面板得能直接看。
 * 挂载时读一次；AI 还在写的话点「刷新」再读。
 */
export default function PlanViewModal({ task, onClose }) {
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState("");

  const load = async () => {
    const res = await window.electronAPI.dockingReadPlan(task.id);
    if (res?.success) {
      setPlan(res);
      setError("");
    } else {
      setError(res?.error || "读取 plan 失败");
    }
  };

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.dockingReadPlan(task.id).then((res) => {
      if (cancelled) return;
      if (res?.success) setPlan(res);
      else setError(res?.error || "读取 plan 失败");
    });
    return () => {
      cancelled = true;
    };
  }, [task.id]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(plan.content);
      showToast("已复制 plan 内容", "success");
    } catch {
      showToast("复制失败", "error");
    }
  };

  const handleOpen = async () => {
    const res = await window.electronAPI.dockingOpenPlan(task.id);
    if (!res?.success) showToast(`打开失败: ${res?.error}`, "error");
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`实施 plan · #${task.seq} ${task.title}`}
      srOnly={false}
      className="w-[820px] p-4"
    >
      {error ? (
        <p className="text-[12px] text-rose-600 py-6 text-center">{error}</p>
      ) : !plan ? (
        <p className="text-[12px] text-slate-500 py-6 text-center">正在读取…</p>
      ) : !plan.exists ? (
        <div className="text-[12px] text-slate-600 py-6 text-center space-y-1">
          <p>plan 还没写出来。派给 AI 用「产实施 plan」档跑完后会出现在这里。</p>
          <p className="text-[11px] text-slate-400 break-all">{plan.path}</p>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 mb-2 text-[11px] text-slate-500">
            <span className="truncate" title={plan.path}>
              更新于 {formatTime(plan.updatedAt)} · {plan.path}
            </span>
          </div>
          <pre className="text-[12px] leading-relaxed whitespace-pre-wrap break-words bg-slate-50 border border-slate-200 rounded p-3 max-h-[65vh] overflow-y-auto font-mono text-slate-800">
            {plan.content}
          </pre>
        </>
      )}

      <div className="flex justify-end gap-2 mt-3">
        <button
          type="button"
          className="text-xs px-3 py-1.5 rounded border border-border text-slate-600 hover:bg-slate-50 cursor-pointer"
          onClick={load}
        >
          刷新
        </button>
        {plan?.exists && (
          <>
            <button
              type="button"
              className="text-xs px-3 py-1.5 rounded border border-border text-slate-600 hover:bg-slate-50 cursor-pointer"
              onClick={handleCopy}
            >
              复制内容
            </button>
            <button
              type="button"
              className="text-xs px-3.5 py-1.5 rounded bg-sky-600 hover:bg-sky-700 text-white cursor-pointer font-medium"
              onClick={handleOpen}
            >
              用默认应用打开
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
