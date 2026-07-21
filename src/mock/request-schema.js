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

function resolveRef(schema, spec, seenRefs) {
  if (!schema || typeof schema !== "object") return schema;
  if (!schema.$ref) return schema;
  if (seenRefs.has(schema.$ref)) return {};
  seenRefs.add(schema.$ref);
  if (!schema.$ref.startsWith("#/")) return schema;
  return (
    schema.$ref
      .slice(2)
      .split("/")
      .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
      .reduce((current, key) => current?.[key], spec) || schema
  );
}

function extractBodyDescriptions(schema, spec, prefix = "", seenRefs = new Set()) {
  if (!schema || typeof schema !== "object") return {};
  
  // 保留 $ref 包装层上的 description / title / summary
  const outerDesc = schema.description || schema.title || schema.summary;
  const resolved = resolveRef(schema, spec, seenRefs);
  const innerDesc = resolved.description || resolved.title || resolved.summary;
  const commentText = outerDesc || innerDesc || "";

  const out = {};
  if (prefix && commentText) {
    out[prefix] = commentText;
  }

  if (resolved.allOf && Array.isArray(resolved.allOf)) {
    for (const item of resolved.allOf) {
      Object.assign(out, extractBodyDescriptions(item, spec, prefix, new Set(seenRefs)));
    }
  }

  if (resolved.type === "array" && resolved.items) {
    Object.assign(out, extractBodyDescriptions(resolved.items, spec, prefix ? `${prefix}.0` : "0", new Set(seenRefs)));
  } else if (resolved.properties) {
    for (const [key, childSchema] of Object.entries(resolved.properties)) {
      const path = prefix ? `${prefix}.${key}` : key;
      Object.assign(out, extractBodyDescriptions(childSchema, spec, path, new Set(seenRefs)));
    }
  }
  return out;
}

/**
 * 完整请求侧 schema。parameters 保留 in/required/type/description 供表格展示；
 * body.fields 是扁平的点路径列表，带对应字段的 description。
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
    Object.keys(content)[0] ||
    "application/json";

  const bodyParam = (route.operation.parameters || []).find((p) => p?.in === "body");
  const bodySchema =
    (contentType && content[contentType]?.schema) ||
    (content && Object.values(content)[0]?.schema) ||
    bodyParam?.schema;

  if (bodySchema) {
    try {
      const sample = mockFromSchema(bodySchema, route.spec, {});
      const descriptions = extractBodyDescriptions(bodySchema, route.spec);
      const fields = flattenBodyFields(sample).map((f) => ({
        ...f,
        description: descriptions[f.path] || "",
      }));
      body = {
        contentType,
        required: Boolean(route.operation.requestBody?.required),
        sample,
        fields,
        descriptions,
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
