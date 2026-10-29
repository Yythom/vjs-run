---
name: mock-rules
description: 定制或排查 vjtools 的接口 mock 数据时使用。覆盖 mock 规则与「场景」（scenes/<名>.json）的增删改查、变体（按 query/header/body 返回不同响应）、状态码与延迟模拟、mock 服务的启停与请求历史、以及 mock 不生效时的排障。定制类触发："改某个接口返回什么"、"让 /api/xxx 返回 …"、"造一份假数据联调"、"建一个联调场景"、"关掉某条 mock"、"模拟接口超时/500"、"分页第二页返回别的数据"、"把刚才那个接口的真实返回存下来改一改"。排障类同样触发："mock 怎么没生效"、"规则明明改了但没用"、"返回怎么多了一层 rc/code/data"、"变体不命中"、"接口返回 502 或 404 No mock route matched"、"这条走的是 mock 还是真后端"、"看看最近的请求"。改地址类同样触发："把后端代理地址换成 …"、"换个 swagger 源服务器"、"mock 回源到测试环境"。启停类同样触发："把 mock 跑起来"、"启动 / 停掉 mock"、"mock 在不在跑"、"重新拉一下 swagger 文档"、"vjtools 命令找不到"。只要涉及 vjtools mock server 的行为就用本 skill，哪怕用户没说"mock 规则"这几个字。
---

# 定制 vjtools 的 mock 接口数据

vjtools 的 mock 服务按「规则」拦截请求并返回自定义 JSON。本 skill 把一次联调要 mock 的一组接口
**收敛成一个命名「场景」**（`scenes/<场景名>.json`），而不是零散地改活动规则——这样用户能按场景
一键应用 / 切换 / 回滚（命令行 `apply-scene`，或在 vjtools app 里点「应用」）。

所有操作都走 `vjtools` 命令，**不要手写 JSON 文件**——不管是图省事、命令报错还是 CLI 版本旧：手改极易漏逗号、
覆盖别的规则或写错字段名（规则按字段白名单重建，多余字段会被静默丢弃），绕过 `apply-scene` 直接覆盖
`mock-rules.json` 还会让「当前应用的场景」标记失真。命令行和 vjtools app 共用同一份配置、规则和场景。

## 第 0 步：确认 vjtools 可用且版本够新

```bash
command -v vjtools && vjtools --version
# PATH 上没有时，看 app 内置的那个（app 每次启动都会生成；路径带空格，必须加引号）
"$HOME/Library/Application Support/vjtools/bin/vjtools" --version
```

- 输出 `vjtools-cli x.y.z`（npm 包）→ 需要 **≥ 0.3.0**。0.2.0 及更早：管道上游稍慢时（`vjtools mock sample … | vjtools mock rule set …`）
  response 会被静默丢掉、照样报成功，被程序调用时 `rule set` 可能永久挂起，雪花 ID 会被舍入；0.1.x 还缺 `sample` / `describe` /
  `save-scene` / `--from-history`，并**静默忽略不认识的参数**（`--from-history` 被吞掉后照样退出码 0，写出一条没有 response 的规则）。
  版本不够就征得用户同意后 `npm i -g vjtools-cli@latest`；用着用着报「未知命令 / 未知子命令」也是这个原因。
- 输出 `vjtools <版本>`（app 内置）→ 能找到就够新。只有它能用时，下文的 `vjtools …` 都换成
  `"$HOME/Library/Application Support/vjtools/bin/vjtools" …`，并提示用户在 app「开发环境体检」页点「安装到命令行」。
- 都找不到 → 请用户二选一并征得同意：装了 app 的，升级到带内置命令的新版并打开一次；没装的，
  `npm i -g vjtools-cli`（Node ≥ 22.12）。用户不让装就停下来说明，装了 app 的可以在 app 的 mock 配置页手动操作。

退出码：`0` 成功 · `1` 失败 · `2` apply-scene 被守卫拒绝 · `3` mock 未运行。

## 先分清用户要什么

| 用户要的 | 去哪 |
|---|---|
| 改接口返回、造假数据、建联调场景、模拟 500 / 超时、分页返回不同数据、存真实响应 | 「场景工作流」 |
| mock 没生效、返回不对、分不清走的是 mock 还是真后端 | 「排障」表 |
| 启停 mock、看状态 / 日志 / 请求历史、重新拉 swagger | 「启停 mock、查状态与请求历史」 |
| 改后端代理地址、Swagger 源服务器等配置 | 「修改配置」 |

只有第一类要问场景名。排障、启停、改配置直接做；排障查到确实要改规则了，再进场景工作流。

## 场景工作流

1. **确定场景名**。用户在请求里已经点名了场景就直接用，不必再问。否则先跑 `vjtools mock rule scenes` 再问：
   - 有标着「← 当前应用中」的场景 → 把它当默认选项问：「要直接改正在用的「X」，还是新建一个场景？」
     用户多半是想在正在用的场景上接着改，这样能自动应用，改完立刻生效。
   - 没有 → 问：「这次联调放到哪个场景？给个场景名（如 `登录联调`）」。
   - 场景名规则：非空、≤60 字符，不能含 `/ \ : * ? " < > |`。
2. **新场景才要建**：`vjtools mock rule new-scene --scene <名>`；往已有场景里加接口就跳过这步。
   报「场景已存在」→ 告诉用户，问是换个名字，还是就往这个已有场景里加。
3. **逐个把接口写进场景**：`vjtools mock rule set --scene <名> --method <M> --path <P> …`（见「`set` 的要点」）。
   - 不确定接口的准确路径时，先 `vjtools mock routes <关键词>` 在 spec 里搜。
   - **别凭空手写 response**：先 `vjtools mock sample --method <M> --path <P>` 拿一份按 swagger 生成的骨架
     （字段名、嵌套、信封都对），在它上面改值再写进去。字段含义不清楚就 `vjtools mock describe` 看说明。
   - 用户要「用真实数据」：见「从请求历史取真实响应」。
4. **展示并核对**：`vjtools mock rule list --scene <名>` 给用户看，确认接口都在、enabled / status 对；
   要逐字核对 response 时用 `get`。
5. **应用**：按下一节。

> 只有当用户明确说「就临时改一下活动规则 / 不用建场景」时，才用不带 `--scene` 的命令直接改活动规则。

## 应用场景

应用会用场景内容**整体覆盖**活动规则，所以分两档。

**先试自动应用**：`vjtools mock rule apply-scene --scene <名>`，**不带** `--force`。CLI 自带守卫，
只在两种情况下真正应用：活动规则为空；或这个场景就是「← 当前应用中」的那个。

- 退出码 0 → 已应用并自动热载，告诉用户「已自动应用」，接着做「收尾自检」。
- 退出码 2 → 活动规则**没有被改动**。转述 stderr 里的原因，问用户要不要覆盖；用户不要的话说清楚：
  场景已经存好，但**还没生效**（装了 app 的也可以自己去 mock 配置页点「应用」）。
- 「当前应用中」只看标记里的场景名，不管活动规则后来有没有被手改过。这次对话里直接改过活动规则
  （你改的，或用户提到的）时，跑之前先说一声：自动应用会把那些手改冲掉。

**`--force` 覆盖**：只有用户明确要求由你应用（「帮我应用」「直接应用上」，或对上面的追问答应覆盖）时才做：

1. 把 CLI 报出的「当前应用的是哪个场景 / 有几条规则会被覆盖」告诉用户。
2. **一律先备份**当前活动规则，不用判断有没有被手改过：
   `vjtools mock rule save-scene --scene "备份-$(date +%m%d-%H%M)"`（带到分钟，同一天备份多次也不撞名）。
3. `vjtools mock rule apply-scene --scene <名> --force`
4. 告诉用户备份场景的名字；想回退时，对备份场景同样走 `apply-scene --force`。

## 命令速查

### 场景命令（首选）

```bash
vjtools mock rule scenes                     # 所有场景 + 规则条数；当前应用中的带「← 当前应用中」
vjtools mock rule new-scene --scene 登录联调   # 新建空场景（同名报错）

# 写接口：response 从 stdin 读 JSON。用带引号的 heredoc，JSON 里有单引号、$ 也不会被 shell 改坏
vjtools mock rule set --scene 登录联调 --method POST --path /api/login --status 200 <<'EOF'
{"rc":0,"code":"SUCCESS","data":{"token":"abc"}}
EOF

# 复杂 JSON：swagger 骨架落到文件 → 改值 → 写进场景。每个接口一个文件名，别共用，免得互相覆盖
vjtools mock sample --method GET --path /api/user/profile > /tmp/vjtools-user-profile.json
vjtools mock rule set --scene 登录联调 --method GET --path /api/user/profile < /tmp/vjtools-user-profile.json

# 用真实请求过的响应（前提和注意事项见「从请求历史取真实响应」）
vjtools mock rule set --scene 登录联调 --from-history 12

# 模拟慢接口：--delay 毫秒数（返回前先等待）
vjtools mock rule set --scene 登录联调 --method GET --path /api/list --delay 3000 <<'EOF'
{"rc":0,"data":[]}
EOF

# 查看 / 开关 / 删除场景内某条
vjtools mock rule list    --scene 登录联调
vjtools mock rule get     --scene 登录联调 --method POST --path /api/login
vjtools mock rule disable --scene 登录联调 --method POST --path /api/login
vjtools mock rule enable  --scene 登录联调 --method POST --path /api/login
vjtools mock rule rm      --scene 登录联调 --method POST --path /api/login

# 应用 / 备份：规矩见「应用场景」
vjtools mock rule apply-scene --scene 登录联调
vjtools mock rule save-scene  --scene 备份-1028-1530   # 同名报错，确认覆盖再加 --force

# 重命名 / 删除整个场景文件（删前先和用户确认；都不影响活动规则）
vjtools mock rule rename-scene --scene 登录联调 --to 登录联调v2
vjtools mock rule rm-scene     --scene 登录联调
```

### 活动规则命令（仅用户明确要临时改时用）

上面的 `list` / `get` / `set` / `set-variant` / `enable` / `disable` / `rm` 去掉 `--scene`，就作用于活动
`mock-rules.json`，写盘后 mock server 自动热载、无需重启。

### `set` 的要点

- 按 **method + path 幂等定位**：命中则覆盖、未命中则追加，**绝不动其它规则**。
  覆盖已有规则时，**本次没传的字段保留原值**（比如只改 response 不会丢 delay）。
- 可选项：`--status <整数>`、`--delay <毫秒>`、`--disabled` / `--enabled`。
- `--method` **必填**且必须是具体方法：mock server 只按具体 method 匹配，`"*"` 或不写的规则一条都不会命中，CLI 直接拒收。
- 定位是**字面 path 字符串**：占位符规则 `/api/user/{id}` 必须原样传 `--path '/api/user/{id}'`，
  传具体的 `/api/user/123` 定位不到那条、反而会新增一条。
- 多条规则都能命中时，**路径最具体的赢**（`/api/user/123` 优先于 `/api/user/{id}`），与数组顺序无关。
- 只带 `--status` / `--delay`、不带 response 的规则，**只对 swagger spec 里已有的路径生效**；
  「让 /api/xxx 返回 500」这类需求，spec 外的路径要连 body 一起给。
- spec 内的 JSON 接口会被**信封化**：不带 `rc` / `code` / `message` 的 body 会被包进 `data`。要原样返回就自己写成
  带 `rc` 的完整信封（本 skill 的示例都这么写），细节见 `references/rule-format.md`。

### 从请求历史取真实响应

用户说「用真实数据」「把刚才那个接口的返回存下来改一改」时：

1. 确认 mock 在跑：请求历史在运行中的 mock 进程内存里，没跑会以退出码 3 失败。没跑就先 `vjtools mock start`。
2. 让用户在前端触发一次请求（或你 curl 一次），`vjtools mock history --path <路径>` 找到 `#` 后面的编号。
3. `vjtools mock rule set --scene <名> --from-history <编号>`，之后照常改值、加变体。

- 历史最多 300 条；`vjtools mock restart` 或停掉再启动 mock 会清空（改配置引起的自动重启不清）——编号现查现用。
- 响应体太大、没被完整记录的那条会被拒绝，改用 `vjtools mock sample` 拿骨架。
- 存下的 path 默认是 swagger 路由模板（如 `/api/user/{id}`，同类请求都能命中），之后 `get` / `rm` / `set-variant`
  也要用这个模板路径定位；想存成别的路径就加 `--path`。状态码跟那条真实响应走（不是 200 才写进规则）。

## 变体：同一路径按条件返回不同响应

一条规则（method+path）内可挂多个**变体**，按请求的 query / header / body 做**相等匹配**，命中哪个就返回
哪个的 response——典型场景：分页（`page=2` 返回第 2 页）、状态流转（`status=1` 返回列表、`status=2` 返回空）。

```bash
# 先有规则（顶层 response 是「无变体命中」时的兜底），再挂变体
vjtools mock rule set --scene 订单联调 --method GET --path /api/orders <<'EOF'
{"rc":0,"data":{"list":["第1页"]}}
EOF

vjtools mock rule set-variant --scene 订单联调 --method GET --path /api/orders \
  --name 分页第2页 --when-query page=2 <<'EOF'
{"rc":0,"data":{"list":["第2页"]}}
EOF

# 条件可叠加（全部相等才命中，AND）；三类条件都可重复传
vjtools mock rule set-variant --scene 订单联调 --method GET --path /api/orders \
  --name 管理员空列表 --when-query page=1 --when-header x-role=admin --when-body filter.type=hot <<'EOF'
{"rc":0,"data":{"list":[]}}
EOF

# 变体也可以单独带 --status/--delay/--disabled；删除单个变体：
vjtools mock rule rm-variant --scene 订单联调 --method GET --path /api/orders --name 分页第2页
```

- `set-variant` 按 **(规则, --name) 幂等定位**；规则必须已存在（先 `set` 建兜底）。
  更新时没传的字段保留原值，但**给了任意 `--when-*` 就整体替换 when**（不逐 key 合并）。
- 写条件前先 `vjtools mock describe --method <M> --path <P>`，看接口实际有哪些 query 参数和请求体字段路径，
  别猜字段名——写错了变体永远不命中，也不会报错。
- query 值按字符串比；header 名不分大小写；body 用点路径（如 `items.0.id`），值先按 JSON 解析
  （`2` → 数字），失败按字符串。数字 / 字符串互转、深度相等、`null` 的细节见 `references/rule-format.md`。
- 变体按顺序 **first-match**，都不命中回退规则顶层；调整顺序 = `rm-variant` 后按序重加。
- `--name` 规则内唯一，≤60 字符。

## 启停 mock、查状态与请求历史

```bash
vjtools mock status              # 先看在不在跑、是谁启动的；退出码 3 = 没在跑
vjtools mock start               # 后台启动，健康检查通过才返回；已在跑会直接说明，不会起第二个
vjtools mock stop                # 停掉后台进程（命令行和新版 app 起的是同一个）
vjtools mock restart             # 重启（会清空请求历史；改配置会自动重启，一般用不上）
vjtools mock logs -n 50          # 后台日志（启动失败、重启原因都在这里）

vjtools mock routes 登录 --method POST   # 在 spec 里搜接口（路径 / 摘要 / operationId），定位 --path 用
vjtools mock describe --method POST --path /api/login   # 接口的参数、请求体、响应字段（含说明和例值）
vjtools mock sample --method POST --path /api/login     # 按 swagger 生成的推荐响应 JSON
vjtools mock history --path /api/orders --limit 10       # 最近请求：每条是 mock 还是代理、命中了哪条规则 / 变体
vjtools mock history --kind proxy                        # 只看回源到真实后端的
vjtools mock history --id 12     # 单条的完整请求体 / 响应体
```

要解析结果时加 `--json`：`status`、`routes`、`describe`、`history`、`config` 都支持，比解析文字输出可靠。

- 用户要联调或要你验证效果、而 mock 没在跑时，直接 `vjtools mock start`，不要回头去改规则文件。
- `start` 报「还没有 OpenAPI spec」→ 按提示二选一：配 `--swagger-server` 后 `vjtools mock gen`，或 `--spec-dir`
  指向已有文件。首次使用也可以一步到位：`vjtools mock init --swagger-server <url> --backend <url>`。
- 「这条走的是 mock 还是真后端」「规则怎么没命中」先看 `history`：`kind` 是 `mock` / `proxy` / `proxy-error` / `miss`，
  `mock:` 后面是来源（`rule-response` / `rule-variant` / `openapi-sample` 等，含义见 `references/request-flow.md`）。

## 修改配置

Swagger 源服务器、后端代理地址等存在 `config.json`（不在 mock-assets 里），**不用走场景流程**：

```bash
vjtools mock config                                          # 查看
vjtools mock config --backend https://api.example.com/t2     # 修改（可只传其中一个；传 "" 表示清空）
vjtools mock config --swagger-server http://swagger.example.com/t2
```

- **后端代理地址**：没命中 mock 的请求回源到这里。改完 mock 会在进程内**自动重启**（请求历史保留），
  几秒后生效，可用 `vjtools mock status` 确认已恢复。
- **Swagger 源服务器**：只在生成 OpenAPI JSON 时使用，改完要接着 `vjtools mock gen`（mock 运行中会自动热更新路由）。
- 同一个命令还能改 `--spec-dir`（已有 OpenAPI JSON 的目录）、`--host` / `--port`、`--service-address`、
  `--mock-all true|false`。

## 与 vjtools app 共存

mock 只有一个后台进程：app 的「启动」和 `vjtools mock start` 起的是同一个，app 退出时 mock **不停**
（下次打开 app 自动接上）。只有两处要留意：

- **停 mock 前先确认用户不需要了**：用户可能正在 app 里看着它，`status` 的「启动方式」会写明是谁起的。
  只停你自己为了验证而启动的；旧版 app 在自己进程里跑的 mock，`vjtools mock stop` 会拒绝，请用户在 app 里停。
- **「录制」只能在 app 里开关，正在录制的场景不要用命令行写**（`set` / `set-variant` / `rename-scene` / `rm-scene`）：
  录制把规则攥在内存里，下一条请求到来就整份重写场景文件，命令行写进去的会被悄悄冲掉。
  命令行查不到录制状态，用户提到在录制时先请他停掉。录制具体录什么见 `references/request-flow.md`。

## 收尾自检

已应用（或直接改了活动规则）时，mock server 已自动热载，用请求本身确认效果，别只写不看：

```bash
BASE=$(vjtools mock rule base --quiet)   # host/port 从 config.json 读，别猜端口
curl -fsS "$BASE/__mock/health"          # 先探活：不通说明 mock 没跑 → vjtools mock status / start，别回头改规则
curl -fsS "$BASE/__mock/rules"           # server 此刻实际生效的规则，确认就是你写的那份
curl -si "$BASE/api/orders?page=2"       # 看实际返回；响应头 x-mock-source 说明是谁给的响应
```

不方便 curl 时，让用户在前端触发一次请求，再用 `vjtools mock history --path <路径>` 看。

## 排障：症状 → 先查什么

| 症状 | 先查 |
|---|---|
| 命令报「未知命令 / 未知子命令」，或 `--from-history` 写出的规则没有 response | CLI 版本太旧，见第 0 步 |
| curl 全部连不上 | `vjtools mock status`；没跑就 `vjtools mock start`，起不来看 `vjtools mock logs`，别改文件 |
| 分不清这次请求走了 mock 还是真后端 | `vjtools mock history --path <路径>`，再 `--id` 看单条；或看响应头 `x-mock-source` |
| `/__mock/rules` 里没有你写的规则 | 写进场景了但没「应用」（最常见，看 `apply-scene` 是不是退出码 2）；或 `--file` / `--scene` 指向了别处 |
| 规则在 `/__mock/rules` 里但没生效 | 先看 `method` 是不是 `"*"` 或没写（这类规则不会命中，mock 启动日志有警告）；再看是否有更具体的同 method 规则先命中 |
| 返回的 body 比你写的多了一层 `{rc,code,message,data}` | 正常，信封化（见「`set` 的要点」） |
| 502 + 没配后端 | 没有任何启用的规则 / override / 控制参数命中，被 `shouldUseMock` 闸门拦住了（`references/request-flow.md`） |
| 404 `No mock route matched` | spec 外路径且规则没带 response（只有 status/delay 的规则对 spec 外无效） |
| 变体死活不命中 | 先看 `history` 或 `x-mock-variant` 头确认实际命中了谁；手改过文件的话，非法变体会被静默丢弃（`curl $BASE/__mock/rules` 看它还在不在）；最后核对 when 的相等语义（`references/rule-format.md`） |
| 刚写进场景的规则过一会儿没了 | 这个场景可能正在 app 里录制，被录制重写冲掉了（见「与 vjtools app 共存」） |

## 参考资料（按需读，不用每次都看）

| 文件 | 什么时候读 |
|---|---|
| `references/rule-format.md` | 规则文件结构；变体条件的精确匹配语义；信封化的完整规则；规则、场景、配置各文件放在哪（排查手改过的文件时） |
| `references/request-flow.md` | 排查「为什么命中了这个 / 为什么没命中 / 为什么 502 或 404」：完整处置顺序、`x-mock-source` 取值、token 注入；用户想不改规则、临时模拟 500 / 超时 / 空列表（请求控制参数）；`mock-data/` override 文件；录制具体录什么；全部 `/__mock/*` 调试接口 |
