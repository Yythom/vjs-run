import { useEffect, useState } from "react";
import { showToast } from "../../utils/toast";
import {
  ensureEngineProbes,
  installDockingCli,
  putEngineProbe,
  refreshEngineProbe,
  useEngineProbe,
} from "../../stores/docking-store";

/**
 * 三个无头引擎（Claude Code / Antigravity / Codex）的可用性探测与一键安装配置。
 *
 * 只有派活弹窗和自动派发预设弹窗需要这些状态，所以放在 hook 里由它们各自持有，
 * 而不是像以前那样把 7 个 state 摊在 DockingPage 顶层——探测结果异步回来时
 * 会把整张任务列表连带重渲染一遍。
 */
export default function useEngineProbes() {
  // 探测结果放 store 共享，两个弹窗不会各探一遍；本地只留「正在装 / 正在配」
  const claudeProbe = useEngineProbe("claude");
  const agyProbe = useEngineProbe("agy");
  const codexProbe = useEngineProbe("codex");
  const [claudeInstalling, setClaudeInstalling] = useState(false);
  const [agyBusy, setAgyBusy] = useState(false);
  const [codexBusy, setCodexBusy] = useState(false);
  const [codexInstalling, setCodexInstalling] = useState(false);

  // 只补探还没探过的，已经有结果就不再 spawn 子进程
  useEffect(() => {
    ensureEngineProbes();
  }, []);

  /** 切换引擎时重探那一个，拿到最新的安装 / 配置状态 */
  const refreshProbe = (engineKey) => refreshEngineProbe(engineKey);

  const handleInstallClaude = async () => {
    setClaudeInstalling(true);
    try {
      const res = await installDockingCli("claude");
      if (res?.success) {
        showToast("Claude Code CLI 安装成功！已就绪", "success");
        await refreshEngineProbe("claude");
      } else {
        showToast(`安装失败: ${res?.error || "未知错误"}`, "error");
      }
    } catch (err) {
      showToast(`安装异常: ${err.message}`, "error");
    } finally {
      setClaudeInstalling(false);
    }
  };

  const handleInstallCodex = async () => {
    setCodexInstalling(true);
    try {
      const res = await installDockingCli("codex");
      if (res?.success) {
        showToast("Codex CLI 安装成功！已就绪", "success");
        await refreshEngineProbe("codex");
      } else {
        showToast(`安装失败: ${res?.error || "未知错误"}`, "error");
      }
    } catch (err) {
      showToast(`安装异常: ${err.message}`, "error");
    } finally {
      setCodexInstalling(false);
    }
  };

  const handleAgySetup = async () => {
    setAgyBusy(true);
    const result = await window.electronAPI.dockingAgySetup();
    setAgyBusy(false);
    if (result?.success) {
      putEngineProbe("agy", result.probe);
      showToast("agy 接入已配置", "success");
    } else {
      showToast(`配置失败: ${result?.error}`, "error");
    }
  };

  const handleCodexSetup = async () => {
    setCodexBusy(true);
    const result = await window.electronAPI.dockingCodexSetup();
    setCodexBusy(false);
    if (result?.success) {
      putEngineProbe("codex", result.probe);
      showToast("Codex 接入已配置", "success");
    } else {
      showToast(`配置失败: ${result?.error}`, "error");
    }
  };

  return {
    claudeProbe,
    claudeInstalling,
    agyProbe,
    agyBusy,
    codexProbe,
    codexBusy,
    codexInstalling,
    refreshProbe,
    handleInstallClaude,
    handleInstallCodex,
    handleAgySetup,
    handleCodexSetup,
  };
}
