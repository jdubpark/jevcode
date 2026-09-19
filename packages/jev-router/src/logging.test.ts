import { describe, expect, it } from "vitest";

import { buildJevDecisionRecord, hashInput } from "./logging.js";

describe("hashInput", () => {
  it("is deterministic and key-order independent", () => {
    const a = hashInput({ files: ["a.ts"], added: 3 });
    const b = hashInput({ added: 3, files: ["a.ts"] });
    expect(a).toBe(b);
    expect(a).toHaveLength(8);
  });

  it("distinguishes different content", () => {
    expect(hashInput({ added: 3 })).not.toBe(hashInput({ added: 4 }));
  });

  it("handles scalars and arrays", () => {
    expect(hashInput("hello")).toBe(hashInput("hello"));
    expect(hashInput([1, 2, 3])).toBe(hashInput([1, 2, 3]));
    expect(hashInput([1, 2, 3])).not.toBe(hashInput([3, 2, 1]));
  });
});

describe("buildJevDecisionRecord", () => {
  const base = {
    sessionId: "sess-1",
    changeUnitId: "cu-1",
    inputHash: hashInput({ files: ["a.ts"] }),
    output: { shouldSurface: true },
    confidence: 0.9,
    probabilities: { implementation_change: 0.9 },
    latencyMs: 120,
    clientKind: "typesafe" as const,
    clamps: ["schema_floor"],
    ts: "2026-09-18T09:01:00.000Z",
  };

  it("returns the jev_decisions row shape", () => {
    const record = buildJevDecisionRecord(base);
    expect(record).toEqual({
      id: expect.stringMatching(/^jev:.+:.+$/) as string,
      sessionId: "sess-1",
      changeUnitId: "cu-1",
      inputHash: base.inputHash,
      output: base.output,
      confidence: 0.9,
      probabilities: base.probabilities,
      latencyMs: 120,
      clientKind: "typesafe",
      clamps: ["schema_floor"],
      ts: "2026-09-18T09:01:00.000Z",
    });
  });

  it("is deterministic for identical inputs", () => {
    expect(buildJevDecisionRecord(base).id).toBe(buildJevDecisionRecord(base).id);
  });

  it("defaults ts and tolerates omitted optional fields", () => {
    const record = buildJevDecisionRecord({
      sessionId: "sess-1",
      inputHash: "abc",
      output: null,
      confidence: 0.6,
      latencyMs: 0,
      clientKind: "degrade",
      clamps: [],
    });
    expect(record.ts).toEqual(expect.any(String));
    expect(record.changeUnitId).toBeUndefined();
    expect(record.probabilities).toBeUndefined();
  });

  it("is storage-agnostic (no @jevcode/storage import required)", () => {
    const record = buildJevDecisionRecord(base);
    expect(Object.keys(record).sort()).toEqual(
      [
        "id",
        "sessionId",
        "changeUnitId",
        "inputHash",
        "output",
        "confidence",
        "probabilities",
        "latencyMs",
        "clientKind",
        "clamps",
        "ts",
      ].sort(),
    );
  });
});
