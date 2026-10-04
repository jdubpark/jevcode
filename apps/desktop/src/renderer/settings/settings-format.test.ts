import { describe, expect, it } from "vitest";

import { keyStatusLine, keyTestLine, overrideNote } from "./settings-format.js";

const base = { name: "ANTHROPIC_API_KEY", set: true, last4: "a1b2", envAlsoSet: false, unreadable: false } as const;

describe("settings format", () => {
  it("describes each key source", () => {
    expect(keyStatusLine({ ...base, source: "app" })).toBe("Saved in app · …a1b2");
    expect(keyStatusLine({ ...base, source: "app", envAlsoSet: true })).toBe("Saved in app · …a1b2 — overrides the environment key");
    expect(keyStatusLine({ ...base, source: "env" })).toBe("From environment · …a1b2");
    expect(keyStatusLine({ ...base, set: false, source: "none", last4: null })).toBe("Not set");
    expect(keyStatusLine({ ...base, set: false, source: "none", last4: null, unreadable: true })).toBe("A saved key could not be read; save it again");
  });

  it("words test results and overrides", () => {
    expect(keyTestLine({ result: "ok" })).toBe("Key works");
    expect(keyTestLine({ result: "error", status: 500 })).toBe("The check failed (HTTP 500)");
    expect(overrideNote("JEVC_AGENT", "mock")).toBe("Set by JEVC_AGENT=mock (environment)");
  });
});
