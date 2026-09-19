import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

import { nodeBuiltinStub } from "./vite-node-stub-plugin.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [nodeBuiltinStub()],
  resolve: {
    alias: {
      "node:crypto": path.join(dirname, "src/preload/stubs/node-crypto.ts"),
    },
  },
  build: {
    outDir: "dist/preload",
    emptyOutDir: true,
    lib: {
      entry: "src/preload/index.ts",
      formats: ["cjs"],
      fileName: () => "index.cjs",
    },
    rollupOptions: {
      external: ["electron"],
    },
  },
});
