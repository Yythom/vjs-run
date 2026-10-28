// 把一条请求历史转成 mock 规则（「存入场景」/ vjtools mock rule set --from-history 共用）。
//
// 零依赖纯函数：渲染层（renderer/src/pages/mock-history.jsx）也直接 import 这个文件，
// 所以这里不能引入任何 node 模块或别的源码文件。

/** 响应体超限未记录的无法固化，返回 null 由调用方跳过 / 报错 */
export function historyEntryToRule(entry) {
  if (entry.responseTruncated || entry.responseBody === undefined) return null;
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
