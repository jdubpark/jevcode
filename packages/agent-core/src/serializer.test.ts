import { describe, expect, it } from "vitest";

import { serializeStructuredDecision } from "./serializer.js";

describe("serializeStructuredDecision", () => {
  it("matches the PRD section 8 example exactly", () => {
    const serialized = serializeStructuredDecision({
      decisionId: "decision_1",
      decision: {
        account_linking_policy: "require_explicit_verification",
      },
      evidence: ["oauth_callback_change", "user_identity_schema_change"],
      instruction:
        "Continue implementation using explicit verification before linking\na Google identity to an existing password account.",
    });

    expect(serialized).toBe(
      [
        "decision:",
        "  account_linking_policy: require_explicit_verification",
        "",
        "evidence:",
        "  - oauth_callback_change",
        "  - user_identity_schema_change",
        "",
        "instruction:",
        "  Continue implementation using explicit verification before linking",
        "  a Google identity to an existing password account.",
        "",
      ].join("\n"),
    );
  });

  it("sorts decision keys for determinism", () => {
    const a = serializeStructuredDecision({
      decisionId: "d",
      decision: { b: "1", a: "2" },
      evidence: [],
      instruction: "",
    });
    const b = serializeStructuredDecision({
      decisionId: "d",
      decision: { a: "2", b: "1" },
      evidence: [],
      instruction: "",
    });
    expect(a).toBe(
      [
        "decision:",
        "  a: 2",
        "  b: 1",
        "",
        "declined: developer declined without further instruction",
        "",
      ].join("\n"),
    );
    expect(a).toBe(b);
  });

  it("omits empty sections and trims trailing instruction whitespace", () => {
    expect(
      serializeStructuredDecision({
        decisionId: "d",
        decision: {},
        evidence: [],
        instruction: "   \n",
      }),
    ).toBe("declined: developer declined without further instruction\n");
    expect(
      serializeStructuredDecision({
        decisionId: "d",
        decision: { key: "value" },
        evidence: ["e1"],
        instruction: "do the thing\n\ncarefully\n",
      }),
    ).toBe(
      [
        "decision:",
        "  key: value",
        "",
        "evidence:",
        "  - e1",
        "",
        "instruction:",
        "  do the thing",
        "",
        "  carefully",
        "",
      ].join("\n"),
    );
  });

  it("emits an explicit decline line when the instruction is absent", () => {
    expect(
      serializeStructuredDecision({
        decisionId: "d",
        decision: { policy: "fail_open" },
        evidence: ["rate_limit_design"],
      }),
    ).toBe(
      [
        "decision:",
        "  policy: fail_open",
        "",
        "evidence:",
        "  - rate_limit_design",
        "",
        "declined: developer declined without further instruction",
        "",
      ].join("\n"),
    );
  });

  it("round-trips through the contracts schema shape", () => {
    const input = {
      decisionId: "decision_2",
      decision: { policy: "fail_open" },
      evidence: ["rate_limit_design"],
      instruction: "Proceed with fail-open and add a circuit breaker.",
    };
    const serialized = serializeStructuredDecision(input);
    expect(serialized).toContain("decision:\n  policy: fail_open");
    expect(serialized).toContain("evidence:\n  - rate_limit_design");
    expect(serialized).toContain("instruction:\n  Proceed with fail-open");
  });
});
