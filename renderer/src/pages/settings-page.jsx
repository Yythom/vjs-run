import { useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import PageShell from "../components/page-shell";
import clsx from "../utils/clsx";
import {
  updateAppConfig,
  useAppConfig,
  useAppConfigStore,
} from "../stores/app-config-store";
import { generateMockSpec, useGeneratingMockSpec } from "../stores/runner-store";
import useConfirm from "../hooks/use-confirm";
import useModalNav from "../hooks/use-modal-nav";
import { showToast } from "../utils/toast";

// 绝对路径目录（不能直接指到 json/yaml 文件）
function isAbsoluteSpecDir(value) {
  return value.startsWith("/") && !/\.(json|ya?ml)$/i.test(value);
}

// 监听地址只填地址本身（与命令行 --host 同一规则）：[::1] 去掉方括号；
// 带协议 / 路径 / 空白的，或只有一个冒号的「地址:端口」都不行，否则 mock 起不来、访问地址也拼不对
function normalizeMockHost(value) {
  const host = value.trim();
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function isValidMockHost(value) {
  const host = normalizeMockHost(value);
  if (!host) return true; // 留空 = 用默认值
  if (/[\s/]/.test(host)) return false;
  return (host.match(/:/g) || []).length !== 1;
}

const settingsSchema = z.object({
  mockSpecPath: z
    .string()
    .refine((v) => isAbsoluteSpecDir(v.trim()), {
      message: "OpenAPI JSON 路径必须是绝对目录",
    }),
  mockSwaggerServer: z.string(),
  mockHost: z.string().refine(isValidMockHost, {
    message: "只填地址本身，不带协议和端口（如 0.0.0.0、127.0.0.1、::1）",
  }),
  mockPort: z
    .string()
    .refine((v) => v.trim() !== "" && Number.isInteger(Number(v.trim())), {
      message: "端口必须是整数",
    }),
  mockServiceAddress: z.string(),
  mockBackendBaseUrl: z.string(),
  mockAll: z.boolean(),
});

function FieldError({ message }) {
  if (!message) return null;
  return <div className="text-[11px] text-red-600">{message}</div>;
}

const INPUT_CLS =
  "w-full bg-card border border-border rounded-md px-3 py-2 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500 transition-colors";

export default function SettingsPage() {
  const openModal = useModalNav();
  const { confirm, confirmDialog } = useConfirm();

  // 配置已经在 store 里（app 启动时 init 拉过一次），直接同步取一次作为初始值。
  // 用 getState() 而不是 useAppConfig()，避免 store 变化时把用户正在编辑的表单 reset。
  const cfg = useAppConfigStore.getState().appConfig;
  const {
    register,
    handleSubmit,
    setValue,
    getValues,
    reset,
    resetField,
    getFieldState,
    // 订阅 dirtyFields，getFieldState(...).isDirty 才是准的
    // eslint-disable-next-line no-unused-vars
    formState: { errors, isSubmitting, isDirty, dirtyFields },
  } = useForm({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      mockSpecPath: cfg.mockSpecPath || "",
      mockSwaggerServer: cfg.mockSwaggerServer || "",
      mockHost: cfg.mockHost || "0.0.0.0",
      mockPort: String(cfg.mockPort || 3002),
      mockServiceAddress: cfg.mockServiceAddress || "",
      mockBackendBaseUrl: cfg.mockBackendBaseUrl || "",
      mockAll: Boolean(cfg.mockAll),
    },
  });
  const generating = useGeneratingMockSpec();

  // 配置被外部改写（如 AI 走 CLI 改了地址）时，把用户没动过的字段同步成新值；
  // 用户正在改的字段保持原样，免得把输入冲掉。
  const liveConfig = useAppConfig();
  useEffect(() => {
    const synced = {
      mockSpecPath: liveConfig.mockSpecPath || "",
      mockSwaggerServer: liveConfig.mockSwaggerServer || "",
      mockHost: liveConfig.mockHost || "0.0.0.0",
      mockPort: String(liveConfig.mockPort || 3002),
      mockServiceAddress: liveConfig.mockServiceAddress || "",
      mockBackendBaseUrl: liveConfig.mockBackendBaseUrl || "",
      mockAll: Boolean(liveConfig.mockAll),
    };
    for (const [field, value] of Object.entries(synced)) {
      if (!getFieldState(field).isDirty && getValues(field) !== value) {
        resetField(field, { defaultValue: value });
      }
    }
  }, [liveConfig, getFieldState, getValues, resetField]);

  // 独立操作：先把表单里的目录 + 源服务器地址落盘（生成逻辑读的是已保存配置），再触发生成
  const handleGenerate = async () => {
    if (generating) return;

    const nextMockSpecPath = getValues("mockSpecPath").trim();
    const nextMockSwaggerServer = getValues("mockSwaggerServer").trim();

    if (!nextMockSwaggerServer) {
      showToast("请先填写 Swagger 源服务器地址", "warning");
      return;
    }
    if (!isAbsoluteSpecDir(nextMockSpecPath)) {
      showToast("OpenAPI JSON 路径必须是绝对目录", "warning");
      return;
    }

    // 生成会覆盖目录里的各服务 json。目录里若还有别的文件，多半是路径填错了（填成了
    // 某个真实工程目录），先让用户确认一次。
    const dirInfo = await window.electronAPI.inspectSpecDir(nextMockSpecPath);
    if (!dirInfo?.success) {
      showToast(`检查目录失败: ${dirInfo?.error || "未知错误"}`, "error");
      return;
    }
    if (dirInfo.foreignCount > 0) {
      const ok = await confirm({
        title: "这个目录看起来不是专用输出目录",
        message:
          `${nextMockSpecPath}\n\n` +
          `目录里有 ${dirInfo.foreignCount} 个与 Mock 无关的文件/文件夹。\n` +
          `生成只会覆盖各服务的 json 与 api-index.json，其他文件不受影响。\n` +
          `确认路径没填错吗？`,
        confirmText: "继续生成",
        danger: true,
      });
      if (!ok) return;
    }

    try {
      await updateAppConfig({
        mockSpecPath: nextMockSpecPath,
        mockSwaggerServer: nextMockSwaggerServer,
      });
    } catch (error) {
      showToast(`保存配置失败: ${error?.message || String(error)}`, "error");
      return;
    }
    // 这两个字段已落盘，把基线跟上，避免它们继续被算作「未保存」
    resetField("mockSpecPath", { defaultValue: nextMockSpecPath });
    resetField("mockSwaggerServer", { defaultValue: nextMockSwaggerServer });
    await generateMockSpec();
  };

  const handleSelectDirectory = async () => {
    try {
      const selectedPath = await window.electronAPI.selectDirectory();
      if (selectedPath) {
        setValue("mockSpecPath", selectedPath, { shouldDirty: true });
      }
    } catch (err) {
      showToast(`选择目录失败: ${err.message}`, "error");
    }
  };

  // 在 Finder 中打开当前填写的目录（未保存也能开，方便生成后立刻查看产物）。
  // 目录要到生成时才会被创建，所以首次配置后大概率还不存在——问一句要不要现在建。
  const handleOpenDirectory = async () => {
    const dir = getValues("mockSpecPath").trim();
    if (!dir) {
      showToast("请先填写 OpenAPI JSON 目录", "warning");
      return;
    }

    const info = await window.electronAPI.inspectSpecDir(dir);
    if (info?.success && !info.exists) {
      const ok = await confirm({
        title: "目录还不存在",
        message: `${dir}\n\n这个目录会在生成 OpenAPI JSON 时自动创建。要现在就创建并打开吗？`,
        confirmText: "创建并打开",
      });
      if (!ok) return;
    }

    const res = await window.electronAPI.openDirectory(dir, { create: true });
    if (!res?.success) {
      showToast(`打开目录失败: ${res?.error || "未知错误"}`, "error");
    }
  };

  const handleSave = handleSubmit(async (values) => {
    try {
      await updateAppConfig({
        mockSpecPath: values.mockSpecPath.trim(),
        mockSwaggerServer: values.mockSwaggerServer.trim(),
        mockHost: normalizeMockHost(values.mockHost) || "0.0.0.0",
        mockPort: Number(values.mockPort.trim()),
        mockServiceAddress: values.mockServiceAddress.trim(),
        mockBackendBaseUrl: values.mockBackendBaseUrl.trim(),
        mockAll: values.mockAll,
      });
      // 用刚提交的值当新基线，isDirty 归零（否则保存后按钮还停在「未保存」态）
      reset(values);
      showToast("配置已保存，下次启动项目时生效", "success");
    } catch (error) {
      showToast(`保存失败: ${error?.message || String(error)}`, "error");
    }
  });

  // HashRouter 下没有 useBlocker，拦不住路由跳转；退而求其次——离开时若还有未保存
  // 的改动，明确告诉用户「丢了」，而不是静默消失。
  const dirtyRef = useRef(false);
  useEffect(() => {
    dirtyRef.current = isDirty;
  }, [isDirty]);
  useEffect(() => {
    return () => {
      if (dirtyRef.current) {
        showToast("服务配置有未保存的修改，已丢弃", "warning");
      }
    };
  }, []);

  return (
    <PageShell
      title="服务配置"
      subtitle="配置 Swagger Mock 服务的主机、端口及后端代理地址"
      actions={
        <div className="flex items-center gap-2">
          {isDirty && (
            <span className="text-[11px] text-amber-600">● 有未保存的修改</span>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={isSubmitting || !isDirty}
            className="px-4 py-1.5 rounded-md border text-xs font-medium cursor-pointer transition-all bg-blue-500/20 text-blue-700 border-blue-500/40 hover:bg-blue-500/30 disabled:opacity-40 disabled:cursor-default"
          >
            {isSubmitting ? "保存中..." : "保存"}
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {/* 卡片 1：数据源配置与生成 */}
        <div className="p-5 border border-slate-200/90 rounded-xl bg-white shadow-2xs flex flex-col gap-4">
          <h3 className="text-xs font-bold text-slate-800 flex items-center gap-2 pb-2.5 border-b border-border">
            <svg className="w-4 h-4 text-violet-600" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="m20.25 7.5-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" />
            </svg>
            <span>数据源配置与生成</span>
          </h3>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-600">
              Swagger Mock OpenAPI JSON 目录
              <span className="ml-1 text-slate-400 font-normal">(绝对路径)</span>
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                {...register("mockSpecPath")}
                placeholder="/Users/yourname/tool/swagger-mock/json.output"
                className={`flex-1 ${INPUT_CLS}`}
              />
              <button
                type="button"
                onClick={handleSelectDirectory}
                className="px-3 py-2 rounded-md border text-xs font-medium bg-white text-slate-700 border-slate-200 hover:bg-slate-50 hover:text-slate-900 transition-colors flex items-center gap-1.5 cursor-pointer shrink-0 shadow-2xs"
              >
                <svg className="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-19.5 0A2.25 2.25 0 0 0 2.25 15v3.75A2.25 2.25 0 0 0 4.5 21h15a2.25 2.25 0 0 0 2.25-2.25V15a2.25 2.25 0 0 0-2.25-2.25m-19.5 0h19.5M2.25 9.75V7.125A2.25 2.25 0 0 1 4.5 5h3.75a3 3 0 0 1 2.25 1L12 8.25h6.75A2.25 2.25 0 0 1 21 10.5V12" />
                </svg>
                <span>选择文件夹</span>
              </button>
              <button
                type="button"
                onClick={handleOpenDirectory}
                className="px-3 py-2 rounded-md border text-xs font-medium bg-white text-slate-700 border-slate-200 hover:bg-slate-50 hover:text-slate-900 transition-colors flex items-center gap-1.5 cursor-pointer shrink-0 shadow-2xs"
                title="在访达中打开该目录"
              >
                <svg className="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                </svg>
                <span>打开目录</span>
              </button>
            </div>
            <FieldError message={errors.mockSpecPath?.message} />
            <p className="text-[11px] text-slate-400">
              必须填写包含 OpenAPI JSON/YAML 文件的绝对路径目录
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-600">
              Swagger 源服务器地址
              <span className="ml-1 text-slate-400 font-normal">(可选)</span>
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                {...register("mockSwaggerServer")}
                placeholder="http://your-swagger-server/t2"
                className={`flex-1 ${INPUT_CLS}`}
              />
              <button
                type="button"
                onClick={handleGenerate}
                disabled={generating}
                className="px-3.5 py-2 rounded-md border text-xs font-semibold bg-violet-50 text-violet-700 border-violet-200 hover:bg-violet-100 transition-colors cursor-pointer shrink-0 disabled:opacity-50 disabled:cursor-default flex items-center gap-1.5 shadow-2xs"
                title="从该服务器拉取各服务 swagger 文档，生成 OpenAPI JSON 写入上面的目录（进度见 Mock 运行日志）"
              >
                <svg className={clsx("w-3.5 h-3.5 text-violet-600", generating && "animate-spin")} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z" />
                </svg>
                <span>{generating ? "生成中…" : "生成 OpenAPI JSON"}</span>
              </button>
              <button
                type="button"
                onClick={() => openModal("/mock-service")}
                className="px-3 py-2 rounded-md border text-xs font-medium bg-white text-slate-700 border-slate-200 hover:bg-slate-50 hover:text-slate-900 transition-colors flex items-center gap-1.5 cursor-pointer shrink-0 shadow-2xs"
                title="打开 Mock 服务运行日志控制台"
              >
                <svg className="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                </svg>
                <span>查看日志</span>
              </button>
            </div>
            <p className="text-[11px] text-slate-400">
              点击「生成」会先保存目录与该地址，再从服务器拉取各服务 swagger
              文档写入上面的目录；生成进度见 Mock 运行日志
            </p>
          </div>
        </div>

        {/* 卡片 2：运行与代理配置 */}
        <div className="p-5 border border-slate-200/90 rounded-xl bg-white shadow-2xs flex flex-col gap-4">
          <h3 className="text-xs font-bold text-slate-800 flex items-center gap-2 pb-2.5 border-b border-border">
            <svg className="w-4 h-4 text-sky-600" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 1 1-3 0m3 0a1.5 1.5 0 1 0-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-9.75 0h9.75" />
            </svg>
            <span>Mock 运行与代理参数</span>
          </h3>
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-slate-600">Mock Host</label>
              <input
                type="text"
                {...register("mockHost")}
                placeholder="0.0.0.0"
                className={INPUT_CLS}
              />
              <FieldError message={errors.mockHost?.message} />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-slate-600">Mock Port</label>
              <input
                type="number"
                {...register("mockPort")}
                placeholder="3002"
                className={INPUT_CLS}
              />
              <FieldError message={errors.mockPort?.message} />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-600">
              Swagger Mock 服务地址
              <span className="ml-1 text-slate-400 font-normal">(可选)</span>
            </label>
            <input
              type="text"
              {...register("mockServiceAddress")}
              placeholder="/vjk 或 http://127.0.0.1:3002/vjk"
              className={INPUT_CLS}
            />
            <p className="text-[11px] text-slate-400">
              所有 mock 路由的前缀（如 /vjh、/vjk）。留空时自动读取 OpenAPI 文档里的默认前缀
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-600">
              后端代理地址
              <span className="ml-1 text-slate-400 font-normal">
                (BACKEND_BASE_URL / API)
              </span>
            </label>
            <input
              type="text"
              {...register("mockBackendBaseUrl")}
              placeholder="https://your-backend-host/t2"
              className={INPUT_CLS}
            />
            <label className="mt-1 inline-flex items-center gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                {...register("mockAll")}
                className="accent-blue-500"
              />
              全部接口使用 mock，不 fallback 到后端
            </label>
          </div>
        </div>
      </div>
      {confirmDialog}
    </PageShell>
  );
}
