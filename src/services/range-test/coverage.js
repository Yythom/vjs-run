// 调 commit-range-test 自带的 coverage.mjs 读清单：status --json 给逐条明细和进度，
// check --json 给三层覆盖率里的第一层。清单格式只在 skill 里有一处，这里不另写解析器。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

const SKILL_SCRIPT = path.join(os.homedir(), ".claude", "skills", "commit-range-test", "scripts", "coverage.mjs");

export function locateCoverageScript() {
  try {
    // skill 目录常是软链（实测指向 ~/.config/magpie/library/skills/…），取真实路径
    return fs.realpathSync(SKILL_SCRIPT);
  } catch {
    return null;
  }
}

// 用 Electron 自带的 Node 跑（ELECTRON_RUN_AS_NODE），不依赖使用者装了哪个版本的 node。
// coverage.mjs 只用 Node 内置模块；check 的「无行为」粗筛会从 cwd 找 typescript，所以 cwd 设成仓库
function runCoverage(args, { cwd }) {
  const script = locateCoverageScript();
  if (!script) {
    return Promise.reject(
      new Error("找不到 commit-range-test 的 coverage.mjs：确认 ~/.claude/skills/commit-range-test 已安装"),
    );
  }
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [script, ...args, "--json"],
      {
        cwd,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        timeout: 60_000,
        maxBuffer: 32 * 1024 * 1024,
      },
      // 有问题时退出码是 1，但 stdout 照样是完整 JSON，所以不看 err、只看能不能解析
      (err, stdout, stderr) => {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          const msg = (stderr || err?.message || stdout || "").trim().split("\n")[0];
          reject(new Error(`coverage.mjs 输出不是 JSON（skill 版本太旧，还没有 --json？）：${msg}`));
        }
      },
    );
  });
}

/**
 * 清单明细与进度。log 和对照表都在时一起带上：每格多出 evidence（证据判断 + log 里的段落），
 * 判断证据过期要在仓库里跑 git，所以 cwd 要是被测仓库
 */
export function readStatus({ checklistPath, logPath, mapPath, cwd }) {
  const args = ["status", "--checklist", checklistPath];
  if (logPath && mapPath) args.push("--log", logPath, "--map", mapPath);
  return runCoverage(args, { cwd });
}

/** skill 是否装好、是不是带 --json 的版本：skill 目录不在版本控制里，被同步覆盖时能马上发现 */
export function skillInfo() {
  const script = locateCoverageScript();
  if (!script) return Promise.resolve({ installed: false, hasJson: false, path: SKILL_SCRIPT });
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, "--help"],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 20_000 },
      (_err, stdout) => resolve({ installed: true, hasJson: /--json/.test(stdout || ""), path: script }),
    );
  });
}

export function readCheck({ mapPath, checklistPath, cwd }) {
  return runCoverage(["check", "--map", mapPath, "--checklist", checklistPath], { cwd });
}
