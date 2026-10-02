import { describe, expect, it } from "vitest";

import { clipText, countLanguages, isConfigFile, isTestPath, languageOf, mainLanguage } from "./paths.js";

describe("languageOf", () => {
  it.each([
    ["src/a.ts", "TypeScript"],
    ["src/App.tsx", "TypeScript"],
    ["types/global.d.ts", "TypeScript"],
    ["lib/x.mjs", "JavaScript"],
    ["package.json", "JSON"],
    ["app/server.py", "Python"],
    ["README.md", "Markdown"],
    ["Dockerfile", null],
    [".gitignore", null],
  ])("maps %s to %s", (path, language) => {
    expect(languageOf(path)).toBe(language);
  });
});

describe("isTestPath", () => {
  it.each([
    ["src/a.test.ts", true],
    ["src/a.spec.tsx", true],
    ["src/__tests__/a.ts", true],
    ["tests/test_server.py", true],
    ["packages/x/test/helpers.ts", true],
    ["src/attest.ts", false],
    ["src/testing/a.ts", false],
  ])("%s → %s", (path, expected) => {
    expect(isTestPath(path)).toBe(expected);
  });
});

describe("isConfigFile", () => {
  it.each([
    ["vite.config.ts", true],
    ["configs/eslint.config.mjs", true],
    ["tsconfig.base.json", true],
    ["package.json", true],
    [".prettierrc", true],
    [".eslintrc.json", true],
    ["src/config.ts", false],
    ["README.md", false],
  ])("%s → %s", (path, expected) => {
    expect(isConfigFile(path)).toBe(expected);
  });
});

describe("mainLanguage", () => {
  it("prefers a code language over more numerous docs and data", () => {
    expect(mainLanguage(countLanguages(["Markdown", "Markdown", "JSON", "TypeScript", null]))).toBe("TypeScript");
  });

  it("falls back to the most frequent language, ties to the smaller name", () => {
    expect(mainLanguage(countLanguages(["TOML", "Markdown"]))).toBe("Markdown");
    expect(mainLanguage(countLanguages([null]))).toBeNull();
  });
});

describe("clipText", () => {
  it("keeps short text and cuts long text to the limit with an ellipsis", () => {
    expect(clipText("abc", 3)).toBe("abc");
    expect(clipText("abcdef", 4)).toBe("abc…");
  });

  it("never leaves half of a surrogate pair at the cut", () => {
    const clipped = clipText("ab😀cd", 4);
    expect(clipped).toBe("ab…");
    expect(clipped.length).toBeLessThanOrEqual(4);
  });
});
