import { useEffect, useRef, useState } from "react";
import clsx from "../utils/clsx";
import PageShell from "../components/page-shell";
import useResource from "../hooks/use-resource";
import { showToast } from "../utils/toast";

const ENV_ICONS = {
  node: "⬡",
  pnpm: "📦",
  git: "🌿",
  brew: "🍺",
  pm2: "⚙️",
};

/** node 来源展示名 */
const NODE_MANAGER_LABELS = {
  nvm: "nvm",
  n: "n",
  volta: "Volta",
  fnm: "fnm",
  homebrew: "Homebrew",
  pkg: "官方安装包",
  unknown: "未知来源",
};

/** 与主进程 diagnostics.js 的 ENV_INSTALL_LOG_ID 保持一致 */
const ENV_INSTALL_LOG_ID = "__env-install__";

/** nvm 一键安装按钮组件 */
function NvmInstallButton({ onInstalled }) {
  const [confirming, setConfirming] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [log, setLog] = useState("");
  const logRef = useRef(null);

  useEffect(() => {
    if (!installing) return undefined;
    return window.electronAPI.onProcessLog(({ projectId, data }) => {
      if (projectId !== ENV_INSTALL_LOG_ID) return;
      setLog((prev) => (data === null ? "" : prev + data));
    });
  }, [installing]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const install = async () => {
    setConfirming(false);
    setInstalling(true);
    setLog("");
    try {
      const res = await window.electronAPI.installNvm();
      if (!res?.success) throw new Error(res?.error || "未知错误");
      showToast("nvm 安装完成，已拉取最新 LTS", "success");
      await onInstalled();
    } catch (err) {
      showToast(`nvm 安装失败: ${err?.message || "未知错误"}`, "error");
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={installing}
          className="w-full rounded-md border border-blue-600/30 bg-blue-50 py-2.5 text-center text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50 cursor-pointer"
        >
          {installing ? "⏳ 正在安装 nvm…" : "⬇ 一键安装 nvm 并在本地环境生效"}
        </button>
      ) : (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-slate-50 p-3">
          <span className="text-xs text-slate-600">
            将执行官方安装脚本并拉取最新 LTS，过程中会往 ~/.zshrc 追加 nvm 初始化代码：
          </span>
          <code className="text-[11px] font-mono break-all text-slate-500 bg-white p-1.5 rounded border border-border">
            curl -fsSL -o- .../nvm-sh/nvm/master/install.sh | bash && nvm install --lts
          </code>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={install}
              className="flex-1 rounded border border-blue-600 bg-blue-600 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 cursor-pointer"
            >
              确认安装
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="flex-1 rounded border border-border bg-white py-1.5 text-xs text-slate-600 hover:bg-slate-100 cursor-pointer"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {log && (
        <pre
          ref={logRef}
          className="max-h-36 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-slate-900 p-2.5 text-[10px] leading-relaxed text-slate-200 font-mono"
        >
          {log}
        </pre>
      )}
    </div>
  );
}

/** nvm 指定版本安装与进度展示 */
function CustomVersionInstaller({ onInstalled }) {
  const [open, setOpen] = useState(false);
  const [targetVersion, setTargetVersion] = useState("");
  const [installing, setInstalling] = useState(false);
  const [log, setLog] = useState("");
  const logRef = useRef(null);

  useEffect(() => {
    if (!installing) return undefined;
    return window.electronAPI.onProcessLog(({ projectId, data }) => {
      if (projectId !== ENV_INSTALL_LOG_ID) return;
      setLog((prev) => (data === null ? "" : prev + data));
    });
  }, [installing]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const doInstall = async (versionStr) => {
    const ver = versionStr.trim();
    if (!ver) return;
    setInstalling(true);
    setLog("");
    try {
      const res = await window.electronAPI.installNodeVersion("nvm", ver);
      if (!res?.success) throw new Error(res?.error || "未知错误");
      showToast(`Node ${res.version} 安装成功，已自动切换`, "success");
      setTargetVersion("");
      setOpen(false);
      await onInstalled();
    } catch (err) {
      showToast(`安装失败: ${err?.message || "未知错误"}`, "error");
    } finally {
      setInstalling(false);
    }
  };

  const handleInstallCustom = (e) => {
    e.preventDefault();
    doInstall(targetVersion);
  };

  if (!open) {
    return (
      <div className="flex flex-col gap-2 pt-1">
        <button
          type="button"
          onClick={() => doInstall("lts")}
          disabled={installing}
          className="w-full rounded border border-blue-600/30 bg-blue-50 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50 cursor-pointer text-center"
        >
          {installing ? "⏳ 安装中…" : "⚡ 一键安装最新 LTS 版本"}
        </button>

        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-xs text-blue-600 hover:text-blue-800 hover:underline font-medium cursor-pointer self-start"
        >
          + 手动输入指定版本号安装
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-slate-50 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-700">安装指定 Node 版本</span>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setLog("");
          }}
          disabled={installing}
          className="text-[11px] text-slate-400 hover:text-slate-600 cursor-pointer"
        >
          关闭
        </button>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => doInstall("lts")}
          disabled={installing}
          className="rounded border border-blue-600/30 bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50 cursor-pointer shrink-0"
        >
          ⚡ 最新 LTS
        </button>

        <form onSubmit={handleInstallCustom} className="flex flex-1 gap-1.5">
          <input
            type="text"
            value={targetVersion}
            onChange={(e) => setTargetVersion(e.target.value)}
            placeholder="如 18.20.0 或 22"
            disabled={installing}
            className="flex-1 min-w-0 rounded border border-border bg-white px-2 py-1 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50 font-mono"
          />
          <button
            type="submit"
            disabled={installing || !targetVersion.trim()}
            className="rounded border border-blue-600 bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 cursor-pointer shrink-0"
          >
            安装
          </button>
        </form>
      </div>

      {log && (
        <pre
          ref={logRef}
          className="max-h-28 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-slate-900 p-2 text-[10px] leading-relaxed text-slate-200 font-mono"
        >
          {log}
        </pre>
      )}
    </div>
  );
}

/** Node.js 专属 Hero 管理卡片 */
function NodeHeroCard({ item, onSwitched }) {
  const [switching, setSwitching] = useState(false);
  const [deletingVer, setDeletingVer] = useState("");
  const versionsOfProvider = item.nodeVersions || [];
  const managerLabel = NODE_MANAGER_LABELS[item.manager] || NODE_MANAGER_LABELS.unknown;

  const selectedVersion =
    item.selectedVersion || versionsOfProvider[0]?.version || "";

  const ok = item.status === "ok";

  const apply = async (version) => {
    setSwitching(true);
    try {
      const res = await window.electronAPI.setNodeVersion("nvm", version);
      if (!res?.success) throw new Error(res?.error || "未知错误");
      showToast(`已切换到 nvm ${res.version}`, "success");
      await onSwitched();
    } catch (err) {
      showToast(`切换失败: ${err?.message || "未知错误"}`, "error");
    } finally {
      setSwitching(false);
    }
  };

  const handleUninstall = async (version) => {
    if (!window.confirm(`确定要卸载 Node v${version} 吗？`)) return;
    setDeletingVer(version);
    try {
      const res = await window.electronAPI.uninstallNodeVersion(version);
      if (!res?.success) throw new Error(res?.error || "卸载失败");
      showToast(`Node v${version} 已成功卸载`, "success");
      await onSwitched();
    } catch (err) {
      showToast(`卸载失败: ${err?.message || "未知错误"}`, "error");
    } finally {
      setDeletingVer("");
    }
  };

  const [uninstallingNvm, setUninstallingNvm] = useState(false);

  const handleUninstallNvm = async () => {
    if (
      !window.confirm(
        "确定要彻底卸载 nvm 吗？\n这将删除 ~/.nvm 目录下的所有 Node 版本，并从 ~/.zshrc 配置文件中抹除 nvm 环境变量。",
      )
    ) {
      return;
    }

    setUninstallingNvm(true);
    try {
      const res = await window.electronAPI.uninstallNvm();
      if (!res?.success) throw new Error(res?.error || "卸载失败");
      showToast("nvm 已彻底卸载，配置文件已清理", "success");
      await onSwitched();
    } catch (err) {
      showToast(`卸载 nvm 失败: ${err?.message || "未知错误"}`, "error");
    } finally {
      setUninstallingNvm(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-slate-50 p-4 shadow-xs">
      {/* 头部栏 */}
      <div className="flex items-center justify-between pb-3 border-b border-border">
        <div className="flex items-center gap-3">
          <span className="text-base font-bold text-slate-900 flex items-center gap-1.5">
            <span className="text-lg">⬡</span> Node.js 多版本管理
          </span>

          <div className="flex items-center gap-2">
            <span
              className={clsx(
                "px-2 py-0.5 rounded-full text-xs font-mono font-medium",
                ok ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-700",
              )}
            >
              {ok ? item.version : "未检测到有效环境"}
            </span>
            <span className="text-xs text-slate-400">
              (环境来源：{managerLabel})
            </span>
          </div>
        </div>

        {item.nvmInstalled && (
          <button
            type="button"
            onClick={handleUninstallNvm}
            disabled={switching || Boolean(deletingVer) || uninstallingNvm}
            className="text-xs text-slate-400 hover:text-red-600 hover:underline cursor-pointer transition-colors"
            title="彻底删除 ~/.nvm 目录与环境变量"
          >
            {uninstallingNvm ? "⏳ 正在卸载 nvm…" : "🗑️ 一键卸载 nvm"}
          </button>
        )}
      </div>

      {/* 主体两栏布局 */}
      <div>
        {item.nvmInstalled ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* 左侧：已安装版本列表 */}
            <div className="flex flex-col gap-2 rounded-md border border-border bg-white p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-800">
                  本地已安装版本 ({versionsOfProvider.length})
                </span>
                {selectedVersion && (
                  <span className="text-[10px] text-slate-400">
                    切换后需重启项目生效
                  </span>
                )}
              </div>

              {versionsOfProvider.length === 0 ? (
                <div className="text-xs text-slate-400 py-4 text-center">
                  暂未检测到已安装的 nvm 版本
                </div>
              ) : (
                <div className="flex flex-col gap-1.5 max-h-48 overflow-y-auto pr-1">
                  {versionsOfProvider.map(({ version }) => {
                    const isActive = version === selectedVersion;
                    const isDeleting = deletingVer === version;
                    return (
                      <div
                        key={version}
                        className={`flex items-center justify-between rounded-md border px-3 py-1.5 text-xs transition-all ${
                          isActive
                            ? "border-blue-500/50 bg-blue-50/70 font-semibold text-blue-900 shadow-xs"
                            : "border-border bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50"
                        }`}
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="font-mono text-xs">v{version}</span>
                          {isActive && (
                            <span className="rounded-full bg-blue-600 px-2 py-0.5 text-[9px] font-semibold text-white">
                              当前使用
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-2">
                          {!isActive && (
                            <button
                              type="button"
                              onClick={() => apply(version)}
                              disabled={switching || Boolean(deletingVer)}
                              className="rounded border border-blue-600/30 bg-blue-50 px-2.5 py-0.5 text-[11px] font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50 cursor-pointer"
                            >
                              切换
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => handleUninstall(version)}
                            disabled={switching || Boolean(deletingVer)}
                            title={`卸载 Node v${version}`}
                            className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-30 cursor-pointer transition-colors"
                          >
                            {isDeleting ? (
                              <span className="text-xs">⏳</span>
                            ) : (
                              <svg
                                className="w-3.5 h-3.5"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                />
                              </svg>
                            )}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* 右侧：安装版本面板 */}
            <div className="flex flex-col gap-2 rounded-md border border-border bg-white p-3">
              <span className="text-xs font-semibold text-slate-800">
                版本安装与更新
              </span>
              <CustomVersionInstaller onInstalled={onSwitched} />
            </div>
          </div>
        ) : (
          <NvmInstallButton onInstalled={onSwitched} />
        )}
      </div>
    </div>
  );
}

/** 辅助复制安装命令按钮 */
function CopyInstallButton({ item }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(item.install);
      setCopied(true);
      showToast(`已复制 ${item.label} 安装命令`, "success");
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      showToast(`复制失败: ${err?.message || "未知错误"}`, "error");
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      className="w-full text-center py-1 rounded border text-xs font-medium bg-white text-slate-600 border-border hover:bg-slate-50 hover:text-slate-900 transition-colors cursor-pointer"
    >
      {copied ? "✓ 已复制" : "📋 复制安装命令"}
    </button>
  );
}

export default function EnvCheckPage() {
  const {
    data,
    loading,
    reload: runEnvCheck,
  } = useResource(async () => {
    try {
      const rows = await window.electronAPI.checkEnv();
      return Array.isArray(rows) ? rows : [];
    } catch (err) {
      showToast(`环境检测失败: ${err?.message || "未知错误"}`, "error");
      return [];
    }
  }, []);
  const results = data ?? [];

  const nodeItem = results.find((item) => item.id === "node");
  const otherItems = results.filter((item) => item.id !== "node");

  const missingCount = results.filter((item) => item.status === "missing").length;

  const subtitleText = loading
    ? "正在体检本地开发工具链，请稍候..."
    : missingCount === 0
      ? `所有环境项配置正常 (共检测 ${results.length} 项)`
      : `环境存在部分缺失项 (共有 ${missingCount} 项未检测到有效版本，请对照下方指引配置)`;

  return (
    <PageShell
      title="开发环境体检"
      subtitle={subtitleText}
      actions={
        <button
          type="button"
          onClick={runEnvCheck}
          disabled={loading}
          className="px-3 py-1.5 rounded-md border text-xs font-medium cursor-pointer transition-all bg-white text-slate-600 border-border hover:bg-slate-50 hover:text-slate-900 disabled:opacity-50"
        >
          🔄 重新检测
        </button>
      }
    >
      {loading ? (
        <div className="text-center py-12 text-slate-400 text-xs">
          正在扫描本地工具链，请稍候…
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* 顶栏 Hero 区域：Node.js 专属管理面板 */}
          {nodeItem && <NodeHeroCard item={nodeItem} onSwitched={runEnvCheck} />}

          {/* 底栏 4 宫格：其余辅助工具链状态卡片 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {otherItems.map((item) => {
              if (item.id === "pnpm") {
                return (
                  <PnpmCard key={item.id} item={item} onInstalled={runEnvCheck} />
                );
              }
              const ok = item.status === "ok";
              return (
                <div
                  key={item.id}
                  className={clsx(
                    "flex flex-col justify-between rounded-lg border p-3.5 transition-all",
                    ok ? "bg-slate-50 border-border" : "bg-red-500/5 border-red-500/20",
                  )}
                >
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <span
                        className={clsx(
                          "text-sm font-semibold",
                          ok ? "text-slate-900" : "text-red-700",
                        )}
                      >
                        {ENV_ICONS[item.id] || "🔧"} {item.label}
                      </span>
                      <span
                        className={clsx("status-dot", ok ? "running" : "error")}
                        style={{ flexShrink: 0 }}
                      />
                    </div>

                    <span
                      className={clsx(
                        "text-xs font-mono font-medium",
                        ok ? "text-slate-800" : "text-red-600",
                      )}
                    >
                      {ok ? item.version : "未安装"}
                    </span>
                    <span className="text-[10px] text-slate-400 truncate">
                      {item.cmd}
                    </span>
                  </div>

                  {!ok && item.install && (
                    <div className="mt-2 flex flex-col gap-1.5 rounded-md border border-red-500/20 bg-red-500/5 p-2">
                      <code
                        className="text-[10px] text-red-700 break-all select-all font-mono"
                        title={item.install}
                      >
                        {item.install}
                      </code>
                      <CopyInstallButton item={item} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </PageShell>
  );
}

/** pnpm 专属管理与指定版本安装卡片 */
function PnpmCard({ item, onInstalled }) {
  const [open, setOpen] = useState(false);
  const [targetVersion, setTargetVersion] = useState("");
  const [installing, setInstalling] = useState(false);
  const [log, setLog] = useState("");
  const logRef = useRef(null);

  const ok = item.status === "ok";

  useEffect(() => {
    if (!installing) return undefined;
    const unsub = window.electronAPI.onProcessLog((event) => {
      if (event.projectId !== ENV_INSTALL_LOG_ID) return;
      if (event.data === null) {
        setLog("");
        return;
      }
      setLog((prev) => prev + event.data);
    });
    return unsub;
  }, [installing]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [log]);

  const doInstall = async (ver) => {
    setInstalling(true);
    setLog("");
    try {
      const res = await window.electronAPI.installPnpmVersion(ver);
      if (!res?.success) throw new Error(res?.error || "安装失败");
      showToast(`pnpm@${res.version} 安装成功`, "success");
      setOpen(false);
      await onInstalled();
    } catch (err) {
      showToast(`安装 pnpm 失败: ${err?.message || "未知错误"}`, "error");
    } finally {
      setInstalling(false);
    }
  };

  const handleInstallSubmit = (e) => {
    e.preventDefault();
    if (!targetVersion.trim()) return;
    doInstall(targetVersion.trim());
  };

  return (
    <div
      className={clsx(
        "flex flex-col justify-between rounded-lg border p-3.5 transition-all",
        ok ? "bg-slate-50 border-border" : "bg-red-500/5 border-red-500/20",
      )}
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span
            className={clsx(
              "text-sm font-semibold flex items-center gap-1",
              ok ? "text-slate-900" : "text-red-700",
            )}
          >
            📦 pnpm
          </span>
          <div className="flex items-center gap-1.5">
            <span
              className={clsx("status-dot", ok ? "running" : "error")}
              style={{ flexShrink: 0 }}
            />
            <button
              type="button"
              onClick={() => setOpen(!open)}
              className="text-[11px] text-blue-600 hover:text-blue-800 hover:underline cursor-pointer font-medium"
            >
              {open ? "收起" : "⚙️ 指定版本"}
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <span
            className={clsx(
              "text-xs font-mono font-medium",
              ok ? "text-slate-800" : "text-red-600",
            )}
          >
            {ok ? item.version : "未安装"}
          </span>
          <span className="text-[10px] text-slate-400 font-mono">
            {item.cmd}
          </span>
        </div>

        {open && (
          <div className="mt-2 flex flex-col gap-2 rounded-md border border-border bg-white p-2.5 shadow-xs">
            <div className="flex items-center justify-between text-[11px] font-medium text-slate-700">
              <span>指定 pnpm 版本号</span>
            </div>

            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => doInstall("latest")}
                disabled={installing}
                className="rounded border border-blue-600/30 bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50 cursor-pointer shrink-0"
              >
                ⚡ 最新版
              </button>

              <form onSubmit={handleInstallSubmit} className="flex flex-1 gap-1">
                <input
                  type="text"
                  value={targetVersion}
                  onChange={(e) => setTargetVersion(e.target.value)}
                  placeholder="如 9.15.0 或 10"
                  disabled={installing}
                  className="flex-1 min-w-0 rounded border border-border bg-white px-2 py-0.5 text-[11px] text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50 font-mono"
                />
                <button
                  type="submit"
                  disabled={installing || !targetVersion.trim()}
                  className="rounded border border-blue-600 bg-blue-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-blue-700 disabled:opacity-50 cursor-pointer shrink-0"
                >
                  安装
                </button>
              </form>
            </div>

            {log && (
              <pre
                ref={logRef}
                className="max-h-24 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-slate-900 p-1.5 text-[10px] leading-relaxed text-slate-200 font-mono"
              >
                {log}
              </pre>
            )}
          </div>
        )}
      </div>

      {!ok && !open && item.install && (
        <div className="mt-2 flex flex-col gap-1.5 rounded-md border border-red-500/20 bg-red-500/5 p-2">
          <code
            className="text-[10px] text-red-700 break-all select-all font-mono"
            title={item.install}
          >
            {item.install}
          </code>
          <CopyInstallButton item={item} />
        </div>
      )}
    </div>
  );
}
