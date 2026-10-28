// 场景文件：mock-rules.json 同目录 scenes/<场景名>.json，结构与活动规则完全一致（规则数组）。
// app（ipc.js 经 recorder.js）和 vjtools CLI 共用。
//
// 「录制中的场景禁止外部写入 / 删除 / 改名」是 app 进程内的录制状态，由 recorder.js
// 包一层守卫；本模块只管文件，纯 node，不能 import electron。

import fs from "node:fs";
import path from "node:path";
import { ruleKey, writeRulesFile } from "./rules.js";

export function scenesDirOf(rulesFile) {
  return path.join(path.dirname(rulesFile), "scenes");
}

export function sanitizeSceneName(rawName) {
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

/** 读场景规则；文件不存在 / 损坏返回 []（UI 展示用；要据此改写文件的请用 rules.js 的 readRulesFile） */
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
  const sceneName = sanitizeSceneName(name);
  writeRulesFile(sceneFilePath(scenesDir, sceneName), rules);
  return sceneName;
}

/**
 * 把 incoming 规则逐条 upsert 进 existing：按 method + path 命中的替换成 incoming
 * 那一条（整个规则对象换掉），没命中的追加到末尾，其余规则原样保留、顺序不变。
 * 纯函数，不碰文件系统。
 */
export function mergeSceneRules(existing = [], incoming = []) {
  const merged = [...existing];
  const indexByKey = new Map(merged.map((rule, index) => [ruleKey(rule), index]));
  let overwritten = 0;

  for (const rule of incoming) {
    const key = ruleKey(rule);
    const at = indexByKey.get(key);
    if (at === undefined) {
      indexByKey.set(key, merged.length);
      merged.push(rule);
    } else {
      merged[at] = rule;
      overwritten += 1;
    }
  }

  return { rules: merged, overwritten, added: incoming.length - overwritten };
}

export function deleteScene(scenesDir, name) {
  fs.rmSync(sceneFilePath(scenesDir, name), { force: true });
}

// 重命名场景（改文件名）。源不存在或目标同名（非自身）报错。
export function renameScene(scenesDir, oldName, newName) {
  const from = sanitizeSceneName(oldName);
  const to = sanitizeSceneName(newName);
  const fromFile = sceneFilePath(scenesDir, from);
  if (!fs.existsSync(fromFile)) throw new Error(`场景不存在：${from}`);
  if (to === from) return to;
  const toFile = sceneFilePath(scenesDir, to);
  if (fs.existsSync(toFile)) throw new Error(`场景已存在：${to}`);
  fs.renameSync(fromFile, toFile);
  return to;
}
