import { useEffect, useRef, useState } from "react";
import clsx from "../../utils/clsx";
import { useDockingHistoryTotal } from "../../stores/docking-store";

/**
 * 标题栏「工作台」下拉：把 Agent 进程 / AI 调用历史 / 工作量周报三个入口收进一个按钮。
 *
 * 这三项都是「回看」类操作，不是主流程，各占一个按钮把标题栏挤满了。收成一个之后
 * 有 Agent 在跑时按钮整体转成绿色并带上数量，一眼能看出后台还有没有活。
 */
export default function WorkbenchMenu({
  activeJobCount = 0,
  onOpenProcesses,
  onOpenHistory,
  onOpenReport,
}) {
  // 角标只要一个数字，从 store 直接订阅——页面不必为它持有 state，
  // 历史变动也就不会再把整页拖进重渲染
  const historyTotal = useDockingHistoryTotal();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event) => {
      if (!wrapRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const items = [
    {
      key: "processes",
      icon: "🤖",
      label: "Agent 进程",
      desc: "谁在占着 CLI 子进程，可逐条终止",
      badge: activeJobCount > 0 ? activeJobCount : null,
      badgeCls:
        "bg-emerald-100 text-emerald-700 border-emerald-200",
      onClick: onOpenProcesses,
    },
    {
      key: "history",
      icon: "📜",
      label: "AI 调用历史",
      desc: "历次派活的指令、日志与结果",
      badge: historyTotal > 0 ? historyTotal : null,
      badgeCls: "bg-slate-100 text-slate-700 border-slate-200",
      onClick: onOpenHistory,
    },
    {
      key: "report",
      icon: "📊",
      label: "工作量周报",
      desc: "按周期汇总已闭环的需求与改动",
      badge: null,
      onClick: onOpenReport,
    },
  ];

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        className={clsx(
          "text-xs px-3 py-1.5 rounded border font-medium cursor-pointer flex items-center gap-1.5",
          activeJobCount > 0
            ? "border-emerald-200 text-emerald-700 bg-emerald-50 hover:bg-emerald-100"
            : open
              ? "border-sky-300 text-sky-700 bg-sky-50"
              : "border-border text-slate-700 bg-white hover:bg-slate-50",
        )}
        title="Agent 进程 / AI 调用历史 / 工作量周报"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>🗂️</span>
        <span>工作台</span>
        {activeJobCount > 0 && (
          <span className="text-[10px] px-1.5 py-[1px] rounded-full bg-emerald-100 text-emerald-700 font-bold border border-emerald-200">
            {activeJobCount}
          </span>
        )}
        <span className="text-[9px] leading-none">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute z-20 top-full right-0 mt-1 w-[248px] rounded-lg border border-border bg-white shadow-lg overflow-hidden py-1"
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className="w-full px-3 py-2 text-left hover:bg-slate-50 cursor-pointer flex items-start gap-2"
              onClick={() => {
                setOpen(false);
                item.onClick?.();
              }}
            >
              <span className="text-[13px] leading-5">{item.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="text-xs font-medium text-slate-800">
                    {item.label}
                  </span>
                  {item.badge != null && (
                    <span
                      className={clsx(
                        "text-[10px] px-1.5 py-[1px] rounded-full font-bold border",
                        item.badgeCls,
                      )}
                    >
                      {item.badge}
                    </span>
                  )}
                </span>
                <span className="block text-[11px] text-slate-500 mt-0.5">
                  {item.desc}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
