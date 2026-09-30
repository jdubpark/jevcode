import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { nodeBuiltinStub } from "./vite-node-stub-plugin.js";

export default defineConfig({
  base: "./",
  plugins: [react(), nodeBuiltinStub()],
  build: {
    outDir: "dist/renderer",
    emptyOutDir: false,
    // default-src 'self' blocks data: URIs, so no asset may be inlined (spec §8.2).
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        main: "src/renderer/index.html",
        trace: "src/renderer/trace.html",
      },
    },
  },
});
