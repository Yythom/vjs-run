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
        ? "ok"
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
              <h2 className="text-sm font-bold text-slate-800">清理 Monorepo</h2>
              <span className="text-xs text-slate-500 ml-1">{statusText}</span>

              <div className="ml-auto flex items-center gap-2 shrink-0">
                {isModal && (
                  <button
                    type="button"
                    onClick={handleOpenWindow}
                    className="px-2.5 py-1 rounded-md border text-[11px] font-medium transition-all bg-white text-slate-700 border-slate-200 hover:bg-slate-50 hover:text-slate-900 shadow-2xs cursor-pointer flex items-center gap-1.5"
                    title="在新窗口中独立进行清理"
                  >
                    <svg className="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                    </svg>
                    <span>新开窗口</span>
                  </button>
                )}

                {(state === "stopped" || state === "error") && (
                  <button
                    type="button"
                    onClick={handleRun}
                    className="px-3 py-1 rounded-md border text-xs font-semibold cursor-pointer transition-all bg-sky-50 text-sky-700 border-sky-200 hover:bg-sky-100 flex items-center gap-1.5 shadow-2xs"
                  >
                    <svg className="w-3.5 h-3.5 text-sky-600" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                    </svg>
                    <span>清理</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleCleanClose}
                  className="text-slate-400 hover:text-slate-700 transition-colors cursor-pointer w-6 h-6 rounded-full hover:bg-slate-100 flex items-center justify-center"
                  aria-label={running ? "终止清理并关闭" : "关闭清理弹窗"}
                  title={running ? "终止清理" : "关闭"}
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                  </svg>
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
