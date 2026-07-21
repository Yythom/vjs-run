#!/usr/bin/env node
// 给 AI / 命令行安全地增删改 mock 规则的入口，避免手改运行时 mock-rules.json 破坏文件。
//
// 规则文件定位优先级：
//   1. --file / MOCK_RULES_FILE 环境变量（显式指定）
//   2. <userData>/mock-assets/mock-rules.json（运行时文件，与 ensureUserMockAssets 一致）
//   userData = VJTOOLS_USER_DATA_DIR || ~/Library/Application Support/vjtools（macOS-only 应用）
//   注意：不读 config.json 的 mockRulesFile——normalize.js 会忽略用户改动，该字段
//   永远等于 userData 路径；读它反而会在 e2e 隔离（拷贝过 config.json）时指回真实文件。
//
// mock server 的 chokidar watcher 会在写盘后自动热载，无需重启。
//
// 场景（scene）：软件里「命名的规则文件快照」，存放在 mock-rules.json 同目录的
//   scenes/<场景名>.json，结构与 mock-rules.json 完全一致（规则数组）。带 --scene <名>
//   时所有命令改为操作该场景文件，不碰活动规则；软件里「应用」该场景后才覆盖活动规则生效。
//
// 用法：
//   node scripts/mock-rule.mjs list
//   node scripts/mock-rule.mjs get --method GET --path /api/user/profile
//   echo '{"rc":0,"data":{...}}' | node scripts/mock-rule.mjs set --method GET --path /api/user/profile [--status 200] [--delay 500] [--disabled]
//   node scripts/mock-rule.mjs enable  --method GET --path /api/user/profile
//   node scripts/mock-rule.mjs disable --method GET --path /api/user/profile
//   node scripts/mock-rule.mjs rm      --method GET --path /api/user/profile
//   echo '{...}' | node scripts/mock-rule.mjs set-variant --method GET --path /api/orders \
//     --name 分页第2页 --when-query page=2 [--when-header x-role=admin] [--when-body a.b=1] \
//     [--status 200] [--delay 300] [--disabled]   # 同路径按条件返回不同响应（变体）
//   node scripts/mock-rule.mjs rm-variant --method GET --path /api/orders --name 分页第2页
//   node scripts/mock-rule.mjs scenes                          # 列出所有场景
//   node scripts/mock-rule.mjs new-scene --scene 登录联调       # 新建空场景（同名报错）
//   node scripts/mock-rule.mjs rm-scene  --scene 登录联调       # 删除整个场景文件
//   node scripts/mock-rule.mjs rename-scene --scene 登录联调 --to 登录联调v2   # 重命名场景
//   echo '{...}' | node scripts/mock-rule.mjs set --scene 登录联调 --path /api/login  # 往场景里加接口
//   node scripts/mock-rule.mjs list --scene 登录联调            # 查看场景内容
//
// set 按 method+path 幂等定位：命中则覆盖，未命中则追加，绝不动其它规则。
// set-variant 按 (规则, --name) 幂等定位；变体必须挂在已有规则上，规则顶层
// response 是「无变体命中」时的兜底。变体按数组顺序 first-match，V1 调序 =
// 手改 JSON 或 rm-variant 后重加。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ─── 路径解析 ────────────────────────────────────────────────────────────────

function defaultUserData() {
  return path.join(os.homedir(), "Library", "Application Support", "vjtools");
}

function resolveRulesFile(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.MOCK_RULES_FILE) return path.resolve(process.env.MOCK_RULES_FILE);

  const userData = process.env.VJTOOLS_USER_DATA_DIR || defaultUserData();
  return path.join(userData, "mock-assets", "mock-rules.json");
}

// 场景目录：与活动 mock-rules.json 同目录下的 scenes/（等价 ipc.js 的 getScenesDir）
function scenesDir() {
  return path.join(path.dirname(resolveRulesFile(flags.file)), "scenes");
}

// mock server 的访问地址，从 config.json 读 mockHost/mockPort。
// 走与规则文件相同的 userData 解析（含 VJTOOLS_USER_DATA_DIR），
// 否则隔离环境下会读到真实配置、和规则文件指向两个地方。
// 配置缺失/损坏时回退 defaults.js 的默认值，让自检命令始终能给出一个地址。
function resolveBaseUrl() {
  const userData = process.env.VJTOOLS_USER_DATA_DIR || defaultUserData();
  const configFile = path.join(userData, "config.json");
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  } catch {
    // 未启动过 app / 文件损坏：用默认值
  }
  const host = config.mockHost || "127.0.0.1";
  const port = Number(config.mockPort) || 3002;
  return { url: `http://${host}:${port}`, configFile, fromConfig: Boolean(config.mockHost) };
}

// 场景名清洗，等价 recorder.js 的 sanitizeSceneName：去非法字符、trim、非空、≤60。
function sanitizeSceneName(rawName) {
  if (rawName === true || rawName === undefined) fail("--scene 需要一个场景名");
  const name = String(rawName).replace(/[/\\:*?"<>|]/g, "").trim();
  if (!name) fail("场景名不能为空（或仅含非法字符）");
  if (name.length > 60) fail("场景名过长（最多 60 字符）");
  return name;
}

function sceneFilePath(name) {
  return path.join(scenesDir(), `${sanitizeSceneName(name)}.json`);
}

// 本次命令实际操作的目标文件：带 --scene 时指向场景文件，否则活动规则文件。
function resolveTargetFile() {
  return flags.scene !== undefined
    ? sceneFilePath(flags.scene)
    : resolveRulesFile(flags.file);
}

// ─── 读写 ────────────────────────────────────────────────────────────────────

function loadRules(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8").trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    fail(`规则文件不是合法 JSON：${file}\n  ${err.message}`);
  }
  if (!Array.isArray(parsed)) fail(`规则文件顶层必须是数组：${file}`);
  return parsed;
}

function saveRules(file, rules) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(rules, null, 2)}\n`);
  fs.renameSync(tmp, file); // 原子替换，避免 watcher 读到半个文件
}

// ─── 校验 / 规整（等价 service.js 的 normalizeRulesForSave）─────────────────────

function normalizeRule(rule) {
  const method = String(rule.method || "*").toUpperCase();
  const rulePath = typeof rule.path === "string" ? rule.path.trim() : "";
  if (!rulePath) fail("规则缺少 path");
  if (!rulePath.startsWith("/")) fail(`path 必须以 / 开头：${rulePath}`);

  const out = { enabled: rule.enabled !== false, method, path: rulePath };

  if (rule.status !== undefined && rule.status !== "") {
    if (typeof rule.status === "boolean") fail("--status 需要一个整数值，如 --status 200");
    const status = Number(rule.status);
    if (!Number.isInteger(status)) fail(`status 必须是整数：${rule.status}`);
    out.status = status;
  }
  if (rule.delay !== undefined && rule.delay !== "") {
    if (typeof rule.delay === "boolean") fail("--delay 需要一个毫秒数，如 --delay 500");
    const delay = Number(rule.delay);
    if (!Number.isInteger(delay) || delay < 0) fail(`delay 必须是大于等于 0 的整数：${rule.delay}`);
    out.delay = delay;
  }
  if (rule.response !== undefined) out.response = rule.response;
  // variants 由 set-variant 流程校验后写入，这里只透传保留（set 不丢已有变体）
  if (Array.isArray(rule.variants) && rule.variants.length) out.variants = rule.variants;
  return out;
}

// ─── 变体（variants）────────────────────────────────────────────────────────
// 语义与 src/mock/variant-match.js 对齐（CLI 自包含，不 import src，以保证
// skill 目录副本可独立运行）：等值匹配，query/header 值存字符串，header key
// 小写，body key 为点路径、值尝试 JSON.parse（失败按字符串）。

const VARIANT_NAME_MAX = 60;

function requireVariantName() {
  const name = typeof flags.name === "string" ? flags.name.trim() : "";
  if (!name) fail("缺少 --name（变体名，规则内唯一）");
  if (name.length > VARIANT_NAME_MAX) fail(`变体名过长（最多 ${VARIANT_NAME_MAX} 字符）`);
  return name;
}

function findVariantIndex(rule, name) {
  if (!Array.isArray(rule.variants)) return -1;
  return rule.variants.findIndex(
    (v) => v && typeof v.name === "string" && v.name.trim() === name,
  );
}

// --when-query/--when-header/--when-body（可重复）→ when 对象；一个都没给返回 undefined
function collectWhenFlags() {
  const scopes = [
    ["when-query", "query"],
    ["when-header", "headers"],
    ["when-body", "body"],
  ];
  const when = {};
  let total = 0;
  for (const [flag, scope] of scopes) {
    if (flags[flag] === undefined) continue;
    const entries = Array.isArray(flags[flag]) ? flags[flag] : [flags[flag]];
    for (const entry of entries) {
      if (entry === true) fail(`--${flag} 需要 key=value 形式，如 --${flag} page=2`);
      const text = String(entry);
      const eq = text.indexOf("=");
      if (eq <= 0) fail(`--${flag} 需要 key=value 形式：${text}`);
      const key = scope === "headers" ? text.slice(0, eq).toLowerCase() : text.slice(0, eq);
      let value = text.slice(eq + 1);
      if (scope === "body") {
        try {
          value = JSON.parse(value); // 2→数字、true→布尔、{"a":1}→对象；失败按字符串
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

// ─── 参数解析 ────────────────────────────────────────────────────────────────

// 可重复的 flag（每次出现都累积成数组），用于变体的 when 条件
const REPEATABLE_FLAGS = new Set(["when-query", "when-header", "when-body"]);

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    let value;
    if (next === undefined || next.startsWith("--")) {
      value = true; // 布尔开关：--disabled / --enabled
    } else {
      value = next;
      i++;
    }
    if (REPEATABLE_FLAGS.has(key)) {
      (flags[key] ||= []).push(value);
    } else {
      flags[key] = value;
    }
  }
  return flags;
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

function sameRule(rule, method, rulePath) {
  return (
    String(rule.method || "*").toUpperCase() === method &&
    rule.path === rulePath
  );
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// ─── 命令 ────────────────────────────────────────────────────────────────────

const [, , command, ...rest] = process.argv;
const flags = parseFlags(rest);
const isScene = flags.scene !== undefined;
const file = resolveTargetFile();
// 目标提示：场景文件需在软件里「应用」才生效，活动规则则 watcher 自动热载。
const applyHint = isScene
  ? "（场景文件，需在软件里「应用」该场景后才生效）"
  : "（mock server 将自动热载）";

function requireTarget() {
  const method = String(flags.method || "*").toUpperCase();
  const rulePath = flags.path && String(flags.path).trim();
  if (!rulePath) fail("缺少 --path");
  return { method, rulePath };
}

switch (command) {
  case "list": {
    const rules = loadRules(file);
    console.log(`# ${file}`);
    if (!rules.length) {
      console.log("(空)");
      break;
    }
    for (const r of rules) {
      const flag = r.enabled === false ? "○" : "●";
      const status = r.status ? ` [${r.status}]` : "";
      const delay = r.delay ? ` +${r.delay}ms` : "";
      console.log(
        `${flag} ${String(r.method || "*").toUpperCase().padEnd(6)} ${r.path}${status}${delay}`,
      );
      if (Array.isArray(r.variants) && r.variants.length) {
        const summary = r.variants
          .map((v) => `${v.enabled === false ? "○" : "●"}${v.name}`)
          .join(" ");
        console.log(`    ▸ 变体×${r.variants.length}：${summary}`);
      }
    }
    break;
  }

  case "scenes": {
    const dir = scenesDir();
    const names = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
      : [];
    if (!names.length) {
      console.log(`(无场景) ${dir}`);
      break;
    }
    console.log(`# ${dir}`);
    for (const f of names) {
      let count = 0;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        count = Array.isArray(parsed) ? parsed.length : 0;
      } catch {
        // 损坏的场景文件按 0 条展示
      }
      console.log(`  ${f.replace(/\.json$/, "").padEnd(24)} ${count} 条`);
    }
    break;
  }

  case "new-scene": {
    const name = sanitizeSceneName(flags.scene);
    const target = sceneFilePath(name);
    if (fs.existsSync(target)) {
      fail(
        `场景已存在：${name}\n  换个名字，或直接用 set --scene ${name} --path <P> 往里加接口`,
      );
    }
    saveRules(target, []);
    console.log(`✔ 已创建空场景：${name}`);
    console.log(`  → ${target}`);
    console.log(`  用 set --scene ${name} --path <P> 往里加接口；完成后在软件里「应用」该场景`);
    break;
  }

  case "rename-scene": {
    // 语义对齐 recorder.js 的 renameScene；「录制中禁止改名」是 app 进程内状态，CLI 无法检查
    const from = sanitizeSceneName(flags.scene);
    if (flags.to === true || flags.to === undefined) fail("--to 需要一个新场景名");
    const to = sanitizeSceneName(flags.to);
    const fromFile = sceneFilePath(from);
    if (!fs.existsSync(fromFile)) fail(`场景不存在：${from}`);
    if (to === from) {
      console.log(`✔ 新旧名字相同，无需重命名：${from}`);
      break;
    }
    const toFile = sceneFilePath(to);
    if (fs.existsSync(toFile)) fail(`场景已存在：${to}`);
    fs.renameSync(fromFile, toFile);
    console.log(`✔ 已重命名：${from} → ${to}`);
    console.log(`  → ${toFile}`);
    break;
  }

  case "rm-scene": {
    const name = sanitizeSceneName(flags.scene);
    const target = sceneFilePath(name);
    if (!fs.existsSync(target)) fail(`场景不存在：${name}`);
    // 只删场景文件本身，不影响活动 mock-rules.json（即使该场景曾被「应用」过）
    fs.unlinkSync(target);
    console.log(`✔ 已删除场景：${name}`);
    console.log(`  → ${target}`);
    break;
  }

  case "get": {
    const { method, rulePath } = requireTarget();
    const rule = loadRules(file).find((r) => sameRule(r, method, rulePath));
    if (!rule) fail(`未找到规则：${method} ${rulePath}`);
    console.log(JSON.stringify(rule, null, 2));
    break;
  }

  case "set": {
    const { method, rulePath } = requireTarget();
    let response;
    const stdin = readStdin();
    if (stdin !== null) {
      try {
        response = JSON.parse(stdin);
      } catch (err) {
        fail(`stdin 不是合法 JSON：${err.message}`);
      }
    }

    const rules = loadRules(file);
    const idx = rules.findIndex((r) => sameRule(r, method, rulePath));
    const existing = idx >= 0 ? rules[idx] : {};

    const next = normalizeRule({
      method,
      path: rulePath,
      // variants：set 只动规则顶层字段，已有变体原样保留（增删改走 set-variant）
      variants: existing.variants,
      // response：本次传了用本次；没传保留原有
      response: response !== undefined ? response : existing.response,
      // status：--status 优先；否则保留原有
      status: flags.status !== undefined ? flags.status : existing.status,
      // delay：--delay 优先；否则保留原有（响应延迟，毫秒）
      delay: flags.delay !== undefined ? flags.delay : existing.delay,
      // enabled：--disabled/--enabled 显式覆盖；否则保留原有（新建默认启用）
      enabled: flags.disabled
        ? false
        : flags.enabled
          ? true
          : existing.enabled !== false,
    });

    if (idx >= 0) {
      rules[idx] = next;
      saveRules(file, rules);
      console.log(`✔ 已更新：${method} ${rulePath}`);
    } else {
      rules.push(next);
      saveRules(file, rules);
      console.log(`✔ 已新增：${method} ${rulePath}`);
    }
    console.log(`  → ${file}${applyHint}`);
    break;
  }

  case "set-variant": {
    const { method, rulePath } = requireTarget();
    const name = requireVariantName();

    const rules = loadRules(file);
    const rule = rules.find((r) => sameRule(r, method, rulePath));
    if (!rule) {
      fail(
        `未找到规则：${method} ${rulePath}\n  变体必须挂在已有规则上（规则顶层 response 兜底）：先用 set 创建`,
      );
    }

    let response;
    const stdin = readStdin();
    if (stdin !== null) {
      try {
        response = JSON.parse(stdin);
      } catch (err) {
        fail(`stdin 不是合法 JSON：${err.message}`);
      }
    }

    const when = collectWhenFlags();
    const variants = Array.isArray(rule.variants) ? [...rule.variants] : [];
    const idx = findVariantIndex(rule, name);
    const existing = idx >= 0 ? variants[idx] : undefined;

    if (!existing && response === undefined) fail("新建变体必须从 stdin 提供 response JSON");
    if (!existing && !when) {
      fail("新建变体至少要一个条件：--when-query/--when-header/--when-body key=value");
    }

    const next = {
      name,
      // enabled：--disabled/--enabled 显式覆盖；否则保留原有（新建默认启用）
      enabled: flags.disabled ? false : flags.enabled ? true : !existing || existing.enabled !== false,
      // when：给了任意 --when-* 就整体替换（不做逐 key 合并）；没给保留原有
      when: when !== undefined ? when : existing.when,
      // response：stdin 传了用本次；没传保留原有
      response: response !== undefined ? response : existing.response,
    };

    const statusInput = flags.status !== undefined ? flags.status : existing?.status;
    if (statusInput !== undefined && statusInput !== "") {
      if (typeof statusInput === "boolean") fail("--status 需要一个整数值，如 --status 200");
      const status = Number(statusInput);
      if (!Number.isInteger(status)) fail(`status 必须是整数：${statusInput}`);
      next.status = status;
    }
    const delayInput = flags.delay !== undefined ? flags.delay : existing?.delay;
    if (delayInput !== undefined && delayInput !== "") {
      if (typeof delayInput === "boolean") fail("--delay 需要一个毫秒数，如 --delay 500");
      const delayMs = Number(delayInput);
      if (!Number.isInteger(delayMs) || delayMs < 0) {
        fail(`delay 必须是大于等于 0 的整数：${delayInput}`);
      }
      next.delay = delayMs;
    }

    if (idx >= 0) {
      variants[idx] = next;
    } else {
      variants.push(next); // 追加到末尾：顺序即匹配序（first-match）
    }
    rule.variants = variants;
    saveRules(file, rules);
    console.log(`✔ 已${idx >= 0 ? "更新" : "新增"}变体：${name}（${method} ${rulePath}）`);
    console.log(`  → ${file}${applyHint}`);
    break;
  }

  case "rm-variant": {
    const { method, rulePath } = requireTarget();
    const name = requireVariantName();
    const rules = loadRules(file);
    const rule = rules.find((r) => sameRule(r, method, rulePath));
    if (!rule) fail(`未找到规则：${method} ${rulePath}`);
    const idx = findVariantIndex(rule, name);
    if (idx < 0) fail(`未找到变体：${name}（${method} ${rulePath}）`);
    rule.variants.splice(idx, 1);
    if (!rule.variants.length) delete rule.variants; // 空数组不落盘，保持文件干净
    saveRules(file, rules);
    console.log(`✔ 已删除变体：${name}（${method} ${rulePath}）`);
    console.log(`  → ${file}${applyHint}`);
    break;
  }

  case "enable":
  case "disable": {
    const { method, rulePath } = requireTarget();
    const rules = loadRules(file);
    const rule = rules.find((r) => sameRule(r, method, rulePath));
    if (!rule) fail(`未找到规则：${method} ${rulePath}`);
    rule.enabled = command === "enable";
    saveRules(file, rules);
    console.log(
      `✔ 已${command === "enable" ? "启用" : "禁用"}：${method} ${rulePath}`,
    );
    break;
  }

  case "rm": {
    const { method, rulePath } = requireTarget();
    const rules = loadRules(file);
    const idx = rules.findIndex((r) => sameRule(r, method, rulePath));
    if (idx < 0) fail(`未找到规则：${method} ${rulePath}`);
    rules.splice(idx, 1);
    saveRules(file, rules);
    console.log(`✔ 已删除：${method} ${rulePath}`);
    break;
  }

  // 自检用：打印 mock server 地址，供后续 curl $BASE/__mock/... 使用。
  // --quiet 只输出地址本身，便于 BASE=$(... base --quiet) 直接取值。
  case "base": {
    const { url, configFile, fromConfig } = resolveBaseUrl();
    if (flags.quiet) {
      console.log(url);
      break;
    }
    console.log(url);
    console.log(`  来源：${fromConfig ? configFile : `${configFile}（读不到，用默认值）`}`);
    console.log(`  自检：curl -fsS ${url}/__mock/health`);
    break;
  }

  default:
    console.log(
      [
        "mock-rule — 安全增删改运行时 mock 规则 / 场景",
        "",
        "  list    [--scene <名>]              列出规则（带 --scene 列场景内规则）",
        "  get     --path <p> [--method <m>] [--scene <名>]   查看单条规则",
        "  set     --path <p> [--method GET] [--status 200] [--delay 500] [--disabled] [--scene <名>]  < response.json",
        "                                      新增/覆盖规则；response 从 stdin 读 JSON",
        "  enable  --path <p> [--method <m>] [--scene <名>]   启用规则",
        "  disable --path <p> [--method <m>] [--scene <名>]   禁用规则",
        "  rm      --path <p> [--method <m>] [--scene <名>]   删除规则",
        "",
        "  set-variant --path <p> --name <名> --when-query k=v [--when-header k=v] [--when-body a.b=v]",
        "              [--method <m>] [--status 200] [--delay 300] [--disabled] [--scene <名>]  < response.json",
        "                                      同路径按条件返回不同响应；条件全部相等才命中（AND），",
        "                                      变体按顺序 first-match，都不命中时回退规则顶层 response",
        "  rm-variant  --path <p> --name <名> [--method <m>] [--scene <名>]   删除单个变体",
        "",
        "  scenes                              列出所有场景",
        "  new-scene --scene <名>              新建空场景（同名报错）",
        "  rm-scene  --scene <名>              删除整个场景文件（不影响活动规则）",
        "  rename-scene --scene <旧名> --to <新名>   重命名场景（同名冲突报错）",
        "",
        "  base [--quiet]                      打印 mock server 地址（自检用）",
        "",
        "  --scene <名> 时所有命令改为操作 scenes/<名>.json（不碰活动规则）",
        "  --method 缺省为 *（匹配所有方法）；--file 可覆盖活动规则文件路径",
        `  当前活动规则文件：${resolveRulesFile(flags.file)}`,
        `  场景目录：${scenesDir()}`,
      ].join("\n"),
    );
    if (command && command !== "help" && command !== "--help") process.exit(1);
}
