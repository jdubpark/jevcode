// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, fireEvent, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { layoutCanvas, type CanvasFrame, type CanvasLayout } from "../../../layout/canvas-layout.js";
import { buildTraceIndex } from "../../../layout/trace-index.js";
import { displayUntrusted, type TraceSession } from "../../../model/index.js";
import { canvasScale, oauthCanvasSession } from "../../../test-support/canvas-arbitraries.js";
import { drawnEdges } from "./EdgeLayer.js";
import type { FrameProps } from "./Frame.js";
import { buildFrameContext, frameFullTitle, frameTitle } from "./frame-label.js";
import { Overlay, badgeSide } from "./Overlay.js";
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
// the canvas mockup (badge worded "contradicts", time chip "+0:33 – 0:40") and lane rulings (CULL_FRAMES, nowMs).

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
    gesturing: false,
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

  it("sets will-change only while a gesture runs", () => {
    const { props, view } = renderWorld({ gesturing: true });
    const world = view.container.querySelector<HTMLElement>("[data-tv-world]");
    expect(world?.style.willChange).toBe("transform");
    view.rerender(<World {...props} gesturing={false} />);
    expect(world?.style.willChange ?? "").toBe("");
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
    expect(view.container.querySelector("[data-time-chip]")?.textContent).toBe("+0:33 – 0:40");
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
