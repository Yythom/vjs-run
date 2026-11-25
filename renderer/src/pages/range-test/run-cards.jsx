import { useEffect, useState } from "react";
import useConfirm from "../../hooks/use-confirm";
import useResource from "../../hooks/use-resource";
import { showToast } from "../../utils/toast";
import { isOfflineItem, remainingCells } from "../../../../src/services/range-test/checklist.js";
import Markdown, { EvidenceImage } from "./markdown";
import { BTN, PROGRESS_CAVEAT, unwrap } from "./ui";

function Card({ children, className = "" }) {
  return <div className={`bg-white border border-slate-200/80 rounded-xl shadow-xs p-4 text-xs ${className}`}>{children}</div>;
}

/** 当前时间，每秒走一次；active 为 false 时不开计时器 */
function useNow(active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

const fmtDuration = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m} 分 ${String(s % 60).padStart(2, "0")} 秒`;
};

/**
 * 线程运行中：已用时 + 最近一张截图。M0b 实测 agent 可能把勾攒到最后才写，进度条长时间是 0，
 * 这张卡片让人看得出它在干活
 */
export function RunningCard({ dir, sidecar, latestEvidence }) {
  const now = useNow(true);
  const started = Date.parse(sidecar?.runStartedAt || sidecar?.lastReplyAt || sidecar?.createdAt || "");
  return (
    <Card className="flex flex-col gap-2 border-sky-200">
      <div className="text-sky-700">
        这一轮已用时 {Number.isNaN(started) ? "—" : fmtDuration(now - started)}
        {latestEvidence && `，最近一张截图在 ${fmtDuration(now - latestEvidence.mtime)}前`}
      </div>
      {latestEvidence && (
        <div className="max-w-md">
          <div className="text-slate-400 mb-1">{latestEvidence.path}</div>
          {/* key 带上 mtime：同名截图被覆盖时重新读 */}
          <EvidenceImage key={`${latestEvidence.path}@${latestEvidence.mtime}`} dir={dir} src={latestEvidence.path} />
        </div>
      )}
    </Card>
  );
}

/** 第二阶段跑完（已确认 + 本轮结束 + 没有本地能测的 ⬜）时的报告：数字来自 status，发现取自 log */
export function ReportCard({ status, findings }) {
  const fails = [];
  const nas = [];
  for (const item of status.items) {
    for (const r of item.results) {
      if (r.state === "fail") fails.push(`${item.id}·${r.site}`);
      if (r.state === "na") nas.push(`${item.id}·${r.site}：${r.text.replace(/^—\s*/, "") || "没写原因"}`);
    }
  }
  const { offline } = remainingCells(status.items);
  const c = status.counts;
  return (
    <Card className="flex flex-col gap-2.5 border-emerald-200">
      <div className="font-semibold text-slate-800">测试报告</div>
      <div className={fails.length ? "text-red-600" : "text-emerald-700"}>
        已出结果 {c.done}/{c.total} 格：✅ {c.pass} · ❌ {c.fail} · — {c.na} · ⬜ {c.todo}
        {status.problems.length ? `；status 还报了 ${status.problems.length} 个问题` : "；打了勾的格都有证据"}
      </div>
      <div className="text-slate-400">{PROGRESS_CAVEAT}</div>
      <Section title="不通过" empty="无">
        {fails.length > 0 && <div className="text-red-600">{fails.join("、")}（点矩阵里的格子看证据）</div>}
      </Section>
      <Section title="没测到" empty="无">
        {offline.length > 0 && (
          <div>
            要到测试服 / 真机 / 线上测：{offline.join("、")}
            （{status.items.filter(isOfflineItem).map((i) => i.id).join("、")} 标了【测试服】【真机】【线上】）
          </div>
        )}
        {nas.length > 0 && (
          <ul className="pl-4 list-disc">
            {nas.map((n) => (
              <li key={n}>标了「—」{n}</li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="发现（取自 log）" empty="log 里没有「发现」一节，看上方 agent 报告里的「其他发现」">
        {findings && <Markdown>{findings}</Markdown>}
      </Section>
      <div className="text-slate-400">留下的东西（产物、mock 场景、要你手动关的标签页）见上方 agent 的报告。</div>
    </Card>
  );
}

function Section({ title, empty, children }) {
  const has = Array.isArray(children) ? children.some(Boolean) : Boolean(children);
  return (
    <div className="flex flex-col gap-1">
      <div className="font-semibold text-slate-600">{title}</div>
      <div className="text-slate-600">{has ? children : <span className="text-slate-400">{empty}</span>}</div>
    </div>
  );
}

/**
 * 这次测试建的 mock 场景：skill 规定 agent 不删场景，留给使用者定。复用 mock 已有的场景接口。
 * 线程运行中按钮置灰，免得和 agent 抢着改场景
 */
export function SceneCard({ hints, running }) {
  const { confirm, confirmDialog } = useConfirm();
  const { data, reload } = useResource(() => window.electronAPI.listMockScenes(), [hints.join("\n")]);
  const [busy, setBusy] = useState(false);
  const scenes = (data?.scenes || []).filter((s) => hints.includes(s.name));
  if (scenes.length === 0) return null;

  const act = async (kind, name) => {
    const ok = await confirm(
      kind === "delete"
        ? { title: "删除 mock 场景", message: `删除场景「${name}」？场景文件会被删掉，不能恢复。`, confirmText: "删除", danger: true }
        : { title: "应用 mock 场景", message: `把「${name}」应用为当前生效的规则？会覆盖现在的活动规则。`, confirmText: "应用" },
    );
    if (!ok) return;
    setBusy(true);
    try {
      await unwrap(kind === "delete" ? window.electronAPI.deleteMockScene(name) : window.electronAPI.applyMockScene(name));
      showToast(kind === "delete" ? `已删除「${name}」` : `已应用「${name}」`, "success");
      reload();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="flex flex-col gap-2">
      {confirmDialog}
      <div className="font-semibold text-slate-700">这次测试建的 mock 场景</div>
      <div className="text-slate-400">当前生效：{data?.appliedScene || "（没有命名场景）"}</div>
      {scenes.map((s) => (
        <div key={s.name} className="flex items-center gap-2">
          <span className="flex-1 truncate text-slate-700">
            {s.name}
            <span className="text-slate-400">（{s.ruleCount} 条{data?.appliedScene === s.name ? "，生效中" : ""}）</span>
          </span>
          <button type="button" className={BTN} disabled={running || busy} onClick={() => act("apply", s.name)}>
            应用
          </button>
          <button type="button" className={BTN} disabled={running || busy} onClick={() => act("delete", s.name)}>
            删除
          </button>
        </div>
      ))}
    </Card>
  );
}
