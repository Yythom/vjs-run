export function buildRepoExport(repo = {}) {
  return {
    key: String(repo.key || "").trim(),
    label: String(repo.label || "").trim(),
    path: String(repo.path || repo.defaultPath || "").trim(),
    projects: Array.isArray(repo.projects)
      ? repo.projects
          .map((project) => {
            return {
              key: String(project.key || "").trim(),
              name: String(project.name || "").trim(),
              command: String(project.command || "").trim(),
            };
          })
          .filter((project) => project.key || project.name || project.command)
      : [],
  };
}

// 写剪贴板：优先 navigator.clipboard（Electron 下 file:// 也是安全上下文），
// 失败时退回隐藏 textarea + execCommand 兜底。
async function writeClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // 落到下面的 execCommand 兜底
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

/** 把 repo 配置序列化为 JSON 并复制到剪贴板，返回导出对象。 */
export async function copyRepoConfig(repo) {
  const exportRepo = buildRepoExport(repo);
  await writeClipboard(`${JSON.stringify(exportRepo, null, 2)}\n`);
  return exportRepo;
}
