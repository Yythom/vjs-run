import { useState } from "react";
import { useNavigate } from "react-router";
import PageShell from "../../components/page-shell";
import useResource from "../../hooks/use-resource";
import useModalNav from "../../hooks/use-modal-nav";
import T3SettingsPanel from "./t3-settings-panel";
import { BTN, BTN_PRIMARY, PhaseBadge, ThreadBadge, formatTime, shortSha, unwrap, useRangeTestChanges } from "./ui";

function ProgressBar({ counts: c }) {
  const width = (n) => `${(n / (c.total || 1)) * 100}%`;
  return (
    <div title={`清单格子的进度，不是代码覆盖率\n✅ ${c.pass} · ❌ ${c.fail} · — ${c.na} · ⬜ ${c.todo}`}>
      <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden flex">
        <div className="bg-emerald-400" style={{ width: width(c.pass) }} />
        <div className="bg-red-400" style={{ width: width(c.fail) }} />
        <div className="bg-slate-300" style={{ width: width(c.na) }} />
      </div>
      <div className="text-[10.5px] text-slate-400 mt-0.5">
        {c.done}/{c.total}
        {c.fail > 0 && <span className="text-red-500"> · ❌ {c.fail}</span>}
      </div>
    </div>
  );
}

/**
 * 改动测试列表：~/test-records/<仓库>/<主题>/ 下的每一条。
 * 产物文件或线程状态一变，主进程推送过来，整表重新拉一次（记录数量很少，不做增量）。
 */
export default function RangeTestListPage() {
  const navigate = useNavigate();
  const openModal = useModalNav();
  const { data, error, loading, reload } = useResource(() => unwrap(window.electronAPI.rangeTestList()), []);
  useRangeTestChanges(() => reload());
  const [settingsOpen, setSettingsOpen] = useState(false);

  const records = data?.records || [];
  // skill 目录不在版本控制里，被同步覆盖成不带 --json 的版本时，清单就读不出来了
  const skill = useResource(() => window.electronAPI.rangeTestSkill(), []);
  const skillProblem = skill.data?.success
    ? !skill.data.installed
      ? `没找到 commit-range-test：${skill.data.path} 不存在，先安装这个 skill`
      : !skill.data.hasJson
        ? `commit-range-test 的 coverage.mjs 不带 --json（${skill.data.path}），清单显示不了：更新 skill`
        : ""
    : "";

  return (
    <PageShell
      title="改动测试"
      subtitle="按 commit 范围派给 T3 Code 跑 commit-range-test，确认点在这里看清单、回复"
      actions={
        <>
          <button type="button" className={BTN} onClick={() => setSettingsOpen((v) => !v)}>
            T3 设置
          </button>
          <button type="button" className={BTN} onClick={reload}>
            刷新
          </button>
          <button type="button" className={BTN_PRIMARY} onClick={() => openModal("/range-test/new")}>
            新建测试
          </button>
        </>
      }
      className="max-w-5xl p-0"
    >
      {skillProblem && <div className="px-5 py-3 text-xs text-red-700 bg-red-50 border-b border-red-200">{skillProblem}</div>}
      {settingsOpen && (
        <T3SettingsPanel
          onSaved={() => {
            setSettingsOpen(false);
            reload();
          }}
          onCancel={() => setSettingsOpen(false)}
        />
      )}
      {error && <div className="px-5 py-4 text-xs text-red-600">{error.message}</div>}
      {!error && !loading && records.length === 0 && (
        <div className="px-5 py-10 text-center text-xs text-slate-500 leading-relaxed">
          还没有测试记录。点右上角「新建测试」，选仓库和提交范围后派给 T3 Code。
          <br />
          记录放在 {data?.recordsDir}，以前在对话里跑的也会列在这里。
        </div>
      )}
      {records.length > 0 && (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[11px] text-slate-400 border-b border-border">
              <th className="px-4 py-2.5 font-medium">主题</th>
              <th className="px-3 py-2.5 font-medium">仓库</th>
              <th className="px-3 py-2.5 font-medium">范围</th>
              <th className="px-3 py-2.5 font-medium">阶段</th>
              <th className="px-3 py-2.5 font-medium w-36">进度</th>
              <th className="px-3 py-2.5 font-medium">线程</th>
              <th className="px-4 py-2.5 font-medium text-right">更新</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr
                key={r.dir}
                onClick={() => navigate(`/range-test/run?dir=${encodeURIComponent(r.dir)}`)}
                className="border-b border-border/60 last:border-0 hover:bg-slate-50 cursor-pointer"
              >
                <td className="px-4 py-2.5 font-medium text-slate-800">{r.topic}</td>
                <td className="px-3 py-2.5 text-slate-500">{r.repoName}</td>
                <td className="px-3 py-2.5 text-slate-500 font-mono text-[11px]">
                  {r.sidecar ? `${shortSha(r.sidecar.base)}..${shortSha(r.sidecar.tip)}（${r.sidecar.count}）` : "—"}
                </td>
                <td className="px-3 py-2.5">
                  <PhaseBadge kind={r.phaseKind} />
                </td>
                <td className="px-3 py-2.5">
                  {r.progress ? <ProgressBar counts={r.progress} /> : <span className="text-slate-300">—</span>}
                </td>
                <td className="px-3 py-2.5">
                  {r.sidecar ? <ThreadBadge state={r.sidecar.lastState} /> : <span className="text-slate-400">对话里跑的</span>}
                </td>
                <td className="px-4 py-2.5 text-right text-slate-400">{formatTime(r.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </PageShell>
  );
}
