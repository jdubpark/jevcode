import { describe, expect, it } from "vitest";

import type { DecisionOption } from "@jevcode/contracts";

import { foldRows, type TraceSession } from "../model/index.js";
import { sentence } from "../test-support/explainer-fixtures.js";
import { componentOf, overviewSnapshot, type ComponentSeed } from "../test-support/overview-builder.js";
import { TraceBuilder, testMeta } from "../test-support/trace-builder.js";
import { buildBrief } from "./brief.js";
import { BRIEF_DECISIONS_MAX, buildBriefDecisions, decisionComponents } from "./brief-decisions.js";
import { buildTraceIndex } from "./trace-index.js";

const MIDDLEWARE_SEED: ComponentSeed = { rootPath: "src/middleware", files: ["src/middleware/rate-limiter.ts"], name: "middleware" };
const SERVER_SEED: ComponentSeed = { rootPath: "src/server", files: ["src/server/app.ts"], name: "server" };
const MIDDLEWARE = componentOf(MIDDLEWARE_SEED);
const OPTIONS: DecisionOption[] = [
  { id: "open", label: "Fail open", description: "", tradeoffs: [{ dimension: "availability", consequence: "API stays up." }] },
  { id: "closed", label: "Fail closed", description: "" },
];
const WHY = sentence("Failing open keeps the API up.", { kind: "decision", id: "d1" });
const STORY = sentence("The agent added the limiter.", { kind: "component", id: MIDDLEWARE.id });

function scenario(options: { story?: boolean } = {}): TraceSession {
  const b = new TraceBuilder();
  b.agent({ type: "agent_started", prompt: "Add a limiter" });
  b.agent({ type: "file_changed", path: "src/middleware/rate-limiter.ts" });
  b.unit({ id: "u1", files: ["src/middleware/rate-limiter.ts"] });
  b.overview(overviewSnapshot({ components: [MIDDLEWARE_SEED, SERVER_SEED] }));
  b.decision({ id: "d0", status: "answered", answer: { decisionId: "d0", decision: { q: "a" }, evidence: [] } });
  b.decision({ id: "d1", status: "open", affectedChangeUnits: ["u1"], options: OPTIONS });
  b.decision({ id: "d1", status: "answered", affectedChangeUnits: ["u1"], options: OPTIONS, answer: { decisionId: "d1", decision: { policy: "open" }, evidence: [] } });
  b.decision({ id: "d2", status: "open", title: "Log level?" });
  b.explainer({ kind: "decision_why", decisionId: "d1", sentence: WHY });
  if (options.story === true) b.explainer({ kind: "story", sentences: [STORY], basisSeq: b.rows.length });
  return foldRows(testMeta(), b.rows, { live: true });
}

describe("buildBriefDecisions", () => {
  it("lists open decisions, then the latest answered one with its why, tradeoffs and components", () => {
    const cards = buildBriefDecisions(scenario());
    expect(cards.map((card) => [card.decisionId, card.status])).toEqual([["d2", "open"], ["d1", "answered"]]);
    const answered = cards[1];
    expect(cards.map((card) => card.components.length)).toEqual([0, 1]);
    expect(answered?.why).toEqual(WHY);
    expect(answered?.decidedBy).toBe("supervisor");
    expect(answered?.options).toEqual([
      { id: "open", label: "Fail open", chosen: true, tradeoffs: [{ dimension: "availability", consequence: "API stays up." }] },
      { id: "closed", label: "Fail closed", chosen: false, tradeoffs: [] },
    ]);
    expect(answered?.components).toEqual([{ id: MIDDLEWARE.id, name: "middleware" }]);
    expect(cards[0]?.why).toBeNull();
    expect(cards[0]?.components).toEqual([]);
  });

  it("shows at most three cards", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Go" });
    for (let i = 0; i < 5; i += 1) b.decision({ id: `d${i}`, status: "open" });
    expect(buildBriefDecisions(foldRows(testMeta(), b.rows, { live: true }))).toHaveLength(BRIEF_DECISIONS_MAX);
  });

  it("finds no components without an overview", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Go" });
    b.unit({ id: "u1", files: ["src/a.ts"] });
    b.decision({ id: "d1", status: "open", affectedChangeUnits: ["u1"] });
    expect(decisionComponents(foldRows(testMeta(), b.rows, { live: true }), "d1")).toEqual([]);
  });
});

describe("buildBrief with explainer rows", () => {
  it("uses the story for Now and carries the decision cards", () => {
    const session = scenario({ story: true });
    const brief = buildBrief(session, buildTraceIndex(session));
    expect(brief.now).toEqual({ kind: "story", sentences: [STORY], basisSeq: session.explainer.story?.basisSeq, provenance: "model" });
    expect(brief.decisions).toBe(buildBriefDecisions(session));
  });

  it("keeps the rule-based Now without a story", () => {
    const session = scenario();
    expect(buildBrief(session, buildTraceIndex(session)).now.kind).toBe("rule");
  });
});
