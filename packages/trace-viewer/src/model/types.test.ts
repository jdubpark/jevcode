import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  LANES,
  LEVELS,
  STABLE_ID_KINDS,
  StableIdSchema,
  decisionStableId,
  fileStableId,
  findingStableId,
  parseStableId,
  stepStableId,
  unitStableId,
} from "./types.js";

describe("stable ids (R9)", () => {
  it("formats step ids from the first seq and rejects non-positive or fractional seqs", () => {
    expect(stepStableId(12)).toBe("step:12");
    expect(() => stepStableId(0)).toThrow(RangeError);
    expect(() => stepStableId(1.5)).toThrow(RangeError);
  });

  it("keeps fixture decision ids with hyphens", () => {
    expect(decisionStableId("dec-oauth-0001")).toBe("decision:dec-oauth-0001");
  });

  it("treats everything after the first colon as an opaque key", () => {
    const id = fileStableId("src/a:b.ts");
    expect(id).toBe("file:src/a:b.ts");
    expect(parseStableId(id)).toEqual({ kind: "file", key: "src/a:b.ts" });
  });

  it("formats finding ids as ruleId@version:anchorSeq", () => {
    expect(findingStableId("claim_contradicted", 1, 48)).toBe("finding:claim_contradicted@1:48");
    expect(() => findingStableId("claim_contradicted", 0, 48)).toThrow(RangeError);
  });

  it("rejects empty keys when building ids", () => {
    expect(() => unitStableId("")).toThrow(RangeError);
    expect(() => fileStableId("")).toThrow(RangeError);
  });

  it("returns null for strings that are not stable ids", () => {
    expect(parseStableId("step:0")).toBeNull();
    expect(parseStableId("step:x")).toBeNull();
    expect(parseStableId("chapter:1")).toBeNull();
    expect(parseStableId("unit:")).toBeNull();
    expect(StableIdSchema.safeParse("unit:").success).toBe(false);
  });

  it("round-trips a path with a line break", () => {
    // POSIX file names may contain "\n"; the id must still resolve.
    expect(parseStableId(fileStableId("docs/odd\nname.md"))).toEqual({ kind: "file", key: "docs/odd\nname.md" });
  });

  it("round-trips any non-empty key", () => {
    const builders = { unit: unitStableId, decision: decisionStableId, file: fileStableId } as const;
    const kinds = fc.constantFrom<keyof typeof builders>("unit", "decision", "file");
    // unit "binary" draws any code point, including line terminators and lone surrogates.
    fc.assert(
      fc.property(kinds, fc.string({ minLength: 1, unit: "binary" }), (kind, key) => {
        expect(parseStableId(builders[kind](key))).toEqual({ kind, key });
      }),
    );
    expect(parseStableId(stepStableId(7))).toEqual({ kind: "step", key: "7" });
  });

  it("names every kind the parser accepts", () => {
    expect(STABLE_ID_KINDS).toEqual(["step", "unit", "decision", "file", "finding"]);
  });
});

describe("vocabulary", () => {
  it("orders the Hybrid lanes top to bottom (R14)", () => {
    expect(LANES).toEqual(["supervisor", "agent", "commands", "edits", "tests", "jev"]);
  });

  it("orders the semantic zoom levels from coarse to fine (R20)", () => {
    expect(LEVELS).toEqual(["session", "chapter", "step"]);
  });
});
