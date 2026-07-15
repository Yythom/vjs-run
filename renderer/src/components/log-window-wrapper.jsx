import { useLocation } from "react-router";
import { useCloseModal } from "../hooks/use-modal-nav";
import Modal from "./modal";

/**
 * LogWindowWrapper - 统一的日志终端窗口容器包装器。
 * 职责：
 * 1. 自动检测是主窗口 Modal 模式还是 Electron 独立副窗口模式。
 * 2. 统一处理 Modal 关闭（react-router 历史记录退回）与独立窗口关闭（调用 Electron close-window IPC）。
 * 3. 统一提供新开窗口跳转行为，并自动关闭当前主窗口的 Modal。
 * 4. 采用 Render Props 模式，向子组件抛出 isModal、handleClose、handleOpenWindow 回调。
 */
export default function LogWindowWrapper({
  title,
  route,
  modalClassName = "w-[96vw] h-[92vh] max-w-7xl",
  onModalCloseCheck, // 可选：关闭前的检查（如清理中禁止关闭）
  children,
}) {
  const location = useLocation();
  const close = useCloseModal();

  const isSubWindow = location.search.includes("window=sub");
  const isModal = !isSubWindow;

  const handleOpenWindow = () => {
    window.electronAPI.openWindow(route);
    if (isModal) close();
  };

  const handleClose = () => {
    if (isModal) {
      if (onModalCloseCheck && !onModalCloseCheck()) {
        return;
      }
      close();
    } else {
      window.electronAPI.closeWindow();
    }
  };

  const context = {
    isModal,
    isSubWindow,
    handleClose,
    handleOpenWindow,
  };

  const content = typeof children === "function" ? children(context) : children;

  if (isModal) {
    return (
      <Modal
        open
        onClose={handleClose}
        title={title}
        srOnly={false}
        className={modalClassName}
      >
        <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
          {content}
        </div>
      </Modal>
    );
  }

  // 独立窗口定位在 TitleBar 下方，撑满剩余视口
  return (
    <div className="fixed top-7 inset-x-0 bottom-0 z-50 flex flex-col overflow-hidden bg-slate-50">
      {content}
    </div>
  );
}
