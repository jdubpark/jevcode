import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { decodeLocation, locationFromHash, locationToHash, ViewerLocationSchema, type ViewerLocation } from "./location.js";

const seq = fc.integer({ min: 1, max: 1_000_000 });
const arbLocation: fc.Arbitrary<ViewerLocation> = fc.record({
  v: fc.constant(1 as const),
  sessionId: fc.constant("sess-1"),
  view: fc.constantFrom("canvas" as const, "hybrid" as const),
  level: fc.constantFrom("session" as const, "chapter" as const, "step" as const),
  selected: fc.option(fc.oneof(seq.map((n) => `step:${n}`), fc.string({ minLength: 1 }).map((s) => `unit:${s}`)), { nil: undefined }),
  playhead: fc.option(fc.oneof(
    fc.constant({ kind: "selection" as const }), fc.constant({ kind: "live" as const }), seq.map((n) => ({ kind: "free" as const, seq: n })),
  ), { nil: undefined }),
  brush: fc.oneof(
    fc.constant({ kind: "session" as const }),
    seq.map((n) => ({ kind: "chapter" as const, anchorSeq: n })),
    fc.tuple(seq, fc.oneof(seq, fc.constant("live" as const))).map(([fromSeq, toSeq]) => ({ kind: "range" as const, fromSeq, toSeq })),
  ),
}).map((l) => ViewerLocationSchema.parse(l));

describe("location codec", () => {
  it("never throws and falls back to defaults", () => {
    const defaults = { v: 1, sessionId: "s", view: "hybrid", level: "chapter", brush: { kind: "session" } };
    expect(decodeLocation("garbage", "s")).toEqual(defaults);
    expect(decodeLocation({ v: 1, sessionId: "other", view: "canvas" }, "s")).toEqual(defaults);
    expect(decodeLocation({ v: 1, sessionId: "s", brush: { kind: "range", fromSeq: 0, toSeq: 3 } }, "s")).toEqual(defaults);
    expect(locationFromHash("#%E0%A4%A", "s")).toEqual(defaults);
    expect(locationFromHash("", "s")).toEqual(defaults);
  });

  it("keeps a valid location for the same session", () => {
    const l = decodeLocation({ v: 1, sessionId: "s", view: "canvas", selected: "decision:dec-oauth-0001", brush: { kind: "range", fromSeq: 5, toSeq: "live" } }, "s");
    expect(l).toMatchObject({ view: "canvas", level: "chapter", selected: "decision:dec-oauth-0001", brush: { kind: "range", fromSeq: 5, toSeq: "live" } });
  });

  it("round-trips through the URL hash", () => {
    fc.assert(fc.property(arbLocation, (location) => {
      expect(locationFromHash(locationToHash(location), location.sessionId)).toEqual(location);
    }));
  });
});
