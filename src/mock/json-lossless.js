// 超出安全范围的整数（雪花 ID 等）经 JSON.parse 会被舍入（1850123456789012345 → …2200）。
// parseJsonLossless 用 JSON.rawJSON 包住原文，JSON.stringify 时原样输出：读进来再写回文件、
// 或原样返回给前端都不丢位。
//
// 只给「解析后原样写回 / 原样返回」的数据用（规则文件、规则 response、后端响应记录）。rawJSON 对象
// 不能结构化克隆（不能走 Electron IPC）、不能 String()，要参与比较、展示或走 IPC 的数据别用它。
// 运行时没有 JSON.rawJSON（Node < 21）时退回普通 JSON.parse。纯模块，不依赖 node / electron。

export function parseJsonLossless(text) {
  if (typeof JSON.rawJSON !== "function") return JSON.parse(text);
  return JSON.parse(text, (key, value, context) =>
    // 顶层就是一个数字时不包：调用方拿到的应该是普通值
    key !== "" &&
    typeof value === "number" &&
    Number.isInteger(value) &&
    !Number.isSafeInteger(value) &&
    context?.source
      ? JSON.rawJSON(context.source)
      : value,
  );
}

/** rawJSON 包装 → 普通 JSON.parse 会得到的值（舍入后的数字）；其它值原样返回。要拿来比较 / String() 的地方先过一遍 */
export function unwrapRawJson(value) {
  return typeof JSON.isRawJSON === "function" && JSON.isRawJSON(value) ? JSON.parse(value.rawJSON) : value;
}
