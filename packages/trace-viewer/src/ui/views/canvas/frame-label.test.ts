import { describe, expect, it } from "vitest";

import { layoutCanvas, type CanvasFrame } from "../../../layout/canvas-layout.js";
import { buildMinimap } from "../../../layout/canvas-minimap.js";
import { buildTraceIndex } from "../../../layout/trace-index.js";
import { describeGraphic, type Step, type TraceSession } from "../../../model/index.js";
import { buildCanvasSession, canvasScale, oauthCanvasSession, oauthReplaySession } from "../../../test-support/canvas-arbitraries.js";
import {
  buildFrameContext,
  CARD_FILE_ROWS,
  criticalFrameKeys,
  fillRowCount,
  frameApprox,
  frameEnd,
  frameFullTitle,
  frameGraphic,
  frameLabel,
  frameModel,
  frameStart,
  frameStepRows,
  frameTitle,
  frameTone,
  graphicPhrase,
  fillSteps,
  ownSteps,
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

describe("chapter fork (spec §7.12 refinement, C3-6 ruling)", () => {
  it("draws oauth's fork only on the decision frame; the identity chapter shows its file list", () => {
    const forks = layout.frames.filter((f) => frameGraphic(f, ctx)?.kind === "fork").map((f) => f.item);
    expect(forks).toEqual(["decision"]);
    const identity = frameGraphic(frame((f) => f.selId === "unit:oauth-identity-layer"), ctx);
    expect(identity?.kind).toBe("diff");
    expect(identity?.kind === "diff" ? identity.files?.map((file) => file.path) : null).toEqual([
      "src/auth/google.ts",
      "src/auth/identity.ts",
      "src/auth/service.ts",
      "src/server/index.ts",
    ]);
    // The decision-born chapter sits under its decision frame, which already shows the fork.
    expect(frameGraphic(frame((f) => f.selId === "unit:oauth-account-linking-decision"), ctx)?.kind).toBe("diff");
  });
});

describe("fillSteps (sparse frames, C3-6 ruling)", () => {
  function stepOf(id: string): Step {
    const step = ctx.stepById.get(id);
    if (step === undefined) throw new Error(`no ${id}`);
    return step;
  }

  it("takes up to n steps, problem steps first and newest first", () => {
    const steps = ["step:1", "step:41", "step:43", "step:49"].map(stepOf);
    // step:43 (failed test) and step:49 (contradicted claim) are the problems.
    expect(fillSteps(steps, 3, ctx.findingsById).map((step) => step.id)).toEqual(["step:49", "step:43", "step:41"]);
    expect(fillSteps(steps, 0, ctx.findingsById)).toEqual([]);
    expect(fillSteps(steps.slice(0, 2), 3, ctx.findingsById).map((step) => step.id)).toEqual(["step:41", "step:1"]);
  });

  it("ranks a step that only cites a finding by age, as any other step (anchor rule)", () => {
    const session: TraceSession = structuredClone(oauth);
    const contradiction = session.findings.find((finding) => finding.ruleId === "claim_contradicted");
    const older = session.steps.find((step) => step.id === "step:13");
    const newer = session.steps.find((step) => step.id === "step:41");
    if (contradiction === undefined || older === undefined || newer === undefined) throw new Error("fixture changed");
    older.findingIds.push(contradiction.id);
    const citing = buildFrameContext(session);
    expect(fillSteps([older, newer], 2, citing.findingsById).map((step) => step.id)).toEqual(["step:41", "step:13"]);
  });
});

describe("Chapter card budget (C3-6 re-review N-1)", () => {
  // Spec §7.5: a 134 px Chapter slot holds the 22 px label row, so the card is 112 px. Frame.module.css: 12 px
  // padding, a 16 px footer and an 8 px gap leave 64 px; a file row is 16 px with 4 px between rows.
  const plain = ctx.session.steps.filter((step) => step.edit === undefined).slice(0, 3);
  const edited = ctx.session.steps.filter((step) => step.edit !== undefined).slice(0, 3);

  it("fits three 16 px file rows in the 64 px body of a 112 px card", () => {
    expect(CARD_FILE_ROWS).toBe(3);
  });

  it("budgets fill rows from the card, not the slot", () => {
    expect(fillRowCount(null, plain)).toBe(3);
    // The edit summary takes 16 px: 64 - 16 - 8 leaves two 20 px rows.
    expect(fillRowCount(null, edited)).toBe(2);
    const oneFile = { kind: "diff" as const, added: 3, removed: 1, files: [{ path: "a.ts", added: 3, removed: 1 }] };
    expect(fillRowCount(oneFile, plain)).toBe(2);
    const threeFiles = { ...oneFile, files: ["a.ts", "b.ts", "c.ts", "d.ts"].map((path) => ({ path, added: 1, removed: 0 })) };
    expect(fillRowCount(threeFiles, plain)).toBe(0);
  });
});

describe("a shared validation run (replay-shaped oauth, lane review I-1, I-2)", () => {
  const replay = oauthReplaySession();
  const replayLayout = layoutCanvas(replay, buildTraceIndex(replay), canvasScale(replay), "chapter");
  const replayCtx = buildFrameContext(replay);
  const shared = replay.steps.find((step) => step.kind === "test");
  const OWNER = "unit:cu_a2589fe62ff19ebf";
  const PACKAGE = "unit:cu_78093dbe9212089d";

  function replayFrame(selId: string): CanvasFrame {
    const found = replayLayout.frames.find((candidate) => candidate.memberSelIds.includes(selId));
    if (found === undefined) throw new Error(`no frame for ${selId}`);
    return found;
  }

  it("is one failed run that every chapter joins", () => {
    expect(shared?.status).toBe("failed");
    expect(replay.chapters.every((chapter) => shared !== undefined && chapter.stepIds.includes(shared.id))).toBe(true);
  });

  it("belongs to the chapter that owns its outcome only", () => {
    for (const chapter of replay.chapters) {
      const ids = ownSteps(replayFrame(chapter.id), replayCtx).map((step) => step.id);
      expect(ids.includes(shared?.id ?? ""), chapter.title).toBe(chapter.id === OWNER);
    }
  });

  it("is red only in the owning chapter and the contradicted claim", () => {
    const bad = replayLayout.frames.filter((candidate) => frameTone(candidate, replayCtx) === "bad");
    expect(bad.map((candidate) => candidate.item === "claim" ? "claim" : candidate.selId).toSorted()).toEqual(["claim", OWNER]);
  });

  it("marks only the owning chapter and the claim critical in the minimap (its strip reads the same set)", () => {
    const critical = criticalFrameKeys(replayLayout, replayCtx);
    const claim = replayLayout.frames.find((candidate) => candidate.item === "claim");
    expect([...critical].toSorted()).toEqual([claim?.key, replayFrame(OWNER).key].toSorted());
    const minimap = buildMinimap(replayLayout, { viewportWorld: replayLayout.bounds, selectedKey: null, criticalKeys: critical });
    const marks = new Map(minimap.frames.map((mini) => [mini.key, mini.mark]));
    expect(marks.get(replayFrame(PACKAGE).key)).toBe("frame");
    expect(marks.get(replayFrame(OWNER).key)).toBe("critical");
  });

  it("stays out of another chapter's fill rows, step count and time span", () => {
    const pkg = replayFrame(PACKAGE);
    const model = frameModel(pkg, replayCtx, "chapter");
    const ids = (steps: readonly Step[]): string[] => steps.map((step) => step.id);
    expect(ids(model.steps)).not.toContain(shared?.id);
    expect(ids(model.fill)).not.toContain(shared?.id);
    expect(model.steps).toHaveLength(3);
    // Package's own work ends with its package.json edit at +0:20.3; the shared run starts at +0:35.
    expect(frameEnd(pkg, replayCtx)).toBe(20_300);
    expect(model.end).toBe(20_300);
    expect(ids(frameModel(pkg, replayCtx, "step").steps)).not.toContain(shared?.id);
    expect(ids(frameModel(replayFrame(OWNER), replayCtx, "step").steps)).toContain(shared?.id);
  });

  it("fills sparse rows with work steps, never pipeline noise", () => {
    const session: TraceSession = structuredClone(replay);
    const pkg = replayFrame(PACKAGE);
    const own = ownSteps(pkg, buildFrameContext(session));
    const newest = own.at(-1);
    const target = session.steps.find((step) => step.id === newest?.id);
    if (target === undefined) throw new Error("no own step");
    target.noise = "pipeline";
    const model = frameModel(pkg, buildFrameContext(session), "chapter");
    expect(model.steps.map((step) => step.id)).toContain(target.id);
    expect(model.fill.map((step) => step.id)).not.toContain(target.id);
  });
});
