import { useEffect } from "react";
import { useLocation } from "react-router";
import DetailPanel from "./detail-panel";
import Welcome from "./welcome";
import {
  useProjects,
  useDebugCommand,
  setDebugCommand,
  startProject,
  stopProject,
  runDebugCommand,
} from "../stores/runner-store";
import { useStatus } from "../stores/status-store";
import * as logStore from "../stores/log-store";
import { getStatusLabel } from "../utils/status";
import { useProjectTabsStore } from "../stores/project-tabs-store";
import LogWindowWrapper from "../components/log-window-wrapper";
import { useCloseModal } from "../hooks/use-modal-nav";
import clsx from "../utils/clsx";

export default function ProjectConsole() {
  const projects = useProjects();
  const debugCommand = useDebugCommand();
  const close = useCloseModal();
  const location = useLocation();

  const isSubWindow = location.search.includes("window=sub");
  const isModal = !isSubWindow;

  const { openedIds, activeId: id, setActiveId, removeTab } = useProjectTabsStore();

  // 如果没有打开的标签页或者没有活跃的项目，自动关闭弹窗或窗口归位
  useEffect(() => {
    if (openedIds.length === 0 || !id) {
      if (isModal) {
        close();
      } else {
        window.electronAPI.closeWindow();
      }
    }
  }, [id, openedIds, isModal, close]);

  // 过滤掉无效的项目 id
  useEffect(() => {
    if (openedIds.length > 0 && projects.length > 0) {
      const validOpenedIds = openedIds.filter((oid) => projects.some((p) => p.id === oid));
      if (validOpenedIds.length !== openedIds.length) {
        useProjectTabsStore.setState({ openedIds: validOpenedIds });
      }
    }
  }, [openedIds, projects]);

  const project = projects.find((p) => p.id === id);
  const status = useStatus(id);

  const handleCloseTab = (tabId, e) => {
    e.stopPropagation();
    removeTab(tabId);
  };

  return (
    <LogWindowWrapper title="项目控制台" route="/projects/logs">
      {({ isModal: wrapperIsModal, handleClose, handleOpenWindow }) => {
        if (!project) {
          return <Welcome />;
        }

        const isActive = status === "running" || status === "starting";
        const detail = {
          name: project.name,
          filter: project.command || "—",
          logTitle: `${project.name} — ${project.command || "command"}`,
          status,
          label: getStatusLabel(status),
          badgeClass: status,
        };

        return (
          <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
            <div className="shrink-0 h-9 bg-slate-100/60 border-b border-border flex items-center px-2.5 overflow-x-auto select-none gap-1">
              {openedIds.map((tabId) => {
                const tabProj = projects.find((p) => p.id === tabId);
                if (!tabProj) return null;

                const isCurrent = tabId === id;
                return (
                  <TabItem
                    key={tabId}
                    id={tabId}
                    name={tabProj.name}
                    isCurrent={isCurrent}
                    onClick={() => setActiveId(tabId)}
                    onClose={(e) => handleCloseTab(tabId, e)}
                  />
                );
              })}

              {/* 右侧窗口与关闭动作按钮 */}
              {wrapperIsModal ? (
                <button
                  type="button"
                  onClick={handleOpenWindow}
                  className="ml-auto mr-1 text-slate-500 hover:text-slate-700 text-xs font-semibold leading-none py-1.5 px-2.5 rounded-md hover:bg-slate-200/50 transition-colors shrink-0 cursor-pointer"
                  title="在新窗口中独立打开日志控制台"
                >
                  🖥️ 新开窗口
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleClose}
                  className="ml-auto mr-1.5 text-slate-400 hover:text-slate-700 text-xs font-semibold leading-none py-1.5 px-2.5 rounded-md hover:bg-slate-200/50 transition-colors shrink-0 cursor-pointer"
                  aria-label="关闭日志控制台"
                >
                  ✕ 关闭
                </button>
              )}
            </div>

            {/* 下方的详情面板 */}
            <DetailPanel
              paneKey={id}
              detail={detail}
              isModal={wrapperIsModal}
              primaryAction={
                isActive
                  ? { label: "⏹ 停止", variant: "stop", onClick: () => stopProject(id) }
                  : { label: "▶ 启动", variant: "start", onClick: () => startProject(id) }
              }
              onClearLog={() => logStore.clear(id)}
              debugInput={{
                value: debugCommand,
                onChange: setDebugCommand,
                onRun: () => runDebugCommand(id),
                placeholder: "在当前项目目录执行命令（例如: pnpm -v）",
              }}
            />
          </div>
        );
      }}
    </LogWindowWrapper>
  );
}

// 独立的 Tab 项，用来精确订阅其状态，避免其它项目状态变化时导致整个 Tab 栏重渲染
function TabItem({ id, name, isCurrent, onClick, onClose }) {
  const tabStatus = useStatus(id);
  return (
    <div
      onClick={onClick}
      className={clsx(
        "group h-7 rounded-md px-2.5 flex items-center gap-1.5 cursor-pointer text-[11px] font-semibold transition-all border shrink-0",
        isCurrent
          ? "bg-white border-border text-slate-800 shadow-[0_1px_2px_rgba(0,0,0,0.03)]"
          : "bg-transparent border-transparent text-slate-500 hover:bg-slate-200/40 hover:text-slate-800"
      )}
    >
      <div className={`status-dot ${tabStatus}`} style={{ width: 6, height: 6, minWidth: 6 }} />
      <span className="truncate max-w-[120px]">{name}</span>
      <button
        type="button"
        onClick={onClose}
        className="opacity-0 group-hover:opacity-100 hover:bg-slate-200 text-slate-400 hover:text-slate-700 rounded-full w-3.5 h-3.5 flex items-center justify-center text-[8px] transition-all ml-0.5"
      >
        ✕
      </button>
    </div>
  );
}
