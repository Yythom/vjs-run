import { useRef, useState } from "react";
import clsx from "../utils/clsx";
import PageShell from "../components/page-shell";
import { showToast } from "../utils/toast";

const SOURCES = [
  { key: "url", label: "JSON 地址" },
  { key: "file", label: "本地文件" },
];

// 结果可能有几 MB，全量塞进 textarea 会卡渲染，超过阈值只预览开头
const PREVIEW_LIMIT = 200_000;

export default function SwaggerConvertPage() {
  const [source, setSource] = useState("url");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState(null); // { name, text }
  const [converting, setConverting] = useState(false);
  const [result, setResult] = useState(null); // { json, stats }
  const [error, setError] = useState("");
  const fileInputRef = useRef(null);

  const reset = () => {
    setResult(null);
    setError("");
  };

  const switchSource = (key) => {
    setSource(key);
    reset();
  };

  const readFile = async (picked) => {
    if (!picked) return;
    try {
      const text = await picked.text();
      setFile({ name: picked.name, text });
      reset();
    } catch (err) {
      showToast(`读取文件失败: ${err.message}`, "error");
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    const picked = e.dataTransfer.files?.[0];
    if (picked) {
      setSource("file");
      readFile(picked);
    }
  };

  const convert = async () => {
    const payload = source === "url" ? url.trim() : file?.text;
    if (!payload) {
      showToast(source === "url" ? "请填写 JSON 地址" : "请先选择文件", "warning");
      return;
    }

    setConverting(true);
    setError("");
    try {
      const res = await window.electronAPI.convertSwaggerSpec(
        source === "url" ? "url" : "text",
        payload,
      );
      if (!res.success) throw new Error(res.error);
      setResult({ json: res.json, stats: res.stats });
      showToast("转换完成", "success");
    } catch (err) {
      setResult(null);
      setError(err.message);
    } finally {
      setConverting(false);
    }
  };

  const copyResult = async () => {
    try {
      await navigator.clipboard.writeText(result.json);
      showToast("结果已复制到剪贴板", "success");
    } catch (err) {
      showToast(`复制失败: ${err.message}`, "error");
    }
  };

  const saveResult = async () => {
    // 地址形如 http://host/vjg/v2/api-docs 时用倒数第三段（服务名）做默认文件名
    const fallback =
      source === "file"
        ? file.name.replace(/\.json$/i, "")
        : url.split("/").filter(Boolean).at(-3) || "openapi";
    try {
      const res = await window.electronAPI.saveSwaggerSpec(
        result.json,
        `${fallback}.json`,
      );
      if (!res.success) throw new Error(res.error);
      if (res.canceled) return;
      showToast(`已保存到 ${res.filePath}`, "success");
    } catch (err) {
      showToast(`保存失败: ${err.message}`, "error");
    }
  };

  const stats = result?.stats;
  const truncated = result && result.json.length > PREVIEW_LIMIT;

  return (
    <PageShell
      title="OpenAPI 转换"
      subtitle="把单份 Swagger / OpenAPI 文档转成 Mock 用的 OpenAPI 3 JSON"
      actions={
        <button
          type="button"
          onClick={convert}
          disabled={converting}
          className={clsx(
            "px-3 py-1.5 rounded-md border text-xs font-medium transition-all",
            converting
              ? "bg-slate-100 text-slate-400 border-border cursor-not-allowed"
              : "bg-white text-slate-600 border-border hover:bg-slate-50 hover:text-slate-900 cursor-pointer",
          )}
        >
          {converting ? "⏳ 转换中…" : "⚡ 开始转换"}
        </button>
      }
    >
      <div className="flex flex-col gap-4" onDragOver={(e) => e.preventDefault()} onDrop={handleDrop}>
        {/* 输入源切换 */}
        <div className="flex items-center gap-1 p-1 bg-slate-50 border border-border rounded-lg w-fit">
          {SOURCES.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => switchSource(item.key)}
              className={clsx(
                "px-3 py-1.5 rounded-md text-xs font-semibold cursor-pointer transition-all",
                source === item.key
                  ? "bg-white text-blue-600 border border-blue-500/20 shadow-[0_1px_2px_rgba(0,0,0,0.03)]"
                  : "text-slate-500 border border-transparent hover:text-slate-900",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        {/* 输入 */}
        {source === "url" ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] text-slate-500 font-semibold uppercase tracking-wide">
              JSON 地址
            </span>
            <input
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                reset();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") convert();
              }}
              spellCheck={false}
              placeholder="http://your-server/vjg/v2/api-docs"
              className="w-full bg-white border border-border rounded-md px-3 py-2 text-xs font-mono text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500 transition-colors"
            />
            <span className="text-[10.5px] text-slate-400">
              直接填完整的文档地址（swagger 2.0 会自动转成 OpenAPI 3）
            </span>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] text-slate-500 font-semibold uppercase tracking-wide">
              本地文件
            </span>
            <div
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 px-3 py-4 rounded-md border border-dashed border-border bg-slate-50/60 cursor-pointer hover:border-slate-400 hover:bg-slate-50 transition-colors"
            >
              <span className="text-sm">📄</span>
              <span className="flex-1 text-xs text-slate-600 truncate">
                {file ? file.name : "点击选择 .json 文件，或直接把文件拖到这里"}
              </span>
              {file && (
                <span className="text-[10.5px] text-slate-400 shrink-0">
                  {(file.text.length / 1024).toFixed(1)} KB
                </span>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                readFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>
        )}

        {/* 结果 */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="flex-1 text-[11px] text-slate-500 font-semibold uppercase tracking-wide">
              结果
            </span>
            {result && (
              <>
                <button
                  type="button"
                  onClick={copyResult}
                  className="text-[10px] px-2 py-1 rounded border cursor-pointer text-slate-500 border-border bg-slate-50 hover:bg-slate-100 hover:text-slate-900 transition-colors"
                >
                  复制
                </button>
                <button
                  type="button"
                  onClick={saveResult}
                  className="text-[10px] px-2 py-1 rounded border cursor-pointer text-slate-500 border-border bg-slate-50 hover:bg-slate-100 hover:text-slate-900 transition-colors"
                >
                  另存为…
                </button>
              </>
            )}
          </div>

          {stats && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 rounded-md border border-border bg-slate-50 text-[11px] text-slate-600">
              {stats.title && <span className="font-semibold text-slate-800">{stats.title}</span>}
              {stats.version && <span>版本 {stats.version}</span>}
              <span>OpenAPI {stats.openapi || "3"}</span>
              <span>接口 {stats.pathCount} 个</span>
              <span>方法 {stats.operationCount} 个</span>
              <span>Schema {stats.schemaCount} 个</span>
              {stats.excludedPaths > 0 && (
                <span className="text-amber-600">已剔除 {stats.excludedPaths} 个黑名单接口</span>
              )}
              {stats.converted && <span className="text-blue-600">swagger 2.0 已转换</span>}
            </div>
          )}

          {error ? (
            <div className="px-3 py-2 rounded-md border border-red-400/30 bg-red-400/10 text-xs text-red-700 break-all">
              转换失败：{error}
            </div>
          ) : (
            <>
              <textarea
                readOnly
                spellCheck={false}
                value={
                  result
                    ? truncated
                      ? result.json.slice(0, PREVIEW_LIMIT)
                      : result.json
                    : ""
                }
                placeholder="暂无结果"
                className="w-full h-80 resize-y bg-slate-50 border border-border rounded-md px-3 py-2 text-xs font-mono text-slate-800 placeholder-slate-400 outline-none"
              />
              {truncated && (
                <span className="text-[10.5px] text-amber-600">
                  结果较大（{(result.json.length / 1024).toFixed(0)} KB），此处仅预览前
                  200 KB，复制与另存为仍是完整内容
                </span>
              )}
            </>
          )}
        </div>
      </div>
    </PageShell>
  );
}
