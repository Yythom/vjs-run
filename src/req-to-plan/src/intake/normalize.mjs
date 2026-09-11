// 把飞书原始节点归一化成「树 + 资产清单 + 外链清单」。
// 这一层只做机械搬运，不做语义提取（涉及业务线、状态机等交给 agent 判断）。

// 飞书富文本里大量零宽字符会污染文本比对，统一清掉。
const ZERO_WIDTH = /[\u200b-\u200d\ufeff]/g

const clean = (text) => text.replace(ZERO_WIDTH, '').trim()

/** 把富文本元素数组拍平成纯文本，同时把其中的链接收集出来。 */
const flattenRichText = (elements = []) => {
  const links = []
  const text = elements
    .map((el) => {
      if (el.element_type === 'text') return el.text?.content ?? ''
      if (el.element_type === 'link') {
        const url = el.link?.url ?? ''
        links.push({ kind: 'link', url })
        return url
      }
      if (el.element_type === 'doc') {
        const url = el.mention_doc?.doc_url ?? ''
        links.push({ kind: 'doc', url })
        return url
      }
      return ''
    })
    .join('')

  return { text: clean(text), links }
}

/**
 * mindnote 的扁平节点数组 → 树。
 *
 * 顶层节点没有 parent_id；图片常常挂在文本为空的独立节点上，
 * 因此每个节点都记录 path（祖先文本链），让下游能还原语义位置。
 */
export const buildTree = (nodes) => {
  const childrenOf = new Map()
  for (const node of nodes) {
    const parent = node.parent_id ?? '__root'
    if (!childrenOf.has(parent)) childrenOf.set(parent, [])
    childrenOf.get(parent).push(node)
  }

  const assets = []
  const links = []

  const walk = (parentId, depth, ancestorPath) =>
    (childrenOf.get(parentId) ?? []).map((node) => {
      const body = flattenRichText(node.texts)
      const note = flattenRichText(node.notes)
      const path = body.text ? [...ancestorPath, body.text] : ancestorPath

      for (const link of [...body.links, ...note.links]) {
        links.push({ ...link, nodeId: node.node_id, path })
      }

      const images = (node.images ?? []).map((image) => {
        const asset = { token: image.token, nodeId: node.node_id, path, localPath: null }
        assets.push(asset)
        return asset
      })

      return {
        id: node.node_id,
        depth,
        text: body.text,
        note: note.text || null,
        path,
        images,
        finish: node.finish ?? false,
        highlight: node.highlight ?? null,
        children: walk(node.node_id, depth + 1, path),
      }
    })

  return { tree: walk('__root', 0, []), assets, links }
}

/** 树 → markdown，供 agent 直接阅读；图片渲染成本地相对路径，便于后续读图。 */
export const renderMarkdown = (tree, meta) => {
  const lines = [
    `# ${meta.title || '(未命名需求)'}`,
    '',
    `- 来源: ${meta.url}`,
    `- 类型: ${meta.type}`,
    `- token: ${meta.token}`,
    meta.updatedAt ? `- 最后更新: ${meta.updatedAt}` : null,
    '',
    '---',
    '',
  ].filter((line) => line !== null)

  const walk = (nodes) => {
    for (const node of nodes) {
      const indent = '  '.repeat(node.depth)
      const parts = [node.text || '(空节点)']
      if (node.note) parts.push(`【备注: ${node.note}】`)
      lines.push(`${indent}- ${parts.join(' ')}`)

      for (const image of node.images) {
        const ref = image.localPath ? `./${image.localPath}` : `(未下载: ${image.token})`
        lines.push(`${indent}  - ![图片](${ref})`)
      }

      walk(node.children)
    }
  }

  walk(tree)
  return lines.join('\n') + '\n'
}
