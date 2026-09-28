import { describe, expect, it } from "vitest";

import { symbolId } from "./node.js";

// Digests are pinned: stored change_unit_symbols rows use these ids, so the move out of
// id.ts must not change a single byte.
describe("symbolId (@jevcode/contracts/node)", () => {
  it("follows the SPEC section 3.2 identity format", () => {
    expect(
      symbolId("auth/service.ts", "createSession", "method", "createSession(userId: string)"),
    ).toBe("auth/service.ts#createSession(method)@34fe8cce1d56428b1cf104d3979829db6c929659");
  });

  it("changes when the signature changes", () => {
    const before = symbolId("a.ts", "f", "function", "f(x)");
    expect(before).toBe("a.ts#f(function)@3e03f4706048fbc6c5a252a85d066adf107fcc1f");
    expect(symbolId("a.ts", "f", "function", "f(x, y)")).not.toBe(before);
  });
});
