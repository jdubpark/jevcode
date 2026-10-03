// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RepoOpenedPayload, SessionStatePayload } from "../payload-types.js";
import { Header, repoDisplayName } from "./Header.js";

const REPO: RepoOpenedPayload = { repoId: "r1", path: "/work/acme-web", gitRoot: "/work/acme-web", branch: "main", baseCommit: "abc" };
const STARTED = "2026-10-02T10:00:00.000Z";

function state(overrides: Partial<SessionStatePayload> = {}): SessionStatePayload {
  return { sessionId: "s1", state: "completed", changeUnitCount: 0, decisionCount: 0, ts: "2026-10-02T10:04:12.000Z", ...overrides };
}

function renderHeader(
  props: { repo?: RepoOpenedPayload; prompt?: string; sessionState?: SessionStatePayload | null; handlers?: Partial<Record<string, () => void>> } = {},
) {
  const noop = (): void => undefined;
  return render(
    <Header
      repo={props.repo ?? REPO}
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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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

  it("renders the repo path and prompt tooltips through displayUntrusted", () => {
    renderHeader({ repo: { ...REPO, path: "/work/acme\u202Ebew", gitRoot: "/work/acme\u202Ebew" }, prompt: "fix \u202Egnp.exe" });
    const repoTitle = document.querySelector(".crumb-repo")?.getAttribute("title") ?? "";
    const taskTitle = document.querySelector(".crumb-task")?.getAttribute("title") ?? "";
    expect(repoTitle).toBe("/work/acme⟨U+202E⟩bew");
    expect(taskTitle).toBe("fix ⟨U+202E⟩gnp.exe");
  });

  it("names a repository at the file-system root instead of leaving the crumb blank", () => {
    expect(repoDisplayName({ ...REPO, path: "/", gitRoot: "/" })).toBe("/");
    expect(repoDisplayName({ ...REPO, gitRoot: "/work/acme-web/" })).toBe("acme-web");
  });

  it("ticks the chip while the session runs and holds it once the session ends", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(Date.parse(STARTED) + 20_000);
    const { rerender } = renderHeader({ sessionState: state({ state: "running", ts: STARTED }) });
    const chip = (): string => document.querySelector(".chip")?.textContent ?? "";
    expect(chip()).toMatch(/· 20 s$/);
    act(() => vi.advanceTimersByTime(3_000));
    expect(chip()).toMatch(/· 23 s$/);

    const noop = (): void => undefined;
    rerender(
      <Header
        repo={REPO}
        sessionState={state({ state: "completed", ts: "2026-10-02T10:00:30.000Z" })}
        sessionPrompt="Add Google OAuth login"
        sessionStartedAt={STARTED}
        terminalOpen={false}
        debugOpen={false}
        onOpenRepo={noop}
        onToggleTerminal={noop}
        onToggleDebug={noop}
        onCloseRepo={noop}
        onOpenTrace={noop}
      />,
    );
    expect(chip()).toBe("Completed · 30 s");
    act(() => vi.advanceTimersByTime(5_000));
    expect(chip()).toBe("Completed · 30 s");
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
