import { useCallback, useState } from "react";
import { useLocation } from "react-router";
import useMockData from "./use-mock-data";
import MockRuleList from "./mock-rule-list";
import MockRuleEditor from "./mock-rule-editor";
import { ruleKey } from "./utils";
import { useAppConfig } from "../../stores/app-config-store";
import { showToast } from "../../utils/toast";
import useConfirm from "../../hooks/use-confirm";
import Modal from "../../components/modal";

const CUSTOM_NEW_KEY = "__custom_new__";
// 从请求历史「生成 mock 规则」跳转过来时的草稿选中项
const DRAFT_KEY = "__draft_from_history__";

/**
 * 场景菜单：列出 scenes/ 下的规则快照，支持应用（覆盖当前规则）、编辑
 * （页面切到场景编辑模式，直接改场景文件）、删除、把当前规则另存为场景。
 * 录制到的场景也在这里应用。
 */
function ScenesMenu({ onApplied, editingScene, onEdit, onExitEdit, confirm }) {
  const [open, setOpen] = useState(false);
  const [scenes, setScenes] = useState([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(null); // 正在改名的场景名
  const [renameValue, setRenameValue] = useState("");

  const refresh = async () => {
    try {
      const result = await window.electronAPI.listMockScenes();
      if (result?.success) setScenes(result.scenes || []);
    } catch {
      // 列表拉不到时面板照常打开（空态），不阻塞交互
    }
  };

  const toggle = () => {
    if (!open) refresh();
    setOpen(!open);
  };

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

  const saveScene = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
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
    setRenaming(sceneName);
    setRenameValue(sceneName);
  };

  const cancelRename = () => {
    setRenaming(null);
    setRenameValue("");
  };

  const submitRename = async () => {
    const from = renaming;
    const to = renameValue.trim();
    if (!to || to === from) {
      cancelRename();
      return;
    }
    const result = await window.electronAPI.renameMockScene(from, to);
    if (!result?.success) {
      showToast(`重命名失败: ${result?.error || "未知错误"}`, "error");
      return;
    }
    cancelRename();
    showToast(`已重命名为「${result.name}」`, "success");
    refresh();
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
        className="w-[500px]"
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
            className="text-slate-400 hover:text-slate-700 transition-colors text-xs leading-none cursor-pointer p-1.5 rounded hover:bg-slate-200/60 flex items-center gap-1 font-medium mr-1"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="w-4 h-4"
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
        <div className="max-h-80 overflow-y-auto p-4 flex flex-col gap-2">
          {scenes.length === 0 && (
            <div className="px-2 py-8 text-center text-xs text-slate-400">
              还没有场景。可以把当前规则存为场景，或在请求历史页录制。
            </div>
          )}
          {scenes.map((scene) => (
            <div
              key={scene.name}
              className="flex items-center gap-2 px-3 py-2 rounded-md border border-border/50 hover:bg-hover hover:border-border transition-all"
            >
              {renaming === scene.name ? (
                <>
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitRename();
                      if (e.key === "Escape") cancelRename();
                    }}
                    placeholder="新场景名…"
                    className="flex-1 min-w-0 bg-panel border border-border rounded-md px-2 py-1.5 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500"
                  />
                  <button
                    type="button"
                    onClick={submitRename}
                    disabled={!renameValue.trim()}
                    className="px-2.5 py-1.5 rounded-md border text-xs font-medium bg-emerald-400/10 text-emerald-700 border-emerald-400/35 hover:bg-emerald-400/20 disabled:opacity-40"
                  >
                    确定
                  </button>
                  <button
                    type="button"
                    onClick={cancelRename}
                    className="px-2.5 py-1.5 rounded-md border text-xs font-medium bg-slate-400/10 text-slate-600 border-slate-400/30 hover:bg-slate-400/20"
                  >
                    取消
                  </button>
                </>
              ) : (
                <>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-slate-900 flex items-center gap-1.5 truncate">
                      <span className="truncate">{scene.name}</span>
                      <button
                        type="button"
                        disabled={scene.name === editingScene}
                        onClick={() => startRename(scene.name)}
                        title={
                          scene.name === editingScene
                            ? "请先结束编辑再改名"
                            : "重命名场景"
                        }
                        className="text-[10px] text-slate-400 hover:text-slate-600 underline decoration-dotted disabled:opacity-40 disabled:no-underline"
                      >
                        重命名
                      </button>

                      {scene.name === editingScene && (
                        <span className="px-1 py-0.5 rounded text-[9px] font-semibold bg-violet-100 text-violet-700">
                          编辑中
                        </span>
                      )}
                    </div>

                    <div className="text-[10.5px] text-slate-500 mt-0.5">
                      {scene.ruleCount} 条规则
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => applyScene(scene.name)}
                      className="px-2.5 py-1 rounded-md border text-xs font-medium bg-sky-400/10 text-sky-700 border-sky-400/35 hover:bg-sky-400/20 disabled:opacity-40"
                    >
                      应用
                    </button>
                    <button
                      type="button"
                      disabled={scene.name === editingScene}
                      onClick={() => editScene(scene.name)}
                      className="px-2.5 py-1 rounded-md border text-xs font-medium bg-violet-400/10 text-violet-700 border-violet-400/35 hover:bg-violet-400/20 disabled:opacity-40"
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => exportScene(scene.name)}
                      title="导出为 JSON 文件"
                      className="px-2.5 py-1 rounded-md border text-xs font-medium bg-amber-400/10 text-amber-700 border-amber-400/35 hover:bg-amber-400/20 disabled:opacity-40"
                    >
                      导出
                    </button>
                    <button
                      type="button"
                      onClick={() => removeScene(scene.name)}
                      className="px-2.5 py-1 rounded-md border text-xs font-medium bg-red-400/10 text-red-700 border-red-400/30 hover:bg-red-400/20"
                    >
                      删除
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
        <div className="px-5 py-4 border-t border-border bg-slate-50/50 flex flex-col gap-2 shrink-0">
          <div className="flex items-center gap-1.5">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveScene()}
              placeholder="把当前规则存为场景…"
              className="flex-1 bg-panel border border-border rounded-md px-2.5 py-1.5 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500"
            />
            <button
              type="button"
              onClick={saveScene}
              disabled={!name.trim()}
              className="px-3 py-1.5 rounded-md border text-xs font-medium bg-emerald-400/10 text-emerald-700 border-emerald-400/35 hover:bg-emerald-400/20 disabled:opacity-40"
            >
              保存
            </button>
          </div>
          <button
            type="button"
            onClick={importScene}
            disabled={busy}
            title="从 JSON 文件导入为新场景（同名自动去重）"
            className="w-full px-3 py-1.5 rounded-md border text-xs font-medium bg-sky-400/10 text-sky-700 border-sky-400/35 hover:bg-sky-400/20 disabled:opacity-40"
          >
            从文件导入场景…
          </button>
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
    selectedKey,
    setSelectedKey,
    editingScene,
  });

  const { confirm, confirmDialog } = useConfirm();

  // Editor 上报的「有未保存改动」。切换选中项前用它拦截，避免静默丢失。
  const [editorDirty, setEditorDirty] = useState(false);
  const handleDirtyChange = useCallback((dirty) => setEditorDirty(dirty), []);

  // 切换选中项 / 进出场景编辑前的统一守卫：编辑器有未保存改动时先确认。
  const guardSwitch = async (proceed) => {
    if (editorDirty) {
      const ok = await confirm({
        title: "放弃未保存的改动？",
        message: "当前编辑器有未保存的修改，切换后会丢失。",
        confirmText: "放弃并切换",
        danger: true,
      });
      if (!ok) return;
      setEditorDirty(false);
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

  // 场景编辑本身逐条即时落盘，退出前只需守卫编辑器里未保存的改动。
  const finishSceneEdit = () => guardSwitch(exitSceneEdit);

  const ruleMap = new Map(rules.map((rule) => [ruleKey(rule), rule]));
  const lookupRule = (method, path) =>
    ruleMap.get(`${method.toUpperCase()} ${path}`) || ruleMap.get(`* ${path}`);

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
      method: rule.method || "*",
      path: rule.path,
      summary: "自定义 mock 规则",
      source: "mock-rules",
      route: null,
      rule,
    }));
  const allItems = [...customItems, ...routeItems];

  let selectedItem = allItems.find((item) => item.key === selectedKey) || null;
  if (selectedKey === DRAFT_KEY && draft) {
    selectedItem = {
      key: DRAFT_KEY,
      rule: { enabled: true, ...draft },
      route: null,
    };
  }
  const editingKey = selectedItem?.rule ? ruleKey(selectedItem.rule) : null;
  // 草稿的 rule 是凭空构造的，只有 rules 里真有同 key 规则才算「已保存」
  const hasSavedRule =
    Boolean(editingKey) && rules.some((rule) => ruleKey(rule) === editingKey);

  const saveRule = async (nextRule) => {
    const newKey = ruleKey(nextRule);
    const nextRules = [
      ...rules.filter((rule) => {
        const k = ruleKey(rule);
        return k !== newKey && k !== editingKey;
      }),
      nextRule,
    ];

    const saved = await saveRules(nextRules);
    if (!saved) return;
    setEditorDirty(false);
    setSelectedKey(newKey);
    showToast(
      editingScene ? `规则已保存到场景「${editingScene}」` : "Mock 规则已保存",
      "success",
    );
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
      setEditorDirty(false);
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
    setEditorDirty(false);
    // 删完后保留 route 选中（若有），否则清空
    setSelectedKey(selectedItem?.route ? ruleKey(selectedItem.route) : "");
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
              <span className="px-1.5 py-0.5 rounded border text-[10.5px] font-medium whitespace-nowrap bg-violet-400/10 text-violet-700 border-violet-400/35">
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
            confirm={confirm}
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

      <div className="flex-1 min-h-0 grid grid-cols-[360px_1fr] overflow-hidden">
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

        {/* key 让 Editor 在切换选中项时重挂，useForm 自然用新 defaults 初始化 */}
        <MockRuleEditor
          key={selectedKey || "empty"}
          rule={selectedItem?.rule}
          route={selectedItem?.route}
          hasSavedRule={hasSavedRule}
          mockBaseUrl={mockBaseUrl}
          backendBaseUrl={config?.mockBackendBaseUrl}
          onSubmit={saveRule}
          onDelete={deleteRule}
          onDirtyChange={handleDirtyChange}
        />
      </div>
      {confirmDialog}
    </div>
  );
}
