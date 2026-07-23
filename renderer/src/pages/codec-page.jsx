import { useState } from "react";
import clsx from "../utils/clsx";
import PageShell from "../components/page-shell";
import JsonEditor from "../components/json-editor";
import { decodeData, encodeData } from "../utils/crypto-codec";
import { showToast } from "../utils/toast";

const MODES = [
  { key: "decode", label: "解密（密文 → JSON）" },
  { key: "encode", label: "加密（JSON → 密文）" },
];

const PLACEHOLDER = {
  decode: "粘贴接口返回的 base64 密文…",
  encode: '输入 JSON，例如 {"id":1,"name":"张三"}',
};

export default function CodecPage() {
  const [mode, setMode] = useState("decode");
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [error, setError] = useState("");

  const switchMode = (nextMode) => {
    setMode(nextMode);
    setInput("");
    setOutput("");
    setError("");
  };

  const run = () => {
    const text = input.trim();
    if (!text) {
      setOutput("");
      setError("");
      return;
    }
    try {
      if (mode === "decode") {
        setOutput(JSON.stringify(decodeData(text), null, 2));
      } else {
        setOutput(encodeData(JSON.parse(text)));
      }
      setError("");
    } catch (err) {
      setOutput("");
      setError(
        mode === "decode"
          ? `解密失败：${err.message}（请确认是完整的 base64 密文）`
          : `加密失败：${err.message}（请确认输入是合法 JSON）`,
      );
    }
  };

  // 把结果塞回输入框，方便加解密来回验证
  const swap = () => {
    if (!output) return;
    const nextMode = mode === "decode" ? "encode" : "decode";
    setMode(nextMode);
    setInput(output);
    setOutput("");
    setError("");
  };

  const copyOutput = async () => {
    try {
      await navigator.clipboard.writeText(output);
      showToast("结果已复制到剪贴板", "success");
    } catch (err) {
      showToast(`复制失败: ${err.message}`, "error");
    }
  };

  return (
    <PageShell
      title="统计数据计算"
      subtitle="对 encodeData（异或 0xa5 + base64）编码的报文做加解密"
      actions={
        <button
          type="button"
          onClick={run}
          className="px-3 py-1.5 rounded-md border text-xs font-medium cursor-pointer transition-all bg-white text-slate-600 border-border hover:bg-slate-50 hover:text-slate-900"
        >
          {mode === "decode" ? "🔓 解密" : "🔒 加密"}
        </button>
      }
    >
      <div className="flex flex-col gap-4">
        {/* 模式切换 */}
        <div className="flex items-center gap-1 p-1 bg-slate-50 border border-border rounded-lg w-fit">
          {MODES.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => switchMode(item.key)}
              className={clsx(
                "px-3 py-1.5 rounded-md text-xs font-semibold cursor-pointer transition-all",
                mode === item.key
                  ? "bg-white text-blue-600 border border-blue-500/20 shadow-[0_1px_2px_rgba(0,0,0,0.03)]"
                  : "text-slate-500 border border-transparent hover:text-slate-900",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        {/* 输入 */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] text-slate-500 font-semibold uppercase tracking-wide">
            输入
          </span>
          <div
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run();
            }}
          >
            {mode === "encode" ? (
              <JsonEditor
                value={input}
                onChange={setInput}
                height="160px"
                placeholder={PLACEHOLDER.encode}
                resizable
                className="border border-border rounded-md overflow-hidden"
              />
            ) : (
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                spellCheck={false}
                placeholder={PLACEHOLDER.decode}
                className="w-full h-40 resize-y bg-white border border-border rounded-md px-3 py-2 text-xs font-mono text-slate-900 placeholder-slate-400 outline-none focus:border-slate-500 transition-colors break-all"
              />
            )}
          </div>
          <span className="text-[10.5px] text-slate-400">
            按 ⌘/Ctrl + Enter 快速执行{mode === "encode" ? "，⌥⇧F 格式化 JSON" : ""}
          </span>
        </div>

        {/* 输出 */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="flex-1 text-[11px] text-slate-500 font-semibold uppercase tracking-wide">
              结果
            </span>
            {output && (
              <>
                <button
                  type="button"
                  onClick={swap}
                  className="text-[10px] px-2 py-1 rounded border cursor-pointer text-slate-500 border-border bg-slate-50 hover:bg-slate-100 hover:text-slate-900 transition-colors"
                  title="把结果作为输入反向验证"
                >
                  ⇄ 反向验证
                </button>
                <button
                  type="button"
                  onClick={copyOutput}
                  className="text-[10px] px-2 py-1 rounded border cursor-pointer text-slate-500 border-border bg-slate-50 hover:bg-slate-100 hover:text-slate-900 transition-colors"
                >
                  复制
                </button>
              </>
            )}
          </div>

          {error ? (
            <div className="px-3 py-2 rounded-md border border-red-400/30 bg-red-400/10 text-xs text-red-700">
              {error}
            </div>
          ) : mode === "decode" ? (
            <JsonEditor
              value={output}
              onChange={setOutput}
              height="224px"
              placeholder="暂无结果"
              resizable
              className="border border-border rounded-md overflow-hidden"
            />
          ) : (
            <pre className="h-56 overflow-auto bg-slate-50 border border-border rounded-md px-3 py-2 text-xs font-mono text-slate-800 whitespace-pre-wrap break-all">
              {output || <span className="text-slate-400">暂无结果</span>}
            </pre>
          )}
        </div>
      </div>
    </PageShell>
  );
}
