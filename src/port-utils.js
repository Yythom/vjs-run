import { exec } from "node:child_process";

// 通过 lsof 找到占用指定端口的进程并 kill；无占用时 xargs kill 会报错，"|| true" 吞掉。
// 仅用于「明确知道要清哪个端口」的场景：mock 启动前清自己的端口、端口查看器逐行 kill。
// 用绝对路径 /usr/sbin/lsof：打包后的 Electron PATH 可能很精简，与 diagnostics.js 的查询保持一致。
//
// 关键：mock server 是「进程内」跑的，端口的占用者就是 Electron 主进程自己。
// 重启 mock（改配置触发）时若不排除本进程 PID，会把 App 自己 kill 掉 → 闪退。
// 所以这里过滤掉 process.pid，只清理上一轮残留的「别的」进程。
export function killPort(port) {
  const selfPid = process.pid;
  return new Promise((resolve) => {
    exec(
      `/usr/sbin/lsof -nP -i :${port} | awk 'NR>1 && $2 != ${selfPid} {print $2}' | xargs kill 2>/dev/null || true`,
      { shell: "/bin/zsh" },
      () => resolve(),
    );
  });
}

