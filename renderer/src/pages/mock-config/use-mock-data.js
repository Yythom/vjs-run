import useResource from "../../hooks/use-resource";
import { ruleKey } from "./utils";

/**
 * mock-config 页面的数据层：读 OpenAPI routes + mock rules。
 * 通过 useResource 接管 fetch-on-mount + spec 路径变化时 re-fetch，
 * 业务侧不暴露任何 useEffect。
 */
export default function useMockData({ config, onToast, selectedKey, setSelectedKey }) {
  const { data, loading, reload } = useResource(async () => {
    const [routeResult, ruleResult] = await Promise.all([
      window.electronAPI.getMockRoutes(),
      window.electronAPI.getMockRules(),
    ]);
    if (!routeResult?.success) {
      onToast?.(`读取 OpenAPI 失败: ${routeResult?.error || "未知错误"}`, "error");
    }
    if (!ruleResult?.success) {
      onToast?.(`读取 mock rules 失败: ${ruleResult?.error || "未知错误"}`, "error");
    }

    const nextRoutes = routeResult?.routes || [];
    const nextRules = ruleResult?.rules || [];

    // 选中项保持，否则选第一条 route / rule
    const firstRoute = nextRoutes[0] ? ruleKey(nextRoutes[0]) : "";
    const firstRule = nextRules[0] ? ruleKey(nextRules[0]) : "";
    setSelectedKey(selectedKey || firstRoute || firstRule);

    return {
      routes: nextRoutes,
      rules: nextRules,
      rulesFile: ruleResult?.file || "",
    };
  }, [config?.mockSpecPath, config?.mockServiceAddress]);

  const routes = data?.routes || [];
  const rules = data?.rules || [];
  const rulesFile = data?.rulesFile || "";

  // 保存后 reload —— 多一次 IPC 但代码更直，不再单独维护 rules state
  const saveRules = async (nextRules) => {
    const result = await window.electronAPI.saveMockRules(nextRules);
    if (!result?.success) {
      onToast?.(`保存失败: ${result?.error || "未知错误"}`, "error");
      return null;
    }
    await reload();
    return result.rules || nextRules;
  };

  return { routes, rules, rulesFile, loading, load: reload, saveRules };
}
