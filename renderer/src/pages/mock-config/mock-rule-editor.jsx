import { useEffect, useRef, useState } from "react";
import { useForm, useFieldArray, Controller, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import clsx from "clsx";
import { toast } from "sonner";
import JsonEditor from "../../components/json-editor";
import RecommendMockModal from "./recommend-mock-modal";
import BackendCurlModal from "./backend-curl-modal";
import RequestSchemaPanel, { ScopeTag, formatExample } from "./request-schema-panel";
import { METHODS, prettyJson } from "./utils";
import useModalNav from "../../hooks/use-modal-nav";
import useResource from "../../hooks/use-resource";

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

/**
 * path/variants 的展示型订阅拆成叶子组件：MockRuleEditor 顶层不再调 watch()，
 * 输入 Path 时只重渲染这几个小组件，而不是整个编辑器树。
 */
function PreviewUrl({ control, mockBaseUrl }) {
  const path = useWatch({ control, name: "path" }) || "";
  return (
    <span className="text-[11px] text-slate-400 font-mono truncate max-w-[500px]">
      {path ? `${mockBaseUrl}${path}` : mockBaseUrl}
    </span>
  );
}

function FallbackResponseTitle({ control }) {
  const variants = useWatch({ control, name: "variants" });
  return (
    <div className="text-xs font-bold text-slate-700">
      {variants?.length ? "Response JSON（兜底：无变体命中时返回）" : "Response JSON"}
    </div>
  );
}

/** 依赖 path 是否为空来禁用的底部按钮组 */
function PathActions({ control, route, onRecommend, onCurl }) {
  const path = useWatch({ control, name: "path" }) || "";
  const disabled = !path.trim();
  return (
    <>
      <button
        type="button"
        onClick={onRecommend}
        disabled={disabled}
        title="根据 swagger schema 生成一份推荐 mock JSON"
        className="px-3 py-1.5 rounded-lg border text-xs font-semibold bg-violet-500/5 text-violet-600 border-violet-200/50 hover:bg-violet-500/10 cursor-pointer transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        推荐数据 ✨
      </button>
      {route && (
        <>
          <button
            type="button"
            onClick={() => onCurl("backend")}
            disabled={disabled}
            title="使用推荐数据向配置的后端代理地址执行 curl"
            className="px-3 py-1.5 rounded-lg border text-xs font-semibold bg-emerald-500/5 text-emerald-600 border-emerald-200/50 hover:bg-emerald-500/10 cursor-pointer transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            后端调试
          </button>
          <button
            type="button"
            onClick={() => onCurl("local")}
            disabled={disabled}
            title="请求本机已启动的 mock 服务，验证当前接口的实际返回"
            className="px-3 py-1.5 rounded-lg border text-xs font-semibold bg-sky-500/5 text-sky-600 border-sky-200/50 hover:bg-sky-500/10 cursor-pointer transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            本地验证
          </button>
        </>
      )}
    </>
  );
}

/**
 * 三个弹窗（推荐数据 / curl 调试 / 变体 curl）的开关 state 全部收在这里，
 * 开关弹窗只重渲染本组件，不触碰 MockRuleEditor 顶层。
 * 打开入口通过 openersRef 暴露给外层的按钮（事件调用，不参与渲染数据流）。
 */
function EditorModals({
  route,
  getValues,
  setValue,
  mockBaseUrl,
  backendBaseUrl,
  onViewLogs,
  openersRef,
}) {
  const [recommendTarget, setRecommendTarget] = useState(null); // null | { method, path }
  const [curlTarget, setCurlTarget] = useState(null); // null | { mode, method, path }
  const [variantCurl, setVariantCurl] = useState(null);

  // 弹窗打开瞬间捕获 method/path，打开期间改 Path 输入框不影响已开的弹窗
  const captureTarget = () => ({
    method: (getValues("method") || route?.method || "*").toUpperCase(),
    path: getValues("path").trim(),
  });

  useEffect(() => {
    openersRef.current = {
      openRecommend: () => {
        const target = captureTarget();
        if (target.path) setRecommendTarget(target);
      },
      openCurl: (mode) => {
        const target = captureTarget();
        if (target.path) setCurlTarget({ mode, ...target });
      },
      openVariantCurl: (data) => {
        setVariantCurl({ ...data, ...captureTarget() });
      },
    };
    return () => {
      openersRef.current = null;
    };
  });

  const applyRecommend = (text) => {
    setValue("responseText", text, { shouldDirty: true });
    setRecommendTarget(null);
  };

  return (
    <>
      <RecommendMockModal
        open={recommendTarget !== null}
        method={recommendTarget?.method || "*"}
        path={recommendTarget?.path || ""}
        onClose={() => setRecommendTarget(null)}
        onApply={applyRecommend}
      />
      {route && curlTarget && (
        <BackendCurlModal
          open
          mode={curlTarget.mode}
          method={curlTarget.method}
          path={curlTarget.path}
          baseUrl={curlTarget.mode === "local" ? mockBaseUrl : backendBaseUrl}
          onClose={() => setCurlTarget(null)}
          onViewLogs={onViewLogs}
        />
      )}
      {route && variantCurl && (
        <BackendCurlModal
          open
          mode={variantCurl.mode}
          method={variantCurl.method}
          path={variantCurl.path}
          baseUrl={variantCurl.mode === "local" ? mockBaseUrl : backendBaseUrl}
          initialParams={variantCurl.initialParams}
          initialBody={variantCurl.initialBody}
          onClose={() => setVariantCurl(null)}
          onViewLogs={onViewLogs}
        />
      )}
    </>
  );
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



const CONDITION_SCOPES = [
  { value: "query", label: "Query" },
  { value: "header", label: "Header" },
  { value: "body", label: "Body" },
];

/**
 * 「+ 条件」下拉：列出 swagger 里可做条件的参数，点选即填好 scope/key/示例值。
 * path 参数不在列内——它已经体现在规则的 path 模板（/api/user/{id}）里，
 * 不是请求间的差异，拿来做变体条件没有意义。
 */
function ConditionPicker({ schema, onPick }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event) => {
      if (!wrapRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const options = [
    ...(schema?.parameters || [])
      .filter((p) => p.in !== "path")
      .map((p) => ({
        scope: p.in,
        key: p.name,
        value: formatExample(p.example),
        hint: p.description,
      })),
    ...(schema?.body?.fields || []).map((f) => ({
      scope: "body",
      key: f.path,
      value: formatExample(f.example),
      hint: f.type,
    })),
  ];

  // 只把表单需要的三个字段交出去，hint 仅用于下拉里的展示
  const pick = ({ scope, key, value }) => {
    setOpen(false);
    onPick({ scope, key, value });
  };

  return (
    <div ref={wrapRef} className="relative ml-auto">
      <button
        type="button"
        onClick={() => (options.length ? setOpen(!open) : pick({ scope: "query", key: "", value: "" }))}
        className="text-sky-700 hover:underline"
      >
        + 条件{options.length > 0 && (open ? " ▲" : " ▼")}
      </button>
      {open && (
        <div className="absolute z-20 top-full right-0 mt-1 w-[300px] max-h-[260px] overflow-y-auto rounded-md border border-border bg-card shadow-lg py-1">
          <div className="px-2.5 py-1 text-[10px] text-slate-400">
            来自 swagger 的请求参数
          </div>
          {options.map((option) => (
            <button
              key={`${option.scope}:${option.key}`}
              type="button"
              onClick={() => pick(option)}
              className="w-full px-2.5 py-1.5 flex items-center gap-2 hover:bg-hover text-left cursor-pointer"
            >
              <ScopeTag scope={option.scope} />
              <span className="text-[11px] text-slate-900 truncate">{option.key}</span>
              {option.value !== "" && (
                <span className="ml-auto text-[10px] text-slate-400 font-mono truncate max-w-[110px] shrink-0">
                  {option.value}
                </span>
              )}
            </button>
          ))}
          <button
            type="button"
            onClick={() => pick({ scope: "query", key: "", value: "" })}
            className="w-full px-2.5 py-1.5 text-[11px] text-slate-600 hover:bg-hover text-left border-t border-border mt-1 cursor-pointer"
          >
            自定义条件…
          </button>
        </div>
      )}
    </div>
  );
}

// 一个变体的条件行（嵌套 useFieldArray 必须独立成组件）
function ConditionRows({ control, register, errors, variantIndex, requestSchema }) {
  const { fields, append, remove } = useFieldArray({
    control,
    name: `variants.${variantIndex}.conditions`,
  });
  const conditionErrors = errors.variants?.[variantIndex]?.conditions;

  return (
    <div className="px-4 py-3.5 border-b border-slate-100 bg-slate-50/20 flex flex-col gap-2.5">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[11px] font-bold text-slate-500 tracking-wider">匹配条件（全部满足才生效）</span>
        {typeof conditionErrors?.message === "string" && (
          <span className="text-red-600 text-xs">{conditionErrors.message}</span>
        )}
        <ConditionPicker schema={requestSchema} onPick={append} />
      </div>
      {fields.length === 0 ? (
        <div className="text-[11px] text-slate-400 py-1 pl-1 font-normal italic">
          暂无匹配条件，请在右上角点击“+ 条件”添加参数或自定义条件
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {fields.map((field, condIndex) => {
            const rowErrors = conditionErrors?.[condIndex];
            return (
              <div key={field.id} className="flex items-center gap-2 flex-wrap bg-white/60 p-2 border border-slate-200/50 rounded-lg shadow-sm">
                <span className="text-[10px] font-bold text-slate-400 w-8 text-center shrink-0">
                  {condIndex === 0 ? "IF" : "AND"}
                </span>
                <select
                  {...register(`variants.${variantIndex}.conditions.${condIndex}.scope`)}
                  className="bg-slate-100 border border-slate-200 hover:bg-slate-200/40 rounded-lg px-2.5 py-1.5 text-xs text-slate-700 outline-none w-[88px] shrink-0 font-semibold cursor-pointer appearance-none transition-all text-center"
                >
                  {CONDITION_SCOPES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
                <input
                  {...register(`variants.${variantIndex}.conditions.${condIndex}.key`)}
                  placeholder="字段 key (例如 filter.type)"
                  className="bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-xs text-slate-800 placeholder-slate-400 outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500/20 transition-all flex-1 min-w-[120px] font-mono shadow-sm"
                />
                <span className="text-slate-400 text-xs font-bold shrink-0 px-0.5">==</span>
                <input
                  {...register(`variants.${variantIndex}.conditions.${condIndex}.value`)}
                  placeholder="期望值"
                  className="bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-xs text-slate-800 placeholder-slate-400 outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500/20 transition-all flex-1 min-w-[120px] font-mono shadow-sm"
                />
                <button
                  type="button"
                  onClick={() => remove(condIndex)}
                  title="删除条件"
                  className="shrink-0 px-2 py-1.5 rounded-md text-[11px] text-red-500 hover:bg-red-500/10 hover:text-red-700 font-bold transition-all duration-150 cursor-pointer"
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
      )}
    </div>
  );
}

function VariantCard({ control, register, errors, index, onRemove, onVariantCurl, requestSchema }) {
  const variantErrors = errors.variants?.[index];
  const isEnabled = useWatch({
    control,
    name: `variants.${index}.enabled`,
    defaultValue: true,
  });

  return (
    <div className={clsx(
      "border border-slate-200 rounded-xl bg-white shadow-sm shrink-0 border-l-4 mb-4 last:mb-0 transition-all duration-200",
      isEnabled ? "border-l-emerald-500" : "border-l-violet-500/80"
    )}>
      <div className="px-4 py-3 flex items-center gap-3 border-b border-slate-100 bg-slate-50/40 flex-wrap">
        <span className="text-xs font-bold text-slate-400 shrink-0">#{index + 1}</span>
        <input
          {...register(`variants.${index}.name`)}
          placeholder="变体名称 (描述该变体用途)"
          className="bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-xs text-slate-800 placeholder-slate-400 focus:border-violet-500 focus:ring-1 focus:ring-violet-500/20 transition-all flex-1 min-w-[180px] font-semibold outline-none"
        />
        <input
          {...register(`variants.${index}.status`)}
          placeholder="Status"
          className="bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 placeholder-slate-400 focus:border-violet-500 focus:ring-1 focus:ring-violet-500/20 transition-all w-16 shrink-0 text-center font-medium outline-none"
        />
        <input
          {...register(`variants.${index}.delay`)}
          placeholder="Delay"
          className="bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 placeholder-slate-400 focus:border-violet-500 focus:ring-1 focus:ring-violet-500/20 transition-all w-16 shrink-0 text-center font-medium outline-none"
        />
        <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700 shrink-0 cursor-pointer">
          <span className="relative inline-flex items-center">
            <input
              type="checkbox"
              {...register(`variants.${index}.enabled`)}
              className="sr-only peer"
            />
            <div className="w-7 h-4 bg-slate-200 rounded-full peer peer-checked:after:translate-x-3 peer-checked:bg-violet-600 after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all"></div>
          </span>
          启用
        </label>
        <div className="flex gap-1.5 ml-auto shrink-0 items-center">
          {/* 自定义规则没有 route，curl 调试弹窗打不开，这两个入口直接不渲染 */}
          {onVariantCurl && (
            <>
              <button
                type="button"
                onClick={() => onVariantCurl(index, "local")}
                title="使用该变体的匹配条件，请求本地 mock 服务进行验证"
                className="shrink-0 px-2 py-0.5 rounded-md border border-sky-200 bg-sky-500/5 text-[10px] text-sky-600 hover:bg-sky-500/10 hover:text-sky-700 font-semibold cursor-pointer transition-colors duration-150"
              >
                ⚡ 本地验证
              </button>
              <button
                type="button"
                onClick={() => onVariantCurl(index, "backend")}
                title="使用该变体的匹配条件，请求代理的真实后端服务进行调试"
                className="shrink-0 px-2 py-0.5 rounded-md border border-emerald-200 bg-emerald-500/5 text-[10px] text-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-700 font-semibold cursor-pointer transition-colors duration-150"
              >
                ⚡ 后端调试
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onRemove}
            className="shrink-0 px-2 py-0.5 rounded-md border border-red-200 bg-red-500/5 text-[10px] text-red-600 hover:bg-red-500/10 hover:text-red-700 font-semibold cursor-pointer transition-colors duration-150"
          >
            删除
          </button>
        </div>

      </div>
      {(variantErrors?.name || variantErrors?.status || variantErrors?.delay) && (
        <div className="px-4 pt-2 text-[11px] text-red-600 font-medium">
          {variantErrors.name?.message || variantErrors.status?.message || variantErrors.delay?.message}
        </div>
      )}
      <ConditionRows
        control={control}
        register={register}
        errors={errors}
        variantIndex={index}
        requestSchema={requestSchema}
      />
      <div className="px-4 py-3.5 bg-white">
        <div className="text-[11px] font-bold text-slate-500 mb-1.5 flex items-center gap-2">
          <span>Response JSON (命中时返回此响应)</span>
          {variantErrors?.responseText && (
            <span className="text-red-600 font-medium">{variantErrors.responseText.message}</span>
          )}
        </div>
        <div className="h-[160px] border border-slate-200 rounded-lg overflow-hidden bg-slate-50/20 shadow-inner">
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


function VariantsSection({ control, register, errors, onVariantCurl, requestSchema }) {
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
    <div className="border border-slate-200/70 rounded-xl bg-white shadow-sm shrink-0 p-3.5 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-xs font-bold text-slate-700 inline-flex items-center gap-1.5 cursor-pointer hover:text-slate-900 transition-colors outline-none"
        >
          <span className={clsx("inline-block transition-transform duration-200", open && "rotate-90")}>▸</span>
          响应变体 ({fields.length})
        </button>
        <span className="text-[11px] text-slate-400 truncate">
          按条件返回不同响应，从上到下第一条命中生效；都不命中回退下方兜底
        </span>
        <button
          type="button"
          onClick={addVariant}
          className="ml-auto shrink-0 px-2.5 py-1 rounded-lg border text-xs font-semibold bg-sky-500/5 text-sky-600 border-sky-200/60 hover:bg-sky-500/10 cursor-pointer transition-colors duration-150"
        >
          + 添加变体
        </button>
      </div>
      {open && fields.length > 0 && (
        <div className="flex flex-col gap-3 pt-1">
          {fields.map((field, index) => (
            <VariantCard
              key={field.id}
              control={control}
              register={register}
              errors={errors}
              index={index}
              onRemove={() => remove(index)}
              onVariantCurl={onVariantCurl}
              requestSchema={requestSchema}
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
  confirm,
}) {
  const {
    register,
    control,
    handleSubmit,
    setValue,
    reset,
    getValues,
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
  // 回调经 ref 转发：即使父组件某天传了不稳定的回调，卸载清理也只在真正卸载时跑。
  const onDirtyChangeRef = useRef(onDirtyChange);
  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  });
  useEffect(() => {
    onDirtyChangeRef.current?.(isDirty);
  }, [isDirty]);
  // 卸载时补一次 false，避免残留的 dirty 状态误拦下一次切换。
  useEffect(() => () => onDirtyChangeRef.current?.(false), []);

  // 请求参数 schema：只在挂载时按「选中项自带的 method/path」拉一次
  // （编辑器有 key={selectedKey}，切换接口会重挂）。不跟 watch("path") 走，
  // 否则用户在 Path 输入框里每敲一个字都会触发一次重量级的 swagger 解析。
  const schemaMethod = (route?.method || rule?.method || "").toUpperCase();
  const schemaPath = route?.path || rule?.path || "";
  const {
    data: requestSchema,
    loading: schemaLoading,
    error: schemaError,
  } = useResource(async () => {
    // 自定义规则（spec 外的路径）没有 route，swagger 里查不到，不必发请求
    if (!route || !schemaPath) return null;
    const result = await window.electronAPI.getMockRequestSchema({
      method: schemaMethod,
      path: schemaPath,
    });
    if (!result?.success) throw new Error(result?.error || "读取请求参数失败");
    return result;
  }, [schemaMethod, schemaPath, Boolean(route)]);

  // 弹窗 state 全部下沉到 EditorModals，顶层只留一个 opener ref：
  // 开/关弹窗不再触发整个编辑器重渲染。
  const modalOpenersRef = useRef(null);

  const handleVariantCurl = (idx, mode) => {
    const variantValues = getValues(`variants.${idx}`);
    if (!variantValues) return;

    const params = {};
    const bodyObj = {};

    (variantValues.conditions || []).forEach((c) => {
      if (!c.key) return;
      const val = c.value;
      if (c.scope === "query") {
        params[c.key] = val;
      } else if (c.scope === "body") {
        setDeepValue(bodyObj, c.key, val);
      }
    });

    modalOpenersRef.current?.openVariantCurl({
      mode,
      initialParams: params,
      initialBody: Object.keys(bodyObj).length > 0 ? bodyObj : null,
    });
  };
  const openModal = useModalNav();
  const handleViewLogs = () => {
    if (window.electronAPI?.openWindow) {
      window.electronAPI.openWindow("/mock-service");
    } else {
      openModal("/mock-service");
    }
  };
  const submit = handleSubmit(async (values) => {
    try {
      const choice = await confirm({
        title: "保存 Mock 规则",
        message: `请选择您想如何保存对该接口的 Mock 修改？\n\n${(values.method || "*").toUpperCase()} ${values.path || ""}`,
        confirmText: "保存并启用",
        altText: "仅保存",
        cancelText: "取消",
      });

      if (choice === false) {
        return; // 取消保存
      }

      const shouldEnable = choice === true;
      const finalValues = {
        ...values,
        enabled: shouldEnable ? true : values.enabled,
      };

      await onSubmit(valuesToRule(finalValues));

      if (shouldEnable) {
        setValue("enabled", true, { shouldDirty: false });
      }
    } catch (e) {
      toast.error(e.message || String(e));
    }
  });



  return (
    <>
      <form
        onSubmit={submit}
        className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden"
      >
        <div className="p-4 border-b border-border bg-slate-50/40 shrink-0 flex flex-col gap-3">
          <div className="grid grid-cols-[120px_1fr_90px_100px] gap-3">
            <FieldShell label="Method">
              <select
                {...register("method")}
                className="bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-800 outline-none shadow-sm focus:border-violet-500 focus:ring-1 focus:ring-violet-500/20 transition-all w-full appearance-none cursor-pointer font-semibold"
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
                className="bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-800 placeholder-slate-400 outline-none shadow-sm focus:border-violet-500 focus:ring-1 focus:ring-violet-500/20 transition-all w-full font-mono"
              />
            </FieldShell>
            <FieldShell label="Status" error={errors.status?.message}>
              <input
                {...register("status")}
                placeholder="200"
                className="bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-800 placeholder-slate-400 outline-none shadow-sm focus:border-violet-500 focus:ring-1 focus:ring-violet-500/20 transition-all w-full text-center font-medium"
              />
            </FieldShell>
            <FieldShell label="Delay (ms)" error={errors.delay?.message}>
              <input
                {...register("delay")}
                placeholder="0"
                className="bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-800 placeholder-slate-400 outline-none shadow-sm focus:border-violet-500 focus:ring-1 focus:ring-violet-500/20 transition-all w-full text-center font-medium"
              />
            </FieldShell>
          </div>
          <div className="flex items-center justify-between pt-0.5">
            <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-700 shrink-0 cursor-pointer">
              <span className="relative inline-flex items-center">
                <input
                  type="checkbox"
                  {...register("enabled")}
                  className="sr-only peer"
                />
                <div className="w-7 h-4 bg-slate-200 rounded-full peer peer-checked:after:translate-x-3 peer-checked:bg-violet-600 after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all"></div>
              </span>
              启用 Mock
            </label>
            <PreviewUrl control={control} mockBaseUrl={mockBaseUrl} />
          </div>
        </div>


        <div className="flex-1 min-h-0 flex flex-col overflow-y-auto p-4 gap-4 bg-slate-50/30">
          <RequestSchemaPanel
            schema={requestSchema}
            loading={schemaLoading}
            error={schemaError ? schemaError.message || String(schemaError) : ""}
          />
          <VariantsSection
            control={control}
            register={register}
            errors={errors}
            onVariantCurl={route ? handleVariantCurl : null}
            requestSchema={requestSchema}
          />
          <div className="border border-slate-200/70 rounded-xl bg-white shadow-sm overflow-hidden p-3.5 flex flex-col gap-2.5 shrink-0">
            <div className="flex items-center gap-2 shrink-0">
              <FallbackResponseTitle control={control} />
              {errors.responseText && (
                <div className="text-[11px] text-red-600 font-medium">
                  {errors.responseText.message}
                </div>
              )}
            </div>
            <div className="h-[280px] shrink-0 border border-slate-200/80 rounded-lg overflow-hidden bg-[#fafbfc]">
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
        </div>

        <div className="shrink-0 border-t border-border px-4 py-3 flex items-center justify-between bg-slate-50/60">
          <span className="text-[11px] font-medium text-slate-500">
            {!hasSavedRule ? "未保存" : isDirty ? "有未保存改动" : "已保存"}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            {hasSavedRule && (
              <button
                type="button"
                onClick={onDelete}
                disabled={isSubmitting}
                className="px-3 py-1.5 rounded-lg border text-xs font-semibold bg-red-500/5 text-red-600 border-red-200/40 hover:bg-red-500/10 hover:text-red-700 transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              >
                删除规则
              </button>
            )}
            <PathActions
              control={control}
              route={route}
              onRecommend={() => modalOpenersRef.current?.openRecommend()}
              onCurl={(mode) => modalOpenersRef.current?.openCurl(mode)}
            />
            <div className="w-[1px] h-5 bg-slate-200 mx-1 shrink-0"></div>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-4 py-1.5 rounded-lg text-xs font-bold bg-violet-600 text-white border-violet-600 hover:bg-violet-700 hover:border-violet-700 shadow-sm shadow-violet-500/20 transition-all duration-150 disabled:opacity-50 cursor-pointer"
            >
              {isSubmitting ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      </form>

      <EditorModals
        route={route}
        getValues={getValues}
        setValue={setValue}
        mockBaseUrl={mockBaseUrl}
        backendBaseUrl={backendBaseUrl}
        onViewLogs={handleViewLogs}
        openersRef={modalOpenersRef}
      />
    </>
  );
}

function setDeepValue(obj, path, value) {
  const parts = path.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current)) {
      current[part] = {};
    }
    current = current[part];
  }
  let parsedValue = value;
  try {
    parsedValue = JSON.parse(value);
  } catch {
    // Keep raw string
  }
  current[parts[parts.length - 1]] = parsedValue;
}
