import { useState } from "react";
import clsx from "../../utils/clsx";
import AnnotatedJson, { CopyJsonButton } from "./annotated-json";

/**
 * 接口请求侧 schema 展示：query/path/header 参数列表 + requestBody（JSON 视图，字段行尾以注释形式展示 description）。
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
        "text-[10px] px-1.5 py-0.5 rounded border shrink-0 font-medium",
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

function renderNestedPath(name) {
  const parts = String(name).split(".");
  if (parts.length === 1) return name;
  const leaf = parts.pop();
  const parent = parts.join(".") + ".";
  return (
    <span className="font-mono">
      <span className="text-slate-400 font-normal">{parent}</span>
      <span className="text-slate-800 font-bold">{leaf}</span>
    </span>
  );
}

function SchemaRow({ name, type, required, description, example }) {
  return (
    <div
      className="group flex items-center gap-2 px-3.5 py-1.5 border-t border-slate-100/70 hover:bg-slate-50/80 transition-colors duration-150 cursor-default"
      title="此字段可在下方变体的「+ 条件」中一键选用"
    >
      <span className="text-[11.5px] text-slate-800 font-semibold min-w-0 break-all pl-1">
        {renderNestedPath(name)}
        {required && <span className="text-red-500 ml-0.5 font-bold">*</span>}
      </span>
      <span className="text-[10px] text-slate-400 font-mono font-medium shrink-0 bg-slate-100 px-1.5 py-0.5 rounded">
        {type}
      </span>
      {description && (
        <span className="text-[11px] text-slate-500 truncate pl-1 font-normal max-w-[280px]" title={description}>
          {description}
        </span>
      )}
      {example !== undefined && example !== "" && (
        <span
          className="ml-auto text-[11px] text-slate-500 font-mono truncate max-w-[240px] shrink-0 bg-slate-50 border border-slate-100 px-1.5 py-0.5 rounded flex items-center"
          title={formatExample(example)}
        >
          <span className="text-[9.5px] text-slate-400 font-sans font-semibold mr-1 leading-none">例</span>
          <span className="leading-none">{formatExample(example)}</span>
        </span>
      )}
    </div>
  );
}

function GroupHeader({ title, count, scope }) {
  return (
    <div className="px-3.5 py-1.5 bg-slate-100/70 border-t border-slate-200/80 first:border-t-0 flex items-center justify-between text-[11px] font-bold text-slate-700 select-none">
      <div className="flex items-center gap-2">
        <ScopeTag scope={scope} />
        <span>{title}</span>
      </div>
      <span className="text-[10px] font-semibold text-slate-400">({count})</span>
    </div>
  );
}

function BodySection({ body }) {
  if (!body?.sample) return null;

  const rawJsonText = JSON.stringify(body.sample, null, 2);

  return (
    <div className="flex flex-col border-t border-slate-200/80">
      <div className="px-3.5 py-1.5 bg-slate-100/70 flex items-center justify-between text-[11px] font-bold text-slate-700 select-none">
        <div className="flex items-center gap-2">
          <ScopeTag scope="body" />
          <span>Body 请求体</span>
          <span className="text-[10px] text-slate-400 font-mono font-normal">
            ({body.contentType || "application/json"})
          </span>
        </div>

        <CopyJsonButton text={rawJsonText} />
      </div>

      <AnnotatedJson
        sample={body.sample}
        descriptions={body.descriptions}
        fields={body.fields}
        className="p-3 bg-slate-900 overflow-x-auto max-h-[260px]"
      />
    </div>
  );
}

export default function RequestSchemaPanel({ schema, loading, error }) {
  const [open, setOpen] = useState(true);

  const parameters = schema?.parameters || [];
  const bodyFields = schema?.body?.fields || [];
  const hasBody = Boolean(schema?.body?.sample || bodyFields.length > 0);
  const total = parameters.length + (bodyFields.length || (hasBody ? 1 : 0));

  const queryParams = parameters.filter((p) => p.in === "query");
  const pathParams = parameters.filter((p) => p.in === "path");
  const headerParams = parameters.filter((p) => p.in === "header");

  const paramGroups = [
    { title: "Query 参数", scope: "query", items: queryParams.map((p) => ({ ...p, key: `query:${p.name}` })) },
    { title: "Path 参数", scope: "path", items: pathParams.map((p) => ({ ...p, key: `path:${p.name}` })) },
    { title: "Header 参数", scope: "header", items: headerParams.map((p) => ({ ...p, key: `header:${p.name}` })) },
  ].filter((g) => g.items.length > 0);

  return (
    <div className="border border-slate-200/70 rounded-xl bg-white shadow-sm shrink-0 overflow-hidden">
      <div className="px-4 py-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-xs font-bold text-slate-700 inline-flex items-center gap-1.5 cursor-pointer hover:text-slate-900 transition-colors outline-none"
        >
          <span className={clsx("inline-block transition-transform duration-200 font-normal", open && "rotate-90")}>
            ▸
          </span>
          请求参数 ({loading ? "…" : total})
        </button>
        <span className="text-[10.5px] text-slate-400 font-medium truncate">
          {error
            ? error
            : total > 0
              ? "来自 Swagger 定义；Query/Path/Header 按列表呈现，Body 为 JSON 视图并以注释标注字段描述"
              : loading
                ? "读取中…"
                : "该接口在 Swagger 中未定义请求参数"}
        </span>
      </div>
      {open && (total > 0 || hasBody) && (
        <div className="border-t border-slate-100 bg-white">
          {paramGroups.map((group) => (
            <div key={group.scope} className="flex flex-col">
              <GroupHeader title={group.title} count={group.items.length} scope={group.scope} />
              {group.items.map((item) => (
                <SchemaRow
                  key={item.key}
                  name={item.name}
                  type={item.type}
                  required={item.required}
                  description={item.description}
                  example={item.example}
                />
              ))}
            </div>
          ))}
          {schema?.body?.sample && <BodySection body={schema.body} />}
        </div>
      )}
    </div>
  );
}
