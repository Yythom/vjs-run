import { useEffect, useState } from "react";
import { useParams, useMatch } from "react-router";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import Modal from "../components/modal";
import { copyRepoConfig } from "../utils/export-config";
import { useAppConfig, updateAppConfig } from "../stores/app-config-store";
import { refreshProjects } from "../stores/runner-store";
import { useCloseModal } from "../hooks/use-modal-nav";
import { showToast } from "../utils/toast";

function emptyProject() {
  return { key: "", name: "", command: "" };
}

/** 整行都空的项目行在校验/保存时静默丢弃，半填的行才报错 */
function isBlankProject(project) {
  return (
    !String(project.key || "").trim() &&
    !String(project.name || "").trim() &&
    !String(project.command || "").trim()
  );
}

// 校验依赖「已有 repo key 列表」这类动态数据，用工厂函数按当前上下文构建 schema
function buildRepoSchema(existingKeys, originalKey) {
  return z
    .object({
      repoKey: z.string().refine((v) => v.trim(), { message: "Repo Key 不能为空" }),
      repoLabel: z.string().refine((v) => v.trim(), { message: "Repo 名称不能为空" }),
      repoPath: z.string().refine((v) => v.trim(), { message: "Repo 根目录不能为空" }),
      jsonInput: z.string(),
      projects: z.array(
        z.object({
          key: z.string(),
          name: z.string(),
          command: z.string(),
        }),
      ),
    })
    .superRefine((values, ctx) => {
      const nextKey = values.repoKey.trim();
      if (nextKey && existingKeys.includes(nextKey) && nextKey !== originalKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["repoKey"],
          message: "Repo Key 不能重复",
        });
      }

      const filled = values.projects.filter((project) => !isBlankProject(project));
      if (filled.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["projects"],
          message: "至少需要一个项目",
        });
        return;
      }
      const seenKeys = new Set();
      values.projects.forEach((project, index) => {
        if (isBlankProject(project)) return;
        for (const field of ["key", "name", "command"]) {
          if (!String(project[field] || "").trim()) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["projects", index, field],
              message: "项目的 key、名称和命令不能为空",
            });
          }
        }
        const key = String(project.key || "").trim();
        if (!key) return;
        if (seenKeys.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["projects", index, "key"],
            message: "项目 key 不能重复",
          });
        }
        seenKeys.add(key);
      });
    });
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

function FieldError({ message }) {
  if (!message) return null;
  return <div className="text-[11px] text-red-600">{message}</div>;
}

const INPUT_CLS =
  "w-full bg-card border border-border rounded-md px-3 py-2 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500 transition-colors";
const PROJECT_INPUT_CLS =
  "w-full bg-panel border border-border rounded-md px-3 py-2 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500 transition-colors";

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

  const originalKey = existingRepo?.key || null;
  const existingKeys = repoGroups.map((repo) => repo.key);

  // 表单初始值从 URL + store 一次性算出，依靠 modal 是 route 组件每次打开都新挂载这一点
  // 来「重置」表单。register 是非受控模式，打字不会触发弹窗重渲染。
  const {
    register,
    control,
    handleSubmit,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(buildRepoSchema(existingKeys, originalKey)),
    defaultValues: {
      repoKey: existingRepo?.key || "",
      repoLabel: existingRepo?.label || "",
      repoPath: existingRepo?.path || "",
      jsonInput: "",
      projects: existingRepo?.projects?.length
        ? existingRepo.projects.map((project) => ({
            key: project.key || "",
            name: project.name || "",
            command: project.command || "",
          }))
        : [emptyProject()],
    },
  });
  const { fields, append, remove, move, replace } = useFieldArray({
    control,
    name: "projects",
  });

  // 拖拽排序的视觉高亮；顺序变更本身交给 useFieldArray 的 move()
  const [draggedIndex, setDraggedIndex] = useState(null);
  const [dragOverIndex, setDragOverIndex] = useState(null);
  // 删除 Repo 的进行中标志（保存用 isSubmitting，两者都会禁用按钮）
  const [deleting, setDeleting] = useState(false);
  const busy = isSubmitting || deleting;

  const handleDragStart = (e, index) => {
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", index);
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  const handleDrop = (e, targetIndex) => {
    e.preventDefault();
    const sourceIndex =
      draggedIndex !== null
        ? draggedIndex
        : parseInt(e.dataTransfer.getData("text/plain"), 10);
    setDraggedIndex(null);
    setDragOverIndex(null);
    if (sourceIndex === null || isNaN(sourceIndex) || sourceIndex === targetIndex) return;
    move(sourceIndex, targetIndex);
  };

  if (!isCreate && !existingRepo) return null;

  const mode = isCreate ? "create" : "edit";

  const handleSelectDirectory = async () => {
    try {
      const selectedPath = await window.electronAPI.selectDirectory();
      if (selectedPath) {
        setValue("repoPath", selectedPath, { shouldDirty: true });
        // 如果 Repo 名称或 Repo Key 为空，自动帮用户推断并填入
        const folderName = selectedPath.split(/[/\\]/).pop() || "";
        if (!getValues("repoLabel").trim()) {
          setValue("repoLabel", folderName, { shouldDirty: true });
        }
        if (!getValues("repoKey").trim()) {
          const safeKey = folderName.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
          setValue("repoKey", safeKey, { shouldDirty: true });
        }
      }
    } catch (err) {
      showToast(`选择目录失败: ${err.message}`, "error");
    }
  };

  const handleSave = handleSubmit(async (values) => {
    const nextRepo = {
      key: values.repoKey.trim(),
      label: values.repoLabel.trim(),
      path: values.repoPath.trim(),
      projects: values.projects
        .filter((project) => !isBlankProject(project))
        .map((project) => ({
          key: project.key.trim(),
          name: project.name.trim(),
          command: project.command.trim(),
        })),
    };
    const nextGroups = isCreate
      ? [...repoGroups, nextRepo]
      : repoGroups.map((repo) => (repo.key === originalKey ? nextRepo : repo));

    try {
      await updateAppConfig({ frontendProjectGroups: nextGroups });
      await refreshProjects();
      showToast("Repo 配置已保存，前端进程已重置", "success");
      close();
    } catch (error) {
      showToast(`保存失败: ${error?.message || String(error)}`, "error");
    }
  });

  // 只覆盖 JSON 里出现的字段，没提供的保留当前输入
  const applyImportedRepo = (parsed) => {
    if (parsed.key) setValue("repoKey", parsed.key, { shouldDirty: true });
    if (parsed.label) setValue("repoLabel", parsed.label, { shouldDirty: true });
    if (parsed.path) setValue("repoPath", parsed.path, { shouldDirty: true });
    if (parsed.projects?.length) replace(parsed.projects);
    setValue("jsonInput", "");
  };

  const handleImportJson = () => {
    const raw = getValues("jsonInput").trim();
    if (!raw) {
      showToast("JSON 内容不能为空", "warning");
      return;
    }
    try {
      applyImportedRepo(resolveImportedRepo(JSON.parse(raw)));
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
      applyImportedRepo(resolveImportedRepo(JSON.parse(trimmed)));
      showToast("已成功从剪切板读取并解析配置 ✨", "success");
    } catch (error) {
      showToast(`剪切板解析失败: ${error?.message || "请确认剪切板中是合法的 JSON 格式"}`, "error");
    }
  };

  const handleDelete = async () => {
    if (busy || isCreate || !existingRepo) return;
    if (!window.confirm(`删除 repo「${existingRepo.label}」？`)) return;

    setDeleting(true);
    try {
      const nextGroups = repoGroups.filter((repo) => repo.key !== originalKey);
      await updateAppConfig({ frontendProjectGroups: nextGroups });
      await refreshProjects();
      showToast("Repo 已删除，前端进程已重置", "success");
      close();
    } catch (error) {
      showToast(`删除失败: ${error?.message || String(error)}`, "error");
    } finally {
      setDeleting(false);
    }
  };

  const handleExport = async () => {
    try {
      const values = getValues();
      const exported = await copyRepoConfig({
        key: values.repoKey,
        label: values.repoLabel,
        path: values.repoPath,
        projects: values.projects,
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
  const projectsError =
    typeof errors.projects?.message === "string" ? errors.projects.message : "";

  return (
    <Modal
      open
      onClose={busy ? undefined : close}
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
          disabled={busy}
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
            <input type="text" {...register("repoKey")} placeholder="main" className={INPUT_CLS} />
            <FieldError message={errors.repoKey?.message} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-600">Repo 名称</label>
            <input type="text" {...register("repoLabel")} placeholder="vjs-monorepo" className={INPUT_CLS} />
            <FieldError message={errors.repoLabel?.message} />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-slate-600">Repo 根目录</label>
          <div className="flex gap-2">
            <input
              type="text"
              {...register("repoPath")}
              placeholder="/Users/yourname/Documents/work/vjs-monorepo"
              className={`flex-1 ${INPUT_CLS}`}
            />
            <button
              type="button"
              onClick={handleSelectDirectory}
              className="px-3 py-2 rounded-md border text-xs font-medium bg-card text-slate-600 border-border hover:bg-hover hover:text-slate-900 transition-colors flex items-center gap-1 cursor-pointer shrink-0"
            >
              📂 选择文件夹
            </button>
          </div>
          <FieldError message={errors.repoPath?.message} />
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
            {...register("jsonInput")}
            placeholder={'支持 repo 对象、projects 数组，或 {"frontendProjectGroups":[...]}'}
            spellCheck={false}
            className="min-h-28 w-full bg-card border border-border rounded-md px-3 py-2 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500 transition-colors resize-y"
          />
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <div className="text-xs font-medium text-slate-600">项目列表</div>
            <FieldError message={projectsError} />
            <button
              type="button"
              onClick={() => append(emptyProject())}
              className="ml-auto px-2.5 py-1 rounded-md border text-[11px] font-medium bg-card text-slate-600 border-border hover:bg-hover hover:text-slate-900 transition-colors"
            >
              ＋ 新增项目
            </button>
          </div>

          <div className="flex flex-col gap-3">
            {fields.map((field, index) => {
              const rowErrors = errors.projects?.[index];
              const rowError =
                rowErrors?.key?.message ||
                rowErrors?.name?.message ||
                rowErrors?.command?.message;
              return (
                <div
                  key={field.id}
                  onDragOver={(e) => e.preventDefault()}
                  onDragEnter={() => setDragOverIndex(index)}
                  onDragLeave={() => setDragOverIndex(null)}
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
                        {...register(`projects.${index}.key`)}
                        placeholder="project-key"
                        className={PROJECT_INPUT_CLS}
                      />
                      <input
                        type="text"
                        {...register(`projects.${index}.name`)}
                        placeholder="项目名称"
                        className={PROJECT_INPUT_CLS}
                      />
                      <button
                        type="button"
                        onClick={() =>
                          fields.length === 1 ? replace([emptyProject()]) : remove(index)
                        }
                        className="px-2.5 py-2 rounded-md border text-[11px] font-medium bg-red-400/10 text-red-700 border-red-400/30 hover:bg-red-400/20 transition-colors"
                      >
                        删除
                      </button>
                    </div>

                    <input
                      type="text"
                      {...register(`projects.${index}.command`)}
                      placeholder="pnpm run dev --filter @gc-app/xxx"
                      className={PROJECT_INPUT_CLS}
                    />
                    <FieldError message={rowError} />
                  </div>
                </div>
              );
            })}
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
                disabled={busy}
                className="px-4 py-1.5 rounded-md border text-xs font-medium cursor-pointer transition-all bg-red-400/10 text-red-700 border-red-400/30 hover:bg-red-400/20 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                删除 Repo
              </button>
            )}
            <button
              type="button"
              onClick={handleExport}
              disabled={busy}
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
            disabled={busy}
            className="px-4 py-1.5 rounded-md border text-xs font-medium cursor-pointer transition-all bg-card text-slate-600 border-border hover:bg-hover hover:text-slate-900 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={busy}
            className="px-4 py-1.5 rounded-md border text-xs font-medium cursor-pointer transition-all bg-blue-500/20 text-blue-700 border-blue-500/40 hover:bg-blue-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isSubmitting ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
