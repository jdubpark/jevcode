import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Decision, ValidationResult } from "@jevcode/contracts";
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
    options: [{ id: "opt_a", label: "Fail open", description: "serve anyway" }],
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

    const answered = decision({ affectedChangeUnits: ["cu_1", "cu_2"], status: "answered" });
    stores.decisions.upsert(answered);
    stores.decisions.upsert(answered);
    expect(rowsOf(db, "decision")).toBe(3);
    expect(stores.decisions.get("dec_1")?.status).toBe("answered");
  });
});
