import { describe, expect, it } from "vitest";

import type { JevClient } from "./types.js";
import { DegradeClient } from "./degrade.js";
import { TypeSafeClient } from "./typesafe-client.js";
import { createJevClient, selectClientKind } from "./selection.js";

describe("selectClientKind", () => {
  it("explicit typesafe wins over everything", () => {
    expect(selectClientKind({ JEVC_JEV_CLIENT: "typesafe" })).toBe("typesafe");
  });

  it("explicit degrade wins even with a key present", () => {
    expect(
      selectClientKind({ JEVC_JEV_CLIENT: "degrade", TYPESAFE_API_KEY: "k" }),
    ).toBe("degrade");
  });

  it("auto selects typesafe when a key is present", () => {
    expect(
      selectClientKind({ JEVC_JEV_CLIENT: "auto", TYPESAFE_API_KEY: "k" }),
    ).toBe("typesafe");
  });

  it("auto selects typesafe when only JEV_API_KEY is present", () => {
    expect(
      selectClientKind({ JEVC_JEV_CLIENT: "auto", JEV_API_KEY: "k" }),
    ).toBe("typesafe");
  });

  it("auto selects degrade when no key is present", () => {
    expect(selectClientKind({ JEVC_JEV_CLIENT: "auto" })).toBe("degrade");
  });

  it("defaults to auto when unset", () => {
    expect(selectClientKind({})).toBe("degrade");
    expect(selectClientKind({ TYPESAFE_API_KEY: "k" })).toBe("typesafe");
  });

  it("ignores blank keys", () => {
    expect(selectClientKind({ TYPESAFE_API_KEY: "   " })).toBe("degrade");
  });
});

describe("createJevClient", () => {
  it("returns DegradeClient without a key", () => {
    const client = createJevClient({ env: () => ({}) });
    expect(client).toBeInstanceOf(DegradeClient);
  });

  it("returns TypeSafeClient with a key", () => {
    const client = createJevClient({ env: () => ({ TYPESAFE_API_KEY: "k" }) });
    expect(client).toBeInstanceOf(TypeSafeClient);
  });

  it("returns DegradeClient for JEVC_JEV_CLIENT=degrade", () => {
    const client: JevClient = createJevClient({
      env: () => ({ JEVC_JEV_CLIENT: "degrade", TYPESAFE_API_KEY: "k" }),
    });
    expect(client).toBeInstanceOf(DegradeClient);
  });

  it("reports degraded health in auto mode without a key", async () => {
    const client = createJevClient({ env: () => ({}) });
    expect(await client.health()).toBe("degraded");
  });
});
