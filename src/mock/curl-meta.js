// curl 调试面板的「响应元信息」协议：状态码 + mock server 回传的 x-mock-* 头。
//
// 用 --write-out 把这些追加到 body 之后、再按分隔符切开，而不是用 -i：
// -i 会把整段响应头混进 body，把面板里「响应结果」区的 JSON 弄脏。
//
// 单独成文件（不放 ipc.js）是为了能被 scripts/ 下的测试直接 import——ipc.js
// 依赖 electron，测试进程里 require 不起来。
//
// %header{} 需要 curl ≥ 7.83（macOS 自带的 8.x 满足）；老版本会把占位符原样
// 吐出来，parseCurlMeta 会丢掉这种值，body 和状态码依旧完整。

export const CURL_META_MARK = "\n__VJ_CURL_META__";

export const CURL_WRITE_OUT = [
  CURL_META_MARK,
  "status=%{http_code}",
  "time=%{time_total}",
  "source=%header{x-mock-source}",
  "rule=%header{x-mock-rule}",
  "variant=%header{x-mock-variant}",
].join("\n");

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** curl 的原始输出 → { output: 纯 body, meta: 元信息|null } */
export function parseCurlMeta(raw) {
  // 用 lastIndexOf：body 里恰好含同样字面量时，元信息永远是最后那段
  const at = raw.lastIndexOf(CURL_META_MARK);
  if (at === -1) return { output: raw, meta: null };

  const fields = {};
  for (const line of raw.slice(at + CURL_META_MARK.length).split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const value = line.slice(eq + 1).trim();
    // 头不存在时 curl 输出空串；含中文的头值在 server 侧做过 encodeURIComponent。
    // curl < 7.83 不认 %header{}，会原样吐出占位符，这种值直接丢掉。
    if (value && !value.startsWith("%header{")) {
      fields[line.slice(0, eq).trim()] = safeDecode(value);
    }
  }

  return {
    output: raw.slice(0, at),
    meta: {
      status: Number(fields.status) || null,
      timeMs: fields.time ? Math.round(Number(fields.time) * 1000) : null,
      source: fields.source || "",
      rule: fields.rule || "",
      variant: fields.variant || "",
    },
  };
}
