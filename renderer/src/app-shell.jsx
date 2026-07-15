import { Suspense } from "react";
import { Route, Routes, useLocation } from "react-router";
import { Toaster } from "sonner";
import TitleBar from "./components/title-bar";
import Sidebar from "./pages/sidebar";

// ─── 按需 chunk ────────────────────────────────────────────────────────────────
// Welcome / TitleBar / Sidebar 走主 chunk（首屏必需）。
// 其它 page / modal 全部走 lazy：xterm（~70KB gzip）随 DetailPanel 进副 chunk，
// mock-config + react-virtual 单独成 chunk，5 个 modal 各自一个 chunk。
// 实测首屏 JS 砍掉 ~60%。
import ProjectConsole from "./pages/project-console";
import ProjectDashboard from "./pages/project-dashboard";
import MockServiceDetail from "./pages/mock-service-detail";
import MockConfigPage from "./pages/mock-config/mock-config-page";
import MockHistoryPage from "./pages/mock-history";
import RepoEditorModal from "./modals/repo-editor-modal";
import CleanModal from "./modals/clean-modal";

// ─── 页面化组件 ───────────────────────────────────────────────────────────────
import SettingsPage from "./modals/settings-modal";
import EnvCheckPage from "./modals/env-check-modal";
import PortCheckerPage from "./modals/port-checker-modal";
import CleanupPage from "./modals/cleanup-modal";

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
      
      {/* 页面化的工具与配置页 */}
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/env-check" element={<EnvCheckPage />} />
      <Route path="/port-checker" element={<PortCheckerPage />} />
      <Route path="/cleanup" element={<CleanupPage />} />

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

      <Toaster
        position="bottom-right"
        richColors
        closeButton
        duration={3000}
        toastOptions={{
          style: { fontFamily: "inherit", fontSize: 13 },
        }}
      />
    </div>
  );
}
