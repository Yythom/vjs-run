// electron-store 封装 + 内存里持有 live config。
// 全项目通过 getConfig() 读取最新配置，通过 saveConfig(partial) 修改。

import Store from "electron-store";
import { DEFAULT_CONFIG } from "./defaults.js";
import { normalizeConfig } from "./normalize.js";

let store = null;
let liveConfig = { ...DEFAULT_CONFIG };

/**
 * 必须在 app.whenReady 之后调用（构造函数会读 app.getPath('userData')）。
 * 文件名 config 对应 userData/config.json，与旧版本路径一致，零迁移。
 */
export function initStore() {
  store = new Store({
    name: "config",
    defaults: { ...DEFAULT_CONFIG },
  });
  liveConfig = loadFromDisk();
}

function loadFromDisk() {
  try {
    return normalizeConfig(store ? store.store : {});
  } catch {
    return normalizeConfig();
  }
}

/** 当前内存里的 live config。所有读取点都用这个，永远返回最新值。 */
export function getConfig() {
  return liveConfig;
}

/**
 * 恢复出厂配置：清空 config.json（electron-store 回落到构造时的 defaults），
 * 并刷新内存里的 live config。会丢失所有项目 / 仓库 / mock 设置，调用方需二次确认。
 */
export function resetStore() {
  if (store) store.clear();
  liveConfig = loadFromDisk();
  return liveConfig;
}

/**
 * 合并 partial → normalize → 写盘 → 更新 live config。
 * 抛错时不修改 live config，让调用方（ipcSafe）兜住。
 */
export function saveConfig(partial) {
  const merged = normalizeConfig({
    ...(store ? store.store : {}),
    ...partial,
  });
  if (store) store.store = merged;
  liveConfig = merged;
  return merged;
}
