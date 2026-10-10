// 最小 Shadowsocks 客户端，只为测速：经节点发一个 HTTP 请求，量从发起连接到
// 收到响应首行的耗时（与 Shadowrocket / Clash 的「URL 测试」口径一致）。
// 只依赖 node 内置 crypto / net，不引第三方。
//
// 支持的加密：
//   AEAD  ：aes-128/192/256-gcm、chacha20-ietf-poly1305
//   流加密：aes-128/192/256-cfb、aes-128/192/256-ctr、chacha20-ietf
//   明文  ：none / plain
// 插件：支持 simple-obfs（obfs-local，http / tls 两种），见 obfs.js。
// 不支持的加密（2022-blake3-*、xchacha20、rc4 等）或其他插件的节点只能测 TCP。
//
// 注意 Electron 主进程的 crypto 是 BoringSSL：不认 chacha20-poly1305 / chacha20 /
// aes-192-cfb。chacha 系列在原生不可用时走 @noble/ciphers（纯 JS、经过审计；
// Electron 里实测解密约 170MB/s）；其余缺失的算法运行时探测，探测不到就算不支持（只测 TCP）。

import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { Duplex } from "node:stream";
import { setInterval, clearInterval } from "node:timers";
import { performance } from "node:perf_hooks";
import { URL } from "node:url";
import { chacha20, chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { createObfs } from "./obfs.js";
import { parsePlugin } from "./ss-link.js";

const AEAD = {
  "aes-128-gcm": { cipher: "aes-128-gcm", keyLen: 16 },
  "aes-192-gcm": { cipher: "aes-192-gcm", keyLen: 24 },
  "aes-256-gcm": { cipher: "aes-256-gcm", keyLen: 32 },
  "chacha20-ietf-poly1305": { cipher: "chacha20-poly1305", keyLen: 32 },
};

const STREAM = {
  "aes-128-cfb": { cipher: "aes-128-cfb", keyLen: 16, ivLen: 16 },
  "aes-192-cfb": { cipher: "aes-192-cfb", keyLen: 24, ivLen: 16 },
  "aes-256-cfb": { cipher: "aes-256-cfb", keyLen: 32, ivLen: 16 },
  "aes-128-ctr": { cipher: "aes-128-ctr", keyLen: 16, ivLen: 16 },
  "aes-192-ctr": { cipher: "aes-192-ctr", keyLen: 24, ivLen: 16 },
  "aes-256-ctr": { cipher: "aes-256-ctr", keyLen: 32, ivLen: 16 },
  // OpenSSL 的 chacha20 要 16 字节 iv（4 字节小端计数器 + 12 字节 nonce），计数器从 0 开始
  "chacha20-ietf": { cipher: "chacha20", keyLen: 32, ivLen: 12, ivPrefix: 4 },
};

const PLAIN = new Set(["none", "plain"]);

const TAG_LEN = 16;
const MAX_CHUNK = 0x3fff;

export const DEFAULT_TEST_URL = "http://www.gstatic.com/generate_204";
export const DEFAULT_DOWNLOAD_URL = "https://speed.cloudflare.com/__down?bytes=50000000";

const nativeCache = new Map();
/** 运行时探测当前 node / Electron 的 crypto 是否支持某个 cipher */
function hasNativeCipher(name) {
  if (!nativeCache.has(name)) {
    let ok = true;
    try {
      const info = crypto.getCipherInfo(name);
      crypto.createCipheriv(
        name,
        Buffer.alloc(info?.keyLength || 32),
        Buffer.alloc(info?.ivLength || 12),
        name.endsWith("gcm") || name.endsWith("poly1305") ? { authTagLength: TAG_LEN } : undefined,
      );
    } catch {
      ok = false;
    }
    nativeCache.set(name, ok);
  }
  return nativeCache.get(name);
}

// 有纯 JS 兜底的算法
const JS_FALLBACK = new Set(["chacha20-poly1305", "chacha20"]);

export function isMethodSupported(method) {
  if (PLAIN.has(method)) return true;
  const spec = AEAD[method] || STREAM[method];
  if (!spec) return false;
  return JS_FALLBACK.has(spec.cipher) || hasNativeCipher(spec.cipher);
}

/** OpenSSL EVP_BytesToKey（MD5，无盐），ss 的主密钥派生 */
export function evpBytesToKey(password, keyLen) {
  const pwd = Buffer.from(password, "utf8");
  const parts = [];
  let prev = Buffer.alloc(0);
  let total = 0;
  while (total < keyLen) {
    prev = crypto.createHash("md5").update(Buffer.concat([prev, pwd])).digest();
    parts.push(prev);
    total += prev.length;
  }
  return Buffer.concat(parts).subarray(0, keyLen);
}

function aeadSubkey(masterKey, salt, keyLen) {
  return Buffer.from(crypto.hkdfSync("sha1", masterKey, salt, "ss-subkey", keyLen));
}

function incNonce(nonce) {
  for (let i = 0; i < nonce.length; i += 1) {
    nonce[i] = (nonce[i] + 1) & 0xff;
    if (nonce[i] !== 0) break;
  }
}

class AeadCodec {
  constructor(spec, masterKey, forceJs) {
    this.spec = spec;
    this.masterKey = masterKey;
    this.useJs = JS_FALLBACK.has(spec.cipher) && (forceJs || !hasNativeCipher(spec.cipher));
    this.enc = null; // { key, nonce }
    this.dec = null;
    this.buf = Buffer.alloc(0);
    this.pendingLen = -1;
  }

  seal(state, plain) {
    if (this.useJs) {
      const out = Buffer.from(chacha20poly1305(state.key, state.nonce).encrypt(plain));
      incNonce(state.nonce);
      return out;
    }
    const c = crypto.createCipheriv(this.spec.cipher, state.key, state.nonce, {
      authTagLength: TAG_LEN,
    });
    const out = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    incNonce(state.nonce);
    return out;
  }

  open(state, sealed) {
    if (this.useJs) {
      const out = Buffer.from(chacha20poly1305(state.key, state.nonce).decrypt(sealed));
      incNonce(state.nonce);
      return out;
    }
    const d = crypto.createDecipheriv(this.spec.cipher, state.key, state.nonce, {
      authTagLength: TAG_LEN,
    });
    d.setAuthTag(sealed.subarray(sealed.length - TAG_LEN));
    const out = Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG_LEN)), d.final()]);
    incNonce(state.nonce);
    return out;
  }

  encrypt(data) {
    const out = [];
    if (!this.enc) {
      const salt = crypto.randomBytes(this.spec.keyLen);
      this.enc = {
        key: aeadSubkey(this.masterKey, salt, this.spec.keyLen),
        nonce: Buffer.alloc(12),
      };
      out.push(salt);
    }
    for (let i = 0; i < data.length; i += MAX_CHUNK) {
      const chunk = data.subarray(i, i + MAX_CHUNK);
      const len = Buffer.alloc(2);
      len.writeUInt16BE(chunk.length);
      out.push(this.seal(this.enc, len), this.seal(this.enc, chunk));
    }
    return Buffer.concat(out);
  }

  /** 流式解密：数据不够一个完整 chunk 时先攒着，返回已解出的明文 */
  decrypt(data) {
    this.buf = Buffer.concat([this.buf, data]);
    if (!this.dec) {
      if (this.buf.length < this.spec.keyLen) return Buffer.alloc(0);
      const salt = this.buf.subarray(0, this.spec.keyLen);
      this.dec = {
        key: aeadSubkey(this.masterKey, salt, this.spec.keyLen),
        nonce: Buffer.alloc(12),
      };
      this.buf = this.buf.subarray(this.spec.keyLen);
    }
    const out = [];
    for (;;) {
      if (this.pendingLen < 0) {
        if (this.buf.length < 2 + TAG_LEN) break;
        this.pendingLen = this.open(this.dec, this.buf.subarray(0, 2 + TAG_LEN)).readUInt16BE(0);
        this.buf = this.buf.subarray(2 + TAG_LEN);
      }
      if (this.buf.length < this.pendingLen + TAG_LEN) break;
      out.push(this.open(this.dec, this.buf.subarray(0, this.pendingLen + TAG_LEN)));
      this.buf = this.buf.subarray(this.pendingLen + TAG_LEN);
      this.pendingLen = -1;
    }
    return Buffer.concat(out);
  }
}

/**
 * 有状态的 ChaCha20 流（ss 的 chacha20-ietf）：noble 的 chacha20 只能从整块（64 字节）计数器
 * 开始算，这里自己记住上一块没用完的密钥流，让跨多次 update 的字节连续。
 */
export class ChaCha20Stream {
  constructor(key, nonce, counter = 0) {
    this.key = key;
    this.nonce = nonce;
    this.counter = counter;
    this.leftover = new Uint8Array(0);
  }

  update(data) {
    const out = Buffer.allocUnsafe(data.length);
    const used = Math.min(this.leftover.length, data.length);
    for (let i = 0; i < used; i += 1) out[i] = data[i] ^ this.leftover[i];
    this.leftover = this.leftover.subarray(used);

    const rest = data.length - used;
    if (rest > 0) {
      const blocks = Math.ceil(rest / 64);
      const ks = chacha20(this.key, this.nonce, new Uint8Array(blocks * 64), undefined, this.counter);
      this.counter += blocks;
      for (let i = 0; i < rest; i += 1) out[used + i] = data[used + i] ^ ks[i];
      this.leftover = ks.subarray(rest);
    }
    return out;
  }
}

class StreamCodec {
  constructor(spec, masterKey, forceJs) {
    this.spec = spec;
    this.key = masterKey;
    this.useJs = JS_FALLBACK.has(spec.cipher) && (forceJs || !hasNativeCipher(spec.cipher));
    this.cipher = null;
    this.decipher = null;
    this.buf = Buffer.alloc(0);
  }

  createStream(iv, decrypt) {
    if (this.useJs) {
      return new ChaCha20Stream(this.key, iv, 0);
    }
    const fullIv = this.spec.ivPrefix ? Buffer.concat([Buffer.alloc(this.spec.ivPrefix), iv]) : iv;
    return decrypt
      ? crypto.createDecipheriv(this.spec.cipher, this.key, fullIv)
      : crypto.createCipheriv(this.spec.cipher, this.key, fullIv);
  }

  encrypt(data) {
    if (!this.cipher) {
      const iv = crypto.randomBytes(this.spec.ivLen);
      this.cipher = this.createStream(iv, false);
      return Buffer.concat([iv, this.cipher.update(data)]);
    }
    return this.cipher.update(data);
  }

  decrypt(data) {
    if (!this.decipher) {
      this.buf = Buffer.concat([this.buf, data]);
      if (this.buf.length < this.spec.ivLen) return Buffer.alloc(0);
      const iv = this.buf.subarray(0, this.spec.ivLen);
      this.decipher = this.createStream(iv, true);
      const rest = this.buf.subarray(this.spec.ivLen);
      this.buf = Buffer.alloc(0);
      return this.decipher.update(rest);
    }
    return this.decipher.update(data);
  }
}

class PlainCodec {
  encrypt(data) {
    return data;
  }
  decrypt(data) {
    return data;
  }
}

/** forceJs 仅供测试：系统 node 有原生 chacha，不强制就走不到 noble 那条路径 */
export function createCodec(method, password, { forceJs = false } = {}) {
  if (!isMethodSupported(method)) throw new Error(`不支持的加密方式: ${method}`);
  if (AEAD[method]) {
    return new AeadCodec(AEAD[method], evpBytesToKey(password, AEAD[method].keyLen), forceJs);
  }
  if (STREAM[method]) {
    return new StreamCodec(STREAM[method], evpBytesToKey(password, STREAM[method].keyLen), forceJs);
  }
  if (PLAIN.has(method)) return new PlainCodec();
  throw new Error(`不支持的加密方式: ${method}`);
}

/** SOCKS5 风格目标地址头：IPv4 / IPv6 / 域名 + 端口 */
export function encodeTargetAddress(host, port) {
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port);
  const ipType = net.isIP(host);
  if (ipType === 4) {
    return Buffer.concat([Buffer.from([0x01]), Buffer.from(host.split(".").map(Number)), portBuf]);
  }
  if (ipType === 6) {
    const groups = host.includes("::") ? expandIpv6(host) : host.split(":");
    const bytes = Buffer.alloc(16);
    groups.forEach((g, i) => bytes.writeUInt16BE(parseInt(g || "0", 16), i * 2));
    return Buffer.concat([Buffer.from([0x04]), bytes, portBuf]);
  }
  const name = Buffer.from(host, "utf8");
  return Buffer.concat([Buffer.from([0x03, name.length]), name, portBuf]);
}

function expandIpv6(host) {
  const [head, tail] = host.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  return [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
}

/**
 * 纯 TCP 握手延迟（含 DNS 解析），所有节点都能测。
 * @returns {Promise<number>} 毫秒
 */
export function tcpPing({ server, port }, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const socket = net.connect({ host: server, port });
    socket.setTimeout(timeout, () => {
      socket.destroy();
      reject(new Error("TCP 连接超时"));
    });
    socket.once("connect", () => {
      const ms = Math.round(performance.now() - start);
      socket.destroy();
      resolve(ms);
    });
    socket.once("error", (err) => reject(new Error(`TCP 连接失败: ${err.code || err.message}`)));
  });
}

/**
 * 在已打开的连接（隧道，或隧道上的 TLS）上发一个 GET，由 node 内置 http 客户端解析响应
 * （状态行 / 响应头 / chunked 都交给它）。Host 头显式给出，https 时不会被拼成 host:443。
 */
function requestOver(connection, target) {
  return http.request({
    host: target.hostname,
    port: Number(target.port) || (target.protocol === "https:" ? 443 : 80),
    path: `${target.pathname}${target.search}`,
    method: "GET",
    // 千万别加 agent: false —— 那样 node 会新建 Agent，createConnection 被静默忽略，
    // 请求直连目标、完全绕过节点（测试里密码错了都能「测通」）。不传 agent 才走 createConnection。
    createConnection: () => connection,
    headers: {
      Host: target.host,
      "User-Agent": "Mozilla/5.0 vjtools-speedtest",
      Accept: "*/*",
      "Accept-Encoding": "identity",
      Connection: "close",
    },
  });
}

/** http 客户端报的底层错误 → 给人看的原因 */
function describeRequestError(err, closedHint) {
  if (err.code?.startsWith("HPE_")) return new Error("响应不是 HTTP（密码或加密方式可能不对）");
  if (err.code === "ECONNRESET" && /socket hang up/.test(err.message)) return new Error(closedHint);
  return err;
}

/**
 * 经 ss 节点请求测试 URL（仅 http），收到响应头即算成功。
 * 耗时从发起 TCP 连接算起（含握手），与 Shadowrocket / Clash 的 URL 测试口径一致。
 * @returns {Promise<{ delay: number, status: number }>}
 */
export async function urlTest(node, { url = DEFAULT_TEST_URL, timeout = 5000 } = {}) {
  let target;
  try {
    target = new URL(url);
  } catch {
    throw new Error(`测试地址不合法: ${url}`);
  }
  if (target.protocol !== "http:") throw new Error("测试地址只支持 http://");

  const start = performance.now();
  const tunnel = await openTunnel(node, target.hostname, Number(target.port) || 80, { timeout });
  const remaining = Math.max(1, timeout - (performance.now() - start));

  return new Promise((resolve, reject) => {
    let settled = false;
    const req = requestOver(tunnel, target);
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      tunnel.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("测试超时")), remaining);
    req.once("response", (res) => {
      finish(null, { delay: Math.round(performance.now() - start), status: res.statusCode });
    });
    req.once("error", (err) =>
      finish(describeRequestError(err, "节点关闭了连接（密码/加密方式/obfs 参数不对或节点不可用）")),
    );
    req.end();
  });
}

/**
 * 经 ss 节点打开到 host:port 的隧道，返回明文 Duplex（可再套 tls.connect）。
 * 分层：socket ⇄ obfs（有插件时）⇄ ss 加解密 ⇄ 明文。
 * 目标地址头和第一次写入的数据合并成一包发出（与 ss-local 一致，少一次往返）；
 * 之后写入的数据原样加密转发。
 */
export function openTunnel(node, host, port, { timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let codec;
    let obfs = null;
    try {
      codec = createCodec(node.method, node.password);
      const r = createObfs(parsePlugin(node.plugin), node.port);
      if (r.error) throw new Error(r.error);
      obfs = r.obfs;
    } catch (err) {
      reject(err);
      return;
    }
    let addrHeader = encodeTargetAddress(host.replace(/^\[|\]$/g, ""), port);
    const send = (plain, cb) => {
      if (addrHeader) {
        plain = Buffer.concat([addrHeader, plain]);
        addrHeader = null;
      }
      const enc = codec.encrypt(plain);
      return socket.write(obfs ? obfs.wrap(enc) : enc, cb);
    };
    const socket = net.connect({ host: node.server, port: node.port });
    let connected = false;
    let ended = false;

    const tunnel = new Duplex({
      write(chunk, _enc, cb) {
        try {
          send(chunk, cb);
        } catch (err) {
          cb(err);
        }
      },
      read() {
        socket.resume();
      },
      final(cb) {
        socket.end();
        cb();
      },
      destroy(err, cb) {
        socket.destroy();
        cb(err);
      },
    });
    // 经过节点的真实流量（上行 + 下行，含 ss 加密 / obfs / TLS 等开销），机场扣的就是这个
    tunnel.traffic = () => socket.bytesRead + socket.bytesWritten;

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("连接节点超时"));
    }, timeout);

    socket.once("connect", () => {
      clearTimeout(timer);
      connected = true;
      resolve(tunnel);
    });
    socket.on("data", (chunk) => {
      let enc;
      try {
        enc = obfs ? obfs.unwrap(chunk) : chunk;
      } catch (err) {
        tunnel.destroy(err);
        return;
      }
      if (!enc.length) return;
      let plain;
      try {
        plain = codec.decrypt(enc);
      } catch {
        tunnel.destroy(new Error("响应解密失败（密码或加密方式不对）"));
        return;
      }
      if (plain.length && !tunnel.push(plain)) socket.pause();
    });
    socket.once("end", () => {
      ended = true;
      tunnel.push(null);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      const e = new Error(`连接失败: ${err.code || err.message}`);
      if (connected) tunnel.destroy(e);
      else reject(e);
    });
    socket.once("close", () => {
      if (connected && !ended) {
        tunnel.destroy(new Error("节点关闭了连接（密码/加密方式/obfs 参数不对或节点不可用）"));
      }
    });
  });
}

/**
 * 下载测速：经节点下载（http / https 均可）。
 * 两个上限谁先到就停：maxDuration（毫秒）、maxBytes（字节），传 null 表示不限，但不能都不限。
 * 只给 url 时文件下完也会停；给了 nextUrl(remainingBytes) 时，文件下完还没到上限就接着下一轮
 * （默认的 Cloudflare 地址单次最多约 95MB，快节点十秒就下完，靠这个撑满用户设的上限）。
 *
 * 计时口径（踩过坑：曾把续传重连时间算进下载时间，快节点被低估一半）：
 *   - ms（有效下载时间）= 各轮「收到响应头 → 本轮结束」之和；建连 / 握手 / 续传重连不算，
 *     卡住（idle）时算到最后一个字节为止。speed = bytes / ms。
 *   - maxDuration 是从第一次收到数据起算的「挂钟」截止时间，到点不管在哪一步（包括续传正在重连）都立即停。
 *   - wallMs = 从发起连接到结束的总耗时，给人看时间都花在哪。
 * traffic = 各轮经过节点的真实字节数（上行 + 下行，含协议开销），失败时挂在 err.traffic 上。
 * onProgress({ bytes, ms, wallMs, speed, traffic }) 约每 500ms 回调一次；signal 中止时 reject「已停止」。
 * @returns {Promise<{ bytes, ms, wallMs, speed, traffic, stoppedBy, rounds }>} speed 单位 字节/秒；
 *   stoppedBy ∈ "time" | "bytes" | "end"（文件下完）| "idle"（卡住）| "interrupted"（续传轮次出错）
 */
export async function downloadTest(
  node,
  {
    url = DEFAULT_DOWNLOAD_URL,
    nextUrl = null,
    maxDuration = 10000,
    maxBytes = null,
    idleTimeout = 6000,
    connectTimeout = 8000,
    onProgress,
    signal,
    tlsOptions = {},
  } = {},
) {
  if (signal?.aborted) throw new Error("已停止");
  if (!maxDuration && !maxBytes) throw new Error("时长上限和流量上限至少要设一个");

  const testStart = performance.now();
  // start：第一次收到数据的时刻（截止时间从这里起算）
  // activeMs / roundStart / lastDataAt：有效下载时间的累计、本轮起点、本轮最后一个字节的时刻
  // traffic：已结束轮次的流量合计；live：进行中那一轮的隧道（实时流量从它读）
  const meter = {
    start: 0,
    bytes: 0,
    activeMs: 0,
    roundStart: 0,
    lastDataAt: 0,
    traffic: 0,
    live: null,
  };
  const summary = () => {
    const now = performance.now();
    const ms = Math.max(1, Math.round(meter.activeMs + (meter.roundStart ? now - meter.roundStart : 0)));
    return {
      bytes: meter.bytes,
      ms,
      wallMs: Math.round(now - testStart),
      speed: Math.round((meter.bytes * 1000) / ms),
      traffic: meter.traffic + (meter.live ? meter.live.traffic() : 0),
    };
  };
  const progressTimer = onProgress
    ? setInterval(() => meter.start && onProgress(summary()), 500)
    : null;

  // 全局截止：第一次收到数据后开始倒计时，到点中止当前这一轮（不管它在下载还是在重连）
  let timeUp = false;
  let roundCtl = null;
  let deadlineTimer = null;
  const onFirstBody = () => {
    if (!maxDuration) return;
    deadlineTimer = setTimeout(() => {
      timeUp = true;
      roundCtl?.abort();
    }, maxDuration);
  };
  const opts = { meter, maxBytes, idleTimeout, connectTimeout, signal, tlsOptions, onFirstBody };

  let rounds = 0;
  try {
    for (;;) {
      if (timeUp) return { ...summary(), stoppedBy: "time", rounds };
      const roundUrl = nextUrl ? nextUrl(maxBytes ? maxBytes - meter.bytes : null) : url;
      rounds += 1;
      roundCtl = new AbortController();
      let stoppedBy;
      try {
        stoppedBy = await downloadOnce(node, roundUrl, { ...opts, roundSignal: roundCtl.signal });
      } catch (err) {
        // 续传轮次出错：前面已经有数据了，按已下载的算
        if (rounds > 1 && meter.bytes && !signal?.aborted) return { ...summary(), stoppedBy: "interrupted", rounds };
        err.traffic = summary().traffic;
        throw err;
      }
      if (stoppedBy !== "end" || !nextUrl) {
        if (!meter.bytes) throw Object.assign(new Error("没有下载到数据"), { traffic: summary().traffic });
        return { ...summary(), stoppedBy, rounds };
      }
    }
  } finally {
    clearInterval(progressTimer);
    clearTimeout(deadlineTimer);
  }
}

/**
 * 单轮下载：字节和有效下载时间累加进 meter，返回停止原因。
 * roundSignal 中止 = 到了全局截止时间，按 "time" 正常结束；signal 中止 = 用户点停止，reject。
 */
async function downloadOnce(
  node,
  url,
  { meter, maxBytes, idleTimeout, connectTimeout, signal, roundSignal, tlsOptions, onFirstBody },
) {
  let target;
  try {
    target = new URL(url);
  } catch {
    throw new Error(`下载地址不合法: ${url}`);
  }
  const isHttps = target.protocol === "https:";
  if (!isHttps && target.protocol !== "http:") throw new Error("下载地址只支持 http / https");
  if (signal?.aborted) throw new Error("已停止");

  const host = target.hostname.replace(/^\[|\]$/g, "");
  const port = Number(target.port) || (isHttps ? 443 : 80);
  // 建连期间到点也要立刻停：和截止信号赛跑，输了的隧道连上后直接丢掉
  const tunnelPromise = openTunnel(node, host, port, { timeout: connectTimeout });
  const tunnel = await Promise.race([
    tunnelPromise,
    new Promise((resolve) => roundSignal.addEventListener("abort", () => resolve(null), { once: true })),
  ]);
  if (!tunnel || roundSignal.aborted) {
    tunnelPromise.then((t) => t.destroy(), () => {});
    return "time";
  }
  meter.live = tunnel;

  return new Promise((resolve, reject) => {
    const connection = isHttps
      ? tls.connect({
          socket: tunnel,
          servername: net.isIP(host) ? undefined : host,
          ALPNProtocols: ["http/1.1"],
          ...tlsOptions,
        })
      : tunnel;
    const req = requestOver(connection, target);

    let settled = false;
    let inBody = false;
    let roundBytes = 0;
    let idleTimer = null;

    const finish = (err, stoppedBy = "end") => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      signal?.removeEventListener("abort", onAbort);
      roundSignal.removeEventListener("abort", onDeadline);
      // 结算本轮有效下载时间：卡住的话只算到最后一个字节，空等的那段不算
      if (meter.roundStart) {
        const end = stoppedBy === "idle" && !err ? meter.lastDataAt : performance.now();
        meter.activeMs += Math.max(0, end - meter.roundStart);
        meter.roundStart = 0;
      }
      req.destroy();
      connection.destroy();
      tunnel.destroy();
      meter.traffic += tunnel.traffic();
      meter.live = null;
      if (err) reject(err);
      else resolve(stoppedBy);
    };
    const armIdle = () => {
      clearTimeout(idleTimer);
      // 下到一半卡住：已有数据就按已下载的算，否则算失败
      idleTimer = setTimeout(
        () => finish(meter.bytes ? null : new Error("下载超时"), "idle"),
        idleTimeout,
      );
    };
    const onAbort = () => finish(new Error("已停止"));
    signal?.addEventListener("abort", onAbort);
    const onDeadline = () => finish(null, "time");
    roundSignal.addEventListener("abort", onDeadline);
    // 读到一半断开：本轮已有数据就按已下载的算
    const onBodyError = (err) => finish(roundBytes ? null : err);

    req.once("response", (res) => {
      armIdle();
      const status = res.statusCode;
      if (status < 200 || status >= 300) {
        const loc = res.headers.location;
        finish(new Error(`下载地址返回 HTTP ${status}${loc ? `（跳转到 ${loc}）` : ""}`));
        return;
      }
      inBody = true;
      const now = performance.now();
      meter.roundStart = now;
      meter.lastDataAt = now;
      if (!meter.start) {
        meter.start = now;
        onFirstBody();
      }
      res.on("data", (chunk) => {
        armIdle();
        meter.lastDataAt = performance.now();
        roundBytes += chunk.length;
        meter.bytes += chunk.length;
        if (maxBytes && meter.bytes >= maxBytes) finish(null, "bytes");
      });
      res.once("end", () => finish(null, "end"));
      res.once("aborted", () => onBodyError(new Error("下载中途连接断开")));
      res.once("error", onBodyError);
    });
    req.once("error", (err) => {
      if (inBody) {
        onBodyError(err);
        return;
      }
      const e = describeRequestError(err, "节点关闭了连接（没收到响应）");
      finish(
        isHttps && e === err
          ? new Error(`TLS 握手失败（${err.message}），密码/加密方式可能不对`)
          : e,
      );
    });
    armIdle();
    req.end();
  });
}
