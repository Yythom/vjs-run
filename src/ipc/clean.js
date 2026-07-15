// 清理 monorepo IPC：clean-monorepo（仅清理）、reinstall-monorepo（清理 + pnpm install）

import { ipcSafe } from "./safe.js";
import { getRepoRuntime } from "../config/lookup.js";
import {
  runCleanSequence,
  withCleanLogging,
  abortCleanSequence,
} from "../services/clean-monorepo.js";

export function registerCleanIpc() {
  ipcSafe("clean-monorepo", (_, payload = {}) =>
    withCleanLogging(() => runCleanSequence(getRepoRuntime(payload.repoKey))),
  );

  ipcSafe("reinstall-monorepo", (_, payload = {}) =>
    withCleanLogging(() =>
      runCleanSequence(getRepoRuntime(payload.repoKey), { withInstall: true }),
    ),
  );

  // 终止进行中的清理 / 重装
  ipcSafe("stop-clean-monorepo", () => abortCleanSequence());
}
