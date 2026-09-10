import { useMemo, useState } from "react";
import clsx from "../../utils/clsx";
import Modal from "../../components/modal";
import { showToast } from "../../utils/toast";
import { generateDockingReport } from "../../utils/docking-report";
import { useDockingTasks } from "../../stores/docking-store";

/**
 * 工作量周报弹窗。
 *
 * 时间范围切换只影响这里，报表本身按 tasks + range 记忆化，
 * 不再随页面的每次重渲染重算一遍 markdown。
 */
export default function ReportModal({ open, onClose }) {
  const tasks = useDockingTasks();
  const [reportRange, setReportRange] = useState("this_week");
  const report = useMemo(
    () => generateDockingReport(tasks, reportRange),
    [tasks, reportRange],
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="📊 赛博牛马工作量周报 / 汇总"
      srOnly={false}
      className="w-[720px] p-4"
    >
      {
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              {[
                { key: "this_week", label: "本周" },
                { key: "7days", label: "近 7 天" },
                { key: "this_month", label: "本月" },
                { key: "all", label: "全部" },
              ].map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  className={clsx(
                    "text-[11px] px-2.5 py-1 rounded-full border cursor-pointer transition",
                    reportRange === tab.key
                      ? "border-sky-400 bg-sky-50 text-sky-700 font-bold ring-1 ring-sky-300"
                      : "border-slate-300 text-slate-700 hover:bg-slate-100 font-medium",
                  )}
                  onClick={() => setReportRange(tab.key)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 text-[11px] text-slate-700 font-medium">
              <span>
                完成:{" "}
                <strong className="text-emerald-700 font-bold">
                  {report.metrics.done}
                </strong>{" "}
                / {report.metrics.total}
              </span>
              <span className="text-slate-300">·</span>
              <span>
                改动文件:{" "}
                <strong className="text-sky-700 font-bold">
                  {report.metrics.filesCount}
                </strong>
              </span>
            </div>
          </div>

          <pre className="text-[12px] whitespace-pre-wrap break-words bg-slate-50 border border-slate-200 rounded p-3 max-h-[50vh] overflow-y-auto font-sans text-slate-800 select-text leading-relaxed">
            {report.markdown}
          </pre>

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              className="text-xs px-3 py-1.5 rounded border border-slate-300 text-slate-700 hover:bg-slate-100 font-medium cursor-pointer"
              onClick={onClose}
            >
              关闭
            </button>
            <button
              type="button"
              className="text-xs px-3.5 py-1.5 rounded bg-sky-600 hover:bg-sky-700 text-white font-semibold cursor-pointer shadow-xs"
              onClick={() => {
                navigator.clipboard.writeText(report.markdown);
                showToast("周报内容已复制到剪贴板", "success");
              }}
            >
              复制周报 Markdown
            </button>
          </div>
        </div>
      }
    </Modal>
  );
}
