// ─── Electron 预加载脚本 ───────────────────────────────────────────────────────
// 运行在渲染进程的独立上下文中，是主进程与渲染进程之间的安全桥梁。
// 通过 contextBridge 将主进程能力以白名单的方式暴露给页面 JS，
// 避免渲染进程直接访问 Node.js/Electron API，防止 XSS 等安全攻击。

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // ── 配置管理 ────────────────────────────────────────────────────────────────

  // 获取当前用户配置（frontendProjectGroups、proxyPath 等）
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

  // 停止所有正在运行的前端项目并释放端口（顶部「全部停止」按钮）
  stopAll: () => ipcRenderer.invoke("stop-all"),

  // 获取当前正在运行的项目 id 列表，用于窗口刷新时同步 UI 状态
  getRunning: () => ipcRenderer.invoke("get-running"),

  // 仅释放所有配置端口，不停止进程（顶部「释放端口」按钮）
  killPorts: () => ipcRenderer.invoke("kill-ports"),

  // 批量关闭全部 agent-browser session
  closeAgentBrowserSessions: () =>
    ipcRenderer.invoke("close-agent-browser-sessions"),

  // ── 服务端 Proxy ─────────────────────────────────────────────────────────────

  // 获取 proxy 环境列表（对应 main.js 中的 PROXY_ENVS 常量）
  getProxyEnvs: () => ipcRenderer.invoke("get-proxy-envs"),

  // 部署 proxy 服务：传入环境 id（或 "__custom__:后缀" 格式的自定义后缀）
  // 主进程会依次执行 git pull → pm2 delete → pm2 start
  deployProxy: (envId) => ipcRenderer.invoke("deploy-proxy", { envId }),

  // 停止 proxy 服务：主进程执行 pm2 delete koa-proxy
  stopProxy: () => ipcRenderer.invoke("stop-proxy"),

  // 清理 monorepo：删除指定仓库下的 node_modules / dist / .turbo / build 目录
  cleanMonorepo: (repoKey) => ipcRenderer.invoke("clean-monorepo", { repoKey }),

  // 一键重装：清理后在指定仓库执行 pnpm install
  reinstallMonorepo: (repoKey) =>
    ipcRenderer.invoke("reinstall-monorepo", { repoKey }),

  // 开发环境体检：并发检测 node / pnpm / git / brew / pm2 版本，返回结果数组
  checkEnv: () => ipcRenderer.invoke("check-env"),

  // 端口占用查看：传入端口数组，返回每个端口的占用状态、进程名、PID
  checkPorts: (ports) => ipcRenderer.invoke("check-ports", { ports }),

  // 单端口 kill：用于端口查看器中逐行操作
  killSinglePort: (port) => ipcRenderer.invoke("kill-single-port", { port }),

  // 在指定项目目录执行一条调试命令（用于打包后排查问题）
  runProjectCommand: (projectId, command) =>
    ipcRenderer.invoke("run-project-command", { projectId, command }),

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
   * 监听来自主进程的进程资源占用数据（2 秒推送一次）
   * 数据格式：{ [projectId]: { cpu: number, memory: number } }
   *   cpu    - 进程组 CPU 占用百分比（%）
   *   memory - 进程组内存占用（MB）
   *
   * @param {Function} callback - 接收 statsMap 对象的回调函数
   * @returns {Function} 调用后取消监听
   */
  onProcessStats: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on("process-stats", handler);
    return () => ipcRenderer.removeListener("process-stats", handler);
  },

  /**
   * 主动拉取所有当前运行进程的资源占用快照
   * 适用于页面刷新后立即同步最新数据
   *
   * @returns {Promise<{ [projectId]: { cpu: number, memory: number } }>}
   */
  getProcessStats: () => ipcRenderer.invoke("get-process-stats"),
});
