import { useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { json, jsonParseLinter } from "@codemirror/lang-json";
import { linter } from "@codemirror/lint";
import { githubLight } from "@uiw/codemirror-theme-github";

const BASIC_SETUP = {
  lineNumbers: false,
  foldGutter: true,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
};

export default function JsonEditor({
  value,
  onChange,
  height = "100%",
  placeholder,
  className,
  resizable = false,
}) {
  const extensions = useMemo(() => [json(), linter(jsonParseLinter())], []);

  const handleKeyDown = (e) => {
    if (e.altKey && e.shiftKey && (e.key?.toLowerCase() === "f" || e.code === "KeyF")) {
      e.preventDefault();
      e.stopPropagation();
      try {
        const parsed = JSON.parse(value || "{}");
        const formatted = JSON.stringify(parsed, null, 2);
        onChange?.(formatted);
      } catch {
        // 格式化错误静默，由 CodeMirror lint / React Hook Form zod 校验处理
      }
    }
  };

  return (
    <div
      onKeyDown={handleKeyDown}
      className={`${resizable ? "resize-y overflow-hidden min-h-[80px]" : ""} ${className || ""}`}
      style={{ height }}
    >
      <CodeMirror
        value={value}
        onChange={onChange}
        extensions={extensions}
        placeholder={placeholder}
        basicSetup={BASIC_SETUP}
        height="100%"
        style={{ height: "100%" }}
        theme={githubLight}
      />
    </div>
  );
}
