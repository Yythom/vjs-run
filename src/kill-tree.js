// 按进程组终止子进程树。
//
// Node 的 proc.kill() 只把信号发给直接子进程。而我们 spawn 的东西（dev server、
// lark-cli、claude / codex / agy）几乎都会再拉起自己的一串子进程，只杀父进程
// 会留下一堆孤儿，继续占着端口、/tmp 里的 socket 和仓库文件锁。
//
// 前提是 spawn 时带了 detached:true —— 子进程自成一个进程组，负数 pid 才能把整组
// 一起端掉。兜底分支保留单进程 kill，应付进程已退出、或没能自立门户的情况。

export function killProcessTree(proc, signal) {
  if (!proc) return;
  const pid = proc.pid;
  // pid 必须是合法的正整数，且不能是 0 或 1：process.kill(0, sig) 是发给自己所在的
  // 整个进程组（会把 Electron 主进程一起带走），-1 则是发给所有有权限的进程。
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, signal);
  } catch (_) {
    try {
      proc.kill(signal);
    } catch (__) {}
  }
}
