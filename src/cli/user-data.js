// vjtools CLI 的数据目录。必须与 app 的 app.getPath("userData") 完全一致：
// 两边共用 config.json、mock 规则、场景，只装 CLI 的用户以后装了 app 也能直接接上。
//
// Electron 的 userData = appData/<productName>，按平台分别是：
//   macOS   ~/Library/Application Support/vjtools
//   Windows %APPDATA%\vjtools
//   Linux   $XDG_CONFIG_HOME/vjtools（缺省 ~/.config/vjtools）
// VJTOOLS_USER_DATA_DIR 优先（e2e / 隔离环境，和 main.js 的约定一致）。

import os from "node:os";
import path from "node:path";

const APP_NAME = "vjtools";

function defaultUserDataDir() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", APP_NAME);
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), APP_NAME);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), APP_NAME);
}

export function resolveUserDataDir() {
  return process.env.VJTOOLS_USER_DATA_DIR
    ? path.resolve(process.env.VJTOOLS_USER_DATA_DIR)
    : defaultUserDataDir();
}

export function cliPaths(userDataDir = resolveUserDataDir()) {
  const mockAssetsDir = path.join(userDataDir, "mock-assets");
  return {
    userDataDir,
    configFile: path.join(userDataDir, "config.json"),
    mockAssetsDir,
    rulesFile: path.join(mockAssetsDir, "mock-rules.json"),
    dataDir: path.join(mockAssetsDir, "mock-data"),
    // 只装 CLI 的用户没有设置页，spec 目录默认放这里，不用操心路径
    defaultSpecDir: path.join(userDataDir, "mock-specs"),
    logFile: path.join(userDataDir, "logs", "mock-cli.log"),
  };
}
