// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useReducer } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { composerReducer, initialComposer } from "../components/composer-prefill.js";
import type { SessionStatePayload } from "../payload-types.js";
import { PromptDock, continuesSession, type PromptDockProps } from "./PromptDock.js";

function fakeBridge() {
  return {
    agent: {
      sendInstruction: vi.fn(async (_sessionId: string, _text: string, _mode?: "queue" | "steer") => undefined),
      resume: vi.fn(async (_sessionId: string) => undefined),
      interrupt: vi.fn(async (_sessionId: string) => undefined),
      cancelInstruction: vi.fn(async (_sessionId: string, _instructionId: string) => undefined),
    },
    session: { switchTo: vi.fn(async (_sessionId: string) => undefined) },
  };
}

function Harness(props: {
  bridge: ReturnType<typeof fakeBridge>;
  state: SessionStatePayload["state"] | null;
  pending?: PromptDockProps["pending"];
}) {
  const [composer, dispatch] = useReducer(composerReducer, "s1", initialComposer);
  return (
    <PromptDock
      bridge={props.bridge as unknown as PromptDockProps["bridge"]}
      sessionId="s1"
      state={props.state}
      composer={composer}
      dispatch={dispatch}
      pending={props.pending ?? []}
      noteTargetPrompt={undefined}
    />
  );
}

const input = (): HTMLTextAreaElement => screen.getByLabelText("Guide the agent") as HTMLTextAreaElement;

afterEach(() => {
  cleanup();
});

describe("PromptDock (spec §3.1, §3.7)", () => {
  it("Cmd+Enter steers the running agent with the trimmed text and clears the draft", async () => {
    const bridge = fakeBridge();
    render(<Harness bridge={bridge} state="running" />);
    fireEvent.change(input(), { target: { value: "  add a test for the 429 path  " } });
    fireEvent.keyDown(input(), { key: "Enter", metaKey: true });
    await waitFor(() => expect(bridge.agent.sendInstruction).toHaveBeenCalledWith("s1", "add a test for the 429 path", "steer"));
    await waitFor(() => expect(input().value).toBe(""));
  });

  it("Enter alone keeps typing: nothing is sent", () => {
    const bridge = fakeBridge();
    render(<Harness bridge={bridge} state="running" />);
    fireEvent.change(input(), { target: { value: "line one" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(bridge.agent.sendInstruction).not.toHaveBeenCalled();
    expect(input().value).toBe("line one");
  });

  it("the timing toggle queues instead of steering", async () => {
    const bridge = fakeBridge();
    render(<Harness bridge={bridge} state="running" />);
    fireEvent.click(screen.getByRole("button", { name: "Instruction timing" }));
    expect(screen.getByRole("button", { name: "Instruction timing" }).textContent).toContain("Queue");
    fireEvent.change(input(), { target: { value: "then update the docs" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    await waitFor(() => expect(bridge.agent.sendInstruction).toHaveBeenCalledWith("s1", "then update the docs", "queue"));
  });

  it("a finished session continues: the text is queued, then the agent resumes", async () => {
    expect(["completed", "paused", "failed"].map((state) => continuesSession(state as SessionStatePayload["state"]))).toEqual([true, true, true]);
    expect(continuesSession("running")).toBe(false);
    const bridge = fakeBridge();
    render(<Harness bridge={bridge} state="completed" />);
    fireEvent.change(input(), { target: { value: "also handle Retry-After" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(bridge.agent.resume).toHaveBeenCalledWith("s1"));
    expect(bridge.agent.sendInstruction).toHaveBeenCalledWith("s1", "also handle Retry-After", "queue");
    expect(bridge.agent.sendInstruction.mock.invocationCallOrder[0]).toBeLessThan(bridge.agent.resume.mock.invocationCallOrder[0] ?? 0);
  });

  it("lists queued instructions above the prompt line, each cancellable", () => {
    const bridge = fakeBridge();
    render(
      <Harness
        bridge={bridge}
        state="running"
        pending={[
          { id: "i1", mode: "queue", text: "then update the docs" },
          { id: "i2", mode: "steer", text: "stop touching the cache" },
        ] as PromptDockProps["pending"]}
      />,
    );
    const queue = screen.getByRole("list", { name: "Queued instructions" });
    expect(queue.textContent).toContain("then update the docs");
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel queued instruction" })[1]!);
    expect(bridge.agent.cancelInstruction).toHaveBeenCalledWith("s1", "i2");
  });

  it("Cmd+L focuses the prompt line from anywhere", () => {
    const bridge = fakeBridge();
    render(<Harness bridge={bridge} state="running" />);
    expect(document.activeElement).not.toBe(input());
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "l", metaKey: true, bubbles: true }));
    });
    expect(document.activeElement).toBe(input());
  });

  it("a failed send keeps the draft and shows the error", async () => {
    const bridge = fakeBridge();
    bridge.agent.sendInstruction.mockRejectedValueOnce(new Error("session s1 is not running"));
    render(<Harness bridge={bridge} state="running" />);
    fireEvent.change(input(), { target: { value: "keep me" } });
    fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("session s1 is not running");
    expect(input().value).toBe("keep me");
  });

  it("Pause interrupts a running agent and Resume resumes a paused one", async () => {
    const bridge = fakeBridge();
    const { rerender } = render(<Harness bridge={bridge} state="running" />);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(bridge.agent.interrupt).toHaveBeenCalledWith("s1"));
    rerender(<Harness bridge={bridge} state="paused" />);
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(bridge.agent.resume).toHaveBeenCalledWith("s1"));
  });
});
