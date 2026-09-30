import { describe, expect, it } from "vitest";

import { loadFixtureTrace } from "../test-support/fixture-rows.js";
import { TraceBuilder, testMeta } from "../test-support/trace-builder.js";
import { foldRows } from "./fold.js";
import { buildSearchIndex, searchSteps } from "./search.js";

describe("search", () => {
  it("finds oauth's test step by its command", () => {
    const trace = loadFixtureTrace("oauth");
    const session = foldRows(trace.meta, trace.rows, { live: false });
    const testStep = session.steps.find((step) => step.kind === "test");
    const decision = session.steps.find((step) => step.kind === "decision");
    const hits = searchSteps(buildSearchIndex(session), "pnpm test");
    // A1-9 adds an oauth agent_reasoning line that quotes "pnpm test", so pin the test step's
    // rank and one non-match instead of an exact list (index §4, fixture drift).
    expect(testStep).toBeDefined();
    expect(hits[0]).toBe(testStep?.id);
    expect(hits).not.toContain(decision?.id);
  });

  it("requires every term, ignores case and returns ids in step order", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Fix the Login flow" });
    b.agent({ type: "agent_message", role: "assistant", text: "Looking at login.ts" });
    b.agent({ type: "file_changed", path: "src/auth/login.ts" });
    const session = foldRows(testMeta(), b.rows, { live: false });
    const index = buildSearchIndex(session);
    expect(searchSteps(index, "LOGIN")).toEqual(["step:1", "step:2", "step:3"]);
    expect(searchSteps(index, "login auth")).toEqual(["step:3"]);
    expect(searchSteps(index, "   ")).toEqual([]);
  });

  it("matches test failure names and never stdout", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "command_started", command: "pnpm test" });
    b.agent({ type: "command_completed", command: "pnpm test", exitCode: 1, stdout: "SECRET_STDOUT_MARKER", stderr: "" });
    b.fact({
      type: "test_result",
      runner: "vitest",
      command: "pnpm test",
      passed: 0,
      failed: 1,
      skipped: 0,
      failures: [{ file: "a.test.ts", testName: "links a Google identity", message: "x" }],
    });
    const index = buildSearchIndex(foldRows(testMeta(), b.rows, { live: false }));
    expect(searchSteps(index, "google identity")).toEqual(["step:2"]);
    expect(searchSteps(index, "secret_stdout_marker")).toEqual([]);
  });

  it("indexes only the first 8 KiB of message text", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "agent_message", role: "assistant", text: `${"a".repeat(9 * 1024)} needle` });
    const index = buildSearchIndex(foldRows(testMeta(), b.rows, { live: false }));
    expect(searchSteps(index, "needle")).toEqual([]);
  });
});
