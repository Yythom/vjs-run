// 业务线：概念名 → 代码里实际用的路径 token。
//
// 二者往往不是一一对应。一条业务线在代码里可能长期使用别名
// （例如「服务」线的目录写作 service 或 demand，「案例」线写作 case 或 idea），
// 直接拿业务线名去匹配路径会大面积漏掉。因此每条线带一组 token：
// 第一个是主 token（生成目标路径时用），其余是探测别名。
//
// param 是该业务线专属的路由参数缩写。它来自仓库实测而非约定 ——
// 多数路由用通用的 $id，只有少数线有专属缩写，没有就配 null，不要臆测补全。
//
// 具体取值来自项目配置（<项目>/repo.config.json 的 bizLines），本模块不含任何
// 项目专有知识。

// token 必须落在路径分隔处，避免 useCase / lowercase 这类驼峰词误命中。
const tokenPattern = (token) => new RegExp(`(^|[./_-])${token}s?($|[./_-])`, 'i')

/**
 * 用项目配置构造业务线工具集。
 *
 * 配置形如 { video: { tokens: ['video'], param: 'vid' }, ... }。
 */
export const createBizLines = (config = {}) => {
  const names = Object.keys(config)

  const tokensOf = (line) => config[line]?.tokens ?? [line]
  const mainToken = (line) => tokensOf(line)[0]
  const paramOf = (line) => config[line]?.param ?? null
  const labelOf = (line) => config[line]?.label ?? line

  /**
   * 路径里出现的所有业务线（按别名匹配，去重）。
   *
   * 别名不可避免带来少量误标：短 token 如 `case` 在 `use-search-case-file-state.ts`
   * 里其实是「用例」。本函数只用于展示标注，不参与过滤或判定，
   * 误标一条业务线不影响结论，因此不为此再加白名单。
   */
  const detectBizLines = (path) =>
    names.filter((line) => tokensOf(line).some((token) => tokenPattern(token).test(path)))

  return { names, config, tokensOf, mainToken, paramOf, labelOf, detectBizLines, tokenPattern }
}
