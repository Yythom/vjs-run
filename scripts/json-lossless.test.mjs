// parseJsonLossless 的快路径：node --test scripts/
//
// 先原生 JSON.parse，结果里没有被舍入的整数就直接返回，有才带 reviver 重新解析。这里拿改动前
// 「每个值都过 reviver」的实现当基准，逐个比对，保证快路径只是提速、不改变任何输出。

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseJsonLossless } from "../src/mock/json-lossless.js";

// 改动前的实现（每个值都过 reviver）
function slowPath(text) {
  return JSON.parse(text, (key, value, context) =>
    key !== "" && typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value) && context?.source
      ? JSON.rawJSON(context.source)
      : value,
  );
}

const same = (text) => assert.equal(JSON.stringify(parseJsonLossless(text)), JSON.stringify(slowPath(text)), text);

test("没有大整数的文本：结果与 JSON.parse 完全相同，不带 rawJSON 包装", () => {
  for (const text of [
    `{"rc":0,"data":{"list":[{"id":1,"price":12.5,"ok":true,"name":"用户"}]}}`,
    `[1,2,3]`,
    `"字符串"`,
    `123456789012345`, // 15 位：一定在安全范围内
    `null`,
  ]) {
    assert.deepEqual(parseJsonLossless(text), JSON.parse(text), text);
    same(text);
  }
});

test("嵌套很深、没有大整数的 JSON 走快路径（带 reviver 时 V8 内部递归会爆栈，改动前也一样）", () => {
  const deep = `${"[".repeat(5000)}{"id":1}${"]".repeat(5000)}`;
  assert.throws(() => slowPath(deep), RangeError);
  assert.doesNotThrow(() => parseJsonLossless(deep));
});

test("会被舍入的数字都走慢路径，原文保留", () => {
  for (const [text, expected] of [
    [`{"id":1850123456789012345}`, `{"id":1850123456789012345}`],
    [`{"id":-1850123456789012345}`, `{"id":-1850123456789012345}`],
    // 16 位：2^53 = 9007199254740992 已经超出安全范围
    [`{"id":9007199254740993}`, `{"id":9007199254740993}`],
    // 指数写法：位数很少也可能是超出安全范围的整数
    [`{"n":1e23}`, `{"n":1e23}`],
    [`{"n":1.5E+18}`, `{"n":1.5E+18}`],
  ]) {
    assert.equal(JSON.stringify(parseJsonLossless(text)), expected);
    same(text);
  }
});

test("字符串里的雪花 ID、安全范围内的 16 位数、顶层大整数：结果与 JSON.parse 相同", () => {
  for (const text of [
    `{"id":"1850123456789012345","n":1}`,
    `{"hash":"md5e3","n":2}`,
    `{"v":9007199254740991}`, // 16 位但仍在安全范围内
    `1850123456789012345`, // 顶层数字本来就不包（调用方拿到的应该是普通值）
  ]) {
    assert.deepEqual(parseJsonLossless(text), JSON.parse(text), text);
    same(text);
  }
});

test("非法 JSON 两条路径都照常抛 SyntaxError", () => {
  assert.throws(() => parseJsonLossless("{a:1}"), SyntaxError);
  assert.throws(() => parseJsonLossless("{a:1850123456789012345}"), SyntaxError);
  assert.throws(() => parseJsonLossless(""), SyntaxError);
});

test("随机比对：各种位数 / 正负 / 小数 / 指数 / 数字串混排，两条路径输出一致", () => {
  // 固定种子的 mulberry32（Math.imul 保证 32 位整数运算，普通乘法会超出 2^53 自己先丢精度），失败时可复现
  let seed = 20261101;
  const rand = (n) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
  const digits = (len) => String(1 + rand(9)) + Array.from({ length: len - 1 }, () => rand(10)).join("");
  const number = () => {
    const sign = rand(4) === 0 ? "-" : "";
    // 一半偏短，保证快路径（没有超出安全范围的整数）也被大量覆盖
    const int = digits(rand(2) ? 1 + rand(12) : 1 + rand(22));
    const frac = rand(3) === 0 ? `.${digits(1 + rand(5))}` : "";
    const exp = rand(4) === 0 ? `${rand(2) ? "e" : "E"}${["", "+", "-"][rand(3)]}${rand(30)}` : "";
    return sign + int + frac + exp;
  };
  const value = () => (rand(3) === 0 ? `"${rand(2) ? digits(1 + rand(20)) : "id" + number()}"` : number());

  let fast = 0;
  for (let i = 0; i < 3000; i++) {
    const text = `{"a":${value()},"b":[${value()},{"c":${value()}}]}`;
    let unsafe = false;
    JSON.parse(text, (key, v) => {
      if (typeof v === "number" && Number.isInteger(v) && !Number.isSafeInteger(v)) unsafe = true;
      return v;
    });
    if (!unsafe) fast += 1;
    same(text);
  }
  // 两条路径都要被大量覆盖，否则这个比对没有意义
  assert.ok(fast > 300 && fast < 2700, `快路径 ${fast} 条 / 3000`);
});
