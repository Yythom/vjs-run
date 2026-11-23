// 读用户可手改的 JSON 文件前的文本处理。
//
// Windows 上 PowerShell 5.1 的 `Set-Content -Encoding UTF8`、`echo ... > file.json` 会写出
// 带 UTF-8 BOM 的文件，而 JSON.parse 不认 BOM（`Unexpected token '﻿'`）。spec / config /
// 场景这些文件经常是用户用 PowerShell 生成的，解析前统一剥掉 BOM，免得「文件明明是对的、就是起不来」。

export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
