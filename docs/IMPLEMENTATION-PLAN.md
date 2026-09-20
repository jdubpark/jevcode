# Jevcode MVP Implementation Plan

Status: v1 — parallelizable plan for the MVP
Companion docs: `SPEC.md` (decisions, contracts), `PRD-REVIEW.md`
Assumption: 3 engineers, ~10 calendar weeks including buffer. All estimates in engineer-days (ed).

---

## 1. Planning principles

1. **Contract-first.** `packages/contracts` ships first. Every track builds against it. UI, Jev, and evidence work never block on each other's internals.
2. **Model-independent core first.** Guardrails, confidence policy, degrade router, UI compiler, and clustering are pure functions with no model dependency. They are buildable immediately and unit-testable against fixtures.
3. **Fixtures before models.** The five replay scenarios are authored in week 1 and used by UI dev, integration tests, and Jev evals simultaneously.
4. **Spike-gated integration.** Two external dependencies (Codex CLI semantics, Jev SDK) are verified by spikes before their dependent work is committed.
5. **Milestones are demo-able.** Every milestone gate is a runnable checkpoint, per PRD §44.

## 2. Tracks (T0–T9)

| Track | Deliverables | Est. | Lane |
|---|---|---|---|
| T0 Scaffold | pnpm monorepo, `contracts` skeleton, CI, vitest, fixtures dir format | 3ed | A |
| T1 Desktop shell | Electron main/preload/renderer, IPC framework, repo open, app chrome, xterm terminal panel, debug panel skeleton | 8ed | A |
| T2 Agent integration | `agent-core` interface, Codex adapter, JSONL parser, interrupt/resume, approvals | 10ed | A |
| T3 Evidence engine | 7 collectors + worker pool + tree-sitter | 14ed | B |
| T4 Semantic engine | clustering, graph projection, validation extraction, pipeline orchestration | 10ed | B |
| T5 Jev harness | Jev client (TypeSafe + degrade), question primitives, guardrails, confidence policy, logging | 8ed | B/C split |
| T6 Generative UI | catalog, compiler, 11 components, SurfaceManager, streaming | 18ed | C |
| T7 Fixtures | 5 scenarios, golden specs, labels, replay runner, PlaybackMode client | 5ed | C |
| T8 Evals + telemetry | eval runner, Pass A/B suites, telemetry package | 6ed | B |
| T9 Stabilize | E2E demo, soak, perf vs SLOs, security checklist, bugfix buffer | 8ed | all |

Total: 90ed ≈ 3 lanes × ~30ed ≈ 7 weeks of focused work → 10 weeks with integration, demos, and buffer.

### 2.1 Lane assignments

- **Lane A (Platform):** T0, T1, T2, T9-4 (security checklist). ~22ed.
- **Lane B (Intelligence):** T3, T4, T8, and model-independent T5 pieces (T5-3 guardrails, T5-5 degrade router). ~33ed.
- **Lane C (Experience):** T7, T6, and model-dependent T5 pieces (T5-1 spike assist, T5-2 schemas/prompts, T5-4 policy, T5-6 debug UI). ~33ed.

Key split: **T5 is split by model-dependence**. Guardrails and degrade mode (T5-3, T5-5) are pure and parallelizable immediately after T0. SDK integration and prompt assembly (T5-1, T5-2) wait for the spike and T4 outputs.

## 3. Track task breakdown

### T0 Scaffold (3ed)
- T0-1 pnpm monorepo, base tsconfigs, ESLint/Prettier, turbo (0.5ed)
- T0-2 `packages/contracts` skeleton: zod schemas from SPEC §4, IPC channel map, CI (lint+typecheck+test) (0.5ed)
- T0-3 fixtures format spec: `events.jsonl`, `labels/attention.json` + `labels/projection.json`, `golden_specs/`, `expected_units.json`, seed repo conventions (1ed)
- T0-4 vitest + fast-check setup across packages, snapshot test conventions (1ed)

### T1 Desktop shell (8ed)
- T1-1 Electron skeleton: main/preload/renderer, `contextIsolation`, `sandbox`, no `nodeIntegration` (1.5ed)
- T1-2 IPC framework: channel registry, zod validation both directions, error contract (1.5ed)
- T1-3 Repo open flow: dialog, git validation, session base commit, recent-repos list (1ed)
- T1-4 App shell chrome: header (repo, branch, agent status, task status), generative workspace host, status bar, session switcher (2ed)
- T1-5 Terminal panel: xterm.js, PTY I/O channels, scrollback ring buffer (1.5ed) *(dummy PTY until T2-3)*
- T1-6 Debug panel skeleton: tabs (Events, Jev, Logs, Telemetry) (0.5ed)

### T2 Agent integration (10ed)
- T2-1 **SPIKE (gate):** Codex CLI semantics: JSONL structured output availability, SIGINT-pause → stdin-turn resume, approval flow, auth error surface. Deliverable: mapping table + recorded fixture of a real short run. (2ed)
- T2-2 `agent-core`: adapter interface, lifecycle state machine (`starting → running → waiting_decision → paused → completed/failed`), event normalizer contract (2ed)
- T2-3 Codex adapter: PTY spawn, JSONL parser, event mapping per T2-1 (2ed)
- T2-4 Transcript fallback normalizer (for when JSONL unavailable) (1.5ed)
- T2-5 Interrupt/resume + `StructuredDecision` serialization (PRD §8 format) (1.5ed)
- T2-6 Approval mapping: `approval_requested` → required Decision → allow/deny → stdin (1ed)

### T3 Evidence engine (14ed)
- T3-1 GitCollector + hunk classifier (formatting-only / config / lockfile) (2.5ed)
- T3-2 FileWatcher: chokidar, 300ms debounce, same-file merge, repo-root boundary (1.5ed)
- T3-3 Analysis worker pool + tree-sitter (`typescript`, `tsx`, `javascript`, `json`) (2ed)
- T3-4 SymbolCollector + `SymbolId` identity hashing vs base snapshot (2.5ed)
- T3-5 DependencyCollector: manifests + lockfile diffing (1.5ed)
- T3-6 TestCollector: vitest/jest/pytest output parsers (2ed)
- T3-7 CommandCollector + destructive classifier (pattern list from SPEC §8.3.1) (1ed)
- T3-8 RevertDetector: reset/revert observation (1ed)

### T4 Semantic engine (10ed)
- T4-1 Clustering: idle-split, connectivity graph, components, attachment, merge/supersede + property tests (3ed)
- T4-2 Graph projection (`graph_nodes`/`graph_edges`) + idempotent upserts (2ed)
- T4-3 Validation/Failure extraction + failing-test → ChangeUnit attachment (2ed)
- T4-4 Deterministic placeholder titles + semantic event emission (1ed)
- T4-5 Pipeline orchestration in main: batch windows (500ms/≤25), sequencing, stale-result discard (2ed)

### T5 Jev harness (8ed)
- T5-1 **SPIKE (gate):** TypeSafe — read live docs (https://docs.typesafe.ai/llms.txt index, JS SDK page, primitives page) + the TypeSafe skill at https://raw.githubusercontent.com/typesafe-ai/skills/main/skills/typesafe-ai/SKILL.md. Verify: JS SDK install + auth, batching semantics (many Choice/Noul/Score over one state), returned probability/confidence shapes, latency for a 9-question × 4-unit batch. Deliverable: `TypeSafeClient` exercising a labeled fixture (mocked when no key) + degrade fallback decision. (1.5ed, B)
- T5-2 Question schemas + prompt assembly, few-shot from PRD §34 examples, context truncation policy (2ed, C)
- T5-3 Guardrail engine: pre/post clamps, all 7 rules, unit-tested (1.5ed, B — no model dependency)
- T5-4 Confidence policy pure function (`renderMode` thresholds) (0.5ed, C)
- T5-5 Degrade router: evidence-type → category/importance/representation heuristic, `confidence=0.6`, "heuristic" flag (1ed, B)
- T5-6 `jev_decisions` logging + debug panel wiring (1.5ed, C)

### T6 Generative UI (18ed)
- T6-1 json-render integration: `defineCatalog` + registry + `Renderer` + action emit plumbing (2ed)
- T6-2 Compiler core: `compileUI` pure function, payload binding, secondary views, snapshot tests (2ed)
- T6-3 P0: `ChangeOverview`, `TestMatrix`, `FailureAnalysis` (3ed)
- T6-4 P0: `Decision` with `answer_decision`/`delegate_decision` + tradeoffs table (2ed)
- T6-5 P0: `CodeDiff` (diff2html) + `CodeEvidence` drilldown (1.5ed)
- T6-6 P1: `BehaviorDelta`, `ExecutionTimeline` (2ed)
- T6-7 P1: `SchemaDelta` (table layout), `DependencyDelta`, `ArchitectureDelta` (React Flow, ≤50 nodes) (3ed)
- T6-8 SurfaceManager: min lifetime, interaction lock, pinning, patch-not-swap, expansion/scroll preservation + unit tests (2ed)
- T6-9 Streaming: `createSpecStreamCompiler` patches + Phase A skeletons (1.5ed)

### T7 Fixtures (5ed)
- T7-1 Author 5 seed repos + `events.jsonl` (oauth, rate-limit, schema-change, api-break, dep-change) (3ed)
- T7-2 Golden compiler specs + labeled Pass A/B outputs for evals (1ed)
- T7-3 Replay runner + `PlaybackMode` Jev client (1ed)

### T8 Evals + telemetry (6ed)
- T8-1 Eval runner + metrics (precision/recall/MAE/set-accuracy) (2ed)
- T8-2 Pass A suite: should_surface, triad scores, category (2ed)
- T8-3 Pass B suite: representation, density, render mode (1ed)
- T8-4 Telemetry package: event schema, append API, debug export (1ed)

### T9 Stabilize (8ed)

- T9-1 E2E demo scenario (Playwright/Electron): rate-limit task, mocked agent, decision loop, completion review (2.5ed). **DONE (headless form):** `apps/desktop/src/main/pipeline/demo-e2e.test.ts` asserts the full PRD §58 sequence through the real pipeline. The live runbook is in `docs/demo.md`
- T9-2 Soak: 10k-event replay, SurfaceManager stability assertions (1ed) — **DONE:** `scripts/soak.mjs` (9,993 records, invariants held, timings in `docs/perf.md`). The soak found and fixed two quadratic rebuild paths
- T9-3 Perf pass vs SPEC §13 SLOs (1ed) — **DONE:** `scripts/perf.mjs` + `docs/perf.md` (all measurable SLOs pass)
- T9-4 Security checklist verification (SPEC §12) (1ed) — **DONE:** all six items PASS, recorded in `docs/security.md` (fixed redactor capture-group bug and missing `commands` table wiring)
- T9-5 Bugfix buffer, docs, PRD §59 acceptance walkthrough (2.5ed) — **DONE:** `docs/acceptance.md` maps all 17 criteria to evidence. The completion summary surface (acceptance #14) is implemented. Thread-id resume wiring is complete. Evals are green (MAE 0.048, representation set-acc 1.0)

## 4. Dependency graph and parallelization map

```
T0 ──┬── T1 ── T1-5(panel) ──┐
     ├── T2 ── T2-1 spike ───┼── M1
     ├── T3 ── T4 ── T5-2/1 ─┼── M2 ── M3 ── M4 ── M5 ── M6 ── M7
     ├── T5-3/5 (pure) ──────┘
     └── T7 ── T6 ── M0 ─────┘                          ↑ T6-4 wiring at M6
```

Strict dependencies: T0 → everything. T3 → T4 → T5 (model parts). T7 → T6 (dev loop) → M0. T2-1 spike → T2-3/5/6. T5-1 spike → T5-2.

Independence achieved:
- **UI (T6) starts week 1** against contracts + fixtures (PlaybackMode) — the longest track runs in parallel with everything.
- **Guardrails/degrade (T5-3/5-5) start week 1** — they are pure and fixture-driven.
- **Evidence (T3) and Agent (T2) never touch each other** until pipeline orchestration (T4-5) merges their streams.

Lane timeline (weeks):

```
        W1   W2   W3   W4   W5   W6   W7   W8   W9   W10
Lane A  T0   T1        [M0]  T2  [M1]  idle/gate fixes  T9-4
Lane B  T5-3/5(part)  T3 ──────── [M2] T4 ─── [M3] T8 ─ T9-3
Lane C  T7   T6-core  [M0] T6-P0  T6-P1 ── T5-1/2/4/6 ─ [M4/M5] T6-4 wiring [M6] [M7] T9-1
```

Note: Lane C owns M0 (week 4) and M4–M7 integration. Lane B owns M2/M3 and the eval gates. Lane A owns M1. M4–M7 are joint A+C efforts (the agent decision loop spans T2 + T6).

## 5. Milestones and gates (mapped to PRD §44)

| Gate | When | Contents | Exit criteria (demo-able) |
|---|---|---|---|
| **M0 UI prototype** | W4 | T0, T7, T6 core (catalog, compiler, P0+P1 components, SurfaceManager) | Replay oauth + rate-limit fixtures: surfaces transition, Decision interaction works, raw diff/terminal escape hatches present. **Review gate: does the reviewer understand the task faster than from the raw transcript?** If no, iterate UI before any live-agent work depends on it. |
| **M1 Live agent shell** | W5 | T1, T2 (post-spike) | Real `codex` task runs inside Jevcode on a real repo. Live events, terminal, git diff tracking, task status. No intelligence yet. |
| **M2 Evidence engine** | W6 | T3 complete | Replay of all 5 fixtures produces every fact type. SLOs §13 measured. Hunk classifier correctly flags formatting/lockfile cases. |
| **M3 Semantic events** | W7 | T4 complete | Human review of ChangeUnits on all 5 fixtures: units match the intended conceptual changes (≤1 mis-grouping per fixture allowed, logged as follow-up). |
| **M4 Jev attention** | W7.5 | T5 complete (Pass A live) | Formatting/lockfile suppressed. Schema/security/destructive surfaced. Eval targets hit (precision ≥0.9, recall ≥0.85). |
| **M5 Jev projection** | W8 | Pass B + compiler wiring | Golden-spec evals pass. Confidence policy enforced. Debug panel shows decisions. |
| **M6 Decision loop** | W8.5 | T2-5/6 + T6-4 live | Live agent pauses on required Decision. Answer resumes execution. Fail-open demo works end-to-end. |
| **M7 Semantic review** | W9 | Completion surface | Agent claims success but test fails → Jevcode shows observed failure (PRD §48 case). Review hierarchy correct. |
| **M8 Stabilize + demo** | W10 | T9 | All 17 acceptance criteria (SPEC §17) evidenced. PRD §58 demo script rehearsed. |

## 6. Critical path

`T0 → T3 (14ed) → T4 (10ed) → T5 model parts (6.5ed) → M4/M5 → M6 wiring → M7 → T9-1`

≈ 40ed on Lane B/C boundary. At 5ed/week this is ~8 weeks. With M0/M1 work fully parallelized, the minimum viable schedule is 8 weeks, planned 10 with buffer. To compress: add a 4th engineer to T3/T4 (split collectors vs. clustering), or cut P1 components (saves 7ed on Lane C, which is not on the critical path. Do this only for time, not scope).

## 7. Risk register

| # | Risk | Owner | Trigger | Response |
|---|---|---|---|---|
| R1 | Codex interrupt/resume not viable (T2-1 spike fails) | Lane A | Spike day 2 | Fallback mode: iterative `exec` turns. Interruption degrades to "stop at natural boundary". M6 redefined. |
| R2 | TypeSafe SDK/API specifics unsuitable (T5-1 spike fails) | Lane B/C | Spike day 1.5 | `DegradeClient` as default + documented provider swap. `JevClient` interface isolates the provider. |
| R3 | Clustering quality insufficient at M3 | Lane B | M3 review >1 mis-grouping | Tune weights (0.5/0.8/1.0) + bucket window. Last resort: Jev-assisted split suggestion (still deterministic confirm). |
| R4 | UI instability at soak (T9-2) | Lane C | >2 full swaps/min or scroll loss | SurfaceManager rule tuning. Extend min lifetime. Batch low-importance patches harder. |
| R5 | Over/under-surfacing in live use | Lane B | Eval drift or demo review | Guardrail thresholds per-category. Add deterministic suppression classes. |
| R6 | Event flood stalls pipeline | Lane B | T9-2 latency | Tighten merge/drop policy. Evidence worker scaling. |
| R7 | json-render API drift vs SPEC §9.2 | Lane C | Integration at T6-1 | Pin version at T0. Upgrade only with snapshot-test sweep. |
| R8 | Scope creep into post-MVP features | All | PRs touching deferred list (SPEC §18) | Deferred list is authoritative. Exceptions need plan owner sign-off. |

## 8. Definition of done

Status: **MET as of 2026-09-19** (stabilization pass: evidence in `docs/acceptance.md`, `docs/security.md`, `docs/perf.md`). The one deviation from the letter of the plan is the E2E form. The PRD §58 demo runs headless through the real pipeline (mock adapter + playback client) rather than Playwright-Electron. The live-agent demo is documented in `docs/demo.md`.

- All 17 acceptance criteria (PRD §59, SPEC §17) have a passing automated or E2E artifact.
- Eval suites committed with target metrics recorded in CI.
- Every Jev call logged (`jev_decisions`) and inspectable in the debug panel.
- Security checklist (SPEC §12) fully green.
- The PRD §58 demo runs end-to-end on the rate-limit fixture and once against a live agent.
- Fixtures, golden specs, and replay runner committed and reproducible (`pnpm evals`).
- `SPEC.md` is updated where implementation forced a contract change. No silent drift.

## 9. Sequencing notes for agents

- Work is dispatched per track task (T*-*), not per file. Each task lands as a PR against `main` with tests and closes its contract TODO list.
- Tracks may run simultaneously in separate worktrees. `contracts` changes require a rebase-first policy to avoid cross-track breakage.
- The two spikes (T2-1, T5-1) are the only tasks allowed to merge documentation-only artifacts. Their deliverables are tables/recordings committed under `docs/spikes/`.
- Never use `git stash` in worktrees. Set aside WIP with commits (see repo policy).
