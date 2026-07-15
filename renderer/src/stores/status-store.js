import { create } from "zustand";

/**
 * 进程状态 store。每个 id 一份 status；组件用 useStatus(id) 精确订阅，
 * 只有自己关心的 id 变化才重渲染。
 *
 * status ∈ "stopped" | "starting" | "running" | "error"
 */
const useStatusStore = create((set) => ({
  statuses: {},

  set: (id, status) =>
    set((state) =>
      state.statuses[id] === status
        ? state
        : { statuses: { ...state.statuses, [id]: status } },
    ),

  setMany: (entries) =>
    set((state) => {
      let dirty = false;
      const next = { ...state.statuses };
      for (const [id, status] of entries) {
        if (next[id] !== status) {
          next[id] = status;
          dirty = true;
        }
      }
      return dirty ? { statuses: next } : state;
    }),
}));

// ─── 便捷 API（与之前手写版本签名一致，迁移成本最低）─────────────────────────

export const get = (id) =>
  useStatusStore.getState().statuses[id] || "stopped";

export const set = (id, status) =>
  useStatusStore.getState().set(id, status);

export const setMany = (entries) =>
  useStatusStore.getState().setMany(entries);

/**
 * 精确订阅某个 id 的 status；只有这个 id 变化才让组件重渲染。
 *   const status = useStatus(project.id);
 */
export const useStatus = (id) =>
  useStatusStore((s) => s.statuses[id] || "stopped");
