import { createFakeNarratorClient } from "@jevcode/jev-router";
import { describe, expect, it, vi } from "vitest";

import { createNarratorSwitch, narratorAvailability } from "./narrator-switch.js";

describe("narratorAvailability", () => {
  it.each([
    [true, { ANTHROPIC_API_KEY: "sk-test" }, "on"],
    [false, { ANTHROPIC_API_KEY: "sk-test" }, "off_setting"],
    [true, {}, "off_no_key"],
    [true, { ANTHROPIC_API_KEY: "   " }, "off_no_key"],
    [true, { ANTHROPIC_API_KEY: "sk-test", JEVCODE_NARRATOR: "off" }, "off_env"],
    [false, { JEVCODE_NARRATOR: "OFF" }, "off_env"],
  ] as const)("enabled=%s env=%j → %s", (enabled, env, expected) => {
    expect(narratorAvailability(enabled, env)).toBe(expected);
  });
});

describe("createNarratorSwitch (spec E15)", () => {
  it("never builds a client while the setting is off", () => {
    const createClient = vi.fn(() => createFakeNarratorClient({}));
    const narrator = createNarratorSwitch({ enabled: false, env: { ANTHROPIC_API_KEY: "sk-test" }, createClient });
    expect(narrator.current()).toBeNull();
    expect(narrator.availability()).toBe("off_setting");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("turns on and off, notifying subscribers once per change and reusing one client", () => {
    const client = createFakeNarratorClient({});
    const createClient = vi.fn(() => client);
    const narrator = createNarratorSwitch({ enabled: true, env: { ANTHROPIC_API_KEY: " sk-test " }, createClient });
    const seen: unknown[] = [];
    const off = narrator.subscribe((next) => {
      seen.push(next);
    });
    expect(narrator.current()).toBe(client);
    narrator.setEnabled(false);
    narrator.setEnabled(false);
    narrator.setEnabled(true);
    off();
    narrator.setEnabled(false);
    expect(seen).toEqual([null, client]);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledWith("sk-test");
  });

  it("stays off without an API key even when the setting is on", () => {
    const createClient = vi.fn(() => createFakeNarratorClient({}));
    const narrator = createNarratorSwitch({ enabled: true, env: {}, createClient });
    expect(narrator.current()).toBeNull();
    expect(narrator.availability()).toBe("off_no_key");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("without a key, still tells subscribers when the setting flips, so status.narrator moves between unavailable and off (R3)", () => {
    const narrator = createNarratorSwitch({ enabled: true, env: {}, createClient: () => createFakeNarratorClient({}) });
    const seen: [unknown, string][] = [];
    narrator.subscribe((next) => {
      seen.push([next, narrator.availability()]);
    });
    narrator.setEnabled(false);
    narrator.setEnabled(true);
    expect(seen).toEqual([
      [null, "off_setting"],
      [null, "off_no_key"],
    ]);
  });

  it("builds the Anthropic-backed client by default without touching the network", () => {
    const narrator = createNarratorSwitch({ enabled: true, env: { ANTHROPIC_API_KEY: "sk-test" } });
    expect(typeof narrator.current()?.describeComponents).toBe("function");
  });
});
