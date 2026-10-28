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
  startSwaggerMock,
  stopMockService,
} from "../src/mock/service.js";
import { startRecording, stopRecording } from "../src/mock/recorder.js";
import { isPidAlive, readMockRuntime } from "../src/mock/runtime.js";

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
  const nextPort = await freePort();
  assert.equal((await cli(ctx, ["mock", "config", "--port", String(nextPort)])).status, 0);

  assert.ok(
    await waitFor(() => readMockRuntime(ctx.mockAssets)?.port === nextPort && isMockRunning()),
    "重启后要重新连上",
  );
  assert.ok(statuses().includes("starting"), "重启期间显示启动中");
  await fetch(`http://127.0.0.1:${nextPort}/api/a`);
  assert.ok(await waitFor(async () => (await fetchMockHistory()).length === 1), "历史从新端口读");
  assert.equal(readMockRuntime(ctx.mockAssets).pid, pid, "改配置是进程内重启，pid 不变");

  assert.equal((await cli(ctx, ["mock", "stop"])).status, 0);
  assert.ok(await waitFor(() => !isMockRunning() && statuses().at(-1) === "stopped"), "被外部停掉后显示已停止");
});
