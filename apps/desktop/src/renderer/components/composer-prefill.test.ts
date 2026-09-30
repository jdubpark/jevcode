import { describe, expect, it } from "vitest";

import { appendPrefill, decidePrefill } from "./composer-prefill.js";

const NOTE = 'Re: trace s1 +0:43 "Claim contradicts tests" (seq 48; evidence seq 46)\n> all checks pass';

describe("appendPrefill", () => {
  it("uses the note as the whole draft when the composer is empty", () => {
    expect(appendPrefill("", "x")).toBe("x");
    expect(appendPrefill("\n\n", "x")).toBe("x");
  });

  it("keeps the draft and appends on a new line", () => {
    expect(appendPrefill("a\n\n", "x")).toBe("a\nx");
    expect(appendPrefill("Please also add a test", NOTE)).toBe(`Please also add a test\n${NOTE}`);
    expect(appendPrefill("  indented draft  ", "x")).toBe("  indented draft  \nx");
  });

  it("leaves bidi and control characters in the note untouched", () => {
    const note = "Re: ‮evil‬ `a‏b`";
    expect(appendPrefill("", note)).toBe(note);
  });
});

describe("decidePrefill", () => {
  it("applies a note for the active session to the draft", () => {
    expect(decidePrefill("s1", { sessionId: "s1", text: NOTE }, "draft")).toEqual({
      kind: "apply",
      draft: `draft\n${NOTE}`,
    });
  });

  it("a note for another session becomes a notice and leaves the draft alone", () => {
    expect(decidePrefill("s1", { sessionId: "s2", text: NOTE }, "draft")).toEqual({
      kind: "notice",
      sessionId: "s2",
    });
    expect(decidePrefill(null, { sessionId: "s2", text: NOTE }, "")).toEqual({
      kind: "notice",
      sessionId: "s2",
    });
  });
});
