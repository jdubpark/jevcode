import { describe, expect, it } from "vitest";

import { componentOf, overviewSnapshot } from "../test-support/overview-builder.js";
import { TraceBuilder, testMeta } from "../test-support/trace-builder.js";
import { CITATION_LABEL_MAX, resolveCitation } from "./citations.js";
import { foldRows } from "./fold.js";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (text: string): number => Array.from(segmenter.segment(text)).length;

function scenario() {
  const b = new TraceBuilder();
  b.agent({ type: "agent_started", prompt: "Add a limiter" });
  const message = b.agent({ type: "agent_message", role: "assistant", text: `Reading ${"a very long file name ".repeat(4)}now.` });
  const edit = b.agent({ type: "file_changed", path: "src/server/app.ts" });
  const decision = b.decision({ id: "d1", title: "Redis down: fail ‮open?" });
  b.overview(overviewSnapshot({ components: [{ rootPath: "src/server", files: ["src/server/app.ts"], name: "server" }] }));
  return { session: foldRows(testMeta(), b.rows, { live: false }), message, edit, decision };
}

describe("resolveCitation", () => {
  it("selects a cited step and clips its headline to the chip width", () => {
    const { session, message } = scenario();
    const target = resolveCitation(session, { kind: "step", id: `step:${message}` });
    expect(target.kind).toBe("select");
    expect(target.kind === "select" ? target.id : null).toBe(`step:${message}`);
    expect(graphemes(target.label)).toBeLessThanOrEqual(CITATION_LABEL_MAX);
    // The approved mockup clips a quoted step at its end ("Redis is a single…").
    expect(target.label.startsWith("Reading a very long")).toBe(true);
    expect(target.label.endsWith("…")).toBe(true);
  });

  it("selects a decision's step and shows its title with a visible bidi token", () => {
    const { session, decision } = scenario();
    const target = resolveCitation(session, { kind: "decision", id: "d1" });
    expect(target).toMatchObject({ kind: "select", id: `step:${decision}` });
    expect(target.full).toBe("Redis down: fail ⟨U+202E⟩open?");
    expect(target.label).not.toContain("‮");
  });

  it("selects the latest step of a cited file by its file name, and names a cited component", () => {
    const { session, edit } = scenario();
    expect(resolveCitation(session, { kind: "file", id: "src/server/app.ts" })).toMatchObject({
      kind: "select",
      id: `step:${edit}`,
      label: "app.ts",
      full: "src/server/app.ts",
    });
    expect(resolveCitation(session, { kind: "component", id: componentOf({ rootPath: "src/server" }).id })).toMatchObject({ kind: "component", label: "server" });
  });

  it.each([
    { kind: "step" as const, id: "step:999" },
    { kind: "step" as const, id: "12" },
    { kind: "decision" as const, id: "d9" },
    { kind: "file" as const, id: "src/missing.ts" },
    { kind: "component" as const, id: "cmp_000000000bad" },
    { kind: "fact" as const, id: "fact_1" },
  ])("leaves $kind $id unresolved", (citation) => {
    const target = resolveCitation(scenario().session, citation);
    expect(target.kind).toBe("none");
    expect(target.full).toMatch(/not in this trace$/);
  });
});
