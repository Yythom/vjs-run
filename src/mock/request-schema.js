// 接口「请求侧」schema 的提取：parameters（query/path/header）+ requestBody 采样。
//
// 供规则编辑器展示请求参数表，并把参数一键填成变体的匹配条件；
// getRecommendedQueryParams 另外供 curl 调试弹窗预填 Query Params。
//
// 与 previewMockResponse 分开：那边要求「响应」必须有 schema，响应没定义就整个
// 失败——但请求参数是独立的信息，不该被响应侧的缺失连累。
//
// 纯模块：只依赖 data.js / variant-match.js，不碰 electron，方便 node --test 直测。

import { mockFromSchema } from "./data.js";
import { flattenBodyFields } from "./variant-match.js";

/** 单个 parameter 的示例值：优先 swagger 自带的 example / examples，否则按 schema 采样 */
function sampleParameterValue(route, parameter) {
  return (
    parameter.example ??
    Object.values(parameter.examples || {})[0]?.value ??
    mockFromSchema(parameter.schema || {}, route.spec, {
      fieldName: parameter.name,
    })
  );
}

/** curl 调试弹窗用：只要 query 参数，扁平的 { name: 示例值 } */
export function getRecommendedQueryParams(route) {
  return (route.operation.parameters || []).reduce((params, parameter) => {
    if (parameter?.in !== "query" || !parameter.name) return params;
    const example = sampleParameterValue(route, parameter);
    if (example !== undefined) params[parameter.name] = example;
    return params;
  }, {});
}

/**
 * 完整请求侧 schema。parameters 保留 in/required/type/description 供表格展示；
 * body.fields 是扁平的点路径列表，直接对应变体 body 条件的写法。
 */
export function getRequestSchema(route) {
  const parameters = (route.operation.parameters || [])
    .filter((p) => p?.name && ["query", "path", "header"].includes(p.in))
    .map((parameter) => {
      let example;
      try {
        example = sampleParameterValue(route, parameter);
      } catch {
        example = undefined; // 单个参数采样失败不影响整张表
      }
      return {
        name: parameter.name,
        in: parameter.in,
        required: Boolean(parameter.required),
        type: parameter.schema?.type || parameter.type || "string",
        description: parameter.description || "",
        example,
      };
    });

  let body = null;
  const content = route.operation.requestBody?.content || {};
  const contentType =
    Object.keys(content).find((type) => type.includes("json")) ||
    Object.keys(content)[0];
  const bodySchema = contentType ? content[contentType]?.schema : null;
  if (bodySchema) {
    try {
      const sample = mockFromSchema(bodySchema, route.spec, {});
      body = {
        contentType,
        required: Boolean(route.operation.requestBody?.required),
        sample,
        fields: flattenBodyFields(sample),
      };
    } catch {
      body = null; // body schema 解析不了就当没有，不阻断参数表
    }
  }

  return {
    method: route.method.toUpperCase(),
    path: route.fullPath,
    operationId: route.operation.operationId || null,
    summary: route.operation.summary || route.operation.description || "",
    parameters,
    body,
  };
}
