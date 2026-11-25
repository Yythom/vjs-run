import { useSearchParams } from "react-router";
import PageShell from "../../components/page-shell";
import useResource from "../../hooks/use-resource";
import { showToast } from "../../utils/toast";
import ChecklistMatrix from "./checklist-matrix";
import ConfirmWorkspace from "./confirm-workspace";
import { evidenceProblem } from "./evidence-drawer";
import Markdown from "./markdown";
import NextStepCard from "./next-step-card";
import { remainingCells } from "../../../../src/services/range-test/checklist.js";
import { ReportCard, RunningCard, SceneCard } from "./run-cards";
import { BTN, PhaseBadge, ThreadBadge, shortSha, unwrap, useRangeTestChanges, PROGRESS_CAVEAT } from "./ui";

function Card({ children, className = "" }) {
  return <div className={`bg-white border border-slate-200/80 rounded-xl shadow-xs p-4 text-xs ${className}`}>{children}</div>;
}

function ThreadCard({ record, thread, threadError }) {
  const sidecar = record.sidecar;
  if (!sidecar) {
    return <Card className="text-slate-500">这条记录是在对话里跑的，没有 T3 线程，这里只能查看。</Card>;
  }
  const state = thread?.state || sidecar.lastState;
  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <ThreadBadge state={state} />
        <span className="text-slate-500">
          {sidecar.provider} · {sidecar.model}
        </span>
      </div>
      {state === "needs-answer" && (
        <div className="text-amber-700">agent 用了提问工具，界面答不了：点右上角「在 T3 中打开」去回答，答完这里会自动刷新。</div>
      )}
      {sidecar.lastError && state === "failed" && <div className="text-red-600">{sidecar.lastError}</div>}
      {threadError && <div className="text-red-600">查线程状态失败：{threadError}</div>}
      {sidecar.threads?.length > 0 && (
        <div className="text-slate-500">
          之前的线程：
          {sidecar.threads.map((t, i) => (
            <button
              key={t.threadId}
              type="button"
              disabled={!t.link}
              className="ml-2 text-sky-700 underline underline-offset-2 cursor-pointer disabled:text-slate-400 disabled:no-underline"
              onClick={() => window.electronAPI.openExternal(t.link)}
            >
              第 {i + 1} 个
            </button>
          ))}
        </div>
      )}
      {thread?.lastMessage && (
        <details open={state !== "running"}>
          <summary className="cursor-pointer text-slate-500">agent 最新一条消息</summary>
          <div className="mt-2 max-h-96 overflow-y-auto bg-slate-50 border border-border rounded-md p-3">
            <Markdown>{thread.lastMessage}</Markdown>
          </div>
        </details>
      )}
    </Card>
  );
}

function ProgressCard({ status, running }) {
  const c = status.counts;
  const hasEvidence = status.items.some((i) => i.results.some((r) => r.evidence));
  const evidenceProblems = status.items.reduce(
    (n, i) => n + i.results.filter((r) => evidenceProblem(r, running)).length,
    0,
  );
  return (
    <Card className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-slate-700">清单 → 实测</span>
        <span className="text-slate-500">
          已出结果 {c.done}/{c.total} 格 · ✅ {c.pass} · ❌ {c.fail} · — {c.na} · ⬜ 还剩 {c.todo}
        </span>
      </div>
      <div className="text-slate-400">{PROGRESS_CAVEAT}</div>
      {hasEvidence && (
        <div className={evidenceProblems ? "text-amber-700" : "text-slate-500"}>
          {running
            ? "线程还在跑：agent 先打勾、过一会儿才写证据，证据问题等这一轮结束再标"
            : evidenceProblems
              ? `${evidenceProblems} 格证据有问题（格子右上角有橙点，点开看原因）`
              : "打了勾的格都有证据，且都是在当前代码上测的。点格子看证据"}
        </div>
      )}
      <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden flex">
        <div className="bg-emerald-400" style={{ width: `${(c.pass / (c.total || 1)) * 100}%` }} />
        <div className="bg-red-400" style={{ width: `${(c.fail / (c.total || 1)) * 100}%` }} />
        <div className="bg-slate-300" style={{ width: `${(c.na / (c.total || 1)) * 100}%` }} />
      </div>
      {status.problems.length > 0 && (
        <ul className="pl-4 list-disc text-amber-700">
          {status.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** 确认开测之后，agent 改了已确认的哪些行（含确认时要求的调整）。没有快照（旧记录）就不显示 */
function ConfirmDiffCard({ diff }) {
  if (!diff || (!diff.edited.length && !diff.removed.length && !diff.added.length)) return null;
  const editedIds = [...new Set(diff.edited.map((e) => e.id))];
  return (
    <Card className="flex flex-col gap-1 border-amber-200 bg-amber-50/40">
      <div className="font-semibold text-amber-800">确认开测之后，清单被改过</div>
      <div className="text-slate-600">
        {editedIds.length > 0 && <>改了内容：{editedIds.map((id) => `${id}（${diff.edited.filter((e) => e.id === id).map((e) => e.field).join("、")}）`).join("、")}。</>}
        {diff.removed.length > 0 && <>删掉：{diff.removed.join("、")}。</>}
        {diff.added.length > 0 && <>新增：{diff.added.join("、")}。</>}
      </div>
      <div className="text-slate-400">矩阵里改过的格有橙色底色，悬停看原来的内容。确认时你要求的调整也算在里面。</div>
    </Card>
  );
}

function RunDetail({ dir }) {
  const { data, error, reload } = useResource(() => unwrap(window.electronAPI.rangeTestDetail({ dir })), [dir]);
  useRangeTestChanges((evt) => {
    if (evt.dir === dir) reload();
  });

  if (error) {
    return <PageShell title="改动测试">{<div className="text-xs text-red-600">{error.message}</div>}</PageShell>;
  }
  if (!data) return <PageShell title="改动测试">{<div className="text-xs text-slate-400">读取中…</div>}</PageShell>;

  const { record, status, statusError, thread, threadError, confirmDiff, findings, sceneHints, latestEvidence } = data;
  const changes = new Map((confirmDiff?.edited || []).map((e) => [`${e.id}\0${e.field}`, e.before]));
  const sidecar = record.sidecar;
  const threadState = thread?.state || sidecar?.lastState;
  // 确认点：线程这一轮结束了，清单还是「待确认」。只看文件和线程状态，不解析 agent 说了什么
  const atConfirmPoint = Boolean(sidecar?.threadId && status && record.phaseKind === "pending" && threadState === "idle");
  const running = threadState === "running";
  // 第二阶段跑完：已确认、这一轮结束（或对话里跑的旧记录）、本地没有能测的 ⬜
  const finished = Boolean(
    status && record.phaseKind === "confirmed" && !running && remainingCells(status.items).local.length === 0,
  );

  const openThread = async () => {
    try {
      await unwrap(window.electronAPI.rangeTestOpenThread({ dir }));
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  return (
    <PageShell
      title={record.topic}
      subtitle={
        sidecar
          ? `${record.repoName} · ${shortSha(sidecar.base)}..${shortSha(sidecar.tip)}（${sidecar.count} 个提交）`
          : record.repoName
      }
      actions={
        <>
          <PhaseBadge kind={record.phaseKind} />
          <button type="button" className={BTN} onClick={() => window.electronAPI.openDirectory(dir)}>
            打开目录
          </button>
          {sidecar?.threadId && (
            <button type="button" className={BTN} onClick={openThread}>
              在 T3 中打开
            </button>
          )}
          <button type="button" className={BTN} onClick={reload}>
            刷新
          </button>
        </>
      }
      noCard
      className="max-w-6xl w-full mx-auto gap-3 h-auto"
    >
      <ThreadCard record={record} thread={thread} threadError={threadError} />
      {running && <RunningCard dir={dir} sidecar={sidecar} latestEvidence={latestEvidence} />}
      {finished && <ReportCard status={status} findings={findings} />}
      {statusError && <Card className="text-red-600">读清单失败：{statusError}</Card>}
      {!status && !statusError && (
        <Card className="text-slate-400">
          {threadState === "running" ? "agent 正在出清单，产物文件一出现这里就会显示…" : "目录里还没有清单文件。"}
        </Card>
      )}
      {status && <ProgressCard status={status} running={threadState === "running"} />}
      <NextStepCard dir={dir} record={record} status={status} thread={thread} threadState={threadState} onDone={reload} />
      <ConfirmDiffCard diff={confirmDiff} />
      {sceneHints?.length > 0 && <SceneCard hints={sceneHints} running={running} />}
      {status &&
        (atConfirmPoint ? (
          <ConfirmWorkspace dir={dir} status={status} updatedAt={record.updatedAt} onSent={reload} />
        ) : (
          <ChecklistMatrix items={status.items} dir={dir} running={threadState === "running"} changes={changes} />
        ))}
    </PageShell>
  );
}

/** 改动测试详情。记录用 ?dir= 指定；换一条记录时 key 变，确认点的表单从头开始 */
export default function RunDetailPage() {
  const [params] = useSearchParams();
  const dir = params.get("dir");
  if (!dir) return <PageShell title="改动测试">{<div className="text-xs text-slate-500">没有指定记录</div>}</PageShell>;
  return <RunDetail key={dir} dir={dir} />;
}
