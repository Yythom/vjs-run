// Mock 规则「变体」（variants）：一条规则（method+path）内按请求特征返回不同响应。
//
// 变体结构（嵌套在规则的 variants 数组里，按序 first-match）：
//   { name, enabled, when: { query?, headers?, body? }, response, status?, delay? }
//
// V1 只做相等匹配（全部条件 AND）：
//   - query：请求 query 中存在该 key 且字符串相等（条件值归一化时已 String 强转）
//   - headers：条件 key 归一化为小写（Node 入站 header 天然小写），字符串相等
//   - body：key 是点路径（a.b.c，数字段可索引数组）；仅 JSON body 可命中。
//     原始值（string/number/boolean）两边 String() 互转比较（1 与 "1" 命中）；
//     条件值为对象/数组时做深度相等（嵌套内不做数字/字符串互转）；null 仅命中 null。
//
// 命不中任何变体时回退规则顶层的 response/status/delay——所以「空 when」非法，
// 兜底语义不由变体承担。
//
// 纯模块：不碰 fs / electron / req 对象，方便 node --test 直测。
// 加载热路径用 Loose（非法变体静默丢弃，手改文件不至于整条规则崩掉），
// 保存路径用 Strict（非法直接抛中文错误，把问题挡在写盘前）。

const VARIANT_NAME_MAX = 60;

// ─── 归一化 ──────────────────────────────────────────────────────────────────

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// when 归一化：header key 小写化，query/header 条件值 String 强转；
// 无任何有效条件时返回 undefined。
export function normalizeWhen(when) {
  if (!isPlainObject(when)) return undefined;

  const out = {};
  let total = 0;

  if (isPlainObject(when.query)) {
    const query = {};
    for (const [key, value] of Object.entries(when.query)) {
      if (!key) continue;
      query[key] = String(value);
      total++;
    }
    if (Object.keys(query).length) out.query = query;
  }

  if (isPlainObject(when.headers)) {
    const headers = {};
    for (const [key, value] of Object.entries(when.headers)) {
      if (!key) continue;
      headers[key.toLowerCase()] = String(value);
      total++;
    }
    if (Object.keys(headers).length) out.headers = headers;
  }

  if (isPlainObject(when.body)) {
    const body = {};
    for (const [key, value] of Object.entries(when.body)) {
      if (!key) continue;
      body[key] = value; // body 条件值保留原始 JSON 类型，比较时再区分原始值/深相等
      total++;
    }
    if (Object.keys(body).length) out.body = body;
  }

  return total > 0 ? out : undefined;
}

// 加载路径：非法变体返回 undefined（调用方 filter 掉），不抛错。
export function normalizeVariantLoose(variant) {
  if (!isPlainObject(variant)) return undefined;

  const name = typeof variant.name === "string" ? variant.name.trim() : "";
  if (!name) return undefined;

  const when = normalizeWhen(variant.when);
  if (!when) return undefined;
  if (variant.response === undefined) return undefined;

  const out = { name, enabled: variant.enabled !== false, when, response: variant.response };

  const status = Number(variant.status);
  if (variant.status !== undefined && Number.isInteger(status)) out.status = status;
  const delay = Number(variant.delay);
  if (variant.delay !== undefined && Number.isInteger(delay) && delay >= 0) out.delay = delay;

  return out;
}

// 保存路径：label 形如「第 2 条规则的第 1 个变体」，拼进中文报错。
export function normalizeVariantStrict(variant, label) {
  if (!isPlainObject(variant)) throw new Error(`${label}必须是对象`);

  const name = typeof variant.name === "string" ? variant.name.trim() : "";
  if (!name) throw new Error(`${label}缺少 name（变体名，规则内唯一）`);
  if (name.length > VARIANT_NAME_MAX) {
    throw new Error(`${label}的 name 过长（最多 ${VARIANT_NAME_MAX} 字符）：${name}`);
  }

  const when = normalizeWhen(variant.when);
  if (!when) {
    throw new Error(
      `${label}的 when 至少要有一个条件（query/headers/body）；无条件的兜底响应请放在规则顶层`,
    );
  }
  if (variant.response === undefined) throw new Error(`${label}缺少 response`);

  const out = { name, enabled: variant.enabled !== false, when, response: variant.response };

  if (variant.status !== undefined && variant.status !== "") {
    const status = Number(variant.status);
    if (!Number.isInteger(status)) throw new Error(`${label}的 status 必须是整数`);
    out.status = status;
  }
  if (variant.delay !== undefined && variant.delay !== "") {
    const delay = Number(variant.delay);
    if (!Number.isInteger(delay) || delay < 0) {
      throw new Error(`${label}的 delay 必须是大于等于 0 的整数`);
    }
    out.delay = delay;
  }

  return out;
}

// 保存路径的数组入口：校验每个变体 + name 规则内唯一。ruleLabel 形如「第 2 条规则」。
export function normalizeVariantsStrict(variants, ruleLabel) {
  if (!Array.isArray(variants)) throw new Error(`${ruleLabel}的 variants 必须是数组`);

  const seen = new Set();
  return variants.map((variant, index) => {
    const normalized = normalizeVariantStrict(variant, `${ruleLabel}的第 ${index + 1} 个变体`);
    if (seen.has(normalized.name)) {
      throw new Error(`${ruleLabel}的变体 name 重复：${normalized.name}`);
    }
    seen.add(normalized.name);
    return normalized;
  });
}

// ─── 匹配 ────────────────────────────────────────────────────────────────────

// 点路径取值：a.b.c / items.0.id。只往对象/数组里走，取不到返回 undefined。
function getByPath(value, dotPath) {
  let current = value;
  for (const part of String(dotPath).split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = current[part];
  }
  return current;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    return (
      keysA.length === Object.keys(b).length &&
      keysA.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]))
    );
  }
  return false;
}

function isPrimitive(value) {
  const type = typeof value;
  return type === "string" || type === "number" || type === "boolean";
}

function matchBodyValue(actual, expected) {
  if (expected === null) return actual === null;
  if (isPrimitive(expected)) {
    return isPrimitive(actual) && String(actual) === String(expected);
  }
  return deepEqual(actual, expected); // 对象/数组条件：深相等，嵌套内不做互转
}

// when 的全部条件 AND；query/headers/body 均为纯对象
// （headers 直接传 req.headers 即可，body 传 parseRequestBody 的结果）。
export function matchWhen(when, { query, headers, body } = {}) {
  if (!isPlainObject(when)) return false;

  if (when.query) {
    for (const [key, expected] of Object.entries(when.query)) {
      if (!isPlainObject(query)) return false;
      if (!Object.prototype.hasOwnProperty.call(query, key)) return false;
      if (String(query[key]) !== String(expected)) return false;
    }
  }

  if (when.headers) {
    for (const [key, expected] of Object.entries(when.headers)) {
      const actual = headers?.[key.toLowerCase()];
      if (actual === undefined) return false;
      if (String(actual) !== String(expected)) return false;
    }
  }

  if (when.body) {
    // 仅 JSON 对象/数组 body 可命中（getByPath 对非对象一律返回 undefined）
    for (const [dotPath, expected] of Object.entries(when.body)) {
      const actual = getByPath(body, dotPath);
      if (actual === undefined) return false;
      if (!matchBodyValue(actual, expected)) return false;
    }
  }

  return true;
}

// 规则内首个启用且命中的变体；无命中返回 undefined（调用方回退规则顶层）。
export function selectVariant(rule, request) {
  const variants = rule?.variants;
  if (!Array.isArray(variants)) return undefined;
  return variants.find(
    (variant) =>
      isPlainObject(variant) &&
      variant.enabled !== false &&
      variant.response !== undefined &&
      matchWhen(variant.when, request),
  );
}
