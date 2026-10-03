import { describe, expect, it, vi } from "vitest";

import { createJevcodeApi } from "./api.js";
import { parseToMain } from "./ipc-registry.js";

describe("debug:listNarratorCalls channel", () => {
  it("validates the limit", () => {
    expect(parseToMain("debug:listNarratorCalls", {})).toEqual({});
    expect(parseToMain("debug:listNarratorCalls", { limit: 20 })).toEqual({ limit: 20 });
    expect(() => parseToMain("debug:listNarratorCalls", { limit: 0 })).toThrowError();
    expect(() => parseToMain("debug:listNarratorCalls", { limit: 500 })).toThrowError();
  });

  it("round-trips through the preload api", async () => {
    const payload = { availability: "off_no_key", calls: [] };
    const invoke = vi.fn<(channel: string, body: unknown) => Promise<unknown>>(async () => payload);
    const on = vi.fn<(channel: string, listener: (body: unknown) => void) => () => void>(() => () => undefined);
    const api = createJevcodeApi({ invoke, on, platform: "test" });
    await expect(api.debug.listNarratorCalls(20)).resolves.toEqual(payload);
    expect(invoke).toHaveBeenCalledWith("debug:listNarratorCalls", { limit: 20 });
  });
});
