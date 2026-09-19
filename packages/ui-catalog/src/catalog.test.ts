import { describe, expect, it } from "vitest";

import {
  CATALOG_ACTION_NAMES,
  CATALOG_COMPONENT_NAMES,
} from "@jevcode/contracts";

import {
  dispatchCatalogAction,
  handlers,
  jevcodeCatalog,
  setActionDispatcher,
} from "./index.js";

const VALID_SPEC = {
  root: "root",
  elements: {
    root: {
      type: "Decision",
      props: {
        decisionId: "dec-1",
        title: "Fail open?",
        severity: "required",
        context: "Redis is down.",
        options: [
          {
            id: "fail_open",
            label: "Fail open",
            description: "Allow requests through.",
          },
        ],
        actions: [
          {
            action: "answer_decision",
            params: {
              decisionId: "dec-1",
              decision: { policy: "fail_open" },
              evidence: ["e-1"],
            },
          },
        ],
      },
      children: [],
    },
  },
};

describe("jevcodeCatalog", () => {
  it("declares exactly the 11 SPEC 9.2 components", () => {
    expect([...jevcodeCatalog.componentNames].sort()).toEqual(
      [...CATALOG_COMPONENT_NAMES].sort(),
    );
  });

  it("declares exactly the 12 SPEC 9.2 actions", () => {
    expect([...jevcodeCatalog.actionNames].sort()).toEqual(
      [...CATALOG_ACTION_NAMES].sort(),
    );
  });

  it("accepts a valid spec against the catalog", () => {
    expect(jevcodeCatalog.validate(VALID_SPEC).success).toBe(true);
  });

  it("rejects a structurally invalid spec", () => {
    expect(jevcodeCatalog.validate({}).success).toBe(false);
    expect(jevcodeCatalog.validate(null).success).toBe(false);
    expect(
      jevcodeCatalog.validate({ root: 42, elements: {} }).success,
    ).toBe(false);
  });

  it("generates a JSON schema for structured outputs", () => {
    expect(jevcodeCatalog.jsonSchema()).toBeTruthy();
  });
});

describe("action dispatch plumbing", () => {
  it("dispatches registered actions to the configured dispatcher", async () => {
    const received: { action: string; params: Record<string, unknown> }[] = [];
    setActionDispatcher(async (action, params) => {
      received.push({ action, params });
    });
    const actionHandlers = handlers(
      () => () => undefined,
      () => ({}),
    );
    const answerHandler = actionHandlers["answer_decision"];
    expect(answerHandler).toBeDefined();
    await answerHandler?.({
      decisionId: "dec-1",
      decision: { policy: "fail_open" },
      evidence: ["e-1"],
    });
    expect(received).toEqual([
      {
        action: "answer_decision",
        params: {
          decisionId: "dec-1",
          decision: { policy: "fail_open" },
          evidence: ["e-1"],
        },
      },
    ]);
  });

  it("rejects when no dispatcher is configured", async () => {
    setActionDispatcher(undefined);
    await expect(
      dispatchCatalogAction("open_terminal", {}),
    ).rejects.toThrow(/No action dispatcher registered/);
  });
});
