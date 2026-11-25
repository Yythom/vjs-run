import { useNavigate } from "react-router";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import Modal from "../../components/modal";
import useResource from "../../hooks/use-resource";
import { useCloseModal } from "../../hooks/use-modal-nav";
import { useAppConfig } from "../../stores/app-config-store";
import { showToast } from "../../utils/toast";
import ModelPicker from "./model-picker";
import { BTN, BTN_PRIMARY, INPUT, unwrap } from "./ui";

const schema = z
  .object({
    repoKey: z.string().min(1, "先选仓库"),
    rangeKind: z.enum(["ahead", "recent", "custom"]),
    recentCount: z.coerce.number().int().min(1, "至少 1 个").max(200, "一次最多 200 个"),
    from: z.string(),
    to: z.string(),
    topic: z.string().max(60, "主题太长了"),
    provider: z.string().trim().min(1, "选 T3 的 provider"),
    model: z.string().trim().min(1, "选模型"),
  })
  .superRefine((v, ctx) => {
    if (v.rangeKind !== "custom") return;
    if (!v.from) ctx.addIssue({ code: "custom", path: ["from"], message: "选起点提交" });
    if (!v.to) ctx.addIssue({ code: "custom", path: ["to"], message: "选终点提交" });
  });

function FieldError({ message }) {
  return message ? <div className="text-[11px] text-red-600">{message}</div> : null;
}

const commitLabel = (c) => `${c.short} · ${c.date} · ${c.author} · ${c.subject}`;

function today() {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/** 主题留空时按范围起个名字；同名目录已存在时主进程会报错，让使用者改 */
function autoTopic(v, cand, commits) {
  if (v.rangeKind === "ahead") return `${cand?.branch || "分支"}-领先${cand?.ahead?.count ?? ""}个-${today()}`;
  if (v.rangeKind === "recent") return `最近${v.recentCount}个提交-${today()}`;
  const short = (sha) => commits.find((c) => c.sha === sha)?.short || sha.slice(0, 7);
  return `${short(v.from)}..${short(v.to)}`;
}

/**
 * 新建改动测试：选仓库和范围，派给 T3。范围在这里定死，agent 第 1 步就不会再问。
 * 弹框是 route 组件，每次打开重新挂载，表单自然是初始值。
 */
export default function NewRunModal() {
  const close = useCloseModal();
  const navigate = useNavigate();
  const appConfig = useAppConfig();
  const repos = appConfig.frontendProjectGroups || [];
  const { provider, model } = appConfig.rangeTest || {};

  const {
    register,
    control,
    handleSubmit,
    setValue,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: {
      repoKey: repos[0]?.key || "",
      rangeKind: "recent",
      recentCount: 5,
      from: "",
      to: "",
      topic: "",
      // 默认取「T3 设置」，这次可以单独改
      provider: provider || "",
      model: model || "",
    },
  });
  const values = useWatch({ control });

  const candidates = useResource(
    () => (values.repoKey ? unwrap(window.electronAPI.rangeTestCandidates({ repoKey: values.repoKey })) : null),
    [values.repoKey],
  );
  const cand = candidates.data;
  const commits = cand?.commits || [];
  const aheadCount = cand?.ahead?.count ?? 0;

  const onSubmit = async (v) => {
    const range =
      v.rangeKind === "recent"
        ? { kind: "recent", count: v.recentCount }
        : v.rangeKind === "custom"
          ? { kind: "custom", from: v.from, to: v.to }
          : { kind: "ahead" };
    try {
      const res = await unwrap(
        window.electronAPI.rangeTestStart({
          repoKey: v.repoKey,
          range,
          topic: v.topic.trim() || autoTopic(v, cand, commits),
          provider: v.provider.trim(),
          model: v.model.trim(),
        }),
      );
      showToast("已派给 T3，正在出清单", "success");
      navigate(`/range-test/run?dir=${encodeURIComponent(res.dir)}`, { replace: true });
    } catch (err) {
      setError("root", { message: err.message });
    }
  };

  return (
    <Modal open onClose={isSubmitting ? undefined : close} title="新建改动测试" srOnly={false} className="w-[640px] max-w-[94vw] max-h-[90vh]">
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col min-h-0">
        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-600">仓库</label>
            <select {...register("repoKey")} className={INPUT}>
              {repos.length === 0 && <option value="">先在「项目管理」里添加仓库</option>}
              {repos.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}（{r.path}）
                </option>
              ))}
            </select>
            <FieldError message={errors.repoKey?.message} />
            {candidates.loading && <div className="text-[11px] text-slate-400">正在 git fetch、读提交列表…</div>}
            {candidates.error && <div className="text-[11px] text-red-600">{candidates.error.message}</div>}
            {cand && (
              <div className="text-[11px] text-slate-500">
                当前分支 <span className="font-mono">{cand.branch}</span>
                {cand.fetchError && <span className="text-amber-600">（fetch 失败，用的是本地已有的远端分支：{cand.fetchError}）</span>}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-xs font-medium text-slate-600">范围</label>
            <label className="flex items-center gap-2 text-xs text-slate-700">
              <input type="radio" value="ahead" {...register("rangeKind")} disabled={!aheadCount} />
              领先 {cand?.ahead?.ref || "origin/develop"} 的改动
              <span className="text-slate-400">{cand?.ahead ? `${aheadCount} 个提交` : "没有这个远端分支"}</span>
            </label>
            <label className="flex items-center gap-2 text-xs text-slate-700">
              <input type="radio" value="recent" {...register("rangeKind")} />
              最近
              <input
                type="number"
                min={1}
                {...register("recentCount")}
                className="w-16 bg-card border border-border rounded px-2 py-0.5 text-xs"
              />
              个提交
            </label>
            <FieldError message={errors.recentCount?.message} />
            <label className="flex items-center gap-2 text-xs text-slate-700">
              <input type="radio" value="custom" {...register("rangeKind")} />
              指定起止（包含起点）
            </label>
            {values.rangeKind === "custom" && (
              <div className="grid grid-cols-1 gap-2 pl-5">
                <select {...register("from")} className={INPUT}>
                  <option value="">起点（较早的那个）</option>
                  {commits.map((c) => (
                    <option key={c.sha} value={c.sha}>
                      {commitLabel(c)}
                    </option>
                  ))}
                </select>
                <FieldError message={errors.from?.message} />
                <select {...register("to")} className={INPUT}>
                  <option value="">终点（较新的那个）</option>
                  {commits.map((c) => (
                    <option key={c.sha} value={c.sha}>
                      {commitLabel(c)}
                    </option>
                  ))}
                </select>
                <FieldError message={errors.to?.message} />
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-600">主题</label>
            <input {...register("topic")} placeholder={autoTopic(values, cand, commits)} className={INPUT} />
            <div className="text-[11px] text-slate-400">也是产物目录名；留空用灰字里的名字</div>
            <FieldError message={errors.topic?.message} />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-600">T3 模型</label>
            <ModelPicker
              value={{ provider: values.provider, model: values.model }}
              disabled={isSubmitting}
              onChange={(next) => {
                setValue("provider", next.provider, { shouldValidate: true });
                setValue("model", next.model, { shouldValidate: true });
              }}
            />
            <FieldError message={errors.provider?.message || errors.model?.message} />
            <div className="text-[11px] text-slate-400">
              默认取「T3 设置」，只影响这一次。agent 会做到确认点就停，不会动 mock 和浏览器。
            </div>
          </div>
          <FieldError message={errors.root?.message} />
        </div>

        <div className="shrink-0 flex justify-end gap-2 px-5 py-3.5 border-t border-border bg-slate-50/50">
          <button type="button" className={BTN} onClick={close} disabled={isSubmitting}>
            取消
          </button>
          <button type="submit" className={BTN_PRIMARY} disabled={isSubmitting || !cand}>
            {isSubmitting ? "派发中…" : "派给 T3 出清单"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
