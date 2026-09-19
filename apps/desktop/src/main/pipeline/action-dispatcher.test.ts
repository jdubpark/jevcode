import { openDb } from "@jevcode/storage";
import { afterAll, describe, expect, it } from "vitest";
import type { JevcodeDb } from "@jevcode/storage";

import { IpcError } from "../../shared/errors.js";
import { dispatchAction } from "./action-dispatcher.js";
import type { ActionDispatcherDeps } from "./action-dispatcher.js";
import type { PipelineRuntime } from "./pipeline-runtime.js";

interface StubCall {
  method: string;
  args: unknown[];
}

function stubRuntime(): { runtime: PipelineRuntime; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const target: Record<string, unknown> = {};
  const proxy = new Proxy(target, {
    get: (_target, prop: string) => {
      return (...args: unknown[]) => {
        calls.push({ method: prop, args });
        return Promise.resolve();
      };
    },
  });
  return { runtime: proxy as unknown as PipelineRuntime, calls };
}

function makeDeps(
  db: JevcodeDb,
  runtime: PipelineRuntime,
  sessionId: string | null = "sess-active",
): ActionDispatcherDeps {
  return {
    runtime,
    db,
    terminals: { ensure: () => {}, data: () => {} },
    activeSessionId: () => sessionId,
    repoPath: () => "/tmp/repo",
    log: () => {},
  };
}

const db = openDb({ dbPath: "/tmp/jevcode-actions-test.db" });
afterAll(() => {
  db.close();
});

describe("ActionDispatcher allowlist and validation", () => {
  it("rejects unknown actions", async () => {
    const { runtime } = stubRuntime();
    await expect(
      dispatchAction(makeDeps(db, runtime), "sudo_rm_rf", {}),
    ).rejects.toMatchObject({ code: "UNKNOWN_ACTION" } satisfies Partial<IpcError>);
  });

  it("rejects schema-invalid params", async () => {
    const { runtime } = stubRuntime();
    await expect(
      dispatchAction(makeDeps(db, runtime), "answer_decision", {}),
    ).rejects.toMatchObject({ code: "INVALID_ACTION_PARAMS" } satisfies Partial<IpcError>);
    await expect(
      dispatchAction(makeDeps(db, runtime), "show_exact_diff", { files: [] }),
    ).rejects.toMatchObject({ code: "INVALID_ACTION_PARAMS" } satisfies Partial<IpcError>);
  });

  it("rejects all actions when no session is active", async () => {
    const { runtime } = stubRuntime();
    await expect(
      dispatchAction(makeDeps(db, runtime, null), "continue_task", {}),
    ).rejects.toMatchObject({ code: "NO_ACTIVE_SESSION" } satisfies Partial<IpcError>);
  });

  it("routes answer_decision to the runtime with parsed params", async () => {
    const { runtime, calls } = stubRuntime();
    const decisionId = "dec-1";
    await dispatchAction(makeDeps(db, runtime), "answer_decision", {
      decisionId,
      decision: { policy: "fail_open" },
      evidence: ["ev-1"],
    });
    expect(calls.some((call) => call.method === "answerDecision")).toBe(true);
    const answer = calls.find((call) => call.method === "answerDecision");
    expect(answer?.args[0]).toBe("sess-active");
    expect(answer?.args[1]).toMatchObject({ decisionId, decision: { policy: "fail_open" } });
  });

  it("routes agent-touching actions to the adapter-facing runtime methods", async () => {
    const { runtime, calls } = stubRuntime();
    await dispatchAction(makeDeps(db, runtime), "interrupt_agent", {});
    await dispatchAction(makeDeps(db, runtime), "continue_task", {});
    await dispatchAction(makeDeps(db, runtime), "restore_previous_api_semantics", {
      symbol: "rateLimiter",
    });
    await dispatchAction(makeDeps(db, runtime), "request_changes", {
      instruction: "narrow the blast radius",
    });
    await dispatchAction(makeDeps(db, runtime), "delegate_decision", {
      decisionId: "dec-2",
    });
    expect(calls.some((call) => call.method === "interrupt")).toBe(true);
    expect(calls.some((call) => call.method === "resume")).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.method === "restorePreviousApiSemantics" &&
          call.args[1] === "rateLimiter",
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.method === "requestChanges" &&
          call.args[1] === "narrow the blast radius",
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.method === "delegateDecision" &&
          (call.args[1] as { decisionId: string }).decisionId === "dec-2",
      ),
    ).toBe(true);
  });

  it("routes surface actions to the runtime without telemetry duplication", async () => {
    const { runtime, calls } = stubRuntime();
    await dispatchAction(makeDeps(db, runtime), "pin_surface", {
      surfaceId: "changeunit:cu-1",
    });
    await dispatchAction(makeDeps(db, runtime), "dismiss_surface", {
      surfaceId: "changeunit:cu-1",
    });
    expect(calls.some((call) => call.method === "pinSurface")).toBe(true);
    expect(calls.some((call) => call.method === "dismissSurface")).toBe(true);
  });
});
