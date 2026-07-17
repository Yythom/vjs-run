// Mock 服务生命周期：startSwaggerMock / stopMockService / 路由与规则查询。
// 内部维持单例 runningMockService 状态。

import fs from "node:fs";
import path from "node:path";
import { sendLog, sendStatus } from "../ui-channel.js";
import { killPort } from "../port-utils.js";
import {
  buildRoutes,
  loadOpenApiSources,
  normalizeMockRule,
  routeToMeta,
  startMockServer,
} from "./server.js";
import { getConfig } from "../config/store.js";
import { recordMockRequest } from "./history.js";
import { handleRecordedEntry } from "./recorder.js";
import { generateSwaggerSpecs } from "./generate-spec.js";

export const MOCK_ID = "__mock__";

let runningMockService = null;

export function isMockRunning() {
  return !!runningMockService;
}

export function stopMockService(projectId = MOCK_ID) {
  return new Promise((resolve) => {
    const service = runningMockService;
    if (!service?.server && !service?.process) {
      sendStatus(projectId, "stopped");
      resolve();
      return;
    }

    runningMockService = null;
    for (const watcher of service.watchers || []) {
      try {
        // chokidar.close() 返回 Promise；不 await 没关系，加 .catch 防 unhandledRejection
        const ret = watcher.close();
        if (ret && typeof ret.catch === "function") ret.catch(() => {});
      } catch (_) {}
    }
    if (service.process) {
      try {
        process.kill(-service.process.pid, "SIGTERM");
      } catch (_) {
        try {
          service.process.kill("SIGTERM");
        } catch (__) {}
      }
      sendLog(projectId, `\x1b[32m✔ Swagger Mock 已停止\x1b[0m\n`);
      sendStatus(projectId, "stopped");
      resolve();
      return;
    }

    service.server.close((err) => {
      if (err) {
        sendLog(
          projectId,
          `\x1b[31m✗ Swagger Mock 停止失败: ${err.message}\x1b[0m\n`,
        );
        sendStatus(projectId, "error");
      } else {
        sendLog(projectId, `\x1b[32m✔ Swagger Mock 已停止\x1b[0m\n`);
        sendStatus(projectId, "stopped");
      }
      resolve();
    });
  });
}

export async function startSwaggerMock(projectId = MOCK_ID) {
  const config = getConfig();
  sendStatus(projectId, "starting");

  const specPath = config.mockSpecPath;
  const host = config.mockHost || "127.0.0.1";
  const port = Number(config.mockPort || 3002);
  const serviceAddress = config.mockServiceAddress || "";
  const mockOptions = {
    mockDataDir: config.mockDataDir,
    mockRulesFile: config.mockRulesFile,
    backendBaseUrl: config.mockBackendBaseUrl,
    mockAll: config.mockAll,
    onLog: (message) => sendLog(projectId, `\x1b[2m${message}\x1b[0m\n`),
    // 每条请求记录：入历史缓冲 + （录制中时）固化为场景规则
    onRecord: (entry) => {
      recordMockRequest(entry);
      handleRecordedEntry(entry);
    },
  };

  try {
    if (!specPath) throw new Error("Mock spec 路径未配置，请到设置中填写");

    sendLog(projectId, `\x1b[36m① 释放 Mock 端口 ${port}\x1b[0m\n`);
    await killPort(port);

    await stopMockService(projectId);
    sendStatus(projectId, "starting");
    sendLog(projectId, `\x1b[2mSpec: ${specPath}\x1b[0m\n`);
    sendLog(projectId, `\x1b[2mURL : http://${host}:${port}\x1b[0m\n`);
    if (serviceAddress) {
      sendLog(projectId, `\x1b[2mService address: ${serviceAddress}\x1b[0m\n`);
    }
    if (mockOptions.backendBaseUrl) {
      sendLog(projectId, `\x1b[2mBackend: ${mockOptions.backendBaseUrl}\x1b[0m\n`);
    }
    sendLog(projectId, `\x1b[2mMock data: ${mockOptions.mockDataDir}\x1b[0m\n`);
    sendLog(projectId, `\x1b[2mMock rules: ${mockOptions.mockRulesFile}\x1b[0m\n`);

    sendLog(projectId, `\x1b[36m② 启动内置 Swagger Mock\x1b[0m\n`);
    runningMockService = await startMockServer({
      specPath,
      host,
      port,
      serviceAddress,
      ...mockOptions,
    });

    sendLog(
      projectId,
      `\x1b[32m✔ Swagger Mock 已启动: http://${host}:${port}\x1b[0m\n` +
        `\x1b[36mHealth: http://${host}:${port}/__mock/health\x1b[0m\n` +
        `\x1b[36mRoutes: ${runningMockService.routes.length} route(s), ${runningMockService.sources.length} file(s)\x1b[0m\n`,
    );
    sendStatus(projectId, "running");
  } catch (err) {
    runningMockService = null;
    sendLog(projectId, `\x1b[31m✗ Swagger Mock 启动失败: ${err.message}\x1b[0m\n`);
    sendStatus(projectId, "error");
    throw err;
  }
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

export function normalizeRulesForSave(rules = []) {
  if (!Array.isArray(rules)) {
    throw new Error("Mock rules 必须是数组");
  }

  return rules.map((rule, index) => {
    const normalized = normalizeMockRule(rule);
    if (!normalized.path) {
      throw new Error(`第 ${index + 1} 条规则缺少 path`);
    }
    const status =
      normalized.status !== undefined && normalized.status !== ""
        ? Number(normalized.status)
        : undefined;
    if (status !== undefined && !Number.isInteger(status)) {
      throw new Error(`第 ${index + 1} 条规则的 status 必须是整数`);
    }
    const delay =
      normalized.delay !== undefined && normalized.delay !== ""
        ? Number(normalized.delay)
        : undefined;
    if (delay !== undefined && (!Number.isInteger(delay) || delay < 0)) {
      throw new Error(`第 ${index + 1} 条规则的 delay 必须是大于等于 0 的整数`);
    }
    return {
      enabled: normalized.enabled !== false,
      method: (normalized.method || "*").toUpperCase(),
      path: normalized.path,
      ...(status !== undefined ? { status } : {}),
      ...(delay !== undefined ? { delay } : {}),
      ...(normalized.response !== undefined ? { response: normalized.response } : {}),
    };
  });
}
