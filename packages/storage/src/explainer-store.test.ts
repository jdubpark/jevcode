import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { OVERVIEW_SNAPSHOT_MAX_BYTES, OverviewSnapshotSchema } from "@jevcode/contracts";
import type { OverviewSnapshot } from "@jevcode/contracts";

import { COMPONENT_ID, SESSION, TS, makeExplainerStory, makeOverviewSnapshot } from "./fixtures.js";
import { openDb } from "./index.js";
import { openSessionDb, openTempDb, tempDbPath } from "./test-utils.js";

const H1 = "1".repeat(40);
const H2 = "2".repeat(40);
const MODEL = "claude-haiku-4-5-20251001";
const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

// K-2 caps a path at 1,024 characters and a component at 400 files, and scanId at 128, so a
// snapshot near 512 KB carries its bulk in the file lists of extra components.
const PATH_MAX = 1024;
const FILES_MAX = 400;

/** A valid snapshot with `chars` copies of `unit` spread over file paths, and `scanExtra` more "x" on scanId. */
function padded(chars: number, unit: string, scanExtra: number): OverviewSnapshot {
  const base = makeOverviewSnapshot();
  const template = base.components[0];
  if (template === undefined) throw new Error("fixture has no component");
  const paths: string[] = [];
  for (let left = chars; left > 0; left -= PATH_MAX) paths.push(unit.repeat(Math.min(PATH_MAX, left)));
  const extra: OverviewSnapshot["components"] = [];
  for (let start = 0; start < paths.length; start += FILES_MAX) {
    const index = start / FILES_MAX + 1;
    extra.push({ ...template, id: `cmp_${index.toString(16).padStart(12, "0")}`, files: paths.slice(start, start + FILES_MAX) });
  }
  return { ...base, scanId: `${base.scanId}${"x".repeat(scanExtra)}`, components: [...base.components, ...extra] };
}

/** The most padding whose ASCII snapshot fits in `target` bytes, and the bytes scanId must add to reach it exactly. */
function paddingForBytes(target: number): { chars: number; gap: number } {
  let low = 0;
  let high = target;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (byteLength(padded(mid, "x", 0)) <= target) low = mid;
    else high = mid - 1;
  }
  return { chars: low, gap: target - byteLength(padded(low, "x", 0)) };
}

describe("overview_snapshot and explainer rows", () => {
  it("appends all four record shapes with gapless seqs and returns the stored payload", () => {
    const db = openSessionDb();
    db.appendAgentEvent(SESSION, { type: "agent_started", sessionId: SESSION, prompt: "go", ts: TS });
    const snapshot = db.appendEvent(SESSION, "overview_snapshot", makeOverviewSnapshot());
    const story = db.appendEvent(SESSION, "explainer", makeExplainerStory());
    const why = db.appendEvent(SESSION, "explainer", {
      sessionId: SESSION,
      kind: "decision_why",
      decisionId: "dec_1",
      sentence: { text: "Chosen to keep reads off the hot path.", citations: [{ kind: "decision", id: "dec_1" }] },
    });
    const highlights = db.appendEvent(SESSION, "explainer", {
      sessionId: SESSION,
      kind: "highlights",
      basisSeq: 3,
      components: [{ id: COMPONENT_ID, state: "changed", unitIds: ["unit_1"] }],
    });
    expect([snapshot, story, why, highlights].map((event) => [event.seq, event.type])).toEqual([
      [2, "overview_snapshot"],
      [3, "explainer"],
      [4, "explainer"],
      [5, "explainer"],
    ]);
    expect(db.getSession(SESSION)?.lastEventSeq).toBe(5);
    expect(JSON.parse(snapshot.payloadJson)).toEqual(makeOverviewSnapshot());
    expect(JSON.parse(story.payloadJson)).toEqual(makeExplainerStory());
    db.close();
  });

  it("rejects invalid payloads, a foreign sessionId and an unknown session without using a seq", () => {
    const db = openSessionDb();
    const component = makeOverviewSnapshot().components[0];
    const cases: Array<[string, "overview_snapshot" | "explainer", unknown]> = [
      [SESSION, "overview_snapshot", { ...makeOverviewSnapshot(), partial: "no" }],
      [SESSION, "overview_snapshot", { ...makeOverviewSnapshot(), components: [{ ...component, role: "external" }] }],
      [SESSION, "overview_snapshot", { ...makeOverviewSnapshot(), narrative: { sentences: [], provenance: "rule" } }],
      [SESSION, "overview_snapshot", makeOverviewSnapshot({ sessionId: "sess_other" })],
      [SESSION, "explainer", { sessionId: SESSION, kind: "story", sentences: [], basisSeq: 1 }],
      [SESSION, "explainer", { sessionId: SESSION, kind: "summary", sentences: [] }],
      [SESSION, "explainer", makeExplainerStory({ sessionId: "sess_other" })],
      ["sess_missing", "explainer", makeExplainerStory({ sessionId: "sess_missing" })],
    ];
    for (const [sessionId, type, payload] of cases) {
      expect(() => db.appendEvent(sessionId, type, payload), `${type} ${JSON.stringify(payload).slice(0, 80)}`).toThrow(TypeError);
    }
    expect(db.getEventCount(SESSION)).toBe(0);
    expect(db.getSession(SESSION)?.lastEventSeq).toBe(0);
    db.close();
  });

  it("enforces the 512 KB snapshot cap at append, counting UTF-8 bytes of the stored JSON", () => {
    const db = openSessionDb();
    const { chars, gap } = paddingForBytes(OVERVIEW_SNAPSHOT_MAX_BYTES);

    const atCap = padded(chars, "x", gap);
    expect(OverviewSnapshotSchema.safeParse(atCap).success).toBe(true);
    expect(byteLength(atCap)).toBe(OVERVIEW_SNAPSHOT_MAX_BYTES);
    expect(db.appendEvent(SESSION, "overview_snapshot", atCap).seq).toBe(1);

    const overByOne = padded(chars, "x", gap + 1);
    expect(byteLength(overByOne)).toBe(OVERVIEW_SNAPSHOT_MAX_BYTES + 1);
    expect(() => db.appendEvent(SESSION, "overview_snapshot", overByOne)).toThrow(/over the 524288-byte cap/);

    // "é" is 2 UTF-8 bytes: this payload has fewer characters than the cap but more bytes.
    const multiByte = padded(chars - 1, "é", 0);
    expect(OverviewSnapshotSchema.safeParse(multiByte).success).toBe(true);
    expect(JSON.stringify(multiByte).length).toBeLessThan(OVERVIEW_SNAPSHOT_MAX_BYTES);
    expect(byteLength(multiByte)).toBeGreaterThan(OVERVIEW_SNAPSHOT_MAX_BYTES);
    expect(() => db.appendEvent(SESSION, "overview_snapshot", multiByte)).toThrow(TypeError);

    expect(db.getSession(SESSION)?.lastEventSeq).toBe(1);
    expect(db.getEventCount(SESSION)).toBe(1);
    db.close();
  });
});

describe("component_text_cache", () => {
  it("round-trips by (repo root, component id, content hash) and misses on any other key", () => {
    const db = openTempDb();
    expect(db.getComponentText("/work/a", COMPONENT_ID, H1)).toBeUndefined();
    const value = { purpose: "Stores sessions and events in SQLite.", role: "storage" as const, model: MODEL };
    db.putComponentText("/work/a", COMPONENT_ID, H1, value);
    expect(db.getComponentText("/work/a", COMPONENT_ID, H1)).toEqual(value);
    expect(db.getComponentText("/work/a", COMPONENT_ID, H2)).toBeUndefined();
    expect(db.getComponentText("/work/b", COMPONENT_ID, H1)).toBeUndefined();
    expect(db.getComponentText("/work/a", "cmp_ffffffffffff", H1)).toBeUndefined();

    // A new content hash adds an entry and keeps the old one; the same key replaces.
    db.putComponentText("/work/a", COMPONENT_ID, H2, { purpose: null, role: "domain", model: MODEL });
    expect(db.getComponentText("/work/a", COMPONENT_ID, H1)).toEqual(value);
    expect(db.getComponentText("/work/a", COMPONENT_ID, H2)).toEqual({ purpose: null, role: "domain", model: MODEL });
    db.putComponentText("/work/a", COMPONENT_ID, H1, { purpose: "Persists the event log.", role: "storage", model: "m2" });
    expect(db.getComponentText("/work/a", COMPONENT_ID, H1)).toEqual({
      purpose: "Persists the event log.",
      role: "storage",
      model: "m2",
    });
    db.close();
  });

  it("refuses values outside the contract and survives a reopen", () => {
    const dbPath = tempDbPath();
    const db = openDb({ dbPath });
    const bad: unknown[] = [
      { purpose: "p".repeat(141), role: "storage", model: MODEL },
      { purpose: "ok", role: "external", model: MODEL },
      { purpose: "ok", role: "storage", model: "" },
    ];
    for (const value of bad) {
      expect(() => db.putComponentText("/w", COMPONENT_ID, H1, value as never), JSON.stringify(value)).toThrow(TypeError);
    }
    expect(db.getComponentText("/w", COMPONENT_ID, H1)).toBeUndefined();
    db.putComponentText("/w", COMPONENT_ID, H1, { purpose: "p".repeat(140), role: "ui", model: MODEL });
    db.close();

    const reopened = openDb({ dbPath });
    expect(reopened.getComponentText("/w", COMPONENT_ID, H1)).toEqual({ purpose: "p".repeat(140), role: "ui", model: MODEL });
    reopened.close();
  });

  it("reads a stored row whose role this build does not know as a miss", () => {
    const dbPath = tempDbPath();
    const db = openDb({ dbPath });
    db.putComponentText("/w", COMPONENT_ID, H1, { purpose: "ok", role: "ui", model: MODEL });
    db.close();
    const raw = new Database(dbPath);
    raw.prepare("UPDATE component_text_cache SET role = 'external'").run();
    raw.close();
    const reopened = openDb({ dbPath });
    expect(reopened.getComponentText("/w", COMPONENT_ID, H1)).toBeUndefined();
    reopened.close();
  });
});

describe("overview_state", () => {
  const narrative: OverviewSnapshot["narrative"] = {
    sentences: [{ text: "Fixture is a one-package workspace.", citations: [{ kind: "component", id: COMPONENT_ID }] }],
    provenance: "model",
  };

  it("round-trips the latest snapshot, narrative and inputs hash per repo root", () => {
    const db = openTempDb();
    expect(db.getOverviewState("/work/fixture")).toBeUndefined();
    db.putOverviewState("/work/fixture", { snapshot: makeOverviewSnapshot(), narrativeInputsHash: "inputs_1", narrative });
    expect(db.getOverviewState("/work/fixture")).toEqual({
      snapshot: makeOverviewSnapshot(),
      narrativeInputsHash: "inputs_1",
      narrative,
    });
    const next = makeOverviewSnapshot({ scanId: "scan_2" });
    db.putOverviewState("/work/fixture", { snapshot: next, narrativeInputsHash: null, narrative: null });
    expect(db.getOverviewState("/work/fixture")).toEqual({ snapshot: next, narrativeInputsHash: null, narrative: null });
    expect(db.getOverviewState("/work/other")).toBeUndefined();
    db.close();
  });

  it("refuses an invalid snapshot, an invalid narrative and a snapshot of another repo root", () => {
    const db = openTempDb();
    expect(() =>
      db.putOverviewState("/work/fixture", {
        snapshot: { ...makeOverviewSnapshot(), scanId: "" },
        narrativeInputsHash: null,
        narrative: null,
      }),
    ).toThrow(TypeError);
    expect(() =>
      db.putOverviewState("/work/fixture", {
        snapshot: makeOverviewSnapshot(),
        narrativeInputsHash: null,
        narrative: { sentences: [{ text: "Uncited.", citations: [] }], provenance: "model" },
      }),
    ).toThrow(TypeError);
    expect(() =>
      db.putOverviewState("/work/elsewhere", { snapshot: makeOverviewSnapshot(), narrativeInputsHash: null, narrative: null }),
    ).toThrow(/repoRoot/);
    expect(db.getOverviewState("/work/fixture")).toBeUndefined();
    expect(db.getOverviewState("/work/elsewhere")).toBeUndefined();
    db.close();
  });

  it("reads corrupt or out-of-contract stored state as a miss", () => {
    const dbPath = tempDbPath();
    const db = openDb({ dbPath });
    db.putOverviewState("/a", { snapshot: makeOverviewSnapshot({ repoRoot: "/a" }), narrativeInputsHash: null, narrative });
    db.putOverviewState("/b", { snapshot: makeOverviewSnapshot({ repoRoot: "/b" }), narrativeInputsHash: null, narrative });
    db.close();
    const raw = new Database(dbPath);
    raw.prepare("UPDATE overview_state SET snapshot_json = '{' WHERE repo_root = '/a'").run();
    raw.prepare(`UPDATE overview_state SET narrative_json = '{"sentences":[],"provenance":"rule"}' WHERE repo_root = '/b'`).run();
    raw.close();
    const reopened = openDb({ dbPath });
    expect(reopened.getOverviewState("/a")).toBeUndefined();
    expect(reopened.getOverviewState("/b")).toBeUndefined();
    reopened.close();
  });
});
