import { useState } from "react";
import Modal from "../../components/modal";
import { showToast } from "../../utils/toast";
import { createTask } from "../../stores/docking-store";

/**
 * 手动新建需求弹窗。
 *
 * 四个表单字段留在这里而不是页面顶层：以前敲一个字就会带着整页（含全部任务卡）
 * 重渲染一次。页面只需要一个 open 布尔值；关闭时组件卸载，字段自动清空。
 */
export default function CreateTaskModal({ open, onClose, repos = [] }) {
  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");
  const [newRequester, setNewRequester] = useState("");
  const [newRepoPath, setNewRepoPath] = useState("");
  const [creating, setCreating] = useState(false);

  const handleCreateTask = async () => {
    const content = newContent.trim() || newTitle.trim();
    if (!content) {
      showToast("请填写需求内容", "warning");
      return;
    }
    setCreating(true);
    const result = await createTask({
      title: newTitle.trim() || undefined,
      content,
      senderName: newRequester.trim() || "手动录入",
      repoPath: newRepoPath || "",
      status: "inbox",
    });
    setCreating(false);
    if (result?.success) {
      showToast(`已创建需求 #${result.task.seq}`, "success");
      onClose();
    } else {
      showToast(`创建失败: ${result?.error}`, "error");
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="新建需求 / 逻辑排查咨询"
      srOnly={false}
      className="w-[560px] p-4"
    >
      <div className="space-y-3">
        <div>
          <label className="block text-[11px] font-bold text-slate-800 mb-1">
            简述 / 标题
          </label>
          <input
            type="text"
            className="w-full text-[12px] border border-slate-300 rounded p-2 focus:outline-none focus:ring-1 focus:ring-sky-400 bg-white text-slate-900 placeholder:text-slate-500 font-medium"
            placeholder="例如：排查登录态过期跳转逻辑 / 对接批量打标签接口"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
          />
        </div>

        <div>
          <label className="block text-[11px] font-bold text-slate-800 mb-1">
            详细描述 / 业务疑问 / 接口参数{" "}
            <span className="text-rose-500">*</span>
          </label>
          <textarea
            className="w-full text-[12px] border border-slate-300 rounded p-2 min-h-[100px] resize-y focus:outline-none focus:ring-1 focus:ring-sky-400 bg-white text-slate-900 placeholder:text-slate-500 font-medium"
            placeholder="粘贴需求说明、业务疑问、报错信息、排查要求或接口参数…"
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[11px] font-bold text-slate-800 mb-1">
              提出人 / 来源
            </label>
            <input
              type="text"
              className="w-full text-[12px] border border-slate-300 rounded p-2 focus:outline-none focus:ring-1 focus:ring-sky-400 bg-white text-slate-900 placeholder:text-slate-500 font-medium"
              placeholder="默认：手动录入"
              value={newRequester}
              onChange={(e) => setNewRequester(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-[11px] font-bold text-slate-800 mb-1">
              关联项目 (Repo)
            </label>
            <select
              className="w-full text-[12px] border border-slate-300 rounded p-2 focus:outline-none focus:ring-1 focus:ring-sky-400 bg-white text-slate-900 font-medium"
              value={newRepoPath}
              onChange={(e) => setNewRepoPath(e.target.value)}
            >
              <option value="">未指定（派活时再选）</option>
              {repos.map((r) => (
                <option key={r.key} value={r.path}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-2 mt-4">
        <button
          type="button"
          className="text-xs px-3 py-1.5 rounded border border-slate-300 text-slate-700 hover:bg-slate-100 font-medium cursor-pointer"
          onClick={onClose}
        >
          取消
        </button>
        <button
          type="button"
          disabled={creating || (!newContent.trim() && !newTitle.trim())}
          className="text-xs px-3.5 py-1.5 rounded bg-sky-600 hover:bg-sky-700 text-white disabled:opacity-40 cursor-pointer font-semibold shadow-xs"
          onClick={handleCreateTask}
        >
          {creating ? "创建中…" : "创建需求"}
        </button>
      </div>
    </Modal>
  );
}
