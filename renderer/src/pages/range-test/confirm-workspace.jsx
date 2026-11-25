import { useFieldArray, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import useResource from "../../hooks/use-resource";
import useConfirm from "../../hooks/use-confirm";
import { showToast } from "../../utils/toast";
import { buildReplyMessage, isEmptyReply } from "../../../../src/services/range-test/prompt.js";
import { isOfflineItem } from "../../../../src/services/range-test/checklist.js";
import ChecklistMatrix from "./checklist-matrix";
import { BTN, BTN_PRIMARY, INPUT, unwrap } from "./ui";

const KIND_LABEL = { remove: "删除，原因", edit: "预期改为", question: "疑问" };

const schema = z.object({
  adjustments: z.array(z.object({ id: z.string(), kind: z.enum(["remove", "edit", "question"]), text: z.string() })),
  groups: z.array(z.string()).min(1, "至少选一个模块"),
  sites: z.array(z.string()).min(1, "至少选一个站"),
  note: z.string(),
});

function uniq(list) {
  return [...new Set(list)];
}

/** 表单值 → 主进程 buildReplyMessage 的入参。全选的模块 / 站不限定 */
function toReply(v, confirm, allGroups, allSites) {
  const of = (kind) => v.adjustments.filter((a) => a.kind === kind);
  return {
    confirm,
    removals: of("remove").map((a) => ({ id: a.id, reason: a.text })),
    edits: of("edit").map((a) => ({ id: a.id, expected: a.text })),
    questions: of("question").map((a) => ({ id: a.id, text: a.text })),
    groups: v.groups.length === allGroups.length ? null : allGroups.filter((g) => v.groups.includes(g)),
    sites: v.sites.length === allSites.length ? null : allSites.filter((s) => v.sites.includes(s)),
    note: v.note,
  };
}

function CheckCard({ dir, updatedAt }) {
  // 改动块核对要 git diff + 解析源码，慢；只在确认点算，清单一改（updatedAt 变）就重算
  const { data, loading, error } = useResource(() => unwrap(window.electronAPI.rangeTestCheck({ dir })), [dir, updatedAt]);
  const c = data?.check;
  return (
    <div className="bg-white border border-slate-200/80 rounded-xl shadow-xs p-4 text-xs flex flex-col gap-2">
      <div className="font-semibold text-slate-700">改动行 → 清单（check）</div>
      {loading && !c && <div className="text-slate-400">核对中…</div>}
      {error && <div className="text-red-600">{error.message}</div>}
      {c && (
        <>
          <div className={c.ok ? "text-emerald-700" : "text-red-600"}>
            {c.ok ? "通过" : `未通过：${c.errors.length} 个问题`} · 改动块 {c.hunks} 个 · 整块不测{" "}
            {Object.entries(c.skip).map(([k, n]) => `${k} ${n}`).join("、") || "0"} · 清单 {c.items} 条，被引用 {c.cited} 条
          </div>
          <div className="text-slate-400">分支 → 清单这一层没有数字：分支列全没有、预期对不对，是逐块人工判断的。</div>
          {[
            ["问题", c.errors, "text-red-600"],
            ["已写原因（脚本认出有行为变化、判断不用测）", c.acknowledged, "text-amber-700"],
            ["标了「—」的格", c.naCells, "text-amber-700"],
            ["提醒", c.warns, "text-slate-500"],
          ].map(([title, list, cls]) =>
            list.length ? (
              <details key={title} open={title === "问题"}>
                <summary className={`cursor-pointer ${cls}`}>
                  {title}（{list.length}）
                </summary>
                <ul className="mt-1 pl-4 list-disc text-slate-600 space-y-0.5">
                  {list.map((x) => (
                    <li key={x} className="break-words">
                      {x}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null,
          )}
        </>
      )}
    </div>
  );
}

/**
 * 确认点：看 check 结果和清单矩阵，在矩阵上点出要删、要改、要问的行，限定模块和站，
 * 然后「按调整重出清单」或「确认开测」。发出后线程进入运行中，父组件不再渲染本组件，
 * 表单随卸载清空；下次回到确认点重新挂载，是改过之后的清单。
 */
export default function ConfirmWorkspace({ dir, status, updatedAt, onSent }) {
  const allGroups = uniq(status.items.map((i) => i.group || "未分组"));
  const allSites = uniq(status.items.flatMap((i) => i.results.map((r) => r.site)));
  // 本地测不了的行：skill 要求在确认点单独列给使用者看
  const offline = status.items.filter(isOfflineItem);
  const { confirm, confirmDialog } = useConfirm();
  // 开测前查常用 dev 端口：被别的项目占着的写进补充说明，agent 会换端口、不去停它（M0 实测）
  const ports = useResource(() => unwrap(window.electronAPI.rangeTestPorts()), [dir]);

  const {
    register,
    control,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: { adjustments: [], groups: allGroups, sites: allSites, note: "" },
  });
  const { fields, append, remove } = useFieldArray({ control, name: "adjustments" });
  const values = useWatch({ control });

  const picked = new Map();
  for (const a of values.adjustments) picked.set(a.id, [...(picked.get(a.id) || []), a.kind]);

  // 模块 / 站的勾选手动维护数组：RHF 原生复选框组只有一个选项时会返回布尔值，
  // 只改了一个站的范围很常见，那样 zod 的数组校验就过不去
  const toggleIn = (name, value) => {
    const cur = values[name];
    setValue(name, cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value], { shouldValidate: true });
  };

  const onAdjust = (item, kind) => {
    const at = values.adjustments.findIndex((a) => a.id === item.id && a.kind === kind);
    if (at >= 0) remove(at);
    else append({ id: item.id, kind, text: kind === "edit" ? item.fields["预期"] || "" : "" });
  };

  const send = async (v, isConfirm) => {
    try {
      await unwrap(window.electronAPI.rangeTestReply({ dir, reply: toReply(v, isConfirm, allGroups, allSites) }));
      showToast(isConfirm ? "已确认，T3 开始实测" : "已发调整，T3 正在改清单", "success");
      onSent();
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  const onRevise = handleSubmit((v) => send(v, false));
  const onConfirm = handleSubmit(async (v) => {
    const ok = await confirm({
      title: "确认开测",
      message:
        "确认后 T3 里的 agent 会进入第二阶段：切到测试 mock 场景、起 dev server、种假的登录 cookie，再到浏览器里逐条实测。测完会恢复原场景。\n\n确定开始吗？",
      confirmText: "确认开测",
    });
    if (ok) await send(v, true);
  });

  const draft = toReply(values, true, allGroups, allSites);
  const nothingToRevise = isEmptyReply({ ...draft, confirm: false });

  return (
    <div className="flex flex-col gap-3">
      {confirmDialog}
      <CheckCard dir={dir} updatedAt={updatedAt} />

      {offline.length > 0 && (
        <div className="bg-amber-50/60 border border-amber-200 rounded-xl p-3 text-xs text-amber-800">
          本地测不了、不能拿 mock 证据打勾的行：{offline.map((i) => i.id).join("、")}
        </div>
      )}

      <ChecklistMatrix items={status.items} dir={dir} running={false} onAdjust={onAdjust} picked={picked} />

      <form className="bg-white border border-sky-200 rounded-xl shadow-xs p-4 flex flex-col gap-3 text-xs" onSubmit={(e) => e.preventDefault()}>
        <div className="font-semibold text-slate-700">回复确认点</div>

        <div className="flex flex-col gap-1.5">
          <div className="text-slate-500">测哪些模块</div>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {allGroups.map((g) => (
              <label key={g} className="flex items-center gap-1.5 text-slate-700">
                <input type="checkbox" checked={values.groups.includes(g)} onChange={() => toggleIn("groups", g)} />
                {g}
              </label>
            ))}
          </div>
          {errors.groups && <div className="text-red-600">{errors.groups.message}</div>}
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="text-slate-500">测哪些站</div>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {allSites.map((s) => (
              <label key={s} className="flex items-center gap-1.5 text-slate-700">
                <input type="checkbox" checked={values.sites.includes(s)} onChange={() => toggleIn("sites", s)} />
                {s}
              </label>
            ))}
          </div>
          {errors.sites && <div className="text-red-600">{errors.sites.message}</div>}
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="text-slate-500">逐行调整（在上面矩阵里点「删 / 改预期 / 提问」加进来）</div>
          {fields.length === 0 && <div className="text-slate-400">还没有</div>}
          {fields.map((f, i) => (
            <div key={f.id} className="flex items-start gap-2">
              <span className="font-mono font-semibold text-slate-700 w-12 shrink-0 pt-2">{f.id}</span>
              <span className="text-slate-500 w-20 shrink-0 pt-2">{KIND_LABEL[f.kind]}</span>
              <textarea rows={1} {...register(`adjustments.${i}.text`)} className={`${INPUT} resize-y`} />
              <button type="button" className={`${BTN} shrink-0`} onClick={() => remove(i)}>
                移除
              </button>
            </div>
          ))}
        </div>

        {ports.data?.note && (
          <div className="rounded-md bg-amber-50 border border-amber-200 text-amber-800 px-3 py-2 flex items-start gap-2">
            <span className="flex-1">{ports.data.note}</span>
            <button
              type="button"
              className={`${BTN} shrink-0`}
              disabled={values.note.includes(ports.data.note)}
              onClick={() =>
                setValue("note", values.note.trim() ? `${values.note.trim()}\n${ports.data.note}` : ports.data.note)
              }
            >
              加进补充说明
            </button>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <div className="text-slate-500">补充说明</div>
          <textarea rows={2} {...register("note")} className={`${INPUT} resize-y`} placeholder="选填" />
        </div>

        <details>
          <summary className="cursor-pointer text-slate-500">预览「确认开测」时发出的文字</summary>
          <pre className="mt-2 whitespace-pre-wrap bg-slate-50 border border-border rounded-md p-3 text-[11px] text-slate-700">
            {buildReplyMessage(draft)}
          </pre>
        </details>

        <div className="flex justify-end gap-2">
          <button type="button" className={BTN} disabled={isSubmitting || nothingToRevise} onClick={onRevise}>
            按调整重出清单
          </button>
          <button type="button" className={BTN_PRIMARY} disabled={isSubmitting} onClick={onConfirm}>
            {isSubmitting ? "发送中…" : "确认开测"}
          </button>
        </div>
      </form>
    </div>
  );
}
