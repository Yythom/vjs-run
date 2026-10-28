// Mock 录制 + 场景管理。
//
// 录制：开启后，onRecord 管道里 2xx JSON 的响应按「method + 路由模板」
// upsert 成规则，写入 scenes/<场景名>.json。默认 kind=proxy（真实后端）
// 和 kind=mock（命中现有规则/回放）都录；开启「排除 mock」后只录 proxy。
// 活动规则文件（mock-rules.json）在录制期间不被触碰——透传继续走后端、
// 重复请求持续刷新录制内容；想回放时把场景「应用」为活动规则即可。
//
// 场景：即一份命名的规则文件快照，存放在 mock-rules.json 同目录的 scenes/ 下。
// 应用（覆盖活动规则文件）后 loadMockRules 的 mtime 缓存自动感知，无需重启 mock。
//
// 场景文件的读写在 scenes.js（与 vjtools CLI 共用）；这里只加一层「录制中的场景禁止
// 外部写入 / 删除 / 改名」守卫——录制状态只存在于 app 进程内。
//
// 本模块不依赖 electron / config store：scenesDir 由 IPC 层从 config 算好传入，
// 方便在纯 node 环境下冒烟测试。

import fs from "node:fs";
import { sendMockRecording } from "../ui-channel.js";
import { ruleKey, writeRulesFile } from "./rules.js";
import * as scenes from "./scenes.js";
import { readSceneRules, sanitizeSceneName, sceneFilePath } from "./scenes.js";

export {
  listScenes,
  mergeSceneRules,
  readSceneRules,
  sanitizeSceneName,
  sceneFilePath,
} from "./scenes.js";

let session = null; // { sceneName, file, rules: Map<key, rule>, startedAt }

// ─── 录制 ─────────────────────────────────────────────────────────────────────

export function getRecordingStatus() {
  if (!session) return { enabled: false };
  return {
    enabled: true,
    sceneName: session.sceneName,
    count: session.rules.size,
    startedAt: session.startedAt,
    excludeMock: session.excludeMock,
  };
}

function pushStatus() {
  sendMockRecording(getRecordingStatus());
}

export function startRecording({ sceneName: rawName, scenesDir, excludeMock = false }) {
  const sceneName = sanitizeSceneName(rawName);
  fs.mkdirSync(scenesDir, { recursive: true });
  const file = sceneFilePath(scenesDir, sceneName);

  // 场景已存在则在其基础上续录（增量录制）；文件损坏就从空开始
  const rules = new Map();
  for (const rule of readSceneRules(scenesDir, sceneName)) {
    rules.set(ruleKey(rule), rule);
  }

  session = {
    sceneName,
    file,
    rules,
    startedAt: Date.now(),
    excludeMock: !!excludeMock,
  };
  pushStatus();
  return getRecordingStatus();
}

export function stopRecording() {
  const { sceneName = "", count = 0 } = getRecordingStatus();
  session = null;
  pushStatus();
  return { sceneName, count };
}

/**
 * onRecord 管道调用：把符合条件的响应固化成录制场景里的规则。
 * 只收 2xx 且完整记录到的 JSON 响应。默认 proxy + mock 都收；开启 excludeMock
 * 后只收 proxy。mock 的响应本身就是规则里的 JSON，天然满足 JSON 条件、无回环
 * （单次请求触发一次，录制不会反向触发新请求）。
 */
export function handleRecordedEntry(entry) {
  if (!session) return;
  const isMock = entry.kind === "mock";
  const isProxy = entry.kind === "proxy";
  if (!isProxy && !isMock) return;
  if (isMock && session.excludeMock) return;
  if (!entry.status || entry.status < 200 || entry.status >= 300) return;
  if (entry.responseTruncated) return;
  // proxy 靠 responseIsJson 判定；mock 的 responseBody 本就是规则 JSON 对象
  if (!isMock && !entry.responseIsJson) return;

  const rule = {
    enabled: true,
    method: entry.method,
    // 命中过 swagger 路由的用带 {param} 的模板，同类请求共用一条规则（后录的覆盖先录的）
    path: entry.matchedPath || entry.path,
    response: entry.responseBody,
  };
  // 录制只产出顶层 response，不生成变体；但会话内同 key 已录到的变体要保留，
  // 避免重复请求把手工配置的 variants 覆盖掉
  const prev = session.rules.get(ruleKey(rule));
  if (prev?.variants) rule.variants = prev.variants;
  session.rules.set(ruleKey(rule), rule);
  try {
    writeRulesFile(session.file, [...session.rules.values()]);
  } catch (err) {
    console.error("[mock-recorder]", err);
  }
  pushStatus();
}

// ─── 场景（录制守卫）─────────────────────────────────────────────────────────────
// 所有「从外部写场景文件」的入口（保存 / 覆盖 / 存入 / 编辑场景）都走这里，
// 录制中的场景一律拒写：录制把规则攥在内存里，下一条请求到来就整份重写文件，
// 外部写进去的内容会被悄悄冲掉。录制自身写盘直接走 writeRulesFile，不受影响。

function isRecording(sceneName) {
  return Boolean(session && session.sceneName === sceneName);
}

export function writeSceneRules(scenesDir, name, rules) {
  const sceneName = sanitizeSceneName(name);
  if (isRecording(sceneName)) {
    throw new Error(`场景「${sceneName}」正在录制中，请先停止录制再写入`);
  }
  return scenes.writeSceneRules(scenesDir, sceneName, rules);
}

export function deleteScene(scenesDir, name) {
  const sceneName = sanitizeSceneName(name);
  if (isRecording(sceneName)) {
    throw new Error(`场景「${sceneName}」正在录制中，请先停止录制`);
  }
  scenes.deleteScene(scenesDir, sceneName);
}

export function renameScene(scenesDir, oldName, newName) {
  const from = sanitizeSceneName(oldName);
  if (isRecording(from)) {
    throw new Error(`场景「${from}」正在录制中，请先停止录制`);
  }
  return scenes.renameScene(scenesDir, from, newName);
}
