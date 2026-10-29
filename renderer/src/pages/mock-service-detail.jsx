import LogWindowWrapper from "../components/log-window-wrapper";
import DetailPanel from "./detail-panel";
import { MOCK_ID } from "../constants";
import { useAppConfig } from "../stores/app-config-store";
import { startMock, stopMock } from "../stores/runner-store";
import { useStatus } from "../stores/status-store";
import * as logStore from "../stores/log-store";
import { mockLocalUrl } from "../utils/mock-url";

const MOCK_STATUS_LABELS = {
  running: "运行中",
  starting: "启动中…",
  error: "出错",
  stopped: "未启动",
};

export default function MockServiceDetail() {
  const appConfig = useAppConfig();
  const status = useStatus(MOCK_ID);

  const isActive = status === "running" || status === "starting";
  const detail = {
    name: "Swagger Mock 服务",
    filter: appConfig.mockSpecPath || "—",
    logTitle: `swagger-mock — ${mockLocalUrl(appConfig.mockHost, appConfig.mockPort)}`,
    status,
    label: MOCK_STATUS_LABELS[status] || MOCK_STATUS_LABELS.stopped,
    badgeClass: status === "running" ? "mock-running" : status,
  };

  return (
    <LogWindowWrapper title="Mock 服务日志" route="/mock-service">
      {({ isModal, handleClose, handleOpenWindow }) => {
        const extraActions = isModal ? (
          <button
            type="button"
            onClick={handleOpenWindow}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-medium cursor-pointer transition-all bg-white text-slate-700 border-slate-200 hover:bg-slate-50 hover:text-slate-900 shadow-2xs"
            title="在新窗口中独立打开 Mock 日志控制台"
          >
            <svg className="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
            </svg>
            <span>新开窗口</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={handleClose}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-medium cursor-pointer transition-all bg-white text-slate-600 border-slate-200 hover:bg-slate-50 hover:text-slate-800 shadow-2xs"
            title="关闭当前日志窗口"
          >
            <svg className="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
            <span>关闭</span>
          </button>
        );

        return (
          <DetailPanel
            paneKey={MOCK_ID}
            detail={detail}
            isModal={isModal}
            primaryAction={
              isActive
                ? { label: "停止 mock", variant: "stop", onClick: stopMock }
                : { label: "启动 mock", variant: "mock-start", onClick: startMock }
            }
            onClearLog={() => logStore.clear(MOCK_ID)}
            extraActions={extraActions}
          />
        );
      }}
    </LogWindowWrapper>
  );
}
