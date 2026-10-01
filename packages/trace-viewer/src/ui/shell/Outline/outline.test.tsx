// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTraceIndex } from "../../../layout/trace-index.js";
import {
  createHarness,
  foldFixture,
  renderHarness,
  stubLayout,
  type LayoutStub,
} from "../../../test-support/ui-harness.js";
import { SessionContext } from "../session-context.js";
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

  it("keeps a Files row's full path in its tooltip and accessible name", async () => {
    const session = foldFixture("oauth");
    renderHarness(<Outline hiddenRows={0} />, session);
    await act(async () => undefined);
    const entity = session.entities.find((item) => item.path === "migrations/001_create_identities.sql");
    const row = document.querySelector<HTMLElement>(`[data-key="${entity?.id ?? ""}"]`);
    expect(row?.getAttribute("aria-label")?.startsWith("migrations/001_create_identities.sql")).toBe(true);
    expect(row?.querySelector("[title]")?.getAttribute("title")).toBe("migrations/001_create_identities.sql");
  });

  it("marks the decision row selected when its folded chapter is selected elsewhere", async () => {
    const session = foldFixture("oauth");
    const decision = session.steps.find((step) => step.kind === "decision");
    const born = session.chapters.find((chapter) => chapter.decisionIds.length > 0);
    const h = renderHarness(<Outline hiddenRows={0} />, session);
    await act(async () => undefined);
    act(() => {
      h.store.dispatch({ type: "select", id: born?.id ?? null, by: "hybrid" });
    });
    const row = document.querySelector(`[data-key="story:${decision?.id ?? ""}"]`);
    expect(row?.getAttribute("aria-selected")).toBe("true");
    // A search hit on the folded chapter marks the row that now stands for it.
    act(() => {
      h.store.dispatch({ type: "search/set", query: "x", matchIds: [born?.id ?? "unit:none"] });
    });
    expect(document.querySelector(`[data-key="story:${decision?.id ?? ""}"]`)?.hasAttribute("data-match")).toBe(true);
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
  it("announces each row's position in the flat tree", async () => {
    renderHarness(<Outline hiddenRows={0} />, foldFixture("oauth"));
    await act(async () => undefined);
    const items = screen.getAllByRole("treeitem");
    expect(items.length).toBeGreaterThan(3);
    const total = items[0]?.getAttribute("aria-setsize");
    expect(Number(total)).toBeGreaterThanOrEqual(items.length);
    expect(items.map((item) => item.getAttribute("aria-posinset"))).toEqual(
      items.map((item) => String(Number(item.getAttribute("data-index")) + 1)),
    );
    expect(new Set(items.map((item) => item.getAttribute("aria-setsize"))).size).toBe(1);
  });

  it("moves the roving row with ArrowDown, ArrowUp, End and Home", async () => {
    renderHarness(<Outline hiddenRows={0} />, foldFixture("oauth"));
    await act(async () => undefined);
    const tree = screen.getByRole("tree", { name: "Outline" });
    const keys = (): string[] => Array.from(tree.querySelectorAll<HTMLElement>("[data-key]")).map((el) => el.dataset.key ?? "");
    const all = keys();
    const press = async (key: string): Promise<void> => {
      fireEvent.keyDown(document.activeElement as HTMLElement, { key });
      await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    };
    const active = (): string | undefined => (document.activeElement as HTMLElement | null)?.dataset.key;
    await act(async () => (tree.querySelector<HTMLElement>('[tabindex="0"]') as HTMLElement).focus());
    const start = all.indexOf(active() ?? "");
    expect(start).toBeGreaterThanOrEqual(0);
    await press("ArrowDown");
    expect(active()).toBe(all[start + 1]);
    await press("ArrowUp");
    expect(active()).toBe(all[start]);
    await press("End");
    expect(active()).toBe(all.at(-1));
    expect(tree.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    await press("Home");
    expect(active()).toBe(all[0]);
  });

  it("keeps the tab-stop row mounted after it scrolls far out of range", async () => {
    layout.restore();
    layout = stubLayout({ height: 100, rowHeight: 28 });
    renderHarness(<Outline hiddenRows={0} />, foldFixture("oauth"));
    await act(async () => undefined);
    const tree = screen.getByRole("tree", { name: "Outline" });
    const tab = tree.querySelector<HTMLElement>('[tabindex="0"]');
    const tabKey = tab?.dataset.key;
    expect(tabKey).toBeDefined();
    await act(async () => tab?.focus());
    await act(async () => {
      tree.scrollTop = 100_000;
      fireEvent.scroll(tree);
    });
    const mounted = Array.from(tree.querySelectorAll<HTMLElement>("[data-key]"));
    expect(mounted.some((el) => Number(el.dataset.index) >= 10)).toBe(true);
    const stops = tree.querySelectorAll<HTMLElement>('[tabindex="0"]');
    expect(stops).toHaveLength(1);
    expect(stops[0]?.dataset.key).toBe(tabKey);
  });

  it("does not move focus when the rows are rebuilt by a Live poll", async () => {
    const session = foldFixture("oauth");
    const h = createHarness(session);
    const view = (next: typeof session) => (
      h.wrap(
        <SessionContext.Provider value={{ ...h.view, session: next }}>
          <Outline hiddenRows={0} />
          <button type="button">outside</button>
        </SessionContext.Provider>,
      )
    );
    const result = render(view(session));
    await act(async () => undefined);
    const tree = screen.getByRole("tree", { name: "Outline" });
    await act(async () => tree.querySelectorAll<HTMLElement>("[data-key]")[2]?.focus());
    const search = screen.getByRole("searchbox", { name: "Search steps" });
    await act(async () => search.focus());
    expect(document.activeElement).toBe(search);
    result.rerender(view({ ...session }));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(document.activeElement).toBe(search);
    await act(async () => screen.getByRole("button", { name: "outside" }).focus());
    result.rerender(view({ ...session }));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "outside" }));
  });
  it("marks exactly one row selected when several rows share a step", async () => {
    const session = foldFixture("oauth");
    const h = renderHarness(<Outline hiddenRows={0} />, session);
    await act(async () => undefined);
    const testStep = session.steps.find((step) => step.tests !== undefined);
    expect(testStep).toBeDefined();
    const key = `test:${testStep?.id ?? ""}`;
    fireEvent.click(document.querySelector<HTMLElement>('[data-key="section:tests"]') as HTMLElement);
    await act(async () => undefined);
    fireEvent.click(document.querySelector<HTMLElement>(`[data-key="${key}"]`) as HTMLElement);
    expect(h.store.get().selection).toBe(testStep?.id);
    const selected = Array.from(document.querySelectorAll('[aria-selected="true"]')).map((el) => el.getAttribute("data-key"));
    expect(selected).toEqual([key]);
    // The same step also has a Commands row: it is not selected.
    expect(document.querySelector(`[data-key="cmd:${testStep?.id ?? ""}"]`)?.getAttribute("aria-selected")).toBe("false");
  });

  it("expands a Files section past 12 rows with Show n more", async () => {
    const base = foldFixture("oauth");
    const seed = base.entities[0];
    if (seed === undefined) throw new Error("fixture has no entity");
    const extra = Array.from({ length: 15 }, (_, n) => ({ ...seed, id: `entity:extra-${n}` as typeof seed.id, path: `src/extra/f${n}.ts`, label: `src/extra/f${n}.ts` }));
    const session = { ...base, entities: [...base.entities, ...extra] };
    renderHarness(<Outline hiddenRows={0} />, session);
    await act(async () => undefined);
    const filesCount = (): number => document.querySelectorAll('[data-key^="entity:"]').length;
    const more = document.querySelector<HTMLElement>('[data-key="more:files"]');
    expect(more?.textContent).toBe(`Show ${base.entities.filter((e) => e.stepIds.length > 0).length + 15 - 12} more`);
    const before = filesCount();
    fireEvent.click(more as HTMLElement);
    await act(async () => undefined);
    expect(document.querySelector('[data-key="more:files"]')).toBeNull();
    expect(filesCount()).toBeGreaterThan(before);
  });

  describe("section keys", () => {
    const focusSection = async (name: string): Promise<HTMLElement> => {
      const row = document.querySelector<HTMLElement>(`[data-key="section:${name}"]`) as HTMLElement;
      await act(async () => row.focus());
      return row;
    };
    const expanded = (name: string): string | null =>
      document.querySelector(`[data-key="section:${name}"]`)?.getAttribute("aria-expanded") ?? null;

    it("ArrowLeft closes an open section and ArrowRight reopens it", async () => {
      renderHarness(<Outline hiddenRows={0} />, foldFixture("oauth"));
      await act(async () => undefined);
      const row = await focusSection("commands");
      expect(expanded("commands")).toBe("true");
      fireEvent.keyDown(row, { key: "ArrowLeft" });
      expect(expanded("commands")).toBe("false");
      fireEvent.keyDown(row, { key: "ArrowLeft" });
      expect(expanded("commands")).toBe("false");
      fireEvent.keyDown(row, { key: "ArrowRight" });
      expect(expanded("commands")).toBe("true");
      fireEvent.keyDown(row, { key: "ArrowRight" });
      expect(expanded("commands")).toBe("true");
    });

    it("Enter toggles the section", async () => {
      renderHarness(<Outline hiddenRows={0} />, foldFixture("oauth"));
      await act(async () => undefined);
      const row = await focusSection("tests");
      expect(expanded("tests")).toBe("false");
      fireEvent.keyDown(row, { key: "Enter" });
      expect(expanded("tests")).toBe("true");
      fireEvent.keyDown(row, { key: "Enter" });
      expect(expanded("tests")).toBe("false");
    });
  });
});
