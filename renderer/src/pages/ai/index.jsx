import { useState, useEffect } from "react";
import PageShell from "../../components/page-shell";
import { useAppConfig } from "../../stores/app-config-store";
import { showToast } from "../../utils/toast";
import clsx from "clsx";

function fmtSpeed(bps) {
  if (!bps || bps <= 0) return '';
  return bps >= 1 << 20
    ? `${(bps / (1 << 20)).toFixed(1)} MB/s`
    : `${Math.max(1, Math.round(bps / 1024))} KB/s`;
}

export default function AiModels() {
  const config = useAppConfig();
  const [ollamaStatus, setOllamaStatus] = useState(null);
  const [ollamaProgress, setOllamaProgress] = useState(null);
  const [ollamaBusy, setOllamaBusy] = useState(false);
  const [pullingModel, setPullingModel] = useState("");
  const [customModelInput, setCustomModelInput] = useState("");

  const refreshStatus = async () => {
    try {
      const status = await window.electronAPI.getOllamaStatus();
      setOllamaStatus(status);
    } catch (err) {
      console.error("Failed to get Ollama status:", err);
    }
  };

  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => {
      if (active) refreshStatus();
    });

    const cleanListener = window.electronAPI.onOllamaProgress((progress) => {
      if (active) {
        setOllamaProgress(progress);
        if (progress.percent === 100) {
          refreshStatus();
        }
      }
    });

    return () => {
      active = false;
      cleanListener();
    };
  }, []);

  const handleStartOllama = async () => {
    setOllamaBusy(true);
    setOllamaProgress({ phase: "starting", percent: 0 });
    try {
      const res = await window.electronAPI.startOllamaService();
      if (res && res.success) {
        showToast("Ollama 服务已就绪", "success");
        await refreshStatus();
      }
    } catch (e) {
      showToast(e.message || "启动 Ollama 失败", "error");
    } finally {
      setOllamaBusy(false);
      setOllamaProgress(null);
    }
  };

  const handleStopOllama = async () => {
    setOllamaBusy(true);
    try {
      await window.electronAPI.stopOllamaService();
      showToast("Ollama 服务已停止", "success");
      await refreshStatus();
    } catch (e) {
      showToast(e.message || "停止 Ollama 失败", "error");
    } finally {
      setOllamaBusy(false);
    }
  };

  const handlePullModel = async (modelName) => {
    if (!modelName) return;
    setOllamaBusy(true);
    setPullingModel(modelName);
    try {
      const res = await window.electronAPI.pullOllamaModel(modelName);
      if (res && res.success) {
        showToast(`模型 ${modelName} 安装成功`, "success");
        setCustomModelInput("");
        await refreshStatus();
      }
    } catch (e) {
      showToast(e.message || `安装模型 ${modelName} 失败`, "error");
    } finally {
      setOllamaBusy(false);
      setPullingModel("");
      setOllamaProgress(null);
    }
  };

  const renderProgress = () => {
    if (!ollamaProgress) return null;
    let msg = "正在执行操作...";
    if (ollamaProgress.phase === 'download') {
      const spd = fmtSpeed(ollamaProgress.speed);
      msg = `下载引擎 ${ollamaProgress.receivedMB} MB/${ollamaProgress.totalMB} MB ${spd ? `· ${spd}` : ''}`;
    } else if (ollamaProgress.phase === 'extract') {
      msg = "解压引擎中...";
    } else if (ollamaProgress.phase === 'starting') {
      msg = "正在启动服务...";
    } else if (ollamaProgress.phase === 'model-download-start') {
      msg = `正在准备下载模型...`;
    } else if (ollamaProgress.phase === 'model-download') {
      msg = `正在下载模型 ${pullingModel || ollamaProgress.model || ''}: ${ollamaProgress.percent || 0}% (${ollamaProgress.status || ''})`;
    }

    return (
      <div className="bg-sky-50 border border-sky-100 rounded-xl p-4 mb-4 space-y-2">
        <div className="flex justify-between items-center text-xs text-sky-700 font-semibold">
          <span className="flex items-center gap-1.5">
            <span className="animate-spin inline-block w-3.5 h-3.5 border-2 border-sky-600 border-t-transparent rounded-full" />
            {msg}
          </span>
          {ollamaProgress.percent != null && ollamaProgress.percent >= 0 && (
            <span className="font-mono text-sky-600">{ollamaProgress.percent}%</span>
          )}
        </div>
        {ollamaProgress.percent != null && ollamaProgress.percent >= 0 && (
          <div className="w-full bg-sky-200 h-2 rounded-full overflow-hidden shadow-inner">
            <div className="bg-sky-600 h-full transition-all duration-300" style={{ width: `${ollamaProgress.percent}%` }} />
          </div>
        )}
      </div>
    );
  };

  const isRunning = ollamaStatus?.running;

  return (
    <PageShell
      title="AI 引擎管理"
      subtitle="管理本地 AI 大模型环境，一键下载或启动 Ollama 本地服务。"
    >
      {renderProgress()}

      <div className="flex flex-col gap-4 max-w-3xl">
        {/* 引擎状态与控制 */}
        <div className="bg-white border border-border rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.02)] p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-800">Ollama 服务引擎</h3>
            <span
              className={clsx(
                "status-badge shrink-0 px-2 py-0.5 rounded-full text-[11px] font-semibold tracking-wide",
                isRunning ? "mock-running" : "stopped"
              )}
            >
              {isRunning ? "正在运行" : "已停止"}
            </span>
          </div>

          <div className="text-xs text-slate-500 space-y-1.5 leading-relaxed">
            <p>
              <strong>引擎类型：</strong>
              {ollamaStatus?.installed ? "本地托管引擎" : "未检测到本地引擎（需要启动时自动安装）"}
            </p>
            <p>
              <strong>服务地址：</strong>
              <code className="font-mono bg-slate-50 border border-slate-100 rounded px-1 text-[11px]">
                {config.aiBaseUrl || "http://127.0.0.1:11434"}
              </code>
            </p>
          </div>

          <div className="flex gap-2">
            {!isRunning ? (
              <button
                type="button"
                disabled={ollamaBusy}
                onClick={handleStartOllama}
                className="px-3 py-1.5 rounded-md border text-xs font-semibold cursor-pointer transition-all bg-blue-500 text-white border-blue-600 hover:bg-blue-600 disabled:opacity-50"
              >
                🚀 启动服务
              </button>
            ) : (
              <button
                type="button"
                disabled={ollamaBusy}
                onClick={handleStopOllama}
                className="px-3 py-1.5 rounded-md border text-xs font-semibold cursor-pointer transition-all bg-red-400/10 text-red-700 border-red-400/30 hover:bg-red-400/20"
              >
                ⏹ 停止服务
              </button>
            )}
          </div>
        </div>

        {/* 模型管理 */}
        <div className="bg-white border border-border rounded-xl shadow-[0_1px_3px_rgba(0,0,0,0.02)] p-5 space-y-4">
          <h3 className="text-sm font-semibold text-slate-800">本地已安装模型</h3>

          {isRunning ? (
            <div className="space-y-4">
              {/* 模型列表 */}
              <div className="space-y-2">
                <div className="text-[11px] text-slate-400 font-semibold uppercase tracking-wider">
                  全部本地模型 ({ollamaStatus?.modelsList?.length || 0})
                </div>
                {ollamaStatus?.modelsList && ollamaStatus.modelsList.length > 0 ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {ollamaStatus.modelsList.map((m) => (
                      <div
                        key={m}
                        className="flex items-center gap-2.5 p-2.5 rounded-lg border border-border text-xs bg-card shadow-[0_1px_2px_rgba(0,0,0,0.01)]"
                      >
                        <span className="text-[14px]">🤖</span>
                        <span className="font-mono text-slate-800 font-semibold truncate flex-1">{m}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-slate-500 italic py-2">
                    暂无本地模型，请在下方下载
                  </div>
                )}
              </div>

              {/* 下载模型 */}
              <div className="pt-2 border-t border-border space-y-2">
                <label className="text-[11px] text-slate-600 font-semibold">
                  安装/下载新模型
                </label>
                <div className="flex gap-2">
                  <input
                    value={customModelInput}
                    onChange={(e) => setCustomModelInput(e.target.value)}
                    placeholder="输入模型名，如 qwen2.5:7b / llama3.2 / bge-m3"
                    disabled={ollamaBusy}
                    className="flex-1 bg-panel border border-border rounded-md px-2.5 py-1 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500"
                  />
                  <button
                    type="button"
                    disabled={ollamaBusy || !customModelInput.trim()}
                    onClick={() => handlePullModel(customModelInput.trim())}
                    className="px-3 py-1 rounded-md border text-xs font-semibold cursor-pointer transition-all bg-blue-500 text-white border-blue-600 hover:bg-blue-600 disabled:opacity-50 shrink-0"
                  >
                    下载
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-xs text-slate-400 italic py-3 text-center border border-dashed border-border rounded-lg">
              请先启动 Ollama 服务以查看并管理模型
            </div>
          )}
        </div>
      </div>
    </PageShell>
  );
}
