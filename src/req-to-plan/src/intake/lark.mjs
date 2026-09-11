// 对 lark-cli 的薄封装：统一以 user 身份调用，统一解析 JSON 响应与错误。
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// lark-cli 单次响应可能较大（整篇文档 / 全量节点），放宽 stdout 上限。
const MAX_BUFFER = 1024 * 1024 * 64

/**
 * 调用 lark-cli 并返回解析后的 data。
 *
 * lark-cli 失败时仍以 exit code 0 输出 `{ ok: false, error }`，
 * 因此不能只靠 exit code 判断，必须解析 ok 字段。
 */
export const larkCall = async (args) => {
  let stdout
  try {
    ;({ stdout } = await execFileAsync('lark-cli', [...args, '--as', 'user'], {
      maxBuffer: MAX_BUFFER,
    }))
  } catch (error) {
    // 进程级失败（命令不存在、参数非法）——stdout 里通常仍有 JSON。
    stdout = error.stdout || ''
    if (!stdout) throw new Error(`lark-cli 执行失败: ${error.message}`, { cause: error })
  }

  let payload
  try {
    payload = JSON.parse(stdout)
  } catch {
    throw new Error(`lark-cli 返回非 JSON:\n${stdout.slice(0, 500)}`)
  }

  if (!payload.ok) {
    const { type, subtype, message, missing_scopes: missingScopes } = payload.error ?? {}
    if (subtype === 'missing_scope') {
      throw new Error(
        `缺少飞书授权 scope: ${(missingScopes ?? []).join(', ')}\n` +
          `补授权: lark-cli auth login --scope "${(missingScopes ?? []).join(' ')}" --no-wait --json`,
      )
    }
    throw new Error(`lark-cli ${type}/${subtype}: ${message}`)
  }

  return payload.data
}

/**
 * 把飞书 URL 解析成真实资源。
 *
 * /wiki/ 链接里的 token 是 wiki node_token，不是底层文档 token，
 * 必须先经 wiki +node-get 解包；直链（/docx/ 等）则自身就是 obj_token。
 */
export const resolveDoc = async (url) => {
  if (/\/wiki\//.test(url)) {
    const node = await larkCall(['wiki', '+node-get', '--node-token', url])
    return {
      token: node.obj_token,
      type: node.obj_type,
      title: node.title,
      updatedAt: node.updated_at,
      wikiToken: node.node_token,
    }
  }

  const match = url.match(/\/(docx|docs|mindnotes?|base)\/([A-Za-z0-9]+)/)
  if (!match) throw new Error(`无法从 URL 解析资源 token: ${url}`)

  const [, path, token] = match
  return {
    token,
    type: path === 'docs' ? 'docx' : path === 'mindnotes' ? 'mindnote' : path,
    title: '',
    updatedAt: '',
  }
}

/** 读取思维笔记的全部节点（扁平数组，靠 parent_id 建树）。 */
export const fetchMindnote = (token) =>
  larkCall(['mindnotes', 'nodes', 'list', '--mindnote-id', token]).then((d) => d.nodes ?? [])

/** 读取 docx 正文（markdown 形态，便于 agent 直接消费）。 */
export const fetchDocx = (token) =>
  larkCall(['docs', '+fetch', '--doc', token, '--doc-format', 'markdown'])

/** 下载素材到本地；lark-cli 按 content-type 自动补扩展名，返回真实落盘路径。 */
export const downloadMedia = async (token, outputBase) => {
  const data = await larkCall([
    'docs',
    '+media-download',
    '--token',
    token,
    '--output',
    outputBase,
    '--overwrite',
  ])
  return data.saved_path
}
