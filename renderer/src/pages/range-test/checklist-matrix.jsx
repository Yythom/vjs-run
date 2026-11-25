import { useState } from "react";
import clsx from "../../utils/clsx";
import EvidenceDrawer, { EVIDENCE_PROBLEM, evidenceProblem } from "./evidence-drawer";

const CELL = {
  todo: ["⬜", "text-slate-300"],
  pass: ["✅", ""],
  fail: ["❌", ""],
  na: ["—", "text-slate-400"],
  unknown: ["?", "text-red-500"],
};

const ADJUST_LABEL = { remove: "删", edit: "改预期", question: "提问" };

function groupItems(items) {
  const groups = [];
  const byName = new Map();
  for (const item of items) {
    let g = byName.get(item.group);
    if (!g) {
      g = { name: item.group || "未分组", items: [], sites: [], fieldNames: Object.keys(item.fields) };
      byName.set(item.group, g);
      groups.push(g);
    }
    g.items.push(item);
    for (const r of item.results) if (!g.sites.includes(r.site)) g.sites.push(r.site);
  }
  return groups;
}

/**
 * 清单矩阵：按「## 」小节分组，行是清单条目，列是各列原文 + 各站结果格。
 * 数据是 coverage.mjs status --json 的 items，文件一变整份重读，这里不存副本。
 *
 * changes：确认后被改过的格（Map「编号\0列名」→ 原来的内容），加底色、悬停看原文。
 * 点结果格打开证据面板。dir 是产物目录（读截图用），running 为 true 时不标证据问题（agent 先打勾后写证据）。
 * 确认点上传 onAdjust：编号下面多出「删 / 改预期 / 提问」（放在第一列，列多时横向滚动也不会被挤出视野），
 * picked 标出已经加进回复的行。
 */
export default function ChecklistMatrix({ items, dir, running, changes, onAdjust, picked }) {
  const groups = groupItems(items);
  // 选中的格只存编号和站；条目从最新的清单里找，清单改了内容跟着变，条目被删了面板自然关掉
  const [selected, setSelected] = useState(null);
  const selectedItem = selected && items.find((i) => i.id === selected.id);
  const selectedResult = selectedItem?.results.find((r) => r.site === selected.site);
  // 折叠是纯界面状态；默认全展开
  const [collapsed, setCollapsed] = useState(() => new Set());
  const toggle = (name) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <div className="flex flex-col gap-3">
      {groups.map((g) => {
        const open = !collapsed.has(g.name);
        const counts = { todo: 0, pass: 0, fail: 0, na: 0 };
        let problems = 0;
        for (const it of g.items) {
          for (const r of it.results) {
            if (r.state in counts) counts[r.state] += 1;
            if (evidenceProblem(r, running)) problems += 1;
          }
        }
        return (
          <section key={g.name} className="bg-white border border-slate-200/80 rounded-xl shadow-xs overflow-hidden">
            <button
              type="button"
              onClick={() => toggle(g.name)}
              className="w-full flex items-center gap-2 px-4 py-2.5 text-left text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
            >
              <span className="text-slate-400 w-3">{open ? "▾" : "▸"}</span>
              <span className="flex-1 truncate">{g.name}</span>
              <span className="font-normal text-[11px] text-slate-400">
                {g.items.length} 条 · ✅ {counts.pass} · ❌ {counts.fail} · ⬜ {counts.todo} · — {counts.na}
                {problems > 0 && <span className="text-amber-600"> · 证据有问题 {problems}</span>}
              </span>
            </button>
            {open && (
              <div className="overflow-x-auto border-t border-border">
                <table className="w-full text-[11.5px] align-top">
                  <thead>
                    <tr className="text-left text-[11px] text-slate-400 bg-slate-50/60">
                      <th className="px-3 py-2 font-medium whitespace-nowrap">编号</th>
                      {g.fieldNames.map((f) => (
                        <th key={f} className="px-3 py-2 font-medium min-w-32">
                          {f}
                        </th>
                      ))}
                      {g.sites.map((s) => (
                        <th key={s} className="px-2 py-2 font-medium text-center whitespace-nowrap">
                          {s}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {g.items.map((item) => {
                      const marks = picked?.get(item.id) || [];
                      return (
                        <tr
                          key={item.id}
                          className={clsx("border-t border-border/60", marks.includes("remove") && "bg-red-50/40 line-through decoration-red-300")}
                        >
                          <td className="px-3 py-2 whitespace-nowrap">
                            <div className="font-mono font-semibold text-slate-700">{item.id}</div>
                            {onAdjust && (
                              <div className="mt-1 flex flex-col items-start gap-1 no-underline">
                                {Object.entries(ADJUST_LABEL).map(([kind, label]) => (
                                  <button
                                    key={kind}
                                    type="button"
                                    onClick={() => onAdjust(item, kind)}
                                    className={clsx(
                                      "px-1.5 py-0.5 rounded border text-[10.5px] cursor-pointer",
                                      marks.includes(kind)
                                        ? "bg-sky-50 border-sky-200 text-sky-700"
                                        : "border-slate-200 text-slate-500 hover:bg-slate-50",
                                    )}
                                  >
                                    {label}
                                  </button>
                                ))}
                              </div>
                            )}
                          </td>
                          {g.fieldNames.map((f) => {
                            const before = changes?.get(`${item.id}\0${f}`);
                            return (
                              <td
                                key={f}
                                title={before === undefined ? undefined : `确认后改过，原来是：\n${before || "（空）"}`}
                                className={clsx(
                                  "px-3 py-2 text-slate-600 whitespace-pre-wrap break-words",
                                  before !== undefined && "bg-amber-50 shadow-[inset_2px_0_0_#f59e0b]",
                                )}
                              >
                                {item.fields[f]}
                              </td>
                            );
                          })}
                          {g.sites.map((s) => {
                            const r = item.results.find((x) => x.site === s);
                            const [icon, cls] = CELL[r?.state] || ["", ""];
                            if (!r) return <td key={s} />;
                            const problem = evidenceProblem(r, running);
                            return (
                              <td key={s} className={clsx("px-1 py-1 text-center", cls)}>
                                <button
                                  type="button"
                                  onClick={() => setSelected({ id: item.id, site: s })}
                                  title={problem ? EVIDENCE_PROBLEM[problem] : `${r.text}（点开看证据）`}
                                  className="relative w-8 h-7 rounded hover:bg-slate-100 cursor-pointer"
                                >
                                  {icon}
                                  {problem && (
                                    <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-amber-500" />
                                  )}
                                </button>
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
      {selectedResult && (
        <EvidenceDrawer
          dir={dir}
          item={selectedItem}
          result={selectedResult}
          running={running}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
