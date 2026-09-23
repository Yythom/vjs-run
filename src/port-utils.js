import { exec } from "node:child_process";

// 通过 lsof 找到占用指定端口的进程并 kill；
// 仅用于「明确知道要清哪个端口」的场景：mock 启动前清自己的端口、端口查看器逐行 kill。
//
// 关键：mock server 是「进程内」跑的，端口的占用者可能是 Electron 主进程自己。
// 重启 mock（改配置触发）时若不排除本进程 PID，会把 App 自己 kill 掉 → 闪退。
// 所以通过 awk 过滤掉 process.pid，只清理上一轮残留的「别的」进程。
//
// 必须带 -sTCP:LISTEN：裸 `-i :port` 会把「连着这个端口的客户端」也列出来
// （如 keep-alive 连到 mock 的 vite 代理、浏览器），不加就会把它们一起杀掉。
// -t 只输出去重后的 PID，省掉跳标题行。
//
// 本应用目前是 macOS-only，故不再保留 Windows 分支（原 kill-port 分支也没做
// self-pid 排除，在 Windows 上反而会自杀）。
export async function killPort(port) {
  if (!port) return;
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort <= 0) return;

  const selfPid = process.pid;

  return new Promise((resolve) => {
    exec(
      `/usr/sbin/lsof -nP -t -iTCP:${numericPort} -sTCP:LISTEN | awk '$1 != ${selfPid}' | xargs kill 2>/dev/null || true`,
      { shell: "/bin/zsh" },
      () => resolve(),
    );
  });
}


