// 需求池轮询：找出新进入「排实施」的需求，为每条准备工作包。
//
// 触发依据是 【进程】 字段的流转，而不是需求文档的更新时间 ——
// 状态流转是人显式做的动作，定稿前文档怎么改都不会误触发。
//
// 默认只准备工作包，不自动执行任何东西。要接自动实施时用 --exec 传入命令，
// 由使用者显式决定风险边界。
import { readFile, writeFile } from 'node:fs/promises'

/** 状态文件记录每条需求上次见到的状态，用于识别「新流转进来的」。 */
export const loadState = async (path) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return { processed: {} }
  }
}

export const saveState = (path, state) => writeFile(path, JSON.stringify(state, null, 2))

/**
 * 挑出需要处理的需求。
 *
 * 从未见过的算新；见过的只有在状态或方案链接变化时才重新处理 ——
 * 后者覆盖「本来缺链接、后来补上了」这种情况。
 *
 * 被分诊挡掉的需求同样要落进 state，否则每轮都会重新报一遍。
 */
export const pickNew = (ready, state) =>
  ready.filter((item) => {
    const seen = state.processed[item.recordId]
    if (!seen) return true
    return seen.status !== item.status || seen.planUrl !== item.planUrl
  })

/** 没有方案链接就无法生成工作包，单独挑出来提示人补。 */
export const splitByReadiness = (items) => ({
  actionable: items.filter((item) => item.planUrl),
  blocked: items.filter((item) => !item.planUrl),
})

// 备料前的分诊闸门。
//
// 以下三类在真实需求池里各占一定比例，且全都能在读文档之前判掉，
// 不必等 lark-cli 报错或让 agent 面对一份不相干的文档：
//   - 非开发需求（招聘、流程类）：业务线填「不涉及业务线」
//   - 方案链接填错：链接栏放的是 MasterGo 视觉稿而非飞书文档
//   - 一份文档挂多条需求：agent 无法判断该做其中哪一条
const FEISHU_HOST = /(feishu\.cn|larksuite\.com|larkoffice\.com)/
const NOT_A_DEV_LINE = "不涉及业务线"

export const triage = (items) => {
  const byPlanUrl = new Map()
  for (const item of items) {
    if (!item.planUrl) continue
    if (!byPlanUrl.has(item.planUrl)) byPlanUrl.set(item.planUrl, [])
    byPlanUrl.get(item.planUrl).push(item.name)
  }

  const buckets = {
    actionable: [],
    notDev: [],
    needsReview: [],
    missingPlan: [],
    badLink: [],
    shared: [],
  }

  for (const item of items) {
    // 「不涉及业务线」是明确的非开发需求；「其他」只是没归到五条线上，
    // 可能仍要改代码（例如提现、媒资工具），交人判断而不是直接丢掉。
    if (item.bizLines.includes(NOT_A_DEV_LINE)) {
      buckets.notDev.push(item)
      continue
    }
    if (item.bizTokens.length === 0) {
      buckets.needsReview.push(item)
      continue
    }
    if (!item.planUrl) {
      buckets.missingPlan.push(item)
      continue
    }
    if (!FEISHU_HOST.test(item.planUrl)) {
      buckets.badLink.push(item)
      continue
    }

    // 文档复用不阻断处理，但要带着共用者名单进工作包，供 agent 定位段落
    const sharedWith = (byPlanUrl.get(item.planUrl) ?? []).filter((name) => name !== item.name)
    if (sharedWith.length) {
      buckets.shared.push({ ...item, sharedWith })
      buckets.actionable.push({ ...item, sharedWith })
      continue
    }

    buckets.actionable.push(item)
  }

  return buckets
}
