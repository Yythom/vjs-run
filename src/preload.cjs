// ─── Electron 预加载脚本 ───────────────────────────────────────────────────────
// 运行在渲染进程的独立上下文中，是主进程与渲染进程之间的安全桥梁。
// 通过 contextBridge 将主进程能力以白名单的方式暴露给页面 JS，
// 避免渲染进程直接访问 Node.js/Electron API，防止 XSS 等安全攻击。

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // ── 配置管理 ────────────────────────────────────────────────────────────────

  // 获取当前用户配置（frontendProjectGroups、mock 相关字段等）
  getConfig: () => ipcRenderer.invoke("get-config"),

  // 更新用户配置，传入需要修改的字段（partial update），保存后热生效
  setConfig: (partial) => ipcRenderer.invoke("set-config", partial),

  // ── 前端项目 ────────────────────────────────────────────────────────────────

  // 获取前端项目列表（由 main.js 中的分组配置动态派生）
  getProjects: () => ipcRenderer.invoke("get-projects"),

  // 启动指定项目的开发服务器，传入项目 id
  startProject: (projectId) => ipcRenderer.invoke("start-project", projectId),

  // 停止指定项目的开发服务器，传入项目 id
  stopProject: (projectId) => ipcRenderer.invoke("stop-project", projectId),

  // 获取当前正在运行的项目 id 列表，用于窗口刷新时同步 UI 状态
  getRunning: () => ipcRenderer.invoke("get-running"),

  // 选择文件夹，返回选择的目录绝对路径，取消返回 null
  selectDirectory: () => ipcRenderer.invoke("select-directory"),

  // ── Swagger Mock ────────────────────────────────────────────────────────────

  // 启动/停止 Swagger Mock 服务：读取配置中的 OpenAPI JSON/YAML 文件或目录
  startMock: () => ipcRenderer.invoke("start-mock"),

  stopMock: () => ipcRenderer.invoke("stop-mock"),

  // 从 swagger 源服务器生成 OpenAPI JSON 到 mockSpecPath 目录（独立操作）
  generateMockSpec: () => ipcRenderer.invoke("generate-mock-spec"),

  getMockRoutes: () => ipcRenderer.invoke("get-mock-routes"),

  getMockRules: () => ipcRenderer.invoke("get-mock-rules"),

  saveMockRules: (rules) => ipcRenderer.invoke("save-mock-rules", { rules }),

  // 根据 swagger schema 生成一份推荐 mock JSON（不写盘，仅返回供用户复制）
  previewMockResponse: ({ method, path }) =>
    ipcRenderer.invoke("preview-mock-response", { method, path }),

  // 向设置页配置的后端地址执行当前 OpenAPI 接口的 curl 调试请求
  executeMockBackendCurl: ({ method, path, params, body }) =>
    ipcRenderer.invoke("execute-mock-backend-curl", { method, path, params, body }),

  // 请求本机已启动的 mock 服务，验证接口在本地服务下的实际返回
  executeMockLocalCurl: ({ method, path, params, body }) =>
    ipcRenderer.invoke("execute-mock-local-curl", { method, path, params, body }),

  // 请求历史：全量拉取 / 清空
  getMockHistory: () => ipcRenderer.invoke("get-mock-history"),

  clearMockHistory: () => ipcRenderer.invoke("clear-mock-history"),

  // 录制：把代理到后端的真实响应固化成 mock 场景
  getMockRecording: () => ipcRenderer.invoke("get-mock-recording"),

  startMockRecording: (name, excludeMock = false) =>
    ipcRenderer.invoke("start-mock-recording", { name, excludeMock }),

  stopMockRecording: () => ipcRenderer.invoke("stop-mock-recording"),

  // 场景：命名的规则文件快照，可保存 / 应用 / 编辑 / 删除
  listMockScenes: () => ipcRenderer.invoke("list-mock-scenes"),

  saveMockScene: (name) => ipcRenderer.invoke("save-mock-scene", { name }),

  applyMockScene: (name) => ipcRenderer.invoke("apply-mock-scene", { name }),

  deleteMockScene: (name) => ipcRenderer.invoke("delete-mock-scene", { name }),

  getMockSceneRules: (name) =>
    ipcRenderer.invoke("get-mock-scene-rules", { name }),

  saveMockSceneRules: (name, rules) =>
    ipcRenderer.invoke("save-mock-scene-rules", { name, rules }),

  // 用系统默认应用打开 mock-rules.json；传场景名则打开对应场景文件
  openMockRulesFile: (scene) =>
    ipcRenderer.invoke("open-mock-rules-file", { scene }),

  // 清理 monorepo：删除指定仓库下的 node_modules / dist / .turbo / build 目录
  cleanMonorepo: (repoKey) => ipcRenderer.invoke("clean-monorepo", { repoKey }),

  // 一键重装：清理后在指定仓库执行 pnpm install
  reinstallMonorepo: (repoKey) =>
    ipcRenderer.invoke("reinstall-monorepo", { repoKey }),

  // 终止进行中的清理 / 重装
  stopCleanMonorepo: () => ipcRenderer.invoke("stop-clean-monorepo"),

  // 开发环境体检：并发检测 node / pnpm / git / brew / pm2 版本，返回结果数组
  checkEnv: () => ipcRenderer.invoke("check-env"),

  // 端口占用查看：传入端口数组，返回每个端口的占用状态、进程名、PID
  checkPorts: (ports) => ipcRenderer.invoke("check-ports", { ports }),

  // 单端口 kill：用于端口查看器中逐行操作
  killSinglePort: (port) => ipcRenderer.invoke("kill-single-port", { port }),

  // 在指定项目目录执行一条调试命令（用于打包后排查问题）
  runProjectCommand: (projectId, command) =>
    ipcRenderer.invoke("run-project-command", { projectId, command }),

  getProjectLog: (projectId) =>
    ipcRenderer.invoke("get-project-log", projectId),

  openLogsWindow: () =>
    ipcRenderer.invoke("open-logs-window"),

  openWindow: (route) =>
    ipcRenderer.invoke("open-window", route),

  closeWindow: () =>
    ipcRenderer.invoke("close-window"),

  // 导出日志到本地文件
  exportLog: (logText, defaultFilename) =>
    ipcRenderer.invoke("export-log", { logText, defaultFilename }),

  // ── 应用清理 ────────────────────────────────────────────────────────────────

  // 获取各可清理项的当前体积（Chromium 缓存 / mock 资源）
  getCleanupInfo: () => ipcRenderer.invoke("get-cleanup-info"),

  // 按勾选项执行清理，传入 target id 数组（appCache / windowState / mockData / config）
  runCleanup: (targets) => ipcRenderer.invoke("run-cleanup", { targets }),

  // ── 事件监听 ────────────────────────────────────────────────────────────────

  /**
   * 监听来自主进程的日志推送
   * 每当子进程有 stdout/stderr 输出时，主进程通过 "process-log" 频道发送过来
   *
   * @param {Function} callback - 接收 { projectId, data } 的回调函数
   * @returns {Function} 调用后取消监听（可在组件卸载时调用）
   */
  onProcessLog: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on("process-log", handler);
    // 返回取消监听函数，供调用方在不需要时手动清理
    return () => ipcRenderer.removeListener("process-log", handler);
  },

  /**
   * 监听来自主进程的进程状态变更
   * 当进程状态切换（starting / running / stopped / error）时触发
   *
   * @param {Function} callback - 接收 { projectId, status } 的回调函数
   * @returns {Function} 调用后取消监听
   */
  onProcessStatus: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on("process-status", handler);
    // 返回取消监听函数，供调用方在不需要时手动清理
    return () => ipcRenderer.removeListener("process-status", handler);
  },

  /**
   * 监听 mock server 的结构化请求记录推送（请求历史面板实时更新）
   *
   * @param {Function} callback - 接收单条历史 entry 的回调函数
   * @returns {Function} 调用后取消监听
   */
  onMockRequest: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on("mock-request", handler);
    return () => ipcRenderer.removeListener("mock-request", handler);
  },

  /**
   * 监听录制状态变化推送（开始/停止/新录到一条时触发）
   *
   * @param {Function} callback - 接收 { enabled, sceneName?, count?, startedAt? }
   * @returns {Function} 调用后取消监听
   */
  onMockRecording: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on("mock-recording", handler);
    return () => ipcRenderer.removeListener("mock-recording", handler);
  },

  // ── 自动升级 ──────────────────────────────────────────────────────────────────

  // 手动检查更新
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),

  // 用户确认后开始下载
  downloadUpdate: () => ipcRenderer.invoke("download-update"),

  // 下载完成后退出并安装
  quitAndInstall: () => ipcRenderer.invoke("quit-and-install"),

  // 监听升级状态推送（checking / available / not-available / downloaded / error）
  onUpdateStatus: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on("update-status", handler);
    return () => ipcRenderer.removeListener("update-status", handler);
  },

  // 监听下载进度推送（percent / bytesPerSecond / transferred / total）
  onUpdateProgress: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on("update-progress", handler);
    return () => ipcRenderer.removeListener("update-progress", handler);
  },
});
