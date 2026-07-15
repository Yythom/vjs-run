import { create } from "zustand";

/**
 * Mock 请求历史 store。
 * 增量靠 preload 的 mock-request 事件推送（模块加载时接线一次，与 log-store 同套路），
 * 全量在面板打开时通过 loadMockHistory 拉取兜底（覆盖窗口刷新 / 打开面板前的记录）。
 */

const MAX_ENTRIES = 300;

const useMockHistoryStore = create(() => ({
  entries: [],
}));

export const useMockHistory = () => useMockHistoryStore((s) => s.entries);

export async function loadMockHistory() {
  const result = await window.electronAPI.getMockHistory();
  if (!result?.success) return result;
  useMockHistoryStore.setState({ entries: result.entries || [] });
  return result;
}

export async function clearMockHistory() {
  const result = await window.electronAPI.clearMockHistory();
  if (result?.success) useMockHistoryStore.setState({ entries: [] });
  return result;
}

function appendEntry(entry) {
  useMockHistoryStore.setState((s) => {
    // id 单调递增；全量拉取和事件推送可能交错，靠 id 去重（迟到的旧事件直接丢弃）
    const last = s.entries[s.entries.length - 1];
    if (last && last.id >= entry.id) return s;
    const next = [...s.entries, entry];
    return { entries: next.length > MAX_ENTRIES ? next.slice(-MAX_ENTRIES) : next };
  });
}

// ─── IPC 接线（模块首次 import 时执行一次，防 HMR 重复 attach）──────────────────
if (
  typeof window !== "undefined" &&
  window.electronAPI?.onMockRequest &&
  !window.__MOCK_HISTORY_WIRED__
) {
  window.electronAPI.onMockRequest(appendEntry);
  window.__MOCK_HISTORY_WIRED__ = true;
}
