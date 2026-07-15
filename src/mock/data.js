// 把 OpenAPI schema 渲染成更"真实"的 mock 数据：
// - mockFromSchema: 用 openapi-sampler 取样后，再按字段名/类型微调（如把 id 字段填成稳定数字、name 字段填中文等）
// - tunePayloadForRequest: 在最终返回前根据请求的 page/size/empty 参数调整数组长度、分页字段
import OpenAPISampler from "openapi-sampler";

export function mockFromSchema(schema, spec, options = {}) {
  const sample = OpenAPISampler.sample(
    schema,
    { skipReadOnly: false, skipWriteOnly: false },
    spec,
  );
  return enhanceSampleValue(sample, schema, spec, options);
}

export function tunePayloadForRequest(payload, request = {}) {
  const page = Number(request.query?.page || request.query?.pageIndex || 1);
  const size = Number(
    request.query?.size || request.query?.pageSize || getArrayLength(request),
  );
  const total = isTruthy(request.controls?.empty) ? 0 : Math.max(size, 1);
  return tuneValue(payload, {
    page,
    size,
    total,
    empty: isTruthy(request.controls?.empty),
  });
}

// ─── 以下为内部辅助 ──────────────────────────────────────────────────────────

function resolveSchema(schema, spec, seenRefs) {
  if (!schema || typeof schema !== "object") return {};
  if (!schema.$ref) return schema;

  if (seenRefs.has(schema.$ref)) return {};
  seenRefs.add(schema.$ref);

  if (!schema.$ref.startsWith("#/")) {
    throw new Error(`External $ref is not supported: ${schema.$ref}`);
  }

  return (
    schema.$ref
      .slice(2)
      .split("/")
      .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
      .reduce((current, key) => current?.[key], spec) || {}
  );
}

function normalizedType(schema) {
  if (schema.type) return schema.type;
  if (schema.properties || schema.additionalProperties) return "object";
  if (schema.items) return "array";
  return undefined;
}

function enhanceSampleValue(value, schema, spec, options = {}, seenRefs = new Set()) {
  const resolvedSchema = resolveSchema(schema, spec, seenRefs);

  if (resolvedSchema.enum?.length) {
    return resolvedSchema.enum[Math.floor((resolvedSchema.enum.length - 1) / 2)];
  }

  if (normalizedType(resolvedSchema) === "array") {
    return enhanceArraySample(value, resolvedSchema, spec, options, seenRefs);
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const result = {};
    const properties = resolvedSchema.properties || {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = enhanceSampleValue(
        child,
        properties[key] || {},
        spec,
        { ...options, fieldName: key },
        new Set(seenRefs),
      );
    }
    return result;
  }

  return enhanceScalarSample(value, resolvedSchema, options.fieldName);
}

function enhanceArraySample(value, schema, spec, options, seenRefs) {
  if (schema.items?.enum?.length) {
    const length = Math.min(
      getArrayLength(options.request, options.fieldName, schema),
      schema.items.enum.length,
    );
    const start = Math.floor((schema.items.enum.length - 1) / 2);
    return Array.from(
      { length },
      (_, index) => schema.items.enum[(start + index) % schema.items.enum.length],
    );
  }

  const arrayValue =
    Array.isArray(value) && value.length > 0
      ? value
      : [OpenAPISampler.sample(schema.items || {}, {}, spec)];
  const length = getArrayLength(options.request, options.fieldName, schema);
  return Array.from({ length }, (_, index) => {
    const item = arrayValue[index % arrayValue.length];
    return enhanceSampleValue(item, schema.items || {}, spec, options, new Set(seenRefs));
  });
}

function enhanceScalarSample(value, schema, fieldName = "") {
  const type = normalizedType(schema);
  if (type === "integer") return mockInteger(fieldName, value);
  if (type === "number") return mockNumber(fieldName, value);
  if (type === "string") return mockString(schema, fieldName, value);
  return value;
}

function mockInteger(fieldName = "", fallback = 1) {
  const name = String(fieldName || "").toLowerCase();
  if (name === "page") return 1;
  if (name === "size") return 20;
  if (name.includes("total") || name.includes("count")) return 40;
  if (name === "uid" || name.endsWith("uid")) return 10001;
  if (name === "id" || name.endsWith("id")) return 100;
  if (name.includes("time") || name.endsWith("at") || name.includes("date")) {
    return 1715738400000;
  }
  return fallback === 0 || fallback === undefined || fallback === null
    ? 1
    : fallback;
}

function mockNumber(fieldName = "", fallback = 1.23) {
  const name = String(fieldName || "").toLowerCase();
  if (
    name.includes("price") ||
    name.includes("amount") ||
    name.includes("cost") ||
    name.includes("fee")
  ) {
    return 99.9;
  }
  if (name.includes("ratio") || name.includes("rate")) return 0.42;
  return mockInteger(fieldName, fallback);
}

function mockString(schema, fieldName = "", fallback = "mock") {
  const name = String(fieldName || "").toLowerCase();
  switch (schema.format) {
    case "date":
      return "2026-05-15";
    case "date-time":
      return "2026-05-15T10:00:00.000Z";
    case "email":
      return "user@example.com";
    case "uuid":
      return "00000000-0000-4000-8000-000000000000";
    case "uri":
    case "url":
      return "https://example.com";
    default:
      return mockNamedString(name, fallback);
  }
}

function mockNamedString(name, fallback = "mock") {
  if (name.includes("avatar")) {
    return "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=240&h=240&fit=crop";
  }
  if (name.includes("cover") || name.includes("image") || name.includes("poster")) {
    return "https://images.unsplash.com/photo-1497366754035-f200968a6e72?w=800&h=450&fit=crop";
  }
  if (name.includes("title")) return "示例标题";
  if (name.includes("name") || name.includes("username")) return "示例用户";
  if (name.includes("desc") || name.includes("intro")) {
    return "这是一段用于联调的模拟描述";
  }
  if (name.includes("mobile") || name.includes("phone")) return "13800138000";
  if (name.includes("code")) return "SUCCESS";
  if (name.includes("url") || name.includes("link")) return "https://example.com/mock";
  if (name.includes("status")) return "ACTIVE";
  return fallback === "string" ? "mock" : fallback;
}

function getArrayLength(request = {}, fieldName = "", schema = {}) {
  if (isTruthy(request.controls?.empty)) return 0;
  if (fieldName && !isListField(fieldName)) {
    return schema.items?.enum?.length || 1;
  }
  const size = Number(
    request.query?.__mockSize || request.query?.size || request.query?.pageSize,
  );
  if (!Number.isFinite(size) || size <= 0) return 1;
  return Math.min(size, 100);
}

function isListField(fieldName = "") {
  const name = String(fieldName || "").toLowerCase();
  return (
    ["data", "list", "items", "records", "rows", "results"].includes(name) ||
    name.endsWith("list") ||
    name.endsWith("records") ||
    name.endsWith("items")
  );
}

function tuneValue(value, context) {
  if (Array.isArray(value)) {
    if (context.empty) return [];
    const length = Math.min(Math.max(context.size || value.length || 1, 1), 100);
    return Array.from({ length }, (_, index) =>
      cloneWithIndex(value[index % value.length], index),
    );
  }

  if (!value || typeof value !== "object") return value;

  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "page" && child && typeof child === "object" && !Array.isArray(child)) {
      result[key] = {
        ...child,
        page: context.page || child.page || 1,
        size: context.size || child.size || 20,
        total: context.total,
      };
      continue;
    }
    if (key === "data" && Array.isArray(child)) {
      result[key] = tuneValue(child, context);
      continue;
    }
    result[key] = tuneValue(child, context);
  }
  return result;
}

function cloneWithIndex(value, index) {
  if (Array.isArray(value)) {
    return value.map((item) => cloneWithIndex(item, index));
  }
  if (!value || typeof value !== "object") return value;

  const result = {};
  for (const [key, child] of Object.entries(value)) {
    const lowerKey = key.toLowerCase();
    if ((lowerKey === "id" || lowerKey.endsWith("id")) && typeof child === "number") {
      result[key] = child + index;
    } else if (lowerKey.includes("title") && typeof child === "string") {
      result[key] = `${child}${index + 1}`;
    } else {
      result[key] = cloneWithIndex(child, index);
    }
  }
  return result;
}

function isTruthy(value) {
  return value === true || value === "true" || value === "1" || value === 1 || value === "yes";
}

