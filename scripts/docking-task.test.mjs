// 赛博牛马模块自动化测试：node --test scripts/docking-task.test.mjs
// 每个用例使用独立的临时目录作为 userData，绝不触碰真实数据。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  __resetCache,
  addTask,
  appendThread,
  deleteTask,
  findAwaitingBySender,
  findByMessageId,
  findBySenderSeq,
  findRecentBySender,
  getSettings,
  getTask,
  listTasks,
  setDataDir,
  setSettings,
  updateTask,
} from "../src/feishu/task-store.js";
import { parseMessageContent } from "../src/feishu/listener.js";

function freshUserData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docking-test-"));
  setDataDir(dir);
  __resetCache();
  return dir;
}

// ─── task-store 基础与缓存一致性 ──────────────────────────────────────────────

test("task-store: 基础添加、查询与 short sequence 号自增", () => {
  const ud = freshUserData();
  const t1 = addTask({
    messageId: "msg-1",
    chatId: "chat-1",
    chatType: "p2p",
    senderId: "user-1",
    senderName: "张三",
    content: "帮我对接批量打标签接口 /api/tags/batch",
    status: "inbox",
  });

  assert.equal(t1.seq, 1);
  assert.equal(t1.title, "帮我对接批量打标签接口 /api/tags/batch");
  assert.equal(t1.requester.name, "张三");

  const t2 = addTask({
    messageId: "msg-2",
    chatId: "chat-1",
    chatType: "p2p",
    senderId: "user-2",
    senderName: "李四",
    content: "另一个接口需求",
  });

  assert.equal(t2.seq, 2);
  const tasks = listTasks();
  assert.equal(tasks.length, 2);
});

test("task-store: 外部进程修改文件后，主进程 load 自动根据 mtime 重新加载新数据", async () => {
  const ud = freshUserData();
  const t1 = addTask({
    messageId: "msg-1",
    chatId: "chat-1",
    senderId: "user-1",
    content: "初始需求",
    status: "doing",
  });

  // 此时内存 cache 中 status 为 doing
  assert.equal(getTask(t1.id).status, "doing");

  // 模拟 MCP Server 外部进程直接修改 docking-tasks.json 磁盘文件
  const filePath = path.join(ud, "docking-tasks.json");
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  data.tasks[0].status = "done";
  data.tasks[0].note = "已由 AI 自动联调完成";

  // 等待 20ms 确保文件系统 mtime 发生变化
  await new Promise((r) => setTimeout(r, 30));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");

  // 主进程未手动 reload，直接调用 getTask / listTasks，应感知 mtime 变化并自动读取最新磁盘状态
  const updatedTask = getTask(t1.id);
  assert.equal(updatedTask.status, "done");
  assert.equal(updatedTask.note, "已由 AI 自动联调完成");
});

// ─── 跨会话隔离（chatId 校验）────────────────────────────────────────────────

test("findAwaitingBySender: 支持通过 chatId 隔离不同会话", () => {
  freshUserData();
  const t = addTask({
    messageId: "msg-awaiting",
    chatId: "chat-group-A",
    senderId: "user-1",
    content: "群聊 A 中的需求",
    status: "awaiting",
  });
  updateTask(t.id, { askedAt: Date.now() });

  // 相同 senderId 但不同 chatId，不应匹配
  const mismatch = findAwaitingBySender("user-1", "chat-group-B");
  assert.equal(mismatch, null);

  // 相同 senderId 且相同 chatId，成功命中
  const hit = findAwaitingBySender("user-1", "chat-group-A");
  assert.ok(hit);
  assert.equal(hit.id, t.id);

  // 缺省 chatId 时保持兼容命中
  const compat = findAwaitingBySender("user-1");
  assert.ok(compat);
});

test("findRecentBySender: 支持通过 chatId 隔离连发合并", () => {
  freshUserData();
  const t = addTask({
    messageId: "msg-recent",
    chatId: "chat-p2p-1",
    senderId: "user-2",
    content: "私聊提的需求",
    status: "inbox",
  });

  // 群聊发来的消息不应合并到私聊任务中
  const groupMsg = findRecentBySender("user-2", 60000, "chat-group-2");
  assert.equal(groupMsg, null);

  // 相同私聊会话内的消息可以正确合并
  const p2pMsg = findRecentBySender("user-2", 60000, "chat-p2p-1");
  assert.ok(p2pMsg);
  assert.equal(p2pMsg.id, t.id);
});

// ─── 飞书消息解析与富文本提取 ────────────────────────────────────────────────

test("parseMessageContent: 纯文本与 JSON 字符串解析", () => {
  assert.equal(parseMessageContent({ content: "纯文本内容" }), "纯文本内容");
  assert.equal(
    parseMessageContent({ content: JSON.stringify({ text: "包装在 JSON 里的文本" }) }),
    "包装在 JSON 里的文本",
  );
});

test("parseMessageContent: post 富文本平铺（标题、链接、@人、代码块、多段落）", () => {
  const postEvent = {
    msg_type: "post",
    content: JSON.stringify({
      zh_cn: {
        title: "批量打标签需求",
        content: [
          [
            { tag: "text", text: "请帮我对接 " },
            { tag: "a", text: "文档地址", href: "https://example.com/doc" },
            { tag: "at", user_id: "ou_123", user_name: "张三" },
          ],
          [
            { tag: "text", text: "接口示例：" },
            { tag: "code_block", text: 'POST /api/tags\n{"name": "test"}' },
          ],
        ],
      },
    }),
  };

  const parsed = parseMessageContent(postEvent);
  assert.match(parsed, /^批量打标签需求/);
  assert.match(parsed, /请帮我对接 \[文档地址\]\(https:\/\/example\.com\/doc\)@张三/);
  assert.match(parsed, /POST \/api\/tags/);
});

test("parseMessageContent: 图片与文件消息占位", () => {
  assert.equal(parseMessageContent({ msg_type: "image", content: "" }), "[图片]");
  assert.equal(
    parseMessageContent({
      msg_type: "file",
      content: JSON.stringify({ file_name: "api-spec.yaml" }),
    }),
    "[文件: api-spec.yaml]",
  );
});

// ─── 设置项与默认值 ──────────────────────────────────────────────────────────

test("settings: 默认开启 notifyOnComplete，支持修改并持久化", () => {
  freshUserData();
  const s = getSettings();
  assert.equal(s.notifyOnComplete, true);
  assert.equal(s.ackEnabled, true);

  setSettings({ notifyOnComplete: false });
  assert.equal(getSettings().notifyOnComplete, false);
});

// ─── 手动创建需求与 Repo 关联 ────────────────────────────────────────────────

test("task-store: 手动录入需求支持指定 title, senderName, repoPath 及 source", () => {
  freshUserData();
  const task = addTask({
    title: "手动录入的需求标题",
    content: "详细的接口需求描述 /api/v2/orders",
    senderName: "产品经理",
    repoPath: "/Users/dev/projects/order-web",
    source: "manual",
    status: "inbox",
  });

  assert.equal(task.seq, 1);
  assert.equal(task.title, "手动录入的需求标题");
  assert.equal(task.content, "详细的接口需求描述 /api/v2/orders");
  assert.equal(task.requester.name, "产品经理");
  assert.equal(task.repoPath, "/Users/dev/projects/order-web");
  assert.equal(task.source, "manual");

  // 支持 updateTask 更新 repoPath
  const updated = updateTask(task.id, { repoPath: "/Users/dev/projects/order-app" });
  assert.equal(updated.repoPath, "/Users/dev/projects/order-app");
});

test("task-store: 支持记录和更新 AI 执行产生的改动文件列表 modifiedFiles", () => {
  freshUserData();
  const task = addTask({
    title: "修改用户表单需求",
    content: "将表单字段 name 改为 username",
    senderName: "测试后端",
  });

  assert.deepEqual(task.modifiedFiles, []);

  // 模拟 runner 执行完毕后持久化 modifiedFiles
  const updated = updateTask(task.id, {
    modifiedFiles: ["src/components/UserForm.jsx", "src/api/user.js"],
  });

  assert.deepEqual(updated.modifiedFiles, [
    "src/components/UserForm.jsx",
    "src/api/user.js",
  ]);
});

// ─── p-queue 调度与并发任务队列 ──────────────────────────────────────────────

test("runner: enqueueJob 压入队列，状态流转与取消排队", async () => {
  freshUserData();
  const t1 = addTask({ title: "任务1", content: "需求1" });
  const t2 = addTask({ title: "任务2", content: "需求2" });

  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const { enqueueJob, getQueueStatus, cancelJob, setSpawnImpl, onQueueIdle } =
    await import("../src/feishu/runner.js");

  const mockProcs = [];
  setSpawnImpl(() => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = () => {
      proc.emit("close", 0);
    };
    mockProcs.push(proc);
    return proc;
  });

  const res1 = enqueueJob({
    ids: [t1.id],
    cwd: "/mock/cwd/repo-1",
    mode: "analyze",
  });

  assert.ok(res1.jobId);

  const res2 = enqueueJob({
    ids: [t2.id],
    cwd: "/mock/cwd/repo-2",
    mode: "analyze",
  });

  assert.ok(res2.jobId);
  assert.notEqual(res1.jobId, res2.jobId);

  const q = getQueueStatus();
  assert.ok(q.running.length + q.queued.length >= 1);

  // 测试取消指定任务
  const cancelled = cancelJob(res2.jobId);
  assert.equal(cancelled, true);

  // 让运行中的 mock proc 正常结束
  for (const p of mockProcs) {
    p.emit("close", 0);
  }

  await onQueueIdle();
  setSpawnImpl(null);
});

// ─── 飞书交互卡片生成器 ──────────────────────────────────────────────────────

test("cards: buildAckCard / buildAskCard / buildDoneCard / buildIgnoredCard / buildSolutionReplyCard 结构正确", async () => {
  const {
    buildAckCard,
    buildAskCard,
    buildDoneCard,
    buildIgnoredCard,
    buildSolutionReplyCard,
  } = await import("../src/feishu/cards.js");

  const mockTask = {
    seq: 7,
    title: "批量打标签接口",
    requester: { name: "张三" },
    repoPath: "/Users/dev/order-service",
    note: "已梳理订单超时处理链路",
    modifiedFiles: ["src/api/tag.js", "src/views/Tag.vue"],
    branchName: "docking/seq-7-batch-tags",
  };

  // 1. Ack 卡片
  const ack = buildAckCard({ task: mockTask });
  assert.equal(ack.header.template, "blue");
  assert.match(ack.header.title.content, /#7 批量打标签接口/);
  assert.match(ack.elements[0].text.content, /张三/);

  // 2. Ask 卡片
  const ask = buildAskCard({ task: mockTask, question: "分页字段传 page 还是 pageNum？" });
  assert.equal(ask.header.template, "orange");
  assert.match(ask.elements[0].text.content, /pageNum/);

  // 3. Done 卡片
  const done = buildDoneCard({
    task: mockTask,
    note: "修改完成并通过测试",
    modifiedFiles: mockTask.modifiedFiles,
    branchName: mockTask.branchName,
  });
  assert.equal(done.header.template, "green");
  assert.match(done.elements[0].text.content, /修改完成/);
  assert.match(done.elements[1].text.content, /src\/api\/tag\.js/);
  assert.match(done.elements[2].text.content, /docking\/seq-7-batch-tags/);

  // 4. Ignored 卡片
  const ignored = buildIgnoredCard({ task: mockTask, reason: "重复提单" });
  assert.equal(ignored.header.template, "grey");
  assert.match(ignored.elements[0].text.content, /重复提单/);

  // 5. SolutionReply 卡片
  const solution = buildSolutionReplyCard({ task: mockTask, text: "超时由 timer-service 统一控制" });
  assert.equal(solution.header.template, "turquoise");
  assert.match(solution.elements[0].text.content, /timer-service/);
});

// ─── 消息资源提取与多模态 Prompt 挂载 ────────────────────────────────────────

test("attachments: extractMessageResources 准确解析 image、file 与富文本中的图片", async () => {
  const { extractMessageResources } = await import("../src/feishu/listener.js");

  // 图片消息
  const imgRes = extractMessageResources({
    msg_type: "image",
    content: JSON.stringify({ image_key: "img_v3_test123" }),
  });
  assert.equal(imgRes.length, 1);
  assert.equal(imgRes[0].type, "image");
  assert.equal(imgRes[0].key, "img_v3_test123");

  // 文件消息
  const fileRes = extractMessageResources({
    msg_type: "file",
    content: JSON.stringify({ file_key: "file_v3_abc", file_name: "api-doc.yaml" }),
  });
  assert.equal(fileRes.length, 1);
  assert.equal(fileRes[0].type, "file");
  assert.equal(fileRes[0].name, "api-doc.yaml");

  // post 富文本混排图片
  const postRes = extractMessageResources({
    msg_type: "post",
    content: JSON.stringify({
      zh_cn: {
        title: "接口说明",
        content: [
          [
            { tag: "text", text: "参数请看图：" },
            { tag: "img", image_key: "img_nested_456" },
          ],
        ],
      },
    }),
  });
  assert.equal(postRes.length, 1);
  assert.equal(postRes[0].key, "img_nested_456");
});

test("prompt: buildPrompt 能够清晰渲染本地附件绝对路径与隔离分支", async () => {
  const { buildPrompt } = await import("../src/feishu/prompt.js");

  const task = {
    seq: 1,
    title: "排查超时逻辑",
    requester: { name: "李四" },
    createdAt: Date.now(),
    branchName: "docking/seq-1-timeout",
    content: "看下订单超时",
    attachments: [
      { type: "image", name: "flowchart.png", path: "/tmp/attachments/flowchart.png" },
      { type: "file", name: "config.yaml", path: "/tmp/attachments/config.yaml" },
    ],
  };

  const prompt = buildPrompt([task]);
  assert.match(prompt, /隔离分支：`docking\/seq-1-timeout`/);
  assert.match(prompt, /需求附件与截图/);
  assert.match(prompt, /\/tmp\/attachments\/flowchart\.png/);
  assert.match(prompt, /\/tmp\/attachments\/config\.yaml/);
});

// ─── 隔离分支命名安全工具 ────────────────────────────────────────────────────

test("runner: sanitizeBranchSlug 规范化分支名 Slug", async () => {
  const { sanitizeBranchSlug } = await import("../src/feishu/runner.js");
  assert.equal(sanitizeBranchSlug("对接批量打标签接口 /api/tags"), "对接批量打标签接口-api-tags");
  assert.equal(sanitizeBranchSlug("fix: user login & auth!!"), "fix-user-login-auth");
});

// ─── 工作量周报与统计生成器 ──────────────────────────────────────────────────

test("report: generateDockingReport 统计与格式化 Markdown 周报", async () => {
  const { generateDockingReport } = await import("../renderer/src/utils/docking-report.js");

  const mockTasks = [
    {
      seq: 1,
      title: "对接打标签接口",
      status: "done",
      note: "已联调完成",
      modifiedFiles: ["src/api/tag.js"],
      requester: { name: "张三" },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    {
      seq: 2,
      title: "排查超时逻辑",
      status: "done",
      note: "已定位并解答",
      modifiedFiles: [],
      requester: { name: "李四" },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    {
      seq: 3,
      title: "导出表格需求",
      status: "doing",
      requester: { name: "张三" },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ];

  const report = generateDockingReport(mockTasks, "all");
  assert.equal(report.metrics.total, 3);
  assert.equal(report.metrics.done, 2);
  assert.equal(report.metrics.doing, 1);
  assert.equal(report.metrics.filesCount, 1);

  assert.match(report.markdown, /赛博牛马工作量周报/);
  assert.match(report.markdown, /#1 对接打标签接口/);
  assert.match(report.markdown, /#2 排查超时逻辑/);
  assert.match(report.markdown, /#3 导出表格需求/);
  assert.match(report.markdown, /\*\*张三\*\*：2 次/);
});

// ─── 澄清回复后自动恢复 AI 会话 ──────────────────────────────────────────────

test("findAwaitingByMessageOrThread: 优先 Thread 话题父级 ID 匹配，降级 senderId 匹配", async () => {
  freshUserData();
  const { findAwaitingByMessageOrThread } = await import("../src/feishu/task-store.js");

  const t1 = addTask({
    messageId: "om_root_123",
    senderId: "ou_user_1",
    chatId: "oc_chat_1",
    content: "需求1",
    status: "awaiting",
  });

  const t2 = addTask({
    messageId: "om_root_456",
    senderId: "ou_user_1",
    chatId: "oc_chat_1",
    content: "需求2",
    status: "inbox",
  });

  // 1. 根据 Thread rootId 精准命中 t1
  const matched1 = findAwaitingByMessageOrThread({
    rootId: "om_root_123",
    senderId: "ou_user_1",
    chatId: "oc_chat_1",
  });
  assert.equal(matched1?.id, t1.id);

  // 2. 根据普通 senderId + chatId 命中处于 awaiting 的 t1
  const matched2 = findAwaitingByMessageOrThread({
    senderId: "ou_user_1",
    chatId: "oc_chat_1",
  });
  assert.equal(matched2?.id, t1.id);
});

test("auto-resume: 收到澄清回复后，自动读取 lastRunConfig 并唤醒 AI 任务调度", async () => {
  freshUserData();
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const { enqueueJob, getQueueStatus, setSpawnImpl, onQueueIdle } =
    await import("../src/feishu/runner.js");

  const mockProcs = [];
  setSpawnImpl(() => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = () => {
      proc.emit("close", 0);
    };
    mockProcs.push(proc);
    return proc;
  });

  // 1. 创建任务并以 analyze 模式初次运行
  const task = addTask({
    messageId: "om_task_789",
    senderId: "ou_tester",
    chatId: "oc_group_1",
    content: "排查订单状态超时",
  });

  enqueueJob({
    ids: [task.id],
    cwd: "/mock/cwd/order-repo",
    mode: "analyze",
    engine: "claude",
  });

  // 验证 task 记录了 lastRunConfig
  const savedTask = getTask(task.id);
  assert.deepEqual(savedTask.lastRunConfig, {
    cwd: "/mock/cwd/order-repo",
    mode: "analyze",
    engine: "claude",
    createBranch: false,
    branchName: "",
  });

  // 2. 模拟 AI 发出反问，任务转为 awaiting
  updateTask(task.id, { status: "awaiting", askedAt: Date.now() });

  // 3. 模拟接收提出人的飞书澄清回复事件
  const { handleClarificationReply } = await import("../src/feishu/listener.js");

  // 若设置开启（默认开启），自动恢复到 doing 并重新压入调度队列
  setSettings({ autoResumeOnClarification: true });
  handleClarificationReply(getTask(task.id), "超时是 30 分钟后关闭", Date.now(), []);

  // 第一轮 job 还在跑（mock proc 尚未 close），同一任务不另起一轮：
  // 回复只进 thread 并挂上 pendingFollowup，等这轮结束再合并成下一轮
  const pendingTask = getTask(task.id);
  assert.equal(pendingTask.pendingFollowup, true);
  assert.equal(pendingTask.thread.length, 2);
  assert.equal(pendingTask.thread[1].text, "超时是 30 分钟后关闭");

  const q = getQueueStatus();
  assert.equal(q.running.length + q.queued.length, 1);

  // 第一轮正常结束 → 自动接着跑下一轮，配置沿用 lastRunConfig。
  // 这里不能等 onQueueIdle：下一轮的 mock proc 不会自己 close，队列永远不空
  mockProcs[0].emit("close", 0);
  for (let i = 0; i < 100 && mockProcs.length < 2; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }

  const resumedTask = getTask(task.id);
  assert.equal(resumedTask.status, "doing");
  assert.equal(resumedTask.pendingFollowup, false);
  assert.equal(mockProcs.length, 2);

  // 清理 mock proc
  for (const p of mockProcs) {
    p.emit("close", 0);
  }
  await onQueueIdle();
  setSpawnImpl(null);
});

// ─── 收到需求自动交给 AI 执行 (Auto-Dispatch) ────────────────────────────────

test("pickSmartRepo: 智能根据需求内容与标题匹配关联工程", async () => {
  const { pickSmartRepo } = await import("../src/feishu/repo-matcher.js");

  const repos = [
    { key: "user", label: "用户前端中心", path: "/projects/fe-user-center" },
    { key: "order", label: "交易订单中台", path: "/projects/fe-order-system" },
    { key: "marketing", label: "营销活动", path: "/projects/fe-marketing" },
  ];

  // 1. 匹配标题中的 label
  const r1 = pickSmartRepo(
    [{ title: "帮看下用户前端中心的登录态", content: "token 过期" }],
    repos,
  );
  assert.equal(r1, "/projects/fe-user-center");

  // 2. 匹配内容中的 basename
  const r2 = pickSmartRepo(
    [{ title: "修改超时配置", content: "请在 fe-order-system 中把 timeout 改为 5000" }],
    repos,
  );
  assert.equal(r2, "/projects/fe-order-system");

  // 3. 无法匹配时，回退到有效 fallbackCwd
  const r3 = pickSmartRepo(
    [{ title: "今天天气不错", content: "没有任何关键词" }],
    repos,
    "/projects/fe-marketing",
  );
  assert.equal(r3, "/projects/fe-marketing");

  // 4. 无法匹配且无 fallback 时，默认第一个
  const r4 = pickSmartRepo(
    [{ title: "随便提一条", content: "123" }],
    repos,
    "/non/exist",
  );
  assert.equal(r4, "/projects/fe-user-center");
});

test("cli: CLI_PACKAGES 定义及 probeLarkCli / probeClaudeCli / probeCodexCli / probeAgy / probeCodex 返回结构", async () => {
  const { CLI_PACKAGES, probeLarkCli, probeClaudeCli, probeCodexCli } = await import(
    "../src/feishu/lark-cli.js"
  );
  const { probeAgy } = await import("../src/feishu/agy-setup.js");
  const { probeCodex } = await import("../src/feishu/codex-setup.js");

  // 1. 包配置元数据
  assert.ok(CLI_PACKAGES["lark-cli"]);
  assert.equal(CLI_PACKAGES["lark-cli"].pkg, "@larksuite/cli");
  assert.equal(CLI_PACKAGES["lark-cli"].installCmd, "npm install -g @larksuite/cli");

  assert.ok(CLI_PACKAGES.claude);
  assert.equal(CLI_PACKAGES.claude.pkg, "@anthropic-ai/claude-code");
  assert.equal(CLI_PACKAGES.claude.installCmd, "npm install -g @anthropic-ai/claude-code");

  assert.ok(CLI_PACKAGES.codex);
  assert.equal(CLI_PACKAGES.codex.pkg, "@openai/codex");
  assert.equal(CLI_PACKAGES.codex.installCmd, "npm install -g @openai/codex");

  // 2. 探测返回结构
  const larkProbe = await probeLarkCli();
  assert.equal(typeof larkProbe.installed, "boolean");
  assert.ok(larkProbe.installCmd);
  assert.equal(larkProbe.pkgName, "@larksuite/cli");

  const claudeProbe = await probeClaudeCli();
  assert.equal(typeof claudeProbe.installed, "boolean");
  assert.ok(claudeProbe.installCmd);
  assert.equal(claudeProbe.pkgName, "@anthropic-ai/claude-code");

  const codexCliProbe = await probeCodexCli();
  assert.equal(typeof codexCliProbe.installed, "boolean");
  assert.ok(codexCliProbe.installCmd);
  assert.equal(codexCliProbe.pkgName, "@openai/codex");

  const agyProbe = await probeAgy();
  assert.equal(typeof agyProbe.installed, "boolean");
  assert.ok(agyProbe.installCmd);

  const codexProbe = await probeCodex();
  assert.equal(typeof codexProbe.installed, "boolean");
  assert.ok(codexProbe.installCmd);
});

test("thread: 支持删除单条沟通记录与清空话题对话", async () => {
  const { deleteThreadEntry, clearThread } = await import(
    "../src/feishu/task-store.js"
  );
  freshUserData();
  const t = addTask({
    content: "初始需求内容",
  });
  appendThread(t.id, { role: "me", text: "请问入参是什么？" });
  appendThread(t.id, { role: "them", text: "入参是 id=123" });
  appendThread(t.id, { role: "me", text: "好的，开始排查" });

  let cur = getTask(t.id);
  assert.equal(cur.thread.length, 4);

  // 1. 删除某条追问 (下标 2: "入参是 id=123")
  deleteThreadEntry(t.id, 2);
  cur = getTask(t.id);
  assert.equal(cur.thread.length, 3);
  assert.equal(cur.thread[1].text, "请问入参是什么？");
  assert.equal(cur.thread[2].text, "好的，开始排查");

  // 2. 清空所有后续追问对话（保留首条原始需求）
  clearThread(t.id);
  cur = getTask(t.id);
  assert.equal(cur.thread.length, 1);
  assert.equal(cur.thread[0].text, "初始需求内容");
});

test("thread: 同一话题(Thread)内聊的消息永远属于原需求，已完成后追问自动重新激活", async () => {
  const { findTaskByThread, updateTask } = await import(
    "../src/feishu/task-store.js"
  );
  const { handleThreadReply } = await import("../src/feishu/listener.js");

  freshUserData();
  const t = addTask({
    messageId: "root-msg-100",
    content: "这是一个初始对接需求",
    status: "done", // 已经完成
  });

  // 1. 验证根据 root_id 或 parent_id 无论何种状态都能唯一定位到该任务
  const matched = findTaskByThread({ rootId: "root-msg-100" });
  assert.ok(matched);
  assert.equal(matched.id, t.id);

  // 2. 对方在已完成的 Thread 下追问
  handleThreadReply(matched, "测试发现还有一个边界条件报 500", Date.now());

  // 3. 验证任务自动重新激活为 inbox，且消息已成功追加到沟通记录中
  const reloaded = getTask(t.id);
  assert.equal(reloaded.status, "inbox");
  assert.equal(reloaded.thread.length, 2);
  assert.equal(reloaded.thread[1].text, "测试发现还有一个边界条件报 500");
  assert.equal(reloaded.thread[1].role, "them");
});

test("history-store: 保存 AI 调用记录、过滤思考日志、按条件筛选与详情回看", async () => {
  const {
    saveJobRun,
    listJobRuns,
    getJobRunDetail,
    deleteJobRun,
    clearJobRuns,
    cleanLogs,
  } = await import("../src/feishu/history-store.js");

  clearJobRuns();

  // 1. cleanLogs 过滤思考标签
  const rawLogs = [
    { at: 1000, kind: "meta", text: "开始分析" },
    { at: 1010, kind: "stdout", text: "<thinking>思考内部链信息</thinking>正在读取代码" },
    { at: 1020, kind: "error", text: "连接超时" },
  ];
  const cleaned = cleanLogs(rawLogs);
  assert.equal(cleaned.length, 3);
  assert.equal(cleaned[1].text, "正在读取代码");

  // 2. 保存调用记录
  const jobRecord1 = {
    id: "job-001",
    taskIds: ["task-a"],
    taskTitles: ["#1 对接微信支付"],
    engine: "claude",
    mode: "edit",
    cwd: "/projects/shop",
    branchName: "task-1-wxpay",
    status: "done",
    exitCode: 0,
    createdAt: Date.now() - 10000,
    startTime: Date.now() - 10000,
    endTime: Date.now(),
    durationMs: 10000,
    prompt: "请实现微信支付回调逻辑",
    logs: cleaned,
    modifiedFiles: ["src/pay/wx.js"],
    resultNote: "已完成回调接口修改",
  };

  const saved1 = saveJobRun(jobRecord1);
  assert.equal(saved1.id, "job-001");

  const jobRecord2 = {
    id: "job-002",
    taskIds: ["task-b"],
    taskTitles: ["#2 排查 500 报错"],
    engine: "agy",
    mode: "analyze",
    cwd: "/projects/shop",
    branchName: "",
    status: "error",
    exitCode: 1,
    createdAt: Date.now() - 5000,
    startTime: Date.now() - 5000,
    endTime: Date.now(),
    durationMs: 5000,
    prompt: "请排查 500 报错原因",
    logs: [{ at: Date.now(), kind: "error", text: "数据库连接失败" }],
    modifiedFiles: [],
    resultNote: "",
  };
  saveJobRun(jobRecord2);

  // 3. 列表与筛选
  const allHistory = listJobRuns();
  assert.equal(allHistory.total, 2);

  const agyOnly = listJobRuns({ engine: "agy" });
  assert.equal(agyOnly.total, 1);
  assert.equal(agyOnly.items[0].id, "job-002");

  const taskAOnly = listJobRuns({ taskId: "task-a" });
  assert.equal(taskAOnly.total, 1);
  assert.equal(taskAOnly.items[0].id, "job-001");

  // 4. 详情回看（完整 prompt 与改动文件）
  const detail = getJobRunDetail("job-001");
  assert.equal(detail.prompt, "请实现微信支付回调逻辑");
  assert.equal(detail.modifiedFiles.length, 1);
  assert.equal(detail.modifiedFiles[0], "src/pay/wx.js");

  // 5. 单条删除
  deleteJobRun("job-002");
  assert.equal(listJobRuns().total, 1);

  // 6. 清空
  clearJobRuns();
  assert.equal(listJobRuns().total, 0);
});



// ─── 力度档位：飞书消息不该有权把只读档顶成可改代码 ──────────────────────────

test("resolveRunMode: 默认不提权；开关打开后才按自定义关键词把 analyze 升到 edit", async () => {
  freshUserData();
  const { resolveRunMode } = await import("../src/feishu/listener.js");

  // 1. 默认（autoEscalateMode = false）：命中关键词也不提权
  let settings = getSettings();
  assert.equal(settings.autoEscalateMode, false);
  assert.equal(resolveRunMode("analyze", "帮我修改一下这里", settings), "analyze");

  // 2. 打开开关，走默认关键词
  settings = setSettings({ autoEscalateMode: true });
  assert.equal(resolveRunMode("analyze", "帮我修改一下这里", settings), "edit");
  assert.equal(resolveRunMode("analyze", "好的，收到", settings), "analyze");

  // 3. 自定义关键词（支持「、」/ 逗号 / 换行分隔，自动去重）
  settings = setSettings({ escalateKeywords: "动手、动手, 上代码\n落地" });
  assert.deepEqual(settings.escalateKeywords, ["动手", "上代码", "落地"]);
  assert.equal(resolveRunMode("analyze", "你直接动手吧", settings), "edit");
  // 老的默认词已经被换掉了，不再命中
  assert.equal(resolveRunMode("analyze", "帮我修改一下这里", settings), "analyze");

  // 4. 关键词留空 = 等于不提权
  settings = setSettings({ escalateKeywords: "" });
  assert.equal(resolveRunMode("analyze", "你直接动手吧", settings), "analyze");

  // 5. 最多升到 edit，永远升不到 full；已经是 edit/full 的档位原样返回
  settings = setSettings({ escalateKeywords: "动手" });
  assert.equal(resolveRunMode("analyze", "动手", settings), "edit");
  assert.equal(resolveRunMode("edit", "随便说点什么", settings), "edit");
  assert.equal(resolveRunMode("full", "动手", settings), "full");
});

test("handleThreadReply: 没开自动派发时，话题里的新消息不会私自拉起 AI", async () => {
  freshUserData();
  const { handleThreadReply } = await import("../src/feishu/listener.js");
  const { getQueueStatus } = await import("../src/feishu/runner.js");

  // autoResumeOnClarification 默认开着，但它只管「反问被回复」，
  // 不该让一句普通话题消息也把 AI 拉起来
  setSettings({ autoDispatchEnabled: false, autoResumeOnClarification: true });
  const before = getQueueStatus();

  const t = addTask({
    messageId: "om_thread_noauto",
    senderId: "ou_someone",
    content: "看下这个逻辑",
    status: "inbox",
  });
  updateTask(t.id, { repoPath: "/mock/repo", lastRunConfig: { cwd: "/mock/repo" } });

  handleThreadReply(getTask(t.id), "顺便帮我改一下这里", Date.now());

  const after = getQueueStatus();
  assert.equal(after.jobs.length, before.jobs.length, "不应新增任何 job");
  assert.equal(getTask(t.id).status, "inbox", "状态不该被改成 doing");
});

test("白名单: 名单外的人不会触发自动执行，任务照常留底", async () => {
  freshUserData();
  const { handleThreadReply } = await import("../src/feishu/listener.js");
  const { getQueueStatus } = await import("../src/feishu/runner.js");

  setSettings({
    autoDispatchEnabled: true,
    autoDispatchCwd: "/mock/repo",
    allowedRequesters: ["ou_boss"],
  });
  const before = getQueueStatus();

  const t = addTask({
    messageId: "om_stranger",
    senderId: "ou_stranger",
    content: "帮我把登录改了",
    status: "inbox",
  });
  handleThreadReply(getTask(t.id), "现在就改", Date.now());

  assert.equal(getQueueStatus().jobs.length, before.jobs.length);
  assert.equal(getTask(t.id).status, "inbox");
  // 消息本身要留底，不能因为不在白名单就丢
  assert.equal(getTask(t.id).thread.at(-1).text, "现在就改");
});

// ─── 消息级幂等：事件总线重推不该重复入库、重复派活 ──────────────────────────

test("task-store: markMessageProcessed 挡住重推，且只保留最近若干条", async () => {
  freshUserData();
  const { isMessageProcessed, markMessageProcessed, reload } = await import(
    "../src/feishu/task-store.js"
  );

  assert.equal(isMessageProcessed("om_1"), false);
  markMessageProcessed("om_1");
  assert.equal(isMessageProcessed("om_1"), true);
  // 重复标记不报错也不重复存
  markMessageProcessed("om_1");
  assert.equal(isMessageProcessed("om_1"), true);
  // 落盘了，换个进程重读也认
  reload();
  assert.equal(isMessageProcessed("om_1"), true);
  assert.equal(isMessageProcessed("om_never"), false);
});

// ─── 隔离分支：真正切分支，切不了就中止 ─────────────────────────────────────

function makeGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docking-git-"));
  const git = (args) =>
    execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q"]);
  git(["config", "user.email", "t@t.t"]);
  git(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
  git(["add", "."]);
  git(["commit", "-qm", "init"]);
  return { dir, git };
}
test("setupGitBranch: 干净工作区切出隔离分支并回写 branchName", async () => {
  freshUserData();
  const { setupGitBranch } = await import("../src/feishu/runner.js");
  const { dir, git } = makeGitRepo();

  const t = addTask({ content: "订单超时要改成 30 分钟", status: "inbox" });
  const logs = [];
  const res = setupGitBranch({
    cwd: dir,
    tasks: [getTask(t.id)],
    createBranch: true,
    mode: "edit",
    emitLog: (kind, text) => logs.push(text),
  });

  assert.equal(res.ok, true);
  assert.match(res.branchName, /^docking\/seq-\d+-/);
  const current = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
  assert.equal(current, res.branchName, "应该真的切过去了");
  assert.equal(getTask(t.id).branchName, res.branchName, "branchName 要回写到任务上");
  assert.ok(logs.some((l) => l.includes(res.branchName)));

  // 再跑一次：已经在这条分支上，不重复创建也不报错
  const again = setupGitBranch({
    cwd: dir,
    tasks: [getTask(t.id)],
    createBranch: true,
    mode: "edit",
  });
  assert.equal(again.ok, true);
  assert.equal(again.branchName, res.branchName);
  void git;
});

test("setupGitBranch: 工作区脏时中止，不带着未提交改动切分支", async () => {
  freshUserData();
  const { setupGitBranch } = await import("../src/feishu/runner.js");
  const { dir } = makeGitRepo();

  fs.writeFileSync(path.join(dir, "a.txt"), "我改了一半还没提交\n");
  const before = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();

  const t = addTask({ content: "随便一条需求", status: "inbox" });
  const res = setupGitBranch({
    cwd: dir,
    tasks: [getTask(t.id)],
    createBranch: true,
    mode: "edit",
  });

  assert.equal(res.ok, false);
  assert.match(res.error, /未提交改动/);
  const after = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
  assert.equal(after, before, "分支不该被切走");
  assert.equal(getTask(t.id).branchName, "", "失败时不该回写 branchName");
});

test("setupGitBranch: 未跟踪文件不算脏，照常切分支", async () => {
  freshUserData();
  const { setupGitBranch } = await import("../src/feishu/runner.js");
  const { dir } = makeGitRepo();

  // 工具生成物 / 本地草稿目录常年躺在工作区，不该拦住派活
  fs.mkdirSync(path.join(dir, ".agents/skills/whatever"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".agents/skills/whatever/SKILL.md"), "# 草稿\n");

  const t = addTask({ content: "随便一条需求", status: "inbox" });
  const res = setupGitBranch({
    cwd: dir,
    tasks: [getTask(t.id)],
    createBranch: true,
    mode: "edit",
  });

  assert.equal(res.ok, true, "未跟踪文件不该阻止切分支");
  assert.match(res.branchName, /^docking\/seq-\d+-/);
  const current = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
  assert.equal(current, res.branchName, "应该真的切过去了");
  assert.ok(
    fs.existsSync(path.join(dir, ".agents/skills/whatever/SKILL.md")),
    "未跟踪文件应原地保留",
  );
});

test("setupGitBranch: 只读档与关闭开关时直接跳过，不碰 git", async () => {
  freshUserData();
  const { setupGitBranch } = await import("../src/feishu/runner.js");
  const t = addTask({ content: "只读排查", status: "inbox" });

  assert.deepEqual(
    setupGitBranch({ cwd: "/not/a/repo", tasks: [t], createBranch: true, mode: "analyze" }),
    { ok: true, branchName: "" },
  );
  assert.deepEqual(
    setupGitBranch({ cwd: "/not/a/repo", tasks: [t], createBranch: false, mode: "edit" }),
    { ok: true, branchName: "" },
  );
});

test("runner: 切分支失败时中止 job，并把任务从 doing 放回 inbox", async () => {
  freshUserData();
  const { enqueueJob, getQueueStatus, onQueueIdle, setSpawnImpl } = await import(
    "../src/feishu/runner.js"
  );
  const { dir } = makeGitRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "脏\n");

  let spawned = 0;
  setSpawnImpl(() => {
    spawned += 1;
    throw new Error("不该走到这一步");
  });

  const t = addTask({ content: "要改代码的需求", status: "inbox" });
  updateTask(t.id, { status: "doing" });

  const { jobId } = enqueueJob({
    ids: [t.id],
    cwd: dir,
    mode: "edit",
    engine: "claude",
    createBranch: true,
  });
  await onQueueIdle();

  assert.equal(spawned, 0, "分支没切成功就不该起 Agent");
  const job = getQueueStatus().jobs.find((j) => j.id === jobId);
  assert.equal(job.status, "error");
  assert.match(job.error, /未提交改动/);
  assert.equal(getTask(t.id).status, "inbox", "任务要放回待处理，不能卡在 doing");

  setSpawnImpl(null);
});

test("runner: engine=codex 支持 exec --json 参数构造与结构化事件解析", async () => {
  freshUserData();
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const { enqueueJob, getQueueStatus, onQueueIdle, setSpawnImpl } = await import(
    "../src/feishu/runner.js"
  );
  const { getJobRunDetail } = await import("../src/feishu/history-store.js");

  const t = addTask({ title: "Codex 需求", content: "使用 Codex CLI 处理" });

  let capturedBin = "";
  let capturedArgs = [];

  setSpawnImpl((bin, args) => {
    capturedBin = bin;
    capturedArgs = args;
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = () => proc.emit("close", 0);

    setTimeout(() => {
      proc.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "th-123" }) + "\n");
      proc.stdout.write(JSON.stringify({ type: "turn.started" }) + "\n");
      proc.stdout.write(
        JSON.stringify({
          type: "item.completed",
          item: { id: "item_0", type: "agent_message", text: "正在分析项目结构" },
        }) + "\n",
      );
      proc.stdout.write(
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item_1",
            type: "mcp_tool_call",
            tool: "mcp__docking__update_task",
            arguments: { seq: 1, status: "done", note: "完成排查" },
          },
        }) + "\n",
      );
      proc.stdout.write(
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item_2",
            type: "apply_patch",
            file_path: "src/index.js",
          },
        }) + "\n",
      );
      proc.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\n");
      proc.emit("close", 0);
    }, 20);

    return proc;
  });

  const res = enqueueJob({
    ids: [t.id],
    cwd: "/mock/cwd/test-codex",
    mode: "edit",
    engine: "codex",
  });

  await onQueueIdle();

  assert.equal(capturedBin, "codex");
  assert.equal(capturedArgs[0], "exec");
  assert.ok(capturedArgs.includes("--json"));
  assert.ok(capturedArgs.includes("--ephemeral"));
  assert.ok(capturedArgs.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(capturedArgs.includes("--skip-git-repo-check"));

  const history = getJobRunDetail(res.jobId);
  assert.ok(history);
  assert.equal(history.engine, "codex");
  assert.equal(history.status, "done");
  assert.ok(history.modifiedFiles.includes("src/index.js"));

  setSpawnImpl(null);
});

