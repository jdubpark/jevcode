import { bench, describe } from "vitest";

import { largeSession } from "../test-support/session-builder.js";
import { buildOverviewIndex } from "./overview-index.js";
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
