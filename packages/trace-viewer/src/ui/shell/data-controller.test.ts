import { describe, expect, it } from "vitest";

import type { AgentState, TraceRow, TraceRowsPage } from "@jevcode/contracts";

import type { TraceRowsRequest, TraceSource } from "../../source.js";
import { TraceSourceError } from "../../sources/errors.js";
import { TraceBuilder, testMeta } from "../../test-support/trace-builder.js";
import {
  BACKOFF_MS,
  COMMIT_COST_FACTOR,
  createDataController,
  LIVE_TICK_START,
  type DataSnapshot,
  type Scheduler,
} from "./data-controller.js";

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

class FakeScheduler implements Scheduler {
  private t = 0;
  private seq = 0;
  private timers: Array<{ at: number; id: number; fn: () => void }> = [];

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    this.seq += 1;
    this.timers.push({ at: this.t + Math.max(0, ms), id: this.seq, fn });
    return this.seq;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  }

  /** Time spent inside a request. */
  spend(ms: number): void {
    this.t += ms;
  }

  pending(): number {
    return this.timers.length;
  }

  async run(ms: number): Promise<void> {
    const end = this.t + ms;
    await settle();
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (next === undefined || next.at > end) break;
      this.timers.shift();
      this.t = Math.max(this.t, next.at);
      next.fn();
      await settle();
    }
    this.t = Math.max(this.t, end);
  }
}

function messageRows(count: number): TraceRow[] {
  const b = new TraceBuilder();
  b.agent({ type: "agent_started", prompt: "p" });
  for (let i = 1; i < count; i += 1) b.agent({ type: "agent_message", role: "assistant", text: `m${i}` });
  return b.rows;
}

interface Deferred {
  request: TraceRowsRequest;
  resolve(page: TraceRowsPage): void;
}

function fakeSource(rows: TraceRow[], init: { state: AgentState; released?: number }) {
  const control = {
    state: init.state,
    released: init.released ?? rows.length,
    calls: [] as TraceRowsRequest[],
    failures: 0,
    deferNext: false,
    deferred: [] as Deferred[],
    onRows: (_request: TraceRowsRequest): void => undefined,
    summaryError: null as unknown,
  };
  const page = (request: TraceRowsRequest): TraceRowsPage => {
    const after = request.afterSeq ?? 0;
    const limit = request.limit ?? 2_000;
    const out = rows.slice(0, control.released).filter((row) => row.seq > after).slice(0, limit);
    return {
      rows: out,
      nextAfterSeq: out.length === limit ? (out.at(-1)?.seq ?? null) : null,
      lastSeq: rows[control.released - 1]?.seq ?? 0,
      state: control.state,
    };
  };
  const source: TraceSource = {
    sessionId: "sess-test",
    summary: async () => {
      if (control.summaryError !== null) {
        const error = control.summaryError;
        control.summaryError = null;
        throw error;
      }
      return testMeta({ state: control.state });
    },
    rows: (request = {}) => {
      control.calls.push(request);
      control.onRows(request);
      if (control.failures > 0) {
        control.failures -= 1;
        return Promise.reject(new Error("socket closed"));
      }
      if (control.deferNext) {
        control.deferNext = false;
        return new Promise<TraceRowsPage>((resolve) => control.deferred.push({ request, resolve }));
      }
      return Promise.resolve(page(request));
    },
    payloads: async () => [],
    now: () => 0,
  };
  return { source, control };
}

function record(controller: { subscribe(listener: (snapshot: DataSnapshot) => void): () => void }, scheduler: FakeScheduler) {
  const seen: Array<{ t: number; snapshot: DataSnapshot }> = [];
  controller.subscribe((snapshot) => seen.push({ t: scheduler.now(), snapshot }));
  return seen;
}

describe("createDataController", () => {
  it("pages until caught up with at most 4 commits per second", async () => {
    const scheduler = new FakeScheduler();
    const { source, control } = fakeSource(messageRows(30), { state: "completed" });
    control.onRows = () => scheduler.spend(60);
    const controller = createDataController({ source, pollMs: 1_000, pageSize: 3, scheduler, isHidden: () => false });
    const seen = record(controller, scheduler);
    controller.start();
    await scheduler.run(5_000);

    expect(control.calls.map((call) => call.afterSeq)).toEqual([0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30]);
    const commits = seen.filter((entry) => entry.snapshot.session !== null);
    expect(commits.length).toBeGreaterThanOrEqual(2);
    expect(commits[0]?.snapshot.loadedFraction).toBeLessThan(1);
    for (let i = 1; i < commits.length; i += 1) {
      expect((commits[i]?.t ?? 0) - (commits[i - 1]?.t ?? 0)).toBeGreaterThanOrEqual(250);
    }
    const last = controller.get();
    expect(last.loadedFraction).toBe(1);
    expect(last.session?.loadedThroughSeq).toBe(30);
    expect(last.terminal).toBe(true);
    expect(last.rows).toBe(30);
    expect(scheduler.pending()).toBe(0);
  });

  it("starts the session summary and the first rows page before either resolves", async () => {
    const scheduler = new FakeScheduler();
    const { source: inner, control } = fakeSource(messageRows(4), { state: "completed" });
    const order: string[] = [];
    let resolveSummary: (summary: Awaited<ReturnType<TraceSource["summary"]>>) => void = () => undefined;
    const source: TraceSource = {
      ...inner,
      summary: () => {
        order.push("summary");
        return new Promise((resolve) => {
          resolveSummary = resolve;
        });
      },
    };
    const controller = createDataController({ source, pollMs: 1_000, scheduler, isHidden: () => false });
    controller.start();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    // Serial loading would still be waiting on the summary and have made no rows call.
    expect(order).toEqual(["summary"]);
    expect(control.calls).toHaveLength(1);
    expect(controller.get().session).toBeNull();

    resolveSummary(testMeta({ state: "completed" }));
    await scheduler.run(100);
    expect(control.calls).toHaveLength(1);
    expect(controller.get().session?.loadedThroughSeq).toBe(4);
    expect(controller.get().terminal).toBe(true);
  });

  it("a rows failure while the summary is in flight surfaces as before, and a summary failure ignores the rows", async () => {
    const scheduler = new FakeScheduler();
    const rowsFail = fakeSource(messageRows(3), { state: "completed" });
    rowsFail.control.failures = 1;
    const a = createDataController({ source: rowsFail.source, pollMs: 1_000, scheduler, isHidden: () => false });
    a.start();
    await scheduler.run(100);
    expect(a.get().status.kind).toBe("error");
    expect(a.get().session).toBeNull();

    const summaryFail = fakeSource(messageRows(3), { state: "completed" });
    summaryFail.control.summaryError = new TraceSourceError("trace:listSessions", "UNKNOWN_SESSION", "gone");
    const b = createDataController({ source: summaryFail.source, pollMs: 1_000, scheduler, isHidden: () => false });
    b.start();
    await scheduler.run(100);
    expect(b.get().status.kind).toBe("error");
    expect(b.get().session).toBeNull();
    expect(scheduler.pending()).toBe(0);
  });

  it("a source whose rows() throws synchronously fails the load like a rejection", async () => {
    const scheduler = new FakeScheduler();
    const { source, control } = fakeSource(messageRows(3), { state: "completed" });
    control.onRows = () => {
      throw new Error("bridge missing");
    };
    const controller = createDataController({ source, pollMs: 1_000, scheduler, isHidden: () => false });
    controller.start();
    await scheduler.run(100);
    expect(controller.get().status.kind).toBe("error");
    expect(controller.get().session).toBeNull();
  });

  it("yields a macrotask after each page so the first commit can paint before the next page folds", async () => {
    const scheduler = new FakeScheduler();
    const { source, control } = fakeSource(messageRows(9), { state: "completed" });
    const controller = createDataController({ source, pollMs: 1_000, pageSize: 3, scheduler, isHidden: () => false });
    const seen = record(controller, scheduler);
    controller.start();
    // Drain microtasks only: no scheduler timer runs, so a page loop that never yields would fold every page here.
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
    // The second page is already requested (pipelined), but only the first is folded and committed.
    expect(control.calls.map((call) => call.afterSeq)).toEqual([0, 3]);
    const commits = seen.filter((entry) => entry.snapshot.session !== null);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.snapshot.session?.loadedThroughSeq).toBe(3);
    expect(scheduler.pending()).toBeGreaterThan(0);

    await scheduler.run(2_000);
    expect(control.calls.map((call) => call.afterSeq)).toEqual([0, 3, 6, 9]);
    expect(controller.get().loadedFraction).toBe(1);
    expect(controller.get().terminal).toBe(true);
    expect(scheduler.pending()).toBe(0);
  });

  it("requests the next page while the current one folds, one request ahead at most (M5 full load)", async () => {
    const scheduler = new FakeScheduler();
    const rows = messageRows(12);
    const { source, control } = fakeSource(rows, { state: "completed" });
    control.deferNext = true;
    const controller = createDataController({ source, pollMs: 1_000, pageSize: 3, scheduler, isHidden: () => false });
    controller.start();
    await settle();
    // First page in flight: nothing else is requested before it returns.
    expect(control.calls.map((call) => call.afterSeq)).toEqual([0]);
    control.deferNext = true;
    control.deferred.shift()?.resolve({ rows: rows.slice(0, 3), nextAfterSeq: 3, lastSeq: 12, state: "completed" });
    await settle();
    // Page 2 is requested as soon as page 1 arrives, before the yield that precedes its fold, and
    // while page 2 is in flight no third request starts.
    expect(control.calls.map((call) => call.afterSeq)).toEqual([0, 3]);
    await scheduler.run(10);
    expect(control.calls.map((call) => call.afterSeq)).toEqual([0, 3]);
    expect(controller.get().session?.loadedThroughSeq).toBe(3);

    control.deferred.shift()?.resolve({ rows: rows.slice(3, 6), nextAfterSeq: 6, lastSeq: 12, state: "completed" });
    await scheduler.run(2_000);
    expect(control.calls.map((call) => call.afterSeq)).toEqual([0, 3, 6, 9, 12]);
    expect(controller.get().session?.loadedThroughSeq).toBe(12);
    expect(controller.get().loadedFraction).toBe(1);
    expect(scheduler.pending()).toBe(0);
  });

  it("a failed pipelined page reconnects and re-requests from the last folded page", async () => {
    const scheduler = new FakeScheduler();
    const { source, control } = fakeSource(messageRows(9), { state: "completed" });
    let failedOnce = false;
    control.onRows = (request) => {
      if (request.afterSeq === 3 && !failedOnce) {
        failedOnce = true;
        control.failures = 1;
      }
    };
    const controller = createDataController({ source, pollMs: 1_000, pageSize: 3, scheduler, isHidden: () => false });
    const seen = record(controller, scheduler);
    controller.start();
    await scheduler.run(5_000);

    expect(control.calls.map((call) => call.afterSeq)).toEqual([0, 3, 3, 6, 9]);
    expect(seen.some((entry) => entry.snapshot.status.kind === "reconnecting")).toBe(true);
    const last = controller.get();
    expect(last.status.kind).toBe("ready");
    expect(last.session?.loadedThroughSeq).toBe(9);
    expect(last.rows).toBe(9);
    expect(scheduler.pending()).toBe(0);
  });

  it("spaces progressive commits by COMMIT_COST_FACTOR x the last finalize while catching up", async () => {
    const scheduler = new FakeScheduler();
    const { source: inner, control } = fakeSource(messageRows(90), { state: "completed" });
    control.onRows = () => scheduler.spend(20);
    // commitNow reads the source clock once per finalize: the fake bills each commit 100 ms there.
    const source: TraceSource = { ...inner, now: () => (scheduler.spend(100), 0) };
    const controller = createDataController({ source, pollMs: 1_000, pageSize: 3, scheduler, isHidden: () => false });
    const seen = record(controller, scheduler);
    controller.start();
    await scheduler.run(10_000);

    const commits = seen.filter((entry) => entry.snapshot.session !== null);
    const progressive = commits.filter((entry) => entry.snapshot.loadedFraction < 1);
    expect(progressive.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < progressive.length; i += 1) {
      expect((progressive[i]?.t ?? 0) - (progressive[i - 1]?.t ?? 0)).toBeGreaterThanOrEqual(COMMIT_COST_FACTOR * 100);
    }
    expect(controller.get().session?.loadedThroughSeq).toBe(90);
    expect(controller.get().loadedFraction).toBe(1);
  });

  it("the caught-up commit replaces a pending progressive commit and waits only the 250 ms cap", async () => {
    const scheduler = new FakeScheduler();
    const rows = messageRows(9);
    const { source: inner, control } = fakeSource(rows, { state: "completed" });
    const source: TraceSource = { ...inner, now: () => (scheduler.spend(100), 0) };
    control.deferNext = true;
    const controller = createDataController({ source, pollMs: 1_000, pageSize: 3, scheduler, isHidden: () => false });
    const seen = record(controller, scheduler);
    controller.start();
    await settle();

    control.deferNext = true;
    control.deferred.shift()?.resolve({ rows: rows.slice(0, 3), nextAfterSeq: 3, lastSeq: 9, state: "completed" });
    await settle(); // first commit at once: finalize 0 -> 100
    expect(seen.map((entry) => entry.t)).toEqual([0, 100]); // summary, then the first commit

    await scheduler.run(50); // t = 150
    control.deferNext = true;
    control.deferred.shift()?.resolve({ rows: rows.slice(3, 6), nextAfterSeq: 6, lastSeq: 9, state: "completed" });
    await scheduler.run(50); // progressive commit pending until 100 + 4 x 100 = 500; t = 200
    control.deferred.shift()?.resolve({ rows: rows.slice(6, 9), nextAfterSeq: null, lastSeq: 9, state: "completed" });
    await scheduler.run(1_000);

    const commits = seen.filter((entry) => entry.snapshot.session !== null);
    // Caught up at t = 200: the commit starts at 100 + 250 = 350 (not 500) and emits after its 100 ms finalize.
    expect(commits.map((entry) => entry.t)).toEqual([100, 450]);
    expect(commits[1]?.snapshot.loadedFraction).toBe(1);
    expect(controller.get().terminal).toBe(true);
    expect(scheduler.pending()).toBe(0);
  });

  it("polls every pollMs until terminal, applies once more, then stops", async () => {
    const scheduler = new FakeScheduler();
    const { source, control } = fakeSource(messageRows(5), { state: "running", released: 3 });
    const controller = createDataController({ source, pollMs: 1_000, scheduler, isHidden: () => false });
    controller.start();
    await scheduler.run(100);
    expect(controller.get().session?.loadedThroughSeq).toBe(3);
    expect(controller.get().terminal).toBe(false);

    const before = controller.get();
    await scheduler.run(1_000);
    expect(control.calls.at(-1)?.afterSeq).toBe(3);
    expect(controller.get()).toBe(before);

    control.released = 5;
    await scheduler.run(1_000);
    expect(controller.get().session?.loadedThroughSeq).toBe(5);

    control.state = "completed";
    await scheduler.run(1_000);
    expect(controller.get().terminal).toBe(true);
    const calls = control.calls.length;
    await scheduler.run(5_000);
    expect(control.calls.length).toBe(calls);
  });

  it("keeps polling a paused session", async () => {
    const scheduler = new FakeScheduler();
    const { source, control } = fakeSource(messageRows(3), { state: "paused" });
    const controller = createDataController({ source, pollMs: 1_000, scheduler, isHidden: () => false });
    controller.start();
    await scheduler.run(100);
    const calls = control.calls.length;
    await scheduler.run(3_000);
    expect(control.calls.length).toBe(calls + 3);
    expect(controller.get().terminal).toBe(false);
  });

  it("a rejected poll reconnects with backoff and keeps the session", async () => {
    const scheduler = new FakeScheduler();
    const { source, control } = fakeSource(messageRows(3), { state: "running" });
    const controller = createDataController({ source, pollMs: 1_000, scheduler, isHidden: () => false });
    const seen = record(controller, scheduler);
    controller.start();
    await scheduler.run(100);
    const loaded = controller.get().session;
    expect(loaded).not.toBeNull();

    control.failures = 5;
    await scheduler.run(40_000);
    const reconnecting = seen
      .map((entry) => entry.snapshot)
      .filter((snapshot) => snapshot.status.kind === "reconnecting");
    expect(reconnecting.map((snapshot) => (snapshot.status.kind === "reconnecting" ? snapshot.status.retryInMs : 0))).toEqual([
      1_000, 2_000, 4_000, 10_000, 10_000,
    ]);
    expect(reconnecting.map((snapshot) => (snapshot.status.kind === "reconnecting" ? snapshot.status.attempt : 0))).toEqual([1, 2, 3, 4, 5]);
    for (const snapshot of reconnecting) expect(snapshot.session).toBe(loaded);
    expect(controller.get().status.kind).toBe("ready");
    expect(BACKOFF_MS).toEqual([1_000, 2_000, 4_000, 10_000]);
  });

  it("restarts the backoff at 1 s after a success followed by a new failure", async () => {
    const scheduler = new FakeScheduler();
    const { source, control } = fakeSource(messageRows(3), { state: "running" });
    const controller = createDataController({ source, pollMs: 1_000, scheduler, isHidden: () => false });
    const seen = record(controller, scheduler);
    controller.start();
    await scheduler.run(100);

    // fail (retry in 1 s), fail (retry in 2 s), then the third poll succeeds.
    control.failures = 2;
    await scheduler.run(3_950);
    expect(controller.get().status.kind).toBe("ready");

    control.failures = 1;
    await scheduler.run(1_500);
    const delays = seen
      .map((entry) => entry.snapshot.status)
      .flatMap((status) => (status.kind === "reconnecting" ? [status.retryInMs] : []));
    expect(delays).toEqual([1_000, 2_000, 1_000]);
    const last = seen.at(-1)?.snapshot.status;
    expect(last?.kind === "reconnecting" ? last.attempt : 0).toBe(1);
  });

  it("stop() during an in-flight poll clears every timer and drops the late response", async () => {
    const scheduler = new FakeScheduler();
    const { source, control } = fakeSource(messageRows(5), { state: "running", released: 3 });
    const controller = createDataController({ source, pollMs: 1_000, scheduler, isHidden: () => false });
    const seen = record(controller, scheduler);
    controller.start();
    await scheduler.run(100);

    control.deferNext = true;
    await scheduler.run(1_000);
    expect(control.deferred).toHaveLength(1);
    const before = controller.get();
    const count = seen.length;

    controller.stop();
    expect(scheduler.pending()).toBe(0);

    control.deferred[0]?.resolve({ rows: messageRows(5).slice(3), nextAfterSeq: null, lastSeq: 5, state: "completed" });
    await scheduler.run(10_000);
    expect(scheduler.pending()).toBe(0);
    expect(seen.length).toBe(count);
    expect(controller.get()).toBe(before);
    expect(controller.get().session?.loadedThroughSeq).toBe(3);
  });

  it("drops a response that a retry superseded", async () => {
    const scheduler = new FakeScheduler();
    const rows = messageRows(5);
    const { source, control } = fakeSource(rows, { state: "running", released: 3 });
    const controller = createDataController({ source, pollMs: 1_000, scheduler, isHidden: () => false });
    const seen = record(controller, scheduler);
    controller.start();
    await scheduler.run(100);

    control.deferNext = true;
    await scheduler.run(1_000);
    expect(control.deferred).toHaveLength(1);

    control.released = 5;
    controller.retry();
    await scheduler.run(10);
    expect(controller.get().session?.loadedThroughSeq).toBe(5);
    const count = seen.length;

    const stale = control.deferred[0];
    stale?.resolve({ rows: [], nextAfterSeq: null, lastSeq: 99, state: "failed" });
    await scheduler.run(10);
    expect(seen.length).toBe(count);
    expect(controller.get().terminal).toBe(false);
    expect(controller.get().session?.loadedThroughSeq).toBe(5);
  });

  it("holds applies during a gesture and applies the latest once", async () => {
    const scheduler = new FakeScheduler();
    const { source, control } = fakeSource(messageRows(5), { state: "running", released: 3 });
    const controller = createDataController({ source, pollMs: 1_000, scheduler, isHidden: () => false });
    const seen = record(controller, scheduler);
    controller.start();
    await scheduler.run(100);
    const count = seen.length;

    controller.hold(true);
    control.released = 4;
    await scheduler.run(1_000);
    control.released = 5;
    await scheduler.run(1_000);
    expect(seen.length).toBe(count);
    expect(controller.get().session?.loadedThroughSeq).toBe(3);

    controller.hold(false);
    expect(seen.length).toBe(count + 1);
    expect(seen.at(-1)?.snapshot.session?.loadedThroughSeq).toBe(5);
  });

  it("polls while hidden and emits once on notifyVisible", async () => {
    const scheduler = new FakeScheduler();
    let hidden = false;
    const { source, control } = fakeSource(messageRows(6), { state: "running", released: 3 });
    const controller = createDataController({ source, pollMs: 1_000, scheduler, isHidden: () => hidden });
    const seen = record(controller, scheduler);
    controller.start();
    await scheduler.run(100);
    const count = seen.length;
    const calls = control.calls.length;

    hidden = true;
    control.released = 5;
    await scheduler.run(1_000);
    control.released = 6;
    await scheduler.run(1_000);
    expect(control.calls.length).toBe(calls + 2);
    expect(seen.length).toBe(count);

    hidden = false;
    controller.notifyVisible();
    expect(seen.length).toBe(count + 1);
    expect(controller.get().session?.loadedThroughSeq).toBe(6);
  });

  it("reports a first-load failure with its channel and recovers on retry", async () => {
    const scheduler = new FakeScheduler();
    const { source, control } = fakeSource(messageRows(3), { state: "completed" });
    control.summaryError = new TraceSourceError("trace:listSessions", "UNKNOWN_SESSION", "no session sess-test");
    const controller = createDataController({ source, pollMs: 1_000, scheduler, isHidden: () => false });
    controller.start();
    await scheduler.run(100);
    expect(controller.get().status).toEqual({
      kind: "error",
      channel: "trace:listSessions",
      code: "UNKNOWN_SESSION",
      message: "no session sess-test",
    });

    controller.retry();
    await scheduler.run(100);
    expect(controller.get().status.kind).toBe("ready");
    expect(controller.get().session?.loadedThroughSeq).toBe(3);
  });

  it("marks the live-tick start only when a poll brings rows after the full load", async () => {
    performance.clearMarks(LIVE_TICK_START);
    const scheduler = new FakeScheduler();
    const { source, control } = fakeSource(messageRows(5), { state: "running", released: 3 });
    const controller = createDataController({ source, pollMs: 1_000, scheduler, isHidden: () => false });
    controller.start();
    await scheduler.run(100);
    expect(performance.getEntriesByName(LIVE_TICK_START, "mark")).toHaveLength(0);

    await scheduler.run(1_000);
    expect(performance.getEntriesByName(LIVE_TICK_START, "mark")).toHaveLength(0);

    control.released = 5;
    await scheduler.run(1_000);
    expect(controller.get().session?.loadedThroughSeq).toBe(5);
    expect(performance.getEntriesByName(LIVE_TICK_START, "mark")).toHaveLength(1);
    performance.clearMarks(LIVE_TICK_START);
  });
});
