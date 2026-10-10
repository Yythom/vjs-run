// 测速节点的持久化：userData/proxy-nodes.json。
// 落盘交给传进来的 key-value 存储：app 里是 electron-store，单测里是 conf（electron-store 的底层，
// 文件格式与原子写入一致，但不依赖 electron，纯 node 能跑）。只用到 get / set 两个方法。
// 节点量级是几十到几百条，整个数组读写足够；内存里留一份，避免每次 get 都重新读文件。

import crypto from "node:crypto";
import { parseSsLinks, nodeKey } from "./ss-link.js";

/** @param {{ get(key: string, fallback?: any): any, set(key: string, value: any): void }} kv */
export function createNodeStore(kv) {
  let nodes = null;

  function load() {
    if (nodes) return nodes;
    const data = kv.get("nodes", []);
    nodes = Array.isArray(data) ? data : [];
    return nodes;
  }

  function save() {
    kv.set("nodes", nodes);
  }

  return {
    list() {
      return load();
    },

    /**
     * 批量导入：新节点默认勾选。
     * 与已有节点重复（服务器+端口+加密+密码相同）时不新增，但用新链接刷新名称 / plugin，
     * 勾选状态保留；plugin 变了说明连法变了，旧测速结果作废。同批次内重复的直接跳过。
     */
    importText(text) {
      const list = load();
      const { nodes: parsed, invalid } = parseSsLinks(text);
      const byKey = new Map(list.map((n) => [nodeKey(n), n]));
      const batch = new Set();
      let added = 0;
      let updated = 0;
      let duplicated = 0;
      for (const node of parsed) {
        const key = nodeKey(node);
        if (batch.has(key)) {
          duplicated += 1;
          continue;
        }
        batch.add(key);
        const existing = byKey.get(key);
        if (!existing) {
          list.push({ id: crypto.randomUUID(), ...node, checked: true, result: null });
          added += 1;
        } else if (existing.raw !== node.raw) {
          if (existing.plugin !== node.plugin) {
            existing.result = null;
            existing.download = null;
          }
          Object.assign(existing, { name: node.name, plugin: node.plugin, raw: node.raw });
          updated += 1;
        } else {
          duplicated += 1;
        }
      }
      if (added || updated) save();
      return { added, updated, duplicated, invalid, nodes: list };
    },

    setChecked(ids, checked) {
      const idSet = new Set(ids);
      for (const node of load()) if (idSet.has(node.id)) node.checked = Boolean(checked);
      save();
      return nodes;
    },

    remove(ids) {
      const idSet = new Set(ids);
      nodes = load().filter((n) => !idSet.has(n.id));
      save();
      return nodes;
    },

    get(id) {
      return load().find((n) => n.id === id) || null;
    },

    /** 下载测速结果单独存 node.download，不和延迟结果互相覆盖 */
    saveDownload(id, download) {
      const node = load().find((n) => n.id === id);
      if (!node) return null;
      node.download = download;
      save();
      return node;
    },

    saveResult(id, result) {
      const node = load().find((n) => n.id === id);
      if (!node) return null;
      node.result = result;
      save();
      return node;
    },
  };
}
