import { describe, expect, it, vi } from "vitest";

import { layoutCanvas, type CanvasFrame } from "../../../layout/canvas-layout.js";
import { buildTraceIndex } from "../../../layout/trace-index.js";
import { canvasScale, oauthCanvasSession } from "../../../test-support/canvas-arbitraries.js";
import { canvasReadingOrder, createCanvasPort, frameForSelection, tailFrame, type CanvasPortDeps } from "./canvas-port.js";

const session = oauthCanvasSession();
const layout = layoutCanvas(session, buildTraceIndex(session), canvasScale(session), "chapter");

function frame(predicate: (candidate: CanvasFrame) => boolean): CanvasFrame {
  const found = layout.frames.find(predicate);
  if (found === undefined) throw new Error("frame not found");
  return found;
}

const linkingTest = frame((candidate) => candidate.selId === "unit:oauth-linking-test-failure");

describe("canvasReadingOrder", () => {
  it("equals the layout's reading order when nothing is expanded", () => {
    expect(canvasReadingOrder(layout, session, new Set())).toEqual(layout.readingOrder);
  });

  it("puts an expanded chapter's steps right after it", () => {
    const chapter = session.chapters.find((candidate) => candidate.id === linkingTest.selId);
    if (chapter === undefined) throw new Error("no chapter");
    const order = canvasReadingOrder(layout, session, new Set([linkingTest.key]));
    const at = order.indexOf(linkingTest.selId);
    expect(order.slice(at + 1, at + 1 + chapter.stepIds.length)).toEqual(chapter.stepIds);
    expect(order.filter((id) => !(chapter.stepIds as readonly string[]).includes(id))).toEqual(layout.readingOrder);
  });
});

describe("frameForSelection and tailFrame", () => {
  it("maps a step to its home frame and a unit to its own frame", () => {
    const testStep = session.steps.find((step) => step.command?.command === "pnpm test");
    expect(testStep === undefined ? undefined : frameForSelection(layout, session, testStep.id)?.key).toBe(linkingTest.key);
    expect(frameForSelection(layout, session, linkingTest.selId)?.key).toBe(linkingTest.key);
    expect(frameForSelection(layout, session, "unit:missing")).toBeUndefined();
  });

  it("finds the tail frame from the last step that has one", () => {
    expect(tailFrame(layout, session)?.item).toBe("claim");
  });
});

describe("createCanvasPort", () => {
  it("delegates zoom presets, steps and reveals", () => {
    const deps: CanvasPortDeps = {
      readingOrder: vi.fn(() => []),
      reveal: vi.fn(),
      captureCamera: vi.fn(() => null),
      focusSelected: vi.fn(),
      camera: () => ({ mode: "uniform", tx: 0, ty: 0, k: 0.834 }),
      zoomAround: vi.fn(),
      zoomTo: vi.fn(),
      fitAll: vi.fn(),
      fitSelection: vi.fn(),
    };
    const port = createCanvasPort(deps);
    expect(port.zoom.label()).toBe("83%");
    expect(port.zoom.presets().map((preset) => preset.label)).toEqual(["50%", "100%", "200%"]);
    port.zoom.applyPreset("200");
    expect(deps.zoomTo).toHaveBeenLastCalledWith(2);
    port.zoom.zoomIn();
    expect(deps.zoomAround).toHaveBeenLastCalledWith(1.25);
    port.zoom.zoomOut();
    expect(deps.zoomAround).toHaveBeenLastCalledWith(0.8);
    port.zoom.resetToPreset();
    expect(deps.zoomTo).toHaveBeenLastCalledWith(1);
    port.zoom.fitAll();
    port.zoom.fitSelection();
    expect(deps.fitAll).toHaveBeenCalledTimes(1);
    expect(deps.fitSelection).toHaveBeenCalledTimes(1);
    port.reveal("step:3", { animate: true });
    expect(deps.reveal).toHaveBeenCalledWith("step:3", true);
  });
});
