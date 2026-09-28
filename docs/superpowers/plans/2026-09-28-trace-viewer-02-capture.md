# Trace Viewer Lane A1: Capture Fixes (M0, M1a, M1b, M1c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every jevcode session record what the trace viewer needs at the source: owner-only DB files, per-process `turnId`, per-call `callId`, `agent_reasoning`, honest `agent_interrupted` lifecycle rows, `sourceCallId` on derived facts, canonical fact ids, redacted size-capped diffs emitted only on change, `ChangeUnit.agentCallIds`, `Decision.ts`, `JevDecisionLog.pass` and graph domain ids.

**Architecture:** The W0 contracts (already merged) declare every field as optional. This lane fills them in the producers: `@jevcode/storage` (`openDb` file modes), `@jevcode/agent-core` and `@jevcode/agent-codex` (turn and call ids, interrupt semantics), `@jevcode/evidence-engine` (collector provenance, `PrepareDiff`, change-only git emission), `@jevcode/semantic-core` (canonical fact ids, unit↔call join, graph ids) and the desktop pipeline (`PipelineRuntime`, `jev-stage`, redactor, evidence wiring). No SQL migration; stored rows written before this lane keep parsing.

**Tech Stack:** TypeScript 5.9 (NodeNext, strict, `verbatimModuleSyntax`), zod 3.25, pnpm 9.15 workspaces, vitest 3.2, fast-check 4.10 (semantic-core), better-sqlite3 11, node-pty 1.1, Node ≥ 22.

**Spec:** `docs/superpowers/specs/2026-09-28-trace-viewer-design.md` — sections "User decisions" (D2, D5, D6, D9, D10, D11) and "Accepted recommendations (data)" (R1, R2, R3, R4). Interface contract and file ownership: `docs/superpowers/plans/2026-09-28-trace-viewer-interfaces.md` (sections 2.1, 2.4, 3 "A1", 4 and 5). On conflict the binding decision record wins, then the spec, then the interfaces index, then this file.

**Lane:** A1, wave W1. Branch `tv/a1-capture`, worktree `/Users/jwpark/Projects/jevcode-tv-a1`. Merges first in W1 (A1, then A2, then B). Run every command in this file from the worktree root.

## Interface deviations

Each item fixes a defect or gap found in the interfaces index while reading the code. Nothing in section 2 of the index is renamed or removed.

1. **A1-3 also edits `apps/desktop/src/main/session-service.ts` and `apps/desktop/src/main/session-guard.test.ts`.** The IPC stop handler (`ipc.ts` `sessionStop`) calls `runtime.stopSession(sessionId)` and then `stopSession(deps.db, sessionId)` from session-service.ts, which sets `endedAt` and rewrites every non-terminal state to `"completed"`. Without this edit, D10 ("stop leaves the session PAUSED") fails on the real UI path even though the runtime stores `paused`. `ipc.ts` itself is not touched (A2 owns it in W1).
2. **A1-3 also edits `packages/agent-codex/src/delivery-queue.test.ts`.** Its test "keeps queued instructions when interrupted" asserts `agent_failed` and state `failed` after `interrupt()`.
3. **A1-3 also edits `docs/spikes/codex-spike.md`** (§3 exit row, §4 interrupt consequence). The index gives the file only to A1-2, but the interrupt rows describe A1-3 behavior. Both tasks run in this lane, in order.
4. **`agent_interrupted {reason: "steer"}` does not change the runtime session state.** The index says `applyTerminalAgentState` maps `agent_interrupted` to `paused`. A steer relaunches Codex in the same adapter call, and the runtime has no transition back to `running` for `agent_started`, so pausing on steer would show a running agent as paused. Reasons `interrupt` and `stop` pause; `steer` keeps the current state.
5. **`agent_reasoning` carries `callId` too.** The W0 schema spreads `...call` into `agent_reasoning` and R2 says `agent_reasoning {text, callId?}`; the index prose mentions only the six call variants. The mapper stamps `callId` on reasoning items as well.
6. **A1-7 removes the revert-detector double push as well** (`evidence-runtime.ts`, the poll's `if (fact !== null) bridgeSink.push(fact)`): `createRevertDetector` already pushes into the same sink (collectors/revert.ts, `cfg.sink.push(fact)` in `emit`). Same defect class as the git double push in R3.
7. **A1-8 also edits `packages/semantic-core/src/coordinator.test.ts`** to prove `agentCallIds` is part of `unitSignature` (a newly linked call bumps the unit version).
8. **A1-9 reconciles fixture `added`/`removed` counts with the real diffs and edits `packages/semantic-core/src/fixtures.test.ts`.** 20 of the 25 fixture `git_hunk` lines disagree with `git diff repo/<file> changes/<file>` today (for example oauth `src/auth/service.ts` says +7/−12, the files give +4/−13), so R3's validator check cannot pass without it. A probe on a copy of the repo showed the reconciled counts and canonical fact ids leave `@jevcode/semantic-core`, `@jevcode/ui-compiler`, `@jevcode/jev-router`, `jevcode-evals` and `jevcode-desktop` green. `scripts/fixture-diffs.mjs` therefore also stamps `turnId`/`callId`/`sourceCallId`, inserts the oauth `agent_reasoning` line and fixes the oauth failure text, so the fixture change is one reproducible command. The fixtures test gains one provenance assertion.
9. **A1-1 edits `docs/SPEC.md` §11** (store file modes), and **A1-3 edits §3.1b** (resume-budget failure is logged), so each behavior change ships with its documentation.
10. **SPEC §18 "replay UI".** D9 says the removal lands "in M1's PR"; the index assigns it to W0-1. A1-3 checks whether W0-1 already removed it and applies the index's exact edit only if it did not.
11. **A1-4 does not edit `evidence-runtime.test.ts`.** The pass-through is covered end to end by a `pipeline-runtime.test.ts` test that stores real facts; a mock-interaction test would add no coverage.
12. **The runtime stop row goes through `ingestRecord`, not a bare `appendAgentEvent`.** `ingestRecord` calls `appendAgentEvent` and also emits `agent:event`, writes the terminal line and applies the pause, while `stopping` is still false. The resume-budget failure keeps the bare `appendAgentEvent` the index specifies.

## Lane prerequisites

W0 (lane file 01) must be merged into `main`. A2 and B run in parallel with this lane and never touch its files.

- [ ] **Create the worktree from `main`** (it holds the W0 merge commit; A1 merges first in W1, so nothing else has landed yet):

```bash
cd /Users/jwpark/Projects/jevcode
git worktree add -b tv/a1-capture /Users/jwpark/Projects/jevcode-tv-a1 main
cd /Users/jwpark/Projects/jevcode-tv-a1
```

- [ ] **Verify the W0 contracts are present:**

```bash
grep -l "agent_interrupted" packages/contracts/src/agent-events.ts \
  && grep -l "export function canonicalJson" packages/contracts/src/canonical-json.ts \
  && grep -l "GitHunkDiffSchema" packages/contracts/src/evidence.ts \
  && grep -l "agentCallIds" packages/contracts/src/semantic.ts \
  && grep -l "JevPassSchema" packages/contracts/src/jev.ts \
  && grep -l 'case "agent_interrupted"' apps/desktop/src/renderer/components/WorkspaceHost.tsx
```

Expected: the six paths are printed and the command exits 0. If any path is missing, stop: W0 is not merged.

- [ ] **Install, build the native modules for Node, and build** (the W0 lane's setup recipe):

```bash
pnpm install --frozen-lockfile
NP=$(ls -d node_modules/.pnpm/node-pty@*/node_modules/node-pty | head -1) && mkdir -p "$NP/build/Release" && pnpm --filter jevcode-desktop rebuild:node && cp "$NP/prebuilds/$(node -p 'process.platform + "-" + process.arch')/spawn-helper" "$NP/build/Release/spawn-helper" && chmod +x "$NP/build/Release/spawn-helper"
pnpm -r build
```

Expected: each command exits 0; the second prints `better-sqlite3 loads under node ok`, `node-pty loads under node ok` and `native modules restored to node ABI`. A fresh worktree has no better-sqlite3 binary at all: without the second command every storage and desktop test fails with `Error: Could not locate the bindings file.` The `mkdir` and the `spawn-helper` copy are needed because `rebuild:node` copies `pty.node` into node-pty's `build/Release`, and node-pty then looks for `spawn-helper` beside it (without it every PTY test fails with `posix_spawnp failed.`).

- [ ] **Baseline:** `pnpm -r --no-bail --workspace-concurrency=1 test` exits 0. If the only failures are in agent-codex `src/stall-watchdog.test.ts` or `src/codex-adapter.test.ts`, or evidence-engine `src/collectors/file-watcher.test.ts` (pre-existing timing flakes, W0 Gotcha 3), rerun that package alone (`pnpm --filter @jevcode/agent-codex test` or `pnpm --filter @jevcode/evidence-engine test`); it must pass alone. Any other failure: record the failing package and stop.

## Global Constraints

Copied from the binding decision record and the interfaces index. Every task's requirements include this section.

- Node `>=22` (root `package.json` engines). `newId` relies on `globalThis.crypto.randomUUID()` (R6).
- Every new contract field is OPTIONAL. `rebuildSession` re-parses stored rows and throws on failure (packages/storage/src/db.ts, `parseWith`). Never add `.strict()`; never make a field required.
- `exitCode` stays `item.exit_code ?? -1` in capture (packages/agent-codex/src/jsonl.ts). The viewer renders `-1` as "unknown", never "failed" (R2).
- No SQL migration in v1: no new tables, columns or indexes; `LATEST_SCHEMA_VERSION` does not change (R5).
- R1: `openDb` creates `~/.jevcode` 0700 and `jevcode.db`, `-wal`, `-shm` 0600, with a POSIX-mode test. Lands as its own small PR before M1b.
- R2: optional `turnId` on every agent event (the adapter mints one per Codex process and passes it via `EventNormalizerContext`); optional `callId = ${turnId}:${item.id}` on `command_started`/`_completed`, `tool_started`/`_completed`, `file_changed`, `approval_requested`; `agent_reasoning {text, callId?}`; `agent_interrupted`; `sourceCallId` on `command_executed` and `test_result`, stamped by `observeCommand`/`observeTestOutput`; the resume-budget `agent_failed` is persisted via `appendAgentEvent` before the emit.
- D10: interrupt, steer and stop leave the session PAUSED and resumable, never failed. `agent_interrupted {reason: interrupt|steer|stop}` replaces the exit-time `agent_failed`.
- R3: `factContentId` hashes `canonicalJson(record)`; `ChangeUnit.agentCallIds` is filled by `clusterSession` and included in `unitSignature`; `git_hunk.diff = {hash (16 hex), bytes, text?, truncated, redactions, withheld?: "secret_path"|"not_captured"}` via an injected `prepareDiff` (default `withheld: "not_captured"`); the desktop implementation withholds `.env*`, `*.pem`, `*.key`, `id_rsa*`, redacts per line after the diff prefix (fix the `env_value` `^` anchor), caps at 32 KiB cut at the last `@@` hunk boundary; the git collector emits only when a file's diff hash changes; remove the double push; zod no-strip guard test (`canonicalJson(parse(x)) === canonicalJson(x)`); fixtures updated with `callId`/`sourceCallId`/`diff`/one `agent_reasoning` line; oauth failure text fixed ("expected null to be 7"); `validate-fixtures.mjs` checks diff `+`/`-` counts.
- R4 (M1c, does not block the viewer): `Decision.ts` optional; `JevDecisionLog.pass` `"A"|"B"` optional; guardrail suppressions logged with their real `clientKind`/confidence; graph node data gains domain ids; SPEC §4.1–4.3, §7, §8.5 and docs/spikes/codex-spike.md §3 updated across M1.
- D11: sessions recorded before M1 are not rewritten; no legacy-id resolver. The log stays append-only.
- All new npm dependencies and every `pnpm-lock.yaml` change happen in W0-1 only. This lane edits no `package.json`, no lockfile and no `eslint.config.mjs`. A task that needs a dependency stops and escalates.
- W1 file ownership: `apps/desktop/src/main/{ipc.ts, index.ts}` and `apps/desktop/src/shared/*` belong to lane A2; `packages/trace-viewer/**` belongs to lane B. This lane never edits them. `apps/desktop/src/main/pipeline/*` belongs to this lane only.
- Commits: conventional commit messages (`fix(storage): …`, `feat(agent-codex): …`). Never add `Claude-Session:` trailers. Use the repository's configured git identity. One commit per task, with the task's files listed explicitly in `git add`.
- Never run `git stash` (the stash stack is shared by all worktrees); set work aside with a WIP commit. Never `git checkout -- <file>`; to undo your own edit, edit the file back.
- Shell is zsh: write `${var}:suffix`, never `"$var:suffix"`, when a colon follows a variable.

**Gotchas (from index section 5, plus two found while verifying this plan):**

1. **Rebuild after editing a dependency.** Every workspace package exports only `./dist`. After changing a package, rebuild it before running a dependent's tests or typecheck. For desktop tests, `pnpm --filter "jevcode-desktop^..." build` rebuilds every dependency of `jevcode-desktop` (contracts, agent-*, evidence-engine, semantic-core, storage, jev-router, …). Desktop tests otherwise pass or fail against stale `dist`.
2. **Native modules.** If a storage or desktop test fails with `NODE_MODULE_VERSION`, `was compiled against a different Node.js version` or `Could not locate the bindings file`, or an agent-codex test fails with `posix_spawnp failed`, rerun the second command of the lane-prerequisites install block (it rebuilds better-sqlite3 and node-pty for Node and puts `spawn-helper` beside `pty.node`). Run the whole line: `rebuild:node` alone fails at its node-pty copy (`cp: …/node-pty/build/Release/pty.node: No such file or directory`) when `build/Release` does not exist yet.
3. **Desktop runtime tests that close the database must drain the coordinator first.** `PipelineCoordinator` debounces rebuilds by 25 ms; `stopSession` does not cancel that timer. A test that calls `db.close()` right after ingesting records can see vitest report `Errors  1 error` with `TypeError: The database connection is not open` from `StorageChangeUnitStore.all`. Call `await runtime.syncAll()` before `runtime.stopSession(...)` in every new test that closes the database.
4. **Root checks** (end of every task, in this order, each must exit 0): `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r test`, `pnpm lint`. Three pre-existing suites flake under load (agent-codex `src/stall-watchdog.test.ts` and `src/codex-adapter.test.ts`, evidence-engine `src/collectors/file-watcher.test.ts`; W0 Gotcha 3). If they are the only failures, rerun that package alone (`pnpm --filter @jevcode/agent-codex test` or `pnpm --filter @jevcode/evidence-engine test`, one retry); it must pass alone, and you name the flake in the task report. A1-3 edits `codex-adapter.test.ts`, so in A1-3 a failure there is real unless it also passes alone.
5. **Targeted tests:** `pnpm --filter <package> exec vitest run <path relative to the package>`. Vitest does not typecheck; a type-only change is proven red/green with `pnpm --filter <package> typecheck`.

## Review Focus

Five inputs this lane's producers meet in real use that the happy-path tests would not exercise, most likely first. Each has a pinning test in the owning task.

1. **Interrupt while a command runs, and Codex answers SIGINT with `turn.completed`** (a real `exec` reports `TurnStatus::Interrupted`, docs/spikes/codex-spike.md §4). Expected: exactly one `agent_interrupted {reason: "interrupt"}`, no `agent_completed`, no `agent_failed`, adapter state `paused`. Test: **A1-3** `codex-adapter.test.ts` "SIGINT during a command yields one agent_interrupted".
2. **The supervisor presses Stop in the app on a running session** (IPC `session:stop` → `runtime.stopSession` → `session-service.stopSession`). Expected: one `agent_interrupted {reason: "stop"}` row, stored state `paused`, `endedAt` null, execution claim kept, so the boot sweep keeps it resumable for 24 h. Tests: **A1-3** `pipeline-runtime.test.ts` "stopping a running session records one agent_interrupted and leaves it paused and resumable" and `session-guard.test.ts` "pauses a running session on stop and leaves it resumable".
3. **Secrets inside a stored diff:** a `+STRIPE_KEY=sk_live_…` line (the old `env_value` rule is anchored at `^` and misses it) and a `.env.local` file. Expected: the line is stored as `+STRIPE_KEY=[REDACTED:env_value]` with its prefix, `.env.local` stores no text (`withheld: "secret_path"`), `hash` is still the raw diff's. Tests: **A1-7** `redactor.test.ts` "redacts a prefixed env line inside a diff and keeps the prefix" and "withholds a secret path and stores no text".
4. **A dirty file that is reverted (leaves `git status`) and later edited back to the same content.** Expected: change-only emission emits it again on return, and an unchanged 5 s re-poll emits nothing. Test: **A1-6** `git.test.ts` "emits again for a file that left git status and came back unchanged" and "emits a file only when its diff changes".
5. **An existing install created by an older build:** `~/.jevcode` is 0755 and `jevcode.db`, `-wal`, `-shm` are 0644; another user points `JEVCODE_DB` into a shared 0755 directory. Expected: the store directory and all three files become owner-only on the next `openDb`, and a caller-chosen directory is never chmodded. Tests: **A1-1** `db.test.ts` "tightens an existing ~/.jevcode and its 0644 database files on open" and "never changes the mode of an existing directory it does not own by default".

---

## Tasks

Execution order is the task order below; each task depends on the one before it. A1-1 is M0; A1-2 to A1-4 are M1a; A1-5 to A1-9 are M1b; A1-10 and A1-11 are M1c.

### Task A1-1: M0, owner-only database files

**Files:**
- Modify: `packages/storage/src/db.ts` (the `node:fs` import on line 2, `defaultDbPath` at ~line 173, `openDb` at ~line 1523 at `144c7fb`; W0-5 moved lines above them, so find them by the quoted code)
- Modify: `docs/SPEC.md` §11
- Test: `packages/storage/src/db.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `openDb(options: OpenDbOptions = {}): JevcodeDb` and `defaultDbPath(): string`, signatures unchanged. New behavior: for a file-backed path, the parent directory is created 0700 when missing, `~/.jevcode` is chmodded 0700, the database file is created or chmodded 0600 before SQLite opens it, and existing `-wal`/`-shm` files are chmodded 0600 after migrations. `":memory:"`, `""` and `file:` URIs touch nothing on disk.

- [ ] **Step 1: Write the failing tests**

In `packages/storage/src/db.test.ts`, replace the first import block:

```ts
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
```

with:

```ts
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
```

Replace `import { describe, expect, it } from "vitest";` with `import { afterEach, describe, expect, it } from "vitest";`. (If W0-5 added names to either import, keep them.)

Append to the end of the file:

```ts
function modeOf(target: string): number {
  return statSync(target).mode & 0o777;
}

describe.skipIf(process.platform === "win32")("openDb file modes (POSIX)", () => {
  const roots: string[] = [];
  const makeRoot = (): string => {
    const root = mkdtempSync(path.join(os.tmpdir(), "jevcode-modes-"));
    roots.push(root);
    return root;
  };
  const savedHome = process.env.HOME;
  const savedDb = process.env.JEVCODE_DB;

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedDb === undefined) delete process.env.JEVCODE_DB;
    else process.env.JEVCODE_DB = savedDb;
    while (roots.length > 0) {
      const root = roots.pop();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates a missing parent directory 0700 and the db, -wal and -shm files 0600", () => {
    const dir = path.join(makeRoot(), "nested", "store");
    const dbPath = path.join(dir, "jevcode.db");
    const db = openDb({ dbPath });
    db.setPreference("probe", { v: 1 });
    expect(modeOf(dir)).toBe(0o700);
    expect(modeOf(dbPath)).toBe(0o600);
    expect(modeOf(`${dbPath}-wal`)).toBe(0o600);
    expect(modeOf(`${dbPath}-shm`)).toBe(0o600);
    db.close();
  });

  it("tightens an existing ~/.jevcode and its 0644 database files on open", () => {
    const home = makeRoot();
    process.env.HOME = home;
    delete process.env.JEVCODE_DB;
    const dataDir = path.join(home, ".jevcode");
    mkdirSync(dataDir, { mode: 0o755 });
    chmodSync(dataDir, 0o755);
    const dbPath = path.join(dataDir, "jevcode.db");
    const legacy = new Database(dbPath);
    legacy.pragma("journal_mode = WAL");
    legacy.exec("CREATE TABLE legacy (x INTEGER)");
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) chmodSync(file, 0o644);

    const db = openDb();
    expect(db.dbPath).toBe(dbPath);
    expect(modeOf(dataDir)).toBe(0o700);
    expect(modeOf(dbPath)).toBe(0o600);
    expect(modeOf(`${dbPath}-wal`)).toBe(0o600);
    expect(modeOf(`${dbPath}-shm`)).toBe(0o600);
    db.close();
    legacy.close();
  });

  it("never changes the mode of an existing directory it does not own by default", () => {
    const shared = makeRoot();
    chmodSync(shared, 0o755);
    const dbPath = path.join(shared, "custom.db");
    process.env.JEVCODE_DB = dbPath;
    const db = openDb();
    expect(modeOf(shared)).toBe(0o755);
    expect(modeOf(dbPath)).toBe(0o600);
    db.close();
  });

  it("still opens an in-memory database without touching the filesystem", () => {
    const cwdMarker = path.resolve(":memory:");
    const db = openDb({ dbPath: ":memory:" });
    db.setPreference("k", { v: 1 });
    expect(db.getPreference("k")).toEqual({ v: 1 });
    expect(existsSync(cwdMarker)).toBe(false);
    db.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @jevcode/storage exec vitest run src/db.test.ts`
Expected: FAIL. With the usual umask 022: "creates a missing parent directory…" and "tightens an existing ~/.jevcode…" fail with `expected 493 to be 448` (0o755 vs 0o700), "never changes the mode…" fails with `expected 420 to be 384` (0o644 vs 0o600); the in-memory test and every existing test pass.

- [ ] **Step 3: Implement owner-only modes in `packages/storage/src/db.ts`**

Replace `import { mkdirSync } from "node:fs";` with:

```ts
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
```

Replace:

```ts
export function defaultDbPath(): string {
  const override = process.env.JEVCODE_DB;
  if (override && override.length > 0) return override;
  return path.join(os.homedir(), ".jevcode", "jevcode.db");
}
```

with:

```ts
function defaultDataDir(): string {
  return path.join(os.homedir(), ".jevcode");
}

export function defaultDbPath(): string {
  const override = process.env.JEVCODE_DB;
  if (override && override.length > 0) return override;
  return path.join(defaultDataDir(), "jevcode.db");
}
```

Replace:

```ts
export function openDb(options: OpenDbOptions = {}): JevcodeDb {
  const dbPath = options.dbPath ?? defaultDbPath();
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return new JevcodeDb(dbPath, db);
}
```

with:

```ts
// The store holds prompts, agent output and diffs: owner-only access (R1).
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function isFileBackedPath(dbPath: string): boolean {
  return dbPath !== "" && dbPath !== ":memory:" && !dbPath.startsWith("file:");
}

// Creates the parent directory 0700 and the database file 0600 before SQLite
// opens it. SQLite creates -wal and -shm with the database file's mode.
function preparePrivateDbFile(dbPath: string): void {
  const dir = path.dirname(dbPath);
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  // Tighten ~/.jevcode even when an older build created it 0755. A directory
  // chosen by the caller (dbPath or JEVCODE_DB, e.g. /tmp) is never chmodded.
  if (path.resolve(dir) === path.resolve(defaultDataDir())) {
    chmodSync(dir, PRIVATE_DIR_MODE);
  }
  closeSync(openSync(dbPath, "a", PRIVATE_FILE_MODE));
  chmodSync(dbPath, PRIVATE_FILE_MODE);
}

// An older build may have left 0644 sidecars; they hold unflushed rows.
function tightenSidecars(dbPath: string): void {
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${dbPath}${suffix}`;
    if (existsSync(sidecar)) chmodSync(sidecar, PRIVATE_FILE_MODE);
  }
}

export function openDb(options: OpenDbOptions = {}): JevcodeDb {
  const dbPath = options.dbPath ?? defaultDbPath();
  const fileBacked = isFileBackedPath(dbPath);
  if (fileBacked) preparePrivateDbFile(dbPath);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  if (fileBacked) tightenSidecars(dbPath);
  return new JevcodeDb(dbPath, db);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @jevcode/storage exec vitest run src/db.test.ts`
Expected: PASS, 0 failed.

Run: `pnpm --filter @jevcode/storage test && pnpm --filter @jevcode/storage typecheck`
Expected: every storage test passes; typecheck exits 0.

- [ ] **Step 5: Document the modes in SPEC §11**

In `docs/SPEC.md`, replace:

```
SQLite, WAL mode, single file under `~/.jevcode/jevcode.db` (dev: repo-local `./.jevcode/`). better-sqlite3, synchronous for simplicity in main. The worker never writes.
```

with:

```
SQLite, WAL mode, single file under `~/.jevcode/jevcode.db` (dev: repo-local `./.jevcode/`). better-sqlite3, synchronous for simplicity in main. The worker never writes. The store holds prompts, agent output and diffs, so `openDb` creates `~/.jevcode` with mode 0700 (and tightens an existing one) and `jevcode.db`, `-wal` and `-shm` with mode 0600. A directory chosen through `dbPath` or `JEVCODE_DB` is created 0700 when missing but never chmodded.
```

- [ ] **Step 6: Root checks**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r test && pnpm lint`
Expected: every command exits 0.

- [ ] **Step 7: Commit, and mark the M0 PR head**

```bash
git add packages/storage/src/db.ts packages/storage/src/db.test.ts docs/SPEC.md
git commit -m "fix(storage): create the local store with owner-only file modes"
git branch tv/a1-m0-db-modes HEAD
```

`tv/a1-m0-db-modes` points at this commit so the controller can open R1's "separate small PR, before M1b" from it. Do not push; the controller decides.

---

### Task A1-2: M1a, per-process `turnId`, `callId` and `agent_reasoning`

**Files:**
- Modify: `packages/agent-core/src/events.ts` (`EventNormalizerContext`, lines 6-9)
- Test: `packages/agent-core/src/events.test.ts`
- Modify (whole file): `packages/agent-codex/src/jsonl.ts`
- Test: `packages/agent-codex/src/jsonl.test.ts`
- Modify: `packages/agent-codex/src/codex-adapter.ts` (imports ~line 17, `startSession` ~line 182, `spawnResume` ~line 435, `emit` ~line 617)
- Test: `packages/agent-codex/src/codex-adapter.test.ts`
- Modify: `docs/spikes/codex-spike.md` §3

**Interfaces:**
- Consumes (W0-4, `@jevcode/contracts`): `NormalizedAgentEventSchema` whose every variant has `turnId?: string`; `callId?: string` on `agent_reasoning`, `tool_started`, `tool_completed`, `command_started`, `command_completed`, `file_changed`, `approval_requested`; variant `{ type: "agent_reasoning"; sessionId; ts; turnId?; callId?; text: string }`. `newId(prefix: string): string` returns `${prefix}_${32 hex}`.
- Produces:
  - `packages/agent-core/src/events.ts`: `export interface EventNormalizerContext { sessionId: string; now: () => string; turnId?: string }`.
  - `packages/agent-codex/src/jsonl.ts`: `export function callIdFor(ctx: EventNormalizerContext, itemId: string | undefined): string | undefined` — `undefined` for a missing or empty id, `` `${ctx.turnId}:${itemId}` `` with a turn id, else `itemId`. `mapCodexJsonlEvent(raw, ctx)` stamps `turnId` (when `ctx.turnId` is set) on every event, `callId` on the six call variants and on `agent_reasoning`, and maps `reasoning` items to `agent_reasoning`. Keys are omitted, never set to `undefined`.
  - `CodexAdapter`: mints `newId("turn")` into `this.context.turnId` in `startSession` and before each `agent_started` in `spawnResume`; `emit` stamps the current `turnId` on any event that lacks one (adapter-emitted and transcript-fallback events).

- [ ] **Step 1: Write the failing context test**

In `packages/agent-core/src/events.test.ts`, replace:

```ts
  it("validates emitted events against the contracts schema", () => {
```

with:

```ts
  it("carries the adapter turn id from the context into mapped events", () => {
    const turnMapper: AgentEventMapper = (_raw, ctx) => [
      {
        type: "agent_completed",
        sessionId: ctx.sessionId,
        ts: ctx.now(),
        ...(ctx.turnId !== undefined ? { turnId: ctx.turnId } : {}),
      },
    ];
    const ctx = { ...defaultNormalizerContext("s1"), turnId: "turn_1" };
    const [event] = applyMappers({}, ctx, [turnMapper]);
    expect(validateNormalizedAgentEvent(event!)).toMatchObject({
      type: "agent_completed",
      turnId: "turn_1",
    });
    expect(defaultNormalizerContext("s1").turnId).toBeUndefined();
  });

  it("validates emitted events against the contracts schema", () => {
```

- [ ] **Step 2: Verify it fails the typecheck**

Run: `pnpm --filter @jevcode/agent-core typecheck`
Expected: FAIL with `error TS2339: Property 'turnId' does not exist on type 'EventNormalizerContext'.` (Vitest does not typecheck, so this is the red signal for a type change.)

- [ ] **Step 3: Add `turnId` to the context**

In `packages/agent-core/src/events.ts`, replace:

```ts
export interface EventNormalizerContext {
  sessionId: string;
  now: () => string;
}
```

with:

```ts
export interface EventNormalizerContext {
  sessionId: string;
  now: () => string;
  // Minted by the adapter once per agent process (exec or exec resume) and
  // stamped on every event that process produces. Absent in legacy callers.
  turnId?: string;
}
```

- [ ] **Step 4: Verify and rebuild agent-core**

Run: `pnpm --filter @jevcode/agent-core typecheck && pnpm --filter @jevcode/agent-core exec vitest run src/events.test.ts && pnpm --filter @jevcode/agent-core build`
Expected: typecheck exits 0; the test file passes (0 failed); build exits 0.

- [ ] **Step 5: Write the failing mapper tests**

In `packages/agent-codex/src/jsonl.test.ts` make five edits.

(a) Replace `import { extractCodexThreadId, mapCodexJsonlEvent } from "./jsonl.js";` with:

```ts
import { callIdFor, extractCodexThreadId, mapCodexJsonlEvent } from "./jsonl.js";
```

(b) Replace:

```ts
function parseFixture(name: string, sessionId = "s1") {
  const ctx = defaultNormalizerContext(sessionId);
```

with:

```ts
function parseFixture(name: string, sessionId = "s1", turnId?: string) {
  const ctx = {
    ...defaultNormalizerContext(sessionId),
    ...(turnId !== undefined ? { turnId } : {}),
  };
```

(c) Replace the whole test `it("maps the documented happy path exactly", () => { … });` (lines 49-76 of the file before edit (a); edit (b) adds three lines above it, so it now spans lines 52-79) with:

```ts
  it("maps the documented happy path exactly", () => {
    const events = parseFixture("documented-happy-path.jsonl", "s1", "turn_a");
    expect(events).toEqual([
      {
        type: "command_started",
        sessionId: "s1",
        turnId: "turn_a",
        callId: "turn_a:item_1",
        command: "bash -lc ls",
        ts: expect.any(String),
      },
      {
        type: "command_completed",
        sessionId: "s1",
        turnId: "turn_a",
        callId: "turn_a:item_1",
        command: "bash -lc ls",
        exitCode: 0,
        stdout: "docs\nsdk\nsrc",
        stderr: "",
        ts: expect.any(String),
      },
      {
        type: "agent_message",
        sessionId: "s1",
        turnId: "turn_a",
        role: "assistant",
        text: "Repo contains docs, sdk, and examples directories.",
        ts: expect.any(String),
      },
      { type: "agent_completed", sessionId: "s1", turnId: "turn_a", ts: expect.any(String) },
    ]);
  });

  it("omits turnId and uses the bare item id when the context has no turn", () => {
    const events = parseFixture("documented-happy-path.jsonl");
    expect(events.map((event) => "turnId" in event)).toEqual([false, false, false, false]);
    expect(events[0]).toMatchObject({ type: "command_started", callId: "item_1" });
    expect("callId" in events[2]!).toBe(false);
  });
```

(d) In the test "maps the documented tool-rich fixture: tools, files, approvals, todo ignored", replace the first entry of the expected `types` array, `"agent_message",` (the line right after `expect(types).toEqual([`), with `"agent_reasoning",`. The other nine entries stay.

(e) Replace:

```ts
  it("ignores unknown event types without failing", () => {
```

with:

```ts
  it("pairs each start and completion by callId and keeps reasoning out of messages", () => {
    const events = parseFixture("documented-tool-rich.jsonl", "s1", "turn_b");
    expect(events.every((event) => event.turnId === "turn_b")).toBe(true);
    const calls = events.map((event) => ("callId" in event ? event.callId : undefined));
    expect(calls).toEqual([
      "turn_b:item_2",
      "turn_b:item_5",
      "turn_b:item_5",
      "turn_b:item_6",
      "turn_b:item_6",
      "turn_b:item_8",
      "turn_b:item_8",
      "turn_b:item_10",
      undefined,
      undefined,
    ]);
    expect(events[0]).toMatchObject({
      type: "agent_reasoning",
      text: "Plan: update the rate limiter and add a Redis dependency.",
    });
    const messages = events.filter((event) => event.type === "agent_message");
    expect(messages.map((event) => (event.type === "agent_message" ? event.text : ""))).toEqual([
      "Rate limiter is now backed by Redis with fail-open on connection error.",
    ]);
  });

  it("builds call ids only from a non-empty item id", () => {
    const ctx = { ...defaultNormalizerContext("s1"), turnId: "turn_c" };
    expect(callIdFor(ctx, "item_9")).toBe("turn_c:item_9");
    expect(callIdFor(ctx, undefined)).toBeUndefined();
    expect(callIdFor(ctx, "")).toBeUndefined();
    expect(callIdFor(defaultNormalizerContext("s1"), "item_9")).toBe("item_9");
  });

  it("ignores unknown event types without failing", () => {
```

- [ ] **Step 6: Run the mapper tests to verify they fail**

Run: `pnpm --filter @jevcode/agent-codex exec vitest run src/jsonl.test.ts`
Expected: FAIL with five failed tests (`Failed Tests 5`). Vitest resolves the missing `callIdFor` export to `undefined`, so the file loads: "maps the documented happy path exactly" and "omits turnId and uses the bare item id…" fail on the missing ids, the tool-rich test fails with `expected [ 'agent_message', …(9) ] to deeply equal [ 'agent_reasoning', …(9) ]`, the pairing test fails with `expected false to be true`, and "builds call ids only from a non-empty item id" fails with `TypeError: callIdFor is not a function`. The other tests pass.

- [ ] **Step 7: Replace `packages/agent-codex/src/jsonl.ts`**

The changes against the current file: `callIdFor` and `callFields` are added; `mapCodexJsonlEvent` becomes a wrapper that stamps `turnId` over the old body (renamed `mapEvent`); `...callFields(ctx, item)` is spread into `command_started`, `tool_started`, `tool_completed`, `approval_requested`, `command_completed` and `file_changed`; the `reasoning` case returns `agent_reasoning` (it returned an assistant `agent_message`); the item parameters of `mapCommandCompleted`/`mapFileChange` become `CodexItem & …` so they carry `id`. Write the complete file:

```ts
import type { NormalizedAgentEvent } from "@jevcode/contracts";
import type { EventNormalizerContext } from "@jevcode/agent-core";

import { detectAuthFailure } from "./auth.js";

interface CodexCommandExecutionItem {
  command: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status: "in_progress" | "completed" | "failed" | "declined";
}

interface CodexFileChangeItem {
  changes: { path: string; kind: "add" | "delete" | "update" }[];
  status: string;
}

interface CodexMcpToolCallItem {
  server: string;
  tool: string;
  arguments?: unknown;
  result?: unknown;
  error?: { message?: string };
}

interface CodexItem {
  id: string;
  type: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  text?: string;
  changes?: { path: string; kind: "add" | "delete" | "update" }[];
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
}

interface CodexEvent {
  type: string;
  thread_id?: string;
  message?: string;
  item?: CodexItem;
  error?: { message?: string };
}

function parse(raw: unknown): CodexEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const event = raw as CodexEvent;
  if (typeof event.type !== "string") return null;
  return event;
}

export function extractCodexThreadId(raw: unknown): string | null {
  const event = parse(raw);
  if (event === null || event.type !== "thread.started") return null;
  return typeof event.thread_id === "string" && event.thread_id !== ""
    ? event.thread_id
    : null;
}

/**
 * Correlates the start and the completion of one Codex item:
 * `${turnId}:${item.id}` when the adapter minted a turn id, else the bare item
 * id. Codex item ids may restart per process, so the turn prefix keeps them
 * unique within a session. Returns undefined when the item has no id.
 */
export function callIdFor(
  ctx: EventNormalizerContext,
  itemId: string | undefined,
): string | undefined {
  if (itemId === undefined || itemId === "") return undefined;
  return ctx.turnId !== undefined ? `${ctx.turnId}:${itemId}` : itemId;
}

// Spread into a mapped event: the key is omitted, never set to undefined.
function callFields(
  ctx: EventNormalizerContext,
  item: CodexItem,
): { callId?: string } {
  const callId = callIdFor(ctx, item.id);
  return callId !== undefined ? { callId } : {};
}

export function mapCodexJsonlEvent(
  raw: unknown,
  ctx: EventNormalizerContext,
): NormalizedAgentEvent[] {
  const events = mapEvent(raw, ctx);
  const turnId = ctx.turnId;
  if (turnId === undefined) return events;
  return events.map((event) => ({ ...event, turnId }));
}

function mapEvent(
  raw: unknown,
  ctx: EventNormalizerContext,
): NormalizedAgentEvent[] {
  const event = parse(raw);
  if (event === null) return [];

  switch (event.type) {
    case "thread.started":
    case "turn.started":
    case "item.updated":
      return [];

    case "item.started":
      return mapItemStarted(event.item, ctx);

    case "item.completed":
      return mapItemCompleted(event.item, ctx);

    case "error": {
      const message = event.message ?? event.error?.message ?? "";
      const auth = detectAuthFailure(message);
      if (auth !== null) {
        return [
          {
            type: "agent_failed",
            sessionId: ctx.sessionId,
            error: auth.message,
            ts: ctx.now(),
          },
        ];
      }
      return [];
    }

    case "turn.completed":
      return [{ type: "agent_completed", sessionId: ctx.sessionId, ts: ctx.now() }];

    case "turn.failed": {
      const message = event.error?.message ?? "turn failed";
      const auth = detectAuthFailure(message);
      return [
        {
          type: "agent_failed",
          sessionId: ctx.sessionId,
          error: auth !== null ? auth.message : message,
          ts: ctx.now(),
        },
      ];
    }

    default:
      return [];
  }
}

function mapItemStarted(
  item: CodexItem | undefined,
  ctx: EventNormalizerContext,
): NormalizedAgentEvent[] {
  if (item === undefined) return [];
  switch (item.type) {
    case "command_execution": {
      const command = item.command ?? "";
      if (command === "") return [];
      return [
        {
          type: "command_started",
          sessionId: ctx.sessionId,
          ...callFields(ctx, item),
          command,
          ts: ctx.now(),
        },
      ];
    }
    case "mcp_tool_call": {
      const tool = mcpToolName(item);
      return [
        {
          type: "tool_started",
          sessionId: ctx.sessionId,
          ...callFields(ctx, item),
          tool,
          input: JSON.stringify(item.arguments ?? {}),
          ts: ctx.now(),
        },
      ];
    }
    default:
      return [];
  }
}

function mapItemCompleted(
  item: CodexItem | undefined,
  ctx: EventNormalizerContext,
): NormalizedAgentEvent[] {
  if (item === undefined) return [];
  switch (item.type) {
    case "command_execution":
      return mapCommandCompleted(item as CodexItem & CodexCommandExecutionItem, ctx);

    case "agent_message":
      return item.text !== undefined
        ? [
            {
              type: "agent_message",
              sessionId: ctx.sessionId,
              role: "assistant" as const,
              text: item.text,
              ts: ctx.now(),
            },
          ]
        : [];

    case "reasoning":
      return item.text !== undefined
        ? [
            {
              type: "agent_reasoning",
              sessionId: ctx.sessionId,
              ...callFields(ctx, item),
              text: item.text,
              ts: ctx.now(),
            },
          ]
        : [];

    case "file_change":
      return mapFileChange(item as CodexItem & CodexFileChangeItem, ctx);

    case "mcp_tool_call": {
      const call = item as CodexMcpToolCallItem;
      const output = call.result !== undefined
        ? JSON.stringify(call.result)
        : call.error !== undefined
          ? JSON.stringify(call.error)
          : "";
      return [
        {
          type: "tool_completed",
          sessionId: ctx.sessionId,
          ...callFields(ctx, item),
          tool: mcpToolName(item),
          output,
          ts: ctx.now(),
        },
      ];
    }

    case "todo_list":
    case "error":
    case "web_search":
    case "collab_tool_call":
      return [];

    default:
      return [];
  }
}

function mapCommandCompleted(
  item: CodexItem & CodexCommandExecutionItem,
  ctx: EventNormalizerContext,
): NormalizedAgentEvent[] {
  const command = item.command ?? "";
  if (command === "") return [];
  const output = item.aggregated_output ?? "";
  if (item.status === "declined") {
    return [
      {
        type: "approval_requested",
        sessionId: ctx.sessionId,
        ...callFields(ctx, item),
        command,
        rationale: output !== "" ? output : "command declined by codex approval policy",
        ts: ctx.now(),
      },
    ];
  }
  return [
    {
      type: "command_completed",
      sessionId: ctx.sessionId,
      ...callFields(ctx, item),
      command,
      // -1 means Codex reported no exit code; readers show it as unknown.
      exitCode: item.exit_code ?? -1,
      stdout: output,
      stderr: "",
      ts: ctx.now(),
    },
  ];
}

function mapFileChange(
  item: CodexItem & CodexFileChangeItem,
  ctx: EventNormalizerContext,
): NormalizedAgentEvent[] {
  if (item.status !== "completed") return [];
  const call = callFields(ctx, item);
  return item.changes
    .filter((change) => change.path !== "")
    .map((change) => ({
      type: "file_changed" as const,
      sessionId: ctx.sessionId,
      ...call,
      path: change.path,
      ts: ctx.now(),
    }));
}

function mcpToolName(item: CodexItem): string {
  const server = item.server ?? "";
  const tool = item.tool ?? "";
  return server !== "" ? `${server}.${tool}` : tool;
}
```

- [ ] **Step 8: Run the mapper tests to verify they pass**

Run: `pnpm --filter @jevcode/agent-codex exec vitest run src/jsonl.test.ts && pnpm --filter @jevcode/agent-codex typecheck`
Expected: PASS, 0 failed; typecheck exits 0.

- [ ] **Step 9: Write the failing adapter turn test**

In `packages/agent-codex/src/codex-adapter.test.ts`, replace:

```ts
  it("routes a structured decision through the steer resume relaunch", async () => {
```

with:

```ts
  it("stamps one turnId per Codex process on every event", async () => {
    const adapter = createAdapter();
    const { events, exited } = collect(adapter);
    const session = await adapter.startSession(sessionInput());
    await adapter.sendInstruction({
      id: "instr-turns",
      sessionId: session.sessionId,
      text: "then add a test",
      mode: "queue",
    });
    await exited;
    await waitFor(
      () => events.filter((e) => e.type === "agent_completed").length === 2,
      5000,
      "second turn completes",
    );

    const starts = events.filter((e) => e.type === "agent_started");
    expect(starts).toHaveLength(2);
    const [first, second] = starts.map((e) => e.turnId);
    expect(first).toMatch(/^turn_[0-9a-f]{32}$/);
    expect(second).toMatch(/^turn_[0-9a-f]{32}$/);
    expect(second).not.toBe(first);
    const secondStart = events.indexOf(starts[1]!);
    expect(events.slice(0, secondStart).every((e) => e.turnId === first)).toBe(true);
    expect(events.slice(secondStart).every((e) => e.turnId === second)).toBe(true);
  });

  it("routes a structured decision through the steer resume relaunch", async () => {
```

- [ ] **Step 10: Run it to verify it fails**

Run: `pnpm --filter @jevcode/agent-codex exec vitest run src/codex-adapter.test.ts -t "stamps one turnId"`
Expected: FAIL, `Tests  1 failed | 15 skipped (16)`, with `TypeError: .toMatch() expects to receive a string, but got undefined` (the adapter stamps no `turnId` yet). If every PTY test fails with `posix_spawnp failed.`, rerun the second command of the lane-prerequisites install block (Gotcha 2) and retry.

- [ ] **Step 11: Mint the turn id in the adapter**

In `packages/agent-codex/src/codex-adapter.ts`, make four edits.

(a) In the `@jevcode/contracts` import, replace:

```ts
import {
  NormalizedAgentEventSchema,
  type AgentDetection,
```

with:

```ts
import {
  NormalizedAgentEventSchema,
  newId,
  type AgentDetection,
```

(b) In `startSession`, replace:

```ts
      this.context = defaultNormalizerContext(sessionId);
```

with:

```ts
      this.context = { ...defaultNormalizerContext(sessionId), turnId: newId("turn") };
```

(c) In `spawnResume`, replace:

```ts
    this.state = "starting";
    this.emit({
      type: "agent_started",
      sessionId: this.sessionId,
      prompt: promptText,
      ts: this.now(),
    });
    this.spawnProcess(args, this.cwd, {});
```

with:

```ts
    this.state = "starting";
    // One turn per Codex process: every event of the relaunched process
    // carries the new turn id.
    this.context = { ...this.context, turnId: newId("turn") };
    this.emit({
      type: "agent_started",
      sessionId: this.sessionId,
      prompt: promptText,
      ts: this.now(),
    });
    this.spawnProcess(args, this.cwd, {});
```

(d) In `emit`, replace:

```ts
  private emit(event: NormalizedAgentEvent): NormalizedAgentEvent {
    const parsed = NormalizedAgentEventSchema.parse(event);
```

with:

```ts
  private emit(event: NormalizedAgentEvent): NormalizedAgentEvent {
    // Adapter-emitted and transcript-fallback events get the current turn id;
    // JSONL-mapped events already carry it (mapCodexJsonlEvent).
    const turnId = this.context?.turnId;
    const stamped =
      turnId !== undefined && event.turnId === undefined ? { ...event, turnId } : event;
    const parsed = NormalizedAgentEventSchema.parse(stamped);
```

- [ ] **Step 12: Run the agent-codex suite**

Run: `pnpm --filter @jevcode/agent-codex typecheck && pnpm --filter @jevcode/agent-codex test`
Expected: typecheck exits 0; every agent-codex test passes (0 failed).

- [ ] **Step 13: Update the mapping table in `docs/spikes/codex-spike.md` §3**

Replace:

```
Implemented in `packages/agent-codex/src/jsonl.ts` (`mapCodexJsonlEvent`).
```

with:

```
Implemented in `packages/agent-codex/src/jsonl.ts` (`mapCodexJsonlEvent`).
Every mapped event carries the adapter's `turnId` (one per `exec` or
`exec resume` process). Call events also carry `callId = ${turnId}:${item.id}`,
the same on an item's `item.started` and `item.completed`.
```

Replace these table rows:

```
| `item.started` `command_execution` | `command_started {command}` |
| `item.completed` `command_execution` (completed/failed) | `command_completed {command, exitCode: exit_code ?? -1, stdout: aggregated_output, stderr: ""}` |
| `item.completed` `command_execution` (declined) | `approval_requested {command, rationale: output or "declined by codex approval policy"}` |
| `item.started` `mcp_tool_call` | `tool_started {tool: server.tool, input: JSON(arguments)}` |
| `item.completed` `mcp_tool_call` | `tool_completed {tool: server.tool, output: JSON(result \| error)}` |
```

with:

```
| `item.started` `command_execution` | `command_started {command, callId}` |
| `item.completed` `command_execution` (completed/failed) | `command_completed {command, callId, exitCode: exit_code ?? -1, stdout: aggregated_output, stderr: ""}` (`-1` means Codex reported no exit code) |
| `item.completed` `command_execution` (declined) | `approval_requested {command, callId, rationale: output or "declined by codex approval policy"}` |
| `item.started` `mcp_tool_call` | `tool_started {tool: server.tool, callId, input: JSON(arguments)}` |
| `item.completed` `mcp_tool_call` | `tool_completed {tool: server.tool, callId, output: JSON(result \| error)}` |
```

Replace:

```
| `item.completed` `reasoning` | `agent_message {role: "assistant", text}` |
| `item.completed` `file_change` (completed) | one `file_changed {path}` per entry in `changes[]` |
```

with:

```
| `item.completed` `reasoning` | `agent_reasoning {text, callId}` (kept out of the conversation) |
| `item.completed` `file_change` (completed) | one `file_changed {path, callId}` per entry in `changes[]` |
```

- [ ] **Step 14: Root checks**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r test && pnpm lint`
Expected: every command exits 0.

- [ ] **Step 15: Commit**

```bash
git add packages/agent-core/src/events.ts packages/agent-core/src/events.test.ts \
  packages/agent-codex/src/jsonl.ts packages/agent-codex/src/jsonl.test.ts \
  packages/agent-codex/src/codex-adapter.ts packages/agent-codex/src/codex-adapter.test.ts \
  docs/spikes/codex-spike.md
git commit -m "feat(agent-codex): stamp turnId and callId on Codex events and map reasoning"
```

---

### Task A1-3: M1a, honest lifecycle (`agent_interrupted`, paused not failed, persisted resume-budget failure)

**Files:**
- Modify (whole file): `packages/agent-codex/test/fixtures/fake-codex.cjs`
- Modify: `packages/agent-codex/src/codex-adapter.ts` (imports, fields ~line 105, `interrupt` ~line 270, `deliverSteer` ~line 359, `spawnProcess` ~line 451, exit handler ~line 482, `dispatchEvent` ~line 567)
- Test: `packages/agent-codex/src/codex-adapter.test.ts` (tests at lines 190-203 and 218-255 change; two tests added)
- Test: `packages/agent-codex/src/delivery-queue.test.ts` (test "keeps queued instructions when interrupted", lines 186-197)
- Modify: `apps/desktop/src/main/pipeline/pipeline-runtime.ts` (`stopSession` ~line 423, `resume` ~line 457, `applyTerminalAgentState` ~line 757, `formatAgentEventForTerminal` ~line 1287)
- Modify: `apps/desktop/src/main/session-service.ts` (`stopSession`, lines 50-66)
- Test: `apps/desktop/src/main/pipeline/pipeline-runtime.test.ts`, `apps/desktop/src/main/pipeline/resume-budget.test.ts`, `apps/desktop/src/main/session-guard.test.ts`
- Modify: `docs/SPEC.md` §3.1, §3.1b, §10 (and §18 only if W0-1 left "replay UI" in it); `docs/spikes/codex-spike.md` §3, §4

**Interfaces:**
- Consumes: W0-4 `agent_interrupted` variant `{ type: "agent_interrupted"; sessionId: string; ts: string; turnId?: string; reason: AgentInterruptReason }` and `export type AgentInterruptReason = "interrupt" | "steer" | "stop"` from `@jevcode/contracts`. From A1-2: `this.context.turnId` in `CodexAdapter`, stamped by `emit`.
- Produces:
  - Adapter: after `interrupt()`, the process's first terminal signal (`turn.completed`, `turn.failed`, an auth `agent_failed`, or process exit) becomes exactly one `agent_interrupted {reason: "interrupt"}`; later terminal signals of that process are dropped; adapter state stays `paused`. `deliverSteer` emits `agent_interrupted {reason: "steer"}` (old turn id) before killing a running turn. `stop()` is unchanged.
  - Runtime: `stopSession(sessionId)` ingests `agent_interrupted {reason: "stop"}` when `agentState` is not `completed`/`failed`, then stores `paused` without `endedAt` and keeps the execution claim. `applyTerminalAgentState` maps `agent_interrupted` with reason `interrupt` or `stop` to `paused` (not ended); `steer` leaves the state. The resume-budget `agent_failed` is written with `db.appendAgentEvent` before the emit.
  - `session-service.ts` `stopSession(db, sessionId): SessionStatePayload`: `completed`/`failed` keep their state and get `endedAt`; every other state becomes `paused` with no `endedAt`.
  - Test fixture: `FAKE_CODEX_COMPLETE_ON_INTERRUPT=1` makes the first (non-resume) fake process emit `item.started` for `bash -lc pnpm test`, hold, and answer ^C/SIGINT with `turn.completed`, `turn.failed`, exit 1.

- [ ] **Step 1: Give the fake Codex an interrupt mode**

Replace `packages/agent-codex/test/fixtures/fake-codex.cjs` with the complete file below. Without the env var it behaves exactly as before (^C prints an `error` line and exits 1; runs complete after 300 ms).

```js
#!/usr/bin/env node
const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("codex-cli 0.155.1 (fake)\n");
  process.exit(0);
}

const emit = (event) => {
  process.stdout.write(JSON.stringify(event) + "\n");
};

const threadId = args[1] === "resume" ? args[2] : "fake-thread-123";
const prompt = args[args.length - 1];
// FAKE_CODEX_COMPLETE_ON_INTERRUPT=1: the first (non-resume) process starts a
// command and holds it open; ^C answers with turn.completed then turn.failed,
// the way a real exec reports TurnStatus::Interrupted, then exits 1.
const holdForInterrupt =
  process.env.FAKE_CODEX_COMPLETE_ON_INTERRUPT === "1" && args[1] !== "resume";

let interrupted = false;
function onInterrupt() {
  if (interrupted) return;
  interrupted = true;
  if (holdForInterrupt) {
    emit({
      type: "turn.completed",
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
    });
    emit({ type: "turn.failed", error: { message: "turn interrupted" } });
  } else {
    emit({ type: "error", message: "turn interrupted" });
  }
  process.exit(1);
}

process.on("SIGINT", onInterrupt);

emit({ type: "thread.started", thread_id: threadId });
emit({ type: "turn.started" });
if (holdForInterrupt) {
  emit({
    type: "item.started",
    item: { id: "item_cmd", type: "command_execution", command: "bash -lc pnpm test", status: "in_progress" },
  });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  if (chunk.includes("\u0003")) {
    onInterrupt();
    return;
  }
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim() === "") continue;
    emit({
      type: "item.completed",
      item: {
        id: "item_user",
        type: "agent_message",
        text: `echoed user input: ${line.trim()}`,
      },
    });
  }
});

setTimeout(() => {
  if (holdForInterrupt) return;
  if (args[1] === "resume") {
    emit({
      type: "item.completed",
      item: {
        id: "item_resume",
        type: "agent_message",
        text: `resumed thread ${threadId} with prompt: ${prompt}`,
      },
    });
  }
  emit({
    type: "item.completed",
    item: {
      id: "item_1",
      type: "agent_message",
      text: "Fake codex run complete.",
    },
  });
  emit({
    type: "turn.completed",
    usage: {
      input_tokens: 10,
      cached_input_tokens: 0,
      output_tokens: 5,
      reasoning_output_tokens: 0,
    },
  });
}, 300);

setTimeout(() => process.exit(0), holdForInterrupt ? 5000 : 900);
```

- [ ] **Step 2: Write the failing adapter tests**

In `packages/agent-codex/src/codex-adapter.test.ts`, replace the whole test:

```ts
  it("interrupt sends SIGINT-equivalent control and the session fails on exit", async () => {
    const adapter = createAdapter();
    const { events, exited } = collect(adapter);
    await adapter.startSession(sessionInput());
    await adapter.interrupt();
    expect(adapter.getState()).toBe("paused");

    const code = await exited;

    expect(code).toBe(1);
    expect(adapter.getState()).toBe("failed");
    const failed = events.find((e) => e.type === "agent_failed");
    expect(failed).toBeDefined();
  });
```

with:

```ts
  it("interrupt pauses the session and records one agent_interrupted on exit", async () => {
    const adapter = createAdapter();
    const { events, exited } = collect(adapter);
    await adapter.startSession(sessionInput());
    await adapter.interrupt();
    expect(adapter.getState()).toBe("paused");

    const code = await exited;

    expect(code).toBe(1);
    expect(adapter.getState()).toBe("paused");
    const interrupted = events.filter((e) => e.type === "agent_interrupted");
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]).toMatchObject({ type: "agent_interrupted", reason: "interrupt" });
    expect(events.some((e) => e.type === "agent_failed")).toBe(false);
  });

  it("SIGINT during a command yields one agent_interrupted", async () => {
    const adapter = new CodexAdapter({
      binPath: FAKE_BIN,
      env: { FAKE_CODEX_COMPLETE_ON_INTERRUPT: "1" },
    });
    openAdapters.push(adapter);
    const { events, exited } = collect(adapter);
    await adapter.startSession(sessionInput());
    await waitFor(
      () => events.some((e) => e.type === "command_started"),
      5000,
      "command running",
    );
    await adapter.interrupt();

    const code = await exited;

    expect(code).toBe(1);
    expect(events.map((e) => e.type)).toEqual([
      "agent_started",
      "command_started",
      "agent_interrupted",
    ]);
    expect(events[2]).toMatchObject({ reason: "interrupt", turnId: events[0]?.turnId });
    expect(adapter.getState()).toBe("paused");
  });

  it("a steer records agent_interrupted for the running turn before the relaunch", async () => {
    const adapter = new CodexAdapter({
      binPath: FAKE_BIN,
      env: { FAKE_CODEX_COMPLETE_ON_INTERRUPT: "1" },
    });
    openAdapters.push(adapter);
    const { events } = collect(adapter);
    const session = await adapter.startSession(sessionInput());
    await waitFor(
      () => events.some((e) => e.type === "command_started"),
      5000,
      "command running",
    );
    const status = await adapter.sendInstruction({
      id: "steer-1",
      sessionId: session.sessionId,
      text: "use fetch instead",
      mode: "steer",
    });
    expect(status).toBe("delivered");
    await waitFor(
      () => events.some((e) => e.type === "agent_completed"),
      5000,
      "relaunched turn completes",
    );

    const starts = events.filter((e) => e.type === "agent_started");
    const interrupted = events.filter((e) => e.type === "agent_interrupted");
    expect(starts).toHaveLength(2);
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]).toMatchObject({ reason: "steer", turnId: starts[0]?.turnId });
    expect(events.indexOf(interrupted[0]!)).toBeLessThan(events.indexOf(starts[1]!));
    expect(starts[1]?.turnId).not.toBe(starts[0]?.turnId);
    expect(events.some((e) => e.type === "agent_failed")).toBe(false);
  });
```

In the test "resumes an interrupted session by relaunching codex exec resume with the thread id", replace:

```ts
    const code = await exited;
    expect(code).toBe(1);
    await waitFor(() => adapter.getState() === "failed", 5000, "failed after interrupt");
```

with:

```ts
    const code = await exited;
    expect(code).toBe(1);
    await waitFor(
      () => events.some((e) => e.type === "agent_interrupted"),
      5000,
      "agent_interrupted after interrupt",
    );
    expect(adapter.getState()).toBe("paused");
```

and, at the end of the same test, replace:

```ts
    expect(events.filter((e) => e.type === "agent_started").length).toBe(2);
    expect(events.filter((e) => e.type === "agent_completed").length).toBe(1);
  });
```

with:

```ts
    expect(events.filter((e) => e.type === "agent_started").length).toBe(2);
    expect(events.filter((e) => e.type === "agent_completed").length).toBe(1);
    expect(events.filter((e) => e.type === "agent_interrupted").length).toBe(1);
    expect(events.some((e) => e.type === "agent_failed")).toBe(false);
  });
```

In `packages/agent-codex/src/delivery-queue.test.ts`, test "keeps queued instructions when interrupted", replace:

```ts
    await adapter.interrupt();
    await waitFor(() => adapter.getState() === "failed", 5000, "failed after interrupt");
    expect(events.some((e) => e.type === "agent_failed")).toBe(true);
```

with:

```ts
    await adapter.interrupt();
    await waitFor(
      () => events.some((e) => e.type === "agent_interrupted"),
      5000,
      "agent_interrupted after interrupt",
    );
    expect(adapter.getState()).toBe("paused");
    expect(events.some((e) => e.type === "agent_failed")).toBe(false);
```

- [ ] **Step 3: Run the adapter tests to verify they fail**

Run: `pnpm --filter @jevcode/agent-codex exec vitest run src/codex-adapter.test.ts src/delivery-queue.test.ts`
Expected: FAIL. "interrupt pauses the session…" fails with `expected 'failed' to be 'paused'`; "SIGINT during a command yields one agent_interrupted" fails on the type list (`agent_completed` or `agent_failed` in place of `agent_interrupted`); "a steer records agent_interrupted…" fails with `expected [] to have a length of 1 but got +0`; the resume and queue tests time out waiting for `agent_interrupted after interrupt`.

- [ ] **Step 4: Implement interrupt and steer reporting in `packages/agent-codex/src/codex-adapter.ts`**

(a) In the `@jevcode/contracts` import, replace:

```ts
  newId,
  type AgentDetection,
```

with:

```ts
  newId,
  type AgentDetection,
  type AgentInterruptReason,
```

(b) Replace:

```ts
  private stallTimer: NodeJS.Timeout | null = null;
  private stallNotified = false;
```

with:

```ts
  private stallTimer: NodeJS.Timeout | null = null;
  private stallNotified = false;
  // D10: the process that interrupt() signalled. Its first terminal signal
  // becomes one agent_interrupted; later ones are dropped.
  private interruptedProc: IPty | null = null;
  private interruptReported = false;
```

(c) In `interrupt()`, replace:

```ts
      this.write("\u0003");
      this.applyEvent("interrupted");
```

with:

```ts
      this.write("\u0003");
      this.interruptedProc = this.ptyProc;
      this.applyEvent("interrupted");
```

(d) In `deliverSteer`, replace:

```ts
    this.deliveredIds.add(id);
    this.terminateRunningProcess();
    this.spawnResume(text);
    return "delivered";
```

with:

```ts
    this.deliveredIds.add(id);
    if (this.ptyProc !== null && !this.terminalEventSeen) {
      // D10: the running turn ends because of the steer, not a failure.
      this.reportInterrupt("steer");
    }
    this.terminateRunningProcess();
    this.spawnResume(text);
    return "delivered";
```

(e) In `spawnProcess`, replace:

```ts
    this.terminalEventSeen = false;
    this.dataReceived = false;
```

with:

```ts
    this.terminalEventSeen = false;
    this.interruptedProc = null;
    this.interruptReported = false;
    this.dataReceived = false;
```

(f) In the `proc.onExit` handler, replace:

```ts
      if (!this.terminalEventSeen) {
        const authFailure = detectAuthFailure(this.lineBuffer);
```

with:

```ts
      if (!this.terminalEventSeen && this.interruptedProc === proc) {
        this.reportInterrupt("interrupt");
      } else if (!this.terminalEventSeen) {
        const authFailure = detectAuthFailure(this.lineBuffer);
```

(g) Replace:

```ts
  private dispatchEvent(event: NormalizedAgentEvent): void {
    const validated = this.emit(event);
```

with:

```ts
  private dispatchEvent(event: NormalizedAgentEvent): void {
    if (
      this.interruptedProc !== null &&
      (event.type === "agent_completed" || event.type === "agent_failed")
    ) {
      // D10: after interrupt() a real exec answers with turn.completed or
      // turn.failed; neither means the task finished or failed.
      this.reportInterrupt("interrupt");
      return;
    }
    const validated = this.emit(event);
```

(h) Replace:

```ts
  private scheduleAutoRelay(): void {
```

with:

```ts
  private reportInterrupt(reason: AgentInterruptReason): void {
    if (this.interruptReported) return;
    this.interruptReported = true;
    this.terminalEventSeen = true;
    this.emit({
      type: "agent_interrupted",
      sessionId: this.sessionId,
      reason,
      ts: this.now(),
    });
  }

  private scheduleAutoRelay(): void {
```

- [ ] **Step 5: Run the agent-codex suite and rebuild it**

Run: `pnpm --filter @jevcode/agent-codex typecheck && pnpm --filter @jevcode/agent-codex test && pnpm --filter @jevcode/agent-codex build`
Expected: typecheck exits 0; every agent-codex test passes (0 failed); build exits 0.

- [ ] **Step 6: Write the failing runtime and session-service tests**

In `apps/desktop/src/main/session-guard.test.ts`, replace:

```ts
  it("marks a running session completed on stop", () => {
    const db = createDb();
    db.setSessionState("sess_a", "running");
    const state = stopSession(db, "sess_a");
    expect(state.state).toBe("completed");
    db.close();
  });
```

with:

```ts
  it("pauses a running session on stop and leaves it resumable", () => {
    const db = createDb();
    db.setSessionState("sess_a", "running");
    db.setExecutionClaim("sess_a", "2026-09-28T10:00:00.000Z");
    const state = stopSession(db, "sess_a");
    expect(state.state).toBe("paused");
    expect(db.getSession("sess_a")?.state).toBe("paused");
    expect(db.getSession("sess_a")?.endedAt).toBeNull();
    expect(db.getSession("sess_a")?.executionClaimTs).toBe("2026-09-28T10:00:00.000Z");
    db.close();
  });

  it("keeps a session paused by the runtime paused", () => {
    const db = createDb();
    db.setSessionState("sess_a", "paused");
    expect(stopSession(db, "sess_a").state).toBe("paused");
    expect(db.getSession("sess_a")?.endedAt).toBeNull();
    db.close();
  });
```

In `apps/desktop/src/main/pipeline/resume-budget.test.ts`, replace:

```ts
    expect(collected.terminal).toContain(
      "[agent] failed: resume budget exhausted",
    );
```

with:

```ts
    expect(collected.terminal).toContain(
      "[agent] failed: resume budget exhausted",
    );

    // The failure is in the event log, not only on the renderer channel.
    const stored = db
      .listAgentEvents(sessionId)
      .filter((event) => event.type === "agent_failed");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ error: "resume budget exhausted", sessionId });
```

In `apps/desktop/src/main/pipeline/pipeline-runtime.test.ts`, in the test "preserves the failed terminal state when stopping a failed session", replace:

```ts
      await runtime.stopSession(sessionId);
      expect(db.getSession(sessionId)?.state).toBe("failed");
    } finally {
```

with:

```ts
      await runtime.stopSession(sessionId);
      expect(db.getSession(sessionId)?.state).toBe("failed");
      expect(
        db.listAgentEvents(sessionId).some((event) => event.type === "agent_interrupted"),
      ).toBe(false);
    } finally {
```

and append to the end of the file:

```ts
describe("PipelineRuntime honest lifecycle (D10)", () => {
  async function startScripted(
    name: string,
    entries: MockScriptEntry[],
  ): Promise<{
    db: JevcodeDb;
    runtime: PipelineRuntime;
    sessionId: string;
    terminal: string[];
  }> {
    const dir = path.join(repoRoot, `apps/desktop/.test-tmp/${name}`);
    rmSync(dir, { recursive: true, force: true });
    const db = createTempDb(dir);
    const sessionId = `sess-${name}`;
    db.upsertRepository({
      id: "repo-lifecycle",
      path: dir,
      gitRoot: dir,
      branch: "test",
      baseCommit: "test",
    });
    db.createSession({ id: sessionId, repoId: "repo-lifecycle", prompt: "demo" });
    const terminal: string[] = [];
    const { emit } = collectEmit();
    const runtime = new PipelineRuntime({
      db,
      emit,
      evidence: false,
      jevClient: new DegradeClient(),
      log: () => {},
      terminal: {
        data: (_sessionId, data) => {
          terminal.push(data);
        },
        ensure: () => {},
      },
    });
    await runtime.startSession({
      sessionId,
      repoId: "repo-lifecycle",
      repoPath: dir,
      prompt: "demo",
      agentMode: "mock",
      mockScript: { sessionId, repoPath: dir, cwd: dir, prompt: "demo", entries },
    });
    return { db, runtime, sessionId, terminal };
  }

  it("stopping a running session records one agent_interrupted and leaves it paused and resumable", async () => {
    const { db, runtime, sessionId, terminal } = await startScripted("stop-pauses", []);
    try {
      await waitFor(
        () => db.listAgentEvents(sessionId).some((event) => event.type === "agent_started"),
        8000,
        "agent_started stored",
      );
      // Drain the coordinator's debounced rebuild before the db closes.
      await runtime.syncAll();
      await runtime.stopSession(sessionId);

      const events = db.listAgentEvents(sessionId);
      const interrupted = events.filter((event) => event.type === "agent_interrupted");
      expect(interrupted).toHaveLength(1);
      expect(interrupted[0]).toMatchObject({ reason: "stop", sessionId });
      expect(events.some((event) => event.type === "agent_failed")).toBe(false);
      const stored = db.getSession(sessionId);
      expect(stored?.state).toBe("paused");
      expect(stored?.endedAt).toBeNull();
      expect(stored?.executionClaimTs).not.toBeNull();
      expect(terminal).toContain("[agent] stopped");
    } finally {
      db.close();
    }
  }, 30_000);

  it("an agent_interrupted from the adapter pauses the session without ending it", async () => {
    const { db, runtime, sessionId } = await startScripted("interrupt-pauses", [
      {
        kind: "agent",
        event: {
          type: "agent_interrupted",
          sessionId: "sess-interrupt-pauses",
          reason: "interrupt",
          ts: "2026-09-28T10:00:00.000Z",
        },
      },
    ]);
    try {
      await waitFor(
        () => db.getSession(sessionId)?.state === "paused",
        8000,
        "paused after agent_interrupted",
      );
      expect(db.getSession(sessionId)?.endedAt).toBeNull();
    } finally {
      await runtime.syncAll();
      await runtime.stopSession(sessionId);
      db.close();
    }
  }, 30_000);

  it("a steer interruption keeps the session state while the agent relaunches", async () => {
    const { db, runtime, sessionId } = await startScripted("steer-keeps-state", [
      {
        kind: "agent",
        event: {
          type: "agent_interrupted",
          sessionId: "sess-steer-keeps-state",
          reason: "steer",
          ts: "2026-09-28T10:00:00.000Z",
        },
      },
      {
        kind: "agent",
        event: {
          type: "agent_message",
          sessionId: "sess-steer-keeps-state",
          role: "assistant",
          text: "working on the steer",
          ts: "2026-09-28T10:00:01.000Z",
        },
      },
    ]);
    try {
      await waitFor(
        () => db.listAgentEvents(sessionId).some((event) => event.type === "agent_message"),
        8000,
        "message after steer",
      );
      expect(db.getSession(sessionId)?.state).not.toBe("paused");
      expect(db.getSession(sessionId)?.state).not.toBe("failed");
    } finally {
      await runtime.syncAll();
      await runtime.stopSession(sessionId);
      db.close();
    }
  }, 30_000);
});
```

- [ ] **Step 7: Run the desktop tests to verify they fail**

Run: `pnpm --filter "jevcode-desktop^..." build && pnpm --filter jevcode-desktop exec vitest run src/main/pipeline/pipeline-runtime.test.ts src/main/pipeline/resume-budget.test.ts src/main/session-guard.test.ts`
Expected: FAIL, 5 tests: both session-guard tests with `expected 'completed' to be 'paused'`; resume budget and "stopping a running session…" with `expected [] to have a length of 1 but got +0`; "an agent_interrupted from the adapter…" with `timed out waiting for paused after agent_interrupted`. "a steer interruption keeps the session state…" already passes; it guards the steer exception (Interface deviation 4).

- [ ] **Step 8: Implement the runtime lifecycle in `apps/desktop/src/main/pipeline/pipeline-runtime.ts`**

(a) In `stopSession`, replace:

```ts
  async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    session.stopping = true;
```

with:

```ts
  async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    // D10: stopping a live session pauses it (resumable). Record why before
    // `stopping` makes ingestRecord drop records.
    const pausing =
      session.agentState !== "completed" && session.agentState !== "failed";
    if (pausing) {
      this.ingestRecord(sessionId, {
        type: "agent_interrupted",
        sessionId,
        reason: "stop",
        ts: this.nowIso(),
      });
    }
    session.stopping = true;
```

(b) Further down in `stopSession`, replace:

```ts
    this.sessions.delete(sessionId);
    // Preserve a terminal state: a session that already failed or completed
    // keeps that state instead of being rewritten to "completed".
    const terminalState =
      session.agentState === "failed" || session.agentState === "completed"
        ? session.agentState
        : "completed";
    this.opts.db.setSessionState(sessionId, terminalState);
    this.opts.db.setSessionEnded(sessionId);
    this.opts.db.setExecutionClaim(sessionId, null);
    this.emitAgentState(session);
    this.emitSessionState(sessionId);
    this.log(`session ${sessionId} stopped (state ${terminalState})`);
  }
```

with:

```ts
    this.sessions.delete(sessionId);
    if (pausing) {
      // Paused, not ended: endedAt stays unset and the execution claim is
      // kept, so the boot sweep keeps the session resumable for 24 h.
      session.agentState = "paused";
      this.opts.db.setSessionState(sessionId, "paused");
    } else {
      // A session that already failed or completed keeps that state.
      this.opts.db.setSessionState(sessionId, session.agentState);
      this.opts.db.setSessionEnded(sessionId);
      this.opts.db.setExecutionClaim(sessionId, null);
    }
    this.emitAgentState(session);
    this.emitSessionState(sessionId);
    this.log(`session ${sessionId} stopped (state ${session.agentState})`);
  }
```

(c) In `resume`, replace:

```ts
      this.opts.db.setExecutionClaim(sessionId, null);
      this.opts.emit(MainToRendererChannels.agentEvent, {
        type: "agent_failed",
        sessionId,
        error: "resume budget exhausted",
        ts: this.nowIso(),
      });
```

with:

```ts
      this.opts.db.setExecutionClaim(sessionId, null);
      const failed: NormalizedAgentEvent = {
        type: "agent_failed",
        sessionId,
        error: "resume budget exhausted",
        ts: this.nowIso(),
      };
      // Persist first: the trace must show why the session ended. Not through
      // ingestRecord, which would rerun the terminal transition.
      this.opts.db.appendAgentEvent(sessionId, failed);
      this.opts.emit(MainToRendererChannels.agentEvent, failed);
```

(d) In `applyTerminalAgentState`, replace the end of the switch:

```ts
          this.emitAgentState(session);
          this.emitSessionState(session.sessionId);
        }
        break;
      default:
        break;
    }
  }

  private handleAgentExit
```

with:

```ts
          this.emitAgentState(session);
          this.emitSessionState(session.sessionId);
        }
        break;
      case "agent_interrupted":
        // D10: interrupt and stop pause the session; it is never failed or
        // ended. A steer relaunches the agent at once, so the state stays.
        if (event.reason !== "steer" && session.agentState !== "paused") {
          session.agentState = "paused";
          this.opts.db.setSessionState(session.sessionId, "paused");
          this.emitAgentState(session);
          this.emitSessionState(session.sessionId);
        }
        break;
      default:
        break;
    }
  }

  private handleAgentExit
```

(e) In `formatAgentEventForTerminal`, replace:

```ts
    case "agent_failed":
      return `[agent] failed: ${event.error}`;
    case "approval_requested":
```

with:

```ts
    case "agent_failed":
      return `[agent] failed: ${event.error}`;
    case "agent_interrupted":
      return event.reason === "stop"
        ? "[agent] stopped"
        : event.reason === "steer"
          ? "[agent] redirected"
          : "[agent] paused";
    case "approval_requested":
```

- [ ] **Step 9: Stop overwriting a paused session in `apps/desktop/src/main/session-service.ts`**

In `stopSession`, replace:

```ts
  db.setSessionEnded(sessionId);
  // Preserve a terminal state: a session that already failed or completed
  // keeps that state instead of being rewritten to "completed".
  const terminalState =
    session.state === "failed" || session.state === "completed"
      ? session.state
      : "completed";
  db.setSessionState(sessionId, terminalState);
  return buildSessionState(db, sessionId);
```

with:

```ts
  if (session.state === "failed" || session.state === "completed") {
    // A session that already ended keeps its terminal state.
    db.setSessionEnded(sessionId);
    return buildSessionState(db, sessionId);
  }
  // D10: stop pauses a live session. It stays resumable: no endedAt, and the
  // execution claim is kept for the boot sweep's 24 h window.
  db.setSessionState(sessionId, "paused");
  return buildSessionState(db, sessionId);
```

- [ ] **Step 10: Run the desktop tests to verify they pass**

Run: `pnpm --filter jevcode-desktop typecheck && pnpm --filter jevcode-desktop exec vitest run src/main/pipeline/pipeline-runtime.test.ts src/main/pipeline/resume-budget.test.ts src/main/session-guard.test.ts`
Expected: typecheck exits 0; all three files pass, 0 failed, no `Errors` line.

Run: `pnpm --filter jevcode-desktop test`
Expected: every desktop test passes and the summary has no `Errors  1 error` line (see Gotcha 3 if it does).

- [ ] **Step 11: Document the lifecycle in SPEC and the spike**

In `docs/SPEC.md` §3.1, in the "Interrupt/resume?" row, replace the sentence:

```
v0 mechanism: interrupt() ends the turn.
```

with:

```
v0 mechanism: interrupt() ends the turn and **pauses** the session (resumable, never failed): the process's first terminal signal (`turn.completed`, `turn.failed` or exit) becomes one `agent_interrupted {reason: "interrupt"}` event and later ones are dropped. A steer records `agent_interrupted {reason: "steer"}` for the running turn before the relaunch. Stopping a live session records `agent_interrupted {reason: "stop"}` and leaves it `paused`, with no `endedAt` and its execution claim kept (§3.1b).
```

In §3.1b, replace:

```
- Resume budget: `resume_attempts` increments per resume. At ≥3 the session fails with "resume budget exhausted" (prevents crash-loops, as in OpenCode's resume counter).
```

with:

```
- Resume budget: `resume_attempts` increments per resume. At ≥3 the session fails with "resume budget exhausted" (prevents crash-loops, as in OpenCode's resume counter). The `agent_failed` event is written to the event log before it is sent to the renderer.
```

In §10, replace:

```
Codex adapter responsibilities: PTY lifecycle, JSONL parse (or transcript normalization fallback), event mapping (spike artifact), approval flow, interrupt/resume, and exit handling. Plus auth error surfacing (missing login → surface actionable FailureAnalysis instead of silent hang).
```

with:

```
Codex adapter responsibilities: PTY lifecycle, JSONL parse (or transcript normalization fallback), event mapping (spike artifact), approval flow, interrupt/resume, and exit handling. Plus auth error surfacing (missing login → surface actionable FailureAnalysis instead of silent hang).

Each Codex process (`exec` or `exec resume`) is one turn: the adapter mints a `turnId` (`turn_<32 hex>`) and stamps it on every event of that process. Call events carry `callId = ${turnId}:${item.id}`, shared by a call's start and completion, and `reasoning` items map to `agent_reasoning`. Interrupt, steer and stop emit `agent_interrupted` instead of `agent_failed` (§3.1). A missing Codex exit code is stored as `-1` and means unknown.
```

Check §18: run `grep -c "Plus replay UI" docs/SPEC.md`. Expected `0` (W0-1 removed it). If it prints `1`, apply W0-1's exact §18 edit (lane 01, W0-1 Step 11): replace `Plus replay UI, team features, and Windows/Linux packaging` with `Plus team features and Windows/Linux packaging` in that sentence, and append this sentence to the end of the §18 paragraph:

```text
The read-only trace viewer (`docs/superpowers/specs/2026-09-28-trace-viewer-design.md`) supersedes the deferred replay UI item (plan-owner sign-off under IMPLEMENTATION-PLAN risk R8; design decision D9).
```

In `docs/spikes/codex-spike.md` §3, replace the row:

```
| process exit without a terminal event | `agent_failed {error: "codex exited with code N"}` (adapter) |
```

with:

```
| `turn.completed` / `turn.failed` after `interrupt()` | one `agent_interrupted {reason: "interrupt"}` (adapter); later terminal events of that process are dropped |
| process exit without a terminal event | `agent_failed {error: "codex exited with code N"}` (adapter), or `agent_interrupted {reason: "interrupt"}` when `interrupt()` signalled that process |
```

In §4, replace:

```
  (SIGINT), which terminates the current turn. The session then ends with exit
  code 1 and the adapter emits `agent_failed`. `resume()`,
```

with:

```
  (SIGINT), which terminates the current turn. The process then exits with
  code 1, and the adapter emits one `agent_interrupted {reason: "interrupt"}`
  instead of `agent_failed`: the session is paused, not failed (D10). `resume()`,
```

- [ ] **Step 12: Root checks**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r test && pnpm lint`
Expected: every command exits 0.

- [ ] **Step 13: Commit**

```bash
git add packages/agent-codex/test/fixtures/fake-codex.cjs \
  packages/agent-codex/src/codex-adapter.ts packages/agent-codex/src/codex-adapter.test.ts \
  packages/agent-codex/src/delivery-queue.test.ts \
  apps/desktop/src/main/pipeline/pipeline-runtime.ts \
  apps/desktop/src/main/pipeline/pipeline-runtime.test.ts \
  apps/desktop/src/main/pipeline/resume-budget.test.ts \
  apps/desktop/src/main/session-service.ts apps/desktop/src/main/session-guard.test.ts \
  docs/SPEC.md docs/spikes/codex-spike.md
git commit -m "fix(agent-codex): record interrupt, steer and stop as agent_interrupted and keep the session paused"
```

---

### Task A1-4: M1a, `sourceCallId` on command and test facts

**Files:**
- Modify: `packages/evidence-engine/src/collectors/commands.ts` (`CommandCollector.observe`, lines 33 and 49-63)
- Modify: `packages/evidence-engine/src/collectors/tests.ts` (`TestCollector.collect`, lines 201 and 215-231)
- Test: `packages/evidence-engine/src/collectors/commands.test.ts`, `packages/evidence-engine/src/collectors/tests.test.ts`
- Modify: `apps/desktop/src/main/pipeline/evidence-runtime.ts` (`EvidenceSession`, lines 31-32 and 142-147)
- Modify: `apps/desktop/src/main/pipeline/pipeline-runtime.ts` (`observeAgentEventForEvidence`, ~line 744)
- Test: `apps/desktop/src/main/pipeline/pipeline-runtime.test.ts`

**Interfaces:**
- Consumes: W0-4 `command_executed` and `test_result` variants with `sourceCallId?: string` (min length 1). From A1-2: `command_completed.callId?: string`.
- Produces (exact, from index section 2.4):
  - `CommandCollector.observe(command: string, exitCode: number, sourceCallId?: string): EvidenceFact | null`
  - `TestCollector.collect(text: string, command: string, runner?: TestRunnerName, sourceCallId?: string): EvidenceFact | null`
  - `EvidenceSession.observeCommand(command: string, exitCode: number, sourceCallId?: string): void`
  - `EvidenceSession.observeTestOutput(command: string, output: string, sourceCallId?: string): void`
  - `observeAgentEventForEvidence` passes `event.callId`. The fact key is omitted when there is no call id (or it is empty).

- [ ] **Step 1: Write the failing collector tests**

In `packages/evidence-engine/src/collectors/commands.test.ts`, replace:

```ts
  it("skips empty commands", () => {
```

with:

```ts
  it("stamps the agent call id as sourceCallId", () => {
    const collector = createCommandCollector("/repo", opts);
    const fact = collector.observe("pnpm test", 1, "turn_a:item_7");
    expect(fact).toMatchObject({ type: "command_executed", sourceCallId: "turn_a:item_7" });
  });

  it("omits sourceCallId when there is no call id", () => {
    const collector = createCommandCollector("/repo", opts);
    const fact = collector.observe("pnpm test", 0);
    expect(fact).not.toBeNull();
    expect("sourceCallId" in fact!).toBe(false);
  });

  it("skips empty commands", () => {
```

In `packages/evidence-engine/src/collectors/tests.test.ts`, replace:

```ts
  it("does not emit for unparseable output", () => {
```

with:

```ts
  it("stamps the agent call id as sourceCallId", () => {
    const collector = createTestCollector("/repo", {
      repoId: "repo-1",
      sessionId: "sess-1",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    const fact = collector.collect(VITEST_OUTPUT, "pnpm test", undefined, "turn_a:item_7");
    expect(fact).toMatchObject({
      type: "test_result",
      runner: "vitest",
      failed: 1,
      sourceCallId: "turn_a:item_7",
    });
    const plain = collector.collect(VITEST_OUTPUT, "pnpm test");
    expect("sourceCallId" in plain!).toBe(false);
  });

  it("does not emit for unparseable output", () => {
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @jevcode/evidence-engine exec vitest run src/collectors/commands.test.ts src/collectors/tests.test.ts`
Expected: FAIL, 2 tests ("stamps the agent call id as sourceCallId" in each file), each with `expected { type: '…', …(…) } to match object { …, sourceCallId: 'turn_a:item_7' }`.

- [ ] **Step 3: Stamp `sourceCallId` in the collectors**

In `packages/evidence-engine/src/collectors/commands.ts`, replace:

```ts
  observe(command: string, exitCode: number): EvidenceFact | null;
  observeAll
```

with:

```ts
  // sourceCallId: the agent call that ran the command (command_completed.callId).
  observe(command: string, exitCode: number, sourceCallId?: string): EvidenceFact | null;
  observeAll
```

and replace:

```ts
    observe(command: string, exitCode: number): EvidenceFact | null {
      const trimmed = command.trim();
      if (!trimmed) return null;
      const fact: EvidenceFact = {
        type: "command_executed",
        repoId: ctx.repoId,
        sessionId: ctx.sessionId,
        command: trimmed,
        exitCode,
        isDestructive: classifyDestructive(trimmed),
        ts: cfg.now(),
      };
```

with:

```ts
    observe(command: string, exitCode: number, sourceCallId?: string): EvidenceFact | null {
      const trimmed = command.trim();
      if (!trimmed) return null;
      const fact: EvidenceFact = {
        type: "command_executed",
        repoId: ctx.repoId,
        sessionId: ctx.sessionId,
        command: trimmed,
        exitCode,
        isDestructive: classifyDestructive(trimmed),
        ...(sourceCallId !== undefined && sourceCallId !== "" ? { sourceCallId } : {}),
        ts: cfg.now(),
      };
```

In `packages/evidence-engine/src/collectors/tests.ts`, replace:

```ts
  collect(text: string, command: string, runner?: TestRunnerName): EvidenceFact | null;
}
```

with:

```ts
  // sourceCallId: the agent call whose output this is (command_completed.callId).
  collect(
    text: string,
    command: string,
    runner?: TestRunnerName,
    sourceCallId?: string,
  ): EvidenceFact | null;
}
```

and replace:

```ts
    collect(text: string, command: string, runner?: TestRunnerName): EvidenceFact | null {
      const parsed = parseTestOutput(text, runner);
      if (!parsed) return null;
      const fact: EvidenceFact = {
        type: "test_result",
        repoId: ctx.repoId,
        sessionId: ctx.sessionId,
        runner: parsed.runner,
        command,
        passed: parsed.passed,
        failed: parsed.failed,
        skipped: parsed.skipped,
        failures: parsed.failures,
        ts: cfg.now(),
      };
```

with:

```ts
    collect(
      text: string,
      command: string,
      runner?: TestRunnerName,
      sourceCallId?: string,
    ): EvidenceFact | null {
      const parsed = parseTestOutput(text, runner);
      if (!parsed) return null;
      const fact: EvidenceFact = {
        type: "test_result",
        repoId: ctx.repoId,
        sessionId: ctx.sessionId,
        runner: parsed.runner,
        command,
        passed: parsed.passed,
        failed: parsed.failed,
        skipped: parsed.skipped,
        failures: parsed.failures,
        ...(sourceCallId !== undefined && sourceCallId !== "" ? { sourceCallId } : {}),
        ts: cfg.now(),
      };
```

- [ ] **Step 4: Run the collector tests and rebuild evidence-engine**

Run: `pnpm --filter @jevcode/evidence-engine exec vitest run src/collectors/commands.test.ts src/collectors/tests.test.ts && pnpm --filter @jevcode/evidence-engine typecheck && pnpm --filter @jevcode/evidence-engine build`
Expected: PASS, 0 failed; typecheck and build exit 0.

- [ ] **Step 5: Write the failing end-to-end runtime test**

In `apps/desktop/src/main/pipeline/pipeline-runtime.test.ts`, replace `import { readFileSync, rmSync } from "node:fs";` with `import { mkdirSync, readFileSync, rmSync } from "node:fs";` and append to the end of the file:

```ts
describe("PipelineRuntime evidence provenance (R2)", () => {
  it("stamps a command completion's callId on its command_executed and test_result facts", async () => {
    const dir = path.join(repoRoot, "apps/desktop/.test-tmp/source-call-id");
    rmSync(dir, { recursive: true, force: true });
    const db = createTempDb(dir);
    // The evidence session watches repoPath; keep the database out of it.
    const repoDir = path.join(dir, "repo");
    mkdirSync(repoDir, { recursive: true });
    const sessionId = "sess-source-call";
    db.upsertRepository({
      id: "repo-source-call",
      path: repoDir,
      gitRoot: repoDir,
      branch: "test",
      baseCommit: "test",
    });
    db.createSession({ id: sessionId, repoId: "repo-source-call", prompt: "demo" });
    const { emit } = collectEmit();
    const runtime = new PipelineRuntime({
      db,
      emit,
      jevClient: new DegradeClient(),
      log: () => {},
    });
    await runtime.startSession({
      sessionId,
      repoId: "repo-source-call",
      repoPath: repoDir,
      prompt: "demo",
      agentMode: "mock",
      mockScript: {
        sessionId,
        repoPath: repoDir,
        cwd: repoDir,
        prompt: "demo",
        entries: [
          {
            kind: "agent",
            event: {
              type: "command_completed",
              sessionId,
              callId: "turn_a:item_7",
              command: "pnpm test",
              exitCode: 1,
              stdout: "Test Files  1 failed (1)\nTests  1 failed | 2 passed (3)\n",
              stderr: "",
              ts: "2026-09-28T10:00:00.000Z",
            },
          },
        ],
      },
    });
    try {
      const facts = (): EvidenceFact[] =>
        db
          .listEvents(sessionId)
          .filter((event) => event.type === "evidence_fact")
          .map((event) => JSON.parse(event.payloadJson) as EvidenceFact);
      await waitFor(
        () => facts().some((fact) => fact.type === "test_result"),
        8000,
        "test_result fact stored",
      );
      // Drain the coordinator's debounced rebuild before the db closes.
      await runtime.syncAll();
      expect(facts().find((fact) => fact.type === "command_executed")).toMatchObject({
        command: "pnpm test",
        exitCode: 1,
        sourceCallId: "turn_a:item_7",
      });
      expect(facts().find((fact) => fact.type === "test_result")).toMatchObject({
        runner: "vitest",
        passed: 2,
        failed: 1,
        sourceCallId: "turn_a:item_7",
      });
    } finally {
      await runtime.stopSession(sessionId);
      db.close();
    }
  }, 30_000);
});
```

This runtime has the evidence session enabled (no `evidence: false`), so the real command and test collectors run and the facts go through storage; it also proves storage keeps `sourceCallId`.

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter "jevcode-desktop^..." build && pnpm --filter jevcode-desktop exec vitest run src/main/pipeline/pipeline-runtime.test.ts -t "stamps a command completion"`
Expected: FAIL with `expected { type: 'command_executed', …(6) } to match object { command: 'pnpm test', exitCode: 1, sourceCallId: 'turn_a:item_7' }`.

- [ ] **Step 7: Pass the call id through the desktop pipeline**

In `apps/desktop/src/main/pipeline/evidence-runtime.ts`, replace:

```ts
  observeCommand(command: string, exitCode: number): void;
  observeTestOutput(command: string, output: string): void;
```

with:

```ts
  // sourceCallId: command_completed.callId of the agent call (R2).
  observeCommand(command: string, exitCode: number, sourceCallId?: string): void;
  observeTestOutput(command: string, output: string, sourceCallId?: string): void;
```

and replace:

```ts
    observeCommand(command: string, exitCode: number): void {
      commandCollector.observe(command, exitCode);
    },
    observeTestOutput(command: string, output: string): void {
      testCollector.collect(output, command);
    },
```

with:

```ts
    observeCommand(command: string, exitCode: number, sourceCallId?: string): void {
      commandCollector.observe(command, exitCode, sourceCallId);
    },
    observeTestOutput(command: string, output: string, sourceCallId?: string): void {
      testCollector.collect(output, command, undefined, sourceCallId);
    },
```

In `apps/desktop/src/main/pipeline/pipeline-runtime.ts` (`observeAgentEventForEvidence`), replace:

```ts
    if (event.type === "command_completed") {
      session.evidence.observeCommand(event.command, event.exitCode);
      if (event.stdout.trim().length > 0) {
        session.evidence.observeTestOutput(event.command, event.stdout);
      }
    }
```

with:

```ts
    if (event.type === "command_completed") {
      session.evidence.observeCommand(event.command, event.exitCode, event.callId);
      if (event.stdout.trim().length > 0) {
        session.evidence.observeTestOutput(event.command, event.stdout, event.callId);
      }
    }
```

- [ ] **Step 8: Run the desktop tests to verify they pass**

Run: `pnpm --filter jevcode-desktop typecheck && pnpm --filter jevcode-desktop exec vitest run src/main/pipeline/pipeline-runtime.test.ts src/main/pipeline/evidence-runtime.test.ts`
Expected: typecheck exits 0; both files pass, 0 failed, no `Errors` line.

- [ ] **Step 9: Root checks**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r test && pnpm lint`
Expected: every command exits 0.

- [ ] **Step 10: Commit**

```bash
git add packages/evidence-engine/src/collectors/commands.ts \
  packages/evidence-engine/src/collectors/commands.test.ts \
  packages/evidence-engine/src/collectors/tests.ts \
  packages/evidence-engine/src/collectors/tests.test.ts \
  apps/desktop/src/main/pipeline/evidence-runtime.ts \
  apps/desktop/src/main/pipeline/pipeline-runtime.ts \
  apps/desktop/src/main/pipeline/pipeline-runtime.test.ts
git commit -m "feat(evidence-engine): stamp sourceCallId on command and test facts"
```

---

### Task A1-5: M1b, canonical `factContentId` and the zod no-strip guards

**Files:**
- Modify: `packages/semantic-core/src/ids.ts` (lines 1 and 11-13)
- Create: `packages/semantic-core/src/ids.test.ts`
- Test: `packages/semantic-core/src/fixtures.test.ts` (no-strip guard over `fixtures/*/events.jsonl`)
- Create: `packages/agent-codex/src/no-strip.test.ts`
- Create: `packages/evidence-engine/src/no-strip.test.ts`

**Interfaces:**
- Consumes: W0-3 `export function canonicalJson(value: unknown): string` from `@jevcode/contracts` (keys sorted at every depth, `undefined` dropped, throws `TypeError` for `undefined`). A1-2's `mapCodexJsonlEvent`; A1-4's collector signatures.
- Produces: `packages/semantic-core/src/ids.ts`: `export function factContentId(sessionId: string, record: unknown): string` returns `hashId("fact", sessionId, canonicalJson(record))`. Signature unchanged. Lane A2's `trace-service` calls it on the stored (zod-ordered) payload and must get the id the coordinator gave the collector-ordered fact.

- [ ] **Step 1: Write the failing id test**

Create `packages/semantic-core/src/ids.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { EvidenceFactSchema, type EvidenceFact } from "@jevcode/contracts";

import { factContentId, hashId } from "./ids.js";

describe("factContentId", () => {
  it("gives a collector-order fact and its zod-parsed copy one id", () => {
    // Collectors put ts last; EvidenceFactSchema moves it to fourth.
    const collected: EvidenceFact = {
      type: "git_hunk",
      repoId: "repo-1",
      sessionId: "sess-1",
      file: "src/app.ts",
      added: 3,
      removed: 1,
      isFormattingOnly: false,
      isConfigOnly: false,
      isLockfile: false,
      ts: "2026-09-28T10:00:00.000Z",
    };
    const stored = EvidenceFactSchema.parse(collected);
    expect(JSON.stringify(stored)).not.toBe(JSON.stringify(collected));
    expect(factContentId("sess-1", stored)).toBe(factContentId("sess-1", collected));
  });

  it("hashes the canonical JSON of the record", () => {
    expect(factContentId("sess-1", { b: 1, a: { d: 2, c: 3 } })).toBe(
      hashId("fact", "sess-1", '{"a":{"c":3,"d":2},"b":1}'),
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @jevcode/semantic-core exec vitest run src/ids.test.ts`
Expected: FAIL, 2 tests, each with `expected 'fact_…' to be 'fact_…'` (the key order changes today's hash).

- [ ] **Step 3: Hash the canonical JSON**

Replace the whole of `packages/semantic-core/src/ids.ts` (13 lines today) with:

```ts
import { createHash } from "node:crypto";

import { canonicalJson } from "@jevcode/contracts";

export function hashId(prefix: string, ...parts: string[]): string {
  const hash = createHash("sha1")
    .update(parts.join("\u0000"))
    .digest("hex")
    .slice(0, 16);
  return `${prefix}_${hash}`;
}

// Key order must not matter: the coordinator hashes the collector's object
// while storage keeps the zod-reordered copy, and the trace reader recomputes
// the id from the stored row (R3).
export function factContentId(sessionId: string, record: unknown): string {
  return hashId("fact", sessionId, canonicalJson(record));
}
```

- [ ] **Step 4: Run it to verify it passes, and rebuild semantic-core**

Run: `pnpm --filter @jevcode/semantic-core exec vitest run src/ids.test.ts && pnpm --filter @jevcode/semantic-core build`
Expected: PASS, 0 failed; build exits 0.

- [ ] **Step 5: Add the no-strip guards**

In `packages/semantic-core/src/fixtures.test.ts`, replace:

```ts
import { parseReplayLine, PipelineCoordinator } from "./coordinator.js";
import type { ChangeUnit, EvidenceFact } from "@jevcode/contracts";
```

with:

```ts
import { parseReplayLine, PipelineCoordinator } from "./coordinator.js";
import { canonicalJson } from "@jevcode/contracts";
import type { ChangeUnit, EvidenceFact } from "@jevcode/contracts";
```

and append to the end of the file:

```ts
describe("fixture records survive zod parsing unchanged (no-strip guard)", () => {
  // A field the schemas do not declare is stripped silently on parse, and
  // canonical fact ids would then differ between the stream and storage.
  for (const scenario of SCENARIOS) {
    it(`keeps every field of ${scenario}/events.jsonl`, () => {
      const lines = readFileSync(path.join(FIXTURES_DIR, scenario, "events.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "");
      const stripped: number[] = [];
      for (const [index, line] of lines.entries()) {
        const parsed = parseReplayLine(line);
        if (canonicalJson(parsed) !== canonicalJson(JSON.parse(line))) stripped.push(index + 1);
      }
      expect(stripped).toEqual([]);
    });
  }
});
```

Create `packages/agent-codex/src/no-strip.test.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { canonicalJson, NormalizedAgentEventSchema } from "@jevcode/contracts";
import { defaultNormalizerContext } from "@jevcode/agent-core";

import { mapCodexJsonlEvent } from "./jsonl.js";

const FIXTURES_DIR = fileURLToPath(new URL("../test/fixtures/", import.meta.url));
const JSONL_FIXTURES = readdirSync(FIXTURES_DIR).filter((name) => name.endsWith(".jsonl"));

describe("mapped Codex events survive NormalizedAgentEventSchema unchanged", () => {
  for (const name of JSONL_FIXTURES) {
    it(`keeps every field mapped from ${name}`, () => {
      const ctx = { ...defaultNormalizerContext("s1"), turnId: "turn_guard" };
      const events = readFileSync(`${FIXTURES_DIR}${name}`, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .flatMap((line) => mapCodexJsonlEvent(JSON.parse(line), ctx));
      for (const event of events) {
        expect(canonicalJson(NormalizedAgentEventSchema.parse(event))).toBe(canonicalJson(event));
      }
    });
  }
});
```

Create `packages/evidence-engine/src/no-strip.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { canonicalJson, EvidenceFactSchema, type EvidenceFact } from "@jevcode/contracts";

import { createCommandCollector } from "./collectors/commands.js";
import { createGitCollector, type GitExec } from "./collectors/git.js";
import { createRevertDetector } from "./collectors/revert.js";
import { createTestCollector } from "./collectors/tests.js";

const opts = {
  repoId: "repo-1",
  sessionId: "sess-1",
  now: () => "2026-09-28T10:00:00.000Z",
};

// Storage and the coordinator parse facts with EvidenceFactSchema, which drops
// undeclared keys without an error. Every collector field must be declared.
function expectNoStrip(fact: EvidenceFact | null): void {
  expect(fact).not.toBeNull();
  expect(canonicalJson(EvidenceFactSchema.parse(fact))).toBe(canonicalJson(fact));
}

const GIT_RESPONSES: Record<string, string> = {
  "status --porcelain": " M src/app.ts\n",
  "diff HEAD -- src/app.ts": [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1 +1 @@",
    "-export const port = 3000;",
    "+export const port = 8080;",
    "",
  ].join("\n"),
  "diff --numstat HEAD -- src/app.ts": "1\t1\tsrc/app.ts",
};

const fakeGit: GitExec = async (args) => GIT_RESPONSES[args.join(" ")] ?? "";

describe("collector facts survive EvidenceFactSchema.parse unchanged", () => {
  it("detects a field the schema does not declare (control)", () => {
    const collector = createCommandCollector("/repo", opts);
    const fact = { ...collector.observe("pnpm test", 0)!, undeclared: "x" };
    expect(canonicalJson(EvidenceFactSchema.parse(fact))).not.toBe(canonicalJson(fact));
  });

  it("command_executed, with and without sourceCallId", () => {
    const collector = createCommandCollector("/repo", opts);
    expectNoStrip(collector.observe("pnpm test", 1, "turn_a:item_7"));
    expectNoStrip(collector.observe("rm -rf dist", 0));
  });

  it("test_result with sourceCallId", () => {
    const collector = createTestCollector("/repo", opts);
    expectNoStrip(
      collector.collect(
        "Test Files  1 failed (1)\n      Tests  1 failed | 2 passed (3)\n",
        "pnpm test",
        undefined,
        "turn_a:item_7",
      ),
    );
  });

  it("git_hunk", async () => {
    const collector = createGitCollector("/repo", "HEAD", { ...opts, execGit: fakeGit });
    const facts = await collector.collect();
    expect(facts).toHaveLength(1);
    for (const fact of facts) expectNoStrip(fact);
  });

  it("revert_detected", () => {
    const detector = createRevertDetector("/repo", opts);
    expectNoStrip(detector.observeReset(["src/app.ts"]));
  });
});
```

- [ ] **Step 6: Run the guards**

Run: `pnpm --filter @jevcode/semantic-core exec vitest run src/fixtures.test.ts && pnpm --filter @jevcode/agent-codex exec vitest run src/no-strip.test.ts && pnpm --filter @jevcode/evidence-engine exec vitest run src/no-strip.test.ts`
Expected: PASS in all three (0 failed). The guards pass today because every W0 field is declared; they fail the moment a producer emits an undeclared key. The evidence-engine control test "detects a field the schema does not declare (control)" proves the comparison catches a stripped key.

- [ ] **Step 7: Confirm canonical ids change no downstream result**

Run: `pnpm --filter "jevcode-desktop^..." build && pnpm --filter jevcode-desktop test && pnpm --filter jevcode-evals test`
Expected: both exit 0. (Unit ids never hash fact ids, clustering.ts `hashId("cu", …)`, so only `evidence` string values change.)

- [ ] **Step 8: Root checks**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r test && pnpm lint`
Expected: every command exits 0.

- [ ] **Step 9: Commit**

```bash
git add packages/semantic-core/src/ids.ts packages/semantic-core/src/ids.test.ts \
  packages/semantic-core/src/fixtures.test.ts \
  packages/agent-codex/src/no-strip.test.ts packages/evidence-engine/src/no-strip.test.ts
git commit -m "fix(semantic-core): hash fact ids over canonical JSON and guard against zod key stripping"
```

---

### Task A1-6: M1b, `PrepareDiff` injection and change-only git emission

**Files:**
- Create: `packages/evidence-engine/src/diff.ts`, `packages/evidence-engine/src/diff.test.ts`
- Modify: `packages/evidence-engine/src/index.ts` (export `./diff.js`)
- Modify: `packages/evidence-engine/src/collectors/git.ts` (imports lines 1-17, `GitCollectorOptions` lines 111-114, `createGitCollector` lines 137-138 and `collect()` lines 185-209)
- Test: `packages/evidence-engine/src/collectors/git.test.ts` (test at lines 153-194 extended; three tests added)
- Modify: `docs/SPEC.md` §7

**Interfaces:**
- Consumes: W0-4 `GitHunkDiff`, `GitHunkDiffSchema` (`{hash: /^[0-9a-f]{16}$/, bytes, text?, truncated, redactions, withheld?: "secret_path" | "not_captured"}`, refine: withheld ⇒ no text) and the `git_hunk.diff?: GitHunkDiff` field, from `@jevcode/contracts`.
- Produces (exact, index section 2.4):
  - `packages/evidence-engine/src/diff.ts`: `export type PrepareDiff = (file: string, rawDiff: string) => GitHunkDiff;` `export function diffHash(rawDiff: string): string` (sha256 hex, first 16); `export function diffBytes(rawDiff: string): number` (UTF-8 bytes); `export const notCapturedDiff: PrepareDiff` returning `{hash, bytes, truncated: false, redactions: 0, withheld: "not_captured"}`. All re-exported from `@jevcode/evidence-engine`.
  - `GitCollectorOptions` gains `prepareDiff?: PrepareDiff`. `collect()` emits a `git_hunk` only when `diffHash(raw)` differs from the last emitted hash for that file, forgets files that leave `git status --porcelain`, and sets `diff` from `(opts.prepareDiff ?? notCapturedDiff)(file, raw)`.

- [ ] **Step 1: Write the failing diff-helper tests**

Create `packages/evidence-engine/src/diff.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { GitHunkDiffSchema } from "@jevcode/contracts";

import { diffBytes, diffHash, notCapturedDiff } from "./diff.js";

describe("diffHash", () => {
  it("is the first 16 hex chars of sha256 over the raw diff", () => {
    expect(diffHash("")).toBe("e3b0c44298fc1c14");
    expect(diffHash("abc")).toBe("ba7816bf8f01cfea");
  });
});

describe("diffBytes", () => {
  it("counts UTF-8 bytes, not UTF-16 code units", () => {
    expect(diffBytes("abc")).toBe(3);
    expect(diffBytes("héllo")).toBe(6);
  });
});

describe("notCapturedDiff", () => {
  it("records hash and size but no text", () => {
    const diff = notCapturedDiff("src/app.ts", "abc");
    expect(diff).toEqual({
      hash: "ba7816bf8f01cfea",
      bytes: 3,
      truncated: false,
      redactions: 0,
      withheld: "not_captured",
    });
    expect(GitHunkDiffSchema.safeParse(diff).success).toBe(true);
  });
});
```

The expected hashes are the published SHA-256 test vectors for `""` and `"abc"`, truncated to 16 hex characters.

- [ ] **Step 2: Write the failing collector tests**

In `packages/evidence-engine/src/collectors/git.test.ts`, in the test "emits git_hunk facts with classifications", replace:

```ts
    expect(byFile.get("src/renamed.ts")).toMatchObject({ added: 2, removed: 0 });
    expect(byFile.get("new file.ts")).toMatchObject({ added: 1, removed: 0 });

    expect(collector.facts).toHaveLength(7);
  });
```

with:

```ts
    expect(byFile.get("src/renamed.ts")).toMatchObject({ added: 2, removed: 0 });
    expect(byFile.get("new file.ts")).toMatchObject({ added: 1, removed: 0 });
    // Without an injected prepareDiff no diff text is ever stored.
    for (const fact of facts) {
      expect(fact.diff).toMatchObject({ withheld: "not_captured", truncated: false, redactions: 0 });
      expect(fact.diff?.text).toBeUndefined();
      expect(fact.diff?.hash).toMatch(/^[0-9a-f]{16}$/);
    }

    expect(collector.facts).toHaveLength(7);
  });

  it("emits a file only when its diff changes", async () => {
    const responses: Record<string, string> = { ...RESPONSES };
    const collector = createGitCollector("/repo", "HEAD", {
      repoId: "repo-1",
      sessionId: "sess-1",
      execGit: fakeGit(responses),
    });
    expect(await collector.collect()).toHaveLength(7);

    // An unchanged re-poll emits nothing.
    expect(await collector.collect()).toEqual([]);

    // An edit to one file emits exactly that file.
    responses["diff HEAD -- src/foo.ts"] = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +1,3 @@
-  const a=1;
+const a = 1;
-  const b=2;
+const b = 2;
+const c = 3;
`;
    responses["diff --numstat HEAD -- src/foo.ts"] = "2\t1\tsrc/foo.ts";
    const afterEdit = (await collector.collect()) as GitHunkFact[];
    expect(afterEdit.map((fact) => fact.file)).toEqual(["src/foo.ts"]);
    expect(afterEdit[0]).toMatchObject({ added: 2, removed: 1 });
    expect(collector.facts).toHaveLength(8);
  });

  it("emits again for a file that left git status and came back unchanged", async () => {
    const responses: Record<string, string> = {
      ...RESPONSES,
      "status --porcelain": "?? src/new.ts\n",
    };
    const collector = createGitCollector("/repo", "HEAD", {
      repoId: "repo-1",
      sessionId: "sess-1",
      execGit: fakeGit(responses),
    });
    expect(await collector.collect()).toHaveLength(1);

    responses["status --porcelain"] = "";
    expect(await collector.collect()).toEqual([]);

    responses["status --porcelain"] = "?? src/new.ts\n";
    const returned = (await collector.collect()) as GitHunkFact[];
    expect(returned.map((fact) => fact.file)).toEqual(["src/new.ts"]);
  });

  it("passes each file and its raw diff to an injected prepareDiff", async () => {
    const seen: [string, string][] = [];
    const collector = createGitCollector("/repo", "HEAD", {
      repoId: "repo-1",
      sessionId: "sess-1",
      execGit: fakeGit({ ...RESPONSES, "status --porcelain": " M src/foo.ts\n" }),
      prepareDiff: (file, rawDiff) => {
        seen.push([file, rawDiff]);
        return {
          hash: "0123456789abcdef",
          bytes: rawDiff.length,
          text: "prepared",
          truncated: false,
          redactions: 0,
        };
      },
    });
    const facts = (await collector.collect()) as GitHunkFact[];
    expect(seen).toEqual([["src/foo.ts", RESPONSES["diff HEAD -- src/foo.ts"]]]);
    expect(facts[0]?.diff).toMatchObject({ text: "prepared", hash: "0123456789abcdef" });
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @jevcode/evidence-engine exec vitest run src/diff.test.ts src/collectors/git.test.ts`
Expected: FAIL. `src/diff.test.ts` fails to load (`Failed to load url ./diff.js` / cannot find module). In git.test.ts: "emits git_hunk facts with classifications" (`expected undefined to match object { withheld: 'not_captured', …(2) }`), "emits a file only when its diff changes" (`expected [ { type: 'git_hunk', …(9) }, …(6) ] to deeply equal []`) and "passes each file and its raw diff…" (`expected [] to deeply equal [ [ 'src/foo.ts', …(1) ] ]`). "emits again for a file that left git status…" passes today; it guards the change-only logic added next.

- [ ] **Step 4: Create `packages/evidence-engine/src/diff.ts`**

```ts
import { createHash } from "node:crypto";

import type { GitHunkDiff } from "@jevcode/contracts";

/**
 * Turns one file's raw unified diff into the `git_hunk.diff` payload. The
 * desktop app injects a redacting, capping implementation; collectors default
 * to `notCapturedDiff` so tests and the CLI never store unredacted text.
 */
export type PrepareDiff = (file: string, rawDiff: string) => GitHunkDiff;

/** First 16 hex chars of sha256 over the raw (pre-redaction) diff: the change key. */
export function diffHash(rawDiff: string): string {
  return createHash("sha256").update(rawDiff, "utf8").digest("hex").slice(0, 16);
}

/** UTF-8 byte length of the raw diff. */
export function diffBytes(rawDiff: string): number {
  return Buffer.byteLength(rawDiff, "utf8");
}

export const notCapturedDiff: PrepareDiff = (_file, rawDiff) => ({
  hash: diffHash(rawDiff),
  bytes: diffBytes(rawDiff),
  truncated: false,
  redactions: 0,
  withheld: "not_captured",
});
```

In `packages/evidence-engine/src/index.ts`, replace `export * from "./hunks.js";` with:

```ts
export * from "./hunks.js";
export * from "./diff.js";
```

- [ ] **Step 5: Make the git collector change-only and diff-aware**

In `packages/evidence-engine/src/collectors/git.ts`, make five edits.

(a) Replace:

```ts
import type { EvidenceFact } from "@jevcode/contracts";

import {
  isConfigPath,
```

with:

```ts
import type { EvidenceFact } from "@jevcode/contracts";

import { diffHash, notCapturedDiff, type PrepareDiff } from "../diff.js";
import {
  isConfigPath,
```

(b) Replace:

```ts
export interface GitCollectorOptions extends CollectorOptions {
  execGit?: GitExec;
  readFile?: (absPath: string) => Promise<string>;
}
```

with:

```ts
export interface GitCollectorOptions extends CollectorOptions {
  execGit?: GitExec;
  readFile?: (absPath: string) => Promise<string>;
  // Builds git_hunk.diff from the raw diff. Default: notCapturedDiff (no text).
  prepareDiff?: PrepareDiff;
}
```

(c) Replace:

```ts
  const git = (args: string[], allowFailure = false): Promise<string> =>
    execGit(args, { cwd: repoPath, allowFailure });
```

with:

```ts
  const git = (args: string[], allowFailure = false): Promise<string> =>
    execGit(args, { cwd: repoPath, allowFailure });
  const prepareDiff = opts.prepareDiff ?? notCapturedDiff;
  // diffHash of the last emitted diff per file. A poll emits a file only when
  // its hash changed, so an unchanged dirty file is not re-emitted every 5 s.
  const lastEmittedHash = new Map<string, string>();
```

(d) Replace:

```ts
    async collect(): Promise<EvidenceFact[]> {
      const statusOutput = await git(["status", "--porcelain"]);
      const changes = parsePorcelain(statusOutput);
      const emitted: EvidenceFact[] = [];
      for (const [file, status] of changes) {
        if (file.endsWith("/")) continue;
        const diff = await diffFor(file, status);
        if (!diff) continue;
        const fact: EvidenceFact = {
```

with:

```ts
    async collect(): Promise<EvidenceFact[]> {
      const statusOutput = await git(["status", "--porcelain"]);
      const changes = parsePorcelain(statusOutput);
      // Forget files that left `git status`, so a file that returns emits again.
      for (const file of [...lastEmittedHash.keys()]) {
        if (!changes.has(file)) lastEmittedHash.delete(file);
      }
      const emitted: EvidenceFact[] = [];
      for (const [file, status] of changes) {
        if (file.endsWith("/")) continue;
        const diff = await diffFor(file, status);
        if (!diff) continue;
        const hash = diffHash(diff.diffText);
        if (lastEmittedHash.get(file) === hash) continue;
        lastEmittedHash.set(file, hash);
        const fact: EvidenceFact = {
```

(e) Replace:

```ts
          isLockfile: isLockfilePath(file),
          ts: cfg.now(),
        };
        cfg.sink.push(fact);
```

with:

```ts
          isLockfile: isLockfilePath(file),
          diff: prepareDiff(file, diff.diffText),
          ts: cfg.now(),
        };
        cfg.sink.push(fact);
```

- [ ] **Step 6: Run the tests to verify they pass, and rebuild**

Run: `pnpm --filter @jevcode/evidence-engine exec vitest run src/diff.test.ts src/collectors/git.test.ts src/no-strip.test.ts && pnpm --filter @jevcode/evidence-engine typecheck && pnpm --filter @jevcode/evidence-engine test && pnpm --filter @jevcode/evidence-engine build`
Expected: every command exits 0 (0 failed). The no-strip guard now also covers `git_hunk.diff`.

- [ ] **Step 7: Document change-only emission and provenance in SPEC §7**

In `docs/SPEC.md` §7, make three replacements in the collector table and the line under it. First, replace the GitCollector row (line 401 at `144c7fb`):

```
| GitCollector | `git status/diff` against session base commit | `git_hunk` (per file, classified formatting-only/config/lockfile) | Classifier: whitespace-only hunk detection + path heuristics (`*.lock`, `package-lock.json`, `.prettierrc`, etc.) |
```

with:

```
| GitCollector | `git status/diff` against session base commit | `git_hunk` (per file, classified formatting-only/config/lockfile) | Classifier: whitespace-only hunk detection + path heuristics (`*.lock`, `package-lock.json`, `.prettierrc`, etc.). Emits a file only when its diff hash changes; a file that leaves and re-enters `git status` emits again. `diff` holds `{hash, bytes, text?, truncated, redactions, withheld?}` from an injected `prepareDiff`; the default stores no text (`withheld: "not_captured"`), the desktop policy is in §3.7 |
```

Second, replace the TestCollector and CommandCollector rows (lines 405-406; the rows between stay):

```
| TestCollector | PTY + command log parsing (vitest/jest/pytest formats) | `test_result` | regex suite v0, runner registry for extension |
| CommandCollector | PTY log | `command_executed` | destructive classifier (§8.3.1) |
```

with:

```
| TestCollector | PTY + command log parsing (vitest/jest/pytest formats) | `test_result` | regex suite v0, runner registry for extension; `sourceCallId` = the agent call's `callId` |
| CommandCollector | PTY log | `command_executed` | destructive classifier (§8.3.1); `sourceCallId` = the agent call's `callId` |
```

Third, replace:

```
All collectors emit into the event store. None talk to the renderer directly.
```

with:

```
All collectors emit into the event store. None talk to the renderer directly. Each collector pushes every fact into its sink exactly once; callers must not push the returned facts again.
```

- [ ] **Step 8: Root checks**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r test && pnpm lint`
Expected: every command exits 0.

- [ ] **Step 9: Commit**

```bash
git add packages/evidence-engine/src/diff.ts packages/evidence-engine/src/diff.test.ts \
  packages/evidence-engine/src/index.ts \
  packages/evidence-engine/src/collectors/git.ts packages/evidence-engine/src/collectors/git.test.ts \
  docs/SPEC.md
git commit -m "feat(evidence-engine): emit git hunks only on change and attach a prepared diff"
```

---

### Task A1-7: M1b, desktop diff policy and single delivery of collector facts

**Files:**
- Modify: `apps/desktop/src/main/pipeline/redactor.ts` (import line 1, `env_value` rule lines 41-45, new exports appended)
- Test: `apps/desktop/src/main/pipeline/redactor.test.ts`
- Modify: `apps/desktop/src/main/pipeline/evidence-runtime.ts` (imports, `createGitCollector` call line 92, `start()` lines 107-132)
- Test: `apps/desktop/src/main/pipeline/evidence-runtime.test.ts`
- Modify: `docs/SPEC.md` §3.7

**Interfaces:**
- Consumes: A1-6 `diffHash(rawDiff: string): string`, `diffBytes(rawDiff: string): number`, `PrepareDiff`, `GitCollectorOptions.prepareDiff` from `@jevcode/evidence-engine`; W0-4 `GitHunkDiff`, `GitHunkDiffSchema` from `@jevcode/contracts`.
- Produces (exact, index section 2.4; lane A2's bundle calls `redactText`, which now also catches `+KEY=` lines):
  - `export const DIFF_TEXT_CAP_BYTES = 32 * 1024;`
  - `export function isSecretPath(file: string): boolean` — basename matches `.env*`, `*.pem`, `*.key`, `id_rsa*` (case-insensitive).
  - `export function capDiffText(diff: string, capBytes?: number): { text: string; truncated: boolean }` — keeps every complete hunk that fits, cuts before the `@@` header of the first hunk that would overflow; when even the first hunk overflows, keeps the file header plus that hunk up to the last whole line within the cap.
  - `export function prepareDiffForStorage(file: string, rawDiff: string): GitHunkDiff` — withholds secret paths (`withheld: "secret_path"`, no text), else `redactText` then `capDiffText`; `hash`/`bytes` describe the raw diff; `redactions` counts every replacement.
  - `env_value` rule: pattern `/^([+\- ]?)([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*)\s*=\s*.+$/gm`, replacement `"$1$2=[REDACTED:env_value]"`.
  - `createEvidenceSession` passes `prepareDiff: prepareDiffForStorage` to the git collector and no longer re-pushes facts returned by `gitCollector.collect()` or `revertDetector.check()`; each fact reaches `onFact` once.

- [ ] **Step 1: Write the failing redactor tests**

In `apps/desktop/src/main/pipeline/redactor.test.ts`, replace:

```ts
import { redactEvidenceFact, redactText } from "./redactor.js";
```

with:

```ts
import { GitHunkDiffSchema } from "@jevcode/contracts";
import { diffHash } from "@jevcode/evidence-engine";

import {
  DIFF_TEXT_CAP_BYTES,
  capDiffText,
  isSecretPath,
  prepareDiffForStorage,
  redactEvidenceFact,
  redactText,
} from "./redactor.js";

const FILE_HEADER = [
  "diff --git a/src/big.ts b/src/big.ts",
  "--- a/src/big.ts",
  "+++ b/src/big.ts",
  "",
].join("\n");

function addedHunk(start: number, lines: number): string {
  const body = Array.from(
    { length: lines },
    (_, index) => `+export const line${start + index} = "${"x".repeat(32)}";\n`,
  ).join("");
  return `@@ -${start},0 +${start},${lines} @@\n${body}`;
}
```

Replace:

```ts
  it("counts multiple redactions and leaves benign text alone", () => {
```

with:

```ts
  it("redacts a prefixed env line inside a diff and keeps the prefix", () => {
    expect(redactText("+STRIPE_KEY=sk_live_abc")).toEqual({
      text: "+STRIPE_KEY=[REDACTED:env_value]",
      count: 1,
    });
    const result = redactText("-DB_PASSWORD=old\n DB_PASSWORD=same\n+PORT=3000");
    expect(result.text).toBe(
      "-DB_PASSWORD=[REDACTED:env_value]\n DB_PASSWORD=[REDACTED:env_value]\n+PORT=3000",
    );
    expect(result.count).toBe(2);
  });

  it("counts multiple redactions and leaves benign text alone", () => {
```

Append to the end of the file:

```ts
describe("isSecretPath", () => {
  it("matches .env*, *.pem, *.key and id_rsa* by basename", () => {
    for (const file of [".env", ".env.local", "config/.env.production", "certs/server.pem", "deploy/app.key", "home/.ssh/id_rsa", "id_rsa.pub"]) {
      expect(isSecretPath(file)).toBe(true);
    }
    for (const file of ["src/env.ts", "src/keyboard.ts", "docs/pem-notes.md", "src/.environment/readme.md"]) {
      expect(isSecretPath(file)).toBe(false);
    }
  });
});

describe("capDiffText", () => {
  it("returns a diff under the cap unchanged", () => {
    const diff = FILE_HEADER + addedHunk(1, 3);
    expect(capDiffText(diff)).toEqual({ text: diff, truncated: false });
  });

  it("cuts a 40 KiB two-hunk diff before the second @@ header", () => {
    const first = addedHunk(1, 345);
    const second = addedHunk(1000, 345);
    const diff = FILE_HEADER + first + second;
    expect(Buffer.byteLength(diff)).toBeGreaterThan(40 * 1024);
    expect(Buffer.byteLength(FILE_HEADER + first)).toBeLessThan(DIFF_TEXT_CAP_BYTES);

    const capped = capDiffText(diff);
    expect(capped).toEqual({ text: FILE_HEADER + first, truncated: true });
  });

  it("keeps the header and whole lines of a first hunk larger than the cap", () => {
    const diff = FILE_HEADER + addedHunk(1, 1000);
    const capped = capDiffText(diff);
    expect(capped.truncated).toBe(true);
    expect(Buffer.byteLength(capped.text)).toBeLessThanOrEqual(DIFF_TEXT_CAP_BYTES);
    expect(capped.text.startsWith(FILE_HEADER + "@@ -1,0 +1,1000 @@\n")).toBe(true);
    expect(capped.text.endsWith("\n")).toBe(true);
    expect(diff.startsWith(capped.text)).toBe(true);
  });
});

describe("prepareDiffForStorage", () => {
  const raw = [
    "diff --git a/.env.local b/.env.local",
    "--- a/.env.local",
    "+++ b/.env.local",
    "@@ -1 +1 @@",
    "-STRIPE_KEY=sk_live_old",
    "+STRIPE_KEY=sk_live_abc",
    "",
  ].join("\n");

  it("withholds a secret path and stores no text", () => {
    const diff = prepareDiffForStorage(".env.local", raw);
    expect(diff).toEqual({
      hash: diffHash(raw),
      bytes: Buffer.byteLength(raw),
      truncated: false,
      redactions: 0,
      withheld: "secret_path",
    });
    expect(GitHunkDiffSchema.safeParse(diff).success).toBe(true);
  });

  it("redacts every line after its diff prefix and hashes the raw diff", () => {
    const diff = prepareDiffForStorage("src/config.ts", raw);
    expect(diff.hash).toBe(diffHash(raw));
    expect(diff.redactions).toBe(2);
    expect(diff.truncated).toBe(false);
    expect(diff.text).toContain("+STRIPE_KEY=[REDACTED:env_value]");
    expect(diff.text).toContain("-STRIPE_KEY=[REDACTED:env_value]");
    expect(diff.text).not.toContain("sk_live");
    expect(GitHunkDiffSchema.safeParse(diff).success).toBe(true);
  });
});
```

- [ ] **Step 2: Write the failing evidence-runtime tests**

In `apps/desktop/src/main/pipeline/evidence-runtime.test.ts`, replace:

```ts
import { createTestCollector } from "@jevcode/evidence-engine";

import { createEvidenceSession, isEBADF } from "./evidence-runtime.js";
```

with:

```ts
import type { EvidenceFact } from "@jevcode/contracts";
import {
  createGitCollector,
  createRevertDetector,
  createTestCollector,
  type FactSink,
} from "@jevcode/evidence-engine";

import { createEvidenceSession, isEBADF } from "./evidence-runtime.js";
import { prepareDiffForStorage } from "./redactor.js";
```

Replace:

```ts
  describe("git poll failures", () => {
```

with:

```ts
  describe("fact delivery", () => {
    const hunk: EvidenceFact = {
      type: "git_hunk",
      repoId: "repo-1",
      sessionId: "sess-1",
      file: "src/app.ts",
      added: 1,
      removed: 0,
      isFormattingOnly: false,
      isConfigOnly: false,
      isLockfile: false,
      ts: "2026-09-28T10:00:00.000Z",
    };
    const revert: EvidenceFact = {
      type: "revert_detected",
      repoId: "repo-1",
      sessionId: "sess-1",
      files: ["src/app.ts"],
      ts: "2026-09-28T10:00:05.000Z",
    };

    beforeEach(() => {
      vi.useFakeTimers();
      mocks.gitCollect.mockReset();
      mocks.revertCheck.mockReset();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("gives the git collector the desktop diff policy", () => {
      makeSession();
      const options = vi.mocked(createGitCollector).mock.calls.at(-1)?.[2];
      expect(options?.prepareDiff).toBe(prepareDiffForStorage);
    });

    it("delivers each collected git and revert fact to onFact once", async () => {
      const onFact = vi.fn();
      const session = createEvidenceSession({
        repoId: "repo-1",
        sessionId: "sess-1",
        repoPath: "/tmp/jevcode-evidence-test",
        sink: { push: () => {} },
        onFact,
        log: () => {},
      });
      // Like the real collectors: push into the injected sink, then return.
      const gitSink = vi.mocked(createGitCollector).mock.calls.at(-1)?.[2]?.sink as FactSink;
      const revertSink = vi.mocked(createRevertDetector).mock.calls.at(-1)?.[1]?.sink as FactSink;
      mocks.gitCollect.mockImplementationOnce(async () => {
        gitSink.push(hunk);
        return [hunk];
      });
      mocks.gitCollect.mockResolvedValue([]);
      mocks.revertCheck.mockImplementationOnce(async () => {
        revertSink.push(revert);
        return revert;
      });
      mocks.revertCheck.mockResolvedValue(null);

      await session.start();
      await vi.advanceTimersByTimeAsync(5000);

      expect(onFact.mock.calls.map(([fact]) => (fact as EvidenceFact).type)).toEqual([
        "git_hunk",
        "revert_detected",
      ]);
      await session.stop();
    });
  });

  describe("git poll failures", () => {
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter "jevcode-desktop^..." build && pnpm --filter jevcode-desktop exec vitest run src/main/pipeline/redactor.test.ts src/main/pipeline/evidence-runtime.test.ts`
Expected: FAIL. redactor.test.ts: "redacts a prefixed env line…" (`expected { text: '+STRIPE_KEY=sk_live_abc', count: 0 } to deeply equal …`) and every `isSecretPath`/`capDiffText`/`prepareDiffForStorage` test (`… is not a function`). evidence-runtime.test.ts: "gives the git collector the desktop diff policy" (`expected undefined to be [Function prepareDiffForStorage]`) and "delivers each … once" (`expected [ 'git_hunk', 'git_hunk', …(2) ] to deeply equal [ 'git_hunk', 'revert_detected' ]`).

- [ ] **Step 4: Implement the diff policy in `apps/desktop/src/main/pipeline/redactor.ts`**

Replace `import type { EvidenceFact } from "@jevcode/contracts";` with:

```ts
import type { EvidenceFact, GitHunkDiff } from "@jevcode/contracts";
import { diffBytes, diffHash } from "@jevcode/evidence-engine";
```

Replace:

```ts
  {
    kind: "env_value",
    pattern: /^([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*)\s*=\s*.+$/gm,
    replacement: "$1=[REDACTED:env_value]",
  },
```

with:

```ts
  {
    kind: "env_value",
    // One optional unified-diff prefix ("+", "-" or " ") so KEY=value lines
    // inside a stored diff are caught too; the prefix is kept.
    pattern: /^([+\- ]?)([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*)\s*=\s*.+$/gm,
    replacement: "$1$2=[REDACTED:env_value]",
  },
```

Append to the end of the file:

```ts
/** Stored diff text is capped at 32 KiB (UTF-8 bytes) (R3). */
export const DIFF_TEXT_CAP_BYTES = 32 * 1024;

const SECRET_BASENAMES: readonly RegExp[] = [/^\.env/i, /\.pem$/i, /\.key$/i, /^id_rsa/i];

/** True for files whose diff is never stored: .env*, *.pem, *.key, id_rsa*. */
export function isSecretPath(file: string): boolean {
  const basename = file.replace(/\\/g, "/").split("/").pop() ?? file;
  return SECRET_BASENAMES.some((pattern) => pattern.test(basename));
}

/**
 * Caps a single-file unified diff at `capBytes` UTF-8 bytes. Keeps every
 * complete hunk that fits and cuts before the "@@" header of the first hunk
 * that would overflow. When even the first hunk overflows, keeps the file
 * header and that hunk up to the last whole line within the cap.
 */
export function capDiffText(
  diff: string,
  capBytes: number = DIFF_TEXT_CAP_BYTES,
): { text: string; truncated: boolean } {
  if (Buffer.byteLength(diff, "utf8") <= capBytes) {
    return { text: diff, truncated: false };
  }
  const lines = diff.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let kept = "";
  let keptBytes = 0;
  let hunkStart = 0;
  let hunks = 0;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      hunkStart = kept.length;
      hunks += 1;
    }
    const size = Buffer.byteLength(line, "utf8");
    if (keptBytes + size > capBytes) {
      return { text: hunks >= 2 ? kept.slice(0, hunkStart) : kept, truncated: true };
    }
    kept += line;
    keptBytes += size;
  }
  return { text: kept, truncated: false };
}

/**
 * The desktop PrepareDiff (injected into the git collector): withholds secret
 * paths, redacts every line after its diff prefix, then caps the text. `hash`
 * and `bytes` describe the raw diff; `redactions` counts every replacement
 * made before the cap.
 */
export function prepareDiffForStorage(file: string, rawDiff: string): GitHunkDiff {
  const hash = diffHash(rawDiff);
  const bytes = diffBytes(rawDiff);
  if (isSecretPath(file)) {
    return { hash, bytes, truncated: false, redactions: 0, withheld: "secret_path" };
  }
  const redacted = redactText(rawDiff);
  const capped = capDiffText(redacted.text);
  return {
    hash,
    bytes,
    text: capped.text,
    truncated: capped.truncated,
    redactions: redacted.count,
  };
}
```

- [ ] **Step 5: Wire the policy and remove the double pushes in `apps/desktop/src/main/pipeline/evidence-runtime.ts`**

Replace:

```ts
  type FactSink,
} from "@jevcode/evidence-engine";
```

with:

```ts
  type FactSink,
} from "@jevcode/evidence-engine";

import { prepareDiffForStorage } from "./redactor.js";
```

Replace:

```ts
  const gitCollector = createGitCollector(options.repoPath, options.baseCommit, collectorOptions);
```

with:

```ts
  const gitCollector = createGitCollector(options.repoPath, options.baseCommit, {
    ...collectorOptions,
    prepareDiff: prepareDiffForStorage,
  });
```

Replace:

```ts
      try {
        const initialFacts = await gitCollector.collect();
        collectTracker.success();
        for (const fact of initialFacts) bridgeSink.push(fact);
      } catch (error) {
```

with:

```ts
      // Collectors push every fact into bridgeSink themselves; re-pushing the
      // returned facts would deliver each one twice.
      try {
        await gitCollector.collect();
        collectTracker.success();
      } catch (error) {
```

Replace:

```ts
        void gitCollector
          .collect()
          .then((facts) => {
            collectTracker.success();
            for (const fact of facts) bridgeSink.push(fact);
          })
          .catch((error: unknown) => collectTracker.failure("git collect", error));
        void revertDetector
          .check()
          .then((fact) => {
            checkTracker.success();
            if (fact !== null) bridgeSink.push(fact);
          })
          .catch((error: unknown) => checkTracker.failure("revert check", error));
```

with:

```ts
        void gitCollector
          .collect()
          .then(() => collectTracker.success())
          .catch((error: unknown) => collectTracker.failure("git collect", error));
        void revertDetector
          .check()
          .then(() => checkTracker.success())
          .catch((error: unknown) => checkTracker.failure("revert check", error));
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter jevcode-desktop typecheck && pnpm --filter jevcode-desktop exec vitest run src/main/pipeline/redactor.test.ts src/main/pipeline/evidence-runtime.test.ts`
Expected: typecheck exits 0; both files pass (0 failed).

Run: `pnpm --filter jevcode-desktop test`
Expected: every desktop test passes; no `Errors` line.

- [ ] **Step 7: Document stored-diff redaction in SPEC §3.7**

In `docs/SPEC.md` §3.7, replace:

```
| Model-context redaction | Same pipeline. Redacted spans replaced with `[REDACTED:<kind>]`, counts logged to telemetry. |
```

with:

```
| Model-context redaction | Same pipeline. Redacted spans replaced with `[REDACTED:<kind>]`, counts logged to telemetry. |
| Stored diffs | `git_hunk.diff.text` is redacted before it is stored. Files named `.env*`, `*.pem`, `*.key` or `id_rsa*` are withheld (`withheld: "secret_path"`, no text). Every line is redacted after its diff prefix (`+`, `-` or space). The text is capped at 32 KiB, cut before the `@@` header of the first hunk that would overflow (`truncated: true`). `hash` and `bytes` describe the raw diff. The store itself is owner-only (§11). |
```

- [ ] **Step 8: Root checks**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r test && pnpm lint`
Expected: every command exits 0.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/main/pipeline/redactor.ts apps/desktop/src/main/pipeline/redactor.test.ts \
  apps/desktop/src/main/pipeline/evidence-runtime.ts \
  apps/desktop/src/main/pipeline/evidence-runtime.test.ts docs/SPEC.md
git commit -m "feat(desktop): store redacted, capped diffs and deliver each collector fact once"
```

---

### Task A1-8: M1b, `ChangeUnit.agentCallIds` in `clusterSession` and `unitSignature`

**Files:**
- Modify: `packages/semantic-core/src/clustering.ts` (end of `clusterSession` ~line 934; new function before `buildPlaceholderTitle` ~line 231)
- Modify: `packages/semantic-core/src/coordinator.ts` (`unitSignature`, lines 529-538)
- Test: `packages/semantic-core/src/clustering.test.ts`, `packages/semantic-core/src/clustering.property.test.ts`, `packages/semantic-core/src/coordinator.test.ts`

**Interfaces:**
- Consumes: W0-4 `ChangeUnit.agentCallIds?: string[]`; A1-2 `file_changed.callId?`; A1-4 `command_executed.sourceCallId?` and `test_result.sourceCallId?`; existing `SessionInput.agentEvents: readonly NormalizedAgentEvent[]` (clustering.ts:39, ignored today) and `SemanticProjection.unitEvidenceFacts: Map<string, SequencedFact[]>`.
- Produces (exact, index section 2.4): `ChangeUnit.agentCallIds` = (1) every `sourceCallId` on the unit's evidence facts (`unitEvidenceFacts.get(unit.id)`); (2) for each agent `file_changed` with a `callId`, every unit that owns the evidence fact for that path nearest in time (ties to the lower fact seq). Sorted ascending (`Array.prototype.sort`), unique, key omitted when empty. `unitSignature` includes `agentCallIds`, so a newly linked call bumps the unit's decision version. Lane B reads it as the "observed" chapter link.

- [ ] **Step 1: Write the failing tests**

In `packages/semantic-core/src/clustering.test.ts`, replace:

```ts
import {
  commandExecuted,
  depChange,
```

with:

```ts
import type { EvidenceFact } from "@jevcode/contracts";

import {
  agentEvent,
  commandExecuted,
  depChange,
```

and append to the end of the file:

```ts
describe("clustering: unit to agent call join (agentCallIds)", () => {
  const withCall = (fact: EvidenceFact, sourceCallId: string): EvidenceFact =>
    ({ ...fact, sourceCallId }) as EvidenceFact;

  it("collects the sourceCallId of every command and test fact on the unit", () => {
    const result = run([
      seq({ fact: fileChanged("src/a.ts", "modified", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
      seq({ fact: withCall(commandExecuted(tsOf(0, 1)), "turn_a:item_3"), factId: "f2", seq: 2, batchId: 0 }),
      seq({ fact: withCall(testResult(tsOf(0, 2), { passed: 2 }), "turn_a:item_3"), factId: "f3", seq: 3, batchId: 0 }),
      seq({ fact: withCall(commandExecuted(tsOf(0, 3), "pnpm lint"), "turn_a:item_1"), factId: "f4", seq: 4, batchId: 0 }),
    ]);
    const unit = result.units.find((candidate) => candidate.files.includes("src/a.ts"));
    expect(unit?.agentCallIds).toEqual(["turn_a:item_1", "turn_a:item_3"]);
  });

  it("links an agent file_changed call to the unit owning the nearest fact for that path", () => {
    const result = run(
      [
        seq({ fact: hunk("src/a.ts", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
        seq({ fact: hunk("src/b.ts", tsOf(5)), factId: "f2", seq: 2, batchId: 1 }),
        seq({ fact: hunk("src/a.ts", tsOf(10)), factId: "f3", seq: 3, batchId: 2 }),
      ],
      {
        agentEvents: [
          agentEvent("file_changed", tsOf(9, 58), { path: "src/a.ts", callId: "turn_a:item_8" }),
          agentEvent("file_changed", tsOf(5, 1), { path: "src/b.ts" }),
        ],
      },
    );
    const owner = result.units.find((unit) => unit.evidence.includes("f3"));
    expect(owner?.agentCallIds).toEqual(["turn_a:item_8"]);
    const other = result.units.find((unit) => unit.files.includes("src/b.ts"));
    expect(other !== undefined && "agentCallIds" in other).toBe(false);
  });

  it("omits the key when a unit has no linked call", () => {
    const result = run([
      seq({ fact: fileChanged("src/a.ts", "modified", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
    ]);
    expect(result.units).toHaveLength(1);
    expect("agentCallIds" in result.units[0]!).toBe(false);
  });
});
```

In `packages/semantic-core/src/clustering.property.test.ts`, replace:

```ts
import { clusterSession, type SequencedFact } from "./clustering.js";
import { fileChanged, hunk, SESSION, symbolDelta, tsOf } from "./test-helpers.js";
```

with:

```ts
import type { EvidenceFact } from "@jevcode/contracts";

import { clusterSession, type SequencedFact } from "./clustering.js";
import {
  agentEvent,
  commandExecuted,
  fileChanged,
  hunk,
  SESSION,
  symbolDelta,
  testResult,
  tsOf,
} from "./test-helpers.js";
```

and replace:

```ts
  it("units always have non-empty files and a valid category", () => {
```

with:

```ts
  it("agentCallIds covers every sourceCallId on a unit's facts, sorted and unique", () => {
    const CALL_IDS = ["turn_1:item_1", "turn_1:item_2", "turn_2:item_1"];
    const provenanceArb = fc.record({
      files: bucketSpecArb,
      calls: fc.array(
        fc.record({
          kind: fc.constantFrom("cmd", "test"),
          callId: fc.option(fc.constantFrom(...CALL_IDS), { nil: undefined }),
          at: fc.integer({ min: 0, max: 19 }),
        }),
        { maxLength: 6 },
      ),
      edits: fc.array(
        fc.record({
          file: fc.constantFrom(...FILE_ALPHABET),
          callId: fc.constantFrom(...CALL_IDS),
          at: fc.integer({ min: 0, max: 19 }),
        }),
        { maxLength: 4 },
      ),
    });
    fc.assert(
      fc.property(provenanceArb, ({ files, calls, edits }) => {
        const facts = specsToFacts(files);
        for (const [index, call] of calls.entries()) {
          const ts = tsOf(0, call.at);
          const base: EvidenceFact =
            call.kind === "cmd" ? commandExecuted(ts) : testResult(ts, { passed: 1 });
          const fact = (
            call.callId === undefined ? base : { ...base, sourceCallId: call.callId }
          ) as EvidenceFact;
          facts.push({ fact, factId: `c${index}`, seq: facts.length + 1, batchId: 0 });
        }
        const result = clusterSession({
          sessionId: SESSION,
          facts,
          agentEvents: edits.map((edit) =>
            agentEvent("file_changed", tsOf(0, edit.at), { path: edit.file, callId: edit.callId }),
          ),
          semanticEvents: [],
          decisions: [],
        });
        for (const unit of result.units) {
          const ids = unit.agentCallIds ?? [];
          expect(ids).toEqual([...new Set(ids)].sort());
          if (unit.agentCallIds !== undefined) expect(ids.length).toBeGreaterThan(0);
          for (const entry of result.unitEvidenceFacts.get(unit.id) ?? []) {
            const fact = entry.fact;
            if (
              (fact.type === "command_executed" || fact.type === "test_result") &&
              fact.sourceCallId !== undefined
            ) {
              expect(ids).toContain(fact.sourceCallId);
            }
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("units always have non-empty files and a valid category", () => {
```

In `packages/semantic-core/src/coordinator.test.ts`, replace:

```ts
describe("PipelineCoordinator supersede", () => {
```

with:

```ts
describe("PipelineCoordinator unit versions", () => {
  it("bumps a unit's version when an agent call is linked to it", () => {
    const coordinator = new PipelineCoordinator();
    coordinator.ingest(hunk("src/a.ts", tsOf(0)));
    coordinator.flush();
    const [unit] = coordinator.snapshot().units;
    expect(unit).toBeDefined();
    expect(coordinator.decisionVersionOf(unit!.id)).toBe(1);

    coordinator.ingest(
      agentEvent("file_changed", tsOf(0, 1), { path: "src/a.ts", callId: "turn_a:item_2" }),
    );
    coordinator.flush();

    expect(coordinator.getUnit(unit!.id)?.agentCallIds).toEqual(["turn_a:item_2"]);
    expect(coordinator.decisionVersionOf(unit!.id)).toBe(2);
  });
});

describe("PipelineCoordinator supersede", () => {
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @jevcode/semantic-core exec vitest run src/clustering.test.ts src/clustering.property.test.ts src/coordinator.test.ts`
Expected: FAIL, 4 tests: "collects the sourceCallId…" (`expected undefined to deeply equal [ 'turn_a:item_1', 'turn_a:item_3' ]`), "links an agent file_changed call…" (`expected undefined to deeply equal [ 'turn_a:item_8' ]`), the property (`Property failed after 1 tests`), and "bumps a unit's version…" (`expected undefined to deeply equal [ 'turn_a:item_2' ]`). "omits the key…" passes.

- [ ] **Step 3: Compute `agentCallIds` in `packages/semantic-core/src/clustering.ts`**

At the end of `clusterSession`, replace:

```ts
      evidence: draft.evidence,
      createdAt,
      updatedAt,
    });
  }

  return {
    sessionId,
    units,
```

with:

```ts
      evidence: draft.evidence,
      createdAt,
      updatedAt,
    });
  }

  attachAgentCallIds(units, unitEvidenceFacts, facts, input.agentEvents);

  return {
    sessionId,
    units,
```

Replace:

```ts
export function buildPlaceholderTitle(files: readonly string[]): string {
```

with:

```ts
/**
 * Unit to agent-call join (R3), stored as ChangeUnit.agentCallIds:
 * 1. exact: the sourceCallId of every command_executed / test_result fact the
 *    unit owns;
 * 2. inferred: an agent file_changed with a callId links to every unit that owns
 *    the evidence fact for that path nearest in time (ties go to the lower fact
 *    seq). "Nearest", not "after": the watcher often sees a write before Codex
 *    reports it.
 * Ids are sorted and unique; the key is omitted when a unit has none.
 */
function attachAgentCallIds(
  units: ChangeUnit[],
  unitEvidenceFacts: ReadonlyMap<string, SequencedFact[]>,
  facts: readonly SequencedFact[],
  agentEvents: readonly NormalizedAgentEvent[],
): void {
  const callIds = new Map<string, Set<string>>();
  const addCall = (unitId: string, callId: string): void => {
    const set = callIds.get(unitId) ?? new Set<string>();
    set.add(callId);
    callIds.set(unitId, set);
  };
  const ownersByFactId = new Map<string, string[]>();
  for (const unit of units) {
    for (const entry of unitEvidenceFacts.get(unit.id) ?? []) {
      const owners = ownersByFactId.get(entry.factId) ?? [];
      if (!owners.includes(unit.id)) owners.push(unit.id);
      ownersByFactId.set(entry.factId, owners);
      const fact = entry.fact;
      if (
        (fact.type === "command_executed" || fact.type === "test_result") &&
        fact.sourceCallId !== undefined
      ) {
        addCall(unit.id, fact.sourceCallId);
      }
    }
  }
  const ownedFactsByPath = new Map<string, SequencedFact[]>();
  for (const entry of facts) {
    if (!ownersByFactId.has(entry.factId)) continue;
    for (const file of factFiles(entry.fact)) {
      const list = ownedFactsByPath.get(file) ?? [];
      list.push(entry);
      ownedFactsByPath.set(file, list);
    }
  }
  for (const event of agentEvents) {
    if (event.type !== "file_changed" || event.callId === undefined) continue;
    const eventMs = tsMs(event.ts);
    let nearest: SequencedFact | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const entry of ownedFactsByPath.get(event.path) ?? []) {
      const distance = Math.abs(tsMs(entry.fact.ts) - eventMs);
      if (
        distance < nearestDistance ||
        (distance === nearestDistance && nearest !== null && entry.seq < nearest.seq)
      ) {
        nearest = entry;
        nearestDistance = distance;
      }
    }
    if (nearest === null) continue;
    for (const unitId of ownersByFactId.get(nearest.factId) ?? []) addCall(unitId, event.callId);
  }
  for (const unit of units) {
    const ids = callIds.get(unit.id);
    if (ids !== undefined && ids.size > 0) unit.agentCallIds = [...ids].sort();
  }
}

export function buildPlaceholderTitle(files: readonly string[]): string {
```

(`ChangeUnit`, `NormalizedAgentEvent`, `SequencedFact`, `factFiles` and `tsMs` already exist in this file.)

- [ ] **Step 4: Run the clustering tests**

Run: `pnpm --filter @jevcode/semantic-core exec vitest run src/clustering.test.ts src/clustering.property.test.ts src/coordinator.test.ts`
Expected: clustering tests pass; only "bumps a unit's version…" still fails, now with `expected 1 to be 2` (the signature ignores the new field).

- [ ] **Step 5: Add `agentCallIds` to `unitSignature` in `packages/semantic-core/src/coordinator.ts`**

Replace:

```ts
function unitSignature(unit: ChangeUnit): string {
  return JSON.stringify({
    files: unit.files,
    symbols: unit.symbols.map((symbol) => symbol.name),
    evidence: unit.evidence,
    status: unit.status,
    category: unit.category,
    depChanges: unit.dependencyChanges,
  });
}
```

with:

```ts
function unitSignature(unit: ChangeUnit): string {
  return JSON.stringify({
    files: unit.files,
    symbols: unit.symbols.map((symbol) => symbol.name),
    evidence: unit.evidence,
    // A newly linked agent call is a new unit version (R3).
    agentCallIds: unit.agentCallIds ?? [],
    status: unit.status,
    category: unit.category,
    depChanges: unit.dependencyChanges,
  });
}
```

- [ ] **Step 6: Run the semantic-core suite and rebuild**

Run: `pnpm --filter @jevcode/semantic-core typecheck && pnpm --filter @jevcode/semantic-core test && pnpm --filter @jevcode/semantic-core build`
Expected: every command exits 0 (0 failed).

Run: `pnpm --filter "jevcode-desktop^..." build && pnpm --filter jevcode-desktop test && pnpm --filter jevcode-evals test`
Expected: both suites pass; desktop has no `Errors` line.

- [ ] **Step 7: Root checks**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r test && pnpm lint`
Expected: every command exits 0.

- [ ] **Step 8: Commit**

```bash
git add packages/semantic-core/src/clustering.ts packages/semantic-core/src/clustering.test.ts \
  packages/semantic-core/src/clustering.property.test.ts \
  packages/semantic-core/src/coordinator.ts packages/semantic-core/src/coordinator.test.ts
git commit -m "feat(semantic-core): join change units to the agent calls behind their evidence"
```

---

### Task A1-9: M1b, fixture provenance, real diffs and the failure-text fix

**Files:**
- Modify: `scripts/validate-fixtures.mjs` (new checks before `validateScenario`, one call inside it)
- Create: `scripts/fixture-diffs.mjs`
- Modify (generated): `fixtures/{api-break,dep-change,oauth,rate-limit,schema-change}/events.jsonl`
- Modify: `fixtures/oauth/golden_specs/oauth-linking-test-failure.json` (line 15)
- Modify: `fixtures/README.md`
- Test: `apps/desktop/src/main/pipeline/pipeline-runtime.test.ts` (line 493), `packages/semantic-core/src/fixtures.test.ts`

**Interfaces:**
- Consumes: A1-7 `prepareDiffForStorage(file: string, rawDiff: string): GitHunkDiff` from the built `apps/desktop/dist/main/pipeline/redactor.js`; A1-8 `agentCallIds` (asserted end to end).
- Produces (exact, index section 2.4, "Fixtures"): every agent event line has `turnId: "turn-<fixture>-1"`; command and tool start/complete pairs share `callId: "turn-<fixture>-1:item_<n>"` (n counts calls in line order); derived `command_executed`/`test_result` facts carry that `sourceCallId`; every `git_hunk` carries `diff` generated from `repo/` → `changes/` with `prepareDiffForStorage`, and its `added`/`removed` equal the diff's `+`/`-` lines; oauth has one `agent_reasoning` line (`callId "turn-oauth-1:item_4"`) immediately before "OAuth implementation complete; all checks pass."; the oauth failure message is "expected null to be 7" in events.jsonl, the golden spec and pipeline-runtime.test.ts. oauth grows from 49 to 50 records; lanes A2 and B select rows by content, never by line number (index section 4, "fixture drift").

- [ ] **Step 1: Add the failing validator checks**

In `scripts/validate-fixtures.mjs`, replace:

```js
function validateScenario(scenario) {
```

with:

```js
// Counts "+" and "-" lines after the first "@@" header, so "---"/"+++" file
// headers are never counted. scripts/fixture-diffs.mjs uses the same rule.
function diffLineCounts(text) {
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

function validateProvenance(prefix, eventsPath) {
  const records = readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    });
  const callIds = new Set();
  for (const record of records) {
    if (record !== null && typeof record.callId === "string") callIds.add(record.callId);
  }
  let diffsOk = true;
  let sourcesOk = true;
  for (const [index, record] of records.entries()) {
    if (record === null) continue;
    if (record.type === "git_hunk") {
      const diff = record.diff;
      if (diff === undefined) {
        check(`${prefix} line ${index + 1} git_hunk ${record.file} carries diff`, false);
        diffsOk = false;
        continue;
      }
      if (typeof diff.text === "string" && diff.truncated === false) {
        const counts = diffLineCounts(diff.text);
        if (counts.added !== record.added || counts.removed !== record.removed) {
          check(
            `${prefix} line ${index + 1} git_hunk ${record.file} +/- lines match added/removed`,
            false,
            `diff +${counts.added}/-${counts.removed}, fact +${record.added}/-${record.removed}`,
          );
          diffsOk = false;
        }
      }
    }
    if (
      (record.type === "command_executed" || record.type === "test_result") &&
      typeof record.repoId === "string" &&
      !callIds.has(record.sourceCallId)
    ) {
      check(
        `${prefix} line ${index + 1} ${record.type} sourceCallId names a call in the stream`,
        false,
        String(record.sourceCallId),
      );
      sourcesOk = false;
    }
  }
  check(`${prefix} every git_hunk diff matches its added/removed counts`, diffsOk);
  check(`${prefix} every derived command/test fact cites its agent call`, sourcesOk);
}

function validateScenario(scenario) {
```

and replace:

```js
    check(`${prefix} all ${recordCount} event records schema-valid`, allValid);
    if (lines.length > 0 && recordCount === lines.length) {
      check(`${prefix} every event record validated (${recordCount} records)`, true);
    }
  }
```

with:

```js
    check(`${prefix} all ${recordCount} event records schema-valid`, allValid);
    if (lines.length > 0 && recordCount === lines.length) {
      check(`${prefix} every event record validated (${recordCount} records)`, true);
    }
    validateProvenance(prefix, eventsPath);
  }
```

- [ ] **Step 2: Run the validator to verify it fails**

Run: `pnpm --filter @jevcode/contracts build && node scripts/validate-fixtures.mjs | tail -2`
Expected: the two lines `Checks: 195, passed: 149, failed: 46` and `VALIDATION FAILED`. (`| tail -2` hides the FAIL lines; without it they include `FAIL  [oauth] line 11 command_executed sourceCallId names a call in the stream -- undefined` and `FAIL  [oauth] line 14 git_hunk src/auth/identity.ts carries diff`.)

- [ ] **Step 3: Create `scripts/fixture-diffs.mjs`**

```js
// One-off, idempotent fixture generator for the trace viewer (A1-9).
//
// For each fixtures/<scenario>/events.jsonl it:
//   1. stamps turnId "turn-<scenario>-1" on every agent event (one Codex process);
//   2. gives each command/tool start and its completion one callId
//      "turn-<scenario>-1:item_<n>", n counting calls in line order (FIFO pairing
//      by command text or tool name), and an agent_reasoning line its own call;
//   3. stamps sourceCallId on each derived command_executed / test_result fact:
//      the open call with the same command, else the last one that closed;
//   4. recomputes every git_hunk from `git diff --no-index repo/<file> changes/<file>`:
//      added/removed from the raw diff, diff from prepareDiffForStorage;
//   5. oauth only: inserts one agent_reasoning line before the final claim and
//      fixes the failure text to what vitest prints for toBe(7) on null.
// Unchanged lines stay byte-identical; changed lines keep the file's JSON style.
//
// Needs built output: pnpm --filter "jevcode-desktop^..." build && pnpm --filter jevcode-desktop build
// Run from the repo root: node scripts/fixture-diffs.mjs
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prepareDiffForStorage } from "../apps/desktop/dist/main/pipeline/redactor.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCENARIOS = ["oauth", "rate-limit", "schema-change", "api-break", "dep-change"];

const OAUTH_CLAIM = "OAuth implementation complete; all checks pass.";
const OAUTH_REASONING = {
  type: "agent_reasoning",
  sessionId: "sess-oauth-0001",
  ts: "2026-09-18T09:00:42.000Z",
  text: "pnpm test reported 1 failed and 14 passed; the account-linking test still fails.",
};
const OAUTH_OLD_FAILURE = "expected 7 to be null";
const OAUTH_NEW_FAILURE = "expected null to be 7";

// Python json.dumps style (", " and ": "), used by fixtures/oauth/events.jsonl.
function spacedJson(value) {
  if (Array.isArray(value)) return `[${value.map(spacedJson).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${spacedJson(v)}`).join(", ")}}`;
  }
  return JSON.stringify(value);
}

function isAgentEvent(record) {
  return !("repoId" in record) && !("severity" in record) && !("kind" in record);
}

// Same rule as scripts/validate-fixtures.mjs: count lines after the first "@@".
function diffLineCounts(text) {
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

// Pinned flags keep the text independent of the user's git config and of the
// repository size (full blob ids, fixed prefixes and algorithm).
function rawFixtureDiff(dir, file) {
  const before = existsSync(path.join(dir, "repo", file)) ? `repo/${file}` : "/dev/null";
  const after = existsSync(path.join(dir, "changes", file)) ? `changes/${file}` : "/dev/null";
  let out;
  try {
    out = execFileSync(
      "git",
      [
        "-c",
        "core.quotePath=false",
        "diff",
        "--no-index",
        "--no-color",
        "--no-ext-diff",
        "--full-index",
        "--diff-algorithm=myers",
        "--indent-heuristic",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--",
        before,
        after,
      ],
      { cwd: dir, encoding: "utf8" },
    );
  } catch (error) {
    if (error.status !== 1) throw error;
    out = error.stdout;
  }
  // Present the diff as the git collector would see it: paths relative to the repo.
  return out
    .split("\n")
    .map((line) =>
      /^(diff --git |--- |\+\+\+ )/.test(line)
        ? line.replace(/(^|\s)([ab])\/(?:repo|changes)\//g, "$1$2/")
        : line,
    )
    .join("\n");
}

function processScenario(scenario) {
  const dir = path.join(ROOT, "fixtures", scenario);
  const eventsPath = path.join(dir, "events.jsonl");
  const turnId = `turn-${scenario}-1`;
  const input = readFileSync(eventsPath, "utf8").split("\n");
  const trailing = input.at(-1) === "" ? [""] : [];
  const lines = input.filter((line) => line.trim() !== "");
  const spaced = lines[0]?.startsWith('{"type": ') ?? false;
  const serialize = (record) => (spaced ? spacedJson(record) : JSON.stringify(record));

  const entries = lines.map((line) => ({ line, record: JSON.parse(line) }));
  if (scenario === "oauth" && !entries.some((entry) => entry.record.type === "agent_reasoning")) {
    const claimIndex = entries.findIndex(
      (entry) => entry.record.type === "agent_message" && entry.record.text === OAUTH_CLAIM,
    );
    if (claimIndex < 0) throw new Error("oauth: final claim message not found");
    entries.splice(claimIndex, 0, { line: null, record: { ...OAUTH_REASONING } });
  }

  let nextItem = 1;
  const openCalls = new Map();
  const lastClosed = new Map();
  const mint = () => `${turnId}:item_${nextItem++}`;

  const output = entries.map(({ line, record }) => {
    const next = { ...record };
    if (isAgentEvent(next)) {
      next.turnId = turnId;
      const family =
        next.type.startsWith("command_") ? "command" : next.type.startsWith("tool_") ? "tool" : null;
      const target = family === "command" ? next.command : family === "tool" ? next.tool : null;
      const key = `${family}\u0000${target}`;
      if (next.type === "command_started" || next.type === "tool_started") {
        next.callId = mint();
        openCalls.set(key, [...(openCalls.get(key) ?? []), next.callId]);
      } else if (next.type === "command_completed" || next.type === "tool_completed") {
        const queue = openCalls.get(key) ?? [];
        next.callId = queue.shift() ?? mint();
        openCalls.set(key, queue);
        if (family === "command") lastClosed.set(next.command, next.callId);
      } else if (next.type === "agent_reasoning") {
        next.callId = mint();
      }
    } else if (next.type === "command_executed" || next.type === "test_result") {
      const open = openCalls.get(`command\u0000${next.command}`) ?? [];
      const sourceCallId = open.at(-1) ?? lastClosed.get(next.command);
      if (sourceCallId !== undefined) next.sourceCallId = sourceCallId;
      if (scenario === "oauth" && next.type === "test_result") {
        next.failures = next.failures.map((failure) =>
          failure.message === OAUTH_OLD_FAILURE ? { ...failure, message: OAUTH_NEW_FAILURE } : failure,
        );
      }
    } else if (next.type === "git_hunk") {
      const raw = rawFixtureDiff(dir, next.file);
      const counts = diffLineCounts(raw);
      next.added = counts.added;
      next.removed = counts.removed;
      next.diff = prepareDiffForStorage(next.file, raw);
    }
    const changed = line === null || JSON.stringify(next) !== JSON.stringify(record);
    return changed ? serialize(next) : line;
  });
  writeFileSync(eventsPath, [...output, ...trailing].join("\n"));
  return output.length;
}

for (const scenario of SCENARIOS) {
  const count = processScenario(scenario);
  console.log(`fixture-diffs: ${scenario} ${count} records`);
}
```

- [ ] **Step 4: Build and regenerate the fixtures**

Run: `pnpm --filter "jevcode-desktop^..." build && pnpm --filter jevcode-desktop build && node scripts/fixture-diffs.mjs`
Expected output (after the build logs):

```
fixture-diffs: oauth 50 records
fixture-diffs: rate-limit 47 records
fixture-diffs: schema-change 25 records
fixture-diffs: api-break 18 records
fixture-diffs: dep-change 33 records
```

- [ ] **Step 5: Verify the validator passes and the generator is idempotent**

Run: `node scripts/validate-fixtures.mjs | tail -1`
Expected: `VALIDATION PASSED`.

Run: `git diff --stat -- fixtures | tail -1 && node scripts/fixture-diffs.mjs > /dev/null && git diff --stat -- fixtures | tail -1`
Expected: the same summary line twice (in verification: `5 files changed, 123 insertions(+), 122 deletions(-)`). A second run changes nothing.

Spot-check oauth: `grep -c '"turnId": "turn-oauth-1"' fixtures/oauth/events.jsonl` prints `21` (20 agent events plus the new reasoning line), and `grep -o '"message": "[^"]*"' fixtures/oauth/events.jsonl` prints `"message": "expected null to be 7"`.

- [ ] **Step 6: Fix the failure text in the golden spec and the runtime test**

In `fixtures/oauth/golden_specs/oauth-linking-test-failure.json`, replace:

```
            "message": "expected 7 to be null"
```

with:

```
            "message": "expected null to be 7"
```

In `apps/desktop/src/main/pipeline/pipeline-runtime.test.ts` (test "emits a completion surface from repository evidence when the agent claims success but a test fails"), replace:

```ts
        JSON.stringify(spec).includes("expected 7 to be null"),
```

with:

```ts
        JSON.stringify(spec).includes("expected null to be 7"),
```

(`fixtures/oauth/changes/tests/auth/oauth.test.ts:9` asserts `expect(identity.userId).toBe(7)` on a null value; vitest prints `expected null to be 7`.)

- [ ] **Step 7: Add the end-to-end provenance assertion**

In `packages/semantic-core/src/fixtures.test.ts`, append to the end of the file:

```ts
describe("fixture provenance (agent call joins)", () => {
  it("links oauth units to the agent calls that produced their evidence", () => {
    const { units } = runFixture("oauth");
    const testUnit = units.find((unit) => sameFileSet(unit.files, ["tests/auth/oauth.test.ts"]));
    expect(testUnit?.agentCallIds).toContain("turn-oauth-1:item_3");
    const manifestUnit = units.find((unit) => sameFileSet(unit.files, ["package.json"]));
    expect(manifestUnit?.agentCallIds).toContain("turn-oauth-1:item_2");
  });
});
```

(`turn-oauth-1:item_2` is `pnpm add google-auth-library`, `item_3` is `pnpm test`.)

- [ ] **Step 8: Document the fields in `fixtures/README.md`**

Replace:

```
Run `node scripts/validate-fixtures.mjs` from the repo root. It validates events against
the contracts schemas, referenced paths against `repo/` + `changes/`, golden-spec
structure, label schemas and slug cross-references, and expected-unit facts. Exit code is
non-zero on any failure.
```

with:

```
Run `node scripts/validate-fixtures.mjs` from the repo root. It validates events against
the contracts schemas, referenced paths against `repo/` + `changes/`, golden-spec
structure, label schemas and slug cross-references, expected-unit facts, that every
`git_hunk` diff matches its `added`/`removed` counts, and that every derived command or
test fact cites a `callId` in the stream. Exit code is non-zero on any failure.

## Provenance fields (trace viewer)

Every agent event carries `turnId: "turn-<scenario>-1"`: each fixture is one Codex process.
A command or tool start and its completion share `callId: "turn-<scenario>-1:item_<n>"`,
with `n` counting calls in line order. Each derived `command_executed` and `test_result`
fact carries `sourceCallId`, the `callId` of the command that produced it. Every `git_hunk`
carries `diff` (`{hash, bytes, text, truncated, redactions}`): the unified diff of
`repo/<file>` → `changes/<file>` after the desktop redaction policy, so the text shows
`[REDACTED:<kind>]` where a rule matched (for example `token: string` parameters in oauth).
`added`/`removed` equal that diff's `+`/`-` lines. oauth has one `agent_reasoning` line
before the final "all checks pass" claim. All of these fields are optional in the
contracts; streams without them still validate.

After editing `repo/`, `changes/` or a stream, rebuild
(`pnpm --filter "jevcode-desktop^..." build && pnpm --filter jevcode-desktop build`), run
`node scripts/fixture-diffs.mjs` (idempotent), then `node scripts/validate-fixtures.mjs`.
```

- [ ] **Step 9: Run every fixture consumer**

Run: `pnpm --filter "jevcode-desktop^..." build && for p in @jevcode/semantic-core @jevcode/ui-compiler @jevcode/jev-router jevcode-evals jevcode-desktop; do pnpm --filter "$p" test || break; done`
Expected: all five suites pass (0 failed); desktop has no `Errors` line.

Run: `pnpm --filter jevcode-desktop replay "$PWD/fixtures/oauth" "$PWD/apps/desktop/.test-tmp/replay-oauth" | tail -3`
Expected: the JSON summary ends with `"errors": []` and `}`. (`apps/desktop/.test-tmp/` is gitignored.)

- [ ] **Step 10: Root checks**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r test && pnpm lint`
Expected: every command exits 0.

- [ ] **Step 11: Commit**

```bash
git add scripts/validate-fixtures.mjs scripts/fixture-diffs.mjs \
  fixtures/api-break/events.jsonl fixtures/dep-change/events.jsonl fixtures/oauth/events.jsonl \
  fixtures/rate-limit/events.jsonl fixtures/schema-change/events.jsonl \
  fixtures/oauth/golden_specs/oauth-linking-test-failure.json fixtures/README.md \
  apps/desktop/src/main/pipeline/pipeline-runtime.test.ts \
  packages/semantic-core/src/fixtures.test.ts
git commit -m "test(fixtures): add call provenance, real redacted diffs and the vitest failure text"
```

---

### Task A1-10: M1c, `Decision.ts`, `JevDecisionLog.pass`, real suppression logging

**Files:**
- Modify: `apps/desktop/src/main/pipeline/jev-stage.ts` (three `buildJevDecisionRecord` calls, lines 146-162, 177-188, 215-226)
- Create: `apps/desktop/src/main/pipeline/jev-stage.test.ts`
- Modify: `apps/desktop/src/main/pipeline/pipeline-runtime.ts` (`answerDecision` ~line 550, `delegateDecision` ~line 585)
- Test: `apps/desktop/src/main/pipeline/pipeline-runtime.test.ts` (test "pauses on interrupt and injects records after a decision answer")
- Modify: `docs/SPEC.md` §8.5

**Interfaces:**
- Consumes: W0-4 `JevPassSchema = z.enum(["A", "B"])`, `JevDecisionLog.pass?: "A" | "B"`, `Decision.ts?: string` from `@jevcode/contracts`. Existing `buildJevDecisionRecord(input: BuildJevDecisionRecordInput): JevDecisionLog` (jev-router/src/logging.ts), unchanged: the lane adds `pass` by spreading its result, so `@jevcode/jev-router` is not edited.
- Produces (exact, index section 2.4): `Decision.ts = nowIso()` on the `answered` and `delegated` upserts. `JevDecisionLog.pass`: `"A"` on attention logs (including guardrail suppressions), `"B"` on projection logs. The guardrail-suppression log records `clientKindOf(result)` and `result.confidence`, not `"degrade"` and `1`. Lane B reads these for guardrail and decision steps.

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/main/pipeline/jev-stage.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  AttentionDecision,
  EvidenceFact,
  JevResult,
  UIIntent,
} from "@jevcode/contracts";
import { DegradeClient } from "@jevcode/jev-router";
import type { AttentionInput, JevClient, ProjectionInput } from "@jevcode/jev-router";
import { PipelineCoordinator } from "@jevcode/semantic-core";
import { openDb } from "@jevcode/storage";
import type { JevcodeDb } from "@jevcode/storage";
import { afterEach, describe, expect, it } from "vitest";

import { runJevStage } from "./jev-stage.js";

const SESSION = "sess_jev_stage";
const REPO = "repo_jev_stage";

// Heuristic answers relabeled as a typesafe client with a fixed confidence,
// so the logs show what the real client reported.
class TypesafeLikeClient implements JevClient {
  private readonly inner = new DegradeClient();

  async attention(batch: AttentionInput[]): Promise<JevResult<AttentionDecision>[]> {
    const results = await this.inner.attention(batch);
    return results.map((result) => ({
      ...result,
      value: { ...result.value, shouldSurface: true },
      confidence: 0.93,
      clientKind: "typesafe" as const,
    }));
  }

  async project(input: ProjectionInput): Promise<JevResult<UIIntent>> {
    const result = await this.inner.project(input);
    return { ...result, confidence: 0.91, clientKind: "typesafe" as const };
  }

  health(): ReturnType<JevClient["health"]> {
    return this.inner.health();
  }
}

function hunk(file: string, ts: string, isLockfile: boolean): EvidenceFact {
  return {
    type: "git_hunk",
    repoId: REPO,
    sessionId: SESSION,
    file,
    added: 12,
    removed: 2,
    isFormattingOnly: false,
    isConfigOnly: false,
    isLockfile,
    ts,
  };
}

const dirs: string[] = [];

function createDb(): JevcodeDb {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jevcode-jev-stage-"));
  dirs.push(dir);
  const db = openDb({ dbPath: path.join(dir, "jev.db") });
  db.upsertRepository({ id: REPO, path: "/work/jev", gitRoot: "/work/jev" });
  db.createSession({ id: SESSION, repoId: REPO });
  return db;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("runJevStage decision logs", () => {
  it("records the pass and the real client on attention, projection and suppression logs", async () => {
    const db = createDb();
    // Five minutes apart: two buckets, so the lockfile is its own unit.
    const facts = [
      hunk("src/app.ts", "2026-09-28T10:00:00.000Z", false),
      hunk("pnpm-lock.yaml", "2026-09-28T10:05:00.000Z", true),
    ];
    const coordinator = new PipelineCoordinator();
    for (const fact of facts) coordinator.ingest(fact);
    coordinator.flush();
    const units = coordinator.snapshot().units;
    const appUnit = units.find((unit) => unit.files.includes("src/app.ts"));
    const lockUnit = units.find((unit) => unit.files.includes("pnpm-lock.yaml"));
    expect(appUnit).toBeDefined();
    expect(lockUnit).toBeDefined();
    expect(lockUnit?.id).not.toBe(appUnit?.id);

    const { logs } = await runJevStage({
      db,
      coordinator,
      client: new TypesafeLikeClient(),
      sessionId: SESSION,
      taskPrompt: "demo",
      facts,
      decisions: [],
      semanticEvents: [],
      nowIso: () => "2026-09-28T10:10:00.000Z",
    });

    const suppression = logs.find((log) => log.changeUnitId === lockUnit?.id);
    expect(suppression).toMatchObject({
      pass: "A",
      clientKind: "typesafe",
      confidence: 0.93,
      output: { shouldSurface: false, guardrailSuppression: true },
    });
    expect(
      logs.filter((log) => log.changeUnitId === appUnit?.id).map((log) => log.pass),
    ).toEqual(["A", "B"]);
    // pass survives the storage round trip (no zod strip).
    expect(
      db
        .listJevDecisions(SESSION)
        .map((log) => log.pass)
        .sort(),
    ).toEqual(["A", "A", "B"]);
    db.close();
  });
});
```

In `apps/desktop/src/main/pipeline/pipeline-runtime.test.ts`, in the test "pauses on interrupt and injects records after a decision answer", replace:

```ts
      expect(collected.channels.get("decision:resolved")?.length ?? 0).toBeGreaterThan(0);
      const agentStates = collected.channels.get("agent:state") ?? [];
```

with:

```ts
      expect(collected.channels.get("decision:resolved")?.length ?? 0).toBeGreaterThan(0);
      const decisionRows = db
        .listEvents(sessionId)
        .filter((event) => event.type === "decision")
        .map((event) => JSON.parse(event.payloadJson) as Decision);
      const answered = decisionRows.find(
        (row) => row.id === "dec-mock-0001" && row.status === "answered",
      );
      expect(answered?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(decisionRows.find((row) => row.status === "open")?.ts).toBeUndefined();
      const agentStates = collected.channels.get("agent:state") ?? [];
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter "jevcode-desktop^..." build && pnpm --filter jevcode-desktop exec vitest run src/main/pipeline/jev-stage.test.ts src/main/pipeline/pipeline-runtime.test.ts`
Expected: FAIL, 2 tests. jev-stage: `expected { id: 'jev:…', …(10) } to match object { pass: 'A', …(3) }` (today the suppression log says `clientKind: "degrade"`, `confidence: 1`, no `pass`). pipeline-runtime: `.toMatch() expects to receive a string, but got undefined`.

- [ ] **Step 3: Record the pass and the real client in `apps/desktop/src/main/pipeline/jev-stage.ts`**

Replace:

```ts
      if (pre.forced.shouldSurface === false) {
        const log = buildJevDecisionRecord({
          sessionId: deps.sessionId,
          changeUnitId: unit.id,
          inputHash: hashInput(input),
          output: {
            shouldSurface: false,
            clamps: pre.clamps,
            guardrailSuppression: true,
          },
          confidence: 1,
          probabilities: undefined,
          latencyMs: latencyOf(started),
          clientKind: "degrade",
          clamps: pre.clamps,
          ts: deps.nowIso(),
        });
```

with:

```ts
      if (pre.forced.shouldSurface === false) {
        // The client did answer this unit; the guardrail overrode it. Log who
        // answered and how sure it was, not a synthetic degrade at 1.0.
        const log: JevDecisionLog = {
          ...buildJevDecisionRecord({
            sessionId: deps.sessionId,
            changeUnitId: unit.id,
            inputHash: hashInput(input),
            output: {
              shouldSurface: false,
              clamps: pre.clamps,
              guardrailSuppression: true,
            },
            confidence: result.confidence,
            probabilities: undefined,
            latencyMs: latencyOf(started),
            clientKind: clientKindOf(result),
            clamps: pre.clamps,
            ts: deps.nowIso(),
          }),
          pass: "A",
        };
```

Replace:

```ts
      const attentionLog = buildJevDecisionRecord({
        sessionId: deps.sessionId,
        changeUnitId: unit.id,
        inputHash: hashInput(input),
        output: attention,
        confidence: result.confidence,
        probabilities: attention.probabilities,
        latencyMs: latencyOf(started),
        clientKind: clientKindOf(result),
        clamps: clamped.clamps,
        ts: deps.nowIso(),
      });
```

with:

```ts
      const attentionLog: JevDecisionLog = {
        ...buildJevDecisionRecord({
          sessionId: deps.sessionId,
          changeUnitId: unit.id,
          inputHash: hashInput(input),
          output: attention,
          confidence: result.confidence,
          probabilities: attention.probabilities,
          latencyMs: latencyOf(started),
          clientKind: clientKindOf(result),
          clamps: clamped.clamps,
          ts: deps.nowIso(),
        }),
        pass: "A",
      };
```

Replace:

```ts
      const projectionLog = buildJevDecisionRecord({
        sessionId: deps.sessionId,
        changeUnitId: unit.id,
        inputHash: hashInput({ ...input, attention }),
        output: intent,
        confidence: policy.confidence,
        probabilities: policy.probabilities,
        latencyMs: latencyOf(projectionStarted),
        clientKind: clientKindOf(policy),
        clamps: clampedProjection.clamps,
        ts: deps.nowIso(),
      });
```

with:

```ts
      const projectionLog: JevDecisionLog = {
        ...buildJevDecisionRecord({
          sessionId: deps.sessionId,
          changeUnitId: unit.id,
          inputHash: hashInput({ ...input, attention }),
          output: intent,
          confidence: policy.confidence,
          probabilities: policy.probabilities,
          latencyMs: latencyOf(projectionStarted),
          clientKind: clientKindOf(policy),
          clamps: clampedProjection.clamps,
          ts: deps.nowIso(),
        }),
        pass: "B",
      };
```

- [ ] **Step 4: Timestamp decision answers in `apps/desktop/src/main/pipeline/pipeline-runtime.ts`**

Replace:

```ts
    const answered: Decision = { ...decision, status: "answered", answer: structured };
```

with:

```ts
    // ts: when the status changed (R4); readers fall back to the row ts.
    const answered: Decision = {
      ...decision,
      status: "answered",
      answer: structured,
      ts: this.nowIso(),
    };
```

Replace:

```ts
    const delegated: Decision = { ...decision, status: "delegated", answer: structured };
```

with:

```ts
    const delegated: Decision = {
      ...decision,
      status: "delegated",
      answer: structured,
      ts: this.nowIso(),
    };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter jevcode-desktop typecheck && pnpm --filter jevcode-desktop exec vitest run src/main/pipeline/jev-stage.test.ts src/main/pipeline/pipeline-runtime.test.ts && pnpm --filter jevcode-desktop test`
Expected: typecheck exits 0; both files pass; the whole desktop suite passes with no `Errors` line.

- [ ] **Step 6: Document the log fields in SPEC §8.5**

In `docs/SPEC.md` §8.5, replace:

```
Every call result is stored (`jev_decisions`: inputs hash, outputs, confidence, probabilities, latency, client kind, guardrail clamps applied). Debug panel (`Cmd/Ctrl+Shift+J` overlay) shows the last 50 per session. This satisfies PRD §59.17 and enables calibration (§14).
```

with:

```
Every call result is stored (`jev_decisions`: inputs hash, outputs, confidence, probabilities, latency, client kind, guardrail clamps applied). Debug panel (`Cmd/Ctrl+Shift+J` overlay) shows the last 50 per session. This satisfies PRD §59.17 and enables calibration (§14). Each log carries `pass`: `"A"` for attention, including guardrail suppressions, and `"B"` for projection. A unit suppressed by a guardrail is logged with the client's real `clientKind` and confidence, the guardrail's clamps, and `output.guardrailSuppression: true`.
```

- [ ] **Step 7: Root checks**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r test && pnpm lint`
Expected: every command exits 0.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/main/pipeline/jev-stage.ts apps/desktop/src/main/pipeline/jev-stage.test.ts \
  apps/desktop/src/main/pipeline/pipeline-runtime.ts \
  apps/desktop/src/main/pipeline/pipeline-runtime.test.ts docs/SPEC.md
git commit -m "feat(desktop): log the Jev pass and the real client on suppressions; timestamp decision answers"
```

---

### Task A1-11: M1c, graph node domain ids; AgentEvent nodes keyed by `callId`

**Files:**
- Modify: `packages/semantic-core/src/graph.ts` (lines 86, 99, 209-213, 224, 237, 253-255)
- Test: `packages/semantic-core/src/graph.test.ts`

**Interfaces:**
- Consumes: A1-2 `callId?` on the call variants of `NormalizedAgentEvent`.
- Produces (exact, index section 2.4): `projectGraph` node `data` gains the domain id: ChangeUnit `unitId`, File `path`, Decision `decisionId`, Validation `validationId`, Failure `failureId`. AgentEvent node ids hash `` `${type}\u0000${callId}` `` when `callId` is present (data gains `callId`); events without it keep the `type + ts` key. No schema change: graph payloads are a `z.record` (packages/storage/src/local-schemas.ts). No v1 consumer (graph rows are hidden in the viewer).

- [ ] **Step 1: Write the failing tests**

In `packages/semantic-core/src/graph.test.ts`, replace:

```ts
  it("is deterministic for identical inputs", () => {
```

with:

```ts
  it("keys AgentEvent nodes by callId, so same-type same-ts calls stay apart", () => {
    const ts = tsOf(0, 1);
    const graph = graphFor([], {
      agentEvents: [
        { type: "command_started", sessionId: SESSION, callId: "turn_a:item_1", command: "pnpm lint", ts },
        { type: "command_started", sessionId: SESSION, callId: "turn_a:item_2", command: "pnpm test", ts },
        { type: "agent_message", sessionId: SESSION, role: "assistant", text: "a", ts },
        { type: "agent_message", sessionId: SESSION, role: "assistant", text: "b", ts },
      ],
    });
    const agentNodes = graph.nodes.filter((node) => node.type === "AgentEvent");
    expect(agentNodes.map((node) => node.data?.["callId"])).toEqual([
      "turn_a:item_1",
      "turn_a:item_2",
      undefined,
    ]);
  });

  it("puts the domain id in every entity node's data", () => {
    const facts: SequencedFact[] = [
      seq({ fact: fileChanged("tests/a.test.ts", "added", tsOf(0)), factId: "f1", seq: 1, batchId: 0 }),
      seq({
        fact: testResult(tsOf(0, 1), {
          passed: 1,
          failed: 1,
          failures: [{ file: "tests/a.test.ts", testName: "run works", message: "boom" }],
        }),
        factId: "f2",
        seq: 2,
        batchId: 0,
      }),
    ];
    const graph = graphFor(facts, {
      decisions: [
        {
          id: "dec-1",
          sessionId: SESSION,
          title: "t",
          context: "c",
          severity: "optional",
          options: [],
          affectedChangeUnits: [],
          evidence: [],
          status: "open",
        },
      ],
    });
    const byType = (type: string) => graph.nodes.filter((node) => node.type === type);
    for (const node of byType("ChangeUnit")) expect(node.data?.["unitId"]).toMatch(/^cu_/);
    expect(byType("File").map((node) => node.data?.["path"])).toEqual(["tests/a.test.ts"]);
    expect(byType("Decision").map((node) => node.data?.["decisionId"])).toEqual(["dec-1"]);
    expect(byType("Validation")[0]?.data?.["validationId"]).toMatch(/^val_/);
    expect(byType("Failure")[0]?.data?.["failureId"]).toMatch(/^fail_/);
  });

  it("is deterministic for identical inputs", () => {
```

The two `agent_message` events share type and ts and still collapse into one node: that legacy key is unchanged on purpose.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @jevcode/semantic-core exec vitest run src/graph.test.ts`
Expected: FAIL, 2 tests: `expected [ undefined, undefined ] to deeply equal [ 'turn_a:item_1', …(2) ]` and `.toMatch() expects to receive a string, but got undefined`.

- [ ] **Step 3: Add domain ids and call keys in `packages/semantic-core/src/graph.ts`**

Replace:

```ts
    addNode("ChangeUnit", id, unit.title, { category: unit.category, status: unit.status });
```

with:

```ts
    addNode("ChangeUnit", id, unit.title, {
      unitId: unit.id,
      category: unit.category,
      status: unit.status,
    });
```

Replace:

```ts
        addNode("File", fileNode, file);
```

with:

```ts
        addNode("File", fileNode, file, { path: file });
```

Replace:

```ts
    addNode("Validation", validationNode, validation.command, {
      status: validation.status,
```

with:

```ts
    addNode("Validation", validationNode, validation.command, {
      validationId: validation.id,
      status: validation.status,
```

Replace:

```ts
    addNode("Failure", failureNode, failure.testName, { file: failure.file });
```

with:

```ts
    addNode("Failure", failureNode, failure.testName, {
      failureId: failure.id,
      file: failure.file,
    });
```

Replace:

```ts
    addNode("Decision", decisionNode, decision.title, { severity: decision.severity, status: decision.status });
```

with:

```ts
    addNode("Decision", decisionNode, decision.title, {
      decisionId: decision.id,
      severity: decision.severity,
      status: decision.status,
    });
```

Replace:

```ts
  for (const event of input.agentEvents) {
    const eventNode = nodeId("evt", sessionId, event.type + event.ts);
    addNode("AgentEvent", eventNode, event.type, { ts: event.ts });
```

with:

```ts
  for (const event of input.agentEvents) {
    // Keyed by callId when present: two calls of one type at the same ts are
    // two nodes. Legacy events keep the type + ts key (and its collapse).
    const callId = "callId" in event ? event.callId : undefined;
    const eventNode = nodeId(
      "evt",
      sessionId,
      callId !== undefined ? `${event.type}\u0000${callId}` : event.type + event.ts,
    );
    addNode(
      "AgentEvent",
      eventNode,
      event.type,
      callId !== undefined ? { ts: event.ts, callId } : { ts: event.ts },
    );
```

- [ ] **Step 4: Run the tests to verify they pass, and rebuild**

Run: `pnpm --filter @jevcode/semantic-core typecheck && pnpm --filter @jevcode/semantic-core test && pnpm --filter @jevcode/semantic-core build`
Expected: every command exits 0 (0 failed).

- [ ] **Step 5: Root checks**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r test && pnpm lint`
Expected: every command exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/semantic-core/src/graph.ts packages/semantic-core/src/graph.test.ts
git commit -m "feat(semantic-core): put domain ids in graph node data and key agent nodes by callId"
```

---

## Lane completion

- [ ] **Run the lane exit checks** (index section 4, merge procedure):

```bash
git rebase main
pnpm install --frozen-lockfile
pnpm -r build
pnpm -r typecheck && pnpm -r test && pnpm lint
node scripts/validate-fixtures.mjs | tail -1
git log --oneline main..HEAD
```

Expected: every command exits 0; the validator prints `VALIDATION PASSED`; the log shows the 11 task commits (A1-1 … A1-11), none with a `Claude-Session:` trailer. `git rebase main` is a no-op when A1 merges first in W1. If a conflict appears, resolve it in the listed files only and rerun the checks.

## Coverage against the binding decisions

| Decision | Task |
|---|---|
| R1 DB 0700/0600 + POSIX test, separate PR | A1-1 (branch `tv/a1-m0-db-modes`) |
| R2 `turnId` via `EventNormalizerContext`, `callId = ${turnId}:${item.id}`, `agent_reasoning` | A1-2 |
| R2/D10 `agent_interrupted` (interrupt, steer, stop), paused not failed, codex-adapter.test.ts:190-203 | A1-3 |
| R2 resume-budget `agent_failed` persisted before the emit | A1-3 |
| R2 `sourceCallId` via `observeCommand`/`observeTestOutput` | A1-4 |
| R3 canonical `factContentId`; zod no-strip guard | A1-5 |
| R3 `prepareDiff` injection (default `not_captured`), change-only emission | A1-6 |
| R3 desktop diff policy (secret paths, prefixed `env_value`, 32 KiB at a hunk boundary); double push removed | A1-7 |
| R3 `agentCallIds` in `clusterSession` and `unitSignature` | A1-8 |
| R3 fixtures (`callId`, `sourceCallId`, `diff`, one `agent_reasoning`), oauth failure text, validator `+`/`-` check | A1-9 |
| R4 `Decision.ts`, `JevDecisionLog.pass`, real suppression `clientKind`/confidence | A1-10 |
| R4 graph domain ids | A1-11 |
| R4 SPEC §4.1–4.3 (W0-4), §7 (A1-6), §8.5 (A1-10); codex-spike §3 (A1-2, A1-3); D9 §18 check (A1-3) | as listed |
| D11 no rewrite of stored rows, no legacy resolver | every task (append-only; optional fields) |

## Known risks for the lane

- **Token rule over-redaction in stored diffs.** `redactText`'s `token` rule matches `token: string` in TypeScript, so oauth's stored diff shows `verifyIdToken(token=[REDACTED:token])`. It fails safe (no leak) but reads badly in the viewer; tightening the rule for code is a separate PR alongside the pattern false positives already listed under "Separate PRs".
- **Change-only emission changes live clustering.** Unchanged dirty files no longer re-emit every 5 s with a new `ts`, so live buckets can split where they used to merge under the 120 s gap. Fixtures are unaffected (verified); watch soak unit counts (lane A2-7 reports them).
- **Codex's real SIGINT output is unverified on 0.155+.** The adapter treats `turn.completed`, `turn.failed`, an auth `agent_failed` and a bare exit as the interrupted process's terminal signal; if a future Codex emits more than one, only the first is reported and the rest are dropped, which is the intended behavior.
