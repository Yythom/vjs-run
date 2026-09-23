import { Suspense, lazy } from "react";
import { createPortal } from "react-dom";
import { Route, Routes, useLocation } from "react-router";
import { Toaster } from "sonner";
import TitleBar from "./components/title-bar";
import Sidebar from "./pages/sidebar";
import ProjectDashboard from "./pages/project-dashboard";

// ─── 按需 chunk ────────────────────────────────────────────────────────────────
// TitleBar / Sidebar / ProjectDashboard（默认首页）走主 chunk（首屏必需）。
// 其它 page / modal 全部走 lazy：xterm 随日志控制台进副 chunk，
// CodeMirror / react-virtual 随 mock 配置页进副 chunk，各 modal 各自一个 chunk。
const ProjectConsole = lazy(() => import("./pages/project-console"));
const MockServiceDetail = lazy(() => import("./pages/mock-service-detail"));
const MockConfigPage = lazy(() => import("./pages/mock-config/mock-config-page"));
const MockHistoryPage = lazy(() => import("./pages/mock-history"));
const SwaggerConvertPage = lazy(() => import("./pages/swagger-convert-page"));
const SettingsPage = lazy(() => import("./pages/settings-page"));
const EnvCheckPage = lazy(() => import("./pages/env-check-page"));
const PortCheckerPage = lazy(() => import("./pages/port-checker-page"));
const CleanupPage = lazy(() => import("./pages/cleanup-page"));
const CodecPage = lazy(() => import("./pages/codec-page"));
const WeappDeployPage = lazy(() => import("./pages/weapp-deploy-page"));
const RepoEditorModal = lazy(() => import("./modals/repo-editor-modal"));
const CleanModal = lazy(() => import("./modals/clean-modal"));

/**
 * 主区域路由（layout 之下的右侧面板）。
 * 当通过 useModalNav 打开 modal 时，主区域会渲染 backgroundLocation 对应的页面，
 * modal 在上层 overlay。
 */
function MainRoutes() {
  const location = useLocation();
  const backgroundLocation = location.state?.backgroundLocation;

  return (
    <Routes location={backgroundLocation || location}>
      <Route index element={<ProjectDashboard />} />
      <Route path="/mock-config" element={<MockConfigPage />} />
      <Route path="/mock-history" element={<MockHistoryPage />} />
      <Route path="/swagger-convert" element={<SwaggerConvertPage />} />

      {/* 小程序管理 */}
      <Route path="/weapp-deploy" element={<WeappDeployPage />} />

      {/* 工具与配置页 */}
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/env-check" element={<EnvCheckPage />} />
      <Route path="/port-checker" element={<PortCheckerPage />} />
      <Route path="/cleanup" element={<CleanupPage />} />
      <Route path="/codec" element={<CodecPage />} />

      {/* 直接刷新到 modal route 时主区域 fallback 到 ProjectDashboard */}
      <Route path="*" element={<ProjectDashboard />} />
    </Routes>
  );
}

/**
 * 把所有 modal 集中挂载在这里。每个 modal 是独立的 route 组件，
 * 自己读 useParams / context，App 不再持有 modal 的 open state。
 */
function ModalRoutes() {
  return (
    <Routes>
      <Route path="/mock-service" element={<MockServiceDetail />} />
      <Route path="/projects/logs" element={<ProjectConsole />} />
      <Route path="/repos/new" element={<RepoEditorModal />} />
      <Route path="/repos/:key/edit" element={<RepoEditorModal />} />
      <Route path="/repos/:key/clean" element={<CleanModal />} />
      <Route path="*" element={null} />
    </Routes>
  );
}

export default function AppShell() {
  const location = useLocation();
  const isSubWindow = location.search.includes("window=sub");

  return (
    <div className="bg-base text-slate-900 text-sm overflow-hidden h-screen flex flex-col">
      <TitleBar />

      <div className="flex flex-1 overflow-hidden">
        {!isSubWindow && <Sidebar />}

        <main className="min-w-0 flex-1 flex flex-col overflow-hidden">
          {/* 切页 / 首次加载某 page chunk 时短暂留白；fallback null 比 spinner 闪烁更顺 */}
          <Suspense fallback={null}>
            <MainRoutes />
          </Suspense>
        </main>
      </div>

      {/* modal chunk 没下载完之前 modal 不出现，背景照旧 */}
      <Suspense fallback={null}>
        <ModalRoutes />
      </Suspense>

      {createPortal(
        <Toaster
          position="bottom-left"
          richColors
          closeButton
          duration={1500}
          toastOptions={{
            style: {
              fontSize: "12px",
              width:"250px",
              padding: "8px 28px 8px 12px",
            },
            closeButton: {
              pointerEvents: "auto",
              zIndex: 99,
            },
          }}
        />,
        document.body,
      )}
    </div>
  );
}
