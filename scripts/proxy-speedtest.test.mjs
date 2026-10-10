// 节点测速：ss:// 解析、节点缓存、ss 客户端协议的测试。node --test scripts/
// 协议测试起一个本地假 ss 服务端：AEAD 部分按 SIP004 规范在测试里独立实现，
// 不复用 ss-client 的编解码，避免「自己跟自己对」掩盖规范层面的错。

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parseSsLink, parseSsLinks, parsePlugin } from "../src/proxy/ss-link.js";
import Conf from "conf";
import { createNodeStore as createStoreWithKv } from "../src/proxy/store.js";
import http from "node:http";
import https from "node:https";
import { execFileSync } from "node:child_process";
import {
  createCodec,
  evpBytesToKey,
  tcpPing,
  urlTest,
  downloadTest,
  openTunnel,
} from "../src/proxy/ss-client.js";

const b64url = (s) => Buffer.from(s).toString("base64url");

// app 里用 electron-store；单测用它的底层 conf，同样落到 <dir>/proxy-nodes.json
const createNodeStore = (dir) =>
  createStoreWithKv(new Conf({ cwd: dir, configName: "proxy-nodes", defaults: { nodes: [] } }));

// ─── 解析 ────────────────────────────────────────────────────────────────────

test("SIP002：base64url userinfo + 名称 + plugin", () => {
  const link = `ss://${b64url("aes-256-gcm:p@ss:word")}@1.2.3.4:8388/?plugin=obfs-local%3Bobfs%3Dhttp#%F0%9F%87%AD%F0%9F%87%B0%20%E9%A6%99%E6%B8%AF`;
  const node = parseSsLink(link);
  assert.equal(node.method, "aes-256-gcm");
  assert.equal(node.password, "p@ss:word");
  assert.equal(node.server, "1.2.3.4");
  assert.equal(node.port, 8388);
  assert.equal(node.plugin, "obfs-local;obfs=http");
  assert.equal(node.name, "🇭🇰 香港");
});

test("SIP002：明文 userinfo（2022 系列常见）与 IPv6", () => {
  const node = parseSsLink("ss://2022-blake3-aes-128-gcm:abc%3D%3D@[2001:db8::1]:443#v6");
  assert.equal(node.method, "2022-blake3-aes-128-gcm");
  assert.equal(node.password, "abc==");
  assert.equal(node.server, "2001:db8::1");
  assert.equal(node.port, 443);
});

test("旧版：整段 base64，无名称时用 host:port", () => {
  const node = parseSsLink(`ss://${Buffer.from("chacha20-ietf-poly1305:pwd@example.com:443").toString("base64")}`);
  assert.equal(node.method, "chacha20-ietf-poly1305");
  assert.equal(node.server, "example.com");
  assert.equal(node.name, "example.com:443");
});

test("批量：换行/空格混排，非法链接单独列出", () => {
  const a = `ss://${b64url("aes-128-gcm:a")}@a.com:1#A`;
  const b = `ss://${b64url("aes-128-gcm:b")}@b.com:2#B`;
  const { nodes, invalid } = parseSsLinks(`${a}\n\n  ${b} ss://garbage\nvmess://xxx`);
  assert.deepEqual(nodes.map((n) => n.name), ["A", "B"]);
  assert.equal(invalid.length, 1);
});

test("批量：Shadowrocket 导出的未编码 ; plugin 参数与 #名称 不被截断", () => {
  const link = `ss://${b64url("aes-128-gcm:pw")}@h.com:13007?plugin=obfs-local;obfs=http;obfs-host=www.bing.com#🇭🇰 香港 01`;
  const link2 = `ss://${b64url("aes-128-gcm:pw")}@h.com:13010?plugin=obfs-local;obfs=tls;obfs-host=a.com#日本，02`;
  // 两条首尾相连也要切开
  const { nodes, invalid } = parseSsLinks(`"${link}"\n  ${link2} ss://${b64url("aes-128-gcm:x")}@c.com:1#C,`);
  assert.equal(invalid.length, 0);
  assert.equal(nodes.length, 3);
  assert.equal(nodes[0].plugin, "obfs-local;obfs=http;obfs-host=www.bing.com");
  assert.equal(nodes[0].name, "🇭🇰 香港 01");
  assert.equal(nodes[1].name, "日本，02");
  assert.equal(nodes[2].name, "C");
  assert.deepEqual(parsePlugin(nodes[1].plugin), {
    name: "obfs-local",
    opts: { obfs: "tls", "obfs-host": "a.com" },
  });
});

// ─── 缓存 ────────────────────────────────────────────────────────────────────

test("store：导入默认勾选、去重、勾选与结果重启后仍在", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-store-"));
  const a = `ss://${b64url("aes-128-gcm:a")}@a.com:1#A`;
  const b = `ss://${b64url("aes-128-gcm:b")}@b.com:2#B`;
  const s1 = createNodeStore(dir);
  const r1 = s1.importText(`${a}\n${b}\n${a}`);
  assert.equal(r1.added, 2);
  assert.equal(r1.duplicated, 1);
  assert.ok(r1.nodes.every((n) => n.checked));

  const r2 = s1.importText(`ss://${b64url("aes-128-gcm:a")}@a.com:1#改了名字`);
  assert.equal(r2.added, 0);
  assert.equal(r2.updated, 1); // 同一节点换了名字：不新增，只刷新名称

  const [nodeA, nodeB] = s1.list();
  s1.setChecked([nodeA.id], false);
  s1.saveResult(nodeB.id, { tcp: 12, delay: 88 });

  assert.ok(fs.existsSync(path.join(dir, "proxy-nodes.json")));
  const s2 = createNodeStore(dir); // 模拟重启：新实例从文件读
  const [a2, b2] = s2.list();
  assert.equal(a2.checked, false);
  assert.equal(b2.checked, true);
  assert.equal(b2.result.delay, 88);

  s2.remove([a2.id]);
  assert.equal(createNodeStore(dir).list().length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("store：重新导入同一节点会刷新名称 / plugin；plugin 变了清空旧结果，勾选保留", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-store-"));
  const s1 = createNodeStore(dir);
  const user = b64url("aes-128-gcm:pw");
  s1.importText(`ss://${user}@h.com:1?plugin=obfs-local`); // 当年被截断的样子
  const [n] = s1.list();
  s1.setChecked([n.id], false);
  s1.saveResult(n.id, { tcp: 3 });

  const r = s1.importText(`ss://${user}@h.com:1?plugin=obfs-local;obfs=http;obfs-host=b.com#香港`);
  assert.equal(r.added, 0);
  assert.equal(r.updated, 1);
  const [m] = createNodeStore(dir).list();
  assert.equal(m.id, n.id);
  assert.equal(m.name, "香港");
  assert.equal(m.plugin, "obfs-local;obfs=http;obfs-host=b.com");
  assert.equal(m.checked, false);
  assert.equal(m.result, null);

  assert.equal(s1.importText(`ss://${user}@h.com:1?plugin=obfs-local;obfs=http;obfs-host=b.com#香港`).duplicated, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── 协议 ────────────────────────────────────────────────────────────────────

const HTTP_RESPONSE = "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n";

/** 按 SIP004 独立实现的 AEAD 服务端，收到 HTTP 请求后回 204 */
function startAeadServer(method, password) {
  const spec = {
    "aes-256-gcm": ["aes-256-gcm", 32],
    "aes-128-gcm": ["aes-128-gcm", 16],
    "chacha20-ietf-poly1305": ["chacha20-poly1305", 32],
  }[method];
  const [cipherName, keyLen] = spec;
  const master = evpBytesToKey(password, keyLen);
  const seen = [];

  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let rKey = null;
    let rNonce = 0n;
    const nonceBuf = (n) => {
      const b = Buffer.alloc(12);
      b.writeBigUInt64LE(n);
      return b;
    };
    const open = (sealed) => {
      const d = crypto.createDecipheriv(cipherName, rKey, nonceBuf(rNonce++), { authTagLength: 16 });
      d.setAuthTag(sealed.subarray(-16));
      return Buffer.concat([d.update(sealed.subarray(0, -16)), d.final()]);
    };
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!rKey) {
        if (buf.length < keyLen) return;
        rKey = Buffer.from(crypto.hkdfSync("sha1", master, buf.subarray(0, keyLen), "ss-subkey", keyLen));
        buf = buf.subarray(keyLen);
      }
      if (buf.length < 18) return;
      let len;
      try {
        len = open(buf.subarray(0, 18)).readUInt16BE(0);
      } catch {
        sock.destroy(); // 密码不对：真实服务端也是直接断开
        return;
      }
      if (buf.length < 18 + len + 16) {
        rNonce -= 1n; // 数据不够，回退重来
        return;
      }
      let payload;
      try {
        payload = open(buf.subarray(18, 18 + len + 16));
      } catch {
        sock.destroy();
        return;
      }
      seen.push(payload);
      // 回包：自己的 salt + 单个 chunk
      const salt = crypto.randomBytes(keyLen);
      const wKey = Buffer.from(crypto.hkdfSync("sha1", master, salt, "ss-subkey", keyLen));
      let wNonce = 0n;
      const seal = (plain) => {
        const c = crypto.createCipheriv(cipherName, wKey, nonceBuf(wNonce++), { authTagLength: 16 });
        return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
      };
      const body = Buffer.from(HTTP_RESPONSE);
      const lenBuf = Buffer.alloc(2);
      lenBuf.writeUInt16BE(body.length);
      // 拆成两次写，顺带验证客户端的分包拼接
      const out = Buffer.concat([salt, seal(lenBuf), seal(body)]);
      sock.write(out.subarray(0, 5));
      setTimeout(() => sock.end(out.subarray(5)), 20);
    });
    sock.on("error", () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, seen }));
  });
}

/** 流加密 / 明文服务端：复用 createCodec（同一对象的加解密方向互不干扰） */
function startCodecServer(method, password) {
  const server = net.createServer((sock) => {
    const codec = createCodec(method, password);
    let replied = false;
    sock.on("data", (chunk) => {
      const plain = codec.decrypt(chunk);
      if (!replied && plain.includes("\r\n\r\n")) {
        replied = true;
        sock.end(codec.encrypt(Buffer.from(HTTP_RESPONSE)));
      }
    });
    sock.on("error", () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

for (const method of ["aes-256-gcm", "aes-128-gcm", "chacha20-ietf-poly1305"]) {
  test(`urlTest：${method} 成功拿到 204，目标地址头正确`, async () => {
    const { server, port, seen } = await startAeadServer(method, "secret-pwd");
    try {
      const r = await urlTest(
        { server: "127.0.0.1", port, method, password: "secret-pwd" },
        { url: "http://www.gstatic.com/generate_204", timeout: 3000 },
      );
      assert.equal(r.status, 204);
      assert.ok(r.delay >= 0);
      const payload = seen[0];
      assert.equal(payload[0], 0x03);
      const host = payload.subarray(2, 2 + payload[1]).toString();
      assert.equal(host, "www.gstatic.com");
      assert.equal(payload.readUInt16BE(2 + payload[1]), 80);
      assert.match(payload.toString(), /GET \/generate_204 HTTP\/1\.1/);
    } finally {
      server.close();
    }
  });
}

test("urlTest：密码错误时报错而不是挂住", async () => {
  const { server, port } = await startAeadServer("aes-256-gcm", "right");
  try {
    await assert.rejects(
      urlTest({ server: "127.0.0.1", port, method: "aes-256-gcm", password: "wrong" }, { timeout: 2000 }),
      /关闭了连接|解密失败|不是 HTTP/,
    );
  } finally {
    server.close();
  }
});

for (const method of ["aes-256-cfb", "aes-128-ctr", "chacha20-ietf", "none"]) {
  test(`urlTest：流加密 ${method}`, async () => {
    const { server, port } = await startCodecServer(method, "pwd");
    try {
      const r = await urlTest({ server: "127.0.0.1", port, method, password: "pwd" }, { timeout: 3000 });
      assert.equal(r.status, 204);
    } finally {
      server.close();
    }
  });
}

test("tcpPing：通的端口返回毫秒，关闭的端口报错", async () => {
  const server = net.createServer((s) => s.end());
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  assert.ok((await tcpPing({ server: "127.0.0.1", port })) >= 0);
  server.close();
  await new Promise((r) => server.once("close", r));
  await assert.rejects(tcpPing({ server: "127.0.0.1", port }, 1000), /TCP/);
});

// ─── chacha 的纯 JS 路径（Electron 的 BoringSSL 不支持原生 chacha，走 @noble/ciphers）────

test("chacha 纯 JS 路径：与 OpenSSL 原生实现互通（AEAD 双向 + 流式任意分包）", async (t) => {
  if (!crypto.getCiphers().includes("chacha20-poly1305")) {
    t.skip("当前运行时没有原生 chacha，无法对拍");
    return;
  }
  const { ChaCha20Stream } = await import("../src/proxy/ss-client.js");

  for (const method of ["chacha20-ietf-poly1305", "chacha20-ietf"]) {
    // 强制 noble 的一端 ⇄ 原生的一端，两个方向都要解得开
    const js = createCodec(method, "pw", { forceJs: true });
    const native = createCodec(method, "pw");
    const native2 = createCodec(method, "pw");
    const js2 = createCodec(method, "pw", { forceJs: true });
    for (const len of [1, 63, 64, 65, 1000, 0x3fff, 50000]) {
      const plain = crypto.randomBytes(len);
      assert.ok(native.decrypt(js.encrypt(plain)).equals(plain), `${method} js→native len=${len}`);
      assert.ok(js2.decrypt(native2.encrypt(plain)).equals(plain), `${method} native→js len=${len}`);
    }
  }

  // ChaCha20Stream 的「跨块剩余密钥流」逻辑：任意切分都要和原生一次性加密一致
  const key = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(12);
  const plain = crypto.randomBytes(5000);
  const expected = crypto.createCipheriv("chacha20", key, Buffer.concat([Buffer.alloc(4), nonce])).update(plain);
  for (const cuts of [[1, 2, 3], [63, 64, 65], [100, 1000, 3000], [4999]]) {
    const stream = new ChaCha20Stream(key, nonce, 0);
    const parts = [];
    let pos = 0;
    for (const c of [...cuts, plain.length]) {
      parts.push(stream.update(plain.subarray(pos, c)));
      pos = c;
    }
    assert.ok(Buffer.concat(parts).equals(expected), `cuts=${cuts}`);
  }
});

// ─── 下载测速 ────────────────────────────────────────────────────────────────

/**
 * 真正转发的 ss 服务端：解出目标地址后连过去（域名一律连 127.0.0.1），双向转发。
 * makeObfs 传了就在 socket 和 ss 之间套一层服务端 obfs。
 */
function startForwardingServer(method, password, makeObfs, { connectDelay = 0 } = {}) {
  const server = net.createServer((client) => {
    const codec = createCodec(method, password);
    const obfs = makeObfs ? makeObfs() : { unwrap: (b) => b, wrap: (b) => b };
    let upstream = null;
    let queued = null; // 解出目标地址后、上游真正发起连接前，先攒着客户端的数据
    let pending = Buffer.alloc(0);
    client.on("data", (chunk) => {
      let enc;
      try {
        enc = obfs.unwrap(chunk);
      } catch {
        client.destroy();
        return;
      }
      if (!enc.length) return;
      const plain = codec.decrypt(enc);
      if (queued) {
        queued.push(plain);
        return;
      }
      if (upstream) {
        upstream.write(plain);
        return;
      }
      pending = Buffer.concat([pending, plain]);
      const type = pending[0];
      const hostLen = type === 1 ? 4 : type === 4 ? 16 : 1 + pending[1];
      if (pending.length < 1 + hostLen + 2) return;
      const port = pending.readUInt16BE(1 + hostLen);
      const rest = pending.subarray(1 + hostLen + 2);
      queued = rest.length ? [rest] : [];
      // connectDelay：模拟慢节点的建连开销（每轮续传都要付一次）
      setTimeout(() => {
        if (client.destroyed) return;
        upstream = net.connect({ host: "127.0.0.1", port });
        upstream.on("data", (d) => client.write(obfs.wrap(codec.encrypt(d))));
        upstream.on("end", () => client.end());
        upstream.on("error", () => client.destroy());
        for (const d of queued) upstream.write(d);
        queued = null;
      }, connectDelay);
    });
    client.on("error", () => upstream?.destroy());
    client.on("close", () => upstream?.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

const handleDownload = (req, res) => {
  if (req.url.startsWith("/redirect")) {
    res.writeHead(301, { Location: "https://example.com/x" });
    res.end();
    return;
  }
  const total = Number(new URL(req.url, "http://x").searchParams.get("bytes"));
  res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": total });
  const block = Buffer.alloc(64 * 1024, 7);
  let sent = 0;
  const pump = () => {
    while (sent < total) {
      const n = Math.min(block.length, total - sent);
      sent += n;
      if (!res.write(block.subarray(0, n))) {
        res.once("drain", pump);
        return;
      }
    }
    res.end();
  };
  pump();
};

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

test("downloadTest：http 经 AEAD 节点完整下载，字节数精确", async () => {
  const web = http.createServer(handleDownload);
  const webPort = await listen(web);
  const { server, port } = await startForwardingServer("aes-128-gcm", "pw");
  try {
    const progress = [];
    const r = await downloadTest(
      { server: "127.0.0.1", port, method: "aes-128-gcm", password: "pw" },
      { url: `http://localhost:${webPort}/dl?bytes=3000000`, onProgress: (p) => progress.push(p) },
    );
    assert.equal(r.bytes, 3000000);
    assert.ok(r.speed > 0);
  } finally {
    server.close();
    web.close();
  }
});

test("downloadTest：https 经节点走 TLS（流加密 chacha20-ietf）", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dl-tls-"));
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=localhost", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"),
    ], { stdio: "ignore" });
  } catch {
    t.skip("没有 openssl，跳过");
    return;
  }
  const cert = fs.readFileSync(path.join(dir, "c.pem"));
  const web = https.createServer({ key: fs.readFileSync(path.join(dir, "k.pem")), cert }, handleDownload);
  const webPort = await listen(web);
  const { server, port } = await startForwardingServer("chacha20-ietf", "pw");
  try {
    const r = await downloadTest(
      { server: "127.0.0.1", port, method: "chacha20-ietf", password: "pw" },
      { url: `https://localhost:${webPort}/dl?bytes=1000000`, tlsOptions: { ca: cert } },
    );
    assert.equal(r.bytes, 1000000);
  } finally {
    server.close();
    web.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("downloadTest：非 2xx 报出状态码与跳转地址；maxDuration 到点按已下载算", async () => {
  const web = http.createServer((req, res) => {
    if (req.url.startsWith("/redirect")) return handleDownload(req, res);
    // 慢速源：每 50ms 吐 10KB，永不结束
    res.writeHead(200);
    const timer = setInterval(() => res.write(Buffer.alloc(10240)), 50);
    res.on("close", () => clearInterval(timer));
  });
  const webPort = await listen(web);
  const { server, port } = await startForwardingServer("aes-256-gcm", "pw");
  const node = { server: "127.0.0.1", port, method: "aes-256-gcm", password: "pw" };
  try {
    await assert.rejects(
      downloadTest(node, { url: `http://localhost:${webPort}/redirect` }),
      /HTTP 301.*example\.com/,
    );
    const r = await downloadTest(node, { url: `http://localhost:${webPort}/slow`, maxDuration: 600 });
    assert.ok(r.bytes > 0 && r.ms >= 500 && r.ms < 1500, JSON.stringify(r));
  } finally {
    server.close();
    web.close();
  }
});

test("downloadTest：abort 立即中止", async () => {
  const web = http.createServer((req, res) => {
    res.writeHead(200);
    const timer = setInterval(() => res.write(Buffer.alloc(1024)), 50);
    res.on("close", () => clearInterval(timer));
  });
  const webPort = await listen(web);
  const { server, port } = await startForwardingServer("aes-256-gcm", "pw");
  const ac = new AbortController();
  try {
    setTimeout(() => ac.abort(), 300);
    const start = Date.now();
    await assert.rejects(
      downloadTest(
        { server: "127.0.0.1", port, method: "aes-256-gcm", password: "pw" },
        { url: `http://localhost:${webPort}/x`, signal: ac.signal, maxDuration: 10000 },
      ),
      /已停止/,
    );
    assert.ok(Date.now() - start < 2000);
  } finally {
    server.close();
    web.close();
  }
});

// ─── simple-obfs ─────────────────────────────────────────────────────────────
// 服务端按 simple-obfs 的 obfs_http.c / obfs_tls.c 服务端行为在测试里独立实现。

function httpObfsServer() {
  let headerDone = false;
  let replied = false;
  let buf = Buffer.alloc(0);
  const seen = {};
  return {
    seen,
    unwrap(chunk) {
      if (headerDone) return chunk;
      buf = Buffer.concat([buf, chunk]);
      const sep = buf.indexOf("\r\n\r\n");
      if (sep < 0) return Buffer.alloc(0);
      const head = buf.subarray(0, sep).toString();
      if (!/^GET \S+ HTTP\/1\.1\r\n/.test(head) || !/Upgrade: websocket/.test(head)) {
        throw new Error("bad obfs http");
      }
      seen.host = head.match(/Host: (\S+)/)[1];
      headerDone = true;
      return buf.subarray(sep + 4);
    },
    wrap(data) {
      if (replied) return data;
      replied = true;
      return Buffer.concat([
        Buffer.from("HTTP/1.1 101 Switching Protocols\r\nServer: nginx/1.14.0\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"),
        data,
      ]);
    },
  };
}

function tlsObfsServer() {
  let stage = 0;
  let replied = false;
  let buf = Buffer.alloc(0);
  const seen = {};
  const record = (type, body) => {
    const h = Buffer.from([type, 0x03, 0x03, 0, 0]);
    h.writeUInt16BE(body.length, 3);
    return Buffer.concat([h, body]);
  };
  return {
    seen,
    unwrap(chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0) {
        // ClientHello：record(5) + handshake 头(4) + version(2) + random(32) + sid
        if (buf.length < 5 || buf.length < 5 + buf.readUInt16BE(3)) return Buffer.alloc(0);
        assert.equal(buf[0], 0x16);
        assert.equal(buf[5], 0x01);
        let p = 5 + 4 + 2 + 32;
        p += 1 + buf[p]; // session id
        p += 2 + buf.readUInt16BE(p); // cipher suites
        p += 1 + buf[p]; // compression
        const extEnd = p + 2 + buf.readUInt16BE(p);
        p += 2;
        let data = Buffer.alloc(0);
        while (p < extEnd) {
          const type = buf.readUInt16BE(p);
          const len = buf.readUInt16BE(p + 2);
          if (type === 0x0023) data = buf.subarray(p + 4, p + 4 + len);
          if (type === 0x0000) seen.sni = buf.subarray(p + 9, p + 4 + len).toString();
          p += 4 + len;
        }
        buf = buf.subarray(extEnd);
        stage = 1;
        return data;
      }
      const out = [];
      while (buf.length >= 5 && buf.length >= 5 + buf.readUInt16BE(3)) {
        const len = buf.readUInt16BE(3);
        if (buf[0] === 0x17) out.push(buf.subarray(5, 5 + len));
        else if (buf[0] === 0x14) seen.ccs = true;
        buf = buf.subarray(5 + len);
      }
      return Buffer.concat(out);
    },
    wrap(data) {
      const app = [];
      for (let i = 0; i < data.length; i += 16384) app.push(record(0x17, data.subarray(i, i + 16384)));
      if (replied) return Buffer.concat(app);
      replied = true;
      return Buffer.concat([
        record(0x16, crypto.randomBytes(86)), // ServerHello（内容随便）
        record(0x14, Buffer.from([0x01])),
        record(0x16, crypto.randomBytes(32)),
        ...app,
      ]);
    },
  };
}

for (const [mode, makeServer] of [["http", httpObfsServer], ["tls", tlsObfsServer]]) {
  test(`obfs=${mode}：经混淆节点的真实延迟与下载都能跑通`, async () => {
    const web = http.createServer((req, res) => {
      if (req.url.startsWith("/generate_204")) {
        res.writeHead(204);
        res.end();
      } else {
        handleDownload(req, res);
      }
    });
    const webPort = await listen(web);
    const echo = net.createServer((sock) => sock.pipe(sock));
    const echoPort = await listen(echo);
    let last = null;
    const { server, port } = await startForwardingServer("aes-128-gcm", "pw", () => (last = makeServer()));
    const node = {
      server: "127.0.0.1",
      port,
      method: "aes-128-gcm",
      password: "pw",
      plugin: `obfs-local;obfs=${mode};obfs-host=www.bing.com`,
    };
    try {
      const r = await urlTest(node, { url: `http://localhost:${webPort}/generate_204`, timeout: 3000 });
      assert.equal(r.status, 204);
      if (mode === "http") assert.equal(last.seen.host, `www.bing.com:${port}`);
      else assert.equal(last.seen.sni, "www.bing.com");

      const d = await downloadTest(node, { url: `http://localhost:${webPort}/dl?bytes=2000000` });
      assert.equal(d.bytes, 2000000);

      // 同一连接多次往返（https 握手就是这样）：tls 模式第二包要带 ChangeCipherSpec
      const tunnel = await openTunnel(node, "localhost", echoPort);
      const roundTrip = (msg) =>
        new Promise((resolve) => {
          tunnel.once("data", (d2) => resolve(d2.toString()));
          tunnel.write(msg);
        });
      assert.equal(await roundTrip("first"), "first");
      assert.equal(await roundTrip("second"), "second");
      tunnel.destroy();
      if (mode === "tls") assert.ok(last.seen.ccs, "第二包应带 ChangeCipherSpec");
    } finally {
      server.close();
      web.close();
      echo.close();
    }
  });
}

test("obfs：模式配错时报清楚的错，不挂住", async () => {
  const { server, port } = await startForwardingServer("aes-128-gcm", "pw", httpObfsServer);
  try {
    await assert.rejects(
      urlTest(
        { server: "127.0.0.1", port, method: "aes-128-gcm", password: "pw", plugin: "obfs-local;obfs=tls" },
        { timeout: 2000 },
      ),
      /关闭了连接|不是|超时/,
    );
    await assert.rejects(
      urlTest({ server: "127.0.0.1", port, method: "aes-128-gcm", password: "pw", plugin: "v2ray-plugin" }),
      /不支持插件 v2ray-plugin/,
    );
  } finally {
    server.close();
  }
});

test("downloadTest：流量上限到点即停；时长 / 流量 / 下完 三种停止原因；都不限时报错", async () => {
  const web = http.createServer((req, res) => {
    if (req.url.startsWith("/slow")) {
      res.writeHead(200);
      const timer = setInterval(() => res.write(Buffer.alloc(10240)), 20);
      res.on("close", () => clearInterval(timer));
      return;
    }
    handleDownload(req, res);
  });
  const webPort = await listen(web);
  const { server, port } = await startForwardingServer("aes-256-gcm", "pw");
  const node = { server: "127.0.0.1", port, method: "aes-256-gcm", password: "pw" };
  try {
    // 文件 8MB，流量上限 2MB、不限时长 → 刚过 2MB 就停
    const byBytes = await downloadTest(node, {
      url: `http://localhost:${webPort}/dl?bytes=8000000`,
      maxDuration: null,
      maxBytes: 2 * 1024 * 1024,
    });
    assert.equal(byBytes.stoppedBy, "bytes");
    assert.ok(byBytes.bytes >= 2 * 1024 * 1024 && byBytes.bytes < 3 * 1024 * 1024, String(byBytes.bytes));

    const byTime = await downloadTest(node, {
      url: `http://localhost:${webPort}/slow`,
      maxDuration: 400,
      maxBytes: 100 * 1024 * 1024,
    });
    assert.equal(byTime.stoppedBy, "time");

    const byEnd = await downloadTest(node, {
      url: `http://localhost:${webPort}/dl?bytes=500000`,
      maxDuration: 10000,
      maxBytes: 100 * 1024 * 1024,
    });
    assert.equal(byEnd.stoppedBy, "end");
    assert.equal(byEnd.bytes, 500000);

    await assert.rejects(
      downloadTest(node, { url: `http://localhost:${webPort}/slow`, maxDuration: null, maxBytes: null }),
      /至少要设一个/,
    );
  } finally {
    server.close();
    web.close();
  }
});

test("downloadTest：nextUrl 续传，单文件下完没到上限就接着下，直到流量 / 时长上限", async () => {
  const web = http.createServer(handleDownload);
  const webPort = await listen(web);
  const { server, port } = await startForwardingServer("aes-128-gcm", "pw");
  const node = { server: "127.0.0.1", port, method: "aes-128-gcm", password: "pw" };
  const MB = 1024 * 1024;
  try {
    const asked = [];
    // 每轮最多 1MB，流量上限 3.5MB → 4 轮，第 4 轮只要剩下的 0.5MB
    const r = await downloadTest(node, {
      maxDuration: null,
      maxBytes: 3.5 * MB,
      nextUrl: (remaining) => {
        asked.push(remaining);
        return `http://localhost:${webPort}/dl?bytes=${Math.min(remaining, MB)}`;
      },
    });
    assert.equal(r.stoppedBy, "bytes");
    assert.equal(r.rounds, 4);
    assert.equal(r.bytes, 3.5 * MB);
    assert.deepEqual(asked, [3.5 * MB, 2.5 * MB, 1.5 * MB, 0.5 * MB]);

    // 只限时长：一直续传到点为止，nextUrl 拿到的剩余额度是 null
    const t = await downloadTest(node, {
      maxDuration: 500,
      maxBytes: null,
      nextUrl: (remaining) => {
        assert.equal(remaining, null);
        return `http://localhost:${webPort}/dl?bytes=${MB}`;
      },
    });
    assert.equal(t.stoppedBy, "time");
    assert.ok(t.rounds > 1, `rounds=${t.rounds}`);
    // ms 是有效下载时间（不含每轮重连），挂钟总耗时 wallMs 才覆盖整个 500ms
    assert.ok(t.ms <= t.wallMs, `ms=${t.ms} wallMs=${t.wallMs}`);
    assert.ok(t.wallMs >= 480 && t.wallMs < 1500, `wallMs=${t.wallMs}`);
  } finally {
    server.close();
    web.close();
  }
});

test("downloadTest：traffic 统计经过节点的真实流量（含协议开销，多轮累加，失败也记）", async () => {
  const web = http.createServer(handleDownload);
  const webPort = await listen(web);
  const { server, port } = await startForwardingServer("aes-128-gcm", "pw", httpObfsServer);
  const node = {
    server: "127.0.0.1",
    port,
    method: "aes-128-gcm",
    password: "pw",
    plugin: "obfs-local;obfs=http;obfs-host=a.com",
  };
  const MB = 1024 * 1024;
  try {
    const progress = [];
    const r = await downloadTest(node, {
      maxDuration: null,
      maxBytes: 3 * MB,
      nextUrl: (remaining) => `http://localhost:${webPort}/dl?bytes=${Math.min(remaining, 2 * MB)}`,
      onProgress: (p) => progress.push(p),
    });
    assert.equal(r.rounds, 2);
    assert.equal(r.bytes, 3 * MB);
    // AEAD 每 16KB 一个 chunk 带 34 字节开销，再加 salt / HTTP 头 / obfs 头：比内容多一点，但不会多太多
    assert.ok(r.traffic > r.bytes, `traffic=${r.traffic}`);
    assert.ok(r.traffic < r.bytes * 1.01, `traffic=${r.traffic}`);
    for (const p of progress) assert.ok(p.traffic >= p.bytes);

    const err = await downloadTest(node, { url: `http://localhost:${webPort}/redirect` }).catch((e) => e);
    assert.match(err.message, /HTTP 301/);
    assert.ok(err.traffic > 0, "失败的请求也消耗了流量");
  } finally {
    server.close();
    web.close();
  }
});

test("downloadTest：续传重连 / 卡住空等的时间不计入速度；到点时正在重连也立刻停", async () => {
  // 限速源：每 20ms 吐 20KB（≈1MB/s），每个文件 200KB
  const web = http.createServer((req, res) => {
    if (req.url.startsWith("/stall")) {
      res.writeHead(200);
      res.write(Buffer.alloc(100 * 1024));
      return; // 之后再也不发
    }
    res.writeHead(200, { "Content-Length": 200 * 1024 });
    let sent = 0;
    const timer = setInterval(() => {
      res.write(Buffer.alloc(20 * 1024));
      sent += 20 * 1024;
      if (sent >= 200 * 1024) {
        clearInterval(timer);
        res.end();
      }
    }, 20);
    res.on("close", () => clearInterval(timer));
  });
  const webPort = await listen(web);
  // 每次建连要等 300ms：200KB 文件只要 ~200ms，重连开销和下载时间一样长
  const { server, port } = await startForwardingServer("aes-128-gcm", "pw", null, { connectDelay: 300 });
  const node = { server: "127.0.0.1", port, method: "aes-128-gcm", password: "pw" };
  try {
    const r = await downloadTest(node, {
      maxDuration: 1500,
      maxBytes: null,
      nextUrl: () => `http://localhost:${webPort}/dl`,
    });
    assert.equal(r.stoppedBy, "time");
    assert.ok(r.rounds >= 3, `rounds=${r.rounds}`);
    // 真实传输速率约 1MB/s；旧算法把重连算进去会掉到一半左右
    const mbps = r.speed / 1024 / 1024;
    assert.ok(mbps > 0.75, `speed=${mbps.toFixed(2)}MB/s ms=${r.ms} wallMs=${r.wallMs}`);
    assert.ok(r.ms < r.wallMs - 600, `有效时间应明显小于总耗时: ms=${r.ms} wallMs=${r.wallMs}`);
    // 截止时间从首次收到数据起算：总耗时 ≈ 首轮建连 300ms + 1500ms，到点正在重连也不能拖
    assert.ok(r.wallMs < 300 + 1500 + 250, `wallMs=${r.wallMs}`);

    // 卡住：100KB 之后不再发数据，idle 500ms 后按已下载的算，空等的 500ms 不计入
    const st = await downloadTest(node, {
      url: `http://localhost:${webPort}/stall`,
      maxDuration: 10000,
      idleTimeout: 500,
    });
    assert.equal(st.stoppedBy, "idle");
    assert.equal(st.bytes, 100 * 1024);
    assert.ok(st.ms < 200, `ms=${st.ms}`);
    assert.ok(st.wallMs >= 500 + 300, `wallMs=${st.wallMs}`);
  } finally {
    server.close();
    web.close();
  }
});
