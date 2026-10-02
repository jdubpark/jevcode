import { defineConfig } from "vitest/config";

export default defineConfig({
  // The root tsconfig has no jsx setting; renderer .tsx tests need the automatic runtime.
  esbuild: { jsx: "automatic" },
  test: {
    // Renderer component tests are .tsx and opt in with // @vitest-environment jsdom.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
