import { useEffect, useState } from "react";

/**
 * 通用「mount 时 fetch / deps 变化时 re-fetch」资源 hook。
 *
 * 命令式异步加载本质上需要 set-state-in-effect，把这条模式集中到 helper 里
 * 一次性 disable，业务代码就不必各自加注释；同时给一个统一的 { data, loading, error, reload } 接口。
 *
 * 用法：
 *   const { data, loading, reload } = useResource(
 *     () => window.electronAPI.checkEnv(),
 *     [],   // 依赖变化触发 re-fetch
 *   );
 */
export default function useResource(fetcher, deps) {
  const [state, setState] = useState({ loading: true, data: null, error: null });

  const run = async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fetcher();
      setState({ loading: false, data, error: null });
    } catch (error) {
      setState({ loading: false, data: null, error });
    }
  };

  useEffect(() => {
    // 故意：deps 由调用方控制 + 这是数据获取的标准命令式模式，
    // 在 helper 里集中 disable 一次，业务代码就不必各自加注释
    // eslint-disable-next-line react-hooks/set-state-in-effect
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { ...state, reload: run };
}
