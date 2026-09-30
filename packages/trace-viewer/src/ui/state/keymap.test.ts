import { describe, expect, it } from "vitest";

import { resolveKey, type KeyContext, type KeyInput } from "./keymap.js";

const key = (code: string, extra: Partial<KeyInput> = {}): KeyInput => ({
  code, key: extra.key ?? code, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false,
  isComposing: false, editableTarget: false, ...extra,
});
const hybrid: KeyContext = { view: "hybrid", spaceOverPannable: true, hasTextSelection: false };
const canvas: KeyContext = { view: "canvas", spaceOverPannable: true, hasTextSelection: false };

describe("resolveKey (spec §7.9, R21)", () => {
  it("matches event.code, so a Hangul input source still moves", () => {
    expect(resolveKey(key("KeyJ", { key: "ㅓ" }), hybrid, "down")).toEqual({ cmd: "item", dir: 1 });
    expect(resolveKey(key("KeyK", { key: "ㅏ" }), hybrid, "down")).toEqual({ cmd: "item", dir: -1 });
  });

  it("ignores IME composition, editable targets and unlisted modifiers", () => {
    expect(resolveKey(key("KeyJ", { isComposing: true }), hybrid, "down")).toBeNull();
    expect(resolveKey(key("KeyJ", { editableTarget: true }), hybrid, "down")).toBeNull();
    expect(resolveKey(key("KeyJ", { ctrlKey: true }), hybrid, "down")).toBeNull();
    expect(resolveKey(key("KeyJ", { metaKey: true }), hybrid, "down")).toBeNull();
    expect(resolveKey(key("KeyJ", { altKey: true }), hybrid, "down")).toBeNull();
  });

  it("maps shifted letters and digits", () => {
    expect(resolveKey(key("KeyJ", { shiftKey: true }), hybrid, "down")).toEqual({ cmd: "chapter", dir: 1 });
    expect(resolveKey(key("KeyN", { shiftKey: true }), hybrid, "down")).toEqual({ cmd: "finding", dir: -1 });
    expect(resolveKey(key("KeyG", { shiftKey: true }), hybrid, "down")).toEqual({ cmd: "last" });
    expect(resolveKey(key("Digit1"), hybrid, "down")).toEqual({ cmd: "view", view: "canvas" });
    expect(resolveKey(key("Digit2"), canvas, "down")).toEqual({ cmd: "view", view: "hybrid" });
    expect(resolveKey(key("Digit1", { shiftKey: true }), hybrid, "down")).toEqual({ cmd: "fit", target: "all" });
    expect(resolveKey(key("Digit2", { shiftKey: true }), hybrid, "down")).toEqual({ cmd: "fit", target: "selection" });
    expect(resolveKey(key("Digit2", { altKey: true }), hybrid, "down")).toEqual({ cmd: "level", level: "chapter" });
    expect(resolveKey(key("Digit3", { altKey: true }), hybrid, "down")).toEqual({ cmd: "level", level: "step" });
  });

  it("brackets move turns; braces and b edit the brush only in Hybrid", () => {
    expect(resolveKey(key("BracketLeft"), canvas, "down")).toEqual({ cmd: "turn", dir: -1 });
    expect(resolveKey(key("BracketRight"), canvas, "down")).toEqual({ cmd: "turn", dir: 1 });
    expect(resolveKey(key("BracketLeft", { shiftKey: true }), hybrid, "down")).toEqual({ cmd: "brushEdge", edge: "from" });
    expect(resolveKey(key("BracketRight", { shiftKey: true }), hybrid, "down")).toEqual({ cmd: "brushEdge", edge: "to" });
    expect(resolveKey(key("KeyB"), hybrid, "down")).toEqual({ cmd: "brushChapter" });
    expect(resolveKey(key("BracketLeft", { shiftKey: true }), canvas, "down")).toBeNull();
    expect(resolveKey(key("KeyB"), canvas, "down")).toBeNull();
  });

  it("Space pans only over a pannable surface, on down and up", () => {
    expect(resolveKey(key("Space"), hybrid, "down")).toEqual({ cmd: "space", down: true });
    expect(resolveKey(key("Space"), hybrid, "up")).toEqual({ cmd: "space", down: false });
    expect(resolveKey(key("Space"), { ...hybrid, spaceOverPannable: false }, "down")).toBeNull();
    expect(resolveKey(key("KeyJ"), hybrid, "up")).toBeNull();
  });

  it("Cmd or Ctrl+C copies the review note only without a text selection", () => {
    expect(resolveKey(key("KeyC", { metaKey: true }), hybrid, "down")).toEqual({ cmd: "copyNote" });
    expect(resolveKey(key("KeyC", { ctrlKey: true }), hybrid, "down")).toEqual({ cmd: "copyNote" });
    expect(resolveKey(key("KeyC", { metaKey: true }), { ...hybrid, hasTextSelection: true }, "down")).toBeNull();
    expect(resolveKey(key("KeyC"), hybrid, "down")).toBeNull();
  });

  it("covers the rest of the table", () => {
    const cases: [KeyInput, unknown][] = [
      [key("KeyN"), { cmd: "finding", dir: 1 }],
      [key("Enter"), { cmd: "toggle" }],
      [key("NumpadEnter"), { cmd: "toggle" }],
      [key("Escape"), { cmd: "esc" }],
      [key("Comma"), { cmd: "playhead", dir: -1 }],
      [key("Period"), { cmd: "playhead", dir: 1 }],
      [key("KeyG"), { cmd: "first" }],
      [key("Minus"), { cmd: "zoom", op: "out" }],
      [key("Equal"), { cmd: "zoom", op: "in" }],
      [key("Equal", { shiftKey: true }), { cmd: "zoom", op: "in" }],
      [key("Digit0"), { cmd: "zoom", op: "preset" }],
      [key("KeyV"), { cmd: "tool", tool: "select" }],
      [key("KeyH"), { cmd: "tool", tool: "hand" }],
      [key("Slash"), { cmd: "search" }],
      [key("Slash", { shiftKey: true }), { cmd: "help" }],
      [key("F6"), { cmd: "region", dir: 1 }],
      [key("F6", { shiftKey: true }), { cmd: "region", dir: -1 }],
      [key("KeyQ"), null],
    ];
    for (const [input, expected] of cases) expect(resolveKey(input, hybrid, "down"), input.code).toEqual(expected);
  });
});
