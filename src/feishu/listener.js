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
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { REQ_BIN } from "../paths.js";
import { buildSpawnEnv } from "../shell-env.js";
import { buildWorkpackTask, findWorkpackTask } from "./workpack.js";
import { COMMANDS, renderHelp } from "./commands.js";
import {
  spawnLark,
  fetchUserName,
  isOwnMessage,
  sendMessage,
  downloadMessageResource,
  describeLarkError,
  parseLarkError,
} from "./lark-cli.js";
import { buildAckCard } from "./cards.js";
import { sendToAllWindows } from "../ui-channel.js";
import { killProcessTree } from "../kill-tree.js";
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
  getDataDir,
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
// SIGTERM 之后等这么久还没退，就对进程组补 SIGKILL
const KILL_GRACE_MS = 3000;
// lark-cli 连上事件总线后打在 stderr 的固定就绪行（lark-event 的 Subprocess contract）
const READY_MARKER = "[event] ready event_key=";
// stderr 只留够解析错误信封的尾巴，常驻进程的输出不能无限攒
const STDERR_TAIL_MAX = 8000;

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
    return [
      "你还没提过需求或排查咨询。用 /r 开头发给我就行，例如：",
      "/r 帮看下订单超时的处理逻辑",
      "/r 帮忙对接下批量打标签接口 /api/user/tags/batch",
      "",
      "需求池里已定稿、要转实施 plan 的，发 /plan 加文档链接：",
      "/plan 帮我看看有没有要改的 https://xxx.feishu.cn/wiki/xxxxx",
    ].join("\n");
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
 * 指令解析。约定四条，好记：
 *   /r <内容>       新建一条需求或逻辑排查咨询（消息正文就是需求）
 *   /plan <链接>    需求池里已定稿的需求转实施 plan（给的是文档链接，不是正文）
 *   /u              列出我提过的任务和短号
 *   /u 7 <补充>     追加到 #7
 *   /u <补充>       没给短号就追加到最近一条
 *   /h              看用法说明
 * 没带指令的不当需求处理，但也不丢——记成 unfiled 由面板决定。
 *
 * /plan 单独一条而不是从 /r 里认链接：两者输入类型不同（正文 vs 文档地址）、
 * 耗时不同（立刻入库 vs 要先拉文档下图），混在一起判会把「贴了个链接说明情况」
 * 的普通需求误当成需求池工作包。
 */
export function parseCommand(text) {
  const m = String(text || "").match(
    /^\s*\/(r|req|plan|u|upd|h|help)\b[\s:：]*([\s\S]*)$/i,
  );
  if (!m) return { cmd: null, body: String(text || "").trim() };
  const raw = m[1].toLowerCase();
  const cmd =
    raw === "r" || raw === "req"
      ? "r"
      : raw === "plan"
        ? "plan"
        : raw === "h" || raw === "help"
          ? "h"
          : "u";
  return { cmd, body: (m[2] || "").trim() };
}

// /h 的用法说明由指令表生成（见 commands.js）。re-export 是为了让调用方和测试
// 不必关心它长在哪——加指令只改 commands.js 一处。
export { renderHelp };

let child = null;
// 已经发过 SIGTERM、但还没确认退出的旧进程。它仍占着飞书那条事件订阅，
// 所以要起新进程之前必须先把它收干净（见 launch 开头）
let exiting = null;
let stopping = false;
let retryTimer = null;
let retryCount = 0;
let lastError = "";
// 当前进程确认连上了（见过就绪行或收到过事件）。running 只说明进程还活着：
// 没配置的机器上它会先活一百来毫秒再失败退出，拿 running 当「健康」页面会闪
let connected = false;

export function getListenerStatus() {
  return {
    running: Boolean(child) && !stopping,
    connected: connected && Boolean(child) && !stopping,
    // 在等退避定时器，或者这个进程本身就是失败后的重试、还没确认连上。
    // 后一种不算的话，每次重试那一下状态会闪回「监听中」
    retrying: Boolean(retryTimer) || (Boolean(child) && retryCount > 0),
    lastError,
  };
}

function broadcastStatus() {
  sendToAllWindows("docking-status", getListenerStatus());
}

/**
 * 确认连接健康（就绪标记或收到事件）：重置退避，并把上次失败留下的报错抹掉——
 * 否则面板会一直挂着一条早就恢复了的报错。
 */
function markHealthy() {
  if (connected && !retryCount && !lastError) return;
  connected = true;
  retryCount = 0;
  lastError = "";
  broadcastStatus();
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



// 备料要拉飞书文档、逐张下截图、扫一遍仓库算影响面事实，二十几张图的需求跑十几秒很正常。
// 但卡住的话不能一直挂着——lark-cli 的 token 过期有时是超时而不是报错。
const PREPARE_TIMEOUT_MS = 5 * 60 * 1000;

// 备料子进程的注入点，跟 runner.setSpawnImpl 同构：测试里换掉它就能跑通整条
// /plan 链路而不真去拉飞书文档
let prepareSpawnImpl = spawn;
export function setPrepareSpawnImpl(fn) {
  prepareSpawnImpl = fn || spawn;
}

/**
 * 工作包落 userData，不落被分析仓库。
 *
 * 落仓库里也能跑（未跟踪文件不算脏，setupGitBranch 用的是 --untracked-files=no），
 * 但那样工作包会跟着隔离分支走、会被 clean 扫掉、多个仓库还各存一份。
 */
function workpackRoot() {
  return path.join(getDataDir(), "req-workpacks");
}

/**
 * 从 /plan 的参数里挑出「要备料的那个东西」，剩下的话当成提出人的额外交代。
 *
 * 人不会只发一个光秃秃的链接，更常见的是：
 *   /plan 帮我看看 https://xxx.feishu.cn/wiki/abc
 *   /plan https://xxx.feishu.cn/wiki/abc 看看有没有什么要改的
 * 链接（或 record_id）拿去喂 req prepare，剩下的文字一个字都不能丢——
 * 那往往才是他这次真正想问的，比需求文档本身更能决定 plan 该往哪写。
 *
 * URL 的字符集特意排掉中文与中文标点：飞书里「…/wiki/abc请看下」这种没空格的贴法很常见，
 * 用 [^\s]+ 会把后面的话一起吃进链接里。
 *
 * 两者都认不出来时（例如 /plan 相似推荐），整段当需求名关键词交给 req，不拆 remark：
 * 没有锚点就没法区分「需求名」和「补充说明」，猜错不如不猜。
 */
export function parsePlanTarget(body) {
  const text = String(body || "").trim();
  const rest = (whole) => text.replace(whole, " ").replace(/\s+/g, " ").trim();

  // 1. Markdown 链接语法：[标题/链接](https://...) —— 飞书 post 富文本里的 <a> 标签会被转成这种格式
  const mdMatch = text.match(/\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/);
  if (mdMatch) {
    const url = mdMatch[1].replace(/[.,;:!?]+$/, "");
    return { target: url, remark: rest(mdMatch[0]) };
  }

  // 2. 尖括号包装：<https://...>
  const angleMatch = text.match(/<(https?:\/\/[^\s>]+)>/);
  if (angleMatch) {
    const url = angleMatch[1].replace(/[.,;:!?]+$/, "");
    return { target: url, remark: rest(angleMatch[0]) };
  }

  // 3. 引号包装："https://..." 或 'https://...'
  const quoteMatch = text.match(
    /["'\u201c\u201d](https?:\/\/[^\s"'\u201c\u201d]+)["'\u201c\u201d]/,
  );
  if (quoteMatch) {
    const url = quoteMatch[1].replace(/[.,;:!?]+$/, "");
    return { target: url, remark: rest(quoteMatch[0]) };
  }

  // 4. 普通 URL：排掉中英文标点与各类括号/引号
  const urlMatch = text.match(
    /https?:\/\/[^\s\u4e00-\u9fa5，。、？！；：“”‘’（）【】《》()[\]<>"'`]+/,
  );
  if (urlMatch) {
    const rawUrl = urlMatch[0];
    const url = rawUrl.replace(/[.,;:!?]+$/, "");
    return { target: url, remark: rest(rawUrl) };
  }

  // 5. 多维表格的 record_id：rec 开头的一串字母数字
  const rec = text.match(/\brec[A-Za-z0-9]{6,}\b/)?.[0];
  if (rec) return { target: rec, remark: rest(rec) };

  return { target: text, remark: "" };
}

/** /plan 用哪个仓库：面板固定了就用固定的，否则按关键词智能匹配（跟 /r 一套逻辑） */
function resolvePlanRepo(settings, hint) {
  if (settings.autoDispatchCwd && settings.autoDispatchCwd !== "auto") {
    return settings.autoDispatchCwd;
  }
  let config = {};
  try {
    config = typeof getConfig === "function" ? getConfig() || {} : {};
  } catch (_) {}
  return pickSmartRepo(
    [{ title: hint, content: hint }],
    config.frontendProjectGroups || [],
    settings.lastCwd,
  );
}

/**
 * 跑 req prepare 备料，拿到工作包路径。
 * 成功 { ok: true, info }，失败 { ok: false, error }——error 是能直接发给提出人的话。
 */
function runPrepare({ target, repoRoot }) {
  return new Promise((resolve) => {
    const root = workpackRoot();
    try {
      fs.mkdirSync(root, { recursive: true });
    } catch (err) {
      resolve({ ok: false, error: `创建工作包目录失败: ${err.message}` });
      return;
    }

    // 不给 --out，让 req 按 record_id 自己落到 <cwd>/.requirements/<record_id>：
    // 同一条需求重复 /plan 会落回同一个目录，天然幂等
    const args = [REQ_BIN, "prepare", target, "--json"];
    if (repoRoot) args.push("--repo", repoRoot);

    let proc;
    try {
      proc = prepareSpawnImpl(process.execPath, args, {
        cwd: root,
        // req prepare 自己还要起 lark-cli 拉文档，PATH 必须是登录 shell 那一份
        env: { ...buildSpawnEnv(), ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ ok: false, error: `启动备料进程失败: ${err.message}` });
      return;
    }

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += d;
    });
    proc.stderr.on("data", (d) => {
      stderr += d;
    });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve({
        ok: false,
        error: `备料超过 ${PREPARE_TIMEOUT_MS / 60000} 分钟未完成，已中断。常见原因是 lark-cli 的 user 授权过期（跑一次 lark-cli auth status --verify 看看）。`,
      });
    }, PREPARE_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `启动备料进程失败: ${err.message}` });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        // req 把进度和报错都写 stderr，末尾几行最有用
        // （「未在「排实施」中找到」「lark-cli 执行失败」「没有方案链接」…）
        const tail = stderr.trim().split("\n").slice(-4).join("\n");
        resolve({ ok: false, error: tail || `备料进程退出码 ${code}` });
        return;
      }
      try {
        resolve({ ok: true, info: JSON.parse(stdout) });
      } catch (err) {
        resolve({ ok: false, error: `备料结果解析失败: ${err.message}` });
      }
    });
  });
}

/**
 * /plan：需求池里已定稿的需求 → 实施 plan。
 *
 * 跟 /r 的差别在输入：/r 的正文就是需求，收到即入库；/plan 给的是一个文档地址，
 * 得先把文档拉下来、截图下下来、工作规范按当前仓库渲染好（req prepare），才有东西可派。
 * 这是秒级到十几秒的事，所以先回一条「正在备料」，别让人对着飞书干等。
 *
 * 备完料走的是跟命令行桥（scripts/req-to-docking.mjs）同一份翻译层，区别只在这条任务
 * 带着真实的飞书会话——所以 AI 中途用 ask_requester 反问，是真能发到提出人那里的。
 */
export async function handlePlanCommand(evt, body, createdAt, messageId) {
  const { target, remark } = parsePlanTarget(body);
  const settings = getSettings();
  const repoRoot = resolvePlanRepo(settings, body || target);
  if (!repoRoot) {
    // 不能放空了跑：req 会退回用 process.cwd()（也就是工作包目录）当仓库，
    // 扫出 0 个应用、渲染出一份 $REPO_FACTS 全空的 skill.md，
    // 影响面命令里的 --repo 也指向错的地方——不报错，但产出的 plan 是废的
    await replyText(
      evt,
      "❌ 还没配项目目录，/plan 不知道该扫哪个仓库算影响面。\n" +
        "请先在 vjtools 里添加前端工程，或在「预设规则」里固定一个工作目录。",
      { force: true },
    );
    return;
  }

  await replyText(evt, `⏳ 正在备料：${target}\n拉取需求文档与截图中，通常十几秒。`);

  const prepared = await runPrepare({ target, repoRoot });
  if (!prepared.ok) {
    // 失败必须说出去，不受自动回执开关约束——静默失败会让人以为还在跑
    await replyText(evt, `❌ 备料失败：\n${prepared.error}`, { force: true });
    return;
  }

  const { outDir, recordId, assetCount, standalone } = prepared.info;

  // 仓库名要报出来：给链接时 pickSmartRepo 没什么可匹配的，会落到上次用的那个，
  // 选错了得让人当场看得见
  const repoLabel = repoRoot.split(/[\\/]/).pop();

  /**
   * 备好料的工作包任务怎么往下走。
   *
   * /plan 跟 /r 只差在「备料」这一步，状态流转是同一套：先进待处理，
   * 开了「收到需求自动交给 AI」才自动派活，引擎、隔离分支也听预设规则；
   * 唯一固定的是力度档——工作包要的产出就是 plan。白名单同样生效。
   */
  const launch = async (task, summary) => {
    const stopHere = async (why) => {
      // 已完成 / 已忽略的任务带新交代回来，跟话题里追问一样放回待处理，不然人在面板上看不见它
      if (task.status === "done" || task.status === "ignored") {
        const reopened = updateTask(task.id, { status: "inbox" });
        if (reopened) broadcastTask("updated", reopened);
      }
      await replyText(evt, `${summary}\n\n${why}`);
      showDesktopNotification({
        title: `【需求池工作包】#${task.seq}「${task.title}」`,
        body: `📁 ${repoLabel}${assetCount ? ` · 截图 ${assetCount} 张` : ""}`,
      });
    };

    if (!settings.autoDispatchEnabled || !isAutoDispatchAllowed(evt.sender_id)) {
      await stopHere("材料已备好，已放进待处理，在面板上派活后开始产 plan。");
      return;
    }

    const engine = settings.autoDispatchEngine || "claude";
    const result = dispatchToAI({
      task,
      cwd: repoRoot,
      mode: "plan",
      engine,
      createBranch: settings.autoDispatchCreateBranch ?? true,
      notify: {
        title: `【产 plan】#${task.seq}「${task.title}」`,
        body: `已进入 ${ENGINE_LABEL[engine] || engine} 队列 · 📁 ${repoLabel}`,
      },
    });

    // dispatchToAI 在这条任务已经有 job 在跑时返回 "pending"：不另起一轮，
    // 只记下「这轮完了还要再跑」。措辞必须跟真开跑区分开，否则人会以为马上有结果
    if (result === "pending") {
      await replyText(
        evt,
        `${summary}\n\n⏳ 这条正在跑，你的交代记下了，等这一轮结束会接着按它再跑一轮。`,
      );
      return;
    }
    if (result) {
      await replyText(evt, `${summary}\n\n⚡ 开始产 plan，完成后我会回你。`);
      return;
    }
    // 派发失败时 dispatchToAI 已经把状态放回 inbox，补一条回执，别让人以为在跑
    await stopHere("派活没成功，已留在待处理。");
  };

  const existing = findWorkpackTask(outDir);
  if (existing) {
    // 光秃秃再发一次，多半是手滑或想确认一下，材料刷新过就够了，不重跑
    if (!remark) {
      await replyText(
        evt,
        `↷ 这份需求已经是 #${existing.seq}「${existing.title}」，材料已刷新。\n` +
          `想换个角度重看，把要求写在后面：/plan ${target} 重点看图片业务线`,
        { force: true },
      );
      return;
    }
    // 带了新交代 = 想换个角度重看。任务不重复建，但这一句要挂进沟通记录并真的再跑一轮，
    // 只 appendThread 不派活的话，人等不到任何结果
    appendThread(existing.id, { role: "them", text: remark, at: createdAt });
    const refreshed = getTask(existing.id) || existing;
    broadcastTask("updated", refreshed);
    await launch(
      refreshed,
      `🔄 #${refreshed.seq}「${refreshed.title}」材料已刷新\n· 你的交代：${remark}`,
    );
    return;
  }

  const { task: fields } = buildWorkpackTask({
    dir: outDir,
    recordId: recordId || "",
    repoPath: repoRoot,
    remark,
  });

  const task = addTask({
    ...fields,
    messageId,
    chatId: evt.chat_id,
    chatType: evt.chat_type,
    senderId: evt.sender_id,
    senderName: "",
    createdAt,
    status: "inbox",
  });
  broadcastTask("created", task);
  hydrateRequesterName(task);

  await launch(
    task,
    [
      `📦 已备料 #${task.seq}「${task.title}」`,
      standalone
        ? "· 该链接不在需求池「排实施」里，按独立文档处理（业务线要从正文推断）"
        : null,
      assetCount ? `· 截图 ${assetCount} 张` : "· 无截图",
      `· 仓库 ${repoLabel}`,
      // 回显一遍：万一链接和说明拆错了，当场就能看出来
      remark ? `· 你的交代：${remark}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

const ENGINE_LABEL = { agy: "Antigravity", claude: "Claude Code", codex: "Codex" };
const MODE_LABEL = {
  analyze: "只读分析",
  plan: "产实施 plan",
  edit: "允许改代码",
  full: "全自动",
};

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

  // ③ /plan：需求池链接 → 备料 → 建工作包任务。
  // 备料是十几秒的异步活，不能卡住事件流——后面还有别人的消息在排队
  if (cmd === "plan") {
    if (!body) {
      const example = COMMANDS.find((c) => c.key === "plan")?.examples?.[0];
      replyText(
        evt,
        [
          "「/plan」后面要跟需求文档链接、record_id 或需求名关键词，例如：",
          example?.text,
          ...(example?.notes || []),
        ]
          .filter(Boolean)
          .join("\n"),
        { force: true },
      );
      return;
    }
    handlePlanCommand(evt, body, createdAt, messageId).catch((err) => {
      console.error("[docking] /plan 处理失败:", err);
      replyText(evt, `❌ /plan 处理异常：${err.message}`, { force: true });
    });
    return;
  }

  // ④ /u：光秃秃一个 /u 就把他自己的任务列表回过去，让他挑
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

  // ⑤ /u 落到具体任务，或 ⑥ 合并窗口内的连发消息 —— 都并入既有任务
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

  // ⑦ /r 建需求；没指令的记成 unfiled，面板上可一键转正
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
  connected = false;

  // 上一个进程还在优雅退出的话，别等那 3 秒的补刀定时器了——它没死透就一直
  // 占着事件订阅，新进程和它抢同一条推送，而它抢到的又会被下面的 isCurrent()
  // 守卫丢掉，等于这段时间的消息谁都没收。要起新的就先把旧的收干净。
  if (exiting) {
    killProcessTree(exiting, "SIGKILL");
    exiting = null;
  }

  // 全程用闭包里的 proc，不要读模块级的 child。
  //
  // stopListener() 发完 SIGTERM 就同步把 child 置空，旧进程却要过 100ms~3s
  // 才真的退出。这中间用户只要再点一次「开始监听」，新进程就已经坐在 child 上了，
  // 而旧进程的那批 handler 还挂着——它们如果直接改全局状态，就会：
  //   · close 里 child = null 把新进程的句柄抹掉（新进程变成停不掉的孤儿）
  //   · 此时 stopping 已被 launch() 重置为 false，于是判成「意外结束」触发重连，
  //     退避到期再拉起第三个进程
  //   · line 里继续 handleEvent，和新进程一起消费同一条飞书推送，
  //     同一条需求入列两次、自动派发跑两次 AI
  // 所以每个 handler 先认一下自己是不是当前进程，不是就只清理自己。
  const proc = spawnLark(["event", "consume", EVENT_KEY, "--as", "bot"]);
  child = proc;
  const isCurrent = () => child === proc;

  const rl = readline.createInterface({ input: proc.stdout });
  rl.on("line", (line) => {
    if (!isCurrent()) return;
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== "{") return; // 跳过就绪标记之类的非 JSON 行
    try {
      handleEvent(JSON.parse(trimmed));
      procError = "";
      markHealthy();
    } catch (err) {
      console.error("[docking] 事件解析失败", err.message, trimmed.slice(0, 200));
    }
  });

  // 这个进程自己的报错，退出时用。不能读模块级的 lastError：
  // 重试时那里还是上一个进程留下的，而且这个进程可能根本没报错
  let stderrTail = "";
  let procError = "";

  proc.stderr.on("data", (chunk) => {
    if (!isCurrent()) return;
    const text = chunk.toString().trim();
    if (!text) return;
    console.log("[docking][lark-cli]", text);

    if (text.includes(READY_MARKER)) {
      procError = "";
      markHealthy();
      return;
    }

    // 没配置、缺授权、网络失败都走错误信封，翻成人话。多行 JSON 可能被切成几个 chunk，攒着尾巴解析
    stderrTail = `${stderrTail}\n${text}`.slice(-STDERR_TAIL_MAX);
    const described = describeLarkError(parseLarkError(stderrTail));
    // 不是信封的就只把明显的错误留给 UI。
    // 匹配得太宽会把 "0 errors" 这种也当成故障，所以排掉明显的正常行
    const plain =
      /\b(error|failed|denied|unauthorized)\b/i.test(text) &&
      !/\b(0 errors?|no error)\b/i.test(text)
        ? text.slice(0, 500)
        : "";
    const reason = described || plain;
    if (!reason) return;
    // 重试时这条多半跟 lastError 一样，也得记到本进程上，否则退出时又被退出码顶掉
    procError = reason;
    if (reason !== lastError) {
      lastError = reason;
      broadcastStatus();
    }
  });

  // 下面两处先 scheduleRetry 再广播：反过来会先推出一帧「没在监听也没在重连」，
  // 顶栏按钮就在「重连中 · 点击停止」和「开始监听飞书」之间闪一下
  proc.on("error", (err) => {
    if (!isCurrent()) return;
    lastError = err.message;
    child = null;
    connected = false;
    scheduleRetry();
    broadcastStatus();
  });

  proc.on("close", (code) => {
    rl.close(); // 自己的 readline 无论如何都要收掉
    if (!isCurrent()) return;
    child = null;
    connected = false;
    if (stopping) {
      broadcastStatus();
      return;
    }
    // stderr 里给过原因（没配置、缺授权…）就留着它，退出码对人没有信息量
    lastError = procError || `事件流意外结束（退出码 ${code}）`;
    scheduleRetry();
    broadcastStatus();
  });

  broadcastStatus();
}

export function startListener() {
  lastError = "";
  retryCount = 0;
  launch();
  return getListenerStatus();
}

/**
 * @param {{force?: boolean}} [options] force=true 时跳过 SIGTERM 直接整组 SIGKILL。
 *   app 退出时用：Electron 不等 before-quit 里的异步收尾，SIGTERM 的补刀定时器
 *   压根没机会执行，不理会 SIGTERM 的 lark-cli 就会变成常驻孤儿。
 */
export function stopListener({ force = false } = {}) {
  stopping = true;
  connected = false;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  // force 是 app 退出路径：Electron 不等 before-quit 里的异步收尾，靠定时器
  // 补刀的那些进程一个都跑不掉，所以这里连上一次 stop 还没死透的也一并 SIGKILL
  if (force && exiting) {
    killProcessTree(exiting, "SIGKILL");
    exiting = null;
  }
  if (child) {
    const proc = child;
    child = null;
    if (force) {
      killProcessTree(proc, "SIGKILL");
    } else {
      exiting = proc;
      killProcessTree(proc, "SIGTERM");
      // 卡死或不理 SIGTERM 的话限时补刀，否则它会一直占着事件订阅，
      // 下次 launch() 起的新进程要和它抢同一条推送
      const forceKill = setTimeout(
        () => killProcessTree(proc, "SIGKILL"),
        KILL_GRACE_MS,
      );
      forceKill.unref?.();
      proc.once("exit", () => {
        clearTimeout(forceKill);
        if (exiting === proc) exiting = null;
      });
    }
  }
  broadcastStatus();
  return getListenerStatus();
}
