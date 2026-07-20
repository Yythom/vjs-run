import { useDeferredValue, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import clsx from "clsx";
import { isRuleEffective, ruleKey } from "./utils";

// 每个 RuleListItem 估算高度（px）。带按钮的项约 78，简项约 56，给个中位偏大值
// 减少二次测量。virtualizer 会按实际渲染的尺寸自动校准。
const ESTIMATED_ROW_HEIGHT = 72;

/** 受控开关：语义等价于 checkbox，但视觉是滑块 */
function Switch({ checked, disabled, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={clsx(
        "relative inline-flex h-[14px] w-[26px] shrink-0 items-center rounded-full border transition-colors disabled:opacity-40",
        checked
          ? "bg-emerald-400/80 border-emerald-500/40"
          : "bg-slate-300 border-slate-400/30",
      )}
    >
      <span
        className={clsx(
          "inline-block h-[10px] w-[10px] rounded-full bg-white shadow-sm transition-transform",
          checked ? "translate-x-[13px]" : "translate-x-[2px]",
        )}
      />
    </button>
  );
}

function RuleListItem({
  item,
  selected,
  toggleBusy,
  displayEnabled,
  selectable,
  checked,
  onToggleChecked,
  onSelect,
  onToggleEnabled,
  onDelete,
}) {
  const effective = isRuleEffective(item.rule);
  const hasRule = Boolean(item.rule);

  const handleClick = () => onSelect(item);
  const handleToggle = () => {
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
        {selectable && (
          <input
            type="checkbox"
            checked={checked}
            onClick={(e) => e.stopPropagation()}
            onChange={() => onToggleChecked(item.rule)}
            aria-label={`选择 ${item.method} ${item.path}`}
            className="accent-sky-500 shrink-0"
          />
        )}
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
        {Array.isArray(item.rule?.variants) &&
          item.rule.variants.length > 0 && (
            <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border text-violet-700 bg-violet-400/10 border-violet-400/35">
              {item.rule.variants.length} 变体
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
          <span
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1.5 text-[11px] text-slate-700"
          >
            <Switch
              checked={displayEnabled}
              disabled={toggleBusy}
              onChange={handleToggle}
              label="启用"
            />
            启用
          </span>
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

/**
 * 批量操作条：在「已配置/已停用/有变体」这些规则子集视图下出现。全选勾选框
 * 覆盖当前筛选出的规则（同时受搜索框和 method 筛选影响），操作只作用于已勾选的规则。
 */
function BulkActions({
  rules,
  selectedRules,
  disabled,
  allChecked,
  someChecked,
  onToggleAll,
  onClearSelection,
  onSetEnabled,
  onDelete,
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const allRef = useRef(null);

  // indeterminate 只能用 DOM 属性设置，JSX 没有对应的受控 prop
  useEffect(() => {
    if (allRef.current)
      allRef.current.indeterminate = someChecked && !allChecked;
  }, [someChecked, allChecked]);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event) => {
      if (!wrapRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // 操作没落盘（保存失败 / 用户取消确认）时保留勾选，方便重试
  const run = async (action) => {
    setOpen(false);
    if (await action()) onClearSelection();
  };

  const actions = [
    {
      label: "启用",
      className: "text-emerald-700 hover:bg-emerald-400/10",
      onClick: () => onSetEnabled(selectedRules, true),
    },
    {
      label: "停用",
      className: "text-amber-700 hover:bg-amber-400/10",
      onClick: () => onSetEnabled(selectedRules, false),
    },
    {
      label: "删除",
      className: "text-red-700 hover:bg-red-400/10",
      onClick: () => onDelete(selectedRules),
    },
  ];

  const count = selectedRules.length;

  return (
    <div className="flex items-center gap-2">
      <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-500 cursor-pointer shrink-0">
        <input
          ref={allRef}
          type="checkbox"
          checked={allChecked}
          disabled={disabled || rules.length === 0}
          onChange={onToggleAll}
          className="accent-sky-500"
        />
        全选
      </label>
      <span className="text-[11px] text-slate-400 truncate">
        {count > 0
          ? `已选 ${count} / ${rules.length}`
          : `共 ${rules.length} 条`}
      </span>

      <div ref={wrapRef} className="relative ml-auto shrink-0">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          disabled={disabled || count === 0}
          title={
            count === 0 ? "请先勾选要操作的规则" : "对已勾选的规则批量操作"
          }
          className={clsx(
            "px-2 py-1 rounded-md border text-[11px] flex items-center gap-1 disabled:opacity-40",
            open
              ? "bg-sky-400/10 text-sky-700 border-sky-400/35"
              : "bg-card text-slate-500 border-border hover:bg-hover hover:text-slate-900",
          )}
        >
          批量操作
          <span className="text-[9px] leading-none">{open ? "▲" : "▼"}</span>
        </button>
        {open && (
          <div className="absolute z-10 top-full right-0 mt-1 w-max rounded-md border border-border bg-card shadow-lg overflow-hidden flex flex-col gap-1">
            {actions.map(({ label, className, onClick }) => (
              <button
                key={label}
                type="button"
                onClick={() => run(onClick)}
                className={clsx(
                  "w-max px-2.5 py-1.5 font-medium  cursor-pointer",
                  className,
                )}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function MockRuleList({
  allItems,
  loading,
  saving,
  selectedKey,
  onSelectItem,
  onToggleEnabled,
  onDeleteRule,
  onBulkSetEnabled,
  onBulkDelete,
}) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [methodFilter, setMethodFilter] = useState("ALL");
  // ALL: 全部 | ENABLED: 已配置（有规则）| DISABLED: 已停用 | VARIANTS: 有变体 | UNSET: 无规则
  const [ruleFilter, setRuleFilter] = useState("ALL");
  // 批量操作勾选的规则 key，仅在「有规则」的子集视图（已配置/已停用/有变体）下可用
  const [checkedKeys, setCheckedKeys] = useState(() => new Set());

  const clearSelection = () => setCheckedKeys(new Set());
  const switchRuleFilter = (id) => {
    setRuleFilter(id);
    clearSelection();
  };

  const q = deferredQuery.trim().toLowerCase();
  const items = allItems.filter((item) => {
    if (methodFilter !== "ALL" && item.method !== methodFilter) return false;
    if (ruleFilter === "ENABLED" && !item.rule) return false;
    if (ruleFilter === "DISABLED" && !(item.rule && item.rule.enabled === false))
      return false;
    if (ruleFilter === "VARIANTS" && !item.rule?.variants?.length) return false;
    if (ruleFilter === "UNSET" && item.rule) return false;
    if (!q) return true;
    return [item.method, item.path, item.summary, item.source]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(q);
  });

  // 「已配置/已停用/有变体」都是规则子集视图，批量操作均可用
  //（比如：切到已停用 → 全选 → 批量删除，一步清理）
  const selectable = ["ENABLED", "DISABLED", "VARIANTS"].includes(ruleFilter);
  // 勾选只对「当前筛选出的规则」有意义：改筛选/搜索后落到范围外的 key 直接忽略，
  // 不用在 effect 里同步 checkedKeys。
  const filteredRules = selectable
    ? items.map((item) => item.rule).filter(Boolean)
    : [];
  const selectedRules = filteredRules.filter((rule) =>
    checkedKeys.has(ruleKey(rule)),
  );
  const allChecked =
    filteredRules.length > 0 && selectedRules.length === filteredRules.length;

  const toggleChecked = (rule) => {
    const key = ruleKey(rule);
    const next = new Set(checkedKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setCheckedKeys(next);
  };

  const toggleAll = () =>
    setCheckedKeys(
      allChecked ? new Set() : new Set(filteredRules.map(ruleKey)),
    );

  let mocked = 0;
  let disabled = 0;
  let variants = 0;
  let unset = 0;
  for (const item of allItems) {
    if (item.rule) {
      mocked += 1;
      if (item.rule.enabled === false) disabled += 1;
      if (item.rule.variants?.length) variants += 1;
    } else {
      unset += 1;
    }
  }
  const filterCounts = { all: allItems.length, mocked, disabled, variants, unset };

  return (
    <aside className="min-h-0 border-r border-border flex flex-col overflow-hidden">
      {/* 列表已占满整页宽：筛选控件横向排开，宽度不够时自动换行 */}
      <div className="p-3 border-b border-border  gap-x-3 gap-y-2">
        <div className="flex gap-2 items-center">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索 path / summary / source"
            className="flex-1 min-w-[200px] max-w-[360px] bg-card border border-border rounded-md px-3 py-2 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500"
          />
          <div className="flex gap-1 shrink-0">
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
        </div>
        <div className="flex gap-1 shrink-0 mt-2">
          {[
            { id: "ALL", label: "全部", count: filterCounts.all },
            { id: "ENABLED", label: "已配置", count: filterCounts.mocked },
            { id: "DISABLED", label: "已停用", count: filterCounts.disabled },
            { id: "VARIANTS", label: "有变体", count: filterCounts.variants },
            { id: "UNSET", label: "未配置", count: filterCounts.unset },
          ].map(({ id, label, count }) => (
            <button
              key={id}
              type="button"
              onClick={() => switchRuleFilter(id)}
              className={clsx(
                "px-2 py-1 rounded-md border text-[11px] flex items-center gap-1.5",
                ruleFilter === id
                  ? {
                      ENABLED:
                        "bg-emerald-400/10 text-emerald-700 border-emerald-400/35",
                      DISABLED:
                        "bg-amber-400/10 text-amber-700 border-amber-400/35",
                      VARIANTS:
                        "bg-violet-400/10 text-violet-700 border-violet-400/35",
                    }[id] || "bg-sky-400/10 text-sky-700 border-sky-400/35"
                  : "bg-card text-slate-500 border-border hover:bg-hover hover:text-slate-900",
              )}
            >
              <span>{label}</span>
              <span>{count}</span>
            </button>
          ))}
        </div>
        {selectable && (
          <div className="ml-auto min-w-[220px]">
            <BulkActions
              rules={filteredRules}
              selectedRules={selectedRules}
              disabled={loading || saving}
              allChecked={allChecked}
              someChecked={selectedRules.length > 0}
              onToggleAll={toggleAll}
              onClearSelection={clearSelection}
              onSetEnabled={onBulkSetEnabled}
              onDelete={onBulkDelete}
            />
          </div>
        )}
      </div>

      <VirtualizedItems
        items={items}
        loading={loading}
        saving={saving}
        selectedKey={selectedKey}
        selectable={selectable}
        checkedKeys={checkedKeys}
        onToggleChecked={toggleChecked}
        onSelectItem={onSelectItem}
        onToggleEnabled={onToggleEnabled}
        onDeleteRule={onDeleteRule}
      />
    </aside>
  );
}

// 列表卡片的目标宽度（px），容器宽度 / 目标宽度 → 列数（1~4 列自适应）
const TARGET_CARD_WIDTH = 360;

/**
 * 虚拟列表：只渲染视口内的行，剩下的撑空 div 维持滚动高度。
 * 列表占满整页宽后按容器宽度自适应 1~4 列：虚拟化按「行」进行，
 * 每个虚拟行渲染 columns 张卡片。即使几千条路由也只 mount 几十个 DOM 节点。
 */
function VirtualizedItems({
  items,
  loading,
  saving,
  selectedKey,
  selectable,
  checkedKeys,
  onToggleChecked,
  onSelectItem,
  onToggleEnabled,
  onDeleteRule,
}) {
  const scrollRef = useRef(null);
  const [columns, setColumns] = useState(1);

  // 容器宽度变化（拖窗口）时重算列数
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const width = el.clientWidth;
      setColumns(
        Math.max(1, Math.min(4, Math.floor(width / TARGET_CARD_WIDTH))),
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const rowCount = Math.ceil(items.length / columns);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 6, // 视口上下各多渲染 6 行，减少快速滚动时的白边
    getItemKey: (index) => items[index * columns].key,
  });

  // 仅首屏（尚无数据）显示整屏「加载中」；开关 / 保存后的 reload 不闪整屏，
  // 保留列表，避免每次即时保存都把列表清空重绘。
  if (loading && items.length === 0) {
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
          // 一个虚拟行 = columns 张卡片
          const rowItems = items.slice(
            virtualRow.index * columns,
            virtualRow.index * columns + columns,
          );

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
                display: "grid",
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                columnGap: "6px",
              }}
            >
              {rowItems.map((item) => (
                <RuleListItem
                  key={item.key}
                  item={item}
                  selected={item.key === selectedKey}
                  toggleBusy={saving}
                  displayEnabled={item.rule && item.rule.enabled !== false}
                  selectable={selectable && Boolean(item.rule)}
                  checked={
                    Boolean(item.rule) && checkedKeys.has(ruleKey(item.rule))
                  }
                  onToggleChecked={onToggleChecked}
                  onSelect={onSelectItem}
                  onToggleEnabled={onToggleEnabled}
                  onDelete={onDeleteRule}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
