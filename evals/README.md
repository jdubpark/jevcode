# jevcode-evals

Evaluation runner for the Jev passes (SPEC 16) and deterministic guardrail checks
(SPEC 8.3), executed against the labeled replay fixtures in `../fixtures`.

The runner loads each scenario's `events.jsonl`, reconstructs the deterministic
`AttentionInput` per labeled unit from `expected_units.json` plus the evidence
facts, runs the deterministic stack from `@jevcode/jev-router`
(guardrails + degrade router + render policy, or a label-playback client), and
scores the results against `labels/attention.json` and `labels/projection.json`.

## Prerequisites

The runner imports the built package dists, not their sources:

```sh
pnpm --filter @jevcode/contracts build
pnpm --filter @jevcode/jev-router build
```

`jevcode-evals` sits outside the pnpm workspace (it cannot be added to
`pnpm-workspace.yaml` yet), so it has no node_modules of its own. It resolves
`@jevcode/jev-router` and `@jevcode/contracts` through relative imports of their
`dist` entrypoints and uses the repo root toolchain (TypeScript, vitest) via
`../node_modules/.bin`.

## Running

From `evals/`:

```sh
npm run typecheck   # tsc
npm run test        # vitest
npm run build       # compile src -> dist
npm run evals       # build + run the runner (degrade client, human table)

node dist/cli.js --client degrade    # heuristic degrade router (default)
node dist/cli.js --client playback   # labels returned verbatim (wiring proof)
node dist/cli.js --json report.json  # write the machine-readable report
node dist/cli.js --fixtures ../fixtures --no-table
```

Exit codes: `0` means all targets and guardrail checks pass. `1` means a target was missed.
`2` means a usage or loading error. `npm run evals` currently exits `1` in degrade mode:
see "Degrade router misses" below.

## Modes

- **degrade** runs the real deterministic stack: `preClampAttention` ->
  `DegradeClient.attention` (`clampAttention`) -> `DegradeClient.project`
  (`clampProjection` + `renderPolicy`). This is the no-model path shipped in
  the product. Scores against it are honest heuristic quality, not model
  quality.
- **playback** runs `PlaybackClient` (in `src/playback.ts`), a `JevClient` that
  returns each labeled `AttentionDecision` / `UIIntent` verbatim. If the runner
  wiring is correct, every target passes in playback mode (precision 1.0,
  recall 1.0, MAE 0, set-accuracy 1.0). A playback failure means the runner
  loads or aligns inputs/labels incorrectly, not that the model is bad. The
  integration track reuses `PlaybackClient` for pipeline development.

## Targets (SPEC 16)

| Metric | Target | Meaning |
|---|---|---|
| `should_surface` precision | >= 0.9 | Of units predicted to surface, how many were labeled to surface. |
| `should_surface` recall | >= 0.85 | Of units labeled to surface, how many were predicted to surface. |
| score MAE (overall) | <= 0.15 | Mean absolute error over importance, relevance, interruption, and mental_model_change across all labeled units. |
| representation set-accuracy | >= 0.75 | Fraction of surfaced units whose predicted representation matches the labeled representation or an acceptable alternative. |

Category accuracy is reported as informational data (SPEC 16 defines no
category target).

## Acceptable alternatives

`config/alternatives.json` implements the PRD 46 "capture both correctness and
acceptable alternatives" requirement. The canonical representation is the
labeled one. The config adds alternatives per semantic category:

```json
{
  "api_change": ["summary", "diff"],
  "architecture_change": ["summary"],
  "security_change": ["summary"]
}
```

For example, a `security_change` unit labeled `diagram` is still scored as a
hit if the client projects `summary` (a plain ChangeOverview is an acceptable
way to show a security change), and an `api_change` labeled `before_after`
accepts `summary` or `diff`.

## Input reconstruction

`expected_units.json` supplies each labeled unit's id, title, category hint,
files, and symbols. The runner derives `AttentionInput.hints` from the fact
stream with the same rules as the pipeline (`jev-router` `state.ts`): hunks in
the unit's files drive `diffStats`/`formattingOnly`/`lockfileOnly`, security
and schema paths come from the pattern sets, `publicExports` from
export/import symbol deltas, `interfacesChanged` from interface/export symbol
deltas, `testResults` from all `test_result` facts, `status: "failed"` when a
failing test file is in the unit's file set, and `decisionIds` from decisions
whose `affectedChangeUnits` list the unit or whose evidence references a
semantic event with the same file set as the unit.

Guardrail checks (`src/guardrail-checks.ts`) assert the deterministic clamp
paths directly, not only router outputs: formatting-only suppression
(`dep-format-noise`), the security surface floor (`oauth-identity-layer`), the
schema surface floor (`schema-users-migration`), and a synthetic destructive
command (required decision + interruption >= 0.9).

## Degrade router misses

The degrade router is a heuristic. The misses below are real calibration data for
the live model, not runner bugs (check them against a run's per-unit table):

- `decision_candidate` is only reachable via destructive commands, so
  non-destructive decision units (oauth account linking, rate-limit fail-open)
  get other categories. The oauth decision also has no stream link
  (`affectedChangeUnits` and decision evidence are unlinked in the fixture).
- The oauth failing-test unit matches the `/oauth/i` security path pattern, so
  it routes as `security_change` instead of `failure`.
- `status: "failed"` units get their relevance pinned to the 0.5 floor by
  `clampAttention`, below the labeled values (api-break units, oauth test
  failure).
- Interruption stays at 0.1 for units without decision links, undercutting
  the api-break behavior-change label (0.64, `humanDecision: "recommended"`).
- Projection misses follow the category misses: 5/10 representation hits with
  the degrade router (target 0.75).

## Known gap

`jest`/`vitest`-style CI wiring for evals is not possible until `evals/` joins
the pnpm workspace (`pnpm-workspace.yaml` is owned by the repo root). The
scripts in `evals/package.json` work standalone from `evals/`.
