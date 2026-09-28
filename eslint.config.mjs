import js from "@eslint/js";
import tseslint from "typescript-eslint";

const nodeGlobals = {
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  setImmediate: "readonly",
  clearImmediate: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  global: "readonly",
  structuredClone: "readonly",
  fetch: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  MessageChannel: "readonly",
  Worker: "readonly",
  performance: "readonly",
  queueMicrotask: "readonly",
};

const browserGlobals = {
  window: "readonly",
  document: "readonly",
  navigator: "readonly",
  HTMLElement: "readonly",
  Event: "readonly",
  CustomEvent: "readonly",
  localStorage: "readonly",
  sessionStorage: "readonly",
  requestAnimationFrame: "readonly",
  cancelAnimationFrame: "readonly",
  ResizeObserver: "readonly",
  MutationObserver: "readonly",
};

const NODE_BUILTIN_REGEX =
  "^(assert|buffer|child_process|crypto|events|fs|http|https|net|os|path|process|stream|url|util|worker_threads|zlib)(/.*)?$";

const BROWSER_SAFE_PATTERNS = [
  { regex: "^node:", message: "Browser-safe code: no Node built-ins." },
  { regex: NODE_BUILTIN_REGEX, message: "Browser-safe code: no Node built-ins." },
  { regex: "^electron(/.*)?$", message: "The trace viewer never touches Electron; hosts inject a TraceSource." },
  {
    regex: "^@jevcode/(storage|semantic-core|evidence-engine|jev-router|telemetry|ui-compiler|agent-[a-z-]+)(/.*)?$",
    message: "The trace viewer reads TraceRows only; it never imports pipeline or storage packages.",
  },
];

const TRACE_VIEWER_PATHS = [
  { name: "@jevcode/ui-catalog", message: "Import one component through @jevcode/ui-catalog/components/<Name>." },
  { name: "@jevcode/contracts/node", message: "Node-only helper; not for browser code." },
];

const NO_NETWORK_GLOBALS = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"].map((name) => ({
  name,
  message: "The trace viewer reads only through its TraceSource.",
}));

// Declared in nodeGlobals above for Node packages; undefined in the Electron trace window.
const NO_NODE_GLOBALS = ["process", "Buffer", "require", "global", "__dirname", "__filename", "setImmediate", "clearImmediate"].map(
  (name) => ({ name, message: "Browser-safe code: no Node globals." }),
);

const LAYOUT_PURE_GLOBALS = [
  "window", "document", "navigator", "requestAnimationFrame", "cancelAnimationFrame",
  "ResizeObserver", "MutationObserver", "getComputedStyle", "localStorage", "sessionStorage",
  "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date",
].map((name) => ({
  name,
  message: "src/layout is pure: no DOM, timers or clocks; take time as numbers (R19).",
}));

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/.jevcode/**",
      "fixtures/**",
      "scripts/**",
      "apps/**/scripts/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["packages/**/*.ts", "apps/**/*.ts", "apps/**/*.tsx", "packages/**/*.cjs", "apps/**/*.cjs"],
    languageOptions: {
      globals: { ...nodeGlobals, ...browserGlobals },
    },
    rules: {
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["packages/**/*.cjs", "apps/**/*.cjs", "packages/**/*.mjs", "apps/**/*.mjs", "scripts/**/*.mjs", "evals/**/*.mjs"],
    languageOptions: {
      globals: { ...nodeGlobals, require: "readonly", module: "readonly", exports: "readonly", __filename: "readonly", __dirname: "readonly" },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    files: ["packages/trace-viewer/src/**/*.ts", "packages/trace-viewer/src/**/*.tsx"],
    ignores: [
      "packages/trace-viewer/src/**/*.test.ts",
      "packages/trace-viewer/src/**/*.test.tsx",
      "packages/trace-viewer/src/**/*.bench.ts",
      "packages/trace-viewer/src/test-support/**",
    ],
    rules: {
      "no-restricted-imports": ["error", { paths: TRACE_VIEWER_PATHS, patterns: BROWSER_SAFE_PATTERNS }],
      "no-restricted-globals": ["error", ...NO_NETWORK_GLOBALS, ...NO_NODE_GLOBALS],
    },
  },
  {
    files: ["packages/trace-viewer/src/model/**/*.ts"],
    ignores: ["packages/trace-viewer/src/model/**/*.test.ts", "packages/trace-viewer/src/model/**/*.bench.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: TRACE_VIEWER_PATHS,
        patterns: [
          ...BROWSER_SAFE_PATTERNS,
          { regex: "^react(-dom)?(/.*)?$", message: "src/model is React-free (R7)." },
          { regex: "^@(xyflow|tanstack)/", message: "src/model is React-free (R7)." },
          { regex: "^@jevcode/ui-catalog(/.*)?$", message: "src/model is React-free (R7)." },
          { regex: "(^|/)ui(/|$)", message: "src/model never imports src/ui." },
          { regex: "(^|/)layout(/|$)", message: "src/model never imports src/layout (R19)." },
        ],
      }],
      "no-restricted-globals": ["error", ...NO_NETWORK_GLOBALS, ...NO_NODE_GLOBALS],
    },
  },
  {
    files: ["packages/trace-viewer/src/layout/**/*.ts"],
    ignores: [
      "packages/trace-viewer/src/layout/**/*.test.ts",
      "packages/trace-viewer/src/layout/**/*.bench.ts",
    ],
    rules: {
      "no-restricted-imports": ["error", {
        paths: TRACE_VIEWER_PATHS,
        patterns: [
          ...BROWSER_SAFE_PATTERNS,
          { regex: "^react(-dom)?(/.*)?$", message: "src/layout is React-free (R19)." },
          { regex: "^@(xyflow|tanstack)/", message: "src/layout is React-free (R19)." },
          { regex: "^d3-", message: "src/layout is pure; d3 belongs in ui/viewport (R17)." },
          { regex: "^@jevcode/ui-catalog(/.*)?$", message: "src/layout is React-free (R19)." },
          { regex: "(^|/)ui(/|$)", message: "src/layout never imports src/ui (R19)." },
        ],
      }],
      "no-restricted-globals": ["error", ...NO_NETWORK_GLOBALS, ...NO_NODE_GLOBALS, ...LAYOUT_PURE_GLOBALS],
    },
  },
);
