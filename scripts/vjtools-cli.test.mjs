// vjtools CLI（src/cli）端到端测试：node --test scripts/
//
// 真起守护进程、真发请求。每个用例独立 mkdtemp 的 VJTOOLS_USER_DATA_DIR + 内核分配的
// 空闲端口，绝不碰真实 userData 和 3002。用例结束必定 stop / kill 掉守护进程，
// 否则 detached 子进程会一直留在机器上。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startMockServer } from "../src/mock/server.js";
import { writeMockRuntime } from "../src/mock/runtime.js";

const CLI = fileURLToPath(new URL("../src/cli/index.js", import.meta.url));

// ─── 夹具 ────────────────────────────────────────────────────────────────────

function sampleSpec() {
  return {
    openapi: "3.0.0",
    info: { title: "cli-test-api", version: "1.0.0" },
    paths: {
      "/api/users": {
        get: {
          operationId: "listUsers",
          summary: "用户列表",
          responses: {
            200: {
              description: "ok",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { rc: { type: "integer" } } },
                },
              },
            },
          },
        },
      },
      "/api/orders": {
        post: { operationId: "createOrder", summary: "下单", responses: { 200: { description: "ok" } } },
      },
    },
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** 独立 userData：spec 目录 + 指向空闲端口的 config.json */
async function setup({ withSpec = true, extraConfig = {} } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "vjtools-cli-test-"));
  const specDir = path.join(userData, "specs");
  if (withSpec) {
    fs.mkdirSync(specDir);
    fs.writeFileSync(path.join(specDir, "api.json"), JSON.stringify(sampleSpec()));
  }
  const port = await freePort();
  const config = {
    mockSpecPath: withSpec ? specDir : "",
    mockHost: "127.0.0.1",
    mockPort: port,
    mockAll: true,
    ...extraConfig,
  };
  fs.writeFileSync(path.join(userData, "config.json"), JSON.stringify(config, null, "\t"));
  return { userData, port, base: `http://127.0.0.1:${port}` };
}

// 必须异步：「模拟 app」的用例里 mock server 跑在本测试进程内，spawnSync 会卡住事件循环，
// server 回不了 CLI 的 health 探测
function run(ctx, args, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, VJTOOLS_USER_DATA_DIR: ctx.userData, MOCK_RULES_FILE: "" },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(stdin ?? "");
  });
}

function runtimeFile(ctx) {
  return path.join(ctx.userData, "mock-assets", "mock-runtime.json");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** 用例收尾：先礼后兵，stop 不掉就按运行记录直接 kill */
async function cleanup(ctx) {
  await run(ctx, ["mock", "stop"]);
  try {
    process.kill(readJson(runtimeFile(ctx)).pid, "SIGKILL");
  } catch {}
}

async function waitFor(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

// ─── 用例 ────────────────────────────────────────────────────────────────────

test("start → 请求 → history → stop：完整生命周期，运行记录随之写入 / 清除", async (t) => {
  const ctx = await setup();
  t.after(() => cleanup(ctx));

  const started = await run(ctx, ["mock", "start"]);
  assert.equal(started.code, 0, started.err);
  assert.match(started.out, /已在后台启动/);

  const info = readJson(runtimeFile(ctx));
  assert.equal(info.owner, "cli");
  assert.equal(info.url, ctx.base);

  const status = await run(ctx, ["mock", "status", "--json"]);
  assert.equal(status.code, 0);
  const parsed = JSON.parse(status.out);
  assert.equal(parsed.running, true);
  assert.equal(parsed.pid, info.pid);
  assert.equal(parsed.routes, 2);

  const res = await fetch(`${ctx.base}/api/users?page=2`);
  assert.equal(res.status, 200);

  const history = await run(ctx, ["mock", "history", "--json"]);
  assert.equal(history.code, 0, history.err);
  const entries = JSON.parse(history.out);
  assert.equal(entries[0].path, "/api/users");
  assert.equal(entries[0].kind, "mock");
  assert.deepEqual(entries[0].query, { page: "2" });

  const one = await run(ctx, ["mock", "history", "--id", String(entries[0].id)]);
  assert.equal(JSON.parse(one.out).id, entries[0].id);

  const stopped = await run(ctx, ["mock", "stop"]);
  assert.equal(stopped.code, 0, stopped.err);
  assert.equal(fs.existsSync(runtimeFile(ctx)), false);

  const after = await run(ctx, ["mock", "status"]);
  assert.equal(after.code, 3, "未运行时 status 退出码为 3");
});

test("重复 start 不会起第二个实例", async (t) => {
  const ctx = await setup();
  t.after(() => cleanup(ctx));

  assert.equal((await run(ctx, ["mock", "start"])).code, 0);
  const pid = readJson(runtimeFile(ctx)).pid;

  const again = await run(ctx, ["mock", "start"]);
  assert.equal(again.code, 0);
  assert.match(again.out, /已经在运行/);
  assert.equal(readJson(runtimeFile(ctx)).pid, pid);
});

test("运行中改 config.json 的端口，守护进程自动重启到新端口", async (t) => {
  const ctx = await setup();
  t.after(() => cleanup(ctx));

  assert.equal((await run(ctx, ["mock", "start"])).code, 0);
  const pid = readJson(runtimeFile(ctx)).pid;
  const nextPort = await freePort();

  const changed = await run(ctx, ["mock", "config", "--port", String(nextPort)]);
  assert.equal(changed.code, 0, changed.err);

  const moved = await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${nextPort}/__mock/health`);
      return res.ok && (await res.json()).pid === pid;
    } catch {
      return false;
    }
  });
  assert.ok(moved, "守护进程应在新端口上重新监听");
  assert.equal(readJson(runtimeFile(ctx)).port, nextPort);
});

test("config 只改 mock 字段，config.json 里其它字段（含 CLI 不认识的）原样保留", async () => {
  const ctx = await setup({ extraConfig: { sidebarWidth: 300, someFutureField: { a: 1 } } });

  const res = await run(ctx, [
    "mock", "config",
    "--backend", "http://127.0.0.1:9999/api",
    "--swagger-server", "http://swagger.test/t2",
    "--mock-all", "false",
  ]);
  assert.equal(res.code, 0, res.err);

  const saved = readJson(path.join(ctx.userData, "config.json"));
  assert.equal(saved.mockBackendBaseUrl, "http://127.0.0.1:9999/api/", "后端地址补尾部斜杠，与 normalize.js 一致");
  assert.equal(saved.mockSwaggerServer, "http://swagger.test/t2");
  assert.equal(saved.mockAll, false);
  assert.equal(saved.sidebarWidth, 300);
  assert.deepEqual(saved.someFutureField, { a: 1 });

  const bad = await run(ctx, ["mock", "config", "--port", "abc"]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /--port/);
});

test("没有 spec 时 start 直接失败并给出下一步，不留运行记录", async () => {
  const ctx = await setup({ withSpec: false });
  const res = await run(ctx, ["mock", "start"]);
  assert.equal(res.code, 1);
  assert.match(res.err, /vjtools mock gen/);
  assert.equal(fs.existsSync(runtimeFile(ctx)), false);
});

test("端口被非 mock 程序占用：start 报端口占用，不去杀占用者", async (t) => {
  const ctx = await setup();
  const blocker = net.createServer().listen(ctx.port, "127.0.0.1");
  await new Promise((resolve) => blocker.once("listening", resolve));
  t.after(() => blocker.close());

  const res = await run(ctx, ["mock", "start"]);
  assert.equal(res.code, 1);
  assert.match(res.err, /已被占用/);
  assert.ok(blocker.listening, "占用端口的进程必须还活着");
});

test("app 在跑的 mock：CLI start 视为已运行，stop 拒绝并提示去 app 里停", async (t) => {
  const ctx = await setup();
  // 模拟 app：本进程起 server + 写 owner=app 的运行记录（app 的 health pid 就是主进程 pid）
  const handle = await startMockServer({
    specPath: path.join(ctx.userData, "specs"),
    host: "127.0.0.1",
    port: ctx.port,
    mockAll: true,
  });
  writeMockRuntime(path.join(ctx.userData, "mock-assets"), {
    pid: process.pid,
    owner: "app",
    host: "127.0.0.1",
    port: ctx.port,
  });
  t.after(async () => {
    await Promise.all(handle.watchers.map((w) => w.close()));
    await new Promise((resolve) => handle.server.close(resolve));
  });

  const started = await run(ctx, ["mock", "start"]);
  assert.equal(started.code, 0);
  assert.match(started.out, /vjtools app/);

  const stopped = await run(ctx, ["mock", "stop"]);
  assert.equal(stopped.code, 1);
  assert.match(stopped.err, /app 里停止/);
  assert.ok(handle.server.listening, "app 的 mock 不能被 CLI 停掉");
});

test("运行记录残留（pid 已不存在）：start 照常启动并覆盖记录", async (t) => {
  const ctx = await setup();
  t.after(() => cleanup(ctx));
  const dead = spawnSync(process.execPath, ["-e", "process.pid"]).pid;
  fs.mkdirSync(path.join(ctx.userData, "mock-assets"), { recursive: true });
  fs.writeFileSync(
    runtimeFile(ctx),
    JSON.stringify({ pid: dead, owner: "cli", host: "127.0.0.1", port: ctx.port, url: ctx.base }),
  );

  const res = await run(ctx, ["mock", "start"]);
  assert.equal(res.code, 0, res.err);
  assert.notEqual(readJson(runtimeFile(ctx)).pid, dead);
});

test("routes 搜索 + rule 写的是 userData 里那份活动规则文件", async () => {
  const ctx = await setup();

  const routes = await run(ctx, ["mock", "routes", "下单", "--json"]);
  assert.equal(routes.code, 0, routes.err);
  const parsed = JSON.parse(routes.out);
  assert.equal(parsed.total, 2);
  assert.deepEqual(parsed.routes.map((r) => `${r.method} ${r.path}`), ["POST /api/orders"]);

  const set = await run(
    ctx,
    ["mock", "rule", "set", "--method", "GET", "--path", "/api/users", "--status", "200"],
    JSON.stringify({ rc: 0, data: [] }),
  );
  assert.equal(set.code, 0, set.err);
  const rules = readJson(path.join(ctx.userData, "mock-assets", "mock-rules.json"));
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].response, { rc: 0, data: [] });

  const unknown = await run(ctx, ["mock", "rules"]);
  assert.equal(unknown.code, 1);
});

test("命令行解析边界：拼错子命令给提示、缺值不写盘、可重复参数缺值不崩", async () => {
  const ctx = await setup();
  const configFile = path.join(ctx.userData, "config.json");
  const before = fs.readFileSync(configFile, "utf8");

  const typo = await run(ctx, ["mock", "statuss"]);
  assert.equal(typo.code, 1);
  assert.match(typo.err, /unknown command 'statuss'/);
  assert.match(typo.err, /Did you mean status/);

  const bare = await run(ctx, ["mock"]);
  assert.equal(bare.code, 0, "只敲分组命令时打印帮助、正常退出");
  assert.match(bare.out + bare.err, /Usage: vjtools mock/);

  for (const flag of ["--port", "--spec-dir", "--host", "--service-address"]) {
    const missing = await run(ctx, ["mock", "config", flag]);
    assert.equal(missing.code, 1, flag);
    assert.match(missing.err, new RegExp(`${flag} 需要一个值`));
  }
  assert.equal(fs.readFileSync(configFile, "utf8"), before, "缺值的 config 命令不能改动配置");

  assert.equal((await run(ctx, ["mock", "rule", "set", "--method=GET", "--path=/api/users"], '{"v":1}')).code, 0);
  const dangling = await run(
    ctx,
    ["mock", "rule", "set-variant", "--method", "GET", "--path", "/api/users", "--name", "v", "--when-query", "p=1", "--when-query"],
    '{"v":2}',
  );
  assert.equal(dangling.code, 1);
  assert.match(dangling.err, /--when-query 需要 key=value 形式/);
  assert.doesNotMatch(dangling.err, /TypeError/);
});

// ─── describe / sample / set --from-history / save-scene ───────────────────

/** 带参数、请求体、响应 schema 的接口，追加到 ctx 的 spec 目录 */
function addItemsSpec(ctx) {
  const json = (properties) => ({
    description: "ok",
    content: { "application/json": { schema: { type: "object", properties } } },
  });
  fs.writeFileSync(
    path.join(ctx.userData, "specs", "items.json"),
    JSON.stringify({
      openapi: "3.0.0",
      info: { title: "items", version: "1" },
      paths: {
        "/api/items/{id}": {
          get: {
            summary: "商品详情",
            parameters: [
              { name: "id", in: "path", required: true, schema: { type: "integer" } },
              { name: "page", in: "query", description: "页码", schema: { type: "integer" } },
            ],
            responses: { 200: json({ rc: { type: "integer" }, data: { type: "object", properties: { name: { type: "string" } } } }) },
          },
        },
        "/api/items": {
          post: {
            summary: "新建商品",
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "object", properties: { title: { type: "string" }, tags: { type: "array", items: { type: "string" } } } },
                },
              },
            },
            responses: { 200: json({ rc: { type: "integer" } }) },
          },
        },
      },
    }),
  );
}

test("describe / sample：列出参数、请求体与推荐响应，找不到接口给出提示", async () => {
  const ctx = await setup();
  addItemsSpec(ctx);

  const described = await run(ctx, ["mock", "describe", "--method", "GET", "--path", "/api/items/{id}", "--json"]);
  assert.equal(described.code, 0, described.err);
  const info = JSON.parse(described.out);
  assert.deepEqual(info.parameters.map((p) => `${p.in}:${p.name}`), ["path:id", "query:page"]);
  assert.equal(info.parameters[1].description, "页码");
  assert.equal(info.sample.rc, 0, "推荐响应带信封");
  assert.ok("name" in info.sample.data);

  const body = JSON.parse((await run(ctx, ["mock", "describe", "-m", "POST", "-p", "/api/items", "--json"])).out).body;
  assert.deepEqual(body.fields.map((f) => f.path), ["title", "tags.0"]);

  // 具体路径也能匹配到模板，sample 输出可直接 JSON.parse 喂给 rule set
  const sampled = await run(ctx, ["mock", "sample", "--method", "GET", "--path", "/api/items/7"]);
  assert.equal(sampled.code, 0, sampled.err);
  assert.equal(JSON.parse(sampled.out).code, "SUCCESS");

  const human = await run(ctx, ["mock", "describe", "--method", "GET", "--path", "/api/items/{id}"]);
  assert.match(human.out, /query\s+page\s+integer\s+页码/);

  const missing = await run(ctx, ["mock", "sample", "--method", "GET", "--path", "/api/nope"]);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /vjtools mock routes/);
});

test("rule set --from-history：把真实后端的响应存成规则（模板路径、非 200 状态码随之保存）", async (t) => {
  const backend = http.createServer((req, res) => {
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ rc: 0, data: { name: "真实数据", url: req.url } }));
  });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const ctx = await setup({
    extraConfig: { mockAll: false, mockBackendBaseUrl: `http://127.0.0.1:${backend.address().port}` },
  });
  addItemsSpec(ctx);
  t.after(async () => {
    await cleanup(ctx);
    backend.close();
  });

  // 没在跑时读不到历史
  const notRunning = await run(ctx, ["mock", "rule", "set", "--scene", "真实", "--from-history", "1"]);
  assert.equal(notRunning.code, 3);

  assert.equal((await run(ctx, ["mock", "start"])).code, 0);
  const proxied = await fetch(`${ctx.base}/api/items/7`);
  assert.equal(proxied.headers.get("x-mock-source"), "proxy");
  const [entry] = JSON.parse((await run(ctx, ["mock", "history", "--json"])).out);

  const saved = await run(ctx, ["mock", "rule", "set", "--scene", "真实", "--from-history", String(entry.id)]);
  assert.equal(saved.code, 0, saved.err);
  assert.match(saved.out, new RegExp(`取自请求历史 #${entry.id}`));
  const [rule] = readJson(path.join(ctx.userData, "mock-assets", "scenes", "真实.json"));
  assert.equal(rule.method, "GET");
  assert.equal(rule.path, "/api/items/{id}", "命中过 swagger 的用模板路径");
  assert.equal(rule.status, 201, "非 200 的真实状态码一起保存");
  assert.deepEqual(rule.response, { rc: 0, data: { name: "真实数据", url: "/api/items/7" } });

  // --path 可以改存到别处
  await run(ctx, ["mock", "rule", "set", "--scene", "真实", "--from-history", String(entry.id), "--path", "/api/items/8"]);
  assert.deepEqual(
    readJson(path.join(ctx.userData, "mock-assets", "scenes", "真实.json")).map((r) => r.path),
    ["/api/items/{id}", "/api/items/8"],
  );

  const unknown = await run(ctx, ["mock", "rule", "set", "--scene", "真实", "--from-history", "9999"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /没有编号为 9999 的请求/);
});

test("rule save-scene：活动规则存成场景快照；同名需 --force；活动规则损坏时不存空场景", async () => {
  const ctx = await setup();
  const sceneFile = path.join(ctx.userData, "mock-assets", "scenes", "备份.json");
  const rulesFile = path.join(ctx.userData, "mock-assets", "mock-rules.json");

  await run(ctx, ["mock", "rule", "set", "--method", "GET", "--path", "/api/users", "--status", "500"], '{"rc":500}');
  const saved = await run(ctx, ["mock", "rule", "save-scene", "--scene", "备份"]);
  assert.equal(saved.code, 0, saved.err);
  assert.deepEqual(readJson(sceneFile), [
    { method: "GET", path: "/api/users", response: { rc: 500 }, status: 500, enabled: true },
  ]);

  const dup = await run(ctx, ["mock", "rule", "save-scene", "--scene", "备份"]);
  assert.equal(dup.code, 1);
  assert.match(dup.err, /场景已存在/);

  await run(ctx, ["mock", "rule", "rm", "--method", "GET", "--path", "/api/users"]);
  assert.equal((await run(ctx, ["mock", "rule", "save-scene", "--scene", "备份", "--force"])).code, 0);
  assert.deepEqual(readJson(sceneFile), []);

  fs.writeFileSync(rulesFile, "{坏的");
  const broken = await run(ctx, ["mock", "rule", "save-scene", "--scene", "坏"]);
  assert.equal(broken.code, 1);
  assert.equal(fs.existsSync(path.join(ctx.userData, "mock-assets", "scenes", "坏.json")), false);
});
