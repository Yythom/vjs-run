// 确认开测前查一遍常用 dev 端口被谁占着。M0 实测：把「5173 被无关项目占用、别停它」写进补充说明，
// agent 会照做（换端口起、测完不碰它）；不写的话它可能停掉别人的进程，或者拿错的返回当证据。

import { execFile } from "node:child_process";

// vjs-monorepo 各应用和 mock、网关常用的端口（见 commit-range-test 的 references/vjs-setup.md）
export const DEV_PORTS = [3002, 4000, 4001, 5173, 5174, 5175, 5176, 5178, 8801, 8888];

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000 }, (err, stdout) => resolve(err && !stdout ? "" : stdout));
  });
}

/** 解析 `lsof -F pcn` 的输出：p<pid> / c<命令> / n<地址> 一行一个字段 */
export function parseLsofListen(text, ports = DEV_PORTS) {
  const out = [];
  let pid = null;
  let command = "";
  for (const line of String(text).split("\n")) {
    const tag = line[0];
    const val = line.slice(1);
    if (tag === "p") pid = Number(val);
    else if (tag === "c") command = val;
    else if (tag === "n") {
      const port = Number(val.match(/:(\d+)$/)?.[1]);
      if (ports.includes(port) && !out.some((o) => o.port === port && o.pid === pid)) out.push({ port, pid, command });
    }
  }
  return out.sort((a, b) => a.port - b.port);
}

export async function checkDevPorts() {
  const listen = parseLsofListen(await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]));
  // 每个进程的工作目录：看得出是哪个项目起的
  for (const item of listen) {
    const cwd = await run("lsof", ["-a", "-p", String(item.pid), "-d", "cwd", "-F", "n"]);
    item.cwd = cwd.split("\n").find((l) => l.startsWith("n"))?.slice(1) || "";
  }
  return listen;
}

/** 写进补充说明的一句话 */
export function describeBusyPorts(list) {
  if (!list.length) return "";
  const parts = list.map((p) => `${p.port}（${p.command}${p.cwd ? `，${p.cwd}` : ""}，PID ${p.pid}）`);
  return `这些端口开测前已经被占用：${parts.join("、")}。不是你起的就不要停它，也不要拿它的返回当证据；要用的应用换端口起，以实际启动日志里的端口为准。`;
}
