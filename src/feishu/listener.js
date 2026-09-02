// 飞书消息监听器。
//
// 常驻一个 `lark-cli event consume im.message.receive_v1` 子进程，它把事件以
// NDJSON（一行一个 JSON）流到 stdout。这里逐行解析后分两路：
//   - 该发起人有一条「已反问、等回复」的任务 → 当作回答挂回那条任务
//   - 否则 → 新建一条 inbox 任务
// 两路都会广播给渲染层实时刷新。
//
// 子进程意外退出会自动退避重连（网络抖动 / 事件总线 daemon 重启都会触发）。

import readline from "node:readline";
import {
  spawnLark,
  fetchUserName,
  isOwnMessage,
  sendMessage,
  downloadMessageResource,
} from "./lark-cli.js";
import { buildAckCard } from "./cards.js";
import { sendToAllWindows } from "../ui-channel.js";
import { enqueueJob, hasActiveJobForTask, setJobSettledHook } from "./runner.js";
import { pickSmartRepo } from "./repo-matcher.js";
import { getConfig } from "../config/store.js";
import {
  addTask,
  appendThread,
  findAwaitingBySender,
  findByMessageId,
  findBySenderSeq,
  findRecentBySender,
  findTaskByThread,
  getAttachmentsDir,
  getSettings,
  getTask,
  isMessageProcessed,
  listOpenTasksBySender,
  markMessageProcessed,
  updateTask,
} from "./task-store.js";

const EVENT_KEY = "im.message.receive_v1";

// 同一人连发的多条消息（"帮我对接个接口" → "/api/xxx" → "参数看图"）并成一条任务
const MERGE_WINDOW_MS = 5 * 60 * 1000;

// /u 不带短号时往「最近一条」上挂的时间上限。不设上限的话，
// 一句「/u 那个再看看」能挂到三个月前的旧任务上去
const LOOSE_MERGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// 事件流断开后的重连退避
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 60000;

// 回给提出人的任务列表里用的状态措辞（面板上的措辞是另一套，不共用）
const STATUS_TEXT = {
  inbox: "待处理",
  unfiled: "未识别",
  awaiting: "等你回复",
  doing: "进行中",
};

/** /u 后面可能带短号：「7 内容」「#7 内容」。不带则返回 seq=null */
function parseSeq(body) {
  const text = String(body || "").trim();
  const m =
    text.match(/^#\s*(\d+)\s*([\s\S]*)$/) ||
    text.match(/^(\d+)(?:\s+([\s\S]+))?$/);
  if (!m) return { seq: null, rest: text };
  return { seq: Number(m[1]), rest: (m[2] || "").trim() };
}

function renderTaskList(tasks) {
  if (!tasks.length) {
    return "你还没提过需求或排查咨询。用 /r 开头发给我就行，例如：\n/r 帮看下订单超时的处理逻辑\n/r 帮忙对接下批量打标签接口 /api/user/tags/batch";
  }
  const lines = tasks.map(
    (t) => `#${t.seq} ${t.title} · ${STATUS_TEXT[t.status] || t.status}`,
  );
  return [
    "你提过的需求与排查咨询：",
    ...lines,
    "",
    "补充内容发：/u 编号 你要补充的话",
  ].join("\n");
}

function titleOf(content) {
  const firstLine = String(content || "").trim().split("\n")[0] || "";
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine || "(空消息)";
}

/**
 * 指令解析。约定就三条，好记：
 *   /r <内容>       新建一条需求或逻辑排查咨询
 *   /u              列出我提过的任务和短号
 *   /u 7 <补充>     追加到 #7
 *   /u <补充>       没给短号就追加到最近一条
 *   /h              看用法说明
 * 没带指令的不当需求处理，但也不丢——记成 unfiled 由面板决定。
 */
function parseCommand(text) {
  const m = String(text || "").match(
    /^\s*\/(r|req|u|upd|h|help)\b[\s:：]*([\s\S]*)$/i,
  );
  if (!m) return { cmd: null, body: String(text || "").trim() };
  const raw = m[1].toLowerCase();
  const cmd =
    raw === "r" || raw === "req" ? "r" : raw === "h" || raw === "help" ? "h" : "u";
  return { cmd, body: (m[2] || "").trim() };
}

/** /h 回过去的用法说明 */
function renderHelp() {
  return [
    "项目对接与答疑助手用法：",
    "",
    "/r 需求或排查内容   提需求或咨询项目代码逻辑，自动入列并回执短号",
    "/u                 查看你提过的需求与咨询列表及短号",
    "/u 7 补充内容      给 #7 补充说明",
    "/h                 查看本说明",
    "",
    "示例：",
    "• 逻辑排查：/r 帮看下订单状态超时在前端哪里处理的",
    "• 需求开发：/r 对接批量打标签接口 /api/user/tags/batch",
    "",
    "提示：不带 /r 的消息也会留底并在待处理中展示。",
  ].join("\n");
}

let child = null;
let stopping = false;
let retryTimer = null;
let retryCount = 0;
let lastError = "";

export function getListenerStatus() {
  return {
    running: Boolean(child) && !stopping,
    retrying: Boolean(retryTimer),
    lastError,
  };
}

function broadcastStatus() {
  sendToAllWindows("docking-status", getListenerStatus());
}

function broadcastTask(type, task) {
  sendToAllWindows("docking-task", { type, task });
}

// open_id → 显示名。每来一条需求都 spawn 一次 lark-cli 去查同一个人太浪费
const nameCache = new Map();

/** 事件里只有 sender_id，显示名异步补——补到了再广播一次，不阻塞任务落库。 */
async function hydrateRequesterName(task) {
  if (task.requester?.name) return;
  const openId = task.requester?.id;
  if (!openId) return;
  let name = nameCache.get(openId);
  if (name === undefined) {
    name = await fetchUserName(openId);
    if (name) nameCache.set(openId, name);
  }
  if (!name) return;
  const updated = updateTask(task.id, { requesterName: name });
  if (updated) broadcastTask("updated", updated);
}

/**
 * 群里 @机器人 提需求时，content 会以 "@机器人名 " 开头（事件给的是渲染好的可读文本），
 * 原样进任务标题很脏。只剥开头的 @，正文里 @别人 的保留——那通常是需求的一部分。
 */
function stripLeadingMentions(content, mentions = []) {
  let text = String(content || "").trimStart();
  const names = mentions
    .map((m) => String(m?.name || "").trim())
    .filter(Boolean);
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of names) {
      const token = `@${name}`;
      if (text.startsWith(token)) {
        text = text.slice(token.length).trimStart();
        changed = true;
      }
    }
  }
  return text.trim() || String(content || "").trim();
}

async function ack(task, fallbackText) {
  if (!getSettings().ackEnabled) return;
  const res = await sendMessage({
    chatId: task.chatId,
    openId: task.requester?.id,
    card: buildAckCard({ task }),
    text: fallbackText || `✅ 已记录 #${task.seq}：${task.title}`,
    replyMessageId: task.messageId,
  });
  if (!res.ok) console.error("[docking] 回执发送失败", res.error);
}

/**
 * 回一条消息给发消息的人。
 *
 * ackEnabled 管的是「自动回执」——收到需求自动回「已记录 #7」这类主动播报。
 * /h、/u 这种是对方明确发指令要的回应，关了回执也得答，否则他只会觉得机器人挂了。
 */
async function replyText(evt, text, { force = false } = {}) {
  if (!force && !getSettings().ackEnabled) return;
  const res = await sendMessage({
    chatId: evt.chat_id,
    openId: evt.sender_id,
    text,
    replyMessageId: evt.message_id || evt.id,
  });
  if (!res.ok) console.error("[docking] 发送失败", res.error);
}

/** 把提出人自己的任务列表回给他 */
function replyList(evt, prefix = "") {
  const text = renderTaskList(listOpenTasksBySender(evt.sender_id));
  // 他自己发 /u 要的，属于「问必答」，不受自动回执开关约束
  return replyText(evt, prefix ? `${prefix}\n\n${text}` : text, { force: true });
}

/**
 * 提取消息体中的图片或文件等资源元数据。
 */
export function extractMessageResources(evt) {
  if (!evt) return [];
  const rawContent = evt.content;
  const msgType = evt.msg_type || evt.message_type || "text";
  const resources = [];

  let parsed = null;
  if (typeof rawContent === "object" && rawContent !== null) {
    parsed = rawContent;
  } else if (typeof rawContent === "string") {
    const trimmed = rawContent.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        parsed = JSON.parse(trimmed);
      } catch (_) {}
    }
  }

  if (msgType === "image") {
    const key = parsed?.image_key || evt.image_key;
    if (key) resources.push({ type: "image", key, name: `${key}.png` });
  } else if (msgType === "file") {
    const key = parsed?.file_key || evt.file_key;
    const name = parsed?.file_name || "file.bin";
    if (key) resources.push({ type: "file", key, name });
  } else if (parsed) {
    const postObj =
      parsed.zh_cn ||
      parsed.en_us ||
      parsed.ja_jp ||
      (Array.isArray(parsed.content) ? parsed : null);
    if (postObj && Array.isArray(postObj.content)) {
      for (const paragraph of postObj.content) {
        if (!Array.isArray(paragraph)) continue;
        for (const el of paragraph) {
          if (el && typeof el === "object") {
            if (el.tag === "img" && el.image_key) {
              resources.push({
                type: "image",
                key: el.image_key,
                name: `${el.image_key}.png`,
              });
            } else if (el.tag === "media" && el.file_key) {
              resources.push({
                type: "file",
                key: el.file_key,
                name: el.file_name || `${el.file_key}.bin`,
              });
            }
          }
        }
      }
    }
  }

  return resources;
}

/**
 * 异步下载消息里的附件并挂回任务。
 */
async function downloadAndAttachResources(task, rawResources, messageId) {
  // 附件要从「带着它的那条消息」上下载，目录也按那条消息分。
  // 全塞进任务首条消息的目录里，两次发同名文件（都叫「接口文档.xlsx」）
  // 会被下载层的「已存在就复用」命中，第二份直接读到第一份的内容
  const srcMessageId = messageId || task?.messageId;
  if (!task || !srcMessageId || !rawResources || rawResources.length === 0) return;
  const outputDir = getAttachmentsDir(srcMessageId);
  const downloaded = [];

  for (const res of rawResources) {
    try {
      const result = await downloadMessageResource({
        messageId: srcMessageId,
        fileKey: res.key,
        type: res.type,
        outputDir,
        fileName: res.name,
      });
      if (result.ok) {
        downloaded.push({
          type: res.type,
          name: res.name,
          key: res.key,
          path: result.path,
          size: result.size || 0,
        });
      }
    } catch (err) {
      console.error("[docking] 下载附件失败", res.key, err);
    }
  }

  if (downloaded.length > 0) {
    // 下载是异步的，期间任务可能已被别处改过，merge 的底要重新取
    const latest = getTask(task.id) || task;
    const existing = latest.attachments || [];
    const merged = [...existing];
    for (const d of downloaded) {
      if (!merged.some((m) => m.key === d.key)) {
        merged.push(d);
      }
    }
    const updated = updateTask(task.id, { attachments: merged });
    if (updated) broadcastTask("updated", updated);
  }
}

/**
 * 飞书消息内容提取与富文本平铺。
 * 支持纯文本、post 富文本、图片/文件等占位。
 */
export function parseMessageContent(evt) {
  if (!evt) return "";
  const rawContent = evt.content;
  const msgType = evt.msg_type || evt.message_type || "text";

  if (msgType === "image") return "[图片]";
  if (msgType === "audio") return "[语音]";
  if (msgType === "media") return "[视频]";
  if (msgType === "file") {
    try {
      const obj =
        typeof rawContent === "string" ? JSON.parse(rawContent) : rawContent;
      return obj?.file_name ? `[文件: ${obj.file_name}]` : "[文件]";
    } catch {
      return "[文件]";
    }
  }

  // 尝试把 content 解析为 JSON 对象
  let parsed = null;
  if (typeof rawContent === "object" && rawContent !== null) {
    parsed = rawContent;
  } else if (typeof rawContent === "string") {
    const trimmed = rawContent.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        parsed = null;
      }
    }
  }

  if (parsed) {
    // 1. 纯文本包装 {"text": "..."}
    if (typeof parsed.text === "string" && !parsed.content && !parsed.zh_cn) {
      return parsed.text;
    }

    // 2. post 富文本：可能是 { zh_cn: { title, content } } 或 { title, content }
    const postObj =
      parsed.zh_cn ||
      parsed.en_us ||
      parsed.ja_jp ||
      (Array.isArray(parsed.content) ? parsed : null);
    if (postObj && (postObj.title !== undefined || Array.isArray(postObj.content))) {
      const parts = [];
      if (postObj.title && String(postObj.title).trim()) {
        parts.push(String(postObj.title).trim());
      }
      if (Array.isArray(postObj.content)) {
        for (const paragraph of postObj.content) {
          if (!Array.isArray(paragraph)) continue;
          const pText = paragraph
            .map((el) => {
              if (!el || typeof el !== "object") return "";
              const tag = el.tag || "text";
              if (tag === "text") return el.text || "";
              if (tag === "a") {
                const label = el.text || el.href || "";
                return el.href ? `[${label}](${el.href})` : label;
              }
              if (tag === "at") return `@${el.user_name || el.text || "用户"}`;
              if (tag === "img") return "[图片]";
              if (tag === "media") return "[视频]";
              if (tag === "code_block") return `\n\`\`\`\n${el.text || ""}\n\`\`\`\n`;
              return el.text || "";
            })
            .join("");
          if (pText.trim()) parts.push(pText.trim());
        }
      }
      if (parts.length) return parts.join("\n");
    }
  }

  return typeof rawContent === "string" ? rawContent : String(rawContent || "");
}

let electronModule = null;
async function getElectron() {
  if (!electronModule) {
    try {
      electronModule = await import("electron");
    } catch {
      electronModule = null;
    }
  }
  return electronModule;
}

export async function showDesktopNotification({ title, body }) {
  try {
    const electron = await getElectron();
    const NotificationClass = electron?.Notification;
    if (NotificationClass && typeof NotificationClass.isSupported === "function" && NotificationClass.isSupported()) {
      const notif = new NotificationClass({
        title,
        body: body ? String(body).slice(0, 200) : "",
        silent: false,
      });
      notif.on("click", () => {
        const windows = electron?.BrowserWindow?.getAllWindows?.() || [];
        if (windows.length > 0) {
          const win = windows[0];
          if (win.isMinimized?.()) win.restore?.();
          win.focus?.();
        }
      });
      notif.show();
    }
  } catch (err) {
    console.error("[docking] 发送桌面通知失败", err);
  }
}

/**
 * 白名单校验。allowedRequesters 为空 = 不限制（保持老行为）；
 * 一旦配了人，就只有名单里的 open_id 能触发本机自动执行——
 * 自动派发在 edit/full 档下等于「一条飞书消息可以直接改这台机器上的代码」。
 */
function isAutoDispatchAllowed(senderId) {
  const list = getSettings().allowedRequesters || [];
  if (!list.length) return true;
  return Boolean(senderId) && list.includes(senderId);
}

/**
 * 决定这一轮用哪个力度档。
 *
 * 默认「人在面板上选的是什么就是什么」——一条飞书消息不该有权把只读档
 * 悄悄顶成可改代码。只有显式打开 autoEscalateMode，命中自定义关键词时
 * 才允许 analyze → edit，且只升这一级，永远升不到 full。
 */
export function resolveRunMode(baseMode, text, settings = getSettings()) {
  const mode = baseMode || settings.autoDispatchMode || "analyze";
  if (mode !== "analyze" || !settings.autoEscalateMode) return mode;
  const keywords = settings.escalateKeywords || [];
  if (!keywords.length) return mode;
  const body = String(text || "");
  return keywords.some((k) => k && body.includes(k)) ? "edit" : mode;
}

/**
 * 交给 AI 跑一轮，失败就把状态放回去。
 *
 * enqueueJob 在没有 cwd、任务已被删时会抛错。以前这里只 console.error，
 * 而任务早就被置成 doing 了——队列里什么都没有，面板显示「进行中」，
 * 飞书那头也永远等不到回音。
 */
function dispatchToAI({ task, cwd, mode, engine, createBranch, notify }) {
  // 同一任务同时只允许一个 job：一个话题 = 一条任务，运行期间再来的指令不另起一轮，
  // 否则两个 AI 抢同一份上下文和同一个工作区。消息本身已经进了 thread，
  // buildPrompt 下一轮会自动带上，这里只记下「这轮结束后还要再跑一次」和它想用的配置。
  if (hasActiveJobForTask(task.id)) {
    const marked =
      updateTask(task.id, {
        pendingFollowup: true,
        lastRunConfig: {
          ...(task.lastRunConfig || {}),
          cwd,
          mode,
          engine,
          createBranch: Boolean(createBranch),
          branchName: task.branchName || "",
        },
      }) || task;
    broadcastTask("updated", marked);
    showDesktopNotification({
      title: `【AI 正在处理中】#${task.seq}「${task.title}」`,
      body: "新指令已记下，等这一轮跑完后合并进下一轮",
    });
    return "pending";
  }

  const updated =
    updateTask(task.id, {
      status: "doing",
      repoPath: cwd,
      pendingFollowup: false,
    }) || task;
  broadcastTask("updated", updated);
  try {
    enqueueJob({ ids: [task.id], cwd, mode, engine, createBranch });
    if (notify) showDesktopNotification(notify);
    return true;
  } catch (err) {
    console.error("[docking] 派发 AI 失败:", err);
    const rolled =
      updateTask(task.id, { status: "inbox" }) || task;
    appendThread(task.id, {
      role: "system",
      text: `自动派发失败：${err.message}，已放回待处理`,
    });
    broadcastTask("updated", rolled);
    showDesktopNotification({
      title: `【派发失败】#${task.seq}「${task.title}」`,
      body: `${err.message}，已放回待处理`,
    });
    return false;
  }
}

const ENGINE_LABEL = { agy: "Antigravity", claude: "Claude Code", codex: "Codex" };
const MODE_LABEL = { analyze: "只读分析", edit: "允许改代码", full: "全自动" };

/**
 * 一轮 job 收尾后的回调：把运行期间攒下的追问合并成下一轮。
 *
 * 这里不再重新过一遍 autoDispatchEnabled / autoResumeOnClarification —— 那些开关
 * 在指令到达时（handleThreadReply / handleClarificationReply）已经判过了，
 * 判过才会走到 dispatchToAI 打上 pendingFollowup。这里只挡两种不该续跑的情况：
 * 本轮没跑成（异常/中断，接着跑多半还是失败）、发起人不在白名单。
 *
 * 不看 task.status：AI 用 ask_requester 反问时 job 往往还在跑，对方秒回就会落成
 * pendingFollowup——标记存在本身就说明「答复已经到了」，awaiting 不该再挡这一轮。
 */
function handleJobSettled({ taskIds = [], status = "" } = {}) {
  for (const id of taskIds) {
    const task = getTask(id);
    if (!task?.pendingFollowup) continue;

    const cleared = updateTask(id, { pendingFollowup: false }) || task;
    const cfg = cleared.lastRunConfig || {};
    const targetCwd = cleared.repoPath || cfg.cwd;
    const canResume =
      status === "done" &&
      Boolean(targetCwd) &&
      isAutoDispatchAllowed(cleared.requester?.id);

    if (!canResume) {
      broadcastTask("updated", cleared);
      showDesktopNotification({
        title: `【有未处理的新指令】#${cleared.seq}「${cleared.title}」`,
        body: "上一轮已结束，运行期间收到的指令需要手动派一次",
      });
      continue;
    }

    const engine = cfg.engine || getSettings().autoDispatchEngine || "claude";
    dispatchToAI({
      task: cleared,
      cwd: targetCwd,
      mode: cfg.mode || "analyze",
      engine,
      createBranch: Boolean(cfg.createBranch) || Boolean(cleared.branchName),
      notify: {
        title: `【AI 继续下一轮】#${cleared.seq}「${cleared.title}」`,
        body: `已合并运行期间收到的新指令，自动唤醒 ${
          ENGINE_LABEL[engine] || engine
        } 接着跑`,
      },
    });
  }
}

setJobSettledHook(handleJobSettled);

export function handleClarificationReply(task, text, createdAt, resources = [], messageId = "") {
  appendThread(task.id, { role: "them", text, at: createdAt });
  if (resources.length > 0) {
    downloadAndAttachResources(task, resources, messageId);
  }

  const settings = getSettings();
  const cfg = task.lastRunConfig || {};
  const targetCwd = task.repoPath || cfg.cwd;
  const canAutoResume =
    settings.autoResumeOnClarification !== false &&
    Boolean(targetCwd) &&
    isAutoDispatchAllowed(task.requester?.id);

  if (canAutoResume) {
    const targetMode = resolveRunMode(cfg.mode, text, settings);
    const targetEngine = cfg.engine || settings.autoDispatchEngine || "claude";
    // 第一轮切过隔离分支的，第二轮得回到同一条分支上接着改，
    // 否则前后两轮的改动会散在两个分支里
    const targetBranch = Boolean(cfg.createBranch || task.branchName);

    const ok = dispatchToAI({
      task,
      cwd: targetCwd,
      mode: targetMode,
      engine: targetEngine,
      createBranch: targetBranch,
      notify: {
        title: `【自动恢复 AI 会话】#${task.seq} ${task.requester?.name || "提出人"} 已回复`,
        body: `答复：「${text}」\n已自动唤醒 ${
          ENGINE_LABEL[targetEngine] || targetEngine
        } 继续处理`,
      },
    });
    if (ok) {
      broadcastTask("replied", getTask(task.id) || task);
      return;
    }
    return;
  }

  const updated = updateTask(task.id, { status: "inbox" }) || task;
  broadcastTask("replied", updated);

  showDesktopNotification({
    title: `【飞书回复】${task.requester?.name || "提出人"} 回复了反问`,
    body: `#${task.seq}「${task.title}」: ${text}`,
  });
}

/**
 * 飞书 Thread 话题内追问 / 答复统一处理。
 * 核心原则：在同一个话题/Thread 下聊的任何消息，永远归属于最初创建该话题的需求任务。
 */
export function handleThreadReply(task, text, createdAt, resources = [], messageId = "") {
  const settings = getSettings();

  // 1. 如果当前任务正处于反问等回复状态 (awaiting)
  if (task.status === "awaiting") {
    handleClarificationReply(task, text, createdAt, resources, messageId);
    return;
  }

  // 2. 将消息挂入该话题的 thread 记录
  appendThread(task.id, { role: "them", text, at: createdAt });
  if (resources.length > 0) {
    downloadAndAttachResources(task, resources, messageId);
  }

  const wasFinished = task.status === "done" || task.status === "ignored";

  // 3. 是否自动唤醒 AI 继续执行。
  //
  //    这里只认 autoDispatchEnabled 一个开关。autoResumeOnClarification 管的是
  //    「我反问了、对方答了，接着往下跑」，语义上和「话题里随口回一句」完全是两回事；
  //    以前两个开关用 || 短路成一个，结果没开自动派发的人，被对方一句「好的」
  //    也会拉起一次 AI。
  //
  //    已完成/已忽略的任务也不自动跑：完成通知本身就是发在这个话题里的，
  //    对方回一句「收到」就重开一轮，一来一回能自己转起来。
  const canAutoDispatch =
    settings.autoDispatchEnabled &&
    !wasFinished &&
    isAutoDispatchAllowed(task.requester?.id);

  let willRun = false;
  if (canAutoDispatch) {
    let config = {};
    try {
      config = typeof getConfig === "function" ? (getConfig() || {}) : {};
    } catch (_) {}
    const repos = config.frontendProjectGroups || [];

    const cfg = task.lastRunConfig || {};
    let targetCwd = task.repoPath || cfg.cwd;
    if (!targetCwd || targetCwd === "auto") {
      if (settings.autoDispatchCwd && settings.autoDispatchCwd !== "auto") {
        targetCwd = settings.autoDispatchCwd;
      } else {
        targetCwd = pickSmartRepo(
          [{ title: task.title, content: `${task.content}\n${text}` }],
          repos,
          settings.lastCwd,
        );
      }
    }

    const targetMode = resolveRunMode(cfg.mode, text, settings);
    const targetEngine = cfg.engine || settings.autoDispatchEngine || "claude";
    const targetBranch = Boolean(
      cfg.createBranch ?? settings.autoDispatchCreateBranch ?? true,
    ) || Boolean(task.branchName);

    if (targetCwd) {
      willRun = dispatchToAI({
        task,
        cwd: targetCwd,
        mode: targetMode,
        engine: targetEngine,
        createBranch: targetBranch,
        notify: {
          title: `【AI 自动继续处理】#${task.seq} ${task.requester?.name || "提出人"} 发来新指令`,
          body: `指令：「${text}」\n已自动唤醒 ${
            ENGINE_LABEL[targetEngine] || targetEngine
          }（${MODE_LABEL[targetMode] || targetMode}）继续执行`,
        },
      });
    }
  }

  if (!willRun) {
    const patch = wasFinished ? { status: "inbox" } : {};
    const updated = updateTask(task.id, patch) || task;
    broadcastTask("updated", updated);

    showDesktopNotification({
      title: `【话题新消息】#${task.seq}「${task.title}」`,
      body: `${task.requester?.name || "对方"}：「${text}」`,
    });
  }
}

function handleEvent(evt) {
  if (!evt || evt.type !== EVENT_KEY) return;
  // 机器人自己发的消息（含我们的反问和回执）会回流，必须忽略，否则自问自答成环。
  // sender_type 是第一道；再用「我们自己刚发出去的 message_id」兜一道——
  // 完成通知是带 --reply-in-thread 发回话题里的，一旦漏判就会被当成对方的新指令。
  if (evt.sender_type === "bot") return;

  const messageId = evt.message_id || evt.id;
  if (isOwnMessage(messageId)) return;
  if (findByMessageId(messageId)) return; // 事件总线重推，幂等丢弃
  // findByMessageId 只挡得住「建过任务」的那条首条消息。话题追问、澄清回复
  // 从来没被记过，重推一次就会重复入库并重复派活，所以另存一份处理过的 id
  if (isMessageProcessed(messageId)) return;
  markMessageProcessed(messageId);

  const createdAt = Number(evt.create_time) || Date.now();
  const rawText = parseMessageContent(evt);
  const rawResources = extractMessageResources(evt);
  const raw = stripLeadingMentions(rawText, evt.mentions);
  const { cmd, body } = parseCommand(raw);

  // ① 飞书 Thread 话题消息（带 root_id 或 parent_id）—— 优先以【话题】为唯一归属依据！
  // 在同一个话题/Thread 下聊的任何消息，永远归属于最初创建该话题的需求任务。
  const threadTask = findTaskByThread({
    rootId: evt.root_id,
    parentId: evt.parent_id,
  });

  if (threadTask) {
    handleThreadReply(
      threadTask,
      cmd === "r" || cmd === "u" ? body : raw,
      createdAt,
      rawResources,
      messageId,
    );
    return;
  }

  // ② 我反问过、正等这个人回话（非 Thread 话题的私聊消息）
  const awaiting = findAwaitingBySender(evt.sender_id, evt.chat_id);
  if (awaiting && !cmd) {
    handleClarificationReply(awaiting, body, createdAt, rawResources, messageId);
    return;
  }

  // ② /h：回用法说明。放在 awaiting 之后——他正被反问时问用法，也该给说明
  if (cmd === "h") {
    replyText(evt, renderHelp(), { force: true });
    return;
  }

  // ③ /u：光秃秃一个 /u 就把他自己的任务列表回过去，让他挑
  let explicitTarget = null;
  let uBody = body;
  if (cmd === "u") {
    const { seq, rest } = parseSeq(body);
    if (!body) {
      replyList(evt);
      return;
    }
    if (seq && !rest) {
      replyList(evt, `#${seq} 后面要写补充内容，例如：/u ${seq} 参数改成 pageNum`);
      return;
    }
    if (seq) {
      const target = findBySenderSeq(evt.sender_id, seq);
      if (target) {
        explicitTarget = target;
        uBody = rest;
      }
      // 找不到该短号（写错了 / 是别人的 / 已完成）就别乱挂，回列表让他重挑
      else {
        replyList(evt, `没找到 #${seq}，可能已完成或不是你提的。`);
        return;
      }
    }
  }

  // ④ /u 落到具体任务，或 ⑤ 合并窗口内的连发消息 —— 都并入既有任务
  const mergeTarget =
    cmd === "u"
      ? // 用 /u 回答我的反问也要挂回那条，awaiting 优先
        explicitTarget ||
        awaiting ||
        findRecentBySender(evt.sender_id, LOOSE_MERGE_WINDOW_MS, evt.chat_id)
      : cmd === null
        ? findRecentBySender(evt.sender_id, MERGE_WINDOW_MS, evt.chat_id)
        : null;

  if (mergeTarget) {
    if (mergeTarget.status === "awaiting") {
      handleClarificationReply(
        mergeTarget,
        cmd === "u" ? uBody : body,
        createdAt,
        rawResources,
        messageId,
      );
      if (cmd === "u") ack(mergeTarget, `➕ 已补充到 #${mergeTarget.seq}「${mergeTarget.title}」`);
      return;
    }

    appendThread(mergeTarget.id, {
      role: "them",
      text: cmd === "u" ? uBody : body,
      at: createdAt,
    });
    // 连发补充能把一条闲聊「扶正」成需求：它显然是在说同一件事。
    // 顺手把标题换成这条真正说事的消息，否则任务会一直叫「在吗」。
    const patch =
      mergeTarget.status === "unfiled"
        ? { status: "inbox", title: titleOf(cmd === "u" ? uBody : body) }
        : {};
    const updated = updateTask(mergeTarget.id, patch) || mergeTarget;
    broadcastTask("updated", updated);
    if (rawResources.length > 0) {
      downloadAndAttachResources(updated, rawResources, messageId);
    }
    if (cmd === "u") ack(updated, `➕ 已补充到 #${updated.seq}「${updated.title}」`);
    return;
  }

  // ⑥ /r 建需求；没指令的记成 unfiled，面板上可一键转正
  const settings = getSettings();
  let targetCwd = "";
  let willAutoDispatch = false;

  if (
    cmd === "r" &&
    settings.autoDispatchEnabled &&
    isAutoDispatchAllowed(evt.sender_id)
  ) {
    let config = {};
    try {
      config = typeof getConfig === "function" ? (getConfig() || {}) : {};
    } catch (_) {}
    const repos = config.frontendProjectGroups || [];
    if (settings.autoDispatchCwd && settings.autoDispatchCwd !== "auto") {
      targetCwd = settings.autoDispatchCwd;
    } else {
      targetCwd = pickSmartRepo(
        [{ title: titleOf(body), content: body }],
        repos,
        settings.lastCwd,
      );
    }
    if (targetCwd) {
      willAutoDispatch = true;
    }
  }

  const task = addTask({
    messageId,
    chatId: evt.chat_id,
    chatType: evt.chat_type,
    senderId: evt.sender_id,
    senderName: "",
    content: body,
    createdAt,
    status: willAutoDispatch ? "doing" : cmd === "r" ? "inbox" : "unfiled",
    repoPath: targetCwd || "",
    autoDispatched: willAutoDispatch,
  });

  broadcastTask("created", task);
  hydrateRequesterName(task);

  if (rawResources.length > 0) {
    downloadAndAttachResources(task, rawResources, messageId);
  }

  // 回执带上短号，他之后 /u 7 就能精确补充，多数时候不用查列表
  if (cmd === "r") {
    if (willAutoDispatch) {
      const mode = settings.autoDispatchMode || "analyze";
      const engine = settings.autoDispatchEngine || "claude";
      const ok = dispatchToAI({
        task,
        cwd: targetCwd,
        mode,
        engine,
        createBranch: settings.autoDispatchCreateBranch ?? true,
        notify: {
          title: `【自动派发 AI】收到 #${task.seq}「${task.title}」`,
          body: `已自动进入 ${ENGINE_LABEL[engine] || engine} 队列 · 📁 ${targetCwd
            .split(/[\\/]/)
            .pop()}`,
        },
      });

      if (ok && settings.ackEnabled) {
        sendMessage({
          chatId: task.chatId,
          openId: task.requester?.id,
          card: buildAckCard({ task, autoDispatching: true }),
          text: `⚡ 已自动启动 AI 排查 #${task.seq}「${task.title}」`,
          replyMessageId: task.messageId,
        });
      } else if (!ok) {
        // 派发失败时 dispatchToAI 已经把状态放回 inbox，这里补一条普通回执，
        // 别让提出人以为「已经在跑了」
        ack(task, `✅ 已记录 #${task.seq}：${task.title}`);
      }
    } else {
      ack(task, `✅ 已记录 #${task.seq}：${task.title}`);
      showDesktopNotification({
        title: `【飞书需求】收到 #${task.seq}「${task.title}」`,
        body: body,
      });
    }
  }
}

function scheduleRetry() {
  if (stopping || retryTimer) return;
  const delay = Math.min(RETRY_BASE_MS * 2 ** retryCount, RETRY_MAX_MS);
  retryCount += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (!stopping) launch();
  }, delay);
  broadcastStatus();
}

function launch() {
  if (child) return;
  stopping = false;

  child = spawnLark(["event", "consume", EVENT_KEY, "--as", "bot"]);

  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== "{") return; // 跳过就绪标记之类的非 JSON 行
    try {
      handleEvent(JSON.parse(trimmed));
      // 收到过正常事件就认为连接健康：重置退避，并把上次的错误抹掉——
      // 否则面板会一直挂着一条早就恢复了的报错
      retryCount = 0;
      if (lastError) {
        lastError = "";
        broadcastStatus();
      }
    } catch (err) {
      console.error("[docking] 事件解析失败", err.message, trimmed.slice(0, 200));
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (!text) return;
    // lark-cli 把 ready / 退出标记也打到 stderr，只把明显的错误留给 UI。
    // 匹配得太宽会把 "0 errors" 这种也当成故障，所以排掉明显的正常行
    if (
      /\b(error|failed|denied|unauthorized)\b/i.test(text) &&
      !/\b(0 errors?|no error)\b/i.test(text)
    ) {
      lastError = text.slice(0, 500);
      broadcastStatus();
    }
    console.log("[docking][lark-cli]", text);
  });

  child.on("error", (err) => {
    lastError = err.message;
    child = null;
    broadcastStatus();
    scheduleRetry();
  });

  child.on("close", (code) => {
    rl.close();
    child = null;
    if (stopping) {
      broadcastStatus();
      return;
    }
    lastError = `事件流意外结束（退出码 ${code}）`;
    broadcastStatus();
    scheduleRetry();
  });

  broadcastStatus();
}

export function startListener() {
  lastError = "";
  retryCount = 0;
  launch();
  return getListenerStatus();
}

export function stopListener() {
  stopping = true;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (child) {
    child.kill("SIGTERM");
    child = null;
  }
  broadcastStatus();
  return getListenerStatus();
}
