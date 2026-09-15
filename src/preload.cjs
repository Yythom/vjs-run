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

  // 在系统文件管理器中打开指定目录，options.create=true 时不存在则先创建
  openDirectory: (dirPath, options) =>
    ipcRenderer.invoke("open-directory", dirPath, options),

  // ── Swagger Mock ────────────────────────────────────────────────────────────

  // 启动/停止 Swagger Mock 服务：读取配置中的 OpenAPI JSON/YAML 文件或目录
  startMock: () => ipcRenderer.invoke("start-mock"),

  stopMock: () => ipcRenderer.invoke("stop-mock"),

  // 从 swagger 源服务器生成 OpenAPI JSON 到 mockSpecPath 目录（独立操作）
  generateMockSpec: () => ipcRenderer.invoke("generate-mock-spec"),

  // 探查输出目录：{ exists, staleCount, foreignCount }，供生成前提示用
  inspectSpecDir: (dirPath) => ipcRenderer.invoke("inspect-spec-dir", dirPath),

  // 独立转换工具：sourceType 为 "url"（拉取地址）或 "text"（文件/粘贴的 JSON 内容）
  convertSwaggerSpec: (sourceType, value) =>
    ipcRenderer.invoke("convert-swagger-spec", { sourceType, value }),

  saveSwaggerSpec: (content, defaultFilename) =>
    ipcRenderer.invoke("save-swagger-spec", { content, defaultFilename }),

  getMockRoutes: () => ipcRenderer.invoke("get-mock-routes"),

  getMockRules: () => ipcRenderer.invoke("get-mock-rules"),

  saveMockRules: (rules) => ipcRenderer.invoke("save-mock-rules", { rules }),

  // 根据 swagger schema 生成一份推荐 mock JSON（不写盘，仅返回供用户复制）
  previewMockResponse: ({ method, path }) =>
    ipcRenderer.invoke("preview-mock-response", { method, path }),

  // 接口的请求侧 schema：query/path/header 参数 + requestBody 字段，
  // 供规则编辑器展示参数表并一键填成变体匹配条件
  getMockRequestSchema: ({ method, path }) =>
    ipcRenderer.invoke("get-mock-request-schema", { method, path }),

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

  // 把一批规则写进场景：mode="create" 建新场景，mode="merge" 按 method+path 覆盖已有场景
  addRulesToMockScene: (name, rules, mode) =>
    ipcRenderer.invoke("add-rules-to-mock-scene", { name, rules, mode }),

  applyMockScene: (name) => ipcRenderer.invoke("apply-mock-scene", { name }),

  deleteMockScene: (name) => ipcRenderer.invoke("delete-mock-scene", { name }),

  renameMockScene: (oldName, newName) =>
    ipcRenderer.invoke("rename-mock-scene", { oldName, newName }),

  // 导出场景到用户选择的文件 / 从文件导入为新场景（走系统文件对话框）
  exportMockScene: (name) => ipcRenderer.invoke("export-mock-scene", { name }),

  importMockScene: () => ipcRenderer.invoke("import-mock-scene"),

  getMockSceneRules: (name) =>
    ipcRenderer.invoke("get-mock-scene-rules", { name }),

  saveMockSceneRules: (name, rules) =>
    ipcRenderer.invoke("save-mock-scene-rules", { name, rules }),

  // 用系统默认应用打开 mock-rules.json；传场景名则打开对应场景文件
  openMockRulesFile: (scene) =>
    ipcRenderer.invoke("open-mock-rules-file", { scene }),

  // 打开包含 mock-rules.json 或场景文件的文件夹，并选中该文件
  openMockRulesFolder: (opts) =>
    ipcRenderer.invoke("open-mock-rules-folder", typeof opts === "string" ? { scene: opts } : opts),

  // 清理 monorepo：删除指定仓库下的 node_modules / dist / .turbo / build 目录
  cleanMonorepo: (repoKey) => ipcRenderer.invoke("clean-monorepo", { repoKey }),

  // 一键重装：清理后在指定仓库执行 pnpm install
  reinstallMonorepo: (repoKey) =>
    ipcRenderer.invoke("reinstall-monorepo", { repoKey }),

  // 终止进行中的清理 / 重装
  stopCleanMonorepo: () => ipcRenderer.invoke("stop-clean-monorepo"),

  // ── 小程序发布 ──────────────────────────────────────────────────────────────

  // 读取指定目录的本地分支列表，返回 { current, branches }
  getRepoBranches: (repoPath) =>
    ipcRenderer.invoke("get-repo-branches", { repoPath }),

  // 在指定目录下执行 pnpm deploy:weapp（构建 Taro 产物 + 上传微信 CI，仅测试服）
  // payload: { repoPath, branch, robot, pullLatest }
  startWeappDeploy: (payload) =>
    ipcRenderer.invoke("start-weapp-deploy", payload),

  // 终止进行中的小程序发布
  stopWeappDeploy: () => ipcRenderer.invoke("stop-weapp-deploy"),

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

  // ── AI 工单台（飞书需求面板）────────────────────────────────────────────────────

  // 探测 lark-cli 是否安装、事件总线是否在跑
  dockingProbe: () => ipcRenderer.invoke("docking-probe"),

  // 探测 Claude Code CLI 是否安装
  dockingClaudeProbe: () => ipcRenderer.invoke("docking-claude-probe"),

  // 一键安装指定 CLI 包（如 lark-cli 或 claude）
  dockingInstallCli: (name) => ipcRenderer.invoke("docking-install-cli", { name }),

  // 飞书消息监听器的启停与当前状态
  dockingGetStatus: () => ipcRenderer.invoke("docking-get-status"),
  dockingStart: () => ipcRenderer.invoke("docking-start"),
  dockingStop: () => ipcRenderer.invoke("docking-stop"),

  // 运行时开关（自动回执、完成通知、自动派活、隔离分支、白名单…）
  dockingGetSettings: () => ipcRenderer.invoke("docking-get-settings"),
  dockingSetSettings: (patch) =>
    ipcRenderer.invoke("docking-set-settings", { patch }),

  // 任务列表读写
  dockingCommands: () => ipcRenderer.invoke("docking-commands"),
  dockingListTasks: () => ipcRenderer.invoke("docking-list-tasks"),
  dockingAddTask: (payload) =>
    ipcRenderer.invoke("docking-add-task", payload || {}),
  dockingUpdateTask: (id, patch) =>
    ipcRenderer.invoke("docking-update-task", { id, patch }),
  dockingDeleteTask: (id) => ipcRenderer.invoke("docking-delete-task", { id }),

  // 批量删除（勾选后一次删掉），一次写盘
  dockingDeleteTasks: (ids) =>
    ipcRenderer.invoke("docking-delete-tasks", { ids }),

  // 勾选的任务拼成 prompt，copy=true 时同时写入系统剪贴板
  dockingBuildPrompt: (ids, copy) =>
    ipcRenderer.invoke("docking-build-prompt", { ids, copy }),
  // 需求池工作包里 AI 写出的 plan.md：读内容 / 用系统默认应用打开
  dockingReadPlan: (id) => ipcRenderer.invoke("docking-read-plan", { id }),
  dockingOpenPlan: (id) => ipcRenderer.invoke("docking-open-plan", { id }),

  // 任务的隔离 worktree：现状 / 在 Finder 打开 / 清理（未提交改动先存进分支）
  dockingWorktreeInfo: (id) => ipcRenderer.invoke("docking-worktree-info", { id }),
  dockingWorktreeOpen: (id) => ipcRenderer.invoke("docking-worktree-open", { id }),
  dockingWorktreeCleanup: (id, deleteBranch) =>
    ipcRenderer.invoke("docking-worktree-cleanup", { id, deleteBranch }),

  // 用飞书原路回问提出人（仅由用户在面板显式触发）
  dockingAsk: (id, question) =>
    ipcRenderer.invoke("docking-ask", { id, question }),

  // 人工一键飞书回复排查解答给提出人
  dockingReplySolution: (id, text, markDone) =>
    ipcRenderer.invoke("docking-reply-solution", { id, text, markDone }),

  // ── 自动处理（无头 Agent） ──────────────────────────────────────────────────────

  // 在 cwd 起一个无头会话处理需求
  // mode: analyze | plan | edit | full；engine: claude | agy | codex；createBranch: boolean
  // freshSession: true 时不续接上一轮会话（仅 claude 会续接）
  dockingRunStart: (ids, cwd, mode, engine, createBranch, freshSession) =>
    ipcRenderer.invoke("docking-run-start", {
      ids,
      cwd,
      mode,
      engine,
      createBranch,
      freshSession,
    }),

  // agy 接入：检测 / 配置 / 撤销（会动全局 MCP 注册和 settings.json）
  dockingAgyProbe: () => ipcRenderer.invoke("docking-agy-probe"),
  dockingAgySetup: () => ipcRenderer.invoke("docking-agy-setup"),
  dockingAgyTeardown: () => ipcRenderer.invoke("docking-agy-teardown"),

  // codex 接入：检测 / 配置 / 撤销（会动全局 MCP 注册 ~/.codex/config.toml）
  dockingCodexProbe: () => ipcRenderer.invoke("docking-codex-probe"),
  dockingCodexSetup: () => ipcRenderer.invoke("docking-codex-setup"),
  dockingCodexTeardown: () => ipcRenderer.invoke("docking-codex-teardown"),
  dockingRunStop: (jobId) => ipcRenderer.invoke("docking-run-stop", { jobId }),
  dockingRunStatus: () => ipcRenderer.invoke("docking-run-status"),
  dockingJobCancel: (jobId) => ipcRenderer.invoke("docking-job-cancel", { jobId }),
  dockingQueueStatus: () => ipcRenderer.invoke("docking-queue-status"),

  // 调度队列全量状态推送
  onDockingQueueStatus: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on("docking-queue-status", handler);
    return () => ipcRenderer.removeListener("docking-queue-status", handler);
  },

  // Job 独立日志流
  onDockingJobLog: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on("docking-job-log", handler);
    return () => ipcRenderer.removeListener("docking-job-log", handler);
  },

  // Job 独立完成推送
  onDockingJobDone: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on("docking-job-done", handler);
    return () => ipcRenderer.removeListener("docking-job-done", handler);
  },

  // 处理过程的日志行（向下兼容）
  onDockingRunLog: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on("docking-run-log", handler);
    return () => ipcRenderer.removeListener("docking-run-log", handler);
  },

  // 运行状态变化（向下兼容）
  onDockingRunStatus: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on("docking-run-status", handler);
    return () => ipcRenderer.removeListener("docking-run-status", handler);
  },

  // 运行完成推送（向下兼容）
  onDockingRunDone: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on("docking-run-done", handler);
    return () => ipcRenderer.removeListener("docking-run-done", handler);
  },

  // 监听任务变化推送（created / updated / replied）
  onDockingTask: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on("docking-task", handler);
    return () => ipcRenderer.removeListener("docking-task", handler);
  },

  // 监听监听器状态推送（running / retrying / lastError）
  onDockingStatus: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on("docking-status", handler);
    return () => ipcRenderer.removeListener("docking-status", handler);
  },

  // ── AI 调用历史记录 ────────────────────────────────────────────────────────
  dockingGetHistory: (params) =>
    ipcRenderer.invoke("docking-history-list", params || {}),
  dockingGetHistoryDetail: (jobId) =>
    ipcRenderer.invoke("docking-history-get", { jobId }),
  dockingDeleteHistory: (jobId) =>
    ipcRenderer.invoke("docking-history-delete", { jobId }),
  dockingClearHistory: () => ipcRenderer.invoke("docking-history-clear"),
  onDockingHistoryUpdated: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on("docking-history-updated", handler);
    return () => ipcRenderer.removeListener("docking-history-updated", handler);
  },
});
