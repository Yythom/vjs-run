import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * 极简 lint：
 *   - eslint-plugin-react-hooks v7 的 recommended-latest 包含所有
 *     React Compiler bailout 检测（set-state-in-effect / purity / immutability …）
 *   - 不引入大而全的代码风格规则
 */
export default [
  {
    // 构建产物 / 依赖不参与 lint
    ignores: ["dist/**", "node_modules/**"],
  },
  js.configs.recommended,
  reactHooks.configs.flat["recommended-latest"],
  {
    files: ["src/**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        requestAnimationFrame: "readonly",
        queueMicrotask: "readonly",
        ResizeObserver: "readonly",
        Blob: "readonly",
        URL: "readonly",
        Map: "readonly",
        btoa: "readonly",
        atob: "readonly",
        Set: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
];
