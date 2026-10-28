# 规则格式、变体匹配语义与信封化

写 / 改规则一律用 `vjtools mock rule …`，这里是「看懂规则文件、解释返回结果」用的参考。

## 规则 JSON 结构（场景文件与活动规则同结构）

顶层是**数组**，每条规则按下面的字段白名单重建，多余字段会被丢弃：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | string | 是 | 必须以 `/` 开头（会编译成锚定正则匹配请求 pathname，不带 `/` 的永远命中不了）。支持 OpenAPI 风格占位符，如 `/api/user/{id}` |
| `method` | string | **是** | 大写的具体方法（`GET`/`POST`/…）。缺省或 `"*"` 的规则不会被命中，只会在 mock 启动日志里收到一条警告 |
| `response` | any(JSON) | 否 | 命中时返回的 body。**这就是要定制的接口数据** |
| `status` | integer | 否 | HTTP 状态码（100–599），缺省走默认 |
| `delay` | integer | 否 | 响应延迟毫秒数（≥0），返回前先等待，用于模拟慢接口 |
| `enabled` | boolean | 否 | 缺省 `true`；`false` 时该规则不生效 |
| `variants` | array | 否 | 变体数组。每个变体：`name`（必填，规则内唯一，≤60 字符）、`when`（必填，`{query?, headers?, body?}` 至少 1 个条件）、`response`（必填）、`status`/`delay`/`enabled`（可选，缺省回退规则顶层） |

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

## 变体条件的精确匹配语义

V1 只做**相等匹配**，一个变体的所有条件全部相等才命中（AND）：

- `--when-query k=v`：请求 query 中存在 k，且值按**字符串**相等。
- `--when-header k=v`：header 名大小写不敏感（存盘时统一小写），值按字符串相等。
- `--when-body a.b.c=v`：k 是 body 的**点路径**（数字段可索引数组，如 `items.0.id`），只有 JSON body 能命中。
  - 值先按 JSON 解析：`2` → 数字、`true` → 布尔、`{"a":1}` → 对象；解析失败按字符串。
  - 原始值比较时数字 / 字符串互转（`1` 与 `"1"` 命中）。
  - 条件值是对象 / 数组时走深度相等，**深度相等内部不做**数字 / 字符串互转。
  - `null` 只命中 `null`。

变体按数组顺序 **first-match**，都不命中时回退规则顶层的 `response` / `status` / `delay`——
所以「无条件的变体」是非法的，兜底就写在规则顶层。

**非法变体在加载时被静默丢弃**（缺 name / 缺 response / when 没有有效条件），server 读规则文件时直接
过滤掉，不报错，也不影响同一规则的其它变体。经 CLI 写入会在写盘前报中文错误挡住，所以这种情况
主要发生在**手改文件**之后。

## 响应会被「信封化」——最容易踩的坑

**仅当路径在 swagger spec 里有定义、且该响应声明了 `application/json` 时**，server 会给 `response`
套一层业务信封再返回：

- 写的已经是信封（含 `rc` / `code` / `message` 任一字段）→ 原样返回，只把缺省 / 占位值补齐：
  `rc` 为空或 `1` → `0`；`code` 为空或字面量 `"string"` → `"SUCCESS"`；`message` 同理 → `"success"`。
- 写的**不是**信封（比如直接给了数组或裸对象）→ 被包成
  `{ rc: 0, code: "SUCCESS", message: "success", data: <你写的> }`。

所以「明明写了 `[1,2,3]`，前端却收到 `{rc:0,...,data:[1,2,3]}`」是预期行为。
想要完全原样的 body，就**自己写成带 `rc` 的完整信封**（skill 里的示例都这么写）。

spec 之外的路径不做任何加工：`response` 原样返回，状态码取规则的 `status`（默认 200）。
override 文件命中时同样走信封化（见 request-flow.md）。

## 文件放在哪

CLI 会自动定位这些文件，正常不用关心；排查「手改过文件」时才需要。基准目录（下称 `<mock-assets>`）：
`~/Library/Application Support/vjtools/mock-assets/`（macOS；其他平台以 `vjtools mock config` 打印的路径为准）

- 活动规则（mock server 实际读取、改完自动热载）：`<mock-assets>/mock-rules.json`
- 场景文件：`<mock-assets>/scenes/<场景名>.json`，结构与活动规则**完全一致**。
- 当前应用的场景标记：`<mock-assets>/applied-scene.json`（由应用动作写入，别手改）。
- override 数据文件：`<mock-assets>/mock-data/`（优先级低于规则，见 request-flow.md）。
- 配置：`~/Library/Application Support/vjtools/config.json`，只通过 `vjtools mock config` 改。

隔离环境用 `VJTOOLS_USER_DATA_DIR` 覆盖整个数据目录；也可用 `--file` / `MOCK_RULES_FILE` 显式指定活动规则文件。
