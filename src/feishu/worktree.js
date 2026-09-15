// 任务的隔离 worktree：建立、查看、清理。
//
// 每条改代码的任务一个 worktree，落在 userData/docking-worktrees/<仓库>/<分支>，主仓库不动。
// node_modules 软链到主仓库，所以一个 worktree 只多占一份检出的源码。
//
// 不 import electron：测试直接跑，cleanup 的 IPC 也要用。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { getDataDir, listTasks, updateTask } from "./task-store.js";

export function sanitizeBranchSlug(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
}

/** 分支名 → 这条任务的 worktree 目录。按仓库分组，路径稳定，续接会话才找得到同一个 cwd */
export function worktreePathFor(cwd, branchName) {
  let real = cwd;
  try {
    real = fs.realpathSync(cwd);
  } catch (_) {}
  const repoKey = `${path.basename(real)}-${crypto
    .createHash("sha1")
    .update(real)
    .digest("hex")
    .slice(0, 8)}`;
  return path.join(getDataDir(), "docking-worktrees", repoKey, branchName.replace(/\//g, "__"));
}

/** 解析 `git worktree list --porcelain`，第一项永远是主工作区 */
function listWorktrees(git) {
  return git(["worktree", "list", "--porcelain"])
    .split("\n\n")
    .map((block) => {
      const entry = {};
      for (const line of block.split("\n")) {
        if (line.startsWith("worktree ")) entry.path = line.slice(9);
        else if (line.startsWith("branch ")) entry.branch = line.slice(7).replace(/^refs\/heads\//, "");
      }
      return entry;
    })
    .filter((e) => e.path);
}

const samePath = (a, b) => {
  if (!a || !b) return false;
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch (_) {
    return path.resolve(a) === path.resolve(b);
  }
};

/**
 * 把主仓库的 node_modules 软链进 worktree，省掉每条任务装一遍依赖。
 *
 * 只找浅层的（根目录与 monorepo 子包，深度 ≤ 3），不进 node_modules 和隐藏目录。
 * worktree 里对应目录不存在（未跟踪的子包）或已经有 node_modules 的都跳过。
 *
 * 软链会被 git 当成普通文件：`.gitignore` 里的 `node_modules/` 带斜杠，只匹配目录，
 * 匹配不到软链——不处理的话 AI 一个 `git add -A` 就把它提交了。
 * 所以没被忽略的那几条写进公共的 info/exclude（主工作区本来就忽略 node_modules，不受影响）。
 */
function linkNodeModules(git, repoDir, workdir, emitLog) {
  const found = [];
  const walk = (rel, depth) => {
    const abs = path.join(repoDir, rel);
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
      const childRel = rel ? path.join(rel, ent.name) : ent.name;
      if (ent.name === "node_modules") found.push(childRel);
      else if (depth < 3) walk(childRel, depth + 1);
    }
  };
  walk("", 0);

  const linked = [];
  for (const rel of found) {
    const target = path.join(workdir, rel);
    if (!fs.existsSync(path.dirname(target))) continue;
    try {
      const st = fs.lstatSync(target);
      if (st.isSymbolicLink() && !fs.existsSync(target)) {
        try {
          fs.unlinkSync(target);
        } catch (_) {}
      } else {
        continue; // 已有且有效（上一轮链过，或 AI 自己装过），不动
      }
    } catch (_) {}
    fs.symlinkSync(path.join(repoDir, rel), target, "dir");
    linked.push(rel);
  }
  if (!linked.length) return;

  const unignored = linked.filter((rel) => {
    try {
      git(["-C", workdir, "check-ignore", "-q", rel]);
      return false;
    } catch (_) {
      return true;
    }
  });
  if (unignored.length) {
    const commonDir = path.resolve(
      workdir,
      git(["-C", workdir, "rev-parse", "--git-common-dir"]).trim(),
    );
    const excludeFile = path.join(commonDir, "info", "exclude");
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    const existing = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, "utf8") : "";
    const lines = unignored
      .map((rel) => `/${rel.split(path.sep).join("/")}`)
      .filter((line) => !existing.split("\n").includes(line));
    if (lines.length) {
      fs.appendFileSync(
        excludeFile,
        `${existing && !existing.endsWith("\n") ? "\n" : ""}# vjtools 工单台 worktree 的 node_modules 软链\n${lines.join("\n")}\n`,
      );
    }
  }
  emitLog("meta", `🔗 已软链主仓库依赖: ${linked.join("、")}`);
}

/**
 * 执行前给任务准备隔离 worktree。
 *
 * 以前是在主仓库里直接 checkout 隔离分支：AI 跑的时候你自己的工作区被切走，
 * 跑完也不切回来；工作区一脏就派不了活；同一仓库的改代码任务只能排队。
 * 现在每条任务一个 worktree，落在 userData/docking-worktrees/ 下，主仓库完全不动。
 *
 * 返回 { ok, branchName, workdir, error }：
 *   - 不需要隔离（没开开关 / analyze 只读档）/ 不是 git 仓库 → ok:true，workdir 就是 cwd
 *   - 建 worktree 失败 → ok:false，**调用方必须中止本次 job**。
 *     隔离开着却建不出来，还硬在主仓库里让 AI 改代码，比不隔离更危险。
 *
 * 任务已经有 branchName（澄清后恢复执行的第二轮）时回到那条分支的 worktree，
 * 否则按 tasks[0] 的短号+标题新建，从主仓库当前 HEAD 拉出。
 */
export function setupWorktree({ cwd, tasks, createBranch, mode, emitLog = () => {} }) {
  const skip = { ok: true, branchName: "", workdir: cwd };
  if (!createBranch || mode === "analyze" || !tasks || tasks.length === 0) return skip;

  const git = (args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

  // 1. 不是仓库就没得隔离，但也没必要拦着不跑
  try {
    if (git(["rev-parse", "--is-inside-work-tree"]).trim() !== "true") throw new Error();
  } catch (_) {
    emitLog("meta", "⚠️ 该目录不是 Git 仓库，跳过隔离 worktree");
    return skip;
  }

  // 2. 分支名。恢复执行时沿用任务上已有的那条
  const firstTask = tasks[0];
  const existing = tasks.find((t) => t.branchName)?.branchName || "";
  const slug = sanitizeBranchSlug(firstTask.title) || "docking-task";
  const branchName = existing || `docking/seq-${firstTask.seq || 1}-${slug}`;

  try {
    // 目录被人手动删掉的 worktree，git 那边的登记先清掉，否则 add 会说已存在
    git(["worktree", "prune"]);
    const worktrees = listWorktrees(git);
    const holder = worktrees.find((w) => w.branch === branchName);
    let workdir = worktreePathFor(cwd, branchName);

    if (holder && samePath(holder.path, worktrees[0].path)) {
      // 旧版隔离分支是直接 checkout 在主仓库里的，git 不允许同一分支检出两处
      return {
        ok: false,
        branchName: "",
        workdir: cwd,
        error:
          `分支 ${branchName} 正检出在主仓库里（旧版隔离分支的残留），无法再建 worktree。\n` +
          "请先在主仓库切回其他分支，再重新派活。",
      };
    }

    if (holder) {
      // git 报的是 realpath，跟算出来的路径可能差一层软链（/var → /private/var）。
      // 同一个目录就沿用算出来的写法：续接会话按路径字符串比对，前后两轮必须一致
      if (!samePath(holder.path, workdir)) workdir = holder.path;
      emitLog("meta", `🌿 复用隔离 worktree: ${branchName} → ${workdir}`);
    } else {
      // 走到这里说明该路径没有登记在册的 worktree；目录还在就是上次半途失败的残骸，
      // 在我们自己管的目录里，清掉重建
      if (fs.existsSync(workdir)) fs.rmSync(workdir, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(workdir), { recursive: true });

      let branchExists = false;
      try {
        git(["rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`]);
        branchExists = true;
      } catch (_) {}

      const base = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
      const baseCommit = git(["rev-parse", "HEAD"]).trim();
      git(
        branchExists
          ? ["worktree", "add", workdir, branchName]
          : ["worktree", "add", "-b", branchName, workdir, "HEAD"],
      );
      emitLog(
        "meta",
        branchExists
          ? `🌿 为既有分支建隔离 worktree: ${branchName} → ${workdir}`
          : `🌿 已从 ${base} 拉出隔离 worktree: ${branchName} → ${workdir}`,
      );

      // 主仓库没提交的改动不会跟进 worktree。不拦，但得说一声，免得 AI 基于旧代码改完才发现
      const dirty = git(["status", "--porcelain", "--untracked-files=no"]).trim();
      if (dirty && !branchExists) {
        emitLog("meta", "⚠️ 主仓库有未提交的改动，这些改动不在 worktree 里");
      }
      // 记下从哪拉出来的：清理前看「AI 多了哪些提交、改了什么」要以它为基线
      if (!branchExists) {
        for (const t of tasks) updateTask(t.id, { worktreeBase: { branch: base, commit: baseCommit } });
      }
    }

    linkNodeModules(git, cwd, workdir, emitLog);

    for (const t of tasks) {
      updateTask(t.id, { branchName, worktreePath: workdir });
      t.branchName = branchName;
      t.worktreePath = workdir;
    }

    return { ok: true, branchName, workdir };
  } catch (err) {
    const detail = String(err.stderr || "").trim() || err.message;
    return {
      ok: false,
      branchName: "",
      workdir: cwd,
      error: `创建隔离 worktree ${branchName} 失败: ${detail}`,
    };
  }
}

// ─── 查看与清理 ──────────────────────────────────────────────────────────────

const WORKTREE_ROOT_NAME = "docking-worktrees";

function gitIn(cwd) {
  return (args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
}

const tryGit = (git, args) => {
  try {
    return git(args);
  } catch (_) {
    return null;
  }
};

/** 目录体积，不跟软链走——worktree 里的 node_modules 是主仓库的，不能算进来 */
function dirBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return 0;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    try {
      if (ent.isSymbolicLink()) continue;
      total += ent.isDirectory() ? dirBytes(full) : fs.lstatSync(full).size;
    } catch (_) {}
  }
  return total;
}

/**
 * 先把 worktree 里的软链摘掉再删目录。
 * git worktree remove 和 fs.rmSync 按理都不跟软链，但删错一次就是把主仓库的依赖整个抹掉，
 * 不赌实现细节。
 */
function unlinkSymlinks(dir, depth = 0) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isSymbolicLink()) {
      if (ent.name === "node_modules") {
        try {
          fs.unlinkSync(full);
        } catch (_) {}
      }
    } else if (ent.isDirectory() && depth < 3 && ent.name !== ".git" && ent.name !== "node_modules") {
      unlinkSymlinks(full, depth + 1);
    }
  }
}

/** 这条任务的基线提交。老任务没记 worktreeBase 的，退回跟主仓库当前 HEAD 的分叉点 */
function resolveBase(git, task) {
  const recorded = task.worktreeBase?.commit;
  if (recorded && tryGit(git, ["cat-file", "-e", `${recorded}^{commit}`]) !== null) return recorded;
  return tryGit(git, ["merge-base", "HEAD", task.branchName])?.trim() || "";
}

/**
 * 清理前给人看的现状：未提交改动、比基线多出的提交、改动规模、有没有合进主仓库当前分支。
 * 主仓库不是 git 仓库或分支已经没了，就只回 exists:false。
 */
export function getWorktreeInfo(task) {
  const empty = { exists: false, branchExists: false, path: task?.worktreePath || "", branch: task?.branchName || "" };
  if (!task?.branchName || !task.repoPath) return empty;
  const git = gitIn(task.repoPath);
  if (tryGit(git, ["rev-parse", "--verify", "--quiet", `refs/heads/${task.branchName}`]) === null) {
    return empty;
  }

  tryGit(git, ["worktree", "prune"]);
  const holder = (tryGit(git, ["worktree", "list", "--porcelain"]) !== null ? listWorktrees(git) : []).find(
    (w) => w.branch === task.branchName,
  );
  const wtPath = holder?.path || task.worktreePath || "";
  const exists = Boolean(holder) && fs.existsSync(wtPath);
  const base = resolveBase(git, task);

  const commits = base
    ? (tryGit(git, ["log", "--format=%h%x09%s", `${base}..${task.branchName}`]) || "")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [sha, ...rest] = line.split("\t");
          return { sha, subject: rest.join("\t") };
        })
    : [];

  let dirty = [];
  let shortstat = "";
  if (exists) {
    const wt = gitIn(wtPath);
    dirty = (tryGit(wt, ["status", "--porcelain"]) || "").split("\n").filter(Boolean);
    if (base) shortstat = (tryGit(wt, ["diff", "--shortstat", base]) || "").trim();
  } else if (base) {
    shortstat = (tryGit(git, ["diff", "--shortstat", base, task.branchName]) || "").trim();
  }

  const mainBranch = (tryGit(git, ["rev-parse", "--abbrev-ref", "HEAD"]) || "").trim();
  const merged =
    commits.length > 0 &&
    tryGit(git, ["merge-base", "--is-ancestor", task.branchName, "HEAD"]) !== null;

  return {
    exists,
    branchExists: true,
    path: wtPath,
    branch: task.branchName,
    baseBranch: task.worktreeBase?.branch || "",
    mainBranch,
    commits,
    dirty: dirty.slice(0, 50),
    dirtyCount: dirty.length,
    shortstat,
    merged,
    bytes: exists ? dirBytes(wtPath) : 0,
  };
}

/**
 * 删掉一个 worktree 目录。未提交的改动先提交到它的分支上，所以只要分支在，什么都不丢。
 *
 * --no-verify：仓库的 pre-commit 钩子（lint、测试）在这里跑没有意义，挂了反而删不掉。
 * 仓库没配提交人时用一个固定身份兜底，不去改用户的 git 配置。
 */
function removeWorktreeDir({ repo, wtPath, branch, label }) {
  const result = { savedCommit: "", removed: false };
  const wt = gitIn(wtPath);
  const isWorktree = fs.existsSync(wtPath) && tryGit(wt, ["rev-parse", "--is-inside-work-tree"]) !== null;

  if (isWorktree) {
    unlinkSymlinks(wtPath);
    const dirty = (tryGit(wt, ["status", "--porcelain"]) || "").trim();
    if (dirty) {
      const hasName = Boolean((tryGit(wt, ["config", "user.name"]) || "").trim());
      const hasEmail = Boolean((tryGit(wt, ["config", "user.email"]) || "").trim());
      const identity = [];
      if (!hasName) identity.push("-c", "user.name=vjtools");
      if (!hasEmail) identity.push("-c", "user.email=vjtools@localhost");
      wt(["add", "-A"]);
      // 提交失败必须中止，不能吞掉接着删：改动没进分支，目录一删就彻底没了。
      // 常见原因是仓库强制签名（commit.gpgsign）而签名环境不可用
      try {
        wt([
          ...identity,
          "commit",
          "--no-verify",
          "-qm",
          `docking: ${label || branch} 的未提交改动（清理 worktree 时自动保存）`,
        ]);
      } catch (err) {
        const detail = String(err.stderr || "").trim() || err.message;
        throw new Error(`未提交的改动没能存进分支，已中止清理，worktree 原样保留：${detail}`, {
          cause: err,
        });
      }
      result.savedCommit = wt(["rev-parse", "--short", "HEAD"]).trim();
    }
    if (repo && fs.existsSync(repo)) {
      const repoGit = gitIn(repo);
      if (tryGit(repoGit, ["worktree", "remove", "--force", wtPath]) === null) {
        fs.rmSync(wtPath, { recursive: true, force: true });
      }
    } else {
      fs.rmSync(wtPath, { recursive: true, force: true });
    }
  } else if (fs.existsSync(wtPath)) {
    unlinkSymlinks(wtPath);
    fs.rmSync(wtPath, { recursive: true, force: true });
  }
  if (repo && fs.existsSync(repo)) tryGit(gitIn(repo), ["worktree", "prune"]);
  result.removed = !fs.existsSync(wtPath);
  return result;
}

/**
 * 清理一条任务的 worktree。
 *
 * 默认保留分支：未提交改动已经存进分支，下次再派活会在同一路径上重建 worktree，
 * 续接会话也还对得上。deleteBranch 才真删分支——那是丢数据的操作，调用方负责二次确认。
 */
export function cleanupTaskWorktree(task, { deleteBranch = false } = {}) {
  if (!task?.branchName || !task.repoPath) throw new Error("这条任务没有隔离 worktree");
  const repoGit = gitIn(task.repoPath);
  tryGit(repoGit, ["worktree", "prune"]);
  const worktrees = listWorktrees(repoGit);
  const holder = worktrees.find((w) => w.branch === task.branchName);
  if (holder && worktrees[0]?.path && samePath(holder.path, worktrees[0].path)) {
    throw new Error(`分支 ${task.branchName} 检出在主仓库里，不是工单台的 worktree，不清理`);
  }
  const wtPath = holder?.path || task.worktreePath || worktreePathFor(task.repoPath, task.branchName);
  if (samePath(wtPath, task.repoPath)) {
    throw new Error(`分支检出在主仓库中或路径相同（${wtPath}），拒绝清理`);
  }

  const result = removeWorktreeDir({
    repo: task.repoPath,
    wtPath,
    branch: task.branchName,
    label: `#${task.seq} ${task.title}`,
  });

  const allRelatedTasks = listTasks().filter(
    (t) =>
      t.id === task.id ||
      (t.repoPath === task.repoPath && (t.branchName === task.branchName || samePath(t.worktreePath, wtPath))),
  );

  if (deleteBranch) {
    if (tryGit(repoGit, ["rev-parse", "--verify", "--quiet", `refs/heads/${task.branchName}`]) !== null) {
      repoGit(["branch", "-D", task.branchName]);
    }
    result.branchDeleted = true;
    for (const t of allRelatedTasks) {
      updateTask(t.id, { worktreePath: "", branchName: "", worktreeBase: null, agentSession: null });
    }
  } else {
    for (const t of allRelatedTasks) {
      updateTask(t.id, { worktreePath: "" });
    }
  }
  return result;
}

/** 某个 worktree 目录属于哪个仓库、哪条分支。目录坏了（不再是 git 工作区）返回 null */
function inspectWorktreeDir(wtPath) {
  const wt = gitIn(wtPath);
  const common = tryGit(wt, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common === null) return null;
  return {
    repo: path.dirname(common.trim()),
    branch: (tryGit(wt, ["rev-parse", "--abbrev-ref", "HEAD"]) || "").trim(),
  };
}

/** 工单台建过的所有 worktree 目录 */
function allWorktreeDirs() {
  const root = path.join(getDataDir(), WORKTREE_ROOT_NAME);
  const dirs = [];
  for (const repoDir of safeReaddir(root)) {
    for (const wt of safeReaddir(path.join(root, repoDir))) dirs.push(path.join(root, repoDir, wt));
  }
  return dirs;
}

function safeReaddir(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (_) {
    return [];
  }
}

/**
 * 批量清理可以收掉的 worktree：任务已完成 / 已忽略 / 已被删掉的。
 * 进行中、待处理、等回复的不碰；正在跑 job 的（isBusy）也不碰。分支一律保留。
 */
function collectStale(tasks, isBusy) {
  const stale = [];
  for (const dir of allWorktreeDirs()) {
    const matching = tasks.filter((t) => t.worktreePath && samePath(t.worktreePath, dir));
    // 如果有任何一个关联任务还在进行中（非 done/ignored）或者正在跑，就绝对不能清理
    if (matching.some((t) => !["done", "ignored"].includes(t.status) || isBusy(t.id))) continue;
    stale.push({ dir, tasks: matching, task: matching[0] });
  }
  return stale;
}

export function staleWorktreesBytes({ tasks = [], isBusy = () => false } = {}) {
  return collectStale(tasks, isBusy).reduce((sum, { dir }) => sum + dirBytes(dir), 0);
}

export function cleanupStaleWorktrees({ tasks = [], isBusy = () => false } = {}) {
  const summary = { removed: 0, saved: 0, failed: [], reclaimedBytes: 0 };
  for (const { dir, tasks: matchingTasks, task } of collectStale(tasks, isBusy)) {
    const bytes = dirBytes(dir);
    try {
      const where = inspectWorktreeDir(dir);
      const res = removeWorktreeDir({
        repo: task?.repoPath || where?.repo || "",
        wtPath: dir,
        branch: task?.branchName || where?.branch || "",
        label: task ? `#${task.seq} ${task.title}` : "",
      });
      if (res.savedCommit) summary.saved += 1;
      if (res.removed) {
        summary.removed += 1;
        summary.reclaimedBytes += bytes;
        for (const t of (matchingTasks || [])) {
          updateTask(t.id, { worktreePath: "" });
        }
      }
    } catch (err) {
      summary.failed.push(`${path.basename(dir)}: ${err.message}`);
    }
  }
  return summary;
}
