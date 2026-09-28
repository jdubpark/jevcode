# Trace Viewer Read Path (Lane A2, Milestone M2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the trace viewer a read-only path to stored jevcode sessions: a `query_only` SQLite reader, a main-process trace service (fact ids, 16 KiB clipping), three bounded `trace:*` IPC channels exposed as `window.jevcode.trace`, redacted `trace.json` bundles from `replay` and `replay export`, and a soak run that times full-session reads and single `trace:rows` calls, generates the spec §10 trace-profile reference input and can keep its database.

**Architecture:** `packages/storage/src/trace-reader.ts` opens a second better-sqlite3 connection on the same database file with `PRAGMA query_only = ON` and reads the existing `events`, `sessions` and `repositories` tables (no migration). `apps/desktop/src/main/trace-service.ts` turns reader rows into contract `TraceRow`s (`factId` from `factContentId` before clipping, long strings clipped to head and tail). Every consumer goes through the service: `trace-ipc.ts` on the existing `handle` wrapper, `trace-bundle.ts` (redaction and `$HOME` to `~`) used by `runReplay` and `exportMain`, and `scripts/soak.mjs`. The renderer API gains a read-only `trace` namespace. The viewer's `TraceSource` is session-bound (spec §7.7, UI index §1.2(b)), so lane M5 adapts the namespace with `createIpcTraceSource(bridge.trace, sessionId)`; its `summary()` uses the exact-id `trace:listSessions({ sessionId })` lookup, which also returns a session with zero events.

**Tech Stack:** TypeScript 5.9.3 (NodeNext, `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), better-sqlite3 11.10.0 (bundled SQLite 3.49.2 with `json_each`), zod 3.25.76, vitest 3.2.7, Electron 33 main process, Node 22, pnpm 9.15.0.

**Spec:** `docs/superpowers/specs/2026-09-28-trace-viewer-design.md`, sections "User decisions" (D2, D9), "Accepted recommendations (data)" (R2, R5) and "Out of v1". Interface contract: `docs/superpowers/plans/2026-09-28-trace-viewer-interfaces.md` §2.1 (`trace.ts` and the paging contract), §2.5 (A2 read path API), §3 (A2 task list), §4 (waves, fixture drift) and §5 (gotchas), amended by `docs/superpowers/plans/2026-09-28-trace-viewer-interfaces-ui.md` §1.3 (the `sessionId` lookup on `trace:listSessions`). Spec sections this lane implements beyond the base index: §5.2 and §5.4 (`sessionId?`), §5.6 (`JEVCODE_SOAK_PROFILE=trace`, `JEVCODE_SOAK_KEEP_DB`, `storedRows`, `consumedRows`) and §10 (the M2 budgets and the measuring method). On any conflict the decision record wins, then the spec, then the interfaces file, then this file.

## Interface deviations

Each item changes or sharpens interfaces §1 or §2.5. Names and signatures in §2.5 are otherwise used verbatim.

1. **`docs/security.md` joins A2's files (task A2-6).** The index file map omits it, but this lane must add the viewer row to the SPEC §12 checklist. No other lane edits `docs/security.md`. Index §1 should list `docs/security.md mod: row 7, trace viewer read-only guarantee [A2-6]`.
2. **`writeTraceBundle` writes rows one at a time** instead of building one `JSON.stringify(bundle)` string. The bytes are identical (`JSON.stringify(bundle) + "\n"`, pinned by a test). Reason: on 2026-09-28 the full soak session held 110,940 trace rows and exported to a 177 MB file, and a session near the 1M-event cap would approach V8's maximum string length.
3. **Bundle redaction covers `row.payload` and `session`, and copies the envelope unchanged** (`seq`, `type`, `ts`, `clipped`, `factId`). §2.5 says "every string in session and rows". The envelope holds machine values, and `factId` must stay the pre-redaction content id.
4. **Redaction count and home mapping rules** (not specified in §2.5): a string's `redactText` hits count only when redaction changed the string, so an already-redacted marker such as `token=[REDACTED:token]` is not counted again. `homeDir` maps to `~` only where a path segment ends (`/Users/ann` never rewrites `/Users/anna`), and `""` or `"/"` never map.
5. **`buildTraceBundle` restamps `session.lastEventSeq` and `session.state` from the final page**, so the summary describes exactly the bundled rows.
6. **Reader errors:** `TraceReader.rows` throws `Error("trace reader: unknown session <id>")` for a missing session row, and `rows`/`listSessions` throw `RangeError` for a non-integer or out-of-range `afterSeq` or `limit`. The service checks the session first and throws `IpcError("UNKNOWN_SESSION")`, so IPC callers never see the plain error.
7. **`toTraceRow` omits `payload` and `factId` when `payloadJson` is not valid JSON** instead of throwing. This applies §2.1's rule "consumers treat a missing payload as an invalid_row" to damaged rows, so one bad row cannot make a session unreadable.
8. **`clipPayload` never splits a UTF-16 surrogate pair**; the head or the tail may be one code unit shorter than `maxChars / 2`. It throws `RangeError` when `maxChars < 2`.
9. **The service clamps limits** (`listSessions` to `TRACE_LIST_SESSIONS_MAX`, `rows` to `TRACE_ROWS_PAGE_MAX`) as well as the IPC schemas, because the export CLI and the soak call it directly. `readAllRows` defaults `pageSize` to `TRACE_ROWS_PAGE_MAX`.
10. **The soak writes its optional bundle after `stopSession`**, so the bundle carries the terminal state. The timed read stays before `stopSession`, as §2.5 says.
11. **`exportMain` accepts exactly `--db`, `--session` and `--out`**, each with a non-empty value. Anything else prints the usage line. Every failure returns `1` and prints `export: …` to stderr; it never throws. It also exports `EXPORT_USAGE`.
12. **`trace:listSessions` takes an optional exact `sessionId`** (UI index §1.3; spec §5.2 and §5.4). `ListTraceSessionsOptions`, `TraceService.listSessions`, `TraceListSessionsPayloadSchema` (`z.string().min(1).optional()`) and `JevcodeApi.trace.listSessions` all gain `sessionId?: string`. With it the reader returns at most that one session (none when `repoId` is also given and differs), and it does **not** hide a session whose `lastEventSeq` is 0; without it the listing still hides zero-event sessions. Lane M5 depends on it: `createIpcTraceSource(...).summary()` calls `listSessions({ sessionId, limit: 1 })` for a trace window opened before the agent logs anything, and `trace:requestChanges` checks that the session exists the same way.
13. **`JevcodeApi.trace` is no longer "structurally a `TraceSource`".** W0-6 (UI index §1.2(b), spec §7.7) made `TraceSource` session-bound (`sessionId`, `summary()`, `rows(request?)`, `payloads(seqs)`, `now()`), so A2-4 drops that claim and its `TraceSource` type test and pins the namespace keys instead. Lane M5 builds the port with `createIpcTraceSource(bridge.trace, sessionId)` and replaces the keys test when it adds `open` and `requestChanges`.
14. **`scripts/soak.mjs` gains the spec §5.6 switches and fields.** `JEVCODE_SOAK_PROFILE=trace` generates the spec §10 reference input (seeded, so every run is identical; the default profile's stream is unchanged); any other non-empty value exits 1 with `SOAK_FAIL: unknown JEVCODE_SOAK_PROFILE …`. `JEVCODE_SOAK_KEEP_DB=<path>` copies the closed database (mode 0600) before the `rmSync`. The printed JSON gains `profile`, `storedRows` and `consumedRows` (spec §5.6) beside the base index's `traceRows`; `consumedRows` equals `traceRows`, and `storedRows` replaces this file's earlier `traceLastSeq` (seq is gapless, so the last seq counts every stored row). Lanes 06 (C2-16) and 08 (D-8) depend on all three.
15. **The soak measures the two M2 budgets the spec §10 way.** `traceReadMs` is the median of 5 full reads after 1 discarded warm-up (`traceReadRunsMs` lists the 5), not one cold read; `tracePageMs` times single `trace:rows` calls at `TRACE_ROWS_PAGE_DEFAULT` (the viewer's page size) until 300 calls are timed, for the spec §12 M2 exit "`trace:rows` p95 ≤ 50 ms in main". Each budget prints a `soak: WARN …` line when missed, never a failure.

## Global Constraints

Binding values, copied verbatim from the binding decision record that the spec carries (sections named in the header):

- D2: "v1 opens jevcode sessions only: the SQLite store, replay.db outputs, and fixture events.jsonl via the replay CLI's trace.json bundle. No Codex-rollout or Claude-transcript importers in v1. Keep the model's input (TraceRow) source-agnostic."
- D9: "the viewer itself never writes."
- R2: "exitCode stays `?? -1` in storage; the viewer renders -1 as "unknown", never failed. Every new field OPTIONAL (rebuildSession re-parses stored rows and throws on failure, db.ts:191-197)."
- R5: "storage/src/trace-reader.ts openTraceReader(dbPath): second better-sqlite3 connection, PRAGMA query_only = ON, statements listSessions (join repositories, hide zero-event sessions, ORDER BY startedAt DESC, id), rows (seq > ? AND type IN (...) ORDER BY seq LIMIT ?), payloads (seq list)."
- R5: "apps/desktop/src/main/trace-service.ts attaches factId (canonical) and clips strings > 16 KiB to head+tail with clipped=true."
- R5: "IPC via the existing handle wrapper (ipc.ts:129-143): trace:listSessions {repoId?, limit<=500}, trace:rows {sessionId, afterSeq?, limit<=5000}, trace:payloads {sessionId, seqs 1-50}. Handlers can reach only the reader (never reloadPending/instruction router/Jev/network)."
- R5: "Live follow = poll trace:rows {afterSeq} every 1 s until the session state is terminal. NO SQL migration in v1."
- R5: "Export: runReplay writes <outDir>/trace.json; replayMain gains `export --db --session --out`; buildTraceBundle runs redactText over every string and maps $HOME to ~. soak.mjs times a full-session read. Budget: full soak-session read <= 1.5 s in main."
- Out of v1: "sharing/export outside the machine" and "SQL migrations/derived columns/join tables".

Values fixed by the interfaces file (§2.1, §2.5, Global Constraints):

- `TRACE_CLIP_CHARS = 16_384` UTF-16 code units. `TRACE_LIST_SESSIONS_DEFAULT = 100`, `TRACE_LIST_SESSIONS_MAX = 500`, `TRACE_ROWS_PAGE_DEFAULT = 2_000`, `TRACE_ROWS_PAGE_MAX = 5_000`, `TRACE_PAYLOADS_MAX = 50`. Import them from `@jevcode/contracts`; never repeat the numbers in source.
- Paging contract: rows with `afterSeq < seq <= lastSeq` and `type` in `TRACE_ROW_TYPES`, ascending, at most `limit`, from one read transaction; `nextAfterSeq` is the last row's seq when `rows.length === limit`, else `null`.
- No new tables, columns or indexes; `LATEST_SCHEMA_VERSION` does not change.
- This lane edits no `package.json`, no `pnpm-lock.yaml` and no `eslint.config.mjs`. A step that seems to need a new dependency stops and escalates.
- `apps/desktop/src/main/pipeline/*` belongs to lane A1. Import `redactText` from `pipeline/redactor.ts`; never edit it.
- Tests select fixture rows by content (type, command text, fact fields), never by line number or seq literal (index §4, "Fixture drift").
- Node `>=22`. zod 3 only.
- Commits use conventional messages (`feat(storage): …`, `feat(desktop): …`, `perf(scripts): …`), the repository's configured git identity, and no `Claude-Session:` trailer.
- Never run `git stash`; set work aside with a WIP commit. Create worktrees with `git worktree add -b <branch> <path> <base>`, never `-f`.
- The shell is zsh: write `${var}:suffix`, never `"$var:suffix"`, when a colon follows a variable. Do not put `# comments` after commands.

Values fixed by the UI index §1.3 and the spec (interface deviations 12-15):

- `trace:listSessions {repoId?, sessionId?, limit ≤ 500}` (spec §5.4). "`sessionId` is an exact-match filter the trace window uses for its summary, and returns the session even with zero events" (spec §5.2). Spec §11 M2: "a zero-event session is readable by exact id and yields `{rows: [], nextAfterSeq: null, lastSeq: 0}`".
- Spec §5.6: "With `JEVCODE_SOAK_PROFILE=trace` it draws `command_completed.stdout` sizes from {0.2, 2, 8, 32, 64} KiB and assistant texts from 0.2–4 KiB, and emits `command_started`/`command_completed` pairs with `callId`, an agent `file_changed` before each feature hunk, and an `agent_started` steer every 500 records. `JEVCODE_SOAK_KEEP_DB=<path>` copies the DB before the `rmSync`."
- Spec §10 budgets gated at the M2 exit: full soak-session read in main ≤ 1.5 s; one `trace:rows` call in main (trace profile) p95 ≤ 50 ms. Method: "Single-run budgets (soak read, …) report the median of 5 runs after 1 discarded warm-up; p95 budgets use at least 300 samples."
- The full soak (`node scripts/soak.mjs`, 10,000 records) now stores about 455,000 events and takes about 11 minutes, longer than a 10-minute tool timeout: always start it as a background command and wait for it to exit. Quick checks use `JEVCODE_SOAK_EVENTS=2000` (about 12 seconds).

## Review Focus

Six inputs the spec implies that a happy-path test would miss, most likely first. Each names the test that pins it and the task that owns it.

1. **A live session appends while the viewer pages.** Expected: every trace-type seq in `1..lastSeq` arrives exactly once, and no appended row is skipped. Test: A2-1 "pages stay gapless while the writer appends".
2. **A trace window opened on a session that has not logged an event yet** (the Trace button pressed right after start). Expected: `trace:listSessions({ sessionId })` returns that session with `lastEventSeq: 0`, `trace:rows` returns `{rows: [], nextAfterSeq: null, lastSeq: 0, state}`, the default listing still hides it, an unknown id returns `[]`, and `sessionId: ""` is rejected with `INVALID_PAYLOAD`. Tests: A2-1 "lists a zero-event session by exact id"; A2-3 "lists a zero-event session by exact id and reads it as an empty page".
3. **Oversized strings** (a 1 MiB `stdout`, a 40 KiB test failure message, emoji at the cut). Expected: `clipped: true`, both 8,192-character halves intact, `factId` computed before clipping, no split surrogate pair. Tests: A2-2 "clips a 1 MiB stdout to head and tail" and "never splits a surrogate pair at either cut".
4. **A damaged stored row** (`payloadJson` that is not JSON). Expected: the page still loads, that row arrives without `payload` or `factId`, and its neighbours are intact. Test: A2-2 "turns a damaged payload row into a row without payload and keeps its neighbors".
5. **Secrets and home paths in an exported bundle**, including a sibling home directory (`/Users/tester2`) and already-redacted markers. Expected: no secret text, `$HOME` becomes `~` only at a path boundary, `redactionCount` counts new hits only, `factId` unchanged. Tests: A2-5 "redacts tokens and maps home" and "maps home only at a path boundary and does not recount redacted markers".
6. **Export CLI misuse** (a missing or malformed flag, an unknown session, a wrong database path). Expected: exit code 1 with a message, no bundle file, and no database file created. Tests: A2-6 "returns 1 with usage and writes nothing when a flag is missing or malformed" and "returns 1 and writes nothing for an unknown session or a missing database".

## Lane prerequisites

- W0 (tasks W0-1 to W0-6) is merged into `main`. Lanes A1 and B are not prerequisites. A2 merges after A1 (index §4).
- Create the worktree from `/Users/jwpark/Projects/jevcode` with `main` at the W0 merge:

  Run: `git worktree add -b tv/a2-read-path /Users/jwpark/Projects/jevcode-tv-a2 main`

- Verify, from `/Users/jwpark/Projects/jevcode-tv-a2`. Each grep prints the number shown; any other number means W0 has not landed, so stop.

  | Run | Expected |
  |---|---|
  | `grep -c "export const TRACE_ROW_TYPES" packages/contracts/src/trace.ts` | `1` |
  | `grep -c "export function canonicalJson" packages/contracts/src/canonical-json.ts` | `1` |
  | `grep -c "export function cursorAfter" packages/trace-viewer/src/source.ts` | `1` |
  | `grep -c '"@jevcode/trace-viewer"' apps/desktop/package.json` | `1` |
  | `grep -c "export const EVENT_TYPES" packages/storage/src/db.ts` | `0` |

- Setup (once, from `/Users/jwpark/Projects/jevcode-tv-a2`; the W0 lane's recipe). A fresh worktree has no better-sqlite3 binary at all, so without the second command every storage and desktop test fails with `Error: Could not locate the bindings file.` The `mkdir` and `spawn-helper` copy keep `rebuild:node` from failing at its node-pty copy and keep the agent-codex PTY tests from failing with `posix_spawnp failed`.

```bash
pnpm install --frozen-lockfile
NP=$(ls -d node_modules/.pnpm/node-pty@*/node_modules/node-pty | head -1) && mkdir -p "$NP/build/Release" && pnpm --filter jevcode-desktop rebuild:node && cp "$NP/prebuilds/$(node -p 'process.platform + "-" + process.arch')/spawn-helper" "$NP/build/Release/spawn-helper" && chmod +x "$NP/build/Release/spawn-helper"
pnpm -r build
```

  Expected: each command exits 0; the second prints `native modules restored to node ABI` as its last line.

- Baseline:

  | Run | Expected |
  |---|---|
  | `pnpm --filter @jevcode/contracts exec vitest run src/trace.test.ts` | `Tests  8 passed (8)` |
  | `pnpm --filter @jevcode/storage test` | `Tests  50 passed (50)` |

## File map

| File | Task | Responsibility |
|---|---|---|
| `packages/storage/src/trace-reader.ts` (new) | A2-1 | `openTraceReader`, `openQueryOnlyConnection`: the only SQL the viewer runs |
| `packages/storage/src/trace-reader.test.ts` (new) | A2-1 | paging, hidden types, live appends, listing, exact-id lookup, write refusal |
| `packages/storage/src/index.ts` (mod) | A2-1 | export the reader and its four types |
| `apps/desktop/src/main/trace-service.ts` (new) | A2-2 | `TraceRow` mapping, `factId`, clipping, limits, `UNKNOWN_SESSION`, `readAllRows` |
| `apps/desktop/src/main/trace-service.test.ts` (new) | A2-2 | fact ids, clipping, damaged rows, paging, `sessionId` pass-through |
| `apps/desktop/src/shared/local-channels.ts` (mod) | A2-3 | three channel names and zod request schemas (`sessionId?` on `trace:listSessions`) |
| `apps/desktop/src/shared/ipc-registry.test.ts` (mod) | A2-3 | request bounds |
| `apps/desktop/src/main/trace-ipc.ts` (new) | A2-3 | `registerTraceHandlers` (no `electron` import) |
| `apps/desktop/src/main/trace-ipc.test.ts` (new) | A2-3 | read-only guarantee, rejections, cross-repo reads, zero-event session by exact id |
| `apps/desktop/src/main/ipc.ts` (mod) | A2-3 | `IpcDeps.trace`, handler registration |
| `apps/desktop/src/main/index.ts` (mod) | A2-3 | open and close the reader at boot and quit |
| `apps/desktop/src/shared/api.ts` (mod) | A2-4 | `JevcodeApi.trace` (the preload exposes it unchanged) |
| `apps/desktop/src/shared/api.test.ts` (mod) | A2-4 | channel use, client-side bounds, namespace keys |
| `apps/desktop/src/main/trace-bundle.ts` (new) | A2-5 | `buildTraceBundle`, `redactBundleValue`, `writeTraceBundle` |
| `apps/desktop/src/main/trace-bundle.test.ts` (new) | A2-5 | redaction, home mapping, byte-exact file, mode 0600 |
| `apps/desktop/src/main/replay/cli-entry.ts` (mod) | A2-5, A2-6 | `trace.json` in `runReplay`; `exportMain` and dispatch |
| `apps/desktop/src/main/replay/cli-entry.test.ts` (new in A2-5, mod in A2-6) | A2-5, A2-6 | oauth replay bundle; export CLI |
| `docs/demo.md` (mod) | A2-6 | `trace.json` and `replay export` usage |
| `docs/security.md` (mod) | A2-6 | checklist row 7 |
| `scripts/soak.mjs` (mod) | A2-7 | `JEVCODE_SOAK_PROFILE=trace` records; median full read and `trace:rows` p95 with budget warnings; optional export (`JEVCODE_SOAK_EXPORT`) and kept database (`JEVCODE_SOAK_KEEP_DB`) |
| `docs/perf.md` (mod) | A2-7 | measured read median and `trace:rows` p95 against the M2 budgets |

## Rules for every task

- Run every command from `/Users/jwpark/Projects/jevcode-tv-a2`.
- Workspace packages export only `./dist`, and no `vitest.config.ts` has aliases, so a package's tests run against the last build of its dependencies. After changing `packages/storage`, run `pnpm --filter @jevcode/storage build` before any `jevcode-desktop` test or typecheck. `apps/desktop/package.json` has no pretest build.
- better-sqlite3 must be built for Node when vitest loads it. If a storage or desktop test fails with `NODE_MODULE_VERSION`, `was compiled against a different Node.js version` or `Could not locate the bindings file`, rerun the second setup command (Lane prerequisites; expected last line: `native modules restored to node ABI`) and rerun the test. `pnpm --filter jevcode-desktop rebuild` switches to the Electron ABI; switch back with `pnpm --filter jevcode-desktop rebuild:node` before testing.
- Line numbers in "Replace line N" and "Replace lines N-M" count lines in the file as it is when the step starts (before the step's first edit). An earlier edit in the same step shifts later lines, so find each edit by its quoted text, which occurs exactly once in the file.
- Targeted tests: `pnpm --filter <package> exec vitest run <path relative to the package>`.
- Root checks at the end of every task, in order: `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r --no-bail --workspace-concurrency=1 test`, `pnpm lint`. Each must exit 0. Three pre-existing suites flake under load (agent-codex `src/stall-watchdog.test.ts` and `src/codex-adapter.test.ts`, evidence-engine `src/collectors/file-watcher.test.ts`; W0 Gotcha 3). If they are the only failures, rerun that package alone (`pnpm --filter @jevcode/agent-codex test` or `pnpm --filter @jevcode/evidence-engine test`, one retry); it must pass alone, and you name the flake in the task report.
- One commit per task, adding only the task's files by name. No `Claude-Session:` trailer.

---

### Task A2-1: `openTraceReader` on a `query_only` connection

**Files:**
- Create: `packages/storage/src/trace-reader.ts`
- Create: `packages/storage/src/trace-reader.test.ts`
- Modify: `packages/storage/src/index.ts:42-43` (append exports)

**Interfaces:**
- Consumes (W0-5, `@jevcode/contracts`):
  ```ts
  export const TRACE_ROW_TYPES: readonly ["agent_event", "evidence_fact", "change_unit", "decision", "validation", "jev_decision"];
  export function isTraceRowType(value: string): value is TraceRowType;
  export type TraceSessionSummary = {
    sessionId: string; repoId: string; repoName: string; prompt: string;
    state: AgentState; startedAt: string; endedAt: string | null; lastEventSeq: number;
  };
  ```
  Existing storage test helpers: `openSessionDb(sessionId = "sess_fixture"): JevcodeDb` (repository `repo_fixture` at `/work/fixture`, one session with zero events) and `tempDbPath(): string` (a path in a fresh temp dir; the file does not exist) from `./test-utils.js`; `SESSION = "sess_fixture"`, `REPO = "repo_fixture"`, `TS`, `makeAgentEvent`, `makeFact`, `makeChangeUnit`, `makeDecision`, `makeJevLog` from `./fixtures.js`.
- Produces (interfaces §2.5, verbatim, plus `sessionId?` from UI index §1.3):
  ```ts
  export interface TraceReaderRow { seq: number; type: string; ts: string; payloadJson: string }
  export interface TraceReaderPage { rows: TraceReaderRow[]; lastSeq: number; state: TraceSessionSummary["state"] }
  export interface ListTraceSessionsOptions { repoId?: string; sessionId?: string; limit: number }
  // listSessions with sessionId: at most that one session (none when repoId differs), zero-event sessions included.
  export interface TraceReader {
    readonly dbPath: string;
    listSessions(options: ListTraceSessionsOptions): TraceSessionSummary[];
    getSession(sessionId: string): TraceSessionSummary | undefined;
    rows(sessionId: string, afterSeq: number, limit: number, types: readonly string[]): TraceReaderPage;
    payloads(sessionId: string, seqs: readonly number[]): TraceReaderRow[];
    close(): void;
  }
  export function openQueryOnlyConnection(dbPath: string): BetterSqlite3.Database; // module export only
  export function openTraceReader(dbPath: string): TraceReader;
  ```
  `@jevcode/storage` exports `openTraceReader` and the four types; `openQueryOnlyConnection` is not re-exported.

- [ ] **Step 1: Write the failing test**

Create `packages/storage/src/trace-reader.test.ts`:

```ts
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { TRACE_ROW_TYPES, isTraceRowType } from "@jevcode/contracts";

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
import type { JevcodeDb } from "./index.js";
import { openSessionDb, tempDbPath } from "./test-utils.js";
import { openQueryOnlyConnection, openTraceReader } from "./trace-reader.js";
import type { TraceReader } from "./trace-reader.js";

/** Appends seqs 1-10. The trace-type seqs are 1, 3, 5, 6, 8, 9 and 10. */
function seedMixedSession(db: JevcodeDb): void {
  db.appendAgentEvent(SESSION, { type: "agent_started", sessionId: SESSION, prompt: "Seed", ts: TS });
  db.appendTelemetry("agent_event_count", {}, SESSION);
  db.appendEvidenceFact(SESSION, makeFact());
  db.upsertUiSnapshot(SESSION, {
    surfaceId: "surf_1",
    spec: { root: "r", elements: { r: { type: "Terminal", props: {} } } },
  });
  db.upsertChangeUnit(makeChangeUnit());
  db.upsertDecision(makeDecision());
  db.upsertGraphNode(SESSION, { id: "node_1", nodeType: "File", payload: { path: "src/a.ts" } });
  db.upsertJevDecision(makeJevLog());
  db.appendAgentEvent(SESSION, makeAgentEvent({ text: "done" }));
  db.appendAgentEvent(SESSION, { type: "agent_completed", sessionId: SESSION, ts: TS });
}

/** The trace-type seqs the writer stored, ascending. */
function traceSeqs(db: JevcodeDb, sessionId: string): number[] {
  return db
    .listEvents(sessionId, { limit: 100_000 })
    .filter((event) => isTraceRowType(event.type))
    .map((event) => event.seq);
}

/** Pages with the paging contract: afterSeq = last row seq when full, else lastSeq. */
function readAll(reader: TraceReader, sessionId: string, limit: number): number[] {
  const seqs: number[] = [];
  let afterSeq = 0;
  for (let guard = 0; guard < 1_000; guard += 1) {
    const page = reader.rows(sessionId, afterSeq, limit, TRACE_ROW_TYPES);
    seqs.push(...page.rows.map((row) => row.seq));
    if (page.rows.length < limit) return seqs;
    afterSeq = page.rows.at(-1)?.seq ?? page.lastSeq;
  }
  throw new Error("readAll did not terminate");
}

describe("openTraceReader", () => {
  it("pages trace-type rows exactly once and never returns hidden types", () => {
    const db = openSessionDb();
    seedMixedSession(db);
    const reader = openTraceReader(db.dbPath);
    expect(traceSeqs(db, SESSION)).toEqual([1, 3, 5, 6, 8, 9, 10]);
    for (const limit of [1, 2, 3, 7, 50]) {
      expect(readAll(reader, SESSION, limit)).toEqual([1, 3, 5, 6, 8, 9, 10]);
    }
    const page = reader.rows(SESSION, 0, 50, TRACE_ROW_TYPES);
    expect(page.rows.every((row) => isTraceRowType(row.type))).toBe(true);
    expect(page.rows[0]).toEqual({
      seq: 1,
      type: "agent_event",
      ts: expect.any(String),
      payloadJson: expect.stringContaining('"agent_started"'),
    });
    reader.close();
    db.close();
  });

  it("pages stay gapless while the writer appends", () => {
    const db = openSessionDb();
    for (let i = 0; i < 5; i += 1) {
      db.appendAgentEvent(SESSION, makeAgentEvent({ text: `seed ${i}` }));
    }
    const reader = openTraceReader(db.dbPath);
    const seen: number[] = [];
    let afterSeq = 0;
    let appendsLeft = 6;
    for (let guard = 0; guard < 100; guard += 1) {
      const page = reader.rows(SESSION, afterSeq, 3, TRACE_ROW_TYPES);
      seen.push(...page.rows.map((row) => row.seq));
      const full = page.rows.length === 3;
      afterSeq = full ? (page.rows.at(-1)?.seq ?? page.lastSeq) : page.lastSeq;
      if (appendsLeft > 0) {
        appendsLeft -= 1;
        db.appendTelemetry("tick", { left: appendsLeft }, SESSION);
        db.appendAgentEvent(SESSION, makeAgentEvent({ text: `live ${appendsLeft}` }));
        continue;
      }
      if (!full) break;
    }
    expect(appendsLeft).toBe(0);
    expect(seen).toHaveLength(11);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(traceSeqs(db, SESSION));
    reader.close();
    db.close();
  });

  it("returns a page window with the session's lastSeq and state", () => {
    const db = openSessionDb();
    seedMixedSession(db);
    db.setSessionState(SESSION, "running");
    const reader = openTraceReader(db.dbPath);
    const page = reader.rows(SESSION, 3, 2, TRACE_ROW_TYPES);
    expect(page.rows.map((row) => row.seq)).toEqual([5, 6]);
    expect(page.lastSeq).toBe(10);
    expect(page.state).toBe("running");
    expect(reader.rows(SESSION, 10, 5, TRACE_ROW_TYPES).rows).toEqual([]);
    expect(reader.rows(SESSION, 0, 5, ["telemetry"]).rows.map((row) => row.seq)).toEqual([2]);
    reader.close();
    db.close();
  });

  it("returns rows of any type for requested seqs and omits unknown ones", () => {
    const db = openSessionDb();
    seedMixedSession(db);
    db.createSession({ id: "sess_other", repoId: REPO });
    db.appendAgentEvent("sess_other", makeAgentEvent({ sessionId: "sess_other" }));
    const reader = openTraceReader(db.dbPath);
    expect(reader.payloads(SESSION, [7, 2, 99, 2]).map((row) => [row.seq, row.type])).toEqual([
      [2, "telemetry"],
      [7, "graph_node"],
    ]);
    expect(reader.payloads("sess_other", [2])).toEqual([]);
    expect(reader.payloads(SESSION, [])).toEqual([]);
    reader.close();
    db.close();
  });

  it("lists sessions with events across repositories, newest first, ties by id", () => {
    const db = openSessionDb();
    db.upsertRepository({ id: "repo_other", path: "/work/other", gitRoot: "/work/other" });
    db.createSession({ id: "sess_b", repoId: "repo_other", prompt: "B" });
    db.createSession({ id: "sess_a", repoId: REPO, prompt: "A" });
    db.createSession({ id: "sess_empty", repoId: REPO });
    db.appendAgentEvent("sess_b", makeAgentEvent({ sessionId: "sess_b" }));
    db.appendAgentEvent("sess_a", makeAgentEvent({ sessionId: "sess_a" }));
    db.appendAgentEvent(SESSION, makeAgentEvent());
    const raw = new Database(db.dbPath);
    raw
      .prepare("UPDATE sessions SET startedAt = ? WHERE id IN ('sess_a', 'sess_b')")
      .run("2026-09-02T00:00:00.000Z");
    raw
      .prepare("UPDATE sessions SET startedAt = ? WHERE id = ?")
      .run("2026-09-01T00:00:00.000Z", SESSION);
    raw.close();
    const reader = openTraceReader(db.dbPath);
    const all = reader.listSessions({ limit: 10 });
    expect(all.map((session) => session.sessionId)).toEqual(["sess_a", "sess_b", SESSION]);
    expect(all[1]).toEqual({
      sessionId: "sess_b",
      repoId: "repo_other",
      repoName: "other",
      prompt: "B",
      state: "starting",
      startedAt: "2026-09-02T00:00:00.000Z",
      endedAt: null,
      lastEventSeq: 1,
    });
    expect(
      reader.listSessions({ repoId: "repo_other", limit: 10 }).map((session) => session.sessionId),
    ).toEqual(["sess_b"]);
    expect(reader.listSessions({ limit: 1 }).map((session) => session.sessionId)).toEqual([
      "sess_a",
    ]);
    expect(reader.getSession("sess_empty")).toMatchObject({
      sessionId: "sess_empty",
      lastEventSeq: 0,
    });
    expect(reader.getSession("sess_missing")).toBeUndefined();
    reader.close();
    db.close();
  });

  it("lists a zero-event session by exact id", () => {
    const db = openSessionDb();
    db.upsertRepository({ id: "repo_other", path: "/work/other", gitRoot: "/work/other" });
    db.createSession({ id: "sess_b", repoId: "repo_other", prompt: "B" });
    db.appendAgentEvent("sess_b", makeAgentEvent({ sessionId: "sess_b" }));
    const reader = openTraceReader(db.dbPath);
    expect(reader.listSessions({ sessionId: SESSION, limit: 1 })).toEqual([
      expect.objectContaining({ sessionId: SESSION, repoId: REPO, repoName: "fixture", lastEventSeq: 0 }),
    ]);
    expect(reader.listSessions({ limit: 10 }).map((session) => session.sessionId)).toEqual(["sess_b"]);
    expect(
      reader.listSessions({ sessionId: "sess_b", repoId: "repo_other", limit: 1 }).map((session) => session.sessionId),
    ).toEqual(["sess_b"]);
    expect(reader.listSessions({ sessionId: "sess_b", repoId: REPO, limit: 1 })).toEqual([]);
    expect(reader.listSessions({ sessionId: "sess_missing", limit: 1 })).toEqual([]);
    expect(() => reader.listSessions({ sessionId: SESSION, limit: 0 })).toThrow(RangeError);
    reader.close();
    db.close();
  });

  it("rejects an unknown session, a bad window and a missing file", () => {
    const db = openSessionDb();
    const reader = openTraceReader(db.dbPath);
    expect(() => reader.rows("sess_missing", 0, 10, TRACE_ROW_TYPES)).toThrow(
      /unknown session sess_missing/,
    );
    expect(() => reader.rows(SESSION, 0, 0, TRACE_ROW_TYPES)).toThrow(RangeError);
    expect(() => reader.rows(SESSION, -1, 10, TRACE_ROW_TYPES)).toThrow(RangeError);
    expect(() => reader.listSessions({ limit: 0 })).toThrow(RangeError);
    expect(() => openTraceReader(tempDbPath())).toThrow();
    expect(() => openTraceReader(":memory:")).toThrow(TypeError);
    reader.close();
    db.close();
  });

  it("exposes no write surface and its connection refuses writes", () => {
    const db = openSessionDb();
    const reader = openTraceReader(db.dbPath);
    expect(Object.keys(reader).sort()).toEqual([
      "close",
      "dbPath",
      "getSession",
      "listSessions",
      "payloads",
      "rows",
    ]);
    const connection = openQueryOnlyConnection(db.dbPath);
    expect(connection.pragma("query_only", { simple: true })).toBe(1);
    expect(() =>
      connection
        .prepare(
          "INSERT INTO repositories (id, path, gitRoot, name, lastOpenedAt, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("repo_x", "/x", "/x", "x", TS, TS),
    ).toThrow(/readonly|query_only/);
    expect(() =>
      connection.prepare("UPDATE sessions SET state = 'failed' WHERE id = ?").run(SESSION),
    ).toThrow(/readonly|query_only/);
    connection.close();
    expect(db.getSession(SESSION)?.state).toBe("starting");
    expect(db.getRepository("repo_x")).toBeUndefined();
    reader.close();
    db.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @jevcode/storage exec vitest run src/trace-reader.test.ts`
Expected: FAIL, `Error: Cannot find module './trace-reader.js' imported from …/trace-reader.test.ts`

- [ ] **Step 3: Write the reader**

Create `packages/storage/src/trace-reader.ts`:

```ts
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";

import type { TraceSessionSummary } from "@jevcode/contracts";

export interface TraceReaderRow {
  seq: number;
  type: string;
  ts: string;
  payloadJson: string;
}

export interface TraceReaderPage {
  rows: TraceReaderRow[];
  lastSeq: number;
  state: TraceSessionSummary["state"];
}

export interface ListTraceSessionsOptions {
  repoId?: string;
  /** Exact-id lookup: at most that one session, returned even with zero events (spec §5.2). */
  sessionId?: string;
  limit: number;
}

export interface TraceReader {
  readonly dbPath: string;
  /** Joins repositories; ORDER BY startedAt DESC, id ASC. Hides sessions with lastEventSeq = 0 unless sessionId is given. */
  listSessions(options: ListTraceSessionsOptions): TraceSessionSummary[];
  getSession(sessionId: string): TraceSessionSummary | undefined;
  /** One read transaction: session row, then seq > afterSeq AND seq <= lastEventSeq AND type IN (types) ORDER BY seq LIMIT limit. */
  rows(sessionId: string, afterSeq: number, limit: number, types: readonly string[]): TraceReaderPage;
  /** Rows of any type for the given seqs, ascending; unknown seqs omitted. */
  payloads(sessionId: string, seqs: readonly number[]): TraceReaderRow[];
  close(): void;
}

const SUMMARY_SELECT =
  "SELECT s.id AS sessionId, s.repoId AS repoId, COALESCE(r.name, '') AS repoName, " +
  "s.prompt AS prompt, s.state AS state, s.startedAt AS startedAt, s.endedAt AS endedAt, " +
  "s.lastEventSeq AS lastEventSeq FROM sessions s LEFT JOIN repositories r ON r.id = s.repoId";

const LIST_ORDER = "ORDER BY s.startedAt DESC, s.id ASC LIMIT ?";

function requireInteger(label: string, value: number, min: number): void {
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(`trace reader: ${label} must be an integer >= ${min}, got ${String(value)}`);
  }
}

/** A second connection: new Database(dbPath, { fileMustExist: true }), busy_timeout = 5000, PRAGMA query_only = ON. */
export function openQueryOnlyConnection(dbPath: string): BetterSqlite3.Database {
  if (dbPath === "" || dbPath === ":memory:") {
    throw new TypeError("trace reader: needs a database file path, not an in-memory database");
  }
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("query_only = ON");
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

export function openTraceReader(dbPath: string): TraceReader {
  const db = openQueryOnlyConnection(dbPath);
  const listAll = db.prepare(`${SUMMARY_SELECT} WHERE s.lastEventSeq > 0 ${LIST_ORDER}`);
  const listByRepo = db.prepare(
    `${SUMMARY_SELECT} WHERE s.lastEventSeq > 0 AND s.repoId = ? ${LIST_ORDER}`,
  );
  // Exact-id lookups (spec §5.2) skip the lastEventSeq > 0 filter: the trace
  // window reads its summary this way, also before the agent logs anything.
  const listById = db.prepare(`${SUMMARY_SELECT} WHERE s.id = ? ${LIST_ORDER}`);
  const listByRepoAndId = db.prepare(
    `${SUMMARY_SELECT} WHERE s.repoId = ? AND s.id = ? ${LIST_ORDER}`,
  );
  const getOne = db.prepare(`${SUMMARY_SELECT} WHERE s.id = ?`);
  const head = db.prepare("SELECT lastEventSeq, state FROM sessions WHERE id = ?");
  const pageRows = db.prepare(
    "SELECT seq, type, ts, payloadJson FROM events WHERE sessionId = ? AND seq > ? AND seq <= ? " +
      "AND type IN (SELECT value FROM json_each(?)) ORDER BY seq ASC LIMIT ?",
  );
  const bySeq = db.prepare(
    "SELECT seq, type, ts, payloadJson FROM events WHERE sessionId = ? " +
      "AND seq IN (SELECT value FROM json_each(?)) ORDER BY seq ASC",
  );

  // One deferred read transaction. In WAL mode both SELECTs read the same
  // snapshot, and appendEvent (db.ts) writes the row and lastEventSeq in one
  // write transaction, so a page never runs past lastSeq or skips a row.
  const readPage = db.transaction(
    (sessionId: string, afterSeq: number, limit: number, typesJson: string): TraceReaderPage => {
      const session = head.get(sessionId) as { lastEventSeq: number; state: string } | undefined;
      if (session === undefined) {
        throw new Error(`trace reader: unknown session ${sessionId}`);
      }
      const rows = pageRows.all(
        sessionId,
        afterSeq,
        session.lastEventSeq,
        typesJson,
        limit,
      ) as TraceReaderRow[];
      return {
        rows,
        lastSeq: session.lastEventSeq,
        state: session.state as TraceSessionSummary["state"],
      };
    },
  );

  return {
    dbPath,
    listSessions({ repoId, sessionId, limit }) {
      requireInteger("limit", limit, 1);
      let rows: unknown[];
      if (sessionId !== undefined) {
        rows =
          repoId === undefined
            ? listById.all(sessionId, limit)
            : listByRepoAndId.all(repoId, sessionId, limit);
      } else {
        rows = repoId === undefined ? listAll.all(limit) : listByRepo.all(repoId, limit);
      }
      return rows as TraceSessionSummary[];
    },
    getSession(sessionId) {
      return getOne.get(sessionId) as TraceSessionSummary | undefined;
    },
    rows(sessionId, afterSeq, limit, types) {
      requireInteger("afterSeq", afterSeq, 0);
      requireInteger("limit", limit, 1);
      return readPage(sessionId, afterSeq, limit, JSON.stringify(types));
    },
    payloads(sessionId, seqs) {
      if (seqs.length === 0) return [];
      return bySeq.all(sessionId, JSON.stringify(seqs)) as TraceReaderRow[];
    },
    close() {
      db.close();
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @jevcode/storage exec vitest run src/trace-reader.test.ts`
Expected: PASS, `Tests  8 passed (8)`

- [ ] **Step 5: Export the reader from the package**

In `packages/storage/src/index.ts`, replace the last two lines (current lines 42-43):

```ts
export { LATEST_SCHEMA_VERSION, MIGRATIONS } from "./migrations.js";
export type { Migration } from "./migrations.js";
```

with:

```ts
export { LATEST_SCHEMA_VERSION, MIGRATIONS } from "./migrations.js";
export type { Migration } from "./migrations.js";
export { openTraceReader } from "./trace-reader.js";
export type {
  ListTraceSessionsOptions,
  TraceReader,
  TraceReaderPage,
  TraceReaderRow,
} from "./trace-reader.js";
```

- [ ] **Step 6: Build storage and confirm the export**

Run: `pnpm --filter @jevcode/storage build`
Expected: exit 0.

Run: `grep -c "openTraceReader" packages/storage/dist/index.d.ts`
Expected: `1`

- [ ] **Step 7: Run the root checks**

Run, in order: `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r --no-bail --workspace-concurrency=1 test`, `pnpm lint`
Expected: each exits 0.

- [ ] **Step 8: Commit**

```bash
git add packages/storage/src/trace-reader.ts packages/storage/src/trace-reader.test.ts packages/storage/src/index.ts
git commit -m "feat(storage): add query_only trace reader"
```

---

### Task A2-2: trace service (`factId`, clipping, `readAllRows`, `UNKNOWN_SESSION`)

**Files:**
- Create: `apps/desktop/src/main/trace-service.ts`
- Create: `apps/desktop/src/main/trace-service.test.ts`

**Interfaces:**
- Consumes:
  - A2-1 (`@jevcode/storage`): `openTraceReader(dbPath: string): TraceReader`, `TraceReader`, `TraceReaderRow`, `ListTraceSessionsOptions` (signatures in A2-1 Produces).
  - W0-5 (`@jevcode/contracts`): `TRACE_CLIP_CHARS = 16_384`, `TRACE_LIST_SESSIONS_DEFAULT = 100`, `TRACE_LIST_SESSIONS_MAX = 500`, `TRACE_ROWS_PAGE_DEFAULT = 2_000`, `TRACE_ROWS_PAGE_MAX = 5_000`, `TRACE_ROW_TYPES`; types `TraceRow = { seq: number; type: string; ts: string; payload?: unknown; clipped?: boolean; factId?: string }`, `TraceRowsPage = { rows: TraceRow[]; nextAfterSeq: number | null; lastSeq: number; state: AgentState }`, `TraceSessionSummary`.
  - `@jevcode/semantic-core`: `factContentId(sessionId: string, record: unknown): string` (returns `fact_<16 hex>`; lane A1-5 makes it hash `canonicalJson(record)` without changing the signature).
  - `apps/desktop/src/shared/errors.ts`: `class IpcError extends Error { constructor(code: IpcErrorCode, message: string); readonly code: IpcErrorCode }`; `"UNKNOWN_SESSION"` is an existing `IpcErrorCode`.
- Produces (interfaces §2.5, verbatim, plus `sessionId?` from UI index §1.3):
  ```ts
  export interface TraceService {
    listSessions(request: { repoId?: string; sessionId?: string; limit?: number }): TraceSessionSummary[]; // passes sessionId through
    session(sessionId: string): TraceSessionSummary; // throws IpcError("UNKNOWN_SESSION")
    rows(request: { sessionId: string; afterSeq?: number; limit?: number }): TraceRowsPage;
    payloads(request: { sessionId: string; seqs: readonly number[] }): TraceRow[];
  }
  export function createTraceService(reader: TraceReader): TraceService;
  export function toTraceRow(sessionId: string, row: TraceReaderRow): TraceRow;
  export function clipPayload(payload: unknown, maxChars?: number): { payload: unknown; clipped: boolean };
  export function readAllRows(
    service: TraceService,
    sessionId: string,
    pageSize?: number,
  ): { rows: TraceRow[]; lastSeq: number; state: TraceSessionSummary["state"] };
  ```

- [ ] **Step 1: Rebuild storage for the desktop tests**

Run: `pnpm --filter @jevcode/storage build`
Expected: exit 0. Then `grep -c "openTraceReader" packages/storage/dist/index.d.ts` prints `1`.

- [ ] **Step 2: Write the failing test**

Create `apps/desktop/src/main/trace-service.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { TRACE_CLIP_CHARS, TRACE_ROW_TYPES } from "@jevcode/contracts";
import type { EvidenceFact, TraceSessionSummary } from "@jevcode/contracts";
import { factContentId } from "@jevcode/semantic-core";
import { openDb, openTraceReader } from "@jevcode/storage";
import type {
  JevcodeDb,
  ListTraceSessionsOptions,
  TraceReader,
  TraceReaderRow,
} from "@jevcode/storage";
import { afterEach, describe, expect, it } from "vitest";

import { IpcError } from "../shared/errors.js";
import { clipPayload, createTraceService, readAllRows, toTraceRow } from "./trace-service.js";

const SESSION = "sess_trace";
const REPO = "repo_trace";
const TS = "2026-09-28T10:00:00.000Z";

const tempDirs: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  while (closers.length > 0) closers.pop()?.();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function seededStore(): { db: JevcodeDb; reader: TraceReader } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jevcode-trace-service-"));
  tempDirs.push(dir);
  const db = openDb({ dbPath: path.join(dir, "trace.db") });
  db.upsertRepository({ id: REPO, path: "/work/trace", gitRoot: "/work/trace" });
  db.createSession({ id: SESSION, repoId: REPO, prompt: "Trace me" });
  const reader = openTraceReader(db.dbPath);
  closers.push(() => {
    reader.close();
    db.close();
  });
  return { db, reader };
}

function commandFact(command: string, exitCode: number): EvidenceFact {
  return {
    type: "command_executed",
    repoId: REPO,
    sessionId: SESSION,
    command,
    exitCode,
    isDestructive: false,
    ts: TS,
  };
}

interface FakeReader extends TraceReader {
  listCalls: ListTraceSessionsOptions[];
  rowCalls: Array<{ afterSeq: number; limit: number; types: readonly string[] }>;
}

function fakeReader(rows: TraceReaderRow[] = []): FakeReader {
  const summary: TraceSessionSummary = {
    sessionId: SESSION,
    repoId: REPO,
    repoName: "trace",
    prompt: "Trace me",
    state: "running",
    startedAt: TS,
    endedAt: null,
    lastEventSeq: rows.at(-1)?.seq ?? 0,
  };
  const listCalls: FakeReader["listCalls"] = [];
  const rowCalls: FakeReader["rowCalls"] = [];
  return {
    dbPath: "fake.db",
    listCalls,
    rowCalls,
    listSessions: (options) => {
      listCalls.push(options);
      return [summary];
    },
    getSession: (sessionId) => (sessionId === SESSION ? summary : undefined),
    rows: (_sessionId, afterSeq, limit, types) => {
      rowCalls.push({ afterSeq, limit, types });
      return {
        rows: rows.filter((row) => row.seq > afterSeq).slice(0, limit),
        lastSeq: summary.lastEventSeq,
        state: summary.state,
      };
    },
    payloads: () => [],
    close: () => undefined,
  };
}

describe("trace service", () => {
  it("attaches factId to evidence rows only, computed from the stored payload", () => {
    const { db, reader } = seededStore();
    db.appendAgentEvent(SESSION, { type: "agent_started", sessionId: SESSION, prompt: "Trace me", ts: TS });
    db.appendEvidenceFact(SESSION, commandFact("pnpm test", 1));
    db.appendTelemetry("fact_count", {}, SESSION);
    const page = createTraceService(reader).rows({ sessionId: SESSION });
    expect(page.rows.map((row) => row.type)).toEqual(["agent_event", "evidence_fact"]);
    expect(page).toMatchObject({ nextAfterSeq: null, lastSeq: 3, state: "starting" });
    const stored = db.listEvents(SESSION).find((event) => event.type === "evidence_fact");
    const [agentRow, factRow] = page.rows;
    expect(factRow?.factId).toBe(factContentId(SESSION, JSON.parse(stored?.payloadJson ?? "null")));
    expect(factRow?.factId).toMatch(/^fact_[0-9a-f]{16}$/);
    expect(agentRow !== undefined && "factId" in agentRow).toBe(false);
    expect(page.rows.some((row) => "clipped" in row)).toBe(false);
  });

  it("clips a 1 MiB stdout to head and tail", () => {
    const { db, reader } = seededStore();
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    const body = alphabet.repeat(Math.ceil((1024 * 1024) / alphabet.length)).slice(0, 1024 * 1024);
    const stdout = `HEAD:${body}:TAIL`;
    db.appendAgentEvent(SESSION, {
      type: "command_completed",
      sessionId: SESSION,
      command: "cat big.log",
      exitCode: 0,
      stdout,
      stderr: "",
      ts: TS,
    });
    db.appendEvidenceFact(SESSION, {
      type: "test_result",
      repoId: REPO,
      sessionId: SESSION,
      runner: "vitest",
      command: "pnpm test",
      passed: 0,
      failed: 1,
      skipped: 0,
      failures: [{ file: "big.test.ts", testName: "big", message: "x".repeat(40 * 1024) }],
      ts: TS,
    });
    const [commandRow, factRow] = createTraceService(reader).rows({ sessionId: SESSION }).rows;
    const payload = commandRow?.payload as { command: string; stdout: string };
    expect(commandRow?.clipped).toBe(true);
    expect(payload.command).toBe("cat big.log");
    expect(payload.stdout.length).toBeLessThanOrEqual(TRACE_CLIP_CHARS + 64);
    expect(payload.stdout.slice(0, 8192)).toBe(stdout.slice(0, 8192));
    expect(payload.stdout.slice(-8192)).toBe(stdout.slice(-8192));
    expect(payload.stdout).toContain(`[${stdout.length - TRACE_CLIP_CHARS} characters clipped]`);
    const stored = db.listEvents(SESSION).find((event) => event.type === "evidence_fact");
    expect(factRow?.clipped).toBe(true);
    expect(factRow?.factId).toBe(factContentId(SESSION, JSON.parse(stored?.payloadJson ?? "null")));
  });

  it("clipPayload keeps short payloads by reference and cuts long strings around a marker", () => {
    const short = { a: "x", list: ["y"] };
    expect(clipPayload(short).payload).toBe(short);
    expect(clipPayload(short).clipped).toBe(false);
    const long = { nested: [{ text: "abcdefghijklmnopqrstuvwxyz" }], keep: "ok" };
    expect(clipPayload(long, 10)).toEqual({
      payload: { nested: [{ text: "abcde\n… [16 characters clipped] …\nvwxyz" }], keep: "ok" },
      clipped: true,
    });
    expect(long.nested[0]?.text).toBe("abcdefghijklmnopqrstuvwxyz");
    expect(() => clipPayload("abc", 1)).toThrow(RangeError);
  });

  it("never splits a surrogate pair at either cut", () => {
    const emoji = "😀".repeat(20);
    expect(clipPayload(emoji, 11)).toEqual({
      payload: "😀😀\n… [32 characters clipped] …\n😀😀",
      clipped: true,
    });
  });

  it("turns a damaged payload row into a row without payload and keeps its neighbors", () => {
    const damaged = toTraceRow(SESSION, { seq: 4, type: "evidence_fact", ts: TS, payloadJson: '{"type":' });
    expect(damaged).toEqual({ seq: 4, type: "evidence_fact", ts: TS });
    expect("payload" in damaged).toBe(false);
    expect("factId" in damaged).toBe(false);
    const service = createTraceService(
      fakeReader([
        {
          seq: 1,
          type: "agent_event",
          ts: TS,
          payloadJson: JSON.stringify({ type: "agent_waiting", sessionId: SESSION, ts: TS }),
        },
        { seq: 2, type: "agent_event", ts: TS, payloadJson: "not json" },
        {
          seq: 3,
          type: "agent_event",
          ts: TS,
          payloadJson: JSON.stringify({ type: "agent_completed", sessionId: SESSION, ts: TS }),
        },
      ]),
    );
    const page = service.rows({ sessionId: SESSION });
    expect(page.rows.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(page.rows.map((row) => "payload" in row)).toEqual([true, false, true]);
  });

  it("defaults and clamps list and page limits and passes an exact sessionId through", () => {
    const reader = fakeReader();
    const service = createTraceService(reader);
    service.listSessions({});
    service.listSessions({ repoId: REPO, limit: 10_000 });
    service.listSessions({ sessionId: SESSION, limit: 1 });
    expect(reader.listCalls).toEqual([
      { limit: 100 },
      { repoId: REPO, limit: 500 },
      { sessionId: SESSION, limit: 1 },
    ]);
    service.rows({ sessionId: SESSION });
    service.rows({ sessionId: SESSION, afterSeq: 7, limit: 99_999 });
    expect(reader.rowCalls).toEqual([
      { afterSeq: 0, limit: 2_000, types: TRACE_ROW_TYPES },
      { afterSeq: 7, limit: 5_000, types: TRACE_ROW_TYPES },
    ]);
  });

  it("throws IpcError UNKNOWN_SESSION for a missing session", () => {
    const service = createTraceService(fakeReader());
    const calls = [
      () => service.session("sess_missing"),
      () => service.rows({ sessionId: "sess_missing" }),
      () => service.payloads({ sessionId: "sess_missing", seqs: [1] }),
    ];
    for (const call of calls) {
      expect(call).toThrowError(IpcError);
      expect(call).toThrowError(/sess_missing/);
      try {
        call();
      } catch (error) {
        expect(error).toMatchObject({ code: "UNKNOWN_SESSION" });
      }
    }
  });

  it("pages with nextAfterSeq and readAllRows returns every trace row", () => {
    const { db, reader } = seededStore();
    db.appendAgentEvent(SESSION, { type: "agent_started", sessionId: SESSION, prompt: "Trace me", ts: TS });
    db.appendTelemetry("agent_event_count", {}, SESSION);
    db.appendEvidenceFact(SESSION, commandFact("pnpm test", 0));
    db.appendAgentEvent(SESSION, { type: "agent_message", sessionId: SESSION, role: "assistant", text: "one", ts: TS });
    db.appendTelemetry("agent_event_count", {}, SESSION);
    db.appendAgentEvent(SESSION, { type: "agent_message", sessionId: SESSION, role: "assistant", text: "two", ts: TS });
    db.appendAgentEvent(SESSION, { type: "agent_completed", sessionId: SESSION, ts: TS });
    const service = createTraceService(reader);
    const first = service.rows({ sessionId: SESSION, limit: 2 });
    expect(first.rows.map((row) => row.seq)).toEqual([1, 3]);
    expect(first.nextAfterSeq).toBe(3);
    const last = service.rows({ sessionId: SESSION, afterSeq: 6, limit: 2 });
    expect(last.rows.map((row) => row.seq)).toEqual([7]);
    expect(last.nextAfterSeq).toBeNull();
    expect(last.lastSeq).toBe(7);
    for (const pageSize of [2, 5, 5_000]) {
      const all = readAllRows(service, SESSION, pageSize);
      expect(all.rows.map((row) => row.seq)).toEqual([1, 3, 4, 6, 7]);
      expect(all.lastSeq).toBe(7);
      expect(all.state).toBe("starting");
    }
  });

  it("payloads returns any row type with factId and clipping applied", () => {
    const { db, reader } = seededStore();
    db.appendTelemetry("agent_event_count", {}, SESSION);
    db.appendEvidenceFact(SESSION, commandFact("x".repeat(20_000), 1));
    const rows = createTraceService(reader).payloads({ sessionId: SESSION, seqs: [2, 1, 42] });
    expect(rows.map((row) => [row.seq, row.type])).toEqual([
      [1, "telemetry"],
      [2, "evidence_fact"],
    ]);
    expect(rows[1]?.clipped).toBe(true);
    expect(rows[1]?.factId).toMatch(/^fact_[0-9a-f]{16}$/);
    expect(rows[0] !== undefined && "factId" in rows[0]).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter jevcode-desktop exec vitest run src/main/trace-service.test.ts`
Expected: FAIL, `Error: Cannot find module './trace-service.js' imported from …/trace-service.test.ts`

- [ ] **Step 4: Write the service**

Create `apps/desktop/src/main/trace-service.ts`:

```ts
import {
  TRACE_CLIP_CHARS,
  TRACE_LIST_SESSIONS_DEFAULT,
  TRACE_LIST_SESSIONS_MAX,
  TRACE_ROWS_PAGE_DEFAULT,
  TRACE_ROWS_PAGE_MAX,
  TRACE_ROW_TYPES,
} from "@jevcode/contracts";
import type { TraceRow, TraceRowsPage, TraceSessionSummary } from "@jevcode/contracts";
import { factContentId } from "@jevcode/semantic-core";
import type { TraceReader, TraceReaderRow } from "@jevcode/storage";

import { IpcError } from "../shared/errors.js";

export interface TraceService {
  /** With sessionId: that one session, even with zero events (spec §5.2); else sessions with events. */
  listSessions(request: { repoId?: string; sessionId?: string; limit?: number }): TraceSessionSummary[];
  /** Throws IpcError("UNKNOWN_SESSION") when the session row is missing. */
  session(sessionId: string): TraceSessionSummary;
  /** Paging contract of section 2.1; types = TRACE_ROW_TYPES; limit defaults to TRACE_ROWS_PAGE_DEFAULT. */
  rows(request: { sessionId: string; afterSeq?: number; limit?: number }): TraceRowsPage;
  payloads(request: { sessionId: string; seqs: readonly number[] }): TraceRow[];
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** head + marker + tail; never cuts a UTF-16 surrogate pair in half. */
function clipString(value: string, maxChars: number): string {
  const half = Math.floor(maxChars / 2);
  let headEnd = half;
  if (isHighSurrogate(value.charCodeAt(headEnd - 1))) headEnd -= 1;
  let tailStart = value.length - half;
  if (isLowSurrogate(value.charCodeAt(tailStart))) tailStart += 1;
  const omitted = tailStart - headEnd;
  return `${value.slice(0, headEnd)}\n… [${omitted} characters clipped] …\n${value.slice(tailStart)}`;
}

/** Deep walk; a string longer than maxChars becomes head(maxChars/2) + "\n… [N characters clipped] …\n" + tail(maxChars/2). */
export function clipPayload(
  payload: unknown,
  maxChars: number = TRACE_CLIP_CHARS,
): { payload: unknown; clipped: boolean } {
  if (!Number.isInteger(maxChars) || maxChars < 2) {
    throw new RangeError(`clipPayload: maxChars must be an integer >= 2, got ${String(maxChars)}`);
  }
  let clipped = false;
  // Returns the same reference when nothing below changed, so unclipped
  // payloads are never copied.
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (value.length <= maxChars) return value;
      clipped = true;
      return clipString(value, maxChars);
    }
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((entry: unknown) => {
        const result = walk(entry);
        if (result !== entry) changed = true;
        return result;
      });
      return changed ? next : value;
    }
    if (value !== null && typeof value === "object") {
      let changed = false;
      const entries = Object.entries(value).map(([key, entry]): [string, unknown] => {
        const result = walk(entry);
        if (result !== entry) changed = true;
        return [key, result];
      });
      // fromEntries defines own data properties, so a "__proto__" key stays data.
      return changed ? Object.fromEntries(entries) : value;
    }
    return value;
  };
  const result = walk(payload);
  return { payload: result, clipped };
}

/** JSON.parse(payloadJson); factId = factContentId(sessionId, payload) for evidence_fact rows (before clipping); then clipPayload. */
export function toTraceRow(sessionId: string, row: TraceReaderRow): TraceRow {
  const traceRow: TraceRow = { seq: row.seq, type: row.type, ts: row.ts };
  let payload: unknown;
  try {
    payload = JSON.parse(row.payloadJson);
  } catch {
    // A damaged row keeps its place in the sequence without a payload; the
    // fold records it as an invalid_row gap (interfaces §2.1).
    return traceRow;
  }
  if (row.type === "evidence_fact") {
    traceRow.factId = factContentId(sessionId, payload);
  }
  const clipped = clipPayload(payload);
  traceRow.payload = clipped.payload;
  if (clipped.clipped) {
    traceRow.clipped = true;
  }
  return traceRow;
}

export function createTraceService(reader: TraceReader): TraceService {
  function session(sessionId: string): TraceSessionSummary {
    const summary = reader.getSession(sessionId);
    if (summary === undefined) {
      throw new IpcError("UNKNOWN_SESSION", `no session with id ${sessionId}`);
    }
    return summary;
  }

  return {
    listSessions(request) {
      const limit = Math.min(request.limit ?? TRACE_LIST_SESSIONS_DEFAULT, TRACE_LIST_SESSIONS_MAX);
      return reader.listSessions({ repoId: request.repoId, sessionId: request.sessionId, limit });
    },
    session,
    rows(request) {
      session(request.sessionId);
      const limit = Math.min(request.limit ?? TRACE_ROWS_PAGE_DEFAULT, TRACE_ROWS_PAGE_MAX);
      const page = reader.rows(request.sessionId, request.afterSeq ?? 0, limit, TRACE_ROW_TYPES);
      const last = page.rows.at(-1);
      return {
        rows: page.rows.map((row) => toTraceRow(request.sessionId, row)),
        nextAfterSeq: page.rows.length === limit && last !== undefined ? last.seq : null,
        lastSeq: page.lastSeq,
        state: page.state,
      };
    },
    payloads(request) {
      session(request.sessionId);
      return reader
        .payloads(request.sessionId, request.seqs)
        .map((row) => toTraceRow(request.sessionId, row));
    },
  };
}

/** Pages rows() from afterSeq 0 until nextAfterSeq is null. */
export function readAllRows(
  service: TraceService,
  sessionId: string,
  pageSize: number = TRACE_ROWS_PAGE_MAX,
): { rows: TraceRow[]; lastSeq: number; state: TraceSessionSummary["state"] } {
  const rows: TraceRow[] = [];
  let afterSeq = 0;
  for (;;) {
    const page = service.rows({ sessionId, afterSeq, limit: pageSize });
    for (const row of page.rows) rows.push(row);
    if (page.nextAfterSeq === null) {
      return { rows, lastSeq: page.lastSeq, state: page.state };
    }
    afterSeq = page.nextAfterSeq;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter jevcode-desktop exec vitest run src/main/trace-service.test.ts`
Expected: PASS, `Tests  9 passed (9)`

- [ ] **Step 6: Run the root checks**

Run, in order: `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r --no-bail --workspace-concurrency=1 test`, `pnpm lint`
Expected: each exits 0.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/trace-service.ts apps/desktop/src/main/trace-service.test.ts
git commit -m "feat(desktop): add trace service with fact ids and string clipping"
```

---

### Task A2-3: `trace:*` channels, `registerTraceHandlers`, boot wiring

**Files:**
- Modify: `apps/desktop/src/shared/local-channels.ts:3`, `:19-21`, `:203-205`, `:221-222`
- Modify: `apps/desktop/src/shared/ipc-registry.test.ts:100-108`
- Create: `apps/desktop/src/main/trace-ipc.ts`
- Create: `apps/desktop/src/main/trace-ipc.test.ts`
- Modify: `apps/desktop/src/main/ipc.ts:43`, `:59-61`, `:415-420`
- Modify: `apps/desktop/src/main/index.ts:8-9`, `:23`, `:50-51`, `:93-94`, `:156-157`, `:181-182`

**Interfaces:**
- Consumes:
  - A2-2: `TraceService`, `createTraceService(reader: TraceReader): TraceService`.
  - A2-1: `openTraceReader(dbPath: string): TraceReader`, `TraceReader` from `@jevcode/storage`.
  - W0-5: `TRACE_LIST_SESSIONS_MAX`, `TRACE_ROWS_PAGE_MAX`, `TRACE_PAYLOADS_MAX`; types `TraceRow`, `TraceRowsPage`, `TraceSessionSummary`.
  - Existing registry (`apps/desktop/src/shared/ipc-registry.ts`): `type ToMainChannelName`, `type ToMainPayload<C extends ToMainChannelName>`, `parseToMain<C>(channel: C, payload: unknown): ToMainPayload<C>` (throws `IpcError` `UNKNOWN_CHANNEL` or `INVALID_PAYLOAD`).
  - Existing `ipc.ts` wrapper (lines 129-143): `function handle<C extends ToMainChannelName>(channel: C, fn: (payload: ToMainPayload<C>) => unknown | Promise<unknown>): void`, which runs `assertTrustedSender` and `parseToMain` before `fn`.
- Produces (interfaces §2.5, verbatim):
  ```ts
  // local-channels.ts
  RendererToMainLocalChannels.traceListSessions === "trace:listSessions";
  RendererToMainLocalChannels.traceRows === "trace:rows";
  RendererToMainLocalChannels.tracePayloads === "trace:payloads";
  export const TraceListSessionsPayloadSchema; // { repoId?: string (min 1); sessionId?: string (min 1); limit?: int 1..500 }
  export const TraceRowsPayloadSchema;         // { sessionId: string (min 1); afterSeq?: int >= 0; limit?: int 1..5000 }
  export const TracePayloadsPayloadSchema;     // { sessionId: string (min 1); seqs: int >= 1, 1 to 50 items }
  // trace-ipc.ts
  export type IpcHandle = <C extends ToMainChannelName>(
    channel: C,
    fn: (payload: ToMainPayload<C>) => unknown | Promise<unknown>,
  ) => void;
  export function registerTraceHandlers(handle: IpcHandle, service: TraceService): void;
  // trace:listSessions -> { sessions: TraceSessionSummary[] }
  // trace:rows         -> TraceRowsPage
  // trace:payloads     -> { rows: TraceRow[] }
  // ipc.ts
  export interface IpcDeps { /* existing fields */ trace: TraceService }
  ```

- [ ] **Step 1: Write the failing registry test**

In `apps/desktop/src/shared/ipc-registry.test.ts`, replace the end of the file (current lines 100-108):

```ts
    expect(() =>
      parseToMain("session:start", {
        repoId: "r1",
        prompt: "hi",
        approvalMode: "always",
      }),
    ).toThrowError(IpcError);
  });
});
```

with:

```ts
    expect(() =>
      parseToMain("session:start", {
        repoId: "r1",
        prompt: "hi",
        approvalMode: "always",
      }),
    ).toThrowError(IpcError);
  });

  it("bounds the read-only trace channels", () => {
    expect(parseToMain("trace:listSessions", {})).toEqual({});
    expect(parseToMain("trace:listSessions", { repoId: "r1", limit: 500 })).toEqual({
      repoId: "r1",
      limit: 500,
    });
    expect(parseToMain("trace:listSessions", { sessionId: "s", limit: 1 })).toEqual({
      sessionId: "s",
      limit: 1,
    });
    expect(parseToMain("trace:rows", { sessionId: "s", afterSeq: 0, limit: 5000 })).toEqual({
      sessionId: "s",
      afterSeq: 0,
      limit: 5000,
    });
    expect(parseToMain("trace:payloads", { sessionId: "s", seqs: [1, 2] })).toEqual({
      sessionId: "s",
      seqs: [1, 2],
    });
    const rejected: Array<[string, unknown]> = [
      ["trace:listSessions", { limit: 501 }],
      ["trace:listSessions", { repoId: "" }],
      ["trace:listSessions", { sessionId: "" }],
      ["trace:rows", { sessionId: "s", limit: 5001 }],
      ["trace:rows", { sessionId: "", afterSeq: 0 }],
      ["trace:rows", { sessionId: "s", afterSeq: -1 }],
      ["trace:rows", { sessionId: "s", afterSeq: 1.5 }],
      ["trace:payloads", { sessionId: "s", seqs: [] }],
      ["trace:payloads", { sessionId: "s", seqs: Array.from({ length: 51 }, (_, i) => i + 1) }],
      ["trace:payloads", { sessionId: "s", seqs: [0] }],
    ];
    for (const [channel, payload] of rejected) {
      let caught: unknown;
      try {
        parseToMain(channel, payload);
      } catch (error) {
        caught = error;
      }
      expect(caught, `${channel} ${JSON.stringify(payload).slice(0, 60)}`).toBeInstanceOf(IpcError);
      expect(caught).toMatchObject({ code: "INVALID_PAYLOAD" });
    }
  });
});
```

- [ ] **Step 2: Write the failing handler test**

Create `apps/desktop/src/main/trace-ipc.test.ts`:

```ts
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { TraceRow, TraceRowsPage, TraceSessionSummary } from "@jevcode/contracts";
import { openDb, openTraceReader } from "@jevcode/storage";
import type { JevcodeDb } from "@jevcode/storage";
import { afterEach, describe, expect, it } from "vitest";

import { parseToMain } from "../shared/ipc-registry.js";
import { registerTraceHandlers } from "./trace-ipc.js";
import type { IpcHandle } from "./trace-ipc.js";
import { createTraceService } from "./trace-service.js";

const SESSION = "sess_ipc";
const OTHER = "sess_other_repo";
const EMPTY = "sess_not_started";
const TS = "2026-09-28T10:00:00.000Z";

const tempDirs: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  while (closers.length > 0) closers.pop()?.();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** Mirrors the ipc.ts handle wrapper: zod-parse the raw request, then call the handler. */
function harness(): {
  handle: IpcHandle;
  channels: () => string[];
  invoke: (channel: string, raw: unknown) => Promise<unknown>;
} {
  const handlers = new Map<string, (raw: unknown) => unknown>();
  const handle: IpcHandle = (channel, fn) => {
    handlers.set(channel, (raw) => fn(parseToMain(channel, raw)));
  };
  return {
    handle,
    channels: () => [...handlers.keys()].sort(),
    invoke: async (channel, raw) => {
      const handler = handlers.get(channel);
      if (handler === undefined) throw new Error(`no handler for ${channel}`);
      return await handler(raw);
    },
  };
}

/** Two repositories. SESSION (repo_open, running): seq 1 agent_started, 2 evidence_fact, 3 telemetry, one pending instruction. */
function seeded(): { db: JevcodeDb; ipc: ReturnType<typeof harness> } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jevcode-trace-ipc-"));
  tempDirs.push(dir);
  const db = openDb({ dbPath: path.join(dir, "trace.db") });
  db.upsertRepository({ id: "repo_open", path: "/work/open", gitRoot: "/work/open" });
  db.upsertRepository({ id: "repo_closed", path: "/work/closed", gitRoot: "/work/closed" });
  db.createSession({ id: SESSION, repoId: "repo_open", prompt: "Open repo task", state: "running" });
  db.createSession({ id: OTHER, repoId: "repo_closed", prompt: "Other repo task", state: "completed" });
  db.appendAgentEvent(SESSION, { type: "agent_started", sessionId: SESSION, prompt: "Open repo task", ts: TS });
  db.appendEvidenceFact(SESSION, {
    type: "command_executed",
    repoId: "repo_open",
    sessionId: SESSION,
    command: "pnpm test",
    exitCode: 0,
    isDestructive: false,
    ts: TS,
  });
  db.appendTelemetry("agent_event_count", {}, SESSION);
  db.appendAgentEvent(OTHER, { type: "agent_completed", sessionId: OTHER, ts: TS });
  db.upsertInstruction({
    sessionId: SESSION,
    instructionId: "instr_pending",
    mode: "queue",
    text: "Please also update the README",
  });
  const reader = openTraceReader(db.dbPath);
  const ipc = harness();
  registerTraceHandlers(ipc.handle, createTraceService(reader));
  closers.push(() => {
    reader.close();
    db.close();
  });
  return { db, ipc };
}

describe("trace IPC handlers", () => {
  it("registers exactly the three read-only channels", () => {
    const { ipc } = seeded();
    expect(ipc.channels()).toEqual(["trace:listSessions", "trace:payloads", "trace:rows"]);
  });

  it("reads never deliver, cancel or append anything", async () => {
    const { db, ipc } = seeded();
    const pendingBefore = db.listPendingInstructions(SESSION);
    const countBefore = db.getEventCount(SESSION);
    const latestBefore = db.getLatestSeq(SESSION);
    const sessionBefore = db.getSession(SESSION);
    const walBefore = statSync(`${db.dbPath}-wal`);
    const mainBefore = statSync(db.dbPath);

    const listed = (await ipc.invoke("trace:listSessions", {})) as { sessions: TraceSessionSummary[] };
    const page = (await ipc.invoke("trace:rows", { sessionId: SESSION })) as TraceRowsPage;
    const fetched = (await ipc.invoke("trace:payloads", { sessionId: SESSION, seqs: [1, 2, 3] })) as {
      rows: TraceRow[];
    };

    expect(listed.sessions.map((session) => session.sessionId).sort()).toEqual([OTHER, SESSION].sort());
    expect(page.rows.map((row) => row.type)).toEqual(["agent_event", "evidence_fact"]);
    expect(fetched.rows.map((row) => row.seq)).toEqual([1, 2, 3]);

    expect(pendingBefore).toHaveLength(1);
    expect(db.listPendingInstructions(SESSION)).toEqual(pendingBefore);
    expect(db.getInstruction(SESSION, "instr_pending")?.status).toBe("pending");
    expect(db.getEventCount(SESSION)).toBe(countBefore);
    expect(db.getLatestSeq(SESSION)).toBe(latestBefore);
    expect(db.getSession(SESSION)?.lastEventSeq).toBe(sessionBefore?.lastEventSeq);
    expect(db.getSession(SESSION)?.state).toBe("running");
    const walAfter = statSync(`${db.dbPath}-wal`);
    expect(walAfter.size).toBe(walBefore.size);
    expect(walAfter.mtimeMs).toBe(walBefore.mtimeMs);
    expect(statSync(db.dbPath).mtimeMs).toBe(mainBefore.mtimeMs);
  });

  it("rejects empty, unknown and out-of-bounds requests", async () => {
    const { ipc } = seeded();
    await expect(ipc.invoke("trace:rows", { sessionId: "" })).rejects.toMatchObject({
      code: "INVALID_PAYLOAD",
    });
    await expect(ipc.invoke("trace:rows", { sessionId: SESSION, limit: 5001 })).rejects.toMatchObject({
      code: "INVALID_PAYLOAD",
    });
    await expect(ipc.invoke("trace:rows", { sessionId: "sess_missing" })).rejects.toMatchObject({
      code: "UNKNOWN_SESSION",
    });
    await expect(
      ipc.invoke("trace:payloads", { sessionId: "sess_missing", seqs: [1] }),
    ).rejects.toMatchObject({ code: "UNKNOWN_SESSION" });
  });

  it("reads a session that belongs to another repository", async () => {
    const { ipc } = seeded();
    const page = (await ipc.invoke("trace:rows", { sessionId: OTHER })) as TraceRowsPage;
    expect(page).toMatchObject({ lastSeq: 1, state: "completed", nextAfterSeq: null });
    expect(page.rows.map((row) => row.type)).toEqual(["agent_event"]);
  });

  it("lists a zero-event session by exact id and reads it as an empty page", async () => {
    const { db, ipc } = seeded();
    db.createSession({ id: EMPTY, repoId: "repo_open", prompt: "Not started yet" });
    const listed = (await ipc.invoke("trace:listSessions", {})) as { sessions: TraceSessionSummary[] };
    expect(listed.sessions.map((session) => session.sessionId)).not.toContain(EMPTY);
    const exact = (await ipc.invoke("trace:listSessions", { sessionId: EMPTY, limit: 1 })) as {
      sessions: TraceSessionSummary[];
    };
    expect(exact.sessions).toEqual([
      expect.objectContaining({ sessionId: EMPTY, repoId: "repo_open", prompt: "Not started yet", lastEventSeq: 0 }),
    ]);
    await expect(ipc.invoke("trace:rows", { sessionId: EMPTY })).resolves.toEqual({
      rows: [],
      nextAfterSeq: null,
      lastSeq: 0,
      state: "starting",
    });
    await expect(ipc.invoke("trace:listSessions", { sessionId: "sess_missing" })).resolves.toEqual({
      sessions: [],
    });
    await expect(ipc.invoke("trace:listSessions", { sessionId: "" })).rejects.toMatchObject({
      code: "INVALID_PAYLOAD",
    });
  });
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `pnpm --filter jevcode-desktop exec vitest run src/shared/ipc-registry.test.ts src/main/trace-ipc.test.ts`
Expected: FAIL. `bounds the read-only trace channels` fails with `IpcError: toMain channel not registered: trace:listSessions`; `trace-ipc.test.ts` fails with `Error: Cannot find module './trace-ipc.js'`. The other 8 registry tests pass.

- [ ] **Step 4: Add the channels and request schemas**

In `apps/desktop/src/shared/local-channels.ts`, make four replacements.

Replace line 3:

```ts
import { AgentStateSchema, RendererToMainChannels } from "@jevcode/contracts";
```

with:

```ts
import {
  AgentStateSchema,
  RendererToMainChannels,
  TRACE_LIST_SESSIONS_MAX,
  TRACE_PAYLOADS_MAX,
  TRACE_ROWS_PAGE_MAX,
} from "@jevcode/contracts";
```

Replace lines 19-21:

```ts
  preferencesGet: "preferences:get",
  preferencesSet: "preferences:set",
} as const;
```

with:

```ts
  preferencesGet: "preferences:get",
  preferencesSet: "preferences:set",
  traceListSessions: "trace:listSessions",
  traceRows: "trace:rows",
  tracePayloads: "trace:payloads",
} as const;
```

Replace lines 203-205:

```ts
export type PreferencesUpdatedPayload = z.infer<
  typeof PreferencesUpdatedPayloadSchema
>;
```

with:

```ts
export type PreferencesUpdatedPayload = z.infer<
  typeof PreferencesUpdatedPayloadSchema
>;

// Read-only trace viewer requests (R5). Responses: trace:listSessions ->
// { sessions: TraceSessionSummary[] }, trace:rows -> TraceRowsPage,
// trace:payloads -> { rows: TraceRow[] } (types from @jevcode/contracts).
export const TraceListSessionsPayloadSchema = z.object({
  repoId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  limit: z.number().int().positive().max(TRACE_LIST_SESSIONS_MAX).optional(),
});

export const TraceRowsPayloadSchema = z.object({
  sessionId: z.string().min(1),
  afterSeq: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(TRACE_ROWS_PAGE_MAX).optional(),
});

export const TracePayloadsPayloadSchema = z.object({
  sessionId: z.string().min(1),
  seqs: z.array(z.number().int().positive()).min(1).max(TRACE_PAYLOADS_MAX),
});
```

Replace lines 221-222 (the end of `localToMain`):

```ts
  [RendererToMainLocalChannels.preferencesSet]: PreferencesSetPayloadSchema,
} as const;
```

with:

```ts
  [RendererToMainLocalChannels.preferencesSet]: PreferencesSetPayloadSchema,
  [RendererToMainLocalChannels.traceListSessions]: TraceListSessionsPayloadSchema,
  [RendererToMainLocalChannels.traceRows]: TraceRowsPayloadSchema,
  [RendererToMainLocalChannels.tracePayloads]: TracePayloadsPayloadSchema,
} as const;
```

- [ ] **Step 5: Write the handlers**

Create `apps/desktop/src/main/trace-ipc.ts`:

```ts
import type { ToMainChannelName, ToMainPayload } from "../shared/ipc-registry.js";
import { RendererToMainLocalChannels } from "../shared/local-channels.js";
import type { TraceService } from "./trace-service.js";

export type IpcHandle = <C extends ToMainChannelName>(
  channel: C,
  fn: (payload: ToMainPayload<C>) => unknown | Promise<unknown>,
) => void;

/**
 * Registers the three read-only trace channels on the ipc.ts handle wrapper,
 * which checks the sender and zod-parses the request first. The handlers get
 * only the TraceService (a query_only reader underneath): no runtime,
 * instruction router, Jev client or network, so a viewer read can never
 * deliver, cancel or append anything (R5, D9).
 */
export function registerTraceHandlers(handle: IpcHandle, service: TraceService): void {
  // -> { sessions: TraceSessionSummary[] }
  handle(RendererToMainLocalChannels.traceListSessions, (request) => ({
    sessions: service.listSessions(request),
  }));
  // -> TraceRowsPage
  handle(RendererToMainLocalChannels.traceRows, (request) => service.rows(request));
  // -> { rows: TraceRow[] }
  handle(RendererToMainLocalChannels.tracePayloads, (request) => ({
    rows: service.payloads(request),
  }));
}
```

- [ ] **Step 6: Run both tests to verify they pass**

Run: `pnpm --filter jevcode-desktop exec vitest run src/shared/ipc-registry.test.ts src/main/trace-ipc.test.ts`
Expected: PASS, `Tests  14 passed (14)` (9 registry tests, 5 handler tests).

- [ ] **Step 7: Register the handlers in `ipc.ts`**

In `apps/desktop/src/main/ipc.ts`, make three replacements.

Replace line 43:

```ts
import type { TerminalManager } from "./terminal-manager.js";
```

with:

```ts
import type { TerminalManager } from "./terminal-manager.js";
import { registerTraceHandlers } from "./trace-ipc.js";
import type { TraceService } from "./trace-service.js";
```

Replace lines 59-61 (the end of `IpcDeps`):

```ts
  requestRepoPath: () => Promise<string | null>;
  log: (message: string) => void;
}
```

with:

```ts
  requestRepoPath: () => Promise<string | null>;
  log: (message: string) => void;
  /** Read-only trace access over a query_only reader (trace-ipc.ts). */
  trace: TraceService;
}
```

Replace lines 415-420 (the end of `registerIpcHandlers`):

```ts
        clamps: log.clamps,
        ts: log.ts,
      }));
    return { decisions };
  });
}
```

with:

```ts
        clamps: log.clamps,
        ts: log.ts,
      }));
    return { decisions };
  });

  registerTraceHandlers(handle, deps.trace);
}
```

- [ ] **Step 8: Open and close the reader in `index.ts`**

In `apps/desktop/src/main/index.ts`, make six replacements.

Replace lines 8-9:

```ts
import { openDb } from "@jevcode/storage";
import type { JevcodeDb } from "@jevcode/storage";
```

with:

```ts
import { openDb, openTraceReader } from "@jevcode/storage";
import type { JevcodeDb, TraceReader } from "@jevcode/storage";
```

Replace line 23:

```ts
import { TerminalManager } from "./terminal-manager.js";
```

with:

```ts
import { TerminalManager } from "./terminal-manager.js";
import { createTraceService } from "./trace-service.js";
```

Replace lines 50-51:

```ts
let db: JevcodeDb | null = null;
let runtime: PipelineRuntime | null = null;
```

with:

```ts
let db: JevcodeDb | null = null;
let traceReader: TraceReader | null = null;
let runtime: PipelineRuntime | null = null;
```

Replace lines 93-94:

```ts
app.whenReady().then(() => {
  db = openDb();
```

with:

```ts
app.whenReady().then(() => {
  db = openDb();
  // A second, query_only connection for the trace viewer (R5): trace:*
  // handlers read through it and can never write.
  const reader = openTraceReader(db.dbPath);
  traceReader = reader;
```

Replace lines 156-157 (inside the `registerIpcHandlers({ … })` call):

```ts
    instructionRouter,
    requestRepoPath: () => openDirectoryDialog(mainWindow),
```

with:

```ts
    instructionRouter,
    trace: createTraceService(reader),
    requestRepoPath: () => openDirectoryDialog(mainWindow),
```

Replace lines 181-182 (inside the `will-quit` handler):

```ts
  terminals = null;
  db?.close();
```

with:

```ts
  terminals = null;
  traceReader?.close();
  traceReader = null;
  db?.close();
```

- [ ] **Step 9: Typecheck, build and confirm the wiring**

`ipc.ts` and `index.ts` import `electron`, so vitest cannot load them; the typecheck and the built output verify them.

Run: `pnpm --filter jevcode-desktop typecheck`
Expected: exit 0.

Run: `pnpm --filter jevcode-desktop build`
Expected: exit 0.

Run: `grep -c "registerTraceHandlers(handle, deps.trace)" apps/desktop/dist/main/ipc.js`
Expected: `1`

Run: `grep -c "openTraceReader" apps/desktop/dist/main/index.js`
Expected: `2`

- [ ] **Step 10: Run the root checks**

Run, in order: `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r --no-bail --workspace-concurrency=1 test`, `pnpm lint`
Expected: each exits 0.

- [ ] **Step 11: Commit**

```bash
git add apps/desktop/src/shared/local-channels.ts apps/desktop/src/shared/ipc-registry.test.ts apps/desktop/src/main/trace-ipc.ts apps/desktop/src/main/trace-ipc.test.ts apps/desktop/src/main/ipc.ts apps/desktop/src/main/index.ts
git commit -m "feat(desktop): serve read-only trace:* IPC channels"
```

---

### Task A2-4: `JevcodeApi.trace` namespace

**Files:**
- Modify: `apps/desktop/src/shared/api.ts:1-5`, `:129-134`, `:288-292`
- Modify: `apps/desktop/src/shared/api.test.ts:164-172`
- No change: `apps/desktop/src/preload/index.ts` exposes the whole `createJevcodeApi` object through `contextBridge.exposeInMainWorld("jevcode", api)`, and `Window.jevcode` is typed as `JevcodeApi` (`src/shared/bridge.ts`), so the new namespace reaches the renderer without edits.

**Interfaces:**
- Consumes:
  - A2-3: channels `"trace:listSessions"`, `"trace:rows"`, `"trace:payloads"` in the toMain registry, with the request bounds above.
  - W0-5: types `TraceRow`, `TraceRowsPage`, `TraceSessionSummary` from `@jevcode/contracts`.
  - Not consumed: W0-6's `TraceSource` (`@jevcode/trace-viewer`) is session-bound (`readonly sessionId`, `summary()`, `rows(request?)`, `payloads(seqs)`, `now()`; UI index §1.2(b), spec §7.7), so this namespace is not a `TraceSource` and `api.test.ts` does not import one. Lane M5 (D-3) adapts it with `createIpcTraceSource(bridge.trace, sessionId)`, whose `summary()` calls `listSessions({ sessionId, limit: 1 })`.
- Produces (interfaces §2.5, plus `sessionId?` from UI index §1.3):
  ```ts
  trace: {
    listSessions(request?: { repoId?: string; sessionId?: string; limit?: number }): Promise<TraceSessionSummary[]>;
    rows(request: { sessionId: string; afterSeq?: number; limit?: number }): Promise<TraceRowsPage>;
    payloads(request: { sessionId: string; seqs: readonly number[] }): Promise<TraceRow[]>;
  };
  ```
  The namespace holds exactly these three reads until D-3 adds `open` and `requestChanges`; D-3 then replaces the keys test below.

- [ ] **Step 1: Write the failing tests**

In `apps/desktop/src/shared/api.test.ts`, replace the end of the file (current lines 164-172):

```ts
    expect(listener).toHaveBeenCalledWith({
      sessionId: "s1",
      pending: [
        expect.objectContaining({ id: "i1", mode: "queue" }),
      ],
    });
    unsubscribe();
  });
});
```

with:

```ts
    expect(listener).toHaveBeenCalledWith({
      sessionId: "s1",
      pending: [
        expect.objectContaining({ id: "i1", mode: "queue" }),
      ],
    });
    unsubscribe();
  });

  it("reads traces through the three trace channels", async () => {
    const deps = makeDeps();
    const page = {
      rows: [{ seq: 1, type: "agent_event", ts: "2026-09-28T10:00:00.000Z", payload: {} }],
      nextAfterSeq: null,
      lastSeq: 1,
      state: "running",
    };
    deps.invoke.mockImplementation(async (channel: string) => {
      if (channel === "trace:listSessions") return { sessions: [] };
      if (channel === "trace:rows") return page;
      if (channel === "trace:payloads") return { rows: page.rows };
      return undefined;
    });
    const api = createJevcodeApi(deps);
    await expect(api.trace.listSessions()).resolves.toEqual([]);
    expect(deps.invoke).toHaveBeenCalledWith("trace:listSessions", {});
    await expect(api.trace.listSessions({ sessionId: "s", limit: 1 })).resolves.toEqual([]);
    expect(deps.invoke).toHaveBeenCalledWith("trace:listSessions", { sessionId: "s", limit: 1 });
    await expect(api.trace.rows({ sessionId: "s" })).resolves.toEqual(page);
    expect(deps.invoke).toHaveBeenCalledWith("trace:rows", { sessionId: "s" });
    const seqs: readonly number[] = Object.freeze([3, 1]);
    await expect(api.trace.payloads({ sessionId: "s", seqs })).resolves.toEqual(page.rows);
    const sent = deps.invoke.mock.calls.find(([channel]) => channel === "trace:payloads")?.[1] as
      | { sessionId: string; seqs: number[] }
      | undefined;
    expect(sent).toEqual({ sessionId: "s", seqs: [3, 1] });
    expect(sent !== undefined && Object.isFrozen(sent.seqs)).toBe(false);
  });

  it("rejects out-of-bounds trace requests before they reach main", async () => {
    const deps = makeDeps();
    const api = createJevcodeApi(deps);
    await expect(api.trace.rows({ sessionId: "s", limit: 5001 })).rejects.toMatchObject({
      code: "INVALID_PAYLOAD",
    });
    await expect(api.trace.payloads({ sessionId: "s", seqs: [] })).rejects.toMatchObject({
      code: "INVALID_PAYLOAD",
    });
    await expect(api.trace.listSessions({ sessionId: "" })).rejects.toMatchObject({
      code: "INVALID_PAYLOAD",
    });
    expect(deps.invoke).not.toHaveBeenCalled();
  });

  it("the trace namespace holds exactly the three reads", () => {
    const trace = createJevcodeApi(makeDeps()).trace;
    expect(Object.keys(trace).sort()).toEqual(["listSessions", "payloads", "rows"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter jevcode-desktop exec vitest run src/shared/api.test.ts`
Expected: FAIL in the three new tests with `TypeError: Cannot read properties of undefined (reading 'listSessions')`, `(reading 'rows')` and `TypeError: Cannot convert undefined or null to object`. The 9 existing tests pass.

- [ ] **Step 3: Add the namespace**

In `apps/desktop/src/shared/api.ts`, make three replacements.

Replace lines 1-5:

```ts
import {
  AgentInstructionStatePayloadSchema,
  MainToRendererChannels,
} from "@jevcode/contracts";
import type { z } from "zod";
```

with:

```ts
import {
  AgentInstructionStatePayloadSchema,
  MainToRendererChannels,
} from "@jevcode/contracts";
import type {
  TraceRow,
  TraceRowsPage,
  TraceSessionSummary,
} from "@jevcode/contracts";
import type { z } from "zod";
```

Replace lines 129-134 (the end of the `debug` block in `JevcodeApi`):

```ts
    listJevDecisions(
      sessionId?: string,
      limit?: number,
    ): Promise<DebugJevDecisionsPayload["decisions"]>;
  };
  on<C extends FromMainChannelName>(
```

with:

```ts
    listJevDecisions(
      sessionId?: string,
      limit?: number,
    ): Promise<DebugJevDecisionsPayload["decisions"]>;
  };
  /**
   * Read-only trace access (R5). The trace window adapts it to the viewer's
   * session-bound TraceSource with createIpcTraceSource(bridge.trace, sessionId).
   * listSessions({ sessionId }) returns that one session even with zero events.
   */
  trace: {
    listSessions(request?: {
      repoId?: string;
      sessionId?: string;
      limit?: number;
    }): Promise<TraceSessionSummary[]>;
    rows(request: { sessionId: string; afterSeq?: number; limit?: number }): Promise<TraceRowsPage>;
    payloads(request: { sessionId: string; seqs: readonly number[] }): Promise<TraceRow[]>;
  };
  on<C extends FromMainChannelName>(
```

Replace lines 288-292 (the end of the `debug` implementation in `createJevcodeApi`):

```ts
        })) as DebugJevDecisionsPayload;
        return result.decisions;
      },
    },
    on,
```

with:

```ts
        })) as DebugJevDecisionsPayload;
        return result.decisions;
      },
    },
    trace: {
      listSessions: async (request) => {
        const result = (await invoke("trace:listSessions", request ?? {})) as {
          sessions: TraceSessionSummary[];
        };
        return result.sessions;
      },
      rows: async (request) => {
        return (await invoke("trace:rows", request)) as TraceRowsPage;
      },
      payloads: async (request) => {
        const result = (await invoke("trace:payloads", {
          sessionId: request.sessionId,
          seqs: [...request.seqs],
        })) as { rows: TraceRow[] };
        return result.rows;
      },
    },
    on,
```

The casts follow the existing trusted-cast pattern (`repo.listRecent`, `debug.listEvents`): main builds these values from typed service output.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter jevcode-desktop exec vitest run src/shared/api.test.ts`
Expected: PASS, `Tests  12 passed (12)`

- [ ] **Step 5: Typecheck all three desktop configs and check the preload bundle**

Run: `pnpm --filter jevcode-desktop typecheck`
Expected: exit 0. This runs `tsconfig.json` (main), `tsconfig.preload.json` and `tsconfig.web.json`; the last two include `src/shared`, so the `trace` namespace types and `api.test.ts` are checked under both module resolutions.

Run: `pnpm --filter jevcode-desktop build`
Expected: exit 0.

Run: `grep -c "trace:rows" apps/desktop/dist/preload/index.cjs`
Expected: a number of 1 or more (the preload bundle carries the new channel).

- [ ] **Step 6: Run the root checks**

Run, in order: `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r --no-bail --workspace-concurrency=1 test`, `pnpm lint`
Expected: each exits 0.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/shared/api.ts apps/desktop/src/shared/api.test.ts
git commit -m "feat(desktop): expose the trace namespace on window.jevcode"
```

---

### Task A2-5: `buildTraceBundle`; `runReplay` writes `trace.json`

**Files:**
- Create: `apps/desktop/src/main/trace-bundle.ts`
- Create: `apps/desktop/src/main/trace-bundle.test.ts`
- Modify: `apps/desktop/src/main/replay/cli-entry.ts:5`, `:16`, `:25-27`, `:177-179`, `:189-191`
- Create: `apps/desktop/src/main/replay/cli-entry.test.ts`

**Interfaces:**
- Consumes:
  - A2-2: `TraceService`, `createTraceService(reader: TraceReader): TraceService`, `readAllRows(service, sessionId, pageSize?): { rows: TraceRow[]; lastSeq: number; state: AgentState }`.
  - A2-1: `openTraceReader(dbPath: string): TraceReader`.
  - `apps/desktop/src/main/pipeline/redactor.ts` (owned by A1; import only): `redactText(input: string): { text: string; count: number }`. A1-7 widens the `env_value` rule to allow one leading diff prefix; the signature does not change.
  - W0-5 (`@jevcode/contracts`): `TraceBundleSchema`, `TRACE_BUNDLE_FORMAT = "jevcode.trace"`, `TRACE_BUNDLE_VERSION = 1`, `TRACE_ROWS_PAGE_MAX`, types `TraceBundle = { format; version; exportedAt: string; redactionCount: number; session: TraceSessionSummary; rows: TraceRow[] }`, `TraceRow`, `isTraceRowType`.
  - Existing: `runReplay(fixtureDir: string, outDir: string, log?: (message: string) => void): Promise<ReplayResult>`; `JevcodeDb.dbPath`.
- Produces (interfaces §2.5, verbatim, plus `ReplayResult.bundlePath`):
  ```ts
  export interface BuildTraceBundleOptions {
    homeDir?: string;      // default os.homedir()
    now?: () => string;    // default () => new Date().toISOString()
    pageSize?: number;     // default TRACE_ROWS_PAGE_MAX
  }
  export function buildTraceBundle(service: TraceService, sessionId: string, options?: BuildTraceBundleOptions): TraceBundle;
  export function redactBundleValue(value: unknown, homeDir: string): { value: unknown; count: number };
  export function writeTraceBundle(filePath: string, bundle: TraceBundle): void; // JSON + "\n", mode 0o600
  // replay/cli-entry.ts
  export interface ReplayResult { /* existing fields */ bundlePath: string }
  ```

- [ ] **Step 1: Write the failing bundle test**

Create `apps/desktop/src/main/trace-bundle.test.ts`:

```ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { TraceBundleSchema } from "@jevcode/contracts";
import { openDb, openTraceReader } from "@jevcode/storage";
import { afterEach, describe, expect, it } from "vitest";

import { buildTraceBundle, redactBundleValue, writeTraceBundle } from "./trace-bundle.js";
import { createTraceService, readAllRows } from "./trace-service.js";
import type { TraceService } from "./trace-service.js";

const SESSION = "sess_bundle";
const REPO = "repo_bundle";
const TS = "2026-09-28T10:00:00.000Z";
const HOME = "/Users/tester";

const tempDirs: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  while (closers.length > 0) closers.pop()?.();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jevcode-trace-bundle-"));
  tempDirs.push(dir);
  return dir;
}

/** seq 1 agent_started, 2 agent_message (token), 3 command_completed (env line), 4 command_executed fact, 5 file_read. */
function seeded(): TraceService {
  const db = openDb({ dbPath: path.join(tempDir(), "trace.db") });
  db.upsertRepository({ id: REPO, path: "/work/bundle", gitRoot: "/work/bundle" });
  db.createSession({ id: SESSION, repoId: REPO, prompt: `Fix ${HOME}/repo/src/a.ts` });
  db.appendAgentEvent(SESSION, {
    type: "agent_started",
    sessionId: SESSION,
    prompt: `Fix ${HOME}/repo/src/a.ts`,
    ts: TS,
  });
  db.appendAgentEvent(SESSION, {
    type: "agent_message",
    sessionId: SESSION,
    role: "assistant",
    text: "export token=abc123secret",
    ts: TS,
  });
  db.appendAgentEvent(SESSION, {
    type: "command_completed",
    sessionId: SESSION,
    command: "cat .env",
    exitCode: 0,
    stdout: "STRIPE_SECRET_KEY=sk_live_1234\n",
    stderr: "",
    ts: TS,
  });
  db.appendEvidenceFact(SESSION, {
    type: "command_executed",
    repoId: REPO,
    sessionId: SESSION,
    command: `ls ${HOME}/repo`,
    exitCode: 0,
    isDestructive: false,
    ts: TS,
  });
  db.appendAgentEvent(SESSION, {
    type: "file_read",
    sessionId: SESSION,
    path: "/Users/tester2/notes.md",
    ts: TS,
  });
  const reader = openTraceReader(db.dbPath);
  closers.push(() => {
    reader.close();
    db.close();
  });
  return createTraceService(reader);
}

describe("trace bundle", () => {
  it("redacts tokens and maps home", () => {
    const service = seeded();
    const before = readAllRows(service, SESSION).rows;
    const bundle = buildTraceBundle(service, SESSION, {
      homeDir: HOME,
      now: () => "2026-09-28T12:00:00.000Z",
    });
    const text = JSON.stringify(bundle);
    expect(text).not.toContain("abc123secret");
    expect(text).not.toContain("sk_live_1234");
    expect(text).not.toContain(`${HOME}/`);
    expect(text).toContain("token=[REDACTED:token]");
    expect(text).toContain("STRIPE_SECRET_KEY=[REDACTED:env_value]");
    expect(bundle.redactionCount).toBe(2);
    expect(bundle.session.prompt).toBe("Fix ~/repo/src/a.ts");
    expect(bundle.rows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);
    expect((bundle.rows[3]?.payload as { command: string }).command).toBe("ls ~/repo");
    expect((bundle.rows[4]?.payload as { path: string }).path).toBe("/Users/tester2/notes.md");
    expect(bundle.rows[3]?.factId).toBe(before[3]?.factId);
    expect(bundle.rows[3]?.factId).toMatch(/^fact_[0-9a-f]{16}$/);
    expect(bundle).toMatchObject({
      format: "jevcode.trace",
      version: 1,
      exportedAt: "2026-09-28T12:00:00.000Z",
      session: { sessionId: SESSION, lastEventSeq: 5, state: "starting" },
    });
    expect(TraceBundleSchema.safeParse(bundle).success).toBe(true);
  });

  it("maps home only at a path boundary and does not recount redacted markers", () => {
    expect(redactBundleValue({ a: "token=[REDACTED:token]" }, HOME)).toEqual({
      value: { a: "token=[REDACTED:token]" },
      count: 0,
    });
    expect(redactBundleValue(["password=hunter2", 7, null, true], HOME)).toEqual({
      value: ["password=[REDACTED:password]", 7, null, true],
      count: 1,
    });
    expect(redactBundleValue(`${HOME}`, `${HOME}/`)).toEqual({ value: "~", count: 0 });
    expect(redactBundleValue(`${HOME}.bak and ${HOME}-old and ${HOME}2`, HOME)).toEqual({
      value: `${HOME}.bak and ${HOME}-old and ${HOME}2`,
      count: 0,
    });
    expect(redactBundleValue(`"${HOME}" ${HOME}/a`, HOME)).toEqual({ value: '"~" ~/a', count: 0 });
    expect(redactBundleValue("/a/b", "/")).toEqual({ value: "/a/b", count: 0 });
  });

  it("writes exactly JSON.stringify(bundle) plus a newline", () => {
    const service = seeded();
    const bundle = buildTraceBundle(service, SESSION, { homeDir: HOME });
    const file = path.join(tempDir(), "nested", "trace.json");
    writeTraceBundle(file, bundle);
    expect(readFileSync(file, "utf8")).toBe(`${JSON.stringify(bundle)}\n`);
    const empty = { ...bundle, rows: [] };
    writeTraceBundle(file, empty);
    expect(readFileSync(file, "utf8")).toBe(`${JSON.stringify(empty)}\n`);
    expect(TraceBundleSchema.parse(JSON.parse(readFileSync(file, "utf8")))).toEqual(empty);
  });

  it.skipIf(process.platform === "win32")("writes mode 0600 even over an existing 0644 file", () => {
    const service = seeded();
    const file = path.join(tempDir(), "out", "trace.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "old", { mode: 0o644 });
    writeTraceBundle(file, buildTraceBundle(service, SESSION, { homeDir: HOME }));
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
```

The expected `redactionCount` of 2 follows from the `redactText` rules: `token=abc123secret` matches the `token` rule once, and the line `STRIPE_SECRET_KEY=sk_live_1234` matches the `env_value` rule once; no other string in the session matches any rule.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter jevcode-desktop exec vitest run src/main/trace-bundle.test.ts`
Expected: FAIL, `Error: Cannot find module './trace-bundle.js' imported from …/trace-bundle.test.ts`

- [ ] **Step 3: Write the bundle module**

Create `apps/desktop/src/main/trace-bundle.ts`:

```ts
import { chmodSync, closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  TRACE_BUNDLE_FORMAT,
  TRACE_BUNDLE_VERSION,
  TRACE_ROWS_PAGE_MAX,
  TraceBundleSchema,
} from "@jevcode/contracts";
import type { TraceBundle, TraceRow } from "@jevcode/contracts";

import { redactText } from "./pipeline/redactor.js";
import { readAllRows } from "./trace-service.js";
import type { TraceService } from "./trace-service.js";

export interface BuildTraceBundleOptions {
  homeDir?: string; // default os.homedir()
  now?: () => string; // default () => new Date().toISOString()
  pageSize?: number; // default TRACE_ROWS_PAGE_MAX
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches homeDir only where a path segment ends, so "/Users/ann" maps in
 * "/Users/ann/x" and "/Users/ann" but not in "/Users/anna/x" or "/Users/ann.bak".
 * Returns null for "" and "/", which would otherwise rewrite every path.
 */
function homePattern(homeDir: string): RegExp | null {
  const trimmed = homeDir.replace(/[\\/]+$/, "");
  if (trimmed.length === 0) return null;
  return new RegExp(`${escapeRegExp(trimmed)}(?![\\w.-])`, "g");
}

/**
 * Deep walk: every string passes redactText, then homeDir becomes "~".
 * count adds a string's redaction hits only when redaction changed it, so an
 * already-redacted marker such as "token=[REDACTED:token]" is not counted again.
 */
export function redactBundleValue(
  value: unknown,
  homeDir: string,
): { value: unknown; count: number } {
  const home = homePattern(homeDir);
  let count = 0;
  const walk = (current: unknown): unknown => {
    if (typeof current === "string") {
      const redacted = redactText(current);
      if (redacted.text !== current) count += redacted.count;
      return home === null ? redacted.text : redacted.text.replace(home, "~");
    }
    if (Array.isArray(current)) return current.map(walk);
    if (current !== null && typeof current === "object") {
      return Object.fromEntries(
        Object.entries(current).map(([key, entry]): [string, unknown] => [key, walk(entry)]),
      );
    }
    return current;
  };
  return { value: walk(value), count };
}

/** readAllRows, then every string in session and rows passes redactText and has homeDir replaced by "~". factIds are kept as computed. */
export function buildTraceBundle(
  service: TraceService,
  sessionId: string,
  options: BuildTraceBundleOptions = {},
): TraceBundle {
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? (() => new Date().toISOString());
  const summary = service.session(sessionId);
  const all = readAllRows(service, sessionId, options.pageSize ?? TRACE_ROWS_PAGE_MAX);
  // The summary is re-stamped from the last page so lastEventSeq and state
  // describe exactly the rows in this bundle.
  const session = redactBundleValue(
    { ...summary, lastEventSeq: all.lastSeq, state: all.state },
    homeDir,
  );
  let redactionCount = session.count;
  const rows = all.rows.map((row): TraceRow => {
    // Envelope fields (seq, type, ts, clipped, factId) are machine values;
    // factId must stay the pre-redaction content id.
    if (!("payload" in row)) return row;
    const payload = redactBundleValue(row.payload, homeDir);
    redactionCount += payload.count;
    return { ...row, payload: payload.value };
  });
  return TraceBundleSchema.parse({
    format: TRACE_BUNDLE_FORMAT,
    version: TRACE_BUNDLE_VERSION,
    exportedAt: now(),
    redactionCount,
    session: session.value,
    rows,
  });
}

/** JSON + "\n", file mode 0o600. Rows are written one at a time, so a large session never becomes one giant string. */
export function writeTraceBundle(filePath: string, bundle: TraceBundle): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const { rows, ...head } = bundle;
  const headJson = JSON.stringify(head);
  const fd = openSync(filePath, "w", 0o600);
  try {
    writeSync(fd, `${headJson.slice(0, -1)},"rows":[`);
    rows.forEach((row, index) => {
      writeSync(fd, `${index === 0 ? "" : ","}${JSON.stringify(row)}`);
    });
    writeSync(fd, "]}\n");
  } finally {
    closeSync(fd);
  }
  // openSync's mode applies only when it creates the file.
  chmodSync(filePath, 0o600);
}
```

`headJson.slice(0, -1)` drops the closing brace of `{format, version, exportedAt, redactionCount, session}`; `TraceBundleSchema.parse` returns keys in schema order with `rows` last, so the streamed text equals `JSON.stringify(bundle)`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter jevcode-desktop exec vitest run src/main/trace-bundle.test.ts`
Expected: PASS, `Tests  4 passed (4)` (on win32 the mode test is skipped).

- [ ] **Step 5: Write the failing replay test**

Create `apps/desktop/src/main/replay/cli-entry.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TraceBundleSchema, isTraceRowType } from "@jevcode/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { runReplay } from "./cli-entry.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../");

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jevcode-replay-cli-"));
  tempDirs.push(dir);
  return dir;
}

describe("runReplay trace bundle", () => {
  it("writes trace.json whose unit evidence ids resolve to row factIds", async () => {
    const outDir = path.join(tempDir(), "replay-oauth");
    const result = await runReplay(path.join(repoRoot, "fixtures", "oauth"), outDir);
    expect(result.errors).toEqual([]);
    expect(result.bundlePath).toBe(path.join(outDir, "trace.json"));
    const bundle = TraceBundleSchema.parse(JSON.parse(readFileSync(result.bundlePath, "utf8")));
    expect(bundle.session.sessionId).toBe(result.sessionId);
    expect(bundle.rows.length).toBeGreaterThan(0);
    expect(bundle.rows.every((row) => isTraceRowType(row.type))).toBe(true);
    const seqs = bundle.rows.map((row) => row.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(Math.max(...seqs)).toBeLessThanOrEqual(bundle.session.lastEventSeq);
    const factIds = new Set(
      bundle.rows.flatMap((row) => (row.factId === undefined ? [] : [row.factId])),
    );
    const latestUnits = new Map<string, { evidence: string[] }>();
    for (const row of bundle.rows) {
      if (row.type !== "change_unit") continue;
      const unit = row.payload as { id: string; evidence: string[] };
      latestUnits.set(unit.id, unit);
    }
    const cited = [...latestUnits.values()].flatMap((unit) =>
      unit.evidence.filter((id) => id.startsWith("fact_")),
    );
    expect(cited.length).toBeGreaterThan(0);
    expect(cited.filter((id) => !factIds.has(id))).toEqual([]);
    if (process.platform !== "win32") {
      expect(statSync(result.bundlePath).mode & 0o777).toBe(0o600);
    }
  }, 60_000);
});
```

The fact-id assertion holds before and after lane A1-5: replay hashes the zod-parsed record and stores the same zod-ordered object, and the service hashes the stored payload with the same `factContentId`. On 2026-09-28 the current oauth replay cited 31 `fact_` ids and all 31 resolved.

- [ ] **Step 6: Run the replay test to verify it fails**

Run: `pnpm --filter jevcode-desktop exec vitest run src/main/replay/cli-entry.test.ts`
Expected: FAIL, `AssertionError: expected undefined to be '…/replay-oauth/trace.json'`

- [ ] **Step 7: Write `trace.json` from `runReplay`**

In `apps/desktop/src/main/replay/cli-entry.ts`, make five replacements.

Replace line 5:

```ts
import { openDb } from "@jevcode/storage";
```

with:

```ts
import { openDb, openTraceReader } from "@jevcode/storage";
```

Replace line 16:

```ts
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
```

with:

```ts
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import { buildTraceBundle, writeTraceBundle } from "../trace-bundle.js";
import { createTraceService } from "../trace-service.js";
```

Replace lines 25-27 (the end of `ReplayResult`):

```ts
  specCount: number;
  errors: string[];
}
```

with:

```ts
  specCount: number;
  errors: string[];
  /** <outDir>/trace.json: a TraceBundle (format jevcode.trace v1) of the replayed session. */
  bundlePath: string;
}
```

Replace lines 177-179:

```ts
    await runtime.stopSession(sessionId);

    return {
```

with:

```ts
    await runtime.stopSession(sessionId);

    // Read back through a second, query_only connection, the same path the
    // trace viewer uses, so trace.json holds exactly what the viewer loads.
    const bundlePath = path.join(outDir, "trace.json");
    const reader = openTraceReader(db.dbPath);
    try {
      writeTraceBundle(bundlePath, buildTraceBundle(createTraceService(reader), sessionId));
    } finally {
      reader.close();
    }

    return {
```

Replace lines 189-191:

```ts
      specCount: surfaces.size,
      errors,
    };
```

with:

```ts
      specCount: surfaces.size,
      errors,
      bundlePath,
    };
```

`replayMain` prints `...result`, so its JSON output now includes `bundlePath`.

- [ ] **Step 8: Run both tests to verify they pass**

Run: `pnpm --filter jevcode-desktop exec vitest run src/main/trace-bundle.test.ts src/main/replay/cli-entry.test.ts`
Expected: PASS, `Tests  5 passed (5)`

- [ ] **Step 9: Replay a fixture through the CLI**

Run: `pnpm --filter jevcode-desktop build`
Expected: exit 0.

Run: `node apps/desktop/scripts/replay.mjs fixtures/rate-limit "${TMPDIR:-/tmp}/jevcode-a2-replay"`
Expected: exit 0; the printed JSON has `"errors": []` and a `"bundlePath"` ending in `jevcode-a2-replay/trace.json`.

Run: `node --input-type=module -e 'import { readFileSync } from "node:fs"; import { TraceBundleSchema } from "./packages/contracts/dist/index.js"; const bundle = TraceBundleSchema.parse(JSON.parse(readFileSync(process.argv[1], "utf8"))); console.log(bundle.session.sessionId, bundle.rows.length);' "${TMPDIR:-/tmp}/jevcode-a2-replay/trace.json"`
Expected: `sess-ratelimit-0001` followed by a row count greater than 0.

- [ ] **Step 10: Run the root checks**

Run, in order: `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r --no-bail --workspace-concurrency=1 test`, `pnpm lint`
Expected: each exits 0.

- [ ] **Step 11: Commit**

```bash
git add apps/desktop/src/main/trace-bundle.ts apps/desktop/src/main/trace-bundle.test.ts apps/desktop/src/main/replay/cli-entry.ts apps/desktop/src/main/replay/cli-entry.test.ts
git commit -m "feat(desktop): write redacted trace.json bundles from replay"
```

---

### Task A2-6: `replay export --db --session --out`; demo and security docs

**Files:**
- Modify: `apps/desktop/src/main/replay/cli-entry.ts` (anchors quoted below; line numbers are after A2-5: `:6`, `:9-12`, `:217-223`)
- Modify: `apps/desktop/src/main/replay/cli-entry.test.ts` (whole file, created in A2-5)
- Modify: `docs/demo.md:33-35`
- Modify: `docs/security.md:12` (append row 7; interface deviation 1)

**Interfaces:**
- Consumes:
  - A2-5: `buildTraceBundle(service, sessionId, options?)`, `writeTraceBundle(filePath, bundle)`.
  - A2-2: `createTraceService(reader)`; `IpcError` with code `"UNKNOWN_SESSION"` from `service.session`.
  - A2-1: `openTraceReader(dbPath: string): TraceReader` (throws for a missing file; never creates one), type `TraceReader`.
  - `apps/desktop/scripts/replay.mjs` needs no change: its guard only checks that `argv[2]` and `argv[3]` exist, then calls `replayMain(process.argv)`.
- Produces:
  ```ts
  export const EXPORT_USAGE = "usage: jevcode-replay export --db <path> --session <id> --out <file>";
  export async function exportMain(args: readonly string[]): Promise<number>; // 0 on success, 1 on any failure
  // replayMain(argv) dispatches argv[2] === "export" to exportMain(argv.slice(3)).
  // Success prints one line: {"out": <absolute path>, "rows": <number>, "redactionCount": <number>}
  ```

- [ ] **Step 1: Write the failing tests**

Replace the whole of `apps/desktop/src/main/replay/cli-entry.test.ts` (created in A2-5) with:

```ts
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TraceBundleSchema, isTraceRowType } from "@jevcode/contracts";
import { openDb } from "@jevcode/storage";
import { afterEach, describe, expect, it, vi } from "vitest";

import { exportMain, replayMain, runReplay } from "./cli-entry.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../");
const TS = "2026-09-28T10:00:00.000Z";
const USAGE = "usage: jevcode-replay export --db <path> --session <id> --out <file>";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jevcode-replay-cli-"));
  tempDirs.push(dir);
  return dir;
}

/** A closed database file holding sess_export: seq 1 agent_started, 2 agent_message with a planted token. */
function seededDbPath(dir: string): string {
  const db = openDb({ dbPath: path.join(dir, "export.db") });
  db.upsertRepository({ id: "repo_export", path: "/work/export", gitRoot: "/work/export" });
  db.createSession({ id: "sess_export", repoId: "repo_export", prompt: "Export me" });
  db.appendAgentEvent("sess_export", {
    type: "agent_started",
    sessionId: "sess_export",
    prompt: "Export me",
    ts: TS,
  });
  db.appendAgentEvent("sess_export", {
    type: "agent_message",
    sessionId: "sess_export",
    role: "assistant",
    text: "export token=abc123secret",
    ts: TS,
  });
  const dbPath = db.dbPath;
  db.close();
  return dbPath;
}

describe("runReplay trace bundle", () => {
  it("writes trace.json whose unit evidence ids resolve to row factIds", async () => {
    const outDir = path.join(tempDir(), "replay-oauth");
    const result = await runReplay(path.join(repoRoot, "fixtures", "oauth"), outDir);
    expect(result.errors).toEqual([]);
    expect(result.bundlePath).toBe(path.join(outDir, "trace.json"));
    const bundle = TraceBundleSchema.parse(JSON.parse(readFileSync(result.bundlePath, "utf8")));
    expect(bundle.session.sessionId).toBe(result.sessionId);
    expect(bundle.rows.length).toBeGreaterThan(0);
    expect(bundle.rows.every((row) => isTraceRowType(row.type))).toBe(true);
    const seqs = bundle.rows.map((row) => row.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(Math.max(...seqs)).toBeLessThanOrEqual(bundle.session.lastEventSeq);
    const factIds = new Set(
      bundle.rows.flatMap((row) => (row.factId === undefined ? [] : [row.factId])),
    );
    const latestUnits = new Map<string, { evidence: string[] }>();
    for (const row of bundle.rows) {
      if (row.type !== "change_unit") continue;
      const unit = row.payload as { id: string; evidence: string[] };
      latestUnits.set(unit.id, unit);
    }
    const cited = [...latestUnits.values()].flatMap((unit) =>
      unit.evidence.filter((id) => id.startsWith("fact_")),
    );
    expect(cited.length).toBeGreaterThan(0);
    expect(cited.filter((id) => !factIds.has(id))).toEqual([]);
    if (process.platform !== "win32") {
      expect(statSync(result.bundlePath).mode & 0o777).toBe(0o600);
    }
  }, 60_000);
});

describe("replay export", () => {
  it("exports a stored session to a 0600 bundle and prints a summary", async () => {
    const dir = tempDir();
    const dbPath = seededDbPath(dir);
    const out = path.join(dir, "out", "trace.json");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await exportMain(["--db", dbPath, "--session", "sess_export", "--out", out])).toBe(0);
    const bundle = TraceBundleSchema.parse(JSON.parse(readFileSync(out, "utf8")));
    expect(bundle.rows.map((row) => row.seq)).toEqual([1, 2]);
    expect(JSON.stringify(bundle)).not.toContain("abc123secret");
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({ out, rows: 2, redactionCount: 1 });
    if (process.platform !== "win32") {
      expect(statSync(out).mode & 0o777).toBe(0o600);
    }
  });

  it("replayMain dispatches the export subcommand", async () => {
    const dir = tempDir();
    const dbPath = seededDbPath(dir);
    const out = path.join(dir, "dispatched.json");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await replayMain([
      "node",
      "replay.mjs",
      "export",
      "--db",
      dbPath,
      "--session",
      "sess_export",
      "--out",
      out,
    ]);
    expect(code).toBe(0);
    expect(TraceBundleSchema.parse(JSON.parse(readFileSync(out, "utf8"))).session.sessionId).toBe(
      "sess_export",
    );
  });

  it("returns 1 with usage and writes nothing when a flag is missing or malformed", async () => {
    const dir = tempDir();
    const dbPath = seededDbPath(dir);
    const out = path.join(dir, "trace.json");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await exportMain(["--db", dbPath, "--out", out])).toBe(1);
    expect(await exportMain(["--db", dbPath, "--session", "--out", out])).toBe(1);
    expect(
      await exportMain(["--db", dbPath, "--session", "sess_export", "--out", out, "--force", "yes"]),
    ).toBe(1);
    expect(error).toHaveBeenCalledWith(USAGE);
    expect(existsSync(out)).toBe(false);
  });

  it("returns 1 and writes nothing for an unknown session or a missing database", async () => {
    const dir = tempDir();
    const dbPath = seededDbPath(dir);
    const out = path.join(dir, "trace.json");
    const missingDb = path.join(dir, "missing.db");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await exportMain(["--db", dbPath, "--session", "sess_missing", "--out", out])).toBe(1);
    expect(await exportMain(["--db", missingDb, "--session", "sess_export", "--out", out])).toBe(1);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(missingDb)).toBe(false);
    const messages = error.mock.calls.map((call) => String(call[0])).join("\n");
    expect(messages).toContain("export: no session sess_missing");
    expect(messages).toContain(`export: cannot open ${missingDb}`);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter jevcode-desktop exec vitest run src/main/replay/cli-entry.test.ts`
Expected: FAIL. Three `replay export` tests fail with `TypeError: exportMain is not a function`; `replayMain dispatches the export subcommand` fails with `ENOENT: no such file or directory, open 'export/expected_units.json'` (today's `replayMain` treats `export` as a fixture directory and throws before writing anything). The `runReplay trace bundle` test passes.

- [ ] **Step 3: Add `exportMain` and the dispatch**

In `apps/desktop/src/main/replay/cli-entry.ts`, make three replacements.

Replace:

```ts
import type { JevcodeDb } from "@jevcode/storage";
```

with:

```ts
import type { JevcodeDb, TraceReader } from "@jevcode/storage";
```

Replace:

```ts
import { EvidenceFactSchema } from "@jevcode/contracts";

import {
  PlaybackClient,
```

with:

```ts
import { EvidenceFactSchema } from "@jevcode/contracts";

import { IpcError } from "../../shared/errors.js";
import {
  PlaybackClient,
```

Replace the start of `replayMain`:

```ts
export async function replayMain(argv: string[]): Promise<number> {
  const fixtureDir = argv[2];
  const outDir = argv[3];
  if (fixtureDir === undefined || outDir === undefined) {
    console.error("usage: jevcode-replay <fixtureDir> <outDir>");
    return 1;
  }
```

with:

```ts
export const EXPORT_USAGE =
  "usage: jevcode-replay export --db <path> --session <id> --out <file>";

interface ExportFlags {
  db: string;
  session: string;
  out: string;
}

/** Exactly --db, --session and --out, each once with a non-empty value; anything else is null. */
function parseExportFlags(args: readonly string[]): ExportFlags | null {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag !== "--db" && flag !== "--session" && flag !== "--out") return null;
    if (value === undefined || value.length === 0 || value.startsWith("--")) return null;
    values.set(flag.slice(2), value);
  }
  const db = values.get("db");
  const session = values.get("session");
  const out = values.get("out");
  if (db === undefined || session === undefined || out === undefined) return null;
  return { db: path.resolve(db), session, out: path.resolve(out) };
}

/**
 * `jevcode-replay export --db <path> --session <id> --out <file>`: writes one
 * stored session as a redacted trace.json (mode 0600). The database is opened
 * query_only and never created. Returns 0 on success, 1 on any failure; a
 * failure writes no file.
 */
export async function exportMain(args: readonly string[]): Promise<number> {
  const flags = parseExportFlags(args);
  if (flags === null) {
    console.error(EXPORT_USAGE);
    return 1;
  }
  let reader: TraceReader;
  try {
    reader = openTraceReader(flags.db);
  } catch (error) {
    console.error(
      `export: cannot open ${flags.db}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  try {
    const bundle = buildTraceBundle(createTraceService(reader), flags.session);
    writeTraceBundle(flags.out, bundle);
    console.log(
      JSON.stringify({
        out: flags.out,
        rows: bundle.rows.length,
        redactionCount: bundle.redactionCount,
      }),
    );
    return 0;
  } catch (error) {
    if (error instanceof IpcError && error.code === "UNKNOWN_SESSION") {
      console.error(`export: no session ${flags.session} in ${flags.db}`);
    } else {
      console.error(`export: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 1;
  } finally {
    reader.close();
  }
}

export async function replayMain(argv: string[]): Promise<number> {
  if (argv[2] === "export") {
    return exportMain(argv.slice(3));
  }
  const fixtureDir = argv[2];
  const outDir = argv[3];
  if (fixtureDir === undefined || outDir === undefined) {
    console.error("usage: jevcode-replay <fixtureDir> <outDir>");
    console.error(EXPORT_USAGE);
    return 1;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter jevcode-desktop exec vitest run src/main/replay/cli-entry.test.ts`
Expected: PASS, `Tests  5 passed (5)`

- [ ] **Step 5: Run the CLI end to end**

Run: `pnpm --filter jevcode-desktop build`
Expected: exit 0.

Run: `node apps/desktop/scripts/replay.mjs fixtures/oauth "${TMPDIR:-/tmp}/jevcode-a2-oauth"`
Expected: exit 0 with `"errors": []`.

Run: `node apps/desktop/scripts/replay.mjs export --db "${TMPDIR:-/tmp}/jevcode-a2-oauth/replay.db" --session sess-oauth-0001 --out "${TMPDIR:-/tmp}/jevcode-a2-export.json"`
Expected: exit 0 and one JSON line with `"out"` ending in `jevcode-a2-export.json`, a `"rows"` count greater than 0 and a `"redactionCount"`.

Run: `node apps/desktop/scripts/replay.mjs export --db "${TMPDIR:-/tmp}/jevcode-a2-oauth/replay.db" --session sess-missing --out "${TMPDIR:-/tmp}/jevcode-a2-missing.json"`
Expected: exit 1, stderr `export: no session sess-missing in …/replay.db`, and no `jevcode-a2-missing.json` file.

- [ ] **Step 6: Document the export in `docs/demo.md`**

In `docs/demo.md`, replace lines 33-35:

````markdown
Emits the UI specs to `/tmp/jevcode-replay/ui-specs/` and session state to
`semantic-state.json`. Replays every fixture with Jev in playback mode
(deterministic labeled outputs).
````

with:

````markdown
Emits the UI specs to `/tmp/jevcode-replay/ui-specs/` and session state to
`semantic-state.json`. Replays every fixture with Jev in playback mode
(deterministic labeled outputs). It also writes `/tmp/jevcode-replay/trace.json`,
a `jevcode.trace` v1 bundle of the session's trace rows for the trace viewer's
dev host.

## Trace export (viewer bundle)

Export any stored session, from the app database or a `replay.db`, to a
`trace.json` bundle. Run it from the repo root after a build:

```
pnpm build
sqlite3 ~/.jevcode/jevcode.db "SELECT id, startedAt, prompt FROM sessions ORDER BY startedAt DESC LIMIT 10"
node apps/desktop/scripts/replay.mjs export --db ~/.jevcode/jevcode.db --session <session id> --out /tmp/jevcode-trace.json
```

The export opens the database on a second, `query_only` connection and never
writes to it. Every string in the bundle passes the redactor, your home
directory becomes `~`, and the file is written with mode 0600. On success it
prints `{"out", "rows", "redactionCount"}` and exits 0; a missing flag, a
missing database or an unknown session exits 1 and writes nothing.
`pnpm --filter jevcode-desktop replay export …` also works, but pnpm runs the
script from `apps/desktop`, so pass absolute paths. Bundles stay on this
machine; sharing them is out of scope for v1.
````

- [ ] **Step 7: Add the viewer row to `docs/security.md`**

Insert this line directly after line 12 (the table row that starts with ``| 6 | `json-render` specs validated against a closed catalog before render |``), so it becomes the new last row of the table:

```markdown
| 7 | Trace viewer reads are read-only and bounded (trace viewer design spec, R5 and D9) | PASS | `apps/desktop/src/main/trace-ipc.ts` registers `trace:listSessions`, `trace:rows` and `trace:payloads` through the same `handle()` wrapper (sender check, then zod bounds from `src/shared/local-channels.ts`: `limit <= 500`, `limit <= 5000`, 1 to 50 `seqs`). The handlers receive only a `TraceService` over `openTraceReader` (`packages/storage/src/trace-reader.ts`), a second SQLite connection with `PRAGMA query_only = ON`, so they cannot reach the runtime, the instruction router, Jev or the network. Strings longer than 16 KiB are clipped to head and tail. `trace.json` bundles (`replay`, `replay export`) pass every payload string through `redactText`, map the home directory to `~` and are written with mode 0600 (`apps/desktop/src/main/trace-bundle.ts`). Covered by `packages/storage/src/trace-reader.test.ts` (writes throw), `apps/desktop/src/main/trace-ipc.test.ts` (a pending instruction stays pending; event count, `lastEventSeq` and the database files are unchanged), `trace-bundle.test.ts` and `replay/cli-entry.test.ts` | The viewer lists sessions from every repository by design. Bundles stay on this machine; sharing them is out of scope for v1 |
```

Run: `grep -c "^| 7 | Trace viewer reads" docs/security.md`
Expected: `1`

- [ ] **Step 8: Run the root checks**

Run, in order: `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r --no-bail --workspace-concurrency=1 test`, `pnpm lint`
Expected: each exits 0.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/main/replay/cli-entry.ts apps/desktop/src/main/replay/cli-entry.test.ts docs/demo.md docs/security.md
git commit -m "feat(desktop): add replay export subcommand"
```

---

### Task A2-7: soak trace profile, kept database and the M2 read budgets; perf record

**Files:**
- Modify: `scripts/soak.mjs:1`, `:6-11`, `:16`, `:21`, `:25-27`, `:71-72`, `:102-103`, `:143-171`, `:190-199`, `:441`, `:470-471`, `:477-479`
- Modify: `docs/perf.md:75-82`

**Interfaces:**
- Consumes (built JavaScript, so run `pnpm build` first):
  - `../packages/storage/dist/index.js`: `openTraceReader(dbPath)`.
  - `../packages/contracts/dist/index.js`: `TRACE_ROWS_PAGE_DEFAULT = 2_000` (W0-5). W0-4's optional `callId` on the `command_started`, `command_completed` and `file_changed` agent events and `sourceCallId` on `test_result` facts; storage stores the zod-parsed payload, so without W0-4 the ids are stripped.
  - `../apps/desktop/dist/main/trace-service.js`: `createTraceService(reader)`, `readAllRows(service, sessionId, pageSize = 5000)`.
  - `../apps/desktop/dist/main/trace-bundle.js`: `buildTraceBundle(service, sessionId)`, `writeTraceBundle(filePath, bundle)`.
  - Existing soak state: `db` (a `JevcodeDb` with `dbPath`), `SESSION_ID = "sess-soak-0001"`, `runtime.stopSession`, `assert(condition, message)` (prints `SOAK_FAIL: <message>` and exits 1), `percentile(values, p)`, the final `console.log(JSON.stringify({ … }, null, 2))`.
- Produces (spec §5.6 and §10; lane 06 C2-16 Step 4 and lane 08 D-8 Step 1 consume them):
  - `JEVCODE_SOAK_PROFILE`: unset, empty or `default` keeps today's stream (the 2,000-record run still prints `"records": 1987`). `trace` generates the spec §10 reference input from a seeded PRNG (mulberry32, seed `0x50a4`), so every run writes the same records: `command_completed.stdout` of 0.2, 2, 8, 32 or 64 KiB; assistant progress notes of 205 to 4,096 characters; a `callId` (`soak-turn-<turn>:item_<n>`) shared by each `command_started`/`command_completed` pair and cited as `sourceCallId` by the pair's `test_result`; an agent `file_changed` claim with its own `callId` before each feature hunk; and every 500 records a steer (an `agent_started` whose prompt is the steer text, then the same text as a user `agent_message`). Soak agent events carry no `turnId`, so the fold reads each relaunch as a steer (spec §6.6 "Turns"). Any other value prints `SOAK_FAIL: unknown JEVCODE_SOAK_PROFILE <value> (expected default or trace)` and exits 1 before any work.
  - `JEVCODE_SOAK_KEEP_DB=<path>`: after the trace reader and the database close (the last close checkpoints the WAL into `soak.db`), removes `<path>-wal` and `<path>-shm`, copies `soak.db` to `<path>` with mode 0600 (about 630 MB after the full trace-profile soak), prints `soak: kept the database at <absolute path>`, then the `rmSync` runs.
  - `JEVCODE_SOAK_EXPORT=<file>`: after `stopSession`, a redacted bundle at that path and the line `soak: wrote <n> trace rows to <absolute path>`.
  - Printed JSON fields, after `jevDecisions`: `profile`; `traceReadMs` (median of 5 full-session reads in pages of 5,000 after 1 discarded warm-up) and `traceReadRunsMs` (those 5, in ms); `traceRows` and `consumedRows` (the trace-type rows one full read returns; the same number under the base index's and the spec's names); `storedRows` (the session's `lastSeq` at the read, which counts every stored row because seq is gapless); `tracePageMs: { p50, p95, max, samples, pageSize }` (single `trace:rows` calls at `TRACE_ROWS_PAGE_DEFAULT`, `samples` ≥ 300).
  - Warnings on stderr, never failures: `soak: WARN trace read <ms> ms exceeds the 1500 ms budget` and `soak: WARN trace:rows p95 <ms> ms exceeds the 50 ms budget`.

- [ ] **Step 1: Confirm the soak has none of this yet**

Run: `pnpm build`
Expected: exit 0.

Run: `grep -cE "JEVCODE_SOAK_PROFILE|JEVCODE_SOAK_KEEP_DB|traceReadMs" scripts/soak.mjs`
Expected: `0`

Run: `JEVCODE_SOAK_EVENTS=2000 node scripts/soak.mjs | grep -E '"(records|traceReadMs)"'`
Expected: exactly one line, `  "records": 1987,` (the 2,000-record soak takes about 10 seconds). The default profile must keep this count after Step 2.

- [ ] **Step 2: Add the profile, the budgets, the export and the kept database to `scripts/soak.mjs`**

In `scripts/soak.mjs`, make twelve replacements. Find each by its quoted text, which occurs exactly once.

Replace line 1:

```js
import { mkdtempSync, rmSync } from "node:fs";
```

with:

```js
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
```

Replace lines 6-11:

```js
import { openDb } from "../packages/storage/dist/index.js";
import {
  EvidenceFactSchema,
  NormalizedAgentEventSchema,
  DecisionSchema,
} from "../packages/contracts/dist/index.js";
```

with:

```js
import { openDb, openTraceReader } from "../packages/storage/dist/index.js";
import {
  EvidenceFactSchema,
  NormalizedAgentEventSchema,
  DecisionSchema,
  TRACE_ROWS_PAGE_DEFAULT,
} from "../packages/contracts/dist/index.js";
```

Replace line 16:

```js
import { PipelineRuntime } from "../apps/desktop/dist/main/pipeline/pipeline-runtime.js";
```

with:

```js
import { PipelineRuntime } from "../apps/desktop/dist/main/pipeline/pipeline-runtime.js";
import { buildTraceBundle, writeTraceBundle } from "../apps/desktop/dist/main/trace-bundle.js";
import { createTraceService, readAllRows } from "../apps/desktop/dist/main/trace-service.js";
```

Replace line 21:

```js
const TARGET_EVENTS = Number(process.env["JEVCODE_SOAK_EVENTS"] ?? 10_000);
```

with:

```js
const TARGET_EVENTS = Number(process.env["JEVCODE_SOAK_EVENTS"] ?? 10_000);
// JEVCODE_SOAK_PROFILE=trace is the trace viewer's reference input (spec §5.6,
// §10): agent rows with realistic payload sizes, callId pairs, agent
// file_changed claims and steers. "default" keeps the 2026-09-19 stream.
const PROFILE = process.env["JEVCODE_SOAK_PROFILE"] || "default";
if (PROFILE !== "default" && PROFILE !== "trace") {
  console.error(`SOAK_FAIL: unknown JEVCODE_SOAK_PROFILE ${PROFILE} (expected default or trace)`);
  process.exit(1);
}
const TRACE_STDOUT_KIB = [0.2, 2, 8, 32, 64];
const TRACE_TEXT_MIN = Math.round(0.2 * 1024);
const TRACE_TEXT_MAX = 4 * 1024;
const TRACE_STEER_EVERY = 500;
// Trace viewer budgets (spec §10, R26). A single-run budget reports the median
// of 5 runs after 1 discarded warm-up; a p95 budget uses at least 300 samples.
const TRACE_READ_BUDGET_MS = 1_500;
const TRACE_PAGE_BUDGET_MS = 50;
const TRACE_READ_RUNS = 5;
const TRACE_PAGE_SAMPLES = 300;
```

Replace lines 25-27:

```js
function nowIso(offsetMs) {
  return new Date(Date.UTC(2026, 8, 19, 9, 0, 0) + offsetMs).toISOString();
}
```

with:

```js
function nowIso(offsetMs) {
  return new Date(Date.UTC(2026, 8, 19, 9, 0, 0) + offsetMs).toISOString();
}

/** mulberry32: a seeded PRNG, so every trace-profile run generates the same records. */
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = state;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** ASCII text of exactly `length` characters, built from numbered copies of `line`. */
function fillerText(length, line) {
  const parts = [];
  let size = 0;
  for (let i = 1; size < length; i += 1) {
    const next = `${line} ${i}\n`;
    parts.push(next);
    size += next.length;
  }
  return parts.join("").slice(0, length);
}
```

Replace lines 71-72:

```js
  let burst = 0;
  while (records.length < TARGET_EVENTS - 40) {
```

with:

```js
  let burst = 0;
  // Trace-profile state. Soak agent events carry no turnId, like a pre-M1a
  // recording, so the fold reads each relaunch below as a steer (spec §6.6
  // "Turns"); callIds keep the `${turnId}:${item.id}` shape.
  const traceProfile = PROFILE === "trace";
  const random = seededRandom(0x50a4);
  let turn = 1;
  let item = 0;
  let nextSteerAt = TRACE_STEER_EVERY;
  const nextCallId = () => `soak-turn-${turn}:item_${(item += 1)}`;
  while (records.length < TARGET_EVENTS - 40) {
```

Replace lines 102-103:

```js
      const file = `src/feature-${feature}.ts`;
      push({
```

with:

```js
      const file = `src/feature-${feature}.ts`;
      if (traceProfile) {
        // The agent's claim; the git_hunk, symbol_delta and file_changed
        // facts below are the repo's observation of the same edit.
        push({
          type: "file_changed",
          sessionId: SESSION_ID,
          callId: nextCallId(),
          path: file,
          ts: nowIso((t += 100)),
        });
      }
      push({
```

Replace lines 143-171 (the test command block):

```js
    if (burst % 8 === 0) {
      push({
        type: "command_started",
        sessionId: SESSION_ID,
        command: `pnpm test ${burst}`,
        ts: nowIso((t += 100)),
      });
      push({
        type: "test_result",
        repoId: REPO_ID,
        sessionId: SESSION_ID,
        runner: "vitest",
        command: `pnpm test ${burst}`,
        passed: 42,
        failed: 0,
        skipped: 0,
        failures: [],
        ts: nowIso((t += 100)),
      });
      push({
        type: "command_completed",
        sessionId: SESSION_ID,
        command: `pnpm test ${burst}`,
        exitCode: 0,
        stdout: "",
        stderr: "",
        ts: nowIso((t += 100)),
      });
    }
```

with:

```js
    if (burst % 8 === 0) {
      // Trace profile: one callId pairs the start and the completion, the
      // test_result cites it as sourceCallId (R2), and stdout is 0.2-64 KiB.
      const callId = traceProfile ? nextCallId() : undefined;
      const call = callId === undefined ? {} : { callId };
      push({
        type: "command_started",
        sessionId: SESSION_ID,
        ...call,
        command: `pnpm test ${burst}`,
        ts: nowIso((t += 100)),
      });
      push({
        type: "test_result",
        repoId: REPO_ID,
        sessionId: SESSION_ID,
        ...(callId === undefined ? {} : { sourceCallId: callId }),
        runner: "vitest",
        command: `pnpm test ${burst}`,
        passed: 42,
        failed: 0,
        skipped: 0,
        failures: [],
        ts: nowIso((t += 100)),
      });
      const stdoutKib = traceProfile
        ? TRACE_STDOUT_KIB[Math.floor(random() * TRACE_STDOUT_KIB.length)]
        : 0;
      push({
        type: "command_completed",
        sessionId: SESSION_ID,
        ...call,
        command: `pnpm test ${burst}`,
        exitCode: 0,
        stdout: fillerText(Math.round(stdoutKib * 1024), `PASS src/feature-${feature}.test.ts > case`),
        stderr: "",
        ts: nowIso((t += 100)),
      });
    }
```

The default profile spreads empty objects and `fillerText(0, …)` returns `""`, so its records keep today's keys, key order and values.

Replace lines 190-199 (the progress note and the end of the loop):

```js
    if (burst % 10 === 0) {
      push({
        type: "agent_message",
        sessionId: SESSION_ID,
        role: "assistant",
        text: `Progress note ${burst}.`,
        ts: nowIso((t += 100)),
      });
    }
  }
```

with:

```js
    if (burst % 10 === 0) {
      const note = `Progress note ${burst}.`;
      push({
        type: "agent_message",
        sessionId: SESSION_ID,
        role: "assistant",
        text: traceProfile
          ? fillerText(TRACE_TEXT_MIN + Math.floor(random() * (TRACE_TEXT_MAX - TRACE_TEXT_MIN + 1)), note)
          : note,
        ts: nowIso((t += 100)),
      });
    }

    if (traceProfile && records.length >= nextSteerAt) {
      // A steer relaunches the agent: the relaunch's agent_started carries the
      // steer as its prompt, then the supervisor's message repeats it (spec
      // §6.6 "Instruction dedupe").
      nextSteerAt += TRACE_STEER_EVERY;
      const steer = `Steer ${turn}: keep feature files small and rerun the tests.`;
      turn += 1;
      push({ type: "agent_started", sessionId: SESSION_ID, prompt: steer, ts: nowIso((t += 100)) });
      push({
        type: "agent_message",
        sessionId: SESSION_ID,
        role: "user",
        text: steer,
        ts: nowIso((t += 100)),
      });
    }
  }
```

Replace line 441:

```js
  const skeletonAvgMs = (Date.now() - skeletonStarted) / 1000;
```

with:

```js
  const skeletonAvgMs = (Date.now() - skeletonStarted) / 1000;

  // Trace viewer budgets through the viewer's own read path: a second,
  // query_only connection, factId + clipping. Full reads page by
  // TRACE_ROWS_PAGE_MAX (readAllRows' default); the first read is a discarded
  // warm-up and traceReadMs is the median of the next five. Then single
  // trace:rows calls are timed at TRACE_ROWS_PAGE_DEFAULT, the page size the
  // viewer requests, over repeated full reads until 300 calls are timed.
  const traceReader = openTraceReader(db.dbPath);
  const traceService = createTraceService(traceReader);
  let trace = readAllRows(traceService, SESSION_ID);
  const traceReadRunsMs = [];
  for (let run = 0; run < TRACE_READ_RUNS; run += 1) {
    const started = performance.now();
    trace = readAllRows(traceService, SESSION_ID);
    traceReadRunsMs.push(Math.round(performance.now() - started));
  }
  const traceReadMs = percentile(traceReadRunsMs, 50);
  const tracePageMs = [];
  const timedTraceService = {
    ...traceService,
    rows(request) {
      const started = performance.now();
      const page = traceService.rows(request);
      tracePageMs.push(performance.now() - started);
      return page;
    },
  };
  while (tracePageMs.length < TRACE_PAGE_SAMPLES) {
    readAllRows(timedTraceService, SESSION_ID, TRACE_ROWS_PAGE_DEFAULT);
  }
  const tracePageP95Ms = Number(percentile(tracePageMs, 95).toFixed(1));
  if (traceReadMs > TRACE_READ_BUDGET_MS) {
    console.warn(
      `soak: WARN trace read ${traceReadMs} ms exceeds the ${TRACE_READ_BUDGET_MS} ms budget`,
    );
  }
  if (tracePageP95Ms > TRACE_PAGE_BUDGET_MS) {
    console.warn(
      `soak: WARN trace:rows p95 ${tracePageP95Ms} ms exceeds the ${TRACE_PAGE_BUDGET_MS} ms budget`,
    );
  }
```

Replace lines 470-471 (inside the printed JSON object):

```js
        jevDecisions: db.listJevDecisions(SESSION_ID).length,
      },
```

with:

```js
        jevDecisions: db.listJevDecisions(SESSION_ID).length,
        profile: PROFILE,
        traceReadMs,
        traceReadRunsMs,
        traceRows: trace.rows.length,
        storedRows: trace.lastSeq,
        consumedRows: trace.rows.length,
        tracePageMs: {
          p50: Number(percentile(tracePageMs, 50).toFixed(1)),
          p95: tracePageP95Ms,
          max: Number(Math.max(...tracePageMs).toFixed(1)),
          samples: tracePageMs.length,
          pageSize: TRACE_ROWS_PAGE_DEFAULT,
        },
      },
```

Replace lines 477-479:

```js
  await runtime.stopSession(SESSION_ID);
  db.close();
  rmSync(outDir, { recursive: true, force: true });
```

with:

```js
  await runtime.stopSession(SESSION_ID);
  // Export after stopSession so the bundle carries the terminal session state.
  const exportPath = process.env["JEVCODE_SOAK_EXPORT"];
  if (exportPath !== undefined && exportPath.length > 0) {
    const bundle = buildTraceBundle(traceService, SESSION_ID);
    writeTraceBundle(path.resolve(exportPath), bundle);
    console.log(`soak: wrote ${bundle.rows.length} trace rows to ${path.resolve(exportPath)}`);
  }
  traceReader.close();
  const dbPath = db.dbPath;
  db.close();
  // JEVCODE_SOAK_KEEP_DB (spec §5.6): copy the database before the rmSync.
  // Closing the last connection checkpoints the WAL into soak.db, so that one
  // file holds every row; stale -wal/-shm files beside the target would be
  // replayed over the copy, so they are removed first.
  const keepPath = process.env["JEVCODE_SOAK_KEEP_DB"];
  if (keepPath !== undefined && keepPath.length > 0) {
    assert(!existsSync(`${dbPath}-wal`), `${dbPath}-wal outlived the close; a copy would miss rows`);
    const target = path.resolve(keepPath);
    mkdirSync(path.dirname(target), { recursive: true });
    rmSync(`${target}-wal`, { force: true });
    rmSync(`${target}-shm`, { force: true });
    copyFileSync(dbPath, target);
    chmodSync(target, 0o600);
    console.log(`soak: kept the database at ${target}`);
  }
  rmSync(outDir, { recursive: true, force: true });
```

Run: `node --check scripts/soak.mjs`
Expected: exit 0, no output.

- [ ] **Step 3: Check both profiles, the kept database and the export on quick soaks**

Each 2,000-record run takes about 12 seconds. Run each block as one shell command.

The default profile is unchanged and prints the new fields:

Run: `JEVCODE_SOAK_EVENTS=2000 node scripts/soak.mjs | grep -E '"(records|profile|traceReadMs|traceRows|storedRows|consumedRows|samples|pageSize)"'`
Expected: eight lines in this order: `"records": 1987,` (the Step 1 count), `"profile": "default",`, `"traceReadMs": <n>,`, `"traceRows": <n>,`, `"storedRows": <n>,`, `"consumedRows": <n>,`, `"samples": <n>,` and `"pageSize": 2000`. `traceRows` equals `consumedRows` and is greater than 0, `storedRows` is greater than `traceRows`, and `samples` is 300 or more.

An unknown profile stops before any work:

Run: `JEVCODE_SOAK_PROFILE=bogus node scripts/soak.mjs; echo "exit $?"`
Expected: `SOAK_FAIL: unknown JEVCODE_SOAK_PROFILE bogus (expected default or trace)`, then `exit 1`.

The trace profile with the kept database and the export:

```bash
KEEP="${TMPDIR:-/tmp}/jevcode-soak-quick.db"
rm -f "${KEEP}" "${KEEP}-wal" "${KEEP}-shm"
JEVCODE_SOAK_EVENTS=2000 JEVCODE_SOAK_PROFILE=trace JEVCODE_SOAK_KEEP_DB="${KEEP}" JEVCODE_SOAK_EXPORT="${TMPDIR:-/tmp}/jevcode-soak-trace.json" node scripts/soak.mjs | grep -E '^soak: |"(records|profile|traceRows|consumedRows)"'
```

Expected, in this order: `soak: 2007 generated records`, `  "records": 2007,`, `  "profile": "trace",`, `  "traceRows": <n>,`, `  "consumedRows": <n>,`, `soak: wrote <n> trace rows to …/jevcode-soak-trace.json` and `soak: kept the database at …/jevcode-soak-quick.db`, with the same `<n>` on the three lines that carry it. (The record count is 2007, not 1987, because the profile adds claims and steers inside the same loop.)

Run: `node --input-type=module -e 'import { readFileSync, statSync } from "node:fs"; import { TraceBundleSchema } from "./packages/contracts/dist/index.js"; const file = process.argv[1]; const bundle = TraceBundleSchema.parse(JSON.parse(readFileSync(file, "utf8"))); console.log(bundle.rows.length, bundle.session.state, (statSync(file).mode & 0o777).toString(8));' "${TMPDIR:-/tmp}/jevcode-soak-trace.json"`
Expected: `<n> completed 600`

Read the kept database through the viewer's own path, as D-8 will (the exact-id lookup is A2-1's):

```bash
node --input-type=module -e '
import { statSync } from "node:fs";
import { openTraceReader } from "./packages/storage/dist/index.js";
import { createTraceService, readAllRows } from "./apps/desktop/dist/main/trace-service.js";
const file = process.argv[1];
const reader = openTraceReader(file);
const service = createTraceService(reader);
const [session] = service.listSessions({ sessionId: "sess-soak-0001", limit: 1 });
const { rows } = readAllRows(service, "sess-soak-0001");
const events = rows.filter((row) => row.type === "agent_event").map((row) => row.payload);
const of = (type) => events.filter((event) => event.type === type);
const starts = new Set(of("command_started").map((event) => event.callId));
const completed = of("command_completed");
console.log(JSON.stringify({
  mode: (statSync(file).mode & 0o777).toString(8),
  state: session.state,
  agentStarted: of("agent_started").length,
  steers: of("agent_message").filter((event) => event.role === "user").length,
  claims: of("file_changed").length,
  commands: completed.length,
  paired: completed.filter((event) => typeof event.callId === "string" && starts.has(event.callId)).length,
  clipped: completed.filter((event) => event.stdout.includes("characters clipped")).length,
  cited: rows.filter((row) => row.type === "evidence_fact" && typeof row.payload.sourceCallId === "string").length,
}));
reader.close();
' "${TMPDIR:-/tmp}/jevcode-soak-quick.db"
```

Expected: `{"mode":"600","state":"completed","agentStarted":5,"steers":4,"claims":12,"commands":6,"paired":6,"clipped":4,"cited":6}`. The seeded stream fixes every count: the initial start plus 4 steers, 12 feature claims, 6 paired test commands whose `test_result` cites the `callId`, and 4 of the 6 stdouts drawn at 32 or 64 KiB, so the service clips them. `paired: 0` or `cited: 0` means the build lacks W0-4's `callId`/`sourceCallId` fields (storage strips undeclared keys): run `pnpm -r build` and repeat Step 3. The check leaves only `jevcode-soak-quick.db`: `query_only` blocks SQL writes but not the checkpoint on close, so the reader's `-wal` and `-shm` are gone when it exits (the `rm -f` above still clears any left by an interrupted run).

- [ ] **Step 4: Run the full soak on the trace profile**

The spec §10 reference input is the trace profile, so the M2 budgets are measured on it. The full soak takes about 11 minutes, longer than a 10-minute tool timeout: on 2026-09-28 the default profile took 642 s (454,917 stored events for 9,993 records), and a prototype of this task's code on the trace profile took 660 s (452,364 stored events for 10,013 records). Start it as a background command and wait for it to exit.

Run (in the background): `JEVCODE_SOAK_PROFILE=trace node scripts/soak.mjs > "${TMPDIR:-/tmp}/jevcode-soak-full.out" 2>&1`
Expected: exit 0.

Run: `node -e 'const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n"); const soak = JSON.parse(lines.slice(lines.indexOf("{"), lines.indexOf("}") + 1).join("\n")); const { profile, records, totalMs, eventStoreCount, traceReadMs, traceReadRunsMs, traceRows, storedRows, consumedRows, tracePageMs } = soak; console.log(JSON.stringify({ profile, records, totalMs, eventStoreCount, traceReadMs, traceReadRunsMs, traceRows, storedRows, consumedRows, tracePageMs }));' "${TMPDIR:-/tmp}/jevcode-soak-full.out"`
Expected: one JSON line with `"profile":"trace"`, `"records":10013` and the other eight fields; `traceRows` equals `consumedRows`, `storedRows` equals `eventStoreCount`, and `tracePageMs.samples` is 300 or more.

Run: `grep -c "soak: WARN" "${TMPDIR:-/tmp}/jevcode-soak-full.out"`
Expected: `0` when both budgets pass. `1` or `2` means a budget was missed; read the lines with `grep "soak: WARN" "${TMPDIR:-/tmp}/jevcode-soak-full.out"`. For scale, that prototype read 110,959 trace rows with a median of 733 ms (runs of 620 to 1,014 ms) and timed `trace:rows` at a p95 of 17.8 ms over 336 calls (max 185.8 ms), so both budgets are expected to pass. A WARN line is a finding to report, not a failure.

- [ ] **Step 5: Record the measurement in `docs/perf.md`**

In `docs/perf.md`, replace lines 75-82:

````markdown
## How to reproduce

```
pnpm build
node scripts/perf.mjs    # fixture replays: persist latency, first-surface latency, compile times
node scripts/soak.mjs    # 10k-event soak with SurfaceManager invariants
JEVCODE_SOAK_EVENTS=2000 node scripts/soak.mjs  # smaller soak for quick checks
```
````

with the block below. Replace every `{field}` with a value from Step 4's JSON line: `{date}` is today's date (`YYYY-MM-DD`); `{traceReadMs}`, `{consumedRows}`, `{storedRows}`, `{eventStoreCount}`, `{records}` and `{totalMs}` are the printed numbers with thousands separators; `{traceReadRunsMs}` is the five run times joined with `, `; `{p50}`, `{p95}`, `{max}` and `{samples}` come from `tracePageMs`; `{readStatus}` is `PASS` when `traceReadMs` is 1500 or less and `MISS` otherwise; `{pageStatus}` is `PASS` when `tracePageMs.p95` is 50 or less and `MISS` otherwise.

````markdown
## Trace read (trace viewer, spec §10 M2 budgets)

Measured {date} with `JEVCODE_SOAK_PROFILE=trace node scripts/soak.mjs`, the
full soak on the spec §10 reference input: command stdout of 0.2 to 64 KiB,
assistant notes of 0.2 to 4 KiB, `callId` pairs, agent `file_changed` claims
and a steer every 500 records. Before it stops the session, the soak reads the
whole session through the viewer's own path: a second `query_only` connection
(`openTraceReader`), `createTraceService` (fact ids and 16 KiB clipping) and
`readAllRows`. Only the six `TRACE_ROW_TYPES` are read; graph, telemetry,
snapshot and failure rows are skipped. The full read runs 6 times in pages of
5,000 rows; the first is a discarded warm-up and the budget uses the median of
the other 5. The `trace:rows` budget times single calls at the viewer's page
size of 2,000 rows over repeated full reads.

| Budget | Target | Measured | Status |
|---|---|---|---|
| Full soak-session trace read in main | ≤1.5s | {traceReadMs} ms, median of 5 ({traceReadRunsMs} ms), for {consumedRows} trace rows of {storedRows} stored | {readStatus} |
| `trace:rows` call in main (trace profile) | p95 ≤50ms | {p95} ms p95 over {samples} calls (p50 {p50} ms, max {max} ms) | {pageStatus} |

This soak stored {eventStoreCount} events for {records} records in {totalMs} ms;
the 2026-09-19 soak above stored 75,181.

## How to reproduce

```
pnpm build
node scripts/perf.mjs    # fixture replays: persist latency, first-surface latency, compile times
node scripts/soak.mjs    # 10k-event soak with SurfaceManager invariants and the trace read budgets
JEVCODE_SOAK_EVENTS=2000 node scripts/soak.mjs  # smaller soak for quick checks
JEVCODE_SOAK_PROFILE=trace node scripts/soak.mjs  # the trace viewer's reference input (spec §10)
JEVCODE_SOAK_EXPORT=/tmp/jevcode-soak-trace.json node scripts/soak.mjs  # also writes a trace.json bundle
JEVCODE_SOAK_KEEP_DB=/tmp/jevcode-soak-trace.db node scripts/soak.mjs  # also keeps the database (mode 0600)
```

The full soak takes about 11 minutes; run it in the background.
````

Run: `grep -c '[{}]' docs/perf.md`
Expected: `0` (every field was filled; `docs/perf.md` had no braces before this task).

- [ ] **Step 6: Run the root checks**

Run, in order: `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r --no-bail --workspace-concurrency=1 test`, `pnpm lint`
Expected: each exits 0. (`scripts/**` is outside the ESLint file set.)

- [ ] **Step 7: Commit**

```bash
git add scripts/soak.mjs docs/perf.md
git commit -m "perf(scripts): add the trace soak profile, kept database and M2 read budgets"
```

If Step 4 printed a WARN line, say so in the task report with the measured numbers; the budget decision belongs to the spec owner.

---

## Lane exit

Run these after A2-7, before the merge (index §4: A2 merges after A1).

- [ ] **Rebase onto `main` after A1 merges**

Run: `git rebase main`
Expected: no conflicts (the worktree shares refs with the main checkout, so `main` already includes the A1 merge). A1 and A2 edit disjoint files (index §4). If a conflict appears, resolve it by keeping both sides' changes, never by dropping A1's.

Run: `pnpm install --frozen-lockfile`, then `pnpm -r build`
Expected: each exits 0.

- [ ] **Rerun the lane suites and the root checks**

Run: `pnpm --filter @jevcode/storage exec vitest run src/trace-reader.test.ts`
Run: `pnpm --filter jevcode-desktop exec vitest run src/main/trace-service.test.ts src/main/trace-ipc.test.ts src/shared/ipc-registry.test.ts src/shared/api.test.ts src/main/trace-bundle.test.ts src/main/replay/cli-entry.test.ts`
Expected: all pass. After A1-5, `factContentId` hashes `canonicalJson`, and the replay fact-id assertion still holds because both sides call the same function. After A1-9 the fixtures gain lines and fields; A2's tests select rows by content, so a failure here is a bug in the A2 test, not a reason to edit fixtures.

Run, in order: `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r --no-bail --workspace-concurrency=1 test`, `pnpm lint`
Expected: each exits 0.

- [ ] **Electron boot smoke with the reader wired in**

This needs the Electron ABI, then the Node ABI back for tests. It uses a throwaway database so it never opens `~/.jevcode`.

Run: `pnpm --filter jevcode-desktop rebuild`
Expected: last line `native modules rebuilt for Electron ABI`.

Run: `JEVCODE_SMOKE=1 JEVCODE_DB="${TMPDIR:-/tmp}/jevcode-a2-smoke.db" pnpm --filter jevcode-desktop start`
Expected: prints `SMOKE_OK` and exits 0.

Run: `pnpm --filter jevcode-desktop rebuild:node`
Expected: last line `native modules restored to node ABI`.

If the Electron rebuild cannot run on this machine (it needs Electron headers), report that in the merge note with the error text; the typecheck and the `dist/main/index.js` grep in A2-3 Step 9 remain the evidence for the wiring.
