import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Same policy as apps/desktop/src/renderer/index.html.
const ELECTRON_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'";
const NODE_BUILTINS = new Set(builtinModules);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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

// Serve only: HMR over the viewer's source. Build and every test use the package's dist.
// A plugin with apply "serve", not a callback config: the default export stays an object, so
// C1-7's vite.spike.config.ts can keep calling mergeConfig(base, …) (Vite 5 throws
// "Cannot merge config in form of callback" on a function config).
function serveViewerSource(): Plugin {
  return {
    name: "jevcode-serve-viewer-source",
    apply: "serve",
    config() {
      return {
        resolve: {
          alias: [
            {
              find: /^@jevcode\/trace-viewer$/,
              replacement: path.join(REPO_ROOT, "packages/trace-viewer/src/index.ts"),
            },
          ],
        },
      };
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), forbidNodeBuiltins(), electronCsp(), serveViewerSource()],
  // assetsInlineLimit: 0 keeps assets as files: the Electron CSP (default-src 'self') blocks data: URIs.
  build: { outDir: "dist", emptyOutDir: true, assetsInlineLimit: 0 },
});
