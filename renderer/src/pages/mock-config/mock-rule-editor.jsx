import { useEffect, useState } from "react";
import { useForm, useFieldArray, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import clsx from "clsx";
import JsonEditor from "../../components/json-editor";
import RecommendMockModal from "./recommend-mock-modal";
import BackendCurlModal from "./backend-curl-modal";
import { METHODS, prettyJson } from "./utils";
import useModalNav from "../../hooks/use-modal-nav";

const statusText = z.string().refine(
  (v) => {
    const trimmed = v.trim();
    return trimmed === "" || Number.isInteger(Number(trimmed));
  },
  { message: "HTTP status 必须是整数" },
);

const delayText = z.string().refine(
  (v) => {
    const trimmed = v.trim();
    return trimmed === "" || (Number.isInteger(Number(trimmed)) && Number(trimmed) >= 0);
  },
  { message: "延时必须是大于等于 0 的整数" },
);

// 变体的匹配条件：一行 = 作用域 + key + 期望值（等值匹配）
const conditionSchema = z.object({
  scope: z.enum(["query", "header", "body"]),
  key: z.string().refine((v) => v.trim().length > 0, { message: "条件 key 不能为空" }),
  value: z.string(),
});

const variantSchema = z.object({
  name: z
    .string()
    .refine((v) => v.trim().length > 0, { message: "变体名不能为空" })
    .refine((v) => v.trim().length <= 60, { message: "变体名最多 60 字符" }),
  enabled: z.boolean(),
  status: statusText,
  delay: delayText,
  // 变体 response 必填（规则顶层才是兜底）
  responseText: z.string().refine(
    (v) => {
      if (!v.trim()) return false;
      try {
        JSON.parse(v);
        return true;
      } catch {
        return false;
      }
    },
    { message: "变体 Response 必须是合法 JSON（必填）" },
  ),
  conditions: z.array(conditionSchema).min(1, "至少要一个匹配条件"),
});

const ruleSchema = z
  .object({
    enabled: z.boolean(),
    method: z.string().min(1),
    path: z.string().refine((v) => v.trim().startsWith("/"), {
      message: "Path 必须以 / 开头",
    }),
    status: statusText,
    delay: delayText,
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
    variants: z.array(variantSchema),
  })
  .superRefine((values, ctx) => {
    const seen = new Set();
    values.variants.forEach((variant, index) => {
      const name = variant.name.trim();
      if (seen.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["variants", index, "name"],
          message: `变体名重复：${name}`,
        });
      }
      seen.add(name);
      const keys = new Set();
      variant.conditions.forEach((cond, condIndex) => {
        const pair = `${cond.scope}:${cond.key.trim()}`;
        if (keys.has(pair)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["variants", index, "conditions", condIndex, "key"],
            message: "同作用域下条件 key 重复",
          });
        }
        keys.add(pair);
      });
    });
  });

// when 对象 ↔ 条件行 的双向转换。展示时原始值 String()、对象/数组 JSON.stringify；
// 提交时 body 值尝试 JSON.parse（与 CLI 语义一致），query/header 保持字符串。
const SCOPE_TO_WHEN_KEY = { query: "query", header: "headers", body: "body" };

function whenToConditions(when) {
  const rows = [];
  for (const [scope, whenKey] of Object.entries(SCOPE_TO_WHEN_KEY)) {
    const group = when?.[whenKey];
    if (!group || typeof group !== "object") continue;
    for (const [key, value] of Object.entries(group)) {
      rows.push({
        scope,
        key,
        value: typeof value === "object" && value !== null ? JSON.stringify(value) : String(value),
      });
    }
  }
  return rows;
}

function conditionsToWhen(conditions) {
  const when = {};
  for (const cond of conditions) {
    const whenKey = SCOPE_TO_WHEN_KEY[cond.scope];
    const key = cond.scope === "header" ? cond.key.trim().toLowerCase() : cond.key.trim();
    let value = cond.value;
    if (cond.scope === "body") {
      try {
        value = JSON.parse(cond.value); // 2→数字、true→布尔、{"a":1}→对象；失败按字符串
      } catch {
        // 保留原字符串
      }
    }
    (when[whenKey] ||= {})[key] = value;
  }
  return when;
}

function variantToValues(variant) {
  return {
    name: variant.name || "",
    enabled: variant.enabled !== false,
    status: variant.status === undefined ? "" : String(variant.status),
    delay: variant.delay === undefined ? "" : String(variant.delay),
    responseText: prettyJson(variant.response),
    conditions: whenToConditions(variant.when),
  };
}

function valuesToVariant(values) {
  const status = values.status.trim();
  const delay = values.delay.trim();
  return {
    name: values.name.trim(),
    enabled: values.enabled,
    when: conditionsToWhen(values.conditions),
    ...(status ? { status: Number(status) } : {}),
    ...(delay ? { delay: Number(delay) } : {}),
    response: JSON.parse(values.responseText),
  };
}

function ruleToValues(rule, route) {
  if (!rule) {
    return {
      enabled: false,
      method: route?.method || "GET",
      path: route?.path || "",
      status: "",
      delay: "",
      responseText: prettyJson({
        rc: 0,
        code: "SUCCESS",
        message: "success",
        data: {},
      }),
      variants: [],
    };
  }
  return {
    enabled: rule.enabled !== false,
    method: (rule.method || route?.method || "*").toUpperCase(),
    path: rule.path || route?.path || "",
    status: rule.status === undefined ? "" : String(rule.status),
    delay: rule.delay === undefined ? "" : String(rule.delay),
    responseText: prettyJson(rule.response),
    variants: Array.isArray(rule.variants) ? rule.variants.map(variantToValues) : [],
  };
}

function valuesToRule(values) {
  const path = values.path.trim();
  const method = (values.method || "*").toUpperCase();
  const status = values.status.trim();
  const delay = values.delay.trim();
  const responseText = values.responseText.trim();
  const response = responseText ? JSON.parse(responseText) : undefined;
  const variants = values.variants.map(valuesToVariant);

  return {
    enabled: values.enabled,
    method,
    path,
    ...(status ? { status: Number(status) } : {}),
    ...(delay ? { delay: Number(delay) } : {}),
    ...(response !== undefined ? { response } : {}),
    ...(variants.length ? { variants } : {}),
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

const INPUT_CLS =
  "bg-card border border-border rounded-md px-2 py-1 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500";

const CONDITION_SCOPES = [
  { value: "query", label: "Query" },
  { value: "header", label: "Header" },
  { value: "body", label: "Body" },
];

// 一个变体的条件行（嵌套 useFieldArray 必须独立成组件）
function ConditionRows({ control, register, errors, variantIndex }) {
  const { fields, append, remove } = useFieldArray({
    control,
    name: `variants.${variantIndex}.conditions`,
  });
  const conditionErrors = errors.variants?.[variantIndex]?.conditions;

  return (
    <div className="px-3 py-2 flex flex-col gap-1.5 border-b border-border">
      <div className="text-[11px] text-slate-500 flex items-center gap-2">
        匹配条件（全部相等才命中）
        {typeof conditionErrors?.message === "string" && (
          <span className="text-red-600">{conditionErrors.message}</span>
        )}
        <button
          type="button"
          onClick={() => append({ scope: "query", key: "", value: "" })}
          className="ml-auto text-sky-700 hover:underline"
        >
          + 条件
        </button>
      </div>
      {fields.map((field, condIndex) => {
        const rowErrors = conditionErrors?.[condIndex];
        return (
          <div key={field.id} className="flex items-center gap-1.5">
            <select
              {...register(`variants.${variantIndex}.conditions.${condIndex}.scope`)}
              className={clsx(INPUT_CLS, "w-[88px] shrink-0")}
            >
              {CONDITION_SCOPES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <input
              {...register(`variants.${variantIndex}.conditions.${condIndex}.key`)}
              placeholder="key（Body 支持点路径 a.b.c）"
              className={clsx(INPUT_CLS, "flex-1 min-w-0")}
            />
            <span className="text-slate-400 text-xs shrink-0">=</span>
            <input
              {...register(`variants.${variantIndex}.conditions.${condIndex}.value`)}
              placeholder="期望值"
              className={clsx(INPUT_CLS, "flex-1 min-w-0")}
            />
            <button
              type="button"
              onClick={() => remove(condIndex)}
              title="删除条件"
              className="shrink-0 px-1.5 py-1 rounded-md text-[11px] text-red-600 hover:bg-red-400/10"
            >
              ✕
            </button>
            {rowErrors?.key && (
              <span className="text-[11px] text-red-600 shrink-0">{rowErrors.key.message}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function VariantCard({ control, register, errors, index, onRemove }) {
  const variantErrors = errors.variants?.[index];
  return (
    <div className="border border-border rounded-lg bg-card overflow-hidden">
      <div className="px-3 py-2 flex items-center gap-2 border-b border-border">
        <span className="text-[11px] text-slate-400 shrink-0">#{index + 1}</span>
        <input
          {...register(`variants.${index}.name`)}
          placeholder="变体名（规则内唯一）"
          className={clsx(INPUT_CLS, "flex-1 min-w-0")}
        />
        <input
          {...register(`variants.${index}.status`)}
          placeholder="Status"
          className={clsx(INPUT_CLS, "w-16 shrink-0")}
        />
        <input
          {...register(`variants.${index}.delay`)}
          placeholder="Delay"
          className={clsx(INPUT_CLS, "w-16 shrink-0")}
        />
        <label className="inline-flex items-center gap-1 text-[11px] text-slate-800 shrink-0">
          <input
            type="checkbox"
            {...register(`variants.${index}.enabled`)}
            className="accent-emerald-400"
          />
          启用
        </label>
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 px-2 py-1 rounded-md border text-[11px] bg-red-400/10 text-red-700 border-red-400/30 hover:bg-red-400/20"
        >
          删除变体
        </button>
      </div>
      {(variantErrors?.name || variantErrors?.status || variantErrors?.delay) && (
        <div className="px-3 pt-1.5 text-[11px] text-red-600">
          {variantErrors.name?.message || variantErrors.status?.message || variantErrors.delay?.message}
        </div>
      )}
      <ConditionRows
        control={control}
        register={register}
        errors={errors}
        variantIndex={index}
      />
      <div className="px-3 py-2.5">
        <div className="text-[11px] text-slate-500 mb-1.5 flex items-center gap-2">
          Response JSON（命中时返回）
          {variantErrors?.responseText && (
            <span className="text-red-600">{variantErrors.responseText.message}</span>
          )}
        </div>
        <div className="h-[160px] border border-border rounded-md overflow-hidden bg-[#fafbfc]">
          <Controller
            name={`variants.${index}.responseText`}
            control={control}
            render={({ field }) => (
              <JsonEditor value={field.value} onChange={field.onChange} height="100%" />
            )}
          />
        </div>
      </div>
    </div>
  );
}

function VariantsSection({ control, register, errors }) {
  const { fields, append, remove } = useFieldArray({ control, name: "variants" });
  const [open, setOpen] = useState(fields.length > 0);

  const addVariant = () => {
    append({
      name: `变体${fields.length + 1}`,
      enabled: true,
      status: "",
      delay: "",
      responseText: prettyJson({ rc: 0, code: "SUCCESS", message: "success", data: {} }),
      conditions: [{ scope: "query", key: "", value: "" }],
    });
    setOpen(true);
  };

  return (
    <div className="border-b border-border">
      <div className="px-4 py-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-xs font-medium text-slate-600 inline-flex items-center gap-1 cursor-pointer"
        >
          <span className={clsx("inline-block transition-transform", open && "rotate-90")}>▸</span>
          响应变体 ({fields.length})
        </button>
        <span className="text-[11px] text-slate-400 truncate">
          按条件返回不同响应，从上到下第一条命中生效；都不命中回退下方兜底
        </span>
        <button
          type="button"
          onClick={addVariant}
          className="ml-auto shrink-0 px-2 py-1 rounded-md border text-[11px] bg-sky-400/10 text-sky-700 border-sky-400/35 hover:bg-sky-400/20"
        >
          + 添加变体
        </button>
      </div>
      {open && fields.length > 0 && (
        <div className="px-4 pb-3 flex flex-col gap-3">
          {fields.map((field, index) => (
            <VariantCard
              key={field.id}
              control={control}
              register={register}
              errors={errors}
              index={index}
              onRemove={() => remove(index)}
            />
          ))}
        </div>
      )}
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
  // null | "backend" | "local"：控制 curl 调试弹窗打开与请求目标
  const [curlMode, setCurlMode] = useState(null);
  const openModal = useModalNav();
  const path = watch("path");
  const method = watch("method");
  const variantCount = watch("variants")?.length ?? 0;

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
        className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden"
      >
        <div className="p-4 border-b border-border grid grid-cols-[110px_1fr_90px_100px] gap-3">
          <FieldShell label="Method">
            <select
              {...register("method")}
              className="bg-card border border-border rounded-md px-3 py-2 text-xs text-slate-900 outline-none focus:border-slate-500 w-full"
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
              className="bg-card border border-border rounded-md px-3 py-2 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500 w-full"
            />
          </FieldShell>
          <FieldShell label="Status" error={errors.status?.message}>
            <input
              {...register("status")}
              placeholder="200"
              className="bg-card border border-border rounded-md px-3 py-2 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500 w-full"
            />
          </FieldShell>
          <FieldShell label="Delay (ms)" error={errors.delay?.message}>
            <input
              {...register("delay")}
              placeholder="0"
              className="bg-card border border-border rounded-md px-3 py-2 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500 w-full"
            />
          </FieldShell>
        </div>

        {/* flex-wrap：宽度不够时按钮组整体换到下一行，而不是溢出被裁掉 */}
        <div className="px-4 py-3 border-b border-border flex flex-wrap items-center gap-x-3 gap-y-2">
          <label className="inline-flex items-center gap-2 text-xs text-slate-800 shrink-0">
            <input
              type="checkbox"
              {...register("enabled")}
              className="accent-emerald-400"
            />
            启用 mock
          </label>
          <span className="text-[11px] text-slate-500 truncate max-w-[220px]">
            {previewUrl}
          </span>
          {/* 操作按钮固定在上方，不随变体/兜底编辑区滚动 */}
          <div className="ml-auto flex flex-wrap gap-2 shrink-0 justify-end">
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
              onClick={() => setCurlMode("backend")}
              disabled={!route || !path.trim()}
              title="使用推荐数据向配置的后端代理地址执行 curl"
              className="px-2 py-1 rounded-md border text-[11px] bg-emerald-400/10 text-emerald-700 border-emerald-400/35 hover:bg-emerald-400/20 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              后端调试
            </button>
            <button
              type="button"
              onClick={() => setCurlMode("local")}
              disabled={!route || !path.trim()}
              title="请求本机已启动的 mock 服务，验证当前接口的实际返回"
              className="px-2 py-1 rounded-md border text-[11px] bg-sky-400/10 text-sky-700 border-sky-400/35 hover:bg-sky-400/20 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              本地请求
            </button>
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

        <div className="flex-1 min-h-0 flex flex-col overflow-y-auto">
          <VariantsSection control={control} register={register} errors={errors} />
          <div className="px-4 py-2.5 flex items-center gap-2 shrink-0">
            <div className="text-xs font-medium text-slate-600">
              {variantCount ? "Response JSON（兜底：无变体命中时返回）" : "Response JSON"}
            </div>
            {errors.responseText && (
              <div className="text-[11px] text-red-600">
                {errors.responseText.message}
              </div>
            )}
          </div>
          <div className="flex-1 min-h-[300px] shrink-0 mx-4 mb-4 border border-border rounded-lg overflow-hidden bg-[#fafbfc]">
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
          open={curlMode !== null}
          mode={curlMode || "backend"}
          method={(method || route.method).toUpperCase()}
          path={path.trim()}
          baseUrl={curlMode === "local" ? mockBaseUrl : backendBaseUrl}
          onClose={() => setCurlMode(null)}
          onViewLogs={() => {
            setCurlMode(null);
            openModal("/mock-service");
          }}
        />
      )}
    </>
  );
}
