import { useState } from "react";
import clsx from "../utils/clsx";
import PageShell from "../components/page-shell";
import useResource from "../hooks/use-resource";
import { showToast } from "../utils/toast";

const ENV_ICONS = {
  node: (
    <svg className="w-4 h-4 text-emerald-600" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="m21 7.5-9-5.25L3 7.5m18 0-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9" />
    </svg>
  ),
  pnpm: (
    <svg className="w-4 h-4 text-amber-600" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="m20.25 7.5-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" />
    </svg>
  ),
  git: (
    <svg className="w-4 h-4 text-orange-600" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 3v12m12-6a9 9 0 0 1-9 9" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
    </svg>
  ),
  brew: (
    <svg className="w-4 h-4 text-amber-700" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 0 1 4.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.943A4.5 4.5 0 0 1 15.938 17H8.062a4.5 4.5 0 0 1-2.292-.757L4.2 15.3m15.6 0-1.8-1.08A2.25 2.25 0 0 0 16.8 14H7.2a2.25 2.25 0 0 0-1.2.32L4.2 15.3" />
    </svg>
  ),
  "mock-skill": (
    <svg className="w-4 h-4 text-violet-600" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" />
    </svg>
  ),
  "vjtools-cli": (
    <svg className="w-4 h-4 text-sky-600" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="m6.75 7.5 3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0 0 21 18V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v12a2.25 2.25 0 0 0 2.25 2.25Z" />
    </svg>
  ),
};

/** copied 提示只影响按钮自身，state 收在叶子里，点复制不重画整页卡片列表 */
function CopyInstallButton({ item, className = "" }) {
  const [copied, setCopied] = useState(false);

  const copy = async (e) => {
    e.stopPropagation();
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
      className={clsx(
        "text-center text-[10.5px] py-1 px-2.5 rounded-md font-medium cursor-pointer transition-all flex items-center justify-center gap-1.5 select-none shadow-2xs shrink-0",
        copied
          ? "bg-emerald-50 text-emerald-700 border border-emerald-300"
          : "bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:text-slate-900",
        className,
      )}
    >
      {copied ? (
        <>
          <svg className="w-3.5 h-3.5 text-emerald-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
          </svg>
          <span>已复制</span>
        </>
      ) : (
        <>
          <svg className="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75" />
          </svg>
          <span>复制安装命令</span>
        </>
      )}
    </button>
  );
}

/** 把 app 内置的 vjtools 命令装到 PATH；可能弹系统授权框。安装中状态收在叶子里，装完让整页重新体检 */
function InstallCliButton({ onDone }) {
  const [installing, setInstalling] = useState(false);

  const install = async () => {
    setInstalling(true);
    try {
      const res = await window.electronAPI.installCli();
      if (!res?.success) {
        showToast(`安装失败: ${res?.error || "未知错误"}`, "error");
        return;
      }
      if (res.status === "canceled") {
        showToast("已取消安装", "info");
        return;
      }
      if (res.status === "external") {
        showToast(`终端里已有 vjtools（${res.linkPath}），无需重复安装`, "info");
      } else if (res.onPath === false) {
        showToast(`已安装到 ${res.linkPath}，但该目录不在 PATH 上，需要自行加入`, "warning");
      } else {
        showToast(`已安装到 ${res.linkPath}，终端里可以直接用 vjtools 了`, "success");
      }
      onDone?.();
    } catch (err) {
      showToast(`安装失败: ${err?.message || "未知错误"}`, "error");
    } finally {
      setInstalling(false);
    }
  };

  return (
    <button
      type="button"
      onClick={install}
      disabled={installing}
      className="text-[10.5px] py-1 px-2.5 rounded-md font-semibold cursor-pointer transition-colors flex items-center justify-center gap-1.5 select-none shadow-2xs shrink-0 border bg-violet-50 text-violet-700 border-violet-200 hover:bg-violet-100 disabled:opacity-50 disabled:cursor-default w-full sm:w-auto"
    >
      <svg className="w-3.5 h-3.5 text-violet-600" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
      </svg>
      <span>{installing ? "安装中…" : "安装到命令行"}</span>
    </button>
  );
}

/** 删掉 app 装进 PATH 的 vjtools 软链；可能弹系统授权框。移除中状态收在叶子里，删完让整页重新体检 */
function UninstallCliButton({ onDone }) {
  const [removing, setRemoving] = useState(false);

  const uninstall = async () => {
    setRemoving(true);
    try {
      const res = await window.electronAPI.uninstallCli();
      if (!res?.success) {
        showToast(`移除失败: ${res?.error || "未知错误"}`, "error");
        return;
      }
      if (res.status === "canceled") {
        showToast("已取消移除", "info");
        // 可写目录里的软链可能已经删了一部分，刷新一下
        if (res.removed?.length) onDone?.();
        return;
      }
      if (res.status === "none") {
        showToast("没有找到 app 装的 vjtools，可能已经被移除了", "info");
      } else if (res.remaining) {
        showToast(`已移除 ${res.removed.join("、")}；终端里仍有别处装的 vjtools（${res.remaining}）`, "info");
      } else {
        showToast(`已从命令行移除 vjtools（${res.removed.join("、")}）`, "success");
      }
      onDone?.();
    } catch (err) {
      showToast(`移除失败: ${err?.message || "未知错误"}`, "error");
    } finally {
      setRemoving(false);
    }
  };

  return (
    <button
      type="button"
      onClick={uninstall}
      disabled={removing}
      className="text-[10.5px] py-1 px-2.5 rounded-md font-semibold cursor-pointer transition-colors flex items-center justify-center gap-1.5 select-none shadow-2xs shrink-0 border bg-white text-slate-600 border-slate-200 hover:bg-red-50 hover:text-red-600 hover:border-red-200 disabled:opacity-50 disabled:cursor-default w-full sm:w-auto"
    >
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
      </svg>
      <span>{removing ? "移除中…" : "从命令行移除"}</span>
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

  const missingCount = results.filter((item) => item.status === "missing").length;

  const subtitleText = loading
    ? "正在体检本地开发工具链与 AI Agent 技能，请稍候..."
    : missingCount === 0
      ? `所有开发工具与 Mock Skill 配置正常 (共检测 ${results.length} 项)`
      : `环境存在部分缺失项 (共有 ${missingCount} 项未检测到有效版本，请对照下方命令安装)`;

  return (
    <PageShell
      title="开发环境体检"
      subtitle={subtitleText}
      actions={
        <button
          type="button"
          onClick={runEnvCheck}
          disabled={loading}
          className="px-3 py-1.5 rounded-lg border text-xs font-semibold cursor-pointer transition-all bg-white text-slate-700 border-slate-200 hover:bg-slate-50 hover:text-slate-900 disabled:opacity-50 shadow-2xs flex items-center gap-1.5"
        >
          <svg
            className={clsx("w-3.5 h-3.5 text-slate-500", loading && "animate-spin")}
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"
            />
          </svg>
          <span>重新检测</span>
        </button>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 items-stretch">
        {loading ? (
          <div className="col-span-full text-center py-8 text-slate-400 text-xs">
            正在体检本地工具链与技能环境...
          </div>
        ) : (
          results.map((item) => {
            const ok = item.status === "ok";
            const isMockSkill = item.id === "mock-skill";
            const isCli = item.id === "vjtools-cli";
            // 宽卡片：命令 + 按钮横排
            const wide = isMockSkill || isCli;
            const showInstall = (!ok && item.install) || isMockSkill;
            return (
              <div
                key={item.id}
                className={clsx(
                  "flex flex-col justify-between gap-2.5 rounded-xl border p-3.5 transition-all shadow-2xs",
                  isMockSkill && "sm:col-span-2 lg:col-span-2",
                  isCli && "sm:col-span-2 lg:col-span-3",
                  ok
                    ? "bg-slate-50/50 border-slate-200/80 hover:border-slate-300 hover:bg-slate-50/80"
                    : "bg-red-500/5 border-red-500/25",
                )}
              >
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span
                      className={clsx(
                        "text-xs font-bold flex items-center gap-1.5",
                        ok ? "text-slate-800" : "text-red-700",
                      )}
                    >
                      {ENV_ICONS[item.id] || null}
                      {item.label}
                    </span>
                    <span
                      className={clsx("status-dot", ok ? "ok" : "error")}
                      style={{ flexShrink: 0 }}
                    />
                  </div>

                  <div className="flex flex-col gap-0.5">
                    <span
                      className={clsx(
                        "text-[11.5px] font-mono",
                        ok ? "text-slate-700 font-semibold" : "text-red-600 font-semibold",
                      )}
                    >
                      {ok ? item.version : "未安装或未检测到"}
                    </span>
                    <span className="text-[10px] text-slate-400 truncate font-mono">
                      {item.cmd}
                    </span>
                  </div>
                </div>

                {isCli && !ok && item.canInstall && (
                  <div className="mt-1 rounded-lg border p-2 flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-red-500/20 bg-red-500/5">
                    <span className="text-[10.5px] text-red-700 leading-relaxed min-w-0">
                      装到命令行后，终端和 AI（Mock Skill）都能直接用 vjtools 启停 mock、改规则，不用另装 npm 包
                    </span>
                    <InstallCliButton onDone={runEnvCheck} />
                  </div>
                )}

                {isCli && item.canUninstall && (
                  <div
                    className={clsx(
                      "mt-1 rounded-lg border p-2 flex flex-col sm:flex-row sm:items-center justify-between gap-2",
                      ok ? "border-slate-200/80 bg-slate-100/60" : "border-red-500/20 bg-red-500/5",
                    )}
                  >
                    <span
                      className={clsx(
                        "text-[10.5px] leading-relaxed min-w-0",
                        ok ? "text-slate-500" : "text-red-700",
                      )}
                    >
                      移除后终端里不能再直接敲 vjtools（npm 装的不受影响）；app 内置命令本身保留，随时可以重新安装
                    </span>
                    <UninstallCliButton onDone={runEnvCheck} />
                  </div>
                )}

                {showInstall && item.install && (
                  <div
                    className={clsx(
                      "mt-1 rounded-lg border p-2 flex gap-2",
                      wide
                        ? "flex-col sm:flex-row sm:items-center justify-between"
                        : "flex-col",
                      !ok
                        ? "border-red-500/20 bg-red-500/5"
                        : "border-slate-200/80 bg-slate-100/60",
                    )}
                  >
                    <code
                      className={clsx(
                        "text-[10px] select-all font-mono leading-relaxed min-w-0 flex-1",
                        // 宽卡片横排（命令 + 按钮同一行），截断；窄卡片里换行，保证命令能看全
                        wide ? "truncate" : "break-all",
                        !ok ? "text-red-700" : "text-slate-600",
                      )}
                      title={item.install}
                    >
                      {item.install}
                    </code>
                    <CopyInstallButton
                      item={item}
                      className={wide ? "w-full sm:w-auto" : "w-full"}
                    />
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </PageShell>
  );
}
