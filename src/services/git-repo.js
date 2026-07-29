// 仓库 git 信息读取。只做只读查询（当前分支 / 本地分支列表），
// 切分支这类会改工作区的操作走 runStreaming，好让用户在日志面板里看到全过程。
//
// 一律用 execFile + 参数数组，不拼 shell 字符串，避免分支名里的特殊字符被解释。

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildSpawnEnv } from "../shell-env.js";

const execFileAsync = promisify(execFile);

// 允许的分支名字符集。校验后才可以安全地拼进 runStreaming 的 shell 命令。
export const BRANCH_PATTERN = /^[\w./-]+$/;

async function git(repoPath, args) {
  if (!repoPath) throw new Error("仓库路径未配置");
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoPath,
      env: buildSpawnEnv(),
      maxBuffer: 1024 * 1024 * 4,
    });
    return stdout;
  } catch (err) {
    // git 的报错正文在 stderr，取第一行做人话提示，避免把整段 usage 抛给 UI
    const detail = String(err.stderr || err.message || "")
      .split("\n")
      .find((line) => line.trim());
    throw new Error(detail || "git 命令执行失败", { cause: err });
  }
}

export async function getCurrentBranch(repoPath) {
  const out = await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return out.trim();
}

/** 本地分支列表，按最近提交时间倒序（最常用的分支排在最前面） */
export async function listBranches(repoPath) {
  const out = await git(repoPath, [
    "for-each-ref",
    "--format=%(refname:short)",
    "--sort=-committerdate",
    "refs/heads",
  ]);
  const branches = out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return { current: await getCurrentBranch(repoPath), branches };
}

/** 工作区是否有未提交改动（含未跟踪文件） */
export async function hasUncommittedChanges(repoPath) {
  const out = await git(repoPath, ["status", "--porcelain"]);
  return out.trim().length > 0;
}
