// @vitest-environment jsdom
import type { SurfaceManager } from "@jevcode/ui-catalog";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SurfacesContext, type SessionSurfaces } from "./session-surfaces.js";
import { SurfacesView } from "./surfaces-view.js";

afterEach(cleanup);

describe("SurfacesView pointer guard", () => {
  it("releases the pointer hold when the view unmounts, so swaps are not deferred forever", () => {
    const manager = { setPointerInside: vi.fn(), notifyInteraction: vi.fn() };
    const surfaces = {
      sessionId: "s1",
      sessionState: null,
      manager: manager as unknown as SurfaceManager,
      entries: [],
      events: [],
      recordedFiles: [],
      togglePin: () => undefined,
      dismiss: () => undefined,
    } satisfies SessionSurfaces;
    const view = render(
      <SurfacesContext.Provider value={surfaces}>
        <SurfacesView active />
      </SurfacesContext.Provider>,
    );
    view.container.querySelector("section")!.dispatchEvent(new Event("pointerenter"));
    expect(manager.setPointerInside).toHaveBeenLastCalledWith(true);
    view.unmount();
    expect(manager.setPointerInside).toHaveBeenLastCalledWith(false);
  });
});
