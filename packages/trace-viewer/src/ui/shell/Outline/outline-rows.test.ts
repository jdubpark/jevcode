import { describe, expect, it } from "vitest";

import { buildSearchIndex, describeGraphic, foldRows, formatOffset, pickGraphic } from "../../../model/index.js";
import { TraceBuilder, testMeta } from "../../../test-support/trace-builder.js";
import { foldFixture } from "../../../test-support/ui-harness.js";
import {
  buildOutlineRows,
  DEFAULT_OPEN_SECTIONS,
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
    expect(story.every((row) => row.graphic === null)).toBe(true);
  });

  it("sanitizes a hostile decision title and keeps it in a mono slot", () => {
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
    expect(fork?.mono).toBe(true);
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
    expect(row?.title).toBe("src/evil\u27E8U+202E\u27E9gnp.ts");
    expect(row?.title).not.toContain("\u202E");
  });
});
