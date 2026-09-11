// 跨 app 孪生文件检测。
//
// 多应用 monorepo 里，同一个组件常常在多个 app 各存一份。改动其中一份而漏掉
// 其余，是这类仓库最典型也最难在 review 中发现的缺陷 —— typecheck 不会关联它们。
// 这里用纯路径比对把「孪生」算出来，不依赖任何语义判断。
//
// 目录布局（apps 目录名、app 内源码目录、源文件后缀、跳过哪些目录）全部来自
// 项目配置的 layout 段，本模块不假定具体项目的结构。
import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const walk = async (dir, base, out, layout) => {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') || layout.skipDirs.includes(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, base, out, layout)
    else if (layout.sourcePattern.test(entry.name)) out.push(relative(base, full))
  }

  return out
}

/** 把配置里的后缀列表编成一个匹配用的正则。 */
const compileLayout = (layout) => ({
  ...layout,
  sourcePattern: new RegExp(`\\.(${layout.sourceExtensions.join('|')})$`),
})

/** 列出 apps 目录下的子目录名（含残留空壳，由调用方筛掉）。 */
export const listApps = async (repoRoot, layout) => {
  const entries = await readdir(join(repoRoot, layout.appsDir), { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

/**
 * 建立「app 内相对路径 → 拥有该路径的 app 列表」索引。
 *
 * 键是去掉 <appsDir>/<name>/ 前缀后的路径，因此同一业务文件在不同 app 中
 * 会落到同一个键上。
 *
 * 返回的 apps 只含实际有源文件的应用：apps 目录下可能留着改名后没清干净的
 * 空壳目录（只剩 node_modules 和构建信息），把它算进应用列表会让下游看到
 * 偏大的应用数。
 */
export const buildTwinIndex = async (repoRoot, rawLayout) => {
  const layout = compileLayout(rawLayout)
  const candidates = await listApps(repoRoot, layout)
  const index = new Map()
  const apps = []

  await Promise.all(
    candidates.map(async (app) => {
      const appRoot = join(repoRoot, layout.appsDir, app)
      const files = await walk(join(appRoot, layout.appSourceDir), appRoot, [], layout)
      if (files.length === 0) return

      apps.push(app)
      for (const file of files) {
        if (!index.has(file)) index.set(file, [])
        index.get(file).push(app)
      }
    }),
  )

  apps.sort()
  return { apps, index, layout }
}

/** 只保留出现在 2 个及以上 app 中的路径，按覆盖面降序。 */
export const findTwinGroups = (index, minApps = 2) =>
  [...index.entries()]
    .filter(([, apps]) => apps.length >= minApps)
    .map(([path, apps]) => ({ path, apps: [...apps].sort(), count: apps.length }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))

/**
 * 查某个文件的孪生。
 *
 * 入参既接受仓库相对路径（<appsDir>/<app>/...），也接受 app 内相对路径。
 */
export const findTwinsOf = (index, filePath, layout) => {
  const normalized = filePath.split(sep).join('/')
  const match = normalized.match(new RegExp(`^${layout.appsDir}/[^/]+/(.+)$`))
  const key = match ? match[1] : normalized

  const apps = index.get(key)
  return { key, apps: apps ? [...apps].sort() : [] }
}
