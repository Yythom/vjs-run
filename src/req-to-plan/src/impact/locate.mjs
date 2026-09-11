// 关键词检索 + 孪生展开。
//
// 需求文档是中文的，而本仓库的业务概念大量以中文字面量直接出现在代码里
// （站内信的 switch case、Tab label、toast 文案），因此中文关键词是
// 比标识符更有效的检索锚点。
//
// 检索本身只是手段，真正的产出是「差集」：关键词命中了 5 个 app，
// 但该文件其实存在于 7 个 app —— 那 2 个就是最容易漏改的地方。
import { readFile } from 'node:fs/promises'

import { findTwinsOf } from './twins.mjs'

/** 在给定文件集合里做字面量检索，返回命中文件及行号。 */
export const searchKeyword = async (repoRoot, files, keyword) => {
  const hits = []

  await Promise.all(
    files.map(async (file) => {
      let content
      try {
        content = await readFile(`${repoRoot}/${file}`, 'utf8')
      } catch {
        return
      }
      if (!content.includes(keyword)) return

      const lines = []
      content.split('\n').forEach((line, i) => {
        if (line.includes(keyword)) lines.push({ line: i + 1, text: line.trim().slice(0, 160) })
      })

      hits.push({ file, count: lines.length, lines: lines.slice(0, 5) })
    }),
  )

  return hits.sort((a, b) => a.file.localeCompare(b.file))
}

/**
 * 把命中文件按孪生分组，算出「命中的 app」与「同名文件存在但未命中的 app」。
 *
 * missingApps 非空即为漏改风险点：同一份文件在别的 app 也有，
 * 但关键词没搜到它——可能是文案不同，也可能就是还没改。
 */
export const expandTwins = (index, hits, layout) => {
  const groups = new Map()
  const appPathPattern = new RegExp(`^${layout.appsDir}/([^/]+)/(.+)$`)

  for (const hit of hits) {
    const match = hit.file.match(appPathPattern)
    if (!match) continue

    const [, app, key] = match
    if (!groups.has(key)) groups.set(key, { key, hitApps: new Set(), files: [] })
    groups.get(key).hitApps.add(app)
    groups.get(key).files.push(hit)
  }

  return [...groups.values()]
    .map((group) => {
      const { apps: allApps } = findTwinsOf(index, group.key, layout)
      const hitApps = [...group.hitApps].sort()
      const missingApps = allApps.filter((app) => !group.hitApps.has(app))
      return { key: group.key, allApps, hitApps, missingApps, files: group.files }
    })
    .sort((a, b) => b.missingApps.length - a.missingApps.length || a.key.localeCompare(b.key))
}
