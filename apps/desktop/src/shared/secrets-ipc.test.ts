import { describe, expect, it } from "vitest";

import { parseFromMain, parseToMain } from "./ipc-registry.js";

describe("secrets channels", () => {
  it("accepts allowlisted names and rejects others", () => {
    expect(parseToMain("secrets:set", { name: "ANTHROPIC_API_KEY", value: "sk-x" })).toEqual({ name: "ANTHROPIC_API_KEY", value: "sk-x" });
    expect(() => parseToMain("secrets:set", { name: "OPENAI_API_KEY", value: "sk-x" })).toThrow();
    expect(() => parseToMain("secrets:remove", { name: "ANTHROPIC_API_KEY", extra: 1 })).toThrow();
    expect(() => parseToMain("secrets:test", { name: "TYPESAFE_API_KEY" })).toThrow();
  });

  it("never echoes a rejected value in the parse error", () => {
    const value = `sk-${"x".repeat(5000)}`;
    let message = "";
    try {
      parseToMain("secrets:set", { name: "ANTHROPIC_API_KEY", value });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain(value.slice(0, 40));
  });

  it("carries statuses, never values, from main", () => {
    const view = {
      canSave: true,
      fileUnreadable: false,
      keys: [{ name: "ANTHROPIC_API_KEY", set: true, source: "app", last4: "1234", envAlsoSet: false, unreadable: false }],
    };
    expect(parseFromMain("secrets:updated", view)).toEqual(view);
    expect(() => parseFromMain("secrets:updated", { ...view, keys: [{ ...view.keys[0], value: "sk-full" }] })).toThrow();
  });
});
