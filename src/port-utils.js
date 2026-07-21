import { exec } from "node:child_process";

// 通过 lsof 找到占用指定端口的进程并 kill；
// 仅用于「明确知道要清哪个端口」的场景：mock 启动前清自己的端口、端口查看器逐行 kill。
//
// 关键：mock server 是「进程内」跑的，端口的占用者可能是 Electron 主进程自己。
// 重启 mock（改配置触发）时若不排除本进程 PID，会把 App 自己 kill 掉 → 闪退。
// 所以通过 awk 过滤掉 process.pid，只清理上一轮残留的「别的」进程。
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
      `/usr/sbin/lsof -nP -i :${numericPort} | awk 'NR>1 && $2 != ${selfPid} {print $2}' | xargs kill 2>/dev/null || true`,
      { shell: "/bin/zsh" },
      () => resolve(),
    );
  });
}


