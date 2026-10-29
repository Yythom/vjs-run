// CLI 读写 config.json 里的 mock 字段。
//
// 只做「按字段打补丁」，不走 normalizeConfig 整体重写：CLI 和 app 可能版本不同，
// 整体 normalize 会把 CLI 不认识的新字段（app 新版加的）静默丢掉。app 监听 config.json，
// 自己会 normalize 一遍。字段默认值与 normalize.js 保持一致。

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { normalizeBackendBaseUrl } from "../url-utils.js";
import { CliError } from "./util.js";

// 与 src/ipc/config.js 的 MOCK_FIELDS_REQUIRING_RESTART 对应（这里用 toMockConfig 后的键名）
export const MOCK_RESTART_FIELDS = [
  "specPath",
  "host",
  "port",
  "serviceAddress",
  "backendBaseUrl",
  "mockAll",
];

export function readRawConfig(configFile) {
  if (!fs.existsSync(configFile)) return {};
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configFile, "utf8"));
  } catch (err) {
    throw new CliError(`config.json 不是合法 JSON：${configFile}\n  ${err.message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CliError(`config.json 顶层必须是对象：${configFile}`);
  }
  return raw;
}

export function toMockConfig(raw) {
  return {
    specPath: String(raw.mockSpecPath || "").trim(),
    swaggerServer: String(raw.mockSwaggerServer || "").trim(),
    host: raw.mockHost || DEFAULT_CONFIG.mockHost,
    port: Number(raw.mockPort || DEFAULT_CONFIG.mockPort),
    serviceAddress: raw.mockServiceAddress || DEFAULT_CONFIG.mockServiceAddress,
    backendBaseUrl: normalizeBackendBaseUrl(raw.mockBackendBaseUrl ?? DEFAULT_CONFIG.mockBackendBaseUrl),
    mockAll: raw.mockAll === undefined ? DEFAULT_CONFIG.mockAll : Boolean(raw.mockAll),
  };
}

export function readMockConfig(configFile) {
  return toMockConfig(readRawConfig(configFile));
}

/** updates 是 config.json 的原始键（mockSpecPath 等），其余字段原样保留 */
export function patchRawConfig(configFile, updates) {
  const next = { ...readRawConfig(configFile), ...updates };
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  const tmp = `${configFile}.tmp`;
  // electron-store 默认用 tab 缩进，保持一致免得 app 和 CLI 来回改格式
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, "\t")}\n`);
  fs.renameSync(tmp, configFile);
  return next;
}

// ─── 命令行参数 → config.json 补丁 ─────────────────────────────────────────────

// 参数在 index.js 里声明成 [value] 可选值：缺值时 commander 给 true，这里统一挡掉，
// 免得把字符串 "true" 当成目录 / 端口写进配置
function requireValue(flag, value) {
  if (value === true) throw new CliError(`--${flag} 需要一个值`);
  return value;
}

function httpUrl(flag, value) {
  if (value === true) throw new CliError(`--${flag} 需要一个地址（传 "" 表示清空）`);
  const text = String(value).trim();
  if (!text) return "";
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new CliError(`--${flag} 不是合法 URL：${text}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CliError(`--${flag} 只支持 http/https：${text}`);
  }
  // 两个地址都是「前缀」，后面还要拼接口路径（后端还会补尾部 /），带了 query / hash 会拼成坏地址
  if (url.search || url.hash || /[?#]/.test(text)) {
    throw new CliError(`--${flag} 不能带 ? 或 #，只填到路径前缀：${text}`);
  }
  return text;
}

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

// server.listen 要的是裸地址：[::1] 去掉方括号；带协议 / 端口的（http://…、127.0.0.1:3002）直接拒绝，
// 否则 listen 报 ENOTFOUND，拼出来的访问地址也是 http://[127.0.0.1:3002]:3002 这种非法 URL
function listenHost(raw) {
  let host = raw.trim();
  if (!host) throw new CliError("--host 不能为空");
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!net.isIP(host) && !HOSTNAME_RE.test(host)) {
    throw new CliError(
      `--host 只填地址本身，不带协议和端口（如 127.0.0.1、0.0.0.0、::1、localhost；端口用 --port）：${raw}`,
    );
  }
  return host;
}

export function configUpdatesFromFlags(values) {
  const updates = {};
  const specDir = values["spec-dir"] ?? values.specDir;
  if (specDir !== undefined) {
    const dir = String(requireValue("spec-dir", specDir)).trim();
    updates.mockSpecPath = dir ? path.resolve(dir) : "";
  }
  const swaggerServer = values["swagger-server"] ?? values.swaggerServer;
  if (swaggerServer !== undefined) {
    updates.mockSwaggerServer = httpUrl("swagger-server", swaggerServer);
  }
  if (values.backend !== undefined) {
    updates.mockBackendBaseUrl = normalizeBackendBaseUrl(httpUrl("backend", values.backend));
  }
  if (values.host !== undefined) {
    updates.mockHost = listenHost(String(requireValue("host", values.host)));
  }
  if (values.port !== undefined) {
    // 只认十进制数字：Number() 会把 1e3、0x10 也当成端口
    const text = String(requireValue("port", values.port)).trim();
    const port = Number(text);
    if (!/^\d+$/.test(text) || port <= 0 || port > 65535) {
      throw new CliError(`--port 必须是 1–65535 的整数：${values.port}`);
    }
    updates.mockPort = port;
  }
  const serviceAddress = values["service-address"] ?? values.serviceAddress;
  if (serviceAddress !== undefined) {
    updates.mockServiceAddress = String(requireValue("service-address", serviceAddress)).trim();
  }
  const mockAll = values["mock-all"] ?? values.mockAll;
  if (mockAll !== undefined) {
    const text = String(mockAll).trim().toLowerCase();
    if (!["true", "false", "1", "0"].includes(text)) {
      throw new CliError(`--mock-all 只能是 true / false：${mockAll}`);
    }
    updates.mockAll = text === "true" || text === "1";
  }
  return updates;
}

/** 启动 / 列路由前的 spec 检查，给出下一步该敲的命令 */
export function assertSpecReady(config) {
  if (!config.specPath) {
    throw new CliError(
      "还没有 OpenAPI spec。二选一：\n" +
        "  · 从 Swagger 拉取：vjtools mock config --swagger-server <url> && vjtools mock gen\n" +
        "  · 用已有文件：     vjtools mock config --spec-dir <OpenAPI JSON 所在目录>",
    );
  }
  if (!fs.existsSync(config.specPath)) {
    throw new CliError(
      `spec 目录不存在：${config.specPath}\n` +
        "  · 从 Swagger 拉取：vjtools mock config --swagger-server <url> && vjtools mock gen\n" +
        "  · 用已有文件：     vjtools mock config --spec-dir <OpenAPI JSON 所在目录>",
    );
  }
  if (fs.statSync(config.specPath).isDirectory() && !hasSpecFiles(config.specPath)) {
    throw new CliError(
      `spec 目录里还没有 OpenAPI 文件：${config.specPath}\n` +
        "  · 从 Swagger 拉取：vjtools mock config --swagger-server <url> && vjtools mock gen\n" +
        "  · 或把 OpenAPI JSON / YAML 文件放进这个目录",
    );
  }
}

/** 目录第一层有没有 OpenAPI 文件（加载时也只看第一层） */
export function hasSpecFiles(dir) {
  try {
    return fs.readdirSync(dir).some((name) => /\.(json|ya?ml)$/i.test(name));
  } catch {
    return false;
  }
}
