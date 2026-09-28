import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { canonicalJson } from "./canonical-json.js";
import { EvidenceFactSchema } from "./evidence.js";

// Rebuilds every object with its keys inserted in reverse order. A null prototype keeps an
// own "__proto__" key as data instead of setting the prototype.
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(source).reverse()) {
    out[key] = reverseKeys(source[key]);
  }
  return out;
}

describe("canonicalJson", () => {
  it("sorts keys at every depth and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}',
    );
  });

  it("drops undefined properties", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it("throws a TypeError for a value with no JSON form", () => {
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
  });

  it("keeps an own __proto__ key as data", () => {
    expect(canonicalJson(JSON.parse('{"__proto__":1}'))).toBe('{"__proto__":1}');
  });

  it("gives a collector-ordered fact and its zod-parsed copy one string (R3)", () => {
    // Collectors emit ts last; zod rebuilds the object in schema order (ts fourth).
    const collectorOrder = {
      type: "git_hunk",
      repoId: "repo_1",
      sessionId: "sess_1",
      file: "src/a.ts",
      added: 3,
      removed: 1,
      isFormattingOnly: false,
      isConfigOnly: false,
      isLockfile: false,
      ts: "2026-09-28T10:00:00.000Z",
    };
    const stored = EvidenceFactSchema.parse(collectorOrder);
    expect(JSON.stringify(stored)).not.toBe(JSON.stringify(collectorOrder));
    expect(canonicalJson(stored)).toBe(canonicalJson(collectorOrder));
  });

  it("depends only on the key set, never on insertion order", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(canonicalJson(reverseKeys(value))).toBe(canonicalJson(value));
      }),
    );
  });

  it("is a fixed point: re-canonicalizing its own output changes nothing", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const once = canonicalJson(value);
        expect(canonicalJson(JSON.parse(once))).toBe(once);
      }),
    );
  });
});
