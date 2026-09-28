// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DiffBar } from "./DiffBar.js";
import { DurationBar } from "./DurationBar.js";
import { TestDots } from "./TestDots.js";

afterEach(() => cleanup());

describe("TestDots", () => {
  it("renders 15 dots for oauth's 14/1/0 run, the failed dot larger", () => {
    const { container } = render(<TestDots size="xs" passed={14} failed={1} skipped={0} />);
    const dots = [...container.querySelectorAll("circle[data-state]")];
    expect(dots).toHaveLength(15);
    const failed = dots.filter((d) => d.getAttribute("data-state") === "failed");
    const passed = dots.filter((d) => d.getAttribute("data-state") === "passed");
    expect(failed).toHaveLength(1);
    expect(passed).toHaveLength(14);
    expect(Number(failed[0]?.getAttribute("r"))).toBeGreaterThan(Number(passed[0]?.getAttribute("r")));
  });

  it("renders a bar and the count for 16 tests", () => {
    const { container } = render(<TestDots size="sm" passed={15} failed={1} skipped={0} />);
    expect(container.querySelectorAll("circle[data-state]")).toHaveLength(0);
    expect(container.querySelectorAll("rect[data-state]").length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).toContain("15/16");
  });

  it("uses the label as its accessible name", () => {
    render(<TestDots size="md" passed={14} failed={1} skipped={0} label="14 passed, 1 failed" />);
    expect(screen.getByRole("img", { name: "14 passed, 1 failed" })).toBeTruthy();
  });
});

describe("DurationBar", () => {
  it("ends a nonzero command exit in an ink cross and never fills red", () => {
    const { container } = render(<DurationBar size="xs" durationMs={5_000} running={false} end="exit_x" />);
    expect(container.querySelector('[data-end="exit_x"]')).not.toBeNull();
    expect(container.querySelector('[data-tone="bad"]')).toBeNull();
  });

  it("ends a failed test in a red dot", () => {
    const { container } = render(<DurationBar size="xs" durationMs={5_000} running={false} end="bad_dot" />);
    expect(container.querySelector('[data-end="bad_dot"]')?.getAttribute("data-tone")).toBe("bad");
  });

  it("draws a running step with no known duration as a fully hollow bar of its elapsed time", () => {
    const { container } = render(<DurationBar size="xs" durationMs={null} running elapsedMs={10_000} end="none" />);
    expect(container.querySelector('rect[data-bar="solid"]')).toBeNull();
    const bar = container.querySelector("rect[data-bar]");
    expect(bar?.getAttribute("data-bar")).toBe("hollow");
    expect(Number(bar?.getAttribute("width"))).toBeCloseTo(60 - 1.5, 5);
  });

  it("draws a running step with a known duration as solid, extended by a hollow bar to elapsedMs (spec §7.12)", () => {
    const { container } = render(<DurationBar size="xs" durationMs={1_000} running elapsedMs={10_000} end="none" />);
    const solid = container.querySelector('rect[data-bar="solid"]');
    const hollow = container.querySelector('rect[data-bar="hollow"]');
    expect(Number(solid?.getAttribute("width"))).toBeCloseTo(20, 5);
    expect(Number(hollow?.getAttribute("width"))).toBeCloseTo(60 - 20 - 1.5, 5);
  });
});

describe("DiffBar", () => {
  it("draws added solid and removed hollow, neutral, sized by diffSidePx", () => {
    const { container } = render(<DiffBar size="xs" added={1} removed={127} />);
    const added = container.querySelector('rect[data-side="added"]');
    const removed = container.querySelector('rect[data-side="removed"]');
    expect(Number(added?.getAttribute("width"))).toBe(8);
    expect(Number(removed?.getAttribute("width"))).toBeCloseTo(56 - 1.5, 5);
    expect(container.querySelector('[data-tone="bad"]')).toBeNull();
  });

  it("lists at most four files and +k at sm", () => {
    const files = [1, 2, 3, 4, 5].map((n) => ({ path: `src/f${n}.ts`, added: n, removed: 0 }));
    const { container } = render(<DiffBar size="sm" added={15} removed={0} files={files} moreFiles={1} />);
    expect(container.querySelectorAll("[data-file]")).toHaveLength(4);
    expect(container.textContent).toContain("+1");
    expect(container.textContent).toContain("+15 −0");
  });
});
