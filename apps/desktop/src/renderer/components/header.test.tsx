// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RepoOpenedPayload, SessionStatePayload } from "../payload-types.js";
import { Header } from "./Header.js";

const REPO: RepoOpenedPayload = { repoId: "r1", path: "/work/acme-web", gitRoot: "/work/acme-web", branch: "main", baseCommit: "abc" };
const STARTED = "2026-10-02T10:00:00.000Z";

function state(overrides: Partial<SessionStatePayload> = {}): SessionStatePayload {
  return { sessionId: "s1", state: "completed", changeUnitCount: 0, decisionCount: 0, ts: "2026-10-02T10:04:12.000Z", ...overrides };
}

function renderHeader(props: { prompt?: string; sessionState?: SessionStatePayload | null; handlers?: Partial<Record<string, () => void>> } = {}) {
  const noop = (): void => undefined;
  return render(
    <Header
      repo={REPO}
      sessionState={props.sessionState === undefined ? state() : props.sessionState}
      sessionPrompt={props.prompt ?? "Add Google OAuth login"}
      sessionStartedAt={STARTED}
      terminalOpen={false}
      debugOpen={false}
      onOpenRepo={props.handlers?.open ?? noop}
      onToggleTerminal={props.handlers?.terminal ?? noop}
      onToggleDebug={props.handlers?.inspect ?? noop}
      onCloseRepo={props.handlers?.close ?? noop}
      onOpenTrace={props.handlers?.trace ?? noop}
    />,
  );
}

afterEach(cleanup);

describe("Header breadcrumb (console-main mockup)", () => {
  it("shows the repo name, a slash and the session prompt with the full text as title", () => {
    const prompt = "Add Google OAuth login while preserving existing email and password accounts";
    renderHeader({ prompt });
    expect(screen.getByText("acme-web")).toBeTruthy();
    const task = screen.getByText(prompt);
    expect(task.getAttribute("title")).toBe(prompt);
    expect(screen.queryByText("/work/acme-web")).toBeNull();
  });

  it("renders a hostile prompt through displayUntrusted", () => {
    renderHeader({ prompt: "fix ‮gnp.exe" });
    const task = document.querySelector(".crumb-task");
    expect(task?.textContent).toBe("fix ⟨U+202E⟩gnp.exe");
    expect(task?.textContent).not.toContain("‮");
  });

  it("shows the state and the elapsed time in a chip", () => {
    renderHeader({ sessionState: state({ state: "completed", ts: "2026-10-02T10:04:12.000Z" }) });
    expect(document.querySelector(".chip")?.textContent).toBe("Completed · 4 m 12 s");
  });

  it("labels a session that waits on a decision", () => {
    renderHeader({ sessionState: state({ state: "waiting_decision" }) });
    const chip = document.querySelector(".chip");
    expect(chip?.className).toContain("agent-waiting_decision");
    expect(chip?.textContent).toContain("Needs your decision");
  });

  it("keeps Open, Close repo, Terminal, Inspect and Trace reachable by name", () => {
    const calls: string[] = [];
    const handlers = {
      open: vi.fn(() => calls.push("open")),
      close: vi.fn(() => calls.push("close")),
      terminal: vi.fn(() => calls.push("terminal")),
      inspect: vi.fn(() => calls.push("inspect")),
      trace: vi.fn(() => calls.push("trace")),
    };
    renderHeader({ handlers });
    for (const name of ["Open", "Close repo", "Terminal", "Inspect", "Trace"]) {
      fireEvent.click(screen.getByRole("button", { name }));
    }
    expect(calls).toEqual(["open", "close", "terminal", "inspect", "trace"]);
  });

  it("disables Trace without a session and shows no chip", () => {
    renderHeader({ sessionState: null, prompt: "" });
    expect((screen.getByRole("button", { name: "Trace" }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector(".chip")).toBeNull();
  });
});
