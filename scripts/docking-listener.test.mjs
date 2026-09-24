// AI 工单台监听器与 lark-cli 报错解析测试：node --test scripts/docking-listener.test.mjs
//
// 监听相关用例拿一个假的 lark-cli 顶替真的（按 lark-event 文档的子进程约定输出），
// 放在 PATH 最前面，起监听前再核对一遍找到的确实是替身——真的 event consume
// 会连上飞书，跟正在跑的 vjtools 抢同一个机器人的消息。

import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSpawnEnvSync } from "../src/shell-env.js";
import { addWindow } from "../src/ui-channel.js";
import {
  LARK_SETUP_CMD,
  describeLarkError,
  parseLarkError,
} from "../src/feishu/lark-cli.js";
import {
  getListenerStatus,
  startListener,
  stopListener,
} from "../src/feishu/listener.js";
import { setDataDir } from "../src/feishu/task-store.js";

// 新电脑上 lark-cli 没配置时 event status / event consume 的原样 stderr（lark-cli 1.0.93 实测，退出码 3）
const NOT_CONFIGURED = `{
  "ok": false,
  "error": {
    "type": "config",
    "subtype": "not_configured",
    "message": "not configured",
    "hint": "run \`lark-cli config init --new\` in the background. It blocks and outputs a verification URL — retrieve the URL and open it in a browser to complete setup."
  }
}`;

// ─── 错误信封解析 ─────────────────────────────────────────────────────────────

test("parseLarkError: 认出多行缩进的错误信封", () => {
  const error = parseLarkError(NOT_CONFIGURED);
  assert.equal(error.type, "config");
  assert.equal(error.subtype, "not_configured");
});

test("parseLarkError: 信封前后夹着非 JSON 的行也能认出", () => {
  const text = [
    "WARN some diagnostic line",
    NOT_CONFIGURED,
    "[event] exited — received 0 event(s) in 0.1s",
  ].join("\n");
  assert.equal(parseLarkError(text)?.subtype, "not_configured");
});

test("parseLarkError: 单行紧凑、带顶层 identity 的信封也认", () => {
  const text = JSON.stringify({
    ok: false,
    identity: "bot",
    error: { type: "auth", subtype: "missing_scope", message: "missing scopes" },
  });
  assert.equal(parseLarkError(text)?.subtype, "missing_scope");
});

test("parseLarkError: 不是错误信封就返回 null", () => {
  assert.equal(parseLarkError(""), null);
  assert.equal(parseLarkError(undefined), null);
  assert.equal(parseLarkError("── cli_xxx ──\n  Bus: not running"), null);
  assert.equal(parseLarkError('{"ok": true, "data": {}}'), null);
  assert.equal(parseLarkError("{ 半截 JSON"), null);
});

test("describeLarkError: 没配置时给人能照做的命令，不带 agent 用的 --new", () => {
  const text = describeLarkError(parseLarkError(NOT_CONFIGURED));
  assert.match(text, /还没绑定飞书应用/);
  assert.ok(text.includes(LARK_SETUP_CMD));
  assert.ok(!text.includes("--new"));
});

test("describeLarkError: 不认识的错误原样带上 type/subtype、message 和 hint", () => {
  const text = describeLarkError({
    type: "auth",
    subtype: "missing_scope",
    message: "missing scopes: im:message",
    hint: "lark-cli auth login --scope im:message",
  });
  assert.match(text, /auth\/missing_scope/);
  assert.match(text, /missing scopes: im:message/);
  assert.match(text, /lark-cli auth login --scope im:message/);
  assert.equal(describeLarkError(null), "");
  assert.equal(describeLarkError("网络连接失败"), "lark-cli 报错：网络连接失败");
});

// ─── 监听器：没配置 → 重连 → 停止 / 恢复 ──────────────────────────────────────

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "docking-listener-test-"));
const binDir = path.join(workDir, "bin");
const spawnLog = path.join(workDir, "spawns.log");
const configuredFlag = path.join(workDir, "configured");
fs.mkdirSync(binDir);
// 没有 configured 标记文件时扮演「没配置」：打出信封，停一会儿再以 3 退出（留出观察重试中状态的窗口）；
// 有了就扮演「连上了」：打就绪行后常驻
fs.writeFileSync(
  path.join(binDir, "lark-cli"),
  `#!/bin/sh
if [ "$1 $2" != "event consume" ]; then exit 64; fi
echo "$*" >> "${spawnLog}"
if [ -f "${configuredFlag}" ]; then
  echo "[event] ready event_key=$3" >&2
  exec tail -f /dev/null
fi
cat >&2 <<'EOF'
${NOT_CONFIGURED}
EOF
sleep 0.3
exit 3
`,
  { mode: 0o755 },
);
const originalPath = process.env.PATH;
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH || ""}`;
setDataDir(path.join(workDir, "userdata"));

// 假窗口：收下推给页面的每一帧监听状态
const pushes = [];
addWindow({
  isDestroyed: () => false,
  webContents: {
    send: (channel, payload) => {
      if (channel === "docking-status") pushes.push(payload);
    },
  },
});

after(() => {
  process.env.PATH = originalPath;
  stopListener({ force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(20);
  }
  assert.fail(`等待超时：${label}，当前状态 ${JSON.stringify(getListenerStatus())}`);
}

function spawnCount() {
  try {
    return fs.readFileSync(spawnLog, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

function resetFake() {
  assert.equal(
    buildSpawnEnvSync()
      .PATH.split(path.delimiter)
      .map((dir) => path.join(dir, "lark-cli"))
      .find((file) => fs.existsSync(file)),
    path.join(binDir, "lark-cli"),
    "PATH 里先找到的不是替身，不能起监听",
  );
  fs.rmSync(configuredFlag, { force: true });
  fs.rmSync(spawnLog, { force: true });
  pushes.length = 0;
}

test("listener: 没配置时报出原因而不是退出码，重连中状态不闪回空闲，停止即不再重试", async () => {
  resetFake();
  // 进程刚拉起、还不知道能不能连上：running 为真，但不能算已连上
  const started = startListener();
  assert.equal(started.running, true);
  assert.equal(started.connected, false);

  await waitFor(() => spawnCount() === 1 && !getListenerStatus().running, 15000, "第一次失败退出");
  let status = getListenerStatus();
  assert.equal(status.retrying, true);
  assert.match(status.lastError, /还没绑定飞书应用/);
  assert.ok(status.lastError.includes(LARK_SETUP_CMD));

  // 退避 2 秒后的重试进程：跑着的这段也是重连中，不能报成「监听中」
  await waitFor(() => getListenerStatus().running, 5000, "重试进程拉起");
  assert.equal(getListenerStatus().retrying, true);

  // 重试进程带着同样的原因退出，原因不能被「事件流意外结束（退出码 3）」顶掉
  await waitFor(() => spawnCount() === 2 && !getListenerStatus().running, 5000, "重试进程退出");
  status = getListenerStatus();
  assert.equal(status.retrying, true);
  assert.match(status.lastError, /还没绑定飞书应用/);

  // 停止之前推给页面的每一帧都得是「监听中」或「重连中」，否则顶栏按钮会闪回「开始监听」
  assert.ok(pushes.length > 0);
  assert.ok(pushes.every((s) => s.running || s.retrying), JSON.stringify(pushes));
  assert.ok(pushes.every((s) => !s.lastError.includes("退出码")), JSON.stringify(pushes));
  // 从没连上过，任何一帧都不能报 connected，否则页面会把「还不能用」的卡片藏掉一下
  assert.ok(pushes.every((s) => s.connected === false), JSON.stringify(pushes));

  // 重连中停止：退避定时器被清掉（retrying 为 false 就说明没有待触发的重试）
  status = stopListener();
  assert.equal(status.running, false);
  assert.equal(status.retrying, false);
});

test("listener: 重连期间把 lark-cli 配好，就绪后自动恢复成监听中并清掉旧报错", async () => {
  resetFake();
  startListener();

  await waitFor(() => spawnCount() === 1 && !getListenerStatus().running, 15000, "第一次失败退出");
  assert.match(getListenerStatus().lastError, /还没绑定飞书应用/);

  fs.writeFileSync(configuredFlag, "");
  await waitFor(
    () => {
      const s = getListenerStatus();
      return s.connected && !s.retrying && !s.lastError;
    },
    5000,
    "重试后连上",
  );
  assert.equal(getListenerStatus().running, true);
  assert.equal(spawnCount(), 2);

  const status = stopListener();
  assert.equal(status.running, false);
  assert.equal(status.connected, false);
  assert.equal(status.retrying, false);
});
