// 工作包生成：把一条需求的全部输入材料落到一个目录里，并附上任务简报。
//
// plan 的产出需要判断（读图、提关键词、定范围），CLI 做不了；
// 但 CLI 可以把判断之前的机械活全干完，并把「接下来该做什么」写进产物 ——
// 这样接手的 agent 不依赖会话上下文，读目录就能开工。

/**
 * 任务简报：给接手的 agent 看，不是给人看的。
 *
 * 命令按实际安装位置拼成绝对路径 —— 本工具可以装在被分析仓库之外，
 * 简报里的命令必须在任意工作目录下都能直接执行。
 */
export const renderContext = (requirement, paths, roots) => {
  const { toolsRoot, repoRoot, apiSearch } = roots
  const impactScan = `node ${toolsRoot}/bin/req scan`
  const rootFlag = ` --repo ${repoRoot}`
  const lines = [
    `# 工作包: ${requirement.name}`,
    '',
    '## 需求元信息',
    '',
    requirement.recordId ? `- record_id: \`${requirement.recordId}\`` : null,
    requirement.status ? `- 状态: ${requirement.status}` : null,
    `- 业务线: ${requirement.bizLines.join(' / ') || '(未填)'}`,
    requirement.bizTokens.length
      ? `- 业务线对应仓库 token: \`${requirement.bizTokens.join('` `')}\``
      : requirement.standalone
        ? '- 业务线对应仓库 token: **未知，需从文档正文判断涉及哪几条业务线**'
        : '- 业务线对应仓库 token: (无映射，可能不是开发需求)',
    `- 方案文档: ${requirement.planUrl ?? '(无)'}`,
    `- 视觉稿: ${requirement.visualUrl ?? '(无)'}`,
    requirement.owner ? `- 实施人: ${requirement.owner}` : null,
    '',
  ].filter((line) => line !== null)

  if (requirement.purpose || requirement.goal || requirement.context) {
    lines.push('## 需求池里的描述', '')
    if (requirement.purpose) lines.push(`**目的**: ${requirement.purpose}`, '')
    if (requirement.goal) lines.push(`**目标**: ${requirement.goal}`, '')
    if (requirement.context) lines.push(`**脉络**:`, '', requirement.context, '')
  }

  lines.push(
    '## 材料',
    '',
    `- 需求正文: [\`${paths.markdown}\`](./${paths.markdown})`,
    `- 结构化: \`${paths.json}\``,
    paths.assetCount > 0
      ? `- 截图 ${paths.assetCount} 张: \`assets/\` —— **必须逐张 Read**，界面约束只存在于图里`
      : '- 无截图',
    '',
    '## 接下来',
    '',
    ...(requirement.standalone
      ? [
          '> 本工作包由文档链接直接生成，**没有需求池的结构化字段**。',
          '> 业务线需从正文推断；若该需求在需求池里有记录，改用 record_id 生成可拿到准确字段。',
          '',
        ]
      : []),
    '按本目录的 `skill.md`（工作规范，备料时渲染进来的）产出 plan，落到本目录的 `plan.md`。',
    '',
    '关键命令（业务线 token 已在上面给出）：',
    '',
    '```bash',
    '# 检索要改的现存文件（--scope 从需求提到的页面名推）',
    `${impactScan} locate "<控件文案>" --scope "<目录前缀>"${rootFlag}`,
    '',
    '# 每个命中文件都要查同名实现',
    `${impactScan} siblings "<命中的文件路径>"${rootFlag}`,
    '',
    '# 跨业务线复制时，算目标侧缺什么',
    requirement.bizTokens.length >= 2
      ? `${impactScan} mirror "<路径前缀>" --from ${requirement.bizTokens[0]} --to ${requirement.bizTokens[1]}${rootFlag}`
      : `${impactScan} mirror "<路径前缀>" --from <源业务线> --to <目标业务线>${rootFlag}`,
    // 接口检索是项目自带的工具，未配置时整段省略而不是留个跑不通的命令
    ...(apiSearch?.search
      ? ['', '# 接口对账', `${apiSearch.search} "<业务关键词>"`]
      : ['', '# 本项目未配置接口检索命令，接口对账需人工确认']),
    '```',
    '',
  )

  return lines.join('\n')
}
