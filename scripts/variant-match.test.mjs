// variant-match.js（mock 规则变体等值匹配）的语义测试：node --test scripts/
// 纯模块直测，不依赖 electron / fs。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  matchWhen,
  selectVariant,
  normalizeWhen,
  normalizeVariantLoose,
  normalizeVariantStrict,
  normalizeVariantsStrict,
  flattenBodyFields,
} from "../src/mock/variant-match.js";

// ─── matchWhen：query ────────────────────────────────────────────────────────

test("query：存在且字符串相等才命中；缺 key / 值不同不命中", () => {
  const when = normalizeWhen({ query: { page: 2 } }); // 数字条件归一化为 "2"
  assert.equal(matchWhen(when, { query: { page: "2" } }), true);
  assert.equal(matchWhen(when, { query: { page: "3" } }), false);
  assert.equal(matchWhen(when, { query: {} }), false);
  assert.equal(matchWhen(when, {}), false); // 连 query 对象都没有
});

test("query：多条件 AND", () => {
  const when = normalizeWhen({ query: { page: "2", size: "10" } });
  assert.equal(matchWhen(when, { query: { page: "2", size: "10", extra: "x" } }), true);
  assert.equal(matchWhen(when, { query: { page: "2" } }), false);
});

// ─── matchWhen：headers ──────────────────────────────────────────────────────

test("headers：条件 key 大小写不敏感（归一化为小写），值字符串相等", () => {
  const when = normalizeWhen({ headers: { "X-User-Role": "admin" } });
  assert.equal(matchWhen(when, { headers: { "x-user-role": "admin" } }), true);
  assert.equal(matchWhen(when, { headers: { "x-user-role": "guest" } }), false);
  assert.equal(matchWhen(when, { headers: {} }), false);
});

// ─── matchWhen：body ─────────────────────────────────────────────────────────

test("body：点路径取值，原始值两边 String 互转（1 与 \"1\"、true 与 \"true\" 互相命中）", () => {
  const when = normalizeWhen({ body: { "filter.type": "hot", count: 1, ok: true } });
  assert.equal(
    matchWhen(when, { body: { filter: { type: "hot" }, count: "1", ok: "true" } }),
    true,
  );
  assert.equal(matchWhen(when, { body: { filter: { type: "new" }, count: 1, ok: true } }), false);
});

test("body：数组索引路径 items.0.id", () => {
  const when = normalizeWhen({ body: { "items.0.id": 7 } });
  assert.equal(matchWhen(when, { body: { items: [{ id: 7 }] } }), true);
  assert.equal(matchWhen(when, { body: { items: [] } }), false);
});

test("body：null 条件仅命中 null；路径取不到不命中", () => {
  const when = normalizeWhen({ body: { deleted: null } });
  assert.equal(matchWhen(when, { body: { deleted: null } }), true);
  assert.equal(matchWhen(when, { body: { deleted: "null" } }), false);
  assert.equal(matchWhen(when, { body: {} }), false);
});

test("body：对象/数组条件走深相等，key 顺序无关，嵌套内不做数字/字符串互转", () => {
  const when = normalizeWhen({ body: { filter: { type: "hot", level: 2 } } });
  assert.equal(matchWhen(when, { body: { filter: { level: 2, type: "hot" } } }), true);
  assert.equal(matchWhen(when, { body: { filter: { level: "2", type: "hot" } } }), false); // 嵌套不互转
  assert.equal(matchWhen(when, { body: { filter: { type: "hot" } } }), false); // key 数不等
});

test("body：非 JSON body / 无 body 一律不命中", () => {
  const when = normalizeWhen({ body: { a: 1 } });
  assert.equal(matchWhen(when, { body: undefined }), false);
  assert.equal(matchWhen(when, { body: "raw-text" }), false);
  assert.equal(matchWhen(when, { body: 42 }), false);
});

// ─── matchWhen：跨域 AND ─────────────────────────────────────────────────────

test("query + headers + body 三域全部 AND", () => {
  const when = normalizeWhen({
    query: { page: "2" },
    headers: { "x-role": "admin" },
    body: { "filter.type": "hot" },
  });
  const full = {
    query: { page: "2" },
    headers: { "x-role": "admin" },
    body: { filter: { type: "hot" } },
  };
  assert.equal(matchWhen(when, full), true);
  assert.equal(matchWhen(when, { ...full, headers: { "x-role": "guest" } }), false);
});

// ─── selectVariant ───────────────────────────────────────────────────────────

function variant(name, when, extra = {}) {
  return { name, enabled: true, when: normalizeWhen(when), response: { name }, ...extra };
}

test("selectVariant：first-match 按数组顺序；无命中返回 undefined", () => {
  const rule = {
    variants: [
      variant("宽条件", { query: { page: "2" } }),
      variant("更具体但排后", { query: { page: "2", size: "10" } }),
    ],
  };
  assert.equal(
    selectVariant(rule, { query: { page: "2", size: "10" } })?.name,
    "宽条件", // 顺序即优先级，不做特异性排序
  );
  assert.equal(selectVariant(rule, { query: { page: "9" } }), undefined);
  assert.equal(selectVariant({}, { query: {} }), undefined); // 无 variants 字段
});

test("selectVariant：enabled=false 跳过；缺 response 的脏数据跳过", () => {
  const rule = {
    variants: [
      variant("已停用", { query: { p: "1" } }, { enabled: false }),
      { name: "脏数据", when: normalizeWhen({ query: { p: "1" } }) }, // 无 response
      variant("兜底命中", { query: { p: "1" } }),
    ],
  };
  assert.equal(selectVariant(rule, { query: { p: "1" } })?.name, "兜底命中");
});

// ─── normalize：Loose ────────────────────────────────────────────────────────

test("normalizeVariantLoose：非法输入返回 undefined（缺 name / 空 when / 缺 response）", () => {
  assert.equal(normalizeVariantLoose(null), undefined);
  assert.equal(normalizeVariantLoose({ when: { query: { a: 1 } }, response: {} }), undefined);
  assert.equal(normalizeVariantLoose({ name: "x", when: {}, response: {} }), undefined);
  assert.equal(normalizeVariantLoose({ name: "x", when: { query: { a: 1 } } }), undefined);
});

test("normalizeVariantLoose：合法输入清洗字段（header 小写、query 值转字符串、非法 status 丢弃）", () => {
  const out = normalizeVariantLoose({
    name: " 变体A ",
    when: { query: { page: 2 }, headers: { "X-Role": "admin" } },
    response: { rc: 0 },
    status: "abc",
    delay: 300,
  });
  assert.deepEqual(out, {
    name: "变体A",
    enabled: true,
    when: { query: { page: "2" }, headers: { "x-role": "admin" } },
    response: { rc: 0 },
    delay: 300,
  });
});

// ─── normalize：Strict ───────────────────────────────────────────────────────

test("normalizeVariantStrict：各校验分支抛中文错误", () => {
  const L = "第 1 条规则的第 1 个变体";
  assert.throws(() => normalizeVariantStrict(null, L), /必须是对象/);
  assert.throws(() => normalizeVariantStrict({ when: { query: { a: 1 } }, response: {} }, L), /缺少 name/);
  assert.throws(
    () => normalizeVariantStrict({ name: "长".repeat(61), when: { query: { a: 1 } }, response: {} }, L),
    /name 过长/,
  );
  assert.throws(() => normalizeVariantStrict({ name: "x", when: {}, response: {} }, L), /至少要有一个条件/);
  assert.throws(() => normalizeVariantStrict({ name: "x", when: { query: { a: 1 } } }, L), /缺少 response/);
  assert.throws(
    () => normalizeVariantStrict({ name: "x", when: { query: { a: 1 } }, response: {}, status: "abc" }, L),
    /status 必须是整数/,
  );
  assert.throws(
    () => normalizeVariantStrict({ name: "x", when: { query: { a: 1 } }, response: {}, delay: -1 }, L),
    /delay 必须是大于等于 0 的整数/,
  );
});

// ─── flattenBodyFields（UI 列出可做条件的 body 字段）──────────────────────────

test("flattenBodyFields：对象递归、数组取第一项拼 .0、只收原始值叶子", () => {
  const fields = flattenBodyFields({
    name: "张三",
    filter: { type: "hot", level: 2 },
    items: [{ id: 7, tag: null }],
    empty: [],
  });
  assert.deepEqual(fields, [
    { path: "name", type: "string", example: "张三" },
    { path: "filter.type", type: "string", example: "hot" },
    { path: "filter.level", type: "number", example: 2 },
    { path: "items.0.id", type: "number", example: 7 },
    { path: "items.0.tag", type: "null", example: null },
  ]); // empty: [] 不产出字段（没有可取值的叶子）
});

// 这条是 flattenBodyFields 与 matchWhen 的契约：产出的每条 path，
// 拿它的 example 当条件，必须能在同一份 body 上命中。两边语义漂移就会挂。
test("flattenBodyFields 产出的路径都能被 matchWhen 命中（生成/消费语义一致）", () => {
  const body = {
    name: "张三",
    filter: { type: "hot", level: 2, on: true },
    items: [{ id: 7 }],
  };
  const fields = flattenBodyFields(body);
  assert.ok(fields.length >= 5);
  for (const field of fields) {
    const when = normalizeWhen({ body: { [field.path]: field.example } });
    assert.equal(
      matchWhen(when, { body }),
      true,
      `路径 ${field.path} 取不回原值`,
    );
  }
});

test("flattenBodyFields：顶层数组 body 产出 0.x 路径（无前导点），且能被 matchWhen 命中", () => {
  const body = [{ id: 7, tag: "hot" }];
  const fields = flattenBodyFields(body);
  assert.deepEqual(fields.map((f) => f.path), ["0.id", "0.tag"]);
  for (const field of fields) {
    const when = normalizeWhen({ body: { [field.path]: field.example } });
    assert.equal(matchWhen(when, { body }), true, `路径 ${field.path} 取不回原值`);
  }
});

test("flattenBodyFields：深度限制与数量限制", () => {
  // 1. 深度限制：默认最大深度为 5，深度大于 5 级的属性（第 6 级及以上）应该被截断
  const deepObj = {
    l1: {
      l2: {
        l3: {
          l4: {
            l5: "ok leaf", // 第 5 级（leaf），可以产出
            l5_obj: {
              l6: "too deep", // 第 6 级（leaf），超过 depth 5，应被截断
            },
          },
        },
      },
    },
  };
  const fieldsDeep = flattenBodyFields(deepObj);
  const pathsDeep = fieldsDeep.map(f => f.path);
  assert.ok(pathsDeep.includes("l1.l2.l3.l4.l5"));
  assert.ok(!pathsDeep.includes("l1.l2.l3.l4.l5_obj.l6"));


  // 2. 数量限制：超过 200 个字段时截断
  const largeObj = {};
  for (let i = 0; i < 250; i++) {
    largeObj[`field_${i}`] = i;
  }
  const fieldsLarge = flattenBodyFields(largeObj);
  assert.equal(fieldsLarge.length, 200);
});


test("normalizeVariantsStrict：非数组报错；name 规则内重复报错", () => {
  assert.throws(() => normalizeVariantsStrict({}, "第 1 条规则"), /variants 必须是数组/);
  const v = { name: "同名", when: { query: { a: "1" } }, response: {} };
  assert.throws(() => normalizeVariantsStrict([v, { ...v }], "第 1 条规则"), /name 重复：同名/);
  // 合法数组原样通过
  assert.equal(normalizeVariantsStrict([v], "第 1 条规则").length, 1);
});
