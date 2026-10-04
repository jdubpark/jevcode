// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_AGENT_PREFERENCES } from "../../shared/prefs.js";
import { App } from "../App.js";
import { installFakeBridge } from "../test-support/fake-bridge.js";

beforeEach(() => {
  const bridge = installFakeBridge();
  vi.mocked(bridge.api.prefs.get).mockResolvedValue({ ...DEFAULT_AGENT_PREFERENCES });
});
afterEach(cleanup);

async function openSettings(): Promise<{ row: HTMLElement; heading: HTMLElement; workspace: HTMLElement }> {
  render(<App />);
  const row = screen.getByRole("button", { name: "Settings" });
  const workspace = document.querySelector(".workspace-column [data-workspace-slot]") as HTMLElement;
  fireEvent.click(row);
  const heading = await screen.findByRole("heading", { level: 1, name: "Settings" });
  return { row, heading, workspace };
}

function press(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe("Settings route", () => {
  it("opens from the sidebar row, keeps the workspace mounted, and returns focus on Esc", async () => {
    const { row, heading, workspace } = await openSettings();
    expect(document.activeElement).toBe(heading);
    expect(workspace.isConnected).toBe(true);
    expect(workspace.hidden).toBe(true);
    expect(press(heading, { key: "Escape", code: "Escape" }).defaultPrevented).toBe(true);
    await waitFor(() => expect(screen.queryByRole("heading", { level: 1, name: "Settings" })).toBeNull());
    expect(workspace.hidden).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(row));
  });

  it("opens with Cmd+, and Ctrl+,", async () => {
    render(<App />);
    press(window, { key: ",", metaKey: true });
    await screen.findByRole("heading", { level: 1, name: "Settings" });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.queryByRole("heading", { level: 1, name: "Settings" })).toBeNull());
    press(window, { key: ",", ctrlKey: true });
    await screen.findByRole("heading", { level: 1, name: "Settings" });
  });

  it("keeps keys aimed at the page body away from the hidden viewer, but lets Tab move focus", async () => {
    await openSettings();
    // The viewer's KeyboardLayer treats <body> targets as its own and skips prevented events.
    expect(press(document.body, { key: "j", code: "KeyJ" }).defaultPrevented).toBe(true);
    expect(press(document.body, { key: "Tab", code: "Tab" }).defaultPrevented).toBe(false);
    expect(press(document.body, { key: "Escape", code: "Escape" }).defaultPrevented).toBe(true);
    await waitFor(() => expect(screen.queryByRole("heading", { level: 1, name: "Settings" })).toBeNull());
  });

  it("lets scrolling keys scroll the page from <body> without reaching the hidden viewer's window listener", async () => {
    await openSettings();
    // Stands in for the viewer's KeyboardLayer: window, bubble phase.
    const viewerKeys = vi.fn();
    window.addEventListener("keydown", viewerKeys);
    try {
      for (const key of ["ArrowDown", " ", "PageDown", "End"]) {
        expect(press(document.body, { key }).defaultPrevented).toBe(false);
      }
      press(document.body, { key: "j", code: "KeyJ" });
      expect(viewerKeys).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", viewerKeys);
    }
  });
});
