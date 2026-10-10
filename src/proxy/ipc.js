// 节点测速 IPC：导入 / 勾选 / 删除 / 单节点延迟测速 / 单节点下载测速。
// 并发调度放在渲染端（方便随时停止），主进程每次只测一个节点并落盘结果。
// 下载测速单次可能跑十几秒，进度通过 proxy-nodes:download-progress 推给发起的窗口，
// 停止时 proxy-nodes:abort 直接掐断进行中的下载。

import dns from "node:dns/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, dialog } from "electron";
import Store from "electron-store";
import { ipcSafe } from "../ipc/safe.js";
import { createNodeStore } from "./store.js";
import { parsePlugin } from "./ss-link.js";
import { isPluginSupported } from "./obfs.js";
import {
  isMethodSupported,
  tcpPing,
  urlTest,
  downloadTest,
  DEFAULT_TEST_URL,
  DEFAULT_DOWNLOAD_URL,
} from "./ss-client.js";

let store = null;
const activeDownloads = new Set(); // AbortController
function getStore() {
  // 构造要在 app ready 之后（electron-store 读 userData 路径）；IPC 被调用时早已 ready
  if (!store) store = createNodeStore(new Store({ name: "proxy-nodes", defaults: { nodes: [] } }));
  return store;
}

/** 不能经节点测速的原因；能测返回空串 */
function unsupportedReason(node) {
  const plugin = parsePlugin(node.plugin);
  if (!isPluginSupported(plugin)) return `不支持插件 ${plugin.name}`;
  if (!isMethodSupported(node.method)) return `不支持 ${node.method}`;
  return "";
}

/**
 * 198.18.0.0/15 是代理软件 TUN / 增强模式下 fake-ip 的惯用网段：
 * 解析到这里说明流量先进了本机代理，TCP 延迟测到的只是本机，不准。
 */
async function isFakeIp(server) {
  try {
    const { address } = await dns.lookup(server, { family: 4 });
    const [a, b] = address.split(".").map(Number);
    return a === 198 && (b === 18 || b === 19);
  } catch {
    return false;
  }
}

async function testNode(node, { url, timeout }) {
  const reason = unsupportedReason(node);
  const [tcp, real, fakeIp] = await Promise.allSettled([
    tcpPing(node, timeout),
    reason ? Promise.resolve(null) : urlTest(node, { url, timeout }),
    isFakeIp(node.server),
  ]);

  const note = reason ? `${reason}，仅测 TCP` : "";
  const errors = [];
  if (tcp.status === "rejected") errors.push(tcp.reason.message);
  if (real.status === "rejected") errors.push(real.reason.message);

  return {
    tcp: tcp.status === "fulfilled" ? tcp.value : null,
    delay: real.status === "fulfilled" && real.value ? real.value.delay : null,
    status: real.status === "fulfilled" && real.value ? real.value.status : null,
    error: errors.join("；") || null,
    note,
    fakeIp: fakeIp.status === "fulfilled" && fakeIp.value,
    testedAt: Date.now(),
  };
}

// 时长 1 秒 ~ 10 分钟，流量 1MB ~ 10GB；不填（null / 0）表示该项不限，但不能都不限
const MAX_DURATION_RANGE = [1000, 600000];
const MAX_BYTES_RANGE = [1024 * 1024, 10 * 1024 * 1024 * 1024];

function clampOrNull(value, [min, max]) {
  const n = Number(value);
  if (!value || !Number.isFinite(n) || n <= 0) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizeLimits(maxDuration, maxBytes) {
  const limits = {
    maxDuration: clampOrNull(maxDuration, MAX_DURATION_RANGE),
    maxBytes: clampOrNull(maxBytes, MAX_BYTES_RANGE),
  };
  if (!limits.maxDuration && !limits.maxBytes) {
    throw new Error("时长上限和流量上限至少要设一个");
  }
  return limits;
}

// Cloudflare __down 的 bytes 参数到 1 亿就返回 403（2026-10 实测），单轮取稍小一点
const CLOUDFLARE_MAX_BYTES = 95_000_000;

/**
 * 默认地址是 Cloudflare 的按需生成接口，bytes 参数就是文件大小。
 * 每轮要「剩余流量额度」和单轮上限中较小的那个；下完还没到上限 downloadTest 会再要下一轮。
 */
function nextDefaultUrl(remainingBytes) {
  const u = new URL(DEFAULT_DOWNLOAD_URL);
  const size = remainingBytes ? Math.min(remainingBytes, CLOUDFLARE_MAX_BYTES) : CLOUDFLARE_MAX_BYTES;
  u.searchParams.set("bytes", String(Math.max(1, size)));
  return u.toString();
}

export function registerProxyIpc() {
  ipcSafe("proxy-nodes:list", () => ({ nodes: getStore().list() }));

  ipcSafe("proxy-nodes:import", (_e, { text }) => getStore().importText(text));

  ipcSafe("proxy-nodes:set-checked", (_e, { ids, checked }) => ({
    nodes: getStore().setChecked(ids, checked),
  }));

  ipcSafe("proxy-nodes:remove", (_e, { ids }) => ({ nodes: getStore().remove(ids) }));

  ipcSafe("proxy-nodes:test", async (_e, { id, url = DEFAULT_TEST_URL, timeout = 5000 }) => {
    const node = getStore().get(id);
    if (!node) throw new Error("节点不存在");
    const result = await testNode(node, { url, timeout });
    return { node: getStore().saveResult(id, result) };
  });

  ipcSafe(
    "proxy-nodes:download-test",
    async (e, { id, url, maxDuration = 10000, maxBytes = null }) => {
      const node = getStore().get(id);
      if (!node) throw new Error("节点不存在");
      const limits = normalizeLimits(maxDuration, maxBytes);

      let download;
      const reason = unsupportedReason(node);
      if (reason) {
        download = {
          speed: null,
          bytes: 0,
          ms: 0,
          error: `${reason}，无法测下载`,
          unsupported: true,
          testedAt: Date.now(),
        };
      } else {
        const ac = new AbortController();
        activeDownloads.add(ac);
        try {
          const r = await downloadTest(node, {
            // 自定义地址只下一遍；默认地址按需续传直到上限
            ...(url ? { url } : { nextUrl: nextDefaultUrl }),
            ...limits,
            signal: ac.signal,
            onProgress: (p) => {
              if (!e.sender.isDestroyed()) e.sender.send("proxy-nodes:download-progress", { id, ...p });
            },
          });
          download = { ...r, ...limits, error: null, testedAt: Date.now() };
        } catch (err) {
          // 用户点停止的不落盘，保留上一次的结果
          if (ac.signal.aborted) return { node, aborted: true };
          download = {
            speed: null,
            bytes: 0,
            ms: 0,
            traffic: err.traffic || 0,
            error: err.message,
            testedAt: Date.now(),
          };
        } finally {
          activeDownloads.delete(ac);
        }
      }
      return { node: getStore().saveDownload(id, download) };
    },
  );

  // 导出勾选节点：内容由渲染端按当前排序拼好，这里只负责弹保存框和写文件
  ipcSafe("proxy-nodes:export-file", async (e, { content, defaultName }) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: "导出勾选节点",
      defaultPath: path.join(app.getPath("downloads"), defaultName || "ss-nodes.txt"),
      filters: [{ name: "文本文件", extensions: ["txt"] }],
    });
    if (canceled || !filePath) return { canceled: true };
    await fs.writeFile(filePath, content, "utf8");
    return { filePath };
  });

  ipcSafe("proxy-nodes:abort", () => {
    for (const ac of activeDownloads) ac.abort();
    return {};
  });

  ipcSafe("proxy-nodes:defaults", () => {
    const u = new URL(DEFAULT_DOWNLOAD_URL);
    return { downloadUrl: `${u.origin}${u.pathname}（文件大小按流量上限自动生成）` };
  });
}
