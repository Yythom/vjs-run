// 赛博牛马页面共用的静态配置表。

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
