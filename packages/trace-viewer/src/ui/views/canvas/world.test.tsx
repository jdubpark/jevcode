// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, fireEvent, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { layoutCanvas, type CanvasFrame, type CanvasLayout } from "../../../layout/canvas-layout.js";
import { LEVEL_SPECS } from "../../../layout/canvas-levels.js";
import { samplePath } from "../../../layout/canvas-routes.js";
import { buildTraceIndex } from "../../../layout/trace-index.js";
import { displayUntrusted, type TraceSession } from "../../../model/index.js";
import { canvasScale, oauthCanvasSession, oauthReplaySession } from "../../../test-support/canvas-arbitraries.js";
import { drawnEdges } from "./EdgeLayer.js";
import type { FrameProps } from "./Frame.js";
import { buildFrameContext, frameFullTitle, frameTitle } from "./frame-label.js";
import { Overlay, badgeSide, labelRectAt, showsLabelOffsets, timeChipPlacement, timeChipRect } from "./Overlay.js";
import { World, cullFrames, focusFrameElement, type WorldProps } from "./World.js";
import styles from "./World.module.css";

// Records every Frame render (key and nowMs) while rendering the real, memoized Frame.
const renders = vi.hoisted(() => [] as Array<{ key: string; nowMs: number | null | undefined }>);
vi.mock("./Frame.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./Frame.js")>();
  const { createElement, memo } = await import("react");
  const Inner = actual.Frame;
  function Recorded(props: FrameProps) {
    renders.push({ key: props.frame.key, nowMs: props.nowMs });
    return createElement(Inner, props);
  }
  return { ...actual, Frame: memo(Recorded) };
});

beforeEach(() => {
  renders.length = 0;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Expected values: spec §7.5 (edges table, oauth table, zoom bands), R17 (world, edge svg, overlay, hit twin, focus),
// the canvas mockup (badge worded "contradicts", time chip "+0:33 – 0:40", written "+0:33 – +0:40" in the shared range format) and lane rulings (CULL_FRAMES, nowMs).

const session = oauthCanvasSession();
const layout = layoutCanvas(session, buildTraceIndex(session), canvasScale(session), "chapter");
const ctx = buildFrameContext(session);

function frame(predicate: (candidate: CanvasFrame) => boolean): CanvasFrame {
  const found = layout.frames.find(predicate);
  if (found === undefined) throw new Error("frame not found");
  return found;
}

const linkingTest = frame((candidate) => candidate.selId === "unit:oauth-linking-test-failure");
const intent = frame((candidate) => candidate.item === "intent");
const claim = frame((candidate) => candidate.item === "claim");

function renderWorld(overrides: Partial<WorldProps> = {}) {
  const selectedKey = overrides.selectedKey ?? null;
  const props: WorldProps = {
    layout,
    ctx,
    level: "chapter",
    selectedKey,
    expanded: new Set<string>(),
    tool: "select",
    cullRange: null,
    viewportRef: createRef<HTMLDivElement>(),
    worldRef: createRef<HTMLDivElement>(),
    overlay: <Overlay layout={layout} ctx={ctx} level="chapter" selectedKey={selectedKey} onSelect={() => undefined} />,
    onSelect: vi.fn(),
    onToggle: vi.fn(),
    onSelectEdge: vi.fn(),
    ...overrides,
  };
  return { props, view: render(<World {...props} />) };
}

function frameElements(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="group"][data-key]')];
}

describe("World", () => {
  it("renders frames in DOM time order with exactly one tab stop", () => {
    renderWorld();
    expect(frameElements().map((element) => element.dataset.key)).toEqual(layout.frames.map((candidate) => candidate.key));
    expect(frameElements().filter((element) => element.getAttribute("tabindex") === "0")).toHaveLength(1);
    expect(frameElements()[0]?.getAttribute("tabindex")).toBe("0");
    cleanup();
    renderWorld({ selectedKey: linkingTest.key });
    const stops = frameElements().filter((element) => element.getAttribute("tabindex") === "0");
    expect(stops.map((element) => element.dataset.key)).toEqual([linkingTest.key]);
  });

  it("marks the viewport pannable for the Space hand tool", () => {
    const { view } = renderWorld();
    expect(view.container.querySelector('[data-tv-viewport="canvas"]')?.hasAttribute("data-pannable")).toBe(true);
  });

  it("draws rest edges under the frames and lifted edges over them", () => {
    const { view } = renderWorld();
    const under = view.container.querySelector('svg[data-layer="under"]');
    const over = view.container.querySelector('svg[data-layer="over"]');
    const first = frameElements()[0];
    if (under === null || over === null || first === undefined) throw new Error("layers missing");
    expect(under.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(first.compareDocumentPosition(over) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const restUnder = layout.edges.filter((edge) => edge.rest && edge.shape !== "direct" && edge.d !== null);
    expect(under.querySelectorAll("[data-edge]")).toHaveLength(restUnder.length);
    expect(view.container.querySelector("marker")).toBeNull();
  });

  it("draws the selection's one-hop edges in accent, dims the rest and keeps contradicts red", () => {
    const { view } = renderWorld({ selectedKey: linkingTest.key });
    const contradicts = layout.edges.find((edge) => edge.kind === "contradicts");
    if (contradicts === undefined) throw new Error("no contradicts edge");
    const stroke = (id: string) => view.container.querySelector(`[data-edge="${id}"] [data-stroke]`)?.getAttribute("class") ?? "";
    expect(stroke(contradicts.id)).toContain(styles.hop);
    expect(stroke(contradicts.id)).toContain(styles.bad);
    expect(stroke(contradicts.id)).not.toContain(styles.dim);
    const other = layout.edges.find((edge) => edge.rest && edge.from !== linkingTest.key && edge.to !== linkingTest.key);
    if (other === undefined) throw new Error("no other rest edge");
    expect(stroke(other.id)).toContain(styles.dim);
    cleanup();
    // The trunk ends at the claim, but it is the turn's spine, not one of the claim's relations.
    const trunk = layout.edges.find((edge) => edge.kind === "trunk" && (edge.from === claim.key || edge.to === claim.key));
    if (trunk === undefined) throw new Error("no trunk at the claim");
    const atClaim = renderWorld({ selectedKey: claim.key });
    const trunkClass = atClaim.view.container.querySelector(`[data-edge="${trunk.id}"] [data-stroke]`)?.getAttribute("class") ?? "";
    expect(trunkClass).not.toContain(styles.hop);
    expect(trunkClass).toContain(styles.dim);
    cleanup();
    const rest = renderWorld();
    expect(rest.view.container.querySelector(`[data-edge="${contradicts.id}"] [data-stroke]`)?.getAttribute("class")).not.toContain(
      styles.dim,
    );
  });

  it("dims the halo of a dimmed lifted edge with its stroke", () => {
    const contradicts = layout.edges.find((edge) => edge.kind === "contradicts");
    if (contradicts === undefined) throw new Error("no contradicts edge");
    expect(contradicts.from === intent.key || contradicts.to === intent.key).toBe(false);
    const lifted: CanvasLayout = {
      ...layout,
      edges: layout.edges.map((edge) => (edge.id === contradicts.id ? { ...edge, shape: "direct" } : edge)),
    };
    const { view } = renderWorld({ layout: lifted, selectedKey: intent.key });
    const halo = view.container.querySelector(`[data-edge="${contradicts.id}"] path:first-child`);
    expect(halo?.getAttribute("class")).toContain(styles.halo);
    expect(halo?.getAttribute("class")).toContain(styles.dim);
    cleanup();
    const rest = renderWorld({ layout: lifted });
    expect(rest.view.container.querySelector(`[data-edge="${contradicts.id}"] path:first-child`)?.getAttribute("class")).not.toContain(
      styles.dim,
    );
  });

  it("keeps junction dots at screen size and renders a repeated junction without a key clash", () => {
    const point = layout.junctions[0];
    if (point === undefined) throw new Error("no junction");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const doubled: CanvasLayout = { ...layout, junctions: [point, point] };
    const { view } = renderWorld({ layout: doubled });
    expect(view.container.querySelectorAll('svg[data-layer="under"] circle')).toHaveLength(2);
    expect(error).not.toHaveBeenCalled();
    const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "World.module.css"), "utf8");
    expect(css).toContain("r: calc(2.5px * var(--tv-inv-k, 1))");
  });

  it("keeps label relayout out of zoom frames: width from --tv-kw, layout containment on overlay items", () => {
    const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "World.module.css"), "utf8");
    expect(css).toContain("max-width: calc(var(--w) * var(--tv-kw, 1) * 1px)");
    expect(css).not.toMatch(/max-width:[^;]*--tv-k,/);
    for (const item of ["label", "handle", "timeChip", "sepLabel", "badge"]) {
      const block = new RegExp(`^\\.${item} \\{[^}]*\\}`, "m").exec(css)?.[0] ?? "";
      expect(block, item).toContain("contain: layout style");
    }
  });

  it("keeps edge strokes at 1.5 CSS px through --tv-inv-k and never colors text with ink-4", () => {
    const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "World.module.css"), "utf8");
    expect(css).toContain("stroke-width: calc(1.5px * var(--tv-inv-k, 1))");
    expect(css).toContain("stroke-width: calc(2px * var(--tv-inv-k, 1))");
    expect(css).toContain("stroke-width: calc(8px * var(--tv-inv-k, 1))");
    expect(css).not.toMatch(/(^|[^-])color:\s*var\(--tv-ink-4\)/m);
  });

  it("gives the contradicts edge an 8 px hit twin and a worded badge", () => {
    const onSelectEdge = vi.fn();
    const { view } = renderWorld({ onSelectEdge });
    const hit = view.container.querySelector('[data-hit="contradicts"]');
    if (hit === null) throw new Error("no hit twin");
    fireEvent.click(hit);
    expect(onSelectEdge).toHaveBeenCalledWith(expect.objectContaining({ kind: "contradicts", tone: "bad" }));
    expect(view.container.querySelector("[data-badge]")?.textContent).toContain("contradicts");
  });

  it("focuses frames with preventScroll and undoes any browser scroll of the viewport", () => {
    const { view } = renderWorld();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const viewport = view.container.querySelector<HTMLElement>('[data-tv-viewport="canvas"]');
    if (viewport === null) throw new Error("no viewport");
    expect(focusFrameElement(viewport, linkingTest.key)).toBe(true);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect((document.activeElement as HTMLElement | null)?.dataset.key).toBe(linkingTest.key);
    expect(focusFrameElement(viewport, "no-such-frame")).toBe(false);
    Object.defineProperty(viewport, "scrollLeft", { value: 40, writable: true, configurable: true });
    Object.defineProperty(viewport, "scrollTop", { value: 12, writable: true, configurable: true });
    fireEvent.scroll(viewport);
    expect(viewport.scrollLeft).toBe(0);
    expect(viewport.scrollTop).toBe(0);
  });

  it("draws four handles and the time chip around the selection", () => {
    const { view } = renderWorld({ selectedKey: linkingTest.key });
    expect(view.container.querySelectorAll("[data-handle]")).toHaveLength(4);
    expect(view.container.querySelector("[data-time-chip]")?.textContent).toBe("+0:33 – +0:40");
  });

  it("renders an empty viewport while the session loads", () => {
    const { view } = renderWorld({ layout: null, ctx: null, overlay: null });
    expect(view.container.querySelector('[data-tv-viewport="canvas"]')).not.toBeNull();
    expect(frameElements()).toEqual([]);
  });

  it("keeps the selection and the tab stop mounted when culling leaves them out", () => {
    renderWorld({ selectedKey: claim.key, cullRange: { x0: 500, x1: 760 } });
    const keys = frameElements().map((element) => element.dataset.key);
    expect(keys).toContain(claim.key);
    expect(keys).toEqual(layout.frames.map((candidate) => candidate.key).filter((key) => keys.includes(key)));
    expect(keys.length).toBeLessThan(layout.frames.length);
    const stop = frameElements().filter((element) => element.getAttribute("tabindex") === "0");
    expect(stop.map((element) => element.dataset.key)).toEqual([claim.key]);
    cleanup();
    renderWorld({ cullRange: { x0: 500, x1: 760 } });
    expect(frameElements()[0]?.dataset.key).toBe(layout.frames[0]?.key);
    expect(frameElements()[0]?.getAttribute("tabindex")).toBe("0");
  });

  it("passes nowMs only to frames with a running step and re-renders only those on the tick", () => {
    const live: TraceSession = structuredClone(session);
    const run = live.steps.find((step) => step.command?.command === "pnpm test");
    if (run === undefined) throw new Error("no pnpm test step");
    run.endTMs = null;
    run.endTs = null;
    run.durationMs = null;
    run.status = "running";
    const liveLayout = layoutCanvas(live, buildTraceIndex(live), canvasScale(live), "chapter");
    const liveCtx = buildFrameContext(live);
    const test = liveLayout.frames.find((candidate) => candidate.selId === "unit:oauth-linking-test-failure");
    const first = liveLayout.frames.find((candidate) => candidate.item === "intent");
    if (test === undefined || first === undefined) throw new Error("frames missing");
    const { props, view } = renderWorld({ layout: liveLayout, ctx: liveCtx, overlay: null, nowMs: run.startMs + 2_000 });
    expect(renders.find((entry) => entry.key === test.key)?.nowMs).toBe(run.startMs + 2_000);
    expect(renders.find((entry) => entry.key === first.key)?.nowMs).toBeUndefined();
    renders.length = 0;
    view.rerender(<World {...props} nowMs={run.startMs + 3_000} />);
    expect(renders.map((entry) => entry.key)).toContain(test.key);
    expect(renders.map((entry) => entry.key)).not.toContain(first.key);
  });
});

describe("Overlay", () => {
  it("labels frames with the short title, the full title as tooltip, and skips labels at Session level", () => {
    const { view } = renderWorld();
    const label = view.container.querySelector<HTMLElement>(`[data-label-for="${linkingTest.key}"]`);
    expect(label?.textContent).toContain(frameTitle(linkingTest, ctx));
    expect(label?.textContent).toContain("+0:33");
    expect(label?.getAttribute("title")).toBe(frameFullTitle(linkingTest, ctx));
    expect(view.container.querySelectorAll("[data-label-for]")).toHaveLength(layout.frames.length);
    cleanup();
    render(<Overlay layout={layout} ctx={ctx} level="session" selectedKey={null} onSelect={() => undefined} />);
    expect(document.querySelectorAll("[data-label-for]")).toHaveLength(0);
  });

  it("selects a frame from its label", () => {
    const onSelect = vi.fn();
    const view = render(<Overlay layout={layout} ctx={ctx} level="chapter" selectedKey={null} onSelect={onSelect} />);
    const label = view.container.querySelector(`[data-label-for="${intent.key}"]`);
    if (label === null) throw new Error("no label");
    fireEvent.click(label);
    expect(onSelect).toHaveBeenCalledWith(intent);
  });

  it("shows a bidi override in a label as a visible token", () => {
    const hostile: TraceSession = structuredClone(session);
    const chapter = hostile.chapters.find((candidate) => candidate.id === "unit:oauth-linking-test-failure");
    if (chapter === undefined) throw new Error("no chapter");
    chapter.title = "Linking ‮tset";
    chapter.shortTitle = "Linking ‮tset";
    const hostileLayout = layoutCanvas(hostile, buildTraceIndex(hostile), canvasScale(hostile), "chapter");
    const view = render(
      <Overlay layout={hostileLayout} ctx={buildFrameContext(hostile)} level="chapter" selectedKey={null} onSelect={() => undefined} />,
    );
    const label = view.container.querySelector(`[data-label-for="${linkingTest.key}"]`);
    expect(label?.textContent).toContain(displayUntrusted("Linking ‮tset"));
    expect(label?.textContent).not.toContain("‮");
    expect(label?.getAttribute("title")).not.toContain("‮");
  });

  it("dims the contradicts badge with its edge when the selection is elsewhere", () => {
    const view = render(<Overlay layout={layout} ctx={ctx} level="chapter" selectedKey={intent.key} onSelect={() => undefined} />);
    expect(view.container.querySelector("[data-badge]")?.hasAttribute("data-dim")).toBe(true);
    view.rerender(<Overlay layout={layout} ctx={ctx} level="chapter" selectedKey={claim.key} onSelect={() => undefined} />);
    expect(view.container.querySelector("[data-badge]")?.hasAttribute("data-dim")).toBe(false);
  });
});

describe("badgeSide", () => {
  it("puts the word right of oauth's badge, where no card sits, and left by default", () => {
    // Spec §7.5 oauth table: the badge is at (772, 224) in gutter 752–792; column 2's cards (x 528–752) fill the
    // left at that height, and the claim's column is empty below the claim.
    const contradicts = layout.edges.find((edge) => edge.kind === "contradicts");
    expect(contradicts?.badge).toEqual({ x: 772, y: 224 });
    expect(badgeSide(layout, { x: 772, y: 224 })).toBe("right");
    expect(badgeSide(layout, { x: -400, y: -400 })).toBe("left");
  });

  // Lane review I-4: before I-3 the replayed bundle put the badge at (772, 299), in the Tests · oauth label row
  // (x 528–752, y 300–316). The word box left of it (x 672–760) missed every card but covered that label.
  const replay = oauthReplaySession();
  const replayLayout = layoutCanvas(replay, buildTraceIndex(replay), canvasScale(replay), "chapter");

  it("treats frame labels as obstacles: a badge in a label row puts its word on the free side", () => {
    const tests = replayLayout.frames.find((candidate) => candidate.selId === "unit:cu_a2589fe62ff19ebf");
    expect(tests?.label).toEqual({ x: 528, y: 300, w: 224, h: 16 });
    expect(badgeSide(replayLayout, { x: 772, y: 299 })).toBe("right");
  });

  it("drops the word when both sides are blocked", () => {
    // Gutter 488–528 at y 350: Identity's card (x 264–488) on the left, Tests · oauth's card (x 528–752) on the right.
    expect(badgeSide(replayLayout, { x: 508, y: 350 })).toBe("mark");
  });

  it("treats the selection's time chip as an obstacle", () => {
    const claimFrame = replayLayout.frames.find((candidate) => candidate.item === "claim");
    if (claimFrame === undefined) throw new Error("no claim");
    // The chip hangs 8–26 px under the claim card (bottom 118), centered at x 904 and about 47 px wide (x 880–928);
    // the word box left of this point spans x 900–988, y 123–147.
    const point = { x: 1000, y: 135 };
    expect(badgeSide(replayLayout, point)).toBe("left");
    expect(badgeSide(replayLayout, point, { chip: timeChipRect(claimFrame, "+0:43") })).toBe("right");
  });

  it("measures the word at the camera's zoom: at k 0.5 it spans twice the world px", () => {
    // Left box at k 1: x 1000–1088 (clear). At k 0.5: x 912–1088, which reaches the chip under the claim card.
    const claimFrame = replayLayout.frames.find((candidate) => candidate.item === "claim");
    if (claimFrame === undefined) throw new Error("no claim");
    const chip = timeChipRect(claimFrame, "+0:43", 0.5);
    expect(badgeSide(replayLayout, { x: 1100, y: 150 }, { chip })).toBe("left");
    expect(badgeSide(replayLayout, { x: 1100, y: 150 }, { chip, k: 0.5 })).toBe("right");
  });

  it("renders a mark-only badge with its word in the tooltip", () => {
    const blocked = {
      ...replayLayout,
      edges: replayLayout.edges.map((edge) => (edge.kind === "contradicts" ? { ...edge, badge: { x: 508, y: 350 } } : edge)),
    };
    const view = render(<Overlay layout={blocked} ctx={buildFrameContext(replay)} level="chapter" selectedKey={null} onSelect={() => undefined} />);
    const badge = view.container.querySelector("[data-badge]");
    expect(badge?.getAttribute("data-side")).toBe("mark");
    expect(badge?.textContent).not.toContain("contradicts");
    expect(badge?.getAttribute("title")).toBe("contradicts");
  });
});

describe("frame labels below zoom 1 (C3b lane review minor 7: crowded at 1000 px)", () => {
  const sessionLayout = layoutCanvas(session, buildTraceIndex(session), canvasScale(session), "session");
  const stepLayout = layoutCanvas(session, buildTraceIndex(session), canvasScale(session), "step");
  /** Pairs of frames in one column where `lower` is the next frame under `upper`. */
  function stacked(of: CanvasLayout): Array<{ upper: CanvasFrame; lower: CanvasFrame }> {
    const pairs: Array<{ upper: CanvasFrame; lower: CanvasFrame }> = [];
    for (const upper of of.frames) {
      const below = of.frames
        .filter((other) => other.card.x === upper.card.x && other.card.y > upper.card.y)
        .sort((a, b) => a.card.y - b.card.y)[0];
      if (below !== undefined) pairs.push({ upper, lower: below });
    }
    return pairs;
  }

  it("sit between the card above and their own card at every zoom that shows them (0.35 to 2)", () => {
    for (const of of [layout, stepLayout]) {
      const pairs = stacked(of);
      expect(pairs.length).toBeGreaterThan(0);
      for (let k = 0.35; k <= 2; k += 0.05) {
        for (const { upper, lower } of pairs) {
          const rect = labelRectAt(lower, k, of === layout ? "chapter" : "step");
          expect(rect.y, `${lower.key} at k ${k.toFixed(2)}`).toBeGreaterThanOrEqual(upper.card.y + upper.card.h);
          expect(rect.y + rect.h).toBeLessThan(lower.card.y);
        }
      }
    }
    // The gap comes from the frame's own level, not a hardcoded Chapter value.
    const step = LEVEL_SPECS.step as { rowGap: number };
    const saved = step.rowGap;
    try {
      const pair = stacked(stepLayout)[0];
      const before = labelRectAt(pair?.lower as CanvasFrame, 0.5, "step");
      step.rowGap = saved + 40;
      expect(labelRectAt(pair?.lower as CanvasFrame, 0.5, "step")).not.toEqual(before);
    } finally {
      step.rowGap = saved;
    }
    // At zoom 1 the label keeps the §7.5 slot: a 16 px row 6 px above the card.
    expect(labelRectAt(linkingTest, 1, "chapter")).toEqual(linkingTest.label);
    const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "World.module.css"), "utf8");
    expect(css).toContain("clamp(1px, calc((var(--slot) * var(--tv-k, 1) * 1px - var(--label-h)) / 2), 6px)");
  });

  it("drop the time offset while the card is under 168 px on screen, so the title keeps the room", () => {
    expect(showsLabelOffsets("chapter", 0.83)).toBe(true); // 1440 px fit: 186 px cards
    expect(showsLabelOffsets("chapter", 0.58)).toBe(false); // 1180 px fit: 130 px cards
    expect(showsLabelOffsets("step", 0.6)).toBe(true); // 192 px cards
    const view = render(<Overlay layout={layout} ctx={ctx} level="chapter" selectedKey={null} onSelect={() => undefined} k={0.58} />);
    expect(view.container.querySelector("[data-tv-overlay]")?.hasAttribute("data-offsets-hidden")).toBe(true);
    view.rerender(<Overlay layout={layout} ctx={ctx} level="chapter" selectedKey={null} onSelect={() => undefined} k={0.83} />);
    expect(view.container.querySelector("[data-tv-overlay]")?.hasAttribute("data-offsets-hidden")).toBe(false);
  });

  it("place the selection's time chip under the card, on its bottom edge, or nowhere: never over another frame or label", () => {
    const { upper } = stacked(layout).find(({ upper: frame }) => frame.kind === "chapter") ?? {};
    if (upper === undefined) throw new Error("no stacked chapter");
    // Under the card the chip (8–26 px down) meets the next label (16–32 px down at zoom 1).
    expect(timeChipPlacement(layout.frames, upper, "+0:17 – +0:45", "chapter", 1).place).toBe("edge");
    expect(timeChipPlacement(layout.frames, upper, "+0:17 – +0:45", "chapter", 0.83).place).toBe("edge");
    // Below 0.75 the card's 12 px bottom padding is under 9 screen px: the chip would cover its footer.
    expect(timeChipPlacement(layout.frames, upper, "+0:17 – +0:45", "chapter", 0.6).place).toBe("none");
    // The claim's column is empty under it (spec §7.5 oauth table): the mockup's place.
    expect(timeChipPlacement(layout.frames, claim, "+0:43", "chapter", 0.45).place).toBe("below");
    // Session chips stand 8 px apart and center their text: a stacked chip gets none, the column's last gets "below".
    const session0 = stacked(sessionLayout)[0];
    if (session0 === undefined) throw new Error("no stacked session chip");
    expect(timeChipPlacement(sessionLayout.frames, session0.upper, "+0:17", "session", 1.27).place).toBe("none");
    const last = sessionLayout.frames.find((frame) => !sessionLayout.frames.some((other) => other.card.x === frame.card.x && other.card.y > frame.card.y));
    if (last === undefined) throw new Error("no last chip");
    expect(timeChipPlacement(sessionLayout.frames, last, "+0:17", "session", 1.27).place).toBe("below");
  });

  it("render the chip where it is placed", () => {
    const { upper } = stacked(layout).find(({ upper: frame }) => frame.kind === "chapter") ?? {};
    if (upper === undefined) throw new Error("no stacked chapter");
    const view = render(<Overlay layout={layout} ctx={ctx} level="chapter" selectedKey={upper.key} onSelect={() => undefined} k={1} />);
    expect(view.container.querySelector("[data-time-chip]")?.getAttribute("data-place")).toBe("edge");
    view.rerender(<Overlay layout={layout} ctx={ctx} level="chapter" selectedKey={upper.key} onSelect={() => undefined} k={0.6} />);
    expect(view.container.querySelector("[data-time-chip]")).toBeNull();
    // The handles still mark the selection.
    expect(view.container.querySelectorAll("[data-handle]")).toHaveLength(4);
  });
});

describe("edge and cull helpers", () => {
  it("culls by x only when the risk 2 ruling passes a range", () => {
    expect(cullFrames(layout.frames, null)).toBe(layout.frames);
    expect(cullFrames(layout.frames, { x0: 500, x1: 760 }).map((candidate) => candidate.col)).toEqual([2, 2, 2]);
  });

  it("keeps a frame whose card contains x0 or ends exactly at x0, and one that starts exactly at x1", () => {
    const first = layout.frames[0];
    if (first === undefined) throw new Error("no frames");
    const { x, w } = first.card;
    const keys = (range: { x0: number; x1: number }) => cullFrames(layout.frames, range).map((candidate) => candidate.key);
    expect(keys({ x0: x + w / 2, x1: x + w / 2 + 1 })).toContain(first.key);
    expect(keys({ x0: x + w, x1: x + w + 1 })).toContain(first.key);
    expect(keys({ x0: x + w + 1, x1: x + w + 2 })).not.toContain(first.key);
    const last = layout.frames[layout.frames.length - 1];
    if (last === undefined) throw new Error("no frames");
    expect(keys({ x0: last.card.x - 50, x1: last.card.x })).toContain(last.key);
    expect(keys({ x0: last.card.x - 50, x1: last.card.x - 1 })).not.toContain(last.key);
  });

  it("culls edges by their path's x-extent and separators by x, keeping the selection's edges (C3-10 review M1)", () => {
    const drawn = (container: HTMLElement): string[] =>
      [...container.querySelectorAll<SVGGElement>("g[data-edge]")].map((element) => element.dataset.edge ?? "");
    const far = { x0: layout.bounds.x + layout.bounds.w + 1_000, x1: layout.bounds.x + layout.bounds.w + 2_000 };
    const { view } = renderWorld({ cullRange: far });
    expect(drawn(view.container)).toEqual([]);
    expect(view.container.querySelectorAll("[data-sep]")).toHaveLength(0);
    cleanup();
    // The selection's one-hop edges stay drawn wherever the camera is (spec §7.5: they are what the selection shows).
    const selected = renderWorld({ selectedKey: linkingTest.key, cullRange: far });
    const hops = layout.edges
      .filter((edge) => edge.kind !== "trunk" && (edge.from === linkingTest.key || edge.to === linkingTest.key))
      .map((edge) => edge.id);
    expect(hops.length).toBeGreaterThan(0);
    expect(drawn(selected.view.container).sort()).toEqual([...hops].sort());
    cleanup();
    // A trunk's from/to are placement-order ends, not its extremes (C3a hand-off): a range that meets only the middle
    // of its path still draws it.
    const trunk = layout.edges.find((edge) => edge.kind === "trunk" && edge.d !== null);
    if (trunk === undefined || trunk.d === null) throw new Error("no trunk");
    const xs = samplePath(trunk.d).map((point) => point.x);
    const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
    const middle = renderWorld({ cullRange: { x0: mid - 1, x1: mid + 1 } });
    expect(drawn(middle.view.container)).toContain(trunk.id);
  });

  it("draws the selection's lane-less edges as direct paths above the frames", () => {
    const decides = layout.edges.find((edge) => edge.kind === "decides");
    if (decides === undefined) throw new Error("no decides edge");
    const laneless: CanvasLayout = { ...layout, edges: [{ ...decides, d: null, rest: false, shape: "channel" }] };
    expect(drawnEdges(laneless, null, "over")).toEqual([]);
    const drawn = drawnEdges(laneless, decides.from, "over");
    expect(drawn).toHaveLength(1);
    expect(drawn[0]?.d.startsWith("M")).toBe(true);
    expect(drawnEdges(laneless, decides.from, "under")).toEqual([]);
  });

  it("lifts a direct contradicts fallback above the frames at rest", () => {
    const contradicts = layout.edges.find((edge) => edge.kind === "contradicts");
    if (contradicts === undefined) throw new Error("no contradicts edge");
    const direct: CanvasLayout = { ...layout, edges: [{ ...contradicts, shape: "direct" }] };
    expect(drawnEdges(direct, null, "over").map((drawn) => drawn.edge.id)).toEqual([contradicts.id]);
    expect(drawnEdges(direct, null, "under")).toEqual([]);
  });
});
