import { useState } from "react";
import Modal from "../../components/modal";
import useResource from "../../hooks/use-resource";
import { showToast } from "../../utils/toast";
import { BTN, BTN_PRIMARY, shortSha, unwrap } from "./ui";

/**
 * 回归：列出清单头「实测代码」之后的提交，勾选哪些是修复，再让 agent 做第 9 步。
 * 弹框关掉即卸载，勾选状态随之清空。
 */
export default function RegressModal({ dir, onClose, onSent }) {
  const { data, error, loading } = useResource(() => unwrap(window.electronAPI.rangeTestFixCommits({ dir })), [dir]);
  const [picked, setPicked] = useState(() => new Set());
  const [sending, setSending] = useState(false);
  const commits = data?.commits || [];

  const toggle = (sha) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(sha)) next.delete(sha);
      else next.add(sha);
      return next;
    });

  const send = async () => {
    setSending(true);
    try {
      await unwrap(window.electronAPI.rangeTestContinue({ dir, kind: "regress", commits: [...picked] }));
      showToast("已让 T3 做回归", "success");
      onSent();
    } catch (err) {
      showToast(err.message, "error");
      setSending(false);
    }
  };

  return (
    <Modal open onClose={sending ? undefined : onClose} title="回归：选修复提交" srOnly={false} className="w-[640px] max-w-[94vw] max-h-[85vh]">
      <div className="flex-1 overflow-y-auto px-5 py-4 text-xs flex flex-col gap-3">
        <div className="text-slate-500">
          实测代码是 {shortSha(data?.testedHead)}，下面是它之后的提交。勾选修复了这次问题的提交，agent 会读它们的 diff，把受影响的行和原来 ❌ 的行退回重测，报告只写变化。
        </div>
        {loading && <div className="text-slate-400">读提交列表…</div>}
        {error && <div className="text-red-600">{error.message}</div>}
        {data && commits.length === 0 && <div className="text-slate-500">实测之后还没有新提交：先把修复提交了再来回归。</div>}
        {commits.map((c) => (
          <label key={c.sha} className="flex items-start gap-2 text-slate-700 cursor-pointer">
            <input type="checkbox" className="mt-0.5" checked={picked.has(c.sha)} onChange={() => toggle(c.sha)} />
            <span>
              <span className="font-mono text-slate-500">{c.short}</span> · {c.date} · {c.author} · {c.subject}
            </span>
          </label>
        ))}
      </div>
      <div className="shrink-0 flex justify-end gap-2 px-5 py-3.5 border-t border-border bg-slate-50/50">
        <button type="button" className={BTN} onClick={onClose} disabled={sending}>
          取消
        </button>
        <button type="button" className={BTN_PRIMARY} onClick={send} disabled={sending || picked.size === 0}>
          {sending ? "发送中…" : `用这 ${picked.size} 个提交回归`}
        </button>
      </div>
    </Modal>
  );
}
