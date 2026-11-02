# 规则格式、变体匹配语义、返回的 body 与信封

写 / 改规则一律用 `vjtools mock rule …`，这里是「看懂规则文件、解释返回结果」用的参考。

## 规则 JSON 结构（场景文件与活动规则同结构）

顶层是**数组**（旧格式 `{ "rules": [...] }` 也能读，命令行改过一次后写回成数组），每条规则按下面的字段白名单重建，
多余字段会被丢弃；`null`、数字这类不是对象的条目会被跳过（`rule list` 会逐条指出）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | string | 是 | 必须以 `/` 开头（会编译成锚定正则匹配请求 pathname，不带 `/` 的永远命中不了），不能带 `?` / `#`。尾部 `/` 可有可无。支持 OpenAPI 风格占位符，如 `/api/user/{id}` |
| `method` | string | **是** | `GET` / `POST` / `PUT` / `PATCH` / `DELETE` / `HEAD` / `OPTIONS` 之一。缺省或 `"*"` 的规则不会被命中，只会在 mock 启动日志里收到一条警告；其它值保存时就被拒收 |
| `response` | any(JSON) | 否 | 命中时返回的 body。**这就是要定制的接口数据**。里面的大整数（雪花 ID）按原文保留、原样返回 |
| `status` | integer | 否 | HTTP 状态码（200–599；1xx 不能当最终响应，保存时拒收，手改进文件的当没写），缺省走默认 |
| `delay` | integer | 否 | 响应延迟毫秒数（0–600000，即最多 10 分钟），返回前先等待，用于模拟慢接口 |
| `enabled` | boolean | 否 | 缺省 `true`；`false` 时该规则不生效 |
| `sequence` | array | 否 | 按次返回：没命中变体的第 n 次请求返回第 n 项，用完回到顶层 `response`。每一项 `{ status?, delay?, response }`，`response` 必填，`status` / `delay` 缺省沿用规则顶层。语义见下文「按次返回」 |
| `variants` | array | 否 | 变体数组。每个变体：`name`（必填，规则内唯一，≤60 字符）、`when`（必填，`{query?, headers?, body?}` 至少 1 个条件）、`response`（必填）、`status`/`delay`/`enabled`（可选，缺省回退规则顶层） |

示例（一个场景文件的内容）：

```json
[
  {
    "enabled": true,
    "method": "POST",
    "path": "/api/login",
    "status": 200,
    "response": { "rc": 0, "code": "SUCCESS", "message": "success", "data": { "token": "abc" } }
  },
  {
    "enabled": true,
    "method": "GET",
    "path": "/api/user/{id}",
    "response": { "rc": 0, "code": "SUCCESS", "message": "success", "data": { "id": 100, "name": "张三" } }
  },
  {
    "enabled": true,
    "method": "GET",
    "path": "/api/orders",
    "response": { "rc": 0, "code": "SUCCESS", "message": "success", "data": { "list": ["第1页（兜底）"] } },
    "variants": [
      {
        "name": "分页第2页",
        "enabled": true,
        "when": { "query": { "page": "2" } },
        "response": { "rc": 0, "code": "SUCCESS", "message": "success", "data": { "list": ["第2页"] } }
      }
    ]
  }
]
```

## 变体条件的精确匹配语义

V1 只做**相等匹配**，一个变体的所有条件全部相等才命中（AND）：

- `--when-query k=v`：请求 query 中存在 k，且值按**字符串**相等。
- `--when-header k=v`：header 名大小写不敏感（存盘时统一小写），值按字符串相等。
- `--when-body a.b.c=v`：k 是 body 的**点路径**（数字段可索引数组，如 `items.0.id`），只有 JSON body 能命中。
  - 值先按 JSON 解析：`2` → 数字、`true` → 布尔、`{"a":1}` → 对象；解析失败按字符串。
    超出安全范围的大整数（如雪花 ID `1850123456789012345`）不解析，按原文存成字符串，免得被舍入。
  - 原始值比较时数字 / 字符串互转（`1` 与 `"1"` 命中）；任意一边是超出安全范围的整数时按数值比
    （请求体里写成数字字面量的雪花 ID 已被解析舍入，只能这样比）。
  - 条件值是对象 / 数组时走深度相等，**深度相等内部不做**数字 / 字符串互转。
  - `null` 只命中 `null`。

变体按数组顺序 **first-match**，都不命中时回退规则顶层的 `response` / `status` / `delay`——
所以「无条件的变体」是非法的，兜底就写在规则顶层。

**非法变体在加载时被静默丢弃**（缺 name / 缺 response / when 没有有效条件，key 为空或纯空白的条件不算），server 读规则文件时直接
过滤掉，不报错，也不影响同一规则的其它变体。经 CLI 写入会在写盘前报中文错误挡住，所以这种情况
主要发生在**手改文件**之后。

## 按次返回（sequence）

```json
{
  "method": "GET",
  "path": "/api/pay/status",
  "response": { "rc": 0, "code": "SUCCESS", "message": "success", "data": { "status": "SUCCESS" } },
  "sequence": [
    { "response": { "rc": 0, "code": "SUCCESS", "message": "success", "data": { "status": "PENDING" } } },
    { "status": 401, "delay": 300, "response": { "rc": 40100, "code": "TOKEN_EXPIRED", "message": "token 过期" } }
  ]
}
```

- 一条请求先看变体：命中变体就返回变体，**不算次数**；没命中才取 sequence 的下一项，全部用完后回到顶层。
- 计数只在运行中的 mock 进程内存里，按规则各自计。mock 重启、规则文件有任何改动（哪怕内容没变、只是重新写盘）、
  `vjtools mock reset-sequence`（`POST /__mock/sequence/reset`）都会让所有规则从第 1 项重新开始。
- 每一项的 `status` / `delay` 不填就沿用规则顶层的。请求控制参数（`__mockStatus` 等）照样优先于项里的值，
  那次请求也算用掉一项。
- 用完之后、规则又没有顶层 `response` 时：spec 内路径返回 swagger 样本（启用的规则接管了这个接口），
  spec 外路径透传后端（没配后端就 404）。所以「第 1 次 401、之后走真后端」只对 spec 外路径成立，
  spec 内的要在顶层写好成功响应。
- 并发请求各拿一项，不会两个请求拿到同一项；每一项自己的 `delay` 在取项之后才等待。
- 任何请求都会用掉一项，包括你自检用的 curl、前端 React StrictMode 开发模式下 effect 执行两次多发的那一遍。
  从 `x-mock-sequence` / `history` 能看出是第几项。
- 每一项的 `response` 与顶层 `response` 处理方式相同；命中时响应头 `x-mock-source: rule-sequence`、
  `x-mock-sequence: <第几项>/<总项数>`。
- 保存时（CLI / app）每一项必须是对象且带 `response`，少包一层直接报错；读取时（手改文件）缺 `response` 的项被静默丢弃，
  后面的项会顺位前移。

## 返回的 body 与状态码

**规则写的 response 原样返回**：顶层 `response`、变体、`sequence` 项都一样，spec 内外也一样，不套信封、不补字段，
大整数原样。所以 response 要写成前端拿到的**完整响应体**（带 `rc` / `code` / `message` 信封）；
`vjtools mock sample` 输出的推荐数据已经是完整信封，在它上面改值最省事。

状态码：请求控制参数（`__mockStatus`）＞ 变体 / sequence 项的 `status` ＞ 规则的 `status` ＞ 默认值。
默认值在 spec 外是 200；spec 内取该接口在 swagger 里定义的第一个 2xx（只定义了 201 的接口就是 201）。

### 只有 mock 自己生成的数据才套业务信封

没写 response 时（没有规则，或规则只写了 status / delay），body 来自 `mock-data/` override 文件或 swagger 样本。
这时只要该响应在 swagger 里声明了 `application/json`，就会整理成团队后端的信封：

- 已经是信封（含 `rc` / `code` / `message` 任一字段）→ 只补占位值：`rc` 为空或 `1` → `0`；`code` 为空或字面量
  `"string"` → `"SUCCESS"`；`message` 同理 → `"success"`。
- 不是信封（数组、裸对象）→ 包成 `{ rc: 0, code: "SUCCESS", message: "success", data: <原数据> }`。
- 状态码是 swagger 里没定义的错误码（如规则只写了 `status: 500`）→ `{ rc: 50000, code: "MOCK_500", message: "Mock status 500" }`。

所以「返回的不是我写的 response、多了一层 `{rc,code,message,data}`」说明**规则没命中**，看 `x-mock-source` 是谁给的响应。

## 文件放在哪

CLI 会自动定位这些文件，正常不用关心；排查「手改过文件」时才需要。基准目录（下称 `<mock-assets>`）：
`~/Library/Application Support/vjtools/mock-assets/`（macOS；其他平台以 `vjtools mock config` 打印的路径为准）

- 活动规则（mock server 实际读取、改完自动热载）：`<mock-assets>/mock-rules.json`
- 场景文件：`<mock-assets>/scenes/<场景名>.json`，结构与活动规则**完全一致**。
- 当前应用的场景标记：`<mock-assets>/applied-scene.json`（由应用动作写入，别手改）。
- override 数据文件：`<mock-assets>/mock-data/`（优先级低于规则，见 request-flow.md）。
- 配置：`~/Library/Application Support/vjtools/config.json`，只通过 `vjtools mock config` 改。

隔离环境用 `VJTOOLS_USER_DATA_DIR` 覆盖整个数据目录；也可用 `--file` / `MOCK_RULES_FILE` 显式指定活动规则文件。
