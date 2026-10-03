import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONSOLE_APPEND_P95_BUDGET_MS,
  SHOT_HEIGHT,
  SHOT_WIDTHS,
  SMOKE_PROMPT,
  VIEW_KEYS,
  appendLatencies,
  createAppendLog,
  openRepoScript,
  parseConsolePaint,
  parseWorkspaceLocation,
  parseWorkspaceReady,
  percentile,
  slowestAppend,
  pressKeyScript,
  runWorkspaceSmoke,
  startSessionScript,
  SURFACES_CLICK_DIFF_SCRIPT,
  SURFACES_DISMISS_SCRIPT,
} from "./smoke-workspace.js";
import type { WorkspaceSmokeDeps } from "./smoke-workspace.js";

interface FakeOptions {
  /** Selection reported after each view key; default: unchanged. */
  selectedFor?: (view: string) => string;
  /** Latency in ms between each stored row and its paint. */
  paintDelayMs?: number;
  rows?: number;
  /** Row type main reports for each stored row. */
  rowType?: string;
  /** The embedded viewer never logs WORKSPACE_READY. */
  noReady?: boolean;
  /** What the renderer DOM probes report in the Surfaces step. */
  dismissResult?: unknown;
  clickResult?: unknown;
}

function fake(options: FakeOptions = {}) {
  const listeners = new Set<(message: string) => void>();
  const execs: string[] = [];
  const files = new Map<string, Uint8Array>();
  const lines: string[] = [];
  let wall = 10_000;
  const appends = createAppendLog(() => wall);
  const emit = (message: string) => {
    for (const listener of [...listeners]) listener(message);
  };
  const deps: WorkspaceSmokeDeps = {
    exec: async (script) => {
      execs.push(script);
      if (script.includes("listSessions")) return "s1";
      if (script.includes("session.start")) {
        if (options.noReady === true) return "repo_1";
        queueMicrotask(() => emit("WORKSPACE_READY 2"));
        // The mock agent, one macrotask later (after the smoke has read readyAt):
        // rows stored after ready, each painted paintDelayMs later, then quiet.
        setTimeout(() => {
          const count = options.rows ?? 5;
          for (let seq = 3; seq < 3 + count; seq += 1) {
            wall += 300;
            appends.record("s1", seq, options.rowType);
            emit(`CONSOLE_PAINT s1 ${seq} ${wall + (options.paintDelayMs ?? 40)}`);
          }
          wall += 10_000;
        }, 5);
        return "repo_1";
      }
      if (script === SURFACES_DISMISS_SCRIPT) {
        return options.dismissResult ?? { ids: ["completion"], actions: ["accept_changes", "request_changes", "show_exact_diff"] };
      }
      if (script === SURFACES_CLICK_DIFF_SCRIPT) {
        return options.clickResult ?? { ids: ["completion", "diff:abc"], actions: ["show_exact_diff"] };
      }
      const key = VIEW_KEYS.find((entry) => script.includes(`"${entry.code}"`));
      if (script.includes('"KeyJ"')) queueMicrotask(() => emit('WORKSPACE_LOCATION {"view":"console","selected":"step:3"}'));
      if (key !== undefined) {
        const selected = options.selectedFor?.(key.view) ?? "step:3";
        queueMicrotask(() => emit(`WORKSPACE_LOCATION ${JSON.stringify({ view: key.view, selected })}`));
      }
      return true;
    },
    onConsole: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    capture: async () => new Uint8Array([1]),
    writeFile: (file, data) => {
      files.set(file, data);
    },
    appends,
    loopDelay: { reset: () => undefined, snapshot: () => ({ p99Ms: 12.4, maxMs: 31.6 }) },
    wallNow: () => wall,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 1)),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    log: (line) => lines.push(line),
  };
  return { deps, execs, files, lines };
}

describe("smoke-workspace parsing", () => {
  it("parses only exact smoke lines", () => {
    expect(parseWorkspaceReady("WORKSPACE_READY 12")).toBe(12);
    expect(parseWorkspaceReady("x WORKSPACE_READY 1")).toBeNull();
    expect(parseConsolePaint("CONSOLE_PAINT s1 41 1700000000123")).toEqual({ sessionId: "s1", throughSeq: 41, atMs: 1700000000123 });
    expect(parseConsolePaint("CONSOLE_PAINT s1 41")).toBeNull();
    expect(parseWorkspaceLocation('WORKSPACE_LOCATION {"view":"map","selected":"step:9"}')).toEqual({ view: "map", selected: "step:9" });
    expect(parseWorkspaceLocation('WORKSPACE_LOCATION {"view":"map"}')).toEqual({ view: "map", selected: null });
    expect(parseWorkspaceLocation("WORKSPACE_LOCATION {")).toBeNull();
  });

  it("JSON-encodes values that reach executeJavaScript", () => {
    expect(openRepoScript('/tmp/a"b')).toContain(JSON.stringify('/tmp/a"b'));
    expect(startSessionScript(SMOKE_PROMPT)).toContain(JSON.stringify(SMOKE_PROMPT));
    expect(pressKeyScript("Digit3", "3")).toContain('"Digit3"');
  });
});

describe("append latency (spec §11)", () => {
  it("uses the spec budget", () => {
    expect(CONSOLE_APPEND_P95_BUDGET_MS).toBe(150);
  });

  it("measures each stored row to the first paint covering its seq", () => {
    const { latencies, unpainted } = appendLatencies(
      [
        { seq: 4, atMs: 1_000 },
        { seq: 5, atMs: 1_010 },
        { seq: 6, atMs: 1_500 },
        { seq: 7, atMs: 2_000 },
      ],
      [
        { sessionId: "s1", throughSeq: 5, atMs: 1_060 },
        { sessionId: "s1", throughSeq: 6, atMs: 1_530 },
      ],
    );
    expect(latencies).toEqual([60, 50, 30]);
    expect(unpainted).toEqual([7]);
  });

  it("names the slowest append with its seq, row type, stored time and painted time", () => {
    const slowest = slowestAppend(
      [
        { seq: 4, atMs: 1_000, type: "agent_event" },
        { seq: 5, atMs: 1_010, type: "decision" },
        { seq: 6, atMs: 1_500 },
        { seq: 7, atMs: 2_000, type: "agent_event" },
      ],
      [
        { sessionId: "s1", throughSeq: 4, atMs: 1_040 },
        { sessionId: "s1", throughSeq: 6, atMs: 1_730 },
      ],
    );
    // Seq 5 and 6 share the second paint; seq 5 waited 720 ms of it (the 716 ms spike shape), and seq 7 was never painted.
    expect(slowest).toEqual({ seq: 5, type: "decision", storedAtMs: 1_010, paintedAtMs: 1_730, latencyMs: 720 });
    expect(slowestAppend([{ seq: 7, atMs: 2_000 }], [])).toBeNull();
  });

  it("takes the nearest-rank percentile", () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentile(values, 0.95)).toBe(95);
    expect(percentile(values, 0.5)).toBe(50);
    expect(percentile([7], 0.95)).toBe(7);
    expect(Number.isNaN(percentile([], 0.95))).toBe(true);
  });
});

describe("runWorkspaceSmoke", () => {
  it("measures appends, captures 1440 and 1000 before any selection, then walks every view with the selection kept", async () => {
    const run = fake({ rows: 5, paintDelayMs: 40 });
    await runWorkspaceSmoke(run.deps, { repoPath: "/tmp/repo", shotsDir: "/tmp/shots", minSamples: 5 });
    expect(run.execs.slice(0, 2)).toEqual([openRepoScript("/tmp/repo"), startSessionScript(SMOKE_PROMPT)]);
    const shots = SHOT_WIDTHS.map((width) => path.join("/tmp/shots", `main-console-${width}.png`));
    // The shots come before the first key press, so the Brief (not a step's Inspector) is on the right.
    expect(run.lines.filter((line) => line.startsWith("SMOKE_"))).toEqual([
      "SMOKE_WORKSPACE session=s1 ready_rows=2",
      "SMOKE_CONSOLE appends=5 p50_ms=40 p95_ms=40 max_ms=40",
      // 10_000 + 5 x 300 ms; seq 3 is the first row stored, and every paint lands 40 ms after its row.
      "SMOKE_CONSOLE_SLOWEST seq=3 type=unknown stored_at_ms=10300 painted_at_ms=10340 latency_ms=40",
      "SMOKE_LOOP_DELAY p99_ms=12 max_ms=32 resolution_ms=10",
      ...shots.map((file) => `SMOKE_SHOT ${file}`),
      "SMOKE_SURFACES actions=accept_changes,request_changes,show_exact_diff diff=diff:abc",
      "SMOKE_VIEWS selected=step:3 views=canvas,hybrid,map,surfaces,console",
    ]);
    expect([...run.files.keys()]).toEqual(shots);
    expect(SHOT_HEIGHT).toBe(900);
  });

  it("fails over the p95 budget", async () => {
    const run = fake({ rows: 5, paintDelayMs: 400 });
    await expect(runWorkspaceSmoke(run.deps, { repoPath: "/tmp/repo", shotsDir: null, minSamples: 5 })).rejects.toThrow(
      /p95 400 ms is over the 150 ms budget/,
    );
  });

  it("fails with too few samples for a p95", async () => {
    const run = fake({ rows: 5 });
    await expect(runWorkspaceSmoke(run.deps, { repoPath: "/tmp/repo", shotsDir: null, minSamples: 300 })).rejects.toThrow(
      /only 5 append samples \(need 300\)/,
    );
  });

  it("fails when the embedded viewer never reports ready", async () => {
    const run = fake({ noReady: true });
    await expect(runWorkspaceSmoke(run.deps, { repoPath: "/tmp/repo", shotsDir: null, minSamples: 5 })).rejects.toThrow(
      /WORKSPACE_READY not seen/,
    );
  });

  it("fails when a view switch loses the selection", async () => {
    const run = fake({ selectedFor: (view) => (view === "hybrid" ? "step:9" : "step:3") });
    await expect(runWorkspaceSmoke(run.deps, { repoPath: "/tmp/repo", shotsDir: null, minSamples: 5 })).rejects.toThrow(
      /selection changed on hybrid: step:3 → step:9/,
    );
  });

  it("fails when the completion surface's action buttons do not render", async () => {
    const run = fake({ dismissResult: { ids: ["changeunit:1"], actions: [] } });
    await expect(runWorkspaceSmoke(run.deps, { repoPath: "/tmp/repo", shotsDir: null, minSamples: 5 })).rejects.toThrow(
      /Surfaces step: completion surface action buttons did not render \(surfaces=\[changeunit:1\] actions=\[\]/,
    );
  });

  it("fails when no surface renders at all", async () => {
    const run = fake({ dismissResult: { ids: [], actions: [], timedOut: true } });
    await expect(runWorkspaceSmoke(run.deps, { repoPath: "/tmp/repo", shotsDir: null, minSamples: 5 })).rejects.toThrow(
      /Surfaces step: no surface rendered/,
    );
  });

  it("fails when clicking show_exact_diff never yields a diff: surface", async () => {
    const run = fake({ clickResult: { ids: ["completion"], actions: ["show_exact_diff"], timedOut: true } });
    await expect(runWorkspaceSmoke(run.deps, { repoPath: "/tmp/repo", shotsDir: null, minSamples: 5 })).rejects.toThrow(
      /Surfaces step: no diff: surface appeared within 8s after clicking show_exact_diff/,
    );
  });
});
