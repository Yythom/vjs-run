import { useDeferredValue, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import clsx from "clsx";
import { isRuleEffective, ruleKey } from "./utils";

// 每个 RuleListItem 估算高度（px）。带按钮的项约 78，简项约 56，给个中位偏大值
// 减少二次测量。virtualizer 会按实际渲染的尺寸自动校准。
const ESTIMATED_ROW_HEIGHT = 72;

function RuleListItem({
  item,
  selected,
  toggleBusy,
  displayEnabled,
  isPending,
  onSelect,
  onToggleEnabled,
  onDelete,
}) {
  const effective = isRuleEffective(item.rule);
  const hasRule = Boolean(item.rule);

  const handleClick = () => onSelect(item);
  const handleToggle = (event) => {
    event.stopPropagation();
    if (!hasRule || toggleBusy) return;
    onToggleEnabled(item.rule, !displayEnabled);
  };
  const handleDelete = (event) => {
    event.stopPropagation();
    if (!hasRule || toggleBusy) return;
    onDelete(item.rule);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && handleClick()}
      className={clsx(
        "w-full text-left rounded-lg border px-2.5 py-2 mb-1.5 transition-colors cursor-pointer",
        selected
          ? "bg-sky-400/[0.08] border-sky-400/30"
          : "bg-card border-border hover:bg-hover",
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={clsx(
            "text-[10px] font-semibold px-1.5 py-0.5 rounded border",
            effective
              ? "text-emerald-700 bg-emerald-400/10 border-emerald-400/35"
              : hasRule
                ? "text-slate-500 bg-card border-border"
                : "text-slate-400 bg-transparent border-transparent",
          )}
        >
          {item.method}
        </span>
        <span className="text-xs text-slate-900 font-medium truncate">
          {item.path}
        </span>
        {isPending && (
          <span className="ml-auto text-[10px] text-amber-700 font-medium">
            待保存
          </span>
        )}
      </div>
      {item.summary && (
        <div className="text-[11px] text-slate-500 mt-0.5 truncate">
          {item.summary}
        </div>
      )}
      {hasRule && (
        <div className="flex items-center gap-2 mt-1.5">
          <label
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1.5 text-[11px] text-slate-700 cursor-pointer"
          >
            <input
              type="checkbox"
              checked={displayEnabled}
              onChange={handleToggle}
              disabled={toggleBusy}
              className="accent-emerald-400"
            />
            启用
          </label>
          <button
            type="button"
            onClick={handleDelete}
            disabled={toggleBusy}
            className="ml-auto text-[10px] px-1.5 py-0.5 rounded border bg-red-400/10 text-red-700 border-red-400/30 hover:bg-red-400/20 disabled:opacity-40"
          >
            删除
          </button>
        </div>
      )}
    </div>
  );
}

export default function MockRuleList({
  allItems,
  loading,
  saving,
  selectedKey,
  pendingEnabled,
  onSelectItem,
  onTogglePendingEnabled,
  onDeleteRule,
}) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [methodFilter, setMethodFilter] = useState("ALL");
  // ALL: 全部 | ENABLED: 仅已启用且生效 | UNSET: 无 mock 规则
  const [ruleFilter, setRuleFilter] = useState("ALL");

  const q = deferredQuery.trim().toLowerCase();
  const items = allItems.filter((item) => {
    if (methodFilter !== "ALL" && item.method !== methodFilter) return false;
    if (ruleFilter === "ENABLED" && !item.rule) return false;
    if (ruleFilter === "UNSET" && item.rule) return false;
    if (!q) return true;
    return [item.method, item.path, item.summary, item.source]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(q);
  });

  let mocked = 0;
  let unset = 0;
  for (const item of allItems) {
    if (item.rule) mocked += 1;
    else unset += 1;
  }
  const filterCounts = { all: allItems.length, mocked, unset };

  return (
    <aside className="min-h-0 border-r border-border flex flex-col overflow-hidden">
      <div className="p-3 border-b border-border space-y-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索 path / summary / source"
          className="w-full bg-card border border-border rounded-md px-3 py-2 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500"
        />
        <div className="flex gap-1 overflow-x-auto">
          {["ALL", "GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => (
            <button
              key={method}
              type="button"
              onClick={() => setMethodFilter(method)}
              className={clsx(
                "px-2 py-1 rounded-md border text-[11px]",
                methodFilter === method
                  ? "bg-sky-400/10 text-sky-700 border-sky-400/35"
                  : "bg-card text-slate-500 border-border hover:bg-hover hover:text-slate-900",
              )}
            >
              {method}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {[
            { id: "ALL", label: "全部", count: filterCounts.all },
            { id: "ENABLED", label: "mock-rules", count: filterCounts.mocked },
            { id: "UNSET", label: "未配置", count: filterCounts.unset },
          ].map(({ id, label, count }) => (
            <button
              key={id}
              type="button"
              onClick={() => setRuleFilter(id)}
              className={clsx(
                "px-2 py-1 rounded-md border text-[11px] flex items-center gap-1.5",
                ruleFilter === id
                  ? id === "ENABLED"
                    ? "bg-emerald-400/10 text-emerald-700 border-emerald-400/35"
                    : "bg-sky-400/10 text-sky-700 border-sky-400/35"
                  : "bg-card text-slate-500 border-border hover:bg-hover hover:text-slate-900",
              )}
            >
              <span>{label}</span>
              <span>{count}</span>
            </button>
          ))}
        </div>
      </div>

      <VirtualizedItems
        items={items}
        loading={loading}
        saving={saving}
        selectedKey={selectedKey}
        pendingEnabled={pendingEnabled}
        onSelectItem={onSelectItem}
        onTogglePendingEnabled={onTogglePendingEnabled}
        onDeleteRule={onDeleteRule}
      />
    </aside>
  );
}

/**
 * 虚拟列表：只渲染视口内 ~20 项，剩下的撑空 div 维持滚动高度。
 * 即使有几千条 OpenAPI 路由也只 mount 二十几个 DOM 节点。
 */
function VirtualizedItems({
  items,
  loading,
  saving,
  selectedKey,
  pendingEnabled,
  onSelectItem,
  onTogglePendingEnabled,
  onDeleteRule,
}) {
  const scrollRef = useRef(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 6, // 视口上下各多渲染 6 个，减少快速滚动时的白边
    getItemKey: (index) => items[index].key,
  });

  if (loading) {
    return (
      <div className="flex-1 overflow-y-auto p-2">
        <div className="p-4 text-xs text-slate-500">加载中…</div>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto p-2">
        <div className="p-4 text-xs text-slate-500">没有匹配的接口</div>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="sidebar-scroll flex-1 overflow-y-auto p-2">
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: "100%",
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const item = items[virtualRow.index];
          const k = item.rule ? ruleKey(item.rule) : null;
          const isPending = k !== null && k in pendingEnabled;
          const displayEnabled = isPending
            ? pendingEnabled[k]
            : item.rule && item.rule.enabled !== false;

          return (
            <div
              key={virtualRow.key}
              // measureElement 让 virtualizer 自动校准实际高度
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <RuleListItem
                item={item}
                selected={item.key === selectedKey}
                toggleBusy={saving}
                displayEnabled={displayEnabled}
                isPending={isPending}
                onSelect={onSelectItem}
                onToggleEnabled={onTogglePendingEnabled}
                onDelete={onDeleteRule}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
