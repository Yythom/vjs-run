// 项目配置加载。
//
// src/ 下的代码不含任何具体项目的假设：仓库目录布局、业务线、通用文件名、
// 接口检索命令全部来自项目配置目录（包内任一含 repo.config.json 的目录）。
// 换一个项目 = 新建一个配置目录，代码不动。
import { readdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const REPO_CONFIG = 'repo.config.json'
const POOL_CONFIG = 'pool.config.json'

/** 包内所有含 repo.config.json 的目录，即可用的项目配置。 */
const discoverProjects = async () => {
  const entries = await readdir(packageRoot, { withFileTypes: true })
  const found = []

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (['src', 'bin', 'node_modules'].includes(entry.name)) continue
    try {
      await readFile(resolve(packageRoot, entry.name, REPO_CONFIG), 'utf8')
      found.push(entry.name)
    } catch {
      // 不是项目配置目录，跳过
    }
  }

  return found.sort()
}

/**
 * 解析项目配置目录：显式参数 > 环境变量 > 包内自动发现。
 *
 * 自动发现只在恰好一个候选时成立；多个候选时要求显式指定，
 * 避免默认挑中一个不相干的项目却毫无提示。
 */
export const resolveProjectDir = async (explicit) => {
  const given = explicit ?? process.env.REQ_PROJECT
  if (given) return isAbsolute(given) ? given : resolve(packageRoot, given)

  const projects = await discoverProjects()
  if (projects.length === 1) return resolve(packageRoot, projects[0])

  if (projects.length === 0) {
    throw new Error(
      `包内没有找到项目配置目录（需含 ${REPO_CONFIG}）。\n` +
        `新建一个目录并放入 ${REPO_CONFIG} 与 ${POOL_CONFIG}。`,
    )
  }

  throw new Error(
    `包内有多个项目配置，请用 --project 指定：\n` +
      projects.map((name) => `  ${name}`).join('\n'),
  )
}

const readJson = async (path) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`配置文件不存在: ${path}`, { cause: error })
    throw new Error(`配置文件解析失败: ${path}\n${error.message}`, { cause: error })
  }
}

/** 仓库结构配置：目录布局、业务线、通用文件名、接口检索命令、规则文件。 */
export const loadRepoConfig = async (projectDir) => {
  const config = await readJson(resolve(projectDir, REPO_CONFIG))

  // 下游按固定形状取值，缺省项在这里补齐，免得每个调用点都判空
  return {
    name: config.name ?? 'unnamed',
    layout: {
      appsDir: 'apps',
      appSourceDir: 'app',
      sourceExtensions: ['ts', 'tsx'],
      skipDirs: ['node_modules', 'dist', 'build'],
      ...(config.layout ?? {}),
    },
    bizLines: config.bizLines ?? {},
    genericFileNames: new Set(config.genericFileNames ?? []),
    apiSearch: config.apiSearch ?? null,
    rules: config.rules ?? null,
  }
}

/** 需求池配置。 */
export const loadPoolConfig = (projectDir) => readJson(resolve(projectDir, POOL_CONFIG))

/** 把 ${repoRoot} 之类的占位换成实际路径。 */
export const expandVars = (text, vars) =>
  text.replace(/\$\{(\w+)\}/g, (whole, key) => vars[key] ?? whole)
