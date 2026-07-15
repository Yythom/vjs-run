import LogWindowWrapper from "../components/log-window-wrapper";
import DetailPanel from "./detail-panel";
import { MOCK_ID } from "../constants";
import { useAppConfig } from "../stores/app-config-store";
import { startMock, stopMock } from "../stores/runner-store";
import { useStatus } from "../stores/status-store";
import * as logStore from "../stores/log-store";

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
  const host = appConfig.mockHost || "127.0.0.1";
  const port = appConfig.mockPort || 3002;

  const detail = {
    name: "Swagger Mock 服务",
    filter: appConfig.mockSpecPath || "—",
    logTitle: `swagger-mock — http://${host}:${port}`,
    status,
    label: MOCK_STATUS_LABELS[status] || MOCK_STATUS_LABELS.stopped,
    badgeClass: status === "running" ? "mock-running" : status,
  };

  return (
    <LogWindowWrapper title="Mock 服务日志" route="/mock-service">
      {({ isModal, handleClose, handleOpenWindow }) => {
        const extraActions = isModal ? (
          <>
            <button
              type="button"
              onClick={handleOpenWindow}
              className="inline-flex items-center gap-1 px-3 py-1 rounded-md border text-xs font-semibold cursor-pointer transition-all bg-blue-500/[0.04] text-blue-600 border-blue-500/20 hover:bg-blue-500/10"
              title="在新窗口中独立打开 Mock 日志控制台"
            >
              🖥️ 新开窗口
            </button>
            <button
              type="button"
              onClick={handleClose}
              className="inline-flex items-center gap-1 px-3 py-1 rounded-md border text-xs font-semibold cursor-pointer transition-all bg-card text-slate-400 border-border hover:bg-hover hover:text-slate-700"
            >
              ✕ 关闭
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={handleClose}
            className="inline-flex items-center gap-1 px-3 py-1 rounded-md border text-xs font-semibold cursor-pointer transition-all bg-card text-slate-500 border-border hover:bg-hover hover:text-slate-800"
            title="关闭当前日志窗口"
          >
            ✕ 关闭
          </button>
        );

        return (
          <DetailPanel
            paneKey={MOCK_ID}
            detail={detail}
            primaryAction={
              isActive
                ? { label: "⏹ 停止 mock", variant: "stop", onClick: stopMock }
                : { label: "▶ 启动 mock", variant: "mock-start", onClick: startMock }
            }
            onClearLog={() => logStore.clear(MOCK_ID)}
            extraActions={extraActions}
          />
        );
      }}
    </LogWindowWrapper>
  );
}
