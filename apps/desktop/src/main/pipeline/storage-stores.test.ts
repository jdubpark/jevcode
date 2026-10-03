import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ChangeUnit, Decision, EvidenceFact, ValidationResult } from "@jevcode/contracts";
import { PipelineCoordinator } from "@jevcode/semantic-core";
import type { FailureRecord, PipelineStores } from "@jevcode/semantic-core";
import { openDb } from "@jevcode/storage";
import type { JevcodeDb } from "@jevcode/storage";
import { afterEach, describe, expect, it } from "vitest";

import { createStorageStores } from "./storage-stores.js";

const SESSION = "sess_stores";
const TS = "2026-10-03T00:00:00.000Z";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function open(): { db: JevcodeDb; stores: PipelineStores } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jevcode-stores-"));
  dirs.push(dir);
  const db = openDb({ dbPath: path.join(dir, "stores.db") });
  db.upsertRepository({ id: "repo_stores", path: "/w", gitRoot: "/w" });
  db.createSession({ id: SESSION, repoId: "repo_stores" });
  return { db, stores: createStorageStores(db, SESSION) };
}

function rowsOf(db: JevcodeDb, type: string): number {
  return db.listEvents(SESSION, { limit: 10_000 }).filter((event) => event.type === type).length;
}

function validation(overrides: Partial<ValidationResult> = {}): ValidationResult {
  return {
    id: "val_1",
    kind: "test",
    command: "pnpm test",
    status: "passed",
    passed: 3,
    failed: 0,
    skipped: 0,
    ts: TS,
    ...overrides,
  };
}

function failure(overrides: Partial<FailureRecord> = {}): FailureRecord {
  return {
    id: "fail_1",
    sessionId: SESSION,
    validationId: "val_1",
    file: "tests/a.test.ts",
    testName: "a works",
    message: "expected 1 to be 2",
    ts: TS,
    ...overrides,
  };
}

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "dec_1",
    sessionId: SESSION,
    title: "Fail open or closed?",
    context: "rate limit",
    severity: "required",
    // Listed out of id order: the decisions projection reads options back by id.
    options: [
      { id: "opt_b", label: "Fail closed", description: "reject" },
      { id: "opt_a", label: "Fail open", description: "serve anyway" },
    ],
    affectedChangeUnits: ["cu_1"],
    evidence: ["fact_1"],
    status: "open",
    ...overrides,
  };
}

// The coordinator re-upserts every validation, failure and decision on every rebuild.
// Each store write appends an event row, so an unchanged payload must not be written again.
describe("storage stores: unchanged re-upserts append no rows", () => {
  it("writes a validation only when its payload changes", () => {
    const { db, stores } = open();
    stores.validations.upsertValidation(validation());
    stores.validations.upsertValidation(validation());
    expect(rowsOf(db, "validation")).toBe(1);

    stores.validations.upsertValidation(validation({ id: "val_2" }));
    expect(rowsOf(db, "validation")).toBe(2);

    stores.validations.upsertValidation(validation({ status: "failed", passed: 2, failed: 1 }));
    stores.validations.upsertValidation(validation({ status: "failed", passed: 2, failed: 1 }));
    expect(rowsOf(db, "validation")).toBe(3);
    expect(stores.validations.validations().find((row) => row.id === "val_1")?.status).toBe("failed");
  });

  it("writes a failure only when its payload changes", () => {
    const { db, stores } = open();
    stores.validations.upsertFailure(failure());
    stores.validations.upsertFailure(failure());
    expect(rowsOf(db, "failure")).toBe(1);

    stores.validations.upsertFailure(failure({ id: "fail_2", testName: "b works" }));
    expect(rowsOf(db, "failure")).toBe(2);

    stores.validations.upsertFailure(failure({ message: "expected 1 to be 3" }));
    stores.validations.upsertFailure(failure({ message: "expected 1 to be 3" }));
    expect(rowsOf(db, "failure")).toBe(3);
  });

  it("writes a decision only when its payload changes, so an answer still lands", () => {
    const { db, stores } = open();
    stores.decisions.upsert(decision());
    stores.decisions.upsert(decision());
    expect(rowsOf(db, "decision")).toBe(1);

    stores.decisions.upsert(decision({ affectedChangeUnits: ["cu_1", "cu_2"] }));
    expect(rowsOf(db, "decision")).toBe(2);

    // An answer carries ts, which the decisions projection does not keep.
    const answered = decision({
      affectedChangeUnits: ["cu_1", "cu_2"],
      status: "answered",
      answer: { decisionId: "dec_1", decision: { choice: "opt_a" }, evidence: ["fact_1"] },
      ts: "2026-10-03T00:01:00.000Z",
    });
    stores.decisions.upsert(answered);
    stores.decisions.upsert(answered);
    expect(rowsOf(db, "decision")).toBe(3);
    expect(stores.decisions.get("dec_1")?.status).toBe("answered");
  });

  // The runtime writes each incoming decision record straight to the database
  // (pipeline-runtime.ts), then the rebuild upserts the linked version through the store.
  it("rewrites the linked decision after a raw write of the same record replaced it", () => {
    const { db, stores } = open();
    const raw = decision({ affectedChangeUnits: ["cu_raw"] });
    const linked = decision({ affectedChangeUnits: [] });
    for (let arrival = 0; arrival < 2; arrival += 1) {
      db.upsertDecision(raw);
      stores.decisions.upsert(linked);
    }
    const rows = db.listEvents(SESSION, { limit: 10_000 }).filter((event) => event.type === "decision");
    expect(rows).toHaveLength(4);
    expect((JSON.parse(rows.at(-1)?.payloadJson ?? "{}") as Decision).affectedChangeUnits).toEqual([]);
    expect(db.getDecision("dec_1")?.affectedChangeUnits).toEqual([]);
  });
});

// PL-1: an agent that keeps working never leaves its idle bucket. Each step edits one file
// and runs the tests; the trace must grow by a bounded number of rows per step, not by one
// row per earlier run or unit.
describe("storage stores under the coordinator: one long bucket", () => {
  const SHAPES = [
    { name: "one repeated passing command", command: () => "pnpm test", fails: () => false },
    { name: "a per-file passing command", command: (step: number) => `pnpm test -- module-${step}`, fails: () => false },
    { name: "every second run failing", command: () => "pnpm test", fails: (step: number) => step % 2 === 1 },
  ];

  it.each(SHAPES)("writes each run once and a bounded number of change-unit rows per step: $name", (shape) => {
    const { db, stores } = open();
    let now = Date.parse(TS);
    const coordinator = new PipelineCoordinator({ stores, clock: () => now });
    const ingest = (fact: EvidenceFact): void => {
      now = Date.parse(fact.ts);
      coordinator.ingest(fact);
    };
    const iso = (ms: number): string => new Date(ms).toISOString();
    const base = Date.parse(TS);
    const steps = 40;
    for (let step = 0; step < steps; step += 1) {
      const t = base + step * 900;
      const common = { repoId: "repo_stores", sessionId: SESSION } as const;
      ingest({
        ...common,
        type: "git_hunk",
        ts: iso(t),
        file: `src/module-${step}.ts`,
        added: 4,
        removed: 1,
        isFormattingOnly: false,
        isConfigOnly: false,
        isLockfile: false,
      });
      const failed = shape.fails(step);
      ingest({
        ...common,
        type: "test_result",
        ts: iso(t + 450),
        runner: "vitest",
        command: shape.command(step),
        passed: 3,
        failed: failed ? 1 : 0,
        skipped: 0,
        failures: failed
          ? [{ file: `src/module-${step}.test.ts`, testName: `module ${step} works`, message: "boom" }]
          : [],
      });
    }
    now += 10_000;
    coordinator.flush();

    expect(rowsOf(db, "validation")).toBe(steps);
    // A step changes the edited file's unit and gives it the new run; a failing run also
    // adds a unit for its failing test file, and the next pass reaches the unit it failed.
    // Attaching runs bucket-wide rewrote every unit on every rebuild (steps * (steps + 1) / 2).
    expect(rowsOf(db, "change_unit")).toBeLessThanOrEqual(3 * steps);
  });
});

// PL-2: every rebuild, the coordinator removes each stored unit that its projection no longer has,
// and a removed unit stays stored as superseded, so later rebuilds remove it again. The store wrote
// it on every remove, past the dedupe: one identical change_unit row per later rebuild (80-82 per
// evidence smoke run).
describe("storage stores: a change unit that leaves the projection", () => {
  const hunk = (file: string, ms: number): EvidenceFact => ({
    type: "git_hunk",
    repoId: "repo_stores",
    sessionId: SESSION,
    ts: new Date(ms).toISOString(),
    file,
    added: 4,
    removed: 1,
    isFormattingOnly: false,
    isConfigOnly: false,
    isLockfile: false,
  });

  function changeUnitRows(db: JevcodeDb): { id: string; status: string; payloadJson: string }[] {
    return db
      .listEvents(SESSION, { limit: 10_000 })
      .filter((event) => event.type === "change_unit")
      .map((event) => {
        const unit = JSON.parse(event.payloadJson) as ChangeUnit;
        return { id: unit.id, status: unit.status, payloadJson: event.payloadJson };
      });
  }

  it("is written superseded once while its payload is unchanged, however many rebuilds follow", () => {
    const { db, stores } = open();
    const base = Date.parse(TS);
    let now = base;
    const coordinator = new PipelineCoordinator({ stores, clock: () => now });
    const ingest = (fact: EvidenceFact): void => {
      now += 5_000;
      coordinator.ingest(fact);
      coordinator.flush();
    };
    // Hunks more than the 2 min idle gap apart fall in separate buckets, and a unit's id names its
    // bucket. A late hunk that sorts between two buckets shifts the later bucket's index, so that
    // bucket's unit leaves the projection under its old id.
    ingest(hunk("src/a.ts", base));
    ingest(hunk("src/b.ts", base + 10 * 60_000));
    const before = new Set(stores.units.all().map((unit) => unit.id));
    ingest(hunk("src/c.ts", base + 5 * 60_000));
    for (let step = 0; step < 5; step += 1) ingest(hunk(`src/d${step}.ts`, base + 11 * 60_000 + step * 1_000));

    const rows = changeUnitRows(db);
    const left = [...before].filter((id) => stores.units.get(id)?.status === "superseded");
    expect(left).toHaveLength(1);
    expect(rows.filter((row) => row.id === left[0]).map((row) => row.status)).toEqual(["detected", "superseded"]);
    // No unit is ever written twice in a row with the same payload.
    const last = new Map<string, string>();
    for (const row of rows) {
      expect(last.get(row.id)).not.toBe(row.payloadJson);
      last.set(row.id, row.payloadJson);
    }
  });

  it("is written again when the projection brings it back with its earlier payload", () => {
    const { db, stores } = open();
    const unit: ChangeUnit = {
      id: "cu_back",
      sessionId: SESSION,
      title: "Changed 1 file: src/a.ts",
      category: "implementation",
      status: "detected",
      files: ["src/a.ts"],
      symbols: [],
      interfacesChanged: [],
      schemaChanges: [],
      dependencyChanges: [],
      relatedDecisions: [],
      validationResults: [],
      evidence: ["fact_1"],
      createdAt: TS,
      updatedAt: TS,
    };
    stores.units.upsert(unit);
    stores.units.remove(unit.id);
    stores.units.remove(unit.id);
    stores.units.upsert(unit);

    expect(changeUnitRows(db).map((row) => row.status)).toEqual(["detected", "superseded", "detected"]);
    expect(stores.units.get(unit.id)?.status).toBe("detected");
  });
});

// PL-2 (D-6 review I-1): a store remembers a payload only once its row is written, so a write
// that throws is tried again by the next rebuild instead of being skipped as already written.
describe("storage stores: a write that throws", () => {
  const unit: ChangeUnit = {
    id: "cu_retry",
    sessionId: SESSION,
    title: "Changed 1 file: src/a.ts",
    category: "implementation",
    status: "detected",
    files: ["src/a.ts"],
    symbols: [],
    interfacesChanged: [],
    schemaChanges: [],
    dependencyChanges: [],
    relatedDecisions: [],
    validationResults: [],
    evidence: ["fact_1"],
    createdAt: TS,
    updatedAt: TS,
  };
  const cases = [
    {
      name: "change unit",
      type: "change_unit",
      method: "upsertChangeUnit",
      write: (stores: PipelineStores) => stores.units.upsert(unit),
    },
    {
      name: "validation",
      type: "validation",
      method: "upsertValidation",
      write: (stores: PipelineStores) => stores.validations.upsertValidation(validation()),
    },
    {
      name: "graph node",
      type: "graph_node",
      method: "upsertGraphNode",
      write: (stores: PipelineStores) =>
        stores.graph.upsertNodes([{ id: "node_1", sessionId: SESSION, type: "File", label: "src/a.ts" }]),
    },
  ] as const;

  it.each(cases)("is written by the next upsert of the same payload: $name", ({ type, method, write }) => {
    const { db, stores } = open();
    const original = db[method].bind(db) as (...args: unknown[]) => unknown;
    let calls = 0;
    (db as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      calls += 1;
      if (calls === 1) throw new Error("disk full");
      return original(...args);
    };
    expect(() => write(stores)).toThrow("disk full");
    expect(rowsOf(db, type)).toBe(0);

    write(stores);
    expect(rowsOf(db, type)).toBe(1);
    write(stores);
    expect(rowsOf(db, type)).toBe(1);
  });
});

// PL-2 fix round 1. A label write rebuilds its unit from the database row, whose key order differs from the
// projection's; the same payload must not be written again for that. A semantic event whose write threw is retried
// by the next rebuild and must then be listed once.
describe("storage stores: payloads that are already written", () => {
  it("does not write a change unit again when only its key order differs", () => {
    const { db, stores } = open();
    const unit: ChangeUnit = {
      id: "cu_order",
      sessionId: SESSION,
      title: "Changed 1 file: src/a.ts",
      category: "implementation",
      status: "validated",
      files: ["src/a.ts"],
      symbols: [],
      interfacesChanged: [],
      schemaChanges: [],
      dependencyChanges: [],
      relatedDecisions: [],
      validationResults: ["val_1"],
      evidence: ["fact_1"],
      createdAt: TS,
      updatedAt: TS,
      importance: 0.2,
    };
    stores.units.upsert(unit);
    const { importance, ...rest } = unit;
    stores.units.upsert({ importance, ...rest });
    expect(rowsOf(db, "change_unit")).toBe(1);

    stores.units.upsert({ ...unit, importance: 0.3 });
    expect(rowsOf(db, "change_unit")).toBe(2);
  });

  it("lists a semantic event once after its write threw and the next rebuild wrote it", () => {
    const { db } = open();
    const stores = createStorageStores(db, SESSION, { persistSemanticEvents: true });
    const event = {
      id: "sev_1",
      sessionId: SESSION,
      kind: "behavior_change" as const,
      summary: "Changed src/a.ts",
      changeUnitId: "cu_1",
      evidence: [],
      files: ["src/a.ts"],
      symbols: [],
      createdAt: TS,
    };
    const appendSemanticEvent = db.appendSemanticEvent.bind(db);
    let calls = 0;
    db.appendSemanticEvent = ((sessionId, value) => {
      calls += 1;
      if (calls === 1) throw new Error("disk full");
      return appendSemanticEvent(sessionId, value);
    }) as typeof db.appendSemanticEvent;

    expect(() => stores.events.emit(event)).toThrow("disk full");
    stores.events.emit(event);
    stores.events.emit(event);
    expect(rowsOf(db, "semantic_event")).toBe(1);
    expect(stores.events.all().map((listed) => listed.id)).toEqual(["sev_1"]);
  });

  it("writes and lists a semantic event once when its listener throws after the write (fix wave minor 5)", () => {
    const { db } = open();
    let notified = 0;
    const stores = createStorageStores(db, SESSION, {
      persistSemanticEvents: true,
      onSemanticEvent: () => {
        notified += 1;
        if (notified === 1) throw new Error("listener failed");
      },
    });
    const event = {
      id: "sev_2",
      sessionId: SESSION,
      kind: "behavior_change" as const,
      summary: "Changed src/b.ts",
      changeUnitId: "cu_2",
      evidence: [],
      files: ["src/b.ts"],
      symbols: [],
      createdAt: TS,
    };

    expect(() => stores.events.emit(event)).toThrow("listener failed");
    // The coordinator's next rebuilds emit the same event again.
    stores.events.emit(event);
    stores.events.emit(event);
    expect(rowsOf(db, "semantic_event")).toBe(1);
    expect(stores.events.all().map((listed) => listed.id)).toEqual(["sev_2"]);
    expect(notified).toBe(1);
  });
});
