import { useLocation, useNavigate } from "react-router";

/**
 * 打开 modal route 时把当前 location 塞到 history state.backgroundLocation 里。
 * <AppShell /> 渲染主区域时优先用 backgroundLocation，这样 modal 浮在原页面上方，
 * 而不是把主区域换成 fallback。
 *
 * 用法：
 *   const openModal = useModalNav();
 *   openModal('/settings');
 *   openModal(`/repos/${key}/edit`);
 */
export default function useModalNav() {
  const navigate = useNavigate();
  const location = useLocation();
  return (to) => {
    const background = location.state?.backgroundLocation || location;
    navigate(to, { state: { backgroundLocation: background } });
  };
}

/**
 * 关闭 modal route：回退到 backgroundLocation 或根路径。
 */
export function useCloseModal() {
  const navigate = useNavigate();
  const location = useLocation();
  return () => {
    const bg = location.state?.backgroundLocation;
    if (bg) navigate(bg, { replace: true });
    else navigate("/", { replace: true });
  };
}
