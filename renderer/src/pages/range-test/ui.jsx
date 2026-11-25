import { useEffect, useEffectEvent } from "react";
import clsx from "../../utils/clsx";

// 改动测试台几个页面共用的小件：状态徽标、按钮样式、变更订阅。

export const BTN =
  "px-3 py-1.5 rounded-md border text-xs font-medium bg-white text-slate-700 border-slate-200 hover:bg-slate-50 hover:text-slate-900 transition-colors cursor-pointer shadow-2xs disabled:opacity-40 disabled:cursor-not-allowed";
export const BTN_PRIMARY =
  "px-3 py-1.5 rounded-md text-xs font-semibold bg-sky-600 text-white hover:bg-sky-700 transition-colors cursor-pointer shadow-2xs disabled:opacity-40 disabled:cursor-not-allowed";
export const INPUT =
  "w-full bg-card border border-border rounded-md px-3 py-2 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500 transition-colors";

const THREAD_STATE = {
  starting: ["启动中", "bg-sky-50 text-sky-700 border-sky-200"],
  running: ["运行中", "bg-sky-50 text-sky-700 border-sky-200"],
  idle: ["本轮结束", "bg-slate-50 text-slate-600 border-slate-200"],
  "needs-answer": ["等你在 T3 里回答", "bg-amber-50 text-amber-700 border-amber-200"],
  failed: ["失败", "bg-red-50 text-red-700 border-red-200"],
  unknown: ["未知", "bg-slate-50 text-slate-500 border-slate-200"],
};

const PHASE = {
  pending: ["待确认", "bg-amber-50 text-amber-700 border-amber-200"],
  confirmed: ["已确认", "bg-emerald-50 text-emerald-700 border-emerald-200"],
  none: ["还没有清单", "bg-slate-50 text-slate-500 border-slate-200"],
};

function Badge({ label, cls }) {
  return (
    <span className={clsx("inline-flex items-center px-1.5 py-0.5 rounded border text-[10.5px] font-medium whitespace-nowrap", cls)}>
      {label}
    </span>
  );
}

export function ThreadBadge({ state }) {
  const [label, cls] = THREAD_STATE[state] || THREAD_STATE.unknown;
  return <Badge label={label} cls={cls} />;
}

export function PhaseBadge({ kind }) {
  const [label, cls] = PHASE[kind] || PHASE.none;
  return <Badge label={label} cls={cls} />;
}

export const shortSha = (sha) => (sha ? String(sha).slice(0, 10) : "");

export function formatTime(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 订阅主进程的「改动测试有变化」推送（产物文件改了、线程状态变了）。
 * onChange 用 useEffectEvent 读最新的回调，订阅本身只建一次。
 */
export function useRangeTestChanges(onChange) {
  const handle = useEffectEvent(onChange);
  useEffect(() => window.electronAPI?.onRangeTestChanged?.((evt) => handle(evt)), []);
}

/** IPC 的 { success, error } 壳拆掉：失败就抛，交给调用方的 catch / useResource 的 error */
export async function unwrap(promise) {
  const res = await promise;
  if (!res?.success) throw new Error(res?.error || "操作失败");
  return res;
}

// 「已出结果 x/K 格」是清单格子的进度，不是覆盖率：使用者明确说过覆盖率算不准，界面上不显示百分比，
// 并在数字旁边注明它证明不了什么（commit-range-test 自己也说「分支 → 清单」这一层给不出数字）
export const PROGRESS_CAVEAT =
  "这是清单格子的进度，不是代码覆盖率：每格要有实测证据才算出结果；清单有没有把分支列全、预期对不对，这个数字证明不了。";
