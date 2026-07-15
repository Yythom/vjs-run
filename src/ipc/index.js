// 所有 IPC 注册的统一入口。main.js 启动期只调一次 registerAllIpc()。
// 拆按业务域：config / project / mock / clean / diagnostics。

import { registerConfigIpc } from "./config.js";
import { registerProjectIpc } from "./project.js";
import { registerMockIpc } from "../mock/ipc.js";
import { registerCleanIpc } from "./clean.js";
import { registerDiagnosticsIpc } from "./diagnostics.js";
import { registerCleanupIpc } from "./cleanup.js";

export function registerAllIpc() {
  registerConfigIpc();
  registerProjectIpc();
  registerMockIpc();
  registerCleanIpc();
  registerDiagnosticsIpc();
  registerCleanupIpc();
}
