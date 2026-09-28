# Trace Viewer Lane B: Trace Model (M3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the React-free trace model in `packages/trace-viewer/src/model`: a pure fold from `TraceRow`s to a supervisor-shaped `TraceSession` (turns, paired steps, evidence, edits, chapters, problems, noise, five v1 signals, coverage), its label helpers, search, stable-id lookup and mini-graphic specs, plus the WorkspaceHost switch to the shared labels.

**Architecture:** `accumulate` folds one row at a time into a private mutable `FoldState` (`fold-state.ts`); `fold-agent.ts`, `fold-evidence.ts` and `fold-chapters.ts` each own one family of rows. `finalize` never mutates that state: it deep-copies the step drafts into public `Step`s, then derives entities, chapters, problems, `missing_evidence` gaps, noise and findings (`classify.ts`, `signals.ts`) and sorts every list by seq. The model hashes nothing and reads only `@jevcode/contracts`; tests drive it with hand-built rows (`test-support/trace-builder.ts`) and with the five fixtures run through the real `PipelineCoordinator` (`test-support/fixture-rows.ts`), each fold checked as stored, as a pre-M1 session and with M1 capture fields.

**Tech Stack:** TypeScript 5.9 (NodeNext, strict, `noUncheckedIndexedAccess`, `noUnusedLocals`, `verbatimModuleSyntax`), zod 3.25.76 (via `@jevcode/contracts`), vitest 3.2.7 (`vitest bench` for budgets), fast-check 4.10.1, `Intl.Segmenter` (Node 22 and Chromium), pnpm 9.15 workspaces.

**Spec:** `docs/superpowers/specs/2026-09-28-trace-viewer-design.md` §6 "Trace model (M3)" (decision record: D1, D2, D10, D11, R2, R7–R12), plus the lane index `docs/superpowers/plans/2026-09-28-trace-viewer-interfaces.md` (§2.3 model types, §2.6 model API, §3 lane B task table, §4 fixture drift, §5 gotchas). On any conflict the decision record wins, then the spec, then the index, then this file. Where the spec's §6 text and the index disagree on a name or type, this lane follows the index and the W0-6 `types.ts` it consumes; each such point is listed under "Spec alignment notes".

## Interface deviations

Every name and type in index §2.6 is kept. These additions and changes were needed; each was checked by replaying all ten model tasks on a W0-state package (every task typechecks and its tests pass, and the end state is the code in this file):

1. **New internal module `src/model/fold-state.ts` (B-3; B-4 and B-5 add their state to it).** `fold.ts` imports the fold-* modules at runtime; if their shared types and helpers (`FoldState`, `StepDraft`, `TurnDraft`, `createStep`, the clock) lived in `fold.ts`, every fold-* module would import `fold.ts` back, a runtime import cycle. `fold-state.ts` imports none of them. It is not exported from the barrel.
2. **Two new test-only files:** `src/test-support/trace-builder.ts` (B-3; row builder shared by every unit test file) and `src/test-support/synthetic-rows.ts` (B-9; the 75k-row generator shared by `fold.bench.ts` and `fold.parity.test.ts`). Both sit under `src/test-support/**`, which W0 excludes from the build and from the model import bans.
3. **`TestDetail.resultSeq?: number`** (B-4 edits W0's `src/model/types.ts`; additive, optional). `claim_contradicted` must cite the failed run's `test_result` seq, and `failing_tests`/`recovery_arc` anchor on it. A step's `evidenceSeqs` can also hold `command_executed` and validation seqs, so the public `Step` could not tell which seq is the test result.
4. **`normalizeCommand` lives in `format.ts` (B-1), not `registry.ts`, and unwraps one `bash -lc '…'`/`zsh -lc '…'` wrapper** (spec §6.8). Command headlines show the unwrapped command. `registry.ts` adds `CHECK_COMMAND`, `TEST_COMMAND`, `commandKind`, `isLockfilePath`, `READ_TOOL` and `severityRank`; `format.ts` adds `toolLabel`; `signals.ts` adds `isSuccessClaim`, `computeCoverage` and `applySignals`. All are additive exports.
5. **B-11 also deletes `readable` and `shortToolName` from WorkspaceHost.** The index says to keep them, but their only caller is `eventSummary`, which B-11 removes; `noUnusedLocals` would then fail `tsc -p tsconfig.web.json`. They move into `format.ts` as `readable` (private) and `toolLabel`.
6. **`agentEventLabel` never calls exit −1 a failure** (R2). The index keeps `eventSummary`'s strings except three; two more change: `command_completed` with exit < 0 reads "`<cmd>` finished (exit code unknown)", and `test_completed` with exit < 0 reads "`<cmd>` finished" (WorkspaceHost said "failed").
7. **The legacy-join test (Review Focus 1) asserts on chapters that cite fact ids.** Index §3 B-5 says "every chapter's `link` is `inferred`". A failure-only unit (api-break's stale-test unit cites only `fail_…`/`val_…` ids) has no content-hash join to lose, so it stays `observed`. `coverage.approximateJoins` is still `true` for every legacy fixture fold.
8. **Clock and turn rules from spec §6.5/§6.6** (behavior only, no type change): only `agent_event` and `evidence_fact` times move the display clock and the first of them is the origin (`meta.startedAt` is only the fallback); `change_unit`, `decision`, `validation` and `jev_decision` rows inherit the clock and get `startTs = origin + t`. A turn closed by the next `agent_started` without a terminal event is `waiting` when a decision was answered in it (and the next turn is `resume`), else `interrupted` (next turn `steer`). Single-row steps have `durationMs: null`.
9. **`pickGraphic` and `describeGraphic` live in `format.ts` (B-10), not `graphics.ts`.** Decision record R25 names `model/format.ts`. The tests stay in `graphics.test.ts`. There is no `src/model/graphics.ts`.
10. **R25 UI-required fields** (consistency review, 2026-09-28). R25 puts them in "W0 model types and lane B", and the UI lanes C1a and C1b run in W1 beside this lane on W0's types. W0-6 therefore declares `Step.startMs`, `Turn.planStepId?`, `Turn.claimStepId?`, `Chapter.current`, `Chapter.noise`, `Chapter.validationStepIds`, `Finding.anchorStepId`, `Finding.claimStepId?`, `Finding.evidenceStepIds?`, `Finding.claimSpan?` and `DecisionDetail.answerSeq?`, and this lane fills each required field in the task that builds the object: `startMs` in B-3 (`sourceMs`, `createStep`, `toPublicStep`), `current`, `noise` (joined edits all lockfile or formatting-only, or the latest Pass A row did not surface the unit; `ChapterState.surfaceByUnit`) and `validationStepIds` in B-5, and `anchorStepId` in B-7 (every rule; `applySignals` clears `noise` on a chapter a finding names). Task B-12 derives the optional rest: `Turn.planStepId`/`claimStepId` (`markTurns`), the `claim_contradicted` fields (`matchSuccessClaim`), decision `target` and the absorbed decision answer. B-10 also takes the oauth `identity.ts` diff counts from the fixture row instead of a literal, because A1-9 reconciles fixture counts. Verified by replaying B-1 to B-12 from this file on the W0-6 types: every task typechecks and passes its tests, and ESLint reports nothing. With the amendments in items 11 and 12 the lane ends at 275 model tests.
11. **UI index amendments** (`docs/superpowers/plans/2026-09-28-trace-viewer-interfaces-ui.md` §1.4, 2026-09-28). The W0-6 amendment in UI index §1.2 declares `CommandDetail.outputTail?`, `TraceSession.originMs`, `Chapter.triad.clientKind?` and the reshaped `GraphicSpec` members `diff` (`files?`, `moreFiles?`), `duration` (`durationMs`, `running`, `status`, `end`), `claim` (`claim {text, span?, tMs}`, `observed {…, tMs}`) and `table` (`tables {name, role: "new" | "altered", columns: number}[]`, no `fks`). This lane fills them: B-1 adds `exitLabel` and `displayUntrusted`, and `truncateMiddle` and `stepHeadline` show bidi and control characters as `⟨U+XXXX⟩` tokens; B-2 pins the kind → lane table (`read` moves to `edits`); B-3 adds `TraceSession.originMs`, `CommandDetail.outputTail` and `FinalizeOptions.nowMs` (an open step at the live edge lasts `nowMs − startMs`); B-5 adds `triad.clientKind` and takes the triad from the unit's latest Pass A attention row (`ChapterState.attentionByUnit`); B-7 adds `FINDING_RULE_RANK` and `compareFindings` (spec §6.7 `FINDING_ORDER`); B-10's `pickGraphic` follows spec §7.12 `CHAPTER_GRAPHIC` (schema → table, architecture and api → flow, tests → the latest run's counts, answered decision → fork, else a diff list of the top 4 files) and emits the reshaped members. Decision `target`, the absorbed decision answer, `Chapter.noise`/`current`/`validationStepIds`, the `FindingDraft` claim fields and `matchSuccessClaim` were already built (B-5, B-7, B-12) and are unchanged.
12. **Spec §16 "Plan follow-ups"** (2026-09-28). The four rows of that table that name this lane are resolved here; B-1 to B-12 were replayed from this file on the W0-6 state after the change (every task typechecks, passes its tests and lints clean):
    - **B-2 anchored check pattern.** `CHECK_COMMAND` matches only at the head of `normalizeCommand(command)` (spec §6.6): `tsc`, `eslint` or `vite build`, bare or through `npx` or pnpm/npm/yarn (optionally with `run` or `exec`), or a pnpm/npm/yarn `typecheck`, `lint` or `build` script after `-r`, `-w`, `--filter x`, `--filter=x`, `-F x` or `--workspace x`. `commandKind` normalizes before it matches, and B-4's `testKind` calls `commandKind`. `ls build`, `grep -r build src`, `pnpm add eslint` and `git commit -m 'fix lint'` are plain commands, so their non-zero exits no longer read as failed checks that paint red and contradict a claim.
    - **B-6 and B-7 info-only clamp rows.** A guardrail step whose clamps are all info (unknown ids included) carries no `guardrail` problem, raises no `guardrail_clamp` finding and is `lifecycle` noise (spec §6.6, §6.7). Routine `suppress_formatting` and `suppress_lockfile` rows therefore add no `n`/`N` stop and pin no step open. A warning or critical clamp still raises one finding at the most severe clamp.
    - **B-7 claim rule.** `claim_contradicted` keeps the per-command comparison; see "Spec alignment notes", "Claim rule".
    - **B-12 instruction dedupe** (spec §6.6). It lives in B-12, not B-3 or a new B-13, because its decision rule reuses B-12's answer absorption; B-12 also adds the two B-8 mutations spec §11 names ("a steer yields one instruction step", "a decision answered with an instruction yields no instruction step").

## Spec alignment notes

Points where the design spec's §6 text differs from what this lane builds. The spec owner should reconcile them; none blocks this lane.

- **`finalize` options.** Spec §6.4 shows `finalize(state, {live, nowMs?, page})` and a `TraceMeta` input. The index and W0 fix `FinalizeOptions {live; state?; throughSeq?}` and `TraceSessionSummary`; this lane implements those plus `nowMs?` (UI index §1.4 B-3). `originMs` is a `TraceSession` field, not a `meta` field.
- **Types named in spec §6.2.** W0-6 declares, and B-3, B-5, B-7 and B-12 derive, the ones decision record R25 and UI index §1.2 require: `Turn.planStepId`/`claimStepId`, `Chapter.current`/`noise`/`validationStepIds`/`triad.clientKind`, `Step.startMs`, `CommandDetail.outputTail`, `TraceSession.originMs`, and `Finding.anchorStepId`/`claimStepId`/`evidenceStepIds`/`claimSpan`. The type is named `Lane` (W0-6), not `LaneId`. `coverage.approximateChapters` and `hidden.total` are not in the decision record and are not built. The UI reads `coverage.approximateJoins` and `hidden.unreceived` instead.
- **Decision-answer absorption** (spec §6.6, R25) is built in B-12: a user message whose next decision row answers or delegates an already-open decision joins that decision step (`DecisionDetail.answerSeq`), and its instruction step is removed. A user message that no answer follows stays an instruction step, and its headline reads the answer's `instruction:` line ("Continue with fail-open behavior.") instead of "decision:".
- **Instruction dedupe** (spec §6.6) is built in B-12. A user message whose trimmed text equals the prompt of the `agent_started` just before it (no other agent event between them) joins that instruction step, so a steer is one step whose `firstSeq` is the relaunch and whose `seqs` hold both rows. An `agent_started` whose trimmed prompt equals an earlier undelivered user message (a queued instruction) opens no instruction step: its seq joins that earlier step, which stays in the earlier turn's `stepIds`. A relaunch that delivers a decision answer loses its instruction step when the answer row lands: both of its seqs join the decision step, `answerSeq` names the echoed message, and `Turn.prompt` is the decision title; when the answer row comes first, the later relaunch's seq joins the decision step the same way. In every case a started turn's instruction item is the step whose `seqs` hold `turn.startSeq`.
- **Chapter noise and attention** (B-5): a chapter is noise when it joins at least one edit and every joined edit is a lockfile or formatting-only change, or when the unit's latest Pass A row has `shouldSurface: false` (`ChapterState.surfaceByUnit`). A row counts as Pass A unless `pass === "B"`. `triad` takes importance, relevance, interruption and `clientKind` from the latest non-Pass-B row whose `output` parses with `AttentionDecisionSchema`, else the unit's own scores without `clientKind`.
- **Edit split rule.** Spec: a repo observation after the turn's latest test or check opens a new edit step. This lane opens a new edit step when a `git_hunk` with new content arrives for a path whose latest edit step already holds a hunk. The git collector polls every 5 s, so under the spec rule a claim whose poll lands after a quick test would be left unobserved and raise a false `missing_evidence` (B-4 test "joins a git poll that lands after a test run to the claim it confirms").
- **Duplicate polls** become their own edit step with noise `duplicate_poll` (spec: "adds only its seq"), so the step that holds the real change keeps a truthful `lastSeq`, and `recovery_arc` ignores them.
- **Approximate window** (D11): edit steps on `unit.files` inside `[createdAt, updatedAt]` widened by 5 s (the git poll interval), and for a file with none there its latest earlier edit. The strict spec window joins nothing for decision units, whose `createdAt` is the decision time (oauth's linking unit).
- **Claim rule (adopted 2026-09-28).** A claim is contradicted when, for any test or check command, that command's latest run before the claim in the session failed (`latestByTarget` in B-7); the finding cites the most recent such failed run. This is the rule the lane adopts, by the orchestrator's ruling of 2026-09-28. Spec §6.6 and its §16 B-7 row still compare with the single latest test or check step and call the per-command rule the §15 variant; the per-command rule is kept because it catches "tests failed, then lint passed, then 'all checks pass'", which the single-run rule misses (B-7 test "compares with the latest run of every command"). The oauth and api-break expectations are the same under both rules. The spec owner should align §6.6 and drop the B-7 row from §16. The scope is the session, so a claim made in a resumed turn without rerunning the tests still contradicts the last evidence. Completion words ("complete", "done", "finished") count only at the end of a clause. An unverified claim raises no gap.
- **Info findings and noise.** Only the guardrail rule changes (spec §6.6, §6.7): a Jev row whose clamps are all info raises no finding and its step is `lifecycle` noise. `recovery_arc` is still an info finding that keeps the steps it names from collapsing, because spec §6.6 ("the close of a recovery arc carries a finding, so it is never noise") and W0-6's `Step.noise` contract ("Never set when problems or findingIds are non-empty") require it.
- **Labels pinned by the index.** `formatDuration` (`2 m 05 s`, `1 h 02 m`) and `agentStateLabel` (WorkspaceHost's strings) follow index §2.6, not spec §6.8's examples, because B-11 swaps them into the live desktop UI.
- **Chapter graphics** (B-10): a `CHAPTER_GRAPHIC` rule whose data is missing (a schema chapter without `schemaChanges`, an architecture or api chapter without edited files, a tests chapter without a joined test run) falls through to the next rule, so it ends at the fork or the diff list.
- **Not in lane B:** `toneOf` (UI lane, `layout/tone.ts`), the `src/layout/**` lint block (UI lane).

## Lane prerequisites

- **Wave:** W1. W0 (`tv/w0-contracts-foundation`) must be merged into `main`. A1 and A2 need not be merged: this lane reads every M1 field as optional and selects fixture rows by content. W1 merges in the order A1, A2, B, so this lane rebases last (see "Lane completion").
- **Verify W0 is on `main`** (from anywhere):

```bash
git -C /Users/jwpark/Projects/jevcode show main:packages/trace-viewer/src/model/index.ts
git -C /Users/jwpark/Projects/jevcode show main:packages/trace-viewer/src/model/types.ts | grep -c "export const TRACE_SCHEMA_VERSION = 1 as const;"
git -C /Users/jwpark/Projects/jevcode show main:packages/contracts/src/trace.ts | grep -c "export const TRACE_ROW_TYPES"
git -C /Users/jwpark/Projects/jevcode show main:packages/contracts/src/agent-events.ts | grep -c 'z.literal("agent_interrupted")'
git -C /Users/jwpark/Projects/jevcode show main:packages/trace-viewer/package.json | grep -cE '"@jevcode/semantic-core"|"fast-check"'
git -C /Users/jwpark/Projects/jevcode show main:apps/desktop/src/renderer/components/WorkspaceHost.tsx | grep -c 'case "agent_interrupted":'
git -C /Users/jwpark/Projects/jevcode show main:apps/desktop/package.json | grep -c '"@jevcode/trace-viewer"'
```

Expected: the first command prints exactly `export * from "./types.js";`; the next six print `1`, `1`, `1`, `2`, `1`, `1`.

- **Plan documents:** if `git -C /Users/jwpark/Projects/jevcode ls-files docs/superpowers` prints nothing, the plan and spec are untracked in the main checkout. Read them by absolute path and never commit them from this lane.
- **Tooling:** `node --version` prints `v22.x`; `pnpm --version` prints `9.15.0`.
- **Worktree** (once):

```bash
git -C /Users/jwpark/Projects/jevcode worktree add -b tv/b-trace-model /Users/jwpark/Projects/jevcode-tv-b main
```

- **Setup** (once; every later command runs from `/Users/jwpark/Projects/jevcode-tv-b`; if your shell does not keep the directory between calls, prefix each command with `cd /Users/jwpark/Projects/jevcode-tv-b && `). This is the W0 lane's recipe: the node-pty lines fix a missing `build/Release` directory in fresh worktrees.

```bash
pnpm install --frozen-lockfile
NP=$(ls -d node_modules/.pnpm/node-pty@*/node_modules/node-pty | head -1) && mkdir -p "$NP/build/Release" && pnpm --filter jevcode-desktop rebuild:node && cp "$NP/prebuilds/$(node -p 'process.platform + "-" + process.arch')/spawn-helper" "$NP/build/Release/spawn-helper" && chmod +x "$NP/build/Release/spawn-helper"
pnpm -r build
```

Expected: the second command prints `native modules restored to node ABI`; `pnpm -r build` exits 0.

- **Baseline** (before B-1): `pnpm --filter @jevcode/trace-viewer test` exits 0 (W0's `lint-boundaries`, `types` and `source` tests), `pnpm -r typecheck` exits 0, `pnpm lint` prints nothing after `> pnpm exec eslint .`.

## Global Constraints

Copied from the binding decision record (quoted text is verbatim) and the lane index. Every task's requirements include this section.

- D1: the primary reader is "a SUPERVISOR reviewing what the agent did (intent, decisions, edits, tests, risky moments, claim vs evidence)".
- D2: "Keep the model's input (TraceRow) source-agnostic." The fold reads `TraceRow {seq, type, ts, payload, clipped?, factId?}` only.
- D10: "New event agent_interrupted {reason: interrupt|steer|stop}". Interrupt, steer and stop never make a turn `failed` or raise `agent_failed`.
- D11: "Sessions recorded before M1: APPROXIMATE unit<->evidence joins (time window + unit.files) with a header notice; no legacy-id resolver."
- R2: "exitCode stays `?? -1` in storage; the viewer renders -1 as "unknown", never failed." "Every new field OPTIONAL". The fold must work on rows with and without `turnId`, `callId`, `sourceCallId`, `factId` and `agentCallIds`.
- R7: "src/model (React-free; ESLint bans react, node:*, electron, @jevcode/{storage,semantic-core,evidence-engine,jev-router,agent-*}; exported as "@jevcode/trace-viewer/model")". "Model hashes nothing." W0 also bans the globals `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `process`, `Buffer`, `require`, `global`, `__dirname`, `__filename`, `setImmediate`, `clearImmediate` in `src/**` outside tests, benches and `src/test-support/**`.
- R8: "createTraceState(meta) -> accumulate(state, row) -> finalize(state, {live}) -> TraceSession {schemaVersion 1, meta, loadedThroughSeq, turns, steps, chapters, entities (files only in v1), findings, gaps, coverage, hidden}. Repeated seq skipped; lower seq -> out_of_order gap; bad payload -> invalid_row gap and continue; graph_*/telemetry/ui_snapshot/failure rows only counted in hidden. Output sorted by (seq, id). Budgets (benchmark, not CI gate): full fold of 75k rows <= 500 ms; one appended row <= 2 ms."
- R9: "Stable ids: step:<firstSeq>, unit:<changeUnitId>, decision:<decisionId>, file:<path>, finding:<ruleId>@<version>:<anchorSeq>."
- R10: "callId pairing, else FIFO by family+target within turn (provenance inferred); evidence attach by sourceCallId, else latest same normalized command in turn; agent file_changed = claim, repo facts = observed; turns split on agent_started (trigger initial|steer|resume; outcome completed|failed|interrupted|waiting|running|unknown); chapters from ChangeUnit.evidence (canonical ids) + agentCallIds (observed), else time window + unit.files (inferred, D11); claim vs evidence (turn's last assistant message matching a success lexicon without negation vs latest earlier test/check step); problems facet orthogonal to kind (exit_nonzero, tests_failed, agent_failed, destructive, guardrail, claim_contradicted; exit -1 = unknown); noise (read, lockfile, formatting, duplicate_poll, lifecycle, superseded, intermediate passing_test) collapsed with reasons, never a step with a problem."
- R11: "Signals v1 (each {id, version, rationale, knownFalsePositives[], requires[]}; coverage lists inactive ones): claim_contradicted (critical), failing_tests (warning; critical if target's final run failed), destructive_command (critical; reuses matchDestructive; known FPs documented), guardrail_clamp (from jev_decision.clamps; unknown clamp ids -> info), recovery_arc (info; fail -> edit -> same target passes). Findings are derived at read time, never persisted, never change live attention; a finding only prevents a step being collapsed."
- R12: "Labels move from WorkspaceHost.tsx:97-200 into src/model/format.ts (truncateMiddle grapheme-safe, formatOffset "+0:39", formatClock, formatDuration single formatter, agentStateLabel, stepHeadline). eventKey/mergeEvents are NOT moved."
- No new npm dependency and no `pnpm-lock.yaml` or `package.json` change in this lane (W0-1 added `@jevcode/semantic-core`, `fast-check`, `vitest` and `@types/node` to `packages/trace-viewer`). A task that needs a dependency stops and escalates.
- Only files listed in a task's **Files** block may change. `eslint.config.mjs`, `docs/SPEC.md` and every `fixtures/**` file are out of bounds for this lane.
- Rebuild rule (index §5): every workspace package exports only `./dist`. Model tests import model sources directly, but `src/test-support/fixture-rows.ts` imports `@jevcode/semantic-core` and every file imports `@jevcode/contracts` from `dist`; the setup's `pnpm -r build` provides them. Run `pnpm --filter @jevcode/trace-viewer build` before anything that imports `@jevcode/trace-viewer/model` from outside the package (B-11, `jevcode-trace-viewer-dev`).
- Commits: one conventional commit per task that lists its files in `git add`. Never add a `Claude-Session:` trailer. Use the repository's configured git identity. Never run `git stash` (the stash stack is shared by all worktrees); set work aside with a WIP commit. The shell is zsh: write `${var}:suffix`, never `"$var:suffix"`.
- Fixture drift (index §4): select fixture rows by content (type, command, text), never by line number or a seq literal. Assert `provenance: "observed"` exactly when the joined rows carry the ids (a `callId`, and a `sourceCallId` for attached facts), never a fixed `"inferred"`.

## Review Focus

Five inputs that the spec implies and a happy-path test would miss, most likely first. Each has a test in the task that owns the code.

1. **A session recorded before M1** (no `turnId`, `callId`, `sourceCallId`, `factId` or `agentCallIds`; unit `evidence` ids that match no row). Expected: chapters that cite fact ids join by time window with `link: "inferred"`, `resolved: 0` and `approx > 0`; `coverage.approximateJoins` is `true`; steps pair with `provenance: "inferred"`; the fold raises no gap. Tests: **B-5** `fold-chapters.test.ts` "legacy session joins by time window"; **B-8** `fold.fixtures.test.ts` runs every fixture assertion on the `legacy` variant.
2. **Interrupt or steer while a command runs; Codex gave no exit code.** Expected: the open command step is `unknown` (never `failed`) with an `unpaired` gap; the turn is `interrupted` with its reason; the next turn's trigger is `steer`; exit `-1` is `unknown` with no `exit_nonzero` and no `failing_tests` finding. Tests: **B-3** `fold.test.ts` "interrupted turn leaves the open command unknown" and "maps exit codes: 0 ok, positive failed, -1 unknown"; **B-7** `signals.test.ts` "does not treat an unknown exit code as a failing test".
3. **A `replay.db` or `trace.json` bundle whose pipeline rows carry processing times** (`meta.startedAt`, `decision`, `jev_decision` and `change_unit` rows stamped by the replay run, days after the fixture's source times). Expected: the clock starts at the first agent or fact row and pipeline rows inherit it, so the timeline neither collapses to +0:00 nor jumps by days. Tests: **B-3** `fold.test.ts` "starts the clock at the first agent row and keeps it monotonic when timestamps go backwards"; **B-5** `fold-chapters.test.ts` "keeps pipeline rows on the inherited clock".
4. **Live follow: `finalize` after every 1 s poll, pages that split anywhere, a page redelivered after a retry, and a React store holding the previous session.** Expected: any batch split and any intermediate `finalize` give a deep-equal session; redelivered rows change nothing; a session already returned never changes when later rows arrive. Tests: **B-3** `fold.test.ts` "never changes a returned session when more rows arrive"; **B-9** `fold.parity.test.ts` (fast-check over split points, `live`, and redelivered prefixes, on all five fixtures, their legacy variants and a 3,000-row synthetic session).
5. **Success wording that is negated, partial or incidental** ("Not all tests pass yet.", "Tests pass except the flaky one.", "I'm done reading the file", a claim after a later passing rerun). Expected: no `claim_contradicted` finding (it is critical and paints the claim red). Tests: **B-7** `signals.test.ts` "success claim lexicon" table and "does not fire on a negated claim or after a later passing run".

## File structure

All paths are under `packages/trace-viewer/` unless a path starts with `apps/`.

| File | Responsibility | Task |
|---|---|---|
| `src/model/format.ts` | Grapheme-safe truncation, offsets, clock, durations, state and event labels, `normalizeCommand`, `exitLabel`, `displayUntrusted`, `stepHeadline`; `pickGraphic`, `describeGraphic` (R25) | B-1 (B-10 appends the graphics) |
| `src/model/registry.ts` | Exhaustive rule tables (`KIND_META`, `ENVELOPE_RULES`, `AGENT_EVENT_RULES`, `FACT_RULES`, `CLAMP_META`) and command/path classifiers | B-2 |
| `src/model/rows.ts` | `rowsFromPipelineRecords`: pipeline records to `TraceRow`s | B-2 |
| `src/test-support/fixture-rows.ts` | Test-only: fixtures through `PipelineCoordinator`; legacy and captured variants | B-2 |
| `src/model/fold-state.ts` | Internal: `FoldState`, step and turn drafts, display clock, step helpers | B-3 (B-4, B-5, B-12 extend) |
| `src/model/fold-agent.ts` | Agent events: turns, point steps, start/complete pairing, edit claims | B-3 (B-12 extends) |
| `src/model/fold.ts` | Public fold API; seq handling, gaps, hidden counts; `finalize` assembly | B-3 (B-4 to B-7, B-12 extend) |
| `src/test-support/trace-builder.ts` | Test-only row builder | B-3 |
| `src/model/fold-evidence.ts` | Facts and validations: evidence attach, tests and checks, edits, entities | B-4 |
| `src/model/fold-chapters.ts` | Change units to chapters, decision steps, guardrail and attention steps | B-5 (B-12 extends) |
| `src/model/classify.ts` | Problems, `missing_evidence`, noise | B-6 |
| `src/model/signals.ts` | Signal registry, the five v1 rules, coverage, finding assembly, `FINDING_RULE_RANK` and `compareFindings` | B-7 (B-12 extends) |
| `src/model/fold.fixtures.test.ts`, `fold.mutations.test.ts` | Five-fixture assertions (three variants) and mutations | B-8 (B-12 extends both) |
| `src/test-support/synthetic-rows.ts`, `src/model/fold.parity.test.ts`, `fold.bench.ts` | Synthetic session, parity property, budgets | B-9 |
| `src/model/search.ts`, `lookup.ts`, `graphics.test.ts` | Step search, stable-id resolution; tests for the mini-graphic specs in `format.ts` | B-10 |
| `src/model/index.ts` | Barrel: each task appends its export lines | B-1, B-2, B-3, B-7, B-10 |
| `src/model/types.ts` | W0 types (including the R25 UI fields); B-4 adds `TestDetail.resultSeq` | B-4 |
| `src/model/ui-fields.test.ts` | R25 fields: `startMs`, turn plan and claim, chapter state, finding anchors, decision answers | B-12 |
| `apps/desktop/src/renderer/components/WorkspaceHost.tsx` | Uses the model's labels | B-11 |

Order: B-1 → B-2 → B-3 → B-4 → B-5 → B-6 → B-7 → B-8 → B-9; B-10 needs only B-7; B-11 needs only B-1; B-12 needs B-8 and B-10. One controller runs them in the order B-1 … B-12 on one branch.

**Commands used by every task** (run from `/Users/jwpark/Projects/jevcode-tv-b`):
- Targeted tests: `pnpm --filter @jevcode/trace-viewer exec vitest run <path relative to packages/trace-viewer>`.
- Package typecheck: `pnpm --filter @jevcode/trace-viewer typecheck` (`tsc -p tsconfig.json --noEmit`; it covers tests, benches and `src/test-support`).
- Root checks (index §5, with the W0 lane's serial test run for three pre-existing flaky suites): `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r --workspace-concurrency=1 test`, `pnpm lint`.
- If a storage or desktop test fails with `NODE_MODULE_VERSION`, run `pnpm --filter jevcode-desktop rebuild:node` (last line `native modules restored to node ABI`) and rerun.

---

### Task B-1: Labels and formatters (`format.ts`)

**Files:**
- Create: `packages/trace-viewer/src/model/format.ts`
- Test: `packages/trace-viewer/src/model/format.test.ts`
- Modify: `packages/trace-viewer/src/model/index.ts` (append one line)

**Interfaces:**
- Consumes (W0): from `@jevcode/contracts`: `type AgentState = "starting" | "running" | "waiting_decision" | "paused" | "completed" | "failed"`; `type NormalizedAgentEvent` (16 variants, including `agent_reasoning {text, callId?}` and `agent_interrupted {reason: "interrupt" | "steer" | "stop"}`). From `./types.js`: `type StepKind` (`STEP_KINDS`), `interface TestCounts { passed: number; failed: number; skipped: number }`.
- Produces (exported from `@jevcode/trace-viewer/model`):
  - `truncateMiddle(text: string, maxGraphemes: number): string`
  - `normalizeCommand(command: string): string` (addition; see deviation 4)
  - `exitLabel(exitCode: number | null): string` (UI index §1.4 B-1): `"exit 0"`, `"exit 1"`, `"exit unknown"` for −1, `""` for null
  - `displayUntrusted(text: string, options?: { multiline?: boolean }): string` (UI index §1.4 B-1): replaces U+202A–U+202E, U+2066–U+2069, U+200E, U+200F and C0 controls (except `\t`, and `\n` when `multiline`) with a visible `⟨U+XXXX⟩` token. `truncateMiddle` and `stepHeadline` call it, so every headline, path label and entity label is safe to render.
  - `formatOffset(ms: number): string`
  - `formatClock(ts: string, options?: { seconds?: boolean }): string`
  - `formatDuration(ms: number | null): string`
  - `agentStateLabel(state: AgentState): string`
  - `toolLabel(tool: string): string` (addition)
  - `agentEventLabel(event: NormalizedAgentEvent): string`
  - `interface StepHeadlineInput { kind: StepKind; target?: string; text?: string; tests?: TestCounts; exitCode?: number | null; decisionTitle?: string; clampIds?: string[] }`
  - `stepHeadline(input: StepHeadlineInput): string`

- [ ] **Step 1: Write the failing test**

Create `packages/trace-viewer/src/model/format.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/model/format.test.ts`

Expected: FAIL, `Error: Cannot find module './format.js' imported from '…/packages/trace-viewer/src/model/format.test.ts'`, `Tests  no tests`.

- [ ] **Step 3: Write the implementation**

Create `packages/trace-viewer/src/model/format.ts`:

```ts
import type { AgentState, NormalizedAgentEvent } from "@jevcode/contracts";

import type { StepKind, TestCounts } from "./types.js";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), (part) => part.segment);
}

/** Bidi controls (U+202A–U+202E, U+2066–U+2069, U+200E, U+200F) and C0 controls other than \t,
 *  and \n when multiline. All are single UTF-16 code units. Checked by code, not by a regex,
 *  because ESLint's no-control-regex rejects control ranges in patterns. */
function isUntrustedCode(code: number, multiline: boolean): boolean {
  if (code < 0x20) return code !== 0x09 && !(multiline && code === 0x0a);
  return (
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * Replaces bidi and control characters with a visible ⟨U+XXXX⟩ token (spec §6.8), so agent text
 * cannot reorder or hide a command or path the supervisor reads. Tabs stay; line breaks stay only
 * with { multiline: true }. Text without such characters is returned as is.
 */
export function displayUntrusted(text: string, options: { multiline?: boolean } = {}): string {
  const multiline = options.multiline === true;
  let result = "";
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (!isUntrustedCode(code, multiline)) continue;
    result += `${text.slice(start, index)}⟨U+${code.toString(16).toUpperCase().padStart(4, "0")}⟩`;
    start = index + 1;
  }
  return start === 0 ? text : result + text.slice(start);
}

/** "exit 0", "exit 1"; "exit unknown" for a negative code (R2: -1 = Codex gave none); "" while running. */
export function exitLabel(exitCode: number | null): string {
  if (exitCode === null) return "";
  return exitCode < 0 ? "exit unknown" : `exit ${exitCode}`;
}

/**
 * Shortens text to at most maxGraphemes user-perceived characters by cutting
 * the middle. Paths keep their whole basename when it fits ("src/au…/file.ts").
 * Never splits an emoji ZWJ sequence or a Hangul syllable. Bidi and control
 * characters become visible tokens first (displayUntrusted).
 */
export function truncateMiddle(text: string, maxGraphemes: number): string {
  if (!Number.isFinite(maxGraphemes) || maxGraphemes < 1) return "";
  const max = Math.floor(maxGraphemes);
  const safe = displayUntrusted(text);
  // A string never has more graphemes than UTF-16 code units: skip the segmenter when it fits.
  if (safe.length <= max) return safe;
  const all = graphemes(safe);
  if (all.length <= max) return safe;
  const slash = safe.lastIndexOf("/");
  if (slash > 0 && slash < safe.length - 1) {
    const basename = graphemes(safe.slice(slash + 1));
    if (basename.length <= max - 2) {
      const headCount = max - 2 - basename.length;
      return `${all.slice(0, headCount).join("")}…/${basename.join("")}`;
    }
  }
  const headCount = Math.ceil((max - 1) / 2);
  const tailCount = Math.floor((max - 1) / 2);
  const tail = tailCount === 0 ? "" : all.slice(all.length - tailCount).join("");
  return `${all.slice(0, headCount).join("")}…${tail}`;
}

/** Cuts the end: at most maxGraphemes graphemes including the "…". Segments only the prefix it
 *  keeps. Bidi and control characters become visible tokens first (displayUntrusted). */
function truncateEnd(text: string, maxGraphemes: number): string {
  const safe = displayUntrusted(text);
  if (safe.length <= maxGraphemes) return safe;
  const kept: string[] = [];
  for (const part of graphemeSegmenter.segment(safe)) {
    if (kept.length === maxGraphemes) {
      kept.pop();
      return `${kept.join("")}…`;
    }
    kept.push(part.segment);
  }
  return safe;
}

function firstLine(text: string): string {
  let start = 0;
  while (start <= text.length) {
    const end = text.indexOf("\n", start);
    const line = (end === -1 ? text.slice(start) : text.slice(start, end)).trim();
    if (line !== "" || end === -1) return line;
    start = end + 1;
  }
  return "";
}

const SHELL_WRAPPER = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/;

/** Trims, unwraps one `bash -lc '…'` or `zsh -lc '…'` wrapper and collapses whitespace: the key
 *  for pairing, evidence attach and "same target" comparisons. */
export function normalizeCommand(command: string): string {
  const trimmed = command.trim();
  const inner = trimmed.match(SHELL_WRAPPER)?.[2] ?? trimmed;
  return inner.trim().replace(/\s+/g, " ");
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Session-relative offset: "+0:39", "+12:05", "+1:02:03". */
export function formatOffset(ms: number): string {
  const totalSeconds = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `+${hours}:${pad2(minutes)}:${pad2(seconds)}`;
  return `+${minutes}:${pad2(seconds)}`;
}

/** Wall-clock time of an ISO timestamp in the viewer's locale; "" when invalid. */
export function formatClock(ts: string, options: { seconds?: boolean } = {}): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    ...(options.seconds === true ? { second: "2-digit" as const } : {}),
  });
}

/** The only duration formatter: "850 ms", "4.5 s", "45 s", "2 m 05 s", "1 h 02 m". */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "";
  const value = Math.max(0, ms);
  if (value < 1000) return `${Math.floor(value)} ms`;
  if (value < 10_000) return `${(Math.floor(value / 100) / 10).toFixed(1)} s`;
  if (value < 60_000) return `${Math.floor(value / 1000)} s`;
  if (value < 3_600_000) {
    const minutes = Math.floor(value / 60_000);
    const seconds = Math.floor((value % 60_000) / 1000);
    return `${minutes} m ${pad2(seconds)} s`;
  }
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  return `${hours} h ${pad2(minutes)} m`;
}

export function agentStateLabel(state: AgentState): string {
  switch (state) {
    case "starting":
      return "Starting";
    case "running":
      return "Working";
    case "waiting_decision":
      return "Needs your decision";
    case "paused":
      return "Paused";
    case "completed":
      return "Completed";
    case "failed":
      return "Stopped with an error";
  }
}

function readable(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** "mcp.github.search_issues" -> "Search Issues". */
export function toolLabel(tool: string): string {
  const parts = tool.split(".");
  return readable(parts[parts.length - 1] ?? tool);
}

export function agentEventLabel(event: NormalizedAgentEvent): string {
  switch (event.type) {
    case "agent_started":
      return "Started working on the task";
    case "agent_message":
      return event.role === "user" ? "Direction received" : event.text;
    case "agent_reasoning":
      return "Thinking";
    case "tool_started":
      return `Using ${toolLabel(event.tool)}`;
    case "tool_completed":
      return `Finished ${toolLabel(event.tool)}`;
    case "command_started":
      return `Running ${event.command}`;
    case "command_completed":
      return event.exitCode < 0
        ? `${event.command} finished (exit code unknown)`
        : `${event.command} finished with exit ${event.exitCode}`;
    case "file_read":
      return `Reading ${truncateMiddle(event.path, 48)}`;
    case "file_changed":
      return `Changed ${truncateMiddle(event.path, 48)}`;
    case "approval_requested":
      return `Approval needed for ${event.command}`;
    case "test_started":
      return `Checking with ${event.command}`;
    case "test_completed":
      return event.exitCode === 0
        ? `${event.command} passed`
        : event.exitCode < 0
          ? `${event.command} finished`
          : `${event.command} failed`;
    case "agent_waiting":
      return "Waiting for direction";
    case "agent_completed":
      return "Turn ended";
    case "agent_failed":
      return `Stopped: ${event.error}`;
    case "agent_interrupted":
      return event.reason === "stop" ? "Stopped" : event.reason === "steer" ? "Redirected" : "Paused";
  }
}

export interface StepHeadlineInput {
  kind: StepKind;
  target?: string;
  text?: string;
  tests?: TestCounts;
  exitCode?: number | null;
  decisionTitle?: string;
  clampIds?: string[];
}

const HEADLINE_MAX = 80;
const COMMAND_MAX = 64;
const PATH_MAX = 48;

/** The instruction line of a structured decision answer ("decision: … instruction:\n  text"). */
const INSTRUCTION_SECTION = /(?:^|\n)instruction:[ \t]*\n[ \t]*(\S[^\n]*)/;

function testsHeadline(command: string, tests: TestCounts): string {
  const total = tests.passed + tests.failed + tests.skipped;
  const counts = total === 0 ? "no tests ran" : `${tests.passed}/${total}`;
  return command === "" ? `Tests · ${counts}` : `${command} · ${counts}`;
}

function runHeadline(command: string, exitCode: number | null | undefined): string {
  return exitCode === null ? `Running ${command}` : command;
}

/** Short title for a step. Details belong in the Inspector (D8). Every agent-supplied string goes
 *  through truncateMiddle or truncateEnd, which call displayUntrusted. */
export function stepHeadline(input: StepHeadlineInput): string {
  const target = input.target ?? "";
  const text = input.text !== undefined ? firstLine(input.text) : "";
  switch (input.kind) {
    case "instruction": {
      const answer = input.text?.match(INSTRUCTION_SECTION)?.[1]?.trim();
      if (answer !== undefined && answer !== "") return truncateEnd(answer, HEADLINE_MAX);
      return text === "" ? "Instruction" : truncateEnd(text, HEADLINE_MAX);
    }
    case "message":
      return text === "" ? "Message" : truncateEnd(text, HEADLINE_MAX);
    case "reasoning":
      return "Thinking";
    case "command":
    case "test":
    case "check": {
      const command = target === "" ? "" : truncateMiddle(normalizeCommand(target), COMMAND_MAX);
      if (input.kind === "test" && input.tests !== undefined) return testsHeadline(command, input.tests);
      if (command === "") return input.kind === "test" ? "Tests" : input.kind === "check" ? "Check" : "Command";
      return runHeadline(command, input.exitCode);
    }
    case "edit":
      return target === "" ? "Edit" : truncateMiddle(target, PATH_MAX);
    case "read":
      return target === "" ? "Read" : `Read ${truncateMiddle(target, PATH_MAX)}`;
    case "tool":
      return target === "" ? "Tool" : truncateMiddle(toolLabel(target), COMMAND_MAX);
    case "approval":
      return target === "" ? "Approval needed" : `Approval needed for ${truncateMiddle(normalizeCommand(target), COMMAND_MAX)}`;
    case "decision":
      return input.decisionTitle !== undefined && input.decisionTitle !== ""
        ? truncateEnd(input.decisionTitle, HEADLINE_MAX)
        : "Decision";
    case "dependency":
      if (text !== "") return truncateEnd(text, HEADLINE_MAX);
      return target === "" ? "Dependencies changed" : `Dependencies in ${truncateMiddle(target, PATH_MAX)}`;
    case "revert":
      return text === "" ? "Revert detected" : truncateEnd(text, HEADLINE_MAX);
    case "lifecycle":
      return text === "" ? "Session event" : truncateEnd(text, HEADLINE_MAX);
    case "guardrail": {
      if (text !== "") return truncateEnd(text, HEADLINE_MAX);
      const count = input.clampIds?.length ?? 0;
      return count === 1 ? "1 guardrail" : `${count} guardrails`;
    }
    case "attention":
      return "Attention scored";
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/model/format.test.ts`

Expected: `Test Files  1 passed (1)`, `Tests  45 passed (45)`.

- [ ] **Step 5: Export from the model barrel**

In `packages/trace-viewer/src/model/index.ts`, find:

```ts
export * from "./types.js";
```

Replace it with:

```ts
export * from "./types.js";
export * from "./format.js";
```

Run: `pnpm --filter @jevcode/trace-viewer typecheck`

Expected: exits 0 with no output after the script line.

- [ ] **Step 6: Root checks**

Run, in order, from `/Users/jwpark/Projects/jevcode-tv-b`:

```bash
pnpm -r build
pnpm -r typecheck
pnpm -r --workspace-concurrency=1 test
pnpm lint
```

Expected: each command exits 0. `pnpm -r build` includes `jevcode-trace-viewer-dev`, whose Vite plugin fails the build if any module reachable from `@jevcode/trace-viewer/model` imports a Node built-in (the browser-safety proof). `pnpm lint` prints nothing after `> pnpm exec eslint .`.

- [ ] **Step 7: Commit**

```bash
git add packages/trace-viewer/src/model/format.ts \
  packages/trace-viewer/src/model/format.test.ts \
  packages/trace-viewer/src/model/index.ts
git commit -m "feat(trace-viewer): add model label and duration formatters"
```

### Task B-2: Rule registries, `rowsFromPipelineRecords`, fixture harness

**Files:**
- Create: `packages/trace-viewer/src/model/registry.ts`, `packages/trace-viewer/src/model/rows.ts`, `packages/trace-viewer/src/test-support/fixture-rows.ts`
- Test: `packages/trace-viewer/src/model/registry.test.ts`, `packages/trace-viewer/src/model/rows.test.ts`
- Modify: `packages/trace-viewer/src/model/index.ts` (append two lines)

**Interfaces:**
- Consumes: B-1 `normalizeCommand(command: string): string`. From `@jevcode/contracts`: `EVENT_TYPES`, `type EventStoreType`, `TRACE_ROW_TYPES`, `type TraceRow`, `type TraceSessionSummary`, `type EvidenceFact`, `type EvidenceFactType`, `type NormalizedAgentEventType`, and the schemas `EvidenceFactSchema`, `NormalizedAgentEventSchema`, `DecisionSchema`, `ChangeUnitSchema`, `ValidationResultSchema`, `JevDecisionLogSchema`, `SemanticEventSchema`. From `./types.js`: `LANES`, `STEP_KINDS`, `type Lane`, `type Actor`, `type Severity`, `type StepKind`. From `@jevcode/semantic-core` (test-support only): `parseReplayLine(line: string): PipelineRecord | null` (zod-parses with the contracts schemas), `new PipelineCoordinator()` with `ingest(record)`, `flush()`, `snapshot(): { units: ChangeUnit[]; validations: ValidationResult[]; … }`, `factContentId(sessionId: string, record: unknown): string`.
- Produces:
  - `registry.ts`: `interface KindMeta { lane: Lane; actor: Actor; label: string }`; `KIND_META: { readonly [K in StepKind]: KindMeta }` with the lanes UI index §1.4 B-2 pins (instruction, approval, decision → `supervisor`; message, reasoning, tool, lifecycle → `agent`; command → `commands`; edit, read, dependency, revert → `edits`; test, check → `tests`; guardrail, attention → `jev`); `type RowDisposition = "consume" | "hidden"`; `ENVELOPE_RULES: { readonly [K in EventStoreType]: RowDisposition }`; `interface AgentEventRule { kind: StepKind; role: "start" | "complete" | "point" }`; `AGENT_EVENT_RULES: { readonly [K in NormalizedAgentEventType]: AgentEventRule }`; `interface FactRule { kind: StepKind; attach: "call" | "path" | "none" }`; `FACT_RULES: { readonly [K in EvidenceFactType]: FactRule }`; `interface ClampMeta { label: string; severity: Severity }`; `CLAMP_META: Readonly<Record<string, ClampMeta>>`; `clampMeta(id: string): ClampMeta`; additions `severityRank(severity: Severity): number`, `CHECK_COMMAND: RegExp` (anchored at the head of a normalized command, spec §6.6), `TEST_COMMAND: RegExp`, `commandKind(command: string): "check" | "test" | "command"` (matches both patterns against `normalizeCommand(command)`), `isLockfilePath(path: string): boolean`, `READ_TOOL: RegExp`.
  - `rows.ts`: `interface PipelineRowOptions { factId?: (fact: EvidenceFact) => string; firstSeq?: number }`; `rowsFromPipelineRecords(records: readonly unknown[], options?: PipelineRowOptions): TraceRow[]`.
  - `test-support/fixture-rows.ts` (test-only): `FIXTURE_NAMES = ["oauth", "rate-limit", "schema-change", "api-break", "dep-change"] as const`; `type FixtureName`; `interface FixtureTrace { meta: TraceSessionSummary; rows: TraceRow[] }`; `loadFixtureTrace(name: FixtureName): FixtureTrace`; additions `fixtureEventsPath(name: FixtureName): string`, `fixtureLines(name: FixtureName): string[]`, `stripCaptureFields(rows: readonly TraceRow[]): TraceRow[]` (a pre-M1 session: no `turnId`, `callId`, `sourceCallId`, `factId`, `agentCallIds`), `addCaptureFields(rows: readonly TraceRow[]): TraceRow[]` (the A1-9 shape; keeps fields already present).

- [ ] **Step 1: Write the failing tests**

Create `packages/trace-viewer/src/model/registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  EVENT_TYPES,
  EvidenceFactSchema,
  NormalizedAgentEventSchema,
  TRACE_ROW_TYPES,
} from "@jevcode/contracts";

import {
  AGENT_EVENT_RULES,
  CLAMP_META,
  clampMeta,
  commandKind,
  ENVELOPE_RULES,
  FACT_RULES,
  isLockfilePath,
  KIND_META,
  READ_TOOL,
} from "./registry.js";
import { LANES, STEP_KINDS } from "./types.js";

// The mapped types already fail typecheck on a missing key; these checks catch entries a
// cast would slip past and keep the tables in step with the zod schemas at runtime.

const GUARDRAIL_CLAMP_IDS = [
  "destructive_command",
  "security_path",
  "schema_floor",
  "public_api",
  "suppress_formatting",
  "suppress_lockfile",
  "suppress_passing_tests",
  "failed_unit_relevance",
  "interrupt_floor",
  "decision_presence_floor",
  "noise_triad_cap_formatting",
  "noise_triad_cap_lockfile",
  "failed_unit_attention",
  "required_decision_attention",
  "attention_sanitize",
];

describe("rule tables", () => {
  it("maps every step kind to a lane, actor and label", () => {
    expect(Object.keys(KIND_META).sort()).toEqual([...STEP_KINDS].sort());
    for (const kind of STEP_KINDS) {
      expect(LANES).toContain(KIND_META[kind].lane);
      expect(KIND_META[kind].label.length).toBeGreaterThan(0);
    }
  });

  it("pins each kind's lane (UI index §1.4 B-2)", () => {
    const lanes = Object.fromEntries(STEP_KINDS.map((kind) => [kind, KIND_META[kind].lane]));
    expect(lanes).toEqual({
      instruction: "supervisor",
      approval: "supervisor",
      decision: "supervisor",
      message: "agent",
      reasoning: "agent",
      tool: "agent",
      lifecycle: "agent",
      command: "commands",
      edit: "edits",
      read: "edits",
      dependency: "edits",
      revert: "edits",
      test: "tests",
      check: "tests",
      guardrail: "jev",
      attention: "jev",
    });
  });

  it("maps every envelope type and consumes exactly TRACE_ROW_TYPES", () => {
    expect(Object.keys(ENVELOPE_RULES).sort()).toEqual([...EVENT_TYPES].sort());
    const consumed = EVENT_TYPES.filter((type) => ENVELOPE_RULES[type] === "consume");
    expect([...consumed].sort()).toEqual([...TRACE_ROW_TYPES].sort());
  });

  it("maps every agent event variant in the contracts schema", () => {
    const variants = NormalizedAgentEventSchema.options.map((option) => option.shape.type.value);
    expect(Object.keys(AGENT_EVENT_RULES).sort()).toEqual([...variants].sort());
    for (const variant of variants) {
      expect(STEP_KINDS).toContain(AGENT_EVENT_RULES[variant].kind);
    }
  });

  it("maps every evidence fact variant in the contracts schema", () => {
    const variants = EvidenceFactSchema.options.map((option) => option.shape.type.value);
    expect(Object.keys(FACT_RULES).sort()).toEqual([...variants].sort());
    for (const variant of variants) {
      expect(STEP_KINDS).toContain(FACT_RULES[variant].kind);
    }
  });

  it("labels the 15 guardrail clamp ids and falls back to info for unknown ids", () => {
    expect(Object.keys(CLAMP_META).sort()).toEqual([...GUARDRAIL_CLAMP_IDS].sort());
    for (const id of GUARDRAIL_CLAMP_IDS) expect(clampMeta(id).label.length).toBeGreaterThan(0);
    expect(clampMeta("destructive_command").severity).toBe("critical");
    expect(clampMeta("security_path").severity).toBe("warning");
    expect(clampMeta("suppress_lockfile").severity).toBe("info");
    expect(clampMeta("guardrail.security")).toEqual({ label: "guardrail.security", severity: "info" });
    expect(clampMeta("toString")).toEqual({ label: "toString", severity: "info" });
  });
});

describe("command and path rules", () => {
  it.each([
    ["pnpm test", "test"],
    ["/bin/zsh -lc 'pnpm run test -- auth'", "test"],
    ["npx vitest run", "test"],
    ["cargo test", "test"],
    ["pnpm typecheck", "check"],
    ["pnpm lint && pnpm test", "check"],
    ["tsc --noEmit", "check"],
    ["pnpm -r typecheck", "check"],
    ["pnpm --filter x lint", "check"],
    ["pnpm --filter=web build", "check"],
    ["npm run build", "check"],
    ["yarn lint", "check"],
    ["npx eslint src", "check"],
    ["pnpm exec tsc -p tsconfig.json", "check"],
    ["npx vite build", "check"],
    ["/bin/zsh -lc 'pnpm -r build'", "check"],
    ["cat tests/users.test.ts", "command"],
    ["pnpm add zod", "command"],
    // Near misses: a check word that is not the command head (spec §6.6).
    ["pnpm add eslint", "command"],
    ["ls build", "command"],
    ["grep -r build src", "command"],
    ["git commit -m 'fix lint'", "command"],
    ["cat tsconfig.json", "command"],
    ["pnpm test -- --grep build", "test"],
  ])("%s is a %s", (command, kind) => {
    expect(commandKind(command)).toBe(kind);
  });

  it("recognizes lockfiles by basename", () => {
    expect(isLockfilePath("pnpm-lock.yaml")).toBe(true);
    expect(isLockfilePath("apps/web/package-lock.json")).toBe(true);
    expect(isLockfilePath("src/lockfile.ts")).toBe(false);
  });

  it("recognizes read-only tools", () => {
    expect(READ_TOOL.test("read_file")).toBe(true);
    expect(READ_TOOL.test("mcp.fs.list_dir")).toBe(true);
    expect(READ_TOOL.test("apply_patch")).toBe(false);
    expect(READ_TOOL.test("thread_reader")).toBe(false);
  });
});
```

Create `packages/trace-viewer/src/model/rows.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  addCaptureFields,
  fixtureLines,
  FIXTURE_NAMES,
  loadFixtureTrace,
  stripCaptureFields,
} from "../test-support/fixture-rows.js";
import { rowsFromPipelineRecords } from "./rows.js";

describe("rowsFromPipelineRecords", () => {
  it("classifies each record and numbers rows from firstSeq", () => {
    const fact = { type: "file_changed", repoId: "r", sessionId: "s", ts: "2026-09-18T09:00:01.000Z", path: "a.ts", kind: "added" };
    const claim = { type: "file_changed", sessionId: "s", ts: "2026-09-18T09:00:02.000Z", path: "a.ts" };
    const decision = {
      id: "dec-1",
      sessionId: "s",
      title: "t",
      context: "",
      severity: "optional",
      options: [],
      affectedChangeUnits: [],
      evidence: [],
      status: "open",
    };
    const rows = rowsFromPipelineRecords([fact, claim, decision], { firstSeq: 10, factId: () => "fact_x" });
    expect(rows.map((row) => [row.seq, row.type, row.ts, row.factId])).toEqual([
      [10, "evidence_fact", "2026-09-18T09:00:01.000Z", "fact_x"],
      [11, "agent_event", "2026-09-18T09:00:02.000Z", undefined],
      [12, "decision", "2026-09-18T09:00:02.000Z", undefined],
    ]);
    expect(rows[0]?.payload).toBe(fact);
  });

  it("throws a TypeError on a record that matches no schema", () => {
    expect(() => rowsFromPipelineRecords([{ hello: "world" }])).toThrow(TypeError);
  });

  it("yields one row per oauth fixture line, seq 1..N in line order", () => {
    const lines = fixtureLines("oauth");
    const rows = rowsFromPipelineRecords(lines.map((line) => JSON.parse(line) as unknown));
    expect(rows).toHaveLength(lines.length);
    expect(rows.map((row) => row.seq)).toEqual(lines.map((_, index) => index + 1));
    expect(rows.every((row) => row.ts !== "")).toBe(true);
  });
});

describe("fixture harness", () => {
  it.each(FIXTURE_NAMES)("loads %s with record rows first, then change_unit and validation rows", (name) => {
    const trace = loadFixtureTrace(name);
    const lines = fixtureLines(name);
    const derived = trace.rows.slice(lines.length);
    expect(trace.rows.slice(0, lines.length).every((row) => row.type !== "change_unit" && row.type !== "validation")).toBe(true);
    expect(derived.length).toBeGreaterThan(0);
    expect(derived.every((row) => row.type === "change_unit" || row.type === "validation")).toBe(true);
    expect(trace.rows.map((row) => row.seq)).toEqual(trace.rows.map((_, index) => index + 1));
    expect(trace.meta).toMatchObject({ state: "completed", lastEventSeq: trace.rows.length });
    const facts = trace.rows.filter((row) => row.type === "evidence_fact");
    expect(facts.every((row) => row.factId?.startsWith("fact_"))).toBe(true);
  });

  it("strips and adds the M1 capture fields", () => {
    const trace = loadFixtureTrace("oauth");
    const legacy = stripCaptureFields(trace.rows);
    expect(legacy.some((row) => row.factId !== undefined)).toBe(false);
    expect(legacy.some((row) => JSON.stringify(row.payload).includes("callId"))).toBe(false);
    const captured = addCaptureFields(legacy);
    const started = captured.find((row) => (row.payload as Record<string, unknown>)["type"] === "command_started");
    const completed = captured.find((row) => (row.payload as Record<string, unknown>)["type"] === "command_completed");
    const callId = (started?.payload as Record<string, unknown>)["callId"];
    expect(typeof callId).toBe("string");
    expect((completed?.payload as Record<string, unknown>)["callId"]).toBe(callId);
    const executed = captured.find((row) => (row.payload as Record<string, unknown>)["type"] === "command_executed");
    expect((executed?.payload as Record<string, unknown>)["sourceCallId"]).toBe(callId);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/model/registry.test.ts src/model/rows.test.ts`

Expected: FAIL, `Error: Cannot find module './registry.js'` and `Error: Cannot find module '../test-support/fixture-rows.js'`, `Test Files  2 failed (2)`.

- [ ] **Step 3: Write the registries**

Create `packages/trace-viewer/src/model/registry.ts`:

```ts
import type { EventStoreType, EvidenceFactType, NormalizedAgentEventType } from "@jevcode/contracts";

import { normalizeCommand } from "./format.js";
import type { Actor, Lane, Severity, StepKind } from "./types.js";

// Exhaustive rule tables. The mapped types make a new contract variant or step
// kind a typecheck error until it has an entry here; registry.test.ts catches
// entries that a cast would slip past.

export interface KindMeta {
  lane: Lane;
  actor: Actor;
  label: string;
}

export const KIND_META: { readonly [K in StepKind]: KindMeta } = {
  instruction: { lane: "supervisor", actor: "supervisor", label: "Instruction" },
  message: { lane: "agent", actor: "agent", label: "Message" },
  reasoning: { lane: "agent", actor: "agent", label: "Reasoning" },
  command: { lane: "commands", actor: "agent", label: "Command" },
  test: { lane: "tests", actor: "agent", label: "Test run" },
  check: { lane: "tests", actor: "agent", label: "Check" },
  edit: { lane: "edits", actor: "agent", label: "Edit" },
  read: { lane: "edits", actor: "agent", label: "Read" },
  tool: { lane: "agent", actor: "agent", label: "Tool call" },
  approval: { lane: "supervisor", actor: "agent", label: "Approval request" },
  decision: { lane: "supervisor", actor: "jevcode", label: "Decision" },
  dependency: { lane: "edits", actor: "repo", label: "Dependency change" },
  revert: { lane: "edits", actor: "repo", label: "Revert" },
  lifecycle: { lane: "agent", actor: "agent", label: "Session event" },
  guardrail: { lane: "jev", actor: "jevcode", label: "Guardrail" },
  attention: { lane: "jev", actor: "jevcode", label: "Attention" },
};

export type RowDisposition = "consume" | "hidden";

/** consume = TRACE_ROW_TYPES; everything else is only counted in TraceSession.hidden. */
export const ENVELOPE_RULES: { readonly [K in EventStoreType]: RowDisposition } = {
  agent_event: "consume",
  evidence_fact: "consume",
  change_unit: "consume",
  decision: "consume",
  validation: "consume",
  failure: "hidden",
  jev_decision: "consume",
  ui_intent: "hidden",
  ui_snapshot: "hidden",
  graph_node: "hidden",
  graph_edge: "hidden",
  command: "hidden",
  semantic_event: "hidden",
  telemetry: "hidden",
};

export interface AgentEventRule {
  kind: StepKind;
  role: "start" | "complete" | "point";
}

/** agent_message with role "user" folds as an instruction (supervisor), not a message. */
export const AGENT_EVENT_RULES: { readonly [K in NormalizedAgentEventType]: AgentEventRule } = {
  agent_started: { kind: "instruction", role: "point" },
  agent_message: { kind: "message", role: "point" },
  agent_reasoning: { kind: "reasoning", role: "point" },
  tool_started: { kind: "tool", role: "start" },
  tool_completed: { kind: "tool", role: "complete" },
  command_started: { kind: "command", role: "start" },
  command_completed: { kind: "command", role: "complete" },
  file_read: { kind: "read", role: "point" },
  file_changed: { kind: "edit", role: "point" },
  approval_requested: { kind: "approval", role: "point" },
  test_started: { kind: "test", role: "start" },
  test_completed: { kind: "test", role: "complete" },
  agent_waiting: { kind: "lifecycle", role: "point" },
  agent_completed: { kind: "lifecycle", role: "point" },
  agent_failed: { kind: "lifecycle", role: "point" },
  agent_interrupted: { kind: "lifecycle", role: "point" },
};

export interface FactRule {
  kind: StepKind;
  attach: "call" | "path" | "none";
}

export const FACT_RULES: { readonly [K in EvidenceFactType]: FactRule } = {
  git_hunk: { kind: "edit", attach: "path" },
  file_changed: { kind: "edit", attach: "path" },
  symbol_delta: { kind: "edit", attach: "path" },
  dependency_change: { kind: "dependency", attach: "none" },
  test_result: { kind: "test", attach: "call" },
  command_executed: { kind: "command", attach: "call" },
  revert_detected: { kind: "revert", attach: "none" },
};

export interface ClampMeta {
  label: string;
  severity: Severity;
}

/** The 15 clamp ids pushed in packages/jev-router/src/guardrails.ts:76-256. */
export const CLAMP_META: Readonly<Record<string, ClampMeta>> = {
  destructive_command: { label: "Destructive command", severity: "critical" },
  security_path: { label: "Security-sensitive path", severity: "warning" },
  schema_floor: { label: "Schema change kept visible", severity: "warning" },
  public_api: { label: "Public API change kept visible", severity: "warning" },
  suppress_formatting: { label: "Formatting-only change hidden", severity: "info" },
  suppress_lockfile: { label: "Lockfile change hidden", severity: "info" },
  suppress_passing_tests: { label: "Passing tests hidden", severity: "info" },
  failed_unit_relevance: { label: "Failed change kept relevant", severity: "warning" },
  interrupt_floor: { label: "Interruption floor applied", severity: "info" },
  decision_presence_floor: { label: "Decision kept visible", severity: "info" },
  noise_triad_cap_formatting: { label: "Formatting noise capped", severity: "info" },
  noise_triad_cap_lockfile: { label: "Lockfile noise capped", severity: "info" },
  failed_unit_attention: { label: "Failed change surfaced", severity: "warning" },
  required_decision_attention: { label: "Required decision surfaced", severity: "info" },
  attention_sanitize: { label: "Attention values sanitized", severity: "info" },
};

/** Unknown ids (for example "guardrail.security" in old rows) are info and labeled by their id. */
export function clampMeta(id: string): ClampMeta {
  return Object.hasOwn(CLAMP_META, id) ? (CLAMP_META[id] as ClampMeta) : { label: id, severity: "info" };
}

const SEVERITY_RANK: { readonly [K in Severity]: number } = { info: 0, warning: 1, critical: 2 };

export function severityRank(severity: Severity): number {
  return SEVERITY_RANK[severity];
}

// ------------------------------------------------------------ command and path rules

/** Workspace flags a package manager may take before a script or a binary: -r, -w, --filter x,
 *  --filter=x, -F x, --workspace x. */
const PM_FLAGS = String.raw`(?:\s+(?:-r|--recursive|-w|--workspace-root|(?:-F|--filter|--workspace)(?:=|\s+)\S+))*`;

/** Type checks, linters and builds (R10, spec §6.6), matched at the head of normalizeCommand(command):
 *  tsc, eslint or vite build, bare or through npx or pnpm/npm/yarn (optionally with run or exec), or
 *  a pnpm/npm/yarn typecheck, lint or build script. Anchored, so "ls build", "grep -r build src"
 *  (exit 1 on no match) and "pnpm add eslint" are not checks: a failed check paints red and can
 *  contradict a claim. Checked before TEST_COMMAND. */
export const CHECK_COMMAND = new RegExp(
  String.raw`^(?:npx\s+|(?:pnpm|npm|yarn)${PM_FLAGS}\s+(?:(?:run|exec)\s+)?)?(?:tsc|eslint|vite build)\b` +
    String.raw`|^(?:pnpm|npm|yarn)${PM_FLAGS}\s+(?:run\s+)?(?:typecheck|lint|build)\b`,
);

/** Test runners. A bare word "test" in a path (cat tests/a.test.ts) does not match. */
export const TEST_COMMAND =
  /\b(?:vitest|jest|pytest|mocha)\b|\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:go|cargo|deno)\s+test\b/;

/** Classifies a raw command; both patterns see normalizeCommand(command) (a bash -lc wrapper unwrapped). */
export function commandKind(command: string): "check" | "test" | "command" {
  const normalized = normalizeCommand(command);
  if (CHECK_COMMAND.test(normalized)) return "check";
  if (TEST_COMMAND.test(normalized)) return "test";
  return "command";
}

const LOCKFILE_NAMES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "composer.lock",
  "go.sum",
]);

export function isLockfilePath(path: string): boolean {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return LOCKFILE_NAMES.has(basename);
}

/** Tools that only read (read_file, list_dir, grep, …) collapse as "read" noise. */
export const READ_TOOL = /(?:^|[._-])(?:read|view|list|search|grep|glob|find|ls|cat)(?:[._-]|$)/i;
```

- [ ] **Step 4: Write the row adapter**

Create `packages/trace-viewer/src/model/rows.ts`:

```ts
import {
  ChangeUnitSchema,
  DecisionSchema,
  EvidenceFactSchema,
  JevDecisionLogSchema,
  NormalizedAgentEventSchema,
  SemanticEventSchema,
  ValidationResultSchema,
  type EventStoreType,
  type EvidenceFact,
  type TraceRow,
} from "@jevcode/contracts";
import type { z } from "zod";

export interface PipelineRowOptions {
  /** Called for evidence facts; the harness passes semantic-core's factContentId. The model never hashes. */
  factId?: (fact: EvidenceFact) => string;
  /** Default 1. */
  firstSeq?: number;
}

// Same precedence as parseReplayLine (packages/semantic-core/src/coordinator.ts): a
// file_changed with repoId is a fact, without repoId an agent claim.
const RECORD_KINDS: readonly { type: EventStoreType; schema: z.ZodTypeAny }[] = [
  { type: "evidence_fact", schema: EvidenceFactSchema },
  { type: "agent_event", schema: NormalizedAgentEventSchema },
  { type: "decision", schema: DecisionSchema },
  { type: "change_unit", schema: ChangeUnitSchema },
  { type: "validation", schema: ValidationResultSchema },
  { type: "jev_decision", schema: JevDecisionLogSchema },
  { type: "semantic_event", schema: SemanticEventSchema },
];

function stringField(record: unknown, key: string): string | undefined {
  if (record === null || typeof record !== "object") return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Classifies each record (EvidenceFact, NormalizedAgentEvent, Decision, ChangeUnit,
 * ValidationResult, JevDecisionLog, SemanticEvent, tried in that order) into a TraceRow;
 * seq = firstSeq + index; ts = record.ts, else updatedAt, else createdAt, else the
 * previous row's ts. Throws TypeError on an unknown record.
 */
export function rowsFromPipelineRecords(
  records: readonly unknown[],
  options: PipelineRowOptions = {},
): TraceRow[] {
  const firstSeq = options.firstSeq ?? 1;
  if (!Number.isInteger(firstSeq) || firstSeq < 1) {
    throw new RangeError(`firstSeq must be a positive integer, got ${String(firstSeq)}`);
  }
  const rows: TraceRow[] = [];
  let previousTs = "";
  records.forEach((record, index) => {
    const kind = RECORD_KINDS.find((candidate) => candidate.schema.safeParse(record).success);
    if (kind === undefined) {
      throw new TypeError(`record ${index} matches no pipeline schema: ${JSON.stringify(record)?.slice(0, 80)}`);
    }
    const ts =
      stringField(record, "ts") ?? stringField(record, "updatedAt") ?? stringField(record, "createdAt") ?? previousTs;
    previousTs = ts;
    const row: TraceRow = { seq: firstSeq + index, type: kind.type, ts, payload: record };
    if (kind.type === "evidence_fact" && options.factId !== undefined) {
      row.factId = options.factId(record as EvidenceFact);
    }
    rows.push(row);
  });
  return rows;
}
```

- [ ] **Step 5: Write the fixture harness**

`REPO_ROOT` resolves `src/test-support` → `src` → `trace-viewer` → `packages` → the worktree root, where `fixtures/` lives.

Create `packages/trace-viewer/src/test-support/fixture-rows.ts`:

```ts
// Test-only: loads fixtures/<name>/events.jsonl through the real semantic pipeline.
// Excluded from the build (tsconfig.build.json) and from the model import bans.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { EvidenceFact, TraceRow, TraceSessionSummary } from "@jevcode/contracts";
import { factContentId, parseReplayLine, PipelineCoordinator } from "@jevcode/semantic-core";

import { normalizeCommand } from "../model/format.js";
import { rowsFromPipelineRecords } from "../model/rows.js";

export const FIXTURE_NAMES = ["oauth", "rate-limit", "schema-change", "api-break", "dep-change"] as const;

export type FixtureName = (typeof FIXTURE_NAMES)[number];

export interface FixtureTrace {
  meta: TraceSessionSummary;
  rows: TraceRow[];
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

export function fixtureEventsPath(name: FixtureName): string {
  return path.join(REPO_ROOT, "fixtures", name, "events.jsonl");
}

export function fixtureLines(name: FixtureName): string[] {
  return readFileSync(fixtureEventsPath(name), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
}

function field(payload: unknown, key: string): unknown {
  return payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>)[key] : undefined;
}

/**
 * Reads fixtures/<name>/events.jsonl, parses each line with parseReplayLine, ingests all
 * records into a PipelineCoordinator, flushes, and returns the records' rows
 * (factId = factContentId) followed by one change_unit row per snapshot unit and one
 * validation row per snapshot validation. meta.state = "completed".
 */
export function loadFixtureTrace(name: FixtureName): FixtureTrace {
  const records = fixtureLines(name).map((line, index) => {
    const record = parseReplayLine(line);
    if (record === null) throw new Error(`${name}: line ${index + 1} is empty`);
    return record;
  });
  const coordinator = new PipelineCoordinator();
  for (const record of records) coordinator.ingest(record);
  coordinator.flush();
  const snapshot = coordinator.snapshot();
  const recordRows = rowsFromPipelineRecords(records, {
    factId: (fact: EvidenceFact) => factContentId(fact.sessionId, fact),
  });
  const derivedRows = rowsFromPipelineRecords([...snapshot.units, ...snapshot.validations], {
    firstSeq: recordRows.length + 1,
  });
  const rows = [...recordRows, ...derivedRows];
  const first = rows[0];
  const last = rows[recordRows.length - 1];
  if (first === undefined || last === undefined) throw new Error(`${name}: fixture has no records`);
  const started = records.find((record) => field(record, "type") === "agent_started");
  const repoId = records.map((record) => field(record, "repoId")).find((value) => typeof value === "string");
  const meta: TraceSessionSummary = {
    sessionId: String(field(first.payload, "sessionId")),
    repoId: typeof repoId === "string" ? repoId : `repo-${name}`,
    repoName: name,
    prompt: String(field(started, "prompt") ?? ""),
    state: "completed",
    startedAt: first.ts,
    endedAt: last.ts,
    lastEventSeq: rows.length,
  };
  return { meta, rows };
}

// ------------------------------------------------------------ capture-field variants

const CAPTURE_EVENT_KEYS = ["turnId", "callId"] as const;

/** The rows as a session recorded before M1 would store them (D11): no turnId, callId,
 *  sourceCallId, factId or agentCallIds. */
export function stripCaptureFields(rows: readonly TraceRow[]): TraceRow[] {
  return rows.map((row) => {
    const { factId: _factId, ...rest } = row;
    const payload = row.payload;
    if (payload === null || typeof payload !== "object") return { ...rest };
    const copy = { ...(payload as Record<string, unknown>) };
    if (row.type === "agent_event") for (const key of CAPTURE_EVENT_KEYS) delete copy[key];
    if (row.type === "evidence_fact") delete copy["sourceCallId"];
    if (row.type === "change_unit") delete copy["agentCallIds"];
    return { ...rest, payload: copy };
  });
}

const CALL_FAMILY: Readonly<Record<string, { family: string; role: "start" | "complete" }>> = {
  command_started: { family: "command", role: "start" },
  command_completed: { family: "command", role: "complete" },
  tool_started: { family: "tool", role: "start" },
  tool_completed: { family: "tool", role: "complete" },
};

/** The rows as M1 capture (A1-9) would store them: every agent event carries turnId,
 *  start/complete pairs share callId `${turnId}:item_<n>`, and command_executed /
 *  test_result facts carry the sourceCallId of the latest same-command call. Fields
 *  already present are kept. */
export function addCaptureFields(rows: readonly TraceRow[]): TraceRow[] {
  let turn = 0;
  let item = 0;
  const open = new Map<string, string[]>();
  const latestCallByCommand = new Map<string, string>();
  return rows.map((row) => {
    const payload = row.payload;
    if (payload === null || typeof payload !== "object") return { ...row };
    const copy = { ...(payload as Record<string, unknown>) };
    if (row.type === "agent_event") {
      const type = String(copy["type"]);
      if (type === "agent_started") {
        turn += 1;
        open.clear();
      }
      const turnId = typeof copy["turnId"] === "string" ? copy["turnId"] : `turn-${Math.max(turn, 1)}`;
      copy["turnId"] = turnId;
      const family = CALL_FAMILY[type];
      if (family !== undefined) {
        const target = String(copy["command"] ?? copy["tool"] ?? "");
        const key = `${family.family}\u0000${normalizeCommand(target)}`;
        if (family.role === "start") {
          item += 1;
          const callId = typeof copy["callId"] === "string" ? copy["callId"] : `${turnId}:item_${item}`;
          copy["callId"] = callId;
          open.set(key, [...(open.get(key) ?? []), callId]);
          if (family.family === "command") latestCallByCommand.set(normalizeCommand(target), callId);
        } else {
          const queue = open.get(key) ?? [];
          const callId = typeof copy["callId"] === "string" ? copy["callId"] : queue[0];
          if (callId !== undefined) copy["callId"] = callId;
          open.set(key, queue.filter((candidate) => candidate !== callId));
        }
      }
    }
    if (row.type === "evidence_fact") {
      const type = String(copy["type"]);
      if ((type === "command_executed" || type === "test_result") && typeof copy["sourceCallId"] !== "string") {
        const callId = latestCallByCommand.get(normalizeCommand(String(copy["command"] ?? "")));
        if (callId !== undefined) copy["sourceCallId"] = callId;
      }
    }
    return { ...row, payload: copy };
  });
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/model/registry.test.ts src/model/rows.test.ts`

Expected: `Test Files  2 passed (2)`, `Tests  41 passed (41)` (registry 32, rows 9).

If `rows.test.ts` fails with `Cannot find module '@jevcode/semantic-core'` or reports stale behavior, run `pnpm --filter @jevcode/semantic-core build` and rerun.

- [ ] **Step 7: Export from the model barrel**

In `packages/trace-viewer/src/model/index.ts`, find:

```ts
export * from "./format.js";
```

Replace it with:

```ts
export * from "./format.js";
export * from "./registry.js";
export * from "./rows.js";
```

Run: `pnpm --filter @jevcode/trace-viewer typecheck`

Expected: exits 0.

- [ ] **Step 8: Root checks**

Run, in order, from `/Users/jwpark/Projects/jevcode-tv-b`:

```bash
pnpm -r build
pnpm -r typecheck
pnpm -r --workspace-concurrency=1 test
pnpm lint
```

Expected: each command exits 0. `pnpm -r build` includes `jevcode-trace-viewer-dev`, whose Vite plugin fails the build if any module reachable from `@jevcode/trace-viewer/model` imports a Node built-in (the browser-safety proof). `pnpm lint` prints nothing after `> pnpm exec eslint .`.

- [ ] **Step 9: Commit**

```bash
git add packages/trace-viewer/src/model/registry.ts \
  packages/trace-viewer/src/model/registry.test.ts \
  packages/trace-viewer/src/model/rows.ts \
  packages/trace-viewer/src/model/rows.test.ts \
  packages/trace-viewer/src/test-support/fixture-rows.ts \
  packages/trace-viewer/src/model/index.ts
git commit -m "feat(trace-viewer): add rule registries, pipeline row adapter and fixture harness"
```

### Task B-3: Fold core: state, seq handling, gaps, hidden counts, turns, agent steps, pairing, display clock

**Files:**
- Create: `packages/trace-viewer/src/model/fold-state.ts`, `packages/trace-viewer/src/model/fold-agent.ts`, `packages/trace-viewer/src/model/fold.ts`, `packages/trace-viewer/src/test-support/trace-builder.ts`
- Test: `packages/trace-viewer/src/model/fold.test.ts`
- Modify: `packages/trace-viewer/src/model/index.ts` (append one line)

**Interfaces:**
- Consumes: B-1 `agentEventLabel(event)`, `normalizeCommand(command)`, `stepHeadline(input: StepHeadlineInput)`. B-2 `KIND_META`, `ENVELOPE_RULES`, `commandKind(command)`, `isLockfilePath(path)`. From `@jevcode/contracts`: `EVENT_TYPES`, `matchDestructive(command: string): DestructivePattern | null` (`{name, pattern}`), the six row schemas, `type TraceRow`, `type TraceSessionSummary`, `type AgentState`, `type AgentInterruptReason`, `type NormalizedAgentEvent`, `type NormalizedAgentEventType`, `type EventStoreType`. From `./types.js`: `TRACE_SCHEMA_VERSION`, `CAPABILITIES`, `SIGNAL_IDS`, `stepStableId(firstSeq: number): StepId`, and the types `Step`, `Turn`, `TurnOutcome`, `TurnTrigger`, `StepStatus`, `StepKind`, `Actor`, `Gap`, `GapKind`, `Capability`, `Coverage`, `TraceSession`.
- Produces:
  - `fold.ts` (public, index §2.6): `interface TraceState { readonly meta: TraceSessionSummary; readonly loadedThroughSeq: number; readonly received: number }`; `interface FinalizeOptions { live: boolean; state?: AgentState; throughSeq?: number; nowMs?: number }` (`nowMs` from UI index §1.4 B-3: epoch ms from `TraceSource.now()`; with `live`, a `running` step gets `durationMs = max(0, nowMs − startMs)`); `createTraceState(meta: TraceSessionSummary): TraceState`; `accumulate(state: TraceState, row: TraceRow): TraceState`; `accumulateAll(state: TraceState, rows: readonly TraceRow[]): TraceState`; `finalize(state: TraceState, options: FinalizeOptions): TraceSession`; `foldRows(meta: TraceSessionSummary, rows: readonly TraceRow[], options: FinalizeOptions): TraceSession`. In this task `finalize` returns `chapters: []`, `entities: []`, `findings: []` and a coverage whose signals all read inactive; B-4 to B-7 fill them.
  - `fold-state.ts` (internal, used by B-4 to B-7): `interface RowContext { seq: number; sourceTs: string; t: number }`; `interface DisplayClock { origin: number; last: number }`; `createClock(): DisplayClock`; `advanceClock(clock: DisplayClock, ts: string): number`; `clockTs(clock: DisplayClock, t: number, fallback: string): string`; `type CallFamily = "tool" | "command" | "test"`; `interface StepDraft extends Step { open: boolean; family: CallFamily | null; source: string; label: string | null }`; `interface QueueEntry { step: StepDraft; nested: boolean }`; `interface TerminalEvent { type: "agent_completed" | "agent_failed" | "agent_interrupted"; reason?: AgentInterruptReason }`; `interface TurnDraft { index; trigger; prompt; turnId; started; startSeq; endSeq; startTs; endTs; tMs; endTMs; stepIds; terminal: TerminalEvent | null; lastAgentEvent; readonly queues: Map<string, QueueEntry[]>; readonly commands: Map<string, StepDraft>; readonly edits: Map<string, StepDraft> }`; `class FoldState { loadedThroughSeq; received; maxSeq; readonly seen: Set<number>; readonly gaps: Gap[]; readonly hidden: Partial<Record<EventStoreType, number>>; readonly capabilities: Set<Capability>; readonly clock: DisplayClock; readonly steps: StepDraft[]; readonly stepById: Map<StepId, StepDraft>; readonly stepsByCallId: Map<string, StepDraft>; readonly turns: TurnDraft[]; constructor(readonly meta: TraceSessionSummary) }`; `addGap(state, kind: GapKind, atSeq: number, message: string): void`; `openTurn(state, ctx, init: { started: boolean; prompt: string; turnId: string | undefined }): TurnDraft`; `currentTurn(state, ctx): TurnDraft`; `touchTurn(turn, ctx): void`; `interface StepInit { kind; source; status; actor?; target?; text?; callId?; label?; approxTime? }`; `createStep(state, turn, ctx, init: StepInit): StepDraft`; `addRowToStep(step, ctx, evidence: boolean): void`; `setKind(step, kind: StepKind): void`.
  - `fold-agent.ts` (internal): `foldAgentEvent(state: FoldState, event: NormalizedAgentEvent, ctx: RowContext): void`.
  - R25 (W0-6 declares the field): every `Step` carries `startMs`, from `sourceMs(clock: DisplayClock, ctx: RowContext): number` in `fold-state.ts` (the parsed source time, else origin + t, else t; never `NaN`).
  - UI index §1.4 B-3 (W0-6 declares the fields per UI index §1.2): `TraceSession.originMs` (the clock origin: the first clock row's source time, else `Date.parse(meta.startedAt)`, else 0; never `NaN`), and `CommandDetail.outputTail` on steps closed by a `command_completed` (the last 20 lines of stdout then stderr, trailing blank lines dropped, `\r\n` read as `\n`, at most 2,048 UTF-16 code units, never starting on a low surrogate; unset when both streams are empty). The model stores the raw tail; the UI renders it through `displayUntrusted(tail, { multiline: true })`.
  - `test-support/trace-builder.ts` (test-only, used by B-4 to B-7 and B-10 tests): `SESSION_ID = "sess-test"`, `REPO_ID = "repo-test"`, `T0_ISO = "2026-09-18T09:00:00.000Z"`, `testMeta(overrides?: Partial<TraceSessionSummary>): TraceSessionSummary`; `class TraceBuilder { readonly rows: TraceRow[]; static at(seconds: number): string; raw(type: string, payload: unknown, ts?: string, extra?: Partial<TraceRow>): number; agent(input: AgentInput): number; fact(input: FactInput, factId?: string): number; unit(input: UnitInput): number; decision(input: DecisionInput): number; validation(input: ValidationInput): number; jev(input: JevInput): number }` (each method appends one row with the next seq and, without an explicit ts, `ts = T0 + (seq − 1) s`, and returns the seq).

Fold rules this task implements (index §2.6, R8, R10, spec §6.5): seq handling (repeat skipped silently; a lower new seq is an `out_of_order` gap; a bad payload is an `invalid_row` gap naming the first failing path; an unknown type is an `unknown_row_type` gap; `graph_*`, `telemetry`, `ui_*`, `failure`, `command` and `semantic_event` rows only counted in `hidden.byType`); turns split on `agent_started`, rows before the first `agent_started` open an implicit turn that the first start adopts; pairing by `callId` (`observed`), else FIFO per family and normalized target within the turn (`inferred`), never across two different `callId`s; `test_started`/`test_completed` inside an open same-command command step fold into it; a completion with no start is a step of its own; command status from exit code (`0` ok, `> 0` failed, `< 0` unknown); open starts become `unknown` plus an `unpaired` gap unless live in the last turn (`running`, lasting `nowMs − startMs` when `nowMs` is given); the display clock and `originMs` (spec §6.5); `outputTail` from `command_completed`.

- [ ] **Step 1: Write the test row builder**

This file is test-only support (deviation 2); it has no test of its own and is exercised by every fold test.

Create `packages/trace-viewer/src/test-support/trace-builder.ts`:

```ts
// Test-only: builds TraceRow sequences for model unit tests. Excluded from the build.
import type {
  ChangeUnit,
  Decision,
  EvidenceFact,
  JevDecisionLog,
  NormalizedAgentEvent,
  TraceRow,
  TraceSessionSummary,
  ValidationResult,
} from "@jevcode/contracts";

export const SESSION_ID = "sess-test";
export const REPO_ID = "repo-test";
export const T0_ISO = "2026-09-18T09:00:00.000Z";
const T0 = Date.parse(T0_ISO);

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type AgentInput = DistributiveOmit<NormalizedAgentEvent, "sessionId" | "ts"> & { ts?: string };
export type FactInput = DistributiveOmit<EvidenceFact, "sessionId" | "ts" | "repoId"> & { ts?: string };
export type UnitInput = Partial<ChangeUnit> & Pick<ChangeUnit, "id" | "files">;
export type DecisionInput = Partial<Decision> & Pick<Decision, "id">;
export type ValidationInput = Omit<ValidationResult, "ts"> & { ts?: string };
export type JevInput = Partial<JevDecisionLog> & Pick<JevDecisionLog, "id" | "clamps">;

export function testMeta(overrides: Partial<TraceSessionSummary> = {}): TraceSessionSummary {
  return {
    sessionId: SESSION_ID,
    repoId: REPO_ID,
    repoName: "test",
    prompt: "Test task",
    state: "completed",
    startedAt: T0_ISO,
    endedAt: null,
    lastEventSeq: 0,
    ...overrides,
  };
}

/** Appends rows with seq 1, 2, 3, … and, unless a ts is given, ts = T0 + (seq - 1) s. */
export class TraceBuilder {
  readonly rows: TraceRow[] = [];

  /** ISO ts `seconds` after T0. */
  static at(seconds: number): string {
    return new Date(T0 + seconds * 1000).toISOString();
  }

  private nextTs(ts: string | undefined): string {
    return ts ?? new Date(T0 + this.rows.length * 1000).toISOString();
  }

  raw(type: string, payload: unknown, ts?: string, extra: Partial<TraceRow> = {}): number {
    const seq = this.rows.length + 1;
    this.rows.push({ seq, type, ts: this.nextTs(ts), payload, ...extra });
    return seq;
  }

  agent(input: AgentInput): number {
    const ts = this.nextTs(input.ts);
    return this.raw("agent_event", { ...input, sessionId: SESSION_ID, ts }, ts);
  }

  fact(input: FactInput, factId?: string): number {
    const ts = this.nextTs(input.ts);
    return this.raw(
      "evidence_fact",
      { ...input, repoId: REPO_ID, sessionId: SESSION_ID, ts },
      ts,
      factId !== undefined ? { factId } : {},
    );
  }

  unit(input: UnitInput): number {
    const ts = this.nextTs(input.updatedAt);
    const unit: ChangeUnit = {
      sessionId: SESSION_ID,
      title: `Unit ${input.id}`,
      category: "implementation",
      status: "in_progress",
      symbols: [],
      interfacesChanged: [],
      schemaChanges: [],
      dependencyChanges: [],
      relatedDecisions: [],
      validationResults: [],
      evidence: [],
      createdAt: ts,
      updatedAt: ts,
      ...input,
    };
    return this.raw("change_unit", unit, ts);
  }

  decision(input: DecisionInput): number {
    const decision: Decision = {
      sessionId: SESSION_ID,
      title: `Decision ${input.id}`,
      context: "",
      severity: "required",
      options: [
        { id: "a", label: "Option A", description: "" },
        { id: "b", label: "Option B", description: "" },
      ],
      affectedChangeUnits: [],
      evidence: [],
      status: "open",
      ...input,
    };
    return this.raw("decision", decision, this.nextTs(input.ts));
  }

  validation(input: ValidationInput): number {
    const ts = this.nextTs(input.ts);
    return this.raw("validation", { ...input, ts }, ts);
  }

  jev(input: JevInput): number {
    const ts = this.nextTs(input.ts);
    const log: JevDecisionLog = {
      sessionId: SESSION_ID,
      inputHash: "hash",
      output: {},
      confidence: 0.9,
      latencyMs: 10,
      clientKind: "typesafe",
      ...input,
      ts,
    };
    return this.raw("jev_decision", log, ts);
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/trace-viewer/src/model/fold.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { loadFixtureTrace } from "../test-support/fixture-rows.js";
import { TraceBuilder, testMeta } from "../test-support/trace-builder.js";
import { accumulate, accumulateAll, createTraceState, finalize, foldRows } from "./fold.js";
import type { Step, TraceSession } from "./types.js";

function fold(builder: TraceBuilder, live = false): TraceSession {
  return foldRows(testMeta(), builder.rows, { live });
}

function stepAt(session: TraceSession, seq: number): Step {
  const step = session.steps.find((candidate) => candidate.firstSeq === seq);
  if (step === undefined) throw new Error(`no step starts at seq ${seq}`);
  return step;
}

describe("fold: seq handling and gaps", () => {
  it("folds an empty session", () => {
    const session = foldRows(testMeta(), [], { live: false });
    expect(session.schemaVersion).toBe(1);
    expect(session.steps).toEqual([]);
    expect(session.turns).toEqual([]);
    expect(session.loadedThroughSeq).toBe(0);
    // No clock row yet: the origin falls back to meta.startedAt (spec §6.5).
    expect(session.originMs).toBe(Date.parse(testMeta().startedAt));
    expect(session.coverage.signals.map((signal) => signal.id)).toEqual([
      "claim_contradicted",
      "failing_tests",
      "destructive_command",
      "guardrail_clamp",
      "recovery_arc",
    ]);
  });

  it("skips a seq it already folded", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "agent_message", role: "assistant", text: "hello" });
    const once = fold(b);
    const state = accumulateAll(createTraceState(testMeta()), b.rows);
    accumulate(state, b.rows[1] as (typeof b.rows)[number]);
    expect(finalize(state, { live: false })).toEqual(once);
  });

  it("records a lower new seq as out_of_order and skips it", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "agent_message", role: "assistant", text: "late" });
    b.agent({ type: "agent_message", role: "assistant", text: "early" });
    const [first, second, third] = b.rows;
    if (first === undefined || second === undefined || third === undefined) throw new Error("rows");
    const session = foldRows(testMeta(), [first, third, second], { live: false });
    expect(session.gaps).toEqual([expect.objectContaining({ kind: "out_of_order", atSeq: 2 })]);
    expect(session.steps.map((step) => step.firstSeq)).toEqual([1, 3]);
  });

  it("records a corrupt payload as invalid_row and keeps folding", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.raw("agent_event", { type: "command_started", sessionId: "s" });
    b.raw("agent_event", undefined);
    b.agent({ type: "agent_message", role: "assistant", text: "still here" });
    const session = fold(b);
    expect(session.gaps.map((gap) => [gap.kind, gap.atSeq])).toEqual([
      ["invalid_row", 2],
      ["invalid_row", 3],
    ]);
    expect(stepAt(session, 4).text).toBe("still here");
  });

  it("records an unknown row type and counts hidden envelope types", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.raw("future_row", { anything: true });
    b.raw("telemetry", { name: "x" });
    b.raw("graph_node", { id: "n" });
    b.raw("graph_node", { id: "m" });
    const session = foldRows(testMeta(), b.rows, { live: false, throughSeq: 9 });
    expect(session.gaps).toEqual([expect.objectContaining({ kind: "unknown_row_type", atSeq: 2 })]);
    expect(session.hidden.byType).toEqual({ telemetry: 1, graph_node: 2 });
    expect(session.loadedThroughSeq).toBe(9);
    expect(session.hidden.unreceived).toBe(4);
  });

  it("uses the page state over meta.state", () => {
    const session = foldRows(testMeta({ state: "running" }), [], { live: true, state: "paused" });
    expect(session.meta.state).toBe("paused");
    expect(session.live).toBe(true);
  });
});

describe("fold: turns and agent steps", () => {
  it("pairs a start and completion by callId as observed", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p", turnId: "t1" });
    b.agent({ type: "command_started", command: "pnpm lint", callId: "t1:item_1", turnId: "t1" });
    b.agent({ type: "command_started", command: "pnpm lint", callId: "t1:item_2", turnId: "t1" });
    b.agent({ type: "command_completed", command: "pnpm lint", exitCode: 0, stdout: "", stderr: "", callId: "t1:item_2", turnId: "t1" });
    b.agent({ type: "command_completed", command: "pnpm lint", exitCode: 3, stdout: "", stderr: "", callId: "t1:item_1", turnId: "t1" });
    const session = fold(b);
    const first = stepAt(session, 2);
    const second = stepAt(session, 3);
    expect(first).toMatchObject({ provenance: "observed", callId: "t1:item_1", seqs: [2, 5], status: "failed" });
    expect(second).toMatchObject({ provenance: "observed", callId: "t1:item_2", seqs: [3, 4], status: "ok" });
    expect(first.command?.exitCode).toBe(3);
    expect(session.turns[0]).toMatchObject({ turnId: "t1", trigger: "initial" });
  });

  it("pairs by family and target in FIFO order as inferred when there is no callId", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "tool_started", tool: "read_file", input: "a.ts" });
    b.agent({ type: "tool_started", tool: "read_file", input: "b.ts" });
    b.agent({ type: "tool_completed", tool: "read_file", output: "a" });
    b.agent({ type: "tool_completed", tool: "read_file", output: "b" });
    const session = fold(b);
    expect(stepAt(session, 2)).toMatchObject({ kind: "tool", provenance: "inferred", seqs: [2, 4], status: "ok" });
    expect(stepAt(session, 3)).toMatchObject({ kind: "tool", provenance: "inferred", seqs: [3, 5], status: "ok" });
  });

  it("never pairs two different callIds", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "command_started", command: "make", callId: "x" });
    b.agent({ type: "command_completed", command: "make", exitCode: 0, stdout: "", stderr: "", callId: "y" });
    const session = fold(b);
    expect(stepAt(session, 2)).toMatchObject({ status: "unknown", seqs: [2] });
    expect(stepAt(session, 3)).toMatchObject({ status: "ok", callId: "y", seqs: [3] });
    expect(session.gaps).toEqual([expect.objectContaining({ kind: "unpaired", atSeq: 2 })]);
  });

  it("folds test_started and test_completed into the enclosing command", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "command_started", command: "pnpm  test" });
    b.agent({ type: "test_started", command: "pnpm test" });
    b.agent({ type: "test_completed", command: "pnpm test", exitCode: 1 });
    b.agent({ type: "command_completed", command: "pnpm test", exitCode: 1, stdout: "", stderr: "" });
    const session = fold(b);
    expect(session.steps.filter((step) => step.kind !== "instruction")).toHaveLength(1);
    expect(stepAt(session, 2)).toMatchObject({ kind: "test", lane: "tests", seqs: [2, 3, 4, 5], status: "failed" });
  });

  it("maps exit codes: 0 ok, positive failed, -1 unknown", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    for (const exitCode of [0, 2, -1]) {
      b.agent({ type: "command_started", command: `run ${exitCode}` });
      b.agent({ type: "command_completed", command: `run ${exitCode}`, exitCode, stdout: "", stderr: "" });
    }
    const session = fold(b);
    expect([2, 4, 6].map((seq) => stepAt(session, seq).status)).toEqual(["ok", "failed", "unknown"]);
    expect(stepAt(session, 6).problems).not.toContain("exit_nonzero");
    expect(stepAt(session, 6).headline).toBe("run -1");
  });

  it("interrupted turn leaves the open command unknown", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "build it" });
    b.agent({ type: "command_started", command: "pnpm build" });
    b.agent({ type: "agent_interrupted", reason: "steer" });
    b.agent({ type: "agent_started", prompt: "use the other API" });
    const session = fold(b);
    const command = stepAt(session, 2);
    expect(command).toMatchObject({ status: "unknown", endTs: null, durationMs: null });
    expect(command.problems).toEqual([]);
    expect(session.turns.map((turn) => [turn.trigger, turn.outcome, turn.interruptReason])).toEqual([
      ["initial", "interrupted", "steer"],
      ["steer", "unknown", undefined],
    ]);
    expect(session.steps.flatMap((step) => step.problems)).not.toContain("agent_failed");
    expect(session.gaps).toEqual([expect.objectContaining({ kind: "unpaired", atSeq: 2 })]);
  });

  it("marks a turn resumed after a completed one and interrupted when it has no terminal event", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "one" });
    b.agent({ type: "agent_completed" });
    b.agent({ type: "agent_started", prompt: "two" });
    b.agent({ type: "agent_started", prompt: "three" });
    b.agent({ type: "agent_failed", error: "resume budget exhausted" });
    const session = fold(b);
    expect(session.turns.map((turn) => [turn.trigger, turn.outcome])).toEqual([
      ["initial", "completed"],
      ["resume", "interrupted"],
      ["steer", "failed"],
    ]);
    expect(stepAt(session, 5)).toMatchObject({ kind: "lifecycle", status: "failed", headline: "Stopped: resume budget exhausted" });
  });

  it("keeps open work running only at the live edge", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "command_started", command: "pnpm install" });
    const live = fold(b, true);
    expect(stepAt(live, 2)).toMatchObject({ status: "running", endTMs: null, headline: "Running pnpm install" });
    expect(live.turns[0]?.outcome).toBe("running");
    expect(live.gaps).toEqual([]);
    b.agent({ type: "agent_waiting" });
    expect(fold(b, true).turns[0]?.outcome).toBe("waiting");
    expect(fold(b, false).turns[0]?.outcome).toBe("unknown");
  });

  it("adopts rows that arrive before agent_started into the first turn", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_message", role: "assistant", text: "warming up" });
    b.agent({ type: "agent_started", prompt: "the task", turnId: "t9" });
    const session = fold(b);
    expect(session.turns).toHaveLength(1);
    expect(session.turns[0]).toMatchObject({ prompt: "the task", turnId: "t9", startSeq: 1, endSeq: 2 });
    expect(stepAt(session, 2)).toMatchObject({ kind: "instruction", lane: "supervisor", actor: "supervisor" });
  });

  it("starts the clock at the first agent row and keeps it monotonic when timestamps go backwards", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p", ts: TraceBuilder.at(10) });
    b.agent({ type: "agent_message", role: "assistant", text: "a", ts: TraceBuilder.at(5) });
    b.agent({ type: "agent_message", role: "assistant", text: "b", ts: "not a date" });
    b.agent({ type: "agent_message", role: "assistant", text: "c", ts: TraceBuilder.at(12) });
    // meta.startedAt is the replay run's wall clock in replay.db, days after the source times.
    const session = foldRows(testMeta({ startedAt: "2026-09-21T00:00:00.000Z" }), b.rows, { live: false });
    expect(session.steps.map((step) => step.tMs)).toEqual([0, 0, 0, 2_000]);
    expect(session.span).toEqual({ startTs: TraceBuilder.at(10), endTs: TraceBuilder.at(12), durationMs: 2_000 });
    expect(session.steps[2]?.startTs).toBe("not a date");
    // startMs (R25) is the unclamped source time; a ts that does not parse gets origin + clock.
    expect(session.steps.map((step) => step.startMs)).toEqual(
      [10, 5, 10, 12].map((seconds) => Date.parse(TraceBuilder.at(seconds))),
    );
    expect(session.originMs).toBe(Date.parse(TraceBuilder.at(10)));
  });

  it("starts oauth's display clock at its first agent row and derives every tMs from startMs", () => {
    const trace = loadFixtureTrace("oauth");
    const session = foldRows(trace.meta, trace.rows, { live: false });
    const first = trace.rows.find((row) => row.type === "agent_event");
    const firstMs = Date.parse(String((first?.payload as { ts?: unknown } | undefined)?.ts));
    expect(Number.isNaN(firstMs)).toBe(false);
    expect(session.steps[0]?.startMs).toBe(firstMs);
    expect(session.originMs).toBe(firstMs);
    // spec §6.5: tMs = max(startMs - originMs, tMs of the previous step in seq order, 0).
    let previous = 0;
    for (const step of session.steps) {
      expect(step.tMs, step.id).toBe(Math.max(step.startMs - session.originMs, previous, 0));
      previous = step.tMs;
    }
  });

  it("keeps the last 20 lines of stdout then stderr as the output tail", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const stdout = `${Array.from({ length: 25 }, (_, index) => `out ${index + 1}`).join("\r\n")}\r\n`;
    const noisy = b.agent({ type: "command_started", command: "make all" });
    b.agent({ type: "command_completed", command: "make all", exitCode: 1, stdout, stderr: "err 1\nerr 2\n\n" });
    const quiet = b.agent({ type: "command_started", command: "true" });
    b.agent({ type: "command_completed", command: "true", exitCode: 0, stdout: "", stderr: "" });
    const long = b.agent({ type: "command_started", command: "cat big.log" });
    b.agent({ type: "command_completed", command: "cat big.log", exitCode: 0, stdout: "x".repeat(5_000), stderr: "" });
    const session = fold(b);
    const expected = [...Array.from({ length: 18 }, (_, index) => `out ${index + 8}`), "err 1", "err 2"].join("\n");
    expect(stepAt(session, noisy).command?.outputTail).toBe(expected);
    expect(stepAt(session, quiet).command).not.toHaveProperty("outputTail");
    expect(stepAt(session, long).command?.outputTail).toBe("x".repeat(2_048));
  });

  it("gives an open step at the live edge a duration up to nowMs", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const run = b.agent({ type: "command_started", command: "pnpm install" });
    const startMs = Date.parse(TraceBuilder.at(run - 1));
    const live = foldRows(testMeta(), b.rows, { live: true, nowMs: startMs + 4_000 });
    expect(stepAt(live, run)).toMatchObject({ status: "running", startMs, durationMs: 4_000, endTMs: null });
    expect(stepAt(foldRows(testMeta(), b.rows, { live: true }), run).durationMs).toBeNull();
    expect(stepAt(foldRows(testMeta(), b.rows, { live: false, nowMs: startMs + 4_000 }), run)).toMatchObject({
      status: "unknown",
      durationMs: null,
    });
  });

  it("never changes a returned session when more rows arrive", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "command_started", command: "pnpm test" });
    const state = accumulateAll(createTraceState(testMeta()), b.rows);
    const before = finalize(state, { live: true });
    const snapshot = structuredClone(before);
    accumulate(state, { seq: 3, type: "agent_event", ts: TraceBuilder.at(3), payload: {
      type: "command_completed", sessionId: "sess-test", ts: TraceBuilder.at(3), command: "pnpm test", exitCode: 0, stdout: "", stderr: "",
    } });
    expect(before).toEqual(snapshot);
    expect(finalize(state, { live: true }).steps[1]?.status).toBe("ok");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/model/fold.test.ts`

Expected: FAIL, `Error: Cannot find module './fold.js' imported from '…/src/model/fold.test.ts'`, `Tests  no tests`.

- [ ] **Step 4: Write the internal fold state**

Create `packages/trace-viewer/src/model/fold-state.ts` (B-4 and B-5 add their state to this file):

```ts
import type {
  AgentInterruptReason,
  EventStoreType,
  NormalizedAgentEventType,
  TraceSessionSummary,
} from "@jevcode/contracts";

import { KIND_META } from "./registry.js";
import {
  stepStableId,
  type Actor,
  type Capability,
  type Gap,
  type GapKind,
  type Step,
  type StepId,
  type StepKind,
  type StepStatus,
  type TurnTrigger,
} from "./types.js";

// Internal fold state. Nothing here is exported from the model barrel.

/** Where a row lands on the display clock. */
export interface RowContext {
  seq: number;
  /** Source time: the payload ts of a clock row; origin + t for any other row. */
  sourceTs: string;
  /** Display clock: ms since the origin, never decreasing with seq. */
  t: number;
}

/**
 * The session clock (spec §6.5). Only agent_event and evidence_fact payload times move it; the
 * first of them is the origin. change_unit, decision, validation and jev_decision rows carry
 * pipeline processing times (in replay.db the replay run's wall clock, days after the source
 * times), so they inherit the current clock instead.
 */
export interface DisplayClock {
  /** Epoch ms of the first parseable clock-row time; NaN until one arrives. */
  origin: number;
  last: number;
}

export function createClock(): DisplayClock {
  return { origin: Number.NaN, last: 0 };
}

/** Advances the clock to a clock row's ts. A ts that goes backwards or does not parse keeps the last value. */
export function advanceClock(clock: DisplayClock, ts: string): number {
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return clock.last;
  if (Number.isNaN(clock.origin)) clock.origin = parsed;
  clock.last = Math.max(clock.last, parsed - clock.origin);
  return clock.last;
}

/** The ISO time of a clock offset, or the fallback while the clock has no origin. */
export function clockTs(clock: DisplayClock, t: number, fallback: string): string {
  return Number.isNaN(clock.origin) ? fallback : new Date(clock.origin + t).toISOString();
}

/** Step.startMs (R25): the parsed source time, else origin + t, else t while the clock has no
 *  origin. Never NaN. */
export function sourceMs(clock: DisplayClock, ctx: RowContext): number {
  const parsed = Date.parse(ctx.sourceTs);
  if (!Number.isNaN(parsed)) return parsed;
  return Number.isNaN(clock.origin) ? ctx.t : clock.origin + ctx.t;
}

export type CallFamily = "tool" | "command" | "test";

export interface StepDraft extends Step {
  /** A start whose completion has not arrived. */
  open: boolean;
  /** Start/complete family; null for point steps. */
  family: CallFamily | null;
  /** The row type that created the step: an agent event type, a fact type or an envelope type. */
  source: string;
  /** Headline text for lifecycle and guardrail steps (not public Step.text). */
  label: string | null;
}

export interface QueueEntry {
  step: StepDraft;
  /** A test_started folded into an enclosing command: its completion must not close the command. */
  nested: boolean;
}

export interface TerminalEvent {
  type: "agent_completed" | "agent_failed" | "agent_interrupted";
  reason?: AgentInterruptReason;
}

export interface TurnDraft {
  index: number;
  trigger: TurnTrigger;
  prompt: string;
  turnId: string | undefined;
  /** False for an implicit turn opened by rows that arrived before any agent_started. */
  started: boolean;
  startSeq: number;
  endSeq: number;
  startTs: string;
  endTs: string;
  tMs: number;
  endTMs: number;
  stepIds: StepId[];
  terminal: TerminalEvent | null;
  lastAgentEvent: NormalizedAgentEventType | null;
  /** Open starts, FIFO per `${family}\u0000${target}`. */
  readonly queues: Map<string, QueueEntry[]>;
  /** Latest command-like step per normalized command. */
  readonly commands: Map<string, StepDraft>;
  /** Latest edit step per path. */
  readonly edits: Map<string, StepDraft>;
}

export class FoldState {
  loadedThroughSeq = 0;
  received = 0;
  maxSeq = 0;
  readonly seen = new Set<number>();
  readonly gaps: Gap[] = [];
  readonly hidden: Partial<Record<EventStoreType, number>> = {};
  readonly capabilities = new Set<Capability>();
  readonly clock: DisplayClock;
  readonly steps: StepDraft[] = [];
  readonly stepById = new Map<StepId, StepDraft>();
  /** Every step that carries a callId (open or closed). */
  readonly stepsByCallId = new Map<string, StepDraft>();
  readonly turns: TurnDraft[] = [];

  constructor(readonly meta: TraceSessionSummary) {
    this.clock = createClock();
  }
}

export function addGap(state: FoldState, kind: GapKind, atSeq: number, message: string): void {
  state.gaps.push({ kind, atSeq, message });
}

function previousTrigger(previous: TurnDraft | undefined): TurnTrigger {
  if (previous === undefined) return "initial";
  const terminal = previous.terminal;
  if (terminal === null) return "steer";
  if (terminal.type === "agent_interrupted" && terminal.reason === "steer") return "steer";
  return "resume";
}

export function openTurn(
  state: FoldState,
  ctx: RowContext,
  init: { started: boolean; prompt: string; turnId: string | undefined },
): TurnDraft {
  const turn: TurnDraft = {
    index: state.turns.length,
    trigger: previousTrigger(state.turns[state.turns.length - 1]),
    prompt: init.prompt,
    turnId: init.turnId,
    started: init.started,
    startSeq: ctx.seq,
    endSeq: ctx.seq,
    startTs: ctx.sourceTs,
    endTs: ctx.sourceTs,
    tMs: ctx.t,
    endTMs: ctx.t,
    stepIds: [],
    terminal: null,
    lastAgentEvent: null,
    queues: new Map(),
    commands: new Map(),
    edits: new Map(),
  };
  state.turns.push(turn);
  return turn;
}

/** The turn a row belongs to: the latest one, or an implicit first turn. */
export function currentTurn(state: FoldState, ctx: RowContext): TurnDraft {
  const last = state.turns[state.turns.length - 1];
  if (last !== undefined) return last;
  return openTurn(state, ctx, { started: false, prompt: state.meta.prompt, turnId: undefined });
}

export function touchTurn(turn: TurnDraft, ctx: RowContext): void {
  turn.endSeq = Math.max(turn.endSeq, ctx.seq);
  turn.endTs = ctx.sourceTs;
  turn.endTMs = Math.max(turn.endTMs, ctx.t);
}

export interface StepInit {
  kind: StepKind;
  source: string;
  status: StepStatus;
  actor?: Actor;
  target?: string;
  text?: string;
  callId?: string;
  label?: string;
  approxTime?: boolean;
}

export function createStep(state: FoldState, turn: TurnDraft, ctx: RowContext, init: StepInit): StepDraft {
  const meta = KIND_META[init.kind];
  const step: StepDraft = {
    id: stepStableId(ctx.seq),
    kind: init.kind,
    lane: meta.lane,
    actor: init.actor ?? meta.actor,
    provenance: "observed",
    status: init.status,
    headline: "",
    ...(init.target !== undefined ? { target: init.target } : {}),
    ...(init.text !== undefined ? { text: init.text } : {}),
    ...(init.callId !== undefined ? { callId: init.callId } : {}),
    turnIndex: turn.index,
    seqs: [ctx.seq],
    firstSeq: ctx.seq,
    lastSeq: ctx.seq,
    startTs: ctx.sourceTs,
    endTs: ctx.sourceTs,
    tMs: ctx.t,
    startMs: sourceMs(state.clock, ctx),
    endTMs: ctx.t,
    durationMs: null,
    approxTime: init.approxTime ?? false,
    evidenceSeqs: [],
    chapterIds: [],
    entityIds: [],
    findingIds: [],
    problems: [],
    noise: null,
    open: false,
    family: null,
    source: init.source,
    label: init.label ?? null,
  };
  state.steps.push(step);
  state.stepById.set(step.id, step);
  turn.stepIds.push(step.id);
  if (init.callId !== undefined) state.stepsByCallId.set(init.callId, step);
  return step;
}

/** Folds one more row into a step. Rows arrive in ascending seq, so seqs stay sorted. */
export function addRowToStep(step: StepDraft, ctx: RowContext, evidence: boolean): void {
  step.seqs.push(ctx.seq);
  step.lastSeq = Math.max(step.lastSeq, ctx.seq);
  if (evidence) step.evidenceSeqs.push(ctx.seq);
}

/** Changes a step's kind and moves it to that kind's lane. */
export function setKind(step: StepDraft, kind: StepKind): void {
  step.kind = kind;
  step.lane = KIND_META[kind].lane;
}
```

- [ ] **Step 5: Write the agent-event fold**

Create `packages/trace-viewer/src/model/fold-agent.ts`:

```ts
import { matchDestructive, type NormalizedAgentEvent } from "@jevcode/contracts";

import { agentEventLabel, normalizeCommand } from "./format.js";
import {
  addRowToStep,
  createStep,
  currentTurn,
  openTurn,
  setKind,
  touchTurn,
  type CallFamily,
  type FoldState,
  type QueueEntry,
  type RowContext,
  type StepDraft,
  type TurnDraft,
} from "./fold-state.js";
import { commandKind, isLockfilePath } from "./registry.js";

function queueKey(family: CallFamily, target: string): string {
  return `${family}\u0000${target}`;
}

function enqueue(turn: TurnDraft, key: string, entry: QueueEntry): void {
  const queue = turn.queues.get(key);
  if (queue === undefined) turn.queues.set(key, [entry]);
  else queue.push(entry);
}

function removeFromQueue(turn: TurnDraft, key: string, step: StepDraft): void {
  const queue = turn.queues.get(key);
  if (queue === undefined) return;
  const index = queue.findIndex((entry) => entry.step === step && !entry.nested);
  if (index >= 0) queue.splice(index, 1);
}

function commandDetail(command: string): NonNullable<StepDraft["command"]> {
  const pattern = matchDestructive(command);
  return pattern === null ? { command, exitCode: null } : { command, exitCode: null, destructivePattern: pattern.name };
}

const OUTPUT_TAIL_LINES = 20;
const OUTPUT_TAIL_MAX = 2_048;

/** CommandDetail.outputTail (spec §6.2): the last 20 lines of stdout then stderr, at most 2,048
 *  UTF-16 code units, never starting on the low half of a surrogate pair. Left unset when both
 *  streams are empty. Raw text: the UI shows it through displayUntrusted(tail, { multiline: true }). */
function setOutputTail(detail: NonNullable<StepDraft["command"]>, stdout: string, stderr: string): void {
  const parts = [stdout, stderr]
    .map((part) => part.replace(/\r\n?/g, "\n").trimEnd())
    .filter((part) => part !== "");
  if (parts.length === 0) return;
  let tail = parts.join("\n").split("\n").slice(-OUTPUT_TAIL_LINES).join("\n");
  if (tail.length > OUTPUT_TAIL_MAX) {
    tail = tail.slice(tail.length - OUTPUT_TAIL_MAX);
    const first = tail.charCodeAt(0);
    if (first >= 0xdc00 && first <= 0xdfff) tail = tail.slice(1);
  }
  detail.outputTail = tail;
}

function latestOpenCommand(turn: TurnDraft, normalized: string): StepDraft | undefined {
  const queue = turn.queues.get(queueKey("command", normalized)) ?? [];
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    const entry = queue[index];
    if (entry !== undefined && !entry.nested && entry.step.open) return entry.step;
  }
  return undefined;
}

function openCall(
  state: FoldState,
  turn: TurnDraft,
  ctx: RowContext,
  event: Extract<NormalizedAgentEvent, { type: "tool_started" | "command_started" | "test_started" }>,
): void {
  if (event.type === "tool_started") {
    const step = createStep(state, turn, ctx, {
      kind: "tool",
      source: event.type,
      status: "running",
      target: event.tool,
      approxTime: true,
      ...(event.callId !== undefined ? { callId: event.callId } : {}),
    });
    step.open = true;
    step.family = "tool";
    enqueue(turn, queueKey("tool", event.tool), { step, nested: false });
    return;
  }
  const normalized = normalizeCommand(event.command);
  if (event.type === "test_started") {
    const host = latestOpenCommand(turn, normalized);
    if (host !== undefined) {
      // A test run inside the command that launched it: one step (fixtures/*/events.jsonl).
      addRowToStep(host, ctx, false);
      if (host.kind === "command") setKind(host, "test");
      enqueue(turn, queueKey("test", normalized), { step: host, nested: true });
      return;
    }
  }
  const family: CallFamily = event.type === "test_started" ? "test" : "command";
  const kind = commandKind(event.command);
  const step = createStep(state, turn, ctx, {
    kind: family === "test" && kind === "command" ? "test" : kind,
    source: event.type,
    status: "running",
    target: event.command,
    approxTime: true,
    ...(event.type === "command_started" && event.callId !== undefined ? { callId: event.callId } : {}),
  });
  step.open = true;
  step.family = family;
  step.command = commandDetail(event.command);
  enqueue(turn, queueKey(family, normalized), { step, nested: false });
  turn.commands.set(normalized, step);
}

function closeCall(
  state: FoldState,
  turn: TurnDraft,
  ctx: RowContext,
  event: Extract<NormalizedAgentEvent, { type: "tool_completed" | "command_completed" | "test_completed" }>,
): void {
  const family: CallFamily =
    event.type === "tool_completed" ? "tool" : event.type === "command_completed" ? "command" : "test";
  const target = event.type === "tool_completed" ? event.tool : normalizeCommand(event.command);
  const key = queueKey(family, target);
  const callId = event.type === "test_completed" ? undefined : event.callId;

  let step: StepDraft | undefined;
  let observed = false;
  if (callId !== undefined) {
    const byCall = state.stepsByCallId.get(callId);
    if (byCall !== undefined && byCall.open && byCall.family === family) {
      step = byCall;
      observed = true;
      removeFromQueue(turn, key, byCall);
    }
  }
  if (step === undefined) {
    const queue = turn.queues.get(key) ?? [];
    const index = queue.findIndex(
      (entry) =>
        (entry.nested || entry.step.open) &&
        (callId === undefined || entry.step.callId === undefined || entry.step.callId === callId),
    );
    const entry = index >= 0 ? queue[index] : undefined;
    if (entry !== undefined) {
      queue.splice(index, 1);
      if (entry.nested) {
        // test_completed inside its command: the command_completed closes the step.
        addRowToStep(entry.step, ctx, false);
        return;
      }
      step = entry.step;
    }
  }
  if (step === undefined) {
    // A completion with no start (history cut or never emitted): a closed step of its own.
    const kind = event.type === "tool_completed" ? "tool" : commandKind(event.command);
    const orphan = createStep(state, turn, ctx, {
      kind: family === "test" && kind === "command" ? "test" : kind,
      source: event.type,
      status: "ok",
      target: event.type === "tool_completed" ? event.tool : event.command,
      approxTime: true,
      ...(callId !== undefined ? { callId } : {}),
    });
    orphan.family = family;
    if (event.type !== "tool_completed") {
      orphan.command = { ...commandDetail(event.command), exitCode: event.exitCode };
      if (event.type === "command_completed") setOutputTail(orphan.command, event.stdout, event.stderr);
      turn.commands.set(target, orphan);
    }
    return;
  }
  addRowToStep(step, ctx, false);
  step.open = false;
  step.endTs = ctx.sourceTs;
  step.endTMs = ctx.t;
  step.durationMs = ctx.t - step.tMs;
  if (!observed) step.provenance = "inferred";
  if (callId !== undefined && step.callId === undefined) {
    step.callId = callId;
    state.stepsByCallId.set(callId, step);
  }
  if (event.type === "tool_completed") {
    step.status = "ok";
  } else if (step.command !== undefined) {
    step.command.exitCode = event.exitCode;
    if (event.type === "command_completed") setOutputTail(step.command, event.stdout, event.stderr);
  }
}

/** An agent file_changed is a claim. It joins the path's latest edit step in the turn when that step is not claimed yet. */
function foldClaim(
  state: FoldState,
  turn: TurnDraft,
  ctx: RowContext,
  event: Extract<NormalizedAgentEvent, { type: "file_changed" }>,
): void {
  const existing = turn.edits.get(event.path);
  if (existing !== undefined && existing.edit !== undefined && !existing.edit.claimed) {
    addRowToStep(existing, ctx, false);
    existing.edit.claimed = true;
    existing.actor = "agent";
    if (event.callId !== undefined && existing.callId === undefined) {
      existing.callId = event.callId;
      state.stepsByCallId.set(event.callId, existing);
    }
    return;
  }
  const step = createStep(state, turn, ctx, {
    kind: "edit",
    source: event.type,
    status: "ok",
    target: event.path,
    approxTime: true,
    ...(event.callId !== undefined ? { callId: event.callId } : {}),
  });
  step.edit = {
    path: event.path,
    added: 0,
    removed: 0,
    claimed: true,
    observed: false,
    diff: "none",
    lockfile: isLockfilePath(event.path),
    formattingOnly: false,
  };
  turn.edits.set(event.path, step);
}

export function foldAgentEvent(state: FoldState, event: NormalizedAgentEvent, ctx: RowContext): void {
  if ("callId" in event && event.callId !== undefined) state.capabilities.add("call_ids");
  if (event.type === "agent_started") {
    const last = state.turns[state.turns.length - 1];
    let turn: TurnDraft;
    if (last !== undefined && !last.started) {
      // Rows before the first agent_started opened an implicit turn; this start adopts it.
      last.started = true;
      last.prompt = event.prompt;
      last.turnId = event.turnId;
      turn = last;
    } else {
      turn = openTurn(state, ctx, { started: true, prompt: event.prompt, turnId: event.turnId });
    }
    touchTurn(turn, ctx);
    createStep(state, turn, ctx, {
      kind: "instruction",
      source: event.type,
      status: "info",
      actor: "supervisor",
      text: event.prompt,
      approxTime: true,
    });
    turn.lastAgentEvent = event.type;
    return;
  }
  const turn = currentTurn(state, ctx);
  touchTurn(turn, ctx);
  if (turn.turnId === undefined && event.turnId !== undefined) turn.turnId = event.turnId;
  switch (event.type) {
    case "agent_message":
      if (event.role === "assistant") state.capabilities.add("agent_messages");
      createStep(state, turn, ctx, {
        kind: event.role === "user" ? "instruction" : "message",
        source: event.type,
        status: "info",
        actor: event.role === "user" ? "supervisor" : "agent",
        text: event.text,
        approxTime: true,
      });
      break;
    case "agent_reasoning":
      createStep(state, turn, ctx, {
        kind: "reasoning",
        source: event.type,
        status: "info",
        text: event.text,
        approxTime: true,
        ...(event.callId !== undefined ? { callId: event.callId } : {}),
      });
      break;
    case "tool_started":
    case "command_started":
    case "test_started":
      if (event.type === "command_started") state.capabilities.add("agent_commands");
      openCall(state, turn, ctx, event);
      break;
    case "tool_completed":
    case "command_completed":
    case "test_completed":
      if (event.type === "command_completed") state.capabilities.add("agent_commands");
      closeCall(state, turn, ctx, event);
      break;
    case "file_read":
      createStep(state, turn, ctx, {
        kind: "read",
        source: event.type,
        status: "info",
        target: event.path,
        approxTime: true,
      });
      break;
    case "file_changed":
      foldClaim(state, turn, ctx, event);
      break;
    case "approval_requested":
      createStep(state, turn, ctx, {
        kind: "approval",
        source: event.type,
        status: "info",
        target: event.command,
        approxTime: true,
        ...(event.callId !== undefined ? { callId: event.callId } : {}),
      });
      break;
    case "agent_waiting":
    case "agent_completed":
    case "agent_failed":
    case "agent_interrupted":
      createStep(state, turn, ctx, {
        kind: "lifecycle",
        source: event.type,
        status: event.type === "agent_failed" ? "failed" : event.type === "agent_completed" ? "ok" : "info",
        label: agentEventLabel(event),
        approxTime: true,
      });
      if (event.type !== "agent_waiting") {
        turn.terminal =
          event.type === "agent_interrupted" ? { type: event.type, reason: event.reason } : { type: event.type };
      }
      break;
  }
  turn.lastAgentEvent = event.type;
}
```

- [ ] **Step 6: Write the public fold API**

Create `packages/trace-viewer/src/model/fold.ts`:

```ts
import {
  ChangeUnitSchema,
  DecisionSchema,
  EVENT_TYPES,
  EvidenceFactSchema,
  JevDecisionLogSchema,
  NormalizedAgentEventSchema,
  ValidationResultSchema,
  type AgentState,
  type EventStoreType,
  type TraceRow,
  type TraceSessionSummary,
} from "@jevcode/contracts";
import type { z } from "zod";

import { foldAgentEvent } from "./fold-agent.js";
import {
  addGap,
  advanceClock,
  clockTs,
  FoldState,
  type DisplayClock,
  type RowContext,
  type StepDraft,
  type TurnDraft,
} from "./fold-state.js";
import { stepHeadline } from "./format.js";
import { ENVELOPE_RULES } from "./registry.js";
import {
  CAPABILITIES,
  SIGNAL_IDS,
  TRACE_SCHEMA_VERSION,
  type Capability,
  type Coverage,
  type Gap,
  type Step,
  type StepStatus,
  type TraceSession,
  type Turn,
  type TurnOutcome,
} from "./types.js";

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
  /** Epoch ms on the session's source clock (TraceSource.now()). With live, a running step lasts
   *  nowMs - startMs (spec §6.5); without it a running step's durationMs is null. */
  nowMs?: number;
}

export function createTraceState(meta: TraceSessionSummary): TraceState {
  return new FoldState({ ...meta });
}

function internal(state: TraceState): FoldState {
  if (!(state instanceof FoldState)) {
    throw new TypeError("accumulate/finalize need a state made by createTraceState");
  }
  return state;
}

function isEventStoreType(type: string): type is EventStoreType {
  return (EVENT_TYPES as readonly string[]).includes(type);
}

/** agent_event and evidence_fact rows move the clock; every other row inherits it (spec §6.5). */
function clockContext(state: FoldState, row: TraceRow, payloadTs: string): RowContext {
  return { seq: row.seq, sourceTs: payloadTs, t: advanceClock(state.clock, payloadTs) };
}

/** The parsed payload, or null after recording an invalid_row gap (the fold continues). */
function parseOrGap<T>(state: FoldState, row: TraceRow, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T | null {
  const parsed = schema.safeParse(row.payload);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues[0];
  addGap(
    state,
    "invalid_row",
    row.seq,
    `${row.type} row ${row.seq} failed its schema${detail !== undefined ? ` at ${detail.path.join(".") || "payload"}: ${detail.message}` : ""}`,
  );
  return null;
}

/**
 * Mutates state and returns it. A seq already folded is skipped silently; a new seq below the
 * max folded seq adds an out_of_order gap and is skipped; a payload that fails its contracts
 * schema adds an invalid_row gap; a type outside EVENT_TYPES adds an unknown_row_type gap.
 */
export function accumulate(state: TraceState, row: TraceRow): TraceState {
  const s = internal(state);
  if (!Number.isInteger(row.seq) || row.seq < 1) {
    addGap(s, "invalid_row", 0, `row has an invalid seq ${String(row.seq)}`);
    return state;
  }
  if (s.seen.has(row.seq)) return state;
  s.seen.add(row.seq);
  s.received = s.seen.size;
  if (row.seq < s.maxSeq) {
    addGap(s, "out_of_order", row.seq, `row ${row.seq} arrived after row ${s.maxSeq} and was skipped`);
    return state;
  }
  s.maxSeq = row.seq;
  s.loadedThroughSeq = row.seq;
  const type = row.type;
  if (!isEventStoreType(type)) {
    addGap(s, "unknown_row_type", row.seq, `row ${row.seq} has unknown type "${type.slice(0, 64)}"`);
    return state;
  }
  if (ENVELOPE_RULES[type] === "hidden") {
    s.hidden[type] = (s.hidden[type] ?? 0) + 1;
    return state;
  }
  switch (type) {
    case "agent_event": {
      const event = parseOrGap(s, row, NormalizedAgentEventSchema);
      if (event !== null) foldAgentEvent(s, event, clockContext(s, row, event.ts));
      break;
    }
    // The remaining consumed types are validated against their contracts schema here.
    case "evidence_fact":
      parseOrGap(s, row, EvidenceFactSchema);
      break;
    case "validation":
      parseOrGap(s, row, ValidationResultSchema);
      break;
    case "change_unit":
      parseOrGap(s, row, ChangeUnitSchema);
      break;
    case "decision":
      parseOrGap(s, row, DecisionSchema);
      break;
    case "jev_decision":
      parseOrGap(s, row, JevDecisionLogSchema);
      break;
    default:
      s.hidden[type] = (s.hidden[type] ?? 0) + 1;
  }
  return state;
}

export function accumulateAll(state: TraceState, rows: readonly TraceRow[]): TraceState {
  for (const row of rows) accumulate(state, row);
  return state;
}

// ------------------------------------------------------------ finalize

function settledStatus(draft: StepDraft): StepStatus {
  if (draft.command === undefined) return draft.status;
  if (draft.tests !== undefined && draft.tests.failed > 0) return "failed";
  const exitCode = draft.command.exitCode;
  if (exitCode !== null && exitCode > 0) return "failed";
  if (exitCode === 0) return "ok";
  // exit -1 (Codex gave none) or no exit code: known only through a clean test result.
  return draft.tests !== undefined && draft.tests.passed > 0 ? "ok" : "unknown";
}

function headlineOf(draft: StepDraft): string {
  return stepHeadline({
    kind: draft.kind,
    ...(draft.target !== undefined ? { target: draft.target } : {}),
    ...(draft.label !== null ? { text: draft.label } : draft.text !== undefined ? { text: draft.text } : {}),
    ...(draft.tests !== undefined
      ? { tests: { passed: draft.tests.passed, failed: draft.tests.failed, skipped: draft.tests.skipped } }
      : {}),
    ...(draft.command !== undefined ? { exitCode: draft.open ? null : draft.command.exitCode } : {}),
    ...(draft.decision !== undefined ? { decisionTitle: draft.decision.title } : {}),
    ...(draft.guardrail !== undefined ? { clampIds: draft.guardrail.clampIds } : {}),
  });
}

/** A deep copy with the private draft fields dropped: later rows never change a returned session. */
function toPublicStep(draft: StepDraft, openStatus: "running" | "unknown"): Step {
  const step: Step = {
    id: draft.id,
    kind: draft.kind,
    lane: draft.lane,
    actor: draft.actor,
    provenance: draft.provenance,
    status: draft.open ? openStatus : settledStatus(draft),
    headline: headlineOf(draft),
    ...(draft.target !== undefined ? { target: draft.target } : {}),
    ...(draft.text !== undefined ? { text: draft.text } : {}),
    ...(draft.callId !== undefined ? { callId: draft.callId } : {}),
    turnIndex: draft.turnIndex,
    seqs: [...draft.seqs],
    firstSeq: draft.firstSeq,
    lastSeq: draft.lastSeq,
    startTs: draft.startTs,
    endTs: draft.open ? null : draft.endTs,
    tMs: draft.tMs,
    startMs: draft.startMs,
    endTMs: draft.open ? null : draft.endTMs,
    durationMs: draft.open ? null : draft.durationMs,
    approxTime: draft.approxTime,
    evidenceSeqs: [...draft.evidenceSeqs],
    chapterIds: [],
    entityIds: [],
    findingIds: [],
    problems: [],
    noise: null,
  };
  if (draft.command !== undefined) step.command = { ...draft.command };
  if (draft.tests !== undefined) {
    step.tests = { ...draft.tests, failures: draft.tests.failures.map((failure) => ({ ...failure })) };
  }
  if (draft.edit !== undefined) step.edit = { ...draft.edit };
  if (draft.decision !== undefined) {
    step.decision = { ...draft.decision, options: draft.decision.options.map((option) => ({ ...option })) };
  }
  if (draft.guardrail !== undefined) step.guardrail = { ...draft.guardrail, clampIds: [...draft.guardrail.clampIds] };
  return step;
}

function outcomeOf(turn: TurnDraft, isLast: boolean, live: boolean): Pick<Turn, "outcome" | "interruptReason"> {
  const terminal = turn.terminal;
  if (terminal !== null) {
    if (terminal.type === "agent_completed") return { outcome: "completed" };
    if (terminal.type === "agent_failed") return { outcome: "failed" };
    return terminal.reason !== undefined
      ? { outcome: "interrupted", interruptReason: terminal.reason }
      : { outcome: "interrupted" };
  }
  if (!isLast) return { outcome: "interrupted" };
  if (!live) return { outcome: "unknown" };
  const waiting: TurnOutcome =
    turn.lastAgentEvent === "agent_waiting" || turn.lastAgentEvent === "approval_requested" ? "waiting" : "running";
  return { outcome: waiting };
}

function toPublicTurn(turn: TurnDraft, isLast: boolean, live: boolean): Turn {
  return {
    index: turn.index,
    trigger: turn.trigger,
    prompt: turn.prompt,
    ...outcomeOf(turn, isLast, live),
    ...(turn.turnId !== undefined ? { turnId: turn.turnId } : {}),
    startSeq: turn.startSeq,
    endSeq: turn.endSeq,
    startTs: turn.startTs,
    endTs: turn.endTs,
    tMs: turn.tMs,
    endTMs: turn.endTMs,
    stepIds: [...turn.stepIds],
  };
}

/** Capabilities present in the folded rows. No signal is evaluated yet, so each one reads inactive. */
function coverageOf(capabilities: ReadonlySet<Capability>, approximateJoins: boolean, inferredSteps: number): Coverage {
  return {
    capabilities: CAPABILITIES.filter((capability) => capabilities.has(capability)),
    signals: SIGNAL_IDS.map((id) => ({ id, active: false, missing: [] })),
    approximateJoins,
    inferredSteps,
  };
}

function compareGaps(a: Gap, b: Gap): number {
  return a.atSeq - b.atSeq || a.kind.localeCompare(b.kind) || a.message.localeCompare(b.message);
}

/** TraceSession.originMs (spec §6.5): the first clock row's source time, else meta.startedAt,
 *  else 0. Never NaN. */
function originOf(clock: DisplayClock, startedAt: string): number {
  if (!Number.isNaN(clock.origin)) return clock.origin;
  const parsed = Date.parse(startedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Never mutates state. Same rows in any batch split produce a deep-equal TraceSession. */
export function finalize(state: TraceState, options: FinalizeOptions): TraceSession {
  const s = internal(state);
  const live = options.live;
  const lastTurnIndex = s.turns.length - 1;
  const gaps: Gap[] = [...s.gaps];
  const turns = s.turns.map((turn) => toPublicTurn(turn, turn.index === lastTurnIndex, live));
  const steps = s.steps.map((draft) => {
    const running = live && draft.turnIndex === lastTurnIndex;
    if (draft.open && !running) {
      gaps.push({
        kind: "unpaired",
        atSeq: draft.firstSeq,
        message: `${draft.target ?? draft.kind} started but never finished`,
      });
    }
    return toPublicStep(draft, running ? "running" : "unknown");
  });
  const nowMs = options.nowMs;
  if (live && nowMs !== undefined) {
    // spec §6.5: an open step at the live edge lasts until now.
    for (const step of steps) if (step.status === "running") step.durationMs = Math.max(0, nowMs - step.startMs);
  }
  steps.sort((a, b) => a.firstSeq - b.firstSeq);

  const loadedThroughSeq = Math.max(s.loadedThroughSeq, options.throughSeq ?? 0);
  const clock = s.clock;
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    meta: { ...s.meta, ...(options.state !== undefined ? { state: options.state } : {}) },
    live,
    loadedThroughSeq,
    originMs: originOf(clock, s.meta.startedAt),
    span: {
      startTs: clockTs(clock, 0, s.meta.startedAt),
      endTs: clockTs(clock, clock.last, s.meta.startedAt),
      durationMs: clock.last,
    },
    turns,
    steps,
    chapters: [],
    entities: [],
    findings: [],
    gaps: gaps.sort(compareGaps),
    coverage: coverageOf(s.capabilities, false, steps.filter((step) => step.provenance === "inferred").length),
    hidden: { byType: { ...s.hidden }, unreceived: Math.max(0, loadedThroughSeq - s.received) },
  };
}

export function foldRows(
  meta: TraceSessionSummary,
  rows: readonly TraceRow[],
  options: FinalizeOptions,
): TraceSession {
  return finalize(accumulateAll(createTraceState(meta), rows), options);
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/model/fold.test.ts`

Expected: `Test Files  1 passed (1)`, `Tests  20 passed (20)`.

- [ ] **Step 8: Export from the model barrel**

In `packages/trace-viewer/src/model/index.ts`, find:

```ts
export * from "./rows.js";
```

Replace it with:

```ts
export * from "./rows.js";
export * from "./fold.js";
```

Run: `pnpm --filter @jevcode/trace-viewer typecheck`

Expected: exits 0.

- [ ] **Step 9: Root checks**

Run, in order, from `/Users/jwpark/Projects/jevcode-tv-b`:

```bash
pnpm -r build
pnpm -r typecheck
pnpm -r --workspace-concurrency=1 test
pnpm lint
```

Expected: each command exits 0. `pnpm -r build` includes `jevcode-trace-viewer-dev`, whose Vite plugin fails the build if any module reachable from `@jevcode/trace-viewer/model` imports a Node built-in (the browser-safety proof). `pnpm lint` prints nothing after `> pnpm exec eslint .`.

- [ ] **Step 10: Commit**

```bash
git add packages/trace-viewer/src/model/fold-state.ts \
  packages/trace-viewer/src/model/fold-agent.ts \
  packages/trace-viewer/src/model/fold.ts \
  packages/trace-viewer/src/model/fold.test.ts \
  packages/trace-viewer/src/test-support/trace-builder.ts \
  packages/trace-viewer/src/model/index.ts
git commit -m "feat(trace-viewer): fold agent events into turns and paired steps"
```

### Task B-4: Evidence attach, tests and checks, validations, edits, entities

**Files:**
- Create: `packages/trace-viewer/src/model/fold-evidence.ts`
- Test: `packages/trace-viewer/src/model/fold-evidence.test.ts`
- Modify: `packages/trace-viewer/src/model/fold.ts` (imports, `accumulate` switch, `finalize`), `packages/trace-viewer/src/model/fold-state.ts` (evidence state), `packages/trace-viewer/src/model/types.ts` (`TestDetail.resultSeq`, deviation 3)

**Interfaces:**
- Consumes: B-3 internals from `./fold-state.js`: `FoldState` (fields `steps`, `stepsByCallId`, `turns`, `capabilities`, `clock`), `TurnDraft` (`commands: Map<string, StepDraft>`, `edits: Map<string, StepDraft>`), `StepDraft`, `RowContext`, `createStep(state, turn, ctx, init)`, `addRowToStep(step, ctx, evidence)`, `currentTurn(state, ctx)`, `touchTurn(turn, ctx)`, `setKind(step, kind)`, `advanceClock`, `clockTs(clock, t, fallback)`. B-1 `normalizeCommand`, `truncateMiddle`. B-2 `commandKind`. From `@jevcode/contracts`: `matchDestructive`, `type EvidenceFact` (`git_hunk.diff?: {hash; bytes; text?; truncated; redactions; withheld?: "secret_path" | "not_captured"}`, `command_executed.sourceCallId?`, `test_result.sourceCallId?`), `type ValidationResult`, `type TraceRow`. From `./types.js`: `fileStableId(path)`, `type DiffState`, `type Entity`, `type FileStableId`, `type Step`.
- Produces:
  - `fold-evidence.ts` (internal): `foldEvidenceFact(state: FoldState, row: TraceRow, fact: EvidenceFact, ctx: RowContext): void`; `foldValidation(state: FoldState, validation: ValidationResult, ctx: RowContext): void`; `buildEntities(steps: readonly Step[], duplicates: ReadonlySet<string>): Entity[]` (also sets each edit step's `entityIds`).
  - `fold-state.ts`: `interface EvidenceState { readonly lastHunkKey: Map<string, string>; readonly hunkKeyByStep: Map<StepId, string>; readonly duplicates: Set<StepId>; readonly factSeqById: Map<string, number>; readonly stepByEvidenceSeq: Map<number, StepDraft>; readonly testRunByKey: Map<string, StepDraft>; readonly validationSeqById: Map<string, number> }` and `FoldState.evidence: EvidenceState`.
  - `types.ts`: `TestDetail.resultSeq?: number`.
  - `finalize` now returns `entities` (files only, in first-touch order); capabilities gain `test_results` and `fact_links`.

Rules (R10): `command_executed` and `test_result` join the step whose `callId` equals `sourceCallId` (provenance unchanged), else the turn's latest step with the same normalized command (provenance `inferred`), else a new repo step. A `test_result` sets `tests` (at most 20 failures, `resultSeq`) and makes the step `test`, or `check` when `commandKind(command)` is `check`; a validation of kind `typecheck`/`lint`/`build` makes it `check`. An agent claim and the repo facts for its path join one edit step; a `git_hunk` with new content (key `diff.hash`, else `added:removed`) after the path's step already holds one starts a new edit step; an identical `git_hunk` is a `duplicate_poll` step of its own. Validations join the step holding their `test_result` (same command and ts), else the latest same-command step in any turn; they only add evidence.

- [ ] **Step 1: Write the failing test**

Create `packages/trace-viewer/src/model/fold-evidence.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { loadFixtureTrace } from "../test-support/fixture-rows.js";
import { TraceBuilder, testMeta } from "../test-support/trace-builder.js";
import { foldRows } from "./fold.js";
import type { Step, TraceSession } from "./types.js";

function fold(builder: TraceBuilder, live = false): TraceSession {
  return foldRows(testMeta(), builder.rows, { live });
}

function stepAt(session: TraceSession, seq: number): Step {
  const step = session.steps.find((candidate) => candidate.firstSeq === seq);
  if (step === undefined) throw new Error(`no step starts at seq ${seq}`);
  return step;
}

const HASH_A = "aaaaaaaaaaaaaaaa";
const HASH_B = "bbbbbbbbbbbbbbbb";

function hunk(file: string, added: number, removed: number, diff?: Record<string, unknown>) {
  return {
    type: "git_hunk" as const,
    file,
    added,
    removed,
    isFormattingOnly: false,
    isConfigOnly: false,
    isLockfile: false,
    ...(diff !== undefined ? { diff: diff as never } : {}),
  };
}

describe("evidence attach", () => {
  it("joins a test_result to its command by sourceCallId (observed)", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "command_started", command: "/bin/zsh -lc 'pnpm test'", callId: "c1" });
    b.agent({ type: "command_completed", command: "/bin/zsh -lc 'pnpm test'", exitCode: 1, stdout: "", stderr: "", callId: "c1" });
    const result = b.fact({
      type: "test_result",
      runner: "vitest",
      command: "pnpm test",
      passed: 3,
      failed: 1,
      skipped: 2,
      failures: [{ file: "a.test.ts", testName: "a > b", message: "boom" }],
      sourceCallId: "c1",
    });
    const session = fold(b);
    const step = stepAt(session, 2);
    expect(step).toMatchObject({ kind: "test", lane: "tests", provenance: "observed", status: "failed" });
    expect(step.tests).toEqual({
      runner: "vitest",
      passed: 3,
      failed: 1,
      skipped: 2,
      failures: [{ file: "a.test.ts", testName: "a > b", message: "boom" }],
      resultSeq: result,
    });
    expect(step.evidenceSeqs).toEqual([result]);
    expect(step.seqs).toEqual([2, 3, result]);
    expect(session.coverage.capabilities).toContain("test_results");
  });

  it("joins by whitespace-normalized command in the turn when there is no sourceCallId (inferred)", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p", turnId: "t" });
    b.agent({ type: "command_started", command: "pnpm  test", callId: "t:1" });
    const result = b.fact({ type: "test_result", runner: "vitest", command: "pnpm test", passed: 14, failed: 1, skipped: 0, failures: [] });
    b.agent({ type: "command_completed", command: "pnpm test", exitCode: 0, stdout: "", stderr: "", callId: "t:1" });
    const step = stepAt(fold(b), 2);
    expect(step).toMatchObject({ provenance: "inferred", status: "failed", headline: "pnpm test · 14/15" });
    expect(step.tests?.resultSeq).toBe(result);
  });

  it("keeps at most 20 failures and makes a check command a check", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "command_started", command: "pnpm lint" });
    b.agent({ type: "command_completed", command: "pnpm lint", exitCode: 1, stdout: "", stderr: "" });
    const failures = Array.from({ length: 25 }, (_, index) => ({ file: `f${index}.ts`, testName: `t${index}`, message: "x" }));
    b.fact({ type: "test_result", runner: "eslint", command: "pnpm lint", passed: 0, failed: 25, skipped: 0, failures });
    const step = stepAt(fold(b), 2);
    expect(step.kind).toBe("check");
    expect(step.tests?.failures).toHaveLength(20);
  });

  it("makes a repo step for a fact with no matching command", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const executed = b.fact({ type: "command_executed", command: "rm -rf dist", exitCode: 0, isDestructive: true });
    const session = fold(b);
    expect(stepAt(session, executed)).toMatchObject({
      kind: "command",
      actor: "repo",
      provenance: "observed",
      status: "ok",
      command: { command: "rm -rf dist", exitCode: 0, destructivePattern: "rm-recursive-force" },
      evidenceSeqs: [executed],
    });
  });

  it("joins a validation to the run holding its test_result", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "command_started", command: "pnpm test" });
    b.agent({ type: "command_completed", command: "pnpm test", exitCode: 0, stdout: "", stderr: "" });
    const ts = TraceBuilder.at(20);
    b.fact({ type: "test_result", runner: "vitest", command: "pnpm test", passed: 5, failed: 0, skipped: 0, failures: [], ts });
    b.agent({ type: "agent_completed" });
    const validation = b.validation({ id: "val_1", kind: "test", command: "pnpm test", status: "passed", passed: 5, failed: 0, skipped: 0, ts });
    const step = stepAt(fold(b), 2);
    expect(step.evidenceSeqs).toEqual([4, validation]);
    expect(step.status).toBe("ok");
  });
});

describe("edits: claims and repo facts", () => {
  it("joins repo facts to the agent's claim for the same path", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "file_changed", path: "src/a.ts", callId: "t:5" });
    b.fact({ type: "file_changed", path: "src/a.ts", kind: "modified" });
    const hunkSeq = b.fact(hunk("src/a.ts", 7, 2, { hash: HASH_A, bytes: 120, text: "@@ -1 +1 @@", truncated: false, redactions: 0 }));
    const session = fold(b);
    const step = stepAt(session, 2);
    expect(session.steps.filter((candidate) => candidate.kind === "edit")).toHaveLength(1);
    expect(step).toMatchObject({ actor: "agent", callId: "t:5", seqs: [2, 3, 4], evidenceSeqs: [3, 4] });
    expect(step.edit).toEqual({
      path: "src/a.ts",
      change: "modified",
      added: 7,
      removed: 2,
      claimed: true,
      observed: true,
      diffSeq: hunkSeq,
      diff: "text",
      lockfile: false,
      formattingOnly: false,
    });
    expect(step.entityIds).toEqual(["file:src/a.ts"]);
  });

  it("lets a claim that arrives after the repo facts join them", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.fact(hunk("src/b.ts", 1, 0));
    b.agent({ type: "file_changed", path: "src/b.ts" });
    const step = stepAt(fold(b), 2);
    expect(step).toMatchObject({ actor: "agent", seqs: [2, 3] });
    expect(step.edit).toMatchObject({ claimed: true, observed: true, diff: "none" });
  });

  it("joins a git poll that lands after a test run to the claim it confirms", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const claim = b.agent({ type: "file_changed", path: "src/late.ts" });
    b.agent({ type: "command_started", command: "pnpm test" });
    b.agent({ type: "command_completed", command: "pnpm test", exitCode: 0, stdout: "", stderr: "" });
    b.fact(hunk("src/late.ts", 2, 0));
    const session = fold(b);
    expect(session.steps.filter((step) => step.kind === "edit").map((step) => step.firstSeq)).toEqual([claim]);
    expect(stepAt(session, claim).edit).toMatchObject({ claimed: true, observed: true, added: 2 });
  });

  it("splits a new hunk into a new step and marks an identical re-poll as a duplicate step", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.fact(hunk("src/c.ts", 3, 0, { hash: HASH_A, bytes: 10, text: "x", truncated: false, redactions: 0 }));
    const poll = b.fact(hunk("src/c.ts", 3, 0, { hash: HASH_A, bytes: 10, text: "x", truncated: false, redactions: 0 }));
    const next = b.fact(hunk("src/c.ts", 9, 1, { hash: HASH_B, bytes: 40, truncated: false, redactions: 0, withheld: "not_captured" }));
    const session = fold(b);
    const edits = session.steps.filter((step) => step.kind === "edit");
    expect(edits.map((step) => step.firstSeq)).toEqual([2, poll, next]);
    expect(stepAt(session, next).edit).toMatchObject({ added: 9, removed: 1, diff: "not_captured" });
    const entity = session.entities.find((candidate) => candidate.path === "src/c.ts");
    expect(entity).toMatchObject({ id: "file:src/c.ts", added: 9, removed: 1, observed: true, claimed: false });
    expect(entity?.stepIds).toEqual(["step:2", `step:${next}`]);
  });

  it("uses added/removed as the change key when the hunk has no diff", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.fact(hunk("src/d.ts", 2, 2));
    b.fact(hunk("src/d.ts", 2, 2));
    b.fact(hunk("src/d.ts", 4, 2));
    expect(fold(b).steps.filter((step) => step.kind === "edit").map((step) => step.firstSeq)).toEqual([2, 3, 4]);
  });

  it("maps withheld and truncated diffs", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const secret = b.fact(hunk(".env.local", 1, 0, { hash: HASH_A, bytes: 20, truncated: false, redactions: 0, withheld: "secret_path" }));
    const cut = b.fact(hunk("big.ts", 900, 0, { hash: HASH_B, bytes: 410_000, text: "@@", truncated: true, redactions: 2 }));
    const session = fold(b);
    expect(stepAt(session, secret).edit?.diff).toBe("withheld_secret");
    expect(stepAt(session, cut).edit?.diff).toBe("truncated");
  });

  it("labels entities with a middle-truncated path", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const path = "packages/trace-viewer/src/model/deeply/nested/folder/structure/file.ts";
    b.fact(hunk(path, 1, 1));
    const entity = fold(b).entities[0];
    expect(entity?.label.endsWith("/file.ts")).toBe(true);
    expect(entity?.label).toContain("…");
  });

  it("makes a dependency step from a dependency_change fact", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const seq = b.fact({
      type: "dependency_change",
      manifest: "package.json",
      added: [{ name: "zod", version: "^3.24.1" }],
      removed: [{ name: "axios", version: "^1.7.0" }],
    });
    expect(stepAt(fold(b), seq)).toMatchObject({ kind: "dependency", lane: "edits", actor: "repo", headline: "+zod −axios" });
  });
});

describe("oauth fixture", () => {
  it("folds the pnpm test run into one failed test step with 14/1/0", () => {
    const trace = loadFixtureTrace("oauth");
    const session = foldRows(trace.meta, trace.rows, { live: false });
    const payloadOf = (seq: number) => trace.rows[seq - 1]?.payload as Record<string, unknown>;
    const started = trace.rows.find((row) => {
      const payload = row.payload as Record<string, unknown>;
      return payload["type"] === "command_started" && payload["command"] === "pnpm test";
    });
    const result = trace.rows.find((row) => (row.payload as Record<string, unknown>)["type"] === "test_result");
    if (started === undefined || result === undefined) throw new Error("fixture rows missing");
    const step = stepAt(session, started.seq);
    expect(step).toMatchObject({ kind: "test", status: "failed", tests: { passed: 14, failed: 1, skipped: 0 } });
    expect(step.tests?.resultSeq).toBe(result.seq);
    const joinedById = payloadOf(started.seq)["callId"] !== undefined && payloadOf(result.seq)["sourceCallId"] !== undefined;
    expect(step.provenance).toBe(joinedById ? "observed" : "inferred");
    const completed = trace.rows.filter((row) => {
      const payload = row.payload as Record<string, unknown>;
      return row.type === "agent_event" && payload["command"] === "pnpm test";
    });
    expect(step.seqs).toEqual(expect.arrayContaining(completed.map((row) => row.seq)));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/model/fold-evidence.test.ts`

Expected: `Tests  14 failed (14)`; the first failure is `joins a test_result to its command by sourceCallId (observed)` with `expected undefined to deeply equal { runner: 'vitest', passed: 3, …(4) }` (facts are parsed but not folded yet).

- [ ] **Step 3: Add `resultSeq` to `TestDetail`**

In `packages/trace-viewer/src/model/types.ts`, find:

```ts
export interface TestDetail extends TestCounts {
  runner?: string;
  /** At most the first 20 failures. */
  failures: TestFailureSummary[];
}
```

Replace it with:

```ts
export interface TestDetail extends TestCounts {
  runner?: string;
  /** At most the first 20 failures. */
  failures: TestFailureSummary[];
  /** seq of the test_result row these counts come from; fetch it with TraceSource.payloads. */
  resultSeq?: number;
}
```

- [ ] **Step 4: Add the evidence state**

In `packages/trace-viewer/src/model/fold-state.ts`, find:

```ts
export class FoldState {
```

Replace it with:

```ts
export interface EvidenceState {
  /** path -> key of the latest non-duplicate git_hunk (diff.hash, else "added:removed"). */
  readonly lastHunkKey: Map<string, string>;
  /** edit step -> key of the git_hunk it holds. */
  readonly hunkKeyByStep: Map<StepId, string>;
  /** Edit steps made by a git_hunk identical to the path's previous one (duplicate_poll). */
  readonly duplicates: Set<StepId>;
  /** row factId -> seq; the first row with an id wins. */
  readonly factSeqById: Map<string, number>;
  /** fact or validation seq -> the step it joined. */
  readonly stepByEvidenceSeq: Map<number, StepDraft>;
  /** `${normalized command}\u0000${test_result ts}` -> the step holding that result. */
  readonly testRunByKey: Map<string, StepDraft>;
  /** validation id -> seq. */
  readonly validationSeqById: Map<string, number>;
}

export class FoldState {
```

In `packages/trace-viewer/src/model/fold-state.ts`, find:

```ts
  readonly turns: TurnDraft[] = [];

  constructor(readonly meta: TraceSessionSummary) {
```

Replace it with:

```ts
  readonly turns: TurnDraft[] = [];
  readonly evidence: EvidenceState = {
    lastHunkKey: new Map(),
    hunkKeyByStep: new Map(),
    duplicates: new Set(),
    factSeqById: new Map(),
    stepByEvidenceSeq: new Map(),
    testRunByKey: new Map(),
    validationSeqById: new Map(),
  };

  constructor(readonly meta: TraceSessionSummary) {
```

- [ ] **Step 5: Write the evidence fold**

Create `packages/trace-viewer/src/model/fold-evidence.ts`:

```ts
import {
  matchDestructive,
  type EvidenceFact,
  type TraceRow,
  type ValidationResult,
} from "@jevcode/contracts";

import {
  addRowToStep,
  createStep,
  currentTurn,
  setKind,
  touchTurn,
  type FoldState,
  type RowContext,
  type StepDraft,
  type TurnDraft,
} from "./fold-state.js";
import { normalizeCommand, truncateMiddle } from "./format.js";
import { commandKind } from "./registry.js";
import { fileStableId, type DiffState, type Entity, type FileStableId, type Step } from "./types.js";

type CallFact = Extract<EvidenceFact, { type: "command_executed" | "test_result" }>;
type PathFact = Extract<EvidenceFact, { type: "git_hunk" | "file_changed" | "symbol_delta" }>;
type HunkFact = Extract<EvidenceFact, { type: "git_hunk" }>;

const MAX_FAILURES = 20;

function testKind(command: string): "check" | "test" {
  return commandKind(command) === "check" ? "check" : "test";
}

/** The step a command_executed or test_result belongs to: by sourceCallId (observed), else the
 *  latest same-command step in the turn (inferred), else a new repo step. */
function attachCall(state: FoldState, turn: TurnDraft, ctx: RowContext, fact: CallFact): StepDraft {
  const normalized = normalizeCommand(fact.command);
  if (fact.sourceCallId !== undefined) {
    const byCall = state.stepsByCallId.get(fact.sourceCallId);
    if (byCall !== undefined) return byCall;
  }
  const byCommand = turn.commands.get(normalized);
  if (byCommand !== undefined) {
    byCommand.provenance = "inferred";
    return byCommand;
  }
  const kind = fact.type === "test_result" ? testKind(fact.command) : commandKind(fact.command);
  const step = createStep(state, turn, ctx, {
    kind,
    source: fact.type,
    status: "ok",
    actor: "repo",
    target: fact.command,
  });
  const pattern = matchDestructive(fact.command);
  step.command = {
    command: fact.command,
    exitCode: fact.type === "command_executed" ? fact.exitCode : null,
    ...(pattern !== null ? { destructivePattern: pattern.name } : {}),
  };
  turn.commands.set(normalized, step);
  return step;
}

function foldCallFact(state: FoldState, turn: TurnDraft, ctx: RowContext, fact: CallFact): void {
  const step = attachCall(state, turn, ctx, fact);
  if (step.seqs[0] !== ctx.seq) addRowToStep(step, ctx, true);
  else step.evidenceSeqs.push(ctx.seq);
  state.evidence.stepByEvidenceSeq.set(ctx.seq, step);
  if (fact.type !== "test_result") return;
  state.capabilities.add("test_results");
  step.tests = {
    runner: fact.runner,
    passed: fact.passed,
    failed: fact.failed,
    skipped: fact.skipped,
    failures: fact.failures.slice(0, MAX_FAILURES).map((failure) => ({
      file: failure.file,
      testName: failure.testName,
      message: failure.message,
    })),
    resultSeq: ctx.seq,
  };
  setKind(step, testKind(fact.command));
  state.evidence.testRunByKey.set(`${normalizeCommand(fact.command)}\u0000${fact.ts}`, step);
}

function pathOf(fact: PathFact): string {
  return fact.type === "git_hunk" ? fact.file : fact.path;
}

function hunkKey(fact: HunkFact): string {
  return fact.diff !== undefined ? fact.diff.hash : `${fact.added}:${fact.removed}`;
}

function diffState(fact: HunkFact): DiffState {
  const diff = fact.diff;
  if (diff === undefined) return "none";
  if (diff.withheld === "secret_path") return "withheld_secret";
  if (diff.withheld === "not_captured" || diff.text === undefined) return "not_captured";
  return diff.truncated ? "truncated" : "text";
}

function createRepoEditStep(state: FoldState, turn: TurnDraft, ctx: RowContext, fact: PathFact): StepDraft {
  const path = pathOf(fact);
  const step = createStep(state, turn, ctx, {
    kind: "edit",
    source: fact.type,
    status: "ok",
    actor: "repo",
    target: path,
  });
  step.edit = {
    path,
    added: 0,
    removed: 0,
    claimed: false,
    observed: true,
    diff: "none",
    lockfile: false,
    formattingOnly: false,
  };
  step.evidenceSeqs.push(ctx.seq);
  return step;
}

function applyHunk(step: StepDraft, ctx: RowContext, fact: HunkFact): void {
  if (step.edit === undefined) return;
  step.edit.added = fact.added;
  step.edit.removed = fact.removed;
  step.edit.lockfile = step.edit.lockfile || fact.isLockfile;
  step.edit.formattingOnly = fact.isFormattingOnly;
  step.edit.diffSeq = ctx.seq;
  step.edit.diff = diffState(fact);
}

/** Repo facts for a path join the path's latest edit step in the turn; a git_hunk with new
 *  content after that step already holds one starts a new step; an identical git_hunk is a
 *  duplicate_poll step of its own. */
function foldPathFact(state: FoldState, turn: TurnDraft, ctx: RowContext, fact: PathFact): void {
  const path = pathOf(fact);
  const evidence = state.evidence;
  if (fact.type === "git_hunk") {
    const key = hunkKey(fact);
    if (evidence.lastHunkKey.get(path) === key) {
      const duplicate = createRepoEditStep(state, turn, ctx, fact);
      applyHunk(duplicate, ctx, fact);
      evidence.duplicates.add(duplicate.id);
      evidence.stepByEvidenceSeq.set(ctx.seq, duplicate);
      return;
    }
    evidence.lastHunkKey.set(path, key);
    let step = turn.edits.get(path);
    if (step === undefined || evidence.hunkKeyByStep.has(step.id)) {
      step = createRepoEditStep(state, turn, ctx, fact);
      turn.edits.set(path, step);
    } else {
      addRowToStep(step, ctx, true);
    }
    evidence.hunkKeyByStep.set(step.id, key);
    applyHunk(step, ctx, fact);
    if (step.edit !== undefined) step.edit.observed = true;
    evidence.stepByEvidenceSeq.set(ctx.seq, step);
    return;
  }
  let step = turn.edits.get(path);
  if (step === undefined) {
    step = createRepoEditStep(state, turn, ctx, fact);
    turn.edits.set(path, step);
  } else {
    addRowToStep(step, ctx, true);
  }
  if (step.edit !== undefined) {
    step.edit.observed = true;
    if (fact.type === "file_changed") step.edit.change = fact.kind;
  }
  evidence.stepByEvidenceSeq.set(ctx.seq, step);
}

function foldPointFact(
  state: FoldState,
  turn: TurnDraft,
  ctx: RowContext,
  fact: Extract<EvidenceFact, { type: "dependency_change" | "revert_detected" }>,
): void {
  if (fact.type === "dependency_change") {
    const names = [
      ...fact.added.map((dependency) => `+${dependency.name}`),
      ...fact.removed.map((dependency) => `−${dependency.name}`),
    ];
    const step = createStep(state, turn, ctx, {
      kind: "dependency",
      source: fact.type,
      status: "info",
      target: fact.manifest,
      label: names.join(" "),
    });
    step.evidenceSeqs.push(ctx.seq);
    state.evidence.stepByEvidenceSeq.set(ctx.seq, step);
    return;
  }
  const step = createStep(state, turn, ctx, {
    kind: "revert",
    source: fact.type,
    status: "info",
    target: fact.files.join(", "),
    label: fact.files.length === 1 ? `Reverted ${fact.files[0] ?? ""}` : `Reverted ${fact.files.length} files`,
  });
  step.evidenceSeqs.push(ctx.seq);
  state.evidence.stepByEvidenceSeq.set(ctx.seq, step);
}

export function foldEvidenceFact(state: FoldState, row: TraceRow, fact: EvidenceFact, ctx: RowContext): void {
  if (row.factId !== undefined) {
    state.capabilities.add("fact_links");
    if (!state.evidence.factSeqById.has(row.factId)) state.evidence.factSeqById.set(row.factId, ctx.seq);
  }
  const turn = currentTurn(state, ctx);
  touchTurn(turn, ctx);
  switch (fact.type) {
    case "command_executed":
    case "test_result":
      foldCallFact(state, turn, ctx, fact);
      break;
    case "git_hunk":
    case "file_changed":
    case "symbol_delta":
      foldPathFact(state, turn, ctx, fact);
      break;
    case "dependency_change":
    case "revert_detected":
      foldPointFact(state, turn, ctx, fact);
      break;
  }
}

/** A validation joins the step holding its test_result (same command and ts), else the latest
 *  step in any turn with the same command. It adds evidence; test counts come from test_result. */
export function foldValidation(state: FoldState, validation: ValidationResult, ctx: RowContext): void {
  const evidence = state.evidence;
  if (!evidence.validationSeqById.has(validation.id)) evidence.validationSeqById.set(validation.id, ctx.seq);
  const normalized = normalizeCommand(validation.command);
  let step = evidence.testRunByKey.get(`${normalized}\u0000${validation.ts}`);
  for (let index = state.turns.length - 1; step === undefined && index >= 0; index -= 1) {
    step = state.turns[index]?.commands.get(normalized);
  }
  if (step === undefined) return;
  addRowToStep(step, ctx, true);
  evidence.stepByEvidenceSeq.set(ctx.seq, step);
  if (validation.kind !== "test" && step.kind !== "check") setKind(step, "check");
}

/** Files only in v1. added/removed come from the path's latest hunk (hunks are cumulative
 *  against the base commit); duplicate_poll steps are left out of stepIds. */
export function buildEntities(steps: readonly Step[], duplicates: ReadonlySet<string>): Entity[] {
  const byPath = new Map<string, Entity>();
  for (const step of steps) {
    if (step.kind !== "edit" || step.edit === undefined) continue;
    const edit = step.edit;
    const id: FileStableId = fileStableId(edit.path);
    step.entityIds = [id];
    let entity = byPath.get(edit.path);
    if (entity === undefined) {
      entity = {
        id,
        kind: "file",
        path: edit.path,
        label: truncateMiddle(edit.path, 48),
        added: 0,
        removed: 0,
        claimed: false,
        observed: false,
        stepIds: [],
        chapterIds: [],
      };
      byPath.set(edit.path, entity);
    }
    entity.claimed = entity.claimed || edit.claimed;
    entity.observed = entity.observed || edit.observed;
    if (duplicates.has(step.id)) continue;
    entity.stepIds.push(step.id);
    if (edit.diffSeq !== undefined) {
      entity.added = edit.added;
      entity.removed = edit.removed;
    }
  }
  return [...byPath.values()];
}
```

- [ ] **Step 6: Wire it into `fold.ts`**

Validations carry pipeline processing times, so they get an inherited-clock context (spec §6.5).

In `packages/trace-viewer/src/model/fold.ts`, find:

```ts
import { foldAgentEvent } from "./fold-agent.js";
```

Replace it with:

```ts
import { foldAgentEvent } from "./fold-agent.js";
import { buildEntities, foldEvidenceFact, foldValidation } from "./fold-evidence.js";
```

In `packages/trace-viewer/src/model/fold.ts`, find:

```ts
/** The parsed payload, or null after recording an invalid_row gap (the fold continues). */
```

Replace it with:

```ts
function inheritedContext(state: FoldState, row: TraceRow): RowContext {
  const t = state.clock.last;
  return { seq: row.seq, sourceTs: clockTs(state.clock, t, row.ts), t };
}

/** The parsed payload, or null after recording an invalid_row gap (the fold continues). */
```

In `packages/trace-viewer/src/model/fold.ts`, find:

```ts
    // The remaining consumed types are validated against their contracts schema here.
    case "evidence_fact":
      parseOrGap(s, row, EvidenceFactSchema);
      break;
    case "validation":
      parseOrGap(s, row, ValidationResultSchema);
      break;
```

Replace it with:

```ts
    case "evidence_fact": {
      const fact = parseOrGap(s, row, EvidenceFactSchema);
      if (fact !== null) foldEvidenceFact(s, row, fact, clockContext(s, row, fact.ts));
      break;
    }
    case "validation": {
      const validation = parseOrGap(s, row, ValidationResultSchema);
      if (validation !== null) foldValidation(s, validation, inheritedContext(s, row));
      break;
    }
    // The remaining consumed types are validated against their contracts schema here.
```

In `packages/trace-viewer/src/model/fold.ts`, find:

```ts
  steps.sort((a, b) => a.firstSeq - b.firstSeq);

  const loadedThroughSeq = Math.max(s.loadedThroughSeq, options.throughSeq ?? 0);
```

Replace it with:

```ts
  steps.sort((a, b) => a.firstSeq - b.firstSeq);

  const entities = buildEntities(steps, s.evidence.duplicates);

  const loadedThroughSeq = Math.max(s.loadedThroughSeq, options.throughSeq ?? 0);
```

In `packages/trace-viewer/src/model/fold.ts`, find:

```ts
    entities: [],
```

Replace it with:

```ts
    entities,
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/model/fold-evidence.test.ts src/model/fold.test.ts`

Expected: `Test Files  2 passed (2)`, `Tests  34 passed (34)`.

Run: `pnpm --filter @jevcode/trace-viewer typecheck`

Expected: exits 0.

- [ ] **Step 8: Root checks**

Run, in order, from `/Users/jwpark/Projects/jevcode-tv-b`:

```bash
pnpm -r build
pnpm -r typecheck
pnpm -r --workspace-concurrency=1 test
pnpm lint
```

Expected: each command exits 0. `pnpm -r build` includes `jevcode-trace-viewer-dev`, whose Vite plugin fails the build if any module reachable from `@jevcode/trace-viewer/model` imports a Node built-in (the browser-safety proof). `pnpm lint` prints nothing after `> pnpm exec eslint .`.

- [ ] **Step 9: Commit**

```bash
git add packages/trace-viewer/src/model/fold-evidence.ts \
  packages/trace-viewer/src/model/fold-evidence.test.ts \
  packages/trace-viewer/src/model/fold.ts \
  packages/trace-viewer/src/model/fold-state.ts \
  packages/trace-viewer/src/model/types.ts
git commit -m "feat(trace-viewer): attach evidence facts, validations and edits to steps"
```

### Task B-5: Chapters, decisions, guardrail and attention steps

**Files:**
- Create: `packages/trace-viewer/src/model/fold-chapters.ts`
- Test: `packages/trace-viewer/src/model/fold-chapters.test.ts`
- Modify: `packages/trace-viewer/src/model/fold.ts` (imports, `accumulate` switch, `outcomeOf`, `finalize`), `packages/trace-viewer/src/model/fold-state.ts` (chapter state, `TurnDraft.decisionAnswered`)

**Interfaces:**
- Consumes: B-3 internals (`FoldState`, `StepDraft`, `RowContext`, `createStep`, `addRowToStep`, `currentTurn`, `touchTurn`, `FoldState.stepsByCallId`, `FoldState.clock.origin`), B-4 `FoldState.evidence` (`factSeqById`, `stepByEvidenceSeq`, `validationSeqById`, `duplicates`), B-2 `clampMeta(id)`. From `@jevcode/contracts`: `type ChangeUnit` (`evidence: string[]`, `agentCallIds?: string[]`, `validationResults`, `relatedDecisions`, `files`, `createdAt`, `updatedAt`, `status`, `schemaChanges`, `dependencyChanges`, `importance?`, `relevance?`, `interruption?`), `type Decision` (`status: "open" | "answered" | "delegated" | "expired"`, `answer?.decision: Record<string, string>`, `affectedChangeUnits`, `ts?`), `type JevDecisionLog` (`clamps: string[]`, `changeUnitId?`, `pass?: "A" | "B"`, `clientKind`, `confidence`), `type JevClientKind` (`"typesafe" | "degrade" | "playback"`), `AttentionDecisionSchema` (contracts/src/jev.ts:8; `importance`, `relevance`, `interruption` in [0, 1] plus eight more required fields). From `./types.js`: `unitStableId`, `decisionStableId`, `type Chapter`, `type DecisionDetail`, `type DecisionStableId`, `type Entity`, `type Step`, `type StepId`, `type StepStatus`.
- Produces:
  - `fold-chapters.ts` (internal): `APPROX_WINDOW_SLACK_MS = 5_000`; `foldChangeUnit(state, unit: ChangeUnit, ctx): void`; `foldDecision(state, decision: Decision, ctx): void`; `foldJevDecision(state, log: JevDecisionLog, ctx): void`; `buildChapters(state: FoldState, steps: readonly Step[], stepById: ReadonlyMap<StepId, Step>, entities: readonly Entity[]): Chapter[]` (also fills `step.chapterIds` and `entity.chapterIds`).
  - `fold-state.ts`: `interface UnitEntry { unit: ChangeUnit; firstSeq: number; lastSeq: number; versions: number }`; `interface UnitAttention { importance: number; relevance: number; interruption: number; clientKind: JevClientKind }`; `interface ChapterState { readonly units: Map<string, UnitEntry>; readonly decisionSteps: Map<string, StepDraft>; readonly decisionUnits: Map<string, string[]>; readonly jevStepsByUnit: Map<string, StepDraft[]>; readonly surfaceByUnit: Map<string, boolean>; readonly attentionByUnit: Map<string, UnitAttention> }`; `FoldState.chapters: ChapterState`; `TurnDraft.decisionAnswered: boolean`.
  - UI index §1.4 B-5 (W0-6 declares `triad.clientKind?: JevClientKind` per UI index §1.2): `Chapter.triad` takes `importance`, `relevance`, `interruption` and `clientKind` from the unit's latest `jev_decision` row that is not Pass B (`pass !== "B"`) and whose `output` parses with `AttentionDecisionSchema` (`@jevcode/contracts`, contracts/src/jev.ts:8); without such a row it takes the unit's own scores and has no `clientKind` (spec §6.6 "Chapters").
  - `finalize` now returns `chapters` sorted by `(firstSeq, id)` and `coverage.approximateJoins`.
  - R25 (W0-6 declares the fields): every `Chapter` carries `current` (`status !== "superseded"`), `noise` (at least one joined edit and all of them lockfile or formatting-only, or `ChapterState.surfaceByUnit` holds `false`: the latest Pass A `jev_decision` row for the unit has `shouldSurface: false`) and `validationStepIds` (steps the unit's `validationResults` attached to, seq order).

Rules (R10, D11, spec §6.6): one chapter per unit id from its latest version; `link: "observed"` when a cited `fact_…` id matches a row `factId` or an `agentCallIds` entry matches a step `callId`, or when the unit cites neither kind of id; otherwise `inferred` via the widened time window (see "Spec alignment notes"). Validations, decisions (`relatedDecisions` and `affectedChangeUnits`) and Jev rows for the unit add steps but never decide the link. All rows of one decision id are one `decision` step (`step:<firstSeq>`); an answered or delegated row marks the turn `decisionAnswered`. A `jev_decision` with clamps is a `guardrail` step, one without is an `attention` step. The latest non-Pass-B `jev_decision` row whose `output` parses with `AttentionDecisionSchema` sets the chapter's `triad` and `triad.clientKind`. `change_unit`, `decision` and `jev_decision` rows inherit the clock.

- [ ] **Step 1: Write the failing test**

Create `packages/trace-viewer/src/model/fold-chapters.test.ts`:

```ts
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { fixtureEventsPath, loadFixtureTrace, stripCaptureFields } from "../test-support/fixture-rows.js";
import { TraceBuilder, testMeta } from "../test-support/trace-builder.js";
import { foldRows } from "./fold.js";
import type { Step, TraceSession } from "./types.js";

function fold(builder: TraceBuilder): TraceSession {
  return foldRows(testMeta(), builder.rows, { live: false });
}

function stepAt(session: TraceSession, seq: number): Step {
  const step = session.steps.find((candidate) => candidate.firstSeq === seq);
  if (step === undefined) throw new Error(`no step starts at seq ${seq}`);
  return step;
}

function editSession(): { builder: TraceBuilder; hunkSeq: number } {
  const b = new TraceBuilder();
  b.agent({ type: "agent_started", prompt: "p" });
  b.agent({ type: "file_changed", path: "src/a.ts", callId: "t:1" });
  const hunkSeq = b.fact(
    { type: "git_hunk", file: "src/a.ts", added: 3, removed: 1, isFormattingOnly: false, isConfigOnly: false, isLockfile: false },
    "fact_a",
  );
  return { builder: b, hunkSeq };
}

describe("chapters", () => {
  it("folds unit versions into one chapter from the latest version", () => {
    const { builder: b } = editSession();
    const first = b.unit({ id: "cu_1", files: ["src/a.ts"], title: "Draft", evidence: ["fact_a"] });
    const last = b.unit({ id: "cu_1", files: ["src/a.ts"], title: "Final", status: "validated", evidence: ["fact_a"] });
    const [chapter] = fold(b).chapters;
    expect(chapter).toMatchObject({
      id: "unit:cu_1",
      changeUnitId: "cu_1",
      title: "Final",
      status: "validated",
      versions: 2,
      firstSeq: first,
      lastSeq: last,
    });
  });

  it("links observed through row factIds", () => {
    const { builder: b, hunkSeq } = editSession();
    b.unit({ id: "cu_1", files: ["src/a.ts"], evidence: ["fact_a", "fact_missing", "se-1", "val_1"] });
    const session = fold(b);
    const [chapter] = session.chapters;
    expect(chapter).toMatchObject({
      link: "observed",
      evidenceLinks: { cited: 2, resolved: 1, approx: 0 },
      stepIds: ["step:2"],
      factSeqs: [hunkSeq],
      current: true,
      noise: false,
      validationStepIds: [],
    });
    expect(stepAt(session, 2).chapterIds).toEqual(["unit:cu_1"]);
    expect(session.entities[0]?.chapterIds).toEqual(["unit:cu_1"]);
    expect(session.coverage.approximateJoins).toBe(false);
  });

  it("links observed through agentCallIds", () => {
    const { builder: b } = editSession();
    b.unit({ id: "cu_1", files: ["src/a.ts"], evidence: ["fact_other"], agentCallIds: ["t:1"] });
    const [chapter] = fold(b).chapters;
    expect(chapter).toMatchObject({ link: "observed", stepIds: ["step:2"], evidenceLinks: { cited: 1, resolved: 0, approx: 0 } });
  });

  it("legacy session joins by time window", () => {
    const trace = loadFixtureTrace("oauth");
    const session = foldRows(trace.meta, stripCaptureFields(trace.rows), { live: false });
    const citing = session.chapters.filter((chapter) => chapter.evidenceLinks.cited > 0);
    expect(citing.length).toBeGreaterThan(0);
    for (const chapter of citing) {
      expect(chapter.link, chapter.title).toBe("inferred");
      expect(chapter.evidenceLinks.resolved, chapter.title).toBe(0);
      expect(chapter.evidenceLinks.approx, chapter.title).toBeGreaterThan(0);
      expect(chapter.stepIds.length, chapter.title).toBeGreaterThan(0);
    }
    expect(session.coverage.approximateJoins).toBe(true);
    expect(session.coverage.capabilities).not.toContain("fact_links");
  });

  it("falls back to a file's latest earlier edit when none is inside the unit window", () => {
    const { builder: b } = editSession();
    b.agent({ type: "agent_message", role: "assistant", text: "later", ts: TraceBuilder.at(60) });
    b.unit({ id: "cu_late", files: ["src/a.ts"], evidence: ["fact_gone"], createdAt: TraceBuilder.at(60), updatedAt: TraceBuilder.at(61) });
    const [chapter] = fold(b).chapters;
    expect(chapter).toMatchObject({ link: "inferred", stepIds: ["step:2"], evidenceLinks: { cited: 1, resolved: 0, approx: 1 } });
  });

  it("keeps a unit that cites no content ids observed", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.unit({ id: "cu_fail", files: ["tests/a.test.ts"], evidence: ["fail_1", "val_1"], status: "failed" });
    expect(fold(b).chapters[0]).toMatchObject({ link: "observed", evidenceLinks: { cited: 0, resolved: 0, approx: 0 }, status: "failed" });
  });

  it("matches the oauth expected_units.json file sets", () => {
    const trace = loadFixtureTrace("oauth");
    const session = foldRows(trace.meta, trace.rows, { live: false });
    const expectedPath = path.join(path.dirname(fixtureEventsPath("oauth")), "expected_units.json");
    const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as { id: string; category: string; files: string[] }[];
    const key = (files: readonly string[]) => [...files].sort().join("|");
    for (const unit of expected) {
      const match = session.chapters.find(
        (chapter) => key(chapter.files) === key(unit.files) && chapter.category === unit.category,
      );
      expect(match, unit.id).toBeDefined();
    }
  });
});

describe("decisions and Jev", () => {
  it("folds every row of one decision id into one step", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const first = b.decision({ id: "dec-oauth-0001", title: "Linking policy" });
    b.agent({ type: "agent_message", role: "user", text: "decision:\n  policy: b\n\ninstruction:\n  Use B." });
    const answer = b.decision({
      id: "dec-oauth-0001",
      title: "Linking policy",
      status: "answered",
      answer: { decisionId: "dec-oauth-0001", decision: { policy: "b" }, evidence: [] },
    });
    b.unit({ id: "cu_1", files: ["src/a.ts"], relatedDecisions: ["dec-oauth-0001"] });
    const session = fold(b);
    const step = stepAt(session, first);
    expect(session.steps.filter((candidate) => candidate.kind === "decision")).toHaveLength(1);
    expect(step).toMatchObject({ id: `step:${first}`, kind: "decision", lane: "supervisor", status: "ok", seqs: [first, answer] });
    expect(step.decision).toEqual({
      decisionId: "dec-oauth-0001",
      title: "Linking policy",
      severity: "required",
      status: "answered",
      options: [
        { id: "a", label: "Option A", chosen: false },
        { id: "b", label: "Option B", chosen: true },
      ],
      decidedBy: "supervisor",
    });
    expect(session.chapters[0]?.decisionIds).toEqual(["decision:dec-oauth-0001"]);
    expect(stepAt(session, 3).headline).toBe("Use B.");
  });

  it("keeps pipeline rows on the inherited clock", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p", ts: TraceBuilder.at(0) });
    b.agent({ type: "agent_message", role: "assistant", text: "a", ts: TraceBuilder.at(4) });
    // replay.db stamps decision and Jev rows with the replay run's wall clock, days later.
    const decision = b.decision({ id: "dec-1", ts: "2026-09-21T10:00:00.000Z" });
    const jev = b.jev({ id: "j", clamps: [], ts: "2026-09-21T10:00:01.000Z" });
    const after = b.agent({ type: "agent_message", role: "assistant", text: "b", ts: TraceBuilder.at(6) });
    const session = fold(b);
    expect(stepAt(session, decision)).toMatchObject({ tMs: 4_000, startTs: TraceBuilder.at(4) });
    expect(stepAt(session, jev).tMs).toBe(4_000);
    expect(stepAt(session, after).tMs).toBe(6_000);
    expect(session.span.durationMs).toBe(6_000);
  });

  it("marks a turn that stopped on an answered decision as waiting and the next one as resumed", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "agent_waiting" });
    b.decision({ id: "dec-1", status: "answered", answer: { decisionId: "dec-1", decision: { k: "a" }, evidence: [] } });
    b.agent({ type: "agent_started", prompt: "continue with A" });
    expect(fold(b).turns.map((turn) => [turn.trigger, turn.outcome])).toEqual([
      ["initial", "waiting"],
      ["resume", "unknown"],
    ]);
  });

  it("links a decision through affectedChangeUnits", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.decision({ id: "dec-1", affectedChangeUnits: ["cu_1"] });
    b.unit({ id: "cu_1", files: [] });
    expect(fold(b).chapters[0]?.decisionIds).toEqual(["decision:dec-1"]);
  });

  it("makes a guardrail step for a clamped jev_decision and an attention step otherwise", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const clamped = b.jev({ id: "jev_1", changeUnitId: "cu_1", clamps: ["schema_floor", "guardrail.security"], pass: "A" });
    const plain = b.jev({ id: "jev_2", changeUnitId: "cu_1", clamps: [] });
    b.unit({ id: "cu_1", files: [] });
    const session = fold(b);
    expect(stepAt(session, clamped)).toMatchObject({
      kind: "guardrail",
      lane: "jev",
      actor: "jevcode",
      headline: "Schema change kept visible, guardrail.security",
      guardrail: { clampIds: ["schema_floor", "guardrail.security"], changeUnitId: "cu_1", pass: "A", clientKind: "typesafe", confidence: 0.9 },
    });
    expect(stepAt(session, plain)).toMatchObject({ kind: "attention", headline: "Attention scored" });
    expect(session.chapters[0]).toMatchObject({
      clampIds: ["schema_floor", "guardrail.security"],
      stepIds: [`step:${clamped}`, `step:${plain}`],
    });
    expect(session.coverage.capabilities).toContain("jev_decisions");
  });

  it("takes the triad and client kind from the latest Pass A attention row, else from the unit", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const attention = (importance: number) => ({
      shouldSurface: true,
      importance,
      relevance: 0.5,
      interruption: 0.25,
      mentalModelChange: 0.1,
      semanticCategory: "behavior_change",
      scope: "module",
      humanDecision: "none",
      needsSystem2: false,
      confidence: 0.8,
      probabilities: {},
    });
    b.jev({ id: "jev_1", changeUnitId: "cu_jev", clamps: [], output: attention(0.2), clientKind: "degrade" });
    b.jev({ id: "jev_2", changeUnitId: "cu_jev", clamps: [], pass: "A", output: attention(0.9), clientKind: "typesafe" });
    // A Pass B row never feeds the triad, even when its output happens to parse.
    b.jev({ id: "jev_3", changeUnitId: "cu_jev", clamps: [], pass: "B", output: attention(0.1), clientKind: "playback" });
    b.jev({ id: "jev_4", changeUnitId: "cu_jev", clamps: [], output: { shouldSurface: false, clamps: [], guardrailSuppression: true } });
    b.unit({ id: "cu_jev", files: [], importance: 0.4 });
    b.unit({ id: "cu_plain", files: [], importance: 0.3, relevance: 0.6, interruption: 0.1 });
    const byUnit = new Map(fold(b).chapters.map((chapter) => [chapter.changeUnitId, chapter]));
    expect(byUnit.get("cu_jev")?.triad).toEqual({ importance: 0.9, relevance: 0.5, interruption: 0.25, clientKind: "typesafe" });
    expect(byUnit.get("cu_plain")?.triad).toEqual({ importance: 0.3, relevance: 0.6, interruption: 0.1 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/model/fold-chapters.test.ts`

Expected: `Tests  13 failed (13)`; for example `folds unit versions into one chapter from the latest version` fails with `expected undefined to match object { id: 'unit:cu_1', …(6) }`.

- [ ] **Step 3: Add the chapter state and the decision-answered turn flag**

In `packages/trace-viewer/src/model/fold-state.ts`, find:

```ts
import type {
  AgentInterruptReason,
  EventStoreType,
```

Replace it with:

```ts
import type {
  AgentInterruptReason,
  ChangeUnit,
  EventStoreType,
  JevClientKind,
```

In `packages/trace-viewer/src/model/fold-state.ts`, find:

```ts
  terminal: TerminalEvent | null;
  lastAgentEvent: NormalizedAgentEventType | null;
```

Replace it with:

```ts
  terminal: TerminalEvent | null;
  /** A decision row answered or delegated a decision in this turn. */
  decisionAnswered: boolean;
  lastAgentEvent: NormalizedAgentEventType | null;
```

In `packages/trace-viewer/src/model/fold-state.ts`, find:

```ts
    terminal: null,
    lastAgentEvent: null,
```

Replace it with:

```ts
    terminal: null,
    decisionAnswered: false,
    lastAgentEvent: null,
```

In `packages/trace-viewer/src/model/fold-state.ts`, find:

```ts
  const terminal = previous.terminal;
  if (terminal === null) return "steer";
```

Replace it with:

```ts
  const terminal = previous.terminal;
  // A turn that stopped on an answered decision resumes; one that just stopped was steered.
  if (terminal === null) return previous.decisionAnswered ? "resume" : "steer";
```

In `packages/trace-viewer/src/model/fold-state.ts`, find:

```ts
export class FoldState {
```

Replace it with:

```ts
export interface UnitEntry {
  /** The latest version. */
  unit: ChangeUnit;
  firstSeq: number;
  lastSeq: number;
  versions: number;
}

/** Scores and client kind of a unit's latest Pass A attention row (Chapter.triad, spec §6.6). */
export interface UnitAttention {
  importance: number;
  relevance: number;
  interruption: number;
  clientKind: JevClientKind;
}

export interface ChapterState {
  /** change unit id -> latest version, in first-seen order. */
  readonly units: Map<string, UnitEntry>;
  /** decision id -> its one decision step. */
  readonly decisionSteps: Map<string, StepDraft>;
  /** decision id -> affectedChangeUnits of its latest row. */
  readonly decisionUnits: Map<string, string[]>;
  /** change unit id -> guardrail and attention steps from jev_decision rows naming it. */
  readonly jevStepsByUnit: Map<string, StepDraft[]>;
  /** change unit id -> shouldSurface of its latest Pass A jev_decision row (Chapter.noise, R25). */
  readonly surfaceByUnit: Map<string, boolean>;
  /** change unit id -> its latest non-Pass-B row whose output parses with AttentionDecisionSchema
   *  (Chapter.triad, UI index §1.4 B-5). */
  readonly attentionByUnit: Map<string, UnitAttention>;
}

export class FoldState {
```

In `packages/trace-viewer/src/model/fold-state.ts`, find:

```ts
    validationSeqById: new Map(),
  };

  constructor(readonly meta: TraceSessionSummary) {
```

Replace it with:

```ts
    validationSeqById: new Map(),
  };
  readonly chapters: ChapterState = {
    units: new Map(),
    decisionSteps: new Map(),
    decisionUnits: new Map(),
    jevStepsByUnit: new Map(),
    surfaceByUnit: new Map(),
    attentionByUnit: new Map(),
  };

  constructor(readonly meta: TraceSessionSummary) {
```

- [ ] **Step 4: Write the chapter fold**

Create `packages/trace-viewer/src/model/fold-chapters.ts`:

```ts
import { AttentionDecisionSchema, type ChangeUnit, type Decision, type JevDecisionLog } from "@jevcode/contracts";

import {
  addRowToStep,
  createStep,
  currentTurn,
  touchTurn,
  type FoldState,
  type RowContext,
  type StepDraft,
  type UnitAttention,
} from "./fold-state.js";
import { clampMeta } from "./registry.js";
import {
  decisionStableId,
  unitStableId,
  type Chapter,
  type DecisionDetail,
  type DecisionStableId,
  type Entity,
  type Step,
  type StepId,
  type StepStatus,
} from "./types.js";

/** Fallback join window slack: the git collector polls every 5 s. */
export const APPROX_WINDOW_SLACK_MS = 5_000;

export function foldChangeUnit(state: FoldState, unit: ChangeUnit, ctx: RowContext): void {
  const entry = state.chapters.units.get(unit.id);
  if (entry === undefined) {
    state.chapters.units.set(unit.id, { unit, firstSeq: ctx.seq, lastSeq: ctx.seq, versions: 1 });
    return;
  }
  entry.unit = unit;
  entry.lastSeq = ctx.seq;
  entry.versions += 1;
}

function decisionDetail(decision: Decision): DecisionDetail {
  const chosen = new Set(Object.values(decision.answer?.decision ?? {}));
  const decidedBy =
    decision.status === "answered" ? "supervisor" : decision.status === "delegated" ? "delegated" : undefined;
  return {
    decisionId: decision.id,
    title: decision.title,
    severity: decision.severity,
    status: decision.status,
    options: decision.options.map((option) => ({ id: option.id, label: option.label, chosen: chosen.has(option.id) })),
    ...(decidedBy !== undefined ? { decidedBy } : {}),
  };
}

function decisionStatus(decision: Decision): StepStatus {
  return decision.status === "answered" || decision.status === "delegated" ? "ok" : "info";
}

/** Every row of one decision id folds into one step (step:<firstSeq>). */
export function foldDecision(state: FoldState, decision: Decision, ctx: RowContext): void {
  const turn = currentTurn(state, ctx);
  touchTurn(turn, ctx);
  state.chapters.decisionUnits.set(decision.id, [...decision.affectedChangeUnits]);
  if (decision.status === "answered" || decision.status === "delegated") turn.decisionAnswered = true;
  const existing = state.chapters.decisionSteps.get(decision.id);
  if (existing !== undefined) {
    addRowToStep(existing, ctx, false);
    existing.decision = decisionDetail(decision);
    existing.status = decisionStatus(decision);
    existing.endTs = ctx.sourceTs;
    existing.endTMs = ctx.t;
    existing.durationMs = ctx.t - existing.tMs;
    return;
  }
  const step = createStep(state, turn, ctx, {
    kind: "decision",
    source: "decision",
    status: decisionStatus(decision),
  });
  step.decision = decisionDetail(decision);
  state.chapters.decisionSteps.set(decision.id, step);
}

/** shouldSurface of a Pass A row (an attention decision or a guardrail suppression), else
 *  undefined. Pass B rows (UI intents) carry no shouldSurface. */
function passASurface(log: JevDecisionLog): boolean | undefined {
  if (log.pass === "B") return undefined;
  const output = log.output;
  if (typeof output !== "object" || output === null) return undefined;
  const surface = (output as { shouldSurface?: unknown }).shouldSurface;
  return typeof surface === "boolean" ? surface : undefined;
}

/** A jev_decision with clamps is a guardrail step; one without is an attention step. */
export function foldJevDecision(state: FoldState, log: JevDecisionLog, ctx: RowContext): void {
  state.capabilities.add("jev_decisions");
  const surface = passASurface(log);
  if (log.changeUnitId !== undefined && surface !== undefined) state.chapters.surfaceByUnit.set(log.changeUnitId, surface);
  if (log.changeUnitId !== undefined && log.pass !== "B") {
    // Chapter.triad (spec §6.6): the latest Pass A row that is a full attention decision.
    const attention = AttentionDecisionSchema.safeParse(log.output);
    if (attention.success) {
      state.chapters.attentionByUnit.set(log.changeUnitId, {
        importance: attention.data.importance,
        relevance: attention.data.relevance,
        interruption: attention.data.interruption,
        clientKind: log.clientKind,
      });
    }
  }
  const turn = currentTurn(state, ctx);
  touchTurn(turn, ctx);
  let step: StepDraft;
  if (log.clamps.length > 0) {
    step = createStep(state, turn, ctx, {
      kind: "guardrail",
      source: "jev_decision",
      status: "info",
      label: log.clamps.map((id) => clampMeta(id).label).join(", "),
    });
    step.guardrail = {
      clampIds: [...log.clamps],
      clientKind: log.clientKind,
      confidence: log.confidence,
      ...(log.changeUnitId !== undefined ? { changeUnitId: log.changeUnitId } : {}),
      ...(log.pass !== undefined ? { pass: log.pass } : {}),
    };
  } else {
    step = createStep(state, turn, ctx, { kind: "attention", source: "jev_decision", status: "info" });
  }
  if (log.changeUnitId !== undefined) {
    const list = state.chapters.jevStepsByUnit.get(log.changeUnitId);
    if (list === undefined) state.chapters.jevStepsByUnit.set(log.changeUnitId, [step]);
    else list.push(step);
  }
}

/** Unit createdAt/updatedAt are source (fact) times, so they sit on the clock's origin. */
function offset(origin: number, ts: string): number {
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed) || Number.isNaN(origin)) return 0;
  return Math.max(0, parsed - origin);
}

/** Edit steps per path, duplicate_poll steps left out; built once per finalize. */
function editsByPath(steps: readonly Step[], duplicates: ReadonlySet<string>): Map<string, Step[]> {
  const byPath = new Map<string, Step[]>();
  for (const step of steps) {
    if (step.kind !== "edit" || step.edit === undefined || duplicates.has(step.id)) continue;
    const list = byPath.get(step.edit.path);
    if (list === undefined) byPath.set(step.edit.path, [step]);
    else list.push(step);
  }
  return byPath;
}

/** D11: edit steps on unit.files inside [createdAt, updatedAt] widened by the slack; for a file
 *  with none there, its latest edit at or before the window's end. */
function approximateSteps(unit: ChangeUnit, edits: ReadonlyMap<string, Step[]>): Step[] {
  const from = Date.parse(unit.createdAt) - APPROX_WINDOW_SLACK_MS;
  const to = Date.parse(unit.updatedAt) + APPROX_WINDOW_SLACK_MS;
  const picked: Step[] = [];
  for (const file of new Set(unit.files)) {
    const candidates = edits.get(file) ?? [];
    let inWindow = 0;
    let latestBefore: Step | undefined;
    for (const step of candidates) {
      const t = Date.parse(step.startTs);
      if (!Number.isNaN(t) && t >= from && t <= to) {
        picked.push(step);
        inWindow += 1;
      }
      if (Number.isNaN(to) || Number.isNaN(t) || t <= to) latestBefore = step;
    }
    if (inWindow === 0 && latestBefore !== undefined) picked.push(latestBefore);
  }
  return picked;
}

/** Chapter.triad (spec §6.6): the latest Pass A attention row's scores and client kind, else the
 *  unit's own scores without a client kind. */
function triadOf(unit: ChangeUnit, attention: UnitAttention | undefined): Chapter["triad"] {
  if (attention !== undefined) return { ...attention };
  return {
    ...(unit.importance !== undefined ? { importance: unit.importance } : {}),
    ...(unit.relevance !== undefined ? { relevance: unit.relevance } : {}),
    ...(unit.interruption !== undefined ? { interruption: unit.interruption } : {}),
  };
}

/** True when the chapter joins at least one edit and every joined edit is a lockfile or a
 *  formatting-only change (R25). applySignals clears it for a chapter a finding names. */
function isNoiseChapter(
  stepIds: readonly StepId[],
  stepById: ReadonlyMap<StepId, Step>,
  duplicates: ReadonlySet<string>,
): boolean {
  let edits = 0;
  for (const stepId of stepIds) {
    const step = stepById.get(stepId);
    if (step?.edit === undefined || duplicates.has(step.id)) continue;
    if (!step.edit.lockfile && !step.edit.formattingOnly) return false;
    edits += 1;
  }
  return edits > 0;
}

/** One chapter per change unit, from its latest version (R10). Also fills step.chapterIds and
 *  entity.chapterIds. */
export function buildChapters(
  state: FoldState,
  steps: readonly Step[],
  stepById: ReadonlyMap<StepId, Step>,
  entities: readonly Entity[],
): Chapter[] {
  const evidence = state.evidence;
  const chapters = state.chapters;
  const origin = state.clock.origin;
  const edits = editsByPath(steps, evidence.duplicates);
  const entries = [...chapters.units.values()].sort(
    (a, b) => a.firstSeq - b.firstSeq || a.unit.id.localeCompare(b.unit.id),
  );
  const result: Chapter[] = [];
  for (const entry of entries) {
    const unit = entry.unit;
    const id = unitStableId(unit.id);
    const linked = new Set<StepId>();
    const pick = (draft: StepDraft | Step | undefined): void => {
      if (draft !== undefined) linked.add(draft.id);
    };
    const factIds = [...new Set(unit.evidence.filter((evidenceId) => evidenceId.startsWith("fact_")))];
    const resolvedSeqs: number[] = [];
    for (const factId of factIds) {
      const seq = evidence.factSeqById.get(factId);
      if (seq === undefined) continue;
      resolvedSeqs.push(seq);
      pick(evidence.stepByEvidenceSeq.get(seq));
    }
    let callLinks = 0;
    for (const callId of unit.agentCallIds ?? []) {
      const step = state.stepsByCallId.get(callId);
      if (step === undefined) continue;
      callLinks += 1;
      pick(step);
    }
    // Content-hash and call-id joins decide the link. A unit that cites neither (a failure-only
    // unit) is joined by plain ids below and stays observed.
    const citesJoins = factIds.length > 0 || (unit.agentCallIds ?? []).length > 0;
    const observed = !citesJoins || resolvedSeqs.length > 0 || callLinks > 0;
    const validationSteps = new Set<StepId>();
    for (const validationId of unit.validationResults) {
      const seq = evidence.validationSeqById.get(validationId);
      if (seq === undefined) continue;
      const draft = evidence.stepByEvidenceSeq.get(seq);
      pick(draft);
      if (draft !== undefined) validationSteps.add(draft.id);
    }
    const decisionIds: DecisionStableId[] = [];
    for (const [decisionId, draft] of chapters.decisionSteps) {
      const related = unit.relatedDecisions.includes(decisionId);
      const affected = chapters.decisionUnits.get(decisionId)?.includes(unit.id) ?? false;
      if (related || affected) {
        decisionIds.push(decisionStableId(decisionId));
        pick(draft);
      }
    }
    const clampIds: string[] = [];
    for (const draft of chapters.jevStepsByUnit.get(unit.id) ?? []) {
      pick(draft);
      for (const clampId of draft.guardrail?.clampIds ?? []) if (!clampIds.includes(clampId)) clampIds.push(clampId);
    }
    const factSeqs = new Set(resolvedSeqs);
    let approx = 0;
    if (!observed) {
      for (const step of approximateSteps(unit, edits)) {
        if (linked.has(step.id)) continue;
        approx += 1;
        linked.add(step.id);
        for (const seq of step.evidenceSeqs) factSeqs.add(seq);
      }
    }
    const stepIds = [...linked].sort((a, b) => (stepById.get(a)?.firstSeq ?? 0) - (stepById.get(b)?.firstSeq ?? 0));
    for (const stepId of stepIds) stepById.get(stepId)?.chapterIds.push(id);
    const tMs = offset(origin, unit.createdAt);
    result.push({
      id,
      changeUnitId: unit.id,
      title: unit.title,
      ...(unit.intent !== undefined ? { intent: unit.intent } : {}),
      category: unit.category,
      status: unit.status,
      current: unit.status !== "superseded",
      noise: isNoiseChapter(stepIds, stepById, evidence.duplicates) || chapters.surfaceByUnit.get(unit.id) === false,
      files: [...unit.files],
      link: observed ? "observed" : "inferred",
      evidenceLinks: { cited: factIds.length, resolved: resolvedSeqs.length, approx },
      firstSeq: entry.firstSeq,
      lastSeq: entry.lastSeq,
      versions: entry.versions,
      startTs: unit.createdAt,
      endTs: unit.updatedAt,
      tMs,
      endTMs: Math.max(tMs, offset(origin, unit.updatedAt)),
      stepIds,
      factSeqs: [...factSeqs].sort((a, b) => a - b),
      decisionIds,
      validationIds: [...unit.validationResults],
      validationStepIds: [...validationSteps].sort(
        (a, b) => (stepById.get(a)?.firstSeq ?? 0) - (stepById.get(b)?.firstSeq ?? 0),
      ),
      clampIds,
      triad: triadOf(unit, chapters.attentionByUnit.get(unit.id)),
      schemaChanges: unit.schemaChanges.map((change) => ({ ...change })),
      dependencyChanges: unit.dependencyChanges.map((change) => ({ ...change })),
      findingIds: [],
    });
  }
  const byPath = new Map(entities.map((entity) => [entity.path, entity]));
  for (const chapter of result) {
    for (const file of chapter.files) byPath.get(file)?.chapterIds.push(chapter.id);
  }
  return result;
}
```

- [ ] **Step 5: Wire it into `fold.ts`**

In `packages/trace-viewer/src/model/fold.ts`, find:

```ts
import { foldAgentEvent } from "./fold-agent.js";
import { buildEntities, foldEvidenceFact, foldValidation } from "./fold-evidence.js";
```

Replace it with:

```ts
import { foldAgentEvent } from "./fold-agent.js";
import { buildChapters, foldChangeUnit, foldDecision, foldJevDecision } from "./fold-chapters.js";
import { buildEntities, foldEvidenceFact, foldValidation } from "./fold-evidence.js";
```

In `packages/trace-viewer/src/model/fold.ts`, find:

```ts
  type Step,
  type StepStatus,
```

Replace it with:

```ts
  type Step,
  type StepId,
  type StepStatus,
```

In `packages/trace-viewer/src/model/fold.ts`, find:

```ts
    // The remaining consumed types are validated against their contracts schema here.
    case "change_unit":
      parseOrGap(s, row, ChangeUnitSchema);
      break;
    case "decision":
      parseOrGap(s, row, DecisionSchema);
      break;
    case "jev_decision":
      parseOrGap(s, row, JevDecisionLogSchema);
      break;
```

Replace it with:

```ts
    case "change_unit": {
      const unit = parseOrGap(s, row, ChangeUnitSchema);
      if (unit !== null) foldChangeUnit(s, unit, inheritedContext(s, row));
      break;
    }
    case "decision": {
      const decision = parseOrGap(s, row, DecisionSchema);
      if (decision !== null) foldDecision(s, decision, inheritedContext(s, row));
      break;
    }
    case "jev_decision": {
      const log = parseOrGap(s, row, JevDecisionLogSchema);
      if (log !== null) foldJevDecision(s, log, inheritedContext(s, row));
      break;
    }
```

In `packages/trace-viewer/src/model/fold.ts`, find:

```ts
  if (!isLast) return { outcome: "interrupted" };
```

Replace it with:

```ts
  if (!isLast) return { outcome: turn.decisionAnswered ? "waiting" : "interrupted" };
```

In `packages/trace-viewer/src/model/fold.ts`, find:

```ts
  steps.sort((a, b) => a.firstSeq - b.firstSeq);

  const entities = buildEntities(steps, s.evidence.duplicates);
```

Replace it with:

```ts
  steps.sort((a, b) => a.firstSeq - b.firstSeq);
  const stepById = new Map<StepId, Step>(steps.map((step) => [step.id, step]));

  const entities = buildEntities(steps, s.evidence.duplicates);
  const chapters = buildChapters(s, steps, stepById, entities);
```

In `packages/trace-viewer/src/model/fold.ts`, find:

```ts
    chapters: [],
```

Replace it with:

```ts
    chapters,
```

In `packages/trace-viewer/src/model/fold.ts`, find:

```ts
    coverage: coverageOf(s.capabilities, false, steps.filter((step) => step.provenance === "inferred").length),
```

Replace it with:

```ts
    coverage: coverageOf(
      s.capabilities,
      chapters.some((chapter) => chapter.link === "inferred"),
      steps.filter((step) => step.provenance === "inferred").length,
    ),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/model/fold-chapters.test.ts src/model/fold-evidence.test.ts src/model/fold.test.ts`

Expected: `Test Files  3 passed (3)`, `Tests  47 passed (47)`.

Run: `pnpm --filter @jevcode/trace-viewer typecheck`

Expected: exits 0.

- [ ] **Step 7: Root checks**

Run, in order, from `/Users/jwpark/Projects/jevcode-tv-b`:

```bash
pnpm -r build
pnpm -r typecheck
pnpm -r --workspace-concurrency=1 test
pnpm lint
```

Expected: each command exits 0. `pnpm -r build` includes `jevcode-trace-viewer-dev`, whose Vite plugin fails the build if any module reachable from `@jevcode/trace-viewer/model` imports a Node built-in (the browser-safety proof). `pnpm lint` prints nothing after `> pnpm exec eslint .`.

- [ ] **Step 8: Commit**

```bash
git add packages/trace-viewer/src/model/fold-chapters.ts \
  packages/trace-viewer/src/model/fold-chapters.test.ts \
  packages/trace-viewer/src/model/fold.ts \
  packages/trace-viewer/src/model/fold-state.ts
git commit -m "feat(trace-viewer): derive chapters, decision and guardrail steps"
```

### Task B-6: Problems, noise, `missing_evidence`, live semantics

**Files:**
- Create: `packages/trace-viewer/src/model/classify.ts`
- Test: `packages/trace-viewer/src/model/classify.test.ts`
- Modify: `packages/trace-viewer/src/model/fold.ts` (imports, `finalize`)

**Interfaces:**
- Consumes: B-1 `normalizeCommand`; B-2 `clampMeta`, `READ_TOOL`, `severityRank`; B-4 `FoldState.evidence.duplicates`; B-5 chapters. From `./types.js`: `PROBLEM_KINDS`, `type Chapter`, `type Gap`, `type NoiseReason`, `type ProblemKind`, `type Step`, `type Turn`.
- Produces (internal): `hasSevereClamp(step: Step): boolean` (a warning or critical clamp; B-7 uses it); `problemsOf(step: Step): ProblemKind[]`; `applyProblems(steps: readonly Step[]): void`; `isTurnClosed(turn: Turn, lastTurnIndex: number, live: boolean): boolean`; `flagMissingEvidence(steps: readonly Step[], turns: readonly Turn[], live: boolean, gaps: Gap[]): void`; `interface NoiseContext { duplicates: ReadonlySet<string>; chapters: readonly Chapter[] }`; `noiseOf(step, context, lastRuns, superseded): NoiseReason | null`; `applyNoise(steps: readonly Step[], context: NoiseContext): void`.

Rules (R10, R2): problems in `PROBLEM_KINDS` order: `exit_nonzero` (exit > 0 on command, test or check), `tests_failed`, `agent_failed` (failed lifecycle step), `destructive` (`command.destructivePattern`), `guardrail` (a clamp of warning or critical severity); `claim_contradicted` comes from B-7. `missing_evidence` only in closed turns (a terminal event, a later turn, or not live): a finished `test` step with no `test_result`, and an edit claim with no repo fact (that step becomes `unknown`). Noise: `read` (file reads and read-only tools), `lockfile`, `formatting`, `duplicate_poll`, `lifecycle` (lifecycle and attention steps, and guardrail steps whose clamps are all info, unknown ids included), `superseded` (edits whose chapters are all superseded), `passing_test` (a passing run that is not its command's final run); never on a step with a problem or a finding.

- [ ] **Step 1: Write the failing test**

Create `packages/trace-viewer/src/model/classify.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { TraceBuilder, testMeta } from "../test-support/trace-builder.js";
import { foldRows } from "./fold.js";
import type { Step, TraceSession } from "./types.js";

function fold(builder: TraceBuilder, live = false): TraceSession {
  return foldRows(testMeta(), builder.rows, { live });
}

function stepAt(session: TraceSession, seq: number): Step {
  const step = session.steps.find((candidate) => candidate.firstSeq === seq);
  if (step === undefined) throw new Error(`no step starts at seq ${seq}`);
  return step;
}

function run(b: TraceBuilder, command: string, exitCode: number): number {
  const seq = b.agent({ type: "command_started", command });
  b.agent({ type: "command_completed", command, exitCode, stdout: "", stderr: "" });
  return seq;
}

function tests(b: TraceBuilder, command: string, passed: number, failed: number): number {
  const seq = run(b, command, failed > 0 ? 1 : 0);
  b.fact({ type: "test_result", runner: "vitest", command, passed, failed, skipped: 0, failures: [] });
  return seq;
}

function edit(b: TraceBuilder, file: string, flags: { lockfile?: boolean; formatting?: boolean } = {}): number {
  return b.fact({
    type: "git_hunk",
    file,
    added: 1,
    removed: 1,
    isFormattingOnly: flags.formatting ?? false,
    isConfigOnly: false,
    isLockfile: flags.lockfile ?? false,
  });
}

describe("problems", () => {
  it("derives problems from exits, tests, lifecycle, destructive commands and guardrails", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const exit = run(b, "make", 2);
    const unknown = run(b, "make again", -1);
    const failing = tests(b, "pnpm test", 3, 1);
    const destructive = run(b, "rm -rf dist", 0);
    const warning = b.jev({ id: "j1", clamps: ["security_path"] });
    const info = b.jev({ id: "j2", clamps: ["suppress_formatting", "guardrail.security"] });
    const failed = b.agent({ type: "agent_failed", error: "boom" });
    const session = fold(b);
    expect(stepAt(session, exit).problems).toEqual(["exit_nonzero"]);
    expect(stepAt(session, unknown).problems).toEqual([]);
    expect(stepAt(session, failing).problems).toEqual(["exit_nonzero", "tests_failed"]);
    expect(stepAt(session, destructive).problems).toEqual(["destructive"]);
    expect(stepAt(session, destructive).command?.destructivePattern).toBe("rm-recursive-force");
    expect(stepAt(session, warning).problems).toEqual(["guardrail"]);
    expect(stepAt(session, info).problems).toEqual([]);
    expect(stepAt(session, failed).problems).toEqual(["agent_failed"]);
  });
});

describe("noise", () => {
  it("collapses reads, lockfiles, formatting, duplicate polls and lifecycle rows with reasons", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const read = b.agent({ type: "file_read", path: "src/a.ts" });
    const tool = b.agent({ type: "tool_started", tool: "read_file", input: "src/a.ts" });
    b.agent({ type: "tool_completed", tool: "read_file", output: "" });
    const other = b.agent({ type: "tool_started", tool: "apply_patch", input: "" });
    b.agent({ type: "tool_completed", tool: "apply_patch", output: "" });
    const lock = edit(b, "pnpm-lock.yaml", { lockfile: true });
    const format = edit(b, "src/format.ts", { formatting: true });
    const real = edit(b, "src/real.ts");
    const poll = edit(b, "src/real.ts");
    const waiting = b.agent({ type: "agent_waiting" });
    const attention = b.jev({ id: "j", clamps: [] });
    const failed = b.agent({ type: "agent_failed", error: "x" });
    const session = fold(b);
    expect(stepAt(session, read).noise).toBe("read");
    expect(stepAt(session, tool).noise).toBe("read");
    expect(stepAt(session, other).noise).toBeNull();
    expect(stepAt(session, lock).noise).toBe("lockfile");
    expect(stepAt(session, format).noise).toBe("formatting");
    expect(stepAt(session, real).noise).toBeNull();
    expect(stepAt(session, poll).noise).toBe("duplicate_poll");
    expect(stepAt(session, waiting).noise).toBe("lifecycle");
    expect(stepAt(session, attention).noise).toBe("lifecycle");
    expect(stepAt(session, failed)).toMatchObject({ problems: ["agent_failed"], noise: null });
  });

  it("collapses a guardrail step whose clamps are all info and keeps one with a warning clamp", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const routine = b.jev({ id: "j1", clamps: ["suppress_formatting", "suppress_lockfile"] });
    const unknown = b.jev({ id: "j2", clamps: ["guardrail.security"] });
    const warning = b.jev({ id: "j3", clamps: ["suppress_lockfile", "security_path"] });
    const session = fold(b);
    expect(stepAt(session, routine)).toMatchObject({ kind: "guardrail", problems: [], noise: "lifecycle" });
    expect(stepAt(session, unknown)).toMatchObject({ kind: "guardrail", problems: [], noise: "lifecycle" });
    expect(stepAt(session, warning)).toMatchObject({ kind: "guardrail", problems: ["guardrail"], noise: null });
  });

  it("collapses intermediate passing runs but never the final run or a failing run", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const early = tests(b, "pnpm test", 5, 0);
    const failing = tests(b, "pnpm test", 4, 1);
    const final = tests(b, "pnpm test", 5, 0);
    const session = fold(b);
    expect(stepAt(session, early).noise).toBe("passing_test");
    expect(stepAt(session, failing).noise).toBeNull();
    expect(stepAt(session, final).noise).toBeNull();
  });

  it("collapses edits whose chapters were all superseded", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const old = b.fact(
      { type: "git_hunk", file: "src/old.ts", added: 1, removed: 0, isFormattingOnly: false, isConfigOnly: false, isLockfile: false },
      "fact_old",
    );
    b.unit({ id: "cu_old", files: ["src/old.ts"], evidence: ["fact_old"], status: "superseded" });
    expect(stepAt(fold(b), old).noise).toBe("superseded");
  });
});

describe("missing evidence", () => {
  it("flags a finished test run without a test result once its turn is closed", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const bare = run(b, "pnpm test", 0);
    const backed = tests(b, "pnpm test", 2, 0);
    const session = fold(b);
    expect(session.gaps).toEqual([expect.objectContaining({ kind: "missing_evidence", atSeq: bare })]);
    expect(session.gaps.some((gap) => gap.atSeq === backed)).toBe(false);
  });

  it("flags an edit claim with no repo fact and leaves its status unknown", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const claim = b.agent({ type: "file_changed", path: "src/ghost.ts" });
    b.agent({ type: "agent_completed" });
    const session = fold(b);
    expect(stepAt(session, claim).status).toBe("unknown");
    expect(session.gaps).toEqual([expect.objectContaining({ kind: "missing_evidence", atSeq: claim })]);
  });

  it("raises nothing for the open turn of a live session", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    run(b, "pnpm test", 0);
    const claim = b.agent({ type: "file_changed", path: "src/pending.ts" });
    const live = fold(b, true);
    expect(live.gaps).toEqual([]);
    expect(stepAt(live, claim).status).toBe("ok");
    b.agent({ type: "agent_completed" });
    expect(fold(b, true).gaps.map((gap) => gap.kind)).toEqual(["missing_evidence", "missing_evidence"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/model/classify.test.ts`

Expected: `Tests  8 failed (8)`; the first is `derives problems from exits, tests, lifecycle, destructive commands and guardrails` with `expected [] to deeply equal [ 'exit_nonzero' ]`.

- [ ] **Step 3: Write the classifier**

Create `packages/trace-viewer/src/model/classify.ts`:

```ts
import { normalizeCommand } from "./format.js";
import { clampMeta, READ_TOOL, severityRank } from "./registry.js";
import {
  PROBLEM_KINDS,
  type Chapter,
  type Gap,
  type NoiseReason,
  type ProblemKind,
  type Step,
  type Turn,
} from "./types.js";

// Problems are orthogonal to kind; noise is never set on a step with a problem or a finding (R10).

function isRun(step: Step): boolean {
  return step.kind === "command" || step.kind === "test" || step.kind === "check";
}

/** A guardrail step with a warning or critical clamp (CLAMP_META; unknown ids are info). Only these
 *  carry the guardrail problem and a guardrail_clamp finding; an info-only step is lifecycle noise. */
export function hasSevereClamp(step: Step): boolean {
  return (step.guardrail?.clampIds ?? []).some((id) => severityRank(clampMeta(id).severity) >= severityRank("warning"));
}

/** Rule-derived problems of one step. claim_contradicted comes from the claim_contradicted signal. */
export function problemsOf(step: Step): ProblemKind[] {
  const found = new Set<ProblemKind>();
  const exitCode = step.command?.exitCode;
  if (isRun(step) && exitCode !== null && exitCode !== undefined && exitCode > 0) found.add("exit_nonzero");
  if (step.tests !== undefined && step.tests.failed > 0) found.add("tests_failed");
  if (step.kind === "lifecycle" && step.status === "failed") found.add("agent_failed");
  if (step.command?.destructivePattern !== undefined) found.add("destructive");
  if (step.kind === "guardrail" && hasSevereClamp(step)) found.add("guardrail");
  if (step.problems.includes("claim_contradicted")) found.add("claim_contradicted");
  return PROBLEM_KINDS.filter((kind) => found.has(kind));
}

export function applyProblems(steps: readonly Step[]): void {
  for (const step of steps) step.problems = problemsOf(step);
}

/** A turn is closed when it ended, a later turn exists, or the session is not live. */
export function isTurnClosed(turn: Turn, lastTurnIndex: number, live: boolean): boolean {
  return !live || turn.index < lastTurnIndex || turn.outcome === "completed" || turn.outcome === "failed" || turn.outcome === "interrupted";
}

/** missing_evidence (closed turns only): a finished test run with no test_result, or an agent
 *  edit claim with no repo fact by the end of its turn. */
export function flagMissingEvidence(steps: readonly Step[], turns: readonly Turn[], live: boolean, gaps: Gap[]): void {
  const lastTurnIndex = turns.length - 1;
  const closed = new Set(turns.filter((turn) => isTurnClosed(turn, lastTurnIndex, live)).map((turn) => turn.index));
  for (const step of steps) {
    if (!closed.has(step.turnIndex)) continue;
    if (step.kind === "test" && step.endTs !== null && step.tests === undefined) {
      gaps.push({
        kind: "missing_evidence",
        atSeq: step.firstSeq,
        message: `${step.target ?? "test run"} finished but no test result was recorded`,
      });
    }
    if (step.kind === "edit" && step.edit !== undefined && step.edit.claimed && !step.edit.observed) {
      step.status = "unknown";
      gaps.push({
        kind: "missing_evidence",
        atSeq: step.firstSeq,
        message: `the agent reported a change to ${step.edit.path} but no repository change was observed`,
      });
    }
  }
}

export interface NoiseContext {
  /** duplicate_poll edit steps. */
  duplicates: ReadonlySet<string>;
  chapters: readonly Chapter[];
}

function lastRunByTarget(steps: readonly Step[]): Map<string, Step> {
  const last = new Map<string, Step>();
  for (const step of steps) {
    if ((step.kind === "test" || step.kind === "check") && step.target !== undefined) {
      last.set(normalizeCommand(step.target), step);
    }
  }
  return last;
}

export function noiseOf(step: Step, context: NoiseContext, lastRuns: ReadonlyMap<string, Step>, superseded: ReadonlySet<string>): NoiseReason | null {
  switch (step.kind) {
    case "read":
      return "read";
    case "tool":
      return step.target !== undefined && READ_TOOL.test(step.target) ? "read" : null;
    case "edit": {
      if (context.duplicates.has(step.id)) return "duplicate_poll";
      if (step.edit?.lockfile === true) return "lockfile";
      if (step.edit?.formattingOnly === true) return "formatting";
      if (step.chapterIds.length > 0 && step.chapterIds.every((id) => superseded.has(id))) return "superseded";
      return null;
    }
    case "lifecycle":
    case "attention":
      return "lifecycle";
    case "guardrail":
      // Routine suppress_formatting and suppress_lockfile rows collapse (spec §6.6, §6.7).
      return hasSevereClamp(step) ? null : "lifecycle";
    case "test":
    case "check": {
      if (step.status !== "ok" || step.target === undefined) return null;
      const last = lastRuns.get(normalizeCommand(step.target));
      return last !== undefined && last.id !== step.id ? "passing_test" : null;
    }
    default:
      return null;
  }
}

/** Runs after signals: a step with a problem or a finding never collapses. */
export function applyNoise(steps: readonly Step[], context: NoiseContext): void {
  const lastRuns = lastRunByTarget(steps);
  const superseded = new Set(context.chapters.filter((chapter) => chapter.status === "superseded").map((chapter) => chapter.id));
  for (const step of steps) {
    step.noise =
      step.problems.length > 0 || step.findingIds.length > 0 ? null : noiseOf(step, context, lastRuns, superseded);
  }
}
```

- [ ] **Step 4: Wire it into `finalize`**

In `packages/trace-viewer/src/model/fold.ts`, find:

```ts
import type { z } from "zod";

import { foldAgentEvent } from "./fold-agent.js";
```

Replace it with:

```ts
import type { z } from "zod";

import { applyNoise, applyProblems, flagMissingEvidence } from "./classify.js";
import { foldAgentEvent } from "./fold-agent.js";
```

In `packages/trace-viewer/src/model/fold.ts`, find:

```ts
  const chapters = buildChapters(s, steps, stepById, entities);
```

Replace it with:

```ts
  const chapters = buildChapters(s, steps, stepById, entities);
  applyProblems(steps);
  flagMissingEvidence(steps, turns, live, gaps);
  applyNoise(steps, { duplicates: s.evidence.duplicates, chapters });
```

- [ ] **Step 5: Run the tests to verify they pass**

The B-3 `fold.test.ts` cases "maps exit codes" and "interrupted turn leaves the open command unknown" now also exercise the problem rules (no `exit_nonzero` for exit −1, no `agent_failed` on an interrupt).

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/model`

Expected: no failures; `src/model/classify.test.ts (8 tests)` is listed. The lane-B files hold 141 tests at this point; W0's `types.test.ts` adds its own.

Run: `pnpm --filter @jevcode/trace-viewer typecheck`

Expected: exits 0.

- [ ] **Step 6: Root checks**

Run, in order, from `/Users/jwpark/Projects/jevcode-tv-b`:

```bash
pnpm -r build
pnpm -r typecheck
pnpm -r --workspace-concurrency=1 test
pnpm lint
```

Expected: each command exits 0. `pnpm -r build` includes `jevcode-trace-viewer-dev`, whose Vite plugin fails the build if any module reachable from `@jevcode/trace-viewer/model` imports a Node built-in (the browser-safety proof). `pnpm lint` prints nothing after `> pnpm exec eslint .`.

- [ ] **Step 7: Commit**

```bash
git add packages/trace-viewer/src/model/classify.ts \
  packages/trace-viewer/src/model/classify.test.ts \
  packages/trace-viewer/src/model/fold.ts
git commit -m "feat(trace-viewer): classify problems, noise and missing evidence"
```

### Task B-7: Signal registry, the five v1 signals, coverage

**Files:**
- Create: `packages/trace-viewer/src/model/signals.ts`
- Test: `packages/trace-viewer/src/model/signals.test.ts`
- Modify: `packages/trace-viewer/src/model/fold.ts` (imports, `coverageOf` removed, end of `finalize`), `packages/trace-viewer/src/model/index.ts` (append one line)

**Interfaces:**
- Consumes: B-1 `normalizeCommand`; B-2 `clampMeta`, `severityRank`; B-4 `TestDetail.resultSeq`; B-6 `hasSevereClamp(step)`; B-3 to B-6 the public `Step`, `Turn`, `Chapter` built by `finalize` (steps sorted by `firstSeq`; `step.noise` already set). From `./types.js`: `CAPABILITIES`, `SIGNAL_IDS`, `findingStableId(ruleId, ruleVersion, anchorSeq)`, `unitStableId`, and the types `Capability`, `ClaimObservation`, `Coverage`, `Finding`, `Severity`, `SignalCoverage`, `SignalId`, `SignalMeta`, `Step`, `StepId`, `TraceSession`, `UnitStableId`.
- Produces (exported from `@jevcode/trace-viewer/model`, index §2.6): `interface SignalInput { session: Omit<TraceSession, "findings" | "coverage"> }`; `interface FindingDraft { anchorSeq; anchorStepId; severity; headline; reason; stepIds; chapterIds; evidenceSeqs; claim?; claimStepId?; evidenceStepIds?; claimSpan?; matchedPattern?; clampId? }` (R25: every rule sets `anchorStepId`, one of its `stepIds`; B-12 sets the three claim fields); `interface SignalRule extends SignalMeta { evaluate(input: SignalInput): FindingDraft[] }`; `SIGNALS: { readonly [K in SignalId]: SignalRule & { readonly id: K } }`; `signalMeta(id: SignalId): SignalMeta`; additions `isSuccessClaim(text: string): boolean`, `computeCoverage(capabilities: ReadonlySet<Capability>, approximateJoins: boolean, inferredSteps: number): Coverage`, `applySignals(input: SignalInput, coverage: Coverage): Finding[]`; UI index §1.4 B-7: `FINDING_RULE_RANK: { readonly [K in SignalId]: number }` (`claim_contradicted` 0, `destructive_command` 1, `failing_tests` 2, `guardrail_clamp` 3, `recovery_arc` 4) and `compareFindings(a: Finding, b: Finding): number` (severity critical > warning > info, then `FINDING_RULE_RANK`, then `anchorSeq` ascending, then `id`; spec §6.7 `FINDING_ORDER`).
- `finalize` now returns `findings` sorted by `(anchorSeq, id)` (R8) and real `coverage`; the UI sorts a copy with `compareFindings` for the initial selection and a spine row's finding. Only active signals are evaluated; each finding un-collapses the steps it names, and a contradicted claim step gains the `claim_contradicted` problem. Every finding's `anchorStepId` names the step whose `seqs` hold its `anchorSeq`.

Rules (R11; order per spec §6.7 `FINDING_ORDER` through `compareFindings`): `claim_contradicted` (critical; the claim is contradicted when any test or check command's latest run before it failed, the adopted per-command rule in "Spec alignment notes"; anchor = the claim step; cites the most recent such failed run's `test_result` seq and the claim seq), `failing_tests` (warning, critical when that command's final run failed; anchor = the `test_result` seq), `destructive_command` (critical; `matchDestructive`), `guardrail_clamp` (one finding per Jev row with a warning or critical clamp; severity and headline from the most severe clamp; a row whose clamps are all info, unknown ids included, raises none, and B-6 makes its step `lifecycle` noise), `recovery_arc` (info; fail, then an edit that is not a duplicate poll, then the same command passes; anchor = the passing run).

- [ ] **Step 1: Write the failing test**

Create `packages/trace-viewer/src/model/signals.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { loadFixtureTrace } from "../test-support/fixture-rows.js";
import { TraceBuilder, testMeta } from "../test-support/trace-builder.js";
import { foldRows } from "./fold.js";
import { compareFindings, FINDING_RULE_RANK, isSuccessClaim, SIGNALS, signalMeta } from "./signals.js";
import {
  findingStableId,
  SIGNAL_IDS,
  stepStableId,
  type Finding,
  type Severity,
  type SignalId,
  type TraceSession,
} from "./types.js";

function fold(builder: TraceBuilder, live = false): TraceSession {
  return foldRows(testMeta(), builder.rows, { live });
}

function findingsOf(session: TraceSession, ruleId: SignalId): Finding[] {
  return session.findings.filter((finding) => finding.ruleId === ruleId);
}

function testRun(b: TraceBuilder, passed: number, failed: number, command = "pnpm test"): { start: number; result: number } {
  const start = b.agent({ type: "command_started", command });
  b.agent({ type: "command_completed", command, exitCode: failed > 0 ? 1 : 0, stdout: "", stderr: "" });
  const result = b.fact({ type: "test_result", runner: "vitest", command, passed, failed, skipped: 0, failures: [] });
  return { start, result };
}

function editFile(b: TraceBuilder, file: string, added: number): number {
  return b.fact({ type: "git_hunk", file, added, removed: 0, isFormattingOnly: false, isConfigOnly: false, isLockfile: false });
}

describe("signal registry", () => {
  it("has complete metadata for every signal id", () => {
    for (const id of SIGNAL_IDS) {
      const rule = SIGNALS[id];
      expect(rule.id).toBe(id);
      expect(rule.version).toBeGreaterThanOrEqual(1);
      expect(rule.title.length).toBeGreaterThan(0);
      expect(rule.rationale.length).toBeGreaterThan(0);
      expect(rule.knownFalsePositives.length).toBeGreaterThan(0);
      expect(rule.requires.length).toBeGreaterThan(0);
      expect(signalMeta(id)).not.toHaveProperty("evaluate");
    }
  });

  it("lists guardrail_clamp inactive on a fixture fold", () => {
    const trace = loadFixtureTrace("oauth");
    const session = foldRows(trace.meta, trace.rows, { live: false });
    expect(session.coverage.signals).toContainEqual({ id: "guardrail_clamp", active: false, missing: ["jev_decisions"] });
    expect(session.coverage.signals.map((signal) => signal.id)).toEqual([...SIGNAL_IDS]);
  });
});

describe("success claim lexicon", () => {
  it.each([
    ["OAuth implementation complete; all checks pass.", true],
    ["The endpoint change is complete and all tests pass.", true],
    ["143 tests pass (128 existing, 12 new).", true],
    ["All tests pass with no failures.", true],
    ["Not all tests pass yet.", false],
    ["Tests pass except the flaky one.", false],
    ["I haven't finished the migration.", false],
    ["Dependencies swapped; formatting noise included.", false],
    ["Running the tests now.", false],
    ["The migration is done.", true],
    ["I'm done reading the file, next I will complete the setup.", false],
    ["The migration is not complete.", false],
  ])("%s -> %s", (text, expected) => {
    expect(isSuccessClaim(text)).toBe(expected);
  });
});

describe("claim_contradicted", () => {
  it("fires when the last success claim follows a failed run and cites both rows", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const run = testRun(b, 14, 1);
    const claim = b.agent({ type: "agent_message", role: "assistant", text: "Done; all checks pass." });
    const session = fold(b);
    const [finding] = findingsOf(session, "claim_contradicted");
    expect(finding).toMatchObject({
      id: `finding:claim_contradicted@1:${claim}`,
      severity: "critical",
      anchorSeq: claim,
      anchorStepId: `step:${claim}`,
      evidenceSeqs: [run.result, claim],
      stepIds: [`step:${run.start}`, `step:${claim}`],
    });
    expect(finding?.claim?.claim).toMatchObject({ seq: claim, stepId: `step:${claim}`, text: "Done; all checks pass." });
    expect(finding?.claim?.observed).toMatchObject({ seq: run.result, passed: 14, failed: 1, command: "pnpm test" });
    const claimStep = session.steps.find((step) => step.firstSeq === claim);
    expect(claimStep?.problems).toEqual(["claim_contradicted"]);
    expect(claimStep?.findingIds).toEqual([finding?.id]);
  });

  it("does not fire on a negated claim or after a later passing run", () => {
    const negated = new TraceBuilder();
    negated.agent({ type: "agent_started", prompt: "p" });
    testRun(negated, 14, 1);
    negated.agent({ type: "agent_message", role: "assistant", text: "Not all tests pass yet." });
    expect(findingsOf(fold(negated), "claim_contradicted")).toEqual([]);

    const fixed = new TraceBuilder();
    fixed.agent({ type: "agent_started", prompt: "p" });
    testRun(fixed, 14, 1);
    testRun(fixed, 15, 0);
    fixed.agent({ type: "agent_message", role: "assistant", text: "All tests pass." });
    expect(findingsOf(fold(fixed), "claim_contradicted")).toEqual([]);
  });

  it("compares with the latest run of every command, so a later passing check does not hide a failed test run", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const tests = testRun(b, 14, 1);
    b.agent({ type: "command_started", command: "pnpm lint" });
    b.agent({ type: "command_completed", command: "pnpm lint", exitCode: 0, stdout: "", stderr: "" });
    const claim = b.agent({ type: "agent_message", role: "assistant", text: "All checks pass." });
    const [finding] = findingsOf(fold(b), "claim_contradicted");
    expect(finding).toMatchObject({
      anchorSeq: claim,
      evidenceSeqs: [tests.result, claim],
      stepIds: [`step:${tests.start}`, `step:${claim}`],
    });
    expect(finding?.claim?.observed).toMatchObject({ command: "pnpm test", failed: 1 });
  });

  it("does not count a failed command that only mentions a check word as a failed check", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    testRun(b, 5, 0);
    const grep = b.agent({ type: "command_started", command: "grep -r build src" });
    b.agent({ type: "command_completed", command: "grep -r build src", exitCode: 1, stdout: "", stderr: "" });
    b.agent({ type: "agent_message", role: "assistant", text: "All checks pass." });
    const session = fold(b);
    expect(session.steps.find((step) => step.firstSeq === grep)).toMatchObject({ kind: "command", problems: ["exit_nonzero"] });
    expect(findingsOf(session, "claim_contradicted")).toEqual([]);
  });

  it("fires on oauth and api-break and not on the green fixtures", () => {
    const fired = (name: "oauth" | "api-break" | "rate-limit" | "schema-change" | "dep-change") => {
      const trace = loadFixtureTrace(name);
      return findingsOf(foldRows(trace.meta, trace.rows, { live: false }), "claim_contradicted").length;
    };
    expect(fired("oauth")).toBe(1);
    expect(fired("api-break")).toBe(1);
    expect(fired("rate-limit")).toBe(0);
    expect(fired("schema-change")).toBe(0);
    expect(fired("dep-change")).toBe(0);
  });
});

describe("failing_tests", () => {
  it("is critical when the final run still fails and a warning when a later run passed", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const fixedRun = testRun(b, 4, 1, "pnpm test");
    testRun(b, 5, 0, "pnpm test");
    const brokenRun = testRun(b, 1, 2, "pnpm test:e2e");
    const session = fold(b);
    const findings = findingsOf(session, "failing_tests");
    expect(findings.map((finding) => [finding.anchorSeq, finding.severity])).toEqual([
      [fixedRun.result, "warning"],
      [brokenRun.result, "critical"],
    ]);
  });

  it("does not treat an unknown exit code as a failing test", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "command_started", command: "pnpm test" });
    b.agent({ type: "command_completed", command: "pnpm test", exitCode: -1, stdout: "", stderr: "" });
    b.fact({ type: "test_result", runner: "vitest", command: "pnpm test", passed: 0, failed: 0, skipped: 0, failures: [] });
    expect(findingsOf(fold(b), "failing_tests")).toEqual([]);
  });
});

describe("destructive_command", () => {
  it("fires on a matched pattern and names it", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const seq = b.agent({ type: "command_started", command: "git reset --hard HEAD~1" });
    b.agent({ type: "command_completed", command: "git reset --hard HEAD~1", exitCode: 0, stdout: "", stderr: "" });
    const [finding] = findingsOf(fold(b), "destructive_command");
    expect(finding).toMatchObject({ anchorSeq: seq, severity: "critical", matchedPattern: "git-reset-hard" });
  });

  it("does not fire on a plain git reset", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "command_started", command: "git reset HEAD src/a.ts" });
    b.agent({ type: "command_completed", command: "git reset HEAD src/a.ts", exitCode: 0, stdout: "", stderr: "" });
    expect(findingsOf(fold(b), "destructive_command")).toEqual([]);
  });
});

describe("guardrail_clamp", () => {
  it("raises one finding per row at its most severe clamp", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const severe = b.jev({ id: "j1", changeUnitId: "cu_1", clamps: ["suppress_lockfile", "destructive_command"] });
    const warning = b.jev({ id: "j2", changeUnitId: "cu_1", clamps: ["guardrail.security", "public_api"] });
    b.unit({ id: "cu_1", files: [] });
    const session = fold(b);
    const findings = findingsOf(session, "guardrail_clamp");
    expect(findings.map((finding) => [finding.anchorSeq, finding.severity, finding.clampId, finding.headline])).toEqual([
      [severe, "critical", "destructive_command", "Destructive command"],
      [warning, "warning", "public_api", "Public API change kept visible"],
    ]);
    expect(findings[0]?.chapterIds).toEqual(["unit:cu_1"]);
    expect(session.chapters[0]?.findingIds).toEqual(findings.map((finding) => finding.id));
  });

  it("raises none for a row whose clamps are all info, including an unknown id, and lets its step collapse", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const routine = b.jev({ id: "j1", changeUnitId: "cu_1", clamps: ["suppress_formatting", "suppress_lockfile"] });
    const unknown = b.jev({ id: "j2", changeUnitId: "cu_1", clamps: ["guardrail.security"] });
    b.unit({ id: "cu_1", files: [] });
    const session = fold(b);
    expect(session.coverage.signals).toContainEqual({ id: "guardrail_clamp", active: true, missing: [] });
    expect(findingsOf(session, "guardrail_clamp")).toEqual([]);
    for (const seq of [routine, unknown]) {
      expect(session.steps.find((step) => step.firstSeq === seq)).toMatchObject({
        kind: "guardrail",
        problems: [],
        findingIds: [],
        noise: "lifecycle",
      });
    }
    expect(session.chapters[0]?.findingIds).toEqual([]);
  });
});

describe("recovery_arc", () => {
  it("fires on fail, edit, then the same command passing", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const failed = testRun(b, 4, 1);
    const edit = editFile(b, "src/fix.ts", 3);
    const passed = testRun(b, 5, 0);
    const [finding] = findingsOf(fold(b), "recovery_arc");
    expect(finding).toMatchObject({
      anchorSeq: passed.result,
      severity: "info",
      stepIds: [`step:${failed.start}`, `step:${edit}`, `step:${passed.start}`],
      evidenceSeqs: [failed.result, passed.result],
    });
  });

  it("does not fire when nothing was edited between the failure and the pass", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    testRun(b, 4, 1);
    testRun(b, 5, 0);
    expect(findingsOf(fold(b), "recovery_arc")).toEqual([]);
  });

  it("keeps the passing run of an arc from collapsing", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    testRun(b, 4, 1);
    editFile(b, "src/fix.ts", 3);
    const passed = testRun(b, 5, 0);
    testRun(b, 5, 0);
    const step = fold(b).steps.find((candidate) => candidate.firstSeq === passed.start);
    expect(step?.findingIds).toHaveLength(1);
    expect(step?.noise).toBeNull();
  });
});

describe("finding order and anchors", () => {
  function finding(ruleId: SignalId, severity: Severity, anchorSeq: number): Finding {
    return {
      id: findingStableId(ruleId, 1, anchorSeq),
      ruleId,
      ruleVersion: 1,
      severity,
      anchorSeq,
      anchorStepId: stepStableId(anchorSeq),
      headline: "",
      reason: "",
      stepIds: [stepStableId(anchorSeq)],
      chapterIds: [],
      evidenceSeqs: [anchorSeq],
    };
  }

  it("sorts by severity, then rule rank, then anchor seq (spec §6.7 FINDING_ORDER)", () => {
    expect(Object.keys(FINDING_RULE_RANK).sort()).toEqual([...SIGNAL_IDS].sort());
    const input = [
      finding("recovery_arc", "info", 1),
      finding("failing_tests", "critical", 46),
      finding("guardrail_clamp", "warning", 3),
      finding("claim_contradicted", "critical", 48),
      finding("destructive_command", "critical", 50),
      finding("failing_tests", "critical", 12),
      finding("guardrail_clamp", "critical", 2),
    ];
    expect([...input].sort(compareFindings).map((item) => item.id)).toEqual([
      "finding:claim_contradicted@1:48",
      "finding:destructive_command@1:50",
      "finding:failing_tests@1:12",
      "finding:failing_tests@1:46",
      "finding:guardrail_clamp@1:2",
      "finding:guardrail_clamp@1:3",
      "finding:recovery_arc@1:1",
    ]);
  });

  it("puts the contradiction first on oauth and api-break, where failing_tests is also critical and earlier", () => {
    for (const name of ["oauth", "api-break"] as const) {
      const trace = loadFixtureTrace(name);
      const findings = foldRows(trace.meta, trace.rows, { live: false }).findings;
      expect(findings.map((item) => [item.ruleId, item.severity]), name).toEqual([
        ["failing_tests", "critical"],
        ["claim_contradicted", "critical"],
      ]);
      expect([...findings].sort(compareFindings)[0]?.ruleId, name).toBe("claim_contradicted");
    }
  });

  it("anchors every finding on the step that holds its anchor seq", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    testRun(b, 4, 1);
    editFile(b, "src/fix.ts", 3);
    testRun(b, 5, 0);
    b.agent({ type: "command_started", command: "rm -rf dist" });
    b.agent({ type: "command_completed", command: "rm -rf dist", exitCode: 0, stdout: "", stderr: "" });
    b.jev({ id: "j1", clamps: ["schema_floor"] });
    const fixtures = (["oauth", "api-break"] as const).map((name) => {
      const trace = loadFixtureTrace(name);
      return foldRows(trace.meta, trace.rows, { live: false });
    });
    const rules = new Set<SignalId>();
    for (const session of [fold(b), ...fixtures]) {
      for (const item of session.findings) {
        rules.add(item.ruleId);
        const anchor = session.steps.find((step) => step.id === item.anchorStepId);
        expect(anchor?.seqs, item.id).toContain(item.anchorSeq);
        expect(item.stepIds, item.id).toContain(item.anchorStepId);
      }
    }
    expect([...rules].sort()).toEqual([...SIGNAL_IDS].sort());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/model/signals.test.ts`

Expected: FAIL, `Error: Cannot find module './signals.js' imported from '…/src/model/signals.test.ts'`, `Tests  no tests`.

- [ ] **Step 3: Write the signals**

Create `packages/trace-viewer/src/model/signals.ts`:

```ts
import { hasSevereClamp } from "./classify.js";
import { normalizeCommand } from "./format.js";
import { clampMeta, severityRank } from "./registry.js";
import {
  CAPABILITIES,
  SIGNAL_IDS,
  findingStableId,
  unitStableId,
  type Capability,
  type ClaimObservation,
  type Coverage,
  type Finding,
  type Severity,
  type SignalCoverage,
  type SignalId,
  type SignalMeta,
  type Step,
  type StepId,
  type TraceSession,
  type UnitStableId,
} from "./types.js";

export interface SignalInput {
  session: Omit<TraceSession, "findings" | "coverage">;
}

export interface FindingDraft {
  anchorSeq: number;
  /** One of stepIds (R25). */
  anchorStepId: StepId;
  severity: Severity;
  headline: string;
  reason: string;
  stepIds: StepId[];
  chapterIds: UnitStableId[];
  evidenceSeqs: number[];
  claim?: ClaimObservation;
  /** claim_contradicted only (R25; set in B-12). */
  claimStepId?: StepId;
  evidenceStepIds?: StepId[];
  claimSpan?: [number, number];
  matchedPattern?: string;
  clampId?: string;
}

export interface SignalRule extends SignalMeta {
  evaluate(input: SignalInput): FindingDraft[];
}

// ------------------------------------------------------------ shared helpers

function isRun(step: Step): boolean {
  return step.kind === "test" || step.kind === "check";
}

function runFailed(step: Step): boolean {
  return step.status === "failed";
}

function runPassed(step: Step): boolean {
  return step.status === "ok" && (step.tests === undefined || step.tests.failed === 0);
}

/** seq of the test_result behind a run, else its first row. */
function runSeq(step: Step): number {
  return step.tests?.resultSeq ?? step.firstSeq;
}

function sortedUnique(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function sortStepIds(ids: readonly StepId[], steps: ReadonlyMap<StepId, Step>): StepId[] {
  return [...new Set(ids)].sort((a, b) => (steps.get(a)?.firstSeq ?? 0) - (steps.get(b)?.firstSeq ?? 0));
}

// ------------------------------------------------------------ claim lexicon (R10)

/** Success phrases that count anywhere in a clause. */
const SUCCESS_PHRASE =
  /\b(?:all (?:tests|checks)(?: are)? (?:pass(?:ing|ed)?|green)|(?:tests?|checks?|suite|build) (?:pass(?:es|ed)?|(?:is |are )?passing|(?:is |are )?green)|passing tests|everything (?:works|passes|is green)|all green)\b/gi;

/** Completion words count only at the end of a clause ("OAuth implementation complete"), so
 *  "I'm done reading the file" and "next I will complete the setup" are not claims. */
const SUCCESS_STATE = /\b(?:complete|completed|done|finished)\s*$/gi;

const NEGATION_BEFORE = /\b(?:not|never|no|none|cannot|without)\b|n't\b/i;

const NEGATION_AFTER = /^\W*(?:except|but|apart from|other than)\b/i;

/** True when some clause of text claims success without a negation (R10). */
export function isSuccessClaim(text: string): boolean {
  for (const clause of text.split(/[.;!?\n]+/)) {
    for (const pattern of [SUCCESS_PHRASE, SUCCESS_STATE]) {
      for (const match of clause.matchAll(pattern)) {
        const before = clause.slice(0, match.index);
        const after = clause.slice(match.index + match[0].length);
        if (!NEGATION_BEFORE.test(before) && !NEGATION_AFTER.test(after)) return true;
      }
    }
  }
  return false;
}

// ------------------------------------------------------------ the five v1 signals (R11)

const claimContradicted: SignalRule & { readonly id: "claim_contradicted" } = {
  id: "claim_contradicted",
  version: 1,
  severity: "critical",
  title: "Claim contradicted by evidence",
  rationale:
    "The agent's last success claim in a turn is compared with the latest earlier run of each test or check command; a failed run contradicts it.",
  knownFalsePositives: [
    "A claim about a subset of the suite (\"the new tests pass\") while an unrelated run still fails.",
    "Before M1a, reasoning text was stored as assistant messages (packages/agent-codex/src/jsonl.ts:178-189), so a thought can read as a claim.",
  ],
  requires: ["agent_messages", "test_results"],
  evaluate({ session }) {
    const stepById = new Map(session.steps.map((step) => [step.id, step]));
    // The last success claim of each turn.
    const claimIds = new Set<StepId>();
    for (const turn of session.turns) {
      for (let index = turn.stepIds.length - 1; index >= 0; index -= 1) {
        const step = stepById.get(turn.stepIds[index] as StepId);
        if (step !== undefined && step.kind === "message" && isSuccessClaim(step.text ?? "")) {
          claimIds.add(step.id);
          break;
        }
      }
    }
    // One pass in seq order: the latest run of each command seen so far.
    const latestByTarget = new Map<string, Step>();
    const drafts: FindingDraft[] = [];
    for (const step of session.steps) {
      if (isRun(step) && step.target !== undefined) {
        latestByTarget.set(normalizeCommand(step.target), step);
        continue;
      }
      if (!claimIds.has(step.id)) continue;
      const failed = [...latestByTarget.values()].filter(runFailed).sort((a, b) => runSeq(b) - runSeq(a))[0];
      if (failed === undefined) continue;
      const tests = failed.tests ?? { passed: 0, failed: 0, skipped: 0 };
      const text = step.text ?? "";
      drafts.push({
        anchorSeq: step.firstSeq,
        anchorStepId: step.id,
        severity: "critical",
        headline: "Claim contradicted by tests",
        reason: `The agent said "${text}" but ${failed.target ?? "the latest run"} had ${
          tests.failed > 0 ? `${tests.failed} failing test${tests.failed === 1 ? "" : "s"}` : "a non-zero exit"
        }.`,
        stepIds: sortStepIds([step.id, failed.id], stepById),
        chapterIds: [...failed.chapterIds],
        evidenceSeqs: sortedUnique([runSeq(failed), step.firstSeq]),
        claim: {
          claim: { text, seq: step.firstSeq, tMs: step.tMs, stepId: step.id },
          observed: {
            command: failed.target ?? "",
            passed: tests.passed,
            failed: tests.failed,
            skipped: tests.skipped,
            seq: runSeq(failed),
            tMs: failed.endTMs ?? failed.tMs,
            stepId: failed.id,
          },
        },
      });
    }
    return drafts;
  },
};

const failingTests: SignalRule & { readonly id: "failing_tests" } = {
  id: "failing_tests",
  version: 1,
  severity: "warning",
  title: "Failing tests",
  rationale:
    "A test run reported failures. It is critical when the same command's final run in the session also failed, because the failure was never fixed.",
  knownFalsePositives: [
    "Any runner-like stdout is parsed into a test result (apps/desktop/src/main/pipeline/pipeline-runtime.ts:750-753), so a command that prints a test summary it did not run can count.",
  ],
  requires: ["test_results"],
  evaluate({ session }) {
    const finalRun = new Map<string, Step>();
    for (const step of session.steps) {
      if (isRun(step) && step.target !== undefined) finalRun.set(normalizeCommand(step.target), step);
    }
    return session.steps
      .filter((step) => isRun(step) && step.tests !== undefined && step.tests.failed > 0)
      .map((step) => {
        const tests = step.tests ?? { passed: 0, failed: 0, skipped: 0 };
        const final = step.target !== undefined ? finalRun.get(normalizeCommand(step.target)) : undefined;
        const unresolved = final !== undefined && runFailed(final);
        return {
          anchorSeq: runSeq(step),
          anchorStepId: step.id,
          severity: unresolved ? "critical" : "warning",
          headline: `${tests.failed} failing test${tests.failed === 1 ? "" : "s"}`,
          reason: unresolved
            ? `${step.target ?? "The test command"} still fails in its final run.`
            : `${step.target ?? "The test command"} passed in a later run.`,
          stepIds: [step.id],
          chapterIds: [...step.chapterIds],
          evidenceSeqs: [runSeq(step)],
        } satisfies FindingDraft;
      });
  },
};

const destructiveCommand: SignalRule & { readonly id: "destructive_command" } = {
  id: "destructive_command",
  version: 1,
  severity: "critical",
  title: "Destructive command",
  rationale: "The command matches a destructive pattern from matchDestructive (packages/contracts/src/security.ts).",
  knownFalsePositives: [
    "SQL verbs match anywhere in the command text, so grep -rn \"DELETE FROM\" matches (packages/contracts/src/security.ts:21-23).",
    "Any rm -rf matches whatever its target, including build output such as dist/.",
  ],
  requires: ["agent_commands"],
  evaluate({ session }) {
    return session.steps
      .filter((step) => step.command?.destructivePattern !== undefined)
      .map((step) => ({
        anchorSeq: step.firstSeq,
        anchorStepId: step.id,
        severity: "critical",
        headline: "Destructive command",
        reason: `${step.command?.command ?? ""} matches the ${step.command?.destructivePattern ?? ""} pattern.`,
        stepIds: [step.id],
        chapterIds: [...step.chapterIds],
        evidenceSeqs: [...step.evidenceSeqs],
        matchedPattern: step.command?.destructivePattern ?? "",
      }));
  },
};

const guardrailClamp: SignalRule & { readonly id: "guardrail_clamp" } = {
  id: "guardrail_clamp",
  version: 1,
  severity: "info",
  title: "Guardrail clamp",
  rationale:
    "Jev's guardrails overrode a model value for a change unit. One finding per guardrail row with a warning or critical clamp, at the most severe clamp's severity (destructive_command critical; security, schema, public API and failed-unit clamps warning). Rows whose clamps are all info, including ids this build does not know, raise none and collapse as lifecycle noise.",
  knownFalsePositives: [
    "Before M1c, suppression rows were logged as clientKind \"degrade\" with confidence 1 (apps/desktop/src/main/pipeline/jev-stage.ts:146-160), so they read as rule-only.",
    "The security-path patterns match /token/i in tokenizer.ts and \\.env in .env.example (packages/jev-router/src/patterns.ts:11-19).",
  ],
  requires: ["jev_decisions"],
  evaluate({ session }) {
    return session.steps
      .filter((step) => step.kind === "guardrail" && step.guardrail !== undefined && hasSevereClamp(step))
      .map((step) => {
        const clampIds = step.guardrail?.clampIds ?? [];
        let top = clampIds[0] ?? "";
        for (const id of clampIds) {
          if (severityRank(clampMeta(id).severity) > severityRank(clampMeta(top).severity)) top = id;
        }
        const unitId = step.guardrail?.changeUnitId;
        return {
          anchorSeq: step.firstSeq,
          anchorStepId: step.id,
          severity: clampMeta(top).severity,
          headline: clampMeta(top).label,
          reason: clampIds.map((id) => clampMeta(id).label).join("; "),
          stepIds: [step.id],
          chapterIds: unitId !== undefined && unitId !== "" ? [unitStableId(unitId)] : [...step.chapterIds],
          evidenceSeqs: [step.firstSeq],
          clampId: top,
        } satisfies FindingDraft;
      });
  },
};

const recoveryArc: SignalRule & { readonly id: "recovery_arc" } = {
  id: "recovery_arc",
  version: 1,
  severity: "info",
  title: "Recovery",
  rationale: "A run failed, the agent edited code, and a later run of the same command passed.",
  knownFalsePositives: ["The later run passed because tests were deleted or skipped rather than fixed."],
  requires: ["test_results"],
  evaluate({ session }) {
    const drafts: FindingDraft[] = [];
    const openFailure = new Map<string, { failed: Step; edits: StepId[] }>();
    for (const step of session.steps) {
      if (step.kind === "edit") {
        if (step.noise !== "duplicate_poll") for (const pending of openFailure.values()) pending.edits.push(step.id);
        continue;
      }
      if (!isRun(step) || step.target === undefined) continue;
      const target = normalizeCommand(step.target);
      if (runFailed(step)) {
        const pending = openFailure.get(target);
        if (pending === undefined || pending.edits.length > 0) openFailure.set(target, { failed: step, edits: [] });
        continue;
      }
      const pending = openFailure.get(target);
      if (pending === undefined || !runPassed(step)) continue;
      if (pending.edits.length === 0) {
        openFailure.delete(target);
        continue;
      }
      openFailure.delete(target);
      drafts.push({
        anchorSeq: runSeq(step),
        anchorStepId: step.id,
        severity: "info",
        headline: "Recovered after edits",
        reason: `${step.target} failed, ${pending.edits.length} edit${pending.edits.length === 1 ? "" : "s"} followed, then it passed.`,
        stepIds: [pending.failed.id, ...pending.edits, step.id],
        chapterIds: [...new Set([...pending.failed.chapterIds, ...step.chapterIds])],
        evidenceSeqs: sortedUnique([runSeq(pending.failed), runSeq(step)]),
      });
    }
    return drafts;
  },
};

export const SIGNALS: { readonly [K in SignalId]: SignalRule & { readonly id: K } } = {
  claim_contradicted: claimContradicted,
  failing_tests: failingTests,
  destructive_command: destructiveCommand,
  guardrail_clamp: guardrailClamp,
  recovery_arc: recoveryArc,
};

export function signalMeta(id: SignalId): SignalMeta {
  const { evaluate: _evaluate, ...meta } = SIGNALS[id];
  return { ...meta, knownFalsePositives: [...meta.knownFalsePositives], requires: [...meta.requires] };
}

/** Rule rank inside a severity (spec §6.7 FINDING_ORDER). On oauth and api-break, failing_tests is
 *  critical too and anchors earlier, so the rank is what puts the contradiction first. */
export const FINDING_RULE_RANK: { readonly [K in SignalId]: number } = {
  claim_contradicted: 0,
  destructive_command: 1,
  failing_tests: 2,
  guardrail_clamp: 3,
  recovery_arc: 4,
};

/** Severity (critical > warning > info), then FINDING_RULE_RANK, then anchorSeq ascending, then id.
 *  finalize keeps findings in (anchorSeq, id) order (R8); the UI sorts a copy with this for the
 *  initial selection and for the finding a spine row shows. */
export function compareFindings(a: Finding, b: Finding): number {
  return (
    severityRank(b.severity) - severityRank(a.severity) ||
    FINDING_RULE_RANK[a.ruleId] - FINDING_RULE_RANK[b.ruleId] ||
    a.anchorSeq - b.anchorSeq ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

// ------------------------------------------------------------ findings and coverage

export function computeCoverage(
  capabilities: ReadonlySet<Capability>,
  approximateJoins: boolean,
  inferredSteps: number,
): Coverage {
  const present = CAPABILITIES.filter((capability) => capabilities.has(capability));
  const signals: SignalCoverage[] = SIGNAL_IDS.map((id) => {
    const missing = SIGNALS[id].requires.filter((capability) => !capabilities.has(capability));
    return { id, active: missing.length === 0, missing };
  });
  return { capabilities: present, signals, approximateJoins, inferredSteps };
}

/** Evaluates the active signals, attaches findingIds to steps and chapters, un-collapses every
 *  step a finding names, and marks each contradicted claim step with the claim_contradicted
 *  problem. Runs after applyNoise. Findings are derived here and never persisted. */
export function applySignals(input: SignalInput, coverage: Coverage): Finding[] {
  const session = input.session;
  const findings = new Map<string, Finding>();
  for (const signal of coverage.signals) {
    if (!signal.active) continue;
    const rule = SIGNALS[signal.id];
    for (const draft of rule.evaluate(input)) {
      const id = findingStableId(rule.id, rule.version, draft.anchorSeq);
      if (findings.has(id)) continue;
      findings.set(id, { id, ruleId: rule.id, ruleVersion: rule.version, ...draft });
    }
  }
  const sorted = [...findings.values()].sort((a, b) => a.anchorSeq - b.anchorSeq || a.id.localeCompare(b.id));
  const stepById = new Map(session.steps.map((step) => [step.id, step]));
  const chapterById = new Map(session.chapters.map((chapter) => [chapter.id, chapter]));
  for (const finding of sorted) {
    for (const stepId of finding.stepIds) {
      const step = stepById.get(stepId);
      if (step === undefined) continue;
      step.findingIds.push(finding.id);
      step.noise = null;
    }
    for (const chapterId of finding.chapterIds) {
      const chapter = chapterById.get(chapterId);
      if (chapter === undefined) continue;
      chapter.findingIds.push(finding.id);
      chapter.noise = false;
    }
    if (finding.ruleId === "claim_contradicted" && finding.claim !== undefined) {
      const claimStep = stepById.get(finding.claim.claim.stepId);
      if (claimStep !== undefined && !claimStep.problems.includes("claim_contradicted")) {
        claimStep.problems.push("claim_contradicted");
      }
    }
  }
  return sorted;
}
```

- [ ] **Step 4: Replace the placeholder coverage in `fold.ts`**

In `packages/trace-viewer/src/model/fold.ts`, find:

```ts
import { ENVELOPE_RULES } from "./registry.js";
import {
  CAPABILITIES,
  SIGNAL_IDS,
  TRACE_SCHEMA_VERSION,
  type Capability,
  type Coverage,
  type Gap,
```

Replace it with:

```ts
import { ENVELOPE_RULES } from "./registry.js";
import { applySignals, computeCoverage } from "./signals.js";
import {
  TRACE_SCHEMA_VERSION,
  type Gap,
```

In `packages/trace-viewer/src/model/fold.ts`, delete this block (the whole function and the blank line after it):

```ts
/** Capabilities present in the folded rows. No signal is evaluated yet, so each one reads inactive. */
function coverageOf(capabilities: ReadonlySet<Capability>, approximateJoins: boolean, inferredSteps: number): Coverage {
  return {
    capabilities: CAPABILITIES.filter((capability) => capabilities.has(capability)),
    signals: SIGNAL_IDS.map((id) => ({ id, active: false, missing: [] })),
    approximateJoins,
    inferredSteps,
  };
}

```

In `packages/trace-viewer/src/model/fold.ts`, find the end of `finalize` (from `const loadedThroughSeq` to the closing brace):

```ts
  const loadedThroughSeq = Math.max(s.loadedThroughSeq, options.throughSeq ?? 0);
  const clock = s.clock;
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    meta: { ...s.meta, ...(options.state !== undefined ? { state: options.state } : {}) },
    live,
    loadedThroughSeq,
    originMs: originOf(clock, s.meta.startedAt),
    span: {
      startTs: clockTs(clock, 0, s.meta.startedAt),
      endTs: clockTs(clock, clock.last, s.meta.startedAt),
      durationMs: clock.last,
    },
    turns,
    steps,
    chapters,
    entities,
    findings: [],
    gaps: gaps.sort(compareGaps),
    coverage: coverageOf(
      s.capabilities,
      chapters.some((chapter) => chapter.link === "inferred"),
      steps.filter((step) => step.provenance === "inferred").length,
    ),
    hidden: { byType: { ...s.hidden }, unreceived: Math.max(0, loadedThroughSeq - s.received) },
  };
}
```

Replace it with:

```ts
  const loadedThroughSeq = Math.max(s.loadedThroughSeq, options.throughSeq ?? 0);
  const clock = s.clock;
  const partial = {
    schemaVersion: TRACE_SCHEMA_VERSION,
    meta: { ...s.meta, ...(options.state !== undefined ? { state: options.state } : {}) },
    live,
    loadedThroughSeq,
    originMs: originOf(clock, s.meta.startedAt),
    span: {
      startTs: clockTs(clock, 0, s.meta.startedAt),
      endTs: clockTs(clock, clock.last, s.meta.startedAt),
      durationMs: clock.last,
    },
    turns,
    steps,
    chapters,
    entities,
    gaps: gaps.sort(compareGaps),
    hidden: { byType: { ...s.hidden }, unreceived: Math.max(0, loadedThroughSeq - s.received) },
  };
  const coverage = computeCoverage(
    s.capabilities,
    chapters.some((chapter) => chapter.link === "inferred"),
    steps.filter((step) => step.provenance === "inferred").length,
  );
  const findings = applySignals({ session: partial }, coverage);
  return { ...partial, findings, coverage };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/model`

Expected: no failures; `src/model/signals.test.ts (31 tests)` is listed, and `fold.test.ts`, `fold-evidence.test.ts`, `fold-chapters.test.ts` and `classify.test.ts` still pass (172 lane-B tests; W0's `types.test.ts` adds its own).

- [ ] **Step 6: Export from the model barrel**

In `packages/trace-viewer/src/model/index.ts`, find:

```ts
export * from "./fold.js";
```

Replace it with:

```ts
export * from "./fold.js";
export * from "./signals.js";
```

Run: `pnpm --filter @jevcode/trace-viewer typecheck`

Expected: exits 0.

- [ ] **Step 7: Root checks**

Run, in order, from `/Users/jwpark/Projects/jevcode-tv-b`:

```bash
pnpm -r build
pnpm -r typecheck
pnpm -r --workspace-concurrency=1 test
pnpm lint
```

Expected: each command exits 0. `pnpm -r build` includes `jevcode-trace-viewer-dev`, whose Vite plugin fails the build if any module reachable from `@jevcode/trace-viewer/model` imports a Node built-in (the browser-safety proof). `pnpm lint` prints nothing after `> pnpm exec eslint .`.

- [ ] **Step 8: Commit**

```bash
git add packages/trace-viewer/src/model/signals.ts \
  packages/trace-viewer/src/model/signals.test.ts \
  packages/trace-viewer/src/model/fold.ts \
  packages/trace-viewer/src/model/index.ts
git commit -m "feat(trace-viewer): add the five v1 supervision signals and coverage"
```

### Task B-8: Five-fixture assertions and mutation tests

**Files:**
- Test: `packages/trace-viewer/src/model/fold.fixtures.test.ts`, `packages/trace-viewer/src/model/fold.mutations.test.ts`

**Interfaces:**
- Consumes: B-2 `loadFixtureTrace(name)`, `FIXTURE_NAMES`, `type FixtureName`, `stripCaptureFields(rows)`, `addCaptureFields(rows)`; B-3 `foldRows(meta, rows, options)`; B-7 `compareFindings(a, b)`; the public `TraceSession`, `Step` and `Finding` shapes.
- Produces: no code. These tests pin behavior built in B-3 to B-7 on real pipeline output, in three variants: `stored` (as `loadFixtureTrace` returns it), `legacy` (pre-M1) and `captured` (M1 fields added). The assertions required by index §3: all five fixtures fold with zero gaps; oauth's `pnpm test` run is one failed step with 14/1/0; `claim_contradicted` fires on oauth ("OAuth implementation complete; all checks pass.") and api-break ("The endpoint change is complete and all tests pass."), each anchored on the claim step, citing the failed run's `test_result` seq and the claim seq, and sorting first under `compareFindings` although `failing_tests` is also critical and earlier; dropping oauth's `test_result` adds `missing_evidence`. B-12 adds the claim fields (`claimStepId`, `evidenceStepIds`, `claimSpan`) to the same test.

- [ ] **Step 1: Write the fixture tests**

Create `packages/trace-viewer/src/model/fold.fixtures.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { TraceRow } from "@jevcode/contracts";

import {
  addCaptureFields,
  FIXTURE_NAMES,
  loadFixtureTrace,
  stripCaptureFields,
  type FixtureName,
} from "../test-support/fixture-rows.js";
import { foldRows } from "./fold.js";
import { compareFindings } from "./signals.js";
import type { Step, TraceSession } from "./types.js";

// Rows are selected by content (type, command, text), never by line number: A1-9 adds lines
// and fields to fixtures/*/events.jsonl. Each fixture is folded three ways: as stored, as a
// pre-M1 session (D11: no turnId, callId, sourceCallId, factId or agentCallIds) and with the
// M1 capture fields added (A1-9 shape).

const VARIANTS = {
  stored: (rows: TraceRow[]) => rows,
  legacy: (rows: TraceRow[]) => stripCaptureFields(rows),
  captured: (rows: TraceRow[]) => addCaptureFields(rows),
} as const;

type Variant = keyof typeof VARIANTS;

function load(name: FixtureName, variant: Variant): { rows: TraceRow[]; session: TraceSession } {
  const trace = loadFixtureTrace(name);
  const rows = VARIANTS[variant](trace.rows);
  return { rows, session: foldRows(trace.meta, rows, { live: false }) };
}

function field(row: TraceRow, key: string): unknown {
  return (row.payload as Record<string, unknown>)[key];
}

function findRow(rows: readonly TraceRow[], predicate: (row: TraceRow) => boolean, label: string): TraceRow {
  const row = rows.find(predicate);
  if (row === undefined) throw new Error(`fixture has no ${label} row`);
  return row;
}

function stepContaining(session: TraceSession, seq: number): Step {
  const step = session.steps.find((candidate) => candidate.seqs.includes(seq));
  if (step === undefined) throw new Error(`no step holds seq ${seq}`);
  return step;
}

const isAgent = (type: string) => (row: TraceRow) => row.type === "agent_event" && field(row, "type") === type;
const isFact = (type: string) => (row: TraceRow) => row.type === "evidence_fact" && field(row, "type") === type;

describe.each(Object.keys(VARIANTS) as Variant[])("fixtures (%s)", (variant) => {
  it.each(FIXTURE_NAMES)("%s folds cleanly into one completed turn", (name) => {
    const { rows, session } = load(name, variant);
    expect(session.gaps).toEqual([]);
    expect(session.turns).toHaveLength(1);
    expect(session.turns[0]).toMatchObject({ trigger: "initial", outcome: "completed" });
    const prompt = field(findRow(rows, isAgent("agent_started"), "agent_started"), "prompt");
    expect(session.steps[0]).toMatchObject({ kind: "instruction", text: prompt });
    const ids = session.steps.map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (let index = 1; index < session.steps.length; index += 1) {
      const previous = session.steps[index - 1] as Step;
      const current = session.steps[index] as Step;
      expect(current.firstSeq).toBeGreaterThan(previous.firstSeq);
      expect(current.tMs).toBeGreaterThanOrEqual(previous.tMs);
    }
    const units = rows.filter((row) => row.type === "change_unit").map((row) => field(row, "id"));
    expect(session.chapters.map((chapter) => chapter.changeUnitId).sort()).toEqual([...new Set(units)].sort());
  });

  it("oauth: the pnpm test run is one failed step with 14/1/0", () => {
    const { rows, session } = load("oauth", variant);
    const started = findRow(rows, (row) => isAgent("command_started")(row) && field(row, "command") === "pnpm test", "pnpm test start");
    const completed = findRow(rows, (row) => isAgent("command_completed")(row) && field(row, "command") === "pnpm test", "pnpm test end");
    const result = findRow(rows, isFact("test_result"), "test_result");
    const step = stepContaining(session, started.seq);
    expect(step.seqs).toEqual(expect.arrayContaining([started.seq, result.seq, completed.seq]));
    expect(step).toMatchObject({ kind: "test", status: "failed", tests: { passed: 14, failed: 1, skipped: 0 } });
    expect(step.problems).toEqual(["exit_nonzero", "tests_failed"]);
    const joinedById = field(started, "callId") !== undefined && field(result, "sourceCallId") !== undefined;
    expect(step.provenance).toBe(joinedById ? "observed" : "inferred");
  });

  it.each([
    ["oauth", "OAuth implementation complete; all checks pass."],
    ["api-break", "The endpoint change is complete and all tests pass."],
  ] as const)("%s: the claim is contradicted by the failed run's test_result", (name, text) => {
    const { rows, session } = load(name, variant);
    const claim = findRow(rows, (row) => isAgent("agent_message")(row) && field(row, "text") === text, "claim");
    const result = findRow(rows, isFact("test_result"), "test_result");
    const contradictions = session.findings.filter((finding) => finding.ruleId === "claim_contradicted");
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0]).toMatchObject({
      anchorSeq: claim.seq,
      anchorStepId: stepContaining(session, claim.seq).id,
      severity: "critical",
    });
    expect(contradictions[0]?.evidenceSeqs).toEqual([result.seq, claim.seq]);
    expect(contradictions[0]?.claim?.observed.seq).toBe(result.seq);
    expect(stepContaining(session, claim.seq).problems).toContain("claim_contradicted");
    const failing = session.findings.filter((finding) => finding.ruleId === "failing_tests");
    expect(failing.map((finding) => [finding.anchorSeq, finding.severity])).toEqual([[result.seq, "critical"]]);
    // failing_tests is critical too and anchors earlier; the rule rank puts the contradiction first (spec §6.7).
    expect([...session.findings].sort(compareFindings)[0]?.ruleId).toBe("claim_contradicted");
  });

  it.each(["rate-limit", "schema-change", "dep-change"] as const)("%s raises no finding", (name) => {
    expect(load(name, variant).session.findings).toEqual([]);
  });

  it("oauth: lockfile and formatting hunks are noise, the decision is one step", () => {
    const { rows, session } = load("oauth", variant);
    const lock = findRow(rows, (row) => isFact("git_hunk")(row) && field(row, "file") === "pnpm-lock.yaml", "lockfile hunk");
    const format = findRow(rows, (row) => isFact("git_hunk")(row) && field(row, "isFormattingOnly") === true, "formatting hunk");
    expect(stepContaining(session, lock.seq).noise).toBe("lockfile");
    expect(stepContaining(session, format.seq).noise).toBe("formatting");
    const decisionRows = rows.filter((row) => row.type === "decision");
    expect(decisionRows.length).toBeGreaterThanOrEqual(2);
    const step = stepContaining(session, decisionRows[0]?.seq ?? 0);
    expect(step.id).toBe(`step:${decisionRows[0]?.seq}`);
    expect(step.seqs).toEqual(decisionRows.map((row) => row.seq));
    expect(step.decision).toMatchObject({ status: "answered", decidedBy: "supervisor" });
    expect(step.decision?.options.filter((option) => option.chosen).map((option) => option.id)).toEqual(["explicit_link"]);
  });

  it("dep-change: formatting and lockfile edits collapse, real edits stay", () => {
    const { rows, session } = load("dep-change", variant);
    const noiseOf = (file: string) => {
      const hunk = findRow(rows, (row) => isFact("git_hunk")(row) && field(row, "file") === file, file);
      return stepContaining(session, hunk.seq).noise;
    };
    expect(noiseOf("src/utils/format.ts")).toBe("formatting");
    expect(noiseOf("pnpm-lock.yaml")).toBe("lockfile");
    expect(noiseOf("src/helpers/http.ts")).toBeNull();
  });
});

describe("fixture joins by variant", () => {
  it("stored and captured sessions link chapters by id; legacy sessions link approximately", () => {
    for (const name of FIXTURE_NAMES) {
      expect(load(name, "stored").session.coverage.approximateJoins, name).toBe(false);
      expect(load(name, "captured").session.coverage.approximateJoins, name).toBe(false);
      expect(load(name, "legacy").session.coverage.approximateJoins, name).toBe(true);
    }
  });

  it("captured sessions pair every command by callId", () => {
    const { session } = load("oauth", "captured");
    const commands = session.steps.filter((step) => step.command !== undefined && step.actor === "agent");
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((step) => step.provenance === "observed" && step.callId !== undefined)).toBe(true);
    expect(session.coverage.capabilities).toContain("call_ids");
  });
});
```

- [ ] **Step 2: Write the mutation tests**

Create `packages/trace-viewer/src/model/fold.mutations.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { TraceRow } from "@jevcode/contracts";

import { loadFixtureTrace, type FixtureName } from "../test-support/fixture-rows.js";
import { foldRows } from "./fold.js";
import type { TraceSession } from "./types.js";

// Each test breaks one thing in a real fixture and checks the fold reports it instead of
// hiding it. Rows are selected by content, never by line number.

function field(row: TraceRow, key: string): unknown {
  return (row.payload as Record<string, unknown>)[key];
}

function isPayload(type: string, extra: Record<string, unknown> = {}) {
  return (row: TraceRow) =>
    field(row, "type") === type && Object.entries(extra).every(([key, value]) => field(row, key) === value);
}

function mutate(
  name: FixtureName,
  change: (rows: TraceRow[]) => TraceRow[],
  live = false,
): { rows: TraceRow[]; session: TraceSession } {
  const trace = loadFixtureTrace(name);
  const rows = change(trace.rows);
  return { rows, session: foldRows(trace.meta, rows, { live }) };
}

function seqOf(rows: readonly TraceRow[], predicate: (row: TraceRow) => boolean): number {
  const row = rows.find(predicate);
  if (row === undefined) throw new Error("row not found");
  return row.seq;
}

describe("fold mutations", () => {
  it("dropping oauth's test_result adds missing_evidence and silences the test signals", () => {
    const trace = loadFixtureTrace("oauth");
    const start = seqOf(trace.rows, isPayload("command_started", { command: "pnpm test" }));
    const { session } = mutate("oauth", (rows) =>
      rows.filter((row) => !isPayload("test_result")(row) && row.type !== "validation"),
    );
    expect(session.gaps).toEqual([expect.objectContaining({ kind: "missing_evidence", atSeq: start })]);
    const step = session.steps.find((candidate) => candidate.firstSeq === start);
    expect(step).toMatchObject({ kind: "test", status: "failed", problems: ["exit_nonzero"] });
    expect(session.findings).toEqual([]);
    expect(session.coverage.signals.find((signal) => signal.id === "claim_contradicted")).toEqual({
      id: "claim_contradicted",
      active: false,
      missing: ["test_results"],
    });
  });

  it("a failing schema-change test run makes its completion claim contradicted", () => {
    const { rows, session } = mutate("schema-change", (input) =>
      input.map((row) =>
        isPayload("test_result")(row)
          ? { ...row, payload: { ...(row.payload as object), passed: 41, failed: 1 } }
          : row,
      ),
    );
    const claim = seqOf(rows, isPayload("agent_message", { text: "Schema change complete with migration and passing tests." }));
    const result = seqOf(rows, isPayload("test_result"));
    const finding = session.findings.find((candidate) => candidate.ruleId === "claim_contradicted");
    expect(finding).toMatchObject({ anchorSeq: claim, evidenceSeqs: [result, claim] });
  });

  it("a test command that never completes is unknown with an unpaired gap, or running at the live edge", () => {
    const drop = (rows: TraceRow[]) => rows.filter((row) => !isPayload("command_completed", { command: "pnpm test" })(row));
    const trace = loadFixtureTrace("oauth");
    const start = seqOf(trace.rows, isPayload("command_started", { command: "pnpm test" }));
    const closed = mutate("oauth", drop).session;
    expect(closed.steps.find((step) => step.firstSeq === start)).toMatchObject({ status: "unknown", endTMs: null });
    expect(closed.gaps).toEqual([expect.objectContaining({ kind: "unpaired", atSeq: start })]);
    const live = mutate(
      "oauth",
      (rows) => drop(rows).filter((row) => !isPayload("agent_completed")(row)),
      true,
    ).session;
    expect(live.steps.find((step) => step.firstSeq === start)?.status).toBe("running");
    expect(live.turns[0]?.outcome).toBe("running");
    expect(live.gaps).toEqual([]);
  });

  it("a corrupt payload becomes one invalid_row gap and every other row still folds", () => {
    const trace = loadFixtureTrace("rate-limit");
    const target = seqOf(trace.rows, isPayload("git_hunk", { file: "src/redis/client.ts" }));
    const intact = foldRows(trace.meta, trace.rows, { live: false });
    const { session } = mutate("rate-limit", (rows) =>
      rows.map((row) => (row.seq === target ? { ...row, payload: { type: "git_hunk", file: 42 } } : row)),
    );
    expect(session.gaps).toEqual([expect.objectContaining({ kind: "invalid_row", atSeq: target })]);
    expect(session.steps.length).toBe(intact.steps.length);
    expect(session.findings).toEqual(intact.findings);
  });

  it("an unknown row type from a newer build is a gap, not a crash", () => {
    const { session } = mutate("api-break", (rows) => [
      ...rows,
      { seq: rows.length + 1, type: "agent_plan", ts: rows[rows.length - 1]?.ts ?? "", payload: { steps: [] } },
    ]);
    expect(session.gaps.map((gap) => gap.kind)).toEqual(["unknown_row_type"]);
    expect(session.findings.map((finding) => finding.ruleId).sort()).toEqual(["claim_contradicted", "failing_tests"]);
  });
});
```

- [ ] **Step 3: Run them**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/model/fold.fixtures.test.ts src/model/fold.mutations.test.ts`

Expected: `Test Files  2 passed (2)`, `Tests  46 passed (46)` (fixtures 41, mutations 5). They pass on the first run because they pin behavior that B-3 to B-7 built; Step 4 shows they catch a regression.

- [ ] **Step 4: Prove the tests catch a broken claim rule, then restore it**

In `packages/trace-viewer/src/model/signals.ts`, temporarily change

```ts
      const failed = [...latestByTarget.values()].filter(runFailed).sort((a, b) => runSeq(b) - runSeq(a))[0];
```

to

```ts
      const failed = [...latestByTarget.values()].filter(() => false).sort((a, b) => runSeq(b) - runSeq(a))[0];
```

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/model/fold.fixtures.test.ts src/model/fold.mutations.test.ts`

Expected: `Tests  8 failed | 38 passed (46)`: the six "the claim is contradicted by the failed run's test_result" cases (two fixtures × three variants), "a failing schema-change test run makes its completion claim contradicted" and "an unknown row type from a newer build is a gap, not a crash".

Change the line back to `.filter(runFailed)` and confirm `git diff --stat -- packages/trace-viewer/src/model/signals.ts` prints nothing.

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/model/fold.fixtures.test.ts src/model/fold.mutations.test.ts`

Expected: `Tests  46 passed (46)`.

- [ ] **Step 5: Root checks**

Run, in order, from `/Users/jwpark/Projects/jevcode-tv-b`:

```bash
pnpm -r build
pnpm -r typecheck
pnpm -r --workspace-concurrency=1 test
pnpm lint
```

Expected: each command exits 0. `pnpm -r build` includes `jevcode-trace-viewer-dev`, whose Vite plugin fails the build if any module reachable from `@jevcode/trace-viewer/model` imports a Node built-in (the browser-safety proof). `pnpm lint` prints nothing after `> pnpm exec eslint .`.

- [ ] **Step 6: Commit**

```bash
git add packages/trace-viewer/src/model/fold.fixtures.test.ts \
  packages/trace-viewer/src/model/fold.mutations.test.ts
git commit -m "test(trace-viewer): pin five-fixture fold results and mutations"
```

### Task B-9: Batch-split parity property and the fold benchmark

**Files:**
- Create: `packages/trace-viewer/src/test-support/synthetic-rows.ts` (deviation 2), `packages/trace-viewer/src/model/fold.bench.ts`
- Test: `packages/trace-viewer/src/model/fold.parity.test.ts`

**Interfaces:**
- Consumes: B-3 `createTraceState`, `accumulate`, `accumulateAll`, `finalize`, `foldRows`; B-2 `loadFixtureTrace`, `FIXTURE_NAMES`, `stripCaptureFields`; `fast-check` 4 (`fc.assert`, `fc.property`, `fc.uniqueArray`, `fc.integer`, `fc.boolean`); vitest `bench` (options `iterations`, `warmupIterations`, `time`, `setup`).
- Produces (test-only): `SYNTHETIC_META: TraceSessionSummary`; `syntheticRows(count: number): TraceRow[]` (a long Codex-like session: every 200 cycles an `agent_started`; each 15-row cycle has a message, reasoning, a read tool call, an edit claim with its `file_changed`/`git_hunk` facts, a `pnpm test` run with `command_executed` and `test_result` facts that fails every ninth cycle, a Jev call that clamps every fifth cycle, `telemetry` and `graph_node` rows, and a `change_unit` version).

The budgets (R8) are a benchmark, not a CI gate: `vitest.config.ts` includes only `*.test.ts(x)` in `vitest run`, so `pnpm -r test` never runs `fold.bench.ts`.

- [ ] **Step 1: Write the failing parity test**

Create `packages/trace-viewer/src/model/fold.parity.test.ts`:

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { TraceRow, TraceSessionSummary } from "@jevcode/contracts";

import { FIXTURE_NAMES, loadFixtureTrace, stripCaptureFields } from "../test-support/fixture-rows.js";
import { SYNTHETIC_META, syntheticRows } from "../test-support/synthetic-rows.js";
import { accumulateAll, createTraceState, finalize, foldRows } from "./fold.js";

// accumulate mutates its state in place for speed (R8); these properties are the guard that
// batch boundaries, intermediate finalize calls (one per live poll) and redelivered pages
// never change the result.

function splitAt(rows: readonly TraceRow[], cuts: readonly number[]): TraceRow[][] {
  const points = [...new Set(cuts)].sort((a, b) => a - b);
  const batches: TraceRow[][] = [];
  let start = 0;
  for (const point of points) {
    batches.push(rows.slice(start, point));
    start = point;
  }
  batches.push(rows.slice(start));
  return batches;
}

function checkParity(meta: TraceSessionSummary, rows: readonly TraceRow[], runs: number): void {
  const cutsArb = fc.uniqueArray(fc.integer({ min: 1, max: Math.max(1, rows.length - 1) }), { maxLength: 12 });
  fc.assert(
    fc.property(cutsArb, fc.boolean(), (cuts, live) => {
      const whole = foldRows(meta, rows, { live });
      const state = createTraceState(meta);
      for (const batch of splitAt(rows, cuts)) {
        accumulateAll(state, batch);
        finalize(state, { live });
      }
      expect(finalize(state, { live })).toEqual(whole);
    }),
    { numRuns: runs },
  );
  fc.assert(
    fc.property(fc.integer({ min: 0, max: rows.length }), (prefix) => {
      const state = accumulateAll(createTraceState(meta), rows);
      const before = finalize(state, { live: false });
      accumulateAll(state, rows.slice(0, prefix));
      expect(finalize(state, { live: false })).toEqual(before);
    }),
    { numRuns: Math.max(10, Math.floor(runs / 2)) },
  );
}

describe("fold parity", () => {
  it.each(FIXTURE_NAMES)("%s: any batch split and any redelivered prefix fold the same", (name) => {
    const trace = loadFixtureTrace(name);
    checkParity(trace.meta, trace.rows, 60);
    checkParity(trace.meta, stripCaptureFields(trace.rows), 20);
  });

  it("a 3,000-row synthetic session folds the same in any batch split", () => {
    const rows = syntheticRows(3_000);
    checkParity({ ...SYNTHETIC_META, lastEventSeq: rows.length }, rows, 8);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/model/fold.parity.test.ts`

Expected: FAIL, `Error: Cannot find module '../test-support/synthetic-rows.js'`, `Tests  no tests`.

- [ ] **Step 3: Write the synthetic session**

Create `packages/trace-viewer/src/test-support/synthetic-rows.ts`:

```ts
// Test-only: a synthetic session shaped like a long live Codex run, for the fold benchmark
// and the parity property. Excluded from the build (tsconfig.build.json).
import type { TraceRow, TraceSessionSummary } from "@jevcode/contracts";

const SESSION = "sess-bench";
const REPO = "repo-bench";
const START = Date.parse("2026-09-18T09:00:00.000Z");

export const SYNTHETIC_META: TraceSessionSummary = {
  sessionId: SESSION,
  repoId: REPO,
  repoName: "bench",
  prompt: "Synthetic 75k-row session",
  state: "completed",
  startedAt: new Date(START).toISOString(),
  endedAt: null,
  lastEventSeq: 0,
};

/** One cycle of a realistic session: talk, read, edit (claim + repo facts), run tests, Jev. */
function cycle(index: number, turnId: string): { type: string; payload: Record<string, unknown> }[] {
  const ts = new Date(START + index * 4_000).toISOString();
  const file = `src/module-${index % 50}/file-${index % 7}.ts`;
  const call = `${turnId}:item_${index}`;
  const testCall = `${turnId}:item_${index}_t`;
  const failed = index % 9 === 0 ? 1 : 0;
  const base = { sessionId: SESSION, ts, turnId };
  const fact = { repoId: REPO, sessionId: SESSION, ts };
  return [
    { type: "agent_event", payload: { ...base, type: "agent_message", role: "assistant", text: `Working on step ${index}: updating ${file}.` } },
    { type: "agent_event", payload: { ...base, type: "agent_reasoning", text: "Considering the next edit.".repeat(4) } },
    { type: "agent_event", payload: { ...base, type: "tool_started", tool: "read_file", input: file, callId: `${call}_r` } },
    { type: "agent_event", payload: { ...base, type: "tool_completed", tool: "read_file", output: "x".repeat(400), callId: `${call}_r` } },
    { type: "agent_event", payload: { ...base, type: "file_changed", path: file, callId: call } },
    { type: "evidence_fact", payload: { ...fact, type: "file_changed", path: file, kind: "modified" } },
    { type: "evidence_fact", payload: { ...fact, type: "git_hunk", file, added: index % 13, removed: index % 5, isFormattingOnly: false, isConfigOnly: false, isLockfile: false } },
    { type: "agent_event", payload: { ...base, type: "command_started", command: "pnpm test", callId: testCall } },
    { type: "agent_event", payload: { ...base, type: "command_completed", command: "pnpm test", exitCode: failed, stdout: "Tests passed\n".repeat(20), stderr: "", callId: testCall } },
    { type: "evidence_fact", payload: { ...fact, type: "command_executed", command: "pnpm test", exitCode: failed, isDestructive: false, sourceCallId: testCall } },
    { type: "evidence_fact", payload: { ...fact, type: "test_result", runner: "vitest", command: "pnpm test", passed: 40, failed, skipped: 0, failures: failed > 0 ? [{ file, testName: "suite > case", message: "expected 1 to be 2" }] : [], sourceCallId: testCall } },
    { type: "jev_decision", payload: { id: `jev_${index}`, sessionId: SESSION, changeUnitId: `cu_${index % 40}`, inputHash: "abc", output: {}, confidence: 0.8, latencyMs: 5, clientKind: "degrade", clamps: index % 5 === 0 ? ["schema_floor"] : [], ts } },
    { type: "telemetry", payload: { sessionId: SESSION, name: "agent_event_count", ts } },
    { type: "graph_node", payload: { sessionId: SESSION, id: `n_${index}`, ts } },
    { type: "change_unit", payload: { id: `cu_${index % 40}`, sessionId: SESSION, title: `Unit ${index % 40}`, category: "implementation", status: "in_progress", files: [file], symbols: [], interfacesChanged: [], schemaChanges: [], dependencyChanges: [], relatedDecisions: [], validationResults: [], evidence: [`fact_${index}`], createdAt: ts, updatedAt: ts, agentCallIds: [call] } },
  ];
}

export function syntheticRows(count: number): TraceRow[] {
  const rows: TraceRow[] = [];
  let turn = 0;
  for (let index = 0; rows.length < count; index += 1) {
    if (index % 200 === 0) {
      turn += 1;
      const ts = new Date(START + index * 4_000).toISOString();
      rows.push({ seq: rows.length + 1, type: "agent_event", ts, payload: { type: "agent_started", sessionId: SESSION, ts, prompt: `Turn ${turn}`, turnId: `turn-${turn}` } });
    }
    for (const entry of cycle(index, `turn-${turn}`)) {
      if (rows.length >= count) break;
      const ts = String(entry.payload["ts"] ?? new Date(START).toISOString());
      rows.push({ seq: rows.length + 1, type: entry.type, ts, payload: entry.payload, ...(entry.type === "evidence_fact" ? { factId: `fact_${rows.length}` } : {}) });
    }
  }
  return rows;
}

```

- [ ] **Step 4: Run the parity test to verify it passes**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/model/fold.parity.test.ts`

Expected: `Tests  6 passed (6)` in a few seconds.

- [ ] **Step 5: Prove the property catches a `finalize` that mutates state, then restore it**

In `packages/trace-viewer/src/model/fold.ts`, inside `finalize`, temporarily change

```ts
    return toPublicStep(draft, running ? "running" : "unknown");
```

to

```ts
    const step = toPublicStep(draft, running ? "running" : "unknown");
    draft.provenance = "observed";
    return step;
```

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/model/fold.parity.test.ts`

Expected: `Tests  5 failed | 1 passed (6)`: every fixture case fails (an intermediate `finalize` flips inferred drafts, so a split fold differs from a whole fold).

Restore the single `return toPublicStep(draft, running ? "running" : "unknown");` line and confirm `git diff --stat -- packages/trace-viewer/src/model/fold.ts` prints nothing.

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/model/fold.parity.test.ts`

Expected: `Tests  6 passed (6)`.

- [ ] **Step 6: Write the benchmark**

Create `packages/trace-viewer/src/model/fold.bench.ts`:

```ts
import { bench, describe } from "vitest";

import { SYNTHETIC_META, syntheticRows } from "../test-support/synthetic-rows.js";
import { accumulate, accumulateAll, createTraceState, finalize, foldRows } from "./fold.js";

// Budgets (R8; a benchmark, not a CI gate): a full fold of 75k rows <= 500 ms and one appended
// row <= 2 ms. Read the "mean" column (ms) of `pnpm --filter @jevcode/trace-viewer bench`.

const ROWS = syntheticRows(75_000);
const META = { ...SYNTHETIC_META, lastEventSeq: ROWS.length };
const EXTRA = syntheticRows(ROWS.length + 5_000).slice(ROWS.length);

describe("trace fold budgets", () => {
  bench(
    "fold 75k rows",
    () => {
      foldRows(META, ROWS, { live: false });
    },
    { iterations: 5, warmupIterations: 1 },
  );

  let state = accumulateAll(createTraceState(META), ROWS);
  let appended = 0;
  bench(
    "append 1 row",
    () => {
      const row = EXTRA[appended];
      appended += 1;
      if (row !== undefined) accumulate(state, row);
    },
    {
      iterations: 1_000,
      time: 0,
      setup: () => {
        state = accumulateAll(createTraceState(META), ROWS);
        appended = 0;
      },
    },
  );

  bench(
    "finalize 75k rows (one live poll)",
    () => {
      finalize(state, { live: true });
    },
    {
      iterations: 5,
      warmupIterations: 1,
      setup: () => {
        state = accumulateAll(createTraceState(META), ROWS);
      },
    },
  );
});
```

- [ ] **Step 7: Run the benchmark and record the numbers**

Run: `pnpm --filter @jevcode/trace-viewer bench`

Expected: a table with the rows `fold 75k rows`, `append 1 row` and `finalize 75k rows (one live poll)`. The `mean` column is in ms. On the plan author's machine (Node 22.23, under load): fold 75k ≈ 375 ms (budget ≤ 500), append 1 row ≈ 0.004 ms (budget ≤ 2), finalize ≈ 115 ms. Record the three means for the lane hand-off. A mean over budget is a finding to report there, not a failure of this task.

Run: `pnpm --filter @jevcode/trace-viewer typecheck`

Expected: exits 0 (the bench file is type-checked).

- [ ] **Step 8: Root checks**

Run, in order, from `/Users/jwpark/Projects/jevcode-tv-b`:

```bash
pnpm -r build
pnpm -r typecheck
pnpm -r --workspace-concurrency=1 test
pnpm lint
```

Expected: each command exits 0. `pnpm -r build` includes `jevcode-trace-viewer-dev`, whose Vite plugin fails the build if any module reachable from `@jevcode/trace-viewer/model` imports a Node built-in (the browser-safety proof). `pnpm lint` prints nothing after `> pnpm exec eslint .`.

- [ ] **Step 9: Commit**

```bash
git add packages/trace-viewer/src/test-support/synthetic-rows.ts \
  packages/trace-viewer/src/model/fold.parity.test.ts \
  packages/trace-viewer/src/model/fold.bench.ts
git commit -m "test(trace-viewer): add batch-split parity property and fold benchmark"
```

### Task B-10: Search, stable-id lookup, mini-graphic specs

**Files:**
- Create: `packages/trace-viewer/src/model/search.ts`, `packages/trace-viewer/src/model/lookup.ts`
- Modify: `packages/trace-viewer/src/model/format.ts` (`pickGraphic` and `describeGraphic` are appended here: decision record R25 puts them in `model/format.ts`; there is no `graphics.ts`)
- Test: `packages/trace-viewer/src/model/search.test.ts`, `packages/trace-viewer/src/model/lookup.test.ts`, `packages/trace-viewer/src/model/graphics.test.ts`
- Modify: `packages/trace-viewer/src/model/index.ts` (append two lines)

**Interfaces:**
- Consumes: B-7 `finalize` output (`TraceSession` with `steps`, `chapters`, `entities` in first-edit order, `findings`, `span`); `Finding.claimSpan` (optional; B-12 fills it); B-1 `formatDuration` (same module). From `./types.js`: `parseStableId(value: string): ParsedStableId | null`, and the types `Chapter`, `DecisionDetail`, `Entity`, `Finding`, `GraphicSpec`, `StableId`, `Step`, `StepId`, `TraceSession`. `GraphicSpec` has the shape UI index §1.2 gives W0-6:

```ts
export type GraphicSpec =
  | { kind: "diff"; added: number; removed: number; files?: { path: string; added: number; removed: number }[]; moreFiles?: number }
  | { kind: "tests"; passed: number; failed: number; skipped: number }
  | { kind: "duration"; durationMs: number | null; running: boolean; status: StepStatus; end: "none" | "bad_dot" | "exit_x" }
  | { kind: "fork"; options: { label: string; chosen: boolean }[]; decidedBy: "supervisor" | "delegated" | "open" }
  | { kind: "flow"; nodes: string[]; focus: number }
  | { kind: "table"; tables: { name: string; role: "new" | "altered"; columns: number }[] }
  | {
      kind: "claim";
      claim: { text: string; span?: [number, number]; tMs: number };
      observed: { passed: number; failed: number; command: string; tMs: number };
    };
```

- Produces (index §2.6): `interface SearchIndex { readonly entries: ReadonlyArray<{ id: StepId; haystack: string }> }`; `buildSearchIndex(session: TraceSession): SearchIndex`; `searchSteps(index: SearchIndex, query: string): StepId[]`; `type ResolvedTarget = { kind: "step"; step: Step } | { kind: "unit"; chapter: Chapter } | { kind: "decision"; step: Step } | { kind: "file"; entity: Entity } | { kind: "finding"; finding: Finding }`; `resolveStableId(session: TraceSession, id: StableId): ResolvedTarget | null`; in `format.ts` (R25): `pickGraphic(target: Step | Chapter, session: TraceSession): GraphicSpec | null`; `describeGraphic(spec: GraphicSpec): string`.

Rules: search haystack = headline, target, the first 8 KiB of text, command, edit path and test failure names (never stdout), lower-cased; every whitespace-split term must match; ids in step order. `resolveStableId` caches one index per session object (a `WeakMap`), so resolving every id stays linear.

`pickGraphic` for a step: a contradicted claim → `claim` (text, `claimSpan` as `span`, claim and observed `tMs`); an edit → `diff`; a step with a test result → `tests`; a decision → `fork`; any other step with a command → `duration` (`durationMs` null while running; `end` is `bad_dot` for a failed test or check, `exit_x` for a command with exit > 0, else `none`); anything else → null.

`pickGraphic` for a chapter follows spec §7.12 `CHAPTER_GRAPHIC`, first match wins, and a rule without data falls through: category `schema` with `schemaChanges` → `table` (spec §6.6: one entry per table named by a `table`/`model` item or by the prefix before the last `.` of a `column`/`field` item; `role` `new` when a table or model item was added, else `altered`; `columns` counts column and field items); `architecture` or `api` with edited files → `flow` (up to 3 file stems in first-edit order, `focus` = the node with the most lines changed); `tests` with a joined test run → `tests` with the counts of the latest run among `validationStepIds` and `stepIds`; an answered or delegated decision in `decisionIds` → `fork`; else `diff` summed over the chapter's file entities with `files` = the top 4 by lines changed (ties by path) and `moreFiles` = the rest; null when no file was edited.

`describeGraphic` (UI index §1.4 B-10): `tests` → "14 passed, 1 failed" (", 2 skipped" when any); `diff` → "+17 −3" (U+2212 minus), plus " in N files" for a chapter list; `duration` → "5.0 s, failed" (`formatDuration`, then the status), "running" while running; `fork`, `flow`, `table` and `claim` as in the test table.

- [ ] **Step 1: Write the failing tests**

Create `packages/trace-viewer/src/model/search.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { loadFixtureTrace } from "../test-support/fixture-rows.js";
import { TraceBuilder, testMeta } from "../test-support/trace-builder.js";
import { foldRows } from "./fold.js";
import { buildSearchIndex, searchSteps } from "./search.js";

describe("search", () => {
  it("finds oauth's test step by its command", () => {
    const trace = loadFixtureTrace("oauth");
    const session = foldRows(trace.meta, trace.rows, { live: false });
    const testStep = session.steps.find((step) => step.kind === "test");
    const decision = session.steps.find((step) => step.kind === "decision");
    const hits = searchSteps(buildSearchIndex(session), "pnpm test");
    // A1-9 adds an oauth agent_reasoning line that quotes "pnpm test", so pin the test step's
    // rank and one non-match instead of an exact list (index §4, fixture drift).
    expect(testStep).toBeDefined();
    expect(hits[0]).toBe(testStep?.id);
    expect(hits).not.toContain(decision?.id);
  });

  it("requires every term, ignores case and returns ids in step order", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Fix the Login flow" });
    b.agent({ type: "agent_message", role: "assistant", text: "Looking at login.ts" });
    b.agent({ type: "file_changed", path: "src/auth/login.ts" });
    const session = foldRows(testMeta(), b.rows, { live: false });
    const index = buildSearchIndex(session);
    expect(searchSteps(index, "LOGIN")).toEqual(["step:1", "step:2", "step:3"]);
    expect(searchSteps(index, "login auth")).toEqual(["step:3"]);
    expect(searchSteps(index, "   ")).toEqual([]);
  });

  it("matches test failure names and never stdout", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "command_started", command: "pnpm test" });
    b.agent({ type: "command_completed", command: "pnpm test", exitCode: 1, stdout: "SECRET_STDOUT_MARKER", stderr: "" });
    b.fact({
      type: "test_result",
      runner: "vitest",
      command: "pnpm test",
      passed: 0,
      failed: 1,
      skipped: 0,
      failures: [{ file: "a.test.ts", testName: "links a Google identity", message: "x" }],
    });
    const index = buildSearchIndex(foldRows(testMeta(), b.rows, { live: false }));
    expect(searchSteps(index, "google identity")).toEqual(["step:2"]);
    expect(searchSteps(index, "secret_stdout_marker")).toEqual([]);
  });

  it("indexes only the first 8 KiB of message text", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "agent_message", role: "assistant", text: `${"a".repeat(9 * 1024)} needle` });
    const index = buildSearchIndex(foldRows(testMeta(), b.rows, { live: false }));
    expect(searchSteps(index, "needle")).toEqual([]);
  });
});
```

Create `packages/trace-viewer/src/model/lookup.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { FIXTURE_NAMES, loadFixtureTrace } from "../test-support/fixture-rows.js";
import { TraceBuilder, testMeta } from "../test-support/trace-builder.js";
import { foldRows } from "./fold.js";
import { resolveStableId } from "./lookup.js";
import type { StableId } from "./types.js";

describe("resolveStableId", () => {
  it.each(FIXTURE_NAMES)("resolves every id in a folded %s session", (name) => {
    const trace = loadFixtureTrace(name);
    const session = foldRows(trace.meta, trace.rows, { live: false });
    const ids: StableId[] = [
      ...session.steps.map((step) => step.id),
      ...session.chapters.map((chapter) => chapter.id),
      ...session.entities.map((entity) => entity.id),
      ...session.findings.map((finding) => finding.id),
    ];
    for (const id of ids) expect(resolveStableId(session, id), id).not.toBeNull();
  });

  it("resolves decision:<id> to its one step after a status change", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const first = b.decision({ id: "dec-oauth-0001" });
    b.decision({ id: "dec-oauth-0001", status: "answered", answer: { decisionId: "dec-oauth-0001", decision: { x: "a" }, evidence: [] } });
    const session = foldRows(testMeta(), b.rows, { live: false });
    const resolved = resolveStableId(session, "decision:dec-oauth-0001");
    expect(resolved?.kind).toBe("decision");
    expect(resolved?.kind === "decision" ? resolved.step.id : null).toBe(`step:${first}`);
    expect(resolved?.kind === "decision" ? resolved.step.decision?.status : null).toBe("answered");
  });

  it("returns null for unknown or malformed ids", () => {
    const session = foldRows(testMeta(), [], { live: false });
    expect(resolveStableId(session, "step:99")).toBeNull();
    expect(resolveStableId(session, "file:nope.ts")).toBeNull();
    expect(resolveStableId(session, "chapter:1" as StableId)).toBeNull();
  });
});
```

Create `packages/trace-viewer/src/model/graphics.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { loadFixtureTrace } from "../test-support/fixture-rows.js";
import { TraceBuilder, testMeta } from "../test-support/trace-builder.js";
import { foldRows } from "./fold.js";
import { describeGraphic, pickGraphic } from "./format.js";
import type { Chapter, GraphicSpec, Step, TraceSession } from "./types.js";

function hunk(file: string, added: number, removed: number) {
  return { type: "git_hunk" as const, file, added, removed, isFormattingOnly: false, isConfigOnly: false, isLockfile: false };
}

function chapterOf(session: TraceSession, unitId: string): Chapter {
  const chapter = session.chapters.find((candidate) => candidate.changeUnitId === unitId);
  if (chapter === undefined) throw new Error(`no chapter for ${unitId}`);
  return chapter;
}

function stepAt(session: TraceSession, seq: number): Step {
  const step = session.steps.find((candidate) => candidate.firstSeq === seq);
  if (step === undefined) throw new Error(`no step starts at seq ${seq}`);
  return step;
}

describe("pickGraphic: steps", () => {
  it("picks tests, claim, diff and fork graphics on oauth", () => {
    const trace = loadFixtureTrace("oauth");
    const session = foldRows(trace.meta, trace.rows, { live: false });
    const byKind = (kind: string) => session.steps.find((step) => step.kind === kind);
    expect(pickGraphic(byKind("test") as NonNullable<ReturnType<typeof byKind>>, session)).toEqual({
      kind: "tests",
      passed: 14,
      failed: 1,
      skipped: 0,
    });
    const claimStep = session.steps.find((step) => step.problems.includes("claim_contradicted"));
    expect(claimStep && pickGraphic(claimStep, session)).toMatchObject({
      kind: "claim",
      claim: { text: "OAuth implementation complete; all checks pass.", tMs: claimStep?.tMs },
      observed: { passed: 14, failed: 1, command: "pnpm test" },
    });
    const edit = session.steps.find((step) => step.edit?.path === "src/auth/identity.ts");
    // Counts come from the fixture row, never a literal: A1-9 reconciles fixture git_hunk counts
    // with the real diffs (index §4, fixture drift).
    const fixtureHunk = trace.rows.find((row) => {
      const payload = row.payload as { type?: string; file?: string };
      return row.type === "evidence_fact" && payload.type === "git_hunk" && payload.file === "src/auth/identity.ts";
    })?.payload as { added: number; removed: number } | undefined;
    expect(fixtureHunk).toBeDefined();
    expect(edit && pickGraphic(edit, session)).toEqual({ kind: "diff", added: fixtureHunk?.added, removed: fixtureHunk?.removed });
    const decision = byKind("decision");
    expect(decision && pickGraphic(decision, session)).toEqual({
      kind: "fork",
      options: [
        { label: "Match by email", chosen: false },
        { label: "Require explicit linking", chosen: true },
      ],
      decidedBy: "supervisor",
    });
    const message = byKind("message");
    expect(message && pickGraphic(message, session)).toBeNull();
  });

  it("draws commands as durations: open while running, an x for a failed command, a dot for a failed check", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const make = b.agent({ type: "command_started", command: "make" });
    b.agent({ type: "command_completed", command: "make", exitCode: 2, stdout: "", stderr: "" });
    const lint = b.agent({ type: "command_started", command: "pnpm lint" });
    b.agent({ type: "command_completed", command: "pnpm lint", exitCode: 1, stdout: "", stderr: "" });
    const install = b.agent({ type: "command_started", command: "pnpm install" });
    const session = foldRows(testMeta(), b.rows, { live: true });
    expect(pickGraphic(stepAt(session, make), session)).toEqual({
      kind: "duration",
      durationMs: 1_000,
      running: false,
      status: "failed",
      end: "exit_x",
    });
    expect(pickGraphic(stepAt(session, lint), session)).toEqual({
      kind: "duration",
      durationMs: 1_000,
      running: false,
      status: "failed",
      end: "bad_dot",
    });
    expect(pickGraphic(stepAt(session, install), session)).toEqual({
      kind: "duration",
      durationMs: null,
      running: true,
      status: "running",
      end: "none",
    });
  });
});

describe("pickGraphic: chapters follow CHAPTER_GRAPHIC", () => {
  it("draws a schema chapter as tables and falls back to a diff list without schema data", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.fact(hunk("migrations/1.sql", 12, 0));
    b.unit({
      id: "cu_schema",
      category: "schema",
      files: ["migrations/1.sql"],
      schemaChanges: [
        { entity: "identities", entityType: "table", change: "added" },
        { entity: "identities.user_id", entityType: "column", change: "added" },
        { entity: "users.password_hash", entityType: "column", change: "removed" },
        { entity: "users_email_idx", entityType: "index", change: "added" },
      ],
    });
    b.unit({ id: "cu_bare", category: "schema", files: ["migrations/1.sql"] });
    const session = foldRows(testMeta(), b.rows, { live: false });
    expect(pickGraphic(chapterOf(session, "cu_schema"), session)).toEqual({
      kind: "table",
      tables: [
        { name: "identities", role: "new", columns: 1 },
        { name: "users", role: "altered", columns: 1 },
      ],
    });
    expect(pickGraphic(chapterOf(session, "cu_bare"), session)).toEqual({
      kind: "diff",
      added: 12,
      removed: 0,
      files: [{ path: "migrations/1.sql", added: 12, removed: 0 }],
    });
  });

  it("draws architecture and api chapters as a flow of file stems in first-edit order", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.fact(hunk("src/auth/identity.ts", 24, 0));
    b.fact(hunk("src/auth/google.ts", 34, 0));
    b.fact(hunk("src/server/index.ts", 11, 3));
    b.fact(hunk("src/auth/service.ts", 7, 12));
    b.unit({
      id: "cu_arch",
      category: "architecture",
      files: ["src/server/index.ts", "src/auth/service.ts", "src/auth/google.ts", "src/auth/identity.ts"],
    });
    b.unit({ id: "cu_api", category: "api", files: ["src/server/index.ts"] });
    const session = foldRows(testMeta(), b.rows, { live: false });
    expect(pickGraphic(chapterOf(session, "cu_arch"), session)).toEqual({
      kind: "flow",
      nodes: ["identity", "google", "index"],
      focus: 1,
    });
    expect(pickGraphic(chapterOf(session, "cu_api"), session)).toEqual({ kind: "flow", nodes: ["index"], focus: 0 });
  });

  it("draws a tests chapter with its latest run's counts", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.fact(hunk("tests/a.test.ts", 5, 0));
    for (const [passed, failed, id] of [[4, 1, "val_1"], [5, 0, "val_2"]] as const) {
      b.agent({ type: "command_started", command: "pnpm test" });
      b.agent({ type: "command_completed", command: "pnpm test", exitCode: failed > 0 ? 1 : 0, stdout: "", stderr: "" });
      b.fact({ type: "test_result", runner: "vitest", command: "pnpm test", passed, failed, skipped: 0, failures: [] });
      b.validation({ id, kind: "test", command: "pnpm test", status: failed > 0 ? "failed" : "passed", passed, failed, skipped: 0 });
    }
    b.unit({ id: "cu_tests", category: "tests", files: ["tests/a.test.ts"], validationResults: ["val_1", "val_2"] });
    b.unit({ id: "cu_untested", category: "tests", files: ["tests/a.test.ts"] });
    const session = foldRows(testMeta(), b.rows, { live: false });
    expect(pickGraphic(chapterOf(session, "cu_tests"), session)).toEqual({ kind: "tests", passed: 5, failed: 0, skipped: 0 });
    expect(pickGraphic(chapterOf(session, "cu_untested"), session)).toEqual({
      kind: "diff",
      added: 5,
      removed: 0,
      files: [{ path: "tests/a.test.ts", added: 5, removed: 0 }],
    });
  });

  it("draws a chapter with an answered decision as a fork", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.fact(hunk("src/link.ts", 6, 1));
    b.decision({ id: "dec-1", title: "Linking policy" });
    b.decision({
      id: "dec-1",
      title: "Linking policy",
      status: "answered",
      answer: { decisionId: "dec-1", decision: { policy: "b" }, evidence: [] },
    });
    b.decision({ id: "dec-2", title: "Still open" });
    b.unit({ id: "cu_linked", files: ["src/link.ts"], relatedDecisions: ["dec-1"] });
    b.unit({ id: "cu_waiting", files: ["src/link.ts"], relatedDecisions: ["dec-2"] });
    const session = foldRows(testMeta(), b.rows, { live: false });
    expect(pickGraphic(chapterOf(session, "cu_linked"), session)).toEqual({
      kind: "fork",
      options: [
        { label: "Option A", chosen: false },
        { label: "Option B", chosen: true },
      ],
      decidedBy: "supervisor",
    });
    expect(pickGraphic(chapterOf(session, "cu_waiting"), session)).toMatchObject({ kind: "diff", added: 6, removed: 1 });
  });

  it("lists a chapter's top 4 files by lines changed and counts the rest", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const sizes = [
      ["a.ts", 3, 1],
      ["b.ts", 2, 2],
      ["c.ts", 10, 0],
      ["d.ts", 1, 0],
      ["e.ts", 0, 6],
      ["f.ts", 1, 1],
    ] as const;
    for (const [file, added, removed] of sizes) b.fact(hunk(file, added, removed));
    b.unit({ id: "cu_code", files: sizes.map(([file]) => file) });
    const session = foldRows(testMeta(), b.rows, { live: false });
    expect(pickGraphic(chapterOf(session, "cu_code"), session)).toEqual({
      kind: "diff",
      added: 17,
      removed: 10,
      files: [
        { path: "c.ts", added: 10, removed: 0 },
        { path: "e.ts", added: 0, removed: 6 },
        { path: "a.ts", added: 3, removed: 1 },
        { path: "b.ts", added: 2, removed: 2 },
      ],
      moreFiles: 2,
    });
  });
});

describe("describeGraphic", () => {
  it.each<[GraphicSpec, string]>([
    [{ kind: "tests", passed: 14, failed: 1, skipped: 0 }, "14 passed, 1 failed"],
    [{ kind: "tests", passed: 3, failed: 0, skipped: 2 }, "3 passed, 0 failed, 2 skipped"],
    [{ kind: "diff", added: 17, removed: 3 }, "+17 −3"],
    [
      { kind: "diff", added: 17, removed: 10, files: [{ path: "c.ts", added: 10, removed: 0 }], moreFiles: 5 },
      "+17 −10 in 6 files",
    ],
    [{ kind: "duration", durationMs: 5_000, running: false, status: "failed", end: "bad_dot" }, "5.0 s, failed"],
    [{ kind: "duration", durationMs: null, running: true, status: "running", end: "none" }, "running"],
    [
      { kind: "fork", options: [{ label: "Fail open", chosen: true }, { label: "Fail closed", chosen: false }], decidedBy: "supervisor" },
      "2 options; you chose Fail open",
    ],
    [{ kind: "fork", options: [{ label: "A", chosen: false }], decidedBy: "open" }, "1 option; open"],
    [{ kind: "flow", nodes: ["User", "Identity", "Session"], focus: 1 }, "User → Identity → Session"],
    [
      {
        kind: "table",
        tables: [
          { name: "identities", role: "new", columns: 0 },
          { name: "users", role: "altered", columns: 1 },
        ],
      },
      "identities (new); users (altered, 1 column)",
    ],
    [
      {
        kind: "claim",
        claim: { text: "All checks pass.", span: [0, 15], tMs: 43_000 },
        observed: { passed: 14, failed: 1, command: "pnpm test", tMs: 40_000 },
      },
      'Claimed "All checks pass."; pnpm test had 14 passed, 1 failed',
    ],
  ])("describes %j", (spec, text) => {
    expect(describeGraphic(spec)).toBe(text);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/model/search.test.ts src/model/lookup.test.ts src/model/graphics.test.ts`

Expected: FAIL, `Cannot find module './search.js'` and `'./lookup.js'`; every `graphics.test.ts` case fails with `TypeError: pickGraphic is not a function` or `TypeError: describeGraphic is not a function` (`format.ts` does not export them yet); `Test Files  3 failed (3)`.

- [ ] **Step 3: Write the search index**

Create `packages/trace-viewer/src/model/search.ts`:

```ts
import type { StepId, TraceSession } from "./types.js";

export interface SearchIndex {
  readonly entries: ReadonlyArray<{ id: StepId; haystack: string }>;
}

const TEXT_LIMIT = 8 * 1024;

/** One lower-cased haystack per step: headline, target, text (first 8 KiB), command, edit path,
 *  test failure names. No stdout (the model never holds it). */
export function buildSearchIndex(session: TraceSession): SearchIndex {
  return {
    entries: session.steps.map((step) => {
      const parts = [
        step.headline,
        step.target ?? "",
        (step.text ?? "").slice(0, TEXT_LIMIT),
        step.command?.command ?? "",
        step.edit?.path ?? "",
        ...(step.tests?.failures.map((failure) => failure.testName) ?? []),
      ];
      return { id: step.id, haystack: parts.join("\n").toLowerCase() };
    }),
  };
}

/** Lower-cased whitespace-split terms; every term must match; ids in step order. */
export function searchSteps(index: SearchIndex, query: string): StepId[] {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term !== "");
  if (terms.length === 0) return [];
  return index.entries.filter((entry) => terms.every((term) => entry.haystack.includes(term))).map((entry) => entry.id);
}
```

- [ ] **Step 4: Write the stable-id lookup**

Create `packages/trace-viewer/src/model/lookup.ts`:

```ts
import { parseStableId, type Chapter, type Entity, type Finding, type StableId, type Step, type TraceSession } from "./types.js";

export type ResolvedTarget =
  | { kind: "step"; step: Step }
  | { kind: "unit"; chapter: Chapter }
  | { kind: "decision"; step: Step }
  | { kind: "file"; entity: Entity }
  | { kind: "finding"; finding: Finding };

const indexes = new WeakMap<TraceSession, Map<string, ResolvedTarget>>();

function indexOf(session: TraceSession): Map<string, ResolvedTarget> {
  let index = indexes.get(session);
  if (index !== undefined) return index;
  index = new Map();
  for (const step of session.steps) {
    index.set(step.id, { kind: "step", step });
    if (step.decision !== undefined) index.set(`decision:${step.decision.decisionId}`, { kind: "decision", step });
  }
  for (const chapter of session.chapters) index.set(chapter.id, { kind: "unit", chapter });
  for (const entity of session.entities) index.set(entity.id, { kind: "file", entity });
  for (const finding of session.findings) index.set(finding.id, { kind: "finding", finding });
  indexes.set(session, index);
  return index;
}

/** The object a stable id names in this session, or null. decision:<id> resolves to its one
 *  decision step, which keeps step:<firstSeq> across status changes. */
export function resolveStableId(session: TraceSession, id: StableId): ResolvedTarget | null {
  if (parseStableId(id) === null) return null;
  return indexOf(session).get(id) ?? null;
}
```

- [ ] **Step 5: Write the mini-graphic specs in `format.ts`**

Decision record R25 puts `pickGraphic` and `describeGraphic` in `model/format.ts`. They use `formatDuration` from the same module, and `format.ts` imports only types from `./types.js`, so no import cycle appears. They emit the `GraphicSpec` shape in this task's Interfaces (UI index §1.2).

In `packages/trace-viewer/src/model/format.ts`, find:

```ts
import type { StepKind, TestCounts } from "./types.js";
```

Replace it with:

```ts
import type {
  Chapter,
  DecisionDetail,
  Entity,
  GraphicSpec,
  Step,
  StepKind,
  TestCounts,
  TraceSession,
} from "./types.js";
```

In `packages/trace-viewer/src/model/format.ts`, find the end of `stepHeadline`:

```ts
    case "attention":
      return "Attention scored";
  }
}
```

Replace it with:

```ts
    case "attention":
      return "Attention scored";
  }
}

// ------------------------------------------------------------ mini graphics (D8, R25)

type DurationEnd = Extract<GraphicSpec, { kind: "duration" }>["end"];
type TableEntry = Extract<GraphicSpec, { kind: "table" }>["tables"][number];

/** DiffBar lists at most this many files for a chapter, then "+k" (spec §7.5). */
const DIFF_FILES_MAX = 4;
/** FlowGlyph shows at most this many file stems (spec §7.12). */
const FLOW_NODES_MAX = 3;

function isChapter(target: Step | Chapter): target is Chapter {
  return target.id.startsWith("unit:");
}

function linesChanged(entity: Entity): number {
  return entity.added + entity.removed;
}

/** The chapter's file entities, in first-edit order (buildEntities builds them in step order). */
function chapterEntities(chapter: Chapter, session: TraceSession): Entity[] {
  const files = new Set(chapter.files);
  return session.entities.filter((entity) => files.has(entity.path));
}

/** Chapter.schema (spec §6.6): one entry per table named by a table/model item or by the prefix
 *  before the last "." of a column/field item; null without schema data. */
function tableSpec(chapter: Chapter): GraphicSpec | null {
  const tables = new Map<string, TableEntry>();
  const tableFor = (name: string): TableEntry => {
    let table = tables.get(name);
    if (table === undefined) {
      table = { name, role: "altered", columns: 0 };
      tables.set(name, table);
    }
    return table;
  };
  for (const change of chapter.schemaChanges) {
    if (change.entityType === "table" || change.entityType === "model") {
      const table = tableFor(change.entity);
      if (change.change === "added") table.role = "new";
      continue;
    }
    if (change.entityType !== "column" && change.entityType !== "field") continue;
    const dot = change.entity.lastIndexOf(".");
    if (dot <= 0) continue;
    tableFor(change.entity.slice(0, dot)).columns += 1;
  }
  return tables.size === 0 ? null : { kind: "table", tables: [...tables.values()] };
}

function fileStem(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** FlowGlyph (spec §7.12): up to 3 file stems in first-edit order; focus = most lines changed. */
function flowSpec(chapter: Chapter, session: TraceSession): GraphicSpec | null {
  const nodes = chapterEntities(chapter, session).slice(0, FLOW_NODES_MAX);
  if (nodes.length === 0) return null;
  let focus = 0;
  nodes.forEach((entity, index) => {
    const best = nodes[focus];
    if (best !== undefined && linesChanged(entity) > linesChanged(best)) focus = index;
  });
  return { kind: "flow", nodes: nodes.map((entity) => fileStem(entity.path)), focus };
}

/** TestDots for a tests chapter: the latest run with a test result among the steps its
 *  validations attached to and its joined steps. */
function chapterTestsSpec(chapter: Chapter, session: TraceSession): GraphicSpec | null {
  const ids = new Set<string>([...chapter.validationStepIds, ...chapter.stepIds]);
  let latest: Step | undefined;
  for (const step of session.steps) if (ids.has(step.id) && step.tests !== undefined) latest = step;
  const tests = latest?.tests;
  return tests === undefined
    ? null
    : { kind: "tests", passed: tests.passed, failed: tests.failed, skipped: tests.skipped };
}

function forkSpec(decision: DecisionDetail): GraphicSpec {
  return {
    kind: "fork",
    options: decision.options.map((option) => ({ label: option.label, chosen: option.chosen })),
    decidedBy: decision.decidedBy ?? "open",
  };
}

/** ForkGlyph for a chapter with an answered or delegated decision. */
function chapterForkSpec(chapter: Chapter, session: TraceSession): GraphicSpec | null {
  if (chapter.decisionIds.length === 0) return null;
  const ids = new Set(chapter.decisionIds.map((id) => id.slice("decision:".length)));
  const step = session.steps.find(
    (candidate) =>
      candidate.decision !== undefined &&
      ids.has(candidate.decision.decisionId) &&
      candidate.decision.decidedBy !== undefined,
  );
  return step?.decision === undefined ? null : forkSpec(step.decision);
}

/** DiffBar list: totals over the chapter's files, the top 4 by lines changed (ties by path), and
 *  how many more there are. */
function diffListSpec(chapter: Chapter, session: TraceSession): GraphicSpec | null {
  const entities = chapterEntities(chapter, session);
  if (entities.length === 0) return null;
  const ranked = [...entities].sort(
    (a, b) => linesChanged(b) - linesChanged(a) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  return {
    kind: "diff",
    added: entities.reduce((sum, entity) => sum + entity.added, 0),
    removed: entities.reduce((sum, entity) => sum + entity.removed, 0),
    files: ranked.slice(0, DIFF_FILES_MAX).map((entity) => ({ path: entity.path, added: entity.added, removed: entity.removed })),
    ...(ranked.length > DIFF_FILES_MAX ? { moreFiles: ranked.length - DIFF_FILES_MAX } : {}),
  };
}

/** spec §7.12 CHAPTER_GRAPHIC: the first rule that matches; a rule without data falls through. */
function chapterGraphic(chapter: Chapter, session: TraceSession): GraphicSpec | null {
  let spec: GraphicSpec | null = null;
  if (chapter.category === "schema") spec = tableSpec(chapter);
  else if (chapter.category === "architecture" || chapter.category === "api") spec = flowSpec(chapter, session);
  else if (chapter.category === "tests") spec = chapterTestsSpec(chapter, session);
  return spec ?? chapterForkSpec(chapter, session) ?? diffListSpec(chapter, session);
}

function durationSpec(step: Step): GraphicSpec {
  const running = step.status === "running";
  const exitCode = step.command?.exitCode ?? null;
  const end: DurationEnd =
    (step.kind === "test" || step.kind === "check") && step.status === "failed"
      ? "bad_dot"
      : step.kind === "command" && exitCode !== null && exitCode > 0
        ? "exit_x"
        : "none";
  return { kind: "duration", durationMs: running ? null : step.durationMs, running, status: step.status, end };
}

/** The mini graphic (D8) that replaces prose for a step or chapter, or null when none fits. */
export function pickGraphic(target: Step | Chapter, session: TraceSession): GraphicSpec | null {
  if (isChapter(target)) return chapterGraphic(target, session);
  const step = target;
  const finding = session.findings.find(
    (candidate) => candidate.ruleId === "claim_contradicted" && candidate.claim?.claim.stepId === step.id,
  );
  const claim = finding?.claim;
  if (claim !== undefined) {
    return {
      kind: "claim",
      claim: {
        text: claim.claim.text,
        ...(finding?.claimSpan !== undefined ? { span: finding.claimSpan } : {}),
        tMs: claim.claim.tMs,
      },
      observed: {
        passed: claim.observed.passed,
        failed: claim.observed.failed,
        command: claim.observed.command,
        tMs: claim.observed.tMs,
      },
    };
  }
  if (step.edit !== undefined) return { kind: "diff", added: step.edit.added, removed: step.edit.removed };
  if (step.tests !== undefined) {
    return { kind: "tests", passed: step.tests.passed, failed: step.tests.failed, skipped: step.tests.skipped };
  }
  if (step.decision !== undefined) return forkSpec(step.decision);
  if (step.command !== undefined) return durationSpec(step);
  return null;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Text alternative for a graphic (screen readers, tooltips, copy). */
export function describeGraphic(spec: GraphicSpec): string {
  switch (spec.kind) {
    case "diff": {
      const counts = `+${spec.added} −${spec.removed}`;
      const files = spec.files === undefined ? 0 : spec.files.length + (spec.moreFiles ?? 0);
      return files > 0 ? `${counts} in ${plural(files, "file")}` : counts;
    }
    case "tests":
      return `${spec.passed} passed, ${spec.failed} failed${spec.skipped > 0 ? `, ${spec.skipped} skipped` : ""}`;
    case "duration":
      if (spec.running) return "running";
      return spec.durationMs === null ? spec.status : `${formatDuration(spec.durationMs)}, ${spec.status}`;
    case "fork": {
      const chosen = spec.options.filter((option) => option.chosen).map((option) => option.label);
      const who = spec.decidedBy === "supervisor" ? "you chose" : spec.decidedBy === "delegated" ? "delegated:" : "open";
      return `${plural(spec.options.length, "option")}; ${who}${chosen.length > 0 ? ` ${chosen.join(", ")}` : ""}`;
    }
    case "flow":
      return spec.nodes.join(" → ");
    case "table":
      return spec.tables
        .map((table) => `${table.name} (${table.role}${table.columns > 0 ? `, ${plural(table.columns, "column")}` : ""})`)
        .join("; ");
    case "claim":
      return `Claimed "${spec.claim.text}"; ${spec.observed.command} had ${spec.observed.passed} passed, ${spec.observed.failed} failed`;
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/model/search.test.ts src/model/lookup.test.ts src/model/graphics.test.ts`

Expected: `Test Files  3 passed (3)`, `Tests  29 passed (29)` (search 4, lookup 7, graphics 18).

- [ ] **Step 7: Export from the model barrel**

In `packages/trace-viewer/src/model/index.ts`, find:

```ts
export * from "./signals.js";
```

Replace it with:

```ts
export * from "./signals.js";
export * from "./search.js";
export * from "./lookup.js";
```

(`pickGraphic` and `describeGraphic` are already exported through `export * from "./format.js";`, which B-1 added.)

Run: `pnpm --filter @jevcode/trace-viewer typecheck`

Expected: exits 0.

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/model`

Expected: no failures; 253 tests from this lane plus W0's `types.test.ts`.

- [ ] **Step 8: Root checks**

Run, in order, from `/Users/jwpark/Projects/jevcode-tv-b`:

```bash
pnpm -r build
pnpm -r typecheck
pnpm -r --workspace-concurrency=1 test
pnpm lint
```

Expected: each command exits 0. `pnpm -r build` includes `jevcode-trace-viewer-dev`, whose Vite plugin fails the build if any module reachable from `@jevcode/trace-viewer/model` imports a Node built-in (the browser-safety proof). `pnpm lint` prints nothing after `> pnpm exec eslint .`.

- [ ] **Step 9: Commit**

```bash
git add packages/trace-viewer/src/model/search.ts \
  packages/trace-viewer/src/model/search.test.ts \
  packages/trace-viewer/src/model/lookup.ts \
  packages/trace-viewer/src/model/lookup.test.ts \
  packages/trace-viewer/src/model/format.ts \
  packages/trace-viewer/src/model/graphics.test.ts \
  packages/trace-viewer/src/model/index.ts
git commit -m "feat(trace-viewer): add step search, stable-id lookup and mini-graphic specs"
```

### Task B-11: WorkspaceHost uses the model's labels (R12)

**Files:**
- Modify: `apps/desktop/src/renderer/components/WorkspaceHost.tsx` (the `@jevcode/contracts` import; the helper block `readable` … `eventSummary`; `statusLabel`; seven call sites)

**Interfaces:**
- Consumes (B-1, from `@jevcode/trace-viewer/model`): `agentEventLabel(event: NormalizedAgentEvent): string`, `agentStateLabel(state: AgentState): string`, `formatClock(ts: string, options?: { seconds?: boolean }): string`, `truncateMiddle(text: string, maxGraphemes: number): string`. `apps/desktop/package.json` already depends on `@jevcode/trace-viewer` (W0-1). `SessionStatePayload["state"]` is `AgentState` (`SessionStatePayloadSchema.state` is `AgentStateSchema`, packages/contracts/src/ipc.ts:92-99).
- Produces: no new names. WorkspaceHost keeps `eventKey`, `mergeEvents` and `isConversationEvent` (R12: "eventKey/mergeEvents are NOT moved") and deletes `readable`, `shortToolName`, `shortPath`, `formatTime`, `eventSummary` and `statusLabel` (deviation 5).

Visible label changes in the main window, all listed fixes: `agent_completed` reads "Turn ended" (was "Task completed"); paths keep the whole basename and cut the middle at 48 graphemes (was `…/` plus the last three segments), and show bidi and control characters as `⟨U+XXXX⟩` tokens (`truncateMiddle` calls `displayUntrusted`); exit −1 reads "finished (exit code unknown)" / "finished" (was "finished with exit -1" / "failed"). No desktop test asserts these strings (`grep -rn "Task completed" apps/desktop/src` finds only WorkspaceHost).

This task has no unit test: the renderer has no test harness (`apps/desktop/vitest.config.ts` includes only `src/**/*.test.ts`). The red/green signal is `tsc -p tsconfig.web.json`, which fails with `noUnusedLocals` while the old helpers remain.

- [ ] **Step 1: Build the model package so the desktop resolves it**

Run: `pnpm --filter @jevcode/trace-viewer build`

Expected: exits 0; `packages/trace-viewer/dist/model/index.d.ts` exists and `grep -c "format.js" packages/trace-viewer/dist/model/index.d.ts` prints `1`.

- [ ] **Step 2: Import the model labels**

In `apps/desktop/src/renderer/components/WorkspaceHost.tsx`, find:

```tsx
import {
  NormalizedAgentEventSchema,
  type NormalizedAgentEvent,
} from "@jevcode/contracts";
```

Replace it with:

```tsx
import {
  NormalizedAgentEventSchema,
  type NormalizedAgentEvent,
} from "@jevcode/contracts";
import {
  agentEventLabel,
  agentStateLabel,
  formatClock,
  truncateMiddle,
} from "@jevcode/trace-viewer/model";
```

- [ ] **Step 3: Switch the seven call sites**

In the same file, replace every occurrence (three) of

```tsx
<time>{formatTime(event.ts)}</time>
```

with

```tsx
<time>{formatClock(event.ts)}</time>
```

Then make these four single replacements:

| Find | Replace with |
|---|---|
| `<span>{eventSummary(event)}</span>` | `<span>{agentEventLabel(event)}</span>` |
| `{statusLabel(state)}` | `{agentStateLabel(state)}` |
| `? eventSummary(latestEvent)` | `? agentEventLabel(latestEvent)` |
| `<li key={file} title={file}>{shortPath(file)}</li>` | `<li key={file} title={file}>{truncateMiddle(file, 48)}</li>` |

- [ ] **Step 4: Run the renderer typecheck to see the old helpers fail**

Run: `pnpm --filter jevcode-desktop exec tsc -p tsconfig.web.json --noEmit`

Expected: FAIL with three `TS6133` errors in `src/renderer/components/WorkspaceHost.tsx`: `'formatTime' is declared but its value is never read.`, `'eventSummary' is declared but its value is never read.` and `'statusLabel' is declared but its value is never read.` (at lines 108, 114 and 199 on the W0 base).

- [ ] **Step 5: Delete the moved helpers**

In the same file, delete this whole block (it starts right after `mergeEvents` and ends right before `function isConversationEvent`; W0-4 added the `agent_reasoning` and `agent_interrupted` cases):

```tsx
function readable(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function shortToolName(value: string): string {
  const parts = value.split(".");
  return readable(parts[parts.length - 1] ?? value);
}

function shortPath(value: string): string {
  const parts = value.split("/");
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : value;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function eventSummary(event: NormalizedAgentEvent): string {
  switch (event.type) {
    case "agent_started":
      return "Started working on the task";
    case "agent_message":
      return event.role === "user" ? "Direction received" : event.text;
    case "agent_reasoning":
      return "Thinking";
    case "tool_started":
      return `Using ${shortToolName(event.tool)}`;
    case "tool_completed":
      return `Finished ${shortToolName(event.tool)}`;
    case "command_started":
      return `Running ${event.command}`;
    case "command_completed":
      return `${event.command} finished with exit ${event.exitCode}`;
    case "file_read":
      return `Reading ${shortPath(event.path)}`;
    case "file_changed":
      return `Changed ${shortPath(event.path)}`;
    case "approval_requested":
      return `Approval needed for ${event.command}`;
    case "test_started":
      return `Checking with ${event.command}`;
    case "test_completed":
      return `${event.command} ${event.exitCode === 0 ? "passed" : "failed"}`;
    case "agent_waiting":
      return "Waiting for direction";
    case "agent_completed":
      return "Task completed";
    case "agent_failed":
      return `Stopped: ${event.error}`;
    case "agent_interrupted":
      return event.reason === "stop"
        ? "Stopped"
        : event.reason === "steer"
          ? "Redirected"
          : "Paused";
  }
}

```

Then delete this function (it sits right before `function ActivityMark(`):

```tsx
function statusLabel(state: SessionStatePayload["state"]): string {
  switch (state) {
    case "starting":
      return "Starting";
    case "running":
      return "Working";
    case "waiting_decision":
      return "Needs your decision";
    case "paused":
      return "Paused";
    case "completed":
      return "Completed";
    case "failed":
      return "Stopped with an error";
  }
}

```

Run: `grep -cE "function (readable|shortToolName|shortPath|formatTime|eventSummary|statusLabel)\\(" apps/desktop/src/renderer/components/WorkspaceHost.tsx`

Expected: `0`.

- [ ] **Step 6: Verify the desktop typecheck, build and lint**

Run: `pnpm --filter jevcode-desktop typecheck`

Expected: exits 0 (all three `tsc` projects).

Run: `pnpm --filter jevcode-desktop build`

Expected: exits 0; the renderer bundle now includes the model barrel.

Run: `pnpm lint`

Expected: prints nothing after `> pnpm exec eslint .`.

- [ ] **Step 7: Root checks**

Run, in order, from `/Users/jwpark/Projects/jevcode-tv-b`:

```bash
pnpm -r build
pnpm -r typecheck
pnpm -r --workspace-concurrency=1 test
pnpm lint
```

Expected: each command exits 0. `pnpm -r build` includes `jevcode-trace-viewer-dev`, whose Vite plugin fails the build if any module reachable from `@jevcode/trace-viewer/model` imports a Node built-in (the browser-safety proof). `pnpm lint` prints nothing after `> pnpm exec eslint .`.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/renderer/components/WorkspaceHost.tsx
git commit -m "refactor(desktop): use trace-viewer model labels in WorkspaceHost"
```

---

### Task B-12: UI-required model fields (R25): turn plan and claim, claim fields, decision answers, instruction dedupe

Decision record R25 lists model fields the M4 UI needs and puts them in "W0 model types and lane B". W0-6 declares all of them in `types.ts`. Lane B derives them where each object is built: `Step.startMs` in B-3 (`createStep`, `toPublicStep`), `Chapter.current`, `Chapter.noise` and `Chapter.validationStepIds` in B-5 (`buildChapters`), `Finding.anchorStepId` in B-7 (every rule), `KIND_META[kind].lane` in B-2, `Chapter.evidenceLinks` in B-5 and `pickGraphic`/`describeGraphic` in `format.ts` in B-10. This task derives the optional rest: `Turn.planStepId`, `Turn.claimStepId`, the `claim_contradicted` fields `claimStepId`, `evidenceStepIds` and `claimSpan`, decision `target` and the absorbed decision answer (`DecisionDetail.answerSeq`). It also builds spec §6.6 "Instruction dedupe" (a §16 plan follow-up), because a relaunch that delivers a decision answer is undone by the same absorption. Its test file also pins the fields B-3, B-5 and B-7 derive.

**Files:**
- Create: `packages/trace-viewer/src/model/ui-fields.test.ts`
- Modify: `packages/trace-viewer/src/model/fold-state.ts` (`PendingAnswer`, `FoldState.pendingAnswer`, `FoldState.undelivered`, `FoldState.answeredPrompts`, `TurnDraft.instruction`, `removeStep`)
- Modify: `packages/trace-viewer/src/model/fold-agent.ts` (a user message becomes the pending decision answer; `deliverInstruction` and the steer echo)
- Modify: `packages/trace-viewer/src/model/fold-chapters.ts` (answer absorption, including a relaunch's instruction step; decision `target`)
- Modify: `packages/trace-viewer/src/model/signals.ts` (`matchSuccessClaim`, `isPlanText`, `markTurns`; `claim_contradicted` checks only `Turn.claimStepId` and sets `claimStepId`, `evidenceStepIds`, `claimSpan`)
- Modify: `packages/trace-viewer/src/model/fold.ts` (`markTurns` call in `finalize`)
- Modify: `packages/trace-viewer/src/model/fold-chapters.test.ts`, `packages/trace-viewer/src/model/fold.fixtures.test.ts` (two assertions that pinned the pre-R25 decision step; the oauth and api-break claim fields in every fixture variant)
- Modify: `packages/trace-viewer/src/model/fold.mutations.test.ts` (spec §11's two instruction-dedupe mutations)

**Interfaces:**
- Consumes: W0-6 `types.ts` R25 fields (`Step.startMs`, `Turn.planStepId?`, `Turn.claimStepId?`, `Chapter.current`, `Chapter.noise`, `Chapter.validationStepIds`, `Finding.anchorStepId`, `Finding.claimStepId?`, `Finding.evidenceStepIds?`, `Finding.claimSpan?: [number, number]`, `DecisionDetail.answerSeq?`); B-3 `fold-state.ts` (`FoldState`, `StepDraft`, `TurnDraft.stepIds: StepId[]`, `TurnDraft.lastAgentEvent`, `createStep(state, turn, ctx, init: StepInit): StepDraft`, `addRowToStep(step, ctx, evidence)`); B-5 `foldDecision(state, decision: Decision, ctx): void`, `ChapterState.decisionSteps: Map<string, StepDraft>`; B-7 `interface FindingDraft` (already carries `anchorStepId`, `claimStepId?`, `evidenceStepIds?`, `claimSpan?`), `SIGNALS`, `isSuccessClaim(text: string): boolean`; test support `TraceBuilder`, `testMeta()`, `loadFixtureTrace(name)`.
- Produces (exported from `@jevcode/trace-viewer/model`; index §2.6 carries the same text):
  - `Turn.planStepId`: the first assistant message before the turn's first edit that starts with "Plan" or lists at least two items. `Turn.claimStepId`: the turn's last success claim; `claim_contradicted` checks only this step.
  - `claim_contradicted` findings carry `claimStepId` (the claim step, equal to `anchorStepId`), `evidenceStepIds` (the failed run) and `claimSpan`: `[start, end)` in UTF-16 code units of the first non-negated success phrase ("all checks pass"), else of a clause-final completion word ("complete").
  - Decision steps: `target` = `Decision.id`. A user `agent_message` whose next decision row answers or delegates an already-open decision is absorbed: its instruction step is removed, its seq joins the decision step's `seqs`, and `DecisionDetail.answerSeq` names it. The decision step keeps `step:<firstSeq>`.
  - Instruction dedupe (spec §6.6): a user message whose trimmed text equals the prompt of the `agent_started` just before it (no other agent event between) joins that instruction step (a steer is one step, `firstSeq` = the relaunch, `seqs` = both rows). An `agent_started` whose trimmed prompt equals an earlier undelivered user message opens no instruction step; its seq joins that message's step. A relaunch that delivers a decision answer ends with no instruction step: when the answer row lands, the relaunch's step (relaunch and echo) is absorbed into the decision step, `answerSeq` is the echo, and `Turn.prompt` is the decision title; a relaunch after the answer row adds its seq to the decision step and takes the title too. A started turn's instruction item is the step whose `seqs` hold `turn.startSeq`.
  - `signals.ts` additions: `matchSuccessClaim(text: string): [number, number] | null`, `isPlanText(text: string): boolean`, `markTurns(turns: readonly Turn[], stepById: ReadonlyMap<StepId, Step>): void`.

- [ ] **Step 1: Write the failing test**

Create `packages/trace-viewer/src/model/ui-fields.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { loadFixtureTrace } from "../test-support/fixture-rows.js";
import { TraceBuilder, testMeta, type DecisionInput } from "../test-support/trace-builder.js";
import { foldRows } from "./fold.js";
import { pickGraphic } from "./format.js";
import { isPlanText, matchSuccessClaim } from "./signals.js";
import type { Step, TraceSession } from "./types.js";

// Fields the viewer UI needs from the model (decision record R25).

function fold(b: TraceBuilder): TraceSession {
  return foldRows(testMeta(), b.rows, { live: false });
}

function holding(session: TraceSession, seq: number): Step | undefined {
  return session.steps.find((step) => step.seqs.includes(seq));
}

describe("Step.startMs", () => {
  it("is the source time for agent rows and origin plus the inherited clock for pipeline rows", () => {
    const b = new TraceBuilder();
    const start = b.agent({ type: "agent_started", prompt: "p", ts: TraceBuilder.at(0) });
    const message = b.agent({ type: "agent_message", role: "assistant", text: "a", ts: TraceBuilder.at(4) });
    // replay.db stamps decision rows with the replay run's wall clock, days after the source times.
    const decision = b.decision({ id: "dec-1", ts: "2026-09-21T10:00:00.000Z" });
    const session = fold(b);
    expect(holding(session, start)?.startMs).toBe(Date.parse(TraceBuilder.at(0)));
    expect(holding(session, message)?.startMs).toBe(Date.parse(TraceBuilder.at(4)));
    expect(holding(session, decision)?.startMs).toBe(Date.parse(TraceBuilder.at(4)));
  });
});

describe("Turn.planStepId and Turn.claimStepId", () => {
  it("marks the plan before the first edit and the last success claim", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "agent_message", role: "assistant", text: "Looking at the code first." });
    const plan = b.agent({ type: "agent_message", role: "assistant", text: "Steps:\n1. add the route\n2. add a test" });
    b.agent({ type: "file_changed", path: "src/a.ts" });
    b.agent({ type: "agent_message", role: "assistant", text: "Plan: also update the docs" });
    b.agent({ type: "agent_message", role: "assistant", text: "All tests pass." });
    const claim = b.agent({ type: "agent_message", role: "assistant", text: "Done; all checks pass." });
    b.agent({ type: "agent_completed" });
    expect(fold(b).turns[0]).toMatchObject({ planStepId: `step:${plan}`, claimStepId: `step:${claim}` });
  });

  it("leaves both unset when no message qualifies", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "agent_message", role: "assistant", text: "Not all tests pass yet." });
    b.agent({ type: "agent_completed" });
    const turn = fold(b).turns[0];
    expect(turn?.planStepId).toBeUndefined();
    expect(turn?.claimStepId).toBeUndefined();
  });

  it("finds oauth's plan and claim", () => {
    const trace = loadFixtureTrace("oauth");
    const session = foldRows(trace.meta, trace.rows, { live: false });
    const plan = session.steps.find((step) => step.kind === "message" && step.text?.startsWith("Plan:") === true);
    const claim = session.steps.find((step) => step.text === "OAuth implementation complete; all checks pass.");
    expect(plan).toBeDefined();
    expect(claim).toBeDefined();
    expect(session.turns[0]).toMatchObject({ planStepId: plan?.id, claimStepId: claim?.id });
  });
});

describe("matchSuccessClaim and isPlanText", () => {
  it.each([
    ["OAuth implementation complete; all checks pass.", "all checks pass"],
    ["Refactor done. All tests pass now.", "All tests pass"],
    ["I checked it and the build is green", "build is green"],
    ["The migration is complete.", "complete"],
  ])("finds the claim in %j", (text, phrase) => {
    const span = matchSuccessClaim(text);
    expect(span).not.toBeNull();
    const [start, end] = span ?? [0, 0];
    expect(text.slice(start, end)).toBe(phrase);
  });

  it("returns null for negated or absent claims", () => {
    expect(matchSuccessClaim("Not all tests pass yet.")).toBeNull();
    expect(matchSuccessClaim("I'm done reading the file")).toBeNull();
  });

  it("accepts a Plan lead or two list items and rejects prose", () => {
    expect(isPlanText("Plan: introduce an Identity layer.")).toBe(true);
    expect(isPlanText("1. inspect\n2. edit")).toBe(true);
    expect(isPlanText("- one item only")).toBe(false);
    expect(isPlanText("I will plan later.")).toBe(false);
  });
});

describe("Chapter.current, Chapter.noise and Chapter.validationStepIds", () => {
  it("marks a superseded chapter not current and a lockfile-only chapter as noise", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.fact(
      { type: "git_hunk", file: "pnpm-lock.yaml", added: 40, removed: 2, isFormattingOnly: false, isConfigOnly: false, isLockfile: true },
      "fact_lock",
    );
    b.fact(
      { type: "git_hunk", file: "src/a.ts", added: 3, removed: 1, isFormattingOnly: false, isConfigOnly: false, isLockfile: false },
      "fact_code",
    );
    b.unit({ id: "cu_lock", files: ["pnpm-lock.yaml"], evidence: ["fact_lock"] });
    b.unit({ id: "cu_code", files: ["src/a.ts"], evidence: ["fact_code"], status: "superseded" });
    const byUnit = new Map(fold(b).chapters.map((chapter) => [chapter.changeUnitId, chapter]));
    expect(byUnit.get("cu_lock")).toMatchObject({ noise: true, current: true });
    expect(byUnit.get("cu_code")).toMatchObject({ noise: false, current: false });
  });

  it("marks a chapter noise when its latest Pass A row did not surface it", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.fact(
      { type: "git_hunk", file: "src/b.ts", added: 2, removed: 0, isFormattingOnly: false, isConfigOnly: false, isLockfile: false },
      "fact_b",
    );
    b.jev({ id: "jev_1", changeUnitId: "cu_quiet", clamps: [], pass: "A", output: { shouldSurface: true } });
    b.jev({ id: "jev_2", changeUnitId: "cu_quiet", clamps: [], output: { shouldSurface: false, clamps: [], guardrailSuppression: true } });
    b.jev({ id: "jev_3", changeUnitId: "cu_quiet", clamps: [], pass: "B", output: { attention: "surface" } });
    b.unit({ id: "cu_quiet", files: ["src/b.ts"], evidence: ["fact_b"] });
    expect(fold(b).chapters[0]).toMatchObject({ noise: true, current: true });
  });

  it("lists the steps its validation results attached to", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const run = b.agent({ type: "command_started", command: "pnpm test" });
    b.agent({ type: "command_completed", command: "pnpm test", exitCode: 0, stdout: "", stderr: "" });
    b.validation({ id: "val_1", kind: "test", command: "pnpm test", status: "passed", passed: 3, failed: 0, skipped: 0 });
    b.unit({ id: "cu_1", files: [], validationResults: ["val_1"] });
    expect(fold(b).chapters[0]?.validationStepIds).toEqual([`step:${run}`]);
  });
});

describe("decision steps", () => {
  it("absorbs the supervisor's answer into the decision step, targets the decision id and keeps the step id", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const open = b.decision({ id: "dec-1", title: "Linking policy" });
    const message = b.agent({ type: "agent_message", role: "user", text: "decision:\n  policy: b\n\ninstruction:\n  Use B." });
    const answered = b.decision({
      id: "dec-1",
      title: "Linking policy",
      status: "answered",
      answer: { decisionId: "dec-1", decision: { policy: "b" }, evidence: [] },
    });
    const session = fold(b);
    const step = session.steps.find((candidate) => candidate.kind === "decision");
    expect(step).toMatchObject({ id: `step:${open}`, target: "dec-1", seqs: [open, message, answered], lastSeq: answered });
    expect(step?.decision?.answerSeq).toBe(message);
    expect(session.steps.filter((candidate) => candidate.kind === "instruction").map((candidate) => candidate.firstSeq)).toEqual([1]);
    expect(session.turns[0]?.stepIds).not.toContain(`step:${message}`);
  });

  it("keeps a user message that no answer follows as an instruction", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.decision({ id: "dec-1" });
    const steer = b.agent({ type: "agent_message", role: "user", text: "Also add a test." });
    b.decision({ id: "dec-2" });
    expect(holding(fold(b), steer)?.kind).toBe("instruction");
  });
});

describe("instruction dedupe (spec §6.6)", () => {
  const answer = "decision:\n  policy: b\n\ninstruction:\n  Use B.";
  const answeredRow: DecisionInput = {
    id: "dec-1",
    title: "Linking policy",
    status: "answered",
    answer: { decisionId: "dec-1", decision: { policy: "b" }, evidence: [] },
  };

  it("folds a steer's echoed user message into its relaunch's instruction step", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Add the route." });
    b.agent({ type: "agent_message", role: "assistant", text: "Working on it." });
    b.agent({ type: "agent_interrupted", reason: "steer" });
    const relaunch = b.agent({ type: "agent_started", prompt: "Use the v2 API instead." });
    const echo = b.agent({ type: "agent_message", role: "user", text: "Use the v2 API instead.\n" });
    b.agent({ type: "agent_message", role: "assistant", text: "Switching to v2." });
    // The same words after the agent has acted are a new instruction.
    const again = b.agent({ type: "agent_message", role: "user", text: "Use the v2 API instead." });
    const session = fold(b);
    expect(session.steps.filter((step) => step.kind === "instruction").map((step) => step.seqs)).toEqual([[1], [relaunch, echo], [again]]);
    expect(holding(session, echo)).toMatchObject({ id: `step:${relaunch}`, firstSeq: relaunch, lastSeq: echo, turnIndex: 1 });
    expect(session.turns[1]).toMatchObject({ trigger: "steer", startSeq: relaunch, prompt: "Use the v2 API instead." });
  });

  it("keeps a queued instruction as the instruction item of the turn that delivers it", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Add the route." });
    const queued = b.agent({ type: "agent_message", role: "user", text: "Then add a test." });
    b.agent({ type: "agent_completed" });
    const relaunch = b.agent({ type: "agent_started", prompt: "Then add a test." });
    const session = fold(b);
    expect(session.steps.filter((step) => step.kind === "instruction").map((step) => step.seqs)).toEqual([[1], [queued, relaunch]]);
    // A turn's instruction item is the step holding its startSeq.
    expect(holding(session, relaunch)).toMatchObject({ id: `step:${queued}`, turnIndex: 0 });
    expect(session.turns[1]).toMatchObject({ trigger: "resume", startSeq: relaunch, prompt: "Then add a test." });
  });

  it("opens a decision relaunch's turn without an instruction step, whichever row comes first", () => {
    // sendDecision relaunches with the answer, echoes it, then the answer row lands.
    const live = new TraceBuilder();
    live.agent({ type: "agent_started", prompt: "p" });
    const open = live.decision({ id: "dec-1", title: "Linking policy" });
    const relaunch = live.agent({ type: "agent_started", prompt: answer });
    const echo = live.agent({ type: "agent_message", role: "user", text: answer });
    const answered = live.decision(answeredRow);
    const first = fold(live);
    expect(first.steps.filter((step) => step.kind === "instruction").map((step) => step.firstSeq)).toEqual([1]);
    expect(holding(first, relaunch)).toMatchObject({ id: `step:${open}`, kind: "decision", seqs: [open, relaunch, echo, answered] });
    expect(holding(first, relaunch)?.decision?.answerSeq).toBe(echo);
    expect(first.turns[1]).toMatchObject({ startSeq: relaunch, prompt: "Linking policy" });

    // The answer row lands before a relaunch that delivers the same text.
    const late = new TraceBuilder();
    late.agent({ type: "agent_started", prompt: "p" });
    const open2 = late.decision({ id: "dec-1", title: "Linking policy" });
    const message = late.agent({ type: "agent_message", role: "user", text: answer });
    const answered2 = late.decision(answeredRow);
    const relaunch2 = late.agent({ type: "agent_started", prompt: answer });
    const second = fold(late);
    expect(second.steps.filter((step) => step.kind === "instruction").map((step) => step.firstSeq)).toEqual([1]);
    expect(holding(second, relaunch2)).toMatchObject({ id: `step:${open2}`, seqs: [open2, message, answered2, relaunch2] });
    expect(second.turns[1]).toMatchObject({ startSeq: relaunch2, prompt: "Linking policy" });
  });
});

describe("Finding.anchorStepId and the claim fields", () => {
  it("pins oauth's contradiction to its claim and the failed run, with the claim span", () => {
    const trace = loadFixtureTrace("oauth");
    const session = foldRows(trace.meta, trace.rows, { live: false });
    const finding = session.findings.find((candidate) => candidate.ruleId === "claim_contradicted");
    const claim = session.steps.find((step) => step.text === "OAuth implementation complete; all checks pass.");
    const failed = session.steps.find((step) => step.kind === "test" && step.status === "failed");
    expect(claim).toBeDefined();
    expect(failed).toBeDefined();
    expect(finding).toMatchObject({
      anchorStepId: claim?.id,
      claimStepId: claim?.id,
      evidenceStepIds: [failed?.id],
      claimSpan: [31, 46],
    });
    const [start, end] = finding?.claimSpan ?? [0, 0];
    expect(claim?.text?.slice(start, end)).toBe("all checks pass");
    // ClaimVsObserved underlines the same span (B-10 pickGraphic reads Finding.claimSpan).
    expect(claim && pickGraphic(claim, session)).toMatchObject({ kind: "claim", claim: { span: [31, 46] } });
  });

  it("anchors every finding on a step it names", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "command_started", command: "git reset --hard" });
    b.agent({ type: "command_completed", command: "git reset --hard", exitCode: 0, stdout: "", stderr: "" });
    b.jev({ id: "jev_1", clamps: ["schema_floor"] });
    const trace = loadFixtureTrace("oauth");
    for (const session of [fold(b), foldRows(trace.meta, trace.rows, { live: false })]) {
      expect(session.findings.length).toBeGreaterThan(0);
      for (const finding of session.findings) {
        expect(finding.stepIds, finding.id).toContain(finding.anchorStepId);
        expect(session.steps.some((step) => step.id === finding.anchorStepId), finding.id).toBe(true);
      }
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/model/ui-fields.test.ts`

Expected: FAIL, `Tests  13 failed | 7 passed (20)`. The failures include `TypeError: matchSuccessClaim is not a function`, `TypeError: isPlanText is not a function` and the three "instruction dedupe (spec §6.6)" cases. The seven passing cases pin fields B-3, B-5 and B-7 already derive (`startMs`, `current`, `noise`, `validationStepIds`, `anchorStepId`) and two near misses ("leaves both unset when no message qualifies", "keeps a user message that no answer follows as an instruction"); they must stay green.

- [ ] **Step 3: Track the pending decision answer, undelivered instructions and each turn's instruction item, and add `removeStep`**

In `packages/trace-viewer/src/model/fold-state.ts`, find:

```ts
export interface QueueEntry {
```

Replace it with:

```ts
/** A user message that may answer an open decision: the step holding it and its own seq. The step
 *  is the relaunch's instruction step when the message echoed its agent_started (spec §6.6). */
export interface PendingAnswer {
  step: StepDraft;
  seq: number;
}

export interface QueueEntry {
```

In `packages/trace-viewer/src/model/fold-state.ts`, find:

```ts
  /** A decision row answered or delegated a decision in this turn. */
  decisionAnswered: boolean;
```

Replace it with:

```ts
  /** A decision row answered or delegated a decision in this turn. */
  decisionAnswered: boolean;
  /** The turn's instruction item (spec §6.6 "Instruction dedupe"): the step its agent_started
   *  opened, or the earlier user message that agent_started delivered; null for an implicit turn
   *  and for a relaunch that delivered a decision answer. */
  instruction: StepDraft | null;
```

In `packages/trace-viewer/src/model/fold-state.ts`, find:

```ts
    decisionAnswered: false,
    lastAgentEvent: null,
```

Replace it with:

```ts
    decisionAnswered: false,
    instruction: null,
    lastAgentEvent: null,
```

In `packages/trace-viewer/src/model/fold-state.ts`, find:

```ts
  /** Every step that carries a callId (open or closed). */
  readonly stepsByCallId = new Map<string, StepDraft>();
```

Replace it with:

```ts
  /** Every step that carries a callId (open or closed). */
  readonly stepsByCallId = new Map<string, StepDraft>();
  /** The latest user message since the last decision row: a candidate decision answer (R25). */
  pendingAnswer: PendingAnswer | null = null;
  /** User instruction steps that no agent_started has delivered yet, oldest first (spec §6.6). */
  readonly undelivered: StepDraft[] = [];
  /** Trimmed text of an absorbed decision answer -> its decision step and title, for a relaunch
   *  that delivers the answer after the answer row (spec §6.6). */
  readonly answeredPrompts = new Map<string, { step: StepDraft; title: string }>();
```

In `packages/trace-viewer/src/model/fold-state.ts`, find:

```ts
/** Changes a step's kind and moves it to that kind's lane. */
export function setKind(step: StepDraft, kind: StepKind): void {
  step.kind = kind;
  step.lane = KIND_META[kind].lane;
}
```

Replace it with:

```ts
/** Changes a step's kind and moves it to that kind's lane. */
export function setKind(step: StepDraft, kind: StepKind): void {
  step.kind = kind;
  step.lane = KIND_META[kind].lane;
}

/** Drops a step from the fold: a user message absorbed into a decision step (R25). */
export function removeStep(state: FoldState, step: StepDraft): void {
  const index = state.steps.indexOf(step);
  if (index >= 0) state.steps.splice(index, 1);
  const queued = state.undelivered.indexOf(step);
  if (queued >= 0) state.undelivered.splice(queued, 1);
  state.stepById.delete(step.id);
  const turn = state.turns[step.turnIndex];
  if (turn !== undefined) turn.stepIds = turn.stepIds.filter((id) => id !== step.id);
}
```

- [ ] **Step 4: Record a user message as the pending decision answer, fold a steer's echo and deliver instructions**

In `packages/trace-viewer/src/model/fold-agent.ts`, find:

```ts
    case "agent_message":
      if (event.role === "assistant") state.capabilities.add("agent_messages");
      createStep(state, turn, ctx, {
        kind: event.role === "user" ? "instruction" : "message",
        source: event.type,
        status: "info",
        actor: event.role === "user" ? "supervisor" : "agent",
        text: event.text,
        approxTime: true,
      });
      break;
```

Replace it with:

```ts
    case "agent_message": {
      if (event.role === "assistant") state.capabilities.add("agent_messages");
      const opening = turn.instruction;
      if (
        event.role === "user" &&
        opening !== null &&
        turn.lastAgentEvent === "agent_started" &&
        event.text.trim() === (opening.text ?? "").trim()
      ) {
        // A steer echoes its relaunch's prompt right after the agent_started: one instruction step
        // holds both rows (spec §6.6 "Instruction dedupe"). It may still be a decision answer.
        addRowToStep(opening, ctx, false);
        state.pendingAnswer = { step: opening, seq: ctx.seq };
        break;
      }
      const message = createStep(state, turn, ctx, {
        kind: event.role === "user" ? "instruction" : "message",
        source: event.type,
        status: "info",
        actor: event.role === "user" ? "supervisor" : "agent",
        text: event.text,
        approxTime: true,
      });
      if (event.role === "user") {
        // The latest user message may answer an open decision; the next decision row decides (R25).
        // A later relaunch with the same prompt delivers it (spec §6.6).
        state.pendingAnswer = { step: message, seq: ctx.seq };
        state.undelivered.push(message);
      }
      break;
    }
```

In `packages/trace-viewer/src/model/fold-agent.ts`, find:

```ts
    touchTurn(turn, ctx);
    createStep(state, turn, ctx, {
      kind: "instruction",
      source: event.type,
      status: "info",
      actor: "supervisor",
      text: event.prompt,
      approxTime: true,
    });
    turn.lastAgentEvent = event.type;
    return;
  }
```

Replace it with:

```ts
    touchTurn(turn, ctx);
    deliverInstruction(state, turn, ctx, event.prompt);
    turn.lastAgentEvent = event.type;
    return;
  }
```

In `packages/trace-viewer/src/model/fold-agent.ts`, find:

```ts
export function foldAgentEvent(state: FoldState, event: NormalizedAgentEvent, ctx: RowContext): void {
```

Replace it with:

```ts
/** Spec §6.6 "Instruction dedupe" for an agent_started. A prompt equal to an absorbed decision
 *  answer opens the turn without an instruction step and the turn takes the decision title; a
 *  prompt equal to an earlier undelivered user message delivers that step (the relaunch's seq joins
 *  it, and it is the turn's instruction item); any other prompt opens an instruction step. */
function deliverInstruction(state: FoldState, turn: TurnDraft, ctx: RowContext, prompt: string): void {
  const key = prompt.trim();
  const answered = state.answeredPrompts.get(key);
  if (answered !== undefined) {
    state.answeredPrompts.delete(key);
    addRowToStep(answered.step, ctx, false);
    turn.prompt = answered.title;
    turn.instruction = null;
    return;
  }
  const index = state.undelivered.findIndex((step) => (step.text ?? "").trim() === key);
  const queued = index >= 0 ? state.undelivered[index] : undefined;
  if (queued !== undefined) {
    state.undelivered.splice(index, 1);
    addRowToStep(queued, ctx, false);
    // Delivered as an instruction, so no longer a candidate decision answer.
    if (state.pendingAnswer?.step === queued) state.pendingAnswer = null;
    turn.instruction = queued;
    return;
  }
  turn.instruction = createStep(state, turn, ctx, {
    kind: "instruction",
    source: "agent_started",
    status: "info",
    actor: "supervisor",
    text: prompt,
    approxTime: true,
  });
}

export function foldAgentEvent(state: FoldState, event: NormalizedAgentEvent, ctx: RowContext): void {
```

- [ ] **Step 5: Absorb the answer and target the decision id**

In `packages/trace-viewer/src/model/fold-chapters.ts`, find:

```ts
import {
  addRowToStep,
  createStep,
  currentTurn,
  touchTurn,
```

Replace it with:

```ts
import {
  addRowToStep,
  createStep,
  currentTurn,
  removeStep,
  touchTurn,
```

In `packages/trace-viewer/src/model/fold-chapters.ts`, find:

```ts
/** Every row of one decision id folds into one step (step:<firstSeq>). */
export function foldDecision(state: FoldState, decision: Decision, ctx: RowContext): void {
  const turn = currentTurn(state, ctx);
  touchTurn(turn, ctx);
  state.chapters.decisionUnits.set(decision.id, [...decision.affectedChangeUnits]);
  if (decision.status === "answered" || decision.status === "delegated") turn.decisionAnswered = true;
  const existing = state.chapters.decisionSteps.get(decision.id);
  if (existing !== undefined) {
    addRowToStep(existing, ctx, false);
    existing.decision = decisionDetail(decision);
    existing.status = decisionStatus(decision);
```

Replace it with:

```ts
/** Every row of one decision id folds into one step (step:<firstSeq>, target = the decision id).
 *  A user message whose next decision row answers or delegates an already-open decision is the
 *  supervisor's answer: its instruction step is removed and its seqs join the decision step (R25). */
export function foldDecision(state: FoldState, decision: Decision, ctx: RowContext): void {
  const turn = currentTurn(state, ctx);
  touchTurn(turn, ctx);
  const answer = state.pendingAnswer;
  state.pendingAnswer = null;
  state.chapters.decisionUnits.set(decision.id, [...decision.affectedChangeUnits]);
  const closes = decision.status === "answered" || decision.status === "delegated";
  if (closes) turn.decisionAnswered = true;
  const existing = state.chapters.decisionSteps.get(decision.id);
  if (existing !== undefined) {
    const answerSeq = existing.decision?.answerSeq;
    addRowToStep(existing, ctx, false);
    existing.decision = decisionDetail(decision);
    if (answerSeq !== undefined) existing.decision.answerSeq = answerSeq;
    if (closes && answer !== null) {
      removeStep(state, answer.step);
      existing.seqs.push(...answer.step.seqs);
      existing.seqs.sort((a, b) => a - b);
      existing.decision.answerSeq = answer.seq;
      const relaunched = state.turns[answer.step.turnIndex];
      if (relaunched !== undefined && relaunched.instruction === answer.step) {
        // The answer was delivered as a steer: its relaunch opens a turn without an instruction
        // step, and the turn's prompt is the decision title (spec §6.6 "Instruction dedupe").
        relaunched.instruction = null;
        relaunched.prompt = decision.title;
      } else {
        state.answeredPrompts.set((answer.step.text ?? "").trim(), { step: existing, title: decision.title });
      }
    }
    existing.status = decisionStatus(decision);
```

In `packages/trace-viewer/src/model/fold-chapters.ts`, find:

```ts
  const step = createStep(state, turn, ctx, {
    kind: "decision",
    source: "decision",
    status: decisionStatus(decision),
  });
```

Replace it with:

```ts
  const step = createStep(state, turn, ctx, {
    kind: "decision",
    source: "decision",
    status: decisionStatus(decision),
    target: decision.id,
  });
```

- [ ] **Step 6: Add the claim span, the plan rule, `markTurns` and the claim fields**

In `packages/trace-viewer/src/model/signals.ts`, find:

```ts
  type TraceSession,
  type UnitStableId,
} from "./types.js";

export interface SignalInput {
```

Replace it with:

```ts
  type TraceSession,
  type Turn,
  type UnitStableId,
} from "./types.js";

export interface SignalInput {
```

In `packages/trace-viewer/src/model/signals.ts`, find:

```ts
/** True when some clause of text claims success without a negation (R10). */
export function isSuccessClaim(text: string): boolean {
  for (const clause of text.split(/[.;!?\n]+/)) {
    for (const pattern of [SUCCESS_PHRASE, SUCCESS_STATE]) {
      for (const match of clause.matchAll(pattern)) {
        const before = clause.slice(0, match.index);
        const after = clause.slice(match.index + match[0].length);
        if (!NEGATION_BEFORE.test(before) && !NEGATION_AFTER.test(after)) return true;
      }
    }
  }
  return false;
}
```

Replace it with:

```ts
/** A clause: text between . ; ! ? and line breaks. */
const CLAUSE = /[^.;!?\n]+/g;

/** [start, end) in UTF-16 code units of the first non-negated success phrase, else of the first
 *  non-negated clause-final completion word (Finding.claimSpan, R25); null when text claims no
 *  success. */
export function matchSuccessClaim(text: string): [number, number] | null {
  // Success phrases ("all checks pass") win over a clause-final completion word ("complete").
  for (const pattern of [SUCCESS_PHRASE, SUCCESS_STATE]) {
    for (const clauseMatch of text.matchAll(CLAUSE)) {
      const clause = clauseMatch[0];
      const base = clauseMatch.index;
      for (const match of clause.matchAll(pattern)) {
        const before = clause.slice(0, match.index);
        const after = clause.slice(match.index + match[0].length);
        if (!NEGATION_BEFORE.test(before) && !NEGATION_AFTER.test(after)) {
          return [base + match.index, base + match.index + match[0].length];
        }
      }
    }
  }
  return null;
}

/** True when some clause of text claims success without a negation (R10). */
export function isSuccessClaim(text: string): boolean {
  return matchSuccessClaim(text) !== null;
}

const PLAN_LEAD = /^\s*plan\b/i;

const LIST_ITEM = /^\s*(?:[-*\u2022]|\d+[.)])\s+\S/gm;

/** A plan message starts with "Plan" or lists at least two items (R25). */
export function isPlanText(text: string): boolean {
  return PLAN_LEAD.test(text) || (text.match(LIST_ITEM) ?? []).length >= 2;
}

/** Sets Turn.planStepId (the first plan message before the turn's first edit) and
 *  Turn.claimStepId (the turn's last success claim) (R25). finalize calls it before signals, and
 *  claim_contradicted checks only claimStepId. */
export function markTurns(turns: readonly Turn[], stepById: ReadonlyMap<StepId, Step>): void {
  for (const turn of turns) {
    const steps = turn.stepIds
      .map((id) => stepById.get(id))
      .filter((step): step is Step => step !== undefined);
    const firstEdit = steps.find((step) => step.kind === "edit");
    const plan = steps.find(
      (step) =>
        step.kind === "message" &&
        (firstEdit === undefined || step.firstSeq < firstEdit.firstSeq) &&
        isPlanText(step.text ?? ""),
    );
    if (plan !== undefined) turn.planStepId = plan.id;
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      const step = steps[index];
      if (step !== undefined && step.kind === "message" && isSuccessClaim(step.text ?? "")) {
        turn.claimStepId = step.id;
        break;
      }
    }
  }
}
```

In `packages/trace-viewer/src/model/signals.ts`, find:

```ts
    const stepById = new Map(session.steps.map((step) => [step.id, step]));
    // The last success claim of each turn.
    const claimIds = new Set<StepId>();
    for (const turn of session.turns) {
      for (let index = turn.stepIds.length - 1; index >= 0; index -= 1) {
        const step = stepById.get(turn.stepIds[index] as StepId);
        if (step !== undefined && step.kind === "message" && isSuccessClaim(step.text ?? "")) {
          claimIds.add(step.id);
          break;
        }
      }
    }
```

Replace it with:

```ts
    const stepById = new Map(session.steps.map((step) => [step.id, step]));
    // Only each turn's claimStepId (its last success claim, set by markTurns) is checked (R25).
    const claimIds = new Set<StepId>();
    for (const turn of session.turns) if (turn.claimStepId !== undefined) claimIds.add(turn.claimStepId);
```

In `packages/trace-viewer/src/model/signals.ts`, find:

```ts
      const text = step.text ?? "";
      drafts.push({
        anchorSeq: step.firstSeq,
        anchorStepId: step.id,
```

Replace it with:

```ts
      const text = step.text ?? "";
      const span = matchSuccessClaim(text);
      drafts.push({
        anchorSeq: step.firstSeq,
        anchorStepId: step.id,
```

In `packages/trace-viewer/src/model/signals.ts`, find:

```ts
            stepId: failed.id,
          },
        },
      });
```

Replace it with:

```ts
            stepId: failed.id,
          },
        },
        claimStepId: step.id,
        evidenceStepIds: [failed.id],
        ...(span !== null ? { claimSpan: span } : {}),
      });
```

- [ ] **Step 7: Mark turns in `finalize`**

In `packages/trace-viewer/src/model/fold.ts`, find:

```ts
import { applySignals, computeCoverage } from "./signals.js";
```

Replace it with:

```ts
import { applySignals, computeCoverage, markTurns } from "./signals.js";
```

In `packages/trace-viewer/src/model/fold.ts`, find:

```ts
  steps.sort((a, b) => a.firstSeq - b.firstSeq);
  const stepById = new Map<StepId, Step>(steps.map((step) => [step.id, step]));
```

Replace it with:

```ts
  steps.sort((a, b) => a.firstSeq - b.firstSeq);
  const stepById = new Map<StepId, Step>(steps.map((step) => [step.id, step]));
  markTurns(turns, stepById);
```

- [ ] **Step 8: Update the two assertions that pinned the pre-R25 decision step, and pin the fixture claim fields**

B-5's decision test and B-8's oauth decision test asserted that the answer message stays a separate instruction step. Under R25 it joins the decision step.

In `packages/trace-viewer/src/model/fold-chapters.test.ts`, find:

```ts
    const first = b.decision({ id: "dec-oauth-0001", title: "Linking policy" });
    b.agent({ type: "agent_message", role: "user", text: "decision:\n  policy: b\n\ninstruction:\n  Use B." });
```

Replace it with:

```ts
    const first = b.decision({ id: "dec-oauth-0001", title: "Linking policy" });
    const message = b.agent({ type: "agent_message", role: "user", text: "decision:\n  policy: b\n\ninstruction:\n  Use B." });
```

In `packages/trace-viewer/src/model/fold-chapters.test.ts`, find:

```ts
    expect(step).toMatchObject({ id: `step:${first}`, kind: "decision", lane: "supervisor", status: "ok", seqs: [first, answer] });
```

Replace it with:

```ts
    expect(step).toMatchObject({
      id: `step:${first}`,
      kind: "decision",
      lane: "supervisor",
      status: "ok",
      target: "dec-oauth-0001",
      seqs: [first, message, answer],
    });
```

In `packages/trace-viewer/src/model/fold-chapters.test.ts`, find:

```ts
      decidedBy: "supervisor",
    });
    expect(session.chapters[0]?.decisionIds).toEqual(["decision:dec-oauth-0001"]);
    expect(stepAt(session, 3).headline).toBe("Use B.");
```

Replace it with:

```ts
      decidedBy: "supervisor",
      answerSeq: message,
    });
    expect(session.chapters[0]?.decisionIds).toEqual(["decision:dec-oauth-0001"]);
    // The answer is absorbed into the decision step (R25): no instruction step of its own.
    expect(session.steps.some((candidate) => candidate.kind === "instruction" && candidate.firstSeq === message)).toBe(false);
```

In `packages/trace-viewer/src/model/fold.fixtures.test.ts`, find:

```ts
    expect(step.seqs).toEqual(decisionRows.map((row) => row.seq));
```

Replace it with:

```ts
    // The supervisor's answer (the user message between the first and last decision rows) joins
    // the decision step (R25).
    const firstDecision = decisionRows[0]?.seq ?? 0;
    const lastDecision = decisionRows[decisionRows.length - 1]?.seq ?? 0;
    const answer = findRow(
      rows,
      (row) => isAgent("agent_message")(row) && field(row, "role") === "user" && row.seq > firstDecision && row.seq < lastDecision,
      "decision answer",
    );
    expect(step.seqs).toEqual([...decisionRows.map((row) => row.seq), answer.seq].sort((a, b) => a - b));
    expect(step.decision?.answerSeq).toBe(answer.seq);
    expect(session.steps.some((candidate) => candidate.firstSeq === answer.seq)).toBe(false);
```

Pin the claim fields on both contradicted fixtures in all three variants (stored, legacy, captured). The spans are the fixture texts' own phrases, found by hand: `"all checks pass"` is at [31, 46) of oauth's claim and `"all tests pass"` at [36, 50) of api-break's.

In `packages/trace-viewer/src/model/fold.fixtures.test.ts`, find:

```ts
  it.each([
    ["oauth", "OAuth implementation complete; all checks pass."],
    ["api-break", "The endpoint change is complete and all tests pass."],
  ] as const)("%s: the claim is contradicted by the failed run's test_result", (name, text) => {
```

Replace it with:

```ts
  it.each([
    ["oauth", "OAuth implementation complete; all checks pass.", "all checks pass"],
    ["api-break", "The endpoint change is complete and all tests pass.", "all tests pass"],
  ] as const)("%s: the claim is contradicted by the failed run's test_result", (name, text, phrase) => {
```

In `packages/trace-viewer/src/model/fold.fixtures.test.ts`, find:

```ts
    // failing_tests is critical too and anchors earlier; the rule rank puts the contradiction first (spec §6.7).
    expect([...session.findings].sort(compareFindings)[0]?.ruleId).toBe("claim_contradicted");
  });
```

Replace it with:

```ts
    // failing_tests is critical too and anchors earlier; the rule rank puts the contradiction first (spec §6.7).
    expect([...session.findings].sort(compareFindings)[0]?.ruleId).toBe("claim_contradicted");
    // R25 claim fields: the turn's claim step, the failed run and the claimed phrase.
    const claimStep = stepContaining(session, claim.seq);
    expect(session.turns[0]?.claimStepId).toBe(claimStep.id);
    expect(contradictions[0]?.claimStepId).toBe(claimStep.id);
    expect(contradictions[0]?.evidenceStepIds).toEqual([stepContaining(session, result.seq).id]);
    const [start, end] = contradictions[0]?.claimSpan ?? [0, 0];
    expect(text.slice(start, end)).toBe(phrase);
  });
```

- [ ] **Step 9: Add the instruction-dedupe mutations (spec §11 M3)**

Two fixture mutations in the live row order `sendInstruction` and `sendDecision` produce (codex-adapter.ts:222-255): a steer's relaunch and echo inserted into rate-limit, and oauth's decision answer delivered by a relaunch before its echo.

In `packages/trace-viewer/src/model/fold.mutations.test.ts`, find:

```ts
function seqOf(rows: readonly TraceRow[], predicate: (row: TraceRow) => boolean): number {
  const row = rows.find(predicate);
  if (row === undefined) throw new Error("row not found");
  return row.seq;
}
```

Replace it with:

```ts
function seqOf(rows: readonly TraceRow[], predicate: (row: TraceRow) => boolean): number {
  const row = rows.find(predicate);
  if (row === undefined) throw new Error("row not found");
  return row.seq;
}

/** Inserts agent events before or after the first matching agent row, with that row's times, and
 *  renumbers every seq in order. */
function insertAgentRows(
  rows: readonly TraceRow[],
  predicate: (row: TraceRow) => boolean,
  where: "before" | "after",
  events: Record<string, unknown>[],
): TraceRow[] {
  const at = rows.findIndex(predicate);
  const anchor = rows[at];
  if (anchor === undefined) throw new Error("row not found");
  const added = events.map((event) => ({
    seq: 0,
    type: "agent_event",
    ts: anchor.ts,
    payload: { sessionId: field(anchor, "sessionId"), ts: field(anchor, "ts"), ...event },
  }));
  const index = where === "before" ? at : at + 1;
  return [...rows.slice(0, index), ...added, ...rows.slice(index)].map((row, position) => ({ ...row, seq: position + 1 }));
}
```

In `packages/trace-viewer/src/model/fold.mutations.test.ts`, find:

```ts
  it("an unknown row type from a newer build is a gap, not a crash", () => {
```

Replace it with:

```ts
  it("a steer yields one instruction step", () => {
    const steer = "Use a token bucket, not a fixed window.";
    const { rows, session } = mutate("rate-limit", (input) =>
      insertAgentRows(input, (row) => isPayload("agent_message", { role: "assistant" })(row) && String(field(row, "text")).startsWith("Plan:"), "after", [
        { type: "agent_interrupted", reason: "steer" },
        { type: "agent_started", prompt: steer },
        { type: "agent_message", role: "user", text: steer },
      ]),
    );
    const relaunch = seqOf(rows, isPayload("agent_started", { prompt: steer }));
    const echo = seqOf(rows, isPayload("agent_message", { text: steer }));
    const instructions = session.steps.filter((step) => step.kind === "instruction");
    expect(instructions.map((step) => step.text)).toEqual([field(rows[0] as TraceRow, "prompt"), steer]);
    expect(instructions[1]).toMatchObject({ firstSeq: relaunch, seqs: [relaunch, echo] });
    expect(session.turns.map((turn) => [turn.trigger, turn.outcome])).toEqual([
      ["initial", "interrupted"],
      ["steer", "completed"],
    ]);
    expect(session.gaps).toEqual([]);
  });

  it("a decision answered with an instruction yields no instruction step", () => {
    const trace = loadFixtureTrace("oauth");
    const answer = trace.rows.find(isPayload("agent_message", { role: "user" }));
    if (answer === undefined) throw new Error("no decision answer in oauth");
    const text = field(answer, "text");
    // sendDecision with an instruction relaunches Codex with the answer before it echoes it.
    const { rows, session } = mutate("oauth", (input) =>
      insertAgentRows(input, isPayload("agent_message", { role: "user" }), "before", [
        { type: "agent_interrupted", reason: "steer" },
        { type: "agent_started", prompt: text },
      ]),
    );
    const relaunch = seqOf(rows, isPayload("agent_started", { prompt: text }));
    const message = seqOf(rows, isPayload("agent_message", { role: "user" }));
    const title = field(rows.find((row) => row.type === "decision") as TraceRow, "title");
    expect(session.steps.filter((step) => step.kind === "instruction").map((step) => step.firstSeq)).toEqual([1]);
    const decision = session.steps.find((step) => step.kind === "decision");
    expect(decision?.seqs).toEqual(expect.arrayContaining([relaunch, message]));
    expect(decision?.decision?.answerSeq).toBe(message);
    expect(session.turns[1]).toMatchObject({ trigger: "steer", startSeq: relaunch, prompt: title });
    expect(session.findings.map((finding) => finding.ruleId).sort()).toEqual(["claim_contradicted", "failing_tests"]);
    expect(session.gaps).toEqual([]);
  });

  it("an unknown row type from a newer build is a gap, not a crash", () => {
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/model/ui-fields.test.ts`

Expected: `Test Files  1 passed (1)`, `Tests  20 passed (20)`.

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/model/fold.mutations.test.ts`

Expected: `Test Files  1 passed (1)`, `Tests  7 passed (7)`.

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/model/fold.fixtures.test.ts -t "claim is contradicted"`

Expected: `Tests  6 passed | 35 skipped (41)`: oauth and api-break in the stored, legacy and captured variants, each with `claimStepId`, `evidenceStepIds` and the claimed phrase.

Run: `pnpm --filter @jevcode/trace-viewer typecheck`

Expected: exits 0.

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/model`

Expected: no failures; 275 tests from this lane (253 before this task, plus 20 in `ui-fields.test.ts` and 2 new mutations) plus W0's `types.test.ts`. The parity property (B-9) still passes: absorption and instruction dedupe happen in `accumulate`, so every batch split folds to the same session.

- [ ] **Step 11: Root checks**

Run, in order, from `/Users/jwpark/Projects/jevcode-tv-b`:

```bash
pnpm -r build
pnpm -r typecheck
pnpm -r --workspace-concurrency=1 test
pnpm lint
```

Expected: each command exits 0. `pnpm lint` prints nothing after `> pnpm exec eslint .`.

- [ ] **Step 12: Commit**

```bash
git add packages/trace-viewer/src/model/ui-fields.test.ts \
  packages/trace-viewer/src/model/fold-state.ts \
  packages/trace-viewer/src/model/fold-agent.ts \
  packages/trace-viewer/src/model/fold-chapters.ts \
  packages/trace-viewer/src/model/signals.ts \
  packages/trace-viewer/src/model/fold.ts \
  packages/trace-viewer/src/model/fold-chapters.test.ts \
  packages/trace-viewer/src/model/fold.fixtures.test.ts \
  packages/trace-viewer/src/model/fold.mutations.test.ts
git commit -m "feat(trace-viewer): derive turn plan and claim, claim fields, decision answers and instruction dedupe"
```

## Lane completion

1. **Whole-lane check** on `tv/b-trace-model` after B-12: the root checks pass, and `pnpm --filter @jevcode/trace-viewer exec vitest run src/model` reports no failures (275 lane-B tests plus W0's `types.test.ts`).
2. **Rebase after A1 and A2 merge** (W1 merge order A1, A2, B). From `/Users/jwpark/Projects/jevcode-tv-b`:

```bash
git rebase main
pnpm install --frozen-lockfile
pnpm -r build
```

Then rerun the root checks. A1-9 changes `fixtures/*/events.jsonl` (M1 fields, `git_hunk.diff`, one oauth `agent_reasoning` line, the oauth failure text) and A1-8 fills `ChangeUnit.agentCallIds`. The B-2, B-4, B-5, B-7, B-8, B-10 and B-12 fixture tests select rows by content and derive `observed`/`inferred` from the rows, so they must stay green without edits. A failure there is a bug in this lane's test or fold, never a reason to edit fixtures (index §4).
3. **Hand-off notes** for the merge PR: the three benchmark means from B-9; the "Interface deviations" and "Spec alignment notes" above; that `@jevcode/trace-viewer/model` now exports the full fold API for the M4a UI lane; that a started turn's instruction item is the step whose `seqs` hold `turn.startSeq` (B-12 instruction dedupe), which is not in that turn's `stepIds` when the turn was opened by a queued instruction or a decision relaunch; and that spec §6.6 and §16 still describe the single-latest-run claim rule this lane does not use.
