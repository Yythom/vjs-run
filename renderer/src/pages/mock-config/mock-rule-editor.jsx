import { useEffect, useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import clsx from "clsx";
import JsonEditor from "../../components/json-editor";
import RecommendMockModal from "./recommend-mock-modal";
import BackendCurlModal from "./backend-curl-modal";
import { METHODS, prettyJson } from "./utils";
import useModalNav from "../../hooks/use-modal-nav";

const ruleSchema = z.object({
  enabled: z.boolean(),
  method: z.string().min(1),
  path: z.string().refine((v) => v.trim().startsWith("/"), {
    message: "Path 必须以 / 开头",
  }),
  status: z.string().refine(
    (v) => {
      const trimmed = v.trim();
      return trimmed === "" || Number.isInteger(Number(trimmed));
    },
    { message: "HTTP status 必须是整数" },
  ),
  responseText: z.string().refine(
    (v) => {
      if (!v.trim()) return true;
      try {
        JSON.parse(v);
        return true;
      } catch {
        return false;
      }
    },
    { message: "Response JSON 格式错误" },
  ),
});

function ruleToValues(rule, route) {
  if (!rule) {
    return {
      enabled: false,
      method: route?.method || "GET",
      path: route?.path || "",
      status: "",
      responseText: prettyJson({
        rc: 0,
        code: "SUCCESS",
        message: "success",
        data: {},
      }),
    };
  }
  return {
    enabled: rule.enabled !== false,
    method: (rule.method || route?.method || "*").toUpperCase(),
    path: rule.path || route?.path || "",
    status: rule.status === undefined ? "" : String(rule.status),
    responseText: prettyJson(rule.response),
  };
}

function valuesToRule(values) {
  const path = values.path.trim();
  const method = (values.method || "*").toUpperCase();
  const status = values.status.trim();
  const responseText = values.responseText.trim();
  const response = responseText ? JSON.parse(responseText) : undefined;

  return {
    enabled: values.enabled,
    method,
    path,
    ...(status ? { status: Number(status) } : {}),
    ...(response !== undefined ? { response } : {}),
  };
}

function FieldShell({ label, error, children }) {
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <label className="text-xs text-slate-600">{label}</label>
      {children}
      {error && <div className="text-[11px] text-red-600">{error}</div>}
    </div>
  );
}

/**
 * Editor 自治：内部持有表单状态 (react-hook-form + zod)。
 * 父组件只传初始 rule/route 和 onSubmit/onDelete。
 *
 * 选中项变化时父组件用 key={selectedKey} 触发 Editor 重挂，
 * 重挂会让 useForm 用新的 defaultValues 初始化 —— 替代旧的 in-render setState 同步。
 *
 * 同一选中项的 rule 引用变化（保存后 reload）时，用 in-render reset() 同步外部数据。
 */
export default function MockRuleEditor({
  rule,
  route,
  hasSavedRule,
  mockBaseUrl,
  backendBaseUrl,
  onSubmit,
  onDelete,
  onDirtyChange,
}) {
  const {
    register,
    control,
    handleSubmit,
    setValue,
    reset,
    watch,
    formState: { errors, isSubmitting, isDirty },
  } = useForm({
    resolver: zodResolver(ruleSchema),
    defaultValues: ruleToValues(rule, route),
  });

  // 外部 rule 引用变化（保存后 reload）时同步表单。
  // 同一 selectedKey 下保存成功 → rules reload → rule ref 变 → reset。
  const [prevRule, setPrevRule] = useState(rule);
  if (rule !== prevRule) {
    setPrevRule(rule);
    reset(ruleToValues(rule, route));
  }

  // 把「表单有未保存改动」上报给父组件，用于切换选中项时拦截丢失。
  // 卸载时补一次 false，避免残留的 dirty 状态误拦下一次切换。
  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const [recommendOpen, setRecommendOpen] = useState(false);
  const [backendCurlOpen, setBackendCurlOpen] = useState(false);
  const openModal = useModalNav();
  const path = watch("path");
  const method = watch("method");

  const submit = handleSubmit(async (values) => {
    await onSubmit(valuesToRule(values));
  });



  const openRecommend = () => {
    if (!path.trim()) return;
    setRecommendOpen(true);
  };

  const applyRecommend = (text) => {
    setValue("responseText", text, { shouldDirty: true });
    setRecommendOpen(false);
  };

  const previewUrl = path ? `${mockBaseUrl}${path}` : mockBaseUrl;

  return (
    <>
      <form
        onSubmit={submit}
        className="min-w-0 min-h-0 flex flex-col overflow-hidden"
      >
        <div className="p-4 border-b border-border grid grid-cols-[110px_1fr_110px] gap-3">
          <FieldShell label="Method">
            <select
              {...register("method")}
              className="bg-card border border-border rounded-md px-3 py-2 text-xs text-slate-900 outline-none focus:border-slate-500"
            >
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </FieldShell>
          <FieldShell label="Path" error={errors.path?.message}>
            <input
              {...register("path")}
              placeholder="/api/example"
              className="bg-card border border-border rounded-md px-3 py-2 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500"
            />
          </FieldShell>
          <FieldShell label="Status" error={errors.status?.message}>
            <input
              {...register("status")}
              placeholder="200"
              className="bg-card border border-border rounded-md px-3 py-2 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500"
            />
          </FieldShell>
        </div>

        <div className="px-4 py-3 border-b border-border flex items-center gap-3">
          <label className="inline-flex items-center gap-2 text-xs text-slate-800">
            <input
              type="checkbox"
              {...register("enabled")}
              className="accent-emerald-400"
            />
            启用 mock
          </label>
          <span className="ml-auto text-[11px] text-slate-500 truncate max-w-[260px]">
            {previewUrl}
          </span>
        </div>

        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <div className="px-4 py-2.5 flex items-center gap-2">
            <div className="text-xs font-medium text-slate-600">
              Response JSON
            </div>
            {errors.responseText && (
              <div className="text-[11px] text-red-600">
                {errors.responseText.message}
              </div>
            )}
            <div className="ml-auto flex gap-2">
              <button
                type="button"
                onClick={openRecommend}
                disabled={!path.trim()}
                title="根据 swagger schema 生成一份推荐 mock JSON"
                className={clsx(
                  "px-2 py-1 rounded-md border text-[11px]",
                  "bg-violet-400/10 text-violet-700 border-violet-400/35 hover:bg-violet-400/20",
                  "disabled:opacity-40 disabled:cursor-not-allowed",
                )}
              >
                推荐数据 ✨
              </button>
              <button
                type="button"
                onClick={() => setBackendCurlOpen(true)}
                disabled={!route || !path.trim()}
                title="使用推荐数据向配置的后端代理地址执行 curl"
                className="px-2 py-1 rounded-md border text-[11px] bg-emerald-400/10 text-emerald-700 border-emerald-400/35 hover:bg-emerald-400/20 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                后端调试
              </button>

              <div className="ml-auto flex gap-2">
                <button
                  type="button"
                  onClick={onDelete}
                  disabled={!hasSavedRule || isSubmitting}
                  className="px-3 py-1.5 rounded-md border text-xs font-medium bg-red-400/10 text-red-700 border-red-400/30 hover:bg-red-400/20 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  删除
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-3 py-1.5 rounded-md border text-xs font-medium bg-sky-400/10 text-sky-700 border-sky-400/35 hover:bg-sky-400/20 disabled:opacity-40"
                >
                  {isSubmitting ? "保存中…" : "保存JSON"}
                </button>
              </div>
            </div>
          </div>
          <div className="flex-1 min-h-0 mx-4 mb-4 border border-border rounded-lg overflow-hidden bg-[#fafbfc]">
            <Controller
              name="responseText"
              control={control}
              render={({ field }) => (
                <JsonEditor
                  value={field.value}
                  onChange={field.onChange}
                  height="100%"
                />
              )}
            />
          </div>
        </div>

        <div className="shrink-0 border-t border-border px-4 py-3 flex items-center gap-2">
          <span className="text-[11px] text-slate-500">
            {!hasSavedRule ? "未保存" : isDirty ? "有未保存改动" : "已保存"}
          </span>
        </div>
      </form>

      <RecommendMockModal
        open={recommendOpen}
        method={(method || "*").toUpperCase()}
        path={path.trim()}
        onClose={() => setRecommendOpen(false)}
        onApply={applyRecommend}
      />
      {route && (
        <BackendCurlModal
          open={backendCurlOpen}
          method={(method || route.method).toUpperCase()}
          path={path.trim()}
          backendBaseUrl={backendBaseUrl}
          onClose={() => setBackendCurlOpen(false)}
          onViewLogs={() => {
            setBackendCurlOpen(false);
            openModal("/mock-service");
          }}
        />
      )}
    </>
  );
}
