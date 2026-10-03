import { describe, expect, it, vi } from "vitest";

import type { JevcodeApi } from "../../shared/api.js";
import { DECISION_ANSWER_KEY, createMainHost } from "./main-host.js";

function deps(repoRoot: string | null = "/work/api") {
  const bridge = {
    action: { invoke: vi.fn(async () => undefined) },
    trace: { open: vi.fn(async () => undefined), requestChanges: vi.fn(async () => undefined) },
    overview: { rescan: vi.fn(async () => undefined) },
  };
  const prefill = vi.fn();
  const lines: string[] = [];
  const host = createMainHost({
    bridge: bridge as unknown as Pick<JevcodeApi, "action" | "trace" | "overview">,
    sessionId: "s1",
    repoRoot: () => repoRoot,
    prefill,
    log: (line) => lines.push(line),
  });
  return { bridge, prefill, lines, host };
}

describe("createMainHost (spec §9)", () => {
  it("hands a review note to the local composer and never over IPC", async () => {
    const { bridge, prefill, host } = deps();
    await host.requestChanges?.({ sessionId: "s1", selected: "step:3", text: "Re: step 3" });
    await host.requestChanges?.({ sessionId: "s2", selected: "step:3", text: "for another session" });
    expect(prefill).toHaveBeenCalledTimes(1);
    expect(prefill).toHaveBeenCalledWith("Re: step 3");
    expect(bridge.trace.requestChanges).not.toHaveBeenCalled();
  });

  it("answers a decision through the allowlisted action dispatch", async () => {
    const { bridge, host } = deps();
    await host.answerDecision?.({ decisionId: "dec_1", optionId: "fail_open" });
    expect(DECISION_ANSWER_KEY).toBe("decision");
    expect(bridge.action.invoke).toHaveBeenCalledWith("answer_decision", {
      decisionId: "dec_1",
      decision: { decision: "fail_open" },
    });
  });

  it("opens the trace window for its own session", () => {
    const { bridge, host } = deps();
    host.openTraceWindow?.();
    expect(bridge.trace.open).toHaveBeenCalledWith("s1");
  });

  it("asks main to rescan only the open repo", () => {
    const open = deps("/work/api");
    open.host.rescanOverview?.();
    expect(open.bridge.overview.rescan).toHaveBeenCalledWith("/work/api");
    const closed = deps(null);
    closed.host.rescanOverview?.();
    expect(closed.bridge.overview.rescan).not.toHaveBeenCalled();
  });

  it("logs WORKSPACE_READY once for the smoke", () => {
    const { lines, host } = deps();
    host.onReady?.({ rows: 4, loadedThroughSeq: 4 });
    host.onReady?.({ rows: 9, loadedThroughSeq: 9 });
    expect(lines).toEqual(["WORKSPACE_READY 4"]);
  });
});

describe("createMainHost smoke locations", () => {
  it("logs WORKSPACE_LOCATION only when asked", () => {
    const lines: string[] = [];
    const base = {
      bridge: {} as Pick<JevcodeApi, "action" | "trace" | "overview">,
      sessionId: "s1",
      repoRoot: () => null,
      prefill: () => undefined,
      log: (line: string) => lines.push(line),
    };
    const location = { v: 1, sessionId: "s1", view: "map", level: "chapter", selected: "step:3", brush: { kind: "session" } };
    createMainHost(base).onLocation?.(location as never);
    expect(lines).toEqual([]);
    createMainHost({ ...base, logLocations: true }).onLocation?.(location as never);
    expect(lines).toEqual(['WORKSPACE_LOCATION {"view":"map","selected":"step:3"}']);
  });
});
