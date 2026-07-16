// Mock 录制 + 场景管理。
//
// 录制：开启后，onRecord 管道里 kind=proxy 且 2xx JSON 的真实后端响应，
// 按「method + 路由模板」upsert 成规则，写入 scenes/<场景名>.json。
// 活动规则文件（mock-rules.json）在录制期间不被触碰——透传继续走后端、
// 重复请求持续刷新录制内容；想回放时把场景「应用」为活动规则即可。
//
// 场景：即一份命名的规则文件快照，存放在 mock-rules.json 同目录的 scenes/ 下。
// 应用（覆盖活动规则文件）后 loadMockRules 的 mtime 缓存自动感知，无需重启 mock。
//
// 本模块不依赖 electron / config store：scenesDir 由 IPC 层从 config 算好传入，
// 方便在纯 node 环境下冒烟测试。

import fs from "node:fs";
import path from "node:path";
import { sendMockRecording } from "../ui-channel.js";

let session = null; // { sceneName, file, rules: Map<key, rule>, startedAt }

function sanitizeSceneName(rawName) {
  const name = String(rawName || "")
    .replace(/[/\\:*?"<>|]/g, "")
    .trim();
  if (!name) throw new Error("场景名不能为空（或仅含非法字符）");
  if (name.length > 60) throw new Error("场景名过长（最多 60 字符）");
  return name;
}

export function sceneFilePath(scenesDir, name) {
  return path.join(scenesDir, `${sanitizeSceneName(name)}.json`);
}

function ruleKey(rule) {
  return `${(rule.method || "*").toUpperCase()} ${rule.path}`;
}

// ─── 录制 ─────────────────────────────────────────────────────────────────────

export function getRecordingStatus() {
  if (!session) return { enabled: false };
  return {
    enabled: true,
    sceneName: session.sceneName,
    count: session.rules.size,
    startedAt: session.startedAt,
  };
}

function pushStatus() {
  sendMockRecording(getRecordingStatus());
}

export function startRecording({ sceneName: rawName, scenesDir }) {
  const sceneName = sanitizeSceneName(rawName);
  fs.mkdirSync(scenesDir, { recursive: true });
  const file = sceneFilePath(scenesDir, sceneName);

  // 场景已存在则在其基础上续录（增量录制）；文件损坏就从空开始
  const rules = new Map();
  for (const rule of readSceneRules(scenesDir, sceneName)) {
    rules.set(ruleKey(rule), rule);
  }

  session = { sceneName, file, rules, startedAt: Date.now() };
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
 * onRecord 管道调用：把符合条件的代理响应固化成录制场景里的规则。
 * 只收 2xx 且完整记录到的 JSON 响应；mock 命中（含回放）不会被再次录制，天然无回环。
 */
export function handleRecordedEntry(entry) {
  if (!session) return;
  if (entry.kind !== "proxy") return;
  if (!entry.status || entry.status < 200 || entry.status >= 300) return;
  if (entry.responseTruncated || !entry.responseIsJson) return;

  const rule = {
    enabled: true,
    method: entry.method,
    // 命中过 swagger 路由的用带 {param} 的模板，同类请求共用一条规则（后录的覆盖先录的）
    path: entry.matchedPath || entry.path,
    response: entry.responseBody,
  };
  session.rules.set(ruleKey(rule), rule);
  try {
    writeRulesFileSync(session.file, [...session.rules.values()]);
  } catch (err) {
    console.error("[mock-recorder]", err);
  }
  pushStatus();
}

// ─── 场景 ─────────────────────────────────────────────────────────────────────

function writeRulesFileSync(file, rules) {
  fs.writeFileSync(file, `${JSON.stringify(rules, null, 2)}\n`, "utf-8");
}

export function listScenes(scenesDir) {
  if (!fs.existsSync(scenesDir)) return [];
  return fs
    .readdirSync(scenesDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const file = path.join(scenesDir, f);
      let ruleCount = 0;
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        ruleCount = Array.isArray(parsed) ? parsed.length : 0;
      } catch {
        // 损坏的场景文件按 0 条展示，应用时会报错
      }
      return {
        name: f.replace(/\.json$/, ""),
        ruleCount,
        updatedAt: fs.statSync(file).mtimeMs,
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 读场景规则；文件不存在 / 损坏返回 []。 */
export function readSceneRules(scenesDir, name) {
  const file = sceneFilePath(scenesDir, name);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeSceneRules(scenesDir, name, rules) {
  fs.mkdirSync(scenesDir, { recursive: true });
  writeRulesFileSync(sceneFilePath(scenesDir, name), rules);
  return sanitizeSceneName(name);
}

export function deleteScene(scenesDir, name) {
  const sceneName = sanitizeSceneName(name);
  if (session && session.sceneName === sceneName) {
    throw new Error(`场景「${sceneName}」正在录制中，请先停止录制`);
  }
  fs.rmSync(sceneFilePath(scenesDir, sceneName), { force: true });
}
