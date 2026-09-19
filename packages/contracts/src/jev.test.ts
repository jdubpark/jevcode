import { describe, expect, it } from "vitest";

import {
  AttentionDecisionSchema,
  JevDecisionLogSchema,
  JevResultSchema,
  UIIntentSchema,
  type JevResult,
} from "./jev.js";

const baseAttention = {
  semanticCategory: "implementation_change" as const,
  scope: "local" as const,
  humanDecision: "none" as const,
  needsSystem2: false,
  confidence: 0.9,
  probabilities: {
    behavior_change: 0.05,
    implementation_change: 0.9,
    configuration: 0.05,
  },
};

describe("AttentionDecisionSchema", () => {
  it("parses the PRD section 14 formatting example", () => {
    const result = AttentionDecisionSchema.safeParse({
      shouldSurface: false,
      importance: 0.02,
      relevance: 0.03,
      interruption: 0.001,
      mentalModelChange: 0.05,
      ...baseAttention,
    });
    expect(result.success).toBe(true);
  });

  it("parses the PRD section 34 formatting example", () => {
    const result = AttentionDecisionSchema.safeParse({
      shouldSurface: false,
      importance: 0.02,
      relevance: 0.01,
      interruption: 0.0,
      mentalModelChange: 0.05,
      ...baseAttention,
    });
    expect(result.success).toBe(true);
  });

  it("parses the PRD section 14 database migration example", () => {
    const result = AttentionDecisionSchema.safeParse({
      shouldSurface: true,
      importance: 0.96,
      relevance: 0.88,
      interruption: 0.1,
      mentalModelChange: 0.7,
      semanticCategory: "schema_change",
      scope: "subsystem",
      humanDecision: "recommended",
      needsSystem2: false,
      confidence: 0.93,
      probabilities: { schema_change: 0.9, api_change: 0.05, other: 0.05 },
    });
    expect(result.success).toBe(true);
  });

  it("parses the PRD section 14 destructive data decision example", () => {
    const result = AttentionDecisionSchema.safeParse({
      shouldSurface: true,
      importance: 0.99,
      relevance: 0.99,
      interruption: 0.98,
      mentalModelChange: 0.8,
      semanticCategory: "schema_change",
      scope: "repository",
      humanDecision: "required",
      needsSystem2: false,
      confidence: 0.97,
      probabilities: { schema_change: 0.95, failure: 0.05 },
    });
    expect(result.success).toBe(true);
  });

  it("parses the PRD section 17 fail-open decision example", () => {
    const result = AttentionDecisionSchema.safeParse({
      shouldSurface: true,
      importance: 0.98,
      relevance: 0.99,
      interruption: 0.95,
      mentalModelChange: 0.6,
      semanticCategory: "decision_candidate",
      scope: "subsystem",
      humanDecision: "required",
      needsSystem2: true,
      confidence: 0.92,
      probabilities: { decision_candidate: 0.8, behavior_change: 0.15, other: 0.05 },
    });
    expect(result.success).toBe(true);
  });

  it("rejects out-of-range scores", () => {
    expect(
      AttentionDecisionSchema.safeParse({ ...baseAttention, shouldSurface: false, importance: 1.5, relevance: 0.1, interruption: 0.1, mentalModelChange: 0.1 }).success,
    ).toBe(false);
    expect(
      AttentionDecisionSchema.safeParse({ ...baseAttention, shouldSurface: false, importance: 0.1, relevance: 0.1, interruption: -0.2, mentalModelChange: 0.1 }).success,
    ).toBe(false);
    expect(
      AttentionDecisionSchema.safeParse({ ...baseAttention, shouldSurface: false, importance: 0.1, relevance: 0.1, interruption: 0.1, mentalModelChange: 0.1, confidence: 2 }).success,
    ).toBe(false);
  });

  it("rejects invalid enums", () => {
    expect(
      AttentionDecisionSchema.safeParse({ ...baseAttention, shouldSurface: false, importance: 0.1, relevance: 0.1, interruption: 0.1, mentalModelChange: 0.1, humanDecision: "mandatory" }).success,
    ).toBe(false);
    expect(
      AttentionDecisionSchema.safeParse({ ...baseAttention, shouldSurface: false, importance: 0.1, relevance: 0.1, interruption: 0.1, mentalModelChange: 0.1, scope: "global" }).success,
    ).toBe(false);
  });

  it("rejects probabilities outside 0..1", () => {
    expect(
      AttentionDecisionSchema.safeParse({
        ...baseAttention,
        shouldSurface: false,
        importance: 0.1,
        relevance: 0.1,
        interruption: 0.1,
        mentalModelChange: 0.1,
        probabilities: { x: 1.5 },
      }).success,
    ).toBe(false);
  });
});

describe("UIIntentSchema", () => {
  it("parses the PRD section 15 projection with conservative render", () => {
    const result = UIIntentSchema.safeParse({
      attention: "surface",
      subject: "schema",
      representation: "before_after",
      density: "normal",
      confidence: 0.88,
      showEvidence: true,
      showCode: true,
      secondaryViews: ["CodeDiff"],
      renderMode: "conservative",
    });
    expect(result.success).toBe(true);
  });

  it("parses the PRD section 16 strong autonomous render", () => {
    const result = UIIntentSchema.safeParse({
      attention: "surface",
      subject: "dependency",
      representation: "graph",
      density: "detailed",
      confidence: 0.96,
      showEvidence: true,
      showCode: false,
      secondaryViews: ["DependencyDelta"],
      renderMode: "autonomous",
    });
    expect(result.success).toBe(true);
  });

  it("parses an interrupt projection", () => {
    const result = UIIntentSchema.safeParse({
      attention: "interrupt",
      subject: "decision",
      representation: "decision",
      density: "detailed",
      confidence: 0.92,
      showEvidence: true,
      showCode: false,
      secondaryViews: [],
      renderMode: "autonomous",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid enums", () => {
    expect(
      UIIntentSchema.safeParse({
        attention: "urgent",
        subject: "code",
        representation: "summary",
        density: "normal",
        confidence: 0.9,
        showEvidence: true,
        showCode: false,
        secondaryViews: [],
        renderMode: "autonomous",
      }).success,
    ).toBe(false);
    expect(
      UIIntentSchema.safeParse({
        attention: "surface",
        subject: "code",
        representation: "carousel",
        density: "normal",
        confidence: 0.9,
        showEvidence: true,
        showCode: false,
        secondaryViews: [],
        renderMode: "autonomous",
      }).success,
    ).toBe(false);
    expect(
      UIIntentSchema.safeParse({
        attention: "surface",
        subject: "code",
        representation: "summary",
        density: "normal",
        confidence: 0.9,
        showEvidence: true,
        showCode: false,
        secondaryViews: [],
        renderMode: "fancy",
      }).success,
    ).toBe(false);
  });

  it("rejects confidence outside 0..1", () => {
    expect(
      UIIntentSchema.safeParse({
        attention: "surface",
        subject: "code",
        representation: "summary",
        density: "normal",
        confidence: 1.2,
        showEvidence: true,
        showCode: false,
        secondaryViews: [],
        renderMode: "autonomous",
      }).success,
    ).toBe(false);
  });
});

describe("JevDecisionLogSchema", () => {
  const baseLog = {
    id: "jev_1",
    sessionId: "sess_1",
    changeUnitId: "cu_1",
    inputHash: "abc",
    output: { shouldSurface: true },
    confidence: 0.9,
    latencyMs: 12,
    clientKind: "degrade",
    clamps: [],
    ts: "2026-09-19T10:00:00.000Z",
  };

  it("parses a valid log with bounded probabilities", () => {
    const result = JevDecisionLogSchema.safeParse({
      ...baseLog,
      probabilities: { schema_change: 0.9, failure: 0.1 },
    });
    expect(result.success).toBe(true);
  });

  it("rejects probabilities outside 0..1", () => {
    expect(
      JevDecisionLogSchema.safeParse({
        ...baseLog,
        probabilities: { schema_change: 1.4 },
      }).success,
    ).toBe(false);
    expect(
      JevDecisionLogSchema.safeParse({
        ...baseLog,
        probabilities: { schema_change: -0.2 },
      }).success,
    ).toBe(false);
  });
});

describe("JevResultSchema", () => {
  const uiIntent = {
    attention: "surface",
    subject: "schema",
    representation: "before_after",
    density: "normal",
    confidence: 0.88,
    showEvidence: true,
    showCode: true,
    secondaryViews: ["CodeDiff"],
    renderMode: "conservative",
  };

  it("parses a JevResult wrapper with probabilities and client kind", () => {
    const result = JevResultSchema.safeParse({
      value: uiIntent,
      confidence: 0.88,
      probabilities: { schema_diff: 0.88, before_after: 0.07, code_diff: 0.04, other: 0.01 },
      clientKind: "typesafe",
    });
    expect(result.success).toBe(true);
  });

  it("parses a degrade-mode result flagged heuristic", () => {
    const result = JevResultSchema.safeParse({
      value: uiIntent,
      confidence: 0.6,
      clientKind: "degrade",
      heuristic: true,
    });
    expect(result.success).toBe(true);
  });

  it("supports typed JevResult<T> construction", () => {
    const jev: JevResult<typeof uiIntent> = {
      value: uiIntent,
      confidence: 0.6,
      clientKind: "degrade",
      heuristic: true,
    };
    expect(jev.value.representation).toBe("before_after");
  });
});
