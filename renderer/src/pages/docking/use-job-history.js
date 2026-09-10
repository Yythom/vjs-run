import { useCallback, useEffect, useRef, useState } from "react";
import { loadHistoryTotal } from "../../stores/docking-store";

/**
 * AI 调用历史的列表、筛选与详情。
 *
 * 整块从 DockingPage 搬下来的：这些 state 只有历史面板用得到，留在页面顶层时
 * 主进程每推一次「历史已更新」就会触发一次 setHistoryList，把整页——连同全部
 * 任务卡——重渲染一遍，而面板可能根本没开着。
 *
 * 面板按 open 条件挂载，所以这里挂载即拉取、卸载即丢弃。
 */
export default function useJobHistory(initialTaskId = "") {
  const [list, setList] = useState([]);
  const [total, setTotal] = useState(0);
  const [selectedJobId, setSelectedJobId] = useState(null);
  const [selectedJobDetail, setSelectedJobDetail] = useState(null);
  const [filterTaskId, setFilterTaskId] = useState(initialTaskId);
  const [filterEngine, setFilterEngine] = useState("");
  const [filterStatus, setFilterStatus] = useState("");

  // fetch 要读当前选中项来决定要不要换详情，但不该因此把自己重建一遍
  // （selectedJobId 进依赖 → fetchHistory 换引用 → 订阅 effect 重跑 → 又拉一次）
  const selectedRef = useRef(null);
  useEffect(() => {
    selectedRef.current = selectedJobId;
  }, [selectedJobId]);

  const loadJobDetail = useCallback(async (jobId) => {
    setSelectedJobId(jobId);
    try {
      const res = await window.electronAPI.dockingGetHistoryDetail(jobId);
      setSelectedJobDetail(res?.record || null);
    } catch (err) {
      console.error("加载调用详情失败:", err);
    }
  }, []);

  const fetchHistory = useCallback(
    async (overrides = {}) => {
      const {
        taskId = filterTaskId,
        engine = filterEngine,
        status = filterStatus,
      } = overrides;
      try {
        const res = await window.electronAPI.dockingGetHistory({
          taskId: taskId || undefined,
          engine: engine || undefined,
          status: status || undefined,
          limit: 100,
        });
        const items = res?.items || [];
        setList(items);
        setTotal(res?.total || 0);
        if (items.length > 0) {
          const current = selectedRef.current;
          if (!current || !items.some((it) => it.id === current)) {
            loadJobDetail(items[0].id);
          }
        } else {
          setSelectedJobId(null);
          setSelectedJobDetail(null);
        }
      } catch (err) {
        console.error("加载 AI 历史记录失败:", err);
      }
    },
    [filterTaskId, filterEngine, filterStatus, loadJobDetail],
  );

  // 挂载时拉一次，并订阅主进程的历史变动
  useEffect(() => {
    // 故意：命令式数据获取的标准写法，同 hooks/use-resource.js 的约定
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchHistory();
    const off = window.electronAPI.onDockingHistoryUpdated?.(() => {
      fetchHistory();
    });
    return () => off?.();
    // fetchHistory 随筛选条件变化，但重订阅一次是无害且必要的（要带上新条件）
  }, [fetchHistory]);

  const changeFilter = useCallback((key, value) => {
    if (key === "taskId") setFilterTaskId(value);
    if (key === "engine") setFilterEngine(value);
    if (key === "status") setFilterStatus(value);
  }, []);

  const deleteJob = useCallback(
    async (jobId) => {
      await window.electronAPI.dockingDeleteHistory(jobId);
      await fetchHistory();
      loadHistoryTotal();
    },
    [fetchHistory],
  );

  const clearAll = useCallback(async () => {
    await window.electronAPI.dockingClearHistory();
    await fetchHistory();
    loadHistoryTotal();
  }, [fetchHistory]);

  return {
    list,
    total,
    selectedJobId,
    selectedJobDetail,
    filterTaskId,
    filterEngine,
    filterStatus,
    loadJobDetail,
    changeFilter,
    deleteJob,
    clearAll,
  };
}
