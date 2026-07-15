/**
 * 日志存储 —— 完全脱离 React 的 module-level singleton。
 *
 * 设计动机：项目跑起来时 process-log IPC 每秒几十次触发，原先走 React state
 * 会让 RunnerContext value 每次都换引用，所有消费者跟着重渲染。
 * 现在日志只 push 给当前订阅了对应 paneKey 的 LogTerminal，React 完全不参与。
 *
 * 订阅者签名：(chunk: string | null, full: string) => void
 *   - chunk = string → 增量追加
 *   - chunk = null   → 整段被清空 / 截断，订阅者应当 reset 后重写 full
 */

const MAX = 500_000; // 单个 buffer 上限
const KEEP = 300_000; // 截断时保留尾部

const buffers = new Map(); // id → 累积 buffer
const subs = new Map(); // id → Set<listener>

function capBuffer(buf) {
  if (buf.length <= MAX) return buf;
  const sliced = buf.slice(buf.length - KEEP);
  // 截到第一个换行后，避免半行 ANSI 残留
  const nl = sliced.indexOf("\n");
  return nl > 0 ? sliced.slice(nl + 1) : sliced;
}

function notify(id, chunk, full) {
  const set = subs.get(id);
  if (!set) return;
  set.forEach((fn) => fn(chunk, full));
}

export function append(id, chunk) {
  if (!chunk) return;
  const prev = buffers.get(id) || "";
  const merged = prev + chunk;
  const capped = capBuffer(merged);
  buffers.set(id, capped);

  // 如果发生了截断，订阅者需要 reset 后重写整段（chunk = null）
  if (capped.length !== merged.length) {
    notify(id, null, capped);
  } else {
    notify(id, chunk, capped);
  }
}

export function clear(id) {
  if (!id) return;
  buffers.set(id, "");
  notify(id, null, "");
}

// 清空所有面板的日志：取 buffers 与 subs 的并集，逐个 reset。
// 即便某个面板当前没有 buffer、只有订阅者（刚打开还没输出），也一并通知重置。
export function clearAll() {
  const ids = new Set([...buffers.keys(), ...subs.keys()]);
  for (const id of ids) {
    buffers.set(id, "");
    notify(id, null, "");
  }
}

export function get(id) {
  return buffers.get(id) || "";
}

export function subscribe(id, fn) {
  if (!subs.has(id)) subs.set(id, new Set());
  subs.get(id).add(fn);
  return () => {
    const set = subs.get(id);
    if (!set) return;
    set.delete(fn);
    if (set.size === 0) subs.delete(id);
  };
}

// ─── IPC 接线 ────────────────────────────────────────────────────────────────
// 模块首次 import 时执行一次。Vite HMR 时如果 log-store 自身被重新求值，
// __WIRED__ 防止重复 attach（实际上 vite 不会反复求值不变模块，但保险）。

if (typeof window !== "undefined" && window.electronAPI && !window.__LOG_STORE_WIRED__) {
  window.electronAPI.onProcessLog(({ projectId, data }) => append(projectId, data));
  window.__LOG_STORE_WIRED__ = true;
}
