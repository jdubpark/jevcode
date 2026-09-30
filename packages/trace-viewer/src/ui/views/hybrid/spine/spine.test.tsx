// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildTimeScale, timeScaleInputOf } from "../../../../layout/time-scale.js";
import { buildTraceIndex } from "../../../../layout/trace-index.js";
import { foldRows, type TraceSession } from "../../../../model/index.js";
import { TraceBuilder, testMeta } from "../../../../test-support/trace-builder.js";
import {
  applyOpenDefaults,
  foldFixture,
  renderHarness,
  stubLayout,
  type Harness,
  type LayoutStub,
} from "../../../../test-support/ui-harness.js";
import { FindingBodyContext, Spine, type SpineApi } from "./Spine.js";

let layout: LayoutStub | null = null;
afterEach(() => {
  cleanup();
  layout?.restore();
  layout = null;
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

function renderSpine(session = foldFixture("oauth"), options: Parameters<typeof renderHarness>[2] = {}) {
  const apiRef: { current: SpineApi | null } = { current: null };
  const h = renderHarness(
    <FindingBodyContext.Provider value={() => <p>finding body</p>}>
      <Spine active apiRef={apiRef} />
    </FindingBodyContext.Provider>,
    session,
    options,
  );
  return { h, apiRef, session };
}

function article(key: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[role="feed"] article[data-key="${key}"]`);
}

/** One instruction and `count` completed commands, each its own step row at the step level. */
function commandRun(count: number, options: { running?: boolean } = {}): TraceSession {
  const b = new TraceBuilder();
  b.agent({ type: "agent_started", prompt: "Run the scripts" });
  for (let i = 0; i < count; i += 1) {
    const command = `node script-${i}.js`;
    b.agent({ type: "command_started", command });
    if (options.running !== true || i < count - 1) {
      b.agent({ type: "command_completed", command, exitCode: 0, stdout: "", stderr: "" });
    }
  }
  if (options.running !== true) b.agent({ type: "agent_completed" });
  return foldRows(testMeta(), b.rows, { live: options.running === true, nowMs: Date.parse("2026-09-18T09:00:00.000Z") + count * 2_000 + 2_000 });
}

function stepKeys(session: TraceSession, from: number, to: number): string[] {
  return session.steps.slice(from, to).map((step) => step.id);
}

function scroller(): HTMLElement {
  return document.querySelector<HTMLElement>("[data-scroll-root]") as HTMLElement;
}

/** Swaps the session under a live harness the way a Live poll does: same store, new index and rows. */
function applySession(h: Harness & { result: { rerender(node: React.ReactElement): void } }, node: React.ReactNode, next: TraceSession): void {
  const index = buildTraceIndex(next);
  h.store.setIndex(index);
  Object.assign(h.view, { session: next, index, scale: buildTimeScale(timeScaleInputOf(next)) });
  act(() => h.result.rerender(h.wrap(node)));
}

describe("Spine", () => {
  it("renders a feed of positioned articles", async () => {
    layout = stubLayout({ height: 2_000 });
    const { apiRef } = renderSpine();
    await settle();
    const feed = screen.getByRole("feed", { name: "Reading spine" });
    const articles = Array.from(feed.querySelectorAll("article"));
    expect(articles.length).toBe(apiRef.current?.rows().length);
    expect(articles[0]?.getAttribute("aria-posinset")).toBe("1");
    expect(articles[0]?.getAttribute("aria-setsize")).toBe(String(articles.length));
  });

  it("shows oauth's test row with TestDots and 14/15, and the expanded claim at +0:43", async () => {
    layout = stubLayout({ height: 2_000 });
    const session = foldFixture("oauth");
    const { h } = renderSpine(session);
    act(() => applyOpenDefaults(h, session));
    await settle();
    const test = session.steps.find((step) => step.command?.command === "pnpm test");
    expect(article(test?.id ?? "")?.textContent).toContain("14/15");
    const claim = session.findings.find((finding) => finding.ruleId === "claim_contradicted");
    const row = article(claim?.anchorStepId ?? "");
    expect(row?.textContent).toContain("+0:43");
    expect(row?.textContent).toContain("Claim contradicts tests");
    expect(row?.querySelector("[data-expanded]")).not.toBeNull();
    expect(row?.textContent).toContain("finding body");
  });

  it("never scrolls for a spine-origin playhead write and reveals for an overview write", async () => {
    const stub = stubLayout({ height: 200 });
    layout = stub;
    const session = foldFixture("oauth");
    const { h } = renderSpine(session);
    await settle();
    stub.scrollCalls.length = 0;
    const last = session.steps.at(-1)?.firstSeq ?? 1;
    act(() => h.store.dispatch({ type: "playhead/set", playhead: { kind: "free", seq: last }, origin: "spine" }));
    await settle();
    expect(stub.scrollCalls).toHaveLength(0);
    act(() => h.store.dispatch({ type: "playhead/set", playhead: { kind: "free", seq: last }, origin: "overview" }));
    await settle();
    expect(stub.scrollCalls.length).toBeGreaterThan(0);
  });

  it("selects a clicked row without scrolling", async () => {
    const stub = stubLayout({ height: 2_000 });
    layout = stub;
    const session = foldFixture("oauth");
    const { h } = renderSpine(session);
    await settle();
    stub.scrollCalls.length = 0;
    const target = session.steps.find((step) => step.kind === "edit");
    fireEvent.click(article(target?.id ?? "")?.firstElementChild as HTMLElement);
    await settle();
    expect(h.store.get().selection).toBe(target?.id);
    expect(stub.scrollCalls).toHaveLength(0);
  });

  it("keeps the live footer outside the list", async () => {
    layout = stubLayout({ height: 2_000 });
    const session = foldFixture("oauth");
    renderSpine({ ...session, live: true }, { terminal: false, nowT: 49_000 });
    await settle();
    const footer = screen.getByText(/^Agent running · last event/);
    expect(screen.getByRole("feed").contains(footer)).toBe(false);
  });

  it("renders a bidi override in a command as the escape token", async () => {
    layout = stubLayout({ height: 2_000 });
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Clean up" });
    b.agent({ type: "command_started", command: "echo \u202Etxt.exe" });
    b.agent({ type: "command_completed", command: "echo \u202Etxt.exe", exitCode: 0, stdout: "", stderr: "" });
    b.agent({ type: "agent_completed" });
    renderSpine(foldRows(testMeta(), b.rows, { live: false }));
    await settle();
    const feed = screen.getByRole("feed");
    expect(feed.textContent).toContain("⟨U+202E⟩");
    expect(feed.textContent).not.toContain("\u202E");
  });

  it("reads exit -1 as unknown on a neutral node", async () => {
    layout = stubLayout({ height: 2_000 });
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Lint" });
    b.agent({ type: "command_started", command: "pnpm lint" });
    b.agent({ type: "command_completed", command: "pnpm lint", exitCode: -1, stdout: "", stderr: "" });
    b.agent({ type: "agent_completed" });
    const session = foldRows(testMeta(), b.rows, { live: false });
    renderSpine(session);
    await settle();
    const command = session.steps.find((step) => step.command?.command === "pnpm lint");
    const row = article(command?.id ?? "");
    expect(row?.textContent).toContain("exit unknown");
    expect(row?.querySelector('[data-tone="bad"], [data-tone="critical"]')).toBeNull();
  });

  describe("scroll and playhead sync", () => {
    const session = commandRun(80);
    const spineNode = (apiRef: { current: SpineApi | null }) => (
      <FindingBodyContext.Provider value={() => <p>finding body</p>}>
        <Spine active apiRef={apiRef} />
      </FindingBodyContext.Provider>
    );

    it("pushes the playhead into the comfort band after a user scroll, tagged spine", async () => {
      layout = stubLayout({ height: 200 });
      const apiRef: { current: SpineApi | null } = { current: null };
      const h = renderHarness(spineNode(apiRef), session, { state: { level: "step" } });
      await settle();
      const first = session.steps[2]?.firstSeq ?? 1;
      act(() => h.store.dispatch({ type: "playhead/set", playhead: { kind: "free", seq: first }, origin: "spine" }));
      await settle();
      const root = scroller();
      fireEvent.wheel(root, { deltaY: 400 });
      root.scrollTop = 1_200;
      fireEvent.scroll(root);
      await settle();
      const state = h.store.get();
      expect(state.playheadOrigin).toBe("spine");
      expect(state.playhead.kind).toBe("free");
      expect(state.playhead.kind === "free" ? state.playhead.seq : 0).toBeGreaterThan(first + 20);
    });

    it("never writes the playhead for a scroll the user did not make", async () => {
      layout = stubLayout({ height: 200 });
      const apiRef: { current: SpineApi | null } = { current: null };
      const h = renderHarness(spineNode(apiRef), session, { state: { level: "step" } });
      await settle();
      const first = session.steps[2]?.firstSeq ?? 1;
      act(() => h.store.dispatch({ type: "playhead/set", playhead: { kind: "free", seq: first }, origin: "keys" }));
      await settle();
      const before = h.store.get().playhead;
      const root = scroller();
      root.scrollTop = 1_200;
      fireEvent.scroll(root);
      await settle();
      expect(h.store.get().playhead).toBe(before);
    });

    it("keeps the selected row and the focused row mounted while they are scrolled away", async () => {
      layout = stubLayout({ height: 200 });
      const apiRef: { current: SpineApi | null } = { current: null };
      const h = renderHarness(spineNode(apiRef), session, { state: { level: "step" } });
      await settle();
      const [selected] = stepKeys(session, 3, 4);
      const focused = stepKeys(session, 5, 6)[0] ?? "";
      act(() => h.store.dispatch({ type: "select", id: selected as never, by: "hybrid" }));
      await settle();
      act(() => apiRef.current?.focusRow(focused));
      await settle();
      const tail = session.steps.at(-1)?.firstSeq ?? 1;
      act(() => h.store.dispatch({ type: "playhead/set", playhead: { kind: "free", seq: tail }, origin: "spine" }));
      const root = scroller();
      root.scrollTop = 2_300;
      fireEvent.scroll(root);
      await settle();
      expect(article(selected ?? "")).not.toBeNull();
      expect(article(focused)).not.toBeNull();
      expect(document.activeElement).toBe(article(focused));
    });

    it("focuses a row that is not mounted yet, once, after the user asks", async () => {
      layout = stubLayout({ height: 200 });
      const apiRef: { current: SpineApi | null } = { current: null };
      renderHarness(spineNode(apiRef), session, { state: { level: "step" } });
      await settle();
      const far = stepKeys(session, 40, 41)[0] ?? "";
      expect(article(far)).toBeNull();
      act(() => apiRef.current?.focusRow(far));
      await settle();
      expect(document.activeElement).toBe(article(far));
    });

    it("keeps focus and the playhead when a poll appends rows", async () => {
      layout = stubLayout({ height: 200 });
      const apiRef: { current: SpineApi | null } = { current: null };
      const node = spineNode(apiRef);
      const h = renderHarness(node, session, { state: { level: "step" } });
      await settle();
      const key = stepKeys(session, 1, 2)[0] ?? "";
      act(() => apiRef.current?.focusRow(key));
      await settle();
      const playhead = h.store.get().playhead;
      const origin = h.store.get().playheadOrigin;
      applySession(h, node, commandRun(85));
      await settle();
      expect(document.activeElement).toBe(article(key));
      expect(h.store.get().playhead).toBe(playhead);
      expect(h.store.get().playheadOrigin).toBe(origin);
    });

    it("scrolls again for a later external write after the spine's own click", async () => {
      const stub = stubLayout({ height: 200 });
      layout = stub;
      const apiRef: { current: SpineApi | null } = { current: null };
      const h = renderHarness(spineNode(apiRef), session, { state: { level: "step" } });
      await settle();
      const [clicked] = stepKeys(session, 1, 2);
      fireEvent.click(article(clicked ?? "")?.firstElementChild as HTMLElement);
      await settle();
      stub.scrollCalls.length = 0;
      const far = session.steps.at(-1)?.firstSeq ?? 1;
      act(() => h.store.dispatch({ type: "playhead/set", playhead: { kind: "free", seq: far }, origin: "overview" }));
      await settle();
      expect(stub.scrollCalls.length).toBeGreaterThan(0);
    });
  });

  it("grows a running command's hollow bar as the clock advances", async () => {
    layout = stubLayout({ height: 2_000 });
    const session = commandRun(3, { running: true });
    const hollowWidth = async (nowT: number): Promise<number> => {
      cleanup();
      renderSpine(session, { terminal: false, nowT, state: { level: "step" } });
      await settle();
      const running = session.steps.at(-1);
      const bar = article(running?.id ?? "")?.querySelector('[data-bar="hollow"]');
      return Number(bar?.getAttribute("width") ?? 0);
    };
    const early = await hollowWidth((session.steps.at(-1)?.tMs ?? 0) + 6_000);
    const later = await hollowWidth((session.steps.at(-1)?.tMs ?? 0) + 60_000);
    expect(later).toBeGreaterThan(early);
    expect(later).toBeGreaterThan(0);
  });
});

describe("Spine Live clock and article names", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function tickingSpine(terminal: boolean) {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    layout = stubLayout({ height: 2_000 });
    const session = { ...foldFixture("oauth"), live: !terminal };
    const clock = { t: 49_000 };
    const apiRef: { current: SpineApi | null } = { current: null };
    const h = renderHarness(<Spine active apiRef={apiRef} />, session, { terminal, state: { level: "step" } });
    h.view.nowT = () => clock.t;
    return { h, clock, session };
  }

  it("advances the Live footer every second without new data", () => {
    const { clock } = tickingSpine(false);
    const before = screen.getByText(/^Agent running · last event/).textContent;
    clock.t += 1_000;
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByText(/^Agent running · last event/).textContent).not.toBe(before);
  });

  it("holds no interval once terminal or unmounted", () => {
    tickingSpine(true);
    const baseline = vi.getTimerCount();
    cleanup();
    const afterTerminal = vi.getTimerCount();
    tickingSpine(false);
    expect(vi.getTimerCount()).toBe(baseline + 1);
    cleanup();
    expect(vi.getTimerCount()).toBe(afterTerminal);
  });

  it("names every article from its own headline", async () => {
    layout = stubLayout({ height: 2_000 });
    renderSpine(foldFixture("oauth"), { state: { level: "step" } });
    await settle();
    const articles = [...document.querySelectorAll<HTMLElement>('[role="feed"] article')];
    expect(articles.length).toBeGreaterThan(0);
    for (const item of articles) {
      const id = item.getAttribute("aria-labelledby");
      expect(id).toBeTruthy();
      const target = document.getElementById(id ?? "");
      expect(item.contains(target)).toBe(true);
      expect(target?.textContent?.length).toBeGreaterThan(0);
    }
  });
});
