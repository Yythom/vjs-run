// normalizeRulesForSave 的保存校验：node --test scripts/
//
// 编辑器保存、导入场景、应用场景、存入场景都走这一个函数，
// 在这里挡住「保存成功却永远不生效 / 请求时才 500」的规则。
// 只调纯函数，不触发 config store（其构造要等 app.whenReady），不碰真实用户数据。

import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeRulesForSave } from "../src/mock/service.js";
import { normalizeMockRule } from "../src/mock/rules.js";

const ok = (extra = {}) => ({ method: "GET", path: "/api/a", response: {}, ...extra });

test("缺 method / method 为 * 的规则拒绝保存（server 永远不会命中它）", () => {
  assert.throws(() => normalizeRulesForSave([ok({ method: undefined })]), /第 1 条规则（\/api\/a）缺少具体 method/);
  assert.throws(() => normalizeRulesForSave([ok(), ok({ method: "*" })]), /第 2 条规则.*缺少具体 method/);
  // 字符串简写只给得出 path
  assert.throws(() => normalizeRulesForSave(["/api/a"]), /缺少具体 method/);
});

test("path 必须以 / 开头（会编译成锚定正则匹配请求 pathname，不带 / 的永远命中不了）", () => {
  assert.throws(() => normalizeRulesForSave([ok({ path: "api/a" })]), /第 1 条规则的 path 必须以 \/ 开头：api\/a/);
  assert.throws(() => normalizeRulesForSave([ok({ path: "  " })]), /第 1 条规则缺少 path/);
  // 首尾空白去掉后再判断
  assert.equal(normalizeRulesForSave([ok({ path: " /api/a " })])[0].path, "/api/a");
});

test("status 必须在 200–599（599 以上 writeHead 抛错请求变 500；1xx 不能当最终响应，请求会挂起）", () => {
  for (const status of [0, 99, 100, 101, 199, 600, 2000, -1]) {
    assert.throws(
      () => normalizeRulesForSave([ok({ status })]),
      /status 必须在 200–599 之间/,
      `status=${status}`,
    );
  }
  assert.throws(() => normalizeRulesForSave([ok({ status: "abc" })]), /status 必须是整数/);
});

test("变体的 status 同样校验范围", () => {
  const rule = ok({
    variants: [{ name: "v", when: { query: { a: "1" } }, response: {}, status: 2000 }],
  });
  assert.throws(() => normalizeRulesForSave([rule]), /第 1 条规则的第 1 个变体的 status 必须在 200–599 之间/);
  const informational = ok({
    variants: [{ name: "v", when: { query: { a: "1" } }, response: {}, status: 101 }],
  });
  assert.throws(() => normalizeRulesForSave([informational]), /变体的 status 必须在 200–599 之间/);
});

test("合法规则照常保存：边界值 200 / 599、status 留空、method 大小写归一", () => {
  const saved = normalizeRulesForSave([
    ok({ status: 200 }),
    ok({ status: "599", path: "/api/b" }),
    ok({ status: "", method: "post", path: "/api/c" }),
  ]);
  assert.equal(saved[0].status, 200);
  assert.equal(saved[1].status, 599);
  assert.equal("status" in saved[2], false);
  assert.equal(saved[2].method, "POST");
});

test("sequence：每一项要写成 { status?, delay?, response }，少包一层 response 时报错说清楚", () => {
  assert.throws(() => normalizeRulesForSave([ok({ sequence: {} })]), /第 1 条规则的 sequence 必须是数组/);
  assert.throws(
    () => normalizeRulesForSave([ok({ sequence: [{ response: 1 }, { rc: 0, data: {} }] })]),
    /第 1 条规则的 sequence 第 2 项缺少 response（每一项写成 \{ "response": <响应体>/,
  );
  assert.throws(() => normalizeRulesForSave([ok({ sequence: ["x"] })]), /sequence 第 1 项必须是对象/);
  assert.throws(
    () => normalizeRulesForSave([ok({ sequence: [{ status: 600, response: {} }] })]),
    /sequence 第 1 项的 status 必须在 200–599 之间/,
  );
  assert.throws(
    () => normalizeRulesForSave([ok({ sequence: [{ delay: -1, response: {} }] })]),
    /sequence 第 1 项的 delay 必须是大于等于 0 的整数/,
  );
});

test("sequence：合法项按原顺序保存，只留 status / delay / response；空数组不落字段", () => {
  const [rule] = normalizeRulesForSave([
    ok({
      sequence: [
        { response: { step: 1 }, extra: "丢掉" },
        { status: "401", delay: 300, response: null },
      ],
    }),
  ]);
  assert.deepEqual(rule.sequence, [{ response: { step: 1 } }, { status: 401, delay: 300, response: null }]);
  assert.equal("sequence" in normalizeRulesForSave([ok({ sequence: [] })])[0], false);
});

test("sequence 读取路径（server 热载 / 编辑器展示）：缺 response 的项静默丢弃，不让整条规则失效", () => {
  const rule = normalizeMockRule({
    method: "GET",
    path: "/api/a",
    sequence: [{ response: 1 }, { status: 401 }, null, { status: "abc", delay: -5, response: 2 }],
  });
  assert.deepEqual(rule.sequence, [{ response: 1 }, { response: 2 }]);
  assert.equal("sequence" in normalizeMockRule({ method: "GET", path: "/api/a", sequence: [{}] }), false);
});

test("读取路径（手改的文件）：1xx / 600 以上的 status 当没写，规则、变体、sequence 一致", () => {
  const rule = normalizeMockRule({
    method: "GET",
    path: "/api/a",
    status: 150,
    response: 1,
    sequence: [{ status: 101, response: 2 }, { status: 404, response: 3 }],
    variants: [{ name: "v", when: { query: { a: "1" } }, status: 999, response: 4 }],
  });
  assert.equal(rule.status, undefined);
  assert.deepEqual(rule.sequence, [{ response: 2 }, { status: 404, response: 3 }]);
  assert.equal("status" in rule.variants[0], false);
  assert.equal(normalizeMockRule({ method: "GET", path: "/api/a", status: "503" }).status, 503);
});
