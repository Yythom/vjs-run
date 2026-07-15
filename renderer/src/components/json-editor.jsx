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

/**
 * 受控 JSON 编辑器 —— CodeMirror 6 包一层，提供语法高亮 + JSON lint。
 * 容器需要给固定/弹性高度；本组件不撑高，自身 height 由父决定。
 */
export default function JsonEditor({
  value,
  onChange,
  height = "100%",
  placeholder,
  className,
}) {
  const extensions = useMemo(() => [json(), linter(jsonParseLinter())], []);
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={extensions}
      placeholder={placeholder}
      basicSetup={BASIC_SETUP}
      height={height}
      // height prop 只作用于内部 .cm-editor；组件最外层的 .cm-theme wrapper 高度是
      // auto，导致 .cm-editor 的 100% 解析成内容高度——编辑器随内容无限撑高、被外层
      // overflow-hidden 裁掉，.cm-scroller 永远不滚（表现为滚轮失效）。把同一 height
      // 设到 wrapper 上，scroller 才真正受限并接管滚动。
      style={{ height }}
      theme={githubLight}
      className={className}
    />
  );
}
