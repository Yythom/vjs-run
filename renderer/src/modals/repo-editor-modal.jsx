import { useEffect, useState } from "react";
import { useParams, useMatch } from "react-router";
import Modal from "../components/modal";
import { copyRepoConfig } from "../utils/export-config";
import { useAppConfig, updateAppConfig } from "../stores/app-config-store";
import { refreshProjects } from "../stores/runner-store";
import { useCloseModal } from "../hooks/use-modal-nav";
import { showToast } from "../utils/toast";

const VALIDATION_MESSAGES = {
  repo: "Repo 的 key、名称和路径不能为空",
  "repo-key": "Repo key 不能重复",
  projects: "至少需要一个项目",
  "project-key": "项目 key 不能重复",
  "project-fields": "项目的 key、名称和命令不能为空",
};

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
    if (!firstRepo) throw new Error("frontendProjectGroups 不能为空数组");
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
    return { projects: [normalizeImportedProject(raw, 0)] };
  }
  throw new Error("无法识别 JSON 结构");
}

export default function RepoEditorModal() {
  const close = useCloseModal();
  const appConfig = useAppConfig();

  // 通过 URL 区分 create / edit：/repos/new 或 /repos/:key/edit
  const isCreate = Boolean(useMatch("/repos/new"));
  const { key: routeKey } = useParams();

  const repoGroups = appConfig.frontendProjectGroups || [];
  const existingRepo = isCreate
    ? null
    : repoGroups.find((repo) => repo.key === routeKey) || null;

  // edit 模式下找不到 repo（URL 过期）—— 关掉就好
  useEffect(() => {
    if (!isCreate && !existingRepo) close();
  }, [isCreate, existingRepo, close]);

  // 表单初始值从 URL + store 一次性算出，依靠 modal 是 route 组件每次打开都新挂载这一点
  // 来「重置」表单。不需要 effect 同步 prop → state。
  const [repoKey, setRepoKey] = useState(existingRepo?.key || "");
  const [repoLabel, setRepoLabel] = useState(existingRepo?.label || "");
  const [repoPath, setRepoPath] = useState(existingRepo?.path || "");
  const [projects, setProjects] = useState(() =>
    existingRepo?.projects?.length
      ? existingRepo.projects.map((project) => ({
          key: project.key || "",
          name: project.name || "",
          command: project.command || "",
        }))
      : [emptyProject()],
  );
  const [jsonInput, setJsonInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [draggedIndex, setDraggedIndex] = useState(null);
  const [dragOverIndex, setDragOverIndex] = useState(null);

  const handleDragStart = (e, index) => {
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", index);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
  };

  const handleDragEnter = (index) => {
    setDragOverIndex(index);
  };

  const handleDragLeave = () => {
    setDragOverIndex(null);
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  const handleDrop = (e, targetIndex) => {
    e.preventDefault();
    const sourceIndex = draggedIndex !== null ? draggedIndex : parseInt(e.dataTransfer.getData("text/plain"), 10);
    setDraggedIndex(null);
    setDragOverIndex(null);

    if (sourceIndex === null || isNaN(sourceIndex) || sourceIndex === targetIndex) return;

    setProjects((prev) => {
      const next = [...prev];
      const [draggedItem] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, draggedItem);
      return next;
    });
  };

  if (!isCreate && !existingRepo) return null;

  const mode = isCreate ? "create" : "edit";
  const originalKey = existingRepo?.key || null;
  const existingKeys = repoGroups.map((repo) => repo.key);

  const updateProject = (index, field, value) => {
    setProjects((prev) =>
      prev.map((project, i) =>
        i === index ? { ...project, [field]: value } : project,
      ),
    );
  };

  const handleSelectDirectory = async () => {
    try {
      const selectedPath = await window.electronAPI.selectDirectory();
      if (selectedPath) {
        setRepoPath(selectedPath);
        // 如果 Repo 名称或 Repo Key 为空，自动帮用户推断并填入
        const folderName = selectedPath.split(/[/\\]/).pop() || "";
        if (!repoLabel.trim()) {
          setRepoLabel(folderName);
        }
        if (!repoKey.trim()) {
          const safeKey = folderName.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
          setRepoKey(safeKey);
        }
      }
    } catch (err) {
      showToast(`选择目录失败: ${err.message}`, "error");
    }
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
      showToast(VALIDATION_MESSAGES.repo, "warning");
      return;
    }
    if (existingKeys.includes(nextRepoKey) && nextRepoKey !== originalKey) {
      showToast(VALIDATION_MESSAGES["repo-key"], "warning");
      return;
    }
    if (!nextProjects.length) {
      showToast(VALIDATION_MESSAGES.projects, "warning");
      return;
    }
    const seenProjectKeys = new Set();
    for (const project of nextProjects) {
      if (!project.key || !project.name || !project.command) {
        showToast(VALIDATION_MESSAGES["project-fields"], "warning");
        return;
      }
      if (seenProjectKeys.has(project.key)) {
        showToast(VALIDATION_MESSAGES["project-key"], "warning");
        return;
      }
      seenProjectKeys.add(project.key);
    }

    const nextRepo = {
      key: nextRepoKey,
      label: nextRepoLabel,
      path: nextRepoPath,
      projects: nextProjects,
    };
    const nextGroups = isCreate
      ? [...repoGroups, nextRepo]
      : repoGroups.map((repo) => (repo.key === originalKey ? nextRepo : repo));

    setSaving(true);
    try {
      await updateAppConfig({ frontendProjectGroups: nextGroups });
      await refreshProjects();
      showToast("Repo 配置已保存，前端进程已重置", "success");
      close();
    } catch (error) {
      showToast(`保存失败: ${error?.message || String(error)}`, "error");
    } finally {
      setSaving(false);
    }
  };

  const handleImportJson = () => {
    const raw = jsonInput.trim();
    if (!raw) {
      showToast("JSON 内容不能为空", "warning");
      return;
    }
    try {
      const parsed = resolveImportedRepo(JSON.parse(raw));
      if (parsed.key) setRepoKey(parsed.key);
      if (parsed.label) setRepoLabel(parsed.label);
      if (parsed.path) setRepoPath(parsed.path);
      if (parsed.projects?.length) setProjects(parsed.projects);
      setJsonInput("");
      showToast("JSON 解析成功", "success");
    } catch (error) {
      showToast(`JSON 解析失败: ${error?.message || String(error)}`, "error");
    }
  };

  const handleImportFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const trimmed = text.trim();
      if (!trimmed) {
        showToast("剪切板内容为空", "warning");
        return;
      }
      const parsed = resolveImportedRepo(JSON.parse(trimmed));
      if (parsed.key) setRepoKey(parsed.key);
      if (parsed.label) setRepoLabel(parsed.label);
      if (parsed.path) setRepoPath(parsed.path);
      if (parsed.projects?.length) setProjects(parsed.projects);
      setJsonInput("");
      showToast("已成功从剪切板读取并解析配置 ✨", "success");
    } catch (error) {
      showToast(`剪切板解析失败: ${error?.message || "请确认剪切板中是合法的 JSON 格式"}`, "error");
    }
  };

  const handleDelete = async () => {
    if (saving || isCreate || !existingRepo) return;
    if (!window.confirm(`删除 repo「${existingRepo.label}」？`)) return;

    setSaving(true);
    try {
      const nextGroups = repoGroups.filter((repo) => repo.key !== originalKey);
      await updateAppConfig({ frontendProjectGroups: nextGroups });
      await refreshProjects();
      showToast("Repo 已删除，前端进程已重置", "success");
      close();
    } catch (error) {
      showToast(`删除失败: ${error?.message || String(error)}`, "error");
    } finally {
      setSaving(false);
    }
  };

  const handleExport = async () => {
    try {
      const exported = await copyRepoConfig({
        key: repoKey,
        label: repoLabel,
        path: repoPath,
        projects,
      });
      showToast(
        `已复制 ${exported.label || exported.key || "Repo"} 的 JSON 配置到剪贴板`,
        "success",
      );
    } catch (error) {
      showToast(`复制失败: ${error?.message || String(error)}`, "error");
    }
  };

  const title = mode === "create" ? "新增 Repo" : `编辑 ${existingRepo?.label || ""}`;

  return (
    <Modal
      open
      onClose={saving ? undefined : close}
      title={title}
      className="w-[760px] max-w-[94vw] max-h-[90vh]"
    >
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
        <h2 className="text-sm font-semibold text-slate-900">
          {mode === "create" ? "＋ 新增 Repo" : `⚙️ 编辑 ${existingRepo?.label || ""}`}
        </h2>
        <button
          type="button"
          onClick={close}
          disabled={saving}
          className="text-slate-500 hover:text-slate-900 transition-colors text-lg leading-none cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label="关闭 repo 编辑弹窗"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5 flex flex-col gap-5">
        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-600">Repo Key</label>
            <input
              type="text"
              value={repoKey}
              onChange={(e) => setRepoKey(e.target.value)}
              placeholder="main"
              className="w-full bg-card border border-border rounded-md px-3 py-2 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500 transition-colors"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-600">Repo 名称</label>
            <input
              type="text"
              value={repoLabel}
              onChange={(e) => setRepoLabel(e.target.value)}
              placeholder="vjs-monorepo"
              className="w-full bg-card border border-border rounded-md px-3 py-2 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500 transition-colors"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-slate-600">Repo 根目录</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="/Users/yourname/Documents/work/vjs-monorepo"
              className="flex-1 bg-card border border-border rounded-md px-3 py-2 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500 transition-colors"
            />
            <button
              type="button"
              onClick={handleSelectDirectory}
              className="px-3 py-2 rounded-md border text-xs font-medium bg-card text-slate-600 border-border hover:bg-hover hover:text-slate-900 transition-colors flex items-center gap-1 cursor-pointer shrink-0"
            >
              📂 选择文件夹
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5">
            <div className="text-xs font-medium text-slate-600">JSON 导入</div>
            <div className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                onClick={handleImportFromClipboard}
                className="px-2.5 py-1 rounded-md border text-[11px] font-medium bg-blue-500/[0.04] text-blue-600 border-blue-500/20 hover:bg-blue-500/10 transition-colors cursor-pointer"
                title="从剪切板读取并直接导入 JSON 配置"
              >
                📋 从剪贴板导入
              </button>
              <button
                type="button"
                onClick={handleImportJson}
                className="px-2.5 py-1 rounded-md border text-[11px] font-medium bg-card text-slate-600 border-border hover:bg-hover hover:text-slate-900 transition-colors cursor-pointer"
              >
                解析输入框 JSON
              </button>
            </div>
          </div>
          <textarea
            value={jsonInput}
            onChange={(e) => setJsonInput(e.target.value)}
            placeholder={'支持 repo 对象、projects 数组，或 {"frontendProjectGroups":[...]}'}
            spellCheck={false}
            className="min-h-28 w-full bg-card border border-border rounded-md px-3 py-2 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500 transition-colors resize-y"
          />
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <div className="text-xs font-medium text-slate-600">项目列表</div>
            <button
              type="button"
              onClick={() => setProjects((prev) => [...prev, emptyProject()])}
              className="ml-auto px-2.5 py-1 rounded-md border text-[11px] font-medium bg-card text-slate-600 border-border hover:bg-hover hover:text-slate-900 transition-colors"
            >
              ＋ 新增项目
            </button>
          </div>

          <div className="flex flex-col gap-3">
            {projects.map((project, index) => (
              <div
                key={`${mode}-${index}`}
                onDragOver={handleDragOver}
                onDragEnter={() => handleDragEnter(index)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, index)}
                className={`border rounded-lg bg-card/60 p-3 flex gap-3 items-center transition-all ${
                  dragOverIndex === index
                    ? "border-blue-500 bg-blue-500/5 shadow-sm"
                    : draggedIndex === index
                    ? "opacity-40 border-dashed border-slate-300"
                    : "border-border"
                }`}
              >
                {/* Drag Handle */}
                <div
                  draggable
                  onDragStart={(e) => handleDragStart(e, index)}
                  onDragEnd={handleDragEnd}
                  className="cursor-grab active:cursor-grabbing text-slate-400 hover:text-slate-600 transition-colors flex items-center justify-center w-6 self-stretch shrink-0"
                  title="按住拖拽排序"
                >
                  <svg className="w-4 h-4 fill-current" viewBox="0 0 20 20">
                    <path d="M7 6c0-1.1-.9-2-2-2s-2 .9-2 2 .9 2 2 2 2-.9 2-2zm0 4c0-1.1-.9-2-2-2s-2 .9-2 2 .9 2 2 2 2-.9 2-2zm0 4c0-1.1-.9-2-2-2s-2 .9-2 2 .9 2 2 2 2-.9 2-2zm6-8c0-1.1-.9-2-2-2s-2 .9-2 2 .9 2 2 2 2-.9 2-2zm0 4c0-1.1-.9-2-2-2s-2 .9-2 2 .9 2 2 2 2-.9 2-2zm0 4c0-1.1-.9-2-2-2s-2 .9-2 2 .9 2 2 2 2-.9 2-2z" />
                  </svg>
                </div>

                {/* Main Card Form Fields */}
                <div className="flex-1 flex flex-col gap-3">
                  <div className="grid grid-cols-[140px_1fr_auto] gap-3 items-start">
                    <input
                      type="text"
                      value={project.key}
                      onChange={(e) => updateProject(index, "key", e.target.value)}
                      placeholder="project-key"
                      className="w-full bg-panel border border-border rounded-md px-3 py-2 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500 transition-colors"
                    />
                    <input
                      type="text"
                      value={project.name}
                      onChange={(e) => updateProject(index, "name", e.target.value)}
                      placeholder="项目名称"
                      className="w-full bg-panel border border-border rounded-md px-3 py-2 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500 transition-colors"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setProjects((prev) =>
                          prev.length === 1
                            ? [emptyProject()]
                            : prev.filter((_, i) => i !== index),
                        )
                      }
                      className="px-2.5 py-2 rounded-md border text-[11px] font-medium bg-red-400/10 text-red-700 border-red-400/30 hover:bg-red-400/20 transition-colors"
                    >
                      删除
                    </button>
                  </div>

                  <input
                    type="text"
                    value={project.command}
                    onChange={(e) => updateProject(index, "command", e.target.value)}
                    placeholder="pnpm run dev --filter @gc-app/xxx"
                    className="w-full bg-panel border border-border rounded-md px-3 py-2 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500 transition-colors"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex justify-between gap-2 px-5 py-3.5 border-t border-border">
        <div>
          <div className="flex gap-2">
            {mode === "edit" && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={saving}
                className="px-4 py-1.5 rounded-md border text-xs font-medium cursor-pointer transition-all bg-red-400/10 text-red-700 border-red-400/30 hover:bg-red-400/20 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                删除 Repo
              </button>
            )}
            <button
              type="button"
              onClick={handleExport}
              disabled={saving}
              className="px-4 py-1.5 rounded-md border text-xs font-medium cursor-pointer transition-all bg-card text-slate-600 border-border hover:bg-hover hover:text-slate-900 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              复制 JSON
            </button>
          </div>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={close}
            disabled={saving}
            className="px-4 py-1.5 rounded-md border text-xs font-medium cursor-pointer transition-all bg-card text-slate-600 border-border hover:bg-hover hover:text-slate-900 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 rounded-md border text-xs font-medium cursor-pointer transition-all bg-blue-500/20 text-blue-700 border-blue-500/40 hover:bg-blue-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
