// @vitest-environment jsdom
import type { TraceSource, ViewDefinition, ViewerHost } from "@jevcode/trace-viewer";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RepoOpenedPayload, SessionStatePayload } from "../payload-types.js";
import { installFakeBridge, type FakeBridge } from "../test-support/fake-bridge.js";
import { WorkspaceHost } from "./WorkspaceHost.js";

const viewerLog = vi.hoisted(() => ({
  mounts: [] as Array<{ sessionId: string; chrome: string | undefined; initialView: string | undefined; hostViews: string[] }>,
  unmounts: [] as string[],
  hosts: [] as ViewerHost[],
  /** Mount the host views (Surfaces) inside the stand-in, as the real viewer does on key 4. */
  renderHostViews: false,
}));

// The viewer itself is lane 02's and has its own tests. This stand-in keeps
// the part this lane owns observable: one real DataController per mount,
// started on mount and stopped on unmount, exactly as TraceViewer does.
vi.mock("@jevcode/trace-viewer", async () => {
  const React = await import("react");
  const { createDataController } = await import("@jevcode/trace-viewer/data-controller");
  interface FakeProps {
    source: TraceSource;
    host?: ViewerHost;
    chrome?: string;
    initialView?: string;
    hostViews?: readonly ViewDefinition[];
    pollMs?: number;
  }
  function TraceViewer(props: FakeProps) {
    const [controller] = React.useState(() =>
      createDataController({ source: props.source, pollMs: props.pollMs ?? 1_000 }),
    );
    React.useEffect(() => {
      viewerLog.mounts.push({
        sessionId: props.source.sessionId,
        chrome: props.chrome,
        initialView: props.initialView,
        hostViews: (props.hostViews ?? []).map((view) => view.kind),
      });
      if (props.host !== undefined) viewerLog.hosts.push(props.host);
      controller.start();
      return () => {
        controller.stop();
        viewerLog.unmounts.push(props.source.sessionId);
      };
    }, [controller]);
    return React.createElement(
      "div",
      { "data-testid": "viewer", "data-session": props.source.sessionId },
      viewerLog.renderHostViews
        ? (props.hostViews ?? []).map((view) => React.createElement(view.Component, { key: view.kind, active: true }))
        : null,
    );
  }
  return { TraceViewer };
});

const REPO: RepoOpenedPayload = {
  repoId: "repo_1",
  path: "/work/api",
  gitRoot: "/work/api",
  branch: "main",
  baseCommit: "abc123",
};

function stateFor(sessionId: string): SessionStatePayload {
  return { sessionId, state: "running", changeUnitCount: 0, decisionCount: 0, ts: "2026-10-02T10:00:00.000Z" };
}

function host(sessionId: string) {
  return (
    <WorkspaceHost
      repo={REPO}
      sessionState={stateFor(sessionId)}
      activePrompt="Add Google OAuth"
      agentLine="Codex"
      onStart={() => undefined}
    />
  );
}

const prompt = (): HTMLTextAreaElement => screen.getByLabelText("Guide the agent") as HTMLTextAreaElement;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let bridge: FakeBridge;

beforeEach(() => {
  viewerLog.mounts.length = 0;
  viewerLog.unmounts.length = 0;
  viewerLog.hosts.length = 0;
  viewerLog.renderHostViews = false;
  bridge = installFakeBridge();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("WorkspaceHost embeds the trace viewer (spec §9, E2)", () => {
  it("opens the active session on Console in embedded chrome with the Surfaces view", async () => {
    render(host("s1"));
    await waitFor(() => expect(bridge.rowsCalls("s1")).toBeGreaterThan(0));
    expect(viewerLog.mounts).toEqual([
      { sessionId: "s1", chrome: "embedded", initialView: "console", hostViews: ["surfaces"] },
    ]);
  });

  it("a push hint for the shown session fetches at once, without waiting for the 1 s poll", async () => {
    render(host("s1"));
    await waitFor(() => expect(bridge.rowsCalls("s1")).toBe(1));
    await act(async () => {
      await sleep(50);
    });
    const before = bridge.rowsCalls("s1");
    act(() => bridge.emitRowsAvailable({ sessionId: "s1", lastSeq: 7 }));
    await waitFor(() => expect(bridge.rowsCalls("s1")).toBe(before + 1), { timeout: 400 });
  });

  // Index Review Focus 4.
  it("switching sessions while live stops the old viewer, opens the new one on Console and resets the draft", async () => {
    const { rerender } = render(host("s1"));
    await waitFor(() => expect(bridge.rowsCalls("s1")).toBeGreaterThan(0));
    fireEvent.change(prompt(), { target: { value: "draft for s1" } });
    expect(prompt().value).toBe("draft for s1");

    rerender(host("s2"));
    await waitFor(() => expect(bridge.rowsCalls("s2")).toBeGreaterThan(0));

    expect(viewerLog.unmounts).toEqual(["s1"]);
    expect(viewerLog.mounts.map((mount) => [mount.sessionId, mount.initialView, mount.chrome])).toEqual([
      ["s1", "console", "embedded"],
      ["s2", "console", "embedded"],
    ]);
    expect(screen.getAllByTestId("viewer").map((element) => element.getAttribute("data-session"))).toEqual(["s2"]);
    expect(prompt().value).toBe("");

    // No stale rows: the stopped controller neither follows s1's hints nor polls.
    const s1Calls = bridge.rowsCalls("s1");
    act(() => bridge.emitRowsAvailable({ sessionId: "s1", lastSeq: 99 }));
    await act(async () => {
      await sleep(1_200);
    });
    expect(bridge.rowsCalls("s1")).toBe(s1Calls);
    expect(bridge.rowsListenerCount()).toBe(1);
  });

  it("a review note for another session is held, then becomes the draft on switching to it", async () => {
    const { rerender } = render(host("s2"));
    act(() => bridge.emitComposerPrefill({ sessionId: "s1", text: "Re: step 3" }));
    expect(await screen.findByText(/Trace note for another session/)).toBeTruthy();
    expect(prompt().value).toBe("");
    rerender(host("s1"));
    await waitFor(() => expect(prompt().value).toBe("Re: step 3"));
    expect(bridge.calls.sendInstruction).not.toHaveBeenCalled();
  });

  it("Request changes in the embedded viewer prefills the local composer and sends nothing", async () => {
    render(host("s1"));
    await waitFor(() => expect(viewerLog.hosts).toHaveLength(1));
    await act(async () => {
      await viewerLog.hosts[0]?.requestChanges?.({ sessionId: "s1", selected: "step:3", text: "Re: step 3" });
    });
    await waitFor(() => expect(prompt().value).toBe("Re: step 3"));
    expect(bridge.calls.sendInstruction).not.toHaveBeenCalled();
    expect(bridge.calls.traceRequestChanges).not.toHaveBeenCalled();
  });

  it("shows the onboarding prompt before the first task", () => {
    render(
      <WorkspaceHost repo={REPO} sessionState={null} activePrompt="" agentLine="Codex" onStart={() => undefined} />,
    );
    expect(screen.getByText("What are we building?")).toBeTruthy();
    expect(viewerLog.mounts).toEqual([]);
  });
});

describe("WorkspaceHost after the dock move (spec §9)", () => {
  it("has no context rail: Now and Changes live in the Brief", async () => {
    render(host("s1"));
    await waitFor(() => expect(bridge.rowsCalls("s1")).toBeGreaterThan(0));
    expect(screen.queryByLabelText("Live session context")).toBeNull();
    expect(screen.getByRole("region", { name: "Prompt" })).toBeTruthy();
  });

  it("shows this session's queued instructions in the dock", async () => {
    render(host("s1"));
    act(() =>
      bridge.emitInstructionState({
        sessionId: "s1",
        pending: [{ id: "i1", mode: "queue", text: "then update the docs" }],
      } as Parameters<FakeBridge["emitInstructionState"]>[0]),
    );
    expect((await screen.findByRole("list", { name: "Queued instructions" })).textContent).toContain("then update the docs");
  });
});

// Regression: the desktop once mounted its own @json-render/react provider (a second copy, zod 3 peer) around
// ui-catalog components that read ui-catalog's copy (zod 4 peer), so they threw "useActions must be used within an
// ActionProvider". The desktop no longer depends on @json-render/react; surfaces render through CatalogSurface.
describe("WorkspaceHost catalog surfaces answer through action:invoke", () => {
  const decisionSpec = {
    root: "decision",
    elements: {
      decision: {
        type: "Decision",
        props: {
          decisionId: "dec-redis-1",
          title: "Redis unavailability policy",
          severity: "required",
          context: "What should happen when Redis is unavailable?",
          options: [
            { id: "fail_open", label: "Fail open", description: "Allow requests through." },
            { id: "fail_closed", label: "Fail closed", description: "Reject requests with 503." },
          ],
          actions: [
            {
              action: "answer_decision",
              params: { decisionId: "dec-redis-1", decision: { redis_failure_policy: "fail_closed" }, evidence: ["se-1"] },
            },
            { action: "delegate_decision", params: { decisionId: "dec-redis-1" } },
          ],
        },
        children: [],
      },
    },
  };

  const matrixSpec = {
    root: "matrix",
    elements: {
      matrix: {
        type: "TestMatrix",
        props: {
          title: "Verification",
          rows: [{ name: "unit", status: "failed", passed: 4, failed: 1, skipped: 0 }],
          actions: [
            { action: "show_exact_diff", params: { files: ["src/limiter.ts"] } },
            { action: "continue_task", params: {} },
          ],
        },
        children: [],
      },
    },
  };

  function showSurface(surfaceId: string, spec: unknown) {
    viewerLog.renderHostViews = true;
    render(host("s1"));
    act(() => bridge.emit("ui:spec", { sessionId: "s1", surfaceId, spec }));
  }

  it("renders a pushed Decision surface and sends the chosen option to main", async () => {
    const consoleError = vi.spyOn(console, "error");
    showSurface("decision:dec-redis-1", decisionSpec);
    expect(await screen.findByText("Fail open")).toBeTruthy();
    expect(screen.getByText("Fail closed")).toBeTruthy();

    fireEvent.click(screen.getByTestId("choose-fail_open"));
    await waitFor(() => expect(bridge.calls.actionInvoke).toHaveBeenCalledTimes(1));
    // The suggested answer's key and evidence carry over; the option is the one clicked.
    expect(bridge.calls.actionInvoke).toHaveBeenCalledWith("answer_decision", {
      decisionId: "dec-redis-1",
      decision: { redis_failure_policy: "fail_open" },
      evidence: ["se-1"],
    });

    fireEvent.click(screen.getByTestId("delegate"));
    await waitFor(() => expect(bridge.calls.actionInvoke).toHaveBeenCalledTimes(2));
    expect(bridge.calls.actionInvoke).toHaveBeenLastCalledWith("delegate_decision", { decisionId: "dec-redis-1" });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("renders a surface's action buttons and sends each click to main", async () => {
    const consoleError = vi.spyOn(console, "error");
    showSurface("validation:unit", matrixSpec);
    const buttons = await screen.findByTestId("action-buttons");

    fireEvent.click(buttons.querySelector('[data-action="show_exact_diff"]') as HTMLButtonElement);
    await waitFor(() => expect(bridge.calls.actionInvoke).toHaveBeenCalledTimes(1));
    expect(bridge.calls.actionInvoke).toHaveBeenCalledWith("show_exact_diff", { files: ["src/limiter.ts"] });
    expect(consoleError).not.toHaveBeenCalled();
  });
});
