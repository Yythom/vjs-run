// AI 工单台页面共用的静态配置表。

// 状态筛选页签。inbox 是默认视图——新需求进来待处理的都在这
export const FILTERS = [
  { key: "inbox", label: "待处理" },
  { key: "unfiled", label: "未识别" },
  { key: "awaiting", label: "已反问" },
  { key: "doing", label: "进行中" },
  { key: "done", label: "已完成" },
  { key: "ignored", label: "已忽略" },
  { key: "all", label: "全部" },
];

export const STATUS_BADGE = {
  inbox: {
    text: "待处理",
    cls: "bg-sky-50 text-sky-700 border-sky-300 font-medium",
  },
  unfiled: {
    text: "未识别",
    cls: "bg-slate-100 text-slate-700 border-slate-300 font-medium",
  },
  awaiting: {
    text: "等回复",
    cls: "bg-amber-50 text-amber-800 border-amber-300 font-medium",
  },
  doing: {
    text: "进行中",
    cls: "bg-violet-50 text-violet-700 border-violet-300 font-medium",
  },
  done: {
    text: "已完成",
    cls: "bg-emerald-50 text-emerald-700 border-emerald-300 font-medium",
  },
  ignored: {
    text: "已忽略",
    cls: "bg-slate-100 text-slate-600 border-slate-300 font-medium",
  },
};

// 可用的无头引擎
export const ENGINES = [
  { key: "claude", label: "Claude Code", desc: "临时注入 MCP，用完即走" },
  { key: "agy", label: "Antigravity", desc: "需预先配置 MCP 权限" },
  { key: "codex", label: "Codex", desc: "OpenAI 官方 CLI，需注册 MCP" },
];

// 执行力度。越往下越自动，也越意味着外部飞书消息能直接驱动本地改动
export const RUN_MODES = [
  {
    key: "analyze",
    label: "只读分析 / 逻辑排查",
    desc: "只读检索代码、梳理逻辑链路并给出结论，不修改任何文件（逻辑排查与咨询首选）",
  },
  {
    key: "plan",
    label: "产实施 plan",
    desc: "读代码 + 跑影响面扫描，产出实施计划写进工作包，不改业务代码（需求池工作包首选）",
  },
  {
    key: "edit",
    label: "允许改代码",
    desc: "自动修改代码实现需求或修复问题，并在结论中附带修改说明与受影响文件",
  },
  {
    key: "full",
    label: "全自动执行",
    desc: "无人值守全自动处理，包含代码修改与命令验证。建议先确认 git 工作区干净",
  },
];

// 档位短标签。历史列表、顶栏这些位置窄的地方用它。
// 不要再写 `mode === "analyze" ? ... : mode === "edit" ? ... : "全自动"` 那种三元链：
// 遇到没见过的档位会一路落到「全自动」，把一个只读的活标成最危险的那档。
export const RUN_MODE_SHORT = {
  analyze: "只读分析",
  plan: "产 plan",
  edit: "改代码",
  full: "全自动",
};

// 自动派发 /r 需求时可选的档位。
//
// 「产实施 plan」不在其中：那一档是为需求池工作包（带 context.md + skill.md）设计的，
// /r 来的 IM 提问没有工作包，选了它只是多放行了 node 子进程，产不出带影响面的 plan。
// /plan 指令自己固定走 plan 档 + Claude Code，也不从这里取。
export const AUTO_DISPATCH_MODES = RUN_MODES.filter((m) => m.key !== "plan");

// 「产实施 plan」档在三个引擎上的实际边界差很大，选之前得知道。
// 它们的力度不是同一套机制：claude 能按工具名禁用，codex 能挑 OS 沙箱策略，
// agy 无头模式下只有「全自动批准」一种。
export const PLAN_MODE_LIMITS = {
  claude: {
    level: "最紧",
    text: "Bash 整个禁掉，跑不了任何命令；影响面扫描走 req_scan 工具（参数结构化，扫哪个仓库由任务决定）。能写文件，但改不了现存文件",
  },
  codex: {
    level: "居中",
    text: "OS 沙箱设为 workspace-write：出不了工作目录与工作包，但范围内可以跑命令、改文件",
  },
  agy: {
    level: "最松",
    text: "无头模式只有「全自动批准」一档，不改业务代码全靠 prompt 约束——建议配合隔离分支",
  },
};
