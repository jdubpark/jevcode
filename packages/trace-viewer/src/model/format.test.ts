import { describe, expect, it } from "vitest";

import type { AgentState, NormalizedAgentEvent } from "@jevcode/contracts";

import {
  agentEventLabel,
  agentStateLabel,
  displayUntrusted,
  exitLabel,
  formatClock,
  formatDuration,
  formatOffset,
  normalizeCommand,
  stepHeadline,
  toolLabel,
  truncateMiddle,
} from "./format.js";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemeCount = (text: string): number => Array.from(segmenter.segment(text)).length;

describe("truncateMiddle", () => {
  it("returns text that fits unchanged", () => {
    expect(truncateMiddle("src/a.ts", 48)).toBe("src/a.ts");
    expect(truncateMiddle("", 5)).toBe("");
  });

  it("keeps the whole basename of a long path", () => {
    const result = truncateMiddle("packages/trace-viewer/src/model/format.ts", 24);
    expect(result).toBe("packages/trac…/format.ts");
    expect(graphemeCount(result)).toBe(24);
  });

  it("cuts the middle when the basename does not fit", () => {
    expect(truncateMiddle("abcdefghijklmnopqrstuvwxyz", 7)).toBe("abc…xyz");
    expect(truncateMiddle("abcdefghij", 6)).toBe("abc…ij");
    expect(truncateMiddle("dir/abcdefghijklmnop.ts", 8)).toBe("dir/….ts");
  });

  it("never splits an emoji ZWJ sequence", () => {
    const text = "👩‍👩‍👧 family.ts";
    expect(truncateMiddle(text, 4)).toBe("👩‍👩‍👧 …s");
    expect(truncateMiddle(text, 6)).toBe("👩‍👩‍👧 f…ts");
  });

  it("counts precomposed and decomposed Hangul as one grapheme per syllable", () => {
    expect(truncateMiddle("한국어/경로/파일이름.ts", 10)).toBe("한…/파일이름.ts");
    const decomposed = "한".repeat(6);
    const result = truncateMiddle(decomposed, 5);
    expect(result).toBe(`${"한".repeat(2)}…${"한".repeat(2)}`);
    expect(graphemeCount(result)).toBe(5);
  });

  it("returns an ellipsis or nothing for tiny budgets", () => {
    expect(truncateMiddle("abcdef", 1)).toBe("…");
    expect(truncateMiddle("abcdef", 0)).toBe("");
  });

  it("shows a bidi override as a visible token before it cuts", () => {
    expect(truncateMiddle("src/‮gnp.ts", 48)).toBe("src/⟨U+202E⟩gnp.ts");
  });
});

describe("displayUntrusted", () => {
  it("shows bidi overrides and control characters as visible tokens", () => {
    expect(displayUntrusted("rm ‮fdp.exe")).toBe("rm ⟨U+202E⟩fdp.exe");
    expect(displayUntrusted("a⁦b⁩c‏d‎e‪f")).toBe("a⟨U+2066⟩b⟨U+2069⟩c⟨U+200F⟩d⟨U+200E⟩e⟨U+202A⟩f");
    expect(displayUntrusted("bell\u0007\r")).toBe("bell⟨U+0007⟩⟨U+000D⟩");
  });

  it("keeps tabs, keeps line breaks only in multi-line slots and returns clean text unchanged", () => {
    expect(displayUntrusted("a\tb\nc")).toBe("a\tb⟨U+000A⟩c");
    expect(displayUntrusted("a\tb\nc", { multiline: true })).toBe("a\tb\nc");
    const clean = "👩‍👩‍👧 한국어/경로/파일.ts";
    expect(displayUntrusted(clean)).toBe(clean);
  });
});

describe("exitLabel", () => {
  it.each([
    [0, "exit 0"],
    [1, "exit 1"],
    [-1, "exit unknown"],
    [null, ""],
  ])("labels %s as %j", (exitCode, expected) => {
    expect(exitLabel(exitCode)).toBe(expected);
  });
});

describe("formatOffset", () => {
  it.each([
    [0, "+0:00"],
    [39_000, "+0:39"],
    [725_000, "+12:05"],
    [3_723_000, "+1:02:03"],
    [-5_000, "+0:00"],
    [Number.NaN, "+0:00"],
  ])("formats %d ms as %s", (ms, expected) => {
    expect(formatOffset(ms)).toBe(expected);
  });
});

describe("formatDuration", () => {
  it.each([
    [null, ""],
    [850, "850 ms"],
    [4_500, "4.5 s"],
    [5_000, "5.0 s"],
    [45_000, "45 s"],
    [125_000, "2 m 05 s"],
    [3_720_000, "1 h 02 m"],
    [-10, "0 ms"],
  ])("formats %s as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe("formatClock", () => {
  it("returns an empty string for an invalid timestamp", () => {
    expect(formatClock("not a date")).toBe("");
  });

  it("shows seconds only when asked", () => {
    const ts = "2026-09-18T09:00:39.000Z";
    expect(formatClock(ts, { seconds: true })).toContain("39");
    expect(formatClock(ts)).not.toContain(":39");
    expect(formatClock(ts)).not.toBe("");
  });
});

describe("agentStateLabel", () => {
  it("keeps the workspace status strings", () => {
    const states: AgentState[] = ["starting", "running", "waiting_decision", "paused", "completed", "failed"];
    expect(states.map(agentStateLabel)).toEqual([
      "Starting",
      "Working",
      "Needs your decision",
      "Paused",
      "Completed",
      "Stopped with an error",
    ]);
  });
});

describe("agentEventLabel", () => {
  const base = { sessionId: "s1", ts: "2026-09-18T09:00:00.000Z" };

  it("labels every event type", () => {
    const cases: [NormalizedAgentEvent, string][] = [
      [{ ...base, type: "agent_started", prompt: "p" }, "Started working on the task"],
      [{ ...base, type: "agent_message", role: "user", text: "do it" }, "Direction received"],
      [{ ...base, type: "agent_message", role: "assistant", text: "Done." }, "Done."],
      [{ ...base, type: "agent_reasoning", text: "hmm" }, "Thinking"],
      [{ ...base, type: "tool_started", tool: "mcp.github.search_issues", input: "" }, "Using Search Issues"],
      [{ ...base, type: "tool_completed", tool: "read_file", output: "" }, "Finished Read File"],
      [{ ...base, type: "command_started", command: "pnpm test" }, "Running pnpm test"],
      [
        { ...base, type: "command_completed", command: "pnpm test", exitCode: 1, stdout: "", stderr: "" },
        "pnpm test finished with exit 1",
      ],
      [
        { ...base, type: "command_completed", command: "pnpm test", exitCode: -1, stdout: "", stderr: "" },
        "pnpm test finished (exit code unknown)",
      ],
      [{ ...base, type: "file_read", path: "src/a.ts" }, "Reading src/a.ts"],
      [{ ...base, type: "file_changed", path: "src/a.ts" }, "Changed src/a.ts"],
      [{ ...base, type: "approval_requested", command: "rm -rf dist", rationale: "" }, "Approval needed for rm -rf dist"],
      [{ ...base, type: "test_started", command: "pnpm test" }, "Checking with pnpm test"],
      [{ ...base, type: "test_completed", command: "pnpm test", exitCode: 0 }, "pnpm test passed"],
      [{ ...base, type: "test_completed", command: "pnpm test", exitCode: 1 }, "pnpm test failed"],
      [{ ...base, type: "test_completed", command: "pnpm test", exitCode: -1 }, "pnpm test finished"],
      [{ ...base, type: "agent_waiting" }, "Waiting for direction"],
      [{ ...base, type: "agent_completed" }, "Turn ended"],
      [{ ...base, type: "agent_failed", error: "boom" }, "Stopped: boom"],
      [{ ...base, type: "agent_interrupted", reason: "interrupt" }, "Paused"],
      [{ ...base, type: "agent_interrupted", reason: "steer" }, "Redirected"],
      [{ ...base, type: "agent_interrupted", reason: "stop" }, "Stopped"],
    ];
    for (const [event, label] of cases) expect(agentEventLabel(event)).toBe(label);
  });

  it("truncates long paths grapheme-safely instead of dropping leading segments", () => {
    const path = "packages/trace-viewer/src/model/some/deeply/nested/folder/file-name.ts";
    const label = agentEventLabel({ ...base, type: "file_changed", path });
    expect(label).toBe(`Changed ${truncateMiddle(path, 48)}`);
    expect(label.endsWith("/file-name.ts")).toBe(true);
    expect(graphemeCount(label.slice("Changed ".length))).toBe(48);
  });
});

describe("normalizeCommand", () => {
  it.each([
    ["  pnpm   test\n --run ", "pnpm test --run"],
    ["bash -lc 'pnpm  test'", "pnpm test"],
    ["/bin/zsh -lc 'pnpm test'", "pnpm test"],
    ['bash -lc "pnpm  lint && pnpm test"', "pnpm lint && pnpm test"],
    ["/usr/bin/bash -c 'make'", "make"],
    ["zsh -lc 'unterminated", "zsh -lc 'unterminated"],
  ])("%j -> %j", (command, expected) => {
    expect(normalizeCommand(command)).toBe(expected);
  });
});

describe("toolLabel", () => {
  it("keeps the last dotted segment in title case", () => {
    expect(toolLabel("mcp.github.search_issues")).toBe("Search Issues");
    expect(toolLabel("shell")).toBe("Shell");
  });
});

describe("stepHeadline", () => {
  it("summarises a test run as the command and passed/total", () => {
    expect(stepHeadline({ kind: "test", target: "pnpm test", tests: { passed: 14, failed: 1, skipped: 0 } })).toBe(
      "pnpm test · 14/15",
    );
    expect(stepHeadline({ kind: "test", target: "pnpm test", tests: { passed: 42, failed: 0, skipped: 0 } })).toBe(
      "pnpm test · 42/42",
    );
    expect(stepHeadline({ kind: "test", tests: { passed: 0, failed: 0, skipped: 0 } })).toBe("Tests · no tests ran");
  });

  it("shows the unwrapped command and marks commands that have not finished", () => {
    expect(stepHeadline({ kind: "command", target: "pnpm install", exitCode: null })).toBe("Running pnpm install");
    expect(stepHeadline({ kind: "command", target: "/bin/zsh -lc 'pnpm   install'", exitCode: 0 })).toBe("pnpm install");
    expect(stepHeadline({ kind: "check", target: "pnpm typecheck", exitCode: -1 })).toBe("pnpm typecheck");
  });

  it("uses the first non-empty line of message text and cuts it at 80 graphemes", () => {
    expect(stepHeadline({ kind: "message", text: "\nPlan: do X.\nThen Y." })).toBe("Plan: do X.");
    const long = "a".repeat(100);
    const headline = stepHeadline({ kind: "instruction", text: long });
    expect(graphemeCount(headline)).toBe(80);
    expect(headline.endsWith("…")).toBe(true);
  });

  it("uses the instruction line of a structured decision answer", () => {
    const text =
      "decision:\n  redis_failure_policy: fail_open\n\nevidence:\n  - se-1\n\ninstruction:\n  Continue with fail-open behavior.";
    expect(stepHeadline({ kind: "instruction", text })).toBe("Continue with fail-open behavior.");
  });

  it("names paths, tools, decisions, guardrails and fallbacks", () => {
    expect(stepHeadline({ kind: "edit", target: "src/auth/service.ts" })).toBe("src/auth/service.ts");
    expect(stepHeadline({ kind: "read", target: "src/db/users.ts" })).toBe("Read src/db/users.ts");
    expect(stepHeadline({ kind: "tool", target: "read_file" })).toBe("Read File");
    expect(stepHeadline({ kind: "decision", decisionTitle: "Account-linking policy" })).toBe("Account-linking policy");
    expect(stepHeadline({ kind: "guardrail", clampIds: ["a", "b"] })).toBe("2 guardrails");
    expect(stepHeadline({ kind: "guardrail", text: "Destructive command" })).toBe("Destructive command");
    expect(stepHeadline({ kind: "reasoning", text: "secret thoughts" })).toBe("Thinking");
    expect(stepHeadline({ kind: "attention" })).toBe("Attention scored");
    expect(stepHeadline({ kind: "lifecycle", text: "Turn ended" })).toBe("Turn ended");
    expect(stepHeadline({ kind: "dependency", text: "+zod −axios" })).toBe("+zod −axios");
    expect(stepHeadline({ kind: "approval", target: "rm -rf dist" })).toBe("Approval needed for rm -rf dist");
    expect(stepHeadline({ kind: "revert" })).toBe("Revert detected");
  });

  it("shows bidi overrides in commands, paths and text as visible tokens", () => {
    expect(stepHeadline({ kind: "command", target: "rm ‮fdp.exe", exitCode: 0 })).toBe("rm ⟨U+202E⟩fdp.exe");
    expect(stepHeadline({ kind: "edit", target: "src/‮gnp.ts" })).toBe("src/⟨U+202E⟩gnp.ts");
    expect(stepHeadline({ kind: "message", text: "Done‮; all checks pass." })).toBe("Done⟨U+202E⟩; all checks pass.");
  });
});
