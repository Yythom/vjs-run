// 主进程入口：只做生命周期编排，所有业务逻辑分布在 config/ services/ ipc/ 三个子目录。
//
// 启动顺序：
//   1. 全局进程异常兜底
//   2. 注册全局右键菜单（独立模块，只跑一次）
//   3. 注册所有 IPC handler（依赖 config，但 store 还没初始化也 OK——
//      handler 真正被调用时才会通过 getConfig() 读，那时已 ready）
//   4. app.whenReady：
//      a) ensureUserMockAssets：把内置 mock 资源种子复制到 userData 可写目录
//      b) initStore：electron-store 加载 userData/config.json
//      c) createWindow：开窗 + ready-to-show 消白屏
//      d) 后台预热 shell-env（避免首次启动项目卡 1-3s）
//   5. window-all-closed / before-quit：清子进程

import { BrowserWindow, app, dialog, nativeImage } from "electron";
import { DEFAULT_CONFIG } from "./config/defaults.js";
import { APP_ICON_PATH } from "./paths.js";
import { initStore } from "./config/store.js";
import { ensureUserMockAssets } from "./mock/user-assets.js";
import { registerContextMenu } from "./services/context-menu.js";
import { createWindow } from "./services/window.js";
import { MOCK_ID, stopMockService } from "./mock/service.js";
import { registerAllIpc } from "./ipc/index.js";
import { buildSpawnEnv } from "./shell-env.js";
import { stopAllProcesses } from "./process-manager.js";

// ─── 全局兜底 ────────────────────────────────────────────────────────────────
// 任何异步路径上未处理的错误都不要让 main 进程整体崩掉。
// 仅打印日志即可——renderer 端那些 IPC 失败已经各自有提示。
process.on("uncaughtException", (err) =>
  console.error("[uncaughtException]", err),
);
process.on("unhandledRejection", (reason) =>
  console.error("[unhandledRejection]", reason),
);

// ─── 启动前注册 ──────────────────────────────────────────────────────────────
// contextMenu 和 IPC handler 都是「注册式」API：只挂监听，被触发时才执行，
// 此时 store 已经初始化好（IPC 触发必在 whenReady 之后，因为窗口要先出来）。
registerContextMenu();
registerAllIpc();

// ─── 应用生命周期 ─────────────────────────────────────────────────────────────

app
  .whenReady()
  .then(() => {
    // dev 下 dock 图标取自 build/icon.png；打包后由 electron-builder 写入 .app 包，不需要这里设置
    if (process.platform === "darwin" && !app.isPackaged && app.dock) {
      try {
        const img = nativeImage.createFromPath(APP_ICON_PATH);
        if (!img.isEmpty()) app.dock.setIcon(img);
      } catch (err) {
        console.error("[dock.setIcon]", err);
      }
    }

    // a) 把 mock-rules.json / mock-data 安置到 userData 可写目录，然后覆盖
    //    DEFAULT_CONFIG 的对应字段（normalizeConfig 永远取 DEFAULT_CONFIG 的这两个字段，
    //    所以这里改完旧 config.json 里的过时路径会被自动纠正）
    try {
      const { rulesFile, dataDir } = ensureUserMockAssets();
      DEFAULT_CONFIG.mockRulesFile = rulesFile;
      DEFAULT_CONFIG.mockDataDir = dataDir;
    } catch (err) {
      // userData 不可写之类的故障：保留默认路径继续启动，给用户一个可见提示
      dialog.showErrorBox(
        "Mock 资源初始化失败",
        `无法在 userData 目录创建 mock-assets：\n${err.message}\n\n应用将继续启动，但 mock 规则的保存可能失败。`,
      );
    }

    // b) electron-store 构造必须在 app.whenReady 之后（内部要读 userData 路径）
    try {
      initStore();
    } catch (err) {
      console.error("[initStore]", err);
    }

    // c) 创建主窗口
    try {
      createWindow();
    } catch (err) {
      dialog.showErrorBox("窗口创建失败", err.message || String(err));
      app.quit();
    }

    // d) 预热 shell-env：buildSpawnEnv 第一次调用要跑 `zsh -ilc 'env -0'`，
    //    重 zshrc（nvm/oh-my-zsh/p10k 等）能耗时 1-3 秒，会让用户「第一次点 ▶ 启动」明显卡顿。
    //    setImmediate 让出当前 tick，先把窗口画出来再去执行 execSync。
    setImmediate(() => {
      try {
        buildSpawnEnv();
      } catch (err) {
        console.error("[shell-env prewarm]", err);
      }
    });
  })
  .catch((err) => {
    dialog.showErrorBox("启动失败", err?.message || String(err));
    app.quit();
  });

// 所有窗口关闭时：非 macOS 直接退出；macOS 保留进程（Dock 点击可重新打开）
app.on("window-all-closed", () => {
  stopAllProcesses();
  // stopMockService 返回 Promise，必须捕获 reject 避免 unhandledRejection 在退出时冒出来
  stopMockService(MOCK_ID).catch((err) => console.error("[stopMock]", err));
  if (process.platform !== "darwin") app.quit();
});

// macOS：点击 Dock 图标且无窗口时，重新创建窗口
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// 应用退出前确保所有子进程都被终止，避免孤儿进程
app.on("before-quit", () => {
  stopAllProcesses();
  stopMockService(MOCK_ID).catch((err) => console.error("[stopMock]", err));
});
