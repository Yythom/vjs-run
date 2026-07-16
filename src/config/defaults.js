// 默认配置。所有字段在 UI 里都可改，这里的默认值仅用于：
//   - 首次启动 config.json 不存在时
//   - 用户漏填某些字段时的兜底
//
// 历史上读过 /Users/yeyuteng/tool/swagger-mock/.env 来填默认 mock 字段，
// 现在彻底去硬编码：mockSpecPath 默认为空 → 启动 mock 前会强制要求用户在
// Settings 里填路径；frontendProjectGroups 默认为空数组 → 引导用户在 UI 新增 Repo。
//
// mockDataDir / mockRulesFile 由 app.whenReady 阶段的 ensureUserMockAssets()
// 写入 userData 目录后，再覆盖到 DEFAULT_CONFIG 的对应字段。

import path from "node:path";
import { BUILTIN_MOCK_ASSETS_DIR } from "../paths.js";

export const DEFAULT_CONFIG = {
  // 用户在 UI 里新增 Repo；首次启动空列表，避免硬编码绝对路径换机就报错
  frontendProjectGroups: [],

  // mock 相关
  mockSpecPath: "",
  // swagger 源服务器地址（如 http://xxx/t2）。在设置页点击「生成 OpenAPI JSON」
  // 时，从该服务器拉取 swagger 文档写入 mockSpecPath
  mockSwaggerServer: "http://alb-qtjrjlj7p6s63het87.cn-shanghai.alb.aliyuncs.com",
  mockHost: "127.0.0.1",
  mockPort: 3002,
  mockServiceAddress: "",
  // 这两条会在 ensureUserMockAssets 之后被覆盖到 userData 路径
  mockDataDir: path.join(BUILTIN_MOCK_ASSETS_DIR, "mock-data"),
  mockRulesFile: path.join(BUILTIN_MOCK_ASSETS_DIR, "mock-rules.json"),
  mockBackendBaseUrl: "",
  mockAll: false,
  mockVjToken: "",

  // UI 偏好
  sidebarWidth: 248,

  // 端口占用查看器默认监听的端口
  watchedPorts: [3000, 3001, 5173, 3002],

  // Ollama 相关配置
  ollamaVersion: "latest",
  aiBaseUrl: "http://127.0.0.1:11434",
};
