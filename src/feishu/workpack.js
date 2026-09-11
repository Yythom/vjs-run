// req-to-plan 工作包 → 赛博牛马任务的翻译层。
//
// 两个入口共用这一份：飞书里的 /plan 指令（listener 备完料直接建任务），
// 和命令行的 scripts/req-to-docking.mjs（req watch --exec 的下游）。
// 各写一份的话，正文格式、附件口径和去重锚点迟早漂移。
//
// 不 import electron：命令行入口是独立 node 进程。

import fs from "node:fs";
import path from "node:path";
import { listTasks } from "./task-store.js";

/**
 * 正文里这一行既是给 agent 看的路径，也是幂等去重的锚点：
 * 重复备料（watch-state 被清、同一条需求 /plan 了两次）不该在面板上堆出两条一样的任务。
 */
export const workpackLine = (dir) => `工作包目录：${dir}`;

/** 工作包里的固定产物。缺 context.md 就不是一个合法工作包——它是 agent 的入口。 */
export function readWorkpack(dir) {
  const contextPath = path.join(dir, "context.md");
  if (!fs.existsSync(contextPath)) {
    throw new Error(`不是一个 req-to-plan 工作包（缺 context.md）: ${dir}`);
  }
  const context = fs.readFileSync(contextPath, "utf8");

  // 需求名只从 context.md 的标题取。需求池的结构化字段（业务线、方案链接）全在
  // context.md 里，这里不重新解析一遍：翻译层只负责路由，语义留给读它的 agent。
  const title =
    context.match(/^#\s*工作包:\s*(.+)$/m)?.[1]?.trim() || path.basename(dir);

  const requirementPath = path.join(dir, "requirement.md");
  const skillPath = path.join(dir, "skill.md");
  const assetsDir = path.join(dir, "assets");
  const assets = fs.existsSync(assetsDir)
    ? fs
        .readdirSync(assetsDir)
        .filter((name) => !name.startsWith("."))
        .sort()
        .map((name) => path.join(assetsDir, name))
    : [];

  return {
    title,
    contextPath,
    requirementPath: fs.existsSync(requirementPath) ? requirementPath : "",
    skillPath: fs.existsSync(skillPath) ? skillPath : "",
    assets,
    planUrl: context.match(/^-\s*方案文档:\s*(\S+)$/m)?.[1] || "",
  };
}

/**
 * 任务正文。
 *
 * 会被 prompt.js 的 renderTask 整段按 `  > ` 引用进「原始需求」。刻意写得薄：
 * 工作规范（怎么检索、怎么对账、澄清清单怎么收）由 runner 从工作包的 skill.md 注入
 * system prompt，这里再抄一遍只会跟它打架。正文只交代三件事——
 * 这是什么、材料在哪、产出是什么。
 */
function buildContent({ dir, recordId, pack, remark }) {
  return [
    "【需求池工作包】这条不是飞书 IM 提问，是需求池里流转到「排实施」的正式需求。",
    "**产出是一份实施 plan，不是代码改动。**",
    "",
    workpackLine(dir),
    recordId ? `需求池 record_id：${recordId}` : null,
    pack.planUrl ? `方案文档：${pack.planUrl}` : null,
    "",
    `- 入口：${pack.contextPath}（需求元信息、业务线对应的仓库 token、影响面检索命令都在里面）`,
    pack.requirementPath ? `- 需求正文：${pack.requirementPath}` : null,
    // 派活时 runner 会把它注入 system prompt，但「复制 prompt」出去粘到别处用的话
    // 那份规范就完全不见了——所以路径要写在正文里
    pack.skillPath ? `- 工作规范：${pack.skillPath}（产 plan 必读；派活时已注入，复制走用要自己读）` : null,
    pack.assets.length
      ? `- 截图 ${pack.assets.length} 张在 assets/，**必须逐张 Read**：尺寸上限、字数限制、按钮态、空态文案这些界面约束，正文一个字都不会写，只存在于图里。`
      : "- 本需求没有截图。",
    `- 产出：${path.join(dir, "plan.md")}`,
    // 提出人在指令里顺带说的那句话。他是看着需求文档说的，往往比文档本身更能决定
    // plan 该往哪写——放在最后、紧挨着后续指令，注意力最好
    remark ? "" : null,
    remark ? "⚡ 提出人在指令里另外交代了一句，这是本次的重点，plan 要正面回应它：" : null,
    remark ? `> ${remark.split("\n").join("\n> ")}` : null,
    "",
    "派活请用「产 plan」档 + Claude Code 引擎：影响面扫描要起 node 子进程，只有这一档",
    "预授权了 node，又不像「全自动」那样把 Bash 全放开。",
  ]
    // 空串是刻意留的段落分隔，只能滤掉条件分支产出的 null
    .filter((line) => line !== null)
    .join("\n");
}

/** 工作包里的文件挂成附件：prompt.js 会渲染成「可直接读取此本地文件」，路径必须是绝对的。 */
function buildAttachments(pack) {
  const files = [
    { type: "file", name: "context.md", path: pack.contextPath },
    pack.requirementPath
      ? { type: "file", name: "requirement.md", path: pack.requirementPath }
      : null,
  ].filter(Boolean);

  const images = pack.assets.map((p) => ({
    type: "image",
    name: path.basename(p),
    path: p,
  }));

  return [...files, ...images];
}

/**
 * 已经为这个工作包建过任务吗。
 *
 * 不用 processedMessageIds 当账本：那是 500 条的环形缓冲、跟真实飞书消息 id 共用，
 * 塞非 IM 的 key 进去会把真实 id 挤掉，反而让飞书那边重复建任务。
 */
export function findWorkpackTask(dir) {
  const anchor = workpackLine(dir);
  const resolvedDir = path.resolve(dir);
  return (
    listTasks().find(
      (t) =>
        t.source === "req-pool" &&
        (t.workpackDir
          ? path.resolve(t.workpackDir) === resolvedDir
          : String(t.content || "").includes(anchor)),
    ) || null
  );
}

/**
 * 工作包 → { task, pack }。
 *
 * remark 是提出人在 /plan 指令里顺带说的话（「帮我看看有没有要改的」），会渲染进正文；
 * 命令行入口没有这种上下文，不传即可。
 *
 * task 是 addTask 参数里跟工作包有关的那部分；来源信息（messageId / chatId /
 * senderId / status）由调用方按自己的入口补齐——/plan 来的有真实飞书会话，
 * 命令行来的没有。pack 一并给出去，调用方打日志、回执时要用。
 */
export function buildWorkpackTask({ dir, recordId = "", repoPath = "", remark = "" }) {
  const pack = readWorkpack(dir);
  return {
    pack,
    task: {
      source: "req-pool",
      title: pack.title,
      content: buildContent({ dir, recordId, pack, remark: String(remark || "").trim() }),
      attachments: buildAttachments(pack),
      // 非空 = runner 会 --add-dir 放行这个目录，并把里面的 skill.md 注入 system prompt
      workpackDir: dir,
      repoPath,
    },
  };
}
