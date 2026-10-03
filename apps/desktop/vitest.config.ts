import { defineConfig } from "vitest/config";

export default defineConfig({
  // Renderer components use the automatic JSX runtime (tsconfig.web.json "react-jsx").
  esbuild: { jsx: "automatic" },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
