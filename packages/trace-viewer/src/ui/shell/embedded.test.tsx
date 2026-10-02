// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStaticBundleSource } from "../../sources/static-bundle.js";
import { fixtureBundle, stubLayout, type LayoutStub } from "../../test-support/ui-harness.js";
import type { ViewerLocation } from "../state/location.js";
import { composeViews, openingView, VIEWS } from "../views/registry.js";
import { hostViewsOf, viewKeyOf, type ViewDefinition } from "../views/view-port.js";
import { TraceViewer } from "./TraceViewer.js";

let layout: LayoutStub;
beforeEach(() => {
  layout = stubLayout();
});
afterEach(() => {
  cleanup();
  layout.restore();
  vi.restoreAllMocks();
});

const surfaces: ViewDefinition = { kind: "surfaces", label: "Surfaces", icon: "view-surfaces", Component: () => <p>Surfaces body</p> };
const impostor: ViewDefinition = { kind: "canvas", label: "Impostor", icon: "view-canvas", Component: () => <p>Impostor body</p> };

function lastView(onLocation: ReturnType<typeof vi.fn>): string | undefined {
  return (onLocation.mock.calls.at(-1)?.[0] as ViewerLocation | undefined)?.view;
}

function press(code: string, key: string): void {
  fireEvent.keyDown(document.body, { code, key });
}

describe("view registry (spec §3.7, §8.5, §8.6)", () => {
  it("orders the built-in views by key and appends host views from key 4; a clashing kind is dropped", () => {
    const views = composeViews([surfaces, impostor]);
    expect(views.map((view) => view.kind)).toEqual(["console", "canvas", "hybrid", "map", "surfaces"]);
    expect(views.map((view) => viewKeyOf(view.kind, views))).toEqual([0, 1, 2, 3, 4]);
    expect(hostViewsOf(views).map((view) => view.kind)).toEqual(["surfaces"]);
    expect(composeViews(undefined)).toBe(VIEWS);
    expect(composeViews([])).toBe(VIEWS);
  });

  it("opens on the location's view, else initialView, else Console embedded and Hybrid in full chrome", () => {
    const views = composeViews([surfaces]);
    expect(openingView(views, "embedded", undefined, undefined)).toBe("console");
    expect(openingView(views, "full", undefined, undefined)).toBe("hybrid");
    expect(openingView(views, "embedded", undefined, "surfaces")).toBe("surfaces");
    expect(openingView(views, "embedded", "canvas", "surfaces")).toBe("canvas");
    expect(openingView(VIEWS, "full", "surfaces", undefined)).toBe("hybrid");
  });
});

describe("chrome (spec §8.5)", () => {
  it("full chrome keeps the title, the Outline and Hybrid", async () => {
    const bundle = fixtureBundle("oauth");
    const firstLine = bundle.session.prompt.split(/\r?\n/)[0] ?? "";
    const onLocation = vi.fn();
    render(<TraceViewer source={createStaticBundleSource(bundle)} host={{ onLocation }} />);
    await waitFor(() => expect(lastView(onLocation)).toBe("hybrid"));
    expect(screen.getByRole("navigation", { name: "Outline" })).toBeTruthy();
    // The title fills once the summary loads; onLocation reports the view before that.
    expect(await within(screen.getByRole("banner")).findByText(firstLine)).toBeTruthy();
  });

  it("embedded chrome drops the title and the Outline and opens on the Console", async () => {
    const bundle = fixtureBundle("oauth");
    const firstLine = bundle.session.prompt.split(/\r?\n/)[0] ?? "";
    const onLocation = vi.fn();
    render(<TraceViewer source={createStaticBundleSource(bundle)} chrome="embedded" host={{ onLocation }} />);
    await waitFor(() => expect(lastView(onLocation)).toBe("console"));
    // Wait for the loaded, terminal session (the Live segment reads Completed) so the missing title is not a race.
    await within(screen.getByRole("banner")).findByRole("button", { name: /Completed/ });
    expect(screen.queryByRole("navigation", { name: "Outline" })).toBeNull();
    expect(within(screen.getByRole("banner")).queryByText(firstLine)).toBeNull();
    expect(screen.getByRole("radiogroup", { name: "View" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Inspector" })).toBeTruthy();
  });

  it("hands the host a working switcher and takes it back on unmount", async () => {
    const onLocation = vi.fn();
    const source = createStaticBundleSource(fixtureBundle("oauth"));
    function Host({ show }: { show: boolean }) {
      const [switcher, setSwitcher] = useState<ReactNode>(null);
      return (
        <>
          <div data-testid="slot">{switcher}</div>
          {show ? <TraceViewer source={source} chrome="embedded" renderSwitch={setSwitcher} host={{ onLocation }} /> : null}
        </>
      );
    }
    const { rerender } = render(<Host show />);
    const slot = screen.getByTestId("slot");
    const group = await within(slot).findByRole("radiogroup", { name: "View" });
    expect(screen.getAllByRole("radiogroup", { name: "View" })).toHaveLength(1);
    expect(within(group).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["Console", "Canvas", "Hybrid", "Map"]);
    expect(within(group).getByRole("radio", { name: /Console/ }).getAttribute("title")).toBe("Console (0)");
    fireEvent.click(within(group).getByRole("radio", { name: /Hybrid/ }));
    await waitFor(() => expect(lastView(onLocation)).toBe("hybrid"));
    rerender(<Host show={false} />);
    expect(slot.childElementCount).toBe(0);
  });

  it("host views follow the built-ins, and keys 0 to 4 switch between all five", async () => {
    const onLocation = vi.fn();
    const hostViews = [surfaces, impostor];
    render(
      <TraceViewer
        source={createStaticBundleSource(fixtureBundle("oauth"))}
        chrome="embedded"
        hostViews={hostViews}
        host={{ onLocation }}
      />,
    );
    const group = await screen.findByRole("radiogroup", { name: "View" });
    expect(within(group).getAllByRole("radio").map((radio) => radio.textContent)).toEqual([
      "Console",
      "Canvas",
      "Hybrid",
      "Map",
      "Surfaces",
    ]);
    expect(within(group).getByRole("radio", { name: /Surfaces/ }).getAttribute("title")).toBe("Surfaces (4)");
    expect(screen.queryByText("Impostor body")).toBeNull();
    press("Digit4", "4");
    await waitFor(() => expect(lastView(onLocation)).toBe("surfaces"));
    press("Digit3", "3");
    await waitFor(() => expect(lastView(onLocation)).toBe("map"));
    expect(screen.getByRole("region", { name: "Codebase map" })).toBeTruthy();
    press("Digit2", "2");
    await waitFor(() => expect(lastView(onLocation)).toBe("hybrid"));
    press("Digit0", "0");
    await waitFor(() => expect(lastView(onLocation)).toBe("console"));
  });
});
