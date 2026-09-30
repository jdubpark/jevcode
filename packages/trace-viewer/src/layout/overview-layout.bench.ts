import { bench, describe } from "vitest";

import type { UnitStableId } from "../model/index.js";
import { bandsOverview, largeSession } from "../test-support/session-builder.js";
import { buildOverviewIndex, type BandSpan } from "./overview-index.js";
import { K_MAX, layoutOverview } from "./overview-layout.js";
import { buildTimeScale, timeScaleInputOf } from "./time-scale.js";
import { buildTraceIndex } from "./trace-index.js";
import { fitRange } from "./viewport.js";

const session = largeSession();
const index = buildTraceIndex(session);
const scale = buildTimeScale(timeScaleInputOf(session));
const overview = buildOverviewIndex(session, index, scale);
const width = 1_200;
const fit = fitRange(0, overview.endU, width, { padFraction: 0.02, limits: { minK: 1e-9, maxK: K_MAX } });

// Reported only; the p95 ≤ 4 ms gate (layout + paint) is measured in the dev-host HUD at C2-16.
describe("overview layout, 60 chapters / 5k steps", () => {
  bench("layoutOverview at Session level", () => {
    layoutOverview({ overview, camera: fit, widthPx: width, level: "session" });
  });
  bench("layoutOverview at Chapter level, zoomed ×8", () => {
    layoutOverview({ overview, camera: { mode: "xOnly", u0: overview.endU / 2, k: fit.k * 8 }, widthPx: width, level: "chapter" });
  });
  bench("buildOverviewIndex", () => {
    buildOverviewIndex(session, index, scale);
  });
});

// Soak shape before ruling M6: 4,861 chapters of 33 pieces each spread over the session, 163 keys.
// Per-frame band cost must follow the visible bands, not the 160k pieces (perf investigation fix 2).
const soakBands: BandSpan[] = [];
for (let c = 0, seed = 1; c < 4_861; c += 1) {
  for (let p = 0; p < 33; p += 1) {
    seed = (seed * 16_807) % 2_147_483_647;
    const u0 = (seed / 2_147_483_647) * 1e6;
    soakBands.push({ key: `ch:${c % 163}`, id: `unit:${c}` as UnitStableId, u0, u1: u0 + (p % 7) * 8, title: `Chapter ${c}` });
  }
}
const soakShape = bandsOverview(soakBands, 1e6);
const soakFit = fitRange(0, 1e6, width, { padFraction: 0.02, limits: { minK: 1e-9, maxK: K_MAX } });
describe("overview layout, 160k band pieces over 163 keys", () => {
  bench("layoutOverview at Session level", () => {
    layoutOverview({ overview: soakShape, camera: soakFit, widthPx: width, level: "session" });
  });
  bench("layoutOverview zoomed ×50", () => {
    layoutOverview({ overview: soakShape, camera: { mode: "xOnly", u0: 5e5, k: soakFit.k * 50 }, widthPx: width, level: "chapter" });
  });
});
