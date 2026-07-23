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
        "relative mx-2.5 flex items-center gap-2.5 px-3.5 py-2 rounded-lg cursor-pointer border transition-all text-xs font-semibold select-none mb-0.5",
        selected
          ? "bg-blue-500/[0.04] border-blue-500/20 text-blue-600 shadow-[0_1px_2px_rgba(0,0,0,0.01)]"
          : "border-transparent text-slate-600 hover:bg-slate-200/40 hover:text-slate-900"
      )}
    >
      {selected && (
        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-3/6 rounded-full bg-blue-500" />
      )}
      <span className="text-[13px] shrink-0">{icon}</span>
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
    <div className="flex items-center gap-1.5 px-4 py-1.5 text-[10px] font-bold tracking-widest uppercase text-slate-400 shrink-0 select-none mt-2">
      <span className="flex-1">🧪 Mock 模拟服务</span>
      <div className={`status-dot ${status || "stopped"}`} />
      <button
        type="button"
        onClick={handleToggle}
        className={clsx(
          "ml-1 w-5 h-5 rounded flex items-center justify-center text-[9px] font-medium cursor-pointer border transition-all shadow-sm shrink-0",
          isActive
            ? "bg-red-500/10 border-red-500/20 text-red-600 hover:bg-red-500/20"
            : "bg-emerald-500/10 border-emerald-500/20 text-emerald-600 hover:bg-emerald-500/20"
        )}
        title={isActive ? "停止 Mock 服务" : "启动 Mock 服务"}
      >
        {isActive ? "⏹" : "▶"}
      </button>
      <button
        type="button"
        onClick={handleOpenLog}
        className="w-5 h-5 rounded flex items-center justify-center text-[10px] cursor-pointer border border-slate-300/60 text-slate-500 bg-slate-500/5 hover:bg-slate-500/15 hover:text-slate-700 transition-all shadow-sm shrink-0"
        title="查看运行日志"
      >
        📋
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

  const activePath = location.pathname;

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
        <div className="flex items-center gap-1.5 px-4 py-1.5 text-[10px] font-bold tracking-widest uppercase text-slate-400 shrink-0 select-none">
          🧭 主控制台
        </div>
        <NavigationMenuItem
          icon="📦"
          label="项目管理"
          path="/"
          activePath={activePath}
        />

        {/* Mock 服务区 */}
        <MockMenuHeader />
        <NavigationMenuItem
          icon="🧩"
          label="规则配置"
          path="/mock-config"
          activePath={activePath}
        />
        <NavigationMenuItem
          icon="🕘"
          label="请求历史"
          path="/mock-history"
          activePath={activePath}
        />
        <NavigationMenuItem
          icon="⚙️"
          label="服务设置"
          path="/settings"
          activePath={activePath}
        />

        {/* 运维工具区 */}
        <div className="flex items-center gap-1.5 px-4 py-1.5 text-[10px] font-bold tracking-widest uppercase text-slate-400 shrink-0 select-none mt-2">
          🛠️ 运维与系统工具
        </div>
        <NavigationMenuItem
          icon="🔍"
          label="开发环境体检"
          path="/env-check"
          activePath={activePath}
        />
        <NavigationMenuItem
          icon="🔌"
          label="端口占用管理"
          path="/port-checker"
          activePath={activePath}
        />
        <NavigationMenuItem
          icon="🧹"
          label="应用缓存清理"
          path="/cleanup"
          activePath={activePath}
        />
        <NavigationMenuItem
          icon="🔐"
          label="统计数据计算"
          path="/codec"
          activePath={activePath}
        />
      </div>

      {/* 底部版本与更新 */}
      <div className="p-2 px-4 border-t border-border bg-slate-50/30 flex items-center justify-between shrink-0 select-none">
        <span className="text-[10.5px] font-medium text-slate-400">
          版本：v{appConfig?._appVersion || "0.0.1"}
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
