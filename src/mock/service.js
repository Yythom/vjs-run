// Mock 服务：启停（转给后台进程客户端）/ 生成 OpenAPI JSON / 路由与规则查询。
//
// mock 不再跑在 Electron 主进程里，而是一个独立的后台进程（与 vjtools mock start 同一个），
// 启停、接上已在跑的、断线重连都在 daemon-client.js。这里保留原来的导出名，调用方不用改。

import fs from "node:fs";
import path from "node:path";
import { sendLog } from "../ui-channel.js";
import { buildRoutes, loadOpenApiSources, routeToMeta } from "./server.js";
import { getConfig } from "../config/store.js";
import { generateSwaggerSpecs } from "./generate-spec.js";
import { MOCK_ID, isMockRunning, startMock, stopMock } from "./daemon-client.js";

export {
  MOCK_ID,
  attachIfRunning,
  clearMockHistory,
  detachMock,
  fetchMockHistory,
  isMockRunning,
  refreshMockStatus,
} from "./daemon-client.js";

export async function startSwaggerMock() {
  await startMock();
}

export async function stopMockService() {
  await stopMock();
}

// 独立操作：从 swagger 源服务器生成 OpenAPI JSON 到 mockSpecPath 目录。
// 由 UI 上的「生成 OpenAPI JSON」按钮显式触发，不再挂在 mock 启动流程里。
// mock 运行中也可执行——server.js 的 chokidar watcher 会感知文件变化自动热载路由。
export async function generateMockSpecs(projectId = MOCK_ID) {
  const config = getConfig();
  const swaggerServer = (config.mockSwaggerServer || "").trim();
  const specPath = config.mockSpecPath;

  if (!swaggerServer) {
    throw new Error("未配置 Swagger 源服务器地址，请到设置中填写");
  }
  if (!specPath) {
    throw new Error("Mock spec 目录未配置，请到设置中填写");
  }
  if (/\.(json|ya?ml)$/i.test(specPath)) {
    throw new Error("mockSpecPath 必须是目录，当前配置指向单个文件");
  }

  const startMsg = `▶ 从 ${swaggerServer} 生成 OpenAPI JSON (输出目录: ${specPath})`;
  console.log(startMsg);
  sendLog(projectId, `\x1b[35m▶ 从 ${swaggerServer} 生成 OpenAPI JSON\x1b[0m\n`);
  sendLog(projectId, `\x1b[2m输出目录: ${specPath}\x1b[0m\n`);

  try {
    const { generated, failed } = await generateSwaggerSpecs({
      serverUrl: swaggerServer,
      outputDir: specPath,
      onLog: (message) => {
        console.log(`[Generate Spec] ${message}`);
        sendLog(projectId, `\x1b[2m${message}\x1b[0m\n`);
      },
    });
    const doneMsg = `✔ OpenAPI JSON 生成完成: ${generated.join(", ")}` +
      (failed.length ? ` (失败: ${failed.map((f) => f.type).join(", ")})` : "");
    console.log(doneMsg);
    sendLog(
      projectId,
      `\x1b[32m✔ OpenAPI JSON 生成完成: ${generated.join(", ")}\x1b[0m` +
        (failed.length
          ? ` \x1b[33m(失败: ${failed.map((f) => f.type).join(", ")})\x1b[0m`
          : "") +
        "\n" +
        (isMockRunning()
          ? `\x1b[2mmock 运行中，路由将自动热更新\x1b[0m\n`
          : ""),
    );
    return { generated, failed };
  } catch (err) {
    const failMsg = `✗ OpenAPI JSON 生成失败: ${err.message}`;
    console.error(failMsg, err);
    sendLog(projectId, `\x1b[31m✗ OpenAPI JSON 生成失败: ${err.message}\x1b[0m\n`);
    throw err;
  }
}

export async function getMockRouteMetas() {
  const config = getConfig();
  const sources = await loadOpenApiSources(config.mockSpecPath);
  return sources
    .flatMap(({ spec, sourcePath }) =>
      buildRoutes(spec, sourcePath, config.mockServiceAddress || ""),
    )
    .map(routeToMeta);
}

export function ensureMockRulesDir() {
  const config = getConfig();
  const rulesDir = path.dirname(config.mockRulesFile);
  if (!fs.existsSync(rulesDir)) {
    fs.mkdirSync(rulesDir, { recursive: true });
  }
}

// 规则保存校验的实现在 rules.js（与 vjtools CLI 共用），这里保留导出，调用方不用改
export { normalizeRulesForSave } from "./rules.js";
