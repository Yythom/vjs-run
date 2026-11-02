# 改配置、取真实响应、与 vjtools app 共存

SKILL.md 里这三件事只留了最常用的命令和必须遵守的规矩，细节在这里。

## 修改配置

Swagger 源服务器、后端代理地址等存在 `config.json`（不在 mock-assets 里），**不用走场景流程**：

```bash
vjtools mock config                                          # 查看
vjtools mock config --backend https://api.example.com/t2     # 修改（可只传其中一个；传 "" 表示清空）
vjtools mock config --swagger-server http://swagger.example.com/t2
```

- **后端代理地址**：没命中 mock 的请求回源到这里。改完 mock 会在进程内**自动重启**（请求历史保留）；
  `config` 会等它重启完再返回，看到「mock 已按新配置重启」就是生效了。重启失败（端口被占、spec 目录不存在等）
  会以退出码 1 报出原因，此时 mock 已经停了，改好配置后 `vjtools mock start`。
- **Swagger 源服务器**：只在生成 OpenAPI JSON 时使用，改完要接着 `vjtools mock gen`（mock 运行中会自动热更新路由）。
- 同一个命令还能改 `--spec-dir`（已有 OpenAPI JSON 的目录）、`--host` / `--port`、`--service-address`、
  `--mock-all true|false`。
- **`--host`** 只填地址本身，不带协议和端口：`0.0.0.0` 监听所有网卡（默认值，手机 / 同事电脑能连，局域网地址见
  `vjtools mock status`），`127.0.0.1` 只允许本机。装过 app 的用户配置里通常已经写死了 `127.0.0.1`，
  「手机连不上」时先看这个。

## 从请求历史取真实响应

用户说「用真实数据」「把刚才那个接口的返回存下来改一改」时：

1. 确认 mock 在跑：请求历史在运行中的 mock 进程内存里，没跑会以退出码 3 失败。没跑就先 `vjtools mock start`。
2. 让用户在前端触发一次请求（或你 curl 一次），`vjtools mock history --path <路径>` 找到 `#` 后面的编号。
3. `vjtools mock rule set --scene <名> --from-history <编号>`，之后照常改值、加变体。

- 历史最多 300 条；`vjtools mock restart` 或停掉再启动 mock 会清空（改配置引起的自动重启不清）——编号现查现用。
- 这几类记录会被拒绝，报错写明原因：代理失败（后端没连上）、未命中 / 没配后端时 mock 自己返回的 404 / 502（没有响应体）、
  后端返回的不是 JSON（HTML 等）、响应体太大没被完整记录。这时改用 `vjtools mock sample` 拿骨架。
- 后端响应里的大整数（雪花 ID）会原样存进规则、原样返回给前端，不用改成字符串。
- 存下的 path 默认是 swagger 路由模板（如 `/api/user/{id}`，同类请求都能命中），之后 `get` / `rm` / `set-variant`
  也要用这个模板路径定位；想存成别的路径就加 `--path`。状态码跟那条真实响应走（不是 200 才写进规则）。

## 与 vjtools app 共存

mock 只有一个后台进程：app 的「启动」和 `vjtools mock start` 起的是同一个，app 退出时 mock **不停**
（下次打开 app 自动接上）。只有两处要留意：

- **停 mock 前先确认用户不需要了**：用户可能正在 app 里看着它，`status` 的「启动方式」会写明是谁起的，
  只停你自己为了验证而启动的。端口被**另一个数据目录**（`VJTOOLS_USER_DATA_DIR` 隔离环境）的 mock 占着时，
  `status` / `stop` / `start` 都会说明，按提示到那个数据目录下操作或换端口，别去停它。
- **「录制」只能在 app 里开关，正在录制的场景不要用命令行写**（`set` / `set-variant` / `set-sequence` / `rename-scene` / `rm-scene`）：
  录制把规则攥在内存里，下一条请求到来就整份重写场景文件，命令行写进去的会被悄悄冲掉。
  命令行查不到录制状态，用户提到在录制时先请他停掉。录制具体录什么见 `request-flow.md`。
