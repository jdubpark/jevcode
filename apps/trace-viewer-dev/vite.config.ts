import { builtinModules } from "node:module";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Same policy as apps/desktop/src/renderer/index.html.
const ELECTRON_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'";
const NODE_BUILTINS = new Set(builtinModules);

// Fails the build on any Node built-in in the browser graph: the browser-safety proof.
function forbidNodeBuiltins(): Plugin {
  return {
    name: "jevcode-forbid-node-builtins",
    enforce: "pre",
    resolveId(source, importer) {
      if (source.startsWith("node:") || NODE_BUILTINS.has(source)) {
        this.error(
          `browser bundle imports "${source}" from ${importer ?? "the entry"}; the trace viewer must stay browser-safe`,
        );
      }
      return null;
    },
  };
}

// Build and preview only: the dev server's React refresh preamble is inline script.
function electronCsp(): Plugin {
  return {
    name: "jevcode-electron-csp",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace(
        "<head>",
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${ELECTRON_CSP}" />`,
      );
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), forbidNodeBuiltins(), electronCsp()],
  // The CSP's default-src 'self' blocks data: URIs, so no asset may be inlined.
  build: { outDir: "dist", emptyOutDir: true, assetsInlineLimit: 0 },
});
