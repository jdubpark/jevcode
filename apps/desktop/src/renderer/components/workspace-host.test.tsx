// @vitest-environment jsdom
import type { TraceSource, ViewerHost } from "@jevcode/trace-viewer";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RepoOpenedPayload, SessionStatePayload } from "../payload-types.js";
import { installFakeBridge, type FakeBridge } from "../test-support/fake-bridge.js";
import { WorkspaceHost } from "./WorkspaceHost.js";

const viewerLog = vi.hoisted(() => ({
  mounts: [] as Array<{ sessionId: string; chrome: string | undefined; initialView: string | undefined; hostViews: string[] }>,
  unmounts: [] as string[],
  hosts: [] as ViewerHost[],
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
    hostViews?: readonly { kind: string }[];
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
    return React.createElement("div", { "data-testid": "viewer", "data-session": props.source.sessionId });
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
    expect(bridge.rowsListenerCount()).toBeLessThanOrEqual(1);
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
