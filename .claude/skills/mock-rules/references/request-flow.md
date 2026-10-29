# 一个请求是怎么被处理的

排查「为什么命中了这个 / 为什么没命中 / 为什么是 502 或 404」时读这里。

## 完整处置顺序

1. `/__mock/*` 调试接口 → 直接响应（见文末）。
2. 路径**在 swagger spec 里**：
   请求控制参数 ＞ 命中的变体 ＞ 规则顶层 `response` ＞ `mock-data/` override 文件 ＞ swagger schema 生成样本。
   但先过 `shouldUseMock` 闸门：只有 `mockAll` 开着，或存在启用的规则 / override 文件 / 任一请求控制参数时才走 mock；
   否则有后端就**透传**，没后端则返回 **502**（故意暴露配置问题，而不是静默给一份假数据）。
3. 路径**不在 spec 里**（后端独有接口、录制来的接口）：只认**带 `response` 的规则**（或有变体命中）。
   命中即返回；否则有后端就透传，没后端返回 **404 `No mock route matched`**。
   所以只带 `status` / `delay`、不带 `response` 的规则，对 spec 外的路径不生效。
4. 同一请求能命中多条启用的规则时，**路径最具体的赢**：字面段优先于 `{param}` 段（与 swagger 路由同一套打分），
   与数组顺序无关；只有具体程度相同（如 `/a/{x}/c` 与 `/a/b/{y}`）才按数组顺序取第一条。

## 响应头：这次是谁给的响应

每个响应都带 `x-mock-source`：

| 取值 | 含义 |
|---|---|
| `proxy` | 回源后端（没命中 mock） |
| `rule-variant` | 命中规则的变体 |
| `rule-custom` | spec 外路径的自定义规则 |
| `rule-response` | 规则顶层 `response` |
| `rule-control` | 规则只改了 status / delay，body 来自 swagger 样本 |
| `file:<路径>` | `mock-data/` override 文件 |
| `openapi-sample` | swagger schema 生成的样本 |

命中规则时还有 `x-mock-rule`（规则 path），命中变体时还有 `x-mock-variant`（变体名）。
透传另保留 `x-mock-proxy: true`（与 `x-mock-source: proxy` 等价，旧的判断依然可用）。

这三个头的值做过 `encodeURIComponent`：curl 里中文变体名长成 `%E6%9C%AA%E7%99%BB%E5%BD%95`、
`file:` 前缀长成 `file%3A%2F…`——**不是头的值写错了**，`node -p 'decodeURIComponent("…")'` 解一下即可。

不想 curl 看头的话，`vjtools mock history --path <路径>` 里每条记录也写明了 `kind`（`mock` / `proxy` /
`proxy-error` / `miss`）和来源。

透传时 server 会替前端补 token：从 cookie 里取，但**只在请求头没有** `Authorization` / `Mgmtauth` 时才注入，
不覆盖前端显式发送的值。所以「前端自己带了 token 却没生效」不是这里的问题——带了就以前端的为准。

## 请求控制参数（不改规则的临时开关）

前端发请求时带上即可，query 参数和 header 二选一，**优先级高于规则和变体**。用户只是想临时看看
500 / 超时 / 空列表的效果、不想改规则时，可以推荐这个：

| query | header | 作用 |
|---|---|---|
| `__mockStatus=500` | `x-mock-status: 500` | 强制 HTTP 状态码（须 > 0） |
| `__mockDelay=3000` | `x-mock-delay: 3000` | 强制响应延迟毫秒（≥0，覆盖规则的 `delay`） |
| `__mockCode=ERR_X` | `x-mock-code: ERR_X` | 强制信封里的业务 `code` |
| `__mockEmpty=1` | `x-mock-empty: 1` | 让 swagger 生成的列表 / 分页数据返回空（`total=0`） |

这几个 header 已在 CORS `allowedHeaders` 白名单里，跨域直接可用。
另外 swagger 生成的数据会读请求的 `page` / `pageIndex`、`size` / `pageSize` 调整数组长度与分页字段——
这只影响**自动生成**的样本，手写的 `response` 不受影响。

## override 文件（`mock-data/`，规则的低优先级备胎）

放在 `<mock-assets>/mock-data/` 下的 JSON 会作为该路由的响应体，**仅对 spec 内的路径生效**，优先级低于规则。
按以下顺序取第一个存在的文件（`<m>` 为小写方法名）：

```
mock-data/<去掉开头斜杠的完整路径>.<m>.json     # 如 mock-data/api/user/profile.get.json
mock-data/<去掉开头斜杠的完整路径>/<m>.json     # 如 mock-data/api/user/profile/get.json
mock-data/<spec 文件名去扩展名>/<openapi 路径>.<m>.json
```

override 命中时同样走信封化，但**不做**分页 / 长度调整（按「用户手写」对待）。
日常优先用规则 / 场景；只有需要长期固化一份大数据、或规则里塞不下时才用它。

## 录制（只能在 vjtools app 里开关）

开着时，经过 mock server 的 2xx JSON 响应会按 `method + 路由模板` 写进 `scenes/<场景名>.json`：

- 默认真实后端（proxy）和已命中规则（mock）的响应都录，开了「排除 mock」只录 proxy。
- 录制期间不碰活动规则、透传照常走后端，重复请求会持续刷新场景内容。
- 只写规则顶层 response，不生成也不清掉变体；录完「应用」即可回放。

「先录一遍真实接口、再用 `set-variant` 加分支」是很顺的组合。正在录制的场景不要用命令行写，原因见 SKILL.md「与 vjtools app 共存」。

## 调试接口

先取 `$BASE`（host/port 在 config.json 里，缺省监听 `0.0.0.0:3002`、本机用 `127.0.0.1:3002` 访问，别猜端口）：

```bash
BASE=$(vjtools mock rule base --quiet)   # 不带 --quiet 还会打印配置来源，排查「是不是读错配置文件」时用
curl -fsS "$BASE/__mock/health"          # 通 = server 在跑；还能看到实际用的 mockRulesFile / mockDataDir / backendBaseUrl / mockAll / pid
curl -fsS "$BASE/__mock/rules"           # server 此刻实际生效的规则数组（验证热载，最直接）
curl -fsS "$BASE/__mock/routes"          # swagger 解析出的全部路由（确认某 path 算不算「spec 内」）
curl -fsS "$BASE/__mock/search?q=user"   # 按关键词搜路由；命令行版是 vjtools mock routes user
curl -fsS "$BASE/__mock/history"         # 最近 300 条请求记录；命令行版是 vjtools mock history
```

`/__mock/ui` 是给人看的浏览器调试页，你用不上，但可以让用户去开。
