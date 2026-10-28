// CLI 公共小工具：错误类型、版本号、时间格式。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 预期内的失败：只打印 message，不打堆栈；exitCode 见 index.js 的退出码约定 */
export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

// 向上找最近的 package.json：npm 安装时是 vjtools-cli 的包，仓库里直跑时是 app 的包
export function cliVersion() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const file = path.join(dir, "package.json");
    if (fs.existsSync(file)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
        return { name: pkg.name, version: pkg.version };
      } catch {
        break;
      }
    }
    dir = path.dirname(dir);
  }
  return { name: "vjtools-cli", version: "0.0.0" };
}

export function clockTime(ts = Date.now()) {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}
