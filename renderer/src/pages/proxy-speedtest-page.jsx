import { memo, useState } from "react";
import clsx from "../utils/clsx";
import PageShell from "../components/page-shell";
import useResource from "../hooks/use-resource";
import { confirm } from "../components/confirm-host";
import { showToast } from "../utils/toast";
import {
  useProxyNodes,
  useProxyNodesLoaded,
  useProxyTestRunning,
  useProxyNodeTesting,
  useProxyDownloadProgress,
  useProxyDownloadPref,
  useProxyDefaultDownloadUrl,
  setProxyDownloadPref,
  getDownloadLimits,
  loadProxyNodes,
  importProxyNodes,
  setProxyNodesChecked,
  removeProxyNodes,
  testProxyNodes,
  testProxyDownloads,
  stopProxyTests,
} from "../stores/proxy-nodes-store";

const BTN =
  "px-3 py-1.5 rounded-md border text-xs font-medium cursor-pointer transition-all bg-white text-slate-600 border-border hover:bg-slate-50 hover:text-slate-900 disabled:opacity-50 disabled:cursor-not-allowed";
const BTN_PRIMARY =
  "px-3 py-1.5 rounded-md border text-xs font-semibold cursor-pointer transition-all bg-slate-900 text-white border-slate-900 hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed";
const BTN_MINI =
  "text-[10px] px-2 py-1 rounded border cursor-pointer text-slate-500 border-border bg-slate-50 hover:bg-slate-100 hover:text-slate-900 transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

async function runTests(ids, kind = "latency") {
  if (!ids.length) {
    showToast("没有勾选任何节点", "warning");
    return;
  }
  if (kind === "download") {
    const { error } = getDownloadLimits();
    if (error) {
      showToast(error, "warning");
      return;
    }
  }
  const res = kind === "download" ? await testProxyDownloads(ids) : await testProxyNodes(ids);
  if (!res) return;
  const ok = res.done - res.failed;
  const what = kind === "download" ? "下载测速" : "延迟测试";
  const traffic = kind === "download" && res.traffic ? `，共消耗流量 ${formatBytes(res.traffic)}` : "";
  showToast(
    `${res.stopped ? "已停止，" : ""}${what}完成 ${res.done} 个：成功 ${ok}，失败 ${res.failed}${traffic}`,
    res.failed && !ok ? "warning" : "success",
  );
}

/** 字节 → 人类可读 */
function formatBytes(n) {
  if (!n) return "0 KB";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** 字节/秒 → 人类可读 */
function formatSpeed(bps) {
  if (bps == null) return "";
  if (bps >= 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(2)} MB/s`;
  return `${Math.round(bps / 1024)} KB/s`;
}

function speedClass(bps) {
  if (bps == null) return "text-red-500";
  if (bps >= 5 * 1024 * 1024) return "text-emerald-600";
  if (bps >= 1024 * 1024) return "text-amber-600";
  return "text-red-500";
}

export default function ProxySpeedtestPage() {
  const { error } = useResource(() => loadProxyNodes(), []);

  return (
    <PageShell
      title="节点测速"
      subtitle="批量导入 Shadowrocket 的 ss:// 节点，勾选后测延迟与下载速度"
      actions={<HeaderActions />}
    >
      <div className="flex flex-col gap-4">
        <ImportBox />
        <DownloadSettings />
        <FakeIpWarning />
        {error ? (
          <div className="text-xs text-red-600">读取节点缓存失败：{error.message}</div>
        ) : (
          <NodeTable />
        )}
      </div>
    </PageShell>
  );
}

function HeaderActions() {
  const nodes = useProxyNodes();
  const running = useProxyTestRunning();
  const checkedIds = nodes.filter((n) => n.checked).map((n) => n.id);

  if (running) {
    return (
      <button type="button" onClick={stopProxyTests} className={BTN}>
        ⏹ 停止{running === "download" ? "下载测速" : "延迟测试"}
      </button>
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={() => runTests(checkedIds, "download")}
        disabled={!checkedIds.length}
        className={BTN}
        title="逐个节点下载测试文件，到时长或流量上限即停"
      >
        ⬇️ 测下载速度（{checkedIds.length}）
      </button>
      <button
        type="button"
        onClick={() => runTests(checkedIds)}
        disabled={!checkedIds.length}
        className={BTN_PRIMARY}
      >
        ⚡ 测延迟（{checkedIds.length}）
      </button>
    </>
  );
}

function FakeIpWarning() {
  const nodes = useProxyNodes();
  if (!nodes.some((n) => n.result?.fakeIp)) return null;
  return (
    <div className="px-3 py-2 rounded-lg border border-amber-400/40 bg-amber-400/10 text-[11px] text-amber-800 leading-relaxed">
      ⚠️ 节点域名解析到了 198.18.x.x，说明本机代理软件（Shadowrocket / Clash / Surge 等）开着
      TUN / 增强模式。此时 TCP 延迟测到的只是本机代理，不准；真实延迟和下载速度也会先绕一圈本机代理。
      想测准请先关掉增强模式再测。
    </div>
  );
}

const INPUT =
  "bg-white border border-border rounded-md px-2.5 py-1 text-[11px] font-mono text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500 transition-colors disabled:opacity-60";

function LimitInput({ name, unit, placeholder, disabled }) {
  const value = useProxyDownloadPref(name);
  return (
    <label className="flex items-center gap-1.5">
      <input
        type="number"
        min="0"
        step="any"
        value={value}
        onChange={(e) => setProxyDownloadPref(name, e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        className={clsx(INPUT, "w-20 text-right")}
      />
      <span className="text-[11px] text-slate-500">{unit}</span>
    </label>
  );
}

function DownloadSettings() {
  const url = useProxyDownloadPref("downloadUrl");
  const defaultUrl = useProxyDefaultDownloadUrl();
  const running = useProxyTestRunning();
  const disabled = running === "download";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="w-20 shrink-0 text-[11px] text-slate-500">下载测速地址</span>
        <input
          value={url}
          onChange={(e) => setProxyDownloadPref("downloadUrl", e.target.value)}
          disabled={disabled}
          spellCheck={false}
          placeholder={defaultUrl ? `留空使用默认：${defaultUrl}` : "http(s):// 大文件地址"}
          className={clsx(INPUT, "flex-1 min-w-0")}
        />
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="w-20 shrink-0 text-[11px] text-slate-500">每个节点</span>
        <span className="text-[11px] text-slate-500">最多测</span>
        <LimitInput name="downloadSeconds" unit="秒" placeholder="不限" disabled={disabled} />
        <span className="text-[11px] text-slate-500">或</span>
        <LimitInput name="downloadMegabytes" unit="MB" placeholder="不限" disabled={disabled} />
        <span className="text-[11px] text-slate-400">
          谁先到就停；留空表示该项不限，但至少填一个。时长从开始收到数据算起；默认地址会自动续传到上限，自定义地址只下一遍
        </span>
      </div>
    </div>
  );
}

function ImportBox() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const handleImport = async () => {
    if (!text.trim()) {
      showToast("请先粘贴 ss:// 链接", "warning");
      return;
    }
    setBusy(true);
    try {
      const { added, updated, duplicated, invalid } = await importProxyNodes(text);
      const parts = [`新增 ${added} 个`];
      if (updated) parts.push(`更新已有节点 ${updated} 个`);
      if (duplicated) parts.push(`重复跳过 ${duplicated} 个`);
      if (invalid.length) parts.push(`无法解析 ${invalid.length} 条`);
      if (!added && !updated && !duplicated && !invalid.length) {
        showToast("没有找到 ss:// 链接", "warning");
      } else {
        showToast(parts.join("，"), added || updated ? "success" : "warning");
        setText("");
      }
    } catch (err) {
      showToast(`导入失败: ${err.message}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 p-3 bg-slate-50 border border-border rounded-lg">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        spellCheck={false}
        placeholder={"一次粘贴多条 ss:// 链接，换行 / 空格分隔均可\nss://YWVzLTI1Ni1nY206cGFzc3dvcmQ@1.2.3.4:8388#香港01"}
        className="w-full bg-white border border-border rounded-md px-3 py-2 text-xs font-mono text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500 transition-colors resize-y"
      />
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-slate-400">
          导入后默认全部勾选；与已有节点（服务器+端口+加密+密码相同）重复的不新增，只刷新名称和插件参数
        </span>
        <button type="button" onClick={handleImport} disabled={busy} className={BTN}>
          📥 批量导入
        </button>
      </div>
    </div>
  );
}

function sortNodes(nodes, sortBy) {
  if (sortBy === "download") {
    return [...nodes].sort((a, b) => (b.download?.speed ?? -1) - (a.download?.speed ?? -1));
  }
  if (sortBy !== "delay") return nodes;
  const score = (n) => n.result?.delay ?? (n.result?.tcp != null ? 1e6 + n.result.tcp : Infinity);
  return [...nodes].sort((a, b) => score(a) - score(b));
}

function NodeTable() {
  const nodes = useProxyNodes();
  const loaded = useProxyNodesLoaded();
  const running = useProxyTestRunning();
  const [sortBy, setSortBy] = useState("default");

  const checkedIds = nodes.filter((n) => n.checked).map((n) => n.id);
  const allChecked = nodes.length > 0 && checkedIds.length === nodes.length;
  const someChecked = checkedIds.length > 0 && !allChecked;

  const toggleAll = async () => {
    try {
      await setProxyNodesChecked(
        nodes.map((n) => n.id),
        !allChecked,
      );
    } catch (err) {
      showToast(`保存勾选失败: ${err.message}`, "error");
    }
  };

  // 导出：按表格当前排序，只取勾选的，每行一条原始 ss:// 链接（Shadowrocket 可直接粘贴导入）
  const exportLinks = () =>
    sortNodes(nodes, sortBy)
      .filter((n) => n.checked)
      .map((n) => n.raw)
      .join("\n");

  const copyChecked = async () => {
    try {
      await navigator.clipboard.writeText(exportLinks());
      showToast(`已复制 ${checkedIds.length} 条节点链接，可直接粘贴到 Shadowrocket`, "success");
    } catch (err) {
      showToast(`复制失败: ${err.message}`, "error");
    }
  };

  const exportCheckedFile = async () => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
    try {
      const res = await window.electronAPI.exportProxyNodesFile(
        `${exportLinks()}\n`,
        `ss-nodes-${stamp}.txt`,
      );
      if (!res?.success) throw new Error(res?.error || "未知错误");
      if (res.canceled) return;
      showToast(`已导出 ${checkedIds.length} 个节点到 ${res.filePath}`, "success");
    } catch (err) {
      showToast(`导出失败: ${err.message}`, "error");
    }
  };

  const removeChecked = async () => {
    const ok = await confirm({
      title: "删除节点",
      message: `确定删除勾选的 ${checkedIds.length} 个节点？`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      await removeProxyNodes(checkedIds);
      showToast(`已删除 ${checkedIds.length} 个节点`, "success");
    } catch (err) {
      showToast(`删除失败: ${err.message}`, "error");
    }
  };

  // 只勾选测通的节点，方便筛掉不能用的
  const checkOnlyAvailable = async () => {
    const tested = nodes.filter((n) => n.result);
    if (!tested.length) {
      showToast("还没有测速结果", "info");
      return;
    }
    const okIds = tested.filter((n) => n.result.delay != null).map((n) => n.id);
    const badIds = nodes.filter((n) => !okIds.includes(n.id)).map((n) => n.id);
    try {
      await setProxyNodesChecked(okIds, true);
      await setProxyNodesChecked(badIds, false);
    } catch (err) {
      showToast(`保存勾选失败: ${err.message}`, "error");
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-slate-500">
          共 {nodes.length} 个节点，已勾选 {checkedIds.length} 个
          <TrafficTotal nodes={nodes} />
        </span>
        <div className="flex items-center gap-1.5">
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="bg-white border border-border rounded px-1.5 py-1 text-[11px] text-slate-600 outline-none"
          >
            <option value="default">按导入顺序</option>
            <option value="delay">按延迟排序</option>
            <option value="download">按下载速度排序</option>
          </select>
          <button
            type="button"
            onClick={copyChecked}
            disabled={!checkedIds.length}
            className={BTN_MINI}
            title="按当前排序复制勾选节点的 ss:// 链接，每行一条"
          >
            复制勾选
          </button>
          <button
            type="button"
            onClick={exportCheckedFile}
            disabled={!checkedIds.length}
            className={BTN_MINI}
            title="按当前排序把勾选节点的 ss:// 链接导出为 .txt"
          >
            导出勾选
          </button>
          <button type="button" onClick={checkOnlyAvailable} disabled={Boolean(running)} className={BTN_MINI}>
            只勾选可用
          </button>
          <button
            type="button"
            onClick={removeChecked}
            disabled={Boolean(running) || !checkedIds.length}
            className={BTN_MINI}
          >
            删除勾选
          </button>
        </div>
      </div>

      <div className="border border-border rounded-lg overflow-hidden">
        <div className="flex items-center px-3 py-2 border-b border-border bg-slate-50 text-[11px] text-slate-500 font-semibold">
          <label className="w-7 shrink-0 flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={allChecked}
              ref={(el) => {
                if (el) el.indeterminate = someChecked;
              }}
              onChange={toggleAll}
              disabled={!nodes.length}
              title={allChecked ? "全不选" : "全选"}
            />
          </label>
          <span className="flex-1 min-w-0">节点</span>
          <span className="w-32 shrink-0">加密</span>
          <span className="w-14 shrink-0 text-right">TCP</span>
          <span className="w-18 shrink-0 text-right">真实延迟</span>
          <span className="w-24 shrink-0 text-right">下载速度</span>
          <span className="w-32 shrink-0 text-right">操作</span>
        </div>

        {!loaded ? (
          <div className="px-4 py-8 text-center text-slate-400 text-xs">读取节点缓存…</div>
        ) : !nodes.length ? (
          <div className="px-4 py-8 text-center text-slate-400 text-xs">
            还没有节点，在上方粘贴 ss:// 链接导入
          </div>
        ) : (
          sortNodes(nodes, sortBy).map((node) => (
            <NodeRow key={node.id} node={node} running={running} />
          ))
        )}
      </div>
    </div>
  );
}

function pluginLabel(plugin) {
  const [name, ...pairs] = plugin.split(";");
  const mode = pairs.find((p) => p.startsWith("obfs="));
  return mode ? `${name} (${mode.slice(5)})` : name;
}

function delayClass(ms) {
  if (ms == null) return "text-red-500";
  if (ms < 300) return "text-emerald-600";
  if (ms < 800) return "text-amber-600";
  return "text-red-500";
}

const NodeRow = memo(function NodeRow({ node, running }) {
  const testing = useProxyNodeTesting(node.id);
  const testingLatency = testing && running === "latency";
  const testingDownload = testing && running === "download";
  const { result } = node;

  const toggle = async () => {
    try {
      await setProxyNodesChecked([node.id], !node.checked);
    } catch (err) {
      showToast(`保存勾选失败: ${err.message}`, "error");
    }
  };

  const remove = async () => {
    try {
      await removeProxyNodes([node.id]);
    } catch (err) {
      showToast(`删除失败: ${err.message}`, "error");
    }
  };

  const tip = [result?.error, result?.note].filter(Boolean).join("\n");

  return (
    <div className="flex items-center px-3 py-2 border-b border-border last:border-0 hover:bg-slate-50/50 transition-colors">
      <label className="w-7 shrink-0 flex items-center cursor-pointer">
        <input type="checkbox" checked={node.checked} onChange={toggle} />
      </label>
      <div className={clsx("flex-1 min-w-0", !node.checked && "opacity-50")} title={node.raw}>
        <div className="text-xs text-slate-900 truncate">{node.name}</div>
        <div className="text-[10.5px] text-slate-400 font-mono truncate">
          {node.server}:{node.port}
          {node.plugin ? ` · ${pluginLabel(node.plugin)}` : ""}
        </div>
      </div>
      <span className="w-32 shrink-0 text-[11px] text-slate-500 font-mono truncate" title={node.method}>
        {node.method}
      </span>
      <span
        className={clsx(
          "w-14 shrink-0 text-right text-xs font-mono",
          result ? delayClass(result.tcp) : "text-slate-300",
        )}
      >
        {testingLatency ? "…" : result ? (result.tcp != null ? `${result.tcp}ms` : "失败") : "—"}
      </span>
      <span
        className={clsx(
          "w-18 shrink-0 text-right text-xs font-mono font-semibold",
          result ? delayClass(result.delay) : "text-slate-300",
          tip && "cursor-help",
        )}
        title={tip || undefined}
      >
        {testingLatency
          ? "测试中"
          : !result
            ? "—"
            : result.delay != null
              ? `${result.delay}ms`
              : result.note
                ? "N/A"
                : /超时/.test(result.error || "")
                  ? "超时"
                  : "失败"}
      </span>
      <DownloadCell node={node} testing={testingDownload} />
      <span className="w-32 shrink-0 flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={() => runTests([node.id])}
          disabled={Boolean(running)}
          className={BTN_MINI}
        >
          延迟
        </button>
        <button
          type="button"
          onClick={() => runTests([node.id], "download")}
          disabled={Boolean(running)}
          className={BTN_MINI}
        >
          下载
        </button>
        <button type="button" onClick={remove} disabled={Boolean(running)} className={BTN_MINI}>
          删除
        </button>
      </span>
    </div>
  );
});

const secs = (ms) => `${(ms / 1000).toFixed(1)} 秒`;

/**
 * 悬停说明：速度 = 文件内容 ÷ 有效下载时间。总耗时里多出来的是建连、握手、续传重连和卡顿，
 * 不计入速度（旧数据没有 wallMs，只显示有效时间）。
 */
function downloadTip(d) {
  const lines = [
    `速度 = 文件内容 ${formatBytes(d.bytes)} ÷ 有效下载时间 ${secs(d.ms)}`,
  ];
  if (d.wallMs) {
    const overhead = Math.max(0, d.wallMs - d.ms);
    lines.push(
      `总耗时 ${secs(d.wallMs)}，其中 ${secs(overhead)}花在建连 / 握手${d.rounds > 1 ? ` / ${d.rounds - 1} 次续传重连` : ""}${d.stoppedBy === "idle" ? " / 卡住空等" : ""}，不计入速度`,
    );
  }
  if (STOPPED_BY[d.stoppedBy]) lines.push(`停止原因：${STOPPED_BY[d.stoppedBy]}`);
  if (d.traffic) lines.push(`经过节点的流量 ${formatBytes(d.traffic)}（含加密 / 混淆 / TLS 开销）`);
  return lines.join("\n");
}

const STOPPED_BY = {
  time: "到时长上限",
  bytes: "到流量上限",
  end: "文件已下完",
  interrupted: "续传中断，按已下载的计算",
  idle: "下载卡住，按已下载的计算",
};

/** 表格上方：最近一次下载测速结果的流量合计（每个节点只算最新一次） */
function TrafficTotal({ nodes }) {
  const total = nodes.reduce((sum, n) => sum + (n.download?.traffic || 0), 0);
  if (!total) return null;
  return (
    <span title="各节点最近一次下载测速经过节点的流量之和（含加密 / 混淆 / TLS 开销）">
      ，下载测速共消耗流量 {formatBytes(total)}
    </span>
  );
}

function DownloadCell({ node, testing }) {
  const progress = useProxyDownloadProgress(node.id);
  const { download } = node;

  if (testing) {
    return (
      <span className="w-24 shrink-0 text-right font-mono text-sky-600 leading-tight">
        <span className="block text-xs">{progress ? formatSpeed(progress.speed) : "连接中…"}</span>
        {progress ? <span className="block text-[10.5px]">已用 {formatBytes(progress.traffic)}</span> : null}
      </span>
    );
  }
  if (!download) {
    return <span className="w-24 shrink-0 text-right text-xs font-mono text-slate-300">—</span>;
  }
  const tip = download.error ? download.error : downloadTip(download);
  return (
    <span className="w-24 shrink-0 text-right font-mono leading-tight cursor-help" title={tip}>
      <span
        className={clsx(
          "block text-xs font-semibold",
          download.unsupported ? "text-slate-400" : speedClass(download.speed),
        )}
      >
        {download.speed != null ? formatSpeed(download.speed) : download.unsupported ? "N/A" : "失败"}
      </span>
      {download.traffic ? (
        <span className="block text-[10.5px] text-slate-400">{formatBytes(download.traffic)}</span>
      ) : null}
    </span>
  );
}
