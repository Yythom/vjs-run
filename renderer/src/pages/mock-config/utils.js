// method 必须具体：OpenAPI 里每个操作本来就绑定在某个 method 上，规则没理由更宽松。
// mock server 的 findMockRule 也只匹配具体 method。
export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

export function ruleKey(rule) {
  return `${(rule?.method || "").toUpperCase()} ${rule?.path || ""}`;
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
