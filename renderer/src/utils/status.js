/**
 * 状态文案
 */
export function getStatusLabel(status) {
  return (
    {
      running: "运行中",
      starting: "启动中",
      error: "出错",
      stopped: "已停止",
    }[status] || "已停止"
  );
}
