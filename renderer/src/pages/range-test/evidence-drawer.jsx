import * as Dialog from "@radix-ui/react-dialog";
import Markdown from "./markdown";
import { shortSha } from "./ui";

// 证据判断的说明。和 coverage.mjs status 的 problems 一一对应
export const EVIDENCE_PROBLEM = {
  missing: "打了勾，但 log 里没有这一格的证据",
  empty: "log 里有标题，正文只有「待补充」「符合预期」这类话",
  "no-commit": "证据前面没写「测试提交」，判断不了测完之后代码有没有再变",
  stale: "证据过期了：测完之后对应的文件又改过",
  lost: "证据写的测试提交在仓库里找不到",
};

/** 这一格的证据有没有问题。线程还在跑时不算：agent 是先打勾、过一会儿才写证据（M0 实测约 20 秒） */
export function evidenceProblem(result, running) {
  const ev = result?.evidence;
  if (!ev || running) return null;
  return EVIDENCE_PROBLEM[ev.state] ? ev.state : null;
}

const MARK = { todo: "⬜ 未测", pass: "✅ 通过", fail: "❌ 不通过", na: "— 这一站没有这条分支", unknown: "认不出的结果" };

function Section({ dir, sec }) {
  const meta = (
    <span className="text-[11px] text-slate-400 font-normal">
      log 第 {sec.line} 行{sec.commit ? ` · 测试提交 ${shortSha(sec.commit)}` : " · 没写测试提交"}
    </span>
  );
  if (sec.voided) {
    return (
      <details className="rounded-lg border border-dashed border-slate-200 px-3 py-2 text-slate-400">
        <summary className="cursor-pointer text-xs">
          <span className="line-through">{sec.heading}</span> {meta}
        </summary>
        <div className="mt-2 opacity-70">
          <Markdown dir={dir}>{sec.body}</Markdown>
        </div>
      </details>
    );
  }
  return (
    <div className="rounded-lg border border-border px-3 py-2.5 flex flex-col gap-2">
      <div className="text-xs font-semibold text-slate-700">
        {sec.heading} {meta}
      </div>
      <Markdown dir={dir}>{sec.body || "（正文是空的）"}</Markdown>
    </div>
  );
}

/**
 * 某一格的证据：结果、证据判断、log 里对应的段落（作废的折叠）。
 * item / result 由父组件按选中的编号和站从最新的清单里找，文件一变内容跟着变；找不到就不渲染。
 */
export default function EvidenceDrawer({ dir, item, result, running, onClose }) {
  const ev = result.evidence;
  const problem = evidenceProblem(result, running);
  const sections = ev?.sections || [];
  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-900/20" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed right-0 top-0 z-50 h-full w-[560px] max-w-[92vw] bg-white border-l border-border shadow-2xl flex flex-col focus:outline-none"
        >
          <div className="shrink-0 flex items-start justify-between gap-3 px-5 py-3.5 border-b border-border bg-slate-50/60">
            <div className="min-w-0">
              <Dialog.Title className="text-sm font-bold text-slate-800">
                {item.id} · {result.site}
              </Dialog.Title>
              <div className="text-[11px] text-slate-500 mt-0.5 truncate">{item.group}</div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-slate-400 hover:text-slate-700 w-6 h-6 rounded-full hover:bg-slate-200/60 flex items-center justify-center cursor-pointer"
              aria-label="关闭证据面板"
            >
              ✕
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-3 text-xs">
            <div className="flex flex-col gap-1.5">
              <div className="font-semibold text-slate-700">{MARK[result.state] || result.state}</div>
              {result.text.length > 2 && <div className="text-slate-500 whitespace-pre-wrap">{result.text}</div>}
              {problem && (
                <div className="rounded-md bg-amber-50 border border-amber-200 text-amber-800 px-3 py-2">
                  {EVIDENCE_PROBLEM[problem]}
                  {problem === "stale" && ev.changed?.length > 0 && `：${ev.changed.join("、")}`}
                </div>
              )}
              {!problem && ev?.state === "ok" && (
                <div className="text-emerald-700">证据齐全，测于 {shortSha(ev.commit)}，之后对应文件没再变过</div>
              )}
              {running && ev && ["missing", "empty", "no-commit"].includes(ev.state) && (
                <div className="text-slate-400">线程还在跑，证据可能还没写进 log</div>
              )}
              {!ev && <div className="text-slate-400">还没有 log 或对照表，看不了证据</div>}
            </div>

            <dl className="grid grid-cols-[72px_1fr] gap-x-3 gap-y-1.5 bg-slate-50 rounded-lg border border-border p-3">
              {Object.entries(item.fields).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-slate-400">{k}</dt>
                  <dd className="text-slate-700 whitespace-pre-wrap break-words">{v}</dd>
                </div>
              ))}
            </dl>

            {sections.length === 0 && ev && <div className="text-slate-400">log 里没有这一格的段落</div>}
            {sections.length > 0 && (
              <div className="flex flex-col gap-2.5">
                {sections.map((sec) => (
                  <Section key={sec.line} dir={dir} sec={sec} />
                ))}
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
