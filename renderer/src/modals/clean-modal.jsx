import { useState } from "react";
import { useParams } from "react-router";
import LogTerminal from "../components/log-terminal";
import { useAppConfig } from "../stores/app-config-store";
import { CLEAN_ID } from "../constants";
import { showToast } from "../utils/toast";
import * as statusStore from "../stores/status-store";
import * as logStore from "../stores/log-store";
import LogWindowWrapper from "../components/log-window-wrapper";

export default function CleanModal() {
  const { key: routeKey } = useParams();
  const appConfig = useAppConfig();
  const state = statusStore.useStatus(CLEAN_ID);

  const targetRepo = (appConfig.frontendProjectGroups || []).find(
    (repo) => repo.key === routeKey,
  );

  // modal 是 route 组件，每次打开都是新挂载 → useState 默认值即「重置」效果
  const [autoInstall, setAutoInstall] = useState(false);

  // 如果在外部删除了，直接返回空
  if (!targetRepo) return null;

  const running = state === "starting" || state === "running";
  const statusText =
    state === "starting"
      ? "清理中…"
      : state === "stopped"
        ? "清理完成"
        : state === "error"
          ? "出错"
          : "就绪";
  const dotClass =
    state === "starting"
      ? "starting"
      : state === "stopped"
        ? "running"
        : state === "error"
          ? "error"
          : "stopped";

  const handleRun = async () => {
    if (state === "starting") return;
    if (!targetRepo.path) {
      showToast("当前前端仓库路径未配置", "warning");
      return;
    }

    logStore.clear(CLEAN_ID);
    statusStore.set(CLEAN_ID, "starting");

    if (autoInstall) {
      await window.electronAPI.reinstallMonorepo(targetRepo.key);
    } else {
      await window.electronAPI.cleanMonorepo(targetRepo.key);
    }
  };

  return (
    <LogWindowWrapper
      title="清理 Monorepo"
      route={`/repos/${targetRepo.key}/clean`}
      modalClassName="w-[640px] max-w-[92vw] h-[480px] max-h-[90vh]"
      onModalCloseCheck={() => {
        if (running) {
          showToast("清理进行中，请先等待清理完成或终止清理", "warning");
          return false;
        }
        return true;
      }}
    >
      {({ isModal, handleClose, handleOpenWindow }) => {
        // 在关闭前先终止进程
        const handleCleanClose = async () => {
          if (running) {
            await window.electronAPI.stopCleanMonorepo();
          }
          handleClose();
        };

        return (
          <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
            <div className="flex items-center gap-2.5 px-5 py-3.5 border-b border-border shrink-0 bg-white">
              <span className={`status-dot ${dotClass}`}></span>
              <h2 className="text-sm font-semibold text-slate-900">🧹 清理 Monorepo</h2>
              <span className="text-xs text-slate-500 ml-1">{statusText}</span>

              <div className="ml-auto flex items-center gap-2 shrink-0">
                {isModal && (
                  <button
                    type="button"
                    onClick={handleOpenWindow}
                    className="px-2.5 py-1 rounded-md border text-[11px] font-semibold transition-all bg-blue-500/[0.04] text-blue-600 border-blue-500/20 hover:bg-blue-500/10 cursor-pointer"
                    title="在新窗口中独立进行清理"
                  >
                    🖥️ 新开窗口
                  </button>
                )}

                {(state === "stopped" || state === "error") && (
                  <button
                    type="button"
                    onClick={handleRun}
                    className="px-3 py-1 rounded-md border text-xs font-medium cursor-pointer transition-all bg-card text-slate-600 border-border hover:bg-hover hover:text-slate-900"
                  >
                    🧹 清理
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleCleanClose}
                  className="text-slate-500 hover:text-slate-900 transition-colors text-lg leading-none cursor-pointer p-1"
                  aria-label={running ? "终止清理并关闭" : "关闭清理弹窗"}
                  title={running ? "终止清理" : "关闭"}
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="px-5 py-2 border-b border-border shrink-0 flex gap-3 flex-wrap bg-white">
              <span className="text-[11px] text-slate-600 font-medium">
                {targetRepo.label || targetRepo.key}
              </span>
              {targetRepo.path ? (
                <span className="text-[11px] text-slate-400 truncate max-w-full font-mono">
                  {targetRepo.path}
                </span>
              ) : (
                <span className="text-[11px] text-amber-700">
                  请先在设置中配置仓库路径
                </span>
              )}
            </div>

            <div className="px-5 py-2 border-b border-border shrink-0 flex gap-3 flex-wrap bg-white">
              <span className="text-[11px] text-slate-400">node_modules</span>
              <span className="text-[11px] text-slate-300">·</span>
              <span className="text-[11px] text-slate-400">dist</span>
              <span className="text-[11px] text-slate-300">·</span>
              <span className="text-[11px] text-slate-400">.turbo</span>
              <span className="text-[11px] text-slate-300">·</span>
              <span className="text-[11px] text-slate-400">build</span>
            </div>

            <LogTerminal
              paneKey={CLEAN_ID}
              className="flex-1 min-h-0 px-3 py-2"
              style={{ background: "#fafbfc" }}
            />

            <div className="flex items-center justify-between px-5 py-3 border-t border-border shrink-0 bg-white">
              <label className="flex items-center gap-2 cursor-pointer select-none group">
                <input
                  type="checkbox"
                  checked={autoInstall}
                  onChange={(e) => setAutoInstall(e.target.checked)}
                  className="accent-violet-500 w-3.5 h-3.5 cursor-pointer"
                />
                <span className="text-xs text-slate-500 group-hover:text-slate-800 transition-colors">
                  清理完成后自动执行 pnpm install
                </span>
              </label>

              <button
                type="button"
                onClick={handleCleanClose}
                className="px-4 py-1.5 rounded-md border text-xs font-medium cursor-pointer transition-all bg-card text-slate-600 border-border hover:bg-hover hover:text-slate-900"
              >
                {running ? "终止清理" : "关闭"}
              </button>
            </div>
          </div>
        );
      }}
    </LogWindowWrapper>
  );
}
