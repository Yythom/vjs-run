import { useState } from "react";
import parseCurl from "parse-curl";
import Modal from "../../components/modal";
import JsonEditor from "../../components/json-editor";
import useResource from "../../hooks/use-resource";
import { showToast } from "../../utils/toast";
import { useAppConfig, updateAppConfig } from "../../stores/app-config-store";

function parseQueryParams(text) {
  const params = JSON.parse(text || "{}");
  if (!params || Array.isArray(params) || typeof params !== "object") {
    throw new Error("Query Params 必须是 JSON 对象");
  }
  return params;
}

function parseCurlText(curlText) {
  if (!curlText || !curlText.trim()) {
    throw new Error("请输入或粘贴 cURL 文本");
  }

  // 预处理 cURL：处理多行续行符 `\`，以及归一化各种 --data-* 参数
  const cleaned = curlText
    .trim()
    .replace(/\\\r?\n/g, " ")
    .replace(/--data-raw/g, "-d")
    .replace(/--data-binary/g, "-d")
    .replace(/--data-urlencode/g, "-d");

  const parsed = parseCurl(cleaned);
  if (!parsed || (!parsed.url && !parsed.header && !parsed.body)) {
    throw new Error("无法解析该 cURL 命令，请确认格式是否正确");
  }

  let method = parsed.method ? parsed.method.toUpperCase() : "GET";
  let queryParams = {};

  if (parsed.url) {
    try {
      const urlObj = new URL(parsed.url);
      urlObj.searchParams.forEach((val, key) => {
        queryParams[key] = val;
      });
    } catch {
      // Fallback
    }
  }

  let parsedBody = null;
  if (parsed.body) {
    try {
      parsedBody = JSON.stringify(JSON.parse(parsed.body), null, 2);
    } catch {
      parsedBody = parsed.body;
    }
  }

  let vjToken = null;
  if (parsed.header) {
    for (const [k, v] of Object.entries(parsed.header)) {
      if (k.toLowerCase() === "authorization" && v) {
        vjToken = v;
      } else if (k.toLowerCase() === "cookie" && v) {
        const match = String(v).match(/VJTOKEN=([^;]+)/);
        if (match) vjToken = match[1];
      }
    }
  }

  return {
    method,
    params: Object.keys(queryParams).length > 0 ? JSON.stringify(queryParams, null, 2) : null,
    body: parsedBody,
    vjToken,
  };
}

function buildRequestUrl(baseUrl, path, params) {
  const base = String(baseUrl || "")
    .trim()
    .replace(/\/+$/, "");
  if (!base) throw new Error("未配置请求地址，请先在服务配置中填写");
  const url = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(params)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined && item !== null)
        url.searchParams.append(key, String(item));
    }
  }
  return url.toString();
}

function buildCurlCommand({
  baseUrl,
  method,
  path,
  params,
  body,
  vjToken,
}) {
  const url = buildRequestUrl(baseUrl, path, params);
  const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  const args = ["curl --silent --show-error", "-X", method, quote(url)];
  if (body)
    args.push(
      "-H",
      quote("Content-Type: application/json"),
      "--data-binary",
      quote(body),
    );
  if (vjToken) {
    args.push("-H", quote(`Authorization: ${vjToken}`));
    args.push("-H", quote(`Cookie: VJTOKEN=${vjToken}`));
  }
  return args.join(" ");
}

function buildFetchCommand({
  baseUrl,
  method,
  path,
  params,
  body,
  vjToken,
}) {
  const options = { method };
  const headers = {};
  if (body) {
    headers["Content-Type"] = "application/json";
    options.body = body;
  }
  if (vjToken) {
    headers["Authorization"] = vjToken;
    headers["Cookie"] = `VJTOKEN=${vjToken}`;
  }
  if (Object.keys(headers).length > 0) {
    options.headers = headers;
  }
  return `fetch(${JSON.stringify(buildRequestUrl(baseUrl, path, params))}, ${JSON.stringify(options, null, 2)})\n  .then((response) => response.json())\n  .then(console.log)\n  .catch(console.error);`;
}

// 支持携带请求 body 的方法
const BODY_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

/**
 * 「schema 生成的默认值」+「用户的编辑」合成一个受控值：
 * 生成值变化（切了接口 / 推荐数据到货）时丢弃旧的编辑内容。
 */
function useEditableValue(generated) {
  const [edited, setEdited] = useState(null);
  const [lastGenerated, setLastGenerated] = useState(generated);
  if (lastGenerated !== generated) {
    setLastGenerated(generated);
    setEdited(null);
  }
  return [edited ?? generated, setEdited];
}

/** initialXxx 允许传对象或字符串，统一成编辑器要的 JSON 文本 */
function toEditorText(value, fallback) {
  if (!value) return fallback;
  return typeof value === "object" ? JSON.stringify(value, null, 2) : value;
}

// mode: "backend" 打后端代理地址；"local" 打本机已启动的 mock 服务
const MODE_CONFIG = {
  backend: {
    title: "后端 curl 调试",
    execApi: (payload) => window.electronAPI.executeMockBackendCurl(payload),
  },
  local: {
    title: "本地服务请求调试",
    execApi: (payload) => window.electronAPI.executeMockLocalCurl(payload),
  },
};

// x-mock-source 的取值 → 人话。file:xxx / 未知值走兜底分支。
const SOURCE_LABEL = {
  proxy: "回源后端（没有命中任何 mock 规则）",
  "rule-variant": "命中规则变体",
  "rule-custom": "命中自定义规则",
  "rule-response": "命中规则的兜底 response",
  "rule-control": "命中规则（只改了 status/delay）",
  "openapi-sample": "swagger schema 自动生成",
};

function describeSource(source) {
  if (!source) return "";
  if (SOURCE_LABEL[source]) return SOURCE_LABEL[source];
  if (source.startsWith("file:")) return `mock-data 文件：${source.slice(5)}`;
  return source;
}

/** 执行结果上方的一行元信息：状态码 / 命中来源 / 变体名 / 耗时 */
function ResultMetaStrip({ meta }) {
  const ok = meta.status >= 200 && meta.status < 400;
  const isProxy = meta.source === "proxy";
  return (
    <div className="flex items-center gap-2 flex-wrap text-[11px]">
      {meta.status && (
        <span
          className={`font-mono font-bold px-1.5 py-0.5 rounded border ${
            ok
              ? "text-emerald-700 bg-emerald-50 border-emerald-200"
              : "text-red-700 bg-red-50 border-red-200"
          }`}
        >
          HTTP {meta.status}
        </span>
      )}
      {meta.source && (
        <span
          className={`px-1.5 py-0.5 rounded border font-medium ${
            isProxy
              ? "text-amber-700 bg-amber-50 border-amber-200"
              : "text-violet-700 bg-violet-50 border-violet-200"
          }`}
        >
          {describeSource(meta.source)}
        </span>
      )}
      {meta.variant && (
        <span className="px-1.5 py-0.5 rounded border border-violet-200 bg-violet-50/60 text-violet-700 font-medium">
          变体：{meta.variant}
        </span>
      )}
      {meta.rule && (
        <span
          className="text-slate-400 font-mono truncate max-w-[240px]"
          title={meta.rule}
        >
          {meta.rule}
        </span>
      )}
      {meta.timeMs !== null && (
        <span className="text-slate-400 ml-auto">{meta.timeMs}ms</span>
      )}
    </div>
  );
}

export default function BackendCurlModal({
  open,
  mode = "backend",
  method,
  path,
  baseUrl,
  onClose,
  onViewLogs,
  initialParams,
  initialBody,
}) {
  const config = useAppConfig();
  const vjToken = config.mockVjToken || "";
  const modeConfig = MODE_CONFIG[mode] || MODE_CONFIG.backend;

  const handleViewLogs = () => {
    if (onViewLogs) {
      onViewLogs();
    } else if (window.electronAPI?.openWindow) {
      window.electronAPI.openWindow("/mock-service");
    }
  };

  const requestMethod = String(method || "GET").toUpperCase();

  // 推荐数据只是「预填」，不是发请求的前提：spec 外的自定义路径查不到 schema，
  // 这里降级成空 body / 空 params 并给个提示，而不是把整个面板置成错误态。
  const { data, loading } = useResource(async () => {
    // If initial params are provided, we don't need to load recommendations
    if (initialParams || initialBody) return null;
    // 用「请求侧」schema 预填：body 取 requestBody 采样，params 取 in=query 的参数示例。
    // 不要用 previewMockResponse——那生成的是响应体（还套了 code/rc/data 信封）。
    const result = await window.electronAPI.getMockRequestSchema({
      method: requestMethod,
      path,
    });
    if (!result?.success) {
      return {
        body: "",
        params: "{}",
        warning: result?.error || "推荐数据生成失败",
      };
    }
    const queryParams = (result.parameters || []).reduce((acc, parameter) => {
      if (parameter.in === "query" && parameter.example !== undefined) {
        acc[parameter.name] = parameter.example;
      }
      return acc;
    }, {});
    return {
      body: result.body?.sample ? JSON.stringify(result.body.sample, null, 2) : "",
      params: JSON.stringify(queryParams, null, 2),
    };
  }, [requestMethod, path, initialParams, initialBody]);
  const recommendWarning = data?.warning || "";

  const generatedBody = toEditorText(initialBody, data?.body || "");
  const generatedParams = toEditorText(initialParams, data?.params || "{}");
  const [body, setEditedBody] = useEditableValue(generatedBody);
  const [paramsTextValue, setParamsText] = useEditableValue(generatedParams);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [resultText, setResultText] = useState("");
  // { status, timeMs, source, rule, variant }：mock server 通过 x-mock-* 响应头回传
  const [resultMeta, setResultMeta] = useState(null);
  // 白名单：只有这几种方法才展示并发送请求 body，
  // GET/HEAD/OPTIONS/TRACE 一律不带（避免给不支持 body 的方法塞 payload）
  const hasRequestBody = BODY_METHODS.includes(requestMethod);

  const handleImportCurlText = (curlText) => {
    try {
      const result = parseCurlText(curlText);
      if (result.params) setParamsText(result.params);
      if (result.body && hasRequestBody) setEditedBody(result.body);
      if (result.vjToken) updateAppConfig({ mockVjToken: result.vjToken });
      showToast("cURL 解析成功，已自动提取参数并填充", "success");
      return true;
    } catch (err) {
      showToast(err.message || "cURL 解析失败", "warning");
      return false;
    }
  };

  /**
   * 校验两个编辑器的内容并汇总成一次请求的入参。
   * 校验失败时抛出「人话」错误，由调用方决定是 toast 还是显示在预览区。
   */
  const buildRequestArgs = () => {
    let params;
    try {
      params = parseQueryParams(paramsTextValue);
    } catch (err) {
      throw new Error(`Query Params 格式错误: ${err.message}`);
    }
    // swagger 没定义 requestBody 时 body 是空串，此时按「不带 body」发，不做 JSON 校验
    const requestBody = hasRequestBody ? body.trim() : "";
    if (requestBody) {
      try {
        JSON.parse(requestBody);
      } catch (err) {
        throw new Error(`请求 JSON 格式错误: ${err.message}`);
      }
    }
    return {
      baseUrl,
      method: requestMethod,
      path,
      params,
      body: requestBody,
      vjToken,
    };
  };

  const execute = async () => {
    let args;
    try {
      args = buildRequestArgs();
    } catch (err) {
      showToast(err.message, "warning");
      return;
    }
    setExecuting(true);
    setResultText("");
    setResultMeta(null);
    try {
      const result = await modeConfig.execApi({
        method: requestMethod,
        path,
        params: args.params,
        body: args.body,
      });
      if (!result?.success) throw new Error(result?.error || "curl 执行失败");
      setResultText(result.output || "curl 已完成（无输出）");
      setResultMeta(result.meta || null);
      showToast("后端请求已执行，详情已写入 Mock 日志", "success");
    } catch (err) {
      const message = err?.message || String(err);
      setResultText(message);
      showToast(`请求失败: ${message}`, "error");
    } finally {
      setExecuting(false);
    }
  };

  const copyAs = (label, build) => async () => {
    try {
      await navigator.clipboard.writeText(build(buildRequestArgs()));
      showToast(`当前 ${label} 命令已复制`, "success");
    } catch (err) {
      showToast(`无法复制 ${label}: ${err.message || String(err)}`, "warning");
    }
  };
  const copyCurl = copyAs("curl", buildCurlCommand);
  const copyFetch = copyAs("fetch", buildFetchCommand);

  const getActualUrl = () => {
    try {
      const parsedParams = parseQueryParams(paramsTextValue);
      return buildRequestUrl(baseUrl, path, parsedParams);
    } catch (err) {
      return err.message || "Query Params JSON 格式不正确，无法生成完整 URL";
    }
  };
  const actualUrl = getActualUrl();
  const urlOk = /^https?:\/\//.test(actualUrl);

  const getPreviewCurlCommand = () => {
    try {
      return buildCurlCommand(buildRequestArgs());
    } catch (err) {
      return `无法生成命令: ${err.message || String(err)}`;
    }
  };
  const previewCurlCommand = getPreviewCurlCommand();

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={modeConfig.title}
      srOnly={false}
      className="w-[760px] max-w-[92vw] max-h-[84vh]"
    >
      <div className="px-5 py-2.5 border-b border-border bg-slate-50/40 flex flex-col gap-1 shrink-0">
        <div className="text-[11px] text-slate-500 truncate">
          请求路径:{" "}
          <span className="font-semibold text-slate-700">
            {requestMethod} {path}
          </span>
        </div>
        <div className="text-[11px] text-slate-500 truncate flex items-center gap-1.5">
          <span>实际请求链接:</span>
          <span
            className={`font-mono px-1.5 py-0.5 rounded border select-all ${
              urlOk
                ? "text-blue-600 bg-blue-50/50 border-blue-100"
                : "text-red-600 bg-red-50/50 border-red-100"
            }`}
            title={urlOk ? "双击选择全部链接" : actualUrl}
          >
            {actualUrl}
          </span>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
        {recommendWarning && (
          <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5">
            未能生成推荐数据（{recommendWarning}），请手动填写请求参数后执行。
          </div>
        )}
        {/* token 是全局配置，不依赖推荐数据，loading 期间也保持可编辑 */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-semibold text-slate-700">
            全局 VJTOKEN 参数{" "}
            <span className="text-slate-400 font-normal">
              (用于后端调试接口登录鉴权)
            </span>
          </label>
          <input
            type="text"
            value={vjToken}
            onChange={(e) => updateAppConfig({ mockVjToken: e.target.value })}
            placeholder="请输入 VJTOKEN（如未登录或无需鉴权可留空）"
            className="w-full bg-card border border-border rounded-md px-3 py-2 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500 transition-colors font-mono"
          />
        </div>

        {loading ? (
          <div className="text-xs text-slate-500 border border-dashed border-border rounded-lg px-3 py-6 text-center">
            正在根据接口 schema 生成推荐参数…
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-1.5 text-xs text-slate-600">
              <span>
                Query Params JSON（所有请求方法均支持，支持 Alt + Shift + F
                格式化）
              </span>
              <JsonEditor
                value={paramsTextValue}
                onChange={setParamsText}
                height="80px"
                resizable={true}
                placeholder={'{\n  "page": 1\n}'}
                className="border border-border rounded-lg overflow-hidden bg-[#fafbfc]"
              />
            </div>
            {hasRequestBody ? (
              <div className="flex flex-col gap-1.5 text-xs text-slate-600">
                <span>
                  请求 JSON
                  {generatedBody
                    ? "（默认根据当前接口的 requestBody schema 生成，可编辑）"
                    : "（该接口未定义 requestBody，可手动填写或留空）"}
                </span>
                <JsonEditor
                  value={body}
                  onChange={setEditedBody}
                  height="220px"
                  resizable={true}
                  placeholder={'{\n  "name": "test"\n}'}
                  className="border border-border rounded-lg overflow-hidden bg-[#fafbfc]"
                />
              </div>
            ) : (
              <div className="text-xs text-slate-500">
                {requestMethod} 请求不携带 body；可在上方配置 Query Params。
              </div>
            )}
          </>
        )}

        <div className="flex flex-col gap-1.5 mt-2">
          <div className="text-xs font-semibold text-slate-700">
            发送的 Curl 命令预览
          </div>
          <pre className="p-3 bg-slate-900 border border-slate-800 rounded-lg overflow-y-auto max-h-32 font-mono text-[10.5px] text-slate-300 select-all leading-relaxed whitespace-pre-wrap break-all shadow-inner">
            {previewCurlCommand}
          </pre>
        </div>

        {/* 结果固定在最下方：执行后内容区自动停在这里，不用回头找 */}
        {(executing || resultText) && (
          <div className="flex flex-col gap-1.5 mt-2">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold text-slate-700">
                请求响应结果
              </div>
              {resultText && (
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(resultText);
                      showToast("响应结果已复制", "success");
                    } catch (err) {
                      showToast(
                        `无法复制结果: ${err.message || String(err)}`,
                        "warning",
                      );
                    }
                  }}
                  className="px-2.5 py-0.5 rounded border border-border text-[11px] font-medium bg-card text-slate-600 hover:bg-hover hover:text-slate-900 transition-colors"
                >
                  一键复制
                </button>
              )}
            </div>
            {resultMeta && <ResultMetaStrip meta={resultMeta} />}
            <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-slate-900 border border-slate-800 p-3.5 font-mono text-[10.5px] text-emerald-400 shadow-inner">
              {executing ? "请求执行中…" : resultText}
            </pre>
          </div>
        )}
      </div>
      <div className="shrink-0 border-t border-border px-5 py-3 flex items-center gap-2">
        <button
          type="button"
          onClick={handleViewLogs}
          className="px-3 py-1.5 rounded-md border text-xs font-medium bg-card text-slate-600 border-border hover:bg-hover hover:text-slate-900"
        >
          查看日志
        </button>

        <div className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={() => setImportModalOpen(true)}
            disabled={loading}
            className="px-3 py-1.5 rounded-md border text-xs font-medium bg-card text-slate-600 border-border hover:bg-hover hover:text-slate-900 disabled:opacity-40"
          >
            解析 cURL
          </button>
          <button
            type="button"
            onClick={copyCurl}
            disabled={loading}
            className="px-3 py-1.5 rounded-md border text-xs font-medium bg-card text-slate-600 border-border hover:bg-hover hover:text-slate-900 disabled:opacity-40"
          >
            复制 curl
          </button>
          <button
            type="button"
            onClick={copyFetch}
            disabled={loading}
            className="px-3 py-1.5 rounded-md border text-xs font-medium bg-card text-slate-600 border-border hover:bg-hover hover:text-slate-900 disabled:opacity-40"
          >
            复制 fetch
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md border text-xs font-medium bg-card text-slate-600 border-border hover:bg-hover hover:text-slate-900"
          >
            关闭
          </button>
          <button
            type="button"
            onClick={execute}
            disabled={loading || executing}
            className="px-3 py-1.5 rounded-md border text-xs font-medium bg-sky-400/10 text-sky-700 border-sky-400/35 hover:bg-sky-400/20 disabled:opacity-40"
          >
            {executing ? "执行中…" : "执行 curl"}
          </button>
        </div>
      </div>

      <ImportCurlModal
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onImport={handleImportCurlText}
      />
    </Modal>
  );
}

function ImportCurlModal({ open, onClose, onImport }) {
  const [curlText, setCurlText] = useState("");

  const handleConfirm = () => {
    if (!curlText.trim()) {
      showToast("请输入或粘贴 cURL 命令", "warning");
      return;
    }
    const success = onImport(curlText);
    if (success) {
      setCurlText("");
      onClose();
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="解析并导入 cURL 命令"
      className="w-[640px] max-w-[92vw]"
    >
      <div className="p-4 space-y-3">
        <div className="text-xs text-slate-600 font-medium">
          请在下方粘贴 cURL 命令，系统将自动解析 Query 参数、Body 请求体及 Authorization Token 并填充到调试面板：
        </div>
        <textarea
          value={curlText}
          onChange={(e) => setCurlText(e.target.value)}
          placeholder="如: curl 'https://api.com/path?page=1' -H 'Authorization: Bearer xyz' -d '{\&quot;name\&quot;:\&quot;test\&quot;}'"
          rows={7}
          className="w-full bg-slate-900 text-slate-200 border border-slate-700 rounded-lg p-3 text-xs font-mono outline-none focus:border-slate-500 shadow-inner resize-none leading-relaxed"
        />
      </div>
      <div className="border-t border-border px-5 py-3 flex items-center justify-end gap-2 shrink-0">
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 rounded-md border text-xs font-medium bg-card text-slate-600 border-border hover:bg-hover hover:text-slate-900"
        >
          取消
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          className="px-3 py-1.5 bg-slate-800 text-white rounded-md text-xs font-medium hover:bg-slate-700 transition-colors shadow-sm cursor-pointer"
        >
          确认解析并填充
        </button>
      </div>
    </Modal>
  );
}
