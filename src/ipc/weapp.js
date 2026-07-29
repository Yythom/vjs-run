// 小程序发布 IPC：start-weapp-deploy（构建 + 上传微信 CI）、stop-weapp-deploy（终止）。
// 仓库目录由用户在页面上用系统文件选择器指定，不依赖 frontendProjectGroups 配置。

import fs from "node:fs";
import path from "node:path";
import { ipcSafe } from "./safe.js";
import { runWeappDeploy, abortWeappDeploy } from "../services/weapp-deploy.js";
import { listBranches } from "../services/git-repo.js";

/**
 * 校验渲染层传来的目录路径，返回 runWeappDeploy / listBranches 需要的 repo 形态。
 * 路径直接来自用户选择，落地前必须确认它真的是个存在的目录。
 */
function requireRepoDir(repoPath) {
  const dir = String(repoPath || "").trim();
  if (!dir) throw new Error("请先选择小程序仓库目录");
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch {
    throw new Error(`目录不存在：${dir}`);
  }
  if (!stat.isDirectory()) throw new Error(`不是一个目录：${dir}`);
  return { label: path.basename(dir) || dir, path: dir };
}

export function registerWeappIpc() {
  // 本地分支列表 + 当前分支，供发布页的分支下拉渲染
  ipcSafe("get-repo-branches", (_, payload = {}) =>
    listBranches(requireRepoDir(payload.repoPath).path),
  );

  ipcSafe("start-weapp-deploy", (_, payload = {}) =>
    runWeappDeploy(requireRepoDir(payload.repoPath), {
      robot: payload.robot,
      branch: payload.branch,
      pullLatest: payload.pullLatest,
    }),
  );

  ipcSafe("stop-weapp-deploy", () => abortWeappDeploy());
}
