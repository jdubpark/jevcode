// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStaticBundleSource } from "../../../sources/static-bundle.js";
import { fixtureBundle, stubLayout, type LayoutStub } from "../../../test-support/ui-harness.js";
import { TraceViewer } from "../../shell/TraceViewer.js";

vi.mock("./overview/Overview.js", () => ({
  Overview: () => {
    throw new Error("overview exploded");
  },
}));

let layout: LayoutStub;
beforeEach(() => {
  layout = stubLayout();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  layout.restore();
  vi.restoreAllMocks();
});

describe("registered Hybrid view", () => {
  it("a crashing view leaves the header, nav and aside mounted", () => {
    render(<TraceViewer source={createStaticBundleSource(fixtureBundle("oauth"))} />);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("banner")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Outline" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: /^(Brief|Inspector)$/ })).toBeTruthy();
  });
});
