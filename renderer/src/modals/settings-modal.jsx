import { useState } from "react";
import PageShell from "../components/page-shell";
import { updateAppConfig, useAppConfigStore } from "../stores/app-config-store";
import { generateMockSpec, useGeneratingMockSpec } from "../stores/runner-store";
import useModalNav, { useCloseModal } from "../hooks/use-modal-nav";
import { showToast } from "../utils/toast";
import UpdateChecker from "../components/update-checker";

export default function SettingsModal() {
  const close = useCloseModal();
  const openModal = useModalNav();

  // 配置已经在 store 里（app 启动时 init 拉过一次），直接同步取一次作为初始值。
  // 用 getState() 而不是 useAppConfig()，避免 store 变化时把用户正在编辑的表单 reset。
  const cfg = useAppConfigStore.getState().appConfig;
  const [mockSpecPath, setMockSpecPath] = useState(cfg.mockSpecPath || "");
  const [mockSwaggerServer, setMockSwaggerServer] = useState(cfg.mockSwaggerServer || "http://alb-qtjrjlj7p6s63het87.cn-shanghai.alb.aliyuncs.com");
  const [mockHost, setMockHost] = useState(cfg.mockHost || "127.0.0.1");
  const [mockPort, setMockPort] = useState(String(cfg.mockPort || 3002));
  const [mockServiceAddress, setMockServiceAddress] = useState(cfg.mockServiceAddress || "");
  const [mockBackendBaseUrl, setMockBackendBaseUrl] = useState(cfg.mockBackendBaseUrl || "");
  const [mockAll, setMockAll] = useState(Boolean(cfg.mockAll));
  const [saving, setSaving] = useState(false);
  const generating = useGeneratingMockSpec();



  // 独立操作：先把表单里的目录 + 源服务器地址落盘（生成逻辑读的是已保存配置），再触发生成
  const handleGenerate = async () => {
    if (generating) return;

    const nextMockSpecPath = mockSpecPath.trim();
    const nextMockSwaggerServer = mockSwaggerServer.trim();
    const mockSpecIsAbsoluteDir =
      nextMockSpecPath.startsWith("/") && !/\.(json|ya?ml)$/i.test(nextMockSpecPath);

    if (!nextMockSwaggerServer) {
      showToast("请先填写 Swagger 源服务器地址", "warning");
      return;
    }
    if (!nextMockSpecPath || !mockSpecIsAbsoluteDir) {
      showToast("OpenAPI JSON 路径必须是绝对目录", "warning");
      return;
    }

    try {
      await updateAppConfig({
        mockSpecPath: nextMockSpecPath,
        mockSwaggerServer: nextMockSwaggerServer,
      });
    } catch (error) {
      showToast(`保存配置失败: ${error?.message || String(error)}`, "error");
      return;
    }
    await generateMockSpec();
  };

  const handleSelectDirectory = async () => {
    try {
      const selectedPath = await window.electronAPI.selectDirectory();
      if (selectedPath) {
        setMockSpecPath(selectedPath);
      }
    } catch (err) {
      showToast(`选择目录失败: ${err.message}`, "error");
    }
  };

  const handleSave = async () => {
    if (saving) return;

    const nextMockSpecPath = mockSpecPath.trim();
    const nextMockHost = mockHost.trim() || "127.0.0.1";
    const nextMockPort = Number(mockPort);
    const nextMockServiceAddress = mockServiceAddress.trim();

    const mockSpecIsAbsoluteDir =
      nextMockSpecPath.startsWith("/") && !/\.(json|ya?ml)$/i.test(nextMockSpecPath);

    if (
      !nextMockSpecPath ||
      !mockSpecIsAbsoluteDir ||
      !Number.isInteger(nextMockPort)
    ) {
      showToast(
        "OpenAPI JSON 路径必须是绝对目录，端口和 rc 需要是整数",
        "warning",
      );
      return;
    }

    setSaving(true);
    try {
      await updateAppConfig({
        mockSpecPath: nextMockSpecPath,
        mockSwaggerServer: mockSwaggerServer.trim(),
        mockHost: nextMockHost,
        mockPort: nextMockPort,
        mockServiceAddress: nextMockServiceAddress,
        mockBackendBaseUrl: mockBackendBaseUrl.trim(),
        mockAll,
      });
      showToast("配置已保存，下次启动项目时生效", "success");
      close();
    } catch (error) {
      showToast(`保存失败: ${error?.message || String(error)}`, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageShell
      title="服务配置"
      subtitle="配置 Swagger Mock 服务的主机、端口及后端代理地址"
      actions={
        <>
          <button
            type="button"
            onClick={close}
            disabled={saving}
            className="px-4 py-1.5 rounded-md border text-xs font-medium cursor-pointer transition-all bg-white text-slate-600 border-border hover:bg-slate-50 hover:text-slate-900 disabled:opacity-40"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 rounded-md border text-xs font-medium cursor-pointer transition-all bg-blue-500/20 text-blue-700 border-blue-500/40 hover:bg-blue-500/30 disabled:opacity-40"
          >
            {saving ? "保存中..." : "保存"}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* 卡片 1：数据源配置与生成 */}
        <div className="p-4 border border-border rounded-xl bg-card flex flex-col gap-4">
          <h3 className="text-xs font-semibold text-slate-700 flex items-center gap-1.5 pb-2 border-b border-border">
            <span>📦</span> 数据源配置与生成
          </h3>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-600">
              Swagger Mock OpenAPI JSON 目录
              <span className="ml-1 text-slate-400 font-normal">(绝对路径)</span>
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={mockSpecPath}
                onChange={(e) => setMockSpecPath(e.target.value)}
                placeholder="/Users/yourname/tool/swagger-mock/json.output"
                className="flex-1 bg-card border border-border rounded-md px-3 py-2 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500 transition-colors"
              />
              <button
                type="button"
                onClick={handleSelectDirectory}
                className="px-3 py-2 rounded-md border text-xs font-medium bg-card text-slate-600 border-border hover:bg-hover hover:text-slate-900 transition-colors flex items-center gap-1 cursor-pointer shrink-0"
              >
                📂 选择文件夹
              </button>
            </div>
            <p className="text-[11px] text-slate-400">
              必须填写包含 OpenAPI JSON/YAML 文件的绝对路径目录
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-600">
              Swagger 源服务器地址
              <span className="ml-1 text-slate-400 font-normal">(可选)</span>
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={mockSwaggerServer}
                onChange={(e) => setMockSwaggerServer(e.target.value)}
                placeholder="http://alb-xxx.cn-shanghai.alb.aliyuncs.com/t2"
                className="flex-1 bg-card border border-border rounded-md px-3 py-2 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500 transition-colors"
              />
              <button
                type="button"
                onClick={handleGenerate}
                disabled={generating}
                className="px-3 py-2 rounded-md border text-xs font-medium bg-purple-500/[0.06] text-purple-700 border-purple-500/25 hover:bg-purple-500/15 transition-colors cursor-pointer shrink-0 disabled:opacity-50 disabled:cursor-default"
                title="从该服务器拉取各服务 swagger 文档，生成 OpenAPI JSON 写入上面的目录（进度见 Mock 运行日志）"
              >
                {generating ? "⏳ 生成中…" : "⚡ 生成 OpenAPI JSON"}
              </button>
              <button
                type="button"
                onClick={() => openModal("/mock-service")}
                className="px-3 py-2 rounded-md border text-xs font-medium bg-card text-slate-600 border-border hover:bg-hover hover:text-slate-900 transition-colors flex items-center gap-1 cursor-pointer shrink-0"
                title="打开 Mock 服务运行日志控制台"
              >
                📋 查看日志
              </button>
            </div>
            <p className="text-[11px] text-slate-400">
              点击「生成」会先保存目录与该地址，再从服务器拉取各服务 swagger
              文档写入上面的目录；生成进度见 Mock 运行日志
            </p>
          </div>
        </div>

        {/* 卡片 2：运行与代理配置 */}
        <div className="p-4 border border-border rounded-xl bg-card flex flex-col gap-4">
          <h3 className="text-xs font-semibold text-slate-700 flex items-center gap-1.5 pb-2 border-b border-border">
            <span>⚙️</span> Mock 运行与代理参数
          </h3>
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-slate-600">Mock Host</label>
              <input
                type="text"
                value={mockHost}
                onChange={(e) => setMockHost(e.target.value)}
                placeholder="127.0.0.1"
                className="w-full bg-card border border-border rounded-md px-3 py-2 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500 transition-colors"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-slate-600">Mock Port</label>
              <input
                type="number"
                value={mockPort}
                onChange={(e) => setMockPort(e.target.value)}
                placeholder="3002"
                className="w-full bg-card border border-border rounded-md px-3 py-2 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500 transition-colors"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-600">
              Swagger Mock 服务地址
              <span className="ml-1 text-slate-400 font-normal">(可选)</span>
            </label>
            <input
              type="text"
              value={mockServiceAddress}
              onChange={(e) => setMockServiceAddress(e.target.value)}
              placeholder="/vjk 或 http://127.0.0.1:3002/vjk"
              className="w-full bg-card border border-border rounded-md px-3 py-2 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500 transition-colors"
            />
            <p className="text-[11px] text-slate-400">
              所有 mock 路由的前缀（如 /vjh、/vjk）。留空时自动读取 OpenAPI 文档里的默认前缀
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-600">
              后端代理地址
              <span className="ml-1 text-slate-400 font-normal">
                (BACKEND_BASE_URL / API)
              </span>
            </label>
            <input
              type="text"
              value={mockBackendBaseUrl}
              onChange={(e) => setMockBackendBaseUrl(e.target.value)}
              placeholder="https://vapi.vjshi.cn/t2"
              className="w-full bg-card border border-border rounded-md px-3 py-2 text-xs text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500 transition-colors"
            />
            <label className="mt-1 inline-flex items-center gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={mockAll}
                onChange={(e) => setMockAll(e.target.checked)}
                className="accent-blue-500"
              />
              全部接口使用 mock，不 fallback 到后端
            </label>
          </div>
        </div>

        {/* 卡片 3：版本与更新 */}
        <div className="p-4 border border-border rounded-xl bg-card flex flex-col gap-3">
          <h3 className="text-xs font-semibold text-slate-700 flex items-center gap-1.5 pb-2 border-b border-border">
            <span>🔄</span> 版本与更新
          </h3>
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500">
              当前版本：v{cfg._appVersion || "unknown"}
            </span>
            <UpdateChecker className="px-4 py-1.5 rounded-md border text-xs font-medium cursor-pointer transition-all bg-emerald-500/10 text-emerald-700 border-emerald-500/30 hover:bg-emerald-500/20 disabled:opacity-50 disabled:cursor-default">
              🔄 检查更新
            </UpdateChecker>
          </div>
        </div>

      </div>
    </PageShell>
  );
}

