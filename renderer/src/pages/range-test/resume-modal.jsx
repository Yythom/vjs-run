import { useState } from "react";
import Modal from "../../components/modal";
import { showToast } from "../../utils/toast";
import ModelPicker from "./model-picker";
import { BTN, BTN_PRIMARY, unwrap } from "./ui";

/**
 * 换新线程续接：新起一个 T3 线程从产物文件接着做。原线程的模型改不了，想换模型就在这里选。
 * 默认用这条记录当前的 provider / 模型。弹框关掉即卸载，选择随之丢弃。
 */
export default function ResumeModal({ dir, sidecar, onClose, onSent }) {
  const [choice, setChoice] = useState({ provider: sidecar.provider || "", model: sidecar.model || "" });
  const [sending, setSending] = useState(false);

  const send = async () => {
    setSending(true);
    try {
      await unwrap(window.electronAPI.rangeTestContinue({ dir, kind: "new-thread", ...choice }));
      showToast(`已用 ${choice.model} 新起线程续接`, "success");
      onSent();
    } catch (err) {
      showToast(err.message, "error");
      setSending(false);
    }
  };

  return (
    <Modal open onClose={sending ? undefined : onClose} title="换新线程续接" srOnly={false} className="w-[600px] max-w-[94vw]">
      <div className="px-5 py-4 text-xs flex flex-col gap-3">
        <div className="text-slate-600 leading-relaxed">
          会在 T3 里新起一个线程，从产物文件接着做（skill 支持中断续测，不重做出清单）。旧线程不再用，链接留在记录里。
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="text-slate-500">新线程用的模型（原线程的模型改不了，想换就在这里选）</div>
          <ModelPicker value={choice} onChange={setChoice} disabled={sending} />
        </div>
      </div>
      <div className="shrink-0 flex justify-end gap-2 px-5 py-3.5 border-t border-border bg-slate-50/50">
        <button type="button" className={BTN} onClick={onClose} disabled={sending}>
          取消
        </button>
        <button
          type="button"
          className={BTN_PRIMARY}
          onClick={send}
          disabled={sending || !choice.provider.trim() || !choice.model.trim()}
        >
          {sending ? "发送中…" : "新起线程续接"}
        </button>
      </div>
    </Modal>
  );
}
