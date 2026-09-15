// 对接任务库。
//
// 刻意不放进 config.json：那边是白名单式 normalize 重建，任务是高频增删的业务数据，
// 混进去既会被 normalizeConfig 静默丢弃，也会让配置文件越滚越大。
// 这里单独落 userData/docking-tasks.json，写盘走 tmp + rename 保证原子。
//
// 不 import electron：MCP server 是独立 node 进程，要复用这个模块读写同一份
// 任务库。Electron 侧启动时调 setDataDir() 注入 app.getPath("userData")，
// MCP server 那边由 runner 通过 VJTOOLS_USER_DATA_DIR 传入。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const FILE_VERSION = 1;

/**
 * 任务状态流转：inbox（新来的）→ doing（已派给模型）→ done；awaiting = 已反问等回复。
 * unfiled = 没带指令（/r、/plan）的消息，不当需求处理，但也不丢——面板上可一键转成 inbox。
 */
export const TASK_STATUS = [
  "inbox",
  "unfiled",
  "awaiting",
  "doing",
  "done",
  "ignored",
];

/** 面板可改的运行时开关。跟任务同文件，避免动 config.json 的白名单 normalize */
const DEFAULT_SETTINGS = {
  // 机器人是否主动回执：/r 的「已记录 #7」、/plan 的备料结果、AI 的反问。
  // /u、/h 是对方明确发指令要的回应，属「问必答」，不受这个开关约束
  ackEnabled: true,
  // 任务完成/忽略时是否自动通知提出人
  notifyOnComplete: true,
  // 是否在执行代码改动前为任务建独立的隔离 worktree（分支 docking/seq-N-…，主仓库不动）
  createBranch: false,
  // 收到提出人澄清回复后是否自动恢复 AI 会话继续执行（仅对 awaiting 的任务生效）
  autoResumeOnClarification: true,
  // 话题里对方追加新指令时，是否允许按关键词把「只读分析」自动提升为「允许改代码」。
  // 默认关：人在面板上选的力度不该被一条飞书消息静默改掉。
  autoEscalateMode: false,
  // 上面那个开关命中用的关键词，面板可改。留空则等于不提升
  escalateKeywords: [
    "修改",
    "改一下",
    "实现",
    "修复",
    "写代码",
    "接入",
    "对接",
    "重构",
  ],
  // 允许触发本机自动执行的飞书 open_id 白名单。空 = 不限制（保持老行为）。
  // 一旦配了人，名单外的人照常能提需求入库，但不会自动拉起 AI——
  // 自动派发在 edit/full 档下等于「一条飞书消息能直接改这台机器上的代码」
  allowedRequesters: [],
  // 收到需求是否自动交给 AI 执行及预设配置
  autoDispatchEnabled: false,
  autoDispatchCwd: "auto",
  autoDispatchMode: "analyze",
  autoDispatchEngine: "claude",
  autoDispatchCreateBranch: true,
  // 上次派活用的工作目录、力度档位和引擎
  lastCwd: "",
  runMode: "analyze",
  runEngine: "claude",
};

let cache = null;
let filePath = null;
let dataDirOverride = null;
let lastMtime = 0;
// 本进程刚删掉的任务 id。写盘合并时用来区分「别的进程新建的」和「我刚删的」，
// 否则被删的任务会从磁盘快照里再被合并回来
const tombstones = new Set();

// 已处理过的飞书消息 id（环形，只留最近这么多条）。事件总线会重推，
// 光靠 task.messageId 只挡得住「建任务」那条，挡不住话题里的追问
const MAX_PROCESSED_IDS = 500;

/** Electron 主进程启动时注入真实 userData 目录（e2e 隔离也走这条） */
export function setDataDir(dir) {
  dataDirOverride = dir || null;
  filePath = null;
  cache = null;
  lastMtime = 0;
  tombstones.clear();
}

export function getDataDir() {
  return (
    dataDirOverride ||
    process.env.VJTOOLS_USER_DATA_DIR ||
    path.join(os.homedir(), "Library", "Application Support", "vjtools")
  );
}

export function getAttachmentsDir(messageId = "") {
  return path.join(getDataDir(), "docking-attachments", messageId);
}

function getFilePath() {
  if (!filePath) {
    const dir = getDataDir();
    filePath = path.join(dir, "docking-tasks.json");
  }
  return filePath;
}

function load() {
  const file = getFilePath();
  let mtime = 0;
  let fileExists = false;
  try {
    const stat = fs.statSync(file);
    mtime = stat.mtimeMs;
    fileExists = true;
  } catch (_) {
    // 文件可能不存在
  }

  // 1. 文件存在且 mtime 未变，直接复用 cache
  if (fileExists && cache && lastMtime && mtime === lastMtime) {
    return cache;
  }

  // 2. 文件不存在，但内存中已有 cache，直接复用
  if (!fileExists && cache) {
    return cache;
  }

  // 3. 从磁盘文件读取解析
  if (fileExists) {
    try {
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw);
      const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
      let nextSeq = Number(parsed.nextSeq) || 1;
      // 老数据没有 seq，补一遍——短号是提出人在飞书里指认任务的唯一凭据，不能缺
      for (const task of [...tasks].reverse()) {
        if (!task.seq) task.seq = nextSeq++;
      }
      lastMtime = mtime;
      cache = {
        version: FILE_VERSION,
        nextSeq: Math.max(nextSeq, ...tasks.map((t) => (t.seq || 0) + 1)),
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
        processedMessageIds: Array.isArray(parsed.processedMessageIds)
          ? parsed.processedMessageIds
          : [],
        tasks,
      };
      return cache;
    } catch (_) {
      // 损坏时降级到空库
    }
  }

  // 4. 首次启动且文件不存在：空库起步
  lastMtime = 0;
  cache = {
    version: FILE_VERSION,
    nextSeq: 1,
    settings: { ...DEFAULT_SETTINGS },
    processedMessageIds: [],
    tasks: [],
  };
  return cache;
}

/**
 * 写盘前跟磁盘对一次账。
 *
 * 主进程和 MCP server 是两个进程在写同一个文件，persist 又是整文件覆写：
 * 如果对方在我们 load 之后写过盘，直接覆盖会把他刚落的任务整条抹掉，
 * 短号也会各自 ++ 撞号。这里以磁盘快照为准补齐差集：
 *   - 磁盘有、内存没有，且不是本进程刚删的 → 是对方新建的，合并进来
 *   - 两边都有 → 取 updatedAt 新的那份
 *   - nextSeq / 已处理消息 id 取并集，短号只增不退
 */
function mergeFromDisk() {
  const target = getFilePath();
  let disk;
  try {
    const stat = fs.statSync(target);
    if (stat.mtimeMs === lastMtime) return; // 没人动过，不用合
    disk = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch (_) {
    return; // 文件不存在或坏了，按内存这份写
  }
  if (!disk || !Array.isArray(disk.tasks)) return;

  const byId = new Map(cache.tasks.map((t) => [t.id, t]));
  const merged = [];
  for (const diskTask of disk.tasks) {
    if (!diskTask?.id) continue;
    if (tombstones.has(diskTask.id)) continue; // 本进程刚删的，别复活
    const mine = byId.get(diskTask.id);
    if (!mine) {
      merged.push(diskTask);
      continue;
    }
    byId.delete(diskTask.id);
    merged.push((mine.updatedAt || 0) >= (diskTask.updatedAt || 0) ? mine : diskTask);
  }
  // 剩下的是本进程新建、磁盘还没有的
  const mineOnly = cache.tasks.filter((t) => byId.has(t.id));

  cache.tasks = [...mineOnly, ...merged].sort(
    (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
  );
  cache.nextSeq = Math.max(
    cache.nextSeq || 1,
    Number(disk.nextSeq) || 1,
    ...cache.tasks.map((t) => (t.seq || 0) + 1),
  );
  cache.processedMessageIds = Array.from(
    new Set([
      ...(Array.isArray(disk.processedMessageIds) ? disk.processedMessageIds : []),
      ...(cache.processedMessageIds || []),
    ]),
  ).slice(-MAX_PROCESSED_IDS);
}

function persist() {
  const target = getFilePath();
  const tmp = `${target}.tmp.${process.pid}`;
  mergeFromDisk();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf8");
  fs.renameSync(tmp, target);
  try {
    const stat = fs.statSync(target);
    lastMtime = stat.mtimeMs;
  } catch (_) {}
}

/** 文件被别的进程（MCP server）改过时丢缓存重读 */
export function reload() {
  cache = null;
  lastMtime = 0;
  return load();
}

/**
 * 这条飞书消息是不是已经处理过了。
 * task.messageId 只记得住建任务的那条首条消息，话题里的追问、澄清回复都不在其中，
 * 事件总线一重推就会重复入库、重复派活，所以单独留一份最近处理过的 id。
 */
export function isMessageProcessed(messageId) {
  if (!messageId) return false;
  return (load().processedMessageIds || []).includes(messageId);
}

export function markMessageProcessed(messageId) {
  if (!messageId) return;
  const store = load();
  if (!Array.isArray(store.processedMessageIds)) store.processedMessageIds = [];
  if (store.processedMessageIds.includes(messageId)) return;
  store.processedMessageIds.push(messageId);
  if (store.processedMessageIds.length > MAX_PROCESSED_IDS) {
    store.processedMessageIds = store.processedMessageIds.slice(-MAX_PROCESSED_IDS);
  }
  persist();
}

export function listTasks() {
  return load().tasks;
}

export function getTask(id) {
  return load().tasks.find((t) => t.id === id) || null;
}

/** 同一条飞书消息重复投递时用 messageId 去重（事件总线可能重推）。 */
export function findByMessageId(messageId) {
  if (!messageId) return null;
  return load().tasks.find((t) => t.messageId === messageId) || null;
}

/** 该发起人最近一条「已反问、等回复」的任务——用来把对方的回复挂回原任务。带 chatId 隔离群聊/私聊。 */
export function findAwaitingBySender(senderId, chatId) {
  if (!senderId) return null;
  const matched = load()
    .tasks.filter(
      (t) =>
        t.status === "awaiting" &&
        t.requester?.id === senderId &&
        (!chatId || !t.chatId || t.chatId === chatId),
    )
    .sort((a, b) => (b.askedAt || 0) - (a.askedAt || 0));
  return matched[0] || null;
}

/**
 * 该发起人最近一条「刚建不久」的任务，用于把连发的多条消息并成一条。
 * 只认 inbox/unfiled：已经派给模型或已完成的任务不该再被追加。带 chatId 隔离。
 */
export function findRecentBySender(senderId, windowMs, chatId) {
  if (!senderId) return null;
  const now = Date.now();
  const matched = load()
    .tasks.filter(
      (t) =>
        t.requester?.id === senderId &&
        (t.status === "inbox" || t.status === "unfiled") &&
        (!chatId || !t.chatId || t.chatId === chatId) &&
        now - (t.updatedAt || t.createdAt || 0) <= windowMs,
    )
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return matched[0] || null;
}

/** 某人提过的、还没收尾的任务，供 /u 列表用（done/ignored 不再允许追加） */
export function listOpenTasksBySender(senderId) {
  if (!senderId) return [];
  return load()
    .tasks.filter(
      (t) =>
        t.requester?.id === senderId &&
        t.status !== "done" &&
        t.status !== "ignored",
    )
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/**
 * 按短号取任务，并校验确实是这个人提的——否则他能往别人的任务里写东西。
 */
export function findBySenderSeq(senderId, seq) {
  if (!senderId || !seq) return null;
  return (
    load().tasks.find(
      (t) =>
        t.seq === Number(seq) &&
        t.requester?.id === senderId &&
        t.status !== "done" &&
        t.status !== "ignored",
    ) || null
  );
}

export function getSettings() {
  const settings = { ...DEFAULT_SETTINGS, ...load().settings };
  settings.escalateKeywords = normalizeKeywords(settings.escalateKeywords);
  settings.allowedRequesters = normalizeKeywords(settings.allowedRequesters);
  return settings;
}

export function setSettings(patch = {}) {
  const store = load();
  const next = { ...DEFAULT_SETTINGS, ...(store.settings || {}), ...patch };
  // 关键词面板上是一行文本，允许传数组或逗号/换行分隔的串，这里统一成去重数组
  next.escalateKeywords = normalizeKeywords(next.escalateKeywords);
  next.allowedRequesters = normalizeKeywords(next.allowedRequesters);
  store.settings = next;
  persist();
  return store.settings;
}

/** 关键词归一化：数组或「逗号 / 顿号 / 换行」分隔的串 → 去空去重数组 */
export function normalizeKeywords(input) {
  const list = Array.isArray(input)
    ? input
    : String(input || "").split(/[,，、\n]/);
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const word = String(raw || "").trim();
    if (!word || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  return out;
}

function titleOf(content) {
  const firstLine = String(content || "").trim().split("\n")[0] || "";
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine || "(空消息)";
}

/**
 * 依据飞书 Thread 话题 root_id / parent_id 查找归属任务（无论当前处于何种状态）。
 * 同一话题（Thread）内聊的所有消息，永远归属于最初创建该话题的需求任务。
 */
export function findTaskByThread({ rootId, parentId }) {
  if (!rootId && !parentId) return null;
  const store = load();
  return (
    store.tasks.find(
      (t) =>
        t.messageId &&
        (t.messageId === rootId || t.messageId === parentId),
    ) || null
  );
}

/**
 * 优先根据飞书 Thread 话题父级 ID（root_id / parent_id）精确查找 awaiting 任务，
 * 若未带 parent_id 或非 Thread 消息，降级按 sender_id + chat_id 匹配。
 */
export function findAwaitingByMessageOrThread({ rootId, parentId, senderId, chatId }) {
  const store = load();
  if (rootId || parentId) {
    const threadMatched = store.tasks.find(
      (t) =>
        t.status === "awaiting" &&
        t.messageId &&
        (t.messageId === rootId || t.messageId === parentId),
    );
    if (threadMatched) return threadMatched;
  }
  return findAwaitingBySender(senderId, chatId);
}

export function addTask({
  messageId,
  chatId,
  chatType,
  senderId,
  senderName,
  title,
  content,
  createdAt,
  status = "inbox",
  source = "feishu",
  repoPath = "",
  workpackDir = "",
  branchName = "",
  attachments = [],
  lastRunConfig = null,
  autoDispatched = false,
}) {
  const now = Date.now();
  const store = load();
  const task = {
    id: crypto.randomUUID(),
    // 给提出人看的短号：他在飞书里用 /u 7 指认要补充哪一条
    seq: store.nextSeq++,
    source,
    messageId: messageId || "",
    chatId: chatId || "",
    chatType: chatType || "",
    requester: { id: senderId || "", name: senderName || "" },
    title: title ? String(title).trim() : titleOf(content),
    content: String(content || ""),
    repoPath: repoPath || "",
    // req-to-plan 备好的工作包目录（context.md / requirement.md / assets / skill.md）。
    // 非空 = 这条不是 IM 提问而是需求池工作包，runner 会 --add-dir 放行它并注入 skill.md
    workpackDir: workpackDir || "",
    branchName: branchName || "",
    attachments: Array.isArray(attachments) ? attachments : [],
    modifiedFiles: [],
    lastRunConfig: lastRunConfig || null,
    autoDispatched: Boolean(autoDispatched),
    // 本轮 AI 还在跑时又收到的新指令：只记标记，等这轮结束合并进下一轮
    pendingFollowup: false,
    note: "",
    status,
    selected: false,
    createdAt: createdAt || now,
    updatedAt: now,
    // 反问往返记录：{ role: "them" | "me", text, at }
    thread: [{ role: "them", text: String(content || ""), at: createdAt || now }],
  };
  store.tasks.unshift(task);
  persist();
  return task;
}

export function updateTask(id, patch = {}) {
  const task = getTask(id);
  if (!task) return null;
  // 白名单，避免渲染层误传把 id / messageId 覆盖掉
  for (const key of [
    "status",
    "selected",
    "note",
    "title",
    "thread",
    "askedAt",
    "repoPath",
    "workpackDir",
    "branchName",
    "attachments",
    "modifiedFiles",
    "lastRunConfig",
    "autoDispatched",
    "pendingFollowup",
    "agentSession",
    "worktreePath",
    "worktreeBase",
  ]) {
    if (key in patch) task[key] = patch[key];
  }
  if (patch.requesterName !== undefined) {
    task.requester = { ...task.requester, name: patch.requesterName };
  }
  task.updatedAt = Date.now();
  persist();
  return task;
}

export function appendThread(id, entry) {
  const task = getTask(id);
  if (!task) return null;
  task.thread.push({ ...entry, at: entry.at || Date.now() });
  task.updatedAt = Date.now();
  persist();
  return task;
}

/** 删除某条追问/反问记录（从下标 1 开始） */
export function deleteThreadEntry(id, threadIndex) {
  const task = getTask(id);
  if (!task || !Array.isArray(task.thread)) return null;
  if (threadIndex >= 0 && threadIndex < task.thread.length) {
    task.thread.splice(threadIndex, 1);
    task.updatedAt = Date.now();
    persist();
  }
  return task;
}

/** 清空除首条原始需求外的所有后续追问与沟通记录 */
export function clearThread(id) {
  const task = getTask(id);
  if (!task || !Array.isArray(task.thread)) return null;
  task.thread = task.thread.slice(0, 1);
  task.updatedAt = Date.now();
  persist();
  return task;
}

export function deleteTask(id) {
  const store = load();
  const before = store.tasks.length;
  store.tasks = store.tasks.filter((t) => t.id !== id);
  if (store.tasks.length !== before) {
    tombstones.add(id);
    persist();
  }
  return store.tasks.length !== before;
}

/** 批量删除。一次写盘，不要循环调 deleteTask */
export function deleteTasks(ids = []) {
  const store = load();
  const target = new Set(ids);
  const before = store.tasks.length;
  store.tasks = store.tasks.filter((t) => !target.has(t.id));
  const removed = before - store.tasks.length;
  if (removed) {
    for (const id of target) tombstones.add(id);
    persist();
  }
  return removed;
}

/** 供测试重置内存缓存 */
export function __resetCache() {
  cache = null;
  filePath = null;
  lastMtime = 0;
  tombstones.clear();
}
