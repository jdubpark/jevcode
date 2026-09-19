import { symbolId, type SymbolInfo } from "@jevcode/contracts";
import { describe, expect, it } from "vitest";

import {
  diffSymbols,
  hasDelta,
  symbolIdForPath,
  symbolKey,
} from "./symbol-diff.js";

function sym(
  name: string,
  kind: SymbolInfo["kind"] = "function",
  signature = `${name}(): void`,
): SymbolInfo {
  return { name, kind, signature, startLine: 1, endLine: 3 };
}

describe("symbolIdForPath", () => {
  it("is stable for the same signature", () => {
    const a = symbolIdForPath("src/a.ts", sym("foo"));
    const b = symbolIdForPath("src/a.ts", sym("foo"));
    expect(a).toBe(b);
  });

  it("matches the contracts symbolId format", () => {
    const info = sym("foo");
    expect(symbolIdForPath("src/a.ts", info)).toBe(
      symbolId("src/a.ts", "foo", "function", "foo(): void"),
    );
  });

  it("changes when the signature changes", () => {
    const a = symbolIdForPath("src/a.ts", sym("foo", "function", "foo(): void"));
    const b = symbolIdForPath("src/a.ts", sym("foo", "function", "foo(x: number): void"));
    expect(a).not.toBe(b);
  });
});

describe("diffSymbols", () => {
  it("classifies added symbols", () => {
    const delta = diffSymbols([sym("a")], [sym("a"), sym("b")], "src/x.ts");
    expect(delta.added.map((s) => s.name)).toEqual(["b"]);
    expect(delta.removed).toEqual([]);
    expect(delta.modified).toEqual([]);
  });

  it("classifies removed symbols", () => {
    const delta = diffSymbols([sym("a"), sym("b")], [sym("b")], "src/x.ts");
    expect(delta.removed.map((s) => s.name)).toEqual(["a"]);
    expect(delta.added).toEqual([]);
    expect(delta.modified).toEqual([]);
  });

  it("classifies modified symbols by signature hash change", () => {
    const delta = diffSymbols(
      [sym("foo", "function", "foo(): void")],
      [sym("foo", "function", "foo(a: number): void")],
      "src/x.ts",
    );
    expect(delta.modified.map((s) => s.name)).toEqual(["foo"]);
    expect(delta.added).toEqual([]);
    expect(delta.removed).toEqual([]);
  });

  it("treats same name+kind+signature as unchanged", () => {
    const delta = diffSymbols([sym("foo")], [sym("foo")], "src/x.ts");
    expect(hasDelta(delta)).toBe(false);
  });

  it("treats same name with different kind as add+remove", () => {
    const delta = diffSymbols(
      [sym("foo", "function")],
      [sym("foo", "class")],
      "src/x.ts",
    );
    expect(delta.added.map((s) => `${s.name}:${s.kind}`)).toEqual(["foo:class"]);
    expect(delta.removed.map((s) => `${s.name}:${s.kind}`)).toEqual(["foo:function"]);
    expect(delta.modified).toEqual([]);
  });

  it("is empty for identical parse results", () => {
    const base = [sym("a"), sym("b", "class")];
    expect(diffSymbols(base, base, "src/x.ts")).toEqual({
      added: [],
      removed: [],
      modified: [],
    });
  });
});

describe("symbolKey", () => {
  it("pairs name with kind", () => {
    expect(symbolKey(sym("foo", "function"))).toBe("foo\u0000function");
    expect(symbolKey(sym("foo", "class"))).not.toBe(symbolKey(sym("foo", "function")));
  });
});
