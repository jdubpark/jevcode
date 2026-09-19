import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  REPO,
  SESSION,
  TS,
  makeAgentEvent,
  makeChangeUnit,
  makeDecision,
  makeFact,
  makeJevLog,
} from "./fixtures.js";
import { openSessionDb } from "./test-utils.js";

describe("event store sequencing", () => {
  it("assigns monotonically increasing seq per session", () => {
    const db = openSessionDb();
    const e1 = db.appendAgentEvent(SESSION, makeAgentEvent());
    const e2 = db.appendEvidenceFact(SESSION, makeFact());
    const e3 = db.appendAgentEvent(SESSION, makeAgentEvent({ type: "agent_completed" }));
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e3.seq).toBe(3);
    expect(db.getLatestSeq(SESSION)).toBe(3);
    expect(db.getEventCount(SESSION)).toBe(3);
    db.close();
  });

  it("keeps seq independent per session", () => {
    const db = openSessionDb();
    const other = "sess_other";
    db.createSession({ id: other, repoId: REPO });
    db.appendAgentEvent(SESSION, makeAgentEvent());
    db.appendAgentEvent(SESSION, makeAgentEvent({ type: "agent_completed" }));
    const first = db.appendAgentEvent(other, makeAgentEvent({ sessionId: other }));
    expect(first.seq).toBe(1);
    expect(db.getLatestSeq(other)).toBe(1);
    db.close();
  });

  it("rejects unknown event types and sessionId mismatches", () => {
    const db = openSessionDb();
    expect(() => db.appendEvent(SESSION, "nonsense" as never, {})).toThrow(TypeError);
    expect(() =>
      db.appendEvent(SESSION, "change_unit", makeChangeUnit({ sessionId: "sess_wrong" })),
    ).toThrow(/does not match/);
    expect(() =>
      db.appendEvent(SESSION, "decision", makeDecision({ sessionId: "sess_wrong" })),
    ).toThrow(/does not match/);
    expect(db.getEventCount(SESSION)).toBe(0);
    db.close();
  });

  it("rejects events for sessions that do not exist", () => {
    const db = openSessionDb();
    expect(() =>
      db.appendAgentEvent("sess_missing", makeAgentEvent({ sessionId: "sess_missing" })),
    ).toThrow(/unknown sessionId/);
    db.close();
  });

  it("returns the newest N agent events in latest-first order", () => {
    const db = openSessionDb();
    for (let i = 0; i < 5; i += 1) {
      db.appendAgentEvent(
        SESSION,
        makeAgentEvent({ type: "tool_started", tool: "bash", input: String(i) }),
      );
    }
    const latest = db.latestAgentEvents(SESSION, 2);
    expect(latest.map((event) => ("input" in event ? event.input : undefined))).toEqual([
      "4",
      "3",
    ]);
    expect(db.listAgentEvents(SESSION).map((e) => ("input" in e ? e.input : ""))).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
    ]);
    db.close();
  });

  it("returns the newest N commands in latest-first order", () => {
    const db = openSessionDb();
    for (let i = 0; i < 4; i += 1) {
      db.recordCommand(SESSION, { command: `cmd ${i}`, isDestructive: false });
    }
    const latest = db.latestCommands(SESSION, 2);
    expect(latest.map((command) => command.command)).toEqual(["cmd 3", "cmd 2"]);
    db.close();
  });

  it("paginates listEvents by seq", () => {
    const db = openSessionDb();
    for (let i = 0; i < 5; i += 1) {
      db.appendAgentEvent(SESSION, makeAgentEvent({ type: "tool_started", tool: "bash", input: String(i) }));
    }
    const page1 = db.listEvents(SESSION, { limit: 2 });
    expect(page1.map((e) => e.seq)).toEqual([1, 2]);
    const page2 = db.listEvents(SESSION, { fromSeq: 2, limit: 2 });
    expect(page2.map((e) => e.seq)).toEqual([3, 4]);
    db.close();
  });
});

describe("projection routing", () => {
  it("stores agent events and derives command rows from command_completed", () => {
    const db = openSessionDb();
    db.appendAgentEvent(
      SESSION,
      makeAgentEvent({
        type: "command_completed",
        command: "npm test",
        exitCode: 1,
        stdout: "2 failed",
        stderr: "",
      }),
    );
    const events = db.listAgentEvents(SESSION);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("command_completed");
    const commands = db.listCommands(SESSION);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.command).toBe("npm test");
    expect(commands[0]?.exitCode).toBe(1);
    expect(commands[0]?.isDestructive).toBe(false);
    db.close();
  });

  it("flags destructive command_completed rows with isDestructive", () => {
    const db = openSessionDb();
    db.appendAgentEvent(
      SESSION,
      makeAgentEvent({
        type: "command_completed",
        command: "git reset --hard HEAD~1",
        exitCode: 0,
        stdout: "",
        stderr: "",
      }),
    );
    const commands = db.listCommands(SESSION);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.isDestructive).toBe(true);
    db.close();
  });

  it("stores evidence facts and derives validations and failures from test_result", () => {
    const db = openSessionDb();
    db.appendEvidenceFact(
      SESSION,
      makeFact({
        type: "test_result",
        runner: "vitest",
        command: "vitest run",
        passed: 3,
        failed: 2,
        skipped: 1,
        failures: [
          { file: "src/a.test.ts", testName: "adds numbers", message: "expected 2 got 3" },
          { file: "src/b.test.ts", testName: "multiplies", message: "expected 6 got 5" },
        ],
      }),
    );
    const validations = db.listValidations(SESSION);
    expect(validations).toHaveLength(1);
    expect(validations[0]).toMatchObject({
      kind: "test",
      status: "failed",
      passed: 3,
      failed: 2,
      skipped: 1,
    });
    expect(validations[0]?.id).toBe(`vitest|vitest run|${TS}`);
    const failures = db.listFailures(SESSION);
    expect(failures).toHaveLength(2);
    expect(failures[0]?.validationId).toBe(validations[0]?.id);
    expect(failures[0]?.file).toBe("src/a.test.ts");
    expect(failures[0]?.testName).toBe("adds numbers");
    db.close();
  });

  it("derives command rows from command_executed facts with the destructive flag", () => {
    const db = openSessionDb();
    db.appendEvidenceFact(
      SESSION,
      makeFact({
        type: "command_executed",
        command: "git reset --hard",
        exitCode: 0,
        isDestructive: true,
      }),
    );
    const commands = db.listCommands(SESSION);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.isDestructive).toBe(true);
    expect(commands[0]?.command).toBe("git reset --hard");
    db.close();
  });

  it("records explicit command events", () => {
    const db = openSessionDb();
    db.recordCommand(SESSION, { command: "pnpm build", isDestructive: false });
    const commands = db.listCommands(SESSION);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.command).toBe("pnpm build");
    db.close();
  });

  it("round-trips a jev decision with probabilities and clamps", () => {
    const db = openSessionDb();
    db.upsertJevDecision(makeJevLog());
    const logs = db.listJevDecisions(SESSION);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual(makeJevLog());
    expect(db.latestJevDecisions(SESSION, 1)[0]?.clamps).toEqual(["guardrail.security"]);
    db.close();
  });

  it("round-trips ui intents and snapshots", () => {
    const db = openSessionDb();
    const intent = {
      attention: "surface" as const,
      subject: "behavior" as const,
      representation: "summary" as const,
      density: "normal" as const,
      confidence: 0.85,
      showEvidence: true,
      showCode: false,
      secondaryViews: [],
      renderMode: "autonomous" as const,
    };
    db.upsertUiIntent(SESSION, { changeUnitId: "cu_1", intent });
    db.upsertUiSnapshot(SESSION, {
      surfaceId: "changeunit:cu_1",
      changeUnitId: "cu_1",
      semanticEventId: "se_1",
      intent,
      spec: { root: "r1", elements: { r1: { type: "ChangeOverview", props: {} } } },
    });
    const intents = db.listUiIntents(SESSION);
    expect(intents).toHaveLength(1);
    expect(intents[0]?.changeUnitId).toBe("cu_1");
    expect(intents[0]?.intent.renderMode).toBe("autonomous");
    const snapshots = db.listUiSnapshots(SESSION);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.surfaceId).toBe("changeunit:cu_1");
    expect(snapshots[0]?.semanticEventId).toBe("se_1");
    expect(snapshots[0]?.spec.root).toBe("r1");
    db.close();
  });

  it("round-trips graph nodes and edges", () => {
    const db = openSessionDb();
    db.upsertGraphNode(SESSION, {
      id: "node_task",
      nodeType: "Task",
      payload: { title: "add rate limiting" },
    });
    db.upsertGraphNode(SESSION, {
      id: "node_cu",
      nodeType: "ChangeUnit",
      payload: { unitId: "cu_1" },
    });
    db.upsertGraphEdge(SESSION, {
      id: "edge_1",
      fromId: "node_task",
      toId: "node_cu",
      edgeType: "contains",
    });
    expect(db.listGraphNodes(SESSION)).toHaveLength(2);
    const edges = db.listGraphEdges(SESSION);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.fromId).toBe("node_task");
    expect(edges[0]?.edgeType).toBe("contains");
    db.close();
  });

  it("upserts explicit validations and failures", () => {
    const db = openSessionDb();
    db.upsertValidation(SESSION, {
      id: "val_typecheck",
      kind: "typecheck",
      command: "tsc --noEmit",
      status: "failed",
      passed: 0,
      failed: 1,
      skipped: 0,
      ts: TS,
    });
    db.upsertFailure(SESSION, {
      validationId: "val_typecheck",
      file: "src/x.ts",
      testName: "ts(2322)",
      message: "type mismatch",
    });
    expect(db.listValidations(SESSION)).toHaveLength(1);
    const failures = db.listFailures(SESSION);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.validationId).toBe("val_typecheck");
    db.close();
  });

  it("rejects invalid payloads at append time", () => {
    const db = openSessionDb();
    expect(() =>
      db.appendAgentEvent(SESSION, { type: "agent_message", sessionId: SESSION } as never),
    ).toThrow(TypeError);
    expect(() =>
      db.appendEvidenceFact(SESSION, { type: "git_hunk", repoId: REPO, sessionId: SESSION } as never),
    ).toThrow(TypeError);
    db.close();
  });
});

describe("per-table upserts", () => {
  it("replace-on-upsert for change units keeps a single row and replaces children", () => {
    const db = openSessionDb();
    db.upsertChangeUnit(makeChangeUnit());
    db.upsertChangeUnit(
      makeChangeUnit({
        title: "updated title",
        files: ["src/a.ts", "src/b.ts"],
        symbols: [
          { id: "sym_1", name: "f", path: "src/a.ts", kind: "function" },
          { id: "sym_2", name: "g", path: "src/b.ts", kind: "class" },
        ],
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
    );
    const units = db.listChangeUnits(SESSION);
    expect(units).toHaveLength(1);
    expect(units[0]?.title).toBe("updated title");
    expect(units[0]?.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(units[0]?.symbols).toHaveLength(2);
    expect(db.getChangeUnit("cu_1")?.title).toBe("updated title");
    expect(db.getEventCount(SESSION)).toBe(2);
    db.close();
  });

  it("replace-on-upsert for decisions keeps a single row and replaces options", () => {
    const db = openSessionDb();
    db.upsertDecision(makeDecision());
    db.upsertDecision(
      makeDecision({
        status: "answered",
        answer: {
          decisionId: "dec_1",
          decision: { rate_limit: "opt_a" },
          evidence: ["fact_1"],
          instruction: "fail open",
        },
        options: [
          { id: "opt_a", label: "Fail open", description: "serve anyway" },
          { id: "opt_b", label: "Fail closed", description: "reject" },
          { id: "opt_c", label: "Ask later", description: "defer" },
        ],
      }),
    );
    const decisions = db.listDecisions(SESSION);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.status).toBe("answered");
    expect(decisions[0]?.options).toHaveLength(3);
    expect(decisions[0]?.answer?.decision.rate_limit).toBe("opt_a");
    expect(db.getDecision("dec_1")?.options).toHaveLength(3);
    db.close();
  });

  it("supports latest-N queries per projection table", () => {
    const db = openSessionDb();
    for (let i = 0; i < 3; i += 1) {
      db.upsertChangeUnit(
        makeChangeUnit({ id: `cu_${i}`, title: `unit ${i}` }),
      );
    }
    expect(db.latestChangeUnits(SESSION, 2).map((u) => u.title)).toEqual(["unit 2", "unit 1"]);
    db.close();
  });

  it("throws on corrupt projection payloads during read", () => {
    const db = openSessionDb();
    db.appendAgentEvent(SESSION, makeAgentEvent());
    const raw = new Database(db.dbPath);
    raw
      .prepare("UPDATE agent_events SET payloadJson = ? WHERE sessionId = ?")
      .run("{not json", SESSION);
    raw.close();
    expect(() => db.listAgentEvents(SESSION)).toThrow(/invalid JSON/);
    db.close();
  });
});
