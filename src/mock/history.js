// Mock 请求历史：主进程内存环形缓冲。
// server.js 每处理完一个请求（mock 命中 / 代理 / 未命中）回调 recordMockRequest，
// 这里补上 id/ts 后入缓冲并实时推给渲染层。历史跨 mock 重启保留，仅手动清空。

import { sendMockRequest } from "../ui-channel.js";

const MAX_ENTRIES = 300;

let seq = 0;
let entries = [];

/**
 * @param {object} entry - server.js 组装的记录，形如：
 *   { kind: "mock"|"proxy"|"proxy-error"|"miss", method, path, query,
 *     matchedPath, status, durationMs, source, variant?, requestBody,
 *     responseBody, responseTruncated }
 *   variant：命中 mock 规则「变体」时的变体名（source 为 "rule-variant"）
 */
export function recordMockRequest(entry) {
  const full = { id: ++seq, ts: Date.now(), ...entry };
  entries.push(full);
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  sendMockRequest(full);
}

export function getMockHistory() {
  return entries;
}

export function clearMockHistory() {
  entries = [];
}
