// app 读写规则、用请求历史生成规则时大整数（雪花 ID）不丢位：node --test scripts/
//
// ipc.js / daemon-client.js 依赖 electron 和 config store 不能直接测，这里按它们的数据流把同一组纯函数串起来：
// 主进程 get-mock-rules → JSON 文本过 IPC → 渲染层 parseJsonLossless、改一条 → JSON 文本回传 →
// save-mock-rules 整份写回。原先传对象时，改任意一条，所有规则里的 ID 都会被舍入成 …2200。
// 请求历史同理：后台进程的历史 / 事件 → 主进程无损解析 → JSON 文本推给渲染层 → 存入场景再传文本回来。
// 文件都建在 mkdtemp 临时目录，不碰真实用户数据。

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { historyEntryToRule } from "../src/mock/history-rule.js";
import { parseJsonLossless } from "../src/mock/json-lossless.js";
import { readRulesFile, writeRulesFile } from "../src/mock/rules.js";
import { mergeSceneRules, readSceneRules } from "../src/mock/scenes.js";
import { loadMockRules } from "../src/mock/server.js";
import { normalizeRulesForSave } from "../src/mock/service.js";
import { handleRecordedEntry, startRecording, stopRecording } from "../src/mock/recorder.js";
import { addWindow, removeWindow, sendMockRequest } from "../src/ui-channel.js";

afterEach(() => stopRecording());

const ID = "1850123456789012345";
const OTHER_ID = "1850123456789099999";
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "mock-lossless-test-"));

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const RULES_TEXT = `[
  {"method":"GET","path":"/a","response":{"id":${ID},"list":[{"uid":${ID}}]}},
  {"method":"GET","path":"/b","response":{"rc":0},
   "variants":[{"name":"v","when":{"query":{"p":"1"}},"response":{"id":${ID}}}]}
]`;

test("规则编辑器往返：改一条规则，其他规则和变体里的雪花 ID 原样保留", () => {
  const file = path.join(tmpDir(), "mock-rules.json");
  writeText(file, RULES_TEXT);

  // 主进程 get-mock-rules
  const rulesJson = JSON.stringify(loadMockRules(file, { lossless: true }));
  // 渲染层：解析、只改 /b 的 enabled（与规则列表开关一样整份回传）
  const rules = parseJsonLossless(rulesJson);
  const nextRules = rules.map((r) => (r.path === "/b" ? { ...r, enabled: false } : r));
  // 主进程 save-mock-rules
  writeRulesFile(file, normalizeRulesForSave(parseJsonLossless(JSON.stringify(nextRules))));

  const text = fs.readFileSync(file, "utf8");
  assert.equal(text.match(new RegExp(ID, "g"))?.length, 3, text);
  assert.doesNotMatch(text, /1850123456789012200/);
  assert.equal(readRulesFile(file)[1].enabled, false);
});

test("编辑器里新粘贴的雪花 ID 按原文保存", () => {
  const file = path.join(tmpDir(), "mock-rules.json");
  writeText(file, RULES_TEXT);

  const rules = parseJsonLossless(JSON.stringify(loadMockRules(file, { lossless: true })));
  // mock-rule-editor 的 valuesToRule：responseText → parseJsonLossless
  const edited = { ...rules[0], response: parseJsonLossless(`{"id": ${OTHER_ID}}`) };
  const nextRules = [edited, rules[1]];
  writeRulesFile(file, normalizeRulesForSave(parseJsonLossless(JSON.stringify(nextRules))));

  const text = fs.readFileSync(file, "utf8");
  assert.match(text, new RegExp(OTHER_ID));
  // 没改的 /b 变体里的 ID 还在
  assert.match(text, new RegExp(ID));
});

test("场景编辑：readSceneRules 无损读出，回写不丢位", () => {
  const scenesDir = path.join(tmpDir(), "scenes");
  writeText(path.join(scenesDir, "联调.json"), RULES_TEXT);

  // 主进程 get-mock-scene-rules → 渲染层 → save-mock-scene-rules
  const rules = parseJsonLossless(JSON.stringify(readSceneRules(scenesDir, "联调")));
  const sceneFile = path.join(scenesDir, "联调.json");
  writeRulesFile(sceneFile, normalizeRulesForSave(parseJsonLossless(JSON.stringify(rules))));

  assert.equal(fs.readFileSync(sceneFile, "utf8").match(new RegExp(ID, "g"))?.length, 3);
});

test("在已有场景上续录：录制整份重写场景文件时，原有规则里的雪花 ID 不丢", () => {
  const scenesDir = path.join(tmpDir(), "scenes");
  writeText(path.join(scenesDir, "录制.json"), RULES_TEXT);

  startRecording({ sceneName: "录制", scenesDir });
  handleRecordedEntry({
    kind: "proxy",
    method: "GET",
    path: "/c",
    status: 200,
    responseIsJson: true,
    responseBody: { rc: 0 },
  });

  const text = fs.readFileSync(path.join(scenesDir, "录制.json"), "utf8");
  assert.equal(text.match(new RegExp(ID, "g"))?.length, 3, text);
  assert.match(text, /"\/c"/);
});

test("场景文件损坏时严格读取报错（应用 / 合并场景据此拒绝，而不是当成空场景覆盖）", () => {
  const sceneFile = path.join(tmpDir(), "scenes", "坏的.json");
  writeText(sceneFile, "[{ 不是 json");
  assert.throws(() => readRulesFile(sceneFile), /不是合法 JSON/);
  // 宽松读法（录制续录用）仍按空场景处理
  assert.deepEqual(readSceneRules(path.dirname(sceneFile), "坏的"), []);
});

// ─── 请求历史 ─────────────────────────────────────────────────────────────────

// 后台进程 /__mock/history、/__mock/events 输出的就是这种文本（server 无损解析后端响应、JSON.stringify 输出）
const HISTORY_TEXT = `[
  {"id":1,"kind":"proxy","method":"GET","path":"/api/user/7","matchedPath":"/api/user/{id}","status":200,
   "responseIsJson":true,"requestBody":{"ids":[${ID}]},"responseBody":{"rc":0,"data":{"id":${ID}}}},
  {"id":2,"kind":"proxy","method":"GET","path":"/api/order","status":200,
   "responseIsJson":true,"responseBody":{"rc":0,"data":{"orderId":${OTHER_ID}}}}
]`;

test("rawJSON 包装不能结构化克隆（IPC、路由 state 都会抛错），JSON 文本可以", () => {
  const entries = parseJsonLossless(HISTORY_TEXT);
  assert.throws(() => structuredClone(entries[0]), { name: "DataCloneError" });
  // 「生成规则」跳转时 draft 带的是 responseJson 文本
  const draft = { method: "GET", path: "/api/user/{id}", responseJson: JSON.stringify(entries[0].responseBody) };
  const cloned = structuredClone({ draft });
  assert.match(cloned.draft.responseJson, new RegExp(ID));
  assert.equal(JSON.stringify(parseJsonLossless(cloned.draft.responseJson)), `{"rc":0,"data":{"id":${ID}}}`);
});

test("sendMockRequest 推给窗口的是 JSON 文本，雪花 ID 原样；没有窗口时什么都不做", () => {
  const [entry] = parseJsonLossless(HISTORY_TEXT);
  assert.doesNotThrow(() => sendMockRequest(entry));

  const sent = [];
  const win = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  };
  addWindow(win);
  try {
    sendMockRequest(entry);
  } finally {
    removeWindow(win);
  }
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, "mock-request");
  assert.equal(typeof sent[0].payload, "string");
  // 渲染层 mock-history-store 的解析
  const received = parseJsonLossless(sent[0].payload);
  assert.equal(JSON.stringify(received.responseBody), `{"rc":0,"data":{"id":${ID}}}`);
  assert.equal(JSON.stringify(received.requestBody), `{"ids":[${ID}]}`);
});

test("录制新录到的响应：雪花 ID 原样写进场景", () => {
  const scenesDir = path.join(tmpDir(), "scenes");
  startRecording({ sceneName: "录新", scenesDir });
  // daemon-client 收到事件后 parseJsonLossless，再交给录制
  for (const entry of parseJsonLossless(HISTORY_TEXT)) handleRecordedEntry(entry);

  const text = fs.readFileSync(path.join(scenesDir, "录新.json"), "utf8");
  assert.match(text, new RegExp(ID));
  assert.match(text, new RegExp(OTHER_ID));
});

test("请求历史「存入场景」：新规则和场景里原有规则的雪花 ID 都不丢", () => {
  const scenesDir = path.join(tmpDir(), "scenes");
  const sceneFile = path.join(scenesDir, "联调.json");
  writeText(sceneFile, RULES_TEXT);

  // 渲染层：历史（JSON 文本解析）→ historyEntryToRule → JSON 文本过 IPC
  const rules = parseJsonLossless(HISTORY_TEXT).map(historyEntryToRule).filter(Boolean);
  const rulesJson = JSON.stringify(rules);
  // 主进程 add-rules-to-mock-scene（mode=merge）
  const incoming = normalizeRulesForSave(parseJsonLossless(rulesJson));
  const merged = mergeSceneRules(readRulesFile(sceneFile), incoming);
  writeRulesFile(sceneFile, merged.rules);

  const text = fs.readFileSync(sceneFile, "utf8");
  // 原有 3 处 + 新规则 1 处
  assert.equal(text.match(new RegExp(ID, "g"))?.length, 4, text);
  assert.match(text, new RegExp(OTHER_ID));
  assert.equal(merged.added, 2);
});
