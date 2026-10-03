# Console and Explainer Lane 02: Viewer API, Console and Brief Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This file holds two lane parts with their own worktrees: Part A (W0) and Part B (W1).

**Goal:** Give `@jevcode/trace-viewer` the API the main window needs (push hints, a Console and a Map slot, host views, an embedded chrome, view keys 0–4, Shift+B and Esc for the Brief), then build the Console view, the rule-based Brief v0 and the Console performance harness.

**Architecture:** Part A changes only contracts inside the viewer: `TraceSource.onRowsAvailable` feeds the data controller, which polls at once on a hint; the view registry gains `console` and `map` slots (quiet placeholders), host views and a key table; `TraceViewer` gains `chrome`, `hostViews`, `initialView` and `renderSwitch`. Part B adds two pure builders in `src/layout` (`buildConsoleRows`, incremental by step identity; `buildBrief`), the virtualized `ConsoleView` that replaces the Console placeholder, the `Brief` panel that the Inspector region shows when nothing is selected, and the dev-host wiring and perf harness that measure the spec §11 Console budgets.

**Tech Stack:** TypeScript 5.9 (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), React 19.2 (`<Activity>`), `@tanstack/react-virtual` (its `anchorTo: "end"` and `followOnAppend` options, as the Hybrid spine uses them), zod 3, vitest 3 with jsdom and fast-check 4.10.1, Vite 5 (dev host), headless Google Chrome for screenshots and the perf run.

**Spec:** `docs/superpowers/specs/2026-10-02-console-and-explainer-design.md` (the spec) §3.1–3.3, §3.6, §3.7, §8, §11, §12. **Interfaces (binding):** `docs/superpowers/plans/2026-10-02-console-explainer-interfaces.md` §6.1–6.4. **Index:** `docs/superpowers/plans/2026-10-02-console-explainer-00-index.md`. **Context:** `docs/superpowers/specs/2026-09-28-trace-viewer-design.md` (the viewer spec) §7.8–7.13, §10. On a conflict the spec wins, then the interfaces file, then this file; each local choice is listed below.

## Interface deviations

Every name in interfaces §6.1–6.4 is kept with its type. These additions and changes follow the real code; lanes 03, 06 and 07 must read them.

1. **`ViewerLocation.view` becomes optional and accepts any view kind** (V-2). The schema was `z.enum(["canvas", "hybrid"]).default("hybrid")`. It becomes `ViewKindSchema.optional()` with `ViewKindSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/)`, so `console`, `map` and host kinds round-trip, and `initialView` can apply when the location names no view. `decodeLocation`'s defaults no longer contain `view`.
2. **`InitialViewStateInput.view?: ViewKind`** (V-2). `TraceViewer` resolves the opening view with `openingView(views, chrome, location?.view, initialView)` (new, `src/ui/views/registry.ts`) and passes it in; `initialViewState` uses `input.view ?? location?.view ?? "hybrid"`.
3. **`ViewState.brief: boolean` and the action `{ type: "brief/toggle" }`** (V-2). Shift+B pins the Brief over a selection (lowercase `b` stays `brushChapter` in Hybrid); any new selection, a cleared selection or a brush that drops the selection unpins it. With nothing selected the Brief already shows and `brief/toggle` returns the same state.
4. **Key table** (V-2, spec §3.7, §8.6). `KeyCommand` gains `{ cmd: "hostView"; position: number }` (Digit4–Digit9) and `{ cmd: "brief" }` (Shift+B). `Digit0` → Console and `Digit3` → Map. The viewer's existing `0` (zoom back to the level preset, viewer spec §7.9) moves to **Shift+0**, beside Shift+1 (fit all) and Shift+2 (zoom to selection). `keymap.ts` exports `BUILT_IN_VIEW_KEYS = { console: 0, canvas: 1, hybrid: 2, map: 3 }` and `FIRST_HOST_VIEW_KEY = 4`; `view-port.ts` exports `viewKeyOf(kind, views)` and `hostViewsOf(views)`; `registry.ts` exports `composeViews(hostViews)` and `openingView(...)`. A host view whose `kind` equals a built-in kind is dropped.
5. **New icon names** `view-console`, `view-map`, `view-surfaces` and `brief` (V-2). `ViewDefinition.icon` is the closed `IconName` union, so lane 03's `surfacesView` (`icon: "view-surfaces"`) typechecks only after V-2.
6. **Package exports for host views** (V-2): `ViewDefinition`, `ViewProps`, `ViewKind`, `IconName`, `ViewerChrome`, `AnswerDecisionRequest`, `useView`, `useDispatch`, `useSessionView` and `SessionView` from `@jevcode/trace-viewer`. Lane 03's Surfaces view uses them to read the store.
7. **Embedded chrome also hides the Outline** (V-2). Spec §8.5 names only the title bar. Beside the main window's own sidebar, a 216 px Outline leaves the active view about 240 px at 1000 px. The embedded title row becomes a 36 px view bar: switcher (unless the host places it), the approximate-joins and gaps chips, Review/Live, the "N new" pill, a non-ready status (loading, reconnecting, error) with Retry, zoom and, from V-5, the Brief toggle. The repo, prompt and duration are left to the main window header.
8. **`renderSwitch` contract** (V-2). The node it receives carries its own store, view list and tokens (`HostViewSwitch`), so the host may render it anywhere in its tree. `TraceViewer` calls `renderSwitch(node)` in a layout effect and `renderSwitch(null)` on unmount; the host passes a stable function (a `useState` setter works) and a stable `hostViews` array.
9. **`HINT_COMMIT_GAP_MS = 50`** (V-1, `data-controller.ts`). The caught-up commit of a hint-started poll waits `max(50 ms, COMMIT_COST_FACTOR × last finalize)` after the previous commit instead of the 250 ms progressive cap; without it the Console append budget (p95 ≤ 150 ms) cannot hold while rows arrive faster than four per second. Hints are ignored while reconnecting or in an error state (the backoff and Retry stay as they are), and a hint during the summary request or an in-flight poll or commit is remembered and polls right after it.
10. **`StaticBundleSource.onRowsAvailable`** (V-1, required on the static source): each drip tick pushes the last released seq, so the dev host exercises the push path. V-6 also marks `ROWS_RELEASED_MARK = "tv:rows-released"` (exported from `src/source.ts`) on each tick, the "row stored" end of the append measure.
11. **`ViewPort.toggle?(id): boolean` and `ViewerHostContext`** (V-4). `toggle` lets Enter expand a Console row (a view returns `true` when it handled the id); `ViewerHostContext` (`src/ui/shell/host-context.ts`, provided by the Shell) lets a view reach `ViewerHost.answerDecision`. Lane 06's Map may use both.
12. **Console row rules the interfaces leave open** (V-3). `tool.args` is always `""` in v1: the model's `Step` keeps no tool input (spec gap). An `approval` step becomes a `lifecycle` row with state `"waiting"`, because it carries no decision id. `guardrail` and `attention` steps (Jev's pipeline) make no row unless a finding is anchored on them; then only the finding row appears and `byStep` maps the step to it. A tool step with status `"unknown"` is emitted as `status: "ok"` with `ms: null`, and the renderer reads the step's own status to print "unknown". `buildConsoleRows` keeps its incremental cache in a module `WeakMap` keyed by the returned state, so `ConsoleRowsState` keeps the interface shape. New exports: `CONSOLE_TAIL_LINES = 8` and `consoleRowStepIds(row)`.
13. **`BriefModel.architecture` is always `null` from V-5**; lane 06 P-4 fills it. `BriefView` (presentational) is exported beside `Brief` so lanes 06 and 07 can render and test model states directly.
14. **Perf names** (V-6): `PERF.consoleAppend = "tv:console-append"` and `measureFromFirstAfterPaint(name, startMark)` in `src/ui/shell/perf.ts`. The Electron trace window and main window log the measure as `TRACE_PERF tv:console-append <ms>` through the existing `traceConsoleLine`.
15. **TitleBar hides its zoom control when the active port's `zoom.label()` is `""`** (V-4). The Console has no zoom.
16. **`ConsoleRow` gains a `guardrails` kind** (V-4 fix rounds): `{ kind: "guardrails"; key: "guardrails:<first finding id>"; stepIds; findingIds; findingStepIds }`. Consecutive warning guardrail-clamp flag lines fold into one "Jev review · n guardrails" row, which expands to its member lines (`ConsoleRowViewProps.onSelectStep?` picks one). A warning guardrail flag line is keyed `guardrails:<finding id>` from the start, so the fold that later absorbs it keeps the key; a critical finding never folds and keeps its finding id as key. `consoleRowStepIds` returns the fold's `stepIds`; `consoleReadingOrder` skips it. Every switch over `ConsoleRow["kind"]` must handle it (lane 07 S-4's `rowAnchorSeq` uses `consoleRowStepIds(row)[0]`).
17. **The Console's "N new" counts rows** (V-4 fix rounds): `consoleNewRowCount(state, index, afterSeq)` in `src/layout/console-rows.ts` (a read group counts once, a silent Jev step not at all). `NewBadge` gains `noun?: "step" | "row"` for its announcement. The title bar's pill reads the active view's own count through `ViewPort.newCount?(): number`, so both pills agree; views without it keep `selectNewCount`.
18. **`ViewState.revealRev`** (V-5 fix round): +1 when the Outline or the Brief (by `"shell"`) picks the item that is already selected; a view reveals its selection on it, with no selection change.
19. **Live at the Console's tail without selecting** (lane ruling I-1): `ViewPort.goToTail?(): boolean`. When the Console is the active view, `G`, its "↓ N new" pill and the title bar's Live and "N new" pill turn Live on and scroll to the tail without `nav/last`: with nothing selected the Brief stays, and an existing selection is kept. Hybrid and Canvas keep `nav/last` (viewer spec §7.10).
20. **`displayUntrusted` covers every hidden or reordering code point** (lane fix I-4): `[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]` (jev-router's guard class) become `⟨U+XXXX⟩` tokens, astral ones too (`⟨U+E0067⟩`); a tab stays, `\n` stays with `{ multiline: true }`; a grapheme cluster holding an `Extended_Pictographic` code point, or a keycap, renders as itself (ZWJ emoji, VS16, tag-sequence flags). Fast path: one regex test, clean text returned as is.
21. **Right panel** (lane fixes I-5, m3): `showsBrief(state)` is exported from `src/ui/inspector/RightPanel.tsx`; the Shell's aside is labelled "Brief" or "Inspector" after its content; when the panel switches while focus is inside it, focus moves to the Brief root (`[data-brief]`, `tabIndex=-1`) or to the active view's tab stop (`ViewPort.focusSelected`, else the main region).
22. **Test harness host** (lane fix I-3a): `HarnessOptions.host?: ViewerHost` and `Harness.host` in `src/test-support/ui-harness.tsx`; `createHarness().wrap` provides it through `ViewerHostContext`.
23. **Pending decisions are announced** (lane fix m6): the Shell mounts `DecisionAnnouncer`, which says "Decision needed: <title>" once, politely, for a decision that becomes pending after the load.

## Spec alignment notes

Points where the spec's text differs from what this lane builds. The spec owner should reconcile them; none blocks the lane.

- **Key `0`.** Spec §3.7 maps `0` to Console and says existing viewer keys keep their meaning, but viewer spec §7.9 already uses `0` for "zoom back to the level preset". This lane moves the preset to Shift+0 (deviation 4). Spec §3.7 and viewer spec §7.9 should both say so.
- **Switcher order.** Spec §3.1's sketch reads "Console · Hybrid · Canvas · Map · Surfaces"; interfaces §6.2 orders the registry Console, Canvas, Hybrid, Map. The switcher follows the registry, so its order equals the key order 0–4.
- **Brief key is Shift+B, not `B`.** Spec §3.3, §3.7 and E4 name `B`, but lowercase `b` is the viewer's `brushChapter` key in Hybrid (viewer spec §7.9), so the toggle is Shift+B (deviation 4). Spec §3.7's key table now says Shift+B and notes that lowercase `b` keeps brushing; a rebind to plain `b` would break brushing.
- **Shift+B with nothing selected.** The Brief already fills the panel, so Shift+B does nothing; with a selection it switches between the Brief and the Inspector. Esc keeps the viewer's unwind (menu → search → hand tool → collapse → parent → clear); its last step clears the selection, which shows the Brief (spec §3.3 "Esc from a selection returns to it").
- **The Brief replaces the Inspector's session summary** in both windows (spec E4). The summary's findings list and its "No problems found by 5 signals" line no longer show when nothing is selected; findings stay reachable with `n`/`N` and the Changes list flags units that need attention.
- **Console live follow.** Spec §3.2 says the Console auto-follows "while the reader is at the bottom". The Console therefore turns Live on again when the reader's own scroll reaches the bottom of a running session, and Live off when the reader scrolls away from it. Viewer spec §7.10 names only `G` and the pill; the Hybrid spine is unchanged.
- **Reasoning duration.** A reasoning step is a single-row step, so `durationMs` is `null` and the row reads "thinking" without seconds unless the model gives a duration (spec §3.2 shows "thinking · 2.3 s").
- **Tool arguments** are not in the model (deviation 12). Adding `Step.toolInput` is a model change outside this lane.
- **Initial selection in Review.** A finished session still opens with the top finding selected (viewer spec §7.8), so the Inspector, not the Brief, shows first; Esc returns to the Brief.

## Lane prerequisites

### Part A (wave W0, branch `ce/02a-viewer-api`)

- **Starts from `main`** in parallel with lane 01. Part A has no code dependency on lane 01: `onRowsAvailable` is a viewer-side signature, and lane 03 adapts the IPC channel to it. Lane 01 also edits `packages/trace-viewer/src/sources/static-bundle.ts` (`parseTraceBundle` accepts versions 1 and 2); W0 merges 01 first, so Part A rebases onto it before its merge (see "Lane completion").
- **Worktree** (once):

```bash
git -C /Users/jwpark/Projects/jevcode worktree add -b ce/02a-viewer-api /Users/jwpark/Projects/jevcode-ce-02a main
bash /Users/jwpark/Projects/jevcode/.superpowers/orchestration/setup-worktree.sh /Users/jwpark/Projects/jevcode-ce-02a
```

- Every Part A command runs from `/Users/jwpark/Projects/jevcode-ce-02a` (prefix `cd /Users/jwpark/Projects/jevcode-ce-02a && ` if the shell does not keep the directory).
- **Baseline** (before V-1): the package suite passes (run it in the background, below), `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer typecheck` exits 0.

### Part B (wave W1, branch `ce/02b-console`)

- **Starts from `<w0>`**, the W0 merge (lanes 01 and 02a). Verify from anywhere:

```bash
git -C /Users/jwpark/Projects/jevcode show main:packages/trace-viewer/src/source.ts | grep -c "onRowsAvailable?("
git -C /Users/jwpark/Projects/jevcode show main:packages/trace-viewer/src/ui/state/view-state.ts | grep -c '"console" | "canvas" | "hybrid" | "map"'
git -C /Users/jwpark/Projects/jevcode show main:packages/trace-viewer/src/ui/views/registry.ts | grep -c "ConsolePlaceholder"
git -C /Users/jwpark/Projects/jevcode show main:packages/contracts/src/overview.ts | grep -c "export const NarrativeSentenceSchema"
```

Expected: `1`, `1`, `2` (`registry.ts` names `ConsolePlaceholder` in its import and in the console entry), `1`.

- **Worktree** (once):

```bash
git -C /Users/jwpark/Projects/jevcode worktree add -b ce/02b-console /Users/jwpark/Projects/jevcode-ce-02b <w0>
bash /Users/jwpark/Projects/jevcode/.superpowers/orchestration/setup-worktree.sh /Users/jwpark/Projects/jevcode-ce-02b
```

- Every Part B command runs from `/Users/jwpark/Projects/jevcode-ce-02b`.
- **Human gate H1** blocks V-4 and V-5 only. V-0 opens the gate; V-3 runs while the person reviews.
- **Plan documents:** if `git ls-files docs/superpowers/plans` does not list this file, the plans are untracked in the main checkout. Read them by absolute path and never commit them from a lane worktree.
- **Tooling:** `node --version` prints `v22.x`, `pnpm --version` prints `9.15.0`, and `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` exists (screenshots and the perf run; `CHROME_PATH` overrides it).

## Global Constraints

The index's Global Constraints apply in full. Lane-specific additions:

- **No new dependency** and no `package.json` or `pnpm-lock.yaml` change. Only files listed in a task's **Files** block may change. `eslint.config.mjs`, `docs/SPEC.md` and `fixtures/**` are out of bounds.
- **`src/layout/**` stays React-free and clock-free** (no `Date`, `performance`, timers or DOM; ESLint `LAYOUT_PURE_GLOBALS`). `console-rows.ts` and `brief.ts` read only the session and the index.
- **Untrusted text:** agent messages, prompts, commands, output lines, paths, tool names, test names, decision titles and options, chapter titles and narrator sentences render through `displayUntrusted` (multi-line text with `{ multiline: true }`) as React text nodes, with the full text in `title` or the accessible name where the visible text is cut. No Markdown, no `dangerouslySetInnerHTML`, no auto-linking.
- **Color for state only:** red (`--tv-bad`, `--tv-bad-ink`) only for failed tests or checks, agent failures and critical findings. A non-zero command exit is a neutral ✕. Accent marks the selection, focus and the one pending decision. No decorative borders; spacing and one thin gutter rule.
- **Live rules:** a data rebuild never moves focus, never scrolls the reader away from where they are, and never moves the selection (viewer spec §7.10).
- **Commits:** one conventional commit per task that lists its files in `git add`. No `Claude-Session:` or `Co-Authored-By` trailers. Never `git stash`, `git reset --hard` or `git clean`; set work aside with a WIP commit. Identity `Jongwon Park <contact@parkjongwon.com>` (pass `-c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com` if the worktree config differs).
- **Hang safety:** wrap every foreground vitest, typecheck and lint call in `perl -e 'alarm 150; exec @ARGV' …`. The whole package suite, root checks, builds, the smoke and the perf run go to the background with their own alarm; poll their logs. Kill every server and Chrome you start.

## Review Focus

The index assigns one Review Focus item to this lane.

3. **Live append while the reader is scrolled back in the Console.** The view must not jump, steal focus or move the selected row; an "N new" pill appears instead. Test: **V-4** `src/ui/views/console/console-view.test.tsx` "Review Focus 3: a live append while the reader is scrolled back keeps the offset, the focused row and the selection, and shows an N new pill".

Two lane-local failure modes get their own tests:

- **A hint storm or a hint during a reconnect** must not stack polls or skip the backoff. Test: **V-1** `data-controller.test.ts` "a hint during an in-flight poll polls once more right after it, never two at once" and "keeps the reconnect backoff".
- **Hostile text in the Console and the Brief** (U+202E, control characters). Tests: **V-4** "shows bidi and control characters as visible tokens"; **V-5** `brief.test.tsx` "renders untrusted titles as tokens".

## File structure

All paths are under `packages/trace-viewer/` unless they start with `apps/` or `docs/`.

| File | Responsibility | Task |
|---|---|---|
| `src/source.ts` | `TraceSource.onRowsAvailable?`; `ROWS_RELEASED_MARK` | V-1 (V-6 adds the mark) |
| `src/ui/shell/data-controller.ts` | Push hint: poll at once, one poll in flight, `HINT_COMMIT_GAP_MS` | V-1 |
| `src/sources/static-bundle.ts` | Drip ticks push hints (V-1) and mark releases (V-6) | V-1, V-6 |
| `src/ui/state/view-state.ts` | `ViewKind`, `ViewState.brief`, `brief/toggle`, opening view input | V-2 |
| `src/ui/state/location.ts` | `ViewKindSchema`, optional `view` | V-2 |
| `src/ui/state/keymap.ts` | Keys 0–9, Shift+0, Shift+B; `BUILT_IN_VIEW_KEYS`, `FIRST_HOST_VIEW_KEY` | V-2 |
| `src/ui/views/registry.ts` | `VIEWS` with Console and Map slots, `composeViews`, `openingView` | V-2 (V-4 swaps in `ConsoleView`; lane 06 swaps in `MapView`) |
| `src/ui/views/view-port.ts` | `viewKeyOf`, `hostViewsOf`; `ViewPort.toggle?` | V-2, V-4 |
| `src/ui/views/placeholder/ViewPlaceholder.tsx`, `.module.css` | Quiet Console and Map placeholders | V-2 |
| `src/ui/icons/icon-names.ts`, `paths.ts` | `view-console`, `view-map`, `view-surfaces`, `brief` | V-2 |
| `src/ui/shell/ViewSwitch.tsx` | The view radiogroup and `HostViewSwitch` | V-2 |
| `src/ui/shell/TitleBar.tsx`, `TitleBar.module.css` | Full and embedded bars; Brief toggle (V-5); zoom hidden for "" (V-4) | V-2, V-4, V-5 |
| `src/ui/shell/Shell.tsx`, `Shell.module.css` | `chrome`, `views`, `showSwitch`; embedded grid; host context (V-4); right panel (V-5) | V-2, V-4, V-5 |
| `src/ui/shell/TraceViewer.tsx` | `chrome`, `hostViews`, `initialView`, `renderSwitch` | V-2 |
| `src/ui/shell/KeyboardLayer.tsx`, `ShortcutSheet.tsx` | Host-view keys, Shift+B, search fallback; `ViewPort.toggle` (V-4) | V-2, V-4 |
| `src/ui/shell/host.ts` | `answerDecision?`, `openTraceWindow?`, `rescanOverview?` | V-2 |
| `src/index.ts` | Host-view exports | V-2 |
| `docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/` | Phase A mockups, PNGs, README with the H1 record | V-0 |
| `src/layout/console-rows.ts` | `ConsoleRow`, `buildConsoleRows` (pure, incremental) | V-3 |
| `src/ui/shell/host-context.ts` | `ViewerHostContext`, `useViewerHost` | V-4 |
| `src/ui/views/console/ConsoleView.tsx`, `ConsoleRowView.tsx`, `ConsoleView.module.css` | The Console view | V-4 |
| `apps/trace-viewer-dev/scripts/smoke.mjs` | `console` view (V-4); `--embedded` and `--console-perf` (V-6) | V-4, V-6 |
| `src/layout/brief.ts` | `BriefModel`, `buildBrief` (pure) | V-5 |
| `src/ui/inspector/Brief.tsx`, `Brief.module.css`, `RightPanel.tsx` | Brief v0 and the Brief/Inspector switch | V-5 |
| `src/ui/shell/perf.ts` | `PERF.consoleAppend`, `measureFromFirstAfterPaint` | V-6 |
| `apps/trace-viewer-dev/src/host.tsx`, `host.module.css`, `perf-hud.tsx`, `main.tsx` | `?chrome=embedded`, `?view=`, Console perf runs | V-6 |
| `apps/trace-viewer-dev/scripts/console-bundle.mjs` | The 10k-step Console bundle | V-6 |
| `docs/perf.md` | Console budget results (dev host) | V-6 |

**Order.** Part A: V-1 → V-2 (independent; one branch). Part B: V-0 (opens H1) → V-3 → (H1) → V-4 → V-5 → V-6.

**Commands used by every task** (from the part's worktree):

- Targeted tests: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run <path relative to packages/trace-viewer>`.
- Package typecheck: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer typecheck` (covers tests and `src/test-support`).
- Lint: `perl -e 'alarm 150; exec @ARGV' pnpm exec eslint packages/trace-viewer/src apps/trace-viewer-dev/src` (prints nothing when clean).
- Package suite, in the background: `perl -e 'alarm 590; exec @ARGV' pnpm --filter @jevcode/trace-viewer test > .superpowers/tv-suite.log 2>&1`, then `tail -6 .superpowers/tv-suite.log` until it shows the vitest summary; expect `Test Files … passed` and no `failed`.
- Viewer build (before anything that imports `@jevcode/trace-viewer` from outside the package): `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer build`.
- Root checks, in the background: `/Users/jwpark/Projects/jevcode/.superpowers/orchestration/root-checks.sh "$PWD"`, then `tail -3 .superpowers/root-checks.log` until it prints `ROOT_CHECKS_DONE fail=0`. The known flakes (`stall-watchdog.test.ts`, `codex-adapter.test.ts`, `file-watcher.test.ts`) are accepted only if that package passes alone.

---

# Part A — Viewer API (wave W0)

### Task V-1: `TraceSource.onRowsAvailable` and controller push hint

**Files:**
- Modify: `packages/trace-viewer/src/source.ts` (the `TraceSource` interface)
- Modify: `packages/trace-viewer/src/ui/shell/data-controller.ts` (constants, state, `requestCommit`, `afterCommit`, `page`, `poll`, `reset`, `start`, `stop`)
- Modify: `packages/trace-viewer/src/sources/static-bundle.ts` (`StaticBundleSource`, `tick`, the returned object)
- Test: `packages/trace-viewer/src/ui/shell/data-controller.test.ts` (new `describe` block)
- Test: `packages/trace-viewer/src/sources/static-bundle.test.ts` (one new case)

**Interfaces:**
- Consumes: `TraceSource` (`src/source.ts`), `createDataController(options: DataControllerOptions): DataController`, `TERMINAL_POLL_MS`, `COMMIT_COST_FACTOR`, `BACKOFF_MS`, the test file's `FakeScheduler`, `fakeSource`, `messageRows`.
- Produces:
  - `TraceSource.onRowsAvailable?(listener: (lastSeq: number) => void): () => void` (interfaces §6.1).
  - `HINT_COMMIT_GAP_MS = 50` (deviation 9), exported from `data-controller.ts`.
  - Controller behavior (spec §8.7): `start()` subscribes when the source offers `onRowsAvailable`, `stop()` unsubscribes; a hint with `lastSeq > cursor` polls at once and the next timer poll counts from that poll; at most one poll in flight; a hint during the summary request, an in-flight poll or a pending commit is remembered and the next poll starts at once; hints are ignored while reconnecting or in an error state. Generation and stale guards are unchanged.
  - `StaticBundleSource.onRowsAvailable(listener: (lastSeq: number) => void): () => void` (deviation 10).

- [ ] **Step 1: Write the failing tests**

Append to `packages/trace-viewer/src/ui/shell/data-controller.test.ts`. First extend the import from `./data-controller.js`:

```ts
import {
  BACKOFF_MS,
  COMMIT_COST_FACTOR,
  createDataController,
  HINT_COMMIT_GAP_MS,
  LIVE_TICK_START,
  TERMINAL_POLL_MS,
  type DataSnapshot,
  type Scheduler,
} from "./data-controller.js";
```

Then add at the end of the file:

```ts
/** A source with spec §7 push hints: hint(lastSeq) calls every subscribed listener. */
function withHints(base: TraceSource) {
  const listeners = new Set<(lastSeq: number) => void>();
  const source: TraceSource = {
    ...base,
    onRowsAvailable(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    source,
    listeners,
    hint(lastSeq: number): void {
      for (const listener of [...listeners]) listener(lastSeq);
    },
  };
}

describe("push hints (spec E5, §8.7)", () => {
  it("a hint past the cursor polls at once, commits within HINT_COMMIT_GAP_MS and restarts the poll timer", async () => {
    const scheduler = new FakeScheduler();
    const { source: base, control } = fakeSource(messageRows(5), { state: "running", released: 3 });
    const { source, hint } = withHints(base);
    const controller = createDataController({ source, pollMs: 1_000, scheduler, isHidden: () => false });
    controller.start();
    await scheduler.run(300);
    expect(controller.get().session?.loadedThroughSeq).toBe(3);
    const calls = control.calls.length;

    control.released = 5;
    hint(5);
    await scheduler.run(HINT_COMMIT_GAP_MS);
    expect(control.calls.length).toBe(calls + 1);
    expect(control.calls.at(-1)?.afterSeq).toBe(3);
    expect(controller.get().session?.loadedThroughSeq).toBe(5);

    // The 1 s timer counts from the hint's poll (t = 300), not from the first commit (t = 0).
    await scheduler.run(900);
    expect(control.calls.length).toBe(calls + 1);
    await scheduler.run(200);
    expect(control.calls.length).toBe(calls + 2);
  });

  it("ignores a hint at or below the cursor", async () => {
    const scheduler = new FakeScheduler();
    const { source: base, control } = fakeSource(messageRows(5), { state: "running", released: 3 });
    const { source, hint } = withHints(base);
    const controller = createDataController({ source, pollMs: 1_000, scheduler, isHidden: () => false });
    controller.start();
    await scheduler.run(300);
    const calls = control.calls.length;
    hint(3);
    hint(2);
    await scheduler.run(10);
    expect(control.calls.length).toBe(calls);
  });

  it("a hint during an in-flight poll polls once more right after it, never two at once", async () => {
    const scheduler = new FakeScheduler();
    const { source: base, control } = fakeSource(messageRows(6), { state: "running", released: 3 });
    const { source, hint } = withHints(base);
    const controller = createDataController({ source, pollMs: 1_000, scheduler, isHidden: () => false });
    controller.start();
    await scheduler.run(300);

    control.deferNext = true;
    await scheduler.run(800); // the timer poll at t = 1,000 is now in flight
    expect(control.deferred).toHaveLength(1);
    const calls = control.calls.length;

    control.released = 6;
    hint(6);
    hint(6);
    await scheduler.run(10);
    expect(control.calls.length).toBe(calls);

    control.deferred.shift()?.resolve({ rows: [], nextAfterSeq: null, lastSeq: 3, state: "running" });
    await scheduler.run(10);
    expect(control.calls.length).toBe(calls + 1);
    expect(control.calls.at(-1)?.afterSeq).toBe(3);
    expect(controller.get().session?.loadedThroughSeq).toBe(6);
  });

  it("keeps the reconnect backoff: a hint while reconnecting waits for the retry", async () => {
    const scheduler = new FakeScheduler();
    const { source: base, control } = fakeSource(messageRows(5), { state: "running", released: 3 });
    const { source, hint } = withHints(base);
    const controller = createDataController({ source, pollMs: 1_000, scheduler, isHidden: () => false });
    controller.start();
    await scheduler.run(300);

    control.failures = 1;
    await scheduler.run(1_000); // the poll at t = 1,000 fails; the retry waits BACKOFF_MS[0]
    expect(controller.get().status.kind).toBe("reconnecting");
    const calls = control.calls.length;
    control.released = 5;
    hint(5);
    await scheduler.run(10);
    expect(control.calls.length).toBe(calls);

    await scheduler.run(BACKOFF_MS[0] ?? 1_000);
    expect(control.calls.length).toBe(calls + 1);
    expect(controller.get().status.kind).toBe("ready");
    expect(controller.get().session?.loadedThroughSeq).toBe(5);
  });

  it("a hint wakes a terminal session before the slow poll", async () => {
    const scheduler = new FakeScheduler();
    const { source: base, control } = fakeSource(messageRows(5), { state: "completed", released: 3 });
    const { source, hint } = withHints(base);
    const controller = createDataController({ source, pollMs: 1_000, scheduler, isHidden: () => false });
    controller.start();
    await scheduler.run(300);
    expect(controller.get().terminal).toBe(true);

    control.state = "running";
    control.released = 4;
    hint(4);
    await scheduler.run(HINT_COMMIT_GAP_MS);
    expect(controller.get().terminal).toBe(false);
    expect(controller.get().session?.loadedThroughSeq).toBe(4);
    expect(scheduler.now()).toBeLessThan(TERMINAL_POLL_MS);
  });

  it("subscribes once per start and unsubscribes on stop", async () => {
    const scheduler = new FakeScheduler();
    const { source: base, control } = fakeSource(messageRows(5), { state: "running", released: 3 });
    const { source, hint, listeners } = withHints(base);
    const controller = createDataController({ source, pollMs: 1_000, scheduler, isHidden: () => false });
    controller.start();
    controller.start();
    expect(listeners.size).toBe(1);
    await scheduler.run(300);

    controller.stop();
    expect(listeners.size).toBe(0);
    const calls = control.calls.length;
    control.released = 5;
    hint(5);
    await scheduler.run(2_000);
    expect(control.calls.length).toBe(calls);

    controller.start();
    expect(listeners.size).toBe(1);
    controller.stop();
  });

  it("caps hint commits at COMMIT_COST_FACTOR times the last finalize", async () => {
    const scheduler = new FakeScheduler();
    const { source: inner, control } = fakeSource(messageRows(8), { state: "running", released: 3 });
    // commitNow reads the source clock once per finalize: each commit costs 30 ms on the fake clock.
    const { source, hint } = withHints({ ...inner, now: () => (scheduler.spend(30), 0) });
    const controller = createDataController({ source, pollMs: 1_000, scheduler, isHidden: () => false });
    const seen = record(controller, scheduler);
    controller.start();
    await scheduler.run(300);
    const commitsBefore = seen.filter((entry) => entry.snapshot.session !== null).length;

    control.released = 4;
    hint(4);
    await scheduler.run(0);
    control.released = 5;
    hint(5);
    await scheduler.run(500);
    const commits = seen.filter((entry) => entry.snapshot.session !== null).slice(commitsBefore);
    expect(commits.map((entry) => entry.snapshot.session?.loadedThroughSeq)).toEqual([4, 5]);
    expect((commits[1]?.t ?? 0) - (commits[0]?.t ?? 0)).toBeGreaterThanOrEqual(COMMIT_COST_FACTOR * 30);
  });
});
```

Append to `packages/trace-viewer/src/sources/static-bundle.test.ts`, inside `describe("createStaticBundleSource", …)`:

```ts
  it("pushes a hint with the last released seq on every drip tick, until unsubscribed", () => {
    const source = createStaticBundleSource(bundle(), { drip: { rowsPerTick: 2, intervalMs: 100, manual: true } });
    const seen: number[] = [];
    const off = source.onRowsAvailable((lastSeq) => seen.push(lastSeq));
    source.tick();
    source.tick();
    off();
    source.tick();
    expect(seen).toEqual([4, 7]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/shell/data-controller.test.ts src/sources/static-bundle.test.ts`

Expected: FAIL. TypeScript-in-vitest reports `HINT_COMMIT_GAP_MS` as undefined (the hint cases fail on `toBe(calls + 1)` because nothing polls) and `source.onRowsAvailable is not a function` in the static-bundle case.

- [ ] **Step 3: Add the hint to the source contract**

In `packages/trace-viewer/src/source.ts`, find:

```ts
  /** Epoch ms on the session's source clock: Date.now() over IPC; a virtual clock for a drip source. */
  now(): number;
}
```

Replace it with:

```ts
  /** Epoch ms on the session's source clock: Date.now() over IPC; a virtual clock for a drip source. */
  now(): number;
  /**
   * Optional push hint (spec E5, §8.7): the host calls `listener(lastSeq)` when rows up to lastSeq are stored for
   * this session. A hint carries no rows; the data controller polls at once and keeps its 1 s poll as the fallback.
   * Returns the unsubscribe function.
   */
  onRowsAvailable?(listener: (lastSeq: number) => void): () => void;
}
```

- [ ] **Step 4: Implement the hint in the data controller**

In `packages/trace-viewer/src/ui/shell/data-controller.ts`, find:

```ts
/** While catching up, a progressive commit waits at least this many times the previous finalize (see requestCommit). */
export const COMMIT_COST_FACTOR = 4;
```

Replace it with:

```ts
/** While catching up, a progressive commit waits at least this many times the previous finalize (see requestCommit). */
export const COMMIT_COST_FACTOR = 4;

/**
 * The caught-up commit of a poll that a push hint started waits at least this long after the previous commit (spec
 * E5: tens of milliseconds), and at least COMMIT_COST_FACTOR times the last finalize, instead of the 250 ms
 * progressive cap. Main coalesces hints to one per 50 ms per session (spec §7), so this matches their rate.
 */
export const HINT_COMMIT_GAP_MS = 50;
```

Find:

```ts
  let failures = 0;
  let foldPoisoned = false;
```

Replace it with:

```ts
  let failures = 0;
  let foldPoisoned = false;
  let unsubscribeHints: (() => void) | null = null;
  /** A page loop of the current generation is in flight. */
  let polling = false;
  /** Highest lastSeq a hint announced while the summary, a poll or a commit was pending; read when the next poll is scheduled. */
  let hintedSeq = 0;
  /** The pending caught-up commit belongs to a hint-started poll and may use HINT_COMMIT_GAP_MS. */
  let hintCommit = false;
```

Find:

```ts
    const gapMs = caughtUp ? minCommitGapMs : Math.max(minCommitGapMs, COMMIT_COST_FACTOR * lastCommitCostMs);
```

Replace it with:

```ts
    const fast = caughtUp && hintCommit;
    if (caughtUp) hintCommit = false;
    const gapMs = caughtUp
      ? fast
        ? Math.max(HINT_COMMIT_GAP_MS, COMMIT_COST_FACTOR * lastCommitCostMs)
        : minCommitGapMs
      : Math.max(minCommitGapMs, COMMIT_COST_FACTOR * lastCommitCostMs);
```

Find:

```ts
  function afterCommit(gen: number, caughtUp: boolean): void {
    if (gen !== generation || !caughtUp || lastPage === null) return;
    schedulePoll(gen, isTerminalState(lastPage.state) ? TERMINAL_POLL_MS : pollMs);
  }
```

Replace it with:

```ts
  /** 0 when a hint announced rows past the cursor while this poll ran (that poll is hint-started); else the timer. */
  function nextPollDelay(state: AgentState): number {
    const hinted = hintedSeq > cursor;
    hintedSeq = 0;
    if (hinted) {
      hintCommit = true;
      return 0;
    }
    return isTerminalState(state) ? TERMINAL_POLL_MS : pollMs;
  }

  function afterCommit(gen: number, caughtUp: boolean): void {
    if (gen !== generation || !caughtUp || lastPage === null) return;
    schedulePoll(gen, nextPollDelay(lastPage.state));
  }
```

Find:

```ts
      } else {
        // Quiet poll: nothing changed, so nothing commits; terminal sessions poll slowly.
        schedulePoll(gen, isTerminalState(next.state) ? TERMINAL_POLL_MS : pollMs);
      }
```

Replace it with:

```ts
      } else {
        // Quiet poll: nothing changed, so nothing commits; terminal sessions poll slowly.
        hintCommit = false;
        schedulePoll(gen, nextPollDelay(next.state));
      }
```

Find:

```ts
  async function poll(gen: number, first?: Promise<TraceRowsPage>): Promise<void> {
    try {
      await page(gen, first);
    } catch (error) {
```

Replace it with:

```ts
  async function poll(gen: number, first?: Promise<TraceRowsPage>): Promise<void> {
    polling = true;
    try {
      await page(gen, first);
    } catch (error) {
```

In the same function, find the end of the `catch` block:

```ts
      emit({ ...latest, status: { kind: "reconnecting", attempt: failures, retryInMs } });
      schedulePoll(gen, retryInMs);
    }
  }
```

Replace it with:

```ts
      emit({ ...latest, status: { kind: "reconnecting", attempt: failures, retryInMs } });
      schedulePoll(gen, retryInMs);
    } finally {
      if (gen === generation) polling = false;
    }
  }

  /** Spec §8.7: a hint past the cursor polls at once and resets the poll timer; one poll in flight at most. */
  function onHint(lastSeq: number): void {
    if (!running || !Number.isFinite(lastSeq) || lastSeq <= cursor) return;
    // A reconnect keeps its backoff (BACKOFF_MS) and an error waits for Retry: hints never start a retry storm.
    if (failures > 0 || latest.status.kind === "error") return;
    if (fold === null || polling || commitTimer !== null) {
      hintedSeq = Math.max(hintedSeq, lastSeq);
      return;
    }
    if (pollTimer !== null) {
      scheduler.clearTimeout(pollTimer);
      pollTimer = null;
    }
    hintCommit = true;
    void poll(generation);
  }
```

Find:

```ts
    commitCaughtUp = false;
    failures = 0;
    foldPoisoned = false;
  }
```

Replace it with:

```ts
    commitCaughtUp = false;
    failures = 0;
    foldPoisoned = false;
    polling = false;
    hintedSeq = 0;
    hintCommit = false;
  }
```

Find:

```ts
    start() {
      if (running) return;
      running = true;
      reset();
      void load(generation);
    },
    stop() {
      running = false;
      clearTimers();
      generation += 1;
    },
```

Replace it with:

```ts
    start() {
      if (running) return;
      running = true;
      reset();
      unsubscribeHints?.();
      unsubscribeHints = source.onRowsAvailable?.(onHint) ?? null;
      void load(generation);
    },
    stop() {
      running = false;
      clearTimers();
      generation += 1;
      unsubscribeHints?.();
      unsubscribeHints = null;
    },
```

- [ ] **Step 5: Push hints from the static source's drip**

In `packages/trace-viewer/src/sources/static-bundle.ts`, find:

```ts
export interface StaticBundleSource extends TraceSource {
  /** Rows released so far (all rows without drip). */
  released(): number;
```

Replace it with:

```ts
export interface StaticBundleSource extends TraceSource {
  /** Each drip tick that releases rows calls the listeners with the last released seq (spec E5 on the dev host). */
  onRowsAvailable(listener: (lastSeq: number) => void): () => void;
  /** Rows released so far (all rows without drip). */
  released(): number;
```

Find:

```ts
  const tick = (): void => {
    released = Math.min(rows.length, released + perTick);
    if (done()) stop();
  };
```

Replace it with:

```ts
  const listeners = new Set<(lastSeq: number) => void>();
  const tick = (): void => {
    const before = released;
    released = Math.min(rows.length, released + perTick);
    if (done()) stop();
    if (released === before) return;
    const seq = lastReleasedSeq();
    for (const listener of [...listeners]) listener(seq);
  };
```

Find:

```ts
    released: () => released,
    tick,
    dispose: stop,
```

Replace it with:

```ts
    onRowsAvailable(listener: (lastSeq: number) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    released: () => released,
    tick,
    dispose: stop,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/shell/data-controller.test.ts src/sources/static-bundle.test.ts`

Expected: PASS, every existing case included (the 1 s and 5 s timer paths are unchanged when no hint arrives).

- [ ] **Step 7: Typecheck, lint and the package suite**

Run the package typecheck and the lint command (section "Commands"); both print nothing and exit 0. Run the package suite in the background; expect no failures. The dev host's `?selftest=drip` path now also polls on each drip tick; nothing in the suite depends on its poll count.

- [ ] **Step 8: Commit**

```bash
git add packages/trace-viewer/src/source.ts \
  packages/trace-viewer/src/ui/shell/data-controller.ts \
  packages/trace-viewer/src/ui/shell/data-controller.test.ts \
  packages/trace-viewer/src/sources/static-bundle.ts \
  packages/trace-viewer/src/sources/static-bundle.test.ts
git commit -m "feat(trace-viewer): poll at once on a push hint (TraceSource.onRowsAvailable)"
```

### Task V-2: View kinds, registry with Console and Map slots, `chrome`, `hostViews`, `initialView`, view keys

**Files:**
- Modify: `packages/trace-viewer/src/ui/state/view-state.ts` (`ViewKind`, `ViewState`, `ViewAction`, `InitialViewStateInput`, `initialViewState`, `selectId`, `writeBrush`, `reduce`)
- Modify: `packages/trace-viewer/src/ui/state/location.ts` (`ViewKindSchema`, `ViewerLocationSchema.view`)
- Modify: `packages/trace-viewer/src/ui/state/keymap.ts` (whole file shown below)
- Modify: `packages/trace-viewer/src/ui/views/view-port.ts` (helpers, comment)
- Modify: `packages/trace-viewer/src/ui/views/registry.ts` (whole file shown below)
- Create: `packages/trace-viewer/src/ui/views/placeholder/ViewPlaceholder.tsx`, `packages/trace-viewer/src/ui/views/placeholder/ViewPlaceholder.module.css`
- Modify: `packages/trace-viewer/src/ui/icons/icon-names.ts`, `packages/trace-viewer/src/ui/icons/paths.ts`
- Create: `packages/trace-viewer/src/ui/shell/ViewSwitch.tsx`
- Modify: `packages/trace-viewer/src/ui/shell/TitleBar.tsx`, `packages/trace-viewer/src/ui/shell/TitleBar.module.css`
- Modify: `packages/trace-viewer/src/ui/shell/Shell.tsx`, `packages/trace-viewer/src/ui/shell/Shell.module.css`
- Modify: `packages/trace-viewer/src/ui/shell/TraceViewer.tsx` (whole file shown below)
- Modify: `packages/trace-viewer/src/ui/shell/KeyboardLayer.tsx` (imports, `run`), `packages/trace-viewer/src/ui/shell/ShortcutSheet.tsx` (`SHORTCUTS`)
- Modify: `packages/trace-viewer/src/ui/shell/host.ts`
- Modify: `packages/trace-viewer/src/index.ts`
- Test: `packages/trace-viewer/src/ui/state/keymap.test.ts`, `view-state.test.ts`, `location.test.ts`
- Test: `packages/trace-viewer/src/ui/shell/title-bar.test.tsx`, `keyboard.test.tsx`
- Test (create): `packages/trace-viewer/src/ui/shell/embedded.test.tsx`

**Interfaces:**
- Consumes: `ViewDefinition`, `ViewProps`, `ViewDefinitionsContext`, `createViewStore`, `ViewStoreContext`, `useView`, `useDispatch`, `tokenStyle`, `Icon`, `TitleBar.module.css` (`segmented`, `segment`), `CanvasView`, `HybridView`, `isFocusable` (`regions.ts`).
- Produces (interfaces §6.2 plus deviations 1–8):
  - `type ViewKind = "console" | "canvas" | "hybrid" | "map" | (string & { readonly __host?: true })`
  - `ViewState.brief: boolean`; `ViewAction` `{ type: "brief/toggle" }`; `InitialViewStateInput.view?: ViewKind`
  - `ViewKindSchema` (zod); `ViewerLocation.view?: string`
  - `KeyCommand` gains `{ cmd: "hostView"; position: number }` and `{ cmd: "brief" }`; `BUILT_IN_VIEW_KEYS`, `FIRST_HOST_VIEW_KEY = 4`
  - `viewKeyOf(kind: ViewKind, views: readonly ViewDefinition[]): number | null`; `hostViewsOf(views: readonly ViewDefinition[]): ViewDefinition[]`
  - `VIEWS` = Console (placeholder), Canvas, Hybrid, Map (placeholder); `composeViews(hostViews: readonly ViewDefinition[] | undefined): readonly ViewDefinition[]`; `openingView(views, chrome, locationView, initialView): ViewKind`
  - `ConsolePlaceholder`, `MapPlaceholder` (V-4 and lane 06 P-3 replace them in `VIEWS`)
  - `ViewSwitch()`, `HostViewSwitch({ store, views })`
  - `TraceViewerProps.chrome?: ViewerChrome` (`"full" | "embedded"`), `hostViews?`, `initialView?`, `renderSwitch?: (switcher: ReactNode) => void`
  - `ViewerHost.answerDecision?(request: AnswerDecisionRequest)`, `openTraceWindow?()`, `rescanOverview?()`; `AnswerDecisionRequest = { decisionId: string; optionId: string }`
  - `ShellProps.chrome?`, `views?`, `showSwitch?`; `TitleBarProps.chrome?`, `showSwitch?`
  - Icon names `view-console`, `view-map`, `view-surfaces`, `brief`

- [ ] **Step 1: Write the failing tests**

In `packages/trace-viewer/src/ui/state/keymap.test.ts`, inside "maps shifted letters and digits", after the `Digit2` line with `canvas`, add:

```ts
    expect(resolveKey(key("Digit0"), hybrid, "down")).toEqual({ cmd: "view", view: "console" });
    expect(resolveKey(key("Digit3"), hybrid, "down")).toEqual({ cmd: "view", view: "map" });
    expect(resolveKey(key("Digit4"), hybrid, "down")).toEqual({ cmd: "hostView", position: 0 });
    expect(resolveKey(key("Digit9"), hybrid, "down")).toEqual({ cmd: "hostView", position: 5 });
    expect(resolveKey(key("Digit0", { shiftKey: true }), hybrid, "down")).toEqual({ cmd: "zoom", op: "preset" });
    expect(resolveKey(key("Digit3", { shiftKey: true }), hybrid, "down")).toBeNull();
    expect(resolveKey(key("Digit4", { shiftKey: true }), hybrid, "down")).toBeNull();
```

In "brackets move turns; braces and b edit the brush only in Hybrid", add:

```ts
    expect(resolveKey(key("KeyB", { shiftKey: true }), hybrid, "down")).toEqual({ cmd: "brief" });
    expect(resolveKey(key("KeyB", { shiftKey: true }), canvas, "down")).toEqual({ cmd: "brief" });
```

In "covers the rest of the table", replace `[key("Digit0"), { cmd: "zoom", op: "preset" }],` with:

```ts
      [key("Digit0", { shiftKey: true }), { cmd: "zoom", op: "preset" }],
```

In `packages/trace-viewer/src/ui/state/view-state.test.ts`, append:

```ts
describe("Brief pin (spec §3.3, E4) and the opening view", () => {
  it("B pins the Brief over a selection; a new selection or a cleared one unpins it", () => {
    const base = initialViewState({ live: false });
    expect(base.brief).toBe(false);
    expect(reduce(base, { type: "brief/toggle" }, index)).toBe(base);
    let s = run(base, [{ type: "select", id: test.id, by: "shell" }, { type: "brief/toggle" }]);
    expect(s).toMatchObject({ selection: test.id, brief: true });
    s = run(s, [{ type: "select", id: claim.id, by: "shell" }]);
    expect(s.brief).toBe(false);
    s = run(s, [{ type: "brief/toggle" }, { type: "brief/toggle" }]);
    expect(s.brief).toBe(false);
    s = run(s, [{ type: "brief/toggle" }, { type: "select", id: null, by: "shell" }]);
    expect(s).toMatchObject({ selection: null, brief: false });
  });

  it("view switches keep the pin", () => {
    const s = run(initialViewState({ live: false }), [
      { type: "select", id: test.id, by: "shell" },
      { type: "brief/toggle" },
      { type: "view/switch", view: "console" },
      { type: "view/switch", view: "hybrid" },
    ]);
    expect(s.brief).toBe(true);
  });

  it("takes the opening view from the input, then the location, then Hybrid", () => {
    const location = { v: 1 as const, sessionId: "s", view: "canvas", level: "chapter" as const, brush: { kind: "session" as const } };
    expect(initialViewState({ live: false }).view).toBe("hybrid");
    expect(initialViewState({ live: false, location }).view).toBe("canvas");
    expect(initialViewState({ live: false, location, view: "console" }).view).toBe("console");
  });
});
```

In `packages/trace-viewer/src/ui/state/location.test.ts`, change the `view` line of `arbLocation` to:

```ts
  view: fc.option(fc.constantFrom("console", "canvas", "hybrid", "map", "surfaces"), { nil: undefined }),
```

change `const defaults = …` in "never throws and falls back to defaults" to:

```ts
    const defaults = { v: 1, sessionId: "s", level: "chapter", brush: { kind: "session" } };
```

and append inside `describe("location codec", …)`:

```ts
  it("accepts host view kinds and rejects a view that is not a lower-case word", () => {
    expect(decodeLocation({ v: 1, sessionId: "s", view: "surfaces" }, "s").view).toBe("surfaces");
    expect(decodeLocation({ v: 1, sessionId: "s", view: "console" }, "s").view).toBe("console");
    expect(decodeLocation({ v: 1, sessionId: "s", view: "Not A View" }, "s").view).toBeUndefined();
    expect(decodeLocation({ v: 1, sessionId: "s", view: "x".repeat(40) }, "s").view).toBeUndefined();
  });
```

In `packages/trace-viewer/src/ui/shell/title-bar.test.tsx`, append inside the top-level `describe`:

```ts
  it("names each view's number key in its title", () => {
    renderHarness(<TitleBar onRetry={noop} />, foldFixture("oauth"), { views: [canvas, hybrid] });
    expect(screen.getByRole("radio", { name: /Canvas/ }).getAttribute("title")).toBe("Canvas (1)");
    expect(screen.getByRole("radio", { name: /Hybrid/ }).getAttribute("title")).toBe("Hybrid (2)");
  });

  it("the embedded bar shows no title and leaves the switch to the host", () => {
    const session = foldFixture("oauth");
    const firstLine = session.meta.prompt.split(/\r?\n/)[0] ?? "";
    renderHarness(<TitleBar onRetry={noop} chrome="embedded" showSwitch={false} />, session, { views: [canvas, hybrid] });
    expect(screen.queryByRole("radiogroup", { name: "View" })).toBeNull();
    expect(screen.queryByText(firstLine)).toBeNull();
    expect(screen.getByRole("group", { name: "Follow" })).toBeTruthy();
  });
```

In `packages/trace-viewer/src/ui/shell/keyboard.test.tsx`, append inside `describe("KeyboardLayer", …)`:

```ts
  it("Shift+B pins the Brief only with a selection and announces it; Shift+0 returns the zoom to its preset", () => {
    const session = foldFixture("oauth");
    const step = session.steps[3];
    if (step === undefined) throw new Error("oauth has fewer than 4 steps");
    const port = fakePort([]);
    const h = renderHarness(<KeyHarness />, session);
    act(() => {
      h.registry.register("hybrid", port);
    });
    fireEvent.keyDown(document.body, { code: "KeyB", key: "B", shiftKey: true });
    expect(h.store.get().brief).toBe(false);
    act(() => h.store.dispatch({ type: "select", id: step.id, by: "shell" }));
    fireEvent.keyDown(document.body, { code: "KeyB", key: "B", shiftKey: true });
    expect(h.store.get().brief).toBe(true);
    expect(h.announcements.at(-1)).toBe("Brief");
    fireEvent.keyDown(document.body, { code: "KeyB", key: "B", shiftKey: true });
    expect(h.announcements.at(-1)).toBe("Inspector");
    fireEvent.keyDown(document.body, { code: "Digit0", key: ")", shiftKey: true });
    expect(port.calls).toContain("resetToPreset");
  });
```

Create `packages/trace-viewer/src/ui/shell/embedded.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStaticBundleSource } from "../../sources/static-bundle.js";
import { fixtureBundle, stubLayout, type LayoutStub } from "../../test-support/ui-harness.js";
import type { ViewerLocation } from "../state/location.js";
import { composeViews, openingView, VIEWS } from "../views/registry.js";
import { hostViewsOf, viewKeyOf, type ViewDefinition } from "../views/view-port.js";
import { TraceViewer } from "./TraceViewer.js";

let layout: LayoutStub;
beforeEach(() => {
  layout = stubLayout();
});
afterEach(() => {
  cleanup();
  layout.restore();
  vi.restoreAllMocks();
});

const surfaces: ViewDefinition = { kind: "surfaces", label: "Surfaces", icon: "view-surfaces", Component: () => <p>Surfaces body</p> };
const impostor: ViewDefinition = { kind: "canvas", label: "Impostor", icon: "view-canvas", Component: () => <p>Impostor body</p> };

function lastView(onLocation: ReturnType<typeof vi.fn>): string | undefined {
  return (onLocation.mock.calls.at(-1)?.[0] as ViewerLocation | undefined)?.view;
}

function press(code: string, key: string): void {
  fireEvent.keyDown(document.body, { code, key });
}

describe("view registry (spec §3.7, §8.5, §8.6)", () => {
  it("orders the built-in views by key and appends host views from key 4; a clashing kind is dropped", () => {
    const views = composeViews([surfaces, impostor]);
    expect(views.map((view) => view.kind)).toEqual(["console", "canvas", "hybrid", "map", "surfaces"]);
    expect(views.map((view) => viewKeyOf(view.kind, views))).toEqual([0, 1, 2, 3, 4]);
    expect(hostViewsOf(views).map((view) => view.kind)).toEqual(["surfaces"]);
    expect(composeViews(undefined)).toBe(VIEWS);
    expect(composeViews([])).toBe(VIEWS);
  });

  it("opens on the location's view, else initialView, else Console embedded and Hybrid in full chrome", () => {
    const views = composeViews([surfaces]);
    expect(openingView(views, "embedded", undefined, undefined)).toBe("console");
    expect(openingView(views, "full", undefined, undefined)).toBe("hybrid");
    expect(openingView(views, "embedded", undefined, "surfaces")).toBe("surfaces");
    expect(openingView(views, "embedded", "canvas", "surfaces")).toBe("canvas");
    expect(openingView(VIEWS, "full", "surfaces", undefined)).toBe("hybrid");
  });
});

describe("chrome (spec §8.5)", () => {
  it("full chrome keeps the title, the Outline and Hybrid", async () => {
    const bundle = fixtureBundle("oauth");
    const firstLine = bundle.session.prompt.split(/\r?\n/)[0] ?? "";
    const onLocation = vi.fn();
    render(<TraceViewer source={createStaticBundleSource(bundle)} host={{ onLocation }} />);
    await waitFor(() => expect(lastView(onLocation)).toBe("hybrid"));
    expect(screen.getByRole("navigation", { name: "Outline" })).toBeTruthy();
    expect(within(screen.getByRole("banner")).getByText(firstLine)).toBeTruthy();
  });

  it("embedded chrome drops the title and the Outline and opens on the Console", async () => {
    const bundle = fixtureBundle("oauth");
    const firstLine = bundle.session.prompt.split(/\r?\n/)[0] ?? "";
    const onLocation = vi.fn();
    render(<TraceViewer source={createStaticBundleSource(bundle)} chrome="embedded" host={{ onLocation }} />);
    await waitFor(() => expect(lastView(onLocation)).toBe("console"));
    expect(screen.queryByRole("navigation", { name: "Outline" })).toBeNull();
    expect(within(screen.getByRole("banner")).queryByText(firstLine)).toBeNull();
    expect(screen.getByRole("radiogroup", { name: "View" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Inspector" })).toBeTruthy();
  });

  it("hands the host a working switcher and takes it back on unmount", async () => {
    const onLocation = vi.fn();
    const source = createStaticBundleSource(fixtureBundle("oauth"));
    function Host({ show }: { show: boolean }) {
      const [switcher, setSwitcher] = useState<ReactNode>(null);
      return (
        <>
          <div data-testid="slot">{switcher}</div>
          {show ? <TraceViewer source={source} chrome="embedded" renderSwitch={setSwitcher} host={{ onLocation }} /> : null}
        </>
      );
    }
    const { rerender } = render(<Host show />);
    const slot = screen.getByTestId("slot");
    const group = await within(slot).findByRole("radiogroup", { name: "View" });
    expect(screen.getAllByRole("radiogroup", { name: "View" })).toHaveLength(1);
    expect(within(group).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["Console", "Canvas", "Hybrid", "Map"]);
    expect(within(group).getByRole("radio", { name: /Console/ }).getAttribute("title")).toBe("Console (0)");
    fireEvent.click(within(group).getByRole("radio", { name: /Hybrid/ }));
    await waitFor(() => expect(lastView(onLocation)).toBe("hybrid"));
    rerender(<Host show={false} />);
    expect(slot.childElementCount).toBe(0);
  });

  it("host views follow the built-ins, and keys 0 to 4 switch between all five", async () => {
    const onLocation = vi.fn();
    const hostViews = [surfaces, impostor];
    render(
      <TraceViewer
        source={createStaticBundleSource(fixtureBundle("oauth"))}
        chrome="embedded"
        hostViews={hostViews}
        host={{ onLocation }}
      />,
    );
    const group = await screen.findByRole("radiogroup", { name: "View" });
    expect(within(group).getAllByRole("radio").map((radio) => radio.textContent)).toEqual([
      "Console",
      "Canvas",
      "Hybrid",
      "Map",
      "Surfaces",
    ]);
    expect(within(group).getByRole("radio", { name: /Surfaces/ }).getAttribute("title")).toBe("Surfaces (4)");
    expect(screen.queryByText("Impostor body")).toBeNull();
    press("Digit4", "4");
    await waitFor(() => expect(lastView(onLocation)).toBe("surfaces"));
    press("Digit3", "3");
    await waitFor(() => expect(lastView(onLocation)).toBe("map"));
    expect(screen.getByRole("region", { name: "Codebase map" })).toBeTruthy();
    press("Digit2", "2");
    await waitFor(() => expect(lastView(onLocation)).toBe("hybrid"));
    press("Digit0", "0");
    await waitFor(() => expect(lastView(onLocation)).toBe("console"));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/state src/ui/shell/title-bar.test.tsx src/ui/shell/keyboard.test.tsx src/ui/shell/embedded.test.tsx`

Expected: FAIL. `keymap.test.ts` gets `{ cmd: "zoom", op: "preset" }` for Digit0; `view-state.test.ts` reads `brief` as `undefined`; `location.test.ts` still sees `view: "hybrid"` in the defaults; `embedded.test.tsx` fails to import `composeViews`.

- [ ] **Step 3: View state**

In `packages/trace-viewer/src/ui/state/view-state.ts`, find:

```ts
export type ViewKind = "canvas" | "hybrid";
```

Replace it with:

```ts
/** Built-in views (spec §8.5, §8.6); a host view uses its own lower-case kind, e.g. "surfaces". */
export type ViewKind = "console" | "canvas" | "hybrid" | "map" | (string & { readonly __host?: true });
```

Find:

```ts
  inspectorTab: InspectorTab;
  tool: Tool;
```

Replace it with:

```ts
  inspectorTab: InspectorTab;
  /** B pinned the Brief over the selection (spec §3.3, E4); a new or cleared selection unpins it. */
  brief: boolean;
  tool: Tool;
```

Find:

```ts
  | { type: "esc" }
  | { type: "seen"; seq: number };

export interface InitialViewStateInput { live: boolean; location?: ViewerLocation }
```

Replace it with:

```ts
  | { type: "esc" }
  | { type: "brief/toggle" }
  | { type: "seen"; seq: number };

export interface InitialViewStateInput {
  live: boolean;
  location?: ViewerLocation;
  /** The opening view TraceViewer resolved (openingView); wins over location.view. */
  view?: ViewKind;
}
```

Find:

```ts
    view: location?.view ?? "hybrid",
```

Replace it with:

```ts
    view: input.view ?? location?.view ?? "hybrid",
```

Find:

```ts
    inspectorTab: "summary",
    tool: "select",
```

Replace it with:

```ts
    inspectorTab: "summary",
    brief: false,
    tool: "select",
```

In `selectId`, find:

```ts
    inspectorTab: state.inspectorTab === "raw" && id !== state.selection ? "summary" : state.inspectorTab,
    follow,
```

Replace it with:

```ts
    inspectorTab: state.inspectorTab === "raw" && id !== state.selection ? "summary" : state.inspectorTab,
    brief: false,
    follow,
```

In `writeBrush`, find:

```ts
    selectionNote: keep ? base.selectionNote : null,
    playhead,
```

Replace it with:

```ts
    selectionNote: keep ? base.selectionNote : null,
    brief: keep ? base.brief : false,
    playhead,
```

In `reduce`, find:

```ts
    case "seen":
      return action.seq > state.lastSeenSeq ? { ...state, lastSeenSeq: action.seq } : state;
```

Replace it with:

```ts
    case "brief/toggle":
      // With nothing selected the Brief already fills the panel.
      return state.selection === null ? state : { ...state, brief: !state.brief };
    case "seen":
      return action.seq > state.lastSeenSeq ? { ...state, lastSeenSeq: action.seq } : state;
```

- [ ] **Step 4: Location**

In `packages/trace-viewer/src/ui/state/location.ts`, find:

```ts
export const ViewerLocationSchema = z.object({
  v: z.literal(1),
  sessionId: z.string().min(1),
  view: z.enum(["canvas", "hybrid"]).default("hybrid"),
```

Replace it with:

```ts
/** A built-in or host view kind (spec §8.5): a lower-case word. The viewer falls back to its default for a kind it lacks. */
export const ViewKindSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);

export const ViewerLocationSchema = z.object({
  v: z.literal(1),
  sessionId: z.string().min(1),
  /** Absent: TraceViewer's initialView, else its chrome's default (openingView). */
  view: ViewKindSchema.optional(),
```

- [ ] **Step 5: Key table**

Replace `packages/trace-viewer/src/ui/state/keymap.ts` with:

```ts
import type { Level } from "../../model/index.js";
import type { Tool, ViewKind } from "./view-state.js";

export interface KeyInput {
  code: string;
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  isComposing: boolean;
  /** input, textarea or [contenteditable] target. */
  editableTarget: boolean;
}
export interface KeyContext { view: ViewKind; spaceOverPannable: boolean; hasTextSelection: boolean }
export type KeyCommand =
  | { cmd: "item"; dir: 1 | -1 }
  | { cmd: "chapter"; dir: 1 | -1 }
  | { cmd: "turn"; dir: 1 | -1 }
  | { cmd: "finding"; dir: 1 | -1 }
  | { cmd: "toggle" }
  | { cmd: "esc" }
  | { cmd: "view"; view: ViewKind }
  /** Digit4… : the host view at `position` among the host views, in registration order. */
  | { cmd: "hostView"; position: number }
  | { cmd: "brief" }
  | { cmd: "level"; level: Level }
  | { cmd: "playhead"; dir: 1 | -1 }
  | { cmd: "first" }
  | { cmd: "last" }
  | { cmd: "zoom"; op: "out" | "in" | "preset" }
  | { cmd: "fit"; target: "all" | "selection" }
  | { cmd: "tool"; tool: Tool }
  | { cmd: "space"; down: boolean }
  | { cmd: "brushEdge"; edge: "from" | "to" }
  | { cmd: "brushChapter" }
  | { cmd: "search" }
  | { cmd: "help" }
  | { cmd: "region"; dir: 1 | -1 }
  | { cmd: "copyNote" };

export const ZOOM_STEP = 1.25;

/** Spec §3.7, §8.6: the number keys of the built-in views. */
export const BUILT_IN_VIEW_KEYS: Readonly<Record<string, number>> = { console: 0, canvas: 1, hybrid: 2, map: 3 };
/** Host views take this key and the ones after it, in registration order, up to 9. */
export const FIRST_HOST_VIEW_KEY = 4;

const LEVEL_OF_DIGIT: Readonly<Record<string, Level>> = { Digit1: "session", Digit2: "chapter", Digit3: "step" };

/** Pure; null when the key is not a viewer command in this context. Matches on event.code. */
export function resolveKey(input: KeyInput, context: KeyContext, phase: "down" | "up"): KeyCommand | null {
  if (input.isComposing || input.editableTarget) return null;
  const command = input.metaKey || input.ctrlKey;
  if (phase === "up") {
    return input.code === "Space" && !command && !input.altKey && context.spaceOverPannable ? { cmd: "space", down: false } : null;
  }
  if (command) {
    if (input.code === "KeyC" && !input.altKey && !input.shiftKey) return context.hasTextSelection ? null : { cmd: "copyNote" };
    return null;
  }
  if (input.altKey) {
    const level = input.shiftKey ? undefined : LEVEL_OF_DIGIT[input.code];
    return level === undefined ? null : { cmd: "level", level };
  }
  const shift = input.shiftKey;
  const hybrid = context.view === "hybrid";
  switch (input.code) {
    case "KeyJ": return shift ? { cmd: "chapter", dir: 1 } : { cmd: "item", dir: 1 };
    case "KeyK": return shift ? { cmd: "chapter", dir: -1 } : { cmd: "item", dir: -1 };
    case "BracketLeft": return shift ? (hybrid ? { cmd: "brushEdge", edge: "from" } : null) : { cmd: "turn", dir: -1 };
    case "BracketRight": return shift ? (hybrid ? { cmd: "brushEdge", edge: "to" } : null) : { cmd: "turn", dir: 1 };
    case "KeyN": return shift ? { cmd: "finding", dir: -1 } : { cmd: "finding", dir: 1 };
    case "Enter":
    case "NumpadEnter": return shift ? null : { cmd: "toggle" };
    case "Escape": return { cmd: "esc" };
    // Spec §3.7: 0 Console; the level-preset zoom moves to Shift+0, beside Shift+1 and Shift+2.
    case "Digit0": return shift ? { cmd: "zoom", op: "preset" } : { cmd: "view", view: "console" };
    case "Digit1": return shift ? { cmd: "fit", target: "all" } : { cmd: "view", view: "canvas" };
    case "Digit2": return shift ? { cmd: "fit", target: "selection" } : { cmd: "view", view: "hybrid" };
    case "Digit3": return shift ? null : { cmd: "view", view: "map" };
    case "Digit4":
    case "Digit5":
    case "Digit6":
    case "Digit7":
    case "Digit8":
    case "Digit9":
      return shift ? null : { cmd: "hostView", position: Number(input.code.slice(5)) - FIRST_HOST_VIEW_KEY };
    case "Comma": return shift ? null : { cmd: "playhead", dir: -1 };
    case "Period": return shift ? null : { cmd: "playhead", dir: 1 };
    case "KeyG": return shift ? { cmd: "last" } : { cmd: "first" };
    case "Minus": return shift ? null : { cmd: "zoom", op: "out" };
    case "Equal": return { cmd: "zoom", op: "in" };
    case "KeyV": return shift ? null : { cmd: "tool", tool: "select" };
    case "KeyH": return shift ? null : { cmd: "tool", tool: "hand" };
    case "Space": return !shift && context.spaceOverPannable ? { cmd: "space", down: true } : null;
    case "KeyB": return shift ? { cmd: "brief" } : hybrid ? { cmd: "brushChapter" } : null;
    case "Slash": return shift ? { cmd: "help" } : { cmd: "search" };
    case "F6": return { cmd: "region", dir: shift ? -1 : 1 };
    default: return null;
  }
}
```

- [ ] **Step 6: Icons**

In `packages/trace-viewer/src/ui/icons/icon-names.ts`, find:

```ts
  "view-canvas", "view-hybrid",
] as const;
```

Replace it with:

```ts
  "view-canvas", "view-hybrid", "view-console", "view-map", "view-surfaces", "brief",
] as const;
```

In `packages/trace-viewer/src/ui/icons/paths.ts`, find:

```ts
  "view-hybrid": ["M2.25 3.25h11.5M2.25 6h11.5", "M2.25 9.5h3M7.25 9.5h6.5M2.25 12.5h3M7.25 12.5h6.5"],
};
```

Replace it with:

```ts
  "view-hybrid": ["M2.25 3.25h11.5M2.25 6h11.5", "M2.25 9.5h3M7.25 9.5h6.5M2.25 12.5h3M7.25 12.5h6.5"],
  // The terminal prompt glyph (spec §3.6): a caret and a cursor line.
  "view-console": ["M3.25 4.25 6.75 8l-3.5 3.75", "M8.5 11.75h4.25"],
  // Three components and their links (spec §3.4).
  "view-map": ["M2.25 3.25h4v3h-4zM9.75 3.25h4v3h-4zM6 9.75h4v3H6z", "M4.25 6.25v1.5h7.5v-1.5M8 7.75v2"],
  "view-surfaces": ["M3.75 2.75h8.5a1 1 0 0 1 1 1v8.5a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1v-8.5a1 1 0 0 1 1-1z", "M2.75 6h10.5M6.5 6v7.25"],
  brief: ["M4 2.25h8a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9.5a1 1 0 0 1 1-1z", "M5.5 5.25h5M5.5 8h5M5.5 10.75h3"],
};
```

- [ ] **Step 7: View-port helpers, placeholders and the registry**

In `packages/trace-viewer/src/ui/views/view-port.ts`, find:

```ts
import type { SelectionId } from "../../layout/trace-index.js";
import type { IconName } from "../icons/icon-names.js";
import { useView } from "../state/store.js";
```

Replace it with:

```ts
import type { SelectionId } from "../../layout/trace-index.js";
import type { IconName } from "../icons/icon-names.js";
import { BUILT_IN_VIEW_KEYS, FIRST_HOST_VIEW_KEY } from "../state/keymap.js";
import { useView } from "../state/store.js";
```

Find:

```ts
/** The views the Shell mounts, in switch order (Canvas | Hybrid). */
export const ViewDefinitionsContext = createContext<readonly ViewDefinition[]>([]);
```

Replace it with:

```ts
/** The views the Shell mounts, in switch order: Console, Canvas, Hybrid, Map, then host views (spec §8.5). */
export const ViewDefinitionsContext = createContext<readonly ViewDefinition[]>([]);

/** Views that are not built in, in registration order. */
export function hostViewsOf(views: readonly ViewDefinition[]): ViewDefinition[] {
  return views.filter((view) => BUILT_IN_VIEW_KEYS[view.kind] === undefined);
}

/** Spec §3.7, §8.6: the number key of a view; null for a host view past key 9 or a kind not in `views`. */
export function viewKeyOf(kind: ViewKind, views: readonly ViewDefinition[]): number | null {
  const builtIn = BUILT_IN_VIEW_KEYS[kind];
  if (builtIn !== undefined) return builtIn;
  const position = hostViewsOf(views).findIndex((view) => view.kind === kind);
  const key = FIRST_HOST_VIEW_KEY + position;
  return position < 0 || key > 9 ? null : key;
}
```

Create `packages/trace-viewer/src/ui/views/placeholder/ViewPlaceholder.tsx`:

```tsx
import type { JSX } from "react";

import { Icon } from "../../icons/Icon.js";
import type { IconName } from "../../icons/icon-names.js";
import type { ViewProps } from "../view-port.js";
import styles from "./ViewPlaceholder.module.css";

function Placeholder({ icon, title, note }: { icon: IconName; title: string; note: string }): JSX.Element {
  return (
    <section className={styles.placeholder} aria-label={title}>
      <Icon name={icon} size={16} className={styles.icon} />
      <p className={styles.title}>{title}</p>
      <p className={styles.note}>{note}</p>
    </section>
  );
}

/** Holds key 0 until V-4's ConsoleView replaces it in VIEWS. */
export function ConsolePlaceholder(_props: ViewProps): JSX.Element {
  return <Placeholder icon="view-console" title="Console" note="The terminal log of this session appears here." />;
}

/** Holds key 3 until lane 06's MapView replaces it in VIEWS. */
export function MapPlaceholder(_props: ViewProps): JSX.Element {
  return (
    <Placeholder icon="view-map" title="Codebase map" note="A map of this repository appears here once it has been scanned." />
  );
}
```

Create `packages/trace-viewer/src/ui/views/placeholder/ViewPlaceholder.module.css`:

```css
.placeholder {
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 6px;
  height: 100%;
  padding: 24px;
  background: var(--tv-canvas);
  text-align: center;
}

.icon {
  color: var(--tv-ink-3);
}

.title {
  margin: 0;
  font-size: 13px;
  line-height: 18px;
  font-weight: 500;
  color: var(--tv-ink-2);
}

.note {
  margin: 0;
  max-width: 280px;
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-ink-3);
}
```

Replace `packages/trace-viewer/src/ui/views/registry.ts` with:

```ts
import type { ViewKind } from "../state/view-state.js";
import { CanvasView } from "./canvas/CanvasView.js";
import { HybridView } from "./hybrid/HybridView.js";
import { ConsolePlaceholder, MapPlaceholder } from "./placeholder/ViewPlaceholder.js";
import type { ViewDefinition } from "./view-port.js";

export type { ViewDefinition, ViewProps } from "./view-port.js";

/**
 * Switch and key order (spec §3.7, §8.6, interfaces §6.2): Console 0, Canvas 1, Hybrid 2, Map 3. The Console and Map
 * slots hold quiet placeholders until V-4 (ConsoleView) and lane 06 (MapView) replace them, so the keys never move.
 */
export const VIEWS: readonly ViewDefinition[] = [
  { kind: "console", label: "Console", icon: "view-console", Component: ConsolePlaceholder },
  { kind: "canvas", label: "Canvas", icon: "view-canvas", Component: CanvasView },
  { kind: "hybrid", label: "Hybrid", icon: "view-hybrid", Component: HybridView },
  { kind: "map", label: "Map", icon: "view-map", Component: MapPlaceholder },
];

/** true: hidden views stay mounted under <Activity mode="hidden">; the spike risk 6 ruling sets false (unmount). */
export const KEEP_HIDDEN_VIEWS_MOUNTED = true;

/** VIEWS followed by the host's views (spec §8.5). A host view whose kind is taken (built in or earlier) is dropped. */
export function composeViews(hostViews: readonly ViewDefinition[] | undefined): readonly ViewDefinition[] {
  if (hostViews === undefined || hostViews.length === 0) return VIEWS;
  const taken = new Set<string>(VIEWS.map((view) => view.kind));
  const extra: ViewDefinition[] = [];
  for (const view of hostViews) {
    if (taken.has(view.kind)) continue;
    taken.add(view.kind);
    extra.push(view);
  }
  return extra.length === 0 ? VIEWS : [...VIEWS, ...extra];
}

/**
 * The view a viewer opens on (spec §8.5, §9): the location's view, else initialView, else Console when embedded and
 * Hybrid in full chrome. A kind that `views` does not register falls back to that chrome default.
 */
export function openingView(
  views: readonly ViewDefinition[],
  chrome: "full" | "embedded",
  locationView: ViewKind | undefined,
  initialView: ViewKind | undefined,
): ViewKind {
  const fallback: ViewKind = chrome === "embedded" ? "console" : "hybrid";
  const wanted = locationView ?? initialView ?? fallback;
  return views.some((view) => view.kind === wanted) ? wanted : fallback;
}
```

- [ ] **Step 8: The view switch, the title bar and the shell**

Create `packages/trace-viewer/src/ui/shell/ViewSwitch.tsx`:

```tsx
import { useContext, useRef, type CSSProperties, type KeyboardEvent } from "react";

import { Icon } from "../icons/Icon.js";
import { useDispatch, useView, ViewStoreContext, type ViewStore } from "../state/store.js";
import { tokenStyle } from "../tokens/tokens.js";
import { viewKeyOf, ViewDefinitionsContext, type ViewDefinition } from "../views/view-port.js";
import styles from "./TitleBar.module.css";

/** WAI-ARIA radio group: the checked view is the one tab stop; arrows (wrapping), Home and End check and focus. */
export function ViewSwitch() {
  const views = useContext(ViewDefinitionsContext);
  const dispatch = useDispatch();
  const view = useView((state) => state.view);
  const radios = useRef<Array<HTMLButtonElement | null>>([]);
  if (views.length < 2) return null;
  const checked = Math.max(0, views.findIndex((definition) => definition.kind === view));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const count = views.length;
    let target: number;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") target = (checked + 1) % count;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") target = (checked - 1 + count) % count;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = count - 1;
    else return;
    event.preventDefault();
    const next = views[target];
    if (next === undefined) return;
    if (next.kind !== view) dispatch({ type: "view/switch", view: next.kind });
    radios.current[target]?.focus();
  };
  return (
    <div role="radiogroup" aria-label="View" className={styles.segmented} onKeyDown={onKeyDown}>
      {views.map((definition, position) => {
        const key = viewKeyOf(definition.kind, views);
        return (
          <button
            key={definition.kind}
            ref={(node) => {
              radios.current[position] = node;
            }}
            type="button"
            role="radio"
            aria-checked={definition.kind === view}
            aria-keyshortcuts={key === null ? undefined : String(key)}
            tabIndex={position === checked ? 0 : -1}
            className={styles.segment}
            title={key === null ? definition.label : `${definition.label} (${key})`}
            onClick={() => dispatch({ type: "view/switch", view: definition.kind })}
          >
            <Icon name={definition.icon} size={14} />
            <span>{definition.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The switcher a host places itself (TraceViewerProps.renderSwitch, deviation 8). It carries the viewer's store, view
 * list and tokens, so it works anywhere in the host's tree; its icons resolve against the Shell's sprite.
 */
export function HostViewSwitch({ store, views }: { store: ViewStore; views: readonly ViewDefinition[] }) {
  return (
    <ViewStoreContext.Provider value={store}>
      <ViewDefinitionsContext.Provider value={views}>
        <div className={styles.hostSwitch} style={tokenStyle() as CSSProperties} data-trace-viewer-switch="">
          <ViewSwitch />
        </div>
      </ViewDefinitionsContext.Provider>
    </ViewStoreContext.Provider>
  );
}
```

In `packages/trace-viewer/src/ui/shell/TitleBar.module.css`, append:

```css
.spacer {
  flex: 1;
  min-width: 0;
}

.hostSwitch {
  display: inline-flex;
  font: 400 13px/18px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: var(--tv-ink);
}
```

In `packages/trace-viewer/src/ui/shell/TitleBar.tsx`, make these edits.

Find:

```ts
import { useContext, useEffect, useRef, useState, type KeyboardEvent } from "react";
```

Replace it with:

```ts
import { useEffect, useState } from "react";
```

Find:

```ts
import { useActiveViewPort, ViewDefinitionsContext } from "../views/view-port.js";
```

Replace it with:

```ts
import { useActiveViewPort } from "../views/view-port.js";
```

Find:

```ts
import { usePopoverDismissal } from "./use-popover.js";

export interface TitleBarProps {
  onRetry(): void;
}
```

Replace it with:

```ts
import { usePopoverDismissal } from "./use-popover.js";
import { ViewSwitch } from "./ViewSwitch.js";

export interface TitleBarProps {
  onRetry(): void;
  /** "embedded": no repo, prompt or duration; the main window header shows them (spec §8.5). Default "full". */
  chrome?: "full" | "embedded";
  /** false when the host places the view switcher itself (TraceViewerProps.renderSwitch). Default true. */
  showSwitch?: boolean;
}
```

Find:

```ts
function TitleBarBody({ onRetry }: TitleBarProps) {
  const { summary, session, index, status, loadedFraction, terminal, nowT } = useSessionView();
  const views = useContext(ViewDefinitionsContext);
  const dispatch = useDispatch();
  const view = useView((state) => state.view);
  const follow = useView((state) => state.follow);
```

Replace it with:

```ts
function TitleBarBody({ onRetry, chrome = "full", showSwitch = true }: TitleBarProps) {
  const { summary, session, index, status, loadedFraction, terminal, nowT } = useSessionView();
  const embedded = chrome === "embedded";
  const dispatch = useDispatch();
  const follow = useView((state) => state.follow);
```

Delete the block from `// WAI-ARIA radio group: the checked view is the one tab stop; …` through the closing `};` of `onViewKeyDown` (the `viewRadios`, `checkedView` and `onViewKeyDown` declarations; `ViewSwitch` owns them now).

Find:

```tsx
    <div className={styles.bar}>
      <p className={styles.title} title={displayUntrusted(summary?.prompt ?? "")}>
        {summary === null ? null : (
          <>
            <span className={styles.repo}>{displayUntrusted(summary.repoName)}</span>
            <span className={styles.sep}> / </span>
            <span className={styles.prompt}>
              {summary.prompt.trim() === "" ? WAITING_FOR_PROMPT : displayUntrusted(firstLine(summary.prompt))}
            </span>
          </>
        )}
      </p>
```

Replace it with:

```tsx
    <div className={styles.bar} data-chrome={chrome}>
      {embedded ? (
        <>
          {showSwitch ? <ViewSwitch /> : null}
          <span className={styles.spacer} />
        </>
      ) : (
        <p className={styles.title} title={displayUntrusted(summary?.prompt ?? "")}>
          {summary === null ? null : (
            <>
              <span className={styles.repo}>{displayUntrusted(summary.repoName)}</span>
              <span className={styles.sep}> / </span>
              <span className={styles.prompt}>
                {summary.prompt.trim() === "" ? WAITING_FOR_PROMPT : displayUntrusted(firstLine(summary.prompt))}
              </span>
            </>
          )}
        </p>
      )}
```

Find the whole radiogroup block:

```tsx
      {views.length > 1 ? (
        <div role="radiogroup" aria-label="View" className={styles.segmented} onKeyDown={onViewKeyDown}>
```

through its closing `) : null}` (the line after `</div>` that ends the `views.map`), and replace it with:

```tsx
      {!embedded && showSwitch ? <ViewSwitch /> : null}
```

Find:

```tsx
      <span className={styles.meta}>
        {hasEvents ? <span className={styles.duration}>{formatDuration(durationMs)}</span> : null}
```

Replace it with:

```tsx
      <span className={styles.meta}>
        {hasEvents && !embedded ? <span className={styles.duration}>{formatDuration(durationMs)}</span> : null}
```

Find:

```tsx
        {statusLine === "" ? null : (
          <>
            {hasEvents ? <span aria-hidden="true"> · </span> : null}
            <span>{statusLine}</span>
          </>
        )}
```

Replace it with:

```tsx
        {statusLine === "" || (embedded && status.kind === "ready" && loadedFraction >= 1) ? null : (
          <>
            {hasEvents && !embedded ? <span aria-hidden="true"> · </span> : null}
            <span>{statusLine}</span>
          </>
        )}
```

In `packages/trace-viewer/src/ui/shell/Shell.tsx`, find:

```ts
export interface ShellProps {
  sessionId: string;
  host: ViewerHost;
  controller: DataController;
  location?: ViewerLocation;
  /** Overrides "running opens in Live" (the selftest drips in Review). */
  initialFollow?: boolean;
}

const EMPTY_SCALE_INPUT = { originMs: 0, work: [], awaitingFrom: [] } as const;

const SHELL_VIEWS: readonly ViewDefinition[] = VIEWS;
const KEEP_HIDDEN = KEEP_HIDDEN_VIEWS_MOUNTED;
```

Replace it with:

```ts
export interface ShellProps {
  sessionId: string;
  host: ViewerHost;
  controller: DataController;
  location?: ViewerLocation;
  /** Overrides "running opens in Live" (the selftest drips in Review). */
  initialFollow?: boolean;
  /** "embedded" drops the title and the Outline (spec §8.5, deviation 7). Default "full". */
  chrome?: "full" | "embedded";
  /** Built-in then host views (TraceViewer composes them). Default VIEWS. */
  views?: readonly ViewDefinition[];
  /** false when the host places the view switcher. Default true. */
  showSwitch?: boolean;
}

const EMPTY_SCALE_INPUT = { originMs: 0, work: [], awaitingFrom: [] } as const;

const KEEP_HIDDEN = KEEP_HIDDEN_VIEWS_MOUNTED;
```

Find:

```ts
export function Shell({ sessionId, host, controller, location, initialFollow }: ShellProps) {
  const store = useViewStore();
```

Replace it with:

```ts
export function Shell({
  sessionId,
  host,
  controller,
  location,
  initialFollow,
  chrome = "full",
  views = VIEWS,
  showSwitch = true,
}: ShellProps) {
  const store = useViewStore();
```

Find:

```tsx
            <ViewDefinitionsContext.Provider value={SHELL_VIEWS}>
              <LiveRegion>
                <div className={styles.grid}>
                  <header className={styles.title} data-region="title">
                    <TitleBar onRetry={() => controller.retry()} />
                  </header>
                  <nav className={styles.outline} aria-label="Outline" data-region="outline">
                    <Outline hiddenRows={hiddenRows} />
                  </nav>
                  <main className={styles.main} data-region="main" tabIndex={-1}>
                    <ViewSlot views={SHELL_VIEWS} keepHiddenMounted={KEEP_HIDDEN} />
                  </main>
```

Replace it with:

```tsx
            <ViewDefinitionsContext.Provider value={views}>
              <LiveRegion>
                <div className={styles.grid} data-chrome={chrome}>
                  <header className={styles.title} data-region="title">
                    <TitleBar onRetry={() => controller.retry()} chrome={chrome} showSwitch={showSwitch} />
                  </header>
                  {chrome === "full" ? (
                    <nav className={styles.outline} aria-label="Outline" data-region="outline">
                      <Outline hiddenRows={hiddenRows} />
                    </nav>
                  ) : null}
                  <main className={styles.main} data-region="main" tabIndex={-1}>
                    <ViewSlot views={views} keepHiddenMounted={KEEP_HIDDEN} />
                  </main>
```

In `packages/trace-viewer/src/ui/shell/Shell.module.css`, find:

```css
@container (max-width: 1179px) {
  .grid {
    grid-template-columns: 200px minmax(0, 1fr) 248px;
  }
}
```

Replace it with:

```css
@container (max-width: 1179px) {
  .grid {
    grid-template-columns: 200px minmax(0, 1fr) 248px;
  }
}

/* Embedded in the main window (spec §8.5): a 36 px view bar, the active view and the Brief or Inspector. */
.grid[data-chrome="embedded"] {
  grid-template-columns: minmax(0, 1fr) 300px;
  grid-template-rows: 36px minmax(0, 1fr);
  grid-template-areas:
    "title title"
    "main inspector";
}

@container (max-width: 1179px) {
  .grid[data-chrome="embedded"] {
    grid-template-columns: minmax(0, 1fr) 264px;
  }
}
```

- [ ] **Step 9: `TraceViewer`, the host and the exports**

Replace `packages/trace-viewer/src/ui/shell/TraceViewer.tsx` with:

```tsx
import { useEffect, useLayoutEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";

import { TRACE_LIVE_POLL_MS } from "@jevcode/contracts";

import { emptyTraceIndex } from "../../layout/trace-index.js";
import type { TraceSource } from "../../source.js";
import type { ViewerLocation } from "../state/location.js";
import { createViewStore, ViewStoreContext } from "../state/store.js";
import { initialViewState, type ViewKind } from "../state/view-state.js";
import base from "../tokens/base.module.css";
import { tokenStyle } from "../tokens/tokens.js";
import { composeViews, openingView } from "../views/registry.js";
import type { ViewDefinition } from "../views/view-port.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { createDataController } from "./data-controller.js";
import type { ViewerHost } from "./host.js";
import { Shell } from "./Shell.js";
import { HostViewSwitch } from "./ViewSwitch.js";

export type ViewerChrome = "full" | "embedded";

export interface TraceViewerProps {
  source: TraceSource;
  host?: ViewerHost;
  location?: ViewerLocation;
  /** Poll interval while not terminal; default TRACE_LIVE_POLL_MS (1,000). */
  pollMs?: number;
  /** Overrides "running opens in Live"; the dev-host selftest passes false. */
  initialFollow?: boolean;
  /** "embedded": the main window places the viewer under its own header: no title, no Outline (spec §8.5). Default "full". */
  chrome?: ViewerChrome;
  /** Host-registered views, appended after the built-in views (spec §8.5). Pass a stable array. */
  hostViews?: readonly ViewDefinition[];
  /** The opening view when the location names none; default "console" when embedded, else "hybrid". */
  initialView?: ViewKind;
  /** Embedded only: receives the view switcher (deviation 8), and null on unmount. Pass a stable function. */
  renderSwitch?: (switcher: ReactNode) => void;
}

/** The viewer's only entry point. Reads through `source`; writes nothing. */
export function TraceViewer({
  source,
  host,
  location,
  pollMs,
  initialFollow,
  chrome = "full",
  hostViews,
  initialView,
  renderSwitch,
}: TraceViewerProps) {
  const views = useMemo(() => composeViews(hostViews), [hostViews]);
  const [controller] = useState(() => createDataController({ source, pollMs: pollMs ?? TRACE_LIVE_POLL_MS }));
  const [store] = useState(() =>
    createViewStore(
      initialViewState({ live: false, location, view: openingView(views, chrome, location?.view, initialView) }),
      emptyTraceIndex(source.sessionId),
    ),
  );
  const shellHost = useMemo<ViewerHost>(() => host ?? {}, [host]);
  const hostPlacesSwitch = chrome === "embedded" && renderSwitch !== undefined;

  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);

  useLayoutEffect(() => {
    if (!hostPlacesSwitch || renderSwitch === undefined) return undefined;
    renderSwitch(<HostViewSwitch store={store} views={views} />);
    return () => renderSwitch(null);
  }, [hostPlacesSwitch, renderSwitch, store, views]);

  return (
    <ViewStoreContext.Provider value={store}>
      <ErrorBoundary
        region="Trace viewer"
        onError={(error) =>
          shellHost.onDiagnostics?.({ errors: [`Trace viewer: ${error.message}`], maxAnchorDriftPx: 0, selectedTitle: null })
        }
        fallbackClassName={base.root}
        fallbackStyle={tokenStyle() as CSSProperties}
      >
        <Shell
          sessionId={source.sessionId}
          host={shellHost}
          controller={controller}
          location={location}
          initialFollow={initialFollow}
          chrome={chrome}
          views={views}
          showSwitch={!hostPlacesSwitch}
        />
      </ErrorBoundary>
    </ViewStoreContext.Provider>
  );
}
```

In `packages/trace-viewer/src/ui/shell/host.ts`, find:

```ts
export interface ViewerDiagnostics {
```

Replace it with:

```ts
export interface AnswerDecisionRequest {
  decisionId: string;
  optionId: string;
}

export interface ViewerDiagnostics {
```

Find:

```ts
  /** Dev-host selftest only; enables anchor-drift measurement. */
  onDiagnostics?(diagnostics: ViewerDiagnostics): void;
}
```

Replace it with:

```ts
  /** Dev-host selftest only; enables anchor-drift measurement. */
  onDiagnostics?(diagnostics: ViewerDiagnostics): void;
  /** Main window only (spec §9): answers a pending decision through the host's allowlisted dispatch. */
  answerDecision?(request: AnswerDecisionRequest): void | Promise<void>;
  /** Main window only: opens the read-only trace window for this session. */
  openTraceWindow?(): void;
  /** Main window only (spec §6.6): Retry after "Codebase map unavailable". */
  rescanOverview?(): void;
}
```

In `packages/trace-viewer/src/index.ts`, find:

```ts
export { TraceViewer, type TraceViewerProps } from "./ui/shell/TraceViewer.js";
export type { ViewerHost, RequestChangesRequest, ViewerReadyInfo, ViewerDiagnostics } from "./ui/shell/host.js";
```

Replace it with:

```ts
export { TraceViewer, type TraceViewerProps, type ViewerChrome } from "./ui/shell/TraceViewer.js";
export type {
  ViewerHost,
  RequestChangesRequest,
  ViewerReadyInfo,
  ViewerDiagnostics,
  AnswerDecisionRequest,
} from "./ui/shell/host.js";
// Host views (spec §8.5): a host view reads the viewer's store and session through these.
export type { ViewDefinition, ViewProps } from "./ui/views/view-port.js";
export type { ViewKind } from "./ui/state/view-state.js";
export type { IconName } from "./ui/icons/icon-names.js";
export { useDispatch, useView } from "./ui/state/store.js";
export { useSessionView, type SessionView } from "./ui/shell/session-context.js";
```

- [ ] **Step 10: Keyboard layer and shortcut sheet**

In `packages/trace-viewer/src/ui/shell/KeyboardLayer.tsx`, find:

```ts
import { useViewPortRegistry, ViewDefinitionsContext } from "../views/view-port.js";
```

Replace it with:

```ts
import { hostViewsOf, useViewPortRegistry, ViewDefinitionsContext } from "../views/view-port.js";
```

Find:

```ts
  hasTextSelection,
  isEditableTarget,
  nextInOrder,
```

Replace it with:

```ts
  hasTextSelection,
  isEditableTarget,
  isFocusable,
  nextInOrder,
```

Find:

```ts
        case "view": {
          const definition = definitions.find((item) => item.kind === command.view);
          if (definition === undefined || state.view === command.view) return;
          store.dispatch({ type: "view/switch", view: command.view });
          latest.current.announce(`${definition.label} view`);
          return;
        }
```

Replace it with:

```ts
        case "view": {
          const definition = definitions.find((item) => item.kind === command.view);
          if (definition === undefined || state.view === command.view) return;
          store.dispatch({ type: "view/switch", view: command.view });
          latest.current.announce(`${definition.label} view`);
          return;
        }
        case "hostView": {
          const definition = hostViewsOf(definitions)[command.position];
          if (definition === undefined || state.view === definition.kind) return;
          store.dispatch({ type: "view/switch", view: definition.kind });
          latest.current.announce(`${definition.label} view`);
          return;
        }
        case "brief": {
          if (state.selection === null) return;
          store.dispatch({ type: "brief/toggle" });
          latest.current.announce(store.get().brief ? "Brief" : "Inspector");
          return;
        }
```

Find:

```ts
        case "search":
          root.querySelector<HTMLInputElement>("[data-outline-search]")?.focus();
          return;
```

Replace it with:

```ts
        case "search": {
          // The Outline's field in full chrome; a view's own field (data-view-search) when the Outline is absent.
          const fields = root.querySelectorAll<HTMLInputElement>("[data-outline-search], [data-view-search]");
          Array.from(fields).find(isFocusable)?.focus();
          return;
        }
```

In `packages/trace-viewer/src/ui/shell/ShortcutSheet.tsx`, find:

```ts
  ["1 / 2", "Canvas / Hybrid"],
```

Replace it with:

```ts
  ["0 / 1 / 2 / 3", "Console / Canvas / Hybrid / Map"],
  ["4", "Surfaces (main window)"],
  ["Shift+B", "Brief or Inspector for the selection"],
```

Find:

```ts
  ["- / = / 0", "Zoom out / in / back to the level preset"],
```

Replace it with:

```ts
  ["- / = / Shift+0", "Zoom out / in / back to the level preset"],
```

- [ ] **Step 11: Run the tests to verify they pass**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/state src/ui/shell src/ui/icons src/ui/views/view-switch.test.tsx`

Expected: PASS. `icons.test.tsx` covers the four new symbols (one symbol per name, the path regex). If a test elsewhere counted two radios in the view switch, it now sees four in full chrome; update that count only, never the switch behavior.

- [ ] **Step 12: Typecheck, lint, the package suite and the dev host**

Run the package typecheck and lint. Then build the viewer and typecheck the dev host, which imports `TraceViewer` from the package dist:

```bash
perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer build
perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-trace-viewer-dev typecheck
```

Expected: both exit 0. Run the package suite in the background; expect no failures.

- [ ] **Step 13: Visual sanity of the full chrome**

The title bar now shows four segments (Console, Canvas, Hybrid, Map). Run the existing smoke in the background and inspect its screenshots:

```bash
(perl -e 'alarm 590; exec @ARGV' node apps/trace-viewer-dev/scripts/smoke.mjs --views hybrid,canvas --port 4181 > .superpowers/smoke-v2.log 2>&1; echo "EXIT=$?" >> .superpowers/smoke-v2.log) &
```

Poll `tail -3 .superpowers/smoke-v2.log` every 15 s until it prints `SMOKE_OK 4 screenshots` or an `EXIT=` line (a nonzero exit or `SMOKE_FAIL` means the smoke failed). Open `apps/trace-viewer-dev/.smoke/hybrid-1440.png` and `hybrid-1000.png` with the Read tool and check against `docs/superpowers/specs/2026-09-28-trace-viewer-mockups/hybrid-1440.png`: the segmented control holds four segments and still fits at 1000 px without pushing the zoom control off the bar; nothing else moved. If it overflows at 1000 px, hide the segment labels below 1180 px (`@container (max-width: 1179px) { .segment span { display: none; } }` in `TitleBar.module.css`) and rerun.

- [ ] **Step 14: Commit**

```bash
git add packages/trace-viewer/src/ui/state/view-state.ts packages/trace-viewer/src/ui/state/view-state.test.ts \
  packages/trace-viewer/src/ui/state/location.ts packages/trace-viewer/src/ui/state/location.test.ts \
  packages/trace-viewer/src/ui/state/keymap.ts packages/trace-viewer/src/ui/state/keymap.test.ts \
  packages/trace-viewer/src/ui/views/view-port.ts packages/trace-viewer/src/ui/views/registry.ts \
  packages/trace-viewer/src/ui/views/placeholder/ViewPlaceholder.tsx \
  packages/trace-viewer/src/ui/views/placeholder/ViewPlaceholder.module.css \
  packages/trace-viewer/src/ui/icons/icon-names.ts packages/trace-viewer/src/ui/icons/paths.ts \
  packages/trace-viewer/src/ui/shell/ViewSwitch.tsx packages/trace-viewer/src/ui/shell/TitleBar.tsx \
  packages/trace-viewer/src/ui/shell/TitleBar.module.css packages/trace-viewer/src/ui/shell/Shell.tsx \
  packages/trace-viewer/src/ui/shell/Shell.module.css packages/trace-viewer/src/ui/shell/TraceViewer.tsx \
  packages/trace-viewer/src/ui/shell/KeyboardLayer.tsx packages/trace-viewer/src/ui/shell/ShortcutSheet.tsx \
  packages/trace-viewer/src/ui/shell/host.ts packages/trace-viewer/src/index.ts \
  packages/trace-viewer/src/ui/shell/title-bar.test.tsx packages/trace-viewer/src/ui/shell/keyboard.test.tsx \
  packages/trace-viewer/src/ui/shell/embedded.test.tsx
git commit -m "feat(trace-viewer): console and map slots, host views, embedded chrome and view keys 0-4"
```

---

# Part B — Console and Brief (wave W1)

### Task V-0: Mockups: main window on Console, Brief v0 (HUMAN H1)

**Files:**
- Create: `docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/console-main.html`
- Create: `docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/console-states.html`
- Create: `docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/console-main-1440.png`, `console-main-1000.png`, `console-states-1440.png`, `console-states-1000.png` (rendered)
- Create or modify: `docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/README.md` (lane 06 P-0 and lane 07 S-0 add their own sections; keep both sides on merge)

**Interfaces:**
- Consumes: the viewer tokens (viewer spec §7.12 table), the icon paths in `packages/trace-viewer/src/ui/icons/paths.ts`, the person's visual taste (`/Users/jwpark/.claude/projects/-Users-jwpark-Projects-jevcode/memory/ui-visual-taste.md`: Figma-grade, light first, restrained color, few borders, icons and mini graphics over text).
- Produces: the approved Phase A mockups that V-4, V-5, V-6 and lane 03's D-3 and D-4 compare against; the H1 record in the README.

The mockups show real Console row kinds with real data shapes, so the implementation can be checked against them row by row. They are static HTML with inline CSS and inline SVG (no external fonts or scripts), rendered headlessly.

- [ ] **Step 1: Write the main-window mockup**

Create `docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/console-main.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Phase A · main window on the Console</title>
<style>
:root{--canvas:#F4F5F7;--panel:#FFFFFF;--ink:#16181D;--ink-2:#5B616E;--ink-3:#676D78;--ink-4:#9AA0AB;--hair:rgb(16 24 40 / .07);--fill:rgb(16 24 40 / .04);--fill-2:rgb(16 24 40 / .07);--accent:#2F6BFF;--accent-soft:rgb(47 107 255 / .10);--accent-ink:#1F5EF0;--bad:#E5484D;--bad-soft:rgb(229 72 77 / .09);--bad-ink:#CE2C31;--good:#2E9E6A;--shadow:0 1px 2px rgb(16 24 40 / .06),0 4px 12px rgb(16 24 40 / .05);--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;--mono:ui-monospace,"SF Mono",Menlo,monospace}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{background:var(--panel);color:var(--ink);font:400 13px/18px var(--sans);font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
svg.i{width:14px;height:14px;flex:none;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
svg.i16{width:16px;height:16px}
.mono{font-family:var(--mono);font-size:12px;line-height:18px}
.el{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.app{display:grid;grid-template-rows:44px minmax(0,1fr) 24px;height:100vh;min-width:1000px}
/* header */
.hdr{display:flex;align-items:center;gap:12px;padding:0 16px;box-shadow:inset 0 -1px 0 var(--hair)}
.logo{font-weight:600;letter-spacing:-.01em}
.crumb{display:flex;align-items:center;gap:8px;flex:1;min-width:0}
.crumb .repo{color:var(--ink-3)}
.crumb .task{font-weight:500}
.chip{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border-radius:12px;background:var(--fill);color:var(--ink-2);font-size:12px;white-space:nowrap}
.chip .dot{width:6px;height:6px;border-radius:50%;background:var(--accent)}
.btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:7px;color:var(--ink-2);font-size:12px}
/* body */
.body{display:grid;grid-template-columns:220px minmax(0,1fr);min-height:0}
.side{display:flex;flex-direction:column;gap:18px;padding:12px 10px;box-shadow:inset -1px 0 0 var(--hair);min-height:0;overflow:hidden}
.side h3{padding:0 8px 4px;font-size:12px;font-weight:500;color:var(--ink-3)}
.side .item{display:flex;align-items:center;gap:8px;height:30px;padding:0 8px;border-radius:7px;color:var(--ink-2)}
.side .item.on{background:var(--accent-soft);color:var(--accent-ink)}
.side .item .meta{margin-left:auto;font-size:12px;color:var(--ink-3)}
/* workspace */
.work{display:grid;grid-template-rows:36px minmax(0,1fr) auto;min-width:0;min-height:0}
.vbar{display:flex;align-items:center;gap:10px;padding:0 12px;box-shadow:inset 0 -1px 0 var(--hair)}
.seg{display:inline-flex;gap:2px;padding:2px;border-radius:7px;background:var(--fill)}
.seg span{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border-radius:5px;color:var(--ink-2);font-size:12px;white-space:nowrap}
.seg .on{background:var(--panel);color:var(--ink);box-shadow:var(--shadow)}
.seg kbd{font:inherit;font-size:11px;color:var(--ink-4)}
.grow{flex:1}
.split{display:grid;grid-template-columns:minmax(0,1fr) 300px;min-height:0}
/* console */
.console{position:relative;display:flex;flex-direction:column;min-width:0;min-height:0}
.cbar{display:flex;align-items:center;gap:8px;height:32px;padding:0 16px;color:var(--ink-3);font-size:12px}
.search{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;border-radius:6px;background:var(--fill);width:180px}
.log{flex:1;min-height:0;overflow:hidden;padding:4px 0 24px;background:linear-gradient(var(--hair),var(--hair)) 25px 0/1px 100% no-repeat}
.row{display:grid;grid-template-columns:20px minmax(0,1fr) auto;column-gap:10px;padding:3px 16px 3px 15px;color:var(--ink-2)}
.row.sel{background:var(--accent-soft)}
.g{display:grid;place-items:center;height:18px;background:var(--panel);color:var(--ink-3);font-family:var(--mono);font-size:12px}
.row.sel .g{background:transparent}
.prompt{color:var(--ink);font-weight:500}
.tag{margin-left:8px;font-size:12px;font-weight:400;color:var(--ink-3)}
.prose{white-space:normal}
.dim{color:var(--ink-3)}
.line{display:flex;align-items:center;gap:8px;min-width:0}
.meta{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--ink-3);white-space:nowrap}
.out{grid-column:2/4;margin-top:2px;padding:2px 0 2px 10px;box-shadow:inset 1px 0 0 var(--hair);color:var(--ink-3);white-space:pre}
.badink{color:var(--bad-ink)}
.db{display:inline-flex;gap:2px;height:6px}
.db i{display:block;height:6px;border-radius:1.5px}
.db .a{background:var(--ink-2)}
.db .r{box-shadow:inset 0 0 0 1.25px var(--ink-3)}
.dots{display:inline-flex;gap:3px;align-items:center}
.dots i{width:5px;height:5px;border-radius:50%;background:var(--good)}
.dots i.f{width:7px;height:7px;background:var(--bad)}
.du{display:inline-flex;align-items:center;gap:0}
.du i{display:block;height:6px;border-radius:3px;background:var(--ink-3)}
.du i.run{background:none;box-shadow:inset 0 0 0 1.25px var(--ink-4);border-radius:0 3px 3px 0}
.rule{grid-column:1/4;display:flex;align-items:center;gap:8px;padding:6px 0;font-size:12px;color:var(--ink-3)}
.rule:before,.rule:after{content:"";flex:1;height:1px;background:var(--hair)}
.decide{grid-column:1/4;margin:6px 0;padding:10px 12px;border-radius:9px;background:var(--accent-soft);color:var(--ink)}
.decide .q{display:flex;align-items:center;gap:8px;font-weight:500}
.decide .why{margin:2px 0 0 22px;font-size:12px;color:var(--ink-2)}
.opts{display:flex;gap:6px;margin:8px 0 0 22px}
.opt{height:26px;padding:0 10px;border:0;border-radius:6px;background:var(--panel);box-shadow:var(--shadow);color:var(--ink);font:inherit;font-size:12px}
.opt.focus{outline:2px solid var(--accent);outline-offset:1px}
.flag{font-size:12px;color:var(--ink-2)}
/* brief */
.brief{display:flex;flex-direction:column;gap:18px;padding:14px 16px;box-shadow:inset 1px 0 0 var(--hair);min-height:0;overflow:hidden}
.bh{display:flex;align-items:center;gap:8px;font-weight:600}
.bh .sub{margin-left:auto;font-size:12px;font-weight:400;color:var(--ink-3)}
.sec h4{display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:12px;font-weight:500;color:var(--ink-3)}
.now{display:flex;flex-direction:column;gap:8px}
.nowrow{display:flex;align-items:center;gap:8px;min-width:0}
.nowrow .t{flex:1}
.card{padding:10px 12px;border-radius:9px;background:var(--accent-soft)}
.card .q{display:flex;gap:8px;font-weight:500}
.card .s{margin:4px 0 0 22px;font-size:12px;color:var(--accent-ink)}
.chg{display:flex;flex-direction:column}
.chg .c{display:grid;grid-template-columns:16px minmax(0,1fr) auto auto 14px;align-items:center;column-gap:8px;height:30px;padding:0 6px;margin:0 -6px;border-radius:6px;color:var(--ink-2)}
.chg .c .t{color:var(--ink)}
.empty{display:flex;gap:10px;align-items:flex-start;padding:12px;border-radius:9px;background:var(--fill);color:var(--ink-3);font-size:12px;line-height:16px}
.empty b{display:block;font-weight:500;color:var(--ink-2)}
/* prompt dock */
.dock{display:flex;flex-direction:column;gap:6px;padding:8px 16px 12px;box-shadow:inset 0 1px 0 var(--hair)}
.queued{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--ink-3)}
.queued .x{margin-left:auto}
.input{display:grid;grid-template-columns:16px minmax(0,1fr);gap:8px;min-height:44px;padding:10px 12px;border-radius:10px;background:var(--panel);box-shadow:var(--shadow)}
.input .caret{font-family:var(--mono);color:var(--accent)}
.input .ph{font-family:var(--mono);font-size:12px;color:var(--ink-3)}
.dockbar{display:flex;align-items:center;gap:12px;font-size:12px;color:var(--ink-3)}
.dockbar .mode{display:inline-flex;align-items:center;gap:4px;color:var(--ink-2)}
.send{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:6px;background:var(--accent-ink);color:#fff}
.status{display:flex;align-items:center;gap:12px;padding:0 16px;font-size:12px;color:var(--ink-3);box-shadow:inset 0 1px 0 var(--hair)}
@media (max-width:1179px){.body{grid-template-columns:200px minmax(0,1fr)}.split{grid-template-columns:minmax(0,1fr) 264px}.seg span b{display:none}.search{width:120px}}
</style>
</head>
<body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
<symbol id="i-console" viewBox="0 0 16 16"><path d="M3.25 4.25 6.75 8l-3.5 3.75"/><path d="M8.5 11.75h4.25"/></symbol>
<symbol id="i-canvas" viewBox="0 0 16 16"><path d="M2.75 3.25h4.5v4h-4.5zM8.75 8.75h4.5v4h-4.5z"/><path d="M7.25 5.25h1.5a1.25 1.25 0 0 1 1.25 1.25v2.25"/></symbol>
<symbol id="i-hybrid" viewBox="0 0 16 16"><path d="M2.25 3.25h11.5M2.25 6h11.5"/><path d="M2.25 9.5h3M7.25 9.5h6.5M2.25 12.5h3M7.25 12.5h6.5"/></symbol>
<symbol id="i-map" viewBox="0 0 16 16"><path d="M2.25 3.25h4v3h-4zM9.75 3.25h4v3h-4zM6 9.75h4v3H6z"/><path d="M4.25 6.25v1.5h7.5v-1.5M8 7.75v2"/></symbol>
<symbol id="i-surfaces" viewBox="0 0 16 16"><path d="M3.75 2.75h8.5a1 1 0 0 1 1 1v8.5a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1v-8.5a1 1 0 0 1 1-1z"/><path d="M2.75 6h10.5M6.5 6v7.25"/></symbol>
<symbol id="i-brief" viewBox="0 0 16 16"><path d="M4 2.25h8a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9.5a1 1 0 0 1 1-1z"/><path d="M5.5 5.25h5M5.5 8h5M5.5 10.75h3"/></symbol>
<symbol id="i-live" viewBox="0 0 16 16"><path d="M6.75 8a1.25 1.25 0 1 0 2.5 0a1.25 1.25 0 1 0-2.5 0"/><path d="M4.75 4.75a4.6 4.6 0 0 0 0 6.5M11.25 4.75a4.6 4.6 0 0 1 0 6.5"/></symbol>
<symbol id="i-clock" viewBox="0 0 16 16"><path d="M2 8a6 6 0 1 0 12 0a6 6 0 1 0-12 0"/><path d="M8 4.75V8l2.25 1.5"/></symbol>
<symbol id="i-search" viewBox="0 0 16 16"><path d="M2.75 7a4.25 4.25 0 1 0 8.5 0a4.25 4.25 0 1 0-8.5 0"/><path d="M10.25 10.25l3.5 3.5"/></symbol>
<symbol id="i-term" viewBox="0 0 16 16"><path d="M4 2.75h8a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6.5a2 2 0 0 1 2-2z"/><path d="M5 6.25 7 8l-2 1.75M8.75 10h2.5"/></symbol>
<symbol id="i-edit" viewBox="0 0 16 16"><path d="M7.75 13.25H4.5A1.5 1.5 0 0 1 3 11.75v-8a1.5 1.5 0 0 1 1.5-1.5h4l3 3v1.5"/><path d="M12.4 8.1l1.5 1.5-4.4 4.4H8v-1.5z"/></symbol>
<symbol id="i-test" viewBox="0 0 16 16"><path d="M5.75 2.25h4.5M6.75 2.25v4.1L3.3 12.1a1.1 1.1 0 0 0 .95 1.65h7.5a1.1 1.1 0 0 0 .95-1.65L9.25 6.35v-4.1M4.9 9.75h6.2"/></symbol>
<symbol id="i-fork" viewBox="0 0 16 16"><path d="M3 3.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M10 3.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M6.5 12.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0"/><path d="M4.5 5v.75A2.25 2.25 0 0 0 6.75 8h2.5a2.25 2.25 0 0 0 2.25-2.25V5M8 8v3"/></symbol>
<symbol id="i-flag" viewBox="0 0 16 16"><path d="M3.5 14V2.5M3.5 3h8.5l-2 3 2 3H3.5"/></symbol>
<symbol id="i-route" viewBox="0 0 16 16"><path d="M2 12.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M11 3.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0"/><path d="M3.5 11V7a2 2 0 0 1 2-2h4a1.5 1.5 0 0 0 1.5-1.5"/></symbol>
<symbol id="i-list" viewBox="0 0 16 16"><path d="M6.5 4.25h7M6.5 8h7M6.5 11.75h7"/></symbol>
<symbol id="i-pkg" viewBox="0 0 16 16"><path d="M8 1.75l5.5 3v6.5L8 14.25l-5.5-3v-6.5z"/><path d="M2.5 4.75 8 7.75l5.5-3M8 7.75v6.5"/></symbol>
<symbol id="i-check" viewBox="0 0 16 16"><path d="M3.5 8.25l3 3 6-6.5"/></symbol>
<symbol id="i-chev" viewBox="0 0 16 16"><path d="M4.75 6.5 8 9.75l3.25-3.25"/></symbol>
<symbol id="i-chev-r" viewBox="0 0 16 16"><path d="M6.5 4.75 9.75 8 6.5 11.25"/></symbol>
</svg>
<div class="app">
  <header class="hdr">
    <span class="logo">jevcode</span>
    <div class="crumb el">
      <span class="repo">acme-web</span><span class="repo">/</span>
      <span class="task el">Add Google OAuth login while preserving existing email and password accounts</span>
    </div>
    <span class="chip"><span class="dot"></span>Working · 4 m 12 s</span>
    <span class="btn"><svg class="i"><use href="#i-hybrid"/></svg>Trace</span>
  </header>
  <div class="body">
    <aside class="side">
      <div><h3>Recent repos</h3>
        <div class="item on"><svg class="i"><use href="#i-list"/></svg><span class="el">acme-web</span></div>
        <div class="item"><svg class="i"><use href="#i-list"/></svg><span class="el">billing-service</span></div>
      </div>
      <div><h3>Sessions</h3>
        <div class="item on"><svg class="i"><use href="#i-live"/></svg><span class="el">Google OAuth login</span><span class="meta">now</span></div>
        <div class="item"><svg class="i"><use href="#i-check"/></svg><span class="el">Rate limit the API</span><span class="meta">2 h</span></div>
        <div class="item"><svg class="i"><use href="#i-check"/></svg><span class="el">Schema for invoices</span><span class="meta">1 d</span></div>
      </div>
      <div class="grow"></div>
      <div class="item"><svg class="i"><use href="#i-list"/></svg>Agent settings</div>
    </aside>
    <main class="work">
      <div class="vbar">
        <div class="seg" role="radiogroup" aria-label="View">
          <span class="on"><svg class="i"><use href="#i-console"/></svg><b>Console</b><kbd>0</kbd></span>
          <span><svg class="i"><use href="#i-canvas"/></svg><b>Canvas</b><kbd>1</kbd></span>
          <span><svg class="i"><use href="#i-hybrid"/></svg><b>Hybrid</b><kbd>2</kbd></span>
          <span><svg class="i"><use href="#i-map"/></svg><b>Map</b><kbd>3</kbd></span>
          <span><svg class="i"><use href="#i-surfaces"/></svg><b>Surfaces</b><kbd>4</kbd></span>
        </div>
        <div class="grow"></div>
        <div class="seg"><span><svg class="i"><use href="#i-clock"/></svg>Review</span><span class="on"><svg class="i"><use href="#i-live"/></svg>Live</span></div>
        <span class="btn" title="Brief (B)"><svg class="i"><use href="#i-brief"/></svg>Brief</span>
      </div>
      <div class="split">
        <section class="console" aria-label="Console">
          <div class="cbar"><span class="grow">212 steps</span><span class="search"><svg class="i"><use href="#i-search"/></svg>Search</span></div>
          <div class="log">
            <div class="row"><span class="g">›</span><span class="prompt">Add Google OAuth login while preserving existing email and password accounts.</span><span></span></div>
            <div class="row"><span class="g">·</span><span class="prose">I'll add a Google provider beside the credentials flow and link accounts by verified email, then run the auth tests.</span><span></span></div>
            <div class="row"><span class="g">·</span><span class="dim">thinking · 2.3 s</span><span class="meta"><svg class="i"><use href="#i-chev-r"/></svg></span></div>
            <div class="row"><span class="g">●</span><span class="line"><span class="mono">search_issues</span><span class="mono dim el">"oauth linking"</span></span><span class="meta"><svg class="i"><use href="#i-check"/></svg>0.8 s</span></div>
            <div class="row"><span class="g">◦</span><span class="dim">read 3 files</span><span class="meta"><svg class="i"><use href="#i-chev-r"/></svg></span></div>
            <div class="row"><span class="g">$</span><span class="mono">pnpm add google-auth-library</span><span class="meta">exit 0 · 4.1 s</span>
              <span class="out mono">Packages: +3
Progress: resolved 412, reused 409, downloaded 3, added 3, done
dependencies:
+ google-auth-library 9.15.0</span></div>
            <div class="row"><span class="g">✎</span><span class="line"><span class="mono el">src/auth/google.ts</span></span><span class="meta"><span class="db"><i class="a" style="width:48px"></i></span>+86 −0</span></div>
            <div class="row"><span class="g">✎</span><span class="line"><span class="mono el">src/auth/identity.ts</span></span><span class="meta"><span class="db"><i class="a" style="width:43px"></i><i class="r" style="width:30px"></i></span>+41 −12</span></div>
            <div class="row sel"><span class="g">$</span><span class="mono">pnpm test --filter auth</span><span class="meta">exit 1 · 6.2 s</span></div>
            <div class="row sel"><span class="g"></span><span class="line"><span class="dots"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i class="f"></i></span><span class="meta">14/15</span><span class="badink el">links accounts by verified email</span></span><span></span></div>
            <div class="row"><span class="g"><svg class="i"><use href="#i-flag"/></svg></span><span class="flag">Failing tests · 1 failed in pnpm test</span><span></span></div>
            <div class="row"><span class="g">·</span><span class="prose">The email comparison was case-sensitive. Normalizing before the lookup.</span><span></span></div>
            <div class="row"><span class="g">✎</span><span class="line"><span class="mono el">src/auth/identity.ts</span></span><span class="meta"><span class="db"><i class="a" style="width:13px"></i><i class="r" style="width:8px"></i></span>+3 −1</span></div>
            <div class="rule">Redirected</div>
            <div class="row"><span class="g">›</span><span class="prompt">Use PKCE for the web client.<span class="tag">steer</span></span><span></span></div>
            <div class="decide"><div class="q"><svg class="i"><use href="#i-fork"/></svg>Keep password login for accounts that link Google?</div>
              <p class="why">Needs your decision</p>
              <div class="opts"><button class="opt focus">Keep both</button><button class="opt">Google only after linking</button></div></div>
            <div class="row"><span class="g">$</span><span class="mono">pnpm test --filter auth</span><span class="meta"><span class="du"><i style="width:40px"></i><i class="run" style="width:14px"></i></span>12 s</span></div>
          </div>
        </section>
        <aside class="brief" aria-label="Brief">
          <div class="bh"><svg class="i i16"><use href="#i-brief"/></svg>Brief<span class="sub">Live</span></div>
          <div class="sec"><h4><svg class="i"><use href="#i-live"/></svg>Now</h4>
            <div class="now">
              <div class="nowrow"><svg class="i"><use href="#i-term"/></svg><span class="t mono el">pnpm test --filter auth</span><span class="du"><i style="width:40px"></i><i class="run" style="width:14px"></i></span><span class="meta">12 s</span></div>
              <div class="nowrow"><svg class="i"><use href="#i-list"/></svg><span class="t el">Identity linking</span><span class="db"><i class="a" style="width:43px"></i><i class="r" style="width:30px"></i></span></div>
              <div class="card"><div class="q"><svg class="i"><use href="#i-fork"/></svg><span>Keep password login for accounts that link Google?</span></div><p class="s">Needs your decision</p></div>
            </div>
          </div>
          <div class="sec"><h4><svg class="i"><use href="#i-list"/></svg>Changes so far · 3</h4>
            <div class="chg">
              <div class="c"><svg class="i"><use href="#i-list"/></svg><span class="t el">Identity linking</span><span class="db"><i class="a" style="width:44px"></i><i class="r" style="width:30px"></i></span><span class="dots"><i></i><i></i><i></i><i class="f"></i></span><svg class="i"><use href="#i-flag"/></svg></div>
              <div class="c"><svg class="i"><use href="#i-list"/></svg><span class="t el">Google provider</span><span class="db"><i class="a" style="width:48px"></i></span><span></span><span></span></div>
              <div class="c"><svg class="i"><use href="#i-pkg"/></svg><span class="t el">Dependencies</span><span class="db"><i class="a" style="width:8px"></i></span><span></span><span></span></div>
            </div>
          </div>
          <div class="sec"><h4><svg class="i"><use href="#i-route"/></svg>Architecture</h4>
            <div class="empty"><svg class="i"><use href="#i-map"/></svg><span><b>Codebase map</b>Appears here once this repository is scanned.</span></div>
          </div>
        </aside>
      </div>
      <div class="dock">
        <div class="queued"><svg class="i"><use href="#i-clock"/></svg><span class="el">Queued · Add a sign-out button to the header</span><span class="x">Cancel</span></div>
        <div class="input"><span class="caret">›</span><span class="ph">Message the agent · Enter for a new line</span></div>
        <div class="dockbar"><span class="mode">Steer<svg class="i"><use href="#i-chev"/></svg></span><span class="grow"></span><span>⌘↵ send</span><span class="send">Send</span></div>
      </div>
    </main>
  </div>
  <footer class="status"><span>Codex · gpt-5-codex</span><span>Jev on</span><span class="grow"></span><span>212 events</span></footer>
</div>
</body>
</html>
```

- [ ] **Step 2: Write the states mockup**

Create `docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/console-states.html`. It reuses `console-main.html`'s `<style>` and `<svg>` sprite verbatim (copy both blocks), then replaces the `<div class="app">…</div>` body with three panels:

```html
<style>
.states{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px;padding:24px;background:var(--canvas);min-height:100vh}
.panel{display:flex;flex-direction:column;border-radius:12px;background:var(--panel);box-shadow:var(--shadow);overflow:hidden;min-width:0}
.panel>h2{padding:12px 16px 4px;font-size:12px;font-weight:500;color:var(--ink-3)}
.panel .console{height:560px}
.panel .brief{box-shadow:none;height:560px}
.pill{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border-radius:14px;background:var(--panel);box-shadow:var(--shadow);font-size:12px;color:var(--ink)}
.bar{height:4px;border-radius:2px;background:var(--fill-2);overflow:hidden;margin-top:8px}
.bar i{display:block;height:4px;width:33%;background:var(--ink-3)}
@media (max-width:1179px){.states{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
<div class="states">
  <section class="panel"><h2>Console · scrolled back while Live (Review Focus 3)</h2>
    <div class="console">
      <div class="cbar"><span class="grow">Review · 215 steps</span><span class="search"><svg class="i"><use href="#i-search"/></svg>Search</span></div>
      <div class="log">
        <div class="row"><span class="g">·</span><span class="prose">Reading the session store before touching the callback.</span><span></span></div>
        <div class="row"><span class="g">◦</span><span class="dim">read 2 files</span><span class="meta"><svg class="i"><use href="#i-chev"/></svg></span></div>
        <div class="row"><span class="g"></span><span class="mono dim">src/auth/session.ts</span><span></span></div>
        <div class="row"><span class="g"></span><span class="mono dim">src/auth/callback.ts</span><span></span></div>
        <div class="row sel"><span class="g">$</span><span class="mono">rg -n "linkAccount" src</span><span class="meta">exit 0 · 0.2 s</span>
          <span class="out mono">src/auth/identity.ts:42:export async function linkAccount(user, profile) {
src/auth/google.ts:88:  await linkAccount(existing, profile);</span></div>
        <div class="row"><span class="g">✎</span><span class="line"><span class="mono el">src/auth/callback.ts</span></span><span class="meta"><span class="db"><i class="a" style="width:20px"></i><i class="r" style="width:8px"></i></span>+6 −2</span></div>
        <div class="row"><span class="g">·</span><span class="dim">thinking</span><span class="meta"><svg class="i"><use href="#i-chev-r"/></svg></span></div>
      </div>
      <span class="pill">↓ 3 new</span>
    </div>
  </section>
  <section class="panel"><h2>Brief · finished session</h2>
    <aside class="brief">
      <div class="bh"><svg class="i i16"><use href="#i-brief"/></svg>Brief<span class="sub">Completed · 6 m 40 s</span></div>
      <div class="sec"><h4><svg class="i"><use href="#i-check"/></svg>Now</h4>
        <div class="now"><div class="nowrow"><svg class="i"><use href="#i-check"/></svg><span class="t">Completed</span><span class="meta">6 m 40 s</span></div>
          <div class="nowrow"><svg class="i"><use href="#i-list"/></svg><span class="t el">Identity linking</span><span class="db"><i class="a" style="width:44px"></i><i class="r" style="width:30px"></i></span></div></div></div>
      <div class="sec"><h4><svg class="i"><use href="#i-list"/></svg>Changes so far · 3</h4>
        <div class="chg">
          <div class="c"><svg class="i"><use href="#i-list"/></svg><span class="t el">Identity linking</span><span class="db"><i class="a" style="width:44px"></i><i class="r" style="width:30px"></i></span><span class="dots"><i></i><i></i><i></i><i></i></span><span></span></div>
          <div class="c"><svg class="i"><use href="#i-list"/></svg><span class="t el">Google provider</span><span class="db"><i class="a" style="width:48px"></i></span><span></span><span></span></div>
          <div class="c"><svg class="i"><use href="#i-pkg"/></svg><span class="t el">Dependencies</span><span class="db"><i class="a" style="width:8px"></i></span><span></span><span></span></div>
        </div></div>
      <div class="sec"><h4><svg class="i"><use href="#i-route"/></svg>Architecture</h4>
        <div class="empty"><svg class="i"><use href="#i-map"/></svg><span><b>Codebase map</b>Appears here once this repository is scanned.</span></div></div>
    </aside>
  </section>
  <section class="panel"><h2>Brief · before the first event</h2>
    <aside class="brief">
      <div class="bh"><svg class="i i16"><use href="#i-brief"/></svg>Brief<span class="sub">Starting</span></div>
      <div class="sec"><h4><svg class="i"><use href="#i-live"/></svg>Now</h4>
        <div class="now"><div class="nowrow dim"><svg class="i"><use href="#i-clock"/></svg><span class="t">Waiting for the agent's first event</span></div></div></div>
      <div class="sec"><h4><svg class="i"><use href="#i-list"/></svg>Changes so far</h4>
        <p class="dim">No changes yet</p></div>
      <div class="sec"><h4><svg class="i"><use href="#i-route"/></svg>Architecture</h4>
        <div class="empty"><svg class="i"><use href="#i-map"/></svg><span><b>Mapping codebase · 3,200 / 9,800 files</b><span class="bar"><i></i></span></span></div></div>
    </aside>
  </section>
</div>
```

- [ ] **Step 3: Render the PNGs headlessly**

Run from the worktree (each call is short; no server is needed for `file://`):

```bash
M=docs/superpowers/specs/2026-10-02-console-and-explainer-mockups
CHROME="${CHROME_PATH:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
for name in console-main console-states; do
  for width in 1440 1000; do
    height=900; [ "$name" = console-states ] && height=700
    perl -e 'alarm 60; exec @ARGV' "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
      --user-data-dir="$(mktemp -d)" --window-size=${width},${height} \
      --screenshot="$PWD/$M/${name}-${width}.png" "file://$PWD/$M/${name}.html"
  done
done
ls -la $M/*.png
```

Expected: four PNGs, each larger than 20 KB. Open each with the Read tool and check: light surfaces, no boxes around Console rows, red only on the failing test name, the failing dot and nothing else, the accent only on the selected rows, the Live segment and the decision block, the switcher fits at 1000 px (labels hidden, icons and keys kept), and the Brief stays readable at 264 px. Fix the HTML and rerender until all hold.

- [ ] **Step 4: Write the README section**

Create `docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/README.md` if it does not exist (lanes 06 and 07 add their own sections), with:

```markdown
# Console and explainer mockups

Static HTML rendered headlessly at 1440 and 1000 px. Tokens and icons follow the trace viewer (viewer spec §7.12).
Each phase's UI tasks compare their headless screenshots against the approved PNGs here.

## Phase A (lane 02 V-0): main window on the Console, Brief v0

| File | Shows |
|---|---|
| `console-main.html`, `console-main-1440.png`, `console-main-1000.png` | The main window: header, sidebar, view switcher (keys 0–4), the Console with every Phase A row kind, Brief v0 (Now, Changes so far, Architecture empty state), the prompt dock with a queued item |
| `console-states.html`, `console-states-1440.png`, `console-states-1000.png` | The Console scrolled back while Live with the "↓ 3 new" pill; Brief for a finished session; Brief before the first event with the scan progress state |

### H1 approval

| Date | Person | Decision | Notes |
|---|---|---|---|
| (pending) | | | |
```

- [ ] **Step 5: HUMAN GATE H1**

Stop here. Show the person the four PNGs (and the two HTML files) and ask for approval of: the main window on the Console with the view switcher and the prompt dock, the Console row styles, and Brief v0. Record their answer in the H1 table (date, person, "approved" or "changes requested", notes). Apply requested changes, rerender (Step 3) and ask again. **V-4 and V-5 must not start until the table says "approved".** V-3 may proceed meanwhile. Lane 03's D-3 and D-4 read the same record.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/console-main.html \
  docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/console-states.html \
  docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/console-main-1440.png \
  docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/console-main-1000.png \
  docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/console-states-1440.png \
  docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/console-states-1000.png \
  docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/README.md
git commit -m "docs: phase A mockups for the Console-first main window and Brief v0"
```

Commit the first version before the gate (Step 5) as well, so the person reviews committed files; each round of changes is one more commit with the same file list.

### Task V-3: `buildConsoleRows` (pure)

**Files:**
- Create: `packages/trace-viewer/src/layout/console-rows.ts`
- Test: `packages/trace-viewer/src/layout/console-rows.test.ts`
- Test: `packages/trace-viewer/src/layout/console-rows.property.test.ts`

**Interfaces:**
- Consumes: `TraceSession`, `Step`, `StepId`, `Turn`, `Finding`, `FindingId`, `agentEventLabel` (`../model/index.js`); `TraceIndex` (`./trace-index.js`, its `findingsById`); `anchoredFindings` (`./tone.js`, the anchor rule); `NarrativeSentence` (`@jevcode/contracts`, lane 01 K-2).
- Produces (interfaces §6.3, deviation 12):
  - `type ConsoleRow` (all twelve variants, `summary` included for lane 07)
  - `interface ConsoleRowsState { rows: readonly ConsoleRow[]; byStep: ReadonlyMap<string, number> }`
  - `buildConsoleRows(session: TraceSession, index: TraceIndex, prev?: ConsoleRowsState): ConsoleRowsState`
  - `CONSOLE_TAIL_LINES = 8`; `consoleRowStepIds(row: ConsoleRow): readonly string[]`

Rules (spec §3.2, §8.2):
- One row per step, in `session.steps` order, keyed by the step id (`reads:<first step id>` for a read group, the finding id for a finding row). Keys derive from first seqs and finding ids only, so they survive refolds and live ticks.
- `instruction`: `text` is the step text; `mode` is `"start"` when the step holds the start seq of its own turn and that turn's trigger is `initial` or `resume`, `"steer"` when that trigger is `steer`, and `"queue"` when the step holds a later turn's start seq (a queued instruction delivered later) or no turn's start seq (not delivered yet).
- `message`, `reasoning` (`ms = durationMs`), `tool` (`name = target`, `args = ""`, `status` running/failed/ok), `command` and `check` steps (`command`, the last `CONSOLE_TAIL_LINES` lines of `CommandDetail.outputTail`, `exitCode`, `running`, `ms`), `test` steps with `tests` (`tests` row; `failing` = failure test names) and without (`command` row), `edit`, `dependency` and `revert` steps (`edit` row; `path` from the edit detail, else the target, else the headline), `decision` steps (`decision` row; `status` `"pending"` while open; `answer` = the chosen options' labels joined by ", "), `approval` steps (`lifecycle` row, `"waiting"`), `lifecycle` steps (`failed` for status failed, `completed` for ok, `waiting` for the "Waiting for direction" label, else `interrupted`).
- Consecutive `read` steps of one turn form one `reads` row; a non-read row ends the group, a Jev step does not.
- After a step's row come its anchored findings (`anchoredFindings`, FINDING_ORDER), one `finding` row each. `guardrail` and `attention` steps make no row of their own.
- Incremental by step identity: a step whose object is unchanged keeps its row object (instructions are rebuilt, since their mode reads the turns; finding rows are rebuilt when `index.findingsById` changed). The result always equals a fresh build.

- [ ] **Step 1: Write the failing unit tests**

Create `packages/trace-viewer/src/layout/console-rows.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { accumulateAll, createTraceState, finalize, foldRows, type TraceSession } from "../model/index.js";
import { TraceBuilder, testMeta } from "../test-support/trace-builder.js";
import {
  buildConsoleRows,
  CONSOLE_TAIL_LINES,
  consoleRowStepIds,
  type ConsoleRow,
  type ConsoleRowsState,
} from "./console-rows.js";
import { buildTraceIndex } from "./trace-index.js";

const NOW = Date.parse("2026-09-18T09:30:00.000Z");

function lines(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");
}

function hunk(file: string, added: number, removed: number) {
  return { type: "git_hunk" as const, file, added, removed, isFormattingOnly: false, isConfigOnly: false, isLockfile: false };
}

function build(b: TraceBuilder, state: "running" | "completed" = "completed"): { session: TraceSession; out: ConsoleRowsState } {
  const session = foldRows(testMeta({ state, lastEventSeq: b.rows.length }), b.rows, { live: state === "running", nowMs: NOW });
  return { session, out: buildConsoleRows(session, buildTraceIndex(session)) };
}

function rowsOf<K extends ConsoleRow["kind"]>(out: ConsoleRowsState, kind: K): Extract<ConsoleRow, { kind: K }>[] {
  return out.rows.filter((row): row is Extract<ConsoleRow, { kind: K }> => row.kind === kind);
}

describe("buildConsoleRows (spec §3.2, §8.2)", () => {
  it("maps each step kind to its Console row, in step order", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Add OAuth" });
    b.agent({ type: "agent_message", role: "assistant", text: "Plan: add a provider." });
    b.agent({ type: "agent_reasoning", text: "Which flow?" });
    b.agent({ type: "tool_started", tool: "mcp.github.search_issues", input: "oauth" });
    b.agent({ type: "tool_completed", tool: "mcp.github.search_issues", output: "" });
    b.agent({ type: "command_started", command: "ls src" });
    b.agent({ type: "command_completed", command: "ls src", exitCode: 0, stdout: lines(12), stderr: "" });
    b.agent({ type: "file_read", path: "src/a.ts" });
    b.agent({ type: "file_read", path: "src/b.ts" });
    b.agent({ type: "file_changed", path: "src/a.ts" });
    b.fact(hunk("src/a.ts", 3, 1));
    b.decision({ id: "d1", title: "Keep email login?" });
    b.agent({ type: "agent_waiting" });
    const { out } = build(b);

    expect(out.rows.map((row) => row.kind)).toEqual([
      "instruction", "message", "reasoning", "tool", "command", "reads", "edit", "decision", "lifecycle",
    ]);
    expect(rowsOf(out, "instruction")[0]).toMatchObject({ text: "Add OAuth", mode: "start" });
    expect(rowsOf(out, "message")[0]).toMatchObject({ text: "Plan: add a provider." });
    expect(rowsOf(out, "tool")[0]).toMatchObject({ name: "mcp.github.search_issues", args: "", status: "ok" });
    expect(rowsOf(out, "command")[0]).toMatchObject({
      command: "ls src",
      exitCode: 0,
      running: false,
      outputTail: ["line 5", "line 6", "line 7", "line 8", "line 9", "line 10", "line 11", "line 12"],
    });
    expect(rowsOf(out, "command")[0]?.outputTail).toHaveLength(CONSOLE_TAIL_LINES);
    expect(rowsOf(out, "reads")[0]?.paths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(rowsOf(out, "edit")[0]).toMatchObject({ path: "src/a.ts", added: 3, removed: 1 });
    expect(rowsOf(out, "decision")[0]).toMatchObject({
      decisionId: "d1",
      question: "Keep email login?",
      status: "pending",
      answer: null,
      options: [{ id: "a", label: "Option A" }, { id: "b", label: "Option B" }],
    });
    expect(rowsOf(out, "lifecycle")[0]).toMatchObject({ state: "waiting", text: "Waiting for direction" });
  });

  it("indexes every shown step, a read group under each of its reads", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const r1 = b.agent({ type: "file_read", path: "src/a.ts" });
    const r2 = b.agent({ type: "file_read", path: "src/b.ts" });
    b.agent({ type: "agent_message", role: "assistant", text: "done reading" });
    const r3 = b.agent({ type: "file_read", path: "src/c.ts" });
    const { out, session } = build(b);
    const stepAt = (seq: number) => session.steps.find((step) => step.firstSeq === seq)?.id ?? "";
    const groups = rowsOf(out, "reads");
    expect(groups.map((row) => row.paths)).toEqual([["src/a.ts", "src/b.ts"], ["src/c.ts"]]);
    expect(groups[0]?.key).toBe(`reads:${stepAt(r1)}`);
    expect(out.byStep.get(stepAt(r1))).toBe(out.byStep.get(stepAt(r2)));
    expect(out.rows[out.byStep.get(stepAt(r3)) ?? -1]?.key).toBe(`reads:${stepAt(r3)}`);
    for (const step of session.steps) {
      const at = out.byStep.get(step.id);
      expect(at, step.id).toBeDefined();
      expect(consoleRowStepIds(out.rows[at ?? -1] as ConsoleRow)).toContain(step.id);
    }
  });

  it("puts a failing run's tests row before the finding anchored on it", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Fix login" });
    b.agent({ type: "command_started", command: "pnpm test" });
    b.agent({ type: "command_completed", command: "pnpm test", exitCode: 1, stdout: "", stderr: "" });
    b.fact({
      type: "test_result", runner: "vitest", command: "pnpm test", passed: 14, failed: 1, skipped: 0,
      failures: [{ file: "a.test.ts", testName: "links accounts", message: "expected true" }],
    });
    b.agent({ type: "agent_completed" });
    const { out } = build(b);
    const tests = rowsOf(out, "tests")[0];
    expect(tests).toMatchObject({ passed: 14, failed: 1, failing: ["links accounts"] });
    const next = out.rows[out.rows.indexOf(tests as ConsoleRow) + 1];
    expect(next).toMatchObject({ kind: "finding", stepId: tests?.stepId });
    expect(next?.kind === "finding" ? next.findingId : "").toMatch(/^finding:failing_tests@/);
    expect(rowsOf(out, "lifecycle").at(-1)).toMatchObject({ state: "completed" });
  });

  it("marks steer and queued instructions", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Add OAuth" });
    b.agent({ type: "agent_message", role: "user", text: "Also add tests" });
    b.agent({ type: "agent_interrupted", reason: "steer" });
    b.agent({ type: "agent_started", prompt: "Use PKCE" });
    b.agent({ type: "agent_message", role: "user", text: "Use PKCE" });
    const { out } = build(b, "running");
    const modes = rowsOf(out, "instruction").map((row) => [row.text, row.mode]);
    expect(modes).toEqual([
      ["Add OAuth", "start"],
      ["Also add tests", "queue"],
      ["Use PKCE", "steer"],
    ]);
    expect(rowsOf(out, "lifecycle")[0]).toMatchObject({ state: "interrupted" });
  });

  it("shows a running command, a failed agent and a Jev step only through its finding", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const routine = b.jev({ id: "j1", clamps: ["suppress_formatting"] });
    const warning = b.jev({ id: "j2", clamps: ["security_path"] });
    b.agent({ type: "command_started", command: "pnpm build" });
    const running = build(b, "running");
    expect(rowsOf(running.out, "command")[0]).toMatchObject({ command: "pnpm build", running: true, exitCode: null, ms: null });
    const stepAt = (seq: number) => running.session.steps.find((step) => step.firstSeq === seq)?.id ?? "";
    expect(running.out.byStep.has(stepAt(routine))).toBe(false);
    const flagged = running.out.rows[running.out.byStep.get(stepAt(warning)) ?? -1];
    expect(flagged).toMatchObject({ kind: "finding", stepId: stepAt(warning) });

    b.agent({ type: "agent_failed", error: "boom" });
    expect(rowsOf(build(b).out, "lifecycle").at(-1)).toMatchObject({ state: "failed", text: "Stopped: boom" });
  });

  it("returns the previous state for the same session and keeps unchanged rows across an append", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.agent({ type: "agent_message", role: "assistant", text: "one" });
    b.agent({ type: "command_started", command: "ls" });
    b.agent({ type: "command_completed", command: "ls", exitCode: 0, stdout: "a", stderr: "" });
    const state = createTraceState(testMeta({ state: "running" }));
    accumulateAll(state, b.rows);
    const first = finalize(state, { live: true, nowMs: NOW });
    const firstIndex = buildTraceIndex(first);
    const a = buildConsoleRows(first, firstIndex);
    expect(buildConsoleRows(first, firstIndex, a)).toBe(a);

    const seen = b.rows.length;
    b.agent({ type: "agent_message", role: "assistant", text: "two" });
    accumulateAll(state, b.rows.slice(seen));
    const second = finalize(state, { live: true, nowMs: NOW });
    const c = buildConsoleRows(second, buildTraceIndex(second, firstIndex), a);
    expect(c.rows).toHaveLength(a.rows.length + 1);
    a.rows.forEach((row, i) => {
      if (row.kind !== "instruction") expect(c.rows[i]).toBe(row);
    });
    expect(c.rows.at(-1)).toMatchObject({ kind: "message", text: "two" });
  });
});
```

Create `packages/trace-viewer/src/layout/console-rows.property.test.ts`:

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { TraceRow, TraceSessionSummary } from "@jevcode/contracts";

import { accumulateAll, createTraceState, finalize, type TraceSession } from "../model/index.js";
import { arbRowSession } from "../test-support/row-arbitraries.js";
import { buildConsoleRows, consoleRowStepIds, type ConsoleRowsState } from "./console-rows.js";
import { buildTraceIndex, type TraceIndex } from "./trace-index.js";

const NOW = Date.parse("2026-09-18T09:30:00.000Z");

/** One finalize per cut point, on one fold state: what a Live viewer commits. */
function commits(meta: TraceSessionSummary, rows: readonly TraceRow[], cuts: readonly number[]): TraceSession[] {
  const state = createTraceState(meta);
  const points = [...new Set(cuts.map((cut) => cut % (rows.length + 1)))].sort((a, b) => a - b);
  const out: TraceSession[] = [];
  let at = 0;
  for (const point of [...points, rows.length]) {
    accumulateAll(state, rows.slice(at, point));
    at = point;
    out.push(finalize(state, { live: true, nowMs: NOW }));
  }
  return out;
}

function plain(state: ConsoleRowsState) {
  return { rows: state.rows, byStep: [...state.byStep.entries()] };
}

describe("buildConsoleRows properties (spec §8.2)", () => {
  it("an incremental build equals a fresh build after every commit, and is deterministic", () => {
    fc.assert(
      fc.property(arbRowSession({ maxOps: 60 }), fc.array(fc.nat(), { minLength: 1, maxLength: 4 }), ({ meta, rows }, cuts) => {
        let index: TraceIndex | undefined;
        let previous: ConsoleRowsState | undefined;
        for (const session of commits(meta, rows, cuts)) {
          index = buildTraceIndex(session, index);
          const next = buildConsoleRows(session, index, previous);
          const fresh = buildConsoleRows(session, buildTraceIndex(session));
          expect(plain(next)).toStrictEqual(plain(fresh));
          expect(plain(buildConsoleRows(session, buildTraceIndex(session)))).toStrictEqual(plain(fresh));
          previous = next;
        }
      }),
      { numRuns: 120 },
    );
  });

  it("keys are unique, rows follow step order, and every shown step is indexed to a row that names it", () => {
    fc.assert(
      fc.property(arbRowSession({ maxOps: 60 }), ({ meta, rows }) => {
        const session = finalize(accumulateAll(createTraceState(meta), rows), { live: false });
        const index = buildTraceIndex(session);
        const out = buildConsoleRows(session, index);
        expect(new Set(out.rows.map((row) => row.key)).size).toBe(out.rows.length);
        const firstSeqOf = new Map(session.steps.map((step) => [step.id as string, step.firstSeq]));
        let last = 0;
        for (const row of out.rows) {
          const ids = consoleRowStepIds(row);
          const seq = firstSeqOf.get(ids[0] ?? "") ?? last;
          expect(seq).toBeGreaterThanOrEqual(last);
          last = seq;
        }
        for (const step of session.steps) {
          const at = out.byStep.get(step.id);
          const silent = (step.kind === "guardrail" || step.kind === "attention") &&
            !step.findingIds.some((id) => index.findingsById.get(id)?.anchorStepId === step.id);
          if (silent) {
            expect(at, step.id).toBeUndefined();
            continue;
          }
          expect(at, step.id).toBeDefined();
          expect(consoleRowStepIds(out.rows[at ?? -1] ?? { kind: "summary", key: "", sentences: [] })).toContain(step.id);
        }
      }),
      { numRuns: 150 },
    );
  });
});
```

`accumulateAll` returns the state (the fold API in `model/fold.ts`); if it returns `void` in this checkout, write `const state = createTraceState(meta); accumulateAll(state, rows); const session = finalize(state, { live: false });` instead.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/console-rows.test.ts src/layout/console-rows.property.test.ts`

Expected: FAIL with "Failed to load url ./console-rows.js" (the module does not exist).

- [ ] **Step 3: Implement `console-rows.ts`**

Create `packages/trace-viewer/src/layout/console-rows.ts`:

```ts
import type { NarrativeSentence } from "@jevcode/contracts";

import { agentEventLabel, type Finding, type FindingId, type Step, type StepId, type TraceSession, type Turn } from "../model/index.js";
import { anchoredFindings } from "./tone.js";
import type { TraceIndex } from "./trace-index.js";

/** One Console row (spec §3.2; interfaces §6.3). Keys come from step ids and finding ids, so they survive refolds. */
export type ConsoleRow =
  | { kind: "instruction"; key: string; stepId: string; text: string; mode: "steer" | "queue" | "start" }
  | { kind: "message"; key: string; stepId: string; text: string }
  | { kind: "reasoning"; key: string; stepId: string; ms: number | null }
  | { kind: "tool"; key: string; stepId: string; name: string; args: string; status: "running" | "ok" | "failed"; ms: number | null }
  | { kind: "command"; key: string; stepId: string; command: string; outputTail: string[]; exitCode: number | null; running: boolean; ms: number | null }
  | { kind: "reads"; key: string; stepIds: string[]; paths: string[] }
  | { kind: "edit"; key: string; stepId: string; path: string; added: number; removed: number }
  | { kind: "tests"; key: string; stepId: string; passed: number; failed: number; failing: string[] }
  | { kind: "decision"; key: string; stepId: string; decisionId: string; question: string; options: { id: string; label: string }[]; status: "pending" | "answered"; answer: string | null }
  | { kind: "lifecycle"; key: string; stepId: string; state: "waiting" | "completed" | "failed" | "interrupted"; text: string }
  | { kind: "finding"; key: string; stepId: string; findingId: string }
  | { kind: "summary"; key: string; sentences: NarrativeSentence[]; provenance?: "rule" | "model" };

export interface ConsoleRowsState {
  rows: readonly ConsoleRow[];
  /** Step id → the row that shows it: its own row, its read group, or the finding row of a Jev step. */
  byStep: ReadonlyMap<string, number>;
}

/** Output lines a command row shows before it is expanded (spec §3.2). */
export const CONSOLE_TAIL_LINES = 8;

type ReadsRow = Extract<ConsoleRow, { kind: "reads" }>;

/** The step ids a row stands for: a read group's reads, nothing for a summary, else its one step. */
export function consoleRowStepIds(row: ConsoleRow): readonly string[] {
  if (row.kind === "reads") return row.stepIds;
  if (row.kind === "summary") return [];
  return [row.stepId];
}

interface StepPiece {
  /** The step's own row; null for a read (it joins a group) and for guardrail and attention steps. */
  own: ConsoleRow | null;
  /** A read step's path. */
  readPath: string | null;
  /** One flag row per finding anchored on the step, in FINDING_ORDER. */
  findings: readonly ConsoleRow[];
}

interface CachedPiece {
  step: Step;
  findingsById: ReadonlyMap<FindingId, Finding>;
  piece: StepPiece;
}

interface Cache {
  session: TraceSession;
  findingsById: ReadonlyMap<FindingId, Finding>;
  pieces: ReadonlyMap<string, CachedPiece>;
  reads: ReadonlyMap<string, ReadsRow>;
}

/** Per returned state, so ConsoleRowsState keeps the interface shape (deviation 12). */
const CACHE = new WeakMap<ConsoleRowsState, Cache>();
const NO_FINDINGS: readonly ConsoleRow[] = [];
const WAITING_TEXT = agentEventLabel({ type: "agent_waiting", sessionId: "", ts: "" });

function tailLines(text: string | undefined, max: number): string[] {
  if (text === undefined || text === "") return [];
  const all = text.split(/\r?\n/);
  while (all.length > 0 && all[all.length - 1] === "") all.pop();
  return all.slice(-max);
}

function instructionMode(step: Step, turnByStart: ReadonlyMap<number, Turn>): "steer" | "queue" | "start" {
  for (const seq of step.seqs) {
    const turn = turnByStart.get(seq);
    if (turn === undefined) continue;
    if (turn.index !== step.turnIndex) return "queue";
    return turn.trigger === "steer" ? "steer" : "start";
  }
  return "queue";
}

function lifecycleState(step: Step): "waiting" | "completed" | "failed" | "interrupted" {
  if (step.status === "failed") return "failed";
  if (step.status === "ok") return "completed";
  return step.headline === WAITING_TEXT ? "waiting" : "interrupted";
}

function commandRow(step: Step): ConsoleRow {
  return {
    kind: "command",
    key: step.id,
    stepId: step.id,
    command: step.command?.command ?? step.target ?? "",
    outputTail: tailLines(step.command?.outputTail, CONSOLE_TAIL_LINES),
    exitCode: step.command?.exitCode ?? null,
    running: step.status === "running",
    ms: step.durationMs,
  };
}

function decisionRow(step: Step): ConsoleRow {
  const decision = step.decision;
  if (decision === undefined) return { kind: "lifecycle", key: step.id, stepId: step.id, state: "waiting", text: step.headline };
  const chosen = decision.options.filter((option) => option.chosen).map((option) => option.label);
  return {
    kind: "decision",
    key: step.id,
    stepId: step.id,
    decisionId: decision.decisionId,
    question: decision.title,
    options: decision.options.map((option) => ({ id: option.id, label: option.label })),
    status: decision.status === "open" ? "pending" : "answered",
    answer: chosen.length === 0 ? null : chosen.join(", "),
  };
}

function ownRow(step: Step, turnByStart: ReadonlyMap<number, Turn>): ConsoleRow | null {
  const key = step.id;
  const stepId = step.id;
  switch (step.kind) {
    case "instruction":
      return { kind: "instruction", key, stepId, text: step.text ?? step.headline, mode: instructionMode(step, turnByStart) };
    case "message":
      return { kind: "message", key, stepId, text: step.text ?? "" };
    case "reasoning":
      return { kind: "reasoning", key, stepId, ms: step.durationMs };
    case "tool":
      return {
        kind: "tool",
        key,
        stepId,
        name: step.target ?? "tool",
        args: "",
        status: step.status === "running" ? "running" : step.status === "failed" ? "failed" : "ok",
        ms: step.durationMs,
      };
    case "test":
      if (step.tests !== undefined) {
        return {
          kind: "tests",
          key,
          stepId,
          passed: step.tests.passed,
          failed: step.tests.failed,
          failing: step.tests.failures.map((failure) => failure.testName),
        };
      }
      return commandRow(step);
    case "command":
    case "check":
      return commandRow(step);
    case "edit":
    case "dependency":
    case "revert":
      return {
        kind: "edit",
        key,
        stepId,
        path: step.edit?.path ?? step.target ?? step.headline,
        added: step.edit?.added ?? 0,
        removed: step.edit?.removed ?? 0,
      };
    case "decision":
      return decisionRow(step);
    case "approval":
      return { kind: "lifecycle", key, stepId, state: "waiting", text: step.headline };
    case "lifecycle":
      return { kind: "lifecycle", key, stepId, state: lifecycleState(step), text: step.headline };
    case "read":
    case "guardrail":
    case "attention":
      return null;
  }
}

function pieceOf(step: Step, turnByStart: ReadonlyMap<number, Turn>, findingsById: ReadonlyMap<FindingId, Finding>): StepPiece {
  const anchored = step.findingIds.length === 0 ? [] : anchoredFindings(step, findingsById);
  const findings: readonly ConsoleRow[] = anchored.length === 0
    ? NO_FINDINGS
    : anchored.map((finding): ConsoleRow => ({ kind: "finding", key: finding.id, stepId: step.id, findingId: finding.id }));
  if (step.kind === "read") return { own: null, readPath: step.target ?? step.headline, findings };
  return { own: ownRow(step, turnByStart), readPath: null, findings };
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/**
 * The Console rows of a session (spec §8.2). Pure and React-free. With `prev` (the state this function returned for
 * an earlier commit of the same session), steps whose objects did not change keep their row objects; the result
 * always equals a fresh build.
 */
export function buildConsoleRows(session: TraceSession, index: TraceIndex, prev?: ConsoleRowsState): ConsoleRowsState {
  const findingsById = index.findingsById;
  const cache = prev === undefined ? undefined : CACHE.get(prev);
  if (prev !== undefined && cache !== undefined && cache.session === session && cache.findingsById === findingsById) return prev;

  const turnByStart = new Map<number, Turn>();
  for (const turn of session.turns) turnByStart.set(turn.startSeq, turn);
  const pieces = new Map<string, CachedPiece>();
  const reads = new Map<string, ReadsRow>();
  const rows: ConsoleRow[] = [];
  const byStep = new Map<string, number>();
  let group: { stepIds: StepId[]; paths: string[]; turnIndex: number } | null = null;

  const closeGroup = (): void => {
    const open = group;
    if (open === null) return;
    group = null;
    const key = `reads:${open.stepIds[0] ?? ""}`;
    const old = cache?.reads.get(key);
    const row: ReadsRow =
      old !== undefined && sameStrings(old.stepIds, open.stepIds) && sameStrings(old.paths, open.paths)
        ? old
        : { kind: "reads", key, stepIds: open.stepIds, paths: open.paths };
    reads.set(key, row);
    const at = rows.length;
    rows.push(row);
    for (const id of open.stepIds) byStep.set(id, at);
  };

  const pushFindings = (stepId: string, findings: readonly ConsoleRow[]): void => {
    for (const row of findings) {
      if (!byStep.has(stepId)) byStep.set(stepId, rows.length);
      rows.push(row);
    }
  };

  for (const step of session.steps) {
    const old = cache?.pieces.get(step.id);
    const reusable =
      old !== undefined &&
      old.step === step &&
      step.kind !== "instruction" &&
      (step.findingIds.length === 0 || old.findingsById === findingsById);
    const entry: CachedPiece = reusable ? old : { step, findingsById, piece: pieceOf(step, turnByStart, findingsById) };
    pieces.set(step.id, entry);
    const piece = entry.piece;

    if (piece.readPath !== null) {
      if (group !== null && group.turnIndex !== step.turnIndex) closeGroup();
      const current: { stepIds: StepId[]; paths: string[]; turnIndex: number } =
        group ?? { stepIds: [], paths: [], turnIndex: step.turnIndex };
      group = current;
      current.stepIds.push(step.id);
      current.paths.push(piece.readPath);
      if (piece.findings.length > 0) {
        closeGroup();
        pushFindings(step.id, piece.findings);
      }
      continue;
    }
    // A guardrail or attention step with no anchored finding is Jev's, not the agent's: no row, and a read group
    // around it stays one group.
    if (piece.own === null && piece.findings.length === 0) continue;
    closeGroup();
    if (piece.own !== null) {
      byStep.set(step.id, rows.length);
      rows.push(piece.own);
    }
    pushFindings(step.id, piece.findings);
  }
  closeGroup();

  const state: ConsoleRowsState = { rows, byStep };
  CACHE.set(state, { session, findingsById, pieces, reads });
  return state;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/console-rows.test.ts src/layout/console-rows.property.test.ts`

Expected: PASS (6 unit cases, 2 properties). If the steer case reports `"start"` for "Use PKCE", read `fold-agent.ts` `deliverInstruction` and the turn trigger rules before changing anything: the expectation comes from spec §3.2 ("a steer or queue tag") and the B-12 rule that a started turn's instruction step holds `turn.startSeq`; fix `instructionMode`, not the test.

- [ ] **Step 5: Typecheck and lint**

Run the package typecheck and lint. The lint run confirms `src/layout/console-rows.ts` uses no React, DOM, timers or clocks (`LAYOUT_PURE_GLOBALS`).

- [ ] **Step 6: Commit**

```bash
git add packages/trace-viewer/src/layout/console-rows.ts \
  packages/trace-viewer/src/layout/console-rows.test.ts \
  packages/trace-viewer/src/layout/console-rows.property.test.ts
git commit -m "feat(trace-viewer): pure, incremental Console row builder"
```

### Task V-4: `ConsoleView`

Blocked by H1: start only when the README's H1 table says "approved".

**Files:**
- Create: `packages/trace-viewer/src/ui/views/console/ConsoleView.tsx`
- Create: `packages/trace-viewer/src/ui/views/console/ConsoleRowView.tsx`
- Create: `packages/trace-viewer/src/ui/views/console/ConsoleView.module.css`
- Create: `packages/trace-viewer/src/ui/shell/host-context.ts`
- Modify: `packages/trace-viewer/src/ui/views/registry.ts` (Console slot → `ConsoleView`)
- Modify: `packages/trace-viewer/src/ui/views/view-port.ts` (`ViewPort.toggle?`)
- Modify: `packages/trace-viewer/src/ui/shell/KeyboardLayer.tsx` (`toggle` case)
- Modify: `packages/trace-viewer/src/ui/shell/Shell.tsx` (provide `ViewerHostContext`)
- Modify: `packages/trace-viewer/src/ui/shell/TitleBar.tsx` (hide zoom for an empty label)
- Modify: `apps/trace-viewer-dev/scripts/smoke.mjs` (`--views` accepts `console`)
- Test: `packages/trace-viewer/src/ui/views/console/console-view.test.tsx`

**Interfaces:**
- Consumes: V-3 `buildConsoleRows`, `consoleRowStepIds`, `ConsoleRow`, `ConsoleRowsState`; V-2 `ViewProps`, `useRegisterViewPort`, `ZoomPort`, `ViewerHost.answerDecision`, `ViewState.focusBy` (`"console"` is a `ViewKind`); `extendRange`, `revealAlign`, `spineVirtualOptions` (`hybrid/spine/scroll-sync.ts`); `NewBadge`; `searchMatches` (`Outline/outline-rows.ts`), `buildSearchIndex`; `selectNewCount`; `DiffBar`, `TestDots`, `DurationBar`; `FINDING_TITLE`; `displayUntrusted`, `truncateMiddle`, `formatDuration`, `exitLabel`, `toolLabel`.
- Produces:
  - `ConsoleView({ active }: ViewProps)`, registered in `VIEWS` as kind `"console"` (interfaces §6.3).
  - `rowIndexOfSelection(state, session, index, selection): number`, `consoleReadingOrder(rows): SelectionId[]`.
  - `ConsoleRowView`, `estimateConsoleRow`, `expandKey(row) = "console:" + row.key`, `isExpandable`, `outputLines(rows)`, `FAILING_SHOWN = 3`, `FULL_OUTPUT_MAX_LINES = 400` (lane 07 S-4 restyles the `summary` row here).
  - `ViewPort.toggle?(id: SelectionId): boolean`; `ViewerHostContext`, `useViewerHost()` (deviation 11).
  - The feed root carries `data-console` and `data-step-count`; the scroller carries `data-console-scroll` (V-6 reads them).

Behavior (spec §3.2, §8.2; viewer spec §7.6.3, §7.10):
- Virtualized with `@tanstack/react-virtual` and the spine's options (`anchorTo: "end"`, `followOnAppend: "auto"` only while following and active, overscan 10); every row is measured; the selected and focused rows stay mounted (`extendRange`).
- Following: opening a following Console scrolls to the end; appends follow the tail while the reader is at the bottom. The reader's own scroll (wheel, touch, pointer, key) away from the bottom turns Live off; scrolling back to the bottom of a running session turns it on again; at the bottom of a finished session it marks rows seen.
- A data rebuild never scrolls, moves focus or changes the selection. A selection written elsewhere (keys, search, another view, the Brief) reveals its row with `revealAlign` (instant); a click in the Console never scrolls.
- `j`/`k` walk `consoleReadingOrder`; Enter expands the selected row through `port.toggle`; `/` focuses the Console's search field (`data-view-search`), whose matches use the Outline's `searchMatches`; `G` and the pill go back to Live.
- Rows render as in spec §3.2 through `ConsoleRowView`: the `›` prompt (ink, steer and queued tags), prose in ink-2, a dim "thinking" line, `●` tool lines with a check, ✕ or "unknown", `$` commands with the last 8 output lines, a neutral `✕ exit n` and a running DurationBar, "read n files", `✎ path` with a DiffBar that opens the diff in the Inspector, TestDots with `passed/total` and the failing names in red, the decision block (option buttons only when the host offers `answerDecision`), a one-line lifecycle rule, a flag line per anchored finding titled from `FINDING_TITLE` (never agent text), and the `◆ Summary` placeholder lane 07 restyles.

- [ ] **Step 1: Open the approved mockups**

Open `docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/console-main-1440.png`, `console-main-1000.png` and `console-states-1440.png` with the Read tool, and `console-main.html` for exact sizes. Keep beside you: the row grid (20 px glyph column, 10 px gap, one 1 px gutter rule at x = 25 px), mono for commands, paths and output, red only for failing tests, the accent-soft decision block, the "↓ N new" pill centered at the bottom.

- [ ] **Step 2: Write the failing tests**

Create `packages/trace-viewer/src/ui/views/console/console-view.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TraceRow } from "@jevcode/contracts";

import { buildTraceIndex } from "../../../layout/trace-index.js";
import { foldRows, type TraceSession } from "../../../model/index.js";
import { TraceBuilder, testMeta } from "../../../test-support/trace-builder.js";
import {
  createHarness,
  stubLayout,
  type Harness,
  type HarnessOptions,
  type LayoutStub,
} from "../../../test-support/ui-harness.js";
import type { ViewerHost } from "../../shell/host.js";
import { ViewerHostContext } from "../../shell/host-context.js";
import { LiveRegion } from "../../shell/LiveRegion.js";
import { SessionContext, type SessionView } from "../../shell/session-context.js";
import { ViewStoreContext } from "../../state/store.js";
import { ViewPortRegistryContext } from "../view-port.js";
import { ConsoleView } from "./ConsoleView.js";

const NOW = Date.parse("2026-09-18T09:30:00.000Z");

let layout: LayoutStub;
beforeEach(() => {
  layout = stubLayout({ height: 600, rowHeight: 32 });
});
afterEach(() => {
  cleanup();
  layout.restore();
  vi.restoreAllMocks();
});

/** Lets rAF callbacks, timers and React commits run. */
async function frames(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

interface Mounted {
  h: Harness;
  update(next: TraceSession): void;
  scroller(): HTMLElement;
}

/** The Console inside the providers the Shell gives it; update() applies a new commit the way the Shell does. */
function mountConsole(session: TraceSession, options: HarnessOptions & { host?: ViewerHost } = {}): Mounted {
  const h = createHarness(session, options);
  let view: SessionView = h.view;
  const tree = (current: SessionView): ReactElement => (
    <ViewStoreContext.Provider value={h.store}>
      <SessionContext.Provider value={current}>
        <ViewerHostContext.Provider value={options.host ?? {}}>
          <ViewPortRegistryContext.Provider value={h.registry}>
            <LiveRegion onAnnounce={(message) => h.announcements.push(message)}>
              <ConsoleView active />
            </LiveRegion>
          </ViewPortRegistryContext.Provider>
        </ViewerHostContext.Provider>
      </SessionContext.Provider>
    </ViewStoreContext.Provider>
  );
  const result = render(tree(view));
  return {
    h,
    update(next) {
      const index = buildTraceIndex(next, view.index);
      view = { ...view, session: next, index, summary: next.meta };
      h.store.setIndex(index);
      act(() => {
        result.rerender(tree(view));
        h.store.dispatch({
          type: "session/applied",
          loadedThroughSeq: next.loadedThroughSeq,
          terminal: false,
          loadComplete: true,
          initialSelection: null,
          chapterSpineRows: 0,
        });
      });
    },
    scroller() {
      const node = result.container.querySelector<HTMLElement>("[data-console-scroll]");
      if (node === null) throw new Error("the Console has no scroller");
      return node;
    },
  };
}

function messages(count: number): TraceBuilder {
  const b = new TraceBuilder();
  b.agent({ type: "agent_started", prompt: "Work" });
  for (let i = 1; i < count; i += 1) b.agent({ type: "agent_message", role: "assistant", text: `message ${i}` });
  return b;
}

function live(b: TraceBuilder): TraceSession {
  return foldRows(testMeta({ state: "running", lastEventSeq: b.rows.length }), b.rows, { live: true, nowMs: NOW });
}

describe("ConsoleView (spec §3.2, §8.2)", () => {
  it("renders the Phase A row kinds and shows bidi and control characters as visible tokens", async () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Fix ‮login" });
    b.agent({ type: "agent_message", role: "assistant", text: "Done ‮txt.exe" });
    b.agent({ type: "command_started", command: "ls src" });
    b.agent({ type: "command_completed", command: "ls src", exitCode: 2, stdout: "a.ts\u0007\nb.ts", stderr: "" });
    b.agent({ type: "file_changed", path: "src/a.ts" });
    b.fact({ type: "git_hunk", file: "src/a.ts", added: 3, removed: 1, isFormattingOnly: false, isConfigOnly: false, isLockfile: false });
    b.decision({ id: "d1", title: "Keep ‮email?" });
    const m = mountConsole(live(b), { state: { follow: false, loaded: true } });
    await frames();
    const text = screen.getByRole("feed", { name: "Console" }).textContent ?? "";
    expect(text).toContain("Fix ⟨U+202E⟩login");
    expect(text).toContain("Done ⟨U+202E⟩txt.exe");
    expect(text).toContain("a.ts⟨U+0007⟩");
    expect(text).toContain("Keep ⟨U+202E⟩email?");
    expect(text).not.toContain("‮");
    expect(text).toContain("✕ exit 2");
    expect(text).toContain("+3 −1");
    expect(text).toContain("Needs your decision");
    // A read-only host (the trace window) offers no answer buttons.
    expect(screen.queryByRole("button", { name: "Option A" })).toBeNull();
    expect(m.h.registry.get("console")?.zoom.label()).toBe("");
  });

  it("answers a pending decision through host.answerDecision with keyboard-reachable buttons", async () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    b.decision({ id: "d1", title: "Keep email login?" });
    const answerDecision = vi.fn(async () => undefined);
    const m = mountConsole(live(b), { host: { answerDecision }, state: { follow: false, loaded: true } });
    await frames();
    const option = screen.getByRole("button", { name: "Option B" });
    act(() => option.focus());
    expect(document.activeElement).toBe(option);
    fireEvent.click(option);
    await waitFor(() => expect(answerDecision).toHaveBeenCalledWith({ decisionId: "d1", optionId: "b" }));
    await waitFor(() => expect(m.h.announcements).toContain("Answer sent"));
  });

  it("Review Focus 3: a live append while the reader is scrolled back keeps the offset, the focused row and the selection, and shows an N new pill", async () => {
    const b = messages(60);
    const first = live(b);
    const target = first.steps[20];
    if (target === undefined) throw new Error("the session has fewer than 21 steps");
    const m = mountConsole(first, { state: { follow: true, loaded: true, lastSeenSeq: first.loadedThroughSeq } });
    await frames();

    // The reader scrolls back with the wheel.
    const scroller = m.scroller();
    act(() => {
      fireEvent.wheel(scroller, { deltaY: -400 });
      scroller.scrollTop = 320;
      fireEvent.scroll(scroller);
    });
    await frames();
    expect(m.h.store.get().follow).toBe(false);

    // The reader selects a visible row and keeps focus on it.
    const row = await waitFor(() => {
      const node = Array.from(scroller.querySelectorAll<HTMLElement>("[data-key]")).find((item) => item.dataset.key === target.id);
      if (node === undefined) throw new Error("the target row is not mounted");
      return node;
    });
    fireEvent.click(row);
    act(() => row.focus());
    expect(m.h.store.get().selection).toBe(target.id);
    const scrollsBefore = layout.scrollCalls.length;
    const topBefore = scroller.scrollTop;

    // Three rows arrive while the reader reads.
    for (let i = 0; i < 3; i += 1) b.agent({ type: "agent_message", role: "assistant", text: `late ${i}` });
    m.update(live(b));
    await frames();

    expect(layout.scrollCalls.length).toBe(scrollsBefore);
    expect(scroller.scrollTop).toBe(topBefore);
    expect(document.activeElement).toBe(row);
    expect(m.h.store.get().selection).toBe(target.id);
    expect(screen.getByRole("button", { name: /3 new/ })).toBeTruthy();
  });

  it("follows the tail in Live while the reader is at the bottom", async () => {
    const b = messages(60);
    const first = live(b);
    const m = mountConsole(first, { state: { follow: true, loaded: true, lastSeenSeq: first.loadedThroughSeq } });
    await frames();
    act(() => {
      fireEvent.scroll(m.scroller());
    });
    await frames();
    const before = layout.scrollCalls.length;
    for (let i = 0; i < 3; i += 1) b.agent({ type: "agent_message", role: "assistant", text: `late ${i}` });
    m.update(live(b));
    await frames();
    expect(layout.scrollCalls.length).toBeGreaterThan(before);
    expect(m.h.store.get().follow).toBe(true);
    expect(screen.queryByRole("button", { name: /new/ })).toBeNull();
  });

  it("gives j/k the step order and expands a command's full output through the port", async () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "p" });
    const cmd = b.agent({ type: "command_started", command: "ls src" });
    b.agent({
      type: "command_completed",
      command: "ls src",
      exitCode: 0,
      stdout: Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n"),
      stderr: "",
    });
    const read = b.agent({ type: "file_read", path: "src/a.ts" });
    b.agent({ type: "file_read", path: "src/b.ts" });
    const session = live(b);
    const payloads = vi.fn(async (seqs: readonly number[]): Promise<TraceRow[]> => b.rows.filter((row) => seqs.includes(row.seq)));
    const m = mountConsole(session, { payloads, state: { follow: false, loaded: true } });
    await frames();
    const stepAt = (seq: number) => session.steps.find((step) => step.firstSeq === seq);
    const commandStep = stepAt(cmd);
    if (commandStep === undefined) throw new Error("no command step");
    const port = m.h.registry.get("console");
    expect(port?.readingOrder()).toEqual([session.steps[0]?.id, commandStep.id, stepAt(read)?.id]);

    const feed = screen.getByRole("feed", { name: "Console" });
    expect(feed.textContent).toContain("line 12");
    expect(feed.textContent).not.toContain("line 4");
    let handled = false;
    act(() => {
      handled = port?.toggle?.(commandStep.id) ?? false;
    });
    expect(handled).toBe(true);
    expect(m.h.store.get().expanded.has(`console:${commandStep.id}`)).toBe(true);
    await waitFor(() => expect(feed.textContent).toContain("line 4"));
    expect(payloads).toHaveBeenCalledWith(commandStep.seqs);
  });

  it("a click selects without scrolling; a selection from elsewhere reveals its row", async () => {
    const b = messages(120);
    const session = live(b);
    const m = mountConsole(session, { state: { follow: false, loaded: true } });
    await frames();
    const scroller = m.scroller();
    const near = session.steps[3];
    const far = session.steps[100];
    if (near === undefined || far === undefined) throw new Error("the session is too short");
    const row = Array.from(scroller.querySelectorAll<HTMLElement>("[data-key]")).find((item) => item.dataset.key === near.id);
    if (row === undefined) throw new Error("row 3 is not mounted");
    const before = layout.scrollCalls.length;
    fireEvent.click(row);
    expect(m.h.store.get().selection).toBe(near.id);
    expect(layout.scrollCalls.length).toBe(before);

    act(() => m.h.store.dispatch({ type: "select", id: far.id, by: "hybrid" }));
    await frames();
    expect(layout.scrollCalls.length).toBeGreaterThan(before);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/console/console-view.test.tsx`

Expected: FAIL with "Failed to load url ./ConsoleView.js" and "../../shell/host-context.js".

- [ ] **Step 4: Host context, `ViewPort.toggle` and the keyboard**

Create `packages/trace-viewer/src/ui/shell/host-context.ts`:

```ts
import { createContext, useContext } from "react";

import type { ViewerHost } from "./host.js";

/** The host's actions for views (deviation 11): the Console's decision block calls answerDecision. */
export const ViewerHostContext = createContext<ViewerHost>({});

export function useViewerHost(): ViewerHost {
  return useContext(ViewerHostContext);
}
```

In `packages/trace-viewer/src/ui/views/view-port.ts`, find:

```ts
  focusSelected(): void;
  zoom: ZoomPort;
}
```

Replace it with:

```ts
  focusSelected(): void;
  /** Enter on the selection: true when the view handled it (the Console expands a row); else the store's expand applies. */
  toggle?(id: SelectionId): boolean;
  zoom: ZoomPort;
}
```

In `packages/trace-viewer/src/ui/shell/KeyboardLayer.tsx`, find:

```ts
        case "toggle":
          if (target?.closest(OWNS_ENTER) != null) return;
          if (state.selection !== null) store.dispatch({ type: "expand/toggle", key: state.selection });
          return;
```

Replace it with:

```ts
        case "toggle":
          if (target?.closest(OWNS_ENTER) != null) return;
          if (state.selection === null) return;
          if (port?.toggle?.(state.selection) === true) return;
          store.dispatch({ type: "expand/toggle", key: state.selection });
          return;
```

In `packages/trace-viewer/src/ui/shell/Shell.tsx`, add `import { ViewerHostContext } from "./host-context.js";` after the `./host.js` import, then find:

```tsx
      <SessionContext.Provider value={sessionView}>
        <DiagnosticsContext.Provider value={diagnostics}>
```

Replace it with:

```tsx
      <SessionContext.Provider value={sessionView}>
        <ViewerHostContext.Provider value={host}>
        <DiagnosticsContext.Provider value={diagnostics}>
```

and find:

```tsx
        </DiagnosticsContext.Provider>
      </SessionContext.Provider>
```

Replace it with:

```tsx
        </DiagnosticsContext.Provider>
        </ViewerHostContext.Provider>
      </SessionContext.Provider>
```

(re-indent the block inside by two spaces).

In `packages/trace-viewer/src/ui/shell/TitleBar.tsx`, find:

```tsx
      {port === undefined ? null : (
```

Replace it with:

```tsx
      {port === undefined || port.zoom.label() === "" ? null : (
```

- [ ] **Step 5: Row renderers**

Create `packages/trace-viewer/src/ui/views/console/ConsoleRowView.tsx`:

```tsx
import { useEffect, useState, type JSX } from "react";

import { TRACE_PAYLOADS_MAX, type TraceRow } from "@jevcode/contracts";

import type { ConsoleRow } from "../../../layout/console-rows.js";
import type { TraceIndex } from "../../../layout/trace-index.js";
import {
  displayUntrusted,
  exitLabel,
  formatDuration,
  toolLabel,
  truncateMiddle,
  type FindingId,
  type Step,
  type TraceSession,
} from "../../../model/index.js";
import { DiffBar } from "../../graphics/DiffBar.js";
import { DurationBar } from "../../graphics/DurationBar.js";
import { TestDots } from "../../graphics/TestDots.js";
import { Icon } from "../../icons/Icon.js";
import { FINDING_TITLE } from "../../inspector/finding-copy.js";
import styles from "./ConsoleView.module.css";

/** Failing test names a tests row shows before it is expanded. */
export const FAILING_SHOWN = 3;
/** Lines of full output an expanded command shows (the rest is counted). */
export const FULL_OUTPUT_MAX_LINES = 400;

type Row<K extends ConsoleRow["kind"]> = Extract<ConsoleRow, { kind: K }>;

/** Store key of a row's expansion (spec §8.2: expand state lives in the store, apart from Hybrid's step keys). */
export function expandKey(row: ConsoleRow): string {
  return `console:${row.key}`;
}

export function isExpandable(row: ConsoleRow): boolean {
  switch (row.kind) {
    case "command":
    case "reasoning":
    case "reads":
      return true;
    case "tests":
      return row.failing.length > FAILING_SHOWN;
    default:
      return false;
  }
}

/** Virtualizer estimate before a row is measured. */
export function estimateConsoleRow(row: ConsoleRow | undefined, expanded: ReadonlySet<string>): number {
  if (row === undefined) return 24;
  const open = expanded.has(expandKey(row));
  switch (row.kind) {
    case "instruction":
      return 32;
    case "message":
      return 24 + 18 * Math.min(8, Math.floor(row.text.length / 110));
    case "reasoning":
      return open ? 96 : 24;
    case "tool":
    case "edit":
    case "finding":
      return 24;
    case "command":
      return 28 + 18 * row.outputTail.length + (open ? 220 : 0);
    case "reads":
      return 24 + (open ? 18 * row.paths.length : 0);
    case "tests":
      return 24 + (row.failing.length > 0 ? 18 : 0) + (open ? 18 * row.failing.length : 0);
    case "decision":
      return 96;
    case "lifecycle":
      return 28;
    case "summary":
      return 32 + 18 * row.sentences.length;
  }
}

/** stdout then stderr of the command_completed rows among `rows`, as lines; trailing empty lines dropped. */
export function outputLines(rows: readonly TraceRow[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (row.type !== "agent_event" || row.payload === null || typeof row.payload !== "object") continue;
    const payload = row.payload as { type?: unknown; stdout?: unknown; stderr?: unknown };
    if (payload.type !== "command_completed") continue;
    for (const part of [payload.stdout, payload.stderr]) {
      if (typeof part === "string" && part !== "") out.push(...part.split(/\r?\n/));
    }
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

function stepOf(session: TraceSession, index: TraceIndex, id: string): Step | undefined {
  const entry = index.entry(id);
  return entry?.kind === "step" ? session.steps[entry.position] : undefined;
}

export interface ConsoleRowViewProps {
  row: ConsoleRow;
  session: TraceSession;
  index: TraceIndex;
  expanded: boolean;
  /** id of the element that labels the row's article. */
  lineId: string;
  /** Display-clock now (SessionView.nowT()), for running bars. */
  nowT: number;
  /** The host offers answerDecision (the main window); the trace window does not. */
  canAnswer: boolean;
  payloads(seqs: readonly number[]): Promise<TraceRow[]>;
  onToggle(): void;
  onOpenDiff(): void;
  onAnswer(decisionId: string, optionId: string): Promise<void>;
}

function Chevron({ open, label, onToggle }: { open: boolean; label: string; onToggle(): void }) {
  return (
    <button
      type="button"
      className={styles.chev}
      aria-expanded={open}
      aria-label={open ? `Collapse ${label}` : `Expand ${label}`}
      onClick={onToggle}
    >
      <Icon name={open ? "chev-d" : "chev-r"} size={12} />
    </button>
  );
}

function FullOutput({ step, payloads }: { step: Step; payloads(seqs: readonly number[]): Promise<TraceRow[]> }) {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "ready"; lines: string[] } | { kind: "error" }>({
    kind: "loading",
  });
  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    payloads(step.seqs.slice(-TRACE_PAYLOADS_MAX)).then(
      (rows) => {
        if (!cancelled) setState({ kind: "ready", lines: outputLines(rows) });
      },
      () => {
        if (!cancelled) setState({ kind: "error" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [step.id, step.lastSeq, payloads]);
  if (state.kind === "loading") return <p className={`${styles.output} ${styles.dim}`}>Loading output</p>;
  if (state.kind === "error") return <p className={`${styles.output} ${styles.dim}`}>The output could not be read</p>;
  const shown = state.lines.slice(-FULL_OUTPUT_MAX_LINES);
  const hidden = state.lines.length - shown.length;
  return (
    <pre className={styles.output}>
      {hidden > 0 ? `${hidden} earlier lines not shown\n` : ""}
      {displayUntrusted(shown.join("\n"), { multiline: true })}
    </pre>
  );
}

function CommandRow({ row, session, index, expanded, lineId, nowT, payloads, onToggle }: ConsoleRowViewProps & { row: Row<"command"> }) {
  const step = stepOf(session, index, row.stepId);
  const exit = exitLabel(row.exitCode);
  const elapsed = Math.max(0, nowT - (step?.tMs ?? nowT));
  return (
    <div className={styles.row}>
      <span className={styles.glyph} aria-hidden="true">$</span>
      <p id={lineId} className={`${styles.mono} ${styles.command}`}>
        {displayUntrusted(row.command)}
      </p>
      <span className={styles.meta}>
        {row.running ? <DurationBar size="xs" durationMs={null} running elapsedMs={elapsed} end="none" /> : null}
        {row.running ? <span>{formatDuration(elapsed)}</span> : null}
        {exit === "" ? null : <span>{row.exitCode !== null && row.exitCode > 0 ? `✕ ${exit}` : exit}</span>}
        {!row.running && row.ms !== null ? <span>{formatDuration(row.ms)}</span> : null}
        {step === undefined ? null : <Chevron open={expanded} label="output" onToggle={onToggle} />}
      </span>
      {expanded && step !== undefined ? (
        <FullOutput step={step} payloads={payloads} />
      ) : row.outputTail.length > 0 ? (
        <pre className={styles.output}>{displayUntrusted(row.outputTail.join("\n"), { multiline: true })}</pre>
      ) : null}
    </div>
  );
}

function DecisionBlock({ row, lineId, canAnswer, onAnswer }: { row: Row<"decision">; lineId: string; canAnswer: boolean; onAnswer(decisionId: string, optionId: string): Promise<void> }) {
  const [sending, setSending] = useState(false);
  const labels = row.options.map((option) => displayUntrusted(option.label));
  return (
    <div className={styles.decision} data-status={row.status}>
      <p id={lineId} className={styles.question}>
        <Icon name="fork" size={14} />
        <span>{displayUntrusted(row.question)}</span>
      </p>
      {row.status === "answered" ? (
        <p className={styles.note}>{row.answer === null ? "Answered" : `→ ${displayUntrusted(row.answer)}`}</p>
      ) : canAnswer ? (
        <>
          <p className={styles.note}>Needs your decision</p>
          <div className={styles.options} role="group" aria-label="Answer">
            {row.options.map((option, position) => (
              <button
                key={option.id}
                type="button"
                className={styles.option}
                disabled={sending}
                onClick={() => {
                  setSending(true);
                  void onAnswer(row.decisionId, option.id).finally(() => setSending(false));
                }}
              >
                {labels[position]}
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className={styles.note}>{`Needs your decision · ${labels.join(" / ")}`}</p>
      )}
    </div>
  );
}

/** One Console row (spec §3.2). Every agent string goes through displayUntrusted; finding titles come from the viewer. */
export function ConsoleRowView(props: ConsoleRowViewProps): JSX.Element {
  const { row, session, index, expanded, lineId, onToggle } = props;
  switch (row.kind) {
    case "instruction":
      return (
        <div className={styles.row}>
          <span className={styles.glyph} aria-hidden="true">›</span>
          <p id={lineId} className={styles.prompt}>
            {displayUntrusted(row.text, { multiline: true })}
            {row.mode === "start" ? null : <span className={styles.tag}>{row.mode === "steer" ? "steer" : "queued"}</span>}
          </p>
        </div>
      );
    case "message":
      return (
        <div className={styles.row}>
          <span className={styles.glyph} aria-hidden="true">·</span>
          <p id={lineId} className={styles.prose}>{displayUntrusted(row.text, { multiline: true })}</p>
        </div>
      );
    case "reasoning": {
      const text = stepOf(session, index, row.stepId)?.text ?? "";
      return (
        <div className={styles.row}>
          <span className={styles.glyph} aria-hidden="true">·</span>
          <p id={lineId} className={styles.dim}>{row.ms === null ? "thinking" : `thinking · ${formatDuration(row.ms)}`}</p>
          <span className={styles.meta}>{text === "" ? null : <Chevron open={expanded} label="thinking" onToggle={onToggle} />}</span>
          {expanded && text !== "" ? <p className={`${styles.detail} ${styles.dim}`}>{displayUntrusted(text, { multiline: true })}</p> : null}
        </div>
      );
    }
    case "tool": {
      const unknown = stepOf(session, index, row.stepId)?.status === "unknown";
      return (
        <div className={styles.row}>
          <span className={styles.glyph} aria-hidden="true">●</span>
          <p id={lineId} className={styles.line}>
            <span className={`${styles.mono} ${styles.ellipsis}`} title={displayUntrusted(row.name)}>
              {displayUntrusted(toolLabel(row.name))}
            </span>
            {row.args === "" ? null : <span className={`${styles.mono} ${styles.dim} ${styles.ellipsis}`}>{displayUntrusted(row.args)}</span>}
          </p>
          <span className={styles.meta}>
            {row.status === "running" ? (
              <span>running</span>
            ) : unknown ? (
              <span>unknown</span>
            ) : row.status === "failed" ? (
              <span>✕ failed</span>
            ) : (
              <Icon name="check" size={12} title="done" />
            )}
            {row.ms === null ? null : <span>{formatDuration(row.ms)}</span>}
          </span>
        </div>
      );
    }
    case "command":
      return <CommandRow {...props} row={row} />;
    case "reads":
      return (
        <div className={styles.row}>
          <span className={styles.glyph} aria-hidden="true">◦</span>
          <p id={lineId} className={styles.dim}>
            {row.paths.length === 1 ? `read ${truncateMiddle(row.paths[0] ?? "", 64)}` : `read ${row.paths.length} files`}
          </p>
          <span className={styles.meta}>
            <Chevron open={expanded} label="files read" onToggle={onToggle} />
          </span>
          {expanded ? (
            <ul className={styles.detail}>
              {row.paths.map((path, position) => (
                <li key={`${position}:${path}`} className={`${styles.mono} ${styles.dim} ${styles.ellipsis}`} title={displayUntrusted(path)}>
                  {truncateMiddle(path, 96)}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      );
    case "edit":
      return (
        <div className={styles.row}>
          <span className={styles.glyph} aria-hidden="true">✎</span>
          <p id={lineId} className={styles.line}>
            <button
              type="button"
              className={`${styles.link} ${styles.mono} ${styles.ellipsis}`}
              title={displayUntrusted(row.path)}
              onClick={props.onOpenDiff}
            >
              {truncateMiddle(row.path, 80)}
            </button>
          </p>
          <span className={styles.meta}>
            <DiffBar size="xs" added={row.added} removed={row.removed} />
            <span>{`+${row.added} −${row.removed}`}</span>
          </span>
        </div>
      );
    case "tests": {
      const shown = expanded ? row.failing : row.failing.slice(0, FAILING_SHOWN);
      const more = row.failed - shown.length;
      return (
        <div className={styles.row}>
          <span className={styles.glyph} aria-hidden="true">
            <Icon name="test" size={12} />
          </span>
          <p id={lineId} className={styles.line}>
            <TestDots size="xs" passed={row.passed} failed={row.failed} skipped={0} label={`${row.passed} passed, ${row.failed} failed`} />
            <span className={styles.meta}>{`${row.passed}/${row.passed + row.failed}`}</span>
          </p>
          <span className={styles.meta}>
            {row.failing.length > FAILING_SHOWN ? <Chevron open={expanded} label="failing tests" onToggle={onToggle} /> : null}
          </span>
          {shown.length > 0 || more > 0 ? (
            <p className={`${styles.detail} ${styles.bad}`}>
              {shown.map((name) => displayUntrusted(name)).join(" · ")}
              {more > 0 ? <span className={styles.dim}>{`${shown.length > 0 ? " · " : ""}${more} more`}</span> : null}
            </p>
          ) : null}
        </div>
      );
    }
    case "decision":
      return <DecisionBlock row={row} lineId={lineId} canAnswer={props.canAnswer} onAnswer={props.onAnswer} />;
    case "lifecycle":
      return (
        <div className={styles.rule} data-state={row.state}>
          <span id={lineId} className={row.state === "failed" ? styles.bad : undefined}>
            {row.state === "failed" ? `✕ ${displayUntrusted(row.text)}` : displayUntrusted(row.text)}
          </span>
        </div>
      );
    case "finding": {
      const finding = index.findingsById.get(row.findingId as FindingId);
      const critical = finding?.severity === "critical";
      return (
        <div className={styles.row}>
          <span className={`${styles.glyph} ${critical ? styles.bad : ""}`} aria-hidden="true">
            <Icon name="flag" size={12} />
          </span>
          <p id={lineId} className={critical ? `${styles.flag} ${styles.bad}` : styles.flag}>
            {finding === undefined ? "Finding" : `${FINDING_TITLE[finding.ruleId]} · ${finding.severity}`}
          </p>
        </div>
      );
    }
    case "summary":
      // Lane 07 (S-4) restyles this row against the approved Phase C mockup.
      return (
        <div className={styles.row}>
          <span className={styles.glyph} aria-hidden="true">◆</span>
          <p id={lineId} className={styles.prose}>
            <span className={styles.summaryLabel}>Summary</span>
            {row.sentences.map((sentence) => displayUntrusted(sentence.text)).join(" ")}
          </p>
        </div>
      );
  }
}
```

- [ ] **Step 6: The view**

Create `packages/trace-viewer/src/ui/views/console/ConsoleView.tsx`:

```tsx
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent } from "react";

import type { TraceRow } from "@jevcode/contracts";

import { buildConsoleRows, consoleRowStepIds, type ConsoleRow, type ConsoleRowsState } from "../../../layout/console-rows.js";
import type { SelectionId, TraceIndex } from "../../../layout/trace-index.js";
import { buildSearchIndex, type SearchIndex, type TraceSession } from "../../../model/index.js";
import { Icon } from "../../icons/Icon.js";
import { useViewerHost } from "../../shell/host-context.js";
import { useAnnounce } from "../../shell/LiveRegion.js";
import { searchMatches } from "../../shell/Outline/outline-rows.js";
import { useDiagnostics, useSessionView } from "../../shell/session-context.js";
import { useDispatch, useView, useViewStore } from "../../state/store.js";
import { selectNewCount } from "../../state/view-state.js";
import { extendRange, revealAlign, spineVirtualOptions } from "../hybrid/spine/scroll-sync.js";
import { NewBadge } from "../shared/NewBadge.js";
import { useRegisterViewPort, type ViewPort, type ViewProps, type ZoomPort } from "../view-port.js";
import { ConsoleRowView, estimateConsoleRow, expandKey, isExpandable } from "./ConsoleRowView.js";
import styles from "./ConsoleView.module.css";

const EMPTY_ROWS: ConsoleRowsState = { rows: [], byStep: new Map() };
/** Wheel, touch, pointer and key input mark the next scroll frames as the reader's own. */
const USER_INPUT_EVENTS = ["wheel", "touchstart", "touchmove", "pointerdown", "keydown"] as const;
const USER_SCROLL_MS = 400;
/** Within this many px of the end the reader is "at the bottom" (the spine's scrollEndThreshold). */
const END_THRESHOLD_PX = 24;

/** The Console has no zoom; the title bar hides its zoom control for an empty label (deviation 15). */
const NO_ZOOM: ZoomPort = {
  label: () => "",
  presets: () => [],
  applyPreset: () => undefined,
  zoomIn: () => undefined,
  zoomOut: () => undefined,
  resetToPreset: () => undefined,
  fitAll: () => undefined,
  fitSelection: () => undefined,
};

/** The row that shows `selection`: a step's row, or the first shown step of a selected chapter. */
export function rowIndexOfSelection(
  state: ConsoleRowsState,
  session: TraceSession | null,
  index: TraceIndex,
  selection: SelectionId | null,
): number {
  if (selection === null || session === null) return -1;
  const direct = state.byStep.get(selection);
  if (direct !== undefined) return direct;
  const entry = index.entry(selection);
  if (entry?.kind !== "chapter") return -1;
  for (const stepId of session.chapters[entry.position]?.stepIds ?? []) {
    const at = state.byStep.get(stepId);
    if (at !== undefined) return at;
  }
  return -1;
}

/** j/k order: one entry per row that shows a step (a read group stands for its first read); finding rows are skipped. */
export function consoleReadingOrder(rows: readonly ConsoleRow[]): SelectionId[] {
  const order: SelectionId[] = [];
  for (const row of rows) {
    if (row.kind === "finding" || row.kind === "summary") continue;
    const first = consoleRowStepIds(row)[0];
    if (first !== undefined) order.push(first as SelectionId);
  }
  return order;
}

function rowMatches(row: ConsoleRow, matches: ReadonlySet<string>): boolean {
  return matches.size > 0 && consoleRowStepIds(row).some((id) => matches.has(id));
}

/** Spec §3.2: the session as a terminal-style log, oldest at the top, following the tail while the reader is there. */
export function ConsoleView({ active }: ViewProps) {
  const { session, index, terminal, loadedFraction, nowT, payloads } = useSessionView();
  const store = useViewStore();
  const dispatch = useDispatch();
  const host = useViewerHost();
  const announce = useAnnounce();
  const diagnostics = useDiagnostics();
  const follow = useView((state) => state.follow);
  const selection = useView((state) => state.selection);
  const expanded = useView((state) => state.expanded);
  const search = useView((state) => state.search);
  const focusRev = useView((state) => state.focusRev);
  const focusBy = useView((state) => state.focusBy);
  const lastSeenSeq = useView((state) => state.lastSeenSeq);
  const newCount = useView((state) => selectNewCount(state, index));
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  const previous = useRef<ConsoleRowsState | undefined>(undefined);
  const built = useMemo(
    () => (session === null ? EMPTY_ROWS : buildConsoleRows(session, index, previous.current)),
    [session, index],
  );
  previous.current = built;
  const rows = built.rows;
  const builtRef = useRef(built);
  builtRef.current = built;
  const live = useRef({ session, index, terminal });
  live.current = { session, index, terminal };
  const payloadsRef = useRef(payloads);
  payloadsRef.current = payloads;
  const fetchPayloads = useCallback((seqs: readonly number[]): Promise<TraceRow[]> => payloadsRef.current(seqs), []);

  const matches = useMemo(() => new Set<string>(search?.matchIds ?? []), [search]);
  const selectedIndex = rowIndexOfSelection(built, session, index, selection);

  const scrollRef = useRef<HTMLDivElement>(null);
  const focusKey = useRef<string | null>(null);
  const focusIndex = focusKey.current === null ? -1 : rows.findIndex((row) => row.key === focusKey.current);
  const mounted = useRef<number[]>([]);
  mounted.current = [selectedIndex, focusIndex];

  const userScroll = useRef(false);
  const userTimer = useRef<number | null>(null);
  const readerMoved = useRef(false);
  const anchor = useRef<{ key: string; top: number } | null>(null);
  const frame = useRef<number | null>(null);
  const frameHandler = useRef<() => void>(() => undefined);
  const viewOf = (): (Window & typeof globalThis) | null => scrollRef.current?.ownerDocument.defaultView ?? null;
  const scheduleFrame = (): void => {
    const view = viewOf();
    if (view === null || frame.current !== null) return;
    frame.current = view.requestAnimationFrame(() => {
      frame.current = null;
      frameHandler.current();
    });
  };

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (position) => estimateConsoleRow(builtRef.current.rows[position], store.get().expanded),
    getItemKey: (position) => builtRef.current.rows[position]?.key ?? position,
    rangeExtractor: (range) => extendRange(defaultRangeExtractor(range), mounted.current, range.count),
    onChange: () => scheduleFrame(),
    ...spineVirtualOptions(follow && active),
  });

  // Coalesced per frame: remember the top row (drift), and let the reader's own scroll turn Live off and on.
  frameHandler.current = (): void => {
    const element = scrollRef.current;
    const current = live.current.session;
    if (element === null || current === null) return;
    const offset = virtualizer.scrollOffset ?? element.scrollTop;
    const height = virtualizer.scrollRect?.height || element.clientHeight;
    const first = virtualizer.getVirtualItems().find((item) => item.end > offset);
    const firstRow = first === undefined ? undefined : builtRef.current.rows[first.index];
    if (first !== undefined && firstRow !== undefined) anchor.current = { key: firstRow.key, top: first.start - offset };
    const atEnd = offset + height >= virtualizer.getTotalSize() - END_THRESHOLD_PX;
    const state = store.get();
    if (atEnd) {
      if (userScroll.current && !live.current.terminal && !state.follow) dispatch({ type: "follow/set", follow: true });
      else if (current.loadedThroughSeq > state.lastSeenSeq) dispatch({ type: "seen", seq: current.loadedThroughSeq });
    } else if (userScroll.current && state.follow) {
      dispatch({ type: "follow/set", follow: false });
    }
  };

  useEffect(() => {
    const element = scrollRef.current;
    const view = viewOf();
    if (!active || element === null || view === null) return undefined;
    const mark = (): void => {
      userScroll.current = true;
      readerMoved.current = true;
      if (userTimer.current !== null) view.clearTimeout(userTimer.current);
      userTimer.current = view.setTimeout(() => {
        userTimer.current = null;
        userScroll.current = false;
      }, USER_SCROLL_MS);
    };
    for (const name of USER_INPUT_EVENTS) element.addEventListener(name, mark, { passive: true });
    return () => {
      for (const name of USER_INPUT_EVENTS) element.removeEventListener(name, mark);
    };
  }, [active, session === null]);

  // A quiet Live agent still ages: running bars advance once a second without new data.
  useEffect(() => {
    const view = viewOf();
    if (view === null || terminal || !active) return undefined;
    const handle = view.setInterval(rerender, 1_000);
    return () => view.clearInterval(handle);
  }, [terminal, active, session === null]);

  useEffect(
    () => () => {
      const view = viewOf();
      if (view !== null && frame.current !== null) view.cancelAnimationFrame(frame.current);
      if (view !== null && userTimer.current !== null) view.clearTimeout(userTimer.current);
    },
    [],
  );

  const reveal = (position: number): void => {
    const element = scrollRef.current;
    if (element === null) return;
    virtualizer.getTotalSize(); // refreshes measurementsCache for rows added in this commit
    const item = virtualizer.measurementsCache[position];
    if (item === undefined) return;
    const win = { offset: virtualizer.scrollOffset ?? element.scrollTop, height: virtualizer.scrollRect?.height || element.clientHeight };
    const align = revealAlign({ start: item.start, end: item.end }, win);
    if (align === "none") return;
    virtualizer.scrollToIndex(position, { align: align === "center" ? "center" : "auto", behavior: "auto" });
  };
  const revealRef = useRef(reveal);
  revealRef.current = reveal;

  const focusRow = (id: SelectionId | null): void => {
    const at = rowIndexOfSelection(builtRef.current, live.current.session, live.current.index, id);
    const row = builtRef.current.rows[at];
    if (row === undefined) return;
    focusKey.current = row.key;
    revealRef.current(at);
    viewOf()?.requestAnimationFrame(() => {
      const node = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>("[data-key]") ?? []).find(
        (item) => item.dataset.key === row.key,
      );
      node?.focus({ preventScroll: true });
    });
  };
  const focusRowRef = useRef(focusRow);
  focusRowRef.current = focusRow;

  const port = useMemo<ViewPort>(
    () => ({
      readingOrder: () => consoleReadingOrder(builtRef.current.rows),
      reveal: (id) => {
        const at = rowIndexOfSelection(builtRef.current, live.current.session, live.current.index, id);
        if (at >= 0) revealRef.current(at);
      },
      captureCamera: () => null,
      focusSelected: () => focusRowRef.current(store.get().selection),
      toggle: (id) => {
        const at = rowIndexOfSelection(builtRef.current, live.current.session, live.current.index, id);
        const row = builtRef.current.rows[at];
        if (row === undefined || !isExpandable(row)) return false;
        store.dispatch({ type: "expand/toggle", key: expandKey(row) });
        return true;
      },
      zoom: NO_ZOOM,
    }),
    [store],
  );
  useRegisterViewPort("console", port);

  // Opening (or showing) the Console: a following Console starts at the tail, a reviewing one at its selection.
  const positioned = useRef(false);
  useLayoutEffect(() => {
    if (!active) {
      positioned.current = false;
      return;
    }
    if (positioned.current || rows.length === 0) return;
    positioned.current = true;
    if (store.get().follow) virtualizer.scrollToIndex(rows.length - 1, { align: "end", behavior: "auto" });
    else if (selectedIndex >= 0) reveal(selectedIndex);
  }, [active, rows.length === 0]);

  // A selection written elsewhere (keys, search, another view, the Brief) reveals its row; a Console click never scrolls,
  // and a data rebuild (no focusRev change) never moves the reader.
  const lastRev = useRef(focusRev);
  useLayoutEffect(() => {
    if (lastRev.current === focusRev) return;
    lastRev.current = focusRev;
    if (!active || focusBy === "console") return;
    const target = selectedIndex >= 0 ? selectedIndex : selection !== null && selection === index.tailStepId ? rows.length - 1 : -1;
    if (target >= 0) reveal(target);
  }, [focusRev, focusBy, active, selectedIndex]);

  // Selftest drift (viewer spec §10 "Anchor drift"): the top row must not move when rows arrive under a reviewing reader.
  useLayoutEffect(() => {
    if (!diagnostics.enabled || !active) return undefined;
    const before = anchor.current;
    const element = scrollRef.current;
    const view = viewOf();
    if (before === null || element === null || view === null) return undefined;
    const id = view.requestAnimationFrame(() => {
      const node = Array.from(element.querySelectorAll<HTMLElement>("[data-key]")).find((item) => item.dataset.key === before.key);
      if (node === undefined) return;
      const top = node.getBoundingClientRect().top - element.getBoundingClientRect().top;
      if (readerMoved.current) readerMoved.current = false;
      else if (!store.get().follow) diagnostics.reportDrift(Math.abs(top - before.top));
    });
    return () => view.cancelAnimationFrame(id);
  }, [built]);

  const [query, setQuery] = useState("");
  useEffect(() => {
    if (search === null) setQuery("");
  }, [search]);
  const searchIndex = useRef<{ session: TraceSession; index: SearchIndex } | null>(null);
  const onSearchChange = (value: string): void => {
    setQuery(value);
    if (session === null) return;
    if (searchIndex.current?.session !== session) searchIndex.current = { session, index: buildSearchIndex(session) };
    dispatch({ type: "search/set", query: value, matchIds: searchMatches(session, searchIndex.current.index, value) });
  };
  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      dispatch({ type: "search/next", dir: event.shiftKey ? -1 : 1 });
    } else if (event.key === "Escape") {
      event.preventDefault();
      dispatch({ type: "esc" });
      scrollRef.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus({ preventScroll: true });
    }
  };

  const selectRow = (row: ConsoleRow): void => {
    const id = consoleRowStepIds(row)[0];
    if (id !== undefined) dispatch({ type: "select", id: id as SelectionId, by: "console" });
  };
  const answer = async (decisionId: string, optionId: string): Promise<void> => {
    if (host.answerDecision === undefined) return;
    try {
      await host.answerDecision({ decisionId, optionId });
      announce("Answer sent");
    } catch {
      announce("Could not send the answer");
    }
  };

  if (session === null) {
    return (
      <div className={styles.console} data-console="">
        <div className={styles.placeholders} aria-hidden="true">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((n) => (
            <div key={n} className={styles.placeholder} />
          ))}
        </div>
      </div>
    );
  }

  const empty =
    rows.length > 0
      ? null
      : session.loadedThroughSeq === 0
        ? "Waiting for the agent's first event"
        : `${session.loadedThroughSeq.toLocaleString("en-US")} events, none describe agent work`;
  const tabKey = (focusIndex >= 0 ? rows[focusIndex]?.key : undefined) ?? rows[selectedIndex]?.key ?? rows.at(-1)?.key ?? null;
  const newProblems = session.findings.filter((finding) => finding.severity === "critical" && finding.anchorSeq > lastSeenSeq).length;
  const now = nowT();

  return (
    <div className={styles.console} data-console="" data-step-count={session.steps.length}>
      <div className={styles.bar}>
        <span className={styles.count}>{`${session.steps.length.toLocaleString("en-US")} steps`}</span>
        <label className={styles.search}>
          <Icon name="search" size={12} />
          <input
            data-view-search=""
            type="search"
            aria-label="Search the Console"
            placeholder="Search"
            value={query}
            onChange={(event) => onSearchChange(event.target.value)}
            onKeyDown={onSearchKeyDown}
          />
        </label>
      </div>
      {empty === null ? null : <p className={styles.empty}>{empty}</p>}
      <div
        ref={scrollRef}
        className={styles.scroll}
        data-scroll-root=""
        data-console-scroll=""
        role="feed"
        aria-label="Console"
        aria-busy={loadedFraction < 1}
      >
        <div className={styles.sizer} style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (row === undefined) return null;
            const lineId = `console-line:${row.key}`;
            return (
              <article
                key={row.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                data-key={row.key}
                data-kind={row.kind}
                data-selected={item.index === selectedIndex ? "" : undefined}
                data-match={rowMatches(row, matches) ? "" : undefined}
                aria-posinset={item.index + 1}
                aria-setsize={rows.length}
                aria-labelledby={lineId}
                tabIndex={row.key === tabKey ? 0 : -1}
                className={styles.slot}
                style={{ transform: `translateY(${item.start}px)` }}
                onFocus={(event) => {
                  if (event.target === event.currentTarget) focusKey.current = row.key;
                }}
                onBlur={(event) => {
                  const next = event.relatedTarget as Node | null;
                  if (focusKey.current === row.key && next !== null && !event.currentTarget.contains(next)) focusKey.current = null;
                }}
                onClick={(event) => {
                  if (event.target instanceof Element && event.target.closest("button, a, input") !== null) return;
                  selectRow(row);
                }}
              >
                <ConsoleRowView
                  row={row}
                  session={session}
                  index={index}
                  expanded={expanded.has(expandKey(row))}
                  lineId={lineId}
                  nowT={now}
                  canAnswer={host.answerDecision !== undefined}
                  payloads={fetchPayloads}
                  onToggle={() => dispatch({ type: "expand/toggle", key: expandKey(row) })}
                  onOpenDiff={() => {
                    selectRow(row);
                    dispatch({ type: "inspector/tab", tab: "evidence" });
                  }}
                  onAnswer={answer}
                />
              </article>
            );
          })}
        </div>
      </div>
      <div className={styles.badge}>
        {follow ? null : (
          <NewBadge
            count={newCount}
            problems={newProblems}
            afterRange={false}
            onActivate={() => {
              dispatch({ type: "nav/last" });
              if (!terminal) dispatch({ type: "follow/set", follow: true });
            }}
          />
        )}
      </div>
    </div>
  );
}
```

Create `packages/trace-viewer/src/ui/views/console/ConsoleView.module.css`:

```css
.console {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--tv-panel);
}

.bar {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 16px;
}

.count {
  flex: 1;
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-ink-3);
  font-variant-numeric: tabular-nums;
}

.search {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 8px;
  border-radius: 6px;
  background: var(--tv-fill);
  color: var(--tv-ink-3);
}

.search:focus-within {
  box-shadow: 0 0 0 2px var(--tv-accent-soft);
}

.search input {
  width: 160px;
  border: 0;
  background: transparent;
  color: var(--tv-ink);
  font: inherit;
  font-size: 12px;
  line-height: 16px;
  outline: none;
}

.empty {
  margin: 0;
  padding: 24px 16px;
  font-size: 13px;
  line-height: 18px;
  color: var(--tv-ink-3);
}

.placeholders {
  padding-top: 40px;
}

.placeholder {
  height: 14px;
  margin: 12px 16px 12px 46px;
  border-radius: 4px;
  background: var(--tv-fill);
}

.scroll {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overflow-anchor: none;
}

/* One thin gutter rule under the glyph column; glyphs sit on the panel color over it (spec §3.2: no boxes). */
.sizer {
  position: relative;
  width: 100%;
  background: linear-gradient(var(--tv-hair), var(--tv-hair)) 25px 0 / 1px 100% no-repeat;
}

.slot {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  outline: none;
}

.row {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto;
  column-gap: 10px;
  align-items: start;
  padding: 3px 16px 3px 15px;
  font-size: 13px;
  line-height: 18px;
  color: var(--tv-ink-2);
}

.slot[data-selected] .row,
.slot[data-selected] .rule {
  background: var(--tv-accent-soft);
}

.slot[data-match] .row {
  box-shadow: inset 2px 0 0 var(--tv-accent);
}

.slot:focus-visible .row,
.slot:focus-visible .rule,
.slot:focus-visible .decision {
  box-shadow: inset 0 0 0 2px var(--tv-accent);
}

.glyph {
  display: grid;
  place-items: center;
  height: 18px;
  background: var(--tv-panel);
  color: var(--tv-ink-3);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12px;
}

.slot[data-selected] .glyph {
  background: transparent;
}

.mono {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12px;
  line-height: 18px;
}

.line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin: 0;
}

.ellipsis {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.prompt {
  margin: 0;
  color: var(--tv-ink);
  font-weight: 500;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.prose {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.dim {
  margin: 0;
  color: var(--tv-ink-3);
}

.command {
  margin: 0;
  color: var(--tv-ink);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.tag {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 400;
  color: var(--tv-ink-3);
}

.meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 18px;
  color: var(--tv-ink-3);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.bad {
  color: var(--tv-bad-ink);
}

.flag {
  margin: 0;
  font-size: 12px;
  color: var(--tv-ink-2);
}

.output {
  grid-column: 2 / 4;
  margin: 2px 0 0;
  padding: 2px 0 2px 10px;
  box-shadow: inset 1px 0 0 var(--tv-hair);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12px;
  line-height: 18px;
  color: var(--tv-ink-3);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.detail {
  grid-column: 2 / 4;
  margin: 2px 0 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
  line-height: 18px;
}

.chev {
  display: inline-grid;
  place-items: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--tv-ink-3);
  cursor: pointer;
}

.chev:hover {
  background: var(--tv-fill);
}

.chev:focus-visible,
.link:focus-visible,
.option:focus-visible {
  outline: 2px solid var(--tv-accent);
  outline-offset: 1px;
}

.link {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--tv-ink);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.link:hover {
  text-decoration: underline;
}

.rule {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px 6px 46px;
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-ink-3);
}

.rule::before,
.rule::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--tv-hair);
}

.decision {
  margin: 6px 16px 6px 46px;
  padding: 10px 12px;
  border-radius: 9px;
  background: var(--tv-accent-soft);
  color: var(--tv-ink);
}

.decision[data-status="answered"] {
  background: var(--tv-fill);
}

.question {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-weight: 500;
}

.note {
  margin: 2px 0 0 22px;
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-ink-2);
}

.options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 8px 0 0 22px;
}

.option {
  height: 26px;
  padding: 0 10px;
  border: 0;
  border-radius: 6px;
  background: var(--tv-panel);
  box-shadow: var(--tv-shadow);
  color: var(--tv-ink);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.option:disabled {
  color: var(--tv-ink-3);
  cursor: default;
}

.summaryLabel {
  margin-right: 6px;
  font-weight: 500;
  color: var(--tv-ink);
}

.badge {
  position: absolute;
  left: 50%;
  bottom: 12px;
  transform: translateX(-50%);
}
```

In `packages/trace-viewer/src/ui/views/registry.ts`, add `import { ConsoleView } from "./console/ConsoleView.js";`, change the placeholder import to `import { MapPlaceholder } from "./placeholder/ViewPlaceholder.js";`, and change the Console entry to:

```ts
  { kind: "console", label: "Console", icon: "view-console", Component: ConsoleView },
```

Keep `ConsolePlaceholder` exported from `ViewPlaceholder.tsx` (unused by the registry) only if another file imports it; otherwise delete it in this step so `noUnusedLocals` and lint stay clean.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/console/console-view.test.tsx src/ui/shell src/ui/views/view-switch.test.tsx`

Expected: PASS. The Review Focus 3 case must pass without any change to its expectations; if the virtualizer scrolls on append, the cause is in the view (an append-time reveal, a measurement above the viewport, `followOnAppend` while not following), never the test.

- [ ] **Step 8: Typecheck, lint and the package suite**

Run the package typecheck, lint, and the package suite in the background; expect no failures. `embedded.test.tsx` now opens on the real Console.

- [ ] **Step 9: Headless screenshots against the mockup**

In `apps/trace-viewer-dev/scripts/smoke.mjs`, find:

```js
  if (options.views.length === 0) throw new Error("--views needs hybrid, canvas or both");
  for (const view of options.views) {
    if (view !== "hybrid" && view !== "canvas") throw new Error(`unknown view ${view}`);
  }
```

Replace it with:

```js
  if (options.views.length === 0) throw new Error("--views needs hybrid, canvas or console");
  for (const view of options.views) {
    if (view !== "hybrid" && view !== "canvas" && view !== "console") throw new Error(`unknown view ${view}`);
  }
```

Run in the background and poll the log:

```bash
(perl -e 'alarm 590; exec @ARGV' node apps/trace-viewer-dev/scripts/smoke.mjs --views console,hybrid --port 4182 > .superpowers/smoke-v4.log 2>&1; echo "EXIT=$?" >> .superpowers/smoke-v4.log) &
```

Poll `tail -4 .superpowers/smoke-v4.log` every 15 s until it shows `SMOKE_OK 4 screenshots` or an `EXIT=` line.

Expected: `console: selftest ok (rows …, max drift 0px)` (or ≤ 1 px), `hybrid: selftest ok …` and `SMOKE_OK 4 screenshots`. Open `apps/trace-viewer-dev/.smoke/console-1440.png` and `console-1000.png` with the Read tool beside `console-main-1440.png` and `console-main-1000.png`, and compare the Console column: glyph column and gutter rule, row rhythm (no boxes), mono commands with their dim output tails, the neutral `✕ exit n`, DiffBars, TestDots with red only on the failing test, the decision block, the lifecycle rule, the search field and step count in the bar. List each difference and fix it in `ConsoleView.module.css` or `ConsoleRowView.tsx`, then rerun. (The full chrome around it differs from the mockup on purpose; V-6 screenshots the embedded chrome.)

- [ ] **Step 10: Commit**

```bash
git add packages/trace-viewer/src/ui/views/console/ConsoleView.tsx \
  packages/trace-viewer/src/ui/views/console/ConsoleRowView.tsx \
  packages/trace-viewer/src/ui/views/console/ConsoleView.module.css \
  packages/trace-viewer/src/ui/views/console/console-view.test.tsx \
  packages/trace-viewer/src/ui/shell/host-context.ts \
  packages/trace-viewer/src/ui/views/registry.ts packages/trace-viewer/src/ui/views/view-port.ts \
  packages/trace-viewer/src/ui/views/placeholder/ViewPlaceholder.tsx \
  packages/trace-viewer/src/ui/shell/KeyboardLayer.tsx packages/trace-viewer/src/ui/shell/Shell.tsx \
  packages/trace-viewer/src/ui/shell/TitleBar.tsx apps/trace-viewer-dev/scripts/smoke.mjs
git commit -m "feat(trace-viewer): virtualized Console view with live follow and decision actions"
```

### Task V-5: `buildBrief` and the `Brief` panel

Blocked by H1. Depends on V-2 (`ViewState.brief`); written after V-4, whose `ViewerHostContext` it does not need.

**Files:**
- Create: `packages/trace-viewer/src/layout/brief.ts`
- Create: `packages/trace-viewer/src/ui/inspector/Brief.tsx`, `packages/trace-viewer/src/ui/inspector/Brief.module.css`
- Create: `packages/trace-viewer/src/ui/inspector/RightPanel.tsx`
- Modify: `packages/trace-viewer/src/ui/shell/Shell.tsx` (the aside renders `RightPanel`)
- Modify: `packages/trace-viewer/src/ui/shell/TitleBar.tsx` (the Brief toggle button)
- Test: `packages/trace-viewer/src/layout/brief.test.ts`
- Test: `packages/trace-viewer/src/ui/inspector/brief.test.tsx`

**Interfaces:**
- Consumes: `TraceSession`, `Chapter`, `Step`, `NarrativeSentence`; `TraceIndex` (`entry`, `findingsById`); V-2 `ViewState.brief`, `brief/toggle`; `KIND_ICON`, `CATEGORY_ICON`; `DiffBar`, `TestDots`, `DurationBar`; `agentStateLabel`, `formatDuration`, `displayUntrusted`; `Inspector`, `ErrorBoundary`; `ViewDefinitionsContext`.
- Produces (interfaces §6.4, deviation 13):
  - `interface BriefModel { now; changes; architecture }` exactly as interfaces §6.4; `type BriefChange = BriefModel["changes"][number]`; `type BriefArchitecture = NonNullable<BriefModel["architecture"]>`.
  - `buildBrief(session: TraceSession, index: TraceIndex): BriefModel` (pure; `now.kind` is always `"rule"`; `architecture` is always `null` here).
  - `Brief()` (connected) and `BriefView(props: BriefViewProps)` (presentational; lanes 06 and 07 render it with filled `architecture` and story `now`).
  - `RightPanel({ host })`: the Brief when `selection === null || brief`, else the Inspector.

Rules (spec §3.3, §8.4):
- `now.runningStepId`: on a live session, the running step with the highest first seq, decisions excluded (a pending decision is reported on its own); null when not live.
- `now.latestUnitId`: the current, non-noise chapter with the highest `lastSeq` (ties by id).
- `now.pendingDecisionId`: the decision id of the latest decision step whose decision is `open`.
- `changes`: current, non-noise chapters, newest first by `lastSeq` (ties by id); `title` is `shortTitle ?? title` (raw; the view applies `displayUntrusted`); `added`/`removed` sum the chapter's own edit steps; `tests` is the latest run among the chapter's steps and validation steps that carries test counts, else null; `attention` is true when a warning or critical finding the chapter lists is anchored on one of the chapter's own steps (the anchor rule).

- [ ] **Step 1: Open the approved mockups**

Open `console-main-1440.png`, `console-states-1440.png` and `console-states-1000.png` with the Read tool. Note the Brief's three parts, icon-led headers, the accent-soft pending decision card, the quiet Architecture empty state and the 264 px layout at 1000 px.

- [ ] **Step 2: Write the failing model tests**

Create `packages/trace-viewer/src/layout/brief.test.ts`:

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { foldRows, type TraceSession } from "../model/index.js";
import { arbTraceSession } from "../test-support/arbitraries.js";
import { TraceBuilder, testMeta } from "../test-support/trace-builder.js";
import { buildBrief } from "./brief.js";
import { buildTraceIndex } from "./trace-index.js";

const NOW = Date.parse("2026-09-18T09:30:00.000Z");

function hunk(file: string, added: number, removed: number) {
  return { type: "git_hunk" as const, file, added, removed, isFormattingOnly: false, isConfigOnly: false, isLockfile: false };
}

function twoUnits(): TraceBuilder {
  const b = new TraceBuilder();
  b.agent({ type: "agent_started", prompt: "Add OAuth" });
  b.agent({ type: "file_changed", path: "src/google.ts", callId: "edit_g" });
  b.fact(hunk("src/google.ts", 86, 0), "fact_g");
  b.unit({ id: "cu_google", title: "Google provider", files: ["src/google.ts"], evidence: ["fact_g"], agentCallIds: ["edit_g"] });
  b.agent({ type: "file_changed", path: "src/identity.ts", callId: "edit_i" });
  b.fact(hunk("src/identity.ts", 41, 12), "fact_i");
  b.unit({ id: "cu_identity", title: "Identity linking", files: ["src/identity.ts"], evidence: ["fact_i"], agentCallIds: ["edit_i"] });
  return b;
}

function fold(b: TraceBuilder, state: "running" | "completed"): TraceSession {
  return foldRows(testMeta({ state, lastEventSeq: b.rows.length }), b.rows, { live: state === "running", nowMs: NOW });
}

describe("buildBrief (spec §3.3, §8.4)", () => {
  it("lists changes newest first with their diff counts and a rule-based Now", () => {
    const b = twoUnits();
    b.agent({ type: "command_started", command: "pnpm build" });
    const session = fold(b, "running");
    const brief = buildBrief(session, buildTraceIndex(session));
    const chapter = (id: string) => session.chapters.find((c) => c.id === id);
    const running = session.steps.find((step) => step.status === "running" && step.kind !== "decision");
    expect(brief.now).toEqual({ kind: "rule", runningStepId: running?.id ?? null, latestUnitId: "unit:cu_identity", pendingDecisionId: null });
    expect(running?.target).toBe("pnpm build");
    expect(brief.changes).toEqual([
      { unitId: "unit:cu_identity", title: chapter("unit:cu_identity")?.shortTitle ?? "Identity linking", added: 41, removed: 12, tests: null, attention: false },
      { unitId: "unit:cu_google", title: chapter("unit:cu_google")?.shortTitle ?? "Google provider", added: 86, removed: 0, tests: null, attention: false },
    ]);
    expect(brief.architecture).toBeNull();
  });

  it("reports a pending decision until it is answered, and no running step once the session is not live", () => {
    const b = twoUnits();
    b.decision({ id: "d1", title: "Keep password login?" });
    const pending = fold(b, "running");
    expect(buildBrief(pending, buildTraceIndex(pending)).now).toMatchObject({ pendingDecisionId: "d1", runningStepId: null });
    b.decision({ id: "d1", title: "Keep password login?", status: "answered", answer: { decisionId: "d1", decision: { choice: "a" }, evidence: [] } });
    const answered = fold(b, "completed");
    expect(buildBrief(answered, buildTraceIndex(answered)).now).toMatchObject({ pendingDecisionId: null, runningStepId: null });
  });

  it("gives a unit its latest test counts and flags a failing run anchored in it", () => {
    const b = twoUnits();
    b.agent({ type: "command_started", command: "pnpm test", callId: "t1" });
    b.agent({ type: "command_completed", command: "pnpm test", exitCode: 1, stdout: "", stderr: "", callId: "t1" });
    b.fact({
      type: "test_result", runner: "vitest", command: "pnpm test", passed: 14, failed: 1, skipped: 0,
      failures: [{ file: "a.test.ts", testName: "links accounts", message: "x" }], sourceCallId: "t1",
    }, "fact_t1");
    b.unit({
      id: "cu_identity", title: "Identity linking", files: ["src/identity.ts"],
      evidence: ["fact_i", "fact_t1"], agentCallIds: ["edit_i", "t1"],
    });
    const session = fold(b, "completed");
    const identity = buildBrief(session, buildTraceIndex(session)).changes.find((change) => change.unitId === "unit:cu_identity");
    expect(identity).toMatchObject({ added: 41, removed: 12, tests: { passed: 14, failed: 1 }, attention: true });
  });

  it("holds its invariants on generated sessions", () => {
    fc.assert(
      fc.property(arbTraceSession({ maxSteps: 60, maxChapters: 6 }), (session) => {
        const index = buildTraceIndex(session);
        const brief = buildBrief(session, index);
        expect(buildBrief(session, index)).toStrictEqual(brief);
        const shown = session.chapters.filter((chapter) => chapter.current && !chapter.noise);
        expect(new Set(brief.changes.map((change) => change.unitId))).toEqual(new Set(shown.map((chapter) => chapter.id)));
        const lastSeq = new Map(shown.map((chapter) => [chapter.id as string, chapter.lastSeq]));
        for (let i = 1; i < brief.changes.length; i += 1) {
          expect(lastSeq.get(brief.changes[i - 1]?.unitId ?? "") ?? 0).toBeGreaterThanOrEqual(lastSeq.get(brief.changes[i]?.unitId ?? "") ?? 0);
        }
        for (const change of brief.changes) {
          expect(change.added).toBeGreaterThanOrEqual(0);
          expect(change.removed).toBeGreaterThanOrEqual(0);
        }
        const now = brief.now;
        expect(now.kind).toBe("rule");
        if (now.kind === "rule" && now.runningStepId !== null) {
          expect(session.live).toBe(true);
          expect(session.steps.find((step) => step.id === now.runningStepId)?.status).toBe("running");
        }
        expect(brief.architecture).toBeNull();
      }),
      { numRuns: 150 },
    );
  });
});
```

- [ ] **Step 3: Write the failing panel tests**

Create `packages/trace-viewer/src/ui/inspector/brief.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildBrief, type BriefModel } from "../../layout/brief.js";
import { buildTraceIndex } from "../../layout/trace-index.js";
import { foldFixture, renderHarness, stubLayout, type LayoutStub } from "../../test-support/ui-harness.js";
import { TitleBar } from "../shell/TitleBar.js";
import { BriefView } from "./Brief.js";
import { RightPanel } from "./RightPanel.js";

let layout: LayoutStub;
beforeEach(() => {
  layout = stubLayout();
});
afterEach(() => {
  cleanup();
  layout.restore();
  vi.restoreAllMocks();
});

const noop = (): void => undefined;

function oauthModel(): { session: ReturnType<typeof foldFixture>; model: BriefModel } {
  const session = foldFixture("oauth");
  return { session, model: buildBrief(session, buildTraceIndex(session)) };
}

function renderView(model: BriefModel, onSelect = vi.fn(), onOpenMap = vi.fn()) {
  const session = foldFixture("oauth");
  render(
    <BriefView model={model} session={session} index={buildTraceIndex(session)} nowT={0} onSelect={onSelect} onOpenMap={onOpenMap} mapAvailable />,
  );
  return { onSelect, onOpenMap };
}

describe("Brief (spec §3.3, E4)", () => {
  it("fills the panel when nothing is selected, gives way to the Inspector on a selection, and Shift+B pins it back", () => {
    const session = foldFixture("oauth");
    const step = session.steps[2];
    if (step === undefined) throw new Error("oauth has fewer than 3 steps");
    const h = renderHarness(<RightPanel host={{}} />, session);
    expect(screen.getByRole("heading", { name: "Brief" })).toBeTruthy();
    for (const name of ["Now", "Changes so far", "Architecture"]) expect(screen.getByRole("heading", { name })).toBeTruthy();
    act(() => h.store.dispatch({ type: "select", id: step.id, by: "shell" }));
    expect(screen.queryByRole("heading", { name: "Brief" })).toBeNull();
    expect(screen.getByRole("tablist", { name: "Inspector tabs" })).toBeTruthy();
    act(() => h.store.dispatch({ type: "brief/toggle" }));
    expect(screen.getByRole("heading", { name: "Brief" })).toBeTruthy();
    act(() => h.store.dispatch({ type: "select", id: null, by: "shell" }));
    expect(screen.getByRole("heading", { name: "Brief" })).toBeTruthy();
  });

  it("lists every current unit and opens one in the active view on click", () => {
    const { session, model } = oauthModel();
    const { onSelect } = renderView(model);
    const list = within(screen.getByRole("list", { name: "Changes so far" }));
    expect(list.getAllByRole("button")).toHaveLength(Math.min(model.changes.length, 8));
    const first = model.changes[0];
    if (first === undefined) throw new Error("oauth has no change units");
    fireEvent.click(list.getAllByRole("button")[0] as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith(first.unitId);
    expect(session.chapters.some((chapter) => chapter.id === first.unitId)).toBe(true);
  });

  it("renders untrusted titles as tokens, with the full text as the accessible name", () => {
    const { model } = oauthModel();
    const first = model.changes[0];
    if (first === undefined) throw new Error("oauth has no change units");
    renderView({ ...model, changes: [{ ...first, title: "Fix ‮login\u0007" }] });
    const button = within(screen.getByRole("list", { name: "Changes so far" })).getByRole("button");
    expect(button.textContent).toContain("Fix ⟨U+202E⟩login⟨U+0007⟩");
    expect(button.textContent).not.toContain("‮");
    expect(button.getAttribute("aria-label")).toContain("Fix ⟨U+202E⟩login⟨U+0007⟩");
  });

  it("shows quiet Architecture states and never an error banner", () => {
    const { model } = oauthModel();
    renderView(model);
    expect(screen.getByText("Appears here once this repository is scanned.")).toBeTruthy();
    cleanup();

    renderView({ ...model, architecture: { overviewSentences: null, componentCount: 12, touched: ["cmp_0123456789ab"], scanning: null } });
    expect(screen.getByText("12 components · 1 touched")).toBeTruthy();
    expect(screen.getByText("Descriptions pending")).toBeTruthy();
    cleanup();

    renderView({ ...model, architecture: { overviewSentences: null, componentCount: 0, touched: [], scanning: { done: 3200, total: 9800 } } });
    expect(screen.getByText("Mapping codebase · 3,200 / 9,800 files")).toBeTruthy();
    cleanup();

    const { onOpenMap } = renderView({
      ...model,
      architecture: {
        overviewSentences: [{ text: "A pnpm workspace with an Electron ‮app.", citations: [{ kind: "component", id: "cmp_0123456789ab" }] }],
        componentCount: 12,
        touched: [],
        scanning: null,
      },
    });
    expect(screen.getByText("A pnpm workspace with an Electron ⟨U+202E⟩app.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open the map" }));
    expect(onOpenMap).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("the title bar's Brief toggle pins the Brief over a selection", () => {
    const session = foldFixture("oauth");
    const step = session.steps[2];
    if (step === undefined) throw new Error("oauth has fewer than 3 steps");
    const h = renderHarness(<TitleBar onRetry={noop} />, session);
    const toggle = screen.getByRole("button", { name: "Brief" });
    expect(toggle.hasAttribute("disabled")).toBe(true);
    act(() => h.store.dispatch({ type: "select", id: step.id, by: "shell" }));
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(h.store.get().brief).toBe(true);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/brief.test.ts src/ui/inspector/brief.test.tsx`

Expected: FAIL with "Failed to load url ./brief.js" and "./Brief.js".

- [ ] **Step 5: Implement `buildBrief`**

Create `packages/trace-viewer/src/layout/brief.ts`:

```ts
import type { NarrativeSentence } from "@jevcode/contracts";

import type { Chapter, Step, TraceSession } from "../model/index.js";
import type { TraceIndex } from "./trace-index.js";

/** The Brief's three parts (spec §3.3, §8.4; interfaces §6.4). Lane 06 fills `architecture`, lane 07 adds the story `now`. */
export interface BriefModel {
  now:
    | { kind: "rule"; runningStepId: string | null; latestUnitId: string | null; pendingDecisionId: string | null }
    | { kind: "story"; sentences: NarrativeSentence[]; basisSeq: number; provenance?: "rule" | "model" };
  changes: { unitId: string; title: string; added: number; removed: number; tests: { passed: number; failed: number } | null; attention: boolean }[];
  architecture: { overviewSentences: NarrativeSentence[] | null; componentCount: number; touched: string[]; scanning: { done: number; total: number } | null } | null;
}

export type BriefChange = BriefModel["changes"][number];
export type BriefArchitecture = NonNullable<BriefModel["architecture"]>;

function compareNewest(a: Chapter, b: Chapter): number {
  return b.lastSeq - a.lastSeq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function shownChapters(session: TraceSession): Chapter[] {
  return session.chapters.filter((chapter) => chapter.current && !chapter.noise).sort(compareNewest);
}

function runningStepOf(session: TraceSession): string | null {
  if (!session.live) return null;
  for (let i = session.steps.length - 1; i >= 0; i -= 1) {
    const step = session.steps[i];
    if (step !== undefined && step.status === "running" && step.kind !== "decision") return step.id;
  }
  return null;
}

function pendingDecisionOf(session: TraceSession): string | null {
  for (let i = session.steps.length - 1; i >= 0; i -= 1) {
    const decision = session.steps[i]?.decision;
    if (decision !== undefined && decision.status === "open") return decision.decisionId;
  }
  return null;
}

function changeOf(chapter: Chapter, session: TraceSession, index: TraceIndex): BriefChange {
  const own = new Set<string>(chapter.stepIds);
  const stepOf = (id: string): Step | undefined => {
    const entry = index.entry(id);
    return entry?.kind === "step" ? session.steps[entry.position] : undefined;
  };
  let added = 0;
  let removed = 0;
  let tests: BriefChange["tests"] = null;
  let testsSeq = -1;
  for (const id of new Set<string>([...chapter.stepIds, ...chapter.validationStepIds])) {
    const step = stepOf(id);
    if (step === undefined) continue;
    if (step.edit !== undefined && own.has(id)) {
      added += step.edit.added;
      removed += step.edit.removed;
    }
    if (step.tests !== undefined && step.firstSeq > testsSeq) {
      testsSeq = step.firstSeq;
      tests = { passed: step.tests.passed, failed: step.tests.failed };
    }
  }
  const attention = chapter.findingIds.some((id) => {
    const finding = index.findingsById.get(id);
    return finding !== undefined && finding.severity !== "info" && own.has(finding.anchorStepId);
  });
  return { unitId: chapter.id, title: chapter.shortTitle ?? chapter.title, added, removed, tests, attention };
}

/** Pure (spec §8.4): the rule-based Brief of phases A and B. `architecture` stays null until lane 06 fills it. */
export function buildBrief(session: TraceSession, index: TraceIndex): BriefModel {
  const chapters = shownChapters(session);
  return {
    now: {
      kind: "rule",
      runningStepId: runningStepOf(session),
      latestUnitId: chapters[0]?.id ?? null,
      pendingDecisionId: pendingDecisionOf(session),
    },
    changes: chapters.map((chapter) => changeOf(chapter, session, index)),
    architecture: null,
  };
}
```

- [ ] **Step 6: Implement the panel**

Create `packages/trace-viewer/src/ui/inspector/Brief.tsx`:

```tsx
import { useContext, useEffect, useMemo, useReducer, type JSX } from "react";

import { buildBrief, type BriefArchitecture, type BriefChange, type BriefModel } from "../../layout/brief.js";
import type { SelectionId, TraceIndex } from "../../layout/trace-index.js";
import {
  agentStateLabel,
  displayUntrusted,
  formatDuration,
  type Chapter,
  type Step,
  type TraceSession,
} from "../../model/index.js";
import { DiffBar } from "../graphics/DiffBar.js";
import { DurationBar } from "../graphics/DurationBar.js";
import { TestDots } from "../graphics/TestDots.js";
import { Icon } from "../icons/Icon.js";
import { CATEGORY_ICON, KIND_ICON } from "../icons/kind-icons.js";
import { displaySpanMs } from "../shell/TitleBar.js";
import { useSessionView } from "../shell/session-context.js";
import { useDispatch } from "../state/store.js";
import { ViewDefinitionsContext } from "../views/view-port.js";
import styles from "./Brief.module.css";

/** Changes the list shows before "n more" (the Changes list is a summary; the views hold the rest). */
export const BRIEF_CHANGES_SHOWN = 8;

export interface BriefViewProps {
  model: BriefModel;
  session: TraceSession;
  index: TraceIndex;
  /** Display-clock now, for the running bar. */
  nowT: number;
  onSelect(id: SelectionId): void;
  onOpenMap(): void;
  /** A Map view is registered (always in v1; the button hides otherwise). */
  mapAvailable: boolean;
}

function stepOf(session: TraceSession, index: TraceIndex, id: string | null): Step | undefined {
  if (id === null) return undefined;
  const entry = index.entry(id);
  return entry?.kind === "step" ? session.steps[entry.position] : undefined;
}

function chapterOf(session: TraceSession, index: TraceIndex, id: string | null): Chapter | undefined {
  if (id === null) return undefined;
  const entry = index.entry(id);
  return entry?.kind === "chapter" ? session.chapters[entry.position] : undefined;
}

function Now({ model, session, index, nowT, onSelect }: BriefViewProps): JSX.Element {
  const now = model.now;
  if (now.kind === "story") {
    // Lane 07 (S-4) renders the story with citation chips against the Phase C mockup.
    return <p className={styles.prose}>{now.sentences.map((sentence) => displayUntrusted(sentence.text)).join(" ")}</p>;
  }
  const running = stepOf(session, index, now.runningStepId);
  const latest = chapterOf(session, index, now.latestUnitId);
  const latestChange = model.changes.find((change) => change.unitId === now.latestUnitId);
  let decisionStep: Step | undefined;
  for (let i = session.steps.length - 1; i >= 0 && now.pendingDecisionId !== null; i -= 1) {
    const step = session.steps[i];
    if (step?.decision?.decisionId === now.pendingDecisionId && step.decision.status === "open") {
      decisionStep = step;
      break;
    }
  }
  const idle = running === undefined && latest === undefined && decisionStep === undefined;
  return (
    <div className={styles.now}>
      {running === undefined ? null : (
        <button type="button" className={styles.item} onClick={() => onSelect(running.id)}>
          <Icon name={KIND_ICON[running.kind]} size={14} className={styles.icon} />
          <span className={`${styles.title} ${styles.mono}`}>{running.headline}</span>
          <DurationBar size="xs" durationMs={null} running elapsedMs={Math.max(0, nowT - running.tMs)} end="none" />
          <span className={styles.meta}>{formatDuration(Math.max(0, nowT - running.tMs))}</span>
        </button>
      )}
      {idle ? (
        <p className={styles.quiet}>
          <Icon name="clock" size={14} className={styles.icon} />
          {session.steps.length === 0
            ? "Waiting for the agent's first event"
            : `${agentStateLabel(session.meta.state)} · ${formatDuration(displaySpanMs(session))}`}
        </p>
      ) : null}
      {latest === undefined ? null : (
        <button
          type="button"
          className={styles.item}
          aria-label={`Latest change: ${displayUntrusted(latest.title)}`}
          onClick={() => onSelect(latest.id)}
        >
          <Icon name={CATEGORY_ICON[latest.category]} size={14} className={styles.icon} />
          <span className={styles.title}>{displayUntrusted(latest.shortTitle ?? latest.title)}</span>
          {latestChange === undefined ? null : <DiffBar size="xs" added={latestChange.added} removed={latestChange.removed} />}
        </button>
      )}
      {decisionStep === undefined || decisionStep.decision === undefined ? null : (
        <button type="button" className={styles.decision} onClick={() => onSelect(decisionStep.id)}>
          <span className={styles.question}>
            <Icon name="fork" size={14} />
            <span>{displayUntrusted(decisionStep.decision.title)}</span>
          </span>
          <span className={styles.ask}>Needs your decision</span>
        </button>
      )}
    </div>
  );
}

function ChangeRow({ change, session, index, onSelect }: { change: BriefChange; session: TraceSession; index: TraceIndex; onSelect(id: SelectionId): void }) {
  const chapter = chapterOf(session, index, change.unitId);
  const title = displayUntrusted(change.title);
  const parts = [title, `+${change.added} −${change.removed}`];
  if (change.tests !== null) parts.push(`${change.tests.passed} passed, ${change.tests.failed} failed`);
  if (change.attention) parts.push("needs attention");
  return (
    <li>
      <button type="button" className={styles.change} aria-label={parts.join(", ")} title={title} onClick={() => onSelect(change.unitId as SelectionId)}>
        <Icon name={chapter === undefined ? "list" : CATEGORY_ICON[chapter.category]} size={14} className={styles.icon} />
        <span className={styles.title}>{title}</span>
        <DiffBar size="xs" added={change.added} removed={change.removed} />
        {change.tests === null ? <span /> : <TestDots size="xs" passed={change.tests.passed} failed={change.tests.failed} skipped={0} />}
        {change.attention ? <Icon name="flag" size={12} className={styles.flag} /> : <span />}
      </button>
    </li>
  );
}

function Architecture({ architecture, onOpenMap, mapAvailable }: { architecture: BriefArchitecture | null; onOpenMap(): void; mapAvailable: boolean }) {
  if (architecture === null) {
    return (
      <div className={styles.empty}>
        <Icon name="view-map" size={14} className={styles.icon} />
        <span>
          <span className={styles.emptyTitle}>Codebase map</span>
          <span>Appears here once this repository is scanned.</span>
        </span>
      </div>
    );
  }
  if (architecture.scanning !== null) {
    const { done, total } = architecture.scanning;
    const share = total > 0 ? Math.min(1, done / total) : 0;
    return (
      <div className={styles.empty}>
        <Icon name="view-map" size={14} className={styles.icon} />
        <span className={styles.grow}>
          <span className={styles.emptyTitle}>{`Mapping codebase · ${done.toLocaleString("en-US")} / ${total.toLocaleString("en-US")} files`}</span>
          <span className={styles.progress} aria-hidden="true">
            <span style={{ width: `${Math.round(share * 100)}%` }} />
          </span>
        </span>
      </div>
    );
  }
  const counts = `${architecture.componentCount} components${architecture.touched.length > 0 ? ` · ${architecture.touched.length} touched` : ""}`;
  return (
    <div className={styles.architecture}>
      <p className={styles.meta}>{counts}</p>
      {architecture.overviewSentences === null ? (
        <p className={styles.quiet}>Descriptions pending</p>
      ) : (
        <p className={styles.prose}>{architecture.overviewSentences.map((sentence) => displayUntrusted(sentence.text)).join(" ")}</p>
      )}
      {mapAvailable ? (
        <button type="button" className={styles.link} onClick={onOpenMap}>
          Open the map
        </button>
      ) : null}
    </div>
  );
}

/** Presentational Brief (spec §3.3): Now, Changes so far, Architecture. Every agent or narrator string goes through displayUntrusted. */
export function BriefView(props: BriefViewProps): JSX.Element {
  const { model, session, index, onSelect } = props;
  const shown = model.changes.slice(0, BRIEF_CHANGES_SHOWN);
  const more = model.changes.length - shown.length;
  return (
    <section className={styles.brief} aria-labelledby="tv-brief-title">
      <header className={styles.header}>
        <Icon name="brief" size={16} />
        <h2 id="tv-brief-title" className={styles.heading}>Brief</h2>
        <span className={styles.state}>{session.live ? "Live" : agentStateLabel(session.meta.state)}</span>
      </header>
      <section className={styles.part} aria-labelledby="tv-brief-now">
        <h3 id="tv-brief-now" className={styles.partTitle}>
          <Icon name="live" size={12} />
          Now
        </h3>
        <Now {...props} />
      </section>
      <section className={styles.part} aria-labelledby="tv-brief-changes">
        <h3 id="tv-brief-changes" className={styles.partTitle}>
          <Icon name="list" size={12} />
          Changes so far
          {model.changes.length > 0 ? <span className={styles.count}>{model.changes.length}</span> : null}
        </h3>
        {model.changes.length === 0 ? (
          <p className={styles.quiet}>No changes yet</p>
        ) : (
          <ul className={styles.changes} aria-label="Changes so far">
            {shown.map((change) => (
              <ChangeRow key={change.unitId} change={change} session={session} index={index} onSelect={onSelect} />
            ))}
          </ul>
        )}
        {more > 0 ? <p className={styles.quiet}>{`${more} more in the views`}</p> : null}
      </section>
      <section className={styles.part} aria-labelledby="tv-brief-architecture">
        <h3 id="tv-brief-architecture" className={styles.partTitle}>
          <Icon name="route" size={12} />
          Architecture
        </h3>
        <Architecture architecture={model.architecture} onOpenMap={props.onOpenMap} mapAvailable={props.mapAvailable} />
      </section>
    </section>
  );
}

/** The Brief of the shown session, rendered by the right panel when nothing is selected (spec §8.4). */
export function Brief(): JSX.Element {
  const { session, index, nowT, terminal } = useSessionView();
  const dispatch = useDispatch();
  const views = useContext(ViewDefinitionsContext);
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const model = useMemo(() => (session === null ? null : buildBrief(session, index)), [session, index]);
  const running = model !== null && model.now.kind === "rule" && model.now.runningStepId !== null;
  useEffect(() => {
    if (!running || terminal) return undefined;
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, [running, terminal]);
  if (session === null || model === null) {
    return (
      <section className={styles.brief} aria-labelledby="tv-brief-title">
        <header className={styles.header}>
          <Icon name="brief" size={16} />
          <h2 id="tv-brief-title" className={styles.heading}>Brief</h2>
        </header>
        <p className={styles.quiet}>Loading</p>
      </section>
    );
  }
  return (
    <BriefView
      model={model}
      session={session}
      index={index}
      nowT={nowT()}
      onSelect={(id) => dispatch({ type: "select", id, by: "shell" })}
      onOpenMap={() => dispatch({ type: "view/switch", view: "map" })}
      mapAvailable={views.some((view) => view.kind === "map")}
    />
  );
}
```

Create `packages/trace-viewer/src/ui/inspector/Brief.module.css`:

```css
.brief {
  display: flex;
  flex-direction: column;
  gap: 18px;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 16px 20px;
  font-size: 13px;
  line-height: 18px;
  color: var(--tv-ink-2);
}

.header {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--tv-ink);
}

.heading {
  margin: 0;
  font-size: 13px;
  line-height: 18px;
  font-weight: 600;
}

.state {
  margin-left: auto;
  font-size: 12px;
  color: var(--tv-ink-3);
}

.part {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.partTitle {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 12px;
  line-height: 16px;
  font-weight: 500;
  color: var(--tv-ink-3);
}

.count {
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}

.now {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.item,
.change {
  display: grid;
  align-items: center;
  column-gap: 8px;
  width: 100%;
  min-height: 28px;
  margin: 0 -6px;
  padding: 0 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--tv-ink-2);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.item {
  grid-template-columns: 16px minmax(0, 1fr) auto auto;
}

.change {
  grid-template-columns: 16px minmax(0, 1fr) auto auto 14px;
}

.item:hover,
.change:hover {
  background: var(--tv-fill);
}

.item:focus-visible,
.change:focus-visible,
.decision:focus-visible,
.link:focus-visible {
  outline: 2px solid var(--tv-accent);
  outline-offset: 1px;
}

.icon {
  color: var(--tv-ink-3);
}

.title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--tv-ink);
}

.mono {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12px;
}

.meta {
  margin: 0;
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-ink-3);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.decision {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 0;
  border-radius: 9px;
  background: var(--tv-accent-soft);
  color: var(--tv-ink);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.question {
  display: flex;
  gap: 8px;
  font-weight: 500;
}

.ask {
  margin-left: 22px;
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-accent-ink);
}

.changes {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.flag {
  color: var(--tv-ink-2);
}

.quiet {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-ink-3);
}

.prose {
  margin: 0;
  color: var(--tv-ink-2);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.empty {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px;
  border-radius: 9px;
  background: var(--tv-fill);
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-ink-3);
}

.empty > span {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.emptyTitle {
  font-weight: 500;
  color: var(--tv-ink-2);
}

.grow {
  flex: 1;
  min-width: 0;
}

.progress {
  display: block;
  height: 4px;
  margin-top: 6px;
  border-radius: 2px;
  background: var(--tv-fill-2);
  overflow: hidden;
}

.progress > span {
  display: block;
  height: 4px;
  background: var(--tv-ink-3);
}

.architecture {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.link {
  align-self: flex-start;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--tv-accent-ink);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
```

Create `packages/trace-viewer/src/ui/inspector/RightPanel.tsx`:

```tsx
import type { JSX } from "react";

import type { ViewerHost } from "../shell/host.js";
import { ErrorBoundary } from "../shell/ErrorBoundary.js";
import { useView } from "../state/store.js";
import { Brief } from "./Brief.js";
import { Inspector } from "./Inspector.js";

/** Spec §3.3, E4: the Brief whenever nothing is selected or B pinned it; the Inspector for a selection. */
export function RightPanel({ host }: { host: ViewerHost }): JSX.Element {
  const showBrief = useView((state) => state.selection === null || state.brief);
  return showBrief ? (
    <ErrorBoundary region="Brief">
      <Brief />
    </ErrorBoundary>
  ) : (
    <Inspector host={host} />
  );
}
```

In `packages/trace-viewer/src/ui/shell/Shell.tsx`, replace `import { Inspector } from "../inspector/Inspector.js";` with `import { RightPanel } from "../inspector/RightPanel.js";`, then find:

```tsx
                    <Inspector host={host} />
```

Replace it with:

```tsx
                    <RightPanel host={host} />
```

In `packages/trace-viewer/src/ui/shell/TitleBar.tsx`, add after `const follow = useView((state) => state.follow);`:

```ts
  const hasSelection = useView((state) => state.selection !== null);
  const briefPinned = useView((state) => state.brief);
```

and find:

```tsx
      {status.kind === "error" ? (
```

Replace it with:

```tsx
      <button
        type="button"
        className={styles.retry}
        aria-pressed={!hasSelection || briefPinned}
        disabled={!hasSelection}
        title="Brief (B)"
        onClick={() => dispatch({ type: "brief/toggle" })}
      >
        <Icon name="brief" size={14} />
        <span>Brief</span>
      </button>

      {status.kind === "error" ? (
```

(The button reuses the bar's quiet `retry` style; when nothing is selected the Brief is already shown, so the button is pressed and disabled.)

- [ ] **Step 7: Run the tests to verify they pass**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/brief.test.ts src/ui/inspector src/ui/shell`

Expected: PASS. The title-bar test "the title bar's Brief toggle…" checks `aria-pressed` `"false"` with a selection; before a selection the button is disabled. `shell.test.tsx` still finds the `complementary` landmark named "Inspector" (the aside keeps its label).

- [ ] **Step 8: Typecheck, lint and the package suite**

Run the package typecheck, lint, and the package suite in the background; expect no failures. A test that rendered the whole viewer and read the Inspector's session summary with nothing selected would now see the Brief; none exists at this commit (checked: no Shell-level test reads it), so any such failure is a regression to fix in `RightPanel`.

- [ ] **Step 9: Headless screenshots against the mockup**

Run the smoke in the background (as in V-4 Step 9) with `--views console,hybrid --port 4183` and poll for `SMOKE_OK 4 screenshots`; it also rebuilds `apps/trace-viewer-dev/dist`. The oauth bundle opens in Review with its claim selected, so those screenshots show the Inspector. A dripping session opens in Live with nothing selected, so the Brief screenshots come from a drip:

```bash
perl -e 'alarm 120; exec @ARGV' pnpm --filter jevcode-trace-viewer-dev exec vite preview --port 4184 --strictPort > .superpowers/preview.log 2>&1 &
perl -e 'alarm 20; exec @ARGV' sh -c 'until curl -sf http://localhost:4184/ > /dev/null; do perl -e "select(undef, undef, undef, 0.25)"; done'
CHROME="${CHROME_PATH:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
SID=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("apps/trace-viewer-dev/public/bundles/oauth.json","utf8")).session.sessionId)')
HASH=$(node -e 'console.log(encodeURIComponent(JSON.stringify({v:1,sessionId:process.argv[1],view:"console",level:"chapter",brush:{kind:"session"}})))' "$SID")
for width in 1440 1000; do
  perl -e 'alarm 60; exec @ARGV' "$CHROME" --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$(mktemp -d)" \
    --window-size=${width},900 --virtual-time-budget=4000 \
    --screenshot="$PWD/apps/trace-viewer-dev/.smoke/brief-${width}.png" "http://localhost:4184/?bundle=oauth&drip=4,200,-60#${HASH}"
done
pkill -f "vite preview --port 4184"
```

Open `brief-1440.png` and `brief-1000.png` beside `console-main-1440.png` and `console-states-1440.png` and compare the Brief: header and state word, the three icon-led parts, the running row with its bar, the change rows (icon, title, DiffBar, dots, flag), the quiet Architecture empty state, spacing at 248 px (the full chrome's narrow inspector) and 280 px. Fix differences in `Brief.module.css` and rerun.

- [ ] **Step 10: Commit**

```bash
git add packages/trace-viewer/src/layout/brief.ts packages/trace-viewer/src/layout/brief.test.ts \
  packages/trace-viewer/src/ui/inspector/Brief.tsx packages/trace-viewer/src/ui/inspector/Brief.module.css \
  packages/trace-viewer/src/ui/inspector/RightPanel.tsx packages/trace-viewer/src/ui/inspector/brief.test.tsx \
  packages/trace-viewer/src/ui/shell/Shell.tsx packages/trace-viewer/src/ui/shell/TitleBar.tsx
git commit -m "feat(trace-viewer): rule-based Brief v0 in the right panel"
```

### Task V-6: Console perf harness and dev-host wiring

**Files:**
- Modify: `packages/trace-viewer/src/source.ts` (`ROWS_RELEASED_MARK`)
- Modify: `packages/trace-viewer/src/sources/static-bundle.ts` (`tick` marks releases)
- Modify: `packages/trace-viewer/src/ui/shell/perf.ts` (`PERF.consoleAppend`, `measureFromFirstAfterPaint`)
- Modify: `packages/trace-viewer/src/ui/views/console/ConsoleView.tsx` (the append measure)
- Modify: `apps/trace-viewer-dev/src/host.tsx`, `apps/trace-viewer-dev/src/host.module.css` (`?chrome=embedded`, `?view=`)
- Modify: `apps/trace-viewer-dev/src/perf-hud.tsx` (`?perfrun=console`)
- Create: `apps/trace-viewer-dev/scripts/console-bundle.mjs`
- Modify: `apps/trace-viewer-dev/scripts/smoke.mjs` (`--embedded`, `--console-perf`)
- Modify: `docs/perf.md` (new section at the end)
- Test: `packages/trace-viewer/src/ui/shell/perf.test.ts` (create), `packages/trace-viewer/src/sources/static-bundle.test.ts`

**Interfaces:**
- Consumes: V-1 `StaticBundleSource` drip and `onRowsAvailable`; V-2 `TraceViewerProps.chrome`, `initialView`, `renderSwitch`, `ViewKind`; V-4 `ConsoleView`, `data-console`, `data-step-count`, `data-console-scroll`; the dev host's `PerfHud`, `parseDrip`, `resolveDrip`; `markAfterPaint`, `measureAfterPaint`, `PERF`.
- Produces:
  - `ROWS_RELEASED_MARK = "tv:rows-released"` (`src/source.ts`, re-exported by the package index through `export * from "./source.js"`).
  - `PERF.consoleAppend = "tv:console-append"`; `measureFromFirstAfterPaint(name: string, startMark: string): void`.
  - Dev host parameters `?chrome=embedded` (a stand-in main-window frame with the host-placed switcher and a static prompt dock) and `?view=<kind>`; `?perfrun=console` writes `{ steps, scroll: { frames, refreshMs, droppedPct, p95Rounded }, append: { name, count, median, p95 } }` (or `{ error }`) to `<pre id="perf-result">`.
  - `smoke.mjs --embedded` (screenshots `console-embedded-<width>.png`), `smoke.mjs --console-perf` (prints `CONSOLE_PERF …` and fails on a miss).

Measures (spec §11): **append latency** runs from the drip's release mark (the dev host's "row stored") to the paint after the Console commit that applied it, measured from the oldest pending release; **scroll** is a 3 s scripted reader scroll (90 frames up, 90 down, 900 px per frame, with wheel events so the Console treats it as the reader's) on a session of at least 10,000 steps, its rAF intervals rounded to refresh intervals (the viewer spec §10 method): dropped = Σ(rounded − 1) / Σ rounded.

- [ ] **Step 1: Open the approved mockup**

Open `console-main-1440.png` and `console-main-1000.png`: the embedded screenshot of this task is compared against their workspace column (view bar, Console, Brief, prompt dock).

- [ ] **Step 2: Write the failing tests**

Create `packages/trace-viewer/src/ui/shell/perf.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

import { measureFromFirstAfterPaint, PERF } from "./perf.js";

afterEach(() => {
  vi.unstubAllGlobals();
  performance.clearMarks();
  performance.clearMeasures();
});

describe("measureFromFirstAfterPaint (spec §11 Console append)", () => {
  it("measures from the oldest pending start mark to the paint, and clears every start mark", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    performance.mark("tv:test-start", { startTime: 10 });
    performance.mark("tv:test-start", { startTime: 40 });
    measureFromFirstAfterPaint("tv:test-append", "tv:test-start");
    expect(performance.getEntriesByName("tv:test-start", "mark")).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [entry] = performance.getEntriesByName("tv:test-append", "measure");
    expect(entry?.startTime).toBe(10);
    expect(PERF.consoleAppend).toBe("tv:console-append");
  });

  it("does nothing without a pending start mark", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    measureFromFirstAfterPaint("tv:test-append", "tv:test-start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(performance.getEntriesByName("tv:test-append", "measure")).toHaveLength(0);
  });
});
```

In `packages/trace-viewer/src/sources/static-bundle.test.ts`, add `import { ROWS_RELEASED_MARK } from "../source.js";` and, inside `describe("createStaticBundleSource", …)`:

```ts
  it("marks tv:rows-released on every drip tick that releases rows", () => {
    performance.clearMarks(ROWS_RELEASED_MARK);
    const source = createStaticBundleSource(bundle(), { drip: { rowsPerTick: 2, intervalMs: 100, manual: true } });
    source.tick();
    expect(performance.getEntriesByName(ROWS_RELEASED_MARK, "mark")).toHaveLength(1);
    source.tick();
    source.tick();
    expect(performance.getEntriesByName(ROWS_RELEASED_MARK, "mark")).toHaveLength(2);
    performance.clearMarks(ROWS_RELEASED_MARK);
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/shell/perf.test.ts src/sources/static-bundle.test.ts`

Expected: FAIL: `measureFromFirstAfterPaint` and `ROWS_RELEASED_MARK` are not exported.

- [ ] **Step 4: Release marks and the measure helper**

In `packages/trace-viewer/src/source.ts`, append:

```ts
/**
 * Marked when a drip source releases rows (the dev host's "row stored", spec §11 Console append latency). The
 * Console measures from the oldest pending mark to the paint after the commit that applies those rows.
 */
export const ROWS_RELEASED_MARK = "tv:rows-released";
```

In `packages/trace-viewer/src/sources/static-bundle.ts`, change the import `import type { TraceRowsRequest, TraceSource } from "../source.js";` to:

```ts
import { ROWS_RELEASED_MARK, type TraceRowsRequest, type TraceSource } from "../source.js";
```

and in `tick`, find:

```ts
    if (released === before) return;
    const seq = lastReleasedSeq();
```

Replace it with:

```ts
    if (released === before) return;
    if (typeof performance !== "undefined" && typeof performance.mark === "function") performance.mark(ROWS_RELEASED_MARK);
    const seq = lastReleasedSeq();
```

In `packages/trace-viewer/src/ui/shell/perf.ts`, find:

```ts
  liveTick: "tv:live-tick",
} as const;
```

Replace it with:

```ts
  liveTick: "tv:live-tick",
  /** Spec 2026-10-02 §11: row stored (ROWS_RELEASED_MARK) → Console line painted. */
  consoleAppend: "tv:console-append",
} as const;
```

and append to the file:

```ts
/**
 * Like measureAfterPaint, but from the OLDEST pending `startMark`, and clears them all: when several releases land
 * before one commit, the append latency is the wait of the oldest row (spec 2026-10-02 §11 "row stored → line painted").
 */
export function measureFromFirstAfterPaint(name: string, startMark: string): void {
  if (
    typeof performance === "undefined" ||
    typeof requestAnimationFrame === "undefined" ||
    typeof MessageChannel === "undefined"
  ) {
    return;
  }
  const start = performance.getEntriesByName(startMark, "mark")[0];
  if (start === undefined) return;
  performance.clearMarks(startMark);
  const startTime = start.startTime;
  requestAnimationFrame(() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      performance.measure(name, { start: startTime, end: performance.now() });
    };
    channel.port2.postMessage(null);
  });
}
```

In `packages/trace-viewer/src/ui/views/console/ConsoleView.tsx`, add the imports:

```ts
import { ROWS_RELEASED_MARK } from "../../../source.js";
import { measureFromFirstAfterPaint, PERF } from "../../shell/perf.js";
```

and add, after the drift `useLayoutEffect`:

```tsx
  // Spec §11 append latency: every commit that rebuilt the rows measures from the oldest release to the next paint.
  // A hidden Console drops pending marks, so a later sample never spans the time it was hidden.
  useLayoutEffect(() => {
    if (active) measureFromFirstAfterPaint(PERF.consoleAppend, ROWS_RELEASED_MARK);
    else if (typeof performance !== "undefined") performance.clearMarks(ROWS_RELEASED_MARK);
  }, [built, active]);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/shell/perf.test.ts src/sources/static-bundle.test.ts src/ui/views/console/console-view.test.tsx`

Expected: PASS.

- [ ] **Step 6: The 10k-step bundle**

Create `apps/trace-viewer-dev/scripts/console-bundle.mjs`:

```js
#!/usr/bin/env node
// Writes public/bundles/console-10k.json: one finished session with more than 10,000 Console steps, the input of the
// spec 2026-10-02 §11 Console budgets. Run after `pnpm -r build`: it validates the bundle with the contracts' dist.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TRACE_BUNDLE_FORMAT, TRACE_BUNDLE_VERSION, TraceBundleSchema } from "@jevcode/contracts";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(APP, "public", "bundles", "console-10k.json");
// 5.2 Console steps per unit (message, read, command, edit, reasoning, and a test run every fifth unit).
const UNITS = Number(process.env.CONSOLE_UNITS ?? 2_100);
const SESSION_ID = "sess-console-10k";
const REPO_ID = "repo-console-10k";
const PROMPT = "Refactor the auth module and keep every test green.";
const T0 = Date.parse("2026-10-02T09:00:00.000Z");

const rows = [];
const iso = (seq) => new Date(T0 + seq * 1_000).toISOString();

function push(type, payload, extra = {}) {
  const seq = rows.length + 1;
  const ts = iso(seq);
  rows.push({ seq, type, ts, payload: { ...payload, ts }, ...extra });
}
const agent = (event) => push("agent_event", { sessionId: SESSION_ID, ...event });
const fact = (body, factId) => push("evidence_fact", { repoId: REPO_ID, sessionId: SESSION_ID, ...body }, { factId });

agent({ type: "agent_started", prompt: PROMPT });
for (let unit = 0; unit < UNITS; unit += 1) {
  const dir = `src/module${unit % 97}`;
  const file = `${dir}/part${unit}.ts`;
  agent({ type: "agent_message", role: "assistant", text: `Step ${unit}: updating ${file}, then rerunning the focused tests.` });
  agent({ type: "file_read", path: file });
  agent({ type: "command_started", command: `rg -n "export" ${dir}`, callId: `cmd_${unit}` });
  agent({
    type: "command_completed",
    command: `rg -n "export" ${dir}`,
    exitCode: 0,
    callId: `cmd_${unit}`,
    stderr: "",
    stdout: Array.from({ length: 12 }, (_, line) => `${dir}/part${line}.ts:${line + 1}: export const value${line} = ${line};`).join("\n"),
  });
  agent({ type: "file_changed", path: file, callId: `edit_${unit}` });
  fact(
    { type: "git_hunk", file, added: 1 + (unit % 9), removed: unit % 4, isFormattingOnly: false, isConfigOnly: false, isLockfile: false },
    `fact_hunk_${unit}`,
  );
  agent({ type: "agent_reasoning", text: `Checking ${dir} before the next file.` });
  if (unit % 5 === 4) {
    agent({ type: "command_started", command: "pnpm test --filter auth", callId: `test_${unit}` });
    agent({
      type: "command_completed",
      command: "pnpm test --filter auth",
      exitCode: 0,
      stdout: "Tests 24 passed (24)",
      stderr: "",
      callId: `test_${unit}`,
    });
    fact(
      { type: "test_result", runner: "vitest", command: "pnpm test --filter auth", passed: 24, failed: 0, skipped: 0, failures: [], sourceCallId: `test_${unit}` },
      `fact_test_${unit}`,
    );
  }
}
agent({ type: "agent_completed" });

const lastSeq = rows.length;
const bundle = TraceBundleSchema.parse({
  format: TRACE_BUNDLE_FORMAT,
  version: TRACE_BUNDLE_VERSION,
  exportedAt: iso(lastSeq + 1),
  redactionCount: 0,
  session: {
    sessionId: SESSION_ID,
    repoId: REPO_ID,
    repoName: "console-10k",
    prompt: PROMPT,
    state: "completed",
    startedAt: iso(0),
    endedAt: iso(lastSeq),
    lastEventSeq: lastSeq,
  },
  rows,
});
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(bundle), { mode: 0o600 });
console.log(`console-10k: ${rows.length} rows from ${UNITS} units -> ${OUT}`);
```

Run: `perl -e 'alarm 60; exec @ARGV' node apps/trace-viewer-dev/scripts/console-bundle.mjs`

Expected: `console-10k: 15961 rows from 2100 units -> …/public/bundles/console-10k.json` (the bundles folder is git-ignored).

- [ ] **Step 7: Dev host: embedded chrome, `?view=` and the Console perf run**

In `apps/trace-viewer-dev/src/host.tsx`:

Change the React import to `import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";` and add `type ViewKind,` to the `@jevcode/trace-viewer` import list.

After `resolveDrip`, add:

```ts
const VIEW_KIND = /^[a-z][a-z0-9-]{0,31}$/;

/** `?view=console` etc.: the opening view when the hash names none (TraceViewerProps.initialView). */
export function parseView(value: string | null): ViewKind | undefined {
  return value !== null && VIEW_KIND.test(value) ? value : undefined;
}
```

Give `Viewer` and `ViewerBody` two more props, `chrome: "full" | "embedded"` and `view: ViewKind | undefined`, pass them from `Viewer` to `ViewerBody`, and in `ViewerBody` replace the returned `<TraceViewer … />` element with:

```tsx
  const [switcher, setSwitcher] = useState<ReactNode>(null);
  const viewer = (
    <TraceViewer
      source={source}
      host={host}
      location={location}
      pollMs={selftest ? 100 : (drip?.intervalMs ?? 1_000)}
      initialFollow={selftest ? false : undefined}
      chrome={chrome}
      initialView={view}
      renderSwitch={chrome === "embedded" ? setSwitcher : undefined}
    />
  );
  return (
    <>
      {chrome === "embedded" ? (
        <div className={styles.embedded}>
          <div className={styles.embeddedBar}>{switcher}</div>
          <div className={styles.embeddedBody}>{viewer}</div>
          {/* A stand-in for lane 03's prompt dock, so screenshots match the main-window mockup's frame. */}
          <div className={styles.embeddedDock} aria-hidden="true">
            <span className={styles.dockGlyph}>›</span>
            <span>Message the agent · Enter for a new line</span>
            <span>⌘↵ send</span>
          </div>
        </div>
      ) : (
        viewer
      )}
```

followed by the existing `{selftest ? … : null}` and `{openProbe ? … : null}` blocks and `</>`. (Declare `useState` before any early return in `ViewerBody`; it has none.)

In `DevHost`, after `const openProbe = …`, add:

```ts
  const chrome = params.get("chrome") === "embedded" ? "embedded" : "full";
  const view = parseView(params.get("view"));
```

pass `chrome={chrome}` and `view={view}` to `<Viewer …/>`, and change the HUD line to:

```tsx
      {perf ? <PerfHud autorun={params.get("perfrun") === "1"} consoleRun={params.get("perfrun") === "console"} /> : null}
```

Append to `apps/trace-viewer-dev/src/host.module.css`:

```css
.embedded {
  position: fixed;
  inset: 0;
  display: grid;
  grid-template-rows: 40px minmax(0, 1fr) auto;
  background: #ffffff;
  font: 13px/18px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #16181d;
}

.embeddedBar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 12px;
  box-shadow: inset 0 -1px 0 rgb(16 24 40 / 0.07);
}

.embeddedBody {
  min-height: 0;
}

.embeddedDock {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  margin: 8px 16px 12px;
  padding: 10px 12px;
  border-radius: 10px;
  box-shadow: 0 1px 2px rgb(16 24 40 / 0.06), 0 4px 12px rgb(16 24 40 / 0.05);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12px;
  color: #676d78;
}

.dockGlyph {
  color: #1f5ef0;
}
```

In `apps/trace-viewer-dev/src/perf-hud.tsx`, add after `runSweep`:

```ts
/** Spec 2026-10-02 §11: the Console budgets hold at 10,000 steps; the run needs at least that many. */
export const CONSOLE_MIN_STEPS = 10_000;
export const CONSOLE_APPEND_SAMPLES = 300;

interface ConsoleScroll {
  frames: number;
  refreshMs: number;
  droppedPct: number;
  p95Rounded: number;
}

function nextFrameTime(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame((time) => resolve(time)));
}

async function frameIntervals(count: number, onFrame: (frame: number) => void): Promise<number[]> {
  const intervals: number[] = [];
  let last = await nextFrameTime();
  for (let frame = 0; frame < count; frame += 1) {
    onFrame(frame);
    const now = await nextFrameTime();
    intervals.push(now - last);
    last = now;
  }
  return intervals;
}

/** The Console's scroller once it holds at least `minSteps` steps, else null after `timeoutMs`. */
async function waitForConsole(minSteps: number, timeoutMs: number): Promise<{ scroller: HTMLElement; steps: number } | null> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const root = document.querySelector<HTMLElement>("[data-console]");
    const scroller = root?.querySelector<HTMLElement>("[data-console-scroll]") ?? null;
    const steps = Number(root?.dataset.stepCount ?? "0");
    if (scroller !== null && steps >= minSteps) return { scroller, steps };
    if (performance.now() > deadline) return null;
    await sleep(100);
  }
}

/** 3 s of reader scrolling (90 frames up, 90 down), rAF intervals rounded to the idle refresh interval (viewer spec §10 method). */
async function runConsoleScroll(scroller: HTMLElement): Promise<ConsoleScroll> {
  const idle = (await frameIntervals(60, () => undefined)).sort((a, b) => a - b);
  const refreshMs = idle[Math.floor(idle.length / 2)] ?? 1_000 / 60;
  scroller.scrollTop = scroller.scrollHeight;
  await nextFrameTime();
  const intervals = await frameIntervals(180, (frame) => {
    const delta = frame < 90 ? -900 : 900;
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: delta, bubbles: true }));
    scroller.scrollTop += delta;
  });
  const rounded = intervals.map((ms) => Math.max(1, Math.round(ms / refreshMs))).sort((a, b) => a - b);
  const total = rounded.reduce((sum, n) => sum + n, 0);
  const dropped = rounded.reduce((sum, n) => sum + (n - 1), 0);
  return {
    frames: intervals.length,
    refreshMs,
    droppedPct: total === 0 ? 0 : (100 * dropped) / total,
    p95Rounded: quantile(rounded, 0.95) ?? 0,
  };
}

/** Back to Live (G), then wait for CONSOLE_APPEND_SAMPLES tv:console-append measures from the drip. */
async function runConsoleAppend(samples: number, timeoutMs: number): Promise<Stat> {
  performance.clearMeasures(PERF.consoleAppend);
  press("KeyG", "G", { shiftKey: true });
  const deadline = performance.now() + timeoutMs;
  while (measureCount(PERF.consoleAppend) < samples && performance.now() < deadline) await sleep(100);
  return readStats().find((stat) => stat.name === PERF.consoleAppend) ?? { name: PERF.consoleAppend, count: 0, median: null, p95: null };
}
```

Change the component signature to `export function PerfHud({ autorun, consoleRun = false }: { autorun: boolean; consoleRun?: boolean })` and add, after the existing autorun effect:

```tsx
  // ?perfrun=console (smoke.mjs --console-perf): scroll at 10k steps, then append latency, then one JSON result.
  useEffect(() => {
    if (!consoleRun) return undefined;
    let cancelled = false;
    void (async () => {
      const found = await waitForConsole(CONSOLE_MIN_STEPS, 90_000);
      if (cancelled) return;
      if (found === null) {
        setResult(JSON.stringify({ error: `the Console never held ${CONSOLE_MIN_STEPS} steps` }));
        return;
      }
      const scroll = await runConsoleScroll(found.scroller);
      const append = await runConsoleAppend(CONSOLE_APPEND_SAMPLES, 120_000);
      if (!cancelled) setResult(JSON.stringify({ steps: found.steps, scroll, append }));
    })();
    return () => {
      cancelled = true;
    };
  }, [consoleRun]);
```

- [ ] **Step 8: Smoke options**

In `apps/trace-viewer-dev/scripts/smoke.mjs`:

In `parseArgs`, change the defaults to `const options = { views: ["hybrid"], skipBuild: false, port: DEFAULT_PORT, embedded: false, consolePerf: false };` and add two branches before the final `else throw`:

```js
    else if (arg === "--embedded") options.embedded = true;
    else if (arg === "--console-perf") options.consolePerf = true;
```

Change `async function chromeSelftest(profile, url, timeoutMs) {` to `async function chromeSelftest(profile, url, timeoutMs, selector = "pre#selftest") {` and, inside it, replace

```js
      const text = await evaluate('document.querySelector("pre#selftest")?.textContent ?? ""');
```

with

```js
      const text = await evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`);
```

In `main`, find:

```js
    run("pnpm", ["--filter", "jevcode-trace-viewer-dev", "build"]);
```

Replace it with:

```js
    if (options.consolePerf) run("node", [path.join(APP, "scripts", "console-bundle.mjs")]);
    run("pnpm", ["--filter", "jevcode-trace-viewer-dev", "build"]);
```

and find:

```js
    console.log(`SMOKE_OK ${shots} screenshots`);
```

Replace it with:

```js
    if (options.embedded) {
      // The main-window frame (spec §9) around the embedded viewer on the Console; a drip opens it in Live, so the
      // right panel shows the Brief (V-6 compares these with console-main-*.png).
      for (const width of WIDTHS) {
        const file = path.join(SMOKE_DIR, `console-embedded-${width}.png`);
        rmSync(file, { force: true });
        chrome(profile, [
          `--window-size=${width},900`,
          "--virtual-time-budget=4000",
          `--screenshot=${file}`,
          `${ORIGIN}/?bundle=oauth&chrome=embedded&drip=4,200,-60${locationHash(sessionId, "console")}`,
        ]);
        if (!existsSync(file)) throw new Error(`no screenshot at ${file}`);
        shots += 1;
      }
    }
    if (options.consolePerf) {
      const consoleSession = JSON.parse(readFileSync(path.join(bundles, "console-10k.json"), "utf8")).session.sessionId;
      const result = await chromeSelftest(
        path.join(tmp, "chrome-console-perf"),
        `${ORIGIN}/?bundle=console-10k&perf=1&perfrun=console&chrome=embedded&drip=1,120,-600${locationHash(consoleSession, "console")}`,
        240_000,
        "pre#perf-result",
      );
      if (result.error !== undefined) throw new Error(`console perf: ${result.error}`);
      const line = [
        `steps=${result.steps}`,
        `append_n=${result.append.count}`,
        `append_median=${result.append.median?.toFixed(1)}`,
        `append_p95=${result.append.p95?.toFixed(1)}`,
        `scroll_dropped=${result.scroll.droppedPct.toFixed(2)}%`,
        `scroll_p95_frames=${result.scroll.p95Rounded}`,
        `refresh_ms=${result.scroll.refreshMs.toFixed(1)}`,
      ].join(" ");
      console.log(`CONSOLE_PERF ${line}`);
      const misses = [];
      if (result.steps < 10_000) misses.push(`only ${result.steps} steps`);
      if (result.append.count < 300) misses.push(`only ${result.append.count} append samples`);
      if (!(result.append.p95 <= 150)) misses.push(`append p95 ${result.append.p95} ms > 150 ms`);
      if (!(result.scroll.droppedPct <= 5)) misses.push(`scroll dropped ${result.scroll.droppedPct.toFixed(2)}% > 5%`);
      if (misses.length > 0) throw new Error(`console perf: ${misses.join("; ")}`);
    }
    console.log(`SMOKE_OK ${shots} screenshots`);
```

- [ ] **Step 9: Typecheck, lint and the package suite**

```bash
perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer typecheck
perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer build
perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-trace-viewer-dev typecheck
perl -e 'alarm 150; exec @ARGV' pnpm exec eslint packages/trace-viewer/src apps/trace-viewer-dev/src
```

Expected: each exits 0 and lint prints nothing. Run the package suite in the background; expect no failures.

- [ ] **Step 10: Screenshots against the mockup, and the budgets**

Run in the background (the perf run alone takes about two minutes):

```bash
(perl -e 'alarm 590; exec @ARGV' node apps/trace-viewer-dev/scripts/smoke.mjs --views console,hybrid,canvas --embedded --console-perf --port 4185 > .superpowers/smoke-v6.log 2>&1; echo "EXIT=$?" >> .superpowers/smoke-v6.log) &
```

Poll `tail -6 .superpowers/smoke-v6.log` every 15 s until it prints `SMOKE_OK 8 screenshots` (or `SMOKE_FAIL`, or an `EXIT=` line). Expected: the three selftests ok (Console drift ≤ 1 px), a `CONSOLE_PERF steps=… append_p95=… scroll_dropped=…%` line within budget, then `SMOKE_OK 8 screenshots`.

Open `apps/trace-viewer-dev/.smoke/console-embedded-1440.png` and `console-embedded-1000.png` beside `console-main-1440.png` and `console-main-1000.png`. The dev frame stands in for the header, sidebar and dock, so compare the workspace: the view bar with the host-placed switcher (Console checked, keys in titles), the Console column, the Brief at 300 px (264 px at 1000), and no Outline. List every difference; fix it in the viewer's CSS and rerun.

If a budget misses: rerun twice to rule out machine load (record `uptime` before each run). A repeatable miss is a defect: profile the append path with the HUD (`?bundle=console-10k&perf=1&chrome=embedded&drip=1,120,-600`, then the Performance panel) and fix the cost before this task is done. Never loosen the thresholds in `smoke.mjs`.

- [ ] **Step 11: Record the results**

Append to `docs/perf.md`:

```markdown
## Console (console and explainer spec §11, phase A)

Dev host in headless Chrome: `node apps/trace-viewer-dev/scripts/smoke.mjs --views console --embedded --console-perf`.
Input: the `console-10k` bundle (`apps/trace-viewer-dev/scripts/console-bundle.mjs`: 2,100 units, about 10,900 Console
steps), embedded chrome, drip of 1 row per 120 ms from `lastSeq − 600`. Append latency runs from the drip's
`tv:rows-released` mark (the dev host's "row stored") to the paint after the Console commit (`tv:console-append`),
from the oldest pending release. Scroll counts rAF intervals over a 3 s scripted reader scroll, rounded to the idle
refresh interval. Electron numbers come from the main-window smoke (lane 03 D-6).

| Budget | Target | Result (median of 3 runs) | Status | Measured by |
|---|---|---|---|---|
| Console append latency | p95 ≤ 150 ms | median <m> ms, p95 <p> ms, n <n> | <PASS/MISS> | `CONSOLE_PERF` line |
| Console scroll at 10k steps | ≤ 5% dropped frames | <d>% dropped at <r> ms refresh, p95 <k> frames | <PASS/MISS> | `CONSOLE_PERF` line |

Runs on <date>, <machine>, load average <a>–<b> (`uptime` before each run).
```

Fill every `<…>` from the three `CONSOLE_PERF` lines (run the smoke twice more with `--views console --console-perf --skip-build`), never with estimates.

- [ ] **Step 12: Commit**

```bash
git add packages/trace-viewer/src/source.ts packages/trace-viewer/src/sources/static-bundle.ts \
  packages/trace-viewer/src/sources/static-bundle.test.ts packages/trace-viewer/src/ui/shell/perf.ts \
  packages/trace-viewer/src/ui/shell/perf.test.ts packages/trace-viewer/src/ui/views/console/ConsoleView.tsx \
  apps/trace-viewer-dev/src/host.tsx apps/trace-viewer-dev/src/host.module.css apps/trace-viewer-dev/src/perf-hud.tsx \
  apps/trace-viewer-dev/scripts/console-bundle.mjs apps/trace-viewer-dev/scripts/smoke.mjs docs/perf.md
git commit -m "perf(trace-viewer): Console append and scroll budgets on a 10k-step dev-host bundle"
```

---

## Lane completion

### Part A (W0)

1. **Whole-part check** on `ce/02a-viewer-api` after V-2: root checks print `ROOT_CHECKS_DONE fail=0`; the smoke `--views hybrid,canvas` prints `SMOKE_OK 4 screenshots`.
2. **Rebase after lane 01 merges** (W0 order 01, 02a). From `/Users/jwpark/Projects/jevcode-ce-02a`:

```bash
git rebase main
pnpm install --frozen-lockfile
perl -e 'alarm 170; exec @ARGV' pnpm -r build
```

Lane 01 edits `packages/trace-viewer/src/sources/static-bundle.ts` (`parseTraceBundle` accepts versions 1 and 2) and V-1 edits the same file (`StaticBundleSource.onRowsAvailable`, `tick`): keep both. Rerun the root checks.

3. **Done (index §9, 02a):** the viewer accepts `chrome`, `hostViews` and `initialView` (`embedded.test.tsx`); keys 0–3 switch views and 4 reaches a host view; a push hint polls at once and commits within `HINT_COMMIT_GAP_MS` (`data-controller.test.ts`); every existing viewer test is green.
4. **Hand-off notes** for the merge PR:
   - Deviations 1–10 above.
   - Lane 03 (D-1, D-2, D-3): `createIpcTraceSource` implements `onRowsAvailable(listener)` by filtering `bridge.trace.onRowsAvailable` payloads on its own `sessionId` and calling `listener(lastSeq)`; `EmbeddedWorkspace` passes `chrome="embedded"`, `initialView="console"`, a stable `hostViews` array and a stable `renderSwitch` (a `useState` setter), and renders the received node in its own bar; the Surfaces view uses `icon: "view-surfaces"` and the new exports (`useView`, `useDispatch`, `useSessionView`, `ViewProps`); `mainHost` may add `answerDecision`, `openTraceWindow`, `rescanOverview`.
   - Lane 06 (P-3): replace `MapPlaceholder` in `VIEWS` (`registry.ts`); key 3 is already bound.
   - The trace window opens in Hybrid as before; it gains the Console (0) and the Map slot (3).

### Part B (W1)

1. **Whole-part check** on `ce/02b-console` after V-6: root checks print `ROOT_CHECKS_DONE fail=0`; `smoke.mjs --views console,hybrid,canvas --embedded --console-perf` prints a `CONSOLE_PERF` line within budget and `SMOKE_OK 8 screenshots`.
2. **Rebase** (W1 order 04, 05, 02b, 03, 06). From `/Users/jwpark/Projects/jevcode-ce-02b`, after 04 and 05 merge:

```bash
git rebase main
pnpm install --frozen-lockfile
perl -e 'alarm 170; exec @ARGV' pnpm -r build
```

Shared docs take both sides: `docs/perf.md` (lane 04 M-8 adds scan and ingest rows) and the mockups `README.md` (lane 06 P-0 adds its Phase B section). Rerun the root checks and the smoke.
3. **Done (index §9, 02b):** the Console renders every Phase A row kind (`console-rows.test.ts`, `console-view.test.tsx`); the Review Focus 3 test is green; the Brief v0 shows in the right panel in every view (it lives in the Shell's aside, outside the views); the dev-host Console perf meets both budgets and `docs/perf.md` records them; H1 is recorded as approved in the mockups README.
4. **Hand-off notes** for the merge PR:
   - Lane 03 (merges next): D-3's context rail content now lives in the Brief (Now and Changes); D-6 can assert the Console with `[data-console]` and `data-step-count`, and read append latency from the `TRACE_PERF tv:console-append` lines once its renderer marks `ROWS_RELEASED_MARK` when a `trace:rowsAvailable` hint arrives (or from its own end-to-end probe).
   - Lane 06 (P-4, after rebasing on 02b): extend `buildBrief` to fill `architecture` (`BriefArchitecture`); `Brief.tsx`'s `Architecture` already renders the four states (null, scanning, `overviewSentences: null` as "Descriptions pending", sentences) and has a test for each; restyle it with the Map thumbnail against the approved P-0 mockup.
   - Lane 07 (S-4): emit `summary` rows from `buildConsoleRows` and restyle the `summary` case in `ConsoleRowView.tsx`; produce `now: { kind: "story", … }` from `buildBrief` and restyle the story branch of `Now` in `Brief.tsx`.
   - The spec alignment notes above (key `0`, the Shift+B Brief key, switcher order, Shift+B with nothing selected, Brief replacing the session summary, Console live follow, reasoning duration, tool arguments).
   - Lane 06 (P-4 Step 1): add the Map component case by extending `showsBrief` (`state.view === "map" && state.mapSelection !== null` → the Inspector branch, which renders the component Inspector), never by replacing `RightPanel`'s body, which carries the I-5 focus handover and feeds the m3 aside label; the I-5 tests in `src/ui/inspector/brief.test.tsx` guard it.
   - Deviations 16–23 (the lane fix wave): lane 03 gets the Console's Live behavior (G and both pills never select in the Console), the title bar's row count, the right panel's label and focus handover, and the decision announcement (its own main-window chrome should not announce the same decision again). Lane 06 (P-4) gets `HarnessOptions.host`, the `guardrails` row kind and the wider `displayUntrusted`. Lane 07 (S-4) must handle the `guardrails` kind in every `ConsoleRow` switch; its `rowAnchorSeq` now reads `consoleRowStepIds(row)[0]`; `ConsoleRowViewProps` has `answer: AnswerState`, `onAnswer(...)` returning `void` and an optional `onSelectStep`.
