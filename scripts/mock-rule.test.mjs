// mock-rule.mjs 的 CLI 自动化测试：node --test scripts/
// 每个用例用 mkdtemp 出来的独立 VJTOOLS_USER_DATA_DIR，绝不触碰真实用户数据。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("./mock-rule.mjs", import.meta.url));
const REPO_ROOT = path.dirname(path.dirname(CLI));

function freshUserData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mock-rule-test-"));
}

// 跑一次 CLI。stdin 传 string 即管道输入；不传则模拟无管道（stdin 关闭，非 TTY，
// readFileSync(0) 返回空 → readStdin() 归一为 null，与终端直跑等价）。
function run(userData, args, stdin) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    input: stdin ?? "",
    encoding: "utf8",
    env: { ...process.env, VJTOOLS_USER_DATA_DIR: userData, MOCK_RULES_FILE: "" },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

function rulesFile(userData) {
  return path.join(userData, "mock-assets", "mock-rules.json");
}

function sceneFile(userData, name) {
  return path.join(userData, "mock-assets", "scenes", `${name}.json`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// ─── set / get / list ────────────────────────────────────────────────────────

test("set 新增规则：stdin response + status + delay 全部落盘，enabled 默认 true", () => {
  const ud = freshUserData();
  const r = run(ud, ["set", "--path", "/api/login", "--method", "post", "--status", "200", "--delay", "300"], '{"rc":0}');
  assert.equal(r.code, 0, r.err);
  const rules = readJson(rulesFile(ud));
  assert.deepEqual(rules, [
    { enabled: true, method: "POST", path: "/api/login", status: 200, delay: 300, response: { rc: 0 } },
  ]);
});

test("set 幂等覆盖：只改 response 时保留原有 status/delay，且不动其它规则", () => {
  const ud = freshUserData();
  run(ud, ["set", "--path", "/api/a", "--status", "500", "--delay", "100"], '{"v":1}');
  run(ud, ["set", "--path", "/api/b"], '{"v":2}');
  const r = run(ud, ["set", "--path", "/api/a"], '{"v":9}');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /已更新/);
  const rules = readJson(rulesFile(ud));
  assert.equal(rules.length, 2);
  assert.deepEqual(rules[0], { enabled: true, method: "*", path: "/api/a", status: 500, delay: 100, response: { v: 9 } });
  assert.deepEqual(rules[1].response, { v: 2 });
});

test("set --disabled 建禁用规则；enable/disable 只翻转 enabled", () => {
  const ud = freshUserData();
  run(ud, ["set", "--path", "/api/x", "--disabled"], '{"v":1}');
  assert.equal(readJson(rulesFile(ud))[0].enabled, false);
  assert.equal(run(ud, ["enable", "--path", "/api/x"]).code, 0);
  assert.equal(readJson(rulesFile(ud))[0].enabled, true);
  assert.equal(run(ud, ["disable", "--path", "/api/x"]).code, 0);
  const rule = readJson(rulesFile(ud))[0];
  assert.equal(rule.enabled, false);
  assert.deepEqual(rule.response, { v: 1 }); // 其余字段不受影响
});

test("set 幂等定位区分 method；--method 缺省为 *", () => {
  const ud = freshUserData();
  run(ud, ["set", "--path", "/api/a", "--method", "GET"], '{"m":"get"}');
  run(ud, ["set", "--path", "/api/a"], '{"m":"star"}');
  const rules = readJson(rulesFile(ud));
  assert.equal(rules.length, 2);
  assert.deepEqual(rules.map((r) => r.method).sort(), ["*", "GET"]);
});

test("get 输出规则 JSON；未命中非 0 退出", () => {
  const ud = freshUserData();
  run(ud, ["set", "--path", "/api/user/{id}"], '{"id":1}');
  const hit = run(ud, ["get", "--path", "/api/user/{id}"]);
  assert.equal(hit.code, 0);
  assert.deepEqual(JSON.parse(hit.out), { enabled: true, method: "*", path: "/api/user/{id}", response: { id: 1 } });
  // 占位符规则必须字面定位，具体路径定位不到
  assert.notEqual(run(ud, ["get", "--path", "/api/user/123"]).code, 0);
});

test("list 展示开关/状态码/延迟标记；空文件显示 (空)", () => {
  const ud = freshUserData();
  assert.match(run(ud, ["list"]).out, /\(空\)/);
  run(ud, ["set", "--path", "/api/a", "--status", "500", "--delay", "200"], '{"v":1}');
  run(ud, ["set", "--path", "/api/b", "--disabled"], '{"v":2}');
  const out = run(ud, ["list"]).out;
  assert.match(out, /● \*\s+\/api\/a \[500\] \+200ms/);
  assert.match(out, /○ \*\s+\/api\/b/);
});

test("rm 只删目标规则；未命中非 0 退出", () => {
  const ud = freshUserData();
  run(ud, ["set", "--path", "/api/a"], '{"v":1}');
  run(ud, ["set", "--path", "/api/b"], '{"v":2}');
  assert.equal(run(ud, ["rm", "--path", "/api/a"]).code, 0);
  assert.deepEqual(readJson(rulesFile(ud)).map((r) => r.path), ["/api/b"]);
  assert.notEqual(run(ud, ["rm", "--path", "/api/a"]).code, 0);
});

// ─── 校验失败路径 ─────────────────────────────────────────────────────────────

test("校验失败均非 0 退出并带原因", () => {
  const ud = freshUserData();
  const cases = [
    [["set"], "缺少 --path"],
    [["set", "--path", "api/no-slash"], "必须以 \\/ 开头"],
    [["set", "--path", "/api/a", "--status", "abc"], "status 必须是整数"],
    [["set", "--path", "/api/a", "--status"], "--status 需要一个整数值"],
    [["set", "--path", "/api/a", "--delay", "-1"], "delay 必须是大于等于 0 的整数"],
    [["set", "--path", "/api/a", "--delay"], "--delay 需要一个毫秒数"],
  ];
  for (const [args, msg] of cases) {
    const r = run(ud, args, '{"v":1}');
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.err, new RegExp(msg));
  }
  // stdin 非法 JSON
  const bad = run(ud, ["set", "--path", "/api/a"], "not-json");
  assert.equal(bad.code, 1);
  assert.match(bad.err, /stdin 不是合法 JSON/);
  // 全部失败后不产生规则文件残留
  assert.equal(fs.existsSync(rulesFile(ud)), false);
});

test("规则文件损坏时报错而不是清空重建", () => {
  const ud = freshUserData();
  fs.mkdirSync(path.dirname(rulesFile(ud)), { recursive: true });
  fs.writeFileSync(rulesFile(ud), "{broken");
  const r = run(ud, ["set", "--path", "/api/a"], '{"v":1}');
  assert.equal(r.code, 1);
  assert.match(r.err, /不是合法 JSON/);
  assert.equal(fs.readFileSync(rulesFile(ud), "utf8"), "{broken"); // 原文件未被动过
});

// ─── 场景 ────────────────────────────────────────────────────────────────────

test("场景生命周期：new-scene → set --scene → scenes/list → rm-scene，全程不碰活动规则", () => {
  const ud = freshUserData();
  assert.equal(run(ud, ["new-scene", "--scene", "登录联调"]).code, 0);
  assert.deepEqual(readJson(sceneFile(ud, "登录联调")), []);
  // 同名报错
  const dup = run(ud, ["new-scene", "--scene", "登录联调"]);
  assert.equal(dup.code, 1);
  assert.match(dup.err, /场景已存在/);

  run(ud, ["set", "--scene", "登录联调", "--path", "/api/login", "--method", "POST"], '{"token":"abc"}');
  assert.equal(readJson(sceneFile(ud, "登录联调")).length, 1);
  assert.equal(fs.existsSync(rulesFile(ud)), false); // 活动规则未被创建/改动

  assert.match(run(ud, ["scenes"]).out, /登录联调\s+1 条/);
  assert.match(run(ud, ["list", "--scene", "登录联调"]).out, /POST\s+\/api\/login/);

  assert.equal(run(ud, ["rm-scene", "--scene", "登录联调"]).code, 0);
  assert.equal(fs.existsSync(sceneFile(ud, "登录联调")), false);
  const gone = run(ud, ["rm-scene", "--scene", "登录联调"]);
  assert.equal(gone.code, 1);
  assert.match(gone.err, /场景不存在/);
});

test("rename-scene：正常改名保留内容；同名幂等；源缺失/目标已存在/缺 --to 报错", () => {
  const ud = freshUserData();
  run(ud, ["new-scene", "--scene", "旧名"]);
  run(ud, ["set", "--scene", "旧名", "--path", "/api/a"], '{"v":1}');

  assert.equal(run(ud, ["rename-scene", "--scene", "旧名", "--to", "新名"]).code, 0);
  assert.equal(fs.existsSync(sceneFile(ud, "旧名")), false);
  assert.deepEqual(readJson(sceneFile(ud, "新名"))[0].response, { v: 1 });

  assert.equal(run(ud, ["rename-scene", "--scene", "新名", "--to", "新名"]).code, 0); // 幂等

  const missing = run(ud, ["rename-scene", "--scene", "旧名", "--to", "别名"]);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /场景不存在/);

  run(ud, ["new-scene", "--scene", "占位"]);
  const conflict = run(ud, ["rename-scene", "--scene", "新名", "--to", "占位"]);
  assert.equal(conflict.code, 1);
  assert.match(conflict.err, /场景已存在/);

  const noTo = run(ud, ["rename-scene", "--scene", "新名"]);
  assert.equal(noTo.code, 1);
  assert.match(noTo.err, /--to 需要一个新场景名/);
});

test("场景名清洗：非法字符剔除、空名/超长报错（对齐 recorder.js 的 sanitizeSceneName）", () => {
  const ud = freshUserData();
  assert.equal(run(ud, ["new-scene", "--scene", 'a/b\\c:*?"<>|d']).code, 0);
  assert.equal(fs.existsSync(sceneFile(ud, "abcd")), true);

  const empty = run(ud, ["new-scene", "--scene", "///"]);
  assert.equal(empty.code, 1);
  assert.match(empty.err, /场景名不能为空/);

  const long = run(ud, ["new-scene", "--scene", "长".repeat(61)]);
  assert.equal(long.code, 1);
  assert.match(long.err, /场景名过长/);
});

// ─── 文件定位 ─────────────────────────────────────────────────────────────────

test("--file / MOCK_RULES_FILE 覆盖活动规则文件路径", () => {
  const ud = freshUserData();
  const custom = path.join(ud, "custom-rules.json");
  run(ud, ["set", "--file", custom, "--path", "/api/a"], '{"v":1}');
  assert.equal(readJson(custom).length, 1);
  assert.equal(fs.existsSync(rulesFile(ud)), false);

  const viaEnv = path.join(ud, "env-rules.json");
  const r = spawnSync(process.execPath, [CLI, "set", "--path", "/api/b"], {
    input: '{"v":2}',
    encoding: "utf8",
    env: { ...process.env, VJTOOLS_USER_DATA_DIR: ud, MOCK_RULES_FILE: viaEnv },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readJson(viaEnv).length, 1);
});

test("写盘原子性：不残留 .tmp 文件", () => {
  const ud = freshUserData();
  run(ud, ["set", "--path", "/api/a"], '{"v":1}');
  const dir = path.dirname(rulesFile(ud));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});

// ─── 副本同步（防漂移）───────────────────────────────────────────────────────

test("skill 目录的 mock-rule.mjs 与仓库根字节一致（改了记得 cp 同步）", () => {
  const skillCopy = path.join(REPO_ROOT, ".claude", "skills", "mock-rules", "scripts", "mock-rule.mjs");
  assert.equal(
    fs.readFileSync(skillCopy, "utf8"),
    fs.readFileSync(CLI, "utf8"),
    "skill 副本与 scripts/mock-rule.mjs 不一致：cp scripts/mock-rule.mjs .claude/skills/mock-rules/scripts/",
  );
});
