// 应用清理 IPC：列出可清理项的体积（get-cleanup-info），按用户勾选执行清理（run-cleanup）。
//
// 可清理项分两类：
//   - 安全（删了自动重建 / 仅内存）：appCache（Chromium 缓存）、windowState（窗口位置）
//   - 破坏性（丢用户数据，需二次确认）：mockData（mock 规则与数据）、config（全部配置）
// 「所有面板日志」是渲染层内存数据，由渲染层自己清，不走这里。

import fs from "node:fs";
import path from "node:path";
import { app, session } from "electron";
import { ipcSafe } from "./safe.js";
import { resetStore } from "../config/store.js";
import { ensureUserMockAssets } from "../mock/user-assets.js";

function userDataDir() {
  return app.getPath("userData");
}

// Chromium 自己的缓存目录：删除后会自动重建，清理安全。
const CACHE_DIRS = [
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnWebGPUCache",
  "DawnGraphiteCache",
];

function dirSize(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
    } catch {
      // 读不到的条目跳过，不影响整体统计
    }
  }
  return total;
}

function appCacheBytes() {
  const base = userDataDir();
  return CACHE_DIRS.reduce((sum, d) => sum + dirSize(path.join(base, d)), 0);
}

function mockAssetsBytes() {
  return dirSize(path.join(userDataDir(), "mock-assets"));
}

async function clearAppCache() {
  // 清理前的体积作为「释放量」估值：clearCache 是异步删盘，事后立刻量大小不准
  const before = appCacheBytes();
  const ses = session.defaultSession;
  await ses.clearCache();
  try {
    await ses.clearCodeCaches({ urls: [] });
  } catch {
    // 个别 Electron 版本无此 API，HTTP 缓存已清即可
  }
  return before;
}

function resetWindowState() {
  fs.rmSync(path.join(userDataDir(), "window-state.json"), { force: true });
}

function resetMockData() {
  fs.rmSync(path.join(userDataDir(), "mock-assets"), {
    recursive: true,
    force: true,
  });
  ensureUserMockAssets(); // 重新种子化为内置默认规则
}

export function registerCleanupIpc() {
  // 返回各可清理项的当前体积，供弹窗展示
  ipcSafe("get-cleanup-info", () => ({
    info: {
      appCacheBytes: appCacheBytes(),
      mockAssetsBytes: mockAssetsBytes(),
    },
  }));

  // 按勾选执行清理；逐项捕获错误，单项失败不影响其余项
  ipcSafe("run-cleanup", async (_, { targets = [] } = {}) => {
    const set = new Set(Array.isArray(targets) ? targets : []);
    const results = {};
    let reclaimedBytes = 0;
    let needsRestart = false;

    if (set.has("appCache")) {
      try {
        const bytes = await clearAppCache();
        reclaimedBytes += bytes;
        results.appCache = { ok: true, reclaimedBytes: bytes };
      } catch (err) {
        results.appCache = { ok: false, error: err.message };
      }
    }

    if (set.has("windowState")) {
      try {
        resetWindowState();
        needsRestart = true;
        results.windowState = { ok: true };
      } catch (err) {
        results.windowState = { ok: false, error: err.message };
      }
    }

    if (set.has("mockData")) {
      try {
        resetMockData();
        needsRestart = true;
        results.mockData = { ok: true };
      } catch (err) {
        results.mockData = { ok: false, error: err.message };
      }
    }

    if (set.has("config")) {
      try {
        resetStore();
        needsRestart = true;
        results.config = { ok: true };
      } catch (err) {
        results.config = { ok: false, error: err.message };
      }
    }

    return { results, reclaimedBytes, needsRestart };
  });
}
