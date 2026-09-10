import { useSyncExternalStore } from "react";
import Modal from "./modal";
import clsx from "../utils/clsx";

/**
 * 全局确认弹窗：命令式 confirm() + 挂在应用根部的唯一宿主。
 *
 * 原来 useConfirm 把 options 这份 state 交给调用它的组件持有，于是每个用到
 * confirm 的页面都为一个「偶尔弹一次的框」在自己顶层挂了一份 state——框一开一关，
 * 整页（DockingPage 就是整张任务列表）跟着重渲染两次，而弹框跟这些内容毫无关系。
 *
 * 弹框本来就是全局单例的东西，state 该住在应用根部，跟 showToast 一样。
 */

let current = null;
let resolver = null;
const listeners = new Set();

const emit = () => listeners.forEach((fn) => fn());
const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const getSnapshot = () => current;

/**
 * confirm(opts) → Promise<boolean | "alt">
 * 点确定 true，取消 / ESC / 点遮罩 false；传了 altText 时次要按钮 resolve 成 "alt"
 * （注意 "alt" 是 truthy，用到它的调用方要显式比较返回值）。
 */
export function confirm(opts) {
  // 前一个还没关就先把它当取消收掉，避免 Promise 悬着
  resolver?.(false);
  return new Promise((resolve) => {
    resolver = resolve;
    current = opts || {};
    emit();
  });
}

function settle(result) {
  const resolve = resolver;
  resolver = null;
  current = null;
  emit();
  resolve?.(result);
}

export default function ConfirmHost() {
  const options = useSyncExternalStore(subscribe, getSnapshot);
  const {
    title = "确认",
    message = "",
    confirmText = "确定",
    cancelText = "取消",
    altText = "",
    danger = false,
  } = options || {};

  return (
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
}
