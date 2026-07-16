// AI 引擎（Ollama）相关 IPC：服务启停、状态查询、模型下载。

import { ipcSafe } from "./safe.js";
import { sendToAllWindows } from "../ui-channel.js";
import {
  isServerUp,
  startServer,
  listModels,
  pullModel,
  systemOllamaPresent,
  stopOwnServer,
  killAllOllama,
} from "../ai/ollama.js";
import { isInstalled } from "../ai/ollama-install.js";

export function registerAiIpc() {
  ipcSafe("get-ollama-status", async () => {
    const running = await isServerUp();
    const installed = await isInstalled();
    const sysPresent = systemOllamaPresent();
    let modelsList = [];
    if (running) {
      try {
        modelsList = await listModels();
      } catch (_err) {
        // 忽略
      }
    }
    return {
      running,
      installed: installed || sysPresent,
      modelsList
    };
  });

  ipcSafe("start-ollama-service", async () => {
    const running = await isServerUp();
    if (running) {
      return { success: true, already: true };
    }

    try {
      await startServer((progress) => {
        sendToAllWindows("ollama-progress", progress);
      });
      return { success: true, already: false };
    } catch (e) {
      throw new Error(e.message || String(e), { cause: e });
    }
  });

  ipcSafe("stop-ollama-service", async () => {
    stopOwnServer();
    killAllOllama();
    return { success: true };
  });

  ipcSafe("pull-ollama-model", async (_, payload = {}) => {
    const { modelName } = payload;
    if (!modelName) throw new Error("模型名称不能为空");
    try {
      await pullModel(modelName, (p) => {
        sendToAllWindows("ollama-progress", { phase: "model-download", percent: p.percent, status: p.status, model: p.model });
      });
      return { success: true };
    } catch (e) {
      throw new Error(e.message || String(e), { cause: e });
    }
  });
}
