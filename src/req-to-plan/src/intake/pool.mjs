// 需求池读取：从飞书多维表格里取出「已定稿、等待开发」的需求。
//
// 触发点选在 【进程】 字段流转到「排实施」，而不是需求文档更新——
// 状态流转是人显式做的动作，文档在此之前可以随便改，不会误触发。
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_BUFFER = 1024 * 1024 * 64

export const loadConfig = async (path) => JSON.parse(await readFile(path, 'utf8'))

/**
 * Base 单元格的取值形态随字段类型而变（纯文本、富文本片段数组、
 * 多选数组、人员对象数组），这里统一压成字符串或字符串数组。
 */
const cellText = (value) => {
  if (value == null) return null
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts = value.map((item) =>
      typeof item === 'string' ? item : (item?.text ?? item?.name ?? ''),
    )
    return parts.join('').trim() || null
  }
  return value?.text ?? value?.name ?? null
}

const cellList = (value) =>
  Array.isArray(value)
    ? value.map((item) => (typeof item === 'string' ? item : (item?.text ?? item?.name ?? ''))).filter(Boolean)
    : []

// 链接类字段在 Base 里存成 markdown，且常带一段“邀请您协作”的尾巴。
const extractUrl = (text) => {
  if (!text) return null
  const markdown = text.match(/\((https?:\/\/[^\s)]+)\)/)
  if (markdown) return markdown[1]
  const bare = text.match(/https?:\/\/\S+/)
  return bare ? bare[0] : null
}

/** 用 ndjson 落盘再读，避免整表记录穿过命令行缓冲。 */
export const fetchPoolRecords = async (config, outFile) => {
  const fieldNames = Object.values(config.fields)
  const args = [
    'base',
    '+record-list',
    '--base-token',
    config.baseToken,
    '--table-id',
    config.tableId,
    ...fieldNames.flatMap((name) => ['--field-id', name]),
    '--as',
    'user',
    '--format',
    'ndjson',
    '--output',
    outFile,
    '--overwrite',
  ]

  await execFileAsync('lark-cli', args, { maxBuffer: MAX_BUFFER })
  const raw = await readFile(outFile, 'utf8')
  return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

/** 把原始记录整理成下游可直接消费的需求条目。 */
export const toRequirement = (record, config) => {
  const { fields, bizLineMap } = config
  const bizLines = cellList(record[fields.bizLines])

  return {
    recordId: record.record_id,
    name: cellText(record[fields.name]),
    status: cellText(record[fields.status]),
    bizLines,
    // 业务线中文名直接映射成仓库里的目录 token，供 impact-scan mirror 使用
    bizTokens: bizLines.map((line) => bizLineMap[line]).filter(Boolean),
    planUrl: extractUrl(cellText(record[fields.planLink])),
    visualUrl: extractUrl(cellText(record[fields.visualLink])),
    purpose: cellText(record[fields.purpose]),
    goal: cellText(record[fields.goal]),
    context: cellText(record[fields.context]),
    owner: cellText(record[fields.owner]),
  }
}

/** 取出处于就绪状态、且带方案链接的需求——两者缺一都无法进入下一步。 */
export const selectReady = (records, config) =>
  records
    .map((record) => toRequirement(record, config))
    .filter((item) => item.status === config.readyStatus)
