# Trace Viewer: Interfaces, File Map and Lane Index (W0, A1, A2, B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This index holds no steps. Each lane file (section 0) holds the TDD steps for its tasks and copies the interfaces below verbatim.

**Goal:** Fix every cross-lane contract for the trace viewer's foundation (W0), capture fixes (A1), read path (A2) and trace model (B), so four subagent-driven controllers can build them in parallel git worktrees without editing each other's files.

**Architecture:** W0 lands every shared contract, the new `@jevcode/trace-viewer` package, the Vite dev host skeleton and every npm dependency on one branch. After W0 merges, A1 (agent adapter, evidence engine, clustering and fixtures), A2 (a `query_only` SQLite reader, three `trace:*` IPC channels and the `trace.json` export) and B (a pure fold from `TraceRow`s to a `TraceSession`) run in parallel on disjoint files and merge in the order A1, A2, B. The UI waves (M4a, M4b, M5) come after and are outside this index.

**Tech Stack:** TypeScript 5.9 (NodeNext, strict, `verbatimModuleSyntax`), zod 3.25, pnpm 9.15 workspaces, vitest 3.2, fast-check 4.10, better-sqlite3 11, Electron 33, React 19.2, Vite 5.4, ESLint 9.39 flat config.

**Spec:** `docs/superpowers/specs/2026-09-28-trace-viewer-design.md`. Its sections follow the binding decision record: User decisions D1–D12, Accepted recommendations (data) R1–R6, (model) R7–R12, (UI) R13–R29, Out of v1, Separate PRs. This index cites those ids. On any conflict the decision record wins, then the spec, then this index, then a lane file. The UI waves (M4a, M4b, M5) have their own index, `docs/superpowers/plans/2026-09-28-trace-viewer-interfaces-ui.md`; its section 1 lists amendments to W0, A2 and B. This index has absorbed all of them (sections 2.2, 2.3, 2.5, 2.6 and 3), so lane writers read one contract here; section 6 below maps each UI index item to its place.

## Global Constraints

- Node `>=22` (root `package.json` engines). `newId` relies on `globalThis.crypto.randomUUID()` (R6).
- zod 3 only (`^3.24.1`, locked 3.25.76) in `@jevcode/contracts` and `@jevcode/trace-viewer`. zod 4 stays inside `@jevcode/ui-catalog`.
- Every new contract field is OPTIONAL. `rebuildSession` re-parses stored rows and throws on failure (packages/storage/src/db.ts:191-197). Avoid `.strict()`.
- `exitCode` stays `item.exit_code ?? -1` in capture (packages/agent-codex/src/jsonl.ts:246). The viewer renders `-1` as "unknown", never "failed" (R2).
- No SQL migration in v1: no new tables, columns or indexes; `LATEST_SCHEMA_VERSION` does not change (R5).
- The viewer never writes. `trace:*` handlers reach only a reader on its own `PRAGMA query_only = ON` connection, never `reloadPending`, the instruction router, Jev or the network (R5, D9).
- `packages/trace-viewer` takes no `@xyflow/react` dependency (R17: hand-rolled DOM viewport). `@xyflow/react@12.11.6` stays locked through `@jevcode/ui-catalog`. W0-1 adds R17's fallback `d3-zoom` 3.0.0 and its peer `d3-selection` 3.0.0 (both already locked), and checks that the resolved `@tanstack/virtual-core` 3.17.11 declares `anchorTo`, `followOnAppend` and `scrollEndThreshold`.
- `packages/trace-viewer/src/layout` (created by the UI lanes) is pure: it may import `src/model`, never `src/ui`, React, d3 or DOM, timer and clock globals, and `src/model` never imports `src/layout` (R19). W0-1's ESLint blocks enforce both directions.
- The model carries every field decision record R25 lists for the UI, plus what the UI index §1.2 adds (`LEVELS`/`Level`, `CommandDetail.outputTail`, `Chapter.triad.clientKind`, `TraceSession.originMs`, the `GraphicSpec` shapes). W0-6 declares them in `types.ts` (section 2.3), because the UI lanes C1a and C1b run in W1 on W0's types. Lane B derives them: `KIND_META[kind].lane` (B-2, a literal table), `exitLabel`/`displayUntrusted` (B-1), `Step.tMs`, `Step.startMs`, `TraceSession.originMs`, `CommandDetail.outputTail` and the live `durationMs` from `FinalizeOptions.nowMs` (B-3), `Chapter.evidenceLinks`, `current`, `noise`, `validationStepIds`, `triad.clientKind` (B-5), `Finding.anchorStepId`, `FINDING_RULE_RANK` and `compareFindings` (B-7), `pickGraphic`/`describeGraphic` in `model/format.ts` (B-10), and `Turn.planStepId`/`claimStepId`, the claim fields, decision `target` and the absorbed decision answer (B-12).
- The viewer's port is session-bound (spec §7.7): `TraceSource { sessionId, summary(), rows(request?), payloads(seqs), now() }` (section 2.3). The host picks the session; `apps/desktop` adapts `window.jevcode.trace` with `createIpcTraceSource(bridge.trace, sessionId)` in M5.
- Model (`packages/trace-viewer/src/model`) is React-free and hashes nothing. ESLint bans `react`, `node:*`, `electron`, `@jevcode/{storage,semantic-core,evidence-engine,jev-router,agent-*}` there (R7).
- Stable ids: `step:<firstSeq>`, `unit:<changeUnitId>`, `decision:<decisionId>`, `file:<path>`, `finding:<ruleId>@<version>:<anchorSeq>` (R9). Opaque after the first colon.
- IPC bounds: `trace:listSessions {repoId?, sessionId?, limit<=500}`, `trace:rows {sessionId, afterSeq?, limit<=5000}`, `trace:payloads {sessionId, seqs 1-50}` (R5; `sessionId?` is spec §5.4's exact-id lookup, which returns a zero-event session too).
- Strings longer than 16 KiB are clipped to head + tail with `clipped: true` (R5). Implemented as `TRACE_CLIP_CHARS = 16_384` UTF-16 code units.
- `git_hunk.diff`: `{hash (16 hex), bytes, text?, truncated, redactions, withheld?: "secret_path"|"not_captured"}`; diff text capped at 32 KiB cut at the last `@@` hunk boundary; `.env*`, `*.pem`, `*.key`, `id_rsa*` withheld (R3).
- Live follow = poll `trace:rows {afterSeq}` every 1 s until the session state is terminal (R5).
- Budgets: full soak-session read `<= 1.5 s` in main (R5). Full fold of 75k rows `<= 500 ms`; one appended row `<= 2 ms` (benchmark, not a CI gate) (R8).
- v1 opens jevcode sessions only (SQLite store, `replay.db`, `trace.json` bundles). No Codex-rollout or Claude-transcript importers. `TraceRow` stays source-agnostic (D2).
- Interrupt, steer and stop never mark a session failed. `agent_interrupted {reason: "interrupt"|"steer"|"stop"}` replaces the exit-time `agent_failed` (D10).
- Sessions recorded before M1 get approximate unit↔evidence joins with a header notice; no legacy-id resolver (D11).
- All new npm dependencies and every `pnpm-lock.yaml` change happen in W0-1 only.
- Commits: conventional commit messages (`feat(contracts): …`, `fix(agent-codex): …`, `test(storage): …`). Never add `Claude-Session:` trailers. Use the repository's configured git identity.
- Worktrees: never run `git stash` (the stash stack is shared by all worktrees); set work aside with a WIP commit. Create lane worktrees with `git worktree add -b <branch> <path> <base>`, never `-f`.
- Shell is zsh: write `${var}:suffix`, never `"$var:suffix"`, when a colon follows a variable.

## Review Focus

Five inputs the spec implies that no task's happy-path tests exercise. Each line names the test the owning task must add (section 3 repeats it on the task).

1. **A session recorded before M1** (no `turnId`, `callId`, `sourceCallId`, `agentCallIds`; unit `evidence` ids that match no row `factId`). Expected: every chapter that cites `fact_…` ids links `"inferred"` with `evidenceLinks.resolved === 0` and `evidenceLinks.approx > 0` (a failure-only unit that cites no fact id has no content-hash join to lose and stays `"observed"`), `coverage.approximateJoins === true`, steps pair with `provenance: "inferred"`, and no chapter reports zero evidence as fact. Tests: **B-5** `fold-chapters.test.ts` "legacy session joins by time window"; **B-8** `fold.fixtures.test.ts` runs every fixture assertion on the `legacy` variant.
2. **A live session that appends while the reader pages.** Expected: the union of pages covers every trace-type seq in `1..lastSeq` exactly once, and `cursorAfter(page)` never skips a row. Test: **A2-1** `trace-reader.test.ts` "pages stay gapless while the writer appends".
3. **Oversized strings** (1 MiB `stdout`, 40 KiB diff text). Expected: the row arrives with `clipped: true`, both halves intact, `factId` computed before clipping, and the page stays bounded. Test: **A2-2** `trace-service.test.ts` "clips a 1 MiB stdout to head and tail".
4. **Interrupt or steer while a command runs; Codex exit code missing.** Expected: exactly one `agent_interrupted` row; the open command step is `unknown`, not `failed`; the turn outcome is `interrupted`; no `agent_failed` problem. Tests: **A1-3** `codex-adapter.test.ts` "SIGINT during a command yields one agent_interrupted" and **B-3** `fold.test.ts` "interrupted turn leaves the open command unknown".
5. **Secrets and home paths in an exported bundle** (`token=…`, a `+STRIPE_KEY=sk_live_…` diff line, `/Users/<name>/…` paths). Expected: every string redacted, `$HOME` mapped to `~`, `redactionCount` counts hits, and `factId`s still resolve because they are computed before redaction. Tests: **A2-5** `trace-bundle.test.ts` "redacts tokens and maps home" (a `token=` message, an unprefixed `STRIPE_SECRET_KEY=` stdout line and `$HOME`; it passes before and after A1-7) and "maps home only at a path boundary and does not recount redacted markers"; **A1-7** `redactor.test.ts` "redacts a prefixed env line inside a diff and keeps the prefix" (the `+STRIPE_KEY=` diff line needs A1-7's widened `env_value` rule).

---

## 0. How to use this index

**Lane files.** Each lane file is a full writing-plans document (header, Global Constraints copied from above, Review Focus lines that belong to it, then tasks with Files / Interfaces / checkbox TDD steps).

| Lane | Wave | File | Branch | Worktree |
|---|---|---|---|---|
| W0 contracts foundation | W0 | `docs/superpowers/plans/2026-09-28-trace-viewer-01-contracts-foundation.md` | `tv/w0-contracts-foundation` | `/Users/jwpark/Projects/jevcode-tv-w0` |
| A1 capture (M0, M1a, M1b, M1c) | W1 | `docs/superpowers/plans/2026-09-28-trace-viewer-02-capture.md` | `tv/a1-capture` | `/Users/jwpark/Projects/jevcode-tv-a1` |
| A2 read path (M2) | W1 | `docs/superpowers/plans/2026-09-28-trace-viewer-03-read-path.md` | `tv/a2-read-path` | `/Users/jwpark/Projects/jevcode-tv-a2` |
| B trace model (M3) | W1 | `docs/superpowers/plans/2026-09-28-trace-viewer-04-trace-model.md` | `tv/b-trace-model` | `/Users/jwpark/Projects/jevcode-tv-b` |

**Rules for lane-file writers.**
- A task may touch only the files listed for it in section 3. Adding a file needs an edit to this index first.
- Section 2 is the only source of cross-lane names and types. Copy signatures verbatim into each task's Interfaces block. A lane may add private helpers and optional fields; renaming or removing anything in section 2 needs an edit here.
- Every task ends green on its own targeted tests plus the root checks in section 5, and ends with one commit.

---

## 1. File map

`new` = created, `mod` = modified. The owning task ids are in brackets.

### Root

- `pnpm-lock.yaml` mod: all new dependencies and the three new importers [W0-1].
- `eslint.config.mjs` mod: browser-safety bans for `packages/contracts/src` and `packages/trace-viewer/src`, the model→layout ban and the `src/layout` purity block (R19) [W0-1, W0-2].
- `docs/SPEC.md` mod: §2.2 package layout, §18 deferred list [W0-1]; §4.1–§4.3 contracts [W0-4]; §4.5 IPC, §15 bundle [W0-5]; §11 store file modes [A1-1]; §3.1, §3.1b and §10 interrupt semantics and the logged resume-budget failure [A1-3]; §7 change-only git emission [A1-6]; §3.7 diff redaction [A1-7]; §8.5 Jev pass and suppression logging [A1-10].
- `docs/spikes/codex-spike.md` mod: §3 mapping table (`callId`, `turnId`, `agent_reasoning`) [A1-2]; §3 exit row and §4 interrupt consequence [A1-3].
- `docs/security.md` mod: SPEC §12 checklist row 7, trace viewer read-only guarantee [A2-6].
- `docs/perf.md` mod: trace-read budget and soak numbers [A2-7].
- `docs/demo.md` mod: `replay export` usage [A2-6].
- `scripts/validate-fixtures.mjs` mod: `+`/`-` line counts of `git_hunk.diff.text` must equal `added`/`removed` [A1-9].
- `scripts/fixture-diffs.mjs` new: one-off generator that writes `git_hunk.diff` into fixtures from `repo/` → `changes/`, reconciles `added`/`removed` with the real diffs, stamps `turnId`/`callId`/`sourceCallId`, inserts the oauth `agent_reasoning` line and fixes the oauth failure text [A1-9].
- `scripts/soak.mjs` mod: time a full trace read before `rmSync`; export a bundle when `JEVCODE_SOAK_EXPORT` is set [A2-7].
- `fixtures/*/events.jsonl` mod: `turnId`, `callId`, `sourceCallId`, `diff`, one oauth `agent_reasoning` line, oauth failure text [A1-9].
- `fixtures/oauth/golden_specs/oauth-linking-test-failure.json` mod: failure text "expected null to be 7" [A1-9].
- `fixtures/README.md` mod: document the new optional fields [A1-9].

### packages/contracts (all W0)

- `package.json` mod: `"./node"` export; devDependency `fast-check` [W0-1, W0-2].
- `src/id.ts` mod: `newId` uses `globalThis.crypto`; `symbolId` removed [W0-2].
- `src/id.test.ts` mod: drop the two `symbolId` cases [W0-2].
- `src/node.ts` new: Node-only helpers (`symbolId`), exported as `@jevcode/contracts/node` [W0-2].
- `src/node.test.ts` new: pinned `symbolId` digests [W0-2].
- `src/browser-safety.test.ts` new: no `node:` specifier is reachable from `src/index.ts` [W0-2].
- `src/canonical-json.ts` new: `canonicalJson` [W0-3].
- `src/canonical-json.test.ts` new [W0-3].
- `src/agent-events.ts` mod: `turnId`, `callId`, `agent_reasoning`, `agent_interrupted` [W0-4].
- `src/agent-events.test.ts` mod [W0-4].
- `src/evidence.ts` mod: `GitHunkDiffSchema`, `git_hunk.diff`, `sourceCallId` [W0-4].
- `src/evidence.test.ts` mod [W0-4].
- `src/semantic.ts` mod: `ChangeUnit.agentCallIds`, `Decision.ts` [W0-4].
- `src/semantic.test.ts` mod [W0-4].
- `src/jev.ts` mod: `JevPassSchema`, `JevDecisionLog.pass` [W0-4].
- `src/jev.test.ts` mod [W0-4].
- `src/trace.ts` new: `EVENT_TYPES`, `TRACE_ROW_TYPES`, limits, `TraceRow`/`TraceSessionSummary`/`TraceRowsPage`/`TraceBundle` schemas [W0-5].
- `src/trace.test.ts` new [W0-5].
- `src/index.ts` mod: export `canonical-json` and `trace` [W0-3, W0-5].

### packages/ui-catalog

- `package.json` mod: `"./components/*"` export, so the viewer imports `@jevcode/ui-catalog/components/CodeDiff` [W0-1].

### packages/trace-viewer (new package)

- `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts` new: package scaffold with the `"."`, `"./model"` and `"./sources"` exports (`src/sources/index.ts` comes from UI lane C1b) [W0-1].
- `scripts/copy-assets.mjs` new: copies `src/**/*.css` into `dist/` after `tsc` [W0-1].
- `src/css-modules.d.ts` new: `*.module.css` typing for the UI waves [W0-1].
- `src/lint-boundaries.test.ts` new: runs ESLint on probe snippets to pin the import bans [W0-1, W0-2].
- `src/index.ts` new: package root barrel [W0-1, W0-6].
- `src/source.ts` new: session-bound `TraceSource` interface and `cursorAfter` [W0-6].
- `src/source.test.ts` new [W0-6].
- `src/model/index.ts` new: model barrel [W0-1, W0-6; each B task appends one export line].
- `src/model/types.ts` new: every public model type and stable-id helper, including the R25 UI fields [W0-6].
- `src/model/types.test.ts` new [W0-6].
- `src/model/format.ts` + `format.test.ts` new: labels and formatters [B-1]; `pickGraphic`, `describeGraphic` appended (R25) [B-10].
- `src/model/registry.ts` + `registry.test.ts` new: exhaustive rule tables [B-2].
- `src/model/rows.ts` + `rows.test.ts` new: `rowsFromPipelineRecords`, payload parsing [B-2].
- `src/test-support/fixture-rows.ts` new: fixture harness through `PipelineCoordinator` (test-only, excluded from build and from the model bans) [B-2].
- `src/model/fold.ts` + `fold.test.ts` new: public fold API, seq handling, gaps, hidden counts [B-3]; extended by B-4 to B-7 and B-12.
- `src/model/fold-state.ts` new: internal `FoldState`, step and turn drafts, display clock (not exported from the barrel) [B-3]; extended by B-4, B-5, B-12.
- `src/model/fold-agent.ts` new: turns, agent steps, start/complete pairing [B-3]; B-12 records the pending decision answer.
- `src/test-support/trace-builder.ts` new: test-only row builder [B-3].
- `src/model/fold-evidence.ts` + `fold-evidence.test.ts` new: evidence attach, tests and checks, validations, edits, entities [B-4].
- `src/model/fold-chapters.ts` + `fold-chapters.test.ts` new: chapters, decisions, guardrail and attention steps [B-5]; B-12 adds decision-answer absorption, decision `target`, `Chapter.current`/`noise`/`validationStepIds` and updates one B-5 assertion.
- `src/model/classify.ts` + `classify.test.ts` new: problems, noise, `missing_evidence`, live semantics [B-6].
- `src/model/signals.ts` + `signals.test.ts` new: signal registry, findings, coverage [B-7]; B-12 adds `matchSuccessClaim`, `isPlanText`, `markTurns` and the finding anchor and claim fields.
- `src/model/fold.fixtures.test.ts`, `src/model/fold.mutations.test.ts` new: five-fixture assertions and mutations [B-8]; B-12 updates the oauth decision assertion.
- `src/test-support/synthetic-rows.ts` new: 75k-row generator [B-9].
- `src/model/fold.parity.test.ts`, `src/model/fold.bench.ts` new: batch-split parity property and budgets [B-9].
- `src/model/search.ts`, `src/model/lookup.ts` + tests new, `src/model/graphics.test.ts` new: search, id resolution, mini-graphic spec tests (the functions live in `format.ts`) [B-10]. There is no `src/model/graphics.ts`.
- `src/model/types.ts` mod: `TestDetail.resultSeq` [B-4].
- `src/model/ui-fields.test.ts` new: R25 fields (pins the ones B-3, B-5 and B-7 derive, drives the ones B-12 derives) [B-12].

### apps/trace-viewer-dev (new app, W0)

- `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html` new: Vite dev host skeleton with a build-time Electron CSP, a node-builtin guard and no inlined assets (`assetsInlineLimit: 0`) [W0-1].
- `src/main.tsx` new, then mod: placeholder that imports both barrels so `vite build` proves browser safety [W0-1, W0-2, W0-6].

### packages/storage

- `src/db.ts` mod: `EVENT_TYPES`/`EventStoreType` re-exported from contracts (lines 53-70) [W0-5]; `openDb` file modes (lines 1523-1533) [A1-1].
- `src/db.test.ts` mod: `EVENT_TYPES` identity [W0-5]; POSIX modes [A1-1].
- `src/trace-reader.ts` + `trace-reader.test.ts` new: `openTraceReader` [A2-1].
- `src/index.ts` mod: export `openTraceReader` and its types [A2-1].

### packages/evidence-engine

- `src/symbol-diff.ts`, `src/symbol-diff.test.ts` mod: import `symbolId` from `@jevcode/contracts/node` (line 1) [W0-2].
- `src/collectors/commands.ts`, `commands.test.ts`, `src/collectors/tests.ts`, `tests.test.ts` mod: `sourceCallId` parameter [A1-4].
- `src/no-strip.test.ts` new: collector facts survive `EvidenceFactSchema.parse` unchanged [A1-5].
- `src/diff.ts` + `diff.test.ts` new: `PrepareDiff`, `diffHash`, `notCapturedDiff` [A1-6].
- `src/collectors/git.ts`, `git.test.ts` mod: `prepareDiff` injection, change-only emission [A1-6].
- `src/index.ts` mod: export `./diff.js` [A1-6].

### packages/semantic-core

- `src/clustering.ts` mod: `symbolId` import (line 16) [W0-2]; `agentCallIds` [A1-8].
- `src/ids.ts` mod + `src/ids.test.ts` new: canonical `factContentId` [A1-5].
- `src/fixtures.test.ts` mod: no-strip guard over `fixtures/*/events.jsonl` [A1-5]; one provenance assertion [A1-9].
- `src/coordinator.ts` mod: `agentCallIds` in `unitSignature` (lines 529-538) [A1-8].
- `src/clustering.test.ts`, `src/clustering.property.test.ts`, `src/coordinator.test.ts` mod [A1-8].
- `src/graph.ts`, `src/graph.test.ts` mod: domain ids in node data; AgentEvent nodes keyed by `callId` [A1-11].

### packages/agent-core and packages/agent-codex (A1)

- `agent-core/src/events.ts`, `events.test.ts` mod: `EventNormalizerContext.turnId` [A1-2].
- `agent-codex/src/jsonl.ts`, `jsonl.test.ts` mod: `callId`, `turnId`, `agent_reasoning` [A1-2].
- `agent-codex/src/codex-adapter.ts`, `codex-adapter.test.ts` mod: per-process `turnId` [A1-2]; `agent_interrupted` [A1-3].
- `agent-codex/test/fixtures/fake-codex.cjs` mod: env switch that answers ^C with `turn.completed` [A1-3].
- `agent-codex/src/delivery-queue.test.ts` mod: "keeps queued instructions when interrupted" expects `paused` and `agent_interrupted` [A1-3].
- `agent-codex/src/no-strip.test.ts` new: every mapped fixture event survives the schema unchanged [A1-5].

### apps/desktop

- `package.json` mod: dependency `@jevcode/trace-viewer` [W0-1].
- `src/renderer/components/WorkspaceHost.tsx` mod: two new `eventSummary` cases (lines 108-139) [W0-4]; labels imported from `@jevcode/trace-viewer/model` [B-11].
- `src/main/pipeline/pipeline-runtime.ts` mod: lifecycle and resume budget (lines 420-480, 761-790) [A1-3]; `sourceCallId` (lines 744-755) [A1-4]; `Decision.ts` (lines ~550, ~585) [A1-10].
- `src/main/pipeline/pipeline-runtime.test.ts` mod [A1-3, A1-4, A1-9, A1-10].
- `src/main/pipeline/resume-budget.test.ts` mod [A1-3].
- `src/main/session-service.ts` mod (`stopSession` keeps a stopped session `paused`, `endedAt` unset), `src/main/session-guard.test.ts` mod [A1-3]. A1 does not edit `ipc.ts`.
- `src/main/pipeline/evidence-runtime.ts` mod: `sourceCallId` [A1-4]; `prepareDiff` wiring, git and revert double-push removal (lines 106-132) [A1-7]. `evidence-runtime.test.ts` mod [A1-7].
- `src/main/pipeline/redactor.ts`, `redactor.test.ts` mod: prefixed `env_value`, diff preparation [A1-7].
- `src/main/pipeline/jev-stage.ts` mod + `jev-stage.test.ts` new: `pass`, real suppression logging [A1-10].
- `src/main/trace-service.ts` + `trace-service.test.ts` new [A2-2].
- `src/shared/local-channels.ts` mod, `src/shared/ipc-registry.test.ts` mod: `trace:*` request schemas [A2-3].
- `src/main/trace-ipc.ts` + `trace-ipc.test.ts` new; `src/main/ipc.ts`, `src/main/index.ts` mod: handler wiring [A2-3].
- `src/shared/api.ts`, `src/shared/api.test.ts` mod: `trace` namespace [A2-4].
- `src/main/trace-bundle.ts` + `trace-bundle.test.ts` new; `src/main/replay/cli-entry.ts` mod + `cli-entry.test.ts` new: `trace.json` in `runReplay` [A2-5].
- `src/main/replay/cli-entry.ts`, `cli-entry.test.ts` mod: `export` subcommand [A2-6].

---

## 2. Interface contract

### 2.1 W0: contracts (`packages/contracts/src`)

#### `id.ts` (W0-2) — current lines 1 and 5-7 change; lines 46-54 move to `node.ts`

```ts
// packages/contracts/src/id.ts  (no import of node:crypto remains)
export function newId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}
// newSessionId, newChangeUnitId, newDecisionId, newFactId, newSemanticEventId,
// newSurfaceId and nowIso are unchanged. symbolId and the SymbolKind import are removed.
```

#### `node.ts` (W0-2, new) — exported as `@jevcode/contracts/node`

```ts
import { createHash } from "node:crypto";

import type { SymbolKind } from "./evidence.js";

export function symbolId(
  path: string,
  name: string,
  kind: SymbolKind,
  signatureText: string,
): string {
  const hash = createHash("sha1").update(signatureText).digest("hex");
  return `${path}#${name}(${kind})@${hash}`;
}
```

`packages/contracts/package.json` `exports` gains:

```json
"./node": {
  "types": "./dist/node.d.ts",
  "import": "./dist/node.js"
}
```

Caller edits (W0-2), exact anchors:
- `packages/evidence-engine/src/symbol-diff.ts:1` and `symbol-diff.test.ts:1`: `import { symbolId, type SymbolInfo } from "@jevcode/contracts";` becomes `import type { SymbolInfo } from "@jevcode/contracts";` plus `import { symbolId } from "@jevcode/contracts/node";`.
- `packages/semantic-core/src/clustering.ts:16`: `import { symbolId } from "@jevcode/contracts";` becomes `import { symbolId } from "@jevcode/contracts/node";`.

Pinned digests for `node.test.ts`: `symbolId("a.ts", "f", "function", "f(x)")` is `"a.ts#f(function)@3e03f4706048fbc6c5a252a85d066adf107fcc1f"`; `symbolId("auth/service.ts", "createSession", "method", "createSession(userId: string)")` is `"auth/service.ts#createSession(method)@34fe8cce1d56428b1cf104d3979829db6c929659"`.

#### `canonical-json.ts` (W0-3, new)

```ts
/**
 * Deterministic JSON. Object keys are sorted by UTF-16 code unit order at
 * every depth, properties whose value is `undefined` are dropped, and arrays
 * keep their order. Two values that differ only in key order produce the
 * same string. Fact ids hash this string (packages/semantic-core/src/ids.ts),
 * so a collector-ordered fact and its zod-reordered stored copy share one id.
 * Integer-like keys enumerate in ascending numeric order (an engine rule);
 * the output is still a function of the key set alone.
 */
export function canonicalJson(value: unknown): string {
  const text = JSON.stringify(value, (_key, current: unknown) => {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return current;
    }
    const source = current as Record<string, unknown>;
    // A null prototype keeps an own "__proto__" key as data.
    const sorted = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(source).sort()) {
      sorted[key] = source[key];
    }
    return sorted;
  });
  if (text === undefined) {
    throw new TypeError("canonicalJson: value has no JSON representation");
  }
  return text;
}
```

Required tests: `canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })` returns `'{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}'`; `canonicalJson({ a: undefined, b: 1 })` returns `'{"b":1}'`; `canonicalJson(undefined)` throws `TypeError`; fast-check property over `fc.jsonValue()`: reversing every object's key order leaves the output unchanged; an object with an own `"__proto__"` key (from `JSON.parse('{"__proto__":1}')`) serializes as `'{"__proto__":1}'`.

#### `agent-events.ts` (W0-4) — full new file

```ts
import { z } from "zod";

const eventBase = {
  sessionId: z.string().min(1),
  ts: z.string(),
  // Minted by the adapter once per agent process (exec or exec resume).
  turnId: z.string().min(1).optional(),
};

// `${turnId}:${item.id}` for Codex. Shared by the start and the completion
// of one call; stamped as sourceCallId on the facts derived from it.
const call = {
  callId: z.string().min(1).optional(),
};

export const AgentInterruptReasonSchema = z.enum(["interrupt", "steer", "stop"]);

export type AgentInterruptReason = z.infer<typeof AgentInterruptReasonSchema>;

export const NormalizedAgentEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent_started"), ...eventBase, prompt: z.string() }),
  z.object({
    type: z.literal("agent_message"),
    ...eventBase,
    role: z.enum(["assistant", "user"]),
    text: z.string(),
  }),
  z.object({
    type: z.literal("agent_reasoning"),
    ...eventBase,
    ...call,
    text: z.string(),
  }),
  z.object({
    type: z.literal("tool_started"),
    ...eventBase,
    ...call,
    tool: z.string().min(1),
    input: z.string(),
  }),
  z.object({
    type: z.literal("tool_completed"),
    ...eventBase,
    ...call,
    tool: z.string().min(1),
    output: z.string(),
  }),
  z.object({
    type: z.literal("command_started"),
    ...eventBase,
    ...call,
    command: z.string().min(1),
  }),
  z.object({
    type: z.literal("command_completed"),
    ...eventBase,
    ...call,
    command: z.string().min(1),
    exitCode: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
  }),
  z.object({ type: z.literal("file_read"), ...eventBase, path: z.string().min(1) }),
  z.object({
    type: z.literal("file_changed"),
    ...eventBase,
    ...call,
    path: z.string().min(1),
  }),
  z.object({
    type: z.literal("approval_requested"),
    ...eventBase,
    ...call,
    command: z.string().min(1),
    rationale: z.string(),
  }),
  z.object({
    type: z.literal("test_started"),
    ...eventBase,
    command: z.string().min(1),
  }),
  z.object({
    type: z.literal("test_completed"),
    ...eventBase,
    command: z.string().min(1),
    exitCode: z.number().int(),
  }),
  z.object({ type: z.literal("agent_waiting"), ...eventBase }),
  z.object({ type: z.literal("agent_completed"), ...eventBase }),
  z.object({ type: z.literal("agent_failed"), ...eventBase, error: z.string() }),
  z.object({
    type: z.literal("agent_interrupted"),
    ...eventBase,
    reason: AgentInterruptReasonSchema,
  }),
]);

export type NormalizedAgentEvent = z.infer<typeof NormalizedAgentEventSchema>;

export type NormalizedAgentEventType = NormalizedAgentEvent["type"];
```

Agent events must never carry `repoId`: `pipeline-runtime.ts:334` and `parseReplayLine` try `EvidenceFactSchema` first.

#### `evidence.ts` (W0-4) — additions

Insert before `factBase` (after `TestFailure`, line 32):

```ts
export const DiffWithheldReasonSchema = z.enum(["secret_path", "not_captured"]);

export type DiffWithheldReason = z.infer<typeof DiffWithheldReasonSchema>;

export const GitHunkDiffSchema = z
  .object({
    // First 16 hex chars of sha256 over the raw (pre-redaction) diff; the change key.
    hash: z.string().regex(/^[0-9a-f]{16}$/),
    // UTF-8 byte length of the raw diff, so "showing 32 KB of 410 KB" is truthful.
    bytes: z.number().int().nonnegative(),
    // Redacted, capped unified diff against baseCommit. Absent when withheld.
    text: z.string().optional(),
    // True when text was cut at the last "@@" hunk boundary under 32 KiB.
    truncated: z.boolean(),
    // Number of redactions applied to text.
    redactions: z.number().int().nonnegative(),
    withheld: DiffWithheldReasonSchema.optional(),
  })
  .refine((diff) => diff.withheld === undefined || diff.text === undefined, {
    message: "a withheld diff carries no text",
  });

export type GitHunkDiff = z.infer<typeof GitHunkDiffSchema>;
```

Variant changes (each field is appended after the variant's last field):
- `git_hunk`: `diff: GitHunkDiffSchema.optional(),`
- `test_result`: `sourceCallId: z.string().min(1).optional(),`
- `command_executed`: `sourceCallId: z.string().min(1).optional(),`

#### `semantic.ts` (W0-4) — additions

- `ChangeUnitSchema`, after `evidence: z.array(z.string().min(1)),` (line 187): `agentCallIds: z.array(z.string().min(1)).optional(),` Filled by `clusterSession` (A1-8): sorted ascending, omitted when empty.
- `DecisionSchema`, after `answer: StructuredDecisionSchema.optional(),` (line 224): `ts: z.string().optional(),` Source time of the status transition (A1-10). Readers fall back to the row `ts`, then to seq.

#### `jev.ts` (W0-4) — additions

```ts
export const JevPassSchema = z.enum(["A", "B"]);

export type JevPass = z.infer<typeof JevPassSchema>;
```

`JevDecisionLogSchema`, after `clamps: z.array(z.string()),` (line 93): `pass: JevPassSchema.optional(),`

#### `WorkspaceHost.tsx` exhaustiveness (W0-4)

`eventSummary` (apps/desktop/src/renderer/components/WorkspaceHost.tsx:108-139) has no `default`, so the two new variants fail `tsc -p tsconfig.web.json` until handled. Insert after `case "agent_message": …` (line 112-113):

```ts
    case "agent_reasoning":
      return "Thinking";
```

and after `case "agent_failed": return \`Stopped: ${event.error}\`;` (lines 136-137):

```ts
    case "agent_interrupted":
      return event.reason === "stop"
        ? "Stopped"
        : event.reason === "steer"
          ? "Redirected"
          : "Paused";
```

`isConversationEvent` (lines 141-149) is an allow-list and stays unchanged, so reasoning and interruptions stay out of the Conversation tab. No other switch in the repo is exhaustive over `NormalizedAgentEvent["type"]` (verified: `ui-stage.ts:545`, `pipeline-runtime.ts:761` and `:1288`, `codex-adapter.ts:569` all have `default` branches).

#### `trace.ts` (W0-5, new) — full file

```ts
import { z } from "zod";

import { AgentStateSchema } from "./agent.js";

/** Every envelope type in the events log. Moved from packages/storage/src/db.ts:53-68. */
export const EVENT_TYPES = [
  "agent_event",
  "evidence_fact",
  "change_unit",
  "decision",
  "validation",
  "failure",
  "jev_decision",
  "ui_intent",
  "ui_snapshot",
  "graph_node",
  "graph_edge",
  "command",
  "semantic_event",
  "telemetry",
] as const;

export type EventStoreType = (typeof EVENT_TYPES)[number];

export const EventStoreTypeSchema = z.enum(EVENT_TYPES);

/** The envelope types the trace fold consumes. trace:rows and trace.json carry only these. */
export const TRACE_ROW_TYPES = [
  "agent_event",
  "evidence_fact",
  "change_unit",
  "decision",
  "validation",
  "jev_decision",
] as const satisfies readonly EventStoreType[];

export type TraceRowType = (typeof TRACE_ROW_TYPES)[number];

export function isTraceRowType(value: string): value is TraceRowType {
  return (TRACE_ROW_TYPES as readonly string[]).includes(value);
}

/** Strings longer than this many UTF-16 code units are clipped to head + tail. */
export const TRACE_CLIP_CHARS = 16_384;
export const TRACE_LIST_SESSIONS_DEFAULT = 100;
export const TRACE_LIST_SESSIONS_MAX = 500;
export const TRACE_ROWS_PAGE_DEFAULT = 2_000;
export const TRACE_ROWS_PAGE_MAX = 5_000;
export const TRACE_PAYLOADS_MAX = 50;
export const TRACE_LIVE_POLL_MS = 1_000;

export const TraceRowSchema = z.object({
  seq: z.number().int().positive(),
  // A string, not EventStoreTypeSchema: a bundle from a newer build may carry a
  // type this build does not know. The fold records it as an unknown_row_type gap.
  type: z.string().min(1),
  // Row append time (events.ts). Payloads carry their own source time.
  ts: z.string(),
  payload: z.unknown(),
  // True when at least one string in payload was clipped (TRACE_CLIP_CHARS).
  clipped: z.boolean().optional(),
  // evidence_fact rows only: factContentId(sessionId, payload), computed in main
  // before clipping and before bundle redaction.
  factId: z.string().min(1).optional(),
});

export type TraceRow = z.infer<typeof TraceRowSchema>;

export const TraceSessionSummarySchema = z.object({
  sessionId: z.string().min(1),
  repoId: z.string().min(1),
  repoName: z.string(),
  prompt: z.string(),
  state: AgentStateSchema,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  lastEventSeq: z.number().int().nonnegative(),
});

export type TraceSessionSummary = z.infer<typeof TraceSessionSummarySchema>;

export const TraceRowsPageSchema = z.object({
  rows: z.array(TraceRowSchema),
  // seq of the last returned row when the page is full, else null.
  nextAfterSeq: z.number().int().nonnegative().nullable(),
  // sessions.lastEventSeq, read in the same transaction as rows.
  lastSeq: z.number().int().nonnegative(),
  state: AgentStateSchema,
});

export type TraceRowsPage = z.infer<typeof TraceRowsPageSchema>;

export const TRACE_BUNDLE_FORMAT = "jevcode.trace";
export const TRACE_BUNDLE_VERSION = 1;

export const TraceBundleSchema = z.object({
  format: z.literal(TRACE_BUNDLE_FORMAT),
  version: z.literal(TRACE_BUNDLE_VERSION),
  exportedAt: z.string(),
  redactionCount: z.number().int().nonnegative(),
  session: TraceSessionSummarySchema,
  rows: z.array(TraceRowSchema),
});

export type TraceBundle = z.infer<typeof TraceBundleSchema>;
```

`payload: z.unknown()` infers as `payload?: unknown`; consumers treat a missing payload as an `invalid_row`.

**Paging contract** (A2 implements, B and the UI rely on it). `rows({ sessionId, afterSeq = 0, limit = TRACE_ROWS_PAGE_DEFAULT })` returns, from one read transaction, rows with `afterSeq < seq <= lastSeq` and `type` in `TRACE_ROW_TYPES`, ascending by seq, at most `limit`. `nextAfterSeq` is the last row's seq when `rows.length === limit`, else `null`. The next request's `afterSeq` is `cursorAfter(page)` (section 2.3) = `page.nextAfterSeq ?? page.lastSeq`. Because `seq` is gapless per session (db.ts:282-295) and `lastEventSeq` is updated in the same write transaction as the insert, no appended row is ever skipped.

`packages/storage/src/db.ts` (W0-5): delete lines 53-70 (`export const EVENT_TYPES = [...] as const;` and `export type EventStoreType = …;`), add `EVENT_TYPES` and `type EventStoreType` to the existing `@jevcode/contracts` value/type imports, and add `export { EVENT_TYPES };` and `export type { EventStoreType };` after the imports. `packages/storage/src/index.ts` stays unchanged (it re-exports from `./db.js`).

`packages/contracts/src/index.ts` final form (after W0-3 and W0-5):

```ts
export * from "./agent-events.js";
export * from "./agent.js";
export * from "./canonical-json.js";
export * from "./evidence.js";
export * from "./id.js";
export * from "./ipc.js";
export * from "./jev.js";
export * from "./json-render.js";
export * from "./model.js";
export * from "./security.js";
export * from "./semantic.js";
export * from "./trace.js";
export * from "./ui/index.js";
```

#### SPEC text owned by W0

- §2.2 (W0-1): add `│   └── trace-viewer/             read-only trace model (src/model, React-free) + viewer UI (src/ui)` under `packages/` (turn the `telemetry/` line's `└──` into `├──`) and `├── apps/trace-viewer-dev/        Vite dev host that opens exported trace.json bundles` under `apps/desktop/`.
- §18 (W0-1): replace "Plus replay UI, team features, and Windows/Linux packaging" with "Plus team features and Windows/Linux packaging" and append the sentence "The read-only trace viewer (`docs/superpowers/specs/2026-09-28-trace-viewer-design.md`) supersedes the deferred replay UI item (plan-owner sign-off under IMPLEMENTATION-PLAN risk R8; design decision D9)." The sign-off is risk R8 in `docs/IMPLEMENTATION-PLAN.md:180` ("Exceptions need plan owner sign-off"), not design recommendation R8. A1-3 re-checks and applies the same text only if W0-1 did not.
- §4.1–§4.3 (W0-4): the new fields and variants above, each marked `// optional`; in §4.3 correct `evidence: string[] // evidence fact ids` to `// fact ids (fact_…), plus validation and semantic-event ids`, and add `agentCallIds?: string[]` and `Decision.ts?: string`.
- §4.5 (W0-5): add a line under `→ main`: `trace:listSessions, trace:rows, trace:payloads (read-only; query_only reader; see the trace viewer design spec)`.
- §15 (W0-5): add "`replay <fixtureDir> <outDir>` also writes `<outDir>/trace.json` (`TraceBundle`, format `jevcode.trace` v1). `replay export --db <path> --session <id> --out <file>` exports any stored session. Every string in a bundle passes `redactText` and the home directory becomes `~`."

### 2.2 W0: packages, dependency manifest, lint boundaries

#### Dependency manifest (W0-1 is the only lockfile change in the whole project)

Versions already in `pnpm-lock.yaml` are pinned exactly so no second copy appears.

| Importer | Section | Entry |
|---|---|---|
| `packages/trace-viewer` | dependencies | `"@jevcode/contracts": "workspace:*"`, `"@jevcode/ui-catalog": "workspace:^"`, `"@tanstack/react-virtual": "3.14.13"`, `"d3-selection": "3.0.0"`, `"d3-zoom": "3.0.0"`, `"zod": "^3.24.1"` (no `@xyflow/react`: R17) |
| `packages/trace-viewer` | peerDependencies | `"react": "^19.2.0"`, `"react-dom": "^19.2.0"` |
| `packages/trace-viewer` | devDependencies | `"@jevcode/semantic-core": "workspace:^"`, `"@testing-library/dom": "^10.4.2"`, `"@testing-library/react": "^16.3.3"`, `"@testing-library/user-event": "14.6.7"`, `"@types/d3-selection": "3.0.12"`, `"@types/d3-zoom": "3.0.8"`, `"@types/node": "^22.13.0"`, `"@types/react": "^19.3.0"`, `"@types/react-dom": "^19.3.0"`, `"eslint": "9.39.5"`, `"fast-check": "4.10.1"`, `"jsdom": "30.1.0"`, `"react": "19.2.3"`, `"react-dom": "19.2.3"`, `"typescript": "^5.7.3"`, `"vitest": "^3.0.5"` |
| `apps/trace-viewer-dev` | dependencies | `"@jevcode/contracts": "workspace:*"`, `"@jevcode/trace-viewer": "workspace:^"`, `"react": "19.2.3"`, `"react-dom": "19.2.3"` |
| `apps/trace-viewer-dev` | devDependencies | `"@types/react": "^19.3.0"`, `"@types/react-dom": "^19.3.0"`, `"@vitejs/plugin-react": "^4.3.4"`, `"typescript": "^5.7.3"`, `"vite": "^5.4.11"` |
| `apps/desktop` | dependencies | add `"@jevcode/trace-viewer": "workspace:^"` (used by the M5 trace window) |
| `packages/contracts` | devDependencies | add `"fast-check": "4.10.1"` |
| `packages/ui-catalog` | exports (no dependency change) | add `"./components/*"` → `./dist/components/*.js` (types `./dist/components/*.d.ts`) |

Why each one: `@tanstack/react-virtual` for the spine and Outline (R14, R13, R17); no `@xyflow/react`, because R17 picks a hand-rolled DOM viewport for both views (it stays locked through ui-catalog, so the grep below still prints it); `d3-zoom` 3.0.0 and its peer `d3-selection` 3.0.0 (with `@types/d3-zoom` 3.0.8 and `@types/d3-selection` 3.0.12) as R17's fallback for spike risk 1 (UI task C1-7F), added now because no UI lane may add a dependency, and all four already locked through `@xyflow/react`; `@jevcode/ui-catalog` for `CodeDiff` through the `./components/*` subpath W0-1 adds (the only ui-catalog form `TRACE_VIEWER_PATHS` allows); `@jevcode/semantic-core` for B's fixture harness; `eslint` for `lint-boundaries.test.ts`; `@testing-library/*` and `jsdom` for UI tests; `fast-check` for B's parity test and W0-3's property. New tarballs: `@tanstack/react-virtual`, `@tanstack/virtual-core`, `@testing-library/user-event`.

Single-version check after `pnpm install` (W0-1 step). Run from the repo root:

```bash
grep -oE "^  '?(@xyflow/react|react|react-dom|zod|fast-check|jsdom|vite|@vitejs/plugin-react|@types/react|@types/react-dom|eslint)@[0-9][0-9.]*" pnpm-lock.yaml | sort -u
```

Expected output, byte for byte (it is today's output; any extra line means a pin drifted). `@xyflow/react@12.11.6` stays in the list because `@jevcode/ui-catalog` locks it. W0-1 then expects `git diff --numstat -- pnpm-lock.yaml` to print `134	0	pnpm-lock.yaml` (lane 01; measured on a replay of W0-1 at `144c7fb`: the four d3 entries add 12 importer lines and no package entry).

```
  '@types/react-dom@19.3.0
  '@types/react@19.3.0
  '@vitejs/plugin-react@4.7.0
  '@xyflow/react@12.11.6
  eslint@9.39.5
  fast-check@4.10.1
  jsdom@30.1.0
  react-dom@19.2.3
  react@19.2.3
  vite@5.4.21
  zod@3.25.76
  zod@4.3.6
```

The single-version output is unchanged by the d3 entries (none of them is in the grep). Virtual-core check, also a W0-1 step after `pnpm install` (R17: "verify followOnAppend/anchorTo exist in the resolved virtual-core"):

```bash
grep -c "anchorTo?: ScrollAnchor\|followOnAppend?: FollowOnAppend\|scrollEndThreshold?: number" node_modules/.pnpm/@tanstack+virtual-core@3.17.11/node_modules/@tanstack/virtual-core/src/index.ts
```

Expected: `3`. If the resolved virtual-core is not 3.17.11 or the count is not 3, W0-1 stops and escalates (spec §16 risk 7).

#### `packages/trace-viewer/package.json` (W0-1)

```json
{
  "name": "@jevcode/trace-viewer",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./model": {
      "types": "./dist/model/index.d.ts",
      "import": "./dist/model/index.js"
    },
    "./sources": {
      "types": "./dist/sources/index.d.ts",
      "import": "./dist/sources/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json && node scripts/copy-assets.mjs",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run --passWithNoTests",
    "bench": "vitest bench --run"
  },
  "dependencies": {
    "@jevcode/contracts": "workspace:*",
    "@jevcode/ui-catalog": "workspace:^",
    "@tanstack/react-virtual": "3.14.13",
    "d3-selection": "3.0.0",
    "d3-zoom": "3.0.0",
    "zod": "^3.24.1"
  },
  "peerDependencies": {
    "react": "^19.2.0",
    "react-dom": "^19.2.0"
  },
  "devDependencies": {
    "@jevcode/semantic-core": "workspace:^",
    "@testing-library/dom": "^10.4.2",
    "@testing-library/react": "^16.3.3",
    "@testing-library/user-event": "14.6.7",
    "@types/d3-selection": "3.0.12",
    "@types/d3-zoom": "3.0.8",
    "@types/node": "^22.13.0",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "eslint": "9.39.5",
    "fast-check": "4.10.1",
    "jsdom": "30.1.0",
    "react": "19.2.3",
    "react-dom": "19.2.3",
    "typescript": "^5.7.3",
    "vitest": "^3.0.5"
  }
}
```

`tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["node"]
  },
  "include": ["src"]
}
```

`tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "exclude": [
    "src/**/*.test.ts",
    "src/**/*.test.tsx",
    "src/**/*.bench.ts",
    "src/test-support/**"
  ]
}
```

`vitest.config.ts` (UI tests opt into jsdom with a first-line `// @vitest-environment jsdom` comment):

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    benchmark: { include: ["src/**/*.bench.ts"] },
  },
});
```

`scripts/copy-assets.mjs`:

```js
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");
const dist = path.join(root, "dist");

let copied = 0;
for (const entry of readdirSync(src, { recursive: true })) {
  const relative = String(entry);
  if (!relative.endsWith(".css")) continue;
  const target = path.join(dist, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(src, relative), target);
  copied += 1;
}
console.log(`copy-assets: ${copied} css file(s)`);
```

`src/css-modules.d.ts`:

```ts
declare module "*.module.css" {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
```

`src/index.ts` and `src/model/index.ts` start as `export {};` (W0-1) and take their final W0 form in W0-6 (section 2.3). The `"./sources"` export points at `dist/sources/index.js`, which exists once UI lane C1b (C1-15) adds `src/sources/index.ts`; it lets `apps/desktop` tests import `createStaticBundleSource` and `readAllTraceRows` without the React barrel and its `.module.css` imports.

#### `packages/ui-catalog/package.json` (W0-1)

`exports` gains one entry after `"."`:

```json
    "./components/*": {
      "types": "./dist/components/*.d.ts",
      "import": "./dist/components/*.js"
    }
```

`tsc -p packages/ui-catalog/tsconfig.json` already emits `dist/components/CodeDiff.{js,d.ts}`, so `import.meta.resolve("@jevcode/ui-catalog/components/CodeDiff")` from `packages/trace-viewer` resolves to `packages/ui-catalog/dist/components/CodeDiff.js` after W0-1.

#### `apps/trace-viewer-dev` (W0-1)

`package.json`:

```json
{
  "name": "jevcode-trace-viewer-dev",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@jevcode/contracts": "workspace:*",
    "@jevcode/trace-viewer": "workspace:^",
    "react": "19.2.3",
    "react-dom": "19.2.3"
  },
  "devDependencies": {
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "^5.7.3",
    "vite": "^5.4.11"
  }
}
```

`tsconfig.json` (mirrors apps/desktop/tsconfig.web.json):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "noEmit": true,
    "declaration": false,
    "declarationMap": false,
    "types": []
  },
  "include": ["src"]
}
```

`vite.config.ts`:

```ts
import { builtinModules } from "node:module";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Same policy as apps/desktop/src/renderer/index.html.
const ELECTRON_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'";
const NODE_BUILTINS = new Set(builtinModules);

// Fails the build on any Node built-in in the browser graph: the browser-safety proof.
function forbidNodeBuiltins(): Plugin {
  return {
    name: "jevcode-forbid-node-builtins",
    enforce: "pre",
    resolveId(source, importer) {
      if (source.startsWith("node:") || NODE_BUILTINS.has(source)) {
        this.error(
          `browser bundle imports "${source}" from ${importer ?? "the entry"}; the trace viewer must stay browser-safe`,
        );
      }
      return null;
    },
  };
}

// Build and preview only: the dev server's React refresh preamble is inline script.
function electronCsp(): Plugin {
  return {
    name: "jevcode-electron-csp",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace(
        "<head>",
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${ELECTRON_CSP}" />`,
      );
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), forbidNodeBuiltins(), electronCsp()],
  // The CSP's default-src 'self' blocks data: URIs, so no asset may be inlined.
  build: { outDir: "dist", emptyOutDir: true, assetsInlineLimit: 0 },
});
```

`index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Jevcode trace viewer (dev)</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./src/main.tsx"></script>
  </body>
</html>
```

`src/main.tsx` goes through three W0 versions. W0-1 renders only `<h1>Trace viewer dev host</h1>` with `react`/`react-dom` imports. W0-2 adds `import { AgentStateSchema } from "@jevcode/contracts";` and renders `AgentStateSchema.options.join(", ")`, so the contracts barrel enters the browser graph. W0-6 final:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { TRACE_ROW_TYPES } from "@jevcode/contracts";
import { TRACE_SCHEMA_VERSION } from "@jevcode/trace-viewer/model";

const root = document.getElementById("root");
if (root === null) throw new Error("dev host: #root is missing");

createRoot(root).render(
  <StrictMode>
    <main>
      <h1>Trace viewer dev host</h1>
      <p>
        Model schema v{TRACE_SCHEMA_VERSION}. Row types: {TRACE_ROW_TYPES.join(", ")}.
      </p>
    </main>
  </StrictMode>,
);
```

The M4a UI lane replaces `main.tsx` with the real host (`?bundle=`, file drop).

#### ESLint boundaries (`eslint.config.mjs`)

Append these objects to the `tseslint.config(...)` argument list, after the existing `*.mjs` block. W0-1 adds the three trace-viewer blocks (package source, `src/model`, `src/layout`); W0-2 adds the contracts block.

```js
const NODE_BUILTIN_REGEX =
  "^(assert|buffer|child_process|crypto|events|fs|http|https|net|os|path|process|stream|url|util|worker_threads|zlib)(/.*)?$";

const BROWSER_SAFE_PATTERNS = [
  { regex: "^node:", message: "Browser-safe code: no Node built-ins." },
  { regex: NODE_BUILTIN_REGEX, message: "Browser-safe code: no Node built-ins." },
  { regex: "^electron(/.*)?$", message: "The trace viewer never touches Electron; hosts inject a TraceSource." },
  {
    regex: "^@jevcode/(storage|semantic-core|evidence-engine|jev-router|telemetry|ui-compiler|agent-[a-z-]+)(/.*)?$",
    message: "The trace viewer reads TraceRows only; it never imports pipeline or storage packages.",
  },
];

const TRACE_VIEWER_PATHS = [
  { name: "@jevcode/ui-catalog", message: "Import one component through @jevcode/ui-catalog/components/<Name>." },
  { name: "@jevcode/contracts/node", message: "Node-only helper; not for browser code." },
];

const NO_NETWORK_GLOBALS = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"].map((name) => ({
  name,
  message: "The trace viewer reads only through its TraceSource.",
}));

// Declared in nodeGlobals above for Node packages; undefined in the Electron trace window.
const NO_NODE_GLOBALS = ["process", "Buffer", "require", "global", "__dirname", "__filename", "setImmediate", "clearImmediate"].map(
  (name) => ({ name, message: "Browser-safe code: no Node globals." }),
);

const LAYOUT_PURE_GLOBALS = [
  "window", "document", "navigator", "requestAnimationFrame", "cancelAnimationFrame",
  "ResizeObserver", "MutationObserver", "getComputedStyle", "localStorage", "sessionStorage",
  "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date",
].map((name) => ({
  name,
  message: "src/layout is pure: no DOM, timers or clocks; take time as numbers (R19).",
}));
```

(The constants go above `export default`. `NO_NODE_GLOBALS` is lane 01's deviation 2: the trace-viewer `tsconfig.json` has `"types": ["node"]`, so without it `Buffer.byteLength(…)` in `src/model` would typecheck and lint clean, then throw in the Electron trace window.) The config objects:

```js
  {
    files: ["packages/contracts/src/**/*.ts"],
    ignores: ["packages/contracts/src/node.ts", "packages/contracts/src/**/*.test.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          regex: "^node:",
          message: "The @jevcode/contracts barrel is browser-safe; put Node-only helpers in src/node.ts (@jevcode/contracts/node).",
        }],
      }],
    },
  },
  {
    files: ["packages/trace-viewer/src/**/*.ts", "packages/trace-viewer/src/**/*.tsx"],
    ignores: [
      "packages/trace-viewer/src/**/*.test.ts",
      "packages/trace-viewer/src/**/*.test.tsx",
      "packages/trace-viewer/src/**/*.bench.ts",
      "packages/trace-viewer/src/test-support/**",
    ],
    rules: {
      "no-restricted-imports": ["error", { paths: TRACE_VIEWER_PATHS, patterns: BROWSER_SAFE_PATTERNS }],
      "no-restricted-globals": ["error", ...NO_NETWORK_GLOBALS, ...NO_NODE_GLOBALS],
    },
  },
  {
    files: ["packages/trace-viewer/src/model/**/*.ts"],
    ignores: ["packages/trace-viewer/src/model/**/*.test.ts", "packages/trace-viewer/src/model/**/*.bench.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: TRACE_VIEWER_PATHS,
        patterns: [
          ...BROWSER_SAFE_PATTERNS,
          { regex: "^react(-dom)?(/.*)?$", message: "src/model is React-free (R7)." },
          { regex: "^@(xyflow|tanstack)/", message: "src/model is React-free (R7)." },
          { regex: "^@jevcode/ui-catalog(/.*)?$", message: "src/model is React-free (R7)." },
          { regex: "(^|/)ui(/|$)", message: "src/model never imports src/ui." },
          { regex: "(^|/)layout(/|$)", message: "src/model never imports src/layout (R19)." },
        ],
      }],
      "no-restricted-globals": ["error", ...NO_NETWORK_GLOBALS, ...NO_NODE_GLOBALS],
    },
  },
  {
    files: ["packages/trace-viewer/src/layout/**/*.ts"],
    ignores: [
      "packages/trace-viewer/src/layout/**/*.test.ts",
      "packages/trace-viewer/src/layout/**/*.bench.ts",
    ],
    rules: {
      "no-restricted-imports": ["error", {
        paths: TRACE_VIEWER_PATHS,
        patterns: [
          ...BROWSER_SAFE_PATTERNS,
          { regex: "^react(-dom)?(/.*)?$", message: "src/layout is React-free (R19)." },
          { regex: "^@(xyflow|tanstack)/", message: "src/layout is React-free (R19)." },
          { regex: "^d3-", message: "src/layout is pure; d3 belongs in ui/viewport (R17)." },
          { regex: "^@jevcode/ui-catalog(/.*)?$", message: "src/layout is React-free (R19)." },
          { regex: "(^|/)ui(/|$)", message: "src/layout never imports src/ui (R19)." },
        ],
      }],
      "no-restricted-globals": ["error", ...NO_NETWORK_GLOBALS, ...NO_NODE_GLOBALS, ...LAYOUT_PURE_GLOBALS],
    },
  },
```

In flat config a later object's rule setting replaces an earlier one for the same file, which is why the model and layout blocks repeat the full lists. The regex form of `patterns` was verified against the installed ESLint 9.39.5 (`node:fs`, bare `path`, `react`, the ui-catalog barrel and `@jevcode/agent-codex` are reported; `@jevcode/ui-catalog/components/CodeDiff` is allowed).

`packages/trace-viewer/src/lint-boundaries.test.ts` pins the bans with ESLint's Node API (`new ESLint({ cwd: REPO_ROOT }).lintText(code, { filePath })`, `REPO_ROOT = path.resolve(dirname(import.meta.url), "../../..")`, timeout 30 s). Cases and expected rule ids:

| filePath (repo-relative) | code | expected ruleIds |
|---|---|---|
| `packages/trace-viewer/src/model/probe.ts` | `import { readFileSync } from "node:fs"; export const x = readFileSync;` | `["no-restricted-imports"]` |
| `packages/trace-viewer/src/model/probe.ts` | `import { useState } from "react"; export const x = useState;` | `["no-restricted-imports"]` |
| `packages/trace-viewer/src/model/probe.ts` | `import { Shell } from "../ui/Shell.js"; export const x = Shell;` | `["no-restricted-imports"]` |
| `packages/trace-viewer/src/model/probe.ts` | `import { buildTimeScale } from "../layout/time-scale.js"; export const x = buildTimeScale;` | `["no-restricted-imports"]` |
| `packages/trace-viewer/src/model/probe.ts` | `export const x = () => fetch("/x");` | `["no-restricted-globals"]` |
| `packages/trace-viewer/src/model/probe.ts` | `export const x = Buffer.byteLength("a");` | `["no-restricted-globals"]` |
| `packages/trace-viewer/src/model/probe.test.ts` | `import { readFileSync } from "node:fs"; export const x = readFileSync;` | `[]` |
| `packages/trace-viewer/src/layout/probe.ts` | `import { useState } from "react"; export const x = useState;` | `["no-restricted-imports"]` |
| `packages/trace-viewer/src/layout/probe.ts` | `import { Shell } from "../ui/shell/Shell.js"; export const x = Shell;` | `["no-restricted-imports"]` |
| `packages/trace-viewer/src/layout/probe.ts` | `export const x = () => document.body;` | `["no-restricted-globals"]` |
| `packages/trace-viewer/src/layout/probe.ts` | `export const x = () => Date.now();` | `["no-restricted-globals"]` |
| `packages/trace-viewer/src/layout/probe.ts` | `import { LANES } from "../model/index.js"; export const x = LANES;` | `[]` |
| `packages/trace-viewer/src/layout/probe.test.ts` | `export const x = () => document.body;` | `[]` |
| `packages/trace-viewer/src/ui/probe.tsx` | `import { useState } from "react"; export const x = useState;` | `[]` |
| `packages/trace-viewer/src/ui/probe.tsx` | `import { registry } from "@jevcode/ui-catalog"; export const x = registry;` | `["no-restricted-imports"]` |
| `packages/trace-viewer/src/ui/probe.tsx` | `import { openDb } from "@jevcode/storage"; export const x = openDb;` | `["no-restricted-imports"]` |
| `packages/contracts/src/probe.ts` (W0-2) | `import { createHash } from "node:crypto"; export const x = createHash;` | `["no-restricted-imports"]` |
| `packages/contracts/src/node.ts` (W0-2) | `import { createHash } from "node:crypto"; export const x = createHash;` | `[]` |

W0-1 lands the first 16 rows (`Tests  16 passed (16)`); W0-2 appends the two contracts rows (`Tests  18 passed (18)`). The rows keep this order in `CASES`.

### 2.3 W0: model types and `TraceSource` (W0-6)

#### `packages/trace-viewer/src/model/types.ts` — full file

```ts
import { z } from "zod";

import type {
  AgentInterruptReason,
  ChangeCategory,
  ChangeUnitStatus,
  Decision,
  DependencyChange,
  EventStoreType,
  JevClientKind,
  JevPass,
  SchemaChange,
  TraceSessionSummary,
} from "@jevcode/contracts";

/** Version of the TraceSession shape. Bump on any breaking change. */
export const TRACE_SCHEMA_VERSION = 1 as const;

// ------------------------------------------------------------ stable ids (R9)

export type StepId = `step:${number}`;
export type UnitStableId = `unit:${string}`;
export type DecisionStableId = `decision:${string}`;
export type FileStableId = `file:${string}`;
export type FindingId = `finding:${string}`;
export type StableId = StepId | UnitStableId | DecisionStableId | FileStableId | FindingId;

export const STABLE_ID_KINDS = ["step", "unit", "decision", "file", "finding"] as const;

export type StableIdKind = (typeof STABLE_ID_KINDS)[number];

// The s flag lets the opaque key hold line terminators (POSIX paths may contain "\n").
export const StableIdSchema = z
  .string()
  .regex(/^(?:step:[1-9]\d*|(?:unit|decision|file|finding):.+)$/s, "not a trace stable id");

export interface ParsedStableId {
  kind: StableIdKind;
  /** Everything after the first colon. Opaque; may itself contain colons. */
  key: string;
}

function positiveInt(label: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

function nonEmpty(label: string, value: string): string {
  if (value.length === 0) throw new RangeError(`${label} must be non-empty`);
  return value;
}

export function stepStableId(firstSeq: number): StepId {
  return `step:${positiveInt("step seq", firstSeq)}`;
}

export function unitStableId(changeUnitId: string): UnitStableId {
  return `unit:${nonEmpty("change unit id", changeUnitId)}`;
}

export function decisionStableId(decisionId: string): DecisionStableId {
  return `decision:${nonEmpty("decision id", decisionId)}`;
}

export function fileStableId(path: string): FileStableId {
  return `file:${nonEmpty("file path", path)}`;
}

export function findingStableId(
  ruleId: SignalId,
  ruleVersion: number,
  anchorSeq: number,
): FindingId {
  return `finding:${ruleId}@${positiveInt("rule version", ruleVersion)}:${positiveInt("anchor seq", anchorSeq)}`;
}

export function parseStableId(value: string): ParsedStableId | null {
  if (!StableIdSchema.safeParse(value).success) return null;
  const colon = value.indexOf(":");
  return { kind: value.slice(0, colon) as StableIdKind, key: value.slice(colon + 1) };
}

// ------------------------------------------------------------ vocabulary

/** Hybrid lanes, top to bottom (R14). */
export const LANES = ["supervisor", "agent", "commands", "edits", "tests", "jev"] as const;
export type Lane = (typeof LANES)[number];

/** Semantic zoom levels shared by both views (R20). */
export const LEVELS = ["session", "chapter", "step"] as const;
export type Level = (typeof LEVELS)[number];

export type Actor = "supervisor" | "agent" | "repo" | "jevcode";

/** observed = joined by an id; inferred = joined by a heuristic (FIFO, time window). */
export type Provenance = "observed" | "inferred";

export const STEP_KINDS = [
  "instruction",
  "message",
  "reasoning",
  "command",
  "test",
  "check",
  "edit",
  "read",
  "tool",
  "approval",
  "decision",
  "dependency",
  "revert",
  "lifecycle",
  "guardrail",
  "attention",
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** "unknown" covers exit code -1, unpaired starts and interrupted runs. Never rendered as failed. */
export type StepStatus = "ok" | "failed" | "running" | "unknown" | "info";

export const PROBLEM_KINDS = [
  "exit_nonzero",
  "tests_failed",
  "agent_failed",
  "destructive",
  "guardrail",
  "claim_contradicted",
] as const;
export type ProblemKind = (typeof PROBLEM_KINDS)[number];

export const NOISE_REASONS = [
  "read",
  "lockfile",
  "formatting",
  "duplicate_poll",
  "lifecycle",
  /** Attention rows and info-only clamp rows, labeled "pipeline events" (C2 fix wave). An exhaustive
   *  Record<NoiseReason, …> must list it. */
  "pipeline",
  "superseded",
  "passing_test",
] as const;
export type NoiseReason = (typeof NOISE_REASONS)[number];

export type TurnTrigger = "initial" | "steer" | "resume";

export type TurnOutcome = "completed" | "failed" | "interrupted" | "waiting" | "running" | "unknown";

export type Severity = "info" | "warning" | "critical";

export const SIGNAL_IDS = [
  "claim_contradicted",
  "failing_tests",
  "destructive_command",
  "guardrail_clamp",
  "recovery_arc",
] as const;
export type SignalId = (typeof SIGNAL_IDS)[number];

/** Data a session may or may not contain; signals list what they require. */
export const CAPABILITIES = [
  "agent_messages",
  "agent_commands",
  "test_results",
  "jev_decisions",
  "call_ids",
  "fact_links",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const GAP_KINDS = [
  "invalid_row",
  "unknown_row_type",
  "out_of_order",
  "unpaired",
  "missing_evidence",
] as const;
export type GapKind = (typeof GAP_KINDS)[number];

// ------------------------------------------------------------ step details

export interface TestCounts {
  passed: number;
  failed: number;
  skipped: number;
}

export interface TestFailureSummary {
  file: string;
  testName: string;
  message: string;
}

export interface CommandDetail {
  /** The command as the agent ran it. */
  command: string;
  /** null = not completed yet; -1 = unknown (Codex gave no exit code). */
  exitCode: number | null;
  /** DestructivePattern.name from matchDestructive, when it matched. */
  destructivePattern?: string;
  /** Last 20 lines of stdout then stderr, at most 2,048 UTF-16 code units; command, test and check steps (spec §6.2). */
  outputTail?: string;
}

export interface TestDetail extends TestCounts {
  runner?: string;
  /** At most the first 20 failures. */
  failures: TestFailureSummary[];
}

export type DiffState = "text" | "truncated" | "withheld_secret" | "not_captured" | "none";

export interface EditDetail {
  path: string;
  change?: "added" | "modified" | "deleted";
  added: number;
  removed: number;
  /** An agent file_changed event names this path. */
  claimed: boolean;
  /** A repo fact (file_changed, git_hunk, symbol_delta) confirms it. */
  observed: boolean;
  /** seq of the latest git_hunk row for this path in this step; fetch it with TraceSource.payloads. */
  diffSeq?: number;
  diff: DiffState;
  lockfile: boolean;
  formattingOnly: boolean;
}

export interface DecisionDetail {
  decisionId: string;
  title: string;
  severity: Decision["severity"];
  status: Decision["status"];
  options: { id: string; label: string; chosen: boolean }[];
  decidedBy?: "supervisor" | "delegated";
  /** seq of the supervisor's answer message, absorbed into this step (R25). */
  answerSeq?: number;
}

export interface GuardrailDetail {
  clampIds: string[];
  changeUnitId?: string;
  pass?: JevPass;
  clientKind: JevClientKind;
  confidence: number;
}

// ------------------------------------------------------------ fold output

export interface Step {
  id: StepId;
  kind: StepKind;
  lane: Lane;
  actor: Actor;
  provenance: Provenance;
  status: StepStatus;
  /** Short title from stepHeadline (format.ts). */
  headline: string;
  /** Command text, path or tool name. */
  target?: string;
  /** instruction, message and reasoning steps. */
  text?: string;
  callId?: string;
  turnIndex: number;
  /** Every row folded into this step, ascending. */
  seqs: number[];
  firstSeq: number;
  lastSeq: number;
  /** Payload source ts of the first row when present, else the row ts. */
  startTs: string;
  endTs: string | null;
  /** Display clock: ms since TraceSession.originMs, never decreasing with seq (spec §6.5). */
  tMs: number;
  /** Epoch ms of the first row's source time, unclamped; for decision, validation, change_unit
   *  and jev_decision rows originMs plus the inherited clock (R25, spec §6.5). */
  startMs: number;
  /** null while running. */
  endTMs: number | null;
  durationMs: number | null;
  /** Codex times are PTY arrival times. */
  approxTime: boolean;
  command?: CommandDetail;
  tests?: TestDetail;
  edit?: EditDetail;
  decision?: DecisionDetail;
  guardrail?: GuardrailDetail;
  /** Repo facts and validations attached to this step. */
  evidenceSeqs: number[];
  chapterIds: UnitStableId[];
  entityIds: FileStableId[];
  findingIds: FindingId[];
  problems: ProblemKind[];
  /** Never set when problems or findingIds are non-empty (R10, R11). */
  noise: NoiseReason | null;
}

export interface Turn {
  index: number;
  trigger: TurnTrigger;
  prompt: string;
  outcome: TurnOutcome;
  interruptReason?: AgentInterruptReason;
  turnId?: string;
  startSeq: number;
  endSeq: number;
  startTs: string;
  endTs: string;
  tMs: number;
  endTMs: number;
  stepIds: StepId[];
  /** The first assistant message before the turn's first edit that starts with "Plan" or lists
   *  at least two items (R25). */
  planStepId?: StepId;
  /** The turn's last success-claim message: the one claim_contradicted checks (R25). */
  claimStepId?: StepId;
}

export interface EvidenceLinks {
  /** fact_ ids cited by the latest unit version. */
  cited: number;
  /** cited ids that match a row factId. */
  resolved: number;
  /** steps attached by the time-window fallback (D11). */
  approx: number;
}

export interface Chapter {
  id: UnitStableId;
  changeUnitId: string;
  title: string;
  /** chapterShortTitle(latest unit), at most SHORT_TITLE_MAX graphemes; set by the fold, absent on
   *  hand-built sessions. Labels show `shortTitle ?? title` through displayUntrusted (C2 fix wave, M2). */
  shortTitle?: string;
  intent?: string;
  category: ChangeCategory;
  status: ChangeUnitStatus;
  /** False when the latest version is superseded (R25). */
  current: boolean;
  /** Every joined edit is a lockfile or formatting-only change, or the latest Pass A jev_decision
   *  row for the unit has shouldSurface: false; a finding that names the chapter clears it (R25).
   *  The views collapse it by default. */
  noise: boolean;
  files: string[];
  /** inferred = approximate join (D11). */
  link: Provenance;
  evidenceLinks: EvidenceLinks;
  /** seq of the first change_unit row for this id. */
  firstSeq: number;
  /** seq of the latest version. */
  lastSeq: number;
  versions: number;
  /** unit createdAt / updatedAt. */
  startTs: string;
  endTs: string;
  tMs: number;
  endTMs: number;
  stepIds: StepId[];
  factSeqs: number[];
  decisionIds: DecisionStableId[];
  validationIds: string[];
  /** Steps that the unit's validation results attached to, in seq order (R25). */
  validationStepIds: StepId[];
  /** Shared test/check steps (another current chapter joins them) whose outcome this chapter does not
   *  own (ownsRunOutcome), less the steps of any finding that names the chapter; the overview band
   *  footprint skips them (spec §6.6, §7.6.1; C2 fix wave, M6). Absent on hand-built sessions. */
  validationOnlyStepIds?: StepId[];
  clampIds: string[];
  triad: { importance?: number; relevance?: number; interruption?: number; clientKind?: JevClientKind };
  schemaChanges: SchemaChange[];
  dependencyChanges: DependencyChange[];
  findingIds: FindingId[];
}

export interface Entity {
  id: FileStableId;
  kind: "file";
  path: string;
  /** truncateMiddle(path, 48). */
  label: string;
  added: number;
  removed: number;
  claimed: boolean;
  observed: boolean;
  stepIds: StepId[];
  chapterIds: UnitStableId[];
}

export interface ClaimObservation {
  claim: { text: string; seq: number; tMs: number; stepId: StepId };
  observed: {
    command: string;
    passed: number;
    failed: number;
    skipped: number;
    seq: number;
    tMs: number;
    stepId: StepId;
  };
}

export interface Finding {
  id: FindingId;
  ruleId: SignalId;
  ruleVersion: number;
  severity: Severity;
  anchorSeq: number;
  /** The step the finding pins to; always one of stepIds (R25). */
  anchorStepId: StepId;
  headline: string;
  reason: string;
  stepIds: StepId[];
  chapterIds: UnitStableId[];
  evidenceSeqs: number[];
  /** claim_contradicted only. */
  claim?: ClaimObservation;
  /** claim_contradicted only: the claim message step (R25). */
  claimStepId?: StepId;
  /** claim_contradicted only: the failed test or check steps behind the contradiction (R25). */
  evidenceStepIds?: StepId[];
  /** claim_contradicted only: [start, end) in UTF-16 code units of the claim step's text (R25). */
  claimSpan?: [number, number];
  /** destructive_command only. */
  matchedPattern?: string;
  /** guardrail_clamp only. */
  clampId?: string;
}

export interface Gap {
  kind: GapKind;
  atSeq: number;
  message: string;
}

export interface SignalMeta {
  id: SignalId;
  version: number;
  severity: Severity;
  title: string;
  rationale: string;
  knownFalsePositives: string[];
  requires: Capability[];
}

export interface SignalCoverage {
  id: SignalId;
  active: boolean;
  missing: Capability[];
}

export interface Coverage {
  /** Present in the folded rows, in CAPABILITIES order. */
  capabilities: Capability[];
  /** One entry per SIGNAL_IDS entry, in that order. */
  signals: SignalCoverage[];
  /** Any chapter joined by time window (D11 header notice). */
  approximateJoins: boolean;
  inferredSteps: number;
}

export interface Hidden {
  /** Rows received but not rendered as steps (graph_*, telemetry, ui_snapshot, failure, command, …). */
  byType: Partial<Record<EventStoreType, number>>;
  /** loadedThroughSeq minus rows received: rows the source filtered out (gapless seq). */
  unreceived: number;
}

export interface TraceSession {
  schemaVersion: typeof TRACE_SCHEMA_VERSION;
  meta: TraceSessionSummary;
  live: boolean;
  loadedThroughSeq: number;
  /** Epoch ms of display-clock zero: the first clock row's source time, else Date.parse(meta.startedAt) (spec §6.5). */
  originMs: number;
  span: { startTs: string; endTs: string; durationMs: number };
  /** Every list below is sorted by (seq, id), never by Map iteration order. */
  turns: Turn[];
  steps: Step[];
  chapters: Chapter[];
  entities: Entity[];
  findings: Finding[];
  gaps: Gap[];
  coverage: Coverage;
  hidden: Hidden;
}

// ------------------------------------------------------------ mini graphics (D8)

export type GraphicSpec =
  | {
      kind: "diff";
      added: number;
      removed: number;
      /** Chapters: per file, ordered by lines changed, at most 4 (spec §7.5 "DiffBar shows the top 4 files and +k"). */
      files?: { path: string; added: number; removed: number }[];
      moreFiles?: number;
    }
  | { kind: "tests"; passed: number; failed: number; skipped: number }
  | {
      kind: "duration";
      /** null while running. */
      durationMs: number | null;
      running: boolean;
      status: StepStatus;
      /** bad_dot: a failed test or check; exit_x: a command with exit > 0 (spec §7.12 DurationBar). */
      end: "none" | "bad_dot" | "exit_x";
    }
  | {
      kind: "fork";
      options: { label: string; chosen: boolean }[];
      decidedBy: "supervisor" | "delegated" | "open";
    }
  | { kind: "flow"; nodes: string[]; focus: number }
  /** Schema chapters, from schemaChanges (spec §6.2, §6.6); v1 has no foreign keys. */
  | { kind: "table"; tables: { name: string; role: "new" | "altered"; columns: number }[] }
  | {
      kind: "claim";
      claim: { text: string; span?: [number, number]; tMs: number };
      observed: { passed: number; failed: number; command: string; tMs: number };
    };
```

**R25 and UI index fields.** The file above already declares every field decision record R25 lists for the UI: `DecisionDetail.answerSeq?`, `Step.startMs`, `Turn.planStepId?`, `Turn.claimStepId?`, `Chapter.current`, `Chapter.noise`, `Chapter.validationStepIds`, `Finding.anchorStepId`, `Finding.claimStepId?`, `Finding.evidenceStepIds?`, `Finding.claimSpan?`. It also carries the UI index §1.2(a) additions: `LEVELS`/`Level` (R20), `CommandDetail.outputTail?`, `Chapter.triad.clientKind?`, `TraceSession.originMs` (spec §6.5) and the `diff` (per-file list), `duration` (`durationMs`, `running`, `end`), `table` (`columns` count, no foreign keys) and `claim` (`span`, `tMs`) members of `GraphicSpec`. Lane B derives all of them (section 2.6). **Lane B is the only other writer of this file:** B-4 adds `TestDetail.resultSeq?: number` (the `test_result` seq behind a run).

Required tests (`types.test.ts`): `parseStableId(fileStableId("docs/odd\nname.md"))` round-trips (the `s` flag); `stepStableId(12)` is `"step:12"` and throws `RangeError` for `0` and `1.5`; `decisionStableId("dec-oauth-0001")` is `"decision:dec-oauth-0001"` (fixture ids have hyphens); `fileStableId("src/a:b.ts")` round-trips through `parseStableId` to `{ kind: "file", key: "src/a:b.ts" }`; `findingStableId("claim_contradicted", 1, 48)` is `"finding:claim_contradicted@1:48"`; `parseStableId("step:0")`, `parseStableId("chapter:1")` and `parseStableId("unit:")` return `null`; `LANES` equals `["supervisor", "agent", "commands", "edits", "tests", "jev"]`; `LEVELS` equals `["session", "chapter", "step"]`.

Icons are not part of the model. The UI lane defines `KIND_ICON` with `satisfies Record<StepKind, IconName>` in `src/ui`, so a new step kind fails typecheck until it has an icon.

#### `packages/trace-viewer/src/source.ts` — full file

```ts
import type { TraceRow, TraceRowsPage, TraceSessionSummary } from "@jevcode/contracts";

export interface TraceRowsRequest {
  afterSeq?: number;
  limit?: number;
}

/**
 * The viewer's only input, bound to one session. The Electron host adapts
 * window.jevcode.trace with createIpcTraceSource(bridge.trace, sessionId) (M5);
 * the dev host adapts a parsed TraceBundle with createStaticBundleSource (M4a).
 * The viewer never touches window.jevcode, the network or storage directly.
 */
export interface TraceSource {
  readonly sessionId: string;
  /** The session's summary. Rejects when the session does not exist. */
  summary(): Promise<TraceSessionSummary>;
  /** The paging contract of index §2.1 for this session: afterSeq defaults to 0, limit to TRACE_ROWS_PAGE_DEFAULT. */
  rows(request?: TraceRowsRequest): Promise<TraceRowsPage>;
  /** Full rows (any type) for up to TRACE_PAYLOADS_MAX seqs, ascending; unknown seqs are omitted. */
  payloads(seqs: readonly number[]): Promise<TraceRow[]>;
  /** Epoch ms on the session's source clock: Date.now() over IPC; a virtual clock for a drip source. */
  now(): number;
}

/** The afterSeq for the request that follows `page`. */
export function cursorAfter(page: TraceRowsPage): number {
  return page.nextAfterSeq ?? page.lastSeq;
}
```

The port is bound to one session (spec §7.7, §8.3): the viewer needs `summary()` for the title while rows load and `now()` for the live clock (`liveTMs = max(last step tMs, source.now() − originMs)`). There is no `TraceListSessionsRequest` or `TracePayloadsRequest`; listing sessions is the host's job. Hosts: `createStaticBundleSource(bundle, { drip? })` in `src/sources` (UI lane C1b) and `createIpcTraceSource(bridge.trace, sessionId)` in `apps/desktop` (M5), which calls `trace.listSessions({ sessionId, limit: 1 })` for `summary()` (section 2.5).

Required tests (`source.test.ts`): `cursorAfter` returns `nextAfterSeq` when set and `lastSeq` when `null`; a reader that calls `rows({ afterSeq, limit })` without a session id sees every served seq exactly once, then only new rows (lane 01 Review Focus 5); an object literal with `sessionId` and the four methods (`summary`, `rows`, `payloads`, `now`) type-checks as `TraceSource`.

Final W0 barrels: `packages/trace-viewer/src/index.ts` is `export * from "./source.js";` and `packages/trace-viewer/src/model/index.ts` is `export * from "./types.js";`. The UI waves append UI exports to `src/index.ts`; each B task appends one line to `src/model/index.ts`.

### 2.4 A1: what capture produces

A1 changes behavior behind the W0 contracts. Nothing outside A1 calls these functions except where the "Consumer" column says so.

| Item | Exact interface | Consumer |
|---|---|---|
| Normalizer context | `packages/agent-core/src/events.ts`: `export interface EventNormalizerContext { sessionId: string; now: () => string; turnId?: string }` | A1 only |
| Call ids | `packages/agent-codex/src/jsonl.ts`: `export function callIdFor(ctx: EventNormalizerContext, itemId: string \| undefined): string \| undefined` returns `undefined` without `itemId`, `` `${ctx.turnId}:${itemId}` `` with a `turnId`, else `itemId`. `mapCodexJsonlEvent` stamps `turnId` (when set) on every event and `callId` on the six call variants and on `agent_reasoning` (lane 02 deviation 5; the W0 schema allows it); `reasoning` items map to `agent_reasoning` (was `agent_message`, jsonl.ts:178-189). Keys are omitted, never set to `undefined`. | fold reads `turnId`, `callId` (B) |
| Turn minting | `CodexAdapter` mints `newId("turn")` (from `@jevcode/contracts`) before each `agent_started` in `startSession` and `spawnResume` (codex-adapter.ts:202, 436), stores it in `this.context.turnId`, and stamps it on adapter-emitted events (`agent_started`, user `agent_message`, `agent_waiting`, `agent_failed`, `agent_interrupted`). | B |
| Interrupt rows | Adapter: after `interrupt()`, the process's first terminal signal (`turn.completed`, `turn.failed`, `error`+exit or exit) becomes exactly one `agent_interrupted {reason: "interrupt"}`; later terminal signals of that process are dropped; lifecycle stays `paused`. `deliverSteer` emits `agent_interrupted {reason: "steer"}` for the running turn before `terminateRunningProcess`. Runtime: `stopSession` records `agent_interrupted {reason: "stop"}` through `ingestRecord` (which calls `appendAgentEvent`, emits `agent:event` and applies the pause) before setting `stopping` (pipeline-runtime.ts:421-424), only when `agentState` is not `completed` or `failed` (lane 02 deviation 12). `applyTerminalAgentState` maps `agent_interrupted` with reason `interrupt` or `stop` to state `paused` without `setSessionEnded`; reason `steer` keeps the current state, because the adapter relaunches Codex in the same call (lane 02 deviation 4). `session-service.ts` `stopSession` (called by the IPC stop handler after `runtime.stopSession`) no longer rewrites the state to `completed` or sets `endedAt` (lane 02 deviation 1). After stop the stored state is `paused` (was `completed`), `endedAt` stays unset and the execution claim is kept, so the boot sweep keeps it resumable for 24 h (session-recovery.ts `STALE_CLAIM_MS`). No path writes `failed` because of interrupt, steer or stop. | B (turn outcome), UI |
| Resume budget | pipeline-runtime.ts:468-473: the `agent_failed {error: "resume budget exhausted"}` is appended with `this.opts.db.appendAgentEvent` before the emit. | B |
| sourceCallId | `CommandCollector.observe(command: string, exitCode: number, sourceCallId?: string): EvidenceFact \| null`; `TestCollector.collect(text: string, command: string, runner?: TestRunnerName, sourceCallId?: string): EvidenceFact \| null`; `EvidenceSession.observeCommand(command: string, exitCode: number, sourceCallId?: string): void`; `EvidenceSession.observeTestOutput(command: string, output: string, sourceCallId?: string): void`. `observeAgentEventForEvidence` passes `event.callId`. The fact key is omitted when there is no call id. | B (evidence attach) |
| Canonical fact ids | `packages/semantic-core/src/ids.ts`: `export function factContentId(sessionId: string, record: unknown): string` returns `hashId("fact", sessionId, canonicalJson(record))`. Signature unchanged. | A2 (`trace-service` calls it), coordinator |
| Diff preparation | `packages/evidence-engine/src/diff.ts`: `export type PrepareDiff = (file: string, rawDiff: string) => GitHunkDiff;` `export function diffHash(rawDiff: string): string` (sha256 hex, first 16); `export function diffBytes(rawDiff: string): number` (UTF-8 bytes); `export const notCapturedDiff: PrepareDiff` (`{hash, bytes, truncated: false, redactions: 0, withheld: "not_captured"}`). `GitCollectorOptions` gains `prepareDiff?: PrepareDiff`. `collect()` emits a `git_hunk` only when `diffHash(raw)` differs from the last emitted hash for that file, forgets files that leave `git status --porcelain`, and sets `diff` from `(opts.prepareDiff ?? notCapturedDiff)(file, raw)`. | A1 only |
| Desktop diff policy | `apps/desktop/src/main/pipeline/redactor.ts`: `export const DIFF_TEXT_CAP_BYTES = 32 * 1024;` `export function isSecretPath(file: string): boolean` (basename matches `.env*`, `*.pem`, `*.key`, `id_rsa*`); `export function capDiffText(diff: string, capBytes?: number): { text: string; truncated: boolean }` keeps every complete hunk that ends within the cap, cutting before the last `@@` header that would overflow, and when even the first hunk overflows keeps the file header plus that hunk cut at the last full line within the cap; `export function prepareDiffForStorage(file: string, rawDiff: string): GitHunkDiff` withholds secret paths (`withheld: "secret_path"`, no text), redacts with `redactText`, then caps. The `env_value` rule (redactor.ts:42-44) accepts one leading diff prefix: pattern `/^([+\- ]?)([A-Z0-9_]*(?:KEY\|TOKEN\|SECRET\|PASSWORD\|PASSWD)[A-Z0-9_]*)\s*=\s*.+$/gm`, replacement `"$1$2=[REDACTED:env_value]"`. `createEvidenceSession` passes `prepareDiffForStorage` to the git collector and drops the two duplicate `bridgeSink.push` loops (evidence-runtime.ts:111, 122) and the revert detector's duplicate push (lane 02 deviation 6). | A2 (bundle calls `redactText`, which now also catches `+KEY=` lines) |
| Unit ↔ agent join | `ChangeUnit.agentCallIds`: (1) every `sourceCallId` on the unit's evidence facts; (2) for each agent `file_changed` with a `callId`, the unit owning the nearest-in-time evidence fact for that path (ties to the lower fact seq). Sorted ascending, key omitted when empty, included in `unitSignature` (coordinator.ts:529-538). | B (chapters, observed link) |
| Decisions and Jev logs | `Decision.ts = nowIso()` on the `answered` and `delegated` upserts (pipeline-runtime.ts ~550, ~585). `JevDecisionLog.pass`: `"A"` on attention logs, `"B"` on projection logs (three `buildJevDecisionRecord` calls in jev-stage.ts). The guardrail-suppression log (jev-stage.ts:146-160) records the real `clientKindOf(result)` and `result.confidence`, not `"degrade"` and `1`. | B (guardrail steps) |
| Graph node data | `projectGraph` node `data` gains the domain id: ChangeUnit `unitId`, File `path`, Decision `decisionId`, Validation `validationId`, Failure `failureId`; AgentEvent node ids hash `callId` when present (graph.ts:86, 254-255). | none in v1 (graph rows are hidden) |
| Fixtures | `scripts/fixture-diffs.mjs` reconciles every `git_hunk` `added`/`removed` with `git diff repo/<file> changes/<file>` (20 of 25 disagree today; lane 02 deviation 8). Every event line gains `turnId: "turn-<fixture>-1"`; command and tool start/complete pairs share `callId: "turn-<fixture>-1:item_<n>"`; derived `command_executed`/`test_result` facts carry that `sourceCallId`; every `git_hunk` carries `diff` generated by `scripts/fixture-diffs.mjs` from `repo/` → `changes/` with `prepareDiffForStorage`; oauth gains one `agent_reasoning` line immediately before the "OAuth implementation complete; all checks pass." message; the oauth failure message becomes "expected null to be 7" (events.jsonl, golden spec, pipeline-runtime.test.ts). | A2 and B tests (see section 4, "fixture drift") |

### 2.5 A2: read path API

#### `packages/storage/src/trace-reader.ts` (A2-1)

```ts
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
  /** Exact-id lookup (spec §5.4): adds AND s.id = ?, returns at most that session, and keeps it when lastEventSeq = 0. */
  sessionId?: string;
  limit: number;
}

export interface TraceReader {
  readonly dbPath: string;
  /** Joins repositories; without sessionId hides sessions with lastEventSeq = 0; ORDER BY startedAt DESC, id ASC. */
  listSessions(options: ListTraceSessionsOptions): TraceSessionSummary[];
  getSession(sessionId: string): TraceSessionSummary | undefined;
  /** One read transaction: session row, then seq > afterSeq AND seq <= lastEventSeq AND type IN (types) ORDER BY seq LIMIT limit. */
  rows(sessionId: string, afterSeq: number, limit: number, types: readonly string[]): TraceReaderPage;
  /** Rows of any type for the given seqs, ascending; unknown seqs omitted. */
  payloads(sessionId: string, seqs: readonly number[]): TraceReaderRow[];
  close(): void;
}

/** A second connection: new Database(dbPath, { fileMustExist: true }), busy_timeout = 5000, PRAGMA query_only = ON. */
export function openQueryOnlyConnection(dbPath: string): BetterSqlite3.Database;

export function openTraceReader(dbPath: string): TraceReader;
```

Lists of types and seqs bind as one JSON array parameter: `type IN (SELECT value FROM json_each(?))`, `seq IN (SELECT value FROM json_each(?))`. `storage/src/index.ts` exports `openTraceReader` and the four types; `openQueryOnlyConnection` stays module-internal (the test imports `./trace-reader.js`). The reader never opens `":memory:"`; tests use `tempDbPath()` from `src/test-utils.ts`.

#### `apps/desktop/src/main/trace-service.ts` (A2-2)

```ts
import type {
  TraceRow,
  TraceRowsPage,
  TraceSessionSummary,
} from "@jevcode/contracts";
import type { TraceReader, TraceReaderRow } from "@jevcode/storage";

export interface TraceService {
  /** Passes repoId and sessionId through to the reader. */
  listSessions(request: { repoId?: string; sessionId?: string; limit?: number }): TraceSessionSummary[];
  /** Throws IpcError("UNKNOWN_SESSION") when the session row is missing. */
  session(sessionId: string): TraceSessionSummary;
  /** Paging contract of section 2.1; types = TRACE_ROW_TYPES; limit defaults to TRACE_ROWS_PAGE_DEFAULT. */
  rows(request: { sessionId: string; afterSeq?: number; limit?: number }): TraceRowsPage;
  payloads(request: { sessionId: string; seqs: readonly number[] }): TraceRow[];
}

export function createTraceService(reader: TraceReader): TraceService;

/** JSON.parse(payloadJson); factId = factContentId(sessionId, payload) for evidence_fact rows (before clipping); then clipPayload. */
export function toTraceRow(sessionId: string, row: TraceReaderRow): TraceRow;

/** Deep walk; a string longer than maxChars becomes head(maxChars/2) + "\n… [N characters clipped] …\n" + tail(maxChars/2). */
export function clipPayload(
  payload: unknown,
  maxChars?: number,
): { payload: unknown; clipped: boolean };

/** Pages rows() from afterSeq 0 until nextAfterSeq is null. */
export function readAllRows(
  service: TraceService,
  sessionId: string,
  pageSize?: number,
): { rows: TraceRow[]; lastSeq: number; state: TraceSessionSummary["state"] };
```

`clipPayload`'s default `maxChars` is `TRACE_CLIP_CHARS`. `clipped` is written only when `true`; `factId` only for `evidence_fact` rows.

#### IPC (A2-3)

`apps/desktop/src/shared/local-channels.ts` additions:

```ts
// in RendererToMainLocalChannels:
  traceListSessions: "trace:listSessions",
  traceRows: "trace:rows",
  tracePayloads: "trace:payloads",

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

// in localToMain:
  [RendererToMainLocalChannels.traceListSessions]: TraceListSessionsPayloadSchema,
  [RendererToMainLocalChannels.traceRows]: TraceRowsPayloadSchema,
  [RendererToMainLocalChannels.tracePayloads]: TracePayloadsPayloadSchema,
```

(`TRACE_LIST_SESSIONS_MAX`, `TRACE_ROWS_PAGE_MAX`, `TRACE_PAYLOADS_MAX` come from `@jevcode/contracts`.)

`apps/desktop/src/main/trace-ipc.ts` (no `electron` import, so it is unit-testable):

```ts
import type { ToMainChannelName, ToMainPayload } from "../shared/ipc-registry.js";
import type { TraceService } from "./trace-service.js";

export type IpcHandle = <C extends ToMainChannelName>(
  channel: C,
  fn: (payload: ToMainPayload<C>, context: IpcHandleContext) => unknown | Promise<unknown>,
) => void;

/** The wrapper passes the calling window's webContents.id, so a handler can bind a request to its sender. */
export interface IpcHandleContext {
  senderId: number;
}

// trace:listSessions → { sessions: TraceSessionSummary[] }
// trace:rows         → TraceRowsPage
// trace:payloads     → { rows: TraceRow[] }
export function registerTraceHandlers(handle: IpcHandle, service: TraceService): void;
```

`TraceWindowRegistry` (Part Da, `main/trace-window.ts`) also exposes `sessionForSender(webContentsId): string | undefined`: the session a trace window shows, `undefined` for any other sender. The `trace:requestChanges` handler (`main/trace-window-ipc.ts`) accepts a note only when `sessionForSender(context.senderId)` equals the payload's `sessionId`; otherwise it throws `UNTRUSTED_SENDER` before the session-existence check, the main-window focus and the prefill.

`apps/desktop/src/main/ipc.ts`: `IpcDeps` gains `trace: TraceService;` and the last statement of `registerIpcHandlers` becomes `registerTraceHandlers(handle, deps.trace);` (the `handle` closure at lines 129-143 already runs `assertTrustedSender` and `parseToMain`). `apps/desktop/src/main/index.ts`: after `db = openDb();` open `traceReader = openTraceReader(db.dbPath)`, pass `trace: createTraceService(traceReader)` in the `registerIpcHandlers` call (line 151), and close the reader in `will-quit` before `db?.close()`.

#### Renderer API (A2-4) — `apps/desktop/src/shared/api.ts`

`JevcodeApi` gains the namespace below. It is not a `TraceSource` (the port is session-bound, section 2.3); the M5 lane adapts it with `createIpcTraceSource(bridge.trace, sessionId)`, whose `summary()` calls `listSessions({ sessionId, limit: 1 })`.

```ts
  trace: {
    listSessions(request?: { repoId?: string; sessionId?: string; limit?: number }): Promise<TraceSessionSummary[]>;
    rows(request: { sessionId: string; afterSeq?: number; limit?: number }): Promise<TraceRowsPage>;
    payloads(request: { sessionId: string; seqs: readonly number[] }): Promise<TraceRow[]>;
  };
```

Implementation: `invoke("trace:listSessions", request ?? {})` cast to `{ sessions }`; `invoke("trace:rows", request)` cast to `TraceRowsPage`; `invoke("trace:payloads", { sessionId, seqs: [...request.seqs] })` cast to `{ rows }`. Casts follow the existing trusted-cast pattern (api.ts:187-192).

#### Bundle and CLI (A2-5, A2-6)

```ts
// apps/desktop/src/main/trace-bundle.ts
import type { TraceBundle } from "@jevcode/contracts";
import type { TraceService } from "./trace-service.js";

export interface BuildTraceBundleOptions {
  homeDir?: string;      // default os.homedir()
  now?: () => string;    // default () => new Date().toISOString()
  pageSize?: number;     // default TRACE_ROWS_PAGE_MAX
}

/** readAllRows, then every string in session and rows passes redactText and has homeDir replaced by "~". factIds are kept as computed. */
export function buildTraceBundle(
  service: TraceService,
  sessionId: string,
  options?: BuildTraceBundleOptions,
): TraceBundle;

export function redactBundleValue(value: unknown, homeDir: string): { value: unknown; count: number };

/** JSON + "\n", file mode 0o600. */
export function writeTraceBundle(filePath: string, bundle: TraceBundle): void;
```

`apps/desktop/src/main/replay/cli-entry.ts`: `ReplayResult` gains `bundlePath: string`. `runReplay` writes `<outDir>/trace.json` after `await runtime.stopSession(sessionId)` and before `db.close()`, through `openTraceReader(path.join(outDir, "replay.db"))`. A2-6 adds `export async function exportMain(args: readonly string[]): Promise<number>` (flags `--db <path> --session <id> --out <file>`; missing flag prints `usage: jevcode-replay export --db <path> --session <id> --out <file>` to stderr and returns `1`; unknown session returns `1`; success prints `{"out", "rows", "redactionCount"}` JSON and returns `0`) and `replayMain` dispatches `argv[2] === "export"` to `exportMain(argv.slice(3))`. `apps/desktop/scripts/replay.mjs` needs no change: its guard only checks that `argv[2]` and `argv[3]` exist. Command: `pnpm --filter jevcode-desktop replay export --db <path> --session <id> --out <file>` (after `pnpm build`).

#### Soak (A2-7)

`scripts/soak.mjs` imports `openTraceReader` from `../packages/storage/dist/index.js` and `createTraceService`, `readAllRows`, `buildTraceBundle`, `writeTraceBundle` from `../apps/desktop/dist/main/…`. After `syncAll` and before `stopSession`, it times `readAllRows` over the soak session, adds `traceReadMs` and `traceRows` to the printed JSON, prints `soak: WARN trace read <ms> ms exceeds the 1500 ms budget` when over budget (warning, not a failure), and writes a bundle to `process.env.JEVCODE_SOAK_EXPORT` when set.

**A2 refinements** (lane 03 "Interface deviations" 2–11; names and signatures above are unchanged): `writeTraceBundle` streams rows but writes exactly `JSON.stringify(bundle) + "\n"`; bundle redaction covers `row.payload` and `session` and copies the envelope (`seq`, `type`, `ts`, `clipped`, `factId`) unchanged; `redactionCount` counts only strings that redaction changed; `homeDir` maps to `~` only at a path boundary; `buildTraceBundle` restamps `session.lastEventSeq` and `session.state` from the final page; `TraceReader.rows` throws for an unknown session and `RangeError` for a bad `afterSeq` or `limit`, while the service throws `IpcError("UNKNOWN_SESSION")` first; `toTraceRow` omits `payload` and `factId` when `payloadJson` is not JSON (the fold then records `invalid_row`); `clipPayload` never splits a surrogate pair and throws `RangeError` below `maxChars` 2; the service clamps limits as the IPC schemas do; `exportMain` accepts exactly `--db`, `--session`, `--out` and exports `EXPORT_USAGE`.

### 2.6 B: trace model API (`packages/trace-viewer/src/model`)

Every item below is exported from `@jevcode/trace-viewer/model`.

```ts
// format.ts (B-1)
export function truncateMiddle(text: string, maxGraphemes: number): string;
export function formatOffset(ms: number): string;
export function formatClock(ts: string, options?: { seconds?: boolean }): string;
export function formatDuration(ms: number | null): string;
export function agentStateLabel(state: AgentState): string;
export function agentEventLabel(event: NormalizedAgentEvent): string;
export interface StepHeadlineInput {
  kind: StepKind;
  target?: string;
  text?: string;
  tests?: TestCounts;
  exitCode?: number | null;
  decisionTitle?: string;
  clampIds?: string[];
}
export function stepHeadline(input: StepHeadlineInput): string;
// B-1 additive exports: normalizeCommand(command: string): string (trim, unwrap one `bash -lc '…'`/`zsh -lc '…'`,
// collapse whitespace); toolLabel(tool: string): string.
// B-1 exports the UI needs (spec §6.8, UI index §1.4):
/** "exit 0", "exit 1", "exit unknown" for -1, "" for null. */
export function exitLabel(exitCode: number | null): string;
/** Replaces U+202A–U+202E, U+2066–U+2069, U+200E, U+200F and C0 controls (except \t, and \n when multiline) with a visible ⟨U+XXXX⟩ token. */
export function displayUntrusted(text: string, options?: { multiline?: boolean }): string;
// B-10 appends the mini graphics here (R25: "pickGraphic/describeGraphic in model/format.ts"):
export function pickGraphic(target: Step | Chapter, session: TraceSession): GraphicSpec | null;
export function describeGraphic(spec: GraphicSpec): string;

// short-title.ts (C2 fix wave, ruling M2; spec §6.6 "Short titles")
export const SHORT_TITLE_MAX = 24;
/** semantic-core's placeholder "Changed N file(s): …". */
export function isPlaceholderTitle(title: string): boolean;
/** First clause of agent prose, cut at a word to ≤ SHORT_TITLE_MAX graphemes; controls are kept for displayUntrusted. */
export function shortenTitle(text: string): string;
/** Chapter.shortTitle: "Tests · oauth" for a placeholder title, else shortenTitle(title). */
export function chapterShortTitle(input: { title: string; category: ChangeCategory; files: readonly string[] }): string;
```

`model/classify.ts` also exports two predicates the fold and signals share; the barrel does not re-export them. `ownsRunOutcome(chapter: Pick<Chapter, "status" | "files">, run: Step): boolean` is true when the chapter's unit failed or its files hold a failing test's file (spec §6.7 "Finding chapters"). `hasBlockingClamp(step: Step): boolean` is true for a critical clamp; only such a step carries the `guardrail` problem, so a warning clamp keeps its finding but never paints red (spec §7.12).

Pinned behavior: `truncateMiddle` counts graphemes with `Intl.Segmenter`, returns the input when it fits, keeps the whole basename for paths (`head + "…/" + basename`) when the basename fits in `max − 2`, otherwise keeps `ceil((max−1)/2)` head and `floor((max−1)/2)` tail graphemes around `"…"`. `formatOffset`: `0 → "+0:00"`, `39_000 → "+0:39"`, `725_000 → "+12:05"`, `3_723_000 → "+1:02:03"`, negatives clamp to `"+0:00"`. `formatDuration`: `null → ""`, `850 → "850 ms"`, `4_500 → "4.5 s"`, `5_000 → "5.0 s"`, `45_000 → "45 s"`, `125_000 → "2 m 05 s"`, `3_720_000 → "1 h 02 m"`. `formatClock`: `toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })` plus `second: "2-digit"` when asked; invalid ts → `""`. `agentStateLabel` returns exactly the strings of WorkspaceHost `statusLabel` (lines 185-200). `agentEventLabel` keeps `eventSummary`'s strings except `agent_completed → "Turn ended"`, `agent_reasoning → "Thinking"`, `agent_interrupted → "Paused" | "Redirected" | "Stopped"`. `eventKey` and `mergeEvents` are NOT moved (R12). `normalizeCommand("bash -lc 'pnpm  test'")` is `"pnpm test"`. `exitLabel(0)` is `"exit 0"`, `exitLabel(1)` is `"exit 1"`, `exitLabel(-1)` is `"exit unknown"` and `exitLabel(null)` is `""`. `displayUntrusted("rm \u202Efdp.exe")` is `"rm ⟨U+202E⟩fdp.exe"`; it keeps `\t` always and `\n` only with `{ multiline: true }`. `stepHeadline` and `truncateMiddle` pass their output through `displayUntrusted`, so a bidi override never reaches a title, row or mono slot.

**Mini graphics (B-10).** `pickGraphic` returns the amended `GraphicSpec` (section 2.3). For a step: a `claim_contradicted` claim step → `claim` (`claim: { text, span: finding.claimSpan, tMs }`, `observed` from the finding's evidence step); an edit → `diff` (`added`, `removed`); a test or check step with counts → `tests`; a decision → `fork`; any other command → `duration` (`durationMs`, `running: status === "running"`, `status`, `end`: `"bad_dot"` for a failed test or check, `"exit_x"` for a command with exit > 0, else `"none"`); anything else → `null`. For a chapter, spec §7.12 `CHAPTER_GRAPHIC` takes the first rule that matches: category `schema` with `schemaChanges` → `table` (`{ name, role: "new" | "altered", columns }`, at most 2); `architecture` or `api` → `flow` (up to 3 file stems ordered by first edit, `focus` = the file with most lines changed); `tests` → `tests` with the counts of the chapter's latest joined test or check run, so oauth's `oauth-linking-test-failure` chapter gives `{ kind: "tests", passed: 14, failed: 1, skipped: 0 }` (a tests chapter never falls back to its diff while it has a counted run); a chapter with an answered decision → `fork`; everything else → `diff` summed over its files, with `files` = the top 4 files by lines changed and `moreFiles` = the rest. A rule whose data is missing (a schema chapter without `schemaChanges`, an architecture or api chapter without edited files, a tests chapter without a joined test run) falls through to the next. `describeGraphic({ kind: "tests", passed: 14, failed: 1, skipped: 0 })` is `"14 passed, 1 failed"`; `describeGraphic({ kind: "diff", added: 17, removed: 3 })` is `"+17 −3"`; `describeGraphic({ kind: "duration", durationMs: 5_000, running: false, status: "failed", end: "bad_dot" })` is `"5.0 s, failed"`.

```ts
// registry.ts (B-2)
export interface KindMeta { lane: Lane; actor: Actor; label: string }
// Lanes, pinned literally in registry.test.ts: instruction, approval, decision → supervisor; message, reasoning, tool,
// lifecycle → agent; command → commands; edit, read, dependency, revert → edits; test, check → tests;
// guardrail, attention → jev.
export const KIND_META: { readonly [K in StepKind]: KindMeta };
export type RowDisposition = "consume" | "hidden";
export const ENVELOPE_RULES: { readonly [K in EventStoreType]: RowDisposition };   // consume = TRACE_ROW_TYPES
export interface AgentEventRule { kind: StepKind; role: "start" | "complete" | "point" }
export const AGENT_EVENT_RULES: { readonly [K in NormalizedAgentEventType]: AgentEventRule };
export interface FactRule { kind: StepKind; attach: "call" | "path" | "none" }
export const FACT_RULES: { readonly [K in EvidenceFactType]: FactRule };
export interface ClampMeta { label: string; severity: Severity }
// The 15 clamp ids pushed in packages/jev-router/src/guardrails.ts:76-256: destructive_command, security_path,
// schema_floor, public_api, suppress_formatting, suppress_lockfile, suppress_passing_tests, failed_unit_relevance,
// interrupt_floor, decision_presence_floor, noise_triad_cap_formatting, noise_triad_cap_lockfile,
// failed_unit_attention, required_decision_attention, attention_sanitize.
// Severity (R11): destructive_command critical; security_path, schema_floor, public_api, failed_unit_relevance,
// failed_unit_attention warning; all others info.
export const CLAMP_META: Readonly<Record<string, ClampMeta>>;
export function clampMeta(id: string): ClampMeta;               // unknown id → { label: id, severity: "info" }
// B-2 additive exports: severityRank(severity: Severity): number; CHECK_COMMAND: RegExp; TEST_COMMAND: RegExp;
// commandKind(command: string): "check" | "test" | "command"; isLockfilePath(path: string): boolean; READ_TOOL: RegExp.

// rows.ts (B-2)
export interface PipelineRowOptions {
  /** Called for evidence facts; the harness passes semantic-core's factContentId. The model never hashes. */
  factId?: (fact: EvidenceFact) => string;
  /** Default 1. */
  firstSeq?: number;
}
/** Classifies each record (EvidenceFact, NormalizedAgentEvent, Decision, ChangeUnit, ValidationResult,
 *  JevDecisionLog, SemanticEvent, tried in that order) into a TraceRow; seq = firstSeq + index;
 *  ts = record.ts, else updatedAt, else createdAt, else the previous row's ts. Throws TypeError on an unknown record. */
export function rowsFromPipelineRecords(
  records: readonly unknown[],
  options?: PipelineRowOptions,
): TraceRow[];

// fold.ts (B-3)
export interface TraceState {
  readonly meta: TraceSessionSummary;
  readonly loadedThroughSeq: number;
  readonly received: number;
}
export interface FinalizeOptions {
  live: boolean;
  /** Overrides meta.state (the latest TraceRowsPage.state). */
  state?: AgentState;
  /** cursorAfter(lastPage); raises loadedThroughSeq past filtered rows. */
  throughSeq?: number;
  /** Epoch ms from TraceSource.now(). With live, an open step gets durationMs = nowMs − startMs (spec §6.5); without it, null. */
  nowMs?: number;
}
export function createTraceState(meta: TraceSessionSummary): TraceState;
/** Mutates state and returns it. A seq already folded is skipped silently; a new seq below the max
 *  folded seq adds an out_of_order gap and is skipped; a payload that fails its contracts schema adds an
 *  invalid_row gap; a type outside EVENT_TYPES adds an unknown_row_type gap. */
export function accumulate(state: TraceState, row: TraceRow): TraceState;
export function accumulateAll(state: TraceState, rows: readonly TraceRow[]): TraceState;
/** Never mutates state. Same rows in any batch split produce a deep-equal TraceSession. */
export function finalize(state: TraceState, options: FinalizeOptions): TraceSession;
export function foldRows(
  meta: TraceSessionSummary,
  rows: readonly TraceRow[],
  options: FinalizeOptions,
): TraceSession;

// signals.ts (B-7)
export interface SignalInput {
  session: Omit<TraceSession, "findings" | "coverage">;
}
export interface FindingDraft {
  anchorSeq: number;
  /** One of stepIds (R25; every rule sets it in B-7). */
  anchorStepId: StepId;
  severity: Severity;
  headline: string;
  reason: string;
  stepIds: StepId[];
  chapterIds: UnitStableId[];
  evidenceSeqs: number[];
  claim?: ClaimObservation;
  /** claim_contradicted only (R25, B-12). */
  claimStepId?: StepId;
  evidenceStepIds?: StepId[];
  claimSpan?: [number, number];
  matchedPattern?: string;
  clampId?: string;
}
export interface SignalRule extends SignalMeta {
  evaluate(input: SignalInput): FindingDraft[];
}
export const SIGNALS: { readonly [K in SignalId]: SignalRule & { readonly id: K } };
export function signalMeta(id: SignalId): SignalMeta;
// B-7 additive exports:
/** Rule rank inside a severity (spec §6.7 FINDING_ORDER): claim_contradicted 0, destructive_command 1,
 *  failing_tests 2, guardrail_clamp 3, recovery_arc 4. */
export const FINDING_RULE_RANK: { readonly [K in SignalId]: number };
/** Severity (critical > warning > info), then FINDING_RULE_RANK, then anchorSeq ascending, then id. */
export function compareFindings(a: Finding, b: Finding): number;
export function isSuccessClaim(text: string): boolean;
export function computeCoverage(capabilities: ReadonlySet<Capability>, approximateJoins: boolean, inferredSteps: number): Coverage;
export function applySignals(input: SignalInput, coverage: Coverage): Finding[];
// B-12 additive exports (R25):
/** [start, end) UTF-16 range of the first non-negated success phrase, else of a clause-final completion word. */
export function matchSuccessClaim(text: string): [number, number] | null;
/** Starts with "Plan" or lists at least two items. */
export function isPlanText(text: string): boolean;
/** Sets Turn.planStepId and Turn.claimStepId; finalize calls it before signals. */
export function markTurns(turns: readonly Turn[], stepById: ReadonlyMap<StepId, Step>): void;

// search.ts, lookup.ts (B-10); pickGraphic and describeGraphic are in format.ts (above)
export interface SearchIndex {
  readonly entries: ReadonlyArray<{ id: StepId; haystack: string }>;
}
export function buildSearchIndex(session: TraceSession): SearchIndex;
/** Lower-cased whitespace-split terms; every term must match; ids in step order. Haystack: headline,
 *  target, text (first 8 KiB), command, edit path, test failure names. No stdout. */
export function searchSteps(index: SearchIndex, query: string): StepId[];

export type ResolvedTarget =
  | { kind: "step"; step: Step }
  | { kind: "unit"; chapter: Chapter }
  | { kind: "decision"; step: Step }
  | { kind: "file"; entity: Entity }
  | { kind: "finding"; finding: Finding };
export function resolveStableId(session: TraceSession, id: StableId): ResolvedTarget | null;
```

**Where lane B derives the R25 fields** (declared by W0-6, section 2.3):

| Field | Task | Rule |
|---|---|---|
| `Step.startMs` | B-3 | `sourceMs(clock, ctx)` in `fold-state.ts`: the row's parsed source time, unclamped; for `decision`, `validation`, `change_unit` and `jev_decision` rows the session origin plus the inherited clock; never `NaN` |
| `TraceSession.originMs` | B-3 | the first clock row's (`agent_event` or `evidence_fact`) source time, else `Date.parse(meta.startedAt)`; `Step.tMs === Math.max(startMs − originMs, previous tMs, 0)` (spec §6.5) |
| `CommandDetail.outputTail` | B-3 | from `command_completed`: stdout then stderr, the last 20 lines, at most 2,048 UTF-16 code units; omitted when both are empty |
| live `durationMs` | B-3 | `FinalizeOptions.nowMs`: with `live`, an open step gets `nowMs − startMs`; otherwise an unpaired step keeps `null` |
| `Chapter.triad.clientKind` | B-5 | the unit's latest `jev_decision` row that is not Pass B and whose `output` parses with `AttentionDecisionSchema` sets `importance`, `relevance`, `interruption` and `clientKind`; without one, the unit's own scores and no `clientKind` (spec §6.6) |
| `GraphicSpec` shapes | B-10 | `pickGraphic`/`describeGraphic` per "Mini graphics (B-10)" above |
| `Chapter.current` | B-5 | `status !== "superseded"` |
| `Chapter.noise` | B-5, B-7 | at least one joined edit and every joined edit is a lockfile or formatting-only change, or the latest Pass A `jev_decision` row for the unit has `shouldSurface: false` (`ChapterState.surfaceByUnit`); `applySignals` (B-7) clears it on a chapter a finding names |
| `Chapter.validationStepIds` | B-5 | steps the unit's `validationResults` attached to, seq order |
| `Finding.anchorStepId` | B-7 | every rule sets it; always one of `stepIds` (claim step, test run, command, guardrail step, recovered run) |
| `Turn.planStepId`, `Turn.claimStepId` | B-12 | `markTurns`: plan = first assistant message before the turn's first edit that starts with "Plan" or lists at least two items; claim = the turn's last success claim, the only claim `claim_contradicted` checks |
| `Finding.claimStepId`, `evidenceStepIds`, `claimSpan` | B-12 | claim step; the failed run; `matchSuccessClaim(text)` = `[start, end)` UTF-16 range of the first non-negated success phrase ("all checks pass"), else of a clause-final completion word |
| decision `target`, `DecisionDetail.answerSeq` | B-12 | `target` = `Decision.id`; a user `agent_message` whose next decision row answers or delegates an already-open decision is removed as an instruction step and its seq joins the decision step (`answerSeq`); the step keeps `step:<firstSeq>` |

**Fold behavior the UI and signals rely on (R8, R10).**
- **Turns** split on `agent_started`. Trigger: index 0 is `initial`; `steer` when the previous turn ended `interrupted` with reason `steer` or had no terminal event; otherwise `resume`. Outcome: the turn's last terminal event wins (`agent_completed` → `completed`, `agent_failed` → `failed`, `agent_interrupted` → `interrupted` with `interruptReason`); with no terminal event, `interrupted` when a later turn exists, else `running`/`waiting` when live (waiting when the last agent event is `agent_waiting` or an open `approval_requested`), else `unknown`.
- **Pairing**: starts and completions pair by `callId` (`provenance: "observed"`), else FIFO by family and target within the turn (`inferred`). `test_started`/`test_completed` inside an open command with the same command fold into that command step. A start still open at its turn's end becomes `unknown` plus an `unpaired` gap (not live) or stays `running` (live, last turn).
- **Command status**: exit `0` → `ok`; `> 0` → `failed` plus `exit_nonzero`; `-1` → `unknown`.
- **Evidence attach**: `command_executed`, `test_result` and `validation` rows join the step whose `callId` equals `sourceCallId` (`observed`), else the latest step in the same turn whose whitespace-normalized command matches (`inferred`). A `test_result` makes the step `test`, or `check` when the command matches `/\b(tsc|typecheck|lint|eslint|build)\b/` or the validation kind is `typecheck`/`lint`/`build`. `failed > 0` sets `failed` plus `tests_failed`.
- **Edits**: an agent `file_changed` is a claim (`actor: "agent"`); repo `file_changed`/`git_hunk`/`symbol_delta` for the same path join that path's latest edit step in the turn (`observed: true`), else start a repo edit step (`actor: "repo"`). A `git_hunk` whose `diff.hash` (or `added`/`removed` when `diff` is absent) equals the previous one for that path is `duplicate_poll` noise.
- **Chapters**: one per change unit id, from its latest version. Links: unit `evidence` fact ids matched to row `factId`s plus `agentCallIds` matched to step `callId`s (`link: "observed"`); when neither resolves, steps inside `[createdAt, updatedAt]` touching `unit.files` (`link: "inferred"`, counted in `evidenceLinks.approx`). Superseded units stay with status `superseded`.
- **Decisions**: all `decision` rows with one id fold into one `decision` step (`step:<firstSeq>`, `target` = the decision id); `decision:<id>` resolves to it. The supervisor's answer message joins that step (B-12). **Jev**: a `jev_decision` with clamps becomes a `guardrail` step and adds `clampIds` to its chapter; one without clamps becomes an `attention` step with noise `lifecycle`.
- **Problems** are orthogonal to kind. **Noise** is never set on a step with a problem or a finding. `missing_evidence` is raised only for closed turns: a completed test-like command with no test result, or an agent edit claim with no repo fact by turn end.
- **Signals v1** (R11): `claim_contradicted` (critical), `failing_tests` (warning; critical when the target's final run failed), `destructive_command` (critical; `matchDestructive`), `guardrail_clamp` (per `clampMeta`; unknown ids info), `recovery_arc` (info). Findings are derived at read time, never persisted, and only keep steps from collapsing. `compareFindings` orders them for the UI (spec §6.7 `FINDING_ORDER`): on oauth and api-break the first is `claim_contradicted`, although oauth's `failing_tests` is also critical and earlier; `session.findings` itself stays sorted by `(seq, id)`.
- **Budgets**: 75k-row fold `<= 500 ms`, one appended row `<= 2 ms`, measured by `pnpm --filter @jevcode/trace-viewer bench` (not a CI gate).
- **Clock** (lane 04 deviation 8, spec §6.5): only `agent_event` and `evidence_fact` payload times move the display clock, and the first of them is the origin (`meta.startedAt` is only the fallback), because `replay.db` stamps pipeline rows and `sessions.startedAt` with the replay run's wall clock. `change_unit`, `decision`, `validation` and `jev_decision` rows inherit the clock. `Step.tMs` is ms since that origin (`TraceSession.originMs`), never decreasing with seq; this refines R25's "ts − startedAt".
- **Claim scope** (lane 04 spec note): a turn's `claimStepId` is contradicted when the latest earlier run of any test or check command in the session failed. `matchSuccessClaim` counts completion words ("complete", "done", "finished") only at the end of a clause.

**Fixture harness** (`src/test-support/fixture-rows.ts`, B-2, test-only):

```ts
export const FIXTURE_NAMES = ["oauth", "rate-limit", "schema-change", "api-break", "dep-change"] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];
export interface FixtureTrace {
  meta: TraceSessionSummary;
  rows: TraceRow[];
}
/** Reads fixtures/<name>/events.jsonl, parses each line with parseReplayLine, ingests all records into a
 *  PipelineCoordinator, flushes, and returns the records' rows (factId = factContentId) followed by one
 *  change_unit row per snapshot unit and one validation row per snapshot validation. meta.state = "completed". */
export function loadFixtureTrace(name: FixtureName): FixtureTrace;
/** D11 variant: drops turnId, callId, sourceCallId, factId and agentCallIds from every row. */
export function stripCaptureFields(rows: readonly TraceRow[]): TraceRow[];
/** A1-9 shape: adds turnId, callId and sourceCallId to rows that lack them. */
export function addCaptureFields(rows: readonly TraceRow[]): TraceRow[];
```

---

## 3. Task list

Size: S ≈ one test file and one small module; M ≈ 2–4 files; L ≈ 5+ files or a dense algorithm. Every task ends with one conventional commit and passes the checks in section 5.

### W0: contracts foundation (lane file 01, runs alone)

| ID | Title | Files | Depends on | Size |
|---|---|---|---|---|
| W0-1 | Scaffold `@jevcode/trace-viewer` and the dev host; add every dependency; lint boundaries; SPEC §2.2 and §18 | `packages/trace-viewer/{package.json, tsconfig.json, tsconfig.build.json, vitest.config.ts, scripts/copy-assets.mjs, src/css-modules.d.ts, src/index.ts, src/model/index.ts, src/lint-boundaries.test.ts}`; `apps/trace-viewer-dev/{package.json, tsconfig.json, vite.config.ts, index.html, src/main.tsx}`; `apps/desktop/package.json`; `packages/contracts/package.json`; `packages/ui-catalog/package.json`; `eslint.config.mjs`; `pnpm-lock.yaml`; `docs/SPEC.md` | — | L |
| W0-2 | Browser-safe contracts barrel (`newId` via `globalThis.crypto`, `symbolId` → `@jevcode/contracts/node`) | `packages/contracts/{package.json, src/id.ts, src/id.test.ts, src/node.ts, src/node.test.ts, src/browser-safety.test.ts}`; `packages/evidence-engine/src/{symbol-diff.ts, symbol-diff.test.ts}`; `packages/semantic-core/src/clustering.ts`; `eslint.config.mjs`; `packages/trace-viewer/src/lint-boundaries.test.ts`; `apps/trace-viewer-dev/src/main.tsx` | W0-1 | M |
| W0-3 | `canonicalJson` | `packages/contracts/src/{canonical-json.ts, canonical-json.test.ts, index.ts}` | W0-2 | S |
| W0-4 | Capture contract fields (`turnId`, `callId`, `agent_reasoning`, `agent_interrupted`, `sourceCallId`, `git_hunk.diff`, `agentCallIds`, `Decision.ts`, `JevDecisionLog.pass`); WorkspaceHost cases; SPEC §4.1–§4.3 | `packages/contracts/src/{agent-events.ts, agent-events.test.ts, evidence.ts, evidence.test.ts, semantic.ts, semantic.test.ts, jev.ts, jev.test.ts}`; `apps/desktop/src/renderer/components/WorkspaceHost.tsx`; `docs/SPEC.md` | W0-3 | M |
| W0-5 | Read-path contracts (`trace.ts`); `EVENT_TYPES` moves from storage; SPEC §4.5 and §15 | `packages/contracts/src/{trace.ts, trace.test.ts, index.ts}`; `packages/storage/src/{db.ts, db.test.ts}`; `docs/SPEC.md` | W0-4 | M |
| W0-6 | Model types (including the R25 UI fields and the UI index §1.2 additions), stable-id helpers, session-bound `TraceSource`, `cursorAfter`; final dev-host placeholder | `packages/trace-viewer/src/{model/types.ts, model/types.test.ts, model/index.ts, source.ts, source.test.ts, index.ts}`; `apps/trace-viewer-dev/src/main.tsx` | W0-5 | M |

- **W0-1** Produces: section 2.2 in full. Deliverable: `pnpm install` updates the lockfile (`134	0`) with the single-version check output unchanged; the virtual-core check prints `3`; `pnpm -r build` succeeds including `jevcode-trace-viewer-dev`; `@jevcode/ui-catalog/components/CodeDiff` resolves from `packages/trace-viewer`; the 16 `lint-boundaries.test.ts` cases pass (the model→layout ban and the `src/layout` block included).
- **W0-2** Consumes: W0-1 lint harness and dev host. Produces: `newId`, `@jevcode/contracts/node` `symbolId`. Failing test first: `browser-safety.test.ts` lists `id.ts -> node:crypto`, and `pnpm --filter jevcode-trace-viewer-dev build` fails with `browser bundle imports "node:crypto"` once `main.tsx` imports the contracts barrel.
- **W0-3** Produces: `canonicalJson`.
- **W0-4** Produces: section 2.1 capture schemas. Required tests: every new variant and field parses; a pre-change row of each touched variant still parses; `agent_interrupted` with reason `"cancel"` fails; `GitHunkDiffSchema` rejects `{ withheld: "secret_path", text: "x", … }` and a 15-char hash; `tsc -p apps/desktop/tsconfig.web.json --noEmit` passes.
- **W0-5** Produces: section 2.1 `trace.ts`. Required tests: `EVENT_TYPES` equals the 14-type list; `isTraceRowType("telemetry") === false`; `TraceRowSchema` accepts type `"future_row"` and rejects `seq: 0`; `TraceBundleSchema` rejects `version: 2`; storage `EVENT_TYPES` is the same array object as contracts `EVENT_TYPES`.
- **W0-6** Produces: section 2.3 in full. Required tests are listed there (`types.test.ts` 11 cases including `LEVELS`, `source.test.ts` 4 cases against the session-bound port); `@jevcode/trace-viewer` ends W0 with 33 tests (18 lint-boundary cases, 11, 4).

### A1: capture (lane file 02, wave W1)

| ID | Title | Files | Depends on | Size |
|---|---|---|---|---|
| A1-1 | M0: `openDb` creates `~/.jevcode` 0700 and `jevcode.db`, `-wal`, `-shm` 0600; SPEC §11 | `packages/storage/src/{db.ts, db.test.ts}`; `docs/SPEC.md` | W0 | S |
| A1-2 | M1a: per-process `turnId`, `callId` from `item.id`, `agent_reasoning` mapping; codex-spike §3 | `packages/agent-core/src/{events.ts, events.test.ts}`; `packages/agent-codex/src/{jsonl.ts, jsonl.test.ts, codex-adapter.ts, codex-adapter.test.ts}`; `docs/spikes/codex-spike.md` | W0 | M |
| A1-3 | M1a: honest lifecycle (`agent_interrupted` for interrupt, steer, stop; paused not failed; resume-budget failure persisted); SPEC §3.1, §3.1b, §10; codex-spike §3, §4 | `packages/agent-codex/src/{codex-adapter.ts, codex-adapter.test.ts, delivery-queue.test.ts}`; `packages/agent-codex/test/fixtures/fake-codex.cjs`; `apps/desktop/src/main/pipeline/{pipeline-runtime.ts, pipeline-runtime.test.ts, resume-budget.test.ts}`; `apps/desktop/src/main/{session-service.ts, session-guard.test.ts}`; `docs/SPEC.md`; `docs/spikes/codex-spike.md` | A1-2 | L |
| A1-4 | M1a: `sourceCallId` stamped by `observeCommand`/`observeTestOutput` | `packages/evidence-engine/src/collectors/{commands.ts, commands.test.ts, tests.ts, tests.test.ts}`; `apps/desktop/src/main/pipeline/{evidence-runtime.ts, pipeline-runtime.ts, pipeline-runtime.test.ts}` | A1-3 | M |
| A1-5 | M1b: canonical `factContentId` and the zod no-strip guards | `packages/semantic-core/src/{ids.ts, ids.test.ts, fixtures.test.ts}`; `packages/agent-codex/src/no-strip.test.ts`; `packages/evidence-engine/src/no-strip.test.ts` | A1-4 | M |
| A1-6 | M1b: git collector `prepareDiff` injection and change-only emission; SPEC §7 | `packages/evidence-engine/src/{diff.ts, diff.test.ts, index.ts, collectors/git.ts, collectors/git.test.ts}`; `docs/SPEC.md` | A1-5 | M |
| A1-7 | M1b: desktop diff policy (secret paths, prefixed `env_value`, 32 KiB cap) and double-push removal; SPEC §3.7 | `apps/desktop/src/main/pipeline/{redactor.ts, redactor.test.ts, evidence-runtime.ts, evidence-runtime.test.ts}`; `docs/SPEC.md` | A1-1, A1-6 | M |
| A1-8 | M1b: `ChangeUnit.agentCallIds` in `clusterSession` and `unitSignature` | `packages/semantic-core/src/{clustering.ts, clustering.test.ts, clustering.property.test.ts, coordinator.ts, coordinator.test.ts}` | A1-5 | M |
| A1-9 | M1b: fixtures gain `turnId`, `callId`, `sourceCallId`, `diff`, one `agent_reasoning`; `added`/`removed` reconciled with the real diffs; failure text fix; validator checks diff counts | `fixtures/{api-break,dep-change,oauth,rate-limit,schema-change}/events.jsonl`; `fixtures/oauth/golden_specs/oauth-linking-test-failure.json`; `fixtures/README.md`; `scripts/{fixture-diffs.mjs, validate-fixtures.mjs}`; `apps/desktop/src/main/pipeline/pipeline-runtime.test.ts`; `packages/semantic-core/src/fixtures.test.ts` | A1-7, A1-8 | L |
| A1-10 | M1c: `Decision.ts`, `JevDecisionLog.pass`, real suppression logging; SPEC §8.5 | `apps/desktop/src/main/pipeline/{pipeline-runtime.ts, pipeline-runtime.test.ts, jev-stage.ts, jev-stage.test.ts}`; `docs/SPEC.md` | A1-9 | M |
| A1-11 | M1c: graph node domain ids; AgentEvent nodes keyed by `callId` | `packages/semantic-core/src/{graph.ts, graph.test.ts}` | A1-9 | S |

- **A1-1** Test: create a DB under a fresh temp dir; `statSync(dir).mode & 0o777 === 0o700`, file, `-wal`, `-shm` `=== 0o600`; `":memory:"` still opens. Skipped on `win32`. Lands as its own small PR from the lane's first commit (R1 "separate small PR, before M1b").
- **A1-2** Test on `test/fixtures/documented-tool-rich.jsonl`: start/complete pairs share `callId` of the form `` `${turnId}:${item.id}` ``; no `reasoning` item becomes `agent_message`; every event carries the context `turnId`.
- **A1-3** Tests: codex-adapter.test.ts:190-203 now expects state `paused` and one `agent_interrupted {reason: "interrupt"}` and no `agent_failed`; the resume test at :216 waits for `paused`, not `failed`; **Review Focus 4**: "SIGINT during a command yields one agent_interrupted" with `fake-codex.cjs` answering ^C with `turn.completed` (env `FAKE_CODEX_COMPLETE_ON_INTERRUPT=1`): exactly one `agent_interrupted`, zero `agent_completed`; `stopSession` on a running session appends one `agent_interrupted {reason: "stop"}` and stores `paused`; resume-budget.test.ts asserts the `agent_failed` row is in `db.listAgentEvents`.
- **A1-4** Test: a `pnpm test` completion with `callId` yields `command_executed` and `test_result` facts whose `sourceCallId` equals it.
- **A1-5** Tests: a collector-order `git_hunk` and its zod-parsed copy get one `factContentId`; `canonicalJson(Schema.parse(x)) === canonicalJson(x)` for every Codex fixture event, every collector fact and every `fixtures/*/events.jsonl` line.
- **A1-6** Tests (git.test.ts:153-195 updated): an unchanged re-collect emits nothing; an edit emits one fact; a file that leaves `git status` and returns emits again; without `prepareDiff` the fact has `withheld: "not_captured"` and no `text`.
- **A1-7** Tests: `.env.local` is withheld ("withholds a secret path and stores no text"); a 40 KiB two-hunk diff is cut before the second `@@` with `truncated: true`; **Review Focus 5**: "redacts a prefixed env line inside a diff and keeps the prefix" (`redactText("+STRIPE_KEY=sk_live_abc").count === 1` and the diff text keeps the `+`); each git and revert fact reaches `onFact` once.
- **A1-8** Property added to clustering.property.test.ts: for every unit, `agentCallIds ⊇` the `sourceCallId`s of its evidence facts, and the array is sorted and unique.
- **A1-9** Deliverable: `node scripts/validate-fixtures.mjs` passes with the new count check; `pnpm --filter @jevcode/semantic-core test` and `pnpm --filter jevcode-desktop test` stay green; `pnpm --filter jevcode-evals test` stays green.
- **A1-10** Test: answering a decision stores `ts`; attention logs carry `pass: "A"` and projection logs `pass: "B"`; a guardrail-suppressed unit logs the client's real `clientKind`.
- **A1-11** Test: two AgentEvent inputs with the same type and ts but different `callId` yield two nodes.

### A2: read path (lane file 03, wave W1)

| ID | Title | Files | Depends on | Size |
|---|---|---|---|---|
| A2-1 | `openTraceReader` on a `query_only` connection | `packages/storage/src/{trace-reader.ts, trace-reader.test.ts, index.ts}` | W0 | M |
| A2-2 | `trace-service`: `factId`, clipping, `readAllRows`, `UNKNOWN_SESSION` | `apps/desktop/src/main/{trace-service.ts, trace-service.test.ts}` | A2-1 | M |
| A2-3 | `trace:*` channels, `registerTraceHandlers`, wiring in `ipc.ts` and `index.ts` | `apps/desktop/src/shared/{local-channels.ts, ipc-registry.test.ts}`; `apps/desktop/src/main/{trace-ipc.ts, trace-ipc.test.ts, ipc.ts, index.ts}` | A2-2 | M |
| A2-4 | `JevcodeApi.trace` namespace | `apps/desktop/src/shared/{api.ts, api.test.ts}` | A2-3 | S |
| A2-5 | `buildTraceBundle`; `runReplay` writes `trace.json` | `apps/desktop/src/main/{trace-bundle.ts, trace-bundle.test.ts, replay/cli-entry.ts, replay/cli-entry.test.ts}` | A2-2 | M |
| A2-6 | `replay export --db --session --out`; demo and security docs | `apps/desktop/src/main/replay/{cli-entry.ts, cli-entry.test.ts}`; `docs/demo.md`; `docs/security.md` | A2-5 | S |
| A2-7 | Soak times a full read and can export a bundle; perf doc | `scripts/soak.mjs`; `docs/perf.md` | A2-6 | S |

- **A2-1** Tests: pages of `limit` 3 cover every trace-type seq in `1..lastSeq` exactly once and never return a `telemetry` or `ui_snapshot` row; **Review Focus 2**: "pages stay gapless while the writer appends" (append through a `JevcodeDb` on the same file between page reads; the union still equals the full set); `openQueryOnlyConnection(path).prepare("INSERT INTO repositories …").run(…)` throws `/readonly|query_only/`; `listSessions` hides a zero-event session and orders equal `startedAt` by id; "lists a zero-event session by exact id" (`listSessions({ sessionId, limit: 1 })` returns it with `lastEventSeq: 0`, while `listSessions({ limit: 10 })` still hides it); a session of another repo is listed; `openTraceReader` on a missing file throws.
- **A2-2** Tests: an `evidence_fact` row's `factId` equals `factContentId(sessionId, JSON.parse(payloadJson))`; **Review Focus 3**: "clips a 1 MiB stdout to head and tail" (`clipped: true`, length ≤ `TRACE_CLIP_CHARS + 64`, first and last 8,192 chars intact, `factId` unchanged by clipping); unknown session → `IpcError` code `UNKNOWN_SESSION`; `readAllRows` with `pageSize` 2 returns every trace row.
- **A2-3** Tests: `parseToMain("trace:rows", { sessionId: "s", limit: 5001 })` throws `INVALID_PAYLOAD`; `parseToMain("trace:listSessions", { sessionId: "" })` throws `INVALID_PAYLOAD`; `trace:payloads` with 51 seqs throws; with a pending instruction seeded (`db.upsertInstruction`), calling all three handlers leaves `db.listPendingInstructions` unchanged and `db.getEventCount`/`getLatestSeq` unchanged; an empty `sessionId` is rejected.
- **A2-4** Test (api.test.ts): with a fake `ApiDeps.invoke`, `api.trace.rows({ sessionId: "s" })` invokes `"trace:rows"` with that payload and returns the page; `payloads` sends a plain array.
- **A2-5** Tests: replaying a temp copy of `fixtures/oauth` writes `trace.json` that parses under `TraceBundleSchema` with `rows.length > 0`; every `fact_…` id in the final `change_unit` rows' `evidence` matches at least one row `factId` (holds before and after A1-5, because replay hashes and stores the same zod-ordered object); **Review Focus 5**: "redacts tokens and maps home" (a planted `token=abc123secret` message never appears and `redactionCount >= 1`; `buildTraceBundle(..., { homeDir: "/Users/tester" })` turns `/Users/tester/repo` into `~/repo`).
- **A2-6** Test: `exportMain(["--db", db, "--session", id, "--out", out])` returns `0` and writes a parseable bundle with file mode `0o600`; a missing `--session` returns `1`.
- **A2-7** Deliverable: `JEVCODE_SOAK_EVENTS=2000 node scripts/soak.mjs` prints `traceReadMs` and `traceRows`; the full soak number is recorded in `docs/perf.md` against the 1.5 s budget.

### B: trace model (lane file 04, wave W1)

| ID | Title | Files | Depends on | Size |
|---|---|---|---|---|
| B-1 | Labels and formatters (`format.ts`) | `packages/trace-viewer/src/model/{format.ts, format.test.ts, index.ts}` | W0 | M |
| B-2 | Rule registries, `rowsFromPipelineRecords`, fixture harness | `packages/trace-viewer/src/model/{registry.ts, registry.test.ts, rows.ts, rows.test.ts, index.ts}`; `packages/trace-viewer/src/test-support/fixture-rows.ts` | B-1 | M |
| B-3 | Fold core: state, seq handling, gaps, hidden, turns, agent steps, pairing, display clock | `packages/trace-viewer/src/model/{fold.ts, fold-state.ts, fold-agent.ts, fold.test.ts, index.ts}`; `packages/trace-viewer/src/test-support/trace-builder.ts` | B-2 | L |
| B-4 | Evidence attach, tests and checks, validations, edits, entities | `packages/trace-viewer/src/model/{fold-evidence.ts, fold-evidence.test.ts, fold.ts, fold-state.ts, types.ts}` | B-3 | L |
| B-5 | Chapters, decisions, guardrail and attention steps | `packages/trace-viewer/src/model/{fold-chapters.ts, fold-chapters.test.ts, fold.ts, fold-state.ts}` | B-4 | M |
| B-6 | Problems, noise, `missing_evidence`, live semantics | `packages/trace-viewer/src/model/{classify.ts, classify.test.ts, fold.ts}` | B-5 | M |
| B-7 | Signal registry, five v1 signals, coverage | `packages/trace-viewer/src/model/{signals.ts, signals.test.ts, fold.ts, index.ts}` | B-6 | L |
| B-8 | Five-fixture assertions and mutation tests | `packages/trace-viewer/src/model/{fold.fixtures.test.ts, fold.mutations.test.ts}` | B-7 | M |
| B-9 | Batch-split parity property and the fold benchmark | `packages/trace-viewer/src/model/{fold.parity.test.ts, fold.bench.ts}`; `packages/trace-viewer/src/test-support/synthetic-rows.ts` | B-8 | M |
| B-10 | Search, stable-id lookup, mini-graphic specs (`pickGraphic`/`describeGraphic` in `format.ts`, R25) | `packages/trace-viewer/src/model/{search.ts, search.test.ts, lookup.ts, lookup.test.ts, format.ts, graphics.test.ts, index.ts}` | B-7 | M |
| B-11 | WorkspaceHost uses the model's labels (R12) | `apps/desktop/src/renderer/components/WorkspaceHost.tsx` | B-1 | S |
| B-12 | R25 optional fields: `Turn.planStepId`/`claimStepId`, `Finding.claimStepId`/`evidenceStepIds`/`claimSpan`, decision `target` and answer absorption; pins the R25 fields B-3, B-5, B-7 derive | `packages/trace-viewer/src/model/{fold-state.ts, fold-agent.ts, fold-chapters.ts, signals.ts, fold.ts, ui-fields.test.ts, fold-chapters.test.ts, fold.fixtures.test.ts}` | B-8, B-10 | M |

- **B-1** Tests pin every example in section 2.6, including emoji (`"👩‍👩‍👧 family.ts"`) and Hangul (`"한국어/경로/파일이름.ts"`) truncation, `exitLabel(-1) === "exit unknown"`, `displayUntrusted("rm \u202Efdp.exe") === "rm ⟨U+202E⟩fdp.exe"`, and a command holding U+202E that reaches `stepHeadline` as the escape token.
- **B-2** Tests: `registry.test.ts` checks every `NormalizedAgentEventType`, `EvidenceFactType`, `EVENT_TYPES` entry, `StepKind` and the 15 clamp ids has non-empty metadata (catches casts that `satisfies` misses), and asserts the `KIND_META[kind].lane` table of section 2.6 literally; `rowsFromPipelineRecords` on oauth yields one row per non-empty line of `fixtures/oauth/events.jsonl`, with `seq` running 1..N in line order (N read from the file, never a literal); `loadFixtureTrace("oauth")` returns change_unit rows after the record rows.
- **B-3** Tests: a duplicate seq changes nothing; a lower seq adds `out_of_order`; a corrupt payload adds `invalid_row` and the fold continues; `callId` pairing is `observed` and FIFO pairing `inferred`; `tMs` never decreases even when ts goes backwards; **Review Focus 4**: "interrupted turn leaves the open command unknown" (rows `agent_started`, `command_started`, `agent_interrupted {reason: "steer"}`, `agent_started`: the command step is `unknown`, turn 0 is `interrupted` with reason `steer`, turn 1's trigger is `steer`, no `agent_failed` problem); exit `-1` gives status `unknown` with no `exit_nonzero`; on oauth the first step's `startMs` equals `Date.parse` of the first agent_event payload `ts` and `originMs` equals it, and every step has `tMs === Math.max(startMs − originMs, previous tMs, 0)`; a live open command finalized with `nowMs = startMs + 4_000` has `durationMs` 4000.
- **B-4** Test: oauth's `pnpm test` run is one `test` step with tests `{passed: 14, failed: 1, skipped: 0}` and status `failed`. Select rows by content (command text, fact type), never by line number (section 4, fixture drift).
- **B-5** Tests: oauth chapters match `expected_units.json` file sets; **Review Focus 1**: "legacy session joins by time window" (strip `factId` from every row and `agentCallIds` from units: every chapter that cites `fact_…` ids links `inferred` with `resolved: 0` and `approx > 0`; a failure-only unit stays `observed`; `coverage.approximateJoins` is `true`); `decision:dec-…` resolves after a status change and keeps `step:<firstSeq>`; `triad` (with `clientKind`) comes from the latest non-Pass-B attention row and never from a Pass B row.
- **B-6** Tests: a formatting-only edit is `formatting` noise; a failing test step is never noise; in live mode the open turn raises no `missing_evidence`.
- **B-7** Tests: a positive and a near-miss per signal ("not all tests pass" does not contradict; fail → pass with no edit is not a recovery arc; exit `-1` is not a failing test; an unknown clamp id is `info`); coverage lists `guardrail_clamp` inactive with `missing: ["jev_decisions"]` on a fixture fold; `[...findings].sort(compareFindings)[0].ruleId` is `claim_contradicted` on oauth and api-break.
- **B-8** Tests: all five fixtures fold with zero `invalid_row` gaps; `claim_contradicted` fires on oauth (claim "OAuth implementation complete; all checks pass.") and api-break (claim "The endpoint change is complete and all tests pass."), each citing the failed run's `test_result` seq; dropping oauth's `test_result` adds `missing_evidence`.
- **B-9** Tests: fast-check over random batch splits of each fixture's rows: `foldRows` equals `accumulateAll` per batch then `finalize`; redelivering any prefix changes nothing. Bench: a synthetic 75k-row session, printed as `fold 75k rows` and `append 1 row` in `pnpm --filter @jevcode/trace-viewer bench` output.
- **B-10** Tests: `searchSteps(index, "pnpm test")` returns oauth's test step; every id in a folded session resolves through `resolveStableId`; `describeGraphic` returns the three strings pinned in section 2.6 ("Mini graphics (B-10)"); `pickGraphic` of oauth's `pnpm test` step is `{ kind: "tests", passed: 14, failed: 1, skipped: 0 }`, and of oauth's `oauth-linking-test-failure` chapter the same counts (tests chapter); a command step gives the `duration` shape with `end`; the oauth `src/auth/identity.ts` diff graphic takes its counts from the fixture row, never a literal (A1-9 reconciles fixture counts).
- **B-3, B-5, B-7 and R25.** B-3's clock test also asserts `startMs`; B-5's "links observed through row factIds" also asserts `current: true`, `noise: false`, `validationStepIds: []`; B-7's first `claim_contradicted` test also asserts `anchorStepId`.
- **B-12** Tests (`ui-fields.test.ts`, 17 cases; 10 fail before B-12, the 7 that pass pin B-3/B-5/B-7 fields and two near misses): `startMs` is the source time for agent rows and origin plus the inherited clock for a replay-stamped decision row; plan before the first edit and last success claim per turn (oauth: the `Plan:` message and "OAuth implementation complete; all checks pass."); `matchSuccessClaim` spans ("all checks pass" on oauth, `[31, 46]`); `current: false` for a superseded unit, `noise: true` for a lockfile-only unit and for a unit whose latest Pass A row did not surface it; `validationStepIds`; the answer message joins the decision step (`answerSeq`, `target: "dec-1"`, same `step:<firstSeq>`) and a user message no answer follows stays an instruction; every finding's `anchorStepId` is one of its `stepIds`. B-12 also updates B-5's decision test and B-8's oauth decision assertion to expect the absorbed answer. Lane file 04 states the lane's final model test count; it changes with the section 2.6 additions above.
- **B-11** Replace WorkspaceHost's `shortPath`, `formatTime`, `eventSummary` and `statusLabel` (lines 97-139, 185-200) with imports from `@jevcode/trace-viewer/model` (`truncateMiddle(path, 48)`, `formatClock`, `agentEventLabel`, `agentStateLabel`); keep `eventKey`, `mergeEvents`, `readable` and `shortToolName`. Check: `pnpm --filter jevcode-desktop typecheck` and `pnpm --filter jevcode-desktop build`.

---

## 4. Waves, ownership and merge order

| Wave | Lanes | Base | Merge |
|---|---|---|---|
| W0 | W0 alone | `main` at `144c7fb` | W0 → `main` |
| W1 | A1, A2, B in parallel (the UI index adds C1a and C1b, which read W0's model types and never edit a W1 base-lane file) | `main` after the W0 merge | A1, then A2, then B (then C1a, C1b per the UI index) |
| W2+ | UI lanes M4a, M4b, M5 (`2026-09-28-trace-viewer-interfaces-ui.md`) | `main` after W1 | per their own index |

**Why W1 has no internal dependency.** A2 consumes only W0 names plus `factContentId` and `redactText`, whose signatures A1 does not change (A1-5 changes `factContentId`'s hash input; A1-7 widens `redactText`'s `env_value` rule). B consumes only W0 types and reads every A1 field as optional. `canonicalJson` lives in W0, so neither A2 nor B waits for A1.

**Files touched by more than one lane, and how they are sequenced.**

| File | Owners | Sequencing |
|---|---|---|
| `docs/SPEC.md` | W0-1, W0-4, W0-5 (§2.2, §4.1–§4.5, §15, §18); A1-3, A1-6, A1-7, A1-10 (§3.1, §10, §7, §3.7, §8.5) | Different waves. In W1 only A1 edits SPEC.md; A2 and B document in `docs/perf.md`, `docs/demo.md` and the design spec. |
| `packages/storage/src/db.ts`, `db.test.ts` | W0-5 (`EVENT_TYPES`), A1-1 (`openDb`) | Different waves. A2 adds `trace-reader.ts` and edits only `storage/src/index.ts`, which A1 never touches. |
| `packages/semantic-core/src/clustering.ts` | W0-2 (import line), A1-8 | Different waves. |
| `apps/desktop/src/renderer/components/WorkspaceHost.tsx` | W0-4 (two cases), B-11 | Different waves; no other W1 lane edits it. |
| `eslint.config.mjs`, `pnpm-lock.yaml`, every `package.json` | W0 only | No W1 task may edit them. A W1 task that needs a dependency stops and escalates. |
| `packages/trace-viewer/src/model/index.ts` | W0-6, then B tasks | Different waves; inside B, tasks run in order and each appends one line. |
| `packages/trace-viewer/src/model/types.ts` | W0-6 (with the R25 fields), then B-4 (`resultSeq`) | Different waves. The UI lanes C1a and C1b read it in W1 but never edit it. |
| `docs/spikes/codex-spike.md` | A1-2 (§3), A1-3 (§3 exit row, §4) | One lane, in order. |
| `packages/semantic-core/src/fixtures.test.ts` | A1-5, A1-9 | One lane, in order. |
| `apps/desktop/src/main/session-service.ts`, `session-guard.test.ts` | A1-3 only | A2 never edits them; A1 never edits `ipc.ts`. |
| `docs/security.md`, `docs/demo.md`, `docs/perf.md`, `scripts/soak.mjs` | A2 only (A2-6, A2-7) | A1 and B never edit them. |
| `fixtures/*/events.jsonl` | A1-9 only | A2 and B read fixtures in tests; see "fixture drift". |
| `apps/desktop/src/main/pipeline/*` | A1 only | A2 imports `redactText` from `redactor.ts` without editing it. |
| `apps/desktop/src/main/{ipc.ts, index.ts}`, `src/shared/*` | A2 only in W1 | M5 edits them later. |

**Fixture drift.** A1-9 adds lines and fields to `fixtures/*/events.jsonl` and reconciles 20 of 25 `git_hunk` `added`/`removed` counts with the real diffs while A2 and B run on the W0 fixtures. A2 and B tests select rows by content (type, command text, message text, fact fields), never by line number or seq literal, never assert a fixture `git_hunk` count as a literal (read it from the row, as B-10's identity.ts graphic test does), and never assert `provenance: "inferred"` on a fixture row that might gain a `callId` (assert `observed` exactly when the row has a `callId`). After the A1 merge, A2 and B rebase and rerun their suites; a failure there is a bug in the lane's test, not a reason to edit fixtures.

**Merge procedure per W1 lane.** On the lane branch, run `git rebase main` (or `git merge main`), resolve conflicts, rebuild (`pnpm install --frozen-lockfile && pnpm -r build`), then run section 5's root checks. Merge to `main` only when they are green. Never `git stash`; commit WIP instead.

**Worktree creation** (from `/Users/jwpark/Projects/jevcode`, after W0 merges; `<w0>` is the W0 merge commit):

```bash
git worktree add -b tv/a1-capture /Users/jwpark/Projects/jevcode-tv-a1 <w0>
git worktree add -b tv/a2-read-path /Users/jwpark/Projects/jevcode-tv-a2 <w0>
git worktree add -b tv/b-trace-model /Users/jwpark/Projects/jevcode-tv-b <w0>
```

W0 itself: `git worktree add -b tv/w0-contracts-foundation /Users/jwpark/Projects/jevcode-tv-w0 main`.

---

## 5. Gotchas every lane file copies into its steps

1. **Fresh worktree setup.** Run `pnpm install --frozen-lockfile` (W0-1 alone runs plain `pnpm install`), then the node-pty helper fix, then `pnpm -r build`. In a fresh worktree node-pty has no `build/Release`, so `pnpm --filter jevcode-desktop rebuild:node` fails at its node-pty copy and agent-codex PTY tests fail with `posix_spawnp failed`. Lanes 01 and 04 use this recipe: `NP=$(ls -d node_modules/.pnpm/node-pty@*/node_modules/node-pty | head -1) && mkdir -p "$NP/build/Release" && pnpm --filter jevcode-desktop rebuild:node && cp "$NP/prebuilds/$(node -p 'process.platform + "-" + process.arch')/spawn-helper" "$NP/build/Release/spawn-helper" && chmod +x "$NP/build/Release/spawn-helper"`. Lane 02 runs `pnpm --filter @jevcode/agent-codex run postinstall` (it makes the prebuilt `spawn-helper` executable) and continues past the node-pty copy error. Both work. `dist/` is gitignored and every workspace package exports only `./dist` (no vitest aliases anywhere; all `vitest.config.ts` files are plain `include` lists), so tests of a dependent package run against the last build.
2. **Rebuild after editing a dependency.** After changing `packages/contracts`, run `pnpm --filter @jevcode/contracts build` before running any other package's tests or typecheck. Same rule for `@jevcode/semantic-core` (A1-5, A1-8, A1-11 before desktop tests), `@jevcode/evidence-engine` (A1-4, A1-6), `@jevcode/agent-core`/`@jevcode/agent-codex` (A1-2, A1-3), `@jevcode/storage` (A2-1 before desktop tests), and `@jevcode/trace-viewer` (before `pnpm --filter jevcode-trace-viewer-dev build` and before B-11). To rebuild a package and everything that depends on it: `pnpm --filter "...@jevcode/contracts" build`. Desktop tests can otherwise pass or fail against stale `dist` (apps/desktop/package.json `"test": "vitest run"` has no pretest build).
3. **better-sqlite3 ABI.** Storage and desktop tests load better-sqlite3 under Node. If a test fails with `NODE_MODULE_VERSION` or `was compiled against a different Node.js version`, run `pnpm --filter jevcode-desktop rebuild:node` (expected last line: `native modules restored to node ABI`). `pnpm --filter jevcode-desktop run rebuild` switches to the Electron ABI for `start`; switch back before testing.
4. **Root checks** (run at the end of every task, in this order): `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r test`, `pnpm lint`. Each must exit 0. Three pre-existing suites flake under load (evidence-engine `collectors/file-watcher.test.ts`, agent-codex `stall-watchdog.test.ts` and `codex-adapter.test.ts`), so lane 01 runs `pnpm -r --no-bail --workspace-concurrency=1 test` and lane 04 runs `pnpm -r --workspace-concurrency=1 test`; both are the same check run one package at a time. A failure only in those three suites is confirmed by rerunning that package alone (`pnpm --filter @jevcode/agent-codex test`); any other failure is real.
5. **Targeted test commands** have the form `pnpm --filter <package> exec vitest run <path relative to the package>`, e.g. `pnpm --filter @jevcode/contracts exec vitest run src/trace.test.ts` (verified working on `src/id.test.ts`). Package names: `@jevcode/contracts`, `@jevcode/agent-core`, `@jevcode/agent-codex`, `@jevcode/evidence-engine`, `@jevcode/semantic-core`, `@jevcode/storage`, `@jevcode/jev-router`, `@jevcode/telemetry`, `@jevcode/ui-catalog`, `@jevcode/ui-compiler`, `@jevcode/trace-viewer`, `jevcode-desktop`, `jevcode-trace-viewer-dev`, `jevcode-evals`.
6. **Replay and soak** need built output: `pnpm build` first; `pnpm --filter jevcode-desktop replay <fixtureDir> <outDir>`; `node scripts/validate-fixtures.mjs`; `JEVCODE_SOAK_EVENTS=2000 node scripts/soak.mjs` for a quick soak.
7. **Optional fields only.** Never make a new field required and never add `.strict()`; rebuild.test.ts must keep replaying rows written before the change.
8. **Commits.** One conventional commit per task, listing the task's files explicitly in `git add`. No `Claude-Session:` trailer. No `git stash`. zsh: `${var}:suffix`.

---

## 6. Reconciliation with the UI index (`2026-09-28-trace-viewer-interfaces-ui.md` §1)

The UI index lists amendments to W0, A2 and B that "a later amend step pastes" into this index and lanes 01, 03 and 04. This index now carries every one of them (amend step of 2026-09-28). Lane 01 carries the W0 items; lanes 03 and 04 copy the A2 and B items from sections 2.5, 2.6 and 3 above.

| UI index item | Where it lives now | Notes |
|---|---|---|
| §1.1(a) drop `@xyflow/react` from `packages/trace-viewer` | Section 2.2; lane 01 deviation 5 | — |
| §1.1(a) `d3-zoom` 3.0.0, `d3-selection` 3.0.0, `@types/d3-zoom` 3.0.8, `@types/d3-selection` 3.0.12, `./sources` export | Section 2.2 manifest and `package.json`; lane 01 W0-1 steps 1 and 5 | All four were already locked through `@xyflow/react`. The lockfile diff is `134	0` (was `122	0`), measured on a replay; the single-version grep output is unchanged; still three new tarballs |
| §1.1(a) virtual-core `anchorTo`/`followOnAppend`/`scrollEndThreshold` check (R17) | Section 2.2; lane 01 W0-1 step 5 | Prints `3` on virtual-core 3.17.11 |
| §1.1(b) `packages/ui-catalog/package.json` `./components/*` export | Sections 1 and 2.2; lane 01 W0-1 step 4 | W0-1 step 10 resolves `@jevcode/ui-catalog/components/CodeDiff` |
| §1.1(c) `assetsInlineLimit: 0` | Section 2.2 `vite.config.ts`; lane 01 W0-1 step 3 | — |
| §1.1(d) `LAYOUT_PURE_GLOBALS`, the `src/layout/**` block, the model→layout ban, 7 new `lint-boundaries.test.ts` rows | Section 2.2 "ESLint boundaries"; lane 01 W0-1 steps 6–9 | `lint-boundaries.test.ts` has 16 cases after W0-1 (`12 failed \| 4 passed (16)` before the config) and 18 after W0-2 |
| §1.2(a) `DecisionDetail.answerSeq`, `Step.startMs`, `Turn.claimStepId`/`planStepId`, `Chapter.noise`/`current`/`validationStepIds`, `Finding.anchorStepId`/`claimStepId`/`evidenceStepIds`/`claimSpan` | Section 2.3 `types.ts` (declared once) | `startMs` sits after `tMs`, not after `endTs`. Do not insert these again: a duplicate property fails `tsc` |
| §1.2(a) `LEVELS`/`Level`, `CommandDetail.outputTail`, `triad.clientKind`, `TraceSession.originMs`, the `diff`/`duration`/`table`/`claim` `GraphicSpec` shapes | Section 2.3 `types.ts`; lane 01 W0-6 | `types.test.ts` gains the `LEVELS` case (11 cases). Lane B derives the fields (section 2.6, "Where lane B derives …") |
| §1.2(b) session-bound `TraceSource` (`sessionId`, `summary()`, `rows(request?)`, `payloads(seqs)`, `now()`) | Section 2.3 `source.ts`; lane 01 W0-6 | `TraceListSessionsRequest` and `TracePayloadsRequest` are gone; `source.test.ts` keeps 4 cases. `@jevcode/trace-viewer` ends W0 with 33 tests |
| §1.3 `trace:listSessions {sessionId?}` | Section 2.5 (A2-1 to A2-4) and section 3 (A2-1, A2-3 tests) | A2-4's `trace` namespace is no longer "structurally a `TraceSource`"; M5 adapts it with `createIpcTraceSource(bridge.trace, sessionId)` |
| §1.4 B-1 `exitLabel`, `displayUntrusted` | Section 2.6 `format.ts` and pinned behavior; section 3 B-1 | `normalizeCommand` was already a B-1 export |
| §1.4 B-2 literal lane table | Section 2.6 `registry.ts` comment; section 3 B-2 | `read` is in the `edits` lane |
| §1.4 B-3 `originMs`, `outputTail`, `FinalizeOptions.nowMs` | Section 2.6 `FinalizeOptions` and the R25 derivation table; section 3 B-3 | `startMs` was already derived by B-3 |
| §1.4 B-5 decision `target`, answer absorption, `noise`, `current`, `validationStepIds`, `triad.clientKind` | Section 2.6 derivation table; section 3 B-5 and B-12 | Everything but `triad.clientKind` was already derived (B-5, B-12) |
| §1.4 B-6 `matchSuccessClaim`, `Turn.claimStepId`/`planStepId` | Section 2.6, B-12 in `signals.ts` (not `classify.ts`) | Do not add a second `matchSuccessClaim` in `classify.ts`: both files are re-exported by the model barrel, so a duplicate name fails with TS2308 |
| §1.4 B-7 `FindingDraft` fields, `FINDING_RULE_RANK`, `compareFindings` | Section 2.6 `signals.ts`; section 3 B-7 | The `FindingDraft` fields were already declared (B-7, B-12) |
| §1.4 B-10 `pickGraphic`/`describeGraphic` in `format.ts`, `CHAPTER_GRAPHIC` | Section 2.6 "Mini graphics (B-10)"; section 3 B-10 | Tests stay in `graphics.test.ts` (this index's B-10 file list, not the UI index's `format.test.ts`); a tests chapter yields `kind: "tests"` with its latest run's counts |

---

## 7. Review Focus placement (checked 2026-09-28)

Every Review Focus test named in this index and in the four lane files exists inside the task that owns the code:

| Review Focus | Test | Task (lane file) |
|---|---|---|
| Index 1, lane 04 RF1 | "legacy session joins by time window"; `legacy` variant in `fold.fixtures.test.ts` | B-5, B-8 (04) |
| Index 2, lane 03 RF1 | "pages stay gapless while the writer appends" | A2-1 (03) |
| Index 3, lane 03 RF2 | "clips a 1 MiB stdout to head and tail", "never splits a surrogate pair at either cut" | A2-2 (03) |
| Index 4, lane 02 RF1, lane 04 RF2 | "SIGINT during a command yields one agent_interrupted"; "interrupted turn leaves the open command unknown", "maps exit codes: 0 ok, positive failed, -1 unknown"; "does not treat an unknown exit code as a failing test" | A1-3 (02); B-3, B-7 (04) |
| Index 5, lane 02 RF3, lane 03 RF4 | "redacts tokens and maps home", "maps home only at a path boundary and does not recount redacted markers"; "redacts a prefixed env line inside a diff and keeps the prefix", "withholds a secret path and stores no text" | A2-5 (03); A1-7 (02) |
| Lane 01 RF1–RF5 | W0-4 "keeps … through a parse" (six tests); W0-2 "imports no Node built-in at runtime" and W0-1 `Buffer.byteLength` lint case; W0-3 "gives a collector-ordered fact and its zod-parsed copy one string (R3)"; W0-6 "round-trips a path with a line break", "round-trips any non-empty key"; W0-6 "drives a reader that sees every served seq exactly once, then only new rows" | W0-1 to W0-6 (01) |
| Lane 02 RF2, RF4, RF5 | "stopping a running session records one agent_interrupted and leaves it paused and resumable", "pauses a running session on stop and leaves it resumable"; "emits again for a file that left git status and came back unchanged", "emits a file only when its diff changes"; "tightens an existing ~/.jevcode and its 0644 database files on open", "never changes the mode of an existing directory it does not own by default" | A1-3, A1-6, A1-1 (02) |
| Lane 03 RF3, RF5 | "turns a damaged payload row into a row without payload and keeps its neighbors"; "returns 1 with usage and writes nothing when a flag is missing or malformed", "returns 1 and writes nothing for an unknown session or a missing database" | A2-2, A2-6 (03) |
| Lane 04 RF3–RF5 | "starts the clock at the first agent row and keeps it monotonic when timestamps go backwards", "keeps pipeline rows on the inherited clock"; "never changes a returned session when more rows arrive", `fold.parity.test.ts`; "success claim lexicon", "does not fire on a negated claim or after a later passing run" | B-3, B-5, B-9, B-7 (04) |

---

## 8. Coverage matrix

Decision ids are from the binding decision record (`scratchpad/decisions.md`, mirrored in the design spec). Scope: W0, M0, M1 (a, b, c), M2, M3. UI-only decisions point to the UI index.

| Decision | Tasks |
|---|---|
| D1 supervisor is the primary reader | B-3 (turns, steps), B-5 (chapters, decisions), B-6 (problems, noise collapse), B-7 (claim vs evidence, risky commands), B-12 (turn plan and claim); UI in M4 |
| D2 jevcode sessions only; `TraceRow` source-agnostic | W0-5 (`TraceRowSchema` with `type: string`), A2-1 (SQLite and `replay.db` reader), A2-5 (`trace.json` from `runReplay`), A2-6 (`replay export`), B-2 (`rowsFromPipelineRecords`, fixture harness) |
| D3 post-hoc first, same model follows live | W0-5 (`TRACE_LIVE_POLL_MS`, paging contract), W0-6 (`cursorAfter`, session-bound `TraceSource` with `now()`), A2-1 (gapless paging while the writer appends; exact-id `listSessions` for the trace window's summary), B-3 and B-6 (`finalize({live})` semantics), B-9 (batch-split parity); live UI in M5 |
| D4 one package, two hosts; Vite dev host | W0-1 (`@jevcode/trace-viewer`, `apps/trace-viewer-dev`), W0-2 and W0-6 (dev-host build proves browser safety) |
| D5 fix provenance at the source | W0-4 (schemas), A1-2, A1-3, A1-4, A1-5, A1-8 |
| D6 persist redacted, size-capped diffs | W0-4 (`GitHunkDiffSchema`), A1-6 (`PrepareDiff`, change-only emission), A1-7 (secret paths, prefixed `env_value`, 32 KiB cap), A1-9 (fixture diffs) |
| D7 Canvas and Hybrid with a switch | UI index (C2, C3a, C3b); no W0–M3 task |
| D8 visual system | UI index (C1a); no W0–M3 task |
| D9 separate window; R8 sign-off removes "replay UI" from SPEC §18; viewer never writes | W0-1 (SPEC §18 edit), A1-3 (re-check), A2-3 (handlers never write: pending instructions and event counts unchanged); window in M5 (UI index Da, Db) |
| D10 interrupt/steer/stop pause, `agent_interrupted` replaces exit-time `agent_failed`; codex-adapter.test.ts:190-203 | W0-4 (`agent_interrupted` variant), A1-3 (adapter, runtime, `session-service.ts`, the 190-203 assertion, `delivery-queue.test.ts`), B-3 (turn `interrupted`, open command `unknown`), B-6 (`agent_failed` problem only from `agent_failed`) |
| D11 approximate joins for pre-M1 sessions, header notice, no legacy resolver | B-2 (`stripCaptureFields`), B-5 (time-window join, "legacy session joins by time window"), B-7 (`coverage.approximateJoins`), B-8 (`legacy` variant of every fixture) |
| D12 every recommendation accepted | This matrix |
| R1 store dir 0700, files 0600, POSIX test, separate PR before M1b | A1-1 (branch `tv/a1-m0-db-modes`) |
| R2 `turnId`, `callId`, `agent_reasoning`, `agent_interrupted`, `sourceCallId`, persisted resume-budget failure, exit −1 unknown, optional fields | W0-4, A1-2, A1-3, A1-4, B-3 (exit −1 → `unknown`), B-7 (exit −1 is not a failing test) |
| R3 canonical fact ids, `agentCallIds` + `unitSignature`, `git_hunk.diff` via `prepareDiff`, desktop diff policy, change-only emission, double-push removal, no-strip guard, fixture fixes (`callId`, `sourceCallId`, diff, `agent_reasoning`, oauth failure text "expected null to be 7"), validator `+`/`-` counts | W0-3 (`canonicalJson`), W0-4 (schemas), A1-5 (fact ids, no-strip guards), A1-6, A1-7, A1-8, A1-9 (fixtures, golden spec, README, `validate-fixtures.mjs`, `fixture-diffs.mjs`) |
| R4 `Decision.ts`, `JevDecisionLog.pass`, real suppression `clientKind`/confidence, graph domain ids, SPEC §4.1–4.3/§7/§8.5 and codex-spike §3 | W0-4 (schemas, SPEC §4.1–§4.3), A1-10 (writers, SPEC §8.5), A1-11 (graph ids), A1-6 (SPEC §7), A1-2 and A1-3 (codex-spike §3, §4) |
| R5 `trace.ts`, `EVENT_TYPES` move, `query_only` reader, `trace-service` (`factId`, 16 KiB clip), three bounded `trace:*` channels, live poll, no migration, `trace.json` export, soak read ≤ 1.5 s | W0-5 (`trace.ts`, `EVENT_TYPES`, SPEC §4.5 and §15), A2-1, A2-2, A2-3, A2-4, A2-5, A2-6, A2-7 |
| R6 `newId` via `globalThis.crypto`; `symbolId` → `@jevcode/contracts/node` | W0-2 |
| R7 one package, React-free `src/model` with ESLint bans, `@jevcode/trace-viewer/model`, model hashes nothing | W0-1 (package, exports, ESLint blocks, `lint-boundaries.test.ts`), W0-6 (types), B-2 (fact ids injected by the test harness only) |
| R8 fold API, seq and gap rules, hidden counts, sorted output, budgets | W0-6 (`TraceSession` shape), B-3 (fold API, gaps, hidden), B-9 (parity property, 75k-row and one-row budgets) |
| R9 stable ids | W0-6 (helpers, `StableIdSchema`), B-3, B-5, B-7 (assignment), B-10 (`resolveStableId`) |
| R10 derivations | B-3 (pairing, turns), B-4 (evidence attach, claim vs observed edits), B-5 (chapters, D11 join), B-6 (problems, noise), B-7 (claim vs evidence), B-12 (`Turn.claimStepId` drives the claim check) |
| R11 five v1 signals with metadata and coverage | B-7 (rules, `SIGNALS`, `computeCoverage`), B-12 (claim fields) |
| R12 labels move to `format.ts`; `eventKey`/`mergeEvents` stay | B-1, B-11 |
| R13–R16, R18, R21–R24, R28, R29 | UI index (C1a, C1b, C2, C3a, C3b, Da, Db); no W0–M3 task |
| R20 store and view-switch contract; shared `level` | W0-6 (`LEVELS`/`Level`); the store in the UI index (C1b) |
| R17 hand-rolled viewport, no `@xyflow/react`, `@tanstack/react-virtual` | W0-1 (no `@xyflow/react`; `@tanstack/react-virtual` 3.14.13 resolving virtual-core 3.17.11 with the `anchorTo`/`followOnAppend`/`scrollEndThreshold` check; `d3-zoom` 3.0.0 and `d3-selection` 3.0.0 as the fallback dependency; `assetsInlineLimit: 0`); the viewport itself in the UI index |
| R19 module structure; layout imports model, never the reverse | W0-1 (`src/model` never imports `src/ui` or `src/layout`; the `src/layout/**` purity block with `LAYOUT_PURE_GLOBALS`; the `./sources` export; `lint-boundaries.test.ts` rows); directories in the UI lanes |
| R25 UI-required model fields (and UI index §1.2, §1.4) | W0-6 (declarations, including `LEVELS`, `outputTail`, `triad.clientKind`, `originMs`, the `GraphicSpec` shapes), B-1 (`exitLabel`, `displayUntrusted`), B-2 (`KIND_META[kind].lane`, literal table), B-3 (`tMs`, `startMs`, `originMs`, `outputTail`, `FinalizeOptions.nowMs`), B-5 (`evidenceLinks`, `current`, `noise`, `validationStepIds`, `triad.clientKind`), B-7 (`anchorStepId`, `FINDING_RULE_RANK`, `compareFindings`), B-10 (`pickGraphic`/`describeGraphic` in `format.ts`, `CHAPTER_GRAPHIC`), B-12 (`planStepId`, `claimStepId`, claim fields, decision `target`, answer absorption) |
| R26 budgets | B-9 (fold 75k ≤ 500 ms, append ≤ 2 ms), A2-7 (full soak read in main ≤ 1.5 s); the rest in the UI index |
| R27 test tooling | W0-1 (`jsdom` 30.1.0, `@testing-library/react` ^16.3.3, `@testing-library/user-event` 14.6.7, `fast-check` 4.10.1), W0-3 and W0-6 (fast-check properties), B-9 (fold parity property); component, paint and smoke tests in the UI index |
| Note: five v1 signals | B-7 (`SIGNAL_IDS` has five entries, W0-6) |
| Out of v1 | No task adds an importer, dark mode, SQL migration, derived column, join table or legacy-id resolver (A2-1 keeps `LATEST_SCHEMA_VERSION`; B-5 joins by time window) |
| Separate PRs | Not planned here; A1 "Known risks" adds the `token` rule over-redaction in stored diffs to that list |
