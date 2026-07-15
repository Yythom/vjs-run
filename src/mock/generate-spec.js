// 从后端 swagger 文档生成 Mock 用的 OpenAPI 3 JSON 目录。
// 逻辑移植自 vjs-monorepo tooling/generate-api 的 init 命令（fetch-data/*）：
//   1. 拉取各服务的 swagger2 文档（{server}/{type}/v2/api-docs）
//   2. 通过 converter 服务转成 OpenAPI 3
//   3. 扁平化 R«xxx» 包装 schema、剔除黑名单接口与鉴权参数
//   4. 拉取错误码（{server}/{type}/errors/api-ecs）注入到 responses
//   5. 写入 {outputDir}/{type}.json，供 mock server 加载
// 区别：inquirer 交互选服务器 → 改为配置项 mockSwaggerServer；axios → 原生 fetch。

import fs from "node:fs";
import path from "node:path";
import { cut } from "jieba-wasm";

/** 各后端服务前缀，与 generate-api 保持一致 */
export const PROJECT_TYPES = ["vjg", "vjh", "vjm", "vjc", "vjk", "vjf"];

/** 生成时剔除的接口路径片段 */
const EXCLUDE_INTERFACE = [
  "/errors/api-ecs",
  "/upload/test",
  "/iop/",
  "/call/",
  "/callbacks/",
  "/callback/",
  "/local/",
  "/mgmt/",
];

/** 接口参数中剔除的鉴权字段 */
const EXCLUDE_PARAMETERS = ["Authorization", "mgmtauth"];

/** swagger2 转 openapi3 的转换服务地址 */
const OPENAPI_CONVERT_SERVER = "https://converter.vjshi.cn/api/convert";

const FETCH_TIMEOUT_MS = 30_000;

// ─── transform（对应 fetch-data/transform.ts）─────────────────────────────────

function transformJsonSchema(obj) {
  if (typeof obj === "string") {
    return { type: "string" };
  }
  if (typeof obj === "number") {
    return { type: "number", const: obj };
  }
  if (typeof obj === "boolean") {
    return { type: "boolean" };
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) {
      return { type: "array", items: {} };
    }
    const itemsSchema = transformJsonSchema(obj[0]);
    return { type: "array", items: itemsSchema };
  }

  if (typeof obj === "object") {
    const properties = {};
    for (const key in obj) {
      const propertySchema = transformJsonSchema(obj[key]);
      properties[key] = propertySchema;
    }
    return { type: "object", properties };
  }

  return {};
}

const EXCLUDE_SCHEMA_NAMES = [/R«Void»/, /R«string»/, /R«List«Void»»/];
const SCHEMA_REF_PREFIX = "#/components/schemas/";

function shouldFlattenResponseSchema(name) {
  return (
    name.startsWith("R«") &&
    !EXCLUDE_SCHEMA_NAMES.some((item) => Boolean(name.match(item)))
  );
}

function replaceRString(string) {
  return string.replace(/R«/, "").replace("»", "");
}

function flatResponseData(data) {
  function replaceRef(obj) {
    if (Array.isArray(obj)) {
      return obj.map((item) => replaceRef(item));
    }
    if (typeof obj === "object" && obj !== null) {
      const result = {};
      for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          if (key === "$ref") {
            const oldRef = obj[key];
            const schemaName = oldRef.startsWith(SCHEMA_REF_PREFIX)
              ? oldRef.slice(SCHEMA_REF_PREFIX.length)
              : oldRef;

            if (
              schemaName.startsWith("R«") &&
              EXCLUDE_SCHEMA_NAMES.some((item) => Boolean(schemaName.match(item)))
            ) {
              continue;
            }

            if (shouldFlattenResponseSchema(schemaName)) {
              const ref = oldRef.startsWith(SCHEMA_REF_PREFIX)
                ? `${SCHEMA_REF_PREFIX}${replaceRString(schemaName)}`
                : replaceRString(oldRef);

              result[key] = ref;
              continue;
            }
            result[key] = oldRef;
          } else {
            result[key] = replaceRef(obj[key]);
          }
        }
      }
      return result;
    }
    return obj;
  }

  function replaceComponents(obj) {
    const schemas = obj.components.schemas;

    if (typeof schemas === "object" && schemas !== null) {
      const result = { ...schemas };
      for (const key in result) {
        if (key.startsWith("R«")) {
          if (!shouldFlattenResponseSchema(key)) {
            continue;
          }

          const newKey = replaceRString(key);

          if (result[newKey] == null) {
            if (result[key].properties.data) {
              result[newKey] = {
                ...result[key].properties.data,
                title: newKey,
              };

              delete result[key];
            }
          }
        }
      }

      return result;
    }

    return schemas;
  }

  const newdata = replaceRef(data);
  newdata.components.schemas = replaceComponents(data);
  return newdata;
}

// ─── fetch（对应 fetch-data/fetch.ts）────────────────────────────────────────

async function fetchJson(url, init = {}) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    ...init,
  });
  if (!response.ok) {
    throw new Error(`${init.method || "GET"} ${url} → HTTP ${response.status}`);
  }
  return response.json();
}

/** 拉取 swagger2 文档并经 converter 服务转成 OpenAPI 3 */
async function fetchApi(jsonUrl, onLog) {
  const originJson = await fetchJson(jsonUrl);
  try {
    return await fetchJson(OPENAPI_CONVERT_SERVER, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(originJson),
    });
  } catch (err) {
    onLog?.(`converter 转换失败（${jsonUrl}）: ${err.message}`);
    throw err;
  }
}

/** 拉取某个接口的错误码定义，注入为额外的 error_{status}_{i} responses */
async function fetchApiError(errorUrl, { method, uri }, schema, onLog) {
  const url = `${errorUrl}?method=${encodeURIComponent(method)}&uri=${encodeURIComponent(uri)}`;
  try {
    const errors = await fetchJson(url);
    if (errors?.code) throw new Error(`errorUrl 返回业务错误码 ${errors.code}`);
    if (!Array.isArray(errors)) return;

    errors.forEach((e, i) => {
      // 后端不会在 data 中返回 httpStatus，不排除会影响 zodios 错误收窄
      const { httpStatus: _ignored, code, ...rest } = e;

      const errorSchema = transformJsonSchema(rest);
      errorSchema.properties.code = { type: "string", enum: [code] };

      // 后端能预见到的错误，除了 400（UNSUPPORTED_VALUE、PARAM_INVALID）都是 200，
      // 预见不到的错误都是 500
      const httpStatus =
        code === "FATAL_ERROR"
          ? 500
          : code === "PARAM_INVALID" || code === "UNSUPPORTED_VALUE"
            ? 400
            : 200;

      schema.responses = schema.responses || {};
      schema.responses[`error_${httpStatus}_${i}`] = {
        description: e.message,
        content: {
          "application/json": { schema: errorSchema },
        },
      };
    });
  } catch (err) {
    // 与 generate-api 一致：单个接口的错误码拉取失败只记日志，不中断整体生成
    onLog?.(`错误码拉取失败 ${method} ${uri}: ${err.message}`);
  }
}

// ─── generateJson（对应 fetch-data/index.ts）─────────────────────────────────

async function generateJson({ jsonPath, apiUrl, errorUrl, onLog }) {
  const swaggerData = await fetchApi(apiUrl, onLog);
  const shadow = flatResponseData(swaggerData);
  const { paths = {} } = shadow || {};

  // 删除不需要的接口
  Object.keys(paths).forEach((key) => {
    if (EXCLUDE_INTERFACE.some((e) => key.includes(e))) {
      delete paths[key];
    }
  });

  const requestTasks = Object.entries(paths).flatMap(([key, item]) =>
    Object.keys(item).map((method) => {
      const schema = item[method];
      // 过滤鉴权参数
      schema.parameters = schema.parameters?.filter(
        (e) => !EXCLUDE_PARAMETERS.includes(e.name),
      );
      delete schema.security;

      // 优先使用 description，没有再用 summary，保证有基本描述
      schema.description = schema.description || schema.summary || "";

      return () =>
        fetchApiError(
          errorUrl,
          { uri: key, method: method.toUpperCase() },
          schema,
          onLog,
        );
    }),
  );

  // 后端有并发限制，分批执行
  const chunkSize = 5;
  for (let i = 0; i < requestTasks.length; i += chunkSize) {
    await Promise.all(requestTasks.slice(i, i + chunkSize).map((task) => task()));
  }

  await fs.promises.writeFile(
    jsonPath,
    JSON.stringify(shadow).replaceAll('"*/*"', '"application/json"'),
    { flag: "w" },
  );
}

// ─── 对外入口 ────────────────────────────────────────────────────────────────

/**
 * 生成 Swagger Mock OpenAPI JSON 目录。
 * 生成前清空输出目录，再逐个服务写入 {outputDir}/{type}.json。
 * 任一服务生成失败时抛错。
 */
export async function generateSwaggerSpecs({ serverUrl, outputDir, onLog }) {
  const server = String(serverUrl || "").replace(/\/+$/, "");
  if (!server) throw new Error("未配置 swagger 接口服务器地址");

  await fs.promises.rm(outputDir, { recursive: true, force: true });
  await fs.promises.mkdir(outputDir, { recursive: true });

  const generated = [];
  const failed = [];

  await Promise.all(
    PROJECT_TYPES.map(async (projectType) => {
      const apiUrl = `${server}/${projectType}/v2/api-docs`;
      const errorUrl = `${server}/${projectType}/errors/api-ecs`;
      const jsonPath = path.resolve(outputDir, `${projectType}.json`);
      try {
        await generateJson({ jsonPath, apiUrl, errorUrl, onLog });
        generated.push(projectType);
        onLog?.(`✔ ${projectType}.json 生成完成`);
      } catch (err) {
        failed.push({ type: projectType, message: err.message });
        onLog?.(`✗ ${projectType}.json 生成失败: ${err.message}`);
      }
    }),
  );

  if (failed.length > 0) {
    throw new Error(
      `部分服务的 OpenAPI JSON 生成失败: ${failed
        .map((f) => `${f.type}(${f.message})`)
        .join("; ")}`,
    );
  }

  try {
    await writeApiIndex(outputDir);
    onLog?.(`✔ api-index.json 生成完成`);
  } catch (err) {
    onLog?.(`✗ api-index.json 生成失败: ${err.message}`);
  }

  return { generated, failed };
}

// ─── search-utils 与 api-index 生成（对应 search-utils.ts 和 utils.ts 中的部分逻辑）───

const synonymGroups = [
  {
    main: "登录",
    words: ["登录", "登陆", "signin", "login", "sign-in"],
  },
  {
    main: "登出",
    words: ["登出", "退出", "注销", "logout", "signout", "sign-out"],
  },
  {
    main: "鉴权",
    words: [
      "鉴权",
      "认证",
      "授权",
      "身份验证",
      "auth",
      "authorize",
      "authentication",
      "authorization",
    ],
  },
  {
    main: "用户",
    words: ["用户", "账号", "账户", "account", "user", "member"],
  },
  {
    main: "昵称",
    words: [
      "昵称",
      "用户名",
      "用户昵称",
      "名称",
      "名字",
      "username",
      "nickname",
      "displayname",
    ],
  },
  {
    main: "用户ID",
    words: ["用户ID", "uid", "userId", "id"],
  },
  {
    main: "视频",
    words: ["视频", "video", "media", "影片", "内容"],
  },
  {
    main: "上传",
    words: ["上传", "上载", "upload"],
  },
  {
    main: "下载",
    words: ["下载", "download", "导出"],
  },
  {
    main: "新增",
    words: ["新增", "创建", "添加", "create", "add", "insert"],
  },
  {
    main: "修改",
    words: ["修改", "更新", "编辑", "更改", "update", "edit", "patch"],
  },
  {
    main: "删除",
    words: ["删除", "移除", "remove", "delete"],
  },
  {
    main: "列表",
    words: ["列表", "list", "query", "search", "find", "分页"],
  },
  {
    main: "详情",
    words: ["详情", "detail", "info", "信息", "data"],
  },
];

const synonymDict = new Map();
for (const group of synonymGroups) {
  const normalizedWords = group.words.map((item) => item.toLowerCase());
  const normalizedMain = group.main.toLowerCase();
  for (const word of normalizedWords) {
    synonymDict.set(word, { main: normalizedMain, words: normalizedWords });
  }
}

function normalizeText(text) {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[_./-]+/g, " ")
    .replace(/[^\u4e00-\u9fa5a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeText(text) {
  if (!text) return [];
  const normalized = normalizeText(text);
  if (!normalized) return [];
  const chineseTokens = cut(normalized);
  const englishTokens = normalized.match(/[a-z0-9]+/g) || [];
  const combined = [...chineseTokens, ...englishTokens];
  return [...new Set(combined.filter((t) => t.trim().length > 0))];
}

function expandSynonyms(token) {
  const entry = synonymDict.get(token);
  return entry ? entry.words : [token];
}

function buildSearchTokens(parts) {
  const result = new Set();
  for (const part of parts) {
    for (const token of tokenizeText(part)) {
      result.add(token);
      for (const synonym of expandSynonyms(token)) {
        result.add(synonym);
      }
    }
  }
  return [...result];
}

function extractPathTokens(pathStr) {
  if (!pathStr) return [];
  const parts = pathStr.split("/").filter(Boolean);
  const tokens = [];
  for (const part of parts) {
    tokens.push(part);
    const hyphenParts = part.split("-").filter(Boolean);
    if (hyphenParts.length > 1) {
      tokens.push(...hyphenParts);
    }
  }
  return tokens;
}

function extractTagTokens(tags) {
  if (!tags || tags.length === 0) return [];
  const tokens = [];
  for (const tag of tags) {
    const match = tag.match(/^api-(.+?)(?:-controller)?$/i);
    if (match) {
      const controllerName = match[1];
      tokens.push(controllerName);
      const parts = controllerName.split("-").filter(Boolean);
      if (parts.length > 1) {
        tokens.push(...parts);
      }
    }
  }
  return tokens;
}

async function writeApiIndex(outputDir) {
  const index = {};

  for (const service of PROJECT_TYPES) {
    const filePath = path.resolve(outputDir, `${service}.json`);
    try {
      const content = await fs.promises.readFile(filePath, "utf-8");
      const doc = JSON.parse(content);

      for (const [pathStr, methods] of Object.entries(doc.paths || {})) {
        for (const [method, details] of Object.entries(methods || {})) {
          const key = `${service}${pathStr}:${method}`;
          index[key] = {
            service,
            method,
            path: pathStr,
            summary: details.summary || "",
            description: details.description || "",
            operationId: details.operationId || "",
            tags: details.tags || [],
            parameters: details.parameters || [],
            requestBody: details.requestBody || null,
            searchTokens: Array.from(
              new Set([
                ...buildSearchTokens([
                  details.summary || "",
                  details.description || "",
                ]),
                ...extractPathTokens(pathStr),
                ...extractTagTokens(details.tags || []),
              ]),
            ),
          };
        }
      }
    } catch (e) {
      console.warn(`Warning: Failed to read ${filePath}`, e.message);
    }
  }

  const outputPath = path.resolve(outputDir, "api-index.json");
  await fs.promises.writeFile(outputPath, JSON.stringify(index, null, 2), "utf-8");
}
