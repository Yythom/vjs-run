import { useCallback, useEffect, useState } from "react";
import { confirm } from "../../components/confirm-host";
import { loadTasks } from "../../stores/docking-store";
import { showToast } from "../../utils/toast";

function formatBytes(n) {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 任务的隔离 worktree：现状 + 清理。
 *
 * 清理前要能看清「删掉会不会丢东西」：AI 在「允许改代码」档下通常不提交，
 * 改动全是未提交的，所以这里把未提交文件数、多出的提交、有没有合进主仓库都摆出来。
 * 清理本身不丢改动（先自动提交进分支），真正会丢的是「连分支一起删」，单独二次确认。
 *
 * 现状每次打开弹窗、任务状态变了、清理完都重新拉——worktree 在磁盘上，
 * AI 跑完或者人在终端里 commit 过，store 里都没有增量可推。
 */
export default function WorktreePanel({ task, busy }) {
  const [info, setInfo] = useState(null);
  const [working, setWorking] = useState(false);

  const refresh = useCallback(async () => {
    const res = await window.electronAPI.dockingWorktreeInfo(task.id);
    if (res?.success) setInfo(res.info);
    else setInfo(null);
  }, [task.id]);

  // task.updatedAt 变了（AI 回写、清理、重派）就重拉；busy 结束时也重拉一次。
  // 弹窗关得快时丢掉迟到的结果
  useEffect(() => {
    let cancelled = false;
    window.electronAPI.dockingWorktreeInfo(task.id).then((res) => {
      if (!cancelled) setInfo(res?.success ? res.info : null);
    });
    return () => {
      cancelled = true;
    };
  }, [task.id, task.updatedAt, task.worktreePath, busy]);

  if (!info || (!info.exists && !info.branchExists)) return null;

  const cleanup = async (deleteBranch) => {
    if (deleteBranch) {
      const risky = !info.merged && (info.commits.length > 0 || info.dirtyCount > 0);
      const ok = await confirm({
        title: "删除 worktree 与分支",
        message:
          `将删除分支 ${info.branch}${info.exists ? " 和它的 worktree 目录" : ""}。\n` +
          (risky
            ? `⚠️ 这条分支还没合进 ${info.mainBranch || "主仓库当前分支"}` +
              `（${info.commits.length} 个提交${info.dirtyCount ? `、${info.dirtyCount} 个未提交文件` : ""}），删了就找不回来了。`
            : "分支上的改动已经合并过，删掉不会丢东西。"),
        confirmText: "删除",
        danger: true,
      });
      if (!ok) return;
    }
    setWorking(true);
    try {
      const res = await window.electronAPI.dockingWorktreeCleanup(task.id, deleteBranch);
      if (!res?.success) throw new Error(res?.error || "清理失败");
      const { savedCommit, branchDeleted } = res.result;
      showToast(
        branchDeleted
          ? "已删除 worktree 与分支"
          : savedCommit
            ? `已清理 worktree，未提交改动已存进分支（${savedCommit}）`
            : "已清理 worktree，分支保留",
        "success",
      );
      await loadTasks();
      await refresh();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      setWorking(false);
    }
  };

  const disabled = busy || working;

  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-2.5 text-[11px] text-slate-700 space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-bold text-emerald-900">🌿 隔离工作区</span>
        <code className="font-mono text-emerald-800 bg-white border border-emerald-200 px-1.5 py-0.5 rounded">
          {info.branch}
        </code>
        {info.baseBranch && <span className="text-slate-500">从 {info.baseBranch} 拉出</span>}
        {info.exists ? (
          <span className="text-slate-500">· 占用 {formatBytes(info.bytes)}</span>
        ) : (
          <span className="text-slate-500">· 目录已清理，分支保留（再派活会自动重建）</span>
        )}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        {info.exists && (
          <span className={info.dirtyCount ? "text-amber-800 font-medium" : "text-slate-500"}>
            未提交改动 {info.dirtyCount} 个文件
          </span>
        )}
        <span className={info.commits.length ? "text-slate-800 font-medium" : "text-slate-500"}>
          分支新提交 {info.commits.length} 个
        </span>
        {info.shortstat && <span className="text-slate-500 font-mono">{info.shortstat}</span>}
        {info.commits.length > 0 && (
          <span className={info.merged ? "text-emerald-700 font-medium" : "text-slate-500"}>
            {info.merged ? `✓ 已合进 ${info.mainBranch}` : `未合进 ${info.mainBranch}`}
          </span>
        )}
      </div>

      {(info.dirty.length > 0 || info.commits.length > 0) && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-slate-500 hover:text-slate-800">展开明细</summary>
          <div className="mt-1 max-h-40 overflow-y-auto font-mono bg-white border border-emerald-100 rounded p-2 space-y-0.5">
            {info.commits.map((c) => (
              <div key={c.sha}>
                <span className="text-emerald-700">{c.sha}</span> {c.subject}
              </div>
            ))}
            {info.dirty.map((line) => (
              <div key={line} className="text-amber-800 whitespace-pre">
                {line}
              </div>
            ))}
            {info.dirtyCount > info.dirty.length && (
              <div className="text-slate-400">… 还有 {info.dirtyCount - info.dirty.length} 个</div>
            )}
          </div>
        </details>
      )}

      <div className="flex items-center gap-2 pt-0.5">
        {info.exists && (
          <>
            <button
              type="button"
              className="px-2 py-0.5 rounded border border-slate-300 bg-white hover:bg-slate-50 cursor-pointer font-medium"
              onClick={async () => {
                const res = await window.electronAPI.dockingWorktreeOpen(task.id);
                if (!res?.success) showToast(res?.error || "打开失败", "error");
              }}
            >
              在 Finder 打开
            </button>
            <button
              type="button"
              className="px-2 py-0.5 rounded border border-slate-300 bg-white hover:bg-slate-50 cursor-pointer font-medium"
              onClick={() => {
                navigator.clipboard.writeText(info.path);
                showToast("已复制 worktree 路径", "success");
              }}
            >
              复制路径
            </button>
            <button
              type="button"
              disabled={disabled}
              className="px-2 py-0.5 rounded border border-emerald-300 bg-white hover:bg-emerald-50 text-emerald-800 cursor-pointer font-medium disabled:opacity-40 disabled:cursor-not-allowed"
              title={
                busy
                  ? "AI 正在这里处理，跑完才能清理"
                  : "删掉工作目录，未提交的改动先自动提交到分支，分支保留"
              }
              onClick={() => cleanup(false)}
            >
              {working ? "清理中…" : "清理 worktree"}
            </button>
          </>
        )}
        <button
          type="button"
          disabled={disabled}
          className="px-2 py-0.5 rounded border border-rose-300 bg-white hover:bg-rose-50 text-rose-700 cursor-pointer font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          title={busy ? "AI 正在这里处理，跑完才能清理" : "连分支一起删掉"}
          onClick={() => cleanup(true)}
        >
          {info.exists ? "清理并删除分支" : "删除分支"}
        </button>
      </div>
    </div>
  );
}
