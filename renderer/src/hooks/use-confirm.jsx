import { useCallback, useRef, useState } from "react";
import clsx from "clsx";
import Modal from "../components/modal";

/**
 * 命令式确认弹窗，替代 window.confirm —— 走应用统一的 Modal 外壳。
 *
 * 用法：
 *   const { confirm, confirmDialog } = useConfirm();
 *   // 渲染树里放一次 {confirmDialog}
 *   const ok = await confirm({ title: "删除规则", message: "GET /a", danger: true });
 *   if (!ok) return;
 *
 * confirm(opts) 返回 Promise<boolean>：点确定 → true，点取消 / ESC / 点遮罩 → false。
 *
 * 传了 altText 时会多出一个次要动作按钮，点它 resolve 成 "alt"（注意是 truthy，
 * 用到 altText 的调用方要显式比较返回值，不能只判断真假）。
 */
export default function useConfirm() {
  const [options, setOptions] = useState(null);
  const resolverRef = useRef(null);

  const confirm = useCallback((opts) => {
    return new Promise((resolve) => {
      resolverRef.current = resolve;
      setOptions(opts || {});
    });
  }, []);

  const settle = useCallback((result) => {
    setOptions(null);
    const resolve = resolverRef.current;
    resolverRef.current = null;
    resolve?.(result);
  }, []);

  const {
    title = "确认",
    message = "",
    confirmText = "确定",
    cancelText = "取消",
    altText = "",
    danger = false,
  } = options || {};

  const confirmDialog = (
    <Modal
      open={options !== null}
      onClose={() => settle(false)}
      title={title}
      srOnly={false}
      className="w-[380px]"
    >
      <div className="px-5 py-4 text-xs text-slate-700 whitespace-pre-wrap break-words">
        {message}
      </div>
      <div className="shrink-0 flex justify-end gap-2 px-5 py-3.5 border-t border-border bg-slate-50/50">
        <button
          type="button"
          onClick={() => settle(false)}
          className="px-3 py-1.5 rounded-md border text-xs font-medium bg-card text-slate-600 border-border hover:bg-hover hover:text-slate-900"
        >
          {cancelText}
        </button>
        {altText && (
          <button
            type="button"
            onClick={() => settle("alt")}
            className="px-3 py-1.5 rounded-md border text-xs font-medium bg-card text-slate-600 border-border hover:bg-hover hover:text-slate-900"
          >
            {altText}
          </button>
        )}
        <button
          type="button"
          onClick={() => settle(true)}
          className={clsx(
            "px-3 py-1.5 rounded-md border text-xs font-medium",
            danger
              ? "bg-red-400/10 text-red-700 border-red-400/30 hover:bg-red-400/20"
              : "bg-sky-400/10 text-sky-700 border-sky-400/35 hover:bg-sky-400/20",
          )}
        >
          {confirmText}
        </button>
      </div>
    </Modal>
  );

  return { confirm, confirmDialog };
}
