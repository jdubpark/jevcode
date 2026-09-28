import type { TraceBundle } from "@jevcode/contracts";
import { describe, expect, it } from "vitest";

import { TraceSourceError } from "./errors.js";
import { readAllTraceRows } from "./read-all.js";
import { createStaticBundleSource } from "./static-bundle.js";

const rows = Array.from({ length: 7 }, (_, i) => ({ seq: i + 1, type: "agent_event", ts: "2026-09-18T09:00:00.000Z", payload: {} }));
const bundle: TraceBundle = {
  format: "jevcode.trace", version: 1, exportedAt: "2026-09-18T10:00:00.000Z", redactionCount: 0,
  session: { sessionId: "s1", repoId: "r1", repoName: "acme", prompt: "go", state: "completed", startedAt: "2026-09-18T09:00:00.000Z", endedAt: null, lastEventSeq: 7 },
  rows,
};

describe("readAllTraceRows", () => {
  it("pages until nextAfterSeq is null and returns every row once", async () => {
    const loaded = await readAllTraceRows(createStaticBundleSource(bundle), { pageSize: 3 });
    expect(loaded.rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(loaded.summary.sessionId).toBe("s1");
    expect(loaded.lastPage).toMatchObject({ nextAfterSeq: null, lastSeq: 7 });
  });

  it("reads only released rows of a drip source", async () => {
    const source = createStaticBundleSource(bundle, { drip: { rowsPerTick: 3, intervalMs: 1_000, manual: true } });
    const loaded = await readAllTraceRows(source, { pageSize: 2 });
    expect(loaded.rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(loaded.lastPage.state).toBe("running");
  });

  it("fails loudly on a cursor that does not advance", async () => {
    const stuck = {
      sessionId: "s1",
      summary: async () => bundle.session,
      rows: async () => ({ rows: [], nextAfterSeq: 0, lastSeq: 7, state: "running" as const }),
      payloads: async () => [],
      now: () => 0,
    };
    await expect(readAllTraceRows(stuck)).rejects.toBeInstanceOf(TraceSourceError);
  });
});
