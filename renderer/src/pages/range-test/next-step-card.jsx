import { useState } from "react";
import useConfirm from "../../hooks/use-confirm";
import { showToast } from "../../utils/toast";
import { remainingCells } from "../../../../src/services/range-test/checklist.js";
import RegressModal from "./regress-modal";
import ResumeModal from "./resume-modal";
import { BTN, BTN_PRIMARY, unwrap } from "./ui";

// 已经跑了很多轮的线程上下文很长，建议换新线程（只提示，不强制）
const MANY_RUNS = 8;

const ACTIONS = {
  continue: {
    label: "继续测",
    title: "继续测",
    message: "agent 会接着测本地能测的 ⬜ 格：可能起 dev server、切测试 mock 场景、种假的登录 cookie，测完恢复。确定继续吗？",
    toast: "已让 T3 接着测",
  },
  "fix-evidence": {
    label: "修正证据问题",
    title: "修正证据问题",
    message: "agent 会逐条处理 status 报的问题，过期的证据要退回重测，可能会起 dev server、切 mock 场景。确定开始吗？",
    toast: "已让 T3 处理证据问题",
  },
  "check-offline": {
    label: "核对线上行",
    title: "核对【测试服】【真机】【线上】的格",
    message:
      "agent 会用只读方式核对这些格（只做 GET 访问、看页面、读响应头），不下单、不付款、不登录真实账号、不改数据；核对不了的保持 ⬜ 并写明还需要什么。线上还没发布这次改动的，会记成「未发布，暂不能核对」。确定开始吗？",
    toast: "已让 T3 核对线上行",
  },
};

/**
 * 线程这一轮结束后，根据文件状态给出下一步。按钮条件只是界面提示，主进程会按文件再判断一遍。
 * 确认点（待确认 + 本轮结束）由确认工作区负责，这里只在线程出了问题时提供「换新线程续接」。
 */
export default function NextStepCard({ dir, record, status, thread, threadState, onDone }) {
  const { confirm, confirmDialog } = useConfirm();
  // 正在发哪个操作；发完 onDone 重新拉详情，线程转成运行中后本卡片不再渲染
  const [pending, setPending] = useState(null);
  const [regressOpen, setRegressOpen] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);

  const sidecar = record.sidecar;
  if (!sidecar || threadState === "running" || threadState === "starting") return null;
  const threadBroken = !sidecar.threadId || ["failed", "needs-answer", "unknown"].includes(threadState);
  const longThread = (thread?.runCount || 0) >= MANY_RUNS;
  const confirmed = record.phaseKind === "confirmed";
  if (!confirmed && !threadBroken) return null;

  const { local, offline } = status ? remainingCells(status.items) : { local: [], offline: [] };
  const problems = status?.problems || [];
  // 失败的线程也能接着发消息（T3 会开一轮新的运行，实测过）：撞上额度上限这类失败，原线程重试就行，
  // 不必换新线程。只有卡在提问工具（needs-answer）时 send 答不了
  const canSend = Boolean(sidecar.threadId) && ["idle", "failed"].includes(threadState);

  const run = async (kind) => {
    const a = ACTIONS[kind];
    if (!(await confirm({ title: a.title, message: a.message, confirmText: a.label }))) return;
    setPending(kind);
    try {
      await unwrap(window.electronAPI.rangeTestContinue({ dir, kind }));
      showToast(a.toast, "success");
      onDone();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      setPending(null);
    }
  };

  const summary = [];
  if (confirmed) {
    if (local.length) summary.push(`还有 ${local.length} 格本地能测`);
    else if (offline.length) summary.push(`本地已测完，剩 ${offline.length} 格要到测试服 / 真机 / 线上测（${offline.join("、")}）`);
    else summary.push("全部格子都出了结果");
    if (problems.length) summary.push(`status 报了 ${problems.length} 个问题`);
  }
  if (threadState === "failed") summary.push("上一轮失败了（原因见上方线程卡片）：额度、网络这类问题可以直接在原线程重试，也可以换新线程从产物文件接着做");
  else if (threadBroken) summary.push(sidecar.threadId ? "线程出了问题，可以换新线程从产物文件接着做" : "还没有线程");
  else if (longThread) summary.push(`线程已经跑了 ${thread.runCount} 轮，上下文很长，可以考虑换新线程`);

  const button = (kind, primary) => (
    <button
      key={kind}
      type="button"
      className={primary ? BTN_PRIMARY : BTN}
      disabled={Boolean(pending)}
      onClick={() => run(kind)}
    >
      {pending === kind ? "发送中…" : ACTIONS[kind].label}
    </button>
  );
  const buttons = [];
  if (confirmed && canSend && local.length) buttons.push(button("continue", true));
  if (confirmed && canSend && problems.length) buttons.push(button("fix-evidence", !local.length));
  if (confirmed && canSend && offline.length) buttons.push(button("check-offline", false));
  if (confirmed && canSend && !local.length && !problems.length) {
    buttons.push(
      <button key="regress" type="button" className={BTN} disabled={Boolean(pending)} onClick={() => setRegressOpen(true)}>
        回归
      </button>,
    );
  }
  // 换新线程要能选模型，走自己的弹框
  buttons.push(
    <button
      key="new-thread"
      type="button"
      className={threadBroken && buttons.length === 0 ? BTN_PRIMARY : BTN}
      disabled={Boolean(pending)}
      onClick={() => setResumeOpen(true)}
    >
      换新线程续接
    </button>,
  );

  return (
    <div className="bg-white border border-sky-200 rounded-xl shadow-xs p-4 text-xs flex flex-col gap-2.5">
      {confirmDialog}
      <div className="font-semibold text-slate-700">下一步</div>
      <div className="text-slate-600">
        {summary.join("；")}
        {problems.length > 0 && "（问题原文见上方进度卡）"}
      </div>
      <div className="flex justify-end gap-2">{buttons}</div>
      {resumeOpen && (
        <ResumeModal
          dir={dir}
          sidecar={sidecar}
          onClose={() => setResumeOpen(false)}
          onSent={() => {
            setResumeOpen(false);
            onDone();
          }}
        />
      )}
      {regressOpen && (
        <RegressModal
          dir={dir}
          onClose={() => setRegressOpen(false)}
          onSent={() => {
            setRegressOpen(false);
            onDone();
          }}
        />
      )}
    </div>
  );
}
