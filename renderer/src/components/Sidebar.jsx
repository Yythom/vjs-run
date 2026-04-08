import { useEffect, useMemo, useState } from "react";
import { PROXY_ID } from "../constants";

function ProxySection({
  status,
  proxyStatusLabel,
  proxyBadge,
  proxyEnvActive,
  proxyEnvs,
  proxyEnvId,
  customSuffix,
  onChangeCustomSuffix,
  onSelectEnv,
  onDeploy,
  onStop,
  onSelectLog,
}) {
  const proxyDotClass =
    status === "running"
      ? "purple"
      : status === "starting"
        ? "purple-starting"
        : status || "stopped";

  return (
    <>
      <div className="flex items-center gap-1.5 px-3.5 py-2.5 text-[10px] font-bold tracking-widest uppercase text-slate-500 border-b border-border flex-shrink-0">
        <span className="flex-1">🖥 服务端 API Proxy</span>
        <div className={`status-dot ${proxyDotClass}`} />
      </div>

      <div className="px-2.5 py-2.5 border-b border-border flex-shrink-0 space-y-2">
        <div className="flex items-center gap-2">
          <span className="flex-1 text-xs text-slate-400">
            {proxyStatusLabel}
          </span>
          <span
            className={`proxy-env-badge text-[10px] font-mono px-1.5 py-0.5 rounded border transition-all duration-200 ${
              proxyEnvActive ? "active" : "bg-card border-border text-slate-500"
            }`}
          >
            {proxyBadge}
          </span>
        </div>

        <div className="grid grid-cols-4 gap-1">
          {proxyEnvs.map((env) => (
            <button
              key={env.id}
              className={`env-chip py-1 rounded-md border text-[11px] font-medium cursor-pointer text-center transition-all bg-card border-border text-slate-500 hover:bg-hover hover:text-slate-200 ${
                proxyEnvId === env.id ? "selected" : ""
              }`}
              onClick={() => onSelectEnv(env.id)}
            >
              {env.label}
            </button>
          ))}
        </div>

        <input
          value={customSuffix}
          onChange={(e) => onChangeCustomSuffix(e.target.value)}
          type="text"
          placeholder="自定义后缀（如 staging）"
          autoComplete="off"
          spellCheck={false}
          className="w-full bg-card border border-border rounded-md text-xs font-mono text-slate-200 px-2 py-1.5 outline-none placeholder-slate-600 focus:border-violet-400/50 transition-colors"
        />

        <div className="flex gap-1.5">
          <button
            onClick={onDeploy}
            className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded-md border text-xs font-medium cursor-pointer transition-all bg-violet-400/10 text-violet-400 border-violet-400/35 hover:bg-violet-400/20"
          >
            🚀 部署
          </button>
          <button
            onClick={onStop}
            className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded-md border text-xs font-medium cursor-pointer transition-all bg-red-400/10 text-red-400 border-red-400/30 hover:bg-red-400/20"
          >
            ⏹ 停止
          </button>
          <button
            onClick={onSelectLog}
            title="查看日志"
            className="inline-flex items-center justify-center px-2 py-1 rounded-md border text-xs cursor-pointer transition-all bg-card text-slate-400 border-border hover:bg-hover hover:text-slate-200"
          >
            📋
          </button>
        </div>
      </div>
    </>
  );
}

function ProjectList({
  repoGroups,
  projects,
  statuses,
  selectedId,
  onSelectPanel,
  onStart,
  onStop,
  onConfigureRepo,
  onCleanRepo,
}) {
  const groups = useMemo(() => {
    const groupsFromConfig = (repoGroups || []).map((group) => ({
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

    return [...groupsFromConfig, ...groupsFromProjects];
  }, [projects, repoGroups]);
  const [collapsedMap, setCollapsedMap] = useState({});

  useEffect(() => {
    setCollapsedMap((prev) =>
      groups.reduce((acc, group) => {
        acc[group.repoKey] = prev[group.repoKey] ?? false;
        return acc;
      }, {}),
    );
  }, [groups]);

  useEffect(() => {
    const selectedProject = projects.find((project) => project.id === selectedId);
    if (!selectedProject?.repoKey) return;
    setCollapsedMap((prev) =>
      prev[selectedProject.repoKey]
        ? { ...prev, [selectedProject.repoKey]: false }
        : prev,
    );
  }, [projects, selectedId]);

  return (
    <div className="flex-1 p-1.5" id="project-list">
      {groups.map((group) => {
        const collapsed = collapsedMap[group.repoKey] ?? false;

        return (
          <div key={group.repoKey} className="mb-1">
            <div
              className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left border border-transparent text-slate-400 hover:bg-hover transition-colors"
              onClick={() =>
                setCollapsedMap((prev) => ({
                  ...prev,
                  [group.repoKey]: !collapsed,
                }))
              }
            >
              <div className="flex-1 text-[11px] font-semibold tracking-wide uppercase flex items-center">
                <span>{group.repoLabel}</span>
                <span className="ml-1 text-[10px] text-slate-600">
                  {collapsed ? "▸" : "▾"}
                </span>
              </div>
              <span className="text-[10px] text-slate-600">
                {group.projects.length}
              </span>
              <button
                type="button"
                title={group.repoPath || "配置仓库"}
                className="text-[10px] flex items-center justify-center w-5 h-5 rounded border border-border bg-card  text-slate-500 hover:bg-hover hover:text-slate-200 transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  onConfigureRepo?.(group.repoKey);
                }}
              >
                ⚙
              </button>
              <button
                type="button"
                title={`清理 ${group.repoLabel}`}
                className="text-[10px] flex items-center justify-center w-5 h-5 rounded border border-border bg-card text-slate-500 hover:bg-hover hover:text-slate-200 transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  onCleanRepo?.(group.repoKey);
                }}
              >
                🧹
              </button>
            </div>

            {!collapsed &&
              group.projects.map((project) => {
                const status = statuses[project.id] || "stopped";
                const isActive = status === "running" || status === "starting";
                const isSelected = selectedId === project.id;

                return (
                  <div
                    key={project.id}
                    className={[
                      "project-item ml-2 flex items-center gap-2.5 px-2.5 py-2 rounded-lg cursor-pointer border border-transparent transition-colors mb-0.5 hover:bg-hover",
                      isActive ? "active bg-card border-border" : "",
                      isSelected
                        ? "selected bg-sky-400/[0.08] border-sky-400/30"
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => onSelectPanel(project.id)}
                  >
                    <div className={`status-dot ${status}`} />
                    <div className="project-info flex-1 min-w-0">
                      <div className="project-name text-[12.5px] font-medium text-slate-200 truncate">
                        {project.name}
                      </div>
                      <div className="project-filter text-[10.5px] text-slate-500 font-mono truncate">
                        {project.command || ""}
                      </div>
                    </div>

                    {isActive ? (
                      <button
                        className="project-btn stop-btn w-6 h-6 rounded flex items-center justify-center text-[11px] flex-shrink-0 transition-all bg-red-400/15 text-red-400 hover:bg-red-400/30"
                        title="停止"
                        onClick={(e) => {
                          e.stopPropagation();
                          onStop(project.id);
                        }}
                      >
                        ⏹
                      </button>
                    ) : (
                      <button
                        className="project-btn start-btn w-6 h-6 rounded flex items-center justify-center text-[11px] flex-shrink-0 transition-all bg-green-400/15 text-green-400 hover:bg-green-400/30"
                        title="启动"
                        onClick={(e) => {
                          e.stopPropagation();
                          onStart(project.id);
                        }}
                      >
                        ▶
                      </button>
                    )}
                  </div>
                );
              })}
          </div>
        );
      })}
    </div>
  );
}

export default function Sidebar({ proxyProps, projectProps }) {
  return (
    <aside className="w-[248px] flex-shrink-0 bg-panel border-r border-border flex flex-col overflow-hidden">
      <div className="sidebar-scroll flex-1 overflow-y-auto flex flex-col">
        <ProxySection {...proxyProps} />

        <div className="flex items-center gap-1.5 px-3.5 py-2.5 text-[10px] font-bold tracking-widest uppercase text-slate-500 border-b border-border flex-shrink-0">
          <span className="flex-1">📦 前端项目</span>
          <button
            type="button"
            title="新增 Repo"
            className="inline-flex items-center justify-center w-5 h-5 rounded border border-border bg-card text-[11px] text-slate-500 hover:bg-hover hover:text-slate-200 transition-colors"
            onClick={projectProps.onCreateRepo}
          >
            ＋
          </button>
        </div>

        <ProjectList {...projectProps} />
      </div>

      <div className="flex-shrink-0 border-t border-border px-3 py-2 text-[11px] text-slate-500 text-center">
        点击项目查看日志 · 悬停显示操作
      </div>
    </aside>
  );
}

export { ProjectList, ProxySection, PROXY_ID };
