// 新建规则时不再提供 "*"：通配规则很难看出到底会盖住哪些接口，排障成本高。
// server 侧仍然认 "*"（mock-rules.json 里的存量规则照常生效），编辑器打开这类
// 存量规则时会临时把 "*" 补进下拉，见 MockRuleEditor 的 methodOptions。
export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
export const WILDCARD_METHOD = "*";

export function ruleKey(rule) {
  return `${(rule?.method || "*").toUpperCase()} ${rule?.path || ""}`;
}

export function prettyJson(value) {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
}

export function isRuleEffective(rule) {
  if (!rule || rule.enabled === false) return false;
  return rule.response !== undefined || rule.status !== undefined;
}
