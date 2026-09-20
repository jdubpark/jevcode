import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { JSONUIProvider, Renderer } from "@json-render/react";
import type { Spec } from "@json-render/core";

import type {
  ChangeOverviewProps,
  DecisionProps,
  FailureAnalysisProps,
  TestMatrixProps,
} from "@jevcode/contracts";

import { registry, setActionDispatcher } from "./index.js";
import { ChangeOverview } from "./components/ChangeOverview.js";
import { CodeDiff } from "./components/CodeDiff.js";
import { Decision } from "./components/Decision.js";
import { FailureAnalysis } from "./components/FailureAnalysis.js";
import { TestMatrix } from "./components/TestMatrix.js";

afterEach(() => {
  cleanup();
  setActionDispatcher(undefined);
});

describe("ChangeOverview", () => {
  const props: ChangeOverviewProps = {
    title: "OAuth identity layer",
    category: "security",
    status: "in_progress",
    confidence: 0.92,
    evidenceLinks: ["src/auth/service.ts", "migrations/001_create_identities.sql"],
    diffs: [{ file: "src/auth/service.ts", diff: "-old\n+new\n" }],
  };

  it("renders badges, confidence chip, and title", () => {
    render(<ChangeOverview props={props} />);
    expect(screen.getByTestId("change-overview")).toBeTruthy();
    expect(screen.getByText("security")).toBeTruthy();
    expect(screen.getByText("in_progress")).toBeTruthy();
    expect(screen.getByText("92%")).toBeTruthy();
    expect(screen.getByText("OAuth identity layer")).toBeTruthy();
  });

  it("drilldown expands CodeEvidence and then CodeDiff", () => {
    render(<ChangeOverview props={props} />);
    expect(screen.queryByTestId("code-evidence")).toBeNull();
    fireEvent.click(screen.getByTestId("evidence-toggle"));
    const evidence = screen.getByTestId("code-evidence");
    expect(evidence).toBeTruthy();
    expect(evidence.querySelectorAll("[data-evidence-link]")).toHaveLength(2);
    expect(screen.queryByTestId("code-diff")).toBeNull();
    fireEvent.click(screen.getByText("src/auth/service.ts"));
    const diff = screen.getByTestId("code-diff");
    expect(diff.getAttribute("data-file")).toBe("src/auth/service.ts");
    expect(diff.textContent).toContain("new");
  });

  it("keeps evidence links without diffs disabled", () => {
    render(<ChangeOverview props={props} />);
    fireEvent.click(screen.getByTestId("evidence-toggle"));
    const link = screen.getByText("migrations/001_create_identities.sql").closest("button");
    expect(link?.hasAttribute("disabled")).toBe(true);
  });

  it("summarizes non-inspectable evidence without exposing opaque ids", () => {
    render(
      <ChangeOverview
        props={{
          ...props,
          evidenceLinks: ["fact_opaque_1", "fact_opaque_2"],
          diffs: undefined,
        }}
      />,
    );
    expect(screen.queryByTestId("evidence-toggle")).toBeNull();
    expect(screen.getByText("Grounded in 2 evidence items")).toBeTruthy();
    expect(screen.queryByText("fact_opaque_1")).toBeNull();
  });
});

describe("Decision", () => {
  const props: DecisionProps = {
    decisionId: "dec-oauth-0001",
    title: "Account-linking policy for Google sign-in",
    severity: "required",
    context: "Existing users signing in through Google need a linking policy.",
    options: [
      {
        id: "match_email",
        label: "Match by email",
        description: "Link by verified Google email.",
        tradeoffs: [
          { dimension: "friction", consequence: "Lower friction." },
          { dimension: "security", consequence: "Weaker against takeover." },
        ],
      },
      {
        id: "explicit_link",
        label: "Require explicit linking",
        description: "Require email/password sign-in first.",
        tradeoffs: [{ dimension: "security", consequence: "Stronger." }],
      },
    ],
    actions: [
      {
        action: "answer_decision",
        params: {
          decisionId: "dec-oauth-0001",
          decision: { account_linking_policy: "explicit_link" },
          evidence: ["oauth_callback_change", "user_identity_schema_change"],
        },
      },
      { action: "delegate_decision", params: { decisionId: "dec-oauth-0001" } },
    ],
  };

  function renderDecision() {
    const calls: { action: string; params: Record<string, unknown> }[] = [];
    const handlers = {
      answer_decision: (params: Record<string, unknown>) => {
        calls.push({ action: "answer_decision", params });
      },
      delegate_decision: (params: Record<string, unknown>) => {
        calls.push({ action: "delegate_decision", params });
      },
    };
    render(
      <JSONUIProvider registry={registry} handlers={handlers}>
        <Decision props={props} />
      </JSONUIProvider>,
    );
    return calls;
  }

  it("renders options with tradeoffs tables", () => {
    renderDecision();
    expect(screen.getByText("Account-linking policy for Google sign-in")).toBeTruthy();
    expect(screen.getByText("friction")).toBeTruthy();
    expect(screen.getByText("Lower friction.")).toBeTruthy();
    const tradeoffs = screen.getByTestId("tradeoffs-match_email");
    expect(tradeoffs.querySelectorAll("tr")).toHaveLength(3);
  });

  it("emits answer_decision with the chosen option and suggested params", async () => {
    const calls = renderDecision();
    fireEvent.click(screen.getByTestId("choose-explicit_link"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      action: "answer_decision",
      params: {
        decisionId: "dec-oauth-0001",
        decision: { account_linking_policy: "explicit_link" },
        evidence: ["oauth_callback_change", "user_identity_schema_change"],
      },
    });
    expect(screen.getByTestId("choose-explicit_link").textContent).toBe("Selected");
    expect(
      screen.getByTestId("choose-explicit_link").getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("emits delegate_decision with the decision id", async () => {
    const calls = renderDecision();
    fireEvent.click(screen.getByTestId("delegate"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      action: "delegate_decision",
      params: { decisionId: "dec-oauth-0001" },
    });
  });
});

describe("TestMatrix", () => {
  const props: TestMatrixProps = {
    title: "Validation: rate limiting",
    summary: "143 tests passed, 0 failed",
    rows: [
      { name: "unit tests", status: "passed", passed: 128, failed: 0, skipped: 0 },
      { name: "integration tests", status: "passed", passed: 15, failed: 0, skipped: 0 },
      { name: "typecheck", status: "passed", passed: 1, failed: 0, skipped: 0 },
      { name: "lint", status: "skipped", passed: 0, failed: 0, skipped: 1 },
    ],
  };

  it("renders a row per validation kind with pass/fail counts", () => {
    render(<TestMatrix props={props} />);
    expect(screen.getByText("Validation: rate limiting")).toBeTruthy();
    expect(screen.getByText("143 tests passed, 0 failed")).toBeTruthy();
    const unitRow = document.querySelector('[data-row-name="unit tests"]');
    expect(unitRow?.getAttribute("data-status")).toBe("passed");
    expect(unitRow?.textContent).toContain("128");
    const lintRow = document.querySelector('[data-row-name="lint"]');
    expect(lintRow?.getAttribute("data-status")).toBe("skipped");
    expect(lintRow?.textContent).toContain("1");
  });

  it("renders provided actions", () => {
    render(
      <JSONUIProvider registry={registry} handlers={{}}>
        <TestMatrix
          props={{
            ...props,
            actions: [{ action: "continue_task", params: {} }],
          }}
        />
      </JSONUIProvider>,
    );
    expect(screen.getByTestId("action-buttons")).toBeTruthy();
    expect(
      document.querySelector('[data-action="continue_task"]'),
    ).toBeTruthy();
  });
});

describe("FailureAnalysis", () => {
  const props: FailureAnalysisProps = {
    title: "pnpm test failed: stale 404 expectation",
    command: "pnpm test",
    runner: "vitest",
    exitCode: 1,
    failures: [
      {
        file: "tests/users.test.ts",
        testName: "GET /users/:id > returns 404 when the user is missing",
        message: 'expected handleGetUser(999) to throw "user 999 not found"',
      },
    ],
    linkedChangeUnits: ["api-users-404-behavior"],
    note: "Test asserts the previous 404 contract.",
    actions: [
      { action: "accept_changes", params: { updateTest: "tests/users.test.ts" } },
    ],
  };

  it("links the failed test and change units as evidence", () => {
    render(
      <JSONUIProvider registry={registry} handlers={{}}>
        <FailureAnalysis props={props} />
      </JSONUIProvider>,
    );
    expect(screen.getByTestId("failure-analysis")).toBeTruthy();
    expect(screen.getByText("tests/users.test.ts")).toBeTruthy();
    expect(screen.getByTestId("linked-change-units").textContent).toContain(
      "api-users-404-behavior",
    );
    expect(screen.getByTestId("failure-note").textContent).toContain(
      "previous 404 contract",
    );
    expect(screen.getByText("exit 1")).toBeTruthy();
    expect(
      document.querySelector('[data-action="accept_changes"]'),
    ).toBeTruthy();
  });
});

describe("CodeDiff", () => {
  it("renders a headerless unified diff via diff2html", () => {
    const diff = [
      " export function handleGetUser(id: number): { status: number; body: unknown } {",
      "   const user = users.find((u) => u.id === id);",
      "-  if (!user) {",
      "-    throw new NotFoundError(`user ${id} not found`);",
      "+  return user",
      "+    ? { status: 200, body: { user } }",
      "+    : { status: 200, body: { user: null } };",
      " }",
      "",
    ].join("\n");
    render(<CodeDiff props={{ file: "src/routes/users.ts", diff }} />);
    const element = screen.getByTestId("code-diff");
    expect(element.getAttribute("data-file")).toBe("src/routes/users.ts");
    expect(element.textContent).toContain("NotFoundError");
    expect(element.textContent).toContain("body: { user: null }");
  });
});

describe("Renderer smoke", () => {
  it("renders a Decision spec with an overview child and dispatches actions", async () => {
    const calls: unknown[] = [];
    const spec: Spec = {
      root: "root",
      elements: {
        root: {
          type: "Decision",
          props: {
            decisionId: "dec-ratelimit-0001",
            title: "Redis unavailability policy",
            severity: "recommended",
            context: "What should happen when Redis is unavailable?",
            options: [
              { id: "fail_open", label: "Fail open", description: "Allow requests through." },
              { id: "fail_closed", label: "Fail closed", description: "Reject requests with 503." },
            ],
            actions: [
              {
                action: "answer_decision",
                params: {
                  decisionId: "dec-ratelimit-0001",
                  decision: { redis_failure_policy: "fail_open" },
                  evidence: ["se-ratelimit-0002"],
                },
              },
              { action: "delegate_decision", params: { decisionId: "dec-ratelimit-0001" } },
            ],
          },
          children: ["overview"],
        },
        overview: {
          type: "ChangeOverview",
          props: {
            title: "Redis-backed rate limiter",
            category: "architecture",
            status: "in_progress",
            confidence: 0.89,
          },
          children: [],
        },
      },
    };
    render(
      <JSONUIProvider
        registry={registry}
        handlers={{
          answer_decision: (params: Record<string, unknown>) => {
            calls.push({ action: "answer_decision", params });
          },
        }}
      >
        <Renderer spec={spec} registry={registry} />
      </JSONUIProvider>,
    );
    expect(screen.getByTestId("decision")).toBeTruthy();
    expect(screen.getByTestId("change-overview")).toBeTruthy();
    fireEvent.click(screen.getByTestId("choose-fail_open"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      action: "answer_decision",
      params: {
        decisionId: "dec-ratelimit-0001",
        decision: { redis_failure_policy: "fail_open" },
        evidence: ["se-ratelimit-0002"],
      },
    });
  });
});
