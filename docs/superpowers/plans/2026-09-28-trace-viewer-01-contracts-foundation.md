# Trace Viewer W0: Contracts Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land every W0 shared contract (browser-safe `@jevcode/contracts` barrel, `@jevcode/contracts/node`, `canonicalJson`, the optional capture fields, `trace.ts`), the new `@jevcode/trace-viewer` package with its model types and `TraceSource`, the Vite dev host skeleton, the ESLint boundaries and every new npm dependency, leaving every existing check green.

**Architecture:** Six sequential tasks (W0-1 … W0-6) on one branch, `tv/w0-contracts-foundation`, in the worktree `/Users/jwpark/Projects/jevcode-tv-w0`. The contracts barrel loses its only `node:` import (`symbolId` moves to `@jevcode/contracts/node`), and three guards pin that: a graph-walk test, ESLint import bans and a Vite plugin that fails the dev-host build on any Node built-in. Every new contract field is an optional addition, so rows written before this lane still parse. The trace-viewer package ships only types, stable-id helpers and the `TraceSource` port in W0; the fold (lane B), the read path (lane A2) and capture (lane A1) build on these names after W0 merges.

**Tech Stack:** TypeScript 5.9 (NodeNext, strict, `verbatimModuleSyntax`), zod 3.25.76 (zod 4 stays inside `@jevcode/ui-catalog`), pnpm 9.15.0 workspaces, vitest 3.2.7, fast-check 4.10.1, ESLint 9.39.5 flat config with typescript-eslint 8.70, Vite 5.4.21 with `@vitejs/plugin-react` 4.7.0, React 19.2.3, Node 22.

**Spec:** `docs/superpowers/specs/2026-09-28-trace-viewer-design.md` (sections "User decisions" D1–D12, "Accepted recommendations (data)" R1–R6, "(model)" R7–R12, "(UI)" R13–R29 (W0 carries R17's and R27's dependencies and R25's model fields), "Out of v1"), plus the lane index `docs/superpowers/plans/2026-09-28-trace-viewer-interfaces.md` (section 2.1–2.3 interfaces, section 3 W0 task table, section 5 gotchas). The UI index `docs/superpowers/plans/2026-09-28-trace-viewer-interfaces-ui.md` §1.1 and §1.2 list what the UI lanes need from W0 (the d3 fallback dependencies, the `./sources` and ui-catalog `./components/*` exports, `assetsInlineLimit: 0`, the `src/layout` ESLint block, the virtual-core option check, the model additions and the session-bound `TraceSource`); the lane index has absorbed them, so this file needs no second source. On any conflict the binding decision record wins, then the spec, then the index, then this file.

## Interface deviations

This file follows the index's names, types and file ownership. Five deliberate differences, each verified by replaying all six tasks on a clone of `main` at `144c7fb`:

1. **`StableIdSchema` gains the `s` (dotAll) flag** (`packages/trace-viewer/src/model/types.ts`, W0-6). The index regex `/^(?:step:[1-9]\d*|(?:unit|decision|file|finding):.+)$/` rejects any key that holds a line terminator, so `parseStableId(fileStableId("docs/odd\nname.md"))` returns `null`. POSIX file names may contain `\n`. fast-check found the counterexample `["unit", "\n"]`. The fix is `/…:.+)$/s`. No name or type changes.
2. **ESLint also bans Node globals in `packages/trace-viewer/src`** (`NO_NODE_GLOBALS`: `process`, `Buffer`, `require`, `global`, `__dirname`, `__filename`, `setImmediate`, `clearImmediate`), added to all three trace-viewer blocks in W0-1, with one extra `lint-boundaries.test.ts` case. The trace-viewer `tsconfig.json` has `"types": ["node"]` (tests need it), so `Buffer.byteLength(…)` in `src/model` would typecheck, lint clean and pass the Vite import guard, then throw in the Electron trace window. The change is additive: nothing in the index is renamed or removed.
3. **SPEC §18 wording** (W0-1). The index's sentence ends "(R8 sign-off, D9)". In the design record, R8 is the fold API. The sign-off meant here is risk R8 in `docs/IMPLEMENTATION-PLAN.md:180`, so this plan writes "plan-owner sign-off under IMPLEMENTATION-PLAN risk R8; design decision D9". It also drops the stray comma ("Plus team features and Windows/Linux packaging"). The change is to documentation only.
4. **Corrections to index section 5 gotchas** (setup and root checks; other lanes should adopt them):
   - After `pnpm install --frozen-lockfile` in a fresh worktree, `pnpm --filter jevcode-desktop rebuild:node` fails at the node-pty copy (`cp: …/node-pty/build/Release/pty.node: No such file or directory`). The directory does not exist because no native build ran. When that directory is missing, the agent-codex PTY tests fail with `posix_spawnp failed`, because `spawn-helper` is not beside `pty.node`. The setup recipe below creates the directory and copies `spawn-helper`.
   - Three pre-existing timing-sensitive suites flake under load: evidence-engine `src/collectors/file-watcher.test.ts`, agent-codex `src/stall-watchdog.test.ts` and `src/codex-adapter.test.ts`. They flake at base `144c7fb` too, and `stall-watchdog.test.ts` failed once in a replay of this plan even with one package at a time. This plan's root test command is `pnpm -r --no-bail --workspace-concurrency=1 test` (about 21 s). It runs one package at a time, which lowers load, and it does not stop at the first failure, so a flake cannot hide later packages' results. Gotcha 3 says how to confirm a flake.
5. **`@jevcode/trace-viewer` does not depend on `@xyflow/react`** (W0-1). An earlier index draft listed `"@xyflow/react": "12.11.6"`, but the binding decision R17 says "packages/trace-viewer takes NO @xyflow/react dependency" (hand-rolled DOM viewport; d3-zoom 3.0.0, already locked, is the fallback). `@xyflow/react@12.11.6` stays in the lockfile through `@jevcode/ui-catalog`, so the lockfile pin check below still lists it. Without `@xyflow/react` and with the four d3 entries of UI index §1.1(a), the lockfile diff is `134	0`. Index section 2.2 now matches.

## Lane prerequisites

- **Wave:** W0 runs first and alone. No other lane has to merge before it.
- **Base:** `main` at `144c7fb`, or a later commit on `main` that adds only `docs/superpowers/**`. Verify from `/Users/jwpark/Projects/jevcode`:
  - `git -C /Users/jwpark/Projects/jevcode diff --stat 144c7fb main -- . ':(exclude)docs/superpowers'` prints nothing.
  - `git -C /Users/jwpark/Projects/jevcode ls-tree -d main packages/trace-viewer apps/trace-viewer-dev` prints nothing (W0 has not landed).
- **Plan documents:** If `git -C /Users/jwpark/Projects/jevcode ls-files docs/superpowers/plans docs/superpowers/specs` prints nothing, the plan files are untracked in the main checkout. Read them by absolute path (`/Users/jwpark/Projects/jevcode/docs/superpowers/...`) and never commit them from this lane. W0-1 adds a SPEC link to the design spec. Report in the lane hand-off that `docs/superpowers/specs/2026-09-28-trace-viewer-design.md` must be on `main` before this branch merges.
- **Tooling:** `node --version` prints `v22.x` (verified on `v22.23.1`). `pnpm --version` prints `9.15.0`. W0-1 needs network access, because `pnpm install` downloads three new tarballs.
- **Worktree** (run once, from anywhere):

```bash
git -C /Users/jwpark/Projects/jevcode worktree add -b tv/w0-contracts-foundation /Users/jwpark/Projects/jevcode-tv-w0 main
```

- **Setup** (run once in the new worktree; every later command in this file runs from `/Users/jwpark/Projects/jevcode-tv-w0`). If your shell does not keep the working directory between calls, prefix each command with `cd /Users/jwpark/Projects/jevcode-tv-w0 && `.

```bash
pnpm install --frozen-lockfile
NP=$(ls -d node_modules/.pnpm/node-pty@*/node_modules/node-pty | head -1) && mkdir -p "$NP/build/Release" && pnpm --filter jevcode-desktop rebuild:node && cp "$NP/prebuilds/$(node -p 'process.platform + "-" + process.arch')/spawn-helper" "$NP/build/Release/spawn-helper" && chmod +x "$NP/build/Release/spawn-helper"
pnpm -r build
```

Expected: the second command prints `better-sqlite3 loads under node ok`, `node-pty loads under node ok` and `native modules restored to node ABI`. `pnpm -r build` exits 0.

- **Baseline** (must all pass before W0-1; these are the numbers at `144c7fb`):
  - `pnpm -r typecheck`: exits 0.
  - `pnpm -r --no-bail --workspace-concurrency=1 test`: exits 0. The `Tests` lines read 106 (contracts), 68 (agent-core), 169 (evidence-engine), 77 (semantic-core), 49 (storage), 22 (telemetry), 89 (ui-catalog), 108 (ui-compiler), 44 (agent-codex), 213 (jev-router), 119 (desktop), 39 (evals). The first full run in a fresh worktree (cold caches) is the likeliest to hit a known flake: in two replays, `stall-watchdog.test.ts` failed on that first run and passed on every later one. Apply Gotcha 3 and rerun the command until it exits 0 before you start W0-1.
  - `pnpm lint`: exits 0 and prints nothing after `> pnpm exec eslint .`.
  - `node scripts/validate-fixtures.mjs`: the last two lines are `Checks: 149, passed: 149, failed: 0` and `VALIDATION PASSED`.

## Global Constraints

Copied from the binding decision record (verbatim where quoted) plus the orchestration rules. Every task's requirements include this section.

- R6: "contracts browser safety: newId uses globalThis.crypto.randomUUID() (Node >= 22); symbolId moves to @jevcode/contracts/node (callers evidence-engine/src/symbol-diff.ts:14, semantic-core/src/clustering.ts:136) with a re-export shim only where needed." This plan needs no shim: the three callers import from `@jevcode/contracts/node` directly.
- R2: "Every new field OPTIONAL (rebuildSession re-parses stored rows and throws on failure, db.ts:191-197)." Never add `.strict()`, and never make a new field required.
- R2: "optional turnId on every agent event …; optional callId = `${turnId}:${item.id}` on command_started/_completed, tool_started/_completed, file_changed, approval_requested; new agent_reasoning {text, callId?} …; new agent_interrupted (D10); sourceCallId on command_executed and test_result facts". "exitCode stays `?? -1` in storage; the viewer renders -1 as "unknown", never failed." (W0 keeps `exitCode: z.number().int()`.)
- D10: "New event agent_interrupted {reason: interrupt|steer|stop} replaces the exit-time agent_failed". W0 adds only the variant; A1 emits it.
- R3: "git_hunk.diff {hash (16 hex), bytes, text?, truncated, redactions, withheld?: "secret_path"|"not_captured"}"; "factContentId hashes canonicalJson(record) from new packages/contracts/src/canonical-json.ts"; "ChangeUnit.agentCallIds".
- R4: "Decision.ts optional; JevDecisionLog.pass "A"|"B" optional".
- R5: "packages/contracts/src/trace.ts: EVENT_TYPES (moved from storage/src/db.ts:53-68, re-exported), TRACE_ROW_TYPES = agent_event, evidence_fact, change_unit, decision, validation, jev_decision; TraceRowSchema {seq, type, ts, payload, clipped?, factId?}; TraceSessionSummarySchema; TraceRowsPageSchema {rows, nextAfterSeq, lastSeq, state}; TraceBundleSchema {format "jevcode.trace", version 1, exportedAt, redactionCount, session, rows}." IPC bounds "trace:listSessions {repoId?, limit<=500}, trace:rows {sessionId, afterSeq?, limit<=5000}, trace:payloads {sessionId, seqs 1-50}"; "clips strings > 16 KiB to head+tail with clipped=true"; "Live follow = poll trace:rows {afterSeq} every 1 s"; "NO SQL migration in v1." (`LATEST_SCHEMA_VERSION` stays unchanged.)
- R7: "One package packages/trace-viewer: src/model (React-free; ESLint bans react, node:*, electron, @jevcode/{storage,semantic-core,evidence-engine,jev-router,agent-*}; exported as "@jevcode/trace-viewer/model") and src/ui. Model hashes nothing."
- R8: "TraceSession {schemaVersion 1, meta, loadedThroughSeq, turns, steps, chapters, entities (files only in v1), findings, gaps, coverage, hidden}".
- R9: "Stable ids: step:<firstSeq>, unit:<changeUnitId>, decision:<decisionId>, file:<path>, finding:<ruleId>@<version>:<anchorSeq>." Everything after the first colon is an opaque key.
- R14: Hybrid "lanes Supervisor, Agent, Commands, Edits, Tests, Jev".
- R17: "packages/trace-viewer takes NO @xyflow/react dependency." "Fallback d3-zoom 3.0.0 (already locked) behind the same math interface." "Spine and Outline virtualized with @tanstack/react-virtual ^3.14.13 (verify followOnAppend/anchorTo exist in the resolved virtual-core; else hand-roll anchoring)." W0-1 adds the dependencies and runs the check.
- R19: "layout (pure, React- and DOM-free …)"; "layout imports model, never the reverse." W0-1 adds the ESLint block that enforces it; the UI lanes create `src/layout`.
- R20: "level (shared: session|chapter|step)". W0-6 exports it as `LEVELS`/`Level`.
- R25: "Model fields REQUIRED by the UI (add to W0 model types and lane B)". W0-6 declares them; lane B derives them.
- R15: "CSS Modules + light --tv-* tokens; scoped (the trace window never loads apps/desktop/src/renderer/styles.css). Local fonts only (system stack). CSP-compatible." The dev host's build output carries the Electron CSP `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'`.
- D2: "Keep the model's input (TraceRow) source-agnostic." D4: "one shared package, two hosts. Develop in a standalone Vite dev host on exported bundles; mount in Electron."
- D9: "Approving §1 = R8 sign-off to remove "replay UI" from the SPEC §18 deferred list (docs/SPEC.md:653) in M1's PR." W0 carries the M1 contract changes, so it is M1's first PR.
- zod 3 only (`^3.24.1`, locked `3.25.76`) in `@jevcode/contracts` and `@jevcode/trace-viewer`.
- Every new npm dependency and every `pnpm-lock.yaml` change happens in W0-1. No other task edits a `package.json` dependency block or the lockfile. (W0-2 adds only an `exports` entry.)
- Commits: one conventional commit per task that lists its files explicitly in `git add`. Never add a `Claude-Session:` trailer. Use the repository's configured git identity.
- Never run `git stash`, because the stash stack is shared by all worktrees. To set work aside, make a WIP commit. The shell is zsh: write `${var}:suffix`, never `"$var:suffix"`.

## Review Focus

These are the five inputs that most need a guard in this lane. Each one has a test in the task that owns the code.

1. **A new optional field declared on only some variants.** zod silently strips undeclared keys in `rebuildSession`, in IPC parsing and in `validate-fixtures.mjs`, so `turnId`, `callId`, `sourceCallId`, `diff`, `agentCallIds`, `Decision.ts` or `pass` would vanish with no error. Expected: every declared carrier keeps the field through `parse`. Tests: **W0-4**, "keeps turnId on every variant and callId on the six call variants", "keeps git_hunk.diff through a parse", "keeps sourceCallId on test_result and command_executed", "keeps agentCallIds through a parse", "keeps the optional status-transition ts" and "keeps the optional Jev pass".
2. **A Node built-in reached from browser code**: today `id.ts -> node:crypto` through the barrel; later a viewer file importing `node:*` or using `Buffer`. The Electron trace window and the dev host have no Node. Expected: `browser-safety.test.ts` lists the edge, the dev-host `vite build` fails and names the specifier, and ESLint reports the import or global. Tests: **W0-2**, "imports no Node built-in at runtime" plus the dev-host build step and the two contracts lint cases; **W0-1**, the `Buffer.byteLength` lint case.
3. **One fact in collector key order (`ts` last) and in zod order (`ts` fourth).** Expected: `canonicalJson` returns one string for both, so A1-5's canonical fact ids match stored rows (0/64 matched before). Test: **W0-3**, "gives a collector-ordered fact and its zod-parsed copy one string (R3)", plus the key-order property.
4. **Stable-id keys with colons, hyphens or line breaks**: `src/a:b.ts`, `dec-oauth-0001`, a POSIX file name holding `\n`. Expected: `parseStableId(fileStableId(p))` is `{ kind: "file", key: p }` for every non-empty `p`. Tests: **W0-6**, "round-trips a path with a line break" and the binary-string property "round-trips any non-empty key".
5. **A live tail whose newest rows are types the source filters out** (telemetry after the last agent row) while the writer keeps appending. Expected: `cursorAfter` jumps to `lastSeq`, the next poll returns only the new rows, and nothing is read twice or stalls. Test: **W0-6**, "drives a reader that sees every served seq exactly once, then only new rows".

## Gotchas (lane copy of index section 5, corrected)

1. **Rebuild after editing a dependency.** Every workspace package exports only `./dist`, and every `vitest.config.ts` is a plain `include` list with no source aliases. After changing `packages/contracts`, run `pnpm --filter @jevcode/contracts build` before testing or typechecking any other package. `pnpm --filter "...@jevcode/contracts" build` rebuilds contracts and every package that depends on it. Build `@jevcode/trace-viewer` before typechecking or building `jevcode-trace-viewer-dev`; otherwise you get `TS2305: Module '"@jevcode/trace-viewer/model"' has no exported member …`.
2. **Native modules.** If a storage or desktop test fails with `NODE_MODULE_VERSION`, `was compiled against a different Node.js version` or `Could not locate the bindings file`, rerun the second setup command. If an agent-codex test fails with `posix_spawnp failed`, rerun it too (it installs `spawn-helper`).
3. **Root checks** (the last step of every task, in this order; each must exit 0): `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r --no-bail --workspace-concurrency=1 test`, `pnpm lint`. If the only test failures are in `file-watcher.test.ts`, `stall-watchdog.test.ts` or `codex-adapter.test.ts`, run that package alone (`pnpm --filter @jevcode/evidence-engine test` or `pnpm --filter @jevcode/agent-codex test`; retry once). It must pass alone. Then run `pnpm lint`, and name the flake in the task report. This lane never edits those suites. Any other failure is real: fix it before you commit.
4. **Targeted tests** use `pnpm --filter <package> exec vitest run <path relative to the package>`. Package names: `@jevcode/contracts`, `@jevcode/storage`, `@jevcode/evidence-engine`, `@jevcode/semantic-core`, `@jevcode/trace-viewer`, `jevcode-desktop`, `jevcode-trace-viewer-dev`, `jevcode-evals`.
5. **Fixture validation** reads `packages/contracts/dist`, so run it after a contracts build: `node scripts/validate-fixtures.mjs`.

## File map (this lane only)

| Task | Creates | Modifies |
|---|---|---|
| W0-1 | `packages/trace-viewer/{package.json, tsconfig.json, tsconfig.build.json, vitest.config.ts, scripts/copy-assets.mjs, src/css-modules.d.ts, src/index.ts, src/model/index.ts, src/lint-boundaries.test.ts}`; `apps/trace-viewer-dev/{package.json, tsconfig.json, vite.config.ts, index.html, src/main.tsx}` | `apps/desktop/package.json`, `packages/contracts/package.json`, `packages/ui-catalog/package.json`, `eslint.config.mjs`, `pnpm-lock.yaml`, `docs/SPEC.md` |
| W0-2 | `packages/contracts/src/{node.ts, node.test.ts, browser-safety.test.ts}` | `packages/contracts/{package.json, src/id.ts, src/id.test.ts}`, `packages/evidence-engine/src/{symbol-diff.ts, symbol-diff.test.ts}`, `packages/semantic-core/src/clustering.ts`, `eslint.config.mjs`, `packages/trace-viewer/src/lint-boundaries.test.ts`, `apps/trace-viewer-dev/src/main.tsx` |
| W0-3 | `packages/contracts/src/{canonical-json.ts, canonical-json.test.ts}` | `packages/contracts/src/index.ts` |
| W0-4 | none | `packages/contracts/src/{agent-events.ts, agent-events.test.ts, evidence.ts, evidence.test.ts, semantic.ts, semantic.test.ts, jev.ts, jev.test.ts}`, `apps/desktop/src/renderer/components/WorkspaceHost.tsx`, `docs/SPEC.md` |
| W0-5 | `packages/contracts/src/{trace.ts, trace.test.ts}` | `packages/contracts/src/index.ts`, `packages/storage/src/{db.ts, db.test.ts}`, `docs/SPEC.md` |
| W0-6 | `packages/trace-viewer/src/{source.ts, source.test.ts, model/types.ts, model/types.test.ts}` | `packages/trace-viewer/src/{index.ts, model/index.ts}`, `apps/trace-viewer-dev/src/main.tsx` |

---

### Task W0-1: Scaffold `@jevcode/trace-viewer` and the dev host; add every dependency; lint boundaries; SPEC §2.2 and §18

**Files:**
- Create: `packages/trace-viewer/package.json`, `packages/trace-viewer/tsconfig.json`, `packages/trace-viewer/tsconfig.build.json`, `packages/trace-viewer/vitest.config.ts`, `packages/trace-viewer/scripts/copy-assets.mjs`, `packages/trace-viewer/src/css-modules.d.ts`, `packages/trace-viewer/src/index.ts`, `packages/trace-viewer/src/model/index.ts`
- Create: `apps/trace-viewer-dev/package.json`, `apps/trace-viewer-dev/tsconfig.json`, `apps/trace-viewer-dev/vite.config.ts`, `apps/trace-viewer-dev/index.html`, `apps/trace-viewer-dev/src/main.tsx`
- Modify: `apps/desktop/package.json:24`, `packages/contracts/package.json:22-26`, `packages/ui-catalog/package.json:8-13`, `eslint.config.mjs:41-44` and `:76-80`, `pnpm-lock.yaml` (generated), `docs/SPEC.md:72`, `:83`, `:653`
- Test: `packages/trace-viewer/src/lint-boundaries.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks. It uses the existing root `eslint.config.mjs` (`nodeGlobals`, `browserGlobals`, `tseslint.config(...)`), `tsconfig.base.json` and the locked versions in `pnpm-lock.yaml`.
- Produces:
  - Package `@jevcode/trace-viewer` with `exports` `"."` → `./dist/index.js`, `"./model"` → `./dist/model/index.js` and `"./sources"` → `./dist/sources/index.js` (lane C1b creates `src/sources/index.ts` in C1-15). Scripts: `build` (`tsc -p tsconfig.build.json && node scripts/copy-assets.mjs`), `typecheck`, `test` (`vitest run --passWithNoTests`), `bench`. Both barrels are `export {};` until W0-6. UI tests opt into jsdom with a first-line `// @vitest-environment jsdom` comment.
  - `@jevcode/ui-catalog` gains the export `"./components/*"` → `./dist/components/*.js`, so `@jevcode/ui-catalog/components/CodeDiff` resolves.
  - App `jevcode-trace-viewer-dev`: scripts `dev`, `build`, `preview`, `typecheck`. Its `vite build` fails on any Node built-in in the browser graph with `browser bundle imports "<specifier>" from <importer>; the trace viewer must stay browser-safe`, injects the Electron CSP into `dist/index.html`, and inlines no asset (`assetsInlineLimit: 0`).
  - ESLint constants in `eslint.config.mjs`: `NODE_BUILTIN_REGEX`, `BROWSER_SAFE_PATTERNS`, `TRACE_VIEWER_PATHS`, `NO_NETWORK_GLOBALS`, `NO_NODE_GLOBALS`, `LAYOUT_PURE_GLOBALS`. Three config objects: one for `packages/trace-viewer/src/**/*.{ts,tsx}` (tests, benches and `src/test-support/**` excluded), one for `packages/trace-viewer/src/model/**/*.ts` (also bans importing `src/ui` and `src/layout`) and one for `packages/trace-viewer/src/layout/**/*.ts` (React, d3, `src/ui`, DOM, timer and clock globals banned; R19).
  - `lint-boundaries.test.ts` exports nothing. W0-2 appends cases of shape `{ filePath: string; code: string; expected: string[] }` to its `CASES` array.
  - Dependencies, per index section 2.2, with nothing else added: `packages/trace-viewer` deps `@jevcode/contracts workspace:*`, `@jevcode/ui-catalog workspace:^`, `@tanstack/react-virtual 3.14.13`, `d3-selection 3.0.0`, `d3-zoom 3.0.0`, `zod ^3.24.1` (no `@xyflow/react`: R17 says "packages/trace-viewer takes NO @xyflow/react dependency"; see Interface deviation 5; d3-zoom is R17's "Fallback d3-zoom 3.0.0 (already locked)"); peers `react`/`react-dom ^19.2.0`; devDeps `@jevcode/semantic-core workspace:^`, `@testing-library/dom ^10.4.2`, `@testing-library/react ^16.3.3`, `@testing-library/user-event 14.6.7`, `@types/d3-selection 3.0.12`, `@types/d3-zoom 3.0.8`, `@types/node ^22.13.0`, `@types/react ^19.3.0`, `@types/react-dom ^19.3.0`, `eslint 9.39.5`, `fast-check 4.10.1`, `jsdom 30.1.0`, `react 19.2.3`, `react-dom 19.2.3`, `typescript ^5.7.3`, `vitest ^3.0.5`. `apps/desktop` adds `@jevcode/trace-viewer workspace:^`. `packages/contracts` adds the devDependency `fast-check 4.10.1`.
  - A checked fact for the UI lanes: the resolved `@tanstack/virtual-core` is 3.17.11 and declares `anchorTo`, `followOnAppend` and `scrollEndThreshold` (R17: "verify followOnAppend/anchorTo exist in the resolved virtual-core").

- [ ] **Step 1: Create the trace-viewer package manifest and TypeScript configs**

Create `packages/trace-viewer/package.json` with this content:

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

Create `packages/trace-viewer/tsconfig.json` with this content:

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

Create `packages/trace-viewer/tsconfig.build.json` with this content:

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

Create `packages/trace-viewer/vitest.config.ts` with this content:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    benchmark: { include: ["src/**/*.bench.ts"] },
  },
});
```

- [ ] **Step 2: Create the build helper, the CSS-module typing and the two empty barrels**

Create `packages/trace-viewer/scripts/copy-assets.mjs` with this content:

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

Create `packages/trace-viewer/src/css-modules.d.ts` with this content:

```ts
declare module "*.module.css" {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
```

Create `packages/trace-viewer/src/index.ts` with this content:

```ts
export {};
```

Create `packages/trace-viewer/src/model/index.ts` with this content:

```ts
export {};
```

- [ ] **Step 3: Create the Vite dev host**

Create `apps/trace-viewer-dev/package.json` with this content:

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

Create `apps/trace-viewer-dev/tsconfig.json` with this content (it mirrors `apps/desktop/tsconfig.web.json`):

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

Create `apps/trace-viewer-dev/vite.config.ts` with this content:

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

Create `apps/trace-viewer-dev/index.html` with this content:

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

Create `apps/trace-viewer-dev/src/main.tsx` with this content:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const root = document.getElementById("root");
if (root === null) throw new Error("dev host: #root is missing");

createRoot(root).render(
  <StrictMode>
    <h1>Trace viewer dev host</h1>
  </StrictMode>,
);
```

- [ ] **Step 4: Add the workspace dependency to desktop, fast-check to contracts and the components subpath to ui-catalog**

In `apps/desktop/package.json`, find:

```json
    "@jevcode/telemetry": "workspace:^",
```

Replace it with:

```json
    "@jevcode/telemetry": "workspace:^",
    "@jevcode/trace-viewer": "workspace:^",
```

In `packages/contracts/package.json`, find:

```json
  "devDependencies": {
    "@types/node": "^22.13.0",
    "typescript": "^5.7.3",
    "vitest": "^3.0.5"
  }
```

Replace it with:

```json
  "devDependencies": {
    "@types/node": "^22.13.0",
    "fast-check": "4.10.1",
    "typescript": "^5.7.3",
    "vitest": "^3.0.5"
  }
```

In `packages/ui-catalog/package.json`, find:

```json
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
```

Replace it with:

```json
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./components/*": {
      "types": "./dist/components/*.d.ts",
      "import": "./dist/components/*.js"
    }
  },
```

The Inspector's Evidence tab imports `@jevcode/ui-catalog/components/CodeDiff` (spec §7.1). That subpath is the only ui-catalog form `TRACE_VIEWER_PATHS` allows, and `tsc -p packages/ui-catalog/tsconfig.json` already emits `dist/components/CodeDiff.{js,d.ts}`. `./sources` in the trace-viewer manifest lets `apps/desktop` tests import `createStaticBundleSource` and `readAllTraceRows` without the React barrel and its `.module.css` imports; lane C1b (C1-15) creates `src/sources/index.ts`, so the entry resolves only after that lane. `d3-zoom` 3.0.0 and its peer `d3-selection` 3.0.0 are R17's fallback for spike risk 1 (UI task C1-7F); no UI lane may add a dependency later, so W0 adds them now.

- [ ] **Step 5: Install and check that no second copy of a pinned package appeared**

Run: `pnpm install`
Expected: exits 0 with `Scope: all 15 workspace projects` and `Packages: +3`. Three warnings are expected and harmless: `packages/trace-viewer | WARN deprecated eslint@9.39.5`, the pre-existing `WARN 8 deprecated subdependencies found: @npmcli/move-file@2.0.1, boolean@3.2.0, …` (all already in the base lockfile), and the existing `@json-render/core 0.21.0 ✕ unmet peer zod@^4.0.0: found 3.25.76` under `apps/desktop`.

Run: `grep -oE "^  '?(@xyflow/react|react|react-dom|zod|fast-check|jsdom|vite|@vitejs/plugin-react|@types/react|@types/react-dom|eslint)@[0-9][0-9.]*" pnpm-lock.yaml | sort -u`
Expected, byte for byte (the same output as at `144c7fb`; an extra line means a pin drifted, so fix the pin before going on):

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

Run: `git diff --numstat -- pnpm-lock.yaml`
Expected: `134	0	pnpm-lock.yaml`. The lockfile gains lines and loses none. The only new tarballs are `@tanstack/react-virtual@3.14.13`, `@tanstack/virtual-core@3.17.11` and `@testing-library/user-event@14.6.7`. `d3-zoom@3.0.0`, `d3-selection@3.0.0`, `@types/d3-zoom@3.0.8` and `@types/d3-selection@3.0.12` were already locked through `@xyflow/react`, so they add only importer lines.

Run: `grep -c "anchorTo?: ScrollAnchor\|followOnAppend?: FollowOnAppend\|scrollEndThreshold?: number" node_modules/.pnpm/@tanstack+virtual-core@3.17.11/node_modules/@tanstack/virtual-core/src/index.ts`
Expected: `3`. These are the live-follow options the UI's spine and Outline rely on (R17, spec §16 risk 7). If the directory is missing (the resolved virtual-core is not 3.17.11) or the count is not 3, stop and escalate; do not continue with W0-1.

- [ ] **Step 6: Write the failing lint-boundary test**

Create `packages/trace-viewer/src/lint-boundaries.test.ts` with this content:

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// Pins the import bans in eslint.config.mjs (R7). The probe files never exist on disk:
// ESLint lints the code as if it lived at filePath, so the path decides which blocks apply.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

let eslint: ESLint | undefined;

async function ruleIds(filePath: string, code: string): Promise<string[]> {
  eslint ??= new ESLint({ cwd: REPO_ROOT });
  const [result] = await eslint.lintText(code, { filePath: path.join(REPO_ROOT, filePath) });
  if (result === undefined) throw new Error(`ESLint returned no result for ${filePath}`);
  return result.messages.map((message) => message.ruleId ?? `fatal: ${message.message}`);
}

interface BoundaryCase {
  filePath: string;
  code: string;
  expected: string[];
}

const CASES: BoundaryCase[] = [
  {
    filePath: "packages/trace-viewer/src/model/probe.ts",
    code: 'import { readFileSync } from "node:fs"; export const x = readFileSync;',
    expected: ["no-restricted-imports"],
  },
  {
    filePath: "packages/trace-viewer/src/model/probe.ts",
    code: 'import { useState } from "react"; export const x = useState;',
    expected: ["no-restricted-imports"],
  },
  {
    filePath: "packages/trace-viewer/src/model/probe.ts",
    code: 'import { Shell } from "../ui/Shell.js"; export const x = Shell;',
    expected: ["no-restricted-imports"],
  },
  {
    filePath: "packages/trace-viewer/src/model/probe.ts",
    code: 'import { buildTimeScale } from "../layout/time-scale.js"; export const x = buildTimeScale;',
    expected: ["no-restricted-imports"],
  },
  {
    filePath: "packages/trace-viewer/src/model/probe.ts",
    code: 'export const x = () => fetch("/x");',
    expected: ["no-restricted-globals"],
  },
  {
    filePath: "packages/trace-viewer/src/model/probe.ts",
    code: 'export const x = Buffer.byteLength("a");',
    expected: ["no-restricted-globals"],
  },
  {
    filePath: "packages/trace-viewer/src/model/probe.test.ts",
    code: 'import { readFileSync } from "node:fs"; export const x = readFileSync;',
    expected: [],
  },
  {
    filePath: "packages/trace-viewer/src/layout/probe.ts",
    code: 'import { useState } from "react"; export const x = useState;',
    expected: ["no-restricted-imports"],
  },
  {
    filePath: "packages/trace-viewer/src/layout/probe.ts",
    code: 'import { Shell } from "../ui/shell/Shell.js"; export const x = Shell;',
    expected: ["no-restricted-imports"],
  },
  {
    filePath: "packages/trace-viewer/src/layout/probe.ts",
    code: "export const x = () => document.body;",
    expected: ["no-restricted-globals"],
  },
  {
    filePath: "packages/trace-viewer/src/layout/probe.ts",
    code: "export const x = () => Date.now();",
    expected: ["no-restricted-globals"],
  },
  {
    filePath: "packages/trace-viewer/src/layout/probe.ts",
    code: 'import { LANES } from "../model/index.js"; export const x = LANES;',
    expected: [],
  },
  {
    filePath: "packages/trace-viewer/src/layout/probe.test.ts",
    code: "export const x = () => document.body;",
    expected: [],
  },
  {
    filePath: "packages/trace-viewer/src/ui/probe.tsx",
    code: 'import { useState } from "react"; export const x = useState;',
    expected: [],
  },
  {
    filePath: "packages/trace-viewer/src/ui/probe.tsx",
    code: 'import { registry } from "@jevcode/ui-catalog"; export const x = registry;',
    expected: ["no-restricted-imports"],
  },
  {
    filePath: "packages/trace-viewer/src/ui/probe.tsx",
    code: 'import { openDb } from "@jevcode/storage"; export const x = openDb;',
    expected: ["no-restricted-imports"],
  },
];

describe("lint boundaries (eslint.config.mjs)", () => {
  it.each(CASES)(
    "$filePath: $code",
    async ({ filePath, code, expected }) => {
      expect(await ruleIds(filePath, code)).toEqual(expected);
    },
    30_000,
  );
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/lint-boundaries.test.ts`
Expected: FAIL with `Tests  12 failed | 4 passed (16)`. The four `expected: []` cases pass; every banned import or global reports `[]` because no rule is configured yet.

- [ ] **Step 8: Add the browser-safety constants and the three trace-viewer blocks to ESLint**

In `eslint.config.mjs`, find:

```js
  MutationObserver: "readonly",
};

export default tseslint.config(
```

Replace it with:

```js
  MutationObserver: "readonly",
};

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

export default tseslint.config(
```

In `eslint.config.mjs`, find:

```js
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
```

Replace it with:

```js
    rules: {
      "@typescript-eslint/no-require-imports": "off",
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
);
```

In flat config, a later object's setting for the same rule replaces the earlier one for that file. That is why the model and layout blocks repeat the full pattern and globals lists. `src/layout` (UI lanes C1b and C3a) is pure: it imports `src/model` but never `src/ui`, React, d3 or the DOM, and it takes time as numbers instead of reading a clock (R19). The layout block is new with W0 so the UI lanes never edit `eslint.config.mjs`.

- [ ] **Step 9: Run the test and the linter to verify they pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/lint-boundaries.test.ts`
Expected: PASS, `Tests  16 passed (16)`.

Run: `pnpm lint`
Expected: exits 0, with no output after `> pnpm exec eslint .`.

- [ ] **Step 10: Build the new package and the dev host**

Run: `pnpm -r build`
Expected: exits 0. The output includes `packages/trace-viewer build: copy-assets: 0 css file(s)` and `apps/trace-viewer-dev build: ✓ built in`, and `apps/desktop` still builds.

Run: `grep -c "Content-Security-Policy" apps/trace-viewer-dev/dist/index.html`
Expected: `1`.

Run: `pnpm --filter @jevcode/trace-viewer typecheck && pnpm --filter jevcode-trace-viewer-dev typecheck`
Expected: exits 0.

Run: `pnpm --filter @jevcode/trace-viewer exec node --input-type=module -e 'console.log(import.meta.resolve("@jevcode/ui-catalog/components/CodeDiff"))'`
Expected: one line that starts with `file://` and ends with `/packages/ui-catalog/dist/components/CodeDiff.js`. The new subpath resolves from the trace-viewer package.

- [ ] **Step 11: Record the new packages in SPEC §2.2 and retire the deferred replay UI in §18**

In `docs/SPEC.md`, find:

```
├── apps/desktop/                 Electron main / preload / renderer
```

Replace it with:

```
├── apps/desktop/                 Electron main / preload / renderer
├── apps/trace-viewer-dev/        Vite dev host that opens exported trace.json bundles
```

In `docs/SPEC.md`, find:

```
│   └── telemetry/                local event schema + export
```

Replace it with:

```
│   ├── telemetry/                local event schema + export
│   └── trace-viewer/             read-only trace model (src/model, React-free) + viewer UI (src/ui)
```

In `docs/SPEC.md`, find:

```
LSP, call/type graphs, embeddings, coverage/profiling, security scanners, CI/GitHub PR integration, Claude adapter implementation, multi-agent, personalization, policy engine, sandboxing/containers, and semantic Git history productization. Plus replay UI, team features, and Windows/Linux packaging (build config only in v0, target macOS dev first).
```

Replace it with:

```
LSP, call/type graphs, embeddings, coverage/profiling, security scanners, CI/GitHub PR integration, Claude adapter implementation, multi-agent, personalization, policy engine, sandboxing/containers, and semantic Git history productization. Plus team features and Windows/Linux packaging (build config only in v0, target macOS dev first). The read-only trace viewer (`docs/superpowers/specs/2026-09-28-trace-viewer-design.md`) supersedes the deferred replay UI item (plan-owner sign-off under IMPLEMENTATION-PLAN risk R8; design decision D9).
```

- [ ] **Step 12: Run the root checks**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint`
Expected: exits 0 (for the known flaky suites, follow Gotcha 3). Test counts are unchanged from the baseline, plus `packages/trace-viewer test: Tests  16 passed (16)`.

Run: `git status --short`
Expected: exactly these lines. git collapses the new directories, and `dist/` is gitignored, so no build output appears.

```
 M apps/desktop/package.json
 M docs/SPEC.md
 M eslint.config.mjs
 M packages/contracts/package.json
 M packages/ui-catalog/package.json
 M pnpm-lock.yaml
?? apps/trace-viewer-dev/
?? packages/trace-viewer/
```

- [ ] **Step 13: Commit**

```bash
git add packages/trace-viewer/package.json packages/trace-viewer/tsconfig.json packages/trace-viewer/tsconfig.build.json packages/trace-viewer/vitest.config.ts packages/trace-viewer/scripts/copy-assets.mjs packages/trace-viewer/src/css-modules.d.ts packages/trace-viewer/src/index.ts packages/trace-viewer/src/model/index.ts packages/trace-viewer/src/lint-boundaries.test.ts apps/trace-viewer-dev/package.json apps/trace-viewer-dev/tsconfig.json apps/trace-viewer-dev/vite.config.ts apps/trace-viewer-dev/index.html apps/trace-viewer-dev/src/main.tsx apps/desktop/package.json packages/contracts/package.json packages/ui-catalog/package.json eslint.config.mjs pnpm-lock.yaml docs/SPEC.md
git commit -m "feat(trace-viewer): scaffold package, dev host, dependencies and lint boundaries"
```

Run: `git status --short`
Expected: no output.

### Task W0-2: Browser-safe contracts barrel (`newId` via `globalThis.crypto`, `symbolId` → `@jevcode/contracts/node`)

**Files:**
- Create: `packages/contracts/src/node.ts`, `packages/contracts/src/node.test.ts`, `packages/contracts/src/browser-safety.test.ts`
- Modify: `packages/contracts/package.json:8-13`, `packages/contracts/src/id.ts:1-7` and `:42-54`, `packages/contracts/src/id.test.ts:3-13`, `:16-21` and `:40-55`, `packages/evidence-engine/src/symbol-diff.ts:1`, `packages/evidence-engine/src/symbol-diff.test.ts:1`, `packages/semantic-core/src/clustering.ts:16`, `eslint.config.mjs` (after W0-1's blocks), `packages/trace-viewer/src/lint-boundaries.test.ts` (`CASES` tail), `apps/trace-viewer-dev/src/main.tsx`
- Test: `packages/contracts/src/browser-safety.test.ts`, `packages/contracts/src/node.test.ts`, `packages/contracts/src/id.test.ts`, `packages/trace-viewer/src/lint-boundaries.test.ts`, plus the dev-host build

**Interfaces:**
- Consumes (W0-1): `packages/trace-viewer/src/lint-boundaries.test.ts` `CASES: BoundaryCase[]` with `interface BoundaryCase { filePath: string; code: string; expected: string[] }`; the dev host build `pnpm --filter jevcode-trace-viewer-dev build` and its `jevcode-forbid-node-builtins` plugin.
- Produces:
  - `packages/contracts/src/id.ts`: `export function newId(prefix: string): string` returns `` `${prefix}_${32 lowercase hex}` `` via `globalThis.crypto.randomUUID()`. `newSessionId`, `newChangeUnitId`, `newDecisionId`, `newFactId`, `newSemanticEventId`, `newSurfaceId` and `nowIso` are unchanged. `symbolId` is no longer exported from `@jevcode/contracts`.
  - `@jevcode/contracts/node` (new `exports` entry `"./node": { "types": "./dist/node.d.ts", "import": "./dist/node.js" }`): `export function symbolId(path: string, name: string, kind: SymbolKind, signatureText: string): string`, byte-identical to the old function: `` `${path}#${name}(${kind})@${sha1(signatureText) hex}` ``.
  - ESLint: `packages/contracts/src/**/*.ts` (except `src/node.ts` and tests) may not import `node:*`.

- [ ] **Step 1: Write the failing browser-safety test**

Create `packages/contracts/src/browser-safety.test.ts` with this content:

```ts
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The @jevcode/contracts barrel ships to browser bundles (renderer, trace viewer).
// Walk the runtime import graph from src/index.ts and report every Node built-in it reaches.
const SRC = path.dirname(fileURLToPath(import.meta.url));
const NODE_BUILTINS = new Set(builtinModules);
// import/export statements with a module specifier; group 1 marks type-only statements,
// which verbatimModuleSyntax erases, so they add nothing to the runtime graph.
const STATEMENT = /\b(?:import|export)\s+(type\s+)?(?:[\w*{}\s,]+?\s+from\s+)?["']([^"']+)["']/g;

interface Graph {
  visited: string[];
  nodeImports: string[];
}

function walk(entry: string): Graph {
  const visited = new Set<string>();
  const nodeImports: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (visited.has(file)) continue;
    visited.add(file);
    const text = readFileSync(path.join(SRC, file), "utf8");
    for (const match of text.matchAll(STATEMENT)) {
      const typeOnly = match[1] !== undefined;
      const specifier = match[2] as string;
      if (typeOnly) continue;
      if (specifier.startsWith(".")) {
        const target = path.posix.join(path.posix.dirname(file), specifier).replace(/\.js$/, ".ts");
        queue.push(target);
      } else if (specifier.startsWith("node:") || NODE_BUILTINS.has(specifier.split("/")[0] as string)) {
        nodeImports.push(`${file} -> ${specifier}`);
      }
    }
  }
  return { visited: [...visited].sort(), nodeImports: nodeImports.sort() };
}

describe("contracts barrel browser safety", () => {
  const graph = walk("index.ts");

  it("reaches the whole barrel", () => {
    expect(graph.visited).toEqual(
      expect.arrayContaining(["agent-events.ts", "evidence.ts", "id.ts", "semantic.ts", "ui/components.ts"]),
    );
  });

  it("imports no Node built-in at runtime", () => {
    expect(graph.nodeImports).toEqual([]);
  });

  it("keeps node.ts out of the barrel", () => {
    expect(graph.visited).not.toContain("node.ts");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @jevcode/contracts exec vitest run src/browser-safety.test.ts`
Expected: FAIL, `Tests  1 failed | 2 passed (3)`. The failing test is `imports no Node built-in at runtime`, and it received `["id.ts -> node:crypto"]`.

- [ ] **Step 3: Write the failing pinned-digest test for the moved helper**

Create `packages/contracts/src/node.test.ts` with this content:

```ts
import { describe, expect, it } from "vitest";

import { symbolId } from "./node.js";

// Digests are pinned: stored change_unit_symbols rows use these ids, so the move out of
// id.ts must not change a single byte.
describe("symbolId (@jevcode/contracts/node)", () => {
  it("follows the SPEC section 3.2 identity format", () => {
    expect(
      symbolId("auth/service.ts", "createSession", "method", "createSession(userId: string)"),
    ).toBe("auth/service.ts#createSession(method)@34fe8cce1d56428b1cf104d3979829db6c929659");
  });

  it("changes when the signature changes", () => {
    const before = symbolId("a.ts", "f", "function", "f(x)");
    expect(before).toBe("a.ts#f(function)@3e03f4706048fbc6c5a252a85d066adf107fcc1f");
    expect(symbolId("a.ts", "f", "function", "f(x, y)")).not.toBe(before);
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `pnpm --filter @jevcode/contracts exec vitest run src/node.test.ts`
Expected: FAIL with `Error: Cannot find module './node.js' imported from '…/packages/contracts/src/node.test.ts'`.

- [ ] **Step 5: Add the two contracts cases to the lint-boundary test**

In `packages/trace-viewer/src/lint-boundaries.test.ts`, find:

```ts
  {
    filePath: "packages/trace-viewer/src/ui/probe.tsx",
    code: 'import { openDb } from "@jevcode/storage"; export const x = openDb;',
    expected: ["no-restricted-imports"],
  },
];
```

Replace it with:

```ts
  {
    filePath: "packages/trace-viewer/src/ui/probe.tsx",
    code: 'import { openDb } from "@jevcode/storage"; export const x = openDb;',
    expected: ["no-restricted-imports"],
  },
  {
    filePath: "packages/contracts/src/probe.ts",
    code: 'import { createHash } from "node:crypto"; export const x = createHash;',
    expected: ["no-restricted-imports"],
  },
  {
    filePath: "packages/contracts/src/node.ts",
    code: 'import { createHash } from "node:crypto"; export const x = createHash;',
    expected: [],
  },
];
```

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/lint-boundaries.test.ts`
Expected: FAIL, `Tests  1 failed | 17 passed (18)`. The failing case is `packages/contracts/src/probe.ts`, which received `[]`.

- [ ] **Step 6: Put the contracts barrel into the dev host's browser graph and watch the build fail**

Replace the entire contents of `apps/trace-viewer-dev/src/main.tsx` with:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AgentStateSchema } from "@jevcode/contracts";

const root = document.getElementById("root");
if (root === null) throw new Error("dev host: #root is missing");

createRoot(root).render(
  <StrictMode>
    <main>
      <h1>Trace viewer dev host</h1>
      <p>Agent states: {AgentStateSchema.options.join(", ")}.</p>
    </main>
  </StrictMode>,
);
```

Run: `pnpm --filter jevcode-trace-viewer-dev build`
Expected: FAIL with `[plugin jevcode-forbid-node-builtins] browser bundle imports "node:crypto" from /Users/jwpark/Projects/jevcode-tv-w0/packages/contracts/dist/id.js; the trace viewer must stay browser-safe`.

- [ ] **Step 7: Make `newId` browser-safe and drop `symbolId` from `id.ts`**

In `packages/contracts/src/id.ts`, find:

```ts
import { createHash, randomUUID } from "node:crypto";

import type { SymbolKind } from "./evidence.js";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}
```

Replace it with:

```ts
// Browser-safe: no node: imports. Web Crypto's randomUUID is global in Node >= 19 and every
// browser this code targets. Node-only helpers live in node.ts (@jevcode/contracts/node).
export function newId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}
```

In `packages/contracts/src/id.ts`, find:

```ts
export function nowIso(): string {
  return new Date().toISOString();
}

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

Replace it with:

```ts
export function nowIso(): string {
  return new Date().toISOString();
}
```

- [ ] **Step 8: Create the Node-only module and export it as `@jevcode/contracts/node`**

Create `packages/contracts/src/node.ts` with this content:

```ts
// Node-only helpers, exported as "@jevcode/contracts/node". Never import this file from
// the barrel (src/index.ts): the barrel must stay browser-safe (browser-safety.test.ts).
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

In `packages/contracts/package.json`, find:

```json
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
```

Replace it with:

```json
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./node": {
      "types": "./dist/node.d.ts",
      "import": "./dist/node.js"
    }
  },
```

- [ ] **Step 9: Move the `symbolId` cases out of `id.test.ts` and pin the `newId` format**

In `packages/contracts/src/id.test.ts`, find:

```ts
import {
  newChangeUnitId,
  newDecisionId,
  newFactId,
  newId,
  newSemanticEventId,
  newSessionId,
  newSurfaceId,
  nowIso,
  symbolId,
} from "./id.js";
```

Replace it with:

```ts
import {
  newChangeUnitId,
  newDecisionId,
  newFactId,
  newId,
  newSemanticEventId,
  newSessionId,
  newSurfaceId,
  nowIso,
} from "./id.js";
```

In `packages/contracts/src/id.test.ts`, find:

```ts
  it("newId applies the prefix and is unique", () => {
    const a = newId("x");
    const b = newId("x");
    expect(a.startsWith("x_")).toBe(true);
    expect(a).not.toBe(b);
  });
```

Replace it with:

```ts
  it("newId applies the prefix and is unique", () => {
    const a = newId("x");
    const b = newId("x");
    expect(a.startsWith("x_")).toBe(true);
    expect(a).not.toBe(b);
  });

  it("newId keeps the prefix_<32 hex> format", () => {
    expect(newId("turn")).toMatch(/^turn_[0-9a-f]{32}$/);
  });
```

In `packages/contracts/src/id.test.ts`, find:

```ts
  it("nowIso returns a parseable ISO timestamp", () => {
    const iso = nowIso();
    expect(new Date(iso).toISOString()).toBe(iso);
  });

  it("symbolId follows the SPEC section 3.2 identity format", () => {
    const id = symbolId("auth/service.ts", "createSession", "method", "createSession(userId: string)");
    expect(id).toMatch(/^auth\/service\.ts#createSession\(method\)@[0-9a-f]{40}$/);
  });

  it("symbolId changes when the signature changes", () => {
    const a = symbolId("a.ts", "f", "function", "f(x)");
    const b = symbolId("a.ts", "f", "function", "f(x, y)");
    expect(a).not.toBe(b);
  });
});
```

Replace it with:

```ts
  it("nowIso returns a parseable ISO timestamp", () => {
    const iso = nowIso();
    expect(new Date(iso).toISOString()).toBe(iso);
  });
});
```

- [ ] **Step 10: Build contracts and run its tests to verify they pass**

Run: `pnpm --filter @jevcode/contracts build && pnpm --filter @jevcode/contracts test`
Expected: PASS, `Test Files  10 passed (10)` and `Tests  110 passed (110)`.

Run: `grep -l "node:crypto" packages/contracts/dist/*.js`
Expected: exactly one line, `packages/contracts/dist/node.js`.

- [ ] **Step 11: Point the three callers at `@jevcode/contracts/node`**

In `packages/evidence-engine/src/symbol-diff.ts`, find:

```ts
import { symbolId, type SymbolInfo } from "@jevcode/contracts";
```

Replace it with:

```ts
import type { SymbolInfo } from "@jevcode/contracts";
import { symbolId } from "@jevcode/contracts/node";
```

In `packages/evidence-engine/src/symbol-diff.test.ts`, find:

```ts
import { symbolId, type SymbolInfo } from "@jevcode/contracts";
```

Replace it with:

```ts
import type { SymbolInfo } from "@jevcode/contracts";
import { symbolId } from "@jevcode/contracts/node";
```

In `packages/semantic-core/src/clustering.ts`, find:

```ts
import { symbolId } from "@jevcode/contracts";
```

Replace it with:

```ts
import { symbolId } from "@jevcode/contracts/node";
```

- [ ] **Step 12: Ban `node:` imports in the contracts barrel**

In `eslint.config.mjs`, find:

```js
  {
    files: ["packages/trace-viewer/src/**/*.ts", "packages/trace-viewer/src/**/*.tsx"],
```

Replace it with:

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
```

- [ ] **Step 13: Rebuild the dependents and verify every guard passes**

Run: `pnpm --filter "...@jevcode/contracts" build`
Expected: exits 0. It rebuilds contracts and every package that depends on it; `evidence-engine` and `semantic-core` now compile against `@jevcode/contracts/node`.

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/lint-boundaries.test.ts`
Expected: PASS, `Tests  18 passed (18)`.

Run: `pnpm --filter @jevcode/evidence-engine exec vitest run src/symbol-diff.test.ts src/worker/parser.test.ts && pnpm --filter @jevcode/semantic-core exec vitest run src/clustering.test.ts`
Expected: PASS, `Tests  24 passed (24)` and `Tests  32 passed (32)`.

Run: `pnpm --filter jevcode-trace-viewer-dev build`
Expected: PASS, ending `✓ built in …`.

Run: `node scripts/validate-fixtures.mjs`
Expected: last lines `Checks: 149, passed: 149, failed: 0` and `VALIDATION PASSED`.

- [ ] **Step 14: Run the root checks**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint`
Expected: exits 0 (for the known flaky suites, follow Gotcha 3). Contracts shows `Tests  110 passed (110)` and trace-viewer shows `Tests  18 passed (18)`; every other package matches the baseline.

- [ ] **Step 15: Commit**

```bash
git add packages/contracts/src/node.ts packages/contracts/src/node.test.ts packages/contracts/src/browser-safety.test.ts packages/contracts/package.json packages/contracts/src/id.ts packages/contracts/src/id.test.ts packages/evidence-engine/src/symbol-diff.ts packages/evidence-engine/src/symbol-diff.test.ts packages/semantic-core/src/clustering.ts eslint.config.mjs packages/trace-viewer/src/lint-boundaries.test.ts apps/trace-viewer-dev/src/main.tsx
git commit -m "refactor(contracts): keep the barrel browser-safe and move symbolId to contracts/node"
```

Run: `git status --short`
Expected: no output.

### Task W0-3: `canonicalJson`

**Files:**
- Create: `packages/contracts/src/canonical-json.ts`
- Modify: `packages/contracts/src/index.ts:2`
- Test: `packages/contracts/src/canonical-json.test.ts`

**Interfaces:**
- Consumes (W0-1): the `fast-check` 4.10.1 devDependency of `@jevcode/contracts`. From the existing code: `EvidenceFactSchema` from `packages/contracts/src/evidence.ts`.
- Produces: `export function canonicalJson(value: unknown): string` from `@jevcode/contracts`. It sorts object keys by UTF-16 code unit at every depth, drops properties whose value is `undefined`, keeps array order, keeps an own `"__proto__"` key as data, and throws `TypeError("canonicalJson: value has no JSON representation")` when `JSON.stringify` returns `undefined`. Consumers: A1-5 (`factContentId` hashes `canonicalJson(record)`), A1-5's no-strip guards, A2 tests.

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/canonical-json.test.ts` with this content:

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { canonicalJson } from "./canonical-json.js";
import { EvidenceFactSchema } from "./evidence.js";

// Rebuilds every object with its keys inserted in reverse order. A null prototype keeps an
// own "__proto__" key as data instead of setting the prototype.
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(source).reverse()) {
    out[key] = reverseKeys(source[key]);
  }
  return out;
}

describe("canonicalJson", () => {
  it("sorts keys at every depth and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}',
    );
  });

  it("drops undefined properties", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it("throws a TypeError for a value with no JSON form", () => {
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
  });

  it("keeps an own __proto__ key as data", () => {
    expect(canonicalJson(JSON.parse('{"__proto__":1}'))).toBe('{"__proto__":1}');
  });

  it("gives a collector-ordered fact and its zod-parsed copy one string (R3)", () => {
    // Collectors emit ts last; zod rebuilds the object in schema order (ts fourth).
    const collectorOrder = {
      type: "git_hunk",
      repoId: "repo_1",
      sessionId: "sess_1",
      file: "src/a.ts",
      added: 3,
      removed: 1,
      isFormattingOnly: false,
      isConfigOnly: false,
      isLockfile: false,
      ts: "2026-09-28T10:00:00.000Z",
    };
    const stored = EvidenceFactSchema.parse(collectorOrder);
    expect(JSON.stringify(stored)).not.toBe(JSON.stringify(collectorOrder));
    expect(canonicalJson(stored)).toBe(canonicalJson(collectorOrder));
  });

  it("depends only on the key set, never on insertion order", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(canonicalJson(reverseKeys(value))).toBe(canonicalJson(value));
      }),
    );
  });

  it("is a fixed point: re-canonicalizing its own output changes nothing", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const once = canonicalJson(value);
        expect(canonicalJson(JSON.parse(once))).toBe(once);
      }),
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @jevcode/contracts exec vitest run src/canonical-json.test.ts`
Expected: FAIL with `Error: Cannot find module './canonical-json.js' imported from '…/packages/contracts/src/canonical-json.test.ts'`.

- [ ] **Step 3: Write the implementation**

Create `packages/contracts/src/canonical-json.ts` with this content:

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

- [ ] **Step 4: Export it from the barrel**

In `packages/contracts/src/index.ts`, find:

```ts
export * from "./agent.js";
```

Replace it with:

```ts
export * from "./agent.js";
export * from "./canonical-json.js";
```

- [ ] **Step 5: Run the tests to verify they pass and the barrel stays browser-safe**

Run: `pnpm --filter @jevcode/contracts exec vitest run src/canonical-json.test.ts src/browser-safety.test.ts`
Expected: PASS, `Tests  10 passed (10)`.

Run: `pnpm --filter @jevcode/contracts build && pnpm --filter @jevcode/contracts typecheck && pnpm --filter @jevcode/contracts test`
Expected: PASS, `Test Files  11 passed (11)` and `Tests  117 passed (117)`.

- [ ] **Step 6: Run the root checks**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint`
Expected: exits 0 (for the known flaky suites, follow Gotcha 3). Contracts shows `Tests  117 passed (117)`; every other package matches the W0-2 counts.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/canonical-json.ts packages/contracts/src/canonical-json.test.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): add canonicalJson"
```

### Task W0-4: Capture contract fields (`turnId`, `callId`, `agent_reasoning`, `agent_interrupted`, `sourceCallId`, `git_hunk.diff`, `agentCallIds`, `Decision.ts`, `JevDecisionLog.pass`); WorkspaceHost cases; SPEC §4.1–§4.3

**Files:**
- Modify: `packages/contracts/src/agent-events.ts:1-71` (whole file), `packages/contracts/src/evidence.ts:32`, `:47-50`, `:83-85`, `:90-92`, `packages/contracts/src/semantic.ts:187-190`, `:224-225`, `packages/contracts/src/jev.ts:65`, `:93-95`, `apps/desktop/src/renderer/components/WorkspaceHost.tsx:112-113`, `:136-139`, `docs/SPEC.md:201-217`, `:222-224`, `:230-233`, `:238-239`, `:268-270`, `:277-279` (line numbers at `144c7fb`; W0-1 moved them down by 2, so match on the quoted text)
- Test: `packages/contracts/src/agent-events.test.ts` (import at `:3-6`, appended `describe`), `packages/contracts/src/evidence.test.ts` (import at `:3-8`, appended `describe`), `packages/contracts/src/semantic.test.ts` (before `:146` and `:192`), `packages/contracts/src/jev.test.ts` (import at `:3-9`, after `:255-261`)

**Interfaces:**
- Consumes: nothing new. This task edits schemas that already exist in `@jevcode/contracts`.
- Produces (all exported from `@jevcode/contracts`; every new field is optional):
  - `AgentInterruptReasonSchema = z.enum(["interrupt", "steer", "stop"])`, `type AgentInterruptReason`.
  - `NormalizedAgentEventSchema`: `turnId?: string` (min 1) on every variant; `callId?: string` (min 1) on `agent_reasoning`, `tool_started`, `tool_completed`, `command_started`, `command_completed`, `file_changed`, `approval_requested`; new variants `{ type: "agent_reasoning"; sessionId; ts; turnId?; callId?; text: string }` and `{ type: "agent_interrupted"; sessionId; ts; turnId?; reason: AgentInterruptReason }`. `NormalizedAgentEventType` gains `"agent_reasoning" | "agent_interrupted"`.
  - `DiffWithheldReasonSchema = z.enum(["secret_path", "not_captured"])`, `type DiffWithheldReason`; `GitHunkDiffSchema` (`hash` matching `/^[0-9a-f]{16}$/`, `bytes` int ≥ 0, `text?`, `truncated: boolean`, `redactions` int ≥ 0, `withheld?`; refine: a withheld diff carries no text), `type GitHunkDiff`.
  - `EvidenceFact`: `git_hunk.diff?: GitHunkDiff`; `test_result.sourceCallId?: string`; `command_executed.sourceCallId?: string`.
  - `ChangeUnit.agentCallIds?: string[]` (each min 1); `Decision.ts?: string`.
  - `JevPassSchema = z.enum(["A", "B"])`, `type JevPass`; `JevDecisionLog.pass?: JevPass`.
  - `WorkspaceHost.tsx` `eventSummary` labels: `agent_reasoning` → `"Thinking"`; `agent_interrupted` → `"Paused"` (interrupt), `"Redirected"` (steer), `"Stopped"` (stop). `isConversationEvent` stays unchanged, so reasoning and interruptions stay out of the Conversation tab.
  - Agent events must never carry `repoId`: `pipeline-runtime.ts:334` and `parseReplayLine` try `EvidenceFactSchema` first.

- [ ] **Step 1: Write the failing agent-event tests**

In `packages/contracts/src/agent-events.test.ts`, find:

```ts
import {
  NormalizedAgentEventSchema,
  type NormalizedAgentEvent,
} from "./agent-events.js";
```

Replace it with:

```ts
import {
  AgentInterruptReasonSchema,
  NormalizedAgentEventSchema,
  type NormalizedAgentEvent,
} from "./agent-events.js";
```

Append to the end of `packages/contracts/src/agent-events.test.ts`:

```ts

describe("trace identity fields and lifecycle variants", () => {
  const turnId = "turn_0123456789abcdef0123456789abcdef";
  const callId = `${turnId}:item_7`;
  const CALL_TYPES = new Set([
    "tool_started",
    "tool_completed",
    "command_started",
    "command_completed",
    "file_changed",
    "approval_requested",
  ]);

  it("keeps turnId on every variant and callId on the six call variants", () => {
    for (const event of events) {
      const withIds = CALL_TYPES.has(event.type) ? { ...event, turnId, callId } : { ...event, turnId };
      const parsed = NormalizedAgentEventSchema.parse(withIds);
      // zod strips undeclared keys silently; equality proves nothing was dropped.
      expect(parsed, event.type).toEqual(withIds);
    }
  });

  it("parses agent_reasoning with and without a callId", () => {
    const reasoning = { type: "agent_reasoning", sessionId: sid, turnId, text: "Check the callback first.", ts };
    expect(NormalizedAgentEventSchema.parse(reasoning)).toEqual(reasoning);
    expect(NormalizedAgentEventSchema.parse({ ...reasoning, callId })).toEqual({ ...reasoning, callId });
  });

  it("parses agent_interrupted for interrupt, steer and stop", () => {
    expect(AgentInterruptReasonSchema.options).toEqual(["interrupt", "steer", "stop"]);
    for (const reason of AgentInterruptReasonSchema.options) {
      const event = { type: "agent_interrupted", sessionId: sid, reason, ts };
      expect(NormalizedAgentEventSchema.parse(event)).toEqual(event);
    }
  });

  it("rejects an unknown interrupt reason", () => {
    const result = NormalizedAgentEventSchema.safeParse({
      type: "agent_interrupted",
      sessionId: sid,
      reason: "cancel",
      ts,
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty turnId and callId", () => {
    const base = { type: "command_started", sessionId: sid, command: "pnpm test", ts };
    expect(NormalizedAgentEventSchema.safeParse({ ...base, turnId: "" }).success).toBe(false);
    expect(NormalizedAgentEventSchema.safeParse({ ...base, callId: "" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @jevcode/contracts exec vitest run src/agent-events.test.ts`
Expected: FAIL, `Tests  4 failed | 6 passed (10)`. "rejects an unknown interrupt reason" already passes, because the variant does not exist yet.

- [ ] **Step 3: Write the failing evidence, semantic and Jev tests**

In `packages/contracts/src/evidence.test.ts`, find:

```ts
import {
  EvidenceFactSchema,
  SymbolInfoSchema,
  TestFailureSchema,
  type EvidenceFact,
} from "./evidence.js";
```

Replace it with:

```ts
import {
  EvidenceFactSchema,
  GitHunkDiffSchema,
  SymbolInfoSchema,
  TestFailureSchema,
  type EvidenceFact,
} from "./evidence.js";
```

Append to the end of `packages/contracts/src/evidence.test.ts`:

```ts

describe("trace fields on evidence facts", () => {
  const gitHunk = {
    type: "git_hunk",
    repoId,
    sessionId,
    file: "src/a.ts",
    added: 1,
    removed: 1,
    isFormattingOnly: false,
    isConfigOnly: false,
    isLockfile: false,
    ts,
  };
  const diff = {
    hash: "0123456789abcdef",
    bytes: 58,
    text: "@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n",
    truncated: false,
    redactions: 0,
  };

  it("keeps git_hunk.diff through a parse", () => {
    expect(EvidenceFactSchema.parse({ ...gitHunk, diff })).toEqual({ ...gitHunk, diff });
  });

  it("accepts a withheld diff without text", () => {
    const withheld = { hash: "fedcba9876543210", bytes: 120, truncated: false, redactions: 0, withheld: "secret_path" };
    expect(GitHunkDiffSchema.parse(withheld)).toEqual(withheld);
    expect(GitHunkDiffSchema.parse({ ...withheld, withheld: "not_captured" }).withheld).toBe("not_captured");
  });

  it("rejects a withheld diff that carries text", () => {
    expect(GitHunkDiffSchema.safeParse({ ...diff, withheld: "secret_path" }).success).toBe(false);
  });

  it("rejects a hash that is not 16 lowercase hex characters", () => {
    expect(GitHunkDiffSchema.safeParse({ ...diff, hash: "0123456789abcde" }).success).toBe(false);
    expect(GitHunkDiffSchema.safeParse({ ...diff, hash: "0123456789ABCDEF" }).success).toBe(false);
  });

  it("rejects an unknown withheld reason", () => {
    const result = GitHunkDiffSchema.safeParse({ hash: diff.hash, bytes: 1, truncated: false, redactions: 0, withheld: "too_big" });
    expect(result.success).toBe(false);
  });

  it("keeps sourceCallId on test_result and command_executed", () => {
    const sourceCallId = "turn_1:item_4";
    for (const fact of facts.filter((f) => f.type === "test_result" || f.type === "command_executed")) {
      expect(EvidenceFactSchema.parse({ ...fact, sourceCallId })).toEqual({ ...fact, sourceCallId });
    }
  });
});
```

In `packages/contracts/src/semantic.test.ts`, find:

```ts
  it("rejects an invalid blast radius scope", () => {
```

Replace it with:

```ts
  it("keeps agentCallIds through a parse", () => {
    const withCalls = { ...unit, agentCallIds: ["turn_1:item_2", "turn_1:item_5"] };
    expect(ChangeUnitSchema.parse(withCalls).agentCallIds).toEqual(["turn_1:item_2", "turn_1:item_5"]);
    expect(ChangeUnitSchema.safeParse({ ...unit, agentCallIds: [""] }).success).toBe(false);
  });

  it("rejects an invalid blast radius scope", () => {
```

In `packages/contracts/src/semantic.test.ts`, find:

```ts
  it("rejects an invalid severity", () => {
```

Replace it with:

```ts
  it("keeps the optional status-transition ts", () => {
    const decision = {
      id: "dec_1",
      sessionId,
      title: "Account linking policy",
      context: "Existing users signing in through Google",
      severity: "required",
      options: [],
      affectedChangeUnits: [],
      evidence: [],
      status: "answered",
      ts,
    };
    expect(DecisionSchema.parse(decision)).toEqual(decision);
  });

  it("rejects an invalid severity", () => {
```

In `packages/contracts/src/jev.test.ts`, find:

```ts
import {
  AttentionDecisionSchema,
  JevDecisionLogSchema,
  JevResultSchema,
  UIIntentSchema,
  type JevResult,
} from "./jev.js";
```

Replace it with:

```ts
import {
  AttentionDecisionSchema,
  JevDecisionLogSchema,
  JevPassSchema,
  JevResultSchema,
  UIIntentSchema,
  type JevResult,
} from "./jev.js";
```

In `packages/contracts/src/jev.test.ts`, find:

```ts
  it("parses a valid log with bounded probabilities", () => {
    const result = JevDecisionLogSchema.safeParse({
      ...baseLog,
      probabilities: { schema_change: 0.9, failure: 0.1 },
    });
    expect(result.success).toBe(true);
  });
```

Replace it with:

```ts
  it("parses a valid log with bounded probabilities", () => {
    const result = JevDecisionLogSchema.safeParse({
      ...baseLog,
      probabilities: { schema_change: 0.9, failure: 0.1 },
    });
    expect(result.success).toBe(true);
  });

  it("keeps the optional Jev pass", () => {
    expect(JevPassSchema.options).toEqual(["A", "B"]);
    expect(JevDecisionLogSchema.parse({ ...baseLog, pass: "A" }).pass).toBe("A");
    expect(JevDecisionLogSchema.parse({ ...baseLog, pass: "B" }).pass).toBe("B");
    expect(JevDecisionLogSchema.safeParse({ ...baseLog, pass: "C" }).success).toBe(false);
  });
```

- [ ] **Step 4: Run the four files to verify the new tests fail and the old ones pass**

Run: `pnpm --filter @jevcode/contracts exec vitest run src/agent-events.test.ts src/evidence.test.ts src/semantic.test.ts src/jev.test.ts`
Expected: FAIL, `Tests  13 failed | 42 passed (55)`. All 13 failures are new tests; every pre-existing test (which parses the pre-W0 shapes) still passes.

- [ ] **Step 5: Replace the agent-event schema**

Replace the entire contents of `packages/contracts/src/agent-events.ts` (currently 71 lines, from `import { z } from "zod";` to `export type NormalizedAgentEventType = NormalizedAgentEvent["type"];`) with:

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

- [ ] **Step 6: Add the diff schema and the `sourceCallId` fields to evidence facts**

In `packages/contracts/src/evidence.ts`, find:

```ts
export type TestFailure = z.infer<typeof TestFailureSchema>;
```

Replace it with:

```ts
export type TestFailure = z.infer<typeof TestFailureSchema>;

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

In `packages/contracts/src/evidence.ts`, find:

```ts
    isFormattingOnly: z.boolean(),
    isConfigOnly: z.boolean(),
    isLockfile: z.boolean(),
  }),
```

Replace it with:

```ts
    isFormattingOnly: z.boolean(),
    isConfigOnly: z.boolean(),
    isLockfile: z.boolean(),
    diff: GitHunkDiffSchema.optional(),
  }),
```

In `packages/contracts/src/evidence.ts`, find:

```ts
    skipped: z.number().int().nonnegative(),
    failures: z.array(TestFailureSchema),
  }),
```

Replace it with:

```ts
    skipped: z.number().int().nonnegative(),
    failures: z.array(TestFailureSchema),
    sourceCallId: z.string().min(1).optional(),
  }),
```

In `packages/contracts/src/evidence.ts`, find:

```ts
    exitCode: z.number().int(),
    isDestructive: z.boolean(),
  }),
```

Replace it with:

```ts
    exitCode: z.number().int(),
    isDestructive: z.boolean(),
    sourceCallId: z.string().min(1).optional(),
  }),
```

- [ ] **Step 7: Add `agentCallIds`, `Decision.ts` and the Jev pass**

In `packages/contracts/src/semantic.ts`, find:

```ts
  evidence: z.array(z.string().min(1)),
  createdAt: z.string(),
  updatedAt: z.string(),
});
```

Replace it with:

```ts
  evidence: z.array(z.string().min(1)),
  // Agent call ids joined to this unit (sourceCallId of its facts, plus agent
  // file_changed claims). Sorted ascending; omitted when empty.
  agentCallIds: z.array(z.string().min(1)).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
```

In `packages/contracts/src/semantic.ts`, find:

```ts
  answer: StructuredDecisionSchema.optional(),
});
```

Replace it with:

```ts
  answer: StructuredDecisionSchema.optional(),
  // Source time of the latest status transition. Readers fall back to the row ts, then to seq.
  ts: z.string().optional(),
});
```

In `packages/contracts/src/jev.ts`, find:

```ts
export type JevClientKind = z.infer<typeof JevClientKindSchema>;
```

Replace it with:

```ts
export type JevClientKind = z.infer<typeof JevClientKindSchema>;

// Pass A = attention, pass B = projection (SPEC §3.3, §8.2).
export const JevPassSchema = z.enum(["A", "B"]);

export type JevPass = z.infer<typeof JevPassSchema>;
```

In `packages/contracts/src/jev.ts`, find:

```ts
  clamps: z.array(z.string()),
  ts: z.string(),
});
```

Replace it with:

```ts
  clamps: z.array(z.string()),
  pass: JevPassSchema.optional(),
  ts: z.string(),
});
```

- [ ] **Step 8: Run the contracts suite to verify it passes**

Run: `pnpm --filter @jevcode/contracts test && pnpm --filter @jevcode/contracts typecheck`
Expected: PASS, `Test Files  11 passed (11)` and `Tests  131 passed (131)`; the typecheck exits 0.

- [ ] **Step 9: Build contracts and watch the renderer's exhaustive switch fail**

Run: `pnpm --filter @jevcode/contracts build && pnpm --filter jevcode-desktop typecheck`
Expected: FAIL with `src/renderer/components/WorkspaceHost.tsx(108,53): error TS2366: Function lacks ending return statement and return type does not include 'undefined'.` `eventSummary` has no `default`, so each new variant has to be handled. No other switch in the repo is exhaustive over `NormalizedAgentEvent["type"]`: `ui-stage.ts:545`, `pipeline-runtime.ts:761` and `:1288`, and `codex-adapter.ts:569` all have `default` branches.

- [ ] **Step 10: Label the two new variants in WorkspaceHost**

In `apps/desktop/src/renderer/components/WorkspaceHost.tsx`, find:

```tsx
    case "agent_message":
      return event.role === "user" ? "Direction received" : event.text;
```

Replace it with:

```tsx
    case "agent_message":
      return event.role === "user" ? "Direction received" : event.text;
    case "agent_reasoning":
      return "Thinking";
```

In `apps/desktop/src/renderer/components/WorkspaceHost.tsx`, find:

```tsx
    case "agent_failed":
      return `Stopped: ${event.error}`;
  }
}
```

Replace it with:

```tsx
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

- [ ] **Step 11: Verify the desktop typecheck, stored-row rebuild and fixtures**

Run: `pnpm --filter jevcode-desktop typecheck`
Expected: exits 0 (all three `tsc` projects, including `tsconfig.web.json`).

Run: `pnpm --filter @jevcode/storage exec vitest run src/rebuild.test.ts`
Expected: PASS, `Tests  5 passed (5)`. Rows shaped before W0 still rebuild.

Run: `node scripts/validate-fixtures.mjs`
Expected: last lines `Checks: 149, passed: 149, failed: 0` and `VALIDATION PASSED`.

- [ ] **Step 12: Document the fields in SPEC §4.1–§4.3**

In `docs/SPEC.md`, find:

````
```ts
type NormalizedAgentEvent =
  | { type: "agent_started"; sessionId: string; prompt: string; ts: string }
  | { type: "agent_message"; sessionId: string; role: "assistant" | "user"; text: string; ts: string }
  | { type: "tool_started"; sessionId: string; tool: string; input: string; ts: string }
  | { type: "tool_completed"; sessionId: string; tool: string; output: string; ts: string }
  | { type: "command_started"; sessionId: string; command: string; ts: string }
  | { type: "command_completed"; sessionId: string; command: string; exitCode: number; stdout: string; stderr: string; ts: string }
  | { type: "file_read"; sessionId: string; path: string; ts: string }
  | { type: "file_changed"; sessionId: string; path: string; ts: string }            // claim; evidence engine confirms
  | { type: "approval_requested"; sessionId: string; command: string; rationale: string; ts: string }
  | { type: "test_started"; sessionId: string; command: string; ts: string }
  | { type: "test_completed"; sessionId: string; command: string; exitCode: number; ts: string }
  | { type: "agent_waiting"; sessionId: string; ts: string }
  | { type: "agent_completed"; sessionId: string; ts: string }
  | { type: "agent_failed"; sessionId: string; error: string; ts: string };
```
````

Replace it with:

````
```ts
// Every variant also carries turnId?: string   // optional; minted by the adapter once per agent process
type NormalizedAgentEvent =
  | { type: "agent_started"; sessionId: string; prompt: string; ts: string }
  | { type: "agent_message"; sessionId: string; role: "assistant" | "user"; text: string; ts: string }
  | { type: "agent_reasoning"; sessionId: string; callId?: string; text: string; ts: string }   // optional variant; model reasoning, never a message
  | { type: "tool_started"; sessionId: string; callId?: string; tool: string; input: string; ts: string }
  | { type: "tool_completed"; sessionId: string; callId?: string; tool: string; output: string; ts: string }
  | { type: "command_started"; sessionId: string; callId?: string; command: string; ts: string }
  | { type: "command_completed"; sessionId: string; callId?: string; command: string; exitCode: number; stdout: string; stderr: string; ts: string }
  | { type: "file_read"; sessionId: string; path: string; ts: string }
  | { type: "file_changed"; sessionId: string; callId?: string; path: string; ts: string }            // claim; evidence engine confirms
  | { type: "approval_requested"; sessionId: string; callId?: string; command: string; rationale: string; ts: string }
  | { type: "test_started"; sessionId: string; command: string; ts: string }
  | { type: "test_completed"; sessionId: string; command: string; exitCode: number; ts: string }
  | { type: "agent_waiting"; sessionId: string; ts: string }
  | { type: "agent_completed"; sessionId: string; ts: string }
  | { type: "agent_failed"; sessionId: string; error: string; ts: string }
  | { type: "agent_interrupted"; sessionId: string; reason: "interrupt" | "steer" | "stop"; ts: string };   // optional variant; the session pauses, never fails

// callId?: string   // optional; `${turnId}:${item.id}` for Codex, shared by a call's start and completion
```
````

In `docs/SPEC.md`, find:

```
type EvidenceFact =
  | { type: "git_hunk"; repoId: string; sessionId: string; file: string; added: number; removed: number;
      isFormattingOnly: boolean; isConfigOnly: boolean; isLockfile: boolean; ts: string }
```

Replace it with:

```
type EvidenceFact =
  | { type: "git_hunk"; repoId: string; sessionId: string; file: string; added: number; removed: number;
      isFormattingOnly: boolean; isConfigOnly: boolean; isLockfile: boolean;
      diff?: GitHunkDiff;                 // optional
      ts: string }
```

In `docs/SPEC.md`, find:

```
  | { type: "test_result"; repoId: string; sessionId: string; runner: string; command: string;
      passed: number; failed: number; skipped: number; failures: TestFailure[]; ts: string }
  | { type: "command_executed"; repoId: string; sessionId: string; command: string; exitCode: number;
      isDestructive: boolean; ts: string }
```

Replace it with:

```
  | { type: "test_result"; repoId: string; sessionId: string; runner: string; command: string;
      passed: number; failed: number; skipped: number; failures: TestFailure[];
      sourceCallId?: string;              // optional; callId of the agent command that produced it
      ts: string }
  | { type: "command_executed"; repoId: string; sessionId: string; command: string; exitCode: number;
      isDestructive: boolean;
      sourceCallId?: string;              // optional
      ts: string }
```

In `docs/SPEC.md`, find:

````
type TestFailure = { file: string; testName: string; message: string };
```
````

Replace it with:

````
type TestFailure = { file: string; testName: string; message: string };
type GitHunkDiff = {
  hash: string;                           // first 16 hex chars of sha256 over the raw diff (change key)
  bytes: number;                          // UTF-8 bytes of the raw diff
  text?: string;                          // redacted unified diff, capped at 32 KiB; absent when withheld
  truncated: boolean;                     // text was cut at the last "@@" hunk boundary
  redactions: number;
  withheld?: "secret_path" | "not_captured";
};
```
````

In `docs/SPEC.md`, find:

```
  evidence: string[];                     // evidence fact ids
  createdAt: string; updatedAt: string;
}
```

Replace it with:

```
  evidence: string[];                     // fact ids (fact_…), plus validation and semantic-event ids
  agentCallIds?: string[];                // optional; agent call ids joined to this unit, sorted
  createdAt: string; updatedAt: string;
}
```

In `docs/SPEC.md`, find:

```
  status: "open" | "answered" | "delegated" | "expired";
  answer?: StructuredDecision;
}
```

Replace it with:

```
  status: "open" | "answered" | "delegated" | "expired";
  answer?: StructuredDecision;
  ts?: string;                            // optional; source time of the latest status transition
}
```

- [ ] **Step 13: Run the root checks**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint`
Expected: exits 0 (for the known flaky suites, follow Gotcha 3). Contracts shows `Tests  131 passed (131)`; storage 49, desktop 119, evals 39 and every other package match the baseline.

- [ ] **Step 14: Commit**

```bash
git add packages/contracts/src/agent-events.ts packages/contracts/src/agent-events.test.ts packages/contracts/src/evidence.ts packages/contracts/src/evidence.test.ts packages/contracts/src/semantic.ts packages/contracts/src/semantic.test.ts packages/contracts/src/jev.ts packages/contracts/src/jev.test.ts apps/desktop/src/renderer/components/WorkspaceHost.tsx docs/SPEC.md
git commit -m "feat(contracts): add optional turn, call, diff and Jev pass fields"
```

### Task W0-5: Read-path contracts (`trace.ts`); `EVENT_TYPES` moves from storage; SPEC §4.5 and §15

**Files:**
- Create: `packages/contracts/src/trace.ts`
- Modify: `packages/contracts/src/index.ts:10`, `packages/storage/src/db.ts:10-17`, `:18-26`, `:51-70`, `docs/SPEC.md:322-324`, `:615` (line numbers at `144c7fb`; W0-1 and W0-4 moved them down, so match on the quoted text)
- Test: `packages/contracts/src/trace.test.ts`, `packages/storage/src/db.test.ts` (import at `:5-12`, appended `describe`)

**Interfaces:**
- Consumes: `AgentStateSchema` from `packages/contracts/src/agent.ts` (`z.enum(["starting", "running", "waiting_decision", "paused", "completed", "failed"])`).
- Produces (all exported from `@jevcode/contracts`):
  - `EVENT_TYPES` (the 14 envelope types, in storage order, `as const`), `type EventStoreType`, `EventStoreTypeSchema = z.enum(EVENT_TYPES)`.
  - `TRACE_ROW_TYPES = ["agent_event", "evidence_fact", "change_unit", "decision", "validation", "jev_decision"] as const`, `type TraceRowType`, `isTraceRowType(value: string): value is TraceRowType`.
  - Limits: `TRACE_CLIP_CHARS = 16_384`, `TRACE_LIST_SESSIONS_DEFAULT = 100`, `TRACE_LIST_SESSIONS_MAX = 500`, `TRACE_ROWS_PAGE_DEFAULT = 2_000`, `TRACE_ROWS_PAGE_MAX = 5_000`, `TRACE_PAYLOADS_MAX = 50`, `TRACE_LIVE_POLL_MS = 1_000`.
  - `TraceRowSchema` → `type TraceRow = { seq: number; type: string; ts: string; payload?: unknown; clipped?: boolean; factId?: string }`. `seq` is a positive int. `type` is any non-empty string, because a newer build may send a type this build does not know.
  - `TraceSessionSummarySchema` → `type TraceSessionSummary = { sessionId; repoId; repoName; prompt; state: AgentState; startedAt; endedAt: string | null; lastEventSeq: number }`.
  - `TraceRowsPageSchema` → `type TraceRowsPage = { rows: TraceRow[]; nextAfterSeq: number | null; lastSeq: number; state: AgentState }`.
  - `TRACE_BUNDLE_FORMAT = "jevcode.trace"`, `TRACE_BUNDLE_VERSION = 1`, `TraceBundleSchema` → `type TraceBundle = { format: "jevcode.trace"; version: 1; exportedAt: string; redactionCount: number; session: TraceSessionSummary; rows: TraceRow[] }`.
  - `@jevcode/storage` keeps exporting `EVENT_TYPES` and `type EventStoreType`, now as the same objects as contracts' (`packages/storage/src/index.ts` is unchanged).
  - Paging contract (A2 implements it; B and the UI rely on it): `rows({ sessionId, afterSeq = 0, limit = TRACE_ROWS_PAGE_DEFAULT })` returns, from one read transaction, the rows with `afterSeq < seq <= lastSeq` whose `type` is in `TRACE_ROW_TYPES`, ascending, at most `limit` of them. `nextAfterSeq` is the last row's seq when `rows.length === limit`, else `null`.

- [ ] **Step 1: Write the failing contracts test**

Create `packages/contracts/src/trace.test.ts` with this content:

```ts
import { describe, expect, it } from "vitest";

import {
  EVENT_TYPES,
  EventStoreTypeSchema,
  TRACE_BUNDLE_FORMAT,
  TRACE_BUNDLE_VERSION,
  TRACE_CLIP_CHARS,
  TRACE_LIST_SESSIONS_DEFAULT,
  TRACE_LIST_SESSIONS_MAX,
  TRACE_LIVE_POLL_MS,
  TRACE_PAYLOADS_MAX,
  TRACE_ROW_TYPES,
  TRACE_ROWS_PAGE_DEFAULT,
  TRACE_ROWS_PAGE_MAX,
  TraceBundleSchema,
  TraceRowSchema,
  TraceRowsPageSchema,
  TraceSessionSummarySchema,
  isTraceRowType,
} from "./trace.js";

const summary = {
  sessionId: "sess_1",
  repoId: "repo_1",
  repoName: "demo",
  prompt: "Add Google sign-in",
  state: "completed",
  startedAt: "2026-09-28T10:00:00.000Z",
  endedAt: "2026-09-28T10:20:00.000Z",
  lastEventSeq: 3,
};

const row = {
  seq: 1,
  type: "agent_event",
  ts: "2026-09-28T10:00:00.000Z",
  payload: { type: "agent_started", sessionId: "sess_1", prompt: "Add Google sign-in", ts: "2026-09-28T10:00:00.000Z" },
};

describe("trace read-path contracts", () => {
  it("lists the fourteen event-log envelope types in storage order", () => {
    expect(EVENT_TYPES).toEqual([
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
    ]);
    expect(EventStoreTypeSchema.safeParse("telemetry").success).toBe(true);
    expect(EventStoreTypeSchema.safeParse("future_row").success).toBe(false);
  });

  it("serves exactly the six envelope types the fold consumes", () => {
    expect(TRACE_ROW_TYPES).toEqual([
      "agent_event",
      "evidence_fact",
      "change_unit",
      "decision",
      "validation",
      "jev_decision",
    ]);
    expect(isTraceRowType("agent_event")).toBe(true);
    expect(isTraceRowType("telemetry")).toBe(false);
    expect(isTraceRowType("graph_node")).toBe(false);
  });

  it("pins the R5 limits", () => {
    expect(TRACE_CLIP_CHARS).toBe(16_384);
    expect(TRACE_LIST_SESSIONS_MAX).toBe(500);
    expect(TRACE_ROWS_PAGE_MAX).toBe(5_000);
    expect(TRACE_PAYLOADS_MAX).toBe(50);
    expect(TRACE_LIVE_POLL_MS).toBe(1_000);
    expect(TRACE_LIST_SESSIONS_DEFAULT).toBeLessThanOrEqual(TRACE_LIST_SESSIONS_MAX);
    expect(TRACE_ROWS_PAGE_DEFAULT).toBeLessThanOrEqual(TRACE_ROWS_PAGE_MAX);
  });

  it("accepts a row type from a newer build and keeps clipped and factId", () => {
    const future = { ...row, seq: 7, type: "future_row", clipped: true, factId: "fact_abc" };
    expect(TraceRowSchema.parse(future)).toEqual(future);
  });

  it("rejects a non-positive or fractional seq and an empty type", () => {
    expect(TraceRowSchema.safeParse({ ...row, seq: 0 }).success).toBe(false);
    expect(TraceRowSchema.safeParse({ ...row, seq: 1.5 }).success).toBe(false);
    expect(TraceRowSchema.safeParse({ ...row, type: "" }).success).toBe(false);
  });

  it("parses a session summary with a null endedAt and rejects an unknown state", () => {
    expect(TraceSessionSummarySchema.parse({ ...summary, state: "running", endedAt: null }).endedAt).toBeNull();
    expect(TraceSessionSummarySchema.safeParse({ ...summary, state: "stopped" }).success).toBe(false);
  });

  it("parses a last page (nextAfterSeq null) and a full page", () => {
    const last = { rows: [row], nextAfterSeq: null, lastSeq: 3, state: "running" };
    expect(TraceRowsPageSchema.parse(last)).toEqual(last);
    expect(TraceRowsPageSchema.parse({ ...last, nextAfterSeq: 1 }).nextAfterSeq).toBe(1);
  });

  it("accepts a v1 jevcode.trace bundle and rejects other versions and formats", () => {
    const bundle = {
      format: TRACE_BUNDLE_FORMAT,
      version: TRACE_BUNDLE_VERSION,
      exportedAt: "2026-09-28T11:00:00.000Z",
      redactionCount: 2,
      session: summary,
      rows: [row],
    };
    expect(TraceBundleSchema.parse(bundle)).toEqual(bundle);
    expect(TraceBundleSchema.safeParse({ ...bundle, version: 2 }).success).toBe(false);
    expect(TraceBundleSchema.safeParse({ ...bundle, format: "jevcode.replay" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @jevcode/contracts exec vitest run src/trace.test.ts`
Expected: FAIL with `Error: Cannot find module './trace.js' imported from '…/packages/contracts/src/trace.test.ts'`.

- [ ] **Step 3: Write `trace.ts`**

Create `packages/contracts/src/trace.ts` with this content:

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

- [ ] **Step 4: Export it from the barrel**

In `packages/contracts/src/index.ts`, find:

```ts
export * from "./semantic.js";
```

Replace it with:

```ts
export * from "./semantic.js";
export * from "./trace.js";
```

- [ ] **Step 5: Run the contracts tests to verify they pass, then build**

Run: `pnpm --filter @jevcode/contracts exec vitest run src/trace.test.ts src/browser-safety.test.ts`
Expected: PASS, `Tests  11 passed (11)`.

Run: `pnpm --filter @jevcode/contracts build && pnpm --filter @jevcode/contracts test`
Expected: PASS, `Test Files  12 passed (12)` and `Tests  139 passed (139)`.

- [ ] **Step 6: Write the failing storage identity test**

In `packages/storage/src/db.test.ts`, find:

```ts
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  LATEST_SCHEMA_VERSION,
  defaultDbPath,
  openDb,
} from "./index.js";
```

Replace it with:

```ts
import { EVENT_TYPES as CONTRACT_EVENT_TYPES } from "@jevcode/contracts";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  EVENT_TYPES,
  LATEST_SCHEMA_VERSION,
  defaultDbPath,
  openDb,
} from "./index.js";
```

Append to the end of `packages/storage/src/db.test.ts`:

```ts

describe("EVENT_TYPES", () => {
  it("re-exports the contracts list instead of keeping a copy", () => {
    expect(EVENT_TYPES).toBe(CONTRACT_EVENT_TYPES);
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm --filter @jevcode/storage exec vitest run src/db.test.ts`
Expected: FAIL, `Tests  1 failed | 8 passed (9)` with `AssertionError: expected [ 'agent_event', …(13) ] to be [ 'agent_event', …(13) ] // Object.is equality`. The lists are equal but are two different arrays. (If the message says `to be undefined`, contracts was not rebuilt; run `pnpm --filter @jevcode/contracts build`.)

- [ ] **Step 8: Re-export the contracts list from storage**

In `packages/storage/src/db.ts`, find:

```ts
import {
  ChangeUnitSchema,
  DecisionSchema,
  EvidenceFactSchema,
  JevDecisionLogSchema,
  NormalizedAgentEventSchema,
  ValidationResultSchema,
} from "@jevcode/contracts";
```

Replace it with:

```ts
import {
  ChangeUnitSchema,
  DecisionSchema,
  EVENT_TYPES,
  EvidenceFactSchema,
  JevDecisionLogSchema,
  NormalizedAgentEventSchema,
  ValidationResultSchema,
} from "@jevcode/contracts";
```

In `packages/storage/src/db.ts`, find:

```ts
import type {
  AgentState,
  ChangeUnit,
  Decision,
  EvidenceFact,
  JevDecisionLog,
  NormalizedAgentEvent,
  ValidationResult,
} from "@jevcode/contracts";
```

Replace it with:

```ts
import type {
  AgentState,
  ChangeUnit,
  Decision,
  EventStoreType,
  EvidenceFact,
  JevDecisionLog,
  NormalizedAgentEvent,
  ValidationResult,
} from "@jevcode/contracts";
```

In `packages/storage/src/db.ts`, find:

```ts
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from "./migrations.js";

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
```

Replace it with:

```ts
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from "./migrations.js";

// The envelope list lives in @jevcode/contracts (trace.ts) so browser code can read it.
export { EVENT_TYPES };
export type { EventStoreType };
```

`eventStoreSchemas … satisfies Record<EventStoreType, z.ZodTypeAny>`, `isEventStoreType` and `StoredEvent.type` keep compiling against the imported names. `packages/storage/src/index.ts` needs no change, because it re-exports both names from `./db.js`.

- [ ] **Step 9: Run the storage tests to verify they pass, then rebuild the dependents**

Run: `pnpm --filter @jevcode/storage exec vitest run src/db.test.ts && pnpm --filter @jevcode/storage typecheck`
Expected: PASS, `Tests  9 passed (9)`; the typecheck exits 0.

Run: `pnpm --filter "...@jevcode/contracts" build`
Expected: exits 0.

- [ ] **Step 10: Document the channels and the bundle in SPEC §4.5 and §15**

In `docs/SPEC.md`, find:

```
        terminal:input, terminal:resize, surface:pin, surface:dismiss,
        telemetry:flush
← renderer: repo:opened, session:state, agent:event, agent:state,
```

Replace it with:

```
        terminal:input, terminal:resize, surface:pin, surface:dismiss,
        telemetry:flush,
        trace:listSessions, trace:rows, trace:payloads (read-only; query_only reader; see the trace viewer design spec)
← renderer: repo:opened, session:state, agent:event, agent:state,
```

In `docs/SPEC.md`, find:

```
Replay runner: feeds `events.jsonl` through the real pipeline with Jev in `PlaybackMode` (deterministic stub returning labeled outputs) or `DegradeMode`. Used by M0 UI development, integration tests, and Jev evals.
```

Replace it with:

```
Replay runner: feeds `events.jsonl` through the real pipeline with Jev in `PlaybackMode` (deterministic stub returning labeled outputs) or `DegradeMode`. Used by M0 UI development, integration tests, and Jev evals.

`replay <fixtureDir> <outDir>` also writes `<outDir>/trace.json` (`TraceBundle`, format `jevcode.trace` v1). `replay export --db <path> --session <id> --out <file>` exports any stored session. Every string in a bundle passes `redactText` and the home directory becomes `~`.
```

(§15 describes the A2-5 and A2-6 behavior that these contracts exist for. Lane A2 implements it.)

- [ ] **Step 11: Run the root checks and the fixture validator**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint`
Expected: exits 0 (for the known flaky suites, follow Gotcha 3). Contracts shows `Tests  139 passed (139)` and storage shows `Tests  50 passed (50)`; every other package matches the W0-4 counts.

Run: `node scripts/validate-fixtures.mjs`
Expected: last lines `Checks: 149, passed: 149, failed: 0` and `VALIDATION PASSED`.

- [ ] **Step 12: Commit**

```bash
git add packages/contracts/src/trace.ts packages/contracts/src/trace.test.ts packages/contracts/src/index.ts packages/storage/src/db.ts packages/storage/src/db.test.ts docs/SPEC.md
git commit -m "feat(contracts): add trace read-path schemas and move EVENT_TYPES from storage"
```

### Task W0-6: Model types, stable-id helpers, `TraceSource`, `cursorAfter`; final dev-host placeholder

**Files:**
- Create: `packages/trace-viewer/src/model/types.ts`, `packages/trace-viewer/src/source.ts`
- Modify: `packages/trace-viewer/src/index.ts` (whole file), `packages/trace-viewer/src/model/index.ts` (whole file), `apps/trace-viewer-dev/src/main.tsx` (whole file)
- Test: `packages/trace-viewer/src/model/types.test.ts`, `packages/trace-viewer/src/source.test.ts`, plus the dev-host typecheck and build

**Interfaces:**
- Consumes: from W0-4, `AgentInterruptReason`, `JevPass`; from W0-5, `EventStoreType`, `TraceRow`, `TraceRowsPage`, `TraceSessionSummary`. Existing: `ChangeCategory`, `ChangeUnitStatus`, `Decision`, `DependencyChange`, `JevClientKind`, `SchemaChange` (all `import type` from `@jevcode/contracts`); `zod` 3.
- Produces:
  - `@jevcode/trace-viewer/model` (barrel `export * from "./types.js";`; each lane-B task appends one line): `TRACE_SCHEMA_VERSION = 1 as const`; stable-id types `StepId`, `UnitStableId`, `DecisionStableId`, `FileStableId`, `FindingId`, `StableId`; `STABLE_ID_KINDS`, `StableIdKind`, `StableIdSchema`, `ParsedStableId`; `stepStableId(firstSeq: number): StepId`, `unitStableId(changeUnitId: string): UnitStableId`, `decisionStableId(decisionId: string): DecisionStableId`, `fileStableId(path: string): FileStableId`, `findingStableId(ruleId: SignalId, ruleVersion: number, anchorSeq: number): FindingId`, `parseStableId(value: string): ParsedStableId | null`; the vocabulary `LANES`/`Lane`, `LEVELS`/`Level`, `Actor`, `Provenance`, `STEP_KINDS`/`StepKind`, `StepStatus`, `PROBLEM_KINDS`/`ProblemKind`, `NOISE_REASONS`/`NoiseReason`, `TurnTrigger`, `TurnOutcome`, `Severity`, `SIGNAL_IDS`/`SignalId`, `CAPABILITIES`/`Capability`, `GAP_KINDS`/`GapKind`; the details `TestCounts`, `TestFailureSummary`, `CommandDetail`, `TestDetail`, `DiffState`, `EditDetail`, `DecisionDetail`, `GuardrailDetail`; the fold output `Step`, `Turn`, `EvidenceLinks`, `Chapter`, `Entity`, `ClaimObservation`, `Finding`, `Gap`, `SignalMeta`, `SignalCoverage`, `Coverage`, `Hidden`, `TraceSession`; and `GraphicSpec`. Shapes are exactly as in the file below (index section 2.3, which already carries Interface deviation 1). The file declares the fields decision record R25 requires for the UI (`Step.startMs`, `Turn.planStepId?`, `Turn.claimStepId?`, `Chapter.current`, `Chapter.noise`, `Chapter.validationStepIds`, `Finding.anchorStepId`, `Finding.claimStepId?`, `Finding.evidenceStepIds?`, `Finding.claimSpan?`, `DecisionDetail.answerSeq?`) and the UI index §1.2(a) additions (`LEVELS`/`Level`, `CommandDetail.outputTail?`, `Chapter.triad.clientKind?`, `TraceSession.originMs`, and the `diff`, `duration`, `table` and `claim` members of `GraphicSpec`), because the UI lanes C1a and C1b build on W0's types in W1 beside lane B; lane B (B-3, B-5, B-7, B-10, B-12) derives them. Nothing in W0 constructs these objects, so the additions need no W0 test beyond `LEVELS`.
  - `@jevcode/trace-viewer` (barrel `export * from "./source.js";`; the UI waves append UI exports): `interface TraceRowsRequest { afterSeq?: number; limit?: number }`, `interface TraceSource { readonly sessionId: string; summary(): Promise<TraceSessionSummary>; rows(request?: TraceRowsRequest): Promise<TraceRowsPage>; payloads(seqs: readonly number[]): Promise<TraceRow[]>; now(): number }` (the session-bound port of spec §7.7 and UI index §1.2(b)), `function cursorAfter(page: TraceRowsPage): number` (`page.nextAfterSeq ?? page.lastSeq`). There is no `TraceListSessionsRequest` or `TracePayloadsRequest`: listing sessions is the host's job, and `apps/desktop` adapts `window.jevcode.trace` with `createIpcTraceSource(bridge.trace, sessionId)` in M5.
  - Icons are not part of the model. The UI lane defines `KIND_ICON` with `satisfies Record<StepKind, IconName>` in `src/ui`.

- [ ] **Step 1: Write the failing stable-id and vocabulary tests**

Create `packages/trace-viewer/src/model/types.test.ts` with this content:

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  LANES,
  LEVELS,
  STABLE_ID_KINDS,
  StableIdSchema,
  decisionStableId,
  fileStableId,
  findingStableId,
  parseStableId,
  stepStableId,
  unitStableId,
} from "./types.js";

describe("stable ids (R9)", () => {
  it("formats step ids from the first seq and rejects non-positive or fractional seqs", () => {
    expect(stepStableId(12)).toBe("step:12");
    expect(() => stepStableId(0)).toThrow(RangeError);
    expect(() => stepStableId(1.5)).toThrow(RangeError);
  });

  it("keeps fixture decision ids with hyphens", () => {
    expect(decisionStableId("dec-oauth-0001")).toBe("decision:dec-oauth-0001");
  });

  it("treats everything after the first colon as an opaque key", () => {
    const id = fileStableId("src/a:b.ts");
    expect(id).toBe("file:src/a:b.ts");
    expect(parseStableId(id)).toEqual({ kind: "file", key: "src/a:b.ts" });
  });

  it("formats finding ids as ruleId@version:anchorSeq", () => {
    expect(findingStableId("claim_contradicted", 1, 48)).toBe("finding:claim_contradicted@1:48");
    expect(() => findingStableId("claim_contradicted", 0, 48)).toThrow(RangeError);
  });

  it("rejects empty keys when building ids", () => {
    expect(() => unitStableId("")).toThrow(RangeError);
    expect(() => fileStableId("")).toThrow(RangeError);
  });

  it("returns null for strings that are not stable ids", () => {
    expect(parseStableId("step:0")).toBeNull();
    expect(parseStableId("step:x")).toBeNull();
    expect(parseStableId("chapter:1")).toBeNull();
    expect(parseStableId("unit:")).toBeNull();
    expect(StableIdSchema.safeParse("unit:").success).toBe(false);
  });

  it("round-trips a path with a line break", () => {
    // POSIX file names may contain "\n"; the id must still resolve.
    expect(parseStableId(fileStableId("docs/odd\nname.md"))).toEqual({ kind: "file", key: "docs/odd\nname.md" });
  });

  it("round-trips any non-empty key", () => {
    const builders = { unit: unitStableId, decision: decisionStableId, file: fileStableId } as const;
    const kinds = fc.constantFrom<keyof typeof builders>("unit", "decision", "file");
    // unit "binary" draws any code point, including line terminators and lone surrogates.
    fc.assert(
      fc.property(kinds, fc.string({ minLength: 1, unit: "binary" }), (kind, key) => {
        expect(parseStableId(builders[kind](key))).toEqual({ kind, key });
      }),
    );
    expect(parseStableId(stepStableId(7))).toEqual({ kind: "step", key: "7" });
  });

  it("names every kind the parser accepts", () => {
    expect(STABLE_ID_KINDS).toEqual(["step", "unit", "decision", "file", "finding"]);
  });
});

describe("vocabulary", () => {
  it("orders the Hybrid lanes top to bottom (R14)", () => {
    expect(LANES).toEqual(["supervisor", "agent", "commands", "edits", "tests", "jev"]);
  });

  it("orders the semantic zoom levels from coarse to fine (R20)", () => {
    expect(LEVELS).toEqual(["session", "chapter", "step"]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/model/types.test.ts`
Expected: FAIL with `Error: Cannot find module './types.js' imported from '…/packages/trace-viewer/src/model/types.test.ts'`.

- [ ] **Step 3: Write the model types**

Create `packages/trace-viewer/src/model/types.ts` with this content:

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

This is the index's section 2.3 file, byte for byte. The `StableIdSchema` regex ends in `/s` (Interface deviation 1); without the flag, "round-trips a path with a line break" fails and the property reports `Counterexample: ["unit","\n"]`. The UI index (§1.2(a)) adds `LEVELS`/`Level`, `CommandDetail.outputTail`, `Chapter.triad.clientKind`, `TraceSession.originMs` and the `diff`, `duration`, `table` and `claim` shapes of `GraphicSpec`; lane B derives them (index section 2.6).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/model/types.test.ts`
Expected: PASS, `Tests  11 passed (11)`.

- [ ] **Step 5: Write the failing `TraceSource` test**

Create `packages/trace-viewer/src/source.test.ts` with this content:

```ts
import type { TraceRow, TraceRowsPage, TraceSessionSummary } from "@jevcode/contracts";
import { describe, expect, it } from "vitest";

import { cursorAfter, type TraceRowsRequest, type TraceSource } from "./source.js";

const TS = "2026-09-28T10:00:00.000Z";
const T0 = Date.parse(TS);

function agentRow(seq: number): TraceRow {
  return { seq, type: "agent_event", ts: TS, payload: { type: "agent_waiting", sessionId: "sess_1", ts: TS } };
}

// In-memory source bound to one session. rows() follows the paging contract: rows with
// afterSeq < seq <= lastSeq whose type is served (telemetry is filtered out), ascending, at most
// `limit`; nextAfterSeq is the last row's seq only when the page is full.
function fakeSource(log: TraceRow[]): TraceSource {
  const summary: TraceSessionSummary = {
    sessionId: "sess_1",
    repoId: "repo_1",
    repoName: "demo",
    prompt: "p",
    state: "running",
    startedAt: TS,
    endedAt: null,
    lastEventSeq: 0,
  };
  return {
    sessionId: "sess_1",
    summary: async () => ({ ...summary, lastEventSeq: log.length }),
    rows: async ({ afterSeq = 0, limit = 2 }: TraceRowsRequest = {}): Promise<TraceRowsPage> => {
      const lastSeq = log.length;
      const rows = log
        .filter((row) => row.seq > afterSeq && row.seq <= lastSeq && row.type !== "telemetry")
        .slice(0, limit);
      const last = rows[rows.length - 1];
      return {
        rows,
        nextAfterSeq: rows.length === limit && last !== undefined ? last.seq : null,
        lastSeq,
        state: "running",
      };
    },
    payloads: async (seqs) => log.filter((row) => seqs.includes(row.seq)),
    now: () => T0 + 4_000,
  };
}

async function readAll(source: TraceSource, afterSeq: number): Promise<{ seqs: number[]; cursor: number }> {
  const seqs: number[] = [];
  let cursor = afterSeq;
  for (;;) {
    const page = await source.rows({ afterSeq: cursor, limit: 2 });
    seqs.push(...page.rows.map((row) => row.seq));
    cursor = cursorAfter(page);
    if (page.nextAfterSeq === null) return { seqs, cursor };
  }
}

describe("cursorAfter", () => {
  it("continues from nextAfterSeq while pages are full", () => {
    expect(cursorAfter({ rows: [agentRow(1), agentRow(2)], nextAfterSeq: 2, lastSeq: 9, state: "running" })).toBe(2);
  });

  it("jumps to lastSeq on the last page, past rows the source filtered out", () => {
    expect(cursorAfter({ rows: [agentRow(4)], nextAfterSeq: null, lastSeq: 5, state: "running" })).toBe(5);
  });

  it("drives a reader that sees every served seq exactly once, then only new rows", async () => {
    const log = [agentRow(1), agentRow(2), agentRow(3), agentRow(4), { ...agentRow(5), type: "telemetry" }];
    const source = fakeSource(log);

    const first = await readAll(source, 0);
    expect(first.seqs).toEqual([1, 2, 3, 4]);
    expect(first.cursor).toBe(5);

    log.push(agentRow(6));
    const next = await readAll(source, first.cursor);
    expect(next.seqs).toEqual([6]);
    expect(next.cursor).toBe(6);
  });

  it("lets a host object bound to one session stand in as a TraceSource", async () => {
    const source = fakeSource([agentRow(1)]);
    expect(source.sessionId).toBe("sess_1");
    expect((await source.summary()).lastEventSeq).toBe(1);
    expect((await source.rows()).rows.map((row) => row.seq)).toEqual([1]);
    expect((await source.payloads([1, 99])).map((row) => row.seq)).toEqual([1]);
    expect(source.now() - T0).toBe(4_000);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/source.test.ts`
Expected: FAIL with `Error: Cannot find module './source.js' imported from '…/packages/trace-viewer/src/source.test.ts'`.

- [ ] **Step 7: Write the port**

Create `packages/trace-viewer/src/source.ts` with this content:

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

The port is bound to one session (spec §7.7 and §8.3). The viewer needs `summary()` for the title while rows load and `now()` for the live clock (`liveTMs = max(last step tMs, source.now() − originMs)`). `rows()` takes no session id, so the Review Focus 5 reader calls `rows({ afterSeq, limit })`.

- [ ] **Step 8: Fill both barrels**

Replace the entire contents of `packages/trace-viewer/src/index.ts` (currently `export {};`) with:

```ts
export * from "./source.js";
```

Replace the entire contents of `packages/trace-viewer/src/model/index.ts` (currently `export {};`) with:

```ts
export * from "./types.js";
```

- [ ] **Step 9: Run the package checks to verify they pass**

Run: `pnpm --filter @jevcode/trace-viewer test`
Expected: PASS, `Test Files  3 passed (3)` and `Tests  33 passed (33)`.

Run: `pnpm --filter @jevcode/trace-viewer typecheck && pnpm lint`
Expected: exits 0. `src/model/types.ts` imports only `zod` and `@jevcode/contracts`, so the model bans stay quiet.

- [ ] **Step 10: Point the dev host at both barrels and see the stale-dist failure**

Replace the entire contents of `apps/trace-viewer-dev/src/main.tsx` with:

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

Run: `pnpm --filter jevcode-trace-viewer-dev typecheck`
Expected: FAIL with `src/main.tsx(5,10): error TS2305: Module '"@jevcode/trace-viewer/model"' has no exported member 'TRACE_SCHEMA_VERSION'.` The dev host reads `@jevcode/trace-viewer/dist`, which still holds W0-1's empty barrel (Gotcha 1).

- [ ] **Step 11: Build the package and verify the dev host typechecks and bundles**

Run: `pnpm --filter @jevcode/trace-viewer build && pnpm --filter jevcode-trace-viewer-dev typecheck && pnpm --filter jevcode-trace-viewer-dev build`
Expected: PASS. The build prints `copy-assets: 0 css file(s)`, the typecheck exits 0, and `vite build` ends `✓ built in …` with no `browser bundle imports` error. The model barrel, zod and the contracts barrel are all in the browser graph now.

- [ ] **Step 12: Run the root checks**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint`
Expected: exits 0 (for the known flaky suites, follow Gotcha 3). The `Tests` lines read 139 (contracts), 68 (agent-core), 169 (evidence-engine), 77 (semantic-core), 50 (storage), 22 (telemetry), 89 (ui-catalog), 108 (ui-compiler), 44 (agent-codex), 213 (jev-router), 33 (trace-viewer), 119 (desktop), 39 (evals).

Run: `node scripts/validate-fixtures.mjs`
Expected: last lines `Checks: 149, passed: 149, failed: 0` and `VALIDATION PASSED`.

- [ ] **Step 13: Commit**

```bash
git add packages/trace-viewer/src/model/types.ts packages/trace-viewer/src/model/types.test.ts packages/trace-viewer/src/source.ts packages/trace-viewer/src/source.test.ts packages/trace-viewer/src/index.ts packages/trace-viewer/src/model/index.ts apps/trace-viewer-dev/src/main.tsx
git commit -m "feat(trace-viewer): add model types, stable ids and TraceSource"
```

---

## Lane completion

- [ ] **Step 1: Verify the branch from a clean tree**

Run: `git status --short && git log --oneline main..HEAD`
Expected: `git status` prints nothing. The log lists exactly six commits, newest first:

```
feat(trace-viewer): add model types, stable ids and TraceSource
feat(contracts): add trace read-path schemas and move EVENT_TYPES from storage
feat(contracts): add optional turn, call, diff and Jev pass fields
feat(contracts): add canonicalJson
refactor(contracts): keep the barrel browser-safe and move symbolId to contracts/node
feat(trace-viewer): scaffold package, dev host, dependencies and lint boundaries
```

(Each line starts with a short hash.)

Run: `git log main..HEAD --format=%B | grep -c "Claude-Session" || true`
Expected: `0`.

- [ ] **Step 2: Hand off**

Finish with superpowers:finishing-a-development-branch. The orchestrator merges `tv/w0-contracts-foundation` into `main` before it creates any W1 worktree (A1, A2, B). The hand-off message names four things: Interface deviations 1–5 (so lanes A2 and B copy the corrected `StableIdSchema` and the setup recipe, and the UI lanes know `@jevcode/trace-viewer` has no `@xyflow/react`), the UI index §1.1–§1.2 items W0 now carries (the d3 fallback dependencies, the `./sources` and `./components/*` exports, `assetsInlineLimit: 0`, the `src/layout` ESLint block, the virtual-core check result, the model additions and the session-bound `TraceSource`), the flaky pre-existing suites, and whether the design spec is committed on `main` (Lane prerequisites, "Plan documents").
