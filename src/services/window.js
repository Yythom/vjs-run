// 主窗口创建：window-state-keeper 记忆位置/尺寸 + ready-to-show 消白屏 + 5s 兜底 show

import { BrowserWindow, app } from "electron";
import windowStateKeeper from "electron-window-state";
import * as uiChannel from "../ui-channel.js";
import { stopAllProcesses } from "../process-manager.js";
import { PRELOAD_PATH, RENDERER_INDEX_HTML } from "../paths.js";

import { pathToFileURL } from "node:url";

const isDev = !app.isPackaged;
const useViteRenderer = isDev && process.env.VJTOOLS_RENDERER_DEV === "1";

export function createWindow() {
  // 上次关闭时的位置/尺寸，文件落在 userData/window-state.json
  const windowState = windowStateKeeper({
    defaultWidth: 1100,
    defaultHeight: 800,
  });

  const mainWindow = new BrowserWindow({
    x: windowState.x,
    y: windowState.y,
    width: windowState.width,
    height: windowState.height,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#ffffff",
    // show:false + ready-to-show 是 Electron 官方消白屏方案
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: PRELOAD_PATH,
    },
  });

  // 自动监听 resize/move/close 事件并写盘，无需手动 .save()
  windowState.manage(mainWindow);

  uiChannel.setMainWindow(mainWindow);

  mainWindow.once("ready-to-show", () => mainWindow.show());
  // 极端情况兜底：renderer 死循环 / 加载卡死时 ready-to-show 不触发，
  // 5 秒后强制 show 让用户至少能看到窗口
  setTimeout(() => {
    if (!mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  }, 5000);

  if (useViteRenderer) {
    mainWindow.loadURL("http://localhost:5100");
  } else {
    mainWindow.loadFile(RENDERER_INDEX_HTML);
  }

  mainWindow.on("closed", () => {
    uiChannel.removeWindow(mainWindow);
    stopAllProcesses();
  });

  return mainWindow;
}

export function createSecondaryWindow(route) {
  const subWindow = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 700,
    minHeight: 500,
    title: "终端日志控制台",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#ffffff",
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: PRELOAD_PATH,
    },
  });

  uiChannel.addWindow(subWindow);

  subWindow.once("ready-to-show", () => subWindow.show());

  // 兜底 show
  setTimeout(() => {
    if (!subWindow.isDestroyed() && !subWindow.isVisible()) {
      subWindow.show();
    }
  }, 5000);

  const suffix = route.includes("?") ? "&window=sub" : "?window=sub";
  if (useViteRenderer) {
    subWindow.loadURL(`http://localhost:5100#${route}${suffix}`);
  } else {
    const fileUrl = pathToFileURL(RENDERER_INDEX_HTML).href + `#${route}${suffix}`;
    subWindow.loadURL(fileUrl);
  }

  subWindow.on("closed", () => {
    uiChannel.removeWindow(subWindow);
  });

  return subWindow;
}
