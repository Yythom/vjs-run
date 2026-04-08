const ANSI_COLORS = {
  30: "ansi-black",
  31: "ansi-red",
  32: "ansi-green",
  33: "ansi-yellow",
  34: "ansi-blue",
  35: "ansi-magenta",
  36: "ansi-cyan",
  37: "ansi-white",
  90: "ansi-bright-black",
  91: "ansi-bright-red",
  92: "ansi-bright-green",
  93: "ansi-bright-yellow",
  94: "ansi-bright-blue",
  95: "ansi-bright-magenta",
  96: "ansi-bright-cyan",
  97: "ansi-bright-white",
};

/**
 * ANSI 转义序列转 HTML（安全）
 * - 先做 HTML 转义，避免 XSS
 * - 再把 ANSI 样式转换为 span class
 */
export function ansiToHtml(text = "") {
  const safeText = String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const parts = safeText.split(/\x1b\[([0-9;]*)m/);
  let result = "";
  let openSpans = 0;

  for (let i = 0; i < parts.length; i += 1) {
    if (i % 2 === 0) {
      // 普通文本片段
      result += parts[i];
      continue;
    }

    // ANSI 码片段
    const rawCodes = parts[i] ? parts[i].split(";") : ["0"];
    const codes = rawCodes.map((n) => Number(n));
    const classes = [];

    for (const code of codes) {
      if (code === 0) {
        // reset
        if (openSpans > 0) {
          result += "</span>".repeat(openSpans);
          openSpans = 0;
        }
      } else if (code === 1) {
        classes.push("ansi-bold");
      } else if (code === 2) {
        classes.push("ansi-dim");
      } else if (ANSI_COLORS[code]) {
        classes.push(ANSI_COLORS[code]);
      }
    }

    if (classes.length > 0) {
      result += `<span class="${classes.join(" ")}">`;
      openSpans += 1;
    }
  }

  if (openSpans > 0) {
    result += "</span>".repeat(openSpans);
  }

  return result;
}

/**
 * 状态文案
 */
export function getStatusLabel(status, isProxy = false) {
  if (isProxy && status === "running") return "运行中";

  return (
    {
      running: "运行中",
      starting: "启动中",
      error: "出错",
      stopped: "已停止",
    }[status] || "已停止"
  );
}
