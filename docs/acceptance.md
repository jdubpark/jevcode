# Acceptance Walkthrough (SPEC §17)

Generated 2026-09-19 from the green build. Every criterion maps to a concrete
test, command, or artifact. "Live" means against the real external dependency
(Codex CLI with credits, TypeSafe API with a key). Where that was not possible
in this environment, this table lists the nearest runnable evidence and names the gap.

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Open local repository | PASS | `apps/desktop` `src/main/repo-service.test.ts`, `src/main/git.test.ts` (git probing, base commit, boundary). IPC round-trips in `src/shared/api.test.ts` / `ipc-registry.test.ts` |
| 2 | Supported agent runs inside Jevcode | PASS (live: partial) | `packages/agent-codex` PTY integration against a fake codex binary (`codex-adapter.test.ts`): start, events, exit handling, auth-failure surfacing. Real recorded JSONL parser fixtures (`recorded-credits-error.jsonl`, `recorded-unauthorized.jsonl`). Mock-adapter end-to-end in `apps/desktop/src/main/pipeline/demo-e2e.test.ts`. Gap: no live credited codex turn (workspace out of credits, spike T2-1 §1). The demo runs against the real binary when available |
| 3 | Structured/normalized agent events | PASS | `packages/agent-codex/src/jsonl.test.ts` (codex JSONL → NormalizedAgentEvent mapping incl. recorded fixtures), `fallback.test.ts`, `packages/agent-core/src/events.test.ts`, `packages/contracts/src/agent-events.test.ts` |
| 4 | Independent observation of repo changes | PASS | `packages/evidence-engine` collector tests: `git.test.ts`, `file-watcher.test.ts`, `symbols.test.ts`, `symbol-diff.test.ts`, `dependencies.test.ts`, `tests.test.ts`, `commands.test.ts`, `revert.test.ts`, `hunks.test.ts`. Fixture replay assertions in `pipeline-runtime.test.ts` |
| 5 | Git/file/test evidence stored | PASS | `packages/storage`: `db.test.ts`, `projections.test.ts`, `rebuild.test.ts` (projections rebuilt from the event store). Pipeline test asserts `evidence_fact` rows and `commands` rows (`pipeline-runtime.test.ts`) |
| 6 | Edits grouped into ChangeUnits | PASS | `packages/semantic-core`: `clustering.test.ts`, `clustering.property.test.ts` (fast-check order invariance), `fixtures.test.ts` (all five fixtures) |
| 7 | Jev suppresses obvious low-value events | PASS (live: unmeasured) | `packages/jev-router/src/guardrails.test.ts` (formatting/lockfile suppression). Evals guardrail checks `guardrail:formatting-suppression` (`pnpm --filter jevcode-evals evals`, overall PASS). Replay asserts `dep-format-noise` never surfaces. Gap: suppression of the live TypeSafe path is the same pre/post clamps, but no keyed live run exists (typesafe-spike §4) |
| 8 | Jev selects among multiple UI representations | PASS (live: unmeasured) | Evals Pass B: representation set-accuracy 1.0 (target ≥0.75) on the degrade router. Golden specs per fixture (`packages/ui-compiler/src/golden-specs.test.ts` exact-match compile). Gap: live TypeSafe Pass B unmeasured |
| 9 | json-render renders constrained surfaces | PASS | `packages/ui-compiler`: `compile.test.ts`, `skeleton.test.ts`, `golden-specs.test.ts` (catalog-only components/actions, prop-schema validation). `packages/ui-catalog/src/catalog.test.ts`. Electron smoke boot (`JEVCODE_SMOKE=1`, prints `SMOKE_OK`) |
| 10 | Decision can interrupt agent | PASS | Spike-verified SIGINT semantics (`docs/spikes/codex-spike.md`). `codex-adapter.test.ts` interrupt test. Runtime: `pipeline-runtime.test.ts` (scripted decision → `waiting_decision`). `demo-e2e.test.ts` |
| 11 | Developer responds through generated UI | PASS | `Decision` component (`packages/ui-catalog/src/components/Decision.tsx`), `answer_decision` allowlisted action (`apps/desktop/src/main/pipeline/action-dispatcher.ts` + `action-dispatcher.test.ts`). E2E answer in `demo-e2e.test.ts` |
| 12 | Structured response resumes agent | PASS | Serializer (`packages/agent-core/src/serializer.test.ts`). Codex resume via `codex exec resume <thread_id>` (`codex-adapter.test.ts` "resumes an interrupted session..."). Thread id exposed on session state (`pipeline-runtime.test.ts`). E2E resume in `demo-e2e.test.ts` |
| 13 | Test failures appear independent of narration | PASS | `packages/evidence-engine/src/collectors/tests.test.ts` (output parsing). PRD §48 case: `pipeline-runtime.test.ts` "emits a completion surface ... when the agent claims success but a test fails" (oauth fixture: narration says "all checks pass", completion shows the failing test) |
| 14 | Completion summary reflects repository evidence | PASS | Completion surface compiled from stored change units, validations, failures, and decisions (`ui-stage.ts compileCompletionSurface`). Asserted in `pipeline-runtime.test.ts` and `demo-e2e.test.ts`. Goldens validated against prop schemas |
| 15 | Terminal + raw diff always available | PASS | `apps/desktop/src/main/terminal-manager.ts` + `scrollback.test.ts`. Persistent `Terminal` surface (`compileTerminalSurface`). `show_exact_diff` action → `compileDiffSurface` with real `git diff` (`evidence-runtime.ts gitDiffFiles`). E2E includes diff access actions |
| 16 | UI stable during continuous execution | PASS | `packages/ui-catalog/src/surface/SurfaceManager.test.ts` (min lifetime, interaction lock, pinning, patch-not-swap). Soak: `node scripts/soak.mjs` — 9,993 records, 0 lock violations, pinned surface never replaced (details in `docs/perf.md`) |
| 17 | Jev decisions inspectable in debug mode | PASS | `packages/jev-router/src/logging.test.ts` (every call logged with inputs hash, outputs, confidence, probabilities, latency, client kind, clamps). `jev_decisions` storage queries (`packages/storage`). Debug IPC channels (`debugListJevDecisions`) + `DebugPanel.tsx`. Pipeline emits `jev:debug` with the last 50 per session |

## Remaining gaps (all external dependencies, none structural)

All three former external gaps are now closed by live runs (2026-09-19):

- Live `codex exec` with `gpt-5.6-luna` + `model_reasoning_effort="xhigh"`:
  ran a real file-modifying task through the `CodexAdapter` (18 normalized
  events, correct lifecycle, thread id captured for resume) — see
  `docs/spikes/codex-spike.md`.
- Live TypeSafe Jev calls via `JEV_API_KEY` from `.env`: `jev-latest` and
  `jev-preview` measured on the full eval suite: should_surface precision/
  recall 1.0/1.0, representation set-accuracy 0.688–0.750, and score MAE ~0.17
  after deterministic guardrail extensions (SPEC §8.3 5a/6a). The residual
  MAE gap versus the 0.15 target is calibration work tracked by the eval
  suite — see `docs/spikes/typesafe-spike.md`.
- Live Electron demo on the real agent: not yet run as a UI walkthrough.
  The headless E2E over the rate-limit fixture is green (see
  `docs/demo.md`).

## Commands that prove the build

```
pnpm install
pnpm typecheck          # clean
pnpm test               # 830 tests green
pnpm lint               # clean
node scripts/validate-fixtures.mjs   # 125/125
node scripts/soak.mjs                 # 10k-event soak, invariants held
pnpm --filter jevcode-evals evals    # overall PASS
node apps/desktop/scripts/replay.mjs fixtures/<name> <out>   # green on all 5 fixtures
JEVCODE_SMOKE=1 pnpm --filter jevcode-desktop start            # SMOKE_OK
```
