import { builtinModules } from "node:module";

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

// Every Node built-in module name, deduped to its top-level form (fs/promises -> fs) and
// stripped of the internal `_`-prefixed modules (_http_agent, _stream_wrap, …), which are not
// public import targets. (/.*)?$ below still bans real subpaths such as fs/promises directly.
const NODE_BUILTIN_NAMES = [
  ...new Set(builtinModules.filter((name) => !name.startsWith("_")).map((name) => name.split("/")[0])),
];
const NODE_BUILTIN_REGEX = `^(${NODE_BUILTIN_NAMES.join("|")})(/.*)?$`;
// Same coverage (node:-prefixed or bare, with subpaths) as one regex, for the dynamic-import
// selector below, which matches a string literal rather than an import-declaration specifier.
const NODE_BUILTIN_SPECIFIER_REGEX = `^(node:.*|(${NODE_BUILTIN_NAMES.join("|")})(/.*)?)$`;

const BROWSER_SAFE_PATTERNS = [
  { regex: "^node:", message: "Browser-safe code: no Node built-ins." },
  { regex: NODE_BUILTIN_REGEX, message: "Browser-safe code: no Node built-ins." },
  { regex: "^electron(/.*)?$", message: "The trace viewer never touches Electron; hosts inject a TraceSource." },
  {
    regex: "^@jevcode/(storage|semantic-core|evidence-engine|jev-router|telemetry|ui-compiler|agent-[a-z-]+)(/.*)?$",
    message: "The trace viewer reads TraceRows only; it never imports pipeline or storage packages.",
  },
];

// R17: only the CodeDiff component may be imported from @jevcode/ui-catalog; every other
// subpath (and the bare specifier, banned separately below via TRACE_VIEWER_PATHS) is banned.
const UI_CATALOG_SUBPATH_BAN = {
  regex: "^@jevcode/ui-catalog/(?!components/CodeDiff$)",
  message: "Only @jevcode/ui-catalog/components/CodeDiff may be imported (R17).",
};

// A no-restricted-syntax selector banning dynamic `import("node:…")` / `import("fs")`, which
// no-restricted-imports does not inspect (it only checks static import/export declarations).
const NODE_BUILTIN_DYNAMIC_IMPORT_BANS = [
  {
    selector: `ImportExpression[source.value=/${NODE_BUILTIN_SPECIFIER_REGEX.replace(/\//g, "\\/")}/]`,
    message: "Browser-safe code: no Node built-ins (dynamic import).",
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

// Trust boundary (spec §3.3(2), §9): the trace viewer never touches window.jevcode or the
// network. no-restricted-globals (above) bans the bare identifiers (`fetch(...)`); this bans
// the same names reached through `window.` or `globalThis.` (`window.fetch(...)`), which
// no-restricted-globals does not see because `window`/`globalThis` themselves are not banned.
const RESTRICTED_WINDOW_PROPERTIES = [
  { property: "jevcode", message: "The trace viewer never touches window.jevcode; it reads only through its TraceSource (spec §3.3)." },
  { property: "fetch", message: "The trace viewer reads only through its TraceSource; no network access (spec §3.3)." },
  { property: "WebSocket", message: "The trace viewer reads only through its TraceSource; no network access (spec §3.3)." },
  { property: "XMLHttpRequest", message: "The trace viewer reads only through its TraceSource; no network access (spec §3.3)." },
  { property: "EventSource", message: "The trace viewer reads only through its TraceSource; no network access (spec §3.3)." },
];

const NO_RESTRICTED_WINDOW_GLOBAL_PROPERTIES = ["window", "globalThis"].flatMap((object) =>
  RESTRICTED_WINDOW_PROPERTIES.map(({ property, message }) => ({ object, property, message })),
);

// R7/§6.1: the model has no clock or randomness. src/ui may use these freely, so this list is
// added only to the src/model block, never to the general trace-viewer or src/ui rules.
const CLOCK_AND_RANDOM_PROPERTIES = [
  { object: "Date", property: "now", message: "src/model has no clock (spec §6.1); take time as data." },
  { object: "Math", property: "random", message: "src/model has no randomness (spec §6.1)." },
  { object: "performance", property: "now", message: "src/model has no clock (spec §6.1); take time as data." },
];

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
      "apps/trace-viewer-dev/dist-spike/**",
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
    files: ["packages/contracts/src/**/*.ts"],
    ignores: ["packages/contracts/src/node.ts", "packages/contracts/src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          regex: "^node:",
          message: "The @jevcode/contracts barrel is browser-safe; put Node-only helpers in src/node.ts (@jevcode/contracts/node).",
        }],
      }],
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
      "no-restricted-imports": ["error", {
        paths: TRACE_VIEWER_PATHS,
        patterns: [...BROWSER_SAFE_PATTERNS, UI_CATALOG_SUBPATH_BAN],
      }],
      "no-restricted-globals": ["error", ...NO_NETWORK_GLOBALS, ...NO_NODE_GLOBALS],
      "no-restricted-properties": ["error", ...NO_RESTRICTED_WINDOW_GLOBAL_PROPERTIES],
      "no-restricted-syntax": ["error", ...NODE_BUILTIN_DYNAMIC_IMPORT_BANS],
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
      "no-restricted-properties": ["error", ...NO_RESTRICTED_WINDOW_GLOBAL_PROPERTIES, ...CLOCK_AND_RANDOM_PROPERTIES],
      "no-restricted-syntax": ["error", ...NODE_BUILTIN_DYNAMIC_IMPORT_BANS],
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
      "no-restricted-properties": ["error", ...NO_RESTRICTED_WINDOW_GLOBAL_PROPERTIES],
      "no-restricted-syntax": ["error", ...NODE_BUILTIN_DYNAMIC_IMPORT_BANS],
    },
  },
  {
    // Spec §4.2: the codebase-map core is pure TypeScript with no Node built-ins. Node-only
    // scanning lives in src/node, which only desktop main imports.
    files: ["packages/codebase-map/src/core/**/*.ts"],
    ignores: ["packages/codebase-map/src/core/**/*.test.ts", "packages/codebase-map/src/core/**/*.bench.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { regex: "^node:", message: "codebase-map core is pure: no Node built-ins (spec §4.2)." },
          { regex: NODE_BUILTIN_REGEX, message: "codebase-map core is pure: no Node built-ins (spec §4.2)." },
          { regex: "^electron(/.*)?$", message: "codebase-map core is pure (spec §4.2)." },
          { regex: "(^|/)node(/|$)", message: "src/core never imports src/node or Node-only entry points." },
        ],
      }],
      "no-restricted-globals": ["error", ...NO_NODE_GLOBALS],
      "no-restricted-syntax": ["error", ...NODE_BUILTIN_DYNAMIC_IMPORT_BANS],
    },
  },
);
