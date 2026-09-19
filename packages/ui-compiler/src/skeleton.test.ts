import { describe, expect, it } from "vitest";

import {
  ChangeOverviewPropsSchema,
  JsonRenderSpecSchema,
  SkeletonInputSchema,
} from "@jevcode/contracts";

import { compileSkeleton, SKELETON_ROOT_ID } from "./skeleton.js";

describe("compileSkeleton (Phase A)", () => {
  const input = {
    surfaceId: "changeunit:cu-1",
    title: "Changed 2 files: src/auth/service.ts, src/auth/google.ts",
    category: "security" as const,
    evidenceCount: 4,
  };

  it("emits a minimal ChangeOverview skeleton with placeholder status", () => {
    const spec = compileSkeleton(input);
    expect(spec.root).toBe(SKELETON_ROOT_ID);
    expect(Object.keys(spec.elements)).toEqual([SKELETON_ROOT_ID]);
    const root = spec.elements[SKELETON_ROOT_ID];
    expect(root?.type).toBe("ChangeOverview");
    expect(root?.props).toEqual({
      title: input.title,
      category: "security",
      status: "detected",
    });
    expect(root?.children).toEqual([]);
  });

  it("contains no model-derived fields (no confidence, scope, or evidence)", () => {
    const spec = compileSkeleton(input);
    const props = spec.elements[SKELETON_ROOT_ID]?.props ?? {};
    expect(props).not.toHaveProperty("confidence");
    expect(props).not.toHaveProperty("scope");
    expect(props).not.toHaveProperty("evidenceLinks");
  });

  it("defaults the category to implementation when evidence gives none", () => {
    const spec = compileSkeleton({
      surfaceId: "changeunit:cu-2",
      title: "Changed 1 file: src/index.ts",
    });
    expect(spec.elements[SKELETON_ROOT_ID]?.props?.category).toBe(
      "implementation",
    );
  });

  it("is deterministic for the same input", () => {
    const first = compileSkeleton(input);
    const second = compileSkeleton(input);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("validates against the catalog prop schema and the json-render spec schema", () => {
    const spec = compileSkeleton(input);
    expect(JsonRenderSpecSchema.safeParse(spec).success).toBe(true);
    const props = spec.elements[SKELETON_ROOT_ID]?.props ?? {};
    expect(ChangeOverviewPropsSchema.safeParse(props).success).toBe(true);
  });

  it("accepts only valid skeleton inputs", () => {
    expect(SkeletonInputSchema.safeParse(input).success).toBe(true);
    expect(SkeletonInputSchema.safeParse({ surfaceId: "x" }).success).toBe(
      false,
    );
    expect(
      SkeletonInputSchema.safeParse({ surfaceId: "", title: "t" }).success,
    ).toBe(false);
  });

  it("is cheap enough for the 100ms Phase A budget", () => {
    const started = performance.now();
    for (let i = 0; i < 1000; i += 1) {
      compileSkeleton({ ...input, surfaceId: `changeunit:cu-${i}` });
    }
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(500);
  });
});
