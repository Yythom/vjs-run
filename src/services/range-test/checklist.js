// 清单明细（coverage.mjs status --json 的 items）上的纯计算，主进程和界面共用。

// 本地测不了的行：前置里标了【测试服】【真机】【线上】。skill 要求这类行不能拿 mock 证据打勾，报告里单列
export const OFFLINE_RE = /【(测试服|真机|线上)】/;

export const isOfflineItem = (item) => OFFLINE_RE.test(Object.values(item.fields || {}).join(" "));

/** 还没测的格，按本地能不能测分开：local 是「继续测」能做的，offline 要等测试服 / 真机 / 上线 */
export function remainingCells(items) {
  const local = [];
  const offline = [];
  for (const item of items) {
    for (const r of item.results) {
      if (r.state !== "todo") continue;
      (isOfflineItem(item) ? offline : local).push(`${item.id}·${r.site}`);
    }
  }
  return { local, offline };
}

/**
 * 确认之后清单被改了什么：按编号逐列比较「前置 / 操作 / 预期 / 原来怎样」这类文字列，结果格不算
 * （结果格本来就要变）。返回 { edited: [{ id, field, before, after }], removed: [id], added: [id] }
 */
export function diffChecklist(beforeItems, afterItems) {
  const before = new Map(beforeItems.map((i) => [i.id, i]));
  const after = new Map(afterItems.map((i) => [i.id, i]));
  const edited = [];
  for (const [id, a] of after) {
    const b = before.get(id);
    if (!b) continue;
    for (const field of new Set([...Object.keys(b.fields), ...Object.keys(a.fields)])) {
      const was = b.fields[field] ?? "";
      const now = a.fields[field] ?? "";
      if (was !== now) edited.push({ id, field, before: was, after: now });
    }
  }
  return {
    edited,
    removed: [...before.keys()].filter((id) => !after.has(id)),
    added: [...after.keys()].filter((id) => !before.has(id)),
  };
}
