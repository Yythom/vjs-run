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

  return (
    <PageShell
      title="项目管理"
      subtitle="统一管理和运行前端项目，查看终端输出与日志"
      noCard={true}
      actions={
        <button
          type="button"
          onClick={() => openModal("/repos/new")}
          className="px-2 py-1 rounded-md border text-xs font-semibold cursor-pointer transition-all bg-blue-500 text-white border-blue-600 hover:bg-blue-600 shadow-sm"
        >
          ＋ 新增项目仓库
        </button>
      }
    >
      <div className="flex flex-col md:flex-row gap-2 pb-6 items-start">
        {/* 左侧瀑布流列 */}
        <div className="flex-1 flex flex-col gap-2 min-w-0">
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
          <div className="flex-1 flex flex-col gap-2 min-w-0">
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
    </PageShell>
  );
}

// 提取仓库卡片组件，使瀑布流排版代码更清晰、可维护
function RepoGroupCard({ group, isCollapsed, onToggleCollapse, openModal, exportRepo, addTab }) {
  return (
    <div className="bg-white border border-border rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.02)] flex flex-col overflow-hidden w-full">
      {/* Repo Header - Clickable for Collapse */}
      <div
        className="px-5 py-4 border-b border-border bg-slate-50/50 flex items-center gap-2.5 cursor-pointer select-none hover:bg-slate-100/50 transition-colors"
        onClick={onToggleCollapse}
      >
        {/* Collapse indicator */}
        <span className="text-[10px] text-slate-400 font-mono transition-transform duration-200 shrink-0">
          {isCollapsed ? "▶" : "▼"}
        </span>

        <span className="text-base shrink-0">📂</span>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-slate-800 truncate" title={group.repoLabel}>
              {group.repoLabel}
            </h3>
            <span className="text-[10px] text-slate-400 bg-slate-200/50 px-1.5 py-0.5 rounded-full shrink-0 font-medium scale-90">
              {group.projects.length}
            </span>
          </div>
          {group.repoPath && (
            <p className="text-[10px] text-slate-400 truncate mt-0.5" title={group.repoPath}>
              {group.repoPath}
            </p>
          )}
        </div>

        {/* Repo Actions */}
        <div className="flex gap-1 shrink-0">
          <button
            type="button"
            title="配置仓库"
            className="w-6.5 h-6.5 rounded-md border border-slate-200 bg-white text-[11px] text-slate-500 hover:bg-slate-100 hover:text-slate-900 transition-colors flex items-center justify-center cursor-pointer shadow-sm"
            onClick={(e) => {
              e.stopPropagation();
              openModal(`/repos/${group.repoKey}/edit`);
            }}
          >
            ⚙️
          </button>
          <button
            type="button"
            title="复制 JSON 配置"
            className="w-6.5 h-6.5 rounded-md border border-slate-200 bg-white text-[11px] text-slate-500 hover:bg-slate-100 hover:text-slate-900 transition-colors flex items-center justify-center cursor-pointer shadow-sm"
            onClick={(e) => {
              e.stopPropagation();
              exportRepo(group.repoKey);
            }}
          >
            📋
          </button>
          <button
            type="button"
            title="一键清理仓库"
            className="w-6.5 h-6.5 rounded-md border border-slate-200 bg-white text-[11px] text-slate-500 hover:bg-slate-100 hover:text-slate-900 transition-colors flex items-center justify-center cursor-pointer shadow-sm"
            onClick={(e) => {
              e.stopPropagation();
              openModal(`/repos/${group.repoKey}/clean`);
            }}
          >
            🧹
          </button>
        </div>
      </div>

      {/* Projects List */}
      {!isCollapsed && (
        <div className="p-4 flex-1 flex flex-col gap-2 bg-white">
          {group.projects.length === 0 ? (
            <div className="text-center py-8 text-slate-400 text-xs">
              该仓库下暂无项目，点击右上角 ⚙️ 编辑仓库以添加项目
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
      className="flex items-center justify-between p-3 rounded-lg border border-slate-100 hover:border-blue-500/20 hover:bg-blue-50/[0.02] cursor-pointer transition-all group/item shadow-[0_1px_2px_rgba(0,0,0,0.01)]"
    >
      <div className="flex items-center gap-3 min-w-0">
        {/* Status Dot */}
        <div className={`status-dot ${status}`} style={{ width: 8, height: 8 }} />
        <div className="min-w-0">
          <div className="text-xs font-bold text-slate-700 truncate group-hover/item:text-blue-600 transition-colors">
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
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={handleToggleRun}
          title={isActive ? "停止运行" : "启动运行"}
          className={clsx(
            "h-6.5 px-2.5 rounded-md border text-[10px] font-bold flex items-center justify-center gap-1 cursor-pointer transition-all shadow-sm",
            isActive
              ? "bg-red-500/10 border-red-500/20 text-red-600 hover:bg-red-500/20"
              : "bg-emerald-500/10 border-emerald-500/20 text-emerald-600 hover:bg-emerald-500/20"
          )}
        >
          {isActive ? "⏹ 停止" : "▶ 启动"}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onNavigate();
          }}
          className="h-6.5 px-2.5 rounded-md border border-slate-200 bg-white text-[10px] font-semibold text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition-all cursor-pointer shadow-sm"
        >
          📖 日志
        </button>
      </div>
    </div>
  );
}
