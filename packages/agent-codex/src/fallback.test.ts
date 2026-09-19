import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { NormalizedAgentEventSchema } from "@jevcode/contracts";
import { defaultNormalizerContext } from "@jevcode/agent-core";

import { initialTranscriptState, parseTranscriptLine } from "./fallback.js";
import { detectAuthFailure } from "./auth.js";

function parseTranscriptFixture(sessionId = "s1") {
  const ctx = defaultNormalizerContext(sessionId);
  const lines = readFileSync(
    fileURLToPath(new URL("../test/fixtures/transcript-fallback.txt", import.meta.url)),
    "utf8",
  ).split("\n");
  let state = initialTranscriptState();
  const events = [];
  for (const line of lines) {
    const result = parseTranscriptLine(line, ctx, state);
    state = result.state;
    events.push(...result.events);
  }
  for (const event of events) NormalizedAgentEventSchema.parse(event);
  return events;
}

describe("transcript fallback normalizer", () => {
  it("maps command markers, exit codes, approvals, and narration", () => {
    const events = parseTranscriptFixture();
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "command_started",
      "agent_message",
      "agent_message",
      "command_completed",
      "agent_message",
      "command_started",
      "approval_requested",
      "command_completed",
    ]);

    const completed = events.filter((e) => e.type === "command_completed");
    expect(completed[0]).toMatchObject({ command: "pnpm test", exitCode: 0 });
    expect(completed[1]).toMatchObject({ command: "rm -rf node_modules", exitCode: 1 });

    const approval = events.find((e) => e.type === "approval_requested");
    expect(approval).toMatchObject({
      command: "rm -rf node_modules",
      rationale: "⏸ Approval needed: allow this command to proceed?",
    });
  });

  it("tracks the last seen command for completions and approvals", () => {
    const ctx = defaultNormalizerContext("s2");
    let state = initialTranscriptState();
    let result = parseTranscriptLine("❯ npm run build", ctx, state);
    state = result.state;
    expect(result.events[0]).toMatchObject({ type: "command_started", command: "npm run build" });
    result = parseTranscriptLine("exit code: 0", ctx, state);
    expect(result.events[0]).toMatchObject({
      type: "command_completed",
      command: "npm run build",
      exitCode: 0,
    });
  });

  it("drops empty lines", () => {
    const ctx = defaultNormalizerContext("s3");
    const result = parseTranscriptLine("   ", ctx, initialTranscriptState());
    expect(result.events).toEqual([]);
  });
});

describe("auth failure detection", () => {
  it("detects not-signed-in output", () => {
    expect(detectAuthFailure("Error: you are not signed in. Run `codex login`.")?.kind).toBe(
      "not_signed_in",
    );
  });

  it("detects 401 unauthorized output", () => {
    expect(
      detectAuthFailure(
        "Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header)",
      )?.kind,
    ).toBe("unauthorized");
  });

  it("detects out-of-credits output", () => {
    expect(
      detectAuthFailure("Your workspace is out of credits. Ask your workspace owner to refill.")?.kind,
    ).toBe("out_of_credits");
  });

  it("does not misclassify unrelated MCP OAuth noise", () => {
    expect(
      detectAuthFailure(
        "ERROR codex_rmcp_client::oauth::refresh_transaction: OAuth refresh token was rejected: invalid_grant",
      ),
    ).toBeNull();
  });

  it("does not misclassify ordinary output", () => {
    expect(detectAuthFailure("pnpm test passed")).toBeNull();
  });
});
