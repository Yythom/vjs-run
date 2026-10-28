// 「先用 CLI 建场景，后装 app」的兼容性：node --test scripts/
//
// 场景的写入走 vjtools mock rule（mock-rule.mjs，自带一套校验），app 读取 / 应用走
// recorder.js + service.js 的 normalizeRulesForSave（另一套校验）。两套是分开实现的，
// 这里用 CLI 造各种写法的场景，再直接调 app 的真实函数读取、应用，确认 app 既能看到、
// 也能应用，且应用时不丢字段。哪天两边校验漂移了，这里会先红。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { listScenes, readSceneRules } from "../src/mock/recorder.js";
import { readAppliedScene } from "../src/mock/applied-scene.js";
import { normalizeRulesForSave } from "../src/mock/service.js";
import { normalizeMockRule } from "../src/mock/server.js";

const CLI = fileURLToPath(new URL("../src/cli/index.js", import.meta.url));

function rule(userData, args, body) {
  const result = spawnSync(process.execPath, [CLI, "mock", "rule", ...args], {
    input: body === undefined ? "" : JSON.stringify(body),
    encoding: "utf8",
    env: { ...process.env, VJTOOLS_USER_DATA_DIR: userData, MOCK_RULES_FILE: "" },
  });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
}

/** 用 CLI 造一批覆盖各种写法的场景，返回 userData */
function buildScenesWithCli() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "cli-scenes-compat-"));
  const r = (args, body) => rule(userData, args, body);

  r(["new-scene", "--scene", "登录联调"]);
  r(["set", "--scene", "登录联调", "--method", "POST", "--path", "/api/login", "--status", "200", "--delay", "300"],
    { rc: 0, data: { token: "t" } });
  r(["set", "--scene", "登录联调", "--method", "GET", "--path", "/api/user/{id}"], { rc: 0, data: { id: 1 } });

  r(["new-scene", "--scene", "订单 回归"]);
  r(["set", "--scene", "订单 回归", "--method", "GET", "--path", "/api/orders"], { rc: 0, data: [] });
  r(["set-variant", "--scene", "订单 回归", "--method", "GET", "--path", "/api/orders",
    "--name", "分页第2页", "--when-query", "page=2"], { rc: 0, data: [{ id: 2 }] });
  r(["set-variant", "--scene", "订单 回归", "--method", "GET", "--path", "/api/orders",
    "--name", "管理员", "--when-header", "X-Role=admin", "--when-query", "scope=all",
    "--status", "200", "--delay", "100", "--disabled"], { rc: 0, data: [{ id: 9 }] });
  r(["set", "--scene", "订单 回归", "--method", "POST", "--path", "/api/orders/search"], { rc: 0, data: [] });
  r(["set-variant", "--scene", "订单 回归", "--method", "POST", "--path", "/api/orders/search",
    "--name", "按状态", "--when-body", "filter.status=1", "--when-body", "tags=[\"a\"]"], { rc: 0, data: [{ id: 3 }] });

  r(["new-scene", "--scene", "异常模拟"]);
  r(["set", "--scene", "异常模拟", "--method", "POST", "--path", "/api/pay", "--status", "500", "--delay", "3000", "--disabled"],
    { rc: 500, message: "服务异常" });
  r(["set", "--scene", "异常模拟", "--method", "DELETE", "--path", "/api/cart/1", "--status", "204"]);

  r(["apply-scene", "--scene", "登录联调"]);
  return userData;
}

function scenesDir(userData) {
  return path.join(userData, "mock-assets", "scenes");
}

// 规则对象的键顺序无关紧要，按 JSON 语义比较
function canonical(value) {
  return JSON.parse(JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
      : v,
  ));
}

test("app 的场景列表能看到 CLI 建的全部场景、条数和「当前应用中」", () => {
  const userData = buildScenesWithCli();
  const scenes = listScenes(scenesDir(userData));
  const byName = Object.fromEntries(scenes.map((s) => [s.name, s.ruleCount]));
  assert.deepEqual(byName, { 登录联调: 2, "订单 回归": 2, 异常模拟: 2 });

  const rulesFile = path.join(userData, "mock-assets", "mock-rules.json");
  assert.equal(readAppliedScene(rulesFile), "登录联调", "CLI apply-scene 写的标记 app 能认");
});

test("app 应用 CLI 建的场景：校验通过，且一个字段都不丢", () => {
  const userData = buildScenesWithCli();
  for (const { name } of listScenes(scenesDir(userData))) {
    const raw = readSceneRules(scenesDir(userData), name);
    // apply-mock-scene IPC 的同一条路径：normalizeRulesForSave(readSceneRules(...))
    const applied = normalizeRulesForSave(raw);
    assert.deepEqual(canonical(applied), canonical(raw), `场景「${name}」经 app 应用后内容有变化`);
  }
});

test("app 编辑器打开 CLI 建的场景：变体、状态码、延迟、启用状态都在", () => {
  const userData = buildScenesWithCli();
  // get-mock-scene-rules IPC：readSceneRules(...).map(normalizeMockRule)
  const rules = readSceneRules(scenesDir(userData), "订单 回归").map(normalizeMockRule);
  const orders = rules.find((r) => r.path === "/api/orders");
  assert.deepEqual(orders.variants.map((v) => v.name), ["分页第2页", "管理员"]);
  const admin = orders.variants[1];
  assert.equal(admin.enabled, false);
  assert.equal(admin.delay, 100);
  assert.deepEqual(admin.when, { headers: { "x-role": "admin" }, query: { scope: "all" } });

  const search = rules.find((r) => r.path === "/api/orders/search");
  assert.deepEqual(search.variants[0].when.body, { "filter.status": 1, tags: ["a"] });

  const pay = readSceneRules(scenesDir(userData), "异常模拟").map(normalizeMockRule)
    .find((r) => r.path === "/api/pay");
  assert.equal(pay.enabled, false);
  assert.equal(pay.status, 500);
  assert.equal(pay.delay, 3000);
});
