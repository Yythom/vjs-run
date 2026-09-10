import { useMemo, useState } from "react";
import clsx from "../../utils/clsx";
import Modal from "../../components/modal";
import { confirm } from "../../components/confirm-host";
import { showToast } from "../../utils/toast";
import useJobHistory from "./use-job-history";
import { formatTime } from "./utils";

// ─── AI 调用历史回看弹窗 ──────────────────────────────────────────────────
/**
 * 列表、筛选、详情、删除全部自己管（见 use-job-history）。
 *
 * 这些 state 原来挂在 DockingPage 上：主进程每推一次「历史已更新」就把整页
 * 重渲染一遍，而面板往往根本没开。现在由调用方按 open 条件挂载，关掉即卸载。
 */
export default function JobHistoryModal({ onClose, initialTaskId = "" }) {
  const {
    list: historyList,
    total,
    selectedJobId,
    selectedJobDetail,
    filterTaskId,
    filterEngine,
    filterStatus,
    loadJobDetail: onSelectJob,
    changeFilter,
    deleteJob,
    clearAll,
  } = useJobHistory(initialTaskId);

  const [activeTab, setActiveTab] = useState("prompt"); // "prompt" | "logs" | "result"
  const [searchFilter, setSearchFilter] = useState("");

  const onFilterTaskChange = (tid) => changeFilter("taskId", tid);
  const onFilterEngineChange = (eng) => changeFilter("engine", eng);
  const onFilterStatusChange = (st) => changeFilter("status", st);

  const onDeleteJob = async (jobId) => {
    const ok = await confirm({
      title: "删除历史记录",
      message: "确定要删除该条 AI 调用历史记录吗？",
      danger: true,
    });
    if (!ok) return;
    await deleteJob(jobId);
    showToast("已删除该条调用记录", "success");
  };

  const onClearHistory = async () => {
    const ok = await confirm({
      title: "清空所有调用历史",
      message: "确定要清空全部 AI 调用历史记录吗？",
      danger: true,
    });
    if (!ok) return;
    await clearAll();
    showToast("已清空所有历史记录", "success");
  };

  const filteredList = useMemo(() => {
    if (!searchFilter.trim()) return historyList;
    const q = searchFilter.trim().toLowerCase();
    return historyList.filter(
      (it) =>
        it.id.toLowerCase().includes(q) ||
        (it.taskTitles || []).some((t) => t.toLowerCase().includes(q)) ||
        (it.promptPreview || "").toLowerCase().includes(q) ||
        (it.cwd || "").toLowerCase().includes(q),
    );
  }, [historyList, searchFilter]);

  return (
    <Modal
      open
      onClose={onClose}
      title={`📜 AI 调用历史回看 (${total})`}
      srOnly={false}
      className="w-[980px] max-w-[95vw] h-[82vh] p-4 flex flex-col"
    >
      <div className="flex-1 min-h-0 flex gap-4 pt-1">
        {/* 左侧：调用历史列表与过滤 */}
        <div className="w-[320px] shrink-0 flex flex-col border-r border-slate-200 pr-3 min-h-0">
          {/* 过滤筛选栏 */}
          <div className="space-y-2 pb-2 border-b border-slate-200 shrink-0">
            <div className="relative">
              <input
                type="text"
                placeholder="搜索历史记录/任务短号/Prompt..."
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                className="w-full text-xs pl-7 pr-2 py-1.5 border border-slate-300 rounded bg-white text-slate-800 placeholder:text-slate-500 font-medium focus:outline-none focus:ring-1 focus:ring-sky-400"
              />
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500 text-xs">
                🔍
              </span>
            </div>

            <div className="flex items-center gap-1.5 text-xs">
              <select
                value={filterEngine}
                onChange={(e) => onFilterEngineChange(e.target.value)}
                className="flex-1 text-[11px] border border-slate-300 rounded px-1.5 py-1 bg-white text-slate-800 font-medium"
              >
                <option value="">全部引擎</option>
                <option value="claude">Claude Code</option>
                <option value="agy">Antigravity</option>
                <option value="codex">Codex</option>
              </select>
              <select
                value={filterStatus}
                onChange={(e) => onFilterStatusChange(e.target.value)}
                className="flex-1 text-[11px] border border-slate-300 rounded px-1.5 py-1 bg-white text-slate-800 font-medium"
              >
                <option value="">全部状态</option>
                <option value="done">✓ 成功</option>
                <option value="error">✕ 错误</option>
                <option value="aborted">⏹️ 中断</option>
              </select>
            </div>

            {filterTaskId && (
              <div className="flex items-center justify-between text-[11px] px-2 py-1 bg-sky-50 text-sky-800 border border-sky-200 rounded font-medium">
                <span>仅显示当前需求历史</span>
                <button
                  type="button"
                  className="text-sky-600 hover:text-sky-950 cursor-pointer font-bold ml-1"
                  onClick={() => onFilterTaskChange("")}
                >
                  ✕ 全部
                </button>
              </div>
            )}
          </div>

          {/* 列表条目 */}
          <div className="flex-1 min-h-0 overflow-y-auto space-y-1.5 pt-2">
            {filteredList.length === 0 ? (
              <div className="text-center text-xs text-slate-400 py-12">
                暂无历史记录
              </div>
            ) : (
              filteredList.map((item) => {
                const isSelected = item.id === selectedJobId;
                const isSuccess = item.status === "done" && item.exitCode === 0;
                const durationSec = ((item.durationMs || 0) / 1000).toFixed(1);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onSelectJob(item.id)}
                    className={clsx(
                      "w-full text-left p-2 rounded-lg border transition cursor-pointer flex flex-col gap-1",
                      isSelected
                        ? "border-sky-500 bg-sky-50/80 ring-1 ring-sky-400"
                        : "border-slate-200 hover:border-slate-300 hover:bg-slate-50 bg-white",
                    )}
                  >
                    <div className="flex items-center justify-between text-[11px]">
                      <div className="flex items-center gap-1 font-bold">
                        <span
                          className={clsx(
                            "w-1.5 h-1.5 rounded-full shrink-0",
                            isSuccess
                              ? "bg-emerald-500"
                              : item.status === "aborted"
                                ? "bg-amber-500"
                                : "bg-rose-500",
                          )}
                        />
                        <span
                          className={
                            isSelected ? "text-sky-900" : "text-slate-800"
                          }
                        >
                          {item.engine === "agy"
                            ? "Antigravity"
                            : item.engine === "codex"
                              ? "Codex"
                              : "Claude Code"}
                        </span>
                        <span className="text-[10px] px-1 rounded bg-slate-100 text-slate-700 border border-slate-200 font-normal">
                          {item.mode === "analyze"
                            ? "只读分析"
                            : item.mode === "edit"
                              ? "改代码"
                              : "全自动"}
                        </span>
                      </div>
                      <span className="text-[10px] text-slate-400 font-mono">
                        {durationSec}s
                      </span>
                    </div>

                    <div className="text-xs text-slate-900 font-semibold truncate">
                      {(item.taskTitles || []).join("、") || "任务处理"}
                    </div>

                    <div className="flex items-center justify-between text-[10px] text-slate-500 pt-0.5">
                      <span>
                        {formatTime(item.createdAt || item.startTime)}
                      </span>
                      {item.modifiedFilesCount > 0 && (
                        <span className="text-emerald-700 font-medium">
                          🛠️ {item.modifiedFilesCount} 改动
                        </span>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>

          {/* 底部清空全部历史按钮 */}
          {historyList.length > 0 && (
            <div className="pt-2 border-t border-slate-200 shrink-0">
              <button
                type="button"
                className="w-full text-center text-[11px] py-1 text-slate-500 hover:text-rose-600 hover:bg-rose-50 rounded transition font-medium cursor-pointer"
                onClick={onClearHistory}
              >
                🗑️ 清空所有历史记录
              </button>
            </div>
          )}
        </div>

        {/* 右侧：选中记录的完整详情 */}
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          {selectedJobDetail ? (
            <div className="flex-1 min-h-0 flex flex-col space-y-3">
              {/* 顶部元信息卡片 */}
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg shrink-0 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span
                      className={clsx(
                        "text-xs px-2 py-0.5 rounded font-bold border",
                        selectedJobDetail.status === "done" &&
                          selectedJobDetail.exitCode === 0
                          ? "bg-emerald-100 text-emerald-800 border-emerald-300"
                          : selectedJobDetail.status === "aborted"
                            ? "bg-amber-100 text-amber-800 border-amber-300"
                            : "bg-rose-100 text-rose-800 border-rose-300",
                      )}
                    >
                      {selectedJobDetail.status === "done" &&
                      selectedJobDetail.exitCode === 0
                        ? "✓ 执行成功"
                        : selectedJobDetail.status === "aborted"
                          ? "⏹️ 用户中断"
                          : `✕ 异常退出 (${selectedJobDetail.exitCode})`}
                    </span>
                    <span className="text-sm font-bold text-slate-900">
                      {selectedJobDetail.engine === "agy"
                        ? "Antigravity CLI"
                        : selectedJobDetail.engine === "codex"
                          ? "Codex CLI"
                          : "Claude Code CLI"}
                    </span>
                    <span className="text-xs text-slate-500">
                      · 耗时:{" "}
                      {((selectedJobDetail.durationMs || 0) / 1000).toFixed(1)}s
                    </span>
                  </div>

                  <button
                    type="button"
                    className="text-xs px-2.5 py-1 text-rose-600 hover:bg-rose-50 border border-rose-200 rounded font-medium cursor-pointer transition flex items-center gap-1"
                    onClick={() => onDeleteJob(selectedJobDetail.id)}
                  >
                    <span>🗑️</span>
                    <span>删除该条记录</span>
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-700 pt-1">
                  <div>
                    <span className="text-slate-400">执行模式：</span>
                    <span className="font-semibold text-slate-800">
                      {selectedJobDetail.mode === "analyze"
                        ? "只读分析 / 逻辑排查"
                        : selectedJobDetail.mode === "edit"
                          ? "允许改代码"
                          : "全自动"}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400">开始时间：</span>
                    <span className="font-mono text-slate-800">
                      {formatTime(selectedJobDetail.startTime)}
                    </span>
                  </div>
                  {selectedJobDetail.cwd && (
                    <div className="col-span-2 truncate">
                      <span className="text-slate-400">工作目录：</span>
                      <span
                        className="font-mono text-slate-800"
                        title={selectedJobDetail.cwd}
                      >
                        {selectedJobDetail.cwd}
                      </span>
                    </div>
                  )}
                  {selectedJobDetail.branchName && (
                    <div>
                      <span className="text-slate-400">隔离分支：</span>
                      <span className="font-mono text-emerald-800 font-bold">
                        🌿 {selectedJobDetail.branchName}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* 标签切换页签 */}
              <div className="flex items-center gap-2 border-b border-slate-200 shrink-0">
                <button
                  type="button"
                  className={clsx(
                    "px-3 py-1.5 text-xs font-bold border-b-2 cursor-pointer transition flex items-center gap-1",
                    activeTab === "prompt"
                      ? "border-sky-600 text-sky-700"
                      : "border-transparent text-slate-600 hover:text-slate-900",
                  )}
                  onClick={() => setActiveTab("prompt")}
                >
                  <span>⚡</span>
                  <span>输入指令与 Prompt</span>
                </button>
                <button
                  type="button"
                  className={clsx(
                    "px-3 py-1.5 text-xs font-bold border-b-2 cursor-pointer transition flex items-center gap-1",
                    activeTab === "logs"
                      ? "border-sky-600 text-sky-700"
                      : "border-transparent text-slate-600 hover:text-slate-900",
                  )}
                  onClick={() => setActiveTab("logs")}
                >
                  <span>📜</span>
                  <span>
                    执行日志与终端输出 ({selectedJobDetail.logs?.length || 0})
                  </span>
                </button>
                <button
                  type="button"
                  className={clsx(
                    "px-3 py-1.5 text-xs font-bold border-b-2 cursor-pointer transition flex items-center gap-1",
                    activeTab === "result"
                      ? "border-sky-600 text-sky-700"
                      : "border-transparent text-slate-600 hover:text-slate-900",
                  )}
                  onClick={() => setActiveTab("result")}
                >
                  <span>🛠️</span>
                  <span>改动文件与答复结论</span>
                  {selectedJobDetail.modifiedFiles?.length > 0 && (
                    <span className="text-[10px] px-1.5 py-[1px] bg-emerald-100 text-emerald-800 rounded-full font-bold ml-1">
                      {selectedJobDetail.modifiedFiles.length}
                    </span>
                  )}
                </button>
              </div>

              {/* 内容区域 */}
              <div className="flex-1 min-h-0 overflow-y-auto">
                {activeTab === "prompt" && (
                  <div className="space-y-2 h-full flex flex-col">
                    <div className="flex items-center justify-between shrink-0">
                      <span className="text-xs text-slate-600 font-medium">
                        当时喂给 AI 的完整多轮会话 Prompt 与上下文指令：
                      </span>
                      <button
                        type="button"
                        className="text-xs px-2.5 py-1 rounded bg-white hover:bg-slate-100 border border-slate-300 text-slate-800 font-medium cursor-pointer shadow-2xs"
                        onClick={() => {
                          navigator.clipboard.writeText(
                            selectedJobDetail.prompt || "",
                          );
                          showToast("已复制输入 Prompt 指令", "success");
                        }}
                      >
                        📋 复制完整 Prompt
                      </button>
                    </div>
                    <pre className="flex-1 text-[12px] whitespace-pre-wrap break-words bg-slate-50 border border-slate-200 rounded-lg p-3 font-sans text-slate-900 overflow-y-auto leading-relaxed select-text">
                      {selectedJobDetail.prompt || "(无指令内容)"}
                    </pre>
                  </div>
                )}

                {activeTab === "logs" && (
                  <div className="space-y-2 h-full flex flex-col">
                    <div className="flex items-center justify-between shrink-0">
                      <span className="text-xs text-slate-600 font-medium">
                        清晰的终端执行与工具调用日志（已过滤内部思考过程）：
                      </span>
                      <button
                        type="button"
                        className="text-xs px-2.5 py-1 rounded bg-white hover:bg-slate-100 border border-slate-300 text-slate-800 font-medium cursor-pointer shadow-2xs"
                        onClick={() => {
                          const logStr = (selectedJobDetail.logs || [])
                            .map(
                              (l) =>
                                `[${formatTime(l.at)}] [${l.kind}] ${l.text}`,
                            )
                            .join("\n");
                          navigator.clipboard.writeText(logStr);
                          showToast("已复制全部执行日志", "success");
                        }}
                      >
                        📋 复制全量日志
                      </button>
                    </div>
                    <div className="flex-1 bg-slate-950 text-slate-100 font-mono text-[11px] p-3 rounded-lg overflow-y-auto space-y-1 select-text">
                      {!selectedJobDetail.logs ||
                      selectedJobDetail.logs.length === 0 ? (
                        <div className="text-slate-500">暂无日志记录</div>
                      ) : (
                        selectedJobDetail.logs.map((log, li) => (
                          <div
                            key={li}
                            className={clsx(
                              "whitespace-pre-wrap break-words leading-relaxed",
                              log.kind === "error"
                                ? "text-rose-400 font-bold"
                                : log.kind === "meta"
                                  ? "text-sky-300 font-bold"
                                  : "text-slate-200",
                            )}
                          >
                            <span className="text-slate-600 mr-2 select-none">
                              {formatTime(log.at)}
                            </span>
                            {log.text}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}

                {activeTab === "result" && (
                  <div className="space-y-4">
                    {/* 改动文件 */}
                    <div>
                      <div className="font-bold text-xs text-slate-800 mb-2 flex items-center gap-1.5">
                        <span>🛠️</span>
                        <span>本次调用改动的文件列表：</span>
                      </div>
                      {!selectedJobDetail.modifiedFiles ||
                      selectedJobDetail.modifiedFiles.length === 0 ? (
                        <div className="text-xs text-slate-500 bg-slate-50 p-2.5 rounded border border-slate-200">
                          本次调用未修改任何代码文件（例如只读排查模式或未产生变更）
                        </div>
                      ) : (
                        <div className="space-y-1.5">
                          {selectedJobDetail.modifiedFiles.map((f, fi) => (
                            <div
                              key={fi}
                              className="flex items-center justify-between text-xs bg-emerald-50/60 border border-emerald-200 rounded p-2 text-emerald-900 font-mono"
                            >
                              <span>📄 {f}</span>
                              <button
                                type="button"
                                className="text-[11px] px-2 py-0.5 rounded bg-white hover:bg-emerald-100 border border-emerald-300 font-sans cursor-pointer transition"
                                onClick={() => {
                                  navigator.clipboard.writeText(f);
                                  showToast(`已复制路径: ${f}`, "success");
                                }}
                              >
                                复制路径
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* 处理答复与结论 */}
                    {selectedJobDetail.resultNote && (
                      <div>
                        <div className="font-bold text-xs text-slate-800 mb-2 flex items-center gap-1.5">
                          <span>💡</span>
                          <span>写回的答复结论：</span>
                        </div>
                        <div className="p-3 bg-amber-50/70 border border-amber-200 rounded-lg text-xs text-slate-900 whitespace-pre-wrap break-words font-sans leading-relaxed select-text">
                          {selectedJobDetail.resultNote}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-xs text-slate-400">
              👈 请在左侧选择一条历史记录回看
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
