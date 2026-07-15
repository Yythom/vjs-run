import { useState } from "react";
import { ruleKey } from "./utils";

/**
 * 列表内联开关的「待保存」状态 —— { [ruleKey]: nextEnabled }。
 *
 * 行为：
 *   - toggle(rule, next): 切回原值会从 pending 中移除，避免误报"有变更"
 *   - clear(): 全部丢弃
 *   - clearKey(key): 某条规则单独保存/删除后清掉对应 pending
 *   - save(): 批量落盘，成功后自动清空
 *
 * rules 引用变化（reload 后）会自动 clear pending，因为旧 key 可能已失效。
 */
export default function usePendingToggles({ rules, saveRules, onToast }) {
  const [pendingEnabled, setPendingEnabled] = useState({});
  const [saving, setSaving] = useState(false);

  const [prevRules, setPrevRules] = useState(rules);
  if (rules !== prevRules) {
    setPrevRules(rules);
    setPendingEnabled({});
  }

  const toggle = (rule, nextEnabled) => {
    const targetKey = ruleKey(rule);
    const savedEnabled = rule.enabled !== false;
    setPendingEnabled((prev) => {
      const next = { ...prev };
      if (nextEnabled === savedEnabled) delete next[targetKey];
      else next[targetKey] = nextEnabled;
      return next;
    });
  };

  const clear = () => setPendingEnabled({});

  const clearKey = (key) => {
    if (!key) return;
    setPendingEnabled((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const save = async () => {
    if (saving) return false;
    const keys = Object.keys(pendingEnabled);
    if (!keys.length) return false;

    const nextRules = rules.map((r) => {
      const k = ruleKey(r);
      return k in pendingEnabled ? { ...r, enabled: pendingEnabled[k] } : r;
    });

    setSaving(true);
    try {
      const saved = await saveRules(nextRules);
      if (saved) {
        setPendingEnabled({});
        onToast?.(`已保存 ${keys.length} 项开关变更`, "success");
      }
      return Boolean(saved);
    } finally {
      setSaving(false);
    }
  };

  return {
    pendingEnabled,
    pendingCount: Object.keys(pendingEnabled).length,
    saving,
    toggle,
    clear,
    clearKey,
    save,
  };
}
