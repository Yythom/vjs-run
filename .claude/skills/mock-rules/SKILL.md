---
name: mock-rules
description: 为前端联调定制/修改接口 mock 数据时使用。覆盖 vjtools 的 mock 规则与「场景」（scenes/<名>.json）的增删改查、字段格式、路径匹配与热载。当被要求"改某个接口返回什么"、"让 /api/xxx 返回 …"、"造一份假数据联调"、"建一个联调场景"、"关掉某条 mock"时触发。
---

# 定制 vjtools 的 mock 接口数据

vjtools 的 mock 服务按「规则」拦截请求并返回自定义 JSON。规则是一个 JSON 数组。
本 skill 把一次联调要 mock 的一组接口**收敛成一个命名「场景」**（`scenes/<场景名>.json`），
而不是零散地改活动规则——这样用户能在软件里按场景一键应用/切换/回滚。

**改这些文件请一律用下面的 CLI，不要手撸 JSON**——手改极易漏逗号、覆盖别的规则或写错字段名（多余字段会被静默丢弃）。

## 工作流：先问场景名，最后产出一个场景

被触发时**默认走场景流程**，按顺序做：

1. **先问用户场景名**（必做，别跳过）：「这次联调放到哪个场景？给个场景名（如 `登录联调`）」。
   - 场景名规则：非空、≤60 字符，不能含 `/ \ : * ? " < > |`。
2. **建场景**：`node scripts/mock-rule.mjs new-scene --scene <名>`。
   - 若报「场景已存在」→ 停下来告诉用户，请其换个名字（或确认要往已有场景里加接口，那就跳过这步直接第 3 步）。
3. **逐个把本次接口写进场景**：对每个接口用 `set --scene <名> …`（见下）。
4. **收尾**：`list --scene <名>` 把场景内容展示给用户，并提示：
   **去 vjtools 的 mock 配置页「应用」这个场景后才会生效**（场景文件本身不影响当前活动规则）。

> 只有当用户明确说「就临时改一下活动规则/不用建场景」时，才用不带 `--scene` 的命令直接改活动 `mock-rules.json`。

## 文件位置

- 活动规则（app 实际读取、改完自动热载）：`~/Library/Application Support/vjtools/mock-assets/mock-rules.json`
- 场景文件：同目录下的 `scenes/<场景名>.json`，结构与活动规则**完全一致**。

路径 app 内不可配置（config.json 的 `mockRulesFile` 会被 normalize 重置）。CLI 自动定位，通常无需关心。
（e2e/隔离环境用 `VJTOOLS_USER_DATA_DIR` 覆盖 userData 目录；也可用 `--file` / `MOCK_RULES_FILE` 显式指定活动规则文件。）

## CLI

`scripts/mock-rule.mjs` **随本 skill 一起分发**（本 skill 目录下的 `scripts/`），只依赖 node 内置模块，无需安装。
由本 skill 触发时以 skill 目录为基准执行；在 vjtools 源码仓库根目录手动操作时，仓库根也有同名脚本，命令一致。

### 场景命令（首选）

```bash
# 列出所有场景（名字 + 规则条数）
node scripts/mock-rule.mjs scenes

# 新建空场景（同名报错）
node scripts/mock-rule.mjs new-scene --scene 登录联调

# 删除整个场景文件（删前先和用户确认；不影响活动规则）
node scripts/mock-rule.mjs rm-scene --scene 登录联调

# 重命名场景（新名已存在会报错；若软件正把该场景用于「录制」，请先在软件里停止录制再改名）
node scripts/mock-rule.mjs rename-scene --scene 登录联调 --to 登录联调v2

# 往场景里加/改接口（response 从 stdin 读 JSON）
echo '{"rc":0,"code":"SUCCESS","data":{"token":"abc"}}' \
  | node scripts/mock-rule.mjs set --scene 登录联调 --method POST --path /api/login --status 200

# 复杂 JSON 先写文件再喂进去
node scripts/mock-rule.mjs set --scene 登录联调 --method GET --path /api/user/profile < /tmp/resp.json

# 模拟慢接口：--delay 毫秒数（返回前先等待）
echo '{"rc":0,"data":[]}' \
  | node scripts/mock-rule.mjs set --scene 登录联调 --method GET --path /api/list --delay 3000

# 查看 / 开关 / 删除场景内某条
node scripts/mock-rule.mjs list    --scene 登录联调
node scripts/mock-rule.mjs get     --scene 登录联调 --method POST --path /api/login
node scripts/mock-rule.mjs disable --scene 登录联调 --method POST --path /api/login
node scripts/mock-rule.mjs enable  --scene 登录联调 --method POST --path /api/login
node scripts/mock-rule.mjs rm      --scene 登录联调 --method POST --path /api/login
```

### 活动规则命令（仅用户明确要临时改时用）

去掉 `--scene` 即作用于活动 `mock-rules.json`，写盘后 watcher 自动热载、无需重启：

```bash
node scripts/mock-rule.mjs list
echo '{"rc":0,"data":{"name":"张三"}}' \
  | node scripts/mock-rule.mjs set --method GET --path /api/user/profile --status 200
node scripts/mock-rule.mjs disable --method GET --path /api/user/profile
node scripts/mock-rule.mjs enable  --method GET --path /api/user/profile
node scripts/mock-rule.mjs rm      --method GET --path /api/user/profile
```

要点：
- `set` 按 **method + path 幂等定位**：命中则覆盖 response、未命中则追加，**绝不动其它规则**。
- `set` 可选项：`--status <整数>`、`--delay <毫秒>`（响应延迟，模拟慢接口）、`--disabled`/`--enabled`。
  覆盖已有规则时，**本次没传的字段保留原值**（比如只改 response 不会丢 delay）。
- `--method` 缺省为 `*`（匹配该 path 的所有请求方法）。
- 匹配是 **first-match**：按数组顺序逐条试，第一条命中即生效。`/api/user/{id}` 与
  `/api/user/123` 并存时排前面的赢——「改了规则却没生效」先 `list` 看顺序有没有被截胡。
- 只带 `status`/`delay`、**不带 `response` 的规则，仅对 swagger spec 里已有的路径生效**
  （强制改状态码/加延迟）；spec 之外的路径必须带 `response` 才会被拦截，否则规则静默不生效。
  所以「让 /api/xxx 返回 500」这类需求，spec 外的路径要连 body 一起给。
- 定位是**字面 path 字符串**：占位符规则 `/api/user/{id}` 必须原样传 `--path '/api/user/{id}'`，
  传具体的 `/api/user/123` 定位不到那条、反而会新增一条。
- 校验失败以非 0 退出并打印原因（path 没以 `/` 开头、status 非整数、stdin 不是合法 JSON 等）。

## 规则 JSON 结构（理解用；场景文件与活动规则同结构）

顶层是**数组**，每条规则字段如下（白名单，多余字段会被丢弃）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | string | 是 | 必须以 `/` 开头。支持 OpenAPI 风格占位符，如 `/api/user/{id}` |
| `method` | string | 否 | 大写；缺省/`"*"` 匹配所有方法 |
| `response` | any(JSON) | 否 | 命中时返回的 body。**这就是你要定制的接口数据** |
| `status` | integer | 否 | HTTP 状态码，缺省走默认 |
| `delay` | integer | 否 | 响应延迟毫秒数（≥0），返回前先等待，用于模拟慢接口 |
| `enabled` | boolean | 否 | 缺省 `true`；`false` 时该规则不生效 |

示例（一个场景文件的内容）：

```json
[
  {
    "enabled": true,
    "method": "POST",
    "path": "/api/login",
    "status": 200,
    "response": { "rc": 0, "code": "SUCCESS", "data": { "token": "abc" } }
  },
  {
    "enabled": true,
    "method": "GET",
    "path": "/api/user/{id}",
    "response": { "rc": 0, "data": { "id": 100, "name": "张三" } }
  }
]
```

## 收尾自检

改完至少做一步验证，别只写不看：
1. `list --scene <名>` 确认接口都在、enabled/status 对。
2. `get --scene <名> --path <P>` 核对 `response` 内容完整。
3. 提醒用户：**在软件里「应用」该场景**后才生效（或直接改活动规则时，watcher 已自动热载，可请求 `http://<mockHost>:<mockPort><path>` 验证）。
