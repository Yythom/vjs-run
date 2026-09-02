// 智能项目 (Repo) 匹配工具

/**
 * 根据任务标题与正文关键词匹配最贴近的项目工程目录
 * @param {Array} tasks - 要处理的任务数组
 * @param {Array} repos - 项目组列表，形如 [{ key, label, path }, ...]
 * @param {string} fallbackCwd - 兜底默认路径
 * @returns {string} 匹配到的项目绝对路径
 */
export function pickSmartRepo(tasks = [], repos = [], fallbackCwd = "") {
  if (!repos || !repos.length) return fallbackCwd || "";

  const taskList = Array.isArray(tasks) ? tasks : [tasks];

  // 1. 如果单条任务记录了关联 repoPath 且属于当前项目库
  if (taskList.length === 1 && taskList[0]?.repoPath) {
    const matched = repos.find((r) => r.path === taskList[0].repoPath);
    if (matched) return matched.path;
  }

  // 2. 根据任务标题与内容匹配 repo label 或目录名
  const combined = taskList
    .map((t) => `${t?.title || ""} ${t?.content || ""}`)
    .join(" ")
    .toLowerCase();

  for (const r of repos) {
    const label = (r?.label || "").toLowerCase();
    const basename = (r?.path || "").split(/[\\/]/).pop().toLowerCase();
    if (label && combined.includes(label)) return r.path;
    if (basename && basename.length > 2 && combined.includes(basename)) return r.path;
  }

  // 3. 上次使用的目录（若在 repos 中有效）
  if (fallbackCwd && repos.some((r) => r.path === fallbackCwd)) {
    return fallbackCwd;
  }

  // 4. 默认第一个
  return repos[0]?.path || "";
}
