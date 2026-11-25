import { useState } from "react";
import useResource from "../../hooks/use-resource";
import { INPUT, unwrap } from "./ui";

const MANUAL = "__manual__";

/**
 * 选 T3 的 provider 和模型。列表从 T3 本机的设置和模型清单只读得来（主进程 range-test-models）；
 * 读不到、或者想用列表里没有的模型时手填。
 *
 * 受控组件：value = { provider, model }，onChange 给出新的一对。选中的模型不在列表里时自动显示手填框。
 */
export default function ModelPicker({ value, onChange, disabled }) {
  const { data, error } = useResource(() => unwrap(window.electronAPI.rangeTestModels()), []);
  // 用户主动点了「其他（手填）」；模型本来就不在列表里时不需要这个标记，手填框自然会出现
  const [manualPicked, setManualPicked] = useState(false);

  const providers = data?.providers || [];
  const listError = error?.message || data?.error || "";
  const current = providers.find((p) => p.id === value.provider);
  const models = current?.models || [];
  const inList = models.some((m) => m.slug === value.model);
  const manual = manualPicked || !inList;

  // 列表读不到：退回两个文本框
  if (!providers.length) {
    return (
      <div className="flex flex-col gap-1.5">
        <div className="grid grid-cols-[160px_1fr] gap-2">
          <input
            className={INPUT}
            placeholder="provider 实例 id"
            value={value.provider}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, provider: e.target.value })}
          />
          <input
            className={INPUT}
            placeholder="模型 slug"
            value={value.model}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, model: e.target.value })}
          />
        </div>
        {listError && <div className="text-[11px] text-amber-700">读不到 T3 的模型列表，只能手填：{listError}</div>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-[160px_1fr] gap-2">
        <select
          className={INPUT}
          value={current ? value.provider : ""}
          disabled={disabled}
          onChange={(e) => {
            const next = providers.find((p) => p.id === e.target.value);
            setManualPicked(false);
            onChange({ provider: e.target.value, model: next?.models[0]?.slug || "" });
          }}
        >
          {!current && <option value="">{value.provider ? `${value.provider}（T3 里没有）` : "选 provider"}</option>}
          {providers.map((p) => (
            <option key={p.id} value={p.id} disabled={!p.enabled}>
              {p.name}
              {p.name !== p.id ? `（${p.id}）` : ""}
              {p.enabled ? "" : " · 未启用"}
            </option>
          ))}
        </select>
        <select
          className={INPUT}
          value={manual ? MANUAL : value.model}
          disabled={disabled || !current}
          onChange={(e) => {
            if (e.target.value === MANUAL) {
              setManualPicked(true);
              return;
            }
            setManualPicked(false);
            onChange({ ...value, model: e.target.value });
          }}
        >
          {models.map((m) => (
            <option key={m.slug} value={m.slug}>
              {m.name === m.slug ? m.slug : `${m.name}（${m.slug}）`}
            </option>
          ))}
          <option value={MANUAL}>其他（手填）</option>
        </select>
      </div>
      {manual && current && (
        <input
          className={INPUT}
          placeholder="模型 slug，如 commandcode/deepseek/deepseek-v4.1-flash-fast[1m]"
          value={value.model}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, model: e.target.value })}
        />
      )}
      {current && (
        <div className="text-[11px] text-slate-400">
          {current.loadsClaudeSkills
            ? "这类 provider 会自动加载 ~/.claude/skills，commit-range-test 能直接用（magpie 实测过）。"
            : `driver 是 ${current.driver || "未知"}，没实测过它能不能用 commit-range-test。`}
          列表里的模型不一定在你的套餐里，跑不了会在线程卡片上看到原因。
        </div>
      )}
    </div>
  );
}
