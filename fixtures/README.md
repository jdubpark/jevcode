# Jevcode Replay Fixtures

Five replay scenarios for the MVP pipeline (SPEC v1 section 15). Each scenario folder is
self-contained and feeds the pipeline integration tests, Jev evals, and compiler snapshot
tests.

## Scenario folders

| Scenario | What happens | Guardrail cases exercised (SPEC 8.3) |
|---|---|---|
| `oauth/` | Google OAuth login + identity layer, identities migration, one required account-linking decision, one failing test | Security path floor (2), schema surface floor (3), decision interrupt floor (6), relevant-now floor for failed unit (7), formatting-only hunk and lockfile hunk suppressed (5) |
| `rate-limit/` | Redis dependency + rate-limiter middleware, fail-open decision, all-green validation matrix | Decision interrupt floor (6), conservative render path (confidence 0.89, SPEC 8.4) |
| `schema-change/` | users migration: add `full_name`/`last_login_at`, drop `password_hash`, with the query layer updated separately | Schema surface floor (3) |
| `api-break/` | GET /users/:id changes 404 -> 200 + `{ user: null }`, and the old test goes stale | API public-export surface floor (4) |
| `dep-change/` | axios removed, zod added, `fetchJson` rewritten on fetch + zod, with formatting-only change and lockfile change suppressed | Suppress floor for formatting-only diffs and lockfile-only changes (5) |

## ChangeUnit clustering (SPEC 6.1)

Each scenario's `events.jsonl` facts cluster into connected components: files join a unit
via shared git-hunk batches, import/export edges, or shared 500ms batches. Files with no
connectivity edge split into separate ChangeUnits. The expected units per scenario are:

| Scenario | Units |
|---|---|
| `oauth/` | `oauth-identity-layer` (identity/google/service/server security layer), `oauth-migration` (identities table), `oauth-dependency` (google-auth-library), `oauth-lockfile-noise` (suppressed), `oauth-account-linking-decision`, `oauth-linking-test-failure`, `oauth-format-noise` (suppressed) |
| `rate-limit/` | `rate-limit-architecture` (redis client + rate-limiter middleware), `rate-limit-impl` (server app wiring), `rate-limit-dependency` (ioredis), `rate-limit-fail-open-decision`, `rate-limit-validation` |
| `schema-change/` | `schema-users-migration` (schema.ts + migration), `schema-queries-impl` (queries.ts) |
| `api-break/` | `api-users-404-behavior`, `api-users-404-stale-test` |
| `dep-change/` | `dep-zod-add` (package.json), `dep-zod-impl` (http.ts + app.ts), `dep-zod-lockfile` (suppressed), `dep-format-noise` (suppressed) |

## Folder layout

```
fixtures/<scenario>/
├── repo/                  Seed repository state BEFORE the session (evidence-engine base parse)
├── changes/               Repository state AFTER the session (collectors confirm the same facts)
├── events.jsonl           Ordered event stream: NormalizedAgentEvent, EvidenceFact,
│                          SemanticEvent, and Decision records, one JSON per line
├── labels/
│   ├── attention.json     Per-unit gold AttentionDecision (Pass A). Key = unit slug
│   └── projection.json    Per-surfaced-unit gold UIIntent (Pass B). Key = unit slug
├── golden_specs/<slug>.json  Expected json-render flat spec ({ root, elements }) from the
│                          UI compiler, one per surfaced unit
└── expected_units.json    Expected deterministic ChangeUnit clustering: array of
                           { id, title, category, files, symbolNames }
```

## Replay contract

`events.jsonl` is the source of truth. The replay runner feeds it through the real
pipeline with Jev in `PlaybackMode` (returns the labeled outputs) or `DegradeMode`
(heuristic path). `repo/` and `changes/` let collectors recompute the same evidence facts,
so pipeline tests can assert that observed evidence matches the stream. Every record in
`events.jsonl` validates against one of the `@jevcode/contracts` zod schemas.

## Labels

`labels/attention.json` maps each unit slug to the expected `AttentionDecision`. It is the
gold answer for Jev Pass A evals. A unit with `shouldSurface: false` (see
`dep-format-noise`, `dep-zod-lockfile`, and `oauth-lockfile-noise`) has NO projection
entry and NO golden spec: Pass B never runs for suppressed units.

`labels/projection.json` maps each surfaced unit slug to the expected `UIIntent`. It is
the gold answer for Jev Pass B evals. The representation follows the SPEC 9.2 mapping:

| Semantic category | Representation | Root component |
|---|---|---|
| schema_change | table | SchemaDelta |
| architecture_change / security_change | diagram | ArchitectureDelta |
| dependency_change | graph | DependencyDelta |
| decision_candidate | decision | Decision |
| behavior_change / api_change | before_after | BehaviorDelta |
| failure | failure | FailureAnalysis |
| test_result | table | TestMatrix |
| implementation_change | summary | ChangeOverview |

Render mode follows the SPEC 8.4 confidence policy: confidence >= 0.90 autonomous,
>= 0.70 conservative, >= 0.50 generic, else suppressed.

Numeric triads follow the PRD examples: dependency change 0.72/0.81/0.08 (PRD 34),
behavior change 0.90/0.94/0.64 (PRD 34), schema migration 0.96/0.91/0.18 (PRD 17),
formatting noise 0.02/0.01/0.00 with `shouldSurface: false` (PRD 34). Implementation-only
split units carry modest scores (summary surfaces with `ChangeOverview`).

## Golden specs

One json-render flat spec per surfaced unit: `{ "root": "<id>", "elements": { "<id>":
{ "type": "<ComponentName>", "props": {...}, "children": [...] } } }`.

- Component `type` values come only from the SPEC 9.2 catalog (the 11 components).
- Actions appear in props as `"actions": [{ "action": "<ActionName>", "params": {...} }]`
  using only the SPEC 9.2 action allowlist
  (`answer_decision`, `delegate_decision`, `restore_previous_api_semantics`,
  `inspect_call_sites`, `show_exact_diff`, `accept_changes`, `request_changes`,
  `continue_task`, `open_terminal`, `interrupt_agent`, `pin_surface`, `dismiss_surface`).
- The `root` id must exist in `elements`. Every child id must exist. Every element must be
  reachable from the root (no orphans).
- A golden spec covers only its unit's composition: the compiler drops secondary views and children whose
  evidence moved to another unit (e.g., the oauth schema/dependency children, or the
  rate-limit dependency child) from the shrunken unit's spec and puts them on the
  split-off unit instead.

## Expected units

`expected_units.json` is the gold answer for deterministic ChangeUnit clustering (SPEC 6):
the connected components the semantic engine should produce from the scenario facts.
`category` is a valid `ChangeCategory`. `files` and `symbolNames` are drawn from the facts
in `events.jsonl`.

## Validation

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
A file the policy withholds would carry `withheld: "secret_path"` and no `text`; no
fixture has one. `added`/`removed` equal that diff's `+`/`-` lines. Each decision row
carries `ts`, the source time of its status: the open row takes the time of the record
before it, and the answered row the time of the user's decision message. oauth has one
`agent_reasoning` line before the final "all checks pass" claim. All of these fields are
optional in the contracts; streams without them still validate.

After editing `repo/`, `changes/` or a stream, rebuild
(`pnpm --filter "jevcode-desktop^..." build && pnpm --filter jevcode-desktop build`), run
`node scripts/fixture-diffs.mjs` (idempotent), then `node scripts/validate-fixtures.mjs`.
