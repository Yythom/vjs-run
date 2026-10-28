// mock 规则的唯一实现：字段规整 / 校验、按 method+path 定位与增删改、规则文件读写。
// app（server.js 读取、service.js 保存、ipc.js 场景）和 vjtools CLI（vjtools mock rule）都用这里。
//
// 规则结构：{ enabled, method, path, status?, delay?, response?, variants? }
// 给规则加字段时，只需要改本文件的两个规整函数（读取用的 Loose、保存用的 Strict），
// 两者都是按字段重建对象，漏改哪一个，新字段就会在那条路径上被静默丢弃。
//
// 纯 node 模块，不能 import electron / config store。

import fs from "node:fs";
import path from "node:path";
import {
  isValidHttpStatus,
  normalizeVariantLoose,
  normalizeVariantsStrict,
} from "./variant-match.js";

// ─── 规整 / 校验 ─────────────────────────────────────────────────────────────

// 规则必须带具体 method——OpenAPI 里每个操作本来就绑定在某个 method 上，规则没理由
// 比 spec 更宽松。缺 method 或写 "*" 的规则一律不再命中，但**不能静默跳过**：
// 「规则明明写了却不生效」是最难查的一类问题。loadMockRules 按 mtime 缓存，
// 同一份文件只会归一化一次，所以这里喊一次就够，不会每个请求刷屏。
function warnMissingMethod(rulePath) {
  console.warn(
    `[mock] 规则 ${rulePath || "(缺 path)"} 没有具体 method（缺省或 "*"），` +
      `不会命中任何请求。请改成 GET / POST 等具体方法。`,
  );
}

/** 读取路径（加载热路径 / 编辑器展示）：宽松，非法变体静默丢弃，手改文件不至于整条规则失效 */
export function normalizeMockRule(rule) {
  // 字符串简写只给得出 path、给不出 method，因此不再是可命中的规则
  if (typeof rule === "string") {
    warnMissingMethod(rule);
    return {
      method: "",
      path: rule,
      enabled: true,
    };
  }

  const variants = Array.isArray(rule.variants)
    ? rule.variants.map(normalizeVariantLoose).filter(Boolean)
    : [];

  const method = String(rule.method ?? "").trim().toUpperCase();
  if (!method || method === "*") warnMissingMethod(rule.path);

  return {
    method,
    path: rule.path,
    response: rule.response,
    status: rule.status,
    delay: rule.delay,
    enabled: rule.enabled !== false,
    ...(variants.length ? { variants } : {}),
  };
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== "";
}

/** status 校验：空值返回 undefined；label 形如「第 2 条规则的 」，拼进中文报错 */
export function parseRuleStatus(value, label = "") {
  if (!hasValue(value)) return undefined;
  const status = Number(value);
  if (!Number.isInteger(status)) throw new Error(`${label}status 必须是整数：${value}`);
  if (!isValidHttpStatus(status)) throw new Error(`${label}status 必须在 100–599 之间：${value}`);
  return status;
}

export function parseRuleDelay(value, label = "") {
  if (!hasValue(value)) return undefined;
  const delay = Number(value);
  if (!Number.isInteger(delay) || delay < 0) {
    throw new Error(`${label}delay 必须是大于等于 0 的整数：${value}`);
  }
  return delay;
}

/**
 * 保存路径（编辑器保存、导入 / 应用 / 存入场景、CLI 写规则）：严格，非法直接抛中文错误，
 * 把「保存成功却永远不生效 / 请求时才 500」的规则挡在写盘前。
 * @param label 「第 2 条规则」这类定位前缀，CLI 单条操作时传空串
 */
export function normalizeRuleStrict(rule, label = "") {
  const source = typeof rule === "string" ? { path: rule } : rule || {};
  const of = label ? `${label}的 ` : "";

  const rulePath = typeof source.path === "string" ? source.path.trim() : "";
  if (!rulePath) throw new Error(`${label || "规则"}缺少 path`);
  // path 会编译成锚定正则去匹配请求 pathname（必然以 / 开头），不以 / 开头的规则永远命中不了
  if (!rulePath.startsWith("/")) throw new Error(`${of}path 必须以 / 开头：${rulePath}`);

  // 缺 method / "*" 的规则 server 永远不会命中（只在主进程 console.warn），保存时就挡住
  const method = String(source.method ?? "").trim().toUpperCase();
  if (!method || method === "*") {
    throw new Error(`${label || "规则"}（${rulePath}）缺少具体 method，请改成 GET / POST 等`);
  }

  const status = parseRuleStatus(source.status, of);
  const delay = parseRuleDelay(source.delay, of);
  // variants 用原始输入严格校验，避免非法变体被静默丢弃后「保存成功但内容缩水」
  const variants =
    source.variants !== undefined && source.variants !== null
      ? normalizeVariantsStrict(source.variants, label || "该规则")
      : [];

  return {
    enabled: source.enabled !== false,
    method,
    path: rulePath,
    ...(status !== undefined ? { status } : {}),
    ...(delay !== undefined ? { delay } : {}),
    ...(source.response !== undefined ? { response: source.response } : {}),
    ...(variants.length ? { variants } : {}),
  };
}

export function normalizeRulesForSave(rules = []) {
  if (!Array.isArray(rules)) {
    throw new Error("Mock rules 必须是数组");
  }
  return rules.map((rule, index) => normalizeRuleStrict(rule, `第 ${index + 1} 条规则`));
}

// ─── 定位 / 增删改（纯函数，不碰文件）──────────────────────────────────────────

/** 规则唯一键：method 大写 + 字面 path（占位符规则 /api/user/{id} 必须原样定位） */
export function ruleKey(rule) {
  return `${String(rule?.method || "").toUpperCase()} ${rule?.path}`;
}

export function findRuleIndex(rules, method, rulePath) {
  const key = ruleKey({ method, path: rulePath });
  return rules.findIndex((rule) => ruleKey(rule) === key);
}

/** 按 method+path 幂等写入：命中替换，未命中追加；不动其它规则 */
export function upsertRule(rules, rule) {
  const next = [...rules];
  const index = findRuleIndex(next, rule.method, rule.path);
  if (index >= 0) next[index] = rule;
  else next.push(rule);
  return { rules: next, created: index < 0 };
}

export function findVariantIndex(rule, name) {
  if (!Array.isArray(rule?.variants)) return -1;
  return rule.variants.findIndex(
    (variant) => variant && typeof variant.name === "string" && variant.name.trim() === name,
  );
}

/** 按变体名幂等写入：命中替换，未命中追加到末尾（顺序即 first-match 的匹配序） */
export function upsertVariant(rule, variant) {
  const variants = Array.isArray(rule.variants) ? [...rule.variants] : [];
  const index = findVariantIndex(rule, variant.name);
  if (index >= 0) variants[index] = variant;
  else variants.push(variant);
  return { rule: { ...rule, variants }, created: index < 0 };
}

/** 删除变体；删空后去掉 variants 字段，保持文件干净 */
export function removeVariant(rule, name) {
  const index = findVariantIndex(rule, name);
  if (index < 0) return { rule, removed: false };
  const variants = rule.variants.filter((_, i) => i !== index);
  const { variants: _dropped, ...rest } = rule;
  return { rule: variants.length ? { ...rest, variants } : rest, removed: true };
}

// ─── 文件读写 ─────────────────────────────────────────────────────────────────

/**
 * 严格读取：文件不存在 / 空文件视为 []；损坏则抛错（调用方据此拒绝写入，
 * 绝不能把读不出来的文件当成空数组再覆盖回去）。
 */
export function readRulesFile(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8").trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`规则文件不是合法 JSON：${file}\n  ${err.message}`, { cause: err });
  }
  if (!Array.isArray(parsed)) throw new Error(`规则文件顶层必须是数组：${file}`);
  return parsed;
}

/** 原子写入：先写 .tmp 再 rename，mock server 的 watcher / mtime 缓存不会读到半个文件 */
export function writeRulesFile(file, rules) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(rules, null, 2)}\n`, "utf-8");
  fs.renameSync(tmp, file);
}
