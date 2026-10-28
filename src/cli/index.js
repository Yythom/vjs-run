#!/usr/bin/env node
// vjtools 命令行入口。不依赖 Electron：npm 全局安装后用系统 node 跑，
// 也能用 app 内置 Electron 以 ELECTRON_RUN_AS_NODE 模式跑（数据目录与 app 共用）。
//
// 退出码：0 成功；1 失败；2 apply-scene 被守卫拒绝；3 mock 未运行。

import { Command } from "commander";
import { logs, restart, serve, start, status, stop } from "./mock-daemon.js";
import { config, describe, gen, history, init, routes, sample } from "./mock-tools.js";
import { createRuleCommand } from "./rule.js";
import { CliError, cliVersion } from "./util.js";

// 所有命令统一：出错不直接 process.exit（交给 runCli 收尾定退出码），报错前缀统一成 ✗。
// 放在构造函数里，rule 这类单独 new 出来再 addCommand 的命令也能生效
export class CustomCommand extends Command {
  constructor(name) {
    super(name);
    this.exitOverride();
    this.configureOutput({
      outputError: (str, write) => write(`✗ ${str.replace(/^error:\s*/i, "")}`),
    });
  }

  createCommand(name) {
    return new CustomCommand(name);
  }
}

export function buildProgram() {
  const { name, version } = cliVersion();
  const program = new CustomCommand();
  program
    .name("vjtools")
    .description("vjtools — 接口 mock 服务（与 vjtools app 共用配置、规则和场景）")
    .version(`${name} ${version}`, "-v, --version", "显示版本号");

  program
    .command("version")
    .description("显示版本号")
    .action(() => {
      console.log(`${name} ${version}`);
    });

  // 分组命令不挂 action：没给子命令时 commander 自己打印帮助；拼错时报 unknown command 并提示
  // Did you mean（挂了 action 会变成误导性的 too many arguments）
  const mock = program
    .command("mock")
    .description("接口 mock 服务（与 vjtools app 共用配置、规则和场景）");

  mock
    .command("start")
    .description("后台启动 mock，健康检查通过才返回")
    .action(async () => {
      const code = await start();
      if (typeof code === "number") process.exitCode = code;
    });

  mock
    .command("stop")
    .description("停止命令行启动的 mock")
    .action(async () => {
      const code = await stop();
      if (typeof code === "number") process.exitCode = code;
    });

  mock
    .command("restart")
    .description("重启")
    .action(async () => {
      const code = await restart();
      if (typeof code === "number") process.exitCode = code;
    });

  mock
    .command("serve")
    .description("前台运行，Ctrl+C 停止")
    .option("--daemon", "守护进程模式")
    .action(async (opts) => {
      await serve({ daemon: Boolean(opts.daemon) });
    });

  mock
    .command("status")
    .description("运行状态；未运行时退出码为 3")
    .option("--json", "以 JSON 格式输出")
    .action(async (opts) => {
      const code = await status({ json: Boolean(opts.json) });
      if (typeof code === "number") process.exitCode = code;
    });

  mock
    .command("logs")
    .description("后台日志（-f 持续跟随）")
    .option("-n, --lines <lines>", "查看最近行数", "50")
    .option("-f, --follow", "持续跟随")
    .action(async (opts) => {
      const lines = opts.lines === undefined ? 50 : Number(opts.lines);
      if (!Number.isInteger(lines) || lines <= 0) throw new CliError(`-n 必须是正整数：${opts.lines}`);
      const code = await logs({ lines, follow: Boolean(opts.follow) });
      if (typeof code === "number") process.exitCode = code;
    });

  mock
    .command("routes [keyword...]")
    .description("搜索 spec 里的接口（路径 / 摘要 / operationId）")
    .option("-m, --method <method>", "筛选 HTTP 方法")
    .option("-l, --limit <limit>", "限制返回条数")
    .option("--json", "以 JSON 格式输出")
    .action(async (keywordArr, opts) => {
      const keyword = Array.isArray(keywordArr) ? keywordArr.join(" ").trim() : "";
      const code = await routes(keyword, opts);
      if (typeof code === "number") process.exitCode = code;
    });

  mock
    .command("describe")
    .description("查看接口的请求参数、请求体与响应结构（写变体条件 / 造数据前用）")
    .option("-m, --method <method>", "请求方法")
    .option("-p, --path <path>", "接口路径（routes 里看到的完整路径，或带 {param} 的模板）")
    .option("--json", "以 JSON 格式输出")
    .action(async (opts) => {
      const code = await describe(opts);
      if (typeof code === "number") process.exitCode = code;
    });

  mock
    .command("sample")
    .description("按 swagger 生成一份推荐响应 JSON（输出到 stdout，改完可直接喂给 rule set）")
    .option("-m, --method <method>", "请求方法")
    .option("-p, --path <path>", "接口路径")
    .action(async (opts) => {
      const code = await sample(opts);
      if (typeof code === "number") process.exitCode = code;
    });

  mock
    .command("history")
    .description("请求历史记录")
    .option("-l, --limit <limit>", "条数限制")
    .option("-p, --path <path>", "按路径关键词过滤")
    .option("-k, --kind <kind>", "按类型过滤（mock|proxy|proxy-error|miss）")
    .option("--id <id>", "单条请求完整详情")
    .option("--json", "以 JSON 格式输出")
    .action(async (opts) => {
      const code = await history(opts);
      if (typeof code === "number") process.exitCode = code;
    });

  function addConfigOptions(cmd) {
    return cmd
      .option("--spec-dir [dir]", "OpenAPI JSON 所在目录")
      .option("--swagger-server [url]", "Swagger 源服务器")
      .option("--backend [url]", "后端代理地址")
      .option("--host [host]", "监听地址")
      .option("--port [port]", "监听端口")
      .option("--service-address [prefix]", "服务前缀")
      .option("--mock-all [bool]", "是否全量 mock");
  }

  addConfigOptions(mock.command("config"))
    .description("查看配置；带参数即修改（传 \"\" 清空）")
    .option("--json", "以 JSON 格式输出")
    .action(async (opts) => {
      const code = await config(opts);
      if (typeof code === "number") process.exitCode = code;
    });

  addConfigOptions(mock.command("init"))
    .description("首次使用：初始化数据目录；配了 Swagger 源服务器时顺带生成 spec")
    .action(async (opts) => {
      const code = await init(opts);
      if (typeof code === "number") process.exitCode = code;
    });

  mock
    .command("gen")
    .description("从 Swagger 源服务器生成 OpenAPI JSON")
    .action(async () => {
      const code = await gen();
      if (typeof code === "number") process.exitCode = code;
    });

  mock.addCommand(createRuleCommand(CustomCommand));

  return program;
}

export async function runCli(argv = process.argv) {
  const program = buildProgram();
  if (argv.length <= 2) {
    program.help();
    return 0;
  }
  await program.parseAsync(argv);
  return process.exitCode ?? 0;
}

runCli(process.argv).catch((err) => {
  if (
    err?.code === "commander.help" ||
    err?.code === "commander.helpDisplayed" ||
    err?.code === "commander.version"
  ) {
    process.exitCode = 0;
  } else if (err instanceof CliError || err?.constructor === Error) {
    console.error(`✗ ${err.message}`);
    process.exitCode = err.exitCode ?? 1;
  } else if (err?.code?.startsWith?.("commander.")) {
    process.exitCode = err.exitCode ?? 1;
  } else {
    console.error(err?.stack || err);
    process.exitCode = 1;
  }
});
