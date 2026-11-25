// 改动测试的记录：就是 commit-range-test 的产物目录 <recordsDir>/<仓库名>/<主题>/。
// 界面只在目录里多放一个 .vjtools-run.json（sidecar），记线程 id、范围、模型，
// 其余状态（阶段、结果格）都从三个产物文件现读，不另存一份。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SIDECAR = ".vjtools-run.json";
const CHECKLIST_SUFFIX = "-test-checklist.md";
const MAP_SUFFIX = "-test-coverage-map.md";
const LOG_SUFFIX = "-test-log.md";
// 和 coverage.mjs 的 PHASE_RE 一致：清单头「阶段：…」一行，前面带列表符号、加粗也认
const PHASE_RE = /^[\s>*+-]*阶段\**\s*[:：]\s*\**\s*(.*)$/m;

export function expandHome(p) {
  const s = String(p || "").trim();
  if (s === "~") return os.homedir();
  if (s.startsWith("~/")) return path.join(os.homedir(), s.slice(2));
  return s;
}

/** 主题要当目录名用：去掉路径分隔符和控制字符，空白压成一个 */
export function sanitizeTopic(topic) {
  return Array.from(String(topic || ""), (ch) => (ch.charCodeAt(0) < 0x20 ? "-" : ch))
    .join("")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s-]+|[.\s]+$/g, "")
    .slice(0, 60);
}

export function readSidecar(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, SIDECAR), "utf8"));
  } catch {
    return null;
  }
}

export function writeSidecar(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, SIDECAR);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function updateSidecar(dir, patch) {
  const cur = readSidecar(dir);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  writeSidecar(dir, next);
  return next;
}

/** 目录里的三个产物：按 skill 的命名「<主题>-test-checklist.md」找，主题名不必和目录名一致 */
export function findArtifacts(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { checklistPath: null, mapPath: null, logPath: null };
  }
  const pick = (suffix) => {
    const name = names.find((n) => n.endsWith(suffix));
    return name ? path.join(dir, name) : null;
  };
  return { checklistPath: pick(CHECKLIST_SUFFIX), mapPath: pick(MAP_SUFFIX), logPath: pick(LOG_SUFFIX) };
}

export function readPhase(checklistPath) {
  if (!checklistPath) return null;
  try {
    const m = fs.readFileSync(checklistPath, "utf8").match(PHASE_RE);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/** 阶段行归成三类：pending（待确认）/ confirmed（已确认）/ none（没有清单或没有阶段行） */
export function phaseKind(phase) {
  if (!phase) return "none";
  if (phase.startsWith("待确认")) return "pending";
  if (phase.startsWith("已确认")) return "confirmed";
  return "none";
}

function latestMtime(dir, files) {
  let t = 0;
  for (const f of files) {
    try {
      t = Math.max(t, fs.statSync(f).mtimeMs);
    } catch {
      // 文件不在就跳过
    }
  }
  if (!t) {
    try {
      t = fs.statSync(dir).mtimeMs;
    } catch {
      t = 0;
    }
  }
  return t;
}

export function describeRecord(dir) {
  const sidecar = readSidecar(dir);
  const artifacts = findArtifacts(dir);
  const phase = readPhase(artifacts.checklistPath);
  return {
    dir,
    repoName: path.basename(path.dirname(dir)),
    topic: sidecar?.topic || path.basename(dir),
    sidecar,
    ...artifacts,
    phase,
    phaseKind: phaseKind(phase),
    updatedAt: latestMtime(dir, [artifacts.checklistPath, artifacts.mapPath, artifacts.logPath, path.join(dir, SIDECAR)].filter(Boolean)),
  };
}

/**
 * 扫描 <recordsDir>/<仓库名>/<主题>/：有 sidecar 或有清单的目录算一条记录。
 * 以前在对话里跑的（没有 sidecar）也列出来，只是没法从界面回复。
 */
export function listRecords(recordsDir) {
  const root = expandHome(recordsDir);
  const out = [];
  const subdirs = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("."));
    } catch {
      return [];
    }
  };
  for (const repo of subdirs(root)) {
    for (const t of subdirs(path.join(root, repo.name))) {
      const dir = path.join(root, repo.name, t.name);
      const rec = describeRecord(dir);
      if (rec.sidecar || rec.checklistPath) out.push(rec);
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 只接受 recordsDir 下面两层的目录，防止渲染层传任意路径进来 */
export function assertRecordDir(recordsDir, dir) {
  const root = path.resolve(expandHome(recordsDir));
  const target = path.resolve(String(dir || ""));
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.split(path.sep).length !== 2) {
    throw new Error(`不是改动测试记录目录：${dir}`);
  }
  return target;
}

/**
 * log 里「## 发现」「## 其他发现」一节的原文（到下一个同级或更高的标题为止），报告视图用。
 * 没有就返回空串
 */
export function extractFindings(logText) {
  const lines = String(logText || "").split("\n");
  // 「## 发现」「## 其他发现」，也认后面带括号说明的「## 发现（11-24）」
  const start = lines.findIndex((l) => /^##\s*(其他)?发现\s*(?:$|[（(])/.test(l.trim()));
  if (start < 0) return "";
  const body = [];
  for (const l of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(l)) break;
    body.push(l);
  }
  return body.join("\n").trim();
}

/** log 里提到的 mock 场景名（测试-xxx、备份-xxx），场景卡片据此找出这次测试建的场景 */
export function sceneNamesIn(text) {
  const names = new Set();
  for (const m of String(text || "").matchAll(/(?:测试|备份)-[^\s`'"，。、；;：:（）()[\]【】|]+/g)) names.add(m[0]);
  return [...names];
}

/** evidence/ 里最新的一张图：运行中显示「最近截图」 */
export function latestEvidence(dir) {
  const evDir = path.join(dir, "evidence");
  let best = null;
  try {
    for (const name of fs.readdirSync(evDir)) {
      if (!/\.(png|jpe?g|gif|webp)$/i.test(name)) continue;
      const mtime = fs.statSync(path.join(evDir, name)).mtimeMs;
      if (!best || mtime > best.mtime) best = { path: `evidence/${name}`, mtime };
    }
  } catch {
    return null;
  }
  return best;
}
