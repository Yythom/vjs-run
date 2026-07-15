import { create } from "zustand";
import { CLEAN_ID, MOCK_ID } from "../constants";
import * as logStore from "./log-store";
import * as statusStore from "./status-store";
import { showToast } from "../utils/toast";

/**
 * 进程层 store。模块级单例，IPC 监听在文件首次 import 时挂一次。
 *
 * 状态：projects 列表 + debugCommand（受控输入）
 * 行为：启停项目 / mock、清理日志、刷新列表
 *
 * 日志统一走 logStore；status 统一走 statusStore，组件分别用各自的 hook 订阅。
 */
export const useRunnerStore = create((set, get) => ({
  projects: [],
  debugCommand: "",

  setDebugCommand: (debugCommand) => set({ debugCommand }),

  startProject: async (id) => {
    const projectId = String(id);
    const project = get().projects.find((p) => p.id === projectId);

    statusStore.set(projectId, "starting");
    logStore.append(projectId, "\x1b[36m══════════════════════════════\x1b[0m\n");
    logStore.append(projectId, `\x1b[36m▶ 启动 ${project?.name || projectId}\x1b[0m\n`);
    logStore.append(projectId, "\x1b[36m══════════════════════════════\x1b[0m\n");

    const result = await window.electronAPI.startProject(projectId);
    if (!result.success) {
      statusStore.set(projectId, "error");
      showToast(`启动失败: ${result.error}`, "error");
    }
  },

  stopProject: async (id) => {
    const projectId = String(id);
    const project = get().projects.find((p) => p.id === projectId);

    statusStore.set(projectId, "stopped");
    const result = await window.electronAPI.stopProject(projectId);

    showToast(
      result.success
        ? `已停止 ${project?.name || projectId}`
        : `停止失败: ${result.error}`,
      result.success ? "success" : "error",
    );
  },

  runDebugCommand: async (projectId) => {
    const debugCommand = get().debugCommand;
    if (!projectId || !debugCommand.trim()) return;
    const result = await window.electronAPI.runProjectCommand(
      projectId,
      debugCommand.trim(),
    );
    if (!result.success) {
      showToast(
        `命令执行失败: ${result.error || `exit ${result.code}`}`,
        "error",
      );
    }
  },

  startMock: async () => {
    statusStore.set(MOCK_ID, "starting");
    logStore.append(MOCK_ID, "\x1b[35m══════════════════════════════\x1b[0m\n");
    logStore.append(MOCK_ID, "\x1b[35m▶ 启动 Swagger Mock\x1b[0m\n");
    logStore.append(MOCK_ID, "\x1b[35m══════════════════════════════\x1b[0m\n");

    const result = await window.electronAPI.startMock();
    showToast(
      result.success ? "Swagger Mock 已启动" : `启动失败: ${result.error}`,
      result.success ? "success" : "error",
    );
    if (!result.success) {
      statusStore.set(MOCK_ID, "error");
    }
  },

  stopMock: async () => {
    statusStore.set(MOCK_ID, "stopped");
    const result = await window.electronAPI.stopMock();
    showToast(
      result.success ? "Swagger Mock 已停止" : `停止失败: ${result.error}`,
      result.success ? "success" : "error",
    );
  },

  refreshProjects: async () => {
    const projectData = await window.electronAPI.getProjects();
    const nextProjects = projectData || [];
    set({ projects: nextProjects });

    // 初始化所有 id 的 status（保留旧值；新 id 默认 stopped）
    statusStore.setMany([
      [MOCK_ID, statusStore.get(MOCK_ID)],
      [CLEAN_ID, statusStore.get(CLEAN_ID)],
      ...nextProjects.map((p) => [p.id, statusStore.get(p.id)]),
    ]);

    // backend 视为「正在跑」的批量标 running
    const running = await window.electronAPI.getRunning();
    if ((running || []).length > 0) {
      statusStore.setMany(running.map((id) => [id, "running"]));
    }
  },
}));

// ─── 模块初始化：IPC 监听 + 首次拉项目列表 ────────────────────────────────────

if (typeof window !== "undefined" && window.electronAPI && !window.__RUNNER_WIRED__) {
  window.electronAPI.onProcessStatus(({ projectId, status }) => {
    const prev = statusStore.get(projectId);

    // 仅在「非 error → error」过渡时注入红色横幅，避免重复触发时多条
    if (status === "error" && prev !== "error") {
      logStore.append(
        projectId,
        "\n\x1b[1;41;97m  ✗ 启动失败 / 进程异常退出，请向上查看错误日志  \x1b[0m\n\n",
      );
    }
    statusStore.set(projectId, status);

    if (projectId === CLEAN_ID && status === "stopped") {
      showToast("Monorepo 清理完成 ✨", "success");
    }
    if (projectId === CLEAN_ID && status === "error") {
      showToast("清理出错，请查看日志", "error");
    }
  });

  // 首次拉取项目列表
  useRunnerStore.getState().refreshProjects();

  window.__RUNNER_WIRED__ = true;
}

// ─── 便捷 API ────────────────────────────────────────────────────────────────

// 响应式（订阅切片，组件 re-render 跟随）
export const useProjects = () => useRunnerStore((s) => s.projects);
export const useDebugCommand = () => useRunnerStore((s) => s.debugCommand);

// 稳定的 action 函数（zustand 在 create 时一次性 bind，引用永远不变）
export const setDebugCommand = (v) => useRunnerStore.getState().setDebugCommand(v);
export const startProject = (id) => useRunnerStore.getState().startProject(id);
export const stopProject = (id) => useRunnerStore.getState().stopProject(id);
export const runDebugCommand = (id) => useRunnerStore.getState().runDebugCommand(id);
export const startMock = () => useRunnerStore.getState().startMock();
export const stopMock = () => useRunnerStore.getState().stopMock();
export const refreshProjects = () => useRunnerStore.getState().refreshProjects();
