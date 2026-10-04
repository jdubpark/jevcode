import { describe, expect, it } from "vitest";

import { chooseAgentMode } from "./agent-mode.js";

describe("chooseAgentMode", () => {
  it.each([
    ["mock", undefined, "codex", "mock"],
    [undefined, "codex", "mock", "codex"],
    [undefined, "replay", undefined, "replay"],
    [undefined, "nonsense", "mock", "mock"],
    [undefined, undefined, "mock", "mock"],
    [undefined, undefined, undefined, "auto"],
  ] as const)("explicit=%s env=%s pref=%s → %s", (explicit, env, pref, expected) => {
    expect(chooseAgentMode(explicit, env, pref)).toBe(expected);
  });
});
