import { openDb } from "@jevcode/storage";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  ROWS_AVAILABLE_CHANNEL,
  ROWS_AVAILABLE_MIN_INTERVAL_MS,
  createRowsAvailableEmitter,
  observeTraceAppends,
  rowsAvailableTargets,
} from "./rows-available.js";
import type { PushContents, RowsAvailableTarget } from "./rows-available.js";

class VirtualClock {
  time = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  readonly now = (): number => this.time;

  readonly setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.time + ms, fn });
    return id;
  };

  readonly clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  advanceTo(target: number): void {
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.time = Math.max(this.time, due[1].at);
      due[1].fn();
    }
    this.time = Math.max(this.time, target);
  }

  pending(): number {
    return this.timers.size;
  }
}

interface Sent {
  at: number;
  channel: string;
  payload: { sessionId: string; lastSeq: number };
}

type FakeContents = PushContents & { sent: Sent[]; destroyed: boolean; throws: boolean };

function fakeContents(clock: VirtualClock, id: number): FakeContents {
  const contents: FakeContents = {
    id,
    sent: [],
    destroyed: false,
    throws: false,
    send(channel, payload) {
      if (contents.throws) throw new Error("render frame disposed");
      contents.sent.push({ at: clock.now(), channel, payload });
    },
    isDestroyed: () => contents.destroyed,
  };
  return contents;
}

function setup(targets?: (clock: VirtualClock) => (sessionId: string) => readonly RowsAvailableTarget[]) {
  const clock = new VirtualClock();
  const main = fakeContents(clock, 1);
  const emitter = createRowsAvailableEmitter({
    targets: targets?.(clock) ?? (() => [{ kind: "main", contents: main }]),
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  return { clock, main, emitter };
}

describe("createRowsAvailableEmitter", () => {
  it("uses the spec's channel and 50 ms per-session bound (spec §7)", () => {
    expect(ROWS_AVAILABLE_CHANNEL).toBe("trace:rowsAvailable");
    expect(ROWS_AVAILABLE_MIN_INTERVAL_MS).toBe(50);
  });

  it("sends the first append at once with its seq", () => {
    const { main, emitter } = setup();
    emitter.notify("sess_a", 7);
    expect(main.sent).toEqual([{ at: 0, channel: "trace:rowsAvailable", payload: { sessionId: "sess_a", lastSeq: 7 } }]);
  });

  it("coalesces a burst into one trailing hint that carries the latest seq", () => {
    const { clock, main, emitter } = setup();
    for (const [at, seq] of [[0, 1], [10, 2], [20, 3], [30, 4], [40, 5]] as const) {
      clock.advanceTo(at);
      emitter.notify("sess_a", seq);
    }
    clock.advanceTo(200);
    expect(main.sent.map((entry) => [entry.at, entry.payload.lastSeq])).toEqual([
      [0, 1],
      [50, 5],
    ]);
  });

  it("keeps sessions independent", () => {
    const { main, emitter } = setup();
    emitter.notify("sess_a", 1);
    emitter.notify("sess_b", 1);
    expect(main.sent.map((entry) => entry.payload)).toEqual([
      { sessionId: "sess_a", lastSeq: 1 },
      { sessionId: "sess_b", lastSeq: 1 },
    ]);
  });

  it("ignores a seq it has already announced and malformed input", () => {
    const { clock, main, emitter } = setup();
    emitter.notify("sess_a", 4);
    clock.advanceTo(20);
    emitter.notify("sess_a", 4);
    emitter.notify("sess_a", 3);
    clock.advanceTo(100);
    emitter.notify("", 9);
    emitter.notify("sess_a", 0);
    emitter.notify("sess_a", 1.5);
    clock.advanceTo(300);
    expect(main.sent).toHaveLength(1);
  });

  it("sends only to the windows showing that session", () => {
    const traceA = { current: null as FakeContents | null };
    const traceB = { current: null as FakeContents | null };
    const { clock, main, emitter } = setup((clock) => {
      traceA.current = fakeContents(clock, 100);
      traceB.current = fakeContents(clock, 101);
      return (sessionId) =>
        sessionId === "sess_a"
          ? [{ kind: "trace", contents: traceA.current as FakeContents }]
          : [{ kind: "trace", contents: traceB.current as FakeContents }];
    });
    emitter.notify("sess_a", 3);
    clock.advanceTo(100);
    expect(traceA.current?.sent.map((entry) => entry.payload)).toEqual([{ sessionId: "sess_a", lastSeq: 3 }]);
    expect(traceB.current?.sent).toEqual([]);
    expect(main.sent).toEqual([]);
  });

  it("drops a destroyed window and keeps sending to the rest when one send throws", () => {
    const windows = { gone: null as FakeContents | null, broken: null as FakeContents | null, ok: null as FakeContents | null };
    const { emitter } = setup((clock) => {
      windows.gone = fakeContents(clock, 100);
      windows.broken = fakeContents(clock, 101);
      windows.ok = fakeContents(clock, 102);
      windows.gone.destroyed = true;
      windows.broken.throws = true;
      return () => [
        { kind: "trace", contents: windows.gone as FakeContents },
        { kind: "trace", contents: windows.broken as FakeContents },
        { kind: "trace", contents: windows.ok as FakeContents },
      ];
    });
    emitter.notify("sess_a", 2);
    expect(windows.gone?.sent).toEqual([]);
    expect(windows.ok?.sent.map((entry) => entry.payload.lastSeq)).toEqual([2]);
  });

  it("a throwing targets() in the trailing timer does not throw out of the timer and logs", () => {
    const clock = new VirtualClock();
    const main = fakeContents(clock, 1);
    const logs: string[] = [];
    let explode = false;
    const emitter = createRowsAvailableEmitter({
      targets: () => {
        if (explode) throw new Error("webContents.fromId failed");
        return [{ kind: "main", contents: main }];
      },
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      log: (message) => logs.push(message),
    });
    emitter.notify("sess_a", 1);
    clock.advanceTo(10);
    emitter.notify("sess_a", 2);
    explode = true;
    expect(() => clock.advanceTo(100)).not.toThrow();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("webContents.fromId failed");
    explode = false;
    clock.advanceTo(300);
    emitter.notify("sess_a", 3);
    expect(main.sent.map((entry) => entry.payload.lastSeq)).toEqual([1, 3]);
  });

  it("sends nothing and throws nothing when a window is destroyed between scheduling and the trailing send", () => {
    const { clock, main, emitter } = setup();
    emitter.notify("sess_a", 1);
    clock.advanceTo(10);
    emitter.notify("sess_a", 2);
    main.destroyed = true;
    expect(() => clock.advanceTo(100)).not.toThrow();
    expect(main.sent.map((entry) => entry.payload.lastSeq)).toEqual([1]);
  });

  it("prunes a session's slot once its timer fired and a quiet interval passed", () => {
    const { clock, main, emitter } = setup();
    emitter.notify("sess_a", 5);
    clock.advanceTo(10);
    emitter.notify("sess_a", 6);
    clock.advanceTo(200);
    // Another session's activity after the quiet interval sweeps the idle slot.
    emitter.notify("sess_b", 1);
    // A pruned slot has no memory of seq 6, so a restarted counter is announced again.
    emitter.notify("sess_a", 2);
    expect(main.sent.filter((entry) => entry.payload.sessionId === "sess_a").map((entry) => entry.payload.lastSeq)).toEqual([
      5, 6, 2,
    ]);
  });

  it("re-announces a stale seq after a quiet interval (dedup memory only lives with the slot)", () => {
    const { clock, main, emitter } = setup();
    emitter.notify("sess_a", 4);
    clock.advanceTo(100);
    emitter.notify("sess_a", 4);
    expect(main.sent.map((entry) => entry.payload.lastSeq)).toEqual([4, 4]);
  });

  it("drops idle slots: many sessions with one leading send each shrink to one slot", () => {
    const { clock, emitter } = setup();
    for (let i = 0; i < 200; i += 1) emitter.notify(`sess_${i}`, 1);
    expect(emitter.slotCount()).toBe(200);
    clock.advanceTo(100);
    emitter.notify("sess_live", 1);
    expect(emitter.slotCount()).toBe(1);
  });

  it("dispose cancels a pending trailing hint", () => {
    const { clock, main, emitter } = setup();
    emitter.notify("sess_a", 1);
    clock.advanceTo(10);
    emitter.notify("sess_a", 2);
    expect(clock.pending()).toBe(1);
    emitter.dispose();
    clock.advanceTo(500);
    expect(main.sent.map((entry) => entry.payload.lastSeq)).toEqual([1]);
    emitter.notify("sess_a", 3);
    expect(main.sent).toHaveLength(1);
  });

  it("never sends faster than 50 ms per session and never drops the tail", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ dt: fc.integer({ min: 0, max: 120 }), session: fc.constantFrom("sess_a", "sess_b") }),
          { minLength: 1, maxLength: 60 },
        ),
        (events) => {
          const { clock, main, emitter } = setup();
          const seqs: Record<string, number> = { sess_a: 0, sess_b: 0 };
          const appends: Array<{ session: string; seq: number; at: number }> = [];
          let t = 0;
          for (const event of events) {
            t += event.dt;
            clock.advanceTo(t);
            seqs[event.session] = (seqs[event.session] ?? 0) + 1;
            const seq = seqs[event.session] ?? 0;
            appends.push({ session: event.session, seq, at: t });
            emitter.notify(event.session, seq);
          }
          clock.advanceTo(t + 1_000);
          for (const session of ["sess_a", "sess_b"]) {
            const sends = main.sent.filter((entry) => entry.payload.sessionId === session);
            for (let i = 1; i < sends.length; i += 1) {
              const previous = sends[i - 1];
              const current = sends[i];
              if (previous === undefined || current === undefined) continue;
              expect(current.at - previous.at).toBeGreaterThanOrEqual(50);
              expect(current.payload.lastSeq).toBeGreaterThan(previous.payload.lastSeq);
            }
            const max = seqs[session] ?? 0;
            if (max > 0) expect(sends.at(-1)?.payload.lastSeq).toBe(max);
            for (const append of appends.filter((entry) => entry.session === session)) {
              const covering = sends.find((entry) => entry.payload.lastSeq >= append.seq && entry.at >= append.at);
              expect(covering).toBeDefined();
              expect((covering?.at ?? Infinity) - append.at).toBeLessThanOrEqual(50);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("rowsAvailableTargets", () => {
  const contents = (id: number): PushContents => ({ id, send: () => undefined, isDestroyed: () => false });

  it("includes the main window only while it shows the session, and every trace window on it", () => {
    const main = contents(1);
    const byId = new Map<number, PushContents>([[100, contents(100)], [101, contents(101)]]);
    const windows = { main, traceSenderIds: [100, 101], fromId: (id: number) => byId.get(id) ?? null };
    expect(
      rowsAvailableTargets("sess_a", { ...windows, mainSessionId: "sess_a" }).map((t) => [t.kind, t.contents.id]),
    ).toEqual([["main", 1], ["trace", 100], ["trace", 101]]);
    expect(
      rowsAvailableTargets("sess_a", { ...windows, mainSessionId: "sess_b" }).map((t) => [t.kind, t.contents.id]),
    ).toEqual([["trace", 100], ["trace", 101]]);
    expect(rowsAvailableTargets("sess_a", { main: null, mainSessionId: "sess_a", traceSenderIds: [7], fromId: () => null })).toEqual([]);
  });
});

describe("observeTraceAppends", () => {
  function seeded() {
    const db = openDb({ dbPath: ":memory:" });
    db.upsertRepository({ id: "repo_a", path: "/a", gitRoot: "/a" });
    db.createSession({ id: "sess_a", repoId: "repo_a", prompt: "demo" });
    return db;
  }
  const message = (text: string) => ({
    type: "agent_message" as const,
    sessionId: "sess_a",
    role: "assistant" as const,
    text,
    ts: "2026-10-02T10:00:00.000Z",
  });

  it("reports every committed trace-row append with its seq, including the typed helpers", () => {
    const db = seeded();
    const seen: Array<{ sessionId: string; seq: number; type: string }> = [];
    observeTraceAppends(db, (event) => seen.push(event));
    db.appendAgentEvent("sess_a", message("one"));
    db.appendAgentEvent("sess_a", message("two"));
    expect(seen).toEqual([
      { sessionId: "sess_a", seq: 1, type: "agent_event" },
      { sessionId: "sess_a", seq: 2, type: "agent_event" },
    ]);
    db.close();
  });

  it("ignores rows the trace never reads and appends that fail", () => {
    const db = seeded();
    const seen: unknown[] = [];
    observeTraceAppends(db, (event) => seen.push(event));
    db.appendTelemetry("agent_event_count", {}, "sess_a");
    expect(() => db.appendAgentEvent("sess_missing", { ...message("x"), sessionId: "sess_missing" })).toThrow();
    expect(seen).toEqual([]);
    db.close();
  });

  it("never fails a write when the listener throws", () => {
    const db = seeded();
    observeTraceAppends(db, () => {
      throw new Error("listener bug");
    });
    expect(db.appendAgentEvent("sess_a", message("kept")).seq).toBe(1);
    expect(db.listEvents("sess_a")).toHaveLength(1);
    db.close();
  });

  it("stops reporting after dispose", () => {
    const db = seeded();
    const seen: unknown[] = [];
    const dispose = observeTraceAppends(db, (event) => seen.push(event));
    dispose();
    db.appendAgentEvent("sess_a", message("after"));
    expect(seen).toEqual([]);
    db.close();
  });
});

describe("hint recipients end to end (per-sender allowlist)", () => {
  it("reaches the main window only on its session and trace windows only on theirs, and nothing else", () => {
    const clock = new VirtualClock();
    const main = fakeContents(clock, 1);
    const traceA = fakeContents(clock, 100);
    const traceB = fakeContents(clock, 101);
    const stranger = fakeContents(clock, 200);
    const byId = new Map<number, PushContents>([[1, main], [100, traceA], [101, traceB], [200, stranger]]);
    const sessionOfTrace = new Map<number, string>([[100, "sess_a"], [101, "sess_b"]]);
    const emitter = createRowsAvailableEmitter({
      targets: (sessionId) =>
        rowsAvailableTargets(sessionId, {
          main,
          mainSessionId: "sess_a",
          traceSenderIds: [...sessionOfTrace].filter(([, shown]) => shown === sessionId).map(([id]) => id),
          fromId: (id) => byId.get(id) ?? null,
        }),
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
    emitter.notify("sess_a", 5);
    emitter.notify("sess_b", 2);
    expect(main.sent.map((s) => s.payload)).toEqual([{ sessionId: "sess_a", lastSeq: 5 }]);
    expect(traceA.sent.map((s) => s.payload)).toEqual([{ sessionId: "sess_a", lastSeq: 5 }]);
    expect(traceB.sent.map((s) => s.payload)).toEqual([{ sessionId: "sess_b", lastSeq: 2 }]);
    expect(stranger.sent).toEqual([]);
  });
});
