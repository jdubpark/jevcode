import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createFakeNarratorClient } from "@jevcode/jev-router";
import { describe, expect, it, vi } from "vitest";

import { createSecretsStore } from "../secrets/secrets-store.js";
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

describe("narrator switch with saved keys (settings page)", () => {
  it("rebuilds the client when the active key changes, and only then", () => {
    let key: string | null = "sk-first";
    // Each call returns a fresh fake, so a rebuilt client is a different object.
    const createClient = vi.fn((_apiKey: string) => createFakeNarratorClient({}));
    const narrator = createNarratorSwitch({ enabled: true, env: {}, apiKey: () => key, createClient });
    expect(createClient).not.toHaveBeenCalled();
    const seen: unknown[] = [];
    narrator.subscribe((client) => seen.push(client));
    const first = narrator.current();
    expect(createClient).toHaveBeenLastCalledWith("sk-first");
    narrator.refresh();
    expect(seen).toHaveLength(0);
    key = "sk-second";
    narrator.refresh();
    expect(createClient).toHaveBeenLastCalledWith("sk-second");
    expect(narrator.current()).not.toBe(first);
    expect(seen).toHaveLength(1);
  });

  it("goes off_no_key when the key is removed, and the kill switch still wins", () => {
    let key: string | null = "sk-first";
    const narrator = createNarratorSwitch({ enabled: true, env: {}, apiKey: () => key, createClient: () => createFakeNarratorClient({}) });
    key = null;
    narrator.refresh();
    expect(narrator.availability()).toBe("off_no_key");
    expect(narrator.current()).toBeNull();
    const killed = createNarratorSwitch({ enabled: true, env: { JEVCODE_NARRATOR: "off" }, apiKey: () => "sk-x", createClient: () => createFakeNarratorClient({}) });
    expect(killed.availability()).toBe("off_env");
  });

  it("stays on with the environment key after the saved key is removed (Review Focus 4)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jevcode-switch-"));
    const store = createSecretsStore({
      filePath: path.join(dir, "secrets.json"),
      crypto: { isEncryptionAvailable: () => true, encryptString: (p) => Buffer.from(`enc:${p}`), decryptString: (c) => c.toString().slice(4) },
      env: { ANTHROPIC_API_KEY: "sk-env-key" },
    });
    const createClient = vi.fn(() => createFakeNarratorClient({}));
    const narrator = createNarratorSwitch({ enabled: true, env: {}, apiKey: () => store.active("ANTHROPIC_API_KEY"), createClient });
    store.subscribe(() => narrator.refresh());
    store.set("ANTHROPIC_API_KEY", "sk-saved-key");
    expect(createClient).toHaveBeenLastCalledWith("sk-saved-key");
    store.remove("ANTHROPIC_API_KEY");
    expect(narrator.availability()).toBe("on");
    expect(createClient).toHaveBeenLastCalledWith("sk-env-key");
    rmSync(dir, { recursive: true, force: true });
  });
});
