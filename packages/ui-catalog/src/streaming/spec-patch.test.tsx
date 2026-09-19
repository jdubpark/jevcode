import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import type { JsonRenderSpec } from "@jevcode/contracts";

import { mergeSpecPatch, specToPatch } from "./spec-patch.js";
import { useSpecPatchStream } from "./useSpecPatchStream.js";

function baseSpec(): JsonRenderSpec {
  return {
    root: "root",
    elements: {
      root: {
        type: "BehaviorDelta",
        props: {
          title: "GET /users/:id behavior",
          subject: "missing_user_response",
          before: "404",
          after: "200 null",
          symbols: ["handleGetUser"],
          files: ["src/routes/users.ts"],
        },
        children: ["diff"],
      },
      diff: {
        type: "CodeDiff",
        props: { file: "src/routes/users.ts", diff: "-x\n+y\n" },
        children: [],
      },
    },
  };
}

describe("mergeSpecPatch", () => {
  it("keeps the existing root when the patch has none", () => {
    const merged = mergeSpecPatch(baseSpec(), {
      elements: {
        extra: { type: "TestMatrix", props: { rows: [] }, children: [] },
      },
    });
    expect(merged.root).toBe("root");
    expect(merged.elements["extra"]?.type).toBe("TestMatrix");
  });

  it("replaces the root id when provided", () => {
    const merged = mergeSpecPatch(baseSpec(), {
      root: "overview",
      elements: {},
    });
    expect(merged.root).toBe("overview");
    expect(merged.elements["root"]?.type).toBe("BehaviorDelta");
  });

  it("upserts elements: adds new ids and replaces existing ids", () => {
    const merged = mergeSpecPatch(baseSpec(), {
      elements: {
        diff: {
          type: "CodeDiff",
          props: { file: "src/routes/users.ts", diff: "+z\n" },
          children: [],
        },
        terminal: { type: "Terminal", props: { lines: [] }, children: [] },
      },
    });
    expect(merged.elements["diff"]?.props?.diff).toBe("+z\n");
    expect(merged.elements["terminal"]?.type).toBe("Terminal");
  });

  it("leaves elements untouched when the patch has no elements", () => {
    const merged = mergeSpecPatch(baseSpec(), {
      root: "root",
      elements: {},
    });
    expect(merged.elements).toEqual(baseSpec().elements);
  });

  it("does not mutate the input spec", () => {
    const original = baseSpec();
    const snapshot = JSON.stringify(original);
    mergeSpecPatch(original, {
      root: "other",
      elements: {
        other: { type: "Terminal", props: {}, children: [] },
      },
    });
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});

describe("specToPatch", () => {
  it("emits all next elements and only a changed root", () => {
    const current = baseSpec();
    const next: JsonRenderSpec = {
      root: "new-root",
      elements: {
        "new-root": { type: "Terminal", props: {}, children: [] },
      },
    };
    const patch = specToPatch(current, next);
    expect(patch.root).toBe("new-root");
    expect(patch.elements).toEqual(next.elements);
  });

  it("omits the root when it is unchanged", () => {
    const current = baseSpec();
    const next: JsonRenderSpec = {
      root: "root",
      elements: {
        root: {
          type: "BehaviorDelta",
          props: { title: "updated" },
          children: [],
        },
      },
    };
    const patch = specToPatch(current, next);
    expect(patch).not.toHaveProperty("root");
    expect(patch.elements["root"]?.props?.title).toBe("updated");
  });
});

describe("useSpecPatchStream (Phase C)", () => {
  it("starts from the initial spec", () => {
    const initial = baseSpec();
    const { result } = renderHook(() => useSpecPatchStream(initial));
    expect(result.current.spec).toEqual(initial);
  });

  it("merges ui:specPatch payloads into the current spec", () => {
    const { result } = renderHook(() => useSpecPatchStream(baseSpec()));
    act(() => {
      result.current.applyPatchPayload({
        elements: {
          status: {
            type: "TestMatrix",
            props: { rows: [{ name: "unit", status: "passed", passed: 1, failed: 0, skipped: 0 }] },
            children: [],
          },
        },
      });
    });
    expect(result.current.spec.root).toBe("root");
    expect(result.current.spec.elements["status"]?.type).toBe("TestMatrix");
    expect(result.current.spec.elements["root"]?.type).toBe("BehaviorDelta");
  });

  it("applies streamed RFC 6902 patch lines to the current spec", () => {
    const { result } = renderHook(() => useSpecPatchStream(baseSpec()));
    let patches: unknown[] = [];
    act(() => {
      patches = result.current.pushStreamChunk(
        '{"op":"replace","path":"/elements/root/props/after","value":"200 { user: null }"}\n',
      );
    });
    expect(patches).toHaveLength(1);
    expect(result.current.spec.elements["root"]?.props?.after).toBe(
      "200 { user: null }",
    );
  });

  it("streams on top of a merged patch payload base", () => {
    const { result } = renderHook(() => useSpecPatchStream(baseSpec()));
    act(() => {
      result.current.applyPatchPayload({
        root: "overview",
        elements: {
          overview: {
            type: "ChangeOverview",
            props: { title: "t", category: "api", status: "detected" },
            children: [],
          },
        },
      });
    });
    act(() => {
      result.current.pushStreamChunk(
        '{"op":"replace","path":"/elements/overview/props/status","value":"validated"}\n',
      );
    });
    expect(result.current.spec.root).toBe("overview");
    expect(result.current.spec.elements["overview"]?.props?.status).toBe(
      "validated",
    );
    expect(result.current.spec.elements["root"]?.type).toBe("BehaviorDelta");
  });

  it("ignores non-patch chunks and reports no new patches", () => {
    const { result } = renderHook(() => useSpecPatchStream(baseSpec()));
    let patches: unknown[] = [];
    act(() => {
      patches = result.current.pushStreamChunk("plain text line\nnot json at all\n");
    });
    expect(patches).toHaveLength(0);
    expect(result.current.spec).toEqual(baseSpec());
  });

  it("does not mutate the initial spec passed by the caller", () => {
    const initial = baseSpec();
    const snapshot = JSON.stringify(initial);
    const { result } = renderHook(() => useSpecPatchStream(initial));
    act(() => {
      result.current.pushStreamChunk(
        '{"op":"replace","path":"/elements/root/props/after","value":"changed"}\n',
      );
    });
    expect(JSON.stringify(initial)).toBe(snapshot);
  });
});
