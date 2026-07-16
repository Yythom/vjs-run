---
name: mock-rules
description: 为前端联调定制/修改接口 mock 数据时使用。覆盖 vjtools 的 mock 规则（mock-rules.json）的增删改查、字段格式、路径匹配与热载。当被要求"改某个接口返回什么"、"让 /api/xxx 返回 …"、"造一份假数据联调"、"关掉某条 mock"时触发。
---

# 定制 vjtools 的 mock 接口数据

vjtools 的 mock 服务按「规则」拦截请求并返回自定义 JSON。规则存在一个 JSON 数组文件里。
**改这个文件请优先用下面的 CLI，不要手撸 JSON**——手改极易漏逗号、覆盖别的规则或写错字段名（多余字段会被静默丢弃）。

## 规则文件在哪

运行时文件（app 实际读取、改完自动热载）：

```
~/Library/Application Support/vjtools/mock-assets/mock-rules.json
```

若 app 里改过路径，以 `~/Library/Application Support/vjtools/config.json` 的 `mockRulesFile` 字段为准。
CLI 会自动按这个优先级定位，通常无需关心。（e2e/隔离环境用 `VJTOOLS_USER_DATA_DIR` 覆盖 userData 目录。）

## 首选：用 CLI 操作（安全、幂等、有校验）

```bash
# 查看现有规则
node scripts/mock-rule.mjs list

# 让 GET /api/user/profile 返回自定义数据（response 从 stdin 读 JSON）
echo '{"rc":0,"code":"SUCCESS","data":{"name":"张三","vip":true}}' \
  | node scripts/mock-rule.mjs set --method GET --path /api/user/profile --status 200

# 复杂 JSON 建议先写文件再喂进去
node scripts/mock-rule.mjs set --method GET --path /api/items < /tmp/resp.json

# 查看 / 开关 / 删除单条
node scripts/mock-rule.mjs get     --method GET --path /api/user/profile
node scripts/mock-rule.mjs disable --method GET --path /api/user/profile
node scripts/mock-rule.mjs enable  --method GET --path /api/user/profile
node scripts/mock-rule.mjs rm      --method GET --path /api/user/profile
```

要点：
- `set` 按 **method + path 幂等定位**：命中则覆盖 response、未命中则追加，**绝不动其它规则**。
- `--method` 缺省为 `*`（匹配该 path 的所有请求方法）。
- 写入是原子替换（写 `.tmp` 再 rename），mock server 的 watcher 会自动热载，**无需重启**。
- 校验失败会以非 0 退出并打印原因（path 没以 `/` 开头、status 非整数、stdin 不是合法 JSON 等）。

## 规则 JSON 结构（理解用；手改时的兜底规范）

规则文件顶层是**数组**，每条规则字段如下（这是白名单，多余字段会被丢弃）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | string | 是 | 必须以 `/` 开头。支持 OpenAPI 风格占位符，如 `/api/user/{id}` |
| `method` | string | 否 | 大写；缺省/`"*"` 匹配所有方法 |
| `response` | any(JSON) | 否 | 命中时返回的 body。**这就是你要定制的接口数据** |
| `status` | integer | 否 | HTTP 状态码，缺省走默认 |
| `enabled` | boolean | 否 | 缺省 `true`；`false` 时该规则不生效 |

示例文件：

```json
[
  {
    "enabled": true,
    "method": "GET",
    "path": "/api/user/profile",
    "status": 200,
    "response": {
      "rc": 0,
      "code": "SUCCESS",
      "message": "success",
      "data": { "name": "张三", "vip": true }
    }
  },
  {
    "enabled": true,
    "method": "GET",
    "path": "/api/items/{id}",
    "response": { "rc": 0, "data": { "id": 100, "title": "示例" } }
  }
]
```

## 典型任务对照

- **"让某接口返回 X"** → `set --method <M> --path <P>`，X 从 stdin/文件喂入 `response`。
- **"某接口先关掉 mock，走真实后端"** → `disable`（保留规则，随时 `enable` 回来）。
- **"清掉这条 mock"** → `rm`。
- **"不知道 path 长啥样"** → 先 `list` 看已有规则；接口清单以 app 里的 mock 路由页 / swagger spec 为准。

## 收尾自检

改完至少做一步验证，别只写不看：
1. `node scripts/mock-rule.mjs list` 确认目标规则在、enabled 状态对。
2. `node scripts/mock-rule.mjs get --path <P>` 核对 `response` 内容完整。
3. 若 mock server 在跑，直接请求 `http://<mockHost>:<mockPort><path>` 确认实际返回（watcher 已热载）。
