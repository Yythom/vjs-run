import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { getConfig } from '../config/store.js';
import {
  install as installOllama,
  managedBin,
  isInstalled,
} from './ollama-install.js';

const DEFAULT_BASE = 'http://127.0.0.1:11434';

function baseUrl() {
  return (getConfig().aiBaseUrl || DEFAULT_BASE).replace(/\/+$/, '');
}

export async function isServerUp() {
  try {
    const res = await fetch(`${baseUrl()}/api/tags`);
    return res.ok;
  } catch {
    return false;
  }
}

export function systemOllamaPresent() {
  const candidates =
    process.platform === 'win32'
      ? [process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Programs\\Ollama\\ollama.exe`]
      : ['/usr/local/bin/ollama', '/opt/homebrew/bin/ollama', '/usr/bin/ollama'];
  return candidates.some((c) => c && existsSync(c));
}

function resolveOllamaBin() {
  const candidates =
    process.platform === 'win32'
      ? [
          managedBin(),
          process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Programs\\Ollama\\ollama.exe`,
        ]
      : [managedBin(), '/usr/local/bin/ollama', '/opt/homebrew/bin/ollama', '/usr/bin/ollama'];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return process.platform === 'win32' ? 'ollama.exe' : 'ollama';
}

const START_TIMEOUT_MS = 20000;
const START_POLL_MS = 600;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let serveChild = null;

export async function startServer(onProgress) {
  if (await isServerUp()) return { ok: true, already: true };

  const isManaged = await isInstalled();
  const isSys = systemOllamaPresent();

  if (!isManaged && !isSys) {
    onProgress?.({ phase: 'install-start' });
    await installOllama(onProgress);
  }

  onProgress?.({ phase: 'starting' });

  try {
    const env = { ...process.env };
    const custom = (getConfig().ollamaModelsDir || '').trim();
    if (custom) {
      await mkdir(custom, { recursive: true });
      env.OLLAMA_MODELS = custom;
    }

    const binPath = resolveOllamaBin();
    const child = spawn(binPath, ['serve'], {
      detached: true,
      stdio: 'ignore',
      env,
    });

    child.on('error', (err) => {
      console.warn('[ollama serve] spawn error:', err?.message || err);
    });

    child.on('exit', () => {
      if (serveChild === child) serveChild = null;
    });

    child.unref();
    serveChild = child;
  } catch (e) {
    throw new Error(`无法启动 Ollama: ${e.message || e}`, { cause: e });
  }

  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    await sleep(START_POLL_MS);
    if (await isServerUp()) return { ok: true, already: false };
    if (Date.now() >= deadline) {
      throw new Error('已尝试启动 Ollama，但服务未在规定时间内就绪，请重试');
    }
  }
}

export function stopOwnServer() {
  if (!serveChild) return { ok: false };
  try {
    serveChild.kill();
  } catch {
    // 忽略
  }
  serveChild = null;
  return { ok: true };
}

export function killAllOllama() {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/F', '/T', '/IM', 'ollama.exe'], { stdio: 'ignore' });
    } else {
      spawnSync('pkill', ['-f', 'ollama serve'], { stdio: 'ignore' });
    }
  } catch {
    // 忽略
  }
}

export async function listModels() {
  let res;
  try {
    res = await fetch(`${baseUrl()}/api/tags`);
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const data = await res.json();
  return (data.models || []).map((m) => m.name);
}

let currentPull = null;

export function cancelPull() {
  if (currentPull) {
    currentPull.abort();
    currentPull = null;
    return { ok: true };
  }
  return { ok: false };
}

export async function pullModel(name, onProgress) {
  const model = name || getConfig().ollamaModel || 'nomic-embed-text';
  if (currentPull) currentPull.abort();

  const controller = new globalThis.AbortController();
  currentPull = controller;

  try {
    let res;
    try {
      res = await fetch(`${baseUrl()}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ name: model, stream: true }),
      });
    } catch (e) {
      if (e?.name === 'AbortError') throw new Error('已取消下载', { cause: e });
      throw new Error('连不上本地模型服务 (Ollama)，请确认已启动', { cause: e });
    }

    if (!res.ok) throw new Error(`拉取模型失败: Ollama 返回 HTTP ${res.status}`);

    const decoder = new globalThis.TextDecoder();
    let buf = '';
    const handleLine = (line) => {
      const s = line.trim();
      if (!s) return;
      let obj;
      try {
        obj = JSON.parse(s);
      } catch {
        return;
      }
      if (obj.error) throw new Error(obj.error);
      const total = obj.total || 0;
      const completed = obj.completed || 0;
      const percent = total > 0 ? Math.round((completed / total) * 100) : null;
      onProgress?.({ model, status: obj.status || '', completed, total, percent });
    };

    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    }
    if (buf.trim()) handleLine(buf);
    return { ok: true, model };
  } finally {
    if (currentPull === controller) currentPull = null;
  }
}


