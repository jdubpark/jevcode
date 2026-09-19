import type { JsonRenderSpec, SkeletonInput } from "@jevcode/contracts";

export const SKELETON_ROOT_ID = "root";

export function compileSkeleton(input: SkeletonInput): JsonRenderSpec {
  return {
    root: SKELETON_ROOT_ID,
    elements: {
      [SKELETON_ROOT_ID]: {
        type: "ChangeOverview",
        props: {
          title: input.title,
          category: input.category ?? "implementation",
          status: "detected",
        },
        children: [],
      },
    },
  };
}
