import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JsonRenderSpec } from "@jevcode/contracts";

import {
  MIN_SURFACE_LIFETIME_MS,
  SurfaceManager,
} from "./SurfaceManager.js";

function specFor(label: string): JsonRenderSpec {
  return {
    root: "root",
    elements: {
      root: {
        type: "ChangeOverview",
        props: { title: label, category: "implementation", status: "detected" },
        children: [],
      },
    },
  };
}

function inputFor(id: string, label: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    spec: specFor(label),
    ...overrides,
  };
}

describe("SurfaceManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies the first surface immediately", () => {
    const manager = new SurfaceManager();
    const result = manager.propose(inputFor("changeunit:a", "A"));
    expect(result.status).toBe("applied");
    expect(manager.getPrimary()?.id).toBe("changeunit:a");
  });

  it("defers a replacement within the minimum surface lifetime", () => {
    const manager = new SurfaceManager();
    manager.propose(inputFor("changeunit:a", "A"));
    vi.advanceTimersByTime(3_000);
    const result = manager.propose(inputFor("changeunit:b", "B"));
    expect(result.status).toBe("deferred");
    if (result.status === "deferred") {
      expect(result.pendingAt).toBe(MIN_SURFACE_LIFETIME_MS);
    }
    expect(manager.getPrimary()?.id).toBe("changeunit:a");
    expect(manager.getGenerative()).toHaveLength(1);
  });

  it("applies the deferred replacement once the minimum lifetime expires", () => {
    const manager = new SurfaceManager();
    manager.propose(inputFor("changeunit:a", "A"));
    vi.advanceTimersByTime(3_000);
    manager.propose(inputFor("changeunit:b", "B"));
    expect(manager.flushDue()).toBeNull();
    expect(manager.getPrimary()?.id).toBe("changeunit:a");
    vi.advanceTimersByTime(5_001);
    const applied = manager.flushDue();
    expect(applied?.status).toBe("applied");
    expect(manager.getPrimary()?.id).toBe("changeunit:b");
    expect(manager.getGenerative().map((s) => s.id)).toEqual(["changeunit:b"]);
  });

  it("holds a replacement while the pointer is inside the workspace", () => {
    const manager = new SurfaceManager();
    manager.propose(inputFor("changeunit:a", "A"));
    vi.advanceTimersByTime(20_000);
    manager.setPointerInside(true);
    const result = manager.propose(inputFor("changeunit:b", "B"));
    expect(result.status).toBe("deferred");
    if (result.status === "deferred") {
      expect(result.pendingAt).toBeNull();
    }
    expect(manager.flushDue()).toBeNull();
    expect(manager.getPrimary()?.id).toBe("changeunit:a");
    manager.setPointerInside(false);
    expect(manager.getPrimary()?.id).toBe("changeunit:b");
  });

  it("holds a replacement within 2s of the last interaction", () => {
    const manager = new SurfaceManager();
    manager.propose(inputFor("changeunit:a", "A"));
    vi.advanceTimersByTime(20_000);
    manager.notifyInteraction();
    vi.advanceTimersByTime(1_000);
    const result = manager.propose(inputFor("changeunit:b", "B"));
    expect(result.status).toBe("deferred");
    expect(manager.flushDue()).toBeNull();
    vi.advanceTimersByTime(1_001);
    const applied = manager.flushDue();
    expect(applied?.status).toBe("applied");
    expect(manager.getPrimary()?.id).toBe("changeunit:b");
  });

  it("never evicts a pinned surface", () => {
    const manager = new SurfaceManager();
    manager.propose(inputFor("changeunit:a", "A"));
    manager.pin("changeunit:a");
    vi.advanceTimersByTime(20_000);
    const result = manager.propose(inputFor("changeunit:b", "B"));
    expect(result.status).toBe("applied");
    expect(manager.getGenerative().map((s) => s.id)).toEqual([
      "changeunit:b",
      "changeunit:a",
    ]);
    expect(manager.getGenerative()[1]?.pinned).toBe(true);
  });

  it("unpinning releases a queued replacement", () => {
    const manager = new SurfaceManager();
    manager.propose(inputFor("changeunit:a", "A"));
    manager.pin("changeunit:a");
    vi.advanceTimersByTime(20_000);
    manager.propose(inputFor("changeunit:b", "B"));
    expect(manager.getGenerative().map((s) => s.id)).toEqual([
      "changeunit:b",
      "changeunit:a",
    ]);
    vi.advanceTimersByTime(1_000);
    const result = manager.propose(inputFor("changeunit:c", "C"));
    expect(result.status).toBe("deferred");
    expect(manager.getGenerative().map((s) => s.id)).toEqual([
      "changeunit:b",
      "changeunit:a",
    ]);
    manager.unpin("changeunit:a");
    expect(manager.getGenerative().map((s) => s.id)).toEqual([
      "changeunit:c",
      "changeunit:b",
    ]);
  });

  it("applies a low-importance update as a patch, not a swap", () => {
    const manager = new SurfaceManager();
    manager.propose(inputFor("changeunit:a", "A", { importance: 0.9 }));
    vi.advanceTimersByTime(2_000);
    const createdAtBefore = manager.getPrimary()?.createdAt ?? 0;
    const updated = {
      root: "root",
      elements: {
        root: {
          type: "ChangeOverview",
          props: {
            title: "A refined",
            category: "security",
            status: "in_progress",
          },
          children: [],
        },
        extra: {
          type: "CodeDiff",
          props: { file: "f.ts", diff: "+x" },
          children: [],
        },
      },
    };
    const result = manager.propose(
      inputFor("changeunit:a", "ignored", {
        importance: 0.2,
        spec: updated,
      }),
    );
    expect(result.status).toBe("patched");
    const primary = manager.getPrimary();
    expect(primary?.spec.root).toBe("root");
    expect(primary?.spec.elements["root"]?.props?.title).toBe("A refined");
    expect(primary?.spec.elements["extra"]?.type).toBe("CodeDiff");
    expect(primary?.createdAt).toBe(createdAtBefore);
  });

  it("applies a patch that replaces the root id when provided", () => {
    const manager = new SurfaceManager();
    manager.propose(inputFor("changeunit:a", "A", { importance: 0.9 }));
    vi.advanceTimersByTime(2_000);
    const result = manager.propose(
      inputFor("changeunit:a", "ignored", {
        importance: 0.1,
        spec: {
          root: "new-root",
          elements: {
            "new-root": {
              type: "TestMatrix",
              props: { rows: [] },
              children: [],
            },
          },
        },
      }),
    );
    expect(result.status).toBe("patched");
    expect(manager.getPrimary()?.spec.root).toBe("new-root");
    expect(manager.getPrimary()?.spec.elements["new-root"]?.type).toBe(
      "TestMatrix",
    );
    expect(manager.getPrimary()?.spec.elements["root"]?.type).toBe(
      "ChangeOverview",
    );
  });

  it("swaps a high-importance update of the same surface id", () => {
    const manager = new SurfaceManager();
    manager.propose(inputFor("changeunit:a", "A", { importance: 0.9 }));
    vi.advanceTimersByTime(2_000);
    const result = manager.propose(
      inputFor("changeunit:a", "ignored", {
        importance: 0.9,
        spec: specFor("A v2"),
      }),
    );
    expect(result.status).toBe("applied");
    expect(manager.getPrimary()?.spec.elements["root"]?.props?.title).toBe(
      "A v2",
    );
  });

  it("defers a same-id swap while the surface is pinned and applies it after unpin", () => {
    const manager = new SurfaceManager();
    manager.propose(inputFor("changeunit:a", "A", { importance: 0.9 }));
    manager.pin("changeunit:a");
    const result = manager.propose(
      inputFor("changeunit:a", "ignored", {
        importance: 0.9,
        spec: specFor("A v2"),
      }),
    );
    expect(result.status).toBe("deferred");
    expect(manager.getPrimary()?.spec.elements["root"]?.props?.title).toBe("A");
    manager.unpin("changeunit:a");
    expect(manager.getPrimary()?.spec.elements["root"]?.props?.title).toBe(
      "A v2",
    );
  });

  it("defers a same-id swap while the pointer is inside and applies on leave", () => {
    const manager = new SurfaceManager();
    manager.propose(inputFor("changeunit:a", "A", { importance: 0.9 }));
    manager.setPointerInside(true);
    const result = manager.propose(
      inputFor("changeunit:a", "ignored", {
        importance: 0.9,
        spec: specFor("A v2"),
      }),
    );
    expect(result.status).toBe("deferred");
    expect(manager.getPrimary()?.spec.elements["root"]?.props?.title).toBe("A");
    manager.setPointerInside(false);
    expect(manager.getPrimary()?.spec.elements["root"]?.props?.title).toBe(
      "A v2",
    );
  });

  it("defers a same-id swap within the interaction lock and flushes after expiry", () => {
    const manager = new SurfaceManager();
    manager.propose(inputFor("changeunit:a", "A", { importance: 0.9 }));
    manager.notifyInteraction();
    vi.advanceTimersByTime(1_000);
    const result = manager.propose(
      inputFor("changeunit:a", "ignored", {
        importance: 0.9,
        spec: specFor("A v2"),
      }),
    );
    expect(result.status).toBe("deferred");
    expect(manager.getPending()?.input.id).toBe("changeunit:a");
    expect(manager.getPrimary()?.spec.elements["root"]?.props?.title).toBe("A");
    vi.advanceTimersByTime(1_001);
    const applied = manager.flushDue();
    expect(applied?.status).toBe("applied");
    expect(manager.getPrimary()?.spec.elements["root"]?.props?.title).toBe(
      "A v2",
    );
  });

  it("keeps a low-importance same-id update as a patch even while pinned", () => {
    const manager = new SurfaceManager();
    manager.propose(inputFor("changeunit:a", "A", { importance: 0.9 }));
    manager.pin("changeunit:a");
    const result = manager.propose(
      inputFor("changeunit:a", "ignored", {
        importance: 0.1,
        spec: specFor("A refined"),
      }),
    );
    expect(result.status).toBe("patched");
    expect(manager.getPrimary()?.spec.elements["root"]?.props?.title).toBe(
      "A refined",
    );
    expect(manager.getPrimary()?.pinned).toBe(true);
  });

  it("accumulates patches without deleting elements (v0 patch semantics)", () => {
    const manager = new SurfaceManager();
    const first = {
      root: "root",
      elements: {
        root: {
          type: "ChangeOverview",
          props: { title: "A", category: "implementation", status: "detected" },
          children: [],
        },
        extra: {
          type: "CodeDiff",
          props: { file: "a.ts", diff: "+a" },
          children: [],
        },
      },
    };
    manager.propose(inputFor("changeunit:a", "ignored", { importance: 0.9, spec: first }));
    manager.applyPatch("changeunit:a", {
      elements: {
        root: {
          type: "ChangeOverview",
          props: { title: "A v2", category: "implementation", status: "detected" },
          children: [],
        },
      },
    });
    // The `extra` element from the original spec survives the patch: patch
    // elements merge by id and no deletion is expressed in v0.
    const merged = manager.getPrimary()?.spec;
    expect(merged?.elements["root"]?.props?.title).toBe("A v2");
    expect(merged?.elements["extra"]?.type).toBe("CodeDiff");
  });

  it("preserves expansion state keyed by surface id across patches and swaps", () => {
    const manager = new SurfaceManager();
    manager.propose(inputFor("changeunit:a", "A", { importance: 0.9 }));
    manager.setExpansionState("changeunit:a", "evidence", true);
    manager.setExpansionState("changeunit:a", "timeline", false);
    vi.advanceTimersByTime(2_000);
    manager.propose(
      inputFor("changeunit:a", "ignored", {
        importance: 0.1,
        spec: specFor("A patched"),
      }),
    );
    expect(manager.getExpansionState("changeunit:a")).toEqual({
      evidence: true,
      timeline: false,
    });
    vi.advanceTimersByTime(2_000);
    manager.propose(
      inputFor("changeunit:a", "ignored", {
        importance: 0.9,
        spec: specFor("A swapped"),
      }),
    );
    expect(manager.getExpansionState("changeunit:a")).toEqual({
      evidence: true,
      timeline: false,
    });
    expect(manager.getExpansionState("other")).toEqual({});
  });

  it("preserves scroll position keyed by surface id", () => {
    const manager = new SurfaceManager();
    manager.propose(inputFor("changeunit:a", "A", { importance: 0.9 }));
    manager.setScrollPosition("changeunit:a", 412);
    vi.advanceTimersByTime(2_000);
    manager.propose(
      inputFor("changeunit:a", "ignored", {
        importance: 0.9,
        spec: specFor("A v2"),
      }),
    );
    expect(manager.getScrollPosition("changeunit:a")).toBe(412);
    expect(manager.getScrollPosition("changeunit:b")).toBeUndefined();
  });

  it("never auto-hides user-opened raw views", () => {
    const manager = new SurfaceManager();
    manager.propose(
      inputFor("raw:diff:1", "diff", { slot: "raw", userOpened: true }),
    );
    manager.propose(
      inputFor("terminal", "terminal", { slot: "terminal" }),
    );
    vi.advanceTimersByTime(20_000);
    manager.propose(inputFor("changeunit:a", "A"));
    vi.advanceTimersByTime(20_000);
    manager.propose(inputFor("changeunit:b", "B"));
    vi.advanceTimersByTime(20_000);
    manager.propose(inputFor("changeunit:c", "C"));
    const rawIds = manager.getRaws().map((s) => s.id);
    expect(rawIds).toEqual(["raw:diff:1", "terminal"]);
    expect(manager.getGenerative().map((s) => s.id)).toEqual([
      "changeunit:c",
    ]);
  });

  it("updates the terminal surface in place instead of duplicating it", () => {
    const manager = new SurfaceManager();
    manager.propose(inputFor("terminal", "terminal", { slot: "terminal" }));
    manager.propose(
      inputFor("terminal", "terminal v2", { slot: "terminal" }),
    );
    expect(manager.getRaws()).toHaveLength(1);
    expect(manager.getRaws()[0]?.spec.elements["root"]?.props?.title).toBe(
      "terminal v2",
    );
  });

  it("keeps only the latest deferred surface in the queue", () => {
    const manager = new SurfaceManager();
    manager.propose(inputFor("changeunit:a", "A"));
    vi.advanceTimersByTime(1_000);
    manager.propose(inputFor("changeunit:b", "B"));
    manager.propose(inputFor("changeunit:c", "C"));
    expect(manager.getPending()?.input.id).toBe("changeunit:c");
    vi.advanceTimersByTime(7_001);
    const applied = manager.flushDue();
    expect(applied?.status).toBe("applied");
    expect(manager.getPrimary()?.id).toBe("changeunit:c");
  });

  it("promotes a pending surface once the blocking surface's lifetime passes", () => {
    const manager = new SurfaceManager();
    manager.propose(inputFor("changeunit:a", "A"));
    manager.pin("changeunit:a");
    vi.advanceTimersByTime(20_000);
    manager.propose(inputFor("changeunit:b", "B"));
    vi.advanceTimersByTime(1_000);
    const result = manager.propose(inputFor("changeunit:c", "C"));
    expect(result.status).toBe("deferred");
    manager.dismiss("changeunit:a");
    expect(manager.getGenerative().map((s) => s.id)).toEqual([
      "changeunit:b",
    ]);
    vi.advanceTimersByTime(7_001);
    const applied = manager.flushDue();
    expect(applied?.status).toBe("applied");
    expect(manager.getGenerative().map((s) => s.id)).toEqual([
      "changeunit:c",
    ]);
  });

  it("rejects patches for unknown surface ids", () => {
    const manager = new SurfaceManager();
    const patch = { elements: { x: { type: "CodeDiff", props: {}, children: [] } } };
    expect(manager.applyPatch("changeunit:missing", patch)).toBe(false);
    manager.propose(inputFor("changeunit:a", "A"));
    expect(manager.applyPatch("changeunit:a", patch)).toBe(true);
    expect(manager.getPrimary()?.spec.elements["x"]?.type).toBe("CodeDiff");
  });

  it("notifies subscribers on every surface mutation", () => {
    const manager = new SurfaceManager();
    const seen: number[] = [];
    manager.subscribe(() => {
      seen.push(manager.getVersion());
    });
    manager.propose(inputFor("changeunit:a", "A"));
    manager.pin("changeunit:a");
    manager.setExpansionState("changeunit:a", "e", true);
    manager.notifyInteraction();
    manager.setPointerInside(true);
    expect(seen).toEqual([1, 2]);
    expect(manager.getVersion()).toBe(2);
  });
});
