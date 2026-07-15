// 全局右键菜单：仅在 TitleBar 区域（顶部 40px，h-10）触发，给开发者菜单。
// 其他区域右键沿用 Electron 默认行为（input/textarea 仍有标准的 cut/copy/paste/spell-check）。

import { app, dialog } from "electron";
import contextMenu from "electron-context-menu";

const TITLEBAR_HEIGHT = 40;

export function registerContextMenu() {
  contextMenu({
    // params.y 是相对 webContents 的纵坐标；≤ 40 即落在 TitleBar 范围内
    shouldShowMenu: (_event, params) =>
      params.y >= 0 && params.y <= TITLEBAR_HEIGHT,
    // 关掉所有默认条目，完全用下方 menu 自定义（不然 Copy/Paste 等会一起出现）
    showCopyImage: false,
    showCopyImageAddress: false,
    showCopyLink: false,
    showCopyVideoAddress: false,
    showSaveImage: false,
    showSaveImageAs: false,
    showSaveLinkAs: false,
    showSaveVideo: false,
    showSaveVideoAs: false,
    showSearchWithGoogle: false,
    showSelectAll: false,
    showInspectElement: false,
    showServices: false,
    showLookUpSelection: false,
    menu: (_defaultActions, _params, browserWindow) => [
      {
        label: "刷新",
        accelerator: "CmdOrCtrl+R",
        click: () => browserWindow?.webContents.reload(),
      },
      {
        label: "强制刷新（忽略缓存）",
        accelerator: "Shift+CmdOrCtrl+R",
        click: () => browserWindow?.webContents.reloadIgnoringCache(),
      },
      { type: "separator" },
      {
        label: "切换开发者工具",
        accelerator: "Alt+CmdOrCtrl+I",
        click: () => browserWindow?.webContents.toggleDevTools(),
      },
      { type: "separator" },
      {
        label: `关于 ${app.getName()}`,
        click: () => {
          dialog.showMessageBox(browserWindow, {
            type: "info",
            message: app.getName(),
            detail: [
              `Version  ${app.getVersion()}`,
              `Electron ${process.versions.electron}`,
              `Chromium ${process.versions.chrome}`,
              `Node     ${process.versions.node}`,
            ].join("\n"),
            buttons: ["确定"],
          });
        },
      },
    ],
  });
}
