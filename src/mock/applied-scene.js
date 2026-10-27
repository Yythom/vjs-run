// 「当前应用的场景」标记：<mock-assets>/applied-scene.json = { name, appliedAt }。
//
// 软件和 scripts/mock-rule.mjs 的 apply-scene 应用场景时都会写这个标记，
// 「某场景是否正在使用」只看标记里的场景名。
// CLI 自包含，同样的逻辑在 mock-rule.mjs 里有一份，改这里要同步改那边。

import fs from "node:fs";
import path from "node:path";

export function appliedSceneFile(rulesFile) {
  return path.join(path.dirname(rulesFile), "applied-scene.json");
}

// 读标记里的场景名；没有标记 / 标记损坏返回空串
export function readAppliedScene(rulesFile) {
  try {
    const marker = JSON.parse(fs.readFileSync(appliedSceneFile(rulesFile), "utf8"));
    return typeof marker?.name === "string" ? marker.name : "";
  } catch {
    return "";
  }
}

export function recordAppliedScene(rulesFile, name) {
  const marker = { name, appliedAt: Date.now() };
  fs.writeFileSync(
    appliedSceneFile(rulesFile),
    `${JSON.stringify(marker, null, 2)}\n`,
    "utf-8",
  );
}

// 场景改名后让标记跟着改，否则改完名的场景会被误判为「未在使用」
export function renameAppliedScene(rulesFile, oldName, newName) {
  const file = appliedSceneFile(rulesFile);
  try {
    const marker = JSON.parse(fs.readFileSync(file, "utf8"));
    if (marker?.name !== oldName) return;
    fs.writeFileSync(file, `${JSON.stringify({ ...marker, name: newName }, null, 2)}\n`, "utf-8");
  } catch {
    // 没有标记 / 标记损坏：无事可做
  }
}
