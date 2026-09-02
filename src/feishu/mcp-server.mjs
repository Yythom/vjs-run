#!/usr/bin/env node
// 赛博牛马 MCP server —— 无头 claude / agy 的工具集。
//
// 它不是给人手动配的：runner 起 claude 时自动挂载。有了这组工具，claude 才能
// 在自动处理需求的过程中回写任务状态、需求含糊时直接飞书反问提出人，
// 从而形成「录入 → 处理 → 标完成 / 反问」的闭环。
//
// 数据目录由 runner 通过 VJTOOLS_USER_DATA_DIR 传进来，跟面板读写同一份任务库。
// runner 用 Electron 自身当 node 跑它（ELECTRON_RUN_AS_NODE=1），这样打包进
// asar 之后依然读得到——外部 node 进程是读不了 asar 的。
//
// stdio 传输下 stdout 属于 JSON-RPC，任何日志都必须走 stderr，否则协议直接破。
//
// 注意：@modelcontextprotocol/sdk 和 zod 必须留在 package.json 的 dependencies
// 里（不能是 devDependencies）——electron-builder 打包只带生产依赖，放错区
// 打出来的包里这个 server 会直接起不来。

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  appendThread,
  getSettings,
  listTasks,
  reload,
  updateTask,
} from "./task-store.js";
import { buildPrompt } from "./prompt.js";
import { sendMessage } from "./lark-cli.js";
import {
  buildAskCard,
  buildDoneCard,
  buildIgnoredCard,
} from "./cards.js";

const STATUS_TEXT = {
  inbox: "待处理",
  unfiled: "未识别",
  awaiting: "已反问等回复",
  doing: "进行中",
  done: "已完成",
  ignored: "已忽略",
};

function text(body) {
  return { content: [{ type: "text", text: body }] };
}

/** 每次调用都重读：面板那边随时在写，内存缓存会过期 */
function bySeq(seq) {
  reload();
  return listTasks().find((t) => t.seq === Number(seq)) || null;
}

const server = new McpServer({ name: "docking", version: "1.0.0" });

server.registerTool(
  "get_task",
  {
    title: "查看任务详情",
    description:
      "按短号取一条对接需求的完整内容：原始需求、我的补充、历次飞书澄清记录。",
    inputSchema: { seq: z.number().int().positive().describe("任务短号") },
  },
  async ({ seq }) => {
    const task = bySeq(seq);
    return task ? text(buildPrompt([task])) : text(`没有 #${seq} 这条任务。`);
  },
);

server.registerTool(
  "update_task",
  {
    title: "更新任务状态",
    description:
      "回写进度。做完置 done，做不了置 ignored 并在 note 里说明原因。" +
      "note 是任务的「当前结论」，每次调用会整体覆盖上一次的 note（历次内容都留在沟通记录里，不会丢），" +
      "所以要一次写完整：改了哪些文件、做了什么、结论是什么。",
    inputSchema: {
      seq: z.number().int().positive(),
      status: z.enum(["doing", "done", "ignored"]).optional(),
      note: z.string().optional(),
    },
  },
  async ({ seq, status, note }) => {
    const task = bySeq(seq);
    if (!task) return text(`没有 #${seq} 这条任务。`);
    const prevStatus = task.status;
    const patch = {};
    if (status) patch.status = status;
    if (note) {
      patch.note = note;
      appendThread(task.id, {
        role: "assistant",
        text: note,
        at: Date.now(),
      });
    }
    if (!Object.keys(patch).length) return text("没给要改的东西。");
    const updated = updateTask(task.id, patch);

    // 完成/忽略时发送飞书通知（优先使用卡片与 Thread 回复）
    if (
      (status === "done" || status === "ignored") &&
      prevStatus !== status
    ) {
      const settings = getSettings();
      if (settings.ackEnabled && settings.notifyOnComplete) {
        const cleanNote = String(updated.note || note || "").trim();
        const fallbackMsg =
          status === "done"
            ? `✅【完成】你提的 #${updated.seq}「${updated.title}」已处理完成。${
                cleanNote ? `\n\n处理说明：\n${cleanNote}` : ""
              }`
            : `⏸️【忽略】你提的 #${updated.seq}「${updated.title}」已置为忽略。${
                cleanNote ? `\n\n原因说明：\n${cleanNote}` : ""
              }`;
        const card =
          status === "done"
            ? buildDoneCard({
                task: updated,
                note: cleanNote,
                modifiedFiles: updated.modifiedFiles || [],
                branchName: updated.branchName || "",
              })
            : buildIgnoredCard({ task: updated, reason: cleanNote });

        sendMessage({
          chatId: updated.chatId,
          openId: updated.requester?.id,
          card,
          text: fallbackMsg,
          replyMessageId: updated.messageId,
        }).catch((err) => console.error("[docking-mcp] 发送完成回执失败", err));
        appendThread(updated.id, { role: "me", text: fallbackMsg });
      }
    }

    return text(
      `#${updated.seq} 已更新为「${STATUS_TEXT[updated.status]}」。`,
    );
  },
);

server.registerTool(
  "ask_requester",
  {
    title: "飞书反问提出人",
    description:
      "需求说不清、不足以动手时，用这个直接在飞书上问提出人，不要靠猜。" +
      "**这会真的发出一条飞书消息**。问完任务转为 awaiting，你这轮就到此为止——" +
      "对方的回复会自动挂回任务，等他回了我会再叫你。",
    inputSchema: {
      seq: z.number().int().positive(),
      question: z.string().min(1).describe("要问的话，具体、一次问清"),
    },
  },
  async ({ seq, question }) => {
    const task = bySeq(seq);
    if (!task) return text(`没有 #${seq} 这条任务。`);
    if (!getSettings().ackEnabled) {
      return text(
        "面板上的「自动回复」是关的，没有发送。请把问题写进你的最终回答里，由人去问。",
      );
    }
    const card = buildAskCard({ task, question });
    const fallbackText = `【确认】关于你提的「${task.title}」：\n${question}`;
    const res = await sendMessage({
      chatId: task.chatId,
      openId: task.requester?.id,
      card,
      text: fallbackText,
      replyMessageId: task.messageId,
    });
    if (!res.ok) return text(`飞书发送失败：${res.error}`);
    appendThread(task.id, { role: "me", text: question });
    updateTask(task.id, { status: "awaiting", askedAt: Date.now() });
    return text(`已问 ${task.requester?.name || "提出人"}，#${seq} 转为「等回复」。`);
  },
);

await server.connect(new StdioServerTransport());
console.error("[docking-mcp] ready");
