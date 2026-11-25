import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { updateAppConfig, useAppConfigStore } from "../../stores/app-config-store";
import { showToast } from "../../utils/toast";
import ModelPicker from "./model-picker";
import { BTN, BTN_PRIMARY, INPUT } from "./ui";

const schema = z.object({
  provider: z.string().trim().min(1, "填 T3 里的 provider 实例 id，如 magpie"),
  model: z.string().trim().min(1, "填模型 slug"),
  recordsDir: z.string().trim().min(1, "填产物目录"),
});

/**
 * 改动测试台的三项设置。面板打开时才挂载，初值取那一刻的配置；关掉即卸载，没保存的改动随之丢弃。
 * 保存后调 onSaved（产物目录可能变了，列表要重读），取消调 onCancel。
 */
export default function T3SettingsPanel({ onSaved, onCancel }) {
  const cfg = useAppConfigStore.getState().appConfig.rangeTest;
  const {
    register,
    control,
    setValue,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm({ resolver: zodResolver(schema), defaultValues: { ...cfg } });
  const [provider, model] = useWatch({ control, name: ["provider", "model"] });

  const onSubmit = async (v) => {
    try {
      await updateAppConfig({ rangeTest: v });
      showToast("已保存，下次新建测试生效", "success");
      onSaved();
    } catch (err) {
      showToast(err.message, "error");
    }
  };

  const field = (name, label, hint) => (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-slate-600">{label}</label>
      <input {...register(name)} className={INPUT} />
      {hint && <div className="text-[11px] text-slate-400">{hint}</div>}
      {errors[name] && <div className="text-[11px] text-red-600">{errors[name].message}</div>}
    </div>
  );

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="px-5 py-4 border-b border-border bg-slate-50/50 flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-slate-600">默认的 T3 provider 和模型（新建测试时可以再改）</label>
        <ModelPicker
          value={{ provider, model }}
          disabled={isSubmitting}
          onChange={(next) => {
            setValue("provider", next.provider, { shouldValidate: true });
            setValue("model", next.model, { shouldValidate: true });
          }}
        />
        {(errors.provider || errors.model) && (
          <div className="text-[11px] text-red-600">{errors.provider?.message || errors.model?.message}</div>
        )}
      </div>
      {field("recordsDir", "产物目录", "和 commit-range-test 的约定一致，默认 ~/test-records")}
      <div className="flex justify-end gap-2">
        <button type="button" className={BTN} onClick={onCancel} disabled={isSubmitting}>
          取消
        </button>
        <button type="submit" className={BTN_PRIMARY} disabled={isSubmitting}>
          保存
        </button>
      </div>
    </form>
  );
}
