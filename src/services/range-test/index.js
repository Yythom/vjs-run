// 改动测试台的主进程编排：发起、回复、查详情，以及两路推送——产物文件变了（chokidar）、
// T3 线程状态变了（轮询 `t3 thread show`）。推送统一走 "range-test-changed" 频道，
// 渲染层收到后按 dir 重新拉详情。

import fs from "node:fs";
import path from "node:path";
import chokidar from "chokidar";
import { getConfig } from "../../config/store.js";
import { getRepoDefinition } from "../../config/lookup.js";
import { sendToAllWindows } from "../../ui-channel.js";
import { showThread, startThread, sendMessage, summarizeThread } from "../t3-cli.js";
import { notifyRangeTest } from "../notify.js";
import { listCandidates, listCommitsSince, repoName, resolveRange } from "./git.js";
import {
  buildFollowUpMessage,
  buildReplyMessage,
  buildResumeMessage,
  buildStartMessage,
  isEmptyReply,
} from "./prompt.js";
import { diffChecklist, remainingCells } from "./checklist.js";
import { readCheck, readStatus, skillInfo } from "./coverage.js";
import { checkDevPorts, describeBusyPorts } from "./ports.js";
import { readT3Models } from "./t3-models.js";
import {
  assertRecordDir,
  describeRecord,
  expandHome,
  extractFindings,
  latestEvidence,
  listRecords,
  readSidecar,
  sanitizeTopic,
  sceneNamesIn,
  updateSidecar,
  writeSidecar,
} from "./records.js";

const CHANNEL = "range-test-changed";
// 确认开测那一刻的清单快照：之后 agent 改了已确认的行，界面拿它比出改了什么（M0 实测 agent 会改）
const CONFIRMED_SNAPSHOT = ".vjtools-confirmed-checklist.md";
const POLL_MS = 4000;
const POLL_MAX_FAILURES = 5;

function settings() {
  return getConfig().rangeTest;
}

/** 这次用哪个 provider / 模型：界面选了就用选的（两个要成对），否则用「T3 设置」里的默认值 */
function pickModel(choice) {
  const provider = String(choice?.provider || "").trim();
  const model = String(choice?.model || "").trim();
  if (provider && model) return { provider, model };
  const { provider: p, model: m } = settings();
  return { provider: p, model: m };
}

function recordsRoot() {
  return expandHome(settings().recordsDir);
}

/**
 * 跑 coverage.mjs 的目录：判断证据过期要在被测仓库里跑 git。界面发起的记录 sidecar 里有仓库路径；
 * 以前在对话里跑的没有 sidecar，按产物目录的上一级（仓库名）找已配置的同名仓库
 */
function repoPathForRecord(record) {
  if (record.sidecar?.repoPath) return record.sidecar.repoPath;
  const repo = (getConfig().frontendProjectGroups || []).find((g) => path.basename(g.path || "") === record.repoName);
  return repo?.path || record.dir;
}

function repoPathOf(repoKey) {
  const repo = getRepoDefinition(repoKey);
  if (!repo?.path) throw new Error("先在「项目管理」里添加这个仓库");
  return repo.path;
}

// ─── 产物文件监听 ───────────────────────────────────────────────────────────────

let watcher = null;
let watchedRoot = "";
const fileTimers = new Map();

function ensureWatcher() {
  const root = recordsRoot();
  if (watcher && watchedRoot === root) return;
  watcher?.close();
  fs.mkdirSync(root, { recursive: true });
  watchedRoot = root;
  watcher = chokidar.watch(root, {
    ignoreInitial: true,
    depth: 2,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });
  watcher.on("all", (_event, file) => {
    const rel = path.relative(root, file).split(path.sep);
    if (rel.length < 2 || rel[0].startsWith("..")) return;
    const dir = path.join(root, rel[0], rel[1]);
    // agent 一次改动会连写几个文件，合并成一次推送
    clearTimeout(fileTimers.get(dir));
    fileTimers.set(
      dir,
      setTimeout(() => {
        fileTimers.delete(dir);
        sendToAllWindows(CHANNEL, { dir, kind: "files" });
      }, 300),
    );
  });
}

export function stopRangeTestWatchers() {
  watcher?.close();
  watcher = null;
  for (const t of fileTimers.values()) clearTimeout(t);
  fileTimers.clear();
  for (const p of pollers.values()) clearTimeout(p.timer);
  pollers.clear();
}

// ─── 线程轮询 ─────────────────────────────────────────────────────────────────

// dir -> { timer, failures, last }
const pollers = new Map();

async function fetchThread(threadId) {
  return summarizeThread(await showThread({ threadId }));
}

function sameThread(a, b) {
  return (
    a && b && a.state === b.state && a.status === b.status && a.lastMessage === b.lastMessage && a.updatedAt === b.updatedAt
  );
}

function notifyRoundEnd(dir, sidecar, thread) {
  const phase = describeRecord(dir).phaseKind;
  const body =
    thread.state === "failed"
      ? "线程失败了，打开看原因"
      : thread.state === "needs-answer"
        ? "agent 在等回答，需要到 T3 里答"
        : phase === "pending"
          ? "清单出好了，等你确认"
          : "这一轮跑完了，打开看结果";
  notifyRangeTest(`改动测试：${sidecar.topic}`, body);
}

function ensurePolling(dir) {
  if (pollers.has(dir)) return;
  const entry = { timer: null, failures: 0, last: null };
  pollers.set(dir, entry);
  const tick = async () => {
    const sidecar = readSidecar(dir);
    if (!sidecar?.threadId) {
      pollers.delete(dir);
      return;
    }
    try {
      const thread = await fetchThread(sidecar.threadId);
      entry.failures = 0;
      if (!sameThread(entry.last, thread)) {
        // 只在亲眼看到「运行中 → 结束」时提醒：app 重开后第一次轮询就看到结束的不算
        if (entry.last?.state === "running" && thread.state !== "running") notifyRoundEnd(dir, sidecar, thread);
        entry.last = thread;
        updateSidecar(dir, { lastState: thread.state, threadLink: thread.link || sidecar.threadLink || "" });
        sendToAllWindows(CHANNEL, { dir, kind: "thread", thread });
      }
      if (thread.state !== "running") {
        pollers.delete(dir);
        return;
      }
    } catch (err) {
      entry.failures += 1;
      sendToAllWindows(CHANNEL, { dir, kind: "thread-error", error: err.message });
      if (entry.failures >= POLL_MAX_FAILURES) {
        pollers.delete(dir);
        return;
      }
    }
    entry.timer = setTimeout(tick, POLL_MS);
  };
  entry.timer = setTimeout(tick, 0);
}

// ─── 对外操作 ─────────────────────────────────────────────────────────────────

export async function getCandidates({ repoKey }) {
  const repoPath = repoPathOf(repoKey);
  return { repoPath, ...(await listCandidates(repoPath)) };
}

// 列表页的进度条：每条记录跑一次 status（不带 log，快），按清单 mtime 缓存，清单没变就不重跑
const progressCache = new Map(); // checklistPath -> { mtime, counts }

async function progressOf(record) {
  if (!record.checklistPath) return null;
  const mtime = fs.statSync(record.checklistPath).mtimeMs;
  const hit = progressCache.get(record.checklistPath);
  if (hit?.mtime === mtime) return hit.counts;
  try {
    const status = await readStatus({ checklistPath: record.checklistPath, cwd: record.dir });
    progressCache.set(record.checklistPath, { mtime, counts: status.counts });
    return status.counts;
  } catch {
    return null;
  }
}

export async function getRecords() {
  ensureWatcher();
  const records = listRecords(recordsRoot());
  // app 重开后接上还在跑的线程
  for (const r of records) {
    if (r.sidecar?.threadId && ["running", "starting"].includes(r.sidecar.lastState)) ensurePolling(r.dir);
  }
  const progress = await Promise.all(records.map(progressOf));
  return { records: records.map((r, i) => ({ ...r, progress: progress[i] })), recordsDir: recordsRoot() };
}

export async function startRun({ repoKey, range, topic, provider: chosenProvider, model: chosenModel }) {
  const repoPath = repoPathOf(repoKey);
  const { provider, model } = pickModel({ provider: chosenProvider, model: chosenModel });
  const safeTopic = sanitizeTopic(topic);
  if (!safeTopic) throw new Error("主题不能为空");
  const dir = path.join(recordsRoot(), await repoName(repoPath), safeTopic);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
    throw new Error(`主题「${safeTopic}」已经有记录了，换一个主题名`);
  }
  const { base, tip, count } = await resolveRange(repoPath, range);
  writeSidecar(dir, {
    version: 1,
    repoKey,
    repoPath,
    topic: safeTopic,
    range,
    base,
    tip,
    count,
    provider,
    model,
    createdAt: new Date().toISOString(),
    runStartedAt: new Date().toISOString(),
    threadId: null,
    threadLink: "",
    lastState: "starting",
  });
  let res;
  try {
    res = await startThread({
      projectPath: repoPath,
      message: buildStartMessage({ repoPath, base, tip, count, topic: safeTopic, dir }),
      title: `改动测试：${safeTopic}`,
      provider,
      model,
    });
  } catch (err) {
    updateSidecar(dir, { lastState: "failed", lastError: err.message });
    throw err;
  }
  updateSidecar(dir, { threadId: res.threadId, lastState: "running" });
  ensurePolling(dir);
  return { dir, threadId: res.threadId };
}

/** 详情：记录 + 清单明细与进度 + 线程状态。check 慢，单独一个接口按需调 */
export async function getDetail({ dir }) {
  const target = assertRecordDir(recordsRoot(), dir);
  const record = describeRecord(target);
  const cwd = repoPathForRecord(record);
  const [status, thread] = await Promise.allSettled([
    record.checklistPath
      ? readStatus({ checklistPath: record.checklistPath, logPath: record.logPath, mapPath: record.mapPath, cwd })
      : Promise.resolve(null),
    record.sidecar?.threadId ? fetchThread(record.sidecar.threadId) : Promise.resolve(null),
  ]);
  if (thread.status === "fulfilled" && thread.value?.state === "running") ensurePolling(target);
  let confirmDiff = null;
  const snapshot = path.join(target, CONFIRMED_SNAPSHOT);
  if (status.status === "fulfilled" && status.value && fs.existsSync(snapshot)) {
    try {
      const before = await readStatus({ checklistPath: snapshot, cwd });
      confirmDiff = diffChecklist(before.items, status.value.items);
    } catch {
      // 快照读不了不影响详情，只是不显示改动
    }
  }
  let logText = "";
  try {
    if (record.logPath) logText = fs.readFileSync(record.logPath, "utf8");
  } catch {
    // log 不在就当空的
  }
  return {
    record,
    confirmDiff,
    findings: extractFindings(logText),
    // 这次测试相关的 mock 场景：约定的「测试-<主题>」，加上 log 里提到的场景名（备份场景只在 log 里有）
    sceneHints: [...new Set([`测试-${record.topic}`, ...sceneNamesIn(logText)])],
    latestEvidence: latestEvidence(target),
    status: status.status === "fulfilled" ? status.value : null,
    statusError: status.status === "rejected" ? status.reason.message : "",
    thread: thread.status === "fulfilled" ? thread.value : null,
    threadError: thread.status === "rejected" ? thread.reason.message : "",
  };
}

export async function getCheck({ dir }) {
  const target = assertRecordDir(recordsRoot(), dir);
  const record = describeRecord(target);
  if (!record.mapPath || !record.checklistPath) return { check: null };
  const check = await readCheck({
    mapPath: record.mapPath,
    checklistPath: record.checklistPath,
    cwd: repoPathForRecord(record),
  });
  return { check };
}

export async function replyRun({ dir, reply }) {
  const target = assertRecordDir(recordsRoot(), dir);
  const sidecar = readSidecar(target);
  if (!sidecar?.threadId) throw new Error("这条记录不是从改动测试台发起的，没有可回复的线程");
  const thread = await fetchThread(sidecar.threadId);
  if (thread.state === "running") throw new Error("线程还在跑，等这一轮结束再回复");
  if (thread.state === "needs-answer") throw new Error("线程在等提问工具的回答，先到 T3 里回答");
  if (isEmptyReply(reply)) throw new Error("没有要发的内容：勾选调整或写点说明，或者直接确认开测");
  if (reply.confirm) {
    // 拍的是使用者确认的这一版；确认时要求的调整由 agent 之后再改，也会算进「确认后改过」
    const { checklistPath } = describeRecord(target);
    if (checklistPath) fs.copyFileSync(checklistPath, path.join(target, CONFIRMED_SNAPSHOT));
  }
  await sendMessage({ threadId: sidecar.threadId, message: buildReplyMessage(reply) });
  updateSidecar(target, {
    lastState: "running",
    lastReplyAt: new Date().toISOString(),
    runStartedAt: new Date().toISOString(),
    ...(reply.confirm ? { confirmedAt: new Date().toISOString() } : {}),
  });
  ensurePolling(target);
  return {};
}

/**
 * 确认开测之后线程一轮结束时的下一步：
 *   continue      还有本地能测的 ⬜ 格
 *   fix-evidence  status 报了证据问题
 *   new-thread    换新线程从产物文件续接（旧线程失败、找不到、上下文太长）
 * 条件都在这里按文件重新判断一遍，不信渲染层传来的状态
 */
export async function continueRun({ dir, kind, commits, provider, model }) {
  const target = assertRecordDir(recordsRoot(), dir);
  const record = describeRecord(target);
  const sidecar = record.sidecar;
  if (!sidecar) throw new Error("这条记录是在对话里跑的，没有线程信息：在对话里接着跑");
  // 原线程的模型改不了（send 不带模型），换模型只能在换新线程时选
  if (kind === "new-thread") return startResumeThread(target, sidecar, pickModel({ provider, model }));

  if (!sidecar.threadId) throw new Error("还没有线程，用「换新线程续接」");
  const thread = await fetchThread(sidecar.threadId);
  if (thread.state === "running") throw new Error("线程还在跑，等这一轮结束");
  if (thread.state === "needs-answer") throw new Error("线程在等提问工具的回答，先到 T3 里回答");
  if (record.phaseKind !== "confirmed") throw new Error("清单还没确认，先在确认点回复");
  if (!record.checklistPath || !record.logPath || !record.mapPath) throw new Error("产物文件不全，读不了进度和证据");

  const status = await readStatus({
    checklistPath: record.checklistPath,
    logPath: record.logPath,
    mapPath: record.mapPath,
    cwd: repoPathForRecord(record),
  });
  let message;
  if (kind === "continue") {
    if (remainingCells(status.items).local.length === 0) throw new Error("没有本地能测的 ⬜ 格了");
    message = buildFollowUpMessage("continue");
  } else if (kind === "fix-evidence") {
    if (status.problems.length === 0) throw new Error("status 没有报问题，不用修");
    message = buildFollowUpMessage("fix-evidence", { problems: status.problems });
  } else if (kind === "check-offline") {
    if (remainingCells(status.items).offline.length === 0) throw new Error("没有要核对的【测试服】【真机】【线上】格");
    message = buildFollowUpMessage("check-offline");
  } else if (kind === "regress") {
    // 只认实测提交之后真实存在的提交，标题以仓库为准
    const since = await listCommitsSince(repoPathForRecord(record), status.testedHead || sidecar.tip);
    const picked = since.filter((c) => (commits || []).includes(c.sha));
    if (picked.length === 0) throw new Error("先勾选修复提交");
    message = buildFollowUpMessage("regress", { commits: picked });
  } else {
    throw new Error(`未知的后续操作：${kind}`);
  }
  await sendMessage({ threadId: sidecar.threadId, message });
  updateSidecar(target, {
    lastState: "running",
    lastFollowUp: { kind, at: new Date().toISOString() },
    runStartedAt: new Date().toISOString(),
  });
  ensurePolling(target);
  return {};
}

/** 回归时可选的修复提交：清单头「实测代码」之后到 HEAD 的提交 */
export async function getFixCommits({ dir }) {
  const target = assertRecordDir(recordsRoot(), dir);
  const record = describeRecord(target);
  if (!record.checklistPath) throw new Error("还没有清单");
  const cwd = repoPathForRecord(record);
  const status = await readStatus({ checklistPath: record.checklistPath, cwd });
  const from = status.testedHead || record.sidecar?.tip;
  if (!from) throw new Error("清单头没有「实测代码」，不知道从哪个提交往后算");
  return { testedHead: from, commits: await listCommitsSince(cwd, from) };
}

export async function getDevPorts() {
  const ports = await checkDevPorts();
  return { ports, note: describeBusyPorts(ports) };
}

export function getT3Models() {
  const { providers, error } = readT3Models();
  return { providers, error, defaults: { provider: settings().provider, model: settings().model } };
}

export async function getSkillInfo() {
  return skillInfo();
}

async function startResumeThread(target, sidecar, { provider, model }) {
  if (sidecar.threadId) {
    const old = await fetchThread(sidecar.threadId).catch(() => null);
    if (old?.state === "running") throw new Error("旧线程还在跑：等它结束，或者先在 T3 里停掉");
  }
  const res = await startThread({
    projectPath: sidecar.repoPath,
    message: buildResumeMessage({ ...sidecar, dir: target }),
    title: `改动测试：${sidecar.topic}（续）`,
    provider,
    model,
  });
  // 旧线程留个记录，详情页能找回链接
  const threads = [...(sidecar.threads || [])];
  if (sidecar.threadId) {
    threads.push({ threadId: sidecar.threadId, link: sidecar.threadLink || "", endedAt: new Date().toISOString() });
  }
  updateSidecar(target, {
    threadId: res.threadId,
    threadLink: "",
    threads,
    provider,
    model,
    lastState: "running",
    lastError: "",
    runStartedAt: new Date().toISOString(),
  });
  ensurePolling(target);
  return { threadId: res.threadId };
}

// 证据里引用的截图：只读产物目录里的图片，防止渲染层借这个接口读任意文件
const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const MAX_ASSET_BYTES = 15 * 1024 * 1024;

export function readAsset({ dir, path: rel }) {
  const target = fs.realpathSync(assertRecordDir(recordsRoot(), dir));
  // 两边都取真实路径再比：目录里放个指向外面的软链也读不出去
  const file = fs.realpathSync(path.resolve(target, String(rel || "")));
  const inside = path.relative(target, file);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) {
    throw new Error(`只能读产物目录里的文件：${rel}`);
  }
  const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (!type) throw new Error(`不是支持的图片格式：${rel}`);
  const stat = fs.statSync(file);
  if (stat.size > MAX_ASSET_BYTES) throw new Error(`图片太大（${Math.round(stat.size / 1024 / 1024)} MB）：${rel}`);
  return { dataUrl: `data:${type};base64,${fs.readFileSync(file).toString("base64")}` };
}

export function threadLinkOf({ dir }) {
  const target = assertRecordDir(recordsRoot(), dir);
  const sidecar = readSidecar(target);
  if (!sidecar?.threadLink) throw new Error("还没有线程链接：等线程状态刷新一次再试");
  return sidecar.threadLink;
}
