import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  accumulateAll,
  buildSearchIndex,
  createTraceState,
  describeGraphic,
  finalize,
  foldRows,
  formatOffset,
  pickGraphic,
} from "../../../model/index.js";
import { arbRowSession, soakShapedRows } from "../../../test-support/row-arbitraries.js";
import { TraceBuilder, testMeta } from "../../../test-support/trace-builder.js";
import { foldFixture } from "../../../test-support/ui-harness.js";
import {
  buildOutlineRows,
  DEFAULT_OPEN_SECTIONS,
  FILE_TITLE_MAX,
  fileTitleBudget,
  searchMatches,
  type OutlineItemRow,
  type OutlineRow,
  type OutlineSection,
} from "./outline-rows.js";

function itemsOf(rows: readonly OutlineRow[], section: OutlineSection): OutlineItemRow[] {
  return rows.filter((row): row is OutlineItemRow => row.t === "item" && row.section === section);
}

const ALL_OPEN = { open: new Set<OutlineSection>(["story", "files", "commands", "tests"]), showAll: new Set<OutlineSection>() };

describe("buildOutlineRows", () => {
  it("lists Intent, chapters and decisions in time order, one noise row, then the final claim", () => {
    // The oauth lockfile and formatting chapters are noise once the shared pnpm test validation no
    // longer names every chapter in the failing-test findings (orchestrator ruling M1).
    const session = foldFixture("oauth");
    const rows = buildOutlineRows(session, { open: DEFAULT_OPEN_SECTIONS, showAll: new Set() });
    expect(rows.some((row) => row.t === "turn")).toBe(false);
    const story = itemsOf(rows, "story");
    expect(story[0]?.title).toBe("Intent");
    const ordered = story.filter((row) => !row.muted && row.title !== "Final claim").map((row) => row.tMs);
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
    expect(story.some((row) => row.icon === "fork")).toBe(true);
    expect(story.find((row) => row.muted)?.title).toBe("Noise 2");
    expect(story.at(-1)?.title).toBe("Final claim");
    expect(story.at(-1)?.flag).toBe("neq");
    // Story rows carry no mini graphic, except the ForkGlyph of a decision row that absorbed its chapter.
    expect(story.every((row) => row.graphic === null || row.graphic.kind === "fork")).toBe(true);
  });

  it("sanitizes a hostile decision title and sets it in the sans face", () => {
    const base = foldFixture("oauth");
    const session = {
      ...base,
      steps: base.steps.map((step) =>
        step.kind === "decision" && step.decision !== undefined
          ? { ...step, decision: { ...step.decision, title: "Pick\u202E one" } }
          : step,
      ),
    };
    const fork = itemsOf(buildOutlineRows(session, ALL_OPEN), "story").find((row) => row.icon === "fork");
    expect(fork?.title).toBe("Pick⟨U+202E⟩ one");
    // Decision titles are prose, not paths or commands (§7.12): sans, still neutralised.
    expect(fork?.mono).toBe(false);
  });

  it("adds turn rows only when there is more than one turn", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "First" });
    b.agent({ type: "agent_message", role: "assistant", text: "one" });
    b.agent({ type: "agent_completed" });
    b.agent({ type: "agent_started", prompt: "Second" });
    b.agent({ type: "agent_message", role: "assistant", text: "two" });
    b.agent({ type: "agent_completed" });
    const rows = buildOutlineRows(foldRows(testMeta(), b.rows, { live: false }), ALL_OPEN);
    const turns = rows.filter((row) => row.t === "turn");
    expect(turns.map((row) => (row.t === "turn" ? row.label : ""))).toEqual(["Turn 1 · initial", "Turn 2 · resume"]);
  });

  it("collapses Files above 12 and shows all on demand", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Touch files" });
    for (let i = 0; i < 13; i += 1) {
      b.fact({ type: "file_changed", path: `src/f${String(i).padStart(2, "0")}.ts`, kind: "modified" });
    }
    const session = foldRows(testMeta(), b.rows, { live: false });
    expect(session.entities).toHaveLength(13);
    const collapsed = buildOutlineRows(session, ALL_OPEN);
    expect(itemsOf(collapsed, "files")).toHaveLength(12);
    expect(collapsed.find((row) => row.t === "more")).toEqual({ t: "more", key: "more:files", section: "files", hidden: 1 });
    const all = buildOutlineRows(session, { ...ALL_OPEN, showAll: new Set<OutlineSection>(["files"]) });
    expect(itemsOf(all, "files")).toHaveLength(13);
    expect(itemsOf(all, "files").every((row) => row.mono && row.openEvidence)).toBe(true);
    // Only the shown rows are built: the collapsed list is the full list's head, and a closed section keeps the count.
    expect(itemsOf(collapsed, "files")).toStrictEqual(itemsOf(all, "files").slice(0, 12));
    const header = (rows: typeof all) => rows.find((row) => row.key === "section:files");
    expect(header(collapsed)).toStrictEqual(header(all));
    const closed = buildOutlineRows(session, { ...ALL_OPEN, open: new Set<OutlineSection>(["story", "commands", "tests"]) });
    expect(header(closed)).toStrictEqual({ ...header(all), open: false });
    expect(itemsOf(closed, "files")).toHaveLength(0);
    expect(closed.some((row) => row.key === "more:files")).toBe(false);
  });

  it("marks a failed command with ✕ and the word failed", () => {
    const rows = buildOutlineRows(foldFixture("oauth"), ALL_OPEN);
    const test = itemsOf(rows, "commands").find((row) => row.title === "pnpm test");
    expect(test?.flag).toBe("x");
    expect(test?.failed).toBe(true);
    expect(test?.label).toContain("failed");
    const install = itemsOf(rows, "commands").find((row) => row.title.startsWith("pnpm add"));
    expect(install?.flag).toBeNull();
  });

  it("exit -1 reads exit unknown and carries no failure flag", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Lint" });
    b.agent({ type: "command_started", command: "pnpm lint" });
    b.agent({ type: "command_completed", command: "pnpm lint", exitCode: -1, stdout: "", stderr: "" });
    b.agent({ type: "agent_completed" });
    const session = foldRows(testMeta(), b.rows, { live: false });
    expect(session.chapters).toHaveLength(0);
    const rows = buildOutlineRows(session, ALL_OPEN);
    const lint = itemsOf(rows, "commands")[0];
    expect(lint?.title).toBe("pnpm lint");
    expect(lint?.flag).toBeNull();
    expect(lint?.failed).toBe(false);
    expect(lint?.label).toContain("exit unknown");
    expect(itemsOf(rows, "story").some((row) => row.chapterId !== null)).toBe(false);
  });

  it("puts the full frame description in a chapter row's accessible name", () => {
    const session = foldFixture("oauth");
    const testsChapter = session.chapters.find((chapter) => chapter.category === "tests");
    expect(testsChapter).toBeDefined();
    const row = itemsOf(buildOutlineRows(session, ALL_OPEN), "story").find((item) => item.chapterId === testsChapter?.id);
    const graphic = testsChapter === undefined ? null : pickGraphic(testsChapter, session);
    expect(row?.label.startsWith(testsChapter?.title ?? "")).toBe(true);
    expect(row?.label).toContain(graphic === null ? "" : describeGraphic(graphic));
    expect(row?.label.endsWith(formatOffset(testsChapter?.tMs ?? 0))).toBe(true);
  });

  it("shows a chapter row's short title, with the full title in its tooltip and accessible name", () => {
    const session = foldFixture("oauth");
    const testsChapter = session.chapters.find((chapter) => chapter.category === "tests");
    if (testsChapter === undefined) throw new Error("fixture changed");
    const row = itemsOf(buildOutlineRows(session, ALL_OPEN), "story").find((item) => item.chapterId === testsChapter.id);
    expect(row?.title).toBe("Tests · oauth");
    expect(row?.hint).toBe(testsChapter.title);
    expect(row?.label.startsWith(testsChapter.title)).toBe(true);
  });

  it("falls back to the full title and shows hostile short and full titles as visible tokens", () => {
    const base = foldFixture("oauth");
    const withShort = { ...base, chapters: base.chapters.map((chapter) => ({ ...chapter, title: "Full\u202E one", shortTitle: "Sh\u202Eort" })) };
    const rows = itemsOf(buildOutlineRows(withShort, ALL_OPEN), "story").filter((row) => row.chapterId !== null && row.icon !== "fork" && !row.muted);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.title).toBe("Sh\u27E8U+202E\u27E9ort");
      expect(row.hint).toBe("Full\u27E8U+202E\u27E9 one");
      expect(row.label.startsWith("Full\u27E8U+202E\u27E9 one")).toBe(true);
    }
    const noShort = { ...base, chapters: base.chapters.map((chapter) => {
      const copy = { ...chapter, title: "Full title" };
      delete copy.shortTitle;
      return copy;
    }) };
    const plain = itemsOf(buildOutlineRows(noShort, ALL_OPEN), "story").filter((row) => row.chapterId !== null && row.icon !== "fork" && !row.muted);
    expect(plain.every((row) => row.title === "Full title" && row.hint === undefined)).toBe(true);
  });

  it("search matches chapter titles and step text with every term required", () => {
    const session = foldFixture("oauth");
    const index = buildSearchIndex(session);
    const matches = searchMatches(session, index, "PNPM test");
    const testStep = session.steps.find((step) => step.command?.command === "pnpm test");
    expect(matches).toContain(testStep?.id);
    expect(searchMatches(session, index, "pnpm zzzz-not-there")).toEqual([]);
    expect(searchMatches(session, index, "   ")).toEqual([]);
  });

  it("shows a bidi override in a Files path as a visible token", () => {
    const base = foldFixture("oauth");
    const first = base.entities[0];
    const hostile = "src/evil\u202Egnp.ts";
    const session = { ...base, entities: base.entities.map((e, i) => (i === 0 ? { ...e, path: hostile, label: hostile } : e)) };
    const row = itemsOf(buildOutlineRows(session, ALL_OPEN), "files").find((item) => item.key === first?.id);
    expect(row?.title).not.toContain("\u202E");
    expect(row?.hint).toBe("src/evil\u27E8U+202E\u27E9gnp.ts");
    expect(row?.label).toContain("src/evil\u27E8U+202E\u27E9gnp.ts");
    expect(row?.label).not.toContain("\u202E");
  });

  it("shows a Files row by its basename, cut in the middle, with the full path in the tooltip and name", () => {
    const rows = itemsOf(buildOutlineRows(foldFixture("oauth"), ALL_OPEN), "files");
    const identity = rows.find((row) => row.hint === "src/auth/identity.ts");
    expect(identity?.title).toBe("identity.ts");
    expect(identity?.label.startsWith("src/auth/identity.ts")).toBe(true);
    const migration = rows.find((row) => row.hint === "migrations/001_create_identities.sql");
    // "001_create_identities.sql" is too long for the 216 px column: the extension must survive.
    expect(migration?.title).toMatch(/^001_.*….*\.sql$/u);
    expect(migration?.title.length).toBeLessThanOrEqual(FILE_TITLE_MAX + (migration?.flag === "shield" ? 0 : 2));
    expect(migration?.label.startsWith("migrations/001_create_identities.sql")).toBe(true);
  });

  it("sizes the Files basename budget to the measured column", () => {
    // 216 px and 200 px Outline columns (§7.1): 118 px of row chrome, then 12 px mono glyphs.
    expect(fileTitleBudget(216)).toBe(13);
    expect(fileTitleBudget(200)).toBe(11);
    expect(fileTitleBudget(0)).toBe(FILE_TITLE_MAX);
    const rows = itemsOf(buildOutlineRows(foldFixture("oauth"), { ...ALL_OPEN, fileTitleMax: 11 }), "files");
    const lock = rows.find((row) => row.hint === "pnpm-lock.yaml");
    expect(lock?.title).toMatch(/^pnpm.*….*yaml$/u);
    expect(lock?.title.length).toBe(lock?.flag === "shield" ? 11 : 13);
    // A row without the shield gains its 20 px: "package.json" (12) fits the 200 px column whole.
    const pkg = rows.find((row) => row.hint === "package.json");
    expect(pkg?.flag).toBeNull();
    expect(pkg?.title).toBe("package.json");
  });

  it("folds a decision-born chapter into its decision row with the fork glyph", () => {
    const session = foldFixture("oauth");
    const decision = session.steps.find((step) => step.kind === "decision");
    const born = session.chapters.find((chapter) => chapter.decisionIds.includes(`decision:${decision?.decision?.decisionId ?? ""}`));
    expect(decision).toBeDefined();
    expect(born).toBeDefined();
    const story = itemsOf(buildOutlineRows(session, ALL_OPEN), "story");
    // One row for the decision and the chapter it gave birth to, not two near-duplicates.
    expect(story.filter((row) => row.selId === decision?.id || row.chapterId === born?.id)).toHaveLength(1);
    const row = story.find((item) => item.selId === decision?.id);
    expect(row?.icon).toBe("fork");
    expect(row?.chapterId).toBe(born?.id);
    expect(row?.alsoSelects).toBe(born?.id);
    expect(row?.graphic?.kind).toBe("fork");
    expect(row?.tMs).toBe(Math.min(decision?.tMs ?? 0, born?.tMs ?? 0));
    expect(row?.mono).toBe(false);
    // A short label in the row (the Outline column is 216 px); the full decision title in the tooltip and the name.
    expect(row?.title).toBe("Account-linking policy…");
    expect(row?.hint).toBe(decision?.decision?.title);
    expect(row?.label.startsWith(decision?.decision?.title ?? "-")).toBe(true);
  });

  it("marks ≠ only on chapters that carry the claim finding, plus the Final claim", () => {
    const base = foldFixture("oauth");
    const claim = base.findings.find((finding) => finding.ruleId === "claim_contradicted");
    const failing = base.chapters.find((chapter) => chapter.status === "failed");
    expect(claim).toBeDefined();
    expect(failing).toBeDefined();
    // Model scoping (branch M) leaves the claim on the failing chapter only; the Outline follows the data.
    const session = {
      ...base,
      chapters: base.chapters.map((chapter) =>
        chapter.id === failing?.id ? chapter : { ...chapter, findingIds: chapter.findingIds.filter((id) => id !== claim?.id) },
      ),
    };
    const story = itemsOf(buildOutlineRows(session, ALL_OPEN), "story");
    const marked = story.filter((row) => row.flag === "neq").map((row) => row.chapterId ?? row.title);
    expect(marked).toEqual([failing?.id, "Final claim"]);
  });
});

describe("buildOutlineRows across Live commits", () => {
  // Rows are cached per step and entity object; the incremental finalize keeps unchanged objects.
  // A structural clone has only new objects, so its rows are built from scratch.
  const everything = { open: new Set<OutlineSection>(["story", "files", "commands", "tests"]), showAll: new Set<OutlineSection>(["files"]) };

  type Rows = Parameters<typeof accumulateAll>[1];

  /** One column width per run, as in the app: a width change rebuilds the Files rows anyway. */
  function checkCommits(meta: Parameters<typeof createTraceState>[0], batches: readonly Rows[]): void {
    for (const fileTitleMax of [FILE_TITLE_MAX, 30]) {
      const state = createTraceState(meta);
      const input = { ...everything, fileTitleMax };
      for (const [index, batch] of batches.entries()) {
        accumulateAll(state, batch);
        const session = finalize(state, { live: true, nowMs: index });
        expect(buildOutlineRows(session, input)).toStrictEqual(buildOutlineRows(structuredClone(session), input));
      }
    }
  }

  it("cached rows equal rows built from scratch after every commit (random rows)", () => {
    fc.assert(
      fc.property(arbRowSession(), fc.integer({ min: 1, max: 12 }), ({ meta, rows }, size) => {
        const batches = [];
        for (let start = 0; start < rows.length; start += size) batches.push(rows.slice(start, start + size));
        checkCommits(meta, batches);
      }),
      { numRuns: 150 },
    );
  });

  it("a cached Files row follows a clamp its chapter gains later (the entity itself is unchanged)", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "file_changed", path: "src/a.ts" });
    b.fact({ type: "git_hunk", file: "src/a.ts", added: 1, removed: 0, isFormattingOnly: false, isConfigOnly: false, isLockfile: false }, "fact_1");
    b.unit({ id: "u1", files: ["src/a.ts"], evidence: ["fact_1"] });
    const first = b.rows.length;
    b.jev({ id: "jev_1", changeUnitId: "u1", clamps: ["schema_floor"] });
    checkCommits(testMeta(), [b.rows.slice(0, first), b.rows.slice(first)]);
  });

  it("cached rows equal rows built from scratch after every commit (soak-shaped rows)", () => {
    const { meta, rows } = soakShapedRows({ units: 80, runs: 4, reemits: 2 });
    const batches = [];
    for (let start = 0; start < rows.length; start += 37) batches.push(rows.slice(start, start + 37));
    checkCommits(meta, batches);
  });
});
