// app 侧（src/mock/service.js → daemon-client.js）作为 mock 后台进程的客户端：node --test scripts/
//
// service.js 在 node 里也能跑：不调 initStore 时 saveConfig 只改内存里的 live config。
// 和 main.js 一样先把 DEFAULT_CONFIG 的 mockRulesFile / mockDataDir 指到隔离 userData，
// 后台进程的 VJTOOLS_USER_DATA_DIR 由 mockRulesFile 推出来——全程不碰真实数据。
// 挂一个假窗口接住 app 发给渲染层的事件（process-status / process-log / mock-request）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { saveConfig } from "../src/config/store.js";
import { addWindow, flushLogs } from "../src/ui-channel.js";
import {
  attachIfRunning,
  clearMockHistory,
  detachMock,
  fetchMockHistory,
  isMockRunning,
  refreshMockStatus,
  startSwaggerMock,
  stopMockService,
} from "../src/mock/service.js";
import { startRecording, stopRecording } from "../src/mock/recorder.js";
import { isPidAlive, readMockRuntime, writeMockRuntime } from "../src/mock/runtime.js";

const CLI = fileURLToPath(new URL("../src/cli/index.js", import.meta.url));

const sent = [];
addWindow({
  isDestroyed: () => false,
  webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
});

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function setup() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "mock-daemon-client-"));
  const specDir = path.join(userData, "specs");
  fs.mkdirSync(specDir);
  fs.writeFileSync(
    path.join(specDir, "api.json"),
    JSON.stringify({
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: {
        "/api/a": {
          get: {
            responses: {
              200: {
                description: "ok",
                content: { "application/json": { schema: { type: "object", properties: { v: { type: "integer" } } } } },
              },
            },
          },
        },
      },
    }),
  );
  const mockAssets = path.join(userData, "mock-assets");
  DEFAULT_CONFIG.mockRulesFile = path.join(mockAssets, "mock-rules.json");
  DEFAULT_CONFIG.mockDataDir = path.join(mockAssets, "mock-data");
  const port = await freePort();
  const config = { mockSpecPath: specDir, mockHost: "127.0.0.1", mockPort: port, mockAll: true };
  fs.writeFileSync(path.join(userData, "config.json"), JSON.stringify(config));
  saveConfig(config);
  sent.length = 0;
  return { userData, mockAssets, port, base: `http://127.0.0.1:${port}` };
}

// 必须异步：后台进程是本测试进程拉起的子进程，退出后要靠本进程的事件循环回收；
// spawnSync 卡住事件循环时它会变成僵尸进程，kill(pid, 0) 仍判为「活着」，stop 会白等到超时
function cli(ctx, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, VJTOOLS_USER_DATA_DIR: ctx.userData },
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout }));
  });
}

/** 用例收尾：断开订阅，再按运行记录把后台进程停干净 */
async function cleanup(ctx) {
  detachMock();
  const pid = readMockRuntime(ctx.mockAssets)?.pid;
  await cli(ctx, ["mock", "stop"]);
  if (pid && isPidAlive(pid)) process.kill(pid, "SIGKILL");
}

async function waitFor(check, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    flushLogs();
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

const statuses = () => sent.filter((e) => e.channel === "process-status").map((e) => e.payload.status);

test("app 启动 mock = 拉起后台进程：状态、日志、请求推送、历史都来自后台进程", async (t) => {
  const ctx = await setup();
  t.after(() => cleanup(ctx));

  await startSwaggerMock();
  const info = readMockRuntime(ctx.mockAssets);
  assert.equal(info.owner, "cli");
  assert.equal(info.startedBy, "app");
  assert.notEqual(info.pid, process.pid, "mock 不再跑在 app 进程里");
  assert.equal(isMockRunning(), true);
  assert.deepEqual(statuses().slice(0, 2), ["starting", "running"]);
  assert.ok(
    await waitFor(() => sent.some((e) => e.channel === "process-log" && /mock 已启动/.test(e.payload.data))),
    "后台进程的启动日志要补进 app 的日志面板",
  );

  await fetch(`${ctx.base}/api/a?x=1`);
  assert.ok(
    await waitFor(() => sent.some((e) => e.channel === "mock-request" && e.payload.path === "/api/a")),
    "新请求实时推给渲染层",
  );
  assert.equal((await fetchMockHistory()).at(-1).path, "/api/a");
  await clearMockHistory();
  assert.deepEqual(await fetchMockHistory(), []);

  await stopMockService();
  assert.equal(isPidAlive(info.pid), false);
  assert.equal(isMockRunning(), false);
  assert.equal(statuses().at(-1), "stopped");
});

test("录制留在 app：后台进程推来的请求照样录进场景", async (t) => {
  const ctx = await setup();
  t.after(() => {
    stopRecording();
    return cleanup(ctx);
  });

  startRecording({ sceneName: "录制测试", scenesDir: path.join(ctx.mockAssets, "scenes") });
  await startSwaggerMock();
  await fetch(`${ctx.base}/api/a`);

  const sceneFile = path.join(ctx.mockAssets, "scenes", "录制测试.json");
  assert.ok(
    await waitFor(() => fs.existsSync(sceneFile) && JSON.parse(fs.readFileSync(sceneFile, "utf8")).length === 1),
    "请求要被录成场景规则",
  );
  const [rule] = JSON.parse(fs.readFileSync(sceneFile, "utf8"));
  assert.equal(rule.method, "GET");
  assert.equal(rule.path, "/api/a");
});

test("app 接上命令行起的 mock；app 退出（只断开订阅）后 mock 继续跑", async (t) => {
  const ctx = await setup();
  t.after(() => cleanup(ctx));

  assert.equal((await cli(ctx, ["mock", "start"])).status, 0);
  const { pid, startedBy } = readMockRuntime(ctx.mockAssets);
  assert.equal(startedBy, "cli");

  const attached = await attachIfRunning();
  assert.equal(attached.pid, pid);
  assert.equal(isMockRunning(), true, "不再拒绝，直接接上命令行起的 mock");

  detachMock();
  assert.ok(isPidAlive(pid), "app 退出不停 mock");
  assert.equal((await fetch(`${ctx.base}/__mock/health`)).status, 200);
});

test("后台进程改配置自动重启后 app 自动重连；被命令行停掉后 app 显示已停止", async (t) => {
  const ctx = await setup();
  t.after(() => cleanup(ctx));

  await startSwaggerMock();
  const { pid } = readMockRuntime(ctx.mockAssets);
  const statusesBefore = statuses().length;
  const nextPort = await freePort();
  // config 会等守护进程重启完才返回，但那时 app 未必已经感知到断线：不能立刻断言，要等 app 走完「断线 → 重连」
  assert.equal((await cli(ctx, ["mock", "config", "--port", String(nextPort)])).status, 0);

  const panel = () => sent.filter((e) => e.channel === "process-log").map((e) => e.payload.data).join("");
  const reconnected = await waitFor(
    () =>
      statuses().slice(statusesBefore).includes("starting") &&
      isMockRunning() &&
      panel().includes(`mock 已启动 http://127.0.0.1:${nextPort}`),
  );
  assert.ok(
    reconnected,
    `重启期间显示启动中、之后重新连上，并把断线期间写的「已启动 + 新地址」补进日志面板，实际收到：\n${panel().slice(-1500)}`,
  );
  await fetch(`http://127.0.0.1:${nextPort}/api/a`);
  assert.ok(await waitFor(async () => (await fetchMockHistory()).length === 1), "历史从新端口读");
  assert.equal(readMockRuntime(ctx.mockAssets).pid, pid, "改配置是进程内重启，pid 不变");

  assert.equal((await cli(ctx, ["mock", "stop"])).status, 0);
  assert.ok(await waitFor(() => !isMockRunning() && statuses().at(-1) === "stopped"), "被外部停掉后显示已停止");
});

test("app 开着时命令行才启动的 mock：手动刷新（refreshMockStatus）后接上", async (t) => {
  const ctx = await setup();
  t.after(() => cleanup(ctx));

  assert.deepEqual(await refreshMockStatus(), { status: "stopped", running: null });

  assert.equal((await cli(ctx, ["mock", "start"])).status, 0);
  assert.equal(isMockRunning(), false, "没刷新之前 app 不知道");

  const refreshed = await refreshMockStatus();
  assert.equal(refreshed.status, "running");
  assert.equal(refreshed.running.pid, readMockRuntime(ctx.mockAssets).pid);
  assert.match(refreshed.running.ownerLabel, /命令行/);
  assert.equal(isMockRunning(), true);
  assert.equal(statuses().at(-1), "running");

  // 接上时会把后台进程的日志补进面板；已经连着时再点刷新不应重复接上、再补一遍
  const replays = () =>
    sent.filter((e) => e.channel === "process-log" && /mock 已启动/.test(e.payload.data)).length;
  assert.ok(await waitFor(() => replays() >= 1), "接上时补日志");
  const before = replays();
  assert.equal((await refreshMockStatus()).status, "running");
  flushLogs();
  assert.equal(replays(), before);
});

test("后台进程拒绝事件订阅（如 403）：app 退避重试，不和 health 探活原地打转，状态也不来回闪", async (t) => {
  const ctx = await setup();
  // 假后台进程：health 正常、事件流 403（监听具体网卡 IP 时旧版 server 就是这样）。
  // pid 用本测试进程，绝不能走 cleanup 里的 vjtools mock stop——那会 SIGTERM 测试进程自己
  let events = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/__mock/health") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, pid: process.pid }));
    } else if (req.url === "/__mock/events") {
      events++;
      res.statusCode = 403;
      res.end("{}");
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(ctx.port, "127.0.0.1", resolve));
  writeMockRuntime(ctx.mockAssets, { pid: process.pid, owner: "cli", host: "127.0.0.1", port: ctx.port });
  t.after(async () => {
    detachMock();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  await attachIfRunning();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const stillRunning = isMockRunning();
  detachMock();
  flushLogs();

  assert.ok(events <= 3, `1.5s 内只该重试几次，实际订阅了 ${events} 次`);
  assert.equal(stillRunning, true);
  assert.ok(!statuses().includes("starting"), "mock 本身是好的，不该在 running / starting 间来回切");
  const warnings = sent.filter((e) => e.channel === "process-log" && /拒绝了事件订阅（HTTP 403）/.test(e.payload.data));
  assert.equal(warnings.length, 1, "原因提示一次，不刷屏");
});

test("后台进程按新配置重启失败（如端口被占）：app 日志面板里能看到失败原因，不只是「已退出」", async (t) => {
  const ctx = await setup();
  t.after(() => cleanup(ctx));
  await startSwaggerMock();
  const { pid } = readMockRuntime(ctx.mockAssets);

  const busyPort = await freePort();
  const blocker = net.createServer().listen(busyPort, "127.0.0.1");
  await new Promise((resolve) => blocker.once("listening", resolve));
  t.after(() => blocker.close());

  // 和 app 设置页保存一样改 config.json；守护进程监听到后重启，撞端口退出
  assert.equal((await cli(ctx, ["mock", "config", "--port", String(busyPort)])).status, 1);
  assert.ok(await waitFor(() => !isPidAlive(pid) && statuses().at(-1) === "stopped"), "app 感知到后台进程退出");
  flushLogs();
  const logs = sent.filter((e) => e.channel === "process-log").map((e) => e.payload.data).join("");
  assert.match(logs, /已被占用/, "失败原因要出现在 app 的日志面板里");
});
