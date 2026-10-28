// 按 method + path 在 swagger 里找接口，并给出「推荐 mock 数据」。
// app（规则编辑器的推荐数据 / 参数表）和 vjtools CLI（vjtools mock describe / sample）共用。
//
// 纯 node 模块：spec 路径等配置由调用方传入，不碰 electron / config store。

import { buildRoutes, loadOpenApiSources, wrapSampleInEnvelope } from "./server.js";
import { mockFromSchema } from "./data.js";
import { getRecommendedQueryParams } from "./request-schema.js";

// 路由匹配优先级：
//   1. method + fullPath 精确命中
//   2. method + openapiPath 命中（rule 里写的可能是带 {id} 的原始模板）
//   3. method 通配（*）情况下放宽到任意 method
//   4. regex 命中（rule path 是具体值 /foo/123 时回退）
export function findRouteForPreview(routes, method, targetPath) {
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

/** 在 specPath 下的 swagger 里找接口；找不到抛中文错误 */
export async function resolveRoute({ specPath, serviceAddress = "", method, path: targetPath }) {
  const upperMethod = String(method || "*").toUpperCase();
  const routePath = String(targetPath || "").trim();
  if (!routePath) throw new Error("path 不能为空");
  if (!specPath) throw new Error("Mock spec 路径未配置，请到设置中填写");

  const sources = await loadOpenApiSources(specPath);
  const allRoutes = sources.flatMap(({ spec, sourcePath }) =>
    buildRoutes(spec, sourcePath, serviceAddress),
  );

  const route = findRouteForPreview(allRoutes, upperMethod, routePath);
  if (!route) {
    throw new Error(`未在 swagger 中找到 ${upperMethod} ${routePath}`);
  }
  return route;
}

/**
 * 根据 OpenAPI schema 推荐一份 mock JSON（不写盘）。
 * 返回完整响应体（2xx JSON 含 rc/code/message/data 信封），用户 / AI 在它上面改值即可。
 */
export function recommendResponse(route) {
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
}
