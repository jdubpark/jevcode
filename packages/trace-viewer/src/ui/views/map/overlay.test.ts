import { describe, expect, it } from "vitest";

import { foldRows, type TraceSession } from "../../../model/index.js";
import { componentId, overviewSnapshot } from "../../../test-support/overview-builder.js";
import { TraceBuilder, testMeta } from "../../../test-support/trace-builder.js";
import { mapOverlayOf, overlayCounts } from "./overlay.js";

const UNKNOWN_ID = "cmp_000000000bad";

/** `other` adds the "(other)" catch-all component to the overview; highlights name it, an unknown id, and real components. */
function sessionOf(options: { highlights: boolean; other?: boolean }): TraceSession {
  const b = new TraceBuilder();
  b.agent({ type: "agent_started", prompt: "Add a limiter" });
  b.overview(
    overviewSnapshot({
      components: [
        { rootPath: "src/server", role: "api" },
        { rootPath: "src/middleware" },
        { rootPath: "src/redis", role: "storage" },
        { rootPath: "config", role: "config" },
        ...(options.other === true ? [{ rootPath: "(other)", role: "tooling" as const }] : []),
      ],
      edges: [
        { from: "src/server", to: "src/middleware", count: 3 },
        { from: "src/middleware", to: "src/redis", count: 2 },
        { from: "src/server", to: "config", count: 1 },
      ],
    }),
  );
  if (options.highlights) {
    b.explainer({
      kind: "highlights",
      basisSeq: 2,
      components: [
        { id: componentId("src/server"), state: "changed", unitIds: ["u1"] },
        { id: componentId("src/middleware"), state: "new", unitIds: ["u1"] },
        { id: componentId("src/redis"), state: "failing", unitIds: [] },
        { id: UNKNOWN_ID, state: "decision", unitIds: ["u2"] },
        { id: componentId("(other)"), state: "decision", unitIds: ["u2"] },
      ],
    });
  }
  return foldRows(testMeta(), b.rows, { live: true });
}

describe("mapOverlayOf", () => {
  it("skips a highlighted id that is not on the map and emphasizes edges with both ends touched", () => {
    const overlay = mapOverlayOf(sessionOf({ highlights: true }));
    expect(new Map(overlay?.cardState)).toEqual(
      new Map([
        [componentId("src/server"), "changed"],
        [componentId("src/middleware"), "new"],
        [componentId("src/redis"), "failing"],
      ]),
    );
    expect([...(overlay?.emphasizedEdges ?? [])].sort()).toEqual(
      [`${componentId("src/server")}>${componentId("src/middleware")}`, `${componentId("src/middleware")}>${componentId("src/redis")}`].sort(),
    );
    expect(overlay === null ? null : overlayCounts(overlay)).toEqual({ new: 1, changed: 1, decision: 0, failing: 1 });
  });

  it("marks the (other) component when the snapshot lists it, and skips it when it does not", () => {
    expect(mapOverlayOf(sessionOf({ highlights: true, other: true }))?.cardState.get(componentId("(other)"))).toBe("decision");
    expect(mapOverlayOf(sessionOf({ highlights: true }))?.cardState.has(componentId("(other)"))).toBe(false);
  });

  it("is null when no highlighted component is on the map", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "x" });
    b.overview(overviewSnapshot({ components: [{ rootPath: "src/server", role: "api" }] }));
    b.explainer({ kind: "highlights", basisSeq: 2, components: [{ id: UNKNOWN_ID, state: "failing", unitIds: [] }] });
    expect(mapOverlayOf(foldRows(testMeta(), b.rows, { live: true }))).toBeNull();
  });

  it("is null without highlights and the same object for the same session", () => {
    expect(mapOverlayOf(sessionOf({ highlights: false }))).toBeNull();
    const s = sessionOf({ highlights: true });
    expect(mapOverlayOf(s)).toBe(mapOverlayOf(s));
  });
});
