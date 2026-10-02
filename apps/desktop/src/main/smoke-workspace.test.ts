import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  SHOT_HEIGHT,
  SHOT_WIDTHS,
  SMOKE_PROMPT,
  openRepoScript,
  parseWorkspaceReady,
  runWorkspaceSmoke,
  startSessionScript,
} from "./smoke-workspace.js";
import type { WorkspaceSmokeDeps } from "./smoke-workspace.js";

function fake() {
  const listeners = new Set<(message: string) => void>();
  const execs: string[] = [];
  const files = new Map<string, Uint8Array>();
  const captures: Array<[number, number]> = [];
  const lines: string[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const deps: WorkspaceSmokeDeps = {
    exec: async (script) => {
      execs.push(script);
      return null;
    },
    onConsole: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    capture: async (width, height) => {
      captures.push([width, height]);
      return new Uint8Array([1, 2, 3]);
    },
    writeFile: (file, data) => {
      files.set(file, data);
    },
    setTimeout: (fn) => {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, fn);
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    log: (line) => lines.push(line),
  };
  return {
    deps,
    execs,
    files,
    captures,
    lines,
    console: (message: string) => {
      for (const listener of [...listeners]) listener(message);
    },
    fireTimers: () => {
      for (const [id, fn] of [...timers]) {
        timers.delete(id);
        fn();
      }
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("runWorkspaceSmoke", () => {
  it("opens the repo, starts the session, waits for the embedded viewer and captures 1440 and 1000", async () => {
    const run = fake();
    const done = runWorkspaceSmoke(run.deps, { repoPath: "/tmp/smoke-repo", shotsDir: "/tmp/shots" });
    await flush();
    expect(run.execs).toEqual([openRepoScript("/tmp/smoke-repo"), startSessionScript(SMOKE_PROMPT)]);
    run.console("TRACE_PERF tv:first-paint 12.00");
    run.console("WORKSPACE_READY 3");
    await done;
    expect(run.captures).toEqual(SHOT_WIDTHS.map((width) => [width, SHOT_HEIGHT]));
    expect([...run.files.keys()]).toEqual([
      path.join("/tmp/shots", "main-console-1440.png"),
      path.join("/tmp/shots", "main-console-1000.png"),
    ]);
    expect(run.lines[0]).toBe("SMOKE_WORKSPACE ready rows=3");
  });

  it("fails when the embedded viewer never reports ready", async () => {
    const run = fake();
    const done = runWorkspaceSmoke(run.deps, { repoPath: "/tmp/smoke-repo", shotsDir: null });
    await flush();
    run.fireTimers();
    await expect(done).rejects.toThrow(/WORKSPACE_READY not seen/);
  });

  it("JSON-encodes the repo path so a quote cannot break out of the script", () => {
    const script = openRepoScript('/tmp/a"b');
    expect(script).toContain(JSON.stringify('/tmp/a"b'));
    expect(script.startsWith("window.jevcode.repo.open(")).toBe(true);
  });

  it("parses only exact WORKSPACE_READY lines", () => {
    expect(parseWorkspaceReady("WORKSPACE_READY 12")).toBe(12);
    expect(parseWorkspaceReady("WORKSPACE_READY")).toBeNull();
    expect(parseWorkspaceReady("x WORKSPACE_READY 1")).toBeNull();
  });
});
