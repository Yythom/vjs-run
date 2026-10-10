// ss:// 链接解析（纯函数，不依赖 electron，可直接 node --test）。
// 支持两种主流格式：
//   SIP002：ss://base64url(method:password)@host:port/?plugin=...#name
//          （2022 系列密码常以明文 method:password 出现在 userinfo，也兼容）
//   旧版  ：ss://base64(method:password@host:port)#name
// Shadowrocket 导出的就是这两种之一。

import { URLSearchParams } from "node:url";

function decodeBase64(str) {
  const normalized = str.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function safeDecodeURIComponent(str) {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

/** "host:port" / "[ipv6]:port" → { server, port } */
function splitHostPort(hostPort) {
  const m = hostPort.match(/^\[([^\]]+)\]:(\d+)$/) || hostPort.match(/^([^:]+):(\d+)$/);
  if (!m) return null;
  const port = Number(m[2]);
  if (!port || port > 65535) return null;
  return { server: m[1], port };
}

/** "method:password" → { method, password }（password 里可能还有冒号） */
function splitUserInfo(userInfo) {
  const idx = userInfo.indexOf(":");
  if (idx <= 0) return null;
  return {
    method: userInfo.slice(0, idx).toLowerCase(),
    password: userInfo.slice(idx + 1),
  };
}

/**
 * 解析单条 ss:// 链接。失败返回 null。
 * @returns {{ name, server, port, method, password, plugin, raw } | null}
 */
export function parseSsLink(link) {
  const raw = String(link || "").trim();
  if (!/^ss:\/\//i.test(raw)) return null;

  let body = raw.slice(5);
  let name = "";
  const hashIdx = body.indexOf("#");
  if (hashIdx >= 0) {
    name = safeDecodeURIComponent(body.slice(hashIdx + 1)).trim();
    body = body.slice(0, hashIdx);
  }

  let query = "";
  const qIdx = body.indexOf("?");
  if (qIdx >= 0) {
    query = body.slice(qIdx + 1);
    body = body.slice(0, qIdx);
  }
  body = body.replace(/\/$/, "");

  let userInfo;
  let hostPort;
  const atIdx = body.lastIndexOf("@");
  if (atIdx >= 0) {
    // SIP002：userinfo 可能是 base64，也可能是明文（percent-encoded）
    const rawUser = body.slice(0, atIdx);
    hostPort = body.slice(atIdx + 1);
    const plain = safeDecodeURIComponent(rawUser);
    if (plain.includes(":")) {
      userInfo = plain;
    } else {
      try {
        userInfo = decodeBase64(rawUser);
      } catch {
        return null;
      }
    }
  } else {
    // 旧版：整段 base64
    let decoded;
    try {
      decoded = decodeBase64(body);
    } catch {
      return null;
    }
    const at = decoded.lastIndexOf("@");
    if (at < 0) return null;
    userInfo = decoded.slice(0, at);
    hostPort = decoded.slice(at + 1);
  }

  const cred = splitUserInfo(userInfo || "");
  const addr = splitHostPort(hostPort || "");
  if (!cred || !addr) return null;

  const params = new URLSearchParams(query);
  const plugin = params.get("plugin") || "";

  return {
    name: name || `${addr.server}:${addr.port}`,
    server: addr.server,
    port: addr.port,
    method: cred.method,
    password: cred.password,
    plugin,
    raw,
  };
}

/** 同一节点的判重 key：服务器 + 端口 + 加密 + 密码，名称不同也算重复 */
export function nodeKey(node) {
  return `${node.server}:${node.port}|${node.method}|${node.password}`;
}

/**
 * 解析 plugin 字段："obfs-local;obfs=http;obfs-host=www.bing.com"
 * → { name: "obfs-local", opts: { obfs: "http", "obfs-host": "www.bing.com" } }
 */
export function parsePlugin(plugin) {
  if (!plugin) return null;
  const [name, ...pairs] = plugin.split(";");
  const opts = {};
  for (const pair of pairs) {
    const idx = pair.indexOf("=");
    if (idx > 0) opts[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    else if (pair.trim()) opts[pair.trim()] = true;
  }
  return { name: name.trim(), opts };
}

/**
 * 从一大段粘贴文本里提取所有 ss:// 链接。
 * 只在「换行」和「ss:// 开头处」切分：Shadowrocket 导出的 plugin 参数里有未编码的 ";"，
 * #名称 里可能有未编码的空格和中文标点，都不能当分隔符（曾经把 ";" 当分隔符，
 * 导致 obfs 参数和 #名称 被截掉）。
 * @returns {{ nodes: object[], invalid: string[] }}
 */
export function parseSsLinks(text) {
  const tokens = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    // 前面不能紧跟字母，否则 vmess:// 里的 "ss://" 也会被误抓
    for (const piece of line.split(/(?<![a-z])(?=ss:\/\/)/i)) {
      // 去掉首尾空白、粘贴时带进来的引号 / 尾随分隔符
      const token = piece.trim().replace(/^["'<]+|["'>,，;；]+$/g, "").trim();
      if (/^ss:\/\//i.test(token)) tokens.push(token);
    }
  }
  const nodes = [];
  const invalid = [];
  for (const token of tokens) {
    const node = parseSsLink(token);
    if (node) nodes.push(node);
    else invalid.push(token);
  }
  return { nodes, invalid };
}
