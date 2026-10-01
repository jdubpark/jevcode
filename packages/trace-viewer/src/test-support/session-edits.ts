// Test-only: copy-on-write edits of a session, for properties of builds that start from the previous commit's
// result (the trace index, the overview index). Untouched Step, Chapter and Finding objects stay shared with the
// input, as finalize keeps them (spec §6.4), while the edits break the joins a fold would keep consistent: a step can
// list a chapter that does not list it back, ids can dangle, and items move, appear and go.
import fc from "fast-check";

import type { ChangeCategory } from "@jevcode/contracts";

import type { Chapter, Finding, Severity, Step, StepId, StepKind, TraceSession, UnitStableId } from "../model/index.js";
import { LANE_OF_KIND } from "./session-builder.js";

export type SessionEdit =
  | { op: "stepSeq"; at: number; first: number; last: number }
  | { op: "stepChapters"; at: number; keep: number; add: number }
  | { op: "dropStep"; at: number }
  | { op: "swapSteps"; at: number; with: number }
  | { op: "addStep"; at: number; seq: number; add: number }
  | { op: "stepTime"; at: number; dt: number; duration: number | null }
  | { op: "stepFindings"; at: number; keep: number; add: number }
  | { op: "stepKind"; at: number; kind: StepKind }
  | { op: "stepNoise"; at: number }
  | { op: "findingSeverity"; at: number; severity: Severity }
  | { op: "findingAnchor"; at: number; to: number }
  | { op: "chapterNoise"; at: number }
  | { op: "chapterSteps"; at: number; keep: number; add: number }
  | { op: "chapterFacts"; at: number; seq: number }
  | { op: "chapterCurrent"; at: number }
  | { op: "chapterValidationOnly"; at: number; keep: number }
  | { op: "chapterTitle"; at: number; title: string | null }
  | { op: "chapterCategory"; at: number; category: ChangeCategory }
  | { op: "dropChapter"; at: number }
  | { op: "swapChapters"; at: number; with: number }
  | { op: "addChapter"; at: number; seq: number; add: number };

const KINDS = Object.keys(LANE_OF_KIND) as StepKind[];

export const arbEdit: fc.Arbitrary<SessionEdit> = fc.oneof(
  fc.record({ op: fc.constant("stepSeq" as const), at: fc.nat(), first: fc.integer({ min: -3, max: 3 }), last: fc.integer({ min: 0, max: 5 }) }),
  fc.record({ op: fc.constant("stepChapters" as const), at: fc.nat(), keep: fc.nat(), add: fc.nat() }),
  fc.record({ op: fc.constant("dropStep" as const), at: fc.nat() }),
  fc.record({ op: fc.constant("swapSteps" as const), at: fc.nat(), with: fc.nat() }),
  fc.record({ op: fc.constant("addStep" as const), at: fc.nat(), seq: fc.nat({ max: 40 }), add: fc.nat() }),
  fc.record({
    op: fc.constant("stepTime" as const), at: fc.nat(), dt: fc.integer({ min: -5_000, max: 90_000 }),
    duration: fc.option(fc.nat({ max: 120_000 }), { nil: null }),
  }),
  fc.record({ op: fc.constant("stepFindings" as const), at: fc.nat(), keep: fc.nat(), add: fc.nat() }),
  fc.record({ op: fc.constant("stepKind" as const), at: fc.nat(), kind: fc.constantFrom(...KINDS) }),
  fc.record({ op: fc.constant("stepNoise" as const), at: fc.nat() }),
  fc.record({ op: fc.constant("findingSeverity" as const), at: fc.nat(), severity: fc.constantFrom<Severity>("info", "warning", "critical") }),
  fc.record({ op: fc.constant("findingAnchor" as const), at: fc.nat(), to: fc.nat() }),
  fc.record({ op: fc.constant("chapterNoise" as const), at: fc.nat() }),
  fc.record({ op: fc.constant("chapterSteps" as const), at: fc.nat(), keep: fc.nat(), add: fc.nat() }),
  fc.record({ op: fc.constant("chapterFacts" as const), at: fc.nat(), seq: fc.nat({ max: 40 }) }),
  fc.record({ op: fc.constant("chapterCurrent" as const), at: fc.nat() }),
  fc.record({ op: fc.constant("chapterValidationOnly" as const), at: fc.nat(), keep: fc.nat() }),
  fc.record({ op: fc.constant("chapterTitle" as const), at: fc.nat(), title: fc.option(fc.constantFrom("Auth", "Rate limit"), { nil: null }) }),
  fc.record({ op: fc.constant("chapterCategory" as const), at: fc.nat(), category: fc.constantFrom<ChangeCategory>("tests", "implementation", "configuration") }),
  fc.record({ op: fc.constant("dropChapter" as const), at: fc.nat() }),
  fc.record({ op: fc.constant("swapChapters" as const), at: fc.nat(), with: fc.nat() }),
  fc.record({ op: fc.constant("addChapter" as const), at: fc.nat(), seq: fc.nat({ max: 40 }), add: fc.nat() }),
);

function swap<T>(list: T[], a: number, b: number): void {
  const i = a % Math.max(1, list.length);
  const j = b % Math.max(1, list.length);
  const x = list[i];
  const y = list[j];
  if (x !== undefined && y !== undefined) [list[i], list[j]] = [y, x];
}

function replaceAt<T>(list: T[], n: number, change: (item: T) => T): void {
  const at = n % Math.max(1, list.length);
  const item = list[at];
  if (item !== undefined) list[at] = change(item);
}

/** Applies edits copy-on-write, so untouched objects (and untouched lists) stay shared with `session`. */
export function editSession(session: TraceSession, edits: readonly SessionEdit[]): TraceSession {
  const steps = [...session.steps];
  const chapters = [...session.chapters];
  const findings = [...session.findings];
  let findingsTouched = false;
  const stepIdAt = (n: number): StepId => steps[n % Math.max(1, steps.length)]?.id ?? ("step:dangling" as StepId);
  const chapterIdAt = (n: number): UnitStableId =>
    n % 5 === 4 ? ("unit:dangling" as UnitStableId) : (chapters[n % Math.max(1, chapters.length)]?.id ?? ("unit:dangling" as UnitStableId));
  const setStep = (n: number, change: (s: Step) => Step) => replaceAt(steps, n, change);
  const setChapter = (n: number, change: (c: Chapter) => Chapter) => replaceAt(chapters, n, change);
  for (const e of edits) {
    switch (e.op) {
      case "stepSeq":
        setStep(e.at, (s) => ({ ...s, firstSeq: Math.max(1, s.firstSeq + e.first), lastSeq: Math.max(1, s.firstSeq + e.first) + e.last }));
        break;
      case "stepChapters":
        setStep(e.at, (s) => ({ ...s, chapterIds: [...s.chapterIds.slice(0, e.keep % (s.chapterIds.length + 1)), chapterIdAt(e.add)] }));
        break;
      case "dropStep":
        if (steps.length > 0) steps.splice(e.at % steps.length, 1);
        break;
      case "swapSteps":
        swap(steps, e.at, e.with);
        break;
      case "addStep": {
        const base = steps[0];
        const id = `step:added-${steps.length}-${e.seq}` as StepId;
        if (base === undefined || steps.some((s) => s.id === id)) break;
        steps.splice(e.at % (steps.length + 1), 0, { ...base, id, firstSeq: e.seq + 1, lastSeq: e.seq + 2, chapterIds: [chapterIdAt(e.add)] });
        break;
      }
      case "stepTime":
        setStep(e.at, (s) => {
          const tMs = Math.max(0, s.tMs + e.dt);
          return e.duration === null
            ? { ...s, tMs, durationMs: null, endTMs: null }
            : { ...s, tMs, durationMs: e.duration, endTMs: tMs + e.duration };
        });
        break;
      case "stepFindings":
        setStep(e.at, (s) => {
          const added = findings[e.add % Math.max(1, findings.length)]?.id;
          const kept = s.findingIds.slice(0, e.keep % (s.findingIds.length + 1));
          return { ...s, findingIds: added === undefined || kept.includes(added) ? kept : [...kept, added] };
        });
        break;
      case "stepKind":
        setStep(e.at, (s) => ({ ...s, kind: e.kind, lane: LANE_OF_KIND[e.kind] }));
        break;
      case "stepNoise":
        setStep(e.at, (s) => ({ ...s, noise: s.noise === null ? "formatting" : null }));
        break;
      case "findingSeverity":
        replaceAt(findings, e.at, (f): Finding => ({ ...f, severity: e.severity }));
        findingsTouched = findings.length > 0;
        break;
      case "findingAnchor":
        // Moves the step a finding anchors to (the anchor rule reads it); the finding's own list order is unchanged.
        replaceAt(findings, e.at, (f): Finding => {
          const to = steps[e.to % Math.max(1, steps.length)];
          return to === undefined ? f : { ...f, anchorStepId: to.id, anchorSeq: to.firstSeq };
        });
        findingsTouched = findings.length > 0;
        break;
      case "chapterNoise":
        setChapter(e.at, (c) => ({ ...c, noise: !c.noise }));
        break;
      case "chapterSteps":
        setChapter(e.at, (c) => ({ ...c, stepIds: [...c.stepIds.slice(0, e.keep % (c.stepIds.length + 1)), stepIdAt(e.add)] }));
        break;
      case "chapterFacts":
        setChapter(e.at, (c) => ({ ...c, factSeqs: [...c.factSeqs, e.seq] }));
        break;
      case "chapterCurrent":
        setChapter(e.at, (c) => ({ ...c, current: !c.current }));
        break;
      case "chapterValidationOnly":
        setChapter(e.at, (c) => ({ ...c, validationOnlyStepIds: c.stepIds.slice(0, e.keep % (c.stepIds.length + 1)) }));
        break;
      case "chapterTitle":
        setChapter(e.at, (c) => {
          const { shortTitle: _drop, ...rest } = c;
          return e.title === null ? rest : { ...rest, shortTitle: e.title };
        });
        break;
      case "chapterCategory":
        setChapter(e.at, (c) => ({ ...c, category: e.category }));
        break;
      case "dropChapter":
        if (chapters.length > 0) chapters.splice(e.at % chapters.length, 1);
        break;
      case "swapChapters":
        swap(chapters, e.at, e.with);
        break;
      case "addChapter": {
        const base = chapters[0];
        const id = `unit:added-${chapters.length}-${e.seq}` as UnitStableId;
        if (base === undefined || chapters.some((c) => c.id === id)) break;
        chapters.splice(e.at % (chapters.length + 1), 0, { ...base, id, factSeqs: [e.seq], stepIds: [stepIdAt(e.add)], current: e.seq % 2 === 0 });
        break;
      }
    }
  }
  return { ...session, steps, chapters, findings: findingsTouched ? findings : session.findings };
}
