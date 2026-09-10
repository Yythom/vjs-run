import { useState } from "react";
import Modal from "../../components/modal";
import { showToast } from "../../utils/toast";
import { askRequester } from "../../stores/docking-store";

/**
 * 向提出人追问 / 确认的弹窗。
 *
 * 输入框内容留在组件内部，页面只持有 task（打开即挂载，关闭即卸载并清空草稿）。
 */
export default function AskRequesterModal({ task, onClose }) {
  const [question, setQuestion] = useState("");
  const [sending, setSending] = useState(false);

  const handleAsk = async () => {
    const text = question.trim();
    if (!text || !task) return;

    setSending(true);
    const result = await askRequester(task.id, text);
    setSending(false);
    if (result?.success) {
      showToast(
        "已发送至飞书原消息话题 (Thread)，等对方回复后会自动挂回",
        "success",
      );
      onClose();
    } else {
      showToast(`发送失败: ${result?.error}`, "error");
    }
  };

  return (
    <Modal
      open={Boolean(task)}
      onClose={onClose}
      title="💬 飞书 Thread 话题追问 / 确认"
      srOnly={false}
      className="w-[540px] p-4"
    >
      <p className="text-[12px] text-slate-700 mb-2.5 leading-relaxed">
        将在需求 #{task?.seq}「{task?.title}」的
        <strong className="text-sky-700 font-semibold">
          {" "}
          飞书原消息话题 (Thread){" "}
        </strong>
        下以卡片回复提出人{" "}
        <strong className="text-slate-900">
          {task?.requester?.name || task?.requester?.id || ""}
        </strong>
        。对方直接在飞书该消息下回复，内容将自动同步回本任务。
      </p>
      <textarea
        className="w-full text-[13px] border border-slate-300 rounded p-2 min-h-[120px] resize-y focus:outline-none focus:ring-1 focus:ring-sky-400 bg-white text-slate-900 placeholder:text-slate-500 font-medium"
        placeholder="想对提出人回复或说明什么？例如：该逻辑排查结论已完成；或者需要对方提供具体的测试入参…"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
      />
      <div className="flex justify-end gap-2 mt-3">
        <button
          type="button"
          className="text-xs px-3 py-1.5 rounded border border-slate-300 text-slate-700 hover:bg-slate-100 font-medium cursor-pointer"
          onClick={onClose}
        >
          取消
        </button>
        <button
          type="button"
          disabled={sending || !question.trim()}
          className="text-xs px-3.5 py-1.5 rounded bg-sky-600 hover:bg-sky-700 text-white disabled:opacity-40 cursor-pointer font-medium"
          onClick={handleAsk}
        >
          {sending ? "发送中…" : "发送回复"}
        </button>
      </div>
    </Modal>
  );
}
