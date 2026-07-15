import { useState } from "react";
import { useLocation } from "react-router";
import useMockData from "./use-mock-data";
import usePendingToggles from "./use-pending-toggles";
import MockRuleList from "./mock-rule-list";
import MockRuleEditor from "./mock-rule-editor";
import { ruleKey } from "./utils";
import { useAppConfig } from "../../stores/app-config-store";
import { showToast } from "../../utils/toast";

const CUSTOM_NEW_KEY = "__custom_new__";
// 从请求历史「生成 mock 规则」跳转过来时的草稿选中项
const DRAFT_KEY = "__draft_from_history__";

/**
 * 场景菜单：列出 scenes/ 下的规则快照，支持应用（覆盖当前规则）、删除、
 * 把当前规则另存为场景。录制到的场景也在这里应用。
 */
function ScenesMenu({ onApplied }) {
  const [open, setOpen] = useState(false);
  const [scenes, setScenes] = useState([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

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
    if (
      !window.confirm(
        `应用场景「${sceneName}」会覆盖当前全部规则（可先把当前规则存为场景）。继续？`,
      )
    ) {
      return;
    }
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
    showToast(`已保存场景「${result.name}」（${result.count} 条规则）`, "success");
    refresh();
  };

  const removeScene = async (sceneName) => {
    if (!window.confirm(`确认删除场景「${sceneName}」？`)) return;
    const result = await window.electronAPI.deleteMockScene(sceneName);
    if (!result?.success) {
      showToast(`删除失败: ${result?.error || "未知错误"}`, "error");
      return;
    }
    refresh();
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={toggle}
        title="规则场景：保存 / 应用整套规则快照"
        className="px-3 py-1 rounded-md border text-xs font-medium bg-violet-400/10 text-violet-700 border-violet-400/35 hover:bg-violet-400/20"
      >
        场景 ▾
      </button>
      {open && (
        <>
          {/* 透明遮罩：点外面关闭 */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1.5 w-80 z-50 bg-card border border-border rounded-lg shadow-lg p-2">
            <div className="max-h-64 overflow-y-auto">
              {scenes.length === 0 && (
                <div className="px-2 py-3 text-[11px] text-slate-400">
                  还没有场景。可以把当前规则存为场景，或在请求历史页录制。
                </div>
              )}
              {scenes.map((scene) => (
                <div
                  key={scene.name}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-hover"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-slate-900 truncate">
                      {scene.name}
                    </div>
                    <div className="text-[10.5px] text-slate-500">
                      {scene.ruleCount} 条规则
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => applyScene(scene.name)}
                    className="px-2 py-1 rounded-md border text-[11px] font-medium bg-sky-400/10 text-sky-700 border-sky-400/35 hover:bg-sky-400/20 disabled:opacity-40"
                  >
                    应用
                  </button>
                  <button
                    type="button"
                    onClick={() => removeScene(scene.name)}
                    className="px-2 py-1 rounded-md border text-[11px] font-medium bg-red-400/10 text-red-700 border-red-400/30 hover:bg-red-400/20"
                  >
                    删
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-2 pt-2 border-t border-border flex items-center gap-1.5">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveScene()}
                placeholder="把当前规则存为场景…"
                className="flex-1 bg-panel border border-border rounded-md px-2.5 py-1 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500"
              />
              <button
                type="button"
                onClick={saveScene}
                disabled={!name.trim()}
                className="px-2.5 py-1 rounded-md border text-xs font-medium bg-emerald-400/10 text-emerald-700 border-emerald-400/35 hover:bg-emerald-400/20 disabled:opacity-40"
              >
                保存
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function MockConfigPage() {
  const config = useAppConfig();
  // 请求历史页通过 location.state.draft 传入预填的规则草稿（method/path/status/response）
  const draft = useLocation().state?.draft || null;
  const [selectedKey, setSelectedKey] = useState(draft ? DRAFT_KEY : "");

  const { routes, rules, rulesFile, loading, load, saveRules } = useMockData({
    config,
    onToast: showToast,
    selectedKey,
    setSelectedKey,
  });

  const pending = usePendingToggles({ rules, saveRules, onToast: showToast });

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
    pending.clearKey(newKey);
    if (editingKey && editingKey !== newKey) pending.clearKey(editingKey);
    setSelectedKey(newKey);
    showToast("Mock 规则已保存", "success");
  };

  const deleteRuleByKey = async (targetKey) => {
    if (!targetKey) return;
    const nextRules = rules.filter((rule) => ruleKey(rule) !== targetKey);
    const saved = await saveRules(nextRules);
    if (!saved) return false;
    pending.clearKey(targetKey);
    showToast("Mock 规则已删除", "success");
    return true;
  };

  const deleteRule = async () => {
    const ok = await deleteRuleByKey(editingKey);
    if (!ok) return;
    // 删完后保留 route 选中（若有），否则清空
    setSelectedKey(selectedItem?.route ? ruleKey(selectedItem.route) : "");
  };

  const deleteRuleFromList = async (rule) => {
    const targetKey = ruleKey(rule);
    if (!window.confirm(`确认删除该 mock 规则？\n${targetKey}`)) return;
    await deleteRuleByKey(targetKey);
  };

  const createCustomRule = () => setSelectedKey(CUSTOM_NEW_KEY);

  const openRulesFile = async () => {
    const result = await window.electronAPI.openMockRulesFile();
    if (!result?.success) {
      showToast(`打开失败: ${result?.error || "未知错误"}`, "error");
    }
  };

  const mockBaseUrl = `http://${config?.mockHost || "127.0.0.1"}:${
    config?.mockPort || 3002
  }`;

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-base">
      <header className="h-[50px] shrink-0 flex items-center gap-3 px-4 border-b border-border">
        <div>
          <div className="text-sm font-semibold text-slate-900">Mock 配置</div>
          <div className="text-[11px] text-slate-500">
            {rulesFile || "mock-rules.json"}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[11px] text-slate-500">
            {routes.length} APIs · {rules.length} rules
          </span>
          <ScenesMenu onApplied={load} />
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
          saving={pending.saving}
          selectedKey={selectedKey}
          pendingEnabled={pending.pendingEnabled}
          onSelectItem={(item) => setSelectedKey(item.key)}
          onTogglePendingEnabled={pending.toggle}
          onDeleteRule={deleteRuleFromList}
        />

        {/* key 让 Editor 在切换选中项时重挂，useForm 自然用新 defaults 初始化 */}
        <MockRuleEditor
          key={selectedKey || "empty"}
          rule={selectedItem?.rule}
          route={selectedItem?.route}
          hasSavedRule={hasSavedRule}
          mockBaseUrl={mockBaseUrl}
          pendingCount={pending.pendingCount}
          onSubmit={saveRule}
          onDelete={deleteRule}
          onSavePending={pending.save}
          onDiscardPending={pending.clear}
        />
      </div>
    </div>
  );
}
