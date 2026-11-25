import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import useResource from "../../hooks/use-resource";
import { unwrap } from "./ui";

// agent 消息和 log 证据都是 markdown。react-markdown 默认不渲染原始 HTML，没有 XSS 面

const isRemote = (src) => /^(https?:|data:)/i.test(src);
const isAbsolutePath = (src) => src.startsWith("/") || src.startsWith("~");

/** 证据里的截图：产物目录里的相对路径走 IPC 读成 data URL；其余只给路径，点了在访达里定位 */
export function EvidenceImage({ dir, src = "", alt }) {
  const local = Boolean(dir) && !isRemote(src) && !isAbsolutePath(src);
  const { data, error } = useResource(
    () => (local ? unwrap(window.electronAPI.rangeTestAsset({ dir, path: decodeURI(src) })) : null),
    [dir, src, local],
  );
  if (!local) {
    return (
      <button
        type="button"
        className="text-sky-700 underline underline-offset-2 cursor-pointer break-all text-left"
        title="不在产物目录里，界面不读；点了在访达里定位"
        onClick={() => window.electronAPI.rangeTestReveal({ path: src })}
      >
        [图片] {alt || src}
      </button>
    );
  }
  if (error) return <span className="text-red-600 break-all">[图片读取失败] {src}：{error.message}</span>;
  if (!data) return <span className="text-slate-400">[图片加载中] {src}</span>;
  return (
    <a href={data.dataUrl} target="_blank" rel="noreferrer">
      <img src={data.dataUrl} alt={alt || src} className="max-w-full rounded border border-border my-1" />
    </a>
  );
}

function ExternalLink({ href = "", children }) {
  return (
    <a
      href={href}
      className="text-sky-700 underline underline-offset-2 break-all"
      onClick={(e) => {
        // 渲染进程里点链接会把整个 app 导航走；http(s) 交给系统浏览器，其余不处理
        e.preventDefault();
        if (/^https?:/i.test(href)) window.electronAPI.openExternal(href);
      }}
    >
      {children}
    </a>
  );
}

/** dir：证据所在的产物目录，图片的相对路径相对它解析；agent 消息里不传 */
export default function Markdown({ children, dir }) {
  return (
    <div className="text-[12px] leading-relaxed text-slate-700 break-words space-y-2">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: ({ src, alt }) => <EvidenceImage dir={dir} src={src} alt={alt} />,
          a: ({ href, children: text }) => <ExternalLink href={href}>{text}</ExternalLink>,
          h1: ({ children: t }) => <div className="font-semibold text-slate-800 mt-2">{t}</div>,
          h2: ({ children: t }) => <div className="font-semibold text-slate-800 mt-2">{t}</div>,
          h3: ({ children: t }) => <div className="font-semibold text-slate-700 mt-2">{t}</div>,
          ul: ({ children: t }) => <ul className="list-disc pl-5 space-y-0.5">{t}</ul>,
          ol: ({ children: t }) => <ol className="list-decimal pl-5 space-y-0.5">{t}</ol>,
          pre: ({ children: t }) => (
            // 没写语言的代码块拿不到 className，会套上行内代码的样式，这里在 pre 里把它抹掉
            <pre className="bg-slate-900 text-slate-100 rounded-md p-2.5 overflow-x-auto text-[11px] leading-snug [&_code]:bg-transparent [&_code]:text-inherit [&_code]:p-0">
              {t}
            </pre>
          ),
          code: ({ className, children: t }) =>
            className ? (
              <code className={className}>{t}</code>
            ) : (
              <code className="bg-slate-100 text-slate-800 rounded px-1 py-px text-[11px] font-mono">{t}</code>
            ),
          table: ({ children: t }) => (
            <div className="overflow-x-auto">
              <table className="text-[11px] border-collapse">{t}</table>
            </div>
          ),
          th: ({ children: t }) => <th className="border border-border px-2 py-1 bg-slate-50 text-left">{t}</th>,
          td: ({ children: t }) => <td className="border border-border px-2 py-1 align-top">{t}</td>,
          blockquote: ({ children: t }) => <blockquote className="border-l-2 border-slate-300 pl-3 text-slate-500">{t}</blockquote>,
        }}
      >
        {children || ""}
      </ReactMarkdown>
    </div>
  );
}
