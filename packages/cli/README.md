# vjtools-cli

vjtools 的接口 mock 服务命令行版。**不装 vjtools app 也能用**：根据 OpenAPI / Swagger 文档起 mock、按规则和场景定制返回、未命中的请求转发真后端、查每条请求走了哪条路。

装了 app 的话，两边共用同一份配置、规则和场景，mock 也是同一个后台进程：app 里点「启动」和 `vjtools mock start` 起的是同一个，app 退出 mock 不停，下次打开 app 自动接上。

## 安装

需要 Node.js ≥ 22.12。已经装了 vjtools app 的话不用装这个包：在 app「开发环境体检」页点「安装到命令行」，用的是 app 自带的运行时，连 node 都不需要。

```bash
npm i -g vjtools-cli
```

## 快速开始

```bash
# 1. 配置 Swagger 源服务器和后端地址，并拉取 OpenAPI 文档
vjtools mock init --swagger-server http://your-swagger-host/t2 --backend http://your-backend-host/t2

# 2. 后台启动（健康检查通过才返回）
vjtools mock start

# 3. 前端把接口代理到 mock 地址（默认 http://127.0.0.1:3002）
```

默认监听所有网卡（`0.0.0.0`），手机、同事电脑在同一局域网里也能连，局域网地址见 `vjtools mock status`。只想本机用：`vjtools mock config --host 127.0.0.1`。

已经有 OpenAPI JSON 文件的话，用 `vjtools mock config --spec-dir <目录>` 指过去就行，不用 `gen`。

## 命令

| 命令 | 说明 |
|---|---|
| `vjtools mock start` / `stop` / `restart` | 后台启停 |
| `vjtools mock status [--json]` | 运行状态；未运行时退出码为 3 |
| `vjtools mock logs [-n 50] [-f]` | 后台日志 |
| `vjtools mock serve` | 前台运行，Ctrl+C 停止 |
| `vjtools mock routes [关键词] [--method GET]` | 搜索 spec 里的接口 |
| `vjtools mock describe --method <M> --path <P>` | 接口的参数、请求体、响应字段（含说明和例值） |
| `vjtools mock sample --method <M> --path <P>` | 按 swagger 生成一份推荐响应 JSON，改完直接喂给 `rule set` |
| `vjtools mock history [--path 关键词] [--kind mock\|proxy\|miss]` | 最近的请求，以及每条是 mock 还是代理 |
| `vjtools mock history --id <编号>` | 单条请求的请求体 / 响应体 |
| `vjtools mock reset-sequence` | 按次返回的计数清零，下一次请求从第 1 项开始 |
| `vjtools mock config [参数]` | 查看 / 修改配置，运行中的 mock 会自动重启生效 |
| `vjtools mock gen` | 从 Swagger 源服务器重新生成 OpenAPI JSON |
| `vjtools mock rule <子命令>` | 增删改规则、变体、按次返回、场景，见下表 |

`status`、`routes`、`describe`、`history`、`config` 都支持 `--json` 输出。完整参数见 `vjtools mock --help`。

### `vjtools mock rule` 子命令

带 `--scene <名>` 时操作场景文件（`scenes/<名>.json`），不碰活动规则，`apply-scene` 之后才生效；不带就直接改活动规则，运行中的 mock 自动热载。`--file <路径>`（或环境变量 `MOCK_RULES_FILE`）可以换一个活动规则文件。

| 子命令 | 说明 |
|---|---|
| `list` | 列出规则，含变体、按次返回的摘要 |
| `get --method <M> --path <P>` | 查看单条规则的完整 JSON |
| `set --method <M> --path <P> [--status <码>] [--delay <毫秒>] [--disabled\|--enabled]` | 新增或覆盖规则，response 从 stdin 读；没传的字段保留原值 |
| `set --from-history <编号> [--method <M>] [--path <P>]` | response 取自请求历史里的这条请求，method / path 默认也取自它 |
| `set-variant --method <M> --path <P> --name <名> --when-query k=v` | 同一路径按条件返回不同响应，按变体名新增或更新；条件还有 `--when-header k=v`、`--when-body a.b=v`，都可重复传，也可带 `--status` / `--delay` / `--disabled` |
| `rm-variant --method <M> --path <P> --name <名>` | 删除单个变体 |
| `set-sequence --method <M> --path <P>` | 按次返回：stdin 传 JSON 数组，第 n 次请求返回第 n 项，用完回到规则自己的 response；传 `[]` 清空 |
| `enable` / `disable --method <M> --path <P>` | 启用 / 停用规则 |
| `rm --method <M> --path <P>` | 删除规则 |
| `scenes` | 列出所有场景，标出当前应用中的那个 |
| `new-scene --scene <名>` | 新建空场景 |
| `rename-scene --scene <旧名> --to <新名>` | 重命名场景 |
| `apply-scene --scene <名> [--force]` | 用场景整体覆盖活动规则；活动规则不为空、又不是当前应用的场景时退出码 2，加 `--force` 才覆盖 |
| `save-scene --scene <名> [--force]` | 把当前活动规则存成场景（覆盖前先备份）；同名已存在时加 `--force` 覆盖 |
| `rm-scene --scene <名>` | 删除场景文件，不影响活动规则 |
| `base [--quiet]` | 打印 mock server 地址；`--quiet` 只输出地址，方便 `BASE=$(vjtools mock rule base --quiet)` |

## 定制返回

所有参数均支持 `--key value` 与 `--key=value` 两种写法，多条件（如 `--when-query`）可重复传入。

response 从 stdin 读。管道在第一块数据到来之前有等待上限：shell 管道 10s，程序调用（如 `child_process.exec`）1s，超时按没有输入处理，所以只改状态码 / 延迟时不传 stdin 也不会卡住。程序调用要传 response，写完记得关闭 stdin。

```bash
# 让某个接口固定返回这份数据（mock 运行中会自动热载）
echo '{"rc":0,"data":{"name":"测试用户"}}' | vjtools mock rule set --method GET --path /api/user/profile

# 同一接口按 query 返回不同数据（也支持 --key=value 写法）
echo '{"rc":0,"data":[]}' | vjtools mock rule set-variant --method=GET --path=/api/orders --name=空列表 --when-query page=99

# 按次返回：第 1 次处理中，第 2 次 401，第 3 次起回到这条规则自己的 response（每一项都要包一层 response）
echo '[{"response":{"rc":0,"data":{"status":"PENDING"}}},{"status":401,"response":{"rc":40100}}]' \
  | vjtools mock rule set-sequence --method GET --path /api/user/profile

# 模拟慢接口 / 报错
echo '{"rc":500}' | vjtools mock rule set --method POST --path /api/pay --status 500 --delay 3000

# 按 swagger 生成骨架，改完写回
vjtools mock sample --method GET --path /api/user/profile > resp.json
vjtools mock rule set --method GET --path /api/user/profile < resp.json

# 用真实后端返回过的数据（编号见 vjtools mock history）
vjtools mock rule set --scene 联调 --from-history 12

# 覆盖前先把当前规则存成场景备份
vjtools mock rule save-scene --scene 备份
```

## 数据目录

与 vjtools app 的 userData 相同：

- macOS：`~/Library/Application Support/vjtools`
- Windows：`%APPDATA%\vjtools`
- Linux：`~/.config/vjtools`

设置环境变量 `VJTOOLS_USER_DATA_DIR` 可以换到别的目录（例如隔离测试）。

## 退出码

`0` 成功 · `1` 失败 · `2` apply-scene 被守卫拒绝 · `3` mock 未运行
