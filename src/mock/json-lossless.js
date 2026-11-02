// 超出安全范围的整数（雪花 ID 等）经 JSON.parse 会被舍入（1850123456789012345 → …2200）。
// parseJsonLossless 用 JSON.rawJSON 包住原文，JSON.stringify 时原样输出：读进来再写回文件、
// 或原样返回给前端都不丢位。
//
// 只给「解析后原样写回 / 原样返回」的数据用（规则文件、规则 response、后端响应记录）。rawJSON 对象
// 不能结构化克隆（不能走 Electron IPC、路由 state）、不能 String()：要走 IPC 先 JSON.stringify 成文本，
// 要参与比较 / String() 先过 unwrapRawJson。
// 运行时没有 JSON.rawJSON（Node < 21）时退回普通 JSON.parse。纯模块，不依赖 node / electron。

// 带 reviver 的 JSON.parse 每个值都要回调一次，比原生慢 7～8 倍；而大多数数据里根本没有大整数
// （雪花 ID 以字符串返回的也算）。所以先原生解析、遍历一遍看有没有被舍入的整数（遍历只占解析的一成多），
// 没有就直接用；有才带 reviver 重新解析一次。
function hasUnsafeInteger(root) {
  // 显式栈：嵌套很深的 JSON 递归会爆栈
  const stack = [root];
  while (stack.length) {
    const value = stack.pop();
    if (typeof value === "number") {
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) return true;
    } else if (value !== null && typeof value === "object") {
      if (Array.isArray(value)) for (let i = 0; i < value.length; i++) stack.push(value[i]);
      else for (const key in value) stack.push(value[key]);
    }
  }
  return false;
}

export function parseJsonLossless(text) {
  const plain = JSON.parse(text);
  if (typeof JSON.rawJSON !== "function" || !hasUnsafeInteger(plain)) return plain;
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
