# vjtools

> 桌面端项目启动控制台 —— 一站式管理本地项目的启动、mock 联调与日志。

基于 Electron 构建,目前**仅支持 macOS(Apple Silicon / arm64)**。

## 功能概览

- **项目控制台** —— 集中启动/停止本地项目进程,实时查看输出日志。
- **Mock 服务** —— 内置 mock server,按「规则」拦截请求返回自定义 JSON,支持路径占位符(`/api/user/{id}`)、热载,以及请求历史回看。
- **配置管理** —— 基于 `electron-store`,配置落在 `~/Library/Application Support/vjtools/config.json`。
- **自动更新** —— 基于 `electron-updater`,设置页可手动检查更新。
- **monorepo 清理** —— 一键清理工作区。

## 开发

依赖 [pnpm](https://pnpm.io/)。

```bash
pnpm install

# 开发模式(Vite 热更新 + Electron,自动 attach inspector)
pnpm dev

# 生产模式本地运行(先构建 renderer 再起 Electron)
pnpm start

# 代码检查
pnpm lint         # 只查 src
pnpm lint:all     # src + renderer
```

## 构建 / 发布

```bash
# 打包 macOS(arm64,产出 dmg + zip 到 dist/)
pnpm build:mac

# 版本号 patch 自增并发布到 GitHub Releases
pnpm release:mac
```

## 目录结构

```
src/
  main.js          # 主进程入口:生命周期编排
  config/          # electron-store 配置读写与 normalize
  ipc/             # 主进程 IPC handler
  mock/            # mock server、规则匹配、请求历史
  services/        # 窗口、自动更新、右键菜单等
renderer/          # 前端(Vite + React),控制台与 mock 配置页
scripts/
  mock-rule.mjs    # CLI:安全增删改运行时 mock 规则
.claude/skills/    # 配套的 Claude Code / Agent skill
```

## Claude Code Skill

本仓库自带 [`mock-rules`](.claude/skills/mock-rules/SKILL.md) skill,让 Claude Code / Agent 直接帮你安全地增删改 mock 规则(改某个接口返回什么、造假数据联调、关掉某条 mock 等),底层走 `scripts/mock-rule.mjs`,带校验、幂等、原子写盘,并自动被 mock server 热载。

### 安装

用 [`skills`](https://github.com/vercel-labs/skills) CLI 从 GitHub 安装(注意命令是 `skills`,复数):

```bash
# 装到当前项目
npx skills add https://github.com/Yythom/vjs-run/tree/main/.claude/skills/mock-rules

# 全局安装(跨项目可用),-g / --global
npx skills add https://github.com/Yythom/vjs-run/tree/main/.claude/skills/mock-rules -g

# 全局 + 指定 agent 为 claude-code,并跳过交互确认
npx skills add https://github.com/Yythom/vjs-run/tree/main/.claude/skills/mock-rules -a claude-code -g -y
```

安装后在 Claude Code 里说「让 `/api/user/profile` 返回 …」「造一份假数据联调」「关掉某条 mock」即可触发。

### 手动直接用 CLI

不装 skill 也可以直接用底层脚本:

```bash
# 列出现有规则
node scripts/mock-rule.mjs list

# 让 GET /api/user/profile 返回自定义数据(response 从 stdin 读 JSON)
echo '{"rc":0,"code":"SUCCESS","data":{"name":"张三","vip":true}}' \
  | node scripts/mock-rule.mjs set --method GET --path /api/user/profile --status 200

# 查看 / 开关 / 删除单条
node scripts/mock-rule.mjs get     --method GET --path /api/user/profile
node scripts/mock-rule.mjs disable --method GET --path /api/user/profile
node scripts/mock-rule.mjs rm      --method GET --path /api/user/profile
```

规则文件默认在 `~/Library/Application Support/vjtools/mock-assets/mock-rules.json`,写盘后 mock server 的 watcher 会自动热载,无需重启。

## License

ISC
