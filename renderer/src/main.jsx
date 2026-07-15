import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router";
import { ErrorBoundary } from "react-error-boundary";
import AppShell from "./app-shell";
import ErrorFallback from "./error-fallback";
import { useAppConfigStore } from "./stores/app-config-store";
// 副作用：import runner-store 即触发 IPC 监听挂载 + 首次刷新项目列表
import "./stores/runner-store";
import "./styles.css";

// 全局兜底：捕获 Promise / 事件回调里没 try 的异常，避免 IPC reject 把组件炸成白屏
window.addEventListener("unhandledrejection", (event) => {
  console.error("[unhandledrejection]", event.reason);
});
window.addEventListener("error", (event) => {
  console.error("[window.error]", event.error || event.message);
});

// 启动时拉一次 app config（不 await，让 React 先 mount；DEFAULT 兜底 UI）
useAppConfigStore.getState().init();

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary
      FallbackComponent={ErrorFallback}
      onError={(error, info) =>
        console.error("[ErrorBoundary]", error, info?.componentStack)
      }
    >
      <HashRouter>
        <AppShell />
      </HashRouter>
    </ErrorBoundary>
  </React.StrictMode>,
);
