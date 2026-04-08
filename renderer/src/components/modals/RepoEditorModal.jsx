import { useEffect, useState } from "react";

function emptyProject() {
  return { key: "", name: "", command: "" };
}

function normalizeImportedProject(project = {}, index = 0) {
  return {
    key: String(project.key || project.name || `project-${index + 1}`).trim(),
    name: String(project.name || project.key || `project-${index + 1}`).trim(),
    command: String(project.command || "").trim(),
  };
}

function resolveImportedRepo(raw) {
  if (Array.isArray(raw)) {
    return {
      projects: raw.map((project, index) => normalizeImportedProject(project, index)),
    };
  }

  if (!raw || typeof raw !== "object") {
    throw new Error("JSON 必须是对象或数组");
  }

  if (Array.isArray(raw.frontendProjectGroups)) {
    const firstRepo = raw.frontendProjectGroups[0];
    if (!firstRepo) {
      throw new Error("frontendProjectGroups 不能为空数组");
    }
    return resolveImportedRepo(firstRepo);
  }

  if (
    raw.key ||
    raw.label ||
    raw.path ||
    raw.defaultPath ||
    Array.isArray(raw.projects)
  ) {
    return {
      key: String(raw.key || "").trim(),
      label: String(raw.label || "").trim(),
      path: String(raw.path || raw.defaultPath || "").trim(),
      projects: Array.isArray(raw.projects)
        ? raw.projects.map((project, index) => normalizeImportedProject(project, index))
        : [],
    };
  }

  if (raw.command || raw.name) {
    return {
      projects: [normalizeImportedProject(raw, 0)],
    };
  }

  throw new Error("无法识别 JSON 结构");
}

export default function RepoEditorModal({
  open,
  repo,
  existingKeys = [],
  onClose,
  onSave,
  onDelete,
  onSaveError,
  onValidateError,
}) {
  const [repoKey, setRepoKey] = useState("");
  const [repoLabel, setRepoLabel] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [projects, setProjects] = useState([emptyProject()]);
  const [jsonInput, setJsonInput] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRepoKey(repo?.key || "");
    setRepoLabel(repo?.label || "");
    setRepoPath(repo?.path || "");
    setProjects(
      repo?.projects?.length
        ? repo.projects.map((project) => ({
            key: project.key || "",
            name: project.name || "",
            command: project.command || "",
          }))
        : [emptyProject()],
    );
    setJsonInput("");
  }, [open, repo]);

  if (!open || !repo) return null;

  const updateProject = (index, field, value) => {
    setProjects((prev) =>
      prev.map((project, projectIndex) =>
        projectIndex === index ? { ...project, [field]: value } : project,
      ),
    );
  };

  const handleSave = async () => {
    if (saving) return;

    const nextRepoKey = repoKey.trim();
    const nextRepoLabel = repoLabel.trim();
    const nextRepoPath = repoPath.trim();
    const nextProjects = projects
      .map((project) => ({
        key: String(project.key || "").trim(),
        name: String(project.name || "").trim(),
        command: String(project.command || "").trim(),
      }))
      .filter((project) => project.key || project.name || project.command);

    if (!nextRepoKey || !nextRepoLabel || !nextRepoPath) {
      onValidateError?.("repo");
      return;
    }

    const duplicateRepoKey =
      existingKeys.includes(nextRepoKey) && nextRepoKey !== repo.originalKey;
    if (duplicateRepoKey) {
      onValidateError?.("repo-key");
      return;
    }

    if (!nextProjects.length) {
      onValidateError?.("projects");
      return;
    }

    const seenProjectKeys = new Set();
    for (const project of nextProjects) {
      if (!project.key || !project.name || !project.command) {
        onValidateError?.("project-fields");
        return;
      }
      if (seenProjectKeys.has(project.key)) {
        onValidateError?.("project-key");
        return;
      }
      seenProjectKeys.add(project.key);
    }

    setSaving(true);
    try {
      await onSave?.({
        originalKey: repo.originalKey,
        key: nextRepoKey,
        label: nextRepoLabel,
        path: nextRepoPath,
        projects: nextProjects,
      });
    } catch (error) {
      onSaveError?.(error?.message || String(error));
    } finally {
      setSaving(false);
    }
  };

  const handleImportJson = () => {
    const raw = jsonInput.trim();
    if (!raw) {
      onSaveError?.("JSON 内容不能为空");
      return;
    }

    try {
      const parsed = resolveImportedRepo(JSON.parse(raw));

      if (parsed.key) setRepoKey(parsed.key);
      if (parsed.label) setRepoLabel(parsed.label);
      if (parsed.path) setRepoPath(parsed.path);
      if (parsed.projects?.length) {
        setProjects(parsed.projects);
      }
      setJsonInput("");
    } catch (error) {
      onSaveError?.(`JSON 解析失败: ${error?.message || String(error)}`);
    }
  };

  const handleDelete = async () => {
    if (saving || repo.mode !== "edit") return;
    if (!window.confirm(`删除 repo「${repo.label}」？`)) return;

    setSaving(true);
    try {
      await onDelete?.(repo);
    } catch (error) {
      onSaveError?.(error?.message || String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0, 0, 0, 0.55)", backdropFilter: "blur(2px)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div
        className="bg-panel border border-border rounded-xl shadow-2xl w-[760px] flex flex-col overflow-hidden"
        style={{ maxWidth: "94vw", maxHeight: "90vh" }}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
          <h2 className="text-sm font-semibold text-slate-200">
            {repo.mode === "create" ? "＋ 新增 Repo" : `⚙️ 编辑 ${repo.label}`}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="text-slate-500 hover:text-slate-200 transition-colors text-lg leading-none cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label="关闭 repo 编辑弹窗"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-slate-400">
                Repo Key
              </label>
              <input
                type="text"
                value={repoKey}
                onChange={(e) => setRepoKey(e.target.value)}
                placeholder="main"
                className="w-full bg-card border border-border rounded-md px-3 py-2 text-xs font-mono text-slate-200 placeholder-slate-600 outline-none focus:border-slate-500 transition-colors"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-slate-400">
                Repo 名称
              </label>
              <input
                type="text"
                value={repoLabel}
                onChange={(e) => setRepoLabel(e.target.value)}
                placeholder="vjs-monorepo"
                className="w-full bg-card border border-border rounded-md px-3 py-2 text-xs text-slate-200 placeholder-slate-600 outline-none focus:border-slate-500 transition-colors"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-400">
              Repo 根目录
            </label>
            <input
              type="text"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="/Users/yourname/Documents/work/vjs-monorepo"
              className="w-full bg-card border border-border rounded-md px-3 py-2 text-xs font-mono text-slate-200 placeholder-slate-600 outline-none focus:border-slate-500 transition-colors"
            />
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center">
              <div className="text-xs font-medium text-slate-400">JSON 导入</div>
              <button
                type="button"
                onClick={handleImportJson}
                className="ml-auto px-2.5 py-1 rounded-md border text-[11px] font-medium bg-card text-slate-400 border-border hover:bg-hover hover:text-slate-200 transition-colors"
              >
                解析 JSON
              </button>
            </div>
            <textarea
              value={jsonInput}
              onChange={(e) => setJsonInput(e.target.value)}
              placeholder={'支持 repo 对象、projects 数组，或 {"frontendProjectGroups":[...]}'}
              spellCheck={false}
              className="min-h-28 w-full bg-card border border-border rounded-md px-3 py-2 text-xs font-mono text-slate-200 placeholder-slate-600 outline-none focus:border-slate-500 transition-colors resize-y"
            />
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex items-center">
              <div className="text-xs font-medium text-slate-400">项目列表</div>
              <button
                type="button"
                onClick={() => setProjects((prev) => [...prev, emptyProject()])}
                className="ml-auto px-2.5 py-1 rounded-md border text-[11px] font-medium bg-card text-slate-400 border-border hover:bg-hover hover:text-slate-200 transition-colors"
              >
                ＋ 新增项目
              </button>
            </div>

            <div className="flex flex-col gap-3">
              {projects.map((project, index) => (
                <div
                  key={`${repo.mode}-${index}`}
                  className="border border-border rounded-lg bg-card/60 p-3 flex flex-col gap-3"
                >
                  <div className="grid grid-cols-[140px_1fr_auto] gap-3 items-start">
                    <input
                      type="text"
                      value={project.key}
                      onChange={(e) => updateProject(index, "key", e.target.value)}
                      placeholder="project-key"
                      className="w-full bg-panel border border-border rounded-md px-3 py-2 text-xs font-mono text-slate-200 placeholder-slate-600 outline-none focus:border-slate-500 transition-colors"
                    />
                    <input
                      type="text"
                      value={project.name}
                      onChange={(e) => updateProject(index, "name", e.target.value)}
                      placeholder="项目名称"
                      className="w-full bg-panel border border-border rounded-md px-3 py-2 text-xs text-slate-200 placeholder-slate-600 outline-none focus:border-slate-500 transition-colors"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setProjects((prev) =>
                          prev.length === 1
                            ? [emptyProject()]
                            : prev.filter((_, projectIndex) => projectIndex !== index),
                        )
                      }
                      className="px-2.5 py-2 rounded-md border text-[11px] font-medium bg-red-400/10 text-red-400 border-red-400/30 hover:bg-red-400/20 transition-colors"
                    >
                      删除
                    </button>
                  </div>

                  <input
                    type="text"
                    value={project.command}
                    onChange={(e) => updateProject(index, "command", e.target.value)}
                    placeholder="pnpm run dev --filter @gc-app/xxx"
                    className="w-full bg-panel border border-border rounded-md px-3 py-2 text-xs font-mono text-slate-200 placeholder-slate-600 outline-none focus:border-slate-500 transition-colors"
                  />
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex justify-between gap-2 px-5 py-3.5 border-t border-border">
          <div>
            {repo.mode === "edit" && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={saving}
                className="px-4 py-1.5 rounded-md border text-xs font-medium cursor-pointer transition-all bg-red-400/10 text-red-400 border-red-400/30 hover:bg-red-400/20 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                删除 Repo
              </button>
            )}
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-4 py-1.5 rounded-md border text-xs font-medium cursor-pointer transition-all bg-card text-slate-400 border-border hover:bg-hover hover:text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-1.5 rounded-md border text-xs font-medium cursor-pointer transition-all bg-blue-500/20 text-blue-400 border-blue-500/40 hover:bg-blue-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? "保存中..." : "保存"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
