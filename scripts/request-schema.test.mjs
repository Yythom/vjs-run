// request-schema.js（编辑器「请求参数」面板的数据源）测试：node --test scripts/
// 走真实的 buildRoutes 管线构造 route，确保和 mock server 看到的是同一个结构。

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRoutes } from "../src/mock/server.js";
import {
  getRequestSchema,
  getRecommendedQueryParams,
} from "../src/mock/request-schema.js";

function routeFrom(operation, { method = "post", path = "/api/orders" } = {}) {
  const spec = {
    openapi: "3.0.0",
    info: { title: "t", version: "1" },
    paths: { [path]: { [method]: operation } },
  };
  const routes = buildRoutes(spec, "test.json", "");
  assert.equal(routes.length, 1, "buildRoutes 应产出一条路由");
  return routes[0];
}

test("parameters：query/path/header 全收，保留 required/type/description", () => {
  const schema = getRequestSchema(
    routeFrom({
      parameters: [
        {
          name: "page",
          in: "query",
          required: true,
          description: "页码",
          schema: { type: "integer" },
          example: 2,
        },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        { name: "X-Role", in: "header", schema: { type: "string" }, example: "admin" },
      ],
      responses: {},
    }),
  );

  // in / required / type / 顺序：逐项写死期望
  assert.deepEqual(
    schema.parameters.map((p) => [p.name, p.in, p.required, p.type]),
    [
      ["page", "query", true, "integer"],
      ["id", "path", true, "string"],
      ["X-Role", "header", false, "string"],
    ],
  );
  assert.equal(schema.parameters[0].description, "页码");
  // 显式给了 example 的按原值返回
  assert.equal(schema.parameters[0].example, 2);
  assert.equal(schema.parameters[2].example, "admin");
  // 没给 example 的走 schema 采样，值不确定但必须有值且类型正确
  assert.equal(typeof schema.parameters[1].example, "string");
});

test("parameters：cookie 等其它 in 被过滤，无名参数被跳过", () => {
  const schema = getRequestSchema(
    routeFrom({
      parameters: [
        { name: "sid", in: "cookie", schema: { type: "string" } },
        { in: "query", schema: { type: "string" } }, // 无 name
        { name: "ok", in: "query", schema: { type: "string" } },
      ],
      responses: {},
    }),
  );
  assert.deepEqual(schema.parameters.map((p) => p.name), ["ok"]);
});

test("parameters：example 优先于 examples，examples 优先于 schema 采样", () => {
  const schema = getRequestSchema(
    routeFrom({
      parameters: [
        { name: "a", in: "query", schema: { type: "string" }, example: "直接" },
        {
          name: "b",
          in: "query",
          schema: { type: "string" },
          examples: { first: { value: "来自examples" } },
        },
      ],
      responses: {},
    }),
  );
  const byName = Object.fromEntries(schema.parameters.map((p) => [p.name, p.example]));
  assert.equal(byName.a, "直接");
  assert.equal(byName.b, "来自examples");
});

test("requestBody：采样并扁平成点路径字段，带 contentType/required", () => {
  const schema = getRequestSchema(
    routeFrom({
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                keyword: { type: "string" },
                filter: {
                  type: "object",
                  properties: { type: { type: "string" }, level: { type: "integer" } },
                },
              },
            },
          },
        },
      },
      responses: {},
    }),
  );

  assert.equal(schema.body.contentType, "application/json");
  assert.equal(schema.body.required, true);
  const paths = schema.body.fields.map((f) => f.path);
  assert.deepEqual(paths, ["keyword", "filter.type", "filter.level"]);
});

test("requestBody：没有 requestBody 时 body 为 null，不影响 parameters", () => {
  const schema = getRequestSchema(
    routeFrom({
      parameters: [{ name: "page", in: "query", schema: { type: "integer" } }],
      responses: {},
    }),
  );
  assert.equal(schema.body, null);
  assert.equal(schema.parameters.length, 1);
});

test("响应侧没有任何 schema 也能正常返回请求参数（与 previewMockResponse 解耦）", () => {
  const schema = getRequestSchema(
    routeFrom({
      parameters: [{ name: "page", in: "query", schema: { type: "integer" } }],
      responses: {}, // 完全没有响应定义
    }),
  );
  assert.equal(schema.parameters.length, 1);
  assert.equal(schema.method, "POST");
  assert.equal(schema.path, "/api/orders");
});

test("getRecommendedQueryParams：只取 query，扁平 name→示例值", () => {
  const route = routeFrom({
    parameters: [
      { name: "page", in: "query", schema: { type: "integer" }, example: 2 },
      { name: "id", in: "path", schema: { type: "string" }, example: "x" },
      { name: "X-Role", in: "header", schema: { type: "string" }, example: "admin" },
    ],
    responses: {},
  });
  assert.deepEqual(getRecommendedQueryParams(route), { page: 2 });
});

test("getRequestSchema：参数采样失败或 body 解析失败时，优雅降级不阻断其它字段", () => {
  const schema = getRequestSchema(
    routeFrom({
      parameters: [
        {
          name: "good-param",
          in: "query",
          schema: { type: "string" },
          example: "ok",
        },
        {
          name: "bad-param",
          in: "query",
          // 构造一个不合法的 $ref 导致 mockFromSchema 内部抛错
          schema: { $ref: "external.json" },
        },
      ],
      requestBody: {
        content: {
          "application/json": {
            // 构造一个不合法的 $ref 导致 mockFromSchema 内部抛错
            schema: { $ref: "external.json" },
          },
        },
      },
      responses: {},
    }),
  );

  // 1. bad-param 采样失败，其 example 应为 undefined，但不能导致整个 parameters 返回失败或报错
  const good = schema.parameters.find((p) => p.name === "good-param");
  assert.equal(good?.example, "ok");

  const bad = schema.parameters.find((p) => p.name === "bad-param");
  assert.ok(bad);
  assert.equal(bad.example, undefined);

  // 2. body 采样失败，其 body 字段应优雅降为 null，而不影响其它 query 参数的正常提取
  assert.equal(schema.body, null);
});

