# Console-first workspace, Brief and codebase explainer — implementation plan (index)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each lane part runs in its own git worktree under one controller; see §6.

**Goal:** Make the main window open on a terminal-style Console, offer Hybrid, Canvas, a new codebase Map and the existing Surfaces as switchable views with a Brief panel in every view, and generate grounded, near-live explanations of the codebase and the session.

**Architecture:** Everything the person sees is a view of `@jevcode/trace-viewer`, embedded in the main window and fed by one read path (`trace:rows`), with push hints for near-live updates. A new explainer stage in the desktop pipeline turns a repo scan and session events into `overview_snapshot` and `explainer` rows. Rule-based builders produce the structure, and a small model writes cited, guarded captions. The viewer stays model-free and IPC-free.

**Tech Stack:** TypeScript, pnpm workspaces, Electron 33, React 19.2, Vite, zod 3, better-sqlite3, tree-sitter (web-tree-sitter wasm), vitest and fast-check, Claude Haiku 4.5 through Jev's TypeSafe client.

**Spec:** `docs/superpowers/specs/2026-10-02-console-and-explainer-design.md` (the spec). **Interfaces (binding):** `docs/superpowers/plans/2026-10-02-console-explainer-interfaces.md`. **Context:** `docs/superpowers/specs/2026-09-28-trace-viewer-design.md` (the viewer spec).

## Global Constraints

- **Visual system:** light theme only, using the viewer's `--tv-*` tokens. Color is for state only (red only for real problems: failed tests, agent failures, critical findings). No decorative borders. Icons and mini graphics are preferred over text (spec E6, §3.6; viewer spec §7.12).
- **Untrusted text:**
  - Every agent string, narrator string, path, component name and README text renders through `displayUntrusted`, with the full text in the tooltip and accessible name.
  - There is no Markdown and no `dangerouslySetInnerHTML`, except the existing diff2html in CodeDiff.
  - Agent and narrator text never appears in title, chip, badge or finding-title slots (viewer spec §16 untrusted row).
- **Viewer purity:**
  - `packages/trace-viewer` never imports Electron, Node built-ins or networking, and never touches `window.jevcode`.
  - `src/model` and `src/layout` stay React-free and clock-free.
  - The existing ESLint boundaries and `lint-boundaries.test.ts` stay green (spec §4.3).
  - `packages/codebase-map/src/core/**` has no Node built-ins.
- **Narrator:**
  - Model `claude-haiku-4-5-20251001` through `@anthropic-ai/sdk` with `ANTHROPIC_API_KEY`. No key means zero calls and narrator state `unavailable`.
  - 10 s timeout, schema-validated output.
  - Every sentence cites something that resolves. Batches are discarded when more than half their sentences are dropped. Plain text only: purpose ≤ 140 characters, sentences ≤ 220.
  - Inputs never include whole files; README paragraphs are redacted and clipped to 600 characters (spec §6.2, §6.3).
  - Off when `explainWithModel` is false (spec E10, E15).
- **Caps:** at most 200 components, 1,000 component edges, 120 externals, 512 KB per snapshot row. Scans stop at 20,000 files and skip files over 1 MiB. Components split above 150 files (spec §5).
- **Budgets:**
  - Console append p95 ≤ 150 ms; Console scroll ≤ 5% dropped frames at 10k steps.
  - Rule-based map ≤ 2 s for 5k files; scan ≤ 20 s for 20k files.
  - Narrator first purposes ≤ 30 s for ≤ 200 components.
  - `layoutMap`: fresh ≤ 8 ms, sticky ≤ 2 ms.
  - Ingest soak ratio ≤ 1.10 (spec §11).
- **Commits:**
  - Identity `Jongwon Park <contact@parkjongwon.com>`; pass `-c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com` if the worktree config differs.
  - **No `Claude-Session:` and no `Co-Authored-By` trailers.**
  - Never `git stash`, `git reset --hard` or `git clean`.
- **Native modules:** never run `pnpm --filter jevcode-desktop rebuild` (the pnpm builtin wipes node-pty). Use `run rebuild` for the Electron ABI and `run rebuild:node` for the Node ABI, then restore node-pty `build/Release/pty.node` and `spawn-helper` from `prebuilds/<platform-arch>/` if they are missing. Leave worktrees on the Node ABI.
- **Hang safety:**
  - No foreground command may run longer than about 3 minutes. Wrap vitest as `perl -e 'alarm 150; exec @ARGV' pnpm exec vitest run <file>`.
  - Builds, servers, Chrome, Electron and soaks run in the background with hard timeouts.
  - Kill every process you start. Fake timers use `advanceTimersByTime`.
- **Shell:** zsh. Write `${var}:suffix` when a colon follows a variable.

## Review Focus

These failure modes are implied by the spec but no feature test covers them by default. Each has an owning test, named in brackets.

1. **A repo in an unsupported language, or a huge or partial repo.** The Map must show components with a quiet "imports not analyzed" note, or a "partial" flag with counts, never an empty or broken view. [lane 04 M-5 fixture tests: a Python repo and a 25k-file generated repo; lane 06 P-3 component tests for both notes]
2. **Narrator output that is hostile, wrong or uncited.** That covers prompt injection from README text, citations of components that don't exist, Markdown and URLs. The result must be rule-based labels and no action, rendered as plain text. [lane 05 N-1 guardrail table tests including injection strings; lane 06 P-3 hostile-purpose U+202E render test]
3. **Live append while the reader is scrolled back in the Console.** The view must not jump, steal focus or move the selected row; an "N new" pill appears instead. [lane 02 V-4 test]
4. **Switching sessions in the main window while live.** The old controller must stop (no stale rows), the new session opens on Console, and the prompt draft follows the D-5 per-session rules. [lane 03 D-2 test]
5. **Narrator off or offline.** Every view and the Brief must work from rule-based data, with a quiet "descriptions pending" or "off" note and no error banners or retry storms. [lane 05 N-3 backoff test; lane 06 P-4 Brief test with `narrative: null`]

---

## 1. Lane parts

| Lane | File | Tasks | Wave | Worktree / branch |
|---|---|---|---|---|
| 01 Contracts and storage | `…-01-contracts-storage.md` | K-1 to K-4 | W0 | `jevcode-ce-01` / `ce/01-contracts` |
| 02a Viewer API | `…-02-viewer-console.md` Part A | V-1, V-2 | W0 | `jevcode-ce-02a` / `ce/02a-viewer-api` |
| 02b Console and Brief | `…-02-viewer-console.md` Part B | V-0, V-3 to V-6 | W1 | `jevcode-ce-02b` / `ce/02b-console` |
| 03 Desktop workspace | `…-03-desktop-workspace.md` | D-1 to D-6 | W1 | `jevcode-ce-03` / `ce/03-desktop` |
| 04 Codebase map | `…-04-codebase-map.md` | M-1 to M-8 | W1 | `jevcode-ce-04` / `ce/04-map` |
| 05 Narrator | `…-05-narrator.md` | N-1 to N-5 | W1 | `jevcode-ce-05` / `ce/05-narrator` |
| 06 Viewer map | `…-06-viewer-map.md` | P-0 to P-5 | W1 | `jevcode-ce-06` / `ce/06-viewer-map` |
| 07 Session explainer | `…-07-session-explainer.md` | S-0 to S-6 | W2 | `jevcode-ce-07` / `ce/07-session` |

Worktrees live under `/Users/jwpark/Projects/`. Execution order inside a lane follows its file, not the id order: lane 03 runs D-1, D-2, D-5, D-4, D-3, D-6; lane 07 runs S-0, S-1, S-3, S-2, S-4, S-5, S-6. Cross-lane names and the orchestrator rulings R1–R6 are in interfaces §8, which wins over every lane file. File names are prefixed with `docs/superpowers/plans/2026-10-02-console-explainer`.

## 2. Waves and merge order

| Wave | Lanes (merge order) | Starts from |
|---|---|---|
| W0 | 01, 02a | `main` |
| W1 | 04, 05, 02b, 03, 06 | `<w0>`, the W0 merge |
| W2 | 07 | `<w1>`, the W1 merge |

Merge order constraints inside W1:

- **04 merges before 05.** Lane 05's N-5 wires narration into lane 04's stage. N-5 runs after rebasing on 04.
- **02b merges before 03.** Lane 03's D-6 smoke asserts the Console.
- **02b merges before 06.** Lane 06's P-4 extends `buildBrief` from V-5.

Lanes 05, 03 and 06 rebase before their dependent task (N-5, D-6, P-4). Every other task in those lanes is independent and starts at W1 start.

**Human gates** (§8) block UI tasks only:

| Gate | Blocks |
|---|---|
| H1 | V-4, V-5, D-3, D-4 |
| H2 | P-3, P-4 |
| H3 | S-4, S-5 |

Pure and backend tasks never wait.

## 3. Task dependency graph

| Task | Title | Depends on |
|---|---|---|
| K-1 | Event types `overview_snapshot` and `explainer`; bundle v2 parser | — |
| K-2 | Overview and explainer zod schemas (`src/overview.ts`) | K-1 |
| K-3 | IPC `trace:rowsAvailable`, `overview:rescan`, preference `explainWithModel` | K-1 |
| K-4 | Storage: schemas in `eventStoreSchemas`, migration v5, cache and state methods, TraceReader and export | K-2 |
| V-1 | `TraceSource.onRowsAvailable` and controller push hint | K-3 (merged W0) |
| V-2 | View kinds, registry with Console and Map slots, `chrome`, `hostViews`, `initialView`, view keys | — |
| V-0 | Mockups: main window on Console, Brief v0 (HUMAN H1) | — |
| V-3 | `buildConsoleRows` (pure) | V-2 |
| V-4 | `ConsoleView` | V-3, H1 |
| V-5 | `buildBrief` and the `Brief` panel | V-2, H1 |
| V-6 | Console perf harness and dev-host wiring | V-4 |
| D-1 | Main: coalesced `trace:rowsAvailable` emitter; preload; IPC source hook | K-3 |
| D-2 | `EmbeddedWorkspace` and `mainHost` replacing the session view | V-2 (W0) |
| D-3 | `PromptDock`, Surfaces view, context rail moved into the Brief | D-2, H1 |
| D-4 | Light restyle of the main window onto `--tv-*` | H1 |
| D-5 | Separate the user shell from the agent log | — |
| D-6 | Electron smoke for the main window, append latency, screenshots | D-1..D-5, 02b merged |
| M-1 | `@jevcode/codebase-map`: `componentize`, ids, content hash | — |
| M-2 | Edges, externals, role guess | M-1 |
| M-3 | `assembleSnapshot` with caps | M-2, K-2 |
| M-4 | evidence-engine `extractImports` and `resolveSpecifier` | — |
| M-5 | `scanRepo` (git ls-files, skips, caps, manifests, tsconfig) with fixture repos | M-1, M-4 |
| M-6 | Explainer stage: scan scheduling, snapshot rows, `overview_state`, push, rescan, progress, failure | M-3, M-5, K-4, D-1 interface |
| M-7 | ArchitectureDelta edge-id fix (in desktop `ui-stage.ts`) | — |
| M-8 | Scan bench and ingest soak guard | M-6 |
| N-1 | Narrator types and guardrails (pure) | K-2 |
| N-2 | `createNarratorClient` prompts and schemas, fake client, recorded tests | N-1 |
| N-3 | `explainer-narration.ts`: batching, cache, narrative hash, backoff, logging | N-2, K-4 |
| N-4 | `explainWithModel` setting and Inspect log entries | K-3 |
| N-5 | Wire narration into the stage (after rebasing on 04) | N-3, 04 merged |
| P-0 | Mockups: Map and Brief architecture card (HUMAN H2) | — |
| P-1 | Fold `overview_snapshot` into `TraceSession.overview` (incremental equals fresh) | K-2 |
| P-2 | `layoutMap` (pure, sticky) with properties and bench | P-1 |
| P-3 | `MapView` and component Inspector | P-2, H2 |
| P-4 | Brief architecture card (after rebasing on 02b) | P-1, 02b merged, H2 |
| P-5 | Dev-host overview fixture and screenshots | P-3 |
| S-0 | Mockups: story, decision cards, Map overlay, Console summary (HUMAN H3) | — |
| S-1 | Narrator `sessionStory` and `decisionWhy` | N-2 |
| S-2 | Stage `onPipelineSync`: triggers, debounce, highlights, rows | M-6, N-5 |
| S-3 | Fold explainer rows into `TraceSession.explainer` (consumes P-1's `componentIdForPath`) | P-1 |
| S-4 | Brief story and decision cards; Console summary rows | S-3, H3 |
| S-5 | Map session overlay | S-3, P-3, H3 |
| S-6 | Live mock-session smoke and phase C budgets | S-2..S-5 |

## 4. Pre-flight (once, before W0)

```bash
cd /Users/jwpark/Projects/jevcode
git status --short                       # expect empty
git log --oneline -1                     # record as <w-1>
pnpm install --frozen-lockfile && pnpm -r build
```

Copy the orchestration helpers (they already exist):
- `.superpowers/orchestration/setup-worktree.sh`: install, native restore and build.
- `root-checks.sh`: per-package root checks, logged to `<wt>/.superpowers/root-checks.log`.
- `prep-lane.sh`: task briefs and lane context.
- `wave-verify.sh`: the merge-procedure step 8 check.

## 5. Worktrees

For each lane in a wave, from `<base>` (`main` for W0, `<w0>` for W1, `<w1>` for W2):

```bash
git -C /Users/jwpark/Projects/jevcode worktree add -b ce/<lane-branch> /Users/jwpark/Projects/jevcode-ce-<id> <base>
bash /Users/jwpark/Projects/jevcode/.superpowers/orchestration/setup-worktree.sh /Users/jwpark/Projects/jevcode-ce-<id>
bash /Users/jwpark/Projects/jevcode/.superpowers/orchestration/prep-lane.sh \
  /Users/jwpark/Projects/jevcode-ce-<id>/docs/superpowers/plans/2026-10-02-console-explainer-<lane-file>.md \
  /Users/jwpark/Projects/jevcode-ce-<id> <task ids…>
```

Append to each lane's `lane-context.md`:
- `rulings-common.md`
- `lessons-w2.md`
- this plan's interfaces file path, with "binding" stated next to it

`prep-lane.sh` swallows `###` sections that follow a task, so after running it, check that the lane's hand-off sections are present.

## 6. Execution: one controller per lane part

- **Per task:** one implementer, then one task reviewer, then fix rounds until approved.
- **Models:**
  - Sonnet implementers, and opus for UI-heavy or model-core tasks: V-4, V-5, P-3, M-6, N-3, S-2, S-4, S-5.
  - Sonnet task reviewers.
  - An opus lane review at the end of each lane part.
- **Implementer prompts must include:**
  - the brief path, `lane-context.md`, the interfaces file, the spec sections cited
  - the hang-safety rule and the no-trailers rule
  - "never `git stash`"
  - "UI changes verified with headless screenshots compared to the approved mockups"
- **Review fixes:** minor findings may be folded into the next task's pre-step. Important findings get a fix round before the next task.
- **Rulings:** record every ruling in the lane `progress.md` and in `lane-context.md`.

## 7. Merge procedure

For each lane part, in wave order:

1. `git -C <wt> status --short` is empty, and `git -C <wt> log main..HEAD --format=%B | grep -c -E "Claude-Session|Co-Authored-By"` prints `0`.
2. `git -C <wt> rebase main`. Resolve conflicts only in this lane's files, and keep both sides in shared docs.
3. `/Users/jwpark/Projects/jevcode/.superpowers/orchestration/root-checks.sh <wt>` must print `ROOT_CHECKS_DONE fail=0`. The known flake (`stall-watchdog.test.ts`, `codex-adapter.test.ts`, `file-watcher.test.ts`) is accepted only if that package passes alone.
4. The lane part's "Done" items (§9) all hold.
5. `git -C /Users/jwpark/Projects/jevcode merge --no-ff ce/<branch> -m "Merge <lane>: <title>"`.
6. Record `merged <lane> at <sha>` in `.superpowers/sdd/2026-10-02-console-explainer-00-index/progress.md`.
7. After each wave, run `wave-verify.sh hybrid,canvas` on a detached main worktree. It must pass with VALIDATION PASSED and SMOKE_OK. Record `<wN>`, then remove the verify worktree.

## 8. HUMAN CHECKS

| Gate | When | What the person does | Recorded in |
|---|---|---|---|
| H1 | W1 start | Approves the mockups from V-0: the main window on Console with the view switcher and prompt dock, and Brief v0. | `docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/` README |
| H2 | W1 start | Approves the mockups from P-0: Map at 1440 and 1000 px, and the Brief architecture card. | same |
| H3 | W2 start | Approves the mockups from S-0: the story in the Brief, decision cards, the Map overlay and the Console summary block. | same |
| H4 | Phase A exit (after W1 merges 02b, 03) | Product review of the Console-first main window on a mock live session. | the spec's §13 table notes |
| H5 | Phase B exit (after W1) | Product review of the Map for this repo and one other repo. | same |
| H6 | Phase C exit (after W2) | Product review of the story, decision cards and overlay on a mock live session. | same |

Mockups are HTML files in the spec's mockups folder, rendered to PNG at 1440 and 1000 px. They follow the person's visual taste in memory (`ui-visual-taste.md`) and the viewer spec §7.12.

## 9. Done, per lane part

| Lane | Done when |
|---|---|
| 01 | Contracts and storage tests green; bundle v1 and v2 both parse; migration v5 applies on a v4 database. |
| 02a | The viewer accepts `chrome`, `hostViews` and `initialView`; view keys 0–3 work; a push hint triggers a fetch within one tick; existing viewer tests green. |
| 02b | Console renders every row kind; the scroll-back/append test is green; Brief v0 shows in every view; dev-host Console perf meets budgets. |
| 03 | The main window opens on the Console; all views are reachable with selection preserved; the prompt dock keeps D-5 behavior; the user shell carries no agent lines; smoke SMOKE_OK with Console append p95 ≤ 150 ms. |
| 04 | `codebase-map` property tests green; fixture repos match expected snapshots; this repo's snapshot matches its expected component table; the stage writes snapshot rows and push hints; scan and ingest budgets met. |
| 05 | Guardrail table tests green (injection, uncited, unknown component, Markdown); cache hits make 0 calls on reopen; backoff verified; the setting turns every call off. |
| 06 | `layoutMap` properties green and bench within budget; Map view and Brief card match the approved mockups; partial and no-edges notes render. |
| 07 | Story and highlights update within one debounce window in a mock live session; decisions show a resolvable "why"; overlay and summaries match the mockups. |

## 10. Spec coverage

| Spec section | Tasks |
|---|---|
| §1, §2 E1 Console default | V-3, V-4, D-2 |
| E2 Embedded viewer | V-2, D-2 |
| E3 Surfaces view | V-2 (`hostViews`), D-3 |
| E4 Brief | V-5, P-4, S-4 |
| E5 Push-triggered pulls | K-3, V-1, D-1 |
| E6 Light restyle | D-4 |
| E7 Shell separation | D-5 |
| E8, §5 Component model | M-1, M-2, M-3, M-5 |
| E9, §6 Explainer stage | M-6, N-5, S-2 |
| E10, §6.2–6.3 Narrator and guardrails | N-1, N-2, N-3, S-1 |
| E11, §6.4 Cache | K-4, N-3 |
| E12, E13, §8.3 Map layout and rendering | P-2, P-3 |
| E14 Languages | M-4, M-5, P-3 |
| E15 Setting | K-3, N-4 |
| E16 Mockups | V-0, P-0, S-0 |
| §3.2 Console row kinds | V-3, V-4, S-4 (summary) |
| §3.4 Map | P-3 |
| §3.5 Decisions | S-1, S-4 |
| §3.7, §8.6 Keys | V-2 |
| §7 Contracts, storage, IPC | K-1 to K-4, D-1 |
| §8.1 Fold | P-1, S-3 |
| §9 Main window | D-2 to D-5 |
| §10 Security and privacy | N-1, N-4, M-5 (skips), D-2 (host actions) |
| §11 Budgets | V-6, D-6, M-8, P-2, N-3, S-6 |
| §12 Testing | per task |
| §13 Phases | W0 to W2, H1 to H6 |
| Adjacent: ArchitectureDelta edge ids | M-7 |
