import { useState } from "react";
import clsx from "clsx";

/**
 * 接口请求侧 schema 展示：query/path/header 参数 + requestBody 字段。
 * 数据由父组件通过 useMockRequestSchema 拉取后传入（父组件还要拿它给
 * 变体条件下拉用，所以在父层取数、这里只负责渲染）。
 */

const SCOPE_LABEL = { query: "Query", path: "Path", header: "Header", body: "Body" };

const SCOPE_STYLE = {
  query: "text-sky-700 bg-sky-400/10 border-sky-400/35",
  path: "text-amber-700 bg-amber-400/10 border-amber-400/35",
  header: "text-slate-600 bg-card border-border",
  body: "text-violet-700 bg-violet-400/10 border-violet-400/35",
};

export function ScopeTag({ scope }) {
  return (
    <span
      className={clsx(
        "text-[10px] px-1.5 py-0.5 rounded border shrink-0",
        SCOPE_STYLE[scope] || SCOPE_STYLE.header,
      )}
    >
      {SCOPE_LABEL[scope] || scope}
    </span>
  );
}

/** 示例值渲染成一行可读文本（对象/数组转 JSON） */
export function formatExample(value) {
  if (value === undefined) return "";
  if (value === null) return "null";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function SchemaRow({ scope, name, type, required, description, example }) {
  return (
    <div className="flex items-start gap-2 px-3 py-1.5 border-t border-border first:border-t-0">
      <ScopeTag scope={scope} />
      <span className="text-[11px] text-slate-900 font-medium min-w-0 break-all">
        {name}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </span>
      <span className="text-[11px] text-slate-400 shrink-0">{type}</span>
      {description && (
        <span className="text-[11px] text-slate-500 truncate" title={description}>
          {description}
        </span>
      )}
      {example !== undefined && example !== "" && (
        <span
          className="ml-auto text-[11px] text-slate-500 font-mono truncate max-w-[220px] shrink-0"
          title={formatExample(example)}
        >
          {formatExample(example)}
        </span>
      )}
    </div>
  );
}

export default function RequestSchemaPanel({ schema, loading, error }) {
  const [open, setOpen] = useState(false);

  const parameters = schema?.parameters || [];
  const bodyFields = schema?.body?.fields || [];
  const total = parameters.length + bodyFields.length;

  return (
    <div className="border-b border-border">
      <div className="px-4 py-2.5 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-xs font-medium text-slate-600 inline-flex items-center gap-1 cursor-pointer"
        >
          <span className={clsx("inline-block transition-transform", open && "rotate-90")}>
            ▸
          </span>
          请求参数 ({loading ? "…" : total})
        </button>
        <span className="text-[11px] text-slate-400 truncate">
          {error
            ? error
            : total > 0
              ? "来自 swagger 定义；在下方变体的「+ 条件」里可直接选用"
              : loading
                ? "读取中…"
                : "该接口在 swagger 里没有定义请求参数"}
        </span>
      </div>
      {open && total > 0 && (
        <div className="mx-4 mb-3 border border-border rounded-lg overflow-hidden bg-card/50">
          {parameters.map((p) => (
            <SchemaRow
              key={`${p.in}:${p.name}`}
              scope={p.in}
              name={p.name}
              type={p.type}
              required={p.required}
              description={p.description}
              example={p.example}
            />
          ))}
          {bodyFields.map((f) => (
            <SchemaRow
              key={`body:${f.path}`}
              scope="body"
              name={f.path}
              type={f.type}
              example={f.example}
            />
          ))}
        </div>
      )}
    </div>
  );
}
