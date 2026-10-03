// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Activity, useLayoutEffect, useRef, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TraceRow } from "@jevcode/contracts";

import { ROWS_RELEASED_MARK } from "../../../source.js";
import { buildTraceIndex, type TraceIndex } from "../../../layout/trace-index.js";
import { displayUntrusted, foldRows, type TraceSession } from "../../../model/index.js";
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
import { DiagnosticsContext, SessionContext, type DiagnosticsSink, type SessionView } from "../../shell/session-context.js";
import { ViewStoreContext, type ViewStore } from "../../state/store.js";
import { ViewPortRegistryContext } from "../view-port.js";
import { ConsoleView } from "./ConsoleView.js";

// A pass-through spy on displayUntrusted: every row renders its agent text through it, so its calls show which rows
// re-rendered (fix round 1, item 8).
vi.mock("../../../model/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../model/index.js")>();
  return { ...actual, displayUntrusted: vi.fn(actual.displayUntrusted) };
});

const NO_DIAGNOSTICS: DiagnosticsSink = { enabled: false, reportDrift: () => undefined, reportError: () => undefined, flush: () => undefined };

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
  /** Only with `activity`: shows or hides the Console under <Activity>, the way the Shell's ViewSlot does. */
  setMode(mode: "visible" | "hidden"): void;
  scroller(): HTMLElement;
}

/**
 * Applies a new commit the way the Shell does (Shell.tsx): from the ancestor's layout effect, which runs after the
 * Console's own layout effects, so the store update lands in a second commit.
 */
function SessionApplier({ session, index, store, children }: { session: TraceSession | null; index: TraceIndex; store: ViewStore; children: ReactNode }) {
  const opened = useRef(session);
  useLayoutEffect(() => {
    if (session === null || session === opened.current) return;
    store.setIndex(index);
    store.dispatch({
      type: "session/applied",
      loadedThroughSeq: session.loadedThroughSeq,
      terminal: false,
      loadComplete: true,
      initialSelection: null,
      chapterSpineRows: 0,
    });
  }, [session, index, store]);
  return <>{children}</>;
}

/** The Console inside the providers the Shell gives it; update() applies a new commit the way the Shell does. */
function mountConsole(session: TraceSession, options: HarnessOptions & { host?: ViewerHost; activity?: boolean; } = {}): Mounted {
  const h = createHarness(session, options);
  let view: SessionView = h.view;
  let mode: "visible" | "hidden" = "visible";
  const tree = (current: SessionView): ReactElement => (
    <DiagnosticsContext.Provider value={options.diagnostics ?? NO_DIAGNOSTICS}>
    <ViewStoreContext.Provider value={h.store}>
      <SessionApplier session={current.session} index={current.index} store={h.store}>
        <SessionContext.Provider value={current}>
          <ViewerHostContext.Provider value={options.host ?? {}}>
            <ViewPortRegistryContext.Provider value={h.registry}>
              <LiveRegion onAnnounce={(message) => h.announcements.push(message)}>
                {options.activity === true ? (
                  <Activity mode={mode}>
                    <ConsoleView active={mode === "visible"} />
                  </Activity>
                ) : (
                  <ConsoleView active />
                )}
              </LiveRegion>
            </ViewPortRegistryContext.Provider>
          </ViewerHostContext.Provider>
        </SessionContext.Provider>
      </SessionApplier>
    </ViewStoreContext.Provider>
    </DiagnosticsContext.Provider>
  );
  const result = render(tree(view));
  return {
    h,
    update(next) {
      const index = buildTraceIndex(next, view.index);
      view = { ...view, session: next, index, summary: next.meta };
      act(() => {
        result.rerender(tree(view));
      });
    },
    setMode(next) {
      mode = next;
      act(() => {
        result.rerender(tree(view));
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

describe("ConsoleView fix round 1", () => {
  function decisionSession(after = 0): TraceBuilder {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.decision({ id: "d1", title: "Keep email login?" });
    for (let i = 0; i < after; i += 1) b.agent({ type: "agent_message", role: "assistant", text: `message ${i}` });
    return b;
  }
  const option = (name: string): HTMLButtonElement => screen.getByRole("button", { name }) as HTMLButtonElement;
  // The block's own note, not the live region's announcement of the same words.
  const inFeed = () => within(screen.getByRole("feed", { name: "Console" }));

  it("a double click sends one answer; once sent the block stays disabled with Answer sent until the trace shows it answered", async () => {
    const b = decisionSession();
    const answerDecision = vi.fn(async () => undefined);
    const m = mountConsole(live(b), { host: { answerDecision }, state: { follow: false, loaded: true } });
    await frames();
    act(() => {
      fireEvent.click(option("Option A"));
      fireEvent.click(option("Option A"));
    });
    await waitFor(() => expect(inFeed().getByText("Answer sent")).toBeTruthy());
    expect(option("Option A").disabled).toBe(true);
    expect(option("Option B").disabled).toBe(true);
    fireEvent.click(option("Option B"));
    await frames();
    expect(answerDecision).toHaveBeenCalledTimes(1);
    expect(answerDecision).toHaveBeenCalledWith({ decisionId: "d1", optionId: "a" });

    b.decision({ id: "d1", title: "Keep email login?", status: "answered", answer: { decisionId: "d1", decision: { choice: "a" }, evidence: [] } });
    m.update(live(b));
    await frames();
    expect(inFeed().queryByText("Answer sent")).toBeNull();
    expect(screen.queryByRole("button", { name: "Option A" })).toBeNull();
    expect(screen.getByRole("feed", { name: "Console" }).textContent).toContain("→ Option A");
  });

  it("a failed answer shows a quiet note in the block and lets the reader answer again", async () => {
    const answerDecision = vi.fn(async () => {
      throw new Error("rejected");
    });
    const m = mountConsole(live(decisionSession()), { host: { answerDecision }, state: { follow: false, loaded: true } });
    await frames();
    fireEvent.click(option("Option B"));
    await waitFor(() => expect(inFeed().getByText("Could not send the answer. Try again.")).toBeTruthy());
    expect(m.h.announcements).toContain("Could not send the answer");
    expect(option("Option B").disabled).toBe(false);
    fireEvent.click(option("Option B"));
    await waitFor(() => expect(answerDecision).toHaveBeenCalledTimes(2));
  });

  it("keeps a sent answer's disabled block when the row scrolls out of the virtual range and back", async () => {
    const answerDecision = vi.fn(async () => undefined);
    const m = mountConsole(live(decisionSession(80)), { host: { answerDecision }, state: { follow: false, loaded: true } });
    await frames();
    fireEvent.click(option("Option A"));
    await waitFor(() => expect(inFeed().getByText("Answer sent")).toBeTruthy());
    const scroller = m.scroller();
    act(() => {
      fireEvent.wheel(scroller, { deltaY: 2000 });
      scroller.scrollTop = 2000;
      fireEvent.scroll(scroller);
    });
    await frames();
    expect(screen.queryByRole("button", { name: "Option A" })).toBeNull();
    act(() => {
      fireEvent.wheel(scroller, { deltaY: -2000 });
      scroller.scrollTop = 0;
      fireEvent.scroll(scroller);
    });
    await frames();
    expect(option("Option A").disabled).toBe(true);
    expect(inFeed().getByText("Answer sent")).toBeTruthy();
    expect(answerDecision).toHaveBeenCalledTimes(1);
  });

  it("keeps one tab stop in the feed: chevrons and edit links leave the tab order, pending decision options stay", async () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "command_started", command: "ls src" });
    b.agent({ type: "command_completed", command: "ls src", exitCode: 0, stdout: Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n"), stderr: "" });
    b.agent({ type: "file_read", path: "src/a.ts" });
    b.agent({ type: "file_changed", path: "src/a.ts" });
    b.fact({ type: "git_hunk", file: "src/a.ts", added: 3, removed: 1, isFormattingOnly: false, isConfigOnly: false, isLockfile: false });
    b.decision({ id: "d1", title: "Keep email login?" });
    mountConsole(live(b), { host: { answerDecision: async () => undefined }, state: { follow: false, loaded: true } });
    await frames();
    const feed = screen.getByRole("feed", { name: "Console" });
    expect(feed.querySelectorAll("button[aria-expanded]").length).toBeGreaterThanOrEqual(2);
    const stops = Array.from(feed.querySelectorAll<HTMLElement>("button, a[href], input, [tabindex]")).filter((node) => node.tabIndex >= 0);
    expect(stops.filter((node) => node.tagName === "ARTICLE")).toHaveLength(1);
    expect(stops.filter((node) => node.tagName !== "ARTICLE").map((node) => node.textContent)).toEqual(["Option A", "Option B"]);
  });

  it("the pill counts new Console rows, not model steps", async () => {
    const b = messages(60);
    const first = live(b);
    const m = mountConsole(first, { state: { follow: false, loaded: true, lastSeenSeq: first.loadedThroughSeq } });
    await frames();
    // Two reads (one row), a routine Jev step (no row) and a message (one row): four steps, two rows.
    b.agent({ type: "file_read", path: "src/a.ts" });
    b.agent({ type: "file_read", path: "src/b.ts" });
    b.jev({ id: "j1", clamps: ["suppress_formatting"] });
    b.agent({ type: "agent_message", role: "assistant", text: "late" });
    m.update(live(b));
    await frames();
    expect(screen.getByRole("button", { name: /new/ }).textContent).toContain("2 new");
  });

  it("Enter is always the Console's: the port handles any id and never toggles Hybrid's expansion", async () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const message = b.agent({ type: "agent_message", role: "assistant", text: "hello" });
    const session = live(b);
    const m = mountConsole(session, { state: { follow: false, loaded: true } });
    await frames();
    const id = session.steps.find((step) => step.firstSeq === message)?.id;
    if (id === undefined) throw new Error("no message step");
    let handled = false;
    act(() => {
      handled = m.h.registry.get("console")?.toggle?.(id) ?? false;
    });
    expect(handled).toBe(true);
    expect(m.h.store.get().expanded.size).toBe(0);
  });

  it("re-renders only running rows on the live clock tick", async () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "agent_message", role: "assistant", text: "a steady message" });
    b.agent({ type: "command_started", command: "pnpm dev" });
    const m = mountConsole(live(b), { state: { follow: false, loaded: true } });
    await frames();
    let clock = 1_000;
    m.h.view.nowT = () => clock;
    const calls = (text: string): number => vi.mocked(displayUntrusted).mock.calls.filter(([value]) => value === text).length;
    const steady = calls("a steady message");
    const running = calls("pnpm dev");
    clock = 9_000;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_150));
    });
    expect(calls("pnpm dev")).toBeGreaterThan(running);
    expect(calls("a steady message")).toBe(steady);
  });
});

describe("ConsoleView V-6 pre-step (carried from V-4 review)", () => {
  it("a Console hidden under <Activity> repositions to the tail when shown again during a Live drip", async () => {
    const b = messages(60);
    const first = live(b);
    const m = mountConsole(first, { activity: true, state: { follow: true, loaded: true, lastSeenSeq: first.loadedThroughSeq } });
    await frames();
    m.setMode("hidden");
    await frames();
    for (let i = 0; i < 5; i += 1) b.agent({ type: "agent_message", role: "assistant", text: `dripped ${i}` });
    m.update(live(b));
    await frames();
    const before = layout.scrollCalls.length;
    m.setMode("visible");
    await frames();
    expect(layout.scrollCalls.length).toBeGreaterThan(before);
  });

  function guardrailSession(): { session: TraceSession; stepIds: string[] } {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const seqs = [b.jev({ id: "j1", clamps: ["security_path"] }), b.jev({ id: "j2", clamps: ["security_path"] })];
    b.agent({ type: "agent_message", role: "assistant", text: "done" });
    const session = live(b);
    const stepIds = seqs.map((seq) => session.steps.find((step) => step.firstSeq === seq)?.id ?? "");
    return { session, stepIds };
  }

  it("expands the folded Jev review row to its member flag lines, each selectable", async () => {
    const { session, stepIds } = guardrailSession();
    const m = mountConsole(session, { state: { follow: false, loaded: true } });
    await frames();
    const feed = within(screen.getByRole("feed", { name: "Console" }));
    expect(feed.getByText("Jev review · 2 guardrails")).toBeTruthy();
    expect(feed.queryAllByRole("button", { name: /^Flag:/ })).toHaveLength(0);
    fireEvent.click(feed.getByRole("button", { name: "Expand guardrails" }));
    await frames();
    const members = feed.getAllByRole("button", { name: /^Flag:/ });
    expect(members).toHaveLength(2);
    fireEvent.click(members[1] as HTMLElement);
    expect(m.h.store.get().selection).toBe(stepIds[1]);
    fireEvent.click(members[0] as HTMLElement);
    expect(m.h.store.get().selection).toBe(stepIds[0]);
  });

  it("an Outline or Brief click on the already-selected item reveals it in the Console", async () => {
    const b = messages(120);
    const session = live(b);
    const target = session.steps[100];
    if (target === undefined) throw new Error("the session is too short");
    const m = mountConsole(session, { state: { follow: false, loaded: true } });
    await frames();
    act(() => m.h.store.dispatch({ type: "select", id: target.id, by: "hybrid" }));
    await frames();
    const scroller = m.scroller();
    act(() => {
      fireEvent.wheel(scroller, { deltaY: -400 });
      scroller.scrollTop = 0;
      fireEvent.scroll(scroller);
    });
    await frames();
    const before = layout.scrollCalls.length;
    act(() => m.h.store.dispatch({ type: "select", id: target.id, by: "shell" }));
    await frames();
    expect(m.h.store.get().selection).toBe(target.id);
    expect(layout.scrollCalls.length).toBeGreaterThan(before);
  });

  it("announces new Console rows as rows, not steps, while Hybrid keeps its wording", async () => {
    const b = messages(60);
    const first = live(b);
    const m = mountConsole(first, { state: { follow: false, loaded: true, lastSeenSeq: first.loadedThroughSeq } });
    await frames();
    b.agent({ type: "agent_message", role: "assistant", text: "late" });
    b.agent({ type: "agent_message", role: "assistant", text: "late 2" });
    b.jev({ id: "jc", clamps: ["destructive_command"] });
    m.update(live(b));
    await frames();
    expect(screen.getByRole("button", { name: /3 new/ })).toBeTruthy();
    expect(m.h.announcements.some((message) => /^\d+ new rows, 1 problem$/.test(message))).toBe(true);
    expect(m.h.announcements.some((message) => /new steps/.test(message))).toBe(false);
  });

  describe("append measure (spec §11)", () => {
    const appendMeasures = () => performance.getEntriesByName("tv:console-append", "measure");
    beforeEach(() => {
      performance.clearMarks();
      performance.clearMeasures();
    });
    afterEach(() => {
      performance.clearMarks();
      performance.clearMeasures();
    });

    it("a commit after a release mark records one tv:console-append sample", async () => {
      const b = messages(20);
      const first = live(b);
      const m = mountConsole(first, { state: { follow: true, loaded: true, lastSeenSeq: first.loadedThroughSeq } });
      await frames();
      expect(appendMeasures()).toHaveLength(0);
      performance.mark(ROWS_RELEASED_MARK);
      b.agent({ type: "agent_message", role: "assistant", text: "dripped" });
      m.update(live(b));
      await frames();
      expect(appendMeasures()).toHaveLength(1);
      expect(performance.getEntriesByName(ROWS_RELEASED_MARK, "mark")).toHaveLength(0);
    });

    it("releases that landed while the Console was hidden never make a sample span the hidden time", async () => {
      const b = messages(20);
      const first = live(b);
      const m = mountConsole(first, { activity: true, state: { follow: true, loaded: true, lastSeenSeq: first.loadedThroughSeq } });
      await frames();
      m.setMode("hidden");
      await frames();
      performance.mark(ROWS_RELEASED_MARK);
      b.agent({ type: "agent_message", role: "assistant", text: "while hidden" });
      m.update(live(b));
      await frames();
      await frames();
      await frames();
      m.setMode("visible");
      await frames();
      expect(performance.getEntriesByName(ROWS_RELEASED_MARK, "mark")).toHaveLength(0);
      expect(appendMeasures()).toHaveLength(0);
      performance.mark(ROWS_RELEASED_MARK);
      b.agent({ type: "agent_message", role: "assistant", text: "after" });
      m.update(live(b));
      await frames();
      expect(appendMeasures()).toHaveLength(1);
      expect(appendMeasures()[0]?.duration).toBeLessThan(120);
    });
  });
});

describe("ConsoleView anchor drift sampler (viewer spec §10)", () => {
  /** DOM tops from the rows' transforms, so a test can move them the way a commit's layout would. */
  function stubRowTops(): { shift: { px: number }; restore(): void } {
    const proto = Element.prototype;
    const original = proto.getBoundingClientRect;
    const shift = { px: 0 };
    proto.getBoundingClientRect = function getBoundingClientRect(this: Element): DOMRect {
      const rect = original.call(this);
      if (!(this instanceof HTMLElement) || this.tagName !== "ARTICLE") return rect;
      const scroller = this.closest<HTMLElement>("[data-console-scroll]");
      const match = /translateY\((-?[\d.]+)px\)/.exec(this.style.transform);
      const top = Number(match?.[1] ?? 0) - (scroller?.scrollTop ?? 0) + shift.px;
      return { ...rect, top, y: top, bottom: top + rect.height } as DOMRect;
    };
    return { shift, restore: () => void (proto.getBoundingClientRect = original) };
  }
  function sink(): DiagnosticsSink & { drifts: number[] } {
    const drifts: number[] = [];
    return { enabled: true, drifts, reportDrift: (px) => void drifts.push(px), reportError: () => undefined, flush: () => undefined };
  }

  it("reads 0 px for appends below a reviewing reader, and the shift of an uncompensated move above the anchor", async () => {
    const stub = stubRowTops();
    try {
      const diagnostics = sink();
      const b = messages(60);
      const m = mountConsole(live(b), { diagnostics, state: { follow: false, loaded: true } });
      await frames();
      diagnostics.drifts.length = 0;
      for (let i = 0; i < 3; i += 1) {
        b.agent({ type: "agent_message", role: "assistant", text: `late ${i}` });
        m.update(live(b));
        await frames();
      }
      expect(diagnostics.drifts.length).toBeGreaterThan(0);
      expect(Math.max(...diagnostics.drifts)).toBe(0);

      // The commit itself moves the anchor row (rows inserted above it, with no compensation): the baseline was read
      // before the commit, so the sample sees the 40 px.
      diagnostics.drifts.length = 0;
      b.agent({ type: "agent_message", role: "assistant", text: "late shifted" });
      stub.shift.px = 40;
      m.update(live(b));
      await frames();
      stub.shift.px = 0;
      expect(Math.max(...diagnostics.drifts)).toBeGreaterThanOrEqual(40);
    } finally {
      stub.restore();
    }
  });
});
