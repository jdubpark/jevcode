import { bench, describe } from "vitest";

import { canvasScale, mutateCanvasSession, syntheticCanvasSession } from "../test-support/canvas-arbitraries.js";
import { layoutCanvas } from "./canvas-layout.js";
import { buildTraceIndex } from "./trace-index.js";

// Spec §10: layoutCanvas fresh ≤ 2 ms and sticky ≤ 0.5 ms on the 60-chapter / 5k-step session (benchmark, not a CI gate).

const session = syntheticCanvasSession();
const index = buildTraceIndex(session);
const scale = canvasScale(session);
const settled = layoutCanvas(session, index, scale, "chapter");
const appended = mutateCanvasSession(session, [{ op: "append", pick: 3 }]);
const appendedIndex = buildTraceIndex(appended);
const appendedScale = canvasScale(appended);

describe("layoutCanvas, 60 chapters and 5,000 steps", () => {
  bench("fresh", () => {
    layoutCanvas(session, index, scale, "chapter");
  });

  bench("sticky after one appended chapter", () => {
    layoutCanvas(appended, appendedIndex, appendedScale, "chapter", settled);
  });
});
