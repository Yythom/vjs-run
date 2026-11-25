// 改动测试台的 git 查询：发起前算候选范围，发起时把范围解析成确定的提交。
// 范围的含义照 commit-range-test 第 1 步：「从 A 到 B」包含 A，所以 base = A^。

import path from "node:path";
import { execFile } from "node:child_process";
import { buildSpawnEnv } from "../../shell-env.js";

// 线上分支。commit-range-test 在 vjs-monorepo 里拿它当「领先多少」的基准
export const UPSTREAM_REF = "origin/develop";
const RECENT_LIMIT = 30;
// 提交列表的字段分隔符：标题里可能有空格、竖线，用 ASCII 单元分隔符
const SEP = "\x1f";

async function git(cwd, args, { timeoutMs = 20_000 } = {}) {
  const env = await buildSpawnEnv({ FORCE_COLOR: "0", GIT_TERMINAL_PROMPT: "0" });
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || "").trim().split("\n")[0];
        reject(new Error(`git ${args[0]} 失败：${msg}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

const gitTry = (cwd, args, opts) => git(cwd, args, opts).catch(() => null);

export function parseCommitLines(text) {
  if (!text) return [];
  return text.split("\n").map((line) => {
    const [sha, short, author, date, subject] = line.split(SEP);
    return { sha, short, author, date, subject };
  });
}

/** 仓库根目录名：产物目录 ~/test-records/<仓库名>/ 用它，和 skill 的约定一致 */
export async function repoName(repoPath) {
  const top = await git(repoPath, ["rev-parse", "--show-toplevel"]);
  return path.basename(top);
}

/**
 * 发起弹框要的候选：当前分支、领先线上分支的提交、最近的提交列表（走第一父链，
 * 这样「最近 N 个」的 base 就是 HEAD~N，和列表里看到的一致）。
 * fetch 失败不致命（离线时照样能选），只在 fetchError 里带上原因。
 */
export async function listCandidates(repoPath) {
  let fetchError = "";
  try {
    await git(repoPath, ["fetch", "origin", "--quiet"], { timeoutMs: 60_000 });
  } catch (err) {
    fetchError = err.message;
  }
  const [branch, head, upstream] = await Promise.all([
    git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(repoPath, ["rev-parse", "HEAD"]),
    gitTry(repoPath, ["rev-parse", "--verify", "--quiet", UPSTREAM_REF]),
  ]);
  let ahead = null;
  if (upstream) {
    const [mergeBase, count] = await Promise.all([
      git(repoPath, ["merge-base", UPSTREAM_REF, "HEAD"]),
      git(repoPath, ["rev-list", "--count", "--no-merges", `${UPSTREAM_REF}..HEAD`]),
    ]);
    ahead = { ref: UPSTREAM_REF, base: mergeBase, count: Number(count) };
  }
  const log = await git(repoPath, [
    "log",
    "--first-parent",
    `-n${RECENT_LIMIT}`,
    `--format=%H${SEP}%h${SEP}%an${SEP}%ad${SEP}%s`,
    "--date=short",
    "HEAD",
  ]);
  return { branch, head, ahead, commits: parseCommitLines(log), fetchError };
}

/**
 * 把界面选的范围解析成确定的 base / tip 提交，并统计提交数（不含合并提交，和 skill 列提交的口径一致）。
 *   { kind: "ahead" }               base = 与线上分支的 merge-base，tip = HEAD
 *   { kind: "recent", count: N }    base = HEAD~N，tip = HEAD
 *   { kind: "custom", from, to }    from 是较早的那个提交（包含在内），base = from^，tip = to
 */
export async function resolveRange(repoPath, range) {
  let baseRev;
  let tipRev = "HEAD";
  if (range.kind === "ahead") {
    baseRev = await git(repoPath, ["merge-base", UPSTREAM_REF, "HEAD"]);
  } else if (range.kind === "recent") {
    const n = Number(range.count);
    if (!Number.isInteger(n) || n < 1) throw new Error("最近提交数要是正整数");
    baseRev = `HEAD~${n}`;
  } else if (range.kind === "custom") {
    if (!range.from || !range.to) throw new Error("要选起止两个提交");
    baseRev = `${range.from}^`;
    tipRev = range.to;
  } else {
    throw new Error(`未知的范围类型：${range.kind}`);
  }
  const [base, tip] = await Promise.all([
    git(repoPath, ["rev-parse", "--verify", baseRev]),
    git(repoPath, ["rev-parse", "--verify", tipRev]),
  ]);
  const isAncestor = await gitTry(repoPath, ["merge-base", "--is-ancestor", base, tip]);
  if (isAncestor === null) throw new Error("起点不在终点之前：检查选的两个提交的先后");
  const count = Number(await git(repoPath, ["rev-list", "--count", "--no-merges", `${base}..${tip}`]));
  if (count === 0) throw new Error("这个范围里没有提交");
  return { base, tip, count };
}

/** from 之后（不含）到 HEAD 的提交，不含合并提交，新的在前。回归时让使用者勾选哪些是修复 */
export async function listCommitsSince(repoPath, from) {
  const log = await git(repoPath, [
    "log",
    "--no-merges",
    `--format=%H${SEP}%h${SEP}%an${SEP}%ad${SEP}%s`,
    "--date=short",
    `${from}..HEAD`,
  ]);
  return parseCommitLines(log);
}
