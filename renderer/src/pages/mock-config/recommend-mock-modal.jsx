import { useState } from "react";
import Modal from "../../components/modal";
import JsonEditor from "../../components/json-editor";
import useResource from "../../hooks/use-resource";
import { showToast } from "../../utils/toast";

/**
 * 推荐 Mock 数据弹窗：
 *   - mount + method/path 变化 → useResource 自动 fetch（业务侧无 useEffect）
 *   - 父组件用 key={`${method}|${path}`} 实现重开 modal 时刷新
 *   - 用户点「直接使用」时回调 onApply(text)
 */
export default function RecommendMockModal({
  open,
  method,
  path,
  onClose,
  onApply,
}) {
  const {
    data,
    loading,
    error: fetchError,
    reload: regenerate,
  } = useResource(async () => {
    if (!path) return { text: "", meta: null };
    const result = await window.electronAPI.previewMockResponse({ method, path });
    if (!result?.success) {
      throw new Error(result?.error || "生成失败");
    }
    return {
      text: JSON.stringify(result.json, null, 2),
      meta: {
        method: result.method,
        path: result.path,
        status: result.status,
        operationId: result.operationId,
        summary: result.summary,
        source: result.source,
      },
    };
  }, [method, path]);

  // text 允许用户在编辑器里改 / 格式化，因此用独立 state。
  // data 变化时（reload 完成）以 fetched 值覆盖；用户改后保留。
  const [editedText, setEditedText] = useState(null);
  const [editKey, setEditKey] = useState(null);
  const dataKey = data?.text ?? "";
  if (editKey !== dataKey) {
    setEditKey(dataKey);
    setEditedText(null);
  }
  const text = editedText ?? data?.text ?? "";
  const meta = data?.meta || null;
  const errorText = fetchError ? fetchError.message || String(fetchError) : "";

  const [copyHint, setCopyHint] = useState("");

  const handleFormat = () => {
    try {
      setEditedText(JSON.stringify(JSON.parse(text || "{}"), null, 2));
    } catch (err) {
      showToast(`JSON 格式错误: ${err.message}`, "warning");
    }
  };

  const handleCopy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopyHint("已复制到剪贴板");
      showToast("推荐 JSON 已复制，请粘贴到 Response 后保存", "success");
    } catch (err) {
      setCopyHint(`复制失败: ${err?.message || err}`);
    }
  };

  const handleApply = () => {
    if (!text) return;
    try {
      JSON.parse(text);
    } catch (err) {
      showToast(`JSON 格式错误，无法直接使用: ${err.message}`, "warning");
      return;
    }
    onApply(text);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="推荐 Mock 数据"
      className="w-[720px] max-w-[92vw] max-h-[82vh]"
    >
      <div className="px-5 py-3 border-b border-border flex items-center gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-900">推荐 Mock 数据</div>
          <div className="text-[11px] text-slate-500 truncate">
            {meta
              ? `${meta.method} ${meta.path} · ${meta.status || "200"}${
                  meta.source ? ` · ${meta.source}` : ""
                }`
              : "基于 swagger schema 生成；用户自行复制到上方编辑器后保存"}
          </div>
          {meta?.summary && (
            <div className="text-[11px] text-slate-500 truncate mt-0.5">
              {meta.summary}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto px-2 py-1 rounded-md border text-[11px] bg-card text-slate-600 border-border hover:bg-hover hover:text-slate-900"
        >
          关闭
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden p-4">
        {loading ? (
          <div className="text-xs text-slate-500">生成中…</div>
        ) : errorText ? (
          <div className="text-xs text-red-600 whitespace-pre-wrap break-words">
            {errorText}
          </div>
        ) : (
          <div className="h-[52vh] border border-border rounded-lg overflow-hidden bg-[#fafbfc]">
            <JsonEditor
              value={text}
              onChange={setEditedText}
              height="100%"
            />
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border px-5 py-3 flex items-center gap-2">
        <span className="text-[11px] text-slate-500">{copyHint}</span>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={handleFormat}
            disabled={!text}
            className="px-3 py-1.5 rounded-md border text-xs font-medium bg-card text-slate-600 border-border hover:bg-hover hover:text-slate-900 disabled:opacity-40"
          >
            格式化
          </button>
          <button
            type="button"
            onClick={regenerate}
            disabled={loading}
            className="px-3 py-1.5 rounded-md border text-xs font-medium bg-card text-slate-600 border-border hover:bg-hover hover:text-slate-900 disabled:opacity-50"
          >
            重新生成
          </button>
          <button
            type="button"
            onClick={handleCopy}
            disabled={!text}
            className="px-3 py-1.5 rounded-md border text-xs font-medium bg-card text-slate-600 border-border hover:bg-hover hover:text-slate-900 disabled:opacity-40"
          >
            复制 JSON
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={!text}
            title="把当前 JSON 填入 Response 编辑器（仍需手动点保存生效）"
            className="px-3 py-1.5 rounded-md border text-xs font-medium bg-violet-400/10 text-violet-700 border-violet-400/35 hover:bg-violet-400/20 disabled:opacity-40"
          >
            直接使用
          </button>
        </div>
      </div>
    </Modal>
  );
}
