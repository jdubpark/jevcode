import { describe, expect, it } from "vitest";

import { keyStatusLine, keyTestLine, overrideNote } from "./settings-format.js";

const base = { name: "ANTHROPIC_API_KEY", set: true, last4: "a1b2", envAlsoSet: false, unreadable: false } as const;

describe("settings format", () => {
  it("describes each key source", () => {
    expect(keyStatusLine({ ...base, source: "app" }, true)).toBe("Saved in app · …a1b2");
    expect(keyStatusLine({ ...base, source: "app", envAlsoSet: true }, true)).toBe("Saved in app · …a1b2 — overrides the environment key");
    expect(keyStatusLine({ ...base, source: "env" }, true)).toBe("From environment · …a1b2");
    expect(keyStatusLine({ ...base, set: false, source: "none", last4: null }, true)).toBe("Not set");
    expect(keyStatusLine({ ...base, set: false, source: "none", last4: null, unreadable: true }, true)).toBe("A saved key could not be read; save it again");
  });

  it("asks to save an unreadable key again only where saving is possible", () => {
    const unreadable = { ...base, set: false, source: "none", last4: null, unreadable: true } as const;
    expect(keyStatusLine(unreadable, false)).toBe("A saved key could not be read; remove it");
    expect(keyStatusLine({ ...base, source: "env", unreadable: true }, true)).toBe(
      "A saved key could not be read; save it again · using the environment key …a1b2",
    );
    expect(keyStatusLine({ ...base, source: "env", unreadable: true }, false)).toBe("A saved key could not be read; remove it · using the environment key …a1b2");
  });

  it("words test results and overrides", () => {
    expect(keyTestLine({ result: "ok" })).toBe("Key works");
    expect(keyTestLine({ result: "error", status: 500 })).toBe("The check failed (HTTP 500)");
    expect(overrideNote("JEVC_AGENT", "mock")).toBe("Set by JEVC_AGENT=mock (environment)");
  });
});
