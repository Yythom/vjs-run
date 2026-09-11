// 飞书指令表：唯一事实来源。
//
// 同一套指令原本要在三个地方各写一遍——listener 的 /h 帮助文案、面板顶部的提示栏、
// 以及「没带参数」时的报错提示。加 /plan 那次就漏了面板那条，还顺手把几处
// 「不带 /r 的消息…」写成了错的（那时已经有两个指令了）。
//
// 所以这里定义一次，帮助文案由它生成，面板经 IPC（docking-commands）取同一份来渲染。
// 以后加指令只改这个文件；面板拿不到就不渲染提示栏，也好过显示一份过期的硬编码。
//
// 不 import electron：IPC 层和 listener 都要读它。

/**
 * @typedef {object} Command
 * @property {string} key      指令标识，测试与代码里引用它
 * @property {string} usage    /h 里左栏的完整写法
 * @property {string} help     /h 里右栏的说明
 * @property {{code: string, label: string}} hint  面板提示栏上的短形态
 * @property {{label: string, text: string, notes?: string[]}[]} [examples] /h 末尾的示例
 */

/** @type {Command[]} */
export const COMMANDS = [
  {
    key: "r",
    usage: "/r 需求或排查内容",
    help: "提需求或咨询项目代码逻辑，自动入列并回执短号",
    hint: { code: "/r 内容", label: "提需求/问逻辑" },
    examples: [
      { label: "逻辑排查", text: "/r 帮看下订单状态超时在前端哪里处理的" },
      { label: "需求开发", text: "/r 对接批量打标签接口 /api/user/tags/batch" },
    ],
  },
  {
    key: "plan",
    usage: "/plan 需求文档链接",
    help: "需求池里已定稿的需求 → 实施 plan（自动拉文档、下截图、算影响面）",
    hint: { code: "/plan 链接", label: "需求转 plan" },
    examples: [
      {
        label: "转实施 plan",
        text: "/plan https://xxx.feishu.cn/wiki/xxxxx",
        notes: [
          "也接 record_id 或需求名关键词：/plan 相似推荐",
          "想交代什么写在链接前后都行，会一并带给 AI：",
          "/plan 帮我看看有没有要改的 https://xxx.feishu.cn/wiki/xxxxx",
        ],
      },
    ],
  },
  {
    key: "u",
    usage: "/u",
    help: "查看你提过的需求与咨询列表及短号",
    hint: { code: "/u", label: "查任务" },
  },
  {
    key: "u-seq",
    usage: "/u 7 补充内容",
    help: "给 #7 补充说明",
    hint: { code: "/u 7 补充", label: "补充到 #7" },
  },
  {
    key: "h",
    usage: "/h",
    help: "查看本说明",
    hint: { code: "/h", label: "看帮助" },
  },
];

/** 会建任务的那些指令，用在「不带指令的消息也会留底」这类说明里 */
export const TASK_COMMANDS = ["r", "plan"];

/**
 * 按显示宽度算长度：飞书消息里中文占两个西文字符的位置，
 * 直接 padEnd 按字符数补会让右栏参差不齐。
 */
const displayWidth = (text) =>
  [...String(text)].reduce(
    (sum, ch) => sum + (/[⺀-鿿＀-｠←-⇿①-⓿]/.test(ch) ? 2 : 1),
    0,
  );

const padTo = (text, width) => text + " ".repeat(Math.max(1, width - displayWidth(text)));

/** /h 回过去的用法说明。由 COMMANDS 生成，改指令不用动这里。 */
export function renderHelp() {
  const column = Math.max(...COMMANDS.map((c) => displayWidth(c.usage))) + 2;

  const examples = COMMANDS.flatMap((c) => c.examples || []).flatMap((ex) => [
    `• ${ex.label}：${ex.text}`,
    ...(ex.notes || []).map((note) => `  ${note}`),
  ]);

  const taskCmds = COMMANDS.filter((c) => TASK_COMMANDS.includes(c.key))
    .map((c) => `/${c.key}`)
    .join("、");

  return [
    "项目对接与答疑助手用法：",
    "",
    ...COMMANDS.map((c) => `${padTo(c.usage, column)}${c.help}`),
    "",
    "示例：",
    ...examples,
    "",
    `提示：不带指令（${taskCmds}）的消息也会留底并在待处理中展示。`,
  ].join("\n");
}
