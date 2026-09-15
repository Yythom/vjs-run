// AI 工单台模块自动化测试：node --test scripts/docking-task.test.mjs
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

  assert.match(report.markdown, /AI 工单台工作量周报/);
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
const headOf = (dir) =>
  execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();

test("setupWorktree: 建独立 worktree，主仓库分支不动，回写 branchName 与 worktreePath", async () => {
  const userData = freshUserData();
  const { setupWorktree } = await import("../src/feishu/runner.js");
  const { dir } = makeGitRepo();
  const before = headOf(dir);

  const t = addTask({ content: "订单超时要改成 30 分钟", status: "inbox" });
  const logs = [];
  const res = setupWorktree({
    cwd: dir,
    tasks: [getTask(t.id)],
    createBranch: true,
    mode: "edit",
    emitLog: (kind, text) => logs.push(text),
  });

  assert.equal(res.ok, true, res.error);
  assert.match(res.branchName, /^docking\/seq-\d+-/);
  assert.ok(res.workdir.startsWith(path.join(userData, "docking-worktrees")), "worktree 落在 userData 下");
  assert.equal(headOf(dir), before, "主仓库不该被切走");
  assert.equal(headOf(res.workdir), res.branchName, "worktree 在隔离分支上");
  assert.ok(fs.existsSync(path.join(res.workdir, "a.txt")));
  assert.equal(getTask(t.id).branchName, res.branchName);
  assert.equal(getTask(t.id).worktreePath, res.workdir);
  assert.ok(logs.some((l) => l.includes(res.branchName)));

  // 第二轮：复用同一个 worktree，路径不变（续接会话靠它）
  const again = setupWorktree({ cwd: dir, tasks: [getTask(t.id)], createBranch: true, mode: "edit" });
  assert.equal(again.ok, true, again.error);
  assert.equal(again.workdir, res.workdir);
});

test("setupWorktree: 主仓库有未提交改动也照常建，改动留在主仓库不带进去", async () => {
  freshUserData();
  const { setupWorktree } = await import("../src/feishu/runner.js");
  const { dir } = makeGitRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "我改了一半还没提交\n");

  const t = addTask({ content: "随便一条需求", status: "inbox" });
  const logs = [];
  const res = setupWorktree({
    cwd: dir,
    tasks: [getTask(t.id)],
    createBranch: true,
    mode: "edit",
    emitLog: (kind, text) => logs.push(text),
  });

  assert.equal(res.ok, true, res.error);
  assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "我改了一半还没提交\n");
  assert.equal(fs.readFileSync(path.join(res.workdir, "a.txt"), "utf8"), "hello\n");
  assert.ok(logs.some((l) => /未提交的改动/.test(l)), "要提示主仓库的改动不在 worktree 里");
});

test("setupWorktree: node_modules 软链复用主仓库，且不会被 git 当成新文件", async () => {
  freshUserData();
  const { setupWorktree } = await import("../src/feishu/runner.js");
  const { dir, git } = makeGitRepo();
  // .gitignore 写的是带斜杠的 node_modules/——它匹配不到软链，正是要兜的情况
  fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n");
  fs.mkdirSync(path.join(dir, "pkg"));
  fs.writeFileSync(path.join(dir, "pkg", "index.js"), "\n");
  git(["add", "."]);
  git(["commit", "-qm", "pkg"]);
  fs.mkdirSync(path.join(dir, "node_modules", "left-pad"), { recursive: true });
  fs.mkdirSync(path.join(dir, "pkg", "node_modules", "dep"), { recursive: true });
  // 没被跟踪的目录下的 node_modules 不链：worktree 里没有它的父目录
  fs.mkdirSync(path.join(dir, "scratch", "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(dir, "scratch", "draft.md"), "草稿\n");

  const t = addTask({ content: "要跑测试的需求", status: "inbox" });
  const res = setupWorktree({ cwd: dir, tasks: [getTask(t.id)], createBranch: true, mode: "full" });
  assert.equal(res.ok, true, res.error);

  for (const rel of ["node_modules", path.join("pkg", "node_modules")]) {
    const link = path.join(res.workdir, rel);
    assert.ok(fs.lstatSync(link).isSymbolicLink(), `${rel} 应该是软链`);
    assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(dir, rel)));
  }
  assert.ok(!fs.existsSync(path.join(res.workdir, "scratch")));

  const status = execFileSync("git", ["status", "--porcelain"], { cwd: res.workdir, encoding: "utf8" });
  assert.equal(status.trim(), "", `软链不该出现在 git status 里：\n${status}`);
  assert.equal(
    execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).trim(),
    "?? scratch/",
    "主仓库的忽略规则不受影响",
  );

  // 再建一次不重复写 exclude
  setupWorktree({ cwd: dir, tasks: [getTask(t.id)], createBranch: true, mode: "full" });
  const exclude = fs.readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8");
  assert.equal(exclude.split("\n").filter((l) => l === "/node_modules").length, 1);
});

test("setupWorktree: worktree 目录被人删了，下一轮重建并沿用原分支上的提交", async () => {
  freshUserData();
  const { setupWorktree } = await import("../src/feishu/runner.js");
  const { dir } = makeGitRepo();
  const t = addTask({ content: "两轮的需求", status: "inbox" });

  const first = setupWorktree({ cwd: dir, tasks: [getTask(t.id)], createBranch: true, mode: "edit" });
  const wtGit = (args) =>
    execFileSync("git", args, { cwd: first.workdir, stdio: ["ignore", "pipe", "pipe"] });
  fs.writeFileSync(path.join(first.workdir, "b.txt"), "AI 第一轮的改动\n");
  wtGit(["add", "b.txt"]);
  wtGit(["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "round1"]);
  fs.rmSync(first.workdir, { recursive: true, force: true });

  const second = setupWorktree({ cwd: dir, tasks: [getTask(t.id)], createBranch: true, mode: "edit" });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.workdir, first.workdir);
  assert.equal(fs.readFileSync(path.join(second.workdir, "b.txt"), "utf8"), "AI 第一轮的改动\n");
});

test("setupWorktree: 分支还检出在主仓库（旧版残留）时中止并说清楚怎么办", async () => {
  freshUserData();
  const { setupWorktree } = await import("../src/feishu/runner.js");
  const { dir, git } = makeGitRepo();
  const t = addTask({ content: "旧任务", status: "inbox" });
  updateTask(t.id, { branchName: "docking/seq-1-old" });
  git(["checkout", "-qb", "docking/seq-1-old"]);

  const res = setupWorktree({ cwd: dir, tasks: [getTask(t.id)], createBranch: true, mode: "edit" });
  assert.equal(res.ok, false);
  assert.match(res.error, /检出在主仓库/);
  assert.match(res.error, /切回其他分支/);
});

test("setupWorktree: 只读档、关闭开关、非 git 目录都直接在原目录跑", async () => {
  freshUserData();
  const { setupWorktree } = await import("../src/feishu/runner.js");
  const t = addTask({ content: "只读排查", status: "inbox" });
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "docking-plain-"));

  const skip = (cwd) => ({ ok: true, branchName: "", workdir: cwd });
  assert.deepEqual(
    setupWorktree({ cwd: "/not/a/repo", tasks: [t], createBranch: true, mode: "analyze" }),
    skip("/not/a/repo"),
  );
  assert.deepEqual(
    setupWorktree({ cwd: "/not/a/repo", tasks: [t], createBranch: false, mode: "edit" }),
    skip("/not/a/repo"),
  );
  assert.deepEqual(setupWorktree({ cwd: plain, tasks: [t], createBranch: true, mode: "edit" }), skip(plain));
});

test("runner: 建 worktree 失败时中止 job，并把任务从 doing 放回 inbox", async () => {
  freshUserData();
  const { enqueueJob, getQueueStatus, onQueueIdle, setSpawnImpl } = await import(
    "../src/feishu/runner.js"
  );
  const { dir, git } = makeGitRepo();

  let spawned = 0;
  setSpawnImpl(() => {
    spawned += 1;
    throw new Error("不该走到这一步");
  });

  const t = addTask({
    content: "要改代码的需求",
    status: "inbox",
    messageId: "om_dirty_1",
    chatId: "oc_dirty_chat",
  });
  updateTask(t.id, { status: "doing", branchName: "docking/seq-9-stuck" });
  git(["checkout", "-qb", "docking/seq-9-stuck"]);

  const { jobId } = enqueueJob({
    ids: [t.id],
    cwd: dir,
    mode: "edit",
    engine: "claude",
    createBranch: true,
  });
  await onQueueIdle();

  assert.equal(spawned, 0, "worktree 没建成就不该起 Agent");
  const job = getQueueStatus().jobs.find((j) => j.id === jobId);
  assert.equal(job.status, "error");
  assert.match(job.error, /检出在主仓库/);
  assert.equal(getTask(t.id).status, "inbox", "任务要放回待处理，不能卡在 doing");
  const thread = getTask(t.id).thread || [];
  assert.ok(
    thread.some((item) => item.text.includes("本次自动处理未完成")),
    "沟通记录里必须记下未完成原因",
  );

  setSpawnImpl(null);
});

test("runner: 开了隔离时 Agent 在 worktree 里跑，prompt 说明依赖是软链的", async () => {
  freshUserData();
  const { dir } = makeGitRepo();
  const t = addTask({ title: "改代码", content: "改一下" });

  const { calls, restore } = await captureSpawn();
  const { enqueueJob, onQueueIdle } = await import("../src/feishu/runner.js");
  try {
    enqueueJob({ ids: [t.id], cwd: dir, mode: "edit", engine: "claude", createBranch: true });
    await onQueueIdle();
  } finally {
    restore();
  }
  const wt = getTask(t.id).worktreePath;
  assert.ok(wt);
  assert.equal(calls[0].opts.cwd, wt);
  const prompt = calls[0].args[calls[0].args.indexOf("-p") + 1];
  assert.match(prompt, /不要安装、升级或删除依赖/);
  assert.equal(getTask(t.id).repoPath, dir, "repoPath 仍是主仓库");
});

test("runner: 同一仓库不同任务的隔离 job 可以并行，不开隔离时仍串行", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const { enqueueJob, onQueueIdle, setSpawnImpl } = await import("../src/feishu/runner.js");

  const maxParallel = async (createBranch) => {
    freshUserData();
    const { dir } = makeGitRepo();
    let running = 0;
    let peak = 0;
    setSpawnImpl(() => {
      running += 1;
      peak = Math.max(peak, running);
      const proc = new EventEmitter();
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.kill = () => proc.emit("close", 0);
      setTimeout(() => {
        running -= 1;
        proc.stdout.end();
        proc.stderr.end();
        proc.emit("close", 0);
      }, 50);
      return proc;
    });
    const a = addTask({ title: "a", content: "a" });
    const b = addTask({ title: "b", content: "b" });
    enqueueJob({ ids: [a.id], cwd: dir, mode: "edit", engine: "claude", createBranch });
    enqueueJob({ ids: [b.id], cwd: dir, mode: "edit", engine: "claude", createBranch });
    await onQueueIdle();
    setSpawnImpl(null);
    return peak;
  };

  assert.equal(await maxParallel(true), 2);
  assert.equal(await maxParallel(false), 1);
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


// ─── 产 plan 档与需求池工作包 ────────────────────────────────────────────────

/**
 * 起一个 mock spawn，把每次调用的 (bin, args, opts) 记下来供断言。
 *
 * 子进程自己在 setImmediate 里收尾：spawn 发生在 p-queue 的异步回调里，
 * 同步的测试体拿不到 proc，手动 emit("close") 会落空，然后 onQueueIdle 一直挂着。
 */
async function captureSpawn() {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const { setSpawnImpl } = await import("../src/feishu/runner.js");

  const calls = [];
  setSpawnImpl((bin, args, opts) => {
    calls.push({ bin, args, opts });
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = () => proc.emit("close", 0);
    setImmediate(() => {
      proc.stdout.end();
      proc.stderr.end();
      proc.emit("close", 0);
    });
    return proc;
  });
  return { calls, restore: () => setSpawnImpl(null) };
}

/** 跑一个 job 并等它收尾，返回 spawn 到的参数。 */
async function runJobAndCaptureArgs(opts) {
  const { enqueueJob, onQueueIdle } = await import("../src/feishu/runner.js");
  const { calls, restore } = await captureSpawn();
  try {
    enqueueJob(opts);
    await onQueueIdle();
  } finally {
    restore();
  }
  assert.equal(calls.length, 1, "应该正好起了一个子进程");
  return calls[0].args;
}

/** 造一个带 skill.md 的工作包。 */
function freshWorkpackDir(skill = "# 工作规范\n必须逐张 Read 截图。") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docking-workpack-"));
  fs.writeFileSync(path.join(dir, "context.md"), "# 工作包: 测试需求\n");
  if (skill !== null) fs.writeFileSync(path.join(dir, "skill.md"), skill);
  return dir;
}

test("plan 档：Bash 整个禁掉，扫描改走 req_scan 工具", async () => {
  freshUserData();
  const task = addTask({ title: "需求池任务", content: "产 plan" });
  const args = await runJobAndCaptureArgs({
    ids: [task.id], cwd: "/mock/repo", mode: "plan", engine: "claude",
  });

  const deny = args.slice(args.indexOf("--disallowedTools") + 1);
  // 原来靠 allowedTools 的 "Bash(node:*)" 白名单只放行 node，实测那个在无头 -p 下
  // 根本不过滤（只放行 Bash(git:*) 时 node 命令照跑），等于这一档能跑任意命令。
  // 现在扫描走 MCP，Bash 可以真禁掉。
  assert.ok(deny.includes("Bash"), "扫描已改走 req_scan，Bash 必须真禁掉");
  assert.ok(deny.includes("Edit") && deny.includes("MultiEdit"));
  // 但要留着 Write——plan.md 得写得出来
  assert.ok(!deny.includes("Write"), "plan.md 要写得出来");

  // allowedTools 里不该再有那个不起作用的 Bash 白名单
  const allow = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--disallowedTools"));
  assert.ok(
    !allow.some((t) => t.startsWith("Bash(")),
    "allowedTools 的 Bash(...) 参数模式在无头模式下不生效，留着是误导",
  );
  assert.ok(allow.includes("mcp__docking__req_scan"), "扫描工具必须放行");
});

test("plan 档：三个引擎都能跑，但各自的边界不一样", async () => {
  const dir = freshWorkpackDir();

  // claude：工具粒度——Bash 与编辑类工具全禁，扫描走 MCP
  freshUserData();
  const t1 = addTask({ title: "工作包", content: "产 plan", workpackDir: dir });
  const claude = await runJobAndCaptureArgs({
    ids: [t1.id], cwd: "/mock/repo", mode: "plan", engine: "claude",
  });
  const claudeDeny = claude.slice(claude.indexOf("--disallowedTools") + 1);
  assert.ok(claudeDeny.includes("Bash") && claudeDeny.includes("Edit"));

  // codex：沙箱粒度——workspace-write，读全部、只在工作目录与工作包内可写
  freshUserData();
  const t2 = addTask({ title: "工作包", content: "产 plan", workpackDir: dir });
  const codex = await runJobAndCaptureArgs({
    ids: [t2.id], cwd: "/mock/repo", mode: "plan", engine: "codex",
  });
  assert.equal(codex[codex.indexOf("--sandbox") + 1], "workspace-write");
  assert.ok(
    !codex.includes("--dangerously-bypass-approvals-and-sandbox"),
    "产 plan 不该整台机器敞开——codex 是唯一能收紧沙箱的",
  );
  // prompt 必须排在所有选项后面，它是位置参数
  assert.equal(codex[codex.length - 1], codex.find((a) => a.includes("产实施 plan")));

  // agy：无头模式只有「全自动批准」一档，边界只能靠 prompt
  freshUserData();
  const t3 = addTask({ title: "工作包", content: "产 plan", workpackDir: dir });
  const agy = await runJobAndCaptureArgs({
    ids: [t3.id], cwd: "/mock/repo", mode: "plan", engine: "agy",
  });
  assert.ok(agy.includes("--dangerously-skip-permissions"));
  assert.ok(
    !agy.includes("--mode"),
    "别用 agy 自带的 --mode plan：语义没文档，可能连 plan.md 都写不出、还可能挡掉 MCP",
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test("plan 档：三个引擎都要放行工作包目录，规范按各自能力送进去", async () => {
  const dir = freshWorkpackDir("# 工作规范\n必须逐张 Read 截图。");

  for (const engine of ["claude", "codex", "agy"]) {
    freshUserData();
    const task = addTask({ title: "工作包", content: "产 plan", workpackDir: dir });
    const args = await runJobAndCaptureArgs({
      ids: [task.id], cwd: "/mock/repo", mode: "plan", engine,
    });

    // 工作包在仓库外，三个引擎都有 --add-dir，都得放行
    assert.equal(args[args.indexOf("--add-dir") + 1], dir, `${engine} 没放行工作包目录`);

    if (engine === "claude") {
      // 只有 claude 有 --append-system-prompt，规范注进 system prompt 跳不掉
      assert.match(args[args.indexOf("--append-system-prompt") + 1], /必须逐张 Read 截图/);
    } else {
      // 另外两个没这个参数，规范只能拼进 prompt 正文
      assert.ok(!args.includes("--append-system-prompt"));
      const prompt = engine === "codex" ? args[args.length - 1] : args[args.indexOf("-p") + 1];
      assert.match(prompt, /必须逐张 Read 截图/, `${engine} 的规范没送进去`);
      assert.match(prompt, /产实施 plan/, `${engine} 的 plan 档指引没送进去`);
    }
  }

  fs.rmSync(dir, { recursive: true, force: true });
});

test("工作包任务：目录 --add-dir 放行，skill.md 注入 system prompt", async () => {
  freshUserData();
  const dir = freshWorkpackDir();
  const task = addTask({
    title: "需求池工作包",
    content: "产 plan",
    workpackDir: dir,
    source: "req-pool",
  });
  assert.equal(getTask(task.id).workpackDir, dir, "workpackDir 要能存进任务库");

  const args = await runJobAndCaptureArgs({
    ids: [task.id],
    cwd: "/mock/repo",
    mode: "plan",
    engine: "claude",
  });

  // 工作包在被分析仓库之外，不放行就既读不到 context.md 也写不出 plan.md
  assert.equal(args[args.indexOf("--add-dir") + 1], dir);
  // 注入 system prompt 而不是让 agent「自己去读一个文件」——它跳不掉
  assert.match(args[args.indexOf("--append-system-prompt") + 1], /必须逐张 Read 截图/);
  // prompt 里要说清哪条任务对应哪个目录
  const prompt = args[args.indexOf("-p") + 1];
  assert.match(prompt, new RegExp(`#${task.seq} → ${dir}`));
  assert.match(prompt, /产实施 plan/);
});

test("工作包没带 skill.md 也照常跑，不注入空的 system prompt", async () => {
  freshUserData();
  const dir = freshWorkpackDir(null);
  const task = addTask({ title: "无规范工作包", content: "x", workpackDir: dir });

  const args = await runJobAndCaptureArgs({
    ids: [task.id],
    cwd: "/mock/repo",
    mode: "plan",
    engine: "claude",
  });

  assert.ok(args.includes("--add-dir"), "目录还是要放行");
  assert.ok(!args.includes("--append-system-prompt"), "没规范就别塞个空的进去");
});

test("普通 IM 任务不受影响：没有 workpackDir 就不加 --add-dir", async () => {
  freshUserData();
  const task = addTask({ title: "IM 提问", content: "这个接口怎么走的" });

  const args = await runJobAndCaptureArgs({
    ids: [task.id],
    cwd: "/mock/repo",
    mode: "analyze",
    engine: "claude",
  });

  assert.ok(!args.includes("--add-dir"));
  assert.ok(!args.includes("--append-system-prompt"));
  assert.ok(!args.includes("--append-system-prompt"));
});

// ─── /plan 指令 ──────────────────────────────────────────────────────────────

test("parseCommand: /plan 独立成一条指令，不跟 /r、/u 串味", async () => {
  const { parseCommand } = await import("../src/feishu/listener.js");

  assert.deepEqual(parseCommand("/plan https://x.feishu.cn/wiki/abc"), {
    cmd: "plan",
    body: "https://x.feishu.cn/wiki/abc",
  });
  // 全角冒号、大小写、多余空格都要认——飞书输入法常带出来
  assert.equal(parseCommand("/PLAN：rec123").cmd, "plan");
  assert.equal(parseCommand("/plan   相似推荐").body, "相似推荐");
  // /r 里贴链接仍然是普通需求，不该被当成工作包
  assert.deepEqual(parseCommand("/r 见 https://x.feishu.cn/wiki/abc"), {
    cmd: "r",
    body: "见 https://x.feishu.cn/wiki/abc",
  });
  // 别把 /plans、/planning 这类词误判成指令
  assert.equal(parseCommand("/planning 下周排期").cmd, null);
  assert.equal(parseCommand("/u 7 补充").cmd, "u");
  assert.equal(parseCommand("随便说句话").cmd, null);
});

test("指令表是唯一事实来源：/h 帮助与面板提示栏都由它生成", async () => {
  const { parseCommand, renderHelp } = await import("../src/feishu/listener.js");
  const { COMMANDS } = await import("../src/feishu/commands.js");

  const help = renderHelp();
  for (const c of COMMANDS) {
    // 表里有的，/h 里必须有——帮助文案由表生成，漏了说明生成逻辑坏了
    assert.ok(help.includes(c.usage), `/h 里缺 ${c.usage}`);
    assert.ok(help.includes(c.help), `/h 里缺「${c.help}」的说明`);
    // 面板提示栏靠 hint 渲染，缺了那一格就是空的
    assert.ok(c.hint?.code && c.hint?.label, `${c.key} 缺 hint，面板提示栏会漏显示`);
  }

  // 表里列出来的，listener 必须真认得——否则会出现「帮助里写了但发过去没反应」
  for (const c of COMMANDS) {
    assert.ok(
      parseCommand(c.hint.code).cmd,
      `指令表里写了 ${c.hint.code}，但 parseCommand 不认它`,
    );
  }

  // 反过来：现有指令一个都不许从文档里消失
  for (const cmd of ["/r", "/plan", "/u", "/h"]) {
    assert.ok(
      COMMANDS.some((c) => c.hint.code === cmd || c.hint.code.startsWith(`${cmd} `)),
      `${cmd} 必须写进指令表`,
    );
  }

  // 加了 /plan 之后正则别把 /h 吃掉
  assert.equal(parseCommand("/help").cmd, "h");
});

test("指令表：改表就能改到帮助文案，不用再去手改一遍", async () => {
  const { COMMANDS, renderHelp } = await import("../src/feishu/commands.js");

  const plan = COMMANDS.find((c) => c.key === "plan");
  assert.ok(plan, "/plan 得在表里");
  // 示例与续行都要落进 /h
  for (const note of plan.examples[0].notes) {
    assert.ok(renderHelp().includes(note), `/h 里缺示例续行：${note}`);
  }
  // 「不带指令的消息也会留底」那句要跟着表走，不能写死成「不带 /r」
  assert.match(renderHelp(), /不带指令（\/r、\/plan）/);
});

/** 造一个假的飞书消息事件。 */
function fakeEvt(overrides = {}) {
  return {
    message_id: "om_plan_1",
    chat_id: "oc_chat_1",
    chat_type: "p2p",
    sender_id: "ou_someone",
    ...overrides,
  };
}

/**
 * 会触发 force 回执（失败、已存在）的用例用这个。
 *
 * force 绕过 ackEnabled，会真的走 sendMessage。给一个没有任何投递目标的 evt，
 * sendMessage 会在「缺 chat_id / open_id」那步直接返回，一个 lark-cli 进程都不起——
 * 测试绝不该尝试往真实飞书发消息。
 */
const silentEvt = () => fakeEvt({ message_id: "", chat_id: "", sender_id: "" });

/**
 * mock 掉备料子进程，让它按给定结果收尾。
 * 返回 calls 供断言实际起进程的参数。
 */
async function mockPrepare({ stdout = "", stderr = "", code = 0 }) {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const { setPrepareSpawnImpl } = await import("../src/feishu/listener.js");

  const calls = [];
  setPrepareSpawnImpl((bin, args, opts) => {
    calls.push({ bin, args, opts });
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = () => proc.emit("close", 143);
    setImmediate(() => {
      if (stdout) proc.stdout.write(stdout);
      if (stderr) proc.stderr.write(stderr);
      proc.stdout.end();
      proc.stderr.end();
      proc.emit("close", code);
    });
    return proc;
  });
  return { calls, restore: () => setPrepareSpawnImpl(null) };
}

/** 造一个 req prepare 产出的工作包。 */
function fakePreparedWorkpack({ recordId = "recPLAN01", assets = 2 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-workpack-"));
  fs.writeFileSync(
    path.join(dir, "context.md"),
    [
      "# 工作包: 视频详情页增加「相似推荐」模块",
      "",
      "- 方案文档: https://example.feishu.cn/wiki/ABCdef",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(dir, "requirement.md"), "需求正文\n");
  fs.writeFileSync(path.join(dir, "skill.md"), "# 工作规范\n必须逐张 Read 截图。");
  if (assets) {
    fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
    for (let i = 1; i <= assets; i += 1) {
      fs.writeFileSync(path.join(dir, "assets", `img-0${i}.png`), `png${i}`);
    }
  }
  return {
    dir,
    json: JSON.stringify({ outDir: dir, recordId, name: "相似推荐", assetCount: assets }),
  };
}

test("/plan: 备料进程用 Electron 当 node 跑，带 --json 与 --repo", async () => {
  freshUserData();
  // ackEnabled 关掉，回执静默——测试绝不该真往飞书发消息
  setSettings({ ackEnabled: false, autoDispatchCwd: "/mock/repo" });
  const { handlePlanCommand } = await import("../src/feishu/listener.js");
  const { dir, json } = fakePreparedWorkpack();
  const { calls, restore } = await mockPrepare({ stdout: json });

  await handlePlanCommand(fakeEvt(), "https://x.feishu.cn/wiki/abc", Date.now(), "om_plan_1");
  restore();

  const { bin, args, opts } = calls[0];
  assert.equal(bin, process.execPath, "要拿 Electron 自己当 node 跑，否则读不到 asar 里的 req");
  assert.equal(opts.env.ELECTRON_RUN_AS_NODE, "1");
  assert.ok(args[0].endsWith(path.join("req-to-plan", "bin", "req")));
  assert.deepEqual(args.slice(1, 4), ["prepare", "https://x.feishu.cn/wiki/abc", "--json"]);
  assert.ok(args.includes("--repo"), "要告诉 req 影响面扫哪个仓库");
  // 工作包落 userData，不落被分析仓库——那边开着隔离分支
  assert.ok(opts.cwd.includes("req-workpacks"));
  assert.ok(opts.env.PATH, "req 还要起 lark-cli，PATH 必须是登录 shell 那份");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("/plan: 备料成功后建出带 workpackDir 与真实飞书会话的任务", async () => {
  freshUserData();
  setSettings({ ackEnabled: false, autoDispatchCwd: "/mock/repo" });
  const { handlePlanCommand } = await import("../src/feishu/listener.js");
  const { onQueueIdle } = await import("../src/feishu/runner.js");
  const { dir, json } = fakePreparedWorkpack();
  const { restore } = await mockPrepare({ stdout: json });
  const { restore: restoreRun } = await captureSpawn();

  await handlePlanCommand(fakeEvt(), "https://x.feishu.cn/wiki/abc", Date.now(), "om_plan_1");
  await onQueueIdle();
  restore();
  restoreRun();

  const [task] = listTasks();
  assert.equal(task.source, "req-pool");
  assert.equal(task.workpackDir, dir);
  assert.equal(task.title, "视频详情页增加「相似推荐」模块");
  // /plan 来的任务带着真实飞书会话，AI 的 ask_requester 才发得出去
  assert.equal(task.chatId, "oc_chat_1");
  assert.equal(task.requester.id, "ou_someone");
  assert.equal(task.messageId, "om_plan_1");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("/plan: 跟 /r 一样，没开自动派发就只备料进待处理，不起 AI", async () => {
  freshUserData();
  setSettings({ ackEnabled: false, autoDispatchCwd: "/mock/repo", autoDispatchEnabled: false });
  const { handlePlanCommand } = await import("../src/feishu/listener.js");
  const { onQueueIdle } = await import("../src/feishu/runner.js");
  const { dir, json } = fakePreparedWorkpack();
  const { restore } = await mockPrepare({ stdout: json });
  const { calls, restore: restoreRun } = await captureSpawn();

  await handlePlanCommand(fakeEvt(), "https://x.feishu.cn/wiki/abc", Date.now(), "om_plan_1");
  await onQueueIdle();
  restore();
  restoreRun();

  assert.equal(calls.length, 0, "自动派发关着，不该起 AI 进程");
  const [task] = listTasks();
  assert.equal(task.workpackDir, dir);
  assert.equal(task.status, "inbox");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("/plan: 开了自动派发就开跑，力度固定 plan 档，引擎听预设", async () => {
  freshUserData();
  setSettings({ ackEnabled: false, autoDispatchCwd: "/mock/repo", autoDispatchEnabled: true, autoDispatchEngine: "agy", autoDispatchCreateBranch: false });
  const { handlePlanCommand } = await import("../src/feishu/listener.js");
  const { onQueueIdle } = await import("../src/feishu/runner.js");
  const { dir, json } = fakePreparedWorkpack();
  const { restore } = await mockPrepare({ stdout: json });
  const { calls, restore: restoreRun } = await captureSpawn();

  await handlePlanCommand(fakeEvt(), "https://x.feishu.cn/wiki/abc", Date.now(), "om_plan_1");
  await onQueueIdle();
  restore();
  restoreRun();

  assert.equal(calls.length, 1, "应该派出去一个 job");
  assert.equal(calls[0].bin, "agy", "预设选了 agy，/plan 就该走 agy");
  const [task] = listTasks();
  assert.equal(task.lastRunConfig.mode, "plan");
  assert.equal(task.lastRunConfig.engine, "agy");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("/plan: 开了自动派发且预设 claude 时，走 plan 档的工具限制", async () => {
  freshUserData();
  setSettings({ ackEnabled: false, autoDispatchCwd: "/mock/repo", autoDispatchEnabled: true, autoDispatchEngine: "claude" });
  const { handlePlanCommand } = await import("../src/feishu/listener.js");
  const { onQueueIdle } = await import("../src/feishu/runner.js");
  const { dir, json } = fakePreparedWorkpack();
  const { restore } = await mockPrepare({ stdout: json });
  const { calls, restore: restoreRun } = await captureSpawn();

  await handlePlanCommand(fakeEvt(), "https://x.feishu.cn/wiki/abc", Date.now(), "om_plan_1");
  await onQueueIdle();
  restore();
  restoreRun();

  assert.equal(calls.length, 1, "应该派出去一个 job");
  const { args } = calls[0];
  const deny = args.slice(args.indexOf("--disallowedTools") + 1);
  assert.ok(deny.includes("Bash"), "plan 档禁 Bash，扫描走 req_scan");
  assert.equal(args[args.indexOf("--add-dir") + 1], dir);
  assert.match(args[args.indexOf("--append-system-prompt") + 1], /必须逐张 Read 截图/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("/plan: 同一份需求再 /plan 一次不重复建任务", async () => {
  freshUserData();
  setSettings({ ackEnabled: false, autoDispatchCwd: "/mock/repo" });
  const { handlePlanCommand } = await import("../src/feishu/listener.js");
  const { dir, json } = fakePreparedWorkpack();

  // 第一次用真实会话（走静默的普通回执），第二次命中 existing 分支、是 force 回执，
  // 换成没有投递目标的 evt 免得真去发消息
  const rounds = [
    { evt: fakeEvt(), msgId: "om_plan_1" },
    { evt: silentEvt(), msgId: "" },
  ];
  for (const { evt, msgId } of rounds) {
    const { restore } = await mockPrepare({ stdout: json });
    await handlePlanCommand(evt, "rec123", Date.now(), msgId);
    restore();
  }

  assert.equal(listTasks().length, 1, "第二次只该刷新材料，不该再建一条");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("/plan: 已完成的任务带新交代再发一次，没开自动派发就放回待处理", async () => {
  freshUserData();
  setSettings({ ackEnabled: false, autoDispatchCwd: "/mock/repo", autoDispatchEnabled: false });
  const { handlePlanCommand } = await import("../src/feishu/listener.js");
  const { dir, json } = fakePreparedWorkpack();

  let prep = await mockPrepare({ stdout: json });
  await handlePlanCommand(fakeEvt(), "recPLAN01xyz", Date.now(), "om_plan_1");
  prep.restore();
  const [created] = listTasks();
  updateTask(created.id, { status: "done" });

  prep = await mockPrepare({ stdout: json });
  await handlePlanCommand(
    fakeEvt({ message_id: "om_plan_2" }),
    "recPLAN01xyz 重点看图片业务线",
    Date.now(),
    "om_plan_2",
  );
  prep.restore();

  assert.equal(listTasks().length, 1, "同一份需求不该再建一条");
  const task = getTask(created.id);
  assert.equal(task.status, "inbox");
  assert.ok(task.thread.some((e) => e.text === "重点看图片业务线"), "新交代要挂进沟通记录");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("/plan: 备料失败不建任务，错误原因取 stderr 末尾几行", async () => {
  freshUserData();
  setSettings({ ackEnabled: false, autoDispatchCwd: "/mock/repo" });
  const { handlePlanCommand } = await import("../src/feishu/listener.js");
  const { restore } = await mockPrepare({
    stderr: "→ 查询需求池\n✗ 未在「排实施」中找到: 不存在的需求\n",
    code: 1,
  });

  await handlePlanCommand(silentEvt(), "不存在的需求", Date.now(), "");
  restore();

  assert.equal(listTasks().length, 0, "备料都没成功，不该在面板上留一条空任务");
});

test("/plan: 没配项目目录时直接拒，不拿工作包目录当仓库扫出一份空的影响面", async () => {
  freshUserData();
  setSettings({ ackEnabled: false, autoDispatchCwd: "auto", lastCwd: "" });
  const { handlePlanCommand } = await import("../src/feishu/listener.js");
  const { calls, restore } = await mockPrepare({ stdout: "{}" });

  await handlePlanCommand(silentEvt(), "rec123", Date.now(), "");
  restore();

  assert.equal(calls.length, 0, "连备料进程都不该起");
  assert.equal(listTasks().length, 0);
});

test("/plan: 开了自动派发，名单外的人也只备料不派活", async () => {
  freshUserData();
  setSettings({
    ackEnabled: false,
    autoDispatchCwd: "/mock/repo",
    autoDispatchEnabled: true,
    allowedRequesters: ["ou_only_me"],
  });
  const { handlePlanCommand } = await import("../src/feishu/listener.js");
  const { onQueueIdle } = await import("../src/feishu/runner.js");
  const { dir, json } = fakePreparedWorkpack();
  const { restore } = await mockPrepare({ stdout: json });
  const { calls, restore: restoreRun } = await captureSpawn();

  await handlePlanCommand(
    fakeEvt({ sender_id: "ou_someone_else" }),
    "rec123",
    Date.now(),
    "om_plan_1",
  );
  await onQueueIdle();
  restore();
  restoreRun();

  assert.equal(calls.length, 0, "名单外的人不该驱动本机起 AI 进程");
  // 但材料照备、任务照留底，等人在面板上确认
  const [task] = listTasks();
  assert.equal(task.workpackDir, dir);
  assert.equal(task.status, "inbox");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("parsePlanTarget: 链接/record_id 挑出来备料，剩下的话是提出人的交代", async () => {
  const { parsePlanTarget } = await import("../src/feishu/listener.js");

  // 说明在前
  assert.deepEqual(parsePlanTarget("帮我看看 https://x.feishu.cn/wiki/abc"), {
    target: "https://x.feishu.cn/wiki/abc",
    remark: "帮我看看",
  });
  // 说明在后，链接带 query
  assert.deepEqual(
    parsePlanTarget("https://x.feishu.cn/wiki/abc?from=from_copylink 看看有没有要改的"),
    {
      target: "https://x.feishu.cn/wiki/abc?from=from_copylink",
      remark: "看看有没有要改的",
    },
  );
  // 飞书里常见的「链接后面直接跟中文、没有空格」
  assert.deepEqual(parsePlanTarget("https://x.feishu.cn/wiki/abc请看下图片业务线"), {
    target: "https://x.feishu.cn/wiki/abc",
    remark: "请看下图片业务线",
  });
  // record_id 同理
  assert.deepEqual(parsePlanTarget("rec27zFqrO7jDS 重点看图片业务线"), {
    target: "rec27zFqrO7jDS",
    remark: "重点看图片业务线",
  });
  // 飞书富文本 Markdown 链接 [title](url)
  assert.deepEqual(
    parsePlanTarget("看下这个 [需求文档](https://x.feishu.cn/wiki/abc) 重点看支付"),
    {
      target: "https://x.feishu.cn/wiki/abc",
      remark: "看下这个 重点看支付",
    },
  );
  // 尖括号包裹 <url>
  assert.deepEqual(
    parsePlanTarget("<https://x.feishu.cn/wiki/abc> 重点看支付"),
    {
      target: "https://x.feishu.cn/wiki/abc",
      remark: "重点看支付",
    },
  );
  // 引号包裹
  assert.deepEqual(
    parsePlanTarget('"https://x.feishu.cn/wiki/abc" 重点看支付'),
    {
      target: "https://x.feishu.cn/wiki/abc",
      remark: "重点看支付",
    },
  );
  // 光秃秃一个链接，没有交代
  assert.equal(parsePlanTarget("https://x.feishu.cn/wiki/abc").remark, "");
  // 没有链接也没有 record_id：整段当需求名，不硬拆
  assert.deepEqual(parsePlanTarget("相似推荐"), { target: "相似推荐", remark: "" });
  assert.deepEqual(parsePlanTarget("相似推荐 重点看图片"), {
    target: "相似推荐 重点看图片",
    remark: "",
  });
});

test("/plan: 指令里顺带说的话进 prompt，并回显出来好让人发现拆错", async () => {
  freshUserData();
  setSettings({ ackEnabled: false, autoDispatchCwd: "/mock/repo", autoDispatchEnabled: true });
  const { handlePlanCommand } = await import("../src/feishu/listener.js");
  const { onQueueIdle } = await import("../src/feishu/runner.js");
  const { dir, json } = fakePreparedWorkpack();
  const { calls: prepCalls, restore } = await mockPrepare({ stdout: json });
  const { calls, restore: restoreRun } = await captureSpawn();

  await handlePlanCommand(
    fakeEvt(),
    "https://x.feishu.cn/wiki/abc 请查看这个链接，看看有没有什么修改的",
    Date.now(),
    "om_plan_1",
  );
  await onQueueIdle();
  restore();
  restoreRun();

  // 喂给 req prepare 的只能是链接，不能把整句话带过去
  assert.equal(prepCalls[0].args[2], "https://x.feishu.cn/wiki/abc");

  const [task] = listTasks();
  assert.match(task.content, /提出人在指令里另外交代了一句/);
  assert.match(task.content, /> 请查看这个链接，看看有没有什么修改的/);
  // 真的送到 agent 手上了
  assert.match(calls[0].args[calls[0].args.indexOf("-p") + 1], /看看有没有什么修改的/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("/plan: 没有交代时不硬塞一段空的「提出人另外交代」", async () => {
  freshUserData();
  setSettings({ ackEnabled: false, autoDispatchCwd: "/mock/repo" });
  const { handlePlanCommand } = await import("../src/feishu/listener.js");
  const { onQueueIdle } = await import("../src/feishu/runner.js");
  const { dir, json } = fakePreparedWorkpack();
  const { restore } = await mockPrepare({ stdout: json });
  const { restore: restoreRun } = await captureSpawn();

  await handlePlanCommand(fakeEvt(), "https://x.feishu.cn/wiki/abc", Date.now(), "om_plan_1");
  await onQueueIdle();
  restore();
  restoreRun();

  assert.ok(!/提出人在指令里另外交代/.test(listTasks()[0].content));

  fs.rmSync(dir, { recursive: true, force: true });
});

test("/plan: 同一份需求再 /plan 一次，新交代挂进沟通记录不丢", async () => {
  freshUserData();
  setSettings({ ackEnabled: false, autoDispatchCwd: "/mock/repo", autoDispatchEnabled: true });
  const { handlePlanCommand } = await import("../src/feishu/listener.js");
  const { onQueueIdle } = await import("../src/feishu/runner.js");
  const { dir, json } = fakePreparedWorkpack();

  const first = await mockPrepare({ stdout: json });
  const firstRun = await captureSpawn();
  await handlePlanCommand(fakeEvt(), "rec27zFqrO7jDS 先整体看一遍", Date.now(), "om_plan_1");
  await onQueueIdle();
  first.restore();
  firstRun.restore();

  const second = await mockPrepare({ stdout: json });
  const secondRun = await captureSpawn();
  await handlePlanCommand(silentEvt(), "rec27zFqrO7jDS 这次重点看图片业务线", Date.now(), "");
  await onQueueIdle();
  second.restore();
  secondRun.restore();

  assert.equal(listTasks().length, 1, "不该重复建任务");
  const [task] = listTasks();
  const said = task.thread.map((e) => e.text).join("\n");
  assert.match(said, /先整体看一遍/, "第一次的交代在正文里");
  assert.match(said, /这次重点看图片业务线/, "第二次的交代不能丢");
  // 只记不跑的话人会一直等：带了新交代就该真的再跑一轮
  assert.equal(secondRun.calls.length, 1, "第二次带交代应该重新派一轮");
  assert.match(
    secondRun.calls[0].args[secondRun.calls[0].args.indexOf("-p") + 1],
    /这次重点看图片业务线/,
    "新交代要送到 agent 手上",
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test("/plan: 光秃秃再发一次不重跑，只告诉你已经有这条了", async () => {
  freshUserData();
  setSettings({ ackEnabled: false, autoDispatchCwd: "/mock/repo" });
  const { handlePlanCommand } = await import("../src/feishu/listener.js");
  const { onQueueIdle } = await import("../src/feishu/runner.js");
  const { dir, json } = fakePreparedWorkpack();

  const first = await mockPrepare({ stdout: json });
  const firstRun = await captureSpawn();
  await handlePlanCommand(fakeEvt(), "https://x.feishu.cn/wiki/abc", Date.now(), "om_plan_1");
  await onQueueIdle();
  first.restore();
  firstRun.restore();

  const second = await mockPrepare({ stdout: json });
  const secondRun = await captureSpawn();
  await handlePlanCommand(silentEvt(), "https://x.feishu.cn/wiki/abc", Date.now(), "");
  await onQueueIdle();
  second.restore();
  secondRun.restore();

  assert.equal(listTasks().length, 1);
  assert.equal(secondRun.calls.length, 0, "没说新要求就别白跑一轮");

  fs.rmSync(dir, { recursive: true, force: true });
});





test("req-to-plan 留在 asar 里，两个消费方都拿 Electron 当 node 跑", async () => {
  const fs = await import("node:fs");

  // 扫描改走 MCP 之后没人再用系统 node 读它了，asarUnpack 与配套的路径换算一并去掉。
  // 那段换算曾经因为两处各换一次滚成 app.asar.unpacked.unpacked，别让它回来
  for (const f of ["src/paths.js", "src/feishu/listener.js", "src/feishu/mcp-server.mjs"]) {
    const src = fs.readFileSync(f, "utf8");
    assert.ok(
      !/\.replace\([^)]*app\.asar/.test(src),
      `${f} 里出现了 asar 路径换算——留在 asar 里就不需要它，两处各换一次会滚成 .unpacked.unpacked`,
    );
  }
  assert.ok(
    !("asarUnpack" in (JSON.parse(fs.readFileSync("package.json", "utf8")).build || {})),
    "asarUnpack 去掉了；要加回来必须同时说明谁在用系统 node 读它",
  );

  // 读 req-to-plan 的只有这两处，都必须用 Electron 当 node（否则读不了 asar）
  for (const f of ["src/feishu/listener.js", "src/feishu/mcp-server.mjs"]) {
    const src = fs.readFileSync(f, "utf8");
    assert.match(src, /ELECTRON_RUN_AS_NODE/, `${f} 起 req 必须带 ELECTRON_RUN_AS_NODE`);
    assert.match(src, /process\.execPath/, `${f} 必须用 Electron 自身当 node`);
  }
});

test("req_scan 对所有档位都放行：影响面扫描是 plan 档唯一的检索手段", async () => {
  for (const mode of ["analyze", "plan", "edit", "full"]) {
    freshUserData();
    const task = addTask({ title: "任务", content: "x" });
    const args = await runJobAndCaptureArgs({
      ids: [task.id], cwd: "/mock/repo", mode, engine: "claude",
    });
    const allow = args.slice(
      args.indexOf("--allowedTools") + 1,
      args.indexOf("--disallowedTools") === -1 ? undefined : args.indexOf("--disallowedTools"),
    );
    assert.ok(allow.includes("mcp__docking__req_scan"), `${mode} 档没放行 req_scan`);
    assert.ok(allow.includes("mcp__docking__update_task"), `${mode} 档没放行 update_task`);
  }
});

test("plan 档指引：对 claude 说没有 Bash，对 agy/codex 不说假话", async () => {
  const dir = freshWorkpackDir();
  for (const engine of ["claude", "agy", "codex"]) {
    freshUserData();
    const task = addTask({ title: "工作包", content: "产 plan", workpackDir: dir });
    const args = await runJobAndCaptureArgs({
      ids: [task.id], cwd: "/mock/repo", mode: "plan", engine,
    });
    const prompt = engine === "codex" ? args[args.length - 1] : args[args.indexOf("-p") + 1];

    assert.match(prompt, /req_scan/, `${engine} 的指引里没提 req_scan`);
    if (engine === "claude") {
      assert.match(prompt, /没有 Bash/, "claude 档是真禁了，该说明白");
    } else {
      // agy/codex 其实有 Bash，说「没有」它一试就发现是假话，后半句也不信了
      assert.ok(!/没有 Bash/.test(prompt), `${engine} 实际有 Bash，不该说没有`);
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── 收尾兜底与会话续接 ──────────────────────────────────────────────────────

/**
 * 起一个会吐 stream-json 的 mock spawn。script(call) 返回 { lines, code, before }：
 * before 在吐日志前执行（用来模拟 AI 经 MCP 回写任务库），lines 逐行写 stdout。
 */
async function scriptedSpawn(script) {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const { setSpawnImpl } = await import("../src/feishu/runner.js");
  const calls = [];
  setSpawnImpl((bin, args, opts) => {
    const call = { bin, args, opts };
    calls.push(call);
    const { lines = [], code = 0, before } = script(call, calls.length) || {};
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = () => proc.emit("close", 0);
    setImmediate(() => {
      before?.();
      for (const l of lines) proc.stdout.write(`${JSON.stringify(l)}\n`);
      proc.stdout.end();
      proc.stderr.end();
      // 等 readline 把最后几行吐完再 close
      setTimeout(() => proc.emit("close", code), 10);
    });
    return proc;
  });
  return { calls, restore: () => setSpawnImpl(null) };
}

/** 在临时 CLAUDE_CONFIG_DIR 里放一份会话文件，让 claudeSessionExists 认得到 */
function fakeClaudeSession(cwd, sessionId) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "docking-claude-cfg-"));
  const projDir = path.join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, `${sessionId}.jsonl`), "{}\n");
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  return () => {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
    fs.rmSync(configDir, { recursive: true, force: true });
  };
}

test("收尾兜底：正常退出但 AI 没回写状态，任务放回待处理并留下它最后的输出", async () => {
  freshUserData();
  const { enqueueJob, onQueueIdle } = await import("../src/feishu/runner.js");
  const t = addTask({ title: "没回写的任务", content: "查个逻辑" });
  updateTask(t.id, { status: "doing" });

  const { restore } = await scriptedSpawn(() => ({
    lines: [
      { type: "system", subtype: "init", session_id: "s-1" },
      { type: "result", subtype: "success", is_error: false, result: "结论：超时在 order.js 里处理", session_id: "s-1" },
    ],
  }));
  try {
    enqueueJob({ ids: [t.id], cwd: "/mock/repo", mode: "analyze", engine: "claude" });
    await onQueueIdle();
  } finally {
    restore();
  }

  const after = getTask(t.id);
  assert.equal(after.status, "inbox", "不能卡在 doing");
  const last = after.thread[after.thread.length - 1];
  assert.equal(last.role, "system");
  assert.match(last.text, /没有回写任务状态/);
  assert.match(last.text, /超时在 order\.js 里处理/, "AI 最后说的话要留下来给人判断");
});

test("收尾兜底：AI 自己回写了 done / awaiting 的任务不被动", async () => {
  freshUserData();
  const { enqueueJob, onQueueIdle } = await import("../src/feishu/runner.js");
  const done = addTask({ title: "回写了完成", content: "a" });
  const asked = addTask({ title: "反问了", content: "b" });
  updateTask(done.id, { status: "doing" });
  updateTask(asked.id, { status: "doing" });

  const { restore } = await scriptedSpawn(() => ({
    before: () => {
      updateTask(done.id, { status: "done", note: "搞定" });
      updateTask(asked.id, { status: "awaiting" });
    },
  }));
  try {
    enqueueJob({ ids: [done.id, asked.id], cwd: "/mock/repo", mode: "analyze", engine: "claude" });
    await onQueueIdle();
  } finally {
    restore();
  }

  assert.equal(getTask(done.id).status, "done");
  assert.equal(getTask(asked.id).status, "awaiting");
  assert.ok(!(getTask(done.id).thread || []).some((e) => /没有回写/.test(e.text)));
});

test("会话续接：claude 单任务跑完记下 session，下一轮 --resume 且只送新进展", async () => {
  freshUserData();
  const { enqueueJob, onQueueIdle } = await import("../src/feishu/runner.js");
  const cwd = "/mock/resume-repo";
  const t = addTask({ title: "要反问的需求", content: "原始需求正文-独一无二" });
  const cleanup = fakeClaudeSession(cwd, "sess-abc");

  const { calls, restore } = await scriptedSpawn((_call, n) =>
    n === 1
      ? {
          lines: [{ type: "system", subtype: "init", session_id: "sess-abc" }],
          before: () => updateTask(t.id, { status: "awaiting" }),
        }
      : { lines: [], before: () => updateTask(t.id, { status: "done" }) },
  );
  try {
    enqueueJob({ ids: [t.id], cwd, mode: "analyze", engine: "claude" });
    await onQueueIdle();

    const session = getTask(t.id).agentSession;
    assert.equal(session.id, "sess-abc");
    assert.equal(session.cwd, cwd);

    await new Promise((r) => setTimeout(r, 5));
    appendThread(t.id, { role: "them", text: "超时是 30 分钟", at: Date.now() });

    enqueueJob({ ids: [t.id], cwd, mode: "edit", engine: "claude" });
    await onQueueIdle();
  } finally {
    restore();
    cleanup();
  }

  const args = calls[1].args;
  assert.equal(args[args.indexOf("--resume") + 1], "sess-abc");
  const prompt = args[args.indexOf("-p") + 1];
  assert.match(prompt, /超时是 30 分钟/, "新进展要送进去");
  assert.ok(!prompt.includes("原始需求正文-独一无二"), "上一轮已有的需求正文不重发");
  assert.match(prompt, /允许改代码/, "力度变了要以本轮为准");
  assert.ok(!calls[0].args.includes("--resume"), "首轮是冷启动");
});

test("会话续接：换了仓库、会话文件不在、批量任务、非 claude 都冷启动", async () => {
  freshUserData();
  const { enqueueJob, onQueueIdle } = await import("../src/feishu/runner.js");
  const cwd = "/mock/resume-repo-2";
  const session = { engine: "claude", id: "sess-x", cwd, endedAt: 1 };
  const a = addTask({ title: "a", content: "a" });
  const b = addTask({ title: "b", content: "b" });
  updateTask(a.id, { agentSession: session });
  updateTask(b.id, { agentSession: session });
  const cleanup = fakeClaudeSession(cwd, "sess-x");

  const { calls, restore } = await scriptedSpawn(() => ({}));
  try {
    enqueueJob({ ids: [a.id], cwd: "/mock/other-repo", mode: "analyze", engine: "claude" });
    enqueueJob({ ids: [a.id, b.id], cwd, mode: "analyze", engine: "claude" });
    enqueueJob({ ids: [a.id], cwd, mode: "analyze", engine: "codex" });
    await onQueueIdle();
  } finally {
    restore();
    cleanup();
  }
  for (const c of calls) assert.ok(!c.args.includes("--resume"), `${c.bin} 不该续接`);

  // 会话文件被清掉：同仓库同任务也冷启动
  const { calls: calls2, restore: restore2 } = await scriptedSpawn(() => ({}));
  try {
    enqueueJob({ ids: [a.id], cwd, mode: "analyze", engine: "claude" });
    await onQueueIdle();
  } finally {
    restore2();
  }
  assert.ok(!calls2[0].args.includes("--resume"));
});

test("会话续接：续接轮失败就作废会话，下一轮冷启动", async () => {
  freshUserData();
  const { enqueueJob, onQueueIdle } = await import("../src/feishu/runner.js");
  const cwd = "/mock/resume-repo-3";
  const t = addTask({ title: "c", content: "c" });
  updateTask(t.id, { agentSession: { engine: "claude", id: "sess-bad", cwd, endedAt: 1 } });
  const cleanup = fakeClaudeSession(cwd, "sess-bad");

  const { calls, restore } = await scriptedSpawn(() => ({ code: 1 }));
  try {
    enqueueJob({ ids: [t.id], cwd, mode: "analyze", engine: "claude" });
    await onQueueIdle();
  } finally {
    restore();
    cleanup();
  }
  assert.ok(calls[0].args.includes("--resume"));
  assert.equal(getTask(t.id).agentSession, null);
});

test("会话续接：派活时勾了「从头开始」就不续接，跑完换成新会话", async () => {
  freshUserData();
  const { enqueueJob, onQueueIdle } = await import("../src/feishu/runner.js");
  const cwd = "/mock/resume-repo-4";
  const t = addTask({ title: "d", content: "原始需求正文-从头来" });
  updateTask(t.id, { agentSession: { engine: "claude", id: "sess-old", cwd, endedAt: 1 } });
  const cleanup = fakeClaudeSession(cwd, "sess-old");

  const { calls, restore } = await scriptedSpawn(() => ({
    lines: [{ type: "system", subtype: "init", session_id: "sess-new" }],
    before: () => updateTask(t.id, { status: "done" }),
  }));
  try {
    enqueueJob({ ids: [t.id], cwd, mode: "analyze", engine: "claude", freshSession: true });
    await onQueueIdle();
  } finally {
    restore();
    cleanup();
  }
  const args = calls[0].args;
  assert.ok(!args.includes("--resume"));
  assert.match(args[args.indexOf("-p") + 1], /原始需求正文-从头来/, "从头来要发完整需求");
  assert.equal(getTask(t.id).agentSession.id, "sess-new");
});
