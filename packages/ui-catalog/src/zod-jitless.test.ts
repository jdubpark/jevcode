import { afterEach, describe, expect, it } from "vitest";

const RealFunction = globalThis.Function;

afterEach(() => {
  globalThis.Function = RealFunction;
});

describe("zod jitless mode", () => {
  it("loading ui-catalog never probes new Function (CSP script-src 'self')", async () => {
    const probes: unknown[][] = [];
    globalThis.Function = new Proxy(RealFunction, {
      construct(target, args, newTarget) {
        probes.push(args);
        return Reflect.construct(target, args, newTarget) as object;
      },
    });
    const catalog = await import("./index.js");
    expect(catalog.jevcodeCatalog).toBeDefined();
    // zod 4 probes eval support with `new Function("")` (zod/v4/core/util.js allowsEval).
    expect(probes.filter((args) => args.length === 1 && args[0] === "")).toEqual([]);
  });
});
