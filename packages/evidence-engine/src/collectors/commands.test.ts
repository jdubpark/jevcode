import type { EvidenceFact } from "@jevcode/contracts";
import { describe, expect, it } from "vitest";

import { createCommandCollector, extractCommandLines } from "./commands.js";

type CommandFact = Extract<EvidenceFact, { type: "command_executed" }>;

describe("extractCommandLines", () => {
  it("extracts commands from a PTY-style transcript", () => {
    const text = [
      "$ pnpm install",
      "  ...",
      "$ git status --short",
      "> pnpm test",
      "",
    ].join("\n");
    expect(extractCommandLines(text)).toEqual([
      "pnpm install",
      "git status --short",
      "pnpm test",
    ]);
  });

  it("ignores plain output lines", () => {
    expect(extractCommandLines("some output\nmore output")).toEqual([]);
  });
});

describe("createCommandCollector", () => {
  const opts = {
    repoId: "repo-1",
    sessionId: "sess-1",
    now: () => "2026-01-01T00:00:00.000Z",
  };

  it("emits command_executed facts with destructive classification", () => {
    const collector = createCommandCollector("/repo", opts);
    const fact = collector.observe("rm -rf node_modules && pnpm install", 0);
    expect(fact).toMatchObject({
      type: "command_executed",
      repoId: "repo-1",
      sessionId: "sess-1",
      command: "rm -rf node_modules && pnpm install",
      exitCode: 0,
      isDestructive: true,
    });
  });

  it("flags non-destructive commands as safe", () => {
    const collector = createCommandCollector("/repo", opts);
    const fact = collector.observe("pnpm test", 0) as CommandFact | null;
    expect(fact?.isDestructive).toBe(false);
  });

  it("keeps non-zero exit codes", () => {
    const collector = createCommandCollector("/repo", opts);
    const fact = collector.observe("pnpm build", 1) as CommandFact | null;
    expect(fact?.exitCode).toBe(1);
  });

  it("skips empty commands", () => {
    const collector = createCommandCollector("/repo", opts);
    expect(collector.observe("   ", 0)).toBeNull();
    expect(collector.facts).toHaveLength(0);
  });

  it("observes batches", () => {
    const collector = createCommandCollector("/repo", opts);
    const facts = collector.observeAll([
      { command: "pnpm install", exitCode: 0 },
      { command: "git reset --hard HEAD", exitCode: 0 },
    ]) as CommandFact[];
    expect(facts).toHaveLength(2);
    expect(facts[0]?.isDestructive).toBe(false);
    expect(facts[1]?.isDestructive).toBe(true);
  });
});
