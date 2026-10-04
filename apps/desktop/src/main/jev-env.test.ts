import { DegradeClient, TypeSafeClient, createJevClient } from "@jevcode/jev-router";
import { describe, expect, it } from "vitest";

import { jevEnv } from "./jev-env.js";

describe("jevEnv (each session's Jev client and model selection)", () => {
  it("passes the key the secrets store resolved, not the environment's", () => {
    const env = jevEnv({
      typesafeKey: "ts-saved-1111",
      jevClientPreference: "auto",
      env: { TYPESAFE_API_KEY: "ts-env-2222", JEV_API_KEY: "jev-env-3333" },
    });
    expect(env["TYPESAFE_API_KEY"]).toBe("ts-saved-1111");
    expect(Object.values(env)).not.toContain("ts-env-2222");
    expect(Object.values(env)).not.toContain("jev-env-3333");
    expect(jevEnv({ typesafeKey: null, jevClientPreference: "auto", env: { TYPESAFE_API_KEY: "ts-env-2222" } })["TYPESAFE_API_KEY"]).toBeUndefined();
  });

  it("maps the stored choice to JEVC_JEV_CLIENT, and leaves it out for auto", () => {
    expect(jevEnv({ typesafeKey: null, jevClientPreference: "offline", env: {} })["JEVC_JEV_CLIENT"]).toBe("degrade");
    expect(jevEnv({ typesafeKey: null, jevClientPreference: "typesafe", env: {} })["JEVC_JEV_CLIENT"]).toBe("typesafe");
    expect("JEVC_JEV_CLIENT" in jevEnv({ typesafeKey: "ts-saved-1111", jevClientPreference: "auto", env: {} })).toBe(false);
  });

  it("lets a recognised environment override win over the stored choice", () => {
    expect(jevEnv({ typesafeKey: "k", jevClientPreference: "typesafe", env: { JEVC_JEV_CLIENT: "degrade" } })["JEVC_JEV_CLIENT"]).toBe("degrade");
    expect(jevEnv({ typesafeKey: "k", jevClientPreference: "offline", env: { JEVC_JEV_CLIENT: "typesafe" } })["JEVC_JEV_CLIENT"]).toBe("typesafe");
    expect(jevEnv({ typesafeKey: "k", jevClientPreference: "auto", env: { JEVC_JEV_CLIENT: "degrade" } })["JEVC_JEV_CLIENT"]).toBe("degrade");
  });

  it.each(["", "auto", "offline", "TypeSafe"])("ignores JEVC_JEV_CLIENT=%j, as the Settings page does", (value) => {
    expect(jevEnv({ typesafeKey: "k", jevClientPreference: "offline", env: { JEVC_JEV_CLIENT: value } })["JEVC_JEV_CLIENT"]).toBe("degrade");
    expect("JEVC_JEV_CLIENT" in jevEnv({ typesafeKey: "k", jevClientPreference: "auto", env: { JEVC_JEV_CLIENT: value } })).toBe(false);
  });

  it("carries the TypeSafe endpoint settings from the environment", () => {
    expect(
      jevEnv({ typesafeKey: null, jevClientPreference: "auto", env: { TYPESAFE_BASE_URL: "https://ts.example", TYPESAFE_DEFAULT_MODEL: "m-1" } }),
    ).toMatchObject({ TYPESAFE_BASE_URL: "https://ts.example", TYPESAFE_DEFAULT_MODEL: "m-1" });
  });

  it("builds the offline client for Offline even with a key active, and TypeSafe for Auto with a key", () => {
    const build = (input: Parameters<typeof jevEnv>[0]) => createJevClient({ env: () => jevEnv(input) });
    expect(build({ typesafeKey: "ts-env-2222", jevClientPreference: "offline", env: { TYPESAFE_API_KEY: "ts-env-2222" } })).toBeInstanceOf(DegradeClient);
    expect(build({ typesafeKey: "ts-env-2222", jevClientPreference: "offline", env: { JEVC_JEV_CLIENT: "offline" } })).toBeInstanceOf(DegradeClient);
    expect(build({ typesafeKey: "ts-saved-1111", jevClientPreference: "auto", env: {} })).toBeInstanceOf(TypeSafeClient);
    expect(build({ typesafeKey: null, jevClientPreference: "auto", env: { JEV_API_KEY: "jev-env-3333" } })).toBeInstanceOf(DegradeClient);
  });
});
