import { describe, expect, it } from "vitest";

import { GitHunkDiffSchema } from "@jevcode/contracts";

import { diffBytes, diffHash, notCapturedDiff } from "./diff.js";

describe("diffHash", () => {
  it("is the first 16 hex chars of sha256 over the raw diff", () => {
    expect(diffHash("")).toBe("e3b0c44298fc1c14");
    expect(diffHash("abc")).toBe("ba7816bf8f01cfea");
  });
});

describe("diffBytes", () => {
  it("counts UTF-8 bytes, not UTF-16 code units", () => {
    expect(diffBytes("abc")).toBe(3);
    expect(diffBytes("héllo")).toBe(6);
  });
});

describe("notCapturedDiff", () => {
  it("records hash and size but no text", () => {
    const diff = notCapturedDiff("src/app.ts", "abc");
    expect(diff).toEqual({
      hash: "ba7816bf8f01cfea",
      bytes: 3,
      truncated: false,
      redactions: 0,
      withheld: "not_captured",
    });
    expect(GitHunkDiffSchema.safeParse(diff).success).toBe(true);
  });
});
