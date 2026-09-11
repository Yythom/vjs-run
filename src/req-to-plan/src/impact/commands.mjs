// 影响面扫描：从仓库结构算出一处改动会牵连到哪些位置。
//
// 只做机械计算，不做语义判断；判断交给读取本工具输出的 agent。
// 仓库布局、业务线、通用文件名均来自项目配置，本文件不含具体项目的假设。
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { loadRepoConfig, resolveProjectDir } from '../config.mjs'
import { createBizLines } from './biz-lines.mjs'
import { expandTwins, searchKeyword } from './locate.mjs'
import { mirrorFiles } from './mirror.mjs'
import { findSiblingGroups, findSiblings } from './siblings.mjs'
import { buildTwinIndex, findTwinGroups, findTwinsOf } from './twins.mjs'

const usage = `用法:
  req scan twins [文件路径]      查孪生文件（不传路径则列出全部孪生组）
  req scan locate <关键词...>    按中文业务词检索并展开孪生，输出漏改风险
                               --scope <前缀,前缀> 限定搜索范围（强烈建议）
  req scan mirror <路径前缀>     业务线对称对照，输出目标侧缺失文件（--from/--to）
  req scan siblings [文件路径]   同名不同路径的实现（twins 覆盖不到的一类重复）

参数:
  --repo <目录>     仓库根目录，默认取 REQ_REPO_ROOT，再回退当前目录（--root 为旧别名）
  --project <目录>  项目配置目录，默认取 REQ_PROJECT，再回退包内唯一的配置目录
  --min <数字>      twins / siblings 列表模式下的最小份数
  --json            输出 JSON
`

/** index 的键是 app 内相对路径，与 app 列表做笛卡尔积即全部源文件。 */
const allFilesFrom = (index, layout) =>
  [...index.entries()].flatMap(([key, apps]) =>
    apps.map((app) => `${layout.appsDir}/${app}/${key}`),
  )

const runTwins = (ctx, target, values) => {
  const { index, apps, layout } = ctx

  if (target) {
    const { key, apps: owners } = findTwinsOf(index, target, layout)
    if (values.json) return console.log(JSON.stringify({ key, apps: owners }, null, 2))

    if (owners.length === 0) return console.log(`未在任何 app 中找到: ${key}`)

    console.log(`${key}\n存在于 ${owners.length} 个 app：`)
    for (const app of owners) console.log(`  ${layout.appsDir}/${app}/${key}`)
    if (owners.length > 1) {
      console.log(`\n⚠ 改动此文件需同步全部 ${owners.length} 处，漏改不会被 typecheck 发现。`)
    }
    return
  }

  const minApps = Number(values.min ?? 2)
  const groups = findTwinGroups(index, minApps)

  if (values.json) return console.log(JSON.stringify({ apps, groups }, null, 2))

  console.log(`扫描 ${apps.length} 个 app：${apps.join(', ')}`)
  console.log(`孪生文件组（≥${minApps} 个 app）：${groups.length} 组\n`)
  for (const group of groups.slice(0, 40)) {
    console.log(`${String(group.count).padStart(2)} × ${group.path}`)
  }
  if (groups.length > 40) console.log(`\n... 另有 ${groups.length - 40} 组，用 --json 查看全部`)
}

const runLocate = async (ctx, keywords, values) => {
  const { repoRoot, index, layout } = ctx
  let files = allFilesFrom(index, layout)

  // 纯字面检索没有业务上下文：「暂停」在音乐播放器和上传断点是两回事。
  // --scope 用需求里提到的模块（上传页 / 作品优化页）把搜索范围先圈住。
  const scopes = (values.scope ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (scopes.length) {
    files = files.filter((file) => scopes.some((scope) => file.includes(scope)))
  }

  const result = []
  for (const keyword of keywords) {
    const hits = await searchKeyword(repoRoot, files, keyword)
    result.push({ keyword, hitCount: hits.length, groups: expandTwins(index, hits, layout) })
  }

  if (values.json) return console.log(JSON.stringify({ keywords, scopes, result }, null, 2))

  if (scopes.length) console.log(`范围限定: ${scopes.join(', ')}（${files.length} 个文件）`)

  for (const { keyword, hitCount, groups } of result) {
    console.log(`\n关键词「${keyword}」：命中 ${hitCount} 个文件`)

    // 规划阶段真正要回答的是「改这里要改几处」，所以只要命中文件存在孪生就必须提示，
    // 无论关键词是否已在其余副本中出现。missingApps 只作为附加线索。
    const multi = groups.filter((g) => g.allApps.length > 1)
    const single = groups.filter((g) => g.allApps.length === 1)

    if (multi.length) {
      console.log(`\n  ⚠ 需同步多处（命中文件在多个 app 各存一份）：`)
      for (const group of multi.slice(0, 10)) {
        console.log(`    ${group.key}  → 需改 ${group.allApps.length} 处`)
        console.log(`      ${group.allApps.map((a) => `${layout.appsDir}/${a}`).join(' ')}`)
        if (group.missingApps.length) {
          console.log(`      关键词未命中: ${group.missingApps.join(', ')}（文案不同或尚未改）`)
        }
      }
      if (multi.length > 10) console.log(`    ... 另有 ${multi.length - 10} 组`)
    }

    if (single.length) {
      console.log(`\n  单 app 文件 ${single.length} 个：`)
      for (const group of single.slice(0, 8)) {
        console.log(`    ${layout.appsDir}/${group.allApps[0]}/${group.key}`)
      }
      if (single.length > 8) console.log(`    ... 另有 ${single.length - 8} 个`)
    }
  }
}

const runMirror = (ctx, prefix, values) => {
  const { index, layout, biz } = ctx
  const lineNames = biz.names

  const from = values.from ?? lineNames[0]
  const to = values.to
  if (!to) {
    console.error(`✗ mirror 需要 --to <业务线>，可选：${lineNames.join(' / ')}`)
    process.exit(1)
  }
  for (const [flag, line] of [
    ['--from', from],
    ['--to', to],
  ]) {
    if (!lineNames.includes(line)) {
      console.error(`✗ ${flag} 未知业务线「${line}」，可选：${lineNames.join(' / ')}`)
      process.exit(1)
    }
  }

  const allFiles = allFilesFrom(index, layout)
  const { sourceCount, matched, missing } = mirrorFiles(allFiles, { prefix, from, to, biz })

  if (values.json) {
    return console.log(JSON.stringify({ prefix, from, to, sourceCount, matched, missing }, null, 2))
  }

  console.log(`对照 ${from} → ${to}，前缀「${prefix}」`)
  console.log(`${from} 侧 ${sourceCount} 个文件：已有对应 ${matched.length}，缺失 ${missing.length}\n`)

  if (missing.length) {
    console.log(`⚠ ${to} 侧缺失（即需新建）：`)
    for (const item of missing) console.log(`    ${item.expected}\n      参照: ${item.source}`)
  }

  if (matched.length) {
    console.log(`\n✓ 两侧都有（改动时需对齐差异）：`)
    for (const item of matched.slice(0, 15)) {
      const notes = [
        item.exact ? null : '参数名不同',
        // 目标侧用了别名命名（如案例线实际叫 case），照抄主 token 会找错文件
        item.alias ? `目标侧命名为 ${item.alias}` : null,
      ].filter(Boolean)
      console.log(`    ${item.target}${notes.length ? `  (${notes.join('，')})` : ''}`)
    }
    if (matched.length > 15) console.log(`    ... 另有 ${matched.length - 15} 个`)
  }
}

const runSiblings = (ctx, target, values) => {
  const { index, layout, biz, repoConfig } = ctx
  const allFiles = allFilesFrom(index, layout)
  const { genericFileNames } = repoConfig

  if (!target) {
    const minCount = Number(values.min ?? 3)
    const groups = findSiblingGroups(allFiles, { genericFileNames, minCount })
    if (values.json) return console.log(JSON.stringify({ groups }, null, 2))

    console.log(`存在多份同名实现的文件（≥${minCount} 份）：${groups.length} 组\n`)
    for (const group of groups.slice(0, 30)) {
      console.log(`${String(group.count).padStart(2)} × ${group.name}`)
    }
    if (groups.length > 30) console.log(`\n... 另有 ${groups.length - 30} 组，用 --json 查看全部`)
    return
  }

  const prefix = `${layout.appsDir}/`
  if (!target.startsWith(prefix)) {
    console.error(`✗ siblings 需要仓库相对路径（${prefix}<app>/...）`)
    process.exit(1)
  }

  const { name, generic, siblings } = findSiblings(allFiles, target, { genericFileNames, biz })

  if (values.json) {
    return console.log(JSON.stringify({ target, name, generic, siblings }, null, 2))
  }

  if (generic) {
    console.log(`${name} 是通用文件名，同名不代表同类实现，不做对照。`)
    return
  }

  if (siblings.length === 0) {
    console.log(`${name} 在仓库中只有这一份。`)
    return
  }

  console.log(`${name} 共 ${siblings.length + 1} 份实现：\n`)
  console.log(`  ${target}  ← 目标`)
  for (const item of siblings) {
    const lines = item.bizLines.length ? `[${item.bizLines.join('/')}]` : ''
    console.log(`  ${item.file}  ${lines} 相似度 ${item.score}`)
  }
  console.log(`\n⚠ 同名不同路径，typecheck 不会关联；改动前逐一确认是否同类实现。`)
}

export const main = async (args) => {
  const { values, positionals } = parseArgs({
    args,
    options: {
      repo: { type: 'string' },
      // --root 是本工具早期的写法，保留兼容；新用法统一为 --repo，与需求侧一致
      root: { type: 'string' },
      project: { type: 'string' },
      min: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      scope: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  })

  const [command, ...rest] = positionals
  if (values.help || !['twins', 'locate', 'mirror', 'siblings'].includes(command)) {
    console.log(usage)
    process.exit(command ? 0 : 1)
  }

  const projectDir = await resolveProjectDir(values.project)
  const repoConfig = await loadRepoConfig(projectDir)

  // 本工具可装在被分析仓库之外运行，仓库位置按 参数 > 环境变量 > 当前目录 解析
  const repoRoot = resolve(
    values.repo ?? values.root ?? process.env.REQ_REPO_ROOT ?? process.cwd(),
  )

  const { apps, index, layout } = await buildTwinIndex(repoRoot, repoConfig.layout)
  const ctx = { repoRoot, apps, index, layout, repoConfig, biz: createBizLines(repoConfig.bizLines) }

  if (command === 'twins') return runTwins(ctx, rest[0], values)
  if (command === 'siblings') return runSiblings(ctx, rest[0], values)

  if (command === 'mirror') {
    if (!rest[0]) {
      console.error('✗ mirror 需要一个路径前缀')
      process.exit(1)
    }
    return runMirror(ctx, rest[0], values)
  }

  if (rest.length === 0) {
    console.error('✗ locate 需要至少一个关键词')
    process.exit(1)
  }
  return runLocate(ctx, rest, values)
}
