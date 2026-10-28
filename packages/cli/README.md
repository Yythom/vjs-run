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
| `vjtools mock config [参数]` | 查看 / 修改配置，运行中的 mock 会自动重启生效 |
| `vjtools mock gen` | 从 Swagger 源服务器重新生成 OpenAPI JSON |
| `vjtools mock rule <子命令>` | 增删改规则、变体、场景（`vjtools mock rule --help` 查看子命令） |

`status`、`routes`、`describe`、`history`、`config` 都支持 `--json` 输出。完整参数见 `vjtools mock --help`。

## 定制返回

所有参数均支持 `--key value` 与 `--key=value` 两种写法，多条件（如 `--when-query`）可重复传入。

```bash
# 让某个接口固定返回这份数据（mock 运行中会自动热载）
echo '{"rc":0,"data":{"name":"测试用户"}}' | vjtools mock rule set --method GET --path /api/user/profile

# 同一接口按 query 返回不同数据（也支持 --key=value 写法）
echo '{"rc":0,"data":[]}' | vjtools mock rule set-variant --method=GET --path=/api/orders --name=空列表 --when-query page=99

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
