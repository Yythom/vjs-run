import { ipcMain, dialog, BrowserWindow } from "electron";
import { ipcSafe } from "./safe.js";
import { getConfig } from "../config/store.js";
import {
  getAllProjects,
  getProjectById,
  getProjectRepo,
  getRepoDefinition,
} from "../config/lookup.js";
import {
  getRunningIds,
  startProject,
  stopProcess,
} from "../process-manager.js";
import { MOCK_ID, isMockRunning } from "../mock/service.js";
import { getLog } from "../log-buffer.js";
import { createSecondaryWindow } from "../services/window.js";

export function registerProjectIpc() {
  ipcMain.handle("get-project-log", (_, projectId) => {
    return getLog(projectId);
  });

  ipcSafe("open-logs-window", () => {
    createSecondaryWindow("/projects/logs");
  });

  ipcSafe("open-window", (_, route) => {
    createSecondaryWindow(route);
  });

  ipcMain.handle("close-window", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      win.close();
    }
  });
  // 返回前端项目列表，供渲染进程渲染侧边栏
  ipcMain.handle("get-projects", () => {
    const config = getConfig();
    return getAllProjects(config).map((project) => ({
      ...project,
      repoLabel: getRepoDefinition(project.repoKey, config).label,
    }));
  });

  // 返回当前正在运行的项目 / 服务 id 列表，供窗口刷新时同步状态
  ipcMain.handle("get-running", () => {
    const ids = getRunningIds();
    if (isMockRunning()) ids.push(MOCK_ID);
    return ids;
  });

  // 启动前端项目：spawn pnpm dev（detached，子进程树整组可被 stopProcess 回收）
  ipcSafe("start-project", async (_, projectId) => {
    const project = getProjectById(projectId);
    if (!project) throw new Error("Project not found");
    const repo = getProjectRepo(project);
    if (!repo.path) throw new Error(`${repo.label} 路径未配置`);
    await startProject(project, repo);
  });

  // 停止前端项目：对 detached 进程组发 SIGTERM，整棵子进程树退出、端口随之释放
  ipcSafe("stop-project", (_, projectId) => {
    stopProcess(String(projectId));
  });


  // 打开系统文件选择器，选择一个文件夹目录
  ipcMain.handle("select-directory", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: "选择 Repo 根目录",
      properties: ["openDirectory"],
    });
    if (canceled) {
      return null;
    }
    return filePaths[0];
  });
}
