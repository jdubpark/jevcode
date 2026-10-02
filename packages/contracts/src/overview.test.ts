import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  CitationSchema,
  ComponentEdgeSchema,
  ComponentSchema,
  ExplainerRecordSchema,
  ExternalDepSchema,
  NARRATOR_STATES,
  NarrativeSentenceSchema,
  OVERVIEW_SCAN_STATES,
  OVERVIEW_SNAPSHOT_MAX_BYTES,
  OverviewSnapshotSchema,
  OverviewStatusSchema,
  ROLES,
  RoleSchema,
} from "./overview.js";
import type { Component, ComponentEdge, ExternalDep, NarratorState, OverviewSnapshot, OverviewStatus } from "./overview.js";

const HASH = "0123456789abcdef0123456789abcdef01234567";

const cmpId = (i: number): string => `cmp_${i.toString(16).padStart(12, "0")}`;

function component(i: number, overrides: Partial<Component> = {}): Component {
  return {
    id: cmpId(i),
    rootPath: `packages/p${i}`,
    name: `@acme/p${i}`,
    fileCount: 3,
    files: [`packages/p${i}/src/a.ts`, `packages/p${i}/src/b.ts`, `packages/p${i}/src/index.ts`],
    language: "TypeScript",
    roleGuess: "domain",
    role: "domain",
    purpose: null,
    provenance: "rule",
    contentHash: HASH,
    externalDeps: [{ name: "zod", count: 2 }],
    entryPoints: [`packages/p${i}/src/index.ts`],
    importsAnalyzed: true,
    ...overrides,
  };
}

function edge(i: number): ComponentEdge {
  return { from: cmpId(i), to: cmpId(i + 1), count: 1 + (i % 5), examples: [`packages/p${i}/src/a.ts → packages/p${i + 1}/src/b.ts`] };
}

function external(i: number): ExternalDep {
  return { name: `dep-${i}`, usedBy: [{ componentId: cmpId(i), count: 1 }] };
}

function snapshot(overrides: Partial<OverviewSnapshot> = {}): OverviewSnapshot {
  return {
    sessionId: "sess_1",
    repoRoot: "/work/acme",
    scanId: "scan_1",
    partial: false,
    counts: { files: 6, components: 2, edges: 1, languages: ["TypeScript"] },
    components: [component(1), component(2, { roleGuess: "storage", role: "storage" })],
    edges: [edge(1)],
    externals: [external(1)],
    narrative: null,
    generatedAt: "2026-10-02T10:00:00.000Z",
    ...overrides,
  };
}

const sentence = (text: string) => ({ text, citations: [{ kind: "component" as const, id: cmpId(1) }] });

describe("roles and limits", () => {
  it("pins the closed role list; external is a dependency chip, not a role", () => {
    expect(ROLES).toEqual(["ui", "api", "agent", "domain", "storage", "tests", "tooling", "config"]);
    for (const role of ROLES) expect(RoleSchema.safeParse(role).success).toBe(true);
    for (const role of ["external", "UI", "frontend", ""]) expect(RoleSchema.safeParse(role).success).toBe(false);
  });

  it("pins the snapshot byte cap at 512 KB", () => {
    expect(OVERVIEW_SNAPSHOT_MAX_BYTES).toBe(524_288);
  });
});

describe("CitationSchema and NarrativeSentenceSchema", () => {
  it("accepts the five citation kinds and nothing else", () => {
    for (const kind of ["component", "file", "decision", "fact", "step"]) {
      expect(CitationSchema.safeParse({ kind, id: "x" }).success, kind).toBe(true);
    }
    expect(CitationSchema.safeParse({ kind: "url", id: "https://example.com" }).success).toBe(false);
    expect(CitationSchema.safeParse({ kind: "file", id: "" }).success).toBe(false);
    expect(CitationSchema.safeParse({ kind: "file", id: "f".repeat(513) }).success).toBe(false);
    expect(CitationSchema.safeParse({ kind: "file", id: "f".repeat(512) }).success).toBe(true);
  });

  it("accepts a sentence iff its text has 1 to 220 characters and it has 1 to 6 citations (property)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 260 }), fc.integer({ min: 0, max: 8 }), (text, n) => {
        const value = { text, citations: Array.from({ length: n }, (_, i) => ({ kind: "file", id: `src/f${i}.ts` })) };
        const expected = text.length >= 1 && text.length <= 220 && n >= 1 && n <= 6;
        expect(NarrativeSentenceSchema.safeParse(value).success).toBe(expected);
      }),
      { numRuns: 200, examples: [["x".repeat(220), 6], ["x".repeat(221), 1], ["", 1], ["x", 0], ["x", 7]] },
    );
  });
});

describe("ComponentSchema", () => {
  it("accepts the boundary values", () => {
    const value = component(1, {
      rootPath: ".",
      purpose: "p".repeat(140),
      language: null,
      files: Array.from({ length: 400 }, (_, i) => `src/f${i}.ts`),
      externalDeps: Array.from({ length: 8 }, (_, i) => ({ name: `d${i}`, count: 1 })),
      entryPoints: Array.from({ length: 8 }, (_, i) => `src/e${i}.ts`),
      fileCount: 0,
      provenance: "model",
    });
    expect(ComponentSchema.parse(value)).toEqual(value);
  });

  it.each<[string, Record<string, unknown>]>([
    ["an id with uppercase hex", { id: "cmp_ABCDEF012345" }],
    ["an id with 11 hex digits", { id: "cmp_0123456789a" }],
    ["an id without the cmp_ prefix", { id: "0123456789ab" }],
    ["a content hash of 39 hex digits", { contentHash: HASH.slice(1) }],
    ["a purpose over 140 characters", { purpose: "p".repeat(141) }],
    ["more than 400 listed files", { files: Array.from({ length: 401 }, (_, i) => `f${i}.ts`) }],
    ["more than 8 external deps", { externalDeps: Array.from({ length: 9 }, (_, i) => ({ name: `d${i}`, count: 1 })) }],
    ["an external dep count of 0", { externalDeps: [{ name: "zod", count: 0 }] }],
    ["more than 8 entry points", { entryPoints: Array.from({ length: 9 }, (_, i) => `e${i}.ts`) }],
    ["a role outside the closed list", { role: "external" }],
    ["a role guess outside the closed list", { roleGuess: "frontend" }],
    ["an empty name", { name: "" }],
    ["a name over 120 characters", { name: "n".repeat(121) }],
    ["a language over 40 characters", { language: "l".repeat(41) }],
    ["a person provenance", { provenance: "person" }],
    ["a negative file count", { fileCount: -1 }],
    ["an empty root path", { rootPath: "" }],
    ["a missing importsAnalyzed flag", { importsAnalyzed: undefined }],
  ])("rejects a component with %s", (_label, override) => {
    expect(ComponentSchema.safeParse({ ...component(1), ...override }).success).toBe(false);
  });

  it("keeps bidi controls in text as data; renderers apply displayUntrusted", () => {
    const value = component(1, { name: "pkg‮gnp.exe", purpose: "Stores ‮sessions" });
    expect(ComponentSchema.parse(value)).toEqual(value);
  });
});

describe("ComponentEdgeSchema and ExternalDepSchema", () => {
  it("accepts an edge with up to 3 examples of up to 300 characters", () => {
    const value = { ...edge(1), examples: ["a".repeat(300), "b", "c"] };
    expect(ComponentEdgeSchema.parse(value)).toEqual(value);
  });

  it("rejects a zero count, a fourth example and an example over 300 characters", () => {
    expect(ComponentEdgeSchema.safeParse({ ...edge(1), count: 0 }).success).toBe(false);
    expect(ComponentEdgeSchema.safeParse({ ...edge(1), examples: ["a", "b", "c", "d"] }).success).toBe(false);
    expect(ComponentEdgeSchema.safeParse({ ...edge(1), examples: ["a".repeat(301)] }).success).toBe(false);
  });

  it("bounds externals by name length and users", () => {
    expect(ExternalDepSchema.safeParse({ ...external(1), name: "n".repeat(214) }).success).toBe(true);
    expect(ExternalDepSchema.safeParse({ ...external(1), name: "n".repeat(215) }).success).toBe(false);
    expect(ExternalDepSchema.safeParse({ ...external(1), name: "" }).success).toBe(false);
    const users = (n: number) => Array.from({ length: n }, (_, i) => ({ componentId: cmpId(i), count: 1 }));
    expect(ExternalDepSchema.safeParse({ name: "zod", usedBy: users(40) }).success).toBe(true);
    expect(ExternalDepSchema.safeParse({ name: "zod", usedBy: users(41) }).success).toBe(false);
    expect(ExternalDepSchema.safeParse({ name: "zod", usedBy: [{ componentId: cmpId(1), count: 0 }] }).success).toBe(false);
  });
});

describe("OverviewSnapshotSchema", () => {
  it("parses a snapshot and keeps it equal through a JSON round trip", () => {
    const value = snapshot();
    expect(OverviewSnapshotSchema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
  });

  it("accepts a model narrative of up to 8 sentences and rejects other provenances", () => {
    const narrative = { sentences: Array.from({ length: 8 }, (_, i) => sentence(`Sentence ${i}.`)), provenance: "model" as const };
    expect(OverviewSnapshotSchema.parse(snapshot({ narrative })).narrative).toEqual(narrative);
    expect(OverviewSnapshotSchema.safeParse(snapshot({ narrative: { ...narrative, sentences: [...narrative.sentences, sentence("Nine.")] } })).success).toBe(false);
    expect(OverviewSnapshotSchema.safeParse({ ...snapshot(), narrative: { sentences: [], provenance: "rule" } }).success).toBe(false);
  });

  it.each<[string, Record<string, unknown>]>([
    ["a missing sessionId", { sessionId: undefined }],
    ["an empty repoRoot", { repoRoot: "" }],
    ["an empty scanId", { scanId: "" }],
    ["a non-boolean partial flag", { partial: "yes" }],
    ["21 languages", { counts: { files: 1, components: 1, edges: 0, languages: Array.from({ length: 21 }, (_, i) => `L${i}`) } }],
    ["a negative file count", { counts: { files: -1, components: 1, edges: 0, languages: [] } }],
  ])("rejects a snapshot with %s", (_label, override) => {
    expect(OverviewSnapshotSchema.safeParse({ ...snapshot(), ...override }).success).toBe(false);
  });

  it("accepts counts.totalFiles as optional and rejects a negative or fractional value", () => {
    const counts = { files: 20_000, components: 2, edges: 1, languages: ["TypeScript"] };
    expect(OverviewSnapshotSchema.parse(snapshot({ partial: true, counts: { ...counts, totalFiles: 25_000 } })).counts.totalFiles).toBe(25_000);
    expect(OverviewSnapshotSchema.parse(snapshot({ counts })).counts.totalFiles).toBeUndefined();
    expect(OverviewSnapshotSchema.safeParse({ ...snapshot(), counts: { ...counts, totalFiles: -1 } }).success).toBe(false);
    expect(OverviewSnapshotSchema.safeParse({ ...snapshot(), counts: { ...counts, totalFiles: 1.5 } }).success).toBe(false);
  });

  it("accepts a snapshot iff it holds at most 200 components, 1,000 edges and 120 externals (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 230 }),
        fc.integer({ min: 0, max: 1_030 }),
        fc.integer({ min: 0, max: 140 }),
        (components, edges, externals) => {
          const value = snapshot({
            components: Array.from({ length: components }, (_, i) => component(i)),
            edges: Array.from({ length: edges }, (_, i) => edge(i)),
            externals: Array.from({ length: externals }, (_, i) => external(i)),
          });
          const expected = components <= 200 && edges <= 1_000 && externals <= 120;
          expect(OverviewSnapshotSchema.safeParse(value).success).toBe(expected);
        },
      ),
      { numRuns: 60, examples: [[200, 1_000, 120], [201, 0, 0], [0, 1_001, 0], [0, 0, 121]] },
    );
  });
});

describe("OverviewStatusSchema (ruling R3)", () => {
  const status = (overrides: Partial<OverviewStatus> = {}): OverviewStatus => ({
    scan: { state: "done", scanned: 9_800, total: 9_800 },
    narrator: "pending",
    ...overrides,
  });

  it("pins the scan and narrator state lists", () => {
    expect(OVERVIEW_SCAN_STATES).toEqual(["running", "done", "failed"]);
    expect(NARRATOR_STATES).toEqual(["off", "unavailable", "pending", "ready"]);
    const states: NarratorState[] = [...NARRATOR_STATES];
    expect(states).toHaveLength(4);
  });

  it("parses a snapshot with and without status; a pre-status row keeps no status", () => {
    const withStatus = snapshot({ status: status({ scan: { state: "running", scanned: 3_200, total: 9_800 }, narrator: "off" }) });
    expect(OverviewSnapshotSchema.parse(withStatus)).toEqual(withStatus);
    const without = snapshot();
    expect("status" in without).toBe(false);
    expect(OverviewSnapshotSchema.parse(without).status).toBeUndefined();
    for (const narrator of NARRATOR_STATES) {
      expect(OverviewStatusSchema.safeParse(status({ narrator })).success, narrator).toBe(true);
    }
    for (const state of OVERVIEW_SCAN_STATES) {
      expect(OverviewStatusSchema.safeParse(status({ scan: { state, scanned: 0, total: 0 } })).success, state).toBe(true);
    }
  });

  it("accepts a failed scan with a short error and rejects an error longer than 200 characters", () => {
    const failed = status({ scan: { state: "failed", scanned: 10, total: 9_800, error: "e".repeat(200) } });
    expect(OverviewStatusSchema.parse(failed)).toEqual(failed);
    expect(OverviewStatusSchema.safeParse(status({ scan: { state: "failed", scanned: 10, total: 9_800, error: "e".repeat(201) } })).success).toBe(false);
    expect(OverviewSnapshotSchema.safeParse({ ...snapshot(), status: { scan: { state: "failed", scanned: 0, total: 0, error: "e".repeat(201) }, narrator: "off" } }).success).toBe(false);
  });

  it.each<[string, unknown]>([
    ["an unknown narrator state", { scan: { state: "done", scanned: 1, total: 1 }, narrator: "error" }],
    ["an unknown scan state", { scan: { state: "queued", scanned: 0, total: 1 }, narrator: "off" }],
    ["a negative scanned count", { scan: { state: "running", scanned: -1, total: 1 }, narrator: "off" }],
    ["a fractional total", { scan: { state: "running", scanned: 0, total: 1.5 }, narrator: "off" }],
    ["an extra key on status", { scan: { state: "done", scanned: 1, total: 1 }, narrator: "ready", message: "hi" }],
    ["an extra key on scan", { scan: { state: "done", scanned: 1, total: 1, detail: "stack trace" }, narrator: "ready" }],
    ["a missing narrator", { scan: { state: "done", scanned: 1, total: 1 } }],
  ])("rejects a status with %s", (_label, value) => {
    expect(OverviewStatusSchema.safeParse(value).success).toBe(false);
    expect(OverviewSnapshotSchema.safeParse({ ...snapshot(), status: value }).success).toBe(false);
  });
});

describe("ExplainerRecordSchema", () => {
  const s = sentence("The agent added an OAuth callback route.");

  it("parses the three record kinds", () => {
    const records = [
      { sessionId: "sess_1", kind: "story", sentences: [s], basisSeq: 40 },
      { sessionId: "sess_1", kind: "story", sentences: [s], basisSeq: 41, provenance: "rule" },
      { sessionId: "sess_1", kind: "decision_why", decisionId: "dec_1", sentence: s },
      {
        sessionId: "sess_1",
        kind: "highlights",
        basisSeq: 41,
        components: [
          { id: cmpId(1), state: "new", unitIds: [] },
          { id: cmpId(2), state: "changed", unitIds: ["unit_1"] },
          { id: cmpId(3), state: "decision", unitIds: [] },
          { id: cmpId(4), state: "failing", unitIds: ["unit_2"] },
        ],
      },
    ];
    for (const record of records) expect(ExplainerRecordSchema.parse(record)).toEqual(record);
  });

  it.each<[string, Record<string, unknown>]>([
    ["a story with no sentences", { sessionId: "sess_1", kind: "story", sentences: [], basisSeq: 1 }],
    ["a story with 7 sentences", { sessionId: "sess_1", kind: "story", sentences: Array.from({ length: 7 }, () => s), basisSeq: 1 }],
    ["a negative basisSeq", { sessionId: "sess_1", kind: "story", sentences: [s], basisSeq: -1 }],
    ["a story with an unknown provenance", { sessionId: "sess_1", kind: "story", sentences: [s], basisSeq: 1, provenance: "guess" }],
    ["a decision_why with an empty decisionId", { sessionId: "sess_1", kind: "decision_why", decisionId: "", sentence: s }],
    ["a decision_why with an uncited sentence", { sessionId: "sess_1", kind: "decision_why", decisionId: "dec_1", sentence: { text: "Why.", citations: [] } }],
    ["an unknown highlight state", { sessionId: "sess_1", kind: "highlights", basisSeq: 1, components: [{ id: cmpId(1), state: "removed", unitIds: [] }] }],
    ["a highlight with 51 unit ids", { sessionId: "sess_1", kind: "highlights", basisSeq: 1, components: [{ id: cmpId(1), state: "changed", unitIds: Array.from({ length: 51 }, (_, i) => `u${i}`) }] }],
    ["highlights for 201 components", { sessionId: "sess_1", kind: "highlights", basisSeq: 1, components: Array.from({ length: 201 }, (_, i) => ({ id: cmpId(i), state: "changed", unitIds: [] })) }],
    ["an unknown kind", { sessionId: "sess_1", kind: "summary", sentences: [s] }],
    ["no sessionId", { kind: "story", sentences: [s], basisSeq: 1 }],
  ])("rejects %s", (_label, record) => {
    expect(ExplainerRecordSchema.safeParse(record).success).toBe(false);
  });
});

describe("per-string caps and component-id pattern", () => {
  const rootPathOf = (n: number) => ComponentSchema.safeParse(component(1, { rootPath: "r".repeat(n) })).success;
  const scanIdOf = (n: number) => OverviewSnapshotSchema.safeParse({ ...snapshot(), scanId: "s".repeat(n) }).success;
  const langsOf = (n: number) =>
    OverviewSnapshotSchema.safeParse({ ...snapshot(), counts: { files: 1, components: 1, edges: 0, languages: ["l".repeat(n)] } }).success;

  it("bounds a path field at 1,024 characters", () => {
    expect(rootPathOf(1_024)).toBe(true);
    expect(rootPathOf(1_025)).toBe(false);
  });

  it("bounds an id field at 128 characters", () => {
    expect(scanIdOf(128)).toBe(true);
    expect(scanIdOf(129)).toBe(false);
  });

  it("bounds a language name at 40 characters", () => {
    expect(langsOf(40)).toBe(true);
    expect(langsOf(41)).toBe(false);
  });

  it("requires component-id format on edge endpoints", () => {
    expect(ComponentEdgeSchema.safeParse(edge(1)).success).toBe(true);
    expect(ComponentEdgeSchema.safeParse({ ...edge(1), from: "cmp_ABCDEF012345" }).success).toBe(false);
    expect(ComponentEdgeSchema.safeParse({ ...edge(1), to: "not-a-component" }).success).toBe(false);
  });
});
