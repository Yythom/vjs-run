import { useEffect, useMemo, useState } from "react";
import TitleBar from "./components/TitleBar";
import Sidebar from "./components/Sidebar";
import DetailPanel from "./components/DetailPanel";
import SettingsModal from "./components/modals/SettingsModal";
import RepoEditorModal from "./components/modals/RepoEditorModal";
import CleanModal from "./components/modals/CleanModal";
import EnvCheckModal from "./components/modals/EnvCheckModal";
import PortCheckerModal from "./components/modals/PortCheckerModal";
import ToastContainer from "./components/ToastContainer";
import { CLEAN_ID, DEFAULT_WATCHED_PORTS, PROXY_ID } from "./constants";
import { getStatusLabel } from "./utils/ansi";
import useToasts from "./hooks/useToasts";
import useProjectRunner from "./hooks/useProjectRunner";
import useProxyRunner from "./hooks/useProxyRunner";

export default function App() {
  const { toasts, showToast } = useToasts();

  const [proxyEnvs, setProxyEnvs] = useState([]);
  const [appConfig, setAppConfig] = useState({
    frontendProjectGroups: [],
    proxyPath: "",
  });

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [repoEditorTarget, setRepoEditorTarget] = useState(null);
  const [cleanTargetRepo, setCleanTargetRepo] = useState(null);
  const [cleanOpen, setCleanOpen] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);
  const [portOpen, setPortOpen] = useState(false);
  const [closingAgentBrowserSessions, setClosingAgentBrowserSessions] =
    useState(false);

  const {
    projects,
    statuses,
    setStatuses,
    logs,
    selectedId,
    setSelectedId,
    selectPanel,
    debugCommand,
    setDebugCommand,
    appendLog,
    clearLog,
    startProject,
    stopProject,
    runDebugCommand,
    stopAll,
    detail: projectDetail,
    refreshProjects,
  } = useProjectRunner({ showToast });

  const {
    proxyEnvId,
    proxyCustomSuffix,
    proxyBadge,
    setProxyEnvId,
    handleChangeCustomSuffix,
    handleSelectEnv,
    handleProxyDeploy,
    handleProxyStop,
  } = useProxyRunner({
    proxyEnvs,
    setStatuses,
    appendLog,
    setSelectedId,
    showToast,
  });

  const proxyStatus = statuses[PROXY_ID] || "stopped";
  const repoGroups = appConfig.frontendProjectGroups || [];
  const proxyStatusLabel =
    proxyStatus === "running"
      ? "运行中"
      : proxyStatus === "starting"
        ? "部署中…"
        : proxyStatus === "error"
          ? "出错"
          : "未部署";

  const detail = useMemo(() => {
    if (!selectedId) return null;

    if (selectedId === PROXY_ID) {
      const status = statuses[PROXY_ID] || "stopped";
      return {
        name: "API Proxy",
        filter: appConfig.proxyPath || "—",
        logTitle: "koa-proxy — pm2",
        status,
        label:
          status === "running"
            ? "运行中"
            : status === "starting"
              ? "部署中…"
              : status === "error"
                ? "出错"
                : "未部署",
        badgeClass: status === "running" ? "proxy-running" : status,
        cpu: "—",
        mem: "—",
      };
    }

    if (projectDetail) return projectDetail;

    const status = statuses[selectedId] || "stopped";
    return {
      name: String(selectedId),
      filter: "—",
      logTitle: `${selectedId} — command`,
      status,
      label: getStatusLabel(status),
      badgeClass: status,
      cpu: "—",
      mem: "—",
    };
  }, [appConfig.proxyPath, projectDetail, selectedId, statuses]);

  const openSettings = () => setSettingsOpen(true);
  const getRepoTarget = (repoKey) => {
    if (!repoKey) return null;
    return repoGroups.find((repo) => repo.key === repoKey) || null;
  };

  const openRepoEditor = (repoKey) => {
    const repo = getRepoTarget(repoKey);
    if (!repo) return;
    setRepoEditorTarget({
      ...repo,
      originalKey: repo.key,
      mode: "edit",
    });
  };

  const openCreateRepo = () => {
    setRepoEditorTarget({
      mode: "create",
      originalKey: null,
      key: "",
      label: "",
      path: "",
      projects: [{ key: "", name: "", command: "" }],
    });
  };

  const saveRepoEditor = async (nextRepo) => {
    const nextGroups =
      repoEditorTarget?.mode === "create"
        ? [...repoGroups, nextRepo]
        : repoGroups.map((repo) =>
            repo.key === repoEditorTarget.originalKey ? nextRepo : repo,
          );

    const result = await window.electronAPI.setConfig({
      frontendProjectGroups: nextGroups,
    });

    if (!result?.success) {
      throw new Error(result?.error || "未知错误");
    }

    setAppConfig(
      result.config || {
        frontendProjectGroups: [],
        proxyPath: "",
      },
    );
    await refreshProjects();
    setRepoEditorTarget(null);
    showToast("Repo 配置已保存，前端进程已重置", "success");
  };

  const deleteRepo = async (repo) => {
    const nextGroups = repoGroups.filter((item) => item.key !== repo.key);
    const result = await window.electronAPI.setConfig({
      frontendProjectGroups: nextGroups,
    });

    if (!result?.success) {
      throw new Error(result?.error || "未知错误");
    }

    setAppConfig(
      result.config || {
        frontendProjectGroups: [],
        proxyPath: "",
      },
    );
    await refreshProjects();
    setRepoEditorTarget(null);
    showToast("Repo 已删除，前端进程已重置", "success");
  };

  const openCleanForRepo = (repoKey) => {
    if (statuses[CLEAN_ID] === "starting") return;
    setCleanTargetRepo(getRepoTarget(repoKey));
    setCleanOpen(true);
  };

  const killPorts = async () => {
    const result = await window.electronAPI.killPorts();
    showToast(
      result.success
        ? "端口 8801 / 3000 / 3001 已释放"
        : `释放失败: ${result.error}`,
      result.success ? "success" : "error",
    );
  };

  const closeAgentBrowserSessions = async () => {
    if (closingAgentBrowserSessions) return;

    setClosingAgentBrowserSessions(true);
    try {
      const result = await window.electronAPI.closeAgentBrowserSessions();
      showToast(
        result.success
          ? "agent-browser sessions 已全部关闭"
          : `关闭失败: ${result.error}`,
        result.success ? "success" : "error",
      );
    } finally {
      setClosingAgentBrowserSessions(false);
    }
  };

  useEffect(() => {
    const init = async () => {
      const [proxyData, cfg] = await Promise.all([
        window.electronAPI.getProxyEnvs(),
        window.electronAPI.getConfig(),
      ]);

      setProxyEnvs(proxyData || []);
      setProxyEnvId(proxyData?.[0]?.id || "default");
      setAppConfig(
        cfg || {
          frontendProjectGroups: [],
          proxyPath: "",
        },
      );
    };

    init();
  }, [setProxyEnvId]);

  return (
    <div className="bg-base text-slate-200 text-sm overflow-hidden h-screen flex flex-col font-sans">
      <TitleBar
        onOpenSettings={openSettings}
        onCloseAgentBrowserSessions={closeAgentBrowserSessions}
        onKillPorts={killPorts}
        onStopAll={stopAll}
        onOpenEnvCheck={() => setEnvOpen(true)}
        onOpenPortChecker={() => setPortOpen(true)}
        closingAgentBrowserSessions={closingAgentBrowserSessions}
      />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          proxyProps={{
            status: proxyStatus,
            proxyStatusLabel,
            proxyBadge,
            proxyEnvActive: proxyStatus === "running",
            proxyEnvs,
            proxyEnvId,
            customSuffix: proxyCustomSuffix,
            onChangeCustomSuffix: handleChangeCustomSuffix,
            onSelectEnv: handleSelectEnv,
            onDeploy: handleProxyDeploy,
            onStop: handleProxyStop,
            onSelectLog: () => selectPanel(PROXY_ID),
          }}
          projectProps={{
            repoGroups,
            projects,
            statuses,
            selectedId,
            onSelectPanel: selectPanel,
            onStart: startProject,
            onStop: stopProject,
            onConfigureRepo: openRepoEditor,
            onCleanRepo: openCleanForRepo,
            onCreateRepo: openCreateRepo,
          }}
        />

        <main className="flex-1 flex flex-col overflow-hidden">
          <DetailPanel
            selectedId={selectedId}
            detail={detail}
            logs={logs}
            debugCommand={debugCommand}
            setDebugCommand={setDebugCommand}
            onStart={() => selectedId && startProject(selectedId)}
            onStop={() => selectedId && stopProject(selectedId)}
            onDeploy={handleProxyDeploy}
            onProxyStop={handleProxyStop}
            onClearLog={() => clearLog(selectedId)}
            onRunDebugCommand={runDebugCommand}
          />
        </main>
      </div>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={(cfg) => {
          setAppConfig(
            cfg || {
              frontendProjectGroups: [],
              proxyPath: "",
            },
          );
          setSettingsOpen(false);
          showToast("配置已保存，下次启动项目时生效", "success");
        }}
        onSaveError={(error) => showToast(`保存失败: ${error}`, "error")}
        onValidateError={() => showToast("路径不能为空", "warning")}
      />

      <RepoEditorModal
        open={!!repoEditorTarget}
        repo={repoEditorTarget}
        existingKeys={repoGroups.map((repo) => repo.key)}
        onClose={() => setRepoEditorTarget(null)}
        onSave={saveRepoEditor}
        onDelete={deleteRepo}
        onSaveError={(error) => showToast(`保存失败: ${error}`, "error")}
        onValidateError={(type) =>
          showToast(
            type === "repo"
              ? "Repo 的 key、名称和路径不能为空"
              : type === "repo-key"
                ? "Repo key 不能重复"
                : type === "projects"
                  ? "至少需要一个项目"
                  : type === "project-key"
                    ? "项目 key 不能重复"
                    : "项目的 key、名称和命令不能为空",
            "warning",
          )
        }
      />

      <CleanModal
        open={cleanOpen}
        state={statuses[CLEAN_ID] || "stopped"}
        logs={logs[CLEAN_ID] || []}
        repoLabel={cleanTargetRepo?.label || "当前仓库"}
        repoPath={cleanTargetRepo?.path || ""}
        onRun={async ({ autoInstall }) => {
          if (statuses[CLEAN_ID] === "starting") return;
          const repoKey = cleanTargetRepo?.key;

          if (!repoKey) {
            showToast("未找到可用的前端仓库", "warning");
            return;
          }

          if (!cleanTargetRepo?.path) {
            showToast("当前前端仓库路径未配置", "warning");
            return;
          }

          clearLog(CLEAN_ID);
          setStatuses((prev) => ({ ...prev, [CLEAN_ID]: "starting" }));

          if (autoInstall) await window.electronAPI.reinstallMonorepo(repoKey);
          else await window.electronAPI.cleanMonorepo(repoKey);
        }}
        onClose={() => {
          setCleanOpen(false);
          setCleanTargetRepo(null);
        }}
      />

      <EnvCheckModal
        open={envOpen}
        onClose={() => setEnvOpen(false)}
        onError={(error) => showToast(`环境检测失败: ${error}`, "error")}
      />

      <PortCheckerModal
        open={portOpen}
        defaultWatchedPorts={DEFAULT_WATCHED_PORTS}
        onClose={() => setPortOpen(false)}
        onToast={showToast}
      />

      <ToastContainer toasts={toasts} />
    </div>
  );
}
