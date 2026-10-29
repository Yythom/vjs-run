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
import { mockLanUrls, writeMockRuntime } from "../src/mock/runtime.js";

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
  assert.match(changed.out, new RegExp(`已按新配置重启：http://127\\.0\\.0\\.1:${nextPort}`), "config 等重启完才返回");

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

test("--host：[::1] 去掉方括号；带协议或端口的拒绝且不写盘", async () => {
  const ctx = await setup();
  const configFile = path.join(ctx.userData, "config.json");

  assert.equal((await run(ctx, ["mock", "config", "--host", "[::1]"])).code, 0);
  assert.equal(readJson(configFile).mockHost, "::1");
  assert.equal((await run(ctx, ["mock", "config", "--host", "localhost"])).code, 0);

  for (const bad of ["127.0.0.1:3002", "http://127.0.0.1", "local host"]) {
    const res = await run(ctx, ["mock", "config", "--host", bad]);
    assert.equal(res.code, 1, bad);
    assert.match(res.err, /只填地址本身/);
    assert.equal(readJson(configFile).mockHost, "localhost", `${bad} 不能写进配置`);
  }
});

test("init：默认 spec 目录顺手建好，之后 routes 提示「还没有 OpenAPI 文件」而不是「目录不存在」", async () => {
  const ctx = await setup({ withSpec: false });
  const res = await run(ctx, ["mock", "init"]);
  assert.equal(res.code, 0, res.err);
  const specDir = path.join(ctx.userData, "mock-specs");
  assert.equal(fs.statSync(specDir).isDirectory(), true);

  const routes = await run(ctx, ["mock", "routes"]);
  assert.equal(routes.code, 1);
  assert.match(routes.err, /还没有 OpenAPI 文件/);
});

test("init：mock 在跑时改了端口，和 config 一样等它按新配置重启完再返回", async (t) => {
  const ctx = await setup();
  t.after(() => cleanup(ctx));
  assert.equal((await run(ctx, ["mock", "start"])).code, 0);
  const nextPort = await freePort();
  const res = await run(ctx, ["mock", "init", "--port", String(nextPort)]);
  assert.equal(res.code, 0, res.err);
  assert.match(res.out, new RegExp(`已按新配置重启：http://127\\.0\\.0\\.1:${nextPort}`));
});

test("restart：新进程起不来（spec 目录没了 / 配置写坏）时先报错，不把正常跑着的 mock 停掉", async (t) => {
  const ctx = await setup();
  t.after(() => cleanup(ctx));
  assert.equal((await run(ctx, ["mock", "start"])).code, 0);
  const { pid } = readJson(runtimeFile(ctx));
  const stillServing = async () => (await (await fetch(`${ctx.base}/__mock/health`)).json()).pid === pid;

  // spec 目录被挪走：配置没变，守护进程照跑（spec 已加载），但新进程起不来
  const specDir = path.join(ctx.userData, "specs");
  fs.renameSync(specDir, `${specDir}.bak`);
  const noSpec = await run(ctx, ["mock", "restart"]);
  assert.equal(noSpec.code, 1);
  assert.match(noSpec.err, /spec 目录不存在/);
  assert.doesNotMatch(noSpec.out, /已停止/);
  assert.ok(await stillServing(), "原来的 mock 还在跑");
  fs.renameSync(`${specDir}.bak`, specDir);

  const configFile = path.join(ctx.userData, "config.json");
  const good = fs.readFileSync(configFile, "utf8");
  fs.writeFileSync(configFile, "{ 坏掉的 JSON");
  const badConfig = await run(ctx, ["mock", "restart"]);
  assert.equal(badConfig.code, 1);
  assert.match(badConfig.err, /不是合法 JSON/);
  fs.writeFileSync(configFile, good);
  assert.ok(await stillServing(), "原来的 mock 还在跑");
});

test("startDaemon：可执行文件不存在时报错返回，不让 spawn 的 error 事件把调用方（app 主进程）崩掉", async () => {
  const ctx = await setup();
  const { startDaemon } = await import("../src/cli/mock-daemon.js");
  const { cliPaths } = await import("../src/cli/user-data.js");
  await assert.rejects(
    startDaemon({ paths: cliPaths(ctx.userData), execPath: path.join(ctx.userData, "no-such-node"), env: process.env }),
    /无法运行/,
  );
});

test("config.json 写坏了：守护进程照跑，logs / history / stop 照样能用（只靠运行记录找进程）", async (t) => {
  const ctx = await setup();
  t.after(() => cleanup(ctx));
  assert.equal((await run(ctx, ["mock", "start"])).code, 0);
  const { pid } = readJson(runtimeFile(ctx));

  fs.writeFileSync(path.join(ctx.userData, "config.json"), "{ 坏掉的 JSON");
  const logs = await run(ctx, ["mock", "logs", "-n", "5"]);
  assert.equal(logs.code, 0, logs.err);
  const history = await run(ctx, ["mock", "history"]);
  assert.equal(history.code, 0, history.err);

  const stopped = await run(ctx, ["mock", "stop"]);
  assert.equal(stopped.code, 0, stopped.err);
  assert.match(stopped.out, new RegExp(`已停止（pid ${pid}）`));
  assert.ok(await waitFor(() => !fs.existsSync(runtimeFile(ctx))), "运行记录随之清除");
});

test("前台 serve 运行时 logs 不打以前后台运行残留的旧日志", async (t) => {
  const ctx = await setup();
  fs.mkdirSync(path.join(ctx.userData, "logs"));
  fs.writeFileSync(path.join(ctx.userData, "logs", "mock-cli.log"), "很久以前的旧日志 ■ mock 已停止\n");
  const serve = spawn(process.execPath, [CLI, "mock", "serve"], {
    env: { ...process.env, VJTOOLS_USER_DATA_DIR: ctx.userData, MOCK_RULES_FILE: "" },
  });
  t.after(() => serve.kill("SIGKILL"));
  assert.ok(await waitFor(() => fs.existsSync(runtimeFile(ctx))), "前台 serve 应写入运行记录");

  const logs = await run(ctx, ["mock", "logs"]);
  assert.equal(logs.code, 0, logs.err);
  assert.match(logs.out, /前台运行/);
  assert.doesNotMatch(logs.out, /很久以前的旧日志/);
});

test("运行中 config 改出起不来的配置：命令如实报重启失败，而不是报成功", async (t) => {
  const ctx = await setup();
  t.after(() => cleanup(ctx));
  assert.equal((await run(ctx, ["mock", "start"])).code, 0);

  const busyPort = await freePort();
  const blocker = net.createServer().listen(busyPort, "127.0.0.1");
  await new Promise((resolve) => blocker.once("listening", resolve));
  t.after(() => blocker.close());

  const res = await run(ctx, ["mock", "config", "--port", String(busyPort)]);
  assert.equal(res.code, 1, res.out);
  assert.match(res.err, /重启失败/);
  assert.match(res.err, /已被占用/, "带上日志里的失败原因");
  assert.equal(readJson(path.join(ctx.userData, "config.json")).mockPort, busyPort, "配置照常写入");
  assert.equal((await run(ctx, ["mock", "status"])).code, 3);
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

test("监听 0.0.0.0：status 说明是所有网卡，地址行仍给本机可访问的 127.0.0.1", async (t) => {
  const ctx = await setup();
  // 真绑 0.0.0.0 会触发系统防火墙弹窗：server 只绑回环，运行记录里写 0.0.0.0（和真实后台进程写的一致）
  const handle = await startMockServer({
    specPath: path.join(ctx.userData, "specs"),
    host: "127.0.0.1",
    port: ctx.port,
    mockAll: true,
  });
  writeMockRuntime(path.join(ctx.userData, "mock-assets"), {
    pid: process.pid,
    owner: "cli",
    host: "0.0.0.0",
    port: ctx.port,
  });
  t.after(async () => {
    await Promise.all(handle.watchers.map((w) => w.close()));
    await new Promise((resolve) => handle.server.close(resolve));
  });

  const status = await run(ctx, ["mock", "status"]);
  assert.equal(status.code, 0, status.err);
  assert.match(status.out, new RegExp(`运行中 http://127\\.0\\.0\\.1:${ctx.port}`));
  assert.match(status.out, new RegExp(`监听 +0\\.0\\.0\\.0:${ctx.port}（所有网卡）`));

  const json = JSON.parse((await run(ctx, ["mock", "status", "--json"])).out);
  assert.equal(json.host, "0.0.0.0");
  assert.deepEqual(json.lanUrls, mockLanUrls("0.0.0.0", ctx.port));
});

test("监听 IPv6 回环 ::1：start 能等到健康检查，status 地址带方括号", async (t) => {
  const ctx = await setup({ extraConfig: { mockHost: "::1" } });
  const probe = net.createServer();
  const ipv6 = await new Promise((resolve) => {
    probe.once("error", () => resolve(false));
    probe.listen(ctx.port, "::1", () => probe.close(() => resolve(true)));
  });
  if (!ipv6) return t.skip("本机不支持 IPv6 回环");
  t.after(() => cleanup(ctx));

  const started = await run(ctx, ["mock", "start"]);
  assert.equal(started.code, 0, started.err);
  const status = await run(ctx, ["mock", "status"]);
  assert.equal(status.code, 0, status.err);
  assert.match(status.out, new RegExp(`运行中 http://\\[::1\\]:${ctx.port}`));
});

test("mockLanUrls：只在监听所有网卡时列出非回环 IPv4", () => {
  const interfaces = {
    lo0: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
    en0: [
      { family: "IPv6", address: "fe80::1", internal: false },
      { family: "IPv4", address: "192.168.1.23", internal: false },
    ],
    utun3: [{ family: "IPv4", address: "10.8.0.2", internal: false }],
    utun4: [{ family: "IPv4", address: "198.18.0.1", internal: false }], // 代理软件的虚拟网卡
  };
  assert.deepEqual(mockLanUrls("0.0.0.0", 3002, interfaces), [
    "http://192.168.1.23:3002",
    "http://10.8.0.2:3002",
  ]);
  assert.deepEqual(mockLanUrls("::", 3002, interfaces).length, 2);
  assert.deepEqual(mockLanUrls("127.0.0.1", 3002, interfaces), []);
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

  // 多个词：各自命中任一字段即可（GET 在 method、/api/users 在 path；「用户」「列表」都在摘要「用户列表」里），
  // 分开传和引号里一整串效果相同；但每个词都得命中
  const names = async (...args) =>
    JSON.parse((await run(ctx, ["mock", "routes", ...args, "--json"])).out).routes.map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(await names("GET", "/api/users"), ["GET /api/users"]);
  assert.deepEqual(await names("GET /api/users"), ["GET /api/users"]);
  assert.deepEqual(await names("用户", "列表"), ["GET /api/users"]);
  assert.deepEqual(await names("POST", "/api/users"), []);

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

test("rule set 从 shell 管道读 response：上游数据晚到也不丢（sample | rule set 这类管道）", async () => {
  const ctx = await setup();
  // 真 shell 管道（FIFO）：上游 1.5s 后才写，超过程序调用那档 1s 的等待，证明 shell 管道走的是更长的那档
  const child = spawn(
    "sh",
    ["-c", `(sleep 1.5; echo '{"rc":0,"late":true}') | "${process.execPath}" "${CLI}" mock rule set -m GET -p /api/users`],
    { env: { ...process.env, VJTOOLS_USER_DATA_DIR: ctx.userData, MOCK_RULES_FILE: "" } },
  );
  let err = "";
  child.stderr.on("data", (chunk) => (err += chunk));
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0, err);
  const rules = readJson(path.join(ctx.userData, "mock-assets", "mock-rules.json"));
  assert.deepEqual(rules[0].response, { rc: 0, late: true });
});

test("rule set 被 child_process.exec 这类调用、stdin 管道没人关：不会永久挂起，按没有输入处理", async (t) => {
  const ctx = await setup();
  const child = spawn(process.execPath, [CLI, "mock", "rule", "set", "-m", "GET", "-p", "/api/a", "--status", "500"], {
    env: { ...process.env, VJTOOLS_USER_DATA_DIR: ctx.userData, MOCK_RULES_FILE: "" },
  });
  t.after(() => child.kill("SIGKILL"));
  // 故意不 end stdin：和 exec 默认行为一样，管道一直开着、没有数据
  let err = "";
  child.stderr.on("data", (chunk) => (err += chunk));
  const code = await Promise.race([
    new Promise((resolve) => child.on("close", resolve)),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 8_000)),
  ]);
  assert.equal(code, 0, `应在等待上限后自行结束（${code}）：${err}`);
  assert.match(err, /没有数据，按没有输入处理/);
  const rules = readJson(path.join(ctx.userData, "mock-assets", "mock-rules.json"));
  assert.equal(rules[0].status, 500);
});

test("history --kind 拼错直接报错并列出可选值（不再静默显示「没有符合条件的请求」）", async () => {
  const ctx = await setup();
  const res = await run(ctx, ["mock", "history", "--kind", "mok"]);
  assert.equal(res.code, 1);
  assert.match(res.err, /--kind 只能是 mock \/ proxy \/ proxy-error \/ miss：mok/);
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

// ─── 第二轮审查补的用例 ──────────────────────────────────────────────────────

test("rule set 没有 response：提示按接口在不在 swagger 里区分（swagger 之外的路径不会生效）", async () => {
  const ctx = await setup();
  const inSpec = await run(ctx, ["mock", "rule", "set", "-m", "GET", "-p", "/api/users", "--status", "500"]);
  assert.equal(inSpec.code, 0, inSpec.err);
  assert.match(inSpec.out, /命中时按 swagger 生成示例数据返回/);

  const notInSpec = await run(ctx, ["mock", "rule", "set", "-m", "GET", "-p", "/not/in/spec", "--status", "500"]);
  assert.equal(notInSpec.code, 0, notInSpec.err);
  assert.match(notInSpec.out, /swagger 里没有 GET \/not\/in\/spec：没有 response 的规则不会生效/);
});

test("运行记录丢了：health 自报身份，仍认得出是命令行起的，stop 停得掉", async (t) => {
  const ctx = await setup();
  assert.equal((await run(ctx, ["mock", "start"])).code, 0);
  const { pid } = readJson(runtimeFile(ctx));
  // 运行记录要删掉，cleanup 靠它找进程会落空：stop 失败时按 pid 直接收尾，别留下后台进程
  t.after(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  });
  fs.rmSync(runtimeFile(ctx));

  const status = await run(ctx, ["mock", "status"]);
  assert.equal(status.code, 0);
  assert.match(status.out, /命令行（vjtools mock start）/);
  const stopped = await run(ctx, ["mock", "stop"]);
  assert.equal(stopped.code, 0, stopped.err);
  assert.match(stopped.out, new RegExp(`已停止（pid ${pid}）`));
  assert.equal((await run(ctx, ["mock", "status"])).code, 3);
});

test("两个 mock start 同时跑：只起一个进程，另一个报「已经在运行」而不是「启动失败」，日志不被截断", async (t) => {
  const ctx = await setup();
  t.after(() => cleanup(ctx));
  const [a, b] = await Promise.all([run(ctx, ["mock", "start"]), run(ctx, ["mock", "start"])]);
  assert.equal(a.code, 0, a.err);
  assert.equal(b.code, 0, b.err);
  const outs = [a.out, b.out];
  assert.equal(outs.filter((out) => /已在后台启动/.test(out)).length, 1);
  assert.equal(outs.filter((out) => /已经在运行/.test(out)).length, 1);
  const log = fs.readFileSync(path.join(ctx.userData, "logs", "mock-cli.log"), "utf8");
  assert.match(log, /mock 已启动/);
  assert.doesNotMatch(log, /已在运行|已被占用/, "没有第二个进程往日志里写失败信息");
  assert.equal(fs.existsSync(path.join(ctx.userData, "mock-assets", "mock-starting.lock")), false, "锁用完即删");
});

test("--from-history：代理失败 / 未命中 / 非 JSON 响应各报真实原因；后端 JSON 里的雪花 ID 原样存进规则并原样返回", async (t) => {
  const big = "1850123456789012345";
  const backend = http.createServer((req, res) => {
    if (req.url.startsWith("/html")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>hi</html>");
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`{"rc":0,"data":{"id":${big}}}`);
    }
  });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const ctx = await setup({ extraConfig: { mockAll: false, mockBackendBaseUrl: `http://127.0.0.1:${backend.address().port}` } });
  t.after(async () => {
    await cleanup(ctx);
    backend.close();
  });
  assert.equal((await run(ctx, ["mock", "start"])).code, 0);
  await fetch(`${ctx.base}/html/page`);
  await fetch(`${ctx.base}/json/big`);
  const deadPort = await freePort();
  assert.equal((await run(ctx, ["mock", "config", "--backend", `http://127.0.0.1:${deadPort}`])).code, 0);
  await fetch(`${ctx.base}/json/dead`);
  assert.equal((await run(ctx, ["mock", "config", "--backend", ""])).code, 0);
  await fetch(`${ctx.base}/nowhere`);
  const ids = Object.fromEntries(
    JSON.parse((await run(ctx, ["mock", "history", "--json"])).out).map((e) => [e.path, e.id]),
  );

  const reasons = {
    "/html/page": /不是 JSON/,
    "/json/dead": /代理失败/,
    "/nowhere": /没有响应体/,
  };
  for (const [p, reason] of Object.entries(reasons)) {
    const res = await run(ctx, ["mock", "rule", "set", "--from-history", String(ids[p])]);
    assert.equal(res.code, 1, p);
    assert.match(res.err, reason, p);
  }

  const saved = await run(ctx, ["mock", "rule", "set", "--from-history", String(ids["/json/big"])]);
  assert.equal(saved.code, 0, saved.err);
  const rulesText = fs.readFileSync(path.join(ctx.userData, "mock-assets", "mock-rules.json"), "utf8");
  assert.match(rulesText, new RegExp(`"id": ${big}`), "规则文件里是原样的数字");
  assert.match(await (await fetch(`${ctx.base}/json/big`)).text(), new RegExp(`"id":${big}`), "返回给前端也不丢位");

  // 从 stdin 写的大整数也一样；改别的规则时不会把它舍入
  const viaStdin = await run(ctx, ["mock", "rule", "set", "-m", "GET", "-p", "/api/users"], `{"id":${big}}`);
  assert.equal(viaStdin.code, 0, viaStdin.err);
  await run(ctx, ["mock", "rule", "set", "-m", "GET", "-p", "/api/other"], "{}");
  assert.equal(
    (fs.readFileSync(path.join(ctx.userData, "mock-assets", "mock-rules.json"), "utf8").match(new RegExp(big, "g")) || []).length,
    2,
  );
  assert.match((await run(ctx, ["mock", "history", "--id", String(ids["/json/big"])])).out, new RegExp(big));
});

test("--port 只认十进制数字；--backend / --swagger-server 不能带 ? 或 #；serve 帮助里不显示内部参数 --daemon", async () => {
  const ctx = await setup();
  const configFile = path.join(ctx.userData, "config.json");
  const before = readJson(configFile).mockPort;
  for (const bad of ["1e3", "0x10", "3002.5", ""]) {
    const res = await run(ctx, ["mock", "config", "--port", bad]);
    assert.equal(res.code, 1, bad);
  }
  assert.equal(readJson(configFile).mockPort, before);
  assert.equal((await run(ctx, ["mock", "config", "--port", " 3010 "])).code, 0);
  assert.equal(readJson(configFile).mockPort, 3010);

  for (const [flag, url] of [["--backend", "http://x.test/api?token=1"], ["--swagger-server", "http://x.test/t2#a"]]) {
    const res = await run(ctx, ["mock", "config", flag, url]);
    assert.equal(res.code, 1, flag);
    assert.match(res.err, /不能带 \? 或 #/);
  }

  const help = await run(ctx, ["mock", "serve", "--help"]);
  assert.doesNotMatch(help.out, /--daemon/);
});

test("别的数据目录（隔离环境）配了同一个端口：不认成自己的，stop 拒绝、start 报端口被占、status 退出码 3", async (t) => {
  const a = await setup();
  t.after(() => cleanup(a));
  assert.equal((await run(a, ["mock", "start"])).code, 0);
  const { pid } = readJson(runtimeFile(a));

  // b 是另一个数据目录，端口和 a 一样
  const b = await setup({ extraConfig: { mockPort: a.port } });
  const status = await run(b, ["mock", "status"]);
  assert.equal(status.code, 3);
  assert.match(status.out, /被另一个数据目录的 vjtools/);
  const stop = await run(b, ["mock", "stop"]);
  assert.equal(stop.code, 1);
  assert.match(stop.err, /VJTOOLS_USER_DATA_DIR=/);
  const start = await run(b, ["mock", "start"]);
  assert.equal(start.code, 1);
  assert.match(start.err, /被另一个数据目录的 vjtools.*占用/);
  assert.equal((await run(b, ["mock", "history"])).code, 3);

  const health = await (await fetch(`${a.base}/__mock/health`)).json();
  assert.equal(health.pid, pid, "a 的 mock 不能被 b 停掉");
});

test("启动锁：读不出 pid 的新锁不当残留立刻删（等它写完 / 过期）；持有者活着时等它释放", async (t) => {
  const ctx = await setup();
  t.after(() => cleanup(ctx));
  const lockFile = path.join(ctx.userData, "mock-assets", "mock-starting.lock");
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });

  fs.writeFileSync(lockFile, "");
  let began = Date.now();
  const afterEmpty = await run(ctx, ["mock", "start"]);
  assert.equal(afterEmpty.code, 0, afterEmpty.err);
  assert.ok(Date.now() - began >= 1_500, "空锁至少等到它算过期才清");
  assert.equal((await run(ctx, ["mock", "stop"])).code, 0);

  fs.writeFileSync(lockFile, String(process.pid)); // 持有者（本测试进程）活着
  setTimeout(() => fs.rmSync(lockFile, { force: true }), 1_000);
  began = Date.now();
  const waited = await run(ctx, ["mock", "start"]);
  assert.equal(waited.code, 0, waited.err);
  assert.ok(Date.now() - began >= 900, "持有者释放之前不能抢锁");
});
