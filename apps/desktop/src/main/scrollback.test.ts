import { describe, expect, it } from "vitest";

import { ScrollbackBuffer } from "./scrollback.js";

describe("ScrollbackBuffer", () => {
  it("splits chunks into lines and preserves the partial line", () => {
    const buffer = new ScrollbackBuffer(10);
    buffer.push("hello\nwor");
    buffer.push("ld\nline3");
    expect(buffer.get()).toEqual(["hello", "world"]);
    expect(buffer.length).toBe(2);
  });

  it("caps the buffer at maxLines, dropping the oldest lines", () => {
    const buffer = new ScrollbackBuffer(3);
    for (let i = 1; i <= 10; i += 1) {
      buffer.push(`line ${i}\n`);
    }
    expect(buffer.get()).toEqual(["line 8", "line 9", "line 10"]);
    expect(buffer.length).toBe(3);
  });

  it("supports latest-N reads", () => {
    const buffer = new ScrollbackBuffer(100);
    buffer.push("a\nb\nc\nd\n");
    expect(buffer.get(2)).toEqual(["c", "d"]);
    expect(buffer.get()).toEqual(["a", "b", "c", "d"]);
  });

  it("rejects non-positive maxLines", () => {
    expect(() => new ScrollbackBuffer(0)).toThrow(RangeError);
    expect(() => new ScrollbackBuffer(-5)).toThrow(RangeError);
  });

  it("clears lines and the partial tail", () => {
    const buffer = new ScrollbackBuffer(10);
    buffer.push("partial");
    buffer.clear();
    buffer.push("x\n");
    expect(buffer.get()).toEqual(["x"]);
  });
});
