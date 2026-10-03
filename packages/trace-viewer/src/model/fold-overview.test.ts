import { ComponentSchema, type Component, type OverviewSnapshot } from "@jevcode/contracts";
import { describe, expect, it } from "vitest";

import { overviewSnapshot } from "../test-support/overview-builder.js";
import { SESSION_ID, TraceBuilder, testMeta } from "../test-support/trace-builder.js";
import { accumulateAll, createTraceState, finalize, foldRows } from "./fold.js";
import { COMPONENT_KEYS, sameComponent } from "./fold-overview.js";
import { overviewStatusOf } from "./overview-status.js";
import type { TraceSession } from "./types.js";

// Spec §8.1: the fold keeps the latest overview_snapshot row (replace semantics); unchanged components keep their
// identity through id plus content hash (viewer spec §6.4 identity rules).

const WEB = { rootPath: "apps/web", role: "ui" } as const;
const API = { rootPath: "packages/api", role: "api" } as const;
const DB = { rootPath: "packages/db", role: "storage" } as const;
const EDGES = [{ from: "apps/web", to: "packages/api", count: 3 }];
const A = overviewSnapshot({ components: [WEB, API, DB], edges: EDGES });
const B = overviewSnapshot({ components: [WEB, { ...API, purpose: "Serves the web app.", provenance: "model" }, DB], edges: EDGES });
const C = overviewSnapshot({ components: [WEB, API, { ...DB, version: 1 }, { rootPath: "packages/jobs", role: "agent" }], edges: EDGES });

function componentIn(session: TraceSession, snapshot: OverviewSnapshot, index: number): Component | undefined {
  const id = snapshot.components[index]?.id;
  return id === undefined ? undefined : session.overview?.componentById.get(id);
}

function started(): TraceBuilder {
  const b = new TraceBuilder();
  b.agent({ type: "agent_started", prompt: "Map the repo" });
  return b;
}

describe("overview_snapshot fold (spec §8.1)", () => {
  it("has no overview without a snapshot row", () => {
    const b = started();
    expect(foldRows(testMeta({ lastEventSeq: b.rows.length }), b.rows, { live: false }).overview).toBeNull();
  });

  it("keeps the latest snapshot row (replace semantics)", () => {
    const b = started();
    b.overview(A);
    b.agent({ type: "agent_message", role: "assistant", text: "Working" });
    const seqB = b.overview(B);
    const session = foldRows(testMeta({ lastEventSeq: b.rows.length }), b.rows, { live: false });
    expect(session.overview?.seq).toBe(seqB);
    expect(session.overview?.snapshot).toEqual(B);
    expect([...(session.overview?.componentById.keys() ?? [])]).toEqual(B.components.map((component) => component.id));
  });

  it("folds a snapshot row without status: status stays undefined and overviewStatusOf gives the R3 default", () => {
    const b = started();
    b.overview(A);
    const snapshot = foldRows(testMeta({ lastEventSeq: b.rows.length }), b.rows, { live: false }).overview?.snapshot;
    if (snapshot === undefined) throw new Error("no overview");
    expect(snapshot.status).toBeUndefined();
    expect(overviewStatusOf(snapshot)).toEqual({ scan: { state: "done", scanned: snapshot.counts.files, total: snapshot.counts.files }, narrator: "pending" });
  });

  it("makes no step, moves no clock and counts nowhere in hidden", () => {
    const b = started();
    b.agent({ type: "agent_message", role: "assistant", text: "Working" });
    const without = foldRows(testMeta({ lastEventSeq: b.rows.length }), b.rows, { live: false });
    b.overview(A, TraceBuilder.at(3_600));
    const withRow = foldRows(testMeta({ lastEventSeq: b.rows.length }), b.rows, { live: false });
    expect(withRow.steps).toEqual(without.steps);
    expect(withRow.span).toEqual(without.span);
    expect(withRow.hidden.byType).toEqual({});
    expect(withRow.gaps).toEqual([]);
    expect(withRow.overview?.snapshot).toEqual(A);
  });

  it("an invalid snapshot row adds an invalid_row gap and keeps the earlier overview", () => {
    const b = started();
    b.overview(A);
    const bad = b.raw("overview_snapshot", { sessionId: SESSION_ID, repoRoot: "" });
    const session = foldRows(testMeta({ lastEventSeq: b.rows.length }), b.rows, { live: false });
    expect(session.overview?.snapshot).toEqual(A);
    expect(session.gaps).toEqual([expect.objectContaining({ kind: "invalid_row", atSeq: bad })]);
  });

  it("keeps the overview object while no snapshot row arrives", () => {
    const b = started();
    b.overview(A);
    const state = accumulateAll(createTraceState(testMeta()), b.rows);
    const first = finalize(state, { live: true });
    const cut = b.rows.length;
    b.agent({ type: "agent_message", role: "assistant", text: "Still working" });
    accumulateAll(state, b.rows.slice(cut));
    const second = finalize(state, { live: true });
    expect(second.overview).not.toBeNull();
    expect(second.overview).toBe(first.overview);
  });

  it("a new snapshot replaces the overview and keeps unchanged components by id and content hash", () => {
    const b = started();
    b.overview(A);
    const state = accumulateAll(createTraceState(testMeta()), b.rows);
    const first = finalize(state, { live: true });
    const cut = b.rows.length;
    b.overview(B);
    accumulateAll(state, b.rows.slice(cut));
    const second = finalize(state, { live: true });
    expect(second.overview).not.toBe(first.overview);
    expect(componentIn(second, B, 0)).toBe(componentIn(first, A, 0));
    expect(componentIn(second, B, 2)).toBe(componentIn(first, A, 2));
    expect(componentIn(second, B, 1)).not.toBe(componentIn(first, A, 1));
    expect(componentIn(second, B, 1)?.purpose).toBe("Serves the web app.");
    expect(second.overview?.snapshot.components[0]).toBe(componentIn(first, A, 0));

    const cut2 = b.rows.length;
    b.overview(C);
    accumulateAll(state, b.rows.slice(cut2));
    const third = finalize(state, { live: true });
    expect(componentIn(third, C, 0)).toBe(componentIn(second, B, 0));
    expect(componentIn(third, C, 2)).not.toBe(componentIn(second, B, 2));
    expect(componentIn(third, C, 3)?.rootPath).toBe("packages/jobs");
  });

  it("a live flip re-derives a deep-equal overview", () => {
    const b = started();
    b.overview(A);
    const state = accumulateAll(createTraceState(testMeta()), b.rows);
    const live = finalize(state, { live: true });
    const done = finalize(state, { live: false });
    expect(done.overview).toEqual(live.overview);
  });

  it("never changes an overview it returned", () => {
    const b = started();
    b.overview(A);
    const state = accumulateAll(createTraceState(testMeta()), b.rows);
    const first = finalize(state, { live: true });
    const copy = structuredClone(first.overview);
    const cut = b.rows.length;
    b.overview(C);
    accumulateAll(state, b.rows.slice(cut));
    finalize(state, { live: true });
    expect(first.overview).toStrictEqual(copy);
  });
});

function mutate(value: unknown): unknown {
  if (typeof value === "string") return `${value}x`;
  if (typeof value === "number") return value + 1;
  if (typeof value === "boolean") return !value;
  if (value === null) return "x";
  if (Array.isArray(value)) return [...value, "x"];
  throw new Error(`no mutation for ${String(value)}`);
}

describe("sameComponent", () => {
  it("compares every ComponentSchema field", () => {
    expect([...COMPONENT_KEYS].sort()).toEqual(Object.keys(ComponentSchema.shape).sort());
    const base = A.components[0];
    if (base === undefined) throw new Error("fixture has no component");
    expect(sameComponent(base, structuredClone(base))).toBe(true);
    for (const key of COMPONENT_KEYS) {
      const changed = { ...base, [key]: mutate(base[key]) } as Component;
      expect(sameComponent(base, changed), key).toBe(false);
    }
  });
});
