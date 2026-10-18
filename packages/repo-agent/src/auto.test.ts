import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { runAuto, type AutoOptions } from "./auto.js";
import { carryForward, generateBrief, unstableSections, type Writer } from "./brief.js";
import { collectRepository } from "./collect.js";
import { AutoConfigSchema, repoEnabled, setOptIn } from "./config.js";
import { parseHookPayload } from "./hook.js";
import { heuristicGate, jevGate, type GateSignals, type JevQuestion, type JevTransport } from "./jev.js";
import { calibrate, churn, DEFAULT_TUNING, readLedger, readTuning, type LedgerEntry } from "./learning.js";
import { buildPrompt } from "./prompt.js";
import { BriefSchema, renderBrief, validateBrief, type Brief } from "./report.js";
import { readCheckpoint } from "./state.js";

const exec = promisify(execFile);
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function scratch(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  temporary.push(directory);
  return directory;
}

async function fixture(): Promise<string> {
  const root = await scratch("jevcode-auto-test-");
  for (const dir of ["src/api", "src/auth"]) await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, "src/api/index.ts"), 'import { allowed } from "../auth/policy.js";\nexport const handler = allowed;\n');
  await writeFile(path.join(root, "src/auth/policy.ts"), "export const allowed = () => false;\n");
  await writeFile(path.join(root, "README.md"), "# Example\n\nAPI requests go through the authorization policy.\n");
  await exec("git", ["init", "-q", root]);
  await exec("git", ["-C", root, "add", "."]);
  await exec("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "baseline"]);
  return root;
}

function brief(overrides: Partial<Brief> = {}): Brief {
  return BriefSchema.parse({
    summary: "The API delegates access decisions to a shared policy.",
    architecture: [{ text: "The API imports the authorization policy.", citations: [{ source: "src/api/index.ts", line: 1 }] }],
    review: [{ priority: "high", area: "Authorization", why: "This policy controls API access.", question: "Does the policy deny unauthenticated callers?", citations: [{ source: "src/auth/policy.ts", line: 1 }] }],
    changes: [], checks: [], guidance: [], unknowns: ["Runtime behavior has not been tested."],
    diagrams: [{ title: "Request path", kind: "system", mermaid: "flowchart LR\n  API --> Policy", citations: [{ source: "src/api/index.ts", line: 1 }] }],
    ...overrides,
  });
}

/** A scripted writer that records every prompt it receives. */
function writer(id: string, answers: (Brief | Error | ((prompt: string) => Brief))[]): Writer & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    id, model: `${id}-model`, prompts,
    async run(prompt) {
      prompts.push(prompt);
      const next = answers.length > 1 ? answers.shift() : answers[0];
      if (next instanceof Error) throw next;
      return { value: typeof next === "function" ? next(prompt) : next, usage: { input: 100, output: 20 } };
    },
  };
}

/** Answers gate and claim questions from a table of probabilities; records each request. */
function judge(answers: Record<string, number | string>, fallback = 0.9): JevTransport & { requests: Record<string, JevQuestion>[] } {
  const requests: Record<string, JevQuestion>[] = [];
  return {
    requests,
    async systemOne({ questions }) {
      requests.push(questions);
      return {
        answers: Object.fromEntries(Object.entries(questions).map(([key, question]) => [key, question.type === "choice" ? { choice: answers[key] ?? "update" } : { noul: answers[key] ?? fallback }])),
        usage: { input_tokens: 50, output_tokens: 5 },
      };
    },
  };
}

const signals = (overrides: Partial<GateSignals> = {}): GateSignals => ({
  hasCheckpoint: true, changedSinceBrief: ["src/auth/policy.ts"], removedSinceBrief: [], touchedComponents: [{ path: "src/auth", changed: 1, incoming: 1 }],
  componentCount: 10, newActivityBytes: 0, recentActivity: [], minutesSinceBrief: 30, previous: brief(), ...overrides,
});

const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();
const decision = (minute: number, action: "skip" | "run", judge: "jev" | "deterministic" = "jev"): LedgerEntry => ({
  kind: "decision", id: `d${minute}`, at: at(minute), action, reason: "test", judge, worthwhile: 0.4, scope: "update", stale: [],
  signals: { changedFiles: 1, newActivityBytes: 0, minutesSinceBrief: 20 }, jevUsage: null, quickKey: null, session: null,
});
const run = (minute: number, fields: Partial<Extract<LedgerEntry, { kind: "run" }>> = {}): LedgerEntry => ({
  kind: "run", id: `r${minute}`, at: at(minute), trigger: "auto", decision: null, ok: true, error: null, writer: "muse", model: "m", attempts: 1,
  writerUsage: null, jevUsage: null, churn: 0.5, weakClaims: 0, removedClaims: 0, unsupportedAtDefault: 0, elapsedMs: 1000, ...fields,
});

describe("outcome-driven tuning", () => {
  it("waits for five weighted samples, then moves one bounded step per evaluation", () => {
    const noisy = [run(1, { churn: 0.05 }), run(2, { churn: 0.05 }), run(3, { churn: 0.1 }), run(4, { churn: 0.05 })];
    expect(calibrate(DEFAULT_TUNING, noisy, new Date(at(10)))).toBe(DEFAULT_TUNING);
    const next = calibrate(DEFAULT_TUNING, [...noisy, run(5, { churn: 0.6 })], new Date(at(10)));
    expect(next).toMatchObject({ gateThreshold: 0.55, debounceMinutes: 15, minFiles: 3, adjustedAt: at(10) });
    expect(next.history.map((entry) => entry.field)).toEqual(["gateThreshold", "debounceMinutes", "minFiles"]);
    // Outcomes already counted do not move it again; new evidence is required.
    expect(calibrate(next, [...noisy, run(5, { churn: 0.6 })], new Date(at(20)))).toBe(next);
    let tuning = DEFAULT_TUNING;
    for (let round = 0; round < 20; round += 1) {
      tuning = calibrate(tuning, Array.from({ length: 5 }, (_, index) => run(100 + round * 10 + index, { churn: 0 })), new Date(at(100 + round * 10 + 9)));
    }
    expect(tuning).toMatchObject({ gateThreshold: 0.85, debounceMinutes: 120, minFiles: 10 });
  });

  it("treats a judged skip followed by a manual request or a large refresh as late", () => {
    const entries = [
      decision(0, "skip"), run(20, { trigger: "manual" }),
      decision(100, "skip"), run(130, { churn: 0.8 }),
      decision(200, "skip"), run(400, { churn: 0.9 }),
      decision(500, "skip", "deterministic"), run(510, { trigger: "manual" }),
    ];
    // Three judged skips (two late) plus two automatic runs with ordinary churn.
    expect(calibrate(DEFAULT_TUNING, entries, new Date(at(600)))).toMatchObject({ gateThreshold: 0.45, debounceMinutes: 6.67, minFiles: 1 });
  });

  it("weights explicit feedback and tightens claim checks after unsupported claims", () => {
    const feedback = (minute: number, verdict: "useful" | "noise" | "late" | "wrong"): LedgerEntry => ({ kind: "feedback", id: `f${minute}`, at: at(minute), verdict, section: null, note: null });
    expect(calibrate(DEFAULT_TUNING, [feedback(1, "late"), feedback(2, "late"), run(3)], new Date(at(5)))).toMatchObject({ gateThreshold: 0.45 });
    expect(calibrate(DEFAULT_TUNING, [feedback(1, "wrong"), run(2, { unsupportedAtDefault: 2 }), run(3), run(4)], new Date(at(5)))).toMatchObject({ verifyThreshold: 0.4, gateThreshold: 0.5 });
    expect(calibrate(DEFAULT_TUNING, [feedback(1, "useful"), feedback(2, "useful"), run(3)], new Date(at(5)))).toMatchObject({ gateThreshold: 0.5, verifyThreshold: 0.35 });
  });

  it("does not blame skips that rightly let small changes accumulate", () => {
    let tuning = DEFAULT_TUNING;
    for (let cycle = 0; cycle < 6; cycle += 1) {
      const base = cycle * 100;
      const skips = [1, 2, 3, 4].map((files, index) => ({ ...decision(base + index * 10, "skip"), id: `s${base + index}`, signals: { changedFiles: files, newActivityBytes: 0, minutesSinceBrief: 20 } }));
      const chosen = { ...decision(base + 45, "run"), id: `d${base}`, signals: { changedFiles: 10, newActivityBytes: 0, minutesSinceBrief: 60 } };
      tuning = calibrate(tuning, [...skips, chosen, run(base + 50, { churn: 0.6, decision: `d${base}` })], new Date(at(base + 60)));
    }
    expect(tuning).toBe(DEFAULT_TUNING);
  });

  it("keeps the claim threshold from ratcheting on its own removals", () => {
    let tuning = DEFAULT_TUNING;
    for (let round = 0; round < 4; round += 1) {
      // One run in five has an unsupported first draft at the default support, whatever the threshold removed.
      const runs = Array.from({ length: 5 }, (_, index) => run(round * 10 + index, { unsupportedAtDefault: index === 0 ? 1 : 0, removedClaims: 3 }));
      tuning = calibrate(tuning, runs, new Date(at(round * 10 + 9)));
    }
    expect(tuning.verifyThreshold).toBe(0.35);
    // A writer whose drafts are often weak moves it one step above the default, no further without a human verdict.
    let weakDrafts = DEFAULT_TUNING;
    for (let round = 0; round < 4; round += 1) {
      weakDrafts = calibrate(weakDrafts, Array.from({ length: 5 }, (_, index) => run(100 + round * 10 + index, { unsupportedAtDefault: index < 2 ? 1 : 0 })), new Date(at(100 + round * 10 + 9)));
    }
    expect(weakDrafts.verifyThreshold).toBe(0.4);
    const verdict: LedgerEntry = { kind: "feedback", id: "fw", at: at(200), verdict: "wrong", section: "review", note: null };
    expect(calibrate(weakDrafts, [verdict, ...Array.from({ length: 5 }, (_, index) => run(201 + index, { unsupportedAtDefault: 1 }))], new Date(at(210))).verifyThreshold).toBe(0.45);
    const strict = { ...DEFAULT_TUNING, verifyThreshold: 0.5 };
    const clean = Array.from({ length: 10 }, (_, index) => run(index));
    expect(calibrate(strict, clean, new Date(at(20))).verifyThreshold).toBe(0.45);
  });

  it("measures churn by section wording, not by regenerated summaries", () => {
    const base = brief();
    expect(churn(null, base)).toBe(1);
    expect(churn(base, { ...base, summary: "Completely different words here." })).toBe(0);
    const revised = { ...base, changes: [{ text: "Authorization now accepts named users.", citations: [{ source: "src/auth/policy.ts", line: 1 }] }] };
    expect(churn(base, revised)).toBeCloseTo(1 / 7);
    // An incremental run that revised exactly what it was asked to is not noise.
    expect(churn(base, revised, ["changes"])).toBe(1);
    expect(churn(base, base, ["changes", "review"])).toBe(0);
  });
});

describe("refresh gate", () => {
  it("asks Jev once for worth, scope and per-section staleness", async () => {
    const transport = judge({ worthwhile: 0.8, scope: "update", stale_changes: 0.9, stale_review: 0.7, stale_architecture: 0.2 }, 0.1);
    const judgment = await jevGate(transport, signals());
    expect(transport.requests).toHaveLength(1);
    expect(Object.keys(transport.requests[0]!)).toEqual(expect.arrayContaining(["worthwhile", "scope", "stale_diagrams", "stale_unknowns"]));
    expect(judgment).toMatchObject({ worthwhile: 0.8, scope: "update", stale: ["review", "changes"], judge: "jev", usage: { input: 50, output: 5 } });
    expect((await jevGate(judge({ scope: "full" }, 0.1), signals())).stale).toHaveLength(7);
    await expect(jevGate({ systemOne: async () => ({ answers: { worthwhile: { noul: 0.9 } } }) }, signals())).rejects.toThrow("scope");
  });

  it("falls back to an interpretable heuristic that scales with change size and shape", () => {
    expect(heuristicGate(signals({ hasCheckpoint: false, previous: null }), 2)).toMatchObject({ scope: "full", worthwhile: 1 });
    const small = heuristicGate(signals(), 2);
    const large = heuristicGate(signals({ changedSinceBrief: ["a", "b", "c", "d"], touchedComponents: [{ path: "src/auth", changed: 4, incoming: 5 }] }), 2);
    expect(small.worthwhile).toBeLessThan(0.5);
    expect(large.worthwhile).toBeGreaterThan(0.5);
    expect(small.stale).not.toContain("architecture");
    expect(large.stale).toEqual(expect.arrayContaining(["architecture", "diagrams", "guidance"]));
  });
});

describe("brief generation pipeline", () => {
  it("carries forward unchanged sections and drops carried entries whose citations moved", async () => {
    const root = await fixture();
    const context = await collectRepository({ repo: root });
    const previous = brief({ guidance: [{ text: "Keep policy decisions in one module.", basis: "proposed", citations: [{ source: "src/auth/policy.ts", line: 40 }] }] });
    const fresh = brief({ summary: "New summary.", architecture: [], changes: [{ text: "The policy changed.", citations: [{ source: "src/auth/policy.ts", line: 1 }] }] });
    const merged = carryForward(fresh, { previous, stale: ["changes"] }, context);
    expect(merged.summary).toBe("New summary.");
    expect(merged.architecture).toEqual(previous.architecture);
    expect(merged.changes).toEqual(fresh.changes);
    expect(merged.guidance).toEqual([]);
  });

  it("revises sections whose carried citations name previous-run excerpts or changed files", async () => {
    const root = await fixture();
    const context = await collectRepository({ repo: root });
    const hashes = Object.fromEntries(Object.entries(context.files).map(([file, info]) => [file, info.hash]));
    expect(unstableSections(brief(), hashes, context)).toEqual([]);
    expect(unstableSections(brief({ changes: [{ text: "A change.", citations: [{ source: "patch:1", line: 2 }] }] }), hashes, context)).toEqual(["changes"]);
    expect(unstableSections(brief(), { ...hashes, "src/api/index.ts": "older" }, context)).toEqual(["architecture", "diagrams"]);
  });

  it("falls back to the next writer after a provider failure or an unrepairable answer", async () => {
    const root = await fixture();
    const context = await collectRepository({ repo: root });
    const options = { context, prompt: "assignment", deadline: Date.now() + 60_000, signal: new AbortController().signal, judge: null, verifyThreshold: 0.35, log: () => {} };
    const failing = writer("muse", [new Error("OpenCode exited with code 1")]);
    const backup = writer("deepseek", [brief()]);
    expect(await generateBrief({ ...options, writers: [failing, backup] })).toMatchObject({ writer: "deepseek", attempts: 1, writerUsage: { input: 100, output: 20 } });
    const invalid = brief({ architecture: [{ text: "Invented.", citations: [{ source: "src/missing.ts", line: 1 }] }] });
    const wrong = writer("muse", [invalid, invalid]);
    const result = await generateBrief({ ...options, writers: [wrong, writer("deepseek", [brief()])] });
    expect(result.writer).toBe("deepseek");
    expect(wrong.prompts[1]).toContain("failed validation: Brief cites unavailable source");
    expect(context.limitations.join(" ")).toContain("no Jev (TypeSafe) key");
    await expect(generateBrief({ ...options, writers: [writer("muse", [new Error("Source changed during review.")]), backup] })).rejects.toThrow("changed during");
    // An unparseable answer gets one format repair from the same writer; schema repairs name the fields.
    const garbled = Object.assign(new Error("The writer did not return a complete structured brief."), { name: "WriterFormatError", answer: "{\"summary\": " });
    const flaky = writer("muse", [garbled, { ...brief(), summary: "x".repeat(700) }, brief()]);
    expect(await generateBrief({ ...options, writers: [flaky] })).toMatchObject({ writer: "muse", attempts: 3 });
    expect(flaky.prompts[1]).toContain("not one parseable JSON object");
    expect(flaky.prompts[2]).toContain("summary: String must contain at most 600 character(s)");
  });

  it("repairs weakly supported claims once and removes the ones Jev still rejects", async () => {
    const root = await fixture();
    const context = await collectRepository({ repo: root });
    const first = brief({ changes: [{ text: "The API now caches responses.", citations: [{ source: "src/api/index.ts", line: 2 }] }] });
    const repaired = brief({ changes: [{ text: "The API still caches responses.", citations: [{ source: "src/api/index.ts", line: 2 }] }] });
    const author = writer("muse", [first, repaired]);
    // c0 architecture, c1 review, c2 changes, c3 diagram: the change claim stays unsupported.
    const transport = judge({ c2: 0.1 });
    const result = await generateBrief({ context, prompt: "assignment", writers: [author], deadline: Date.now() + 120_000, signal: new AbortController().signal, judge: transport, verifyThreshold: 0.35, log: () => {} });
    expect(author.prompts).toHaveLength(2);
    expect(author.prompts[1]).toContain("evidence check found entries");
    expect(author.prompts[1]).toContain("caches responses");
    expect(transport.requests).toHaveLength(2);
    expect(result).toMatchObject({ weakClaims: 1, removedClaims: 1, jevUsage: { input: 100, output: 10 } });
    expect(result.brief.changes).toEqual([]);
    expect(result.brief.unknowns.at(-1)).toContain("removed from changes");
    expect(result.brief.architecture).toHaveLength(1);
  });

  it("removes weak carried entries in place instead of rewriting a carried section", async () => {
    const root = await fixture();
    const context = await collectRepository({ repo: root });
    const reviewEntry = (area: string) => ({ priority: "medium" as const, area, why: "It controls access.", question: "Is this tested?", citations: [{ source: "src/auth/policy.ts", line: 1 }] });
    const previous = brief({ review: [reviewEntry("Policy default"), reviewEntry("Unrelated claim")], unknowns: ["Old question.", "2 generated entries were removed from changes because the cited evidence did not support them."] });
    const fresh = brief({ summary: "Updated.", architecture: [], review: [], diagrams: [], unknowns: ["New question."], changes: [{ text: "The policy changed.", citations: [{ source: "src/auth/policy.ts", line: 1 }] }] });
    const author = writer("muse", [fresh]);
    // Claims in order: architecture c0, review c1 and c2 (carried), changes c3, diagram c4. Only carried c2 is weak.
    const result = await generateBrief({ context, prompt: "assignment", writers: [author], deadline: Date.now() + 120_000, signal: new AbortController().signal, judge: judge({ c2: 0.1 }), verifyThreshold: 0.35, carry: { previous, stale: ["changes"] }, log: () => {} });
    expect(author.prompts).toHaveLength(1);
    expect(result.brief.review.map((entry) => entry.area)).toEqual(["Policy default"]);
    expect(result).toMatchObject({ removedClaims: 1, unsupportedAtDefault: 1 });
    expect(result.brief.unknowns).toEqual(["Old question.", "New question.", "1 generated entry was removed from review because the cited evidence did not support it."]);
  });

  it("hands previous entries to an update without run-specific citation ids", async () => {
    const root = await fixture();
    const context = await collectRepository({ repo: root });
    const previous = brief({ changes: [{ text: "The handler changed.", citations: [{ source: "patch:2", line: 6 }, { source: "src/api/index.ts", line: 1 }] }] });
    const prompt = buildPrompt(context, undefined, null, { previous, stale: ["changes"], changedSinceBrief: [], evidence: [{ source: "patch:2", line: 6, path: "src/api/index.ts", text: "+export const handler = allowed;" }] });
    const section = prompt.slice(prompt.indexOf("Previous content of the stale sections"), prompt.indexOf("Final report JSON schema"));
    expect(section).toContain("+export const handler = allowed;");
    expect(section).toContain('"source":"src/api/index.ts"');
    expect(section).not.toContain("patch:2");
  });

  it("renders safe Mermaid diagrams and drops unsafe ones without failing the brief", async () => {
    const root = await fixture();
    const context = await collectRepository({ repo: root });
    expect(renderBrief(await validateBrief(brief(), context), context)).toContain("```mermaid\nflowchart LR\n  API --> Policy\n```");
    // Node names that resemble directives are ordinary diagrams.
    for (const mermaid of ["flowchart LR\n  Link --> Store", "flowchart LR\n  Class --> Registry", "sequenceDiagram\n  Link->>Client: target", "flowchart LR\n  Style --> Theme"]) {
      expect((await validateBrief({ ...brief(), diagrams: [{ title: "Names", kind: "system", mermaid, citations: [{ source: "src/api/index.ts", line: 1 }] }] }, context)).diagrams).toHaveLength(1);
    }
    for (const mermaid of [
      "flowchart LR\n  A --> B\n  click A \"https://example.invalid\"", "flowchart LR\n  A[<img src=x>] --> B", "%%{init: {}}%%\nflowchart LR\n  A --> B", "pie title X\n  \"a\": 1",
      "sequenceDiagram\n  A->>B: hi\n  link A: Docs @ example", "flowchart LR\n  A@{ img: \"x.png\" } --> B",
      "flowchart LR\n  A --> B\n  style A fill:#f00", "flowchart LR\n  A --> B\n  classDef red fill:#f00", "flowchart LR\n  A --> B\n  class A red", "flowchart LR\n  A --> B\n  linkStyle 0 stroke:#f00",
    ]) {
      const checked = await collectRepository({ repo: root });
      const result = await validateBrief({ ...brief(), diagrams: [{ title: "Unsafe", kind: "system", mermaid, citations: [{ source: "src/api/index.ts", line: 1 }] }] }, checked);
      expect([mermaid, result.diagrams.length]).toEqual([mermaid, 0]);
      expect(checked.limitations.join(" ")).toContain("Dropped 1 generated diagram");
    }
  });
});

describe("automatic refresh", () => {
  const config = AutoConfigSchema.parse({ base: "head", include: ["*"] });
  // Checkpoints carry the real collection time, so the injected clock moves forward from now.
  const start = Date.now();
  const later = (minutes: number) => () => new Date(start + minutes * 60_000);
  async function auto(root: string, state: string, overrides: Partial<AutoOptions>) {
    return runAuto({ repo: root, logs: [], session: null, trigger: "hook", dryRun: false, stateDir: state, config, judge: null, writers: [writer("muse", [brief()])], log: () => {}, ...overrides });
  }

  it("skips cheaply when nothing changed, debounces, and runs an incremental update when Jev says so", async () => {
    const root = await fixture();
    const state = await scratch("jevcode-auto-state-");
    expect(await auto(root, state, {})).toMatchObject({ action: "skip", reason: "no changes or agent activity to brief yet" });

    await writeFile(path.join(root, "src/auth/policy.ts"), "export const allowed = (user: string) => user !== \"\";\n");
    const first = writer("muse", [brief()]);
    const created = await auto(root, state, { writers: [first], now: later(0) });
    expect(created).toMatchObject({ action: "run", reason: "full brief written by muse" });
    expect(await readFile(created.briefPath!, "utf8")).toContain("```mermaid");
    expect((await readCheckpoint(state, root))?.brief.diagrams).toHaveLength(1);

    expect(await auto(root, state, { now: later(1) })).toMatchObject({ action: "skip", reason: "no source or activity change since the last check" });
    await writeFile(path.join(root, "src/api/index.ts"), 'import { allowed } from "../auth/policy.js";\nexport const handler = (user: string) => allowed(user);\n');
    expect(await auto(root, state, { now: later(2) })).toMatchObject({ action: "skip", reason: "last brief is under 10 minutes old" });

    const transport = judge({ worthwhile: 0.9, scope: "update", stale_architecture: 0.1, stale_review: 0.1, stale_checks: 0.1, stale_guidance: 0.1, stale_unknowns: 0.1, stale_diagrams: 0.1 });
    const updater = writer("muse", [(prompt) => {
      expect(prompt).toContain("UPDATE MODE");
      // Jev marked only changes stale; architecture and diagrams cite the edited handler, so they are revised too.
      expect(prompt).toContain("Revise only these stale sections: architecture, changes, diagrams");
      return brief({
        summary: "The handler now passes the user to the policy.", review: [], unknowns: [],
        architecture: [{ text: "The handler passes each user to the authorization policy.", citations: [{ source: "src/api/index.ts", line: 2 }] }],
        changes: [{ text: "The handler forwards the user to the policy.", citations: [{ source: "src/api/index.ts", line: 2 }] }],
        diagrams: [{ title: "Request path", kind: "system", mermaid: "flowchart LR\n  Handler -->|user| Policy", citations: [{ source: "src/api/index.ts", line: 2 }] }],
      });
    }]);
    const updated = await auto(root, state, { judge: transport, writers: [updater], now: later(30) });
    expect(updated).toMatchObject({ action: "run", reason: "update brief written by muse" });
    const saved = (await readCheckpoint(state, root))!.brief;
    expect(saved.changes[0]?.text).toContain("forwards the user");
    expect(saved.architecture[0]?.text).toContain("passes each user");
    // The review cites the unchanged policy file, so it is carried forward verbatim.
    expect(saved.review).toEqual(brief().review);
    expect(saved.unknowns).toEqual(brief().unknowns);
    // One gate request, then one claim check over the merged brief.
    expect(transport.requests.map((questions) => Object.keys(questions).length)).toEqual([9, 4]);

    const ledger = await readLedger(state, root);
    expect(ledger.map((entry) => entry.kind === "decision" ? `${entry.action}:${entry.judge}` : entry.kind)).toEqual([
      "skip:deterministic", "run:heuristic", "run", "skip:deterministic", "skip:deterministic", "run:jev", "run",
    ]);
    expect(ledger.at(-1)).toMatchObject({ kind: "run", ok: true, writer: "muse", writerUsage: { input: 100, output: 20 } });
    expect(await readTuning(state, root)).toMatchObject({ gateThreshold: 0.5 });
  });

  it("records a judged skip, backs off after a failure, and never nests or overlaps", async () => {
    const root = await fixture();
    const state = await scratch("jevcode-auto-state-");
    await writeFile(path.join(root, "src/auth/policy.ts"), "export const allowed = () => true;\n");
    await auto(root, state, { now: later(0) });
    await writeFile(path.join(root, "README.md"), "# Example\n\nTypo fixed.\n");
    expect(await auto(root, state, { judge: judge({ worthwhile: 0.2, scope: "skip" }), now: later(30) })).toMatchObject({ action: "skip", reason: expect.stringContaining("jev judged a refresh not worthwhile") });

    await writeFile(path.join(root, "README.md"), "# Example\n\nA larger rewrite.\n");
    expect(await auto(root, state, { writers: [writer("muse", [new Error("OpenCode exited with code 1")])], judge: judge({ worthwhile: 0.9 }), now: later(60) })).toMatchObject({ action: "failed" });
    expect(await auto(root, state, { now: later(61) })).toMatchObject({ action: "skip", reason: expect.stringContaining("previous automatic brief failed") });

    process.env.JEVCODE_BRIEFING = "1";
    try { expect(await auto(root, state, {})).toMatchObject({ action: "skip", reason: "inside a briefing run" }); }
    finally { delete process.env.JEVCODE_BRIEFING; }

    const lock = path.join(state, (await import("./io.js")).hash(root) + ".auto.lock");
    await writeFile(lock, JSON.stringify({ pid: process.pid, token: "live", expiresAt: Date.now() + 60_000 }));
    expect(await auto(root, state, {})).toMatchObject({ action: "coalesced" });
    await rm(lock);
    expect(await auto(root, state, { config: { ...config, exclude: [root] } })).toMatchObject({ action: "disabled" });
  });

  it("accumulates agent activity since the last brief across judged skips", async () => {
    const root = await fixture();
    const state = await scratch("jevcode-auto-state-");
    const transcript = path.join(state, "session.jsonl");
    const turn = (text: string) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";
    await writeFile(transcript, turn("Started reviewing the policy.").repeat(40));
    await writeFile(path.join(root, "src/auth/policy.ts"), "export const allowed = () => true;\n");
    await auto(root, state, { logs: [transcript], now: later(0) });
    const quiet = judge({ worthwhile: 0.1, scope: "skip" });
    for (const [minute, size] of [[20, 3000], [40, 5000]] as const) {
      await writeFile(transcript, turn("x".repeat(size)), { flag: "a" });
      expect(await auto(root, state, { logs: [transcript], judge: quiet, now: later(minute) })).toMatchObject({ action: "skip" });
    }
    const skips = (await readLedger(state, root)).filter((entry): entry is Extract<LedgerEntry, { kind: "decision" }> => entry.kind === "decision" && entry.judge === "jev");
    expect(skips[1]!.signals.newActivityBytes).toBeGreaterThan(skips[0]!.signals.newActivityBytes + 4000);
  });

  it("launches a detached run from a hook payload that uses the caller's state directory", async () => {
    const root = await fixture();
    const state = await scratch("jevcode-hook-state-");
    const cli = new URL("../dist/cli.js", import.meta.url).pathname;
    const started = Date.now();
    // A private config home: the child must not depend on this machine's automatic-brief settings.
    const env = { ...process.env, JEVCODE_BRIEFING: "", XDG_CONFIG_HOME: await scratch("jevcode-config-") };
    await exec(process.execPath, [cli, "optin", "--repo", root], { env });
    const hook = exec(process.execPath, [cli, "auto", "--hook", "claude", "--state-dir", state], { env });
    hook.child.stdin!.end(JSON.stringify({ hook_event_name: "Stop", session_id: "s1", cwd: root, transcript_path: null }));
    expect(await hook).toMatchObject({ stdout: "" });
    expect(Date.now() - started).toBeLessThan(5000);
    let ledger: LedgerEntry[] = [];
    for (let attempt = 0; attempt < 100 && ledger.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      ledger = await readLedger(state, root);
    }
    expect(ledger).toMatchObject([{ kind: "decision", action: "skip", reason: "no changes or agent activity to brief yet", session: "s1" }]);
    expect(await readFile(path.join(state, "auto.log"), "utf8")).toContain("skip: no changes or agent activity to brief yet");
  }, 15000);

  it("lets small conversation turns add up past the cheap skip", async () => {
    const root = await fixture();
    const state = await scratch("jevcode-auto-state-");
    const transcript = path.join(state, "session.jsonl");
    await writeFile(path.join(root, "src/auth/policy.ts"), "export const allowed = () => true;\n");
    await auto(root, state, { logs: [transcript], now: later(0) });
    const reasons: string[] = [];
    for (let turn = 1; turn <= 3; turn += 1) {
      await writeFile(transcript, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "y".repeat(1200) }] } }) + "\n", { flag: "a" });
      reasons.push((await auto(root, state, { logs: [transcript], judge: judge({ worthwhile: 0.1, scope: "skip" }), now: later(30 + turn) })).reason);
    }
    expect(reasons[0]).toBe("no source or activity change since the last check");
    expect(reasons[1]).toContain("jev judged a refresh not worthwhile");
  });

  it("re-checks once without back-off when the checkout moved during the run", async () => {
    const root = await fixture();
    const state = await scratch("jevcode-auto-state-");
    await writeFile(path.join(root, "src/auth/policy.ts"), "export const allowed = () => true;\n");
    const pending = path.join(state, (await import("./io.js")).hash(root) + ".pending");
    const author = writer("muse", [(prompt) => {
      if (!prompt.includes("second")) { void 0; }
      return brief();
    }]);
    let call = 0;
    const moving: Writer = {
      id: "muse", model: "m",
      async run(prompt, options) {
        call += 1;
        // A trigger during the last pass leaves its marker for the next run instead of being dropped.
        if (call === 2) await writeFile(pending, "");
        if (call === 1) {
          // The agent keeps editing and stops again while the first brief is being written.
          await writeFile(path.join(root, "src/api/index.ts"), 'import { allowed } from "../auth/policy.js";\nexport const handler = () => allowed();\n');
          await writeFile(pending, "");
        }
        return author.run(prompt, options);
      },
    };
    const outcome = await auto(root, state, { writers: [moving], now: later(0) });
    expect(outcome).toMatchObject({ action: "run" });
    expect(call).toBe(2);
    expect(await readFile(pending, "utf8")).toBe("");
    const runs = (await readLedger(state, root)).filter((entry) => entry.kind === "run");
    expect(runs).toMatchObject([{ ok: false, error: expect.stringContaining("changed during") }, { ok: true }]);
  });

  it("stops the writer early when the checkout moves, and backs off after two such runs", async () => {
    const root = await fixture();
    const state = await scratch("jevcode-auto-state-");
    await writeFile(path.join(root, "src/auth/policy.ts"), "export const allowed = () => true;\n");
    await auto(root, state, { now: later(0) });
    let edits = 0;
    const editing: Writer = {
      id: "muse", model: "m",
      async run(_prompt, options) {
        edits += 1;
        await writeFile(path.join(root, "src/api/index.ts"), `export const handler = () => ${edits};\n`);
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 5000);
          options.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Briefing cancelled; no successful checkpoint was saved.")); }, { once: true });
        });
        return { value: brief(), usage: null };
      },
    };
    const busy = { writers: [editing], judge: judge({ worthwhile: 0.9, scope: "full" }), watchMs: 50 };
    await writeFile(path.join(root, "README.md"), "# Example\n\nThe agent is still working.\n");
    const started = Date.now();
    expect(await auto(root, state, { ...busy, now: later(30) })).toMatchObject({ action: "failed", reason: expect.stringContaining("stopped early") });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(await auto(root, state, { ...busy, now: later(32) })).toMatchObject({ action: "failed" });
    expect(await auto(root, state, { ...busy, now: later(34) })).toMatchObject({ action: "skip", reason: expect.stringContaining("previous automatic brief failed") });
    expect(edits).toBe(2);
  });

  it("reclaims stale or unreadable locks and serializes concurrent triggers", async () => {
    const root = await fixture();
    const state = await scratch("jevcode-auto-state-");
    await writeFile(path.join(root, "src/auth/policy.ts"), "export const allowed = () => true;\n");
    const lock = path.join(state, (await import("./io.js")).hash(root) + ".auto.lock");
    // A live PID (reused after a crash) whose owner's own expiry has passed.
    await writeFile(lock, JSON.stringify({ pid: process.pid, token: "old", expiresAt: Date.now() - 1 }));
    expect(await auto(root, state, { now: later(0) })).toMatchObject({ action: "run" });
    await writeFile(lock, "12345");
    expect(await auto(root, state, { now: later(1) })).toMatchObject({ action: "skip" });
    await expect(readFile(lock, "utf8")).rejects.toThrow();

    await writeFile(path.join(root, "README.md"), "# Example\n\nRewritten.\n");
    const slow: Writer = { id: "muse", model: "m", run: async () => { await new Promise((resolve) => setTimeout(resolve, 300)); return { value: brief(), usage: null }; } };
    const [first, second] = await Promise.all([
      auto(root, state, { writers: [slow], judge: judge({ worthwhile: 0.9, scope: "full" }), now: later(30) }),
      new Promise((resolve) => setTimeout(resolve, 100)).then(() => auto(root, state, { writers: [slow], now: later(30) })),
    ]);
    expect(second).toMatchObject({ action: "coalesced" });
    expect([first.action, first.reason]).toEqual(["run", "full brief written by muse"]);
    const tail = (await readLedger(state, root)).slice(-4).map((entry) => entry.kind === "decision" ? entry.action : entry.kind);
    // The coalesced trigger may land before or after the run decision; the run then re-checks and finds nothing new.
    expect(tail.slice(0, 2).sort()).toEqual(["coalesced", "run"]);
    expect(tail.slice(2)).toEqual(["run", "skip"]);
    await expect(readFile(lock, "utf8")).rejects.toThrow();
  });

  it("opts repositories in by root commit so every clone and worktree follows, and opts them out precisely", async () => {
    const root = await fixture();
    const clone = await scratch("jevcode-clone-");
    await exec("git", ["clone", "-q", root, clone]);
    // Unrelated history: a different root commit.
    const other = await scratch("jevcode-other-");
    await exec("git", ["init", "-q", other]);
    await writeFile(path.join(other, "other.txt"), "unrelated\n");
    await exec("git", ["-C", other, "add", "."]);
    await exec("git", ["-C", other, "-c", "user.name=Other", "-c", "user.email=other@example.invalid", "commit", "-qm", "other"]);
    const fresh = AutoConfigSchema.parse({});
    expect(await repoEnabled(fresh, root)).toBe(false);
    const opted = await setOptIn(fresh, root, true);
    expect(opted.include).toEqual([expect.stringMatching(/^root:[0-9a-f]{40}$/)]);
    expect(await repoEnabled(opted, clone)).toBe(true);
    // A worktree on a branch with separate (for example rewritten) history is covered once it is a ref.
    const rewritten = await scratch("jevcode-rewritten-");
    await exec("git", ["-C", root, "worktree", "add", "-q", "--orphan", "-b", "old-history", rewritten]).catch(async () => {
      await exec("git", ["-C", root, "worktree", "add", "-q", "--detach", rewritten]);
      await exec("git", ["-C", rewritten, "checkout", "-q", "--orphan", "old-history"]);
    });
    await writeFile(path.join(rewritten, "legacy.txt"), "before the rewrite\n");
    await exec("git", ["-C", rewritten, "add", "."]);
    await exec("git", ["-C", rewritten, "-c", "user.name=Legacy", "-c", "user.email=legacy@example.invalid", "commit", "-qm", "legacy root"]);
    expect(await repoEnabled(opted, rewritten)).toBe(false);
    const both = await setOptIn(fresh, root, true);
    expect(both.include).toHaveLength(2);
    expect(await repoEnabled(both, rewritten)).toBe(true);
    expect(await repoEnabled(opted, other)).toBe(false);
    expect(await repoEnabled(await setOptIn(opted, clone, false), root)).toBe(false);
    // Opting out of one repository under a broad rule keeps the rule and excludes only that repository.
    const broad = await setOptIn(AutoConfigSchema.parse({ include: [path.dirname(root)] }), root, false);
    expect(broad.include).toEqual([path.dirname(root)]);
    expect(await repoEnabled(broad, root)).toBe(false);
    expect(await repoEnabled(broad, other)).toBe(true);
    const unborn = await scratch("jevcode-unborn-optin-");
    await exec("git", ["init", "-q", unborn]);
    expect((await setOptIn(fresh, unborn, true)).include).toEqual([unborn]);
  });

  it("reads hook payloads and scopes enablement by checkout prefix", async () => {
    expect(parseHookPayload(JSON.stringify({ cwd: "/work/repo", transcript_path: "/work/.sessions/a.jsonl", session_id: "s1", hook_event_name: "Stop" }), "/fallback")).toEqual({ cwd: "/work/repo", transcript: "/work/.sessions/a.jsonl", session: "s1" });
    expect(parseHookPayload("not json", "/fallback")).toEqual({ cwd: "/fallback", transcript: null, session: null });
    expect(parseHookPayload(JSON.stringify({ cwd: "relative", transcript_path: "also-relative" }), "/fallback")).toEqual({ cwd: "/fallback", transcript: null, session: null });
    const scoped = AutoConfigSchema.parse({ include: ["/work"], exclude: ["/work/private"] });
    expect(await repoEnabled(scoped, "/work/repo")).toBe(true);
    expect(await repoEnabled(scoped, "/work/private/repo")).toBe(false);
    expect(await repoEnabled(scoped, "/workspace")).toBe(false);
    expect(await repoEnabled(AutoConfigSchema.parse({ enabled: false, include: ["*"] }), "/work/repo")).toBe(false);
  });
});
