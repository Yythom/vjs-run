// 配置形状对齐 + 校验。所有外部（磁盘 / IPC partial）传入的 raw
// 都过这一道，下游代码可以信任 config 各字段都是干净的。

import { DEFAULT_CONFIG } from "./defaults.js";
import { normalizeBackendBaseUrl } from "../url-utils.js";

export function buildProjectId(groupKey, project) {
  return `${groupKey}:${project.key || project.name}`;
}



function normalizeProject(project = {}, index = 0) {
  const key =
    String(project.key || project.name || `project-${index + 1}`).trim() ||
    `project-${index + 1}`;
  const name = String(project.name || key).trim() || key;
  return {
    key,
    name,
    command: String(project.command || "").trim(),
  };
}

export function normalizeGroup(group = {}, index = 0) {
  const key =
    String(group.key || `repo-${index + 1}`).trim() || `repo-${index + 1}`;
  return {
    key,
    label: String(group.label || key).trim() || key,
    path: String(group.path || group.defaultPath || "").trim(),
    projects: Array.isArray(group.projects)
      ? group.projects
          .map((project, projectIndex) => normalizeProject(project, projectIndex))
          .filter((project) => project.key || project.name || project.command)
      : [],
  };
}

function validateFrontendProjectGroups(groups = []) {
  const seenGroupKeys = new Set();
  for (const group of groups) {
    if (!group.key) throw new Error("Repo key 不能为空");
    if (!group.label) throw new Error(`Repo ${group.key} 的名称不能为空`);
    if (!group.path) throw new Error(`Repo ${group.label} 的路径不能为空`);
    if (seenGroupKeys.has(group.key)) {
      throw new Error(`Repo key 重复: ${group.key}`);
    }
    seenGroupKeys.add(group.key);

    const seenProjectIds = new Set();
    for (const project of group.projects || []) {
      if (!project.key) {
        throw new Error(`Repo ${group.label} 存在项目 key 为空`);
      }
      if (!project.name) {
        throw new Error(`Repo ${group.label} 存在项目名称为空`);
      }
      if (!project.command) {
        throw new Error(
          `Repo ${group.label} 下项目 ${project.name} 的命令不能为空`,
        );
      }
      const projectId = buildProjectId(group.key, project);
      if (seenProjectIds.has(projectId)) {
        throw new Error(`Repo ${group.label} 下项目 id 重复: ${projectId}`);
      }
      seenProjectIds.add(projectId);
    }
  }
}

function normalizeSidebarWidth(value) {
  const width = Number(value || DEFAULT_CONFIG.sidebarWidth);
  if (!Number.isFinite(width)) return DEFAULT_CONFIG.sidebarWidth;
  return Math.min(480, Math.max(220, width));
}

/**
 * 把任意来源的 raw 配置归一化为下游可信赖的形状。
 * 校验失败抛错；调用方（loadConfig / set-config IPC）负责接住。
 *
 * 注意：mockSpecPath 只在「真正启动 mock」时校验是否存在，这里允许空字符串，
 * 避免首次启动用户还没填路径就把整个 config 加载链炸掉。
 */
export function normalizeConfig(raw = {}) {
  const frontendProjectGroups = Array.isArray(raw.frontendProjectGroups)
    ? raw.frontendProjectGroups.map((group, index) => normalizeGroup(group, index))
    : [];

  validateFrontendProjectGroups(frontendProjectGroups);

  const watchedPorts = Array.isArray(raw.watchedPorts)
    ? [...new Set(raw.watchedPorts.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= 65535))]
    : DEFAULT_CONFIG.watchedPorts;

  return {
    frontendProjectGroups,
    mockSpecPath: String(raw.mockSpecPath || "").trim(),
    mockHost: raw.mockHost || DEFAULT_CONFIG.mockHost,
    mockPort: Number(raw.mockPort || DEFAULT_CONFIG.mockPort),
    mockServiceAddress:
      raw.mockServiceAddress || DEFAULT_CONFIG.mockServiceAddress,
    // 这两个走 DEFAULT_CONFIG 当前值（启动期 ensureUserMockAssets 已经覆盖到 userData 路径）
    mockDataDir: DEFAULT_CONFIG.mockDataDir,
    mockRulesFile: DEFAULT_CONFIG.mockRulesFile,
    mockBackendBaseUrl: normalizeBackendBaseUrl(
      raw.mockBackendBaseUrl === undefined
        ? DEFAULT_CONFIG.mockBackendBaseUrl
        : raw.mockBackendBaseUrl,
    ),
    mockAll:
      raw.mockAll === undefined ? DEFAULT_CONFIG.mockAll : Boolean(raw.mockAll),
    sidebarWidth: normalizeSidebarWidth(raw.sidebarWidth),
    watchedPorts,
  };
}
