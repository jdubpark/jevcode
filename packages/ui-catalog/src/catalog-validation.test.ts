import { describe, expect, it } from "vitest";

import {
  validateIncomingPatch,
  validateIncomingSpec,
} from "./catalog-validation.js";

const validSpec = {
  root: "root",
  elements: {
    root: {
      type: "ChangeOverview",
      props: { title: "A", category: "implementation", status: "detected" },
      children: [],
    },
    diff: {
      type: "CodeDiff",
      props: { file: "a.ts", diff: "+a" },
      children: [],
    },
  },
};

describe("validateIncomingSpec", () => {
  it("accepts a spec built only from catalog components", () => {
    const result = validateIncomingSpec(validSpec);
    expect(result.ok).toBe(true);
  });

  it("rejects a structurally invalid spec", () => {
    const result = validateIncomingSpec({ root: "root" });
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown component type from model output", () => {
    const result = validateIncomingSpec({
      root: "root",
      elements: {
        root: {
          type: "CreditCardForm",
          props: {},
          children: [],
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("CreditCardForm");
    }
  });
});

describe("validateIncomingPatch", () => {
  it("accepts a patch with catalog components", () => {
    const result = validateIncomingPatch({
      elements: {
        root: {
          type: "TestMatrix",
          props: { rows: [] },
          children: [],
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a patch with an unknown component type", () => {
    const result = validateIncomingPatch({
      elements: {
        x: { type: "EvilComponent", props: {}, children: [] },
      },
    });
    expect(result.ok).toBe(false);
  });
});
