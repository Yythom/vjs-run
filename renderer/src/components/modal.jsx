import * as Dialog from "@radix-ui/react-dialog";
import clsx from "clsx";

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
          className={clsx(
            "fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 bg-panel border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden focus:outline-none",
            className,
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {/* a11y 必备标题：Radix 要求 Dialog 必须有 Title，不传会 warning */}
          {srOnly ? (
            <Dialog.Title className="sr-only">{title}</Dialog.Title>
          ) : (
            <Dialog.Title>{title}</Dialog.Title>
          )}
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
