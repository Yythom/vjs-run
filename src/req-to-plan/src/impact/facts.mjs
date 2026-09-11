// 仓库现状扫描：把会随代码漂移的事实在运行时算出来，注入 skill。
//
// 这些数字（app 数量、孪生规模、哪些文件被复制得最多）原本写死在 skill 文档里。
// 问题不只是换仓库会错 —— 同一个仓库里它们也会随代码变化过期，
// 而 agent 会拿它们当依据判断「要改几处」。所以一律现扫现填。
import { findSiblingGroups } from './siblings.mjs'
import { buildTwinIndex, findTwinGroups } from './twins.mjs'

// 举例只是让 agent 对「什么样的文件会被复制」有直觉，不需要穷举。
const EXAMPLE_LIMIT = 6

export const collectFacts = async (repoRoot, repoConfig) => {
  const { apps, index, layout } = await buildTwinIndex(repoRoot, repoConfig.layout)
  const allFiles = [...index.entries()].flatMap(([key, owners]) =>
    owners.map((app) => `${layout.appsDir}/${app}/${key}`),
  )

  const twinGroups = findTwinGroups(index, 2)
  const siblingGroups = findSiblingGroups(allFiles, {
    genericFileNames: repoConfig.genericFileNames,
    minCount: 3,
  })

  return {
    scannedAt: new Date().toISOString(),
    project: repoConfig.name,
    apps,
    fileCount: allFiles.length,
    twinGroups,
    siblingGroups,
    maxTwinCount: twinGroups[0]?.count ?? 0,
    bizLines: repoConfig.bizLines,
  }
}

/** 渲染成注入 skill 的 markdown 片段。 */
export const renderFacts = (facts) => {
  const lines = [
    `扫描时间：${facts.scannedAt}`,
    '',
    `**应用**：${facts.apps.length} 个 —— ${facts.apps.join('、')}`,
    `**源文件**：${facts.fileCount}`,
    '',
    '### 重复规模',
    '',
    `- 跨 app 同路径孪生：**${facts.twinGroups.length} 组**，最多的一份存在于 ${facts.maxTwinCount} 个 app`,
    `- 同名不同路径的实现（≥3 份）：**${facts.siblingGroups.length} 组**`,
    '',
    '被复制得最多的文件（改一处必须同步其余）：',
    '',
  ]

  for (const group of facts.twinGroups.slice(0, EXAMPLE_LIMIT)) {
    lines.push(`- \`${group.path}\` × ${group.count}`)
  }

  lines.push('', '同名实现最多的文件名：', '')
  for (const group of facts.siblingGroups.slice(0, EXAMPLE_LIMIT)) {
    lines.push(`- \`${group.name}\` × ${group.count}`)
  }

  const lineNames = Object.keys(facts.bizLines)
  if (lineNames.length) {
    lines.push(
      '',
      '### 业务线与代码 token 对照',
      '',
      '| 业务线 | 代码里的 token | 专属路由参数 |',
      '| --- | --- | --- |',
    )

    for (const name of lineNames) {
      const { tokens = [name], param, label } = facts.bizLines[name]
      const tokenText = tokens.map((token) => `\`${token}\``).join(' / ')
      const title = label ? `${name}（${label}）` : name
      lines.push(`| ${title} | ${tokenText} | ${param ? `\`$${param}\`` : '无（用通用 `$id`）'} |`)
    }
  }

  return lines.join('\n')
}
