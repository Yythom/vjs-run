import { toast } from "sonner";

/**
 * 兼容旧 API 的 toast 封装：showToast(message, type)
 * type ∈ "success" | "error" | "warning" | "info"，未知值走 info
 *
 * 现有代码大量使用这个签名（hook props、modal onToast prop 等），
 * 直接迁移成 sonner 调用会产生大量改动；保留一层薄壳维持原 API。
 */
export function showToast(message, type = "info") {
  switch (type) {
    case "success":
      return toast.success(message);
    case "error":
      return toast.error(message);
    case "warning":
      return toast.warning(message);
    default:
      return toast.info(message);
  }
}

// 高级用法（promise/loading/custom）直接 import { toast } from "sonner"
export { toast };
