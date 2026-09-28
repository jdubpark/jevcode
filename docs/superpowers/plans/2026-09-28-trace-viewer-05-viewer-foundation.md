# Trace Viewer Lane C1: Viewer Foundation (C1a Visual Primitives, C1b Viewer Core and Spike) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the trace viewer's W1 foundation in `packages/trace-viewer`: light `--tv-*` tokens with a contrast test, the 1.5 px icon family, the seven mini graphics and their scales (C1a), plus the pure viewport math, the native-wheel viewport controller, the one-day rendering spike, `TimeScale` and ticks, `TraceIndex` and tone, the view-state reducer, store, location codec and keymap, the overview and spine row layouts, and the static bundle source with drip (C1b).

**Architecture:** Two parallel lanes in one file. Part A (C1a) owns `src/ui/{tokens,icons,graphics}` and exports nothing through `src/index.ts`. Part B (C1b) owns `src/layout/*` (pure, React- and DOM-free), `src/ui/{viewport,state}`, `src/sources/*`, `src/test-support/{session-builder,arbitraries}.ts` and the spike harness under `apps/trace-viewer-dev`. Both lanes read only W0 model names (types, `LANES`, `LEVELS`, `STEP_KINDS`, `SIGNAL_IDS`, stable-id helpers) and test against `src/test-support/session-builder.ts`; neither calls lane B's runtime (`format.ts`, `fold.ts`, `signals.ts`, `lookup.ts`, `search.ts`).

**Tech Stack:** TypeScript 5.9 (NodeNext, strict, `noUncheckedIndexedAccess`, `noUnusedLocals`, `verbatimModuleSyntax`), React 19.2.3 (`useSyncExternalStore`, `<Activity>`), zod 3.25.76, vitest 3.2 + jsdom 30.1.0 + `@testing-library/react` 16.3.3, fast-check 4.10.1, Vite 5.4.21 + `@vitejs/plugin-react` 4.7.0, Electron 33 (spike only, from `apps/desktop` devDependencies), ESLint 9.39 flat config.

**Spec:** `docs/superpowers/specs/2026-09-28-trace-viewer-design.md` §7 (Viewer UI: §7.3 rendering, §7.4 TimeScale, §7.6 Hybrid overview and spine, §7.8 store, §7.9 keyboard, §7.10 live, §7.12 visual system, §7.13 accessibility), §8 (Electron: the spike's hidden-then-shown window only), §10 budgets, §11 tests, §16 spike. Interface contracts: `docs/superpowers/plans/2026-09-28-trace-viewer-interfaces.md` (W0, A1, A2, B names; section 5 gotchas) and `docs/superpowers/plans/2026-09-28-trace-viewer-interfaces-ui.md` (UI names; sections 1.1-1.2 W0 amendments, 2.1-2.4 signatures, 3 task table C1-1…C1-15, 5 gotchas). Binding record: `local decision scratchpad (not committed)` (R13-R29). Detailed designs: `…/scratchpad/ui-unified.md` (wins over `tech-verdict.md`, `ui-hybrid.md`, `ui-shared-state.md`). On any conflict the decision record wins, then the spec, then the base index, then the UI index, then this file.

## Required W0 amendments

None beyond the UI index. This lane adds no dependency and edits no `package.json`, `exports` map, `pnpm-lock.yaml` or `eslint.config.mjs`. It needs, from W0: UI index §1.1 (a) the `@jevcode/trace-viewer` dependency block without `@xyflow/react`, with `d3-zoom` 3.0.0 and `d3-selection` 3.0.0 (C1-7F only) and their `@types`, plus the `./sources` export (C1-15); (c) `assetsInlineLimit: 0` in `apps/trace-viewer-dev/vite.config.ts` (C1-7 builds the spike page under the Electron CSP); (d) the `src/layout/**` ESLint block with `LAYOUT_PURE_GLOBALS` (every C1b `layout/*` task); and UI index §1.2 (a) the model type insertions (`LEVELS`, `Level`, `TraceSession.originMs`, the amended `GraphicSpec`) and (b) the session-bound `TraceSource` (`sessionId`, `summary()`, `rows(request?)`, `payloads(seqs)`, `now()`; C1-15 implements it).

Checked 2026-09-28: `2026-09-28-trace-viewer-01-contracts-foundation.md` does not yet carry these (no `d3-selection`, no `"./sources"` export, no `assetsInlineLimit`, no `LAYOUT_PURE_GLOBALS`, the three-method `TraceSource`). The amend step must fold UI index §1.1 and §1.2 into lane 01 before W0 runs; the "Lane prerequisites" greps below stop this lane if it did not.

## Interface deviations

Each item is a genuine gap or defect found while writing complete code against the UI index. Nothing in section 2 of either index is renamed or removed.

1. **One file holds both C1 lanes.** The UI index names two lane files (`…-05a-visual-primitives.md`, `…-05b-viewer-core.md`). This file is both: Part A is lane C1a (branch `tv/c1a-visual-primitives`, worktree `~/Projects/jevcode-tv-c1a`), Part B is lane C1b (branch `tv/c1b-viewer-core`, worktree `~/Projects/jevcode-tv-c1b`). Run them under two controllers exactly as the UI index section 4 says. File ownership is unchanged.
2. **`ui/state/location.ts` and `location.test.ts` move from C1-12 to C1-11.** The index's C1-11 signature imports `type { ViewerLocation } from "./location.js"` (`initialViewState({ location })`, `locationOf(): ViewerLocation`), but the index creates `location.ts` one task later. C1-11 now creates both files; C1-12 keeps the store, the keymap and the `src/index.ts` export line for the location codec.
3. **`TraceIndex` gains `findingsById: ReadonlyMap<FindingId, Finding>` and `layout/trace-index.ts` exports `isStepExpanded(step, findingsById, expanded, collapsed): boolean`.** Spec §7.6.3 auto-expands a critical finding the first time it appears and never re-expands one the reader collapsed. That rule is computed, not stored, and both `reduce` (Enter, Esc) and `buildSpineRows` need the same function, so it lives once in `layout`. Additive.
4. **`ViewState` gains `unitAnchors: Readonly<Record<string, number>>`** (unit id → anchor seq for every unit id held in `selection`, `expanded` or `collapsed`). `reduce(state, action, index)` receives only the new index on `session/applied`, so without a stored anchor it cannot remap a regrouped `unit:` id "through `ch:<anchorSeq>`" (index section 2.3). `initialViewState` sets `{}`; only `reduce` writes it. Additive.
5. **`select` gains `origin?: PlayheadOrigin`** (default: `by === "canvas" ? "canvas" : by === "hybrid" ? "overview" : "outline"`). The spine must never scroll for its own selections (spec §7.6.3), and `FocusBy` cannot say "spine". Additive, optional.
6. **`brush/set`, `brush/edge` and `brush/chapter` keep the written brush and clear a selection that falls outside it** (the playhead then clamps into the brush). The index says "the selection intersects the brush … when a write breaks it, the brush slides": that rule is for selection and playhead writes; sliding a brush the reader just drew would undo the gesture. Views that must keep a selection across a brush write (Canvas pan settle, C3-9) include the selection in the range they write.
7. **`effectivePlayheadSeq` for `{kind: "selection"}` is the selected entry's `firstSeq`** (not `lastSeq` as ui-shared-state.md proposed). A command step's `lastSeq` can lie inside a later interleaved step, so `stepIndexAtOrBefore(lastSeq)` would name the wrong row. With no selection it is the previous effective seq recorded as `free` (see `select` in C1-11), else `loadedThroughSeq`.
8. **`StaticBundleSource` reports `lastSeq = max(bundle.session.lastEventSeq, last released seq)` once every row is released.** The index says "lastSeq = last released seq". A bundle omits non-trace rows, so the IPC source's `lastSeq` (`sessions.lastEventSeq`) is larger; D-7 requires deep-equal folds from both sources (`Hidden.unreceived` and `loadedThroughSeq` come from `lastSeq`). While dripping, `lastSeq` stays the last released seq.
9. **`LaneMarks` gains `noise: Uint8Array` and `maxSpan: number`.** Spec §7.6.1 draws noise per level (omitted at Session, one hollow bar per run at Chapter, muted marks at Step), and the visible-range binary search over `u0` needs the lane's longest span to find bars that start left of the viewport. Additive.
10. **`displayGapMs(3_600_000)` is 52,459 ms, not "≈ 52,430".** The index's example contradicts its own formula (`10 s + 5 s · log2(360)` = 52,459.3 ms; the spec's "1 h → 52.4 s" truncates). Tests pin the formula value.
11. **Scope note from the computed task.** "Dev host wiring to load bundles" stays in C2-15 as the UI index assigns it (it mounts `TraceViewer`, which C2 builds); this lane never edits `apps/trace-viewer-dev/src/main.tsx`. The spike page accepts `?bench=<chapters>x<edges>` (default `60x300`) as the computed task asks, on `spike.html` as the index requires, and measures all seven spike risks (R28), not only risks 1-3.

## Lane prerequisites

- **Wave:** W1. W0 must be merged into `main`, including the UI index's section 1.1 and 1.2 amendments. A1, A2 and B run beside this lane; none has to merge first. Merge order after W1: A1 → A2 → B → C1a → C1b.
- **Verify the W0 amendments** (from `~/Projects/jevcode`, on `main`). Each command prints the expected count; any mismatch means the amend step did not land, and the lane stops and escalates:

```bash
grep -c '"d3-zoom": "3.0.0"' packages/trace-viewer/package.json                       # 1
grep -c '"./sources"' packages/trace-viewer/package.json                                # 1
grep -c '@xyflow/react' packages/trace-viewer/package.json                              # 0
grep -c 'export const LEVELS' packages/trace-viewer/src/model/types.ts                   # 1
grep -c 'originMs: number' packages/trace-viewer/src/model/types.ts                     # 1
grep -c 'anchorStepId: StepId' packages/trace-viewer/src/model/types.ts                 # 1
grep -c 'kind: "duration";' packages/trace-viewer/src/model/types.ts                    # 1
grep -c 'end: "none" | "bad_dot" | "exit_x"' packages/trace-viewer/src/model/types.ts   # 1
grep -c 'summary(): Promise<TraceSessionSummary>' packages/trace-viewer/src/source.ts    # 1
grep -c 'LAYOUT_PURE_GLOBALS' eslint.config.mjs                                          # 2
grep -c 'assetsInlineLimit: 0' apps/trace-viewer-dev/vite.config.ts                     # 1
```

- **Worktrees** (after W0 merges; `<w0>` is the W0 merge commit):

```bash
git -C ~/Projects/jevcode worktree add -b tv/c1a-visual-primitives ~/Projects/jevcode-tv-c1a <w0>
git -C ~/Projects/jevcode worktree add -b tv/c1b-viewer-core ~/Projects/jevcode-tv-c1b <w0>
```

- **Setup** (once per worktree; later commands run from that worktree root, so prefix with `cd ~/Projects/jevcode-tv-c1a && ` or `cd ~/Projects/jevcode-tv-c1b && ` when the shell does not keep its directory):

```bash
pnpm install --frozen-lockfile
NP=$(ls -d node_modules/.pnpm/node-pty@*/node_modules/node-pty | head -1) && mkdir -p "$NP/build/Release" && pnpm --filter jevcode-desktop rebuild:node && cp "$NP/prebuilds/$(node -p 'process.platform + "-" + process.arch')/spawn-helper" "$NP/build/Release/spawn-helper" && chmod +x "$NP/build/Release/spawn-helper"
pnpm -r build
```

Expected: the second command ends with `native modules restored to node ABI`; `pnpm -r build` exits 0.

- **Baseline:** `pnpm -r typecheck`, `pnpm -r --no-bail --workspace-concurrency=1 test` and `pnpm lint` exit 0 before the first task. A failure in `file-watcher.test.ts`, `stall-watchdog.test.ts` or `codex-adapter.test.ts` is a known flake: rerun that package alone.
- **Spike tooling (C1-7 only):** Google Chrome or Electron 33 through `pnpm --filter jevcode-desktop exec electron`; a Magic Trackpad and a mouse; a DPR 2 panel (the DPR 1 run uses `SPIKE_DPR=1`, which sets `--force-device-scale-factor=1`); VoiceOver for the risk 4 HUMAN CHECK.

## Global Constraints

- D8 (verbatim intent): "LIGHT MODE FIRST (dark later). Figma-grade. Color encodes STATE only: accent #2F6BFF = selection/focus/playhead/one primary action; #E5484D = real problems only (failed test, contradiction, guardrail hit); tiny #2E9E6A pass marks only. Neutrals everywhere else; no per-kind colors; diffs neutral (added solid ink-2, removed hollow ink-3), never green/red. Kind = one consistent 1.5px-stroke SVG icon family. … No decorative borders; elevation declared once (shadow OR border). … No eyebrow labels, no ALL-CAPS labels. 12px minimum text. System font stack; mono only for paths/commands/code."
- Tokens (D8 + R24): `--tv-canvas #F4F5F7`; `--tv-panel #FFFFFF`; `--tv-ink #16181D`; `--tv-ink-2 #5B616E`; `--tv-ink-3 #676D78` (text, ≥ 4.5:1); `--tv-ink-4 #9AA0AB` (decoration only; never in a `color` declaration); `--tv-mark #7C828E` (marks, ≥ 3:1); `--tv-hair rgb(16 24 40 / .07)`; `--tv-fill rgb(16 24 40 / .04)`; `--tv-fill-2 rgb(16 24 40 / .07)`; `--tv-accent #2F6BFF`; `--tv-accent-soft rgb(47 107 255 / .10)`; `--tv-accent-ink #1F5EF0`; `--tv-bad #E5484D`; `--tv-bad-soft rgb(229 72 77 / .09)`; `--tv-bad-ink #CE2C31`; `--tv-good #2E9E6A`; shadow `0 1px 2px rgb(16 24 40 / .06), 0 4px 12px rgb(16 24 40 / .05)`.
- R24 graphic scales: "DiffBar 8*log2(1+lines) per side max 56 px; TestDots one dot per test up to 15 then a bar; DurationBar 20+40*log10(s). No dimming after playhead in v1."
- R15: "CSS Modules + light --tv-* tokens; scoped (the trace window never loads apps/desktop/src/renderer/styles.css). Local fonts only (system stack). CSP-compatible." Fonts: `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`; mono `ui-monospace, "SF Mono", Menlo, monospace`; `tabular-nums` on every number.
- R17: "packages/trace-viewer takes NO @xyflow/react dependency." One hand-rolled DOM viewport: `layout/viewport.ts` pure math and `ui/viewport/controller.ts` with a native `wheel` listener `{passive: false}`; Ctrl/Meta+wheel zooms at the cursor with factor `2^(−deltaY · 0.02)` clamped per event to [0.8, 1.25]; other wheel, Space-drag, the hand tool and middle-drag pan; one rAF write per frame; settle 150 ms after the last input rounds `tx`/`ty` and writes `--tv-inv-k`; gesture-time `will-change` only. Fallback `d3-zoom` 3.0.0 behind the same API only if spike risk 1 fails.
- R18: `IDLE_KNEE_MS 10_000`, `IDLE_LOG_MS 5_000`, `BREAK_MIN_MS 60_000`; "waiting on a decision and lifecycle steps are not work"; ticks ≥ 64 px apart and none inside breaks.
- R19: `layout` imports `model`, never the reverse; `layout` never imports `ui`, React, the DOM, timers or `Date` (ESLint `LAYOUT_PURE_GLOBALS`).
- R20: selector-based `useSyncExternalStore` store, no zustand; camera frames never enter the store; invariants "selection intersects brush, playhead inside brush, 1,2,1 is identity except view".
- R21: keys match `event.code`, are ignored during IME composition, in inputs and with an unlisted modifier.
- "The viewer never writes" (D9). `TraceSource` is the only input; nothing in this lane calls `fetch`, IPC or storage.
- No UI lane edits any `package.json` dependency block, any `exports` map, `pnpm-lock.yaml` or `eslint.config.mjs`. A missing dependency stops the task and escalates (this lane needs none beyond W0 plus UI index section 1.1).
- Tests: `layout/*.property.test.ts` and `ui/state/*.property.test.ts` use fast-check; component tests start with `// @vitest-environment jsdom`, stub `getBoundingClientRect` and `ResizeObserver` inside each test and restore them in `afterEach`, and install no global fakes. Expected values come from the spec and the fixtures' known content (oauth's failed `pnpm test` 14/1/0 at +0:35 for 5.0 s, the claim at +0:43), never from the implementation.
- Commits: one conventional commit per task (`feat(trace-viewer): …`, `test(trace-viewer): …`, `docs(spikes): …`), files listed explicitly in `git add`. Never add a `Claude-Session:` trailer. Never run `git stash`; set work aside with a WIP commit. zsh: write `${var}:suffix`.

## Review Focus

1. **A live append arrives while the reader is scrolled away, mid-gesture, with a critical finding they collapsed.** Expected: the drip source reports `running` until its last row; keys of rows already shown survive the append; a collapsed critical finding stays collapsed; `lastSeenSeq` never decreases. Tests: C1-15 `static-bundle.test.ts` "drip releases rows and reports running until the last row"; C1-14 `spine-rows.property.test.ts` "keys from a prefix fold stay in the full fold except the open tail"; C1-11 `view-state.property.test.ts` "a collapsed critical finding stays collapsed across session/applied".
2. **A re-cluster renames the selected unit** (`unit:u1` becomes `unit:u2` with the same anchor seq). Expected: selection, `expanded` and `collapsed` follow through `ch:<anchorSeq>`, `selectionNote` records the move, and a chapter brush still resolves. Tests: C1-11 "regrouped selection follows the anchor seq"; C1-10 `trace-index.test.ts` "a chapter brush resolves by anchorSeq after the unit id changes".
3. **A pre-M1 session**: no chapters, a command with exit −1, a command with exit 1, `coverage.approximateJoins`. Expected: turns stand in for chapters in overview bands and presets; exit 1 stays neutral (never red, though its row stays visible as a failure); exit −1 reads unknown, is never red and is never pinned. Tests: C1-13 `overview-layout.test.ts` "turns stand in for chapters"; C1-14 `spine-rows.test.ts` "exit -1 is unknown, never failed"; C1-10 `tone.test.ts` "a command with exit 1 is neutral".
4. **Keyboard edge cases**: a Hangul input source (`key: "ㅓ"`, `code: "KeyJ"`), `isComposing: true`, Space when nothing pans, Cmd+C with a text selection, Ctrl+J. Expected: `ㅓ` moves like `j`; composing keys, Space off a pannable surface, Cmd+C over selected text and unlisted modifiers do nothing. Tests: C1-12 `keymap.test.ts`.
5. **Pathological time and input**: a one-hour idle gap, a line-mode (`deltaMode 1`) mouse wheel with Ctrl held, two wheel events in one frame, a 0 × 0 viewport. Expected: the gap renders 52.5 s wide with one break and no ticks inside it; the wheel factor clamps to [0.8, 1.25]; one `onFrame` per animation frame; `fitBounds` with a 0 × 0 viewport returns finite numbers at `minK`. Tests: C1-9 `time-scale.test.ts` "a one-hour gap compresses to 52.5 s with one break" and `ticks.test.ts` "no tick inside a break"; C1-5 `viewport.test.ts` "wheelZoomFactor clamps line-mode deltas" and "fitBounds on a 0x0 viewport stays finite"; C1-6 `controller.test.ts` "two wheel events in one frame produce one onFrame".

---

## Gotchas (copied from UI index section 5, applied to this lane)

1. Fresh worktree setup is the Setup block above; the root test command is `pnpm -r --no-bail --workspace-concurrency=1 test`; known flakes (`file-watcher.test.ts`, `stall-watchdog.test.ts`, `codex-adapter.test.ts`) are confirmed by rerunning that package alone.
2. **Root checks** at the end of every task, in order, each exiting 0: `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r --no-bail --workspace-concurrency=1 test`, `pnpm lint`.
3. Targeted tests: `pnpm --filter @jevcode/trace-viewer exec vitest run <path relative to packages/trace-viewer>`. Benches: `pnpm --filter @jevcode/trace-viewer bench`.
4. `@jevcode/trace-viewer` exports only `dist`. Run `pnpm --filter @jevcode/trace-viewer build` before `pnpm --filter jevcode-trace-viewer-dev build` and before the spike. CSS Modules reach `dist` only through `scripts/copy-assets.mjs`, which the package `build` script runs.
5. jsdom: start the file with `// @vitest-environment jsdom`; stub `getBoundingClientRect` with `vi.spyOn(element, "getBoundingClientRect")` and `ResizeObserver` with `vi.stubGlobal` inside each test, restoring both in `afterEach` (`vi.restoreAllMocks(); vi.unstubAllGlobals();`); jsdom has no `setPointerCapture` (call it only when present) and `getContext("2d")` returns `null`. Use `render`, `screen` and `act` from `@testing-library/react`; there is no jest-dom, so assert with `getAttribute`, `textContent` and roles. Vitest returns stable proxy class names for `*.module.css`, so tests query by role, label or `data-*` attributes, never by class.
6. W1 boundary: import from `../model/index.js` only W0 names (types, `LANES`, `LEVELS`, `STEP_KINDS`, `SIGNAL_IDS`, `CAPABILITIES`, stable-id helpers, `StableIdSchema`, `TRACE_SCHEMA_VERSION`). B's runtime exports (`formatOffset`, `pickGraphic`, `compareFindings`, `foldRows`, …) do not exist until B merges; this lane has private stand-ins where it needs one.
7. `useSyncExternalStore` selectors return primitives or references held in state; a selector that builds a new object on every call loops.
8. `<Activity>` comes from `react` (`import { Activity } from "react"`); a hidden subtree keeps DOM and state but runs no effects, so rAF loops and observers start only in effects.
9. HUMAN CHECK steps (spike risks 1 and 4) cannot be done by a subagent: the implementer runs the automated parts and writes the results table, then the controller asks the user to perform and confirm the check before the task's commit.
10. Commits: one per task, files listed in `git add`; no `Claude-Session:` trailer; no `git stash`.

## File map

Part A (C1a), all new, under `packages/trace-viewer/src/ui/`:
- `tokens/tokens.ts`, `tokens/contrast.ts`, `tokens/base.module.css`, `tokens/tokens.test.ts` (C1-1)
- `icons/icon-names.ts`, `icons/paths.ts`, `icons/IconSprite.tsx`, `icons/Icon.tsx`, `icons/kind-icons.ts`, `icons/icons.test.tsx` (C1-2)
- `graphics/scales.ts`, `graphics/scales.test.ts`, `graphics/DiffBar.tsx`, `graphics/TestDots.tsx`, `graphics/DurationBar.tsx`, `graphics/graphics.module.css`, `graphics/bars.test.tsx` (C1-3)
- `graphics/ForkGlyph.tsx`, `graphics/FlowGlyph.tsx`, `graphics/TableGlyph.tsx`, `graphics/ClaimVsObserved.tsx`, `graphics/Graphic.tsx`, `graphics/glyphs.test.tsx`; `graphics/graphics.module.css` modified (C1-4)

Part B (C1b), under `packages/trace-viewer/src/` unless noted:
- `layout/viewport.ts`, `layout/viewport.test.ts`, `layout/viewport.property.test.ts`; `index.ts` modified (C1-5)
- `ui/viewport/controller.ts`, `ui/viewport/controller.test.ts`; `index.ts` modified (C1-6)
- `apps/trace-viewer-dev/{spike.html, vite.spike.config.ts, .gitignore, src/vite-env.d.ts, src/spike/main.tsx, src/spike/synthetic.ts, src/spike/CanvasHarness.tsx, src/spike/OverviewHarness.tsx, src/spike/SwitchHarness.tsx, src/spike/measure.ts, src/spike/spike.module.css, scripts/spike-electron.cjs}`; `docs/spikes/trace-viewer-spike.md` (C1-7)
- conditional: `ui/viewport/d3-controller.ts`; `ui/viewport/controller.ts`, `controller.test.ts`, `docs/spikes/trace-viewer-spike.md` modified (C1-7F)
- `test-support/session-builder.ts`, `test-support/session-builder.test.ts`, `test-support/arbitraries.ts` (C1-8)
- `layout/time-scale.ts`, `layout/time-scale.test.ts`, `layout/time-scale.property.test.ts`, `layout/ticks.ts`, `layout/ticks.test.ts` (C1-9)
- `layout/trace-index.ts`, `layout/trace-index.test.ts`, `layout/tone.ts`, `layout/tone.test.ts` (C1-10)
- `ui/state/view-state.ts`, `ui/state/view-state.test.ts`, `ui/state/view-state.property.test.ts`, `ui/state/location.ts`, `ui/state/location.test.ts` (C1-11, deviation 2)
- `ui/state/store.ts`, `ui/state/store.test.tsx`, `ui/state/keymap.ts`, `ui/state/keymap.test.ts`; `index.ts` modified (C1-12)
- `layout/overview-index.ts`, `layout/overview-layout.ts`, `layout/overview-layout.test.ts`, `layout/overview-layout.property.test.ts`, `layout/overview-layout.bench.ts` (C1-13)
- `layout/spine-rows.ts`, `layout/spine-rows.test.ts`, `layout/spine-rows.property.test.ts` (C1-14)
- `sources/errors.ts`, `sources/static-bundle.ts`, `sources/static-bundle.test.ts`, `sources/read-all.ts`, `sources/read-all.test.ts`, `sources/index.ts`; `index.ts` modified (C1-15)

---

# Part A: lane C1a, visual primitives (worktree `~/Projects/jevcode-tv-c1a`)

### Task C1-1: Typed tokens, contrast math, base CSS, `--tv-ink-4` color guard

**Files:**
- Create: `packages/trace-viewer/src/ui/tokens/tokens.ts`
- Create: `packages/trace-viewer/src/ui/tokens/contrast.ts`
- Create: `packages/trace-viewer/src/ui/tokens/base.module.css`
- Test: `packages/trace-viewer/src/ui/tokens/tokens.test.ts`

**Interfaces:**
- Consumes: nothing beyond W0.
- Produces:

```ts
// ui/tokens/tokens.ts
export const TOKEN_NAMES: readonly ["canvas", "panel", "ink", "ink2", "ink3", "ink4", "mark", "hair", "fill", "fill2",
  "accent", "accentSoft", "accentInk", "bad", "badSoft", "badInk", "good", "shadow"];
export type TokenName = (typeof TOKEN_NAMES)[number];
export type Tokens = { readonly [K in TokenName]: string };
export const LIGHT_TOKENS: Tokens;
export const TOKEN_VARS: { readonly [K in TokenName]: `--tv-${string}` };
export function tokenStyle(tokens?: Tokens): Readonly<Record<`--tv-${string}`, string>>;
export const FONT_SANS: string;
export const FONT_MONO: string;
export const TYPE: { readonly meta: { size: 12; line: 16 }; readonly base: { size: 13; line: 18 }; readonly prose: { size: 15; line: 20 }; readonly numeral: { size: 20; line: 24 }; readonly mono: { size: 12; line: 18 } };
// ui/tokens/contrast.ts
export function parseColor(value: string): { r: number; g: number; b: number; a: number };
export function composite(fg: string, bg: string): string;
export function contrastRatio(fg: string, bg: string): number;
// ui/tokens/base.module.css: classes `root` and `mono`
```

- [ ] **Step 1: Write the failing test**

`packages/trace-viewer/src/ui/tokens/tokens.test.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { composite, contrastRatio, parseColor } from "./contrast.js";
import { LIGHT_TOKENS, TOKEN_NAMES, TOKEN_VARS, tokenStyle } from "./tokens.js";

const T = LIGHT_TOKENS;
const fill2OnPanel = composite(T.fill2, T.panel);
const BASES = { panel: T.panel, canvas: T.canvas, fill2OnPanel } as const;

describe("tokens", () => {
  it("text tokens reach 4.5:1 on panel, canvas and fill-2 over panel (R24, spec §7.13)", () => {
    for (const name of ["ink", "ink2", "ink3", "accentInk", "badInk"] as const) {
      for (const [baseName, base] of Object.entries(BASES)) {
        expect(contrastRatio(T[name], base), `${name} on ${baseName}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrastRatio(T.accentInk, composite(T.accentSoft, T.panel))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(T.badInk, composite(T.badSoft, T.panel))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#FFFFFF", T.accentInk)).toBeGreaterThanOrEqual(4.5);
  });

  it("mark tokens reach 3:1 on the same bases and mark on both band composites", () => {
    for (const name of ["mark", "bad", "accent"] as const) {
      for (const [baseName, base] of Object.entries(BASES)) {
        expect(contrastRatio(T[name], base), `${name} on ${baseName}`).toBeGreaterThanOrEqual(3);
      }
    }
    expect(contrastRatio(T.mark, composite(T.fill, T.canvas))).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(T.mark, composite(T.fill2, T.canvas))).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(T.good, T.panel)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(T.good, T.canvas)).toBeGreaterThanOrEqual(3);
  });

  it("matches the spec's measured anchors", () => {
    expect(contrastRatio("#676D78", "#FFFFFF").toFixed(2)).toBe("5.20");
    expect(contrastRatio("#FFFFFF", "#2F6BFF")).toBeLessThan(4.5);
  });

  it("parses hex and space-separated rgb with alpha, and composites over an opaque base", () => {
    expect(parseColor("#2F6BFF")).toEqual({ r: 47, g: 107, b: 255, a: 1 });
    expect(parseColor("rgb(16 24 40 / 0.07)")).toEqual({ r: 16, g: 24, b: 40, a: 0.07 });
    expect(composite("rgb(0 0 0 / 0.5)", "#FFFFFF")).toBe("#808080");
    expect(() => composite("#000000", "rgb(0 0 0 / 0.5)")).toThrow(/opaque/);
  });

  it("exposes every token as an inline --tv-* property", () => {
    const style = tokenStyle();
    expect(Object.keys(style)).toHaveLength(TOKEN_NAMES.length);
    expect(style["--tv-ink-3"]).toBe("#676D78");
    expect(style[TOKEN_VARS.accentSoft]).toBe("rgb(47 107 255 / 0.10)");
  });
});

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const INK4_IN_COLOR = /(?<![-\w])color\s*:\s*[^;}]*var\(\s*--tv-ink-4\s*\)/;
const FONT_SIZE_PX = /font-size\s*:\s*(\d+(?:\.\d+)?)px/g;

function moduleCssFiles(): string[] {
  return readdirSync(SRC, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".module.css"))
    .map((file) => path.join(SRC, file));
}

describe("CSS module guards (spec §7.13 lint rule, D8 12px minimum)", () => {
  it("the ink-4 guard catches color and ignores other properties", () => {
    expect(INK4_IN_COLOR.test(".a { color: var(--tv-ink-4); }")).toBe(true);
    expect(INK4_IN_COLOR.test(".a{color:var( --tv-ink-4 )}")).toBe(true);
    expect(INK4_IN_COLOR.test(".a { background-color: var(--tv-ink-4); }")).toBe(false);
    expect(INK4_IN_COLOR.test(".a { border-color: var(--tv-ink-4); fill: var(--tv-ink-4); }")).toBe(false);
  });

  it("no CSS module uses --tv-ink-4 as a text color or sets text below 12px", () => {
    const files = moduleCssFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const css = readFileSync(file, "utf8");
      expect(INK4_IN_COLOR.test(css), `${path.relative(SRC, file)} uses var(--tv-ink-4) in color`).toBe(false);
      for (const match of css.matchAll(FONT_SIZE_PX)) {
        expect(Number(match[1]), `${path.relative(SRC, file)} font-size`).toBeGreaterThanOrEqual(12);
      }
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/tokens/tokens.test.ts`
Expected: FAIL, `Failed to resolve import "./contrast.js"`.

- [ ] **Step 3: Write the implementation**

`packages/trace-viewer/src/ui/tokens/tokens.ts`:

```ts
export const TOKEN_NAMES = [
  "canvas", "panel", "ink", "ink2", "ink3", "ink4", "mark", "hair", "fill", "fill2",
  "accent", "accentSoft", "accentInk", "bad", "badSoft", "badInk", "good", "shadow",
] as const;
export type TokenName = (typeof TOKEN_NAMES)[number];
export type Tokens = { readonly [K in TokenName]: string };

/** Light tokens (D8, R24). Canvas2D painters read this object directly. */
export const LIGHT_TOKENS: Tokens = {
  canvas: "#F4F5F7", panel: "#FFFFFF", ink: "#16181D", ink2: "#5B616E", ink3: "#676D78",
  ink4: "#9AA0AB", mark: "#7C828E", hair: "rgb(16 24 40 / 0.07)", fill: "rgb(16 24 40 / 0.04)",
  fill2: "rgb(16 24 40 / 0.07)", accent: "#2F6BFF", accentSoft: "rgb(47 107 255 / 0.10)",
  accentInk: "#1F5EF0", bad: "#E5484D", badSoft: "rgb(229 72 77 / 0.09)", badInk: "#CE2C31",
  good: "#2E9E6A", shadow: "0 1px 2px rgb(16 24 40 / 0.06), 0 4px 12px rgb(16 24 40 / 0.05)",
};

export const TOKEN_VARS: { readonly [K in TokenName]: `--tv-${string}` } = {
  canvas: "--tv-canvas", panel: "--tv-panel", ink: "--tv-ink", ink2: "--tv-ink-2", ink3: "--tv-ink-3",
  ink4: "--tv-ink-4", mark: "--tv-mark", hair: "--tv-hair", fill: "--tv-fill", fill2: "--tv-fill-2",
  accent: "--tv-accent", accentSoft: "--tv-accent-soft", accentInk: "--tv-accent-ink", bad: "--tv-bad",
  badSoft: "--tv-bad-soft", badInk: "--tv-bad-ink", good: "--tv-good", shadow: "--tv-shadow",
};

/** Inline style object for the Shell root: { "--tv-canvas": "#F4F5F7", … }. */
export function tokenStyle(tokens: Tokens = LIGHT_TOKENS): Readonly<Record<`--tv-${string}`, string>> {
  const style: Record<`--tv-${string}`, string> = {};
  for (const name of TOKEN_NAMES) style[TOKEN_VARS[name]] = tokens[name];
  return style;
}

export const FONT_SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
export const FONT_MONO = 'ui-monospace, "SF Mono", Menlo, monospace';
export const TYPE = {
  meta: { size: 12, line: 16 }, base: { size: 13, line: 18 }, prose: { size: 15, line: 20 },
  numeral: { size: 20, line: 24 }, mono: { size: 12, line: 18 },
} as const;
```

`packages/trace-viewer/src/ui/tokens/contrast.ts`:

```ts
export interface Rgba { r: number; g: number; b: number; a: number }

const HEX = /^#([0-9a-f]{6})$/i;
const RGB = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})\s*(?:[/,]\s*([\d.]+%?)\s*)?\)$/i;

/** "#RRGGBB" or "rgb(r g b / a)". */
export function parseColor(value: string): Rgba {
  const text = value.trim();
  const hex = HEX.exec(text);
  if (hex !== null) {
    const n = Number.parseInt(hex[1] ?? "0", 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const rgb = RGB.exec(text);
  if (rgb !== null) {
    const alphaText = rgb[4];
    const a = alphaText === undefined ? 1
      : alphaText.endsWith("%") ? Number.parseFloat(alphaText) / 100
      : Number.parseFloat(alphaText);
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a };
  }
  throw new Error(`unsupported color: ${value}`);
}

function hex2(value: number): string {
  return Math.round(value).toString(16).padStart(2, "0").toUpperCase();
}

/** Alpha-composites fg over an opaque bg; returns "#RRGGBB". */
export function composite(fg: string, bg: string): string {
  const f = parseColor(fg);
  const b = parseColor(bg);
  if (b.a !== 1) throw new Error(`composite needs an opaque background, got ${bg}`);
  const mix = (top: number, bottom: number): number => top * f.a + bottom * (1 - f.a);
  return `#${hex2(mix(f.r, b.r))}${hex2(mix(f.g, b.g))}${hex2(mix(f.b, b.b))}`;
}

function channel(value: number): number {
  const s = value / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(color: string): number {
  const c = parseColor(color);
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/** WCAG 2.x ratio; a translucent fg is composited over bg first. */
export function contrastRatio(fg: string, bg: string): number {
  const solid = parseColor(fg).a < 1 ? composite(fg, bg) : fg;
  const a = luminance(solid);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
```

`packages/trace-viewer/src/ui/tokens/base.module.css`:

```css
.root {
  --tv-dur-fast: 120ms;
  --tv-dur: 180ms;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-size: 13px;
  line-height: 18px;
  font-weight: 400;
  color: var(--tv-ink);
  background: var(--tv-panel);
  font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased;
}

@media (prefers-reduced-motion: reduce) {
  .root {
    --tv-dur-fast: 0ms;
    --tv-dur: 0ms;
  }
}

.mono {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12px;
  line-height: 18px;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/tokens/tokens.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Root checks**

```bash
pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint
```

Expected: each exits 0; `copy-assets: 1 css file(s)` appears in the trace-viewer build output.

- [ ] **Step 6: Commit**

```bash
git add packages/trace-viewer/src/ui/tokens/tokens.ts packages/trace-viewer/src/ui/tokens/contrast.ts packages/trace-viewer/src/ui/tokens/base.module.css packages/trace-viewer/src/ui/tokens/tokens.test.ts
git commit -m "feat(trace-viewer): light --tv-* tokens with contrast and css guards"
```

### Task C1-2: Icon family (names, paths, sprite, `Icon`, kind/lane/category/signal maps)

**Files:**
- Create: `packages/trace-viewer/src/ui/icons/icon-names.ts`
- Create: `packages/trace-viewer/src/ui/icons/paths.ts`
- Create: `packages/trace-viewer/src/ui/icons/IconSprite.tsx`
- Create: `packages/trace-viewer/src/ui/icons/Icon.tsx`
- Create: `packages/trace-viewer/src/ui/icons/kind-icons.ts`
- Test: `packages/trace-viewer/src/ui/icons/icons.test.tsx`

**Interfaces:**
- Consumes (W0 model): `type StepKind`, `type Lane`, `type SignalId`, `STEP_KINDS`, `LANES`, `SIGNAL_IDS` from `../../model/index.js`; `type ChangeCategory` and `ChangeCategorySchema` from `@jevcode/contracts`.
- Produces:

```ts
export const ICON_NAMES: readonly ["person", "bubble", "thought", "plug", "term", "test", "gauge", "edit", "eye", "key", "fork", "pkg", "undo", "flag", "jev",
  "neq", "quote", "shield", "table", "route", "list", "stack", "eyeoff",
  "cursor", "hand", "fit", "zoom", "search", "clock", "check", "chev-d", "chev-r", "live", "copy", "reply", "diff", "file",
  "view-canvas", "view-hybrid"];
export type IconName = (typeof ICON_NAMES)[number];
export const ICON_PATHS: { readonly [K in IconName]: readonly string[] };
export const ICON_ID_PREFIX: "tv-i-";
export function IconSprite(): React.JSX.Element;
export interface IconProps { name: IconName; size?: 12 | 14 | 16; title?: string; className?: string }
export function Icon(props: IconProps): React.JSX.Element;
export const KIND_ICON: { readonly instruction: "person"; … } /* satisfies Record<StepKind, IconName> */;
export const LANE_ICON: /* satisfies Record<Lane, IconName> */;
export const LANE_LABEL: /* satisfies Record<Lane, string> */;
export const CATEGORY_ICON: /* satisfies Record<ChangeCategory, IconName> */;
export const SIGNAL_ICON: /* satisfies Record<SignalId, IconName> */;
```

- [ ] **Step 1: Write the failing test**

`packages/trace-viewer/src/ui/icons/icons.test.tsx`:

```tsx
// @vitest-environment jsdom
import { ChangeCategorySchema } from "@jevcode/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LANES, SIGNAL_IDS, STEP_KINDS } from "../../model/index.js";
import { Icon } from "./Icon.js";
import { ICON_NAMES } from "./icon-names.js";
import { IconSprite } from "./IconSprite.js";
import { CATEGORY_ICON, KIND_ICON, LANE_ICON, LANE_LABEL, SIGNAL_ICON } from "./kind-icons.js";
import { ICON_PATHS } from "./paths.js";

afterEach(() => cleanup());

describe("icon family", () => {
  it("has non-empty stroke path data for every name", () => {
    for (const name of ICON_NAMES) {
      expect(ICON_PATHS[name].length, name).toBeGreaterThan(0);
      for (const d of ICON_PATHS[name]) expect(d, name).toMatch(/^[Mm][\d.\s,a-zA-Z-]+$/);
    }
  });

  it("renders one symbol per name, 16x16, 1.5px stroke, round caps", () => {
    const { container } = render(<IconSprite />);
    const sprite = container.querySelector("svg");
    expect(sprite?.getAttribute("aria-hidden")).toBe("true");
    const symbols = container.querySelectorAll("symbol");
    expect(symbols).toHaveLength(ICON_NAMES.length);
    for (const name of ICON_NAMES) {
      const symbol = container.querySelector(`symbol#tv-i-${name}`);
      expect(symbol, name).not.toBeNull();
      expect(symbol?.getAttribute("viewBox")).toBe("0 0 16 16");
      expect(symbol?.getAttribute("stroke-width")).toBe("1.5");
      expect(symbol?.getAttribute("stroke-linecap")).toBe("round");
      expect(symbol?.getAttribute("fill")).toBe("none");
    }
  });

  it("an icon with a title is an image with an accessible name", () => {
    render(<Icon name="neq" title="contradicts" />);
    const img = screen.getByRole("img", { name: "contradicts" });
    expect(img.querySelector("use")?.getAttribute("href")).toBe("#tv-i-neq");
    expect(img.getAttribute("width")).toBe("16");
  });

  it("an icon without a title is hidden from assistive tech", () => {
    const { container } = render(<Icon name="term" size={12} />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("role")).toBeNull();
    expect(svg?.getAttribute("height")).toBe("12");
  });

  it("maps every kind, lane, category and signal to a real icon", () => {
    const names = new Set<string>(ICON_NAMES);
    for (const kind of STEP_KINDS) expect(names.has(KIND_ICON[kind]), kind).toBe(true);
    for (const lane of LANES) {
      expect(names.has(LANE_ICON[lane]), lane).toBe(true);
      expect(LANE_LABEL[lane].length).toBeGreaterThan(0);
    }
    for (const category of ChangeCategorySchema.options) expect(names.has(CATEGORY_ICON[category]), category).toBe(true);
    for (const signal of SIGNAL_IDS) expect(names.has(SIGNAL_ICON[signal]), signal).toBe(true);
    expect(KIND_ICON.command).toBe("term");
    expect(CATEGORY_ICON.schema).toBe("table");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/icons/icons.test.tsx`
Expected: FAIL, `Failed to resolve import "./Icon.js"`.

- [ ] **Step 3: Write the implementation**

`packages/trace-viewer/src/ui/icons/icon-names.ts`:

```ts
export const ICON_NAMES = [
  "person", "bubble", "thought", "plug", "term", "test", "gauge", "edit", "eye", "key", "fork", "pkg", "undo", "flag", "jev",
  "neq", "quote", "shield", "table", "route", "list", "stack", "eyeoff",
  "cursor", "hand", "fit", "zoom", "search", "clock", "check", "chev-d", "chev-r", "live", "copy", "reply", "diff", "file",
  "view-canvas", "view-hybrid",
] as const;
export type IconName = (typeof ICON_NAMES)[number];
```

`packages/trace-viewer/src/ui/icons/paths.ts` (16 × 16 viewBox, stroke-only; dots are r 0.5 circles that the 1.5 px stroke fills):

```ts
import type { IconName } from "./icon-names.js";

const circle = (cx: number, cy: number, r: number): string =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
const dot = (cx: number, cy: number): string => circle(cx, cy, 0.5);

/** One 1.5px-stroke family (D8), after the approved mockups' m22-* symbols. */
export const ICON_PATHS: { readonly [K in IconName]: readonly string[] } = {
  person: [circle(8, 5.5, 2.75), "M2.75 13.75c.6-2.6 2.7-4 5.25-4s4.65 1.4 5.25 4"],
  bubble: ["M2.75 4.25c0-.83.67-1.5 1.5-1.5h7.5c.83 0 1.5.67 1.5 1.5v5.5c0 .83-.67 1.5-1.5 1.5H7.25L4.5 13.5v-2.25h-.25c-.83 0-1.5-.67-1.5-1.5z"],
  thought: ["M5.25 10.25a2.75 2.75 0 0 1-.4-5.47A3.25 3.25 0 0 1 11 4.4a2.9 2.9 0 0 1 .25 5.85z", dot(4.25, 12.75), dot(2.75, 14.25)],
  plug: ["M6 2.25v3M10 2.25v3", "M4.25 5.25h7.5v2.5a3.75 3.75 0 0 1-7.5 0z", "M8 11.5v2.25"],
  term: ["M4 2.75h8a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6.5a2 2 0 0 1 2-2z", "M5 6.25 7 8l-2 1.75M8.75 10h2.5"],
  test: ["M5.75 2.25h4.5M6.75 2.25v4.1L3.3 12.1a1.1 1.1 0 0 0 .95 1.65h7.5a1.1 1.1 0 0 0 .95-1.65L9.25 6.35v-4.1M4.9 9.75h6.2"],
  gauge: ["M2.75 11.5a5.25 5.25 0 1 1 10.5 0", "M8 11.5l2.5-3.5", dot(8, 11.5)],
  edit: ["M7.75 13.25H4.5A1.5 1.5 0 0 1 3 11.75v-8a1.5 1.5 0 0 1 1.5-1.5h4l3 3v1.5", "M12.4 8.1l1.5 1.5-4.4 4.4H8v-1.5z"],
  eye: ["M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8z", circle(8, 8, 2)],
  key: [circle(5.5, 10.5, 2.75), "M7.5 8.5l5.25-5.25M11 5l1.75 1.75M9.5 6.5l1.25 1.25"],
  fork: [circle(4.5, 3.5, 1.5), circle(11.5, 3.5, 1.5), circle(8, 12.5, 1.5), "M4.5 5v.75A2.25 2.25 0 0 0 6.75 8h2.5a2.25 2.25 0 0 0 2.25-2.25V5M8 8v3"],
  pkg: ["M8 1.75l5.5 3v6.5L8 14.25l-5.5-3v-6.5z", "M2.5 4.75 8 7.75l5.5-3M8 7.75v6.5M5.25 3.25l5.5 3"],
  undo: ["M5.5 3.5 2.75 6.25 5.5 9", "M2.75 6.25h6.5a3.5 3.5 0 0 1 0 7H6.5"],
  flag: ["M3.5 14V2.5M3.5 3h8.5l-2 3 2 3H3.5"],
  jev: ["M2.5 5.5V4A1.5 1.5 0 0 1 4 2.5h1.5M10.5 2.5H12A1.5 1.5 0 0 1 13.5 4v1.5M13.5 10.5V12a1.5 1.5 0 0 1-1.5 1.5h-1.5M5.5 13.5H4A1.5 1.5 0 0 1 2.5 12v-1.5", dot(8, 8)],
  neq: ["M3.25 6h9.5M3.25 10h9.5M10.25 2.75l-4.5 10.5"],
  quote: ["M2.75 7.75h3.5v3.5h-3.5V7.75c0-2.1 1-3.4 3-4M9.75 7.75h3.5v3.5h-3.5V7.75c0-2.1 1-3.4 3-4"],
  shield: ["M8 1.75 13 3.6v4.1c0 3.05-2.05 5.25-5 6.55-2.95-1.3-5-3.5-5-6.55V3.6z"],
  table: ["M4 2.75h8a1.75 1.75 0 0 1 1.75 1.75v7a1.75 1.75 0 0 1-1.75 1.75H4a1.75 1.75 0 0 1-1.75-1.75v-7A1.75 1.75 0 0 1 4 2.75z", "M2.25 6.5h11.5M2.25 9.9h11.5M6.25 6.5v6.75"],
  route: [circle(3.5, 12.5, 1.5), circle(12.5, 3.5, 1.5), "M3.5 11V7a2 2 0 0 1 2-2h4a1.5 1.5 0 0 0 1.5-1.5"],
  list: ["M6.5 4.25h7M6.5 8h7M6.5 11.75h7", dot(3.25, 4.25), dot(3.25, 8), dot(3.25, 11.75)],
  stack: ["M8 2.25 13.75 5 8 7.75 2.25 5z", "M2.25 8 8 10.75 13.75 8", "M2.25 11 8 13.75 13.75 11"],
  eyeoff: ["M6.6 3.9A6 6 0 0 1 8 3.75c4 0 6.25 4.25 6.25 4.25a11.6 11.6 0 0 1-1.7 2.2M4.2 5.1C2.6 6.2 1.75 8 1.75 8S4 12.25 8 12.25a6.2 6.2 0 0 0 3.2-.9M2.25 2.25l11.5 11.5M6.6 6.6a2 2 0 0 0 2.8 2.8"],
  cursor: ["M3.25 2.75 12.75 7l-4.1 1.35-1.4 4.4z"],
  hand: ["M5.25 8.5V4a1 1 0 0 1 2 0v3.5M7.25 7V2.75a1 1 0 0 1 2 0V7.5M9.25 7.25V4a1 1 0 0 1 2 0v5a4.75 4.75 0 0 1-4.75 4.75h-.4a3.8 3.8 0 0 1-3.05-1.55L1.9 10.4a1 1 0 0 1 1.45-1.35l1.9 1.45"],
  fit: ["M2.75 6V3.5a.75.75 0 0 1 .75-.75H6M10 2.75h2.5a.75.75 0 0 1 .75.75V6M13.25 10v2.5a.75.75 0 0 1-.75.75H10M6 13.25H3.5a.75.75 0 0 1-.75-.75V10"],
  zoom: [circle(7, 7, 4.25), "M10.25 10.25l3.5 3.5M5.25 7h3.5M7 5.25v3.5"],
  search: [circle(7, 7, 4.25), "M10.25 10.25l3.5 3.5"],
  clock: [circle(8, 8, 6), "M8 4.75V8l2.25 1.5"],
  check: ["M3.5 8.25l3 3 6-6.5"],
  "chev-d": ["M4.75 6.5 8 9.75l3.25-3.25"],
  "chev-r": ["M6.5 4.75 9.75 8 6.5 11.25"],
  live: [circle(8, 8, 1.25), "M4.75 4.75a4.6 4.6 0 0 0 0 6.5M11.25 4.75a4.6 4.6 0 0 1 0 6.5"],
  copy: ["M6 5.25h5.25a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-6.5a1 1 0 0 1 1-1z", "M3.75 10.5V3.25a1 1 0 0 1 1-1h5.5"],
  reply: ["M6.25 4 2.75 7.5 6.25 11", "M2.75 7.5h6.5a4 4 0 0 1 4 4v1"],
  diff: ["M8 2.75v5.5M5.25 5.5h5.5M5.25 12.25h5.5"],
  file: ["M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6z", "M9 2v4h4"],
  "view-canvas": ["M2.75 3.25h4.5v4h-4.5zM8.75 8.75h4.5v4h-4.5z", "M7.25 5.25h1.5a1.25 1.25 0 0 1 1.25 1.25v2.25"],
  "view-hybrid": ["M2.25 3.25h11.5M2.25 6h11.5", "M2.25 9.5h3M7.25 9.5h6.5M2.25 12.5h3M7.25 12.5h6.5"],
};
```

`packages/trace-viewer/src/ui/icons/IconSprite.tsx`:

```tsx
import type { JSX } from "react";

import { ICON_NAMES } from "./icon-names.js";
import { ICON_PATHS } from "./paths.js";

export const ICON_ID_PREFIX = "tv-i-";

/** Renders every <symbol id="tv-i-<name>"> once, inside a hidden aria-hidden <svg>; mounted by the Shell. */
export function IconSprite(): JSX.Element {
  return (
    <svg aria-hidden="true" focusable="false" width="0" height="0" style={{ position: "absolute", overflow: "hidden" }}>
      {ICON_NAMES.map((name) => (
        <symbol
          key={name}
          id={`${ICON_ID_PREFIX}${name}`}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {ICON_PATHS[name].map((d, i) => (
            <path key={i} d={d} />
          ))}
        </symbol>
      ))}
    </svg>
  );
}
```

`packages/trace-viewer/src/ui/icons/Icon.tsx`:

```tsx
import type { JSX } from "react";

import type { IconName } from "./icon-names.js";

export interface IconProps { name: IconName; size?: 12 | 14 | 16; title?: string; className?: string }

/** <svg><use href="#tv-i-<name>"/></svg>; aria-hidden unless title is set. */
export function Icon({ name, size = 16, title, className }: IconProps): JSX.Element {
  const a11y = title !== undefined && title.length > 0
    ? { role: "img", "aria-label": title }
    : { "aria-hidden": true };
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 16 16" focusable="false" {...a11y}>
      <use href={`#tv-i-${name}`} />
    </svg>
  );
}
```

`packages/trace-viewer/src/ui/icons/kind-icons.ts`:

```ts
import type { ChangeCategory } from "@jevcode/contracts";

import type { Lane, SignalId, StepKind } from "../../model/index.js";
import type { IconName } from "./icon-names.js";

export const KIND_ICON = {
  instruction: "person", message: "bubble", reasoning: "thought", command: "term", test: "test",
  check: "gauge", edit: "edit", read: "eye", tool: "plug", approval: "key", decision: "fork",
  dependency: "pkg", revert: "undo", lifecycle: "flag", guardrail: "shield", attention: "jev",
} as const satisfies Record<StepKind, IconName>;

export const LANE_ICON = {
  supervisor: "person", agent: "bubble", commands: "term", edits: "edit", tests: "test", jev: "jev",
} as const satisfies Record<Lane, IconName>;

export const LANE_LABEL = {
  supervisor: "Supervisor", agent: "Agent", commands: "Commands", edits: "Edits", tests: "Tests", jev: "Jev",
} as const satisfies Record<Lane, string>;

export const CATEGORY_ICON = {
  schema: "table", tests: "test", dependency: "pkg", architecture: "route", api: "route", security: "shield",
  behavior: "list", configuration: "list", performance: "list", implementation: "list", documentation: "list",
} as const satisfies Record<ChangeCategory, IconName>;

export const SIGNAL_ICON = {
  claim_contradicted: "neq", failing_tests: "test", destructive_command: "term", guardrail_clamp: "shield", recovery_arc: "check",
} as const satisfies Record<SignalId, IconName>;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/icons/icons.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Root checks**

```bash
pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint
```

Expected: each exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/trace-viewer/src/ui/icons/icon-names.ts packages/trace-viewer/src/ui/icons/paths.ts packages/trace-viewer/src/ui/icons/IconSprite.tsx packages/trace-viewer/src/ui/icons/Icon.tsx packages/trace-viewer/src/ui/icons/kind-icons.ts packages/trace-viewer/src/ui/icons/icons.test.tsx
git commit -m "feat(trace-viewer): 1.5px icon family with sprite and kind maps"
```

### Task C1-3: Graphic scales and bar graphics (`DiffBar`, `TestDots`, `DurationBar`)

**Files:**
- Create: `packages/trace-viewer/src/ui/graphics/scales.ts`
- Test: `packages/trace-viewer/src/ui/graphics/scales.test.ts`
- Create: `packages/trace-viewer/src/ui/graphics/DiffBar.tsx`
- Create: `packages/trace-viewer/src/ui/graphics/TestDots.tsx`
- Create: `packages/trace-viewer/src/ui/graphics/DurationBar.tsx`
- Create: `packages/trace-viewer/src/ui/graphics/graphics.module.css`
- Test: `packages/trace-viewer/src/ui/graphics/bars.test.tsx`

**Interfaces:**
- Consumes: C1-1 tokens only through `var(--tv-*)` in CSS.
- Produces:

```ts
// ui/graphics/scales.ts
export const DIFF_SIDE_MAX_PX = 56;
export function diffSidePx(lines: number): number;            // 0 when lines = 0, else clamp(2, 56, 8 · log2(1 + lines))
export function compactCount(n: number): string;               // exact below 1,000; "1.2k" from 1,000; "1.2M" from 1,000,000
export const TEST_DOTS_MAX = 15;
export function testDotsMode(total: number): "dots" | "bar";
export function durationPx(ms: number): number;                // clamp(4, 120, 20 + 40 · log10(seconds))
export type GraphicSize = "xs" | "sm" | "md";
export interface GraphicBaseProps { size: GraphicSize; label?: string }
export function graphicA11y(label?: string): { role: "img"; "aria-label": string } | { "aria-hidden": true };
// DiffBar.tsx, TestDots.tsx, DurationBar.tsx
export interface DiffBarProps extends GraphicBaseProps { added: number; removed: number; files?: readonly { path: string; added: number; removed: number }[]; moreFiles?: number }
export const DiffBar: React.NamedExoticComponent<DiffBarProps>;
export interface TestDotsProps extends GraphicBaseProps { passed: number; failed: number; skipped: number }
export const TestDots: React.NamedExoticComponent<TestDotsProps>;
export interface DurationBarProps extends GraphicBaseProps { durationMs: number | null; running: boolean; elapsedMs?: number; end: "none" | "bad_dot" | "exit_x" }
export const DurationBar: React.NamedExoticComponent<DurationBarProps>;
```

(`GraphicSize` and `GraphicBaseProps` live in `scales.ts` so every graphic imports one definition; the UI index lists them as "shared props".)

- [ ] **Step 1: Write the failing tests**

`packages/trace-viewer/src/ui/graphics/scales.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { compactCount, diffSidePx, durationPx, graphicA11y, testDotsMode } from "./scales.js";

describe("graphic scales (R24, spec §7.12)", () => {
  it("DiffBar sides follow 8·log2(1+lines), 0 for none, capped at 56", () => {
    expect(diffSidePx(0)).toBe(0);
    expect(diffSidePx(1)).toBe(8);
    expect(diffSidePx(127)).toBe(56);
    expect(diffSidePx(10_000)).toBe(56);
    expect(diffSidePx(-3)).toBe(0);
  });

  it("counts are exact below 1,000 and compact above", () => {
    expect(compactCount(999)).toBe("999");
    expect(compactCount(1_234)).toBe("1.2k");
    expect(compactCount(1_000)).toBe("1.0k");
    expect(compactCount(2_500_000)).toBe("2.5M");
  });

  it("TestDots draws dots up to 15 tests, then a bar", () => {
    expect(testDotsMode(15)).toBe("dots");
    expect(testDotsMode(16)).toBe("bar");
  });

  it("DurationBar is 20+40·log10(s) on an absolute scale, clamped to [4, 120]", () => {
    expect(durationPx(1_000)).toBe(20);
    expect(durationPx(10_000)).toBe(60);
    expect(durationPx(100_000)).toBe(100);
    expect(durationPx(100)).toBe(4);
    expect(durationPx(0)).toBe(4);
    expect(durationPx(10_000_000)).toBe(120);
  });

  it("a graphic without a label is hidden from assistive tech", () => {
    expect(graphicA11y()).toEqual({ "aria-hidden": true });
    expect(graphicA11y("14 passed, 1 failed")).toEqual({ role: "img", "aria-label": "14 passed, 1 failed" });
  });
});
```

`packages/trace-viewer/src/ui/graphics/bars.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DiffBar } from "./DiffBar.js";
import { DurationBar } from "./DurationBar.js";
import { TestDots } from "./TestDots.js";

afterEach(() => cleanup());

describe("TestDots", () => {
  it("renders 15 dots for oauth's 14/1/0 run, the failed dot larger", () => {
    const { container } = render(<TestDots size="xs" passed={14} failed={1} skipped={0} />);
    const dots = [...container.querySelectorAll("circle[data-state]")];
    expect(dots).toHaveLength(15);
    const failed = dots.filter((d) => d.getAttribute("data-state") === "failed");
    const passed = dots.filter((d) => d.getAttribute("data-state") === "passed");
    expect(failed).toHaveLength(1);
    expect(passed).toHaveLength(14);
    expect(Number(failed[0]?.getAttribute("r"))).toBeGreaterThan(Number(passed[0]?.getAttribute("r")));
  });

  it("renders a bar and the count for 16 tests", () => {
    const { container } = render(<TestDots size="sm" passed={15} failed={1} skipped={0} />);
    expect(container.querySelectorAll("circle[data-state]")).toHaveLength(0);
    expect(container.querySelectorAll("rect[data-state]").length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).toContain("15/16");
  });

  it("uses the label as its accessible name", () => {
    render(<TestDots size="md" passed={14} failed={1} skipped={0} label="14 passed, 1 failed" />);
    expect(screen.getByRole("img", { name: "14 passed, 1 failed" })).toBeTruthy();
  });
});

describe("DurationBar", () => {
  it("ends a nonzero command exit in an ink cross and never fills red", () => {
    const { container } = render(<DurationBar size="xs" durationMs={5_000} running={false} end="exit_x" />);
    expect(container.querySelector('[data-end="exit_x"]')).not.toBeNull();
    expect(container.querySelector('[data-tone="bad"]')).toBeNull();
  });

  it("ends a failed test in a red dot", () => {
    const { container } = render(<DurationBar size="xs" durationMs={5_000} running={false} end="bad_dot" />);
    expect(container.querySelector('[data-end="bad_dot"]')?.getAttribute("data-tone")).toBe("bad");
  });

  it("draws a running step as a hollow bar of its elapsed time", () => {
    const { container } = render(<DurationBar size="xs" durationMs={null} running elapsedMs={10_000} end="none" />);
    const bar = container.querySelector("rect[data-bar]");
    expect(bar?.getAttribute("data-bar")).toBe("hollow");
    expect(Number(bar?.getAttribute("width"))).toBeCloseTo(60 - 1.5, 5);
  });
});

describe("DiffBar", () => {
  it("draws added solid and removed hollow, neutral, sized by diffSidePx", () => {
    const { container } = render(<DiffBar size="xs" added={1} removed={127} />);
    const added = container.querySelector('rect[data-side="added"]');
    const removed = container.querySelector('rect[data-side="removed"]');
    expect(Number(added?.getAttribute("width"))).toBe(8);
    expect(Number(removed?.getAttribute("width"))).toBeCloseTo(56 - 1.5, 5);
    expect(container.querySelector('[data-tone="bad"]')).toBeNull();
  });

  it("lists at most four files and +k at sm", () => {
    const files = [1, 2, 3, 4, 5].map((n) => ({ path: `src/f${n}.ts`, added: n, removed: 0 }));
    const { container } = render(<DiffBar size="sm" added={15} removed={0} files={files} moreFiles={1} />);
    expect(container.querySelectorAll("[data-file]")).toHaveLength(4);
    expect(container.textContent).toContain("+1");
    expect(container.textContent).toContain("+15 −0");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/graphics/scales.test.ts src/ui/graphics/bars.test.tsx`
Expected: FAIL, `Failed to resolve import "./scales.js"`.

- [ ] **Step 3: Write the implementation**

`packages/trace-viewer/src/ui/graphics/scales.ts`:

```ts
export type GraphicSize = "xs" | "sm" | "md";

export interface GraphicBaseProps {
  size: GraphicSize;
  /** Accessible name (describeGraphic); omitted → aria-hidden. */
  label?: string;
}

const clamp = (lo: number, hi: number, v: number): number => Math.min(hi, Math.max(lo, v));

export const DIFF_SIDE_MAX_PX = 56;

/** 0 when lines = 0, else clamp(2, 56, 8 · log2(1 + lines)). */
export function diffSidePx(lines: number): number {
  if (!(lines > 0)) return 0;
  return clamp(2, DIFF_SIDE_MAX_PX, 8 * Math.log2(1 + lines));
}

/** Exact below 1,000; one decimal with k from 1,000 ("1.2k"); M from 1,000,000. */
export function compactCount(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1_000) return String(n);
  if (abs < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export const TEST_DOTS_MAX = 15;

export function testDotsMode(total: number): "dots" | "bar" {
  return total <= TEST_DOTS_MAX ? "dots" : "bar";
}

/** clamp(4, 120, 20 + 40 · log10(seconds)); 1 s = 20, 10 s = 60, 100 s = 100. */
export function durationPx(ms: number): number {
  if (!(ms > 0)) return 4;
  return clamp(4, 120, 20 + 40 * Math.log10(ms / 1_000));
}

export function graphicA11y(label?: string): { role: "img"; "aria-label": string } | { "aria-hidden": true } {
  return label !== undefined && label.length > 0 ? { role: "img", "aria-label": label } : { "aria-hidden": true };
}
```

`packages/trace-viewer/src/ui/graphics/graphics.module.css`:

```css
.graphic {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  vertical-align: middle;
  flex: none;
  font-size: 12px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
}

.xs { gap: 4px; }
.sm { gap: 6px; }
.md { gap: 8px; }

.count {
  color: var(--tv-ink-3);
  white-space: nowrap;
}

.added { fill: var(--tv-ink-2); }
.removed { fill: none; stroke: var(--tv-ink-3); stroke-width: 1.5; }

.files {
  display: inline-flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.file {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.path {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12px;
  color: var(--tv-ink-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pass { fill: var(--tv-good); }
.fail { fill: var(--tv-bad); }
.skip { fill: none; stroke: var(--tv-mark); stroke-width: 1; }

.bar { fill: var(--tv-mark); }
.hollow { fill: none; stroke: var(--tv-mark); stroke-width: 1.5; }
.badDot { fill: var(--tv-bad); }
.exitX { fill: none; stroke: var(--tv-ink-2); stroke-width: 1.5; stroke-linecap: round; }
```

`packages/trace-viewer/src/ui/graphics/DiffBar.tsx`:

```tsx
import { memo, type JSX } from "react";

import styles from "./graphics.module.css";
import { compactCount, diffSidePx, graphicA11y, type GraphicBaseProps, type GraphicSize } from "./scales.js";

export interface DiffBarProps extends GraphicBaseProps {
  added: number;
  removed: number;
  files?: readonly { path: string; added: number; removed: number }[];
  moreFiles?: number;
}

const BAR_H: Record<GraphicSize, number> = { xs: 6, sm: 8, md: 10 };
const GAP = 2;
const STROKE = 1.5;

function Bars({ added, removed, h }: { added: number; removed: number; h: number }): JSX.Element {
  const a = diffSidePx(added);
  const r = diffSidePx(removed);
  const width = Math.max(1, a + (a > 0 && r > 0 ? GAP : 0) + r);
  const rx = a > 0 && r > 0 ? a + GAP : 0;
  return (
    <svg width={width} height={h} viewBox={`0 0 ${width} ${h}`} aria-hidden="true" focusable="false">
      {a > 0 ? <rect data-side="added" className={styles.added} x={0} y={0} width={a} height={h} rx={1} /> : null}
      {r > 0 ? (
        <rect
          data-side="removed"
          className={styles.removed}
          x={rx + STROKE / 2}
          y={STROKE / 2}
          width={r - STROKE}
          height={h - STROKE}
          rx={1}
        />
      ) : null}
    </svg>
  );
}

function DiffBarImpl({ size, label, added, removed, files, moreFiles }: DiffBarProps): JSX.Element {
  const rows = size !== "xs" && files !== undefined && files.length > 0 ? files.slice(0, 4) : null;
  return (
    <span className={`${styles.graphic} ${styles[size]}`} {...graphicA11y(label)}>
      {rows === null ? (
        <Bars added={added} removed={removed} h={BAR_H[size]} />
      ) : (
        <span className={styles.files}>
          {rows.map((file) => (
            <span key={file.path} className={styles.file} data-file={file.path}>
              <Bars added={file.added} removed={file.removed} h={BAR_H[size]} />
              <span className={styles.path}>{file.path}</span>
            </span>
          ))}
          {moreFiles !== undefined && moreFiles > 0 ? <span className={styles.count}>{`+${moreFiles}`}</span> : null}
        </span>
      )}
      {size !== "xs" ? <span className={styles.count}>{`+${compactCount(added)} −${compactCount(removed)}`}</span> : null}
    </span>
  );
}

export const DiffBar = memo(DiffBarImpl);
```

`packages/trace-viewer/src/ui/graphics/TestDots.tsx`:

```tsx
import { memo, type JSX } from "react";

import styles from "./graphics.module.css";
import { graphicA11y, testDotsMode, type GraphicBaseProps, type GraphicSize } from "./scales.js";

export interface TestDotsProps extends GraphicBaseProps { passed: number; failed: number; skipped: number }

const R: Record<GraphicSize, { pass: number; fail: number }> = {
  xs: { pass: 2, fail: 3 },
  sm: { pass: 2.5, fail: 3.5 },
  md: { pass: 3, fail: 4 },
};
const BAR_W = 60;

function TestDotsImpl({ size, label, passed, failed, skipped }: TestDotsProps): JSX.Element {
  const total = passed + failed + skipped;
  const r = R[size];
  const h = r.fail * 2;
  if (testDotsMode(total) === "dots") {
    const states: ("failed" | "passed" | "skipped")[] = [
      ...Array<"failed">(failed).fill("failed"),
      ...Array<"passed">(passed).fill("passed"),
      ...Array<"skipped">(skipped).fill("skipped"),
    ];
    const pitch = r.pass * 2 + 2;
    let x = 0;
    const dots = states.map((state, i) => {
      const radius = state === "failed" ? r.fail : r.pass;
      const cx = x + radius;
      x += radius * 2 + (pitch - r.pass * 2);
      const cls = state === "failed" ? styles.fail : state === "passed" ? styles.pass : styles.skip;
      return <circle key={i} data-state={state} className={cls} cx={cx} cy={h / 2} r={radius} />;
    });
    const width = Math.max(1, x);
    return (
      <span className={`${styles.graphic} ${styles[size]}`} {...graphicA11y(label)}>
        <svg width={width} height={h} viewBox={`0 0 ${width} ${h}`} aria-hidden="true" focusable="false">{dots}</svg>
      </span>
    );
  }
  const segments = [
    { state: "passed", n: passed, cls: styles.pass },
    { state: "failed", n: failed, cls: styles.fail },
    { state: "skipped", n: skipped, cls: styles.skip },
  ] as const;
  let x = 0;
  const rects = segments.filter((s) => s.n > 0).map((s) => {
    const w = Math.max(2, (s.n / total) * BAR_W);
    const rect = <rect key={s.state} data-state={s.state} className={s.cls} x={x} y={h / 2 - 2} width={w} height={4} />;
    x += w;
    return rect;
  });
  return (
    <span className={`${styles.graphic} ${styles[size]}`} {...graphicA11y(label)}>
      <svg width={x} height={h} viewBox={`0 0 ${x} ${h}`} aria-hidden="true" focusable="false">{rects}</svg>
      <span className={styles.count}>{`${passed}/${total}`}</span>
    </span>
  );
}

export const TestDots = memo(TestDotsImpl);
```

`packages/trace-viewer/src/ui/graphics/DurationBar.tsx`:

```tsx
import { memo, type JSX } from "react";

import styles from "./graphics.module.css";
import { durationPx, graphicA11y, type GraphicBaseProps, type GraphicSize } from "./scales.js";

export interface DurationBarProps extends GraphicBaseProps {
  durationMs: number | null;
  running: boolean;
  /** Running: elapsed so far, drawn as the hollow extension to now. */
  elapsedMs?: number;
  end: "none" | "bad_dot" | "exit_x";
}

const BAR_H: Record<GraphicSize, number> = { xs: 6, sm: 8, md: 10 };
const STROKE = 1.5;
const END_W = 10;

function DurationBarImpl({ size, label, durationMs, running, elapsedMs, end }: DurationBarProps): JSX.Element {
  const h = BAR_H[size];
  const w = durationPx(running ? (elapsedMs ?? 0) : (durationMs ?? 0));
  const width = w + (end === "none" ? 0 : END_W);
  const cy = h / 2;
  const ex = w + END_W / 2;
  return (
    <span className={`${styles.graphic} ${styles[size]}`} {...graphicA11y(label)}>
      <svg width={width} height={h} viewBox={`0 0 ${width} ${h}`} aria-hidden="true" focusable="false">
        {running ? (
          <rect data-bar="hollow" data-tone="neutral" className={styles.hollow}
            x={STROKE / 2} y={STROKE / 2} width={w - STROKE} height={h - STROKE} rx={1} />
        ) : (
          <rect data-bar="solid" data-tone="neutral" className={styles.bar} x={0} y={0} width={w} height={h} rx={1} />
        )}
        {end === "bad_dot" ? (
          <circle data-end="bad_dot" data-tone="bad" className={styles.badDot} cx={ex} cy={cy} r={Math.min(3, h / 2)} />
        ) : null}
        {end === "exit_x" ? (
          <path data-end="exit_x" data-tone="neutral" className={styles.exitX}
            d={`M${ex - 2.5} ${cy - 2.5}l5 5M${ex + 2.5} ${cy - 2.5}l-5 5`} />
        ) : null}
      </svg>
    </span>
  );
}

export const DurationBar = memo(DurationBarImpl);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/graphics/scales.test.ts src/ui/graphics/bars.test.tsx`
Expected: PASS, 13 tests.

- [ ] **Step 5: Root checks**

```bash
pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint
```

Expected: each exits 0; the C1-1 CSS guard now also scans `graphics.module.css` and passes.

- [ ] **Step 6: Commit**

```bash
git add packages/trace-viewer/src/ui/graphics/scales.ts packages/trace-viewer/src/ui/graphics/scales.test.ts packages/trace-viewer/src/ui/graphics/DiffBar.tsx packages/trace-viewer/src/ui/graphics/TestDots.tsx packages/trace-viewer/src/ui/graphics/DurationBar.tsx packages/trace-viewer/src/ui/graphics/graphics.module.css packages/trace-viewer/src/ui/graphics/bars.test.tsx
git commit -m "feat(trace-viewer): graphic scales and DiffBar, TestDots, DurationBar"
```

### Task C1-4: Glyph graphics (`ForkGlyph`, `FlowGlyph`, `TableGlyph`, `ClaimVsObserved`) and the `Graphic` map

**Files:**
- Create: `packages/trace-viewer/src/ui/graphics/ForkGlyph.tsx`
- Create: `packages/trace-viewer/src/ui/graphics/FlowGlyph.tsx`
- Create: `packages/trace-viewer/src/ui/graphics/TableGlyph.tsx`
- Create: `packages/trace-viewer/src/ui/graphics/ClaimVsObserved.tsx`
- Create: `packages/trace-viewer/src/ui/graphics/Graphic.tsx`
- Modify: `packages/trace-viewer/src/ui/graphics/graphics.module.css` (append; C1-3 created it)
- Test: `packages/trace-viewer/src/ui/graphics/glyphs.test.tsx`

**Interfaces:**
- Consumes: C1-2 `Icon` (`../icons/Icon.js`); C1-3 `TestDots`, `DiffBar`, `DurationBar`, `graphicA11y`, `GraphicSize`, `GraphicBaseProps`; W0 amended `type GraphicSpec` from `../../model/index.js` (UI index §1.2 shape: `diff {added, removed, files?, moreFiles?}`, `tests {passed, failed, skipped}`, `duration {durationMs, running, status, end}`, `fork {options, decidedBy}`, `flow {nodes, focus}`, `table {tables: {name, role: "new" | "altered", columns}[]}`, `claim {claim: {text, span?, tMs}, observed: {passed, failed, command, tMs}}`).
- Produces:

```ts
export interface ForkGlyphProps extends GraphicBaseProps { options: readonly { label: string; chosen: boolean }[]; decidedBy: "supervisor" | "delegated" | "open" }
export const ForkGlyph: React.NamedExoticComponent<ForkGlyphProps>;
export interface FlowGlyphProps extends GraphicBaseProps { nodes: readonly string[]; focus: number }
export const FlowGlyph: React.NamedExoticComponent<FlowGlyphProps>;
export interface TableGlyphProps extends GraphicBaseProps { tables: readonly { name: string; role: "new" | "altered"; columns: number }[] }
export const TableGlyph: React.NamedExoticComponent<TableGlyphProps>;
export interface ClaimVsObservedProps extends GraphicBaseProps {
  claim: { text: string; span?: readonly [number, number]; tMs: number };
  observed: { passed: number; failed: number; command: string; tMs: number };
  onObservedClick?(): void;
}
export const ClaimVsObserved: React.NamedExoticComponent<ClaimVsObservedProps>;
export const GRAPHIC_COMPONENTS: { readonly [K in GraphicSpec["kind"]]: React.ComponentType<{ spec: Extract<GraphicSpec, { kind: K }>; size: GraphicSize; label?: string; elapsedMs?: number }> };
export function Graphic(props: { spec: GraphicSpec; size: GraphicSize; label?: string; elapsedMs?: number }): React.JSX.Element;
```

(`elapsedMs` is an optional prop the duration entry forwards; the map stays assignable to the index's narrower type.)

- [ ] **Step 1: Write the failing test**

`packages/trace-viewer/src/ui/graphics/glyphs.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GraphicSpec } from "../../model/index.js";
import { ClaimVsObserved } from "./ClaimVsObserved.js";
import { FlowGlyph } from "./FlowGlyph.js";
import { ForkGlyph } from "./ForkGlyph.js";
import { Graphic, GRAPHIC_COMPONENTS } from "./Graphic.js";
import { TableGlyph } from "./TableGlyph.js";

afterEach(() => cleanup());

const KINDS = ["diff", "tests", "duration", "fork", "flow", "table", "claim"] as const satisfies readonly GraphicSpec["kind"][];
type Missing = Exclude<GraphicSpec["kind"], (typeof KINDS)[number]>;
const exhaustive: [Missing] extends [never] ? true : false = true;

describe("ForkGlyph", () => {
  it("draws 3 branches and +1 for 4 options, the chosen branch solid and others dashed", () => {
    const options = [
      { label: "explicit_link", chosen: true },
      { label: "auto_link_by_email", chosen: false },
      { label: "reject", chosen: false },
      { label: "ask_later", chosen: false },
    ];
    const { container } = render(<ForkGlyph size="sm" options={options} decidedBy="supervisor" />);
    const branches = [...container.querySelectorAll("path[data-branch]")];
    expect(branches).toHaveLength(3);
    const chosen = branches.filter((b) => b.getAttribute("data-chosen") === "true");
    expect(chosen).toHaveLength(1);
    expect(chosen[0]?.getAttribute("stroke-dasharray")).toBeNull();
    for (const b of branches.filter((x) => x.getAttribute("data-chosen") === "false")) {
      expect(b.getAttribute("stroke-dasharray")).toBe("2 2");
    }
    expect(container.textContent).toContain("+1");
  });

  it("keeps the chosen option when it is the fourth", () => {
    const options = ["a", "b", "c", "d"].map((label) => ({ label, chosen: label === "d" }));
    const { container } = render(<ForkGlyph size="xs" options={options} decidedBy="delegated" />);
    const branches = [...container.querySelectorAll("path[data-branch]")];
    expect(branches.map((b) => b.getAttribute("data-branch"))).toEqual(["a", "b", "d"]);
  });

  it("an open decision has no solid branch", () => {
    const options = [{ label: "a", chosen: false }, { label: "b", chosen: false }];
    const { container } = render(<ForkGlyph size="xs" options={options} decidedBy="open" />);
    expect(container.querySelectorAll('path[data-chosen="true"]')).toHaveLength(0);
  });
});

describe("ClaimVsObserved", () => {
  const text = "OAuth implementation complete; all checks pass.";
  const start = text.indexOf("all checks pass");
  const span = [start, start + "all checks pass".length] as const;

  it("underlines exactly the claim span and renders the claim as text", () => {
    const { container } = render(
      <ClaimVsObserved size="md" claim={{ text, span, tMs: 43_000 }} observed={{ passed: 14, failed: 1, command: "pnpm test", tMs: 35_000 }} />,
    );
    expect(container.querySelector("[data-claim-span]")?.textContent).toBe("all checks pass");
    expect(container.textContent).toContain(text);
    expect(container.textContent).toContain("1 failed");
    expect(container.textContent).toContain("pnpm test");
  });

  it("renders markup in agent text as text", () => {
    const hostile = "<img src=x onerror=alert(1)> all tests pass";
    const { container } = render(
      <ClaimVsObserved size="sm" claim={{ text: hostile, tMs: 1 }} observed={{ passed: 0, failed: 1, command: "pnpm test", tMs: 0 }} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("the observed card is a button when clickable", () => {
    const onObservedClick = vi.fn();
    render(
      <ClaimVsObserved size="md" claim={{ text, span, tMs: 43_000 }} observed={{ passed: 14, failed: 1, command: "pnpm test", tMs: 35_000 }} onObservedClick={onObservedClick} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /1 failed/ }));
    expect(onObservedClick).toHaveBeenCalledTimes(1);
  });
});

describe("FlowGlyph and TableGlyph", () => {
  it("FlowGlyph shows 3 nodes then an ellipsis and marks the focus", () => {
    const { container } = render(<FlowGlyph size="md" nodes={["identity", "google", "service", "index"]} focus={1} />);
    const nodes = [...container.querySelectorAll("[data-node]")];
    expect(nodes.map((n) => n.textContent)).toEqual(["identity", "google", "service"]);
    expect(nodes[1]?.getAttribute("data-focus")).toBe("true");
    expect(container.textContent).toContain("…");
  });

  it("TableGlyph shows at most two tables with column counts", () => {
    const tables = [
      { name: "identities", role: "new" as const, columns: 5 },
      { name: "users", role: "altered" as const, columns: 1 },
      { name: "sessions", role: "altered" as const, columns: 2 },
    ];
    const { container } = render(<TableGlyph size="sm" tables={tables} />);
    expect(container.querySelectorAll("[data-table]")).toHaveLength(2);
    expect(container.textContent).toContain("identities");
    expect(container.textContent).toContain("5 cols");
  });
});

describe("Graphic map", () => {
  it("has an entry for every GraphicSpec kind", () => {
    expect(exhaustive).toBe(true);
    expect(Object.keys(GRAPHIC_COMPONENTS).sort()).toEqual([...KINDS].sort());
  });

  it("renders a spec through its component", () => {
    const { container } = render(<Graphic spec={{ kind: "tests", passed: 14, failed: 1, skipped: 0 }} size="xs" label="14 passed, 1 failed" />);
    expect(container.querySelectorAll("circle[data-state]")).toHaveLength(15);
    const running = render(<Graphic spec={{ kind: "duration", durationMs: null, running: true, status: "running", end: "none" }} size="xs" elapsedMs={10_000} />);
    expect(running.container.querySelector('rect[data-bar="hollow"]')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/graphics/glyphs.test.tsx`
Expected: FAIL, `Failed to resolve import "./ClaimVsObserved.js"`.

- [ ] **Step 3: Write the implementation**

Append to `packages/trace-viewer/src/ui/graphics/graphics.module.css`:

```css
.branch { fill: none; stroke: var(--tv-mark); stroke-width: 1.5; stroke-linecap: round; }
.branchChosen { fill: none; stroke: var(--tv-ink-2); stroke-width: 1.5; stroke-linecap: round; }
.root { fill: var(--tv-ink-2); }

.flow {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.node {
  display: inline-flex;
  align-items: center;
  min-width: 10px;
  height: 16px;
  padding: 0 6px;
  border-radius: 4px;
  background: var(--tv-fill-2);
  color: var(--tv-ink-2);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12px;
  white-space: nowrap;
}

.nodeFocus {
  background: var(--tv-panel);
  box-shadow: inset 0 0 0 1.5px var(--tv-ink-2);
  color: var(--tv-ink);
}

.arrow { fill: none; stroke: var(--tv-mark); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }

.table {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--tv-ink-2);
}

.tableName {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12px;
}

.claim {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.bubble {
  min-width: 0;
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--tv-fill);
  color: var(--tv-ink);
  font-size: 13px;
  line-height: 18px;
}

.sm .bubble {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.md .bubble { font-size: 15px; line-height: 20px; }

.span {
  text-decoration: underline;
  text-decoration-color: var(--tv-bad);
  text-decoration-thickness: 2px;
  text-underline-offset: 3px;
}

.neq {
  display: inline-flex;
  color: var(--tv-bad);
  flex: none;
}

.observed {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  padding: 6px 10px;
  border: 0;
  border-radius: 8px;
  background: var(--tv-panel);
  box-shadow: var(--tv-shadow);
  color: var(--tv-ink);
  font: inherit;
  font-size: 12px;
  cursor: default;
}

button.observed { cursor: pointer; }
button.observed:focus-visible { outline: 2px solid var(--tv-accent); outline-offset: 2px; }

.observedFail { color: var(--tv-bad-ink); }

.mono {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12px;
  color: var(--tv-ink-2);
}
```

`packages/trace-viewer/src/ui/graphics/ForkGlyph.tsx`:

```tsx
import { memo, type JSX } from "react";

import styles from "./graphics.module.css";
import { graphicA11y, type GraphicBaseProps, type GraphicSize } from "./scales.js";

export interface ForkGlyphProps extends GraphicBaseProps {
  options: readonly { label: string; chosen: boolean }[];
  decidedBy: "supervisor" | "delegated" | "open";
}

const DIMS: Record<GraphicSize, { w: number; h: number }> = { xs: { w: 24, h: 12 }, sm: { w: 32, h: 16 }, md: { w: 40, h: 20 } };
const MAX_BRANCHES = 3;

function pickBranches(options: ForkGlyphProps["options"]): { label: string; chosen: boolean }[] {
  const shown = options.slice(0, MAX_BRANCHES);
  const chosenIndex = options.findIndex((o) => o.chosen);
  if (chosenIndex >= MAX_BRANCHES) {
    const chosen = options[chosenIndex];
    if (chosen !== undefined) shown[MAX_BRANCHES - 1] = chosen;
  }
  return shown;
}

function ForkGlyphImpl({ size, label, options, decidedBy }: ForkGlyphProps): JSX.Element {
  const { w, h } = DIMS[size];
  const branches = pickBranches(options);
  const extra = options.length - branches.length;
  const mid = h / 2;
  const step = branches.length > 1 ? (h - 3) / (branches.length - 1) : 0;
  return (
    <span className={`${styles.graphic} ${styles[size]}`} {...graphicA11y(label)}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" focusable="false">
        <circle className={styles.root} cx={2} cy={mid} r={1.75} />
        {branches.map((branch, i) => {
          const y = branches.length === 1 ? mid : 1.5 + i * step;
          const solid = decidedBy !== "open" && branch.chosen;
          return (
            <path
              key={`${branch.label}:${i}`}
              data-branch={branch.label}
              data-chosen={solid ? "true" : "false"}
              className={solid ? styles.branchChosen : styles.branch}
              strokeDasharray={solid ? undefined : "2 2"}
              d={`M3.5 ${mid}C${w / 2} ${mid} ${w / 2} ${y} ${w - 1.5} ${y}`}
            />
          );
        })}
      </svg>
      {extra > 0 ? <span className={styles.count}>{`+${extra}`}</span> : null}
    </span>
  );
}

export const ForkGlyph = memo(ForkGlyphImpl);
```

`packages/trace-viewer/src/ui/graphics/FlowGlyph.tsx`:

```tsx
import { Fragment, memo, type JSX } from "react";

import styles from "./graphics.module.css";
import { graphicA11y, type GraphicBaseProps } from "./scales.js";

export interface FlowGlyphProps extends GraphicBaseProps { nodes: readonly string[]; focus: number }

const MAX_NODES = 3;

function Arrow(): JSX.Element {
  return (
    <svg width={10} height={8} viewBox="0 0 10 8" aria-hidden="true" focusable="false">
      <path className={styles.arrow} d="M1 4h7M5.5 1.5 8 4 5.5 6.5" />
    </svg>
  );
}

function FlowGlyphImpl({ size, label, nodes, focus }: FlowGlyphProps): JSX.Element {
  const shown = nodes.slice(0, MAX_NODES);
  return (
    <span className={`${styles.graphic} ${styles[size]} ${styles.flow}`} {...graphicA11y(label)}>
      {shown.map((node, i) => (
        <Fragment key={`${node}:${i}`}>
          {i > 0 ? <Arrow /> : null}
          <span data-node={node} data-focus={i === focus ? "true" : "false"} className={i === focus ? `${styles.node} ${styles.nodeFocus}` : styles.node}>
            {size === "xs" ? "" : node}
          </span>
        </Fragment>
      ))}
      {nodes.length > MAX_NODES ? <span className={styles.count}>…</span> : null}
    </span>
  );
}

export const FlowGlyph = memo(FlowGlyphImpl);
```

The xs test above renders at `md`, so text is present; at `xs` the boxes carry no text and the row line names the files.

`packages/trace-viewer/src/ui/graphics/TableGlyph.tsx`:

```tsx
import { memo, type JSX } from "react";

import styles from "./graphics.module.css";
import { graphicA11y, type GraphicBaseProps } from "./scales.js";

export interface TableGlyphProps extends GraphicBaseProps {
  tables: readonly { name: string; role: "new" | "altered"; columns: number }[];
}

function TableGlyphImpl({ size, label, tables }: TableGlyphProps): JSX.Element {
  return (
    <span className={`${styles.graphic} ${styles[size]}`} {...graphicA11y(label)}>
      {tables.slice(0, 2).map((table) => (
        <span key={table.name} className={styles.table} data-table={table.name} data-role={table.role}>
          <svg width={14} height={12} viewBox="0 0 14 12" aria-hidden="true" focusable="false">
            <rect className={styles.hollow} x={0.75} y={0.75} width={12.5} height={10.5} rx={1.5}
              strokeDasharray={table.role === "altered" ? "2 1.5" : undefined} />
            <path className={styles.arrow} d="M0.75 4.25h12.5M5 4.25v7" />
          </svg>
          {size === "xs" ? null : <span className={styles.tableName}>{table.name}</span>}
          {size === "xs" ? null : <span className={styles.count}>{`${table.columns} cols`}</span>}
        </span>
      ))}
    </span>
  );
}

export const TableGlyph = memo(TableGlyphImpl);
```

`packages/trace-viewer/src/ui/graphics/ClaimVsObserved.tsx`:

```tsx
import { memo, type JSX, type ReactNode } from "react";

import { Icon } from "../icons/Icon.js";
import styles from "./graphics.module.css";
import { graphicA11y, type GraphicBaseProps } from "./scales.js";
import { TestDots } from "./TestDots.js";

export interface ClaimVsObservedProps extends GraphicBaseProps {
  claim: { text: string; span?: readonly [number, number]; tMs: number };
  observed: { passed: number; failed: number; command: string; tMs: number };
  onObservedClick?(): void;
}

function ClaimText({ text, span }: { text: string; span?: readonly [number, number] }): JSX.Element {
  if (span === undefined || span[0] < 0 || span[1] > text.length || span[0] >= span[1]) return <>{text}</>;
  return (
    <>
      {text.slice(0, span[0])}
      <span className={styles.span} data-claim-span="">{text.slice(span[0], span[1])}</span>
      {text.slice(span[1])}
    </>
  );
}

function ClaimVsObservedImpl({ size, label, claim, observed, onObservedClick }: ClaimVsObservedProps): JSX.Element {
  const content: ReactNode = (
    <>
      <TestDots size="xs" passed={observed.passed} failed={observed.failed} skipped={0} />
      <span className={observed.failed > 0 ? styles.observedFail : undefined}>{`${observed.failed} failed`}</span>
      <span className={styles.mono}>{observed.command}</span>
    </>
  );
  return (
    <span className={`${styles.graphic} ${styles[size]} ${styles.claim}`} {...graphicA11y(label)}>
      <span className={styles.bubble}>
        <ClaimText text={claim.text} span={claim.span} />
      </span>
      <span className={styles.neq}>
        <Icon name="neq" size={size === "md" ? 16 : 14} />
      </span>
      {onObservedClick === undefined ? (
        <span className={styles.observed}>{content}</span>
      ) : (
        <button type="button" className={styles.observed} onClick={onObservedClick}>{content}</button>
      )}
    </span>
  );
}

export const ClaimVsObserved = memo(ClaimVsObservedImpl);
```

`packages/trace-viewer/src/ui/graphics/Graphic.tsx`:

```tsx
import type { ComponentType, JSX } from "react";

import type { GraphicSpec } from "../../model/index.js";
import { ClaimVsObserved } from "./ClaimVsObserved.js";
import { DiffBar } from "./DiffBar.js";
import { DurationBar } from "./DurationBar.js";
import { FlowGlyph } from "./FlowGlyph.js";
import { ForkGlyph } from "./ForkGlyph.js";
import type { GraphicSize } from "./scales.js";
import { TableGlyph } from "./TableGlyph.js";
import { TestDots } from "./TestDots.js";

type Kind = GraphicSpec["kind"];
export interface GraphicViewProps<K extends Kind> {
  spec: Extract<GraphicSpec, { kind: K }>;
  size: GraphicSize;
  label?: string;
  elapsedMs?: number;
}

export const GRAPHIC_COMPONENTS: { readonly [K in Kind]: ComponentType<GraphicViewProps<K>> } = {
  diff: ({ spec, size, label }) => (
    <DiffBar size={size} label={label} added={spec.added} removed={spec.removed} files={spec.files} moreFiles={spec.moreFiles} />
  ),
  tests: ({ spec, size, label }) => (
    <TestDots size={size} label={label} passed={spec.passed} failed={spec.failed} skipped={spec.skipped} />
  ),
  duration: ({ spec, size, label, elapsedMs }) => (
    <DurationBar size={size} label={label} durationMs={spec.durationMs} running={spec.running} elapsedMs={elapsedMs} end={spec.end} />
  ),
  fork: ({ spec, size, label }) => <ForkGlyph size={size} label={label} options={spec.options} decidedBy={spec.decidedBy} />,
  flow: ({ spec, size, label }) => <FlowGlyph size={size} label={label} nodes={spec.nodes} focus={spec.focus} />,
  table: ({ spec, size, label }) => <TableGlyph size={size} label={label} tables={spec.tables} />,
  claim: ({ spec, size, label }) => <ClaimVsObserved size={size} label={label} claim={spec.claim} observed={spec.observed} />,
};

export function Graphic({ spec, size, label, elapsedMs }: { spec: GraphicSpec; size: GraphicSize; label?: string; elapsedMs?: number }): JSX.Element {
  const Component = GRAPHIC_COMPONENTS[spec.kind] as ComponentType<GraphicViewProps<Kind>>;
  return <Component spec={spec} size={size} label={label} elapsedMs={elapsedMs} />;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/graphics`
Expected: PASS, 3 files, 23 tests.

- [ ] **Step 5: Root checks**

```bash
pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint
```

Expected: each exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/trace-viewer/src/ui/graphics/ForkGlyph.tsx packages/trace-viewer/src/ui/graphics/FlowGlyph.tsx packages/trace-viewer/src/ui/graphics/TableGlyph.tsx packages/trace-viewer/src/ui/graphics/ClaimVsObserved.tsx packages/trace-viewer/src/ui/graphics/Graphic.tsx packages/trace-viewer/src/ui/graphics/graphics.module.css packages/trace-viewer/src/ui/graphics/glyphs.test.tsx
git commit -m "feat(trace-viewer): fork, flow, table and claim glyphs with the Graphic map"
```

**Lane C1a completion.** Rebase on `main` after B merges (`git rebase main`), run `pnpm install --frozen-lockfile && pnpm -r build`, then the root checks, then merge. C1a exports nothing through `src/index.ts`; C2 imports these modules by path.

---

# Part B: lane C1b, viewer core and spike (worktree `~/Projects/jevcode-tv-c1b`)

### Task C1-5: Pure viewport math (`uniform` and `xOnly`) with properties

**Files:**
- Create: `packages/trace-viewer/src/layout/viewport.ts`
- Test: `packages/trace-viewer/src/layout/viewport.test.ts`
- Test: `packages/trace-viewer/src/layout/viewport.property.test.ts`
- Modify: `packages/trace-viewer/src/index.ts` (W0 final form is the single line `export * from "./source.js";`)

**Interfaces:**
- Consumes: nothing.
- Produces (UI index §2.1, plus two exported constants used by `clampCamera`):

```ts
export interface Point { x: number; y: number }
export interface Size { w: number; h: number }
export interface Rect { x: number; y: number; w: number; h: number }
export interface UniformCamera { mode: "uniform"; tx: number; ty: number; k: number }
export interface XOnlyCamera { mode: "xOnly"; u0: number; k: number }
export type Camera = UniformCamera | XOnlyCamera;
export interface ZoomLimits { minK: number; maxK: number }
export const TWEEN_MS = 180;
export const WHEEL_ZOOM_RATE = 0.02;
export const WHEEL_ZOOM_MIN = 0.8;
export const WHEEL_ZOOM_MAX = 1.25;
export const WHEEL_LINE_PX = 16;
export const CLAMP_KEEP_PX = 64;   // uniform: screen px of content that stays reachable
export const CLAMP_PAD_PX = 24;    // xOnly: screen px of padding past either end
export function worldToScreen(camera: UniformCamera, world: Point): Point;
export function screenToWorld(camera: UniformCamera, screen: Point): Point;
export function uToScreenX(camera: XOnlyCamera, u: number): number;
export function screenXToU(camera: XOnlyCamera, x: number): number;
export function zoomAt<C extends Camera>(camera: C, anchor: Point, factor: number, limits: ZoomLimits): C;
export function panBy<C extends Camera>(camera: C, dx: number, dy: number): C;
export function fitBounds(bounds: Rect, viewport: Size, options: { padding: number; limits: ZoomLimits }): UniformCamera;
export function fitRange(u0: number, u1: number, widthPx: number, options: { padFraction: number; limits: ZoomLimits }): XOnlyCamera;
export function setCenter(camera: UniformCamera, world: Point, viewport: Size): UniformCamera;
export function clampCamera<C extends Camera>(camera: C, content: Rect, viewport: Size, limits: ZoomLimits): C;
export function isInsideInset(camera: UniformCamera, rect: Rect, viewport: Size, inset: number): boolean;
export function easeOutCubic(t: number): number;
export function tweenCamera<C extends Camera>(from: C, to: C, t: number): C;
export function wheelZoomFactor(deltaY: number, deltaMode: 0 | 1 | 2, pageHeight: number): number;
```

- [ ] **Step 1: Write the failing tests**

`packages/trace-viewer/src/layout/viewport.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  clampCamera, fitBounds, fitRange, isInsideInset, panBy, screenToWorld, setCenter, tweenCamera,
  wheelZoomFactor, worldToScreen, zoomAt, type UniformCamera, type XOnlyCamera,
} from "./viewport.js";

const WIDE = { minK: 0.01, maxK: 100 };

describe("viewport math", () => {
  it("maps world to screen as world · k + t and back", () => {
    const cam: UniformCamera = { mode: "uniform", tx: 10, ty: 20, k: 2 };
    expect(worldToScreen(cam, { x: 5, y: 5 })).toEqual({ x: 20, y: 30 });
    expect(screenToWorld(cam, { x: 20, y: 30 })).toEqual({ x: 5, y: 5 });
  });

  it("zoomAt keeps the world point under the cursor and clamps k", () => {
    const cam: UniformCamera = { mode: "uniform", tx: 0, ty: 0, k: 1 };
    const next = zoomAt(cam, { x: 200, y: 100 }, 2, WIDE);
    expect(next.k).toBe(2);
    expect(worldToScreen(next, { x: 200, y: 100 })).toEqual({ x: 200, y: 100 });
    expect(zoomAt(cam, { x: 0, y: 0 }, 1_000, { minK: 0.5, maxK: 4 }).k).toBe(4);
  });

  it("xOnly zoom keeps u under the cursor; pan ignores dy", () => {
    const cam: XOnlyCamera = { mode: "xOnly", u0: 1_000, k: 0.1 };
    const next = zoomAt(cam, { x: 50, y: 999 }, 2, WIDE);
    expect(next).toEqual({ mode: "xOnly", u0: 1_250, k: 0.2 });
    expect(panBy(cam, 20, 500)).toEqual({ mode: "xOnly", u0: 800, k: 0.1 });
  });

  it("fitBounds centers the box inside the padded viewport", () => {
    const cam = fitBounds({ x: 0, y: 0, w: 1_000, h: 500 }, { w: 1_200, h: 800 }, { padding: 100, limits: WIDE });
    expect(cam).toEqual({ mode: "uniform", k: 1, tx: 100, ty: 150 });
  });

  it("fitBounds on a 0x0 viewport stays finite", () => {
    const cam = fitBounds({ x: 10, y: 10, w: 1_000, h: 500 }, { w: 0, h: 0 }, { padding: 48, limits: { minK: 0.1, maxK: 2 } });
    expect(cam.k).toBe(0.1);
    expect(Number.isFinite(cam.tx) && Number.isFinite(cam.ty)).toBe(true);
  });

  it("fitRange covers the span edge to edge without padding", () => {
    const cam = fitRange(0, 45_000, 1_000, { padFraction: 0, limits: { minK: 1e-6, maxK: 0.4 } });
    expect(cam.k).toBeCloseTo(1_000 / 45_000, 12);
    expect(cam.u0).toBeCloseTo(0, 9);
  });

  it("setCenter centers a world point at the current k", () => {
    const cam = setCenter({ mode: "uniform", tx: 0, ty: 0, k: 2 }, { x: 100, y: 50 }, { w: 800, h: 600 });
    expect(worldToScreen(cam, { x: 100, y: 50 })).toEqual({ x: 400, y: 300 });
  });

  it("clampCamera keeps content reachable and keeps an xOnly range inside its padding", () => {
    const content = { x: 0, y: 0, w: 2_000, h: 1_000 };
    const far = clampCamera({ mode: "uniform", tx: 5_000, ty: -9_000, k: 1 } as UniformCamera, content, { w: 800, h: 600 }, WIDE);
    expect(far.tx).toBe(800 - 64);
    expect(far.ty).toBe(64 - 1_000);
    const limitsX = { minK: 1e-4, maxK: 100 };
    const x = clampCamera({ mode: "xOnly", u0: 90_000, k: 0.05 } as XOnlyCamera, { x: 0, y: 0, w: 45_000, h: 0 }, { w: 1_000, h: 288 }, limitsX);
    expect(x.u0).toBeCloseTo(45_000 + 24 / 0.05 - 1_000 / 0.05, 9);
    const wide = clampCamera({ mode: "xOnly", u0: 5, k: 0.001 } as XOnlyCamera, { x: 0, y: 0, w: 45_000, h: 0 }, { w: 1_000, h: 288 }, limitsX);
    expect(wide.u0).toBeCloseTo(22_500 - 500 / 0.001, 6);
  });

  it("isInsideInset checks the screen rect against the inset viewport", () => {
    const cam: UniformCamera = { mode: "uniform", tx: 0, ty: 0, k: 1 };
    expect(isInsideInset(cam, { x: 48, y: 48, w: 100, h: 100 }, { w: 800, h: 600 }, 48)).toBe(true);
    expect(isInsideInset(cam, { x: 40, y: 48, w: 100, h: 100 }, { w: 800, h: 600 }, 48)).toBe(false);
  });

  it("tweens translation linearly in eased t and k geometrically", () => {
    const a: UniformCamera = { mode: "uniform", tx: 0, ty: 0, k: 1 };
    const b: UniformCamera = { mode: "uniform", tx: 100, ty: -100, k: 4 };
    expect(tweenCamera(a, b, 0)).toBe(a);
    expect(tweenCamera(a, b, 1)).toBe(b);
    const t = 1 - Math.cbrt(0.5);
    const mid = tweenCamera(a, b, t);
    expect(mid.k).toBeCloseTo(2, 9);
    expect(mid.tx).toBeCloseTo(50, 9);
  });

  it("wheelZoomFactor is 2^(−deltaY·0.02) and clamps line-mode deltas", () => {
    expect(wheelZoomFactor(-10, 0, 800)).toBeCloseTo(2 ** 0.2, 12);
    expect(wheelZoomFactor(100, 0, 800)).toBe(0.8);
    expect(wheelZoomFactor(-3, 1, 800)).toBe(1.25);
    expect(wheelZoomFactor(1, 2, 800)).toBe(0.8);
    expect(wheelZoomFactor(0, 0, 800)).toBe(1);
  });
});
```

`packages/trace-viewer/src/layout/viewport.property.test.ts`:

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  fitBounds, screenToWorld, screenXToU, tweenCamera, uToScreenX, wheelZoomFactor, worldToScreen, zoomAt,
  type UniformCamera, type XOnlyCamera,
} from "./viewport.js";

const LIMITS = { minK: 1e-3, maxK: 1e3 };
const num = (min: number, max: number) => fc.double({ min, max, noNaN: true, noDefaultInfinity: true });
const uniform = fc.record({ tx: num(-1e4, 1e4), ty: num(-1e4, 1e4), k: num(0.01, 10) })
  .map((c): UniformCamera => ({ mode: "uniform", ...c }));
const xOnly = fc.record({ u0: num(-1e6, 1e6), k: num(1e-4, 0.4) }).map((c): XOnlyCamera => ({ mode: "xOnly", ...c }));
const point = fc.record({ x: num(0, 2_000), y: num(0, 1_200) });

describe("viewport properties", () => {
  it("zoomAt keeps the world point under the anchor (uniform)", () => {
    fc.assert(fc.property(uniform, point, num(0.5, 2), (cam, anchor, factor) => {
      const world = screenToWorld(cam, anchor);
      const after = worldToScreen(zoomAt(cam, anchor, factor, LIMITS), world);
      expect(after.x).toBeCloseTo(anchor.x, 6);
      expect(after.y).toBeCloseTo(anchor.y, 6);
    }));
  });

  it("zoomAt keeps u under the anchor (xOnly)", () => {
    fc.assert(fc.property(xOnly, point, num(0.5, 2), (cam, anchor, factor) => {
      const u = screenXToU(cam, anchor.x);
      const next = zoomAt(cam, anchor, factor, { minK: 1e-6, maxK: 10 });
      expect(uToScreenX(next, u)).toBeCloseTo(anchor.x, 6);
    }));
  });

  it("screenToWorld inverts worldToScreen", () => {
    fc.assert(fc.property(uniform, point, (cam, p) => {
      const back = screenToWorld(cam, worldToScreen(cam, p));
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
    }));
  });

  it("fitBounds shows the whole box inside the padding", () => {
    const box = fc.record({ x: num(-5_000, 5_000), y: num(-5_000, 5_000), w: num(1, 20_000), h: num(1, 20_000) });
    const view = fc.record({ w: num(200, 3_000), h: num(200, 2_000) });
    fc.assert(fc.property(box, view, num(0, 80), (b, v, padding) => {
      const cam = fitBounds(b, v, { padding, limits: { minK: 1e-9, maxK: 1e9 } });
      const tl = worldToScreen(cam, { x: b.x, y: b.y });
      const br = worldToScreen(cam, { x: b.x + b.w, y: b.y + b.h });
      expect(tl.x).toBeGreaterThanOrEqual(padding - 1e-6);
      expect(tl.y).toBeGreaterThanOrEqual(padding - 1e-6);
      expect(br.x).toBeLessThanOrEqual(v.w - padding + 1e-6);
      expect(br.y).toBeLessThanOrEqual(v.h - padding + 1e-6);
    }));
  });

  it("tweenCamera starts at from and ends at to", () => {
    fc.assert(fc.property(uniform, uniform, (a, b) => {
      expect(tweenCamera(a, b, 0)).toEqual(a);
      expect(tweenCamera(a, b, 1)).toEqual(b);
    }));
  });

  it("wheelZoomFactor stays in [0.8, 1.25]", () => {
    fc.assert(fc.property(num(-1e6, 1e6), fc.constantFrom(0 as const, 1 as const, 2 as const), num(1, 4_000), (dy, mode, page) => {
      const f = wheelZoomFactor(dy, mode, page);
      expect(f).toBeGreaterThanOrEqual(0.8);
      expect(f).toBeLessThanOrEqual(1.25);
    }));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/viewport.test.ts src/layout/viewport.property.test.ts`
Expected: FAIL, `Failed to resolve import "./viewport.js"`.

- [ ] **Step 3: Write the implementation**

`packages/trace-viewer/src/layout/viewport.ts`:

```ts
export interface Point { x: number; y: number }
export interface Size { w: number; h: number }
export interface Rect { x: number; y: number; w: number; h: number }
export interface UniformCamera { mode: "uniform"; tx: number; ty: number; k: number }
export interface XOnlyCamera { mode: "xOnly"; u0: number; k: number }
export type Camera = UniformCamera | XOnlyCamera;
export interface ZoomLimits { minK: number; maxK: number }

export const TWEEN_MS = 180;
export const WHEEL_ZOOM_RATE = 0.02;
export const WHEEL_ZOOM_MIN = 0.8;
export const WHEEL_ZOOM_MAX = 1.25;
export const WHEEL_LINE_PX = 16;
/** Uniform clamp: at least this many screen px of content stay inside the viewport. */
export const CLAMP_KEEP_PX = 64;
/** xOnly clamp: the visible range may run this many screen px past either end of the content. */
export const CLAMP_PAD_PX = 24;

const clamp = (lo: number, hi: number, value: number): number => Math.min(hi, Math.max(lo, value));
const clampK = (k: number, limits: ZoomLimits): number => clamp(limits.minK, limits.maxK, k);

/** screen = world · k + t */
export function worldToScreen(camera: UniformCamera, world: Point): Point {
  return { x: world.x * camera.k + camera.tx, y: world.y * camera.k + camera.ty };
}

export function screenToWorld(camera: UniformCamera, screen: Point): Point {
  return { x: (screen.x - camera.tx) / camera.k, y: (screen.y - camera.ty) / camera.k };
}

/** x = (u − u0) · k */
export function uToScreenX(camera: XOnlyCamera, u: number): number {
  return (u - camera.u0) * camera.k;
}

export function screenXToU(camera: XOnlyCamera, x: number): number {
  return x / camera.k + camera.u0;
}

/** Keeps the world point (uniform) or u (xOnly) under `anchor` fixed; k clamped to limits. */
export function zoomAt<C extends Camera>(camera: C, anchor: Point, factor: number, limits: ZoomLimits): C {
  const cam = camera as Camera;
  const k = clampK(cam.k * factor, limits);
  if (cam.mode === "uniform") {
    const world = screenToWorld(cam, anchor);
    return { mode: "uniform", k, tx: anchor.x - world.x * k, ty: anchor.y - world.y * k } as C;
  }
  const u = screenXToU(cam, anchor.x);
  return { mode: "xOnly", k, u0: u - anchor.x / k } as C;
}

/** xOnly ignores dy. */
export function panBy<C extends Camera>(camera: C, dx: number, dy: number): C {
  const cam = camera as Camera;
  if (cam.mode === "uniform") return { ...cam, tx: cam.tx + dx, ty: cam.ty + dy } as C;
  return { ...cam, u0: cam.u0 - dx / cam.k } as C;
}

export function fitBounds(bounds: Rect, viewport: Size, options: { padding: number; limits: ZoomLimits }): UniformCamera {
  const availW = Math.max(0, viewport.w - 2 * options.padding);
  const availH = Math.max(0, viewport.h - 2 * options.padding);
  const kx = bounds.w > 0 ? availW / bounds.w : Number.POSITIVE_INFINITY;
  const ky = bounds.h > 0 ? availH / bounds.h : Number.POSITIVE_INFINITY;
  const raw = Math.min(kx, ky);
  const k = clampK(Number.isFinite(raw) ? raw : options.limits.maxK, options.limits);
  return {
    mode: "uniform",
    k,
    tx: (viewport.w - bounds.w * k) / 2 - bounds.x * k,
    ty: (viewport.h - bounds.h * k) / 2 - bounds.y * k,
  };
}

export function fitRange(u0: number, u1: number, widthPx: number, options: { padFraction: number; limits: ZoomLimits }): XOnlyCamera {
  const span = Math.max(u1 - u0, 1e-9);
  const width = Math.max(0, widthPx);
  const k = Math.max(1e-12, clampK(width / (span * (1 + 2 * options.padFraction)), options.limits));
  return { mode: "xOnly", k, u0: (u0 + u1) / 2 - width / (2 * k) };
}

/** Centers `world` at the current k. */
export function setCenter(camera: UniformCamera, world: Point, viewport: Size): UniformCamera {
  return { ...camera, tx: viewport.w / 2 - world.x * camera.k, ty: viewport.h / 2 - world.y * camera.k };
}

/** Clamps k to limits (keeping the viewport center) and translation so `content` stays reachable. */
export function clampCamera<C extends Camera>(camera: C, content: Rect, viewport: Size, limits: ZoomLimits): C {
  const cam = camera as Camera;
  const k = clampK(cam.k, limits);
  if (cam.mode === "uniform") {
    const center = screenToWorld(cam, { x: viewport.w / 2, y: viewport.h / 2 });
    const tx0 = viewport.w / 2 - center.x * k;
    const ty0 = viewport.h / 2 - center.y * k;
    const mx = Math.max(0, Math.min(CLAMP_KEEP_PX, content.w * k, viewport.w));
    const my = Math.max(0, Math.min(CLAMP_KEEP_PX, content.h * k, viewport.h));
    const tx = clamp(mx - (content.x + content.w) * k, viewport.w - mx - content.x * k, tx0);
    const ty = clamp(my - (content.y + content.h) * k, viewport.h - my - content.y * k, ty0);
    return { mode: "uniform", k, tx, ty } as C;
  }
  const centerU = cam.u0 + viewport.w / 2 / cam.k;
  const u0 = centerU - viewport.w / (2 * k);
  const pad = CLAMP_PAD_PX / k;
  const lo = content.x - pad;
  const hi = content.x + content.w + pad - viewport.w / k;
  if (hi < lo) return { mode: "xOnly", k, u0: content.x + content.w / 2 - viewport.w / (2 * k) } as C;
  return { mode: "xOnly", k, u0: clamp(lo, hi, u0) } as C;
}

/** True when `rect` (world) lies inside the viewport inset by `inset` px. */
export function isInsideInset(camera: UniformCamera, rect: Rect, viewport: Size, inset: number): boolean {
  const tl = worldToScreen(camera, { x: rect.x, y: rect.y });
  const br = worldToScreen(camera, { x: rect.x + rect.w, y: rect.y + rect.h });
  return tl.x >= inset && tl.y >= inset && br.x <= viewport.w - inset && br.y <= viewport.h - inset;
}

export function easeOutCubic(t: number): number {
  const c = clamp(0, 1, t);
  return 1 - (1 - c) ** 3;
}

/** t ∈ [0, 1]; translation linear in eased t, k geometric. */
export function tweenCamera<C extends Camera>(from: C, to: C, t: number): C {
  if (t <= 0) return from;
  if (t >= 1) return to;
  const a = from as Camera;
  const b = to as Camera;
  const e = easeOutCubic(t);
  const k = a.k * (b.k / a.k) ** e;
  if (a.mode === "uniform" && b.mode === "uniform") {
    return { mode: "uniform", k, tx: a.tx + (b.tx - a.tx) * e, ty: a.ty + (b.ty - a.ty) * e } as C;
  }
  if (a.mode === "xOnly" && b.mode === "xOnly") return { mode: "xOnly", k, u0: a.u0 + (b.u0 - a.u0) * e } as C;
  return to;
}

/** 2^(−deltaY · 0.02), line mode ×16, page mode ×viewportHeight, clamped to [0.8, 1.25]. */
export function wheelZoomFactor(deltaY: number, deltaMode: 0 | 1 | 2, pageHeight: number): number {
  const px = deltaMode === 1 ? deltaY * WHEEL_LINE_PX : deltaMode === 2 ? deltaY * pageHeight : deltaY;
  return clamp(WHEEL_ZOOM_MIN, WHEEL_ZOOM_MAX, 2 ** (-px * WHEEL_ZOOM_RATE));
}
```

Modify `packages/trace-viewer/src/index.ts`. Current content (W0-6 final):

```ts
export * from "./source.js";
```

New content:

```ts
export * from "./source.js";
export * from "./layout/viewport.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/viewport.test.ts src/layout/viewport.property.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Root checks**

```bash
pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint
```

Expected: each exits 0 (the layout lint block rejects any DOM global or timer here).

- [ ] **Step 6: Commit**

```bash
git add packages/trace-viewer/src/layout/viewport.ts packages/trace-viewer/src/layout/viewport.test.ts packages/trace-viewer/src/layout/viewport.property.test.ts packages/trace-viewer/src/index.ts
git commit -m "feat(trace-viewer): pure uniform and xOnly viewport math"
```

### Task C1-6: Viewport controller (native wheel, pointer pan, rAF writes, settle, tween)

**Files:**
- Create: `packages/trace-viewer/src/ui/viewport/controller.ts`
- Test: `packages/trace-viewer/src/ui/viewport/controller.test.ts`
- Modify: `packages/trace-viewer/src/index.ts`

**Interfaces:**
- Consumes (C1-5): `clampCamera`, `panBy`, `zoomAt`, `tweenCamera`, `wheelZoomFactor`, `TWEEN_MS`, `WHEEL_LINE_PX`, `type Camera`, `type Point`, `type Rect`, `type Size`, `type ZoomLimits` from `../../layout/viewport.js`.
- Produces (UI index §2.1, verbatim, plus one optional option and one export that C1-7F uses):

```ts
export const SETTLE_MS = 150;
export type FramePhase = "gesture" | "tween" | "settle";
export interface ViewportControllerOptions<C extends Camera> {
  element: HTMLElement;
  initial: C;
  limits(): ZoomLimits;
  viewport(): Size;
  content(): Rect;
  onFrame(camera: C, phase: FramePhase): void;
  onGestureStart?(kind: "pan" | "zoom"): void;
  onGestureEnd?(camera: C): void;
  isHandTool(): boolean;
  reducedMotion(): boolean;
  settleRoundK?: number | null;
  raf?(callback: FrameRequestCallback): number;
  cancelRaf?(handle: number): void;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  /** Internal (C1-7F): false leaves Ctrl/Meta+wheel zoom to another handler; the event is still prevented. Default true. */
  wheelZoom?: boolean;
}
export interface ViewportController<C extends Camera> {
  get(): C;
  set(camera: C, options?: { animate?: boolean }): Promise<void>;
  zoomBy(factor: number, anchor?: Point): void;
  panBy(dx: number, dy: number): void;
  isGesturing(): boolean;
  destroy(): void;
}
/** Internal: the controller plus a gesture-time camera write, for the d3-zoom fallback (C1-7F). */
export interface ViewportCore<C extends Camera> extends ViewportController<C> { gestureTo(camera: C, kind: "pan" | "zoom"): void }
export function createViewportCore<C extends Camera>(options: ViewportControllerOptions<C>): ViewportCore<C>;
export function createViewportController<C extends Camera>(options: ViewportControllerOptions<C>): ViewportController<C>;
```

- [ ] **Step 1: Write the failing test**

`packages/trace-viewer/src/ui/viewport/controller.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { UniformCamera } from "../../layout/viewport.js";
import { createViewportController, SETTLE_MS, type FramePhase, type ViewportController } from "./controller.js";

interface Harness {
  element: HTMLDivElement;
  onFrame: Mock<(camera: UniformCamera, phase: FramePhase) => void>;
  onGestureEnd: Mock<(camera: UniformCamera) => void>;
  onGestureStart: Mock<(kind: "pan" | "zoom") => void>;
  flush(dt?: number): void;
  controller: ViewportController<UniformCamera>;
  state: { hand: boolean; reduced: boolean };
}

function setup(options: { settleRoundK?: number } = {}): Harness {
  const element = document.createElement("div");
  document.body.append(element);
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON: () => ({}),
  } as DOMRect);
  const queue: FrameRequestCallback[] = [];
  let now = 0;
  const state = { hand: false, reduced: false };
  const onFrame = vi.fn<(camera: UniformCamera, phase: FramePhase) => void>();
  const onGestureEnd = vi.fn<(camera: UniformCamera) => void>();
  const onGestureStart = vi.fn<(kind: "pan" | "zoom") => void>();
  const controller = createViewportController<UniformCamera>({
    element,
    initial: { mode: "uniform", tx: 0, ty: 0, k: 1 },
    limits: () => ({ minK: 0.1, maxK: 4 }),
    viewport: () => ({ w: 800, h: 600 }),
    content: () => ({ x: 0, y: 0, w: 2_000, h: 1_500 }),
    onFrame,
    onGestureStart,
    onGestureEnd,
    isHandTool: () => state.hand,
    reducedMotion: () => state.reduced,
    settleRoundK: options.settleRoundK ?? null,
    raf: (cb) => { queue.push(cb); return queue.length; },
    cancelRaf: () => { queue.length = 0; },
    setTimer: (cb, ms) => setTimeout(cb, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  const flush = (dt = 16): void => {
    now += dt;
    for (const cb of queue.splice(0)) cb(now);
  };
  return { element, onFrame, onGestureEnd, onGestureStart, flush, controller, state };
}

function wheel(element: HTMLElement, init: WheelEventInit): WheelEvent {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  element.dispatchEvent(event);
  return event;
}

function pointer(element: HTMLElement, type: string, init: MouseEventInit & { pointerId?: number }): void {
  const Ctor = (globalThis as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
  element.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, ...init }));
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("viewport controller", () => {
  it("a Ctrl+wheel is prevented and zooms at the cursor, written once per frame", () => {
    const h = setup();
    const event = wheel(h.element, { deltaY: -10, ctrlKey: true, clientX: 200, clientY: 100 });
    expect(event.defaultPrevented).toBe(true);
    expect(h.onFrame).not.toHaveBeenCalled();
    h.flush();
    expect(h.onFrame).toHaveBeenCalledTimes(1);
    const [camera, phase] = h.onFrame.mock.calls[0] ?? [];
    expect(phase).toBe("gesture");
    expect(camera?.k).toBeCloseTo(2 ** 0.2, 12);
    expect(camera?.tx).toBeCloseTo(200 - 200 * 2 ** 0.2, 9);
    expect(h.onGestureStart).toHaveBeenCalledWith("zoom");
  });

  it("a Meta+wheel (trackpad pinch on macOS) also zooms", () => {
    const h = setup();
    wheel(h.element, { deltaY: 5, metaKey: true, clientX: 0, clientY: 0 });
    h.flush();
    expect(h.controller.get().k).toBeCloseTo(2 ** -0.1, 12);
  });

  it("a plain wheel pans and keeps k", () => {
    const h = setup();
    wheel(h.element, { deltaX: 12, deltaY: 30 });
    h.flush();
    expect(h.controller.get()).toEqual({ mode: "uniform", tx: -12, ty: -30, k: 1 });
    expect(h.onGestureStart).toHaveBeenCalledWith("pan");
  });

  it("line-mode wheel pans 16 px per line", () => {
    const h = setup();
    wheel(h.element, { deltaY: 2, deltaMode: 1 });
    h.flush();
    expect(h.controller.get().ty).toBe(-32);
  });

  it("two wheel events in one frame produce one onFrame", () => {
    const h = setup();
    wheel(h.element, { deltaY: 10 });
    wheel(h.element, { deltaY: 10 });
    h.flush();
    expect(h.onFrame).toHaveBeenCalledTimes(1);
    expect(h.controller.get().ty).toBe(-20);
  });

  it("settle fires once 150 ms after the last input with whole-pixel translation", () => {
    const h = setup();
    wheel(h.element, { deltaY: 10.4 });
    h.flush();
    vi.advanceTimersByTime(100);
    wheel(h.element, { deltaY: 0.3 });
    h.flush();
    vi.advanceTimersByTime(SETTLE_MS - 1);
    expect(h.onGestureEnd).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.onGestureEnd).toHaveBeenCalledTimes(1);
    expect(h.onGestureEnd.mock.calls[0]?.[0]).toEqual({ mode: "uniform", tx: 0, ty: -11, k: 1 });
    expect(h.onFrame.mock.calls.at(-1)?.[1]).toBe("settle");
    expect(h.controller.isGesturing()).toBe(false);
  });

  it("settle rounds k to a 1/n grid when settleRoundK is set", () => {
    const h = setup({ settleRoundK: 64 });
    wheel(h.element, { deltaY: -7, ctrlKey: true, clientX: 300, clientY: 200 });
    h.flush();
    vi.advanceTimersByTime(SETTLE_MS);
    const k = h.controller.get().k;
    expect(Number.isInteger(k * 64)).toBe(true);
  });

  it("an animated set under reduced motion arrives in one frame", async () => {
    const h = setup();
    h.state.reduced = true;
    const target: UniformCamera = { mode: "uniform", tx: 100, ty: 50, k: 2 };
    const done = h.controller.set(target, { animate: true });
    h.flush();
    await done;
    expect(h.onFrame).toHaveBeenLastCalledWith(target, "tween");
  });

  it("an animated set takes TWEEN_MS and a newer set supersedes it", async () => {
    const h = setup();
    const first = h.controller.set({ mode: "uniform", tx: 100, ty: 0, k: 1 }, { animate: true });
    h.flush(16);
    h.flush(16);
    expect(h.controller.get().tx).toBeGreaterThan(0);
    expect(h.controller.get().tx).toBeLessThan(100);
    const second = h.controller.set({ mode: "uniform", tx: -50, ty: 0, k: 1 });
    await first;
    h.flush();
    await second;
    expect(h.controller.get().tx).toBe(-50);
  });

  it("the hand tool drags to pan; middle drag pans without it", () => {
    const h = setup();
    pointer(h.element, "pointerdown", { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    pointer(h.element, "pointermove", { clientX: 30, clientY: 40, pointerId: 1 });
    h.flush();
    expect(h.controller.get().tx).toBe(0);
    h.state.hand = true;
    pointer(h.element, "pointerdown", { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    pointer(h.element, "pointermove", { clientX: 30, clientY: 40, pointerId: 1 });
    pointer(h.element, "pointerup", { clientX: 30, clientY: 40, pointerId: 1 });
    h.flush();
    expect(h.controller.get()).toMatchObject({ tx: 20, ty: 30 });
    h.state.hand = false;
    pointer(h.element, "pointerdown", { button: 1, clientX: 0, clientY: 0, pointerId: 2 });
    pointer(h.element, "pointermove", { clientX: -5, clientY: 0, pointerId: 2 });
    h.flush();
    expect(h.controller.get().tx).toBe(15);
  });

  it("destroy removes the wheel listener and stops frames", () => {
    const h = setup();
    const remove = vi.spyOn(h.element, "removeEventListener");
    h.controller.destroy();
    expect(remove.mock.calls.some(([type]) => type === "wheel")).toBe(true);
    wheel(h.element, { deltaY: 10 });
    h.flush();
    expect(h.onFrame).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/viewport/controller.test.ts`
Expected: FAIL, `Failed to resolve import "./controller.js"`.

- [ ] **Step 3: Write the implementation**

`packages/trace-viewer/src/ui/viewport/controller.ts`:

```ts
import {
  clampCamera, panBy as panCamera, TWEEN_MS, tweenCamera, WHEEL_LINE_PX, wheelZoomFactor, zoomAt,
  type Camera, type Point, type Rect, type Size, type ZoomLimits,
} from "../../layout/viewport.js";

export const SETTLE_MS = 150;
export type FramePhase = "gesture" | "tween" | "settle";

export interface ViewportControllerOptions<C extends Camera> {
  /** Receives wheel and pointer input. */
  element: HTMLElement;
  initial: C;
  limits(): ZoomLimits;
  viewport(): Size;
  content(): Rect;
  /** One call per animation frame while the camera changed; the view writes transforms directly. */
  onFrame(camera: C, phase: FramePhase): void;
  onGestureStart?(kind: "pan" | "zoom"): void;
  /** After settle: translation rounded to whole CSS px. */
  onGestureEnd?(camera: C): void;
  /** Hand tool active or Space held. */
  isHandTool(): boolean;
  reducedMotion(): boolean;
  /** Spike risk 3 ruling: round k to a 1/n grid at settle (null = off). */
  settleRoundK?: number | null;
  /** Test seams; default window.requestAnimationFrame / cancelAnimationFrame / setTimeout / clearTimeout. */
  raf?(callback: FrameRequestCallback): number;
  cancelRaf?(handle: number): void;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  /** Internal (C1-7F): false leaves Ctrl/Meta+wheel zoom to another handler; the event is still prevented. */
  wheelZoom?: boolean;
}

export interface ViewportController<C extends Camera> {
  get(): C;
  /** Animated moves take TWEEN_MS (0 under reduced motion); resolves when the camera arrives or is superseded. */
  set(camera: C, options?: { animate?: boolean }): Promise<void>;
  zoomBy(factor: number, anchor?: Point): void;
  panBy(dx: number, dy: number): void;
  isGesturing(): boolean;
  destroy(): void;
}

export interface ViewportCore<C extends Camera> extends ViewportController<C> {
  /** Gesture-time camera write: clamps, schedules one frame, re-arms settle. */
  gestureTo(camera: C, kind: "pan" | "zoom"): void;
}

interface Tween<C> { from: C; to: C; start: number | null; duration: number; resolve(): void }

export function createViewportCore<C extends Camera>(options: ViewportControllerOptions<C>): ViewportCore<C> {
  const raf = options.raf ?? ((cb: FrameRequestCallback) => window.requestAnimationFrame(cb));
  const cancelRaf = options.cancelRaf ?? ((handle: number) => window.cancelAnimationFrame(handle));
  const setTimer = options.setTimer ?? ((cb: () => void, ms: number) => window.setTimeout(cb, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => window.clearTimeout(handle as number));
  const { element } = options;
  const wheelZoom = options.wheelZoom ?? true;

  let camera: C = options.initial;
  let frameHandle: number | null = null;
  let phase: FramePhase = "gesture";
  let gesturing = false;
  let settleHandle: unknown = null;
  let tween: Tween<C> | null = null;
  let drag: { pointerId: number; x: number; y: number } | null = null;
  let destroyed = false;

  const clampToContent = (next: C): C => clampCamera(next, options.content(), options.viewport(), options.limits());

  function schedule(next: FramePhase): void {
    if (destroyed) return;
    phase = next;
    if (frameHandle === null) frameHandle = raf(onAnimationFrame);
  }

  function onAnimationFrame(now: number): void {
    frameHandle = null;
    if (destroyed) return;
    if (tween !== null) {
      const current = tween;
      if (current.start === null) current.start = now;
      const t = current.duration <= 0 ? 1 : (now - current.start) / current.duration;
      camera = tweenCamera(current.from, current.to, t);
      if (t >= 1) tween = null;
      options.onFrame(camera, "tween");
      if (t >= 1) current.resolve();
      else schedule("tween");
      return;
    }
    options.onFrame(camera, phase);
  }

  function supersedeTween(): void {
    if (tween === null) return;
    const current = tween;
    tween = null;
    current.resolve();
  }

  function beginGesture(kind: "pan" | "zoom"): void {
    supersedeTween();
    if (!gesturing) {
      gesturing = true;
      options.onGestureStart?.(kind);
    }
  }

  function armSettle(): void {
    if (settleHandle !== null) clearTimer(settleHandle);
    settleHandle = setTimer(settle, SETTLE_MS);
  }

  function roundCamera(value: C): C {
    const cam = value as Camera;
    if (cam.mode === "xOnly") return { ...cam, u0: Math.round(cam.u0 * cam.k) / cam.k } as C;
    let next = cam;
    const n = options.settleRoundK ?? null;
    if (n !== null && n > 0) {
      const k = Math.round(cam.k * n) / n;
      if (k > 0 && k !== cam.k) {
        const v = options.viewport();
        next = zoomAt(cam, { x: v.w / 2, y: v.h / 2 }, k / cam.k, { minK: k, maxK: k });
      }
    }
    return { ...next, tx: Math.round(next.tx), ty: Math.round(next.ty) } as C;
  }

  function settle(): void {
    settleHandle = null;
    if (destroyed || drag !== null) return;
    if (frameHandle !== null) {
      cancelRaf(frameHandle);
      frameHandle = null;
    }
    camera = roundCamera(camera);
    gesturing = false;
    options.onFrame(camera, "settle");
    options.onGestureEnd?.(camera);
  }

  function gestureTo(next: C, kind: "pan" | "zoom"): void {
    if (destroyed) return;
    beginGesture(kind);
    camera = clampToContent(next);
    schedule("gesture");
    armSettle();
  }

  function localPoint(clientX: number, clientY: number): Point {
    const rect = element.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    if (destroyed) return;
    const viewport = options.viewport();
    if (event.ctrlKey || event.metaKey) {
      if (!wheelZoom) return;
      const factor = wheelZoomFactor(event.deltaY, event.deltaMode as 0 | 1 | 2, viewport.h);
      gestureTo(zoomAt(camera, localPoint(event.clientX, event.clientY), factor, options.limits()), "zoom");
      return;
    }
    const scale = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? viewport.h : 1;
    let dx = event.deltaX * scale;
    let dy = event.deltaY * scale;
    if (event.shiftKey && dx === 0) {
      dx = dy;
      dy = 0;
    }
    gestureTo(panCamera(camera, -dx, -dy), "pan");
  }

  function onPointerDown(event: PointerEvent): void {
    const pans = event.button === 1 || (event.button === 0 && options.isHandTool());
    if (!pans || destroyed) return;
    event.preventDefault();
    beginGesture("pan");
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    if (settleHandle !== null) {
      clearTimer(settleHandle);
      settleHandle = null;
    }
    if (typeof element.setPointerCapture === "function") {
      try {
        element.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic events carry no active pointer; panning still works without capture.
      }
    }
  }

  function onPointerMove(event: PointerEvent): void {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    camera = clampToContent(panCamera(camera, dx, dy));
    schedule("gesture");
  }

  function onPointerUp(event: PointerEvent): void {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    if (typeof element.releasePointerCapture === "function") {
      try {
        element.releasePointerCapture(event.pointerId);
      } catch {
        // Capture was never taken (synthetic events).
      }
    }
    drag = null;
    armSettle();
  }

  const wheelOptions: AddEventListenerOptions = { passive: false };
  element.addEventListener("wheel", onWheel, wheelOptions);
  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerup", onPointerUp);
  element.addEventListener("pointercancel", onPointerUp);

  return {
    get: () => camera,
    set(next, setOptions) {
      supersedeTween();
      if (destroyed) return Promise.resolve();
      const animate = setOptions?.animate === true && !options.reducedMotion();
      return new Promise<void>((resolve) => {
        tween = { from: camera, to: next, start: null, duration: animate ? TWEEN_MS : 0, resolve };
        schedule("tween");
      });
    },
    zoomBy(factor, anchor) {
      const v = options.viewport();
      gestureTo(zoomAt(camera, anchor ?? { x: v.w / 2, y: v.h / 2 }, factor, options.limits()), "zoom");
    },
    panBy(dx, dy) {
      gestureTo(panCamera(camera, dx, dy), "pan");
    },
    isGesturing: () => gesturing || drag !== null,
    gestureTo,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      element.removeEventListener("wheel", onWheel, wheelOptions);
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerup", onPointerUp);
      element.removeEventListener("pointercancel", onPointerUp);
      if (frameHandle !== null) cancelRaf(frameHandle);
      frameHandle = null;
      if (settleHandle !== null) clearTimer(settleHandle);
      settleHandle = null;
      supersedeTween();
    },
  };
}

export function createViewportController<C extends Camera>(options: ViewportControllerOptions<C>): ViewportController<C> {
  return createViewportCore(options);
}
```

Modify `packages/trace-viewer/src/index.ts`. Current content:

```ts
export * from "./source.js";
export * from "./layout/viewport.js";
```

Append:

```ts
export { createViewportController, SETTLE_MS, type ViewportController, type ViewportControllerOptions, type FramePhase } from "./ui/viewport/controller.js";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/viewport/controller.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Root checks**

```bash
pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint
```

Expected: each exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/trace-viewer/src/ui/viewport/controller.ts packages/trace-viewer/src/ui/viewport/controller.test.ts packages/trace-viewer/src/index.ts
git commit -m "feat(trace-viewer): native-wheel viewport controller with rAF writes and settle"
```

### Task C1-7: SPIKE (R28, one day): synthetic harness, all seven risks measured, rulings recorded

This is the first work of milestone M4a. It measures; it does not decide the product. Risks 1, 4 and 5 gate M4a (C2-0 reads the rulings); risks 2, 3, 6 and 7 gate M4b (C3-5 applies their rulings).

**Files:**
- Create: `apps/trace-viewer-dev/spike.html`
- Create: `apps/trace-viewer-dev/vite.spike.config.ts`
- Create: `apps/trace-viewer-dev/.gitignore`
- Create: `apps/trace-viewer-dev/src/vite-env.d.ts`
- Create: `apps/trace-viewer-dev/src/spike/main.tsx`
- Create: `apps/trace-viewer-dev/src/spike/synthetic.ts`
- Create: `apps/trace-viewer-dev/src/spike/measure.ts`
- Create: `apps/trace-viewer-dev/src/spike/CanvasHarness.tsx`
- Create: `apps/trace-viewer-dev/src/spike/OverviewHarness.tsx`
- Create: `apps/trace-viewer-dev/src/spike/SwitchHarness.tsx`
- Create: `apps/trace-viewer-dev/src/spike/spike.module.css`
- Create: `apps/trace-viewer-dev/scripts/spike-electron.cjs`
- Create: `docs/spikes/trace-viewer-spike.md`

**Interfaces:**
- Consumes (C1-5, C1-6 through the built `@jevcode/trace-viewer` root barrel): `createViewportController`, `SETTLE_MS`, `type ViewportController`, `type FramePhase`, `fitBounds`, `fitRange`, `setCenter`, `isInsideInset`, `zoomAt`, `screenToWorld`, `worldToScreen`, `type UniformCamera`, `type XOnlyCamera`. `Activity` from `react` 19.2.3.
- Produces: `docs/spikes/trace-viewer-spike.md` with one row per risk (measured values, pass or fail against spec §16's pass column, ruling). Rulings on failure, which later tasks apply: 1 → C1-7F in this lane before merge; 4 → C2-5 puts each frame's full description in its Outline row; 5 → C2-11 paints pins on the canvas and keeps DOM buttons only as focus targets; 2 → C3-5 adds x0 binary-search culling and caps Step lists; 3 → C3-5 sets `settleRoundK: 64`; 6 → C3-5 sets `KEEP_HIDDEN_VIEWS_MOUNTED = false`; 7 → C3-5 sets `INV_K_EVERY_FRAME = true` in `views/canvas/World.tsx`. The page's `window.__spikeRun` API (in `measure.ts`) is internal to the spike.

- [ ] **Step 1: Build the package the harness imports**

Run: `pnpm --filter @jevcode/trace-viewer build`
Expected: exits 0; `packages/trace-viewer/dist/ui/viewport/controller.js` exists.

- [ ] **Step 2: Write the harness entry, config and ignore file**

`apps/trace-viewer-dev/spike.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Trace viewer spike</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./src/spike/main.tsx"></script>
  </body>
</html>
```

`apps/trace-viewer-dev/vite.spike.config.ts` (reuses W0's plugins: the Electron CSP meta on build and the node-builtin guard):

```ts
import { defineConfig, mergeConfig } from "vite";

import base from "./vite.config";

export default mergeConfig(
  base,
  defineConfig({
    build: {
      outDir: "dist-spike",
      emptyOutDir: true,
      assetsInlineLimit: 0,
      rollupOptions: { input: "spike.html" },
    },
  }),
);
```

`apps/trace-viewer-dev/.gitignore`:

```
dist-spike/
.spike/
```

`apps/trace-viewer-dev/src/vite-env.d.ts`:

```ts
/// <reference types="vite/client" />
```

- [ ] **Step 3: Write the synthetic scene and the measurement helpers**

`apps/trace-viewer-dev/src/spike/synthetic.ts`:

```ts
export interface BenchSize { chapters: number; edges: number }
export interface SpikeFrame {
  key: string; index: number; col: number;
  x: number; y: number; w: number; h: number;
  title: string; label: string; rows: readonly string[];
  critical: boolean; story: boolean;
}
export interface SpikeEdge { id: string; d: string; bad: boolean }
export interface SpikeMark { lane: number; u0: number; u1: number; bad: boolean }
export interface SpikePin { key: string; lane: number; u: number; label: string; bad: boolean }
export interface SpikeScene {
  frames: SpikeFrame[]; edges: SpikeEdge[]; marks: SpikeMark[]; pins: SpikePin[];
  bounds: { x: number; y: number; w: number; h: number };
  endU: number; columns: number;
}

export const PITCH = 264;
export const FRAME_W = 240;
export const STORY_H = 44;
export const STEP_H = 292;
export const WORK_TOP = 128;
export const COLUMN_MS = 20_000;
export const STORY_FRAMES = 40;
export const LANE_COUNT = 6;
export const MARK_COUNT = 5_000;

/** "?bench=60x300" → 60 chapters and 300 edges (the spec §16 scene). */
export function parseBench(value: string | null): BenchSize {
  const match = /^(\d+)x(\d+)$/.exec(value ?? "");
  if (match === null) return { chapters: 60, edges: 300 };
  return { chapters: Math.max(1, Number(match[1])), edges: Math.max(0, Number(match[2])) };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function offsetLabel(ms: number): string {
  const s = Math.floor(ms / 1_000);
  return `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** 60 chapters (Step level, nine-row lists) + 40 story frames ≈ 4k DOM nodes, 300 edges, 5k lane marks. */
export function buildScene(size: BenchSize, seed = 7): SpikeScene {
  const rand = mulberry32(seed);
  const columns = Math.max(1, Math.ceil(size.chapters / 3), Math.ceil(STORY_FRAMES / 2));
  const frames: SpikeFrame[] = [];
  for (let i = 0; i < STORY_FRAMES; i += 1) {
    const col = Math.floor(i / 2) % columns;
    frames.push({
      key: `story:${i}`, index: 0, col, x: col * PITCH, y: (i % 2) * (STORY_H + 8), w: FRAME_W, h: STORY_H,
      title: `Intent ${i + 1}`, label: `Intent ${i + 1}, ${offsetLabel(col * COLUMN_MS)}`, rows: [], critical: false, story: true,
    });
  }
  for (let i = 0; i < size.chapters; i += 1) {
    const col = Math.floor(i / 3);
    const row = i % 3;
    const failed = rand() < 0.1 ? 1 + Math.floor(rand() * 3) : 0;
    const passed = 5 + Math.floor(rand() * 20);
    const title = `Chapter ${i + 1}`;
    frames.push({
      key: `ch:${i}`, index: 0, col, x: col * PITCH, y: WORK_TOP + row * (STEP_H + 24), w: FRAME_W, h: STEP_H,
      title, label: `${title}, ${failed} failed, ${passed} passed, ${offsetLabel(col * COLUMN_MS + row * 1_000)}`,
      rows: Array.from({ length: 9 }, (_, r) => `pnpm test --filter pkg-${i}-${r}`), critical: failed > 0, story: false,
    });
  }
  frames.sort((a, b) => a.col - b.col || a.y - b.y);
  frames.forEach((frame, index) => { frame.index = index; });
  const work = frames.filter((frame) => !frame.story);
  const edges: SpikeEdge[] = [];
  for (let i = 0; i < size.edges && work.length > 1; i += 1) {
    const a = work[Math.floor(rand() * (work.length - 1))];
    if (a === undefined) break;
    const later = work.filter((frame) => frame.col > a.col);
    const b = later[Math.floor(rand() * later.length)] ?? work[work.length - 1];
    if (b === undefined) break;
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = b.x;
    const y2 = b.y + b.h / 2;
    const mx = (x1 + x2) / 2;
    edges.push({ id: `e${i}`, d: `M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`, bad: rand() < 0.02 });
  }
  const endU = columns * COLUMN_MS;
  const marks: SpikeMark[] = [];
  for (let i = 0; i < MARK_COUNT; i += 1) {
    const u0 = rand() * endU;
    marks.push({ lane: i % LANE_COUNT, u0, u1: u0 + (rand() < 0.3 ? rand() * 3_000 : 0), bad: rand() < 0.02 });
  }
  marks.sort((a, b) => a.u0 - b.u0);
  const pins: SpikePin[] = Array.from({ length: 60 }, (_, i) => ({
    key: `pin:${i}`, lane: i % LANE_COUNT, u: ((i + 0.5) / 60) * endU, label: `Pin ${i + 1}`, bad: i % 10 === 0,
  }));
  const bottom = Math.max(...frames.map((frame) => frame.y + frame.h));
  return { frames, edges, marks, pins, bounds: { x: 0, y: 0, w: columns * PITCH - (PITCH - FRAME_W), h: bottom }, endU, columns };
}
```

`apps/trace-viewer-dev/src/spike/measure.ts`:

```ts
export interface Drops { frames: number; p95Rounded: number; droppedFraction: number; pass: boolean }
export interface Rect { x: number; y: number; width: number; height: number }
export interface Risk1 { events: number; maxAnchorDriftPx: number; maxVisualScale: number; maxScroll: number }
export interface Risk5 { frames: number; maxDriftPx: number; redraws: number; dprChanges: number }
export interface SpikeResults { csp: string[]; scrollResets: number; risk1?: Risk1; risk5?: Risk5 }
export interface SpikeRun {
  sweep?(willChange: boolean): Promise<Drops & { willChange: boolean }>;
  settleAt?(k: number): Promise<{ k: number; dpr: number; frame: Rect; reference: Rect }>;
  hideReference?(): Promise<void>;
  strokeCheck?(): Promise<{ k: number; renderedPx: number }[]>;
  rulerSync?(): Promise<{ maxTickDriftPx: number }>;
  keyboardWalk?(presses: number): Promise<{ presses: number; failures: number; scrollResets: number }>;
  overviewDrift?(): Promise<Risk5>;
  switchCheck?(): Promise<{ toggles: number; storeEqual: boolean; maxCenterDriftPx: number; hiddenRafCallbacks: number; zeroFits: number }>;
}

declare global {
  interface Window { __spike?: SpikeResults; __spikeRun?: SpikeRun }
}

export function results(): SpikeResults {
  window.__spike ??= { csp: [], scrollResets: 0 };
  return window.__spike;
}

export function spikeRun(): SpikeRun {
  window.__spikeRun ??= {};
  return window.__spikeRun;
}

export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? 0;
}

/** Spec §10: each rAF interval rounded to whole refresh intervals; pass = ≤ 5% dropped and p95 ≤ 1 interval. */
export function roundedDrops(stamps: readonly number[], refreshMs = 1_000 / 60): Drops {
  const rounded: number[] = [];
  for (let i = 1; i < stamps.length; i += 1) {
    const a = stamps[i - 1] ?? 0;
    const b = stamps[i] ?? 0;
    rounded.push(Math.max(1, Math.round((b - a) / refreshMs)));
  }
  const total = rounded.reduce((sum, r) => sum + r, 0);
  const dropped = rounded.reduce((sum, r) => sum + (r - 1), 0);
  const p95Rounded = percentile(rounded, 0.95);
  const droppedFraction = total === 0 ? 0 : dropped / total;
  return { frames: rounded.length, p95Rounded, droppedFraction, pass: droppedFraction <= 0.05 && p95Rounded <= 1 };
}

export function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

export async function frames(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await nextFrame();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function rectOf(r: DOMRect): Rect {
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}
```

- [ ] **Step 4: Write the three harnesses, their CSS and the page entry**

`apps/trace-viewer-dev/src/spike/spike.module.css`:

```css
.app {
  display: grid;
  grid-template-rows: 36px 1fr;
  height: 100vh;
  font: 13px/18px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #16181D;
  background: #FFFFFF;
  font-variant-numeric: tabular-nums;
}

.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  box-shadow: 0 1px 0 rgb(16 24 40 / 0.07);
}

.bar button {
  font: inherit;
  font-size: 12px;
  padding: 2px 10px;
  border: 0;
  border-radius: 6px;
  background: rgb(16 24 40 / 0.04);
  color: #16181D;
}

.bar button[aria-pressed="true"] {
  background: rgb(47 107 255 / 0.10);
  color: #1F5EF0;
}

.meta { font-size: 12px; color: #676D78; }

.canvasRoot {
  display: grid;
  grid-template-rows: 28px 1fr;
  min-height: 0;
}

.ruler {
  position: relative;
  overflow: hidden;
  background: #FFFFFF;
  box-shadow: 0 1px 0 rgb(16 24 40 / 0.07);
}

.tick {
  position: absolute;
  top: 0;
  left: 0;
  height: 28px;
  padding-left: 4px;
  border-left: 1px solid #9AA0AB;
  font-size: 12px;
  line-height: 28px;
  color: #676D78;
  white-space: nowrap;
}

.viewport {
  position: relative;
  overflow: hidden;
  min-height: 0;
  background-color: #F4F5F7;
  background-image: radial-gradient(#9AA0AB 1px, transparent 1px);
  background-size: 24px 24px;
  outline: none;
}

.world {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
}

.edges {
  position: absolute;
  top: 0;
  left: 0;
  overflow: visible;
}

.edge { fill: none; stroke: #9AA0AB; stroke-width: calc(1.5px * var(--tv-inv-k, 1)); }
.edgeBad { fill: none; stroke: #E5484D; stroke-width: calc(1.5px * var(--tv-inv-k, 1)); }

.frame, .story {
  position: absolute;
  box-sizing: border-box;
  padding: 10px 12px;
  border-radius: 8px;
  background: #FFFFFF;
  box-shadow: 0 1px 2px rgb(16 24 40 / 0.06), 0 4px 12px rgb(16 24 40 / 0.05);
  outline: none;
}

.frame:focus-visible, .story:focus-visible { box-shadow: 0 0 0 2px #2F6BFF; }

.title {
  display: inline-block;
  font-weight: 500;
  font-size: 13px;
  line-height: 18px;
  color: #16181D;
}

.rows {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}

.rows li {
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr) auto;
  gap: 6px;
  align-items: center;
  height: 24px;
}

.dot { width: 6px; height: 6px; border-radius: 50%; background: #7C828E; }

.mono {
  overflow: hidden;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12px;
  color: #5B616E;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reference {
  position: fixed;
  top: 48px;
  right: 24px;
  display: inline-block;
  padding: 0;
  background: #FFFFFF;
  font-weight: 500;
  color: #16181D;
  white-space: nowrap;
}

.overview {
  position: relative;
  height: 288px;
  overflow: hidden;
  background: #F4F5F7;
}

.overviewCanvas {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 288px;
}

.pin {
  position: absolute;
  top: 0;
  left: 0;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 11px;
  background: #FFFFFF;
  box-shadow: 0 1px 2px rgb(16 24 40 / 0.06), 0 4px 12px rgb(16 24 40 / 0.05);
  font-size: 12px;
  color: #5B616E;
}

.pinBad { color: #CE2C31; }

.switch {
  display: grid;
  grid-template-rows: 36px 1fr;
  min-height: 0;
}

.dummy {
  position: relative;
  height: 100%;
  overflow: hidden;
  background: #F4F5F7;
}

.marker {
  position: absolute;
  top: 40px;
  left: 0;
  width: 2px;
  height: 120px;
  background: #2F6BFF;
}
```

`apps/trace-viewer-dev/src/spike/CanvasHarness.tsx`:

```tsx
import {
  createViewportController, fitBounds, isInsideInset, screenToWorld, setCenter, SETTLE_MS, worldToScreen, zoomAt,
  type FramePhase, type UniformCamera, type ViewportController,
} from "@jevcode/trace-viewer";
import { useEffect, useRef, type JSX } from "react";

import { frames as waitFrames, nextFrame, rectOf, results, roundedDrops, sleep, spikeRun } from "./measure";
import styles from "./spike.module.css";
import { COLUMN_MS, offsetLabel, PITCH, type SpikeScene } from "./synthetic";

const LIMITS = { minK: 0.1, maxK: 4 };
const INSET = 48;

function TestDotsLite({ failed }: { failed: number }): JSX.Element {
  return (
    <svg width={90} height={6} aria-hidden="true">
      {Array.from({ length: 15 }, (_, i) => (
        <circle key={i} cx={3 + i * 6} cy={3} r={i < failed ? 3 : 2} fill={i < failed ? "#E5484D" : "#2E9E6A"} />
      ))}
    </svg>
  );
}

export function CanvasHarness({ scene, settleRoundK }: { scene: SpikeScene; settleRoundK: number | null }): JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const referenceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = viewportRef.current;
    const world = worldRef.current;
    const ruler = rulerRef.current;
    const reference = referenceRef.current;
    if (el === null || world === null || ruler === null || reference === null) return undefined;
    const out = results();
    const risk1 = { events: 0, maxAnchorDriftPx: 0, maxVisualScale: 1, maxScroll: 0 };
    out.risk1 = risk1;
    const size = () => ({ w: el.clientWidth, h: el.clientHeight });
    const ticks = [...ruler.querySelectorAll<HTMLElement>("[data-col]")];
    const frameEls = [...world.querySelectorAll<HTMLElement>("[data-frame]")];
    let hand = false;
    let willChange = true;
    let focusIndex = 0;
    let pendingAnchor: { cursor: { x: number; y: number }; world: { x: number; y: number } } | null = null;
    let controller: ViewportController<UniformCamera> | null = null;

    const apply = (camera: UniformCamera, phase: FramePhase): void => {
      world.style.transform = `translate(${camera.tx}px, ${camera.ty}px) scale(${camera.k})`;
      if (phase === "settle") el.style.setProperty("--tv-inv-k", String(1 / camera.k));
      for (const tick of ticks) {
        tick.style.transform = `translateX(${camera.tx + Number(tick.dataset.col) * PITCH * camera.k}px)`;
      }
      if (pendingAnchor !== null && phase === "gesture") {
        const screen = worldToScreen(camera, pendingAnchor.world);
        risk1.maxAnchorDriftPx = Math.max(risk1.maxAnchorDriftPx, Math.hypot(screen.x - pendingAnchor.cursor.x, screen.y - pendingAnchor.cursor.y));
        pendingAnchor = null;
      }
    };

    const initial = fitBounds(scene.bounds, size(), { padding: 48, limits: LIMITS });
    // Registered before the controller so it reads the camera before the event applies.
    const onMeasureWheel = (event: WheelEvent): void => {
      risk1.events += 1;
      risk1.maxVisualScale = Math.max(risk1.maxVisualScale, window.visualViewport?.scale ?? 1);
      const page = document.scrollingElement;
      risk1.maxScroll = Math.max(risk1.maxScroll, Math.abs(el.scrollLeft) + Math.abs(el.scrollTop) + Math.abs(page?.scrollLeft ?? 0) + Math.abs(page?.scrollTop ?? 0));
      if ((event.ctrlKey || event.metaKey) && pendingAnchor === null) {
        const rect = el.getBoundingClientRect();
        const cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        pendingAnchor = { cursor, world: screenToWorld(controller?.get() ?? initial, cursor) };
      }
    };
    el.addEventListener("wheel", onMeasureWheel, { passive: true });
    const onScroll = (): void => {
      if (el.scrollLeft !== 0 || el.scrollTop !== 0) {
        el.scrollLeft = 0;
        el.scrollTop = 0;
        out.scrollResets += 1;
      }
    };
    el.addEventListener("scroll", onScroll);

    const ctl = createViewportController<UniformCamera>({
      element: el,
      initial,
      limits: () => LIMITS,
      viewport: size,
      content: () => scene.bounds,
      onFrame: apply,
      onGestureStart: () => { if (willChange) world.style.willChange = "transform"; },
      onGestureEnd: () => { world.style.willChange = ""; },
      isHandTool: () => hand,
      reducedMotion: () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      settleRoundK,
    });
    controller = ctl;
    apply(initial, "settle");

    async function reveal(index: number): Promise<void> {
      const frame = scene.frames[index];
      const node = frameEls[index];
      if (frame === undefined || node === undefined) return;
      const camera = ctl.get();
      if (!isInsideInset(camera, frame, size(), INSET)) {
        await ctl.set(setCenter(camera, { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 }, size()));
      }
      frameEls[focusIndex]?.setAttribute("tabindex", "-1");
      node.setAttribute("tabindex", "0");
      focusIndex = index;
      node.focus({ preventScroll: true });
    }

    const onKey = (event: KeyboardEvent): void => {
      if (event.code === "Space") {
        event.preventDefault();
        hand = event.type === "keydown";
        return;
      }
      if (event.type !== "keydown") return;
      if (event.code === "KeyJ" || event.code === "KeyK") {
        event.preventDefault();
        const next = Math.max(0, Math.min(scene.frames.length - 1, focusIndex + (event.code === "KeyJ" ? 1 : -1)));
        void reveal(next);
      } else if (event.code === "KeyH") {
        hand = true;
      } else if (event.code === "KeyV") {
        hand = false;
      } else if (event.code === "Digit1" && event.shiftKey) {
        void ctl.set(fitBounds(scene.bounds, size(), { padding: 48, limits: LIMITS }), { animate: true });
      } else if (event.code === "Digit2" && event.shiftKey) {
        const frame = scene.frames[focusIndex];
        if (frame !== undefined) void ctl.set(fitBounds(frame, size(), { padding: 48, limits: { minK: LIMITS.minK, maxK: 1.5 } }), { animate: true });
      }
    };
    el.addEventListener("keydown", onKey);
    el.addEventListener("keyup", onKey);

    const tickDrift = (): number => {
      let max = 0;
      for (const frame of scene.frames) {
        if (frame.story || frame.index > 40) continue;
        const tick = ticks[frame.col];
        const node = frameEls[frame.index];
        if (tick === undefined || node === undefined) continue;
        max = Math.max(max, Math.abs(tick.getBoundingClientRect().left - node.getBoundingClientRect().left));
      }
      return max;
    };

    const zoomSweep = async (ms: number, from: number, to: number, perFrame?: () => void): Promise<number[]> => {
      const v = size();
      const stamps: number[] = [];
      const start = await nextFrame();
      for (;;) {
        const now = await nextFrame();
        stamps.push(now);
        const p = Math.min(1, (now - start) / ms);
        const k = from * (to / from) ** p;
        const current = ctl.get();
        void ctl.set(zoomAt(current, { x: v.w / 2, y: v.h / 2 }, k / current.k, { minK: k, maxK: k }));
        perFrame?.();
        if (p >= 1) break;
      }
      return stamps;
    };

    const run = spikeRun();
    run.sweep = async (withWillChange) => {
      willChange = withWillChange;
      world.style.willChange = withWillChange ? "transform" : "";
      const stamps = await zoomSweep(3_000, 0.35, 2);
      world.style.willChange = "";
      willChange = true;
      return { ...roundedDrops(stamps), willChange: withWillChange };
    };
    run.settleAt = async (k) => {
      const first = scene.frames.find((frame) => !frame.story);
      if (first === undefined) throw new Error("scene has no chapter frame");
      await ctl.set(setCenter({ mode: "uniform", tx: 0, ty: 0, k }, { x: first.x + first.w / 2, y: first.y + 40 }, size()));
      ctl.panBy(0, 0);
      await sleep(SETTLE_MS + 60);
      await waitFrames(2);
      const title = frameEls[first.index]?.querySelector<HTMLElement>("[data-title]");
      if (title === null || title === undefined) throw new Error("frame title missing");
      const settledK = ctl.get().k;
      reference.textContent = first.title;
      reference.style.fontSize = `${13 * settledK}px`;
      reference.style.lineHeight = `${18 * settledK}px`;
      reference.hidden = false;
      await waitFrames(2);
      return { k: settledK, dpr: window.devicePixelRatio, frame: rectOf(title.getBoundingClientRect()), reference: rectOf(reference.getBoundingClientRect()) };
    };
    run.hideReference = async () => {
      reference.hidden = true;
      await waitFrames(1);
    };
    run.strokeCheck = async () => {
      const path = world.querySelector<SVGPathElement>("[data-edge]");
      if (path === null) return [];
      const rows: { k: number; renderedPx: number }[] = [];
      for (const k of [0.5, 0.75, 1, 1.5, 2]) {
        await run.settleAt?.(k);
        reference.hidden = true;
        const k2 = ctl.get().k;
        rows.push({ k: k2, renderedPx: Number.parseFloat(getComputedStyle(path).strokeWidth) * k2 });
      }
      return rows;
    };
    run.rulerSync = async () => {
      let max = 0;
      await zoomSweep(1_500, 0.5, 2, () => { max = Math.max(max, tickDrift()); });
      return { maxTickDriftPx: max };
    };
    run.keyboardWalk = async (presses) => {
      let failures = 0;
      await ctl.set(fitBounds(scene.bounds, size(), { padding: 48, limits: { minK: 1, maxK: 1 } }));
      focusIndex = 0;
      frameEls[0]?.focus({ preventScroll: true });
      for (let i = 0; i < presses; i += 1) {
        el.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyJ", key: "j", bubbles: true }));
        await waitFrames(3);
        const node = frameEls[focusIndex];
        const r = node?.getBoundingClientRect();
        const v = el.getBoundingClientRect();
        const inside = r !== undefined && r.left >= v.left + INSET && r.top >= v.top + INSET && r.right <= v.right - INSET && r.bottom <= v.bottom - INSET;
        if (document.activeElement !== node || !inside) failures += 1;
      }
      return { presses, failures, scrollResets: out.scrollResets };
    };

    return () => {
      el.removeEventListener("wheel", onMeasureWheel);
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("keyup", onKey);
      ctl.destroy();
    };
  }, [scene, settleRoundK]);

  return (
    <div className={styles.canvasRoot}>
      <div ref={rulerRef} className={styles.ruler} aria-hidden="true">
        {Array.from({ length: scene.columns }, (_, col) => (
          <span key={col} data-col={col} className={styles.tick}>{offsetLabel(col * COLUMN_MS)}</span>
        ))}
      </div>
      <div ref={viewportRef} className={styles.viewport} tabIndex={-1} aria-label="Spike canvas">
        <div ref={worldRef} className={styles.world}>
          <svg className={styles.edges} width={scene.bounds.w} height={scene.bounds.h} aria-hidden="true">
            {scene.edges.map((edge) => (
              <path key={edge.id} data-edge="" d={edge.d} className={edge.bad ? styles.edgeBad : styles.edge} />
            ))}
          </svg>
          {scene.frames.map((frame, i) => (
            <div
              key={frame.key}
              data-frame=""
              role="group"
              aria-label={frame.label}
              tabIndex={i === 0 ? 0 : -1}
              className={frame.story ? styles.story : styles.frame}
              style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}
            >
              <span data-title="" className={styles.title}>{frame.title}</span>
              {frame.story ? null : (
                <>
                  <TestDotsLite failed={frame.critical ? 1 : 0} />
                  <ul className={styles.rows}>
                    {frame.rows.map((row) => (
                      <li key={row}>
                        <span className={styles.dot} />
                        <span className={styles.mono}>{row}</span>
                        <span className={styles.meta}>1.2 s</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
      <div ref={referenceRef} className={styles.reference} hidden />
    </div>
  );
}
```

`apps/trace-viewer-dev/src/spike/OverviewHarness.tsx`:

```tsx
import { createViewportController, fitRange, type XOnlyCamera } from "@jevcode/trace-viewer";
import { useEffect, useRef, type JSX } from "react";

import { nextFrame, results, sleep, spikeRun } from "./measure";
import styles from "./spike.module.css";
import type { SpikeScene } from "./synthetic";

const OVERVIEW_H = 288;
const LANES_TOP = 58;
const LANE_H = 28;
const PIN_PX = 22;

export function OverviewHarness({ scene }: { scene: SpikeScene }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pinsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const pinLayer = pinsRef.current;
    const ctx = canvas?.getContext("2d") ?? null;
    if (host === null || canvas === null || pinLayer === null || ctx === null) return undefined;
    const report = { frames: 0, maxDriftPx: 0, redraws: 0, dprChanges: 0 };
    results().risk5 = report;
    const pinEls = [...pinLayer.querySelectorAll<HTMLElement>("[data-pin]")];
    const painted = new Float64Array(scene.pins.length);
    let dpr = window.devicePixelRatio;
    let widthPx = host.clientWidth;
    const snap = (x: number): number => Math.round(x * dpr) / dpr;

    const paint = (camera: XOnlyCamera): void => {
      report.frames += 1;
      ctx.setTransform(canvas.width / widthPx, 0, 0, canvas.height / OVERVIEW_H, 0, 0);
      ctx.clearRect(0, 0, widthPx, OVERVIEW_H);
      const uEnd = camera.u0 + widthPx / camera.k;
      for (const mark of scene.marks) {
        if (mark.u1 < camera.u0 || mark.u0 > uEnd) continue;
        const x = snap((mark.u0 - camera.u0) * camera.k);
        ctx.fillStyle = mark.bad ? "#E5484D" : "#7C828E";
        ctx.fillRect(x, LANES_TOP + mark.lane * LANE_H + 10, Math.max(1 / dpr, (mark.u1 - mark.u0) * camera.k), 8);
      }
      scene.pins.forEach((pin, i) => {
        const x = snap((pin.u - camera.u0) * camera.k);
        painted[i] = x;
        ctx.fillStyle = "#2F6BFF";
        ctx.fillRect(x - 0.5 / dpr, LANES_TOP + pin.lane * LANE_H, 1 / dpr, LANE_H);
        const node = pinEls[i];
        if (node !== undefined) node.style.transform = `translate(${x - PIN_PX / 2}px, ${LANES_TOP + pin.lane * LANE_H + 3}px)`;
      });
    };
    const measure = (): void => {
      const left = host.getBoundingClientRect().left;
      scene.pins.forEach((_, i) => {
        const r = pinEls[i]?.getBoundingClientRect();
        if (r === undefined || r.right < left || r.left > left + widthPx) return;
        report.maxDriftPx = Math.max(report.maxDriftPx, Math.abs(r.left + r.width / 2 - left - (painted[i] ?? 0)));
      });
    };

    const fit = fitRange(0, scene.endU, widthPx, { padFraction: 0.02, limits: { minK: 1e-9, maxK: 0.4 } });
    const limits = { minK: fit.k * 0.9, maxK: 0.4 };
    const controller = createViewportController<XOnlyCamera>({
      element: host,
      initial: fit,
      limits: () => limits,
      viewport: () => ({ w: widthPx, h: OVERVIEW_H }),
      content: () => ({ x: 0, y: 0, w: scene.endU, h: OVERVIEW_H }),
      onFrame: (camera) => {
        paint(camera);
        requestAnimationFrame(measure);
      },
      isHandTool: () => false,
      reducedMotion: () => false,
    });

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const device = entry.devicePixelContentBoxSize?.[0];
        const css = entry.contentBoxSize?.[0];
        if (window.devicePixelRatio !== dpr) report.dprChanges += 1;
        dpr = window.devicePixelRatio;
        widthPx = css?.inlineSize ?? host.clientWidth;
        canvas.width = device?.inlineSize ?? Math.round(widthPx * dpr);
        canvas.height = device?.blockSize ?? Math.round(OVERVIEW_H * dpr);
        report.redraws += 1;
        paint(controller.get());
      }
    });
    try {
      observer.observe(canvas, { box: "device-pixel-content-box" });
    } catch {
      observer.observe(canvas);
    }

    spikeRun().overviewDrift = async () => {
      report.maxDriftPx = 0;
      const start = await nextFrame();
      for (;;) {
        const now = await nextFrame();
        const p = (now - start) / 2_000;
        if (p >= 1) break;
        if (p < 0.5) controller.panBy(-6, 0);
        else controller.zoomBy(p < 0.75 ? 1.03 : 1 / 1.03, { x: widthPx / 2, y: 100 });
      }
      await sleep(300);
      return { ...report };
    };

    return () => {
      observer.disconnect();
      controller.destroy();
    };
  }, [scene]);

  return (
    <div ref={hostRef} className={styles.overview}>
      <canvas ref={canvasRef} className={styles.overviewCanvas} aria-hidden="true" />
      <div ref={pinsRef}>
        {scene.pins.map((pin) => (
          <button key={pin.key} type="button" data-pin="" className={pin.bad ? `${styles.pin} ${styles.pinBad}` : styles.pin} aria-label={pin.label}>
            {pin.bad ? "!" : "·"}
          </button>
        ))}
      </div>
    </div>
  );
}
```

`apps/trace-viewer-dev/src/spike/SwitchHarness.tsx`:

```tsx
import { createViewportController, fitRange, type XOnlyCamera } from "@jevcode/trace-viewer";
import { Activity, useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";

import { frames, nextFrame, sleep, spikeRun } from "./measure";
import styles from "./spike.module.css";
import type { SpikeScene } from "./synthetic";

type ViewId = "a" | "b";
const store = { selection: "step:12", playhead: 12, brush: [5, 40] as [number, number] };
const hiddenCallbacks: Record<ViewId, number> = { a: 0, b: 0 };
const saved: Partial<Record<ViewId, { u0: number; k: number }>> = {};
let zeroFits = 0;
let visible: ViewId = "a";

function DummyView({ id, scene, rows }: { id: ViewId; scene: SpikeScene; rows: number }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return undefined;
    const rect = el.getBoundingClientRect();
    let camera = saved[id];
    if (camera === undefined) {
      if (rect.width === 0 || rect.height === 0) {
        zeroFits += 1;
        return undefined;
      }
      const fit = fitRange(0, scene.endU, rect.width, { padFraction: 0.02, limits: { minK: 1e-9, maxK: 0.4 } });
      camera = { u0: fit.u0, k: fit.k };
    }
    const place = (c: { u0: number; k: number }): void => {
      if (markerRef.current !== null) markerRef.current.style.transform = `translateX(${(scene.endU / 2 - c.u0) * c.k}px)`;
    };
    const controller = createViewportController<XOnlyCamera>({
      element: el,
      initial: { mode: "xOnly", ...camera },
      limits: () => ({ minK: 1e-9, maxK: 0.4 }),
      viewport: () => ({ w: el.clientWidth, h: el.clientHeight }),
      content: () => ({ x: 0, y: 0, w: scene.endU, h: 1 }),
      onFrame: (c) => {
        saved[id] = { u0: c.u0, k: c.k };
        place(c);
      },
      isHandTool: () => false,
      reducedMotion: () => false,
    });
    saved[id] = camera;
    place(camera);
    let handle = 0;
    const loop = (): void => {
      if (visible !== id) hiddenCallbacks[id] += 1;
      handle = requestAnimationFrame(loop);
    };
    handle = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(handle);
      const last = controller.get();
      saved[id] = { u0: last.u0, k: last.k };
      controller.destroy();
    };
  }, [id, scene]);
  return (
    <div ref={ref} className={styles.dummy} data-view={id}>
      <div ref={markerRef} className={styles.marker} />
      <span className={styles.meta}>{`View ${id.toUpperCase()} · ${rows} rows`}</span>
    </div>
  );
}

export function SwitchHarness({ scene }: { scene: SpikeScene }): JSX.Element {
  const [view, setView] = useState<ViewId>("a");
  const [rows, setRows] = useState(0);
  visible = view;
  const setViewRef = useRef(setView);
  setViewRef.current = setView;

  useEffect(() => {
    const drip = window.setInterval(() => setRows((n) => n + 1), 1_000);
    spikeRun().switchCheck = async () => {
      const before = JSON.stringify(store);
      hiddenCallbacks.a = 0;
      hiddenCallbacks.b = 0;
      let maxCenterDriftPx = 0;
      for (let i = 0; i < 10; i += 1) {
        const id = visible;
        const other: ViewId = id === "a" ? "b" : "a";
        const el = document.querySelector<HTMLElement>(`[data-view="${id}"]`);
        if (el === null) throw new Error(`view ${id} missing`);
        for (let j = 0; j < 5; j += 1) {
          el.dispatchEvent(new WheelEvent("wheel", { deltaY: -4, ctrlKey: true, clientX: 300, clientY: 80, bubbles: true, cancelable: true }));
        }
        await nextFrame();
        const width = el.clientWidth;
        const cam = saved[id];
        if (cam === undefined) throw new Error("no saved camera");
        const centerU = cam.u0 + width / 2 / cam.k;
        setViewRef.current(other);
        await frames(3);
        setViewRef.current(id);
        await frames(3);
        const back = saved[id];
        if (back === undefined) throw new Error("camera lost");
        maxCenterDriftPx = Math.max(maxCenterDriftPx, Math.abs(back.u0 + width / 2 / back.k - centerU) * back.k);
        await sleep(i % 3 === 0 ? 1_100 : 50);
      }
      return {
        toggles: 10,
        storeEqual: before === JSON.stringify(store),
        maxCenterDriftPx,
        hiddenRafCallbacks: hiddenCallbacks.a + hiddenCallbacks.b,
        zeroFits,
      };
    };
    return () => window.clearInterval(drip);
  }, []);

  return (
    <div className={styles.switch}>
      <div className={styles.bar}>
        <button type="button" aria-pressed={view === "a"} onClick={() => setView("a")}>View A</button>
        <button type="button" aria-pressed={view === "b"} onClick={() => setView("b")}>View B</button>
      </div>
      <div>
        <Activity mode={view === "a" ? "visible" : "hidden"}><DummyView id="a" scene={scene} rows={rows} /></Activity>
        <Activity mode={view === "b" ? "visible" : "hidden"}><DummyView id="b" scene={scene} rows={rows} /></Activity>
      </div>
    </div>
  );
}
```

`apps/trace-viewer-dev/src/spike/main.tsx`:

```tsx
import { StrictMode, useState, type JSX } from "react";
import { createRoot } from "react-dom/client";

import { CanvasHarness } from "./CanvasHarness";
import { results } from "./measure";
import { OverviewHarness } from "./OverviewHarness";
import styles from "./spike.module.css";
import { SwitchHarness } from "./SwitchHarness";
import { buildScene, parseBench } from "./synthetic";

const params = new URLSearchParams(window.location.search);
const scene = buildScene(parseBench(params.get("bench")));
const roundK = params.get("roundK");
const settleRoundK = roundK === null ? null : Number(roundK);
type HarnessId = "canvas" | "overview" | "switch";
const HARNESSES: readonly HarnessId[] = ["canvas", "overview", "switch"];
const requested = params.get("harness");
const initialHarness: HarnessId = HARNESSES.find((h) => h === requested) ?? "canvas";

document.addEventListener("securitypolicyviolation", (event) => {
  results().csp.push(`${event.violatedDirective} ${event.blockedURI}`);
});
results();

function App(): JSX.Element {
  const [harness, setHarness] = useState<HarnessId>(initialHarness);
  return (
    <div className={styles.app}>
      <nav className={styles.bar} aria-label="Spike harness">
        {HARNESSES.map((id) => (
          <button key={id} type="button" aria-pressed={harness === id} onClick={() => setHarness(id)}>{id}</button>
        ))}
        <span className={styles.meta}>{`${scene.frames.length} frames · ${scene.edges.length} edges · ${scene.marks.length} marks`}</span>
      </nav>
      {harness === "overview" ? <OverviewHarness scene={scene} /> : null}
      {harness === "switch" ? <SwitchHarness scene={scene} /> : null}
      {harness === "canvas" ? <CanvasHarness scene={scene} settleRoundK={settleRoundK} /> : null}
    </div>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("spike: #root is missing");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 5: Typecheck and build the harness under the Electron CSP**

Run: `pnpm --filter jevcode-trace-viewer-dev typecheck && pnpm --filter jevcode-trace-viewer-dev exec vite build --config vite.spike.config.ts`
Expected: both exit 0; `apps/trace-viewer-dev/dist-spike/spike.html` contains `Content-Security-Policy` (check: `grep -c "Content-Security-Policy" apps/trace-viewer-dev/dist-spike/spike.html` prints `1`) and `ls apps/trace-viewer-dev/dist-spike/assets | grep -c '\.js$'` prints at least `1`.

- [ ] **Step 6: Write the Electron driver**

`apps/trace-viewer-dev/scripts/spike-electron.cjs` (run from any directory; loads the built harness from `dist-spike` in a hidden-then-shown window and writes `.spike/results-dpr<N>.json` and `.spike/summary-dpr<N>.md`):

```js
const { app, BrowserWindow, screen } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, ".spike");
const BENCH = process.env.SPIKE_BENCH ?? "60x300";
if (process.env.SPIKE_DPR) app.commandLine.appendSwitch("force-device-scale-factor", process.env.SPIKE_DPR);

const js = (win, code) => win.webContents.executeJavaScript(code, true);
const twoFrames = (win) => js(win, "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function open(win, harness) {
  await win.loadFile(path.join(ROOT, "dist-spike", "spike.html"), { query: { bench: BENCH, harness } });
  await twoFrames(win);
}

function toRect(r) {
  return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.max(1, Math.ceil(r.width)), height: Math.max(1, Math.ceil(r.height)) };
}

function diffImages(a, b) {
  const sa = a.getSize();
  const sb = b.getSize();
  const w = Math.min(sa.width, sb.width);
  const h = Math.min(sa.height, sb.height);
  const ba = a.toBitmap();
  const bb = b.toBitmap();
  let differing = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const ia = (y * sa.width + x) * 4;
      const ib = (y * sb.width + x) * 4;
      if (Math.abs(ba[ia] - bb[ib]) > 16 || Math.abs(ba[ia + 1] - bb[ib + 1]) > 16 || Math.abs(ba[ia + 2] - bb[ib + 2]) > 16) differing += 1;
    }
  }
  const fraction = w * h === 0 ? 1 : differing / (w * h);
  return { width: w, height: h, differing, fraction, pass: fraction <= 0.01 };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const consoleErrors = [];
  const win = new BrowserWindow({
    width: 1440, height: 900, show: false, backgroundColor: "#FFFFFF",
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
  });
  win.webContents.on("console-message", (_event, level, message) => { if (level >= 3) consoleErrors.push(message); });
  const csp = [];

  await open(win, "canvas");
  win.show();
  await wait(500);
  const dpr = await js(win, "window.devicePixelRatio");
  const tag = `dpr${dpr}`;

  const [w, h] = win.getContentSize();
  const x = Math.round(w / 2);
  const y = Math.round(h / 2);
  for (let i = 0; i < 40; i += 1) {
    win.webContents.sendInputEvent({ type: "mouseWheel", x, y, deltaX: 0, deltaY: i < 20 ? 4 : -4, modifiers: ["control"], canScroll: true, hasPreciseScrollingDeltas: true });
    await twoFrames(win);
  }
  for (let i = 0; i < 20; i += 1) {
    win.webContents.sendInputEvent({ type: "mouseWheel", x, y, deltaX: -6, deltaY: -6, canScroll: true, hasPreciseScrollingDeltas: true });
    await twoFrames(win);
  }
  await wait(400);
  const risk1 = await js(win, "window.__spike.risk1");

  const risk2 = [];
  for (const willChange of [false, true]) risk2.push(await js(win, `window.__spikeRun.sweep(${willChange})`));

  const risk3 = [];
  for (const k of [0.5, 1, 2]) {
    const rects = await js(win, `window.__spikeRun.settleAt(${k})`);
    const a = await win.webContents.capturePage(toRect(rects.frame));
    const b = await win.webContents.capturePage(toRect(rects.reference));
    fs.writeFileSync(path.join(OUT, `risk3-k${k}-${tag}-frame.png`), a.toPNG());
    fs.writeFileSync(path.join(OUT, `risk3-k${k}-${tag}-reference.png`), b.toPNG());
    risk3.push({ k: rects.k, ...diffImages(a, b) });
  }
  await js(win, "window.__spikeRun.hideReference()");

  const risk7 = { stroke: await js(win, "window.__spikeRun.strokeCheck()"), ...(await js(win, "window.__spikeRun.rulerSync()")) };
  const risk4 = await js(win, "window.__spikeRun.keyboardWalk(20)");
  csp.push(...(await js(win, "window.__spike.csp")));

  await open(win, "overview");
  const risk5 = await js(win, "window.__spikeRun.overviewDrift()");
  const displays = screen.getAllDisplays();
  if (displays.length > 1) {
    const current = screen.getDisplayMatching(win.getBounds());
    const other = displays.find((d) => d.id !== current.id);
    win.setBounds({ x: other.workArea.x + 40, y: other.workArea.y + 40, width: 1440, height: 900 });
    await wait(1_000);
    Object.assign(risk5, await js(win, "window.__spike.risk5"), { movedDisplays: true });
  } else {
    risk5.movedDisplays = false;
  }
  csp.push(...(await js(win, "window.__spike.csp")));

  await open(win, "switch");
  const risk6 = await js(win, "window.__spikeRun.switchCheck()");
  csp.push(...(await js(win, "window.__spike.csp")));

  const pass = {
    1: risk1.maxAnchorDriftPx <= 1 && risk1.maxVisualScale === 1 && risk1.maxScroll === 0,
    2: risk2[0].pass,
    "2 (will-change)": risk2[1].pass,
    3: risk3.every((row) => row.pass),
    4: risk4.failures === 0 && risk4.scrollResets === 0,
    5: risk5.maxDriftPx <= 1,
    6: risk6.storeEqual && risk6.maxCenterDriftPx <= 1 && risk6.hiddenRafCallbacks === 0 && risk6.zeroFits === 0,
    7: risk7.stroke.every((row) => Math.abs(row.renderedPx - 1.5) <= 0.05) && risk7.maxTickDriftPx <= 1,
    csp: csp.length === 0 && consoleErrors.length === 0,
  };
  const result = { bench: BENCH, dpr, risk1, risk2, risk3, risk4, risk5, risk6, risk7, csp, consoleErrors, pass };
  fs.writeFileSync(path.join(OUT, `results-${tag}.json`), `${JSON.stringify(result, null, 2)}\n`);
  const f = (n) => (typeof n === "number" ? Number(n.toFixed(3)) : n);
  const lines = [
    `| 1 (${tag}) | anchor drift max ${f(risk1.maxAnchorDriftPx)} px over ${risk1.events} events; visualViewport.scale max ${f(risk1.maxVisualScale)}; scroll max ${f(risk1.maxScroll)} | ${pass[1] ? "pass (automated part)" : "FAIL"} |`,
    `| 2 (${tag}) | without will-change: dropped ${f(risk2[0].droppedFraction * 100)}%, p95 ${risk2[0].p95Rounded} intervals over ${risk2[0].frames} frames; with: dropped ${f(risk2[1].droppedFraction * 100)}%, p95 ${risk2[1].p95Rounded} | ${pass[2] ? "pass" : pass["2 (will-change)"] ? "pass only with gesture-time will-change" : "FAIL"} |`,
    `| 3 (${tag}) | ${risk3.map((r) => `k ${f(r.k)}: ${f(r.fraction * 100)}% of ${r.width}x${r.height} px differ`).join("; ")} | ${pass[3] ? "pass" : "FAIL"} |`,
    `| 4 (${tag}) | ${risk4.presses} j presses, ${risk4.failures} focus/inset failures, ${risk4.scrollResets} scroll resets | ${pass[4] ? "pass (automated part)" : "FAIL"} |`,
    `| 5 (${tag}) | pin vs mark drift max ${f(risk5.maxDriftPx)} px over ${risk5.frames} frames; ${risk5.redraws} redraws, ${risk5.dprChanges} DPR changes, moved displays: ${risk5.movedDisplays} | ${pass[5] ? "pass" : "FAIL"} |`,
    `| 6 (${tag}) | ${risk6.toggles} toggles: store equal ${risk6.storeEqual}; center drift max ${f(risk6.maxCenterDriftPx)} px; hidden rAF callbacks ${risk6.hiddenRafCallbacks}; 0x0 fits ${risk6.zeroFits} | ${pass[6] ? "pass" : "FAIL"} |`,
    `| 7 (${tag}) | stroke ${risk7.stroke.map((r) => `k ${f(r.k)}: ${f(r.renderedPx)} px`).join(", ")}; ruler tick drift max ${f(risk7.maxTickDriftPx)} px | ${pass[7] ? "pass" : "FAIL"} |`,
    `| CSP (${tag}) | ${csp.length} violations, ${consoleErrors.length} console errors | ${pass.csp ? "pass" : "FAIL"} |`,
  ];
  fs.writeFileSync(path.join(OUT, `summary-${tag}.md`), `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
  console.log(`SPIKE_DONE ${tag}`);
}

app.whenReady().then(main).then(() => app.quit(), (error) => {
  console.error(error);
  app.exit(1);
});
```

- [ ] **Step 7: Run the automated risks at DPR 2 and DPR 1**

The spike loads no native module, so no ABI switch is needed. Run from the worktree root:

```bash
pnpm --filter jevcode-desktop exec electron ~/Projects/jevcode-tv-c1b/apps/trace-viewer-dev/scripts/spike-electron.cjs
SPIKE_DPR=1 pnpm --filter jevcode-desktop exec electron ~/Projects/jevcode-tv-c1b/apps/trace-viewer-dev/scripts/spike-electron.cjs
```

Expected: each run prints eight table rows and `SPIKE_DONE dpr2` (then `SPIKE_DONE dpr1`); `apps/trace-viewer-dev/.spike/` holds `results-dpr2.json`, `results-dpr1.json`, `summary-dpr2.md`, `summary-dpr1.md` and six risk 3 crops per DPR. Keep the window on a 60 Hz display (ProMotion set to 60 Hz) for risk 2. Rows may read `FAIL`; a failure is a finding, not a task failure.

- [ ] **Step 8: HUMAN CHECK for risks 1 and 4 (the controller asks the user)**

The implementer stops here and hands the controller these two procedures; the controller asks the user to run them and report the numbers:

1. Risk 1 blind A/B. Hand-rolled side: `pnpm --filter jevcode-trace-viewer-dev exec vite --config vite.spike.config.ts`, open `http://localhost:5173/spike.html?bench=60x300&harness=canvas`. Comparison side: a scratch worktree (`git -C ~/Projects/jevcode worktree add --detach /tmp/jevcode-ab main`) where `packages/ui-catalog/src/components/ArchitectureDelta.tsx` lines 116-118 (`zoomOnScroll={false}`, `zoomOnPinch={false}`, `panOnDrag={false}`) become `zoomOnScroll={false}`, `zoomOnPinch`, `panOnDrag`, `panOnScroll`, then `pnpm install --frozen-lockfile && pnpm -r build && pnpm --filter jevcode-desktop rebuild && pnpm --filter jevcode-desktop start` and open a replayed fixture with an architecture delta. A second person randomizes the order of 10 trials (5 per controller); the tester uses a Magic Trackpad and a mouse (two-finger pan, pinch, wheel, Space-drag, H then drag, Shift+1, Shift+2) and names the controller each time. Pass: the hand-rolled controller is identified at most 7 times. Remove the scratch worktree afterwards (`git -C ~/Projects/jevcode worktree remove /tmp/jevcode-ab`).
2. Risk 4 VoiceOver. In the Electron run of `harness=canvas` (or the Vite page), turn on VoiceOver (Cmd+F5), focus the canvas, press `j` until an off-screen frame is reached, and confirm VoiceOver reads the frame's label in the form "Chapter 7, 1 failed, 14 passed, +0:40"; press Tab and Shift+Tab to confirm the focus order leaves and re-enters the canvas at the focused frame. Pass: every frame read, focus never lost.

- [ ] **Step 9: Write the spike document**

`docs/spikes/trace-viewer-spike.md` (paste the rows from `apps/trace-viewer-dev/.spike/summary-dpr2.md` and `summary-dpr1.md` into the "Automated results" table, the user's two answers into "Human checks", and one ruling per risk into "Rulings"):

````markdown
# Trace viewer rendering spike (R28)

Date: 2026-09-28 (update to the run date). Scene: `spike.html?bench=60x300`: 60 chapters at Step level (nine-row lists) plus 40 story frames (about 4k DOM nodes), 300 edges, 5k lane marks. Harness: `apps/trace-viewer-dev/src/spike/*`, driver `apps/trace-viewer-dev/scripts/spike-electron.cjs`, Electron 33 hidden-then-shown window under the Electron CSP (`vite.spike.config.ts`).

## Machine

| Item | Value |
|---|---|
| Model, CPU, memory | (from About This Mac) |
| OS | (from `sw_vers`) |
| Electron / Chromium | (from `pnpm --filter jevcode-desktop exec electron --version` and `process.versions.chrome`) |
| Displays | (DPR 2 panel; DPR 1 via `SPIKE_DPR=1`) |
| Refresh rate | 60 Hz |

## Pass criteria (spec §16, verbatim)

| # | Risk | Pass |
|---|---|---|
| 1 | Gesture feel and Electron input | `visualViewport.scale` stays 1 and the viewport's `scrollLeft`/`scrollTop` stay 0 throughout; during a pinch the world point under the cursor moves ≤ 1 px per event; in 10 blind trials (5 per controller, order randomized by a second person) the tester identifies the hand-rolled controller at most 7 times |
| 2 | DOM raster cost during pinch at Step level | ≤ 5% of frames dropped (rounded intervals, 60 Hz, §10) on Chromium 130 without `will-change`; if only with it, keep it gesture-only |
| 3 | Text crispness at rest | After settle at each zoom and DPR, a `capturePage` crop of a frame title differs from the same title rendered without a transform at `font-size × k` in ≤ 1% of pixels (any channel differing by > 16) |
| 4 | Keyboard and VoiceOver | VoiceOver reads the frame's `aria-label` ("Linking test, 1 failed, 14 passed, +0:33"); after every j/k, `document.activeElement` is the target frame and its rect lies inside the viewport inset by 48 px |
| 5 | Hybrid DOM/canvas alignment | ≤ 1 px drift; redraw on `devicePixelContentBoxSize` change |
| 6 | View switch under `<Activity>` | Selection, playhead and brush deep-equal before and after; the time at the viewport center maps to within 1 px on the shown view's x map; the hidden view runs zero rAF callbacks; no 0 × 0 fit |
| 7 | Edge hairlines and ruler sync | 1.5 CSS px after settle; ticks within 1 px |

## Automated results

| # | Measured | Result |
|---|---|---|
<!-- rows from .spike/summary-dpr2.md, then .spike/summary-dpr1.md -->

## Human checks

| # | Check | Answer | Result |
|---|---|---|---|
| 1 | Blind A/B, 10 trials | hand-rolled identified N of 10 times | pass when N ≤ 7 |
| 4 | VoiceOver reads each frame label; Tab order | as reported by the user | pass or fail |

## Rulings

| # | Result | Ruling applied | Owner |
|---|---|---|---|
| 1 | pass or fail | pass: none. Fail: d3-zoom behind the controller API | C1-7F (this lane, before W1 merges) |
| 2 | pass or fail | pass: none. Pass only with will-change: keep gesture-time `will-change`. Fail: x0 binary-search culling and capped Step lists | C3-5 / C3-7 |
| 3 | pass or fail | pass: none. Fail: `settleRoundK: 64` at the Canvas call site | C3-5 |
| 4 | pass or fail | pass: none. Fail: each frame's full description in its Outline row | C2-5 |
| 5 | pass or fail | pass: none. Fail: paint pins on the canvas; DOM buttons only as focus targets | C2-11 |
| 6 | pass or fail | pass: none. Fail: `KEEP_HIDDEN_VIEWS_MOUNTED = false` | C3-5 |
| 7 | pass or fail | pass: none. Fail: `INV_K_EVERY_FRAME = true` in `views/canvas/World.tsx` | C3-5 |
````

Replace every "pass or fail", "(from …)" and "as reported by the user" cell with the measured value and delete the HTML comment line. Check: `grep -cE "pass or fail|\(from |as reported by the user|<!--" docs/spikes/trace-viewer-spike.md` prints `0`.

- [ ] **Step 10: Root checks**

```bash
pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint
```

Expected: each exits 0 (`apps/**/scripts/**` is outside ESLint; the harness `src/spike/**` is linted and typechecked).

- [ ] **Step 11: Commit (after the controller confirms the HUMAN CHECK answers are in the document)**

```bash
git add apps/trace-viewer-dev/spike.html apps/trace-viewer-dev/vite.spike.config.ts apps/trace-viewer-dev/.gitignore apps/trace-viewer-dev/src/vite-env.d.ts apps/trace-viewer-dev/src/spike/main.tsx apps/trace-viewer-dev/src/spike/synthetic.ts apps/trace-viewer-dev/src/spike/measure.ts apps/trace-viewer-dev/src/spike/CanvasHarness.tsx apps/trace-viewer-dev/src/spike/OverviewHarness.tsx apps/trace-viewer-dev/src/spike/SwitchHarness.tsx apps/trace-viewer-dev/src/spike/spike.module.css apps/trace-viewer-dev/scripts/spike-electron.cjs docs/spikes/trace-viewer-spike.md
git commit -m "docs(spikes): trace viewer rendering spike harness and rulings"
```

### Task C1-7F (conditional): d3-zoom behind the controller API

Run this task only when the spike document's risk 1 row reads fail. When risk 1 passes, add the line "C1-7F skipped: risk 1 passed." under "Rulings" in `docs/spikes/trace-viewer-spike.md`, commit it (`git add docs/spikes/trace-viewer-spike.md && git commit -m "docs(spikes): record that the d3-zoom fallback is not needed"`), and continue with C1-8.

**Files:**
- Create: `packages/trace-viewer/src/ui/viewport/d3-controller.ts`
- Modify: `packages/trace-viewer/src/ui/viewport/controller.ts`
- Modify: `packages/trace-viewer/src/ui/viewport/controller.test.ts`
- Modify: `docs/spikes/trace-viewer-spike.md`

**Interfaces:**
- Consumes (C1-6): `createViewportCore`, `type ViewportControllerOptions`, `type ViewportController`, `type ViewportCore`; (C1-5) `clampCamera`, `wheelZoomFactor`; `select` from `d3-selection` 3.0.0, `zoom`, `zoomIdentity`, `type D3ZoomEvent`, `type ZoomTransform` from `d3-zoom` 3.0.0 (both W0 dependencies per UI index §1.1a).
- Produces: `createViewportController` keeps its signature and now returns the d3-backed controller; `createHandRolledViewportController` keeps the C1-6 implementation for comparison.

```ts
// ui/viewport/d3-controller.ts
export function createD3ViewportController<C extends Camera>(options: ViewportControllerOptions<C>): ViewportController<C>;
// ui/viewport/controller.ts
export function createHandRolledViewportController<C extends Camera>(options: ViewportControllerOptions<C>): ViewportController<C>;
export { createD3ViewportController as createViewportController } from "./d3-controller.js";
```

- [ ] **Step 1: Add the failing test**

Append to `packages/trace-viewer/src/ui/viewport/controller.test.ts` (the existing suite stays unchanged and now runs against the d3 implementation):

```ts
describe("d3-zoom fallback (C1-7F)", () => {
  it("createViewportController is backed by d3-zoom", () => {
    const h = setup();
    expect((h.element as HTMLDivElement & { __zoom?: { k: number } }).__zoom?.k).toBe(1);
    wheel(h.element, { deltaY: -10, ctrlKey: true, clientX: 200, clientY: 100 });
    h.flush();
    expect((h.element as HTMLDivElement & { __zoom?: { k: number } }).__zoom?.k).toBeCloseTo(2 ** 0.2, 12);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/viewport/controller.test.ts`
Expected: FAIL in "createViewportController is backed by d3-zoom" (`expected undefined to be 1`); the other 11 pass.

- [ ] **Step 3: Write the d3 implementation and swap the export**

`packages/trace-viewer/src/ui/viewport/d3-controller.ts`:

```ts
import { select } from "d3-selection";
import { zoom, zoomIdentity, type D3ZoomEvent, type ZoomTransform } from "d3-zoom";

import { clampCamera, wheelZoomFactor, type Camera } from "../../layout/viewport.js";
import { createViewportCore, type ViewportController, type ViewportControllerOptions } from "./controller.js";

function toTransform(camera: Camera): ZoomTransform {
  if (camera.mode === "uniform") return zoomIdentity.translate(camera.tx, camera.ty).scale(camera.k);
  return zoomIdentity.translate(-camera.u0 * camera.k, 0).scale(camera.k);
}

function fromTransform<C extends Camera>(template: C, t: ZoomTransform): C {
  const cam = template as Camera;
  if (cam.mode === "uniform") return { mode: "uniform", tx: t.x, ty: t.y, k: t.k } as C;
  return { mode: "xOnly", u0: -t.x / t.k, k: t.k } as C;
}

/** Spike risk 1 fallback: d3-zoom owns Ctrl/Meta+wheel zoom; the core keeps pan, frames, settle and tweens. */
export function createD3ViewportController<C extends Camera>(options: ViewportControllerOptions<C>): ViewportController<C> {
  const selection = select<HTMLElement, unknown>(options.element);
  let syncing = false;
  const sync = (camera: C): void => {
    syncing = true;
    behavior.transform(selection, toTransform(camera));
    syncing = false;
  };
  const core = createViewportCore<C>({
    ...options,
    wheelZoom: false,
    onFrame(camera, phase) {
      // Keep d3's stored transform equal to the core camera, so a pinch that follows a pan starts from it.
      sync(camera);
      options.onFrame(camera, phase);
    },
  });
  const behavior = zoom<HTMLElement, unknown>()
    .filter((event: Event) => event.type === "wheel" && ((event as WheelEvent).ctrlKey || (event as WheelEvent).metaKey))
    .wheelDelta((event: WheelEvent) => Math.log2(wheelZoomFactor(event.deltaY, event.deltaMode as 0 | 1 | 2, options.viewport().h)))
    .scaleExtent([options.limits().minK, options.limits().maxK])
    .on("zoom", (event: D3ZoomEvent<HTMLElement, unknown>) => {
      if (syncing || event.sourceEvent === null) return;
      behavior.scaleExtent([options.limits().minK, options.limits().maxK]);
      const next = fromTransform(core.get(), event.transform);
      const clamped = clampCamera(next, options.content(), options.viewport(), options.limits());
      core.gestureTo(clamped, "zoom");
      if (clamped !== next) sync(core.get());
    });
  selection.call(behavior).on("dblclick.zoom", null);
  sync(options.initial);
  return {
    get: core.get,
    set: core.set,
    zoomBy: core.zoomBy,
    panBy: core.panBy,
    isGesturing: core.isGesturing,
    destroy() {
      selection.on(".zoom", null);
      core.destroy();
    },
  };
}
```

Modify `packages/trace-viewer/src/ui/viewport/controller.ts`. Current last function:

```ts
export function createViewportController<C extends Camera>(options: ViewportControllerOptions<C>): ViewportController<C> {
  return createViewportCore(options);
}
```

Replace it with:

```ts
/** The C1-6 controller, kept for side-by-side comparison in the spike. */
export function createHandRolledViewportController<C extends Camera>(options: ViewportControllerOptions<C>): ViewportController<C> {
  return createViewportCore(options);
}

// Spike risk 1 ruling (docs/spikes/trace-viewer-spike.md): d3-zoom behind the same API.
export { createD3ViewportController as createViewportController } from "./d3-controller.js";
```

The two modules import each other; this is safe because `d3-controller.ts` reads `createViewportCore` (a hoisted function declaration) only when `createD3ViewportController` runs.

- [ ] **Step 4: Run the suite against the d3 implementation**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/viewport/controller.test.ts`
Expected: PASS, 12 tests. If a C1-6 test fails, the d3 wiring is wrong; the C1-6 tests are the API contract and do not change.

- [ ] **Step 5: Re-run the spike's risk 1 and record it**

Run: `pnpm -r build && pnpm --filter jevcode-trace-viewer-dev exec vite build --config vite.spike.config.ts && pnpm --filter jevcode-desktop exec electron ~/Projects/jevcode-tv-c1b/apps/trace-viewer-dev/scripts/spike-electron.cjs`
Expected: `SPIKE_DONE dpr2`. Add a "Risk 1 with d3-zoom" row under "Automated results" from the new `summary-dpr2.md` line 1, repeat the risk 1 HUMAN CHECK (Step 8 of C1-7) against the d3 build, and set the risk 1 ruling row to "d3-zoom applied (C1-7F)".

- [ ] **Step 6: Root checks**

```bash
pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint
```

Expected: each exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/trace-viewer/src/ui/viewport/d3-controller.ts packages/trace-viewer/src/ui/viewport/controller.ts packages/trace-viewer/src/ui/viewport/controller.test.ts docs/spikes/trace-viewer-spike.md
git commit -m "feat(trace-viewer): d3-zoom fallback behind the viewport controller API"
```

### Task C1-8: Session builders and fast-check arbitraries (test-only)

**Files:**
- Create: `packages/trace-viewer/src/test-support/session-builder.ts`
- Create: `packages/trace-viewer/src/test-support/arbitraries.ts`
- Test: `packages/trace-viewer/src/test-support/session-builder.test.ts`

`src/test-support/**` is excluded from `tsconfig.build.json` and from the ESLint trace-viewer blocks (W0), so these files may use `Date` and fast-check; no production module imports them.

**Interfaces:**
- Consumes (W0 model types, UI index §1.2 amended): `type TraceSession`, `type Step`, `type Turn`, `type Chapter`, `type Finding`, `type Entity`, `type Gap`, `type StepKind`, `type StepStatus`, `type Lane`, `type Actor`, `type NoiseReason`, `type ProblemKind`, `type Severity`, `type SignalId`, `type TurnTrigger`, `type TurnOutcome`, `type GapKind`, `type CommandDetail`, `type TestDetail`, `type EditDetail`, `type DecisionDetail`, `type GuardrailDetail`, `type ClaimObservation`, `STEP_KINDS`, `NOISE_REASONS`, `SIGNAL_IDS`, `CAPABILITIES`, `TRACE_SCHEMA_VERSION`, `stepStableId`, `unitStableId`, `decisionStableId`, `fileStableId`, `findingStableId` from `../model/index.js`; `type AgentState`, `type ChangeCategory`, `type ChangeUnitStatus` from `@jevcode/contracts`.
- Produces (test-only; used by C1-9…C1-14 and by C2/C3 tests):

```ts
// test-support/session-builder.ts
export const LANE_OF_KIND: { readonly [K in StepKind]: Lane };   // local copy of UI index §1.4 B-2
export const DEFAULT_ORIGIN_MS: number;                          // Date.parse("2026-09-18T09:00:00.000Z")
export interface StepSeed {
  kind: StepKind; tMs: number; durationMs?: number | null; status?: StepStatus; headline?: string; target?: string; text?: string;
  turn?: number; rows?: number; chapter?: string; noise?: NoiseReason | null; problems?: ProblemKind[];
  command?: Partial<CommandDetail>; tests?: Partial<TestDetail>; edit?: Partial<EditDetail>;
  decision?: Partial<DecisionDetail>; guardrail?: Partial<GuardrailDetail>; callId?: string;
}
export interface ChapterSeed { id: string; title: string; category?: ChangeCategory; status?: ChangeUnitStatus; noise?: boolean; current?: boolean; factSeqs?: number[] }
export interface FindingSeed { ruleId: SignalId; severity: Severity; step: number; evidence?: number[]; claimSpan?: [number, number]; headline?: string }
export interface TurnSeed { trigger: TurnTrigger; prompt: string; outcome?: TurnOutcome; planStep?: number; claimStep?: number }
export interface GapSeed { kind: GapKind; beforeStep: number; message?: string }
export interface SessionSeed {
  sessionId?: string; repoName?: string; prompt?: string; originMs?: number; state?: AgentState; live?: boolean;
  turns?: TurnSeed[]; steps: StepSeed[]; chapters?: ChapterSeed[]; findings?: FindingSeed[]; gaps?: GapSeed[];
  approximateJoins?: boolean; trailingHiddenRows?: number;
}
export function buildSession(seed: SessionSeed): TraceSession;
export function claimSpanOf(text: string, phrase: string): [number, number];
export const OAUTH_CLAIM_TEXT: "OAuth implementation complete; all checks pass.";
export const OAUTH_PROMPT: "Add Google OAuth login while preserving existing email/password accounts.";
/** Mirrors fixtures/oauth: intent, plan, 3 chapters, Noise ×2, decision, 2 linking chapters, failed pnpm test 14/1/0 at +0:35 for 5.0 s, claim at +0:43. */
export function oauthLikeSession(): TraceSession;
export function largeSession(options?: { chapters?: number; steps?: number; seed?: number }): TraceSession;
// test-support/arbitraries.ts
export interface ArbSessionOptions { maxSteps?: number; maxChapters?: number; maxTurns?: number; live?: boolean }
export function arbSessionSeed(options?: ArbSessionOptions): fc.Arbitrary<SessionSeed>;
export function arbTraceSession(options?: ArbSessionOptions): fc.Arbitrary<TraceSession>;
```

- [ ] **Step 1: Write the failing test**

`packages/trace-viewer/src/test-support/session-builder.test.ts`:

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { TraceSession } from "../model/index.js";
import { arbTraceSession } from "./arbitraries.js";
import { buildSession, LANE_OF_KIND, largeSession, OAUTH_CLAIM_TEXT, oauthLikeSession } from "./session-builder.js";

function sortedBySeqThenId<T extends { id: string }>(items: readonly T[], seqOf: (item: T) => number): boolean {
  return items.every((item, i) => {
    const prev = items[i - 1];
    if (prev === undefined) return true;
    return seqOf(prev) < seqOf(item) || (seqOf(prev) === seqOf(item) && prev.id <= item.id);
  });
}

function checkInvariants(session: TraceSession): void {
  const ids = new Set<string>();
  let prevT = 0;
  for (const step of session.steps) {
    expect(ids.has(step.id)).toBe(false);
    ids.add(step.id);
    expect(step.id).toBe(`step:${step.firstSeq}`);
    expect(step.seqs[0]).toBe(step.firstSeq);
    expect(step.seqs.at(-1)).toBe(step.lastSeq);
    expect(step.tMs).toBeGreaterThanOrEqual(prevT);
    prevT = step.tMs;
    expect(step.lane).toBe(LANE_OF_KIND[step.kind]);
    expect(step.startMs).toBe(session.originMs + step.tMs);
    if (step.problems.length > 0 || step.findingIds.length > 0) expect(step.noise).toBeNull();
  }
  expect(sortedBySeqThenId(session.steps, (s) => s.firstSeq)).toBe(true);
  expect(sortedBySeqThenId(session.chapters, (c) => c.firstSeq)).toBe(true);
  expect(sortedBySeqThenId(session.findings, (f) => f.anchorSeq)).toBe(true);
  for (const finding of session.findings) {
    const anchor = session.steps.find((s) => s.id === finding.anchorStepId);
    expect(anchor?.seqs).toContain(finding.anchorSeq);
    expect(anchor?.findingIds).toContain(finding.id);
  }
  const last = session.steps.at(-1);
  expect(session.loadedThroughSeq).toBeGreaterThanOrEqual(last?.lastSeq ?? 0);
  expect(session.meta.lastEventSeq).toBe(session.loadedThroughSeq);
}

describe("buildSession", () => {
  it("assigns seqs in order, step ids, lanes and display times", () => {
    const session = buildSession({
      steps: [
        { kind: "instruction", tMs: 0, text: "Do it" },
        { kind: "command", tMs: 2_000, target: "pnpm test", rows: 3 },
        { kind: "message", tMs: 1_000, text: "earlier ts is clamped" },
      ],
    });
    expect(session.steps.map((s) => s.id)).toEqual(["step:1", "step:2", "step:5"]);
    expect(session.steps.map((s) => s.tMs)).toEqual([0, 2_000, 2_000]);
    expect(session.steps[1]?.command).toEqual({ command: "pnpm test", exitCode: 0 });
    expect(session.steps[1]?.lane).toBe("commands");
    expect(session.loadedThroughSeq).toBe(5);
    checkInvariants(session);
  });

  it("never marks a step with a problem or finding as noise", () => {
    const session = buildSession({
      steps: [{ kind: "command", tMs: 0, target: "rm -rf dist", noise: "duplicate_poll" }],
      findings: [{ ruleId: "destructive_command", severity: "critical", step: 0 }],
    });
    expect(session.steps[0]?.noise).toBeNull();
    expect(session.steps[0]?.problems).toContain("destructive");
  });

  it("mirrors oauth: one failed test step 14/1/0 at +0:35 for 5.0 s and the contradicted claim at +0:43", () => {
    const session = oauthLikeSession();
    checkInvariants(session);
    const tests = session.steps.filter((s) => s.kind === "test");
    expect(tests).toHaveLength(1);
    expect(tests[0]).toMatchObject({ tMs: 35_000, durationMs: 5_000, status: "failed", tests: { passed: 14, failed: 1, skipped: 0 } });
    const claim = session.steps.find((s) => s.text === OAUTH_CLAIM_TEXT);
    expect(claim?.tMs).toBe(43_000);
    const contradiction = session.findings.find((f) => f.ruleId === "claim_contradicted");
    expect(contradiction).toMatchObject({ severity: "critical", anchorStepId: claim?.id, claimStepId: claim?.id, evidenceStepIds: [tests[0]?.id] });
    const span = contradiction?.claimSpan;
    expect(span === undefined ? "" : OAUTH_CLAIM_TEXT.slice(span[0], span[1])).toBe("all checks pass");
    expect(session.chapters).toHaveLength(7);
    expect(session.chapters.filter((c) => c.noise)).toHaveLength(2);
    expect(session.chapters.find((c) => c.title === "Linking test")?.tMs).toBe(33_000);
    expect(session.steps.filter((s) => s.kind === "decision")).toHaveLength(1);
    expect(session.turns[0]?.claimStepId).toBe(claim?.id);
  });

  it("largeSession builds 60 chapters over 5k steps deterministically", () => {
    const a = largeSession();
    expect(a.steps).toHaveLength(5_000);
    expect(a.chapters).toHaveLength(60);
    expect(largeSession().steps.map((s) => s.tMs)).toEqual(a.steps.map((s) => s.tMs));
    checkInvariants(a);
  });

  it("arbitrary sessions satisfy the W0 invariants", () => {
    fc.assert(fc.property(arbTraceSession({ maxSteps: 60, maxChapters: 5, maxTurns: 3 }), (session) => {
      checkInvariants(session);
    }), { numRuns: 100 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/test-support/session-builder.test.ts`
Expected: FAIL, `Failed to resolve import "./arbitraries.js"`.

- [ ] **Step 3: Write the builder**

`packages/trace-viewer/src/test-support/session-builder.ts`:

```ts
import type { AgentState, ChangeCategory, ChangeUnitStatus } from "@jevcode/contracts";

import {
  CAPABILITIES, decisionStableId, fileStableId, findingStableId, SIGNAL_IDS, stepStableId, TRACE_SCHEMA_VERSION, unitStableId,
  type Actor, type Chapter, type ClaimObservation, type CommandDetail, type DecisionDetail, type EditDetail, type Entity,
  type Finding, type Gap, type GapKind, type GuardrailDetail, type Lane, type NoiseReason, type ProblemKind, type Severity,
  type SignalId, type Step, type StepKind, type StepStatus, type TestDetail, type TraceSession, type Turn, type TurnOutcome,
  type TurnTrigger,
} from "../model/index.js";

/** Local copy of UI index §1.4 B-2 (KIND_META[kind].lane), so W1 tests do not need lane B. */
export const LANE_OF_KIND: { readonly [K in StepKind]: Lane } = {
  instruction: "supervisor", approval: "supervisor", decision: "supervisor",
  message: "agent", reasoning: "agent", tool: "agent", lifecycle: "agent",
  command: "commands",
  edit: "edits", read: "edits", dependency: "edits", revert: "edits",
  test: "tests", check: "tests",
  guardrail: "jev", attention: "jev",
};

const ACTOR_OF_KIND: { readonly [K in StepKind]: Actor } = {
  instruction: "supervisor", approval: "supervisor", decision: "supervisor",
  message: "agent", reasoning: "agent", tool: "agent", lifecycle: "agent", command: "agent", test: "agent",
  check: "agent", edit: "agent", read: "agent", dependency: "repo", revert: "repo", guardrail: "jevcode", attention: "jevcode",
};

const TIMED: ReadonlySet<StepKind> = new Set<StepKind>(["command", "test", "check", "tool"]);
const EDIT_LIKE: ReadonlySet<StepKind> = new Set<StepKind>(["edit", "dependency", "revert"]);

export const DEFAULT_ORIGIN_MS = Date.parse("2026-09-18T09:00:00.000Z");

export interface StepSeed {
  kind: StepKind;
  tMs: number;
  /** Default: 1,000 for command, test, check and tool; 0 otherwise; null = running. */
  durationMs?: number | null;
  status?: StepStatus;
  headline?: string;
  target?: string;
  text?: string;
  turn?: number;
  /** Seqs this step folds (default 1). */
  rows?: number;
  /** Change unit id without the "unit:" prefix. */
  chapter?: string;
  noise?: NoiseReason | null;
  problems?: ProblemKind[];
  command?: Partial<CommandDetail>;
  tests?: Partial<TestDetail>;
  edit?: Partial<EditDetail>;
  decision?: Partial<DecisionDetail>;
  guardrail?: Partial<GuardrailDetail>;
  callId?: string;
}
export interface ChapterSeed { id: string; title: string; category?: ChangeCategory; status?: ChangeUnitStatus; noise?: boolean; current?: boolean; factSeqs?: number[] }
export interface FindingSeed { ruleId: SignalId; severity: Severity; step: number; evidence?: number[]; claimSpan?: [number, number]; headline?: string }
export interface TurnSeed { trigger: TurnTrigger; prompt: string; outcome?: TurnOutcome; planStep?: number; claimStep?: number }
export interface GapSeed { kind: GapKind; beforeStep: number; message?: string }
export interface SessionSeed {
  sessionId?: string;
  repoName?: string;
  prompt?: string;
  originMs?: number;
  state?: AgentState;
  live?: boolean;
  turns?: TurnSeed[];
  steps: StepSeed[];
  chapters?: ChapterSeed[];
  findings?: FindingSeed[];
  gaps?: GapSeed[];
  approximateJoins?: boolean;
  /** Seqs the source filtered out after the last step (Hidden.unreceived). */
  trailingHiddenRows?: number;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const bySeqThenId = <T extends { id: string }>(seqOf: (item: T) => number) =>
  (a: T, b: T): number => seqOf(a) - seqOf(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function defaultStatus(seed: StepSeed, durationMs: number | null): StepStatus {
  if (seed.status !== undefined) return seed.status;
  if (TIMED.has(seed.kind)) return durationMs === null ? "running" : "ok";
  if (EDIT_LIKE.has(seed.kind) || seed.kind === "decision") return "ok";
  return "info";
}

function defaultProblems(seed: StepSeed, status: StepStatus): ProblemKind[] {
  if (seed.problems !== undefined) return [...seed.problems];
  if (status !== "failed") return [];
  if (seed.kind === "test" || seed.kind === "check") return (seed.tests?.failed ?? 0) > 0 ? ["tests_failed"] : ["exit_nonzero"];
  if (seed.kind === "command" || seed.kind === "tool") return ["exit_nonzero"];
  return [];
}

function exitCodeFor(status: StepStatus): number | null {
  if (status === "running") return null;
  if (status === "failed") return 1;
  if (status === "unknown") return -1;
  return 0;
}

const PROBLEM_OF_RULE: Partial<Record<SignalId, ProblemKind>> = {
  claim_contradicted: "claim_contradicted",
  destructive_command: "destructive",
};

export function buildSession(seed: SessionSeed): TraceSession {
  const origin = seed.originMs ?? DEFAULT_ORIGIN_MS;
  const state: AgentState = seed.state ?? "completed";
  const live = seed.live ?? (state === "starting" || state === "running" || state === "waiting_decision");
  const turnSeeds: TurnSeed[] = seed.turns ?? [{ trigger: "initial", prompt: seed.prompt ?? "Build the feature." }];
  const gaps: Gap[] = [];
  const steps: Step[] = [];
  let seq = 0;
  let prevT = 0;

  seed.steps.forEach((s, index) => {
    for (const g of seed.gaps ?? []) {
      if (g.beforeStep !== index) continue;
      seq += 1;
      gaps.push({ kind: g.kind, atSeq: seq, message: g.message ?? `${g.kind} at seq ${seq}` });
    }
    const rows = Math.max(1, s.rows ?? 1);
    const firstSeq = seq + 1;
    seq += rows;
    const tMs = Math.max(prevT, s.tMs, 0);
    prevT = tMs;
    const durationMs = s.durationMs !== undefined ? s.durationMs : TIMED.has(s.kind) ? 1_000 : 0;
    const status = defaultStatus(s, durationMs);
    const step: Step = {
      id: stepStableId(firstSeq),
      kind: s.kind,
      lane: LANE_OF_KIND[s.kind],
      actor: ACTOR_OF_KIND[s.kind],
      provenance: "observed",
      status,
      headline: s.headline ?? s.target ?? s.text ?? s.kind,
      turnIndex: s.turn ?? 0,
      seqs: Array.from({ length: rows }, (_, r) => firstSeq + r),
      firstSeq,
      lastSeq: seq,
      startTs: iso(origin + tMs),
      endTs: durationMs === null ? null : iso(origin + tMs + durationMs),
      startMs: origin + tMs,
      tMs,
      endTMs: durationMs === null ? null : tMs + durationMs,
      durationMs,
      approxTime: false,
      evidenceSeqs: [],
      chapterIds: s.chapter === undefined ? [] : [unitStableId(s.chapter)],
      entityIds: [],
      findingIds: [],
      problems: defaultProblems(s, status),
      noise: s.noise ?? null,
    };
    if (s.target !== undefined) step.target = s.target;
    if (s.text !== undefined) step.text = s.text;
    if (s.callId !== undefined) step.callId = s.callId;
    if (s.kind === "command" || s.kind === "test" || s.kind === "check") {
      step.command = { command: s.target ?? step.headline, exitCode: exitCodeFor(status), ...s.command };
    }
    if (s.kind === "test" || s.tests !== undefined) {
      step.tests = { passed: 0, failed: 0, skipped: 0, failures: [], ...s.tests };
    }
    if (EDIT_LIKE.has(s.kind) && s.target !== undefined) {
      step.edit = {
        path: s.target, added: 0, removed: 0, claimed: true, observed: true, diff: "text", lockfile: false, formattingOnly: false,
        ...s.edit,
      };
      step.entityIds = [fileStableId(step.edit.path)];
    }
    if (s.kind === "decision") {
      step.decision = {
        decisionId: `dec-${firstSeq}`, title: step.headline, severity: "required", status: "answered", options: [],
        decidedBy: "supervisor", ...s.decision,
      };
      step.target ??= step.decision.decisionId;
    }
    if (s.kind === "guardrail") {
      step.guardrail = { clampIds: [], clientKind: "typesafe", confidence: 1, ...s.guardrail };
    }
    steps.push(step);
  });

  const findings: Finding[] = [];
  for (const f of seed.findings ?? []) {
    const anchor = steps[f.step];
    if (anchor === undefined) continue;
    const id = findingStableId(f.ruleId, 1, anchor.firstSeq);
    if (findings.some((x) => x.id === id)) continue;
    const evidence = (f.evidence ?? []).map((i) => steps[i]).filter((s): s is Step => s !== undefined);
    const finding: Finding = {
      id, ruleId: f.ruleId, ruleVersion: 1, severity: f.severity, anchorSeq: anchor.firstSeq,
      headline: f.headline ?? f.ruleId, reason: "", stepIds: [anchor.id, ...evidence.map((e) => e.id)],
      chapterIds: [...anchor.chapterIds], evidenceSeqs: evidence.map((e) => e.firstSeq), anchorStepId: anchor.id,
    };
    if (f.ruleId === "claim_contradicted") {
      finding.claimStepId = anchor.id;
      finding.evidenceStepIds = evidence.map((e) => e.id);
      if (f.claimSpan !== undefined) finding.claimSpan = f.claimSpan;
      const observedStep = evidence[0];
      if (observedStep !== undefined) {
        const claim: ClaimObservation = {
          claim: { text: anchor.text ?? "", seq: anchor.firstSeq, tMs: anchor.tMs, stepId: anchor.id },
          observed: {
            command: observedStep.command?.command ?? observedStep.target ?? "",
            passed: observedStep.tests?.passed ?? 0, failed: observedStep.tests?.failed ?? 0, skipped: observedStep.tests?.skipped ?? 0,
            seq: observedStep.firstSeq, tMs: observedStep.tMs, stepId: observedStep.id,
          },
        };
        finding.claim = claim;
      }
    }
    anchor.findingIds.push(id);
    const problem = PROBLEM_OF_RULE[f.ruleId] ?? (f.ruleId === "guardrail_clamp" && f.severity !== "info" ? "guardrail" : undefined);
    if (problem !== undefined && !anchor.problems.includes(problem)) anchor.problems.push(problem);
    findings.push(finding);
  }
  for (const step of steps) if (step.problems.length > 0 || step.findingIds.length > 0) step.noise = null;
  findings.sort(bySeqThenId((f) => f.anchorSeq));

  const lastSeq = seq;
  const loadedThroughSeq = lastSeq + (seed.trailingHiddenRows ?? 0);
  const endMs = steps.reduce((max, s) => Math.max(max, s.endTMs ?? s.tMs), 0);

  const turns: Turn[] = turnSeeds.map((t, index) => {
    const own = steps.filter((s) => s.turnIndex === index);
    const first = own[0];
    const lastStep = own.at(-1);
    const turn: Turn = {
      index,
      trigger: t.trigger,
      prompt: t.prompt,
      outcome: t.outcome ?? (live && index === turnSeeds.length - 1 ? "running" : "completed"),
      startSeq: first?.firstSeq ?? Math.max(1, lastSeq),
      endSeq: lastStep?.lastSeq ?? Math.max(1, lastSeq),
      startTs: iso(origin + (first?.tMs ?? endMs)),
      endTs: iso(origin + own.reduce((m, s) => Math.max(m, s.endTMs ?? s.tMs), first?.tMs ?? endMs)),
      tMs: first?.tMs ?? endMs,
      endTMs: own.reduce((m, s) => Math.max(m, s.endTMs ?? s.tMs), first?.tMs ?? endMs),
      stepIds: own.map((s) => s.id),
    };
    const plan = t.planStep === undefined ? undefined : steps[t.planStep];
    const claim = t.claimStep === undefined ? undefined : steps[t.claimStep];
    if (plan !== undefined) turn.planStepId = plan.id;
    if (claim !== undefined) turn.claimStepId = claim.id;
    return turn;
  });

  const chapters: Chapter[] = (seed.chapters ?? []).map((c) => {
    const id = unitStableId(c.id);
    const own = steps.filter((s) => s.chapterIds.includes(id));
    const firstSeq = own[0]?.firstSeq ?? c.factSeqs?.[0] ?? 1;
    const tMs = own[0]?.tMs ?? 0;
    const endTMs = own.reduce((m, s) => Math.max(m, s.endTMs ?? s.tMs), tMs);
    const status = c.status ?? "validated";
    return {
      id, changeUnitId: c.id, title: c.title, category: c.category ?? "implementation", status,
      files: [...new Set(own.flatMap((s) => (s.edit === undefined ? [] : [s.edit.path])))],
      link: seed.approximateJoins === true ? "inferred" : "observed",
      evidenceLinks: { cited: 0, resolved: 0, approx: 0 },
      firstSeq, lastSeq: own.reduce((m, s) => Math.max(m, s.lastSeq), firstSeq), versions: 1,
      startTs: iso(origin + tMs), endTs: iso(origin + endTMs), tMs, endTMs,
      stepIds: own.map((s) => s.id), factSeqs: [...(c.factSeqs ?? [])],
      decisionIds: own.flatMap((s) => (s.decision === undefined ? [] : [decisionStableId(s.decision.decisionId)])),
      validationIds: [], clampIds: [], triad: {}, schemaChanges: [], dependencyChanges: [],
      findingIds: findings.filter((f) => f.chapterIds.includes(id)).map((f) => f.id),
      noise: c.noise ?? false, current: c.current ?? status !== "superseded",
      validationStepIds: own.filter((s) => s.kind === "test" || s.kind === "check").map((s) => s.id),
    };
  });
  chapters.sort(bySeqThenId((c) => c.firstSeq));

  const entityMap = new Map<string, Entity>();
  for (const step of steps) {
    if (step.edit === undefined) continue;
    const entityId = fileStableId(step.edit.path);
    const entity = entityMap.get(entityId) ?? {
      id: entityId, kind: "file", path: step.edit.path, label: step.edit.path, added: 0, removed: 0,
      claimed: false, observed: false, stepIds: [], chapterIds: [],
    };
    entity.added += step.edit.added;
    entity.removed += step.edit.removed;
    entity.claimed ||= step.edit.claimed;
    entity.observed ||= step.edit.observed;
    entity.stepIds.push(step.id);
    for (const chapterId of step.chapterIds) if (!entity.chapterIds.includes(chapterId)) entity.chapterIds.push(chapterId);
    entityMap.set(entityId, entity);
  }

  const terminal = state === "completed" || state === "failed";
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    meta: {
      sessionId: seed.sessionId ?? "sess-test-0001", repoId: "repo-test", repoName: seed.repoName ?? "acme-app",
      prompt: turnSeeds[0]?.prompt ?? "", state, startedAt: iso(origin), endedAt: terminal ? iso(origin + endMs) : null,
      lastEventSeq: loadedThroughSeq,
    },
    live,
    loadedThroughSeq,
    originMs: origin,
    span: { startTs: iso(origin), endTs: iso(origin + endMs), durationMs: endMs },
    turns,
    steps,
    chapters,
    entities: [...entityMap.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    findings,
    gaps,
    coverage: {
      capabilities: [...CAPABILITIES],
      signals: SIGNAL_IDS.map((id) => ({ id, active: true, missing: [] })),
      approximateJoins: seed.approximateJoins ?? false,
      inferredSteps: 0,
    },
    hidden: { byType: {}, unreceived: seed.trailingHiddenRows ?? 0 },
  };
}

export function claimSpanOf(text: string, phrase: string): [number, number] {
  const start = text.indexOf(phrase);
  if (start < 0) throw new Error(`"${phrase}" not in "${text}"`);
  return [start, start + phrase.length];
}

export const OAUTH_PROMPT = "Add Google OAuth login while preserving existing email/password accounts.";
export const OAUTH_CLAIM_TEXT = "OAuth implementation complete; all checks pass.";

/** Mirrors fixtures/oauth/events.jsonl by content (times from its ts fields, origin 09:00:00.000). */
export function oauthLikeSession(): TraceSession {
  const steps: StepSeed[] = [
    { kind: "instruction", tMs: 0, text: OAUTH_PROMPT, headline: "Add Google OAuth login" },
    { kind: "message", tMs: 2_100, text: "I will inspect the current auth code, database types, and server routes before making changes." },
    { kind: "read", tMs: 3_400, target: "src/auth/service.ts", rows: 3, noise: "read" },
    { kind: "read", tMs: 5_200, target: "src/db/users.ts", noise: "read" },
    { kind: "read", tMs: 6_300, target: "src/server/index.ts", noise: "read" },
    { kind: "message", tMs: 8_000, text: "Plan: introduce an Identity layer, add a Google OAuth provider, and link accounts explicitly." },
    { kind: "command", tMs: 10_000, durationMs: 4_500, target: "pnpm add google-auth-library", rows: 3, chapter: "u-google" },
    { kind: "dependency", tMs: 14_700, target: "package.json", chapter: "u-google", edit: { added: 1, removed: 0 } },
    { kind: "edit", tMs: 15_000, target: "src/auth/identity.ts", rows: 3, chapter: "u-identity", edit: { added: 42, removed: 0, change: "added" } },
    { kind: "edit", tMs: 16_000, target: "src/auth/google.ts", rows: 3, chapter: "u-google", edit: { added: 58, removed: 0, change: "added" } },
    { kind: "edit", tMs: 17_000, target: "migrations/001_create_identities.sql", rows: 2, chapter: "u-migration", edit: { added: 12, removed: 0, change: "added" } },
    { kind: "edit", tMs: 18_000, target: "src/auth/service.ts", rows: 3, chapter: "u-identity", edit: { added: 17, removed: 3 } },
    { kind: "edit", tMs: 19_000, target: "src/server/index.ts", rows: 3, chapter: "u-google", edit: { added: 9, removed: 1 } },
    { kind: "edit", tMs: 20_000, target: "package.json", rows: 2, chapter: "u-google", edit: { added: 1, removed: 0 } },
    { kind: "edit", tMs: 21_000, target: "pnpm-lock.yaml", rows: 2, chapter: "u-lock", noise: "lockfile", edit: { added: 120, removed: 4, lockfile: true } },
    { kind: "edit", tMs: 22_000, target: "src/db/users.ts", rows: 2, chapter: "u-format", noise: "formatting", edit: { added: 6, removed: 6, formattingOnly: true } },
    { kind: "message", tMs: 24_000, text: "Identity layer and Google provider are in place. The callback needs a linking policy decision." },
    { kind: "lifecycle", tMs: 25_000, headline: "Waiting", noise: "lifecycle" },
    {
      kind: "decision", tMs: 26_000, durationMs: 4_000, rows: 3, headline: "Account-linking policy for Google sign-in",
      decision: {
        decisionId: "dec-oauth-0001", title: "Account-linking policy for Google sign-in", status: "answered", decidedBy: "supervisor",
        options: [
          { id: "explicit_link", label: "Explicit link", chosen: true },
          { id: "auto_link_by_email", label: "Auto-link by email", chosen: false },
          { id: "reject", label: "Reject", chosen: false },
        ],
      },
    },
    { kind: "message", tMs: 31_000, text: "Applying the explicit linking policy to the callback flow." },
    { kind: "edit", tMs: 32_000, target: "src/auth/google.ts", rows: 2, chapter: "u-linking-policy", edit: { added: 14, removed: 2 } },
    { kind: "edit", tMs: 33_000, target: "tests/auth/oauth.test.ts", rows: 2, chapter: "u-linking-test", edit: { added: 31, removed: 0, change: "added" } },
    {
      kind: "test", tMs: 35_000, durationMs: 5_000, rows: 5, status: "failed", target: "pnpm test", chapter: "u-linking-test",
      headline: "pnpm test · 14/15",
      tests: { passed: 14, failed: 1, skipped: 0, runner: "vitest", failures: [{ file: "tests/auth/oauth.test.ts", testName: "links an existing account", message: "expected null to be 7" }] },
      command: { exitCode: 1 },
    },
    { kind: "message", tMs: 43_000, text: OAUTH_CLAIM_TEXT },
    { kind: "lifecycle", tMs: 45_000, headline: "Turn ended", noise: "lifecycle" },
  ];
  return buildSession({
    sessionId: "sess-oauth-0001",
    repoName: "acme-auth",
    originMs: DEFAULT_ORIGIN_MS,
    state: "completed",
    turns: [{ trigger: "initial", prompt: OAUTH_PROMPT, outcome: "completed", planStep: 5, claimStep: 23 }],
    steps,
    chapters: [
      { id: "u-identity", title: "Identity layer", category: "architecture" },
      { id: "u-google", title: "Google provider", category: "api" },
      { id: "u-migration", title: "Identities migration", category: "schema" },
      { id: "u-lock", title: "Lockfile update", category: "dependency", noise: true },
      { id: "u-format", title: "Users formatting", category: "implementation", noise: true },
      { id: "u-linking-policy", title: "Linking policy", category: "behavior" },
      { id: "u-linking-test", title: "Linking test", category: "tests", status: "failed" },
    ],
    findings: [
      { ruleId: "failing_tests", severity: "critical", step: 22, headline: "Tests failed" },
      { ruleId: "claim_contradicted", severity: "critical", step: 23, evidence: [22], claimSpan: claimSpanOf(OAUTH_CLAIM_TEXT, "all checks pass"), headline: "Claim contradicts tests" },
    ],
  });
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const LARGE_KINDS: readonly StepKind[] = ["command", "edit", "edit", "message", "read", "test", "tool", "reasoning"];

/** Deterministic 60-chapter / 5k-step session for layout properties and benches (spec §10 reference input). */
export function largeSession(options: { chapters?: number; steps?: number; seed?: number } = {}): TraceSession {
  const chapterCount = options.chapters ?? 60;
  const stepCount = options.steps ?? 5_000;
  const rand = mulberry32(options.seed ?? 1);
  const steps: StepSeed[] = [];
  const findings: FindingSeed[] = [];
  let t = 0;
  for (let i = 0; i < stepCount; i += 1) {
    t += rand() < 0.01 ? 90_000 + Math.floor(rand() * 600_000) : Math.floor(rand() * 2_500);
    const kind = i === 0 ? "instruction" : (LARGE_KINDS[Math.floor(rand() * LARGE_KINDS.length)] ?? "command");
    const failed = (kind === "test" || kind === "command") && rand() < 0.03;
    const chapter = `c${Math.min(chapterCount - 1, Math.floor((i / stepCount) * chapterCount))}`;
    steps.push({
      kind, tMs: t, target: kind === "edit" || kind === "read" ? `src/m${i % 97}.ts` : `cmd ${i % 31}`,
      durationMs: kind === "command" || kind === "test" || kind === "tool" ? 200 + Math.floor(rand() * 8_000) : 0,
      status: failed ? "failed" : undefined, chapter: kind === "read" ? undefined : chapter,
      noise: kind === "read" ? "read" : null,
      tests: kind === "test" ? { passed: 10, failed: failed ? 1 : 0, skipped: 0 } : undefined,
      edit: kind === "edit" ? { added: Math.floor(rand() * 40), removed: Math.floor(rand() * 10) } : undefined,
    });
    if (failed && kind === "test") findings.push({ ruleId: "failing_tests", severity: rand() < 0.3 ? "critical" : "warning", step: i });
  }
  return buildSession({
    sessionId: "sess-large",
    steps,
    chapters: Array.from({ length: chapterCount }, (_, c) => ({ id: `c${c}`, title: `Chapter ${c + 1}` })),
    findings,
  });
}
```

`packages/trace-viewer/src/test-support/arbitraries.ts`:

```ts
import fc from "fast-check";

import { NOISE_REASONS, SIGNAL_IDS, STEP_KINDS, type Severity, type StepKind, type StepStatus, type TraceSession } from "../model/index.js";
import { buildSession, type FindingSeed, type SessionSeed, type StepSeed } from "./session-builder.js";

export interface ArbSessionOptions { maxSteps?: number; maxChapters?: number; maxTurns?: number; live?: boolean }

const TIMED: readonly StepKind[] = ["command", "test", "check", "tool"];

/** Multi-turn, no-chapter, gap, idle-gap and running sessions. */
export function arbSessionSeed(options: ArbSessionOptions = {}): fc.Arbitrary<SessionSeed> {
  const maxSteps = options.maxSteps ?? 40;
  const maxChapters = options.maxChapters ?? 6;
  const maxTurns = options.maxTurns ?? 3;
  const step = fc.record({
    kind: fc.constantFrom(...STEP_KINDS),
    gapMs: fc.oneof(
      { weight: 8, arbitrary: fc.integer({ min: 0, max: 5_000 }) },
      { weight: 1, arbitrary: fc.integer({ min: 10_001, max: 3_600_000 }) },
    ),
    durationMs: fc.integer({ min: 0, max: 20_000 }),
    outcome: fc.constantFrom("ok", "ok", "ok", "ok", "failed", "unknown"),
    noise: fc.option(fc.constantFrom(...NOISE_REASONS), { freq: 4, nil: null }),
    chapter: fc.integer({ min: -1, max: Math.max(0, maxChapters - 1) }),
    newTurn: fc.integer({ min: 0, max: 9 }).map((n) => n === 0),
    rows: fc.integer({ min: 1, max: 3 }),
    finding: fc.option(
      fc.record({ ruleId: fc.constantFrom(...SIGNAL_IDS), severity: fc.constantFrom<Severity>("info", "warning", "critical") }),
      { freq: 6, nil: null },
    ),
  });
  return fc
    .record({
      steps: fc.array(step, { minLength: 1, maxLength: maxSteps }),
      chapters: fc.integer({ min: 0, max: maxChapters }),
      gapAt: fc.option(fc.nat(), { nil: null }),
      live: options.live === undefined ? fc.boolean() : fc.constant(options.live),
    })
    .map(({ steps, chapters, gapAt, live }): SessionSeed => {
      let t = 0;
      let turn = 0;
      const seeds: StepSeed[] = [];
      const findings: FindingSeed[] = [];
      steps.forEach((s, i) => {
        if (i > 0 && s.newTurn && turn < maxTurns - 1) turn += 1;
        t += s.gapMs;
        const timed = TIMED.includes(s.kind);
        const running = live && timed && i === steps.length - 1;
        const status: StepStatus | undefined = timed ? (running ? "running" : (s.outcome as StepStatus)) : undefined;
        seeds.push({
          kind: s.kind,
          tMs: t,
          durationMs: running ? null : timed ? s.durationMs : 0,
          status,
          turn,
          rows: s.rows,
          chapter: s.chapter >= 0 && s.chapter < chapters ? `u${s.chapter}` : undefined,
          noise: s.noise,
          target: s.kind === "edit" || s.kind === "read" ? `src/f${i % 13}.ts` : `cmd-${i % 7}`,
          tests: s.kind === "test" ? { passed: 3, failed: s.outcome === "failed" ? 1 : 0, skipped: 0 } : undefined,
          command: status === "unknown" ? { exitCode: -1 } : undefined,
        });
        if (timed && !running) t += s.durationMs;
        if (s.finding !== null) findings.push({ ruleId: s.finding.ruleId, severity: s.finding.severity, step: i });
      });
      return {
        live,
        state: live ? "running" : "completed",
        turns: Array.from({ length: turn + 1 }, (_, k) => ({ trigger: k === 0 ? "initial" : "steer", prompt: `Turn ${k + 1}` })),
        steps: seeds,
        chapters: Array.from({ length: chapters }, (_, k) => ({ id: `u${k}`, title: `Chapter ${k + 1}` })),
        findings,
        gaps: gapAt === null ? [] : [{ kind: "invalid_row", beforeStep: gapAt % steps.length }],
      };
    });
}

export function arbTraceSession(options: ArbSessionOptions = {}): fc.Arbitrary<TraceSession> {
  return arbSessionSeed(options).map(buildSession);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/test-support/session-builder.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Root checks**

```bash
pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint
```

Expected: each exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/trace-viewer/src/test-support/session-builder.ts packages/trace-viewer/src/test-support/session-builder.test.ts packages/trace-viewer/src/test-support/arbitraries.ts
git commit -m "test(trace-viewer): session builders, oauth-like session and arbitraries"
```

### Task C1-9: `TimeScale` (idle compression, breaks, live edge) and ticks

**Files:**
- Create: `packages/trace-viewer/src/layout/time-scale.ts`
- Test: `packages/trace-viewer/src/layout/time-scale.test.ts`
- Test: `packages/trace-viewer/src/layout/time-scale.property.test.ts`
- Create: `packages/trace-viewer/src/layout/ticks.ts`
- Test: `packages/trace-viewer/src/layout/ticks.test.ts`

**Interfaces:**
- Consumes: C1-5 `type XOnlyCamera`; W0 `type TraceSession`, `type StepKind`; C1-8 `buildSession` (tests).
- Produces (UI index §2.1 verbatim):

```ts
// layout/time-scale.ts — every time is display-clock ms (Step.tMs space)
export const IDLE_KNEE_MS = 10_000;
export const IDLE_LOG_MS = 5_000;
export const BREAK_MIN_MS = 60_000;
export const SESSION_BREAK_MIN_MS = 300_000;
export function displayGapMs(gapMs: number): number;
export type IdleReason = "awaiting_supervisor" | "agent_quiet";
export interface ScaleSegment { t0: number; t1: number; u0: number; u1: number; idle: null | { reason: IdleReason; ms: number } }
export interface TimeScale {
  originMs: number; endT: number; endU: number; segments: readonly ScaleSegment[];
  toU(tMs: number): number; toT(u: number): number;
  breaks(u0: number, u1: number, minMs?: number): readonly ScaleSegment[];
}
export interface TimeScaleInput { originMs: number; work: ReadonlyArray<readonly [number, number]>; awaitingFrom: readonly number[]; liveTMs?: number }
export function buildTimeScale(input: TimeScaleInput): TimeScale;
export function timeScaleInputOf(session: TraceSession, liveTMs?: number): TimeScaleInput;
export interface XMap { xOf(tMs: number): number; tOf(x: number): number }
export function xOnlyXMap(scale: TimeScale, camera: XOnlyCamera): XMap;
// layout/ticks.ts
export const TICK_STEPS_MS: readonly number[];
export const MIN_TICK_LABEL_GAP_PX = 64;
export interface Tick { tMs: number; x: number; labeled: boolean }
export interface BreakMark { x0: number; x1: number; ms: number }
export function computeTicks(map: XMap, scale: TimeScale, range: { x0: number; x1: number }): { ticks: Tick[]; breaks: BreakMark[] };
```

Rules (spec §7.4, R18): work spans map 1:1; every gap maps through `displayGapMs` (continuous, so the live edge never jumps); inside a gap `toU(t) = u0 + displayGapMs(t − t0)` so appended work never moves earlier times; a gap reads `awaiting_supervisor` when an `awaitingFrom` time lies in `[t0, t1)`; lifecycle, decision and approval steps are not work. Ticks: the smallest step whose spacing on work segments is ≥ 64 px; no tick strictly inside a break (idle ≥ `BREAK_MIN_MS`); a tick closer than 64 px to the previous labeled tick is unlabeled, and closer than 8 px it is dropped.

- [ ] **Step 1: Write the failing tests**

`packages/trace-viewer/src/layout/time-scale.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { buildSession } from "../test-support/session-builder.js";
import {
  BREAK_MIN_MS, buildTimeScale, displayGapMs, timeScaleInputOf, xOnlyXMap,
} from "./time-scale.js";

describe("displayGapMs (spec §7.4)", () => {
  it("is linear up to the 10 s knee, then 10 s + 5 s · log2(g / 10 s)", () => {
    expect(displayGapMs(4_000)).toBe(4_000);
    expect(displayGapMs(10_000)).toBe(10_000);
    expect(displayGapMs(20_000)).toBeCloseTo(15_000, 6);
    expect(displayGapMs(60_000)).toBeCloseTo(22_924.8, 1);
    expect(displayGapMs(300_000)).toBeCloseTo(34_534.5, 1);
    expect(displayGapMs(3_600_000)).toBeCloseTo(52_459.3, 1);
  });
});

describe("buildTimeScale", () => {
  it("is the identity when no gap exceeds 10 s", () => {
    const scale = buildTimeScale({ originMs: 0, work: [[0, 4_000], [9_000, 12_000], [20_000, 20_000]], awaitingFrom: [] });
    for (const t of [0, 3_000, 6_500, 12_000, 19_999, 20_000]) expect(scale.toU(t)).toBe(t);
    expect(scale.endU).toBe(20_000);
    expect(scale.breaks(0, scale.endU)).toHaveLength(0);
  });

  it("a one-hour gap compresses to 52.5 s with one break", () => {
    const scale = buildTimeScale({ originMs: 0, work: [[0, 1_000], [3_601_000, 3_602_000]], awaitingFrom: [] });
    expect(scale.toU(3_601_000)).toBeCloseTo(1_000 + 52_459.3, 1);
    expect(scale.endU).toBeCloseTo(2_000 + 52_459.3, 1);
    const breaks = scale.breaks(0, scale.endU);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]?.idle).toEqual({ reason: "agent_quiet", ms: 3_600_000 });
    expect(scale.toT(scale.toU(1_801_000))).toBeCloseTo(1_801_000, 3);
  });

  it("a 10-minute decision wait is one awaiting_supervisor segment and one break", () => {
    const session = buildSession({
      steps: [
        { kind: "command", tMs: 0, durationMs: 1_000, target: "pnpm build" },
        { kind: "decision", tMs: 2_000, durationMs: 600_000, headline: "Pick a policy" },
        { kind: "command", tMs: 602_000, durationMs: 1_000, target: "pnpm test" },
      ],
    });
    const scale = buildTimeScale(timeScaleInputOf(session));
    // The decision is not work: its open point splits the quiet second before it from the wait after it.
    const awaited = scale.segments.filter((s) => s.idle?.reason === "awaiting_supervisor");
    expect(awaited).toHaveLength(1);
    expect(awaited[0]?.idle).toEqual({ reason: "awaiting_supervisor", ms: 600_000 });
    expect(scale.breaks(0, scale.endU, BREAK_MIN_MS)).toHaveLength(1);
  });

  it("the live edge extends the scale continuously past the last work", () => {
    const base = { originMs: 0, work: [[0, 1_000]] as const, awaitingFrom: [] };
    const a = buildTimeScale({ ...base, liveTMs: 30_000 });
    const b = buildTimeScale({ ...base, liveTMs: 30_001 });
    expect(b.endU - a.endU).toBeGreaterThan(0);
    expect(b.endU - a.endU).toBeLessThanOrEqual(1);
    const closed = buildTimeScale({ originMs: 0, work: [[0, 1_000], [30_000, 31_000]], awaitingFrom: [] });
    expect(closed.toU(30_000)).toBeCloseTo(a.endU, 9);
  });

  it("maps display time to x for a Hybrid camera and back", () => {
    const scale = buildTimeScale({ originMs: 0, work: [[0, 45_000]], awaitingFrom: [] });
    const map = xOnlyXMap(scale, { mode: "xOnly", u0: 5_000, k: 0.02 });
    expect(map.xOf(15_000)).toBeCloseTo(200, 9);
    expect(map.tOf(200)).toBeCloseTo(15_000, 9);
  });
});
```

`packages/trace-viewer/src/layout/time-scale.property.test.ts`:

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { buildTimeScale, IDLE_KNEE_MS } from "./time-scale.js";

const spans = (maxGap: number) =>
  fc.array(fc.record({ gap: fc.integer({ min: 0, max: maxGap }), len: fc.integer({ min: 0, max: 30_000 }) }), { minLength: 1, maxLength: 30 })
    .map((parts) => {
      let t = 0;
      return parts.map(({ gap, len }) => {
        const a = t + gap;
        t = a + len;
        return [a, t] as const;
      });
    });

describe("TimeScale properties (R18)", () => {
  it("toU is monotone", () => {
    fc.assert(fc.property(spans(4_000_000), fc.array(fc.integer({ min: -1_000, max: 60_000_000 }), { minLength: 2, maxLength: 40 }), (work, ts) => {
      const scale = buildTimeScale({ originMs: 0, work, awaitingFrom: [] });
      const sorted = [...ts].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i += 1) {
        expect(scale.toU(sorted[i] ?? 0)).toBeGreaterThanOrEqual(scale.toU(sorted[i - 1] ?? 0));
      }
    }));
  });

  it("toT inverts toU on work segments", () => {
    fc.assert(fc.property(spans(4_000_000), fc.double({ min: 0, max: 1, noNaN: true }), (work, f) => {
      const scale = buildTimeScale({ originMs: 0, work, awaitingFrom: [] });
      for (const seg of scale.segments.filter((s) => s.idle === null)) {
        const t = seg.t0 + (seg.t1 - seg.t0) * f;
        expect(Math.abs(scale.toT(scale.toU(t)) - t)).toBeLessThan(1e-6);
      }
    }));
  });

  it("appending work after T leaves toU(t) unchanged for t ≤ T", () => {
    fc.assert(fc.property(spans(4_000_000), fc.integer({ min: 0, max: 600_000 }), spans(4_000_000), fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 1, maxLength: 10 }), (work, live, more, fractions) => {
      const last = work.at(-1)?.[1] ?? 0;
      const liveTMs = last + live;
      const before = buildTimeScale({ originMs: 0, work, awaitingFrom: [], liveTMs });
      const shifted = more.map(([a, b]) => [a + liveTMs, b + liveTMs] as const);
      const after = buildTimeScale({ originMs: 0, work: [...work, ...shifted], awaitingFrom: [] });
      for (const f of fractions) {
        const t = liveTMs * f;
        expect(Math.abs(after.toU(t) - before.toU(t))).toBeLessThan(1e-6);
      }
    }));
  });

  it("the live edge is continuous and never faster than real time", () => {
    fc.assert(fc.property(spans(4_000_000), fc.integer({ min: 0, max: 7_200_000 }), fc.integer({ min: 1, max: 1_000 }), (work, extra, delta) => {
      const last = work.at(-1)?.[1] ?? 0;
      const a = buildTimeScale({ originMs: 0, work, awaitingFrom: [], liveTMs: last + extra });
      const b = buildTimeScale({ originMs: 0, work, awaitingFrom: [], liveTMs: last + extra + delta });
      expect(b.endU).toBeGreaterThanOrEqual(a.endU);
      expect(b.endU - a.endU).toBeLessThanOrEqual(delta + 1e-9);
    }));
  });

  it("is the identity when no gap exceeds the knee", () => {
    fc.assert(fc.property(spans(IDLE_KNEE_MS), fc.double({ min: 0, max: 1, noNaN: true }), (work, f) => {
      const scale = buildTimeScale({ originMs: 0, work, awaitingFrom: [] });
      const t = Math.round(scale.endT * f);
      expect(scale.toU(t)).toBeCloseTo(t, 6);
    }));
  });
});
```

`packages/trace-viewer/src/layout/ticks.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { computeTicks, MIN_TICK_LABEL_GAP_PX, TICK_STEPS_MS } from "./ticks.js";
import { buildTimeScale, xOnlyXMap } from "./time-scale.js";

function labeledGaps(xs: readonly number[]): number[] {
  return xs.slice(1).map((x, i) => x - (xs[i] ?? 0));
}

describe("computeTicks (spec §7.4)", () => {
  it("picks the smallest step whose labels stay ≥ 64 px apart", () => {
    const scale = buildTimeScale({ originMs: 0, work: [[0, 45_000]], awaitingFrom: [] });
    const map = xOnlyXMap(scale, { mode: "xOnly", u0: 0, k: 0.02 });
    const { ticks, breaks } = computeTicks(map, scale, { x0: 0, x1: 900 });
    expect(ticks.map((t) => t.tMs)).toEqual([0, 5_000, 10_000, 15_000, 20_000, 25_000, 30_000, 35_000, 40_000, 45_000]);
    expect(ticks.every((t) => t.labeled)).toBe(true);
    expect(ticks[1]?.x).toBeCloseTo(100, 9);
    expect(breaks).toHaveLength(0);
  });

  it("no tick inside a break, and labeled ticks stay ≥ 64 px apart at every zoom", () => {
    const scale = buildTimeScale({ originMs: 0, work: [[0, 30_000], [3_630_000, 3_660_000]], awaitingFrom: [] });
    const [gap] = scale.breaks(0, scale.endU);
    expect(gap).toBeDefined();
    for (const k of [0.002, 0.01, 0.05, 0.2]) {
      const map = xOnlyXMap(scale, { mode: "xOnly", u0: 0, k });
      const { ticks, breaks } = computeTicks(map, scale, { x0: 0, x1: scale.endU * k });
      expect(breaks).toHaveLength(1);
      for (const tick of ticks) expect(tick.tMs <= (gap?.t0 ?? 0) || tick.tMs >= (gap?.t1 ?? 0)).toBe(true);
      const xs = ticks.filter((t) => t.labeled).map((t) => t.x);
      for (const d of labeledGaps(xs)) expect(d).toBeGreaterThanOrEqual(MIN_TICK_LABEL_GAP_PX - 1e-9);
    }
  });

  it("uses the published step list", () => {
    expect(TICK_STEPS_MS).toEqual([1e3, 2e3, 5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/time-scale.test.ts src/layout/time-scale.property.test.ts src/layout/ticks.test.ts`
Expected: FAIL, `Failed to resolve import "./time-scale.js"`.

- [ ] **Step 3: Write the implementation**

`packages/trace-viewer/src/layout/time-scale.ts`:

```ts
import type { StepKind, TraceSession } from "../model/index.js";
import type { XOnlyCamera } from "./viewport.js";

export const IDLE_KNEE_MS = 10_000;
export const IDLE_LOG_MS = 5_000;
export const BREAK_MIN_MS = 60_000;
export const SESSION_BREAK_MIN_MS = 300_000;

/** g ≤ 10 s: g; else 10 s + 5 s · log2(g / 10 s). 20 s → 15 s, 60 s → 22.9 s, 5 min → 34.5 s, 1 h → 52.5 s. */
export function displayGapMs(gapMs: number): number {
  if (!(gapMs > 0)) return 0;
  return gapMs <= IDLE_KNEE_MS ? gapMs : IDLE_KNEE_MS + IDLE_LOG_MS * Math.log2(gapMs / IDLE_KNEE_MS);
}

function realGapMs(displayMs: number): number {
  if (!(displayMs > 0)) return 0;
  return displayMs <= IDLE_KNEE_MS ? displayMs : IDLE_KNEE_MS * 2 ** ((displayMs - IDLE_KNEE_MS) / IDLE_LOG_MS);
}

export type IdleReason = "awaiting_supervisor" | "agent_quiet";
export interface ScaleSegment {
  t0: number; t1: number; u0: number; u1: number;
  idle: null | { reason: IdleReason; ms: number };
}
export interface TimeScale {
  originMs: number;
  endT: number;
  endU: number;
  segments: readonly ScaleSegment[];
  toU(tMs: number): number;
  toT(u: number): number;
  /** Idle segments intersecting [u0, u1] whose real gap is ≥ minMs (default BREAK_MIN_MS). */
  breaks(u0: number, u1: number, minMs?: number): readonly ScaleSegment[];
}
export interface TimeScaleInput {
  originMs: number;
  /** Step spans [tMs, tMs + durationMs]; lifecycle steps and decision/approval waits excluded. */
  work: ReadonlyArray<readonly [number, number]>;
  /** Turn ends, decisions and approvals opened: gaps starting here read "awaiting_supervisor". */
  awaitingFrom: readonly number[];
  /** max(last step tMs, source.now() − originMs) while live. */
  liveTMs?: number;
}

/** Last index i with key(items[i]) ≤ value, or −1. */
function lastAtOrBefore<T>(items: readonly T[], value: number, key: (item: T) => number): number {
  let lo = 0;
  let hi = items.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const item = items[mid];
    if (item !== undefined && key(item) <= value) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export function buildTimeScale(input: TimeScaleInput): TimeScale {
  const spans = input.work
    .map(([a, b]) => [Math.max(0, a), Math.max(0, a, b)] as [number, number])
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged: [number, number][] = [];
  for (const [a, b] of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const workEnd = merged[merged.length - 1]?.[1] ?? 0;
  const endT = Math.max(workEnd, input.liveTMs ?? 0, 0);
  const awaiting = input.awaitingFrom;
  const segments: ScaleSegment[] = [];
  let t = 0;
  let u = 0;
  const pushGap = (t1: number): void => {
    const ms = t1 - t;
    if (ms <= 0) return;
    const du = displayGapMs(ms);
    const start = t;
    const awaited = awaiting.some((v) => v >= start && v < t1);
    segments.push({ t0: t, t1, u0: u, u1: u + du, idle: { reason: awaited ? "awaiting_supervisor" : "agent_quiet", ms } });
    t = t1;
    u += du;
  };
  for (const [a, b] of merged) {
    pushGap(a);
    if (b > t) {
      segments.push({ t0: t, t1: b, u0: u, u1: u + (b - t), idle: null });
      u += b - t;
      t = b;
    }
  }
  pushGap(endT);
  const endU = u;

  const toU = (tMs: number): number => {
    if (tMs <= 0) return tMs;
    if (tMs >= endT) return endU + (tMs - endT);
    const seg = segments[lastAtOrBefore(segments, tMs, (s) => s.t0)];
    if (seg === undefined) return tMs;
    return seg.idle === null ? seg.u0 + (tMs - seg.t0) : seg.u0 + displayGapMs(tMs - seg.t0);
  };
  const toT = (value: number): number => {
    if (value <= 0) return value;
    if (value >= endU) return endT + (value - endU);
    const seg = segments[lastAtOrBefore(segments, value, (s) => s.u0)];
    if (seg === undefined) return value;
    return seg.idle === null ? seg.t0 + (value - seg.u0) : seg.t0 + realGapMs(value - seg.u0);
  };
  return {
    originMs: input.originMs,
    endT,
    endU,
    segments,
    toU,
    toT,
    breaks: (u0, u1, minMs = BREAK_MIN_MS) =>
      segments.filter((s) => s.idle !== null && s.idle.ms >= minMs && s.u1 > u0 && s.u0 < u1),
  };
}

const NOT_WORK: ReadonlySet<StepKind> = new Set<StepKind>(["lifecycle", "decision", "approval"]);

export function timeScaleInputOf(session: TraceSession, liveTMs?: number): TimeScaleInput {
  const work = session.steps.map((s): readonly [number, number] =>
    NOT_WORK.has(s.kind) ? [s.tMs, s.tMs] : [s.tMs, s.tMs + Math.max(0, s.durationMs ?? 0)]);
  const awaitingFrom = [
    ...session.turns.map((turn) => turn.endTMs),
    ...session.steps.filter((s) => s.kind === "decision" || s.kind === "approval").map((s) => s.tMs),
  ];
  return liveTMs === undefined
    ? { originMs: session.originMs, work, awaitingFrom }
    : { originMs: session.originMs, work, awaitingFrom, liveTMs };
}

/** Monotone map between display time and screen x. */
export interface XMap { xOf(tMs: number): number; tOf(x: number): number }

/** Hybrid: x = (toU(t) − u0) · k. */
export function xOnlyXMap(scale: TimeScale, camera: XOnlyCamera): XMap {
  return {
    xOf: (tMs) => (scale.toU(tMs) - camera.u0) * camera.k,
    tOf: (x) => scale.toT(x / camera.k + camera.u0),
  };
}
```

`packages/trace-viewer/src/layout/ticks.ts`:

```ts
import { BREAK_MIN_MS, type ScaleSegment, type TimeScale, type XMap } from "./time-scale.js";

export const TICK_STEPS_MS: readonly number[] = [1e3, 2e3, 5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5];
export const MIN_TICK_LABEL_GAP_PX = 64;
const MIN_TICK_GAP_PX = 8;

export interface Tick { tMs: number; x: number; labeled: boolean }
export interface BreakMark { x0: number; x1: number; ms: number }

/** Largest px-per-ms slope on work segments inside [t0, t1]. */
function workSlope(map: XMap, scale: TimeScale, t0: number, t1: number): number {
  let slope = 0;
  for (const seg of scale.segments) {
    if (seg.idle !== null || seg.t1 <= t0 || seg.t0 >= t1) continue;
    const a = Math.max(seg.t0, t0);
    const b = Math.min(seg.t1, t1);
    if (b > a) slope = Math.max(slope, (map.xOf(b) - map.xOf(a)) / (b - a));
  }
  if (slope > 0) return slope;
  const probe = Math.max(1, (t1 - t0) / 100);
  return Math.max(1e-12, (map.xOf(t0 + probe) - map.xOf(t0)) / probe);
}

/** Ticks inside [x0, x1]; none inside breaks; the Ruler formats labels with formatOffset(tMs). */
export function computeTicks(map: XMap, scale: TimeScale, range: { x0: number; x1: number }): { ticks: Tick[]; breaks: BreakMark[] } {
  const x0 = Math.min(range.x0, range.x1);
  const x1 = Math.max(range.x0, range.x1);
  const t0 = Math.max(0, map.tOf(x0));
  const t1 = Math.max(t0, map.tOf(x1));
  const breakSegs: ScaleSegment[] = scale.segments.filter((s) => s.idle !== null && s.idle.ms >= BREAK_MIN_MS && s.t1 > t0 && s.t0 < t1);
  const breaks = breakSegs.map((s) => ({ x0: map.xOf(s.t0), x1: map.xOf(s.t1), ms: s.idle?.ms ?? 0 }));
  const slope = workSlope(map, scale, t0, t1);
  const step = TICK_STEPS_MS.find((s) => s * slope >= MIN_TICK_LABEL_GAP_PX) ?? TICK_STEPS_MS[TICK_STEPS_MS.length - 1] ?? 3_600_000;
  const ticks: Tick[] = [];
  let lastLabeledX = Number.NEGATIVE_INFINITY;
  let lastX = Number.NEGATIVE_INFINITY;
  let t = Math.ceil(t0 / step) * step;
  while (t <= t1) {
    const inside = breakSegs.find((s) => s.t0 < t && t < s.t1);
    if (inside !== undefined) {
      t = Math.ceil(inside.t1 / step) * step;
      continue;
    }
    const x = map.xOf(t);
    if (x >= x0 - 1e-9 && x <= x1 + 1e-9 && x - lastX >= MIN_TICK_GAP_PX) {
      const labeled = x - lastLabeledX >= MIN_TICK_LABEL_GAP_PX - 1e-9;
      ticks.push({ tMs: t, x, labeled });
      lastX = x;
      if (labeled) lastLabeledX = x;
    }
    t += step;
  }
  return { ticks, breaks };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/time-scale.test.ts src/layout/time-scale.property.test.ts src/layout/ticks.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Root checks**

```bash
pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint
```

Expected: each exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/trace-viewer/src/layout/time-scale.ts packages/trace-viewer/src/layout/time-scale.test.ts packages/trace-viewer/src/layout/time-scale.property.test.ts packages/trace-viewer/src/layout/ticks.ts packages/trace-viewer/src/layout/ticks.test.ts
git commit -m "feat(trace-viewer): shared TimeScale with idle compression and ruler ticks"
```

### Task C1-10: `TraceIndex`, brush and playhead resolution, tone

**Files:**
- Create: `packages/trace-viewer/src/layout/trace-index.ts`
- Test: `packages/trace-viewer/src/layout/trace-index.test.ts`
- Create: `packages/trace-viewer/src/layout/tone.ts`
- Test: `packages/trace-viewer/src/layout/tone.test.ts`

**Interfaces:**
- Consumes: W0 `type TraceSession`, `type Step`, `type Chapter`, `type Turn`, `type Finding`, `type FindingId`, `type StepId`, `type UnitStableId`, `type Severity`; C1-8 builders (tests).
- Produces (UI index §2.1 verbatim, plus deviation 3's `findingsById`, `isStepExpanded` and `isKeyExpanded`):

```ts
// layout/trace-index.ts
export type SelectionId = StepId | UnitStableId;
export type Playhead = { kind: "selection" } | { kind: "free"; seq: number } | { kind: "live" };
export type Brush = { kind: "session" } | { kind: "chapter"; anchorSeq: number } | { kind: "range"; fromSeq: number; toSeq: number | "live" };
export interface IndexEntry { id: SelectionId; kind: "step" | "chapter"; t0: number; t1: number; firstSeq: number; lastSeq: number; parent: UnitStableId | null; position: number }
export interface TraceIndex {
  readonly sessionId: string;
  readonly session: TraceSession | null;
  readonly loadedThroughSeq: number;
  readonly stepFirstSeqs: Int32Array;
  entry(id: string): IndexEntry | undefined;
  stepIndexAtOrBefore(seq: number): number;
  stepIndexAtOrAfter(seq: number): number;
  chapterKey(id: UnitStableId): `ch:${number}` | undefined;
  chapterByAnchor(anchorSeq: number): UnitStableId | undefined;
  chapterAtSeq(seq: number): Chapter | undefined;
  turnAtSeq(seq: number): Turn | undefined;
  readonly findingsBySeq: readonly Finding[];
  readonly tailStepId: StepId | null;
  readonly findingsById: ReadonlyMap<FindingId, Finding>;
}
export function buildTraceIndex(session: TraceSession): TraceIndex;
export function emptyTraceIndex(sessionId: string): TraceIndex;
export function brushSeqRange(brush: Brush, index: TraceIndex): { fromSeq: number; toSeq: number };
export function effectivePlayheadSeq(playhead: Playhead, selection: SelectionId | null, index: TraceIndex): number;
/** Spec §7.6.3: expanded when the reader expanded it, or when it anchors a critical finding the reader has not collapsed. */
export function isStepExpanded(step: Step, findingsById: ReadonlyMap<FindingId, Finding>, expanded: ReadonlySet<string>, collapsed: ReadonlySet<string>): boolean;
/** Same rule for any row, frame or finding key. */
export function isKeyExpanded(key: string, index: TraceIndex, expanded: ReadonlySet<string>, collapsed: ReadonlySet<string>): boolean;
// layout/tone.ts
export type Tone = "neutral" | "bad" | "good";
export function stepTone(step: Step, findingsById: ReadonlyMap<FindingId, Finding>): Tone;
export function findingTone(finding: Finding): Tone;
export function worstSeverity(step: Step, findingsById: ReadonlyMap<FindingId, Finding>): Severity | null;
```

- [ ] **Step 1: Write the failing tests**

`packages/trace-viewer/src/layout/trace-index.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { buildSession, OAUTH_CLAIM_TEXT, oauthLikeSession, type StepSeed } from "../test-support/session-builder.js";
import {
  brushSeqRange, buildTraceIndex, effectivePlayheadSeq, emptyTraceIndex, isKeyExpanded, isStepExpanded,
} from "./trace-index.js";

const oauth = oauthLikeSession();
const index = buildTraceIndex(oauth);
const stepBy = (pred: (s: (typeof oauth.steps)[number]) => boolean) => {
  const step = oauth.steps.find(pred);
  if (step === undefined) throw new Error("step not found");
  return step;
};

describe("TraceIndex", () => {
  it("binary-searches steps by firstSeq", () => {
    const first = oauth.steps[0];
    const second = oauth.steps[1];
    expect(index.stepIndexAtOrBefore(0)).toBe(-1);
    expect(index.stepIndexAtOrBefore(first?.firstSeq ?? 0)).toBe(0);
    expect(index.stepIndexAtOrAfter((first?.firstSeq ?? 0) + 1)).toBe(1);
    expect(index.stepIndexAtOrBefore((second?.firstSeq ?? 0) - 1)).toBe(0);
    expect(index.stepIndexAtOrAfter(10_000)).toBe(oauth.steps.length);
    expect(index.tailStepId).toBe(oauth.steps.at(-1)?.id);
  });

  it("keys a chapter by its anchor seq and parents a step to its lowest-anchor chapter", () => {
    const testFile = stepBy((s) => s.target === "tests/auth/oauth.test.ts");
    const test = stepBy((s) => s.kind === "test");
    expect(index.chapterKey("unit:u-linking-test")).toBe(`ch:${testFile.firstSeq}`);
    expect(index.chapterByAnchor(testFile.firstSeq)).toBe("unit:u-linking-test");
    expect(index.entry(test.id)?.parent).toBe("unit:u-linking-test");
    expect(index.entry("unit:u-linking-test")).toMatchObject({ kind: "chapter", firstSeq: testFile.firstSeq, lastSeq: test.lastSeq, t0: 33_000 });
  });

  it("chapterAtSeq picks the latest anchor among chapters whose span holds the seq", () => {
    const service = stepBy((s) => s.target === "src/auth/service.ts" && s.kind === "edit");
    expect(index.chapterAtSeq(service.firstSeq)?.id).toBe("unit:u-identity");
  });

  it("orders findings by seq and resolves the effective playhead", () => {
    expect(index.findingsBySeq.map((f) => f.ruleId)).toEqual(["failing_tests", "claim_contradicted"]);
    const claim = stepBy((s) => s.text === OAUTH_CLAIM_TEXT);
    expect(effectivePlayheadSeq({ kind: "selection" }, claim.id, index)).toBe(claim.firstSeq);
    expect(effectivePlayheadSeq({ kind: "live" }, claim.id, index)).toBe(oauth.loadedThroughSeq);
    expect(effectivePlayheadSeq({ kind: "free", seq: 7 }, null, index)).toBe(7);
    expect(effectivePlayheadSeq({ kind: "selection" }, null, index)).toBe(oauth.loadedThroughSeq);
  });

  it("a live range brush ends at loadedThroughSeq; a session brush spans everything", () => {
    expect(brushSeqRange({ kind: "range", fromSeq: 5, toSeq: "live" }, index)).toEqual({ fromSeq: 5, toSeq: oauth.loadedThroughSeq });
    expect(brushSeqRange({ kind: "session" }, index)).toEqual({ fromSeq: 1, toSeq: oauth.loadedThroughSeq });
    expect(brushSeqRange({ kind: "range", fromSeq: 30, toSeq: 12 }, index)).toEqual({ fromSeq: 12, toSeq: 12 });
  });

  it("a chapter brush resolves by anchorSeq after the unit id changes", () => {
    const steps: StepSeed[] = [
      { kind: "instruction", tMs: 0, text: "go" },
      { kind: "edit", tMs: 1_000, target: "a.ts", chapter: "u1" },
      { kind: "edit", tMs: 2_000, target: "b.ts", chapter: "u1" },
    ];
    const before = buildTraceIndex(buildSession({ steps, chapters: [{ id: "u1", title: "A" }] }));
    const renamed = steps.map((s) => (s.chapter === "u1" ? { ...s, chapter: "u2" } : s));
    const after = buildTraceIndex(buildSession({ steps: renamed, chapters: [{ id: "u2", title: "A" }] }));
    const key = before.chapterKey("unit:u1");
    expect(key).toBe(after.chapterKey("unit:u2"));
    const anchorSeq = Number(key?.slice(3));
    expect(after.chapterByAnchor(anchorSeq)).toBe("unit:u2");
    expect(brushSeqRange({ kind: "chapter", anchorSeq }, after)).toEqual(brushSeqRange({ kind: "chapter", anchorSeq }, before));
    expect(brushSeqRange({ kind: "chapter", anchorSeq }, after)).toEqual({ fromSeq: 2, toSeq: 3 });
  });

  it("a chapter brush with no chapter falls back to its turn", () => {
    const session = buildSession({
      turns: [{ trigger: "initial", prompt: "one" }, { trigger: "steer", prompt: "two" }],
      steps: [
        { kind: "instruction", tMs: 0, turn: 0 },
        { kind: "command", tMs: 1_000, turn: 0, target: "a" },
        { kind: "instruction", tMs: 5_000, turn: 1 },
        { kind: "command", tMs: 6_000, turn: 1, target: "b", rows: 2 },
      ],
    });
    const idx = buildTraceIndex(session);
    expect(brushSeqRange({ kind: "chapter", anchorSeq: 3 }, idx)).toEqual({ fromSeq: 3, toSeq: 5 });
    expect(idx.turnAtSeq(4)?.index).toBe(1);
  });

  it("auto-expands a critical finding's row until the reader collapses it", () => {
    const claim = stepBy((s) => s.text === OAUTH_CLAIM_TEXT);
    const findingId = claim.findingIds[0];
    expect(findingId).toBeDefined();
    const none = new Set<string>();
    expect(isStepExpanded(claim, index.findingsById, none, none)).toBe(true);
    expect(isStepExpanded(claim, index.findingsById, none, new Set([findingId ?? ""]))).toBe(false);
    expect(isStepExpanded(claim, index.findingsById, new Set([claim.id]), new Set([findingId ?? ""]))).toBe(true);
    expect(isKeyExpanded(claim.id, index, none, none)).toBe(true);
    expect(isKeyExpanded("unit:u-identity", index, none, none)).toBe(false);
    expect(isKeyExpanded("unit:u-identity", index, new Set(["unit:u-identity"]), none)).toBe(true);
  });

  it("the empty index answers safely", () => {
    const empty = emptyTraceIndex("s");
    expect(empty.session).toBeNull();
    expect(empty.tailStepId).toBeNull();
    expect(empty.stepIndexAtOrBefore(10)).toBe(-1);
    expect(brushSeqRange({ kind: "session" }, empty)).toEqual({ fromSeq: 1, toSeq: 1 });
  });
});
```

`packages/trace-viewer/src/layout/tone.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { buildSession } from "../test-support/session-builder.js";
import { findingTone, stepTone, worstSeverity } from "./tone.js";
import { buildTraceIndex } from "./trace-index.js";

const session = buildSession({
  steps: [
    { kind: "command", tMs: 0, target: "grep -r TODO", status: "failed" },
    { kind: "test", tMs: 1_000, target: "pnpm test", status: "failed", tests: { passed: 14, failed: 1, skipped: 0 } },
    { kind: "test", tMs: 2_000, target: "pnpm test", tests: { passed: 15, failed: 0, skipped: 0 } },
    { kind: "command", tMs: 3_000, target: "pnpm dev", status: "unknown" },
    { kind: "command", tMs: 4_000, target: "rm -rf dist" },
    { kind: "guardrail", tMs: 5_000, problems: ["guardrail"] },
    { kind: "guardrail", tMs: 6_000 },
    { kind: "lifecycle", tMs: 7_000, status: "failed", problems: ["agent_failed"] },
    { kind: "message", tMs: 8_000, text: "done" },
  ],
  findings: [
    { ruleId: "destructive_command", severity: "critical", step: 4 },
    { ruleId: "guardrail_clamp", severity: "warning", step: 4 },
  ],
});
const { findingsById } = buildTraceIndex(session);
const step = (i: number) => {
  const s = session.steps[i];
  if (s === undefined) throw new Error("missing step");
  return s;
};

describe("tone (spec §6.8 toneOf)", () => {
  it("a command with exit 1 is neutral", () => expect(stepTone(step(0), findingsById)).toBe("neutral"));
  it("a failed test is bad and a passing test is good", () => {
    expect(stepTone(step(1), findingsById)).toBe("bad");
    expect(stepTone(step(2), findingsById)).toBe("good");
  });
  it("exit -1 (unknown) is neutral", () => expect(stepTone(step(3), findingsById)).toBe("neutral"));
  it("a step anchoring a critical finding is bad", () => expect(stepTone(step(4), findingsById)).toBe("bad"));
  it("a guardrail hit is bad, an info clamp neutral, an agent failure bad", () => {
    expect(stepTone(step(5), findingsById)).toBe("bad");
    expect(stepTone(step(6), findingsById)).toBe("neutral");
    expect(stepTone(step(7), findingsById)).toBe("bad");
    expect(stepTone(step(8), findingsById)).toBe("neutral");
  });
  it("worstSeverity picks critical over warning; findingTone is bad only for critical", () => {
    expect(worstSeverity(step(4), findingsById)).toBe("critical");
    expect(worstSeverity(step(8), findingsById)).toBeNull();
    const critical = session.findings.find((f) => f.ruleId === "destructive_command");
    const warning = session.findings.find((f) => f.ruleId === "guardrail_clamp");
    expect(critical === undefined ? "missing" : findingTone(critical)).toBe("bad");
    expect(warning === undefined ? "missing" : findingTone(warning)).toBe("neutral");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/trace-index.test.ts src/layout/tone.test.ts`
Expected: FAIL, `Failed to resolve import "./trace-index.js"`.

- [ ] **Step 3: Write the implementation**

`packages/trace-viewer/src/layout/trace-index.ts`:

```ts
import type {
  Chapter, Finding, FindingId, Step, StepId, TraceSession, Turn, UnitStableId,
} from "../model/index.js";

export type SelectionId = StepId | UnitStableId;
export type Playhead = { kind: "selection" } | { kind: "free"; seq: number } | { kind: "live" };
export type Brush =
  | { kind: "session" }
  | { kind: "chapter"; anchorSeq: number }
  | { kind: "range"; fromSeq: number; toSeq: number | "live" };

export interface IndexEntry {
  id: SelectionId;
  kind: "step" | "chapter";
  /** Display clock. */
  t0: number;
  t1: number;
  firstSeq: number;
  lastSeq: number;
  /** step → its lowest-anchor chapter; chapter → null. */
  parent: UnitStableId | null;
  /** Position in session.steps or session.chapters. */
  position: number;
}

export interface TraceIndex {
  readonly sessionId: string;
  readonly session: TraceSession | null;
  readonly loadedThroughSeq: number;
  /** session.steps' firstSeq, ascending. */
  readonly stepFirstSeqs: Int32Array;
  entry(id: string): IndexEntry | undefined;
  /** Last step index with firstSeq ≤ seq, or −1. */
  stepIndexAtOrBefore(seq: number): number;
  /** First step index with firstSeq ≥ seq, or steps.length. */
  stepIndexAtOrAfter(seq: number): number;
  /** "ch:<anchorSeq>", anchorSeq = min over factSeqs and step firstSeqs (spec §7.5). */
  chapterKey(id: UnitStableId): `ch:${number}` | undefined;
  chapterByAnchor(anchorSeq: number): UnitStableId | undefined;
  /** The current chapter whose step span holds seq (latest anchor wins). */
  chapterAtSeq(seq: number): Chapter | undefined;
  turnAtSeq(seq: number): Turn | undefined;
  /** Findings in seq order (n/N). */
  readonly findingsBySeq: readonly Finding[];
  /** The tail step: highest firstSeq. */
  readonly tailStepId: StepId | null;
  readonly findingsById: ReadonlyMap<FindingId, Finding>;
}

/** First index with arr[i] ≥ value. */
function lowerBound(arr: Int32Array, value: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((arr[mid] ?? 0) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index with arr[i] > value. */
function upperBound(arr: Int32Array, value: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((arr[mid] ?? 0) <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function buildTraceIndex(session: TraceSession): TraceIndex {
  const steps = session.steps;
  const stepFirstSeqs = Int32Array.from(steps, (s) => s.firstSeq);
  const entries = new Map<string, IndexEntry>();
  const positionOf = new Map<string, number>();
  steps.forEach((step, i) => positionOf.set(step.id, i));
  const anchorOf = new Map<UnitStableId, number>();
  const byAnchor = new Map<number, UnitStableId>();

  session.chapters.forEach((chapter, position) => {
    const own = chapter.stepIds
      .map((id) => steps[positionOf.get(id) ?? -1])
      .filter((s): s is Step => s !== undefined);
    const candidates = [...chapter.factSeqs, ...own.map((s) => s.firstSeq)];
    const anchor = candidates.length > 0 ? Math.min(...candidates) : chapter.firstSeq;
    anchorOf.set(chapter.id, anchor);
    if (!byAnchor.has(anchor)) byAnchor.set(anchor, chapter.id);
    const firstSeq = own.length > 0 ? Math.min(...own.map((s) => s.firstSeq)) : anchor;
    const lastSeq = own.length > 0 ? Math.max(...own.map((s) => s.lastSeq)) : anchor;
    entries.set(chapter.id, { id: chapter.id, kind: "chapter", t0: chapter.tMs, t1: chapter.endTMs, firstSeq, lastSeq, parent: null, position });
  });

  steps.forEach((step, position) => {
    let parent: UnitStableId | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (const chapterId of step.chapterIds) {
      const anchor = anchorOf.get(chapterId);
      if (anchor !== undefined && anchor < best) {
        best = anchor;
        parent = chapterId;
      }
    }
    entries.set(step.id, {
      id: step.id, kind: "step", t0: step.tMs, t1: step.endTMs ?? step.tMs,
      firstSeq: step.firstSeq, lastSeq: step.lastSeq, parent, position,
    });
  });

  const turns = [...session.turns].sort((a, b) => a.startSeq - b.startSeq);
  const findingsBySeq = [...session.findings].sort((a, b) => a.anchorSeq - b.anchorSeq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const findingsById = new Map<FindingId, Finding>(session.findings.map((f) => [f.id, f]));

  return {
    sessionId: session.meta.sessionId,
    session,
    loadedThroughSeq: session.loadedThroughSeq,
    stepFirstSeqs,
    entry: (id) => entries.get(id),
    stepIndexAtOrBefore: (seq) => upperBound(stepFirstSeqs, seq) - 1,
    stepIndexAtOrAfter: (seq) => lowerBound(stepFirstSeqs, seq),
    chapterKey: (id) => {
      const anchor = anchorOf.get(id);
      return anchor === undefined ? undefined : `ch:${anchor}`;
    },
    chapterByAnchor: (anchorSeq) => byAnchor.get(anchorSeq),
    chapterAtSeq: (seq) => {
      let found: Chapter | undefined;
      let bestAnchor = Number.NEGATIVE_INFINITY;
      for (const chapter of session.chapters) {
        if (!chapter.current) continue;
        const e = entries.get(chapter.id);
        const anchor = anchorOf.get(chapter.id) ?? Number.NEGATIVE_INFINITY;
        if (e !== undefined && e.firstSeq <= seq && seq <= e.lastSeq && anchor > bestAnchor) {
          bestAnchor = anchor;
          found = chapter;
        }
      }
      return found;
    },
    turnAtSeq: (seq) => {
      let found: Turn | undefined = turns[0];
      for (const turn of turns) {
        if (turn.startSeq <= seq) found = turn;
        else break;
      }
      return found;
    },
    findingsBySeq,
    tailStepId: steps[steps.length - 1]?.id ?? null,
    findingsById,
  };
}

export function emptyTraceIndex(sessionId: string): TraceIndex {
  return {
    sessionId,
    session: null,
    loadedThroughSeq: 0,
    stepFirstSeqs: new Int32Array(0),
    entry: () => undefined,
    stepIndexAtOrBefore: () => -1,
    stepIndexAtOrAfter: () => 0,
    chapterKey: () => undefined,
    chapterByAnchor: () => undefined,
    chapterAtSeq: () => undefined,
    turnAtSeq: () => undefined,
    findingsBySeq: [],
    tailStepId: null,
    findingsById: new Map(),
  };
}

/** Inclusive seq range; "live" → loadedThroughSeq; a chapter brush with no chapter falls back to its turn. */
export function brushSeqRange(brush: Brush, index: TraceIndex): { fromSeq: number; toSeq: number } {
  const loaded = Math.max(1, index.loadedThroughSeq);
  if (brush.kind === "session") return { fromSeq: 1, toSeq: loaded };
  if (brush.kind === "range") {
    const to = brush.toSeq === "live" ? loaded : brush.toSeq;
    const from = Math.max(1, Math.min(brush.fromSeq, to));
    return { fromSeq: from, toSeq: Math.max(from, to) };
  }
  const id = index.chapterByAnchor(brush.anchorSeq);
  const entry = id === undefined ? undefined : index.entry(id);
  if (entry !== undefined) return { fromSeq: entry.firstSeq, toSeq: entry.lastSeq };
  const turn = index.turnAtSeq(brush.anchorSeq);
  if (turn !== undefined) return { fromSeq: turn.startSeq, toSeq: Math.max(turn.startSeq, turn.endSeq) };
  return { fromSeq: brush.anchorSeq, toSeq: brush.anchorSeq };
}

export function effectivePlayheadSeq(playhead: Playhead, selection: SelectionId | null, index: TraceIndex): number {
  if (playhead.kind === "live") return index.loadedThroughSeq;
  if (playhead.kind === "free") return playhead.seq;
  const entry = selection === null ? undefined : index.entry(selection);
  return entry === undefined ? index.loadedThroughSeq : entry.firstSeq;
}

export function isStepExpanded(
  step: Step,
  findingsById: ReadonlyMap<FindingId, Finding>,
  expanded: ReadonlySet<string>,
  collapsed: ReadonlySet<string>,
): boolean {
  if (expanded.has(step.id)) return true;
  return step.findingIds.some((id) => findingsById.get(id)?.severity === "critical" && !collapsed.has(id));
}

export function isKeyExpanded(key: string, index: TraceIndex, expanded: ReadonlySet<string>, collapsed: ReadonlySet<string>): boolean {
  if (expanded.has(key)) return true;
  if (key.startsWith("step:")) {
    const entry = index.entry(key);
    const step = entry === undefined ? undefined : index.session?.steps[entry.position];
    return step === undefined ? false : isStepExpanded(step, index.findingsById, expanded, collapsed);
  }
  if (key.startsWith("finding:")) {
    return index.findingsById.get(key as FindingId)?.severity === "critical" && !collapsed.has(key);
  }
  return false;
}
```

`packages/trace-viewer/src/layout/tone.ts`:

```ts
import type { Finding, FindingId, Severity, Step } from "../model/index.js";

export type Tone = "neutral" | "bad" | "good";

const SEVERITY_RANK: { readonly [S in Severity]: number } = { info: 0, warning: 1, critical: 2 };

export function worstSeverity(step: Step, findingsById: ReadonlyMap<FindingId, Finding>): Severity | null {
  let worst: Severity | null = null;
  for (const id of step.findingIds) {
    const severity = findingsById.get(id)?.severity;
    if (severity !== undefined && (worst === null || SEVERITY_RANK[severity] > SEVERITY_RANK[worst])) worst = severity;
  }
  return worst;
}

/** bad: failed test/check, agent_failed, a guardrail problem, or anchoring a critical finding; good: passed test/check; a command with exit > 0 stays neutral. */
export function stepTone(step: Step, findingsById: ReadonlyMap<FindingId, Finding>): Tone {
  if (worstSeverity(step, findingsById) === "critical") return "bad";
  const testLike = step.kind === "test" || step.kind === "check";
  if (testLike && step.status === "failed") return "bad";
  if (step.problems.includes("tests_failed") || step.problems.includes("agent_failed") || step.problems.includes("guardrail")) return "bad";
  if (testLike && step.status === "ok") return "good";
  return "neutral";
}

/** critical → bad, else neutral. */
export function findingTone(finding: Finding): Tone {
  return finding.severity === "critical" ? "bad" : "neutral";
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/trace-index.test.ts src/layout/tone.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Root checks**

```bash
pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint
```

Expected: each exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/trace-viewer/src/layout/trace-index.ts packages/trace-viewer/src/layout/trace-index.test.ts packages/trace-viewer/src/layout/tone.ts packages/trace-viewer/src/layout/tone.test.ts
git commit -m "feat(trace-viewer): trace index, brush and playhead resolution, tone"
```

### Task C1-11: `ViewState`, `ViewAction`, pure `reduce` with invariants; location codec

**Files:**
- Create: `packages/trace-viewer/src/ui/state/location.ts` (deviation 2)
- Test: `packages/trace-viewer/src/ui/state/location.test.ts` (deviation 2)
- Create: `packages/trace-viewer/src/ui/state/view-state.ts`
- Test: `packages/trace-viewer/src/ui/state/view-state.test.ts`
- Test: `packages/trace-viewer/src/ui/state/view-state.property.test.ts`

**Interfaces:**
- Consumes: C1-10 `brushSeqRange`, `effectivePlayheadSeq`, `isKeyExpanded`, `type Brush`, `type Playhead`, `type SelectionId`, `type TraceIndex`, `type IndexEntry`; W0 `type Level`, `type UnitStableId`, `LEVELS`, `StableIdSchema`; zod 3; C1-8 builders and `arbTraceSession` (tests).
- Produces (UI index §2.3 verbatim, plus deviations 4 and 5):

```ts
// ui/state/location.ts
export const PlayheadSchema: z.ZodType<Playhead>;
export const BrushSchema: z.ZodType<Brush>;
export const ViewerLocationSchema: z.ZodObject<…>;   // {v: 1, sessionId, view = "hybrid", level = "chapter", selected?, playhead?, brush = {kind: "session"}}
export type ViewerLocation = z.infer<typeof ViewerLocationSchema>;
export function decodeLocation(raw: unknown, sessionId: string): ViewerLocation;
export function locationToHash(location: ViewerLocation): string;
export function locationFromHash(hash: string, sessionId: string): ViewerLocation;
// ui/state/view-state.ts
export type ViewKind = "canvas" | "hybrid";
export type FocusBy = ViewKind | "shell";
export type InspectorTab = "summary" | "evidence" | "raw";
export type Tool = "select" | "hand";
export type Gesture = null | "pan" | "zoom" | "brush" | "playhead";
export type PlayheadOrigin = "spine" | "overview" | "canvas" | "keys" | "outline" | "search" | "finding" | "live" | "program";
export interface CanvasCamera { mode: "uniform"; tx: number; ty: number; k: number; syncedRev: number }
export interface HybridCamera { mode: "xOnly"; u0: number; k: number; spineAnchor: { key: string; offsetPx: number } | null; syncedRev: number }
export interface SearchState { query: string; matchIds: readonly SelectionId[]; cursor: number }
export interface ViewState {
  view: ViewKind; level: Level; follow: boolean; selection: SelectionId | null;
  selectionNote: { from: UnitStableId; to: UnitStableId } | null;
  playhead: Playhead; playheadOrigin: PlayheadOrigin; brush: Brush; focusRev: number; focusBy: FocusBy;
  expanded: ReadonlySet<string>; collapsed: ReadonlySet<string>; inspectorTab: InspectorTab; tool: Tool;
  search: SearchState | null; lastSeenSeq: number; gesture: Gesture; terminal: boolean; loaded: boolean;
  cameras: { canvas: CanvasCamera | null; hybrid: HybridCamera | null };
  /** Deviation 4: anchor seq of every unit id held in selection, expanded or collapsed. */
  unitAnchors: Readonly<Record<string, number>>;
}
export type ViewAction = /* UI index §2.3 union */ | { type: "select"; id: SelectionId | null; by: FocusBy; origin?: PlayheadOrigin } | …;
export interface InitialViewStateInput { live: boolean; location?: ViewerLocation }
export function initialViewState(input: InitialViewStateInput): ViewState;
export function reduce(state: ViewState, action: ViewAction, index: TraceIndex): ViewState;
export function selectNewCount(state: ViewState, index: TraceIndex): number;
export function selectEffectivePlayheadSeq(state: ViewState, index: TraceIndex): number;
export function selectStepIsTail(id: SelectionId, index: TraceIndex): boolean;
export function locationOf(state: ViewState, sessionId: string): ViewerLocation;
export const SPINE_ROWS_BRUSH_LIMIT = 150;
```

Reducer rules (UI index §2.3 guarantees, spec §7.8 and §7.10):
- Selection writes (`select`, `nav*`, `search/next`, `esc`, `session/applied`) slide the brush, keeping its width, so the selection intersects it; playhead writes slide it so the effective playhead lies inside it; a live playhead keeps a `range` brush's right edge `"live"`. When the two needs conflict (free playhead far from the selection), the brush widens to cover both. Any brush change bumps `focusRev`.
- Brush writes (`brush/set`, `brush/edge`, `brush/chapter`) keep the written brush, clear a selection outside it and clamp the playhead into it (deviation 6).
- While `follow` is true: `playhead/set` with origin ≠ `"live"`, `playhead/step`, `level/set` with `by !== "shell"`, any brush write, a `gesture` other than `null` and a `select` of a non-tail id set `follow` to false; turning follow off turns a `live` playhead into `free` at `loadedThroughSeq`.
- `collapsed` only grows. `session/applied` remaps missing `unit:` ids in `selection`, `expanded` and `collapsed` through `unitAnchors` and `ch:<anchorSeq>`.

- [ ] **Step 1: Write the failing tests**

`packages/trace-viewer/src/ui/state/location.test.ts`:

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { decodeLocation, locationFromHash, locationToHash, ViewerLocationSchema, type ViewerLocation } from "./location.js";

const seq = fc.integer({ min: 1, max: 1_000_000 });
const arbLocation: fc.Arbitrary<ViewerLocation> = fc.record({
  v: fc.constant(1 as const),
  sessionId: fc.constant("sess-1"),
  view: fc.constantFrom("canvas" as const, "hybrid" as const),
  level: fc.constantFrom("session" as const, "chapter" as const, "step" as const),
  selected: fc.option(fc.oneof(seq.map((n) => `step:${n}`), fc.string({ minLength: 1 }).map((s) => `unit:${s}`)), { nil: undefined }),
  playhead: fc.option(fc.oneof(
    fc.constant({ kind: "selection" as const }), fc.constant({ kind: "live" as const }), seq.map((n) => ({ kind: "free" as const, seq: n })),
  ), { nil: undefined }),
  brush: fc.oneof(
    fc.constant({ kind: "session" as const }),
    seq.map((n) => ({ kind: "chapter" as const, anchorSeq: n })),
    fc.tuple(seq, fc.oneof(seq, fc.constant("live" as const))).map(([fromSeq, toSeq]) => ({ kind: "range" as const, fromSeq, toSeq })),
  ),
}).map((l) => ViewerLocationSchema.parse(l));

describe("location codec", () => {
  it("never throws and falls back to defaults", () => {
    const defaults = { v: 1, sessionId: "s", view: "hybrid", level: "chapter", brush: { kind: "session" } };
    expect(decodeLocation("garbage", "s")).toEqual(defaults);
    expect(decodeLocation({ v: 1, sessionId: "other", view: "canvas" }, "s")).toEqual(defaults);
    expect(decodeLocation({ v: 1, sessionId: "s", brush: { kind: "range", fromSeq: 0, toSeq: 3 } }, "s")).toEqual(defaults);
    expect(locationFromHash("#%E0%A4%A", "s")).toEqual(defaults);
    expect(locationFromHash("", "s")).toEqual(defaults);
  });

  it("keeps a valid location for the same session", () => {
    const l = decodeLocation({ v: 1, sessionId: "s", view: "canvas", selected: "decision:dec-oauth-0001", brush: { kind: "range", fromSeq: 5, toSeq: "live" } }, "s");
    expect(l).toMatchObject({ view: "canvas", level: "chapter", selected: "decision:dec-oauth-0001", brush: { kind: "range", fromSeq: 5, toSeq: "live" } });
  });

  it("round-trips through the URL hash", () => {
    fc.assert(fc.property(arbLocation, (location) => {
      expect(locationFromHash(locationToHash(location), location.sessionId)).toEqual(location);
    }));
  });
});
```

`packages/trace-viewer/src/ui/state/view-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { brushSeqRange, buildTraceIndex, isKeyExpanded, type TraceIndex } from "../../layout/trace-index.js";
import { buildSession, OAUTH_CLAIM_TEXT, oauthLikeSession, type StepSeed } from "../../test-support/session-builder.js";
import { initialViewState, locationOf, reduce, selectNewCount, type ViewAction, type ViewState } from "./view-state.js";

const oauth = oauthLikeSession();
const index = buildTraceIndex(oauth);
const claim = oauth.steps.find((s) => s.text === OAUTH_CLAIM_TEXT);
const test = oauth.steps.find((s) => s.kind === "test");
if (claim === undefined || test === undefined) throw new Error("oauth-like session is missing its claim or test");

const run = (state: ViewState, actions: readonly ViewAction[], idx: TraceIndex = index): ViewState =>
  actions.reduce((s, a) => reduce(s, a, idx), state);
const applied = (idx: TraceIndex, extra: Partial<Extract<ViewAction, { type: "session/applied" }>> = {}): ViewAction => ({
  type: "session/applied", loadedThroughSeq: idx.loadedThroughSeq, terminal: false, loadComplete: true,
  initialSelection: null, chapterSpineRows: 20, ...extra,
});

describe("initial state and defaults on open (spec §7.8)", () => {
  it("Review opens on the initial selection with a session brush", () => {
    const s = run(initialViewState({ live: false }), [applied(index, { terminal: true, initialSelection: claim.id })]);
    expect(s).toMatchObject({ selection: claim.id, playhead: { kind: "selection" }, brush: { kind: "session" }, loaded: true, terminal: true, follow: false });
  });

  it("Review uses the chapter holding the selection when the Chapter spine exceeds 150 rows", () => {
    const s = run(initialViewState({ live: false }), [applied(index, { initialSelection: test.id, chapterSpineRows: 151 })]);
    expect(s.brush).toEqual({ kind: "chapter", anchorSeq: Number(index.chapterKey("unit:u-linking-test")?.slice(3)) });
  });

  it("Live opens without a selection and with the playhead at the edge", () => {
    const s = run(initialViewState({ live: true }), [applied(index, { initialSelection: claim.id })]);
    expect(s).toMatchObject({ selection: null, playhead: { kind: "live" }, follow: true, lastSeenSeq: oauth.loadedThroughSeq });
  });

  it("returns the same object when nothing changes", () => {
    const s = initialViewState({ live: false });
    expect(reduce(s, { type: "tool/set", tool: "select" }, index)).toBe(s);
    expect(reduce(s, { type: "view/switch", view: "hybrid" }, index)).toBe(s);
  });
});

describe("selection, playhead and brush", () => {
  it("select resets Raw to Summary but keeps Evidence, and bumps focusRev", () => {
    let s = run(initialViewState({ live: false }), [{ type: "inspector/tab", tab: "raw" }, { type: "select", id: test.id, by: "hybrid" }]);
    expect(s).toMatchObject({ inspectorTab: "summary", focusRev: 1, focusBy: "hybrid", playheadOrigin: "overview" });
    s = run(s, [{ type: "inspector/tab", tab: "evidence" }, { type: "select", id: claim.id, by: "shell", origin: "spine" }]);
    expect(s).toMatchObject({ inspectorTab: "evidence", playheadOrigin: "spine" });
  });

  it("a selection outside a chapter brush slides the brush to its chapter", () => {
    const identity = oauth.steps.find((s) => s.target === "src/auth/identity.ts");
    const s = run(initialViewState({ live: false }), [
      { type: "select", id: test.id, by: "shell" },
      { type: "brush/chapter" },
      { type: "select", id: identity?.id ?? claim.id, by: "shell" },
    ]);
    const range = brushSeqRange(s.brush, index);
    expect(range.fromSeq).toBeLessThanOrEqual(identity?.firstSeq ?? 0);
    expect(range.toSeq).toBeGreaterThanOrEqual(identity?.firstSeq ?? 0);
  });

  it("a brush write keeps the brush, clears a selection outside it and clamps the playhead", () => {
    const s = run(initialViewState({ live: false }), [
      { type: "select", id: claim.id, by: "shell" },
      { type: "brush/set", brush: { kind: "range", fromSeq: 1, toSeq: 5 }, by: "hybrid" },
    ]);
    expect(s).toMatchObject({ brush: { kind: "range", fromSeq: 1, toSeq: 5 }, selection: null, playhead: { kind: "free", seq: 5 } });
  });

  it("playhead steps move by one step and switch Live to Review", () => {
    const s = run(initialViewState({ live: true }), [applied(index), { type: "playhead/step", dir: -1 }]);
    const last = oauth.steps.at(-1);
    const prev = oauth.steps.at(-2);
    expect(last?.firstSeq).toBe(index.loadedThroughSeq);
    expect(s).toMatchObject({ follow: false, playhead: { kind: "free", seq: prev?.firstSeq }, playheadOrigin: "keys" });
  });

  it("selecting the tail keeps Live; selecting anything else switches to Review", () => {
    const tail = index.tailStepId;
    const live = run(initialViewState({ live: true }), [applied(index)]);
    expect(reduce(live, { type: "select", id: tail ?? claim.id, by: "hybrid" }, index)).toMatchObject({ follow: true, playhead: { kind: "live" } });
    expect(reduce(live, { type: "select", id: test.id, by: "hybrid" }, index)).toMatchObject({ follow: false, playhead: { kind: "selection" } });
  });

  it("n wraps through findings in seq order", () => {
    const s0 = run(initialViewState({ live: false }), [{ type: "select", id: claim.id, by: "shell" }]);
    const s1 = reduce(s0, { type: "nav", target: "finding", dir: 1 }, index);
    expect(s1.selection).toBe(test.id);
    const s2 = reduce(s1, { type: "nav", target: "finding", dir: 1 }, index);
    expect(s2.selection).toBe(claim.id);
  });

  it("J moves to the next chapter by anchor; ] and [ move between turns", () => {
    const s = run(initialViewState({ live: false }), [{ type: "select", id: "unit:u-identity", by: "shell" }, { type: "nav", target: "chapter", dir: 1 }]);
    const identityKey = Number(index.chapterKey("unit:u-identity")?.slice(3));
    const nextKey = Number(index.chapterKey(s.selection as `unit:${string}`)?.slice(3));
    expect(nextKey).toBeGreaterThan(identityKey);
    const two = buildSession({
      turns: [{ trigger: "initial", prompt: "a" }, { trigger: "steer", prompt: "b" }],
      steps: [{ kind: "instruction", tMs: 0 }, { kind: "message", tMs: 1 }, { kind: "instruction", tMs: 2, turn: 1 }, { kind: "message", tMs: 3, turn: 1 }],
    });
    const idx = buildTraceIndex(two);
    const t = run(initialViewState({ live: false }), [{ type: "select", id: "step:2", by: "shell" }, { type: "nav", target: "turn", dir: 1 }], idx);
    expect(t.selection).toBe("step:3");
    expect(reduce(t, { type: "nav", target: "turn", dir: -1 }, idx).selection).toBe("step:1");
  });
});

describe("expansion, esc and live bookkeeping", () => {
  it("a collapsed critical finding stays collapsed across session/applied", () => {
    const findingId = claim.findingIds[0] ?? "";
    let s = run(initialViewState({ live: false }), [applied(index, { initialSelection: claim.id })]);
    expect(isKeyExpanded(claim.id, index, s.expanded, s.collapsed)).toBe(true);
    s = reduce(s, { type: "expand/toggle", key: claim.id }, index);
    expect(s.collapsed.has(findingId)).toBe(true);
    // A live append of three filtered rows: same steps and findings, higher loadedThroughSeq.
    const grown = oauth.loadedThroughSeq + 3;
    const longer = buildTraceIndex({ ...oauth, loadedThroughSeq: grown, meta: { ...oauth.meta, lastEventSeq: grown } });
    s = reduce(s, applied(longer), longer);
    expect(s.collapsed.has(findingId)).toBe(true);
    expect(isKeyExpanded(claim.id, longer, s.expanded, s.collapsed)).toBe(false);
  });

  it("regrouped selection follows the anchor seq", () => {
    const steps: StepSeed[] = [
      { kind: "instruction", tMs: 0 },
      { kind: "edit", tMs: 1_000, target: "a.ts", chapter: "u1" },
      { kind: "edit", tMs: 2_000, target: "b.ts", chapter: "u1" },
    ];
    const before = buildTraceIndex(buildSession({ steps, chapters: [{ id: "u1", title: "Identity layer" }] }));
    const after = buildTraceIndex(buildSession({
      steps: steps.map((s) => (s.chapter === "u1" ? { ...s, chapter: "u2" } : s)),
      chapters: [{ id: "u2", title: "Identity layer" }],
    }));
    let s = run(initialViewState({ live: false }), [
      { type: "select", id: "unit:u1", by: "canvas" },
      { type: "expand/set", key: "unit:u1", expanded: true },
      { type: "brush/chapter" },
    ], before);
    const brushBefore = brushSeqRange(s.brush, before);
    s = reduce(s, applied(after), after);
    expect(s.selection).toBe("unit:u2");
    expect(s.selectionNote).toEqual({ from: "unit:u1", to: "unit:u2" });
    expect(s.expanded.has("unit:u2")).toBe(true);
    expect(s.expanded.has("unit:u1")).toBe(false);
    expect(brushSeqRange(s.brush, after)).toEqual(brushBefore);
  });

  it("esc unwinds search, hand tool, expansion, parent, then clears", () => {
    let s = run(initialViewState({ live: false }), [
      { type: "select", id: test.id, by: "shell" },
      { type: "expand/set", key: test.id, expanded: true },
      { type: "tool/set", tool: "hand" },
      { type: "search/set", query: "pnpm", matchIds: [test.id] },
    ]);
    s = reduce(s, { type: "esc" }, index);
    expect(s.search).toBeNull();
    s = reduce(s, { type: "esc" }, index);
    expect(s.tool).toBe("select");
    s = reduce(s, { type: "esc" }, index);
    expect(isKeyExpanded(test.id, index, s.expanded, s.collapsed)).toBe(false);
    s = reduce(s, { type: "esc" }, index);
    expect(s.selection).toBe("unit:u-linking-test");
    s = reduce(s, { type: "esc" }, index);
    expect(s.selection).toBeNull();
    const cameraBefore = s.cameras;
    expect(reduce(s, { type: "esc" }, index).cameras).toBe(cameraBefore);
  });

  it("a terminal apply disables Live once and camera/sync never bumps focusRev", () => {
    let s = run(initialViewState({ live: true }), [applied(index)]);
    s = reduce(s, applied(index, { terminal: true }), index);
    expect(s).toMatchObject({ terminal: true, follow: false, playhead: { kind: "free", seq: index.loadedThroughSeq } });
    expect(reduce(s, { type: "follow/set", follow: true }, index)).toBe(s);
    const rev = s.focusRev;
    s = reduce(s, { type: "camera/sync", view: "canvas", camera: { mode: "uniform", tx: 1, ty: 2, k: 1 } }, index);
    expect(s.focusRev).toBe(rev);
    expect(s.cameras.canvas).toEqual({ mode: "uniform", tx: 1, ty: 2, k: 1, syncedRev: rev });
  });

  it("switching views there and back is the identity; lastSeenSeq and N new", () => {
    const s = run(initialViewState({ live: false }), [applied(index, { initialSelection: claim.id })]);
    expect(run(s, [{ type: "view/switch", view: "canvas" }, { type: "view/switch", view: "hybrid" }])).toEqual(s);
    expect(selectNewCount(s, index)).toBe(oauth.steps.length);
    const seen = reduce(s, { type: "seen", seq: 20 }, index);
    expect(reduce(seen, { type: "seen", seq: 5 }, index).lastSeenSeq).toBe(20);
    expect(selectNewCount(seen, index)).toBe(oauth.steps.filter((st) => st.firstSeq > 20).length);
    expect(locationOf(s, "sess-oauth-0001")).toMatchObject({ v: 1, sessionId: "sess-oauth-0001", view: "hybrid", selected: claim.id, brush: { kind: "session" } });
  });
});
```

`packages/trace-viewer/src/ui/state/view-state.property.test.ts`:

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { TraceSession } from "../../model/index.js";
import { brushSeqRange, buildTraceIndex, effectivePlayheadSeq, type Brush } from "../../layout/trace-index.js";
import { arbTraceSession } from "../../test-support/arbitraries.js";
import { initialViewState, reduce, type ViewAction, type ViewState } from "./view-state.js";

function arbAction(session: TraceSession): fc.Arbitrary<ViewAction> {
  const stepIds = session.steps.map((s) => s.id);
  const unitIds = session.chapters.map((c) => c.id);
  const ids = [...stepIds, ...unitIds];
  const seqs = session.steps.map((s) => s.firstSeq);
  const findingIds = session.findings.map((f) => f.id);
  const by = fc.constantFrom("canvas" as const, "hybrid" as const, "shell" as const);
  const seq = fc.constantFrom(...seqs);
  const brush: fc.Arbitrary<Brush> = fc.oneof(
    fc.constant({ kind: "session" as const }),
    fc.tuple(seq, seq, fc.boolean()).map(([a, b, live]) => ({ kind: "range" as const, fromSeq: Math.min(a, b), toSeq: live ? ("live" as const) : Math.max(a, b) })),
    seq.map((anchorSeq) => ({ kind: "chapter" as const, anchorSeq })),
  );
  return fc.oneof(
    fc.record({ type: fc.constant("select" as const), id: fc.option(fc.constantFrom(...ids), { nil: null }), by }),
    fc.record({ type: fc.constant("nav" as const), target: fc.constantFrom("chapter" as const, "turn" as const, "finding" as const), dir: fc.constantFrom(1 as const, -1 as const) }),
    fc.constant({ type: "nav/first" as const }),
    fc.constant({ type: "nav/last" as const }),
    fc.record({ type: fc.constant("view/switch" as const), view: fc.constantFrom("canvas" as const, "hybrid" as const) }),
    fc.record({ type: fc.constant("level/set" as const), level: fc.constantFrom("session" as const, "chapter" as const, "step" as const), by }),
    fc.record({ type: fc.constant("follow/set" as const), follow: fc.boolean() }),
    fc.record({
      type: fc.constant("playhead/set" as const),
      playhead: fc.oneof(fc.constant({ kind: "live" as const }), fc.constant({ kind: "selection" as const }), seq.map((s) => ({ kind: "free" as const, seq: s }))),
      origin: fc.constantFrom("spine" as const, "overview" as const, "keys" as const, "live" as const),
    }),
    fc.record({ type: fc.constant("playhead/step" as const), dir: fc.constantFrom(1 as const, -1 as const) }),
    fc.record({ type: fc.constant("brush/set" as const), brush, by: fc.constantFrom("canvas" as const, "hybrid" as const) }),
    fc.record({ type: fc.constant("brush/edge" as const), edge: fc.constantFrom("from" as const, "to" as const) }),
    fc.constant({ type: "brush/chapter" as const }),
    fc.record({ type: fc.constant("expand/toggle" as const), key: fc.constantFrom(...ids, ...(findingIds.length > 0 ? findingIds : ["finding:none"])) }),
    fc.record({ type: fc.constant("inspector/tab" as const), tab: fc.constantFrom("summary" as const, "evidence" as const, "raw" as const) }),
    fc.record({ type: fc.constant("tool/set" as const), tool: fc.constantFrom("select" as const, "hand" as const) }),
    fc.record({ type: fc.constant("gesture" as const), gesture: fc.constantFrom(null, "pan" as const, "zoom" as const, "brush" as const, "playhead" as const) }),
    fc.record({ type: fc.constant("camera/sync" as const), view: fc.constant("canvas" as const), camera: fc.constant({ mode: "uniform" as const, tx: 3, ty: 4, k: 1 }) }),
    fc.record({ type: fc.constant("search/set" as const), query: fc.constantFrom("", "pnpm"), matchIds: fc.subarray(ids) }),
    fc.record({ type: fc.constant("search/next" as const), dir: fc.constantFrom(1 as const, -1 as const) }),
    fc.constant({ type: "esc" as const }),
    fc.record({ type: fc.constant("seen" as const), seq }),
    fc.record({
      type: fc.constant("session/applied" as const),
      loadedThroughSeq: fc.constant(session.loadedThroughSeq),
      terminal: fc.boolean(),
      loadComplete: fc.boolean(),
      initialSelection: fc.option(fc.constantFrom(...stepIds), { nil: null }),
      chapterSpineRows: fc.integer({ min: 0, max: 300 }),
    }),
  );
}

const scenario = arbTraceSession({ maxSteps: 30, maxChapters: 4, maxTurns: 3 }).chain((session) =>
  fc.tuple(fc.constant(session), fc.boolean(), fc.array(arbAction(session), { minLength: 1, maxLength: 40 })));

function intersects(state: ViewState, index: ReturnType<typeof buildTraceIndex>): boolean {
  if (state.selection === null) return true;
  const entry = index.entry(state.selection);
  if (entry === undefined) return true;
  const r = brushSeqRange(state.brush, index);
  return entry.lastSeq >= r.fromSeq && entry.firstSeq <= r.toSeq;
}

describe("reduce invariants (UI index §2.3)", () => {
  it("holds selection ∩ brush, playhead ∈ brush, monotone lastSeenSeq and collapsed, and rev rules", () => {
    fc.assert(fc.property(scenario, ([session, live, actions]) => {
      const index = buildTraceIndex(session);
      let state = initialViewState({ live });
      for (const action of actions) {
        const next = reduce(state, action, index);
        expect(intersects(next, index)).toBe(true);
        const r = brushSeqRange(next.brush, index);
        const p = effectivePlayheadSeq(next.playhead, next.selection, index);
        expect(p).toBeGreaterThanOrEqual(r.fromSeq);
        expect(p).toBeLessThanOrEqual(r.toSeq);
        expect(next.lastSeenSeq).toBeGreaterThanOrEqual(state.lastSeenSeq);
        for (const id of state.collapsed) expect(next.collapsed.has(id)).toBe(true);
        if (action.type === "camera/sync") expect(next.focusRev).toBe(state.focusRev);
        if (action.type === "select" && action.id !== state.selection && state.inspectorTab === "raw" && next.selection !== state.selection) {
          expect(next.inspectorTab).toBe("summary");
        }
        if (state.follow && ((action.type === "playhead/set" && action.origin !== "live") || action.type === "playhead/step" || action.type === "brush/set")) {
          expect(next.follow).toBe(false);
        }
        const other = next.view === "canvas" ? "hybrid" : "canvas";
        const back = reduce(reduce(next, { type: "view/switch", view: other }, index), { type: "view/switch", view: next.view }, index);
        expect({ ...back, cameras: next.cameras }).toEqual(next);
        state = next;
      }
    }), { numRuns: 200 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/state/location.test.ts src/ui/state/view-state.test.ts src/ui/state/view-state.property.test.ts`
Expected: FAIL, `Failed to resolve import "./location.js"`.

- [ ] **Step 3: Write the implementation**

`packages/trace-viewer/src/ui/state/location.ts`:

```ts
import { z } from "zod";

import type { Brush, Playhead } from "../../layout/trace-index.js";
import { LEVELS, StableIdSchema } from "../../model/index.js";

const seq = z.number().int().positive();

export const PlayheadSchema: z.ZodType<Playhead> = z.union([
  z.object({ kind: z.literal("selection") }),
  z.object({ kind: z.literal("live") }),
  z.object({ kind: z.literal("free"), seq }),
]);

export const BrushSchema: z.ZodType<Brush> = z.union([
  z.object({ kind: z.literal("session") }),
  z.object({ kind: z.literal("chapter"), anchorSeq: seq }),
  z.object({ kind: z.literal("range"), fromSeq: seq, toSeq: z.union([seq, z.literal("live")]) }),
]);

export const ViewerLocationSchema = z.object({
  v: z.literal(1),
  sessionId: z.string().min(1),
  view: z.enum(["canvas", "hybrid"]).default("hybrid"),
  level: z.enum(LEVELS).default("chapter"),
  selected: StableIdSchema.optional(),
  playhead: PlayheadSchema.optional(),
  brush: BrushSchema.default({ kind: "session" }),
});
export type ViewerLocation = z.infer<typeof ViewerLocationSchema>;

/** Never throws; any failure or a different sessionId yields the defaults for sessionId. */
export function decodeLocation(raw: unknown, sessionId: string): ViewerLocation {
  const parsed = ViewerLocationSchema.safeParse(raw);
  if (parsed.success && parsed.data.sessionId === sessionId) return parsed.data;
  return ViewerLocationSchema.parse({ v: 1, sessionId: sessionId.length > 0 ? sessionId : "unknown" });
}

/** "#" + encodeURIComponent(JSON.stringify(location)). */
export function locationToHash(location: ViewerLocation): string {
  return `#${encodeURIComponent(JSON.stringify(location))}`;
}

export function locationFromHash(hash: string, sessionId: string): ViewerLocation {
  const body = hash.startsWith("#") ? hash.slice(1) : hash;
  try {
    return decodeLocation(JSON.parse(decodeURIComponent(body)), sessionId);
  } catch {
    return decodeLocation(null, sessionId);
  }
}
```

`packages/trace-viewer/src/ui/state/view-state.ts`:

```ts
import type { Level, UnitStableId } from "../../model/index.js";
import {
  brushSeqRange, effectivePlayheadSeq, isKeyExpanded,
  type Brush, type Playhead, type SelectionId, type TraceIndex,
} from "../../layout/trace-index.js";
import type { ViewerLocation } from "./location.js";

export type ViewKind = "canvas" | "hybrid";
export type FocusBy = ViewKind | "shell";
export type InspectorTab = "summary" | "evidence" | "raw";
export type Tool = "select" | "hand";
export type Gesture = null | "pan" | "zoom" | "brush" | "playhead";
export type PlayheadOrigin = "spine" | "overview" | "canvas" | "keys" | "outline" | "search" | "finding" | "live" | "program";

export interface CanvasCamera { mode: "uniform"; tx: number; ty: number; k: number; syncedRev: number }
export interface HybridCamera { mode: "xOnly"; u0: number; k: number; spineAnchor: { key: string; offsetPx: number } | null; syncedRev: number }
export interface SearchState { query: string; matchIds: readonly SelectionId[]; cursor: number }

export interface ViewState {
  view: ViewKind;
  level: Level;
  /** Live = true. */
  follow: boolean;
  selection: SelectionId | null;
  /** Set when a re-cluster moved the selection; cleared by the next select. */
  selectionNote: { from: UnitStableId; to: UnitStableId } | null;
  playhead: Playhead;
  /** Origin of the last playhead write; the spine never scrolls for "spine". */
  playheadOrigin: PlayheadOrigin;
  brush: Brush;
  /** +1 on every selection, brush or level write a hidden view must catch up with; never on programmatic camera moves. */
  focusRev: number;
  focusBy: FocusBy;
  /** Expanded row, frame and finding keys. */
  expanded: ReadonlySet<string>;
  /** Finding ids the reader collapsed; later folds never re-expand them. */
  collapsed: ReadonlySet<string>;
  inspectorTab: InspectorTab;
  tool: Tool;
  search: SearchState | null;
  lastSeenSeq: number;
  gesture: Gesture;
  /** Terminal state reached and final apply done; Live disabled. */
  terminal: boolean;
  /** Load reached lastSeq at least once; the initial selection has run. */
  loaded: boolean;
  cameras: { canvas: CanvasCamera | null; hybrid: HybridCamera | null };
  /** Anchor seq of every unit id held in selection, expanded or collapsed (remaps regrouped units). */
  unitAnchors: Readonly<Record<string, number>>;
}

export type ViewAction =
  | { type: "session/applied"; loadedThroughSeq: number; terminal: boolean; loadComplete: boolean; initialSelection: SelectionId | null; chapterSpineRows: number }
  | { type: "select"; id: SelectionId | null; by: FocusBy; origin?: PlayheadOrigin }
  | { type: "nav"; target: "chapter" | "turn" | "finding"; dir: 1 | -1 }
  | { type: "nav/first" }
  | { type: "nav/last" }
  | { type: "view/switch"; view: ViewKind }
  | { type: "level/set"; level: Level; by: FocusBy }
  | { type: "follow/set"; follow: boolean }
  | { type: "playhead/set"; playhead: Playhead; origin: PlayheadOrigin }
  | { type: "playhead/step"; dir: 1 | -1 }
  | { type: "brush/set"; brush: Brush; by: ViewKind }
  | { type: "brush/edge"; edge: "from" | "to" }
  | { type: "brush/chapter" }
  | { type: "expand/toggle"; key: string }
  | { type: "expand/set"; key: string; expanded: boolean }
  | { type: "inspector/tab"; tab: InspectorTab }
  | { type: "tool/set"; tool: Tool }
  | { type: "gesture"; gesture: Gesture }
  | { type: "camera/sync"; view: "canvas"; camera: Omit<CanvasCamera, "syncedRev"> }
  | { type: "camera/sync"; view: "hybrid"; camera: Omit<HybridCamera, "syncedRev"> }
  | { type: "search/set"; query: string; matchIds: readonly SelectionId[] }
  | { type: "search/next"; dir: 1 | -1 }
  | { type: "esc" }
  | { type: "seen"; seq: number };

export interface InitialViewStateInput { live: boolean; location?: ViewerLocation }

/** Spec §7.8: the brush stays `session` when the Chapter-level spine has at most this many rows. */
export const SPINE_ROWS_BRUSH_LIMIT = 150;

const EMPTY: ReadonlySet<string> = new Set<string>();

export function initialViewState(input: InitialViewStateInput): ViewState {
  const location = input.location;
  const selected = location?.selected;
  const selection = selected !== undefined && (selected.startsWith("step:") || selected.startsWith("unit:"))
    ? (selected as SelectionId)
    : null;
  return {
    view: location?.view ?? "hybrid",
    level: location?.level ?? "chapter",
    follow: input.live,
    selection,
    selectionNote: null,
    playhead: location?.playhead ?? (input.live ? { kind: "live" } : { kind: "selection" }),
    playheadOrigin: "program",
    brush: location?.brush ?? { kind: "session" },
    focusRev: 0,
    focusBy: "shell",
    expanded: EMPTY,
    collapsed: EMPTY,
    inspectorTab: "summary",
    tool: "select",
    search: null,
    lastSeenSeq: 0,
    gesture: null,
    terminal: false,
    loaded: false,
    cameras: { canvas: null, hybrid: null },
    unitAnchors: {},
  };
}

// ------------------------------------------------------------ helpers

function lastIndexWhere<T>(items: readonly T[], pred: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item !== undefined && pred(item)) return i;
  }
  return -1;
}

const anchorOf = (id: UnitStableId, index: TraceIndex): number | undefined => {
  const key = index.chapterKey(id);
  return key === undefined ? undefined : Number(key.slice(3));
};

function rememberAnchors(anchors: Readonly<Record<string, number>>, keys: readonly (string | null)[], index: TraceIndex): Readonly<Record<string, number>> {
  let next: Record<string, number> | null = null;
  for (const key of keys) {
    if (key === null || !key.startsWith("unit:")) continue;
    const anchor = anchorOf(key as UnitStableId, index);
    if (anchor === undefined || anchors[key] === anchor) continue;
    next ??= { ...anchors };
    next[key] = anchor;
  }
  return next ?? anchors;
}

function withKey(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  if (set.has(key)) return set;
  const next = new Set(set);
  next.add(key);
  return next;
}

function withoutKey(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  if (!set.has(key)) return set;
  const next = new Set(set);
  next.delete(key);
  return next;
}

function originFor(by: FocusBy): PlayheadOrigin {
  return by === "canvas" ? "canvas" : by === "hybrid" ? "overview" : "outline";
}

function leaveLive(state: ViewState, index: TraceIndex): ViewState {
  if (!state.follow) return state;
  const playhead: Playhead = state.playhead.kind === "live" ? { kind: "free", seq: index.loadedThroughSeq } : state.playhead;
  return { ...state, follow: false, playhead };
}

/** Moves the brush the least (keeping its width) so its range meets [lo, hi]. */
function slideToInclude(brush: Brush, index: TraceIndex, lo: number, hi: number, liveEdge: boolean): Brush {
  const r = brushSeqRange(brush, index);
  if (r.toSeq >= lo && r.fromSeq <= hi) return brush;
  if (brush.kind === "session") return brush;
  if (brush.kind === "chapter") {
    const chapter = index.chapterAtSeq(lo);
    const anchor = chapter === undefined ? undefined : anchorOf(chapter.id, index);
    if (anchor !== undefined) {
      const candidate: Brush = { kind: "chapter", anchorSeq: anchor };
      const c = brushSeqRange(candidate, index);
      if (c.toSeq >= lo && c.fromSeq <= hi) return candidate;
    }
  }
  const width = r.toSeq - r.fromSeq;
  if (hi < r.fromSeq) {
    const toSeq = hi;
    return { kind: "range", fromSeq: Math.max(1, toSeq - width), toSeq: Math.max(1, toSeq) };
  }
  const fromSeq = Math.max(1, lo);
  if (liveEdge || (brush.kind === "range" && brush.toSeq === "live")) {
    return { kind: "range", fromSeq: Math.max(1, Math.min(fromSeq, index.loadedThroughSeq - width)), toSeq: "live" };
  }
  return { kind: "range", fromSeq, toSeq: fromSeq + width };
}

/** Selection ∩ brush and playhead ∈ brush (UI index §2.3); bumps focusRev when the brush moves. */
function ensureInvariants(state: ViewState, index: TraceIndex): ViewState {
  if (index.session === null || index.session.steps.length === 0) return state;
  const live = state.playhead.kind === "live";
  let brush = state.brush;
  const sel = state.selection === null ? undefined : index.entry(state.selection);
  if (sel !== undefined) brush = slideToInclude(brush, index, sel.firstSeq, sel.lastSeq, live);
  const p = effectivePlayheadSeq(state.playhead, state.selection, index);
  brush = slideToInclude(brush, index, p, p, live);
  if (sel !== undefined) {
    const r = brushSeqRange(brush, index);
    if (!(r.toSeq >= sel.firstSeq && r.fromSeq <= sel.lastSeq)) {
      brush = { kind: "range", fromSeq: Math.max(1, Math.min(r.fromSeq, sel.lastSeq)), toSeq: Math.max(r.toSeq, sel.firstSeq) };
    }
  }
  return brush === state.brush ? state : { ...state, brush, focusRev: state.focusRev + 1 };
}

function isTail(id: SelectionId, index: TraceIndex): boolean {
  const tail = index.tailStepId;
  if (tail === null) return false;
  if (id === tail) return true;
  if (!id.startsWith("unit:")) return false;
  if (index.entry(tail)?.parent === id) return true;
  return index.session?.chapters.some((c) => c.id === id && c.stepIds.includes(tail)) ?? false;
}

function selectId(state: ViewState, id: SelectionId | null, by: FocusBy, origin: PlayheadOrigin, index: TraceIndex): ViewState {
  if (id !== null && index.entry(id) === undefined) return state;
  if (id === state.selection && (id === null || state.playhead.kind === "selection")) return state;
  const prevP = effectivePlayheadSeq(state.playhead, state.selection, index);
  const follow = state.follow && (id === null || isTail(id, index));
  let playhead: Playhead;
  if (id === null) playhead = state.playhead.kind === "selection" ? { kind: "free", seq: prevP } : state.playhead;
  else playhead = follow ? { kind: "live" } : { kind: "selection" };
  if (!follow && playhead.kind === "live") playhead = { kind: "free", seq: index.loadedThroughSeq };
  const next: ViewState = {
    ...state,
    selection: id,
    selectionNote: null,
    playhead,
    playheadOrigin: origin,
    focusRev: state.focusRev + 1,
    focusBy: by,
    inspectorTab: state.inspectorTab === "raw" && id !== state.selection ? "summary" : state.inspectorTab,
    follow,
    unitAnchors: rememberAnchors(state.unitAnchors, [id], index),
  };
  return ensureInvariants(next, index);
}

/** Brush writes keep the written brush; a selection outside it clears and the playhead clamps into it. */
function writeBrush(state: ViewState, brush: Brush, by: FocusBy, index: TraceIndex): ViewState {
  const base = leaveLive(state, index);
  const prevP = effectivePlayheadSeq(base.playhead, base.selection, index);
  const r = brushSeqRange(brush, index);
  const sel = base.selection === null ? undefined : index.entry(base.selection);
  const keep = sel === undefined || (sel.lastSeq >= r.fromSeq && sel.firstSeq <= r.toSeq);
  const selection = keep ? base.selection : null;
  let playhead: Playhead = base.playhead;
  if (!keep && playhead.kind === "selection") playhead = { kind: "free", seq: prevP };
  const p = effectivePlayheadSeq(playhead, selection, index);
  if (p < r.fromSeq || p > r.toSeq) playhead = { kind: "free", seq: Math.min(r.toSeq, Math.max(r.fromSeq, p)) };
  return {
    ...base,
    brush,
    selection,
    selectionNote: keep ? base.selectionNote : null,
    playhead,
    focusRev: base.focusRev + 1,
    focusBy: by,
  };
}

function setExpanded(state: ViewState, key: string, want: boolean, index: TraceIndex): ViewState {
  if (isKeyExpanded(key, index, state.expanded, state.collapsed) === want) return state;
  if (want) {
    return { ...state, expanded: withKey(state.expanded, key), unitAnchors: rememberAnchors(state.unitAnchors, [key], index) };
  }
  let collapsed = state.collapsed;
  if (key.startsWith("finding:")) collapsed = withKey(collapsed, key);
  if (key.startsWith("step:")) {
    const entry = index.entry(key);
    const step = entry === undefined ? undefined : index.session?.steps[entry.position];
    for (const id of step?.findingIds ?? []) {
      if (index.findingsById.get(id)?.severity === "critical") collapsed = withKey(collapsed, id);
    }
  }
  return { ...state, expanded: withoutKey(state.expanded, key), collapsed };
}

function chapterBrushFor(id: SelectionId | null, index: TraceIndex): Brush | null {
  if (id === null) return null;
  const unit = id.startsWith("unit:") ? (id as UnitStableId) : index.entry(id)?.parent ?? null;
  const anchor = unit === null ? undefined : anchorOf(unit, index);
  return anchor === undefined ? null : { kind: "chapter", anchorSeq: anchor };
}

function applySession(state: ViewState, action: Extract<ViewAction, { type: "session/applied" }>, index: TraceIndex): ViewState {
  let s = state;
  const remap = (key: string): UnitStableId | null => {
    if (!key.startsWith("unit:") || index.entry(key) !== undefined) return null;
    const anchor = s.unitAnchors[key];
    if (anchor === undefined) return null;
    const to = index.chapterByAnchor(anchor) ?? index.chapterAtSeq(anchor)?.id;
    return to !== undefined && to !== key ? to : null;
  };
  let anchors = s.unitAnchors;
  const carry = (from: string, to: UnitStableId): void => {
    const anchor = anchors[from];
    if (anchor !== undefined && anchors[to] !== anchor) anchors = { ...anchors, [to]: anchor };
  };
  if (s.selection !== null) {
    const from = s.selection;
    const to = remap(from);
    if (to !== null) {
      carry(from, to);
      s = { ...s, selection: to, selectionNote: { from: from as UnitStableId, to }, focusRev: s.focusRev + 1, focusBy: "shell" };
    }
  }
  let expanded = s.expanded;
  for (const key of s.expanded) {
    const to = remap(key);
    if (to === null) continue;
    carry(key, to);
    expanded = withKey(withoutKey(expanded, key), to);
  }
  let collapsed = s.collapsed;
  for (const key of s.collapsed) {
    const to = remap(key);
    if (to === null) continue;
    carry(key, to);
    collapsed = withKey(collapsed, to);
  }
  if (expanded !== s.expanded || collapsed !== s.collapsed || anchors !== s.unitAnchors) s = { ...s, expanded, collapsed, unitAnchors: anchors };

  if (action.terminal && !s.terminal) s = { ...leaveLive(s, index), terminal: true };
  if (s.follow && action.loadedThroughSeq > s.lastSeenSeq) s = { ...s, lastSeenSeq: action.loadedThroughSeq };

  if (action.loadComplete && !s.loaded) {
    s = { ...s, loaded: true };
    const small = action.chapterSpineRows <= SPINE_ROWS_BRUSH_LIMIT;
    if (!s.follow) {
      if (s.selection === null) {
        const initial = action.initialSelection ?? index.tailStepId;
        if (initial !== null && index.entry(initial) !== undefined) {
          s = {
            ...s, selection: initial, playhead: { kind: "selection" }, playheadOrigin: "program",
            focusRev: s.focusRev + 1, focusBy: "shell", unitAnchors: rememberAnchors(s.unitAnchors, [initial], index),
          };
        }
      }
      if (!small && s.brush.kind === "session") {
        const brush = chapterBrushFor(s.selection, index);
        if (brush !== null) s = { ...s, brush, focusRev: s.focusRev + 1 };
      }
    } else {
      s = { ...s, playhead: { kind: "live" }, playheadOrigin: "live" };
      if (!small && s.brush.kind === "session") {
        const latest = index.chapterAtSeq(index.loadedThroughSeq);
        const brush = latest === undefined ? null : chapterBrushFor(latest.id, index);
        if (brush !== null) s = { ...s, brush, focusRev: s.focusRev + 1 };
      }
    }
  }
  return ensureInvariants(s, index);
}

function nav(state: ViewState, target: "chapter" | "turn" | "finding", dir: 1 | -1, index: TraceIndex): ViewState {
  const session = index.session;
  if (session === null || session.steps.length === 0) return state;
  const p = effectivePlayheadSeq(state.playhead, state.selection, index);
  if (target === "finding") {
    const list = index.findingsBySeq;
    if (list.length === 0) return state;
    let i = dir > 0 ? list.findIndex((f) => f.anchorSeq > p) : lastIndexWhere(list, (f) => f.anchorSeq < p);
    if (i < 0) i = dir > 0 ? 0 : list.length - 1;
    const finding = list[i];
    return finding === undefined ? state : selectId(state, finding.anchorStepId, "shell", "finding", index);
  }
  if (target === "turn") {
    const turns = session.turns;
    if (turns.length === 0) return state;
    const current = index.turnAtSeq(p)?.index ?? 0;
    const next = turns[Math.max(0, Math.min(turns.length - 1, current + dir))];
    if (next === undefined) return state;
    const step = session.steps[index.stepIndexAtOrAfter(next.startSeq)];
    return step === undefined ? state : selectId(state, step.id, "shell", "keys", index);
  }
  const chapters = session.chapters
    .filter((c) => c.current)
    .map((c) => ({ id: c.id, anchor: anchorOf(c.id, index) ?? c.firstSeq }))
    .sort((a, b) => a.anchor - b.anchor);
  if (chapters.length === 0) return state;
  const selected = state.selection === null ? null : state.selection.startsWith("unit:") ? state.selection : index.entry(state.selection)?.parent ?? null;
  const at = selected === null ? -1 : chapters.findIndex((c) => c.id === selected);
  let next: number;
  if (at >= 0) next = Math.max(0, Math.min(chapters.length - 1, at + dir));
  else {
    next = dir > 0 ? chapters.findIndex((c) => c.anchor > p) : lastIndexWhere(chapters, (c) => c.anchor < p);
    if (next < 0) next = dir > 0 ? chapters.length - 1 : 0;
  }
  const chosen = chapters[next];
  return chosen === undefined ? state : selectId(state, chosen.id, "shell", "keys", index);
}

// ------------------------------------------------------------ reduce

/** Pure. Returns the same object when nothing changes. */
export function reduce(state: ViewState, action: ViewAction, index: TraceIndex): ViewState {
  switch (action.type) {
    case "session/applied":
      return applySession(state, action, index);
    case "select":
      return selectId(state, action.id, action.by, action.origin ?? originFor(action.by), index);
    case "nav":
      return nav(state, action.target, action.dir, index);
    case "nav/first": {
      const first = index.session?.steps[0];
      return first === undefined ? state : selectId(leaveLive(state, index), first.id, "shell", "keys", index);
    }
    case "nav/last": {
      const tail = index.tailStepId;
      if (tail === null) return state;
      const canFollow = !state.terminal && index.session?.live === true;
      const base = canFollow ? { ...state, follow: true } : state;
      const next = selectId(base, tail, "shell", "keys", index);
      if (!canFollow) return next;
      return ensureInvariants({ ...next, follow: true, playhead: { kind: "live" }, playheadOrigin: "live", lastSeenSeq: Math.max(next.lastSeenSeq, index.loadedThroughSeq) }, index);
    }
    case "view/switch":
      return action.view === state.view ? state : { ...state, view: action.view };
    case "level/set": {
      if (action.level === state.level) return state;
      const base = action.by === "shell" ? state : leaveLive(state, index);
      return { ...base, level: action.level, focusRev: base.focusRev + 1, focusBy: action.by };
    }
    case "follow/set": {
      if (action.follow === state.follow) return state;
      if (!action.follow) return leaveLive(state, index);
      if (state.terminal) return state;
      return ensureInvariants({
        ...state, follow: true, playhead: { kind: "live" }, playheadOrigin: "live",
        lastSeenSeq: Math.max(state.lastSeenSeq, index.loadedThroughSeq),
      }, index);
    }
    case "playhead/set": {
      const base = action.origin === "live" ? state : leaveLive(state, index);
      const playhead: Playhead = action.playhead.kind === "free"
        ? { kind: "free", seq: Math.max(1, Math.min(Math.max(1, index.loadedThroughSeq), action.playhead.seq)) }
        : action.playhead;
      const effective = action.origin !== "live" && playhead.kind === "live" && !base.follow ? { kind: "free" as const, seq: index.loadedThroughSeq } : playhead;
      return ensureInvariants({ ...base, playhead: effective, playheadOrigin: action.origin }, index);
    }
    case "playhead/step": {
      const steps = index.session?.steps ?? [];
      if (steps.length === 0) return state;
      const base = leaveLive(state, index);
      const p = effectivePlayheadSeq(base.playhead, base.selection, index);
      const i = index.stepIndexAtOrBefore(p);
      const target = steps[Math.max(0, Math.min(steps.length - 1, i + action.dir))];
      if (target === undefined) return state;
      return ensureInvariants({ ...base, playhead: { kind: "free", seq: target.firstSeq }, playheadOrigin: "keys" }, index);
    }
    case "brush/set":
      return writeBrush(state, action.brush, action.by, index);
    case "brush/edge": {
      const p = effectivePlayheadSeq(state.playhead, state.selection, index);
      const r = brushSeqRange(state.brush, index);
      const liveTo = state.brush.kind === "range" && state.brush.toSeq === "live";
      const brush: Brush = action.edge === "from"
        ? { kind: "range", fromSeq: p, toSeq: liveTo ? "live" : Math.max(p, r.toSeq) }
        : { kind: "range", fromSeq: Math.min(r.fromSeq, p), toSeq: p };
      return writeBrush(state, brush, "hybrid", index);
    }
    case "brush/chapter": {
      const p = effectivePlayheadSeq(state.playhead, state.selection, index);
      const chapter = index.chapterAtSeq(p);
      const byChapter = chapter === undefined ? null : chapterBrushFor(chapter.id, index);
      if (byChapter !== null) return writeBrush(state, byChapter, "hybrid", index);
      const turn = index.turnAtSeq(p);
      if (turn === undefined) return state;
      return writeBrush(state, { kind: "range", fromSeq: turn.startSeq, toSeq: Math.max(turn.startSeq, turn.endSeq) }, "hybrid", index);
    }
    case "expand/toggle":
      return setExpanded(state, action.key, !isKeyExpanded(action.key, index, state.expanded, state.collapsed), index);
    case "expand/set":
      return setExpanded(state, action.key, action.expanded, index);
    case "inspector/tab":
      return action.tab === state.inspectorTab ? state : { ...state, inspectorTab: action.tab };
    case "tool/set":
      return action.tool === state.tool ? state : { ...state, tool: action.tool };
    case "gesture": {
      if (action.gesture === state.gesture) return state;
      const base = action.gesture === null ? state : leaveLive(state, index);
      return { ...base, gesture: action.gesture };
    }
    case "camera/sync":
      if (action.view === "canvas") return { ...state, cameras: { ...state.cameras, canvas: { ...action.camera, syncedRev: state.focusRev } } };
      return { ...state, cameras: { ...state.cameras, hybrid: { ...action.camera, syncedRev: state.focusRev } } };
    case "search/set": {
      const query = action.query.trim();
      if (query.length === 0) return state.search === null ? state : { ...state, search: null };
      return { ...state, search: { query: action.query, matchIds: action.matchIds, cursor: -1 } };
    }
    case "search/next": {
      const search = state.search;
      if (search === null || search.matchIds.length === 0) return state;
      const n = search.matchIds.length;
      const cursor = (((search.cursor + action.dir) % n) + n) % n;
      const id = search.matchIds[cursor];
      if (id === undefined) return state;
      const selected = selectId(state, id, "shell", "search", index);
      return { ...selected, search: { ...search, cursor } };
    }
    case "esc": {
      if (state.search !== null) return { ...state, search: null };
      if (state.tool === "hand") return { ...state, tool: "select" };
      const selection = state.selection;
      if (selection === null) return state;
      if (isKeyExpanded(selection, index, state.expanded, state.collapsed)) return setExpanded(state, selection, false, index);
      const parent = selection.startsWith("step:") ? index.entry(selection)?.parent ?? null : null;
      if (parent !== null) return selectId(state, parent, "shell", "keys", index);
      return selectId(state, null, "shell", "keys", index);
    }
    case "seen":
      return action.seq > state.lastSeenSeq ? { ...state, lastSeenSeq: action.seq } : state;
  }
}

// ------------------------------------------------------------ selectors

export function selectNewCount(state: ViewState, index: TraceIndex): number {
  const steps = index.session?.steps.length ?? 0;
  return steps - index.stepIndexAtOrAfter(state.lastSeenSeq + 1);
}

export function selectEffectivePlayheadSeq(state: ViewState, index: TraceIndex): number {
  const r = brushSeqRange(state.brush, index);
  const p = effectivePlayheadSeq(state.playhead, state.selection, index);
  return Math.min(r.toSeq, Math.max(r.fromSeq, p));
}

export function selectStepIsTail(id: SelectionId, index: TraceIndex): boolean {
  return isTail(id, index);
}

export function locationOf(state: ViewState, sessionId: string): ViewerLocation {
  const location: ViewerLocation = { v: 1, sessionId, view: state.view, level: state.level, brush: state.brush, playhead: state.playhead };
  if (state.selection !== null) location.selected = state.selection;
  return location;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/state/location.test.ts src/ui/state/view-state.test.ts src/ui/state/view-state.property.test.ts`
Expected: PASS, 3 files, 20 tests. A property counterexample prints the action list; fix `reduce`, never the invariant.

- [ ] **Step 5: Root checks**

```bash
pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint
```

Expected: each exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/trace-viewer/src/ui/state/location.ts packages/trace-viewer/src/ui/state/location.test.ts packages/trace-viewer/src/ui/state/view-state.ts packages/trace-viewer/src/ui/state/view-state.test.ts packages/trace-viewer/src/ui/state/view-state.property.test.ts
git commit -m "feat(trace-viewer): view-state reducer with brush, playhead and live invariants"
```

### Task C1-12: Selector store and pure keymap

**Files:**
- Create: `packages/trace-viewer/src/ui/state/store.ts`
- Test: `packages/trace-viewer/src/ui/state/store.test.tsx`
- Create: `packages/trace-viewer/src/ui/state/keymap.ts`
- Test: `packages/trace-viewer/src/ui/state/keymap.test.ts`
- Modify: `packages/trace-viewer/src/index.ts`

(`location.ts` moved to C1-11, deviation 2; its barrel line lands here as the index says.)

**Interfaces:**
- Consumes: C1-11 `reduce`, `initialViewState`, `type ViewState`, `type ViewAction`, `type ViewKind`, `type Tool`; C1-10 `type TraceIndex`, `buildTraceIndex`, `emptyTraceIndex`; W0 `type Level`; React 19.2 `createContext`, `useContext`, `useRef`, `useSyncExternalStore`.
- Produces (UI index §2.3 verbatim):

```ts
// ui/state/store.ts
export interface ViewStore {
  get(): ViewState;
  subscribe(listener: () => void): () => void;
  dispatch(action: ViewAction): void;
  setIndex(index: TraceIndex): void;
  getIndex(): TraceIndex;
}
export function createViewStore(initial: ViewState, index: TraceIndex): ViewStore;
export const ViewStoreContext: React.Context<ViewStore | null>;
export function useViewStore(): ViewStore;
export function useView<T>(select: (state: ViewState) => T, equal?: (a: T, b: T) => boolean): T;
export function useDispatch(): (action: ViewAction) => void;
// ui/state/keymap.ts
export interface KeyInput { code: string; key: string; shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean; isComposing: boolean; editableTarget: boolean }
export interface KeyContext { view: ViewKind; spaceOverPannable: boolean; hasTextSelection: boolean }
export type KeyCommand = /* UI index §2.3 union */;
export const ZOOM_STEP = 1.25;
export function resolveKey(input: KeyInput, context: KeyContext, phase: "down" | "up"): KeyCommand | null;
```

- [ ] **Step 1: Write the failing tests**

`packages/trace-viewer/src/ui/state/store.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildTraceIndex, emptyTraceIndex } from "../../layout/trace-index.js";
import { oauthLikeSession } from "../../test-support/session-builder.js";
import { createViewStore, useDispatch, useView, ViewStoreContext, type ViewStore } from "./store.js";
import { initialViewState } from "./view-state.js";

afterEach(() => cleanup());

function mount(store: ViewStore, counter: { renders: number }) {
  function LevelLabel() {
    counter.renders += 1;
    const level = useView((s) => s.level);
    return <span data-testid="level">{level}</span>;
  }
  return render(
    <ViewStoreContext.Provider value={store}>
      <LevelLabel />
    </ViewStoreContext.Provider>,
  );
}

describe("view store", () => {
  it("useView re-renders only when its selected slice changes", () => {
    const store = createViewStore(initialViewState({ live: false }), emptyTraceIndex("s"));
    const counter = { renders: 0 };
    const view = mount(store, counter);
    expect(counter.renders).toBe(1);
    act(() => store.dispatch({ type: "tool/set", tool: "hand" }));
    act(() => store.dispatch({ type: "inspector/tab", tab: "evidence" }));
    expect(counter.renders).toBe(1);
    act(() => store.dispatch({ type: "level/set", level: "step", by: "shell" }));
    expect(counter.renders).toBe(2);
    expect(view.getByTestId("level").textContent).toBe("step");
  });

  it("does not notify when reduce returns the same state", () => {
    const store = createViewStore(initialViewState({ live: false }), emptyTraceIndex("s"));
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.dispatch({ type: "tool/set", tool: "select" });
    expect(listener).not.toHaveBeenCalled();
    store.dispatch({ type: "tool/set", tool: "hand" });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.dispatch({ type: "tool/set", tool: "select" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("reduces against the index set last", () => {
    const session = oauthLikeSession();
    const store = createViewStore(initialViewState({ live: false }), emptyTraceIndex(session.meta.sessionId));
    const target = session.steps[3]?.id ?? "step:1";
    store.dispatch({ type: "select", id: target, by: "shell" });
    expect(store.get().selection).toBeNull();
    store.setIndex(buildTraceIndex(session));
    store.dispatch({ type: "select", id: target, by: "shell" });
    expect(store.get().selection).toBe(target);
    expect(store.getIndex().session).toBe(session);
  });

  it("a custom equality keeps a derived value stable", () => {
    const store = createViewStore(initialViewState({ live: false }), emptyTraceIndex("s"));
    const counter = { renders: 0 };
    function Expanded() {
      counter.renders += 1;
      const size = useView((s) => s.expanded, (a, b) => a.size === b.size);
      const dispatch = useDispatch();
      return <button type="button" onClick={() => dispatch({ type: "tool/set", tool: "hand" })}>{size.size}</button>;
    }
    render(<ViewStoreContext.Provider value={store}><Expanded /></ViewStoreContext.Provider>);
    act(() => store.dispatch({ type: "expand/set", key: "unit:a", expanded: true }));
    expect(counter.renders).toBe(2);
    act(() => store.dispatch({ type: "tool/set", tool: "hand" }));
    expect(counter.renders).toBe(2);
  });
});
```

`packages/trace-viewer/src/ui/state/keymap.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { resolveKey, type KeyContext, type KeyInput } from "./keymap.js";

const key = (code: string, extra: Partial<KeyInput> = {}): KeyInput => ({
  code, key: extra.key ?? code, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false,
  isComposing: false, editableTarget: false, ...extra,
});
const hybrid: KeyContext = { view: "hybrid", spaceOverPannable: true, hasTextSelection: false };
const canvas: KeyContext = { view: "canvas", spaceOverPannable: true, hasTextSelection: false };

describe("resolveKey (spec §7.9, R21)", () => {
  it("matches event.code, so a Hangul input source still moves", () => {
    expect(resolveKey(key("KeyJ", { key: "ㅓ" }), hybrid, "down")).toEqual({ cmd: "item", dir: 1 });
    expect(resolveKey(key("KeyK", { key: "ㅏ" }), hybrid, "down")).toEqual({ cmd: "item", dir: -1 });
  });

  it("ignores IME composition, editable targets and unlisted modifiers", () => {
    expect(resolveKey(key("KeyJ", { isComposing: true }), hybrid, "down")).toBeNull();
    expect(resolveKey(key("KeyJ", { editableTarget: true }), hybrid, "down")).toBeNull();
    expect(resolveKey(key("KeyJ", { ctrlKey: true }), hybrid, "down")).toBeNull();
    expect(resolveKey(key("KeyJ", { metaKey: true }), hybrid, "down")).toBeNull();
    expect(resolveKey(key("KeyJ", { altKey: true }), hybrid, "down")).toBeNull();
  });

  it("maps shifted letters and digits", () => {
    expect(resolveKey(key("KeyJ", { shiftKey: true }), hybrid, "down")).toEqual({ cmd: "chapter", dir: 1 });
    expect(resolveKey(key("KeyN", { shiftKey: true }), hybrid, "down")).toEqual({ cmd: "finding", dir: -1 });
    expect(resolveKey(key("KeyG", { shiftKey: true }), hybrid, "down")).toEqual({ cmd: "last" });
    expect(resolveKey(key("Digit1"), hybrid, "down")).toEqual({ cmd: "view", view: "canvas" });
    expect(resolveKey(key("Digit2"), canvas, "down")).toEqual({ cmd: "view", view: "hybrid" });
    expect(resolveKey(key("Digit1", { shiftKey: true }), hybrid, "down")).toEqual({ cmd: "fit", target: "all" });
    expect(resolveKey(key("Digit2", { shiftKey: true }), hybrid, "down")).toEqual({ cmd: "fit", target: "selection" });
    expect(resolveKey(key("Digit2", { altKey: true }), hybrid, "down")).toEqual({ cmd: "level", level: "chapter" });
    expect(resolveKey(key("Digit3", { altKey: true }), hybrid, "down")).toEqual({ cmd: "level", level: "step" });
  });

  it("brackets move turns; braces and b edit the brush only in Hybrid", () => {
    expect(resolveKey(key("BracketLeft"), canvas, "down")).toEqual({ cmd: "turn", dir: -1 });
    expect(resolveKey(key("BracketRight"), canvas, "down")).toEqual({ cmd: "turn", dir: 1 });
    expect(resolveKey(key("BracketLeft", { shiftKey: true }), hybrid, "down")).toEqual({ cmd: "brushEdge", edge: "from" });
    expect(resolveKey(key("BracketRight", { shiftKey: true }), hybrid, "down")).toEqual({ cmd: "brushEdge", edge: "to" });
    expect(resolveKey(key("KeyB"), hybrid, "down")).toEqual({ cmd: "brushChapter" });
    expect(resolveKey(key("BracketLeft", { shiftKey: true }), canvas, "down")).toBeNull();
    expect(resolveKey(key("KeyB"), canvas, "down")).toBeNull();
  });

  it("Space pans only over a pannable surface, on down and up", () => {
    expect(resolveKey(key("Space"), hybrid, "down")).toEqual({ cmd: "space", down: true });
    expect(resolveKey(key("Space"), hybrid, "up")).toEqual({ cmd: "space", down: false });
    expect(resolveKey(key("Space"), { ...hybrid, spaceOverPannable: false }, "down")).toBeNull();
    expect(resolveKey(key("KeyJ"), hybrid, "up")).toBeNull();
  });

  it("Cmd or Ctrl+C copies the review note only without a text selection", () => {
    expect(resolveKey(key("KeyC", { metaKey: true }), hybrid, "down")).toEqual({ cmd: "copyNote" });
    expect(resolveKey(key("KeyC", { ctrlKey: true }), hybrid, "down")).toEqual({ cmd: "copyNote" });
    expect(resolveKey(key("KeyC", { metaKey: true }), { ...hybrid, hasTextSelection: true }, "down")).toBeNull();
    expect(resolveKey(key("KeyC"), hybrid, "down")).toBeNull();
  });

  it("covers the rest of the table", () => {
    const cases: [KeyInput, unknown][] = [
      [key("KeyN"), { cmd: "finding", dir: 1 }],
      [key("Enter"), { cmd: "toggle" }],
      [key("NumpadEnter"), { cmd: "toggle" }],
      [key("Escape"), { cmd: "esc" }],
      [key("Comma"), { cmd: "playhead", dir: -1 }],
      [key("Period"), { cmd: "playhead", dir: 1 }],
      [key("KeyG"), { cmd: "first" }],
      [key("Minus"), { cmd: "zoom", op: "out" }],
      [key("Equal"), { cmd: "zoom", op: "in" }],
      [key("Equal", { shiftKey: true }), { cmd: "zoom", op: "in" }],
      [key("Digit0"), { cmd: "zoom", op: "preset" }],
      [key("KeyV"), { cmd: "tool", tool: "select" }],
      [key("KeyH"), { cmd: "tool", tool: "hand" }],
      [key("Slash"), { cmd: "search" }],
      [key("Slash", { shiftKey: true }), { cmd: "help" }],
      [key("F6"), { cmd: "region", dir: 1 }],
      [key("F6", { shiftKey: true }), { cmd: "region", dir: -1 }],
      [key("KeyQ"), null],
    ];
    for (const [input, expected] of cases) expect(resolveKey(input, hybrid, "down"), input.code).toEqual(expected);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/state/store.test.tsx src/ui/state/keymap.test.ts`
Expected: FAIL, `Failed to resolve import "./store.js"`.

- [ ] **Step 3: Write the implementation**

`packages/trace-viewer/src/ui/state/store.ts`:

```ts
import { createContext, useContext, useRef, useSyncExternalStore, type Context } from "react";

import type { TraceIndex } from "../../layout/trace-index.js";
import { reduce, type ViewAction, type ViewState } from "./view-state.js";

export interface ViewStore {
  get(): ViewState;
  /** Stable identity for useSyncExternalStore. */
  subscribe(listener: () => void): () => void;
  dispatch(action: ViewAction): void;
  setIndex(index: TraceIndex): void;
  getIndex(): TraceIndex;
}

export function createViewStore(initial: ViewState, index: TraceIndex): ViewStore {
  let state = initial;
  let current = index;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const dispatch = (action: ViewAction): void => {
    const next = reduce(state, action, current);
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    get: () => state,
    subscribe,
    dispatch,
    setIndex: (next) => {
      current = next;
    },
    getIndex: () => current,
  };
}

export const ViewStoreContext: Context<ViewStore | null> = createContext<ViewStore | null>(null);

export function useViewStore(): ViewStore {
  const store = useContext(ViewStoreContext);
  if (store === null) throw new Error("useViewStore must be used inside a ViewStoreContext provider");
  return store;
}

/** Selector read; `equal` defaults to Object.is. Selectors return primitives or references held in state. */
export function useView<T>(select: (state: ViewState) => T, equal: (a: T, b: T) => boolean = Object.is): T {
  const store = useViewStore();
  const cache = useRef<{ state: ViewState; select: (state: ViewState) => T; value: T } | null>(null);
  const getSnapshot = (): T => {
    const state = store.get();
    const previous = cache.current;
    if (previous !== null && previous.state === state && previous.select === select) return previous.value;
    const value = select(state);
    if (previous !== null && equal(previous.value, value)) {
      cache.current = { state, select, value: previous.value };
      return previous.value;
    }
    cache.current = { state, select, value };
    return value;
  };
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

export function useDispatch(): (action: ViewAction) => void {
  return useViewStore().dispatch;
}
```

`packages/trace-viewer/src/ui/state/keymap.ts`:

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
    case "Digit1": return shift ? { cmd: "fit", target: "all" } : { cmd: "view", view: "canvas" };
    case "Digit2": return shift ? { cmd: "fit", target: "selection" } : { cmd: "view", view: "hybrid" };
    case "Comma": return shift ? null : { cmd: "playhead", dir: -1 };
    case "Period": return shift ? null : { cmd: "playhead", dir: 1 };
    case "KeyG": return shift ? { cmd: "last" } : { cmd: "first" };
    case "Minus": return shift ? null : { cmd: "zoom", op: "out" };
    case "Equal": return { cmd: "zoom", op: "in" };
    case "Digit0": return shift ? null : { cmd: "zoom", op: "preset" };
    case "KeyV": return shift ? null : { cmd: "tool", tool: "select" };
    case "KeyH": return shift ? null : { cmd: "tool", tool: "hand" };
    case "Space": return !shift && context.spaceOverPannable ? { cmd: "space", down: true } : null;
    case "KeyB": return !shift && hybrid ? { cmd: "brushChapter" } : null;
    case "Slash": return shift ? { cmd: "help" } : { cmd: "search" };
    case "F6": return { cmd: "region", dir: shift ? -1 : 1 };
    default: return null;
  }
}
```

Modify `packages/trace-viewer/src/index.ts`. Current content:

```ts
export * from "./source.js";
export * from "./layout/viewport.js";
export { createViewportController, SETTLE_MS, type ViewportController, type ViewportControllerOptions, type FramePhase } from "./ui/viewport/controller.js";
```

Append:

```ts
export { ViewerLocationSchema, decodeLocation, locationFromHash, locationToHash, type ViewerLocation } from "./ui/state/location.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/state/store.test.tsx src/ui/state/keymap.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Root checks**

```bash
pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint
```

Expected: each exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/trace-viewer/src/ui/state/store.ts packages/trace-viewer/src/ui/state/store.test.tsx packages/trace-viewer/src/ui/state/keymap.ts packages/trace-viewer/src/ui/state/keymap.test.ts packages/trace-viewer/src/index.ts
git commit -m "feat(trace-viewer): selector view store, keymap and location export"
```

### Task C1-13: Overview index and layout (density, pins, bands, presets)

**Files:**
- Create: `packages/trace-viewer/src/layout/overview-index.ts`
- Create: `packages/trace-viewer/src/layout/overview-layout.ts`
- Test: `packages/trace-viewer/src/layout/overview-layout.test.ts`
- Test: `packages/trace-viewer/src/layout/overview-layout.property.test.ts`
- Create: `packages/trace-viewer/src/layout/overview-layout.bench.ts`

**Interfaces:**
- Consumes: C1-9 `type TimeScale`, `buildTimeScale`, `timeScaleInputOf`; C1-10 `type TraceIndex`, `type Brush`, `buildTraceIndex`, `stepTone`, `worstSeverity`, `type Tone`; C1-5 `fitRange`, `type XOnlyCamera`; W0 `LANES`, `type Lane`, `type Level`, `type StepKind`, `type TraceSession`, `type TurnTrigger`, `type FindingId`, `type UnitStableId`, `type Step`, `type Finding`, `type Severity`, `type SignalId`; C1-8 builders (tests).
- Produces (UI index §2.1 verbatim, plus deviation 9's `noise` and `maxSpan`):

```ts
// layout/overview-index.ts
export type Glyph = "dot" | "ring" | "bar" | "hist" | "wait";
export type PinRule = "always" | "finding" | "never";
export const PLACEMENT: { readonly [K in StepKind]: { glyph: Glyph; pin: PinRule; echo?: Lane } };
export const GLYPH_CODE: { readonly [G in Glyph]: number };
export const TONE_CODE: { readonly [T in Tone]: number };
export type PinKind = "critical_finding" | "failed" | "decision" | "approval" | "instruction" | "guardrail" | "finding" | "other";
export const PIN_PRIORITY: { readonly [K in PinKind]: number };
export interface LaneMarks {
  readonly count: number; readonly u0: Float64Array; readonly u1: Float64Array; readonly step: Int32Array;
  readonly glyph: Uint8Array; readonly tone: Uint8Array; readonly added: Float64Array; readonly removed: Float64Array;
  readonly problem: Uint8Array; readonly noise: Uint8Array; readonly maxSpan: number;
}
export interface PinCandidate { stepIndex: number; lane: Lane; u: number; kind: PinKind; critical: boolean; findingId: FindingId | null }
export interface BandSpan { key: `ch:${number}` | `turn:${number}`; id: UnitStableId | null; u0: number; u1: number; title: string }
export interface OverviewIndex {
  readonly endU: number;
  readonly lanes: { readonly [L in Lane]: LaneMarks };
  readonly pins: readonly PinCandidate[];
  readonly bands: readonly BandSpan[];
  readonly turns: readonly { index: number; u: number; trigger: TurnTrigger }[];
  readonly links: readonly { findingId: FindingId; fromStep: number; toStep: number }[];
}
export function buildOverviewIndex(session: TraceSession, index: TraceIndex, scale: TimeScale): OverviewIndex;
// layout/overview-layout.ts — constants OVERVIEW_H 288, LABELS_H 36, RULER_TOP 36, LANES_TOP 58, LANE_H 28, STRIP_H 6,
// GUTTER_W 112, GUTTER_W_NARROW 40, NARROW_CONTAINER_PX 1180, BIN_PX 6, PIN_PX 22, PIN_MIN_GAP_PX 26, DOT_MIN_GAP_PX 8,
// BAR_MIN_W_PX 3, HIST_CAP_PX 12, BAND_MERGE_GAP_PX 24, K_MAX 0.4, MAX_OVERLAY_NODES 150
export type MarkOp = /* UI index §2.1 union */;
export interface PinPlacement { key: string; lane: Lane; x: number; kind: PinKind; critical: boolean; stepIndexes: readonly number[]; cluster: boolean; findingId: FindingId | null }
export interface BandPlacement { key: string; id: UnitStableId | null; x0: number; x1: number; title: string; tier: 0 | 1 | null; iconOnly: boolean }
export interface OverviewLayout { marks: readonly MarkOp[]; pins: readonly PinPlacement[]; bands: readonly BandPlacement[]; turnLines: readonly { x: number; label: string }[]; links: readonly { findingId: FindingId; fromPin: string; toPin: string }[]; strip: Float64Array }
export interface OverviewLayoutInput { overview: OverviewIndex; camera: XOnlyCamera; widthPx: number; level: Level }
export function layoutOverview(input: OverviewLayoutInput): OverviewLayout;
export interface OverviewPresetInput { level: Level; overview: OverviewIndex; index: TraceIndex; scale: TimeScale; widthPx: number; playheadSeq: number; live: boolean }
export function overviewPreset(input: OverviewPresetInput): { camera: XOnlyCamera; brush: Brush };
```

Layout rules (spec §7.6.1): every decision that could flicker under a pan is taken in `u · k` (bins `floor(u · k / 6)` anchored at u = 0, dot spacing, bar merging, pin clustering, band merging, label tiers), so a pan changes only x offsets. Session level omits noise and aggregates dots, rings and bars into heat; Chapter level draws one hollow bar per consecutive noise run on a lane; Step level draws noise steps individually. A problem mark always emits a 2 × 10 px `problem` op at its exact x. Pins cluster per lane when centers are < 26 px apart; if pins, labeled bands, turn lines and links exceed 150 overlay nodes, the cluster gap doubles until they fit.

- [ ] **Step 1: Write the failing tests**

`packages/trace-viewer/src/layout/overview-layout.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { TraceSession } from "../model/index.js";
import { buildSession, largeSession, OAUTH_CLAIM_TEXT, oauthLikeSession } from "../test-support/session-builder.js";
import { buildOverviewIndex } from "./overview-index.js";
import { K_MAX, layoutOverview, MAX_OVERLAY_NODES, overviewPreset } from "./overview-layout.js";
import { buildTimeScale, timeScaleInputOf } from "./time-scale.js";
import { buildTraceIndex } from "./trace-index.js";
import { fitRange } from "./viewport.js";

const WIDTH = 1_000;
const LIMITS = { minK: 1e-9, maxK: K_MAX };

function prepare(session: TraceSession) {
  const index = buildTraceIndex(session);
  const scale = buildTimeScale(timeScaleInputOf(session));
  const overview = buildOverviewIndex(session, index, scale);
  const fit = fitRange(0, overview.endU, WIDTH, { padFraction: 0.02, limits: LIMITS });
  return { index, scale, overview, fit };
}

const oauth = oauthLikeSession();
const o = prepare(oauth);
const claim = oauth.steps.find((s) => s.text === OAUTH_CLAIM_TEXT);
const test = oauth.steps.find((s) => s.kind === "test");

describe("overview layout on the oauth-like session", () => {
  it("Chapter level pins the instruction, the decision fork, the claim quote, the failed test and one link", () => {
    const layout = layoutOverview({ overview: o.overview, camera: o.fit, widthPx: WIDTH, level: "chapter" });
    const pinned = layout.pins.flatMap((p) => p.stepIndexes.map((i) => oauth.steps[i]?.id));
    const expected = [
      oauth.steps.find((s) => s.kind === "instruction")?.id,
      oauth.steps.find((s) => s.kind === "decision")?.id,
      test?.id,
      claim?.id,
    ];
    expect([...pinned].sort()).toEqual([...expected].sort());
    const claimPin = layout.pins.find((p) => p.stepIndexes.some((i) => oauth.steps[i]?.id === claim?.id));
    const testPin = layout.pins.find((p) => p.stepIndexes.some((i) => oauth.steps[i]?.id === test?.id));
    expect(claimPin).toMatchObject({ lane: "agent", kind: "critical_finding", critical: true, cluster: false });
    expect(testPin?.lane).toBe("tests");
    expect(layout.links).toHaveLength(1);
    expect(layout.links[0]).toMatchObject({ fromPin: claimPin?.key, toPin: testPin?.key });
  });

  it("Session level omits noise; Chapter level draws one bar per noise run; problem ticks always survive", () => {
    const session = layoutOverview({ overview: o.overview, camera: o.fit, widthPx: WIDTH, level: "session" });
    expect(session.marks.filter((m) => m.op === "noise")).toHaveLength(0);
    const problems = session.marks.filter((m) => m.op === "problem").map((m) => m.lane).sort();
    expect(problems).toEqual(["agent", "tests"]);
    const chapter = layoutOverview({ overview: o.overview, camera: o.fit, widthPx: WIDTH, level: "chapter" });
    expect(chapter.marks.filter((m) => m.op === "noise" && m.lane === "edits")).toHaveLength(2);
    expect(chapter.marks.filter((m) => m.op === "noise" && m.lane === "agent")).toHaveLength(2);
    const step = layoutOverview({ overview: o.overview, camera: o.fit, widthPx: WIDTH, level: "step" });
    expect(step.marks.filter((m) => m.op === "noise")).toHaveLength(0);
    expect(step.marks.filter((m) => m.op === "ring" && m.lane === "edits")).toHaveLength(3);
  });

  it("echoes the test run as a plain bar on the Commands lane without a pin", () => {
    const layout = layoutOverview({ overview: o.overview, camera: o.fit, widthPx: WIDTH, level: "chapter" });
    expect(layout.marks.some((m) => m.op === "bar" && m.lane === "commands")).toBe(true);
    expect(layout.pins.some((p) => p.lane === "commands")).toBe(false);
  });

  it("presets: Session fits everything; Chapter fits the playhead chapter with 20 s minimum; Step caps k", () => {
    const base = { overview: o.overview, index: o.index, scale: o.scale, widthPx: WIDTH, playheadSeq: test?.firstSeq ?? 1, live: false };
    const s = overviewPreset({ ...base, level: "session" });
    expect(s.brush).toEqual({ kind: "session" });
    expect(s.camera.k).toBeCloseTo(o.fit.k, 12);
    const c = overviewPreset({ ...base, level: "chapter" });
    expect(c.brush).toEqual({ kind: "chapter", anchorSeq: Number(o.index.chapterKey("unit:u-linking-test")?.slice(3)) });
    expect(c.camera.k).toBeCloseTo(WIDTH / (20_000 * 1.16), 9);
    const st = overviewPreset({ ...base, level: "step" });
    expect(st.camera.k).toBeLessThanOrEqual(K_MAX);
    expect((o.scale.toU(test?.tMs ?? 0) - st.camera.u0) * st.camera.k).toBeCloseTo(WIDTH / 2, 6);
    expect(st.brush.kind).toBe("range");
    const live = overviewPreset({ ...base, level: "session", live: true });
    expect(live.camera.k).toBeLessThan(s.camera.k);
  });
});

describe("overview layout edge cases", () => {
  it("turns stand in for chapters", () => {
    const session = buildSession({
      turns: [{ trigger: "initial", prompt: "a" }, { trigger: "steer", prompt: "b" }],
      steps: [
        { kind: "instruction", tMs: 0 },
        { kind: "command", tMs: 1_000, target: "pnpm test", status: "unknown", command: { exitCode: -1 } },
        { kind: "instruction", tMs: 5_000, turn: 1 },
        { kind: "command", tMs: 6_000, turn: 1, target: "pnpm lint", rows: 2 },
      ],
      approximateJoins: true,
    });
    const p = prepare(session);
    expect(p.overview.bands.map((b) => b.key)).toEqual(["turn:0", "turn:1"]);
    const layout = layoutOverview({ overview: p.overview, camera: p.fit, widthPx: WIDTH, level: "chapter" });
    expect(layout.bands.map((b) => b.key)).toEqual(["turn:0", "turn:1"]);
    expect(layout.turnLines).toEqual([{ x: expect.any(Number), label: "T2 · steer" }]);
    const preset = overviewPreset({ level: "chapter", overview: p.overview, index: p.index, scale: p.scale, widthPx: WIDTH, playheadSeq: 4, live: false });
    expect(preset.brush).toEqual({ kind: "range", fromSeq: 3, toSeq: 5 });
    expect(layout.marks.some((m) => m.op === "problem")).toBe(false);
    expect(layout.pins.map((pin) => oauthKind(session, pin.stepIndexes[0]))).toEqual(["instruction", "instruction"]);
  });

  it("dense dots become heat bars whose height carries the count", () => {
    const session = buildSession({ steps: Array.from({ length: 20 }, (_, i) => ({ kind: "message" as const, tMs: i * 100, text: `m${i}` })) });
    const p = prepare(session);
    const camera = fitRange(0, 200_000, WIDTH, { padFraction: 0.02, limits: LIMITS });
    const layout = layoutOverview({ overview: p.overview, camera, widthPx: WIDTH, level: "chapter" });
    const heat = layout.marks.filter((m): m is Extract<typeof m, { op: "heat" }> => m.op === "heat");
    expect(heat.reduce((sum, m) => sum + m.count, 0)).toBe(20);
    expect(layout.marks.some((m) => m.op === "dot")).toBe(false);
    for (const m of heat) expect(m.h).toBe(m.count >= 10 ? 8 : m.count >= 4 ? 6 : m.count >= 2 ? 4 : 2);
  });

  it("keeps the overlay under 150 nodes at Session level on a 5k-step session", () => {
    const p = prepare(largeSession());
    const layout = layoutOverview({ overview: p.overview, camera: p.fit, widthPx: 1_200, level: "session" });
    const labeled = layout.bands.filter((b) => b.tier !== null).length;
    expect(layout.pins.length + labeled + layout.turnLines.length + layout.links.length).toBeLessThanOrEqual(MAX_OVERLAY_NODES);
    expect(layout.strip.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(5_000);
  });
});

function oauthKind(session: TraceSession, index: number | undefined): string | undefined {
  return index === undefined ? undefined : session.steps[index]?.kind;
}
```

`packages/trace-viewer/src/layout/overview-layout.property.test.ts`:

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { LANES, type TraceSession } from "../model/index.js";
import { arbTraceSession } from "../test-support/arbitraries.js";
import { largeSession } from "../test-support/session-builder.js";
import { buildOverviewIndex } from "./overview-index.js";
import { K_MAX, layoutOverview, MAX_OVERLAY_NODES, PIN_MIN_GAP_PX, type MarkOp, type OverviewLayout } from "./overview-layout.js";
import { buildTimeScale, timeScaleInputOf } from "./time-scale.js";
import { stepTone } from "./tone.js";
import { buildTraceIndex } from "./trace-index.js";
import { fitRange } from "./viewport.js";

function prepare(session: TraceSession) {
  const index = buildTraceIndex(session);
  const scale = buildTimeScale(timeScaleInputOf(session));
  return { index, scale, overview: buildOverviewIndex(session, index, scale) };
}

function shiftOp(op: MarkOp, dx: number): MarkOp {
  if ("x" in op) return { ...op, x: op.x + dx };
  return { ...op, x0: op.x0 + dx, x1: op.x1 + dx };
}

function expectShifted(a: OverviewLayout, b: OverviewLayout, dx: number): void {
  expect(b.marks).toHaveLength(a.marks.length);
  a.marks.forEach((op, i) => {
    const want = shiftOp(op, dx);
    const got = b.marks[i];
    expect(got?.op).toBe(want.op);
    for (const [key, value] of Object.entries(want)) {
      const actual = (got as Record<string, unknown> | undefined)?.[key];
      if (typeof value === "number") expect(actual as number).toBeCloseTo(value, 6);
      else expect(actual).toEqual(value);
    }
  });
  expect(b.pins.map((p) => p.key)).toEqual(a.pins.map((p) => p.key));
  b.pins.forEach((p, i) => expect(p.x).toBeCloseTo((a.pins[i]?.x ?? 0) + dx, 6));
  expect(b.bands.map((x) => [x.key, x.tier, x.iconOnly])).toEqual(a.bands.map((x) => [x.key, x.tier, x.iconOnly]));
  b.bands.forEach((band, i) => expect(band.x0).toBeCloseTo((a.bands[i]?.x0 ?? 0) + dx, 6));
  expect(b.turnLines.map((t) => t.label)).toEqual(a.turnLines.map((t) => t.label));
  expect(b.links).toEqual(a.links);
  expect([...b.strip]).toEqual([...a.strip]);
}

const level = fc.constantFrom("session" as const, "chapter" as const, "step" as const);

describe("overview layout properties (spec §7.6.1)", () => {
  it("a pan changes only x offsets", () => {
    fc.assert(fc.property(arbTraceSession({ maxSteps: 50, maxChapters: 5, maxTurns: 3 }), fc.double({ min: 1e-4, max: 0.05, noNaN: true }), fc.double({ min: 0, max: 100, noNaN: true }), level, (session, k, dx, lvl) => {
      const { overview } = prepare(session);
      const widthPx = overview.endU * k + 600;
      const a = layoutOverview({ overview, camera: { mode: "xOnly", u0: -200 / k, k }, widthPx, level: lvl });
      const b = layoutOverview({ overview, camera: { mode: "xOnly", u0: -200 / k - dx / k, k }, widthPx, level: lvl });
      expectShifted(a, b, dx);
    }), { numRuns: 80 });
  });

  it("every problem tick survives at every k from fit to K_MAX", () => {
    fc.assert(fc.property(arbTraceSession({ maxSteps: 40, maxChapters: 4 }), fc.double({ min: 0, max: 1, noNaN: true }), level, (session, f, lvl) => {
      const { index, scale, overview } = prepare(session);
      const fitK = fitRange(0, overview.endU, 1_000, { padFraction: 0.02, limits: { minK: 1e-9, maxK: K_MAX } }).k;
      const k = fitK + (Math.min(K_MAX, 0.01) - fitK) * f;
      const camera = { mode: "xOnly" as const, u0: -50 / k, k };
      const layout = layoutOverview({ overview, camera, widthPx: overview.endU * k + 200, level: lvl });
      for (const step of session.steps) {
        if (stepTone(step, index.findingsById) !== "bad") continue;
        const x = (scale.toU(step.tMs) - camera.u0) * k;
        const found = layout.marks.some((m) => m.op === "problem" && m.lane === step.lane && Math.abs(m.x - x) < 1e-6);
        expect(found, step.id).toBe(true);
      }
    }), { numRuns: 80 });
  });

  it("pins on one lane never overlap", () => {
    fc.assert(fc.property(arbTraceSession({ maxSteps: 60, maxChapters: 4 }), fc.double({ min: 1e-5, max: K_MAX, noNaN: true }), fc.double({ min: -1e6, max: 1e6, noNaN: true }), level, (session, k, u0, lvl) => {
      const { overview } = prepare(session);
      const layout = layoutOverview({ overview, camera: { mode: "xOnly", u0, k }, widthPx: 1_200, level: lvl });
      for (const lane of LANES) {
        const xs = layout.pins.filter((p) => p.lane === lane).map((p) => p.x).sort((a, b) => a - b);
        for (let i = 1; i < xs.length; i += 1) expect((xs[i] ?? 0) - (xs[i - 1] ?? 0)).toBeGreaterThanOrEqual(PIN_MIN_GAP_PX - 1e-9);
      }
    }), { numRuns: 100 });
  });

  it("the overlay stays within 150 nodes at Session level on 5k-step sessions", () => {
    fc.assert(fc.property(fc.constantFrom(1, 2, 3), (seed) => {
      const { overview } = prepare(largeSession({ seed }));
      const camera = fitRange(0, overview.endU, 1_200, { padFraction: 0.02, limits: { minK: 1e-9, maxK: K_MAX } });
      const layout = layoutOverview({ overview, camera, widthPx: 1_200, level: "session" });
      const nodes = layout.pins.length + layout.bands.filter((b) => b.tier !== null).length + layout.turnLines.length + layout.links.length;
      expect(nodes).toBeLessThanOrEqual(MAX_OVERLAY_NODES);
    }), { numRuns: 3 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/overview-layout.test.ts src/layout/overview-layout.property.test.ts`
Expected: FAIL, `Failed to resolve import "./overview-index.js"`.

- [ ] **Step 3: Write the implementation**

`packages/trace-viewer/src/layout/overview-index.ts`:

```ts
import {
  LANES,
  type Finding, type FindingId, type Lane, type Severity, type SignalId, type Step, type StepKind, type TraceSession,
  type TurnTrigger, type UnitStableId,
} from "../model/index.js";
import type { TimeScale } from "./time-scale.js";
import { stepTone, worstSeverity, type Tone } from "./tone.js";
import type { TraceIndex } from "./trace-index.js";

export type Glyph = "dot" | "ring" | "bar" | "hist" | "wait";
export type PinRule = "always" | "finding" | "never";

/** Spec §7.6.1: the lane is a model fact; the glyph and pin rule are drawing choices. */
export const PLACEMENT: { readonly [K in StepKind]: { glyph: Glyph; pin: PinRule; echo?: Lane } } = {
  instruction: { glyph: "dot", pin: "always" },
  decision: { glyph: "wait", pin: "always" },
  approval: { glyph: "wait", pin: "always" },
  message: { glyph: "dot", pin: "finding" },
  reasoning: { glyph: "dot", pin: "finding" },
  lifecycle: { glyph: "dot", pin: "finding" },
  tool: { glyph: "bar", pin: "finding" },
  command: { glyph: "bar", pin: "finding" },
  test: { glyph: "bar", pin: "finding", echo: "commands" },
  check: { glyph: "bar", pin: "finding", echo: "commands" },
  edit: { glyph: "hist", pin: "finding" },
  dependency: { glyph: "hist", pin: "finding" },
  revert: { glyph: "hist", pin: "finding" },
  read: { glyph: "ring", pin: "never" },
  guardrail: { glyph: "dot", pin: "always" },
  attention: { glyph: "dot", pin: "finding" },
};

export const GLYPH_CODE: { readonly [G in Glyph]: number } = { dot: 0, ring: 1, bar: 2, hist: 3, wait: 4 };
export const TONE_CODE: { readonly [T in Tone]: number } = { neutral: 0, bad: 1, good: 2 };

export type PinKind = "critical_finding" | "failed" | "decision" | "approval" | "instruction" | "guardrail" | "finding" | "other";
/** Higher wins a cluster's icon: critical finding > failed > decision/approval > instruction > guardrail > other. */
export const PIN_PRIORITY: { readonly [K in PinKind]: number } = {
  critical_finding: 7, failed: 6, decision: 5, approval: 5, instruction: 4, guardrail: 3, finding: 2, other: 1,
};

export interface LaneMarks {
  readonly count: number;
  /** Sorted ascending by u0. */
  readonly u0: Float64Array;
  readonly u1: Float64Array;
  /** Index into session.steps. */
  readonly step: Int32Array;
  readonly glyph: Uint8Array;
  readonly tone: Uint8Array;
  readonly added: Float64Array;
  readonly removed: Float64Array;
  readonly problem: Uint8Array;
  /** 1 when the step is noise (drawn per level). */
  readonly noise: Uint8Array;
  /** Longest u1 − u0 on the lane, for the visible-range binary search. */
  readonly maxSpan: number;
}
export interface PinCandidate { stepIndex: number; lane: Lane; u: number; kind: PinKind; critical: boolean; findingId: FindingId | null }
export interface BandSpan { key: `ch:${number}` | `turn:${number}`; id: UnitStableId | null; u0: number; u1: number; title: string }
export interface OverviewIndex {
  readonly endU: number;
  readonly lanes: { readonly [L in Lane]: LaneMarks };
  readonly pins: readonly PinCandidate[];
  /** Chapters, or turns when the session has no chapters. */
  readonly bands: readonly BandSpan[];
  readonly turns: readonly { index: number; u: number; trigger: TurnTrigger }[];
  readonly links: readonly { findingId: FindingId; fromStep: number; toStep: number }[];
}

interface Row { u0: number; u1: number; step: number; glyph: number; tone: number; added: number; removed: number; problem: number; noise: number }

const SEVERITY_RANK: { readonly [S in Severity]: number } = { info: 0, warning: 1, critical: 2 };
const RULE_RANK: { readonly [K in SignalId]: number } = {
  claim_contradicted: 0, destructive_command: 1, failing_tests: 2, guardrail_clamp: 3, recovery_arc: 4,
};

function mostSevere(step: Step, findingsById: ReadonlyMap<FindingId, Finding>): FindingId | null {
  let best: Finding | null = null;
  for (const id of step.findingIds) {
    const f = findingsById.get(id);
    if (f === undefined) continue;
    if (best === null || SEVERITY_RANK[f.severity] > SEVERITY_RANK[best.severity]
      || (f.severity === best.severity && RULE_RANK[f.ruleId] < RULE_RANK[best.ruleId])) best = f;
  }
  return best?.id ?? null;
}

function toMarks(rows: Row[]): LaneMarks {
  rows.sort((a, b) => a.u0 - b.u0 || a.step - b.step);
  const n = rows.length;
  const marks = {
    count: n,
    u0: new Float64Array(n), u1: new Float64Array(n), step: new Int32Array(n), glyph: new Uint8Array(n), tone: new Uint8Array(n),
    added: new Float64Array(n), removed: new Float64Array(n), problem: new Uint8Array(n), noise: new Uint8Array(n), maxSpan: 0,
  };
  rows.forEach((r, i) => {
    marks.u0[i] = r.u0;
    marks.u1[i] = r.u1;
    marks.step[i] = r.step;
    marks.glyph[i] = r.glyph;
    marks.tone[i] = r.tone;
    marks.added[i] = r.added;
    marks.removed[i] = r.removed;
    marks.problem[i] = r.problem;
    marks.noise[i] = r.noise;
    marks.maxSpan = Math.max(marks.maxSpan, r.u1 - r.u0);
  });
  return marks;
}

function pinKind(step: Step, critical: boolean, hasFinding: boolean): PinKind {
  if (critical) return "critical_finding";
  if (step.status === "failed") return "failed";
  if (step.kind === "decision") return "decision";
  if (step.kind === "approval") return "approval";
  if (step.kind === "instruction") return "instruction";
  if (step.kind === "guardrail") return "guardrail";
  return hasFinding ? "finding" : "other";
}

/** Rebuilt once per fold: struct-of-arrays marks per lane, pin candidates, band spans, turns and ≠ links. */
export function buildOverviewIndex(session: TraceSession, index: TraceIndex, scale: TimeScale): OverviewIndex {
  const rows = new Map<Lane, Row[]>(LANES.map((lane) => [lane, []]));
  const pins: PinCandidate[] = [];
  session.steps.forEach((step, i) => {
    const place = PLACEMENT[step.kind];
    const u0 = scale.toU(step.tMs);
    const u1 = Math.max(u0, scale.toU(step.tMs + Math.max(0, step.durationMs ?? 0)));
    const tone = stepTone(step, index.findingsById);
    rows.get(step.lane)?.push({
      u0, u1, step: i, glyph: GLYPH_CODE[place.glyph], tone: TONE_CODE[tone],
      added: step.edit?.added ?? 0, removed: step.edit?.removed ?? 0, problem: tone === "bad" ? 1 : 0, noise: step.noise === null ? 0 : 1,
    });
    if (place.echo !== undefined) {
      rows.get(place.echo)?.push({ u0, u1, step: i, glyph: GLYPH_CODE.bar, tone: TONE_CODE.neutral, added: 0, removed: 0, problem: 0, noise: 0 });
    }
    const hasFinding = step.findingIds.length > 0;
    const pinned = place.pin === "always" || (place.pin === "finding" && (hasFinding || step.status === "failed"));
    if (!pinned) return;
    const critical = worstSeverity(step, index.findingsById) === "critical";
    pins.push({
      stepIndex: i, lane: step.lane, u: place.glyph === "wait" ? u1 : u0,
      kind: pinKind(step, critical, hasFinding), critical, findingId: mostSevere(step, index.findingsById),
    });
  });
  const lanes = Object.fromEntries(LANES.map((lane) => [lane, toMarks(rows.get(lane) ?? [])])) as { [L in Lane]: LaneMarks };

  const bands: BandSpan[] = [];
  const current = session.chapters.filter((c) => c.current);
  if (current.length > 0) {
    for (const chapter of current) {
      const key = index.chapterKey(chapter.id);
      if (key === undefined) continue;
      const spans = chapter.stepIds
        .map((id) => index.entry(id))
        .filter((e): e is NonNullable<typeof e> => e !== undefined)
        .map((e): [number, number] => [scale.toU(e.t0), scale.toU(e.t1)])
        .sort((a, b) => a[0] - b[0]);
      if (spans.length === 0) spans.push([scale.toU(chapter.tMs), scale.toU(chapter.endTMs)]);
      let piece: [number, number] | null = null;
      for (const span of spans) {
        if (piece !== null && span[0] <= piece[1]) piece[1] = Math.max(piece[1], span[1]);
        else {
          if (piece !== null) bands.push({ key, id: chapter.id, u0: piece[0], u1: piece[1], title: chapter.title });
          piece = [span[0], span[1]];
        }
      }
      if (piece !== null) bands.push({ key, id: chapter.id, u0: piece[0], u1: piece[1], title: chapter.title });
    }
  } else {
    for (const turn of session.turns) {
      bands.push({ key: `turn:${turn.index}`, id: null, u0: scale.toU(turn.tMs), u1: scale.toU(turn.endTMs), title: `Turn ${turn.index + 1}` });
    }
  }
  bands.sort((a, b) => a.u0 - b.u0 || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const links: { findingId: FindingId; fromStep: number; toStep: number }[] = [];
  for (const finding of session.findings) {
    if (finding.ruleId !== "claim_contradicted") continue;
    const from = index.entry(finding.claimStepId ?? finding.anchorStepId)?.position;
    const evidence = finding.evidenceStepIds?.[0];
    const to = evidence === undefined ? undefined : index.entry(evidence)?.position;
    if (from !== undefined && to !== undefined) links.push({ findingId: finding.id, fromStep: from, toStep: to });
  }

  return {
    endU: scale.endU,
    lanes,
    pins,
    bands,
    turns: session.turns.map((turn) => ({ index: turn.index, u: scale.toU(turn.tMs), trigger: turn.trigger })),
    links,
  };
}
```

`packages/trace-viewer/src/layout/overview-layout.ts`:

```ts
import { LANES, type FindingId, type Lane, type Level, type UnitStableId } from "../model/index.js";
import { GLYPH_CODE, PIN_PRIORITY, type LaneMarks, type OverviewIndex, type PinCandidate, type PinKind } from "./overview-index.js";
import type { TimeScale } from "./time-scale.js";
import type { Tone } from "./tone.js";
import type { Brush, TraceIndex } from "./trace-index.js";
import { fitRange, type XOnlyCamera } from "./viewport.js";

export const OVERVIEW_H = 288;
export const LABELS_H = 36;
export const RULER_TOP = 36;
export const LANES_TOP = 58;
export const LANE_H = 28;
export const STRIP_H = 6;
export const GUTTER_W = 112;
export const GUTTER_W_NARROW = 40;
export const NARROW_CONTAINER_PX = 1180;
export const BIN_PX = 6;
export const PIN_PX = 22;
export const PIN_MIN_GAP_PX = 26;
export const DOT_MIN_GAP_PX = 8;
export const BAR_MIN_W_PX = 3;
export const HIST_CAP_PX = 12;
export const BAND_MERGE_GAP_PX = 24;
export const K_MAX = 0.4;
export const MAX_OVERLAY_NODES = 150;

const LABEL_ICON_PX = 22;
const LABEL_CHAR_PX = 7;
const LABEL_GAP_PX = 8;
const ICON_ONLY_PX = 20;
const BAR_MERGE_PX = 2;
const CHAPTER_MIN_SPAN_MS = 20_000;

export type MarkOp =
  | { op: "dot"; lane: Lane; x: number; tone: Tone }
  | { op: "ring"; lane: Lane; x: number }
  | { op: "bar"; lane: Lane; x0: number; x1: number; tone: Tone; endTone?: Tone }
  | { op: "heat"; lane: Lane; x: number; count: number; h: 2 | 4 | 6 | 8 }
  | { op: "hist"; lane: Lane; x: number; upPx: number; downPx: number }
  | { op: "wait"; lane: Lane; x0: number; x1: number }
  | { op: "noise"; lane: Lane; x0: number; x1: number }
  | { op: "problem"; lane: Lane; x: number };
export interface PinPlacement { key: string; lane: Lane; x: number; kind: PinKind; critical: boolean; stepIndexes: readonly number[]; cluster: boolean; findingId: FindingId | null }
export interface BandPlacement { key: string; id: UnitStableId | null; x0: number; x1: number; title: string; tier: 0 | 1 | null; iconOnly: boolean }
export interface OverviewLayout {
  marks: readonly MarkOp[];
  pins: readonly PinPlacement[];
  bands: readonly BandPlacement[];
  /** Hairline plus ruler chip "T2 · steer". */
  turnLines: readonly { x: number; label: string }[];
  /** claim_contradicted: quote pin ↔ evidence pin with ≠ at the midpoint. */
  links: readonly { findingId: FindingId; fromPin: string; toPin: string }[];
  /** 1 px density bins across the full session for the 6 px strip. */
  strip: Float64Array;
}
export interface OverviewLayoutInput { overview: OverviewIndex; camera: XOnlyCamera; widthPx: number; level: Level }
export interface OverviewPresetInput {
  level: Level; overview: OverviewIndex; index: TraceIndex; scale: TimeScale;
  widthPx: number; playheadSeq: number; live: boolean;
}

const TONES: readonly Tone[] = ["neutral", "bad", "good"];
const TONE_RANK: { readonly [T in Tone]: number } = { good: 0, neutral: 1, bad: 2 };
const worse = (a: Tone, b: Tone): Tone => (TONE_RANK[b] > TONE_RANK[a] ? b : a);
const SESSION_PINS: ReadonlySet<PinKind> = new Set<PinKind>(["critical_finding", "instruction", "decision"]);

function heatHeight(count: number): 2 | 4 | 6 | 8 {
  if (count >= 10) return 8;
  if (count >= 4) return 6;
  if (count >= 2) return 4;
  return 2;
}

/** First index in [0, count) with arr[i] ≥ value. */
function lowerBound(arr: Float64Array, count: number, value: number): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((arr[mid] ?? 0) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface BarRun { u0: number; u1: number; tone: Tone; endTone: Tone | undefined }
interface Dot { u: number; tone: Tone; ring: boolean }

function layoutLane(lane: Lane, m: LaneMarks, camera: XOnlyCamera, uStart: number, uEnd: number, level: Level, marks: MarkOp[]): void {
  const k = camera.k;
  const xOf = (u: number): number => (u - camera.u0) * k;
  const binX = (bin: number): number => bin * BIN_PX + BIN_PX / 2 - camera.u0 * k;
  const barOp = (run: BarRun): MarkOp => (run.endTone === undefined || run.endTone === run.tone
    ? { op: "bar", lane, x0: xOf(run.u0), x1: xOf(run.u1), tone: run.tone }
    : { op: "bar", lane, x0: xOf(run.u0), x1: xOf(run.u1), tone: run.tone, endTone: run.endTone });
  const noiseOp = (u0: number, u1: number): MarkOp => ({ op: "noise", lane, x0: xOf(u0), x1: Math.max(xOf(u1), xOf(u0) + 1) });
  const heat = new Map<number, number>();
  const hist = new Map<number, { added: number; removed: number }>();
  const dots: Dot[] = [];
  let bar: BarRun | null = null;
  let noise: { u0: number; u1: number } | null = null;

  for (let i = lowerBound(m.u0, m.count, uStart - m.maxSpan); i < m.count; i += 1) {
    const u0 = m.u0[i] ?? 0;
    if (u0 > uEnd) break;
    const u1 = m.u1[i] ?? u0;
    if (u1 < uStart) continue;
    const tone = TONES[m.tone[i] ?? 0] ?? "neutral";
    const glyph = m.glyph[i] ?? GLYPH_CODE.dot;
    if ((m.problem[i] ?? 0) === 1) marks.push({ op: "problem", lane, x: xOf(u0) });
    if ((m.noise[i] ?? 0) === 1 && level !== "step") {
      if (level === "session") continue;
      if (noise !== null) noise.u1 = Math.max(noise.u1, u1);
      else noise = { u0, u1 };
      continue;
    }
    if (noise !== null) {
      marks.push(noiseOp(noise.u0, noise.u1));
      noise = null;
    }
    if (glyph === GLYPH_CODE.wait) {
      marks.push({ op: "wait", lane, x0: xOf(u0), x1: Math.max(xOf(u1), xOf(u0) + 1) });
      continue;
    }
    if (glyph === GLYPH_CODE.hist) {
      const bin = Math.floor((u0 * k) / BIN_PX);
      const h = hist.get(bin) ?? { added: 0, removed: 0 };
      h.added += m.added[i] ?? 0;
      h.removed += m.removed[i] ?? 0;
      hist.set(bin, h);
      continue;
    }
    if (glyph === GLYPH_CODE.bar && level !== "session" && (u1 - u0) * k >= BAR_MIN_W_PX) {
      if (bar !== null && (u0 - bar.u1) * k < BAR_MERGE_PX) {
        bar.u1 = Math.max(bar.u1, u1);
        bar.endTone = worse(bar.endTone ?? bar.tone, tone);
      } else {
        if (bar !== null) marks.push(barOp(bar));
        bar = { u0, u1, tone, endTone: undefined };
      }
      continue;
    }
    dots.push({ u: u0, tone, ring: glyph === GLYPH_CODE.ring });
  }
  if (bar !== null) marks.push(barOp(bar));
  if (noise !== null) marks.push(noiseOp(noise.u0, noise.u1));

  dots.forEach((dot, j) => {
    const prev = dots[j - 1];
    const next = dots[j + 1];
    const isolated = level !== "session"
      && (prev === undefined || (dot.u - prev.u) * k >= DOT_MIN_GAP_PX)
      && (next === undefined || (next.u - dot.u) * k >= DOT_MIN_GAP_PX);
    if (isolated) {
      marks.push(dot.ring ? { op: "ring", lane, x: xOf(dot.u) } : { op: "dot", lane, x: xOf(dot.u), tone: dot.tone });
      return;
    }
    const bin = Math.floor((dot.u * k) / BIN_PX);
    heat.set(bin, (heat.get(bin) ?? 0) + 1);
  });
  for (const [bin, count] of [...heat].sort((a, b) => a[0] - b[0])) {
    marks.push({ op: "heat", lane, x: binX(bin), count, h: heatHeight(count) });
  }
  for (const [bin, h] of [...hist].sort((a, b) => a[0] - b[0])) {
    marks.push({
      op: "hist", lane, x: binX(bin),
      upPx: Math.min(HIST_CAP_PX, Math.log2(1 + h.added)), downPx: Math.min(HIST_CAP_PX, Math.log2(1 + h.removed)),
    });
  }
}

function placePins(overview: OverviewIndex, camera: XOnlyCamera, widthPx: number, level: Level, gapPx: number): PinPlacement[] {
  const k = camera.k;
  const xOf = (u: number): number => (u - camera.u0) * k;
  const byLane = new Map<Lane, PinCandidate[]>();
  for (const pin of overview.pins) {
    if (level === "session" && !SESSION_PINS.has(pin.kind)) continue;
    const x = xOf(pin.u);
    if (x < -PIN_PX || x > widthPx + PIN_PX) continue;
    const list = byLane.get(pin.lane) ?? [];
    list.push(pin);
    byLane.set(pin.lane, list);
  }
  const out: PinPlacement[] = [];
  const place = (lane: Lane, members: readonly PinCandidate[], u: number): void => {
    let top = members[0];
    if (top === undefined) return;
    for (const m of members) if (PIN_PRIORITY[m.kind] > PIN_PRIORITY[top.kind]) top = m;
    const first = members[0]?.stepIndex ?? top.stepIndex;
    out.push({
      key: members.length === 1 ? `pin:${top.stepIndex}` : `cl:${lane}:${first}`,
      lane, x: xOf(u), kind: top.kind, critical: members.some((m) => m.critical),
      stepIndexes: members.map((m) => m.stepIndex), cluster: members.length > 1, findingId: top.findingId,
    });
  };
  for (const lane of LANES) {
    const list = [...(byLane.get(lane) ?? [])].sort((a, b) => a.u - b.u || a.stepIndex - b.stepIndex);
    let members: PinCandidate[] = [];
    let clusterU = 0;
    for (const pin of list) {
      if (members.length > 0 && (pin.u - clusterU) * k < gapPx) {
        members.push(pin);
      } else {
        place(lane, members, clusterU);
        members = [pin];
        clusterU = pin.u;
      }
    }
    place(lane, members, clusterU);
  }
  return out;
}

function placeBands(overview: OverviewIndex, camera: XOnlyCamera, widthPx: number): BandPlacement[] {
  const k = camera.k;
  const xOf = (u: number): number => (u - camera.u0) * k;
  const byKey = new Map<string, { id: UnitStableId | null; u0: number; u1: number; title: string }[]>();
  for (const band of overview.bands) {
    const list = byKey.get(band.key) ?? [];
    list.push({ id: band.id, u0: band.u0, u1: band.u1, title: band.title });
    byKey.set(band.key, list);
  }
  const merged: { key: string; id: UnitStableId | null; u0: number; u1: number; title: string }[] = [];
  for (const [key, pieces] of byKey) {
    let current: { key: string; id: UnitStableId | null; u0: number; u1: number; title: string } | null = null;
    for (const piece of [...pieces].sort((a, b) => a.u0 - b.u0)) {
      if (current !== null && (piece.u0 - current.u1) * k < BAND_MERGE_GAP_PX) current.u1 = Math.max(current.u1, piece.u1);
      else {
        if (current !== null) merged.push(current);
        current = { key, ...piece };
      }
    }
    if (current !== null) merged.push(current);
  }
  const visible = merged
    .filter((b) => xOf(b.u1) >= 0 && xOf(b.u0) <= widthPx)
    .sort((a, b) => a.u0 - b.u0 || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const seen = new Map<string, number>();
  const tierEndU: [number, number] = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  return visible.map((band) => {
    const n = seen.get(band.key) ?? 0;
    seen.set(band.key, n + 1);
    let tier: 0 | 1 | null = null;
    let iconOnly = false;
    if (n === 0) {
      const bandPx = (band.u1 - band.u0) * k;
      const labelPx = LABEL_ICON_PX + band.title.length * LABEL_CHAR_PX;
      const full = bandPx >= labelPx;
      if (full || bandPx >= ICON_ONLY_PX) {
        for (const t of [0, 1] as const) {
          if (band.u0 >= tierEndU[t] + LABEL_GAP_PX / k) {
            tier = t;
            iconOnly = !full;
            tierEndU[t] = band.u0 + (full ? labelPx : ICON_ONLY_PX) / k;
            break;
          }
        }
      }
    }
    return { key: n === 0 ? band.key : `${band.key}#${n}`, id: band.id, x0: xOf(band.u0), x1: xOf(band.u1), title: band.title, tier, iconOnly };
  });
}

function placeLinks(overview: OverviewIndex, pins: readonly PinPlacement[]): { findingId: FindingId; fromPin: string; toPin: string }[] {
  const keyOfStep = new Map<number, string>();
  for (const pin of pins) for (const i of pin.stepIndexes) keyOfStep.set(i, pin.key);
  const out: { findingId: FindingId; fromPin: string; toPin: string }[] = [];
  for (const link of overview.links) {
    const fromPin = keyOfStep.get(link.fromStep);
    const toPin = keyOfStep.get(link.toStep);
    if (fromPin !== undefined && toPin !== undefined && fromPin !== toPin) out.push({ findingId: link.findingId, fromPin, toPin });
  }
  return out;
}

export function layoutOverview(input: OverviewLayoutInput): OverviewLayout {
  const { overview, camera, widthPx, level } = input;
  const k = camera.k;
  const margin = PIN_PX / k;
  const uStart = camera.u0 - margin;
  const uEnd = camera.u0 + widthPx / k + margin;
  const marks: MarkOp[] = [];
  for (const lane of LANES) layoutLane(lane, overview.lanes[lane], camera, uStart, uEnd, level, marks);

  const bands = placeBands(overview, camera, widthPx);
  const labeled = bands.filter((b) => b.tier !== null).length;
  const turnLines = overview.turns
    .filter((t) => t.index > 0)
    .map((t) => ({ x: (t.u - camera.u0) * k, label: `T${t.index + 1} · ${t.trigger}` }))
    .filter((t) => t.x >= 0 && t.x <= widthPx);
  let gap = PIN_MIN_GAP_PX;
  let pins = placePins(overview, camera, widthPx, level, gap);
  let links = placeLinks(overview, pins);
  for (let tries = 0; tries < 12 && pins.length + labeled + turnLines.length + links.length > MAX_OVERLAY_NODES; tries += 1) {
    gap *= 2;
    pins = placePins(overview, camera, widthPx, level, gap);
    links = placeLinks(overview, pins);
  }

  const width = Math.max(1, Math.floor(widthPx));
  const strip = new Float64Array(width);
  const endU = Math.max(overview.endU, 1e-9);
  for (const lane of LANES) {
    const m = overview.lanes[lane];
    for (let i = 0; i < m.count; i += 1) {
      const bin = Math.min(width - 1, Math.max(0, Math.floor(((m.u0[i] ?? 0) / endU) * width)));
      strip[bin] = (strip[bin] ?? 0) + 1;
    }
  }
  return { marks, pins, bands, turnLines, links, strip };
}

/** Spec §7.6.1 semantic-zoom table: preset camera and preset brush per level. */
export function overviewPreset(input: OverviewPresetInput): { camera: XOnlyCamera; brush: Brush } {
  const { level, overview, index, scale, widthPx, playheadSeq, live } = input;
  const limits = { minK: 1e-9, maxK: K_MAX };
  if (level === "session") {
    const end = Math.max(1, overview.endU * (live ? 1.2 : 1));
    return { camera: fitRange(0, end, widthPx, { padFraction: 0.02, limits }), brush: { kind: "session" } };
  }
  if (level === "chapter") {
    let u0 = 0;
    let u1 = overview.endU;
    let brush: Brush = { kind: "session" };
    const chapter = index.chapterAtSeq(playheadSeq);
    const entry = chapter === undefined ? undefined : index.entry(chapter.id);
    const key = chapter === undefined ? undefined : index.chapterKey(chapter.id);
    if (entry !== undefined && key !== undefined) {
      u0 = scale.toU(entry.t0);
      u1 = scale.toU(entry.t1);
      brush = { kind: "chapter", anchorSeq: Number(key.slice(3)) };
    } else {
      const turn = index.turnAtSeq(playheadSeq);
      if (turn !== undefined) {
        u0 = scale.toU(turn.tMs);
        u1 = scale.toU(turn.endTMs);
        brush = { kind: "range", fromSeq: turn.startSeq, toSeq: Math.max(turn.startSeq, turn.endSeq) };
      }
    }
    if (u1 - u0 < CHAPTER_MIN_SPAN_MS) {
      const center = (u0 + u1) / 2;
      u0 = center - CHAPTER_MIN_SPAN_MS / 2;
      u1 = center + CHAPTER_MIN_SPAN_MS / 2;
    }
    return { camera: fitRange(u0, u1, widthPx, { padFraction: 0.08, limits }), brush };
  }
  const steps = index.session?.steps ?? [];
  const i = Math.max(0, index.stepIndexAtOrBefore(playheadSeq));
  const us: number[] = [];
  for (let j = Math.max(0, i - 20); j <= Math.min(steps.length - 1, i + 20); j += 1) us.push(scale.toU(steps[j]?.tMs ?? 0));
  const spacings = us.slice(1).map((u, j) => u - (us[j] ?? u)).filter((d) => d > 0).sort((a, b) => a - b);
  const median = spacings.length === 0 ? 0 : spacings[Math.floor(spacings.length / 2)] ?? 0;
  const k = median > 0 ? Math.min(K_MAX, 28 / median) : K_MAX;
  const center = scale.toU(steps[i]?.tMs ?? 0);
  const camera: XOnlyCamera = { mode: "xOnly", k, u0: center - widthPx / (2 * k) };
  const uLast = camera.u0 + widthPx / k;
  let first = -1;
  let last = -1;
  steps.forEach((step, j) => {
    const u = scale.toU(step.tMs);
    if (u >= camera.u0 && u <= uLast) {
      if (first < 0) first = j;
      last = j;
    }
  });
  const from = steps[first]?.firstSeq ?? playheadSeq;
  const to = steps[last]?.lastSeq ?? playheadSeq;
  return { camera, brush: { kind: "range", fromSeq: Math.max(1, Math.min(from, to)), toSeq: Math.max(from, to) } };
}
```

`packages/trace-viewer/src/layout/overview-layout.bench.ts`:

```ts
import { bench, describe } from "vitest";

import { largeSession } from "../test-support/session-builder.js";
import { buildOverviewIndex } from "./overview-index.js";
import { K_MAX, layoutOverview } from "./overview-layout.js";
import { buildTimeScale, timeScaleInputOf } from "./time-scale.js";
import { buildTraceIndex } from "./trace-index.js";
import { fitRange } from "./viewport.js";

const session = largeSession();
const index = buildTraceIndex(session);
const scale = buildTimeScale(timeScaleInputOf(session));
const overview = buildOverviewIndex(session, index, scale);
const width = 1_200;
const fit = fitRange(0, overview.endU, width, { padFraction: 0.02, limits: { minK: 1e-9, maxK: K_MAX } });

// Reported only; the p95 ≤ 4 ms gate (layout + paint) is measured in the dev-host HUD at C2-16.
describe("overview layout, 60 chapters / 5k steps", () => {
  bench("layoutOverview at Session level", () => {
    layoutOverview({ overview, camera: fit, widthPx: width, level: "session" });
  });
  bench("layoutOverview at Chapter level, zoomed ×8", () => {
    layoutOverview({ overview, camera: { mode: "xOnly", u0: overview.endU / 2, k: fit.k * 8 }, widthPx: width, level: "chapter" });
  });
  bench("buildOverviewIndex", () => {
    buildOverviewIndex(session, index, scale);
  });
});
```

- [ ] **Step 4: Run the tests and the bench**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/overview-layout.test.ts src/layout/overview-layout.property.test.ts`
Expected: PASS, 11 tests.

Run: `pnpm --filter @jevcode/trace-viewer exec vitest bench --run src/layout/overview-layout.bench.ts`
Expected: three benchmark rows print with `hz` and `mean`; record the Session-level mean in the C1b lane hand-off (not a gate).

- [ ] **Step 5: Root checks**

```bash
pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint
```

Expected: each exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/trace-viewer/src/layout/overview-index.ts packages/trace-viewer/src/layout/overview-layout.ts packages/trace-viewer/src/layout/overview-layout.test.ts packages/trace-viewer/src/layout/overview-layout.property.test.ts packages/trace-viewer/src/layout/overview-layout.bench.ts
git commit -m "feat(trace-viewer): overview index, pan-stable lane layout and presets"
```

### Task C1-14: Spine rows (brush slice, noise, elision, beats, separators)

**Files:**
- Create: `packages/trace-viewer/src/layout/spine-rows.ts`
- Test: `packages/trace-viewer/src/layout/spine-rows.test.ts`
- Test: `packages/trace-viewer/src/layout/spine-rows.property.test.ts`

**Interfaces:**
- Consumes: C1-9 `type TimeScale`, `type IdleReason`, `BREAK_MIN_MS`, `buildTimeScale`, `timeScaleInputOf`; C1-10 `brushSeqRange`, `isStepExpanded`, `worstSeverity`, `stepTone`, `buildTraceIndex`, `type Brush`, `type SelectionId`, `type TraceIndex`; W0 `LANES`, `type Lane`, `type Level`, `type NoiseReason`, `type SignalId`, `type Severity`, `type Step`, `type StepId`, `type TraceSession`; C1-8 builders and `arbSessionSeed` (tests).
- Produces (UI index §2.1 verbatim):

```ts
export type SpineRow =
  | { t: "step"; key: StepId; step: number; expanded: boolean }
  | { t: "chapter"; key: `ch:${number}`; chapter: number }
  | { t: "noise"; key: `noise:${number}`; steps: number[]; label: string }
  | { t: "elided"; key: `elided:${number}`; steps: number[]; byLane: Record<Lane, number>; spanMs: number }
  | { t: "turn"; key: `turn:${number}`; turn: number }
  | { t: "idle"; key: `idle:${number}`; ms: number; reason: IdleReason }
  | { t: "gap"; key: `gap:${number}`; gap: number };
export const SPINE_ROW_PX = 32;
export const SPINE_SEPARATOR_PX = 24;
export const ELIDE_ABOVE_ROWS = 11;
export const ELIDE_HEAD = 3;
export const ELIDE_TAIL = 5;
export interface SpineRowsInput {
  brush: Brush; level: Level; playheadSeq: number; selection: SelectionId | null;
  expanded: ReadonlySet<string>; collapsed: ReadonlySet<string>; matches?: ReadonlySet<string>; live: boolean;
}
export function buildSpineRows(session: TraceSession, index: TraceIndex, scale: TimeScale, input: SpineRowsInput): SpineRow[];
export function estimateSpineRowSize(row: SpineRow, session: TraceSession): number;
export function spineRowIndexForSeq(rows: readonly SpineRow[], session: TraceSession, seq: number): number;
```

Rules (spec §7.6.3): pinned rows are instructions, decisions, approvals, steps with findings, failed steps, the playhead row, the selected row and search matches; a segment is a maximal run of unpinned rows within one chapter (the step's `TraceIndex.parent`) and one turn, broken by any separator; at Chapter level a segment of more than 11 rows shows 3, one `elided` band and 5, unless the band key is in `expanded` or the segment is the still-growing live tail; consecutive noise steps fold into one noise row (keyed by the first step's seq) even across chapters; an expanded noise row is followed by its steps; Step level shows every step with noise expanded and no elision; Session level shows current chapter rows interleaved by first seq with instruction, decision, approval and critical-finding steps (turn rows when the session has several turns or no chapters). Separators: a turn row before a turn's first row, an idle row (keyed by the next row's first seq) where a break ≥ `BREAK_MIN_MS` lies between two steps, a gap row before the first step after a fold gap.

- [ ] **Step 1: Write the failing tests**

`packages/trace-viewer/src/layout/spine-rows.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { TraceSession } from "../model/index.js";
import { buildSession, OAUTH_CLAIM_TEXT, oauthLikeSession, type StepSeed } from "../test-support/session-builder.js";
import { buildSpineRows, estimateSpineRowSize, spineRowIndexForSeq, type SpineRow, type SpineRowsInput } from "./spine-rows.js";
import { buildTimeScale, timeScaleInputOf } from "./time-scale.js";
import { stepTone } from "./tone.js";
import { buildTraceIndex } from "./trace-index.js";

const none = new Set<string>();
function rowsOf(session: TraceSession, input: Partial<SpineRowsInput> = {}): SpineRow[] {
  const index = buildTraceIndex(session);
  const scale = buildTimeScale(timeScaleInputOf(session));
  return buildSpineRows(session, index, scale, {
    brush: { kind: "session" }, level: "chapter", playheadSeq: 1, selection: null,
    expanded: none, collapsed: none, live: false, ...input,
  });
}

function commands(count: number, patch: (i: number) => Partial<StepSeed> = () => ({})): StepSeed[] {
  return [
    { kind: "instruction", tMs: 0, text: "go" },
    ...Array.from({ length: count }, (_, j): StepSeed => ({ kind: "command", tMs: (j + 1) * 1_000, durationMs: 500, target: `step ${j + 1}`, ...patch(j + 1) })),
  ];
}

describe("spine rows on the oauth-like session", () => {
  const oauth = oauthLikeSession();
  const claim = oauth.steps.find((s) => s.text === OAUTH_CLAIM_TEXT);

  it("shows one test row (14/1/0) and the claim expanded at +0:43", () => {
    const rows = rowsOf(oauth, { playheadSeq: claim?.firstSeq ?? 1, selection: claim?.id ?? null });
    const stepRows = rows.filter((r): r is Extract<SpineRow, { t: "step" }> => r.t === "step");
    const tests = stepRows.filter((r) => oauth.steps[r.step]?.kind === "test");
    expect(tests).toHaveLength(1);
    expect(oauth.steps[tests[0]?.step ?? -1]?.tests).toMatchObject({ passed: 14, failed: 1, skipped: 0 });
    const claimRow = stepRows.find((r) => r.key === claim?.id);
    expect(claimRow?.expanded).toBe(true);
    expect(oauth.steps[claimRow?.step ?? -1]?.tMs).toBe(43_000);
  });

  it("folds consecutive noise into labelled rows, across chapters", () => {
    const labels = rowsOf(oauth).filter((r): r is Extract<SpineRow, { t: "noise" }> => r.t === "noise").map((r) => r.label);
    expect(labels.slice(0, 2)).toEqual(["3 reads", "2 lockfile and formatting edits"]);
  });

  it("Session level shows chapter rows interleaved with beats", () => {
    const rows = rowsOf(oauth, { level: "session" });
    expect(rows.filter((r) => r.t === "chapter")).toHaveLength(7);
    const beats = rows.filter((r): r is Extract<SpineRow, { t: "step" }> => r.t === "step").map((r) => oauth.steps[r.step]?.kind);
    expect(beats).toEqual(["instruction", "decision", "test", "message"]);
    expect(rows[0]?.t).toBe("step");
  });

  it("estimates expanded finding rows per signal and finds the row holding a seq", () => {
    const rows = rowsOf(oauth);
    const claimRow = rows.find((r) => r.key === claim?.id);
    expect(claimRow === undefined ? 0 : estimateSpineRowSize(claimRow, oauth)).toBe(124);
    expect(estimateSpineRowSize({ t: "turn", key: "turn:1", turn: 1 }, oauth)).toBe(24);
    expect(spineRowIndexForSeq(rows, oauth, claim?.firstSeq ?? 0)).toBe(rows.indexOf(claimRow as SpineRow));
    const read = oauth.steps.find((s) => s.kind === "read");
    const readRow = spineRowIndexForSeq(rows, oauth, read?.firstSeq ?? 0);
    expect(rows[readRow]?.t).toBe("noise");
    expect(spineRowIndexForSeq(rows, oauth, 0)).toBe(-1);
  });
});

describe("elision and separators", () => {
  it("a 412-row unpinned segment renders 3 + band + 5", () => {
    const session = buildSession({ steps: commands(412) });
    const rows = rowsOf(session);
    expect(rows).toHaveLength(10);
    const band = rows[4];
    expect(band).toMatchObject({ t: "elided", key: "elided:5", spanMs: 403_500 });
    expect(band?.t === "elided" ? band.steps.length : 0).toBe(404);
    expect(band?.t === "elided" ? band.byLane.commands : 0).toBe(404);
  });

  it("the playhead row is never elided and splits the band", () => {
    const session = buildSession({ steps: commands(412) });
    const rows = rowsOf(session, { playheadSeq: 201 });
    expect(rows).toHaveLength(20);
    expect(rows.some((r) => r.t === "step" && r.key === "step:201")).toBe(true);
  });

  it("an expanded band and the live tail are not elided", () => {
    const session = buildSession({ steps: commands(412) });
    expect(rowsOf(session, { expanded: new Set(["elided:5"]) })).toHaveLength(413);
    expect(rowsOf(session, { live: true })).toHaveLength(413);
    expect(rowsOf(session, { level: "step" })).toHaveLength(413);
  });

  it("exit -1 is unknown, never failed", () => {
    const session = buildSession({
      steps: commands(20, (j) => (j === 6 ? { status: "unknown", command: { exitCode: -1 } } : j === 15 ? { status: "failed" } : {})),
    });
    const rows = rowsOf(session);
    expect(rows.some((r) => r.t === "step" && r.step === 6)).toBe(false);
    const band = rows.find((r): r is Extract<SpineRow, { t: "elided" }> => r.t === "elided");
    expect(band?.steps).toContain(6);
    expect(rows.some((r) => r.t === "step" && r.step === 15)).toBe(true);
    const index = buildTraceIndex(session);
    const six = session.steps[6];
    const fifteen = session.steps[15];
    expect(six === undefined ? "" : stepTone(six, index.findingsById)).toBe("neutral");
    expect(fifteen === undefined ? "" : stepTone(fifteen, index.findingsById)).toBe("neutral");
  });

  it("adds turn, idle and gap separator rows", () => {
    const session = buildSession({
      turns: [{ trigger: "initial", prompt: "a" }, { trigger: "steer", prompt: "b" }],
      steps: [
        { kind: "instruction", tMs: 0 },
        { kind: "command", tMs: 1_000, durationMs: 1_000, target: "pnpm build" },
        { kind: "instruction", tMs: 842_000, turn: 1 },
        { kind: "command", tMs: 843_000, turn: 1, target: "pnpm test" },
      ],
      gaps: [{ kind: "invalid_row", beforeStep: 3 }],
    });
    const rows = rowsOf(session);
    expect(rows.map((r) => r.t)).toEqual(["step", "step", "turn", "idle", "step", "gap", "step"]);
    expect(rows[3]).toEqual({ t: "idle", key: `idle:${session.steps[2]?.firstSeq}`, ms: 840_000, reason: "awaiting_supervisor" });
    expect(rows[5]).toEqual({ t: "gap", key: `gap:${session.gaps[0]?.atSeq}`, gap: 0 });
  });
});
```

`packages/trace-viewer/src/layout/spine-rows.property.test.ts`:

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { Step, TraceSession } from "../model/index.js";
import { arbSessionSeed, arbTraceSession } from "../test-support/arbitraries.js";
import { buildSession } from "../test-support/session-builder.js";
import { buildSpineRows, type SpineRow } from "./spine-rows.js";
import { buildTimeScale, timeScaleInputOf } from "./time-scale.js";
import { buildTraceIndex } from "./trace-index.js";

const none = new Set<string>();
const PINNED_KINDS = new Set(["instruction", "decision", "approval"]);

function rows(session: TraceSession, playheadSeq: number, selection: Step | undefined, matches: ReadonlySet<string>, live: boolean): SpineRow[] {
  const index = buildTraceIndex(session);
  return buildSpineRows(session, index, buildTimeScale(timeScaleInputOf(session)), {
    brush: { kind: "session" }, level: "chapter", playheadSeq, selection: selection?.id ?? null,
    expanded: none, collapsed: none, matches, live,
  });
}

describe("spine row properties (spec §7.6.3)", () => {
  it("the playhead row and every pinned row are never elided; keys are unique", () => {
    fc.assert(fc.property(arbTraceSession({ maxSteps: 80, maxChapters: 3, maxTurns: 2 }), fc.nat(), fc.nat(), fc.array(fc.nat(), { maxLength: 4 }), (session, p, s, m) => {
      const n = session.steps.length;
      const playhead = session.steps[p % n];
      const selected = session.steps[s % n];
      const matches = new Set(m.map((i) => session.steps[i % n]?.id ?? ""));
      const out = rows(session, playhead?.firstSeq ?? 1, selected, matches, false);
      expect(new Set(out.map((r) => r.key)).size).toBe(out.length);
      const shown = new Set(out.flatMap((r) => (r.t === "step" ? [r.step] : [])));
      session.steps.forEach((step, i) => {
        const pinned = PINNED_KINDS.has(step.kind) || step.findingIds.length > 0 || step.status === "failed"
          || step === playhead || step === selected || matches.has(step.id);
        if (pinned) expect(shown.has(i), step.id).toBe(true);
      });
    }), { numRuns: 150 });
  });

  it("keys from a prefix fold stay in the full fold except the open tail", () => {
    fc.assert(fc.property(arbSessionSeed({ maxSteps: 60, maxChapters: 3, maxTurns: 2, live: false }), fc.double({ min: 0, max: 1, noNaN: true }), (seed, f) => {
      const m = Math.max(1, Math.floor(seed.steps.length * f));
      const full = buildSession(seed);
      const prefix = buildSession({
        ...seed,
        live: true,
        state: "running",
        steps: seed.steps.slice(0, m),
        findings: (seed.findings ?? []).filter((x) => x.step < m).map((x) => ({ ...x, evidence: (x.evidence ?? []).filter((e) => e < m) })),
        gaps: (seed.gaps ?? []).filter((g) => g.beforeStep < m),
      });
      const prefixRows = rows(prefix, 1, undefined, none, true);
      const fullKeys = new Set(rows(full, 1, undefined, none, false).map((r) => r.key));
      let lastClosed = -1;
      prefixRows.forEach((row, j) => {
        if (row.t === "turn" || row.t === "idle" || row.t === "gap") lastClosed = j;
        if (row.t === "step") {
          const step = prefix.steps[row.step];
          if (step !== undefined && (PINNED_KINDS.has(step.kind) || step.findingIds.length > 0 || step.status === "failed" || step.firstSeq === 1)) lastClosed = j;
        }
      });
      for (const row of prefixRows.slice(0, lastClosed + 1)) expect(fullKeys.has(row.key), row.key).toBe(true);
    }), { numRuns: 150 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/spine-rows.test.ts src/layout/spine-rows.property.test.ts`
Expected: FAIL, `Failed to resolve import "./spine-rows.js"`.

- [ ] **Step 3: Write the implementation**

`packages/trace-viewer/src/layout/spine-rows.ts`:

```ts
import {
  LANES,
  type Finding, type Lane, type Level, type NoiseReason, type Severity, type SignalId, type Step, type StepId, type StepKind,
  type TraceSession,
} from "../model/index.js";
import { BREAK_MIN_MS, type IdleReason, type TimeScale } from "./time-scale.js";
import { worstSeverity } from "./tone.js";
import { brushSeqRange, isStepExpanded, type Brush, type SelectionId, type TraceIndex } from "./trace-index.js";

export type SpineRow =
  | { t: "step"; key: StepId; step: number; expanded: boolean }
  | { t: "chapter"; key: `ch:${number}`; chapter: number }
  | { t: "noise"; key: `noise:${number}`; steps: number[]; label: string }
  | { t: "elided"; key: `elided:${number}`; steps: number[]; byLane: Record<Lane, number>; spanMs: number }
  | { t: "turn"; key: `turn:${number}`; turn: number }
  | { t: "idle"; key: `idle:${number}`; ms: number; reason: IdleReason }
  | { t: "gap"; key: `gap:${number}`; gap: number };

export const SPINE_ROW_PX = 32;
export const SPINE_SEPARATOR_PX = 24;
export const ELIDE_ABOVE_ROWS = 11;
export const ELIDE_HEAD = 3;
export const ELIDE_TAIL = 5;

export interface SpineRowsInput {
  brush: Brush;
  level: Level;
  playheadSeq: number;
  selection: SelectionId | null;
  expanded: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
  matches?: ReadonlySet<string>;
  /** The still-growing tail segment is never elided. */
  live: boolean;
}

const PINNED_KINDS: ReadonlySet<StepKind> = new Set<StepKind>(["instruction", "decision", "approval"]);
const FINDING_ROW_PX: { readonly [K in SignalId]: number } = {
  claim_contradicted: 124, failing_tests: 112, destructive_command: 96, guardrail_clamp: 88, recovery_arc: 96,
};
const EXPANDED_ROW_PX = 96;
const SEVERITY_RANK: { readonly [S in Severity]: number } = { info: 0, warning: 1, critical: 2 };
const RULE_RANK: { readonly [K in SignalId]: number } = {
  claim_contradicted: 0, destructive_command: 1, failing_tests: 2, guardrail_clamp: 3, recovery_arc: 4,
};

const EDIT_ADJECTIVE: Partial<Record<NoiseReason, string>> = {
  lockfile: "lockfile", formatting: "formatting", superseded: "superseded", duplicate_poll: "repeated",
};
const NOUN: { readonly [R in NoiseReason]: [string, string] } = {
  read: ["read", "reads"],
  lockfile: ["lockfile edit", "lockfile edits"],
  formatting: ["formatting edit", "formatting edits"],
  duplicate_poll: ["repeated poll", "repeated polls"],
  lifecycle: ["lifecycle event", "lifecycle events"],
  superseded: ["superseded edit", "superseded edits"],
  passing_test: ["passing test run", "passing test runs"],
};

/** "3 reads", "2 lockfile and formatting edits", "4 noise steps: reads, lifecycle events". */
function noiseLabel(steps: readonly number[], session: TraceSession): string {
  const reasons: NoiseReason[] = [];
  for (const i of steps) {
    const reason = session.steps[i]?.noise;
    if (reason !== null && reason !== undefined && !reasons.includes(reason)) reasons.push(reason);
  }
  const n = steps.length;
  const only = reasons[0];
  if (reasons.length === 1 && only !== undefined) return `${n} ${NOUN[only][n === 1 ? 0 : 1]}`;
  if (reasons.length > 1 && reasons.every((r) => EDIT_ADJECTIVE[r] !== undefined)) {
    return `${n} ${reasons.map((r) => EDIT_ADJECTIVE[r]).join(" and ")} ${n === 1 ? "edit" : "edits"}`;
  }
  return `${n} noise steps: ${reasons.map((r) => NOUN[r][1]).join(", ")}`;
}

interface Segment { rows: SpineRow[]; parent: string | null; turn: number }

function emitSegment(out: SpineRow[], segment: Segment, input: SpineRowsInput, openTail: boolean, session: TraceSession): void {
  const rows: SpineRow[] = [];
  for (const row of segment.rows) {
    rows.push(row);
    if (row.t !== "noise" || !input.expanded.has(row.key)) continue;
    for (const i of row.steps) {
      const step = session.steps[i];
      if (step !== undefined) rows.push({ t: "step", key: step.id, step: i, expanded: input.expanded.has(step.id) });
    }
  }
  if (input.level !== "chapter" || openTail || rows.length <= ELIDE_ABOVE_ROWS) {
    out.push(...rows);
    return;
  }
  const middle = rows.slice(ELIDE_HEAD, rows.length - ELIDE_TAIL);
  const steps = middle.flatMap((r) => (r.t === "step" ? [r.step] : r.t === "noise" ? r.steps : []));
  const first = session.steps[steps[0] ?? -1];
  if (first === undefined) {
    out.push(...rows);
    return;
  }
  const key: `elided:${number}` = `elided:${first.firstSeq}`;
  if (input.expanded.has(key)) {
    out.push(...rows);
    return;
  }
  const byLane = Object.fromEntries(LANES.map((lane) => [lane, 0])) as Record<Lane, number>;
  let end = first.tMs;
  for (const i of steps) {
    const step = session.steps[i];
    if (step === undefined) continue;
    byLane[step.lane] += 1;
    end = Math.max(end, step.tMs + Math.max(0, step.durationMs ?? 0));
  }
  out.push(...rows.slice(0, ELIDE_HEAD), { t: "elided", key, steps, byLane, spanMs: end - first.tMs }, ...rows.slice(rows.length - ELIDE_TAIL));
}

function sessionRows(session: TraceSession, index: TraceIndex, input: SpineRowsInput, range: { fromSeq: number; toSeq: number }, i0: number, i1: number): SpineRow[] {
  const items: { seq: number; turn: number; row: SpineRow }[] = [];
  const current = session.chapters.filter((c) => c.current);
  session.chapters.forEach((chapter, position) => {
    if (!chapter.current) return;
    const entry = index.entry(chapter.id);
    const key = index.chapterKey(chapter.id);
    if (entry === undefined || key === undefined || entry.firstSeq < range.fromSeq || entry.firstSeq > range.toSeq) return;
    items.push({ seq: entry.firstSeq, turn: index.turnAtSeq(entry.firstSeq)?.index ?? 0, row: { t: "chapter", key, chapter: position } });
  });
  for (let i = i0; i <= i1; i += 1) {
    const step = session.steps[i];
    if (step === undefined) continue;
    if (!PINNED_KINDS.has(step.kind) && worstSeverity(step, index.findingsById) !== "critical") continue;
    items.push({
      seq: step.firstSeq, turn: step.turnIndex,
      row: { t: "step", key: step.id, step: i, expanded: isStepExpanded(step, index.findingsById, input.expanded, input.collapsed) },
    });
  }
  items.sort((a, b) => a.seq - b.seq || (a.row.t === "chapter" ? -1 : b.row.t === "chapter" ? 1 : 0));
  const showTurns = session.turns.length > 1 || current.length === 0;
  const out: SpineRow[] = [];
  let turn = -1;
  for (const item of items) {
    if (showTurns && item.turn !== turn) out.push({ t: "turn", key: `turn:${item.turn}`, turn: item.turn });
    turn = item.turn;
    out.push(item.row);
  }
  return out;
}

/** Binary-searches steps by firstSeq for the brushed range; keys survive refolds, churn and live ticks (spec §7.6.3). */
export function buildSpineRows(session: TraceSession, index: TraceIndex, scale: TimeScale, input: SpineRowsInput): SpineRow[] {
  const steps = session.steps;
  if (steps.length === 0) return [];
  const range = brushSeqRange(input.brush, index);
  const i0 = index.stepIndexAtOrAfter(range.fromSeq);
  const i1 = index.stepIndexAtOrBefore(range.toSeq);
  if (i0 > i1) return [];
  if (input.level === "session") return sessionRows(session, index, input, range, i0, i1);

  const playheadStep = index.stepIndexAtOrBefore(input.playheadSeq);
  const selected = input.selection === null ? undefined : index.entry(input.selection);
  const selectedStep = selected?.kind === "step" ? selected.position : -1;
  const gaps = session.gaps
    .map((gap, gi) => ({ gap, gi }))
    .filter(({ gap }) => gap.atSeq >= range.fromSeq && gap.atSeq <= range.toSeq)
    .sort((a, b) => a.gap.atSeq - b.gap.atSeq);
  let gapCursor = 0;
  const out: SpineRow[] = [];
  let segment: Segment | null = null;
  let prev: Step | null = null;

  for (let i = i0; i <= i1; i += 1) {
    const step = steps[i];
    if (step === undefined) continue;
    const separators: SpineRow[] = [];
    const turnStarts = prev === null
      ? step.turnIndex > 0 && (steps[i - 1]?.turnIndex ?? -1) !== step.turnIndex
      : step.turnIndex !== prev.turnIndex;
    if (turnStarts) separators.push({ t: "turn", key: `turn:${step.turnIndex}`, turn: step.turnIndex });
    if (prev !== null) {
      const prevEnd = prev.tMs + Math.max(0, prev.durationMs ?? 0);
      if (step.tMs > prevEnd) {
        const brk = scale.breaks(scale.toU(prevEnd), scale.toU(step.tMs), BREAK_MIN_MS)[0];
        if (brk?.idle) separators.push({ t: "idle", key: `idle:${step.firstSeq}`, ms: brk.idle.ms, reason: brk.idle.reason });
      }
    }
    for (let next = gaps[gapCursor]; next !== undefined && next.gap.atSeq < step.firstSeq; next = gaps[gapCursor]) {
      separators.push({ t: "gap", key: `gap:${next.gap.atSeq}`, gap: next.gi });
      gapCursor += 1;
    }
    if (separators.length > 0 && segment !== null) {
      emitSegment(out, segment, input, false, session);
      segment = null;
    }
    out.push(...separators);

    const parent = index.entry(step.id)?.parent ?? null;
    const pinned = PINNED_KINDS.has(step.kind) || step.findingIds.length > 0 || step.status === "failed"
      || i === playheadStep || i === selectedStep || (input.matches?.has(step.id) ?? false);
    const row: SpineRow = { t: "step", key: step.id, step: i, expanded: isStepExpanded(step, index.findingsById, input.expanded, input.collapsed) };
    if (pinned) {
      if (segment !== null) {
        emitSegment(out, segment, input, false, session);
        segment = null;
      }
      out.push(row);
      prev = step;
      continue;
    }
    const isNoise = step.noise !== null && input.level !== "step";
    const last = segment === null ? undefined : segment.rows[segment.rows.length - 1];
    if (isNoise && last !== undefined && last.t === "noise") {
      last.steps.push(i);
      last.label = noiseLabel(last.steps, session);
      prev = step;
      continue;
    }
    if (segment !== null && (segment.parent !== parent || segment.turn !== step.turnIndex)) {
      emitSegment(out, segment, input, false, session);
      segment = null;
    }
    segment ??= { rows: [], parent, turn: step.turnIndex };
    segment.rows.push(isNoise ? { t: "noise", key: `noise:${step.firstSeq}`, steps: [i], label: noiseLabel([i], session) } : row);
    prev = step;
  }
  if (segment !== null) emitSegment(out, segment, input, input.live && i1 === steps.length - 1, session);
  for (let next = gaps[gapCursor]; next !== undefined; next = gaps[gapCursor]) {
    out.push({ t: "gap", key: `gap:${next.gap.atSeq}`, gap: next.gi });
    gapCursor += 1;
  }
  return out;
}

function firstFinding(step: Step, session: TraceSession): Finding | undefined {
  let best: Finding | undefined;
  for (const finding of session.findings) {
    if (!step.findingIds.includes(finding.id)) continue;
    if (best === undefined || SEVERITY_RANK[finding.severity] > SEVERITY_RANK[best.severity]
      || (finding.severity === best.severity && RULE_RANK[finding.ruleId] < RULE_RANK[best.ruleId])) best = finding;
  }
  return best;
}

/** 32 for step/chapter/noise/elided, 24 for separators, per signal for expanded finding rows (124 for claim_contradicted). */
export function estimateSpineRowSize(row: SpineRow, session: TraceSession): number {
  if (row.t === "turn" || row.t === "idle" || row.t === "gap") return SPINE_SEPARATOR_PX;
  if (row.t !== "step" || !row.expanded) return SPINE_ROW_PX;
  const step = session.steps[row.step];
  const finding = step === undefined ? undefined : firstFinding(step, session);
  return finding === undefined ? EXPANDED_ROW_PX : FINDING_ROW_PX[finding.ruleId];
}

/** Index of the row holding seq, or −1. */
export function spineRowIndexForSeq(rows: readonly SpineRow[], session: TraceSession, seq: number): number {
  let lo = 0;
  let hi = session.steps.length - 1;
  let si = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((session.steps[mid]?.firstSeq ?? Number.POSITIVE_INFINITY) <= seq) {
      si = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const target = session.steps[si];
  if (target === undefined) return -1;
  const exact = rows.findIndex((r) => r.t === "step" && r.step === si);
  if (exact >= 0) return exact;
  const group = rows.findIndex((r) => (r.t === "noise" || r.t === "elided") && r.steps.includes(si));
  if (group >= 0) return group;
  for (let j = rows.length - 1; j >= 0; j -= 1) {
    const row = rows[j];
    if (row?.t === "chapter" && session.chapters[row.chapter]?.stepIds.includes(target.id)) return j;
  }
  return -1;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/spine-rows.test.ts src/layout/spine-rows.property.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Root checks**

```bash
pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint
```

Expected: each exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/trace-viewer/src/layout/spine-rows.ts packages/trace-viewer/src/layout/spine-rows.test.ts packages/trace-viewer/src/layout/spine-rows.property.test.ts
git commit -m "feat(trace-viewer): keyed spine rows with noise groups, elision and separators"
```

### Task C1-15: Sources (`createStaticBundleSource` with drip, `parseTraceBundle`, `readAllTraceRows`, errors, barrels)

**Files:**
- Create: `packages/trace-viewer/src/sources/errors.ts`
- Create: `packages/trace-viewer/src/sources/static-bundle.ts`
- Test: `packages/trace-viewer/src/sources/static-bundle.test.ts`
- Create: `packages/trace-viewer/src/sources/read-all.ts`
- Test: `packages/trace-viewer/src/sources/read-all.test.ts`
- Create: `packages/trace-viewer/src/sources/index.ts`
- Modify: `packages/trace-viewer/src/index.ts`

**Interfaces:**
- Consumes: W0 `type TraceSource`, `type TraceRowsRequest` from `../source.js` (UI index §1.2b session-bound port); `TraceBundleSchema`, `TRACE_BUNDLE_FORMAT`, `TRACE_BUNDLE_VERSION`, `TRACE_ROWS_PAGE_DEFAULT`, `TRACE_PAYLOADS_MAX`, `type TraceBundle`, `type TraceRow`, `type TraceRowsPage`, `type TraceSessionSummary` from `@jevcode/contracts`.
- Produces (UI index §2.4 verbatim, with deviation 8 for `lastSeq`):

```ts
// sources/errors.ts
export type TraceChannel = "trace:listSessions" | "trace:rows" | "trace:payloads" | "bundle";
export type TraceSourceErrorCode = "UNKNOWN_SESSION" | "NOT_A_TRACE" | "UNSUPPORTED_VERSION" | "SOURCE_FAILED";
export class TraceSourceError extends Error { readonly channel: TraceChannel; readonly code: TraceSourceErrorCode; constructor(channel: TraceChannel, code: TraceSourceErrorCode, message: string) }
// sources/static-bundle.ts
export type ParsedBundle = { ok: true; bundle: TraceBundle } | { ok: false; code: "NOT_A_TRACE" | "UNSUPPORTED_VERSION"; message: string };
export function parseTraceBundle(json: unknown): ParsedBundle;
export interface DripOptions { rowsPerTick: number; intervalMs: number; manual?: boolean; startAtSeq?: number }
export interface StaticBundleSource extends TraceSource { released(): number; tick(): void; dispose(): void }
export function createStaticBundleSource(bundle: TraceBundle, options?: { drip?: DripOptions }): StaticBundleSource;
// sources/read-all.ts
export interface LoadedTrace { summary: TraceSessionSummary; rows: TraceRow[]; lastPage: TraceRowsPage }
export function readAllTraceRows(source: TraceSource, options?: { pageSize?: number }): Promise<LoadedTrace>;
// sources/index.ts (the "@jevcode/trace-viewer/sources" subpath; no React, no CSS)
export * from "./errors.js"; export * from "./static-bundle.js"; export * from "./read-all.js";
```

Drip semantics: at creation the source releases every row with `seq ≤ startAtSeq` (default 0) plus one tick of `rowsPerTick`; each `tick()` (or each `intervalMs` unless `manual`) releases `rowsPerTick` more. `rows()` pages only released rows; `state` is `"running"` and `endedAt` is `null` until the last row is released, then the bundle's; `now()` is the source time (payload `ts`) of the last released `agent_event` or `evidence_fact` row, because other rows carry pipeline processing times (spec §6.5), else `Date.parse(session.startedAt)`.

- [ ] **Step 1: Write the failing tests**

`packages/trace-viewer/src/sources/static-bundle.test.ts`:

```ts
import type { TraceBundle } from "@jevcode/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TraceSourceError } from "./errors.js";
import { createStaticBundleSource, parseTraceBundle } from "./static-bundle.js";

const T0 = Date.parse("2026-09-18T09:00:00.000Z");
const iso = (ms: number) => new Date(T0 + ms).toISOString();

function bundle(): TraceBundle {
  const agent = (seq: number, ms: number) => ({ seq, type: "agent_event", ts: iso(ms + 999_000), payload: { type: "agent_message", sessionId: "s1", ts: iso(ms), role: "assistant", text: `m${seq}` } });
  return {
    format: "jevcode.trace",
    version: 1,
    exportedAt: iso(100_000),
    redactionCount: 0,
    session: { sessionId: "s1", repoId: "r1", repoName: "acme", prompt: "go", state: "completed", startedAt: iso(0), endedAt: iso(9_000), lastEventSeq: 9 },
    rows: [
      agent(1, 1_000),
      agent(2, 2_000),
      agent(3, 3_000),
      { seq: 4, type: "change_unit", ts: iso(5_000_000), payload: { id: "u1" } },
      agent(5, 5_000),
      agent(7, 7_000),
    ],
  };
}

afterEach(() => { vi.useRealTimers(); });

describe("parseTraceBundle", () => {
  it("accepts a v1 bundle", () => {
    const parsed = parseTraceBundle(JSON.parse(JSON.stringify(bundle())));
    expect(parsed.ok).toBe(true);
  });

  it("names a wrong file and an unsupported version", () => {
    expect(parseTraceBundle({})).toEqual({ ok: false, code: "NOT_A_TRACE", message: "Not a jevcode trace" });
    expect(parseTraceBundle("garbage")).toEqual({ ok: false, code: "NOT_A_TRACE", message: "Not a jevcode trace" });
    expect(parseTraceBundle({ ...bundle(), version: 2 })).toEqual({ ok: false, code: "UNSUPPORTED_VERSION", message: "Trace format v2 is not supported" });
    expect(parseTraceBundle({ ...bundle(), rows: "nope" })).toMatchObject({ ok: false, code: "NOT_A_TRACE" });
  });
});

describe("createStaticBundleSource", () => {
  it("serves every row without drip, with lastSeq from the session (filtered rows count)", async () => {
    const source = createStaticBundleSource(bundle());
    expect(source.sessionId).toBe("s1");
    const page = await source.rows();
    expect(page.rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 7]);
    expect(page).toMatchObject({ nextAfterSeq: null, lastSeq: 9, state: "completed" });
    expect(await source.summary()).toMatchObject({ lastEventSeq: 9, state: "completed", endedAt: iso(9_000) });
  });

  it("pages with afterSeq and limit", async () => {
    const source = createStaticBundleSource(bundle());
    const first = await source.rows({ afterSeq: 0, limit: 4 });
    expect(first.rows.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(first.nextAfterSeq).toBe(4);
    const second = await source.rows({ afterSeq: 4, limit: 4 });
    expect(second.rows.map((r) => r.seq)).toEqual([5, 7]);
    expect(second.nextAfterSeq).toBeNull();
  });

  it("drip releases rows and reports running until the last row", async () => {
    const source = createStaticBundleSource(bundle(), { drip: { rowsPerTick: 2, intervalMs: 100, manual: true } });
    let page = await source.rows();
    expect(page.rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(page).toMatchObject({ lastSeq: 2, state: "running" });
    expect(await source.summary()).toMatchObject({ state: "running", endedAt: null, lastEventSeq: 2 });
    expect(source.now()).toBe(T0 + 2_000);
    source.tick();
    page = await source.rows({ afterSeq: 2 });
    expect(page.rows.map((r) => r.seq)).toEqual([3, 4]);
    expect(source.now()).toBe(T0 + 3_000);
    source.tick();
    page = await source.rows({ afterSeq: 4 });
    expect(page).toMatchObject({ lastSeq: 9, state: "completed" });
    expect(source.released()).toBe(6);
    expect(source.now()).toBe(T0 + 7_000);
  });

  it("startAtSeq releases the history first", () => {
    const source = createStaticBundleSource(bundle(), { drip: { rowsPerTick: 1, intervalMs: 100, manual: true, startAtSeq: 3 } });
    expect(source.released()).toBe(4);
  });

  it("an interval drip advances on its own and stops on dispose", () => {
    vi.useFakeTimers();
    const source = createStaticBundleSource(bundle(), { drip: { rowsPerTick: 2, intervalMs: 100 } });
    expect(source.released()).toBe(2);
    vi.advanceTimersByTime(100);
    expect(source.released()).toBe(4);
    source.dispose();
    vi.advanceTimersByTime(1_000);
    expect(source.released()).toBe(4);
  });

  it("payloads returns released rows only and bounds the request", async () => {
    const source = createStaticBundleSource(bundle(), { drip: { rowsPerTick: 2, intervalMs: 100, manual: true } });
    expect((await source.payloads([1, 3, 99])).map((r) => r.seq)).toEqual([1]);
    await expect(source.payloads(Array.from({ length: 51 }, (_, i) => i + 1))).rejects.toBeInstanceOf(TraceSourceError);
    await expect(source.payloads(Array.from({ length: 51 }, (_, i) => i + 1))).rejects.toMatchObject({ channel: "bundle", code: "SOURCE_FAILED" });
  });
});
```

`packages/trace-viewer/src/sources/read-all.test.ts`:

```ts
import type { TraceBundle } from "@jevcode/contracts";
import { describe, expect, it } from "vitest";

import { TraceSourceError } from "./errors.js";
import { readAllTraceRows } from "./read-all.js";
import { createStaticBundleSource } from "./static-bundle.js";

const rows = Array.from({ length: 7 }, (_, i) => ({ seq: i + 1, type: "agent_event", ts: "2026-09-18T09:00:00.000Z", payload: {} }));
const bundle: TraceBundle = {
  format: "jevcode.trace", version: 1, exportedAt: "2026-09-18T10:00:00.000Z", redactionCount: 0,
  session: { sessionId: "s1", repoId: "r1", repoName: "acme", prompt: "go", state: "completed", startedAt: "2026-09-18T09:00:00.000Z", endedAt: null, lastEventSeq: 7 },
  rows,
};

describe("readAllTraceRows", () => {
  it("pages until nextAfterSeq is null and returns every row once", async () => {
    const loaded = await readAllTraceRows(createStaticBundleSource(bundle), { pageSize: 3 });
    expect(loaded.rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(loaded.summary.sessionId).toBe("s1");
    expect(loaded.lastPage).toMatchObject({ nextAfterSeq: null, lastSeq: 7 });
  });

  it("reads only released rows of a drip source", async () => {
    const source = createStaticBundleSource(bundle, { drip: { rowsPerTick: 3, intervalMs: 1_000, manual: true } });
    const loaded = await readAllTraceRows(source, { pageSize: 2 });
    expect(loaded.rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(loaded.lastPage.state).toBe("running");
  });

  it("fails loudly on a cursor that does not advance", async () => {
    const stuck = {
      sessionId: "s1",
      summary: async () => bundle.session,
      rows: async () => ({ rows: [], nextAfterSeq: 0, lastSeq: 7, state: "running" as const }),
      payloads: async () => [],
      now: () => 0,
    };
    await expect(readAllTraceRows(stuck)).rejects.toBeInstanceOf(TraceSourceError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/sources`
Expected: FAIL, `Failed to resolve import "./errors.js"`.

- [ ] **Step 3: Write the implementation**

`packages/trace-viewer/src/sources/errors.ts`:

```ts
export type TraceChannel = "trace:listSessions" | "trace:rows" | "trace:payloads" | "bundle";
export type TraceSourceErrorCode = "UNKNOWN_SESSION" | "NOT_A_TRACE" | "UNSUPPORTED_VERSION" | "SOURCE_FAILED";

export class TraceSourceError extends Error {
  readonly channel: TraceChannel;
  readonly code: TraceSourceErrorCode;

  constructor(channel: TraceChannel, code: TraceSourceErrorCode, message: string) {
    super(message);
    this.name = "TraceSourceError";
    this.channel = channel;
    this.code = code;
  }
}
```

`packages/trace-viewer/src/sources/static-bundle.ts`:

```ts
import {
  TRACE_BUNDLE_FORMAT, TRACE_BUNDLE_VERSION, TRACE_PAYLOADS_MAX, TRACE_ROWS_PAGE_DEFAULT, TraceBundleSchema,
  type TraceBundle, type TraceRow, type TraceRowsPage, type TraceSessionSummary,
} from "@jevcode/contracts";

import type { TraceRowsRequest, TraceSource } from "../source.js";
import { TraceSourceError } from "./errors.js";

export type ParsedBundle =
  | { ok: true; bundle: TraceBundle }
  | { ok: false; code: "NOT_A_TRACE" | "UNSUPPORTED_VERSION"; message: string };

const NOT_A_TRACE: ParsedBundle = { ok: false, code: "NOT_A_TRACE", message: "Not a jevcode trace" };

export function parseTraceBundle(json: unknown): ParsedBundle {
  if (json === null || typeof json !== "object") return NOT_A_TRACE;
  const record = json as { format?: unknown; version?: unknown };
  if (record.format !== TRACE_BUNDLE_FORMAT) return NOT_A_TRACE;
  if (record.version !== TRACE_BUNDLE_VERSION) {
    return { ok: false, code: "UNSUPPORTED_VERSION", message: `Trace format v${String(record.version)} is not supported` };
  }
  const parsed = TraceBundleSchema.safeParse(json);
  return parsed.success ? { ok: true, bundle: parsed.data } : NOT_A_TRACE;
}

export interface DripOptions { rowsPerTick: number; intervalMs: number; manual?: boolean; startAtSeq?: number }

export interface StaticBundleSource extends TraceSource {
  /** Rows released so far (all rows without drip). */
  released(): number;
  /** Releases rowsPerTick more rows now (manual drip and tests). */
  tick(): void;
  dispose(): void;
}

const CLOCK_ROW_TYPES: ReadonlySet<string> = new Set(["agent_event", "evidence_fact"]);

function sourceTimeMs(row: TraceRow): number | null {
  if (!CLOCK_ROW_TYPES.has(row.type)) return null;
  const payload = row.payload;
  const ts = payload !== null && typeof payload === "object" ? (payload as { ts?: unknown }).ts : undefined;
  const ms = typeof ts === "string" ? Date.parse(ts) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** First index with rows[i].seq > seq. */
function firstAfter(rows: readonly TraceRow[], seq: number, limit: number): number {
  let lo = 0;
  let hi = limit;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((rows[mid]?.seq ?? Number.POSITIVE_INFINITY) <= seq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** rows() returns only released rows; state "running" until the last row, then bundle.session.state; now() = the last released row's source time. */
export function createStaticBundleSource(bundle: TraceBundle, options: { drip?: DripOptions } = {}): StaticBundleSource {
  const rows = [...bundle.rows].sort((a, b) => a.seq - b.seq);
  const drip = options.drip;
  const perTick = Math.max(1, drip?.rowsPerTick ?? rows.length);
  let released = rows.length;
  if (drip !== undefined) released = Math.min(rows.length, firstAfter(rows, drip.startAtSeq ?? 0, rows.length) + perTick);
  const startedAtMs = Date.parse(bundle.session.startedAt);
  let timer: ReturnType<typeof setInterval> | null = null;

  const done = (): boolean => released >= rows.length;
  const lastReleasedSeq = (): number => rows[released - 1]?.seq ?? 0;
  const lastSeq = (): number => (done() ? Math.max(bundle.session.lastEventSeq, lastReleasedSeq()) : lastReleasedSeq());
  const state = (): TraceSessionSummary["state"] => (done() ? bundle.session.state : "running");
  const stop = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const tick = (): void => {
    released = Math.min(rows.length, released + perTick);
    if (done()) stop();
  };
  if (drip !== undefined && drip.manual !== true && !done()) timer = setInterval(tick, Math.max(1, drip.intervalMs));

  return {
    sessionId: bundle.session.sessionId,
    async summary() {
      return { ...bundle.session, state: state(), endedAt: done() ? bundle.session.endedAt : null, lastEventSeq: lastSeq() };
    },
    async rows(request: TraceRowsRequest = {}): Promise<TraceRowsPage> {
      const limit = Math.max(1, request.limit ?? TRACE_ROWS_PAGE_DEFAULT);
      const start = firstAfter(rows, request.afterSeq ?? 0, released);
      const page = rows.slice(start, Math.min(released, start + limit));
      const last = page[page.length - 1];
      return { rows: page, nextAfterSeq: page.length === limit && last !== undefined ? last.seq : null, lastSeq: lastSeq(), state: state() };
    },
    async payloads(seqs: readonly number[]): Promise<TraceRow[]> {
      if (seqs.length > TRACE_PAYLOADS_MAX) {
        throw new TraceSourceError("bundle", "SOURCE_FAILED", `at most ${TRACE_PAYLOADS_MAX} seqs per payloads request`);
      }
      const wanted = new Set(seqs);
      return rows.slice(0, released).filter((row) => wanted.has(row.seq));
    },
    now(): number {
      for (let i = released - 1; i >= 0; i -= 1) {
        const row = rows[i];
        const ms = row === undefined ? null : sourceTimeMs(row);
        if (ms !== null) return ms;
      }
      return startedAtMs;
    },
    released: () => released,
    tick,
    dispose: stop,
  };
}
```

`packages/trace-viewer/src/sources/read-all.ts`:

```ts
import type { TraceRow, TraceRowsPage, TraceSessionSummary } from "@jevcode/contracts";

import type { TraceSource } from "../source.js";
import { TraceSourceError } from "./errors.js";

export interface LoadedTrace { summary: TraceSessionSummary; rows: TraceRow[]; lastPage: TraceRowsPage }

/** summary(), then rows() from afterSeq 0 until nextAfterSeq is null. */
export async function readAllTraceRows(source: TraceSource, options: { pageSize?: number } = {}): Promise<LoadedTrace> {
  const summary = await source.summary();
  const rows: TraceRow[] = [];
  let afterSeq = 0;
  for (;;) {
    const page = await source.rows(options.pageSize === undefined ? { afterSeq } : { afterSeq, limit: options.pageSize });
    for (const row of page.rows) rows.push(row);
    if (page.nextAfterSeq === null) return { summary, rows, lastPage: page };
    if (page.nextAfterSeq <= afterSeq) {
      throw new TraceSourceError("trace:rows", "SOURCE_FAILED", `rows cursor did not advance past ${afterSeq}`);
    }
    afterSeq = page.nextAfterSeq;
  }
}
```

`packages/trace-viewer/src/sources/index.ts`:

```ts
export * from "./errors.js";
export * from "./static-bundle.js";
export * from "./read-all.js";
```

Modify `packages/trace-viewer/src/index.ts`. Current content:

```ts
export * from "./source.js";
export * from "./layout/viewport.js";
export { createViewportController, SETTLE_MS, type ViewportController, type ViewportControllerOptions, type FramePhase } from "./ui/viewport/controller.js";
export { ViewerLocationSchema, decodeLocation, locationFromHash, locationToHash, type ViewerLocation } from "./ui/state/location.js";
```

Append:

```ts
export * from "./sources/index.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/sources`
Expected: PASS, 2 files, 11 tests.

- [ ] **Step 5: Check the subpath export and browser safety**

Run: `pnpm --filter @jevcode/trace-viewer build && pnpm --filter @jevcode/trace-viewer exec node --input-type=module -e "import('@jevcode/trace-viewer/sources').then((m) => console.log(Object.keys(m).sort().join(',')))"`
Expected: `TraceSourceError,createStaticBundleSource,parseTraceBundle,readAllTraceRows` (the package resolves its own `./sources` export; no React or CSS loads).

Run: `pnpm --filter jevcode-trace-viewer-dev build && pnpm --filter jevcode-trace-viewer-dev exec vite build --config vite.spike.config.ts`
Expected: both exit 0. The spike page imports the root barrel, so the Node-builtin guard walks every module this lane exports (viewport, controller, location, sources); W0's `main.tsx` imports only the contracts and model barrels.

- [ ] **Step 6: Root checks**

```bash
pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint
```

Expected: each exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/trace-viewer/src/sources/errors.ts packages/trace-viewer/src/sources/static-bundle.ts packages/trace-viewer/src/sources/static-bundle.test.ts packages/trace-viewer/src/sources/read-all.ts packages/trace-viewer/src/sources/read-all.test.ts packages/trace-viewer/src/sources/index.ts packages/trace-viewer/src/index.ts
git commit -m "feat(trace-viewer): static bundle source with drip and paged reader"
```

**Lane C1b completion.** After A1, A2, B and C1a merge: `git rebase main`, `pnpm install --frozen-lockfile && pnpm -r build`, rerun the root checks (a C1b test that breaks on B's real exports is a C1b bug), confirm `docs/spikes/trace-viewer-spike.md` has a ruling for all seven risks (and C1-7F merged when risk 1 failed), then merge. Hand-off notes for C2: the rulings for risks 4 and 5, the overview bench means, and the four additive deviations (3, 4, 5, 9) that C2 and C3 code against.
