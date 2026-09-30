import type { Level } from "../../model/index.js";
import type { Tool, ViewKind } from "./view-state.js";

export interface KeyInput {
  code: string;
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  isComposing: boolean;
  /** input, textarea or [contenteditable] target. */
  editableTarget: boolean;
}
export interface KeyContext { view: ViewKind; spaceOverPannable: boolean; hasTextSelection: boolean }
export type KeyCommand =
  | { cmd: "item"; dir: 1 | -1 }
  | { cmd: "chapter"; dir: 1 | -1 }
  | { cmd: "turn"; dir: 1 | -1 }
  | { cmd: "finding"; dir: 1 | -1 }
  | { cmd: "toggle" }
  | { cmd: "esc" }
  | { cmd: "view"; view: ViewKind }
  | { cmd: "level"; level: Level }
  | { cmd: "playhead"; dir: 1 | -1 }
  | { cmd: "first" }
  | { cmd: "last" }
  | { cmd: "zoom"; op: "out" | "in" | "preset" }
  | { cmd: "fit"; target: "all" | "selection" }
  | { cmd: "tool"; tool: Tool }
  | { cmd: "space"; down: boolean }
  | { cmd: "brushEdge"; edge: "from" | "to" }
  | { cmd: "brushChapter" }
  | { cmd: "search" }
  | { cmd: "help" }
  | { cmd: "region"; dir: 1 | -1 }
  | { cmd: "copyNote" };

export const ZOOM_STEP = 1.25;

const LEVEL_OF_DIGIT: Readonly<Record<string, Level>> = { Digit1: "session", Digit2: "chapter", Digit3: "step" };

/** Pure; null when the key is not a viewer command in this context. Matches on event.code. */
export function resolveKey(input: KeyInput, context: KeyContext, phase: "down" | "up"): KeyCommand | null {
  if (input.isComposing || input.editableTarget) return null;
  const command = input.metaKey || input.ctrlKey;
  if (phase === "up") {
    return input.code === "Space" && !command && !input.altKey && context.spaceOverPannable ? { cmd: "space", down: false } : null;
  }
  if (command) {
    if (input.code === "KeyC" && !input.altKey && !input.shiftKey) return context.hasTextSelection ? null : { cmd: "copyNote" };
    return null;
  }
  if (input.altKey) {
    const level = input.shiftKey ? undefined : LEVEL_OF_DIGIT[input.code];
    return level === undefined ? null : { cmd: "level", level };
  }
  const shift = input.shiftKey;
  const hybrid = context.view === "hybrid";
  switch (input.code) {
    case "KeyJ": return shift ? { cmd: "chapter", dir: 1 } : { cmd: "item", dir: 1 };
    case "KeyK": return shift ? { cmd: "chapter", dir: -1 } : { cmd: "item", dir: -1 };
    case "BracketLeft": return shift ? (hybrid ? { cmd: "brushEdge", edge: "from" } : null) : { cmd: "turn", dir: -1 };
    case "BracketRight": return shift ? (hybrid ? { cmd: "brushEdge", edge: "to" } : null) : { cmd: "turn", dir: 1 };
    case "KeyN": return shift ? { cmd: "finding", dir: -1 } : { cmd: "finding", dir: 1 };
    case "Enter":
    case "NumpadEnter": return shift ? null : { cmd: "toggle" };
    case "Escape": return { cmd: "esc" };
    case "Digit1": return shift ? { cmd: "fit", target: "all" } : { cmd: "view", view: "canvas" };
    case "Digit2": return shift ? { cmd: "fit", target: "selection" } : { cmd: "view", view: "hybrid" };
    case "Comma": return shift ? null : { cmd: "playhead", dir: -1 };
    case "Period": return shift ? null : { cmd: "playhead", dir: 1 };
    case "KeyG": return shift ? { cmd: "last" } : { cmd: "first" };
    case "Minus": return shift ? null : { cmd: "zoom", op: "out" };
    case "Equal": return { cmd: "zoom", op: "in" };
    case "Digit0": return shift ? null : { cmd: "zoom", op: "preset" };
    case "KeyV": return shift ? null : { cmd: "tool", tool: "select" };
    case "KeyH": return shift ? null : { cmd: "tool", tool: "hand" };
    case "Space": return !shift && context.spaceOverPannable ? { cmd: "space", down: true } : null;
    case "KeyB": return !shift && hybrid ? { cmd: "brushChapter" } : null;
    case "Slash": return shift ? { cmd: "help" } : { cmd: "search" };
    case "F6": return { cmd: "region", dir: shift ? -1 : 1 };
    default: return null;
  }
}
