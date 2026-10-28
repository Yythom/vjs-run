// 组装 vjtools-cli 的 npm 包（prepack 自动执行）。
//
// 不打包、不改写代码：从入口顺着相对 import 把 CLI 用到的源码按仓库原目录结构复制到 dist/，
// 这样 paths.js 里基于 import.meta.url 推导的内置资源路径、generate-spec 的按需加载都照常工作，
// 仓库里 `node src/cli/index.js` 和装好的 `vjtools` 跑的是同一份代码。
//
// 顺带两道闸，防止 app 侧改动悄悄把 CLI 搞坏：
//   1. 依赖图里出现 electron → 失败（CLI 不能依赖 Electron）
//   2. 第三方依赖没在本包 dependencies 里声明，或版本与 app 的 package.json 不一致 → 失败

import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(PKG_DIR, "..", "..");
const DIST = path.join(PKG_DIR, "dist");

const ENTRIES = ["src/cli/index.js"];
// 运行时按路径读取、不会出现在 import 里的资源
const EXTRA_DIRS = ["src/mock/assets"];

const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, "package.json"), "utf8"));
const appPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));

// 静态 import / export from / 副作用 import / 字面量动态 import
const IMPORT_RE =
  /(?:^|[\s;])(?:import|export)\s[^'"`;]*?\sfrom\s*["']([^"']+)["']|(?:^|[\s;])import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gm;

function stripComments(code) {
  // 只去掉整行注释：注释里举例的 import 语句不该被当成依赖
  return code
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function isBuiltin(specifier) {
  return specifier.startsWith("node:") || builtinModules.includes(packageName(specifier));
}

const errors = [];
const files = new Set();
const bareDeps = new Map(); // name -> 第一次引用它的文件

function visit(relFile) {
  if (files.has(relFile)) return;
  const absFile = path.join(REPO_ROOT, relFile);
  if (!fs.existsSync(absFile)) {
    errors.push(`找不到文件：${relFile}`);
    return;
  }
  files.add(relFile);

  const code = stripComments(fs.readFileSync(absFile, "utf8"));
  for (const match of code.matchAll(IMPORT_RE)) {
    const specifier = match[1] || match[2] || match[3];
    if (specifier.startsWith(".")) {
      visit(path.relative(REPO_ROOT, path.resolve(path.dirname(absFile), specifier)));
    } else if (!isBuiltin(specifier)) {
      const name = packageName(specifier);
      if (!bareDeps.has(name)) bareDeps.set(name, relFile);
    }
  }
}

ENTRIES.forEach(visit);

for (const [name, from] of bareDeps) {
  if (name === "electron") {
    errors.push(`${from} 引入了 electron：CLI 的依赖图里不能有 Electron`);
    continue;
  }
  const declared = pkg.dependencies?.[name];
  if (!declared) {
    errors.push(`${from} 用到了 ${name}，但 packages/cli/package.json 的 dependencies 里没有声明`);
  } else if (appPkg.dependencies?.[name] && appPkg.dependencies[name] !== declared) {
    errors.push(`${name} 版本与 app 不一致：cli ${declared}，app ${appPkg.dependencies[name]}`);
  }
}
for (const name of Object.keys(pkg.dependencies || {})) {
  if (!bareDeps.has(name)) errors.push(`dependencies 里的 ${name} 没有被用到，删掉免得用户白装`);
}

if (errors.length) {
  console.error(`✗ vjtools-cli 构建失败：\n  ${errors.join("\n  ")}`);
  process.exit(1);
}

fs.rmSync(DIST, { recursive: true, force: true });
for (const relFile of files) {
  const target = path.join(DIST, relFile);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, relFile), target);
}
for (const relDir of EXTRA_DIRS) {
  fs.cpSync(path.join(REPO_ROOT, relDir), path.join(DIST, relDir), { recursive: true });
}
fs.chmodSync(path.join(DIST, "src", "cli", "index.js"), 0o755);

console.log(
  `✔ vjtools-cli ${pkg.version}：${files.size} 个源文件 → ${path.relative(REPO_ROOT, DIST)}/` +
    `（依赖：${[...bareDeps.keys()].sort().join(", ")}）`,
);
