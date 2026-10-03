// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useState, type JSX, type ReactNode } from "react";

import { buildBrief, type BriefModel } from "../../layout/brief.js";
import { buildTraceIndex } from "../../layout/trace-index.js";
import { foldRows, type TraceSession } from "../../model/index.js";
import { TraceBuilder, testMeta } from "../../test-support/trace-builder.js";
import { foldFixture, renderHarness, stubLayout, type LayoutStub } from "../../test-support/ui-harness.js";
import { KeyboardLayer } from "../shell/KeyboardLayer.js";
import { TitleBar } from "../shell/TitleBar.js";
import { BriefView } from "./Brief.js";
import { RightPanel } from "./RightPanel.js";

let layout: LayoutStub;
beforeEach(() => {
  layout = stubLayout();
});
afterEach(() => {
  cleanup();
  layout.restore();
  vi.restoreAllMocks();
});

const noop = (): void => undefined;

function oauthModel(): { session: ReturnType<typeof foldFixture>; model: BriefModel } {
  const session = foldFixture("oauth");
  return { session, model: buildBrief(session, buildTraceIndex(session)) };
}

function renderView(model: BriefModel, onSelect = vi.fn(), onOpenMap = vi.fn()) {
  const session = foldFixture("oauth");
  render(
    <BriefView model={model} session={session} index={buildTraceIndex(session)} nowT={0} onSelect={onSelect} onOpenMap={onOpenMap} mapAvailable />,
  );
  return { onSelect, onOpenMap };
}

const NOW = Date.parse("2026-09-18T09:30:00.000Z");

function foldLive(b: TraceBuilder, state: "starting" | "running" | "completed"): TraceSession {
  return foldRows(testMeta({ state, lastEventSeq: b.rows.length }), b.rows, { live: state !== "completed", nowMs: NOW });
}

/** Renders the Brief of a hand-built session (the mockup's states), 12 s of display clock after its last step. */
function renderSession(session: TraceSession, onSelect = vi.fn()) {
  const index = buildTraceIndex(session);
  const nowT = (session.steps.at(-1)?.tMs ?? 0) + 12_000;
  render(<BriefView model={buildBrief(session, index)} session={session} index={index} nowT={nowT} onSelect={onSelect} onOpenMap={vi.fn()} mapAvailable={false} />);
  return { onSelect };
}

function unitRows(b: TraceBuilder): void {
  b.agent({ type: "file_changed", path: "src/identity.ts", callId: "edit_i" });
  b.fact({ type: "git_hunk", file: "src/identity.ts", added: 41, removed: 12, isFormattingOnly: false, isConfigOnly: false, isLockfile: false }, "fact_i");
  b.unit({ id: "cu_identity", title: "Identity linking", files: ["src/identity.ts", "src/google.ts"], evidence: ["fact_i"], agentCallIds: ["edit_i"] });
}

/** RightPanel beside the real KeyboardLayer, so Shift+B and Esc travel the same path as in the viewer. */
function KeyedPanel({ children }: { children: ReactNode }) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setRoot}>
      <main data-region="main" tabIndex={-1} />
      <aside data-region="inspector">{children}</aside>
      <KeyboardLayer root={root} />
    </div>
  );
}

describe("Brief (spec §3.3, E4)", () => {
  it("fills the panel when nothing is selected, gives way to the Inspector on a selection, and Shift+B pins it back", () => {
    const session = foldFixture("oauth");
    const step = session.steps[2];
    if (step === undefined) throw new Error("oauth has fewer than 3 steps");
    const h = renderHarness(<RightPanel host={{}} />, session);
    expect(screen.getByRole("heading", { name: "Brief" })).toBeTruthy();
    for (const name of ["Now", "Changes so far", "Architecture"]) expect(screen.getByRole("heading", { name })).toBeTruthy();
    act(() => h.store.dispatch({ type: "select", id: step.id, by: "shell" }));
    expect(screen.queryByRole("heading", { name: "Brief" })).toBeNull();
    expect(screen.getByRole("tablist", { name: "Inspector tabs" })).toBeTruthy();
    act(() => h.store.dispatch({ type: "brief/toggle" }));
    expect(screen.getByRole("heading", { name: "Brief" })).toBeTruthy();
    act(() => h.store.dispatch({ type: "select", id: null, by: "shell" }));
    expect(screen.getByRole("heading", { name: "Brief" })).toBeTruthy();
  });

  it("lists every current unit and opens one in the active view on click", () => {
    const { session, model } = oauthModel();
    const { onSelect } = renderView(model);
    const list = within(screen.getByRole("list", { name: "Changes so far" }));
    expect(list.getAllByRole("button")).toHaveLength(Math.min(model.changes.length, 8));
    const first = model.changes[0];
    if (first === undefined) throw new Error("oauth has no change units");
    fireEvent.click(list.getAllByRole("button")[0] as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith(first.unitId);
    expect(session.chapters.some((chapter) => chapter.id === first.unitId)).toBe(true);
  });

  it("renders untrusted titles as tokens, with the full text as the accessible name", () => {
    const { model } = oauthModel();
    const first = model.changes[0];
    if (first === undefined) throw new Error("oauth has no change units");
    renderView({ ...model, changes: [{ ...first, title: "Fix \u202Elogin\u0007" }] });
    const button = within(screen.getByRole("list", { name: "Changes so far" })).getByRole("button");
    expect(button.textContent).toContain("Fix ⟨U+202E⟩login⟨U+0007⟩");
    expect(button.textContent).not.toContain("\u202E");
    expect(button.getAttribute("aria-label")).toContain("Fix ⟨U+202E⟩login⟨U+0007⟩");
  });

  it("draws a long test run as at most five dots that keep its failure, with the exact counts in the accessible name", () => {
    const { model } = oauthModel();
    const first = model.changes[0];
    if (first === undefined) throw new Error("oauth has no change units");
    renderView({
      ...model,
      changes: [
        { ...first, tests: { passed: 14, failed: 1 } },
        { ...first, unitId: `${first.unitId}-b`, tests: { passed: 0, failed: 9 } },
        { ...first, unitId: `${first.unitId}-c`, tests: { passed: 2, failed: 1 } },
      ],
    });
    const [long, allFailed, short] = within(screen.getByRole("list", { name: "Changes so far" })).getAllByRole("button");
    const dots = (row: HTMLElement | undefined, state: string): number => row?.querySelectorAll(`circle[data-state="${state}"]`).length ?? -1;
    expect([dots(long, "passed"), dots(long, "failed")]).toEqual([4, 1]);
    expect(long?.getAttribute("aria-label")).toContain("14 passed, 1 failed");
    expect([dots(allFailed, "passed"), dots(allFailed, "failed")]).toEqual([0, 5]);
    expect([dots(short, "passed"), dots(short, "failed")]).toEqual([2, 1]);
  });

  it("shows quiet Architecture states and never an error banner", () => {
    const { model } = oauthModel();
    renderView(model);
    expect(screen.getByText("Appears here once this repository is scanned.")).toBeTruthy();
    cleanup();

    renderView({ ...model, architecture: { overviewSentences: null, componentCount: 12, touched: ["cmp_0123456789ab"], scanning: null } });
    expect(screen.getByText("12 components · 1 touched")).toBeTruthy();
    expect(screen.getByText("Descriptions pending")).toBeTruthy();
    cleanup();

    renderView({ ...model, architecture: { overviewSentences: null, componentCount: 0, touched: [], scanning: { done: 3200, total: 9800 } } });
    expect(screen.getByText("Mapping codebase · 3,200 / 9,800 files")).toBeTruthy();
    cleanup();

    const { onOpenMap } = renderView({
      ...model,
      architecture: {
        overviewSentences: [{ text: "A pnpm workspace with an Electron \u202Eapp.", citations: [{ kind: "component", id: "cmp_0123456789ab" }] }],
        componentCount: 12,
        touched: [],
        scanning: null,
      },
    });
    expect(screen.getByText("A pnpm workspace with an Electron ⟨U+202E⟩app.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open the map" }));
    expect(onOpenMap).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Now shows the running step, the latest change and the open decision with a way to it, untrusted text as tokens", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Add OAuth" });
    unitRows(b);
    b.decision({ id: "d1", title: "Keep \u202Epassword login?" });
    b.agent({ type: "command_started", command: "pnpm test --filter \u202Eauth" });
    const session = foldLive(b, "running");
    const { onSelect } = renderSession(session);
    const now = within(screen.getByRole("heading", { name: "Now" }).parentElement as HTMLElement);
    if (!session.steps.some((step) => step.status === "running" && step.kind === "test")) throw new Error("no running test run");
    const runningRow = now.getByRole("button", { name: /pnpm test/ });
    expect(runningRow.textContent).not.toContain("\u202E");
    expect(runningRow.getAttribute("title")).toContain("--filter ⟨U+202E⟩auth");
    expect(runningRow.textContent).toContain("12 s");
    expect(now.getByRole("button", { name: "Latest change: Identity linking" })).toBeTruthy();
    const decision = now.getByRole("button", { name: /Needs your decision/ });
    expect(decision.textContent).toContain("Keep ⟨U+202E⟩password login?");
    fireEvent.click(decision);
    const decisionStep = session.steps.find((step) => step.decision?.decisionId === "d1");
    expect(onSelect).toHaveBeenLastCalledWith(decisionStep?.id);
    expect(screen.getByText("Live")).toBeTruthy();
  });

  it("Now reads the session's phase: before the first event, between steps while live, and finished", () => {
    renderSession(foldLive(new TraceBuilder(), "starting"));
    expect(screen.getByText("Waiting for the agent's first event")).toBeTruthy();
    expect(screen.getByText("No changes yet")).toBeTruthy();
    expect(screen.getByText("Starting")).toBeTruthy();
    cleanup();

    // A session that ended before its first event: Now follows the header's state.
    renderSession(foldLive(new TraceBuilder(), "completed"));
    const ended = within(screen.getByRole("heading", { name: "Now" }).parentElement as HTMLElement);
    expect(ended.getByText("Completed")).toBeTruthy();
    expect(screen.queryByText("Waiting for the agent's first event")).toBeNull();
    cleanup();

    const between = new TraceBuilder();
    between.agent({ type: "agent_started", prompt: "Add OAuth" });
    between.agent({ type: "agent_message", role: "assistant", text: "The email comparison was case-sensitive.\nNormalizing before the lookup." });
    between.jev({ id: "jev_1", clamps: [] });
    const live = foldLive(between, "running");
    expect(live.steps.at(-1)?.lane).toBe("jev");
    const { onSelect } = renderSession(live);
    const message = screen.getByRole("button", { name: /The email comparison was case-sensitive\./ });
    expect(message.getAttribute("title")).toContain("Normalizing before the lookup.");
    fireEvent.click(message);
    expect(onSelect).toHaveBeenCalledWith(live.steps.find((step) => step.kind === "message")?.id);
    expect(screen.getByText("No changes yet")).toBeTruthy();
    cleanup();

    const finished = new TraceBuilder();
    finished.agent({ type: "agent_started", prompt: "Add OAuth" });
    unitRows(finished);
    finished.agent({ type: "agent_completed" });
    const done = foldLive(finished, "completed");
    renderSession(done);
    const now = within(screen.getByRole("heading", { name: "Now" }).parentElement as HTMLElement);
    expect(now.getByText("Completed")).toBeTruthy();
    expect(now.getByRole("button", { name: "Latest change: Identity linking" })).toBeTruthy();
    expect(now.queryByRole("button", { name: /Needs your decision/ })).toBeNull();
    expect(screen.getByText(/^Completed · /)).toBeTruthy();
    const change = within(screen.getByRole("list", { name: "Changes so far" })).getByRole("button");
    expect(change.getAttribute("aria-label")).toBe("Identity linking, 2 files, +41 −12");
    expect(change.getAttribute("title")).toBe("Identity linking\nsrc/identity.ts\nsrc/google.ts");
  });

  it("before any change unit, lists the edited files newest first under a quiet note", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Add OAuth" });
    const paths = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts", "src/auth/\u202Eevil.ts"];
    paths.forEach((path, i) => {
      b.agent({ type: "file_changed", path, callId: `edit_${i}` });
      b.fact({ type: "git_hunk", file: path, added: i + 1, removed: 0, isFormattingOnly: false, isConfigOnly: false, isLockfile: false });
    });
    const session = foldLive(b, "running");
    expect(session.chapters).toHaveLength(0);
    const { onSelect } = renderSession(session);
    expect(screen.getByText("7 files edited · not grouped yet")).toBeTruthy();
    expect(screen.queryByText("No changes yet")).toBeNull();
    const rows = within(screen.getByRole("list", { name: "Files edited" })).getAllByRole("button");
    expect(rows).toHaveLength(5);
    const newest = rows[0] as HTMLElement;
    expect(newest.getAttribute("aria-label")).toBe("src/auth/⟨U+202E⟩evil.ts, +7 −0");
    expect(newest.getAttribute("title")).toBe("src/auth/⟨U+202E⟩evil.ts");
    expect(newest.textContent).not.toContain("\u202E");
    expect(rows[1]?.getAttribute("aria-label")).toBe("src/f.ts, +6 −0");
    expect(screen.getByText("2 more")).toBeTruthy();
    fireEvent.click(newest);
    expect(onSelect).toHaveBeenCalledWith(session.entities.find((entity) => entity.path === paths[6])?.stepIds.at(-1));
  });

  it("gives each rendered Brief its own heading ids", () => {
    const { model } = oauthModel();
    const session = foldFixture("oauth");
    const index = buildTraceIndex(session);
    const view = (): JSX.Element => (
      <BriefView model={model} session={session} index={index} nowT={0} onSelect={vi.fn()} onOpenMap={vi.fn()} mapAvailable />
    );
    render(
      <>
        {view()}
        {view()}
      </>,
    );
    for (const name of ["Brief", "Now", "Changes so far", "Architecture"]) {
      const ids = screen.getAllByRole("heading", { name }).map((heading) => heading.id);
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size, name).toBe(2);
    }
  });

  it("Shift+B switches the panel between the Inspector and the Brief, and Esc from a selection returns to the Brief", () => {
    const session = foldFixture("oauth");
    const step = session.steps.find((item) => item.chapterIds.length === 0 && item.findingIds.length === 0);
    if (step === undefined) throw new Error("oauth has no step outside a chapter");
    const h = renderHarness(
      <KeyedPanel>
        <RightPanel host={{}} />
      </KeyedPanel>,
      session,
    );
    const shiftB = (): void => {
      fireEvent.keyDown(document.body, { code: "KeyB", key: "B", shiftKey: true });
    };
    act(() => h.store.dispatch({ type: "select", id: step.id, by: "shell" }));
    expect(screen.queryByRole("heading", { name: "Brief" })).toBeNull();
    shiftB();
    expect(screen.getByRole("heading", { name: "Brief" })).toBeTruthy();
    shiftB();
    expect(screen.queryByRole("heading", { name: "Brief" })).toBeNull();
    fireEvent.keyDown(document.body, { code: "Escape", key: "Escape" });
    expect(h.store.get().selection).toBeNull();
    expect(screen.getByRole("heading", { name: "Brief" })).toBeTruthy();

    // Pinned over a step inside a chapter, Esc clears the selection instead of stepping out to the chapter's Inspector.
    const inner = session.steps.find((item) => item.chapterIds.length > 0);
    if (inner === undefined) throw new Error("oauth has no step inside a chapter");
    act(() => h.store.dispatch({ type: "select", id: inner.id, by: "shell" }));
    shiftB();
    fireEvent.keyDown(document.body, { code: "Escape", key: "Escape" });
    expect(h.store.get().selection).toBeNull();
    expect(screen.getByRole("heading", { name: "Brief" })).toBeTruthy();
  });

  it("the title bar's Brief toggle pins the Brief over a selection", () => {
    const session = foldFixture("oauth");
    const step = session.steps[2];
    if (step === undefined) throw new Error("oauth has fewer than 3 steps");
    const h = renderHarness(<TitleBar onRetry={noop} />, session);
    const toggle = screen.getByRole("button", { name: "Brief" });
    expect(toggle.hasAttribute("disabled")).toBe(true);
    act(() => h.store.dispatch({ type: "select", id: step.id, by: "shell" }));
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(h.store.get().brief).toBe(true);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });

  describe("focus when the panel switches under it (lane fix I-5)", () => {
    function setup() {
      const session = foldFixture("oauth");
      const step = session.steps.find((item) => item.chapterIds.length === 0 && item.findingIds.length === 0);
      if (step === undefined) throw new Error("oauth has no step outside a chapter");
      const h = renderHarness(
        <KeyedPanel>
          <RightPanel host={{}} />
        </KeyedPanel>,
        session,
      );
      act(() => h.store.dispatch({ type: "select", id: step.id, by: "shell" }));
      const panel = document.querySelector<HTMLElement>('[data-region="inspector"]');
      if (panel === null) throw new Error("no panel");
      return { h, panel };
    }
    const focusInPanel = (panel: HTMLElement): HTMLElement => {
      const target = panel.querySelector<HTMLElement>("button, [tabindex]");
      if (target === null) throw new Error("nothing focusable in the panel");
      act(() => target.focus());
      expect(panel.contains(document.activeElement)).toBe(true);
      return target;
    };
    const brief = (): HTMLElement | null => document.querySelector<HTMLElement>("[data-brief]");

    it("Esc clearing a selection with focus in the Inspector moves focus to the Brief, not <body>", () => {
      const { h, panel } = setup();
      const target = focusInPanel(panel);
      fireEvent.keyDown(target, { code: "Escape", key: "Escape" });
      expect(h.store.get().selection).toBeNull();
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toBe(brief());
    });

    it("Shift+B with focus in the panel keeps focus: into the Brief, then back to the view's tab stop", () => {
      const { panel } = setup();
      const target = focusInPanel(panel);
      fireEvent.keyDown(target, { code: "KeyB", key: "B", shiftKey: true });
      expect(document.activeElement).toBe(brief());
      fireEvent.keyDown(document.activeElement ?? document.body, { code: "KeyB", key: "B", shiftKey: true });
      expect(brief()).toBeNull();
      expect(document.activeElement).toBe(document.querySelector('[data-region="main"]'));
    });

    it("leaves focus alone when it was outside the panel", () => {
      const { h } = setup();
      const main = document.querySelector<HTMLElement>('[data-region="main"]');
      act(() => main?.focus());
      act(() => h.store.dispatch({ type: "select", id: null, by: "shell" }));
      expect(document.activeElement).toBe(main);
    });
  });
});
