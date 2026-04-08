import { useCallback, useEffect, useMemo, useState } from "react";
import { ansiToHtml, getStatusLabel } from "../utils/ansi";
import { CLEAN_ID, PROXY_ID } from "../constants";

export default function useProjectRunner({ showToast }) {
  const [projects, setProjects] = useState([]);
  const [statuses, setStatuses] = useState({
    [PROXY_ID]: "stopped",
    [CLEAN_ID]: "stopped",
  });
  const [logs, setLogs] = useState({});
  const [stats, setStats] = useState({});
  const [selectedId, setSelectedId] = useState(null);
  const [debugCommand, setDebugCommand] = useState("");

  const appendLog = useCallback((id, rawText) => {
    const html = ansiToHtml(rawText);
    setLogs((prev) => {
      const next = [...(prev[id] || []), html];
      return {
        ...prev,
        [id]: next.length > 10000 ? next.slice(5000) : next,
      };
    });
  }, []);

  const clearLog = useCallback((id) => {
    if (!id) return;
    setLogs((prev) => ({ ...prev, [id]: [] }));
  }, []);

  const selectPanel = useCallback((id) => {
    setSelectedId(id);
  }, []);

  const startProject = useCallback(
    async (id) => {
      const projectId = String(id);
      const project = projects.find((p) => p.id === projectId);

      setStatuses((prev) => ({ ...prev, [projectId]: "starting" }));
      appendLog(projectId, "\x1b[36m══════════════════════════════\x1b[0m\n");
      appendLog(projectId, `\x1b[36m▶ 启动 ${project?.name || projectId}\x1b[0m\n`);
      appendLog(projectId, "\x1b[36m══════════════════════════════\x1b[0m\n");
      setSelectedId(projectId);

      const result = await window.electronAPI.startProject(projectId);
      if (!result.success) {
        setStatuses((prev) => ({ ...prev, [projectId]: "error" }));
        showToast?.(`启动失败: ${result.error}`, "error");
      }
    },
    [appendLog, projects, showToast],
  );

  const stopProject = useCallback(
    async (id) => {
      const projectId = String(id);
      const project = projects.find((p) => p.id === projectId);

      setStatuses((prev) => ({ ...prev, [projectId]: "stopped" }));
      const result = await window.electronAPI.stopProject(projectId);

      showToast?.(
        result.success
          ? `已停止 ${project?.name || projectId}`
          : `停止失败: ${result.error}`,
        result.success ? "success" : "error",
      );
    },
    [projects, showToast],
  );

  const runDebugCommand = useCallback(async () => {
    if (!selectedId || selectedId === PROXY_ID || !debugCommand.trim()) return;

    const result = await window.electronAPI.runProjectCommand(
      selectedId,
      debugCommand.trim(),
    );

    if (!result.success) {
      showToast?.(
        `命令执行失败: ${result.error || `exit ${result.code}`}`,
        "error",
      );
    }
  }, [debugCommand, selectedId, showToast]);

  const stopAll = useCallback(async () => {
    const result = await window.electronAPI.stopAll();
    if (result.success) {
      setStatuses((prev) => {
        const next = { ...prev };
        Object.keys(next).forEach((k) => {
          next[k] = "stopped";
        });
        return next;
      });
      showToast?.("已停止所有进程并释放端口", "success");
    } else {
      showToast?.(`操作失败: ${result.error}`, "error");
    }
  }, [showToast]);

  const refreshProjects = useCallback(async () => {
    const projectData = await window.electronAPI.getProjects();
    const nextProjects = projectData || [];
    const nextProjectIds = new Set(nextProjects.map((project) => project.id));

    setProjects(nextProjects);
    setStatuses((prev) => {
      const next = {
        [PROXY_ID]: prev[PROXY_ID] || "stopped",
        [CLEAN_ID]: prev[CLEAN_ID] || "stopped",
      };

      nextProjects.forEach((project) => {
        next[project.id] = prev[project.id] || "stopped";
      });

      return next;
    });
    setLogs((prev) => {
      const next = {
        [PROXY_ID]: prev[PROXY_ID] || [],
        [CLEAN_ID]: prev[CLEAN_ID] || [],
      };

      nextProjects.forEach((project) => {
        if (prev[project.id]) next[project.id] = prev[project.id];
      });

      return next;
    });
    setStats((prev) => {
      const next = {};
      nextProjects.forEach((project) => {
        if (prev[project.id]) next[project.id] = prev[project.id];
      });
      return next;
    });
    setSelectedId((prev) =>
      prev === PROXY_ID || prev === CLEAN_ID || nextProjectIds.has(prev) ? prev : null,
    );

    const running = await window.electronAPI.getRunning();
    if ((running || []).length > 0) {
      setStatuses((prev) => {
        const next = { ...prev };
        running.forEach((id) => {
          next[id] = "running";
        });
        return next;
      });

      const statMap = await window.electronAPI.getProcessStats();
      setStats(statMap || {});
    }
  }, []);

  useEffect(() => {
    refreshProjects();
  }, [refreshProjects]);

  useEffect(() => {
    const offLog = window.electronAPI.onProcessLog(({ projectId, data }) => {
      appendLog(projectId, data);
    });

    const offStatus = window.electronAPI.onProcessStatus(
      ({ projectId, status }) => {
        setStatuses((prev) => ({ ...prev, [projectId]: status }));

        if (projectId === CLEAN_ID && status === "stopped") {
          showToast?.("Monorepo 清理完成 ✨", "success");
        }
        if (projectId === CLEAN_ID && status === "error") {
          showToast?.("清理出错，请查看日志", "error");
        }
      },
    );

    const offStats = window.electronAPI.onProcessStats((statMap) => {
      setStats(statMap || {});
    });

    return () => {
      offLog?.();
      offStatus?.();
      offStats?.();
    };
  }, [appendLog, showToast]);

  const detail = useMemo(() => {
    if (!selectedId || selectedId === PROXY_ID) return null;

    const p = projects.find((x) => x.id === selectedId);
    const status = statuses[selectedId] || "stopped";
    const s = stats[selectedId] || { cpu: "—", memory: "—" };

    return {
      name: p?.name || String(selectedId),
      filter: p?.command || "—",
      logTitle: `${p?.name || selectedId} — ${p?.command || "command"}`,
      status,
      label: getStatusLabel(status),
      badgeClass: status,
      cpu: s.cpu,
      mem: s.memory,
    };
  }, [projects, selectedId, stats, statuses]);

  return {
    projects,
    statuses,
    logs,
    stats,
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
    detail,
    setStatuses,
    refreshProjects,
  };
}
