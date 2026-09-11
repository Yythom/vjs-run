// 同名实现检测。
//
// twins 只能发现「跨 app 的同路径」拷贝。但仓库里还有一类更隐蔽的重复：
// 同一份逻辑在不同路由目录下各写一份，文件名相同而路径不同。
// 这类文件 typecheck 不会关联，改一处不会提示其余几处。
//
// 哪些文件名算「通用」（同名不代表同类实现，列出来只是噪音）来自项目配置的
// genericFileNames，因为它取决于框架约定而非普遍规律。
import { basename } from 'node:path'

/** 路径切成 token，用于衡量两个同名文件所处的上下文有多接近。 */
const pathTokens = (path) => new Set(path.split(/[/.\-_$]+/).filter((t) => t.length > 2))

const similarity = (a, b) => {
  const setA = pathTokens(a)
  const setB = pathTokens(b)
  let shared = 0
  for (const token of setA) if (setB.has(token)) shared += 1
  return shared / Math.max(setA.size, setB.size)
}

/**
 * 找出与目标文件同名的其他实现，按上下文相似度排序。
 *
 * 相似度只是排序依据，不做阈值过滤 —— 同名却上下文迥异的文件也值得
 * 出现在列表里，由使用者判断是否相关。
 */
export const findSiblings = (allFiles, target, { genericFileNames, biz }) => {
  const name = basename(target)
  if (genericFileNames.has(name)) {
    return { name, generic: true, siblings: [] }
  }

  const siblings = allFiles
    .filter((file) => basename(file) === name && file !== target)
    .map((file) => ({
      file,
      bizLines: biz.detectBizLines(file),
      score: Number(similarity(target, file).toFixed(2)),
    }))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))

  return { name, generic: false, siblings }
}

/** 全仓扫描：列出所有存在多份同名实现的文件名。 */
export const findSiblingGroups = (allFiles, { genericFileNames, minCount = 2 }) => {
  const byName = new Map()

  for (const file of allFiles) {
    const name = basename(file)
    if (genericFileNames.has(name)) continue
    if (!byName.has(name)) byName.set(name, [])
    byName.get(name).push(file)
  }

  return [...byName.entries()]
    .filter(([, files]) => files.length >= minCount)
    .map(([name, files]) => ({ name, count: files.length, files: files.sort() }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}
