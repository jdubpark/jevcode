import { describe, expect, it, vi } from "vitest";

import { createJevcodeApi } from "./api.js";
import { parseFromMain, parseToMain } from "./ipc-registry.js";

const SAMPLE_PREFS = {
  model: "gpt-5.6-luna",
  reasoningEffort: "xhigh",
  usageBudgetFraction: "0.25",
};

describe("preference IPC channels", () => {
  it("accepts an empty preferences:get payload", () => {
    expect(parseToMain("preferences:get", {})).toEqual({});
  });

  it("validates preferences:set patches", () => {
    expect(
      parseToMain("preferences:set", {
        model: "gpt-5.6-sol",
        usageBudgetFraction: "0.60",
      }),
    ).toEqual({ model: "gpt-5.6-sol", usageBudgetFraction: "0.60" });
    expect(
      parseToMain("preferences:set", { usageBudgetFraction: null }),
    ).toEqual({ usageBudgetFraction: null });
    expect(() =>
      parseToMain("preferences:set", { model: "gpt-9" }),
    ).toThrowError();
    expect(() =>
      parseToMain("preferences:set", { usageBudgetFraction: "1.5" }),
    ).toThrowError();
    expect(() => parseToMain("preferences:set", {})).toThrowError();
  });

  it("validates preferences:updated snapshots", () => {
    expect(parseFromMain("preferences:updated", SAMPLE_PREFS)).toEqual(
      SAMPLE_PREFS,
    );
    expect(() =>
      parseFromMain("preferences:updated", {
        model: "gpt-5.6-luna",
        reasoningEffort: "extreme",
        usageBudgetFraction: "0.25",
      }),
    ).toThrowError();
  });

  it("roundtrips preferences through the preload api", async () => {
    const invoke = vi.fn<(channel: string, payload: unknown) => Promise<unknown>>(
      async () => SAMPLE_PREFS,
    );
    const on = vi.fn<
      (channel: string, listener: (payload: unknown) => void) => () => void
    >(() => () => undefined);
    const api = createJevcodeApi({ invoke, on, platform: "test" });

    await expect(api.prefs.get()).resolves.toEqual(SAMPLE_PREFS);
    expect(invoke).toHaveBeenCalledWith("preferences:get", {});

    await api.prefs.set({ model: "gpt-5.6-mini", reasoningEffort: "low" });
    expect(invoke).toHaveBeenCalledWith("preferences:set", {
      model: "gpt-5.6-mini",
      reasoningEffort: "low",
    });

    await expect(
      (api.prefs as never as { set: (p: unknown) => Promise<unknown> }).set({
        model: "gpt-9",
      }),
    ).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });

    const listener = vi.fn();
    const unsubscribe = api.onPrefsUpdated(listener);
    expect(on).toHaveBeenCalledWith(
      "preferences:updated",
      expect.any(Function),
    );
    const registered = on.mock.calls[0]?.[1] as (p: unknown) => void;
    registered(SAMPLE_PREFS);
    expect(listener).toHaveBeenCalledWith(SAMPLE_PREFS);
    unsubscribe();
  });
});
