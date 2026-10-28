import { useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import clsx from "../utils/clsx";
import { useAppConfig, updateAppConfig } from "../stores/app-config-store";
import {
  startMock,
  stopMock,
} from "../stores/runner-store";
import { useStatus } from "../stores/status-store";
import { MOCK_ID } from "../constants";
import { showToast } from "../utils/toast";
import UpdateChecker from "../components/update-checker";

import useModalNav from "../hooks/use-modal-nav";

const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_DEFAULT_WIDTH = 248;

function clampSidebarWidth(width) {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
}

function NavigationMenuItem({ icon, label, path, activePath }) {
  const navigate = useNavigate();
  const openModal = useModalNav();
  // 精确匹配或者当 path="/" 时匹配以 /projects 开头的子路径，或者非根路径的前缀匹配
  const selected =
    activePath === path ||
    (path === "/" && activePath.startsWith("/projects")) ||
    (path !== "/" && activePath.startsWith(path));

  const handleClick = () => {
    if (path === "/mock-service") {
      openModal(path);
    } else {
      navigate(path);
    }
  };

  return (
    <div
      onClick={handleClick}
      className={clsx(
        // 只过渡颜色：transition-all 会把选中/未选中的字重差异做成逐帧动画，每帧都要重排
        "group relative mx-2 flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer transition-colors text-xs select-none mb-0.5",
        selected
          ? "bg-sky-50 text-sky-700 font-semibold shadow-[0_1px_2px_rgba(0,0,0,0.02)]"
          : "text-slate-600 hover:bg-slate-200/50 hover:text-slate-900 font-medium"
      )}
    >
      <span
        className={clsx(
          "shrink-0 transition-colors",
          selected ? "text-sky-600" : "text-slate-400 group-hover:text-slate-600"
        )}
      >
        {icon}
      </span>
      <span className="flex-1 truncate">{label}</span>
    </div>
  );
}

function MockMenuHeader() {
  const status = useStatus(MOCK_ID);
  const openModal = useModalNav();
  const isActive = status === "running" || status === "starting";

  const handleToggle = (e) => {
    e.stopPropagation();
    if (isActive) stopMock();
    else startMock();
  };

  const handleOpenLog = (e) => {
    e.stopPropagation();
    openModal("/mock-service");
  };

  return (
    <div className="flex items-center gap-1.5 px-3.5 py-1.5 text-[10px] font-bold tracking-wider uppercase text-slate-400 shrink-0 select-none mt-3">
      <span className="flex-1 flex items-center gap-1.5 text-slate-500 font-semibold tracking-normal">
        <svg className="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 0 1-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 0 1 4.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.943A4.5 4.5 0 0 1 15.938 17H8.062a4.5 4.5 0 0 1-2.292-.757L4.2 15.3m15.6 0-1.8-1.08A2.25 2.25 0 0 0 16.8 14H7.2a2.25 2.25 0 0 0-1.2.32L4.2 15.3" />
        </svg>
        Mock 模拟服务
      </span>
      <div className={`status-dot ${status || "stopped"}`} />
      <button
        type="button"
        onClick={handleToggle}
        className={clsx(
          "ml-1 w-5 h-5 rounded flex items-center justify-center text-[10px] cursor-pointer border transition-all shadow-xs shrink-0",
          isActive
            ? "bg-red-500/10 border-red-500/30 text-red-600 hover:bg-red-500/20"
            : "bg-emerald-500/10 border-emerald-500/30 text-emerald-600 hover:bg-emerald-500/20"
        )}
        title={isActive ? "停止 Mock 服务" : "启动 Mock 服务"}
      >
        {isActive ? (
          <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24">
            <rect x="5" y="5" width="14" height="14" rx="2" />
          </svg>
        ) : (
          <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z" />
          </svg>
        )}
      </button>
      <button
        type="button"
        onClick={handleOpenLog}
        className="w-5 h-5 rounded flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 transition-all border border-slate-200/70 bg-white shadow-xs shrink-0 cursor-pointer"
        title="查看运行日志"
      >
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
        </svg>
      </button>
    </div>
  );
}

export default function Sidebar() {
  const appConfig = useAppConfig();
  const location = useLocation();
  const savedWidth = appConfig.sidebarWidth;

  const [width, setWidth] = useState(() =>
    clampSidebarWidth(savedWidth || SIDEBAR_DEFAULT_WIDTH),
  );
  const [resizing, setResizing] = useState(false);
  const asideRef = useRef(null);



  const persistWidth = async (nextWidth) => {
    try {
      await updateAppConfig({ sidebarWidth: nextWidth });
    } catch (error) {
      showToast(`保存侧栏宽度失败: ${error.message}`, "error");
    }
  };

  const startResize = (event) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = asideRef.current?.offsetWidth ?? width;
    setResizing(true);
    let latestWidth = startWidth;

    const handlePointerMove = (moveEvent) => {
      const nextWidth = clampSidebarWidth(
        startWidth + moveEvent.clientX - startX,
      );
      latestWidth = nextWidth;
      const el = asideRef.current;
      if (el) el.style.width = `${nextWidth}px`;
    };

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      setWidth(latestWidth);
      setResizing(false);
      persistWidth(latestWidth);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  };

  // 打开 modal 时 pathname 变成 /repos/... 这类 modal 路由，选中态要跟着背后那一页走，
  // 否则一开弹窗侧栏高亮就熄灭、关掉又亮起
  const activePath = location.state?.backgroundLocation?.pathname || location.pathname;

  return (
    <aside
      ref={asideRef}
      className={clsx(
        "relative shrink-0 bg-panel border-r border-border flex flex-col overflow-hidden",
        resizing && "select-none",
      )}
      style={{ width }}
    >
      <div className="sidebar-scroll flex-1 overflow-y-auto flex flex-col py-2.5 gap-1">
        {/* 概览区 */}
        <div className="flex items-center gap-1.5 px-3.5 py-1.5 text-[10px] font-bold tracking-wider uppercase text-slate-400 shrink-0 select-none">
          控制台
        </div>
        <NavigationMenuItem
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z" />
            </svg>
          }
          label="项目管理"
          path="/"
          activePath={activePath}
        />

        {/* Mock 服务区 */}
        <MockMenuHeader />
        <NavigationMenuItem
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 1 1-3 0m3 0a1.5 1.5 0 1 0-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-9.75 0h9.75" />
            </svg>
          }
          label="规则配置"
          path="/mock-config"
          activePath={activePath}
        />
        <NavigationMenuItem
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
            </svg>
          }
          label="请求历史"
          path="/mock-history"
          activePath={activePath}
        />
        <NavigationMenuItem
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
            </svg>
          }
          label="OpenAPI 转换"
          path="/swagger-convert"
          activePath={activePath}
        />
        <NavigationMenuItem
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
            </svg>
          }
          label="服务设置"
          path="/settings"
          activePath={activePath}
        />

        {/* 运维工具区 */}
        <div className="flex items-center gap-1.5 px-3.5 py-1.5 text-[10px] font-bold tracking-wider uppercase text-slate-400 shrink-0 select-none mt-3">
          运维与系统工具
        </div>
        <NavigationMenuItem
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" />
            </svg>
          }
          label="开发环境体检"
          path="/env-check"
          activePath={activePath}
        />
        <NavigationMenuItem
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 0 0 2.25-2.25V6.75a2.25 2.25 0 0 0-2.25-2.25H6.75A2.25 2.25 0 0 0 4.5 6.75v10.5a2.25 2.25 0 0 0 2.25 2.25Zm.75-12h9v9h-9v-9Z" />
            </svg>
          }
          label="端口占用管理"
          path="/port-checker"
          activePath={activePath}
        />
        <NavigationMenuItem
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
            </svg>
          }
          label="应用缓存清理"
          path="/cleanup"
          activePath={activePath}
        />
        <NavigationMenuItem
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 15.75V18m-7.5-6.75h.008v.008H8.25v-.008Zm0 2.25h.008v.008H8.25V13.5Zm0 2.25h.008v.008H8.25v-.008Zm0 2.25h.008v.008H8.25V18Zm2.498-6.75h.007v.008h-.007v-.008Zm0 2.25h.007v.008h-.007V13.5Zm0 2.25h.007v.008h-.007v-.008Zm0 2.25h.007v.008h-.007V18Zm2.504-6.75h.008v.008h-.008v-.008Zm0 2.25h.008v.008h-.008V13.5Zm0 2.25h.008v.008h-.008v-.008Zm0 2.25h.008v.008h-.008V18Zm2.498-6.75h.008v.008h-.008v-.008Zm0 2.25h.008v.008h-.008V13.5ZM8.25 6h7.5v2.25h-7.5V6ZM12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25Z" />
            </svg>
          }
          label="统计数据计算"
          path="/codec"
          activePath={activePath}
        />
        <NavigationMenuItem
          icon={
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.59 14.37a6 6 0 0 1-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 0 0 6.16-12.12A14.98 14.98 0 0 0 9.631 8.41m5.96 5.96a14.926 14.926 0 0 1-5.841 2.58m-.119-8.54a6 6 0 0 0-7.381 5.84h4.8m2.581-5.84a14.927 14.927 0 0 0-2.58 5.84m2.699 2.7c-.103.021-.207.041-.311.06a15.09 15.09 0 0 1-2.448-2.448 14.9 14.9 0 0 1 .06-.312m-2.24 2.39a4.493 4.493 0 0 0-1.757 4.306 4.493 4.493 0 0 0 4.306-1.758M16.5 9a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z" />
            </svg>
          }
          label="小程序发布"
          path="/weapp-deploy"
          activePath={activePath}
        />
      </div>

      {/* 底部版本与更新 */}
      <div className="p-2.5 px-3.5 border-t border-border bg-slate-50/50 flex items-center justify-between shrink-0 select-none">
        <span className="text-[11px] font-medium text-slate-400 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-slate-300" />
          v{appConfig?._appVersion || "0.0.1"}
        </span>
        <UpdateChecker />
      </div>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧栏宽度"
        title="拖动调整宽度"
        onPointerDown={startResize}
        className={clsx(
          "absolute top-0 right-[-3px] z-10 h-full w-1.5 cursor-col-resize transition-colors",
          resizing ? "bg-sky-400/40" : "hover:bg-sky-400/25",
        )}
      />
    </aside>
  );
}
