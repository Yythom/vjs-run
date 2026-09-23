// normalizeRulesForSave 的保存校验：node --test scripts/
//
// 编辑器保存、导入场景、应用场景、存入场景都走这一个函数，
// 在这里挡住「保存成功却永远不生效 / 请求时才 500」的规则。
// 只调纯函数，不触发 config store（其构造要等 app.whenReady），不碰真实用户数据。

import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeRulesForSave } from "../src/mock/service.js";

const ok = (extra = {}) => ({ method: "GET", path: "/api/a", response: {}, ...extra });

test("缺 method / method 为 * 的规则拒绝保存（server 永远不会命中它）", () => {
  assert.throws(() => normalizeRulesForSave([ok({ method: undefined })]), /第 1 条规则（\/api\/a）缺少具体 method/);
  assert.throws(() => normalizeRulesForSave([ok(), ok({ method: "*" })]), /第 2 条规则.*缺少具体 method/);
  // 字符串简写只给得出 path
  assert.throws(() => normalizeRulesForSave(["/api/a"]), /缺少具体 method/);
});

test("status 必须在 100–599（范围外 writeHead 会抛错，请求变 500）", () => {
  for (const status of [0, 99, 600, 2000, -1]) {
    assert.throws(
      () => normalizeRulesForSave([ok({ status })]),
      /status 必须在 100–599 之间/,
      `status=${status}`,
    );
  }
  assert.throws(() => normalizeRulesForSave([ok({ status: "abc" })]), /status 必须是整数/);
});

test("变体的 status 同样校验范围", () => {
  const rule = ok({
    variants: [{ name: "v", when: { query: { a: "1" } }, response: {}, status: 2000 }],
  });
  assert.throws(() => normalizeRulesForSave([rule]), /第 1 条规则的第 1 个变体的 status 必须在 100–599 之间/);
});

test("合法规则照常保存：边界值 100 / 599、status 留空、method 大小写归一", () => {
  const saved = normalizeRulesForSave([
    ok({ status: 100 }),
    ok({ status: "599", path: "/api/b" }),
    ok({ status: "", method: "post", path: "/api/c" }),
  ]);
  assert.equal(saved[0].status, 100);
  assert.equal(saved[1].status, 599);
  assert.equal("status" in saved[2], false);
  assert.equal(saved[2].method, "POST");
});
