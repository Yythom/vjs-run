// 不涉及进程生命周期的 mock 命令：config / init / gen / routes / describe / sample / history。
// 规则 / 场景的增删改在 rule.js。

import fs from "node:fs";
import { URLSearchParams } from "node:url";
import { buildRoutes, loadOpenApiSources, routeToMeta, wrapSampleInEnvelope } from "../mock/server.js";
import { recommendResponse, resolveRoute } from "../mock/route-info.js";
import { getRequestSchema, getResponseSchema } from "../mock/request-schema.js";
import { seedMockAssets } from "../mock/seed-assets.js";
import { cliPaths } from "./user-data.js";
import {
  assertSpecReady,
  configUpdatesFromFlags,
  patchRawConfig,
  readMockConfig,
  toMockConfig,
} from "./config.js";
import { NOT_RUNNING_EXIT_CODE, detectRunningMock } from "./mock-daemon.js";
import { CliError, clockTime, printJson } from "./util.js";

// ─── config ──────────────────────────────────────────────────────────────────

function printConfig(paths, config) {
  console.log(`# ${paths.configFile}`);
  console.log(`  spec 目录         --spec-dir         ${config.specPath || "(未设置)"}`);
  console.log(`  Swagger 源服务器  --swagger-server   ${config.swaggerServer || "(未设置)"}`);
  console.log(`  后端代理地址      --backend          ${config.backendBaseUrl || "(未设置)"}`);
  console.log(`  监听地址          --host / --port    ${config.host}:${config.port}`);
  console.log(`  服务前缀          --service-address  ${config.serviceAddress || "(无)"}`);
  console.log(`  全量 mock         --mock-all         ${config.mockAll}`);
  console.log(`  规则文件                             ${paths.rulesFile}`);
}

function configJson(paths, config) {
  return { ...config, configFile: paths.configFile, rulesFile: paths.rulesFile };
}

/** 应用 flags，返回最新 mock 配置；没有任何 flag 时不写盘 */
function applyConfigFlags(paths, values) {
  const updates = configUpdatesFromFlags(values);
  if (!Object.keys(updates).length) return { config: readMockConfig(paths.configFile), changed: false };
  return { config: toMockConfig(patchRawConfig(paths.configFile, updates)), changed: true };
}

async function printRestartHint(paths, config) {
  const running = await detectRunningMock(paths, config);
  if (!running) return;
  console.log(
    running.owner === "cli"
      ? "  mock 运行中：守护进程监听 config.json，改了 spec / 地址 / 后端会自动重启。"
      : "  mock 由 vjtools app 运行：软件会自动重新加载配置，必要时重启 mock。",
  );
}

export async function config(values) {
  const paths = cliPaths();
  const { config, changed } = applyConfigFlags(paths, values);
  if (values.json) {
    printJson(configJson(paths, config));
    return 0;
  }
  if (changed) console.log("✔ 配置已更新");
  printConfig(paths, config);
  if (changed) await printRestartHint(paths, config);
  return 0;
}

// ─── gen ─────────────────────────────────────────────────────────────────────

/** spec 目录没配时落到 <userData>/mock-specs，并写回 config.json */
function ensureSpecDir(paths, config) {
  if (config.specPath) return config;
  patchRawConfig(paths.configFile, { mockSpecPath: paths.defaultSpecDir });
  console.log(`  spec 目录未设置，使用默认目录：${paths.defaultSpecDir}`);
  return { ...config, specPath: paths.defaultSpecDir };
}

export async function gen() {
  const paths = cliPaths();
  let config = readMockConfig(paths.configFile);
  if (!config.swaggerServer) {
    throw new CliError("未配置 Swagger 源服务器：vjtools mock config --swagger-server <url>");
  }
  config = ensureSpecDir(paths, config);
  if (/\.(json|ya?ml)$/i.test(config.specPath)) {
    throw new CliError(`spec 路径必须是目录，当前指向单个文件：${config.specPath}`);
  }

  console.log(`▶ 从 ${config.swaggerServer} 生成 OpenAPI JSON → ${config.specPath}`);
  // jieba-wasm 体积大，只有 gen 用得到，按需加载
  const { generateSwaggerSpecs } = await import("../mock/generate-spec.js");
  try {
    const { generated, failed } = await generateSwaggerSpecs({
      serverUrl: config.swaggerServer,
      outputDir: config.specPath,
      onLog: (message) => console.log(`  ${message}`),
    });

    if (generated.length) console.log(`✔ 已生成：${generated.join(", ")}`);
    if (failed.length) console.log(`✗ 失败：${failed.map((item) => item.type).join(", ")}`);
    const running = await detectRunningMock(paths, config);
    if (running) console.log("  mock 运行中，路由会自动热更新。");
    return generated.length ? 0 : 1;
  } catch (err) {
    throw new CliError(err.message);
  }
}

// ─── init ────────────────────────────────────────────────────────────────────

function hasSpecFiles(dir) {
  try {
    return fs.readdirSync(dir).some((name) => /\.(json|ya?ml)$/i.test(name));
  } catch {
    return false;
  }
}

export async function init(values) {
  const paths = cliPaths();
  seedMockAssets(paths.userDataDir);
  let { config } = applyConfigFlags(paths, values);
  config = ensureSpecDir(paths, config);
  console.log(`✔ 数据目录：${paths.userDataDir}`);
  printConfig(paths, config);

  if (config.swaggerServer && !hasSpecFiles(config.specPath)) {
    console.log("");
    const code = await gen();
    if (code !== 0) return code;
  }

  console.log("");
  if (!hasSpecFiles(config.specPath)) {
    console.log("下一步：vjtools mock config --swagger-server <url> && vjtools mock gen");
    console.log("    或：vjtools mock config --spec-dir <已有 OpenAPI JSON 目录>");
  } else {
    console.log("下一步：vjtools mock start");
  }
  return 0;
}

// ─── routes ──────────────────────────────────────────────────────────────────

export async function routes(keyword, values) {
  const paths = cliPaths();
  const config = readMockConfig(paths.configFile);
  assertSpecReady(config);

  const sources = await loadOpenApiSources(config.specPath);
  let metas = sources
    .flatMap(({ spec, sourcePath }) => buildRoutes(spec, sourcePath, config.serviceAddress))
    .map(routeToMeta);

  const total = metas.length;
  if (values.method) {
    const method = values.method.toUpperCase();
    metas = metas.filter((meta) => meta.method === method);
  }
  if (keyword) {
    const needle = keyword.toLowerCase();
    metas = metas.filter((meta) =>
      [meta.method, meta.path, meta.openapiPath, meta.summary, meta.operationId, meta.source]
        .filter(Boolean)
        .some((text) => String(text).toLowerCase().includes(needle)),
    );
  }
  const matched = metas.length;
  const limit = parseLimit(values.limit, 50);
  const shown = metas.slice(0, limit);

  if (values.json) {
    printJson({ total, matched, routes: shown });
    return 0;
  }
  for (const meta of shown) {
    console.log(`${meta.method.padEnd(6)} ${meta.path}${meta.summary ? `  ${meta.summary}` : ""}`);
  }
  console.log(
    `— ${matched} 条匹配（共 ${total} 条）${matched > shown.length ? `，显示前 ${shown.length} 条，--limit 调整` : ""}`,
  );
  return 0;
}

// ─── describe / sample ───────────────────────────────────────────────────────
// 与 app 规则编辑器里的「参数表」「推荐数据」是同一份实现（route-info.js / request-schema.js）

async function resolveCliRoute(values) {
  const config = readMockConfig(cliPaths().configFile);
  assertSpecReady(config);
  if (typeof values.method !== "string" || !values.method.trim()) {
    throw new CliError("缺少 --method（如 --method GET）");
  }
  if (typeof values.path !== "string" || !values.path.trim()) {
    throw new CliError("缺少 --path（routes 里看到的完整路径，或带 {param} 的模板）");
  }
  try {
    return await resolveRoute({
      specPath: config.specPath,
      serviceAddress: config.serviceAddress,
      method: values.method,
      path: values.path,
    });
  } catch (err) {
    throw new CliError(`${err.message}\n  先用 vjtools mock routes <关键词> 找到准确的 method 和路径`);
  }
}

function formatExample(value) {
  if (value === undefined) return "";
  const text = JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function printFields(fields, descriptions = {}) {
  // 按最长的字段路径对齐（封顶 48，再长的就让它顶出去）
  const width = Math.min(48, Math.max(...fields.map((field) => field.path.length)));
  for (const field of fields) {
    const desc = field.description || descriptions[field.path] || "";
    const example = formatExample(field.example);
    console.log(
      `  ${field.path.padEnd(width)}  ${String(field.type || "").padEnd(8)}${desc ? ` ${desc}` : ""}${example ? `  例: ${example}` : ""}`,
    );
  }
}

/** 接口的请求参数、请求体和响应结构：写变体条件、造数据前先看这个 */
export async function describe(values) {
  const route = await resolveCliRoute(values);
  const request = getRequestSchema(route);
  const response = getResponseSchema(route, { wrapSample: wrapSampleInEnvelope });
  let recommended = null;
  try {
    recommended = recommendResponse(route).json;
  } catch {
    // swagger 没定义响应 schema：只展示请求侧
  }

  if (values.json) {
    printJson({
      ...request,
      openapiPath: route.openapiPath,
      source: route.sourceName,
      response: response && {
        status: response.status,
        contentType: response.contentType,
        fields: response.fields,
      },
      sample: recommended,
    });
    return 0;
  }

  console.log(`${request.method} ${request.path}${request.summary ? `  ${request.summary}` : ""}`);
  console.log(`  来源 ${route.sourceName}${request.operationId ? ` · operationId ${request.operationId}` : ""}`);

  console.log("\n参数（query / path / header）：");
  if (!request.parameters.length) console.log("  (无)");
  for (const p of request.parameters) {
    const example = formatExample(p.example);
    console.log(
      `  ${p.in.padEnd(6)} ${p.name.padEnd(20)} ${p.type.padEnd(8)}${p.required ? " 必填" : ""}${p.description ? ` ${p.description}` : ""}${example ? `  例: ${example}` : ""}`,
    );
  }

  console.log(`\n请求体${request.body ? `（${request.body.contentType}）` : ""}：`);
  if (!request.body?.fields?.length) console.log("  (无)");
  else printFields(request.body.fields);

  console.log(`\n响应${response ? `（${response.status}）` : ""}：`);
  if (!response?.fields?.length) console.log("  (swagger 没有定义响应结构)");
  else printFields(response.fields, response.descriptions);

  console.log("\n变体条件：--when-query <参数>=<值>、--when-header <名>=<值>、--when-body <请求体字段路径>=<值>");
  if (recommended) {
    console.log(`推荐响应：vjtools mock sample --method ${request.method} --path '${request.path}'（输出完整 JSON，改完喂给 rule set）`);
  }
  return 0;
}

/** 按 swagger schema 生成一份推荐响应 JSON，输出到 stdout，方便改完直接喂给 rule set */
export async function sample(values) {
  const route = await resolveCliRoute(values);
  let recommended;
  try {
    recommended = recommendResponse(route);
  } catch (err) {
    throw new CliError(err.message);
  }
  console.log(JSON.stringify(recommended.json, null, 2));
  return 0;
}

// ─── history ─────────────────────────────────────────────────────────────────

function parseLimit(raw, fallback) {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new CliError(`--limit 必须是正整数：${raw}`);
  return n;
}

function describeSource(entry) {
  if (entry.kind !== "mock") return entry.kind;
  const source = entry.source ? `:${entry.source}` : "";
  const variant = entry.variant ? `(${entry.variant})` : "";
  return `mock${source}${variant}`;
}

function queryString(query) {
  if (!query || typeof query !== "object") return "";
  const text = new URLSearchParams(query).toString();
  return text ? `?${text}` : "";
}

export async function history(values) {
  const paths = cliPaths();
  const running = await detectRunningMock(paths, readMockConfig(paths.configFile));
  if (!running) throw new CliError("mock 未在运行，没有请求历史。", NOT_RUNNING_EXIT_CODE);

  const res = await fetch(`${running.url}/__mock/history`).catch(() => null);
  if (!res?.ok) {
    throw new CliError(
      res?.status === 404
        ? "当前运行的 mock 不支持查询历史（旧版 vjtools app），升级 app 或改用 vjtools mock start。"
        : `读取请求历史失败：${res ? `HTTP ${res.status}` : "连接失败"}`,
    );
  }
  let entries = await res.json();

  if (values.id !== undefined) {
    const entry = entries.find((item) => String(item.id) === String(values.id));
    if (!entry) throw new CliError(`没有 id 为 ${values.id} 的请求（历史只保留最近 300 条）`);
    printJson(entry);
    return 0;
  }

  if (values.kind) entries = entries.filter((entry) => entry.kind === values.kind);
  if (values.path) {
    const needle = values.path.toLowerCase();
    entries = entries.filter((entry) => String(entry.path).toLowerCase().includes(needle));
  }
  entries = entries.slice(-parseLimit(values.limit, 20)).reverse();

  if (values.json) {
    printJson(entries);
    return 0;
  }
  if (!entries.length) {
    console.log("没有符合条件的请求。");
    return 0;
  }
  for (const entry of entries) {
    console.log(
      `#${entry.id} ${clockTime(entry.ts)} ${String(entry.method).padEnd(6)} ${entry.status} ` +
        `${describeSource(entry)} ${entry.durationMs}ms ${entry.path}${queryString(entry.query)}`,
    );
  }
  console.log("— 最新在上；看单条的请求体 / 响应体：vjtools mock history --id <编号>");
  return 0;
}
