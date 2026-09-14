// AI 工单台周报 / 工作量聚合与 Markdown 格式化工具

/**
 * 根据指定时间区间生成结构化工作量 Markdown 报告
 * @param {Array} tasks
 * @param {'this_week' | '7days' | 'this_month' | 'all'} range
 */
export function generateDockingReport(tasks = [], range = "this_week") {
  const now = Date.now();
  let startTime = 0;

  if (range === "this_week") {
    const d = new Date();
    const day = d.getDay() || 7; // Monday is 1, Sunday is 7
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (day - 1));
    startTime = d.getTime();
  } else if (range === "7days") {
    startTime = now - 7 * 24 * 60 * 60 * 1000;
  } else if (range === "this_month") {
    const d = new Date();
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    startTime = d.getTime();
  } else {
    startTime = 0; // all
  }

  const inRange = tasks.filter((t) => (t.updatedAt || t.createdAt || 0) >= startTime);
  const doneTasks = inRange.filter((t) => t.status === "done");
  const doingTasks = inRange.filter((t) => t.status === "doing" || t.status === "inbox");
  const awaitingTasks = inRange.filter((t) => t.status === "awaiting");
  const ignoredTasks = inRange.filter((t) => t.status === "ignored");

  // 改动文件统计
  const allModifiedFiles = new Set();
  for (const t of doneTasks) {
    for (const f of t.modifiedFiles || []) {
      allModifiedFiles.add(f);
    }
  }

  // 按提出人聚合
  const requestersMap = {};
  for (const t of inRange) {
    const name = t.requester?.name || t.requester?.id || "未知";
    requestersMap[name] = (requestersMap[name] || 0) + 1;
  }

  const rangeTitleMap = {
    this_week: "本周",
    "7days": "近 7 天",
    this_month: "本月",
    all: "全部",
  };

  const lines = [
    `# AI 工单台工作量周报 / 汇总（${rangeTitleMap[range] || "全部"}）`,
    ``,
    `> **统计概览**：共对接 **${inRange.length}** 项需求/咨询 | 已闭环完成 **${doneTasks.length}** 项 | 进行中 **${doingTasks.length}** 项 | 改动代码文件 **${allModifiedFiles.size}** 个`,
    ``,
    `---`,
    ``,
    `### 一、 ✅ 已完成需求与逻辑排查 (${doneTasks.length})`,
  ];

  if (doneTasks.length === 0) {
    lines.push(`*(该时间段内暂无已完成任务)*`);
  } else {
    doneTasks.forEach((t, i) => {
      const who = t.requester?.name || t.requester?.id || "提出人";
      const branch = t.branchName ? ` · 🌿 \`${t.branchName}\`` : "";
      lines.push(`${i + 1}. **#${t.seq} ${t.title}** (${who}${branch})`);
      if (t.note) {
        lines.push(`   - 💡 **结论/改动**：${t.note.split("\n")[0]}`);
      }
      if (t.modifiedFiles && t.modifiedFiles.length > 0) {
        lines.push(
          `   - 🛠️ **改动文件**：${t.modifiedFiles
            .slice(0, 3)
            .map((f) => `\`${f}\``)
            .join(", ")}${
            t.modifiedFiles.length > 3
              ? ` 等共 ${t.modifiedFiles.length} 个文件`
              : ""
          }`,
        );
      }
    });
  }

  lines.push(``);
  lines.push(`### 二、 ⏳ 进行中 / 待处理需求 (${doingTasks.length + awaitingTasks.length})`);
  const activeList = [...doingTasks, ...awaitingTasks];
  if (activeList.length === 0) {
    lines.push(`*(暂无进行中需求)*`);
  } else {
    activeList.forEach((t, i) => {
      const who = t.requester?.name || t.requester?.id || "提出人";
      const statusText =
        t.status === "awaiting"
          ? "等回复"
          : t.status === "doing"
            ? "进行中"
            : "待处理";
      lines.push(`${i + 1}. **#${t.seq} ${t.title}** [${statusText}] (${who})`);
    });
  }

  lines.push(``);
  lines.push(`### 三、 👥 提出人分布`);
  const requesterEntries = Object.entries(requestersMap).sort((a, b) => b[1] - a[1]);
  if (requesterEntries.length > 0) {
    lines.push(
      requesterEntries.map(([name, count]) => `• **${name}**：${count} 次`).join("\n"),
    );
  } else {
    lines.push(`*(暂无数据)*`);
  }

  return {
    markdown: lines.join("\n"),
    metrics: {
      total: inRange.length,
      done: doneTasks.length,
      doing: doingTasks.length,
      awaiting: awaitingTasks.length,
      ignored: ignoredTasks.length,
      filesCount: allModifiedFiles.size,
    },
  };
}
