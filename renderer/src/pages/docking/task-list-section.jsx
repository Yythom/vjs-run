import { useMemo, useState } from "react";
import clsx from "../../utils/clsx";
import { confirm } from "../../components/confirm-host";
import { showToast } from "../../utils/toast";
import {
  cancelDockingJob,
  clearSelected,
  removeTasks,
  setSelectedIds,
  toggleSelected,
  useDockingQueue,
  useDockingSelectedIds,
  useDockingStatus,
  useDockingTasks,
} from "../../stores/docking-store";
import TaskCard from "./task-card";
import { FILTERS } from "./constants";

/**
 * 搜索 / 状态筛选 / 任务列表 / 批量派活条。
 *
 * 单独拆出来是因为 filter 与 searchKeyword 是这一整块的私事：留在页面顶层时，
 * 搜索框每敲一个字都要把标题栏、环境状态区、飞书指令说明一起重渲染一遍——
 * 它们跟搜索毫无关系。tasks / selectedIds / queue 也一并在这里订阅，
 * 页面本身于是不再跟着任务流水重渲染。
 */
export default function TaskListSection({
  onRun,
  onOpenThread,
  onViewHistory,
  onViewPlan,
  onPromptGenerated,
}) {
  const tasks = useDockingTasks();
  const selectedIds = useDockingSelectedIds();
  const queue = useDockingQueue();
  const status = useDockingStatus();

  const [filter, setFilter] = useState("inbox");
  const [searchKeyword, setSearchKeyword] = useState("");

  const visible = useMemo(() => {
    let list =
      filter === "all" ? tasks : tasks.filter((t) => t.status === filter);
    if (searchKeyword.trim()) {
      const q = searchKeyword.trim().toLowerCase();
      const isSeqQuery = q.startsWith("#") ? q.slice(1) : q;
      list = list.filter((t) => {
        const matchSeq = String(t.seq) === isSeqQuery;
        const matchTitle = (t.title || "").toLowerCase().includes(q);
        const matchContent = (t.content || "").toLowerCase().includes(q);
        const matchSender =
          (t.requester?.name || "").toLowerCase().includes(q) ||
          (t.requester?.id || "").toLowerCase().includes(q);
        const matchNote = (t.note || "").toLowerCase().includes(q);
        return (
          matchSeq || matchTitle || matchContent || matchSender || matchNote
        );
      });
    }
    return list;
  }, [tasks, filter, searchKeyword]);

  const counts = useMemo(() => {
    const map = {};
    for (const t of tasks) map[t.status] = (map[t.status] || 0) + 1;
    map.all = tasks.length;
    return map;
  }, [tasks]);

  // taskId -> 它对应的运行中 / 排队中 Job。原来是在 map 里对 queue 做两次 find，
  // 每渲染一次就是 O(任务数 × 队列长度)，而且返回值参与不了 memo 比较
  const jobsByTaskId = useMemo(() => {
    const map = new Map();
    const put = (taskId, patch) =>
      map.set(taskId, { ...(map.get(taskId) || {}), ...patch });
    for (const job of queue?.running || []) {
      for (const id of job.taskIds || []) put(id, { runningJob: job });
    }
    for (const job of queue?.queued || []) {
      for (const id of job.taskIds || []) put(id, { queuedJob: job });
    }
    return map;
  }, [queue]);

  const selectAllVisible = () => {
    const visibleIds = visible.map((t) => t.id);
    const allSelected = visibleIds.every((id) => selectedIds.includes(id));
    setSelectedIds(allSelected ? [] : visibleIds);
  };

  const handleBulkDelete = async () => {
    const ok = await confirm({
      title: `批量移除 ${selectedIds.length} 条需求话题`,
      message: `确定要从本工具列表中移除选中的 ${selectedIds.length} 条需求吗？\n（仅在本软件中删除记录，飞书 App 里的聊天记录与消息完全不受影响）`,
      danger: true,
    });
    if (!ok) return;
    const result = await removeTasks(selectedIds);
    if (result?.success) {
      showToast(`已移除 ${result.removed} 条`, "success");
    } else {
      showToast(`删除失败: ${result?.error}`, "error");
    }
  };

  const handleBuildPrompt = async () => {
    const result = await window.electronAPI.dockingBuildPrompt(
      selectedIds,
      true,
    );
    if (!result?.success) {
      showToast(`生成失败: ${result?.error}`, "error");
      return;
    }
    onPromptGenerated(result.prompt);
    showToast(
      `已生成 ${result.count} 条需求的 prompt，并复制到剪贴板`,
      "success",
    );
  };

  return (
    <>
      {/* 搜索与筛选工具栏 */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <input
            type="text"
            className="w-full text-xs pl-7 pr-7 py-1.5 rounded-lg border border-slate-300 bg-white placeholder:text-slate-500 text-slate-800 focus:outline-none focus:ring-1 focus:ring-sky-400"
            placeholder="搜索需求、短号(#7)、发起人、关键词…"
            value={searchKeyword}
            onChange={(e) => setSearchKeyword(e.target.value)}
          />
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 text-xs">
            🔍
          </span>
          {searchKeyword && (
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-700 text-xs cursor-pointer"
              onClick={() => setSearchKeyword("")}
            >
              ✕
            </button>
          )}
        </div>

        {/* 状态筛选页签 */}
        <div className="flex items-center gap-1 flex-wrap">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={clsx(
                "text-[11px] px-2.5 py-1 rounded-full border cursor-pointer transition",
                filter === f.key
                  ? "border-sky-400 bg-sky-50 text-sky-700 font-semibold ring-1 ring-sky-300"
                  : "border-slate-300 text-slate-700 hover:text-slate-900 hover:bg-slate-100 font-medium",
              )}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              {counts[f.key] ? ` ${counts[f.key]}` : ""}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2 shrink-0">
          {selectedIds.length > 0 && (
            <button
              type="button"
              className="text-[11px] px-2.5 py-1 rounded border border-rose-300 text-rose-600 hover:text-rose-700 hover:bg-rose-50 font-medium cursor-pointer flex items-center gap-1 transition shadow-2xs"
              onClick={handleBulkDelete}
            >
              <span>🗑️</span>
              <span>批量删除 ({selectedIds.length})</span>
            </button>
          )}
          <button
            type="button"
            className="text-[11px] text-slate-600 hover:text-slate-900 font-medium cursor-pointer"
            onClick={selectAllVisible}
          >
            全选/取消
          </button>
        </div>
      </div>

      {/* 任务列表 */}
      {visible.length === 0 ? (
        <div className="text-center text-[12px] text-slate-600 font-medium py-16 border border-dashed border-slate-300 rounded-lg bg-slate-50/50">
          {searchKeyword
            ? "没有找到匹配的需求"
            : status.retrying
              ? "连接异常，正在自动重试（可在上方查看原因）…"
              : status.running && !status.retrying
                ? "监听中，等后端同学飞书私聊你……"
                : "还没有任务。可点击右上角「+ 新建需求」或「开始监听飞书」"}
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              checked={selectedIds.includes(task.id)}
              onToggle={toggleSelected}
              runningJob={jobsByTaskId.get(task.id)?.runningJob}
              queuedJob={jobsByTaskId.get(task.id)?.queuedJob}
              onCancelJob={cancelDockingJob}
              onRun={onRun}
              onViewHistory={onViewHistory}
              onOpenThread={onOpenThread}
              onViewPlan={onViewPlan}
            />
          ))}
        </div>
      )}

      {/* 派活条 */}
      {selectedIds.length > 0 && (
        <div className="sticky bottom-0 flex items-center gap-2 bg-white border border-border rounded-lg px-3 py-2 shadow-sm">
          <span className="text-[12px] text-slate-500">
            已选 {selectedIds.length} 条
          </span>
          <button
            type="button"
            className="ml-auto text-[11px] text-slate-400 hover:text-slate-600 cursor-pointer"
            onClick={clearSelected}
          >
            清空
          </button>
          <button
            type="button"
            className="text-xs px-3 py-1.5 rounded border border-rose-200 text-rose-500 hover:bg-rose-50 cursor-pointer"
            onClick={handleBulkDelete}
          >
            删除
          </button>
          <button
            type="button"
            className="text-xs px-3 py-1.5 rounded border border-border text-slate-600 hover:bg-slate-50 cursor-pointer"
            onClick={handleBuildPrompt}
          >
            复制 prompt
          </button>
          <button
            type="button"
            className="text-xs px-3 py-1.5 rounded bg-sky-600 text-white hover:bg-sky-700 cursor-pointer font-medium"
            onClick={() => {
              const selectedTasks = selectedIds
                .map((id) => tasks.find((t) => t.id === id))
                .filter(Boolean);
              onRun(selectedTasks);
            }}
          >
            交给 AI 处理 ({selectedIds.length})
          </button>
        </div>
      )}
    </>
  );
}
