import { describe, expect, it } from "vitest";

import { layoutCanvas, type CanvasFrame } from "../../../layout/canvas-layout.js";
import { buildTraceIndex } from "../../../layout/trace-index.js";
import { describeGraphic, type Step, type TraceSession } from "../../../model/index.js";
import { buildCanvasSession, canvasScale, oauthCanvasSession } from "../../../test-support/canvas-arbitraries.js";
import {
  buildFrameContext,
  frameApprox,
  frameEnd,
  frameFullTitle,
  frameLabel,
  frameStart,
  frameStepRows,
  frameTitle,
  frameTone,
  graphicPhrase,
  planItems,
  timeChip,
  zoomBand,
} from "./frame-label.js";

// Expected strings: spec §7.13 ("Linking test, 1 failed, 14 passed, +0:33", with the model's unit title),
// §7.1 FINDING_TITLE, and the canvas mockup's time chip "+0:33 – 0:40".

const oauth = oauthCanvasSession();
const layout = layoutCanvas(oauth, buildTraceIndex(oauth), canvasScale(oauth), "chapter");
const ctx = buildFrameContext(oauth);

function frame(predicate: (candidate: CanvasFrame) => boolean): CanvasFrame {
  const found = layout.frames.find(predicate);
  if (found === undefined) throw new Error("frame not found");
  return found;
}

function chapterFrameOf(session: TraceSession): CanvasFrame {
  const chapterLayout = layoutCanvas(session, buildTraceIndex(session), canvasScale(session), "chapter");
  const found = chapterLayout.frames.find((candidate) => candidate.kind === "chapter");
  if (found === undefined) throw new Error("no chapter frame");
  return found;
}

describe("frameLabel", () => {
  it("names oauth's linking-test chapter with failures first", () => {
    expect(frameLabel(frame((f) => f.selId === "unit:oauth-linking-test-failure"), ctx)).toBe(
      "OAuth account-linking test failure, 1 failed, 14 passed, +0:33",
    );
  });

  it("names the contradiction on the claim frame", () => {
    expect(frameLabel(frame((f) => f.item === "claim"), ctx)).toBe("Final claim, Claim contradicts tests, +0:43");
  });

  it("marks a chapter joined by time window as approximate and never red", () => {
    const base = buildCanvasSession([{ atMs: 1_000, kind: "chapter", title: "Identity layer" }]);
    const session = { ...base, chapters: base.chapters.map((chapter) => ({ ...chapter, link: "inferred" as const })) };
    const approxFrame = chapterFrameOf(session);
    const approxCtx = buildFrameContext(session);
    expect(frameApprox(approxFrame, approxCtx)).toBe(true);
    const label = frameLabel(approxFrame, approxCtx);
    expect(label.startsWith("Identity layer, approximate join, ")).toBe(true);
    expect(label.endsWith(", +0:01")).toBe(true);
    expect(frameTone(approxFrame, approxCtx)).toBe("neutral");
  });

  it("gives the selected chapter's time chip", () => {
    const linkingTest = frame((f) => f.selId === "unit:oauth-linking-test-failure");
    expect(timeChip(frameStart(linkingTest, ctx), frameEnd(linkingTest, ctx))).toBe("+0:33 – 0:40");
  });
});

describe("frame titles", () => {
  it("shows the chapter's short title and keeps the full title for the name", () => {
    const linkingTest = frame((f) => f.selId === "unit:oauth-linking-test-failure");
    const chapter = oauth.chapters.find((candidate) => candidate.id === linkingTest.selId);
    expect(chapter?.shortTitle).toBeDefined();
    expect(frameTitle(linkingTest, ctx)).toBe(chapter?.shortTitle);
    expect(frameFullTitle(linkingTest, ctx)).toBe("OAuth account-linking test failure");
  });

  it("shows a bidi override in a chapter title as a visible token in the title, full title and label", () => {
    const session = buildCanvasSession([{ atMs: 1_000, kind: "chapter", title: "Rename src/‮txt.exe" }]);
    const hostile = chapterFrameOf(session);
    const hostileCtx = buildFrameContext(session);
    for (const text of [frameTitle(hostile, hostileCtx), frameFullTitle(hostile, hostileCtx), frameLabel(hostile, hostileCtx)]) {
      expect(text).toContain("src/⟨U+202E⟩txt.exe");
      expect(text).not.toContain("‮");
    }
  });
});

describe("frameTone (anchor rule)", () => {
  it("reddens oauth's linking-test chapter through its anchored failing run", () => {
    expect(frameTone(frame((f) => f.selId === "unit:oauth-linking-test-failure"), ctx)).toBe("bad");
    expect(frameTone(frame((f) => f.selId === "unit:oauth-migration"), ctx)).toBe("neutral");
  });

  it("keeps a chapter neutral when a critical finding only cites its step or only names the chapter", () => {
    const session: TraceSession = structuredClone(
      buildCanvasSession([
        { atMs: 1_000, kind: "loose" },
        { atMs: 3_000, kind: "chapter", title: "Identity layer" },
        { atMs: 6_000, kind: "claim", flagged: true },
      ]),
    );
    const chapter = session.chapters[0];
    const edit = session.steps.find((step) => step.id === chapter?.stepIds[0]);
    const contradiction = session.findings.find((finding) => finding.ruleId === "claim_contradicted");
    if (chapter === undefined || edit === undefined || contradiction === undefined) throw new Error("builder changed");
    // Cited, never anchored: the claim finding lists the chapter's edit as evidence and names the chapter.
    edit.findingIds.push(contradiction.id);
    chapter.findingIds.push(contradiction.id);
    const cited = chapterFrameOf(session);
    expect(frameTone(cited, buildFrameContext(session))).toBe("neutral");
  });

  it("ignores a failing run the chapter only reaches through a shared validation", () => {
    const session: TraceSession = structuredClone(
      buildCanvasSession([
        { atMs: 1_000, kind: "loose" },
        { atMs: 3_000, kind: "chapter", title: "Identity layer" },
      ]),
    );
    const chapter = session.chapters[0];
    const run = session.steps.find((step) => step.kind === "test");
    if (chapter === undefined || run === undefined) throw new Error("builder changed");
    chapter.stepIds = [run.id, ...chapter.stepIds];
    chapter.validationOnlyStepIds = [run.id];
    run.chapterIds = [chapter.id];
    const shared = chapterFrameOf(session);
    const sharedCtx = buildFrameContext(session);
    expect(frameTone(shared, sharedCtx)).toBe("neutral");
    chapter.validationOnlyStepIds = [];
    expect(frameTone(shared, buildFrameContext(session))).toBe("bad");
  });
});

describe("graphicPhrase", () => {
  it("puts failures first for tests and keeps every other graphic's description", () => {
    expect(graphicPhrase({ kind: "tests", passed: 14, failed: 1, skipped: 0 })).toBe("1 failed, 14 passed");
    expect(graphicPhrase({ kind: "tests", passed: 3, failed: 0, skipped: 2 })).toBe("3 passed, 2 skipped");
    const diff = { kind: "diff" as const, added: 17, removed: 3 };
    expect(graphicPhrase(diff)).toBe(describeGraphic(diff));
  });
});

describe("planItems", () => {
  it("splits oauth's one-line plan into its four items", () => {
    const plan = oauth.steps.find((step) => step.id === oauth.turns[0]?.planStepId);
    expect(planItems(plan?.text ?? "")).toEqual([
      "introduce an Identity layer",
      "add a Google OAuth provider",
      "wire a callback route",
      "add a migration for the identities table",
    ]);
  });

  it("reads numbered and bulleted lines and leaves prose without a list alone", () => {
    expect(planItems("Plan:\n1. Read the code\n2. Add the provider\n- Run the tests")).toEqual([
      "Read the code",
      "Add the provider",
      "Run the tests",
    ]);
    expect(planItems("I will look at the auth code first and then decide.")).toEqual([]);
  });
});

describe("zoomBand", () => {
  it("hides the graphic below 0.5 and shows only icon and state fill below 0.35", () => {
    expect(zoomBand(0.5)).toBe("full");
    expect(zoomBand(0.49)).toBe("nographic");
    expect(zoomBand(0.35)).toBe("nographic");
    expect(zoomBand(0.34)).toBe("icon");
  });
});

describe("frameStepRows", () => {
  const session = buildCanvasSession(
    Array.from({ length: 20 }, (_, i) => ({ atMs: 1_000 * (i + 1), kind: "work" as const })),
  );
  const work: Step[] = session.steps.slice(1);
  const seqs = (rows: ReturnType<typeof frameStepRows>): Array<number | string> =>
    rows.map((row) => (row.t === "band" ? `band ${row.count}` : row.step.firstSeq));

  it("keeps every step when nine or fewer", () => {
    expect(seqs(frameStepRows(work.slice(0, 9)))).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("keeps head 3, tail 5 and problem steps, collapsing other runs into bands", () => {
    const steps = work.map((step, i) => (i === 10 ? { ...step, problems: ["exit_nonzero" as const] } : step));
    expect(seqs(frameStepRows(steps))).toEqual([2, 3, 4, "band 7", 12, "band 4", 17, 18, 19, 20, 21]);
  });

  it("caps the rows and keeps the tail when problem steps overflow the cap", () => {
    const steps = work.map((step) => ({ ...step, problems: ["exit_nonzero" as const] }));
    const rows = frameStepRows(steps, 9, 12);
    expect(rows.length).toBeLessThanOrEqual(12);
    expect(seqs(rows).slice(0, 3)).toEqual([2, 3, 4]);
    expect(seqs(rows).slice(-5)).toEqual([17, 18, 19, 20, 21]);
    const shown = rows.reduce((sum, row) => sum + (row.t === "band" ? row.count : 1), 0);
    expect(shown).toBe(steps.length);
  });
});
