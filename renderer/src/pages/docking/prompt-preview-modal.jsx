import Modal from "../../components/modal";

/** 生成的 prompt 预览弹窗（内容已同步复制到剪贴板）。 */
export default function PromptPreviewModal({ prompt, onClose }) {
  return (
    <Modal
      open={Boolean(prompt)}
      onClose={onClose}
      title="生成的 prompt"
      srOnly={false}
      className="w-[720px] p-4"
    >
      <pre className="text-[12px] whitespace-pre-wrap break-words bg-slate-50 rounded p-3 max-h-[60vh] overflow-y-auto font-sans">
        {prompt}
      </pre>
      <p className="text-[11px] text-slate-400 mt-2">已复制到剪贴板。</p>
    </Modal>
  );
}
