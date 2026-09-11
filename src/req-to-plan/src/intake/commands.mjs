// 需求读取层：
//   pool     —— 从需求池取出已定稿、等待开发的需求（触发层）
//   prepare  —— 把一条需求的全部材料落成工作包，附任务简报
//   plan     —— 备料后交给 Claude 产出实施 plan
//   fetch    —— 把一份飞书需求文档拉成本地结构化产物
//   watch    —— 轮询新流转进「排实施」的需求并备料
//
// 除 plan 外只做机械读取与归一化；语义提取（影响面、实施方案）由 agent 完成。
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'

const execFileAsync = promisify(execFile)

import { downloadMedia, fetchDocx, fetchMindnote, resolveDoc } from './lark.mjs'
import { buildTree, renderMarkdown } from './normalize.mjs'
import { loadPoolConfig, packageRoot, resolveProjectDir, loadRepoConfig, expandVars } from '../config.mjs'
import { fetchPoolRecords, selectReady } from './pool.mjs'
import { renderContext } from './prepare.mjs'
import { renderSkill, describeRules } from '../skill/render.mjs'
import { loadState, pickNew, saveState, triage } from './watch.mjs'

// 图片逐张走一次 lark-cli 进程，并发过高会被飞书限流，也会打满本机进程数。
const DOWNLOAD_CONCURRENCY = 4

// 影响面工具与 skill 都在本包内，整包可迁移到任意位置。
const toolsRoot = packageRoot

// 被分析仓库的位置：参数 > 环境变量 > 当前目录。
const resolveRepoRoot = (values) =>
  resolve(values.repo ?? process.env.REQ_REPO_ROOT ?? process.cwd())

const usage = `用法:
  req pool                       列出需求池中「排实施」的需求
  req prepare <链接|record_id|关键词>  生成工作包（含任务简报）
  req plan <链接|record_id|关键词>     备料后交给 Claude 产出 plan
  req fetch <飞书URL>             只拉取需求文档
  req watch                      轮询新流转进「排实施」的需求并备料

参数:
  --out <目录>    输出目录，默认 .requirements/<slug>
  --no-assets     跳过图片下载
  --project <目录> 项目配置目录，默认取 REQ_PROJECT，再回退包内唯一的配置目录
  --repo <目录>   被分析仓库根目录，默认取 REQ_REPO_ROOT，再回退当前目录
  --state <文件>  watch 的状态文件，默认 <out>/watch-state.json
  --exec <命令>   watch 备料后对每个工作包执行的命令
                  （环境变量 WORKPACK_DIR / RECORD_ID；不传则只备料）
  --json          输出 JSON（prepare 会把工作包路径等结构化信息打到 stdout）
`

/** 读取当前项目的仓库结构配置。 */
const loadProjectRepoConfig = async (values) =>
  loadRepoConfig(await resolveProjectDir(values.project))

/** 接口检索命令来自项目配置，未配置时简报里省略这一段。 */
const loadApiSearch = async (values) => {
  const config = await loadProjectRepoConfig(values)
  if (!config.apiSearch) return null
  const repoRoot = resolveRepoRoot(values)
  return {
    search: expandVars(config.apiSearch.search ?? '', { repoRoot }),
    detail: expandVars(config.apiSearch.detail ?? '', { repoRoot }),
  }
}

/**
 * 把工作规范渲染进工作包（skill.md）。
 *
 * 工作包因此自包含：接手的 agent —— req plan 自己、赛博牛马派下来的无头进程、
 * 或者人手开的一个会话 —— 读目录就拿得到同一份规范，不必知道 req-to-plan 装在哪。
 * 返回值给调用方复用，免得产 plan 时再扫一遍仓库。
 */
const writeSkill = async (outDir, values) => {
  const projectDir = await resolveProjectDir(values.project)
  const repoConfig = await loadRepoConfig(projectDir)
  const rendered = await renderSkill({
    projectDir,
    repoConfig,
    repoRoot: resolveRepoRoot(values),
    workpackDir: outDir,
  })
  await writeFile(resolve(outDir, 'skill.md'), rendered.text)
  return { ...rendered, repoConfig }
}

/** 按固定并发跑任务，避免 25 张图同时开 25 个进程。 */
const mapWithConcurrency = async (items, limit, worker) => {
  const results = new Array(items.length)
  let cursor = 0

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index], index)
    }
  })

  await Promise.all(runners)
  return results
}

/** 拉取并归一化一份需求文档，返回落盘结果供上层组装简报。 */
const fetchRequirement = async (url, outDir, { skipAssets = false } = {}) => {
  const meta = await resolveDoc(url)
  console.error(`  ${meta.type} / ${meta.title || '(无标题)'} / ${meta.token}`)

  await mkdir(outDir, { recursive: true })

  let tree = []
  let assets = []
  let links = []
  let rawMarkdown = null

  if (meta.type === 'mindnote') {
    const nodes = await fetchMindnote(meta.token)
    console.error(`  节点 ${nodes.length} 个`)
    ;({ tree, assets, links } = buildTree(nodes))
  } else if (meta.type === 'docx') {
    const doc = await fetchDocx(meta.token)
    rawMarkdown = doc.document?.content ?? ''
    console.error(`  字符 ${rawMarkdown.length}`)
  } else {
    throw new Error(`暂不支持的资源类型: ${meta.type}（当前支持 mindnote / docx）`)
  }

  if (assets.length && !skipAssets) {
    await mkdir(resolve(outDir, 'assets'), { recursive: true })
    await mapWithConcurrency(assets, DOWNLOAD_CONCURRENCY, async (asset, index) => {
      const base = resolve(outDir, 'assets', `img-${String(index + 1).padStart(2, '0')}`)
      try {
        const saved = await downloadMedia(asset.token, base)
        asset.localPath = relative(outDir, saved)
      } catch (error) {
        console.error(`  ⚠ 图片 ${asset.token} 下载失败: ${error.message}`)
      }
    })
    console.error(`  图片 ${assets.filter((a) => a.localPath).length}/${assets.length}`)
  }

  const source = { url, ...meta }
  await writeFile(
    resolve(outDir, 'requirement.json'),
    JSON.stringify({ source, tree, assets, links, rawMarkdown }, null, 2),
  )
  await writeFile(resolve(outDir, 'requirement.md'), rawMarkdown ?? renderMarkdown(tree, source))

  return { meta, assetCount: assets.filter((a) => a.localPath).length, linkCount: links.length }
}

const readPool = async (values) => {
  const projectDir = await resolveProjectDir(values.project)
  const config = await loadPoolConfig(projectDir)
  const cacheDir = resolve(values.out ?? '.requirements')
  await mkdir(cacheDir, { recursive: true })

  const records = await fetchPoolRecords(config, resolve(cacheDir, 'pool.ndjson'))
  return { config, records, ready: selectReady(records, config), cacheDir }
}

const runPool = async (values) => {
  const { config, records, ready } = await readPool(values)

  if (values.json) return console.log(JSON.stringify({ total: records.length, ready }, null, 2))

  console.log(`需求池 ${records.length} 条，状态「${config.readyStatus}」${ready.length} 条\n`)

  for (const item of ready) {
    const lines = item.bizTokens.length ? item.bizTokens.join('/') : (item.bizLines.join('/') || '-')
    console.log(`${item.name}`)
    console.log(`  业务线: ${lines}    方案: ${item.planUrl ? '✓' : '✗'}   视觉: ${item.visualUrl ? '✓' : '✗'}`)
    console.log(`  record: ${item.recordId}`)
  }
}

/** 文档 URL 常带 #mindmap、?from=from_copylink 之类的尾巴，比对时只看 token 部分。 */
export const tokenOf = (url) => url?.match(/\/(?:wiki|docx|docs|mindnotes)\/([A-Za-z0-9]+)/)?.[1] || ''

const sameDoc = (a, b) => {
  const [ta, tb] = [tokenOf(a), tokenOf(b)]
  return Boolean(ta && tb && ta === tb)
}

/**
 * 定位一条需求。
 *
 * 接受 record_id、需求名关键词，或直接给文档链接。给链接时先反查需求池 ——
 * 命中就能拿到业务线等结构化字段；查不到则退化成 standalone 工作包，
 * 由 agent 从正文推断业务线。
 */
const locateRequirement = async (target, values) => {
  const isUrl = target.startsWith('http')
  const { ready } = await readPool(values)

  const matches = ready.filter((item) =>
    isUrl
      ? sameDoc(item.planUrl, target)
      : item.recordId === target || (item.name ?? '').includes(target),
  )

  if (matches.length > 1) {
    throw new Error(
      `匹配到多条，请用 record_id 指定：\n` +
        matches.map((m) => `  ${m.recordId}  ${m.name}`).join('\n'),
    )
  }

  if (matches.length === 1) {
    const [requirement] = matches
    if (!requirement.planUrl) {
      throw new Error(`需求「${requirement.name}」没有方案链接，无法生成工作包`)
    }
    return requirement
  }

  if (!isUrl) {
    throw new Error(`未在「排实施」中找到: ${target}\n用 pool 命令查看可用需求`)
  }

  console.error('  ⚠ 该链接不在需求池「排实施」列表中，按独立文档处理')
  return {
    recordId: null,
    name: null,
    status: null,
    bizLines: [],
    bizTokens: [],
    planUrl: target,
    visualUrl: null,
    standalone: true,
  }
}

const runPrepare = async (target, values) => {
  const requirement = await locateRequirement(target, values)

  const docToken = tokenOf(requirement.planUrl)
  const slug =
    requirement.recordId ??
    (docToken
      ? `standalone-${docToken}`
      : `standalone-${createHash('md5').update(requirement.planUrl || 'doc').digest('hex').slice(0, 8)}`)
  const outDir = resolve(values.out ?? `.requirements/${slug}`)
  console.error(`→ ${requirement.name ?? requirement.planUrl}`)

  const result = await fetchRequirement(requirement.planUrl, outDir, {
    skipAssets: values['no-assets'],
  })

  // 独立文档没有需求池里的需求名，用文档标题兜底
  const named = { ...requirement, name: requirement.name ?? result.meta.title ?? '(无标题需求)' }

  const context = renderContext(
    named,
    { markdown: 'requirement.md', json: 'requirement.json', assetCount: result.assetCount },
    { toolsRoot, repoRoot: resolveRepoRoot(values), apiSearch: await loadApiSearch(values) },
  )
  await writeFile(resolve(outDir, 'context.md'), context)

  const skill = await writeSkill(outDir, values)

  console.error(`\n✓ 工作包: ${outDir}`)
  console.error(`  context.md        任务简报（agent 从这里开始）`)
  console.error(`  requirement.md    需求正文`)
  console.error(`  skill.md          工作规范（${skill.facts.apps.length} 个应用、${skill.facts.twinGroups.length} 组孪生）`)
  if (result.assetCount) console.error(`  assets/           ${result.assetCount} 张截图`)

  // stderr 是给人看的进度，stdout 是给调用方解析的数据。
  // 赛博牛马的 /plan 指令要拿 outDir 去建任务，不能靠 grep 上面那几行进度
  if (values.json) {
    console.log(
      JSON.stringify(
        {
          outDir,
          recordId: named.recordId,
          name: named.name,
          planUrl: named.planUrl ?? null,
          bizTokens: named.bizTokens ?? [],
          standalone: Boolean(named.standalone),
          assetCount: result.assetCount,
        },
        null,
        2,
      ),
    )
  }

  return { outDir, requirement: named, skill }
}

/**
 * 备料 + 交给 Claude 产出 plan。
 *
 * 工作规范由 runPrepare 渲染进工作包（skill.md），这里直接注入 system prompt，
 * 因此被分析仓库不需要安装任何东西；claude 仍在仓库里跑（cwd = repoRoot），
 * 否则读不到代码和仓库自身的规则文件。
 */
const runPlan = async (target, values) => {
  const { outDir, requirement, skill } = await runPrepare(target, values)
  const repoRoot = resolveRepoRoot(values)
  const rules = skill.repoConfig.rules
  const rulesText = describeRules(rules)

  const prompt = [
    `读取工作包 ${outDir}/context.md，按注入的工作规范产出实施 plan，写入 ${outDir}/plan.md。`,
    `需求名称：${requirement.name}`,
    '',
    '硬性要求：',
    `- 逐张 Read ${outDir}/assets/ 下的截图，界面约束只存在于图里`,
    '- 检索必须带 --scope，命中结果要与需求描述的模块一致',
    '- locate 命中的每个文件都要跑一次 siblings',
    '- 澄清清单不能省，需求文档自标的「开发阶段确认」项逐条抄进去',
    // 规则文件的位置随项目而异，从项目配置取，不写死具体文件名
    rules ? `- 先读 ${rulesText}，plan 要符合仓库自身的规则` : null,
    '- 只产出 plan，不要改任何业务代码',
  ]
    .filter((line) => line !== null)
    .join('\n')

  console.error(`\n→ 交给 Claude 产出 plan（工作目录 ${repoRoot}）`)

  const exitCode = await new Promise((resolvePromise) => {
    const child = spawn(
      'claude',
      [
        '-p',
        prompt,
        '--append-system-prompt',
        skill.text,
        '--add-dir',
        outDir,
        '--permission-mode',
        'acceptEdits',
        // 影响面与接口检索都要起 node 子进程；不显式放行会被权限拦截，
        // 无头模式下又无法交互确认，agent 只能退化成 grep。
        '--allowedTools',
        'Bash(node:*),Read,Write,Edit,Glob,Grep',
      ],
      { cwd: repoRoot, stdio: ['ignore', 'inherit', 'inherit'] },
    )
    child.on('close', resolvePromise)
    child.on('error', (error) => {
      console.error(`✗ 启动 claude 失败: ${error.message}`)
      resolvePromise(1)
    })
  })

  if (exitCode !== 0) throw new Error(`claude 退出码 ${exitCode}，plan 可能未生成`)
  console.error(`\n✓ plan: ${outDir}/plan.md`)
}

const runFetch = async (url, values) => {
  console.error(`→ ${url}`)
  const outDir = resolve(values.out ?? '.requirements/fetch')
  const result = await fetchRequirement(url, outDir, { skipAssets: values['no-assets'] })
  console.error(`\n✓ ${outDir}`)
  if (result.linkCount) console.error(`  外链 ${result.linkCount} 条`)
}

const runWatch = async (values) => {
  const { ready, cacheDir } = await readPool(values)
  const statePath = resolve(values.state ?? `${cacheDir}/watch-state.json`)
  const state = await loadState(statePath)

  const fresh = pickNew(ready, state)
  const buckets = triage(fresh)

  console.error(`需求池「排实施」${ready.length} 条，本轮新增 ${fresh.length} 条`)

  const skipped = [
    ['非开发需求（业务线=不涉及业务线）', buckets.notDev],
    ['业务线为「其他」，需人工确认是否要开发', buckets.needsReview],
    ['缺方案链接', buckets.missingPlan],
    ['方案链接不是飞书文档', buckets.badLink],
  ].filter(([, items]) => items.length > 0)

  for (const [label, items] of skipped) {
    console.error(`\n⚠ ${label}（${items.length}）：`)
    for (const item of items) {
      console.error(`  ${item.recordId}  ${item.name}`)
      // 落 state，避免每轮重复报；方案链接补上后 pickNew 会重新捞出来
      state.processed[item.recordId] = {
        status: item.status,
        name: item.name,
        planUrl: item.planUrl ?? null,
        skipped: label,
        seenAt: new Date().toISOString(),
      }
    }
  }

  if (buckets.shared.length) {
    console.error(`\n⚠ 多条需求共用一份方案文档（${buckets.shared.length}）——已在工作包里标注共用者：`)
    for (const item of buckets.shared) {
      console.error(`  ${item.name}  ← 与 ${item.sharedWith.join('、')} 共用`)
    }
  }

  const prepared = []
  for (const item of buckets.actionable) {

    const outDir = resolve(values.out ?? '.requirements', item.recordId)
    console.error(`\n→ ${item.name}`)

    try {
      const result = await fetchRequirement(item.planUrl, outDir, {
        skipAssets: values['no-assets'],
      })
      const context = renderContext(
        item,
        { markdown: 'requirement.md', json: 'requirement.json', assetCount: result.assetCount },
        { toolsRoot, repoRoot: resolveRepoRoot(values), apiSearch: await loadApiSearch(values) },
      )
      await writeFile(resolve(outDir, 'context.md'), context)
      await writeSkill(outDir, values)

      prepared.push({ ...item, outDir })
      state.processed[item.recordId] = {
        status: item.status,
        name: item.name,
        planUrl: item.planUrl,
        preparedAt: new Date().toISOString(),
        outDir,
      }
    } catch (error) {
      // 单条失败不能中断整轮；状态不落盘，下轮会重试
      console.error(`  ✗ ${error.message}`)
    }
  }

  await saveState(statePath, state)

  if (values.json)
    return console.log(
      JSON.stringify(
        { prepared, skipped: skipped.map(([reason, items]) => ({ reason, items })) },
        null,
        2,
      ),
    )

  console.error(`\n✓ 准备了 ${prepared.length} 个工作包，状态记于 ${statePath}`)

  // --exec 是显式的自动化开关：不传就只准备材料，传了才把工作包交给外部命令
  if (values.exec && prepared.length) {
    console.error(`\n→ 执行 ${values.exec}`)
    for (const item of prepared) {
      console.error(`  ${item.name}`)
      try {
        const { stdout } = await execFileAsync('sh', ['-c', values.exec], {
          env: { ...process.env, WORKPACK_DIR: item.outDir, RECORD_ID: item.recordId },
          maxBuffer: 1024 * 1024 * 64,
        })
        if (stdout.trim()) console.error(`    ${stdout.trim().split('\n').slice(-3).join('\n    ')}`)
      } catch (error) {
        console.error(`    ✗ ${error.message}`)
      }
    }
  } else if (prepared.length) {
    console.error(`\n下一步：对每个工作包按 requirement-to-plan skill 产出 plan`)
    for (const item of prepared) console.error(`  ${item.outDir}/context.md`)
  }
}

export const main = async (args) => {
  const { values, positionals } = parseArgs({
    args,
    options: {
      out: { type: 'string' },
      project: { type: 'string' },
      repo: { type: 'string' },
      state: { type: 'string' },
      exec: { type: 'string' },
      'no-assets': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  })

  const [first, second] = positionals
  // 直接传 URL 时按 fetch 处理，省去每次都写子命令
  const command = first?.startsWith('http') ? 'fetch' : first
  const target = first?.startsWith('http') ? first : second

  if (values.help || !['pool', 'prepare', 'plan', 'fetch', 'watch'].includes(command)) {
    console.log(usage)
    process.exit(first ? 0 : 1)
  }

  if (command === 'pool') return runPool(values)

  if (command === 'watch') return runWatch(values)

  if (!target) {
    console.error(`✗ ${command} 需要一个参数`)
    process.exit(1)
  }

  if (command === 'plan') return runPlan(target, values)
  if (command === 'prepare') return runPrepare(target, values)
  return runFetch(target, values)
}
