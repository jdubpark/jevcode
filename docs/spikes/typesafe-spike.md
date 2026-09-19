# Spike T5-1: TypeSafe SDK for the Jev Harness

Date: 2026-09-19
Owner: jev-router track
Status: complete (doc-verified; run-verified only through the mocked transport — see Verification)

Sources (live docs, read as part of this spike):

- https://docs.typesafe.ai/llms.txt (index)
- https://docs.typesafe.ai/sdk/javascript.md
- https://docs.typesafe.ai/primitives.md
- https://docs.typesafe.ai/primitives/score.md
- https://docs.typesafe.ai/confidence.md
- https://docs.typesafe.ai/sdk/javascript/api/classes/TypeSafeClient.md
- https://docs.typesafe.ai/sdk/javascript/api/interfaces/ScoreResponse.md
- https://docs.typesafe.ai/sdk/javascript/api/interfaces/NoulResponse.md
- https://docs.typesafe.ai/sdk/javascript/api/interfaces/SystemOneResult.md
- https://docs.typesafe.ai/sdk/javascript/api/variables/ENV.md
- https://docs.typesafe.ai/sdk/javascript/api/functions/score.md
- https://raw.githubusercontent.com/typesafe-ai/skills/main/skills/typesafe-ai/SKILL.md (TypeSafe skill)

## 1. Install, package name, auth

- Package: `@typesafe-ai/sdk` (v0.6.0 installed in `packages/jev-router`). Node >= 20 required; repo uses Node >= 22. ESM + CJS + TS declarations; we consume the ESM build.
- Client: `new TypeSafeClient(config?)`. Method: `client.systemOne({ state, questions, model? })` -> `APIPromise<SystemOneResult<Q>>` with `.answers`, `.model`, `.usage`.
- Question builders: `choice(instructions, criteria)`, `noul(instructions, criteria?)`, `score(instructions, criteria)` imported from the same package. They return plain objects; the SDK `Questions` type is structural, so our pure question composition (`src/questions.ts`) does not import the SDK at all.
- Auth: `TYPESAFE_API_KEY` env var (SDK constant `ENV.apiKey`). Also supported: `TYPESAFE_BASE_URL` (default `https://api.typesafe.ai`), `TYPESAFE_DEFAULT_MODEL` (default `jev-latest`), `TYPESAFE_LOG_LEVEL` (default `warn`). Explicit constructor options beat env vars.
- Key handling in jev-router: read only in `SdkTransport` (lazy client construction) and in `health()`. We construct the SDK with `logLevel: "off"` so no request summaries or bodies are ever logged; the API key is never logged anywhere in jev-router. `health()` returns `"degraded"` when the key is absent; the selection factory (`createJevClient`) auto-selects `DegradeClient` in that case.

## 2. Primitive semantics (confirmed from docs)

- **Choice**: answer = `{ type: "choice", choice, confidence, probabilities }`. `choice` is one of the supplied options; `probabilities` is the full distribution over the options; `confidence` summarizes distribution concentration. Never returns a value outside the supplied options.
- **Score**: answer = `{ type: "score", score, legend, confidence, probabilities }`. `score` is a probability-weighted position on the level-number line (0..top-level, can be fractional); `probabilities` is the distribution over levels. Normalization to 0..1: divide by `len(criteria) - 1` (docs show exactly this).
- **Noul**: answer = `{ type: "noul", noul }`. `noul` is the probability of yes, 0..1. **No separate `confidence` field.** Near 0.5 means the yes/no probabilities are close, not medium intensity.
- **Batching**: any number of questions can be sent over one state in one `systemOne` call; they are evaluated in parallel and one answer does not inform another. Adding questions "barely changes the response time" and costs only question tokens (docs; parallel-questions cookbook: ~10x faster than per-question calls). Request budget ~32k tokens shared by state + questions. Question IDs are for code only and are not sent to the model; the full question must live in `instructions`. State fields are referenced from instructions with backticked paths (e.g. `` `units[0].files` ``).

## 3. Mapping implemented in jev-router

Pass A (per unit, prefixed IDs `u<idx>:<name>`):

- `should_surface` (Noul) -> `shouldSurface` boolean, `noul >= 0.5`; the noul probability is carried as the question's own confidence contribution (SPEC 8.2: "Noul probability -> boolean plus its probability as confidence").
- `semantic_category` (Choice over the 11 `SemanticEventKind`s) -> `semanticCategory`; its `probabilities` become `AttentionDecision.probabilities` (filtered to known kinds); its `confidence` becomes `JevResult.confidence` (distribution concentration, per SPEC 8.2).
- `importance`, `relevance`, `interruption`, `mental_model_change` (Score, 5 concrete levels each) -> 0..1 via `score / (levels - 1)`, clamped.
- `scope`, `human_decision` (Choice) -> enum values; unknown values raise `AnswerMappingError` (schema failure -> one retry -> deterministic defaults, SPEC 3.3).
- `needs_system2` (Noul) -> boolean >= 0.5.

Pass B (single unit):

- `representation` (Choice over 9) -> `UIIntent.representation` + `probabilities`/`confidence` for `JevResult`.
- `attention` (Choice over background/surface/highlight/interrupt), `density` (Choice over 4).
- `show_evidence`, `show_code` (Noul) -> booleans.
- `secondary_views`: one Noul per catalog component (11 total, speculative fan-out), `noul >= 0.5` sorted descending, capped at 3.
- `subject` is derived deterministically from the Pass A category (`subjectFromCategory`), not asked.

Prompt policy: the Jevcode catalog, triad definitions, mental-model-delta definition, and PRD section 34 examples are embedded verbatim as `state.system_policy` (TypeSafe has no system-prompt field; state is the context channel).

Input state per unit (SPEC 8.2): title, intent, category hint, file set (<= 40), symbol names (<= 60), diff stats, formatting/lockfile flags, destructive commands, security/schema paths, public exports, behavior/interfaces hints, dependency deltas, test outcomes, decision presence, task prompt truncated to 4096 chars.

## 4. Latency

No live call could be made: no `TYPESAFE_API_KEY` is available in this environment, and no key may be committed. Latency notes are therefore skipped; SPEC 13 SLOs (Pass A batch <= 3s p95, Pass B <= 2s p95) remain unmeasured until a keyed environment runs the eval suite.

## 5. Verification status

- **Doc-verified**: package name, install, auth/env vars, client + builder APIs, request/response shapes, Score normalization, Noul-without-confidence, batching semantics, and retry/timeout config — all read directly from the live docs listed above and cross-checked against the installed SDK's TypeScript declarations (`@typesafe-ai/sdk@0.6.0`).
- **Run-verified (offline)**: question composition, answer->JevResult mapping, Score/Choice/Noul handling, batched request assembly, retry-once-then-deterministic-defaults, health/selection, and the full guardrail + policy pipeline — exercised by 13 unit tests against an injected fake transport (`TypeSafeTransport`); no real network calls in the test suite. The real `SdkTransport` (thin wrapper over the SDK) is construction-verified by typecheck only.

## 6. Notes for consolidation

- `packages/contracts` `JevClientKind` is `"openrouter" | "degrade" | "playback"` — it predates the TypeSafe decision (SPEC 3.3). jev-router emits `"openrouter"` for the live client (`TYPESAFE_CLIENT_KIND`); a later contracts change should add a `"typesafe"` kind and jev-router will follow.
- jev-router keeps a local copy of the destructive-command pattern list (`src/patterns.ts`); the evidence-engine package is being built concurrently with its own classifier (T3-7). Consolidate to one list when both tracks land.
- Model-context redaction (SPEC 12.4) runs upstream of jev-router (pipeline/desktop main); `TypeSafeClient` sends whatever state it is given.

## Live verification (2026-09-19)

- Real API key via `JEV_API_KEY` in repo `.env` (client accepts `JEV_API_KEY` with `TYPESAFE_API_KEY` fallback).
- Available models: `jev-latest` (default), `jev-preview`. Both measured on the eval suite; performance equivalent.
- Live evals (`pnpm --filter jevcode-evals evals --client typesafe`):
  - should_surface precision 1.0, recall 1.0 (targets 0.9/0.85) — PASS
  - representation set-accuracy 0.688–0.750 (target 0.75) — borderline
  - score MAE ~0.17 after deterministic guardrail additions (target 0.15) — near-miss
- Calibration findings fixed with deterministic guardrails (SPEC §8.3 5a/6a): batched calls over-rate `lockfile_only`/`formatting_only` units and under-rate pending-decision units; single-unit calls score correctly. Remaining gap is model/label calibration, tracked by the eval suite.
- Scores return continuous values between integer levels; `score/(levelCount-1)` mapping confirmed correct.
