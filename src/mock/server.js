import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import cors from "cors";
import chokidar from "chokidar";
import { parse as parseCookie } from "cookie";
import { mockFromSchema, tunePayloadForRequest } from "./data.js";
import { normalizeVariantLoose, selectVariant } from "./variant-match.js";
import { normalizeBackendBaseUrl } from "../url-utils.js";

const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
]);
const DEFAULT_MOCK_DATA_DIR = "./mock-data";
const DEFAULT_MOCK_RULES_FILE = "./mock-rules.json";
const corsMiddleware = cors({
  origin: true,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
  allowedHeaders: [
    "content-type",
    "Mgmtauth",
    "x-requested-with",
    "x-mock-code",
    "x-mock-status",
    "x-mock-delay",
    "x-mock-empty",
  ],
  exposedHeaders: ["x-backend-reqid", "X-Request-Id", "x-mock-proxy"],
  optionsSuccessStatus: 204,
});

async function startMockServer({
  specPath,
  host = "127.0.0.1",
  port = 3002,
  serviceAddress = "",
  mockDataDir = "",
  mockRulesFile = "",
  backendBaseUrl = "",
  mockAll = false,
  delay = 0,
  forcedStatus,
  onLog,
  onRecord,
}) {
  const state = await loadMockState(specPath, serviceAddress);
  const { routes, sources } = state;

  if (routes.length === 0) {
    throw new Error("No mockable routes found in the OpenAPI document.");
  }

  const watchers = watchOpenApiSources(specPath, state, serviceAddress);

  const server = createMockServer({
    state,
    host,
    port,
    delay,
    forcedStatus,
    config: {
      mockDataDir,
      mockRulesFile,
      backendBaseUrl: normalizeBackendBaseUrl(backendBaseUrl),
      mockAll,
      onLog,
      onRecord,
    },
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    server,
    sources,
    routes,
    watchers,
    host,
    port,
  };
}

function createMockServer({
  state,
  host,
  port,
  delay = 0,
  forcedStatus,
  config = {},
}) {
  const runtimeState = state;
  const runtimeConfig = {
    mockDataDir: DEFAULT_MOCK_DATA_DIR,
    mockRulesFile: DEFAULT_MOCK_RULES_FILE,
    backendBaseUrl: "",
    mockAll: false,
    onLog: null,
    onRecord: null,
    ...config,
  };
  // 历史记录是旁路能力，回调抛错不能影响请求处理
  const record = (entry) => {
    try {
      runtimeConfig.onRecord?.(entry);
    } catch {}
  };

  return http.createServer(async (req, res) => {
    try {
      await runMiddleware(req, res, corsMiddleware);

      if (res.writableEnded) {
        return;
      }

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const requestUrl = new URL(
        req.url || "/",
        `http://${req.headers.host || `${host}:${port}`}`,
      );
      const requestStart = Date.now();
      const currentSources = runtimeState.sources;
      const currentRoutes = runtimeState.routes;

      if (requestUrl.pathname === "/__mock/routes") {
        sendJsonPretty(res, 200, currentRoutes.map(routeToMeta));
        return;
      }

      if (requestUrl.pathname === "/__mock/rules") {
        sendJsonPretty(res, 200, loadMockRules(runtimeConfig.mockRulesFile));
        return;
      }

      if (requestUrl.pathname === "/__mock/search") {
        const q = requestUrl.searchParams.get("q") || "";
        sendJsonPretty(res, 200, searchRoutes(currentRoutes, q));
        return;
      }

      if (requestUrl.pathname === "/__mock/ui") {
        sendHtml(res, 200, renderMockUi());
        return;
      }

      if (requestUrl.pathname === "/__mock/health") {
        sendJsonPretty(res, 200, {
          ok: true,
          files: currentSources.length,
          routes: currentRoutes.length,
          mockDataDir: runtimeConfig.mockDataDir || null,
          mockRulesFile: runtimeConfig.mockRulesFile || null,
          backendBaseUrl: runtimeConfig.backendBaseUrl || null,
          mockAll: runtimeConfig.mockAll,
          titles: currentSources
            .map((source) => source.spec.info?.title)
            .filter(Boolean),
        });
        return;
      }

      const route = findRoute(
        currentRoutes,
        req.method || "GET",
        requestUrl.pathname,
      );
      if (!route) {
        // swagger 之外的路径也允许被自定义 rule 命中（请求历史「MISS→生成规则」、
        // 录制的 backend-only 接口都落在这里）。没有 swagger 定义可参考，
        // 只认带 response 的规则：status 用规则自带的（默认 200），payload 原样返回。
        const customRule = findMockRule(
          runtimeConfig.mockRulesFile,
          req.method || "GET",
          requestUrl.pathname,
        );
        // 变体判定需要 body，一旦读过流就被消费，之后转发必须补传 rawBody
        let consumedRawBody;
        if (
          customRule &&
          (customRule.response !== undefined || customRule.variants?.length)
        ) {
          const rawBody = await readRawBody(req);
          consumedRawBody = rawBody;
          const body = parseRequestBody(rawBody);
          const variant = selectVariant(customRule, {
            query: Object.fromEntries(requestUrl.searchParams.entries()),
            headers: req.headers,
            body,
          });
          // 只有变体、都没命中、又无顶层 response：与今天一样不认此规则，落回 proxy/404
          const effectiveResponse = variant ? variant.response : customRule.response;
          if (effectiveResponse !== undefined) {
            const ruleDelay = variant?.delay ?? customRule.delay;
            const requestControls = getRequestControls(req, requestUrl, {
              delay: typeof ruleDelay === "number" ? ruleDelay : delay,
              forcedStatus,
            });
            await sleep(requestControls.delay);
            const status = Number(variant?.status ?? customRule.status) || 200;
            const responseText = sendJson(res, status, effectiveResponse);
            const mockSource = variant ? "rule-variant" : "rule-custom";
            logRequest(
              `MOCK:${mockSource}`,
              req.method,
              status,
              Date.now() - requestStart,
              requestUrl.pathname + requestUrl.search,
              runtimeConfig.onLog,
              buildRequestLogDetails({ requestUrl, body }),
            );
            const cappedResponse = capForRecord(effectiveResponse, responseText);
            record({
              kind: "mock",
              source: mockSource,
              method: (req.method || "GET").toUpperCase(),
              path: requestUrl.pathname,
              query: Object.fromEntries(requestUrl.searchParams.entries()),
              matchedPath: customRule.path,
              status,
              durationMs: Date.now() - requestStart,
              ...(variant ? { variant: variant.name } : {}),
              requestBody: capForRecord(body).value,
              responseBody: cappedResponse.value,
              responseTruncated: cappedResponse.truncated,
            });
            return;
          }
        }
        if (runtimeConfig.backendBaseUrl) {
          await proxyRequest(req, res, requestUrl, runtimeConfig.backendBaseUrl, {
            ...(consumedRawBody !== undefined ? { rawBody: consumedRawBody } : {}),
            onLog: runtimeConfig.onLog,
            onRecord: record,
          });
          return;
        }
        sendJson(res, 404, {
          error: "No mock route matched",
          method: req.method,
          path: requestUrl.pathname,
        });
        logRequest(
          "MISS",
          req.method,
          404,
          Date.now() - requestStart,
          requestUrl.pathname + requestUrl.search,
          runtimeConfig.onLog,
          buildRequestLogDetails({ requestUrl }),
        );
        record({
          kind: "miss",
          method: (req.method || "GET").toUpperCase(),
          path: requestUrl.pathname,
          query: Object.fromEntries(requestUrl.searchParams.entries()),
          matchedPath: "",
          status: 404,
          durationMs: Date.now() - requestStart,
        });
        return;
      }

      const overridePayload = loadMockOverride(route, runtimeConfig.mockDataDir);
      const mockRule = findMockRule(
        runtimeConfig.mockRulesFile,
        req.method || "GET",
        requestUrl.pathname,
      );
      // 变体选择要看 query/headers/body，body 读取因此提前（与 getRequestControls 无依赖）
      const rawBody = await readRawBody(req);
      const body = parseRequestBody(rawBody);
      const variant = mockRule
        ? selectVariant(mockRule, {
            query: Object.fromEntries(requestUrl.searchParams.entries()),
            headers: req.headers,
            body,
          })
        : undefined;
      const ruleDelay = variant?.delay ?? mockRule?.delay;
      const requestControls = getRequestControls(req, requestUrl, {
        delay: typeof ruleDelay === "number" ? ruleDelay : delay,
        forcedStatus,
      });

      if (
        !shouldUseMock({
          runtimeConfig,
          requestControls,
          overridePayload,
          mockRule,
        })
      ) {
        // 没有后端可转发，又没有任何理由 mock（无启用的规则 / override / 请求控制参数）：
        // 与其静默返回一份 swagger 生成的假数据，不如把配置问题暴露出来。
        if (!runtimeConfig.backendBaseUrl) {
          sendJson(res, 502, {
            error: "No backend base URL configured and no mock rule enabled",
            method: req.method,
            path: requestUrl.pathname,
          });
          logRequest(
            "NO-BACKEND",
            req.method,
            502,
            Date.now() - requestStart,
            requestUrl.pathname + requestUrl.search,
            runtimeConfig.onLog,
            buildRequestLogDetails({ requestUrl, body }),
          );
          record({
            kind: "miss",
            method: (req.method || "GET").toUpperCase(),
            path: requestUrl.pathname,
            query: Object.fromEntries(requestUrl.searchParams.entries()),
            matchedPath: route.fullPath,
            status: 502,
            durationMs: Date.now() - requestStart,
            requestBody: capForRecord(body).value,
          });
          return;
        }
        await proxyRequest(req, res, requestUrl, runtimeConfig.backendBaseUrl, {
          rawBody,
          matchedPath: route.fullPath,
          onLog: runtimeConfig.onLog,
          onRecord: record,
        });
        return;
      }

      await sleep(requestControls.delay);

      // 优先级：请求控制参数（__mockStatus/x-mock-*）＞ 命中变体 ＞ 规则顶层
      const ruleStatus = variant?.status ?? mockRule?.status;
      const response = selectResponse(
        route.operation.responses || {},
        requestControls.status || (ruleStatus ? Number(ruleStatus) : undefined),
        requestControls.code,
      );
      const contentType = selectContentType(response);
      const request = {
        method: req.method,
        path: requestUrl.pathname,
        query: Object.fromEntries(requestUrl.searchParams.entries()),
        params: route.match(requestUrl.pathname),
        body,
        controls: requestControls,
      };
      const effectiveResponse = variant ? variant.response : mockRule?.response;
      const payload =
        effectiveResponse !== undefined
          ? effectiveResponse
          : overridePayload.found
            ? normalizeApiResponse(overridePayload.payload, response, request, { fixed: true })
            : buildResponsePayload({
                spec: route.spec,
                route,
                response,
                contentType,
                request,
              });
      const mockSource = variant
        ? "rule-variant"
        : mockRule?.response !== undefined
          ? "rule-response"
          : mockRule?.status
            ? "rule-control"
            : overridePayload.found
              ? `file:${overridePayload.filePath}`
              : "openapi-sample";

      const responseText = sendPayload(res, response.status, payload, contentType);
      logRequest(
        `MOCK:${mockSource}`,
        req.method,
        response.status,
        Date.now() - requestStart,
        requestUrl.pathname + requestUrl.search,
        runtimeConfig.onLog,
        buildRequestLogDetails({
          requestUrl,
          params: request.params,
          body: request.body,
        }),
      );
      {
        const cappedResponse = capForRecord(payload, responseText);
        record({
          kind: "mock",
          source: mockSource,
          method: (req.method || "GET").toUpperCase(),
          path: requestUrl.pathname,
          query: request.query,
          matchedPath: route.fullPath,
          status: response.status,
          durationMs: Date.now() - requestStart,
          ...(variant ? { variant: variant.name } : {}),
          requestBody: capForRecord(body).value,
          responseBody: cappedResponse.value,
          responseTruncated: cappedResponse.truncated,
        });
      }
    } catch (error) {
      logRequest("ERROR", req.method, 500, 0, req.url || "/", runtimeConfig.onLog);
      // 响应已经发出去一部分时再 writeHead 会抛 ERR_HTTP_HEADERS_SENT，把真正的
      // 错误盖掉；这种情况只能收尾，500 body 已经没地方写了。
      if (res.writableEnded) return;
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, {
        error: "Mock server error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

async function loadOpenApiSources(specPath) {
  const absolutePath = path.resolve(specPath);
  const stats = fs.statSync(absolutePath);

  if (!stats.isDirectory()) {
    const spec = await loadOpenApiSpec(absolutePath);
    validateOpenApi3(spec, absolutePath);
    return [{ spec, sourcePath: absolutePath }];
  }

  const entries = fs
    .readdirSync(absolutePath)
    .filter((file) => /\.(json|ya?ml)$/i.test(file))
    .map((file) => path.join(absolutePath, file));

  const sources = [];
  for (const entry of entries) {
    const spec = await loadOpenApiSpec(entry);
    if (isOpenApi3(spec)) {
      sources.push({ spec, sourcePath: entry });
    }
  }

  if (sources.length === 0) {
    throw new Error(`No OpenAPI 3.x JSON/YAML files found in directory: ${absolutePath}`);
  }

  return sources;
}

async function loadMockState(specPath, serviceAddress = "") {
  const sources = await loadOpenApiSources(specPath);
  const routes = sources.flatMap(({ spec, sourcePath }) =>
    buildRoutes(spec, sourcePath, serviceAddress),
  );
  return {
    sources,
    routes,
    loadedAt: new Date().toISOString(),
  };
}

function watchOpenApiSources(specPath, state, serviceAddress = "") {
  const absolutePath = path.resolve(specPath);
  if (!fs.existsSync(absolutePath)) return [];

  const reload = async () => {
    try {
      const next = await loadMockState(absolutePath, serviceAddress);
      state.sources = next.sources;
      state.routes = next.routes;
      state.loadedAt = next.loadedAt;
    } catch (error) {
      console.error(
        `Failed to reload OpenAPI sources: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  // chokidar 替代 fs.watch：
  // - 解决 macOS 编辑器原子保存（vim/IDE 的 .swp + rename）丢事件的问题
  // - awaitWriteFinish：等文件 200ms 内不再变化才触发，避免拿到半个文件
  // - 自带去重，不需要再外层 setTimeout 防抖
  try {
    const watcher = chokidar.watch(absolutePath, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });
    watcher.on("all", reload);
    watcher.on("error", (err) =>
      console.error("[chokidar]", err?.message || err),
    );
    return [watcher];
  } catch {
    return [];
  }
}

async function loadOpenApiSpec(specPath) {
  const raw = fs.readFileSync(path.resolve(specPath), "utf8");
  const ext = path.extname(specPath).toLowerCase();

  if (ext === ".yaml" || ext === ".yml") {
    try {
      // 动态 import：js-yaml 是可选依赖，未安装时优雅降级
      const { default: yaml } = await import("js-yaml");
      return yaml.load(raw);
    } catch {
      throw new Error("YAML specs require optional dependency js-yaml.");
    }
  }

  return JSON.parse(raw);
}

function validateOpenApi3(spec, specPath) {
  if (!spec || typeof spec !== "object") {
    throw new Error(`${specPath} is not a valid OpenAPI document.`);
  }
  if (!isOpenApi3(spec)) {
    throw new Error("Only OpenAPI 3.x documents are supported.");
  }
  if (!spec.paths || typeof spec.paths !== "object") {
    throw new Error("OpenAPI document must contain a paths object.");
  }
}

function isOpenApi3(spec) {
  return Boolean(
    spec && typeof spec === "object" && String(spec.openapi || "").startsWith("3."),
  );
}

function buildRoutes(spec, sourcePath = "", serviceAddress = "") {
  const sourceName = sourcePath ? path.basename(sourcePath) : "";
  const basePath = getServerBasePath(spec, serviceAddress);

  return Object.entries(spec.paths)
    .flatMap(([openapiPath, pathItem]) => {
      if (!pathItem || typeof pathItem !== "object") {
        return [];
      }

      return Object.entries(pathItem)
        .filter(([method]) => HTTP_METHODS.has(method.toLowerCase()))
        .map(([method, operation]) => {
          const fullPath = joinUrlPath(basePath, openapiPath);
          const { regex, paramNames } = compileOpenApiPath(fullPath);
          const route = {
            method: method.toLowerCase(),
            openapiPath,
            fullPath,
            basePath,
            spec,
            sourcePath,
            sourceName,
            operation,
            regex,
            paramNames,
            match(pathname) {
              const match = regex.exec(pathname);
              if (!match) return {};
              return Object.fromEntries(
                paramNames.map((name, index) => [
                  name,
                  decodeURIComponent(match[index + 1]),
                ]),
              );
            },
          };
          // 搜索文本在构建期算一次（spec 热重载时会重建路由），
          // /__mock/search 每次查询就不用再对全量路由拼接 + toLowerCase
          route.searchText = routeSearchText(route);
          return route;
        });
    })
    .sort(compareRoutes);
}

function compileOpenApiPath(openapiPath) {
  const paramNames = [];
  const pattern = openapiPath
    .split("/")
    .map((part) => {
      const match = /^\{([^}]+)\}$/.exec(part);
      if (match) {
        paramNames.push(match[1]);
        return "([^/]+)";
      }
      return escapeRegex(part);
    })
    .join("/");

  return {
    regex: new RegExp(`^${pattern}/?$`),
    paramNames,
  };
}

function getServerBasePath(spec, serviceAddress = "") {
  const configuredBasePath = getConfiguredBasePath(serviceAddress);
  if (configuredBasePath !== null) {
    return configuredBasePath;
  }

  const serverUrl = spec.servers?.[0]?.url;
  if (!serverUrl) return "";

  try {
    const url = new URL(serverUrl, "http://mock.local");
    return normalizeBasePath(url.pathname);
  } catch {
    return "";
  }
}

function getConfiguredBasePath(serviceAddress) {
  const value = String(serviceAddress || "").trim();
  if (!value) return null;

  try {
    const url = new URL(value, "http://mock.local");
    return normalizeBasePath(url.pathname);
  } catch {
    return normalizeBasePath(value);
  }
}

function normalizeBasePath(value) {
  if (!value || value === "/") return "";
  return `/${value.replace(/^\/+|\/+$/g, "")}`;
}

function joinUrlPath(basePath, openapiPath) {
  return `${normalizeBasePath(basePath)}${
    openapiPath.startsWith("/") ? openapiPath : `/${openapiPath}`
  }`;
}

function findRoute(routes, method, pathname) {
  const normalizedMethod = method.toLowerCase();
  return routes.find(
    (route) => route.method === normalizedMethod && route.regex.test(pathname),
  );
}

function routeToMeta(route) {
  return {
    method: route.method.toUpperCase(),
    path: route.fullPath,
    openapiPath: route.openapiPath,
    operationId: route.operation.operationId || null,
    summary: route.operation.summary || route.operation.description || "",
    source: route.sourceName,
    errors: getRouteErrorCodes(route),
  };
}

function getRouteErrorCodes(route) {
  return Object.values(route.operation.responses || {})
    .flatMap((definition) => Object.values(definition.content || {}))
    .map(
      (media) =>
        media.schema?.properties?.code?.enum?.[0] ||
        media.schema?.properties?.code?.const,
    )
    .filter(Boolean);
}

function searchRoutes(routes, query) {
  const normalizedQuery = query.trim().toLowerCase();
  const source = normalizedQuery
    ? routes.filter((route) => route.searchText.includes(normalizedQuery))
    : routes;
  return source.slice(0, 200).map(routeToMeta);
}

function routeSearchText(route) {
  return [
    route.method,
    route.fullPath,
    route.openapiPath,
    route.sourceName,
    route.operation.operationId,
    route.operation.summary,
    route.operation.description,
    ...(route.operation.tags || []),
    ...getRouteErrorCodes(route),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function compareRoutes(a, b) {
  return routeSpecificity(b.openapiPath) - routeSpecificity(a.openapiPath);
}

function routeSpecificity(openapiPath) {
  return openapiPath.split("/").reduce((score, part) => {
    if (!part) return score;
    return score + (/^\{[^}]+\}$/.test(part) ? 1 : 10);
  }, 0);
}

function selectResponse(responses, forcedStatus, forcedCode) {
  if (forcedCode) {
    const matched = Object.entries(responses).find(([, definition]) => {
      const schema = Object.values(definition.content || {})
        .map((media) => media.schema)
        .find(Boolean);
      return schemaHasCode(schema, forcedCode);
    });

    if (matched) {
      const [key, definition] = matched;
      return { key, status: statusFromResponseKey(key), definition };
    }
  }

  if (forcedStatus && responses[String(forcedStatus)]) {
    return {
      key: String(forcedStatus),
      status: forcedStatus,
      definition: responses[String(forcedStatus)],
    };
  }
  if (forcedStatus) {
    const matched = Object.entries(responses).find(
      ([key]) => statusFromResponseKey(key) === forcedStatus,
    );
    if (matched) {
      const [key, definition] = matched;
      return { key, status: forcedStatus, definition };
    }
    return {
      key: `error_${forcedStatus}_mock`,
      status: forcedStatus,
      definition: {
        description: `Mock status ${forcedStatus}`,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                rc: { type: "integer", const: forcedStatus * 100 },
                code: { type: "string", enum: [`MOCK_${forcedStatus}`] },
                message: { type: "string" },
              },
            },
          },
        },
      },
    };
  }

  const preferredStatus =
    Object.keys(responses).find((status) => /^2\d\d$/.test(status)) ||
    Object.keys(responses).find((status) => status !== "default") ||
    "default";

  return {
    key: preferredStatus,
    status: statusFromResponseKey(preferredStatus),
    definition: responses[preferredStatus] || responses.default || {},
  };
}

function statusFromResponseKey(key) {
  if (key === "default") return 200;
  const match = String(key).match(/\d{3}/);
  return match ? Number(match[0]) : 200;
}

function schemaHasCode(schema, code) {
  if (!schema || typeof schema !== "object") return false;
  const codeSchema = schema.properties?.code;
  return (
    codeSchema?.const === code ||
    codeSchema?.enum?.includes(code) ||
    JSON.stringify(schema).includes(`"${code}"`)
  );
}

function selectContentType(response) {
  const content = response.definition?.content || {};
  return (
    Object.keys(content).find((type) => type.includes("json")) ||
    Object.keys(content)[0] ||
    "application/json"
  );
}

function buildResponsePayload({
  spec,
  route,
  response,
  contentType,
  request,
}) {
  const responseDefinition = response.definition || {};
  const media = responseDefinition.content?.[contentType];

  if (media?.example !== undefined) {
    return normalizeApiResponse(media.example, response, request);
  }

  const examples = media?.examples;
  if (examples && typeof examples === "object") {
    const firstExample = Object.values(examples)[0];
    if (firstExample?.value !== undefined) {
      return normalizeApiResponse(firstExample.value, response, request);
    }
  }

  if (media?.schema) {
    return normalizeApiResponse(
      mockFromSchema(media.schema, spec, { request }),
      response,
      request,
    );
  }

  if (contentType.includes("json")) {
    return normalizeApiResponse(
      {
        ok: true,
        operationId: route.operation.operationId || null,
        params: request.params,
        query: request.query,
        body: request.body,
      },
      response,
      request,
    );
  }

  return responseDefinition.description || "";
}

/**
 * @param {*} payload - 待规范化的数据
 * @param {object} response - 命中的 OpenAPI response 描述
 * @param {object} request - 请求上下文（query/params/controls 等）
 * @param {object} [opts]
 * @param {boolean} [opts.fixed] - 是否为用户手写的固定 mock。true 时跳过基于请求参数的
 *   数组扩展/字段微调（tunePayloadForRequest），原样返回。
 */
function normalizeApiResponse(payload, response, request = {}, opts = {}) {
  if (!response.definition?.content?.["application/json"]) {
    return payload;
  }

  // 用户手写的 mock 走原样路径，只在外层补 envelope 字段，不动 data 内容
  const finalPayload = opts.fixed ? payload : tunePayloadForRequest(payload, request);
  if (isApiEnvelope(finalPayload)) {
    return normalizeEnvelope(finalPayload, response);
  }
  if (response.status >= 400) {
    return {
      rc: response.status * 100,
      code: `MOCK_${response.status}`,
      message: response.definition?.description || `Mock status ${response.status}`,
    };
  }

  return {
    rc: 0,
    code: "SUCCESS",
    message: "success",
    data: finalPayload,
  };
}

/**
 * 给 schema 采样值套上 mock server 默认信封，让「推荐数据」与服务端
 * 未配置 rule 时自动返回的响应保持一致（用户拿到的就是完整响应体）。
 */
function wrapSampleInEnvelope(sample, definition, responseKey) {
  const response = {
    definition: definition || {},
    status: statusFromResponseKey(responseKey),
    key: responseKey,
  };
  return normalizeApiResponse(sample, response, {}, { fixed: true });
}

function isApiEnvelope(payload) {
  return Boolean(
    payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      ("rc" in payload || "code" in payload || "message" in payload),
  );
}

function normalizeEnvelope(payload, response) {
  const isError = String(response.key || "").startsWith("error_");
  return {
    ...payload,
    rc: isError ? payload.rc : normalizeSuccessRc(payload.rc),
    code: isError ? payload.code : normalizeSuccessCode(payload.code),
    message: isError
      ? normalizeErrorMessage(payload.message, response.definition?.description)
      : normalizeSuccessMessage(payload.message),
  };
}

function normalizeSuccessRc(rc) {
  return rc === undefined || rc === null || rc === 1 ? 0 : rc;
}

function normalizeSuccessCode(code) {
  return !code || code === "string" ? "SUCCESS" : code;
}

function normalizeSuccessMessage(message) {
  return !message || message === "string" ? "success" : message;
}

function normalizeErrorMessage(message, description) {
  return !message || message === "string" || message === "mock"
    ? description || "error"
    : message;
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
}

function parseRequestBody(rawBody) {
  const raw = Buffer.isBuffer(rawBody)
    ? rawBody.toString("utf8")
    : String(rawBody || "");
  if (!raw) return undefined;

  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function shouldUseMock({
  runtimeConfig,
  requestControls,
  overridePayload,
  mockRule,
}) {
  if (runtimeConfig.mockAll) {
    return true;
  }

  // 没配后端时不再无条件 mock：swagger 里有定义 ≠ 用户想要假数据。没有启用的规则
  // 命中就让调用方报 502，避免「规则明明没启用，接口却还是走 mock」。
  return Boolean(
    mockRule ||
      overridePayload.found ||
      requestControls.code ||
      requestControls.status ||
      requestControls.empty ||
      requestControls.delay > 0,
  );
}

// ─── 文件读取缓存 ──────────────────────────────────────────────────────────────
// rules / override 文件在请求热路径上被反复读取，但内容几乎不变（只有用户在 UI 改规则、
// 或手动编辑文件时才会变）。原先每个请求都 readFileSync + JSON.parse 一遍同一个文件，
// 请求量一大就是连续的同步磁盘 IO，阻塞事件循环。
//
// 这里按 mtime 缓存「解析后」的结果：statSync 拿修改时间，没变就直接返回内存里的值，
// 只有文件真的变了才重新读盘 + 解析。statSync 仍是一次 syscall，但远比读整个文件
// + JSON.parse 便宜；且自带失效语义——UI 保存规则会重写文件 → mtime 变 → 下次请求
// 自动重载，无需再额外挂 watcher / 做缓存失效。
const jsonFileCache = new Map(); // filePath → { mtimeMs, value }

// 读取并解析 JSON 文件，命中 mtime 缓存时跳过读盘。文件不存在返回 undefined。
function readJsonByMtime(filePath, parse) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    jsonFileCache.delete(filePath);
    return undefined;
  }
  const cached = jsonFileCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.value;

  const value = parse(fs.readFileSync(filePath, "utf8"));
  jsonFileCache.set(filePath, { mtimeMs: stat.mtimeMs, value });
  return value;
}

function loadMockRules(mockRulesFile) {
  if (!mockRulesFile) return [];

  const rules = readJsonByMtime(mockRulesFile, (raw) => {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.map(normalizeMockRule);
    if (Array.isArray(parsed.rules)) return parsed.rules.map(normalizeMockRule);
    return [];
  });
  return rules || [];
}

function normalizeMockRule(rule) {
  if (typeof rule === "string") {
    return {
      method: "*",
      path: rule,
      enabled: true,
    };
  }

  // variants：加载路径宽松清洗（非法变体静默丢弃），手改文件不至于整条规则失效
  const variants = Array.isArray(rule.variants)
    ? rule.variants.map(normalizeVariantLoose).filter(Boolean)
    : [];

  return {
    method: (rule.method || "*").toUpperCase(),
    path: rule.path,
    response: rule.response,
    status: rule.status,
    delay: rule.delay,
    enabled: rule.enabled !== false,
    ...(variants.length ? { variants } : {}),
  };
}

// 规则对象 → 编译后的正则。规则对象本身已按 mtime 缓存（readJsonByMtime），
// 用 WeakMap 跟随其生命周期：文件不变时同一批对象反复命中缓存，避免每个请求
// × 每条规则都 new RegExp；文件变了会解析出新对象，旧条目随之被 GC。
// 不直接挂在 rule 上，是为了不污染 /__mock/rules 接口返回的 JSON。
const ruleRegexCache = new WeakMap();

function getRuleRegex(rule) {
  let regex = ruleRegexCache.get(rule);
  if (!regex) {
    regex = compileOpenApiPath(rule.path).regex;
    ruleRegexCache.set(rule, regex);
  }
  return regex;
}

function findMockRule(mockRulesFile, method, pathname) {
  const normalizedMethod = method.toUpperCase();
  return loadMockRules(mockRulesFile).find((rule) => {
    if (!rule.enabled || !rule.path) return false;
    if (rule.method !== "*" && rule.method !== normalizedMethod) return false;
    return getRuleRegex(rule).test(pathname);
  });
}

function loadMockOverride(route, mockDataDir) {
  if (!mockDataDir) return { found: false };

  const filePath = getMockOverrideCandidates(route, mockDataDir).find((candidate) =>
    fs.existsSync(candidate),
  );
  if (!filePath) return { found: false };

  try {
    const payload = readJsonByMtime(filePath, (raw) => JSON.parse(raw));
    // existsSync 命中后文件又被删（罕见竞态）：readJsonByMtime 返回 undefined，按未命中处理
    if (payload === undefined) return { found: false };
    return { found: true, filePath, payload };
  } catch (error) {
    throw new Error(
      `Failed to load mock override ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

function getMockOverrideCandidates(route, mockDataDir) {
  const normalizedPath = route.fullPath.replace(/^\/+/, "");
  const ext = `.${route.method}.json`;
  return [
    path.join(mockDataDir, `${normalizedPath}${ext}`),
    path.join(mockDataDir, normalizedPath, `${route.method}.json`),
    path.join(
      mockDataDir,
      route.sourceName.replace(/\.json$/i, ""),
      `${route.openapiPath.replace(/^\/+/, "")}${ext}`,
    ),
  ];
}

async function proxyRequest(
  req,
  res,
  requestUrl,
  backendBaseUrl,
  { rawBody, matchedPath = "", onLog, onRecord } = {},
) {
  const startTime = Date.now();
  const targetUrl = resolveBackendTargetUrl(requestUrl, backendBaseUrl);
  const body = rawBody || (await readRawBody(req));
  const parsedBody = parseRequestBody(body);
  const { headers, auth: proxyAuth } = proxyHeaders(
    req.headers,
    requestUrl.pathname,
  );
  const recordBase = () => ({
    method: (req.method || "GET").toUpperCase(),
    path: requestUrl.pathname,
    query: Object.fromEntries(requestUrl.searchParams.entries()),
    matchedPath,
    source: backendBaseUrl,
    durationMs: Date.now() - startTime,
    requestBody: capForRecord(parsedBody).value,
  });

  try {
    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: body.length > 0 ? body : undefined,
      redirect: "manual",
    });

    response.headers.forEach((value, key) => {
      if (
        !["content-encoding", "content-length", "transfer-encoding"].includes(
          key.toLowerCase(),
        )
      ) {
        res.setHeader(key, value);
      }
    });
    res.setHeader("x-mock-proxy", "true");
    res.writeHead(response.status);
    const responseBuffer = Buffer.from(await response.arrayBuffer());
    res.end(responseBuffer);
    logRequest(
      "PROXY",
      req.method,
      response.status,
      Date.now() - startTime,
      targetUrl.toString(),
      onLog,
      buildRequestLogDetails({ requestUrl, body: parsedBody, auth: proxyAuth }),
    );
    const capped = capProxyResponseForRecord(
      responseBuffer,
      response.headers.get("content-type") || "",
    );
    onRecord?.({
      kind: "proxy",
      ...recordBase(),
      status: response.status,
      responseBody: capped.value,
      responseTruncated: capped.truncated,
      responseIsJson: capped.isJson,
    });
  } catch (error) {
    console.error("proxy error:", error instanceof Error ? error.message : String(error));
    logRequest(
      "PROXY_ERR",
      req.method,
      502,
      Date.now() - startTime,
      targetUrl.toString(),
      onLog,
      buildRequestLogDetails({ requestUrl, body: parsedBody, auth: proxyAuth }),
    );
    sendJson(res, 502, {
      error: "Proxy request failed",
      target: targetUrl.toString(),
      message: error instanceof Error ? error.message : String(error),
    });
    onRecord?.({
      kind: "proxy-error",
      ...recordBase(),
      status: 502,
      responseBody: {
        error: "Proxy request failed",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

// ─── 历史记录的体积保护 ────────────────────────────────────────────────────────
// 历史缓冲常驻主进程内存且整条走 IPC，超大 body 只标记 truncated 不存内容
// （truncated 的记录在 UI 上禁用「生成规则」）。
const MAX_RECORD_BODY_CHARS = 512_000;

/**
 * @param {*} value - 待记录的 body
 * @param {string} [serialized] - value 的 JSON 文本，调用方若已序列化过（发送响应时）
 *   可传入复用，省掉这里再 stringify 一遍。省略时内部自行序列化。
 */
function capForRecord(value, serialized) {
  if (value === undefined) return { value: undefined, truncated: false };
  try {
    const text = serialized === undefined ? JSON.stringify(value) : serialized;
    if (typeof text === "string" && text.length > MAX_RECORD_BODY_CHARS) {
      return { value: undefined, truncated: true };
    }
  } catch {
    return { value: undefined, truncated: true };
  }
  return { value, truncated: false };
}

function capProxyResponseForRecord(buffer, contentType) {
  if (buffer.length > MAX_RECORD_BODY_CHARS) {
    return { value: undefined, truncated: true, isJson: false };
  }
  const text = buffer.toString("utf8");
  if (contentType.includes("json")) {
    try {
      return { value: JSON.parse(text), truncated: false, isJson: true };
    } catch {
      // content-type 撒谎 / 半截 JSON：按文本兜底
    }
  }
  // 非 JSON（HTML、纯文本等）只留个预览，生成规则也用不上
  return {
    value: text.slice(0, 2000),
    truncated: text.length > 2000,
    isJson: false,
  };
}

function resolveBackendTargetUrl(requestUrl, backendBaseUrl) {
  const baseUrl = new URL(backendBaseUrl);
  const basePath = baseUrl.pathname.replace(/\/+$/g, "");
  const requestPath = requestUrl.pathname.replace(/^\/+/g, "");
  baseUrl.pathname = [basePath, requestPath].filter(Boolean).join("/");
  baseUrl.search = requestUrl.search;
  baseUrl.hash = "";
  return baseUrl;
}

function proxyHeaders(headers, pathname) {
  // cookie@1.x parse 行为与原手写版（及 dev-api-proxy 依赖的 cookie-parser）一致：
  // 同名 cookie 保留首次出现、value 仅在含 % 时 decodeURIComponent、解码失败回退原值。
  const cookies = parseCookie(getHeaderValue(headers, "cookie") || "");
  // host / connection / content-length 都由 fetch 自己管理，无需透传
  const skip = new Set(["host", "connection", "content-length"]);

  const incomingAuthorization = getHeaderValue(headers, "authorization");
  const incomingMgmtauth = getHeaderValue(headers, "mgmtauth");

  // 与 dev-api-proxy 实际行为保持一致：cookie 中的 token 只在请求头没有该字段时注入，
  // 不覆盖前端显式发送的 Authorization / Mgmtauth（dev-api-proxy 因 Node 把 req.headers 全小写化，
  // `req.headers.Authorization = ...` 实际上不会覆盖小写 authorization，因此原值胜出）。
  const injectAuthorization = cookies.VJTOKEN && !incomingAuthorization;
  const injectMgmtauth =
    cookies.TOKEN && pathname.includes("/mgmt") && !incomingMgmtauth;

  const proxied = Object.fromEntries(
    Object.entries(headers)
      .filter(([key, value]) => !skip.has(key.toLowerCase()) && value !== undefined)
      .map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value]),
  );

  const finalAuthorization = injectAuthorization
    ? cookies.VJTOKEN
    : incomingAuthorization;
  const finalMgmtauth = injectMgmtauth ? cookies.TOKEN : incomingMgmtauth;

  if (injectAuthorization) proxied.Authorization = cookies.VJTOKEN;
  if (injectMgmtauth) proxied.Mgmtauth = cookies.TOKEN;

  return {
    headers: proxied,
    auth: {
      authorization: !!finalAuthorization,
      authorizationLength: String(finalAuthorization || "").length,
      authorizationSource: injectAuthorization
        ? "cookie.VJTOKEN"
        : incomingAuthorization ? "header" : "",
      authorizationFingerprint: fingerprintHeader(finalAuthorization),
      mgmtauth: !!finalMgmtauth,
      mgmtauthLength: String(finalMgmtauth || "").length,
      mgmtauthSource: injectMgmtauth
        ? "cookie.TOKEN"
        : incomingMgmtauth ? "header" : "",
      mgmtauthFingerprint: fingerprintHeader(finalMgmtauth),
    },
  };
}

function fingerprintHeader(value) {
  const str = String(value || "");
  if (!str) return "";
  if (str.length <= 16) return str;
  return `${str.slice(0, 8)}…${str.slice(-8)}`;
}

function getHeaderValue(headers, name) {
  const normalizedName = name.toLowerCase();
  const match = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === normalizedName,
  );
  return match?.[1];
}

function logRequest(type, method, statusCode, duration, url, onLog, details = "") {
  const message = `[${type}] [${method}] [${statusCode}] [${duration}ms] ${url}${details}`;
  // onLog 存在时（嵌入 Electron 主进程，渲染层会展示），不再走 console 避免双写
  if (typeof onLog === "function") {
    onLog(message);
    return;
  }
  if (duration > 300) {
    console.warn(message);
  } else {
    console.info(message);
  }
}

function buildRequestLogDetails({ requestUrl, params, body, auth }) {
  const details = {};
  const query = Object.fromEntries(requestUrl.searchParams.entries());

  if (Object.keys(query).length > 0) {
    details.query = query;
  }
  if (params && Object.keys(params).length > 0) {
    details.params = params;
  }
  if (body !== undefined) {
    details.body = body;
  }
  if (auth && (auth.authorization || auth.mgmtauth)) {
    details.auth = auth;
  }

  if (Object.keys(details).length === 0) return "";
  return ` ${truncateLogValue(JSON.stringify(details))}`;
}

function truncateLogValue(value, maxLength = 2000) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...<truncated ${value.length - maxLength} chars>`;
}

function getRequestControls(req, requestUrl, defaults = {}) {
  return {
    code: requestUrl.searchParams.get("__mockCode") || req.headers["x-mock-code"],
    status: numberOrUndefined(
      requestUrl.searchParams.get("__mockStatus") ||
        req.headers["x-mock-status"] ||
        defaults.forcedStatus,
    ),
    delay: numberOrDefault(
      requestUrl.searchParams.get("__mockDelay") ||
        req.headers["x-mock-delay"],
      defaults.delay || 0,
    ),
    empty: requestUrl.searchParams.get("__mockEmpty") || req.headers["x-mock-empty"],
  };
}

function numberOrUndefined(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function numberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

// 返回实际发出的 JSON 文本，调用方可交给 capForRecord 复用，避免为量长度再序列化一次。
// 非 JSON 响应返回 undefined。
function sendPayload(res, status, payload, contentType) {
  if (contentType.includes("json")) {
    return sendJson(res, status, payload);
  }

  res.writeHead(status, {
    "content-type": contentType,
  });
  res.end(String(payload ?? ""));
  return undefined;
}

// 业务响应走紧凑序列化：给前端代码消费，缩进只是白费带宽和 CPU。
// 给人看的 /__mock/* 调试接口用 sendJsonPretty。
function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  res.end(text);
  return text;
}

function sendJsonPretty(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
  });
  res.end(html);
}

function renderMockUi() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Swagger Mock</title>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #20242a; background: #f6f7f9; }
    header { padding: 20px 24px; background: #ffffff; border-bottom: 1px solid #dfe3e8; position: sticky; top: 0; }
    h1 { margin: 0 0 12px; font-size: 22px; }
    input { width: min(680px, 100%); box-sizing: border-box; padding: 10px 12px; border: 1px solid #c9d0d8; border-radius: 6px; font-size: 14px; }
    main { padding: 16px 24px 32px; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #dfe3e8; }
    th, td { padding: 10px 12px; border-bottom: 1px solid #edf0f3; text-align: left; font-size: 13px; vertical-align: top; }
    th { background: #f9fafb; font-weight: 600; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .method { font-weight: 700; width: 72px; }
    .errors { color: #9b1c1c; }
    button { padding: 6px 9px; border: 1px solid #c9d0d8; background: #fff; border-radius: 6px; cursor: pointer; }
  </style>
</head>
<body>
  <header>
    <h1>Swagger Mock</h1>
    <input id="q" placeholder="搜索 path、summary、operationId、错误码" autofocus />
  </header>
  <main>
    <table>
      <thead><tr><th>Method</th><th>Path</th><th>Summary</th><th>Errors</th><th>Source</th><th></th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </main>
  <script>
    const rows = document.querySelector("#rows");
    const input = document.querySelector("#q");
    let timer;
    async function search() {
      const res = await fetch("/__mock/search?q=" + encodeURIComponent(input.value));
      const data = await res.json();
      rows.innerHTML = data.map(route => {
        const path = route.path.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
        return \`<tr>
          <td class="method">\${route.method}</td>
          <td><code>\${path}</code></td>
          <td>\${route.summary || ""}</td>
          <td class="errors">\${(route.errors || []).join(", ")}</td>
          <td>\${route.source}</td>
          <td><button data-url="\${route.path}">复制</button></td>
        </tr>\`;
      }).join("");
    }
    rows.addEventListener("click", event => {
      const button = event.target.closest("button");
      if (button) navigator.clipboard.writeText(location.origin + button.dataset.url);
    });
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(search, 150);
    });
    search();
  </script>
</body>
</html>`;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runMiddleware(req, res, middleware) {
  return new Promise((resolve, reject) => {
    middleware(req, res, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export {
  buildRoutes,
  loadMockRules,
  loadOpenApiSources,
  normalizeMockRule,
  routeToMeta,
  startMockServer,
  wrapSampleInEnvelope,
};
