import { useEffect, useState } from "react";

/** mm:ss */
export function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * 运行时长计时器。
 *
 * 自己持有 setInterval，是为了把「每秒一次的 setState」关在这一个 <span> 里。
 * 计时器一旦挂在上层组件（页面、悬浮条）身上，只要有任务在跑，那整棵子树就
 * 每秒重建一次——而实际会变的只有这几个数字。
 *
 * startTime 为空时不渲染也不计时。
 */
export default function ElapsedTime({ startTime }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!startTime) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startTime]);

  if (!startTime) return null;
  const elapsed = Math.max(0, Math.floor((now - startTime) / 1000));
  return <>{formatDuration(elapsed)}</>;
}
