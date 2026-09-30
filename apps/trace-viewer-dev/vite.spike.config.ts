import { defineConfig, mergeConfig } from "vite";

import base from "./vite.config";

export default mergeConfig(
  base,
  defineConfig({
    build: {
      outDir: "dist-spike",
      emptyOutDir: true,
      assetsInlineLimit: 0,
      rollupOptions: { input: "spike.html" },
    },
  }),
);
