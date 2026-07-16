// Mock 服务相关 IPC：start/stop service、查询 routes/rules、保存 rules、
// 请求历史、录制、场景管理、用系统应用打开 rules JSON。

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { shell } from "electron";
import { ipcSafe } from "../ipc/safe.js";
import { getConfig } from "../config/store.js";
import { sendLog } from "../ui-channel.js";
import {
  buildRoutes,
  loadMockRules,
  loadOpenApiSources,
  normalizeMockRule,
  wrapSampleInEnvelope,
} from "./server.js";
import { mockFromSchema } from "./data.js";
import {
  MOCK_ID,
  ensureMockRulesDir,
  generateMockSpecs,
  getMockRouteMetas,
  normalizeRulesForSave,
  startSwaggerMock,
  stopMockService,
} from "./service.js";
import { clearMockHistory, getMockHistory } from "./history.js";
import {
  deleteScene,
  getRecordingStatus,
  listScenes,
  readSceneRules,
  sceneFilePath,
  startRecording,
  stopRecording,
  writeSceneRules,
} from "./recorder.js";

// 场景文件与 mock-rules.json 同目录，放 scenes/ 子目录下
function getScenesDir() {
  return path.join(path.dirname(getConfig().mockRulesFile), "scenes");
}

// 覆盖写活动规则文件；loadMockRules 的 mtime 缓存会自动感知，运行中的 mock 无需重启
function writeActiveRules(rules) {
  ensureMockRulesDir();
  fs.writeFileSync(
    getConfig().mockRulesFile,
    `${JSON.stringify(rules, null, 2)}\n`,
    "utf-8",
  );
}

// 路由匹配优先级：
//   1. method + fullPath 精确命中
//   2. method + openapiPath 命中（rule 里写的可能是带 {id} 的原始模板）
//   3. method 通配（*）情况下放宽到任意 method
//   4. regex 命中（rule path 是具体值 /foo/123 时回退）
function findRouteForPreview(routes, method, targetPath) {
  const lcMethod = method.toLowerCase();
  const methodMatch = (route) =>
    method === "*" || route.method === lcMethod;

  return (
    routes.find((r) => methodMatch(r) && r.fullPath === targetPath) ||
    routes.find((r) => methodMatch(r) && r.openapiPath === targetPath) ||
    routes.find((r) => methodMatch(r) && r.regex.test(targetPath)) ||
    null
  );
}

function runCurl(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(output || `curl exited with code ${code}`));
    });
  });
}

function getBackendUrl(baseUrl, requestPath, params = {}) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  const path = String(requestPath || "").trim();
  if (!base) throw new Error("未配置后端代理地址，请先在服务配置中填写");
  if (!/^https?:\/\//i.test(base)) throw new Error("后端代理地址必须以 http:// 或 https:// 开头");
  if (!path.startsWith("/")) throw new Error("path 必须以 / 开头");
  if (!params || Array.isArray(params) || typeof params !== "object") {
    throw new Error("Query Params 必须是对象");
  }
  const url = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item !== undefined && item !== null) url.searchParams.append(key, String(item));
    }
  }
  return url.toString();
}

function getRecommendedQueryParams(route) {
  return (route.operation.parameters || []).reduce((params, parameter) => {
    if (parameter?.in !== "query" || !parameter.name) return params;
    const example =
      parameter.example ??
      Object.values(parameter.examples || {})[0]?.value ??
      mockFromSchema(parameter.schema || {}, route.spec, {
        fieldName: parameter.name,
      });
    if (example !== undefined) params[parameter.name] = example;
    return params;
  }, {});
}

export function registerMockIpc() {
  ipcSafe("start-mock", async () => {
    const config = getConfig();
    await startSwaggerMock(MOCK_ID);
    return {
      url: `http://${config.mockHost || "127.0.0.1"}:${
        Number(config.mockPort || 3002)
      }`,
    };
  });

  ipcSafe("stop-mock", () => stopMockService(MOCK_ID));

  // 独立的「生成 OpenAPI JSON」操作：从 swagger 源服务器拉文档写入 mockSpecPath
  ipcSafe("generate-mock-spec", () => generateMockSpecs(MOCK_ID));

  ipcSafe("execute-mock-backend-curl", async (_, payload = {}) => {
    const method = String(payload.method || "GET").toUpperCase();
    const requestPath = String(payload.path || "").trim();
    const body = String(payload.body || "");
    const config = getConfig();
    const url = getBackendUrl(config.mockBackendBaseUrl, requestPath, payload.params);
    const args = ["--silent", "--show-error", "--max-time", "30", "-X", method, url];
    if (!["GET", "HEAD"].includes(method) && body) {
      JSON.parse(body);
      args.push("-H", "Content-Type: application/json", "--data-binary", body);
    }

    const vjToken = String(config.mockVjToken || "").trim();
    if (vjToken) {
      args.push("-H", `Authorization: ${vjToken}`);
      args.push("-H", `Cookie: VJTOKEN=${vjToken}`);
    }

    sendLog(MOCK_ID, `\x1b[35m▶ curl ${method} ${url}\x1b[0m\n`);
    try {
      const output = await runCurl(args);
      sendLog(MOCK_ID, `\x1b[32m✔ curl 完成\x1b[0m\n${output}\n`);
      return { output };
    } catch (err) {
      sendLog(MOCK_ID, `\x1b[31m✗ curl 失败: ${err.message}\x1b[0m\n`);
      throw err;
    }
  });

  ipcSafe(
    "get-mock-routes",
    async () => ({ routes: await getMockRouteMetas() }),
    { routes: [] },
  );

  ipcSafe(
    "get-mock-rules",
    () => {
      const config = getConfig();
      return {
        rules: loadMockRules(config.mockRulesFile),
        file: config.mockRulesFile,
      };
    },
    { rules: [] },
  );

  ipcSafe("save-mock-rules", (_, payload = {}) => {
    const rules = normalizeRulesForSave(payload.rules || []);
    writeActiveRules(rules);
    return { rules, file: getConfig().mockRulesFile };
  });

  // ── 录制 ────────────────────────────────────────────────────────────────────

  ipcSafe("get-mock-recording", () => ({ recording: getRecordingStatus() }));

  ipcSafe("start-mock-recording", (_, payload = {}) => ({
    recording: startRecording({
      sceneName: payload.name,
      scenesDir: getScenesDir(),
    }),
  }));

  ipcSafe("stop-mock-recording", () => stopRecording());

  // ── 场景 ────────────────────────────────────────────────────────────────────

  ipcSafe("list-mock-scenes", () => ({ scenes: listScenes(getScenesDir()) }), {
    scenes: [],
  });

  // 把当前活动规则存为命名场景（快照）
  ipcSafe("save-mock-scene", (_, payload = {}) => {
    const rules = loadMockRules(getConfig().mockRulesFile);
    const name = writeSceneRules(getScenesDir(), payload.name, rules);
    return { name, count: rules.length };
  });

  // 应用场景：用场景内容覆盖活动规则文件
  ipcSafe("apply-mock-scene", (_, payload = {}) => {
    const rules = normalizeRulesForSave(
      readSceneRules(getScenesDir(), payload.name),
    );
    writeActiveRules(rules);
    return { rules };
  });

  ipcSafe("delete-mock-scene", (_, payload = {}) => {
    deleteScene(getScenesDir(), payload.name);
  });

  // 读场景规则：mock 配置页进入「场景编辑模式」时加载，不影响活动规则
  ipcSafe(
    "get-mock-scene-rules",
    (_, payload = {}) => ({
      rules: readSceneRules(getScenesDir(), payload.name).map(normalizeMockRule),
      file: sceneFilePath(getScenesDir(), payload.name),
    }),
    { rules: [] },
  );

  // 覆盖写场景规则：场景编辑模式下的保存目标是场景文件本身
  ipcSafe("save-mock-scene-rules", (_, payload = {}) => {
    const recording = getRecordingStatus();
    if (recording.enabled && recording.sceneName === payload.name) {
      throw new Error(
        `场景「${payload.name}」正在录制中，请先停止录制再编辑`,
      );
    }
    const rules = normalizeRulesForSave(payload.rules || []);
    const name = writeSceneRules(getScenesDir(), payload.name, rules);
    return { rules, name, file: sceneFilePath(getScenesDir(), name) };
  });

  // 根据 OpenAPI schema 推荐一份 mock JSON（不写盘，仅返回供用户复制）。
  // 入参 { method, path }：path 必须是接入了 service prefix 的完整 path
  // （和列表里展示的一致，例如 /vjg/ads/actions/click）。
  ipcSafe("preview-mock-response", async (_, payload = {}) => {
    const method = String(payload.method || "*").toUpperCase();
    const targetPath = String(payload.path || "").trim();
    if (!targetPath) throw new Error("path 不能为空");

    const config = getConfig();
    if (!config.mockSpecPath) {
      throw new Error("Mock spec 路径未配置，请到设置中填写");
    }

    const sources = await loadOpenApiSources(config.mockSpecPath);
    const allRoutes = sources.flatMap(({ spec, sourcePath }) =>
      buildRoutes(spec, sourcePath, config.mockServiceAddress || ""),
    );

    const route = findRouteForPreview(allRoutes, method, targetPath);
    if (!route) {
      throw new Error(`未在 swagger 中找到 ${method} ${targetPath}`);
    }

    const responses = route.operation.responses || {};
    const responseKey =
      Object.keys(responses).find((key) => /^2\d\d$/.test(key)) ||
      Object.keys(responses).find((key) => key !== "default") ||
      "default";
    const definition = responses[responseKey] || responses.default;
    if (!definition) {
      throw new Error("该接口的 swagger 中没有任何 response 定义");
    }

    const content = definition.content || {};
    const contentType =
      Object.keys(content).find((type) => type.includes("json")) ||
      Object.keys(content)[0];
    const schema = contentType ? content[contentType]?.schema : null;
    if (!schema) {
      throw new Error(
        `swagger 中 ${responseKey} 响应缺少 schema，无法生成推荐数据`,
      );
    }

    const sample = mockFromSchema(schema, route.spec, {});
    // 推荐数据返回完整响应体（含 code/rc/message/data 信封），用户直接编辑整份 JSON。
    const json = contentType.includes("json")
      ? wrapSampleInEnvelope(sample, definition, responseKey)
      : sample;
    return {
      json,
      queryParams: getRecommendedQueryParams(route),
      method: route.method.toUpperCase(),
      path: route.fullPath,
      status: responseKey,
      operationId: route.operation.operationId || null,
      summary: route.operation.summary || route.operation.description || "",
      source: route.sourceName,
    };
  });

  // 请求历史：窗口刷新 / 面板首次打开时全量拉取；增量靠 mock-request 事件推送
  ipcSafe("get-mock-history", () => ({ entries: getMockHistory() }), {
    entries: [],
  });

  ipcSafe("clear-mock-history", () => {
    clearMockHistory();
  });

  // 用系统默认应用打开 mock-rules.json（方便直接用编辑器改）；
  // 传 { scene } 时打开对应场景文件
  ipcSafe("open-mock-rules-file", async (_, payload = {}) => {
    let file;
    if (payload.scene) {
      file = sceneFilePath(getScenesDir(), payload.scene);
      if (!fs.existsSync(file)) {
        throw new Error(`场景文件不存在: ${file}`);
      }
    } else {
      const config = getConfig();
      ensureMockRulesDir();
      if (!fs.existsSync(config.mockRulesFile)) {
        fs.writeFileSync(config.mockRulesFile, "[]\n");
      }
      file = config.mockRulesFile;
    }
    // shell.openPath 失败返回非空错误字符串
    const err = await shell.openPath(file);
    if (err) throw new Error(err);
    return { file };
  });
}
