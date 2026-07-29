// 小程序发布：在指定 repo 下带 DEPLOY_ENV / ROBOT 执行 pnpm deploy:weapp
// （构建 Taro 产物 + 上传微信 CI）。日志/状态都打到 WEAPP_DEPLOY_ID 这一个独立面板，
// 与清理 monorepo 同一套路。
//
// 只发测试服：DEPLOY_ENV 固定 staging，版本号由 deploy-weapp.js 内部固定为 0.0.1。
// 正式发布仍然走仓库自己的流水线，不从这里出口。

import fs from "node:fs/promises";
import path from "node:path";
import { sendLog, sendStatus } from "../ui-channel.js";
import { runStreaming } from "../process-manager.js";
import {
  BRANCH_PATTERN,
  getCurrentBranch,
  hasUncommittedChanges,
} from "./git-repo.js";

export const WEAPP_DEPLOY_ID = "__weapp_deploy__";

const DEPLOY_COMMAND = "pnpm deploy:weapp";
const DEPLOY_ENV = "staging";
// deploy-weapp.js 会按 ROBOT 就地改写这个文件里的 TARO_APP_API，发布结束后还原
const STAGING_ENV_FILE = ".env.staging";
const ROBOT_MIN = 1;
const ROBOT_MAX = 30;

// 同一时刻只允许跑一次发布。busy 覆盖整个序列（切分支 → 构建上传），
// currentChild 只是序列里当前那一条命令，两条命令之间它会是 null。
let busy = false;
let currentChild = null;
let aborted = false;

export function isWeappDeployRunning() {
  return busy;
}

/** 终止进行中的发布。无进行中任务时为 no-op。 */
export function abortWeappDeploy() {
  aborted = true;
  if (currentChild) {
    try {
      currentChild.kill("SIGTERM");
    } catch (_) {}
  }
}

/**
 * 校验机器人编号。校验失败直接抛错，由 ipcSafe 包成 { success:false } 返回给 UI。
 * 与页面上的 zod schema 是同一套规则，这里作为兜底（也挡住直接调 IPC 的情况）。
 */
function resolveRobot(robot) {
  const robotNumber = Number(robot);
  if (
    !Number.isInteger(robotNumber) ||
    robotNumber < ROBOT_MIN ||
    robotNumber > ROBOT_MAX
  ) {
    throw new Error(`CI 机器人编号需为 ${ROBOT_MIN}-${ROBOT_MAX} 的整数`);
  }
  return robotNumber;
}

/**
 * 取一份 .env.staging 的内容快照。文件不存在返回 null（deploy 脚本自己也允许这种情况）。
 * 存内容而不是走 git checkout --，是为了不误伤用户对这个文件已有的未提交改动。
 */
async function readStagingEnv(repoPath) {
  try {
    return await fs.readFile(path.join(repoPath, STAGING_ENV_FILE), "utf8");
  } catch {
    return null;
  }
}

/** 把 .env.staging 还原成发布前的样子。还原失败只告警，不影响发布结果。 */
async function restoreStagingEnv(repoPath, snapshot) {
  if (snapshot === null) return;
  const file = path.join(repoPath, STAGING_ENV_FILE);
  try {
    if ((await fs.readFile(file, "utf8")) === snapshot) return;
    await fs.writeFile(file, snapshot);
    sendLog(WEAPP_DEPLOY_ID, `\x1b[2m↩ 已还原 ${STAGING_ENV_FILE}\x1b[0m\n`);
  } catch (err) {
    sendLog(
      WEAPP_DEPLOY_ID,
      `\x1b[33m⚠ 还原 ${STAGING_ENV_FILE} 失败：${err.message}\x1b[0m\n`,
    );
  }
}

/** 删掉仓库顶层 dist（上一次的构建产物），deploy 脚本随后会重新构建它 */
async function cleanDist(repo, track) {
  sendLog(WEAPP_DEPLOY_ID, `\x1b[36m🧹 清理 dist\x1b[0m\n`);
  // 只删顶层 dist，cwd 已限定在 repo.path 下
  const { code } = await runStreaming(WEAPP_DEPLOY_ID, "rm -rf dist", {
    cwd: repo.path,
    onChild: track,
  });
  if (code !== 0) throw new Error("删除 dist 目录失败，已中止发布");
}

/** 装依赖。刻意排在切分支之后——要装的是目标分支的 lockfile，不是切换前那份 */
async function installDependencies(repo, track) {
  sendLog(WEAPP_DEPLOY_ID, `\x1b[36m📦 安装依赖\x1b[0m\n`);
  const { code } = await runStreaming(WEAPP_DEPLOY_ID, "pnpm install", {
    cwd: repo.path,
    onChild: track,
  });
  if (code !== 0) throw new Error("pnpm install 失败，已中止发布");
}

/**
 * 发布前把仓库切到目标分支（可选再 pull 一次）。
 * 已经在目标分支上就只打一行日志，不做多余的 checkout。
 */
async function prepareBranch(repo, { branch, pullLatest }, track) {
  if (!branch) return;
  if (!BRANCH_PATTERN.test(branch)) {
    throw new Error(`分支名不合法：${branch}`);
  }

  const current = await getCurrentBranch(repo.path);
  if (current === branch) {
    sendLog(WEAPP_DEPLOY_ID, `\x1b[2m🌿 当前已在分支 ${branch}\x1b[0m\n`);
  } else {
    // 工作区脏时 checkout 可能失败（或把改动带到新分支），先提醒再试
    if (await hasUncommittedChanges(repo.path)) {
      sendLog(
        WEAPP_DEPLOY_ID,
        `\x1b[33m⚠ 工作区有未提交改动，切分支可能失败或把改动带过去\x1b[0m\n`,
      );
    }
    sendLog(WEAPP_DEPLOY_ID, `\x1b[36m🌿 切换分支：${current} → ${branch}\x1b[0m\n`);
    const { code } = await runStreaming(
      WEAPP_DEPLOY_ID,
      `git checkout ${branch}`,
      { cwd: repo.path, onChild: track },
    );
    if (code !== 0) throw new Error(`切换到分支 ${branch} 失败，已中止发布`);
  }
  if (aborted) return;

  if (pullLatest) {
    // -r（--rebase）：把本地提交搬到远程之上，不产生 merge commit。
    // 注意冲突时 git 会停在 rebase 中间状态，需要去仓库里手动 --abort / 解冲突。
    const { code } = await runStreaming(WEAPP_DEPLOY_ID, "git pull -r", {
      cwd: repo.path,
      onChild: track,
    });
    if (code !== 0) throw new Error("git pull -r 失败，已中止发布");
  }
}

export async function runWeappDeploy(repo, options = {}) {
  if (!repo?.path) throw new Error(`${repo?.label || "Repo"} 路径未配置`);
  if (busy) throw new Error("已有发布任务在进行中");

  const robotNumber = resolveRobot(options.robot);

  busy = true;
  aborted = false;
  sendStatus(WEAPP_DEPLOY_ID, "starting");
  sendLog(
    WEAPP_DEPLOY_ID,
    `\x1b[36m📱 开始发布小程序 · ${repo.label}: ${repo.path}\x1b[0m\n`,
  );
  sendLog(
    WEAPP_DEPLOY_ID,
    `\x1b[2m环境=${DEPLOY_ENV}  机器人=${robotNumber}  版本=0.0.1（脚本内固定）\x1b[0m\n`,
  );
  sendLog(
    WEAPP_DEPLOY_ID,
    `\x1b[2m脚本会就地改写 ${STAGING_ENV_FILE}（TARO_APP_API），发布结束后自动还原\x1b[0m\n`,
  );

  const track = (proc) => {
    currentChild = proc;
  };

  // 快照必须在切分支之后取：不同分支的 .env.staging 内容可能不一样
  let stagingEnvSnapshot = null;

  try {
    await cleanDist(repo, track);
    if (aborted) return endAborted();

    await prepareBranch(repo, options, track);
    if (aborted) return endAborted();

    await installDependencies(repo, track);
    if (aborted) return endAborted();

    stagingEnvSnapshot = await readStagingEnv(repo.path);

    const { code } = await runStreaming(WEAPP_DEPLOY_ID, DEPLOY_COMMAND, {
      cwd: repo.path,
      env: {
        DEPLOY_ENV: DEPLOY_ENV,
        ROBOT: String(robotNumber),
      },
      onChild: track,
    });

    if (aborted) return endAborted();
    if (code !== 0) throw new Error(`发布失败（退出码 ${code}）`);

    sendLog(WEAPP_DEPLOY_ID, `\n\x1b[32m✔ 发布完成\x1b[0m\n`);
    sendStatus(WEAPP_DEPLOY_ID, "stopped");
  } catch (err) {
    sendLog(WEAPP_DEPLOY_ID, `\x1b[31m✗ ${err.message}\x1b[0m\n`);
    sendStatus(WEAPP_DEPLOY_ID, "error");
    throw err;
  } finally {
    // 成功 / 失败 / 中途终止都要还原，所以放在 finally
    await restoreStagingEnv(repo.path, stagingEnvSnapshot);
    currentChild = null;
    busy = false;
  }
}

function endAborted() {
  sendLog(WEAPP_DEPLOY_ID, `\n\x1b[33m■ 已终止发布\x1b[0m\n`);
  sendStatus(WEAPP_DEPLOY_ID, "stopped");
}
