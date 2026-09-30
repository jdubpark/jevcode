# Jevcode trace viewer: design spec

**Status.** Approved design, 2026-09-28. This document is the single source of truth for the trace viewer. Decisions D1–D12 and R1–R29 (§2) are binding; where an earlier draft disagreed with them, this spec follows the decisions. Code anchors are `path:line` at commit 144c7fb. On 2026-09-28 the spec was aligned with the final implementation plans (`docs/superpowers/plans/2026-09-28-trace-viewer-*.md`); §16 "Plan follow-ups" lists the plan tasks that must still change to match it, and §17 records the alignment.

**Mockups.** `docs/superpowers/specs/2026-09-28-trace-viewer-mockups/`: `hybrid.html` and `canvas.html`, rendered at 1440 px (`hybrid-1440.png`, `canvas-1440.png`) and 1000 px (`hybrid-1000.png`, `canvas-1000.png`). §7.2 lists every place the build deviates from them.

## 1. Summary

The trace viewer turns one jevcode session's event log into a review a supervisor can read: what the agent was asked, what it planned and decided, what it changed and ran, what failed, and whether its claims match the repository's evidence. It is one package, `packages/trace-viewer`, with a React-free model and a React UI, hosted by a Vite dev host on exported `trace.json` bundles and by a separate Electron trace window over three read-only `trace:*` IPC channels. Two views share one shell, one store and one time scale: Hybrid, a time × lane overview above a virtualized reading spine, and Canvas, chapters as frames in time order joined by causal edges; selection, playhead and brush survive a switch between them. Capture is fixed at the source first, so step pairing and unit-to-evidence joins are exact for new sessions and visibly approximate for sessions recorded before M1. The viewer follows a running session by polling, never writes to the store, and makes no network or Jev call.

**Reader (D1).** A supervisor reviewing what the agent did: intent, decisions, edits, tests, risky moments, and claim versus evidence. Pipeline debugging stays in DebugPanel. The Raw tab is the escape hatch and is never the default (docs/SPEC.md:523).

**Success criteria.**

| Criterion | Target | Checked by |
|---|---|---|
| The product review gate (the "M0 UI prototype" gate, docs/IMPLEMENTATION-PLAN.md:153): does the supervisor understand the task faster than from the raw transcript? | Pooled over all participants and sessions, the median time to a correct answer per question is lower with the viewer than with the raw `events.jsonl` plus DebugPanel, and the viewer condition has no more wrong answers in total | Moderated session at the M4a exit with at least 2 participants who did not build the viewer. Each participant reads each of oauth, api-break and one soak-derived session in exactly one condition; conditions alternate between participants, so every session is read in both. Questions: what was asked; what changed; did verification pass; what was risky; does the final claim match the evidence. An answer is correct when it matches an answer key written before the session. Per-question times, answers and the verdict are recorded in the M4a PR |
| The oauth contradiction is found at once | Visible and selected within 5 s of opening, with no input | The initial selection is the first finding under `FINDING_ORDER` (§6.7, §7.8): "Claim contradicts tests" at +0:43, expanded in the spine and pinned in the overview. The Shell calls `markNextFrame("tv:initial-selection-painted")` (C2-3) right after the `session/applied` dispatch that moves the selection from `null` to the open default, so the mark lands in the first rAF after the commit that applies the initial selection; a session that opens in Live gets no initial selection and no mark. smoke.mjs opens oauth in Hybrid at 1440 × 900 with the dev host's `?selftest=open` probe (C2-15, §11) and no input, and asserts: the selection equals the oauth claim step's id (`step:<claim row seq>`); the claim row lies inside the spine viewport and its pin inside the overview lanes; the mark's `startTime` is ≤ 5000. Under `--virtual-time-budget` that time is virtual, so the 5 s check indicates wall time rather than proving it. `shell.test.tsx` (jsdom) checks one mark after the first frame and none for a Live open. The moderated session does not time it |
| Honest labels | No step reads "failed" because of exit −1, an interrupt or an unpaired start | Fold and signal tests (§11) |
| Detection on fixtures | `claim_contradicted` fires on oauth (lines 46/48) and api-break (lines 14/17); every fixture's findings equal its hand-written expectation table | `fold.fixtures.test.ts` |
| Read-only | Every `trace:*` call leaves the `events` count, `lastEventSeq` and the instruction inbox unchanged | `trace-ipc.test.ts` |
| Performance | All budgets in §10 | §10 |

Line numbers into `fixtures/*/events.jsonl` in this spec refer to the files before M1b. M1b inserts lines, so tests locate rows by content, not by line number.

## 2. Decisions

| ID | Decision | Rationale | § |
|---|---|---|---|
| D1 | The primary reader is a supervisor reviewing the agent; Raw is never the default | Tests the product thesis (docs/SPEC.md:11-13, :523) | 1, 7.1 |
| D2 | v1 opens jevcode sessions only (SQLite store, replay.db, fixture bundles); `TraceRow` stays source-agnostic | Only jevcode sessions carry units, Jev and evidence | 5, 15 |
| D3 | Post-hoc review first; the same UI follows a live session | Seek is a fold to seq N; live reuses it | 7.10 |
| D4 | One shared package, two hosts: Vite dev host on bundles, Electron window | The renderer cannot run in a browser today | 3.2 |
| D5 | Fix provenance in the contracts, not with viewer heuristics | 0 of 64 cited fact ids match stored rows today | 4 |
| D6 | Persist redacted, size-capped unified-diff text | Diffs are the evidence a reader wants; the working tree moves on | 4.3 |
| D7 | Ship both views, Canvas and Hybrid, with a switch | Approved mockups | 7.2 |
| D8 | Light mode first; color encodes state only; one icon family; mini graphics replace prose | Figma-grade reading surface | 7.12 |
| D9 | Separate Electron `BrowserWindow` (`trace.html`); order M0, M1, M2, M3, M4a, M4b, M5; approval of §1 is the plan-owner sign-off for risk R8 in docs/IMPLEMENTATION-PLAN.md:180; "Request changes" focuses the main composer | No CSS migration; side-by-side live reading; the viewer never writes | 8, 12 |
| D10 | Interrupt, steer and stop leave the session paused and resumable; `agent_interrupted {reason}` replaces the exit-time `agent_failed` | An interrupt is not a failure | 4.2 |
| D11 | Sessions recorded before M1 get approximate unit↔evidence joins with a header notice; no legacy-id resolver | Only old live sessions are affected | 6.9 |
| D12 | Every recommendation R1–R29 is accepted | User sign-off | all |
| R1 | M0: `openDb` creates `~/.jevcode` 0700 and the DB, `-wal`, `-shm` files 0600, with a POSIX-mode test | The DB holds prompts and stdout at mode 0644 today (db.ts:1523-1527) | 4.1 |
| R2 | M1a: optional `turnId`, `callId`, `agent_reasoning`, `agent_interrupted`, `sourceCallId`; persist the resume-budget failure; exit −1 renders "unknown" | Exact pairing and honest lifecycle | 4.2 |
| R3 | M1b: canonical fact ids, `agentCallIds`, `git_hunk.diff`, change-only emission, no double push, no-strip guard, fixture updates | Exact unit→fact and unit→agent joins; diffs | 4.3 |
| R4 | M1c: `Decision.ts`, `JevDecisionLog.pass`, honest suppression log, graph domain ids, SPEC edits | Completes decided fields; does not block the viewer | 4.4 |
| R5 | M2: `contracts/src/trace.ts`, `query_only` TraceReader, trace-service, three IPC channels, 1 s poll, bundle export; no SQL migration | Smallest read path the fold needs | 5 |
| R6 | `newId` uses `globalThis.crypto.randomUUID()`; `symbolId` moves to `@jevcode/contracts/node` | Makes the contracts barrel browser-safe | 4.5, 5.1 |
| R7 | One package `packages/trace-viewer`: lint-guarded React-free `src/model` plus `src/ui`; the model hashes nothing | One home for labels, fold and UI | 3.2, 6.1 |
| R8 | Fold API `createTraceState → accumulate → finalize`; skip repeats, gap on disorder or bad payloads | Incremental, parity-testable, never throws | 6.4 |
| R9 | Stable ids `step:<firstSeq>`, `unit:<id>`, `decision:<id>`, `file:<path>`, `finding:<ruleId>@<version>:<anchorSeq>` | Survive refolds and live appends | 6.3 |
| R10 | Derivations: pairing, evidence attach, claims vs observations, turns, chapters, claim vs evidence, problems facet, noise | One classifier, recomputed on read | 6.6 |
| R11 | Five v1 signals with id, version, rationale, known false positives, requires; coverage lists inactive ones | Explainable findings | 6.7 |
| R12 | Labels move from WorkspaceHost.tsx:97-200 to `model/format.ts`; `eventKey`/`mergeEvents` do not move | One vocabulary; do not export their bugs | 6.8 |
| R13 | One shell for both views: title bar, Outline, Inspector (Summary, Evidence, Raw), one keyboard model, one store | Selection and time carry across views | 7.1 |
| R14 | Hybrid and Canvas anatomy; pan, zoom, playhead and brush are in v1; no comments | Approved mockups minus write paths | 7.2 |
| R15 | CSS Modules and light `--tv-*` tokens; the trace window never loads styles.css; system fonts; CSP-compatible | Scoped by construction | 7.12, 8 |
| R16 | Live follows the tail only at the live edge; otherwise holds place with "N new" | Never move the reader | 7.10 |
| R17 | Hand-rolled DOM viewport for both views; no `@xyflow/react`; Canvas2D only for Hybrid marks; `@tanstack/react-virtual` for lists | Judge score 89 vs 68 vs 61 | 7.3 |
| R18 | One `TimeScale`: 10 s knee, 5 s per doubling, `BREAK_MIN_MS` 60 s | Continuous curve, identical gaps in both views | 7.4 |
| R19 | Module structure `model`, `layout`, `ui`, `sources`; `layout` imports `model`, never the reverse | Pixels never touch the model contract | 7.7 |
| R20 | Selector store on `useSyncExternalStore`; session in `startTransition`; view-switch contract | A fold never blocks a key | 7.8 |
| R21 | Keyboard map on `event.code`, one tab stop per region | IME-safe, one model for both views | 7.9 |
| R22 | Live follow rules; M4 drives live with the drip source, M5 with the poll | Testable before Electron | 7.10 |
| R23 | Loading, progressive, empty, partial, error states | The reader can tell "nothing" from "could not see" | 7.11 |
| R24 | Token additions and graphic scales; no dimming after the playhead | Contrast ≥ 4.5:1 text, ≥ 3:1 marks | 7.12 |
| R25 | Model fields the UI needs (lanes, finding anchors, claim span, display clock, chapter fields); the display clock is measured from `originMs` (§6.5) | Built into W0 types | 6.2 |
| R26 | Performance budgets | Measurable gates | 10 |
| R27 | Property tests, jsdom tests, one visual smoke outside `pnpm -r test` | Fastest reliable level per risk | 11 |
| R28 | One-day spike at the start of M4a; risks 1, 4, 5 gate M4a; 2, 3, 6, 7 gate M4b | Retire rendering risk early | 16 |
| R29 | M5: `openTraceWindow`, `trace.html`, Trace button, IPC source, Request changes handoff, smoke, parity test | Ships the Electron host | 8 |

## 3. Architecture

### 3.1 Data flow

```
Codex JSONL ─► M1 capture: turnId, callId, agent_reasoning, agent_interrupted, sourceCallId,
               canonical fact ids, agentCallIds, redacted diffs (change-only)
           ─► events log (SQLite `events`, schema unchanged)
           ─► M2 TraceReader (second connection, PRAGMA query_only = ON)
           ─► trace-service (factId, 16 KiB string clipping)
                 ├─► trace:listSessions | trace:rows | trace:payloads  (Electron IPC)
                 └─► buildTraceBundle ─► trace.json (redacted; replay CLI and `export`)
           ─► M3 fold (packages/trace-viewer/src/model): TraceRow[] ─► TraceSession
           ─► layout (pure: TimeScale, canvas layout, overview bins, spine rows)
           ─► UI (packages/trace-viewer/src/ui)
                 ├─► apps/trace-viewer-dev (Vite, static bundle source with drip)
                 └─► Electron trace window (trace.html, IPC source, 1 s poll)
```

Every consumer reads the same `TraceRow` shape. The fold is the only place rows become steps, so the dev host, the Electron window and the tests agree by construction; `trace-parity.test.ts` proves it for the five fixtures (§11).

### 3.2 Packages and ownership

| Path | Owns | Milestone |
|---|---|---|
| `packages/storage/src/db.ts` | File modes in `openDb` | M0 |
| `packages/contracts/src/{agent-events,evidence,semantic,jev}.ts` | Optional capture fields | W0 (schemas), M1a–M1c (producers) |
| `packages/contracts/src/canonical-json.ts` | `canonicalJson` | W0 |
| `packages/contracts/src/trace.ts` | `EVENT_TYPES`, `TRACE_ROW_TYPES`, row, page, summary and bundle schemas | W0 |
| `packages/contracts/src/node.ts` (`@jevcode/contracts/node`) | `symbolId` (node:crypto) | W0 |
| `packages/agent-core`, `packages/agent-codex` | `turnId`, `callId`, reasoning, interrupts | M1a |
| `packages/evidence-engine/src/collectors/git.ts` | Change-only emission, injected `prepareDiff` | M1b |
| `packages/semantic-core` | Canonical `factContentId`, `agentCallIds` | M1b |
| `apps/desktop/src/main/pipeline/*` | `prepareDiff`, double-push removal, stop and resume-budget events, suppression log | M1a–M1c |
| `packages/storage/src/trace-reader.ts` | `openTraceReader` | M2 |
| `apps/desktop/src/main/trace-{service,ipc,bundle}.ts` | factId, clipping, handlers, bundle | M2 |
| `apps/desktop/src/shared/{local-channels,api}.ts` | `trace:*` request schemas, `trace` API namespace | M2, M5 |
| `packages/trace-viewer` | `model`, `layout`, `ui`, `sources` | W0–M4b |
| `packages/ui-catalog` | `"./components/*"` export, CodeDiff `@@` fix | M4a |
| `apps/trace-viewer-dev` | Dev host, `scripts/smoke.mjs` | M4a |
| `apps/desktop/src/main/index.ts`, `renderer/trace/*`, `trace.html` | Trace window, IPC source, Trace button, composer prefill | M5 |

`packages/trace-viewer` builds to `dist` like every workspace package (W0 makes them all dist-only, with plain `include` lists in every Vitest config): `exports` maps `"."`, `"./model"` and `"./sources"` to `./dist/…`, and `scripts/copy-assets.mjs` copies the `.module.css` files that `tsc` does not emit. `./sources` lets Node-side tests (D-7) import the bundle source and `readAllTraceRows` without loading the React barrel. Dependencies: `@jevcode/contracts`, `@jevcode/ui-catalog` (components subpath only), `@tanstack/react-virtual` 3.14.13 (resolves virtual-core 3.17.11), `d3-zoom` and `d3-selection` 3.0.0 (the spike risk 1 fallback, both already locked), `zod ^3.24.1`; React 19.2 is a peer. `@jevcode/ui-catalog` itself depends on `@xyflow/react` (packages/ui-catalog/package.json), so an ESLint `no-restricted-imports` block over `packages/trace-viewer/src/**` bans `@xyflow/*` and every `@jevcode/ui-catalog` path except `@jevcode/ui-catalog/components/CodeDiff` (R17). Test-only code lives in `src/test-support/`, which `tsconfig.build.json` and the lint blocks already exclude, so no `./testing` export exists: row and session builders, fast-check arbitraries, the 75k-row synthetic generator, and `fixture-rows.ts`, which attaches `factId` with `factContentId` and makes `@jevcode/semantic-core` a devDependency, so the dev-host build never pulls in Node code.

### 3.3 Trust boundaries

1. **The viewer never writes.** Handlers receive only a `TraceReader` on its own `query_only` connection, so a write throws at runtime. They cannot reach `reloadPending`, the instruction router, Jev or the network (ipc.ts:264-279 shows the path `session:switch` takes and the trace window must never take).
2. **Zero network and zero Jev calls on open.** `packages/trace-viewer` lint-bans `fetch`, `WebSocket`, `window.jevcode`, `electron`, `node:*` and non-browser `@jevcode/*` packages. The trace window's CSP (`default-src 'self'`) blocks remote origins, and system fonts mean no font requests.
3. **Request changes hands off.** The Inspector's primary action calls `ViewerHost.requestChanges`. In Electron that focuses the main window's composer (WorkspaceHost.tsx:833) with a prefilled reference; the supervisor edits and sends it there. The trace window never calls `agent.sendInstruction` (apps/desktop/src/shared/api.ts:90).
4. **The trace window is read-only at the process boundary.** Main rejects every channel outside a four-channel allowlist when the sender is a trace window (§8.6).
5. **Agent text is data.** Every string from a payload renders as a text node; nothing an agent writes can produce viewer chrome (§9).

## 4. Contract and capture changes (M0, M1a, M1b, M1c)

**Compatibility rule.** Every new field is optional. `rebuildSession` re-parses stored rows with the current schemas and throws on the first failure (`parseWith`, packages/storage/src/db.ts:195-201; `rebuildOnBoot`, :431-457), so one required field would break boot for every existing database. `.strict()` is never used, because an older build must still parse newer rows. `rebuild.test.ts` replays rows written before each change.

### 4.1 M0: private store files

`openDb` (db.ts:1523-1527) creates the directory with `mode: 0o700` and chmods it only when it is the default `~/.jevcode`, never a `JEVCODE_DB` parent. Before better-sqlite3 opens the file, `openSync(dbPath, "a", 0o600)` pre-creates a missing DB, and an existing DB and its `-wal` and `-shm` files are chmodded to 0600; SQLite creates new sidecars with the DB file's mode. The replay `outDir`, `replay.db` and exported bundles use the same modes. `db.test.ts` asserts 0700 and 0600 (including `-wal`) on POSIX and skips on Windows. M0 is its own PR and lands before M1b, which starts persisting diff text.

### 4.2 M1a: agent correlation and an honest lifecycle

```ts
// packages/contracts/src/agent-events.ts
const eventBase = { sessionId, ts, turnId: z.string().min(1).optional() };
const call = { callId: z.string().min(1).optional() };        // `${turnId}:${item.id}`
// `...call` is added to command_started, command_completed, tool_started,
// tool_completed, file_changed and approval_requested.
z.object({ type: z.literal("agent_reasoning"), ...eventBase, ...call, text: z.string() }),
z.object({ type: z.literal("agent_interrupted"), ...eventBase,
           reason: z.enum(["interrupt", "steer", "stop"]) }),

// packages/contracts/src/evidence.ts
command_executed: + sourceCallId: z.string().min(1).optional()
test_result:      + sourceCallId: z.string().min(1).optional()
```

**Mapping rules** (packages/agent-codex/src/jsonl.ts):

| Codex input | Before | After |
|---|---|---|
| `item.started` / `item.completed` `item.id` (:121-221) | dropped | `callId = ${turnId}:${item.id}` on both events of the pair |
| `reasoning` item (:178-189) | `agent_message {role: "assistant"}` | `agent_reasoning {text, callId}` |
| `command_execution.exit_code` missing (:246) | `exitCode: -1` | unchanged in storage; the viewer renders −1 as "exit unknown", never failed |
| every emitted event | no turn | `turnId` from `EventNormalizerContext` |

**Turn ids.** Codex `turn.started` carries no id, so the adapter mints `turnId = newId("turn")` before each `agent_started` it emits (codex-adapter.ts:203 and :437) and passes it through a new optional `turnId` on `EventNormalizerContext` (packages/agent-core/src/events.ts:6-9). The prefix keeps `callId` unique if Codex restarts item ids per `exec resume`. No per-event `id` is added: `(sessionId, seq)` already identifies a row.

**Source call ids.** `observeCommand` and `observeTestOutput` (called at pipeline-runtime.ts:750-753) take the `command_completed.callId` and stamp it as `sourceCallId` on the `command_executed` and `test_result` facts they derive.

**Paused interrupts (D10).** Today `interrupt()` writes ^C (codex-adapter.ts:258-272) and the exit handler emits `agent_failed "codex exited with code N"` (:479-492), which the runtime turns into a failed, ended session (pipeline-runtime.ts:776-787). Stop and steer log nothing.

- **Interrupt.** After `interrupt()` the adapter marks the running process. That process's first terminal signal (`turn.completed`, `turn.failed` or exit) becomes exactly one `agent_interrupted {reason: "interrupt"}`, and later signals from it are dropped. This also blocks an invented `agent_completed` if Codex emits `turn.completed` after SIGINT.
- **Steer.** A steer kills the running process with its exit suppressed (`terminateRunningProcess`, codex-adapter.ts:392-398) and relaunches. `deliverSteer` gains an interrupt-reason option: `sendInstruction` (codex-adapter.ts:232-233) passes `"steer"`, and `deliverSteer` then emits `agent_interrupted {reason: "steer"}` only when `terminateRunningProcess` actually killed a process (`ptyProc` was not null), before `spawnResume` emits the relaunch's `agent_started`. `sendDecision` shares `deliverSteer` (:248-249), passes no reason, and keeps today's behavior.
- **Stop.** The runtime owns the stop record, because `ingestRecord` drops adapter records once `stopping` is set (pipeline-runtime.ts:316). `stopSession` (:423-445) appends `agent_interrupted {reason: "stop"}` through `appendAgentEvent` before it sets `stopping`; `adapter.stop()` (codex-adapter.ts:297-306) emits nothing. When the agent had not ended, `stopSession` writes `paused` instead of the synthetic `completed`, skips `setSessionEnded`, and keeps the execution claim, so the boot sweep treats the session like any paused one (session-recovery.ts:18-24). The `session:stop` handler (ipc.ts:256-262) also calls `session-service.stopSession` (session-service.ts:50-66), which sets `endedAt` and rewrites the state to `completed`; M1a changes that function to keep `failed` and `completed`, leave any other state as the runtime wrote it, and set `endedAt` only for a terminal state.
- **Resumable stop (D10).** The Codex thread id lives only in memory (`ActiveSession.threadId` and the adapter); the `sessions` table has no thread column (migrations.ts:23-34, :294-295). A paused stop therefore keeps the `ActiveSession` in `this.sessions` with its adapter and evidence collector instead of deleting it (pipeline-runtime.ts:433). `resume()` clears `stopping` and calls `adapter.resume()`, which runs `codex exec resume <threadId>` (codex-adapter.ts:274-295). `stopSession` takes `{teardown}`: `session:stop` passes `false`; `repo:close` (ipc.ts:171-186) and the replay CLI (cli-entry.ts:177) pass `true` and keep today's full teardown. Resuming after an app restart is §16 risk 9.
- A decision relaunch keeps today's behavior (no terminal event); the fold reads the next turn as a resume (§6.6).
- `PipelineRuntime.applyTerminalAgentState` maps `agent_interrupted` to `paused`; it never sets `failed` or `endedAt`.
- codex-adapter.test.ts:190-203 changes from "the session fails on exit" to "exactly one `agent_interrupted {reason: "interrupt"}`, state `paused`, no `agent_failed`".

**Resume-budget failure.** The `agent_failed "resume budget exhausted"` event is emitted but never persisted (pipeline-runtime.ts:468-473). It is appended with `appendAgentEvent` before the emit. `ingestRecord` is not used because it would rerun the terminal transition.

**Routing guard.** Record routing tries `EvidenceFactSchema` first (pipeline-runtime.ts:334). A comment there states that agent events must never carry `repoId`.

**SPEC sign-off (IMPLEMENTATION-PLAN risk R8).** The M1a PR removes "replay UI" from the §18 deferred list (docs/SPEC.md:653) and adds "read-only trace viewer (this spec)" to §1 In scope. "Replay UI polish" stays in §1 Out of scope (docs/SPEC.md:35). Approving §1 of the design was the plan-owner sign-off that docs/IMPLEMENTATION-PLAN.md:180 requires.

### 4.3 M1b: fact provenance and redacted diffs

**Canonical fact ids.** `canonicalJson(value)` in new `packages/contracts/src/canonical-json.ts` sorts object keys recursively, drops `undefined`, keeps array order and uses no `node:` import. `factContentId` (packages/semantic-core/src/ids.ts:11-13) becomes `hashId("fact", sessionId, canonicalJson(record))`. Today the coordinator hashes the collector's key order while storage keeps the zod-reordered JSON, so 0 of 64 cited ids in a copy of `~/.jevcode/jevcode.db` match their stored rows. Unit ids never hash fact ids (clustering.ts:441-513), so they do not change.

**Unit → agent join.**

```ts
// packages/contracts/src/semantic.ts, ChangeUnitSchema (:165-190)
agentCallIds: z.array(z.string().min(1)).optional(),
```

`clusterSession` receives `agentEvents` and ignores them today (packages/semantic-core/src/clustering.ts:39). It fills `agentCallIds` with:
1. every `sourceCallId` on the unit's facts (exact);
2. for each agent `file_changed` with a `callId`, the unit that owns the evidence fact for that path nearest in time, ties to the lower sequence. "Nearest", not "after", because the watcher can see a write before Codex reports it.

`agentCallIds` joins `unitSignature` (coordinator.ts:529-538), so a changed call set emits a new unit version.

**Diffs (D6).**

```ts
// packages/contracts/src/evidence.ts, git_hunk
diff: z.object({
  hash: z.string().regex(/^[0-9a-f]{16}$/),   // sha256(raw diff) prefix, pre-redaction; the change key
  bytes: z.number().int().nonnegative(),      // raw size, so "showing 32 KB of 410 KB" is truthful
  text: z.string().optional(),                // redacted, capped unified diff against baseCommit
  truncated: z.boolean(),                     // set where the cap was applied, never inferred
  redactions: z.number().int().nonnegative(),
  withheld: z.enum(["secret_path", "not_captured"]).optional(),
}).optional()
```

Capture rules in `packages/evidence-engine/src/collectors/git.ts:185-209`:

1. **Change-only emission.** The collector keeps `lastHash` per file, skips a file whose raw diff hash is unchanged, and forgets files that leave `git status`. Today every 5 s poll re-emits each dirty file with a new `ts`.
2. **Injected `prepareDiff(file, raw) → diff`.** Without an injection the fact carries `{hash, bytes, truncated: false, redactions: 0, withheld: "not_captured"}`, so tests and CLIs never store unredacted text.
3. **Desktop `prepareDiff`** lives in `apps/desktop/src/main/pipeline/redactor.ts` and is wired in `evidence-runtime.ts`. Order: withhold, then collapse private-key blocks, then redact, then cap.
   - withholds paths whose basename matches (case-insensitive) `.env*`, `*.pem`, `*.key`, `id_rsa*`, `id_dsa*`, `id_ecdsa*` or `id_ed25519*` (the last three not when the name ends in `.pub`), `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `.npmrc`, `.netrc`, `.pgpass`, `.pypirc` or `credentials` (`withheld: "secret_path"`, no `text`; `withheld` keeps its two values). `.env.example` is withheld too, and `id_rsa*` keeps R3's glob, so `id_rsa.pub` is withheld while `id_ed25519.pub` is stored; a false positive costs one diff;
   - classifies lines first: `---`/`+++` are headers only in a file's header block (after `diff --git`, before its first `@@`). Inside a hunk every line is classified by its first character and counted against the `@@` header's old and new line counts, so a removed `-- password=…` line is content. Header-block lines (`diff --git`, `index`, `new file mode`, `---`, `+++`), `@@` lines, `Binary files … differ` and `\ No newline at end of file` are kept verbatim;
   - in every path it does not withhold, replaces each PEM private-key block with one line before any other rule runs. A block opens at a line containing `-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----` after its diff prefix and runs through the next line containing `-----END [A-Z0-9 ]*PRIVATE KEY-----`, or to the end of its hunk (the next `@@` or `diff --git` line) when no END line follows. The whole block becomes the single line `[REDACTED:private_key]` behind the BEGIN line's prefix (`+`, `-` or space) and counts as one redaction. `CERTIFICATE` and `PUBLIC KEY` blocks are kept. This pass exists because the whole-string `private_key` rule (redactor.ts:25-29) never matches a diff whose hunk ends before the END line, so the key body would be stored. After a collapsed block the hunk's `@@` counts overstate its stored lines; `hash` and `bytes` still describe the raw diff (§16 risk 14);
   - redacts each hunk line after its one-character prefix (`+`, `-`, space);
   - fixes the `env_value` rule's `^` anchor (redactor.ts:42-44) to accept leading whitespace and `export `; a probe gets 0 redactions for `+STRIPE_KEY=sk_live_abc` today;
   - caps `text` at 32,768 UTF-8 bytes, measured after redaction. A longer diff is cut at the start of the last `@@` hunk header before which the text fits; when the first hunk alone does not fit, it is cut after the last whole line that fits. Either cut sets `truncated: true`; `truncated` is false only when nothing was cut.
4. **Redaction rules.** `RULES` in redactor.ts serve `prepareDiff`, bundle export (§5.7) and Jev prompts. M1b changes them, each change with a test in redactor.test.ts:
   - `redactText` skips values that already start with `[REDACTED:`: each rule's value part is preceded by `(?!\[REDACTED:)`, so a span replaced by an earlier rule in the same call is not counted again and a second pass is a no-op. Today `redactText("API_KEY=abc123")` counts 2 and every later pass counts again. Tests assert `redactText("API_KEY=abc123").count === 1` and `redactText(redactText(x).text).count === 0` for one sample per rule;
   - the `token` rule change leaves M1b for a separate PR (§14). The proposed rule accepts an optional quote between the key and the separator (`\b(key)\b["']?\s*[:=]\s*["']?`) and redacts only a quoted literal of at least 8 characters, or an unquoted run of at least 8 characters from `[A-Za-z0-9_\-./+=]` that contains a digit. Until that PR lands, the rule keeps rewriting `verifyIdToken(token: string)` (oauth's `symbol_delta` and its `identity.ts` diff) and `token: randomBytes(32)…`, which fails safe but reads badly and makes every oauth bundle's `redactionCount` at least 1 (§16 risk 12);
   - new rules: `github_token` `/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g`; `slack_token` `/\bxox[abposr]-[A-Za-z0-9-]{10,}/g`; `provider_key` `/\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|[rs]k_(?:live|test)_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{35})\b/g`; `bearer` `/\b(Bearer)\s+[A-Za-z0-9._~+\/=-]{16,}/g` → `$1 [REDACTED:bearer]`; `url_credential` `/\b([a-z][a-z0-9+.-]*:\/\/[^\s:\/@]+:)[^\s@\/]+@/gi` → `$1[REDACTED:url_password]@`; `aws_secret` `/\b(aws_secret_access_key)\s*[:=]\s*[A-Za-z0-9\/+=]{40}/gi` → `$1=[REDACTED:aws_secret]`. Today a quoted `"apiKey": "sk-proj-…"`, `Bearer …`, `ghp_…` and lowercase `aws_secret_access_key = …` all get 0 redactions.
5. **No double push.** The collector already pushes each fact into the sink (git.ts:205), and evidence-runtime.ts:111 and :122 push the returned facts again; a copy of the local DB shows seq pairs 3/7 and 5/9 as identical rows. The two re-pushes are removed.

**No-strip guard.** zod strips undeclared keys at codex-adapter.ts:618, db.ts:261-267, coordinator.ts:549-551, api.ts:169 and validate-fixtures.mjs:162. One test asserts `canonicalJson(schema.parse(x)) === canonicalJson(x)` over every event mapped from `packages/agent-codex/test/fixtures/*.jsonl`, every fact from the git, command and test collectors, and every `fixtures/*/events.jsonl` line. Canonical ids depend on the same equality, so this test protects both.

**Fixtures.** Each `fixtures/*/events.jsonl` gains `turnId` on agent events, `callId` on `command_started`/`command_completed` and `tool_started`/`tool_completed` pairs (never on `test_started`/`test_completed`, whose schemas gain no `callId`; they join the open command step by normalized command, §6.6), `sourceCallId` on `command_executed` and `test_result`, and `diff` on every `git_hunk`, generated once from `repo/` → `changes/` through the desktop `prepareDiff`. Every fixture diff has `redactions === 0` except where the unchanged `token` rule matches code, such as oauth's `verifyIdToken(token: string)` (§14). No fixture contains an agent `file_changed` (every one carries `repoId`), so claim-versus-observation tests use `src/test-support` builders. oauth gains one `agent_reasoning` line immediately before the "all checks pass" claim (line 48). The oauth failure message changes from "expected 7 to be null" to "expected null to be 7": the assertion is `expect(identity.userId).toBe(7)` (fixtures/oauth/changes/tests/auth/oauth.test.ts:9), and vitest prints the received value first. `scripts/validate-fixtures.mjs` checks each diff's `+`/`-` line counts against `added`/`removed`; a mismatch is reconciled by hand, because the counts feed Jev `diffStats` (jev-router/src/state.ts:180).

### 4.4 M1c: remaining decided fields (does not block M2–M5)

- `Decision.ts: z.string().optional()`, the source time of each status transition, set at pipeline-runtime.ts:550 and :585 and in fixtures. The viewer uses it for display only (§6.5).
- `JevDecisionLog.pass: z.enum(["A", "B"]).optional()`, set at the three `buildJevDecisionRecord` calls (jev-stage.ts:147, :177, :215).
- Guardrail suppression (jev-stage.ts:146-160) logs `clientKindOf(result)`, `result.confidence` and `modelShouldSurface`. Jev already answered that unit (`client.attention`, jev-stage.ts:134), so the constant `"degrade"` at 1.0 is wrong.
- Graph node `data` gains domain ids (`unitId` at graph.ts:86, `path`, `decisionId`, `validationId`, `failureId`), and AgentEvent nodes are keyed by `callId` (graph.ts:254-255 collapses same-type, same-ts events today). `payload` is a `z.record` (storage/src/local-schemas.ts:44-50), so no schema change.

### 4.5 SPEC and documentation edits

| Document | Edit | PR |
|---|---|---|
| docs/SPEC.md §1, §18 | IMPLEMENTATION-PLAN risk R8 sign-off (§4.2) | M1a |
| docs/SPEC.md §4.1 | `turnId`, `callId`, `agent_reasoning`, `agent_interrupted`, all optional; `agent_completed` means "turn ended normally"; exit −1 means unknown | M1a |
| docs/SPEC.md §4.2, §3.7 | `sourceCallId`; `git_hunk.diff`; the diff redaction, withholding and cap rule | M1b |
| docs/SPEC.md §4.3 | `evidence` holds fact, validation and semantic-event ids (not only fact ids); `agentCallIds`; `Decision.ts` | M1b, M1c |
| docs/SPEC.md §7 | Change-only git emission | M1b |
| docs/SPEC.md §8.5 | `pass`; the suppression logging rule | M1c |
| docs/spikes/codex-spike.md §3 | Mapping table rows for `item.id`, `reasoning`, turn ids, interrupts | M1a |
| docs/SPEC.md §13, docs/perf.md | Viewer budgets with measurements | M5 |
| docs/security.md | File modes; diff redaction; trace window allowlist | M0, M1b, M5 |

R6 lands in W0: `newId` uses `globalThis.crypto.randomUUID()` (engines already require Node ≥ 22, package.json:7-9), and `symbolId` moves to `@jevcode/contracts/node`, with its two callers (evidence-engine/src/symbol-diff.ts:14, semantic-core/src/clustering.ts:136) importing from there. `id.test.ts` pins the `symbolId` digest so `change_unit_symbols` rows stay valid.

### 4.6 Stored-row compatibility

- Pre-M1 rows lack every new field and still parse. The fold degrades per §6.9: inferred pairing, approximate chapter joins, "exit unknown".
- The log is append-only. Old units keep their non-canonical `evidence` ids; nothing rewrites them.
- An interrupted session recorded before M1a keeps its stored `agent_failed`; the viewer shows it as recorded, because the log is evidence.
- Change-only emission changes live clustering: repeated polls no longer keep a bucket under the 120 s gap. This moves live sessions closer to fixture behavior. soak.mjs reports unit counts before and after, and fixtures are unaffected.

## 5. Read path and export (M2)

### 5.1 `packages/contracts/src/trace.ts`

```ts
export const EVENT_TYPES = [/* moved verbatim from storage/src/db.ts:53-68 */] as const;
export type EventStoreType = (typeof EVENT_TYPES)[number];     // db.ts re-exports both
export const TRACE_ROW_TYPES = ["agent_event", "evidence_fact", "change_unit",
  "decision", "validation", "jev_decision"] as const;          // the rows the fold consumes

export const TraceRowSchema = z.object({
  seq: z.number().int().positive(),
  type: z.string().min(1),           // any type, so the row stays source-agnostic (D2); the fold gaps unknown types (§6.4)
  ts: z.string(),                    // row append time; not the source clock (§6.5)
  payload: z.unknown(),
  clipped: z.boolean().optional(),   // a string over 16 KiB was cut to head + tail
  factId: z.string().optional(),     // evidence_fact only; canonical, computed pre-clip, pre-redaction
});
export const TraceSessionSummarySchema = z.object({
  sessionId: z.string(), repoId: z.string(), repoName: z.string(), prompt: z.string(),
  state: AgentStateSchema, startedAt: z.string(), endedAt: z.string().nullable(),
  lastEventSeq: z.number().int().nonnegative(),
});
export const TraceRowsPageSchema = z.object({
  rows: z.array(TraceRowSchema),
  nextAfterSeq: z.number().int().nullable(),   // null: caught up with lastSeq
  lastSeq: z.number().int().nonnegative(),     // same read snapshot as rows
  state: AgentStateSchema,
});
export const TraceBundleSchema = z.object({
  format: z.literal("jevcode.trace"), version: z.literal(1), exportedAt: z.string(),
  redactionCount: z.number().int().nonnegative(),
  session: TraceSessionSummarySchema, rows: z.array(TraceRowSchema),
});
```

Only `EVENT_TYPES` moves. Every payload schema the fold parses already lives in contracts (`NormalizedAgentEventSchema`, `EvidenceFactSchema`, `ChangeUnitSchema`, `DecisionSchema`, `ValidationResultSchema` at semantic.ts:150, `JevDecisionLogSchema`). After R6 the barrel is browser-safe, so no `./trace` subpath is needed.

### 5.2 TraceReader

`packages/storage/src/trace-reader.ts` exports `openTraceReader(dbPath): TraceReader`. It opens a second better-sqlite3 connection with `PRAGMA query_only = ON`; WAL lets it read while the writer appends. It prepares three statements:

| Method | SQL shape | Notes |
|---|---|---|
| `listSessions({repoId?, sessionId?, limit})` | `sessions JOIN repositories`, `lastEventSeq > 0`, `ORDER BY startedAt DESC, id` | Without `sessionId`, hides the zero-event session every repo open creates (repo-service.ts:23-27); `lastEventSeq > 0` applies only then. `sessionId` is an exact-match filter the trace window uses for its summary, and returns the session even with zero events |
| `rows(sessionId, afterSeq, limit)` | `seq > ? AND type IN (TRACE_ROW_TYPES) ORDER BY seq LIMIT ?` | Uses the existing `UNIQUE(sessionId, seq)` index (migrations.ts:36-45). The page also stops after the row whose cumulative stored `payloadJson` passes 2 MiB (2,097,152 UTF-8 bytes), because real agent rows average about 12 KB and 5,000 of them would make a page of about 60 MB. A page always holds at least one row, so a single larger row still arrives. The statement is read with `iterate()`, so no payload after the cut is read. `TraceReaderPage.full` is true when the page stopped at `limit` or at the byte bound |
| `payloads(sessionId, seqs)` | `seq IN (SELECT value FROM json_each(?))` | One cached statement |

`rows` reads `sessions.lastEventSeq` and the page inside one read transaction, so both come from one WAL snapshot. `nextAfterSeq` is the last returned seq when the page is full (by `limit` or by the 2 MiB bound) and `null` otherwise; after a `null`, the caller's next `afterSeq` is the page's `lastSeq`, which skips the excluded rows it already passed. Seq is gapless (`MAX(seq)+1` inside the append transaction, db.ts:282-295), so this reads each consumed row exactly once.

### 5.3 trace-service

`apps/desktop/src/main/trace-service.ts` wraps the reader:

- attaches `factId` to each `evidence_fact` row, computed with `factContentId(sessionId, parsedPayload)` on the stored payload before clipping;
- clips every string longer than 16 KiB (16,384 UTF-8 bytes; W0's `TRACE_CLIP_CHARS` is used as a byte threshold, although its doc comment says UTF-16 code units) to its first 4 KiB and last 12 KiB of UTF-8, with a `… [N bytes clipped] …` line between them (N counts the UTF-8 bytes removed), and sets `clipped: true`. Both cuts fall on code-point boundaries, so the head or the tail may be up to 3 bytes short and no surrogate pair is split. The tail is longer because failures live at the end of output. `clipPayload(payload, maxBytes?)` puts a quarter of `maxBytes` in the head and the rest in the tail. Only the `text` of a `git_hunk` payload's `diff` object is exempt; a `text` key anywhere else clips as usual. Its 32 KiB cap (§4.3) already bounds it, so Evidence receives the whole stored diff and `diff.text` never sets `clipped`. The service does not re-check that size, so a stored `diff.text` over the cap would be served whole;
- takes `rows(request, {clip: false})` and `toTraceRow(…, {clip: false})`, which return payloads as stored, and exports `clipTraceRow(row)`, which applies the clip afterwards. Only `buildTraceBundle` passes `clip: false` (§5.7). The `trace:*` handlers pass only the zod-parsed request, so a renderer cannot turn clipping off;
- validates `sessionId` against `sessions` and fails with `UNKNOWN_SESSION` otherwise. It does not require the open repo, because the viewer reads across repositories.

### 5.4 IPC channels

Request schemas go in `apps/desktop/src/shared/local-channels.ts` (:10-28 channel names, :207-230 payload registry); `shared/api.ts` gains a `trace` namespace. Handlers live in `apps/desktop/src/main/trace-ipc.ts` as `registerTraceHandlers(handle, service)` on the existing `handle` wrapper (ipc.ts:129-143), which already runs `assertTrustedSender` and zod parsing.

| Channel | Request | Response | Guarantees |
|---|---|---|---|
| `trace:listSessions` | `{repoId?, sessionId?, limit ≤ 500}` | `TraceSessionSummary[]` | Deterministic order; all repositories |
| `trace:rows` | `{sessionId, afterSeq? ≥ 0, limit ≤ 5000}` | `TraceRowsPage` | One snapshot; consumed types only; ascending seq; each row at most once per `afterSeq` |
| `trace:payloads` | `{sessionId, seqs: 1–50 positive ints}` | `TraceRow[]` | Same clipping as `rows`; unknown seqs are omitted |

`registerTraceHandlers` receives only `handle` and the service. It holds no reference to state, the runtime, the instruction router, Jev, the network or `sendToRenderer`. `trace-ipc.test.ts` seeds a pending instruction, calls every channel, and asserts that the instruction stays pending, nothing is delivered, and the `events` count and `lastEventSeq` are unchanged.

The hidden-row count is `hidden.unreceived` (`loadedThroughSeq − received`, the rows the source filtered out) plus the `hidden.byType` counts of delivered rows that make no step; it is exact because seq is gapless (§6.4). The Outline footer shows it.

**M5 channels.** These three are registered in `apps/desktop/src/main/index.ts` beside `openTraceWindow`, not in `registerTraceHandlers`, because they need the window map:

| Channel | Direction and sender | Payload | Response |
|---|---|---|---|
| `trace:open` | renderer → main; main window only | `{sessionId: z.string().min(1)}` | void |
| `trace:requestChanges` | renderer → main; trace windows only | `{sessionId: z.string().min(1), selected: TraceStableIdSchema, text: z.string().min(1).max(TRACE_NOTE_MAX_CHARS)}` | void |
| `composer:prefill` | main → main renderer, in `MainToRendererLocalChannels` | `{sessionId: z.string().min(1), text: z.string().min(1).max(TRACE_NOTE_MAX_CHARS)}` | — |

local-channels.ts declares `TRACE_NOTE_MAX_CHARS = 8_000` and `TraceStableIdSchema = z.string().regex(/^(step:\d+|unit:.+|decision:.+)$/s)`. The viewer sends only the review note's line 1 (§7.1), so 8,000 characters is a bound on a forged or future note, not a length any v1 note reaches; a longer payload fails `INVALID_PAYLOAD`. The `trace` API namespace gains `open(sessionId)` and `requestChanges(r)`, and the API gains `onComposerPrefill(listener)`.

### 5.5 Live polling

Live follow polls `trace:rows {afterSeq}` every 1 s until the page's `state` is `completed` or `failed`. `paused` and `waiting_decision` are not terminal and keep polling. Pushes are not used: `sendToRenderer` reaches only the main window (ipc.ts:82-91), and a poll over gapless seqs misses nothing. `TraceSource` is a stateless pull interface, and `createIpcTraceSource` only maps calls to channels. The DataController (`ui/shell/data-controller.ts`) calls `source.rows({afterSeq})` every `pollMs` until the page state is terminal. `pollMs` is a `TraceViewer` prop, because only the host knows the source: it defaults to `TRACE_LIVE_POLL_MS` (1,000) for IPC, and the dev host passes `drip.intervalMs`. The DataController tags each request with a monotonic token and drops stale responses. A failed poll keeps the loaded data, shows "Reconnecting (n)", and retries after 1, 2, 4, then every 10 s. While `document.visibilityState === "hidden"`, the DataController keeps polling and applies once on `visibilitychange`. After the terminal page, the DataController applies once more and stops.

### 5.6 Bundle and export CLI

`buildTraceBundle(service, sessionId, options?)` in `apps/desktop/src/main/trace-bundle.ts` pages the service with `trace:rows` semantics to the end (unclipped, then redacted and clipped page by page, §5.7), re-stamps the summary's `lastEventSeq` and `state` from the last page, and returns a `TraceBundle`. Two entry points call it:

- `runReplay` (apps/desktop/src/main/replay/cli-entry.ts:29) writes `<outDir>/trace.json` after `syncAll`, next to `replay.db`.
- `replayMain` (cli-entry.ts:202) accepts `export --db <path> --session <id> --out <file>`:

```
pnpm --filter jevcode-desktop build
pnpm --filter jevcode-desktop replay fixtures/oauth .out/oauth           # writes .out/oauth/trace.json
pnpm --filter jevcode-desktop replay export --db ~/.jevcode/jevcode.db --session sess_… --out oauth.json
JEVCODE_SOAK_PROFILE=trace JEVCODE_SOAK_EXPORT=.out/soak.json node scripts/soak.mjs   # soak bundle
```

soak.mjs also times a full-session read through the service before its `rmSync` (scripts/soak.mjs:479) and prints it, with `storedRows` and `consumedRows` (= `bundle.rows.length`). A full default soak on 144c7fb stores about 455k events for its 9,993 records and runs about 11 minutes; docs/perf.md:19 still records 75,181 events from an earlier build. About 111k of the 455k are trace rows, holding 168 MB of payload JSON; the reader excludes the rest (§16 risk 11). Its default records carry empty stdout and one-line messages, about 40 times smaller than a real DB's agent rows (11.7 KB mean). With `JEVCODE_SOAK_PROFILE=trace` it draws `command_completed.stdout` sizes from {0.2, 2, 8, 32, 64} KiB and assistant texts from 0.2–4 KiB, and emits `command_started`/`command_completed` pairs with `callId`, an agent `file_changed` before each feature hunk, and an `agent_started` steer every 500 records. `JEVCODE_SOAK_KEEP_DB=<path>` copies the DB before the `rmSync`. The dev host's `pnpm --filter trace-viewer-dev bundles` runs the replay for all five fixtures into its gitignored `public/bundles/`.

### 5.7 Redaction on export

`buildTraceBundle` pages with `service.rows(request, {clip: false})`, which returns stored payloads with `factId` computed. `redactBundleValue(value, homeDir)` (exported from trace-bundle.ts) then runs `redactText` (redactor.ts:48) over every whole string of each row payload and of the summary, replaces the home-directory prefix with `~` only at a path boundary, and returns `{value, count}`; the counts sum to `redactionCount`. Envelope fields (`seq`, `type`, `ts`, `clipped`, `factId`) are machine values and are not redacted. Only then does `clipTraceRow` apply the service's 16 KiB head + tail clip (§5.3), so a secret cannot escape redaction by straddling a cut: a private key cut by the 4 KiB head boundary is redacted as one block. The bundle works one page at a time, so an unclipped page never holds more than the 2 MiB page bound (§5.2) plus one row. `factId` is computed before redaction, so it still matches the units' `evidence` ids. Stored diffs are already redacted, and `redactBundleValue` counts a string's hits only when redaction changed it, so an existing `[REDACTED:…]` marker is not counted again. Bundles are local files for the dev host and tests; sharing them outside the machine is out of v1 (§15). The trace window does not redact: it shows the local user their own local data.

## 6. Trace model (M3)

### 6.1 Placement and rules

`packages/trace-viewer/src/model`, exported as `@jevcode/trace-viewer/model`. An ESLint block bans `react`, `react-dom`, `node:*`, `electron`, `@jevcode/{storage,semantic-core,evidence-engine,jev-router,agent-*}`, `fetch` and `WebSocket` in `src/model/**` and `src/layout/**`, and `src/model` may not import `src/layout` (R19). The model has no clock, randomness or I/O, hashes nothing, and keeps no raw payloads: it keeps derived fields plus the prose text of instruction, message and reasoning steps, and the Inspector fetches payloads by seq. Its output is structured-clone-safe, so a worker can run it later.

Files: `types.ts` (W0-6), `format.ts`, `registry.ts`, `rows.ts`, `fold.ts`, `classify.ts`, `signals.ts`, `search.ts`, `lookup.ts`, and the internal `fold-state.ts`, `fold-agent.ts`, `fold-evidence.ts` and `fold-chapters.ts`. Each `fold-*` module owns one family of rows; `fold-state.ts` holds the shared drafts and the clock so that no `fold-*` module imports `fold.ts` back (a runtime import cycle). It is not exported.

### 6.2 Types

`model/types.ts` (W0-6, plus the UI index §1.2 additions and B-4's `resultSeq`) is authoritative for names; this is its shape. It replaces the earlier draft shape (`Step.turn`, `entityKeys`, `noise: {reason}`, kind `jev`, decision step ids `decision:<id>`, `TraceMeta`), because W0 and lane B implement this one and the UI lanes code against it (UI index §1.6).

```ts
// Contract types (AgentState, ChangeCategory, ChangeUnitStatus, Decision, DependencyChange,
// EventStoreType, JevClientKind, JevPass, SchemaChange, TraceSessionSummary) come from @jevcode/contracts.
export const LANES = ["supervisor", "agent", "commands", "edits", "tests", "jev"] as const;
export type Lane = (typeof LANES)[number];
export const LEVELS = ["session", "chapter", "step"] as const;
export type Level = (typeof LEVELS)[number];
export type StepKind = "instruction" | "message" | "reasoning" | "command" | "test" | "check"
  | "edit" | "read" | "tool" | "approval" | "decision" | "dependency" | "revert"
  | "lifecycle" | "guardrail" | "attention";                       // STEP_KINDS
export type StepStatus = "ok" | "failed" | "running" | "unknown" | "info";
export type Actor = "supervisor" | "agent" | "repo" | "jevcode";
export type ProblemKind = "exit_nonzero" | "tests_failed" | "agent_failed" | "destructive"
  | "guardrail" | "claim_contradicted";
export type NoiseReason = "read" | "lockfile" | "formatting" | "duplicate_poll" | "lifecycle"
  | "pipeline" | "superseded" | "passing_test";
export type SignalId = "claim_contradicted" | "failing_tests" | "destructive_command"
  | "guardrail_clamp" | "recovery_arc";
export type Capability = "agent_messages" | "agent_commands" | "test_results" | "jev_decisions"
  | "call_ids" | "fact_links";
export type GapKind = "invalid_row" | "unknown_row_type" | "out_of_order" | "unpaired"
  | "missing_evidence";
export type StepId = `step:${number}`;          export type UnitStableId = `unit:${string}`;
export type DecisionStableId = `decision:${string}`;  export type FileStableId = `file:${string}`;
export type FindingId = `finding:${string}`;
export type StableId = StepId | UnitStableId | DecisionStableId | FileStableId | FindingId;

export interface Step {
  id: StepId;                       // step:<firstSeq> for every step, decisions included (§6.3)
  kind: StepKind; lane: Lane;       // lane = KIND_META[kind].lane
  actor: Actor;
  provenance: "observed" | "inferred";   // inferred = heuristic join or pairing
  status: StepStatus;
  headline: string; target?: string;     // target: normalized command, path, tool or decision id
  text?: string;                    // instruction, message and reasoning steps: the full text
  callId?: string; turnIndex: number;
  seqs: number[]; firstSeq: number; lastSeq: number;
  startTs: string; endTs: string | null;
  startMs: number;                  // epoch ms of the first row's source time, unclamped (§6.5)
  tMs: number;                      // display clock, ms since originMs, never decreases with seq
  endTMs: number | null; durationMs: number | null;
  approxTime: boolean;              // Codex PTY arrival times
  command?: { command: string;
              exitCode: number | null;       // null until completed; −1 kept as recorded, "exit unknown"
              destructivePattern?: string;   // matchDestructive pattern name
              outputTail?: string };         // last 20 lines of stdout then stderr, ≤ 2,048 code units
  tests?: { passed: number; failed: number; skipped: number; runner?: string;
            failures: { file: string; testName: string; message: string }[];   // ≤ 20
            resultSeq?: number };            // the test_result row behind the run (B-4)
  edit?: { path: string; change?: "added" | "modified" | "deleted"; added: number; removed: number;
           claimed: boolean;                 // an agent file_changed names the path
           observed: boolean;                // a repo fact confirms it
           diffSeq?: number;                 // latest git_hunk row; fetched with TraceSource.payloads
           diff: "text" | "truncated" | "withheld_secret" | "not_captured" | "none";
           lockfile: boolean; formattingOnly: boolean };
  decision?: { decisionId: string; title: string; severity: Decision["severity"];
               status: Decision["status"]; options: { id: string; label: string; chosen: boolean }[];
               decidedBy?: "supervisor" | "delegated";
               answerSeq?: number };         // the absorbed answer message (§6.6)
  guardrail?: { clampIds: string[]; changeUnitId?: string; pass?: JevPass;
                clientKind: JevClientKind; confidence: number };   // kind "guardrail"
  evidenceSeqs: number[];           // repo facts and validations attached to the step
  chapterIds: UnitStableId[]; entityIds: FileStableId[]; findingIds: FindingId[];
  problems: ProblemKind[];
  noise: NoiseReason | null;        // never set when problems or findingIds is non-empty
}

export interface Turn {
  index: number; trigger: "initial" | "steer" | "resume"; prompt: string;
  outcome: "completed" | "failed" | "interrupted" | "waiting" | "running" | "unknown";
  interruptReason?: "interrupt" | "steer" | "stop"; turnId?: string;
  startSeq: number; endSeq: number; startTs: string; endTs: string; tMs: number; endTMs: number;
  stepIds: StepId[]; planStepId?: StepId; claimStepId?: StepId;   // §6.6 "Plan and claim"
}

export interface Chapter {
  id: UnitStableId; changeUnitId: string; title: string; intent?: string;
  shortTitle?: string;              // ≤ 24 graphemes, §6.6 "Short titles"; set by the fold, absent on hand-built sessions
  category: ChangeCategory; status: ChangeUnitStatus;
  current: boolean;                 // false when the latest version is superseded
  noise: boolean;                   // §6.6 "Chapters"; a finding that names the chapter clears it
  files: string[];
  link: "observed" | "inferred";    // inferred = approximate join (D11)
  evidenceLinks: { cited: number; resolved: number; approx: number };
  firstSeq: number; lastSeq: number; versions: number;   // first and latest change_unit rows
  startTs: string; endTs: string;   // unit createdAt / updatedAt
  tMs: number; endTMs: number;      // the same two times on the display clock
  stepIds: StepId[]; factSeqs: number[];
  decisionIds: DecisionStableId[]; validationIds: string[]; validationStepIds: StepId[];
  validationOnlyStepIds?: StepId[]; // validationStepIds no other join links (§6.6); absent on hand-built sessions
  clampIds: string[];
  triad: { importance?: number; relevance?: number; interruption?: number; clientKind?: JevClientKind };
  schemaChanges: SchemaChange[]; dependencyChanges: DependencyChange[];
  findingIds: FindingId[];
}

export interface Entity { id: FileStableId; kind: "file"; path: string; label: string;  // label: truncateMiddle(path, 48)
  added: number; removed: number; claimed: boolean; observed: boolean;
  stepIds: StepId[]; chapterIds: UnitStableId[] }

export interface Finding {
  id: FindingId;                    // finding:<ruleId>@<version>:<anchorSeq>
  ruleId: SignalId; ruleVersion: number; severity: "info" | "warning" | "critical";
  anchorSeq: number; anchorStepId: StepId;   // anchorStepId is one of stepIds
  headline: string; reason: string;          // plain text; UI titles come from FINDING_TITLE (§9)
  stepIds: StepId[]; chapterIds: UnitStableId[]; evidenceSeqs: number[];
  claim?: ClaimObservation;         // claim_contradicted: {claim, observed} with text, counts, seqs, tMs
  claimStepId?: StepId; evidenceStepIds?: StepId[];
  claimSpan?: [number, number];     // [start, end) in UTF-16 code units of the claim step's text
  matchedPattern?: string;          // destructive_command
  clampId?: string;                 // guardrail_clamp: the row's most severe clamp
}

export interface Gap { kind: GapKind; atSeq: number; message: string }
export interface Coverage {
  capabilities: Capability[];       // present in the folded rows, in CAPABILITIES order
  signals: { id: SignalId; active: boolean; missing: Capability[] }[];   // one per SIGNAL_IDS entry
  approximateJoins: boolean;        // any chapter joined by time window (D11 notice)
  inferredSteps: number;
}

export interface TraceSession {
  schemaVersion: 1; meta: TraceSessionSummary; live: boolean;
  loadedThroughSeq: number;
  originMs: number;                 // epoch ms of display-clock zero (§6.5)
  span: { startTs: string; endTs: string; durationMs: number };
  turns: Turn[]; steps: Step[]; chapters: Chapter[]; entities: Entity[];  // files only in v1
  findings: Finding[]; gaps: Gap[]; coverage: Coverage;
  hidden: { byType: Partial<Record<EventStoreType, number>>;   // delivered rows that make no step
            unreceived: number };   // loadedThroughSeq − rows received (§6.4)
}
```

`meta` is the source's `TraceSessionSummary` as delivered, so no model field names the source (D2, §8.7). A chapter's anchor seq, which placement and the chapter brush key on, is not a model field: `layout/trace-index.ts` derives it as the minimum over the chapter's `factSeqs` and its steps' `firstSeq`s (§7.5, §7.8). The mini-graphic spec `GraphicSpec` is also in `types.ts`; §7.12 describes it.

`model/registry.ts` holds the exhaustive registries, each typed over its key union (`{ readonly [K in …]: … }`) so a new contract variant fails typecheck until it is mapped: `KIND_META`, `ENVELOPE_RULES` over `EventStoreType` (`consume` for `TRACE_ROW_TYPES`, else `hidden`), `AGENT_EVENT_RULES` over the agent event types, `FACT_RULES` over the fact types, and `CLAMP_META` (§6.7). `SIGNALS` lives in `model/signals.ts`. The model carries no icons: `ui/icons` defines `IconName`, `KIND_ICON`, `LANE_ICON`, `CATEGORY_ICON` and `SIGNAL_ICON`, each with `satisfies Record<…, IconName>`, so a new kind still fails typecheck until it has an icon (UI index §1.6).

```ts
export const KIND_META: { readonly [K in StepKind]: { lane: Lane; actor: Actor; label: string } } = {
  instruction: { lane: "supervisor", actor: "supervisor", label: "Instruction" },
  approval:    { lane: "supervisor", actor: "agent",      label: "Approval request" },
  decision:    { lane: "supervisor", actor: "jevcode",    label: "Decision" },
  message:     { lane: "agent",      actor: "agent",      label: "Message" },
  reasoning:   { lane: "agent",      actor: "agent",      label: "Reasoning" },
  tool:        { lane: "agent",      actor: "agent",      label: "Tool call" },
  lifecycle:   { lane: "agent",      actor: "agent",      label: "Session event" },
  command:     { lane: "commands",   actor: "agent",      label: "Command" },
  edit:        { lane: "edits",      actor: "agent",      label: "Edit" },       // a repo-observed edit step has actor repo
  read:        { lane: "edits",      actor: "agent",      label: "Read" },
  dependency:  { lane: "edits",      actor: "repo",       label: "Dependency change" },
  revert:      { lane: "edits",      actor: "repo",       label: "Revert" },
  test:        { lane: "tests",      actor: "agent",      label: "Test run" },
  check:       { lane: "tests",      actor: "agent",      label: "Check" },
  guardrail:   { lane: "jev",        actor: "jevcode",    label: "Guardrail" },
  attention:   { lane: "jev",        actor: "jevcode",    label: "Attention" },
};
// ui/icons/kind-icons.ts
export const KIND_ICON = {
  instruction: "person", message: "bubble", reasoning: "thought", command: "term", test: "test",
  check: "gauge", edit: "edit", read: "eye", tool: "plug", approval: "key", decision: "fork",
  dependency: "pkg", revert: "undo", lifecycle: "flag", guardrail: "shield", attention: "jev",
} as const satisfies Record<StepKind, IconName>;
```

`registry.test.ts` asserts the lane column literally (UI index §1.4 B-2; the C1b session builder copies the same table). `CATEGORY_ICON` gives chapters their icon: schema → `table`, tests → `test`, dependency → `pkg`, architecture and api → `route`, security → `shield`; behavior, configuration, performance, implementation and documentation → `list`.

### 6.3 Stable ids (R9)

| Id | Assigned to | Stability |
|---|---|---|
| `step:<firstSeq>` | Every step, decision steps included | A step's first row never changes; appends only add seqs |
| `unit:<changeUnitId>` | Chapters | Unit ids hash the file list and can change when a file joins (clustering.ts:441); canvas placement, the chapter brush and chapter spine rows key by anchor seq (§7.5, §7.8), and the store remaps a stale selection (§7.8) |
| `decision:<decisionId>` | Resolves to its decision step through `resolveStableId` (B-10) | Decision ids are stable across status rows, and the decision step keeps `step:<firstSeq>` |
| `file:<path>` | Entities | Paths as recorded |
| `finding:<ruleId>@<version>:<anchorSeq>` | Findings | One finding per rule per anchor step; a Jev row with several clamps is one finding, whose `clampId` names the most severe |

Selection holds only `step:` and `unit:` ids (`SelectionId = StepId | UnitStableId`, UI index §2.1). A location's `selected` accepts any stable id and is resolved to a `SelectionId` on load (C2-3); a `decision:` id resolves to its decision step, so every surface keys a decision by its step id.

### 6.4 Fold API and rules

```ts
export function createTraceState(meta: TraceSessionSummary): TraceState;
export function accumulate(state: TraceState, row: TraceRow): TraceState;   // mutates, returns state
export function accumulateAll(state: TraceState, rows: readonly TraceRow[]): TraceState;
export interface FinalizeOptions {
  live: boolean;
  state?: AgentState;       // the latest TraceRowsPage.state; overrides meta.state
  throughSeq?: number;      // cursorAfter(lastPage); raises loadedThroughSeq past filtered rows
  nowMs?: number;           // source.now(); an open step's duration while live
}
export function finalize(state: TraceState, options: FinalizeOptions): TraceSession;  // never mutates state
export function foldRows(meta: TraceSessionSummary, rows: readonly TraceRow[],
  options: FinalizeOptions): TraceSession;
```

The source's summary is the whole `meta`, and the latest page's facts arrive as `state` and `throughSeq`; the host passes `live: !terminal(state)` (§7.10) and `nowMs: source.now()`. This replaces the earlier `createTraceState({summary, redactionCount})` and `finalize(…, {page})`, because the summary already carries the session, repository, prompt, times and `lastEventSeq`, and no viewer surface reads a bundle's `redactionCount` (the parity test redacts the IPC rows instead, §8.7).

```
accumulate(state, row):
  if row.seq was already folded: return state                      # repeat, skipped silently
  if row.seq < state.maxSeq: gap(out_of_order, row.seq); return state
  record row.seq (received += 1); state.maxSeq = row.seq
  if row.type ∉ EVENT_TYPES: gap(unknown_row_type, row.seq); return state
  if row.type ∉ TRACE_ROW_TYPES: hidden.byType[row.type]++; return state
  parsed = SCHEMA[row.type].safeParse(row.payload)
  if !parsed.success: gap(invalid_row, message = first issue path); return state
  advance the clock (§6.5); apply the row's fold-* handler (state, parsed, row)
  return state

finalize(fold, {live, state: pageState, throughSeq, nowMs}):
  loadedThroughSeq = max(last folded seq, throughSeq); meta.state = pageState ?? meta.state
  derive pairing closures, chapters, claims, problems, noise, findings, coverage, entities
  sort every list by (seq, id); never mutate fold
```

- `accumulate` mutates in place, because copying per row at 75k rows is wasteful. The parity test proves a whole fold equals any batch split and any intermediate `finalize` (§11), and a session already returned never changes when later rows arrive.
- With `live`, open steps read `running` with `durationMs = nowMs − startMs`, and the open turn raises no `missing_evidence`.
- Live input must be stored rows with a seq; `agent:event` pushes carry none (contracts/src/ipc.ts:44).
- `hidden.unreceived = loadedThroughSeq − received`: the rows the source filtered out, exact because seq is gapless. `hidden.byType` counts delivered rows that make no step; the reader and bundles deliver only `TRACE_ROW_TYPES`, so it is empty in v1. The Outline footer shows their sum.

### 6.5 Clock

Only `agent_event.ts` and `evidence_fact.ts` payload times advance the session clock. `change_unit`, `decision`, `validation` and `jev_decision` rows take the clock of the latest preceding clock row, because their times are pipeline processing times: in `replay.db` the row `ts`, `sessions.startedAt` and Jev times are the replay run's wall clock, days after the fixture's source times. `Decision.ts` (M1c) is shown in the Inspector as the transition time and never moves the clock.

- `originMs` (`TraceSession.originMs`) is the first clock row's source time; `Date.parse(meta.startedAt)` is the fallback when no clock row exists. This refines R25's `ts − startedAt`: `sessions.startedAt` is the replay run's wall clock in replay.db, days after the fixture source times (so `ts − startedAt` would clamp every fixture step to 0), and repo-open time in live sessions, so the display origin is the first clock row.
- `Step.startMs` is the first row's source time; for a step that starts on a non-clock row (a decision, a Jev call) it is `originMs` plus the inherited clock. `Step.tMs = max(startMs − originMs, tMs of the previous step in seq order, 0)`.
- `durationMs` is `complete.ts − start.ts` for paired steps, `nowMs − startMs` for an open step when `live` is true, and `null` for single-row steps and every other unpaired step; approval waits follow §6.6. `nowMs` comes from the source (`TraceSource.now()`, §7.7) through `FinalizeOptions.nowMs`.
- A chapter's `tMs` and `endTMs` put the unit's `createdAt` and `updatedAt` on the display clock. Clustering takes both from the first and last grouped event times (clustering.ts:910-911), so they are source times, unlike the `change_unit` row's `ts`.

### 6.6 Derivations (R10)

**Rows to steps.**

| Row | Step |
|---|---|
| `agent_started` | Opens a turn; an `instruction` step (actor supervisor) with the prompt, unless deduped (below) |
| `agent_message {role: "user"}` | `instruction` (a steer), unless absorbed into a decision or deduped (below) |
| `agent_message {role: "assistant"}` | `message` |
| `agent_reasoning` | `reasoning`, rendered muted and never merged with messages |
| `tool_*`, `command_*` | `tool` or `command`, paired (below) |
| `test_started` / `test_completed` (fixtures only) | Join the open command step with the same normalized command; the step becomes `test` |
| `file_read` | `read` (noise); a read-only tool call (`READ_TOOL`: read, view, list, search, grep, glob, find, ls, cat) is `read` noise too |
| agent `file_changed` | `edit`, a claim (actor agent) |
| `approval_requested` | `approval` (supervisor lane: it hands work to the human); its wait ends at the next agent event in the same turn, or at the turn's end, and `durationMs` is that span |
| `agent_waiting` | `lifecycle` (noise) |
| `agent_completed` / `agent_failed` / `agent_interrupted` | `lifecycle`; closes the turn; `agent_failed` sets status failed and problem `agent_failed`; an interrupt reads "Interrupted · steer" in neutral ink |
| `command_executed`, `test_result` | Attach to a command step (below) |
| `git_hunk`, evidence `file_changed`, `symbol_delta` | Observations joined to an edit step (below) |
| `dependency_change`, `revert_detected` | `dependency`, `revert` |
| `decision` | One `decision` step per decision id (`step:<firstSeq>`, `target` = the decision id; `decision:<id>` resolves to it); the first row opens it, the answered, delegated or expired row closes it |
| `validation` | Attaches to the latest step before it with the same normalized command |
| `change_unit` | A chapter version; the latest version per unit id wins |
| `jev_decision` | A `guardrail` step when the row has clamps, else an `attention` step with `pipeline` noise. A guardrail step with a warning or critical clamp (`CLAMP_META`, §6.7) anchors a `guardrail_clamp` finding, and only one with a critical (blocking) clamp also carries the `guardrail` problem, so a warning clamp is never red (§7.12); one whose clamps are all info anchors none and is `pipeline` noise |

**Pairing.** Starts and completions pair by `callId`. Without one, pairing is FIFO by family (command, tool, test) and target within the turn, and the step is `provenance: "inferred"`. At a turn boundary, still-open steps become `unknown` and add an `unpaired` gap (in live mode the last turn's open steps stay `running`). Exit 0 reads `ok`, exit > 0 `failed` with `exit_nonzero`, exit −1 `unknown`.

**Evidence attach.** `command_executed` and `test_result` attach to the step whose `callId` equals their `sourceCallId`; otherwise to the turn's latest step with the same normalized command. A `test_result` makes the step `test`. A command whose `normalizeCommand(cmd)` matches `CHECK_COMMAND` (`model/registry.ts`, B-2), or a validation of kind typecheck, lint or build, makes it `check`:

```ts
const PM_FLAGS = String.raw`(?:\s+(?:-r|--recursive|-w|--workspace-root|(?:-F|--filter|--workspace)(?:=|\s+)\S+))*`;
export const CHECK_COMMAND = new RegExp(
  String.raw`^(?:npx\s+|(?:pnpm|npm|yarn)${PM_FLAGS}\s+(?:(?:run|exec)\s+)?)?(?:tsc|eslint|vite build)\b` +
  String.raw`|^(?:pnpm|npm|yarn)${PM_FLAGS}\s+(?:run\s+)?(?:typecheck|lint|build)\b`);
```

It matches only at the head of the normalized command: `tsc`, `eslint` or `vite build`, bare, through `npx`, or through pnpm, npm or yarn (optionally with `run` or `exec`); or a pnpm, npm or yarn `typecheck`, `lint` or `build` script after the workspace flags `-r`, `-w`, `--filter x`, `--filter=x`, `-F x` or `--workspace x`. `commandKind` normalizes before it matches and tries the check pattern before the test pattern. The anchor matters: an unanchored `\bbuild\b` would make `ls build` or `grep -r build src` (exit 1 on no match) a failed check, which paints red and can contradict a claim, and would make `pnpm add eslint` or `git commit -m 'fix lint'` checks. `pnpm test -- --grep build` is a test. `cd x && pnpm build`, `npm run -w x build`, `yarn workspace x build`, `cargo build`, `go build` and `make build` are plain commands in v1.

**Claims and observations.** An agent `file_changed` is a claim and opens an edit step. A repo observation (`file_changed`, `git_hunk`, `symbol_delta`) for path P joins that path's latest edit step in the turn and sets `edit.observed`; with none, it opens a repo edit step (actor repo). A `git_hunk` with new content (a new `diff.hash`, or without a diff new `added`/`removed`) for a P whose latest edit step already holds a hunk opens a new edit step: each new hunk is a new observed state of the file, which is what `recovery_arc` needs between a failing and a passing run. This replaces the earlier rule "a new step after the turn's latest test or check", because the git collector polls every 5 s: a claim whose poll landed after a quick test stayed unobserved and raised a false `missing_evidence`. A `git_hunk` equal to the previous one for P (pre-M1b sessions re-emit every poll) becomes its own edit step with noise `duplicate_poll`, so the step that holds the real change keeps a truthful `lastSeq`; `recovery_arc` ignores it. In a closed turn, a claim with no observation adds a `missing_evidence` gap and reads `unknown`; a finished test command with no `test_result` adds the gap too and keeps the status its exit gives (§11 M3: without its `test_result`, oauth's run stays failed with exit 1). `edit.lockfile` is true when any joined `git_hunk` has `isLockfile: true`; `edit.formattingOnly` is true when the step has at least one joined `git_hunk` and every one has `isFormattingOnly: true`; an edit with no observation has both false.

**Decision answers.** A `role: "user"` `agent_message` is absorbed into decision D when the next decision row after it is D's answered or delegated row and no other user message lies between them (oauth line 38 between rows 37 and 39, emitted by `sendDecision`, codex-adapter.ts:241-255). The provisional instruction step is removed, its seq joins the decision step and becomes `decision.answerSeq`, and the decision step keeps its `step:<firstSeq>` id, so the supervisor lane and the spine show the answer once. The decision's wait ends at the row that closes it: the absorbed answer message's time when `answerSeq` is set, else the answered, delegated or expired row's inherited clock. Later rows with the same decision id (the Jev projection pass re-emits answered decisions at the end of a replay) join the step's `seqs` and refresh its detail but never move `endTMs` or `durationMs`. A user message that no answer follows stays an instruction step.

**Instruction dedupe.** `sendInstruction` and `sendDecision` emit a user `agent_message` whose text is also the relaunch's `agent_started.prompt` (codex-adapter.ts:222-253, :413-441): after the relaunch for a steer, before it for a queued instruction delivered on resume. B-12 folds each case to one step:

- **Steer.** A `role: "user"` `agent_message` whose trimmed text equals the prompt of the `agent_started` just before it, with no other agent event between them, joins that relaunch's instruction step. The step keeps the relaunch as `firstSeq`, and its `seqs` hold both rows.
- **Queued instruction.** An `agent_started` whose trimmed prompt equals an earlier undelivered user message opens no instruction step. Its seq joins that message's step, which stays in the earlier turn's `stepIds`.
- **Decision relaunch.** A relaunch that delivers a decision answer ends with no instruction step, whichever row arrives first. When the answer row lands after the relaunch, the relaunch's step (relaunch and echo) is absorbed into the decision step and `answerSeq` names the echoed message. When the answer row came first, the relaunch's seq joins the decision step. Either way `Turn.prompt` is the decision title.

In every case a started turn's instruction item is the step whose `seqs` include `turn.startSeq`. That step is not in the turn's `stepIds` when a queued instruction or a decision relaunch opened the turn, so the Outline's Intent row and Canvas's instruction story item read it through `startSeq` (§7.1, §7.5). Absorption and dedupe happen in `accumulate`, so every batch split still folds to the same session (§6.4).

**Turns.** Turns split on `agent_started`. Trigger: `initial` for turn 0; `steer` when the previous turn ended with `agent_interrupted {reason: "steer"}`, or with no terminal event and no answered decision; `resume` otherwise. Earlier drafts applied the no-terminal case only to turns without `turnId`; the plan drops that condition because M1a writes a terminal event for every interrupt, steer and stop, so it changes only the label of a turn whose process vanished without one, and its outcome stays `interrupted` either way. Outcome: `completed`, `failed` or `interrupted` from the turn's last terminal event (`interruptReason` from `agent_interrupted`). A turn closed by the next `agent_started` without a terminal event is `waiting` when a decision was answered in it and `interrupted` otherwise. The last turn takes the first outcome that applies: its terminal event's outcome; `waiting` while live when its last agent event is `agent_waiting` or an open `approval_requested`; `running` while live; else `unknown`.

**Plan and claim.** `markTurns` (B-12) sets both before signals run. `Turn.planStepId` is the first assistant message that precedes the turn's first edit step (any assistant message when the turn has no edit) and either matches `/^\s*plan\b/i` or contains at least two lines matching `/^\s*(?:[-*•]|\d+[.)])\s+\S/m` (oauth line 8 matches through `Plan:`). `Turn.claimStepId` is the turn's last claim (below). Only `Turn.claimStepId` is evaluated for `claim_contradicted`, so a turn yields at most one such finding.

**Chapters.** For each unit id, the latest version defines the chapter; `current` is false when that version is `superseded`.

```
join(unit):
  cited    = unit.evidence filtered to "fact_" ids
  resolved = cited ∩ { row.factId }                        # factId from trace-service
  calls    = unit.agentCallIds ∩ { step.callId }
  steps    = steps holding a resolved fact seq ∪ steps whose callId ∈ calls
             ∪ the unit's validation, decision and Jev steps   # joined by plain id; never decide the link
  if cited = ∅ and unit.agentCallIds is empty: link = observed  # e.g. a failure-only unit
  elif resolved ≠ ∅ or calls ≠ ∅:             link = observed
  else:                                                       # pre-M1 units (D11)
    for each file f in unit.files:
      w = edit steps on f with Date.parse(startTs) ∈ [createdAt − 5 s, updatedAt + 5 s]
      steps ∪= w, or, when w is empty, f's latest edit step at or before updatedAt + 5 s
    link = inferred                                           # APPROX_WINDOW_SLACK_MS = 5_000
  evidenceLinks = {cited: |cited|, resolved: |resolved|, approx: |steps added by the window rule|}
```

The 5 s slack on both ends is the git poll interval: a file's observation can land up to one poll away from the unit's first or last event. The latest-earlier-edit fallback covers a file whose window holds no edit, such as a decision-born unit whose events start at the decision (oauth's linking unit), which the strict window joined to nothing. A unit that cites no `fact_` id and no call id (api-break's stale-test unit cites only `fail_…` and `val_…` ids) has no content-hash join to lose, so it stays `observed` and gets only its plain-id steps.

`validationStepIds` are the steps that `unit.validationResults` validations attached to, in seq order; `validationOnlyStepIds` are those of them that no fact, call-id, decision, Jev or time-window join also links to the chapter (the overview band footprint skips them, §7.6.1). `decisionIds` come from `relatedDecisions` and `Decision.affectedChangeUnits`. `clampIds` come from the unit's guardrail steps. A `jev_decision` row is Pass A when `pass === "A"`, or, with no `pass`, when `output` parses with `AttentionDecisionSchema` (contracts/src/jev.ts:8) or has `guardrailSuppression: true` (jev-stage.ts:151-155); it is Pass B when `pass === "B"` or `output` parses with `UIIntentSchema`. `triad` takes importance, relevance and interruption from the latest Pass A row that parses with `AttentionDecisionSchema`, else from the ChangeUnit's own fields (semantic.ts:180-182); `triad.clientKind` comes from that row. `noise` is true when the chapter joins at least one edit (duplicate polls aside) and every joined edit is a lockfile or formatting-only change, or when the latest Pass A row's `shouldSurface` is false (`ChapterState.surfaceByUnit`); `applySignals` clears it on a chapter a finding names.

**Short titles.** `Chapter.shortTitle` (`model/short-title.ts`, `chapterShortTitle`) is at most 24 graphemes, for the Outline, overview band labels and Canvas frames. Replay runs no LLM titler, so semantic-core's `buildPlaceholderTitle` ("Changed N file(s): a, b, c", or "Changed 0 files") reaches the bundle as the unit title and names nothing a band can fit. For such a placeholder the short title is the category noun (schema `Migration`, dependency `Package`, tests `Tests`, implementation `Code`, configuration `Config`, documentation `Docs`, api `API`, and the capitalised category otherwise), then ` · ` and the focus file's stem: the focus file is the unit's first file that is not a lockfile, and the stem is its basename up to the first dot without a leading sequence number or migration verb (`migrations/001_create_identities.sql` → `Migration · identities`, `tests/auth/oauth.test.ts` → `Tests · oauth`). A unit of lockfiles only is `Lockfile`; a dependency unit or one without files is the noun alone (`Package`). Any other title is cut to its first clause (at `: `, `; `, `. `, `, `, ` (` or a spaced dash, once the clause has 8 characters) and clipped at a word with `…`. The model keeps `title` unchanged; semantic-core is not touched (orchestrator ruling M2, 2026-09-30). The overview's `BandSpan.title` uses `shortTitle ?? title`.

`pickGraphic` derives the TableGlyph spec (§7.12) from `Chapter.schemaChanges`, one entry per table: a `schemaChanges` item with `entityType` `table` or `model` names one (`name = entity`), and so does the prefix before `.` of a `column` or `field` item. `role` is `new` when a table or model item has `change: "added"`, else `altered`; `columns` counts its column and field items. Clustering emits `schemaChanges: []` today (clustering.ts:926), so v1 schema chapters render the DiffBar list and the mapping is tested with synthetic units only.

**Claim versus evidence.** The claim lexicon lives in `model/signals.ts` (`matchSuccessClaim`, B-12; `isSuccessClaim` is `matchSuccessClaim(text) !== null`). It matches per clause (text between `.`, `;`, `!`, `?` and line breaks), case-insensitively:

- success phrases, anywhere in a clause: `/\b(?:all (?:tests|checks)(?: are)? (?:pass(?:ing|ed)?|green)|(?:tests?|checks?|suite|build) (?:pass(?:es|ed)?|(?:is |are )?passing|(?:is |are )?green)|passing tests|everything (?:works|passes|is green)|all green)\b/`;
- completion words, only at the end of a clause: `/\b(?:complete|completed|done|finished)\s*$/`, so "OAuth implementation complete" and "The migration is done." are claims and "I'm done reading the file, next I will complete the setup." is not.

A match is negated when the clause before it contains `not`, `never`, `no`, `none`, `cannot`, `without` or a word ending in `n't`, or when the clause after it starts with `except`, `but`, `apart from` or `other than`. A claim is an assistant message with a non-negated match. `claimSpan` is the first non-negated success phrase as [start, end) in UTF-16 code units of `Step.text`, else the first non-negated clause-final completion word; the model keeps the full text, so the span always lies inside it. This lexicon replaces the earlier token-window draft: clause-scoped negation covers "Tests pass except the flaky one", completion words catch the common "X complete" claim, and B-7's lexicon table pins both ("Not all tests pass yet.", "I haven't finished the migration." and "The migration is not complete." are not claims). A bare "verified" is not a claim.

Only `Turn.claimStepId` is checked. It is contradicted when, for any test or check target (its normalized command), that target's latest run before the claim in the session failed. `evidenceStepIds` holds the most recent of those failed runs. A later passing run of the same target clears that target. This per-target rule refines R10's "latest earlier test/check step" by an orchestrator ruling under D12 on 2026-09-28: comparing with only the single latest run misses "tests failed, then lint passed, then 'All checks pass.'", because the passing lint run hides the failed tests. The oauth and api-break expectations are the same under both rules. The session scope replaces "in the same turn", because a claim made in a resumed turn without rerunning the tests still contradicts the last evidence. A test run failed when `tests.failed > 0` or `exitCode > 0`, and a check run failed when `exitCode > 0`; exit −1 is neither. A claim with no earlier test or check step raises no finding and no gap: an unverified claim describes the agent, not missing data, and `verification_bypass` (§15) is the later signal for it.

**Problems facet.** Orthogonal to kind: `exit_nonzero` (exit > 0 on a command, test or check; −1 is unknown), `tests_failed`, `agent_failed`, `destructive` (`command.destructivePattern`), `guardrail` (a clamp of critical severity, `hasBlockingClamp`; a warning clamp still anchors its `guardrail_clamp` finding but is not a problem, because §7.12 keeps red for real problems), `claim_contradicted`.

**Status.** Command, tool, test and check steps read `ok`, `failed`, `running` or `unknown` from pairing and exit; edit, dependency and revert read `ok`, except an unobserved edit claim in a closed turn, which reads `unknown`; a decision reads `running` while open, `ok` when answered or delegated, and `unknown` when expired; `agent_failed` reads `failed`; instruction, message, reasoning, approval, read, other lifecycle, guardrail and attention steps read `info`. A step's `TraceIndex.parent` is its lowest-anchor chapter.

**Noise.** `read` (file reads and read-only tools); `lockfile`; `formatting`; `duplicate_poll`; `lifecycle` (`agent_waiting` and other agent lifecycle steps); `pipeline` (Jev pipeline rows: attention steps and guardrail steps whose clamps are all info, unknown clamp ids included; B-6 `hasSevereClamp`), which the spine labels "pipeline events" rather than "lifecycle events" because they are Jev's own processing, not the agent's session; `superseded` (edits whose chapters are all superseded); `passing_test` (a passing run that is not its command's final run; the close of a recovery arc carries a finding, so it is never noise). A step with a problem or a finding is never noise.

### 6.7 Signals (R11)

Each rule in `model/signals.ts` is a `SignalMeta` `{id, version, severity, title, rationale, knownFalsePositives[], requires[]}` plus `evaluate(input) → FindingDraft[]`. Findings are derived at read time and never persisted. They never change live attention; a finding only prevents its steps from being collapsed. Every finding does this whatever its severity, because R11 says so and W0-6's `Step.noise` is never set on a step whose `findingIds` is non-empty. A rule whose hits must not pin a step therefore creates no finding: a guardrail row whose clamps are all info raises none and its step is `pipeline` noise (§6.6). `recovery_arc` is the only info finding v1 creates, and it keeps its arc uncollapsed; a severity-based pin rule would need W0-6 and R11 changed. `coverage.signals` marks a signal inactive when a required capability is absent from `coverage.capabilities`: `agent_messages` (an assistant message), `agent_commands` (a `command_started`), `test_results` (a `test_result` fact), `jev_decisions` (a `jev_decision` row). `call_ids` and `fact_links` describe capture quality; no v1 signal requires them.

| Signal (v1) | Severity | Rule | Requires | Known false positives | Rationale |
|---|---|---|---|---|---|
| `claim_contradicted` | critical | §6.6 claim versus evidence, per target; anchor = the claim step; `evidenceStepIds` = the most recent test or check run that is its target's latest run before the claim and failed; `evidenceSeqs` = that run's `test_result` seq (`tests.resultSeq`, else its first seq) and the claim seq | agent_messages, test_results | A claim about a subset of tests; a failed run of a target the claim does not cover, such as a failed lint under "all tests pass"; before M1a, reasoning is merged into assistant text (jsonl.ts:178-189), so a thought can read as a claim | The supervisor's core question: did the agent say it worked when the repo says it did not |
| `failing_tests` | warning; critical when the same normalized command's final run in the loaded rows also failed (a later passing live run lowers it to warning; the finding id is unchanged) | A test step with `failed > 0`; anchor seq = its `test_result` seq | test_results | Any runner-like stdout is parsed as test output (pipeline-runtime.ts:750-753), e.g. `cat test.log` | Failures the agent moved past, or never fixed |
| `destructive_command` | critical | `matchDestructive(command)` (contracts/src/security.ts:32-37) on a command step; `matchedPattern` = the pattern name | agent_commands | SQL verbs match anywhere (`grep -rn "DELETE FROM"`, security.ts:21-23); every `rm -rf` matches, including `rm -rf node_modules` | Irreversible actions need a second look |
| `guardrail_clamp` | the maximum over the row's clamps per `CLAMP_META`: `destructive_command` critical; `security_path`, `schema_floor`, `public_api`, `failed_unit_relevance`, `failed_unit_attention` warning; all others and unknown ids (such as `"guardrail.security"`, storage/src/fixtures.ts:91) info | One finding per guardrail step (`jev_decision` row) with a warning or critical clamp; a row whose clamps are all info, unknown ids included, raises none | jev_decisions | Before M1c, suppression rows log `degrade` at 1.0 (jev-stage.ts:146-160); `/token/i` matches `tokenizer.ts` and `\.env` matches `.env.example` (jev-router/src/patterns.ts:11-19) | Shows where a deterministic rule overrode the model |
| `recovery_arc` | info | Target T fails, at least one edit that is not a duplicate poll follows, then a later run of T passes; anchor = the passing run | test_results | The pass came from deleting or skipping tests | Shows how a failure was resolved |

`failing_tests` follows R11's wording ("critical if target's final run failed"): a failing run followed by another failing run is critical for both, because the failure was never fixed.

**Finding chapters.** A finding about a test or check run (`claim_contradicted` through its evidence run, `failing_tests`, and `recovery_arc` through its failed run, or its passing run when the failed run has no chapter) names only the run's chapters that own the failure: those whose unit `status` is `failed` or whose `files` hold a failing test's `file` (equal, or one path ends with the other at a `/`), else the latest of the run's chapters in session order. One validation is often cited by every unit (all seven oauth units cite the one `pnpm test` validation), so the run joins every chapter (§6.6 join, unchanged); naming all of them would mark every chapter with the finding and, through `applySignals`, clear `noise` on lockfile and formatting chapters. This refines the earlier "the run's `chapterIds`" by an orchestrator ruling (M1, 2026-09-30).

```ts
export const CLAMP_META: Readonly<Record<string, { label: string; severity: Severity }>> = {
  destructive_command: { label: "Destructive command", severity: "critical" },   // mirrors jev-router/src/guardrails.ts:76-256
  // warning: security_path, schema_floor, public_api, failed_unit_relevance, failed_unit_attention
  // info: suppress_formatting, suppress_lockfile, suppress_passing_tests, interrupt_floor,
  //   decision_presence_floor, noise_triad_cap_formatting, noise_triad_cap_lockfile,
  //   required_decision_attention, attention_sanitize
};
export function clampMeta(id: string): { label: string; severity: Severity };   // unknown id → {label: id, severity: "info"}
```

A finding's severity is the maximum over its clamp ids, `clampId` names that clamp, and `reason` lists every clamp's label. A row whose clamps are all info creates no finding and leaves its guardrail step as `pipeline` noise, because `suppress_formatting` and `suppress_lockfile` fire on routine units and would otherwise add a finding stop to `n`/`N` and keep the step uncollapsed; its clamps still show in the chapter's Guardrails. `registry.test.ts` checks `CLAMP_META` against the 15 clamp ids pushed in guardrails.ts, because the model cannot import jev-router.

`FINDING_ORDER` is `compareFindings` with `FINDING_RULE_RANK` (model/signals.ts, UI index §1.4 B-7): severity (critical > warning > info), then rule rank (`claim_contradicted` 0, `destructive_command` 1, `failing_tests` 2, `guardrail_clamp` 3, `recovery_arc` 4), then anchor seq ascending, then id. It picks the initial selection (§7.8) and the finding a spine row shows; `n`/`N` still step in seq order. This refines R23's "earliest most-severe finding" with a rule rank inside each severity: on oauth, `failing_tests` is also critical (its only `pnpm test` run is the final one) and earlier, so the rule rank is what selects the contradiction.

Later signals: `test_weakened` and `verification_bypass` (§15). The Inspector's "Why flagged?" shows the rationale, the matched pattern and `knownFalsePositives`. Header counts include every finding before any view state.

### 6.8 Format helpers (R12)

`model/format.ts` replaces the WorkspaceHost helpers (WorkspaceHost.tsx:97-200), and B-11 switches WorkspaceHost to them. `eventKey`, `mergeEvents` and `isConversationEvent` do not move: they dedupe by timestamp and cap at 160, and seq identity replaces them. B-11 also deletes `readable` and `shortToolName`, whose only caller is `eventSummary`; they move into `format.ts` as a private `readable` and the exported `toolLabel`, because `noUnusedLocals` would otherwise fail the desktop typecheck. Labels follow the plan's pinned strings rather than earlier examples, because B-11 puts them into the live desktop UI and one vocabulary serves both windows.

| Helper | Replaces | Behavior |
|---|---|---|
| `truncateMiddle(s, maxGraphemes)` | `shortPath` (:97-100) | Grapheme-safe via `Intl.Segmenter`; returns the input when it fits; keeps the whole basename (`head + "…/" + basename`) when it fits in `max − 2`, else a middle cut around `…` |
| `formatOffset(ms)` | `formatTime` (:102-106) | `+0:00`, `+0:39`, `+12:05`, `+1:02:03`; negatives clamp to `+0:00` |
| `formatClock(ts, {seconds})` | `formatTime` | Local clock time for hover; invalid `ts` → `""` |
| `formatDuration(ms)` | (new) | The only duration formatter: `850 ms`, `4.5 s`, `45 s`, `2 m 05 s`, `1 h 02 m`; `null` → `""` |
| `agentStateLabel(state)` | `statusLabel` (:185-200) | WorkspaceHost's strings: `Starting`, `Working`, `Needs your decision`, `Paused`, `Completed`, `Stopped with an error` |
| `agentEventLabel(event)` | `eventSummary` (:108-139) | `eventSummary`'s strings, except `agent_completed` → "Turn ended", `agent_reasoning` → "Thinking", `agent_interrupted` → "Paused", "Redirected" or "Stopped", and exit −1, which never reads failed: `command_completed` → "`<cmd>` finished (exit code unknown)", `test_completed` → "`<cmd>` finished" (R2) |
| `stepHeadline(input)` | (new) | One line per kind; tests carry counts (`pnpm test · 14/15`); commands are middle-truncated |
| `normalizeCommand(cmd)` | (new) | Trim, unwrap one `bash -lc '…'` or `zsh -lc '…'`, collapse whitespace; command headlines show the unwrapped command |
| `exitLabel(code)` | (new) | `exit 0`, `exit 1`, `exit unknown` for −1, `""` for `null` |
| `pickGraphic(chapter \| step, session)` / `describeGraphic(spec)` | (new) | §7.12 |
| `displayUntrusted(s, {multiline?})` | (new) | Replaces U+202A–U+202E, U+2066–U+2069, U+200E, U+200F and C0 controls (other than `\t`, and `\n` in multi-line slots) with a visible `⟨U+XXXX⟩` token; `stepHeadline`, `truncateMiddle` and every mono slot (commands, paths, output tails) call it, so bidi overrides cannot reorder a command the supervisor reads |

Tone is a UI rule and lives in `layout/tone.ts` (C1-10), not in `format.ts`, because W1's overview index and spine rows need it before lane B merges and it reads only W0 fields: `stepTone` is `bad` for failed test and check steps, `agent_failed`, a `guardrail` problem (a critical clamp only) and a step anchoring a critical finding, `good` for a passed test or check, else `neutral`; `findingTone` and `worstSeverity` complete it. A plain command with exit > 0 stays neutral with a ✕ glyph and "exit 1", because exits such as `grep`'s 1 are not problems by themselves (D8). Search (`buildSearchIndex`, `searchSteps`: every lower-cased term must match headline, target, the first 8 KiB of text, command, edit path or failing test names; no stdout) and `resolveStableId` are in `search.ts` and `lookup.ts` (B-10).

### 6.9 Approximate joins for pre-M1 sessions (D11)

A chapter that cites `fact_` ids or call ids, none of which resolve, uses the time-window join (§6.6) and gets `link: "inferred"`. `coverage.approximateJoins` is true when any chapter does, and the title bar then shows `≈ Approximate joins`; its popover explains the window rule (an edit to one of the unit's files within 5 s of the unit's `createdAt`–`updatedAt` span, else that file's latest earlier edit). Pairing falls back to FIFO with `provenance: "inferred"` (`coverage.inferredSteps` counts them), and exit −1 reads unknown. No legacy-id resolver ships.

### 6.10 Budgets

Benchmarks, not CI gates (`pnpm --filter @jevcode/trace-viewer bench`, printed as `fold 75k rows` and `append 1 row`): a full fold of a seeded 75,000-row synthetic session from `src/test-support/synthetic-rows.ts` (B-9; shared with the parity property) in ≤ 500 ms, and one appended row (`accumulate` + `finalize`) in ≤ 2 ms on a state already holding that stream. A full default soak now yields about 111k trace rows (§5.6), so the M4a soak full-load budget (§10) folds about 1.5 times the benchmark stream; the fold budget stays as R8 fixed it, and §16 risk 11 tracks the gap.

## 7. Viewer UI (M4a, M4b)

### 7.1 Shell

```
┌ TitleBar 40 px ───────────────────────────────────────────────────────────────────────┐
│ repo / prompt…  [≈ Approximate joins] [3 gaps]   [Canvas | Hybrid] [Review | Live] 12 new │
│                                                     45 s · Working        Chapter ▾       │
├ Outline 216 ─────┬──────────── main: view slot ─────────────┬ Inspector 280 ─────────────┤
│ search /         │ <Activity canvas> <Activity hybrid>        │ header                     │
│ Story tree       │ view-owned toolbar, minimap                │ Summary | Evidence | Raw   │
│ Files, Commands, │                                            │ …                          │
│ Tests            │                                            │ [Request changes] [Diff]   │
│ N rows hidden    │                                            │                            │
└──────────────────┴────────────────────────────────────────────┴────────────────────────────┘
```

**Grid.** `grid-template: 40px 1fr / 216px minmax(0, 1fr) 280px`; under a 1180 px container the sides become 200 and 248 px. Landmarks: `header` (title bar), `nav` (Outline), `main` (view slot), `aside` (Inspector). The Outline and the Inspector sit outside the `<Activity>` boundaries, so one instance serves both views.

**Title bar.** Session title `repoName / prompt` (one line, full prompt in the tooltip); data-quality chips, shown only when non-zero and never red; view switch `role="radiogroup"` with `1`/`2` hints; Review | Live (Live disabled and labelled with the terminal state once ended); the "N new" pill; duration and state; the zoom menu of the active view (Canvas `100%`, Hybrid `Chapter`). Duration is the display-clock span `max over steps of (tMs + (durationMs ?? 0))`, never `endedAt − startedAt` (replay times are wall clock, §6.5); while running it is `source.now() − originMs`, ticking at 1 Hz.

**Outline.** One panel replaces the mockups' Layers and Chapters rails.

| Section | Rows |
|---|---|
| Header | "Outline" and a search field (`/`) |
| Story | Turn rows only when there is more than one turn ("Turn 2 · steer"); under each: Intent, chapters and decisions in time order, a dim "Noise n" row, Final claim. The Intent is the step whose `seqs` include the turn's `startSeq` (§6.6 "Instruction dedupe"); when that step is a decision, it shows once, as the decision row |
| Files | Path (mono, middle-truncated), guardrail shield, `DiffBar xs`; collapsed above 12 files |
| Commands | Normalized command and a status glyph (✕ for failed, never only a dot) |
| Tests | Test runs with `TestDots xs`; collapsed by default |
| Footer | "N pipeline rows hidden" (`hidden.unreceived` plus the `hidden.byType` counts, §6.4) |

Rows show icon, title, at most one flag glyph (shield, `≠`, ✕) and a trailing offset. `aria-selected` marks the selection; `aria-current` marks the chapter under the playhead. Entity rows are shortcuts: a Files row selects that file's latest edit step and opens Evidence at its diff; Commands and Tests rows select their step. Search matches step headlines, targets, paths and chapter titles, case-insensitive with all terms required; matches are marked in both views and in the overview, never hidden. The tree is flattened and virtualized.

**Inspector.** Header: kind tile, a finding-first title ("Claim contradicts tests", not "Final claim") and a meta line (offset, duration, mono command). Tabs:

- **Summary** (default). Per selection kind: the finding body (§7.6.3) first, then kind details. Test: `TestDots md`, counts, up to three failures with the message verbatim in mono ("expected null to be 7"), command, duration, exit. Command: exit, `DurationBar`, output tail. Edit: path, `DiffBar md`, "Agent reported · Repo shows +17 −0". Chapter: category graphic, files, validations, decisions, Attention (importance, relevance, interruption as bars with numbers, labelled with the Jev client kind), Guardrails (clamp labels from `CLAMP_META`), "4 of 6 evidence links resolve · 2 approximated". Decision: `ForkGlyph md`, options, answer, wait duration, affected chapters. Message, reasoning, instruction: the text, plain, with the claim span underlined. A "Related" list follows (claim ↔ evidence, chapter ↔ decisions and validations).
- **Evidence.** Per selection: edit → ui-catalog `CodeDiff` (`"./components/*"` subpath) of its `diffSeq`; chapter → one CodeDiff per file from that file's latest edit step; command, test or check → full stdout and stderr of the completion row via `trace:payloads`, with the clipping label; decision → options with descriptions and the answer; anything else → "No evidence for this item". Diff labels: "Diff withheld: secret path", "Not captured", "Truncated at hunk boundary · showing 32 KB of 410 KB" and "2 secrets redacted". Diffs render neutral (§7.12).
- **Raw.** Lazily fetched through `trace:payloads` (first 50 seqs of the selection, then "N more"), pretty-printed JSON as text, with "Clipped to head + tail (16 KiB)" where `clipped`. Raw never survives a selection change: a new selection opens on Summary, while Evidence persists.
- **Nothing selected.** Session summary: prompt, state, duration, findings by severity with an "n / N to step through" hint, coverage ("5 of 5 signals active", or which are inactive and why), and data-quality notes.

Footer: the primary action is **Request changes** when the host provides `requestChanges` (Electron), and **Copy review note** otherwise (dev host). A secondary icon button "Diff" appears when the selection has a diff. Request changes and Diff are disabled when the selection is null. Inspector scroll is keyed by selection id.

**Review note.** `Cmd/Ctrl+C` with no text selected, and the dev-host button, copy this Markdown, omitting lines with no data: line 1 `Re: trace <sessionId> <offset> "<title>" (seq <firstSeq>; evidence seq <seqs joined by ", ">)`; line 2 `Session: <repoName> / <first line of prompt>`; then `Claim:` and the claim text in a fence; then `Observed: <evidence step headlines joined by "; ">`; then `Paths: <paths joined by ", ">`. The fence is backticks one longer than the longest backtick run in the text, minimum 3. Paths, commands and headlines outside the fence are inline code delimited by a backtick run longer than any run inside them, with `\r` and `\n` shown as `⏎`, so agent-written content cannot forge the note's structure. The Request changes prefill uses line 1: `Re: trace <sessionId> +0:43 "Claim contradicts tests" (seq 48; evidence seq 46)`.

### 7.2 Views and their anatomy

**Hybrid** (default; `hybrid.html`, `hybrid-1440.png`). Top: the lane overview, 288 px tall, with chapter labels in two tiers (top 36 px), the ruler (36–58 px) with a 6 px session strip on its bottom edge, six 28 px lanes (58–226 px) labelled by icon and name in a 112 px gutter (40 px icon-only under a 1180 px container), and a floating toolbar at the bottom center (select, hand, level segmented control Session | Chapter | Step, zoom readout). Below it: the reading spine for the brushed range, starting with a range chip (`+0:30 – +0:45`).

**Canvas** (`canvas.html`, `canvas-1440.png`). A sticky 28 px time ruler with the playhead; chapter frames placed in time order in story, channel and work bands; causal edges beneath the frames; the red `≠` "contradicts" connector; noise stacks; a floating toolbar (select, hand, fit, level segmented control); a 152 × 96 minimap panel at the bottom right.

**Deviations from the approved mockups.**

| Mockup element | Build | Why |
|---|---|---|
| Comment tool, avatars | Removed | No comments in v1 (R14) |
| Hybrid: two spine rows for `pnpm test` and `vitest` | One test row: TestDots, `pnpm test`, `14/15 · 5.0 s` | The fold makes oauth lines 43-47 one test step |
| Hybrid: expected/received chips | The failure message verbatim | The chips invert vitest's order; the message is the evidence |
| Canvas: "expected 7 to be null" | "expected null to be 7" | Fixture fix (§4.3) |
| Marks dimmed outside the brush or after the playhead | Not dimmed; an `--tv-accent-soft` backdrop marks the brush | Dimmed marks fail the 3:1 contrast check (R24) |
| Canvas: Plan below Intent with a three-way fan; decision and chapter in one frame | Plan beside Intent in its own column; the fan becomes the trunk comb; decision and decision-born chapter are separate frames | Column packing (§7.5) |
| Hybrid Outline rows with mini graphics; search icon in the title bar | Story rows: offsets and one flag glyph, no mini graphic; Files rows keep `DiffBar xs` and Tests rows keep `TestDots xs`; search in the Outline header | Width at 216 px; one search location |
| Canvas: Migration frame TableGlyph (users → identities) | DiffBar list for `migrations/001_create_identities.sql` | Clustering emits `schemaChanges: []` (clustering.ts:926) |
| Request changes filled with `--accent` `#2F6BFF` | Filled with `--tv-accent-ink` `#1F5EF0` | White on `#2F6BFF` measures 4.499:1, under R24's 4.5:1 text floor; white on `#1F5EF0` is 5.36:1 |
| Canvas "Layers", Hybrid "Chapters" rails | One Outline | Same content |

### 7.3 Rendering technology (R17)

**Canvas.** One CSS-transformed world `div` holds React frames (`role="group"`, `aria-label`, roving tabindex, DOM order = time order). One edge `<svg>` sits beneath the frames; the red connector has an 8 px transparent hit twin. Labels, selection handles and the time chip live in a screen-space overlay. v1 never culls frames at any count, so each stays focusable and findable with Cmd+F; spike risk 2 measures the Step-level cost, and culling by binary search on `x0` is its fallback. Focus uses `el.focus({preventScroll: true})`, and an `onScroll` guard resets any browser scroll of the `overflow: hidden` viewport. Layers bottom to top: dot background (CSS), turn bands and break markers, edges, frames, overlay, ruler, minimap.

**Hybrid overview.** The same controller in `xOnly` mode. One DPR-scaled, `aria-hidden` Canvas2D paints bands, lane lines, ticks and binned marks, with colors read from the typed token object. The DOM holds all text, pins (buttons), the playhead and brush sliders (`role="slider"`) and the `≠` link path, at most 150 nodes.

**Viewport math** (`layout/viewport.ts`, pure). `Camera = {mode: "uniform", tx, ty, k} | {mode: "xOnly", u0, k}` with `zoomAt`, `panBy`, `fitBounds`, `setCenter`, `clamp`, `screenToWorld` and a 180 ms tween.

**Controller** (`ui/viewport/controller.ts`). A native `wheel` listener with `{passive: false}` (React's `onWheel` is passive). Ctrl or Meta with the wheel zooms at the cursor, which includes trackpad pinch: factor `2^(−deltaY · 0.02)`, clamped per event to [0.8, 1.25]. Any other wheel movement pans, with line-mode deltas × 16. Space-drag, the hand tool and middle-drag pan with pointer capture when available. One `requestAnimationFrame` write per frame goes to the world layer, the ruler and the minimap rectangle. Settle fires 150 ms after the last input: it rounds `tx`/`ty`, writes `--tv-inv-k` so edges keep `calc(1.5px * var(--tv-inv-k))`, and clears the gesture-time `will-change`. Fallback if spike risk 1 fails: `d3-zoom` 3.0.0 (already locked, pnpm-lock.yaml:1348) behind the same math interface.

**Lists.** The spine and the Outline use `@tanstack/react-virtual ^3.14.13`. On 2026-09-28 it resolved to virtual-core 3.17.11, which declares `anchorTo`, `followOnAppend`, `scrollEndThreshold` and `isAtEnd`; virtual-core 3.15.0 has none of them. W0 verifies them in the lockfile's resolved version; if they are absent, the spine hand-rolls keyed anchoring behind the same options.

### 7.4 TimeScale (R18)

```ts
// layout/time-scale.ts
export const IDLE_KNEE_MS = 10_000, IDLE_LOG_MS = 5_000, BREAK_MIN_MS = 60_000;
export const displayGapMs = (g: number) =>
  g <= IDLE_KNEE_MS ? g : IDLE_KNEE_MS + IDLE_LOG_MS * Math.log2(g / IDLE_KNEE_MS);
  // 20 s → 15 s, 60 s → 22.9 s, 5 min → 34.5 s, 1 h → 52.5 s (52,459 ms)
export interface ScaleSegment { t0: number; t1: number; u0: number; u1: number;
  idle: null | { reason: "awaiting_supervisor" | "agent_quiet"; ms: number } }
export interface TimeScale { originMs: number; endU: number; segments: readonly ScaleSegment[];
  toU(tMs: number): number; toT(u: number): number;
  breaks(u0: number, u1: number, minMs?: number): readonly ScaleSegment[] }
export function buildTimeScale(i: { originMs: number;
  work: ReadonlyArray<readonly [number, number]>;   // step spans on the display clock
  awaitingFrom: readonly number[];                  // turn ends, decisions and approvals opened
  liveTMs?: number }): TimeScale;                   // every time here is display-clock ms (Step.tMs space)
export interface XMap { xOf(tMs: number): number; tOf(x: number): number }   // monotone
```

- Work spans are `[tMs, tMs + durationMs]`. Lifecycle steps and the waiting part of decision and approval steps are not work, so a 10-minute wait for the supervisor compresses and its hollow wait bar crosses the break.
- Gaps are the complement of the union of work spans; work maps 1:1 and each gap maps through `displayGapMs`. `reason` is only a label, and equal durations get equal widths.
- `liveTMs = max(last step tMs, source.now() − originMs)`. The curve is continuous, so as `liveTMs` grows the live edge moves without jumps, and a row that closes a gap lands where the edge was.
- `BREAK_MIN_MS` drives the break glyph ("⫽ 4m idle"), the spine's idle rows and the canvas column breaks at Chapter and Step levels. The Canvas Session level uses 300 s.
- No fixture has a gap over 10 s (the largest between timestamped lines is 5.0 s: oauth lines 35→38 and rate-limit lines 21→25), so fixtures render linear and match the mockups.
- `ticks.ts` picks the smallest step of 1, 2, 5, 10, 15, 30 s, 1, 2, 5, 10, 15, 30 min or 1 h whose labels stay ≥ 64 px apart, draws no ticks inside breaks, and labels real offsets with `formatOffset`. Hybrid's `XMap` is `(toU(t) − u0) · k`; Canvas's is its column map (§7.5) over `toU`. One `Ruler` component draws any `XMap`.

### 7.5 Canvas layout

`layoutCanvas(session, index, scale, level, prev?) → CanvasLayout` in `layout/canvas-layout.ts` (it reads the shared `TraceIndex` and `TimeScale`) is pure, deterministic and sticky: a placed frame never moves while the view is open, except when the reader runs *Tidy layout* or switches level (both lay out fresh and pin the focus frame); a pure append equals a fresh layout; frame sizes depend only on `(level, kind)`. Edges route only through gutters and the channel.

**Levels** (`canvas-levels.ts`; world px at zoom 1; each slot includes a 22 px label row; `pitch = w + colGap`):

| | Session | Chapter (default) | Step |
|---|---|---|---|
| Frame `w` | 168 (chips) | 224 | 320 |
| `h` story / chapter / noise / loose | 28 / 28 / 28 / 28 | 118 / 134 / 58 / 66 | 118 / 294 (header + 9 rows × 24) / 58 / 66 |
| `storyCap` / `rMax` | 3 / 12 | 1 / 4 | 1 / 3 |
| `colGap` / `turnGap` / `breakGap` | 24 / 48 / 40 | 40 / 72 / 64 | 48 / 80 / 72 |
| `rowGap`; channel height / lanes; rail lanes per gutter | 8; 16 / 2; 1 | 16; 32 / 4; 3 | 16; 32 / 4; 3 |
| `pps` (px per display second) / `slack` | 0.5 / 32 | 8 / 64 | 8 / 64 |
| `breakMinMs` | 300 000 | 60 000 | 60 000 |
| `minZoom` / `maxZoom` | 0.25 / 2 | 0.2 / 2 | 0.2 / 2 |

Bands: `storyBand = storyCap · (h.story + rowGap) − rowGap`, the channel `[storyBand, storyBand + channelH)`, `workTop = storyBand + channelH`. Cards draw their natural height inside the slot with line clamps (intent 4 lines, claim 3); mini graphics have fixed boxes (DiffBar shows the top 4 files and `+k`, TestDots wraps at 15), so a chapter that gains files never grows.

**Items.**

```
collectItems(s):
  for turn t: story item "intent" (turn 0) or "instruction" (key turn:<startSeq>) for the step
              whose seqs include t.startSeq (§6.6), none when that step is a decision step
              (its decision item shows it), skipping a resume turn whose prompt is
              "Continue the task." (codex-adapter.ts:289);
              "plan" (plan:<seq>) if t.planStepId; "claim" (claim:<seq>) if t.claimStepId
  for decision steps: story item "decision" (decision:<id>)
  for current chapters: work item key ch:<anchorSeq>, selId unit:<id>,
              kind "noise" if chapter.noise and no step in it has a finding, else "chapter"
  for steps with a warning+ finding, no chapter and no story item: work item "loose" (step:<seq>)
  disambiguate equal keys by selId; sort by (start, anchorSeq, key)
```

An item's `start` is its step's `tMs` or its chapter's `tMs` (display clock). A chapter's placement key is `ch:<anchorSeq>` (the min fact or step seq), which survives unit-id churn; the store resolves a stale `unit:<old>` selection through the key.

**Column map.** Columns are time bins. The time map is a list of breakpoints `{t, xIn, xOut}`, one per placed frontier item; x is linear in `toU(t)` between breakpoints and continues at `pps` past the last as a tentative live edge.

```
advance(tm, t, L): last = tm.bps.at(-1)
  return last ? last.xOut + min((toU(t) − toU(last.t)) / 1000 · L.pps, L.pitch + L.slack) : 0

place(st, item, L):
  front = st.cols.at(-1)
  if front and item.start < front.t0: put(columnAt(item.start), item, late = true); return
  x   = advance(st.time, item.start, L)
  sep = item.turn ≠ front.turn ? "turn"
      : scale.breaks(toU(lastBp.t), toU(item.start), L.breakMinMs) ≠ ∅ ? "break" : null
  joinable = front and !sep and (item.kind = noise or (x < front.x + L.pitch and room(front, item)))
  col = joinable ? front : open(x, sep)          # open: cx = max(x, prev.x + w + gap(sep)); cx > x is a push
  put(col, item); st.time.bps.push({t: item.start, xIn: x, xOut: opened ? col.x : x})

put(col, item):
  noise with an existing stack in col → join the stack (count + 1)
  story item and col.story < storyCap → next story cell
  else → next work row at col.workY (a late story item drops into the work band)
```

Helpers: `rMax` is work rows per column; `room(col, it)` is `col.story.length < storyCap` for a story item, else `col.workRows < rMax`; `columnAt(t)` is the last column with `t0 ≤ t` (a late item pushes no breakpoint); `lastBp = st.time.bps.at(-1)`; `opened` is true when `open` ran. With no front column, `sep = null` and the item opens column 0 at x = 0. Late and noise placements may exceed `rMax` and increment `stats.rMaxExceeded`.

```ts
type Rect = { x: number; y: number; w: number; h: number };
export interface CanvasLayout {
  level: Level; sessionId: string;
  frames: { key: string; selId: StableId; kind: "story" | "chapter" | "noise" | "loose";
            col: number; row: number; card: Rect; label: Rect; late: boolean;
            members: string[]; memberSelIds: SelectionId[] }[];   // a noise stack is keyed stack:<first member key>
  holes: Rect[];
  columns: { key: string; x: number; t0: number; turn: number }[];
  separators: { kind: "turn" | "break"; x: number; t: number; label: string }[];
  edges: { kind: "trunk" | "contradicts" | "decides" | "validates"; from: string; to: string;
           shape: "stacked" | "adjacent" | "rail" | "channel" | "direct"; lane: number | null;
           d: string | null }[];   // null: a decides/validates edge without a lane, drawn only for the selection
  junctions: { x: number; y: number }[];   // 2.5 px dots where strokes share a port
  time: { bps: { t: number; xIn: number; xOut: number }[] };
  bounds: Rect; readingOrder: StableId[];
  stats: { late: number; rMaxExceeded: number; holes: number; hiddenEdges: number };
  state: unknown;                    // opaque; passed back as `prev`
}
```

Noise never opens a column. A new turn always opens a column with `turnGap` and a mid-gutter separator labelled in the ruler (`Turn 2 · steer · after 14 min`); a column never mixes turns. **Kind flips:** a chapter that becomes noise renders as a stack in its own slot; a noise item that becomes a chapter leaves its stack and is placed late at the bottom of its column; an emptied slot becomes a hole. When holes exist, the toolbar offers *Tidy layout*, which runs a fresh layout, pins the focus frame and animates. Reopening always lays out fresh; the location holds ids and times, never pixels.

**Edges** (`canvas-routes.ts`).

| Kind | Endpoints | Drawn at rest | Tone |
|---|---|---|---|
| `trunk` | A comb per turn on channel lane 0; story frames hang from it by their bottom center, each column's first work frame by its top center | Always | Neutral hairline `--tv-ink-4` |
| `contradicts` | Claim frame ↔ home frame of each `evidenceStepIds` step, `≠` badge at the midpoint labelled "contradicts" | Always, on reserved channel lane 1 and rail lane 0; falls back to a direct bezier with a 3 px panel halo when no lane is free | `--tv-bad` 2 px, the only red edge |
| `decides` | Decision frame → each current chapter listing the decision | When the route is `stacked`, `adjacent` or `rail` | Neutral |
| `validates` | Chapter → home frame of each validation step in another frame | Same rule | Neutral |

Shapes: `stacked` (same column, nothing between: straight), `adjacent` (neighbor columns: cubic inside one gutter), `rail` (same column with frames between: orthogonal via the left-gutter rail, 6 px radius), `channel` (farther: via a channel lane). A step's home frame is its loose frame, else its story frame, else its `tests` chapter for a test or check, else its lowest-anchor chapter. Lanes have fixed capacity; an edge without a lane is drawn only for the selection. Coinciding strokes use solid ink, not opacity; shared ports get a 2.5 px junction dot; no arrowheads (time runs left to right). The selection's one-hop edges draw in accent and others dim to 30%. Session level draws only `trunk` and `contradicts` at rest.

**Semantic zoom.** Session shows chips (icon, short title, status glyph; `Noise ×n`). Chapter shows frames with one mini graphic. Step widens frames to 320 px with a fixed nine-row step list (head 3, tail 5, then problem steps, then collapse bands) that scrolls inside the frame; wheel over it scrolls the list unless Ctrl or Meta is held. Within a level zoom is geometric; below 0.5 cards hide their graphic, below 0.35 they show only icon and state fill. A level switch pins the focus frame (the selection if visible, else the frame nearest the center) to the same screen point and animates others for 180 ms.

**Viewport commands.** Fit (`Shift+1`): fit bounds with 48 px padding; at Chapter or Step, a fit below 0.35 switches the shared level to Session first. Zoom to selection (`Shift+2`): the selection plus rest-edge neighbors when that fits at ≥ 0.75, else the selection alone, capped at 1.5. Reveal (j/k, n/N, Outline clicks, a switch from Hybrid): nothing if the card lies inside the viewport inset by 48 px, else `setCenter` at the current zoom; reveal never zooms.

**Minimap** (`canvas-minimap.ts`). A 140 × 84 SVG inside the 152 × 96 panel, derived from `CanvasLayout`: `s = max(min(140/B.w, 84/B.h), 0.03)`; when `s · B.w > 140` it shows a window centered on the viewport plus a 3 px full-session strip with a window bracket and red ticks for critical findings. Marks: frames `--tv-fill-2`; selection accent-soft with an accent stroke; critical frames a 1.5 px `--tv-bad` stroke; noise stacks at 50%; rest `contradicts` edges red with `vector-effect: non-scaling-stroke`; turn separators and the viewport outline `--tv-ink-4`. Click centers; dragging the viewport outline pans.

**Expected oauth layout at Chapter level** (fixture times; units from `expected_units.json`):

| Item (start) | Time x | Rule | Column, cell | Slot origin |
|---|---|---|---|---|
| Intent (0 s) | 0 | First column | col 0, story | (0, 0) |
| Plan (8 s) | 64 | Story cell taken: open, push to 0 + 224 + 40 | col 1, story | (264, 0) |
| Dependency (10 s) | 280 | 280 < 264 + 264: join | col 1, row 0 | (264, 150) |
| Identity layer (15 s) | 320 | Join | col 1, row 1 | (264, 300) |
| Migration (17 s) | 336 | Join | col 1, row 2 | (264, 450) |
| Lockfile, format noise (21 s, 22 s) | 368, 376 | Noise joins the frontier stack | col 1, row 3, `Noise ×2` | (264, 600) |
| Decision (25 s) | 400 | Story cell taken: open, push to 528 | col 2, story | (528, 0) |
| Linking policy (30 s) | 568 | Join | col 2, row 0 | (528, 150) |
| Linking test (33 s) | 592 | Join | col 2, row 1 | (528, 300) |
| Final claim (43 s) | 672 | Story cell taken: open, push to 792 | col 3, story | (792, 0) |

Bounds are 1016 × 658, so Fit in a 1440 × 900 window is width-bound: (1440 − 216 − 280 − 2 · 48) / 1016 ≈ 0.83. The trunk runs at y ≈ 124 from col 0 to col 3; Decision → Linking policy is `stacked`; Identity → Decision is an `adjacent` S-curve in gutter 488–528; Claim `≠` Linking test is a red `adjacent` S-curve in gutter 752–792 with the badge at (772, 224). At Session level the session fits in two columns, about 360 × 324.

**Invariants** (property tests, §11):

| # | Invariant |
|---|---|
| P1 | No overlap: all slots, holes included, are disjoint, with ≥ `colGap` between columns and ≥ `rowGap` within one |
| P2 | Monotone: `start(a) < start(b)` ⇒ `col(a) ≤ col(b)` and `x(a) ≤ x(b)`, fresh and sticky |
| P3 | Truthful ruler: `col.x ≤ xAt(start(f)) ≤ nextCol.x`; `xAt` non-decreasing; `tAt(xAt(t)) = t` outside jumps and breaks |
| P4 | Turns and breaks sit in gutters; no column mixes turns or spans a break ≥ `breakMinMs` |
| P5 | Append equals fresh for any prefix with no key mutated after it |
| P6 | Sticky under id churn, merges, kind flips and late arrivals; old breakpoints are a prefix of the new list |
| P7 | Deterministic, including under shuffled `chapters`, `steps` and `findings` |
| P8 | Every current item appears exactly once (frame or stack member); every warning+ finding step is reachable through its home frame |
| P9 | No rest edge crosses a card other than its endpoints; only `contradicts` is red; every `claim_contradicted` finding has exactly one `contradicts` edge per distinct evidence home frame, drawn even when its route is `channel`; lane indices below capacity |
| P10 | `w` and `h` depend only on `(level, kind)` |

**Refinements from lane C3a** (lane 07 deviations; the oauth table and P5 are unaffected):
- An item is late when `start < lastBp.t`, a superset of `start < front.t0` that keeps breakpoints sorted by `t` in sticky runs; a fresh layout has no late item.
- Every item's `turn` is the index of the last turn whose `tMs ≤ start`, so turns never decrease with `start`, which P4 needs.
- Break detection runs only when at least `breakMinMs` of real time separates the last breakpoint from the item, and counts only `scale.breaks()` segments with `u1 > toU(lastBp.t)` and `u0 < toU(start)`, so an idle segment that merely touches the previous item, or two story items a second apart inside one long wait, open no separator.
- A `contradicts` edge with no free lane gets `shape: "direct"` and its path in the layout, drawn above the frames with the 3 px halo; P9's crossing check exempts it.
- P4 and P10 hold on fresh layouts (a sticky kind flip keeps its old slot size by design); P3 exempts frames that start before column 0's `t0` and reads `xAt` at a push as the interval [first `xIn`, last `xOut`].
- Cards fill their card rect (fixed height, content clamped), so every edge port lies on a drawn card edge.

Complexity: O(S log S) for the scale and O(F log F) for placement; budgets in §10. The layout reruns only when `loadedThroughSeq` changes.

### 7.6 Hybrid overview and spine

#### 7.6.1 Lanes and marks

The lane is `KIND_META[kind].lane`, a model fact; the glyph is a UI choice in `layout/overview-index.ts`:

| Kind | Glyph | Pin |
|---|---|---|
| instruction | dot | always |
| decision, approval | wait (hollow bar from open to answer or, for approvals, to the next agent event; fork pin only for decisions) | always |
| message, reasoning, lifecycle | dot | when it has a finding or failed |
| tool, command | bar | same |
| test, check | bar, echoed as a plain bar on Commands | same |
| edit, dependency, revert | hist (up strokes added, down strokes removed) | same |
| read | ring | never |
| jev | dot; a shield pin per clamped row | always when clamped |

A finding draws on its anchor step's lane (`claim_contradicted` as a quote pin linked to the evidence pin with `≠` at the midpoint; others as a badge pin). Tone follows `stepTone`/`findingTone` (`layout/tone.ts`, §6.8): red for failed tests and checks, agent failures, critical findings and guardrail hits; neutral otherwise, so an info clamp keeps a gray shield.

**Density** (`layout/overview-layout.ts`, pure). For each lane, binary search over a struct-of-arrays index (`Float64Array` u0/u1, `Int32Array` step, `Uint8Array` glyph and tone) sorted by u0 and rebuilt once per fold. The bin grid is anchored at u = 0 (`bin = floor(u · k / 6)`), so a pure pan never re-bins.

| Mark | Individually when | Otherwise |
|---|---|---|
| Dot, ring | Neighbors on the lane ≥ 8 px away | Heat: a bar 2, 4, 6 or 8 px tall for 1, 2–3, 4–9 or ≥ 10 steps, in `--tv-mark` (height carries the count, not opacity) |
| Bar | Width ≥ 3 px | A dot; bars < 2 px apart merge, with an end dot showing the worst status |
| Hist | Always | Lines summed per bin; `log2(1 + lines)` px up and down, capped at 12 |
| Wait | Always | Hollow bar ending in the pin |
| Pin (22 px DOM) | Centers ≥ 26 px apart | Cluster pin with a count and the icon of its highest-priority member (critical finding > failed > decision/approval > instruction > guardrail > other); red if any member is critical; click zooms to fit the members |
| Problem | Always | A 2 × 10 px red tick at its exact x inside heat or a cluster; never merged away |

**Bands and ruler.** A chapter band covers the union of its steps' spans, except its `validationOnlyStepIds` (a run the chapter reaches only through a validation, which is often shared by every unit and would stack every band over one test run; orchestrator ruling M6, 2026-09-30), merged where the pixel gap is under 24 px at the current k, recomputed on zoom only; filled `--tv-fill` (`--tv-fill-2` hovered or selected). Labels are DOM, placed greedily in two tiers; a label that fits no tier drops to icon-only when the band is ≥ 20 px, else out (the Outline and the tooltip still name it). Turn starts draw a hairline across all lanes with a ruler chip `T2 · steer`. The 6 px session strip always shows the whole session: 1 px density bins, the brush in accent-soft, the playhead as a 1 px accent line, the viewport as an outline; drag pans, click centers. A 2 px `--tv-ink-4` underline (decoration) on the ruler spans the first and last visible spine rows. The brush shows as an accent-soft column behind the lanes.

**Semantic zoom.** A session without chapters (pre-M1, no units) uses turns wherever this table says chapter.

| | Session | Chapter (default) | Step |
|---|---|---|---|
| Preset domain | `fit(0, endU)` | Playhead chapter's footprint, 8% padding, ≥ 20 s display | Centered on the playhead; k makes the median spacing of ±20 neighbors 28 px, capped at `K_MAX = 0.4` px per display ms |
| Preset brush | `session` | `chapter` holding the playhead | `range` over the visible domain |
| Pins | Critical findings, instructions, decisions | Every pin rule | Same, plus a link per finding |
| Noise | Omitted | One hollow thin bar per noise run | Individual muted marks |
| Brush snapping | Chapter and turn boundaries | Step boundaries | Step boundaries |
| Spine rows | Chapter rows plus beats | Steps, noise groups, head/tail elision | Every step, noise expanded, no elision |

Picking a level applies its preset domain and brush; continuous zoom afterwards leaves the level unchanged. The zoom readout is `k / k_preset(level)`.

#### 7.6.2 Interactions

A pointer moving less than 4 px is a click. Drags use `setPointerCapture` when available.

| Gesture | Result |
|---|---|
| Click an empty track | Playhead to the nearest step on any lane (`free`); the brush slides if needed; selection unchanged |
| Click a mark or pin | Select the step; playhead follows the selection |
| Drag on an empty track | New `range` brush, snapped per level (Alt disables chapter snapping at Session) |
| Drag the brush body or an edge (8 px hit area on a 3 px handle) | Move or resize the brush |
| Drag the playhead handle | Scrub: each frame moves the playhead to the nearest step and centers its spine row with an instant scroll |
| Double-click a band or label | Brush becomes that chapter at the Chapter preset |
| Hover | DOM tooltip: kind, headline, offset, duration; nearest mark within 8 px on the pointer's lane; over heat, the bin's step range |
| Hand tool, Space, plain wheel | Pan |
| Pinch, Cmd/Ctrl + wheel | Zoom around the pointer |

#### 7.6.3 Spine

```ts
type SpineRow =
  | { t: "step";    key: StableId;           step: number; expanded: boolean }   // key = Step.id
  | { t: "chapter"; key: `ch:${number}`;     chapter: number }   // Session level; Chapter.anchorSeq
  | { t: "noise";   key: `noise:${number}`;  steps: number[]; label: string }
  | { t: "elided";  key: `elided:${number}`; steps: number[]; byLane: Record<Lane, number>; spanMs: number }
  | { t: "turn";    key: `turn:${number}`;   turn: number }
  | { t: "idle";    key: `idle:${number}`;   ms: number; reason: "awaiting_supervisor" | "agent_quiet" }
  | { t: "gap";     key: `gap:${number}`;    gap: number };
export function buildSpineRows(s: TraceSession, scale: TimeScale, v: { brush: Brush; level: Level;
  playhead: number; selected?: StableId; expanded: ReadonlySet<string>;
  collapsed: ReadonlySet<string>; matches?: ReadonlySet<string> }): SpineRow[];
```

Every key derives from a first seq, a decision id or a chapter's anchor seq, so keys survive refolds, unit-id churn, live ticks and growing groups. `buildSpineRows` binary-searches steps by `firstSeq` for the brushed range and walks only those.

**Row anatomy** (grid `52px 24px 120px minmax(0,1fr) auto`, 12 px gap, 32 px minimum; separators 24 px):

| Column | Content |
|---|---|
| Time gutter (52 px; 60 px for sessions ≥ 1 h) | `formatOffset`, 12 px `--tv-ink-3`, tabular; the playhead row gets an accent pill with panel-colored text |
| Node (24 px circle on a continuous 2 px spine line) | Kind icon; `stepTone` bad (a failed test or check, an agent failure, a guardrail hit): `--tv-bad-soft` fill, red icon; critical finding: solid red, white icon; a nonzero command exit: neutral node with a ✕; noise and elided: `eyeoff`/`stack` in `--tv-ink-3` |
| Graphic slot (120 px) | `ROW_GRAPHIC[kind]`: DurationBar for command, tool, check; TestDots for test; DiffBar for edit, dependency, revert; ForkGlyph for decision; empty for prose |
| Line | One ellipsized line; mono for paths and commands; agent messages `--tv-ink-2`; reasoning muted and prefixed "Thinking" |
| Metric | `+17 −3`, `5.0 s`, `14/15`, `exit 1`, a clamp id; `--tv-ink-3`, `--tv-bad-ink` only where `stepTone` is bad |

**Finding rows.** A step with findings renders its first finding under `FINDING_ORDER` (§6.7). A critical finding expands automatically the first time its id appears; a reader's collapse puts the id in `collapsed`, and later folds never re-expand it. Others show a badge and expand on Enter or the chevron. Bodies come from `FINDING_BODY satisfies Record<SignalId, Component>`:
- `claim_contradicted`: title "Claim contradicts tests"; a chain `[test] —— [quote] 3.0 s` (claim `tMs` − (evidence `tMs` + `durationMs`)); `ClaimVsObserved` with the claim span underlined in red, a `≠` badge and an observed card (TestDots, "1 failed pnpm test"); clicking the observed card moves the playhead to the evidence;
- `failing_tests`: up to three failures and "N more";
- `destructive_command`: the command with the matched pattern marked and "Why flagged?";
- `guardrail_clamp`: clamp labels and the rule's reason;
- `recovery_arc`: fail → edit → pass chain with offsets.

**Noise, elision, beats, separators.**
- Consecutive noise steps in the brush fold into one row labelled by kinds ("4 lockfile and formatting edits"), expandable.
- Head/tail elision is a pure selector (`layout/spine-rows.ts`), used only at Chapter level. Pinned rows: instructions, decisions, approvals, steps with findings, failed steps, turn boundaries, the playhead row, the selected row and search matches. A segment is a maximal run of unpinned rows within one chapter and one turn; above 11 rows it shows the first 3, one band ("412 steps · 180 edits · 200 commands · 12 min" with a six-lane stacked count bar) and the last 5. Moving the playhead into a band expands it; the still-growing live segment is never elided; a segment that closes while visible is added to `expanded`.
- Session-level beats: chapter rows (category graphic, title, duration, step count, finding badge) interleaved by first seq with instruction, decision, approval and critical-finding steps.
- Separator rows: a turn row ("Turn 2 · steer · +14:02"), an idle row wherever `scale.breaks` falls between two rows ("⋯ 6m 12s · waiting for supervisor"), and a gap row ("1 row could not be read · seq 812").

**Virtualization.** `anchorTo: "end"`, `followOnAppend: "auto"`, `scrollEndThreshold: 24`, `overscan: 10`; `estimateSize` 32 for step, chapter, noise and elided rows, 24 for separators, per signal for expanded rows (124 for a claim); `rangeExtractor` keeps the playhead and focused rows mounted. Only expanded rows are measured; their virtualizer key is `row.key + "+x"` while the React key stays `row.key`, so a height change while unmounted gets first-measure compensation. The live footer ("Agent running · last event 4 s ago") and the end row sit outside the list, because a permanent last key would stop `followOnAppend`.

**Scroll and playhead sync.** The playhead never leaves the spine viewport and moves only as far as needed:

```
on playhead write with origin ≠ "spine" (overview, keys, search, n/N):
  i = row holding the playhead
  if i is outside the comfort band (the viewport inset by 32 px at top and bottom):
    far = the row's top lies more than one viewport height outside the viewport
    scrollToIndex(i, {align: far ? "center" : "auto", behavior: "auto"})
  suppressPush = true            # cleared at the first onChange with isScrolling = false

on spine scroll (coalesced per animation frame):
  publish the first and last visible row times to the overview underline
  if suppressPush: return
  if the playhead row is above the comfort band: playhead = first row in band (origin "spine")
  if it is below: playhead = last row in band (origin "spine")
```

Each direction has one writer, writes with origin `"spine"` never scroll, programmatic scrolls are instant, and pushes pause while a measurement settles, so nothing jitters. A click on a visible row never scrolls. A brush, level or view change replaces the row set and reveals the playhead row centered.

### 7.7 Module structure (R19)

```
packages/trace-viewer/src/
  model/    types.ts, registry.ts, rows.ts, fold.ts (+ internal fold-state, fold-agent,
            fold-evidence, fold-chapters), classify.ts, signals.ts, format.ts, search.ts,
            lookup.ts, index.ts ("@jevcode/trace-viewer/model"); §6.1
  layout/   pure, React- and DOM-free (same ESLint block as model, plus LAYOUT_PURE_GLOBALS:
            no window, document, timers, performance or Date)
            time-scale.ts ticks.ts viewport.ts trace-index.ts tone.ts
            canvas-levels.ts canvas-layout.ts canvas-routes.ts canvas-minimap.ts
            overview-index.ts overview-layout.ts spine-rows.ts
  ui/
    shell/      TraceViewer, Shell, TitleBar, Outline/, DataController, LiveRegion, ErrorBoundary
    state/      view-state.ts (pure reduce), store.ts (useView), keymap.ts (pure), location.ts
    viewport/   controller.ts
    views/canvas/  CanvasView, World, Frame, EdgeLayer, Overlay, Minimap, Toolbar
    views/hybrid/  overview/{Overview, paint.ts, Pins, Brush}, spine/{Spine, rows/, findings/}
    views/shared/  Ruler, LevelControl, NewBadge
    inspector/  Summary, Evidence, Raw, ReviewNote
    graphics/   DiffBar TestDots ForkGlyph FlowGlyph TableGlyph DurationBar ClaimVsObserved scales.ts
    icons/      IconSprite (satisfies Record<IconName, …>), Icon, kind-icons.ts (KIND_ICON, LANE_ICON,
                CATEGORY_ICON, SIGNAL_ICON)
    tokens/     tokens.ts (typed; Canvas2D reads it), contrast.ts
  sources/  ("@jevcode/trace-viewer/sources"; no React, no CSS) static-bundle.ts
            (createStaticBundleSource, parseTraceBundle), read-all.ts (readAllTraceRows), errors.ts
  test-support/  test-only, excluded from the build and the lint blocks (§3.2): trace-builder.ts,
            synthetic-rows.ts, fixture-rows.ts, session-builder.ts, arbitraries.ts,
            canvas-arbitraries.ts, recording-context.ts, ui-harness.tsx, canvas-view-harness.tsx
```

`layout` imports `model`, never the reverse. `createIpcTraceSource` lives in `apps/desktop` (M5).

```ts
export interface TraceSource {          // src/source.ts (W0-6); bound to one session
  readonly sessionId: string;
  summary(): Promise<TraceSessionSummary>;          // rejects when the session does not exist
  rows(r?: { afterSeq?: number; limit?: number }): Promise<TraceRowsPage>;
  payloads(seqs: readonly number[]): Promise<TraceRow[]>;   // ≤ TRACE_PAYLOADS_MAX (50); [] needs no call
  now(): number;            // epoch ms on the session's source clock; drip supplies a virtual clock
}
export function cursorAfter(page: TraceRowsPage): number;   // page.nextAfterSeq ?? page.lastSeq
export interface ViewerHost {
  requestChanges?(r: { sessionId: string; selected: SelectionId; text: string }): void | Promise<void>;
  onLocation?(l: ViewerLocation): void;
  onReady?(r: { rows: number; loadedThroughSeq: number }): void;   // once, after the first committed fold
  onDiagnostics?(d: { errors: string[]; maxAnchorDriftPx: number;
                      selectedTitle: string | null }): void;       // dev host selftest only
}
export function TraceViewer(p: { source: TraceSource; host?: ViewerHost; location?: ViewerLocation;
  pollMs?: number }): JSX.Element;   // pollMs: poll interval while not terminal, default 1,000 (§5.5)
```

`createStaticBundleSource(bundle, {drip: {rowsPerTick, intervalMs, manual?, startAtSeq?}})` serves a `TraceBundle` validated by `parseTraceBundle`; with `drip` it releases rows over time (`rows()` returns only rows released so far; `startAtSeq` releases every row up to it at once), reports `state: "running"` until the last row, and advances `now()` from the last released row's source time, which exercises live mode without Electron. While dripping, `lastSeq` is the last released seq; once every row is out it is `max(bundle.session.lastEventSeq, last released seq)`, so `hidden.unreceived` and `loadedThroughSeq` match the IPC source, whose `lastSeq` counts the rows a bundle omits (D-7 parity).

**Dev host.** `apps/trace-viewer-dev` loads `?bundle=<name>` from `public/bundles/<name>.json` (default `oauth`) and accepts a dropped file validated with `parseTraceBundle` (failure shows "Not a jevcode trace" or "Trace format v2 is not supported"). It mounts `<TraceViewer source={createStaticBundleSource(bundle, {drip})} pollMs={drip?.intervalMs ?? 1000} location={locationFromHash(location.hash, sessionId)} host={{onLocation}} />`, with `?drip=<rowsPerTick>,<intervalMs>[,<startAtSeq>]` (a negative `startAtSeq` counts back from the bundle's last seq; the M5 live-tick run uses `?drip=20,1000,-2000`) and `pollMs` set to the drip interval, `?perf=1`, `?selftest=drip` and `?selftest=open` (§1, §11). A Vite `transformIndexHtml` plugin injects the Electron CSP meta for build and preview only, because plugin-react's dev preamble is inline. Every workspace package, the viewer included, is consumed from `dist` in builds, previews and tests; there is no source alias for `@jevcode/contracts` or `@jevcode/ui-catalog`, because aliasing contracts in the viewer's tests would load a second copy beside semantic-core's `dist` copy. A plugin with `apply: "serve"` aliases `@jevcode/trace-viewer` to its `src` for `vite` serve only, which gives HMR without touching build, preview or tests.

### 7.8 Store and view-switch contract (R20)

The view store is a selector-based external store read through `useSyncExternalStore` (precedent: useSurfaceManager.ts:33), with no zustand. Unlike `useSurfaceManager`, which re-renders on any version change, every read goes through a selector, because brush drags write at frame rate. `TraceSession` is React state set inside `startTransition`, so a page fold or a live apply never blocks a key (docs/SPEC.md:593). After each commit a layout effect dispatches `session/applied {index, loadedThroughSeq, terminal}`, which remaps a regrouped selection, advances `lastSeenSeq` while following and recomputes "N new". Camera frames never enter the store.

```ts
export type Playhead = { kind: "selection" } | { kind: "free"; seq: number } | { kind: "live" };
export type Brush = { kind: "session" } | { kind: "chapter"; anchorSeq: number }
  | { kind: "range"; fromSeq: number; toSeq: number | "live" };
export interface CanvasCamera { mode: "uniform"; tx: number; ty: number; k: number; syncedRev: number }
export interface HybridCamera { mode: "xOnly"; u0: number; k: number;
  spineAnchor: { key: string; offsetPx: number } | null; syncedRev: number }
export interface ViewState {
  view: "canvas" | "hybrid"; level: Level; follow: boolean;
  selection: SelectionId | null; playhead: Playhead; brush: Brush;   // SelectionId = StepId | UnitStableId (§6.3)
  focusRev: number; focusBy: "canvas" | "hybrid" | "shell";
  expanded: ReadonlySet<string>; collapsed: ReadonlySet<string>;
  inspectorTab: "summary" | "evidence" | "raw"; tool: "select" | "hand";
  lastSeenSeq: number; gesture: null | "pan" | "zoom" | "brush" | "playhead";
  search: { query: string; matchIds: readonly StableId[]; cursor: number } | null;
  cameras: { canvas: CanvasCamera | null; hybrid: HybridCamera | null };
}
// reduce(state, action, index: TraceIndex): ViewState  — pure; TraceIndex maps id → {kind, t0, t1, firstSeq, lastSeq, parent}

// StableIdSchema is W0's: /^(?:step:[1-9]\d*|(?:unit|decision|file|finding):.+)$/s (types.ts)
export const ViewerLocationSchema = z.object({
  v: z.literal(1), sessionId: z.string().min(1),
  view: z.enum(["canvas", "hybrid"]).default("hybrid"),
  level: z.enum(["session", "chapter", "step"]).default("chapter"),
  selected: StableIdSchema.optional(),   // resolved to a SelectionId on load (C2-3)
  playhead: z.union([z.object({ kind: z.literal("selection") }),
    z.object({ kind: z.literal("live") }),
    z.object({ kind: z.literal("free"), seq: z.number().int().positive() })]).optional(),
  brush: z.union([z.object({ kind: z.literal("session") }),
    z.object({ kind: z.literal("chapter"), anchorSeq: z.number().int().positive() }),
    z.object({ kind: z.literal("range"), fromSeq: z.number().int().positive(),
               toSeq: z.union([z.number().int().positive(), z.literal("live")]) })])
    .default({ kind: "session" }),
});
```

The location lives in the URL hash in the dev host (`#` + `encodeURIComponent(JSON)`, written with `history.replaceState`) and in memory in Electron. `decodeLocation` falls back to defaults and never throws. Lenses are later and are not in the location.

**Defaults on open.** Level Chapter. A session that opens in Review (§7.10) keeps brush `session` until loading ends. Then, when the reader has selected nothing, the selection becomes the anchor of the first finding under `FINDING_ORDER` (§6.7), else the last step, and the playhead follows it. The brush stays `session` when the Chapter-level spine has ≤ 150 rows (every fixture does), else it becomes the chapter holding that selection. A session that opens in Live gets follow on, playhead `live`, no initial selection, and brush `session` when the Chapter-level spine has ≤ 150 rows, else the latest chapter; its findings are reachable with `n`. The initial selection is programmatic and never switches Live to Review.

**Switch contract.**
1. Everything except `cameras` carries across a switch.
2. Only user gestures write the brush: a settled Canvas pan or zoom writes the steps inside its window (an empty window writes nothing), and a Hybrid brush drag writes the range. Programmatic moves never write it, so a narrow brush survives a zoomed-out canvas.
3. A view stamps `syncedRev = focusRev` whenever its camera agrees with focus. On show: if the stamp matches, it restores exactly; otherwise it animates for 180 ms (0 under reduced motion). Hybrid fits the brush and centers the selection row; Canvas fits the brush horizontally with `k ∈ [minZoom(level), 1.5]`, keeps `ty`, then reveals the selection without zooming.
4. Both views stay mounted under React 19.2 `<Activity>`: the hidden tree keeps DOM and state, its effects unmount (no rAF loop or observers), and updates render at low priority. `ResizeObserver` ignores width 0; the spine restores from `spineAnchor` in a layout effect. If spike risk 6 fails, the hidden view unmounts and restores from the store.
5. Each view registers `{readingOrder, reveal, captureCamera, focusSelected, zoom}` with the shell. An id a view does not know falls back to its ancestor (step → unit), so a step selected in Hybrid continues from its frame in Canvas.
6. Invariants: the selection intersects the brush; the playhead's effective seq lies inside the brush. A selection or playhead write that breaks them slides the brush, keeping its width; a brush write (`brush/set`, `brush/edge`, `brush/chapter`) keeps the brush the reader drew, clears a selection outside it and clamps the playhead into it, because sliding a just-drawn brush would undo the gesture (a Canvas pan settle includes the selection in the range it writes). The effective seq of a `selection` playhead is the selected item's `firstSeq`, since a command's `lastSeq` can lie inside a later interleaved step; switching to the other view and back leaves the state deep-equal to the state before the first switch, excluding `cameras` (R20's "1,2,1 is identity except view": `view` returns to its start, and hiding a view captures its camera); DOM focus follows a switch only when it was in `main`.
7. `search` carries across a switch and is not in `ViewerLocation`. A selector recomputes `matchIds` after each fold; `buildSpineRows`' `matches`, the overview match marks, the canvas frame marks and the Outline read it; Esc clears it in the unwind order (§7.9).

**Regrouped selection.** If a re-cluster removes the selected `unit:` id, the selection moves to the unit that now holds the old unit's anchor seq, and the Inspector notes "Regrouped into 'Identity layer'". The same remap applies to `expanded` and `collapsed` ids of the old unit. The reducer keeps `unitAnchors` (unit id → anchor seq for every unit id held in `selection`, `expanded` or `collapsed`), because `session/applied` hands it only the new index. A `chapter` brush and chapter spine rows resolve through the placement key `ch:<anchorSeq>` (§7.5), so they survive unit-id churn.

### 7.9 Keyboard (R21)

Keys match `event.code` (a Hangul input source sends `ㅓ` for `KeyJ`) and are ignored during IME composition, in inputs, textareas and `[contenteditable]`, and with an unlisted modifier. An uppercase letter means Shift+letter.

| Key | Action (both views unless noted) |
|---|---|
| `j` / `k` | Next or previous item (Canvas: frame, then an expanded frame's steps; Hybrid: spine row, sliding the brush past its edge) |
| `J` / `K` | Next or previous chapter |
| `[` / `]` | Previous or next turn (selects its Intent) |
| `n` / `N` | Next or previous finding in seq order, wrapping; announced "Finding 2 of 5: Claim contradicts tests" |
| `Enter` / `Esc` | Expand or collapse; Esc unwinds one step: menu → search → hand tool → collapse → parent (step → unit) → clear. Esc never moves the camera and never closes the window |
| `1` / `2` | Canvas / Hybrid |
| `Alt+1` / `Alt+2` / `Alt+3` | Session / Chapter / Step |
| `,` / `.` | Playhead back or forward one step (`free`) |
| `g` / `G` | First item / last item; on a running session `G` also turns Live on |
| `-` / `=` / `0` | Zoom out or in by a factor of 1.25 per press around the selection (Canvas) or the playhead (Hybrid), clamped to the view's zoom limits; `0` returns to the level preset |
| `Shift+1` / `Shift+2` | Fit all / zoom to selection |
| `v` / `h` / hold `Space` | Select tool / hand tool / temporary hand (only over a pannable surface or with focus in `main`) |
| `{` / `}` / `b` (Hybrid) | Brush start / end at the playhead; brush to the playhead's chapter |
| `/` / `?` | Outline search (Enter next match, Esc returns focus) / shortcut sheet |
| `F6` / `Shift+F6` | Cycle regions: Outline → main → Inspector |
| `Cmd/Ctrl+C` | Copy review note when no text is selected |

In the focused overview, `←`/`→` move one step, with `Alt` one pin, with `Shift` one chapter. Each region is one tab stop with a roving tabindex. An Outline click reveals without stealing focus; Tab into `main` lands on the selected item; Esc in the Inspector returns focus to the selected view item.

### 7.10 Live follow (R16, R22)

Review | Live toggles following. `terminal(state) = state === "completed" || state === "failed"`, and `finalize` gets `live: !terminal(page.state)`. The viewer opens in Live for `starting`, `running` and `waiting_decision`, and in Review for `paused` and terminal states; polling continues while not terminal, including `paused`. The tail is the step with the highest `firstSeq`; selecting it or its chapter keeps Live. Any camera gesture, drag, `,`/`.`, zoom key or selection of a non-tail item switches to Review, announced once ("Live follow paused"). Search changes keep Live.

| Surface | Live | Review |
|---|---|---|
| Hybrid overview | Playhead at the edge; the brush's right edge sticks to the tail at a fixed width; the Session level keeps 20% headroom and grows × 1.5 only when the tail reaches it | Camera and brush stay put |
| Hybrid spine | `followOnAppend: "auto"`; the open step's DurationBar updates on the poll tick | `anchorTo: "end"` keeps the top row pixel-stable; a "↓ N new" pill; "N new after range" when the brush does not follow live, which acts like `G` |
| Canvas | Pans x only, over 180 ms, when the frontier column leaves the view | Never moves; the frame nearest the center stays anchored; an "N frames →" badge |
| Title bar | Duration ticks | "N new" pill, with a red dot only when a new critical finding arrived; click acts like `G` |
| Outline | `aria-current` moves to the newest chapter; scrolls only when neither hovered nor focused | Unchanged |

Applies wait for a gesture to end, and the latest session wins. Placement is sticky and rows are keyed, so an append moves only the open tail. A collapsed finding stays collapsed, and no refold collapses the selection, an expanded id or an on-screen row under the reader (the rule lives in the row projection, not the fold). `newCount` counts steps with `firstSeq > lastSeenSeq`; `lastSeenSeq` never decreases and advances while following, or while the tail step's spine row (Hybrid) or its home frame (Canvas) intersects the viewport. Announcements in Review are throttled to one per 10 s ("12 new steps, 1 problem"); in Live only findings are announced. A terminal session gets one final apply, then Live is disabled and "Session ended" is announced. M4 drives live mode with the drip source; M5 swaps in the 1 s `trace:rows {afterSeq}` poll.

### 7.11 States (R23)

| State | Behavior |
|---|---|
| Loading | Title from the summary; static placeholder rows (no shimmer); a dotted grid in Canvas, empty lanes in Hybrid; the Inspector shows the summary |
| Progressive | "Loading 41%" (`nextAfterSeq / lastSeq`), at most 4 commits per second inside a transition; the ruler is hatched past `loadedThroughSeq`; interaction allowed; initial selection deferred to load end (oauth: the contradiction at +0:43) |
| Empty | "Waiting for the agent's first event" (running, no consumed rows); "1,204 events, none describe agent work" (only pipeline rows); "No steps match '…' · Clear" (search); "Nothing between +3:10 and +3:40 (idle 30 s)" with previous/next activity (empty brush) |
| Partial | `≈ Approximate joins` chip and `≈` on affected frames and bands; "3 gaps" chip whose popover lists each gap by `atSeq` and jumps to the nearest step, plus neutral dashed ruler ticks; unpaired steps and exit −1 read "unknown"; the Inspector labels clipped, withheld, truncated and redacted content; Canvas holes offer "Tidy layout" |
| Errors | First load: the channel, the message and Retry; a bad bundle reads "Not a jevcode trace" or "Trace format v2 is not supported"; a failed poll shows "Reconnecting (n)" with 1 → 2 → 4 → 10 s backoff and keeps the data; payload failures show inline in Raw or Evidence with Retry; each region has an error boundary ("Canvas failed to render · Switch to Hybrid", "Hybrid failed to render · Switch to Canvas", an Inspector-only boundary that keeps the selection) |

With zero findings the summary reads "No problems found by 5 signals" and lists them, or names the inactive ones and their missing capabilities.

### 7.12 Visual system (D8, R24)

Tokens live in `ui/tokens/tokens.ts`, typed, applied as inline `--tv-*` custom properties on the Shell root (the CSP allows inline styles, apps/desktop/src/renderer/index.html:5-8) and read directly by the Canvas2D painter. CSS Modules only consume `var(--tv-*)`. Light only in v1; dark is a second object later.

| Token | Value | Role (measured contrast) |
|---|---|---|
| `--tv-canvas` / `--tv-panel` | `#F4F5F7` / `#FFFFFF` | Backgrounds; `body` and the trace window background are `#FFFFFF` |
| `--tv-ink` | `#16181D` | Primary text (17.8:1 on panel) |
| `--tv-ink-2` | `#5B616E` | Secondary text, lane icons, DiffBar added (6.2:1 panel, 5.4:1 fill-2) |
| `--tv-ink-3` | `#676D78` | Tertiary text: offsets, counts, ruler labels (5.20:1 panel, 4.77:1 canvas, 4.52:1 fill-2) |
| `--tv-ink-4` | `#9AA0AB` | Decoration only: grid dots, ticks, neutral edges (2.63:1) |
| `--tv-mark` | `#7C828E` | Overview marks and heat (3.54:1 canvas, 3.24:1 band) |
| `--tv-hair` / `--tv-fill` / `--tv-fill-2` | `rgb(16 24 40 / .07)` / `/ .04` / `/ .07` | Structural dividers and wells |
| `--tv-accent` / `--tv-accent-soft` | `#2F6BFF` / `rgb(47 107 255 / .10)` | Selection, focus, playhead, brush |
| `--tv-accent-ink` | `#1F5EF0` | Accent text on accent-soft (4.70:1); the primary button fill (white on `#2F6BFF` measures 4.499:1, just under 4.5:1; white on `#1F5EF0` is 5.36:1) |
| `--tv-bad` / `--tv-bad-soft` | `#E5484D` / `rgb(229 72 77 / .09)` | Real problems only: marks, glyphs, the contradicts edge (3.91:1) |
| `--tv-bad-ink` | `#CE2C31` | Problem text ("1 failed", "contradicts") (5.21:1 panel, 4.66:1 bad-soft) |
| `--tv-good` | `#2E9E6A` | Tiny pass marks only, never text (3.38:1 panel); a 1 px panel ring on bands where it measures 2.83:1 |
| `--tv-shadow` | `0 1px 2px rgb(16 24 40 / .06), 0 4px 12px rgb(16 24 40 / .05)` | The one elevation: frames, toolbars, minimap, popovers |

**Rules.** Accent means selected, focused, current or the one primary action. Red means a real problem as `layout/tone.ts` defines it (a failed test or check, an agent failure, a critical finding such as a contradiction or a destructive command, a guardrail hit), and every red mark also differs in shape or carries a word. Green is only a small pass mark. Everything else is neutral, with no per-kind colors. Diffs are neutral in both DiffBar and CodeDiff: added lines solid `--tv-ink-2` (CodeDiff: `--tv-fill-2` rows with a `+` gutter), removed lines hollow `--tv-ink-3` (CodeDiff: panel rows with a `−` gutter), never green or red. Elevation is declared once (shadow, not border); no decorative borders; no eyebrow or all-caps labels; text is cut to short titles with details in the Inspector or on hover. No dimming after the playhead in v1.

**Type.** System stack `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`; mono `ui-monospace, "SF Mono", Menlo, monospace`, used only for paths, commands and code. Sizes: 12/16 meta (the minimum), 13/18 base, 15/20 card prose, 20/24 large numerals, mono 12/18; weights 400/500/600; `tabular-nums` on every number.

**Motion.** `--tv-dur-fast: 120ms`, `--tv-dur: 180ms`, both 0 under `prefers-reduced-motion`, declared in `Shell.module.css` because an inline property would beat the media query.

**Icon family.** `IconSprite` renders inline `<symbol id="tv-i-*">` once in the Shell: 16 × 16 viewBox, `stroke: currentColor`, 1.5 px, round caps and joins; `<Icon name size={12 | 14 | 16}/>` renders `<use>`. `IconName` is a const union; the sprite and `ui/icons/kind-icons.ts` (`KIND_ICON`, `LANE_ICON`, `CATEGORY_ICON`, `SIGNAL_ICON`) `satisfies` it, so a new step kind fails typecheck until it has an icon (§6.2). The v1 set:
- kinds and lanes: `person`, `bubble`, `thought`, `plug`, `term`, `test`, `gauge`, `edit`, `eye`, `key`, `fork`, `pkg`, `undo`, `flag`, `jev`;
- findings and chapters: `neq`, `quote`, `shield`, `table`, `route`, `list`, `stack`, `eyeoff`;
- chrome: `cursor`, `hand`, `fit`, `zoom`, `search`, `clock`, `check`, `chev-d`, `chev-r`, `live`, `copy`, `reply`, `diff`, `file`, `view-canvas`, `view-hybrid`.

Commands use `term` (not the mockups' boxed `cmd`); schema chapters use `table` (not the cylinder `db`); `comment` is not shipped.

**Mini graphics** (`ui/graphics/`). Pure `memo` SVG components fed plain numbers; `pickGraphic` returns a discriminated `GraphicSpec`, and the UI maps each kind to a component with `satisfies Record<GraphicSpec["kind"], …>`. Sizes: `xs` 12 px inline (Outline, spine, Inspector rows), `sm` canvas cards and expanded rows, `md` Inspector. Accessible names come from `describeGraphic(spec)`; a graphic is `aria-hidden` when adjacent text says the same. Scales are fixed per session, never per brush.

| Graphic | Inputs (from the model) | Scale |
|---|---|---|
| `DiffBar` | `added`, `removed` (per file list for chapters) | Each side is 0 px when its count is 0, else `clamp(2, 56, 8 · log2(1 + lines))` px; added solid, removed hollow. From 128 lines the bar is at the cap and the label shows the count: exact below 1,000, one decimal with `k` from 1,000 (`+1.2k`) |
| `TestDots` | `passed`, `failed`, `skipped` | One dot per test up to 15; above that a proportional bar split passed/failed/skipped with the count as text; failed dots larger and red |
| `DurationBar` | `durationMs` or running, `status` | `clamp(4, 120, 20 + 40 · log10(seconds))` px on an absolute scale (1 s = 20, 10 s = 60, 100 s = 100); running adds a hollow extension to now; a failed test or check ends in a red dot, a nonzero command exit in an ink ✕ |
| `ForkGlyph` | Decision options `{label, chosen}`, `decidedBy` (supervisor or delegated) | Chosen branch solid, others dashed; up to 3 branches, then `+n` |
| `FlowGlyph` | Up to 3 file stems ordered by first edit, focus = most lines changed | Boxes with arrows, then an ellipsis |
| `TableGlyph` | `{name, role: "new" \| "altered", columns}` per table, derived by `pickGraphic` from `Chapter.schemaChanges` (§6.6); no foreign keys in v1 | Up to 2 tables; without schema data the chapter renders a DiffBar list |
| `ClaimVsObserved` | Claim `{text, claimSpan, tMs}`, observed `{passed, failed, command, tMs}` | Claim clamped to 2 lines at `sm`, full at `md` |

`CHAPTER_GRAPHIC` takes the first rule that matches, in this order: `schema` → TableGlyph; `architecture`, `api` → FlowGlyph; `tests` → TestDots; a chapter with an answered decision → ForkGlyph; everything else → DiffBar.

### 7.13 Accessibility

- Landmarks `header`, `nav`, `main`, `aside`; the Inspector is a panel, not a dialog. One polite `aria-live` region carries view switches, "Live follow paused", new-step counts, findings and copy confirmations.
- The Outline is `role="tree"`; Canvas frames are `role="group"` with `aria-label` built from the model's chapter title, such as "OAuth account-linking test failure, 1 failed, 14 passed, +0:33" (the unit title in `fixtures/oauth/expected_units.json`; the mockups shorten it to "Linking test"), and Outline chapter rows always carry the same description in their accessible name; the spine is `role="feed"` with `aria-posinset`/`aria-setsize`, which announces virtualized totals and is the screen-reader reading path. The overview canvas is `aria-hidden`; its pins are buttons in one roving group ("3 events, +0:39 to +0:41, 1 problem"); the playhead and the two brush handles are `role="slider"` with `aria-valuetext` ("+0:43, Claim contradicts tests, step 38 of 412").
- Each region is one tab stop with a roving tabindex; `rangeExtractor` keeps the focused row mounted; off-screen frames are revealed before focus.
- Contrast: `tokens.test.ts` composites each translucent token over its base (`--tv-fill-2`, `--tv-accent-soft` and `--tv-bad-soft` over `--tv-panel`; overview bands `--tv-fill` and `--tv-fill-2` over `--tv-canvas`) and asserts these pairs. Text tokens `--tv-ink`, `--tv-ink-2`, `--tv-ink-3`, `--tv-accent-ink` and `--tv-bad-ink` are ≥ 4.5:1 on `--tv-panel`, `--tv-canvas` and fill-2 over panel; `--tv-accent-ink` is ≥ 4.5:1 on accent-soft, `--tv-bad-ink` on bad-soft, and white on `--tv-accent-ink`. Mark tokens `--tv-mark`, `--tv-bad` and `--tv-accent` are ≥ 3:1 on the same three backgrounds, and `--tv-mark` also on both band composites. `--tv-good` is ≥ 3:1 on `--tv-panel` and `--tv-canvas` only (2.93:1 on fill-2 over panel); on bands it always carries the 1 px panel ring. `--tv-ink-4` is exempt, and a lint rule rejects `var(--tv-ink-4)` in any `color` declaration.
- Reduced motion sets every duration to 0, including view-switch and level-switch animations.
- Color is never the only signal: every status has a glyph and a word ("✕ failed 1"), failed dots are larger, finding pins differ in shape, and gaps are dashed.

## 8. Electron integration (M5)

### 8.1 Window lifecycle

`openTraceWindow(sessionId)` in `apps/desktop/src/main/index.ts` creates a `BrowserWindow` with width 1440, height 900, `minWidth: 1000`, `backgroundColor: "#FFFFFF"` (the main window's `#14161a`, index.ts:58, would flash through a light page), `show: false` until `ready-to-show`, and the main window's `webPreferences` and preload (`contextIsolation`, `sandbox`, no `nodeIntegration`, `webSecurity`, index.ts:54-79). It loads `trace.html` with `{query: {session: sessionId}}`. One window exists per session: a second `trace:open` for the same id focuses it. Trace windows block `will-navigate` and deny `window.open` through `setWindowOpenHandler`. Closing one removes it from the map; closing the main window closes all trace windows.

### 8.2 Build entry

`apps/desktop/src/renderer/trace.html` is the second Vite input (apps/desktop/vite.config.ts:12-13 becomes `input: {main: "src/renderer/index.html", trace: "src/renderer/trace.html"}`). It carries the same CSP meta as index.html: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'`. Its entry `renderer/trace/main.tsx` reads `session` from `location.search`, builds `createIpcTraceSource(bridge.trace, sessionId)`, and mounts `<TraceViewer source host />`. It never imports `styles.css`; the viewer brings its own CSS Modules, including the Inspector's scoped `:global(.d2h-*)` rules for CodeDiff. `default-src 'self'` blocks `data:` URIs, so the desktop and dev-host Vite configs set `build.assetsInlineLimit: 0`, and CSS Modules draw the dot background and the progressive hatch with `radial-gradient` and `repeating-linear-gradient`, never `url(data:…)`.

### 8.3 IPC source and polling

`createIpcTraceSource` (renderer/trace/ipc-source.ts) implements `TraceSource`: `summary()` calls `trace:listSessions {sessionId, limit: 1}`; `rows()` calls `trace:rows`; `payloads()` calls `trace:payloads`; `now()` returns `Date.now()`, since live source times are wall-clock. The shell's DataController pages to `lastSeq` on open (progressive state), then polls every 1 s per §5.5.

### 8.4 Trace button

A "Trace" button beside Inspect (apps/desktop/src/renderer/components/Header.tsx:80) invokes `trace:open {sessionId}` for the active session and is disabled without one. It never calls `session.switchTo` (SessionSwitcher.tsx:46), whose handler runs `reloadPending` (ipc.ts:264-279).

### 8.5 Request changes handoff

`ViewerHost.requestChanges` invokes `trace:requestChanges {sessionId, selected, text}` (schema in §5.4). The main handler checks that the session exists through `listSessions({sessionId, limit: 1})`, restores and focuses the main window, and pushes `composer:prefill {sessionId, text}` to the main renderer. WorkspaceHost applies it only when its active session matches: it appends the text to the composer draft (WorkspaceHost.tsx:402, :833) on a new line, leaves the instruction mode unchanged, focuses the textarea with the caret at the end, and never sends. For another session it holds the note as pending and shows an inline notice "Trace note for another session · Switch" with a "Dismiss" button; Switch is the user's explicit `switchTo`, and only after that switch does the held note apply to the new session's composer, by the same append rule. A draft of only newlines counts as empty. The handler's dependencies are the TraceReader, the main window reference and `sendToRenderer`; it cannot reach the writer connection, the runtime or the instruction router.

### 8.6 Channel allowlist

`openTraceWindow` records the new window's `webContents.id` before calling `loadFile`. The `handle` wrapper accepts non-`trace:*` channels and `trace:open` only when `event.sender.id` equals the current main window's `webContents.id`; `trace:listSessions`, `trace:rows` and `trace:payloads` from the main window or a recorded trace window; and `trace:requestChanges` only from a recorded trace window. Every other sender gets `UNTRUSTED_SENDER`. The trace window therefore makes no telemetry write, though `view_switched` exists (docs/SPEC.md:598), and cannot call any agent, decision, session or repo channel even though it shares the preload.

### 8.7 Smoke and parity

`runSmoke` (index.ts:81-91) today checks only that the main window loads. M5 extends it (`apps/desktop/src/main/smoke.ts`): with `JEVCODE_SMOKE_TRACE=1` and `JEVCODE_DB` pointed at a replay DB (the flag without a DB fails instead of skipping), it opens a trace window for the newest session, waits for the `TRACE_READY <rows>` console marker, which `renderer/trace/main.tsx` logs from `ViewerHost.onReady`, and fails on any console error or CSP violation in either window. `trace-parity.test.ts` replays the five fixtures, then asserts that the IPC source and the exported bundle fold to deep-equal `TraceSession`s after the IPC summary and rows pass through the same `redactBundleValue` that `buildTraceBundle` uses (§5.7), so both folds see identical strings; the summed count must equal the bundle's `redactionCount`, which is at least 1 for oauth while the `token` rule still matches code (§16 risk 12). `TraceSession` carries no redaction count, and no meta field names the source (§6.2).

The M5 PR adds `packages/ui-catalog/src/zod-jitless.ts`, a side-effect module that calls `z4.config({ jitless: true })`, and makes `import "./zod-jitless.js";` the first line of packages/ui-catalog/src/catalog.ts: zod 4's object parser probes `new Function("")`, and under `script-src 'self'` Chromium logs that probe as a CSP violation even though zod catches it, which would fail the extended smoke in the main window. A call in the body of catalog.ts runs too late, because ESM evaluates its imports first and `@json-render/core` builds zod 4 object schemas at module load (lane 08 deviation 3, verified by a probe test). The trace window's closure uses zod 3 only (ui-catalog is imported through `./components/*`, and CodeDiff imports only diff2html and contract types).

## 9. Security and privacy

| Concern | Control | Where |
|---|---|---|
| Store readable by other local users | Directory 0700; DB, `-wal`, `-shm`, replay outputs and bundles 0600 | M0 (§4.1) |
| Secrets in persisted diffs | Secret-file basenames withheld (`.env*`, keys and certificates, SSH private keys, keystores, credential dotfiles); each PEM private-key block collapsed to one counted `[REDACTED:private_key]` line, also when its hunk ends before the END line; header-aware per-line redaction after the diff prefix; fixed `env_value` anchor; provider, bearer and URL-credential rules; idempotent `redactText`; 32 KiB cap; `redactions` counted | M1b (§4.3). A1-7 builds the basenames except `.pypirc` and `credentials`, the key blocks, the `env_value` fix and the cap; the rest is a §16 "Plan follow-ups" row |
| Secrets in exported bundles | `redactText` over every whole string before the 16 KiB clip, home directory → `~`, `redactionCount`; bundles are local files for the dev host and tests, and sharing outside the machine is out of v1 (§15) | M2 (§5.7) |
| Viewer writes | Second connection with `PRAGMA query_only = ON`; handlers receive only the reader; write-attempt test | M2 (§5.2, §5.4) |
| Trace window reaching write channels | Channel allowlist by sender `webContents.id` | M5 (§8.6) |
| Cross-repo reads | Accepted: `trace:*` reads any repository by design; a session id must exist in `sessions` | M2 |
| Untrusted agent text | Every payload string renders as a React text node; no `dangerouslySetInnerHTML` except diff2html output in CodeDiff, which escapes line content (a test renders a diff line containing `<img src=x onerror=alert(1)>` as text); no Markdown rendering and no auto-linking of agent text in v1; agent text never renders inside title bar, chip, badge or finding-title slots, so it cannot forge viewer chrome; `displayUntrusted` shows bidi and control characters in commands and paths as visible tokens (§6.8); review notes fence quoted text and write paths as inline code | M3, M4a |
| Network and Jev | Lint bans `fetch`, `WebSocket`, `window.jevcode` in the package; CSP `default-src 'self'`; system fonts | W0, M5 |
| Telemetry | None from the trace window (allowlist) | M5 |
| Sender checks | `assertTrustedSender` (ipc.ts:63-80) still accepts any `file:` URL; tightening it is a separate PR (§14) | Separate PR |

The trace window shows unredacted local data to the local user, exactly as the main window and DebugPanel do. docs/security.md records the file modes, the diff rule and the allowlist.

## 10. Performance budgets (R26)

Reference inputs: the trace-profile soak bundle (`JEVCODE_SOAK_PROFILE=trace`, `JEVCODE_SOAK_EXPORT`; its `consumedRows` recorded in docs/perf.md), the 75,000-row `synthetic-rows` stream for fold benchmarks, and a fast-check `TraceSession` of 60 chapters and 5,000 steps. The dev host's `?perf=1` HUD shows `performance.measure` results and DOM counts. M4a and M4b record their results in `docs/spikes/trace-viewer-spike.md` (C2-16, C3-12); at M5, D-8 copies every UI budget result to docs/perf.md and SPEC §13, because only A2-7 (W1) and D-8 (W3) edit docs/perf.md.

**Method.** Every budget is measured on one reference machine named in docs/perf.md (model, CPU, memory, OS, Node, Electron, display refresh rate). Single-run budgets (soak read, fold, append, first paint, full load, `layoutCanvas`) report the median of 5 runs after 1 discarded warm-up; p95 budgets use at least 300 samples. A budget whose Gate names a milestone blocks that milestone's exit when missed. A `Benchmark` budget never blocks, but a miss is recorded in docs/perf.md with a follow-up issue. §1's Performance criterion covers the milestone-gated budgets only. The HUD's paint mark is a `MessageChannel` message posted from the first `requestAnimationFrame` callback after the commit; it runs after that frame's style, layout and paint.

| Budget | Target | Gate | Measured by |
|---|---|---|---|
| Full soak-session read in main | ≤ 1.5 s | M2 exit | soak.mjs trace phase: `openTraceReader` + service, pages of up to 5,000 rows, each ending after 2 MiB of payload (§5.2), to `lastSeq` |
| `trace:rows` call in main (trace profile) | p95 ≤ 50 ms | M2 exit | soak.mjs trace phase, per page |
| Fold of 75k rows / one appended row | ≤ 500 ms / ≤ 2 ms | Benchmark | `vitest bench` over the 75,000-row `synthetic-rows` stream; the append runs `accumulate` + `finalize` on a state holding it (§6.10) |
| Soak first paint / full load | ≤ 300 ms / ≤ 2 s | M4a exit | HUD: from `performance.mark("tv:bundle-parsed")`, set right after `JSON.parse` of the bundle and before `TraceBundleSchema` validation, to the paint mark after the first commit that renders at least one spine row (first paint), and to the paint mark after the commit where `loadedThroughSeq === lastSeq` (full load). Median of 5 cold loads |
| `j` to painted | p95 ≤ 16.7 ms of work, vsync wait excluded | M4a exit | HUD: 300 `j` presses on the soak bundle in Hybrid at Chapter level; work = keydown `event.timeStamp` → the commit's layout effect, plus that frame's rAF → the paint mark. The wait for vsync alone is 0–16.7 ms, so it is excluded |
| Overview layout + paint at Session level | p95 ≤ 4 ms; ≤ 150 overlay nodes | M4a exit | HUD over a scripted pan and zoom sweep |
| Anchor drift (spine and canvas) | ≤ 1 px | Smoke | `?selftest=drip` on oauth and on the soak bundle, with the spine scrolled to its middle and one expanded finding above the anchored row, records the maximum drift of the anchored row |
| `layoutCanvas` fresh / sticky | ≤ 2 ms / ≤ 0.5 ms | Benchmark | `vitest bench` on the 60-chapter session |
| Canvas pinch at Step level (~4k nodes, 300 edges) | ≤ 5% of frames dropped in Electron 33: each rAF interval is rounded to a whole number of refresh intervals, and the p95 of the rounded intervals is ≤ 1 refresh interval | M4b exit | Spike harness on a 60 Hz display (ProMotion set to 60 Hz): rAF intervals during a scripted zoom sweep 0.35 → 2 over 3 s |
| View switch | Restore painted in the toggle's frame; never a 0 × 0 fit | M4b exit | HUD: 20 switches with `1`/`2`; each passes when, at the paint mark after the switch commit, the shown view's camera already equals its restored camera (Canvas world transform; Hybrid `u0`/`k`) and its `main` rect is non-zero. Zero misses. The jsdom switch test asserts only the restored camera values and the non-zero fit |
| Live tick (poll apply + selectors + commit) | p95 ≤ 16 ms | M5 exit | HUD in the dev host with `createStaticBundleSource(soak, {drip: {rowsPerTick: 20, intervalMs: 1000}})` starting at `lastSeq − 2000`, plus the mock-adapter session in the trace window |
| Soak open in the Electron trace window (trace profile) | First paint ≤ 500 ms / full load ≤ 3 s | M5 exit | Extended `runSmoke` with `JEVCODE_DB` = the DB kept by `JEVCODE_SOAK_KEEP_DB`, from `trace:open` to `TRACE_READY` and to the last page committed |

If the live-tick budget is missed, selectors switch to incremental appends before the fold moves to a worker.

## 11. Testing strategy

Tests extend existing suites where they exist, use fixtures as inputs, and derive expectations from the fixtures' known content (oauth's failed test, the claim at +0:43), not from implementation code. New dev dependencies in `packages/trace-viewer`: jsdom 30.1.0 (already locked through vitest), `@testing-library/react` 16.3.3, fast-check 4.10.1 (locked, pnpm-lock.yaml:1541).

| Milestone | Tests |
|---|---|
| M0 | `db.test.ts`: modes 0700/0600 including `-wal`, POSIX only |
| M1a | `jsonl.test.ts:49-113`: start/complete pairs share a `callId`; reasoning never becomes `agent_message`; `turnId` on every event. `codex-adapter.test.ts:190-203`: SIGINT then `turn.completed` yields one `agent_interrupted`, state `paused`, no `agent_failed`. Steer and stop each log one `agent_interrupted`; a decision answer with an instruction emits no `agent_interrupted`, and a steer while no process runs emits none. `session:stop` through IPC leaves state `paused`, `endedAt` null and exactly one `agent_interrupted {reason: "stop"}`; stop, then `agent:resume`, relaunches `codex exec resume <threadId>` and the session reads `running`. `resume-budget.test.ts`: the failure is persisted. A test run's `command_executed` and `test_result` carry its `callId` as `sourceCallId`. `rebuild.test.ts` replays pre-change rows |
| M1b | Collector-order and zod-order facts share one id; an unchanged recollect emits nothing, with one `diffHash` call and no `prepareDiff` call, an edit emits one fact, each fact reaches the sink once (`git.test.ts:153-195`); `+STRIPE_KEY=…` is redacted, the cap cuts at a hunk boundary with `truncated`, `.env` and `id_ed25519` are withheld while `id_ed25519.pub` is stored, a second redaction pass counts 0; a private key added inside `src/config.ts` is stored as one `+[REDACTED:private_key]` line with `redactions: 1`; a key block whose hunk ends before its END line (`deploy/key.txt`) is redacted to the end of the hunk; `CERTIFICATE` and `PUBLIC KEY` blocks are kept; a removed line `-- password=hunter2` inside a hunk is redacted; the redactor.test.ts cases of §4.3 rule 4 except the `token` rule, whose tests (`token: string`, `verifyIdToken(token: string)` and `token: randomBytes(32).toString("hex")` produce 0 redactions) move to its separate PR (§14); `clustering.property.test.ts`: `agentCallIds` ⊇ every `sourceCallId` on the unit's facts; the no-strip guard; `validate-fixtures.mjs` diff counts |
| M1c | Suppression rows carry the real `clientKind` and `pass`; graph nodes carry domain ids; AgentEvent nodes do not collapse on equal ts |
| M2 | `trace-reader.test.ts`: pages cover `1..lastSeq` exactly once; excluded types never appear; a write through the reader throws; one snapshot per page; a page ends after the row whose payload passes 2 MiB of UTF-8 (2-byte characters count twice), a single 3 MiB row makes a page of one, and paging from `nextAfterSeq` reads every row once. `trace-ipc.test.ts`: read-only proof (§5.4); unknown session ids and an empty `sessionId` string rejected; a zero-event session is readable by exact id and yields `{rows: [], nextAfterSeq: null, lastSeq: 0}`; other-repo sessions readable; request bounds; a page stops after 2 MiB of payload with `nextAfterSeq` set, and the next call resumes there. `trace-service.test.ts`: a 20 KiB `stdout` becomes exactly its first 4,096 bytes, the marker `[4096 bytes clipped]` and its last 12,288 bytes, with `clipped: true`; the 16 KiB bound is measured in UTF-8 bytes and cuts fall on code points; a 30 KiB `git_hunk` `diff.text` passes through byte-identical while the same text in a message is clipped. `trace-bundle.test.ts`: a private key that straddles the 4 KiB head cut of a 40 KiB stdout leaves no key line in the bundle, the row is `clipped` and `redactionCount` is 1. `cli-entry.test.ts`: the oauth bundle parses; a planted `token=tok_4f9a2c1e` is redacted; every `fact_` id in the final units' `evidence` resolves to exactly one row `factId`; on POSIX, `<outDir>` is 0700 and `replay.db`, `trace.json` and the `export --out` file are 0600 |
| M3 | `fold.fixtures.test.ts` (five fixtures through `PipelineCoordinator` with a units-store hook, via `src/test-support/fixture-rows.ts`, which may import semantic-core as a dev dependency and is outside the model lint block): oauth lines 43-47 become one failed test step (14/1/0); `claim_contradicted` cites oauth 46/48 and api-break 14/17; oauth lines 29-32 are noise; decision rows 37→39 form one step with the answer absorbed; `expected-findings.ts` holds, per fixture, the expected `(ruleId, severity, anchor row located by content)` list, written from the fixture files before the fold exists and compared for equality (no generated snapshots). `fold.parity.test.ts` (fast-check): a whole fold equals any batch split; a redelivered seq changes nothing. `fold.mutations.test.ts`: dropping oauth's `test_result` leaves one failed test step (exit 1, no counts) and marks `claim_contradicted` and `failing_tests` inactive in `coverage.signals` with `missing: ["test_results"]`; a `src/test-support` session with an agent `file_changed` claim for `a.ts` and no repo observation before its turn closes adds `missing_evidence` at the claim's seq; a steer yields one instruction step; a decision answered with an instruction yields no instruction step; a two-bullet message before the first edit becomes the plan and a one-bullet message does not; a corrupt payload adds `invalid_row` and the fold continues; `agent_completed` removed before an `agent_started` gives an interrupted turn and `unpaired`. `signals.test.ts`: the lexicon table of §6.6 (claims: "OAuth implementation complete; all checks pass.", "The endpoint change is complete and all tests pass.", "143 tests pass (128 existing, 12 new).", "The migration is done."; not claims: "Not all tests pass yet.", "Tests pass except the flaky one.", "I haven't finished the migration.", "Running the tests now.", "I'm done reading the file, next I will complete the setup.", "The migration is not complete.", "unverified"); a positive and a near-miss per signal (a claim after a later passing rerun of the failed target, fail → pass without an edit, exit −1, an unknown clamp id, an info-only clamp row that raises no finding and leaves a `pipeline` noise step); tests failed, then lint passed, then "All checks pass." is contradicted; a `grep -r build src` that exits 1 does not contradict a claim; on oauth and api-break, `FINDING_ORDER[0]` is `claim_contradicted` on the claim step. `registry.test.ts`: every schema variant, `EVENT_TYPES` entry, clamp id, kind and signal is mapped with non-empty metadata; `pnpm -r typecheck`, `pnpm --filter x lint`, `pnpm --filter=web build`, `pnpm exec tsc -p tsconfig.json` and `npx vite build` are checks; `pnpm add eslint`, `ls build`, `grep -r build src`, `git commit -m 'fix lint'` and `cat tsconfig.json` are plain commands; `pnpm test -- --grep build` is a test. `ui-fields.test.ts` (B-12): a steer's echoed message joins its relaunch's instruction step; a queued instruction stays the instruction item of the turn that delivers it; a decision relaunch opens its turn without an instruction step, whichever row comes first. `format.test.ts`: emoji and Hangul truncation; a command containing U+202E renders the escape token |
| M4a | Property: `time-scale` (monotone, round trip on active segments, append-stable, continuous live edge, identity on the five fixtures); `viewport` (zoom keeps its anchor fixed, `screenToWorld ∘ worldToScreen` identity, `fitBounds` contains its box); `overview-layout` (pan changes only the offset, problems survive at every k, pins never overlap); `spine-rows` (playhead and pinned rows never elided, keys stable across prefixes; oauth yields one test row and an expanded claim at +0:43); `reduce` over random actions (selection ∩ brush, playhead in brush, switch-and-back identity excluding `cameras`, Raw never survives a selection change, `lastSeenSeq` monotone, programmatic moves never bump `focusRev`, a collapsed critical finding stays collapsed). jsdom, each test stubbing its own `getBoundingClientRect` and `ResizeObserver`: shell (`shell.test.tsx`: on oauth the open default selects the claim step and sets no `tv:initial-selection-painted` mark before a frame runs and exactly one after it; a session that opens in Live sets none); keyboard (`event.code`, IME, Esc order, one `tabindex=0` per region, Space inert in `main`); Inspector (Summary default, Raw lazy and reset, Request changes only with a host); live (drip raises "N new" and never moves focus); tokens (contrast); `paint.ts` against a recording 2D context (red ticks survive binning); ui-catalog `components.test.tsx`: a two-hunk diff keeps real line numbers; a diff line with markup renders as text |
| M4b | `canvas-layout.property.test.ts`: P1–P10 with a generator of turns, chapters, story items, noise, loose findings, id churn, merges, kind flips and skewed arrivals. Examples: the oauth table fresh and under a one-row drip, every placed key keeping its rect; a unit whose id changes keeps its key, rect and selection; chapter ↔ noise flips; a steer after 14 idle minutes gives one separator labelled with turn and idle time; a 5-minute test command alone makes no break. jsdom view switch: state carries across; a hidden view holds no listeners |
| M5 | `trace-parity.test.ts`; allowlist test: for every channel name in local-channels.ts outside `trace:listSessions`, `trace:rows`, `trace:payloads` and `trace:requestChanges`, a trace-window sender gets `UNTRUSTED_SENDER`, and `trace:open` from a trace window and `trace:requestChanges` from the main window are rejected; the extended smoke; one manual live session on the mock adapter showing appends that hold the focused row in place |

**Visual smoke.** `apps/trace-viewer-dev/scripts/smoke.mjs` builds the dev host, runs `vite preview` with the Electron CSP injected, and drives headless Chrome (`--headless=new --screenshot`) to capture oauth in both views at 1440 and 1000 px into `.smoke/` for comparison with the mockup renders. `?selftest=drip` drips rows in Review and writes the `onDiagnostics` payload (errors including CSP violations, the selected title, the maximum anchor drift) as JSON into `<pre id="selftest">`, read with `--dump-dom --virtual-time-budget=5000` (or over `--remote-debugging-pipe` if virtual time is flaky). It asserts ready, "Claim contradicts tests" selected, zero errors and drift ≤ 1 px. For Hybrid it also loads `?selftest=open` at 1440 px: the whole bundle, no drip and no input. After the `tv:initial-selection-painted` mark and three frames of unchanged geometry, the probe writes `OpenProbeResult {selected, claimStepId, claimRowInSpine, claimPinInOverview, paintedAtMs}` into `<pre id="selftest">`, or writes `paintedAtMs: null` at 4,800 ms if the mark never comes. The smoke asserts §1's "found at once" criterion on it and prints `hybrid: opened with <id> selected and in view, painted at <ms> ms`. It is a separate mode because the drip selftest scrolls the spine to its middle in the first frame after `onReady`. The smoke needs Chrome, so it runs outside `pnpm -r test`, at the M4a and M4b exits.

**VoiceOver check.** At the M4a exit a person runs C2-16 Step 6 in desktop Chrome on macOS, with oauth in Hybrid at 1440 px or wider. Pass requires all four: Tab moves Outline → main → Inspector and Shift+Tab walks back; the selected spine row reads "+0:43" and "Claim contradicts tests"; the Playhead slider reads "+0:43, Claim contradicts tests, step n of m"; after Alt+3 (Step level) the Range start and Range end sliders each read a "+m:ss" value. A fail returns C2-8, C2-12 or C2-11 to iteration, and the answers go in the spike doc's "M4a exit" section.

**Not tested, and why.** Pixel equality with the mockups (the smoke produces screenshots for human comparison; the layout table and invariants carry the geometry). Real Codex multi-turn resumes (no recording exists; turn logic is covered by synthetic rows). Gesture feel (the spike judges it by hand). VoiceOver output in automation (checked by hand: spike risk 4 and the M4a-exit VoiceOver check above). Frame budgets in CI (machine-dependent; the HUD and spike measure them). Playwright is not added.

## 12. Milestones and exit criteria

Every exit also requires `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r --no-bail --workspace-concurrency=1 test` and `pnpm lint` green. A failure only in a known flaky suite (evidence-engine `file-watcher.test.ts`, agent-codex `stall-watchdog.test.ts` and `codex-adapter.test.ts`; §16 risk 13) is confirmed by rerunning that package alone; any other failure is real. Shipping order is D9's: M0, M1a, M1b, M2, M3, M4a, M4b, M5. M1c merges any time after M1b and gates no other milestone.

| Milestone | Ships | Exit criteria |
|---|---|---|
| M0 | File modes (§4.1) | Mode test green; lands before M1b |
| M1a | Agent-event fields, turn and call ids, reasoning, paused interrupts, `sourceCallId`, persisted resume-budget failure, SPEC §1/§18 sign-off edit, §4.1 and codex-spike §3 | M1a tests green; `rebuild.test.ts` replays pre-change rows |
| M1b | Canonical ids, `agentCallIds`, diffs, change-only emission, double-push removal, no-strip guard, fixtures, validate-fixtures | M1b tests green; the median soak.mjs `ingestMs` over 3 runs is ≤ 1.10 × the median over 3 runs at the PR's merge base on the same machine, and the PR lists both medians and the unit counts before and after (lane 02 "Lane completion": runs alternate between head and a detached merge-base worktree, about 65 minutes on an idle machine). soak runs with `evidence: false` (scripts/soak.mjs:361), so a `vitest bench` covers the desktop `prepareDiff`: a 2 MiB lockfile-style diff and a 32 KiB source diff each ≤ 10 ms per call (`redactor.bench.ts`, A1-7; excluded from the build and from `pnpm -r test`); git.test.ts asserts that an unchanged diff triggers one hash and no `prepareDiff` call (A1-6) |
| M1c | `Decision.ts`, `pass`, suppression log, graph domain ids, SPEC §4.3/§8.5 | Tests green; does not block M2–M5 |
| M2 | `trace.ts`, TraceReader, trace-service, IPC handlers and API namespace, bundle, export CLI, soak read timing | Tests green; full soak read ≤ 1.5 s and `trace:rows` p95 ≤ 50 ms in main |
| M3 | Model: types, fold, derivations, five signals, format helpers, registries | Tests green; fold benchmarks recorded |
| M4a | Spike (first day); ui-catalog components export and CodeDiff fix; shell, Outline, Inspector, graphics, icons, tokens, store, keyboard, TimeScale, ticks, viewport math and controller (`xOnly`), Hybrid overview and spine, static source with drip, dev host, Hybrid smoke | Spike risks 1, 4, 5 pass; oauth opens in Hybrid with the contradiction at +0:43 selected and expanded; dev-host `vite build` passes (the browser-safety proof); M4a budgets; smoke green, including §1's `?selftest=open` assertion at 1440 px; the VoiceOver check (§11, C2-16 Step 6) passes on all four items and is recorded in the spike doc; the product review-gate session (docs/IMPLEMENTATION-PLAN.md:153, §1) held and recorded, and a failed gate returns the UI to iteration before M4b |
| M4b | Canvas layout, routes and minimap, `uniform` mode, Canvas view, `<Activity>` switch with `1`/`2`, Canvas smoke | Spike risks 2, 3, 6, 7 pass; oauth in Canvas matches the §7.5 table; switch tests pass; both smokes green; M4b budgets |
| M5 | Trace window, `trace.html`, IPC source with poll, Trace button, handoff, allowlist, smoke, parity test | Parity, allowlist and smoke green; manual mock-adapter live session; live-tick and soak-open budgets; budgets recorded in SPEC §13 and docs/perf.md |

**Parallel execution waves.** Development runs in four waves of parallel lanes, each lane in its own worktree and plan file (`docs/superpowers/plans/2026-09-28-trace-viewer-01` to `-08`; the base index covers W0, A1, A2 and B, the UI index covers C1a to Db). W0 merges first as one additive PR (types, optional schemas, dependencies, scaffolds) with no runtime behavior change. Inside a wave, lanes merge in the order listed; a later wave starts from `main` after the previous wave merged. User-visible behavior still ships in D9 order: Da merges in W2 before M4b, but its channels stay inert until Db adds `trace.html`.

| Wave | Lane (plan file) | Contents | Depends on |
|---|---|---|---|
| W0 | Contracts foundation (01) | Every new dependency (`@tanstack/react-virtual` 3.14.13 with a check that the resolved virtual-core has `anchorTo`, `followOnAppend` and `scrollEndThreshold`; `d3-zoom` and `d3-selection` 3.0.0 as the spike risk 1 fallback; `@testing-library/react`, `@testing-library/user-event`, jsdom, fast-check; dev-host Vite and plugin-react at the desktop's versions); the `./sources` and ui-catalog `./components/*` exports; `assetsInlineLimit: 0`; R6 browser-safe contracts and `/node`; `canonical-json.ts`; `trace.ts` schemas; every optional capture field from §4 as schema only; `packages/trace-viewer` scaffold with the model and `src/layout/**` ESLint blocks; model types (§6.2, including `LEVELS`, `originMs` and the R25 fields); the session-bound `TraceSource`; `apps/trace-viewer-dev` scaffold | — |
| W1 | A1 capture (02) | M0, M1a, M1b, M1c producers, fixtures and SPEC edits | W0 |
| | A2 read path (03) | M2: TraceReader, trace-service, `trace:*` IPC and API namespace, bundle, export CLI, soak read timing | W0 |
| | B trace model (04) | M3: fold, derivations, five signals, format, search and lookup, WorkspaceHost labels; fixture tests select rows by content, so they pass on the W0 fixtures and again after A1's | W0 |
| | C1a visual primitives (05, part A) | Tokens and the contrast test, the icon family, the seven mini graphics and their scales | W0 |
| | C1b viewer core (05, part B) | The spike on its third task (C1-7, rulings in `docs/spikes/trace-viewer-spike.md`); viewport math and controller, TimeScale and ticks, TraceIndex and tone, view-state reducer, store, location and keymap, overview and spine row layouts, static bundle source with drip; driven by `src/test-support` sessions, never by B's runtime | W0 |
| W2 | C2 shell + Hybrid, M4a (06) | DataController, `TraceViewer`, Shell, title bar, Outline, Inspector, keyboard layer, shared view parts, Hybrid overview and spine, dev host wiring, Hybrid smoke | W1 (B's runtime, C1a, C1b) |
| | C3a pure canvas layout (07, part A) | Canvas levels, items, placement, routes, minimap model; P1–P10; the §7.5 oauth table | W1 (B's fold, C1b's `time-scale.ts` and `trace-index.ts`) |
| | Da Electron window plumbing (08, part Da) | `openTraceWindow` and the window registry, the sender allowlist, `trace:open`, `trace:requestChanges` and `composer:prefill` in main | W1 (A2) |
| W3 | C3b Canvas view + switch, M4b (07, part B) | Canvas view (frames, world, edges, overlay, minimap, toolbar, camera rules), the `<Activity>` view switch on `1`/`2`, Canvas smoke | W2 (C2, C3a) |
| | Db Electron trace entry + live, M5 (08, part Db) | `trace.html`, `createIpcTraceSource` and the 1 s poll, Trace button, composer prefill, extended smoke, parity test, M5 budgets and docs | W2 (C2, Da) |

The shell, Outline and Inspector moved from W1, where earlier drafts put them in a "viewer foundation" lane, to W2 with Hybrid (C2): they call lane B's runtime (`formatOffset`, `pickGraphic`, `describeGraphic`, `searchSteps`, `compareFindings`, the fold), which does not exist until B merges. C1a and C1b consume only W0 names, so they stay in W1 beside A1, A2 and B. Merge order: W1 A1 → A2 → B → C1a → C1b; W2 C2 → C3a → Da; W3 C3b → Db.

## 13. Compatibility and migration risks

| Risk | Mitigation |
|---|---|
| A required field breaks `rebuildOnBoot` for existing databases (db.ts:431-457) | Every new field is optional; `rebuild.test.ts` replays pre-change rows; no `.strict()` |
| Units recorded before M1b cite ids that match no row (0 of 64 locally) | Approximate time-window join, `≈` chip, `evidenceLinks` counts (D11) |
| Change-only emission changes live clustering | Intended; soak reports unit counts before and after; fixtures unaffected |
| `agentCallIds` in `unitSignature` adds `change_unit` versions | Bounded by the number of calls; soak checks the row count |
| Interrupted sessions now stay `paused` | Intended (D10); adapter and runtime tests updated; old sessions keep their recorded `agent_failed` |
| A stopped session stays `paused`, but `agent:resume` needs a live runtime session (`requireSession`, pipeline-runtime.ts:1243-1251) | M1a keeps the stopped `ActiveSession` registered (§4.2); after an app restart, §16 risk 9 |
| Reasoning leaves the Conversation tab (WorkspaceHost.tsx:141-149) | Intended |
| Diffs grow the DB | 32 KiB cap per fact, change-only emission, M0 file modes first |
| Record routing tries `EvidenceFactSchema` first (pipeline-runtime.ts:334) | Agent events never carry `repoId`; a comment says so |
| `symbolId` moves to `/node` | Digest pinned by `id.test.ts`; `change_unit_symbols` rows stay valid |
| CodeDiff keeps real `@@` headers | Line numbers change in rendered diffs, not golden props; ui-catalog test covers two hunks |
| Fixture line numbers shift in M1b | Tests locate rows by content |
| No SQL migration | Nothing to back-fill or roll back; older builds can open the DB |
| Replay DB times are replay wall time | The model's clock uses only source times (§6.5) |

## 14. Adjacent fixes shipped as separate PRs

| Defect | Anchor | Why separate |
|---|---|---|
| Guardrail evidence is broadcast to every unit: one `rm -rf` clamps every unit to `required` | jev-router/src/state.ts:218, :55-63 | Changes live attention and eval labels |
| Destructive and security-path pattern false positives (SQL verbs anywhere, `/token/i` on `tokenizer.ts`, `.env` on `.env.example`) | contracts/src/security.ts:21-23; jev-router/src/patterns.ts:11-19 | Changes live guardrails; needs near-miss tests. The viewer shows them as known false positives meanwhile |
| WorkspaceHost restores the first 2,000 rows and DebugPanel shows the first 200 | WorkspaceHost.tsx:452; DebugPanel.tsx:65 | Needs a tail read; independent of the viewer |
| `diffStatsFor` sums cumulative, duplicated hunks | jev-router/src/state.ts:41-53 | M1b reduces the inflation; the fix (latest hunk per file) changes Jev inputs |
| `debug:*` lacks an ownership guard and falls back to `?? ""` | ipc.ts:375-419 | Hardening outside the trace path |
| `assertTrustedSender` accepts any `file:` URL; navigation is not blocked in the main window | ipc.ts:63-80; index.ts:54-79 | Hardening; the trace window already blocks navigation |
| Desktop tests can run against a stale `dist` | apps/desktop/package.json:10 | Add a `pretest` build |
| The `token` redaction rule rewrites code such as `verifyIdToken(token: string)` and `token: randomBytes(32)…` (the §4.3 rule 4 change, with its three 0-redaction tests) | apps/desktop/src/main/pipeline/redactor.ts, `token` rule | Fails safe; changes every redacted surface (stored diffs, bundles, Jev prompts) and belongs with the pattern false positives above (§16 risk 12) |
| agent-codex `stall-watchdog.test.ts` fails in serial full runs and passes alone | packages/agent-codex, at 144c7fb | Pre-existing timing flake, not caused by the viewer (§16 risk 13) |

## 15. Out of scope and later

- Codex rollout and Claude transcript importers; multi-agent trees and sub-agent cards.
- Dark mode (a second token object).
- Lenses (Story, Changes, Risk) and entity highlighting; cross-session search; the stdout search haystack.
- Supervisor comments and any annotation store; sharing or export outside the machine, which would first blind hashed ids (`factId`, `diff.hash`) per export.
- Token and cost lanes (no usage is captured); `agent_plan`, `usage`, `status`, agent `file_changed.kind`, MCP `server`/`isError`; nullable `exitCode`.
- Signals `test_weakened` and `verification_bypass`.
- SQL migrations, derived columns, covering indexes, join tables, columnar responses, `trace:around`, `trace:aggregates`, push channels; the legacy fact-id resolver.
- A persisted location across window reopen; automatic Tidy; a Hybrid minimap; brush editing in Canvas; dimming after the playhead.
- `replay --json`; rendering stored `ui_snapshot` specs; chapter version history; non-file entities.
- WebGL or worker painting; moving the fold to a worker (only if the live-tick budget fails).
- Playwright and Playwright-Electron E2E.

## 16. Open risks

1. **Rendering feel.** The hand-rolled controller may not match Figma or xyflow feel on a Magic Trackpad in Electron 33; the fallback is d3-zoom behind the same interface (spike risk 1).
2. **Claim lexicon recall.** Agents phrase success many ways; the lexicon misses paraphrases and flags quoted phrases. Fixture expectation tables bound it; real sessions will show misses.
3. **Chapter churn in long live sessions.** Unit ids change as files join, merges leave holes until Tidy, and `stats.holes` from soak bundles decides whether Tidy should run automatically when a session ends.
4. **Legibility beyond 150 chapters.** Canvas Session-level fit falls below legibility; the reader navigates by the minimap strip and the Outline. There is no fourth level.
5. **Pre-M1 sessions.** Approximate joins can attach an edit to the wrong chapter when units overlap in time.
6. **The plan heuristic** is a guess until `agent_plan` exists; when it misses, the canvas has no plan frame and the trunk starts at the intent.
7. **`@tanstack/react-virtual` anchoring** depends on virtual-core ≥ 3.16.0 behavior (`anchorTo`, `followOnAppend`); a regression there forces the hand-rolled fallback.
8. **Canvas2D and DOM drift** across displays with different DPRs (spike risk 5).
9. **Resume after an app restart.** The Codex thread id lives only in memory (no `sessions` column, although session-recovery.ts:20-23 says it is on the row), and no boot path re-attaches a paused session. After a restart, `agent:resume` fails with `SESSION_NOT_RUNNING` (pipeline-runtime.ts:1243-1251) for interrupted and stopped sessions alike. This predates the viewer; a cold re-attach needs a persisted thread id and is a separate change. The viewer is unaffected because it only reports the recorded state.
10. **Clock quality.** Codex times are PTY arrival times (`approxTime`), so durations under a second are approximate.
11. **Soak scale and read time.** A full default soak on 144c7fb stores about 455k events for its 9,993 records and runs about 11 minutes, not the 75,181 events docs/perf.md records; about 111k of them are trace rows with 168 MB of payload JSON (lane 03 measured 110,940 rows and a 177 MB bundle). A prototype full-session read took 1.9 s cold against the 1.5 s budget and 0.66–0.88 s warm. No budget changes: §10's Method reports the median of 5 runs after a discarded warm-up (A2-7's `traceReadMs` does the same), and the warm reads meet 1.5 s. The cold read is the risk: it counts against the M5 "soak open in the trace window" full load (≤ 3 s), and the M4a full load (≤ 2 s) folds about 1.5 times the 75k-row fold benchmark. A rerun of lane 03's code with the 2 MiB page bound and the 4 + 12 KiB clip, while a second full soak shared the machine, read 110,935 trace rows at a median of 857 ms (runs of 775–1,221 ms) and timed `trace:rows` at a p95 of 14.3 ms over 340 calls; the M2 budgets still need an uncontended run at A2-7. A2-7 records both profiles' numbers in docs/perf.md; a miss at M4a or M5 blocks that exit per §10.
12. **Token-rule over-redaction.** Until the separate `token` rule PR (§14), redactor.ts rewrites `verifyIdToken(token: string)`, so oauth's stored diff and `symbol_delta` read `token=[REDACTED:token]` and every oauth bundle has `redactionCount ≥ 1`. It leaks nothing. Tests must not assume `redactionCount === 0`; the parity test compares redacted rows from both paths and checks their count against the bundle's (§8.7).
13. **Flaky suite.** agent-codex `stall-watchdog.test.ts` fails in serial full runs (`pnpm -r --workspace-concurrency=1 test`) at 144c7fb and passes when its package runs alone. Lanes treat it like `file-watcher.test.ts` and `codex-adapter.test.ts`: a failure only there is confirmed by rerunning the package alone (§12). The fix is a separate PR (§14).
14. **Private-key redaction limits in stored diffs.** The key-block pass (§4.3) sees one diff at a time. A hunk that shows lines from the middle of a key, with neither its BEGIN nor its END line, stores those lines as they are. After a collapsed block the hunk's `@@` counts overstate its stored lines; how CodeDiff renders such a hunk is untested, and no fixture holds a key.
15. **Unanchored test pattern.** B-2's `TEST_COMMAND` still matches anywhere in a command (`\bvitest\b` and similar), and `commandKind` makes a matching command a `test` step even without a `test_result`. A `grep -r vitest src` that exits 1 therefore reads as a failed test run with a `missing_evidence` gap, paints red, and under the per-target rule (§6.6) contradicts every later claim in the session unless the same command later passes. Anchoring it the way `CHECK_COMMAND` is anchored is a lane 04 change.

**Spike (R28).** One day at the start of M4a, in the dev host and a hidden-then-shown Electron 33 window, on a synthetic session of 60 chapters plus 40 story frames at Step level (~4k DOM nodes), 300 edges and 5k lane marks, with a Magic Trackpad and a mouse, on a DPR 2 panel and a DPR 1 display (or `--force-device-scale-factor=1`). The spike also runs the trace page under the Electron CSP and fails on console errors, ahead of M5's smoke.

| # | Risk | Test | Pass | If it fails | Gates |
|---|---|---|---|---|---|
| 1 | Gesture feel and Electron input | Two-finger pan, pinch, wheel, Space-drag, hand tool, Shift+1, Shift+2, side by side with ArchitectureDelta in a scratch copy with zoom and pan on | `visualViewport.scale` stays 1 and the viewport's `scrollLeft`/`scrollTop` stay 0 throughout; during a pinch the world point under the cursor moves ≤ 1 px per event; in 10 blind trials (5 per controller, order randomized by a second person) the tester identifies the hand-rolled controller at most 7 times | d3-zoom behind `viewport.ts` | M4a |
| 2 | DOM raster cost during pinch at Step level | rAF-interval p95 during a zoom sweep 0.35 → 2, with and without gesture-time `will-change` | ≤ 5% of frames dropped (rounded intervals, 60 Hz, §10) on Chromium 130 without `will-change`; if only with it, keep it gesture-only | Cull by binary search on `x0`; cap Step lists | M4b |
| 3 | Text crispness at rest | `capturePage` at zoom 0.5, 1, 2 on DPR 1 and 2 after settle rounding | After settle at each zoom and DPR, a `capturePage` crop of a frame title differs from the same title rendered without a transform at `font-size × k` in ≤ 1% of pixels (any channel differing by > 16) | Round `k` to a 1/64 grid at settle | M4b |
| 4 | Keyboard and VoiceOver | j/k onto an off-screen frame; Tab order Outline → main → Inspector; sliders | VoiceOver reads the frame's `aria-label` ("Linking test, 1 failed, 14 passed, +0:33"); after every j/k, `document.activeElement` is the target frame and its rect lies inside the viewport inset by 48 px | Move a frame's full description into its Outline row | M4a |
| 5 | Hybrid DOM/canvas alignment | Pins vs marks during pan and pinch; drag the window between displays | ≤ 1 px drift; redraw on `devicePixelContentBoxSize` change | Paint pins on the canvas, keep DOM only for focus targets | M4a |
| 6 | View switch under `<Activity>` | Toggle mid-gesture and during a 1 Hz drip | Selection, playhead and brush deep-equal before and after; the time at the viewport center maps to within 1 px on the shown view's x map; the hidden view runs zero rAF callbacks; no 0 × 0 fit | Unmount the hidden view and restore from the store | M4b |
| 7 | Edge hairlines and ruler sync | Stroke width at zoom 0.5–2; ruler ticks vs frames during a pinch | 1.5 CSS px after settle; ticks within 1 px | Write `--tv-inv-k` every frame instead of at settle | M4b |

**Plan follow-ups.** Plan choices this spec does not adopt, rechecked on 2026-09-28 after the plan-fix pass on lanes 02, 03, 04 and 06 (§17). The spec text stands; the named task changes before its lane runs.

| Task | Change | Why |
|---|---|---|
| A1-7 | Implement the rest of §4.3 rules 3–4, or move it to a separate PR that lands before M1b stores diff text and update §4.3 and §11 M1b: header-aware line classification, the already-redacted guard in `redactText`, the `github_token`, `slack_token`, `provider_key`, `bearer`, `url_credential` and `aws_secret` rules, and the `.pypirc` and `credentials` basenames | Lane 02 deviation 13 now withholds the SSH private keys, keystores, `.npmrc`, `.netrc` and `.pgpass` and collapses private-key blocks, and leaves the rest out. Stored diffs therefore still keep a quoted `"apiKey": "sk-proj-…"`, a `Bearer …` value, a `ghp_…` token, a lowercase `aws_secret_access_key = …`, and the whole diff of a committed `.pypirc` or `credentials` file; without the guard, `redactions` and `redactionCount` can count one secret more than once |
| C2-5 `storyRows`, C3-1 `collectItems` | Take a turn's instruction item from the step whose `seqs` include `turn.startSeq`, not from the first `instruction` step in `turn.stepIds`; when that step is a decision step, show it once, as the decision (§6.6, §7.1, §7.5) | After B-12's dedupe, a turn opened by a queued instruction or a decision relaunch has no instruction step in its own `stepIds`, so the Outline shows no Intent row for it and Canvas uses the turn's first step as its instruction story item |

## 17. Revision notes

Review pass on 2026-09-28: 100 findings across four lenses; 98 applied, 2 rejected.

| Lens | Findings | Applied | Rejected |
|---|---|---|---|
| Decision fidelity | 12 | 11 | 1 |
| Completeness and internal consistency | 33 | 33 | 0 |
| Ambiguity and testability | 38 | 38 | 0 |
| Security, privacy and performance realism | 17 | 16 | 1 |

**Rejected.**
- Primary action filled with `#2F6BFF` (decision fidelity, §7.12): white on `#2F6BFF` measures 4.499:1, under R24's 4.5:1 text floor. The button keeps `--tv-accent-ink`, the accent family's text-safe shade, and §7.2 records the deviation from the mockups.
- HMAC blinding of `fact_…` ids and `diff.hash` in bundles (security, §5.7): bundles are local files, and sharing outside the machine is out of v1. §15 records blinding as a prerequisite for any sharing feature.

**Applied with changes.**
- Resumable stop (§4.2): the proposed cold re-attach needs a stored thread id, and the `sessions` table has none (migrations.ts:23-34). A user stop instead keeps the `ActiveSession` registered, and §16 risk 9 now covers resume after an app restart.
- Parity `meta.source` (§8.7): resolved by deleting `TraceMeta.source` (§6.2) and passing IPC rows through `redactRows`, which replaces the old `redactionCount === 0` precondition that oauth fails.
- Steer interrupt (§4.2): the emit sits in `deliverSteer` behind an option, because `spawnResume` runs inside it.
- `trace:requestChanges.text` (§5.4) is capped at 8,000 characters, not 4,000 or 2,000, because a note quotes up to 2,000 graphemes of claim text.
- `Chapter.schema.role` is `new | altered`: no v1 source identifies an unchanged, referenced table.
- A claim match past the 2,000-grapheme cut omits `claimSpan`; `text` is not extended.
- `j` to painted and first paint merge the two measurement proposals. They count style, layout and paint through a `MessageChannel` mark and exclude the vsync wait. They start after `JSON.parse`, not at `performance.timeOrigin`, because the M5 Electron open budget covers the full path.
- A chapter brush keys by `anchorSeq`, so the brush needs no remap on regroup (§7.8).

**Refinements of binding decisions.** Each is stated where it applies:
- R8: `createTraceState` takes the summary.
- R10: `claim_contradicted` compares a claim with the latest earlier run of every test or check target, not with the single latest run (§6.6; orchestrator ruling under D12, 2026-09-28).
- R20: switch-and-back identity excludes `cameras`.
- R21: the tool and brush keys are unshifted `v`, `h` and `b`.
- R23: `FINDING_ORDER` adds a rule rank within each severity.
- R25: the display clock is measured from `originMs`.

### Alignment with the final plans (2026-09-28)

The spec was checked against the final plan set (base index, UI index, lane files 01–08). Where a plan choice was sound and consistent with the binding decisions, the spec now says what the plan builds; where it was not, the spec text stands and §16 "Plan follow-ups" names the task that must change. Some earlier notes above (the `2,000`-grapheme cut, `redactRows`, `TraceMeta.source`) describe the pre-alignment text and are kept as history.

**Adopted from the plans.**
- §12 waves: W0; W1 = A1 capture, A2 read path, B trace model, C1a visual primitives, C1b viewer core; W2 = C2 shell + Hybrid (M4a), C3a pure canvas layout, Da Electron window plumbing; W3 = C3b Canvas view + switch (M4b), Db Electron trace entry + live (M5). The shell, Outline and Inspector moved from W1 to W2 because they call lane B's runtime.
- §6.2 model shape is W0-6's `types.ts` (`Lane`, `turnIndex`, `entityIds`, `noise: NoiseReason | null`, kinds `guardrail` and `attention`, `command`/`guardrail` detail objects, `TraceSessionSummary` as `meta`, `Coverage.approximateJoins`, `Hidden.unreceived`, `TestDetail.resultSeq`), because W0 and lane B implement it and the UI codes against it. Icons moved to `ui/icons`; registries are in `model/registry.ts`; the model keeps full prose text.
- §6.3: decision steps keep `step:<firstSeq>` and `decision:<id>` resolves to them; selection holds only `step:` and `unit:` ids.
- §6.4: `createTraceState(meta)` and `FinalizeOptions {live, state?, throughSeq?, nowMs?}`, because the summary already carries every meta field and no surface reads a bundle's `redactionCount`; unknown row types become `unknown_row_type` gaps.
- §6.6: the edit split on a new hunk (the git poll made the test-boundary rule raise false `missing_evidence`); duplicate polls as their own noise step (truthful `lastSeq`); the approximate window widened by 5 s at both ends with a latest-earlier-edit fallback (decision-born units joined nothing); failure-only units stay `observed` (nothing to approximate); the turn trigger without the `turnId` condition (M1a logs every interrupt, steer and stop); the plan's clause-scoped claim lexicon with clause-final completion words; claim scope over the session, not the turn (a resumed turn's claim still contradicts the last run); no gap for an unverified claim (it is not missing data); a finished test command without a result is `missing_evidence`.
- §6.7: `failing_tests` is critical when the command's final run also failed (R11's wording); `recovery_arc` requires only `test_results`; `clampId` names the most severe clamp.
- §6.8: B-1's label strings, pinned by base index §2.6 (`2 m 05 s`, WorkspaceHost's state labels), because B-11 puts them in the live desktop UI; `agentEventLabel` added; tone lives in `layout/tone.ts` because W1's layout needs it before B merges.
- §3.2, §7.7: dist-only packages with a `./sources` export and no `./testing` export; `src/test-support/`; no source alias for contracts or ui-catalog (a second contracts copy in tests) and a serve-only alias for the viewer; `TraceSource` is session-bound with `sessionId`; `TraceViewer` takes `pollMs`; the static source's `lastSeq` rule for parity; `?drip=` takes a start seq.
- §7.4, §7.5, §7.8, §7.13: `1 h → 52.5 s` (the formula's value); lane 07's late, turn, break and property-scope refinements, `shape: "direct"`, `memberSelIds`, `junctions`; brush writes keep the drawn brush and clear an outside selection; the effective playhead seq is `firstSeq`; frame labels use the model's chapter title.
- §5.4, §5.5, §5.7, §8.5, §8.7, §10: `TraceStableIdSchema` and `TRACE_NOTE_MAX_CHARS` (8,000; the viewer sends only the note's line 1); `pollMs`; `redactBundleValue` and its count rule; a note for another session is held until the user's own Switch, with Dismiss; zod jitless in a first-imported module (a call in `catalog.ts`'s body runs after its imports); `JEVCODE_SMOKE_TRACE`; M4a and M4b results go to the spike doc, and D-8 copies them to docs/perf.md and SPEC §13.
- §4.3, §11, §14: the `token` rule change leaves M1b for a separate PR, with its tests.

**Kept, with a plan follow-up (§16).** Instruction dedupe (B-3/B-8); the anchored check pattern (B-2); one latest-run comparison for `claim_contradicted` (B-7); no finding for info-only clamp rows (B-7, B-6); §4.3's redaction additions (A1-7); redaction before the clip, the 2 MiB page bound, the diff exemption and the 4 + 12 KiB clip (A2-2, A2-5). The UI index §1 amendments (`LEVELS`, `originMs`, `outputTail`, `nowMs`, `triad.clientKind`, the session-bound `TraceSource`, `exitLabel`, `displayUntrusted`, `read` on the edits lane, `compareFindings`, the `GraphicSpec` reshape, the W0-1 dependencies, exports and layout lint block) landed in lanes 01, 03 and 04 during this pass and need no follow-up.

**New open risks.** §16 risks 11 (soak scale: ~455k events, ~111k trace rows, 168 MB; a 1.9 s cold read against the 1.5 s budget, 0.66–0.88 s warm), 12 (token-rule over-redaction keeps oauth's `redactionCount ≥ 1`) and 13 (`stall-watchdog.test.ts` flake). No budget changed: the warm reads meet the M2 budget under §10's Method, and no other measurement contradicts a target.

**2026-09-28, plan-fix pass (lanes 02, 03, 04, 06).** The spec now states what the fixed plans build: the per-target `claim_contradicted` rule, an orchestrator ruling under D12 (§6.6, §6.7, removed from §15); no finding and `lifecycle` noise for info-only clamp rows, while every finding still pins its steps per R11 and W0-6 (§6.7); one instruction step per steer and the `startSeq` instruction item (§6.6, §7.1, §7.5); the anchored `CHECK_COMMAND` (§6.6); a finished test command without a `test_result` keeps its exit status, as §11 M3 and B-6 have it (§6.6); the extended withheld basenames and one-line private-key blocks in place of line-preserving ones (§4.3, §9, §11); redaction before the clip, the 2 MiB page bound, the `diff.text` exemption and the 4 + 12 KiB UTF-8 clip (§5.2, §5.3, §5.6, §5.7, §10, §11); the `?selftest=open` smoke assertion and the M4a VoiceOver check, closing index gaps G1 and G3 (§1, §11, §12); and the G2 bench and soak comparison (§12). §16 drops the B-2, B-3/B-8, B-7, B-6/B-7 and A2-2/A2-5 follow-ups, narrows A1-7 to what lane 02 leaves out, adds C2-5/C3-1, and adds risks 14 and 15.
