// 录制 × 场景写入的互斥：node --test scripts/
//
// 录制把规则攥在内存里、每录到一条请求就整份重写场景文件；外部此时写进
// 同一个场景的内容会被悄悄冲掉。writeSceneRules 必须拒写正在录制的场景。
// scenesDir 用 mkdtemp，不碰真实用户数据。

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  handleRecordedEntry,
  readSceneRules,
  startRecording,
  stopRecording,
  writeSceneRules,
} from "../src/mock/recorder.js";

afterEach(() => stopRecording());

const tmpScenes = () => fs.mkdtempSync(path.join(os.tmpdir(), "mock-recorder-test-"));
const rule = (p) => ({ enabled: true, method: "GET", path: p, response: { p } });

test("录制中的场景拒绝外部写入，其他场景照常写", () => {
  const dir = tmpScenes();
  startRecording({ sceneName: "录制中", scenesDir: dir });

  assert.throws(
    () => writeSceneRules(dir, "录制中", [rule("/api/x")]),
    /场景「录制中」正在录制中，请先停止录制再写入/,
  );
  // 场景名清洗后同名也要拦（非法字符会被剔除）
  assert.throws(() => writeSceneRules(dir, "录制中?", [rule("/api/x")]), /正在录制中/);

  assert.equal(writeSceneRules(dir, "别的场景", [rule("/api/y")]), "别的场景");
  assert.equal(readSceneRules(dir, "别的场景").length, 1);
});

test("录制自身的写盘不受拦截；停止录制后可以正常写入", () => {
  const dir = tmpScenes();
  startRecording({ sceneName: "s", scenesDir: dir });
  handleRecordedEntry({
    kind: "proxy",
    method: "GET",
    path: "/api/rec",
    status: 200,
    responseIsJson: true,
    responseBody: { ok: true },
  });
  assert.deepEqual(readSceneRules(dir, "s").map((r) => r.path), ["/api/rec"]);

  stopRecording();
  writeSceneRules(dir, "s", [rule("/api/after")]);
  assert.deepEqual(readSceneRules(dir, "s").map((r) => r.path), ["/api/after"]);
});
