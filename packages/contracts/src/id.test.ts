import { describe, expect, it } from "vitest";

import {
  newChangeUnitId,
  newDecisionId,
  newFactId,
  newId,
  newSemanticEventId,
  newSessionId,
  newSurfaceId,
  nowIso,
  symbolId,
} from "./id.js";

describe("id helpers", () => {
  it("newId applies the prefix and is unique", () => {
    const a = newId("x");
    const b = newId("x");
    expect(a.startsWith("x_")).toBe(true);
    expect(a).not.toBe(b);
  });

  it("domain helpers use their prefixes", () => {
    expect(newSessionId().startsWith("sess_")).toBe(true);
    expect(newChangeUnitId().startsWith("cu_")).toBe(true);
    expect(newDecisionId().startsWith("dec_")).toBe(true);
    expect(newFactId().startsWith("fact_")).toBe(true);
    expect(newSemanticEventId().startsWith("sem_")).toBe(true);
  });

  it("newSurfaceId matches SPEC section 9.6 surface id scheme", () => {
    expect(newSurfaceId("changeunit", "cu_1")).toBe("changeunit:cu_1");
    expect(newSurfaceId("decision", "dec_1")).toBe("decision:dec_1");
    expect(newSurfaceId("validation", "v1")).toBe("validation:v1");
    expect(newSurfaceId("timeline", "t1")).toBe("timeline:t1");
    expect(newSurfaceId("terminal", "t1")).toBe("terminal:t1");
    expect(newSurfaceId("completion", "t1")).toBe("completion:t1");
  });

  it("nowIso returns a parseable ISO timestamp", () => {
    const iso = nowIso();
    expect(new Date(iso).toISOString()).toBe(iso);
  });

  it("symbolId follows the SPEC section 3.2 identity format", () => {
    const id = symbolId("auth/service.ts", "createSession", "method", "createSession(userId: string)");
    expect(id).toMatch(/^auth\/service\.ts#createSession\(method\)@[0-9a-f]{40}$/);
  });

  it("symbolId changes when the signature changes", () => {
    const a = symbolId("a.ts", "f", "function", "f(x)");
    const b = symbolId("a.ts", "f", "function", "f(x, y)");
    expect(a).not.toBe(b);
  });
});
