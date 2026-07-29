import { useEffect, useRef } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import PageShell from "../components/page-shell";
import LogTerminal from "../components/log-terminal";
import useResource from "../hooks/use-resource";
import {
  useAppConfig,
  useAppConfigLoaded,
  updateAppConfig,
} from "../stores/app-config-store";
import { WEAPP_DEPLOY_ID } from "../constants";
import { showToast } from "../utils/toast";
import * as statusStore from "../stores/status-store";
import * as logStore from "../stores/log-store";

// 只发测试服：DEPLOY_ENV 固定 staging、版本号由脚本固定为 0.0.1，都不出现在表单里
const deploySchema = z.object({
  repoPath: z
    .string()
    .refine((v) => v.trim(), { message: "请选择小程序仓库目录" }),
  robot: z
    .string()
    .refine((v) => /^\d+$/.test(v.trim()) && Number(v) >= 1 && Number(v) <= 30, {
      message: "机器人编号需为 1-30 的整数",
    }),
  branch: z.string(),
  pullLatest: z.boolean(),
});

// 表单值变化后延迟这么久再落盘，避免输入框每敲一个字符就写一次配置
const AUTOSAVE_DELAY_MS = 400;

/**
 * 表单一改就存盘的隐形组件。订阅收在叶子里，页面主体不跟着每次输入重渲染。
 */
function PrefsAutoSave({ control }) {
  const values = useWatch({ control });
  const timerRef = useRef(null);
  // 已存盘的那份的序列化结果；null 表示还没存过（挂载时的初值就是刚读出来的配置）
  const savedRef = useRef(null);

  // 依赖必须是这个字符串而不是 values 对象：useWatch 每次渲染都给新对象，
  // 而存盘会换掉 appConfig 引用触发重渲染，用对象当依赖会自己喂自己转不停。
  const serialized = JSON.stringify({
    repoPath: values.repoPath,
    branch: values.branch,
    robot: values.robot,
    pullLatest: values.pullLatest,
  });

  useEffect(() => {
    if (savedRef.current === null) {
      savedRef.current = serialized;
      return;
    }
    if (savedRef.current === serialized) return;

    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      savedRef.current = serialized;
      updateAppConfig({ weappDeploy: JSON.parse(serialized) }).catch((error) => {
        showToast(`发布参数保存失败: ${error.message}`, "warning");
      });
    }, AUTOSAVE_DELAY_MS);

    return () => clearTimeout(timerRef.current);
  }, [serialized]);

  return null;
}

function FieldError({ message }) {
  if (!message) return null;
  return <div className="text-[11px] text-red-600">{message}</div>;
}

const INPUT_CLS =
  "w-full bg-card border border-border rounded-md px-3 py-2 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500 transition-colors";

/**
 * 分支下拉。分支列表是异步拉的，state 收在这个叶子组件里，
 * 换仓库时自动重拉并把选中值对齐到该仓库的当前分支。
 */
function BranchField({ register, getValues, setValue, repoPath, disabled }) {
  const { data, loading, reload } = useResource(
    () => (repoPath ? window.electronAPI.getRepoBranches(repoPath) : null),
    [repoPath],
  );

  const ok = Boolean(data?.success);
  const branches = ok ? data.branches : [];
  const error = data && !data.success ? data.error : "";

  // 列表到位后，把选中分支对齐到这个仓库真实存在的分支（默认它当前所在分支）
  useEffect(() => {
    if (!data?.success) return;
    const picked = getValues("branch");
    if (picked && data.branches.includes(picked)) return;
    setValue("branch", data.current || data.branches[0] || "");
  }, [data, getValues, setValue]);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <label className="text-xs font-medium text-slate-600">分支</label>
        <button
          type="button"
          onClick={reload}
          disabled={disabled || loading}
          className="ml-auto text-[11px] text-slate-400 hover:text-slate-700 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          title="重新读取分支列表"
        >
          {loading ? "读取中…" : "🔄 刷新"}
        </button>
      </div>
      <select
        {...register("branch")}
        disabled={disabled || !ok}
        className={`${INPUT_CLS} disabled:opacity-50`}
      >
        {!ok && <option value="">—</option>}
        {branches.map((name) => (
          <option key={name} value={name}>
            {name}
            {name === data?.current ? "（当前）" : ""}
          </option>
        ))}
      </select>
      {error && (
        <div className="text-[11px] text-amber-700">
          读取分支失败：{error}（将直接在仓库当前分支上发布）
        </div>
      )}
    </div>
  );
}

function DeployConsole() {
  const appConfig = useAppConfig();
  const state = statusStore.useStatus(WEAPP_DEPLOY_ID);
  const running = state === "starting" || state === "running";

  const {
    register,
    handleSubmit,
    control,
    setValue,
    getValues,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(deploySchema),
    // 表单初值只在挂载时读一次，所以外层保证了 config 已经加载完成
    defaultValues: { ...appConfig.weappDeploy },
  });

  const robot = useWatch({ control, name: "robot" });
  const repoPath = useWatch({ control, name: "repoPath" });

  const handleSelectDirectory = async () => {
    try {
      const selected = await window.electronAPI.selectDirectory();
      // 取消选择返回 null，保持原值不动
      if (selected) setValue("repoPath", selected, { shouldValidate: true });
    } catch (error) {
      showToast(`选择目录失败: ${error.message}`, "error");
    }
  };

  const statusText =
    state === "starting"
      ? "发布中…"
      : state === "stopped"
        ? "发布完成"
        : state === "error"
          ? "出错"
          : "就绪";
  const dotClass =
    state === "starting"
      ? "starting"
      : state === "stopped"
        ? "running"
        : state === "error"
          ? "error"
          : "stopped";

  const handleRun = handleSubmit(async (values) => {
    if (running) return;
    // 表单参数由 PrefsAutoSave 实时存盘，这里不用再写一次

    logStore.clear(WEAPP_DEPLOY_ID);
    statusStore.set(WEAPP_DEPLOY_ID, "starting");

    const result = await window.electronAPI.startWeappDeploy({
      repoPath: values.repoPath,
      robot: values.robot.trim(),
      branch: values.branch,
      pullLatest: values.pullLatest,
    });
    // 参数校验类错误在主进程里没走到 sendStatus，UI 会卡在「发布中」，这里补一次
    if (!result?.success) {
      statusStore.set(WEAPP_DEPLOY_ID, "error");
      showToast(`发布失败: ${result?.error || "未知错误"}`, "error");
    }
  });

  const handleStop = async () => {
    await window.electronAPI.stopWeappDeploy();
  };

  return (
    <PageShell
      title="📱 小程序发布"
      subtitle="在选定仓库执行 pnpm deploy:weapp：构建 Taro 产物并上传微信 CI（测试服）"
      noCard
      actions={
        <div className="flex items-center gap-2">
          <span className={`status-dot ${dotClass}`} />
          <span className="text-xs text-slate-500 mr-1">{statusText}</span>
          {running ? (
            <button
              type="button"
              onClick={handleStop}
              className="px-4 py-1.5 rounded-md border text-xs font-medium cursor-pointer transition-all bg-red-400/10 text-red-700 border-red-400/30 hover:bg-red-400/20"
            >
              终止发布
            </button>
          ) : (
            <button
              type="button"
              onClick={handleRun}
              className="px-4 py-1.5 rounded-md border text-xs font-medium cursor-pointer transition-all bg-blue-500/20 text-blue-700 border-blue-500/40 hover:bg-blue-500/30"
            >
              🚀 开始发布
            </button>
          )}
        </div>
      }
    >
      <PrefsAutoSave control={control} />

      <div className="flex flex-col gap-2 h-full min-h-0">
        <div className="shrink-0 bg-white border border-border rounded-xl p-4 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-600">
              小程序仓库目录
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                {...register("repoPath")}
                disabled={running}
                placeholder="/Users/yourname/Documents/work/gc-wechat-app"
                className={`flex-1 ${INPUT_CLS} disabled:opacity-50`}
              />
              <button
                type="button"
                onClick={handleSelectDirectory}
                disabled={running}
                className="px-3 py-2 rounded-md border text-xs font-medium bg-card text-slate-600 border-border hover:bg-hover hover:text-slate-900 transition-colors flex items-center gap-1 cursor-pointer shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                📂 选择文件夹
              </button>
            </div>
            <FieldError message={errors.repoPath?.message} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <BranchField
              register={register}
              getValues={getValues}
              setValue={setValue}
              repoPath={repoPath}
              disabled={running}
            />

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-slate-600">
                CI 机器人
              </label>
              <input
                type="text"
                {...register("robot")}
                disabled={running}
                placeholder="5"
                className={`${INPUT_CLS} disabled:opacity-50`}
              />
              <FieldError message={errors.robot?.message} />
            </div>
          </div>

          <label className="flex items-center gap-2 cursor-pointer select-none group w-fit">
            <input
              type="checkbox"
              {...register("pullLatest")}
              disabled={running}
              className="accent-violet-500 w-3.5 h-3.5 cursor-pointer"
            />
            <span className="text-xs text-slate-500 group-hover:text-slate-800 transition-colors">
              切换分支后执行 <span className="font-mono">git pull -r</span>
            </span>
          </label>

          <div className="text-[11px] text-slate-500 bg-slate-50 border border-border rounded-md px-3 py-2 leading-relaxed">
            仅发测试服，版本号由脚本固定为 0.0.1。发布前脚本会就地改写仓库的{" "}
            <span className="font-mono">.env.staging</span>，把{" "}
            <span className="font-mono">TARO_APP_API</span> 设为{" "}
            <span className="font-mono">
              {robot === "5"
                ? "https://vapi.vjshi.cn"
                : `https://vapi.vjshi.cn/t${robot || "5"}`}
            </span>
            ，发布结束后会自动还原成发布前的内容。
          </div>

          <div className="text-[11px] text-slate-400 flex flex-wrap gap-1.5 items-center">
            <span className="font-mono">rm -rf dist</span>
            <span>→</span>
            <span className="font-mono">git checkout</span>
            <span>→</span>
            <span className="font-mono">pnpm install</span>
            <span>→</span>
            <span className="font-mono">pnpm deploy:weapp</span>
          </div>
        </div>

        <LogTerminal
          paneKey={WEAPP_DEPLOY_ID}
          logTitle="小程序发布"
          className="flex-1 min-h-0 bg-white border border-border rounded-xl px-3 py-2"
          style={{ background: "#fafbfc" }}
        />
      </div>
    </PageShell>
  );
}

export default function WeappDeployPage() {
  // config 还没加载完就挂载的话，DeployConsole 会把 DEFAULT 当成用户上次的选择，
  // 所以在这里挡一道，等 init 完成再挂。
  const loaded = useAppConfigLoaded();
  if (!loaded) {
    return (
      <PageShell
        title="📱 小程序发布"
        subtitle="在选定仓库执行 pnpm deploy:weapp：构建 Taro 产物并上传微信 CI（测试服）"
        noCard
      >
        <div />
      </PageShell>
    );
  }
  return <DeployConsole />;
}
