import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// React Compiler：自动 memo 化所有组件 + hook 返回值，
// 替代手写 useMemo/useCallback/React.memo。target 19 = 运行时是 React 19。
const ReactCompilerConfig = { target: "19" };

export default defineConfig({
  base: "./",
  plugins: [
    tailwindcss(),
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler", ReactCompilerConfig]],
      },
    }),
  ],
  // RHF / CodeMirror 这类库被 vite 预打包时如果有自己的 React 解析，
  // 会导致渲染时出现两份 React 实例 → "Invalid hook call"。dedupe 强制单实例。
  //
  // CodeMirror 的 @codemirror/state / @codemirror/view 是单例库：多个 codemirror
  // 子包（react-codemirror / lang-json / lint / theme-github）在 pnpm 下各自带一份
  // state 的软链，预打包/分包时可能产出两份拷贝，导致 facet 的 instanceof 失败 →
  // "Unrecognized extension value... multiple instances of @codemirror/state"。
  // 一并 dedupe 强制单实例。
  resolve: {
    dedupe: ["react", "react-dom", "@codemirror/state", "@codemirror/view"],
  },
  server: {
    port: 5100,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
