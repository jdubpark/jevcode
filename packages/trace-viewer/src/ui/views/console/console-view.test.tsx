// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TraceRow } from "@jevcode/contracts";

import { buildTraceIndex } from "../../../layout/trace-index.js";
import { foldRows, type TraceSession } from "../../../model/index.js";
import { TraceBuilder, testMeta } from "../../../test-support/trace-builder.js";
import {
  createHarness,
  stubLayout,
  type Harness,
  type HarnessOptions,
  type LayoutStub,
} from "../../../test-support/ui-harness.js";
import type { ViewerHost } from "../../shell/host.js";
import { ViewerHostContext } from "../../shell/host-context.js";
import { LiveRegion } from "../../shell/LiveRegion.js";
import { SessionContext, type SessionView } from "../../shell/session-context.js";
import { ViewStoreContext } from "../../state/store.js";
import { ViewPortRegistryContext } from "../view-port.js";
import { ConsoleView } from "./ConsoleView.js";

const NOW = Date.parse("2026-09-18T09:30:00.000Z");

let layout: LayoutStub;
beforeEach(() => {
  layout = stubLayout({ height: 600, rowHeight: 32 });
});
afterEach(() => {
  cleanup();
  layout.restore();
  vi.restoreAllMocks();
});

/** Lets rAF callbacks, timers and React commits run. */
async function frames(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

interface Mounted {
  h: Harness;
  update(next: TraceSession): void;
  scroller(): HTMLElement;
}

/** The Console inside the providers the Shell gives it; update() applies a new commit the way the Shell does. */
function mountConsole(session: TraceSession, options: HarnessOptions & { host?: ViewerHost } = {}): Mounted {
  const h = createHarness(session, options);
  let view: SessionView = h.view;
  const tree = (current: SessionView): ReactElement => (
    <ViewStoreContext.Provider value={h.store}>
      <SessionContext.Provider value={current}>
        <ViewerHostContext.Provider value={options.host ?? {}}>
          <ViewPortRegistryContext.Provider value={h.registry}>
            <LiveRegion onAnnounce={(message) => h.announcements.push(message)}>
              <ConsoleView active />
            </LiveRegion>
          </ViewPortRegistryContext.Provider>
        </ViewerHostContext.Provider>
      </SessionContext.Provider>
    </ViewStoreContext.Provider>
  );
  const result = render(tree(view));
  return {
    h,
    update(next) {
      const index = buildTraceIndex(next, view.index);
      view = { ...view, session: next, index, summary: next.meta };
      h.store.setIndex(index);
      act(() => {
        result.rerender(tree(view));
        h.store.dispatch({
          type: "session/applied",
          loadedThroughSeq: next.loadedThroughSeq,
          terminal: false,
          loadComplete: true,
          initialSelection: null,
          chapterSpineRows: 0,
        });
      });
    },
    scroller() {
      const node = result.container.querySelector<HTMLElement>("[data-console-scroll]");
      if (node === null) throw new Error("the Console has no scroller");
      return node;
    },
  };
}

function messages(count: number): TraceBuilder {
  const b = new TraceBuilder();
  b.agent({ type: "agent_started", prompt: "Work" });
  for (let i = 1; i < count; i += 1) b.agent({ type: "agent_message", role: "assistant", text: `message ${i}` });
  return b;
}

function live(b: TraceBuilder): TraceSession {
  return foldRows(testMeta({ state: "running", lastEventSeq: b.rows.length }), b.rows, { live: true, nowMs: NOW });
}

describe("ConsoleView (spec §3.2, §8.2)", () => {
  it("renders the Phase A row kinds and shows bidi and control characters as visible tokens", async () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Fix \u202Elogin" });
    b.agent({ type: "agent_message", role: "assistant", text: "Done \u202Etxt.exe" });
    b.agent({ type: "command_started", command: "ls src" });
    b.agent({ type: "command_completed", command: "ls src", exitCode: 2, stdout: "a.ts\u0007\nb.ts", stderr: "" });
    b.agent({ type: "file_changed", path: "src/a.ts" });
    b.fact({ type: "git_hunk", file: "src/a.ts", added: 3, removed: 1, isFormattingOnly: false, isConfigOnly: false, isLockfile: false });
    b.decision({ id: "d1", title: "Keep \u202Eemail?" });
    const m = mountConsole(live(b), { state: { follow: false, loaded: true } });
    await frames();
    const text = screen.getByRole("feed", { name: "Console" }).textContent ?? "";
    expect(text).toContain("Fix ⟨U+202E⟩login");
    expect(text).toContain("Done ⟨U+202E⟩txt.exe");
    expect(text).toContain("a.ts⟨U+0007⟩");
    expect(text).toContain("Keep ⟨U+202E⟩email?");
    expect(text).not.toContain("\u202E");
    expect(text).toContain("✕ exit 2");
    expect(text).toContain("+3 −1");
    expect(text).toContain("Needs your decision");
    // A read-only host (the trace window) offers no answer buttons.
    expect(screen.queryByRole("button", { name: "Option A" })).toBeNull();
    expect(m.h.registry.get("console")?.zoom.label()).toBe("");
  });

  it("answers a pending decision through host.answerDecision with keyboard-reachable buttons", async () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.decision({ id: "d1", title: "Keep email login?" });
    const answerDecision = vi.fn(async () => undefined);
    const m = mountConsole(live(b), { host: { answerDecision }, state: { follow: false, loaded: true } });
    await frames();
    const option = screen.getByRole("button", { name: "Option B" });
    act(() => option.focus());
    expect(document.activeElement).toBe(option);
    fireEvent.click(option);
    await waitFor(() => expect(answerDecision).toHaveBeenCalledWith({ decisionId: "d1", optionId: "b" }));
    await waitFor(() => expect(m.h.announcements).toContain("Answer sent"));
  });

  it("Review Focus 3: a live append while the reader is scrolled back keeps the offset, the focused row and the selection, and shows an N new pill", async () => {
    const b = messages(60);
    const first = live(b);
    const target = first.steps[20];
    if (target === undefined) throw new Error("the session has fewer than 21 steps");
    const m = mountConsole(first, { state: { follow: true, loaded: true, lastSeenSeq: first.loadedThroughSeq } });
    await frames();

    // The reader scrolls back with the wheel.
    const scroller = m.scroller();
    act(() => {
      fireEvent.wheel(scroller, { deltaY: -400 });
      scroller.scrollTop = 320;
      fireEvent.scroll(scroller);
    });
    await frames();
    expect(m.h.store.get().follow).toBe(false);

    // The reader selects a visible row and keeps focus on it.
    const row = await waitFor(() => {
      const node = Array.from(scroller.querySelectorAll<HTMLElement>("[data-key]")).find((item) => item.dataset.key === target.id);
      if (node === undefined) throw new Error("the target row is not mounted");
      return node;
    });
    fireEvent.click(row);
    act(() => row.focus());
    expect(m.h.store.get().selection).toBe(target.id);
    const scrollsBefore = layout.scrollCalls.length;
    const topBefore = scroller.scrollTop;

    // Three rows arrive while the reader reads.
    for (let i = 0; i < 3; i += 1) b.agent({ type: "agent_message", role: "assistant", text: `late ${i}` });
    m.update(live(b));
    await frames();

    expect(layout.scrollCalls.length).toBe(scrollsBefore);
    expect(scroller.scrollTop).toBe(topBefore);
    expect(document.activeElement).toBe(row);
    expect(m.h.store.get().selection).toBe(target.id);
    expect(screen.getByRole("button", { name: /3 new/ })).toBeTruthy();
  });

  it("follows the tail in Live while the reader is at the bottom", async () => {
    const b = messages(60);
    const first = live(b);
    const m = mountConsole(first, { state: { follow: true, loaded: true, lastSeenSeq: first.loadedThroughSeq } });
    await frames();
    act(() => {
      fireEvent.scroll(m.scroller());
    });
    await frames();
    const before = layout.scrollCalls.length;
    for (let i = 0; i < 3; i += 1) b.agent({ type: "agent_message", role: "assistant", text: `late ${i}` });
    m.update(live(b));
    await frames();
    expect(layout.scrollCalls.length).toBeGreaterThan(before);
    expect(m.h.store.get().follow).toBe(true);
    expect(screen.queryByRole("button", { name: /new/ })).toBeNull();
  });

  it("gives j/k the step order and expands a command's full output through the port", async () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const cmd = b.agent({ type: "command_started", command: "ls src" });
    b.agent({
      type: "command_completed",
      command: "ls src",
      exitCode: 0,
      stdout: Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n"),
      stderr: "",
    });
    const read = b.agent({ type: "file_read", path: "src/a.ts" });
    b.agent({ type: "file_read", path: "src/b.ts" });
    const session = live(b);
    const payloads = vi.fn(async (seqs: readonly number[]): Promise<TraceRow[]> => b.rows.filter((row) => seqs.includes(row.seq)));
    const m = mountConsole(session, { payloads, state: { follow: false, loaded: true } });
    await frames();
    const stepAt = (seq: number) => session.steps.find((step) => step.firstSeq === seq);
    const commandStep = stepAt(cmd);
    if (commandStep === undefined) throw new Error("no command step");
    const port = m.h.registry.get("console");
    expect(port?.readingOrder()).toEqual([session.steps[0]?.id, commandStep.id, stepAt(read)?.id]);

    const feed = screen.getByRole("feed", { name: "Console" });
    expect(feed.textContent).toContain("line 12");
    expect(feed.textContent).not.toContain("line 4");
    let handled = false;
    act(() => {
      handled = port?.toggle?.(commandStep.id) ?? false;
    });
    expect(handled).toBe(true);
    expect(m.h.store.get().expanded.has(`console:${commandStep.id}`)).toBe(true);
    await waitFor(() => expect(feed.textContent).toContain("line 4"));
    expect(payloads).toHaveBeenCalledWith(commandStep.seqs);
  });

  it("a click selects without scrolling; a selection from elsewhere reveals its row", async () => {
    const b = messages(120);
    const session = live(b);
    const m = mountConsole(session, { state: { follow: false, loaded: true } });
    await frames();
    const scroller = m.scroller();
    const near = session.steps[3];
    const far = session.steps[100];
    if (near === undefined || far === undefined) throw new Error("the session is too short");
    const row = Array.from(scroller.querySelectorAll<HTMLElement>("[data-key]")).find((item) => item.dataset.key === near.id);
    if (row === undefined) throw new Error("row 3 is not mounted");
    const before = layout.scrollCalls.length;
    fireEvent.click(row);
    expect(m.h.store.get().selection).toBe(near.id);
    expect(layout.scrollCalls.length).toBe(before);

    act(() => m.h.store.dispatch({ type: "select", id: far.id, by: "hybrid" }));
    await frames();
    expect(layout.scrollCalls.length).toBeGreaterThan(before);
  });
});

function finished(b: TraceBuilder): TraceSession {
  return foldRows(testMeta({ state: "completed", lastEventSeq: b.rows.length }), b.rows, { live: false });
}

describe("ConsoleView live clock, Live follow and test runs", () => {
  it("times a running command from its step start on the display clock (running rows carry ms: null)", async () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const cmd = b.agent({ type: "command_started", command: "pnpm test --filter auth" });
    const session = live(b);
    const step = session.steps.find((item) => item.firstSeq === cmd);
    if (step === undefined) throw new Error("no command step");
    mountConsole(session, { nowT: step.tMs + 12_400, state: { follow: false, loaded: true } });
    await frames();
    expect(screen.getByRole("feed", { name: "Console" }).textContent).toContain("12 s");
  });

  it("turns Live on when the reader's own scroll reaches the bottom of a running session, not on any scroll", async () => {
    const b = messages(60);
    const first = live(b);
    const m = mountConsole(first, { state: { follow: false, loaded: true, lastSeenSeq: first.loadedThroughSeq } });
    await frames();
    const scroller = m.scroller();

    // A scroll the reader did not make (no wheel, touch, pointer or key) leaves Review alone.
    act(() => {
      scroller.scrollTop = 100_000;
      fireEvent.scroll(scroller);
    });
    await frames();
    expect(m.h.store.get().follow).toBe(false);

    act(() => {
      scroller.scrollTop = 0;
      fireEvent.scroll(scroller);
    });
    await frames();
    act(() => {
      fireEvent.wheel(scroller, { deltaY: 4000 });
      scroller.scrollTop = 100_000;
      fireEvent.scroll(scroller);
    });
    await frames();
    expect(m.h.store.get().follow).toBe(true);
  });

  it("shows a test run as its command over passed/total and the failing test names", async () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Fix login" });
    b.agent({ type: "command_started", command: "pnpm test --filter auth" });
    b.agent({ type: "command_completed", command: "pnpm test --filter auth", exitCode: 1, stdout: "", stderr: "" });
    b.fact({
      type: "test_result", runner: "vitest", command: "pnpm test --filter auth", passed: 14, failed: 1, skipped: 0,
      failures: [{ file: "a.test.ts", testName: "links accounts by verified email", message: "expected true" }],
    });
    b.agent({ type: "agent_completed" });
    mountConsole(finished(b), { state: { follow: false, loaded: true } });
    await frames();
    const text = screen.getByRole("feed", { name: "Console" }).textContent ?? "";
    expect(text).toContain("pnpm test --filter auth");
    expect(text).toContain("14/15");
    expect(text).toContain("links accounts by verified email");
    // The flag line is titled by the viewer (FINDING_TITLE), never by agent text.
    expect(text).toContain("Tests failed");
  });

  it("a click on a row cut by the viewport edge selects it without scrolling", async () => {
    const b = messages(60);
    const m = mountConsole(live(b), { state: { follow: false, loaded: true } });
    await frames();
    const scroller = m.scroller();
    // 32 px rows from y = 4 in a 600 px viewport: row 18 spans 580-612, outside the comfort band.
    const row = Array.from(scroller.querySelectorAll<HTMLElement>("[data-key]")).find((item) => item.dataset.index === "18");
    if (row === undefined) throw new Error("row 18 is not mounted");
    const before = layout.scrollCalls.length;
    fireEvent.click(row);
    await frames();
    expect(m.h.store.get().selection).toBe(row.dataset.key);
    expect(layout.scrollCalls.length).toBe(before);
  });

  it("following with the tail selected, an append that slides the live brush keeps following instead of revealing the old tail", async () => {
    const b = messages(60);
    const first = live(b);
    const tail = first.steps.at(-1);
    if (tail === undefined) throw new Error("no tail step");
    const m = mountConsole(first, {
      state: {
        follow: true,
        loaded: true,
        lastSeenSeq: first.loadedThroughSeq,
        selection: tail.id,
        playhead: { kind: "live" },
        brush: { kind: "chapter", anchorSeq: 1 },
      },
    });
    await frames();
    const scroller = m.scroller();
    const sizer = scroller.firstElementChild as HTMLElement;
    // jsdom has no layout: give the scroller the box the virtualizer reads for its end.
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 600 });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => Math.max(600, Number.parseFloat(sizer.style.height) || 0) });
    const end = (): number => scroller.scrollHeight - scroller.clientHeight;
    act(() => {
      scroller.scrollTop = end();
      fireEvent.scroll(scroller);
    });
    await frames();
    const rev = m.h.store.get().focusRev;
    const topBefore = scroller.scrollTop;

    // A steer opens a new turn: the live playhead leaves the chapter brush, which slides and bumps focusRev.
    b.agent({ type: "agent_message", role: "user", text: "Use PKCE" });
    b.agent({ type: "agent_interrupted", reason: "steer" });
    b.agent({ type: "agent_started", prompt: "Use PKCE" });
    for (let i = 0; i < 3; i += 1) b.agent({ type: "agent_message", role: "assistant", text: `late ${i}` });
    m.update(live(b));
    await frames();

    expect(m.h.store.get().focusRev).toBeGreaterThan(rev);
    expect(m.h.store.get().selection).toBe(tail.id);
    expect(m.h.store.get().follow).toBe(true);
    // Live keeps moving down with the new rows (jsdom settles the last few px of measurement late, so no exact end).
    expect(scroller.scrollTop).toBeGreaterThan(topBefore);
  });
});
