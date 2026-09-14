// req-to-plan 工作包 → AI 工单台任务库 的桥接测试：node --test scripts/req-to-docking.test.mjs
// 脚本按子进程跑，测的是真实 CLI 契约（位置参数 / WORKPACK_DIR / RECORD_ID 环境变量）；
// userData 一律用临时目录，绝不触碰真实任务库。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const SCRIPT = fileURLToPath(new URL("./req-to-docking.mjs", import.meta.url));

/** 造一个最小可用的 req-to-plan 工作包。 */
function freshWorkpack({ recordId = "recTEST0001", assets = 2, requirement = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "req-bridge-"));
  const dir = path.join(root, ".requirements", recordId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "context.md"),
    [
      "# 工作包: 视频详情页增加「相似推荐」模块",
      "",
      "## 需求元信息",
      "",
      `- record_id: \`${recordId}\``,
      "- 业务线对应仓库 token: `video` `foto`",
      "- 方案文档: https://example.feishu.cn/wiki/ABCdef123",
      "",
    ].join("\n"),
  );
  if (requirement) fs.writeFileSync(path.join(dir, "requirement.md"), "需求正文\n");
  if (assets) {
    fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
    for (let i = 1; i <= assets; i += 1) {
      fs.writeFileSync(path.join(dir, "assets", `img-0${i}.png`), `png${i}`);
    }
  }
  return { dir, userData: path.join(root, "userData") };
}

function run(args, { env = {}, userData } = {}) {
  return execFileSync(process.execPath, [SCRIPT, ...args, "--user-data", userData], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const readStore = (userData) =>
  JSON.parse(fs.readFileSync(path.join(userData, "docking-tasks.json"), "utf8"));

test("工作包入库：标题取自 context.md，source/repoPath/status 正确", () => {
  const { dir, userData } = freshWorkpack();
  run([dir, "--repo", "/tmp/some-repo"], { userData });

  const { tasks } = readStore(userData);
  assert.equal(tasks.length, 1);
  const [task] = tasks;
  assert.equal(task.title, "视频详情页增加「相似推荐」模块");
  assert.equal(task.source, "req-pool");
  assert.equal(task.status, "inbox");
  assert.equal(task.repoPath, "/tmp/some-repo");
  assert.equal(task.requester.name, "需求池");
  assert.equal(task.seq, 1);
  // 方案 B 的接线点：runner 靠它决定要不要 --add-dir + 注入 skill.md
  assert.equal(task.workpackDir, dir);
});

test("入库结果行走 stdout，才能被 req watch --exec 回显出来", () => {
  const { dir, userData } = freshWorkpack();
  assert.match(run([dir], { userData }), /✓ #1「视频详情页增加「相似推荐」模块」已入库（4 个附件）/);
});

test("附件：context.md + requirement.md + 每张截图，路径全是绝对路径", () => {
  const { dir, userData } = freshWorkpack({ assets: 3 });
  run([dir], { userData });

  const [task] = readStore(userData).tasks;
  assert.equal(task.attachments.length, 5);
  assert.deepEqual(
    task.attachments.map((a) => a.name),
    ["context.md", "requirement.md", "img-01.png", "img-02.png", "img-03.png"],
  );
  assert.deepEqual(
    task.attachments.map((a) => a.type),
    ["file", "file", "image", "image", "image"],
  );
  for (const att of task.attachments) {
    assert.ok(path.isAbsolute(att.path), `${att.name} 必须是绝对路径`);
    assert.ok(fs.existsSync(att.path), `${att.name} 必须真实存在`);
  }
});

test("幂等：同一个工作包重复跑不重复入库，--force 才强插", () => {
  const { dir, userData } = freshWorkpack();
  run([dir], { userData });
  // 结果行必须在 stdout：req watch --exec 只回显 stdout
  assert.match(run([dir], { userData }), /↷ 已在任务库里（#1/);
  assert.equal(readStore(userData).tasks.length, 1);

  run([dir, "--force"], { userData });
  assert.equal(readStore(userData).tasks.length, 2);
});

test("不污染 processedMessageIds，也不编造假 messageId", () => {
  const { dir, userData } = freshWorkpack();
  run([dir], { userData });

  const store = readStore(userData);
  // 那是 500 条的环形缓冲，塞非 IM 的 key 会把真实消息 id 挤掉，
  // 反而让飞书侧重复建任务
  assert.deepEqual(store.processedMessageIds, []);
  // 填假 id 会让完成通知拿它去 im +messages-reply，白起一个 lark-cli 进程再失败
  assert.equal(store.tasks[0].messageId, "");
});

test("走 req watch --exec 的环境变量契约：WORKPACK_DIR / RECORD_ID", () => {
  const { dir, userData } = freshWorkpack({ recordId: "recFromWatch" });
  run([], { userData, env: { WORKPACK_DIR: dir, RECORD_ID: "recFromWatch" } });

  const [task] = readStore(userData).tasks;
  assert.match(task.content, /需求池 record_id：recFromWatch/);
  assert.match(task.content, new RegExp(`工作包目录：${dir}`));
});

test("正文保留段落空行（filter 只能滤 null，不能用 Boolean 把空串一起吃掉）", () => {
  const { dir, userData } = freshWorkpack();
  run([dir], { userData });

  const { content } = readStore(userData).tasks[0];
  assert.ok(content.includes("**产出是一份实施 plan，不是代码改动。**\n\n工作包目录："));
  assert.ok(content.includes("\n\n- 入口："), "材料清单前必须有空行分隔");
});

test("没有截图时正文如实说明，不谎报要读图", () => {
  const { dir, userData } = freshWorkpack({ assets: 0 });
  run([dir], { userData });

  const { content } = readStore(userData).tasks[0];
  assert.match(content, /- 本需求没有截图。/);
  assert.ok(!/必须逐张 Read/.test(content), "没图就别写「必须逐张 Read」");
  assert.equal(readStore(userData).tasks[0].attachments.length, 2);
});

test("缺 context.md 直接报错，不往库里塞半成品", () => {
  const { dir, userData } = freshWorkpack();
  fs.rmSync(path.join(dir, "context.md"));

  assert.throws(
    () => run([dir], { userData }),
    (err) => /缺 context.md/.test(String(err.stderr)),
  );
  assert.ok(!fs.existsSync(path.join(userData, "docking-tasks.json")));
});

test("--dry-run 只打印不落库", () => {
  const { dir, userData } = freshWorkpack();
  const out = run([dir, "--dry-run"], { userData });

  assert.match(out, /视频详情页增加「相似推荐」模块/);
  assert.ok(!fs.existsSync(path.join(userData, "docking-tasks.json")));
});
