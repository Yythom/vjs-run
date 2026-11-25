// T3 里能选的 provider 和模型，给界面的下拉用。`t3` 命令行没有列模型的子命令，只能只读 T3 自己的两份文件：
//   - <T3 数据目录>/userdata/settings.json   providerInstances：实例 id、driver、是否启用、自定义模型（customModels）
//   - <T3 数据目录>/userdata/model-manifest.json   各 driver 内置的模型清单
// 都是 T3 内部格式，升级后可能变；读不到或解析不了，界面退回手填，不影响发起。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 实测过会自动加载 ~/.claude/skills 的 driver（magpie 就是这一类），commit-range-test 能被认出来照做
const LOADS_CLAUDE_SKILLS = new Set(["claudeAgent"]);

export function t3UserDataDir() {
  // 和 `t3 --base-dir` / T3CODE_HOME 一致：数据目录下的 userdata
  const home = process.env.T3CODE_HOME || path.join(os.homedir(), ".t3");
  return path.join(home, "userdata");
}

/**
 * settings + manifest → [{ id, driver, name, enabled, loadsClaudeSkills, models: [{ slug, name }] }]
 * 配了自定义模型的实例（如 magpie 这种网关）只列它自己的模型：网关只转发自己那份清单，内置模型未必能用；
 * 没配的列 driver 内置的当前模型（status=current），过时的不列。没启用的实例排在最后，界面置灰
 */
export function parseT3Models(settings, manifest) {
  const builtin = manifest?.manifest?.providers || manifest?.providers || {};
  const out = [];
  for (const [id, inst] of Object.entries(settings?.providerInstances || {})) {
    if (!inst || typeof inst !== "object") continue;
    const custom = (inst.config?.customModels || [])
      .filter((m) => m?.slug)
      .map((m) => ({ slug: String(m.slug), name: String(m.name || m.slug) }));
    const models = custom.length
      ? custom
      : (builtin[inst.driver]?.models || [])
          .filter((m) => m?.slug && (m.status || "current") === "current")
          .map((m) => ({ slug: String(m.slug), name: String(m.name || m.slug) }));
    out.push({
      id,
      driver: String(inst.driver || ""),
      name: String(inst.displayName || id),
      enabled: inst.enabled !== false,
      loadsClaudeSkills: LOADS_CLAUDE_SKILLS.has(inst.driver),
      models,
    });
  }
  return out.sort((a, b) => Number(b.enabled) - Number(a.enabled));
}

export function readT3Models() {
  const dir = t3UserDataDir();
  const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
  let settings;
  try {
    settings = read("settings.json");
  } catch (err) {
    return { providers: [], error: `读不了 T3 的设置（${path.join(dir, "settings.json")}）：${err.message}` };
  }
  let manifest = null;
  try {
    manifest = read("model-manifest.json");
  } catch {
    // 没有内置清单也行：只是没配自定义模型的实例列不出模型，界面让手填
  }
  return { providers: parseT3Models(settings, manifest), error: "" };
}
