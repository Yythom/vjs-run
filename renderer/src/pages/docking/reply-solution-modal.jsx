import { useState } from "react";
import Modal from "../../components/modal";
import { showToast } from "../../utils/toast";
import { replySolution } from "../../stores/docking-store";

/**
 * 回送排查解答弹窗。
 *
 * 草稿正文（可能上千字）与勾选项都留在组件内部，避免每敲一个字就重渲染整页。
 * 初值由 task.note 决定，靠 key 挂载时取一次即可。
 */
export default function ReplySolutionModal({ task, onClose }) {
  const [solutionText, setSolutionText] = useState(() => task?.note || "");
  const [solutionMarkDone, setSolutionMarkDone] = useState(true);
  const [solutionSending, setSolutionSending] = useState(false);

  const handleReplySolution = async () => {
    if (!task || !solutionText.trim()) return;
    setSolutionSending(true);
    const result = await replySolution(
      task.id,
      solutionText.trim(),
      solutionMarkDone,
    );
    setSolutionSending(false);
    if (result?.success) {
      showToast("已成功将排查解答回送给对方", "success");
      onClose();
    } else {
      showToast(`发送失败: ${result?.error}`, "error");
    }
  };

  return (
    <Modal
      open={Boolean(task)}
      onClose={onClose}
      title="💬 飞书回送排查解答 (Thread 话题回复)"
      srOnly={false}
      className="w-[560px] p-4"
    >
      <p className="text-[12px] text-slate-700 mb-2.5 leading-relaxed">
        将在需求 #{task?.seq}「{task?.title}」的
        <strong className="text-emerald-700 font-semibold">
          {" "}
          飞书原消息话题 (Thread){" "}
        </strong>
        下以结构化卡片回送排查解答给{" "}
        <strong className="text-slate-900">
          {task?.requester?.name || task?.requester?.id || "提出人"}
        </strong>
        。
      </p>
      <textarea
        className="w-full text-[12px] border border-slate-300 rounded p-2.5 min-h-[140px] resize-y focus:outline-none focus:ring-1 focus:ring-sky-400 font-sans text-slate-800"
        placeholder="排查解答内容（可在线微调修改）..."
        value={solutionText}
        onChange={(e) => setSolutionText(e.target.value)}
      />
      <div className="mt-2.5 flex items-center justify-between">
        <label className="flex items-center gap-1.5 text-xs text-slate-700 font-medium cursor-pointer">
          <input
            type="checkbox"
            className="accent-sky-600"
            checked={solutionMarkDone}
            onChange={(e) => setSolutionMarkDone(e.target.checked)}
          />
          <span>发送后同时将任务标记为「已完成」</span>
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            className="text-xs px-3 py-1.5 rounded border border-slate-300 text-slate-700 hover:bg-slate-100 font-medium cursor-pointer"
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            disabled={solutionSending || !solutionText.trim()}
            className="text-xs px-3.5 py-1.5 rounded bg-sky-600 hover:bg-sky-700 text-white disabled:opacity-40 cursor-pointer font-semibold shadow-xs"
            onClick={handleReplySolution}
          >
            {solutionSending ? "发送中…" : "确认发送"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
