// 飞书交互式卡片（Interactive Cards）构建模块。
//
// 遵循飞书开放平台 Card JSON 规范（v1 兼容格式），
// 提供状态色标（绿/橙/蓝/灰/青）与清晰 Markdown 内容排版。

/**
 * 需求录入回执卡片（蓝色/青色，支持自动派发态）
 */
export function buildAckCard({ task, autoDispatching = false }) {
  const seq = task.seq || "?";
  const title = task.title || "对接需求";
  const requester = task.requester?.name || task.requester?.id || "未知";
  const repo = task.repoPath ? task.repoPath.split(/[\\/]/).pop() : "智能匹配中";
  const isAuto = Boolean(autoDispatching || task.autoDispatched);

  return {
    config: { wide_screen_mode: true },
    header: {
      template: isAuto ? "turquoise" : "blue",
      title: {
        tag: "plain_text",
        content: isAuto
          ? `⚡【需求已入列并启动 AI 处理】#${seq} ${title}`
          : `📋【需求已记录】#${seq} ${title}`,
      },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `**提出人**：${requester}\n**状态**：${
            isAuto ? "AI 自动排查处理中 ⚡" : "待处理"
          }\n**关联项目**：\`${repo}\``,
        },
      },
      { tag: "hr" },
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: isAuto
            ? `• ⚡ **已自动交由 AI 处理**，完成后将在此回复排查结论\n• 补充说明：发送 \`/u ${seq} 补充内容\` 随时追加`
            : `• 补充说明：发送 \`/u ${seq} 补充内容\` 随时追加\n• 查看任务：发送 \`/u\` 查你的需求列表`,
        },
      },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content: "由 AI 工单台 自动流转",
          },
        ],
      },
    ],
  };
}

/**
 * 反问确认卡片（橙色）
 */
export function buildAskCard({ task, question }) {
  const seq = task.seq || "?";
  const title = task.title || "对接需求";
  const requester = task.requester?.name || task.requester?.id || "提出人";

  return {
    config: { wide_screen_mode: true },
    header: {
      template: "orange",
      title: {
        tag: "plain_text",
        content: `❓【确认】关于 #${seq}「${title}」`,
      },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `**回复**：\n${question || "请进一步澄清该需求细节。"}`,
        },
      },
      { tag: "hr" },
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `💡 **提示**：直接在此消息下回复或私聊发文字，回复会自动挂回该任务并唤醒处理。`,
        },
      },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content: `提出人：${requester}`,
          },
        ],
      },
    ],
  };
}

/**
 * 对接完成卡片（绿色）
 */
export function buildDoneCard({ task, note, modifiedFiles = [], branchName = "" }) {
  const seq = task.seq || "?";
  const title = task.title || "对接需求";
  const cleanNote = String(note || task.note || "").trim();
  const files = modifiedFiles.length > 0 ? modifiedFiles : task.modifiedFiles || [];
  const branch = branchName || task.branchName || "";

  const elements = [];

  if (cleanNote) {
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: `**💡 处理说明 / 排查解答**：\n${cleanNote}`,
      },
    });
  } else {
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: "你提的需求已处理完成。",
      },
    });
  }

  if (files.length > 0) {
    const fileListStr = files.slice(0, 10).map((f) => `• \`${f}\``).join("\n");
    const extra = files.length > 10 ? `\n• *(等共 ${files.length} 个文件)*` : "";
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: `**🛠️ 改动文件 (${files.length})**：\n${fileListStr}${extra}`,
      },
    });
  }

  if (branch) {
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: `**🌿 代码分支**：\`${branch}\``,
      },
    });
  }

  elements.push({ tag: "hr" });
  elements.push({
    tag: "note",
    elements: [
      {
        tag: "plain_text",
        content: "由 AI 工单台 自动处理",
      },
    ],
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      template: "green",
      title: {
        tag: "plain_text",
        content: `✅【完成】#${seq} ${title}`,
      },
    },
    elements,
  };
}

/**
 * 置为忽略卡片（灰色）
 */
export function buildIgnoredCard({ task, reason }) {
  const seq = task.seq || "?";
  const title = task.title || "对接需求";
  const cleanReason = String(reason || task.note || "").trim();

  return {
    config: { wide_screen_mode: true },
    header: {
      template: "grey",
      title: {
        tag: "plain_text",
        content: `⏸️【忽略】#${seq} ${title}`,
      },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: cleanReason
            ? `**原因说明**：\n${cleanReason}`
            : "该需求已被置为忽略。",
        },
      },
      { tag: "hr" },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content: "由 AI 工单台 更新",
          },
        ],
      },
    ],
  };
}

/**
 * 人工排查解答回发卡片（青绿色）
 */
export function buildSolutionReplyCard({ task, text }) {
  const seq = task.seq || "?";
  const title = task.title || "对接需求";
  const requester = task.requester?.name || task.requester?.id || "提出人";

  return {
    config: { wide_screen_mode: true },
    header: {
      template: "turquoise",
      title: {
        tag: "plain_text",
        content: `💡【解答】关于 #${seq}「${title}」`,
      },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `**排查解答 / 答复说明**：\n${text}`,
        },
      },
      { tag: "hr" },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content: `提出人：${requester} · 来自 AI 工单台`,
          },
        ],
      },
    ],
  };
}
