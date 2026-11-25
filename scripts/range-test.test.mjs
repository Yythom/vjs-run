// 改动测试台（src/services/range-test、src/services/t3-cli.js）的纯逻辑：node --test scripts/
//
// 不调真的 t3：线程状态推导、输出解析、错误归类用实测过的 JSON 形状喂；git 范围解析在
// mkdtemp 里建临时仓库跑；记录扫描在临时目录里造产物。

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildFollowUpMessage,
  buildReplyMessage,
  buildResumeMessage,
  buildStartMessage,
  isEmptyReply,
} from "../src/services/range-test/prompt.js";
import { diffChecklist, isOfflineItem, remainingCells } from "../src/services/range-test/checklist.js";
import {
  classifyT3Failure,
  deriveThreadState,
  parseJsonOutput,
  summarizeThread,
} from "../src/services/t3-cli.js";
import {
  SIDECAR,
  assertRecordDir,
  listRecords,
  phaseKind,
  sanitizeTopic,
  updateSidecar,
  writeSidecar,
} from "../src/services/range-test/records.js";
import { listCommitsSince, parseCommitLines, resolveRange } from "../src/services/range-test/git.js";
import { describeBusyPorts, parseLsofListen } from "../src/services/range-test/ports.js";
import { extractFindings, latestEvidence, sceneNamesIn } from "../src/services/range-test/records.js";
import { parseT3Models } from "../src/services/range-test/t3-models.js";
import { normalizeConfig, normalizeRangeTest } from "../src/config/normalize.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "range-test-"));

// ─── 提示词 ───────────────────────────────────────────────────────────────────

test("首条消息：范围已定、产物目录、不许用提问工具、停在确认点", () => {
  const msg = buildStartMessage({
    repoPath: "/r/vjs",
    base: "aaa",
    tip: "bbb",
    count: 3,
    topic: "最近3个",
    dir: "/h/test-records/vjs/最近3个",
  });
  assert.match(msg, /commit-range-test/);
  assert.match(msg, /aaa\.\.bbb（3 个提交，使用者已在界面上选定，不用再问范围）/);
  assert.match(msg, /产物目录：\/h\/test-records\/vjs\/最近3个/);
  assert.match(msg, /不要用提问工具/);
  assert.match(msg, /做到确认点就停/);
});

test("回复：确认开测 + 删行、改预期、限定模块和站、疑问、补充", () => {
  const msg = buildReplyMessage({
    confirm: true,
    removals: [{ id: "A3", reason: "纯运营文案" }, { id: "  ", reason: "空编号丢掉" }],
    edits: [{ id: "A5", expected: "默认选中 500" }, { id: "A6", expected: "" }],
    questions: [{ id: "B2", text: "子账号也要弹吗？" }],
    groups: ["A. 充值弹框", "B. 升级页"],
    sites: ["视频", "音乐"],
    note: "埋点先不管",
  });
  assert.match(msg, /^确认开测，先按下面的调整改清单。/);
  assert.match(msg, /- 删 A3：纯运营文案/);
  assert.doesNotMatch(msg, /空编号/);
  assert.match(msg, /- A5 预期改为：默认选中 500/);
  assert.doesNotMatch(msg, /A6/);
  assert.match(msg, /只测这些模块：A\. 充值弹框、B\. 升级页/);
  assert.match(msg, /只测这些站：视频、音乐/);
  assert.match(msg, /- B2：子账号也要弹吗？/);
  assert.match(msg, /补充：埋点先不管/);
  assert.match(msg, /截图存到产物目录的 evidence\/ 下/);
  assert.match(msg, /不要用提问工具/);
});

test("回复：不确认时要求停在确认点；没有任何调整的不确认回复算空", () => {
  const msg = buildReplyMessage({ confirm: false, removals: [{ id: "A1", reason: "" }] });
  assert.match(msg, /^先不开测。.*停在确认点/);
  assert.match(msg, /- 删 A1：使用者定不测/);
  // 截图约定只在开测时带上
  assert.doesNotMatch(msg, /evidence\//);
  assert.equal(isEmptyReply({ confirm: false }), true);
  assert.equal(isEmptyReply({ confirm: false, edits: [{ id: "A1", expected: " " }] }), true);
  assert.equal(isEmptyReply({ confirm: false, note: "看下 A1" }), false);
  assert.equal(isEmptyReply({ confirm: true }), false);
  assert.match(buildReplyMessage({ confirm: true }), /^确认开测，清单不用调整。/);
});

// ─── t3 输出与状态 ────────────────────────────────────────────────────────────

test("线程状态：提问工具等回答、失败、排队/在跑、结束", () => {
  assert.equal(deriveThreadState({ status: "running", pendingRequestCount: 1 }), "needs-answer");
  assert.equal(deriveThreadState({ status: "failed", pendingRequestCount: 0, activeRunId: null }), "failed");
  assert.equal(deriveThreadState({ status: "waiting", pendingRequestCount: 0, activeRunId: null }), "running");
  assert.equal(deriveThreadState({ status: "running", pendingRequestCount: 0, activeRunId: "run:1" }), "running");
  assert.equal(deriveThreadState({ status: "completed", pendingRequestCount: 0, activeRunId: null }), "idle");
  assert.equal(deriveThreadState(null), "unknown");
});

test("线程摘要取最后一条 assistant 消息（失败原因就在这里）", () => {
  const s = summarizeThread({
    thread: {
      threadId: "mcp:1",
      link: "https://app.t3.codes/threads/x/mcp%3A1",
      status: "failed",
      pendingRequestCount: 0,
      activeRunId: null,
      providerInstanceId: "magpie",
      model: "m",
      runCount: 1,
    },
    messages: [
      { role: "user", text: "测" },
      { role: "assistant", text: "Failed to authenticate. API Error: 403" },
    ],
  });
  assert.equal(s.state, "failed");
  assert.equal(s.lastMessage, "Failed to authenticate. API Error: 403");
  assert.equal(s.link, "https://app.t3.codes/threads/x/mcp%3A1");
});

test("--json 输出：取第一行 JSON，--wait 后面跟的说明文字不影响", () => {
  const out =
    '{"threadId":"mcp:f0","status":"waiting","reply":null}\nThread mcp:f0 is waiting for an answer. Open it in T3 Code to respond.\n';
  assert.deepEqual(parseJsonOutput(out), { threadId: "mcp:f0", status: "waiting", reply: null });
  assert.deepEqual(parseJsonOutput('{\n  "a": 1\n}\n'), { a: 1 });
  assert.equal(parseJsonOutput("no json here"), null);
});

test("t3 失败归类：没装、模型不在套餐、连不上服务、其他", () => {
  assert.equal(classifyT3Failure({ spawnErrorCode: "ENOENT" }).code, "T3_NOT_INSTALLED");
  assert.equal(
    classifyT3Failure({ stderr: "API Error: 403 Command Code: MODEL_NOT_IN_PLAN: Claude Opus" }).code,
    "MODEL_NOT_IN_PLAN",
  );
  assert.equal(classifyT3Failure({ stderr: "connect ECONNREFUSED 127.0.0.1:3773" }).code, "T3_NOT_RUNNING");
  const other = classifyT3Failure({ stderr: "\nsomething odd\nmore" });
  assert.equal(other.code, "T3_FAILED");
  assert.equal(other.message, "something odd");
});

// ─── 记录 ─────────────────────────────────────────────────────────────────────

test("主题当目录名：去掉路径分隔符和控制字符，不能以点开头", () => {
  assert.equal(sanitizeTopic("  feat/cart: 分享 *文案*  "), "feat-cart- 分享 -文案-");
  assert.equal(sanitizeTopic("../etc"), "etc");
  assert.equal(sanitizeTopic("a\tb\nc"), "a-b-c");
  assert.equal(sanitizeTopic("..."), "");
});

test("阶段行归类", () => {
  assert.equal(phaseKind("待确认"), "pending");
  assert.equal(phaseKind("已确认（11-24；调整：无）"), "confirmed");
  assert.equal(phaseKind(null), "none");
  assert.equal(phaseKind("别的"), "none");
});

test("扫描记录：有 sidecar 或有清单的算，按更新时间倒序；记录目录只认两层", () => {
  const root = tmp();
  const a = path.join(root, "vjs-monorepo", "老记录");
  fs.mkdirSync(a, { recursive: true });
  fs.writeFileSync(path.join(a, "老记录-test-checklist.md"), "# t\n\n阶段：已确认（11-15）\n");
  const b = path.join(root, "vjs-monorepo", "新记录");
  writeSidecar(b, { topic: "新记录", threadId: "mcp:1", lastState: "running" });
  fs.mkdirSync(path.join(root, "vjs-monorepo", "空目录"));
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(b, SIDECAR), future, future);

  const recs = listRecords(root);
  assert.deepEqual(
    recs.map((r) => [r.topic, r.phaseKind, Boolean(r.sidecar)]),
    [
      ["新记录", "none", true],
      ["老记录", "confirmed", false],
    ],
  );
  assert.equal(recs[1].checklistPath, path.join(a, "老记录-test-checklist.md"));

  assert.equal(updateSidecar(b, { lastState: "idle" }).threadId, "mcp:1");
  assert.equal(updateSidecar(a, { lastState: "idle" }), null);

  assert.equal(assertRecordDir(root, a), a);
  assert.throws(() => assertRecordDir(root, path.join(root, "vjs-monorepo")), /不是改动测试记录目录/);
  assert.throws(() => assertRecordDir(root, path.join(root, "..", "x", "y")), /不是改动测试记录目录/);
  assert.throws(() => assertRecordDir(root, "/etc/passwd"), /不是改动测试记录目录/);
});

// ─── git 范围 ─────────────────────────────────────────────────────────────────

function makeRepo(n) {
  const repo = tmp();
  const g = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  g("init", "-q");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  const shas = [];
  for (let i = 0; i < n; i++) {
    fs.writeFileSync(path.join(repo, "f.txt"), `${i}\n`);
    g("add", "-A");
    g("commit", "-qm", `c${i}`);
    shas.push(g("rev-parse", "HEAD"));
  }
  return { repo, shas };
}

test("范围解析：最近 N 个、指定起止（包含起点）、先后颠倒和非法输入报错", async () => {
  const { repo, shas } = makeRepo(5);
  assert.deepEqual(await resolveRange(repo, { kind: "recent", count: 2 }), { base: shas[2], tip: shas[4], count: 2 });
  assert.deepEqual(await resolveRange(repo, { kind: "custom", from: shas[1], to: shas[3] }), {
    base: shas[0],
    tip: shas[3],
    count: 3,
  });
  await assert.rejects(resolveRange(repo, { kind: "custom", from: shas[4], to: shas[1] }), /起点不在终点之前/);
  await assert.rejects(resolveRange(repo, { kind: "recent", count: 0 }), /正整数/);
  await assert.rejects(resolveRange(repo, { kind: "nope" }), /未知的范围类型/);
});

test("提交列表解析", () => {
  assert.deepEqual(parseCommitLines("abc\x1fa\x1f虎虎\x1f2026-11-24\x1ffix: a | b"), [
    { sha: "abc", short: "a", author: "虎虎", date: "2026-11-24", subject: "fix: a | b" },
  ]);
  assert.deepEqual(parseCommitLines(""), []);
});

// ─── 配置 ─────────────────────────────────────────────────────────────────────

test("配置：rangeTest 不会被 normalizeConfig 丢掉；provider / model 要成对，留空回默认", () => {
  const def = DEFAULT_CONFIG.rangeTest;
  assert.deepEqual(normalizeConfig({}).rangeTest, def);
  assert.deepEqual(
    normalizeConfig({ rangeTest: { provider: "cursor", model: "grok-4.7", recordsDir: " ~/tr " } }).rangeTest,
    { provider: "cursor", model: "grok-4.7", recordsDir: "~/tr" },
  );
  assert.deepEqual(normalizeRangeTest({ provider: "cursor", model: "" }), def);
  assert.deepEqual(normalizeRangeTest(null), def);
});

// ─── 开测之后 ─────────────────────────────────────────────────────────────────

const item = (id, fields, states) => ({
  id,
  fields,
  results: states.map(([site, state]) => ({ site, state })),
});

test("剩余格：本地能测的和【测试服】【真机】【线上】的分开", () => {
  const items = [
    item("A1", { 前置: "余额 0" }, [["视频", "pass"], ["SEO", "todo"]]),
    item("A2", { 前置: "【线上】生产环境" }, [["视频", "todo"], ["SEO", "todo"]]),
    item("A3", { 前置: "x", 预期: "【真机】扫码后跳转" }, [["视频", "na"]]),
  ];
  assert.deepEqual(remainingCells(items), { local: ["A1·SEO"], offline: ["A2·视频", "A2·SEO"] });
  assert.equal(isOfflineItem(items[2]), true);
  assert.equal(isOfflineItem(items[0]), false);
});

test("确认后改动：按编号逐列比较文字列，结果格不算；删掉和新增的单列", () => {
  const before = [
    item("A1", { 前置: "视频 5173", 预期: "200" }, [["视频", "todo"]]),
    item("A2", { 前置: "同上", 预期: "逐字一致" }, [["视频", "todo"]]),
    item("A4", { 前置: "干净工作区", 预期: "产物一致" }, [["视频", "todo"]]),
  ];
  const after = [
    item("A1", { 前置: "视频 5273", 预期: "200" }, [["视频", "pass"]]),
    item("A2", { 前置: "同上", 预期: "逐字一致" }, [["视频", "pass"]]),
    item("A2a", { 前置: "新增", 预期: "x" }, [["视频", "todo"]]),
  ];
  assert.deepEqual(diffChecklist(before, after), {
    edited: [{ id: "A1", field: "前置", before: "视频 5173", after: "视频 5273" }],
    removed: ["A4"],
    added: ["A2a"],
  });
});

test("后续消息：继续测跳过线上行，修正证据带上 status 原文；都带截图约定和不许用提问工具", () => {
  const cont = buildFollowUpMessage("continue");
  assert.match(cont, /从清单里还是 ⬜ 的格做起/);
  assert.match(cont, /【测试服】【真机】【线上】的行本地测不了/);
  const fix = buildFollowUpMessage("fix-evidence", { problems: ["打了 ✅ / ❌ 但 log 里没有对应证据标题：A1"] });
  assert.match(fix, /^`status --log --map` 报了下面这些证据问题/);
  assert.match(fix, /- 打了 ✅ \/ ❌ 但 log 里没有对应证据标题：A1/);
  for (const m of [cont, fix]) {
    assert.match(m, /evidence\//);
    assert.match(m, /不要用提问工具/);
  }
  assert.throws(() => buildFollowUpMessage("nope"), /未知的后续操作/);
});

test("换新线程：交代产物目录和续测规矩，不重做第 1～5 步", () => {
  const m = buildResumeMessage({ repoPath: "/r/vjs", base: "aaa", tip: "bbb", count: 2, topic: "t", dir: "/h/tr/vjs/t" });
  assert.match(m, /中断后续测/);
  assert.match(m, /产物目录：\/h\/tr\/vjs\/t/);
  assert.match(m, /还是「待确认」就回到确认点/);
  assert.match(m, /不重做第 1～5 步/);
  assert.match(m, /有证据问题先处理/);
  assert.match(m, /不要用提问工具/);
});

// ─── 第二期补充 ───────────────────────────────────────────────────────────────

test("开测类消息都要求逐格回填；核对线上行只读、未发布不判不通过；回归带上勾选的提交", () => {
  for (const m of [
    buildReplyMessage({ confirm: true }),
    buildFollowUpMessage("continue"),
    buildFollowUpMessage("check-offline"),
    buildResumeMessage({ repoPath: "/r", base: "a", tip: "b", count: 1, topic: "t", dir: "/d" }),
  ]) {
    assert.match(m, /每测完一格就马上回填/);
  }
  assert.doesNotMatch(buildReplyMessage({ confirm: false, note: "x" }), /每测完一格/);
  const off = buildFollowUpMessage("check-offline");
  assert.match(off, /只做 GET 访问/);
  assert.match(off, /不下单、不付款/);
  assert.match(off, /未发布，暂不能核对/);
  const reg = buildFollowUpMessage("regress", {
    commits: [{ sha: "0123456789abcdef", subject: "fix: 补上静态托管" }],
  });
  assert.match(reg, /做第 9 步回归/);
  assert.match(reg, /- 0123456789 fix: 补上静态托管/);
  assert.match(reg, /正文第一行写「回归」/);
  assert.throws(() => buildFollowUpMessage("regress", { commits: [] }), /回归要带上修复提交/);
});

test("实测提交之后的提交：不含起点，新的在前", async () => {
  const { repo, shas } = makeRepo(4);
  const list = await listCommitsSince(repo, shas[1]);
  assert.deepEqual(list.map((c) => c.sha), [shas[3], shas[2]]);
  assert.equal(list[0].subject, "c3");
  assert.deepEqual(await listCommitsSince(repo, shas[3]), []);
});

test("端口占用：只留常用 dev 端口，同一进程同一端口去重；没有占用时不写说明", () => {
  const text = ["p11523", "cnode", "n[::1]:5173", "n127.0.0.1:5173", "p2201", "cControlCe", "n*:7000", "p900", "cnode", "n*:8801", ""].join("\n");
  const list = parseLsofListen(text);
  assert.deepEqual(list, [
    { port: 5173, pid: 11523, command: "node" },
    { port: 8801, pid: 900, command: "node" },
  ]);
  const note = describeBusyPorts([{ port: 5173, pid: 11523, command: "node", cwd: "/x/brotato" }]);
  assert.match(note, /5173（node，\/x\/brotato，PID 11523）/);
  assert.match(note, /不是你起的就不要停它/);
  assert.equal(describeBusyPorts([]), "");
});

test("log 里的「发现」一节、提到的场景名、最近一张截图", () => {
  const log = [
    "# log",
    "测试提交：abc1234",
    "## 发现",
    "- README 滞后",
    "### 子标题也算在里面",
    "## 实测证据",
    "### A1 · 视频",
    "场景：测试-购物车分享与音乐站充值链接（13 条），备份 `备份-1124-0131`。",
  ].join("\n");
  assert.equal(extractFindings(log), "- README 滞后\n### 子标题也算在里面");
  assert.equal(extractFindings("## 其他发现\n无\n"), "无");
  assert.equal(extractFindings("## 发现（11-24）\n- a\n## 下一节"), "- a");
  assert.equal(extractFindings("## 发现与说明\n- a"), "");
  assert.equal(extractFindings("# 没有"), "");
  assert.deepEqual(sceneNamesIn(log), ["测试-购物车分享与音乐站充值链接", "备份-1124-0131"]);

  const dir = tmp();
  assert.equal(latestEvidence(dir), null);
  fs.mkdirSync(path.join(dir, "evidence"));
  fs.writeFileSync(path.join(dir, "evidence", "A1-视频.png"), "x");
  fs.writeFileSync(path.join(dir, "evidence", "A2-视频.png"), "x");
  fs.writeFileSync(path.join(dir, "evidence", "notes.txt"), "x");
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(dir, "evidence", "A1-视频.png"), later, later);
  assert.equal(latestEvidence(dir).path, "evidence/A1-视频.png");
});

test("T3 模型清单：配了自定义模型的实例只列自己的；没配的列内置当前模型；未启用的排后面；读不到 driver 清单就是空", () => {
  const settings = {
    providerInstances: {
      claudeAgent: { driver: "claudeAgent", enabled: false },
      magpie: {
        driver: "claudeAgent",
        displayName: "magpie",
        enabled: true,
        config: {
          customModels: [
            { slug: "commandcode/deepseek/deepseek-v4.1-flash-fast[1m]", name: "DeepSeek V4.1 Flash Fast" },
            { name: "没有 slug 的丢掉" },
          ],
        },
      },
      antigravity: { driver: "antigravity", enabled: true },
      grok: { driver: "grok", displayName: "Grok", enabled: true },
    },
  };
  const manifest = {
    manifest: {
      providers: {
        claudeAgent: { models: [{ slug: "claude-opus-5-5", name: "Claude Opus 5.5", status: "current" }] },
        antigravity: {
          models: [
            { slug: "gemini-4-carbon", name: "Gemini 4 Carbon", status: "current" },
            { slug: "gemini-pro-agent", name: "Gemini Pro Agent", status: "legacy" },
          ],
        },
      },
    },
  };
  const list = parseT3Models(settings, manifest);
  assert.deepEqual(
    list.map((p) => [p.id, p.enabled, p.loadsClaudeSkills, p.models.map((m) => m.slug)]),
    [
      ["magpie", true, true, ["commandcode/deepseek/deepseek-v4.1-flash-fast[1m]"]],
      ["antigravity", true, false, ["gemini-4-carbon"]],
      ["grok", true, false, []],
      ["claudeAgent", false, true, ["claude-opus-5-5"]],
    ],
  );
  assert.equal(list.find((p) => p.id === "grok").name, "Grok");
  // 没有内置清单也不报错，只是列不出模型
  assert.deepEqual(parseT3Models(settings, null).find((p) => p.id === "antigravity").models, []);
  assert.deepEqual(parseT3Models({}, manifest), []);
});
