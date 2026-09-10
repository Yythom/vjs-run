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
useAppConfigStore
  .getState()
  .init()
  .then(() => {
    // 侧栏宽度直接写进 CSS 变量，不走 React。
    // 它进 state 的话就得跟「IPC 和首次渲染谁先到」赛跑——主进程一忙，侧栏
    // 就拿默认宽度挂载，用户拖出来的宽度当场丢掉。写变量则谁先到都对：
    // 晚到无非是晚一帧把布局改过去，没有需要同步的 state。
    // 值在主进程 normalize 时已经 clamp 过（220–480），这里不用再夹一次。
    const saved = useAppConfigStore.getState().appConfig?.sidebarWidth;
    if (saved) {
      document.documentElement.style.setProperty(
        "--sidebar-width",
        `${saved}px`,
      );
    }
  });

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
