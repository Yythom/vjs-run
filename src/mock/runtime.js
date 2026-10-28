// mock-runtime.json：记录「当前是谁在跑 mock」，app 和 vjtools CLI 共用。
// 放在 mock-assets 目录（与 applied-scene.json 同级），两边都能从 mockRulesFile 推出来。
//
// 只信 pid 不够：进程崩溃后文件残留，pid 还可能被系统复用。所以判定「真在跑」
// 要同时满足 pid 存活 + 端口上的 /__mock/health 返回的 pid 与记录一致。
//
// 纯 node 模块，不能 import electron（CLI 也要用）。

import fs from "node:fs";
import path from "node:path";

const RUNTIME_FILE = "mock-runtime.json";

export function mockRuntimeFile(mockAssetsDir) {
  return path.join(mockAssetsDir, RUNTIME_FILE);
}

/** 0.0.0.0 / :: 这类监听地址不能直接拿来访问，探测时换成回环地址 */
export function mockBaseUrl(host, port) {
  const reachable = !host || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${reachable}:${port}`;
}

export function readMockRuntime(mockAssetsDir) {
  try {
    const info = JSON.parse(fs.readFileSync(mockRuntimeFile(mockAssetsDir), "utf8"));
    return info && Number.isInteger(info.pid) ? info : null;
  } catch {
    return null;
  }
}

/** @param {{pid:number, owner:"app"|"cli", host:string, port:number, logFile?:string, version?:string}} info */
export function writeMockRuntime(mockAssetsDir, info) {
  const file = mockRuntimeFile(mockAssetsDir);
  fs.mkdirSync(mockAssetsDir, { recursive: true });
  const next = {
    ...info,
    url: mockBaseUrl(info.host, info.port),
    startedAt: new Date().toISOString(),
  };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return next;
}

/** 只删属于 pid 的记录，避免 A 停止时把 B 刚写的记录抹掉 */
export function clearMockRuntime(mockAssetsDir, pid) {
  const current = readMockRuntime(mockAssetsDir);
  if (current && pid !== undefined && current.pid !== pid) return;
  try {
    fs.rmSync(mockRuntimeFile(mockAssetsDir), { force: true });
  } catch {}
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM：进程存在但不归当前用户，仍算活着
    return err?.code === "EPERM";
  }
}

/** GET /__mock/health；不通 / 超时 / 不是 mock server 都返回 null */
export async function fetchMockHealth(url, timeoutMs = 1500) {
  try {
    const res = await fetch(`${url}/__mock/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.ok ? body : null;
  } catch {
    return null;
  }
}

/**
 * 读记录并核实：pid 活着且端口上的 mock 就是它，才返回记录（附带 health）。
 * 记录残留（pid 已死）时顺手清掉。
 */
export async function findLiveMockRuntime(mockAssetsDir) {
  const info = readMockRuntime(mockAssetsDir);
  if (!info) return null;
  if (!isPidAlive(info.pid)) {
    clearMockRuntime(mockAssetsDir, info.pid);
    return null;
  }
  const health = await fetchMockHealth(info.url);
  if (!health || health.pid !== info.pid) return null;
  return { ...info, health };
}
