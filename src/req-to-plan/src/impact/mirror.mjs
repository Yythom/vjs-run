// 业务线对称映射。
//
// 同构的业务线在路由和组件上高度相似，需求里的「参照视频，为图片做一套」
// 本质上就是沿这个对称轴复制。本模块回答两个问题：参照实现在哪、目标侧缺哪些文件。
//
// 两处不规整必须处理，否则用别名命名的业务线会大面积误判：
//   1. 业务线在代码里有别名 —— 生成目标路径用主 token，找不到时用别名再探测一遍。
//   2. 路由参数命名不统一 —— 对照时把参数段当通配符，只对齐业务线 token 与结构。

// 业务线 token 出现在路径段中间，需要用分隔符界定，避免误伤
// 例如 `videos`、`fotoSize` 这类包含业务线字样的普通标识符。
const lineTokenPattern = (token) => new RegExp(`(^|[./_-])${token}($|[./_-])`, 'g')

/** 路径是否属于某条业务线（任一别名命中即算）。 */
const belongsTo = (path, line, biz) =>
  biz.tokensOf(line).some((token) => lineTokenPattern(token).test(path))

/** 把路径里的业务线 token 换成目标 token，并对齐路由参数缩写。 */
const swapToken = (path, fromToken, toToken, fromLine, toLine, biz) => {
  const swapped = path.replace(
    lineTokenPattern(fromToken),
    (_, before, after) => `${before}${toToken}${after}`,
  )

  const fromParam = biz.paramOf(fromLine)
  const toParam = biz.paramOf(toLine)
  if (!fromParam || !toParam) return swapped

  // replace 的替换串里 $ 有特殊含义，用 $$ 转义出字面美元符
  return swapped.replace(new RegExp(`\\$${fromParam}(?![a-zA-Z])`, 'g'), `$$${toParam}`)
}

/** 用主 token 生成目标侧的预期路径。 */
export const swapLine = (path, from, to, biz) =>
  swapToken(path, biz.mainToken(from), biz.mainToken(to), from, to, biz)

/**
 * 生成目标侧的全部候选路径：主 token 一个，其余别名各一个。
 *
 * 目标业务线可能用别名命名，只按主 token 找会把「已存在但换了名字」
 * 误报成「缺失」。
 */
const candidatesFor = (path, from, to, biz) => {
  const seen = new Set()
  const out = []

  for (const fromToken of biz.tokensOf(from)) {
    if (!lineTokenPattern(fromToken).test(path)) continue
    for (const toToken of biz.tokensOf(to)) {
      const candidate = swapToken(path, fromToken, toToken, from, to, biz)
      if (candidate === path || seen.has(candidate)) continue
      seen.add(candidate)
      out.push({ path: candidate, token: toToken })
    }
  }

  return out
}

/** 参数段命名不统一，转成通配后再比对结构。 */
const toPattern = (path) =>
  new RegExp(
    `^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\$[a-zA-Z]+/g, '\\$[a-zA-Z]+')}$`,
  )

/**
 * 对照两条业务线在给定前缀下的文件分布。
 *
 * matched  两侧都有（alias 标记目标侧是否用了别名命名）
 * missing  源侧有、目标侧无 —— 即「要新建的文件清单」
 */
export const mirrorFiles = (allFiles, { prefix, from, to, biz }) => {
  const sourceFiles = allFiles.filter(
    (file) => file.includes(prefix) && belongsTo(file, from, biz),
  )

  const targetSet = new Set(allFiles)
  const matched = []
  const missing = []

  for (const file of sourceFiles) {
    const candidates = candidatesFor(file, from, to, biz)
    const primary = candidates[0]?.path ?? swapLine(file, from, to, biz)

    // 先精确命中；再按参数通配找结构等价的文件；两者都对每个别名候选试一遍。
    const exact = candidates.find((candidate) => targetSet.has(candidate.path))
    if (exact) {
      matched.push({
        source: file,
        target: exact.path,
        exact: true,
        alias: exact.token !== biz.mainToken(to) ? exact.token : null,
      })
      continue
    }

    let fuzzyHit = null
    for (const candidate of candidates) {
      const pattern = toPattern(candidate.path)
      const found = allFiles.find((item) => pattern.test(item))
      if (found) {
        fuzzyHit = { target: found, token: candidate.token }
        break
      }
    }

    if (fuzzyHit) {
      matched.push({
        source: file,
        target: fuzzyHit.target,
        exact: false,
        alias: fuzzyHit.token !== biz.mainToken(to) ? fuzzyHit.token : null,
      })
    } else {
      missing.push({ source: file, expected: primary })
    }
  }

  return { sourceCount: sourceFiles.length, matched, missing }
}
