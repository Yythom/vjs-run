import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "./task-store.js";

const MAX_HISTORY_ENTRIES = 500;

function getHistoryDir() {
  const dir = path.join(getDataDir(), "docking-history");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getRunsDir() {
  const dir = path.join(getHistoryDir(), "runs");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getIndexFile() {
  return path.join(getHistoryDir(), "history-index.json");
}

function loadIndex() {
  const file = getIndexFile();
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(data)) return data;
    }
  } catch (err) {
    console.error("[history-store] 读取历史索引失败:", err);
  }
  return [];
}

function saveIndex(list) {
  const file = getIndexFile();
  const tmp = `${file}.tmp.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), "utf8");
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch (_) {}
    console.error("[history-store] 保存历史索引失败:", err);
  }
}

/**
 * 过滤清洗日志中的内部标签与多余 token，保留清晰的终端日志与工具调用
 */
export function cleanLogs(logs = []) {
  if (!Array.isArray(logs)) return [];
  return logs
    .map((log) => {
      if (!log || typeof log !== "object") return null;
      let text = String(log.text || "");
      text = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();
      if (!text) return null;
      return {
        at: log.at || Date.now(),
        kind: log.kind || "stdout",
        text,
      };
    })
    .filter(Boolean);
}

/**
 * 保存一次 AI 调用的完整记录
 */
export function saveJobRun(record = {}) {
  if (!record.id) return null;
  const runsDir = getRunsDir();
  const cleanedLogs = cleanLogs(record.logs || []);

  const fullDetail = {
    id: record.id,
    taskIds: record.taskIds || [],
    taskTitles: record.taskTitles || [],
    engine: record.engine || "claude",
    mode: record.mode || "analyze",
    cwd: record.cwd || "",
    branchName: record.branchName || "",
    status: record.status || "done",
    exitCode: record.exitCode ?? 0,
    error: record.error || "",
    createdAt: record.createdAt || Date.now(),
    startTime: record.startTime || Date.now(),
    endTime: record.endTime || Date.now(),
    durationMs:
      record.durationMs ||
      Math.max(0, (record.endTime || Date.now()) - (record.startTime || Date.now())),
    prompt: record.prompt || "",
    logs: cleanedLogs,
    modifiedFiles: record.modifiedFiles ? Array.from(record.modifiedFiles) : [],
    resultNote: record.resultNote || "",
    sessionId: record.sessionId || "",
    resumedFrom: record.resumedFrom || "",
  };

  // 1. 写详情文件
  const detailFile = path.join(runsDir, `${record.id}.json`);
  try {
    fs.writeFileSync(detailFile, JSON.stringify(fullDetail, null, 2), "utf8");
  } catch (err) {
    console.error(`[history-store] 写入详情文件失败 (${record.id}):`, err);
  }

  // 2. 更新摘要索引
  const summary = {
    id: fullDetail.id,
    taskIds: fullDetail.taskIds,
    taskTitles: fullDetail.taskTitles,
    engine: fullDetail.engine,
    mode: fullDetail.mode,
    cwd: fullDetail.cwd,
    branchName: fullDetail.branchName,
    status: fullDetail.status,
    exitCode: fullDetail.exitCode,
    error: fullDetail.error,
    createdAt: fullDetail.createdAt,
    startTime: fullDetail.startTime,
    endTime: fullDetail.endTime,
    durationMs: fullDetail.durationMs,
    modifiedFilesCount: fullDetail.modifiedFiles.length,
    promptPreview:
      fullDetail.prompt.length > 200
        ? `${fullDetail.prompt.slice(0, 200)}…`
        : fullDetail.prompt,
    resultNote:
      fullDetail.resultNote.length > 200
        ? `${fullDetail.resultNote.slice(0, 200)}…`
        : fullDetail.resultNote,
  };

  const list = loadIndex();
  const existingIndex = list.findIndex((it) => it.id === summary.id);
  if (existingIndex >= 0) {
    list[existingIndex] = summary;
  } else {
    list.unshift(summary);
  }

  // 限制最大条数
  if (list.length > MAX_HISTORY_ENTRIES) {
    const expired = list.slice(MAX_HISTORY_ENTRIES);
    list.length = MAX_HISTORY_ENTRIES;
    for (const item of expired) {
      try {
        const p = path.join(runsDir, `${item.id}.json`);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch (_) {}
    }
  }

  saveIndex(list);
  return fullDetail;
}

/**
 * 查询历史记录列表（支持按 taskId, engine, status 过滤）
 */
export function listJobRuns({ taskId, engine, status, limit = 50, offset = 0 } = {}) {
  let list = loadIndex();
  if (taskId) {
    list = list.filter((it) => it.taskIds && it.taskIds.includes(taskId));
  }
  if (engine) {
    list = list.filter((it) => it.engine === engine);
  }
  if (status) {
    list = list.filter((it) => it.status === status);
  }

  const total = list.length;
  const items = list.slice(offset, offset + limit);
  return { items, total };
}

/**
 * 获取单次调用的完整详情（包含完整 prompt、全量 logs 与改动文件）
 */
export function getJobRunDetail(jobId) {
  if (!jobId) return null;
  const runsDir = getRunsDir();
  const detailFile = path.join(runsDir, `${jobId}.json`);
  try {
    if (fs.existsSync(detailFile)) {
      return JSON.parse(fs.readFileSync(detailFile, "utf8"));
    }
  } catch (err) {
    console.error(`[history-store] 读取详情失败 (${jobId}):`, err);
  }

  // 降级：从 index 里找 summary
  const list = loadIndex();
  return list.find((it) => it.id === jobId) || null;
}

/**
 * 删除单条历史记录
 */
export function deleteJobRun(jobId) {
  if (!jobId) return false;
  const runsDir = getRunsDir();
  const detailFile = path.join(runsDir, `${jobId}.json`);
  try {
    if (fs.existsSync(detailFile)) fs.unlinkSync(detailFile);
  } catch (_) {}

  const list = loadIndex().filter((it) => it.id !== jobId);
  saveIndex(list);
  return true;
}

/**
 * 清空所有历史记录
 */
export function clearJobRuns() {
  const runsDir = getRunsDir();
  try {
    if (fs.existsSync(runsDir)) {
      const files = fs.readdirSync(runsDir);
      for (const f of files) {
        try {
          fs.unlinkSync(path.join(runsDir, f));
        } catch (_) {}
      }
    }
  } catch (_) {}

  saveIndex([]);
  return true;
}
