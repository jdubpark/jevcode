// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { layoutCanvas, type CanvasFrame } from "../../../layout/canvas-layout.js";
import { buildTraceIndex } from "../../../layout/trace-index.js";
import { displayUntrusted, type Level, type TraceSession } from "../../../model/index.js";
import { buildCanvasSession, canvasScale, oauthCanvasSession, oauthReplaySession } from "../../../test-support/canvas-arbitraries.js";
import { Frame } from "./Frame.js";
import styles from "./Frame.module.css";
import { buildFrameContext } from "./frame-label.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderFrame(
  session: TraceSession,
  predicate: (frame: CanvasFrame) => boolean,
  options: { level?: Level; expanded?: boolean } = {},
) {
  const level = options.level ?? "chapter";
  const layout = layoutCanvas(session, buildTraceIndex(session), canvasScale(session), level);
  const frame = layout.frames.find(predicate);
  if (frame === undefined) throw new Error("frame not found");
  const onSelect = vi.fn();
  const onToggle = vi.fn();
  const view = render(
    <Frame
      frame={frame}
      level={level}
      ctx={buildFrameContext(session)}
      selected={false}
      focusTarget
      expanded={options.expanded ?? false}
      onSelect={onSelect}
      onToggle={onToggle}
    />,
  );
  return { frame, onSelect, onToggle, view };
}

/** A chapter holding 20 build commands and its own edit: 21 steps, one Step-level list. */
function longChapterSession(): TraceSession {
  const base = buildCanvasSession([
    ...Array.from({ length: 20 }, (_, i) => ({ atMs: 1_000 * (i + 1), kind: "work" as const })),
    { atMs: 21_000, kind: "chapter" as const },
  ]);
  const session: TraceSession = structuredClone(base);
  const chapter = session.chapters[0];
  if (chapter === undefined) throw new Error("no chapter");
  const workIds = session.steps.filter((step) => step.kind === "command").map((step) => step.id);
  chapter.stepIds = [...workIds, ...chapter.stepIds];
  for (const step of session.steps) if (workIds.includes(step.id)) step.chapterIds = [chapter.id];
  return session;
}

/** jsdom lays nothing out: give the list the overflow a real 216 px list of 9+ rows has, or none. */
function stubListBox(list: HTMLElement, box: { scrollHeight: number; clientHeight: number }): void {
  Object.defineProperty(list, "scrollHeight", { configurable: true, value: box.scrollHeight });
  Object.defineProperty(list, "clientHeight", { configurable: true, value: box.clientHeight });
}

describe("Frame", () => {
  it("is a focusable group named by its label", () => {
    renderFrame(oauthCanvasSession(), (frame) => frame.selId === "unit:oauth-linking-test-failure");
    const group = screen.getByRole("group");
    expect(group.getAttribute("aria-label")).toBe("OAuth account-linking test failure, 1 failed, 14 passed, +0:33");
    expect(group.getAttribute("tabindex")).toBe("0");
  });

  it("claim text with markup renders as text and an out-of-range span draws no underline", () => {
    const hostile = "<img src=x onerror=alert(1)> rm ‮fdp.exe: all checks pass";
    const shown = displayUntrusted(hostile);
    const session = buildCanvasSession([
      { atMs: 1_000, kind: "loose" },
      { atMs: 6_000, kind: "claim", flagged: true, title: hostile },
    ]);
    const first = renderFrame(session, (frame) => frame.item === "claim");
    expect(first.view.container.querySelector("img")).toBeNull();
    const text = screen.getByRole("group").textContent ?? "";
    expect(text).toContain(shown);
    expect(text).not.toContain("‮");
    // The span covers the whole claim here, so the underline holds exactly the sanitized text.
    expect(first.view.container.querySelector("mark")?.textContent).toBe(shown);
    cleanup();
    const broken: TraceSession = structuredClone(session);
    for (const finding of broken.findings) {
      if (finding.ruleId === "claim_contradicted") finding.claimSpan = [5, 9_999];
    }
    const second = renderFrame(broken, (frame) => frame.item === "claim");
    expect(second.view.container.querySelector("mark")).toBeNull();
    expect(screen.getByRole("group").textContent).toContain(shown);
  });

  it("underlines exactly oauth's claimed span", () => {
    const { view } = renderFrame(oauthCanvasSession(), (frame) => frame.item === "claim");
    expect(view.container.querySelector("mark")?.textContent).toBe("all checks pass");
    expect(screen.getByRole("group").textContent).toBe("OAuth implementation complete; all checks pass.");
  });

  it("shows a step list at Step level whose wheel scrolls the list unless Ctrl or Meta is held", () => {
    const { view } = renderFrame(longChapterSession(), (frame) => frame.kind === "chapter", { level: "step" });
    const parentWheel = vi.fn();
    view.container.addEventListener("wheel", parentWheel);
    const list = screen.getByRole("list", { name: "Steps" });
    expect(list.querySelectorAll("li")).toHaveLength(9);
    stubListBox(list, { scrollHeight: 400, clientHeight: 216 });
    list.dispatchEvent(new WheelEvent("wheel", { deltaY: 40, bubbles: true }));
    expect(parentWheel).not.toHaveBeenCalled();
    list.dispatchEvent(new WheelEvent("wheel", { deltaY: 40, ctrlKey: true, bubbles: true }));
    list.dispatchEvent(new WheelEvent("wheel", { deltaY: 40, metaKey: true, bubbles: true }));
    expect(parentWheel).toHaveBeenCalledTimes(2);
  });

  it("lets the wheel pan the canvas over a list with nothing to scroll or a sideways swipe", () => {
    const { view } = renderFrame(longChapterSession(), (frame) => frame.kind === "chapter", { level: "step" });
    const parentWheel = vi.fn();
    view.container.addEventListener("wheel", parentWheel);
    const list = screen.getByRole("list", { name: "Steps" });
    stubListBox(list, { scrollHeight: 400, clientHeight: 216 });
    list.dispatchEvent(new WheelEvent("wheel", { deltaX: 60, deltaY: 4, bubbles: true }));
    stubListBox(list, { scrollHeight: 216, clientHeight: 216 });
    list.dispatchEvent(new WheelEvent("wheel", { deltaY: 40, bubbles: true }));
    expect(parentWheel).toHaveBeenCalledTimes(2);
  });

  it("names every step row and a collapsed band in the Step list", () => {
    renderFrame(longChapterSession(), (frame) => frame.kind === "chapter", { level: "step" });
    const rows = [...screen.getByRole("list", { name: "Steps" }).querySelectorAll("li")].map((li) => li.textContent);
    expect(rows[0]).toContain("pnpm build");
    expect(rows[3]).toBe("13 more steps");
  });

  it("renders a chip at Session level and the graphic part at Chapter level", () => {
    const session = oauthCanvasSession();
    const atChapter = renderFrame(session, (frame) => frame.selId === "unit:oauth-linking-test-failure");
    expect(atChapter.view.container.querySelector('[data-part="graphic"]')).not.toBeNull();
    cleanup();
    const atSession = renderFrame(session, (frame) => frame.selId === "unit:oauth-linking-test-failure", {
      level: "session",
    });
    expect(atSession.view.container.querySelector('[data-part="graphic"]')).toBeNull();
    const chapter = session.chapters.find((candidate) => candidate.id === "unit:oauth-linking-test-failure");
    const group = screen.getByRole("group");
    // The chip reads the short title; the full title is its tooltip and starts the group's name.
    expect(group.textContent).toContain(chapter?.shortTitle);
    expect(group.querySelector(`[title="${chapter?.title ?? ""}"]`)).not.toBeNull();
    expect(group.getAttribute("aria-label")?.startsWith("OAuth account-linking test failure, ")).toBe(true);
  });

  it("shows a failed test chapter's counts with the word, not color alone", () => {
    renderFrame(oauthCanvasSession(), (frame) => frame.selId === "unit:oauth-linking-test-failure");
    const group = screen.getByRole("group");
    expect(group.getAttribute("data-tone")).toBe("bad");
    expect(group.textContent).toContain("1 failed");
    // The pass count is its own element next to the check mark, not a digit run inside another number.
    expect(within(group).getByText("14").className).toBe(styles.passCount);
  });

  it("puts the tests card's duration bar in the graphic part and ends a failed run in a red dot", () => {
    const { view } = renderFrame(oauthCanvasSession(), (frame) => frame.selId === "unit:oauth-linking-test-failure");
    const dot = view.container.querySelector('[data-end="bad_dot"]');
    expect(dot).not.toBeNull();
    // Below GRAPHIC_MIN_K the zoom band hides every [data-part="graphic"], the run's bar included.
    expect(dot?.closest('[data-part="graphic"]')).not.toBeNull();
  });

  it("keeps a multi-line claim's line breaks instead of showing U+000A tokens", () => {
    for (const flagged of [false, true]) {
      const session = buildCanvasSession([
        { atMs: 1_000, kind: "loose" },
        { atMs: 6_000, kind: "claim", flagged, title: "Done.\nAll checks pass." },
      ]);
      renderFrame(session, (frame) => frame.item === "claim");
      const text = screen.getByRole("group").textContent ?? "";
      expect(text).toBe("Done.\nAll checks pass.");
      cleanup();
    }
  });

  it("toggles expansion on Enter from the frame itself, not with a modifier or from inside", () => {
    const { frame, onToggle, view } = renderFrame(oauthCanvasSession(), (candidate) => candidate.item === "decision");
    const group = screen.getByRole("group");
    const event = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true });
    group.dispatchEvent(event);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(frame);
    expect(event.defaultPrevented).toBe(true);
    fireEvent.keyDown(group, { key: "Enter", code: "Enter", metaKey: true });
    fireEvent.keyDown(group, { key: "Enter", code: "Enter", shiftKey: true });
    fireEvent.keyDown(group, { key: " ", code: "Space" });
    const inner = view.container.querySelector("li");
    if (inner === null) throw new Error("no option row");
    fireEvent.keyDown(inner, { key: "Enter", code: "Enter" });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("draws the decision's fork on the decision frame only; the identity chapter lists its files", () => {
    const identity = renderFrame(oauthCanvasSession(), (frame) => frame.selId === "unit:oauth-identity-layer");
    expect(identity.view.container.querySelector('[data-graphic="fork"]')).toBeNull();
    // Four files, three rows fit the 112 px card (C3-6 re-review N-1); the fourth is counted in "+1 more".
    const files = [...identity.view.container.querySelectorAll<HTMLElement>("[data-file]")];
    expect(files.map((file) => file.dataset.file)).toEqual(["src/auth/google.ts", "src/auth/identity.ts", "src/auth/service.ts"]);
    expect(identity.view.container.querySelector("[data-more-files]")?.textContent).toBe("+1 more");
    // Each row carries its own counts; no total floats beside the list.
    expect(files[0]?.textContent).toMatch(/\+\d+/u);
    cleanup();
    const policy = renderFrame(oauthCanvasSession(), (frame) => frame.selId === "unit:oauth-account-linking-decision");
    expect(policy.view.container.querySelector('[data-graphic="fork"]')).toBeNull();
    cleanup();
    const decision = renderFrame(oauthCanvasSession(), (frame) => frame.item === "decision");
    expect(decision.view.container.querySelector('[data-graphic="fork"]')).not.toBeNull();
  });

  it("fills a sparse chapter card with up to three compact step rows, newest problem first", () => {
    const session = oauthCanvasSession();
    const dependency = renderFrame(session, (frame) => frame.selId === "unit:oauth-dependency");
    const fill = dependency.view.container.querySelector('[data-part="fill"]');
    const rows = [...(fill?.querySelectorAll("li") ?? [])];
    // Two steps, newest first: the package.json edit, then the dependency it added.
    expect(rows.map((row) => row.textContent)).toEqual(["package.json+0:20", "+google-auth-library+0:14"]);
    expect(rows.every((row) => row.querySelector("svg use") !== null)).toBe(true);
    cleanup();
    // A four-file list already fills the Identity card; the tests card is full too.
    const identity = renderFrame(session, (frame) => frame.selId === "unit:oauth-identity-layer");
    expect(identity.view.container.querySelector('[data-part="fill"]')).toBeNull();
    cleanup();
    const tests = renderFrame(session, (frame) => frame.selId === "unit:oauth-linking-test-failure");
    expect(tests.view.container.querySelector('[data-part="fill"]')).toBeNull();
    cleanup();
    // Step level shows the whole list instead.
    const atStep = renderFrame(session, (frame) => frame.selId === "unit:oauth-dependency", { level: "step" });
    expect(atStep.view.container.querySelector('[data-part="fill"]')).toBeNull();
  });

  it("fills with sanitized headlines", () => {
    const session: TraceSession = structuredClone(oauthCanvasSession());
    const added = session.steps.find((step) => step.id === "step:12");
    if (added === undefined) throw new Error("no dependency step");
    added.headline = "pnpm add \u202Eevil";
    renderFrame(session, (frame) => frame.selId === "unit:oauth-dependency");
    const text = screen.getByRole("group").textContent ?? "";
    expect(text).toContain(displayUntrusted("pnpm add \u202Eevil"));
    expect(text).not.toContain("\u202E");
  });

  it("keeps a Session chip's guardrail shield neutral when no clamp step is bad", () => {
    const session: TraceSession = structuredClone(oauthCanvasSession());
    const chapter = session.chapters.find((candidate) => candidate.id === "unit:oauth-dependency");
    if (chapter === undefined) throw new Error("no chapter");
    chapter.clampIds = ["clamp-1"];
    const { view } = renderFrame(session, (frame) => frame.selId === "unit:oauth-dependency", { level: "session" });
    const shield = view.container.querySelector('[data-flag="shield"]');
    expect(shield).not.toBeNull();
    expect(shield?.getAttribute("class")).not.toContain(styles.flagBad);
  });

  it("lists a shared failed run only in the chapter that owns it (replay-shaped oauth, lane review I-2)", () => {
    const replay = oauthReplaySession();
    const other = renderFrame(replay, (frame) => frame.selId === "unit:cu_78093dbe9212089d", { level: "step" });
    const otherText = other.view.container.textContent ?? "";
    expect(otherText).not.toContain("pnpm test");
    expect(otherText).not.toContain("failed");
    cleanup();
    const owner = renderFrame(replay, (frame) => frame.selId === "unit:cu_a2589fe62ff19ebf", { level: "step" });
    expect(owner.view.container.textContent ?? "").toContain("pnpm test");
    cleanup();
    const card = renderFrame(replay, (frame) => frame.selId === "unit:cu_78093dbe9212089d");
    expect(card.view.container.textContent ?? "").toContain("3 steps");
    expect(card.view.container.textContent ?? "").not.toContain("pnpm test");
  });

  it("lists the plan's items", () => {
    renderFrame(oauthCanvasSession(), (frame) => frame.item === "plan");
    const items = [...screen.getByRole("list", { name: "Plan" }).querySelectorAll("li")].map((li) => li.textContent);
    expect(items).toEqual([
      "introduce an Identity layer",
      "add a Google OAuth provider",
      "wire a callback route",
      "add a migration for the identities table",
    ]);
  });

  it("shows the decision's options with the chosen one marked", () => {
    renderFrame(oauthCanvasSession(), (frame) => frame.item === "decision");
    const group = screen.getByRole("group");
    const chosen = group.querySelector('[data-chosen="true"]');
    expect(chosen?.textContent).toBe("Require explicit linking");
    expect(group.textContent).toContain("Match by email");
  });

  it("selects on click and toggles on double click", () => {
    const { frame, onSelect, onToggle } = renderFrame(oauthCanvasSession(), (candidate) => candidate.item === "decision");
    fireEvent.click(screen.getByRole("group"));
    expect(onSelect).toHaveBeenCalledWith(frame);
    fireEvent.doubleClick(screen.getByRole("group"));
    expect(onToggle).toHaveBeenCalledWith(frame);
  });
});
