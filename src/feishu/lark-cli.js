// lark-cli 调用封装。
//
// 飞书两头的能力（收事件 / 发消息 / 查人）全部复用本地已安装的 @larksuite/cli：
// 主进程只负责 spawn 它，不引飞书 SDK、不自己维护 WebSocket 长连接、不碰 app_secret
// ——凭证和事件总线 daemon 都归 lark-cli 自己管。
//
// 所有调用一律 argv 数组 + shell:false：消息正文里可能带引号/反引号/换行，
// 走 shell 拼串会被注入。

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildSpawnEnv } from "../shell-env.js";
import { killProcessTree } from "../kill-tree.js";

// SIGTERM 之后等这么久还没退，就对进程组补 SIGKILL
const KILL_GRACE_MS = 3000;

const BIN = "lark-cli";

/**
 * 一次性执行一个命令，收全 stdout 后返回。解析不出 JSON 时 json 为 null，
 * 原文仍在 stdout。argv 数组 + shell:false，参数里带引号也不会被注入。
 */
export function runCommand(bin, args, { timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    let proc;
    try {
      // detached 让它自成进程组：超时强杀时才能整组端掉，
      // 不然被杀的只是直接子进程，它拉起来的东西会留在后台
      proc = spawn(bin, args, {
        env: buildSpawnEnv(),
        shell: false,
        detached: true,
      });
    } catch (err) {
      resolve({ ok: false, error: err.message, stdout: "", stderr: "" });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      killProcessTree(proc, "SIGTERM");
      // 卡死的命令未必理会 SIGTERM，限时补刀，不然这个进程组就留在后台了
      const forceKill = setTimeout(
        () => killProcessTree(proc, "SIGKILL"),
        KILL_GRACE_MS,
      );
      forceKill.unref?.();
      proc.once("exit", () => clearTimeout(forceKill));
      finish({ ok: false, error: `${bin} 超时（${timeout}ms）`, stdout, stderr });
    }, timeout);

    proc.stdout.on("data", (c) => (stdout += c.toString()));
    proc.stderr.on("data", (c) => (stderr += c.toString()));
    proc.on("error", (err) =>
      finish({
        ok: false,
        // ENOENT 基本都是 GUI 进程的 PATH 里没有这个命令。用标志位而不是让
        // 调用方去匹配错误文案——文案一改判断就悄悄失效了。
        notFound: err.code === "ENOENT",
        error: err.code === "ENOENT" ? `找不到 ${bin}` : err.message,
        stdout,
        stderr,
      }),
    );
    proc.on("close", (code) => {
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch (_) {
        // 非 JSON 输出（--help、表格格式等）不算错误，交给调用方看 stdout
      }
      finish({
        ok: code === 0,
        code,
        json,
        stdout,
        stderr,
        error: code === 0 ? null : stderr.trim() || `${bin} 退出码 ${code}`,
      });
    });
  });
}

/** lark-cli 专用的薄封装，省得每处都写 BIN */
export function runLark(args, options) {
  return runCommand(BIN, args, options);
}

/**
 * 长驻调用（event consume）。调用方自己接 stdout 并负责 kill。
 *
 * detached 让它自成进程组，停止时才能用 killProcessTree 把 lark-cli 连同它自己
 * 起的子进程一起收掉，不然会留下常驻孤儿继续占着事件订阅。
 */
export function spawnLark(args) {
  return spawn(BIN, args, { env: buildSpawnEnv(), shell: false, detached: true });
}

export const CLI_PACKAGES = {
  "lark-cli": {
    name: "lark-cli",
    pkg: "@larksuite/cli",
    installCmd: "npm install -g @larksuite/cli",
    desc: "飞书命令行工具，用于监听消息、发送通知及反问卡片",
  },
  claude: {
    name: "claude",
    pkg: "@anthropic-ai/claude-code",
    installCmd: "npm install -g @anthropic-ai/claude-code",
    desc: "Claude Code CLI，用于自动处理需求、排查代码及回写结论",
  },
  codex: {
    name: "codex",
    pkg: "@openai/codex",
    installCmd: "npm install -g @openai/codex",
    desc: "Codex CLI，用于自动处理需求、排查代码及回写结论",
  },
};

/** lark-cli 是否可用 + 事件总线状态，供面板显示「未安装 / 未登录」。 */
export async function probeLarkCli() {
  const version = await runLark(["--version"], { timeout: 8000 });
  const pkgInfo = CLI_PACKAGES["lark-cli"];
  if (version.notFound) {
    return {
      installed: false,
      error: "找不到 lark-cli，请确认已全局安装 @larksuite/cli",
      installCmd: pkgInfo.installCmd,
      pkgName: pkgInfo.pkg,
    };
  }
  const status = await runLark(["event", "status"], { timeout: 15000 });
  return {
    installed: true,
    version: (version.stdout || "").trim(),
    // `event status` 输出形如 "── cli_xxx ──\n  Bus: running"
    busRunning: /Bus:\s*running/i.test(status.stdout),
    appId: (status.stdout.match(/cli_[a-z0-9]+/i) || [])[0] || "",
    statusText: (status.stdout || status.stderr || "").trim(),
    installCmd: pkgInfo.installCmd,
    pkgName: pkgInfo.pkg,
  };
}

/** claude 是否可用，供面板显示「未安装 / 已安装」。 */
export async function probeClaudeCli() {
  const version = await runCommand("claude", ["--version"], { timeout: 8000 });
  const pkgInfo = CLI_PACKAGES.claude;
  if (version.notFound) {
    return {
      installed: false,
      error: "找不到 claude，请确认已全局安装 @anthropic-ai/claude-code",
      installCmd: pkgInfo.installCmd,
      pkgName: pkgInfo.pkg,
    };
  }
  return {
    installed: true,
    version: (version.stdout || "").trim(),
    installCmd: pkgInfo.installCmd,
    pkgName: pkgInfo.pkg,
  };
}

/** codex 是否可用，供面板显示「未安装 / 已安装」。 */
export async function probeCodexCli() {
  const version = await runCommand("codex", ["--version"], { timeout: 8000 });
  const pkgInfo = CLI_PACKAGES.codex;
  if (version.notFound) {
    return {
      installed: false,
      error: "找不到 codex，请确认已全局安装 @openai/codex",
      installCmd: pkgInfo.installCmd,
      pkgName: pkgInfo.pkg,
    };
  }
  return {
    installed: true,
    version: (version.stdout || "").trim(),
    installCmd: pkgInfo.installCmd,
    pkgName: pkgInfo.pkg,
  };
}

/** 一键安装 CLI 工具包（通过 npm install -g） */
export async function installCliPackage(target) {
  const meta =
    CLI_PACKAGES[target] ||
    Object.values(CLI_PACKAGES).find((p) => p.pkg === target) ||
    (typeof target === "string" && target.startsWith("@") ? { pkg: target } : null);

  if (!meta) {
    throw new Error(`不支持安装目标: ${target}`);
  }

  const res = await runCommand("npm", ["install", "-g", meta.pkg], {
    timeout: 180000,
  });
  if (!res.ok) {
    const errorDetails =
      res.error || res.stderr.trim() || res.stdout.trim() || "未知错误";
    throw new Error(`安装 ${meta.pkg} 失败: ${errorDetails}`);
  }

  let newProbe = null;
  if (target === "lark-cli" || meta.pkg === "@larksuite/cli") {
    newProbe = await probeLarkCli();
  } else if (target === "claude" || meta.pkg === "@anthropic-ai/claude-code") {
    newProbe = await probeClaudeCli();
  } else if (target === "codex" || meta.pkg === "@openai/codex") {
    newProbe = await probeCodexCli();
  }

  return {
    ok: true,
    pkg: meta.pkg,
    probe: newProbe,
    stdout: res.stdout,
  };
}

/** 按 open_id 查显示名，失败返回空串（补名字是锦上添花，不该阻断主流程）。 */
export async function fetchUserName(openId) {
  if (!openId) return "";
  const res = await runLark([
    "contact",
    "+get-user",
    "--user-id",
    openId,
    "--format",
    "json",
  ]);
  if (!res.ok || !res.json) return "";
  const u = res.json.user || res.json.data?.user || res.json;
  return String(u?.name || u?.nickname || "").trim();
}

// 我们自己发出去的 message_id。机器人的消息会随事件流回流，
// sender_type 万一没带（或 lark-cli 换了字段名），这份就是兜底的第二道闸——
// 完成通知是 --reply-in-thread 发回话题里的，漏判一次就会被当成对方的新指令，
// 于是「回通知 → 当成新指令 → 又跑一轮 → 又回通知」自己转起来
const MAX_SENT_IDS = 200;
const sentMessageIds = [];

export function isOwnMessage(messageId) {
  return Boolean(messageId) && sentMessageIds.includes(messageId);
}

function rememberSentMessage(res) {
  const id =
    res?.json?.message_id ||
    res?.json?.data?.message_id ||
    res?.json?.data?.message?.message_id;
  if (!id) return;
  sentMessageIds.push(id);
  if (sentMessageIds.length > MAX_SENT_IDS) {
    sentMessageIds.splice(0, sentMessageIds.length - MAX_SENT_IDS);
  }
}

/**
 * 发送消息：支持纯文本与 Interactive 交互卡片，支持优先使用 Thread 话题引用回复原消息。
 * 若指定了 replyMessageId，会优先调用 `+messages-reply --reply-in-thread`；
 * 若回复失败或未指定，平滑降级为往 chatId / openId 发送新消息。
 */
export async function sendMessage({
  chatId,
  openId,
  text,
  card,
  replyMessageId,
  replyInThread = true,
}) {
  const isCard = Boolean(card && typeof card === "object");
  const contentStr = isCard
    ? typeof card === "string"
      ? card
      : JSON.stringify(card)
    : "";

  // 1. 优先尝试 Thread 话题回复
  if (replyMessageId) {
    const replyArgs = [
      "im",
      "+messages-reply",
      "--message-id",
      replyMessageId,
      "--as",
      "bot",
      "--format",
      "json",
    ];
    if (replyInThread) replyArgs.push("--reply-in-thread");

    if (isCard) {
      replyArgs.push("--msg-type", "interactive", "--content", contentStr);
    } else {
      replyArgs.push("--text", String(text || ""));
    }

    const replyRes = await runLark(replyArgs);
    if (replyRes.ok) {
      rememberSentMessage(replyRes);
      return replyRes;
    }

    console.warn(
      `[docking] Thread 回复 #${replyMessageId} 失败 (${replyRes.error})，降级为普通发送`,
    );
  }

  // 2. 普通发送（降级或直接发送）
  const target = chatId
    ? ["--chat-id", chatId]
    : openId
      ? ["--user-id", openId]
      : null;
  if (!target) return { ok: false, error: "缺少 chat_id / open_id，无法发送" };

  const sendArgs = ["im", "+messages-send", ...target, "--as", "bot", "--format", "json"];
  if (isCard) {
    sendArgs.push("--msg-type", "interactive", "--content", contentStr);
  } else {
    sendArgs.push("--text", String(text || ""));
  }

  const sendRes = await runLark(sendArgs);
  rememberSentMessage(sendRes);
  return sendRes;
}

/**
 * 下载飞书消息里的图片或文件附件。
 * 成功后返回 { ok: true, path: "/path/to/downloaded/file" }
 */
export async function downloadMessageResource({
  messageId,
  fileKey,
  type = "image",
  outputDir,
  fileName,
}) {
  if (!messageId || !fileKey || !outputDir) {
    return { ok: false, error: "缺少必要参数 (messageId/fileKey/outputDir)" };
  }

  try {
    fs.mkdirSync(outputDir, { recursive: true });
  } catch (err) {
    return { ok: false, error: `创建附件目录失败: ${err.message}` };
  }

  const safeFileName = fileName
    ? fileName.replace(/[\\/:*?"<>|]/g, "_")
    : `${fileKey}.${type === "image" ? "png" : "bin"}`;
  const outputPath = path.join(outputDir, safeFileName);

  // 如果已经下载过且大小大于 0，直接复用
  try {
    const stat = fs.statSync(outputPath);
    if (stat.size > 0) {
      return { ok: true, path: outputPath, size: stat.size, reused: true };
    }
  } catch (_) {}

  const res = await runLark([
    "im",
    "+messages-resources-download",
    "--message-id",
    messageId,
    "--file-key",
    fileKey,
    "--type",
    type,
    "--output",
    outputPath,
    "--as",
    "bot",
    "--format",
    "json",
  ]);

  if (!res.ok) {
    return { ok: false, error: res.error || "下载附件失败" };
  }

  try {
    const stat = fs.statSync(outputPath);
    return { ok: true, path: outputPath, size: stat.size };
  } catch {
    return { ok: true, path: outputPath, size: 0 };
  }
}
