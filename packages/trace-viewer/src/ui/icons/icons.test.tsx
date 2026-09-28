// @vitest-environment jsdom
import { ChangeCategorySchema } from "@jevcode/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LANES, SIGNAL_IDS, STEP_KINDS } from "../../model/index.js";
import { Icon } from "./Icon.js";
import { ICON_NAMES } from "./icon-names.js";
import { IconSprite } from "./IconSprite.js";
import { CATEGORY_ICON, KIND_ICON, LANE_ICON, LANE_LABEL, SIGNAL_ICON } from "./kind-icons.js";
import { ICON_PATHS } from "./paths.js";

afterEach(() => cleanup());

describe("icon family", () => {
  it("has non-empty stroke path data for every name", () => {
    for (const name of ICON_NAMES) {
      expect(ICON_PATHS[name].length, name).toBeGreaterThan(0);
      for (const d of ICON_PATHS[name]) expect(d, name).toMatch(/^[Mm][\d.\s,a-zA-Z-]+$/);
    }
  });

  it("renders one symbol per name, 16x16, 1.5px stroke, round caps", () => {
    const { container } = render(<IconSprite />);
    const sprite = container.querySelector("svg");
    expect(sprite?.getAttribute("aria-hidden")).toBe("true");
    const symbols = container.querySelectorAll("symbol");
    expect(symbols).toHaveLength(ICON_NAMES.length);
    for (const name of ICON_NAMES) {
      const symbol = container.querySelector(`symbol#tv-i-${name}`);
      expect(symbol, name).not.toBeNull();
      expect(symbol?.getAttribute("viewBox")).toBe("0 0 16 16");
      expect(symbol?.getAttribute("stroke-width")).toBe("1.5");
      expect(symbol?.getAttribute("stroke-linecap")).toBe("round");
      expect(symbol?.getAttribute("fill")).toBe("none");
    }
  });

  it("an icon with a title is an image with an accessible name", () => {
    render(<Icon name="neq" title="contradicts" />);
    const img = screen.getByRole("img", { name: "contradicts" });
    expect(img.querySelector("use")?.getAttribute("href")).toBe("#tv-i-neq");
    expect(img.getAttribute("width")).toBe("16");
  });

  it("an icon without a title is hidden from assistive tech", () => {
    const { container } = render(<Icon name="term" size={12} />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("role")).toBeNull();
    expect(svg?.getAttribute("height")).toBe("12");
  });

  it("maps every kind, lane, category and signal to a real icon", () => {
    const names = new Set<string>(ICON_NAMES);
    for (const kind of STEP_KINDS) expect(names.has(KIND_ICON[kind]), kind).toBe(true);
    for (const lane of LANES) {
      expect(names.has(LANE_ICON[lane]), lane).toBe(true);
      expect(LANE_LABEL[lane].length).toBeGreaterThan(0);
    }
    for (const category of ChangeCategorySchema.options) expect(names.has(CATEGORY_ICON[category]), category).toBe(true);
    for (const signal of SIGNAL_IDS) expect(names.has(SIGNAL_ICON[signal]), signal).toBe(true);
    expect(KIND_ICON.command).toBe("term");
    expect(CATEGORY_ICON.schema).toBe("table");
  });
});
