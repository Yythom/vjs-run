// vjtools mock rule <子命令>：规则 / 变体 / 场景的增删改。
//
// 校验、定位、读写全部来自 src/mock/rules.js、scenes.js、applied-scene.js——与 app 是同一份
// 实现，CLI 写出的规则 app 一定认、app 写出的 CLI 也一定认。本文件只管命令行参数和输出。
//
// 活动规则文件定位优先级：--file > MOCK_RULES_FILE > <userData>/mock-assets/mock-rules.json。
// 场景：活动规则同目录的 scenes/<场景名>.json；带 --scene <名> 时所有命令改为操作该场景，
// 不碰活动规则，apply-scene 后才覆盖活动规则生效。mock server 按 mtime 自动热载，无需重启。
//
// set 按 method+path 幂等定位：命中则覆盖，未命中则追加，绝不动其它规则。
// set-variant 按 (规则, --name) 幂等定位；变体必须挂在已有规则上，规则顶层
// response 是「无变体命中」时的兜底。变体按数组顺序 first-match。

import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import {
  findRuleIndex,
  findVariantIndex,
  normalizeMockRule,
  normalizeRuleStrict,
  normalizeRulesForSave,
  readRulesFile,
  removeVariant,
  upsertRule,
  upsertVariant,
  writeRulesFile,
} from "../mock/rules.js";
import {
  deleteScene,
  listScenes,
  renameScene,
  sanitizeSceneName,
  sceneFilePath,
  scenesDirOf,
  writeSceneRules,
} from "../mock/scenes.js";
import { readAppliedScene, recordAppliedScene, renameAppliedScene } from "../mock/applied-scene.js";
import { normalizeVariantStrict } from "../mock/variant-match.js";
import { historyEntryToRule } from "../mock/history-rule.js";
import { readMockConfig, readRawConfig, toMockConfig } from "./config.js";
import { NOT_RUNNING_EXIT_CODE, detectRunningMock } from "./mock-daemon.js";
import { config as configCommand } from "./mock-tools.js";
import { cliPaths } from "./user-data.js";
import { CliError } from "./util.js";

const VARIANT_NAME_MAX = 60;

// ─── 参数规整 ────────────────────────────────────────────────────────────────

const collectRepeatable = (val, prev) => {
  if (Array.isArray(prev)) return [...prev, val];
  if (prev !== undefined) return [prev, val];
  return [val];
};

function normalizeFlags(raw = {}) {
  const flags = { ...raw };
  if (flags.whenQuery !== undefined) flags["when-query"] = flags.whenQuery;
  if (flags.whenHeader !== undefined) flags["when-header"] = flags.whenHeader;
  if (flags.whenBody !== undefined) flags["when-body"] = flags.whenBody;
  if (flags.swaggerServer !== undefined) flags["swagger-server"] = flags.swaggerServer;
  return flags;
}

/** 带值的 flag 却没跟值（commander 对 [value] 形式的可选值给 true）时给出用法提示 */
function valueFlag(flags, name, hint) {
  if (flags[name] === true) throw new CliError(hint);
  return flags[name];
}

function sceneNameFlag(raw) {
  if (raw === true || raw === undefined) throw new CliError("--scene 需要一个场景名");
  return sanitizeSceneName(String(raw));
}

function requireTarget(flags) {
  const rulePath = typeof flags.path === "string" ? flags.path.trim() : "";
  if (!rulePath) throw new CliError("缺少 --path");

  // method 必填且必须具体：mock server 只按具体 method 匹配，写 "*" 或不写的规则
  // 一条都不会命中。parseFlags 对「--method 后面没跟值」会给 true，一并挡掉。
  if (flags.method === undefined || flags.method === true) {
    throw new CliError("缺少 --method（如 --method GET）");
  }
  const method = String(flags.method).trim().toUpperCase();
  if (!method) throw new CliError("--method 不能为空");
  if (method === "*") {
    throw new CliError('--method 不能是 "*"：mock server 只匹配具体 method，通配规则不会命中');
  }
  return { method, rulePath };
}

function requireVariantName(flags) {
  const name = typeof flags.name === "string" ? flags.name.trim() : "";
  if (!name) throw new CliError("缺少 --name（变体名，规则内唯一）");
  if (name.length > VARIANT_NAME_MAX) throw new CliError(`变体名过长（最多 ${VARIANT_NAME_MAX} 字符）`);
  return name;
}

// --when-query/--when-header/--when-body（可重复）→ when 对象；一个都没给返回 undefined。
// header key 小写、body 值尝试 JSON.parse（2→数字、true→布尔、{"a":1}→对象，失败按字符串），
// 其余归一化交给 variant-match.js 的 normalizeVariantStrict。
function collectWhenFlags(flags) {
  const scopes = [
    ["when-query", "query"],
    ["when-header", "headers"],
    ["when-body", "body"],
  ];
  const when = {};
  let total = 0;
  for (const [flag, scope] of scopes) {
    // 可选值的 flag 缺值时 commander 不走 collectRepeatable，直接把整个值覆盖成 true
    const raw = flags[flag];
    const entries = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    for (const entry of entries) {
      if (entry === true) throw new CliError(`--${flag} 需要 key=value 形式，如 --${flag} page=2`);
      const text = String(entry);
      const eq = text.indexOf("=");
      if (eq <= 0) throw new CliError(`--${flag} 需要 key=value 形式：${text}`);
      const key = scope === "headers" ? text.slice(0, eq).toLowerCase() : text.slice(0, eq);
      let value = text.slice(eq + 1);
      if (scope === "body") {
        try {
          value = JSON.parse(value);
        } catch {
          // 保留原字符串
        }
      }
      (when[scope] ||= {})[key] = value;
      total++;
    }
  }
  return total > 0 ? when : undefined;
}

function readStdin() {
  if (process.stdin.isTTY) return null; // 没有管道输入时不阻塞
  try {
    const text = fs.readFileSync(0, "utf8").trim();
    return text || null;
  } catch {
    return null;
  }
}

function readJsonStdin() {
  const text = readStdin();
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new CliError(`stdin 不是合法 JSON：${err.message}`);
  }
}

// 请求历史在跑 mock 的进程内存里（CLI 后台进程或 app），只能从运行中的 mock 取。
// 转换规则与 app 的「存入场景」共用 history-rule.js
async function ruleFromHistory(flags) {
  const id = valueFlag(flags, "fromHistory", "--from-history 需要一个请求编号（vjtools mock history 里 # 后面的数字）");
  const paths = cliPaths();
  const running = await detectRunningMock(paths, readMockConfig(paths.configFile));
  if (!running) {
    throw new CliError("mock 未在运行，读不到请求历史（--from-history 需要 mock 在跑）", NOT_RUNNING_EXIT_CODE);
  }
  const res = await fetch(`${running.url}/__mock/history`).catch(() => null);
  if (!res?.ok) throw new CliError(`读取请求历史失败：${res ? `HTTP ${res.status}` : "连接失败"}`);
  const entry = (await res.json()).find((item) => String(item.id) === String(id));
  if (!entry) throw new CliError(`没有编号为 ${id} 的请求（只保留最近 300 条；mock 进程重启后会清空）`);
  const rule = historyEntryToRule(entry);
  if (!rule) throw new CliError(`#${id} 的响应体没有被完整记录（超出记录上限），不能存成规则`);
  return { id, rule };
}

// ─── 定位 ────────────────────────────────────────────────────────────────────

function resolveRulesFile(flags) {
  if (flags.file === true) throw new CliError("--file 需要一个规则文件路径");
  if (flags.file) return path.resolve(flags.file);
  if (process.env.MOCK_RULES_FILE) return path.resolve(process.env.MOCK_RULES_FILE);
  return cliPaths().rulesFile;
}

function resolveContext(flags) {
  const rulesFile = resolveRulesFile(flags);
  const scenesDir = scenesDirOf(rulesFile);
  const isScene = flags.scene !== undefined;
  return {
    rulesFile,
    scenesDir,
    // 本次命令实际操作的文件：带 --scene 时是场景文件，否则是活动规则
    target: isScene ? sceneFilePath(scenesDir, sceneNameFlag(flags.scene)) : rulesFile,
    applyHint: isScene
      ? "（场景文件，apply-scene 应用后才生效）"
      : "（mock server 将自动热载）",
  };
}

function findRuleOrFail(rules, method, rulePath, hint = "") {
  const index = findRuleIndex(rules, method, rulePath);
  if (index < 0) throw new CliError(`未找到规则：${method} ${rulePath}${hint}`);
  return index;
}

// ─── 命令 ────────────────────────────────────────────────────────────────────

const COMMANDS = {
  list(flags, ctx) {
    const rules = readRulesFile(ctx.target);
    console.log(`# ${ctx.target}`);
    if (!rules.length) {
      console.log("(空)");
      return;
    }
    for (const r of rules) {
      const flag = r.enabled === false ? "○" : "●";
      const status = r.status ? ` [${r.status}]` : "";
      const delay = r.delay ? ` +${r.delay}ms` : "";
      // method 无效的规则不会被 mock server 命中，CLI 又拒收 --method '*'、定位不到它们，
      // 只能手改文件。列出来时说清楚，免得用户对着它反复试命令。
      const method = String(r.method || "").toUpperCase();
      const bad = !method || method === "*" ? "  ← method 无效，不会命中（需手改文件删除）" : "";
      console.log(`${flag} ${(method || "?").padEnd(6)} ${r.path}${status}${delay}${bad}`);
      if (Array.isArray(r.variants) && r.variants.length) {
        const summary = r.variants.map((v) => `${v.enabled === false ? "○" : "●"}${v.name}`).join(" ");
        console.log(`    ▸ 变体×${r.variants.length}：${summary}`);
      }
    }
  },

  get(flags, ctx) {
    const { method, rulePath } = requireTarget(flags);
    const rules = readRulesFile(ctx.target);
    console.log(JSON.stringify(rules[findRuleOrFail(rules, method, rulePath)], null, 2));
  },

  async set(flags, ctx) {
    // --from-history：response 取自那条请求的真实响应（不读 stdin）；method / path 默认也取自它，
    // 可以用 --method / --path 改存到别处
    const history = flags.fromHistory !== undefined ? await ruleFromHistory(flags) : null;
    const { method, rulePath } = requireTarget(
      history
        ? { method: flags.method ?? history.rule.method, path: flags.path ?? history.rule.path }
        : flags,
    );
    const response = history ? history.rule.response : readJsonStdin();
    const rules = readRulesFile(ctx.target);
    const index = findRuleIndex(rules, method, rulePath);
    const existing = index >= 0 ? rules[index] : {};

    // 没传的字段保留原值；variants 只由 set-variant / rm-variant 管理，这里原样带上。
    // 来自历史时状态码跟着那条真实响应走（200 就不写），不沿用旧值
    const next = normalizeRuleStrict({
      method,
      path: rulePath,
      variants: existing.variants,
      response: response !== undefined ? response : existing.response,
      status:
        flags.status !== undefined
          ? valueFlag(flags, "status", "--status 需要一个整数值，如 --status 200")
          : history
            ? history.rule.status
            : existing.status,
      delay:
        flags.delay !== undefined
          ? valueFlag(flags, "delay", "--delay 需要一个毫秒数，如 --delay 500")
          : existing.delay,
      enabled: flags.disabled ? false : flags.enabled ? true : existing.enabled !== false,
    });

    const { rules: saved, created } = upsertRule(rules, next);
    writeRulesFile(ctx.target, saved);
    const origin = history ? `（response 取自请求历史 #${history.id}）` : "";
    console.log(`✔ 已${created ? "新增" : "更新"}：${method} ${rulePath}${origin}`);
    console.log(`  → ${ctx.target}${ctx.applyHint}`);
  },

  "set-variant"(flags, ctx) {
    const { method, rulePath } = requireTarget(flags);
    const name = requireVariantName(flags);
    const rules = readRulesFile(ctx.target);
    const index = findRuleOrFail(
      rules,
      method,
      rulePath,
      "\n  变体必须挂在已有规则上（规则顶层 response 兜底）：先用 set 创建",
    );
    const response = readJsonStdin();
    const when = collectWhenFlags(flags);
    const rule = rules[index];
    const existing = rule.variants?.[findVariantIndex(rule, name)];

    if (!existing && response === undefined) throw new CliError("新建变体必须从 stdin 提供 response JSON");
    if (!existing && !when) {
      throw new CliError("新建变体至少要一个条件：--when-query/--when-header/--when-body key=value");
    }

    const variant = normalizeVariantStrict(
      {
        name,
        enabled: flags.disabled ? false : flags.enabled ? true : !existing || existing.enabled !== false,
        // 给了任意 --when-* 就整体替换（不做逐 key 合并）；没给保留原有
        when: when ?? existing.when,
        response: response !== undefined ? response : existing.response,
        status:
          flags.status !== undefined
            ? valueFlag(flags, "status", "--status 需要一个整数值，如 --status 200")
            : existing?.status,
        delay:
          flags.delay !== undefined
            ? valueFlag(flags, "delay", "--delay 需要一个毫秒数，如 --delay 500")
            : existing?.delay,
      },
      `变体「${name}」`,
    );

    const { rule: updated, created } = upsertVariant(rule, variant);
    rules[index] = normalizeRuleStrict(updated);
    writeRulesFile(ctx.target, rules);
    console.log(`✔ 已${created ? "新增" : "更新"}变体：${name}（${method} ${rulePath}）`);
    console.log(`  → ${ctx.target}${ctx.applyHint}`);
  },

  "rm-variant"(flags, ctx) {
    const { method, rulePath } = requireTarget(flags);
    const name = requireVariantName(flags);
    const rules = readRulesFile(ctx.target);
    const index = findRuleOrFail(rules, method, rulePath);
    const { rule, removed } = removeVariant(rules[index], name);
    if (!removed) throw new CliError(`未找到变体：${name}（${method} ${rulePath}）`);
    rules[index] = rule;
    writeRulesFile(ctx.target, rules);
    console.log(`✔ 已删除变体：${name}（${method} ${rulePath}）`);
    console.log(`  → ${ctx.target}${ctx.applyHint}`);
  },

  enable(flags, ctx) {
    toggle(flags, ctx, true);
  },

  disable(flags, ctx) {
    toggle(flags, ctx, false);
  },

  rm(flags, ctx) {
    const { method, rulePath } = requireTarget(flags);
    const rules = readRulesFile(ctx.target);
    rules.splice(findRuleOrFail(rules, method, rulePath), 1);
    writeRulesFile(ctx.target, rules);
    console.log(`✔ 已删除：${method} ${rulePath}`);
  },

  scenes(flags, ctx) {
    const scenes = listScenes(ctx.scenesDir);
    if (!scenes.length) {
      console.log(`(无场景) ${ctx.scenesDir}`);
      return;
    }
    console.log(`# ${ctx.scenesDir}`);
    const applied = readAppliedScene(ctx.rulesFile);
    for (const { name, ruleCount } of scenes) {
      const mark = name === applied ? "  ← 当前应用中" : "";
      console.log(`  ${name.padEnd(24)} ${ruleCount} 条${mark}`);
    }
  },

  "new-scene"(flags, ctx) {
    const name = sceneNameFlag(flags.scene);
    const file = sceneFilePath(ctx.scenesDir, name);
    if (fs.existsSync(file)) {
      throw new CliError(`场景已存在：${name}\n  换个名字，或直接用 set --scene ${name} --path <P> 往里加接口`);
    }
    writeSceneRules(ctx.scenesDir, name, []);
    console.log(`✔ 已创建空场景：${name}`);
    console.log(`  → ${file}`);
    console.log(`  用 set --scene ${name} --path <P> 往里加接口；完成后 apply-scene --scene ${name} 应用`);
  },

  "rename-scene"(flags, ctx) {
    // 「录制中禁止改名」是 app 进程内状态，CLI 无法检查
    const from = sceneNameFlag(flags.scene);
    if (flags.to === true || flags.to === undefined) throw new CliError("--to 需要一个新场景名");
    const to = sanitizeSceneName(String(flags.to));
    if (!fs.existsSync(sceneFilePath(ctx.scenesDir, from))) throw new CliError(`场景不存在：${from}`);
    if (to === from) {
      console.log(`✔ 新旧名字相同，无需重命名：${from}`);
      return;
    }
    renameScene(ctx.scenesDir, from, to);
    // 标记跟着改名，否则改名后的场景会被误判为「未在使用」
    renameAppliedScene(ctx.rulesFile, from, to);
    console.log(`✔ 已重命名：${from} → ${to}`);
    console.log(`  → ${sceneFilePath(ctx.scenesDir, to)}`);
  },

  "apply-scene"(flags, ctx) {
    const name = sceneNameFlag(flags.scene);
    const sceneFile = sceneFilePath(ctx.scenesDir, name);
    if (!fs.existsSync(sceneFile)) throw new CliError(`场景不存在：${name}`);
    // 与 app 的「应用场景」走同一套校验
    const rules = normalizeRulesForSave(readRulesFile(sceneFile));

    // 守卫只在 CLI（AI 调用）这边：app 里是用户亲手点的「应用」
    const active = readRulesFile(ctx.rulesFile);
    const applied = readAppliedScene(ctx.rulesFile);
    let reason;
    if (flags.force) reason = "--force";
    else if (!active.length) reason = "活动规则为空";
    else if (applied === name) reason = "该场景正是当前应用的场景";
    else {
      const current = applied ? `当前应用的是场景「${applied}」` : "当前没有记录在用的场景";
      throw new CliError(
        `未应用：活动规则里已有 ${active.length} 条规则，${current}，应用会把它们整体覆盖。\n` +
          "  先问用户是否覆盖；用户明确同意后再加 --force（装了 vjtools app 也可以在 app 里「应用」）。",
        2,
      );
    }

    writeRulesFile(ctx.rulesFile, rules);
    recordAppliedScene(ctx.rulesFile, name);
    console.log(`✔ 已应用场景「${name}」（${rules.length} 条规则，依据：${reason}）`);
    console.log(`  → ${ctx.rulesFile}（mock server 将自动热载）`);
  },

  // 把当前活动规则存成场景快照：apply-scene --force 覆盖前先备份，用户随时能切回来。
  // 与 app「存为场景」一致按读取路径宽松规整；活动规则文件损坏时报错，不会存出一个空场景
  "save-scene"(flags, ctx) {
    const name = sceneNameFlag(flags.scene);
    const file = sceneFilePath(ctx.scenesDir, name);
    if (fs.existsSync(file) && !flags.force) {
      throw new CliError(`场景已存在：${name}\n  换个名字；确认要用当前活动规则覆盖它时再加 --force`);
    }
    const rules = readRulesFile(ctx.rulesFile).map(normalizeMockRule);
    writeSceneRules(ctx.scenesDir, name, rules);
    console.log(`✔ 已把当前活动规则（${rules.length} 条）存为场景「${name}」`);
    console.log(`  → ${file}`);
  },

  "rm-scene"(flags, ctx) {
    const name = sceneNameFlag(flags.scene);
    const file = sceneFilePath(ctx.scenesDir, name);
    if (!fs.existsSync(file)) throw new CliError(`场景不存在：${name}`);
    // 只删场景文件本身，不影响活动 mock-rules.json（即使该场景曾被「应用」过）
    deleteScene(ctx.scenesDir, name);
    console.log(`✔ 已删除场景：${name}`);
    console.log(`  → ${file}`);
  },

  // 兼容旧用法：等同 vjtools mock config，只接这两个地址参数
  config(flags) {
    const values = {};
    for (const flag of ["swagger-server", "backend"]) {
      if (flags[flag] === undefined) continue;
      values[flag] = String(valueFlag(flags, flag, `--${flag} 需要一个地址（传 "" 表示清空）`));
    }
    return configCommand(values);
  },

  // 自检用：打印 mock server 地址，供后续 curl $BASE/__mock/... 使用。
  // --quiet 只输出地址本身，便于 BASE=$(vjtools mock rule base --quiet) 直接取值。
  // config.json 缺失 / 损坏时回退默认值，不报错。
  base(flags) {
    const { configFile } = cliPaths();
    let raw = null;
    try {
      raw = readRawConfig(configFile);
    } catch {
      // 损坏：用默认值
    }
    const { host, port } = toMockConfig(raw || {});
    const url = `http://${host}:${port}`;
    console.log(url);
    if (flags.quiet) return;
    const fromConfig = Boolean(raw?.mockHost);
    console.log(`  来源：${fromConfig ? configFile : `${configFile}（读不到，用默认值）`}`);
    console.log(`  自检：curl -fsS ${url}/__mock/health`);
  },
};

function toggle(flags, ctx, enabled) {
  const { method, rulePath } = requireTarget(flags);
  const rules = readRulesFile(ctx.target);
  const index = findRuleOrFail(rules, method, rulePath);
  rules[index] = { ...rules[index], enabled };
  writeRulesFile(ctx.target, rules);
  console.log(`✔ 已${enabled ? "启用" : "禁用"}：${method} ${rulePath}`);
}

export function createRuleCommand(CommandClass = Command) {
  const rule = new CommandClass("rule")
    .description("增删改 mock 规则 / 变体 / 场景（mock server 自动热载）")
    .option("--file [file]", "指定规则文件路径（或环境变量 MOCK_RULES_FILE）")
    .option("--scene [name]", "指定场景名");

  const exec = (fn) => async function () {
    const flags = normalizeFlags(this.optsWithGlobals());
    try {
      const code = await fn(flags, resolveContext(flags));
      if (typeof code === "number") process.exitCode = code;
      return code;
    } catch (err) {
      if (err?.constructor === Error) throw new CliError(err.message);
      throw err;
    }
  };

  rule
    .command("list")
    .description("列出规则（带 --scene 列场景内规则）")
    .action(exec(COMMANDS.list));

  rule
    .command("get")
    .description("查看单条规则")
    .option("-p, --path [path]", "规则路径")
    .option("-m, --method [method]", "请求方法")
    .action(exec(COMMANDS.get));

  rule
    .command("set")
    .description("新增/覆盖规则；response 从 stdin 读 JSON")
    .option("-p, --path [path]", "规则路径")
    .option("-m, --method [method]", "请求方法")
    .option("--status [status]", "HTTP 状态码")
    .option("--delay [delay]", "延迟毫秒数")
    .option("--disabled", "创建为禁用状态")
    .option("--enabled", "创建为启用状态")
    .option("--from-history [id]", "response 取自请求历史里这条请求（vjtools mock history 的编号）；method / path 默认也取自它")
    .action(exec(COMMANDS.set));

  rule
    .command("set-variant")
    .description("同路径按条件返回不同响应")
    .option("-p, --path [path]", "规则路径")
    .option("-m, --method [method]", "请求方法")
    .option("-n, --name [name]", "变体名（规则内唯一）")
    .option("--status [status]", "HTTP 状态码")
    .option("--delay [delay]", "延迟毫秒数")
    .option("--disabled", "创建为禁用状态")
    .option("--enabled", "创建为启用状态")
    .option("--when-query [pair]", "query 条件（key=value）", collectRepeatable)
    .option("--when-header [pair]", "header 条件（key=value）", collectRepeatable)
    .option("--when-body [pair]", "body 条件（path=value）", collectRepeatable)
    .action(exec(COMMANDS["set-variant"]));

  rule
    .command("rm-variant")
    .description("删除单个变体")
    .option("-p, --path [path]", "规则路径")
    .option("-m, --method [method]", "请求方法")
    .option("-n, --name [name]", "变体名")
    .action(exec(COMMANDS["rm-variant"]));

  rule
    .command("enable")
    .description("启用规则")
    .option("-p, --path [path]", "规则路径")
    .option("-m, --method [method]", "请求方法")
    .action(exec(COMMANDS.enable));

  rule
    .command("disable")
    .description("禁用规则")
    .option("-p, --path [path]", "规则路径")
    .option("-m, --method [method]", "请求方法")
    .action(exec(COMMANDS.disable));

  rule
    .command("rm")
    .description("删除规则")
    .option("-p, --path [path]", "规则路径")
    .option("-m, --method [method]", "请求方法")
    .action(exec(COMMANDS.rm));

  rule
    .command("scenes")
    .description("列出所有场景")
    .action(exec(COMMANDS.scenes));

  rule
    .command("new-scene")
    .description("新建空场景")
    .action(exec(COMMANDS["new-scene"]));

  rule
    .command("rename-scene")
    .description("重命名场景")
    .option("--to [to]", "新场景名")
    .action(exec(COMMANDS["rename-scene"]));

  rule
    .command("apply-scene")
    .description("应用场景（覆盖活动规则）")
    .option("--force", "跳过守卫检查直接覆盖")
    .action(exec(COMMANDS["apply-scene"]));

  rule
    .command("save-scene")
    .description("把当前活动规则存为场景（快照；apply-scene --force 前先备份）")
    .option("--force", "同名场景已存在时覆盖")
    .action(exec(COMMANDS["save-scene"]));

  rule
    .command("rm-scene")
    .description("删除整个场景文件")
    .action(exec(COMMANDS["rm-scene"]));

  rule
    .command("config")
    .description("同 vjtools mock config")
    .option("--swagger-server [url]", "Swagger 源服务器")
    .option("--backend [url]", "后端代理地址")
    .action(exec((flags) => COMMANDS.config(flags)));

  rule
    .command("base")
    .description("打印 mock server 地址")
    .option("-q, --quiet", "只输出地址本身")
    .action(exec(COMMANDS.base));

  return rule;
}
