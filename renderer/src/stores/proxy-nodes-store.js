import { create } from "zustand";
import PQueue from "p-queue";

/**
 * 节点测速 store。
 * 节点列表以主进程的 proxy-nodes.json 为准，这里只是镜像；
 * 测速调度放在这里而不是页面里：切走页面也不会打断正在跑的测速。
 */

const CONCURRENCY = 8;
// 下载测速偏好只是本机便利设置，放 localStorage；读写失败就只在本次会话生效
const PREF_KEYS = {
  downloadUrl: "vjtools.proxy.downloadUrl",
  downloadSeconds: "vjtools.proxy.downloadSeconds",
  downloadMegabytes: "vjtools.proxy.downloadMegabytes",
};
const PREF_DEFAULTS = { downloadUrl: "", downloadSeconds: "10", downloadMegabytes: "" };

function readPref(name) {
  try {
    const v = window.localStorage.getItem(PREF_KEYS[name]);
    return v === null ? PREF_DEFAULTS[name] : v;
  } catch {
    return PREF_DEFAULTS[name];
  }
}

const useProxyNodesStore = create(() => ({
  nodes: [],
  loaded: false,
  running: null, // null | "latency" | "download"
  testingIds: {}, // { [id]: true }
  downloadProgress: {}, // { [id]: { bytes, ms, speed, traffic } } 只存进行中的
  downloadUrl: readPref("downloadUrl"), // 空串 = 用主进程默认地址
  downloadSeconds: readPref("downloadSeconds"), // 时长上限（秒），空串 = 不限
  downloadMegabytes: readPref("downloadMegabytes"), // 流量上限（MB），空串 = 不限
  defaultDownloadUrl: "",
}));

export const useProxyNodes = () => useProxyNodesStore((s) => s.nodes);
export const useProxyNodesLoaded = () => useProxyNodesStore((s) => s.loaded);
export const useProxyTestRunning = () => useProxyNodesStore((s) => s.running);
export const useProxyNodeTesting = (id) => useProxyNodesStore((s) => Boolean(s.testingIds[id]));
export const useProxyDownloadProgress = (id) => useProxyNodesStore((s) => s.downloadProgress[id]);
export const useProxyDownloadPref = (name) => useProxyNodesStore((s) => s[name]);
export const useProxyDefaultDownloadUrl = () => useProxyNodesStore((s) => s.defaultDownloadUrl);

/** name ∈ downloadUrl | downloadSeconds | downloadMegabytes，值一律存字符串（输入框原样） */
export function setProxyDownloadPref(name, value) {
  useProxyNodesStore.setState({ [name]: value });
  try {
    window.localStorage.setItem(PREF_KEYS[name], value);
  } catch {
    // localStorage 不可用就只在本次会话生效
  }
}

/** 把偏好换算成主进程参数；两个上限都没填时返回 { error } */
export function getDownloadLimits() {
  const { downloadSeconds, downloadMegabytes } = useProxyNodesStore.getState();
  const seconds = Number(downloadSeconds);
  const mb = Number(downloadMegabytes);
  const maxDuration = downloadSeconds.trim() && seconds > 0 ? Math.round(seconds * 1000) : null;
  const maxBytes = downloadMegabytes.trim() && mb > 0 ? Math.round(mb * 1024 * 1024) : null;
  if (!maxDuration && !maxBytes) return { error: "时长上限和流量上限至少要填一个" };
  return { maxDuration, maxBytes };
}

let stopRequested = false;
let latencyQueue = null; // 进行中的延迟测试队列，停止时 clear 掉还没开始的

function unwrap(result) {
  if (!result?.success) throw new Error(result?.error || "未知错误");
  return result;
}

export async function loadProxyNodes() {
  const [list, defaults] = await Promise.all([
    window.electronAPI.listProxyNodes(),
    window.electronAPI.getProxyDefaults(),
  ]);
  const { nodes } = unwrap(list);
  useProxyNodesStore.setState({
    nodes,
    loaded: true,
    defaultDownloadUrl: defaults?.downloadUrl || "",
  });
}

export async function importProxyNodes(text) {
  const result = unwrap(await window.electronAPI.importProxyNodes(text));
  useProxyNodesStore.setState({ nodes: result.nodes });
  return result;
}

export async function setProxyNodesChecked(ids, checked) {
  const idSet = new Set(ids);
  // 乐观更新，勾选要跟手
  useProxyNodesStore.setState((s) => ({
    nodes: s.nodes.map((n) => (idSet.has(n.id) ? { ...n, checked } : n)),
  }));
  try {
    const { nodes } = unwrap(await window.electronAPI.setProxyNodesChecked(ids, checked));
    useProxyNodesStore.setState({ nodes });
  } catch (err) {
    await loadProxyNodes();
    throw err;
  }
}

export async function removeProxyNodes(ids) {
  const { nodes } = unwrap(await window.electronAPI.removeProxyNodes(ids));
  useProxyNodesStore.setState({ nodes });
}

function patchNode(node) {
  useProxyNodesStore.setState((s) => ({
    nodes: s.nodes.map((n) => (n.id === node.id ? node : n)),
  }));
}

function markTesting(id, on) {
  useProxyNodesStore.setState((s) => {
    const next = { ...s.testingIds };
    if (on) next[id] = true;
    else delete next[id];
    return { testingIds: next };
  });
}

/** 并发测一批节点的延迟；返回 { done, failed }。已有测速在跑时直接忽略 */
export async function testProxyNodes(ids, options = {}) {
  if (useProxyNodesStore.getState().running || !ids.length) return null;
  stopRequested = false;
  useProxyNodesStore.setState({ running: "latency" });

  let done = 0;
  let failed = 0;
  const testOne = async (id) => {
    markTesting(id, true);
    try {
      const { node } = unwrap(await window.electronAPI.testProxyNode(id, options));
      if (node) {
        patchNode(node);
        if (node.result?.delay == null && node.result?.tcp == null) failed += 1;
      }
    } catch {
      failed += 1;
    } finally {
      done += 1;
      markTesting(id, false);
    }
  };

  latencyQueue = new PQueue({ concurrency: CONCURRENCY });
  try {
    // 被 clear 掉的任务 promise 永远不会 settle，所以只等 onIdle，不 await addAll
    void latencyQueue.addAll(ids.map((id) => () => testOne(id)));
    await latencyQueue.onIdle();
  } finally {
    latencyQueue = null;
    useProxyNodesStore.setState({ running: null });
  }
  return { done, failed, stopped: stopRequested };
}

function setProgress(id, progress) {
  useProxyNodesStore.setState((s) => {
    const next = { ...s.downloadProgress };
    if (progress) next[id] = progress;
    else delete next[id];
    return { downloadProgress: next };
  });
}

/**
 * 逐个测下载速度（串行：并发会互相抢带宽，测出来的数没意义）。
 * 返回 { done, failed, stopped, traffic }，traffic 是这一批经过节点的总流量（字节）。
 */
export async function testProxyDownloads(ids) {
  if (useProxyNodesStore.getState().running || !ids.length) return null;
  stopRequested = false;
  useProxyNodesStore.setState({ running: "download" });
  const url = useProxyNodesStore.getState().downloadUrl.trim() || undefined;
  const { maxDuration, maxBytes } = getDownloadLimits();

  let done = 0;
  let failed = 0;
  let traffic = 0;
  try {
    for (const id of ids) {
      if (stopRequested) break;
      markTesting(id, true);
      try {
        const res = unwrap(
          await window.electronAPI.testProxyDownload(id, { url, maxDuration, maxBytes }),
        );
        // 中途停止的那个节点结果不落盘，但流量已经花掉了，按最后一次进度算
        if (res.aborted) {
          traffic += useProxyNodesStore.getState().downloadProgress[id]?.traffic || 0;
          break;
        }
        if (res.node) {
          patchNode(res.node);
          traffic += res.node.download?.traffic || 0;
          if (res.node.download?.speed == null) failed += 1;
        }
        done += 1;
      } catch {
        failed += 1;
        done += 1;
      } finally {
        markTesting(id, false);
        setProgress(id, null);
      }
    }
  } finally {
    useProxyNodesStore.setState({ running: null });
  }
  return { done, failed, stopped: stopRequested, traffic };
}

/** 停止：不再派发新节点，并掐断进行中的下载；在测的延迟最多再跑一个超时周期 */
export function stopProxyTests() {
  stopRequested = true;
  latencyQueue?.clear();
  window.electronAPI.abortProxyTests();
}

// ─── IPC 接线（模块首次 import 时执行一次，防 HMR 重复 attach）──────────────────
if (
  typeof window !== "undefined" &&
  window.electronAPI?.onProxyDownloadProgress &&
  !window.__PROXY_DOWNLOAD_WIRED__
) {
  window.electronAPI.onProxyDownloadProgress(({ id, ...progress }) => {
    // 迟到的进度（已经测完）不要再写回去
    if (useProxyNodesStore.getState().testingIds[id]) setProgress(id, progress);
  });
  window.__PROXY_DOWNLOAD_WIRED__ = true;
}
