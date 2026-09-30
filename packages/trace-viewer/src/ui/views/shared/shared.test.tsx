// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildTimeScale, type XMap } from "../../../layout/time-scale.js";
import { foldFixture, renderHarness, stubLayout, type LayoutStub } from "../../../test-support/ui-harness.js";
import { LevelControl } from "./LevelControl.js";
import { NewBadge } from "./NewBadge.js";
import { idleLabel, Ruler } from "./Ruler.js";

let layout: LayoutStub;
beforeEach(() => {
  layout = stubLayout();
});
afterEach(() => {
  cleanup();
  layout.restore();
  vi.useRealTimers();
});

describe("Ruler", () => {
  it("labels ticks at least 64 px apart with real offsets and hatches past the loaded seq", () => {
    const scale = buildTimeScale({ originMs: 0, work: [[0, 45_000]], awaitingFrom: [] });
    const map: XMap = { xOf: (t) => t / 100, tOf: (x) => x * 100 };
    renderHarness(<Ruler map={map} scale={scale} widthPx={450} loadedThroughT={30_000} />, null);
    const labels = Array.from(screen.getByTestId("ruler").querySelectorAll("[data-tick]")).map((node) => node.textContent);
    expect(labels).toEqual(["+0:00", "+0:10", "+0:20", "+0:30", "+0:40"]);
    const hatch = screen.getByTestId("ruler-hatch");
    expect(hatch.style.left).toBe("300px");
    expect(hatch.style.width).toBe("150px");
  });

  it("formats idle breaks", () => {
    expect(idleLabel(12_000)).toBe("12s");
    expect(idleLabel(4 * 60_000 + 5_000)).toBe("4m");
    expect(idleLabel(62 * 60_000)).toBe("1h 02m");
  });
});

describe("LevelControl", () => {
  it("is a radiogroup that writes the shared level", () => {
    const h = renderHarness(<LevelControl by="hybrid" />, foldFixture("oauth"));
    const group = screen.getByRole("radiogroup", { name: "Level" });
    expect(group.querySelectorAll('[role="radio"]')).toHaveLength(3);
    fireEvent.click(screen.getByRole("radio", { name: "Session" }));
    expect(h.store.get().level).toBe("session");
    expect(screen.getByRole("radio", { name: "Session" }).getAttribute("aria-checked")).toBe("true");
    expect(group.querySelectorAll('[tabindex="0"]')).toHaveLength(0);
  });
});

describe("NewBadge", () => {
  it("announces only growth in problems, never plain step counts, throttled to one per 10 s", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T10:00:00.000Z"));
    const onActivate = vi.fn();
    const badge = (count: number, problems: number) => (
      <NewBadge count={count} problems={problems} afterRange={false} onActivate={onActivate} />
    );
    const h = renderHarness(badge(3, 0), null);
    h.result.rerender(h.wrap(badge(5, 0)));
    expect(h.announcements).toEqual([]);
    h.result.rerender(h.wrap(badge(6, 1)));
    expect(h.announcements).toEqual(["6 new steps, 1 problem"]);
    h.result.rerender(h.wrap(badge(7, 1)));
    expect(h.announcements).toEqual(["6 new steps, 1 problem"]);
    vi.advanceTimersByTime(2_000);
    h.result.rerender(h.wrap(badge(9, 2)));
    expect(h.announcements).toEqual(["6 new steps, 1 problem"]);
    act(() => {
      vi.advanceTimersByTime(8_000);
    });
    expect(h.announcements).toEqual(["6 new steps, 1 problem", "9 new steps, 2 problems"]);
    expect(screen.getByRole("button", { name: /↓ 9 new/ })).toBeTruthy();
    expect(screen.getByTestId("new-badge-dot")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /↓ 9 new/ }));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("reads after range and renders nothing at zero", () => {
    const h = renderHarness(<NewBadge count={2} problems={0} afterRange onActivate={() => undefined} />, null);
    expect(screen.getByRole("button").textContent).toBe("↓ 2 new after range");
    expect(screen.queryByTestId("new-badge-dot")).toBeNull();
    h.result.rerender(h.wrap(<NewBadge count={0} problems={0} afterRange={false} onActivate={() => undefined} />));
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("LevelControl keyboard", () => {
  it("moves and checks the neighbour with arrows, wraps, and follows with focus", () => {
    const h = renderHarness(<LevelControl by="hybrid" />, foldFixture("oauth"));
    const session = screen.getByRole("radio", { name: "Session" });
    fireEvent.click(session);
    session.focus();
    fireEvent.keyDown(session, { key: "ArrowRight" });
    expect(h.store.get().level).toBe("chapter");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Chapter" }));
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
    expect(h.store.get().level).toBe("step");
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowRight" });
    expect(h.store.get().level).toBe("session");
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowLeft" });
    expect(h.store.get().level).toBe("step");
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowUp" });
    expect(h.store.get().level).toBe("chapter");
  });

  it("ignores arrows with a modifier or during composition", () => {
    const h = renderHarness(<LevelControl by="hybrid" />, foldFixture("oauth"));
    const radio = screen.getByRole("radio", { name: "Session" });
    fireEvent.click(radio);
    const before = h.store.get().level;
    fireEvent.keyDown(radio, { key: "ArrowRight", altKey: true });
    fireEvent.keyDown(radio, { key: "ArrowRight", metaKey: true });
    fireEvent.keyDown(radio, { key: "ArrowRight", isComposing: true });
    expect(h.store.get().level).toBe(before);
  });
});
