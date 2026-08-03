import { useState } from "react";

/**
 * 带行内注释的 JSON 视图：请求 Body 和响应示例共用。
 * 每行 { text, type, comment }：text 是标准 JSON 片段，type 由示例值推导，
 * comment 是该字段的 description（若有）。
 */

function inferType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `array<${value.length ? inferType(value[0]) : "any"}>`;
  }
  return typeof value;
}

/** 数组内对象的字段描述沿用 `path.0.field` 的约定查找。 */
export function buildAnnotatedLines(
  value,
  descriptions,
  fieldsMap,
  path = "",
  key = null,
  indent = 0,
  trailingComma = false,
) {
  const pad = "  ".repeat(indent);
  const keyPrefix = key !== null ? `${JSON.stringify(key)}: ` : "";
  const comma = trailingComma ? "," : "";
  // 数组元素统一按 `.0` 路径查描述（描述表只对首个元素建索引）
  const lookupPath = path ? path.replace(/(^|\.)\d+(?=\.|$)/g, "$10") : "";
  const desc = lookupPath ? descriptions[lookupPath] || fieldsMap.get(lookupPath) || "" : "";

  // 只有具名字段（有 key）才标类型，数组元素/收尾括号行不标，避免噪音
  const type = key !== null ? inferType(value) : "";

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [{ text: `${pad}${keyPrefix}[]${comma}`, type, comment: desc }];
    }
    const lines = [{ text: `${pad}${keyPrefix}[`, type, comment: desc }];
    value.forEach((item, idx) => {
      lines.push(
        ...buildAnnotatedLines(
          item,
          descriptions,
          fieldsMap,
          path ? `${path}.${idx}` : String(idx),
          null,
          indent + 1,
          idx < value.length - 1,
        ),
      );
    });
    lines.push({ text: `${pad}]${comma}`, comment: "" });
    return lines;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return [{ text: `${pad}${keyPrefix}{}${comma}`, type, comment: desc }];
    }
    const lines = [{ text: `${pad}${keyPrefix}{`, type, comment: desc }];
    entries.forEach(([k, v], idx) => {
      lines.push(
        ...buildAnnotatedLines(
          v,
          descriptions,
          fieldsMap,
          path ? `${path}.${k}` : k,
          k,
          indent + 1,
          idx < entries.length - 1,
        ),
      );
    });
    lines.push({ text: `${pad}}${comma}`, comment: "" });
    return lines;
  }

  return [{ text: `${pad}${keyPrefix}${JSON.stringify(value)}${comma}`, type, comment: desc }];
}

/** copied 提示只影响按钮自身，state 收在这里，点复制不重画整个 JSON 块 */
export function CopyJsonButton({ text }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      className="text-[10.5px] text-slate-500 hover:text-slate-800 font-semibold px-2 py-0.5 rounded border border-slate-200 bg-white hover:bg-slate-50 transition-colors cursor-pointer"
    >
      {copied ? "✓ 已复制" : "复制 JSON"}
    </button>
  );
}

/** sample + descriptions/fields → 深色代码块 */
export default function AnnotatedJson({ sample, descriptions, fields, className }) {
  const fieldsMap = new Map((fields || []).map((f) => [f.path, f.description]));
  const lines = buildAnnotatedLines(sample, descriptions || {}, fieldsMap);

  return (
    <div className={className || "p-3 bg-slate-900 overflow-auto h-full"}>
      <pre className="font-mono text-[11.5px] leading-relaxed text-slate-100 whitespace-pre">
        {lines.map((line, idx) => (
          <div key={idx}>
            {line.text}
            {(line.type || line.comment) && (
              <span className="text-emerald-400/70">
                {"  // "}
                {line.type && <span className="text-sky-400/80">{line.type}</span>}
                {line.type && line.comment && " "}
                {line.comment}
              </span>
            )}
          </div>
        ))}
      </pre>
    </div>
  );
}
