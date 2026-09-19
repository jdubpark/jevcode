import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import type { JsonRenderSpec } from "@jevcode/contracts";

import { SurfaceManager } from "./SurfaceManager.js";
import { useSurfaceManager } from "./useSurfaceManager.js";

function specFor(title: string): JsonRenderSpec {
  return {
    root: "root",
    elements: {
      root: {
        type: "ChangeOverview",
        props: { title, category: "implementation", status: "detected" },
        children: [],
      },
    },
  };
}

describe("useSurfaceManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-renders when a surface is proposed", () => {
    const manager = new SurfaceManager();
    const { result } = renderHook(() => useSurfaceManager(manager));
    expect(result.current.primary).toBeNull();
    act(() => {
      result.current.propose({ id: "changeunit:a", spec: specFor("A") });
    });
    expect(result.current.primary?.id).toBe("changeunit:a");
    expect(result.current.generative).toHaveLength(1);
  });

  it("auto-flushes a deferred replacement when the lifetime timer fires", () => {
    const manager = new SurfaceManager();
    const { result } = renderHook(() => useSurfaceManager(manager));
    act(() => {
      result.current.propose({ id: "changeunit:a", spec: specFor("A") });
    });
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    act(() => {
      const outcome = result.current.propose({
        id: "changeunit:b",
        spec: specFor("B"),
      });
      expect(outcome.status).toBe("deferred");
    });
    expect(result.current.primary?.id).toBe("changeunit:a");
    act(() => {
      vi.advanceTimersByTime(7_001);
    });
    expect(result.current.primary?.id).toBe("changeunit:b");
  });

  it("exposes pinning and expansion state through the hook", () => {
    const manager = new SurfaceManager();
    const { result } = renderHook(() => useSurfaceManager(manager));
    act(() => {
      result.current.propose({ id: "changeunit:a", spec: specFor("A") });
      result.current.pin("changeunit:a");
      result.current.setExpansionState("changeunit:a", "evidence", true);
      result.current.setScrollPosition("changeunit:a", 42);
    });
    expect(result.current.primary?.pinned).toBe(true);
    expect(result.current.getExpansionState("changeunit:a")).toEqual({
      evidence: true,
    });
    expect(result.current.getScrollPosition("changeunit:a")).toBe(42);
  });

  it("applies specs, defers replacements under the interaction lock, expires min lifetime, and protects pinned surfaces", () => {
    const manager = new SurfaceManager();
    const { result } = renderHook(() => useSurfaceManager(manager));

    // Spec apply: the first proposal renders immediately.
    act(() => {
      const outcome = result.current.propose({
        id: "changeunit:a",
        spec: specFor("A"),
      });
      expect(outcome.status).toBe("applied");
      result.current.setExpansionState("changeunit:a", "evidence", true);
    });
    expect(result.current.primary?.id).toBe("changeunit:a");

    // Interaction lock: pointer inside the workspace defers a replacement.
    act(() => {
      result.current.setPointerInside(true);
      const outcome = result.current.propose({
        id: "changeunit:b",
        spec: specFor("B"),
      });
      expect(outcome.status).toBe("deferred");
    });
    expect(result.current.primary?.id).toBe("changeunit:a");
    expect(result.current.pendingSurface?.input.id).toBe("changeunit:b");

    // Min lifetime expiry: leaving the pointer does not flush early.
    act(() => {
      vi.advanceTimersByTime(1_000);
      result.current.setPointerInside(false);
    });
    expect(result.current.primary?.id).toBe("changeunit:a");

    // After the minimum lifetime the deferred replacement is applied by the
    // hook's timer.
    act(() => {
      vi.advanceTimersByTime(7_001);
    });
    expect(result.current.primary?.id).toBe("changeunit:b");

    // Pin protection: a pinned surface is never evicted; the new proposal
    // is added alongside it.
    act(() => {
      result.current.pin("changeunit:b");
      result.current.setExpansionState("changeunit:b", "evidence", true);
      const outcome = result.current.propose({
        id: "changeunit:c",
        spec: specFor("C"),
      });
      expect(outcome.status).toBe("applied");
    });
    expect(result.current.generative.map((s) => s.id)).toEqual([
      "changeunit:c",
      "changeunit:b",
    ]);
    expect(result.current.generative[1]?.pinned).toBe(true);

    // Expansion state is preserved across patches keyed by surface id.
    act(() => {
      result.current.applyPatch("changeunit:b", {
        elements: {
          root: {
            type: "ChangeOverview",
            props: {
              title: "B refined",
              category: "implementation",
              status: "detected",
            },
            children: [],
          },
        },
      });
    });
    expect(result.current.getExpansionState("changeunit:b")).toEqual({
      evidence: true,
    });
  });
});
