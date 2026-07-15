// URL 相关的共享小工具。被 config/normalize 与 mock/server 复用，避免两处各写一份漂移。

/**
 * 规整后端 base URL：去首尾空白；非空时确保以 "/" 结尾（方便后续与 path 拼接）。
 * 空值返回空串。
 */
export function normalizeBackendBaseUrl(value = "") {
  const nextValue = String(value || "").trim();
  if (!nextValue) return "";
  return nextValue.endsWith("/") ? nextValue : `${nextValue}/`;
}
