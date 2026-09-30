import { describe, expect, it } from "vitest";

import { foldRows } from "../model/fold.js";
import type { TraceSession } from "../model/index.js";
import { loadFixtureTrace } from "../test-support/fixture-rows.js";
import { buildSession, OAUTH_CLAIM_TEXT, oauthLikeSession, type StepSeed } from "../test-support/session-builder.js";
import { buildSpineRows, estimateSpineRowSize, spineRowIndexForSeq, type SpineRow, type SpineRowsInput } from "./spine-rows.js";
import { buildTimeScale, timeScaleInputOf } from "./time-scale.js";
import { stepTone } from "./tone.js";
import { buildTraceIndex } from "./trace-index.js";

const none = new Set<string>();
function rowsOf(session: TraceSession, input: Partial<SpineRowsInput> = {}): SpineRow[] {
  const index = buildTraceIndex(session);
  const scale = buildTimeScale(timeScaleInputOf(session));
  return buildSpineRows(session, index, scale, {
    brush: { kind: "session" }, level: "chapter", playheadSeq: 1, selection: null,
    expanded: none, collapsed: none, live: false, ...input,
  });
}

function commands(count: number, patch: (i: number) => Partial<StepSeed> = () => ({})): StepSeed[] {
  return [
    { kind: "instruction", tMs: 0, text: "go" },
    ...Array.from({ length: count }, (_, j): StepSeed => ({ kind: "command", tMs: (j + 1) * 1_000, durationMs: 500, target: `step ${j + 1}`, ...patch(j + 1) })),
  ];
}

describe("spine rows on the oauth-like session", () => {
  const oauth = oauthLikeSession();
  const claim = oauth.steps.find((s) => s.text === OAUTH_CLAIM_TEXT);

  it("shows one test row (14/1/0) and the claim expanded at +0:43", () => {
    const rows = rowsOf(oauth, { playheadSeq: claim?.firstSeq ?? 1, selection: claim?.id ?? null });
    const stepRows = rows.filter((r): r is Extract<SpineRow, { t: "step" }> => r.t === "step");
    const tests = stepRows.filter((r) => oauth.steps[r.step]?.kind === "test");
    expect(tests).toHaveLength(1);
    expect(oauth.steps[tests[0]?.step ?? -1]?.tests).toMatchObject({ passed: 14, failed: 1, skipped: 0 });
    const claimRow = stepRows.find((r) => r.key === claim?.id);
    expect(claimRow?.expanded).toBe(true);
    expect(oauth.steps[claimRow?.step ?? -1]?.tMs).toBe(43_000);
  });

  it("folds consecutive noise into labelled rows, across chapters", () => {
    const labels = rowsOf(oauth).filter((r): r is Extract<SpineRow, { t: "noise" }> => r.t === "noise").map((r) => r.label);
    expect(labels.slice(0, 2)).toEqual(["3 reads", "2 lockfile and formatting edits"]);
  });

  it("labels Jev pipeline noise as pipeline events, apart from agent lifecycle events", () => {
    const session = buildSession({
      steps: [
        { kind: "instruction", tMs: 0, text: "go" },
        { kind: "attention", tMs: 1_000, noise: "pipeline" },
        { kind: "guardrail", tMs: 1_000, noise: "pipeline" },
        { kind: "attention", tMs: 1_000, noise: "pipeline" },
        { kind: "command", tMs: 2_000, target: "ls" },
        { kind: "attention", tMs: 3_000, noise: "pipeline" },
        { kind: "lifecycle", tMs: 3_000, noise: "lifecycle" },
      ],
    });
    const labels = rowsOf(session).filter((r): r is Extract<SpineRow, { t: "noise" }> => r.t === "noise").map((r) => r.label);
    // An info-only clamp is pipeline noise, not a guardrail hit: no Jev review group forms (visual audit 1-1).
    expect(labels).toEqual(["3 pipeline events", "2 noise steps: pipeline events, lifecycle events"]);
    const attentionOnly = buildSession({
      steps: [
        { kind: "instruction", tMs: 0, text: "go" },
        { kind: "attention", tMs: 1_000, noise: "pipeline" },
        { kind: "attention", tMs: 1_000, noise: "pipeline" },
      ],
    });
    expect(rowsOf(attentionOnly).flatMap((r) => (r.t === "noise" ? [[r.label, r.jev]] : []))).toEqual([["2 pipeline events", undefined]]);
  });

  it("labels a 5,000-step noise run once, with its reasons in first-appearance order", () => {
    const reasons = ["lifecycle", "read", "pipeline"] as const;
    const session = buildSession({
      steps: [
        { kind: "instruction", tMs: 0, text: "go" },
        ...Array.from({ length: 5_000 }, (_, j): StepSeed => {
          const reason = j < 4_000 ? "lifecycle" : reasons[j % 3] ?? "read";
          return { kind: reason === "read" ? "read" : reason === "pipeline" ? "attention" : "lifecycle", tMs: 1_000 + j, noise: reason };
        }),
      ],
    });
    const noise = rowsOf(session).filter((r): r is Extract<SpineRow, { t: "noise" }> => r.t === "noise");
    expect(noise.map((r) => [r.steps.length, r.label])).toEqual([[5_000, "5000 noise steps: lifecycle events, reads, pipeline events"]]);
  });

  it("Session level shows chapter rows interleaved with beats", () => {
    const rows = rowsOf(oauth, { level: "session" });
    expect(rows.filter((r) => r.t === "chapter")).toHaveLength(7);
    const beats = rows.filter((r): r is Extract<SpineRow, { t: "step" }> => r.t === "step").map((r) => oauth.steps[r.step]?.kind);
    expect(beats).toEqual(["instruction", "decision", "test", "message"]);
    expect(rows[0]?.t).toBe("step");
  });

  it("estimates expanded finding rows per signal and finds the row holding a seq", () => {
    const rows = rowsOf(oauth);
    const claimRow = rows.find((r) => r.key === claim?.id);
    expect(claimRow === undefined ? 0 : estimateSpineRowSize(claimRow, oauth)).toBe(124);
    expect(estimateSpineRowSize({ t: "turn", key: "turn:1", turn: 1 }, oauth)).toBe(24);
    expect(spineRowIndexForSeq(rows, oauth, claim?.firstSeq ?? 0)).toBe(rows.indexOf(claimRow as SpineRow));
    const read = oauth.steps.find((s) => s.kind === "read");
    const readRow = spineRowIndexForSeq(rows, oauth, read?.firstSeq ?? 0);
    expect(rows[readRow]?.t).toBe("noise");
    expect(spineRowIndexForSeq(rows, oauth, 0)).toBe(-1);
  });
});

describe("Jev review groups at Chapter level (visual audit 1-1)", () => {
  // The oauth tail: warning clamps with findings interleaved with attention and info-only clamps.
  const tail: StepSeed[] = [
    { kind: "instruction", tMs: 0, text: "go" },
    { kind: "command", tMs: 1_000, durationMs: 500, target: "pnpm test" },
    { kind: "guardrail", tMs: 45_000, guardrail: { clampIds: ["security_path"] } },
    { kind: "attention", tMs: 45_000, noise: "pipeline" },
    { kind: "guardrail", tMs: 45_000, noise: "pipeline", guardrail: { clampIds: ["suppress_formatting"] } },
    { kind: "attention", tMs: 45_000, noise: "pipeline" },
    { kind: "guardrail", tMs: 45_000, guardrail: { clampIds: ["schema_floor"] } },
    { kind: "attention", tMs: 45_000, noise: "pipeline" },
  ];
  const warnings = [{ ruleId: "guardrail_clamp" as const, severity: "warning" as const, step: 2 }, { ruleId: "guardrail_clamp" as const, severity: "warning" as const, step: 6 }];

  it("fold consecutive Jev rows into one group row with a count and the worst tone", () => {
    const session = buildSession({ steps: tail, findings: warnings });
    const rows = rowsOf(session);
    expect(rows.map((r) => r.t)).toEqual(["step", "step", "noise"]);
    expect(rows[2]).toEqual({
      t: "noise", key: `noise:${session.steps[2]?.firstSeq}`, steps: [2, 3, 4, 5, 6, 7], label: "Jev review · 2 guardrails",
      jev: { guardrails: 2, tone: "neutral", severity: "warning" },
    });
    // Expanding the group lists its steps, as for a noise run.
    expect(rowsOf(session, { expanded: new Set([rows[2]?.key ?? ""]) }).filter((r) => r.t === "step")).toHaveLength(8);
  });

  it("keep critical findings, the playhead and the selection as their own rows; Step level never groups", () => {
    const critical = buildSession({ steps: tail, findings: [...warnings, { ruleId: "guardrail_clamp", severity: "critical", step: 4 }] });
    expect(rowsOf(critical).map((r) => (r.t === "noise" ? r.steps : r.t === "step" ? r.step : r.t))).toEqual([0, 1, [2, 3], 4, [5, 6, 7]]);
    const session = buildSession({ steps: tail, findings: warnings });
    const selected = session.steps[5];
    expect(rowsOf(session, { selection: selected?.id ?? null }).map((r) => (r.t === "noise" ? r.steps : r.t === "step" ? r.step : r.t)))
      .toEqual([0, 1, [2, 3, 4], 5, [6, 7]]);
    expect(rowsOf(session, { level: "step" }).some((r) => r.t === "noise")).toBe(false);
  });
});

describe("Session-level beats on the folded oauth fixture (visual audit 1-14)", () => {
  const trace = loadFixtureTrace("oauth");
  const session = foldRows(trace.meta, trace.rows, { live: false });

  it("read in gutter-time order: the decision at +0:25 comes before the chapter it opens at +0:26", () => {
    const rows = rowsOf(session, { level: "session" });
    const times = rows.flatMap((r) => (r.t === "chapter" ? [session.chapters[r.chapter]?.tMs ?? -1] : r.t === "step" ? [session.steps[r.step]?.tMs ?? -1] : []));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    const decision = rows.findIndex((r) => r.t === "step" && session.steps[r.step]?.kind === "decision");
    const opened = rows.findIndex((r) => r.t === "chapter" && session.chapters[r.chapter]?.decisionIds.length !== 0 && session.chapters[r.chapter]?.tMs === 26_000);
    expect(decision).toBeGreaterThanOrEqual(0);
    expect(opened).toBe(decision + 1);
  });
});

describe("chapters that share an anchor seq", () => {
  // A decision linked to both units is each unit's earliest step (spec §7.5).
  const session = buildSession({
    steps: [
      { kind: "decision", tMs: 0, chapter: "a", alsoChapters: ["b"] },
      { kind: "edit", tMs: 1_000, target: "a.ts", chapter: "a" },
      { kind: "edit", tMs: 2_000, target: "a2.ts", chapter: "a" },
      { kind: "message", tMs: 3_000 },
      { kind: "edit", tMs: 4_000, target: "b.ts", chapter: "b" },
    ],
    chapters: [{ id: "a", title: "A" }, { id: "b", title: "B" }],
  });

  it("get distinct Session-level keys, ch:<anchor> then ch:<anchor>.<n> by unit id, whatever the chapter order", () => {
    const rows = rowsOf(session, { level: "session" });
    expect(rows.map((r) => r.key)).toEqual(["ch:1", "ch:1.1", "step:1"]);
    const flipped = { ...session, chapters: [...session.chapters].reverse() };
    const keyed = rowsOf(flipped, { level: "session" }).map((r) => (r.t === "chapter" ? `${r.key}=${flipped.chapters[r.chapter]?.id}` : r.key));
    expect(keyed).toEqual(["ch:1=unit:a", "ch:1.1=unit:b", "step:1"]);
  });

  it("a seq with no row of its own resolves to the chapter row holding its step", () => {
    const rows = rowsOf(session, { level: "session" });
    expect(spineRowIndexForSeq(rows, session, 5)).toBe(1);
    expect(spineRowIndexForSeq(rows, session, 2)).toBe(0);
    expect(spineRowIndexForSeq(rows, session, 4)).toBe(-1);
  });
});

describe("elision and separators", () => {
  it("a 412-row unpinned segment renders 3 + band + 5", () => {
    const session = buildSession({ steps: commands(412) });
    const rows = rowsOf(session);
    expect(rows).toHaveLength(10);
    const band = rows[4];
    expect(band).toMatchObject({ t: "elided", key: "elided:5", spanMs: 403_500 });
    expect(band?.t === "elided" ? band.steps.length : 0).toBe(404);
    expect(band?.t === "elided" ? band.byLane.commands : 0).toBe(404);
  });

  it("the playhead row is never elided and splits the band", () => {
    const session = buildSession({ steps: commands(412) });
    const rows = rowsOf(session, { playheadSeq: 201 });
    expect(rows).toHaveLength(20);
    expect(rows.some((r) => r.t === "step" && r.key === "step:201")).toBe(true);
  });

  it("an expanded band and the live tail are not elided", () => {
    const session = buildSession({ steps: commands(412) });
    expect(rowsOf(session, { expanded: new Set(["elided:5"]) })).toHaveLength(413);
    expect(rowsOf(session, { live: true })).toHaveLength(413);
    expect(rowsOf(session, { level: "step" })).toHaveLength(413);
  });

  it("exit -1 is unknown, never failed", () => {
    const session = buildSession({
      steps: commands(20, (j) => (j === 6 ? { status: "unknown", command: { exitCode: -1 } } : j === 15 ? { status: "failed" } : {})),
    });
    const rows = rowsOf(session);
    expect(rows.some((r) => r.t === "step" && r.step === 6)).toBe(false);
    const band = rows.find((r): r is Extract<SpineRow, { t: "elided" }> => r.t === "elided");
    expect(band?.steps).toContain(6);
    expect(rows.some((r) => r.t === "step" && r.step === 15)).toBe(true);
    const index = buildTraceIndex(session);
    const six = session.steps[6];
    const fifteen = session.steps[15];
    expect(six === undefined ? "" : stepTone(six, index.findingsById)).toBe("neutral");
    expect(fifteen === undefined ? "" : stepTone(fifteen, index.findingsById)).toBe("neutral");
  });

  it("adds turn, idle and gap separator rows", () => {
    const session = buildSession({
      turns: [{ trigger: "initial", prompt: "a" }, { trigger: "steer", prompt: "b" }],
      steps: [
        { kind: "instruction", tMs: 0 },
        { kind: "command", tMs: 1_000, durationMs: 1_000, target: "pnpm build" },
        { kind: "instruction", tMs: 842_000, turn: 1 },
        { kind: "command", tMs: 843_000, turn: 1, target: "pnpm test" },
      ],
      gaps: [{ kind: "invalid_row", beforeStep: 3 }],
    });
    const rows = rowsOf(session);
    expect(rows.map((r) => r.t)).toEqual(["step", "step", "turn", "idle", "step", "gap", "step"]);
    expect(rows[3]).toEqual({ t: "idle", key: `idle:${session.steps[2]?.firstSeq}`, ms: 840_000, reason: "awaiting_supervisor" });
    expect(rows[5]).toEqual({ t: "gap", key: `gap:${session.gaps[0]?.atSeq}`, gap: 0 });
  });
});
