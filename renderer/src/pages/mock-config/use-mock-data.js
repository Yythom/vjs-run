import useResource from "../../hooks/use-resource";

/**
 * mock-config 页面的数据层：读 OpenAPI routes + mock rules。
 * 通过 useResource 接管 fetch-on-mount + spec 路径变化时 re-fetch，
 * 业务侧不暴露任何 useEffect。
 *
 * 传入 editingScene（场景名）时进入场景编辑模式：规则的读写目标
 * 从活动规则文件切换为 scenes/<场景名>.json，routes 不受影响。
 */
export default function useMockData({
  config,
  onToast,
  editingScene = null,
}) {
  const { data, loading, reload } = useResource(async () => {
    const [routeResult, ruleResult] = await Promise.all([
      window.electronAPI.getMockRoutes(),
      editingScene
        ? window.electronAPI.getMockSceneRules(editingScene)
        : window.electronAPI.getMockRules(),
    ]);
    if (!routeResult?.success) {
      onToast?.(`读取 OpenAPI 失败: ${routeResult?.error || "未知错误"}`, "error");
    }
    if (!ruleResult?.success) {
      onToast?.(`读取 mock rules 失败: ${ruleResult?.error || "未知错误"}`, "error");
    }

    // 不在这里碰 selectedKey：它现在是编辑器弹框的开关，
    // 加载完自动选中会让弹框在进页面 / 切回页面时自己弹出来。
    return {
      routes: routeResult?.routes || [],
      rules: ruleResult?.rules || [],
      rulesFile: ruleResult?.file || "",
    };
  }, [config?.mockSpecPath, config?.mockServiceAddress, editingScene]);

  const routes = data?.routes || [];
  const rules = data?.rules || [];
  const rulesFile = data?.rulesFile || "";

  // 保存后 reload —— 多一次 IPC 但代码更直，不再单独维护 rules state
  const saveRules = async (nextRules) => {
    const result = editingScene
      ? await window.electronAPI.saveMockSceneRules(editingScene, nextRules)
      : await window.electronAPI.saveMockRules(nextRules);
    if (!result?.success) {
      onToast?.(`保存失败: ${result?.error || "未知错误"}`, "error");
      return null;
    }
    await reload();
    return result.rules || nextRules;
  };

  return { routes, rules, rulesFile, loading, load: reload, saveRules };
}
