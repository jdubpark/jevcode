import { bench, describe } from "vitest";

import { largeSession } from "../test-support/session-builder.js";
import { buildSpineRows, type SpineRowsInput } from "./spine-rows.js";
import { buildTimeScale, timeScaleInputOf } from "./time-scale.js";
import { buildTraceIndex } from "./trace-index.js";

const session = largeSession();
const index = buildTraceIndex(session);
const scale = buildTimeScale(timeScaleInputOf(session));
const none = new Set<string>();
const middle = session.steps[Math.floor(session.steps.length / 2)];
const input: SpineRowsInput = {
  brush: { kind: "session" }, level: "chapter", playheadSeq: middle?.firstSeq ?? 1, selection: middle?.id ?? null,
  expanded: none, collapsed: none, live: false,
};

// Rebuilt on every j, ,/. and live tick; the M4a gate is 16.7 ms j-to-painted (spec §10).
describe("spine rows, 60 chapters / 5k steps", () => {
  bench("buildSpineRows at Chapter level, session-wide brush", () => {
    buildSpineRows(session, index, scale, input);
  });
  bench("buildSpineRows at Step level, session-wide brush", () => {
    buildSpineRows(session, index, scale, { ...input, level: "step" });
  });
});
