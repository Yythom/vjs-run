// mock 的本机访问地址，与 src/mock/runtime.js 的 mockBaseUrl 保持一致（那边依赖 node:os，渲染层引不了）：
// 0.0.0.0 / :: 是「监听所有网卡」，不能拿来访问，换成回环地址；IPv6 地址在 URL 里要加方括号
export function mockLocalUrl(host, port) {
  const reachable = !host || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const urlHost = reachable.includes(":") && !reachable.startsWith("[") ? `[${reachable}]` : reachable;
  return `http://${urlHost}:${port || 3002}`;
}
