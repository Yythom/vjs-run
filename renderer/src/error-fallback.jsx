/**
 * 顶层 ErrorBoundary 的 fallback 组件。
 * 配合 react-error-boundary，渲染抛错时显示，给用户「刷新」「复制」两个出口。
 */
export default function ErrorFallback({ error, resetErrorBoundary }) {
  const handleReload = () => {
    resetErrorBoundary?.();
    if (typeof window !== "undefined") window.location.reload();
  };

  const handleCopy = async () => {
    const text = `${error?.name || "Error"}: ${error?.message || ""}\n\n${
      error?.stack || ""
    }`;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 复制失败忽略，stack 已经显示在页面上
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-base text-slate-900 p-6">
      <div className="max-w-2xl w-full rounded-lg border border-border bg-card p-6 shadow-sm">
        <div className="text-lg font-semibold mb-2">页面渲染出错</div>
        <div className="text-sm text-slate-600 mb-4">
          UI 抛出了一个未处理的异常。可以刷新窗口恢复；如反复出现请复制错误反馈。
        </div>
        <pre className="text-xs bg-slate-100 rounded p-3 overflow-auto max-h-64 whitespace-pre-wrap">
          {error?.message}
          {"\n\n"}
          {error?.stack}
        </pre>
        <div className="mt-4 flex gap-2">
          <button
            onClick={handleReload}
            className="px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs font-medium hover:bg-slate-700"
          >
            刷新窗口
          </button>
          <button
            onClick={handleCopy}
            className="px-3 py-1.5 rounded-md border border-border text-xs font-medium hover:bg-hover"
          >
            复制错误
          </button>
        </div>
      </div>
    </div>
  );
}
