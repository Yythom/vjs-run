import clsx from "clsx";

/**
 * PageShell - 统一的独立页面包装外壳
 *
 * Props:
 *   - title: 页面标题
 *   - subtitle: 可选，副标题/描述文字
 *   - actions: 可选，渲染在右侧的操作按钮区域
 *   - children: 页面主体内容
 *   - className: 可选，覆盖内部卡片容器的样式
 *   - noCard: 可选，为 true 时不包裹白底卡片容器（例如终端等全屏撑满组件）
 */
export default function PageShell({
  title,
  subtitle,
  actions,
  children,
  className = "",
  noCard = false,
}) {
  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
      {/* 统一的页面 Header */}
      <div className="shrink-0 flex items-center justify-between px-6 h-14 border-b border-border bg-white">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-800 truncate">{title}</h2>
          {subtitle && (
            <p className="text-[11px] text-slate-400 mt-0.5 truncate">{subtitle}</p>
          )}
        </div>
        {actions && <div className="flex gap-2 shrink-0">{actions}</div>}
      </div>

      {/* 页面内容区 */}
      <div className="flex-1 overflow-y-auto p-2">
        {noCard ? (
          <div className={clsx("h-full flex flex-col", className)}>
            {children}
          </div>
        ) : (
          <div
            className={clsx(
              "max-w-4xl mx-auto bg-white border border-border rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.02)] p-4",
              className
            )}
          >
            {children}
          </div>
        )}
      </div>
    </div>
  );
}
