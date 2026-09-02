// 勾选的任务 → 一段可直接丢给模型的 prompt。
//
// 只做拼装、不自动执行：派活前我要能先读一遍、随手改两句。
// 澄清记录（我反问 / 对方回答）也一并带上——那些往往才是需求里真正关键的约束。

function formatTime(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

function renderThread(task) {
  // 首条就是原始需求，已经单独渲染过，这里渲染后续所有沟通、AI答复与追问指令
  const thread = (task.thread || []).slice(1);
  if (!thread.length) return "";
  const lines = thread.map((entry) => {
    let who = `${task.requester?.name || "提出人"}回复/指令`;
    if (entry.role === "me") who = "我追问/说明";
    else if (entry.role === "assistant") who = "AI 上一轮分析与回复";
    else if (entry.role === "system") who = "系统记录";
    const timeStr = entry.at ? ` (${formatTime(entry.at)})` : "";
    return `  - **[${who}${timeStr}]**：\n    ${String(entry.text || "").trim().split("\n").join("\n    ")}`;
  });
  return `- 飞书多轮沟通与指令历史：\n${lines.join("\n\n")}`;
}

function renderAttachments(task) {
  const attachments = task.attachments || [];
  if (!attachments.length) return "";
  const lines = attachments.map((att) => {
    const kind = att.type === "image" ? "图片/截图" : "附件文件";
    const p = att.path || att.name;
    return `  - [${kind}] \`${att.name}\`：\`${p}\` (可直接使用工具读取或查看此本地文件)`;
  });
  return `- 需求附件与截图：\n${lines.join("\n")}`;
}

function renderTask(task, index) {
  const who = task.requester?.name || task.requester?.id || "未知发起人";
  const thread = task.thread || [];
  const latestEntry = thread.length > 1 ? thread[thread.length - 1] : null;
  const isFollowup = latestEntry && (latestEntry.role === "them" || latestEntry.role === "me");

  return [
    `### ${index + 1}. ${task.title}`,
    ``,
    `- 提出人：${who}`,
    `- 提出时间：${formatTime(task.createdAt)}`,
    task.branchName ? `- 隔离分支：\`${task.branchName}\`` : "",
    `- 原始需求：`,
    String(task.content || "")
      .trim()
      .split("\n")
      .map((line) => `  > ${line}`)
      .join("\n"),
    renderAttachments(task),
    renderThread(task),
    isFollowup
      ? `\n> ⚡ **当前最新一轮指令/追问**：${String(latestEntry.text || "").trim()}\n> 请基于前序排查与上下文，重点执行上述最新指令（若要求修改代码，请直接定位对应文件并完成修改）！`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildPrompt(tasks = []) {
  if (!tasks.length) return "";

  const header = [
    "以下是同事通过飞书提给我的项目需求或代码逻辑排查咨询任务，请逐条分析并处理：",
    "",
    "要求与处理原则：",
    "1. **逻辑排查 / 疑问解答类**：",
    "   - 检索并通读相关代码，梳理清晰完整的业务逻辑流转链路。",
    "   - 明确指出涉及的关键文件路径、函数名及关键判断条件，并给出详尽准确的排查结论。",
    "2. **需求开发 / 代码改动类**：",
    "   - 先通读需求与澄清记录，确认改动范围，不要臆测未明确的边界。",
    "   - 涉及接口变更的，明确写清方法、路径、请求/响应字段及页面交互逻辑。",
    "3. **信息不足时**：直接列出需要向提出人反问的问题（可通过 ask_requester 直接发飞书）。",
    "",
    "---",
    "",
    "",
  ].join("\n");

  return `${header}${tasks.map(renderTask).join("\n\n")}\n`;
}
