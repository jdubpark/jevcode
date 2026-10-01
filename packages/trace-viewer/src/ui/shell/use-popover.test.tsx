// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { afterEach, describe, expect, it } from "vitest";

import { usePopoverDismissal } from "./use-popover.js";

afterEach(() => cleanup());

function Popover({ host }: { host: HTMLElement }) {
  const [open, setOpen] = useState(true);
  const { anchorRef, triggerRef } = usePopoverDismissal(open, setOpen);
  return createPortal(
    <span ref={anchorRef}>
      <button ref={triggerRef} type="button">
        trigger
      </button>
      {open ? <p role="dialog">popover</p> : null}
    </span>,
    host,
  );
}

describe("usePopoverDismissal in a popout window", () => {
  it("listens on the anchor's own document, not the global one", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const popout = frame.contentDocument as Document;
    render(<Popover host={popout.body} />);
    expect(popout.querySelector('[role="dialog"]')).not.toBeNull();
    // An Escape in the main document is another window's key.
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(popout.querySelector('[role="dialog"]')).not.toBeNull();
    // A press inside the anchor keeps it open; Escape in the popout's own document closes it.
    act(() => {
      popout.querySelector("button")?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(popout.querySelector('[role="dialog"]')).not.toBeNull();
    act(() => {
      popout.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(popout.querySelector('[role="dialog"]')).toBeNull();
  });
});
