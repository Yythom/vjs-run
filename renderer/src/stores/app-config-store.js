import { create } from "zustand";
import { loadConfig, saveConfig } from "../utils/config-api";

const DEFAULT_APP_CONFIG = {
  frontendProjectGroups: [],
  mockSpecPath: "",
  mockSwaggerServer: "http://alb-qtjrjlj7p6s63het87.cn-shanghai.alb.aliyuncs.com",
  mockHost: "127.0.0.1",
  mockPort: 3002,
  mockServiceAddress: "",
  mockVjToken: "",
  sidebarWidth: 248,
  watchedPorts: [3000, 3001, 5173, 3002],
};

/**
 * 应用配置 store。模块级单例，任何地方 import 即用，不需要 Provider。
 *   - useAppConfig() —— 响应式读取 appConfig 对象
 *   - updateAppConfig(patch) —— 增量写入 + 落盘
 */
export const useAppConfigStore = create((set) => ({
  appConfig: DEFAULT_APP_CONFIG,

  /** 启动时从主进程加载一次。main.jsx 调用。 */
  init: async () => {
    const cfg = await loadConfig();
    set({ appConfig: cfg || DEFAULT_APP_CONFIG });
  },

  /** patch 进去 + 立即落盘，返回服务端规整后的 config。 */
  update: async (patch) => {
    const next = await saveConfig(patch);
    const resolved = next || DEFAULT_APP_CONFIG;
    set({ appConfig: resolved });
    return resolved;
  },

  /** 兼容 SettingsPage 保存后直接覆盖整段 config 的旧用法。 */
  replace: (nextConfig) => set({ appConfig: nextConfig || DEFAULT_APP_CONFIG }),
}));

// ─── 便捷 API ────────────────────────────────────────────────────────────────

/** 响应式：组件 re-render 跟随 appConfig 变化 */
export const useAppConfig = () => useAppConfigStore((s) => s.appConfig);

/** 稳定函数，可在任意地方调用（不需要 useEffect 包） */
export const updateAppConfig = (patch) => useAppConfigStore.getState().update(patch);
export const replaceAppConfig = (cfg) => useAppConfigStore.getState().replace(cfg);

export { DEFAULT_APP_CONFIG };
