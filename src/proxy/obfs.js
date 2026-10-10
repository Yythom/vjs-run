// simple-obfs（obfs-local）客户端混淆层，按 shadowsocks/simple-obfs 的 obfs_http.c / obfs_tls.c 实现。
// 位置：socket ⇄ obfs ⇄ ss 加解密。wrap 包装发出去的数据，unwrap 剥掉服务端回包的伪装。
//
//   obfs=http：首包伪装成 WebSocket Upgrade 请求（数据放 body），服务端回 101 响应头，
//              之后双向都是裸数据。
//   obfs=tls ：首包伪装成 TLS ClientHello（数据塞在 SessionTicket 扩展里）；第二包前面补
//              ChangeCipherSpec + 假 Finished；之后每包包成 TLS ApplicationData 记录。
//              服务端回包是若干 TLS 记录，只取 ApplicationData 的内容。

import crypto from "node:crypto";

const u8 = (v) => Buffer.from([v & 0xff]);
const u16 = (v) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v);
  return b;
};
const u32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v >>> 0);
  return b;
};

const SUPPORTED_PLUGINS = new Set(["obfs-local", "simple-obfs"]);
const DEFAULT_OBFS_HOST = "cloudfront.net";
const MAX_TLS_RECORD = 16384;

/**
 * 根据解析后的 plugin 建混淆层；不支持的插件返回 { error }。
 * @param {{ name: string, opts: object } | null} plugin
 * @param {number} port 节点端口（obfs=http 的 Host 头要带非 80 端口）
 */
export function createObfs(plugin, port) {
  if (!plugin) return { obfs: null };
  if (!SUPPORTED_PLUGINS.has(plugin.name)) return { error: `不支持插件 ${plugin.name}` };
  const mode = plugin.opts.obfs || "http";
  const host = plugin.opts["obfs-host"] || DEFAULT_OBFS_HOST;
  if (mode === "http") return { obfs: new HttpObfs(host, port, plugin.opts["obfs-uri"] || "/") };
  if (mode === "tls") return { obfs: new TlsObfs(host) };
  return { error: `不支持 obfs=${mode}` };
}

export function isPluginSupported(plugin) {
  return !plugin || !createObfs(plugin, 0).error;
}

class HttpObfs {
  constructor(host, port, uri) {
    this.host = host;
    this.port = port;
    this.uri = uri;
    this.sent = false;
    this.headerDone = false;
    this.buf = Buffer.alloc(0);
  }

  wrap(data) {
    if (this.sent) return data;
    this.sent = true;
    const minor = crypto.randomInt(0, 60);
    const patch = crypto.randomInt(0, 2);
    const head =
      `GET ${this.uri} HTTP/1.1\r\n` +
      `Host: ${this.host}${this.port === 80 ? "" : `:${this.port}`}\r\n` +
      `User-Agent: curl/7.${minor}.${patch}\r\n` +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\n` +
      `Content-Length: ${data.length}\r\n\r\n`;
    return Buffer.concat([Buffer.from(head), data]);
  }

  unwrap(data) {
    if (this.headerDone) return data;
    this.buf = Buffer.concat([this.buf, data]);
    const sep = this.buf.indexOf("\r\n\r\n");
    if (sep < 0) {
      if (this.buf.length >= 5 && !this.buf.subarray(0, 5).equals(Buffer.from("HTTP/"))) {
        throw new Error("obfs 回包不是 HTTP（obfs 模式可能不对）");
      }
      return Buffer.alloc(0);
    }
    this.headerDone = true;
    const rest = this.buf.subarray(sep + 4);
    this.buf = Buffer.alloc(0);
    return rest;
  }
}

const CIPHER_SUITES = Buffer.from([
  0xc0, 0x2c, 0xc0, 0x30, 0x00, 0x9f, 0xcc, 0xa9, 0xcc, 0xa8, 0xcc, 0xaa, 0xc0, 0x2b, 0xc0, 0x2f,
  0x00, 0x9e, 0xc0, 0x24, 0xc0, 0x28, 0x00, 0x6b, 0xc0, 0x23, 0xc0, 0x27, 0x00, 0x67, 0xc0, 0x0a,
  0xc0, 0x14, 0x00, 0x39, 0xc0, 0x09, 0xc0, 0x13, 0x00, 0x33, 0x00, 0x9d, 0x00, 0x9c, 0x00, 0x3d,
  0x00, 0x3c, 0x00, 0x35, 0x00, 0x2f, 0x00, 0xff,
]);

// ec_point_formats + supported_groups + signature_algorithms + encrypt_then_mac + extended_master_secret
const OTHER_EXTENSIONS = Buffer.from([
  0x00, 0x0b, 0x00, 0x04, 0x03, 0x01, 0x00, 0x02,
  0x00, 0x0a, 0x00, 0x0a, 0x00, 0x08, 0x00, 0x1d, 0x00, 0x17, 0x00, 0x19, 0x00, 0x18,
  0x00, 0x0d, 0x00, 0x20, 0x00, 0x1e,
  0x06, 0x01, 0x06, 0x02, 0x06, 0x03, 0x05, 0x01, 0x05, 0x02, 0x05, 0x03, 0x04, 0x01, 0x04, 0x02,
  0x04, 0x03, 0x03, 0x01, 0x03, 0x02, 0x03, 0x03, 0x02, 0x01, 0x02, 0x02, 0x02, 0x03,
  0x00, 0x16, 0x00, 0x00,
  0x00, 0x17, 0x00, 0x00,
]);

function appDataRecords(data) {
  const out = [];
  for (let i = 0; i < data.length; i += MAX_TLS_RECORD) {
    const chunk = data.subarray(i, i + MAX_TLS_RECORD);
    out.push(Buffer.from([0x17, 0x03, 0x03]), u16(chunk.length), chunk);
  }
  return Buffer.concat(out);
}

class TlsObfs {
  constructor(host) {
    this.host = host;
    this.stage = 0;
    this.buf = Buffer.alloc(0);
  }

  clientHello(payload) {
    const sni = Buffer.from(this.host);
    const sessionTicket = Buffer.concat([u16(0x0023), u16(payload.length), payload]);
    const serverName = Buffer.concat([
      u16(0x0000), u16(sni.length + 5), u16(sni.length + 3), u8(0), u16(sni.length), sni,
    ]);
    const exts = Buffer.concat([sessionTicket, serverName, OTHER_EXTENSIONS]);
    const body = Buffer.concat([
      u16(0x0303),
      u32(Math.floor(Date.now() / 1000)),
      crypto.randomBytes(28),
      u8(32),
      crypto.randomBytes(32),
      u16(CIPHER_SUITES.length),
      CIPHER_SUITES,
      u8(1),
      u8(0),
      u16(exts.length),
      exts,
    ]);
    const handshake = Buffer.concat([u8(0x01), u8(0), u16(body.length), body]);
    return Buffer.concat([u8(0x16), u16(0x0301), u16(handshake.length), handshake]);
  }

  wrap(data) {
    if (this.stage === 0) {
      this.stage = 1;
      return this.clientHello(data);
    }
    if (this.stage === 1) {
      this.stage = 2;
      const ccs = Buffer.from([0x14, 0x03, 0x03, 0x00, 0x01, 0x01]);
      const finished = Buffer.concat([Buffer.from([0x16, 0x03, 0x03, 0x00, 0x20]), crypto.randomBytes(32)]);
      return Buffer.concat([ccs, finished, appDataRecords(data)]);
    }
    return appDataRecords(data);
  }

  unwrap(data) {
    this.buf = Buffer.concat([this.buf, data]);
    const out = [];
    while (this.buf.length >= 5) {
      const type = this.buf[0];
      if (type < 0x14 || type > 0x17) throw new Error("obfs 回包不是 TLS（obfs 模式可能不对）");
      const len = this.buf.readUInt16BE(3);
      if (this.buf.length < 5 + len) break;
      if (type === 0x17) out.push(this.buf.subarray(5, 5 + len));
      else if (type === 0x15) throw new Error("obfs 服务端返回 TLS Alert");
      this.buf = this.buf.subarray(5 + len);
    }
    return Buffer.concat(out);
  }
}
