#!/usr/bin/env node
// req-to-plan 的工作包 → 赛博牛马任务库的单向桥（命令行入口）。
//
// 用于批量备料的场景：
//   req watch --exec 'node <此文件>'    → 每备好一个工作包就往任务库塞一条 inbox 任务
//
// 飞书里单条需求走 /plan 指令，不用这个脚本；两条路径共用 src/feishu/workpack.js
// 那份翻译层，所以正文格式、附件口径和去重锚点不会漂移。
//
// 外部进程能直接写任务库，是因为 task-store.js 本来就是按跨进程设计的（MCP server 也是
// 独立进程在读写同一份库）：不 import electron、getDataDir() 认 VJTOOLS_USER_DATA_DIR、
// persist() 写盘前先 mergeFromDisk() 跟磁盘对账，所以外部进程插入不会覆盖面板那边的任务。
//
// ⚠️ 命令行入口建的任务没有飞书会话（chatId / openId 都空），MCP 的 ask_requester 发不
// 出去，完成通知也只会记进 thread、不会真的发人。要闭环就走 /plan。
//
// 用法：
//   node scripts/req-to-docking.mjs                      # 从 WORKPACK_DIR / RECORD_ID 环境变量取（req watch --exec 的契约）
//   node scripts/req-to-docking.mjs <工作包目录>          # 手动塞一个
//   node scripts/req-to-docking.mjs <工作包目录> --dry-run  # 只打印会写什么，不落库
//
// 参数：
//   --repo <目录>       被分析仓库根目录，写进 task.repoPath，让面板/自动派活直接选中它
//                       （默认取 REQ_REPO_ROOT）
//   --user-data <目录>  vjtools 的 userData 目录（默认 VJTOOLS_USER_DATA_DIR，
//                       再回退 ~/Library/Application Support/vjtools）
//   --force             同一个工作包已经在库里也再插一条
//   --dry-run           只打印，不写库

import path from "node:path";
import { parseArgs } from "node:util";
import { addTask, setDataDir } from "../src/feishu/task-store.js";
import { buildWorkpackTask, findWorkpackTask } from "../src/feishu/workpack.js";

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      repo: { type: "string" },
      "user-data": { type: "string" },
      force: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const raw = positionals[0] || process.env.WORKPACK_DIR;
  if (!raw) {
    console.error("✗ 没给工作包目录（位置参数或 WORKPACK_DIR 环境变量）");
    process.exit(1);
  }

  const dir = path.resolve(raw);
  // req watch --exec 会带 RECORD_ID；手动跑时工作包目录名就是 record_id
  const recordId = process.env.RECORD_ID || path.basename(dir);
  const repoPath = path.resolve(values.repo || process.env.REQ_REPO_ROOT || ".");

  if (values["user-data"]) setDataDir(values["user-data"]);

  const { task, pack } = buildWorkpackTask({ dir, recordId, repoPath });

  if (values["dry-run"]) {
    console.log(`标题: ${task.title}`);
    console.log(`repoPath: ${repoPath}`);
    console.log(`附件: ${task.attachments.length} 个（截图 ${pack.assets.length} 张）`);
    console.log("---");
    console.log(task.content);
    return;
  }

  if (!values.force) {
    const existing = findWorkpackTask(dir);
    if (existing) {
      // 结果行走 stdout：req watch --exec 只回显子命令的 stdout，写 stderr 等于静默
      console.log(
        `↷ 已在任务库里（#${existing.seq}「${existing.title}」），跳过。--force 可强制再插一条。`,
      );
      return;
    }
  }

  const created = addTask({
    ...task,
    // 刻意留空：这不是飞书消息 id。填了假 id，完成通知会拿它去 im +messages-reply，
    // 白起一个 lark-cli 进程再失败
    messageId: "",
    senderName: "需求池",
    status: "inbox",
  });

  console.log(`✓ #${created.seq}「${created.title}」已入库（${task.attachments.length} 个附件）`);
  console.error(`  派活时选：工作目录 ${repoPath} · 产 plan 档 · Claude Code 引擎`);
  console.error(`  面板会在窗口重新聚焦时自动对账，切回 vjtools 就能看到`);
}

main(process.argv.slice(2));
