// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SelectionId } from "../../layout/trace-index.js";
import { createStaticBundleSource } from "../../sources/static-bundle.js";
import {
  fixtureBundle,
  foldFixture,
  renderHarness,
  stubLayout,
  type LayoutStub,
} from "../../test-support/ui-harness.js";
import type { ViewPort } from "../views/view-port.js";
import { KeyboardLayer } from "./KeyboardLayer.js";
import { regionOf } from "./regions.js";
import { TraceViewer } from "./TraceViewer.js";

let layout: LayoutStub;
beforeEach(() => {
  layout = stubLayout();
});
afterEach(() => {
  cleanup();
  layout.restore();
  vi.restoreAllMocks();
  window.getSelection()?.removeAllRanges();
});

function KeyHarness({ children }: { children?: ReactNode }) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setRoot}>
      <nav data-region="outline">
        <button type="button" tabIndex={0}>
          outline row
        </button>
      </nav>
      <main data-region="main" tabIndex={-1}>
        {children}
      </main>
      <aside data-region="inspector">
        <button type="button" tabIndex={0}>
          inspector tab
        </button>
      </aside>
      <KeyboardLayer root={root} />
    </div>
  );
}

function fakePort(order: readonly SelectionId[]): ViewPort & { calls: string[] } {
  const calls: string[] = [];
  const note = (name: string) => (): void => {
    calls.push(name);
  };
  return {
    calls,
    readingOrder: () => order,
    reveal: (id) => {
      calls.push(`reveal:${id}`);
    },
    captureCamera: () => null,
    focusSelected: note("focusSelected"),
    zoom: {
      label: () => "Chapter",
      presets: () => [],
      applyPreset: note("applyPreset"),
      zoomIn: note("zoomIn"),
      zoomOut: note("zoomOut"),
      resetToPreset: note("resetToPreset"),
      fitAll: note("fitAll"),
      fitSelection: note("fitSelection"),
    },
  };
}

describe("KeyboardLayer", () => {
  it("keeps exactly one tabindex=0 in the Outline and the Inspector", async () => {
    render(<TraceViewer source={createStaticBundleSource(fixtureBundle("oauth"))} />);
    await waitFor(() => expect(screen.getAllByRole("treeitem").length).toBeGreaterThan(0));
    const outline = screen.getByRole("navigation", { name: "Outline" });
    const inspector = screen.getByRole("complementary", { name: "Inspector" });
    expect(outline.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    expect(inspector.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  });

  it("F6 cycles Outline → main → Inspector", async () => {
    render(<TraceViewer source={createStaticBundleSource(fixtureBundle("oauth"))} />);
    await waitFor(() => expect(screen.getAllByRole("treeitem").length).toBeGreaterThan(0));
    const visited: Array<string | null> = [];
    for (let i = 0; i < 3; i += 1) {
      fireEvent.keyDown(document.activeElement ?? document.body, { code: "F6", key: "F6" });
      visited.push(regionOf(document.activeElement));
    }
    expect(visited).toEqual(["outline", "main", "inspector"]);
  });

  it("moves like j for a Hangul input source and ignores composing keys", () => {
    const session = foldFixture("oauth");
    const [a, b, c] = session.steps;
    const order = [a?.id, b?.id, c?.id].filter((id): id is `step:${number}` => id !== undefined);
    const h = renderHarness(<KeyHarness />, session, { state: { selection: order[0] ?? null } });
    act(() => {
      h.registry.register("hybrid", fakePort(order));
    });
    fireEvent.keyDown(document.body, { code: "KeyJ", key: "ㅓ" });
    expect(h.store.get().selection).toBe(order[1]);
    fireEvent.keyDown(document.body, { code: "KeyJ", key: "j", isComposing: true });
    expect(h.store.get().selection).toBe(order[1]);
  });

  it("Esc unwinds search → hand → collapse → parent → clear and never moves the camera", () => {
    const session = foldFixture("oauth");
    const step = session.steps.find((item) => item.chapterIds.length > 0);
    const h = renderHarness(<KeyHarness />, session, {
      state: {
        selection: step?.id ?? null,
        tool: "hand",
        search: { query: "pnpm", matchIds: [], cursor: 0 },
        expanded: new Set([step?.id ?? ""]),
      },
    });
    const port = fakePort([]);
    act(() => {
      h.registry.register("hybrid", port);
    });
    const press = (): void => {
      fireEvent.keyDown(document.body, { code: "Escape", key: "Escape" });
    };
    press();
    expect(h.store.get().search).toBeNull();
    press();
    expect(h.store.get().tool).toBe("select");
    press();
    expect(h.store.get().expanded.has(step?.id ?? "")).toBe(false);
    press();
    expect(h.store.get().selection?.startsWith("unit:")).toBe(true);
    press();
    expect(h.store.get().selection).toBeNull();
    expect(port.calls).toEqual([]);
  });

  it("Space with focus on a button in main pans and never clicks it", async () => {
    const onClick = vi.fn();
    const h = renderHarness(
      <KeyHarness>
        <button type="button" onClick={onClick}>
          row action
        </button>
      </KeyHarness>,
      foldFixture("oauth"),
    );
    const user = userEvent.setup();
    screen.getByRole("button", { name: "row action" }).focus();
    await user.keyboard("[Space>]");
    expect(h.store.get().tool).toBe("hand");
    await user.keyboard("[/Space]");
    expect(h.store.get().tool).toBe("select");
    expect(onClick).not.toHaveBeenCalled();
  });

  it("Cmd+C with a text selection leaves the clipboard to the browser", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const session = foldFixture("oauth");
    renderHarness(
      <KeyHarness>
        <p>selectable words</p>
      </KeyHarness>,
      session,
      { state: { selection: session.steps[0]?.id ?? null } },
    );
    window.getSelection()?.selectAllChildren(screen.getByText("selectable words"));
    fireEvent.keyDown(document.body, { code: "KeyC", key: "c", metaKey: true });
    await act(async () => undefined);
    expect(writeText).not.toHaveBeenCalled();

    window.getSelection()?.removeAllRanges();
    fireEvent.keyDown(document.body, { code: "KeyC", key: "c", metaKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(String(writeText.mock.calls[0]?.[0]).startsWith("Re: trace ")).toBe(true);
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("announces the finding position on n", () => {
    const session = foldFixture("oauth");
    const h = renderHarness(<KeyHarness />, session);
    act(() => {
      h.registry.register("hybrid", fakePort([]));
    });
    fireEvent.keyDown(document.body, { code: "KeyN", key: "n" });
    expect(h.announcements.some((message) => /^Finding \d+ of \d+: /.test(message))).toBe(true);
  });

  it("announces Live follow paused once when follow turns off", () => {
    const h = renderHarness(<KeyHarness />, foldFixture("oauth"), { state: { follow: true } });
    act(() => h.store.dispatch({ type: "follow/set", follow: false }));
    act(() => h.store.dispatch({ type: "follow/set", follow: false }));
    expect(h.announcements.filter((message) => message === "Live follow paused")).toHaveLength(1);
  });

  it("Enter on a focused button leaves it to the button and does not toggle the selection", () => {
    const session = foldFixture("oauth");
    const id = session.steps[0]?.id ?? "";
    const h = renderHarness(<KeyHarness />, session, { state: { selection: session.steps[0]?.id ?? null } });
    screen.getByRole("button", { name: "inspector tab" }).focus();
    const before = h.store.get().expanded.has(id);
    const notCanceled = fireEvent.keyDown(document.activeElement ?? document.body, { code: "Enter", key: "Enter" });
    expect(notCanceled).toBe(true);
    expect(h.store.get().expanded.has(id)).toBe(before);
  });

  it("? opens the shortcut sheet, Esc closes it before the selection unwinds, and focus returns", () => {
    const session = foldFixture("oauth");
    const selection = session.steps[0]?.id ?? null;
    const h = renderHarness(<KeyHarness />, session, { state: { selection } });
    const trigger = screen.getByRole("button", { name: "outline row" });
    trigger.focus();
    fireEvent.keyDown(trigger, { code: "Slash", key: "?", shiftKey: true });
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { code: "Escape", key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(h.store.get().selection).toBe(selection);
    expect(document.activeElement).toBe(trigger);
  });

  it("ignores keys whose target lies outside the viewer", () => {
    const session = foldFixture("oauth");
    const h = renderHarness(<KeyHarness />, session, { state: { tool: "hand" } });
    const outside = document.createElement("button");
    document.body.append(outside);
    fireEvent.keyDown(outside, { code: "KeyV", key: "v" });
    expect(h.store.get().tool).toBe("hand");
    outside.remove();
  });

  it("F6 into main focuses the visible view's tab stop, not a hidden view's earlier one", () => {
    renderHarness(
      <KeyHarness>
        <div style={{ display: "none" }}>
          <button type="button" tabIndex={0}>
            hidden row
          </button>
        </div>
        <div>
          <button type="button" tabIndex={0}>
            visible row
          </button>
        </div>
      </KeyHarness>,
      foldFixture("oauth"),
    );
    screen.getByRole("button", { name: "outline row" }).focus();
    fireEvent.keyDown(document.activeElement ?? document.body, { code: "F6", key: "F6" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "visible row" }));
  });

  it("releases the hand tool on Space keyup even when the pointer is no longer over a pannable surface", () => {
    const h = renderHarness(<KeyHarness><button type="button">row action</button></KeyHarness>, foldFixture("oauth"));
    const row = screen.getByRole("button", { name: "row action" });
    row.focus();
    fireEvent.keyDown(row, { code: "Space", key: " " });
    expect(h.store.get().tool).toBe("hand");
    const outline = screen.getByRole("button", { name: "outline row" });
    outline.focus();
    fireEvent.keyUp(outline, { code: "Space", key: " " });
    expect(h.store.get().tool).toBe("select");
  });

  it("releases the hand tool when the window loses focus while Space is held", () => {
    const h = renderHarness(<KeyHarness><button type="button">row action</button></KeyHarness>, foldFixture("oauth"));
    const row = screen.getByRole("button", { name: "row action" });
    row.focus();
    fireEvent.keyDown(row, { code: "Space", key: " " });
    expect(h.store.get().tool).toBe("hand");
    fireEvent.blur(window);
    expect(h.store.get().tool).toBe("select");
  });

  it("focuses the sheet's Close button when it opens", () => {
    renderHarness(<KeyHarness />, foldFixture("oauth"));
    const trigger = screen.getByRole("button", { name: "outline row" });
    trigger.focus();
    fireEvent.keyDown(trigger, { code: "Slash", key: "?", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  });

  it("Esc from an editable target closes an open sheet and otherwise leaves Esc to the input", () => {
    const session = foldFixture("oauth");
    const selection = session.steps[0]?.id ?? null;
    const h = renderHarness(
      <KeyHarness>
        <input aria-label="field" />
      </KeyHarness>,
      session,
      { state: { selection } },
    );
    const input = screen.getByLabelText("field");
    input.focus();
    fireEvent.keyDown(input, { code: "Escape", key: "Escape" });
    expect(h.store.get().selection).toBe(selection);
    const trigger = screen.getByRole("button", { name: "outline row" });
    fireEvent.keyDown(trigger, { code: "Slash", key: "?", shiftKey: true });
    expect(screen.getByRole("dialog")).toBeTruthy();
    input.focus();
    fireEvent.keyDown(input, { code: "Escape", key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(h.store.get().selection).toBe(selection);
  });

  it("forgets the pointer target when the pointer leaves the viewer", () => {
    renderHarness(
      <KeyHarness>
        <div data-pannable data-testid="pan">
          surface
        </div>
      </KeyHarness>,
      foldFixture("oauth"),
    );
    const pan = screen.getByTestId("pan");
    const root = pan.parentElement?.parentElement as HTMLElement;
    fireEvent.pointerOver(pan);
    expect(fireEvent.keyDown(document.body, { code: "Space", key: " " })).toBe(false);
    fireEvent.keyUp(document.body, { code: "Space", key: " " });
    fireEvent.pointerLeave(root);
    expect(fireEvent.keyDown(document.body, { code: "Space", key: " " })).toBe(true);
  });

  it("Shift+B pins the Brief only with a selection and announces it; Shift+0 returns the zoom to its preset", () => {
    const session = foldFixture("oauth");
    const step = session.steps[3];
    if (step === undefined) throw new Error("oauth has fewer than 4 steps");
    const port = fakePort([]);
    const h = renderHarness(<KeyHarness />, session);
    act(() => {
      h.registry.register("hybrid", port);
    });
    fireEvent.keyDown(document.body, { code: "KeyB", key: "B", shiftKey: true });
    expect(h.store.get().brief).toBe(false);
    act(() => h.store.dispatch({ type: "select", id: step.id, by: "shell" }));
    fireEvent.keyDown(document.body, { code: "KeyB", key: "B", shiftKey: true });
    expect(h.store.get().brief).toBe(true);
    expect(h.announcements.at(-1)).toBe("Brief");
    fireEvent.keyDown(document.body, { code: "KeyB", key: "B", shiftKey: true });
    expect(h.announcements.at(-1)).toBe("Inspector");
    fireEvent.keyDown(document.body, { code: "Digit0", key: ")", shiftKey: true });
    expect(port.calls).toContain("resetToPreset");
  });
});
