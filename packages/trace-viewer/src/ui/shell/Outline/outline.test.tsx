// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTraceIndex } from "../../../layout/trace-index.js";
import { foldFixture, renderHarness, stubLayout, type LayoutStub } from "../../../test-support/ui-harness.js";
import { Outline } from "./Outline.js";

let layout: LayoutStub;
beforeEach(() => {
  layout = stubLayout({ height: 2_000, rowHeight: 28 });
});
afterEach(() => {
  cleanup();
  layout.restore();
});

describe("Outline", () => {
  it("selects a chapter row on click and marks it aria-selected", async () => {
    const session = foldFixture("oauth");
    const h = renderHarness(<Outline hiddenRows={2} />, session);
    await act(async () => undefined);
    const chapter = session.chapters.find((item) => item.current && !item.noise);
    const row = document.querySelector<HTMLElement>(`[data-key="${chapter?.id ?? ""}"]`);
    expect(row?.getAttribute("role")).toBe("treeitem");
    fireEvent.click(row as HTMLElement);
    expect(h.store.get().selection).toBe(chapter?.id);
    expect(document.querySelector(`[data-key="${chapter?.id ?? ""}"]`)?.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("2 pipeline rows hidden")).toBeTruthy();
  });

  it("marks the chapter under the playhead with aria-current", async () => {
    const session = foldFixture("oauth");
    const h = renderHarness(<Outline hiddenRows={0} />, session);
    const chapter = session.chapters.find((item) => item.current && !item.noise);
    const seq = session.steps.find((step) => step.id === chapter?.stepIds[0])?.firstSeq ?? 1;
    act(() => {
      h.store.dispatch({ type: "playhead/set", playhead: { kind: "free", seq }, origin: "program" });
    });
    await act(async () => undefined);
    const expected = buildTraceIndex(session).chapterAtSeq(seq)?.id;
    expect(document.querySelector(`[data-key="${expected ?? ""}"]`)?.getAttribute("aria-current")).toBe("true");
  });

  it("opens Evidence when a Files row is chosen", async () => {
    const session = foldFixture("oauth");
    const h = renderHarness(<Outline hiddenRows={0} />, session);
    await act(async () => undefined);
    const entity = session.entities[0];
    fireEvent.click(document.querySelector<HTMLElement>(`[data-key="${entity?.id ?? ""}"]`) as HTMLElement);
    expect(h.store.get().selection).toBe(entity?.stepIds.at(-1));
    expect(h.store.get().inspectorTab).toBe("evidence");
  });

  it("shows ✕ and the word failed on a failed command row", async () => {
    const session = foldFixture("oauth");
    renderHarness(<Outline hiddenRows={0} />, session);
    await act(async () => undefined);
    const testStep = session.steps.find((step) => step.command?.command === "pnpm test");
    const row = document.querySelector(`[data-key="cmd:${testStep?.id ?? ""}"]`);
    expect(row?.textContent).toContain("✕");
    expect(row?.textContent).toContain("failed");
  });

  it("marks search matches and hides nothing", async () => {
    const session = foldFixture("oauth");
    const h = renderHarness(<Outline hiddenRows={0} />, session);
    await act(async () => undefined);
    const before = screen.getAllByRole("treeitem").length;
    fireEvent.change(screen.getByRole("searchbox", { name: "Search steps" }), { target: { value: "pnpm test" } });
    await act(async () => undefined);
    expect(h.store.get().search?.matchIds.length ?? 0).toBeGreaterThan(0);
    expect(document.querySelectorAll("[data-match]").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("treeitem").length).toBe(before);
  });

  it("keeps exactly one row in the tab order", async () => {
    renderHarness(<Outline hiddenRows={0} />, foldFixture("oauth"));
    await act(async () => undefined);
    const tree = screen.getByRole("tree", { name: "Outline" });
    expect(tree.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  });
});
