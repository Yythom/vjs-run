// 改动测试台 IPC：把 commit-range-test 派给 T3 Code 跑，界面看清单、回复确认点。
// 编排都在 services/range-test，这里只做 channel 映射。

import { shell } from "electron";
import { ipcSafe } from "./safe.js";
import {
  continueRun,
  getCandidates,
  getCheck,
  getDetail,
  getDevPorts,
  getFixCommits,
  getRecords,
  getSkillInfo,
  getT3Models,
  readAsset,
  replyRun,
  startRun,
  threadLinkOf,
} from "../services/range-test/index.js";

export function registerRangeTestIpc() {
  ipcSafe("range-test-candidates", (_, payload = {}) => getCandidates(payload));
  ipcSafe("range-test-list", () => getRecords());
  ipcSafe("range-test-start", (_, payload = {}) => startRun(payload));
  ipcSafe("range-test-detail", (_, payload = {}) => getDetail(payload));
  ipcSafe("range-test-check", (_, payload = {}) => getCheck(payload));
  ipcSafe("range-test-reply", (_, payload = {}) => replyRun(payload));
  ipcSafe("range-test-continue", (_, payload = {}) => continueRun(payload));
  ipcSafe("range-test-fix-commits", (_, payload = {}) => getFixCommits(payload));
  ipcSafe("range-test-ports", () => getDevPorts());
  ipcSafe("range-test-skill", () => getSkillInfo());
  ipcSafe("range-test-models", () => getT3Models());
  ipcSafe("range-test-open-thread", async (_, payload = {}) => {
    await shell.openExternal(threadLinkOf(payload));
  });
  ipcSafe("range-test-asset", (_, payload = {}) => readAsset(payload));
  // 证据里引用了产物目录以外的文件时，界面只给路径，点了在访达里定位
  ipcSafe("range-test-reveal", (_, payload = {}) => {
    shell.showItemInFolder(String(payload.path || ""));
  });
}
