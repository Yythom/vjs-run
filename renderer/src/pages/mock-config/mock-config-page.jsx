import { useCallback, useRef, useState } from "react";
import { useLocation } from "react-router";
import useMockData from "./use-mock-data";
import MockRuleList from "./mock-rule-list";
import MockRuleEditor from "./mock-rule-editor";
import { formatRelativeTime, ruleKey } from "./utils";
import { useAppConfig } from "../../stores/app-config-store";
import { showToast } from "../../utils/toast";
import { confirm } from "../../components/confirm-host";
import Modal from "../../components/modal";
import { isEnterKey } from "../../utils/keyboard";

const CUSTOM_NEW_KEY = "__custom_new__";
// 从请求历史「生成 mock 规则」跳转过来时的草稿选中项
const DRAFT_KEY = "__draft_from_history__";

// 场景名落到文件名时的比对键：与后端 sanitizeSceneName 一样去掉非法字符；
// macOS 文件系统不区分大小写，「Claude」和「claude」写的是同一个文件
function sceneFileKey(sceneName) {
  return sceneName.replace(/[/\\:*?"<>|]/g, "").trim().toLowerCase();
}

/**
 * 行内改名输入框：回车 / 失焦提交，Esc 取消。
 * doneRef 防止回车提交后、输入框卸载时触发的 blur 再提交一次；提交失败（如重名）复位，可改了再提交。
 */
function SceneRenameInput({ initialName, onSubmit, onCancel }) {
  const [value, setValue] = useState(initialName);
  const doneRef = useRef(false);

  const submit = async () => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (!(await onSubmit(value))) doneRef.current = false;
  };

  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => {
        if (isEnterKey(e)) submit();
        if (e.key === "Escape") {
          doneRef.current = true;
          onCancel();
        }
      }}
      onBlur={submit}
      placeholder="新场景名…"
      className="block w-full h-5 -my-0.5 bg-white border border-sky-400 rounded px-1.5 text-xs font-medium text-slate-900 placeholder-slate-400 outline-none ring-1 ring-sky-400/20"
    />
  );
}

/**
 * 场景菜单：列出 scenes/ 下的规则快照，支持应用（覆盖当前规则）、编辑
 * （页面切到场景编辑模式，直接改场景文件）、删除、把当前规则另存为场景。
 * 录制到的场景也在这里应用。
 */
function ScenesMenu({ onApplied, editingScene, onEdit, onExitEdit }) {
  const [open, setOpen] = useState(false);
  const [scenes, setScenes] = useState([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(null); // 正在改名的场景名
  const [appliedScene, setAppliedScene] = useState(""); // 当前应用的场景名
  const [query, setQuery] = useState("");

  const refresh = async () => {
    try {
      const result = await window.electronAPI.listMockScenes();
      if (result?.success) {
        setScenes(result.scenes || []);
        setAppliedScene(result.appliedScene || "");
      }
    } catch {
      // 列表拉不到时面板照常打开（空态），不阻塞交互
    }
  };

  const toggle = () => {
    if (!open) {
      setQuery("");
      setRenaming(null);
      refresh();
    }
    setOpen(!open);
  };

  // 清空后焦点回到搜索框：点 × 时焦点落在按钮上，按钮随即卸载会把焦点丢给弹框
  const searchRef = useRef(null);
  const clearQuery = () => {
    setQuery("");
    searchRef.current?.focus();
  };

  // 搜索过滤后，使用中的场景置顶（sort 稳定，其余仍按更新时间倒序）
  const keyword = query.trim().toLowerCase();
  const visibleScenes = scenes
    .filter((scene) => !keyword || scene.name.toLowerCase().includes(keyword))
    .sort((a, b) => (b.name === appliedScene) - (a.name === appliedScene));

  const applyScene = async (sceneName) => {
    const ok = await confirm({
      title: "应用场景",
      message: `应用场景「${sceneName}」会覆盖当前全部规则（可先把当前规则存为场景）。继续？`,
      confirmText: "应用",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    const result = await window.electronAPI.applyMockScene(sceneName);
    setBusy(false);
    if (!result?.success) {
      showToast(`应用失败: ${result?.error || "未知错误"}`, "error");
      return;
    }
    setOpen(false);
    showToast(`已应用场景「${sceneName}」`, "success");
    onApplied();
  };

  // 覆盖：把当前活动规则写进已有场景（同名直接覆盖，等价于「另存为」到已存在的名字）。
  // 返回是否真的覆盖了，供「存为场景」撞名时复用
  const overwriteScene = async (sceneName) => {
    const ok = await confirm({
      title: "覆盖场景",
      message: `会用当前全部规则覆盖场景「${sceneName}」的内容，原内容不可恢复。继续？`,
      confirmText: "覆盖",
      danger: true,
    });
    if (!ok) return false;
    setBusy(true);
    const result = await window.electronAPI.saveMockScene(sceneName);
    setBusy(false);
    if (!result?.success) {
      showToast(`覆盖失败: ${result?.error || "未知错误"}`, "error");
      return false;
    }
    showToast(
      `已用当前规则覆盖场景「${result.name}」（${result.count} 条规则）`,
      "success",
    );
    refresh();
    return true;
  };

  const saveScene = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    // 后端同名直接覆盖文件，撞名时改走「覆盖」那套确认
    const existing = scenes.find(
      (scene) => sceneFileKey(scene.name) === sceneFileKey(trimmed),
    );
    if (existing) {
      if (existing.name === editingScene) {
        showToast(`场景「${existing.name}」正在编辑中，请先结束编辑`, "error");
        return;
      }
      if (await overwriteScene(existing.name)) setName("");
      return;
    }
    const result = await window.electronAPI.saveMockScene(trimmed);
    if (!result?.success) {
      showToast(`保存失败: ${result?.error || "未知错误"}`, "error");
      return;
    }
    setName("");
    showToast(
      `已保存场景「${result.name}」（${result.count} 条规则）`,
      "success",
    );
    refresh();
  };

  const removeScene = async (sceneName) => {
    const ok = await confirm({
      title: "删除场景",
      message: `确认删除场景「${sceneName}」？`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    const result = await window.electronAPI.deleteMockScene(sceneName);
    if (!result?.success) {
      showToast(`删除失败: ${result?.error || "未知错误"}`, "error");
      return;
    }
    if (sceneName === editingScene) onExitEdit();
    refresh();
  };

  const editScene = (sceneName) => {
    setOpen(false);
    onEdit(sceneName);
  };

  const exportScene = async (sceneName) => {
    setBusy(true);
    const result = await window.electronAPI.exportMockScene(sceneName);
    setBusy(false);
    if (!result?.success) {
      showToast(`导出失败: ${result?.error || "未知错误"}`, "error");
      return;
    }
    if (result.canceled) return;
    showToast(`已导出场景「${sceneName}」到 ${result.file}`, "success");
  };

  const importScene = async () => {
    setBusy(true);
    const result = await window.electronAPI.importMockScene();
    setBusy(false);
    if (!result?.success) {
      showToast(`导入失败: ${result?.error || "未知错误"}`, "error");
      return;
    }
    if (result.canceled) return;
    showToast(
      `已导入场景「${result.name}」（${result.count} 条规则）`,
      "success",
    );
    refresh();
  };

  const startRename = (sceneName) => {
    if (sceneName === editingScene) {
      showToast(`场景「${sceneName}」正在编辑中，请先结束编辑再改名`, "error");
      return;
    }
    setRenaming(sceneName);
  };

  // 返回是否结束改名：失败时输入框保留，改了再提交
  const submitRename = async (from, value) => {
    const to = value.trim();
    if (!to || to === from) {
      setRenaming(null);
      return true;
    }
    const result = await window.electronAPI.renameMockScene(from, to);
    if (!result?.success) {
      showToast(`重命名失败: ${result?.error || "未知错误"}`, "error");
      return false;
    }
    setRenaming(null);
    showToast(`已重命名为「${result.name}」`, "success");
    refresh();
    return true;
  };

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        title="规则场景：保存 / 应用 / 编辑整套规则快照"
        className="px-3 py-1 rounded-md border text-xs font-medium whitespace-nowrap bg-violet-400/10 text-violet-700 border-violet-400/35 hover:bg-violet-400/20"
      >
        场景
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="规则场景"
        srOnly={false}
        className="w-[680px] max-w-[calc(100vw-2rem)]"
        // 改名时 Esc 只取消改名，不关整个弹框
        onEscapeKeyDown={(e) => renaming && e.preventDefault()}
        headerAction={
          <button
            type="button"
            onClick={async () => {
              try {
                await window.electronAPI.openMockRulesFolder({ openScenesDir: true });
              } catch (err) {
                showToast(`打开文件夹失败: ${err?.message || "未知错误"}`, "error");
              }
            }}
            title="打开场景配置文件夹目录"
            className="text-slate-500 hover:text-slate-800 transition-colors text-xs leading-none cursor-pointer p-1.5 rounded-md hover:bg-slate-200/60 flex items-center gap-1.5 font-medium mr-1"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="w-3.5 h-3.5 text-slate-500"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-19.5 0A2.25 2.25 0 0 0 2.25 15v3.75A2.25 2.25 0 0 0 4.5 21h15a2.25 2.25 0 0 0 2.25-2.25V15a2.25 2.25 0 0 0-2.25-2.25m-19.5 0h19.5M2.25 9.75V7.125A2.25 2.25 0 0 1 4.5 5h3.75a3 3 0 0 1 2.25 1L12 8.25h6.75A2.25 2.25 0 0 1 21 10.5V12"
              />
            </svg>
            打开目录
          </button>
        }
      >
        <div className="px-5 pt-3.5 pb-2 shrink-0 flex items-center gap-2">
          <div className="relative flex-1">
            <div className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none text-slate-400">
              <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
            <input
              ref={searchRef}
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索场景…"
              className="w-full bg-slate-50/70 hover:bg-slate-50 focus:bg-white border border-border rounded-lg pl-8 pr-7 py-1.5 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500/20 transition-all"
            />
            {query && (
              <button
                type="button"
                onClick={clearQuery}
                className="absolute inset-y-0 right-0 pr-2.5 flex items-center text-slate-400 hover:text-slate-600 transition-colors"
                title="清空搜索"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                </svg>
              </button>
            )}
          </div>
          <div className="text-[11px] text-slate-400 font-medium px-1 shrink-0">
            {query.trim()
              ? `${visibleScenes.length} / ${scenes.length}`
              : `共 ${scenes.length} 个`}
          </div>
        </div>

        <div className="max-h-[55vh] min-h-[140px] overflow-y-auto px-5 py-2.5 flex flex-col gap-2">
          {scenes.length === 0 && (
            <div className="py-10 flex flex-col items-center justify-center text-center">
              <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center text-slate-400 mb-2">
                <svg
                  className="w-5 h-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
                  />
                </svg>
              </div>
              <p className="text-xs font-medium text-slate-600 mb-1">还没有规则场景</p>
              <p className="text-[11px] text-slate-400 max-w-[280px]">
                可以把当前规则保存为场景快照，或在请求历史中批量存入。
              </p>
            </div>
          )}
          {scenes.length > 0 && visibleScenes.length === 0 && (
            <div className="py-10 flex flex-col items-center justify-center text-center">
              <p className="text-xs text-slate-500">
                没有找到包含「<span className="text-slate-800 font-medium">{query.trim()}</span>」的场景
              </p>
              <button
                type="button"
                onClick={clearQuery}
                className="mt-2 text-xs text-sky-600 hover:text-sky-700 hover:underline cursor-pointer"
              >
                清空搜索条件
              </button>
            </div>
          )}
          {visibleScenes.map((scene) => {
            const isApplied = scene.name === appliedScene;
            const isEditing = scene.name === editingScene;
            const isRenaming = renaming === scene.name;

            return (
              <div
                key={scene.name}
                // overflow-hidden 让色条跟着圆角裁切；它会让列表里的行被压扁，所以要 shrink-0
                className={`group relative overflow-hidden shrink-0 flex items-center gap-2.5 px-3 py-2 rounded-lg border transition-all ${
                  isApplied
                    ? "bg-sky-50/40 border-sky-200 shadow-xs"
                    : isEditing
                      ? "bg-violet-50/40 border-violet-200 shadow-xs"
                      : "bg-white border-border/70 hover:border-slate-300 hover:bg-slate-50/40 hover:shadow-xs"
                }`}
              >
                {/* 左侧色条绝对定位，不占宽度，各行图标保持对齐 */}
                {(isApplied || isEditing) && (
                  <span
                    aria-hidden
                    className={`absolute inset-y-0 left-0 w-[3px] ${isApplied ? "bg-sky-500" : "bg-violet-500"}`}
                  />
                )}

                {/* 场景左侧图标：改名时也保留，行高和位置不跳 */}
                <div
                  className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${
                    isApplied
                      ? "bg-sky-100 text-sky-600"
                      : isEditing
                        ? "bg-violet-100 text-violet-600"
                        : "bg-slate-100 text-slate-400 group-hover:text-slate-600"
                  } transition-colors`}
                >
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={1.5}
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
                    />
                  </svg>
                </div>

                <div className="flex-1 min-w-0">
                  {isRenaming ? (
                    <SceneRenameInput
                      initialName={scene.name}
                      onSubmit={(value) => submitRename(scene.name, value)}
                      onCancel={() => setRenaming(null)}
                    />
                  ) : (
                    <div className="text-xs font-medium text-slate-900 flex items-center gap-1.5">
                      <span
                        className="truncate select-none"
                        title={isEditing ? scene.name : `${scene.name}\n双击或点击铅笔重命名`}
                        onDoubleClick={() => startRename(scene.name)}
                      >
                        {scene.name}
                      </span>

                      {isApplied && (
                        <span
                          title="当前生效的规则是从这个场景应用的（应用后改过的规则不会同步回场景）"
                          className="px-1.5 py-0.5 rounded text-[9.5px] leading-none font-semibold bg-sky-100 text-sky-700 shrink-0"
                        >
                          使用中
                        </span>
                      )}
                      {isEditing && (
                        <span className="px-1.5 py-0.5 rounded text-[9.5px] leading-none font-semibold bg-violet-100 text-violet-700 shrink-0">
                          编辑中
                        </span>
                      )}

                      {/* 重命名铅笔：放在标签之后，隐藏时占的位置落在行尾，不会把标签和名字隔开；
                          编辑中的场景不能改名，不显示 */}
                      {!isEditing && (
                        <button
                          type="button"
                          onClick={() => startRename(scene.name)}
                          title="重命名场景"
                          className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 p-0.5 text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 rounded transition-all shrink-0"
                        >
                          <svg
                            className="w-3 h-3"
                            fill="none"
                            viewBox="0 0 24 24"
                            strokeWidth={1.5}
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Zm0 0L19.5 7.125"
                            />
                          </svg>
                        </button>
                      )}
                    </div>
                  )}

                  <div className="text-[11px] text-slate-400 mt-0.5 flex items-center gap-1.5">
                    <span className="inline-flex items-center px-1.5 py-0.5 leading-none bg-slate-100 text-slate-600 rounded text-[10px] font-medium">
                      {scene.ruleCount} 条规则
                    </span>
                    {scene.updatedAt && (
                      <span
                        title={`更新于 ${new Date(scene.updatedAt).toLocaleString("zh-CN", { hour12: false })}`}
                      >
                        {formatRelativeTime(scene.updatedAt)}
                      </span>
                    )}
                  </div>
                </div>

                {isRenaming ? (
                  <span className="shrink-0 text-[10.5px] text-slate-400">
                    回车确定 · Esc 取消
                  </span>
                ) : (
                  <>
                    {/* 辅助操作图标组（覆盖 / 导出 / 删除）：悬停时渐显 */}
                    <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity mr-1">
                      <button
                        type="button"
                        disabled={busy || isEditing}
                        onClick={() => overwriteScene(scene.name)}
                        title={
                          isEditing
                            ? "该场景正在编辑中，请先结束编辑"
                            : "用当前规则覆盖这个场景"
                        }
                        className="p-1.5 rounded-md text-slate-400 hover:text-amber-600 hover:bg-amber-50 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-slate-400 disabled:hover:bg-transparent"
                      >
                        {/* 「存入」图标：把当前规则写进这个场景 */}
                        <svg
                          className="w-3.5 h-3.5"
                          fill="none"
                          viewBox="0 0 24 24"
                          strokeWidth={1.5}
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M9 8.25H7.5a2.25 2.25 0 0 0-2.25 2.25v9a2.25 2.25 0 0 0 2.25 2.25h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25H15M9 12l3 3m0 0 3-3m-3 3V2.25"
                          />
                        </svg>
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => exportScene(scene.name)}
                        title="导出为 JSON 文件"
                        className="p-1.5 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <svg
                          className="w-3.5 h-3.5"
                          fill="none"
                          viewBox="0 0 24 24"
                          strokeWidth={1.5}
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"
                          />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={() => removeScene(scene.name)}
                        title="删除场景"
                        className="p-1.5 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors cursor-pointer"
                      >
                        <svg
                          className="w-3.5 h-3.5"
                          fill="none"
                          viewBox="0 0 24 24"
                          strokeWidth={1.5}
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"
                          />
                        </svg>
                      </button>
                    </div>

                    {/* 主操作：应用与编辑 */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      {isApplied ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => applyScene(scene.name)}
                          title="当前已生效；点击可重新应用快照规则"
                          className="px-2.5 py-1 rounded-md border text-xs font-medium bg-sky-50 text-sky-700 border-sky-200 hover:bg-sky-100 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          重新应用
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => applyScene(scene.name)}
                          className="px-2.5 py-1 rounded-md text-xs font-medium bg-sky-600 text-white hover:bg-sky-700 transition-colors shadow-xs cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          应用
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={isEditing}
                        onClick={() => editScene(scene.name)}
                        title={isEditing ? "这个场景正在编辑中" : undefined}
                        className="px-2.5 py-1 rounded-md border text-xs font-medium bg-white text-slate-700 border-slate-200 hover:bg-slate-50 hover:border-slate-300 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        编辑
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>

        <div className="px-5 py-3 border-t border-border bg-slate-50/70 flex items-center justify-between gap-3 shrink-0">
          <button
            type="button"
            onClick={importScene}
            disabled={busy}
            title="从 JSON 文件导入为新场景（同名自动去重）"
            className="px-2.5 py-1.5 rounded-md border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 transition-colors text-xs font-medium flex items-center gap-1.5 shrink-0 shadow-xs cursor-pointer"
          >
            <svg
              className="w-3.5 h-3.5 text-slate-500"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3"
              />
            </svg>
            从文件导入
          </button>

          <div className="flex items-center gap-1.5 flex-1 max-w-[340px] ml-auto">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => isEnterKey(e) && saveScene()}
              placeholder="把当前规则存为新场景…"
              className="flex-1 min-w-0 bg-white border border-slate-200 rounded-md px-2.5 py-1.5 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500/20 transition-all"
            />
            <button
              type="button"
              onClick={saveScene}
              disabled={!name.trim()}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-slate-900 text-white hover:bg-slate-800 transition-colors disabled:opacity-30 disabled:pointer-events-none shrink-0 shadow-xs cursor-pointer"
            >
              存为场景
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}

export default function MockConfigPage() {
  const config = useAppConfig();
  // 请求历史页通过 location.state.draft 传入预填的规则草稿（method/path/status/response）
  const draft = useLocation().state?.draft || null;
  const [selectedKey, setSelectedKey] = useState(draft ? DRAFT_KEY : "");
  // 非空时进入场景编辑模式：列表 / 编辑器读写 scenes/<名字>.json 而非活动规则
  const [editingScene, setEditingScene] = useState(null);

  const { routes, rules, rulesFile, loading, load, saveRules } = useMockData({
    config,
    onToast: showToast,
    editingScene,
  });


  // Editor 上报的「有未保存改动」。切换选中项前用它拦截，避免静默丢失。
  // 只在事件处理器里读取、不参与渲染，用 ref 存：编辑器进入/退出 dirty
  // 状态时不重渲染整页（state 版还会让 guardSwitch 闭包变化，击穿列表 memo）。
  const editorDirtyRef = useRef(false);
  const handleDirtyChange = useCallback((dirty) => {
    editorDirtyRef.current = dirty;
  }, []);

  // 切换选中项 / 进出场景编辑前的统一守卫：编辑器有未保存改动时先确认。
  const guardSwitch = async (proceed) => {
    if (editorDirtyRef.current) {
      const ok = await confirm({
        title: "放弃未保存的改动？",
        message: "当前编辑器有未保存的修改，关闭后会丢失。",
        confirmText: "放弃",
        danger: true,
      });
      if (!ok) return;
      editorDirtyRef.current = false;
    }
    proceed();
  };

  const enterSceneEdit = (sceneName) =>
    guardSwitch(() => {
      setSelectedKey("");
      setEditingScene(sceneName);
    });

  const exitSceneEdit = () => {
    setSelectedKey("");
    setEditingScene(null);
  };

  // 场景编辑本身逐条即时落盘，退出前只需守卫编辑器里未保存的改动。改完常见的下一步
  // 是「就用这套规则」，所以退出时顺带给一个应用场景的入口，省得再去场景菜单点一次。
  const finishSceneEdit = () =>
    guardSwitch(async () => {
      const sceneName = editingScene;
      const choice = await confirm({
        title: "结束场景编辑",
        message: `场景「${sceneName}」的改动已经保存。要顺便把它应用为当前生效的规则吗？`,
        confirmText: "应用并结束",
        altText: "只结束编辑",
      });
      if (!choice) return;
      if (choice === "alt") {
        exitSceneEdit();
        return;
      }
      const result = await window.electronAPI.applyMockScene(sceneName);
      if (!result?.success) {
        showToast(`应用失败: ${result?.error || "未知错误"}`, "error");
        return;
      }
      // exitSceneEdit 会把 editingScene 清空，useMockData 依赖它自动重拉活动规则
      exitSceneEdit();
      showToast(`已应用场景「${sceneName}」`, "success");
    });

  // 按 method + path 字面精确查找（列表项与规则一一对应）。同一 method+path 有多条
  // 规则时，server 的 findMockRule 具体度相同、按 mock-rules.json 数组顺序取第一条，
  // 这里也取第一条——否则编辑器里打开的会是没生效的那条。
  // 按 path 分组只是为了保持 O(1) 查找，组内顺序仍是文件顺序。
  const rulesByPath = new Map();
  for (const rule of rules) {
    const list = rulesByPath.get(rule.path);
    if (list) list.push(rule);
    else rulesByPath.set(rule.path, [rule]);
  }
  const lookupRule = (method, path) => {
    const wanted = method.toUpperCase();
    return (rulesByPath.get(path) || []).find((rule) => {
      return (rule.method || "").toUpperCase() === wanted;
    });
  };

  // 合并 routes 与「未对应任何 route 的自定义 rule」为统一列表
  const matchedRuleKeys = new Set();
  const routeItems = routes.map((route) => {
    const rule = lookupRule(route.method, route.path);
    if (rule) matchedRuleKeys.add(ruleKey(rule));
    return {
      key: ruleKey(route),
      method: route.method,
      path: route.path,
      summary: route.summary,
      source: route.source,
      route,
      rule,
    };
  });
  const customItems = rules
    .filter((rule) => !matchedRuleKeys.has(ruleKey(rule)))
    .map((rule) => ({
      key: ruleKey(rule),
      method: rule.method || "",
      path: rule.path,
      summary: "自定义 mock 规则",
      source: "mock-rules",
      route: null,
      rule,
    }));
  const allItems = [...customItems, ...routeItems];

  let selectedItem = allItems.find((item) => item.key === selectedKey) || null;
  if (selectedKey === DRAFT_KEY && draft) {
    // 草稿命中已有规则（同 method+path）时把已有变体带上，避免一次保存把变体清空
    const existingForDraft = lookupRule(draft.method || "GET", draft.path);
    selectedItem = {
      key: DRAFT_KEY,
      rule: {
        enabled: true,
        ...(existingForDraft?.variants ? { variants: existingForDraft.variants } : {}),
        ...draft,
      },
      route: null,
    };
  }
  const editingKey = selectedItem?.rule ? ruleKey(selectedItem.rule) : null;
  // 草稿的 rule 是凭空构造的，只有 rules 里真有同 key 规则才算「已保存」
  const hasSavedRule =
    Boolean(editingKey) && rules.some((rule) => ruleKey(rule) === editingKey);

  // 返回是否真的落盘，编辑器据此决定要不要同步表单里的「启用」状态
  const saveRule = async (nextRule) => {
    const newKey = ruleKey(nextRule);
    // 改了 method/path 撞上「另一条」已有规则时，下面的 filter 会把它整条替换掉
    // （连同变体），先让用户确认。同 key 覆盖（正常编辑 / 历史草稿）不拦。
    const clashed =
      newKey !== editingKey && rules.find((rule) => ruleKey(rule) === newKey);
    if (clashed) {
      const variantCount = Array.isArray(clashed.variants) ? clashed.variants.length : 0;
      const ok = await confirm({
        title: "覆盖已有规则？",
        message:
          `${newKey} 已经有一条规则${variantCount ? `（含 ${variantCount} 个变体）` : ""}。\n\n` +
          `继续保存会用当前内容整条替换它，原规则不可恢复。`,
        confirmText: "覆盖",
        danger: true,
      });
      if (!ok) return false;
    }
    // 原地替换，不挪到末尾：server 在具体程度相同的规则间按数组顺序取第一条，
    // 编辑一次就挪到最后会悄悄改变「谁先命中」，文件 diff 也会一团乱。
    // 位置取被编辑规则原来的位置；新建 / 草稿则取被覆盖的同 key 规则的位置；都没有才追加。
    const editingIndex = rules.findIndex((rule) => ruleKey(rule) === editingKey);
    const slot =
      editingIndex >= 0
        ? editingIndex
        : rules.findIndex((rule) => ruleKey(rule) === newKey);
    const nextRules = rules.flatMap((rule, index) => {
      if (index === slot) return [nextRule];
      const k = ruleKey(rule);
      return k === newKey || k === editingKey ? [] : [rule];
    });
    if (slot < 0) nextRules.push(nextRule);

    const saved = await saveRules(nextRules);
    if (!saved) return false;
    editorDirtyRef.current = false;
    setSelectedKey(newKey);
    showToast(
      editingScene ? `规则已保存到场景「${editingScene}」` : "Mock 规则已保存",
      "success",
    );
    return true;
  };

  // 列表内联开关：即时落盘，语义与编辑器一致（不再走「待保存」批量）。
  const toggleRuleEnabled = async (rule, nextEnabled) => {
    const targetKey = ruleKey(rule);
    const nextRules = rules.map((r) =>
      ruleKey(r) === targetKey ? { ...r, enabled: nextEnabled } : r,
    );
    const saved = await saveRules(nextRules);
    if (!saved) return;
    showToast(nextEnabled ? "已启用" : "已停用", "success");
  };

  // 批量操作作用于列表里勾选的规则（targetRules），返回是否已落盘。
  const bulkSetEnabled = async (targetRules, nextEnabled) => {
    if (targetRules.length === 0) return false;
    const targetKeys = new Set(targetRules.map(ruleKey));
    const nextRules = rules.map((rule) =>
      targetKeys.has(ruleKey(rule)) ? { ...rule, enabled: nextEnabled } : rule,
    );
    const saved = await saveRules(nextRules);
    if (!saved) return false;
    showToast(
      `已${nextEnabled ? "启用" : "停用"} ${targetKeys.size} 条规则`,
      "success",
    );
    return true;
  };

  const bulkDelete = async (targetRules) => {
    if (targetRules.length === 0) return false;
    const targetKeys = new Set(targetRules.map(ruleKey));
    const ok = await confirm({
      title: "清除规则",
      message: editingScene
        ? `将从场景「${editingScene}」删除选中的 ${targetKeys.size} 条规则，此操作不可撤销。`
        : `将删除选中的 ${targetKeys.size} 条 mock 规则，此操作不可撤销（可先把当前规则存为场景）。`,
      confirmText: "清除",
      danger: true,
    });
    if (!ok) return false;
    const nextRules = rules.filter((rule) => !targetKeys.has(ruleKey(rule)));
    const saved = await saveRules(nextRules);
    if (!saved) return false;
    if (targetKeys.has(editingKey)) {
      editorDirtyRef.current = false;
      setSelectedKey("");
    }
    showToast(`已清除 ${targetKeys.size} 条 mock 规则`, "success");
    return true;
  };

  const deleteRuleByKey = async (targetKey) => {
    if (!targetKey) return false;
    const nextRules = rules.filter((rule) => ruleKey(rule) !== targetKey);
    const saved = await saveRules(nextRules);
    if (!saved) return false;
    showToast("Mock 规则已删除", "success");
    return true;
  };

  const deleteRule = async () => {
    if (!editingKey) return;
    const ok = await confirm({
      title: "删除规则",
      message: editingKey,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    const done = await deleteRuleByKey(editingKey);
    if (!done) return;
    editorDirtyRef.current = false;
    // 编辑器在弹框里：删完直接关弹框回列表
    setSelectedKey("");
  };

  const deleteRuleFromList = async (rule) => {
    const targetKey = ruleKey(rule);
    const ok = await confirm({
      title: "删除规则",
      message: targetKey,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    await deleteRuleByKey(targetKey);
  };

  const selectItem = (item) => guardSwitch(() => setSelectedKey(item.key));

  const createCustomRule = () =>
    guardSwitch(() => setSelectedKey(CUSTOM_NEW_KEY));

  const openRulesFile = async () => {
    const result = await window.electronAPI.openMockRulesFile(
      editingScene || undefined,
    );
    if (!result?.success) {
      showToast(`打开失败: ${result?.error || "未知错误"}`, "error");
    }
  };

  const openRulesFolder = async () => {
    const result = await window.electronAPI.openMockRulesFolder(
      editingScene || undefined,
    );
    if (!result?.success) {
      showToast(`打开文件夹失败: ${result?.error || "未知错误"}`, "error");
    }
  };

  const mockBaseUrl = `http://${config?.mockHost || "127.0.0.1"}:${
    config?.mockPort || 3002
  }`;

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-base">
      <header className="h-[50px] shrink-0 flex items-center gap-3 px-4 border-b border-border">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-900 flex items-center gap-2">
            Mock 配置
            {editingScene && (
              <span
                title={editingScene}
                className="max-w-[320px] truncate px-1.5 py-0.5 rounded border text-[10.5px] font-medium bg-violet-400/10 text-violet-700 border-violet-400/35"
              >
                编辑场景：{editingScene}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={openRulesFolder}
            className="text-[11px] text-slate-500 hover:text-sky-600 hover:underline cursor-pointer truncate block text-left w-full outline-none"
            title={`点击打开本地文件夹：\n${rulesFile || "mock-rules.json"}`}
          >
            {rulesFile || "mock-rules.json"}
          </button>
        </div>
        {/* whitespace-nowrap 会被按钮继承，header 变挤时按钮文字不竖排 */}
        <div className="ml-auto shrink-0 flex items-center gap-2 whitespace-nowrap">
          <span className="text-[11px] text-slate-500">
            {routes.length} APIs · {rules.length} rules
          </span>
          {editingScene && (
            <button
              type="button"
              onClick={finishSceneEdit}
              title="结束场景编辑，回到活动规则（规则改动已逐条落盘）"
              className="px-3 py-1 rounded-md border text-xs font-medium whitespace-nowrap bg-emerald-400/10 text-emerald-700 border-emerald-400/35 hover:bg-emerald-400/20"
            >
              结束编辑
            </button>
          )}
          <ScenesMenu
            onApplied={load}
            editingScene={editingScene}
            onEdit={enterSceneEdit}
            onExitEdit={exitSceneEdit}
          />
          <button
            type="button"
            onClick={openRulesFile}
            title="用系统默认应用打开 mock-rules.json"
            className="px-3 py-1 rounded-md border text-xs font-medium bg-card text-slate-600 border-border hover:bg-hover hover:text-slate-900"
          >
            打开 JSON
          </button>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="px-3 py-1 rounded-md border text-xs font-medium bg-card text-slate-600 border-border hover:bg-hover hover:text-slate-900 disabled:opacity-50"
          >
            刷新
          </button>
          <button
            type="button"
            onClick={createCustomRule}
            className="px-3 py-1 rounded-md border text-xs font-medium bg-emerald-400/10 text-emerald-700 border-emerald-400/35 hover:bg-emerald-400/20"
          >
            新增
          </button>
        </div>
      </header>

      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <MockRuleList
          allItems={allItems}
          loading={loading}
          saving={loading}
          selectedKey={selectedKey}
          onSelectItem={selectItem}
          onToggleEnabled={toggleRuleEnabled}
          onDeleteRule={deleteRuleFromList}
          onBulkSetEnabled={bulkSetEnabled}
          onBulkDelete={bulkDelete}
        />
      </div>

      {/* 编辑器改为全屏弹框：列表占满页面，配置区不再被变体挤压。
          conditional render + key：打开即按当前选中项初始化表单，切换项自然重挂 */}
      {Boolean(selectedKey) && (
        <Modal
          open
          onClose={() => guardSwitch(() => setSelectedKey(""))}
          srOnly={false}
          title={
            selectedItem
              ? `${(selectedItem.method || selectedItem.rule?.method || "").toUpperCase()} ${
                  selectedItem.path || selectedItem.rule?.path || ""
                }`
              : "新增 Mock 规则"
          }
          className="w-[94vw] max-w-300 h-[92vh]"
        >
          <MockRuleEditor
            key={selectedKey}
            rule={selectedItem?.rule}
            route={selectedItem?.route}
            hasSavedRule={hasSavedRule}
            mockBaseUrl={mockBaseUrl}
            backendBaseUrl={config?.mockBackendBaseUrl}
            onSubmit={saveRule}
            onDelete={deleteRule}
            onDirtyChange={handleDirtyChange}
          />
        </Modal>
      )}
    </div>
  );
}
