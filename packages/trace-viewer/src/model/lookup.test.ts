import { describe, expect, it } from "vitest";

import { FIXTURE_NAMES, loadFixtureTrace } from "../test-support/fixture-rows.js";
import { TraceBuilder, testMeta } from "../test-support/trace-builder.js";
import { foldRows } from "./fold.js";
import { resolveStableId } from "./lookup.js";
import type { StableId } from "./types.js";

describe("resolveStableId", () => {
  it.each(FIXTURE_NAMES)("resolves every id in a folded %s session", (name) => {
    const trace = loadFixtureTrace(name);
    const session = foldRows(trace.meta, trace.rows, { live: false });
    const ids: StableId[] = [
      ...session.steps.map((step) => step.id),
      ...session.chapters.map((chapter) => chapter.id),
      ...session.entities.map((entity) => entity.id),
      ...session.findings.map((finding) => finding.id),
    ];
    for (const id of ids) expect(resolveStableId(session, id), id).not.toBeNull();
  });

  it("resolves decision:<id> to its one step after a status change", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const first = b.decision({ id: "dec-oauth-0001" });
    b.decision({ id: "dec-oauth-0001", status: "answered", answer: { decisionId: "dec-oauth-0001", decision: { x: "a" }, evidence: [] } });
    const session = foldRows(testMeta(), b.rows, { live: false });
    const resolved = resolveStableId(session, "decision:dec-oauth-0001");
    expect(resolved?.kind).toBe("decision");
    expect(resolved?.kind === "decision" ? resolved.step.id : null).toBe(`step:${first}`);
    expect(resolved?.kind === "decision" ? resolved.step.decision?.status : null).toBe("answered");
  });

  it("returns null for unknown or malformed ids", () => {
    const session = foldRows(testMeta(), [], { live: false });
    expect(resolveStableId(session, "step:99")).toBeNull();
    expect(resolveStableId(session, "file:nope.ts")).toBeNull();
    expect(resolveStableId(session, "chapter:1" as StableId)).toBeNull();
  });
});
