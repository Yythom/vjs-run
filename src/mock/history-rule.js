// 把一条请求历史转成 mock 规则（「存入场景」/ vjtools mock rule set --from-history 共用）。
//
// 零依赖纯函数：渲染层（renderer/src/pages/mock-history.jsx）也直接 import 这个文件，
// 所以这里不能引入任何 node 模块或别的源码文件。

/**
 * 这条历史为什么不能存成规则；能存返回 null。返回的是接在「#编号」后面的半句话，CLI 拼进报错。
 * 代理失败、mock 自己的 404/502 都没有后端响应；非 JSON 响应存下来只能原样返回一个字符串
 */
export function historyEntryRejectReason(entry) {
  if (entry.kind === "proxy-error") return "是代理失败的请求（后端没连上），没有后端响应可以保存";
  if (entry.responseTruncated) return "的响应体超出记录上限，没有被完整记录";
  if (entry.responseBody === undefined) return "没有响应体（未命中、没配后端时 mock 自己返回的 404 / 502 不会记录）";
  if (entry.responseIsJson === false) return "的后端响应不是 JSON（如 HTML、纯文本），存成规则只能返回一个字符串";
  return null;
}

/** 不能存的（见 historyEntryRejectReason）返回 null，由调用方跳过 / 报错 */
export function historyEntryToRule(entry) {
  if (historyEntryRejectReason(entry)) return null;
  return {
    enabled: true,
    method: entry.method,
    // 命中过 swagger 路由的用带 {param} 的模板，规则能覆盖同类请求
    path: entry.matchedPath || entry.path,
    ...(entry.status && entry.status !== 200 && entry.kind !== "miss"
      ? { status: entry.status }
      : {}),
    response: entry.responseBody,
  };
}
