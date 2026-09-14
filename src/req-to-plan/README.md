# req-to-plan

飞书需求 → 实施 plan。自包含、可整体迁移，**被分析的仓库不需要安装任何东西**。

`src/` 不含任何具体项目的假设；项目相关的一切（需求池、仓库结构、业务线、经验）
都在项目配置目录里。换一个项目 = 新建一个配置目录，代码不动。

## 结构

```
bin/req                 统一入口
src/
├── config.mjs          项目配置加载
├── intake/             需求侧：需求池、文档读取、工作包、轮询
├── impact/             影响面：孪生、检索、业务线对称、同名实现、仓库事实
└── skill/              产 plan 的工作规范 + plan 模板（运行时注入）
vjs-monorepo-run/       ← 项目配置目录
├── pool.config.json    需求池：base token、状态字段、字段名、业务线映射
├── repo.config.json    仓库结构：目录布局、业务线 token、通用文件名、接口检索命令
└── notes.md            项目经验：词汇错位、已知瑕疵、本仓库特有的坑
```

## 装

没有 npm 依赖，把这个目录整个拷到任意位置就能跑。

它现在同时是 vjtools（AI 工单台）的一部分，随 `src/**` 一起打包，所以飞书里的
`/plan` 指令能直接调它备料——那条路径用 Electron 当 node 跑（`ELECTRON_RUN_AS_NODE=1`），
才读得到打包进 asar 的这个目录。自己在命令行用则照常：

```bash
export REQ_REPO_ROOT=/path/to/your-repo      # 被分析的仓库
alias req="node /path/to/vjs-run/src/req-to-plan/bin/req"
```

前置条件：

| 依赖 | 说明 |
| --- | --- |
| Node ≥ 20 | 用了 `parseArgs`，无第三方依赖 |
| `lark-cli` 已认证 | `lark-cli auth status --verify` 应返回 user ready |
| `claude` CLI | 仅 `req plan` 需要；其余命令不依赖 |
| 目标仓库的本地副本 | 影响面分析要读文件，不能只靠 API |

飞书 refresh token 是滚动的，只要**至少每 7 天**跑一次就不必重新授权。

## 用

```bash
req plan "https://xxx.feishu.cn/wiki/<token>"    # 一条链接直接出 plan
req plan rec27zFqrO7jDS                          # 也接 record_id 或需求名关键词
```

产出落在 `.requirements/<record_id>/`：

```
context.md        任务简报（agent 的入口）
requirement.md    需求正文（树形，图片已就地引用）
requirement.json  结构化数据
assets/           截图
plan.md           ← 最终产出
```

其他命令：

```bash
req pool            # 看需求池里「排实施」有哪些
req prepare <目标>  # 只备料，不调 Claude（省 token）；--json 把工作包路径打到 stdout
req watch           # 轮询新流转进「排实施」的需求，批量备料
```

## 接 AI 工单台

`req plan` 是自己调 claude 产 plan，跑完就结束——没有队列、没有隔离分支、没有面板、
反问也没地方回。要那些东西就把工作包交给 AI 工单台，它的「产实施 plan」力度档就是为此加的
（放行 `Bash(node:*)` 跑影响面扫描，禁掉改现存文件）：

```bash
# 单条：直接在飞书里发指令，vjtools 自己备料建任务
/plan https://xxx.feishu.cn/wiki/<token>

# 批量：轮询需求池，每备好一个就塞进任务库
req watch --exec 'node /path/to/vjs-run/scripts/req-to-docking.mjs --repo <被分析仓库>'
```

工作包里的 `skill.md` 是 prepare 阶段渲染的（占位符已填），AI 工单台会把它注入
agent 的 system prompt，所以两条路径产出的 plan 遵循同一份规范。

影响面工具可以单独用，跟需求流程无关：

```bash
req scan locate "未知错误" --scope "upload,optimization"
req scan siblings "apps/xxx/components/upload-list.tsx"
req scan mirror "optimization" --from video --to foto
req scan twins
```

## skill 怎么注入

`src/skill/SKILL.md` 在 `req prepare` 时读出来、替换占位符后写进工作包的 `skill.md`，
产 plan 时再注入 Claude 的 system prompt，所以目标仓库的 `.agents/skills/` 下**不需要**
放这份 skill。工作包因此是自包含的：`req plan`、AI 工单台的无头进程、或者人手开的一个
会话，谁接手都读到同一份规范。

运行时替换的占位符：

| 占位符 | 来源 |
| --- | --- |
| `$REQ_BIN` / `$REPO_ROOT` / `$WORKPACK` | 本次运行的实际路径 |
| `$REPO_FACTS` | **现场扫描**仓库算出的 app 数、孪生规模、业务线对照表 |
| `$API_SEARCH` / `$API_DETAIL` | `repo.config.json` 的 `apiSearch` |
| `$RULES_FILES` | `repo.config.json` 的 `rules` |
| `$PROJECT_NOTES` | 项目配置目录下的 `notes.md` |

`$REPO_FACTS` 现扫现填而不是写在文档里，是因为那些数字会随代码变化过期，
而 agent 会拿它们当依据判断「要改几处」。扫描约 70ms。

## 换一个项目

新建一个配置目录（例如 `other-repo-run/`），放三个文件：

**`pool.config.json`** —— 需求池在哪、什么状态算就绪、字段叫什么名：

```jsonc
{
  "baseToken": "...",
  "tableId": "...",
  "statusField": "【进程】",
  "readyStatus": "排实施",
  "fields": { "name": "需求名称", "bizLines": "业务线" },
  "bizLineMap": { "视频": "video", "图片": "foto" }
}
```

**`repo.config.json`** —— 仓库长什么样：

```jsonc
{
  "layout": {
    "appsDir": "apps",           // 多应用所在目录
    "appSourceDir": "app",       // 每个应用内的源码目录
    "sourceExtensions": ["ts", "tsx"],
    "skipDirs": ["node_modules", "dist"]
  },
  "bizLines": {
    // tokens[0] 是主 token，其余是代码里的别名；param 是专属路由参数，没有就 null
    "video": { "label": "视频", "tokens": ["video"], "param": "vid" }
  },
  "genericFileNames": ["index.ts", "route.tsx"],
  "apiSearch": { "search": "node ${repoRoot}/...", "detail": "..." },
  "rules": { "entry": "AGENTS.md", "dir": "docs/rules" }
}
```

**`notes.md`**（可选）—— 项目特有的经验，会整段注入 skill。

包内有多个配置目录时用 `--project <目录名>` 或 `REQ_PROJECT` 指定；只有一个时自动发现。

## 已知边界

- `req plan` 需要 `claude` CLI，跑不到没有它的服务器上；服务器只能做到 `req watch` 备料
- 影响面分析基于**字面检索 + 路径结构**，不做语义理解；需求语言与代码语言不一致时要靠 agent 换词
- `impact/` 假定仓库是「多应用 monorepo」（`<appsDir>/<app>/<appSourceDir>/**`）。
  单应用仓库能跑，但孪生检测会失去意义
- 不负责实施，只产出 plan
