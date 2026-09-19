import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { nodeBuiltinStub } from "./vite-node-stub-plugin.js";

export default defineConfig({
  base: "./",
  plugins: [react(), nodeBuiltinStub()],
  build: {
    outDir: "dist/renderer",
    emptyOutDir: false,
    rollupOptions: {
      input: "src/renderer/index.html",
    },
  },
});
