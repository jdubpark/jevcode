// @vitest-environment jsdom
import { displayUntrusted } from "@jevcode/trace-viewer/model";
import { SurfaceManager } from "@jevcode/ui-catalog";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SurfacesContext, type SessionSurfaces } from "./session-surfaces.js";
import { ActivityEvent, SurfacesView, surfacesView } from "./surfaces-view.js";

function surfaces(overrides: Partial<SessionSurfaces> = {}): SessionSurfaces {
  return {
    sessionId: "s1",
    sessionState: { sessionId: "s1", state: "running", changeUnitCount: 2, decisionCount: 0, ts: "2026-10-02T10:00:00.000Z" },
    manager: new SurfaceManager(),
    entries: [],
    events: [],
    recordedFiles: [],
    togglePin: vi.fn(),
    dismiss: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("Surfaces host view (spec E3)", () => {
  it("is registered as kind surfaces with its own icon", () => {
    expect([surfacesView.kind, surfacesView.label, surfacesView.icon]).toEqual(["surfaces", "Surfaces", "view-surfaces"]);
  });

  it("keeps the Overview, Conversation and Decisions tabs, with conversation-only events under Conversation", () => {
    const ts = "2026-10-02T10:00:01.000Z";
    render(
      <SurfacesContext.Provider
        value={surfaces({
          events: [
            { type: "agent_message", sessionId: "s1", role: "assistant", text: "Reading the router \u202Eevil", ts },
            { type: "command_started", sessionId: "s1", command: "pnpm test", ts },
          ],
        })}
      >
        <SurfacesView active />
      </SurfacesContext.Provider>,
    );
    expect(screen.getByRole("button", { name: /Conversation/ }).textContent).toContain("1");
    fireEvent.click(screen.getByRole("button", { name: /Conversation/ }));
    const feed = screen.getByText(/Reading the router/);
    // Plain text, never markup: the bidi override stays a character in a text node.
    expect(feed.tagName).toBe("P");
    expect(document.body.innerHTML).not.toContain("<script");
    expect(screen.queryByText("pnpm test")).toBeNull();
  });

  it("shows the decisions empty state when nothing waits", () => {
    render(
      <SurfacesContext.Provider value={surfaces()}>
        <SurfacesView active />
      </SurfacesContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Decisions/ }));
    expect(screen.getByText("No decisions yet")).toBeTruthy();
  });

  it("renders agent text through displayUntrusted with the full text as tooltip and name", () => {
    const ts = "2026-10-02T10:00:01.000Z";
    const hostile = `ok \u202Eevil\u200Bzero ${"x".repeat(2000)}`;
    render(
      <SurfacesContext.Provider
        value={surfaces({
          events: [
            { type: "agent_message", sessionId: "s1", role: "assistant", text: hostile, ts },
            { type: "agent_message", sessionId: "s1", role: "assistant", text: "short \u202Eflip", ts },
          ],
        })}
      >
        <SurfacesView active />
      </SurfacesContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Conversation/ }));
    const short = screen.getByText(/short/);
    expect(short.textContent).toBe(displayUntrusted("short \u202Eflip"));
    expect(short.textContent).not.toContain("\u202E");
    expect(short.getAttribute("title")).toBe(displayUntrusted("short \u202Eflip", { multiline: true }));
    // A paragraph takes no name (aria-label is prohibited on it); the full text is its tooltip and "Read full update".
    expect(short.hasAttribute("aria-label")).toBe(false);
    const clipped = screen.getByText(/ok /);
    expect(clipped.textContent).not.toContain("\u202E");
    // Lane 02b I-4: displayUntrusted shows zero-width characters as visible tokens.
    expect(clipped.textContent).not.toContain("\u200B");
    expect(clipped.textContent).toContain("⟨U+200B⟩");
    expect(clipped.getAttribute("title")).toBe(displayUntrusted(hostile, { multiline: true }));
    expect(clipped.getAttribute("title")).toContain("x".repeat(2000));
  });

  it("renders command output and spec-supplied surface titles through displayUntrusted", () => {
    const manager = new SurfaceManager();
    const title = "Review \u202Efdp.exe";
    const entry = {
      surface: { id: "change:1", pinned: false, spec: { root: "r", elements: { r: { type: "Stack", props: { title }, children: [] } } } },
      meta: { group: "change", label: "Change", title },
    } as unknown as SessionSurfaces["entries"][number];
    render(
      <SurfacesContext.Provider
        value={surfaces({
          manager,
          entries: [entry],
        })}
      >
        <SurfacesView active />
      </SurfacesContext.Provider>,
    );
    const titleEl = document.querySelector(".surface-title") as HTMLElement;
    expect(titleEl.textContent).toBe(displayUntrusted(title));
    expect(titleEl.textContent).not.toContain("\u202E");
    expect(titleEl.getAttribute("title")).toBe(displayUntrusted(title));
    // A generic span takes no name (aria-label is prohibited on it); its text and tooltip carry the title
    // (final review C M-2).
    expect(titleEl.hasAttribute("aria-label")).toBe(false);
  });

  it("renders command output through displayUntrusted, keeping line breaks", () => {
    const stdout = `out\u202Ex\nline2 ${"z".repeat(2000)}`;
    render(
      <ActivityEvent
        event={{ type: "command_completed", sessionId: "s1", command: "c", exitCode: 0, stdout, stderr: "err\u0007", ts: "2026-10-02T10:00:01.000Z" }}
      />,
    );
    const pre = document.querySelector("pre") as HTMLElement;
    expect(pre.textContent).toBe(displayUntrusted([stdout, "err\u0007"].join("\n").slice(0, 5000), { multiline: true }));
    expect(pre.textContent).not.toContain("\u202E");
    expect(pre.textContent).toContain("\n");
    expect(pre.getAttribute("title")).toBe(displayUntrusted([stdout, "err\u0007"].join("\n"), { multiline: true }));
  });

  it("renders an operation's label, agent text included, through displayUntrusted with the full text as its tooltip (fix wave minor 4)", () => {
    const error = `quota \u202Eexceeded ${"y".repeat(300)}`;
    render(<ActivityEvent event={{ type: "agent_failed", sessionId: "s1", error, ts: "2026-10-02T10:00:01.000Z" }} />);
    const label = document.querySelector(".activity-operation-copy span") as HTMLElement;
    expect(label.textContent).toBe(displayUntrusted(`Stopped: ${error}`));
    expect(label.textContent).not.toContain("\u202E");
    expect(label.getAttribute("title")).toBe(displayUntrusted(`Stopped: ${error}`));
    expect(label.getAttribute("title")).toContain("y".repeat(300));
  });
});
