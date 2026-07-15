// 项目/Repo 查找帮助函数。所有需要根据 id 或 key 拿对应 repo/project 的代码都走这里。

import { buildProjectId } from "./normalize.js";
import { getConfig } from "./store.js";

/** 展平所有项目，每项附带 id / repoKey / repoLabel / repoPath，便于 UI 渲染 */
export function getAllProjects(runtimeConfig = getConfig()) {
  return (runtimeConfig.frontendProjectGroups || []).flatMap((group) =>
    (group.projects || []).map((project) => ({
      ...project,
      id: buildProjectId(group.key, project),
      repoKey: group.key,
      repoLabel: group.label,
      repoPath: group.path,
    })),
  );
}

export function getProjectById(projectId, runtimeConfig = getConfig()) {
  return getAllProjects(runtimeConfig).find(
    (project) => project.id === String(projectId),
  );
}

/**
 * 按 repoKey 拿到 repo 定义；找不到时退回第一个 repo（避免 UI 因为空 repoKey 崩溃）。
 */
export function getRepoDefinition(repoKey, runtimeConfig = getConfig()) {
  const groups = runtimeConfig.frontendProjectGroups || [];
  return groups.find((group) => group.key === repoKey) || groups[0] || null;
}

/** 拿到 repo 的运行时形态，缺失也返回一个安全的兜底对象 */
export function getRepoRuntime(repoKey, runtimeConfig = getConfig()) {
  const repo = getRepoDefinition(repoKey, runtimeConfig);
  if (!repo) {
    return {
      key: String(repoKey || ""),
      label: "当前 Repo",
      path: "",
      projects: [],
    };
  }
  return { ...repo, path: repo?.path || "" };
}

export function getProjectRepo(project, runtimeConfig = getConfig()) {
  return getRepoRuntime(project?.repoKey, runtimeConfig);
}
