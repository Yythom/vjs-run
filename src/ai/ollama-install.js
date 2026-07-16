import { app, net } from 'electron';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat, readdir, chmod, rename, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getConfig } from '../config/store.js';

export const DEFAULT_OLLAMA_VERSION = 'latest';

export function targetVersion() {
  return (getConfig().ollamaVersion || '').trim() || DEFAULT_OLLAMA_VERSION;
}

function assetName() {
  if (process.platform === 'win32') return 'ollama-windows-amd64.zip';
  if (process.platform === 'darwin') return 'ollama-darwin.tgz';
  throw new Error(`暂不支持自动安装 Ollama 的平台:${process.platform}`);
}

function assetUrl() {
  const version = targetVersion();
  return version === 'latest'
    ? `https://github.com/ollama/ollama/releases/latest/download/${assetName()}`
    : `https://github.com/ollama/ollama/releases/download/${version}/${assetName()}`;
}



export function ollamaDir() {
  return join(app.getPath('userData'), 'ollama');
}

export function managedBin() {
  return join(ollamaDir(), process.platform === 'win32' ? 'ollama.exe' : 'ollama');
}

export async function isInstalled() {
  try {
    await stat(managedBin());
    return true;
  } catch {
    return false;
  }
}

function versionFile() {
  return join(ollamaDir(), '.ollama-version');
}

async function installedVersion() {
  try {
    return (await readFile(versionFile(), 'utf8')).trim();
  } catch {
    return '';
  }
}


function defaultModelsDir() {
  return join(homedir(), '.ollama', 'models');
}

export function modelsDir() {
  const custom = (getConfig().ollamaModelsDir || '').trim();
  return custom || defaultModelsDir();
}

async function rmDir(target, errors) {
  try {
    await rm(target, { recursive: true, force: true });
  } catch (e) {
    errors.push(`${target}: ${e.message || e}`);
  }
}

export async function removeEngine() {
  const errors = [];
  await rmDir(ollamaDir(), errors);
  return { ok: errors.length === 0, errors };
}

export async function removeModels() {
  const errors = [];
  await rmDir(modelsDir(), errors);
  return { ok: errors.length === 0, errors };
}

async function locateAndNormalizeBin(dir) {
  const want = process.platform === 'win32' ? 'ollama.exe' : 'ollama';
  if (await isInstalled()) return managedBin();

  async function find(d) {
    for (const ent of await readdir(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) {
        const hit = await find(p);
        if (hit) return hit;
      } else if (ent.name === want) {
        return p;
      }
    }
    return null;
  }

  const found = await find(dir);
  if (!found) return null;

  const parent = dirname(found);
  if (parent !== dir) {
    for (const ent of await readdir(parent)) {
      await rename(join(parent, ent), join(dir, ent));
    }
  }
  return (await isInstalled()) ? managedBin() : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, label) {
  const lockCodes = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!lockCodes.has(e?.code) || i >= 4) {
        if (lockCodes.has(e?.code)) {
          throw new Error(`${label}失败:${e.code}(文件被占用,请关闭杀毒软件或重启电脑后重试)`, { cause: e });
        }
        throw e;
      }
      await sleep(400 * (i + 1));
    }
  }
}

function runCmd(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: 'ignore' });
    p.on('error', () => resolve(-1));
    p.on('exit', (code) => resolve(code ?? -1));
  });
}

async function extract(archive, dir) {
  const tarArgs =
    process.platform === 'win32' ? ['-xf', archive, '-C', dir] : ['-xzf', archive, '-C', dir];
  if ((await runCmd('tar', tarArgs)) === 0) return;

  if (process.platform === 'win32') {
    const code = await runCmd('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${dir}' -Force`,
    ]);
    if (code === 0) return;
    throw new Error('解压 Ollama 失败:系统缺少 tar,且 PowerShell Expand-Archive 也失败');
  }
  throw new Error('解压 Ollama 失败:tar 不可用或返回非 0');
}

let installAbort = null;

export function cancelInstall() {
  if (!installAbort) return { ok: false };
  installAbort.abort(new Error('user-cancel'));
  return { ok: true };
}

export async function install(onProgress) {
  if (await isInstalled()) {
    const installed = await installedVersion();
    const target = targetVersion();
    if (target === 'latest' || installed === target) {
      return { ok: true, already: true, bin: managedBin() };
    }
  }

  const url = assetUrl();
  const dir = ollamaDir();
  await withRetry(() => rm(dir, { recursive: true, force: true }), '清理旧引擎');
  await mkdir(dir, { recursive: true });

  const archive = join(tmpdir(), `vjtools-ollama-${Date.now()}-${assetName()}`);

  const ctrl = new globalThis.AbortController();
  installAbort = ctrl;
  const connectTimer = setTimeout(() => ctrl.abort(new Error('connect-timeout')), 30000);
  let actualInstalledVersion = targetVersion();
  try {
    let res;
    try {
      res = await net.fetch(url, { signal: ctrl.signal });
      const finalUrl = res.url || url;
      const versionMatch = finalUrl.match(/\/releases\/download\/(v[0-9a-zA-Z.-]+)\//);
      if (versionMatch) {
        actualInstalledVersion = versionMatch[1];
      }
    } finally {
      clearTimeout(connectTimer);
    }
    if (!res.ok || !res.body) throw new Error(`下载 Ollama 失败:HTTP ${res.status}(${url})`);

    const total = Number(res.headers.get('content-length')) || 0;
    let received = 0;
    let lastPct = -1;
    let lastEmit = 0;
    let speed = 0;
    let speedBytes = 0;
    let speedTime = Date.now();

    await pipeline(
      Readable.fromWeb(res.body),
      async function* (source) {
        for await (const chunk of source) {
          received += chunk.length;
          const now = Date.now();
          if (now - speedTime >= 700) {
            speed = ((received - speedBytes) / (now - speedTime)) * 1000;
            speedBytes = received;
            speedTime = now;
          }
          const pct = total ? Math.floor((received / total) * 100) : -1;
          if (pct !== lastPct || now - lastEmit >= 700) {
            lastPct = pct;
            lastEmit = now;
            onProgress?.({
              phase: 'download',
              percent: pct,
              receivedMB: Math.round(received / 1e6),
              totalMB: Math.round(total / 1e6),
              speed,
              url,
            });
          }
          yield chunk;
        }
      },
      createWriteStream(archive),
      { signal: ctrl.signal }
    );

    onProgress?.({ phase: 'extract' });
    try {
      await extract(archive, dir);
    } finally {
      await rm(archive, { force: true }).catch(() => {});
    }

    const bin = await locateAndNormalizeBin(dir);
    if (!bin) throw new Error('解压完成但未找到 ollama 可执行文件,可能是下载包结构有变');
    if (process.platform !== 'win32') await chmod(bin, 0o755);

    await writeFile(versionFile(), actualInstalledVersion, 'utf8').catch(() => {});

    return { ok: true, already: false, bin };
  } catch (e) {
    await rm(archive, { force: true }).catch(() => {});
    if (ctrl.signal.aborted) {
      await withRetry(() => rm(dir, { recursive: true, force: true }), '清理半截引擎').catch(() => {});
      const msg = ctrl.signal.reason?.message || '';
      if (/connect-timeout/.test(msg)) {
        throw new Error(
          `下载 Ollama 失败:连接超时(${url})。请检查网络后重试。`,
          { cause: e }
        );
      }
      throw new Error('已取消下载', { cause: e });
    }
    if (/^(下载 Ollama 失败|解压)/.test(e?.message || '')) throw e;
    throw new Error(`下载 Ollama 失败:${e?.message || e}(${url})`, { cause: e });
  } finally {
    installAbort = null;
  }
}
