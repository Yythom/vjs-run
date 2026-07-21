import * as Dialog from "@radix-ui/react-dialog";
import clsx from "../utils/clsx";

/**
 * 统一 modal 外壳：所有弹窗共用 overlay / Portal / Content 定位。
 *
 * 基于 Radix Dialog，自动获得：
 *   - ESC 关闭
 *   - 点击 overlay 关闭
 *   - Focus trap（Tab 走不出 modal）
 *   - 打开时锁 body 滚动
 *   - 关闭后焦点回到触发元素
 *   - aria-* 标签全套（屏幕阅读器）
 *
 * Props:
 *   - open, onClose：受控开关
 *   - title：a11y 必填的标题（Dialog.Title 要求）。如果视觉上不需要展示，
 *     用 srOnly 把它视觉藏起来但保留语义。
 *   - srOnly：true 时 title 视觉隐藏，仅给屏幕阅读器
 *   - className：覆盖 Content 容器 className
 *   - children：modal 内容
 */
export default function Modal({
  open,
  onClose,
  title,
  srOnly = true,
  className = "",
  headerAction,
  children,
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose?.()}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-50"
          style={{
            background: "rgba(0, 0, 0, 0.55)",
            backdropFilter: "blur(2px)",
          }}
        />
        <Dialog.Content
          aria-describedby={undefined}
          onPointerDownOutside={(e) => {
            const target = e.target;
            if (target && target.closest("[data-sonner-toaster]")) {
              e.preventDefault();
            }
          }}
          onInteractOutside={(e) => {
            const target = e.target;
            if (target && target.closest("[data-sonner-toaster]")) {
              e.preventDefault();
            }
          }}
          className={clsx(
            "fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 bg-panel border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden focus:outline-none",
            className,
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {/* 统一的 Modal 头部：标题与关闭按钮在一行 */}
          {!srOnly ? (
            <div className="shrink-0 flex items-center justify-between px-5 py-3.5 border-b border-border bg-slate-50/50">
              <Dialog.Title className="text-sm font-semibold text-slate-800">
                {title}
              </Dialog.Title>
              <div className="flex items-center gap-1.5">
                {headerAction}
                {onClose && (
                  <button
                    type="button"
                    onClick={onClose}
                    className="text-slate-400 hover:text-slate-700 transition-colors text-base leading-none cursor-pointer w-6 h-6 rounded-full hover:bg-slate-200/60 flex items-center justify-center"
                    aria-label="关闭弹窗"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          ) : (
            <Dialog.Title className="sr-only">{title}</Dialog.Title>
          )}

          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
