# 改动测试台 · 第一期实现方案

在 vjtools 里加一个「改动测试」页：选仓库和提交范围，一键派给 T3 Code 按 `commit-range-test` 跑；跑到确认点后，在界面上把清单当矩阵看、勾要测的模块和站、写调整意见，再一键回给 T3 继续。

## 定位与边界

- **vjtools 不跑 AI，只做三件事**：调 `t3` 命令行起线程 / 回消息 / 查状态；读 `~/test-records/` 下的产物文件；把清单渲染成可操作的界面。
- **规则只在 skill 里**。删行、改预期、改「阶段」行、重跑 `check`，都由 T3 里的 agent 照 skill 做；界面只负责把使用者的决定整理成一条文字回复发过去，不直接改清单 markdown。
- **状态以文件为准**。清单头的「阶段」行、结果格、`coverage.mjs` 的统计就是唯一状态，界面不另存一份进度。中断、重开 app、在 T3 里手动推进，界面都能对上。
- **不新增 vjtools CLI 命令**。底下的命令行就是 `t3` 和 `coverage.mjs`，再包一层没有收益；唯一的 CLI 改动是给 `coverage.mjs` 加 `--json`（见 M0）。

第一期包含：发起、运行状态、确认点矩阵与回复、历史列表。
第二期再做：实测证据查看（点格子看 log 段落和截图）、一键回归（第 9 步）、按模块分批推进的大范围模式。
第一期的矩阵读的就是实时文件，所以确认开测后 ✅ / ❌ 会自然刷出来，只是还没有证据面板。

## 已实测的前提（2026-11-24 探针）

| 事实 | 对方案的影响 |
|---|---|
| `t3` v0.1.11，T3 Code 桌面端常驻；vjs-monorepo 已是 T3 项目 | 起线程直接传仓库路径，不用 `project add` |
| provider `magpie`（driver=claudeAgent）自动加载 `~/.claude/skills`，能照 skill 做 | 默认 provider 用 magpie |
| `claude-opus-5-5` 不在套餐里（403）；`deepseek-v4.1-flash-fast` 可用 | 默认模型 DeepSeek 4.1，可在设置里改 |
| `--wait` 退出码：0 完成 / 1 失败 / 2 等回答 | 界面只把 0 当正常回合结束 |
| **agent 用提问工具时，`t3 thread send` 答不了**，线程卡在 `pendingRequestCount=1` | 提示词里禁止用提问工具；万一卡住，界面提示去 T3 里答 |
| `thread show --json` 在等回答时 `status` 仍是 `running`，要看 `pendingRequestCount` | 状态推导规则见下文 |
| 线程默认 `runtimeMode: full-access` | 第二阶段不会中途弹审批 |

## 用户流程

1. **发起**：侧栏「改动测试」→「新建」弹框：
   - 仓库：从 `frontendProjectGroups` 选（拿到 `repoPath`）
   - 范围：三选一，每项带提交数——领先 `origin/develop`（0 个时置灰）/ 最近 N 个 / 在提交列表里勾起止
   - 主题：默认从提交标题取短名，可改
   - provider / 模型：默认取设置
   - 提交后：写 sidecar，调 `t3 thread start`，跳到详情页
2. **第一阶段运行中**：详情页顶部状态条（运行中 · 已用时 · 最新一条 agent 消息摘要）+「在 T3 中打开」。三个产物文件一出现就开始渲染。
3. **确认点**：判定条件 = 线程回合结束（`status=completed`、`pendingRequestCount=0`）且清单「阶段」行是「待确认」。此时显示：
   - 三层覆盖率数字（`check --json` / `status --json`）
   - 「请重点看」：`check` 的「已写原因」「标了 —」「提醒」，以及标了【测试服】【真机】【线上】的行
   - 清单矩阵 + 回复编辑器（见下）
4. **回复**：两个按钮——「按调整重出清单」（只发调整，不确认）和「确认开测」（发调整 + 确认）。都走 `t3 thread send`。
5. **开测后**：矩阵随文件实时刷新；状态条显示 `已出结果 x/K 格`。

## 界面

### 列表页 `/range-test`

按仓库分组列出 `~/test-records/<仓库>/<主题>/`：主题、范围、阶段（待确认 / 已确认 / 无清单）、进度条、线程状态、更新时间。没有 sidecar 的旧记录（以前在对话里跑的）也列出来，只是没有「回复」能力，可「在对话里继续」。

### 详情页 `/range-test/:repo/:topic`

- **状态条**：线程状态 + 最新消息摘要 + 「在 T3 中打开」+ 错误信息（如 403）
- **覆盖率卡**：三层数字，第一层不到 N/N 时标红
- **清单矩阵**：行 = 清单条目（按模块分组、可折叠），列 = 编号 / 前置 / 操作 / 预期 / 原来怎样 / 各站结果格。124 行量级不必虚拟化；超过 300 行再上 `@tanstack/react-virtual`
- **回复编辑器**（确认点才出现）：
  - 范围勾选：模块（分组字母）× 站（结果列），默认全选
  - 行内操作：删除（必填原因）/ 改预期（文本）/ 提问（文本）
  - 补充说明：自由文本
  - 底部实时预览将要发出的文字

回复文字示例：

```text
确认开测。
调整：
- 删 A3：纯运营文案
- A5 预期改为：弹框默认选中 500
- 只测模块 A、B；站只测 视频、音乐（其余格保持 ⬜，按 skill 记为使用者定的）
补充：充值弹框的埋点先不管。
```

回复编辑器是动态字段表单，按约定用 react-hook-form + zod（`useFieldArray` 管行内操作），草稿不进 zustand 顶层 state。

## 提示词模板（`prompt.js`）

首条消息由 UI 已经算好的范围填进去，所以第 1 步不会再问范围：

```text
用 commit-range-test 测这段改动。
- 仓库：<repoPath>
- 范围：<base>..<tip>（<N> 个提交，已由使用者在界面上选定，不用再问范围）
- 主题：<topic>；产物目录：~/test-records/<repoName>/<topic>/
- 这次由 vjtools 界面驱动：需要问使用者时，用普通文字写出问题后结束本轮，不要用提问工具（界面答不了提问工具）。
- 做到确认点就停，等界面回复。
```

确认 / 调整的回复也走同一条规则：每条 `send` 末尾都带一句「需要问时用普通文字」的提醒，防止长会话里被淡忘。

## 主进程

### 新文件

| 文件 | 职责 |
|---|---|
| `src/services/t3-cli.js` | 包一层 `t3`：`startThread`、`sendMessage`、`showThread`。用 `buildSpawnEnv()` 拿 PATH；`--json` 解析；错误归类（未安装 / T3 未运行 / 模型不在套餐 / 其他） |
| `src/services/range-test/git.js` | 候选范围：`git fetch origin`、领先 `origin/develop` 的提交数与 merge-base、最近 30 个提交列表（sha / 作者 / 日期 / 标题） |
| `src/services/range-test/prompt.js` | 首条消息与回复的模板；回复由结构化的调整对象拼成文字 |
| `src/services/range-test/records.js` | 扫描 `~/test-records/`、读写 sidecar、chokidar 监听产物目录，变更推送到渲染层 |
| `src/services/range-test/coverage.js` | 定位 skill（`~/.claude/skills/commit-range-test` 取 realpath），跑 `coverage.mjs status/check --json` |
| `src/services/range-test/poller.js` | 对「运行中」的线程每 4 秒 `t3 thread show --messages 1 --json`，状态变了推送；回合结束即停。app 启动时对 sidecar 里记着运行中的线程恢复轮询 |
| `src/ipc/range-test.js` | 注册下面的 IPC，在 `src/ipc/index.js` 里挂上 |

### sidecar：`<产物目录>/.vjtools-run.json`

```json
{ "repoKey": "vjs", "repoPath": "/Users/…/vjs-monorepo", "topic": "latest-5",
  "base": "…", "tip": "…", "threadId": "mcp:…", "threadLink": "https://app.t3.codes/…",
  "provider": "magpie", "model": "commandcode/deepseek/deepseek-v4.1-flash-fast[1m]",
  "createdAt": "…", "lastStatus": "running" }
```

放在产物目录而不是 `config.json`：一条记录的一切都在同一个目录里，删目录即删记录，也不用动 `normalize.js`。产物目录本来就不进仓库，sidecar 不会被误提交。

### IPC

| channel | 入参 | 出参 |
|---|---|---|
| `range-test-candidates` | `{ repoKey }` | `{ repoPath, branch, head, ahead: { ref, base, count } \| null, commits, fetchError }` |
| `range-test-start` | `{ repoKey, range: { kind, count?, from?, to? }, topic }` | `{ dir, threadId }`（provider / model 取设置） |
| `range-test-list` | — | `{ records, recordsDir }` |
| `range-test-detail` | `{ dir }` | `{ record, status, statusError, thread, threadError }` |
| `range-test-check` | `{ dir }` | `{ check }`（慢，只在确认点按需调） |
| `range-test-reply` | `{ dir, reply }` | — |
| `range-test-open-thread` | `{ dir }` | 用浏览器打开 T3 线程 |
| 推送 `range-test-changed` | — | `{ dir, kind: "files" \| "thread" \| "thread-error", … }` |

全部用现有的 `ipcSafe` 包，preload 里按现有分区加一段「改动测试」。

### 线程状态推导

| `thread show` | 界面状态 |
|---|---|
| `status=running` 且 `pendingRequestCount=0` | 运行中 |
| `status=running` 且 `pendingRequestCount>0` | 卡在提问工具 → 提示「去 T3 里回答」 |
| `status=completed` + 阶段「待确认」 | 确认点 |
| `status=completed` + 阶段「已确认」 | 已结束本轮（看进度判断是暂停还是完成） |
| `status=failed` | 失败，显示 `error` |

### 配置

`config.json` 加 `rangeTest: { provider, model, recordsDir }`，默认 `magpie` / DeepSeek 4.1 / `~/test-records`。**`defaults.js` 和 `normalize.js` 要一起改**（白名单式重建，漏了会被静默丢弃），渲染层 `app-config-store.js` 的默认值也补上。三个输入项放在改动测试列表页的「T3 设置」面板，不放进「服务设置」：那张表单是 mock 的，保存时牵涉 mock 重启。

## 渲染层

| 文件 | 内容 |
|---|---|
| `renderer/src/pages/range-test/range-test-list-page.jsx` | 列表页 |
| `renderer/src/pages/range-test/new-run-modal.jsx` | 发起弹框（RHF + zod），挂在 `ModalRoutes` |
| `renderer/src/pages/range-test/run-detail-page.jsx` | 详情页骨架：状态条 + 覆盖率卡 + 矩阵 + 回复编辑器 |
| `renderer/src/pages/range-test/checklist-matrix.jsx` | 矩阵 |
| `renderer/src/pages/range-test/reply-composer.jsx` | 回复编辑器 + 预览 |
| `renderer/src/stores/range-test-store.js` | 只存主进程推来的记录与线程状态（zustand），表单草稿不放这里 |
| `app-shell.jsx` / `sidebar.jsx` | 加路由和侧栏入口（lazy chunk） |

写法照 code-design：状态由文件推送派生，不在 effect 里串联请求；切换记录用 `key={dir}` 让表单自然重置。

## skill 侧改动（M0，在 `~/.config/magpie/library/skills/commit-range-test`）

- `coverage.mjs status --json`：输出 `{ phase, items: [{ id, group, cols: {前置, 操作, 预期, 原来怎样}, cells: { 站: mark } }], sites, totals, perSite, ... }`
- `coverage.mjs check --json`：输出三层数字、报错、已写原因、标了「—」、提醒
- 补 `coverage.test.mjs` 对应用例
- 这样界面不用再写一份 markdown 解析器，格式规则只有一处

## 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M0 | `coverage.mjs` 加 `--json` | `coverage.test.mjs` 通过；对 `latest-10-commits` 那份真实清单输出 124 条 / 267 格 |
| M1 | 主进程：t3-cli、git、prompt、records、poller、IPC | `node --test` 覆盖 prompt 拼接、`thread show` 状态推导、t3 错误归类、sidecar 扫描；真起一个 DeepSeek 线程能拿到 threadId 并轮询到结束 |
| M2 | 列表页 + 发起弹框 + 详情页状态条 | 在预览里发起一次，状态从运行中走到确认点 |
| M3 | 矩阵 + 回复编辑器 + 两个回复按钮 | 对真实线程发一次「按调整重出清单」，agent 改完、`check` 通过、矩阵刷新 |
| M4 | 「T3 设置」三项 + 错误提示（未装 t3、T3 未开、模型 403、卡在提问工具） | 逐个造出错误场景看提示 |

端到端验证用 vjs-monorepo 最近 1～2 个提交的小范围、DeepSeek 4.1；只验证到「按调整重出清单」，**不点「确认开测」**——那会进第二阶段，切 mock 场景、起 dev server、种假 cookie。vjtools 本身的数据用 `VJTOOLS_USER_DATA_DIR` 隔离，不碰真实 `config.json`。

## 实现状态（2026-11-24）

M0～M4 已实现。回复预览直接复用主进程的 `src/services/range-test/prompt.js`（渲染层已有引用 `src/` 纯函数模块的先例），不另写一份。

## 待定（已按推荐定下）

1. 第一期就放「确认开测」按钮，还是第一期只给「按调整重出清单」、确认开测仍去 T3 里说？（放进来几乎零成本，但第一期没有证据面板，开测后只能看格子变色。）
2. 产物目录用 sidecar 文件记线程信息，可以吗？
3. 在 main 上开分支做（不依赖 `feat/cyber-niuma` 的 runner），可以吗？
