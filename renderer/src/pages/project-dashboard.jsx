import { useState } from "react";
import PageShell from "../components/page-shell";
import { useAppConfig } from "../stores/app-config-store";
import {
  useProjects,
  startProject,
  stopProject,
} from "../stores/runner-store";
import { useStatus } from "../stores/status-store";
import useModalNav from "../hooks/use-modal-nav";
import { showToast } from "../utils/toast";
import { copyRepoConfig } from "../utils/export-config";
import { useProjectTabsStore } from "../stores/project-tabs-store";
import clsx from "../utils/clsx";

export default function ProjectDashboard() {
  const openModal = useModalNav();
  const appConfig = useAppConfig();
  const projects = useProjects();

  const repoGroups = appConfig.frontendProjectGroups || [];

  const groupsFromConfig = repoGroups.map((group) => ({
    repoKey: group.key,
    repoLabel: group.label,
    repoPath: group.path,
    projects: projects.filter((project) => project.repoKey === group.key),
  }));

  const seen = new Set(groupsFromConfig.map((group) => group.repoKey));
  const groupsFromProjects = projects
    .filter((project) => !seen.has(project.repoKey))
    .reduce((acc, project) => {
      const existing = acc.find((group) => group.repoKey === project.repoKey);
      if (existing) {
        existing.projects.push(project);
        return acc;
      }
      acc.push({
        repoKey: project.repoKey,
        repoLabel: project.repoLabel || project.repoKey,
        repoPath: "",
        projects: [project],
      });
      return acc;
    }, []);

  const groups = [...groupsFromConfig, ...groupsFromProjects];

  const getRepoTarget = (repoKey) =>
    repoKey ? repoGroups.find((repo) => repo.key === repoKey) || null : null;

  const exportRepo = async (repoKey) => {
    const repo = getRepoTarget(repoKey);
    if (!repo) {
      showToast("未找到可导出的 Repo 配置", "warning");
      return;
    }
    try {
      await copyRepoConfig(repo);
      showToast(`已复制 ${repo.label || repo.key} 的 JSON 配置到剪贴板`, "success");
    } catch (error) {
      showToast(`复制失败: ${error?.message || String(error)}`, "error");
    }
  };

  const { addTab } = useProjectTabsStore();
  const [collapsedRepos, setCollapsedRepos] = useState(() => new Set());

  const toggleRepoCollapse = (repoKey) => {
    setCollapsedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(repoKey)) {
        next.delete(repoKey);
      } else {
        next.add(repoKey);
      }
      return next;
    });
  };

  // 双列瀑布流分发：奇偶索引归入左右两列，保证无视行高限制紧凑排列
  const leftColGroups = groups.filter((_, idx) => idx % 2 === 0);
  const rightColGroups = groups.filter((_, idx) => idx % 2 === 1);

  // 统计概览
  const totalProjects = projects.length;

  return (
    <PageShell
      title="项目管理"
      subtitle="统一管理和运行前端项目，查看实时终端输出与日志"
      noCard={true}
      actions={
        <button
          type="button"
          onClick={() => openModal("/repos/new")}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-all bg-sky-600 text-white hover:bg-sky-700 shadow-xs flex items-center gap-1.5"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          新增项目仓库
        </button>
      }
    >
      {/* 顶部轻量概览栏 */}
      <div className="flex items-center justify-between mb-3 px-1">
        <div className="flex items-center gap-3 text-xs text-slate-500">
          <span>共 <strong className="text-slate-800 font-semibold">{groups.length}</strong> 个仓库</span>
          <span className="text-slate-300">·</span>
          <span>包含 <strong className="text-slate-800 font-semibold">{totalProjects}</strong> 个子项目</span>
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="py-16 flex flex-col items-center justify-center text-center bg-white border border-border/80 rounded-xl">
          <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center text-slate-400 mb-3">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-19.5 0A2.25 2.25 0 0 0 2.25 15v3.75A2.25 2.25 0 0 0 4.5 21h15a2.25 2.25 0 0 0 2.25-2.25V15a2.25 2.25 0 0 0-2.25-2.25m-19.5 0h19.5M2.25 9.75V7.125A2.25 2.25 0 0 1 4.5 5h3.75a3 3 0 0 1 2.25 1L12 8.25h6.75A2.25 2.25 0 0 1 21 10.5V12" />
            </svg>
          </div>
          <h4 className="text-sm font-semibold text-slate-700 mb-1">暂无项目仓库</h4>
          <p className="text-xs text-slate-400 mb-4 max-w-sm">
            点击右上角「新增项目仓库」按钮，配置前端 monorepo 或独立项目路径。
          </p>
          <button
            type="button"
            onClick={() => openModal("/repos/new")}
            className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-sky-600 text-white hover:bg-sky-700 shadow-xs"
          >
            立即新增
          </button>
        </div>
      ) : (
        <div className="flex flex-col md:flex-row gap-3 pb-6 items-start">
          {/* 左侧瀑布流列 */}
          <div className="flex-1 flex flex-col gap-3 min-w-0">
            {leftColGroups.map((group) => (
              <RepoGroupCard
                key={group.repoKey}
                group={group}
                isCollapsed={collapsedRepos.has(group.repoKey)}
                onToggleCollapse={() => toggleRepoCollapse(group.repoKey)}
                openModal={openModal}
                exportRepo={exportRepo}
                addTab={addTab}
              />
            ))}
          </div>

          {/* 右侧瀑布流列（仅在有数据时渲染，防止单列时右侧空白占位） */}
          {rightColGroups.length > 0 && (
            <div className="flex-1 flex flex-col gap-3 min-w-0">
              {rightColGroups.map((group) => (
                <RepoGroupCard
                  key={group.repoKey}
                  group={group}
                  isCollapsed={collapsedRepos.has(group.repoKey)}
                  onToggleCollapse={() => toggleRepoCollapse(group.repoKey)}
                  openModal={openModal}
                  exportRepo={exportRepo}
                  addTab={addTab}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </PageShell>
  );
}

// 提取仓库卡片组件，使瀑布流排版代码更清晰、可维护
function RepoGroupCard({ group, isCollapsed, onToggleCollapse, openModal, exportRepo, addTab }) {
  return (
    <div className="bg-white border border-slate-200/80 rounded-xl shadow-xs flex flex-col overflow-hidden w-full transition-shadow hover:shadow-sm">
      {/* Repo Header - Clickable for Collapse */}
      <div
        className="px-4 py-3.5 border-b border-border bg-slate-50/50 flex items-center gap-2.5 cursor-pointer select-none hover:bg-slate-100/50 transition-colors"
        onClick={onToggleCollapse}
      >
        {/* Collapse indicator */}
        <svg
          className={clsx(
            "w-3.5 h-3.5 text-slate-400 transition-transform duration-200 shrink-0",
            !isCollapsed && "rotate-90"
          )}
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
        </svg>

        <div className="w-7 h-7 rounded-lg bg-sky-50 border border-sky-100/80 flex items-center justify-center text-sky-600 shrink-0">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-19.5 0A2.25 2.25 0 0 0 2.25 15v3.75A2.25 2.25 0 0 0 4.5 21h15a2.25 2.25 0 0 0 2.25-2.25V15a2.25 2.25 0 0 0-2.25-2.25m-19.5 0h19.5M2.25 9.75V7.125A2.25 2.25 0 0 1 4.5 5h3.75a3 3 0 0 1 2.25 1L12 8.25h6.75A2.25 2.25 0 0 1 21 10.5V12" />
          </svg>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-bold text-slate-800 truncate" title={group.repoLabel}>
              {group.repoLabel}
            </h3>
            <span className="text-[10px] text-slate-500 bg-slate-100 px-1.5 py-px rounded-full shrink-0 font-medium font-mono">
              {group.projects.length}
            </span>
          </div>
          {group.repoPath && (
            <p className="text-[10.5px] text-slate-400 truncate mt-0.5 font-mono" title={group.repoPath}>
              {group.repoPath}
            </p>
          )}
        </div>

        {/* Repo Actions */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            title="配置仓库"
            className="w-7 h-7 rounded-md border border-slate-200 bg-white text-slate-500 hover:text-slate-800 hover:bg-slate-50 transition-colors flex items-center justify-center cursor-pointer shadow-xs"
            onClick={(e) => {
              e.stopPropagation();
              openModal(`/repos/${group.repoKey}/edit`);
            }}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
            </svg>
          </button>
          <button
            type="button"
            title="复制 JSON 配置"
            className="w-7 h-7 rounded-md border border-slate-200 bg-white text-slate-500 hover:text-slate-800 hover:bg-slate-50 transition-colors flex items-center justify-center cursor-pointer shadow-xs"
            onClick={(e) => {
              e.stopPropagation();
              exportRepo(group.repoKey);
            }}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75" />
            </svg>
          </button>
          <button
            type="button"
            title="一键清理仓库"
            className="w-7 h-7 rounded-md border border-slate-200 bg-white text-slate-500 hover:text-slate-800 hover:bg-slate-50 transition-colors flex items-center justify-center cursor-pointer shadow-xs"
            onClick={(e) => {
              e.stopPropagation();
              openModal(`/repos/${group.repoKey}/clean`);
            }}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
            </svg>
          </button>
        </div>
      </div>

      {/* Projects List */}
      {!isCollapsed && (
        <div className="p-3.5 flex-1 flex flex-col gap-2 bg-white">
          {group.projects.length === 0 ? (
            <div className="text-center py-6 text-slate-400 text-xs">
              该仓库下暂无项目，点击右上角设置图标添加项目
            </div>
          ) : (
            group.projects.map((project) => (
              <DashboardProjectItem
                key={project.id}
                project={project}
                onNavigate={() => {
                  addTab(project.id);
                  openModal("/projects/logs");
                }}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function DashboardProjectItem({ project, onNavigate }) {
  const status = useStatus(project.id);
  const isActive = status === "running" || status === "starting";

  const handleToggleRun = (e) => {
    e.stopPropagation();
    if (isActive) {
      stopProject(project.id);
    } else {
      startProject(project.id);
    }
  };

  return (
    <div
      onClick={onNavigate}
      className="flex items-center justify-between p-2.5 px-3 rounded-lg border border-slate-100/90 hover:border-slate-300 hover:bg-slate-50/50 cursor-pointer transition-all group/item shadow-xs"
    >
      <div className="flex items-center gap-2.5 min-w-0">
        {/* Status Dot */}
        <div className={`status-dot ${status}`} />
        <div className="min-w-0">
          <div className="text-xs font-semibold text-slate-800 truncate group-hover/item:text-sky-600 transition-colors">
            {project.name}
          </div>
          {project.command && (
            <div className="text-[10px] text-slate-400 truncate font-mono mt-0.5">
              {project.command}
            </div>
          )}
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onClick={handleToggleRun}
          title={isActive ? "停止运行" : "启动运行"}
          className={clsx(
            "h-7 px-2.5 rounded-md text-[11px] font-semibold flex items-center justify-center gap-1.5 cursor-pointer transition-all shadow-xs",
            isActive
              ? "bg-red-50 text-red-700 border border-red-200 hover:bg-red-100"
              : "bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100"
          )}
        >
          {isActive ? (
            <>
              <svg className="w-2.5 h-2.5 fill-current" viewBox="0 0 24 24">
                <rect x="5" y="5" width="14" height="14" rx="2" />
              </svg>
              停止
            </>
          ) : (
            <>
              <svg className="w-2.5 h-2.5 fill-current" viewBox="0 0 24 24">
                <path d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z" />
              </svg>
              启动
            </>
          )}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onNavigate();
          }}
          className="h-7 px-2.5 rounded-md border border-slate-200 bg-white text-[11px] font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900 transition-all cursor-pointer shadow-xs flex items-center gap-1"
        >
          <svg className="w-3 h-3 text-slate-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="m6.75 7.5 3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0 0 21 18V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v12a2.25 2.25 0 0 0 2.25 2.25Z" />
          </svg>
          日志
        </button>
      </div>
    </div>
  );
}
