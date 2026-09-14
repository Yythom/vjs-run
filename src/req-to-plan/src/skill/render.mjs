// 工作规范（SKILL.md + plan 模板）的渲染。
//
// 原来这段逻辑长在 runPlan 里，只有「备料完立刻调 claude」这一条路径能用到。
// 抽出来之后 prepare 阶段就把渲染结果写进工作包（skill.md），工作包因此变成
// 真正自包含的：谁接手都行——req plan 自己、AI 工单台的无头 agent、或者人手动开一个
// 会话——读目录就能拿到同一份规范，不必再知道 req-to-plan 装在哪。
//
// 代价是 $REPO_FACTS 变成「备料时刻的快照」而不是「产 plan 时刻」。仓库事实
// （app 数、孪生规模）以周为单位漂移，备料到派活之间通常是分钟到小时，可以接受；
// 真要最新的重跑一次 prepare 即可（扫描约 70ms）。
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { collectFacts, renderFacts } from '../impact/facts.mjs'
import { expandVars, packageRoot } from '../config.mjs'

/** 把 skill 里的占位变量换成本次运行的实际值。 */
const fillPlaceholders = (text, vars) =>
  Object.entries(vars).reduce((acc, [key, value]) => acc.split(key).join(value), text)

/** 规则文件的位置随项目而异，从项目配置取，不写死具体文件名。 */
export const describeRules = (rules) =>
  rules
    ? [rules.entry, rules.dir ? `${rules.dir}/*` : null].filter(Boolean).join(' 与 ') +
      (rules.note ? `（${rules.note}）` : '')
    : '（本项目未配置规则文件）'

/**
 * 渲染完整的工作规范文本（skill + plan 模板，占位符已填）。
 *
 * 返回 { text, facts, rulesText }：facts 与 rulesText 调用方还要用来打日志、
 * 拼硬性要求，就一并给出去，免得外面再扫一次仓库。
 */
export const renderSkill = async ({ projectDir, repoConfig, repoRoot, workpackDir }) => {
  const facts = await collectFacts(repoRoot, repoConfig)

  const apiSearch = repoConfig.apiSearch
    ? {
        search: expandVars(repoConfig.apiSearch.search ?? '', { repoRoot }),
        detail: expandVars(repoConfig.apiSearch.detail ?? '', { repoRoot }),
      }
    : null

  const notes = await readFile(resolve(projectDir, 'notes.md'), 'utf8').catch(() => null)
  const rulesText = describeRules(repoConfig.rules)

  const vars = {
    $REQ_BIN: `node ${packageRoot}/bin/req`,
    $REPO_ROOT: repoRoot,
    $WORKPACK: workpackDir,
    $REPO_FACTS: renderFacts(facts),
    $API_SEARCH: apiSearch?.search ?? '（本项目未配置接口检索命令，接口对账需人工确认）',
    $API_DETAIL: apiSearch?.detail ?? '（同上）',
    $RULES_FILES: rulesText,
    $PROJECT_NOTES: notes ?? '（本项目暂无经验记录）',
  }

  const [skill, template] = await Promise.all([
    readFile(`${packageRoot}/src/skill/SKILL.md`, 'utf8'),
    readFile(`${packageRoot}/src/skill/plan-template.md`, 'utf8'),
  ])

  const text = [
    '以下是本次任务必须遵循的工作规范（需求 → 实施 plan）。',
    '',
    fillPlaceholders(skill, vars),
    '',
    '---',
    '',
    '## plan 模板',
    '',
    '产出的 plan 按以下模板组织：',
    '',
    fillPlaceholders(template, vars),
  ].join('\n')

  return { text, facts, rulesText }
}
