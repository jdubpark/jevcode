import { describe, expect, it } from "vitest";

import {
  ActionRefSchema,
  CATALOG_ACTION_NAMES,
  CATALOG_COMPONENT_NAMES,
  JsonRenderSpecSchema,
  type ActionRef,
  type ChangeUnit,
  type UIIntent,
} from "@jevcode/contracts";

import { compileUI } from "./compile.js";
import type {
  ChangeUnitPayload,
  CompilePayload,
  DecisionPayload,
  FailurePayload,
  TimelinePayload,
  ValidationPayload,
} from "./payload.js";

const T0 = "2026-09-18T09:00:00.000Z";

function unit(overrides: Partial<ChangeUnit> = {}): ChangeUnit {
  return {
    id: "cu-1",
    sessionId: "sess-1",
    title: "Add rate limiting",
    category: "architecture",
    status: "in_progress",
    files: ["src/server/app.ts"],
    symbols: [],
    interfacesChanged: [],
    schemaChanges: [],
    dependencyChanges: [],
    relatedDecisions: [],
    validationResults: [],
    evidence: [],
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function intent(overrides: Partial<UIIntent> = {}): UIIntent {
  return {
    attention: "surface",
    subject: "architecture",
    representation: "summary",
    density: "normal",
    confidence: 0.9,
    showEvidence: true,
    showCode: true,
    secondaryViews: [],
    renderMode: "autonomous",
    ...overrides,
  };
}

function changeUnitPayload(
  overrides: Partial<ChangeUnitPayload> = {},
): ChangeUnitPayload {
  return {
    kind: "changeUnit",
    unit: unit(),
    ...overrides,
  };
}

const ACTION_ALLOWLIST = new Set<string>(CATALOG_ACTION_NAMES);
const COMPONENT_ALLOWLIST = new Set<string>(CATALOG_COMPONENT_NAMES);

describe("compileUI root mapping", () => {
  const table: Array<[UIIntent["representation"], string, CompilePayload]> = [
    [
      "summary",
      "ChangeOverview",
      changeUnitPayload(),
    ],
    [
      "before_after",
      "BehaviorDelta",
      changeUnitPayload({
        behavior: { subject: "s", before: "404", after: "200 null" },
      }),
    ],
    [
      "diff",
      "CodeDiff",
      changeUnitPayload({
        diff: { file: "src/a.ts", diff: "-x\n+y\n" },
      }),
    ],
    [
      "diagram",
      "ArchitectureDelta",
      changeUnitPayload({
        architecture: { nodes: [], edges: [] },
      }),
    ],
    [
      "table",
      "SchemaDelta",
      changeUnitPayload({
        schema: {
          title: "users",
          migration: "migrations/1.sql",
          changes: [],
        },
      }),
    ],
    [
      "table",
      "TestMatrix",
      changeUnitPayload({
        matrix: { rows: [] },
      }),
    ],
    [
      "graph",
      "DependencyDelta",
      changeUnitPayload({
        dependencies: { title: "deps", added: [], removed: [] },
      }),
    ],
    [
      "decision",
      "Decision",
      {
        kind: "decision",
        decision: {
          id: "d-1",
          sessionId: "sess-1",
          title: "Policy?",
          context: "c",
          severity: "required",
          options: [],
          affectedChangeUnits: [],
          evidence: [],
          status: "open",
        },
      } satisfies DecisionPayload,
    ],
    [
      "failure",
      "FailureAnalysis",
      {
        kind: "failure",
        failure: {
          title: "f",
          command: "pnpm test",
          runner: "vitest",
          exitCode: 1,
          failures: [],
          linkedChangeUnits: [],
        },
      } satisfies FailurePayload,
    ],
    [
      "timeline",
      "ExecutionTimeline",
      { kind: "timeline", events: [] } satisfies TimelinePayload,
    ],
  ];

  it.each(table)("%s -> %s", (representation, expectedType, payload) => {
    const subject =
      representation === "table" && expectedType === "SchemaDelta"
        ? "schema"
        : representation === "table"
          ? "tests"
          : "architecture";
    const spec = compileUI(intent({ representation, subject }), payload);
    expect(spec.root).toBe("root");
    expect(spec.elements["root"]?.type).toBe(expectedType);
  });

  it("table + schema subject chooses SchemaDelta", () => {
    const spec = compileUI(
      intent({ representation: "table", subject: "schema" }),
      changeUnitPayload({
        schema: { title: "t", migration: "m", changes: [] },
      }),
    );
    expect(spec.elements["root"]?.type).toBe("SchemaDelta");
  });

  it("table + tests subject chooses TestMatrix", () => {
    const spec = compileUI(
      intent({ representation: "table", subject: "tests" }),
      changeUnitPayload({ matrix: { rows: [] } }),
    );
    expect(spec.elements["root"]?.type).toBe("TestMatrix");
  });
});

describe("compileUI secondary views", () => {
  it("emits children in secondaryViews order, gated on payload data", () => {
    const spec = compileUI(
      intent({
        representation: "graph",
        secondaryViews: [
          "ChangeOverview",
          "CodeDiff",
          "ExecutionTimeline",
          "CodeDiff",
        ],
      }),
      changeUnitPayload({
        dependencies: { title: "d", added: [], removed: [] },
        diff: { file: "src/a.ts", diff: "x" },
      }),
    );
    expect(spec.elements["root"]?.children).toEqual(["overview", "diff"]);
    expect(spec.elements["overview"]?.type).toBe("ChangeOverview");
    expect(spec.elements["diff"]?.type).toBe("CodeDiff");
  });

  it("skips secondary views the payload cannot back", () => {
    const spec = compileUI(
      intent({
        representation: "summary",
        secondaryViews: [
          "SchemaDelta",
          "DependencyDelta",
          "ArchitectureDelta",
          "BehaviorDelta",
          "TestMatrix",
          "FailureAnalysis",
          "ExecutionTimeline",
          "Terminal",
          "Decision",
        ],
      }),
      changeUnitPayload(),
    );
    expect(spec.elements["root"]?.children).toEqual([]);
  });

  it("decision roots derive a ChangeOverview child from the related unit", () => {
    const decision: DecisionPayload = {
      kind: "decision",
      decision: {
        id: "d-1",
        sessionId: "sess-1",
        title: "Fail open?",
        context: "c",
        severity: "recommended",
        options: [],
        affectedChangeUnits: [],
        evidence: ["e-1"],
        status: "open",
      },
      relatedUnit: {
        unit: unit({ title: "Redis rate limiter" }),
        confidence: 0.89,
      },
    };
    const spec = compileUI(
      intent({ representation: "decision", secondaryViews: ["ArchitectureDelta"] }),
      decision,
    );
    expect(spec.elements["root"]?.children).toEqual(["overview"]);
    expect(spec.elements["overview"]?.props).toEqual({
      title: "Redis rate limiter",
      category: "architecture",
      status: "in_progress",
      confidence: 0.89,
    });
  });

  it("does not duplicate the derived overview when ChangeOverview is a secondary view", () => {
    const decision: DecisionPayload = {
      kind: "decision",
      decision: {
        id: "d-2",
        sessionId: "sess-1",
        title: "T",
        context: "c",
        severity: "optional",
        options: [],
        affectedChangeUnits: [],
        evidence: [],
        status: "open",
      },
      relatedUnit: { unit: unit() },
    };
    const spec = compileUI(
      intent({ representation: "decision", secondaryViews: ["ChangeOverview"] }),
      decision,
    );
    expect(spec.elements["root"]?.children).toEqual(["overview"]);
  });

  it("validation roots emit the overview and timeline secondary views", () => {
    const payload: ValidationPayload = {
      kind: "validation",
      matrix: { rows: [] },
      overview: {
        title: "All green",
        category: "tests",
        status: "validated",
      },
      timeline: { events: [{ id: "t-1", ts: T0, label: "tests" }] },
    };
    const spec = compileUI(
      intent({
        representation: "table",
        subject: "tests",
        secondaryViews: ["ExecutionTimeline", "ChangeOverview"],
      }),
      payload,
    );
    expect(spec.elements["root"]?.children).toEqual([
      "execution-timeline",
      "overview",
    ]);
  });
});

describe("compileUI bounds and guards", () => {
  it("caps decision option tradeoffs at two per option", () => {
    const decision: DecisionPayload = {
      kind: "decision",
      decision: {
        id: "d-3",
        sessionId: "sess-1",
        title: "T",
        context: "c",
        severity: "optional",
        options: [
          {
            id: "a",
            label: "A",
            description: "d",
            tradeoffs: [
              { dimension: "one", consequence: "1" },
              { dimension: "two", consequence: "2" },
              { dimension: "three", consequence: "3" },
            ],
          },
        ],
        affectedChangeUnits: [],
        evidence: [],
        status: "open",
      },
    };
    const spec = compileUI(intent({ representation: "decision" }), decision);
    const options = spec.elements["root"]?.props?.["options"] as {
      tradeoffs?: unknown[];
    }[];
    expect(options?.[0]?.tradeoffs).toHaveLength(2);
  });

  it("caps architecture nodes and edges at 50", () => {
    const nodes = Array.from({ length: 60 }, (_, i) => ({
      id: `n-${i}`,
      label: `N${i}`,
      kind: "module" as const,
    }));
    const spec = compileUI(
      intent({ representation: "diagram" }),
      changeUnitPayload({
        architecture: {
          nodes,
          edges: nodes.map((n) => ({ from: n.id, to: "n-0", label: "e" })),
        },
      }),
    );
    const props = spec.elements["root"]?.props;
    expect((props?.["nodes"] as unknown[]).length).toBe(50);
    expect((props?.["edges"] as unknown[]).length).toBe(50);
  });

  it("rejects unknown actions", () => {
    const payload = changeUnitPayload({
      actions: [
        {
          action: "format_hard_drive",
          params: {},
        } as unknown as ActionRef,
      ],
    });
    expect(() => compileUI(intent({ representation: "summary" }), payload)).toThrow(
      /format_hard_drive/,
    );
  });

  it("rejects unknown actions on validation payloads", () => {
    const payload: ValidationPayload = {
      kind: "validation",
      matrix: { rows: [{ name: "unit", status: "passed", passed: 1, failed: 0, skipped: 0 }] },
      actions: [
        {
          action: "format_hard_drive",
          params: {},
        } as unknown as ActionRef,
      ],
    };
    expect(() =>
      compileUI(intent({ representation: "table", subject: "tests" }), payload),
    ).toThrow(/format_hard_drive/);
  });

  it("emits schema-valid answer_decision params when no suggested answer is given", () => {
    const payload: DecisionPayload = {
      kind: "decision",
      decision: {
        id: "dec-1",
        sessionId: "sess-1",
        title: "Fail open?",
        context: "redis down",
        severity: "recommended",
        options: [{ id: "o1", label: "Fail open", description: "serve" }],
        affectedChangeUnits: [],
        evidence: [],
        status: "open",
      },
    };
    const compiled = compileUI(intent({ representation: "decision" }), payload);
    const rootProps = compiled.elements[compiled.root]?.props as
      | { actions?: ActionRef[] }
      | undefined;
    const answer = rootProps?.actions?.find(
      (action) => action.action === "answer_decision",
    );
    expect(answer).toBeDefined();
    expect(ActionRefSchema.safeParse(answer).success).toBe(true);
    if (answer !== undefined && answer.action === "answer_decision") {
      expect(answer.params.decision).toEqual({});
    }
  });

  it("rejects unknown secondary view components", () => {
    expect(() =>
      compileUI(
        intent({ representation: "summary", secondaryViews: ["Carousel"] }),
        changeUnitPayload(),
      ),
    ).toThrow(/Carousel/);
  });

  it("throws when the payload kind does not match the representation", () => {
    const payload: TimelinePayload = { kind: "timeline", events: [] };
    expect(() =>
      compileUI(intent({ representation: "decision" }), payload),
    ).toThrow(/expected a decision payload/);
    expect(() =>
      compileUI(intent({ representation: "timeline" }), payload),
    ).not.toThrow();
  });

  it("throws when required data is missing", () => {
    expect(() =>
      compileUI(intent({ representation: "before_after" }), changeUnitPayload()),
    ).toThrow(/behavior/);
    expect(() =>
      compileUI(intent({ representation: "diff" }), changeUnitPayload()),
    ).toThrow(/diff/);
  });
});

describe("compileUI determinism and catalog safety", () => {
  const allSecondary = [
    ...CATALOG_COMPONENT_NAMES,
  ] as UIIntent["secondaryViews"];

  const richPayload: ChangeUnitPayload = {
    kind: "changeUnit",
    unit: unit({
      files: ["src/a.ts"],
      symbols: [{ id: "s-1", name: "f", path: "src/a.ts", kind: "function" }],
    }),
    confidence: 0.8,
    overview: { evidenceLinks: ["src/a.ts"], diffs: [{ file: "src/a.ts", diff: "x" }] },
    behavior: { subject: "s", before: "b", after: "a" },
    architecture: {
      nodes: [{ id: "n-1", label: "N", kind: "module" }],
      edges: [{ from: "n-1", to: "n-1", label: "self" }],
      scope: "module",
      evidenceCount: 1,
    },
    schema: {
      title: "users",
      migration: "m.sql",
      changes: [{ entity: "users", entityType: "table", change: "added" }],
      compatibilityNote: "n",
    },
    dependencies: { title: "d", added: [], removed: [] },
    diff: { file: "src/a.ts", diff: "-x\n+y\n" },
    matrix: {
      title: "m",
      summary: "s",
      rows: [{ name: "unit", status: "passed", passed: 1, failed: 0, skipped: 0 }],
    },
    failure: {
      title: "f",
      command: "c",
      runner: "r",
      exitCode: 1,
      failures: [{ file: "src/a.ts", testName: "t", message: "m" }],
      linkedChangeUnits: ["cu-1"],
      note: "n",
    },
    timeline: { events: [{ id: "t-1", ts: T0, label: "l" }] },
    actions: [
      { action: "inspect_call_sites", params: { symbol: "f" } },
      { action: "pin_surface", params: { surfaceId: "s" } },
    ],
  };

  const representations: UIIntent["representation"][] = [
    "summary",
    "before_after",
    "diff",
    "diagram",
    "table",
    "graph",
    "decision",
    "failure",
    "timeline",
  ];

  it.each(representations)(
    "emits only catalog components and actions for %s",
    (representation) => {
      const payload: CompilePayload =
        representation === "decision"
          ? ({
              kind: "decision",
              decision: {
                id: "d-1",
                sessionId: "sess-1",
                title: "T",
                context: "c",
                severity: "required",
                options: [
                  {
                    id: "a",
                    label: "A",
                    description: "d",
                    tradeoffs: [{ dimension: "x", consequence: "y" }],
                  },
                ],
                affectedChangeUnits: [],
                evidence: ["e-1"],
                status: "open",
              },
              suggestedAnswer: { decision: { k: "a" } },
              relatedUnit: { unit: unit() },
            } satisfies DecisionPayload)
          : representation === "failure"
            ? ({
                kind: "failure",
                failure: richPayload.failure as FailurePayload["failure"],
                matrix: richPayload.matrix,
                diff: richPayload.diff,
                actions: richPayload.actions,
              } satisfies FailurePayload)
            : representation === "timeline"
              ? ({
                  kind: "timeline",
                  title: "t",
                  events: richPayload.timeline?.events ?? [],
                } satisfies TimelinePayload)
              : richPayload;

      const spec = compileUI(
        intent({ representation, secondaryViews: allSecondary }),
        payload,
      );
      expect(JsonRenderSpecSchema.safeParse(spec).success).toBe(true);
      for (const el of Object.values(spec.elements)) {
        expect(COMPONENT_ALLOWLIST.has(el.type), el.type).toBe(true);
        const actions = el.props?.["actions"] as { action: string }[] | undefined;
        for (const a of actions ?? []) {
          expect(ACTION_ALLOWLIST.has(a.action), a.action).toBe(true);
        }
      }
    },
  );

  it("is deterministic: identical inputs produce byte-identical output", () => {
    const first = compileUI(intent({ representation: "graph" }), richPayload);
    const second = compileUI(intent({ representation: "graph" }), richPayload);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("does not mutate its inputs", () => {
    const payload = richPayload;
    const frozen = JSON.parse(JSON.stringify(payload)) as typeof payload;
    Object.freeze(frozen.unit);
    Object.freeze(frozen.diff as object);
    const before = JSON.stringify(payload);
    compileUI(intent({ representation: "graph" }), payload);
    expect(JSON.stringify(payload)).toBe(before);
    void frozen;
  });
});
