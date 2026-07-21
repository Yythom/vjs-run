---
name: mock-rules
description: 定制或排查 vjtools 的接口 mock 数据时使用。覆盖 mock 规则与「场景」（scenes/<名>.json）的增删改查、变体（按 query/header/body 返回不同响应）、状态码与延迟模拟、以及 mock 不生效时的排障。定制类触发："改某个接口返回什么"、"让 /api/xxx 返回 …"、"造一份假数据联调"、"建一个联调场景"、"关掉某条 mock"、"模拟接口超时/500"、"分页第二页返回别的数据"。排障类同样触发："mock 怎么没生效"、"规则明明改了但没用"、"返回怎么多了一层 rc/code/data"、"变体不命中"、"接口返回 502 或 404 No mock route matched"、"这条走的是 mock 还是真后端"。只要涉及 vjtools mock server 的行为就用本 skill，哪怕用户没说"mock 规则"这几个字。
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

### 哪些事你做不了

第 4 步的「应用」不是你能代劳的动作，值得先说清楚，免得走到那一步临时起意：

- **你能做**：经 CLI 读写场景与活动规则文件、curl `/__mock/*` 自检、发请求验证。
- **只有 UI 入口、必须交还用户**：应用场景、启动/重启 mock server、开关「录制」。
  走到这些地方就停下来请用户去点，然后再接着验证。
- 别为了「帮用户把场景应用上」去覆盖 `mock-rules.json`。那会静默冲掉用户当前的活动规则，
  而且和软件里的「应用」并不等价。用户没明说要改活动规则时，只写场景文件。

## 文件位置

基准目录（下称 `<mock-assets>`）：`~/Library/Application Support/vjtools/mock-assets/`

- 活动规则（app 实际读取、改完自动热载）：`<mock-assets>/mock-rules.json`
- 场景文件：`<mock-assets>/scenes/<场景名>.json`，结构与活动规则**完全一致**。
- override 数据文件：`<mock-assets>/mock-data/`（见「override 文件」一节，优先级低于规则）。

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

# 自检用：打印 mock server 地址（从 config.json 读，尊重 VJTOOLS_USER_DATA_DIR）
node scripts/mock-rule.mjs base
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

## 变体：同一路径按条件返回不同响应

一条规则（method+path）内可挂多个**变体**（`variants`），按请求的 query/header/body
做**相等匹配**，命中哪个变体就返回哪个的 response——典型场景：分页（`page=2` 返回第
2 页）、状态流转（`status=1` 返回列表、`status=2` 返回空）。

```bash
# 先有规则（顶层 response 是「无变体命中」时的兜底），再挂变体
echo '{"rc":0,"data":{"list":["第1页"]}}' \
  | node scripts/mock-rule.mjs set --scene 订单联调 --method GET --path /api/orders

echo '{"rc":0,"data":{"list":["第2页"]}}' \
  | node scripts/mock-rule.mjs set-variant --scene 订单联调 --method GET --path /api/orders \
      --name 分页第2页 --when-query page=2

# 条件可叠加（全部相等才命中，AND）；三类条件都可重复传
echo '{"rc":0,"data":{"list":[]}}' \
  | node scripts/mock-rule.mjs set-variant --scene 订单联调 --method GET --path /api/orders \
      --name 管理员空列表 --when-query page=1 --when-header x-role=admin --when-body filter.type=hot

# 变体也可以单独带 --status/--delay/--disabled；删除单个变体：
node scripts/mock-rule.mjs rm-variant --scene 订单联调 --method GET --path /api/orders --name 分页第2页
```

变体要点：
- `set-variant` 按 **(规则, --name) 幂等定位**；规则必须已存在（先 `set` 建兜底）。
  更新时没传的字段保留原值，但**给了任意 `--when-*` 就整体替换 when**（不逐 key 合并）。
- 匹配语义（V1 仅相等匹配）：
  - `--when-query k=v`：请求 query 中存在 k 且值字符串相等；
  - `--when-header k=v`：header 名大小写不敏感，值字符串相等；
  - `--when-body a.b.c=v`：k 是 body 的**点路径**（可索引数组，如 `items.0.id`），仅 JSON
    body 可命中；值先按 JSON 解析（`2`→数字、`true`→布尔），失败按字符串；原始值比较时
    数字/字符串互转（`1` 与 `"1"` 命中），对象/数组值走深度相等（**深度相等内部不做**
    数字/字符串互转），`null` 只命中 `null`。
- 变体按数组顺序 **first-match**，都不命中回退规则顶层 response；调整顺序 = `rm-variant` 后按序重加。
- `--name` 规则内唯一，**≤60 字符**。
- **非法变体在加载时被静默丢弃**（缺 name / 缺 response / when 无有效条件的，
  server 读规则文件时直接过滤掉，不报错也不影响同规则的其它变体）。
  经 CLI 写入会在写盘前就报中文错误挡住，所以这条主要发生在**手改文件**之后——
  「变体明明在文件里却从不命中」先 `curl $BASE/__mock/rules` 看它还在不在。
- 优先级见下文「一个请求的完整处置顺序」；「录制」不会生成变体，但也不会清掉已有变体。

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
| `variants` | array | 否 | 变体数组（见上节）。每个变体：`name`（必填，规则内唯一）、`when`（必填，`{query?, headers?, body?}` 至少 1 个条件）、`response`（必填）、`status`/`delay`/`enabled`（可选，缺省回退规则顶层） |

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
  },
  {
    "enabled": true,
    "method": "GET",
    "path": "/api/orders",
    "response": { "rc": 0, "data": { "list": ["第1页（兜底）"] } },
    "variants": [
      {
        "name": "分页第2页",
        "enabled": true,
        "when": { "query": { "page": "2" } },
        "response": { "rc": 0, "data": { "list": ["第2页"] } }
      }
    ]
  }
]
```

## 响应会被「信封化」——最容易踩的坑

**仅当路径在 swagger spec 里有定义、且该响应声明了 `application/json` 时**，server 会给你写的
`response` 套一层业务信封再返回：

- 你写的已经是信封（含 `rc` / `code` / `message` 任一字段）→ 原样返回，只把缺省/占位值补齐：
  `rc` 为空或 `1` → `0`；`code` 为空或字面量 `"string"` → `"SUCCESS"`；`message` 同理 → `"success"`。
- 你写的**不是**信封（比如直接给了个数组或裸对象）→ 被包成
  `{ rc: 0, code: "SUCCESS", message: "success", data: <你写的> }`。

所以「我明明写了 `[1,2,3]`，前端却收到 `{rc:0,...,data:[1,2,3]}`」是预期行为。
想要完全原样的 body，就**自己写成带 `rc` 的完整信封**（本 skill 示例都这么写）。

spec 之外的路径（`findRoute` 未命中）不做任何加工，`response` 原样返回、状态码取规则的 `status`（默认 200）。

## 请求控制参数（不用改规则的临时开关）

前端发请求时带上即可，query 参数和 header 二选一，**优先级高于规则和变体**：

| query | header | 作用 |
|---|---|---|
| `__mockStatus=500` | `x-mock-status: 500` | 强制 HTTP 状态码（须 > 0） |
| `__mockDelay=3000` | `x-mock-delay: 3000` | 强制响应延迟毫秒（≥0，覆盖规则的 `delay`） |
| `__mockCode=ERR_X` | `x-mock-code: ERR_X` | 强制信封里的业务 `code` |
| `__mockEmpty=1` | `x-mock-empty: 1` | 让 swagger 生成的列表/分页数据返回空（`total=0`） |

这几个 header 已在 CORS `allowedHeaders` 白名单里，跨域直接可用。
另外 swagger 生成的数据还会读请求的 `page`/`pageIndex`、`size`/`pageSize` 来调整数组长度与分页字段
——这只影响**自动生成**的样本，你手写的 `response` 不受影响。

## 一个请求的完整处置顺序

1. `/__mock/*` 调试接口 → 直接响应（见下节）。
2. 路径**在 swagger spec 里**：
   请求控制参数 ＞ 命中的变体 ＞ 规则顶层 `response` ＞ `mock-data/` override 文件 ＞ swagger schema 生成样本。
   但先过 `shouldUseMock` 闸门：只有 `mockAll` 开着，或存在启用的规则 / override 文件 / 任一请求控制参数时才走 mock；
   否则有后端就**透传**，没后端则返回 **502**（故意暴露配置问题，而不是静默给一份假数据）。
3. 路径**不在 spec 里**（后端独有接口、录制来的接口）：只认**带 `response` 的规则**
   （或有变体命中）。命中即返回；否则有后端就透传、没后端返回 **404 `No mock route matched`**。
4. 透传的响应会带上 `x-mock-proxy: true` 响应头——**判断「这条到底走没走 mock」就看它在不在**。

透传时 server 会替你补 token：从 cookie 里取，但**只在请求头没有**
`Authorization` / `Mgmtauth` 时才注入，不覆盖前端显式发送的值。
所以「前端自己带了 token 却没生效」不是这里的问题——带了就以前端的为准。

## 调试接口（自检时直接 curl）

**先取 `$BASE`，别猜端口**（host/port 在 config.json 里，缺省 `127.0.0.1:3002`）：

```bash
BASE=$(node scripts/mock-rule.mjs base --quiet)
```

不带 `--quiet` 会连配置来源和自检命令一起打印，排查「是不是读错配置文件」时用它。

然后**先探活再做别的**——server 没跑的话后面每一条 curl 都会失败：

```bash
curl -fsS "$BASE/__mock/health"     # 通 = server 在跑；这里还能看到实际用的 mockRulesFile/mockDataDir/backendBaseUrl/mockAll
curl -fsS "$BASE/__mock/rules"      # server 此刻实际生效的规则数组（验证热载，最直接）
curl -fsS "$BASE/__mock/routes"     # swagger 解析出的全部路由（确认某 path 算不算「spec 内」）
curl -fsS "$BASE/__mock/search?q=user"
```

`/__mock/ui` 是给人看的浏览器调试页，你用不上，但可以让用户去开。

**连不上 `/__mock/health` ≠ 规则没写对。** 这时 mock server 根本没启动，
应该停下来让用户在软件里启动 mock，而不是回头去改规则文件。

## 排障：症状 → 先查什么

| 症状 | 先查 |
|---|---|
| curl 全部连不上 | `/__mock/health`；不通就是 server 没跑，让用户启动，别改文件 |
| `/__mock/rules` 里没有你写的规则 | 写进场景了但没「应用」（最常见）；或 `--file`/`--scene` 指向了别处 |
| 规则在 `/__mock/rules` 里但没生效 | `list` 看顺序，是否被前面的规则 first-match 截胡 |
| 返回的 body 比你写的多了一层 `{rc,code,message,data}` | 正常，见「信封化」一节；要原样就自己写成完整信封 |
| 响应头有 `x-mock-proxy: true` | 走的是真实后端，没命中 mock，回到上面三条 |
| 502 + 没配后端 | 没有任何启用的规则/override/控制参数命中，`shouldUseMock` 闸门拦住了 |
| 404 `No mock route matched` | spec 外路径且规则没带 `response`（只有 status/delay 的规则对 spec 外无效） |
| 变体死活不命中 | 先确认变体没被**静默丢弃**（见变体要点末条），再核对 when 的相等语义 |

## override 文件（`mock-data/`，规则的低优先级备胎）

放在 `<mock-assets>/mock-data/` 下的 JSON 会作为该路由的响应体，**仅对 spec 内的路径生效**，
优先级低于规则。按以下顺序取第一个存在的文件（`<m>` 为小写方法名）：

```
mock-data/<去掉开头斜杠的完整路径>.<m>.json     # 如 mock-data/api/user/profile.get.json
mock-data/<去掉开头斜杠的完整路径>/<m>.json     # 如 mock-data/api/user/profile/get.json
mock-data/<spec 文件名去扩展名>/<openapi 路径>.<m>.json
```

override 命中时同样走上一节的信封化，但**不做**分页/长度调整（按「用户手写」对待）。
日常优先用规则/场景；只有需要长期固化一份大数据、或规则里塞不下时才用它。

## 「录制」与本 skill 的关系

软件里开「录制」后，经过 mock server 的 2xx JSON 响应会按 `method + 路由模板` upsert
成规则，写进 `scenes/<场景名>.json`：

- 录制期间**不碰活动规则**，透传照常走后端，重复请求会持续刷新场景内容。
- 默认 proxy（真实后端）和 mock（命中现有规则）都录；开「排除 mock」后只录 proxy。
- 只写规则顶层 `response`，**不生成变体**，也不会清掉已有变体。
- 录完把场景「应用」为活动规则即可回放。

所以「先录一遍真实接口、再用本 skill 的 `set-variant` 加分支」是很顺的组合。
**正在录制的场景不要用 `rename-scene`/`rm-scene`**，先在软件里停止录制。

## 收尾自检

改完至少做一步验证，别只写不看：
1. `list --scene <名>` 确认接口都在、enabled/status 对。
2. `get --scene <名> --path <P>` 核对 `response` 内容完整。
3. 提醒用户：**在软件里「应用」该场景**后才生效。
4. 已应用/直接改活动规则时，watcher 已自动热载，可用 `curl -fsS "$BASE/__mock/rules"`（`$BASE`
   的解析见「调试接口」一节）确认 server 读到的就是你写的那份，再请求 `$BASE<path>`
   看实际返回——注意响应体可能被信封化，
   且响应头有没有 `x-mock-proxy: true` 决定了它到底走的 mock 还是后端。
