import type { TraceBundle } from "@jevcode/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TraceSourceError } from "./errors.js";
import { createStaticBundleSource, parseTraceBundle } from "./static-bundle.js";

const T0 = Date.parse("2026-09-18T09:00:00.000Z");
const iso = (ms: number) => new Date(T0 + ms).toISOString();

function bundle(): TraceBundle {
  const agent = (seq: number, ms: number) => ({ seq, type: "agent_event", ts: iso(ms + 999_000), payload: { type: "agent_message", sessionId: "s1", ts: iso(ms), role: "assistant", text: `m${seq}` } });
  return {
    format: "jevcode.trace",
    version: 1,
    exportedAt: iso(100_000),
    redactionCount: 0,
    session: { sessionId: "s1", repoId: "r1", repoName: "acme", prompt: "go", state: "completed", startedAt: iso(0), endedAt: iso(9_000), lastEventSeq: 9 },
    rows: [
      agent(1, 1_000),
      agent(2, 2_000),
      agent(3, 3_000),
      { seq: 4, type: "change_unit", ts: iso(5_000_000), payload: { id: "u1" } },
      agent(5, 5_000),
      agent(7, 7_000),
    ],
  };
}

afterEach(() => { vi.useRealTimers(); });

describe("parseTraceBundle", () => {
  it("accepts a v1 bundle", () => {
    const parsed = parseTraceBundle(JSON.parse(JSON.stringify(bundle())));
    expect(parsed).toMatchObject({ ok: true, bundle: { version: 1 } });
  });

  it("accepts a v2 bundle with overview_snapshot and explainer rows", () => {
    const v2 = {
      ...bundle(),
      version: 2,
      rows: [
        ...bundle().rows,
        { seq: 8, type: "overview_snapshot", ts: iso(8_000), payload: { repoRoot: "/work/acme" } },
        { seq: 9, type: "explainer", ts: iso(9_000), payload: { kind: "story" } },
      ],
    };
    const parsed = parseTraceBundle(JSON.parse(JSON.stringify(v2)));
    expect(parsed).toMatchObject({ ok: true, bundle: { version: 2 } });
    expect(parsed.ok && parsed.bundle.rows.map((r) => r.type).slice(-2)).toEqual(["overview_snapshot", "explainer"]);
  });

  it("names a wrong file and an unsupported version", () => {
    expect(parseTraceBundle({})).toEqual({ ok: false, code: "NOT_A_TRACE", message: "Not a jevcode trace" });
    expect(parseTraceBundle("garbage")).toEqual({ ok: false, code: "NOT_A_TRACE", message: "Not a jevcode trace" });
    expect(parseTraceBundle({ ...bundle(), version: 3 })).toEqual({ ok: false, code: "UNSUPPORTED_VERSION", message: "Trace format v3 is not supported" });
    expect(parseTraceBundle({ ...bundle(), version: 0 })).toEqual({ ok: false, code: "UNSUPPORTED_VERSION", message: "Trace format v0 is not supported" });
    // The version must be the number, not its string.
    expect(parseTraceBundle({ ...bundle(), version: "2" })).toMatchObject({ ok: false, code: "UNSUPPORTED_VERSION" });
    expect(parseTraceBundle({ ...bundle(), rows: "nope" })).toMatchObject({ ok: false, code: "NOT_A_TRACE" });
  });
});

describe("createStaticBundleSource", () => {
  it("serves every row without drip, with lastSeq from the session (filtered rows count)", async () => {
    const source = createStaticBundleSource(bundle());
    expect(source.sessionId).toBe("s1");
    const page = await source.rows();
    expect(page.rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 7]);
    expect(page).toMatchObject({ nextAfterSeq: null, lastSeq: 9, state: "completed" });
    expect(await source.summary()).toMatchObject({ lastEventSeq: 9, state: "completed", endedAt: iso(9_000) });
  });

  it("pages with afterSeq and limit", async () => {
    const source = createStaticBundleSource(bundle());
    const first = await source.rows({ afterSeq: 0, limit: 4 });
    expect(first.rows.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(first.nextAfterSeq).toBe(4);
    const second = await source.rows({ afterSeq: 4, limit: 4 });
    expect(second.rows.map((r) => r.seq)).toEqual([5, 7]);
    expect(second.nextAfterSeq).toBeNull();
  });

  it("drip releases rows and reports running until the last row", async () => {
    const source = createStaticBundleSource(bundle(), { drip: { rowsPerTick: 2, intervalMs: 100, manual: true } });
    let page = await source.rows();
    expect(page.rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(page).toMatchObject({ lastSeq: 2, state: "running" });
    expect(await source.summary()).toMatchObject({ state: "running", endedAt: null, lastEventSeq: 2 });
    expect(source.now()).toBe(T0 + 2_000);
    source.tick();
    page = await source.rows({ afterSeq: 2 });
    expect(page.rows.map((r) => r.seq)).toEqual([3, 4]);
    expect(source.now()).toBe(T0 + 3_000);
    source.tick();
    page = await source.rows({ afterSeq: 4 });
    expect(page).toMatchObject({ lastSeq: 9, state: "completed" });
    expect(source.released()).toBe(6);
    expect(source.now()).toBe(T0 + 7_000);
  });

  it("startAtSeq releases the history first", () => {
    const source = createStaticBundleSource(bundle(), { drip: { rowsPerTick: 1, intervalMs: 100, manual: true, startAtSeq: 3 } });
    expect(source.released()).toBe(4);
  });

  it("an interval drip advances on its own and stops on dispose", () => {
    vi.useFakeTimers();
    const source = createStaticBundleSource(bundle(), { drip: { rowsPerTick: 2, intervalMs: 100 } });
    expect(source.released()).toBe(2);
    vi.advanceTimersByTime(100);
    expect(source.released()).toBe(4);
    source.dispose();
    vi.advanceTimersByTime(1_000);
    expect(source.released()).toBe(4);
  });

  it("payloads returns released rows only and bounds the request", async () => {
    const source = createStaticBundleSource(bundle(), { drip: { rowsPerTick: 2, intervalMs: 100, manual: true } });
    expect((await source.payloads([1, 3, 99])).map((r) => r.seq)).toEqual([1]);
    await expect(source.payloads(Array.from({ length: 51 }, (_, i) => i + 1))).rejects.toBeInstanceOf(TraceSourceError);
    await expect(source.payloads(Array.from({ length: 51 }, (_, i) => i + 1))).rejects.toMatchObject({ channel: "bundle", code: "SOURCE_FAILED" });
  });
});
