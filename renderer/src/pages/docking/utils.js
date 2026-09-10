// 赛博牛马页面共用的纯函数工具。

export function pickSmartRepo(tasksToRun, repos, lastCwd) {
  if (!repos || !repos.length) return "";
  // 1. 如果单条任务记录了关联 repoPath
  if (tasksToRun.length === 1 && tasksToRun[0]?.repoPath) {
    const matched = repos.find((r) => r.path === tasksToRun[0].repoPath);
    if (matched) return matched.path;
  }
  // 2. 根据任务标题与内容匹配 repo label 或目录名
  const combined = tasksToRun
    .map((t) => `${t.title || ""} ${t.content || ""}`)
    .join(" ")
    .toLowerCase();
  for (const r of repos) {
    const label = (r.label || "").toLowerCase();
    const basename = (r.path || "").split(/[\\/]/).pop().toLowerCase();
    if (label && combined.includes(label)) return r.path;
    if (basename && basename.length > 2 && combined.includes(basename))
      return r.path;
  }
  // 3. 上次使用的目录
  if (lastCwd && repos.some((r) => r.path === lastCwd)) {
    return lastCwd;
  }
  // 4. 默认第一个
  return repos[0]?.path || "";
}

export function formatTime(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

