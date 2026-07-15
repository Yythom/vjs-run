export const METHODS = ["*", "GET", "POST", "PUT", "PATCH", "DELETE"];

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
