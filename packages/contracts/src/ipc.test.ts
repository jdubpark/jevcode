import { describe, expect, it } from "vitest";

import {
  MainToRendererChannels,
  RendererToMainChannels,
  allChannelNames,
  mainToRendererPayloads,
  rendererToMainPayloads,
  validatePayload,
} from "./ipc.js";

describe("IPC channel map", () => {
  it("covers every SPEC section 4.5 renderer-to-main channel", () => {
    const expected = [
      "repo:open",
      "repo:close",
      "session:start",
      "session:stop",
      "agent:interrupt",
      "agent:resume",
      "agent:sendInstruction",
      "agent:cancelInstruction",
      "action:invoke",
      "terminal:input",
      "terminal:resize",
      "surface:pin",
      "surface:dismiss",
      "telemetry:flush",
    ];
    expect(Object.values(RendererToMainChannels)).toEqual(expected);
    for (const channel of expected) {
      expect(rendererToMainPayloads[channel as keyof typeof rendererToMainPayloads]).toBeDefined();
    }
  });

  it("covers every SPEC section 4.5 main-to-renderer channel", () => {
    const expected = [
      "repo:opened",
      "session:state",
      "agent:event",
      "agent:state",
      "agent:instructionState",
      "semantic:update",
      "changeunit:upsert",
      "decision:open",
      "decision:resolved",
      "validation:update",
      "ui:spec",
      "ui:specPatch",
      "terminal:data",
      "terminal:scrollback",
      "jev:debug",
      "telemetry:ack",
    ];
    expect(Object.values(MainToRendererChannels)).toEqual(expected);
    for (const channel of expected) {
      expect(mainToRendererPayloads[channel as keyof typeof mainToRendererPayloads]).toBeDefined();
    }
  });

  it("rejects unknown channels in both directions", () => {
    expect(validatePayload("toMain", "repo:teleport", {}).ok).toBe(false);
    expect(validatePayload("fromMain", "unknown:channel", {}).ok).toBe(false);
  });
});

describe("validatePayload", () => {
  it("round-trips repo:open / repo:opened", () => {
    const open = validatePayload("toMain", "repo:open", { path: "/srv/repo/jev" });
    expect(open.ok).toBe(true);

    const opened = validatePayload("fromMain", "repo:opened", {
      repoId: "repo_1",
      path: "/srv/repo/jev",
      gitRoot: "/srv/repo/jev",
      branch: "main",
      baseCommit: "abc123",
    });
    expect(opened.ok).toBe(true);
  });

  it("round-trips an agent event over agent:event", () => {
    const result = validatePayload("fromMain", "agent:event", {
      type: "approval_requested",
      sessionId: "sess_1",
      command: "rm -rf build",
      rationale: "clean",
      ts: "2026-01-15T10:30:00.000Z",
    });
    expect(result.ok).toBe(true);
  });

  it("round-trips a json-render spec over ui:spec", () => {
    const result = validatePayload("fromMain", "ui:spec", {
      sessionId: "sess_1",
      surfaceId: "changeunit:cu_1",
      spec: {
        root: "changeoverview_1",
        elements: {
          changeoverview_1: {
            type: "ChangeOverview",
            props: { title: "Add rate limiting", confidence: 0.9 },
            children: [],
          },
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("round-trips action:invoke", () => {
    const result = validatePayload("toMain", "action:invoke", {
      action: "answer_decision",
      params: { decisionId: "dec_1", decision: { policy: "fail_open" } },
      surfaceId: "decision:dec_1",
    });
    expect(result.ok).toBe(true);
  });

  it("round-trips catalog actions with their discriminated params", () => {
    expect(
      validatePayload("toMain", "action:invoke", {
        action: "continue_task",
        params: {},
      }).ok,
    ).toBe(true);
    expect(
      validatePayload("toMain", "action:invoke", {
        action: "pin_surface",
        params: { surfaceId: "changeunit:cu_1" },
      }).ok,
    ).toBe(true);
    expect(
      validatePayload("toMain", "action:invoke", {
        action: "show_exact_diff",
        params: { files: ["src/app.ts"] },
        surfaceId: "changeunit:cu_1",
      }).ok,
    ).toBe(true);
  });

  it("rejects unknown actions and params that fail the action schema", () => {
    const unknownAction = validatePayload("toMain", "action:invoke", {
      action: "sudo_rm_rf",
      params: {},
    });
    expect(unknownAction.ok).toBe(false);

    const invalidParams = validatePayload("toMain", "action:invoke", {
      action: "answer_decision",
      params: { decisionId: "dec_1" },
    });
    expect(invalidParams.ok).toBe(false);

    const wrongParamsShape = validatePayload("toMain", "action:invoke", {
      action: "show_exact_diff",
      params: { files: [] },
    });
    expect(wrongParamsShape.ok).toBe(false);
  });

  it("round-trips terminal and surface control payloads", () => {
    expect(validatePayload("toMain", "terminal:input", { sessionId: "sess_1", data: "ls\n" }).ok).toBe(true);
    expect(validatePayload("toMain", "terminal:resize", { sessionId: "sess_1", cols: 120, rows: 40 }).ok).toBe(true);
    expect(validatePayload("toMain", "surface:pin", { surfaceId: "changeunit:cu_1", pinned: true }).ok).toBe(true);
    expect(validatePayload("toMain", "surface:dismiss", { surfaceId: "changeunit:cu_1" }).ok).toBe(true);
    expect(validatePayload("toMain", "agent:sendInstruction", { id: "ins_1", sessionId: "sess_1", text: "continue" }).ok).toBe(true);
    expect(validatePayload("toMain", "agent:cancelInstruction", { sessionId: "sess_1", instructionId: "ins_1" }).ok).toBe(true);
    expect(validatePayload("toMain", "agent:interrupt", { sessionId: "sess_1" }).ok).toBe(true);
    expect(validatePayload("toMain", "telemetry:flush", {}).ok).toBe(true);
  });

  it("rejects schema-invalid payloads", () => {
    const missing = validatePayload("toMain", "repo:open", {});
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.length).toBeGreaterThan(0);
    }

    const wrongShape = validatePayload("toMain", "terminal:resize", {
      sessionId: "sess_1",
      cols: 0,
      rows: "wide",
    });
    expect(wrongShape.ok).toBe(false);

    const badAction = validatePayload("toMain", "action:invoke", {
      action: "",
      params: {},
    });
    expect(badAction.ok).toBe(false);
  });
});

describe("allChannelNames", () => {
  it("returns 30 unique channel names", () => {
    const names = allChannelNames();
    expect(new Set(names).size).toBe(30);
    expect(names.length).toBe(30);
  });
});
