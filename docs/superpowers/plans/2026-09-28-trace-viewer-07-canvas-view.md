# Trace Viewer Lane C3: Canvas Layout and Canvas View (M4b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This file holds two lanes: **Part A = lane C3a** (wave W2, tasks C3-1 to C3-4) and **Part B = lane C3b** (wave W3, tasks C3-5 to C3-12). Each part runs under its own controller in its own worktree.

**Goal:** Build the Canvas view of the trace viewer: the pure, sticky canvas layout (levels, time-binned columns, story and work bands, noise stacks, edge routes with the red `≠` connector, minimap model) with fast-check invariants P1–P10 and the spec §7.5 oauth table, then the React Canvas view (world, frames, edges, screen-space overlay, minimap, floating toolbar, semantic levels Session/Chapter/Step), its camera rules, and the `<Activity>` view switch on `1`/`2`, closing milestone M4b.

**Architecture:** `packages/trace-viewer/src/layout/canvas-*.ts` are pure, React-free and DOM-free (R19): `layoutCanvas(session, index, scale, level, prev?)` places frames on columns over the shared `TimeScale` and returns a serializable `CanvasLayout` whose opaque `state` is passed back as `prev`, so a placed frame never moves. `src/ui/views/canvas/*` renders that layout in one hand-rolled DOM viewport (R17): one CSS-transformed world `div` of `role="group"` frames over one edge `<svg>`, a screen-space overlay positioned by three custom properties (`--tv-tx`, `--tv-ty`, `--tv-k`) that the viewport controller writes once per frame, and an SVG minimap. The view registers a `ViewPort` with the shell and stays mounted under React 19.2 `<Activity>`.

**Tech Stack:** TypeScript 5.9 (NodeNext, strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `noUnusedLocals`), React 19.2.3 (`<Activity>`, `useSyncExternalStore`), CSS Modules on `--tv-*` tokens, vitest 3.2 (`vitest bench`), jsdom 30.1.0, `@testing-library/react` 16.3.3, `@testing-library/user-event` 14.6.7, fast-check 4.10.1, Vite 5.4.21 dev host, Electron 33 (spike harness only).

**Spec:** `docs/superpowers/specs/2026-09-28-trace-viewer-design.md` §7.3, §7.5 (Canvas layout), §7.8 (switch contract), §7.10–§7.13, §10, §11 (M4b), §12 (M4b exit), §16 (spike risks 2, 3, 6, 7). Interface contracts: `docs/superpowers/plans/2026-09-28-trace-viewer-interfaces-ui.md` (UI index: §2.1 `layout/canvas-*.ts`, §2.3, §2.4, §3 C3a/C3b, §4, §5) and `docs/superpowers/plans/2026-09-28-trace-viewer-interfaces.md` (base index: §2.3 model types, §2.6 model API, §5 gotchas). Binding record: `local decision scratchpad (not committed)` (R13–R29). On any conflict: decision record, then spec, then base index, then UI index, then this file. Visual target: `docs/superpowers/specs/2026-09-28-trace-viewer-mockups/canvas.html` and `canvas-1440.png`.

## Global Constraints

Copied from the decision record, the spec and the UI index Global Constraints. Every task's requirements include this section.

- Everything in the base index's Global Constraints applies unchanged (Node ≥ 22, zod 3 in `@jevcode/trace-viewer`, no SQL migration, the viewer never writes, stable ids per R9, commits, worktrees, zsh `${var}:suffix`).
- R17: "`packages/trace-viewer` takes **no** `@xyflow/react` dependency. Both views use one hand-rolled DOM viewport". Canvas: "One CSS-transformed world `div` holds React frames (`role="group"`, `aria-label`, roving tabindex, DOM order = time order). One edge `<svg>` sits beneath the frames; the red connector has an 8 px transparent hit twin. Labels, selection handles and the time chip live in a screen-space overlay. v1 never culls frames at any count". "Focus uses `el.focus({preventScroll: true})`, and an `onScroll` guard resets any browser scroll of the `overflow: hidden` viewport."
- R19: `layout` imports `model`, never the reverse; `ui` imports `layout` and `model`; `layout` never imports `ui`, React, the DOM or timers (ESLint enforces it). `src/layout/**` may not use `window`, `document`, `requestAnimationFrame`, `ResizeObserver`, `performance`, `setTimeout` or `Date`.
- R15/D8: "CSS Modules consuming `var(--tv-*)` only; tokens are inline custom properties on the Shell root; light only; no global CSS except `:global(.d2h-*)` rules nested under one Inspector class". "12 px minimum text; no ALL-CAPS and no eyebrow labels; `tabular-nums` on every number." Mono only for paths, commands and code.
- D8/R24 color: "accent `#2F6BFF` = selection, focus, playhead, brush, one primary action; `#E5484D` = real problems only (failed test or check, agent failure, critical finding, guardrail hit) and every red mark also differs in shape or carries a word; `#2E9E6A` = tiny pass marks only, never text; diffs neutral". "no per-kind colors; no dimming after the playhead or outside the brush in v1."
- "`--tv-ink-4` (`#9AA0AB`) is decoration only; no CSS Module may use `var(--tv-ink-4)` in a `color` declaration (enforced by `tokens.test.ts`, C1-1)."
- "Agent-written text renders only as React text nodes." No `dangerouslySetInnerHTML` in this lane.
- "Every region (Outline, `main`, Inspector) is one tab stop with a roving tabindex. `prefers-reduced-motion` sets every duration to 0, including view-switch and level-switch animations."
- R16/R22: "any camera gesture, drag, `,`/`.`, zoom key or non-tail selection switches to Review"; Canvas in Live "Pans x only, over 180 ms, when the frontier column leaves the view"; in Review it "Never moves; the frame nearest the center stays anchored; an 'N frames →' badge"; "applies wait for a gesture to end".
- R20 switch contract: "everything but cameras carries; only user gestures write the brush; restore exactly if syncedRev === focusRev else animate 180 ms (0 under reduced motion)"; "`ResizeObserver` ignores width 0"; "no 0 × 0 fit".
- "The viewer reads only through `TraceSource` and writes nothing."
- "No UI lane edits any `package.json` dependency block, any `exports` map, `pnpm-lock.yaml` or `eslint.config.mjs`." A task that finds a missing dependency stops and escalates.
- Tests: "`layout/*.property.test.ts` ... use fast-check; component tests start with `// @vitest-environment jsdom`, stub their own `getBoundingClientRect` and `ResizeObserver` per test, and install no global fakes". "Expected values come from the spec's tables and the fixtures' known content (oauth's failed `pnpm test` 14/1/0, the claim at +0:43), never from the implementation."
- Budgets (R26, spec §10): "`layoutCanvas` fresh ≤ 2 ms and sticky ≤ 0.5 ms (benchmark); canvas pinch at Step level ≤ 5% frames dropped in Electron 33 (M4b); view switch restored in the toggle's frame, never a 0 × 0 fit (M4b)"; anchor drift ≤ 1 px (smoke).
- Commits: one conventional commit per task (`feat(trace-viewer): …`, `test(trace-viewer): …`, `docs(trace-viewer): …`, `chore(trace-viewer-dev): …`), listing the task's files explicitly in `git add`. "Never add a `Claude-Session:` trailer. Never run `git stash`; set work aside with a WIP commit."

## Review Focus

Five inputs a happy-path test would miss, most likely first. Each has its test in the owning task.

1. **A live append while the reader is in Review, scrolled away, maybe mid-gesture.** Expected: every placed frame keeps its world rect, the camera does not move, DOM focus stays, an "N frames →" badge appears; in Live only x pans, and only when the frontier column leaves the view. Tests: **C3-2** `canvas-layout.test.ts` "keeps every placed key's slot under a one-row drip of oauth"; **C3-10** `canvas-view.test.tsx` "an append leaves every placed frame's rect unchanged", "in Live the camera pans x only when the frontier column leaves the view", "in Review it never moves and shows N frames → for frames past the right edge".
2. **A re-cluster renames or merges units** (`unit:u1` becomes `unit:u2` with the same anchor seq; two units merge; a chapter flips to noise and back). Expected: the frame keeps its key and rect and its `selId` follows; a vacated slot becomes a hole that only Tidy removes. Tests: **C3-2** "a unit whose id changes keeps its key, rect and selection", "a chapter that becomes noise renders in its own slot", "a noise item that becomes a chapter lands at the bottom of its column"; property **P6** in `canvas-layout.property.test.ts`.
3. **The Canvas hidden under `<Activity>` at width 0, then shown.** Expected: `ResizeObserver` width 0 is ignored, no fit ever runs against a 0 × 0 rect, the hidden view holds no wheel listener and runs no rAF, and a switch back with `syncedRev === focusRev` restores the camera exactly. Tests: **C3-11** `view-switch.test.tsx` "never fits a 0x0 rect", "a hidden view holds no listeners and schedules no animation frames", "1, 2, 1 leaves every non-camera field unchanged and restores the canvas camera exactly".
4. **A session with idle gaps, several turns and no chapters** (pre-M1, steer after 14 minutes, a 5-minute test run, loose failing steps). Expected: one turn separator labelled "Turn 2 · steer · after 14 min"; no break for a long-running command; loose frames carry every warning-or-worse step that has no chapter. Tests: **C3-1** `canvas-items.test.ts` "makes a warning finding step with no chapter a loose item"; **C3-2** "a steer after 14 idle minutes yields one separator labelled with turn and idle time", "a 5-minute test command alone makes no break", "lays out a session with no chapters from story and loose frames".
5. **Hostile agent text in a frame**: a claim holding `<img src=x onerror=alert(1)>`, a U+202E override, and a `claimSpan` that runs past the text. Expected: rendered as text, no `img` element, the underline covers exactly `text.slice(...span)` and is dropped when the span is out of range. Test: **C3-6** `frame.test.tsx` "claim text with markup renders as text and an out-of-range span draws no underline".

## Interface deviations

Each is a genuine gap or defect in the UI index; nothing here renames or removes a section 2 name.

1. **One lane file for C3a and C3b.** UI index §0 names `07a-canvas-layout.md` and `07b-canvas-view.md`. This file holds both as Part A and Part B with the index's branches, worktrees and waves unchanged.
2. **`CanvasFrame.memberSelIds: readonly SelectionId[]`** (added, parallel to `members`). Routes, the reading order and `frameForSelection` need every stack member's selection id; `members` holds item keys.
3. **`CanvasLayout.junctions: readonly Point[]`** (added). `routeEdges` returns junctions and the view draws them; the index's `CanvasLayout` had nowhere to keep them.
4. **`MinimapModel.origin: Point`** (added). `minimapToWorld(model, point)` needs the world point that the minimap's (0, 0) shows.
5. **`buildMinimap` takes `Pick<CanvasLayout, "bounds" | "frames" | "edges" | "separators">`.** Wider than `CanvasLayout`; every existing call still type-checks.
6. **Late rule.** An item is late when `start < lastBreakpoint.t` (spec: `start < front.t0`). This is a superset of the spec rule that keeps breakpoints sorted by `t` in sticky runs; a fresh layout never has a late item, so the oauth table and P5 are unaffected.
7. **Item turn.** Every item's `turn` is the index of the last turn whose `tMs ≤ start` (spec leaves a chapter's turn open). Turns are then non-decreasing in `start`, which is what P4 needs.
8. **Break detection** runs only when at least `breakMinMs` of real time separates the last breakpoint from the item, and keeps only `scale.breaks()` segments with `u1 > u(lastBp)` and `u0 < u(start)`, so an idle segment that merely touches the previous item's start, or two story items a second apart inside one long wait, never open a separator. P4 checks the same predicate.
9. **Noise stack frames are keyed `stack:<first member key>`**; `members` lists the live member keys. P6 compares frame keys.
10. **Property scopes.** P4 and P10 are asserted on fresh layouts (a sticky kind flip keeps its old slot size by design); P3 exempts frames whose start precedes column 0's `t0`, and reads `xAt` at a push as the jump interval [first `xIn`, last `xOut`] at that time (items sharing one start can open several columns, which a single-valued `xAt` cannot place inside every column); P9's crossing check exempts `shape: "direct"` contradicts fallbacks, which spec §7.5 draws above the frames.
11. **`src/test-support/canvas-arbitraries.ts` is created in C3-1** (its session builder feeds C3-1's tests) and extended in C3-2 (index: C3-2 creates it). The index's C1-8 `SessionSeed` has no fixed shape, so this lane builds sessions with its own `buildCanvasSession`.
12. **C3-2 creates `layout/canvas-routes.ts` with the edge types only**; C3-3 adds the functions. `CanvasLayout.edges` needs `CanvasEdge` in C3-2.
13. **New files:** `src/test-support/canvas-view-harness.tsx` (C3-10); `src/ui/views/canvas/spike-rulings.ts` (C3-5; holds `CANVAS_SETTLE_ROUND_K`, `INV_K_EVERY_FRAME`, `CULL_FRAMES`, replacing the index's risk-3 edit of `controller.ts`, which already takes `settleRoundK`, and the risk-7 constant in `World.tsx`); `src/ui/views/canvas/CanvasRuler.tsx` (C3-10); `apps/trace-viewer-dev/src/selftest-canvas.ts` (C3-12). C3-12 may also touch `apps/trace-viewer-dev/src/main.tsx` (see that task).
14. **C3-6's label expectation** is `"OAuth account-linking test failure, 1 failed, 14 passed, +0:33"`. The index's `"Linking test, …"` is the mockup's shortened name; the model's chapter title is the unit title in `fixtures/oauth/expected_units.json`.
15. **Test placement.** C3-9 pins the pure `brushForWindow` (steps inside the window; an empty window gives `null`); "a settled user pan writes `brush/set`" and "a programmatic move never writes the brush" are asserted in C3-10's `canvas-view.test.tsx`, where the controller callbacks live. The roving-tabindex and DOM-order test moves from C3-6 to C3-7 (`World` owns roving); `will-change` is a `World` prop that `CanvasView` toggles.
16. **Assumed C2 behavior the UI index does not fix:** C2-9's `Ruler` takes `{ map: XMap; scale: TimeScale; widthPx: number; playheadT: number | null; band: readonly [number, number] | null; problemTs: readonly number[]; hatchFromT: number | null }` (only `CanvasRuler.tsx` touches it; C3-10 Step 1 checks it); C2-8 maps hold-Space to `tool/set` hand, so `isHandTool()` reads `state.tool`. The toolbar renders its own level radiogroup because the index gives `LevelControl` no props.
17. **A contradicts edge with no free lane gets `shape: "direct"` and `d = directPath(...)` in the layout** (index comment: "`d` null when no lane is free"), so "drawn even when its route is channel" holds in the layout itself. `decides`/`validates` edges without a lane keep `d: null`.
18. **Cards fill their card rect** (fixed height, content clamped), so every edge port lies on a drawn card edge.
19. **A level switch lays out fresh** (spec §7.5) rather than with that level's own `prev` (ui-canvas-layout §7).

**Pre-check of this plan (2026-09-28).** Every pure module, `canvas-camera.ts`, every UI component and every test in this file was extracted with its edit steps applied (all anchors matched), type-checked under the repo's strict compiler options, and run under vitest 3.2.7 + jsdom 30.1.0 against stand-ins written from UI index §2 for the C1/C2 modules and an oauth-shaped builder session: 105 of 111 tests passed; the 6 others need B's real oauth fold or C2's `TraceViewer` and could not run there. P1–P10 passed 2,000 fast-check runs each. `canvas-layout.bench.ts` measured fresh 0.40 ms and sticky 0.34 ms with a binary-search `TimeScale` stand-in. The pre-check found and fixed three defects now reflected below: P3 at multi-column pushes, fractional column x breaking P1's gap, and `new URL(…, import.meta.url)` under jsdom.

## Controller hand-offs from W1 (binding)

- **C1a lane review M-1 (elapsedMs):** running `DurationBar`s only grow when the caller passes `elapsedMs`. A canvas frame or step-list row that renders a `duration` graphic for a running step passes `elapsedMs = nowMs - step.startMs` to `Graphic` (`nowMs` from the source's `now()` on the live tick).
- **C1a text sanitization:** the graphics sanitize their own mono text with `displayUntrusted` (idempotent), so frames need not pre-sanitize graphic inputs.

## Required W0 amendments

None. This lane uses only packages present after W0 with the UI index §1.1 amendments: `react`/`react-dom` 19.2.3, `fast-check` 4.10.1, `jsdom` 30.1.0, `@testing-library/react`, `@testing-library/user-event`, `@jevcode/semantic-core` (dev, through B's `fixture-rows.ts`). It needs the UI index §1.1(d) `src/layout/**` ESLint block and the §1.2(a) and §1.4 model amendments (`LEVELS`, `TraceSession.originMs`, B-10 `CHAPTER_GRAPHIC`); the prerequisites below check them.

## Lane prerequisites

### Part A (lane C3a, wave W2)

- **W1 is merged into `main`** (W0, A1, A2, B, C1a, C1b). From anywhere:

```bash
git -C ~/Projects/jevcode show main:packages/trace-viewer/src/model/types.ts | grep -cE "export const LEVELS|validationStepIds: StepId\[\]|claimSpan\?: \[number, number\]|originMs: number"
git -C ~/Projects/jevcode show main:packages/trace-viewer/src/layout/time-scale.ts | grep -cE "export function buildTimeScale|export function timeScaleInputOf"
git -C ~/Projects/jevcode show main:packages/trace-viewer/src/layout/trace-index.ts | grep -cE "export function buildTraceIndex|chapterKey"
git -C ~/Projects/jevcode show main:packages/trace-viewer/src/layout/tone.ts | grep -c "export function worstSeverity"
git -C ~/Projects/jevcode show main:packages/trace-viewer/src/layout/viewport.ts | grep -c "export interface Rect"
git -C ~/Projects/jevcode show main:packages/trace-viewer/src/test-support/fixture-rows.ts | grep -c "export function loadFixtureTrace"
git -C ~/Projects/jevcode show main:eslint.config.mjs | grep -c "LAYOUT_PURE_GLOBALS"
```

Expected: the first prints `4` or more; the second `2`; the third `2` or more; the next three `1`; the last `2` or more. Any lower count means a W1 lane or a UI index §1 amendment has not merged: stop and escalate.

- **Plan documents** may be untracked in the main checkout. Read them by absolute path; never commit them from this lane.
- **Worktree** (once; `<w1>` is the merge commit that closes W1):

```bash
git -C ~/Projects/jevcode worktree add -b tv/c3a-canvas-layout ~/Projects/jevcode-tv-c3a <w1>
```

- **Setup** (once; every later command runs from `~/Projects/jevcode-tv-c3a`; prefix `cd ~/Projects/jevcode-tv-c3a && ` if the shell does not keep the directory):

```bash
pnpm install --frozen-lockfile
NP=$(ls -d node_modules/.pnpm/node-pty@*/node_modules/node-pty | head -1) && mkdir -p "$NP/build/Release" && pnpm --filter jevcode-desktop rebuild:node && cp "$NP/prebuilds/$(node -p 'process.platform + "-" + process.arch')/spawn-helper" "$NP/build/Release/spawn-helper" && chmod +x "$NP/build/Release/spawn-helper"
pnpm -r build
```

Expected: the second command prints `native modules restored to node ABI`; `pnpm -r build` exits 0.

- **Baseline:** `pnpm --filter @jevcode/trace-viewer test` exits 0; `pnpm -r typecheck` exits 0; `pnpm lint` prints nothing after `> pnpm exec eslint .`.

### Part B (lane C3b, wave W3)

- **W2 is merged into `main`** (C2 = M4a, C3a, Da):

```bash
git -C ~/Projects/jevcode show main:packages/trace-viewer/src/layout/canvas-layout.ts | grep -c "export function layoutCanvas"
git -C ~/Projects/jevcode show main:packages/trace-viewer/src/ui/views/view-port.ts | grep -cE "export function useRegisterViewPort|export function createViewPortRegistry"
git -C ~/Projects/jevcode show main:packages/trace-viewer/src/ui/views/registry.ts | grep -cE "export const VIEWS|export const KEEP_HIDDEN_VIEWS_MOUNTED"
git -C ~/Projects/jevcode show main:packages/trace-viewer/src/ui/shell/session-context.ts | grep -c "export function useSessionView"
git -C ~/Projects/jevcode show main:packages/trace-viewer/src/ui/views/shared/Ruler.tsx | grep -c "export function Ruler"
git -C ~/Projects/jevcode show main:packages/trace-viewer/src/ui/inspector/finding-copy.ts | grep -c "export const FINDING_TITLE"
git -C ~/Projects/jevcode show main:docs/spikes/trace-viewer-spike.md | grep -c "M4a exit"
git -C ~/Projects/jevcode show main:apps/trace-viewer-dev/scripts/smoke.mjs | grep -c "SMOKE_OK"
```

Expected: `1`, `2`, `2`, `1`, `1`, `1`, `1` or more, `1` or more. Any `0`: stop and escalate.

- **Worktree** (`<w2>` is the merge commit that closes W2):

```bash
git -C ~/Projects/jevcode worktree add -b tv/c3b-canvas-view ~/Projects/jevcode-tv-c3b <w2>
```

- **Setup:** the Part A setup commands, run from `~/Projects/jevcode-tv-c3b`. **Baseline** as in Part A, plus `node apps/trace-viewer-dev/scripts/smoke.mjs --views hybrid` prints `SMOKE_OK` (Chrome at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` or `CHROME_PATH`; port 4179 free).

## Commands used by every task

Run from the lane's worktree root.

- Targeted tests: `pnpm --filter @jevcode/trace-viewer exec vitest run <path relative to packages/trace-viewer>`.
- Package typecheck: `pnpm --filter @jevcode/trace-viewer typecheck` (covers tests, benches and `src/test-support`).
- Root checks, in order, at the end of every task (UI index §5.2); each must exit 0: `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r --no-bail --workspace-concurrency=1 test`, `pnpm lint`. Known flakes (`file-watcher.test.ts`, `stall-watchdog.test.ts`, `codex-adapter.test.ts`) are confirmed by rerunning that package alone.
- If a storage or desktop test fails with `NODE_MODULE_VERSION`, run `pnpm --filter jevcode-desktop rebuild:node` and rerun.
- jsdom tests have no jest-dom: assert with `getAttribute`, `textContent`, roles and `style.getPropertyValue`.
- Under `// @vitest-environment jsdom`, `new URL(relative, import.meta.url)` resolves against `http://localhost:3000`, so `fileURLToPath` of it throws `ERR_INVALID_URL_SCHEME`. Build file paths with `path.dirname(fileURLToPath(import.meta.url))` instead (verified on vitest 3.2.7 + jsdom 30.1.0). Vitest runs without globals, so every jsdom test file calls `cleanup()` from `@testing-library/react` in its own `afterEach`, together with `vi.restoreAllMocks()` and `vi.unstubAllGlobals()`.

## File structure

All paths are under `packages/trace-viewer/src/` unless they start with `apps/` or `docs/`.

| File | Responsibility | Task |
|---|---|---|
| `layout/canvas-levels.ts` | Level table (spec §7.5), frame sizes, zoom-band thresholds | C3-1 |
| `layout/canvas-layout.ts` | `collectItems`; placement, sticky state, time map, `canvasXMap`; calls `routeEdges` | C3-1, C3-2, C3-3 |
| `layout/canvas-routes.ts` | Edge types (C3-2); trunk comb, contradicts, decides, validates, lanes, `homeFrameKey`, `directPath`, `samplePath` (C3-3) | C3-2, C3-3 |
| `layout/canvas-minimap.ts` | Minimap model and inverse mapping | C3-4 |
| `layout/canvas-levels.test.ts`, `canvas-items.test.ts`, `canvas-layout.test.ts`, `canvas-layout.property.test.ts`, `canvas-routes.test.ts`, `canvas-minimap.test.ts`, `canvas-layout.bench.ts` | Examples, P1–P10, benchmark | C3-1 to C3-4 |
| `test-support/canvas-arbitraries.ts` | `buildCanvasSession` (C3-1); arbitraries, prefixes, mutations, oauth sessions and bundle (C3-2); synthetic bench session (C3-4) | C3-1, C3-2, C3-4 |
| `ui/views/canvas/spike-rulings.ts` | M4b spike rulings as constants | C3-5 |
| `ui/views/canvas/canvas-camera.ts` | Pure camera rules and the camera store | C3-9 |
| `test-support/canvas-view-harness.tsx` | Providers and per-test stubs for jsdom tests | C3-10 |
| `ui/views/canvas/frame-label.ts`, `Frame.tsx`, `frame-content.tsx`, `Frame.module.css` | Frame text, icons, tone, labels, step list, frame component | C3-6 |
| `ui/views/canvas/World.tsx`, `EdgeLayer.tsx`, `Overlay.tsx`, `World.module.css` | Viewport, world layer, edges, screen-space overlay | C3-7 |
| `ui/views/canvas/Minimap.tsx`, `Toolbar.tsx`, `chrome.module.css` | Minimap panel and floating toolbar | C3-8 |
| `ui/views/canvas/CanvasView.tsx`, `canvas-port.ts`, `CanvasRuler.tsx`, `CanvasView.module.css` | Composition, controller wiring, `ViewPort` | C3-10 |
| `ui/views/registry.ts` | Adds Canvas to `VIEWS` | C3-11 (C3-5 for risk 6 only) |
| `apps/trace-viewer-dev/src/selftest-canvas.ts`, `selftest.ts`, `scripts/smoke.mjs`; `docs/spikes/trace-viewer-spike.md` | Canvas smoke, switch selftest, M4b exit | C3-5, C3-12 |

Task order: Part A runs C3-1 → C3-2 → C3-3 → C3-4. Part B runs C3-5 → C3-9 → C3-6 → C3-7 → C3-8 → C3-10 → C3-11 → C3-12 (C3-9 moves ahead of C3-6 because the minimap reads its camera store; the index's dependency column allows it).

---

# Part A: lane C3a (wave W2): pure canvas layout

### Task C3-1: Level constants and `collectItems`

**Files:**
- Create: `packages/trace-viewer/src/layout/canvas-levels.ts`
- Create: `packages/trace-viewer/src/layout/canvas-levels.test.ts`
- Create: `packages/trace-viewer/src/layout/canvas-layout.ts`
- Create: `packages/trace-viewer/src/layout/canvas-items.test.ts`
- Create: `packages/trace-viewer/src/test-support/canvas-arbitraries.ts`

**Interfaces:**
- Consumes: model (`../model/index.js`): `Level`, `LEVELS`, `TraceSession`, `Step`, `StepId`, `Chapter`, `Turn`, `TurnTrigger`, `Finding`, `FindingId`, `Lane`, `StepKind`, `Severity`, `SignalId`, `stepStableId(firstSeq: number): StepId`, `unitStableId(id: string): UnitStableId`, `decisionStableId(id: string): DecisionStableId`, `findingStableId(ruleId: SignalId, ruleVersion: number, anchorSeq: number): FindingId`. C1-10: `interface TraceIndex { chapterKey(id: UnitStableId): \`ch:${number}\` | undefined; … }`, `buildTraceIndex(session: TraceSession): TraceIndex`, `type SelectionId = StepId | UnitStableId`, `worstSeverity(step: Step, findingsById: ReadonlyMap<FindingId, Finding>): Severity | null`. Contracts: `TraceSessionSummary`.
- Produces (UI index §2.1, verbatim plus the constants below):

```ts
// layout/canvas-levels.ts
export type CanvasItemKind = "intent" | "instruction" | "plan" | "decision" | "claim" | "chapter" | "noise" | "loose";
export interface LevelSpec {
  level: Level; w: number;
  h: { story: number; chapter: number; noise: number; loose: number };
  labelH: number; storyCap: number; rMax: number;
  colGap: number; turnGap: number; breakGap: number; rowGap: number;
  channelH: number; channelLanes: number; railLanes: number;
  pps: number; slack: number; breakMinMs: number;
  minZoom: number; maxZoom: number;
  pitch: number; storyBand: number; workTop: number;
}
export const LEVEL_SPECS: { readonly [L in Level]: LevelSpec };
export const LABEL_ROW_PX = 16;
export const STEP_LIST_ROWS = 9;
export const STEP_ROW_PX = 24;
export const GRAPHIC_MIN_K = 0.5;
export const ICON_ONLY_K = 0.35;
export function isStoryKind(kind: CanvasItemKind): boolean;
export function frameSize(level: Level, kind: CanvasItemKind): { w: number; h: number };
/** Step lookup by id through firstSeq (binary search; sorts a copy only if out of order). */
export function stepFinder(steps: readonly Step[]): (id: string) => Step | undefined;

// layout/canvas-layout.ts (this task)
export const RESUME_DEFAULT_PROMPT = "Continue the task.";
export interface CanvasItem { key: string; selId: SelectionId; kind: CanvasItemKind; band: "story" | "work"; start: number; end: number; anchorSeq: number; turn: number }
export function collectItems(session: TraceSession, index: TraceIndex): CanvasItem[];

// test-support/canvas-arbitraries.ts (this task; C3-2 extends)
export const CANVAS_ORIGIN_MS: number;
export type CanvasSeedKind = "prompt" | "plan" | "claim" | "decision" | "chapter" | "noise" | "loose" | "work";
export interface CanvasSeed { atMs: number; kind: CanvasSeedKind; durationMs?: number; flagged?: boolean; title?: string; trigger?: TurnTrigger; prompt?: string; decides?: boolean; validates?: boolean; category?: Chapter["category"] }
export interface CanvasSessionOptions { sessionId?: string; live?: boolean }
export function canvasMeta(sessionId?: string, state?: TraceSessionSummary["state"]): TraceSessionSummary;
export function buildCanvasSession(seeds: readonly CanvasSeed[], options?: CanvasSessionOptions): TraceSession;
```

- [ ] **Step 1: Write the failing level test**

Create `packages/trace-viewer/src/layout/canvas-levels.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { LEVELS } from "../model/index.js";
import { LEVEL_SPECS, frameSize } from "./canvas-levels.js";

// Expected values: spec §7.5 level table and its band formulas.

describe("LEVEL_SPECS", () => {
  it("derives the Chapter bands from the spec table", () => {
    expect(LEVEL_SPECS.chapter).toMatchObject({
      w: 224, labelH: 22, storyCap: 1, rMax: 4, colGap: 40, turnGap: 72, breakGap: 64, rowGap: 16,
      channelH: 32, channelLanes: 4, railLanes: 3, pps: 8, slack: 64, breakMinMs: 60_000,
      minZoom: 0.2, maxZoom: 2, pitch: 264, storyBand: 118, workTop: 150,
    });
  });

  it("derives the Session and Step bands", () => {
    expect(LEVEL_SPECS.session).toMatchObject({
      w: 168, labelH: 0, storyCap: 3, rMax: 12, channelLanes: 2, railLanes: 1, pps: 0.5,
      breakMinMs: 300_000, minZoom: 0.25, pitch: 192, storyBand: 100, workTop: 116,
    });
    expect(LEVEL_SPECS.step).toMatchObject({ w: 320, rMax: 3, pitch: 368, storyBand: 118, workTop: 150 });
  });

  it("names each spec after its level", () => {
    for (const level of LEVELS) expect(LEVEL_SPECS[level].level).toBe(level);
  });
});

describe("frameSize", () => {
  it("depends only on level and kind", () => {
    expect(frameSize("chapter", "intent")).toEqual({ w: 224, h: 118 });
    expect(frameSize("chapter", "decision")).toEqual({ w: 224, h: 118 });
    expect(frameSize("chapter", "chapter")).toEqual({ w: 224, h: 134 });
    expect(frameSize("chapter", "noise")).toEqual({ w: 224, h: 58 });
    expect(frameSize("chapter", "loose")).toEqual({ w: 224, h: 66 });
    expect(frameSize("step", "chapter")).toEqual({ w: 320, h: 294 });
    expect(frameSize("session", "claim")).toEqual({ w: 168, h: 28 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/canvas-levels.test.ts`
Expected: FAIL with `Failed to load url ./canvas-levels.js`.

- [ ] **Step 3: Write `canvas-levels.ts`**

Create `packages/trace-viewer/src/layout/canvas-levels.ts`:

```ts
import type { Level, Step } from "../model/index.js";

/** Story band: intent, instruction, plan, decision, claim. Work band: chapter, noise, loose. */
export type CanvasItemKind =
  | "intent"
  | "instruction"
  | "plan"
  | "decision"
  | "claim"
  | "chapter"
  | "noise"
  | "loose";

export interface LevelSpec {
  level: Level;
  w: number;
  h: { story: number; chapter: number; noise: number; loose: number };
  /** 22 at Chapter and Step, 0 at Session (chips). */
  labelH: number;
  storyCap: number;
  rMax: number;
  colGap: number;
  turnGap: number;
  breakGap: number;
  rowGap: number;
  channelH: number;
  channelLanes: number;
  railLanes: number;
  pps: number;
  slack: number;
  breakMinMs: number;
  minZoom: number;
  maxZoom: number;
  /** Derived: w + colGap; storyCap·(h.story + rowGap) − rowGap; storyBand + channelH. */
  pitch: number;
  storyBand: number;
  workTop: number;
}

type LevelBase = Omit<LevelSpec, "pitch" | "storyBand" | "workTop">;

function derive(base: LevelBase): LevelSpec {
  const storyBand = base.storyCap * (base.h.story + base.rowGap) - base.rowGap;
  return { ...base, pitch: base.w + base.colGap, storyBand, workTop: storyBand + base.channelH };
}

/** Spec §7.5 level table. World px at zoom 1; each slot includes its label row. */
export const LEVEL_SPECS: { readonly [L in Level]: LevelSpec } = {
  session: derive({
    level: "session",
    w: 168,
    h: { story: 28, chapter: 28, noise: 28, loose: 28 },
    labelH: 0,
    storyCap: 3,
    rMax: 12,
    colGap: 24,
    turnGap: 48,
    breakGap: 40,
    rowGap: 8,
    channelH: 16,
    channelLanes: 2,
    railLanes: 1,
    pps: 0.5,
    slack: 32,
    breakMinMs: 300_000,
    minZoom: 0.25,
    maxZoom: 2,
  }),
  chapter: derive({
    level: "chapter",
    w: 224,
    h: { story: 118, chapter: 134, noise: 58, loose: 66 },
    labelH: 22,
    storyCap: 1,
    rMax: 4,
    colGap: 40,
    turnGap: 72,
    breakGap: 64,
    rowGap: 16,
    channelH: 32,
    channelLanes: 4,
    railLanes: 3,
    pps: 8,
    slack: 64,
    breakMinMs: 60_000,
    minZoom: 0.2,
    maxZoom: 2,
  }),
  step: derive({
    level: "step",
    w: 320,
    h: { story: 118, chapter: 294, noise: 58, loose: 66 },
    labelH: 22,
    storyCap: 1,
    rMax: 3,
    colGap: 48,
    turnGap: 80,
    breakGap: 72,
    rowGap: 16,
    channelH: 32,
    channelLanes: 4,
    railLanes: 3,
    pps: 8,
    slack: 64,
    breakMinMs: 60_000,
    minZoom: 0.2,
    maxZoom: 2,
  }),
};

/** Label row height inside the slot's labelH (the remaining 6 px is the gap above the card). */
export const LABEL_ROW_PX = 16;
/** Step level: a fixed list of nine 24 px rows under a 56 px header (294 = 22 + 56 + 9 · 24). */
export const STEP_LIST_ROWS = 9;
export const STEP_ROW_PX = 24;
/** Below GRAPHIC_MIN_K cards hide their mini graphic; below ICON_ONLY_K only icon and state fill show. */
export const GRAPHIC_MIN_K = 0.5;
export const ICON_ONLY_K = 0.35;

const STORY_KINDS: ReadonlySet<CanvasItemKind> = new Set<CanvasItemKind>([
  "intent",
  "instruction",
  "plan",
  "decision",
  "claim",
]);

export function isStoryKind(kind: CanvasItemKind): boolean {
  return STORY_KINDS.has(kind);
}

/** P10: a frame's size depends only on (level, kind), so content growth never moves a neighbor. */
export function frameSize(level: Level, kind: CanvasItemKind): { w: number; h: number } {
  const spec = LEVEL_SPECS[level];
  if (isStoryKind(kind)) return { w: spec.w, h: spec.h.story };
  if (kind === "chapter") return { w: spec.w, h: spec.h.chapter };
  if (kind === "noise") return { w: spec.w, h: spec.h.noise };
  return { w: spec.w, h: spec.h.loose };
}

/**
 * Finds a step by id through its firstSeq (StepId is step:<firstSeq>, and the model sorts steps by seq),
 * so canvas modules need no 5,000-entry Map per layout run. Sorts a copy only when the list is out of order.
 */
export function stepFinder(steps: readonly Step[]): (id: string) => Step | undefined {
  let sorted = steps;
  for (let i = 1; i < steps.length; i += 1) {
    if ((steps[i - 1]?.firstSeq ?? 0) > (steps[i]?.firstSeq ?? 0)) {
      sorted = [...steps].sort((a, b) => a.firstSeq - b.firstSeq);
      break;
    }
  }
  return (id) => {
    if (!id.startsWith("step:")) return undefined;
    const seq = Number(id.slice("step:".length));
    let lo = 0;
    let hi = sorted.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const step = sorted[mid];
      if (step === undefined) return undefined;
      if (step.firstSeq === seq) return step;
      if (step.firstSeq < seq) lo = mid + 1;
      else hi = mid - 1;
    }
    return undefined;
  };
}
```

- [ ] **Step 4: Run the level test to verify it passes**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/canvas-levels.test.ts`
Expected: PASS, `Tests  4 passed (4)`.

- [ ] **Step 5: Write the session builder**

Create `packages/trace-viewer/src/test-support/canvas-arbitraries.ts`:

```ts
import type { TraceSessionSummary } from "@jevcode/contracts";

import {
  decisionStableId,
  findingStableId,
  stepStableId,
  unitStableId,
  type Chapter,
  type Finding,
  type Lane,
  type Severity,
  type SignalId,
  type Step,
  type StepKind,
  type TraceSession,
  type Turn,
  type TurnTrigger,
} from "../model/index.js";

// Test-only builders for canvas layout and view tests. Sessions follow the W0 model
// contract: seqs 1..n in time order, step:<firstSeq> ids, lists sorted by seq.

/** 2026-09-18T09:00:00.000Z, the oauth fixture's first agent row. */
export const CANVAS_ORIGIN_MS = Date.parse("2026-09-18T09:00:00.000Z");

/** Local copy of the B-2 lane table (UI index §1.4). */
const LANE_OF = {
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
} as const satisfies Record<StepKind, Lane>;

export type CanvasSeedKind = "prompt" | "plan" | "claim" | "decision" | "chapter" | "noise" | "loose" | "work";

export interface CanvasSeed {
  /** Display-clock time of the step (ms since CANVAS_ORIGIN_MS). */
  atMs: number;
  kind: CanvasSeedKind;
  /** Step duration: edits 500 ms, tests and commands 4 s, others 0 when omitted. */
  durationMs?: number;
  /** chapter/noise: a warning failing_tests finding on its step. claim: a critical claim_contradicted citing the latest loose step. */
  flagged?: boolean;
  title?: string;
  /** prompt only; turn 0 is always "initial". */
  trigger?: TurnTrigger;
  prompt?: string;
  /** chapter/noise: the chapter lists the latest decision. */
  decides?: boolean;
  /** chapter: validationStepIds holds the latest loose step. */
  validates?: boolean;
  category?: Chapter["category"];
}

export interface CanvasSessionOptions {
  sessionId?: string;
  live?: boolean;
}

function iso(t: number): string {
  return new Date(CANVAS_ORIGIN_MS + t).toISOString();
}

export function canvasMeta(
  sessionId = "sess-canvas",
  state: TraceSessionSummary["state"] = "completed",
): TraceSessionSummary {
  return {
    sessionId,
    repoId: "repo-canvas",
    repoName: "repo-canvas",
    prompt: "Build the feature",
    state,
    startedAt: iso(0),
    endedAt: null,
    lastEventSeq: 0,
  };
}

export function buildCanvasSession(
  seeds: readonly CanvasSeed[],
  options: CanvasSessionOptions = {},
): TraceSession {
  const sorted = [...seeds].sort((a, b) => a.atMs - b.atMs);
  if (sorted[0]?.kind !== "prompt") sorted.unshift({ atMs: 0, kind: "prompt" });
  const steps: Step[] = [];
  const turns: Turn[] = [];
  const chapters: Chapter[] = [];
  const findings: Finding[] = [];
  let lastDecision: Step | undefined;
  let lastLoose: Step | undefined;

  const addStep = (kind: StepKind, t: number, durationMs: number, extra: Partial<Step> = {}): Step => {
    const seq = steps.length + 1;
    const turn = turns.at(-1);
    const step: Step = {
      id: stepStableId(seq),
      kind,
      lane: LANE_OF[kind],
      actor: kind === "instruction" || kind === "decision" ? "supervisor" : kind === "edit" ? "repo" : "agent",
      provenance: "observed",
      status: "ok",
      headline: `${kind} ${seq}`,
      turnIndex: turn?.index ?? 0,
      seqs: [seq],
      firstSeq: seq,
      lastSeq: seq,
      startTs: iso(t),
      endTs: iso(t + durationMs),
      tMs: t,
      endTMs: t + durationMs,
      durationMs,
      approxTime: false,
      startMs: CANVAS_ORIGIN_MS + t,
      evidenceSeqs: [],
      chapterIds: [],
      entityIds: [],
      findingIds: [],
      problems: [],
      noise: null,
      ...extra,
    };
    steps.push(step);
    if (turn !== undefined) {
      turn.stepIds.push(step.id);
      turn.endSeq = seq;
      turn.endTs = step.endTs ?? step.startTs;
      turn.endTMs = Math.max(turn.endTMs, t + durationMs);
    }
    return step;
  };

  const addFinding = (ruleId: SignalId, severity: Severity, step: Step, extra: Partial<Finding> = {}): Finding => {
    const finding: Finding = {
      id: findingStableId(ruleId, 1, step.firstSeq),
      ruleId,
      ruleVersion: 1,
      severity,
      anchorSeq: step.firstSeq,
      headline: ruleId,
      reason: ruleId,
      stepIds: [step.id],
      chapterIds: [],
      evidenceSeqs: [],
      anchorStepId: step.id,
      ...extra,
    };
    findings.push(finding);
    step.findingIds.push(finding.id);
    return finding;
  };

  for (const seed of sorted) {
    const t = seed.atMs;
    switch (seed.kind) {
      case "prompt": {
        const index = turns.length;
        const trigger: TurnTrigger = index === 0 ? "initial" : (seed.trigger ?? "steer");
        const prompt = seed.prompt ?? `Prompt ${index + 1}`;
        const seq = steps.length + 1;
        turns.push({
          index,
          trigger,
          prompt,
          outcome: "completed",
          startSeq: seq,
          endSeq: seq,
          startTs: iso(t),
          endTs: iso(t),
          tMs: t,
          endTMs: t,
          stepIds: [],
        });
        addStep("instruction", t, 0, { text: prompt, headline: prompt });
        break;
      }
      case "plan": {
        const step = addStep("message", t, 0, { text: "Plan: build it, then test it.", headline: "Plan" });
        const turn = turns.at(-1);
        if (turn !== undefined && turn.planStepId === undefined) turn.planStepId = step.id;
        break;
      }
      case "claim": {
        const text = seed.title ?? "All tests pass.";
        const step = addStep("message", t, 0, { text, headline: "Final claim" });
        const turn = turns.at(-1);
        if (turn !== undefined) turn.claimStepId = step.id;
        if (seed.flagged === true && lastLoose !== undefined) {
          addFinding("claim_contradicted", "critical", step, {
            claimStepId: step.id,
            evidenceStepIds: [lastLoose.id],
            evidenceSeqs: [lastLoose.firstSeq],
            claimSpan: [0, text.length],
          });
          step.problems = ["claim_contradicted"];
        }
        break;
      }
      case "decision": {
        const decisionId = `dec-${steps.length + 1}`;
        lastDecision = addStep("decision", t, seed.durationMs ?? 0, {
          target: decisionId,
          headline: seed.title ?? "Decision",
          decision: {
            decisionId,
            title: seed.title ?? "Decision",
            severity: "required",
            status: "answered",
            options: [
              { id: "a", label: "Option A", chosen: true },
              { id: "b", label: "Option B", chosen: false },
            ],
            decidedBy: "supervisor",
          },
        });
        break;
      }
      case "chapter":
      case "noise": {
        const path = `src/file-${steps.length + 1}.ts`;
        const durationMs = seed.durationMs ?? 500;
        const step = addStep("edit", t, durationMs, {
          target: path,
          headline: path,
          edit: {
            path,
            change: "modified",
            added: 12,
            removed: 3,
            claimed: false,
            observed: true,
            diff: "none",
            lockfile: seed.kind === "noise",
            formattingOnly: false,
          },
        });
        const id = unitStableId(`c${step.firstSeq}`);
        const chapter: Chapter = {
          id,
          changeUnitId: `c${step.firstSeq}`,
          title: seed.title ?? `Chapter ${step.firstSeq}`,
          category: seed.category ?? "implementation",
          status: "detected",
          files: [path],
          link: "observed",
          evidenceLinks: { cited: 1, resolved: 1, approx: 0 },
          firstSeq: step.firstSeq,
          lastSeq: step.lastSeq,
          versions: 1,
          startTs: step.startTs,
          endTs: step.endTs ?? step.startTs,
          tMs: t,
          endTMs: t + durationMs,
          stepIds: [step.id],
          factSeqs: [step.firstSeq],
          decisionIds:
            seed.decides === true && lastDecision?.target !== undefined ? [decisionStableId(lastDecision.target)] : [],
          validationIds: [],
          clampIds: [],
          triad: {},
          schemaChanges: [],
          dependencyChanges: [],
          findingIds: [],
          noise: seed.kind === "noise",
          current: true,
          validationStepIds: seed.validates === true && lastLoose !== undefined ? [lastLoose.id] : [],
        };
        step.chapterIds.push(id);
        if (seed.flagged === true) {
          const finding = addFinding("failing_tests", "warning", step, { chapterIds: [id] });
          chapter.findingIds.push(finding.id);
        }
        chapters.push(chapter);
        break;
      }
      case "loose": {
        lastLoose = addStep("test", t, seed.durationMs ?? 4_000, {
          target: "pnpm test",
          headline: "pnpm test",
          status: "failed",
          problems: ["tests_failed"],
          command: { command: "pnpm test", exitCode: 1 },
          tests: { passed: 14, failed: 1, skipped: 0, failures: [] },
        });
        addFinding("failing_tests", "warning", lastLoose);
        break;
      }
      case "work": {
        addStep("command", t, seed.durationMs ?? 4_000, {
          target: "pnpm build",
          headline: "pnpm build",
          command: { command: "pnpm build", exitCode: 0 },
        });
        break;
      }
    }
  }

  const last = steps.at(-1);
  const endT = steps.reduce((max, step) => Math.max(max, step.endTMs ?? step.tMs), 0);
  findings.sort((a, b) => a.anchorSeq - b.anchorSeq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    schemaVersion: 1,
    meta: {
      ...canvasMeta(options.sessionId, options.live === true ? "running" : "completed"),
      lastEventSeq: last?.lastSeq ?? 0,
    },
    live: options.live === true,
    loadedThroughSeq: last?.lastSeq ?? 0,
    originMs: CANVAS_ORIGIN_MS,
    span: { startTs: iso(0), endTs: iso(endT), durationMs: endT },
    turns,
    steps,
    chapters,
    entities: [],
    findings,
    gaps: [],
    coverage: { capabilities: [], signals: [], approximateJoins: false, inferredSteps: 0 },
    hidden: { byType: {}, unreceived: 0 },
  };
}
```

If `pnpm --filter @jevcode/trace-viewer typecheck` later reports a required model field that this builder omits, the model gained a field after this plan was written: add it to the object literal that `tsc` names, with the empty value its doc comment in `src/model/types.ts` gives (`[]`, `null`, `false` or `0`), and note it in the commit message.

- [ ] **Step 6: Write the failing item tests**

Create `packages/trace-viewer/src/layout/canvas-items.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { TraceSession } from "../model/index.js";
import { buildCanvasSession } from "../test-support/canvas-arbitraries.js";
import { RESUME_DEFAULT_PROMPT, collectItems, type CanvasItem } from "./canvas-layout.js";
import { buildTraceIndex } from "./trace-index.js";

// Expected items follow spec §7.5 "Items".

function items(session: TraceSession): CanvasItem[] {
  return collectItems(session, buildTraceIndex(session));
}

describe("collectItems", () => {
  it("emits intent, plan, chapters, decision and claim in time order with stable keys", () => {
    const session = buildCanvasSession([
      { atMs: 0, kind: "prompt" },
      { atMs: 8_000, kind: "plan" },
      { atMs: 10_000, kind: "chapter" },
      { atMs: 25_000, kind: "decision" },
      { atMs: 43_000, kind: "claim" },
    ]);
    expect(items(session).map((item) => [item.kind, item.band, item.key, item.selId, item.start])).toEqual([
      ["intent", "story", "turn:1", "step:1", 0],
      ["plan", "story", "plan:2", "step:2", 8_000],
      ["chapter", "work", "ch:3", "unit:c3", 10_000],
      ["decision", "story", "decision:dec-4", "step:4", 25_000],
      ["claim", "story", "claim:5", "step:5", 43_000],
    ]);
  });

  it("adds no story item for a resume turn that only says 'Continue the task.'", () => {
    const session = buildCanvasSession([
      { atMs: 0, kind: "prompt" },
      { atMs: 1_000, kind: "chapter" },
      { atMs: 5_000, kind: "prompt", trigger: "resume", prompt: RESUME_DEFAULT_PROMPT },
      { atMs: 6_000, kind: "chapter" },
      { atMs: 9_000, kind: "prompt", trigger: "steer", prompt: "Use the other API" },
    ]);
    expect(items(session).map((item) => [item.kind, item.turn])).toEqual([
      ["intent", 0],
      ["chapter", 0],
      ["chapter", 1],
      ["instruction", 2],
    ]);
  });

  it("keeps a flagged noise chapter as a chapter and a clean one as noise", () => {
    const session = buildCanvasSession([
      { atMs: 1_000, kind: "noise", flagged: true },
      { atMs: 2_000, kind: "noise" },
    ]);
    expect(items(session).map((item) => item.kind)).toEqual(["intent", "chapter", "noise"]);
  });

  it("makes a warning finding step with no chapter a loose item", () => {
    const session = buildCanvasSession([
      { atMs: 2_000, kind: "work" },
      { atMs: 3_000, kind: "loose" },
    ]);
    expect(items(session).map((item) => [item.kind, item.band, item.key, item.selId])).toEqual([
      ["intent", "story", "turn:1", "step:1"],
      ["loose", "work", "step:3", "step:3"],
    ]);
  });

  it("skips superseded chapters and treats a step whose only chapter is superseded as loose", () => {
    const base = buildCanvasSession([{ atMs: 1_000, kind: "chapter", flagged: true }]);
    const session: TraceSession = {
      ...base,
      chapters: base.chapters.map((chapter) => ({ ...chapter, current: false })),
    };
    expect(items(session).map((item) => [item.kind, item.key])).toEqual([
      ["intent", "turn:1"],
      ["loose", "step:2"],
    ]);
  });

  it("disambiguates chapters that share an anchor seq, ranked by selection id", () => {
    const base = buildCanvasSession([{ atMs: 1_000, kind: "chapter" }]);
    const first = base.chapters[0];
    if (first === undefined) throw new Error("builder made no chapter");
    const twin = { ...first, id: "unit:zz" as const, changeUnitId: "zz" };
    const session: TraceSession = { ...base, chapters: [twin, first] };
    expect(items(session).filter((item) => item.band === "work").map((item) => [item.key, item.selId])).toEqual([
      ["ch:2", "unit:c2"],
      ["ch:2.1", "unit:zz"],
    ]);
  });

  it("does not depend on the order of chapters, steps and findings", () => {
    const session = buildCanvasSession([
      { atMs: 1_000, kind: "chapter" },
      { atMs: 2_000, kind: "loose" },
      { atMs: 3_000, kind: "decision" },
      { atMs: 4_000, kind: "noise" },
      { atMs: 5_000, kind: "claim", flagged: true },
    ]);
    const index = buildTraceIndex(session);
    const shuffled: TraceSession = {
      ...session,
      chapters: [...session.chapters].reverse(),
      steps: [...session.steps].reverse(),
      findings: [...session.findings].reverse(),
    };
    expect(collectItems(shuffled, index)).toEqual(collectItems(session, index));
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/canvas-items.test.ts`
Expected: FAIL with `Failed to load url ./canvas-layout.js`.

- [ ] **Step 8: Write `collectItems`**

Create `packages/trace-viewer/src/layout/canvas-layout.ts`:

```ts
import type { Finding, FindingId, Step, TraceSession, Turn } from "../model/index.js";
import { stepFinder, type CanvasItemKind } from "./canvas-levels.js";
import { worstSeverity } from "./tone.js";
import type { SelectionId, TraceIndex } from "./trace-index.js";

/** codex-adapter.ts:289 resumes a turn with this prompt; such a turn adds no story frame. */
export const RESUME_DEFAULT_PROMPT = "Continue the task.";

export interface CanvasItem {
  key: string;
  selId: SelectionId;
  kind: CanvasItemKind;
  band: "story" | "work";
  /** Display clock (Step.tMs or Chapter.tMs). */
  start: number;
  end: number;
  anchorSeq: number;
  turn: number;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Index of the last turn whose tMs ≤ t (turns are in seq order, so tMs is non-decreasing). */
function turnLocator(turns: readonly Turn[]): (t: number) => number {
  return (t) => {
    let lo = 0;
    let hi = turns.length - 1;
    let found = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const turn = turns[mid];
      if (turn !== undefined && turn.tMs <= t) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return turns[found]?.index ?? 0;
  };
}

/** Equal keys keep the first (by selection id) and suffix the rest with .1, .2, … */
function disambiguate(items: CanvasItem[]): CanvasItem[] {
  const groups = new Map<string, CanvasItem[]>();
  for (const item of items) {
    const group = groups.get(item.key);
    if (group === undefined) groups.set(item.key, [item]);
    else group.push(item);
  }
  const out: CanvasItem[] = [];
  for (const [key, group] of groups) {
    group.sort((a, b) => compareText(a.selId, b.selId) || compareText(a.kind, b.kind));
    group.forEach((item, index) => out.push(index === 0 ? item : { ...item, key: `${key}.${index}` }));
  }
  return out;
}

function compareItems(a: CanvasItem, b: CanvasItem): number {
  return a.start - b.start || a.anchorSeq - b.anchorSeq || compareText(a.key, b.key);
}

/** Spec §7.5 "Items": story items per turn, decisions, current chapters and loose finding steps. */
export function collectItems(session: TraceSession, index: TraceIndex): CanvasItem[] {
  const stepOf = stepFinder(session.steps);
  const findingsById = new Map<FindingId, Finding>(session.findings.map((finding) => [finding.id, finding]));
  const currentChapters = new Set<string>(
    session.chapters.filter((chapter) => chapter.current).map((chapter) => chapter.id),
  );
  const turnAt = turnLocator(session.turns);
  const items: CanvasItem[] = [];
  const storySteps = new Set<string>();

  const story = (kind: CanvasItemKind, key: string, step: Step, start: number, anchorSeq: number): void => {
    storySteps.add(step.id);
    items.push({
      key,
      selId: step.id,
      kind,
      band: "story",
      start,
      end: Math.max(start, step.endTMs ?? step.tMs),
      anchorSeq,
      turn: turnAt(start),
    });
  };

  for (const turn of session.turns) {
    const resumeDefault = turn.trigger === "resume" && turn.prompt.trim() === RESUME_DEFAULT_PROMPT;
    let prompt: Step | undefined;
    let first: Step | undefined;
    for (const id of turn.stepIds) {
      const step = stepOf(id);
      if (step === undefined) continue;
      first ??= step;
      if (step.kind === "instruction") {
        prompt = step;
        break;
      }
    }
    prompt ??= first;
    if (!resumeDefault && prompt !== undefined) {
      story(turn.index === 0 ? "intent" : "instruction", `turn:${turn.startSeq}`, prompt, turn.tMs, turn.startSeq);
    }
    const plan = turn.planStepId === undefined ? undefined : stepOf(turn.planStepId);
    if (plan !== undefined) story("plan", `plan:${plan.firstSeq}`, plan, plan.tMs, plan.firstSeq);
    const claim = turn.claimStepId === undefined ? undefined : stepOf(turn.claimStepId);
    if (claim !== undefined) story("claim", `claim:${claim.firstSeq}`, claim, claim.tMs, claim.firstSeq);
  }

  for (const step of session.steps) {
    if (step.kind !== "decision") continue;
    story("decision", `decision:${step.target ?? String(step.firstSeq)}`, step, step.tMs, step.firstSeq);
  }

  for (const chapter of session.chapters) {
    if (!chapter.current) continue;
    const key = index.chapterKey(chapter.id);
    if (key === undefined) continue;
    const flagged =
      chapter.findingIds.length > 0 ||
      chapter.stepIds.some((id) => (stepOf(id)?.findingIds.length ?? 0) > 0);
    items.push({
      key,
      selId: chapter.id,
      kind: chapter.noise && !flagged ? "noise" : "chapter",
      band: "work",
      start: chapter.tMs,
      end: Math.max(chapter.tMs, chapter.endTMs),
      anchorSeq: Number(key.slice(3)),
      turn: turnAt(chapter.tMs),
    });
  }

  for (const step of session.steps) {
    if (step.findingIds.length === 0 || storySteps.has(step.id)) continue;
    if (step.chapterIds.some((id) => currentChapters.has(id))) continue;
    const severity = worstSeverity(step, findingsById);
    if (severity !== "warning" && severity !== "critical") continue;
    items.push({
      key: `step:${step.firstSeq}`,
      selId: step.id,
      kind: "loose",
      band: "work",
      start: step.tMs,
      end: Math.max(step.tMs, step.endTMs ?? step.tMs),
      anchorSeq: step.firstSeq,
      turn: turnAt(step.tMs),
    });
  }

  return disambiguate(items).sort(compareItems);
}
```

- [ ] **Step 9: Run the item tests to verify they pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/canvas-items.test.ts src/layout/canvas-levels.test.ts`
Expected: PASS, `Tests  11 passed (11)`.

- [ ] **Step 10: Typecheck, lint and root checks**

Run: `pnpm --filter @jevcode/trace-viewer typecheck && pnpm lint`
Expected: both exit 0; `pnpm lint` reports nothing for `src/layout/canvas-*.ts` (the layout block forbids `Date`, which only `src/test-support` uses).

Then run the root checks (section "Commands used by every task"). Expected: each exits 0.

- [ ] **Step 11: Commit**

```bash
git add packages/trace-viewer/src/layout/canvas-levels.ts packages/trace-viewer/src/layout/canvas-levels.test.ts packages/trace-viewer/src/layout/canvas-layout.ts packages/trace-viewer/src/layout/canvas-items.test.ts packages/trace-viewer/src/test-support/canvas-arbitraries.ts
git commit -m "feat(trace-viewer): canvas level table and item collection"
```

### Task C3-2: Placement, sticky state, column time map, `canvasXMap`; P1–P8, P10

**Files:**
- Modify: `packages/trace-viewer/src/layout/canvas-layout.ts` (append placement below `collectItems`)
- Create: `packages/trace-viewer/src/layout/canvas-routes.ts` (edge types only; C3-3 adds the functions)
- Create: `packages/trace-viewer/src/layout/canvas-layout.test.ts`
- Create: `packages/trace-viewer/src/layout/canvas-layout.property.test.ts`
- Modify: `packages/trace-viewer/src/test-support/canvas-arbitraries.ts` (append arbitraries, prefix, mutations, oauth helpers)

**Interfaces:**
- Consumes: C3-1 (`CanvasItem`, `collectItems`, `LEVEL_SPECS`, `LevelSpec`, `CanvasItemKind`, `frameSize`, `isStoryKind`, `LABEL_ROW_PX`, `buildCanvasSession`, `CanvasSeed`, `CANVAS_ORIGIN_MS`); C1-9: `interface TimeScale { originMs; endT; endU; segments; toU(tMs: number): number; toT(u: number): number; breaks(u0: number, u1: number, minMs?: number): readonly ScaleSegment[] }`, `interface ScaleSegment { t0; t1; u0; u1; idle: null | { reason: IdleReason; ms: number } }`, `interface XMap { xOf(tMs: number): number; tOf(x: number): number }`, `buildTimeScale(input: TimeScaleInput): TimeScale`, `timeScaleInputOf(session: TraceSession, liveTMs?: number): TimeScaleInput`; C1-5: `interface Point { x: number; y: number }`, `interface Rect { x: number; y: number; w: number; h: number }`; B: `foldRows(meta, rows, options: FinalizeOptions): TraceSession`; B-2 test support: `loadFixtureTrace(name: FixtureName): { meta: TraceSessionSummary; rows: TraceRow[] }`; contracts: `ChangeUnit`, `TraceRow`, `TraceBundle`, `TraceSessionSummary`, `TRACE_BUNDLE_FORMAT`, `TRACE_BUNDLE_VERSION`.
- Produces (UI index §2.1 plus Interface deviations 2, 3):

```ts
// layout/canvas-layout.ts
export interface CanvasFrame {
  key: string; selId: SelectionId;
  kind: "story" | "chapter" | "noise" | "loose"; item: CanvasItemKind;
  col: number; row: number; slot: Rect; card: Rect; label: Rect | null;
  members: readonly string[];
  /** Deviation 2: selection ids of `members`, same order. */
  memberSelIds: readonly SelectionId[];
  late: boolean;
}
export interface CanvasColumn { key: string; index: number; x: number; t0: number; turn: number }
export interface CanvasSeparator { kind: "turn" | "break"; x: number; t: number; turn: number; label: string }
export interface TimeBreakpoint { t: number; xIn: number; xOut: number }
export interface CanvasLayoutStats { late: number; rMaxExceeded: number; holes: number; hiddenEdges: number }
export interface CanvasLayoutState { readonly [layoutStateBrand]: true }
export interface CanvasLayout {
  level: Level; sessionId: string;
  frames: readonly CanvasFrame[]; frameByKey: ReadonlyMap<string, CanvasFrame>;
  holes: readonly Rect[]; columns: readonly CanvasColumn[]; separators: readonly CanvasSeparator[];
  edges: readonly CanvasEdge[];
  /** Deviation 3. */
  junctions: readonly Point[];
  time: { bps: readonly TimeBreakpoint[]; pps: number };
  bounds: Rect; readingOrder: readonly SelectionId[];
  stats: CanvasLayoutStats; state: CanvasLayoutState;
}
export function layoutCanvas(session: TraceSession, index: TraceIndex, scale: TimeScale, level: Level, prev?: CanvasLayout): CanvasLayout;
export function canvasXMap(layout: CanvasLayout, scale: TimeScale): XMap;
/** "14 min", "1 h 05 min". */
export function formatIdle(ms: number): string;

// layout/canvas-routes.ts (types only in this task)
export type EdgeKind = "trunk" | "contradicts" | "decides" | "validates";
export type EdgeShape = "comb" | "stacked" | "adjacent" | "rail" | "channel" | "direct";
export interface CanvasEdge { id: string; kind: EdgeKind; from: string; to: string; shape: EdgeShape; lane: number | null; d: string | null; rest: boolean; tone: "bad" | "neutral"; badge: Point | null; findingId: FindingId | null }
export interface RouteInput { session: TraceSession; frames: readonly CanvasFrame[]; frameByKey: ReadonlyMap<string, CanvasFrame>; columns: readonly CanvasColumn[]; spec: LevelSpec }

// test-support/canvas-arbitraries.ts additions
export function canvasScale(session: TraceSession, liveTMs?: number): TimeScale;
export function arbCanvasSession(options?: { maxSeeds?: number }): fc.Arbitrary<TraceSession>;
export function canvasPrefix(session: TraceSession, beforeMs: number): TraceSession;
export interface CanvasMutation { op: "churn" | "merge" | "flip" | "late" | "append"; pick: number }
export const arbCanvasMutation: fc.Arbitrary<CanvasMutation>;
export function mutateCanvasSession(session: TraceSession, ops: readonly CanvasMutation[]): TraceSession;
export function oauthCanvasRows(options?: { unitsInline?: boolean }): { meta: TraceSessionSummary; rows: TraceRow[] };
export function foldCanvasPrefix(meta: TraceSessionSummary, rows: readonly TraceRow[], count: number): TraceSession;
export function oauthCanvasSession(): TraceSession;
export function oauthCanvasBundle(): TraceBundle;
```

- [ ] **Step 1: Write the edge types file**

Create `packages/trace-viewer/src/layout/canvas-routes.ts`:

```ts
import type { FindingId, TraceSession } from "../model/index.js";
import type { CanvasColumn, CanvasFrame } from "./canvas-layout.js";
import type { LevelSpec } from "./canvas-levels.js";
import type { Point } from "./viewport.js";

export type EdgeKind = "trunk" | "contradicts" | "decides" | "validates";
export type EdgeShape = "comb" | "stacked" | "adjacent" | "rail" | "channel" | "direct";

export interface CanvasEdge {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  shape: EdgeShape;
  lane: number | null;
  /** SVG path in world px; null when no lane is free (drawn only for the selection via directPath). */
  d: string | null;
  rest: boolean;
  tone: "bad" | "neutral";
  /** contradicts: ≠ badge position. */
  badge: Point | null;
  findingId: FindingId | null;
}

export interface RouteInput {
  session: TraceSession;
  frames: readonly CanvasFrame[];
  frameByKey: ReadonlyMap<string, CanvasFrame>;
  columns: readonly CanvasColumn[];
  spec: LevelSpec;
}
```

- [ ] **Step 2: Append the session tools to `canvas-arbitraries.ts`**

At the top of `packages/trace-viewer/src/test-support/canvas-arbitraries.ts`, replace the two import blocks:

```ts
import type { TraceSessionSummary } from "@jevcode/contracts";

import {
  decisionStableId,
```

with:

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  TRACE_BUNDLE_FORMAT,
  TRACE_BUNDLE_VERSION,
  type ChangeUnit,
  type TraceBundle,
  type TraceRow,
  type TraceSessionSummary,
} from "@jevcode/contracts";
import fc from "fast-check";

import { RESUME_DEFAULT_PROMPT } from "../layout/canvas-layout.js";
import { buildTimeScale, timeScaleInputOf, type TimeScale } from "../layout/time-scale.js";
import {
  decisionStableId,
  foldRows,
  type UnitStableId,
```

(the rest of the model import list stays as it is). Then append to the end of the file:

```ts
// ------------------------------------------------------------ scale

export function canvasScale(session: TraceSession, liveTMs?: number): TimeScale {
  return buildTimeScale(timeScaleInputOf(session, liveTMs));
}

// ------------------------------------------------------------ arbitraries (P1–P10)

interface RawSeed {
  dtMs: number;
  kind: CanvasSeedKind;
  durationMs: number;
  flagged: boolean;
  decides: boolean;
  validates: boolean;
  trigger: TurnTrigger;
  resumeDefault: boolean;
}

const rawSeed: fc.Arbitrary<RawSeed> = fc.record({
  dtMs: fc.oneof(
    { weight: 6, arbitrary: fc.integer({ min: 0, max: 20_000 }) },
    { weight: 1, arbitrary: fc.integer({ min: 60_000, max: 1_200_000 }) },
  ),
  kind: fc.constantFrom<CanvasSeedKind>(
    "prompt",
    "plan",
    "claim",
    "decision",
    "chapter",
    "chapter",
    "chapter",
    "noise",
    "loose",
    "work",
  ),
  durationMs: fc.oneof(
    fc.constant(0),
    fc.integer({ min: 100, max: 5_000 }),
    fc.integer({ min: 60_000, max: 400_000 }),
  ),
  flagged: fc.boolean(),
  decides: fc.boolean(),
  validates: fc.boolean(),
  trigger: fc.constantFrom<TurnTrigger>("steer", "resume"),
  resumeDefault: fc.boolean(),
});

/** Turns, story items, chapters, noise, loose findings, decisions, validations, idle gaps and long commands. */
export function arbCanvasSession(options: { maxSeeds?: number } = {}): fc.Arbitrary<TraceSession> {
  return fc.array(rawSeed, { minLength: 1, maxLength: options.maxSeeds ?? 40 }).map((raw) => {
    let t = 0;
    const seeds: CanvasSeed[] = raw.map((seed, index) => {
      t += index === 0 ? 0 : seed.dtMs;
      const prompt =
        seed.kind === "prompt" && seed.trigger === "resume" && seed.resumeDefault ? RESUME_DEFAULT_PROMPT : undefined;
      return {
        atMs: t,
        kind: seed.kind,
        durationMs: seed.durationMs,
        flagged: seed.flagged,
        decides: seed.decides,
        validates: seed.validates,
        trigger: seed.trigger,
        ...(prompt === undefined ? {} : { prompt }),
        ...(seed.validates ? { category: "tests" as const } : {}),
      };
    });
    return buildCanvasSession(seeds);
  });
}

/** The items with start < beforeMs, unchanged (P5: "no key mutated after T"). */
export function canvasPrefix(session: TraceSession, beforeMs: number): TraceSession {
  const steps = session.steps.filter((step) => step.tMs < beforeMs);
  const kept = new Set<string>(steps.map((step) => step.id));
  const turns = session.turns
    .filter((turn) => turn.tMs < beforeMs)
    .map((turn) => {
      const next: Turn = { ...turn, stepIds: turn.stepIds.filter((id) => kept.has(id)) };
      if (next.planStepId !== undefined && !kept.has(next.planStepId)) delete next.planStepId;
      if (next.claimStepId !== undefined && !kept.has(next.claimStepId)) delete next.claimStepId;
      return next;
    });
  const last = steps.at(-1);
  return {
    ...session,
    meta: { ...session.meta, lastEventSeq: last?.lastSeq ?? 0 },
    loadedThroughSeq: last?.lastSeq ?? 0,
    turns,
    steps,
    chapters: session.chapters.filter((chapter) => chapter.tMs < beforeMs),
    findings: session.findings.filter((finding) => kept.has(finding.anchorStepId)),
  };
}

export interface CanvasMutation {
  op: "churn" | "merge" | "flip" | "late" | "append";
  pick: number;
}

export const arbCanvasMutation: fc.Arbitrary<CanvasMutation> = fc.record({
  op: fc.constantFrom<CanvasMutation["op"]>("churn", "merge", "flip", "late", "append"),
  pick: fc.nat({ max: 1_000 }),
});

function chapterAnchor(chapter: Chapter, session: TraceSession): number {
  const stepSeqs = chapter.stepIds.map((id) => session.steps.find((step) => step.id === id)?.firstSeq ?? Infinity);
  return Math.min(...chapter.factSeqs, ...stepSeqs);
}

function replaceChapterId(session: TraceSession, from: UnitStableId, to: UnitStableId): void {
  const swap = (ids: UnitStableId[]): UnitStableId[] => [...new Set(ids.map((id) => (id === from ? to : id)))];
  for (const step of session.steps) step.chapterIds = swap(step.chapterIds);
  for (const finding of session.findings) finding.chapterIds = swap(finding.chapterIds);
}

function applyMutation(session: TraceSession, { op, pick }: CanvasMutation): void {
  const chapters = session.chapters;
  switch (op) {
    case "churn": {
      const chapter = chapters[pick % Math.max(1, chapters.length)];
      if (chapter === undefined) return;
      const id: UnitStableId = `${chapter.id}~r`;
      replaceChapterId(session, chapter.id, id);
      chapter.id = id;
      chapter.changeUnitId = id.slice("unit:".length);
      return;
    }
    case "merge": {
      if (chapters.length < 2) return;
      const i = pick % chapters.length;
      const a = chapters[i];
      const b = chapters[(i + 1) % chapters.length];
      if (a === undefined || b === undefined) return;
      a.stepIds = [...new Set([...a.stepIds, ...b.stepIds])].sort(
        (x, y) => Number(x.slice("step:".length)) - Number(y.slice("step:".length)),
      );
      a.factSeqs = [...new Set([...a.factSeqs, ...b.factSeqs])].sort((x, y) => x - y);
      a.findingIds = [...new Set([...a.findingIds, ...b.findingIds])];
      a.tMs = Math.min(a.tMs, b.tMs);
      a.endTMs = Math.max(a.endTMs, b.endTMs);
      a.noise = a.noise && b.noise;
      replaceChapterId(session, b.id, a.id);
      session.chapters = chapters.filter((chapter) => chapter !== b);
      return;
    }
    case "flip": {
      const clean = chapters.filter(
        (chapter) =>
          chapter.findingIds.length === 0 &&
          chapter.stepIds.every((id) => (session.steps.find((step) => step.id === id)?.findingIds.length ?? 0) === 0),
      );
      const chapter = clean[pick % Math.max(1, clean.length)];
      if (chapter !== undefined) chapter.noise = !chapter.noise;
      return;
    }
    case "late": {
      const pool = session.steps.filter(
        (step) => step.kind === "edit" || step.kind === "test" || step.kind === "command",
      );
      const step = pool[pick % Math.max(1, pool.length)];
      if (step === undefined) return;
      const id: UnitStableId = `unit:late${step.firstSeq}`;
      if (chapters.some((chapter) => chapter.id === id)) return;
      const source = chapters[0];
      const base: Chapter =
        source === undefined
          ? (buildCanvasSession([{ atMs: 0, kind: "chapter" }]).chapters[0] as Chapter)
          : source;
      chapters.push({
        ...base,
        id,
        changeUnitId: id.slice("unit:".length),
        title: `Late ${step.firstSeq}`,
        firstSeq: step.firstSeq,
        lastSeq: step.lastSeq,
        tMs: step.tMs,
        endTMs: step.endTMs ?? step.tMs,
        stepIds: [step.id],
        factSeqs: [step.firstSeq],
        decisionIds: [],
        validationStepIds: [],
        findingIds: [],
        noise: false,
        current: true,
      });
      step.chapterIds.push(id);
      chapters.sort((x, y) => chapterAnchor(x, session) - chapterAnchor(y, session));
      return;
    }
    case "append": {
      const last = session.steps.at(-1);
      const turn = session.turns.at(-1);
      if (last === undefined || turn === undefined) return;
      const endT = session.steps.reduce((max, step) => Math.max(max, step.endTMs ?? step.tMs), 0);
      const extra = buildCanvasSession([
        { atMs: 0, kind: "prompt" },
        { atMs: endT + 1_000 * (1 + (pick % 90)), kind: "chapter" },
      ]);
      const edit = extra.steps[1];
      const chapter = extra.chapters[0];
      if (edit === undefined || chapter === undefined) return;
      const seq = last.lastSeq + 1;
      const stepId = stepStableId(seq);
      const unitId = unitStableId(`a${seq}`);
      session.steps.push({
        ...edit,
        id: stepId,
        seqs: [seq],
        firstSeq: seq,
        lastSeq: seq,
        turnIndex: turn.index,
        chapterIds: [unitId],
      });
      session.chapters.push({
        ...chapter,
        id: unitId,
        changeUnitId: `a${seq}`,
        firstSeq: seq,
        lastSeq: seq,
        stepIds: [stepId],
        factSeqs: [seq],
      });
      turn.stepIds.push(stepId);
      turn.endSeq = seq;
      session.loadedThroughSeq = seq;
      session.meta = { ...session.meta, lastEventSeq: seq };
      return;
    }
  }
}

/** Id churn, merges, kind flips, late arrivals and appends (P6). Never mutates its input. */
export function mutateCanvasSession(session: TraceSession, ops: readonly CanvasMutation[]): TraceSession {
  const next = structuredClone(session);
  for (const op of ops) applyMutation(next, op);
  return next;
}

// ------------------------------------------------------------ oauth (spec §7.5 table)

interface ExpectedUnit {
  id: string;
  title: string;
  category: ChangeUnit["category"];
  files: string[];
}

// path + fileURLToPath, not new URL(relative, import.meta.url): under jsdom that resolves against http://localhost:3000.
const EXPECTED_UNITS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../fixtures/oauth/expected_units.json",
);

type Payload = Record<string, unknown>;

function payloadOf(row: TraceRow): Payload {
  return typeof row.payload === "object" && row.payload !== null ? (row.payload as Payload) : {};
}

function isFileFact(path: string): (row: TraceRow, payload: Payload) => boolean {
  return (row, payload) => row.type === "evidence_fact" && payload.type === "file_changed" && payload.path === path;
}

/** Each unit's creation time, located by content in fixtures/oauth/events.jsonl (never by line number). */
const UNIT_START: Record<string, (row: TraceRow, payload: Payload) => boolean> = {
  "oauth-dependency": (row, payload) =>
    row.type === "agent_event" && payload.type === "command_started" && payload.command === "pnpm add google-auth-library",
  "oauth-identity-layer": isFileFact("src/auth/identity.ts"),
  "oauth-migration": isFileFact("migrations/001_create_identities.sql"),
  "oauth-lockfile-noise": isFileFact("pnpm-lock.yaml"),
  "oauth-format-noise": isFileFact("src/db/users.ts"),
  "oauth-account-linking-decision": (row, payload) =>
    row.type === "agent_event" && payload.type === "agent_message" && payload.role === "user",
  "oauth-linking-test-failure": isFileFact("tests/auth/oauth.test.ts"),
};

/** The mockup (canvas-1440.png) draws Identity layer → Account linking; the decision-born unit lists its decision. */
const RELATED_DECISIONS: Record<string, string[]> = {
  "oauth-identity-layer": ["dec-oauth-0001"],
  "oauth-account-linking-decision": ["dec-oauth-0001"],
};

function unitEvidence(unit: ExpectedUnit, rows: readonly TraceRow[]): string[] {
  const files = new Set(unit.files);
  const ids: string[] = [];
  for (const row of rows) {
    if (row.type !== "evidence_fact" || row.factId === undefined) continue;
    const payload = payloadOf(row);
    const path = payload.path ?? payload.file ?? payload.manifest;
    const touches = typeof path === "string" && files.has(path);
    const testRun = unit.category === "tests" && payload.type === "test_result";
    if (touches || testRun) ids.push(row.factId);
  }
  return ids;
}

function expectedUnits(): ExpectedUnit[] {
  const parsed: unknown = JSON.parse(readFileSync(EXPECTED_UNITS_PATH, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("expected_units.json is not an array");
  return parsed as ExpectedUnit[];
}

/**
 * oauth rows with the clusterer's change_unit rows replaced by units built from
 * fixtures/oauth/expected_units.json, so clusterer drift cannot move the §7.5 table.
 * Default: units are appended after every record row (they arrive late, as in replay).
 * unitsInline: each unit row sits right after the row it was created at, and seqs are renumbered 1..N.
 */
export function oauthCanvasRows(options: { unitsInline?: boolean } = {}): {
  meta: TraceSessionSummary;
  rows: TraceRow[];
} {
  const fixture = loadFixtureTrace("oauth");
  const records = fixture.rows.filter((row) => row.type !== "change_unit");
  const units: TraceRow[] = [];
  const after = new Map<number, TraceRow[]>();
  let seq = records.reduce((max, row) => Math.max(max, row.seq), 0);
  for (const expected of expectedUnits()) {
    const locate = UNIT_START[expected.id];
    const origin = locate === undefined ? undefined : records.find((row) => locate(row, payloadOf(row)));
    const createdAt = origin === undefined ? undefined : payloadOf(origin).ts;
    if (origin === undefined || typeof createdAt !== "string") {
      throw new Error(`oauth unit ${expected.id} has no start row`);
    }
    const unit: ChangeUnit = {
      id: expected.id,
      sessionId: fixture.meta.sessionId,
      title: expected.title,
      category: expected.category,
      status: "detected",
      files: [...expected.files],
      symbols: [],
      interfacesChanged: [],
      schemaChanges: [],
      dependencyChanges: [],
      relatedDecisions: RELATED_DECISIONS[expected.id] ?? [],
      validationResults: [],
      evidence: unitEvidence(expected, records),
      createdAt,
      updatedAt: createdAt,
    };
    seq += 1;
    const row: TraceRow = { seq, type: "change_unit", ts: createdAt, payload: unit };
    units.push(row);
    const list = after.get(origin.seq) ?? [];
    list.push(row);
    after.set(origin.seq, list);
  }
  if (options.unitsInline !== true) return { meta: fixture.meta, rows: [...records, ...units] };
  const ordered: TraceRow[] = [];
  for (const row of records) {
    ordered.push(row);
    for (const unit of after.get(row.seq) ?? []) ordered.push(unit);
  }
  return { meta: fixture.meta, rows: ordered.map((row, index) => ({ ...row, seq: index + 1 })) };
}

/** Folds the first `count` rows; running until the last row arrives. */
export function foldCanvasPrefix(meta: TraceSessionSummary, rows: readonly TraceRow[], count: number): TraceSession {
  const slice = rows.slice(0, count);
  const done = count >= rows.length;
  return foldRows({ ...meta, state: done ? meta.state : "running" }, slice, {
    live: !done,
    state: done ? meta.state : "running",
    throughSeq: slice.at(-1)?.seq ?? 0,
  });
}

export function oauthCanvasSession(): TraceSession {
  const { meta, rows } = oauthCanvasRows();
  return foldRows(meta, rows, { live: false });
}

export function oauthCanvasBundle(): TraceBundle {
  const { meta, rows } = oauthCanvasRows({ unitsInline: true });
  return {
    format: TRACE_BUNDLE_FORMAT,
    version: TRACE_BUNDLE_VERSION,
    exportedAt: meta.startedAt,
    redactionCount: 0,
    session: { ...meta, lastEventSeq: rows.at(-1)?.seq ?? 0 },
    rows,
  };
}
```

Also add `import { loadFixtureTrace } from "./fixture-rows.js";` after the `fast-check` import. `ChangeUnit.symbols` and the other arrays match `ChangeUnitSchema` in `packages/contracts/src/semantic.ts:165-190`; `agentCallIds` (W0-4) is optional and omitted.

- [ ] **Step 3: Write the failing example tests**

Create `packages/trace-viewer/src/layout/canvas-layout.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { Level, TraceSession } from "../model/index.js";
import {
  buildCanvasSession,
  canvasScale,
  foldCanvasPrefix,
  oauthCanvasRows,
  oauthCanvasSession,
} from "../test-support/canvas-arbitraries.js";
import { canvasXMap, collectItems, layoutCanvas, type CanvasLayout } from "./canvas-layout.js";
import { buildTraceIndex } from "./trace-index.js";

function fresh(session: TraceSession, level: Level = "chapter", prev?: CanvasLayout): CanvasLayout {
  return layoutCanvas(session, buildTraceIndex(session), canvasScale(session), level, prev);
}

/** Frame name → slot origin, named as in the spec §7.5 table. */
function tableOf(layout: CanvasLayout): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const frame of layout.frames) {
    const name =
      frame.kind === "noise" && frame.members.length > 1
        ? `noise×${frame.members.length}`
        : frame.kind === "story"
          ? frame.item
          : frame.selId.replace(/^unit:/, "");
    out[name] = [frame.slot.x, frame.slot.y];
  }
  return out;
}

// Spec §7.5 "Expected oauth layout at Chapter level".
const OAUTH_TABLE: Record<string, [number, number]> = {
  intent: [0, 0],
  plan: [264, 0],
  "oauth-dependency": [264, 150],
  "oauth-identity-layer": [264, 300],
  "oauth-migration": [264, 450],
  "noise×2": [264, 600],
  decision: [528, 0],
  "oauth-account-linking-decision": [528, 150],
  "oauth-linking-test-failure": [528, 300],
  claim: [792, 0],
};

function slots(layout: CanvasLayout): Map<string, string> {
  return new Map(layout.frames.map((frame) => [frame.key, JSON.stringify(frame.slot)]));
}

describe("layoutCanvas on oauth", () => {
  it("matches the spec §7.5 table from a fresh layout", () => {
    const layout = fresh(oauthCanvasSession());
    expect(tableOf(layout)).toEqual(OAUTH_TABLE);
    expect(layout.bounds).toEqual({ x: 0, y: 0, w: 1016, h: 658 });
    expect(layout.columns.map((column) => column.x)).toEqual([0, 264, 528, 792]);
    expect(layout.stats).toMatchObject({ late: 0, holes: 0, rMaxExceeded: 0 });
  });

  it("keeps every placed key's slot under a one-row drip of oauth", () => {
    const { meta, rows } = oauthCanvasRows();
    let prev: CanvasLayout | undefined;
    for (let count = 1; count <= rows.length; count += 1) {
      const session = foldCanvasPrefix(meta, rows, count);
      const next = layoutCanvas(session, buildTraceIndex(session), canvasScale(session), "chapter", prev);
      if (prev !== undefined) {
        const before = slots(prev);
        for (const [key, slot] of slots(next)) {
          if (before.has(key)) expect(slot, `${key} after row ${count}`).toBe(before.get(key));
        }
      }
      prev = next;
    }
    if (prev === undefined) throw new Error("oauth has no rows");
    // Units arrive after their facts (as in replay), so chapters are placed late: each lands in
    // the time column the fresh table gives it, below whatever arrived there first.
    const table = fresh(oauthCanvasSession());
    for (const frame of table.frames) {
      const dripped = prev.frames.find((candidate) => candidate.selId === frame.selId && candidate.kind === frame.kind);
      expect(dripped?.col, frame.selId).toBe(frame.col);
    }
  });

  it("places the same table when unit rows arrive inline", () => {
    const { meta, rows } = oauthCanvasRows({ unitsInline: true });
    const session = foldCanvasPrefix(meta, rows, rows.length);
    expect(tableOf(fresh(session))).toEqual(OAUTH_TABLE);
  });

  it("fits in two columns at Session level", () => {
    const layout = fresh(oauthCanvasSession(), "session");
    expect(layout.columns).toHaveLength(2);
    expect(layout.bounds).toEqual({ x: 0, y: 0, w: 360, h: 324 });
  });
});

describe("layoutCanvas stickiness", () => {
  const seeds = [
    { atMs: 8_000, kind: "plan" as const },
    { atMs: 10_000, kind: "chapter" as const },
    { atMs: 15_000, kind: "chapter" as const },
    { atMs: 21_000, kind: "noise" as const },
    { atMs: 22_000, kind: "noise" as const },
  ];

  it("a unit whose id changes keeps its key, rect and selection", () => {
    const before = buildCanvasSession(seeds);
    const first = fresh(before);
    const target = before.chapters[0];
    if (target === undefined) throw new Error("no chapter");
    const renamed: TraceSession = structuredClone(before);
    const chapter = renamed.chapters[0];
    const step = renamed.steps.find((candidate) => candidate.id === target.stepIds[0]);
    if (chapter === undefined || step === undefined) throw new Error("no chapter");
    chapter.id = "unit:c3-v2";
    chapter.changeUnitId = "c3-v2";
    step.chapterIds = ["unit:c3-v2"];
    const next = fresh(renamed, "chapter", first);
    const key = "ch:3";
    expect(next.frameByKey.get(key)?.selId).toBe("unit:c3-v2");
    expect(next.frameByKey.get(key)?.slot).toEqual(first.frameByKey.get(key)?.slot);
    expect(next.readingOrder.indexOf("unit:c3-v2")).toBe(first.readingOrder.indexOf("unit:c3"));
  });

  it("a chapter that becomes noise renders in its own slot", () => {
    const before = buildCanvasSession(seeds);
    const first = fresh(before);
    const flipped: TraceSession = structuredClone(before);
    const chapter = flipped.chapters[0];
    if (chapter === undefined) throw new Error("no chapter");
    chapter.noise = true;
    const next = fresh(flipped, "chapter", first);
    expect(next.frameByKey.get("ch:3")).toMatchObject({ kind: "noise", members: ["ch:3"] });
    expect(next.frameByKey.get("ch:3")?.slot).toEqual(first.frameByKey.get("ch:3")?.slot);
    expect(next.stats.holes).toBe(0);
  });

  it("a noise item that becomes a chapter lands at the bottom of its column", () => {
    const before = buildCanvasSession(seeds);
    const first = fresh(before);
    const stack = first.frames.find((frame) => frame.kind === "noise");
    if (stack === undefined) throw new Error("no stack");
    const flipped: TraceSession = structuredClone(before);
    const noise = flipped.chapters.find((chapter) => chapter.noise);
    if (noise === undefined) throw new Error("no noise chapter");
    noise.noise = false;
    const next = fresh(flipped, "chapter", first);
    const moved = next.frames.find((frame) => frame.selId === noise.id && frame.kind === "chapter");
    expect(moved?.late).toBe(true);
    expect(moved?.col).toBe(stack.col);
    expect(moved?.slot.y).toBe(stack.slot.y + stack.slot.h + 16);
    expect(next.frameByKey.get(stack.key)?.slot).toEqual(stack.slot);
    expect(next.frameByKey.get(stack.key)?.members).toHaveLength(1);
  });

  it("re-running on the same session changes nothing", () => {
    const session = buildCanvasSession(seeds);
    const first = fresh(session);
    expect(fresh(session, "chapter", first)).toEqual(first);
  });
});

describe("turns and breaks", () => {
  it("a steer after 14 idle minutes yields one separator labelled with turn and idle time", () => {
    const session = buildCanvasSession([
      { atMs: 1_000, kind: "chapter" },
      { atMs: 1_500 + 14 * 60_000, kind: "prompt", trigger: "steer", prompt: "Use the other API" },
      { atMs: 1_500 + 14 * 60_000 + 2_000, kind: "chapter" },
    ]);
    const layout = fresh(session);
    expect(layout.separators).toHaveLength(1);
    expect(layout.separators[0]).toMatchObject({ kind: "turn", turn: 1, label: "Turn 2 · steer · after 14 min" });
  });

  it("a 5-minute test command alone makes no break", () => {
    const session = buildCanvasSession([
      { atMs: 1_000, kind: "chapter" },
      { atMs: 2_000, kind: "work", durationMs: 300_000 },
      { atMs: 302_500, kind: "chapter" },
    ]);
    expect(fresh(session).separators).toEqual([]);
  });

  it("an idle gap of five minutes with no work opens a break", () => {
    const session = buildCanvasSession([
      { atMs: 1_000, kind: "chapter" },
      { atMs: 302_500, kind: "chapter" },
    ]);
    expect(fresh(session).separators).toEqual([expect.objectContaining({ kind: "break", label: "⫽ 5 min" })]);
  });

  it("lays out a session with no chapters from story and loose frames", () => {
    const session = buildCanvasSession([
      { atMs: 2_000, kind: "loose" },
      { atMs: 9_000, kind: "loose" },
      { atMs: 12_000, kind: "claim", flagged: true },
    ]);
    const layout = fresh(session);
    expect(layout.frames.map((frame) => frame.kind)).toEqual(["story", "loose", "loose", "story"]);
    expect(layout.stats.holes).toBe(0);
  });
});

describe("canvasXMap", () => {
  it("is monotone and inverts at every item start", () => {
    const session = oauthCanvasSession();
    const scale = canvasScale(session);
    const layout = fresh(session);
    const map = canvasXMap(layout, scale);
    let previous = -Infinity;
    for (let t = 0; t <= 45_000; t += 250) {
      const x = map.xOf(t);
      expect(x).toBeGreaterThanOrEqual(previous);
      previous = x;
    }
    for (const item of collectItems(session, buildTraceIndex(session))) {
      expect(Math.abs(map.tOf(map.xOf(item.start)) - item.start)).toBeLessThan(1e-3);
    }
    expect(map.xOf(43_000)).toBe(792);
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/canvas-layout.test.ts`
Expected: FAIL with `SyntaxError: The requested module './canvas-layout.js' does not provide an export named 'canvasXMap'` (or vitest's equivalent "is not a function" for `layoutCanvas`).

- [ ] **Step 5: Append placement to `canvas-layout.ts`**

In `packages/trace-viewer/src/layout/canvas-layout.ts`, replace the import block:

```ts
import type { Finding, FindingId, Step, TraceSession, Turn } from "../model/index.js";
import { stepFinder, type CanvasItemKind } from "./canvas-levels.js";
import { worstSeverity } from "./tone.js";
import type { SelectionId, TraceIndex } from "./trace-index.js";
```

with:

```ts
import type { Finding, FindingId, Level, Step, TraceSession, Turn } from "../model/index.js";
import type { CanvasEdge } from "./canvas-routes.js";
import {
  LABEL_ROW_PX,
  LEVEL_SPECS,
  frameSize,
  isStoryKind,
  stepFinder,
  type CanvasItemKind,
  type LevelSpec,
} from "./canvas-levels.js";
import type { TimeScale, XMap } from "./time-scale.js";
import { worstSeverity } from "./tone.js";
import type { SelectionId, TraceIndex } from "./trace-index.js";
import type { Point, Rect } from "./viewport.js";
```

and append to the end of the file:

```ts
// ------------------------------------------------------------ public layout types

export interface CanvasFrame {
  key: string;
  selId: SelectionId;
  kind: "story" | "chapter" | "noise" | "loose";
  item: CanvasItemKind;
  col: number;
  row: number;
  slot: Rect;
  card: Rect;
  label: Rect | null;
  /** Noise stack members (item keys); [key] otherwise. */
  members: readonly string[];
  /** Selection ids of `members`, same order. */
  memberSelIds: readonly SelectionId[];
  late: boolean;
}

export interface CanvasColumn {
  key: string;
  index: number;
  x: number;
  t0: number;
  turn: number;
}

export interface CanvasSeparator {
  kind: "turn" | "break";
  x: number;
  t: number;
  turn: number;
  label: string;
}

export interface TimeBreakpoint {
  t: number;
  xIn: number;
  xOut: number;
}

export interface CanvasLayoutStats {
  late: number;
  rMaxExceeded: number;
  holes: number;
  hiddenEdges: number;
}

declare const layoutStateBrand: unique symbol;
export interface CanvasLayoutState {
  readonly [layoutStateBrand]: true;
}

export interface CanvasLayout {
  level: Level;
  sessionId: string;
  frames: readonly CanvasFrame[];
  frameByKey: ReadonlyMap<string, CanvasFrame>;
  holes: readonly Rect[];
  columns: readonly CanvasColumn[];
  separators: readonly CanvasSeparator[];
  edges: readonly CanvasEdge[];
  junctions: readonly Point[];
  time: { bps: readonly TimeBreakpoint[]; pps: number };
  bounds: Rect;
  /** Columns left → right; story cells, then work rows top → bottom. */
  readingOrder: readonly SelectionId[];
  stats: CanvasLayoutStats;
  state: CanvasLayoutState;
}

// ------------------------------------------------------------ opaque sticky state (plain data, deep-equal friendly)

interface Slot {
  id: string;
  stack: boolean;
  band: "story" | "work";
  placedAs: CanvasItemKind;
  col: number;
  row: number;
  x: number;
  y: number;
  w: number;
  h: number;
  members: string[];
  late: boolean;
}

interface ColumnState {
  key: string;
  index: number;
  x: number;
  t0: number;
  turn: number;
  story: number;
  workY: number;
  workRows: number;
  noiseSlot: string | null;
}

interface SeparatorState {
  kind: "turn" | "break";
  x: number;
  t: number;
  turn: number;
  idleMs: number;
}

interface StateData {
  level: Level;
  sessionId: string;
  cols: ColumnState[];
  slots: Slot[];
  /** Item key → slot id. */
  memberSlot: Record<string, string>;
  bps: TimeBreakpoint[];
  seps: SeparatorState[];
  rMaxExceeded: number;
}

function packState(data: StateData): CanvasLayoutState {
  return data as unknown as CanvasLayoutState;
}

function unpackState(state: CanvasLayoutState): StateData {
  return state as unknown as StateData;
}

function emptyState(level: Level, sessionId: string): StateData {
  return { level, sessionId, cols: [], slots: [], memberSlot: {}, bps: [], seps: [], rMaxExceeded: 0 };
}

function cloneState(data: StateData): StateData {
  return {
    level: data.level,
    sessionId: data.sessionId,
    cols: data.cols.map((col) => ({ ...col })),
    slots: data.slots.map((slot) => ({ ...slot, members: [...slot.members] })),
    memberSlot: { ...data.memberSlot },
    bps: data.bps.map((bp) => ({ ...bp })),
    seps: data.seps.map((sep) => ({ ...sep })),
    rMaxExceeded: data.rMaxExceeded,
  };
}

// ------------------------------------------------------------ placement (spec §7.5 "Column map")

interface Run {
  st: StateData;
  spec: LevelSpec;
  scale: TimeScale;
  slotById: Map<string, Slot>;
}

function advance(run: Run, t: number): number {
  const last = run.st.bps.at(-1);
  if (last === undefined) return 0;
  const du = Math.max(0, run.scale.toU(t) - run.scale.toU(last.t));
  return last.xOut + Math.min((du / 1_000) * run.spec.pps, run.spec.pitch + run.spec.slack);
}

function fits(col: ColumnState, item: CanvasItem, x: number, spec: LevelSpec): boolean {
  if (x >= col.x + spec.pitch) return false;
  return item.band === "story" ? col.story < spec.storyCap : col.workRows < spec.rMax;
}

/** Last column with t0 ≤ t; column 0 when none. */
function columnAt(cols: readonly ColumnState[], t: number): ColumnState {
  let lo = 0;
  let hi = cols.length - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const col = cols[mid];
    if (col !== undefined && col.t0 <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const col = cols[found];
  if (col === undefined) throw new Error("columnAt on an empty layout");
  return col;
}

function openColumn(run: Run, item: CanvasItem, x: number, sep: "turn" | "break" | null, idleMs: number): ColumnState {
  const { st, spec } = run;
  const prev = st.cols.at(-1);
  const gap = sep === "turn" ? spec.turnGap : sep === "break" ? spec.breakGap : spec.colGap;
  // Whole world px keep column gaps exact and cards crisp; ceil keeps xOut ≥ xIn, so the time map stays monotone.
  const cx = prev === undefined ? 0 : Math.max(Math.ceil(x), prev.x + spec.w + gap);
  const col: ColumnState = {
    key: `col:${item.key}`,
    index: st.cols.length,
    x: cx,
    t0: item.start,
    turn: item.turn,
    story: 0,
    workY: spec.workTop,
    workRows: 0,
    noiseSlot: null,
  };
  st.cols.push(col);
  if (prev !== undefined && sep !== null) {
    st.seps.push({ kind: sep, x: (prev.x + spec.w + cx) / 2, t: item.start, turn: item.turn, idleMs });
  }
  return col;
}

function putItem(run: Run, col: ColumnState, item: CanvasItem, late: boolean): void {
  const { st, spec, slotById } = run;
  if (item.kind === "noise" && col.noiseSlot !== null) {
    const stack = slotById.get(col.noiseSlot);
    if (stack !== undefined) {
      stack.members.push(item.key);
      st.memberSlot[item.key] = stack.id;
      return;
    }
  }
  const size = frameSize(spec.level, item.kind);
  let slot: Slot;
  if (item.band === "story" && col.story < spec.storyCap) {
    slot = {
      id: item.key,
      stack: false,
      band: "story",
      placedAs: item.kind,
      col: col.index,
      row: col.story,
      x: col.x,
      y: col.story * (spec.h.story + spec.rowGap),
      w: size.w,
      h: size.h,
      members: [item.key],
      late,
    };
    col.story += 1;
  } else {
    const stack = item.kind === "noise";
    slot = {
      id: stack ? `stack:${item.key}` : item.key,
      stack,
      band: "work",
      placedAs: item.kind,
      col: col.index,
      row: spec.storyCap + col.workRows,
      x: col.x,
      y: col.workY,
      w: size.w,
      h: size.h,
      members: [item.key],
      late,
    };
    col.workY += size.h + spec.rowGap;
    col.workRows += 1;
    if (stack) col.noiseSlot = slot.id;
    if (col.workRows > spec.rMax) st.rMaxExceeded += 1;
  }
  st.slots.push(slot);
  slotById.set(slot.id, slot);
  st.memberSlot[item.key] = slot.id;
}

function placeItem(run: Run, item: CanvasItem): void {
  const { st, spec, scale } = run;
  const front = st.cols.at(-1);
  const last = st.bps.at(-1);
  // Late (deviation 6): earlier than the last breakpoint; goes to its own time column, pushes no breakpoint.
  if (front !== undefined && last !== undefined && item.start < last.t) {
    putItem(run, columnAt(st.cols, item.start), item, true);
    return;
  }
  const x = advance(run, item.start);
  let sep: "turn" | "break" | null = null;
  let idleMs = 0;
  if (front !== undefined && last !== undefined) {
    const u0 = scale.toU(last.t);
    const u1 = scale.toU(item.start);
    // A break needs at least breakMinMs of real time between the two starts; most items are closer.
    const breaks =
      item.start - last.t >= spec.breakMinMs
        ? scale.breaks(u0, u1, spec.breakMinMs).filter((seg) => seg.u1 > u0 && seg.u0 < u1)
        : [];
    idleMs = breaks.reduce((sum, seg) => sum + (seg.idle?.ms ?? 0), 0);
    sep = item.turn !== front.turn ? "turn" : breaks.length > 0 ? "break" : null;
  }
  const joinable = front !== undefined && sep === null && (item.kind === "noise" || fits(front, item, x, spec));
  const col = joinable ? front : openColumn(run, item, x, sep, idleMs);
  putItem(run, col, item, false);
  st.bps.push({ t: item.start, xIn: x, xOut: joinable ? x : col.x });
}

// ------------------------------------------------------------ finalize

export function formatIdle(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1_000))} s`;
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

function separatorLabel(sep: SeparatorState, session: TraceSession, spec: LevelSpec): string {
  if (sep.kind === "break") return `⫽ ${formatIdle(sep.idleMs)}`;
  const trigger = session.turns.find((turn) => turn.index === sep.turn)?.trigger ?? "resume";
  const idle = sep.idleMs >= spec.breakMinMs ? ` · after ${formatIdle(sep.idleMs)}` : "";
  return `Turn ${sep.turn + 1} · ${trigger}${idle}`;
}

function frameKindOf(item: CanvasItemKind): CanvasFrame["kind"] {
  if (isStoryKind(item)) return "story";
  if (item === "chapter") return "chapter";
  if (item === "noise") return "noise";
  return "loose";
}

function finalize(run: Run, session: TraceSession, itemByKey: ReadonlyMap<string, CanvasItem>): CanvasLayout {
  const { st, spec } = run;
  const frames: CanvasFrame[] = [];
  const holes: Rect[] = [];
  let right = 0;
  let bottom = 0;
  for (const slot of st.slots) {
    const slotRect: Rect = { x: slot.x, y: slot.y, w: slot.w, h: slot.h };
    right = Math.max(right, slot.x + slot.w);
    bottom = Math.max(bottom, slot.y + slot.h);
    const live = slot.members
      .map((key) => itemByKey.get(key))
      .filter((item): item is CanvasItem => item !== undefined);
    const head = live[0];
    if (head === undefined) {
      holes.push(slotRect);
      continue;
    }
    const item: CanvasItemKind = slot.stack ? "noise" : head.kind;
    frames.push({
      key: slot.id,
      selId: head.selId,
      kind: frameKindOf(item),
      item,
      col: slot.col,
      row: slot.row,
      slot: slotRect,
      card: { x: slot.x, y: slot.y + spec.labelH, w: slot.w, h: slot.h - spec.labelH },
      label: spec.labelH > 0 ? { x: slot.x, y: slot.y, w: slot.w, h: LABEL_ROW_PX } : null,
      members: live.map((member) => member.key),
      memberSelIds: live.map((member) => member.selId),
      late: slot.late,
    });
  }
  frames.sort((a, b) => a.col - b.col || a.row - b.row);
  const readingOrder: SelectionId[] = [];
  const seen = new Set<SelectionId>();
  for (const frame of frames) {
    for (const selId of frame.memberSelIds) {
      if (seen.has(selId)) continue;
      seen.add(selId);
      readingOrder.push(selId);
    }
  }
  const columns: CanvasColumn[] = st.cols.map((col) => ({
    key: col.key,
    index: col.index,
    x: col.x,
    t0: col.t0,
    turn: col.turn,
  }));
  const frameByKey = new Map(frames.map((frame) => [frame.key, frame]));
  // C3-3 replaces this block with routeEdges.
  const edges: CanvasEdge[] = [];
  const junctions: Point[] = [];
  const hiddenEdges = 0;
  return {
    level: st.level,
    sessionId: st.sessionId,
    frames,
    frameByKey,
    holes,
    columns,
    separators: st.seps.map((sep) => ({
      kind: sep.kind,
      x: sep.x,
      t: sep.t,
      turn: sep.turn,
      label: separatorLabel(sep, session, spec),
    })),
    edges,
    junctions,
    time: { bps: st.bps.map((bp) => ({ ...bp })), pps: spec.pps },
    bounds: { x: 0, y: 0, w: right, h: bottom },
    readingOrder,
    stats: {
      late: frames.filter((frame) => frame.late).length,
      rMaxExceeded: st.rMaxExceeded,
      holes: holes.length,
      hiddenEdges,
    },
    state: packState(st),
  };
}

/** Pure, deterministic and sticky (spec §7.5; P1–P10). A different level or session lays out fresh. */
export function layoutCanvas(
  session: TraceSession,
  index: TraceIndex,
  scale: TimeScale,
  level: Level,
  prev?: CanvasLayout,
): CanvasLayout {
  const spec = LEVEL_SPECS[level];
  const sessionId = session.meta.sessionId;
  const st =
    prev !== undefined && prev.level === level && prev.sessionId === sessionId
      ? cloneState(unpackState(prev.state))
      : emptyState(level, sessionId);
  const run: Run = { st, spec, scale, slotById: new Map(st.slots.map((slot) => [slot.id, slot])) };
  const items = collectItems(session, index);
  const itemByKey = new Map(items.map((item) => [item.key, item]));
  for (const item of items) {
    const slotId = st.memberSlot[item.key];
    const slot = slotId === undefined ? undefined : run.slotById.get(slotId);
    if (slot === undefined) {
      placeItem(run, item);
      continue;
    }
    if (slot.stack && item.kind !== "noise") {
      // A noise item that became a chapter leaves its stack and lands late at the bottom of its column.
      slot.members = slot.members.filter((key) => key !== item.key);
      delete st.memberSlot[item.key];
      const col = st.cols[slot.col];
      if (col !== undefined) putItem(run, col, item, true);
    }
  }
  return finalize(run, session, itemByKey);
}

/** World x ↔ display time over the breakpoints, linear in toU between them, pps past the last. */
export function canvasXMap(layout: CanvasLayout, scale: TimeScale): XMap {
  const bps = layout.time.bps;
  const perU = layout.time.pps / 1_000;
  const us = bps.map((bp) => scale.toU(bp.t));
  const lastAtOrBefore = (tMs: number): number => {
    let lo = 0;
    let hi = bps.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((bps[mid]?.t ?? Infinity) <= tMs) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  };
  const xOf = (tMs: number): number => {
    const first = bps[0];
    const u0 = us[0];
    const u = scale.toU(tMs);
    if (first === undefined || u0 === undefined) return u * perU;
    const i = lastAtOrBefore(tMs);
    if (i < 0) return first.xOut - (u0 - u) * perU;
    const bp = bps[i];
    const ui = us[i];
    if (bp === undefined || ui === undefined) return u * perU;
    const next = bps[i + 1];
    const un = us[i + 1];
    if (next === undefined || un === undefined) return bp.xOut + (u - ui) * perU;
    if (un <= ui) return bp.xOut;
    return bp.xOut + ((u - ui) / (un - ui)) * (next.xIn - bp.xOut);
  };
  const tOf = (x: number): number => {
    const first = bps[0];
    const u0 = us[0];
    if (first === undefined || u0 === undefined) return scale.toT(x / perU);
    if (x <= first.xOut) return scale.toT(u0 - (first.xOut - x) / perU);
    let lo = 0;
    let hi = bps.length - 1;
    let i = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((bps[mid]?.xOut ?? Infinity) <= x) {
        i = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const bp = bps[i];
    const ui = us[i];
    if (bp === undefined || ui === undefined) return scale.toT(u0);
    const next = bps[i + 1];
    const un = us[i + 1];
    if (next === undefined || un === undefined) return scale.toT(ui + (x - bp.xOut) / perU);
    if (x >= next.xIn) return next.t; // inside the push [xIn, xOut) of the next breakpoint
    if (next.xIn <= bp.xOut) return bp.t;
    return scale.toT(ui + ((x - bp.xOut) / (next.xIn - bp.xOut)) * (un - ui));
  };
  return { xOf, tOf };
}
```


- [ ] **Step 6: Run the example tests to verify they pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/canvas-layout.test.ts`
Expected: PASS, `Tests  13 passed (13)`. If the oauth table differs, print `tableOf(layout)` and compare with the spec §7.5 derivation (Plan: x = 8 s · 8 px/s = 64, pushed to 264; Decision 25 s: x = 400, pushed to 528; Claim 43 s: x = 672, pushed to 792) before changing any code: a mismatch in chapter times means B's `Chapter.tMs` is not `offset(origin, unit.createdAt)` and must be escalated, not patched here.

- [ ] **Step 7: Write the property tests P1–P8 and P10**

Create `packages/trace-viewer/src/layout/canvas-layout.property.test.ts`:

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { Level, TraceSession } from "../model/index.js";
import {
  arbCanvasMutation,
  arbCanvasSession,
  canvasPrefix,
  canvasScale,
  mutateCanvasSession,
} from "../test-support/canvas-arbitraries.js";
import { LEVEL_SPECS, frameSize } from "./canvas-levels.js";
import { canvasXMap, collectItems, layoutCanvas, type CanvasItem, type CanvasLayout } from "./canvas-layout.js";
import { buildTraceIndex } from "./trace-index.js";
import type { Rect } from "./viewport.js";

// Spec §7.5 invariants P1–P10 (P9 is added by C3-3).

const levels = fc.constantFrom<Level>("session", "chapter", "step");
const RUNS = { numRuns: 150 };

function fresh(session: TraceSession, level: Level, prev?: CanvasLayout): CanvasLayout {
  return layoutCanvas(session, buildTraceIndex(session), canvasScale(session), level, prev);
}

function itemsOf(session: TraceSession): Map<string, CanvasItem> {
  return new Map(collectItems(session, buildTraceIndex(session)).map((item) => [item.key, item]));
}

function gap(a: Rect, b: Rect): { dx: number; dy: number } {
  const dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
  const dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
  return { dx, dy };
}

function checkP1(layout: CanvasLayout): void {
  const spec = LEVEL_SPECS[layout.level];
  const rects = [...layout.frames.map((frame) => ({ rect: frame.slot, col: frame.col })), ...layout.holes.map((rect) => ({ rect, col: -1 }))];
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i];
      const b = rects[j];
      if (a === undefined || b === undefined) continue;
      const { dx, dy } = gap(a.rect, b.rect);
      expect(dx > 0 || dy > 0, "slots overlap").toBe(true);
      if (a.rect.x === b.rect.x) expect(dy).toBeGreaterThanOrEqual(spec.rowGap);
      else expect(dx).toBeGreaterThanOrEqual(spec.colGap);
    }
  }
}

function colOfItem(layout: CanvasLayout): Map<string, { col: number; x: number }> {
  const out = new Map<string, { col: number; x: number }>();
  for (const frame of layout.frames) for (const key of frame.members) out.set(key, { col: frame.col, x: frame.slot.x });
  return out;
}

function checkP2(layout: CanvasLayout, items: Map<string, CanvasItem>): void {
  const placed = [...colOfItem(layout)]
    .map(([key, at]) => ({ start: items.get(key)?.start ?? NaN, ...at }))
    .sort((a, b) => a.start - b.start);
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      const a = placed[i];
      const b = placed[j];
      if (a === undefined || b === undefined || !(a.start < b.start)) continue;
      expect(a.col).toBeLessThanOrEqual(b.col);
      expect(a.x).toBeLessThanOrEqual(b.x);
    }
  }
}

function checkP3(layout: CanvasLayout, session: TraceSession, items: Map<string, CanvasItem>): void {
  const map = canvasXMap(layout, canvasScale(session));
  const first = layout.columns[0];
  for (const frame of layout.frames) {
    for (const key of frame.members) {
      const item = items.get(key);
      if (item === undefined || first === undefined || item.start < first.t0) continue;
      const column = layout.columns[frame.col];
      const next = layout.columns[frame.col + 1];
      const x = map.xOf(item.start);
      // At a push the map jumps from the first breakpoint's xIn to the last breakpoint's xOut at that time,
      // so items that share a start and open several columns all sit inside the jump.
      const atStart = layout.time.bps.filter((bp) => bp.t === item.start);
      const left = Math.min(x, ...atStart.map((bp) => bp.xIn));
      if (column !== undefined) expect(x).toBeGreaterThanOrEqual(column.x - 1e-6);
      if (next !== undefined) expect(left).toBeLessThanOrEqual(next.x + 1e-6);
      if (!frame.late) expect(Math.abs(map.tOf(x) - item.start)).toBeLessThan(1e-3);
    }
  }
  const starts = [...items.values()].map((item) => item.start).sort((a, b) => a - b);
  for (let i = 1; i < starts.length; i += 1) {
    expect(map.xOf(starts[i] ?? 0)).toBeGreaterThanOrEqual(map.xOf(starts[i - 1] ?? 0) - 1e-6);
  }
}

function checkP4(layout: CanvasLayout, session: TraceSession, items: Map<string, CanvasItem>): void {
  const spec = LEVEL_SPECS[layout.level];
  const scale = canvasScale(session);
  for (const frame of layout.frames) {
    const column = layout.columns[frame.col];
    for (const key of frame.members) expect(items.get(key)?.turn).toBe(column?.turn);
  }
  for (const sep of layout.separators) {
    const next = layout.columns.find((column) => column.x > sep.x);
    const prev = [...layout.columns].reverse().find((column) => column.x < sep.x);
    if (prev !== undefined) expect(prev.x + spec.w).toBeLessThan(sep.x);
    if (next !== undefined) expect(sep.x).toBeLessThan(next.x);
  }
  for (const column of layout.columns) {
    const starts = [
      ...new Set(
        layout.frames
          .filter((frame) => frame.col === column.index)
          .flatMap((frame) => frame.members.map((key) => items.get(key)?.start ?? column.t0)),
      ),
    ].sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i += 1) {
      if ((starts[i] ?? 0) - (starts[i - 1] ?? 0) < spec.breakMinMs) continue;
      const u0 = scale.toU(starts[i - 1] ?? 0);
      const u1 = scale.toU(starts[i] ?? 0);
      const inside = scale.breaks(u0, u1, spec.breakMinMs).filter((seg) => seg.u1 > u0 && seg.u0 < u1);
      expect(inside, `column ${column.index} spans a break`).toEqual([]);
    }
  }
}

function checkP8(layout: CanvasLayout, items: Map<string, CanvasItem>): void {
  const members = layout.frames.flatMap((frame) => frame.members);
  expect(new Set(members).size).toBe(members.length);
  expect(new Set(members)).toEqual(new Set(items.keys()));
}

function checkP10(layout: CanvasLayout): void {
  for (const frame of layout.frames) {
    const size = frameSize(layout.level, frame.item);
    expect({ w: frame.slot.w, h: frame.slot.h }).toEqual(size);
  }
}

describe("canvas layout invariants", () => {
  it("P1 no overlap, fresh and after mutations", () => {
    fc.assert(
      fc.property(arbCanvasSession(), fc.array(arbCanvasMutation, { maxLength: 6 }), levels, (session, ops, level) => {
        const first = fresh(session, level);
        checkP1(first);
        checkP1(fresh(mutateCanvasSession(session, ops), level, first));
      }),
      RUNS,
    );
  });

  it("P2 monotone x versus start, fresh and sticky", () => {
    fc.assert(
      fc.property(arbCanvasSession(), fc.array(arbCanvasMutation, { maxLength: 6 }), levels, (session, ops, level) => {
        const first = fresh(session, level);
        checkP2(first, itemsOf(session));
        const mutated = mutateCanvasSession(session, ops);
        checkP2(fresh(mutated, level, first), itemsOf(mutated));
      }),
      RUNS,
    );
  });

  it("P3 the ruler is truthful", () => {
    fc.assert(
      fc.property(arbCanvasSession(), fc.array(arbCanvasMutation, { maxLength: 4 }), levels, (session, ops, level) => {
        const first = fresh(session, level);
        checkP3(first, session, itemsOf(session));
        const mutated = mutateCanvasSession(session, ops);
        checkP3(fresh(mutated, level, first), mutated, itemsOf(mutated));
      }),
      RUNS,
    );
  });

  it("P4 turns and breaks sit in gutters (fresh layouts)", () => {
    fc.assert(
      fc.property(arbCanvasSession(), levels, (session, level) => {
        checkP4(fresh(session, level), session, itemsOf(session));
      }),
      RUNS,
    );
  });

  it("P5 append equals fresh", () => {
    fc.assert(
      fc.property(arbCanvasSession(), fc.nat(), levels, (session, pick, level) => {
        const index = buildTraceIndex(session);
        const scale = canvasScale(session);
        const starts = [...new Set(collectItems(session, index).map((item) => item.start))].sort((a, b) => a - b);
        const cut = starts[pick % Math.max(1, starts.length)] ?? 0;
        const prefix = canvasPrefix(session, cut);
        const first = layoutCanvas(prefix, buildTraceIndex(prefix), scale, level);
        expect(layoutCanvas(session, index, scale, level, first)).toEqual(layoutCanvas(session, index, scale, level));
      }),
      RUNS,
    );
  });

  it("P6 sticky under churn, merges, flips, late arrivals and appends", () => {
    fc.assert(
      fc.property(arbCanvasSession(), fc.array(arbCanvasMutation, { maxLength: 6 }), levels, (session, ops, level) => {
        const first = fresh(session, level);
        const next = fresh(mutateCanvasSession(session, ops), level, first);
        for (const [key, frame] of first.frameByKey) {
          const after = next.frameByKey.get(key);
          if (after !== undefined) expect(after.slot, key).toEqual(frame.slot);
        }
        expect(next.time.bps.slice(0, first.time.bps.length)).toEqual(first.time.bps);
      }),
      RUNS,
    );
  });

  it("P7 deterministic, including shuffled chapters, steps and findings", () => {
    fc.assert(
      fc.property(arbCanvasSession(), levels, (session, level) => {
        const index = buildTraceIndex(session);
        const scale = canvasScale(session);
        const once = layoutCanvas(session, index, scale, level);
        expect(layoutCanvas(session, index, scale, level)).toEqual(once);
        const shuffled: TraceSession = {
          ...session,
          chapters: [...session.chapters].reverse(),
          steps: [...session.steps].reverse(),
          findings: [...session.findings].reverse(),
        };
        expect(layoutCanvas(shuffled, index, scale, level)).toEqual(once);
      }),
      RUNS,
    );
  });

  it("P8 every current item appears exactly once, fresh and sticky", () => {
    fc.assert(
      fc.property(arbCanvasSession(), fc.array(arbCanvasMutation, { maxLength: 6 }), levels, (session, ops, level) => {
        const first = fresh(session, level);
        checkP8(first, itemsOf(session));
        const mutated = mutateCanvasSession(session, ops);
        checkP8(fresh(mutated, level, first), itemsOf(mutated));
      }),
      RUNS,
    );
  });

  it("P10 slot size depends only on (level, kind) in fresh layouts", () => {
    fc.assert(fc.property(arbCanvasSession(), levels, (session, level) => checkP10(fresh(session, level))), RUNS);
  });
});
```

- [ ] **Step 8: Run the property tests**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/canvas-layout.property.test.ts`
Expected: PASS, `Tests  9 passed (9)`. A counterexample prints its seed and path: reproduce it with `fc.assert(..., { seed, path, numRuns: 1 })`, fix the algorithm (never weaken the check), and keep the shrunk session as a new example test in `canvas-layout.test.ts`.

- [ ] **Step 9: Typecheck, lint and root checks**

Run: `pnpm --filter @jevcode/trace-viewer typecheck && pnpm lint`, then the root checks.
Expected: all exit 0.

- [ ] **Step 10: Commit**

```bash
git add packages/trace-viewer/src/layout/canvas-layout.ts packages/trace-viewer/src/layout/canvas-routes.ts packages/trace-viewer/src/layout/canvas-layout.test.ts packages/trace-viewer/src/layout/canvas-layout.property.test.ts packages/trace-viewer/src/test-support/canvas-arbitraries.ts
git commit -m "feat(trace-viewer): sticky canvas placement over the shared time scale"
```

### Task C3-3: Edge routing (trunk comb, contradicts, decides, validates, lanes); P9

**Files:**
- Modify: `packages/trace-viewer/src/layout/canvas-routes.ts` (append the functions below the types)
- Create: `packages/trace-viewer/src/layout/canvas-routes.test.ts`
- Modify: `packages/trace-viewer/src/layout/canvas-layout.ts` (`finalize` calls `routeEdges`)
- Modify: `packages/trace-viewer/src/layout/canvas-layout.property.test.ts` (append P9 and P8 reachability)

**Interfaces:**
- Consumes: C3-2 `CanvasFrame`, `CanvasColumn`, `CanvasLayout`, `layoutCanvas`, `RouteInput`, `CanvasEdge`, `EdgeKind`, `EdgeShape`; C3-1 `LevelSpec`, `LEVEL_SPECS`, `stepFinder(steps: readonly Step[]): (id: string) => Step | undefined`; model `decisionStableId(id: string): DecisionStableId`, `Chapter`, `Step`, `StepId`, `FindingId`; C1-5 `Point`, `Rect`.
- Produces (UI index §2.1 plus helpers):

```ts
export function routeEdges(input: RouteInput): { edges: CanvasEdge[]; junctions: Point[]; hiddenEdges: number };
/** Loose frame, else story frame, else tests chapter for a test/check, else lowest-anchor chapter. */
export function homeFrameKey(stepId: StepId, input: RouteInput): string | undefined;
/** Cubic bezier between card edges; used for the selection's lane-less edges with a 3 px panel halo. */
export function directPath(a: Rect, b: Rect): string;
/** Points along an absolute M/L/H/V/C/Q path (tests and hit checks). */
export function samplePath(d: string, perSegment?: number): Point[];
/** Channel lane center y: storyBand + round(channelH · (lane + 1) / (channelLanes + 1)). */
export function laneY(spec: LevelSpec, lane: number): number;
export const RAIL_RADIUS_PX = 6;
```

- [ ] **Step 1: Write the failing route tests**

Create `packages/trace-viewer/src/layout/canvas-routes.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { Level, TraceSession } from "../model/index.js";
import { buildCanvasSession, canvasScale, oauthCanvasSession } from "../test-support/canvas-arbitraries.js";
import { layoutCanvas, type CanvasFrame, type CanvasLayout } from "./canvas-layout.js";
import { LEVEL_SPECS } from "./canvas-levels.js";
import { directPath, homeFrameKey, laneY, samplePath, type CanvasEdge, type RouteInput } from "./canvas-routes.js";
import { buildTraceIndex } from "./trace-index.js";

// Expected geometry: spec §7.5 "Expected oauth layout" paragraph and the §7.5 edge table.

function fresh(session: TraceSession, level: Level = "chapter"): CanvasLayout {
  return layoutCanvas(session, buildTraceIndex(session), canvasScale(session), level);
}

function frameOf(layout: CanvasLayout, predicate: (frame: CanvasFrame) => boolean): CanvasFrame {
  const frame = layout.frames.find(predicate);
  if (frame === undefined) throw new Error("frame not found");
  return frame;
}

function edge(layout: CanvasLayout, kind: CanvasEdge["kind"], from: string, to: string): CanvasEdge {
  const found = layout.edges.find((candidate) => candidate.kind === kind && candidate.from === from && candidate.to === to);
  if (found === undefined) throw new Error(`no ${kind} edge ${from} → ${to}`);
  return found;
}

function xRange(d: string | null): [number, number] {
  const xs = samplePath(d ?? "").map((point) => point.x);
  return [Math.min(...xs), Math.max(...xs)];
}

describe("routeEdges on oauth at Chapter level", () => {
  const layout = fresh(oauthCanvasSession());
  const decision = frameOf(layout, (frame) => frame.item === "decision");
  const claim = frameOf(layout, (frame) => frame.item === "claim");
  const identity = frameOf(layout, (frame) => frame.selId === "unit:oauth-identity-layer");
  const linking = frameOf(layout, (frame) => frame.selId === "unit:oauth-account-linking-decision");
  const linkingTest = frameOf(layout, (frame) => frame.selId === "unit:oauth-linking-test-failure");

  it("runs the trunk at y 124 from column 0 to column 3", () => {
    const trunk = layout.edges.find((candidate) => candidate.kind === "trunk");
    expect(laneY(LEVEL_SPECS.chapter, 0)).toBe(124);
    expect(trunk?.d?.startsWith("M112 124H904")).toBe(true);
    expect(trunk).toMatchObject({ shape: "comb", lane: 0, rest: true, tone: "neutral" });
    expect(layout.junctions).toEqual(expect.arrayContaining([{ x: 376, y: 124 }, { x: 640, y: 124 }]));
  });

  it("draws Decision → Linking policy stacked", () => {
    expect(edge(layout, "decides", decision.key, linking.key)).toMatchObject({ shape: "stacked", rest: true });
  });

  it("draws Identity → Decision as an adjacent S-curve in gutter 488–528", () => {
    const decides = edge(layout, "decides", decision.key, identity.key);
    expect(decides).toMatchObject({ shape: "adjacent", rest: true, tone: "neutral" });
    const [lo, hi] = xRange(decides.d);
    expect(lo).toBeGreaterThanOrEqual(488);
    expect(hi).toBeLessThanOrEqual(528);
  });

  it("draws Claim ≠ Linking test as the only red edge, adjacent in gutter 752–792 with the badge at (772, 224)", () => {
    const contradicts = edge(layout, "contradicts", claim.key, linkingTest.key);
    expect(contradicts).toMatchObject({ shape: "adjacent", tone: "bad", rest: true, badge: { x: 772, y: 224 } });
    expect(contradicts.findingId?.startsWith("finding:claim_contradicted@")).toBe(true);
    const [lo, hi] = xRange(contradicts.d);
    expect(lo).toBeGreaterThanOrEqual(752);
    expect(hi).toBeLessThanOrEqual(792);
    expect(layout.edges.filter((candidate) => candidate.tone === "bad")).toEqual([contradicts]);
    expect(layout.stats.hiddenEdges).toBe(0);
  });

  it("finds each step's home frame: loose, then story, then the tests chapter, then the lowest anchor", () => {
    const session = oauthCanvasSession();
    const input: RouteInput = {
      session,
      frames: layout.frames,
      frameByKey: layout.frameByKey,
      columns: layout.columns,
      spec: LEVEL_SPECS.chapter,
    };
    const testStep = session.steps.find((step) => step.command?.command === "pnpm test");
    const googleEdit = session.steps.find((step) => step.edit?.path === "src/auth/google.ts");
    expect(testStep === undefined ? undefined : homeFrameKey(testStep.id, input)).toBe(linkingTest.key);
    expect(homeFrameKey(claim.selId as `step:${number}`, input)).toBe(claim.key);
    // google.ts belongs to Identity layer (anchor 13) and Account linking (anchor 16): the lower anchor wins.
    expect(googleEdit === undefined ? undefined : homeFrameKey(googleEdit.id, input)).toBe(identity.key);
  });
});

describe("routeEdges rules", () => {
  it("draws only trunk and contradicts at rest at Session level", () => {
    const layout = fresh(oauthCanvasSession(), "session");
    const atRest = new Set(layout.edges.filter((candidate) => candidate.rest).map((candidate) => candidate.kind));
    expect([...atRest].sort()).toEqual(["contradicts", "trunk"]);
  });

  it("routes a decision to a chapter with frames between them through the left rail", () => {
    const layout = fresh(
      buildCanvasSession([
        { atMs: 1_000, kind: "decision" },
        { atMs: 2_000, kind: "chapter" },
        { atMs: 3_000, kind: "chapter" },
        { atMs: 4_000, kind: "chapter", decides: true },
      ]),
    );
    const rail = layout.edges.find((candidate) => candidate.kind === "decides");
    expect(rail).toMatchObject({ shape: "rail", lane: 1, rest: true });
    const column = layout.columns[1];
    const [lo, hi] = xRange(rail?.d ?? null);
    expect(lo).toBeLessThan(column?.x ?? 0);
    expect(hi).toBeLessThanOrEqual((column?.x ?? 0) + 1);
  });

  it("gives contradicts lanes 1 and 2 and then falls back to a direct bezier drawn at rest", () => {
    const layout = fresh(
      buildCanvasSession([
        { atMs: 1_000, kind: "loose" },
        { atMs: 2_000, kind: "chapter" },
        { atMs: 3_000, kind: "chapter" },
        { atMs: 4_000, kind: "chapter" },
        { atMs: 5_000, kind: "chapter" },
        { atMs: 6_000, kind: "chapter" },
        { atMs: 7_000, kind: "chapter" },
        { atMs: 8_000, kind: "chapter" },
        { atMs: 9_000, kind: "chapter" },
        { atMs: 9_500, kind: "claim", flagged: true },
        { atMs: 10_000, kind: "chapter" },
        { atMs: 11_000, kind: "chapter" },
        { atMs: 12_000, kind: "chapter" },
        { atMs: 12_500, kind: "claim", flagged: true },
        { atMs: 13_000, kind: "chapter" },
        { atMs: 14_000, kind: "chapter" },
        { atMs: 15_000, kind: "chapter" },
        { atMs: 15_500, kind: "claim", flagged: true },
      ]),
    );
    const contradicts = layout.edges.filter((candidate) => candidate.kind === "contradicts");
    expect(contradicts.map((candidate) => [candidate.shape, candidate.lane, candidate.rest])).toEqual([
      ["channel", 1, true],
      ["channel", 2, true],
      ["direct", null, true],
    ]);
    expect(contradicts.every((candidate) => candidate.d !== null)).toBe(true);
  });

  it("directPath runs between facing card edges", () => {
    expect(directPath({ x: 0, y: 0, w: 100, h: 40 }, { x: 200, y: 100, w: 100, h: 40 })).toBe(
      "M100 20C150 20 150 120 200 120",
    );
    expect(directPath({ x: 0, y: 0, w: 100, h: 40 }, { x: 0, y: 100, w: 100, h: 40 })).toBe(
      "M50 40C50 70 50 70 50 100",
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/canvas-routes.test.ts`
Expected: FAIL with `does not provide an export named 'directPath'` (and the trunk assertions fail, because `finalize` still returns no edges).

- [ ] **Step 3: Append the routing functions to `canvas-routes.ts`**

In `packages/trace-viewer/src/layout/canvas-routes.ts`, replace the import block:

```ts
import type { FindingId, TraceSession } from "../model/index.js";
import type { CanvasColumn, CanvasFrame } from "./canvas-layout.js";
import type { LevelSpec } from "./canvas-levels.js";
import type { Point } from "./viewport.js";
```

with:

```ts
import { decisionStableId, type Chapter, type FindingId, type Step, type StepId, type TraceSession } from "../model/index.js";
import type { CanvasColumn, CanvasFrame } from "./canvas-layout.js";
import { stepFinder, type LevelSpec } from "./canvas-levels.js";
import type { SelectionId } from "./trace-index.js";
import type { Point, Rect } from "./viewport.js";
```

and append:

```ts
export const RAIL_RADIUS_PX = 6;

const KIND_RANK: { readonly [K in EdgeKind]: number } = { trunk: 0, contradicts: 1, decides: 2, validates: 3 };

function n(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function laneY(spec: LevelSpec, lane: number): number {
  return spec.storyBand + Math.round((spec.channelH * (lane + 1)) / (spec.channelLanes + 1));
}

// ------------------------------------------------------------ context

interface RouteContext {
  input: RouteInput;
  stepOf: (id: string) => Step | undefined;
  chapterById: Map<string, Chapter>;
  frameBySel: Map<SelectionId, CanvasFrame>;
  order: Map<string, number>;
  byColumn: Map<number, CanvasFrame[]>;
}

function createContext(input: RouteInput): RouteContext {
  const frameBySel = new Map<SelectionId, CanvasFrame>();
  const order = new Map<string, number>();
  const byColumn = new Map<number, CanvasFrame[]>();
  input.frames.forEach((frame, index) => {
    order.set(frame.key, index);
    for (const selId of frame.memberSelIds) if (!frameBySel.has(selId)) frameBySel.set(selId, frame);
    const list = byColumn.get(frame.col);
    if (list === undefined) byColumn.set(frame.col, [frame]);
    else list.push(frame);
  });
  for (const list of byColumn.values()) list.sort((a, b) => a.row - b.row);
  return {
    input,
    stepOf: stepFinder(input.session.steps),
    chapterById: new Map(input.session.chapters.map((chapter) => [chapter.id, chapter])),
    frameBySel,
    order,
    byColumn,
  };
}

function anchorOf(ctx: RouteContext, chapter: Chapter): number {
  const stepSeqs = chapter.stepIds.map((id) => ctx.stepOf(id)?.firstSeq ?? Infinity);
  return Math.min(Infinity, ...chapter.factSeqs, ...stepSeqs);
}

function homeKey(ctx: RouteContext, stepId: string): string | undefined {
  const step = ctx.stepOf(stepId);
  if (step === undefined) return undefined;
  const loose = ctx.input.frameByKey.get(`step:${step.firstSeq}`);
  if (loose !== undefined && loose.kind === "loose") return loose.key;
  const story = ctx.frameBySel.get(step.id);
  if (story !== undefined && story.kind === "story") return story.key;
  const byAnchor = (a: Chapter, b: Chapter): number => anchorOf(ctx, a) - anchorOf(ctx, b) || compareText(a.id, b.id);
  const chapters = step.chapterIds
    .map((id) => ctx.chapterById.get(id))
    .filter((chapter): chapter is Chapter => chapter !== undefined && ctx.frameBySel.has(chapter.id))
    .sort(byAnchor);
  if (step.kind === "test" || step.kind === "check") {
    const tests = chapters.find((chapter) => chapter.category === "tests");
    if (tests !== undefined) return ctx.frameBySel.get(tests.id)?.key;
  }
  const lowest = chapters[0];
  return lowest === undefined ? undefined : ctx.frameBySel.get(lowest.id)?.key;
}

export function homeFrameKey(stepId: StepId, input: RouteInput): string | undefined {
  return homeKey(createContext(input), stepId);
}

// ------------------------------------------------------------ geometry

function center(frame: CanvasFrame): number {
  return frame.card.x + frame.card.w / 2;
}

function top(frame: CanvasFrame): Point {
  return { x: center(frame), y: frame.card.y };
}

function bottom(frame: CanvasFrame): Point {
  return { x: center(frame), y: frame.card.y + frame.card.h };
}

function left(frame: CanvasFrame): Point {
  return { x: frame.card.x, y: frame.card.y + frame.card.h / 2 };
}

function right(frame: CanvasFrame): Point {
  return { x: frame.card.x + frame.card.w, y: frame.card.y + frame.card.h / 2 };
}

function roundedPolyline(points: readonly Point[], radius: number): string {
  const pts = points.filter((point, index) => {
    const prev = points[index - 1];
    return prev === undefined || prev.x !== point.x || prev.y !== point.y;
  });
  const first = pts[0];
  if (first === undefined) return "";
  let d = `M${n(first.x)} ${n(first.y)}`;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const prev = pts[i - 1];
    const cur = pts[i];
    const next = pts[i + 1];
    if (prev === undefined || cur === undefined || next === undefined) continue;
    const inLen = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const outLen = Math.hypot(next.x - cur.x, next.y - cur.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    const a = { x: cur.x - ((cur.x - prev.x) / inLen) * r, y: cur.y - ((cur.y - prev.y) / inLen) * r };
    const b = { x: cur.x + ((next.x - cur.x) / outLen) * r, y: cur.y + ((next.y - cur.y) / outLen) * r };
    d += `L${n(a.x)} ${n(a.y)}Q${n(cur.x)} ${n(cur.y)} ${n(b.x)} ${n(b.y)}`;
  }
  const last = pts[pts.length - 1];
  if (last !== undefined && pts.length > 1) d += `L${n(last.x)} ${n(last.y)}`;
  return d;
}

export function directPath(a: Rect, b: Rect): string {
  if (a.x + a.w <= b.x || b.x + b.w <= a.x) {
    const [l, r] = a.x <= b.x ? [a, b] : [b, a];
    const p0 = { x: l.x + l.w, y: l.y + l.h / 2 };
    const p3 = { x: r.x, y: r.y + r.h / 2 };
    const gx = (p0.x + p3.x) / 2;
    return `M${n(p0.x)} ${n(p0.y)}C${n(gx)} ${n(p0.y)} ${n(gx)} ${n(p3.y)} ${n(p3.x)} ${n(p3.y)}`;
  }
  const [u, v] = a.y <= b.y ? [a, b] : [b, a];
  const p0 = { x: u.x + u.w / 2, y: u.y + u.h };
  const p3 = { x: v.x + v.w / 2, y: v.y };
  const gy = (p0.y + p3.y) / 2;
  return `M${n(p0.x)} ${n(p0.y)}C${n(p0.x)} ${n(gy)} ${n(p3.x)} ${n(gy)} ${n(p3.x)} ${n(p3.y)}`;
}

function directBadge(a: Rect, b: Rect): Point {
  if (a.x + a.w <= b.x || b.x + b.w <= a.x) {
    const [l, r] = a.x <= b.x ? [a, b] : [b, a];
    return { x: (l.x + l.w + r.x) / 2, y: (l.y + l.h / 2 + r.y + r.h / 2) / 2 };
  }
  const [u, v] = a.y <= b.y ? [a, b] : [b, a];
  return { x: (u.x + u.w / 2 + v.x + v.w / 2) / 2, y: (u.y + u.h + v.y) / 2 };
}

export function samplePath(d: string, perSegment = 16): Point[] {
  const tokens = d.match(/[MLHVCQ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  const points: Point[] = [];
  let i = 0;
  let cursor: Point = { x: 0, y: 0 };
  let command = "M";
  const num = (): number => Number(tokens[i++]);
  while (i < tokens.length) {
    const token = tokens[i];
    if (token !== undefined && /^[MLHVCQ]$/i.test(token)) {
      command = token.toUpperCase();
      i += 1;
    }
    if (command === "M") {
      cursor = { x: num(), y: num() };
      points.push(cursor);
      command = "L";
    } else if (command === "L" || command === "H" || command === "V") {
      const target =
        command === "L" ? { x: num(), y: num() } : command === "H" ? { x: num(), y: cursor.y } : { x: cursor.x, y: num() };
      for (let s = 1; s <= perSegment; s += 1) {
        const t = s / perSegment;
        points.push({ x: cursor.x + (target.x - cursor.x) * t, y: cursor.y + (target.y - cursor.y) * t });
      }
      cursor = target;
    } else if (command === "C") {
      const c1 = { x: num(), y: num() };
      const c2 = { x: num(), y: num() };
      const target = { x: num(), y: num() };
      for (let s = 1; s <= perSegment; s += 1) {
        const t = s / perSegment;
        const m = 1 - t;
        points.push({
          x: m * m * m * cursor.x + 3 * m * m * t * c1.x + 3 * m * t * t * c2.x + t * t * t * target.x,
          y: m * m * m * cursor.y + 3 * m * m * t * c1.y + 3 * m * t * t * c2.y + t * t * t * target.y,
        });
      }
      cursor = target;
    } else if (command === "Q") {
      const c = { x: num(), y: num() };
      const target = { x: num(), y: num() };
      for (let s = 1; s <= perSegment; s += 1) {
        const t = s / perSegment;
        const m = 1 - t;
        points.push({
          x: m * m * cursor.x + 2 * m * t * c.x + t * t * target.x,
          y: m * m * cursor.y + 2 * m * t * c.y + t * t * target.y,
        });
      }
      cursor = target;
    } else {
      i += 1;
    }
  }
  return points;
}

// ------------------------------------------------------------ lanes

class IntervalBook {
  private readonly used = new Map<string, Array<readonly [number, number]>>();

  free(slot: string, a: number, b: number): boolean {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return (this.used.get(slot) ?? []).every(([u0, u1]) => hi <= u0 || lo >= u1);
  }

  take(slot: string, a: number, b: number): void {
    const list = this.used.get(slot) ?? [];
    list.push([Math.min(a, b), Math.max(a, b)]);
    this.used.set(slot, list);
  }
}

/** x of rail lane j in the left gutter of column c (lane 0 nearest the column). */
function railX(ctx: RouteContext, column: number, lane: number): number {
  const { columns, spec } = ctx.input;
  const colX = columns[column]?.x ?? 0;
  const prev = columns[column - 1];
  const gutterLeft = prev === undefined ? colX - spec.colGap : prev.x + spec.w;
  return colX - Math.round(((colX - gutterLeft) * (lane + 1)) / (spec.railLanes + 1));
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let value = from; value < to; value += 1) out.push(value);
  return out;
}

/** "bottom" for the lowest story cell, "top" for the first work row, null for a frame with others between it and the channel. */
function directPort(ctx: RouteContext, frame: CanvasFrame): "bottom" | "top" | null {
  const { spec } = ctx.input;
  const column = ctx.byColumn.get(frame.col) ?? [];
  if (frame.row < spec.storyCap) {
    return column.some((other) => other.row > frame.row && other.row < spec.storyCap) ? null : "bottom";
  }
  return column.some((other) => other.row >= spec.storyCap && other.row < frame.row) ? null : "top";
}

interface Routed {
  shape: EdgeShape;
  lane: number | null;
  d: string | null;
  badge: Point;
}

function stackedRoute(a: CanvasFrame, b: CanvasFrame): Routed {
  const [upper, lower] = a.row < b.row ? [a, b] : [b, a];
  const p0 = bottom(upper);
  const p1 = top(lower);
  return { shape: "stacked", lane: null, d: `M${n(p0.x)} ${n(p0.y)}V${n(p1.y)}`, badge: { x: p0.x, y: (p0.y + p1.y) / 2 } };
}

function adjacentRoute(a: CanvasFrame, b: CanvasFrame): Routed {
  const [l, r] = a.col < b.col ? [a, b] : [b, a];
  const p0 = right(l);
  const p3 = left(r);
  const gx = (p0.x + p3.x) / 2;
  return {
    shape: "adjacent",
    lane: null,
    d: `M${n(p0.x)} ${n(p0.y)}C${n(gx)} ${n(p0.y)} ${n(gx)} ${n(p3.y)} ${n(p3.x)} ${n(p3.y)}`,
    badge: { x: gx, y: (p0.y + p3.y) / 2 },
  };
}

function railLanesFor(ctx: RouteContext, kind: EdgeKind): number[] {
  return kind === "contradicts" ? range(0, ctx.input.spec.railLanes) : range(1, ctx.input.spec.railLanes);
}

function railRoute(ctx: RouteContext, book: IntervalBook, kind: EdgeKind, a: CanvasFrame, b: CanvasFrame): Routed | null {
  const [upper, lower] = a.row < b.row ? [a, b] : [b, a];
  const ya = left(upper).y;
  const yb = left(lower).y;
  for (const lane of railLanesFor(ctx, kind)) {
    const slot = `rail:${a.col}:${lane}`;
    if (!book.free(slot, ya, yb)) continue;
    book.take(slot, ya, yb);
    const x = railX(ctx, a.col, lane);
    return {
      shape: "rail",
      lane,
      d: roundedPolyline([left(upper), { x, y: ya }, { x, y: yb }, left(lower)], RAIL_RADIUS_PX),
      badge: { x, y: (ya + yb) / 2 },
    };
  }
  return null;
}

function channelRoute(ctx: RouteContext, book: IntervalBook, kind: EdgeKind, a: CanvasFrame, b: CanvasFrame): Routed | null {
  const { spec } = ctx.input;
  const [l, r] = a.col < b.col ? [a, b] : [b, a];
  const lPort = directPort(ctx, l);
  const rPort = directPort(ctx, r);
  const lanes = kind === "contradicts" ? [1, 2] : range(2, spec.channelLanes);
  for (const lane of lanes.filter((value) => value < spec.channelLanes)) {
    const y = laneY(spec, lane);
    const lRail =
      lPort === null
        ? railLanesFor(ctx, kind).find((j) => book.free(`rail:${l.col + 1}:${j}`, right(l).y, y))
        : undefined;
    const rRail =
      rPort === null ? railLanesFor(ctx, kind).find((j) => book.free(`rail:${r.col}:${j}`, y, left(r).y)) : undefined;
    if ((lPort === null && lRail === undefined) || (rPort === null && rRail === undefined)) continue;
    const x0 = lPort === null ? railX(ctx, l.col + 1, lRail ?? 0) : center(l);
    const x1 = rPort === null ? railX(ctx, r.col, rRail ?? 0) : center(r);
    if (!book.free(`lane:${lane}`, x0, x1)) continue;
    book.take(`lane:${lane}`, x0, x1);
    if (lPort === null) book.take(`rail:${l.col + 1}:${lRail ?? 0}`, right(l).y, y);
    if (rPort === null) book.take(`rail:${r.col}:${rRail ?? 0}`, y, left(r).y);
    const points: Point[] = [];
    if (lPort === "bottom") points.push(bottom(l), { x: x0, y });
    else if (lPort === "top") points.push(top(l), { x: x0, y });
    else points.push(right(l), { x: x0, y: right(l).y }, { x: x0, y });
    if (rPort === "bottom") points.push({ x: x1, y }, bottom(r));
    else if (rPort === "top") points.push({ x: x1, y }, top(r));
    else points.push({ x: x1, y }, { x: x1, y: left(r).y }, left(r));
    return { shape: "channel", lane, d: roundedPolyline(points, RAIL_RADIUS_PX), badge: { x: (x0 + x1) / 2, y } };
  }
  return null;
}

function nothingBetween(ctx: RouteContext, a: CanvasFrame, b: CanvasFrame): boolean {
  const lo = Math.min(a.row, b.row);
  const hi = Math.max(a.row, b.row);
  return !(ctx.byColumn.get(a.col) ?? []).some((frame) => frame.row > lo && frame.row < hi);
}

// ------------------------------------------------------------ edges

interface EdgeSpec {
  kind: EdgeKind;
  from: string;
  to: string;
  findingId: FindingId | null;
}

function wantedEdges(ctx: RouteContext): EdgeSpec[] {
  const { session, frames } = ctx.input;
  const specs: EdgeSpec[] = [];
  for (const finding of session.findings) {
    if (finding.ruleId !== "claim_contradicted") continue;
    const from = homeKey(ctx, finding.claimStepId ?? finding.anchorStepId);
    if (from === undefined) continue;
    for (const evidence of finding.evidenceStepIds ?? []) {
      const to = homeKey(ctx, evidence);
      if (to !== undefined && to !== from) specs.push({ kind: "contradicts", from, to, findingId: finding.id });
    }
  }
  for (const frame of frames) {
    if (frame.item !== "decision") continue;
    const step = ctx.stepOf(frame.selId);
    const decisionId = step?.decision?.decisionId ?? step?.target;
    if (decisionId === undefined) continue;
    const stableId = decisionStableId(decisionId);
    for (const chapter of session.chapters) {
      if (!chapter.decisionIds.includes(stableId)) continue;
      const to = ctx.frameBySel.get(chapter.id);
      if (to !== undefined && to.key !== frame.key) specs.push({ kind: "decides", from: frame.key, to: to.key, findingId: null });
    }
  }
  for (const chapter of session.chapters) {
    const from = ctx.frameBySel.get(chapter.id);
    if (from === undefined) continue;
    for (const stepId of chapter.validationStepIds) {
      const to = homeKey(ctx, stepId);
      if (to !== undefined && to !== from.key) specs.push({ kind: "validates", from: from.key, to, findingId: null });
    }
  }
  const unique = new Map<string, EdgeSpec>();
  for (const spec of specs) {
    const id = `${spec.kind}|${spec.from}|${spec.to}`;
    const seen = unique.get(id);
    if (seen === undefined || compareText(spec.findingId ?? "", seen.findingId ?? "") < 0) unique.set(id, spec);
  }
  const order = (key: string): number => ctx.order.get(key) ?? Number.MAX_SAFE_INTEGER;
  return [...unique.values()].sort(
    (a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || order(a.from) - order(b.from) || order(a.to) - order(b.to),
  );
}

function trunkEdges(ctx: RouteContext): { edges: CanvasEdge[]; junctions: Point[] } {
  const { columns, spec } = ctx.input;
  const y = laneY(spec, 0);
  const byTurn = new Map<number, CanvasColumn[]>();
  for (const column of columns) {
    const list = byTurn.get(column.turn);
    if (list === undefined) byTurn.set(column.turn, [column]);
    else list.push(column);
  }
  const edges: CanvasEdge[] = [];
  const junctions: Point[] = [];
  for (const [turn, turnColumns] of [...byTurn].sort((a, b) => a[0] - b[0])) {
    const stubs: string[] = [];
    const xs: number[] = [];
    const keys: string[] = [];
    const turnJunctions: Point[] = [];
    for (const column of turnColumns) {
      const frames = ctx.byColumn.get(column.index) ?? [];
      const story = frames.filter((frame) => frame.row < spec.storyCap);
      const work = frames.filter((frame) => frame.row >= spec.storyCap);
      const x = column.x + spec.w / 2;
      for (let i = 0; i + 1 < story.length; i += 1) {
        const upper = story[i];
        const lower = story[i + 1];
        if (upper !== undefined && lower !== undefined) stubs.push(`M${n(x)} ${n(bottom(upper).y)}V${n(top(lower).y)}`);
      }
      const lastStory = story[story.length - 1];
      const firstWork = work[0];
      if (lastStory !== undefined) {
        stubs.push(`M${n(x)} ${n(bottom(lastStory).y)}V${n(y)}`);
        xs.push(x);
        keys.push(...story.map((frame) => frame.key));
      }
      if (firstWork !== undefined) {
        stubs.push(`M${n(x)} ${n(y)}V${n(top(firstWork).y)}`);
        xs.push(x);
        keys.push(firstWork.key);
      }
      if (lastStory !== undefined && firstWork !== undefined) turnJunctions.push({ x, y });
    }
    if (xs.length < 2) continue;
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const ordered = [...keys].sort((a, b) => (ctx.order.get(a) ?? 0) - (ctx.order.get(b) ?? 0));
    edges.push({
      id: `trunk:turn:${turn}`,
      kind: "trunk",
      from: ordered[0] ?? "",
      to: ordered[ordered.length - 1] ?? "",
      shape: "comb",
      lane: 0,
      d: `${x1 > x0 ? `M${n(x0)} ${n(y)}H${n(x1)}` : ""}${stubs.join("")}`,
      rest: true,
      tone: "neutral",
      badge: null,
      findingId: null,
    });
    junctions.push(...turnJunctions);
  }
  return { edges, junctions };
}

/** Spec §7.5 "Edges": routes through gutters and channel lanes only; the ≠ connector is always drawn. */
export function routeEdges(input: RouteInput): { edges: CanvasEdge[]; junctions: Point[]; hiddenEdges: number } {
  const ctx = createContext(input);
  const trunk = trunkEdges(ctx);
  const book = new IntervalBook();
  const edges: CanvasEdge[] = [...trunk.edges];
  let hiddenEdges = 0;
  for (const spec of wantedEdges(ctx)) {
    const a = input.frameByKey.get(spec.from);
    const b = input.frameByKey.get(spec.to);
    if (a === undefined || b === undefined) continue;
    let routed: Routed | null;
    if (a.col === b.col) {
      routed = nothingBetween(ctx, a, b) ? stackedRoute(a, b) : railRoute(ctx, book, spec.kind, a, b);
    } else if (Math.abs(a.col - b.col) === 1) {
      routed = adjacentRoute(a, b);
    } else {
      routed = channelRoute(ctx, book, spec.kind, a, b);
    }
    if (routed === null && spec.kind === "contradicts") {
      routed = { shape: "direct", lane: null, d: directPath(a.card, b.card), badge: directBadge(a.card, b.card) };
    }
    const shape: EdgeShape =
      routed?.shape ?? (a.col === b.col ? "rail" : Math.abs(a.col - b.col) === 1 ? "adjacent" : "channel");
    const d = routed?.d ?? null;
    if (d === null) hiddenEdges += 1;
    const rest =
      spec.kind === "contradicts"
        ? true
        : input.spec.level !== "session" && d !== null && (shape === "stacked" || shape === "adjacent" || shape === "rail");
    edges.push({
      id: `${spec.kind}:${spec.from}>${spec.to}`,
      kind: spec.kind,
      from: spec.from,
      to: spec.to,
      shape,
      lane: routed?.lane ?? null,
      d,
      rest,
      tone: spec.kind === "contradicts" ? "bad" : "neutral",
      badge: spec.kind === "contradicts" && routed !== null ? routed.badge : null,
      findingId: spec.findingId,
    });
  }
  return { edges, junctions: trunk.junctions, hiddenEdges };
}
```

- [ ] **Step 4: Wire `routeEdges` into `finalize`**

In `packages/trace-viewer/src/layout/canvas-layout.ts`, replace:

```ts
import type { CanvasEdge } from "./canvas-routes.js";
```

with:

```ts
import { routeEdges, type CanvasEdge } from "./canvas-routes.js";
```

and replace:

```ts
  // C3-3 replaces this block with routeEdges.
  const edges: CanvasEdge[] = [];
  const junctions: Point[] = [];
  const hiddenEdges = 0;
```

with:

```ts
  const routed = routeEdges({ session, frames, frameByKey, columns, spec });
  const edges: readonly CanvasEdge[] = routed.edges;
  const junctions: readonly Point[] = routed.junctions;
  const hiddenEdges = routed.hiddenEdges;
```

- [ ] **Step 5: Run the route tests to verify they pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/canvas-routes.test.ts src/layout/canvas-layout.test.ts`
Expected: PASS, `Tests  22 passed (22)`.

- [ ] **Step 6: Append P9 and P8 reachability to the property file**

In `packages/trace-viewer/src/layout/canvas-layout.property.test.ts`, replace:

```ts
import { canvasXMap, collectItems, layoutCanvas, type CanvasItem, type CanvasLayout } from "./canvas-layout.js";
```

with:

```ts
import { canvasXMap, collectItems, layoutCanvas, type CanvasItem, type CanvasLayout } from "./canvas-layout.js";
import { homeFrameKey, samplePath, type RouteInput } from "./canvas-routes.js";
import { worstSeverity } from "./tone.js";
```

and append inside the `describe("canvas layout invariants", …)` block, before its closing `});`:

```ts
  it("P9 rest edges cross no card; only contradicts is red; one contradicts per evidence frame; lanes in range", () => {
    fc.assert(
      fc.property(arbCanvasSession(), levels, (session, level) => {
        const layout = fresh(session, level);
        const spec = LEVEL_SPECS[level];
        for (const edge of layout.edges) {
          if (edge.tone === "bad") expect(edge.kind).toBe("contradicts");
          if (edge.kind === "contradicts") {
            expect(edge.rest).toBe(true);
            expect(edge.d).not.toBeNull();
          }
          if (edge.shape === "channel") expect(edge.lane ?? -1).toBeLessThan(spec.channelLanes);
          if (edge.shape === "rail") expect(edge.lane ?? -1).toBeLessThan(spec.railLanes);
          if (!edge.rest || edge.d === null || edge.shape === "direct") continue;
          for (const point of samplePath(edge.d)) {
            for (const frame of layout.frames) {
              const { x, y, w, h } = frame.card;
              const inside = point.x > x + 1 && point.x < x + w - 1 && point.y > y + 1 && point.y < y + h - 1;
              expect(inside, `${edge.id} crosses ${frame.key}`).toBe(false);
            }
          }
        }
        const input: RouteInput = { session, frames: layout.frames, frameByKey: layout.frameByKey, columns: layout.columns, spec };
        for (const finding of session.findings) {
          if (finding.ruleId !== "claim_contradicted") continue;
          const from = homeFrameKey(finding.claimStepId ?? finding.anchorStepId, input);
          const targets = new Set(
            (finding.evidenceStepIds ?? [])
              .map((id) => homeFrameKey(id, input))
              .filter((key): key is string => key !== undefined && key !== from),
          );
          const drawn = layout.edges.filter((edge) => edge.kind === "contradicts" && edge.findingId === finding.id);
          expect(drawn).toHaveLength(targets.size);
        }
      }),
      RUNS,
    );
  });

  it("P8 every warning-or-worse step is reachable through its home frame", () => {
    fc.assert(
      fc.property(arbCanvasSession(), levels, (session, level) => {
        const layout = fresh(session, level);
        const input: RouteInput = {
          session,
          frames: layout.frames,
          frameByKey: layout.frameByKey,
          columns: layout.columns,
          spec: LEVEL_SPECS[level],
        };
        const findingsById = new Map(session.findings.map((finding) => [finding.id, finding]));
        for (const step of session.steps) {
          const severity = worstSeverity(step, findingsById);
          if (severity !== "warning" && severity !== "critical") continue;
          const key = homeFrameKey(step.id, input);
          expect(key, step.id).toBeDefined();
          expect(layout.frameByKey.has(key ?? "")).toBe(true);
        }
      }),
      RUNS,
    );
  });
```

- [ ] **Step 7: Run the property tests**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/canvas-layout.property.test.ts`
Expected: PASS, `Tests  11 passed (11)`. On a P9 crossing counterexample, print the edge's `d` and the crossed card: a crossing means a port or rail rule let a path leave its gutter or lane; fix the route, never the check.

- [ ] **Step 8: Typecheck, lint and root checks**

Run: `pnpm --filter @jevcode/trace-viewer typecheck && pnpm lint`, then the root checks. Expected: all exit 0.

- [ ] **Step 9: Commit**

```bash
git add packages/trace-viewer/src/layout/canvas-routes.ts packages/trace-viewer/src/layout/canvas-routes.test.ts packages/trace-viewer/src/layout/canvas-layout.ts packages/trace-viewer/src/layout/canvas-layout.property.test.ts
git commit -m "feat(trace-viewer): canvas edge routing with the contradicts connector"
```

### Task C3-4: Minimap model and the layout benchmark

**Files:**
- Create: `packages/trace-viewer/src/layout/canvas-minimap.ts`
- Create: `packages/trace-viewer/src/layout/canvas-minimap.test.ts`
- Create: `packages/trace-viewer/src/layout/canvas-layout.bench.ts`
- Modify: `packages/trace-viewer/src/test-support/canvas-arbitraries.ts` (append `syntheticCanvasSession`)

**Interfaces:**
- Consumes: C3-2/C3-3 `CanvasLayout`, `CanvasFrame`, `layoutCanvas`; C1-5 `Point`, `Rect`; C3-1 `buildCanvasSession`, `CanvasSeed`; C3-2 `canvasScale`, `oauthCanvasSession`.
- Produces (UI index §2.1 plus deviations 4 and 5):

```ts
export const MINIMAP_W = 140;
export const MINIMAP_H = 84;
export const MINIMAP_STRIP_H = 3;
export const MINIMAP_MIN_SCALE = 0.03;
export type MinimapSource = Pick<CanvasLayout, "bounds" | "frames" | "edges" | "separators">;
export interface MinimapModel {
  scale: number;
  /** World point shown at minimap (0, 0) (deviation 4). */
  origin: Point;
  window: { x0: number; x1: number } | null;
  frames: readonly { key: string; rect: Rect; mark: "frame" | "selected" | "critical" | "noise" }[];
  /** World-space paths, drawn inside a scale(s) translate(−origin) group with non-scaling strokes. */
  edges: readonly { d: string }[];
  separators: readonly { x: number }[];
  viewport: Rect;
  strip: { bracket: readonly [number, number]; critical: readonly number[] } | null;
}
export function buildMinimap(layout: MinimapSource, input: { viewportWorld: Rect; selectedKey: string | null; criticalKeys: ReadonlySet<string> }): MinimapModel;
export function minimapToWorld(model: MinimapModel, point: Point): Point;

// test-support
export function syntheticCanvasSession(options?: { chapters?: number; steps?: number; turns?: number }): TraceSession;
```

- [ ] **Step 1: Write the failing minimap tests**

Create `packages/trace-viewer/src/layout/canvas-minimap.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { canvasScale, oauthCanvasSession } from "../test-support/canvas-arbitraries.js";
import type { CanvasFrame } from "./canvas-layout.js";
import { layoutCanvas } from "./canvas-layout.js";
import { MINIMAP_H, MINIMAP_W, buildMinimap, minimapToWorld, type MinimapSource } from "./canvas-minimap.js";
import { buildTraceIndex } from "./trace-index.js";

// Expected values: spec §7.5 "Minimap": s = max(min(140/B.w, 84/B.h), 0.03); a window when s·B.w > 140.

function frame(key: string, x: number, y: number): CanvasFrame {
  return {
    key,
    selId: `unit:${key}`,
    kind: "chapter",
    item: "chapter",
    col: 0,
    row: 1,
    slot: { x, y, w: 224, h: 134 },
    card: { x, y: y + 22, w: 224, h: 112 },
    label: { x, y, w: 224, h: 16 },
    members: [key],
    memberSelIds: [`unit:${key}`],
    late: false,
  };
}

describe("buildMinimap", () => {
  it("scales the oauth layout to fit 140 × 84 with no window", () => {
    const session = oauthCanvasSession();
    const layout = layoutCanvas(session, buildTraceIndex(session), canvasScale(session), "chapter");
    const selected = layout.frames[1]?.key ?? null;
    const model = buildMinimap(layout, {
      viewportWorld: { x: 0, y: 0, w: 800, h: 600 },
      selectedKey: selected,
      criticalKeys: new Set(),
    });
    expect(model.scale).toBeCloseTo(84 / 658, 10);
    expect(model.window).toBeNull();
    expect(model.strip).toBeNull();
    expect(model.frames).toHaveLength(layout.frames.length);
    expect(model.frames.find((mark) => mark.key === selected)?.mark).toBe("selected");
    expect(model.frames.filter((mark) => mark.mark === "noise")).toHaveLength(1);
    expect(model.edges).toHaveLength(1);
    expect(model.viewport).toEqual({ x: 0, y: 0, w: 800 * model.scale, h: 600 * model.scale });
  });

  it("shows a window and a session strip with red ticks for a long session", () => {
    const layout: MinimapSource = {
      bounds: { x: 0, y: 0, w: 8_000, h: 750 },
      frames: [frame("early", 100, 150), frame("late", 7_700, 150)],
      edges: [],
      separators: [],
    };
    const model = buildMinimap(layout, {
      viewportWorld: { x: 3_000, y: 0, w: 1_000, h: 700 },
      selectedKey: null,
      criticalKeys: new Set(["late"]),
    });
    expect(model.scale).toBe(0.03);
    const span = MINIMAP_W / 0.03;
    expect(model.window?.x0).toBeCloseTo(3_500 - span / 2, 6);
    expect(model.window?.x1).toBeCloseTo(3_500 + span / 2, 6);
    expect(model.frames).toEqual([]);
    expect(model.strip?.bracket[0]).toBeCloseTo(((3_500 - span / 2) / 8_000) * MINIMAP_W, 6);
    expect(model.strip?.critical).toEqual([((7_700 + 112) / 8_000) * MINIMAP_W]);
  });

  it("clamps the window to the session bounds", () => {
    const layout: MinimapSource = { bounds: { x: 0, y: 0, w: 8_000, h: 750 }, frames: [], edges: [], separators: [] };
    const model = buildMinimap(layout, {
      viewportWorld: { x: 7_900, y: 0, w: 1_000, h: 700 },
      selectedKey: null,
      criticalKeys: new Set(),
    });
    expect(model.window?.x1).toBeCloseTo(8_000, 6);
  });

  it("minimapToWorld inverts the scale", () => {
    const session = oauthCanvasSession();
    const layout = layoutCanvas(session, buildTraceIndex(session), canvasScale(session), "chapter");
    const model = buildMinimap(layout, {
      viewportWorld: { x: 0, y: 0, w: 800, h: 600 },
      selectedKey: null,
      criticalKeys: new Set(),
    });
    for (const mark of model.frames) {
      const card = layout.frameByKey.get(mark.key)?.card;
      const world = minimapToWorld(model, { x: mark.rect.x, y: mark.rect.y });
      expect(world.x).toBeCloseTo(card?.x ?? NaN, 6);
      expect(world.y).toBeCloseTo(card?.y ?? NaN, 6);
    }
    expect(minimapToWorld(model, { x: MINIMAP_W, y: MINIMAP_H }).y).toBeCloseTo(MINIMAP_H / model.scale, 6);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/canvas-minimap.test.ts`
Expected: FAIL with `Failed to load url ./canvas-minimap.js`.

- [ ] **Step 3: Write `canvas-minimap.ts`**

Create `packages/trace-viewer/src/layout/canvas-minimap.ts`:

```ts
import type { CanvasLayout } from "./canvas-layout.js";
import type { Point, Rect } from "./viewport.js";

export const MINIMAP_W = 140;
export const MINIMAP_H = 84;
export const MINIMAP_STRIP_H = 3;
export const MINIMAP_MIN_SCALE = 0.03;

export type MinimapSource = Pick<CanvasLayout, "bounds" | "frames" | "edges" | "separators">;

export interface MinimapModel {
  scale: number;
  origin: Point;
  /** World x-window shown when s · bounds.w > 140; null when the whole session fits. */
  window: { x0: number; x1: number } | null;
  frames: readonly { key: string; rect: Rect; mark: "frame" | "selected" | "critical" | "noise" }[];
  edges: readonly { d: string }[];
  separators: readonly { x: number }[];
  viewport: Rect;
  strip: { bracket: readonly [number, number]; critical: readonly number[] } | null;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** Spec §7.5 "Minimap": everything derives from the layout; holes are not drawn. */
export function buildMinimap(
  layout: MinimapSource,
  input: { viewportWorld: Rect; selectedKey: string | null; criticalKeys: ReadonlySet<string> },
): MinimapModel {
  const bounds = layout.bounds;
  const fitW = bounds.w > 0 ? MINIMAP_W / bounds.w : 1;
  const fitH = bounds.h > 0 ? MINIMAP_H / bounds.h : 1;
  const scale = Math.max(Math.min(fitW, fitH), MINIMAP_MIN_SCALE);
  let window: MinimapModel["window"] = null;
  if (scale * bounds.w > MINIMAP_W) {
    const span = MINIMAP_W / scale;
    const center = input.viewportWorld.x + input.viewportWorld.w / 2;
    const x0 = clamp(center - span / 2, bounds.x, bounds.x + bounds.w - span);
    window = { x0, x1: x0 + span };
  }
  const origin: Point = { x: window === null ? bounds.x : window.x0, y: bounds.y };
  const toMini = (rect: Rect): Rect => ({
    x: (rect.x - origin.x) * scale,
    y: (rect.y - origin.y) * scale,
    w: rect.w * scale,
    h: rect.h * scale,
  });
  const visible = (x0: number, x1: number): boolean => window === null || (x1 >= window.x0 && x0 <= window.x1);
  const frames = layout.frames
    .filter((frame) => visible(frame.card.x, frame.card.x + frame.card.w))
    .map((frame) => ({
      key: frame.key,
      rect: toMini(frame.card),
      mark:
        frame.key === input.selectedKey
          ? ("selected" as const)
          : input.criticalKeys.has(frame.key)
            ? ("critical" as const)
            : frame.kind === "noise"
              ? ("noise" as const)
              : ("frame" as const),
    }));
  const edges = layout.edges
    .filter((edge) => edge.kind === "contradicts" && edge.rest && edge.d !== null)
    .map((edge) => ({ d: edge.d ?? "" }));
  const separators = layout.separators
    .filter((sep) => sep.kind === "turn" && visible(sep.x, sep.x))
    .map((sep) => ({ x: (sep.x - origin.x) * scale }));
  const strip =
    window === null || bounds.w <= 0
      ? null
      : {
          bracket: [
            ((window.x0 - bounds.x) / bounds.w) * MINIMAP_W,
            ((window.x1 - bounds.x) / bounds.w) * MINIMAP_W,
          ] as const,
          critical: layout.frames
            .filter((frame) => input.criticalKeys.has(frame.key))
            .map((frame) => ((frame.card.x + frame.card.w / 2 - bounds.x) / bounds.w) * MINIMAP_W),
        };
  return { scale, origin, window, frames, edges, separators, viewport: toMini(input.viewportWorld), strip };
}

export function minimapToWorld(model: MinimapModel, point: Point): Point {
  return { x: model.origin.x + point.x / model.scale, y: model.origin.y + point.y / model.scale };
}
```

- [ ] **Step 4: Run the minimap tests to verify they pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/canvas-minimap.test.ts`
Expected: PASS, `Tests  4 passed (4)`.

- [ ] **Step 5: Add the synthetic benchmark session**

Append to `packages/trace-viewer/src/test-support/canvas-arbitraries.ts`:

```ts
/** Spec §10 reference input: 60 chapters and 5,000 steps over three turns, with two idle breaks. */
export function syntheticCanvasSession(options: { chapters?: number; steps?: number; turns?: number } = {}): TraceSession {
  const chapters = options.chapters ?? 60;
  const steps = options.steps ?? 5_000;
  const turns = options.turns ?? 3;
  const seeds: CanvasSeed[] = [];
  const every = Math.max(1, Math.floor(steps / chapters));
  const turnEvery = Math.max(1, Math.floor(steps / turns));
  let placedChapters = 0;
  let t = 0;
  for (let i = 0; i < steps; i += 1) {
    t += i % 1_700 === 1_699 ? 180_000 : 400;
    if (i > 0 && i % turnEvery === 0) seeds.push({ atMs: t, kind: "prompt", trigger: "steer" });
    else if (i % every === 0 && placedChapters < chapters) {
      placedChapters += 1;
      seeds.push({ atMs: t, kind: "chapter", flagged: i % (every * 7) === 0, decides: i % (every * 5) === 0 });
    } else if (i % 97 === 0) seeds.push({ atMs: t, kind: "loose" });
    else if (i % 131 === 0) seeds.push({ atMs: t, kind: "decision" });
    else seeds.push({ atMs: t, kind: "work", durationMs: 300 });
  }
  return buildCanvasSession(seeds);
}
```

- [ ] **Step 6: Write the benchmark**

Create `packages/trace-viewer/src/layout/canvas-layout.bench.ts`:

```ts
import { bench, describe } from "vitest";

import { canvasScale, mutateCanvasSession, syntheticCanvasSession } from "../test-support/canvas-arbitraries.js";
import { layoutCanvas } from "./canvas-layout.js";
import { buildTraceIndex } from "./trace-index.js";

// Spec §10: layoutCanvas fresh ≤ 2 ms and sticky ≤ 0.5 ms on the 60-chapter / 5k-step session (benchmark, not a CI gate).

const session = syntheticCanvasSession();
const index = buildTraceIndex(session);
const scale = canvasScale(session);
const settled = layoutCanvas(session, index, scale, "chapter");
const appended = mutateCanvasSession(session, [{ op: "append", pick: 3 }]);
const appendedIndex = buildTraceIndex(appended);
const appendedScale = canvasScale(appended);

describe("layoutCanvas, 60 chapters and 5,000 steps", () => {
  bench("fresh", () => {
    layoutCanvas(session, index, scale, "chapter");
  });

  bench("sticky after one appended chapter", () => {
    layoutCanvas(appended, appendedIndex, appendedScale, "chapter", settled);
  });
});
```

- [ ] **Step 7: Run the benchmark and record the numbers**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest bench --run src/layout/canvas-layout.bench.ts`
Expected: exits 0 and prints a table with `fresh` and `sticky after one appended chapter` rows. Record both `mean` values and the machine in the commit message body (for example `fresh 1.4 ms, sticky 0.31 ms, Apple M3 Pro`). A miss against 2 ms / 0.5 ms does not fail the task (spec §10: "A `Benchmark` budget never blocks"); C3-12 copies the numbers into the spike doc's M4b section with a follow-up note when missed.

- [ ] **Step 8: Typecheck, lint and root checks**

Run: `pnpm --filter @jevcode/trace-viewer typecheck && pnpm lint`, then the root checks. Expected: all exit 0.

- [ ] **Step 9: Commit**

```bash
git add packages/trace-viewer/src/layout/canvas-minimap.ts packages/trace-viewer/src/layout/canvas-minimap.test.ts packages/trace-viewer/src/layout/canvas-layout.bench.ts packages/trace-viewer/src/test-support/canvas-arbitraries.ts
git commit -m "feat(trace-viewer): canvas minimap model and layout benchmark" -m "layoutCanvas bench: fresh <mean> ms, sticky <mean> ms on <machine>"
```

Replace the three `<…>` values in the second `-m` with the numbers Step 7 printed.

### Part A completion (lane C3a)

- [ ] **Merge.** On `tv/c3a-canvas-layout`, run `git rebase main` (or `git merge main`), then `pnpm install --frozen-lockfile && pnpm -r build`, then the root checks. Merge to `main` after C2 (UI index §4, W2 order: C2 → C3a → Da). Never `git stash`; commit WIP instead.

---

# Part B: lane C3b (wave W3): Canvas view and view switch (M4b)

## Hand-offs from C3a (lane review)

Source: lane review of C3a (`298d3ed..f55a4b9`) and its follow-up commits. Binding for C3-5..C3-12.

- **Live drips place chapters late.** Units arrive after their facts, so under a drip most chapter frames are `late` and sit at the bottom of their time column. The final drip layout matches the spec table by column, not by slot. The oauth table holds only for a fresh layout (open, Tidy, level switch). C3-12's smoke and screenshots must use a fresh load; `?selftest=drip` asserts drift only.
- **Edge stability is bounded.** Routes are a function of the layout (P5). Edges age by slot placement order (append order in sticky state): an appended edge touching a newly placed frame, late-arrival frames included, never moves an existing edge. An edge added between two already placed frames may re-lane younger edges, and a frame that becomes a hole can change a stacked/rail shape (oauth drip: `decides:decision:dec-oauth-0001>ch:16` rail/1 to stacked). C3-10's "an append leaves every placed frame's rect unchanged" is guaranteed by P6. Assert edge `d` stability only for appends that touch a newly placed frame.
- **Minimap edges come in world coordinates**, while frames, separators, viewport and strip are already in minimap coordinates. Draw edges under `scale(s) translate(-origin)` with `vector-effect: non-scaling-stroke`.
- **Edges with `d: null`** (decides/validates without a lane, `stats.hiddenEdges`) are drawn only for the selection via `directPath(a.card, b.card)`. Contradicts always has `d`, including `shape: "direct"`, drawn above the frames with the 3 px halo. `shape: "rail"` with `lane: null` occurs at Session level, which has no decides/validates rail lanes.
- **`homeFrameKey` rebuilds the context per call** (0.055 ms at 5k steps). Memoize `frameForSelection` per (layout, selection) rather than calling it in the render body on every camera tick, and never call it per step.
- **Separators carry `turn`.** A queued instruction whose step `tMs` precedes its turn's `tMs` is placed, per spec, in the previous turn's column (item turn = last turn with `tMs <= start`). Label story frames from the frame's own item, not from the column's turn.
- **Levels and `prev`.** Pass `prev` only for the same level and session; a level switch or Tidy calls `layoutCanvas` without `prev`. Rerun only when `loadedThroughSeq` changes (spec §7.5 complexity note).
- **Trunk endpoints follow placement order.** A trunk's `from`/`to` are its first and last placed frames, not its (col, row) extremes; ids stay `trunk:turn:N`. Do not derive trunk geometry from `from`/`to` column positions.
- **Open C3a follow-ups (not blocking):** rails in column 0 draw at x < 0 (`railX` uses gutterLeft = -colGap) while bounds start at x 0, so Fit and the minimap clip them; P9's per-finding edge count assumes no cross-finding dedupe (assert per (from, to)); carried minors: `turnLocator` returns turn 0 before the first turn, `frameBySel` is first-frame-wins, P8's `frameByKey.has(key)` check is tautological, the bench has no frame-count guard, `edge.d ?? ""` in the minimap is dead code.

### Task C3-5: M4b spike gate: risks 2, 3, 6, 7 passed or ruled; apply rulings

**Files:**
- Modify: `docs/spikes/trace-viewer-spike.md` (append a "M4b gate (C3-5)" section)
- Create: `packages/trace-viewer/src/ui/views/canvas/spike-rulings.ts`
- Modify: `packages/trace-viewer/src/ui/views/registry.ts` (risk 6 ruling only)

**Interfaces:**
- Consumes: the spike doc C1-7 wrote (one row per risk with the measured values, "pass" or "fail" against spec §16's pass column, and the ruling); C2-14 `registry.ts` with `export const KEEP_HIDDEN_VIEWS_MOUNTED: boolean`; C1-6 `ViewportControllerOptions.settleRoundK?: number | null`.
- Produces (deviation 13):

```ts
// ui/views/canvas/spike-rulings.ts
/** Spike risk 3 (text crispness at rest): 64 rounds k to a 1/64 grid at settle; null leaves k alone. */
export const CANVAS_SETTLE_ROUND_K: number | null;
/** Spike risk 7 (edge hairlines, ruler sync): true writes --tv-inv-k every frame instead of at settle. */
export const INV_K_EVERY_FRAME: boolean;
/** Spike risk 2 (DOM raster cost at Step level): true culls frames by x0 binary search and caps Step lists. */
export const CULL_FRAMES: boolean;
```

- [ ] **Step 1: Read the four gating rows**

Run: `grep -nE '^\| *(2|3|6|7) *\|' docs/spikes/trace-viewer-spike.md`
Expected: four table rows, one each for risks 2, 3, 6 and 7, each containing the word `pass` or `fail`. If a row is missing, or a row has neither word, stop and escalate: M4b does not start (spec §12 "Spike risks 2, 3, 6, 7 pass").

- [ ] **Step 2: Write the rulings file from the verdicts**

Create `packages/trace-viewer/src/ui/views/canvas/spike-rulings.ts`, choosing each value from the table below by the verdict Step 1 printed:

| Risk | Verdict `pass` | Verdict `fail` (spec §16 "If it fails") |
|---|---|---|
| 2 | `CULL_FRAMES = false` | `CULL_FRAMES = true` ("Cull by binary search on `x0`; cap Step lists") |
| 3 | `CANVAS_SETTLE_ROUND_K = null` | `CANVAS_SETTLE_ROUND_K = 64` ("Round `k` to a 1/64 grid at settle") |
| 7 | `INV_K_EVERY_FRAME = false` | `INV_K_EVERY_FRAME = true` ("Write `--tv-inv-k` every frame instead of at settle") |

With every risk passing, the file is:

```ts
// M4b spike rulings (docs/spikes/trace-viewer-spike.md, "M4b gate (C3-5)"). Each constant is the
// spec §16 fallback for one risk; the Canvas view reads them at its call sites.

/** Spike risk 3 (text crispness at rest): 64 rounds k to a 1/64 grid at settle; null leaves k alone. */
export const CANVAS_SETTLE_ROUND_K: number | null = null;

/** Spike risk 7 (edge hairlines, ruler sync): true writes --tv-inv-k every frame instead of at settle. */
export const INV_K_EVERY_FRAME: boolean = false;

/** Spike risk 2 (DOM raster cost at Step level): true culls frames by x0 binary search and caps Step lists. */
export const CULL_FRAMES: boolean = false;
```

The explicit `number | null` and `boolean` annotations keep TypeScript from narrowing the constants to literals, so the branches that read them stay type-checked either way.

- [ ] **Step 3: Apply the risk 6 ruling (only when risk 6 failed)**

If risk 6's verdict is `fail` ("Unmount the hidden view and restore from the store"), open `packages/trace-viewer/src/ui/views/registry.ts`, find:

```ts
export const KEEP_HIDDEN_VIEWS_MOUNTED = true;
```

and replace it with:

```ts
/** Spike risk 6 failed (docs/spikes/trace-viewer-spike.md "M4b gate"): hidden views unmount and restore from the store. */
export const KEEP_HIDDEN_VIEWS_MOUNTED = false;
```

If the file declares the constant with a type annotation or a comment above it, keep them and change only the value. With risk 6 passing, leave `registry.ts` untouched.

- [ ] **Step 4: Append the gate section to the spike doc**

Append to `docs/spikes/trace-viewer-spike.md`, filling each verdict and ruling from Step 1 and Step 2 (the rows below show the all-pass case):

```markdown
## M4b gate (C3-5)

Date: <YYYY-MM-DD>. Lane C3b (`tv/c3b-canvas-view`). Source rows: the risk table above.

| Risk | Verdict | Ruling applied | Where |
|---|---|---|---|
| 2 DOM raster cost during pinch at Step level | pass | none | `CULL_FRAMES = false` in `packages/trace-viewer/src/ui/views/canvas/spike-rulings.ts` |
| 3 Text crispness at rest | pass | none | `CANVAS_SETTLE_ROUND_K = null` (same file) |
| 6 View switch under `<Activity>` | pass | none | `KEEP_HIDDEN_VIEWS_MOUNTED = true` in `packages/trace-viewer/src/ui/views/registry.ts` |
| 7 Edge hairlines and ruler sync | pass | none | `INV_K_EVERY_FRAME = false` (same file as risk 2) |

M4b may start: every gating risk passed or has its spec §16 fallback applied above.
```

- [ ] **Step 5: Typecheck and root checks**

Run: `pnpm --filter @jevcode/trace-viewer typecheck && pnpm lint`, then the root checks. Expected: all exit 0 (the rulings file has no importer yet; `noUnusedLocals` does not flag exports).

- [ ] **Step 6: Commit**

```bash
git add docs/spikes/trace-viewer-spike.md packages/trace-viewer/src/ui/views/canvas/spike-rulings.ts
git commit -m "docs(trace-viewer): M4b spike gate and canvas rulings"
```

When Step 3 changed `registry.ts`, add `packages/trace-viewer/src/ui/views/registry.ts` to the `git add` line.

### Task C3-9: Canvas camera rules: fit, zoom to selection, reveal, level-switch pinning, brush window

**Files:**
- Create: `packages/trace-viewer/src/ui/views/canvas/canvas-camera.ts`
- Create: `packages/trace-viewer/src/ui/views/canvas/canvas-camera.test.ts`

**Interfaces:**
- Consumes: C1-5 `UniformCamera`, `Point`, `Rect`, `Size`, `ZoomLimits`, `fitBounds(bounds: Rect, viewport: Size, options: { padding: number; limits: ZoomLimits }): UniformCamera`, `setCenter(camera: UniformCamera, world: Point, viewport: Size): UniformCamera`, `isInsideInset(camera: UniformCamera, rect: Rect, viewport: Size, inset: number): boolean`, `worldToScreen(camera, world): Point`, `screenToWorld(camera, screen): Point`; C1-9 `TimeScale`, `XMap`; C1-10 `TraceIndex` (`stepIndexAtOrAfter(seq)`, `stepIndexAtOrBefore(seq)`), `Brush`, `brushSeqRange(brush: Brush, index: TraceIndex): { fromSeq: number; toSeq: number }`; C3-2 `CanvasLayout`, `CanvasFrame`, `canvasXMap`; C3-1 `LEVEL_SPECS`.
- Produces:

```ts
export const FIT_PADDING_PX = 48;
export const REVEAL_INSET_PX = 48;
export const FIT_MAX_K = 1;
export const FIT_LEVEL_SWITCH_K = 0.35;
export const SELECTION_MAX_K = 1.5;
export const NEIGHBOR_FIT_MIN_K = 0.75;
export const DEFAULT_CAMERA: UniformCamera;          // { mode: "uniform", tx: 48, ty: 48, k: 1 }
export function levelLimits(level: Level): ZoomLimits;
export type FitPlan = { kind: "switch"; level: "session" } | { kind: "camera"; camera: UniformCamera };
/** Spec §7.5 Fit: 48 px padding, k ≤ 1; a Chapter/Step fit below 0.35 switches to Session first; null for a 0 × 0 viewport. */
export function planFit(layout: CanvasLayout, viewport: Size): FitPlan | null;
/** Selection plus non-trunk rest-edge neighbors when that fits at ≥ 0.75, else the selection; k ≤ 1.5. */
export function zoomToSelection(layout: CanvasLayout, frameKey: string, viewport: Size): UniformCamera | null;
/** null when the card is inside the viewport inset by 48 px; else setCenter at the same k. Never zooms. */
export function revealCamera(camera: UniformCamera, card: Rect, viewport: Size): UniformCamera | null;
/** The card's top-left keeps its screen point; k clamped to the new level's limits. */
export function pinFrameCamera(camera: UniformCamera, before: Rect, after: Rect, limits: ZoomLimits): UniformCamera;
export function intersectsViewport(camera: UniformCamera, rect: Rect, viewport: Size): boolean;
export function nearestFrameToCenter(layout: CanvasLayout, camera: UniformCamera, viewport: Size): CanvasFrame | undefined;
/** The selection's frame when it is on screen, else the frame nearest the center. */
export function focusFrame(layout: CanvasLayout, camera: UniformCamera, viewport: Size, selected: CanvasFrame | undefined): CanvasFrame | undefined;
/** Live: x-only pan that brings the frontier column's right edge to viewport.w − 48; null when already inside. */
export function frontierFollowCamera(layout: CanvasLayout, camera: UniformCamera, viewport: Size): UniformCamera | null;
/** Frames whose card starts at or beyond the viewport's right edge ("N frames →"). */
export function framesAhead(layout: CanvasLayout, camera: UniformCamera, viewport: Size): number;
/** x of the last column with t0 ≤ t (bounds.x when none). */
export function columnXAt(layout: CanvasLayout, t: number): number;
export interface ShowCameraInput { layout: CanvasLayout; scale: TimeScale; session: TraceSession; index: TraceIndex; brush: Brush; camera: UniformCamera; viewport: Size; selectionCard: Rect | null }
/** Stale restore (spec §7.8 item 3): fit the brush horizontally with k ∈ [minZoom(level), 1.5], keep ty, then reveal without zooming. */
export function showCamera(input: ShowCameraInput): UniformCamera | null;
export interface BrushWindowInput { layout: CanvasLayout; scale: TimeScale; session: TraceSession; camera: UniformCamera; viewport: Size }
/** The steps whose start lies inside the visible x window, as a range brush; null for an empty window. */
export function brushForWindow(input: BrushWindowInput): Brush | null;
/** Screen x ↔ time: the world map composed with the camera (for the Ruler). */
export function screenXMap(map: XMap, camera: UniformCamera): XMap;
export interface CameraStore { get(): UniformCamera; set(camera: UniformCamera): void; subscribe(listener: () => void): () => void }
export function createCameraStore(initial: UniformCamera): CameraStore;
```

- [ ] **Step 1: Write the failing tests**

Create `packages/trace-viewer/src/ui/views/canvas/canvas-camera.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { layoutCanvas, type CanvasFrame, type CanvasLayout } from "../../../layout/canvas-layout.js";
import { LEVEL_SPECS } from "../../../layout/canvas-levels.js";
import { buildTraceIndex } from "../../../layout/trace-index.js";
import { isInsideInset, worldToScreen, type Size, type UniformCamera } from "../../../layout/viewport.js";
import type { Level, TraceSession } from "../../../model/index.js";
import { buildCanvasSession, canvasScale, oauthCanvasSession } from "../../../test-support/canvas-arbitraries.js";
import {
  brushForWindow,
  createCameraStore,
  focusFrame,
  framesAhead,
  frontierFollowCamera,
  levelLimits,
  pinFrameCamera,
  planFit,
  revealCamera,
  screenXMap,
  showCamera,
  zoomToSelection,
} from "./canvas-camera.js";

// Expected values: spec §7.5 "Viewport commands", §7.8 item 3 and §7.10 (Canvas row).

function fresh(session: TraceSession, level: Level = "chapter"): CanvasLayout {
  return layoutCanvas(session, buildTraceIndex(session), canvasScale(session), level);
}

function camera(tx: number, ty: number, k: number): UniformCamera {
  return { mode: "uniform", tx, ty, k };
}

const oauth = oauthCanvasSession();
const layout = fresh(oauth);

function frame(predicate: (candidate: CanvasFrame) => boolean): CanvasFrame {
  const found = layout.frames.find(predicate);
  if (found === undefined) throw new Error("frame not found");
  return found;
}

const claim = frame((candidate) => candidate.item === "claim");
const linkingTest = frame((candidate) => candidate.selId === "unit:oauth-linking-test-failure");

describe("planFit", () => {
  it("switches the shared level to Session when a Chapter fit falls below 0.35", () => {
    const wide = buildCanvasSession(
      Array.from({ length: 80 }, (_, i) => ({ atMs: 1_000 * (i + 1), kind: "chapter" as const })),
    );
    expect(planFit(fresh(wide), { w: 800, h: 600 })).toEqual({ kind: "switch", level: "session" });
    const plan = planFit(fresh(wide, "session"), { w: 800, h: 600 });
    expect(plan?.kind).toBe("camera");
    if (plan?.kind === "camera") {
      expect(plan.camera.k).toBeGreaterThanOrEqual(LEVEL_SPECS.session.minZoom);
      expect(plan.camera.k).toBeLessThanOrEqual(1);
    }
  });

  it("fits oauth width-bound in the 1440 × 900 window's main area", () => {
    // Spec §7.5: (1440 − 216 − 280 − 2 · 48) / 1016 ≈ 0.83.
    const plan = planFit(layout, { w: 1440 - 216 - 280, h: 900 - 40 - 28 });
    expect(plan?.kind).toBe("camera");
    if (plan?.kind === "camera") expect(plan.camera.k).toBeCloseTo((1440 - 216 - 280 - 96) / 1016, 6);
  });

  it("never fits a 0x0 viewport", () => {
    expect(planFit(layout, { w: 0, h: 0 })).toBeNull();
  });
});

describe("zoomToSelection", () => {
  it("caps at 1.5", () => {
    expect(zoomToSelection(layout, linkingTest.key, { w: 4_000, h: 3_000 })?.k).toBe(1.5);
  });

  it("includes rest-edge neighbors when they fit at 0.75 or more, else the selection alone", () => {
    const roomy: Size = { w: 1_400, h: 900 };
    const both = zoomToSelection(layout, claim.key, roomy);
    if (both === null) throw new Error("no camera");
    expect(isInsideInset(both, claim.card, roomy, 0)).toBe(true);
    expect(isInsideInset(both, linkingTest.card, roomy, 0)).toBe(true);
    const tight = zoomToSelection(layout, claim.key, { w: 400, h: 300 });
    expect(tight?.k).toBeCloseTo((400 - 96) / 224, 6);
  });
});

describe("revealCamera", () => {
  it("does nothing when the card is inside the 48 px inset and never zooms", () => {
    const at = camera(0, 0, 1);
    expect(revealCamera(at, { x: 100, y: 100, w: 200, h: 100 }, { w: 800, h: 600 })).toBeNull();
    const moved = revealCamera(at, { x: 2_000, y: 100, w: 200, h: 100 }, { w: 800, h: 600 });
    if (moved === null) throw new Error("expected a move");
    expect(moved.k).toBe(1);
    expect(worldToScreen(moved, { x: 2_100, y: 150 })).toEqual({ x: 400, y: 300 });
  });

  it("does nothing for a 0x0 viewport", () => {
    expect(revealCamera(camera(0, 0, 1), { x: 2_000, y: 100, w: 200, h: 100 }, { w: 0, h: 0 })).toBeNull();
  });
});

describe("pinFrameCamera", () => {
  it("keeps the focus card's top-left on the same screen point and clamps k to the new level", () => {
    const before = { x: 264, y: 172, w: 224, h: 112 };
    const after = { x: 192, y: 116, w: 168, h: 28 };
    const from = camera(10, 20, 0.8);
    const pinned = pinFrameCamera(from, before, after, levelLimits("session"));
    const was = worldToScreen(from, { x: before.x, y: before.y });
    const now = worldToScreen(pinned, { x: after.x, y: after.y });
    expect(now.x).toBeCloseTo(was.x, 9);
    expect(now.y).toBeCloseTo(was.y, 9);
    expect(pinFrameCamera(camera(10, 20, 0.1), before, after, levelLimits("session")).k).toBe(0.25);
  });
});

describe("focusFrame", () => {
  it("prefers the selection when it is on screen, else the frame nearest the center", () => {
    const view: Size = { w: 800, h: 600 };
    const at = camera(0, 0, 1);
    expect(focusFrame(layout, at, view, linkingTest)?.key).toBe(linkingTest.key);
    const offscreenClaim = focusFrame(layout, camera(0, 0, 1), { w: 500, h: 400 }, claim);
    expect(offscreenClaim?.key).not.toBe(claim.key);
  });
});

describe("brushForWindow", () => {
  it("writes the steps inside a settled window", () => {
    // World x ∈ [0, 600] maps to [+0:00, +0:34]: between Linking test (592 px, 33 s) and the claim's
    // breakpoint (672 px, 43 s), x = 600 is 33 s + 8/80 · 10 s. The last step starting by then is the
    // tests/auth/oauth.test.ts edit (33.0 s); `pnpm test` starts at 35.0 s.
    const brush = brushForWindow({
      layout,
      scale: canvasScale(oauth),
      session: oauth,
      camera: camera(0, 0, 1),
      viewport: { w: 600, h: 600 },
    });
    const lastInside = oauth.steps.find((step) => step.edit?.path === "tests/auth/oauth.test.ts");
    expect(brush).toEqual({ kind: "range", fromSeq: oauth.steps[0]?.firstSeq, toSeq: lastInside?.lastSeq });
  });

  it("writes nothing for an empty window", () => {
    const brush = brushForWindow({
      layout,
      scale: canvasScale(oauth),
      session: oauth,
      camera: camera(-5_000, 0, 1),
      viewport: { w: 600, h: 600 },
    });
    expect(brush).toBeNull();
  });
});

describe("live follow and the N frames badge", () => {
  it("pans x only when the frontier column leaves the view", () => {
    const view: Size = { w: 600, h: 600 };
    expect(frontierFollowCamera(layout, camera(-464, 12, 1), view)).toBeNull();
    expect(frontierFollowCamera(layout, camera(0, 12, 1), view)).toEqual(camera(-464, 12, 1));
  });

  it("counts frames that start beyond the right edge", () => {
    expect(framesAhead(layout, camera(-150, 0, 1), { w: 600, h: 600 })).toBe(1);
    expect(framesAhead(layout, camera(-464, 0, 1), { w: 600, h: 600 })).toBe(0);
  });
});

describe("showCamera", () => {
  it("fits a chapter brush horizontally within [minZoom, 1.5], keeps ty and shows the chapter's column", () => {
    const index = buildTraceIndex(oauth);
    const unit = oauth.chapters.find((chapter) => chapter.changeUnitId === "oauth-linking-test-failure");
    const key = unit === undefined ? undefined : index.chapterKey(unit.id);
    if (key === undefined) throw new Error("no chapter key");
    const view: Size = { w: 800, h: 600 };
    const shown = showCamera({
      layout,
      scale: canvasScale(oauth),
      session: oauth,
      index,
      brush: { kind: "chapter", anchorSeq: Number(key.slice(3)) },
      camera: camera(0, 37, 1),
      viewport: view,
      selectionCard: null,
    });
    if (shown === null) throw new Error("no camera");
    expect(shown.ty).toBe(37);
    expect(shown.k).toBeGreaterThanOrEqual(LEVEL_SPECS.chapter.minZoom);
    expect(shown.k).toBeLessThanOrEqual(1.5);
    expect(worldToScreen(shown, { x: 528, y: 0 }).x).toBeGreaterThanOrEqual(0);
    expect(worldToScreen(shown, { x: 752, y: 0 }).x).toBeLessThanOrEqual(view.w);
  });

  it("never fits a 0x0 viewport", () => {
    const index = buildTraceIndex(oauth);
    expect(
      showCamera({
        layout,
        scale: canvasScale(oauth),
        session: oauth,
        index,
        brush: { kind: "session" },
        camera: camera(0, 0, 1),
        viewport: { w: 0, h: 0 },
        selectionCard: null,
      }),
    ).toBeNull();
  });
});

describe("screenXMap and the camera store", () => {
  it("composes the world map with the camera", () => {
    const screen = screenXMap({ xOf: (t) => t / 10, tOf: (x) => x * 10 }, camera(5, 0, 2));
    expect(screen.xOf(100)).toBe(25);
    expect(screen.tOf(25)).toBe(100);
  });

  it("notifies subscribers only when the camera changes", () => {
    const store = createCameraStore(camera(0, 0, 1));
    const listener = vi.fn();
    const stop = store.subscribe(listener);
    store.set(camera(0, 0, 1));
    store.set(camera(3, 0, 1));
    stop();
    store.set(camera(4, 0, 1));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get()).toEqual(camera(4, 0, 1));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/canvas/canvas-camera.test.ts`
Expected: FAIL with `Failed to load url ./canvas-camera.js`.

- [ ] **Step 3: Write `canvas-camera.ts`**

Create `packages/trace-viewer/src/ui/views/canvas/canvas-camera.ts`:

```ts
import { canvasXMap, type CanvasFrame, type CanvasLayout } from "../../../layout/canvas-layout.js";
import { LEVEL_SPECS } from "../../../layout/canvas-levels.js";
import type { TimeScale, XMap } from "../../../layout/time-scale.js";
import { brushSeqRange, type Brush, type TraceIndex } from "../../../layout/trace-index.js";
import {
  fitBounds,
  isInsideInset,
  screenToWorld,
  setCenter,
  worldToScreen,
  type Rect,
  type Size,
  type UniformCamera,
  type ZoomLimits,
} from "../../../layout/viewport.js";
import type { Level, TraceSession } from "../../../model/index.js";

export const FIT_PADDING_PX = 48;
export const REVEAL_INSET_PX = 48;
export const FIT_MAX_K = 1;
export const FIT_LEVEL_SWITCH_K = 0.35;
export const SELECTION_MAX_K = 1.5;
export const NEIGHBOR_FIT_MIN_K = 0.75;
export const DEFAULT_CAMERA: UniformCamera = { mode: "uniform", tx: FIT_PADDING_PX, ty: FIT_PADDING_PX, k: 1 };

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function hasArea(viewport: Size): boolean {
  return viewport.w > 0 && viewport.h > 0;
}

function rawFitK(rect: Rect, viewport: Size): number {
  return Math.min(
    (viewport.w - 2 * FIT_PADDING_PX) / Math.max(1, rect.w),
    (viewport.h - 2 * FIT_PADDING_PX) / Math.max(1, rect.h),
  );
}

function unionRect(rects: readonly Rect[]): Rect {
  const x0 = Math.min(...rects.map((rect) => rect.x));
  const y0 = Math.min(...rects.map((rect) => rect.y));
  const x1 = Math.max(...rects.map((rect) => rect.x + rect.w));
  const y1 = Math.max(...rects.map((rect) => rect.y + rect.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function levelLimits(level: Level): ZoomLimits {
  const spec = LEVEL_SPECS[level];
  return { minK: spec.minZoom, maxK: spec.maxZoom };
}

export type FitPlan = { kind: "switch"; level: "session" } | { kind: "camera"; camera: UniformCamera };

export function planFit(layout: CanvasLayout, viewport: Size): FitPlan | null {
  const bounds = layout.bounds;
  if (!hasArea(viewport) || bounds.w <= 0 || bounds.h <= 0) return null;
  if (layout.level !== "session" && rawFitK(bounds, viewport) < FIT_LEVEL_SWITCH_K) {
    return { kind: "switch", level: "session" };
  }
  const spec = LEVEL_SPECS[layout.level];
  return {
    kind: "camera",
    camera: fitBounds(bounds, viewport, { padding: FIT_PADDING_PX, limits: { minK: spec.minZoom, maxK: FIT_MAX_K } }),
  };
}

export function zoomToSelection(layout: CanvasLayout, frameKey: string, viewport: Size): UniformCamera | null {
  const frame = layout.frameByKey.get(frameKey);
  if (frame === undefined || !hasArea(viewport)) return null;
  const limits = { minK: LEVEL_SPECS[layout.level].minZoom, maxK: SELECTION_MAX_K };
  const neighbors = layout.edges
    .filter((edge) => edge.rest && edge.kind !== "trunk" && (edge.from === frameKey || edge.to === frameKey))
    .map((edge) => layout.frameByKey.get(edge.from === frameKey ? edge.to : edge.from))
    .filter((other): other is CanvasFrame => other !== undefined);
  if (neighbors.length > 0) {
    const union = unionRect([frame.card, ...neighbors.map((other) => other.card)]);
    if (rawFitK(union, viewport) >= NEIGHBOR_FIT_MIN_K) {
      return fitBounds(union, viewport, { padding: FIT_PADDING_PX, limits });
    }
  }
  return fitBounds(frame.card, viewport, { padding: FIT_PADDING_PX, limits });
}

export function revealCamera(camera: UniformCamera, card: Rect, viewport: Size): UniformCamera | null {
  if (!hasArea(viewport) || isInsideInset(camera, card, viewport, REVEAL_INSET_PX)) return null;
  return setCenter(camera, { x: card.x + card.w / 2, y: card.y + card.h / 2 }, viewport);
}

export function pinFrameCamera(camera: UniformCamera, before: Rect, after: Rect, limits: ZoomLimits): UniformCamera {
  const screen = worldToScreen(camera, { x: before.x, y: before.y });
  const k = clamp(camera.k, limits.minK, limits.maxK);
  return { mode: "uniform", k, tx: screen.x - after.x * k, ty: screen.y - after.y * k };
}

export function intersectsViewport(camera: UniformCamera, rect: Rect, viewport: Size): boolean {
  const a = worldToScreen(camera, { x: rect.x, y: rect.y });
  const b = worldToScreen(camera, { x: rect.x + rect.w, y: rect.y + rect.h });
  return b.x > 0 && a.x < viewport.w && b.y > 0 && a.y < viewport.h;
}

export function nearestFrameToCenter(layout: CanvasLayout, camera: UniformCamera, viewport: Size): CanvasFrame | undefined {
  const center = screenToWorld(camera, { x: viewport.w / 2, y: viewport.h / 2 });
  let best: CanvasFrame | undefined;
  let bestDistance = Infinity;
  for (const frame of layout.frames) {
    const distance = Math.hypot(frame.card.x + frame.card.w / 2 - center.x, frame.card.y + frame.card.h / 2 - center.y);
    if (distance < bestDistance) {
      best = frame;
      bestDistance = distance;
    }
  }
  return best;
}

export function focusFrame(
  layout: CanvasLayout,
  camera: UniformCamera,
  viewport: Size,
  selected: CanvasFrame | undefined,
): CanvasFrame | undefined {
  if (selected !== undefined && hasArea(viewport) && intersectsViewport(camera, selected.card, viewport)) return selected;
  return nearestFrameToCenter(layout, camera, viewport);
}

export function frontierFollowCamera(layout: CanvasLayout, camera: UniformCamera, viewport: Size): UniformCamera | null {
  const column = layout.columns[layout.columns.length - 1];
  if (column === undefined || !hasArea(viewport)) return null;
  const right = column.x + LEVEL_SPECS[layout.level].w;
  const limit = viewport.w - REVEAL_INSET_PX;
  if (right * camera.k + camera.tx <= limit) return null;
  return { ...camera, tx: limit - right * camera.k };
}

export function framesAhead(layout: CanvasLayout, camera: UniformCamera, viewport: Size): number {
  if (!hasArea(viewport)) return 0;
  return layout.frames.filter((frame) => frame.card.x * camera.k + camera.tx >= viewport.w).length;
}

export function columnXAt(layout: CanvasLayout, t: number): number {
  let x = layout.bounds.x;
  for (const column of layout.columns) {
    if (column.t0 > t) break;
    x = column.x;
  }
  return x;
}

export interface ShowCameraInput {
  layout: CanvasLayout;
  scale: TimeScale;
  session: TraceSession;
  index: TraceIndex;
  brush: Brush;
  camera: UniformCamera;
  viewport: Size;
  selectionCard: Rect | null;
}

export function showCamera(input: ShowCameraInput): UniformCamera | null {
  const { layout, viewport } = input;
  if (!hasArea(viewport) || layout.frames.length === 0) return null;
  const spec = LEVEL_SPECS[layout.level];
  let x0 = layout.bounds.x;
  let x1 = layout.bounds.x + layout.bounds.w;
  if (input.brush.kind !== "session") {
    const { fromSeq, toSeq } = brushSeqRange(input.brush, input.index);
    const first = input.session.steps[input.index.stepIndexAtOrAfter(fromSeq)];
    const last = input.session.steps[input.index.stepIndexAtOrBefore(toSeq)];
    if (first !== undefined && last !== undefined && first.firstSeq <= last.firstSeq) {
      x0 = columnXAt(layout, first.tMs);
      x1 = Math.max(columnXAt(layout, last.tMs), x0) + spec.w;
    }
  }
  const k = clamp((viewport.w - 2 * FIT_PADDING_PX) / Math.max(1, x1 - x0), spec.minZoom, SELECTION_MAX_K);
  const fitted: UniformCamera = {
    mode: "uniform",
    k,
    tx: (viewport.w - (x1 - x0) * k) / 2 - x0 * k,
    ty: input.camera.ty,
  };
  const revealed = input.selectionCard === null ? null : revealCamera(fitted, input.selectionCard, viewport);
  return revealed ?? fitted;
}

export interface BrushWindowInput {
  layout: CanvasLayout;
  scale: TimeScale;
  session: TraceSession;
  camera: UniformCamera;
  viewport: Size;
}

export function brushForWindow(input: BrushWindowInput): Brush | null {
  const { camera, viewport, session } = input;
  if (!hasArea(viewport)) return null;
  const map = canvasXMap(input.layout, input.scale);
  const t0 = map.tOf(screenToWorld(camera, { x: 0, y: 0 }).x);
  const t1 = map.tOf(screenToWorld(camera, { x: viewport.w, y: 0 }).x);
  const steps = session.steps;
  let lo = 0;
  let hi = steps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((steps[mid]?.tMs ?? Infinity) < t0) lo = mid + 1;
    else hi = mid;
  }
  const first = lo;
  lo = 0;
  hi = steps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((steps[mid]?.tMs ?? Infinity) <= t1) lo = mid + 1;
    else hi = mid;
  }
  const last = lo - 1;
  const from = steps[first];
  const to = steps[last];
  if (from === undefined || to === undefined || first > last) return null;
  return { kind: "range", fromSeq: from.firstSeq, toSeq: to.lastSeq };
}

export function screenXMap(map: XMap, camera: UniformCamera): XMap {
  return {
    xOf: (tMs) => map.xOf(tMs) * camera.k + camera.tx,
    tOf: (x) => map.tOf((x - camera.tx) / camera.k),
  };
}

export interface CameraStore {
  get(): UniformCamera;
  set(camera: UniformCamera): void;
  subscribe(listener: () => void): () => void;
}

/** Holds the live camera outside React so per-frame writes reach only the ruler, minimap and badge. */
export function createCameraStore(initial: UniformCamera): CameraStore {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (camera) => {
      if (camera.tx === current.tx && camera.ty === current.ty && camera.k === current.k) return;
      current = camera;
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/canvas/canvas-camera.test.ts`
Expected: PASS, `Tests  17 passed (17)`.

- [ ] **Step 5: Typecheck, lint and root checks**

Run: `pnpm --filter @jevcode/trace-viewer typecheck && pnpm lint`, then the root checks. Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/trace-viewer/src/ui/views/canvas/canvas-camera.ts packages/trace-viewer/src/ui/views/canvas/canvas-camera.test.ts
git commit -m "feat(trace-viewer): canvas camera rules for fit, reveal, pinning and brush writes"
```

### Task C3-6: Frame components per kind and level, labels, zoom bands

**Files:**
- Create: `packages/trace-viewer/src/ui/views/canvas/frame-label.ts`
- Create: `packages/trace-viewer/src/ui/views/canvas/frame-label.test.ts`
- Create: `packages/trace-viewer/src/ui/views/canvas/frame-content.tsx`
- Create: `packages/trace-viewer/src/ui/views/canvas/Frame.tsx`
- Create: `packages/trace-viewer/src/ui/views/canvas/Frame.module.css`
- Create: `packages/trace-viewer/src/ui/views/canvas/frame.test.tsx`

**Interfaces:**
- Consumes: C3-2 `CanvasFrame`; C3-1 `STEP_LIST_ROWS`, `GRAPHIC_MIN_K`, `ICON_ONLY_K`; C1-10 `stepTone(step: Step, findingsById: ReadonlyMap<FindingId, Finding>): Tone`; model `formatOffset(ms: number): string`, `formatDuration(ms: number | null): string`, `pickGraphic(target: Step | Chapter, session: TraceSession): GraphicSpec | null`, `describeGraphic(spec: GraphicSpec): string`; C1-2 `Icon(props: { name: IconName; size?: 12 | 14 | 16; title?: string; className?: string })`, `IconName`, `KIND_ICON`, `CATEGORY_ICON`; C1-3/C1-4 `Graphic(props: { spec: GraphicSpec; size: GraphicSize; label?: string; elapsedMs?: number })`, `DiffBar` (`{ size; added; removed; label? }`); C2-6 `FINDING_TITLE`; C3-5 `CULL_FRAMES`.
- Produces:

```ts
// frame-label.ts
export interface FrameContext { session: TraceSession; stepById: ReadonlyMap<string, Step>; chapterById: ReadonlyMap<string, Chapter>; findingsById: ReadonlyMap<FindingId, Finding> }
export function buildFrameContext(session: TraceSession): FrameContext;
export function frameSteps(frame: CanvasFrame, ctx: FrameContext): Step[];
export function frameStart(frame: CanvasFrame, ctx: FrameContext): number;
export function frameEnd(frame: CanvasFrame, ctx: FrameContext): number;
export function frameTitle(frame: CanvasFrame, ctx: FrameContext): string;
export function frameIcon(frame: CanvasFrame, ctx: FrameContext): IconName;
export function frameTone(frame: CanvasFrame, ctx: FrameContext): "bad" | "neutral";
export type FrameFlag = "neq" | "failed" | "shield" | null;
export function frameFlag(frame: CanvasFrame, ctx: FrameContext): FrameFlag;
export function frameGraphic(frame: CanvasFrame, ctx: FrameContext): GraphicSpec | null;
/** Tests: failed first ("1 failed, 14 passed"); other graphics: describeGraphic. */
export function graphicPhrase(spec: GraphicSpec): string;
/** Spec §7.11: a chapter joined by time window (D11) shows ≈. */
export function frameApprox(frame: CanvasFrame, ctx: FrameContext): boolean;
/** Accessible name, e.g. "OAuth account-linking test failure, 1 failed, 14 passed, +0:33". */
export function frameLabel(frame: CanvasFrame, ctx: FrameContext): string;
export function claimSpanFor(step: Step, ctx: FrameContext): readonly [number, number] | undefined;
export type ZoomBand = "full" | "nographic" | "icon";
export function zoomBand(k: number): ZoomBand;
/** "+0:33 – 0:40". */
export function timeChip(start: number, end: number): string;
export type StepListRow = { t: "step"; step: Step } | { t: "band"; key: string; count: number };
/** ≤ maxRows steps: all; else head 3, tail 5 and problem steps, other runs collapsed into bands. */
export function frameStepRows(steps: readonly Step[], maxRows?: number): StepListRow[];

// Frame.tsx
export interface FrameProps { frame: CanvasFrame; level: Level; ctx: FrameContext; selected: boolean; focusTarget: boolean; expanded: boolean; onSelect(frame: CanvasFrame): void; onToggle(frame: CanvasFrame): void }
export const Frame: React.NamedExoticComponent<FrameProps>;
```

- [ ] **Step 1: Write the failing label tests**

Create `packages/trace-viewer/src/ui/views/canvas/frame-label.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { layoutCanvas, type CanvasFrame } from "../../../layout/canvas-layout.js";
import { buildTraceIndex } from "../../../layout/trace-index.js";
import { describeGraphic, type Step } from "../../../model/index.js";
import { buildCanvasSession, canvasScale, oauthCanvasSession } from "../../../test-support/canvas-arbitraries.js";
import {
  buildFrameContext,
  frameApprox,
  frameEnd,
  frameLabel,
  frameStart,
  frameStepRows,
  frameTone,
  graphicPhrase,
  timeChip,
  zoomBand,
} from "./frame-label.js";

// Expected strings: spec §7.13 ("Linking test, 1 failed, 14 passed, +0:33", with the model's unit title),
// §7.1 FINDING_TITLE, and the canvas mockup's time chip "+0:33 – 0:40".

const oauth = oauthCanvasSession();
const layout = layoutCanvas(oauth, buildTraceIndex(oauth), canvasScale(oauth), "chapter");
const ctx = buildFrameContext(oauth);

function frame(predicate: (candidate: CanvasFrame) => boolean): CanvasFrame {
  const found = layout.frames.find(predicate);
  if (found === undefined) throw new Error("frame not found");
  return found;
}

describe("frameLabel", () => {
  it("names oauth's linking-test chapter with failures first", () => {
    expect(frameLabel(frame((f) => f.selId === "unit:oauth-linking-test-failure"), ctx)).toBe(
      "OAuth account-linking test failure, 1 failed, 14 passed, +0:33",
    );
  });

  it("names the contradiction on the claim frame", () => {
    expect(frameLabel(frame((f) => f.item === "claim"), ctx)).toBe("Final claim, Claim contradicts tests, +0:43");
  });

  it("marks a chapter joined by time window as approximate and never red", () => {
    const base = buildCanvasSession([{ atMs: 1_000, kind: "chapter", title: "Identity layer" }]);
    const session = { ...base, chapters: base.chapters.map((chapter) => ({ ...chapter, link: "inferred" as const })) };
    const approxLayout = layoutCanvas(session, buildTraceIndex(session), canvasScale(session), "chapter");
    const approxFrame = approxLayout.frames.find((candidate) => candidate.kind === "chapter");
    if (approxFrame === undefined) throw new Error("no chapter frame");
    const approxCtx = buildFrameContext(session);
    expect(frameApprox(approxFrame, approxCtx)).toBe(true);
    const label = frameLabel(approxFrame, approxCtx);
    expect(label.startsWith("Identity layer, approximate join, ")).toBe(true);
    expect(label.endsWith(", +0:01")).toBe(true);
    expect(frameTone(approxFrame, approxCtx)).toBe("neutral");
  });

  it("gives the selected chapter's time chip", () => {
    const linkingTest = frame((f) => f.selId === "unit:oauth-linking-test-failure");
    expect(timeChip(frameStart(linkingTest, ctx), frameEnd(linkingTest, ctx))).toBe("+0:33 – 0:40");
  });
});

describe("graphicPhrase", () => {
  it("puts failures first for tests and keeps every other graphic's description", () => {
    expect(graphicPhrase({ kind: "tests", passed: 14, failed: 1, skipped: 0 })).toBe("1 failed, 14 passed");
    expect(graphicPhrase({ kind: "tests", passed: 3, failed: 0, skipped: 2 })).toBe("3 passed, 2 skipped");
    const diff = { kind: "diff" as const, added: 17, removed: 3 };
    expect(graphicPhrase(diff)).toBe(describeGraphic(diff));
  });
});

describe("zoomBand", () => {
  it("hides the graphic below 0.5 and shows only icon and state fill below 0.35", () => {
    expect(zoomBand(0.5)).toBe("full");
    expect(zoomBand(0.49)).toBe("nographic");
    expect(zoomBand(0.35)).toBe("nographic");
    expect(zoomBand(0.34)).toBe("icon");
  });
});

describe("frameStepRows", () => {
  const session = buildCanvasSession(
    Array.from({ length: 20 }, (_, i) => ({ atMs: 1_000 * (i + 1), kind: "work" as const })),
  );
  const work: Step[] = session.steps.slice(1);

  it("keeps every step when nine or fewer", () => {
    expect(frameStepRows(work.slice(0, 9)).map((row) => (row.t === "step" ? row.step.firstSeq : 0))).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it("keeps head 3, tail 5 and problem steps, collapsing other runs into bands", () => {
    const steps = work.map((step, i) => (i === 10 ? { ...step, problems: ["exit_nonzero" as const] } : step));
    expect(frameStepRows(steps).map((row) => (row.t === "band" ? `band ${row.count}` : row.step.firstSeq))).toEqual([
      2, 3, 4, "band 7", 12, "band 4", 17, 18, 19, 20, 21,
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/canvas/frame-label.test.ts`
Expected: FAIL with `Failed to load url ./frame-label.js`.

- [ ] **Step 3: Write `frame-label.ts`**

Create `packages/trace-viewer/src/ui/views/canvas/frame-label.ts`:

```ts
import type { CanvasFrame } from "../../../layout/canvas-layout.js";
import { GRAPHIC_MIN_K, ICON_ONLY_K, STEP_LIST_ROWS } from "../../../layout/canvas-levels.js";
import { stepTone } from "../../../layout/tone.js";
import {
  describeGraphic,
  formatOffset,
  pickGraphic,
  type Chapter,
  type Finding,
  type FindingId,
  type GraphicSpec,
  type Step,
  type TraceSession,
} from "../../../model/index.js";
import type { IconName } from "../../icons/icon-names.js";
import { CATEGORY_ICON, KIND_ICON } from "../../icons/kind-icons.js";
import { FINDING_TITLE } from "../../inspector/finding-copy.js";

export interface FrameContext {
  session: TraceSession;
  stepById: ReadonlyMap<string, Step>;
  chapterById: ReadonlyMap<string, Chapter>;
  findingsById: ReadonlyMap<FindingId, Finding>;
}

export function buildFrameContext(session: TraceSession): FrameContext {
  return {
    session,
    stepById: new Map(session.steps.map((step) => [step.id, step])),
    chapterById: new Map(session.chapters.map((chapter) => [chapter.id, chapter])),
    findingsById: new Map(session.findings.map((finding) => [finding.id, finding])),
  };
}

export function frameSteps(frame: CanvasFrame, ctx: FrameContext): Step[] {
  const out: Step[] = [];
  const seen = new Set<string>();
  for (const selId of frame.memberSelIds) {
    const chapter = ctx.chapterById.get(selId);
    for (const id of chapter === undefined ? [selId] : chapter.stepIds) {
      const step = ctx.stepById.get(id);
      if (step === undefined || seen.has(step.id)) continue;
      seen.add(step.id);
      out.push(step);
    }
  }
  return out.sort((a, b) => a.firstSeq - b.firstSeq);
}

export function frameStart(frame: CanvasFrame, ctx: FrameContext): number {
  let start = Infinity;
  for (const selId of frame.memberSelIds) {
    const t = ctx.chapterById.get(selId)?.tMs ?? ctx.stepById.get(selId)?.tMs;
    if (t !== undefined) start = Math.min(start, t);
  }
  return Number.isFinite(start) ? start : 0;
}

export function frameEnd(frame: CanvasFrame, ctx: FrameContext): number {
  let end = frameStart(frame, ctx);
  for (const selId of frame.memberSelIds) {
    const chapter = ctx.chapterById.get(selId);
    if (chapter !== undefined) end = Math.max(end, chapter.endTMs);
  }
  for (const step of frameSteps(frame, ctx)) end = Math.max(end, step.endTMs ?? step.tMs);
  return end;
}

function triggerOf(step: Step | undefined, ctx: FrameContext): string | undefined {
  return step === undefined ? undefined : ctx.session.turns.find((turn) => turn.index === step.turnIndex)?.trigger;
}

export function frameTitle(frame: CanvasFrame, ctx: FrameContext): string {
  const step = ctx.stepById.get(frame.selId);
  switch (frame.item) {
    case "intent":
      return "Intent";
    case "instruction": {
      const trigger = triggerOf(step, ctx);
      return trigger === "steer" ? "Steer" : trigger === "resume" ? "Resume" : "Instruction";
    }
    case "plan":
      return "Plan";
    case "decision":
      return step?.decision?.title ?? "Decision";
    case "claim":
      return "Final claim";
    case "noise":
      return `Noise ×${frame.memberSelIds.length}`;
    case "chapter":
      return frame.kind === "noise" ? "Noise ×1" : (ctx.chapterById.get(frame.selId)?.title ?? "Chapter");
    case "loose":
      return step?.headline ?? "Step";
  }
}

export function frameIcon(frame: CanvasFrame, ctx: FrameContext): IconName {
  switch (frame.item) {
    case "intent":
    case "instruction":
      return "person";
    case "plan":
      return "list";
    case "decision":
      return "fork";
    case "claim":
      return "quote";
    case "noise":
      return "stack";
    case "chapter": {
      if (frame.kind === "noise") return "stack";
      const chapter = ctx.chapterById.get(frame.selId);
      return chapter === undefined ? "list" : CATEGORY_ICON[chapter.category];
    }
    case "loose": {
      const step = ctx.stepById.get(frame.selId);
      return step === undefined ? "flag" : KIND_ICON[step.kind];
    }
  }
}

export function frameTone(frame: CanvasFrame, ctx: FrameContext): "bad" | "neutral" {
  for (const selId of frame.memberSelIds) {
    const chapter = ctx.chapterById.get(selId);
    if (chapter?.findingIds.some((id) => ctx.findingsById.get(id)?.severity === "critical") === true) return "bad";
  }
  return frameSteps(frame, ctx).some((step) => stepTone(step, ctx.findingsById) === "bad") ? "bad" : "neutral";
}

export type FrameFlag = "neq" | "failed" | "shield" | null;

export function frameFlag(frame: CanvasFrame, ctx: FrameContext): FrameFlag {
  if (frame.item === "claim") {
    const step = ctx.stepById.get(frame.selId);
    if (step?.findingIds.some((id) => ctx.findingsById.get(id)?.ruleId === "claim_contradicted") === true) return "neq";
  }
  if (frameTone(frame, ctx) === "bad") return "failed";
  const guarded = frame.memberSelIds.some((selId) => (ctx.chapterById.get(selId)?.clampIds.length ?? 0) > 0);
  return guarded ? "shield" : null;
}

export function frameGraphic(frame: CanvasFrame, ctx: FrameContext): GraphicSpec | null {
  if (frame.kind === "noise" || (frame.kind === "story" && frame.item !== "decision")) return null;
  if (frame.kind === "chapter") {
    const chapter = ctx.chapterById.get(frame.selId);
    return chapter === undefined ? null : pickGraphic(chapter, ctx.session);
  }
  const step = ctx.stepById.get(frame.selId);
  return step === undefined ? null : pickGraphic(step, ctx.session);
}

export function graphicPhrase(spec: GraphicSpec): string {
  if (spec.kind !== "tests") return describeGraphic(spec);
  const parts = spec.failed > 0 ? [`${spec.failed} failed`, `${spec.passed} passed`] : [`${spec.passed} passed`];
  if (spec.skipped > 0) parts.push(`${spec.skipped} skipped`);
  return parts.join(", ");
}

/** Spec §7.11 Partial: a chapter joined by time window (D11) carries ≈ on its frame. */
export function frameApprox(frame: CanvasFrame, ctx: FrameContext): boolean {
  return frame.memberSelIds.some((selId) => ctx.chapterById.get(selId)?.link === "inferred");
}

export function frameLabel(frame: CanvasFrame, ctx: FrameContext): string {
  const parts = [frameTitle(frame, ctx)];
  if (frameApprox(frame, ctx)) parts.push("approximate join");
  if (frameFlag(frame, ctx) === "neq") parts.push(FINDING_TITLE.claim_contradicted);
  const graphic = frameGraphic(frame, ctx);
  if (graphic !== null) parts.push(graphicPhrase(graphic));
  parts.push(formatOffset(frameStart(frame, ctx)));
  return parts.join(", ");
}

export function claimSpanFor(step: Step, ctx: FrameContext): readonly [number, number] | undefined {
  for (const id of step.findingIds) {
    const finding = ctx.findingsById.get(id);
    if (finding?.ruleId === "claim_contradicted" && finding.claimSpan !== undefined) return finding.claimSpan;
  }
  return undefined;
}

export type ZoomBand = "full" | "nographic" | "icon";

export function zoomBand(k: number): ZoomBand {
  return k < ICON_ONLY_K ? "icon" : k < GRAPHIC_MIN_K ? "nographic" : "full";
}

export function timeChip(start: number, end: number): string {
  return `${formatOffset(start)} – ${formatOffset(Math.max(start, end)).replace(/^\+/, "")}`;
}

export type StepListRow = { t: "step"; step: Step } | { t: "band"; key: string; count: number };

export function frameStepRows(steps: readonly Step[], maxRows = STEP_LIST_ROWS): StepListRow[] {
  if (steps.length <= maxRows) return steps.map((step) => ({ t: "step", step }));
  const keep = new Set<number>();
  for (let i = 0; i < 3; i += 1) keep.add(i);
  for (let i = steps.length - 5; i < steps.length; i += 1) keep.add(i);
  steps.forEach((step, i) => {
    if (step.problems.length > 0 || step.findingIds.length > 0) keep.add(i);
  });
  const rows: StepListRow[] = [];
  let run: Step[] = [];
  const flush = (): void => {
    const first = run[0];
    if (first !== undefined) rows.push({ t: "band", key: `band:${first.firstSeq}`, count: run.length });
    run = [];
  };
  steps.forEach((step, i) => {
    if (keep.has(i)) {
      flush();
      rows.push({ t: "step", step });
    } else {
      run.push(step);
    }
  });
  flush();
  return rows;
}
```

- [ ] **Step 4: Run the label tests to verify they pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/canvas/frame-label.test.ts`
Expected: PASS, `Tests  8 passed (8)`. If the linking-test label reads `…, 17 lines added, 0 removed, +0:33`, `pickGraphic` is still on the pre-amendment chapter rule (tests chapters must yield `kind: "tests"`, UI index §1.4 B-10): stop and escalate to the B lane; do not special-case it here.

- [ ] **Step 5: Write the failing component tests**

Create `packages/trace-viewer/src/ui/views/canvas/frame.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { layoutCanvas, type CanvasFrame } from "../../../layout/canvas-layout.js";
import { buildTraceIndex } from "../../../layout/trace-index.js";
import type { Level, TraceSession } from "../../../model/index.js";
import { buildCanvasSession, canvasScale, oauthCanvasSession } from "../../../test-support/canvas-arbitraries.js";
import { Frame } from "./Frame.js";
import { buildFrameContext } from "./frame-label.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderFrame(
  session: TraceSession,
  predicate: (frame: CanvasFrame) => boolean,
  options: { level?: Level; expanded?: boolean } = {},
) {
  const level = options.level ?? "chapter";
  const layout = layoutCanvas(session, buildTraceIndex(session), canvasScale(session), level);
  const frame = layout.frames.find(predicate);
  if (frame === undefined) throw new Error("frame not found");
  const onSelect = vi.fn();
  const onToggle = vi.fn();
  const view = render(
    <Frame
      frame={frame}
      level={level}
      ctx={buildFrameContext(session)}
      selected={false}
      focusTarget
      expanded={options.expanded ?? false}
      onSelect={onSelect}
      onToggle={onToggle}
    />,
  );
  return { frame, onSelect, onToggle, view };
}

describe("Frame", () => {
  it("is a focusable group named by its label", () => {
    renderFrame(oauthCanvasSession(), (frame) => frame.selId === "unit:oauth-linking-test-failure");
    const group = screen.getByRole("group");
    expect(group.getAttribute("aria-label")).toBe("OAuth account-linking test failure, 1 failed, 14 passed, +0:33");
    expect(group.getAttribute("tabindex")).toBe("0");
  });

  it("claim text with markup renders as text and an out-of-range span draws no underline", () => {
    const hostile = "<img src=x onerror=alert(1)> rm ‮fdp.exe: all checks pass";
    const session = buildCanvasSession([
      { atMs: 1_000, kind: "loose" },
      { atMs: 6_000, kind: "claim", flagged: true, title: hostile },
    ]);
    const first = renderFrame(session, (frame) => frame.item === "claim");
    expect(first.view.container.querySelector("img")).toBeNull();
    expect(screen.getByRole("group").textContent).toContain(hostile);
    expect(first.view.container.querySelector("mark")?.textContent).toBe(hostile);
    cleanup();
    const broken: TraceSession = structuredClone(session);
    for (const finding of broken.findings) {
      if (finding.ruleId === "claim_contradicted") finding.claimSpan = [5, 9_999];
    }
    const second = renderFrame(broken, (frame) => frame.item === "claim");
    expect(second.view.container.querySelector("mark")).toBeNull();
    expect(screen.getByRole("group").textContent).toContain(hostile);
  });

  it("shows a step list at Step level whose wheel scrolls the list unless Ctrl or Meta is held", () => {
    const base = buildCanvasSession([
      ...Array.from({ length: 20 }, (_, i) => ({ atMs: 1_000 * (i + 1), kind: "work" as const })),
      { atMs: 21_000, kind: "chapter" as const },
    ]);
    const session: TraceSession = structuredClone(base);
    const chapter = session.chapters[0];
    if (chapter === undefined) throw new Error("no chapter");
    const workIds = session.steps.filter((step) => step.kind === "command").map((step) => step.id);
    chapter.stepIds = [...workIds, ...chapter.stepIds];
    for (const step of session.steps) if (workIds.includes(step.id)) step.chapterIds = [chapter.id];
    const { view } = renderFrame(session, (frame) => frame.kind === "chapter", { level: "step" });
    const parentWheel = vi.fn();
    view.container.addEventListener("wheel", parentWheel);
    const list = screen.getByRole("list", { name: "Steps" });
    expect(list.querySelectorAll("li")).toHaveLength(9);
    list.dispatchEvent(new WheelEvent("wheel", { deltaY: 40, bubbles: true }));
    expect(parentWheel).not.toHaveBeenCalled();
    list.dispatchEvent(new WheelEvent("wheel", { deltaY: 40, ctrlKey: true, bubbles: true }));
    list.dispatchEvent(new WheelEvent("wheel", { deltaY: 40, metaKey: true, bubbles: true }));
    expect(parentWheel).toHaveBeenCalledTimes(2);
  });

  it("renders a chip at Session level and the graphic part at Chapter level", () => {
    const session = oauthCanvasSession();
    const atChapter = renderFrame(session, (frame) => frame.selId === "unit:oauth-linking-test-failure");
    expect(atChapter.view.container.querySelector('[data-part="graphic"]')).not.toBeNull();
    cleanup();
    const atSession = renderFrame(session, (frame) => frame.selId === "unit:oauth-linking-test-failure", {
      level: "session",
    });
    expect(atSession.view.container.querySelector('[data-part="graphic"]')).toBeNull();
    expect(screen.getByRole("group").textContent).toContain("OAuth account-linking test failure");
  });

  it("selects on click and toggles on double click", () => {
    const { frame, onSelect, onToggle } = renderFrame(oauthCanvasSession(), (candidate) => candidate.item === "decision");
    fireEvent.click(screen.getByRole("group"));
    expect(onSelect).toHaveBeenCalledWith(frame);
    fireEvent.doubleClick(screen.getByRole("group"));
    expect(onToggle).toHaveBeenCalledWith(frame);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/canvas/frame.test.tsx`
Expected: FAIL with `Failed to load url ./Frame.js`.

- [ ] **Step 7: Write the frame styles**

Create `packages/trace-viewer/src/ui/views/canvas/Frame.module.css`:

```css
.frame {
  position: absolute;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 12px;
  overflow: hidden;
  border-radius: 8px;
  background: var(--tv-panel);
  box-shadow: var(--tv-shadow);
  color: var(--tv-ink);
  font-size: 13px;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
  cursor: default;
  outline: none;
}

.frame:focus-visible {
  box-shadow: var(--tv-shadow), 0 0 0 2px var(--tv-accent);
}

.frame[data-selected] {
  box-shadow: var(--tv-shadow), 0 0 0 1.5px var(--tv-accent);
}

.chip {
  flex-direction: row;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  border-radius: 6px;
  white-space: nowrap;
}

.noise {
  color: var(--tv-ink-3);
  box-shadow: var(--tv-shadow), 4px 4px 0 -1px var(--tv-panel), 4px 4px 0 0 var(--tv-hair);
}

.body {
  display: contents;
}

.iconOnly {
  display: none;
}

.prompt,
.claim {
  margin: 0;
  font-size: 15px;
  line-height: 20px;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
  unicode-bidi: isolate;
}

.prompt {
  -webkit-line-clamp: 4;
}

.claim {
  -webkit-line-clamp: 3;
}

.span {
  background: none;
  color: inherit;
  text-decoration: underline wavy var(--tv-bad) 1.5px;
  text-underline-offset: 4px;
  text-decoration-skip-ink: none;
}

.plan {
  margin: 0;
  color: var(--tv-ink-2);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
  overflow: hidden;
  overflow-wrap: anywhere;
  unicode-bidi: isolate;
}

.graphic {
  display: flex;
  align-items: center;
  min-width: 0;
  min-height: 0;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.meta {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 16px;
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-ink-3);
  white-space: nowrap;
}

.spacer {
  flex: 1 1 auto;
}

.icon {
  flex: none;
  color: var(--tv-ink-3);
}

.chipTitle,
.stepText {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  unicode-bidi: isolate;
}

.steps {
  list-style: none;
  margin: 0;
  padding: 0;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.stepRow {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 24px;
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-ink-2);
  white-space: nowrap;
}

.band {
  color: var(--tv-ink-3);
}

.failed {
  flex: none;
  font-size: 12px;
  color: var(--tv-bad-ink);
}

.flagBad {
  flex: none;
  color: var(--tv-bad);
}

[data-zoom-band="nographic"] .graphic,
[data-zoom-band="icon"] .graphic {
  display: none;
}

[data-zoom-band="icon"] .body {
  display: none;
}

[data-zoom-band="icon"] .iconOnly {
  display: grid;
  place-items: center;
  flex: 1 1 auto;
  color: var(--tv-ink-2);
}

[data-zoom-band="icon"] .frame[data-tone="bad"] {
  background: var(--tv-bad-soft);
}

[data-zoom-band="icon"] .frame[data-tone="bad"] .iconOnly {
  color: var(--tv-bad);
}

[data-relayout] .frame:not([data-pinned]) {
  transition:
    left var(--tv-dur) ease-out,
    top var(--tv-dur) ease-out,
    width var(--tv-dur) ease-out,
    height var(--tv-dur) ease-out;
}
```

- [ ] **Step 8: Write the frame content**

Create `packages/trace-viewer/src/ui/views/canvas/frame-content.tsx`:

```tsx
import { useEffect, useRef } from "react";
import type React from "react";

import type { CanvasFrame } from "../../../layout/canvas-layout.js";
import { STEP_LIST_ROWS } from "../../../layout/canvas-levels.js";
import { formatDuration, formatOffset, type Level, type Step } from "../../../model/index.js";
import { DiffBar } from "../../graphics/DiffBar.js";
import { Graphic } from "../../graphics/Graphic.js";
import { Icon } from "../../icons/Icon.js";
import { KIND_ICON } from "../../icons/kind-icons.js";
import styles from "./Frame.module.css";
import {
  claimSpanFor,
  frameFlag,
  frameGraphic,
  frameIcon,
  frameStepRows,
  frameSteps,
  frameTitle,
  type FrameContext,
} from "./frame-label.js";
import { CULL_FRAMES } from "./spike-rulings.js";

interface BodyProps {
  frame: CanvasFrame;
  ctx: FrameContext;
}

export interface FrameContentProps extends BodyProps {
  level: Level;
  expanded: boolean;
}

/** Agent text renders only as React text nodes; the span underline is dropped when out of range. */
function ClaimText({ text, span }: { text: string; span: readonly [number, number] | undefined }): React.JSX.Element {
  if (span === undefined || span[0] < 0 || span[1] > text.length || span[0] >= span[1]) {
    return <p className={styles.claim}>{text}</p>;
  }
  return (
    <p className={styles.claim}>
      {text.slice(0, span[0])}
      <mark className={styles.span}>{text.slice(span[0], span[1])}</mark>
      {text.slice(span[1])}
    </p>
  );
}

function StepList({ steps }: { steps: readonly Step[] }): React.JSX.Element {
  const listRef = useRef<HTMLOListElement | null>(null);
  useEffect(() => {
    const list = listRef.current;
    if (list === null) return undefined;
    // Wheel over the list scrolls it; Ctrl/Meta+wheel still reaches the viewport controller and zooms.
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) event.stopPropagation();
    };
    list.addEventListener("wheel", onWheel, { passive: true });
    return () => list.removeEventListener("wheel", onWheel);
  }, []);
  const rows = frameStepRows(steps);
  const shown = CULL_FRAMES ? rows.slice(0, STEP_LIST_ROWS) : rows;
  return (
    <ol ref={listRef} className={styles.steps} aria-label="Steps">
      {shown.map((row) =>
        row.t === "band" ? (
          <li key={row.key} className={`${styles.stepRow} ${styles.band}`}>
            {`${row.count} more`}
          </li>
        ) : (
          <li key={row.step.id} className={styles.stepRow}>
            <Icon name={KIND_ICON[row.step.kind]} size={14} className={styles.icon} />
            <span className={styles.stepText}>{row.step.headline}</span>
            {row.step.status === "failed" ? <span className={styles.failed}>✕ failed</span> : null}
            <span className={styles.meta}>{formatOffset(row.step.tMs)}</span>
          </li>
        ),
      )}
    </ol>
  );
}

function GraphicPart({ frame, ctx, size }: BodyProps & { size: "xs" | "sm" }): React.JSX.Element | null {
  const graphic = frameGraphic(frame, ctx);
  if (graphic === null) return null;
  return (
    <div className={styles.graphic} data-part="graphic">
      <Graphic spec={graphic} size={size} />
    </div>
  );
}

function SessionChip({ frame, ctx }: BodyProps): React.JSX.Element {
  const flag = frameFlag(frame, ctx);
  return (
    <>
      <Icon name={frameIcon(frame, ctx)} size={14} className={styles.icon} />
      <span className={styles.chipTitle}>{frameTitle(frame, ctx)}</span>
      {flag === "failed" ? <span className={styles.failed}>✕</span> : null}
      {flag === "neq" ? <Icon name="neq" size={12} className={styles.flagBad} /> : null}
    </>
  );
}

function DecisionBody({ frame, ctx }: BodyProps): React.JSX.Element {
  const step = ctx.stepById.get(frame.selId);
  const decidedBy = step?.decision?.decidedBy;
  return (
    <>
      <GraphicPart frame={frame} ctx={ctx} size="sm" />
      <div className={styles.meta}>
        <Icon name="person" size={12} className={styles.icon} />
        <span>{decidedBy === "delegated" ? "Delegated" : decidedBy === "supervisor" ? "Supervisor" : "Open"}</span>
        <span className={styles.spacer} />
        <Icon name="clock" size={12} className={styles.icon} />
        <span>{formatDuration(step?.durationMs ?? null)}</span>
      </div>
    </>
  );
}

function NoiseBody({ frame, ctx }: BodyProps): React.JSX.Element {
  const edits = frameSteps(frame, ctx).filter((step) => step.edit !== undefined);
  const added = edits.reduce((sum, step) => sum + (step.edit?.added ?? 0), 0);
  const removed = edits.reduce((sum, step) => sum + (step.edit?.removed ?? 0), 0);
  const files = new Set(edits.map((step) => step.edit?.path)).size;
  return (
    <div className={styles.meta}>
      <span>{`${files} ${files === 1 ? "file" : "files"}`}</span>
      <DiffBar size="xs" added={added} removed={removed} />
      <span>{`+${added} −${removed}`}</span>
    </div>
  );
}

function LooseBody({ frame, ctx }: BodyProps): React.JSX.Element {
  const step = ctx.stepById.get(frame.selId);
  return (
    <div className={styles.row}>
      <span className={styles.stepText}>{step?.headline ?? ""}</span>
      <GraphicPart frame={frame} ctx={ctx} size="xs" />
      {step?.status === "failed" ? <span className={styles.failed}>✕ failed</span> : null}
    </div>
  );
}

function ChapterBody({ frame, ctx, level, expanded }: FrameContentProps): React.JSX.Element {
  const showList = level === "step" || expanded;
  return (
    <>
      <GraphicPart frame={frame} ctx={ctx} size="sm" />
      {showList ? <StepList steps={frameSteps(frame, ctx)} /> : null}
    </>
  );
}

export function FrameContent(props: FrameContentProps): React.JSX.Element {
  const { frame, ctx, level } = props;
  if (level === "session") return <SessionChip frame={frame} ctx={ctx} />;
  const step = ctx.stepById.get(frame.selId);
  switch (frame.item) {
    case "intent":
    case "instruction":
      return <p className={styles.prompt}>{step?.text ?? step?.headline ?? ""}</p>;
    case "plan":
      return <p className={styles.plan}>{step?.text ?? ""}</p>;
    case "claim":
      return <ClaimText text={step?.text ?? ""} span={step === undefined ? undefined : claimSpanFor(step, ctx)} />;
    case "decision":
      return <DecisionBody frame={frame} ctx={ctx} />;
    case "noise":
      return <NoiseBody frame={frame} ctx={ctx} />;
    case "loose":
      return <LooseBody frame={frame} ctx={ctx} />;
    case "chapter":
      return frame.kind === "noise" ? <NoiseBody frame={frame} ctx={ctx} /> : <ChapterBody {...props} />;
  }
}
```

- [ ] **Step 9: Write the frame component**

Create `packages/trace-viewer/src/ui/views/canvas/Frame.tsx`:

```tsx
import { memo } from "react";
import type React from "react";

import type { CanvasFrame } from "../../../layout/canvas-layout.js";
import type { Level } from "../../../model/index.js";
import { Icon } from "../../icons/Icon.js";
import styles from "./Frame.module.css";
import { FrameContent } from "./frame-content.js";
import { frameIcon, frameLabel, frameTone, type FrameContext } from "./frame-label.js";

export interface FrameProps {
  frame: CanvasFrame;
  level: Level;
  ctx: FrameContext;
  selected: boolean;
  /** The one frame with tabindex 0 (roving). */
  focusTarget: boolean;
  expanded: boolean;
  onSelect(frame: CanvasFrame): void;
  onToggle(frame: CanvasFrame): void;
}

function FrameView({ frame, level, ctx, selected, focusTarget, expanded, onSelect, onToggle }: FrameProps): React.JSX.Element {
  const className = [styles.frame, level === "session" ? styles.chip : undefined, frame.kind === "noise" ? styles.noise : undefined]
    .filter((name): name is string => name !== undefined)
    .join(" ");
  return (
    <div
      role="group"
      aria-label={frameLabel(frame, ctx)}
      aria-current={selected ? "true" : undefined}
      tabIndex={focusTarget ? 0 : -1}
      data-key={frame.key}
      data-kind={frame.kind}
      data-tone={frameTone(frame, ctx)}
      data-selected={selected ? "" : undefined}
      data-expanded={expanded ? "" : undefined}
      className={className}
      style={{ left: frame.card.x, top: frame.card.y, width: frame.card.w, height: frame.card.h }}
      onClick={() => onSelect(frame)}
      onDoubleClick={() => onToggle(frame)}
    >
      <span className={styles.iconOnly} aria-hidden="true">
        <Icon name={frameIcon(frame, ctx)} size={16} />
      </span>
      <div className={styles.body}>
        <FrameContent frame={frame} level={level} ctx={ctx} expanded={expanded} />
      </div>
    </div>
  );
}

/** A canvas frame in world coordinates; its label, handles and time chip live in the screen-space overlay. */
export const Frame = memo(FrameView);
```

- [ ] **Step 10: Run the frame tests to verify they pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/canvas/frame.test.tsx src/ui/views/canvas/frame-label.test.ts`
Expected: PASS, `Tests  13 passed (13)`.

- [ ] **Step 11: Typecheck, lint and root checks**

Run: `pnpm --filter @jevcode/trace-viewer typecheck && pnpm lint`, then the root checks. Expected: all exit 0, including C1-1's `tokens.test.ts` CSS guard, which now also reads `Frame.module.css` (no `color: var(--tv-ink-4)`).

- [ ] **Step 12: Commit**

```bash
git add packages/trace-viewer/src/ui/views/canvas/frame-label.ts packages/trace-viewer/src/ui/views/canvas/frame-label.test.ts packages/trace-viewer/src/ui/views/canvas/frame-content.tsx packages/trace-viewer/src/ui/views/canvas/Frame.tsx packages/trace-viewer/src/ui/views/canvas/Frame.module.css packages/trace-viewer/src/ui/views/canvas/frame.test.tsx
git commit -m "feat(trace-viewer): canvas frames with labels, step lists and zoom bands"
```

### Task C3-7: World layer, edge SVG, screen-space overlay

**Files:**
- Create: `packages/trace-viewer/src/ui/views/canvas/World.tsx`
- Create: `packages/trace-viewer/src/ui/views/canvas/EdgeLayer.tsx`
- Create: `packages/trace-viewer/src/ui/views/canvas/Overlay.tsx`
- Create: `packages/trace-viewer/src/ui/views/canvas/World.module.css`
- Create: `packages/trace-viewer/src/ui/views/canvas/world.test.tsx`

**Interfaces:**
- Consumes: C3-2/C3-3 `CanvasLayout`, `CanvasFrame`, `CanvasEdge`, `directPath(a: Rect, b: Rect): string`; C3-6 `Frame`, `FrameContext`, `frameTitle`, `frameIcon`, `frameFlag`, `frameStart`, `frameEnd`, `timeChip`; C1-11 `Tool`; C1-2 `Icon`; model `formatOffset`, `Level`.
- Produces:

```ts
// World.tsx
export interface CullRange { x0: number; x1: number }
export interface WorldProps {
  layout: CanvasLayout | null; ctx: FrameContext | null; level: Level;
  /** Frame key of the selection. */
  selectedKey: string | null;
  expanded: ReadonlySet<string>;
  /** Gesture-time will-change (R17). */
  gesturing: boolean;
  tool: Tool;
  /** Spike risk 2 ruling only; null draws every frame. */
  cullRange: CullRange | null;
  viewportRef: React.Ref<HTMLDivElement>;
  worldRef: React.Ref<HTMLDivElement>;
  overlay: React.ReactNode;
  onSelect(frame: CanvasFrame): void;
  onToggle(frame: CanvasFrame): void;
  onSelectEdge(edge: CanvasEdge): void;
}
export const World: React.NamedExoticComponent<WorldProps>;
export function cullFrames(frames: readonly CanvasFrame[], range: CullRange | null): readonly CanvasFrame[];
/** Focuses the frame element for `key` with preventScroll; false when it is not in the DOM. */
export function focusFrameElement(root: ParentNode, key: string): boolean;

// EdgeLayer.tsx
export interface DrawnEdge { edge: CanvasEdge; d: string; hop: boolean }
/** Rest edges plus the selection's one-hop edges; "over" holds direct and lane-less paths (drawn above frames with a halo). */
export function drawnEdges(layout: CanvasLayout, selectedKey: string | null, layer: "under" | "over"): DrawnEdge[];
export function EdgeLayer(props: { layout: CanvasLayout; layer: "under" | "over"; selectedKey: string | null; onSelectEdge(edge: CanvasEdge): void }): React.JSX.Element;

// Overlay.tsx
export interface OverlayProps { layout: CanvasLayout; ctx: FrameContext; level: Level; selectedKey: string | null; onSelect(frame: CanvasFrame): void }
export function Overlay(props: OverlayProps): React.JSX.Element;
```

The viewport element carries `data-tv-viewport="canvas"`, `data-zoom-band` and the camera custom properties `--tv-tx`, `--tv-ty`, `--tv-k`, `--tv-inv-k` (written by C3-10). The world layer and every overlay item position themselves from those properties, so one style write per frame moves everything.

- [ ] **Step 1: Write the failing tests**

Create `packages/trace-viewer/src/ui/views/canvas/world.test.tsx`:

```tsx
// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, fireEvent, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { layoutCanvas, type CanvasFrame, type CanvasLayout } from "../../../layout/canvas-layout.js";
import { buildTraceIndex } from "../../../layout/trace-index.js";
import { canvasScale, oauthCanvasSession } from "../../../test-support/canvas-arbitraries.js";
import { drawnEdges } from "./EdgeLayer.js";
import { buildFrameContext } from "./frame-label.js";
import { Overlay } from "./Overlay.js";
import { World, cullFrames, focusFrameElement, type WorldProps } from "./World.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const session = oauthCanvasSession();
const layout = layoutCanvas(session, buildTraceIndex(session), canvasScale(session), "chapter");
const ctx = buildFrameContext(session);

function frame(predicate: (candidate: CanvasFrame) => boolean): CanvasFrame {
  const found = layout.frames.find(predicate);
  if (found === undefined) throw new Error("frame not found");
  return found;
}

const linkingTest = frame((candidate) => candidate.selId === "unit:oauth-linking-test-failure");

function renderWorld(overrides: Partial<WorldProps> = {}) {
  const selectedKey = overrides.selectedKey ?? null;
  const props: WorldProps = {
    layout,
    ctx,
    level: "chapter",
    selectedKey,
    expanded: new Set<string>(),
    gesturing: false,
    tool: "select",
    cullRange: null,
    viewportRef: createRef<HTMLDivElement>(),
    worldRef: createRef<HTMLDivElement>(),
    overlay: <Overlay layout={layout} ctx={ctx} level="chapter" selectedKey={selectedKey} onSelect={() => undefined} />,
    onSelect: vi.fn(),
    onToggle: vi.fn(),
    onSelectEdge: vi.fn(),
    ...overrides,
  };
  return { props, view: render(<World {...props} />) };
}

function frameElements(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="group"][data-key]')];
}

describe("World", () => {
  it("renders frames in DOM time order with exactly one tab stop", () => {
    renderWorld();
    expect(frameElements().map((element) => element.dataset.key)).toEqual(layout.frames.map((candidate) => candidate.key));
    expect(frameElements().filter((element) => element.getAttribute("tabindex") === "0")).toHaveLength(1);
    expect(frameElements()[0]?.getAttribute("tabindex")).toBe("0");
    cleanup();
    renderWorld({ selectedKey: linkingTest.key });
    const stops = frameElements().filter((element) => element.getAttribute("tabindex") === "0");
    expect(stops.map((element) => element.dataset.key)).toEqual([linkingTest.key]);
  });

  it("draws rest edges under the frames and lifted edges over them", () => {
    const { view } = renderWorld();
    const under = view.container.querySelector('svg[data-layer="under"]');
    const over = view.container.querySelector('svg[data-layer="over"]');
    const first = frameElements()[0];
    if (under === null || over === null || first === undefined) throw new Error("layers missing");
    expect(under.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(first.compareDocumentPosition(over) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const restUnder = layout.edges.filter((edge) => edge.rest && edge.shape !== "direct" && edge.d !== null);
    expect(under.querySelectorAll("[data-edge]")).toHaveLength(restUnder.length);
  });

  it("keeps edge strokes at 1.5 CSS px through --tv-inv-k and never colors text with ink-4", () => {
    const css = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "World.module.css"), "utf8");
    expect(css).toContain("stroke-width: calc(1.5px * var(--tv-inv-k, 1))");
    expect(css).toContain("stroke-width: calc(2px * var(--tv-inv-k, 1))");
    expect(css).toContain("stroke-width: calc(8px * var(--tv-inv-k, 1))");
    expect(css).not.toMatch(/(^|[^-])color:\s*var\(--tv-ink-4\)/m);
  });

  it("gives the contradicts edge an 8 px hit twin and a worded badge", () => {
    const onSelectEdge = vi.fn();
    const { view } = renderWorld({ onSelectEdge });
    const hit = view.container.querySelector('[data-hit="contradicts"]');
    if (hit === null) throw new Error("no hit twin");
    fireEvent.click(hit);
    expect(onSelectEdge).toHaveBeenCalledWith(expect.objectContaining({ kind: "contradicts", tone: "bad" }));
    expect(view.container.querySelector("[data-badge]")?.textContent).toContain("contradicts");
  });

  it("sets will-change only while a gesture runs", () => {
    const { props, view } = renderWorld({ gesturing: true });
    const world = view.container.querySelector<HTMLElement>("[data-tv-world]");
    expect(world?.style.willChange).toBe("transform");
    view.rerender(<World {...props} gesturing={false} />);
    expect(world?.style.willChange ?? "").toBe("");
  });

  it("focuses frames with preventScroll and undoes any browser scroll of the viewport", () => {
    const { view } = renderWorld();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const viewport = view.container.querySelector<HTMLElement>('[data-tv-viewport="canvas"]');
    if (viewport === null) throw new Error("no viewport");
    expect(focusFrameElement(viewport, linkingTest.key)).toBe(true);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect((document.activeElement as HTMLElement | null)?.dataset.key).toBe(linkingTest.key);
    Object.defineProperty(viewport, "scrollLeft", { value: 40, writable: true, configurable: true });
    Object.defineProperty(viewport, "scrollTop", { value: 12, writable: true, configurable: true });
    fireEvent.scroll(viewport);
    expect(viewport.scrollLeft).toBe(0);
    expect(viewport.scrollTop).toBe(0);
  });

  it("draws four handles and the time chip around the selection", () => {
    const { view } = renderWorld({ selectedKey: linkingTest.key });
    expect(view.container.querySelectorAll("[data-handle]")).toHaveLength(4);
    expect(view.container.querySelector("[data-time-chip]")?.textContent).toBe("+0:33 – 0:40");
  });

  it("renders an empty viewport while the session loads", () => {
    const { view } = renderWorld({ layout: null, ctx: null, overlay: null });
    expect(view.container.querySelector('[data-tv-viewport="canvas"]')).not.toBeNull();
    expect(frameElements()).toEqual([]);
  });
});

describe("edge and cull helpers", () => {
  it("culls by x only when the risk 2 ruling passes a range", () => {
    expect(cullFrames(layout.frames, null)).toBe(layout.frames);
    expect(cullFrames(layout.frames, { x0: 500, x1: 760 }).map((candidate) => candidate.col)).toEqual([2, 2, 2]);
  });

  it("draws the selection's lane-less edges as direct paths above the frames", () => {
    const decides = layout.edges.find((edge) => edge.kind === "decides");
    if (decides === undefined) throw new Error("no decides edge");
    const laneless: CanvasLayout = { ...layout, edges: [{ ...decides, d: null, rest: false, shape: "channel" }] };
    expect(drawnEdges(laneless, null, "over")).toEqual([]);
    const drawn = drawnEdges(laneless, decides.from, "over");
    expect(drawn).toHaveLength(1);
    expect(drawn[0]?.d.startsWith("M")).toBe(true);
    expect(drawnEdges(laneless, decides.from, "under")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/canvas/world.test.tsx`
Expected: FAIL with `Failed to load url ./EdgeLayer.js`.

- [ ] **Step 3: Write the styles**

Create `packages/trace-viewer/src/ui/views/canvas/World.module.css`:

```css
.viewport {
  position: absolute;
  inset: 0;
  overflow: hidden;
  outline: none;
  touch-action: none;
  background-color: var(--tv-canvas);
  background-image: radial-gradient(circle, var(--tv-ink-4) 0.6px, transparent 1.1px);
  background-size: calc(20px * var(--tv-k, 1)) calc(20px * var(--tv-k, 1));
  background-position: var(--tv-tx, 0px) var(--tv-ty, 0px);
}

.viewport[data-tool="hand"] {
  cursor: grab;
}

.world {
  position: absolute;
  left: 0;
  top: 0;
  transform-origin: 0 0;
  transform: translate(var(--tv-tx, 0px), var(--tv-ty, 0px)) scale(var(--tv-k, 1));
}

.separator {
  position: absolute;
  top: 0;
  width: 0;
  border-left: 1px dashed var(--tv-hair);
  pointer-events: none;
}

.separator[data-sep="break"] {
  border-left-style: dotted;
}

.edges {
  position: absolute;
  left: 0;
  top: 0;
  overflow: visible;
  pointer-events: none;
}

.edge {
  fill: none;
  stroke: var(--tv-ink-4);
  stroke-width: calc(1.5px * var(--tv-inv-k, 1));
  stroke-linecap: round;
  stroke-linejoin: round;
}

.hop {
  stroke: var(--tv-accent);
}

.bad {
  stroke: var(--tv-bad);
  stroke-width: calc(2px * var(--tv-inv-k, 1));
}

.dim {
  opacity: 0.3;
}

.halo {
  fill: none;
  stroke: var(--tv-panel);
  stroke-width: calc(4.5px * var(--tv-inv-k, 1));
}

.hit {
  fill: none;
  stroke: transparent;
  stroke-width: calc(8px * var(--tv-inv-k, 1));
  pointer-events: stroke;
  cursor: pointer;
}

.junction {
  fill: var(--tv-ink-4);
}

.overlay {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

.label {
  position: absolute;
  left: 0;
  top: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 16px;
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-ink-2);
  white-space: nowrap;
  pointer-events: auto;
  transform: translate(
    calc(var(--tv-tx, 0px) + var(--x) * var(--tv-k, 1) * 1px),
    calc(var(--tv-ty, 0px) + var(--cy) * var(--tv-k, 1) * 1px - 22px)
  );
  width: calc(var(--w) * var(--tv-k, 1) * 1px);
}

.label[data-selected] {
  color: var(--tv-accent-ink);
}

.labelIcon {
  flex: none;
}

.labelText {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  background: var(--tv-canvas);
}

.labelTime {
  flex: none;
  color: var(--tv-ink-3);
  background: var(--tv-canvas);
}

.flagBad {
  flex: none;
  color: var(--tv-bad);
}

.handle {
  position: absolute;
  left: 0;
  top: 0;
  width: 7px;
  height: 7px;
  background: var(--tv-panel);
  box-shadow: inset 0 0 0 1.25px var(--tv-accent);
  transform: translate(
    calc(var(--tv-tx, 0px) + var(--x) * var(--tv-k, 1) * 1px - 3.5px),
    calc(var(--tv-ty, 0px) + var(--y) * var(--tv-k, 1) * 1px - 3.5px)
  );
}

.timeChip {
  position: absolute;
  left: 0;
  top: 0;
  height: 18px;
  padding: 0 6px;
  border-radius: 4px;
  background: var(--tv-accent-ink);
  color: var(--tv-panel);
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
  white-space: nowrap;
  transform: translate(
    calc(var(--tv-tx, 0px) + var(--x) * var(--tv-k, 1) * 1px - 50%),
    calc(var(--tv-ty, 0px) + var(--y) * var(--tv-k, 1) * 1px + 8px)
  );
}

.sepLabel {
  position: absolute;
  left: 0;
  top: 6px;
  padding: 0 4px;
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-ink-3);
  background: var(--tv-canvas);
  white-space: nowrap;
  transform: translateX(calc(var(--tv-tx, 0px) + var(--x) * var(--tv-k, 1) * 1px - 50%));
}

.badge {
  position: absolute;
  left: 0;
  top: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-bad-ink);
  white-space: nowrap;
  transform: translate(
    calc(var(--tv-tx, 0px) + var(--x) * var(--tv-k, 1) * 1px - 100% + 10px),
    calc(var(--tv-ty, 0px) + var(--y) * var(--tv-k, 1) * 1px - 10px)
  );
}

.badgeText {
  background: var(--tv-canvas);
}

.badgeMark {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--tv-bad);
  color: var(--tv-panel);
}

[data-zoom-band="icon"] .label {
  display: none;
}
```

The `.bad` rule follows `.hop`, so a selected contradicts edge stays red (red is state, accent is selection; spec §7.5 "the only red edge").

- [ ] **Step 4: Write the edge layer**

Create `packages/trace-viewer/src/ui/views/canvas/EdgeLayer.tsx`:

```tsx
import type React from "react";

import type { CanvasLayout } from "../../../layout/canvas-layout.js";
import { directPath, type CanvasEdge } from "../../../layout/canvas-routes.js";
import styles from "./World.module.css";

export interface DrawnEdge {
  edge: CanvasEdge;
  d: string;
  hop: boolean;
}

export function drawnEdges(layout: CanvasLayout, selectedKey: string | null, layer: "under" | "over"): DrawnEdge[] {
  const out: DrawnEdge[] = [];
  for (const edge of layout.edges) {
    const hop = selectedKey !== null && (edge.from === selectedKey || edge.to === selectedKey);
    if (!edge.rest && !hop) continue;
    let d = edge.d;
    let lifted = edge.shape === "direct";
    if (d === null) {
      const from = layout.frameByKey.get(edge.from);
      const to = layout.frameByKey.get(edge.to);
      if (from === undefined || to === undefined) continue;
      d = directPath(from.card, to.card);
      lifted = true;
    }
    if ((layer === "over") !== lifted) continue;
    out.push({ edge, d, hop });
  }
  return out;
}

export interface EdgeLayerProps {
  layout: CanvasLayout;
  layer: "under" | "over";
  selectedKey: string | null;
  onSelectEdge(edge: CanvasEdge): void;
}

/** One SVG in world px; strokes stay 1.5 CSS px through --tv-inv-k (written at settle). No arrowheads. */
export function EdgeLayer({ layout, layer, selectedKey, onSelectEdge }: EdgeLayerProps): React.JSX.Element {
  const edges = drawnEdges(layout, selectedKey, layer);
  return (
    <svg
      className={styles.edges}
      data-layer={layer}
      width={Math.max(1, layout.bounds.w)}
      height={Math.max(1, layout.bounds.h)}
      aria-hidden="true"
      focusable="false"
    >
      {edges.map(({ edge, d, hop }) => {
        const classes = [styles.edge, hop ? styles.hop : selectedKey !== null ? styles.dim : undefined, edge.tone === "bad" ? styles.bad : undefined]
          .filter((name): name is string => name !== undefined)
          .join(" ");
        return (
          <g key={edge.id} data-edge={edge.id} data-kind={edge.kind}>
            {layer === "over" ? <path className={styles.halo} d={d} /> : null}
            <path className={classes} d={d} />
            {edge.kind === "contradicts" ? (
              <path className={styles.hit} d={d} data-hit="contradicts" onClick={() => onSelectEdge(edge)} />
            ) : null}
          </g>
        );
      })}
      {layer === "under"
        ? layout.junctions.map((point) => (
            <circle key={`${point.x}:${point.y}`} className={styles.junction} cx={point.x} cy={point.y} r={2.5} />
          ))
        : null}
    </svg>
  );
}
```

- [ ] **Step 5: Write the overlay**

Create `packages/trace-viewer/src/ui/views/canvas/Overlay.tsx`:

```tsx
import type React from "react";

import type { CanvasFrame, CanvasLayout } from "../../../layout/canvas-layout.js";
import type { CanvasEdge } from "../../../layout/canvas-routes.js";
import type { Point } from "../../../layout/viewport.js";
import { formatOffset, type Level } from "../../../model/index.js";
import { Icon } from "../../icons/Icon.js";
import {
  frameApprox,
  frameEnd,
  frameFlag,
  frameIcon,
  frameStart,
  frameTitle,
  timeChip,
  type FrameContext,
} from "./frame-label.js";
import styles from "./World.module.css";

export interface OverlayProps {
  layout: CanvasLayout;
  ctx: FrameContext;
  level: Level;
  selectedKey: string | null;
  onSelect(frame: CanvasFrame): void;
}

/** World coordinates as unitless custom properties; the CSS maps them through --tv-tx/--tv-ty/--tv-k. */
function place(values: Record<string, number>): React.CSSProperties {
  const style: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) style[`--${name}`] = String(value);
  return style as React.CSSProperties;
}

function FrameLabel(props: { frame: CanvasFrame; ctx: FrameContext; selected: boolean; onSelect(frame: CanvasFrame): void }): React.JSX.Element | null {
  const { frame, ctx, selected, onSelect } = props;
  if (frame.label === null) return null;
  const flag = frameFlag(frame, ctx);
  return (
    <div
      className={styles.label}
      data-label-for={frame.key}
      data-selected={selected ? "" : undefined}
      style={place({ x: frame.label.x, cy: frame.card.y, w: frame.label.w })}
      onClick={() => onSelect(frame)}
    >
      <Icon name={frameIcon(frame, ctx)} size={14} className={styles.labelIcon} />
      <span className={styles.labelText}>{frameTitle(frame, ctx)}</span>
      <span className={styles.labelTime}>{formatOffset(frameStart(frame, ctx))}</span>
      {frameApprox(frame, ctx) ? <span className={styles.labelTime}>≈</span> : null}
      {flag === "neq" ? <Icon name="neq" size={12} className={styles.flagBad} /> : null}
      {flag === "shield" ? <Icon name="shield" size={12} className={styles.flagBad} /> : null}
      {flag === "failed" ? <span className={styles.flagBad}>✕</span> : null}
    </div>
  );
}

function Selection({ frame, ctx }: { frame: CanvasFrame; ctx: FrameContext }): React.JSX.Element {
  const { card } = frame;
  const corners: Array<[string, number, number]> = [
    ["nw", card.x, card.y],
    ["ne", card.x + card.w, card.y],
    ["sw", card.x, card.y + card.h],
    ["se", card.x + card.w, card.y + card.h],
  ];
  return (
    <>
      {corners.map(([name, x, y]) => (
        <span key={name} className={styles.handle} data-handle={name} style={place({ x, y })} />
      ))}
      <span className={styles.timeChip} data-time-chip="" style={place({ x: card.x + card.w / 2, y: card.y + card.h })}>
        {timeChip(frameStart(frame, ctx), frameEnd(frame, ctx))}
      </span>
    </>
  );
}

export function Overlay({ layout, ctx, level, selectedKey, onSelect }: OverlayProps): React.JSX.Element {
  const selected = selectedKey === null ? undefined : layout.frameByKey.get(selectedKey);
  const badges = layout.edges.filter(
    (edge): edge is CanvasEdge & { badge: Point } => edge.kind === "contradicts" && edge.badge !== null,
  );
  return (
    <div className={styles.overlay} aria-hidden="true">
      {level === "session"
        ? null
        : layout.frames.map((frame) => (
            <FrameLabel key={frame.key} frame={frame} ctx={ctx} selected={frame.key === selectedKey} onSelect={onSelect} />
          ))}
      {layout.separators.map((sep) => (
        <span key={`${sep.kind}:${sep.x}`} className={styles.sepLabel} data-sep-label={sep.kind} style={place({ x: sep.x })}>
          {sep.label}
        </span>
      ))}
      {badges.map((edge) => (
        <span key={edge.id} className={styles.badge} data-badge={edge.id} style={place({ x: edge.badge.x, y: edge.badge.y })}>
          <span className={styles.badgeText}>contradicts</span>
          <span className={styles.badgeMark}>
            <Icon name="neq" size={12} />
          </span>
        </span>
      ))}
      {selected === undefined ? null : <Selection frame={selected} ctx={ctx} />}
    </div>
  );
}
```

- [ ] **Step 6: Write the world**

Create `packages/trace-viewer/src/ui/views/canvas/World.tsx`:

```tsx
import { memo } from "react";
import type React from "react";

import type { CanvasFrame, CanvasLayout } from "../../../layout/canvas-layout.js";
import type { CanvasEdge } from "../../../layout/canvas-routes.js";
import type { Level } from "../../../model/index.js";
import type { Tool } from "../../state/view-state.js";
import { EdgeLayer } from "./EdgeLayer.js";
import { Frame } from "./Frame.js";
import type { FrameContext } from "./frame-label.js";
import styles from "./World.module.css";

export interface CullRange {
  x0: number;
  x1: number;
}

export interface WorldProps {
  layout: CanvasLayout | null;
  ctx: FrameContext | null;
  level: Level;
  selectedKey: string | null;
  expanded: ReadonlySet<string>;
  gesturing: boolean;
  tool: Tool;
  cullRange: CullRange | null;
  viewportRef: React.Ref<HTMLDivElement>;
  worldRef: React.Ref<HTMLDivElement>;
  overlay: React.ReactNode;
  onSelect(frame: CanvasFrame): void;
  onToggle(frame: CanvasFrame): void;
  onSelectEdge(edge: CanvasEdge): void;
}

/** Spike risk 2 ruling: frames whose card overlaps [x0, x1]. Frames are in column order, so card edges are non-decreasing. */
export function cullFrames(frames: readonly CanvasFrame[], range: CullRange | null): readonly CanvasFrame[] {
  if (range === null) return frames;
  let lo = 0;
  let hi = frames.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const frame = frames[mid];
    if (frame !== undefined && frame.card.x + frame.card.w < range.x0) lo = mid + 1;
    else hi = mid;
  }
  const out: CanvasFrame[] = [];
  for (let i = lo; i < frames.length; i += 1) {
    const frame = frames[i];
    if (frame === undefined || frame.card.x > range.x1) break;
    out.push(frame);
  }
  return out;
}

export function focusFrameElement(root: ParentNode, key: string): boolean {
  for (const element of root.querySelectorAll<HTMLElement>("[data-key]")) {
    if (element.dataset.key !== key) continue;
    element.focus({ preventScroll: true });
    return true;
  }
  return false;
}

function WorldView(props: WorldProps): React.JSX.Element {
  const { layout, ctx, selectedKey } = props;
  const frames = layout === null ? [] : cullFrames(layout.frames, props.cullRange);
  const focusKey =
    layout !== null && selectedKey !== null && layout.frameByKey.has(selectedKey) ? selectedKey : (layout?.frames[0]?.key ?? null);
  return (
    <div
      ref={props.viewportRef}
      className={styles.viewport}
      data-tv-viewport="canvas"
      data-zoom-band="full"
      data-tool={props.tool}
      onScroll={(event) => {
        // overflow: hidden still scrolls on focus; the camera is the only way to move.
        event.currentTarget.scrollLeft = 0;
        event.currentTarget.scrollTop = 0;
      }}
    >
      <div
        ref={props.worldRef}
        className={styles.world}
        data-tv-world=""
        style={{ willChange: props.gesturing ? "transform" : undefined }}
      >
        {layout === null || ctx === null ? null : (
          <>
            {layout.separators.map((sep) => (
              <div
                key={`${sep.kind}:${sep.x}`}
                className={styles.separator}
                data-sep={sep.kind}
                aria-hidden="true"
                style={{ left: sep.x, height: Math.max(1, layout.bounds.h) }}
              />
            ))}
            <EdgeLayer layout={layout} layer="under" selectedKey={selectedKey} onSelectEdge={props.onSelectEdge} />
            {frames.map((frame) => (
              <Frame
                key={frame.key}
                frame={frame}
                level={props.level}
                ctx={ctx}
                selected={frame.key === selectedKey}
                focusTarget={frame.key === focusKey}
                expanded={props.expanded.has(frame.key) || props.expanded.has(frame.selId)}
                onSelect={props.onSelect}
                onToggle={props.onToggle}
              />
            ))}
            <EdgeLayer layout={layout} layer="over" selectedKey={selectedKey} onSelectEdge={props.onSelectEdge} />
          </>
        )}
      </div>
      {props.overlay}
    </div>
  );
}

/** Viewport (camera custom properties, zoom band, scroll guard) holding the transformed world and the overlay. */
export const World = memo(WorldView);
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/canvas/world.test.tsx`
Expected: PASS, `Tests  10 passed (10)`.

- [ ] **Step 8: Typecheck, lint and root checks**

Run: `pnpm --filter @jevcode/trace-viewer typecheck && pnpm lint`, then the root checks. Expected: all exit 0 (C1-1's CSS guard reads `World.module.css`: ink-4 appears only in `stroke`, `fill` and `background-image`).

- [ ] **Step 9: Commit**

```bash
git add packages/trace-viewer/src/ui/views/canvas/World.tsx packages/trace-viewer/src/ui/views/canvas/EdgeLayer.tsx packages/trace-viewer/src/ui/views/canvas/Overlay.tsx packages/trace-viewer/src/ui/views/canvas/World.module.css packages/trace-viewer/src/ui/views/canvas/world.test.tsx
git commit -m "feat(trace-viewer): canvas world, edge layers and screen-space overlay"
```

### Task C3-8: Minimap panel and floating toolbar (select, hand, fit, level, Tidy)

**Files:**
- Create: `packages/trace-viewer/src/ui/views/canvas/Minimap.tsx`
- Create: `packages/trace-viewer/src/ui/views/canvas/Toolbar.tsx`
- Create: `packages/trace-viewer/src/ui/views/canvas/chrome.module.css`
- Create: `packages/trace-viewer/src/ui/views/canvas/chrome.test.tsx`

**Interfaces:**
- Consumes: C3-4 `buildMinimap`, `minimapToWorld`, `MINIMAP_W`, `MINIMAP_H`, `MINIMAP_STRIP_H`; C3-9 `CameraStore`; C1-5 `screenToWorld`, `Point`, `Size`; model `LEVELS`, `Level`; C1-11 `Tool`; C1-2 `Icon`.
- Produces:

```ts
export interface MinimapProps {
  layout: CanvasLayout; cameraStore: CameraStore; viewport: Size;
  selectedKey: string | null; criticalKeys: ReadonlySet<string>;
  /** Click: center this world point at the current zoom. */
  onCenter(world: Point): void;
  /** Dragging the viewport outline: move the camera by this world delta. */
  onPan(dxWorld: number, dyWorld: number): void;
}
export function Minimap(props: MinimapProps): React.JSX.Element;
export interface ToolbarProps { tool: Tool; level: Level; holes: number; onTool(tool: Tool): void; onLevel(level: Level): void; onFit(): void; onTidy(): void }
/** Select, hand, fit, level radiogroup and Tidy (only with holes). No comment tool (R14). Buttons are not tab stops: `main` is one region. */
export function Toolbar(props: ToolbarProps): React.JSX.Element;
```

- [ ] **Step 1: Write the failing tests**

Create `packages/trace-viewer/src/ui/views/canvas/chrome.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { layoutCanvas } from "../../../layout/canvas-layout.js";
import { buildTraceIndex } from "../../../layout/trace-index.js";
import type { Level } from "../../../model/index.js";
import { canvasScale, oauthCanvasSession } from "../../../test-support/canvas-arbitraries.js";
import type { Tool } from "../../state/view-state.js";
import { createCameraStore } from "./canvas-camera.js";
import { Minimap } from "./Minimap.js";
import { Toolbar } from "./Toolbar.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const session = oauthCanvasSession();
const layout = layoutCanvas(session, buildTraceIndex(session), canvasScale(session), "chapter");
// Spec §7.5: s = max(min(140 / 1016, 84 / 658), 0.03) = 84 / 658 for oauth.
const SCALE = 84 / 658;

function renderMinimap() {
  const onCenter = vi.fn();
  const onPan = vi.fn();
  const view = render(
    <Minimap
      layout={layout}
      cameraStore={createCameraStore({ mode: "uniform", tx: 0, ty: 0, k: 1 })}
      viewport={{ w: 800, h: 600 }}
      selectedKey={null}
      criticalKeys={new Set()}
      onCenter={onCenter}
      onPan={onPan}
    />,
  );
  return { onCenter, onPan, view };
}

describe("Minimap", () => {
  it("centers at the clicked world point", () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, width: 140, height: 84, right: 140, bottom: 84, toJSON: () => ({}),
    } as DOMRect);
    const { onCenter, view } = renderMinimap();
    const svg = view.container.querySelector("svg[data-minimap]");
    if (svg === null) throw new Error("no minimap");
    fireEvent.pointerDown(svg, { clientX: 70, clientY: 42 });
    const [world] = onCenter.mock.calls[0] ?? [];
    expect(world?.x).toBeCloseTo(70 / SCALE, 6);
    expect(world?.y).toBeCloseTo(42 / SCALE, 6);
  });

  it("pans when the viewport outline is dragged, without centering", () => {
    const { onCenter, onPan, view } = renderMinimap();
    const outline = view.container.querySelector("[data-viewport]");
    if (outline === null) throw new Error("no viewport outline");
    fireEvent.pointerDown(outline, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(outline, { clientX: 24, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(outline, { pointerId: 1 });
    expect(onCenter).not.toHaveBeenCalled();
    const [dx, dy] = onPan.mock.calls[0] ?? [];
    expect(dx).toBeCloseTo(14 / SCALE, 6);
    expect(dy).toBe(0);
  });

  it("draws the rest contradicts edge and one mark per frame", () => {
    const { view } = renderMinimap();
    expect(view.container.querySelectorAll("path")).toHaveLength(1);
    expect(view.container.querySelectorAll("rect[data-mark]")).toHaveLength(layout.frames.length);
  });
});

describe("Toolbar", () => {
  function props(overrides: Partial<{ tool: Tool; level: Level; holes: number }> = {}) {
    return {
      tool: overrides.tool ?? ("select" as Tool),
      level: overrides.level ?? ("chapter" as Level),
      holes: overrides.holes ?? 0,
      onTool: vi.fn(),
      onLevel: vi.fn(),
      onFit: vi.fn(),
      onTidy: vi.fn(),
    };
  }

  it("offers Tidy only when the layout has holes and has no comment tool", () => {
    const base = props();
    const view = render(<Toolbar {...base} />);
    expect(screen.queryByRole("button", { name: "Tidy layout" })).toBeNull();
    expect(screen.queryByRole("button", { name: /comment/i })).toBeNull();
    view.rerender(<Toolbar {...base} holes={2} />);
    fireEvent.click(screen.getByRole("button", { name: "Tidy layout" }));
    expect(base.onTidy).toHaveBeenCalledTimes(1);
  });

  it("reflects the tool and level and reports changes", () => {
    const base = props({ tool: "hand" });
    render(<Toolbar {...base} />);
    expect(screen.getByRole("button", { name: "Hand (H)" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("radio", { name: "Chapter" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Session" }));
    expect(base.onLevel).toHaveBeenCalledWith("session");
    fireEvent.click(screen.getByRole("button", { name: "Select (V)" }));
    expect(base.onTool).toHaveBeenCalledWith("select");
    fireEvent.click(screen.getByRole("button", { name: "Fit (Shift+1)" }));
    expect(base.onFit).toHaveBeenCalledTimes(1);
    for (const button of screen.getAllByRole("button")) expect(button.getAttribute("tabindex")).toBe("-1");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/canvas/chrome.test.tsx`
Expected: FAIL with `Failed to load url ./Minimap.js`.

- [ ] **Step 3: Write the chrome styles**

Create `packages/trace-viewer/src/ui/views/canvas/chrome.module.css`:

```css
.toolbar {
  position: absolute;
  left: 50%;
  bottom: 16px;
  z-index: 4;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border-radius: 10px;
  background: var(--tv-panel);
  box-shadow: var(--tv-shadow);
  transform: translateX(-50%);
}

.tool {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: none;
  color: var(--tv-ink-2);
}

.tool[aria-pressed="true"] {
  background: var(--tv-accent-ink);
  color: var(--tv-panel);
}

.divider {
  width: 1px;
  height: 20px;
  margin: 0 4px;
  background: var(--tv-hair);
}

.segment {
  display: flex;
  padding: 2px;
  border-radius: 8px;
  background: var(--tv-fill);
}

.segmentItem {
  height: 28px;
  padding: 0 10px;
  border: 0;
  border-radius: 6px;
  background: none;
  font: inherit;
  font-size: 12px;
  color: var(--tv-ink-2);
}

.segmentItem[aria-checked="true"] {
  background: var(--tv-panel);
  color: var(--tv-ink);
  font-weight: 500;
}

.tidy {
  height: 28px;
  padding: 0 10px;
  border: 0;
  border-radius: 6px;
  background: var(--tv-fill);
  font: inherit;
  font-size: 12px;
  color: var(--tv-ink);
}

.minimap {
  position: absolute;
  right: 16px;
  bottom: 16px;
  z-index: 4;
  box-sizing: border-box;
  width: 152px;
  height: 96px;
  padding: 6px;
  border-radius: 8px;
  background: var(--tv-panel);
  box-shadow: var(--tv-shadow);
}

.miniSvg {
  display: block;
  overflow: hidden;
}

.miniFrame {
  fill: var(--tv-fill-2);
}

.miniSelected {
  fill: var(--tv-accent-soft);
  stroke: var(--tv-accent);
  stroke-width: 1;
}

.miniCritical {
  fill: var(--tv-fill-2);
  stroke: var(--tv-bad);
  stroke-width: 1.5;
}

.miniNoise {
  fill: var(--tv-fill-2);
  opacity: 0.5;
}

.miniEdge {
  fill: none;
  stroke: var(--tv-bad);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.miniSep {
  stroke: var(--tv-ink-4);
  stroke-width: 1;
}

.miniViewport {
  fill: transparent;
  stroke: var(--tv-ink-4);
  stroke-width: 1;
  cursor: move;
}

.strip {
  display: block;
  margin-top: 1px;
}

.stripBracket {
  fill: var(--tv-fill-2);
}

.stripCritical {
  fill: var(--tv-bad);
}
```

- [ ] **Step 4: Write the toolbar**

Create `packages/trace-viewer/src/ui/views/canvas/Toolbar.tsx`:

```tsx
import type React from "react";

import { LEVELS, type Level } from "../../../model/index.js";
import { Icon } from "../../icons/Icon.js";
import type { Tool } from "../../state/view-state.js";
import styles from "./chrome.module.css";

const LEVEL_LABEL = { session: "Session", chapter: "Chapter", step: "Step" } as const satisfies Record<Level, string>;

export interface ToolbarProps {
  tool: Tool;
  level: Level;
  holes: number;
  onTool(tool: Tool): void;
  onLevel(level: Level): void;
  onFit(): void;
  onTidy(): void;
}

export function Toolbar(props: ToolbarProps): React.JSX.Element {
  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Canvas tools">
      <button
        type="button"
        tabIndex={-1}
        className={styles.tool}
        aria-pressed={props.tool === "select"}
        aria-label="Select (V)"
        title="Select (V)"
        onClick={() => props.onTool("select")}
      >
        <Icon name="cursor" size={16} />
      </button>
      <button
        type="button"
        tabIndex={-1}
        className={styles.tool}
        aria-pressed={props.tool === "hand"}
        aria-label="Hand (H)"
        title="Hand (H)"
        onClick={() => props.onTool("hand")}
      >
        <Icon name="hand" size={16} />
      </button>
      <button type="button" tabIndex={-1} className={styles.tool} aria-label="Fit (Shift+1)" title="Fit (Shift+1)" onClick={props.onFit}>
        <Icon name="fit" size={16} />
      </button>
      <span className={styles.divider} aria-hidden="true" />
      <div className={styles.segment} role="radiogroup" aria-label="Level">
        {LEVELS.map((level, index) => (
          <button
            key={level}
            type="button"
            role="radio"
            tabIndex={-1}
            aria-checked={props.level === level}
            className={styles.segmentItem}
            title={`${LEVEL_LABEL[level]} (Alt+${index + 1})`}
            onClick={() => props.onLevel(level)}
          >
            {LEVEL_LABEL[level]}
          </button>
        ))}
      </div>
      {props.holes > 0 ? (
        <button type="button" tabIndex={-1} className={styles.tidy} onClick={props.onTidy}>
          Tidy layout
        </button>
      ) : null}
    </div>
  );
}
```

The pressed tool uses `--tv-accent-ink` as its fill, the text-safe accent shade (spec §7.12: white on `#2F6BFF` is 4.499:1).

- [ ] **Step 5: Write the minimap**

Create `packages/trace-viewer/src/ui/views/canvas/Minimap.tsx`:

```tsx
import { useMemo, useRef, useSyncExternalStore } from "react";
import type React from "react";

import type { CanvasLayout } from "../../../layout/canvas-layout.js";
import {
  MINIMAP_H,
  MINIMAP_STRIP_H,
  MINIMAP_W,
  buildMinimap,
  minimapToWorld,
  type MinimapModel,
} from "../../../layout/canvas-minimap.js";
import { screenToWorld, type Point, type Size } from "../../../layout/viewport.js";
import type { CameraStore } from "./canvas-camera.js";
import styles from "./chrome.module.css";

export interface MinimapProps {
  layout: CanvasLayout;
  cameraStore: CameraStore;
  viewport: Size;
  selectedKey: string | null;
  criticalKeys: ReadonlySet<string>;
  onCenter(world: Point): void;
  onPan(dxWorld: number, dyWorld: number): void;
}

const MARK_CLASS: { readonly [K in MinimapModel["frames"][number]["mark"]]: string | undefined } = {
  frame: styles.miniFrame,
  selected: styles.miniSelected,
  critical: styles.miniCritical,
  noise: styles.miniNoise,
};

/** A 140 × 84 SVG derived from the layout (spec §7.5 "Minimap"); pointer-only, so it is aria-hidden. */
export function Minimap(props: MinimapProps): React.JSX.Element {
  const camera = useSyncExternalStore(props.cameraStore.subscribe, props.cameraStore.get);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<Point | null>(null);
  const { layout, viewport, selectedKey, criticalKeys } = props;
  const model = useMemo(() => {
    const topLeft = screenToWorld(camera, { x: 0, y: 0 });
    const bottomRight = screenToWorld(camera, { x: viewport.w, y: viewport.h });
    return buildMinimap(layout, {
      viewportWorld: { x: topLeft.x, y: topLeft.y, w: bottomRight.x - topLeft.x, h: bottomRight.y - topLeft.y },
      selectedKey,
      criticalKeys,
    });
  }, [camera, layout, viewport.w, viewport.h, selectedKey, criticalKeys]);
  const local = (event: React.PointerEvent): Point => {
    const box = svgRef.current?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
  };
  return (
    <div className={styles.minimap} aria-hidden="true">
      <svg
        ref={svgRef}
        className={styles.miniSvg}
        width={MINIMAP_W}
        height={MINIMAP_H}
        data-minimap=""
        onPointerDown={(event) => props.onCenter(minimapToWorld(model, local(event)))}
      >
        <g transform={`scale(${model.scale}) translate(${-model.origin.x} ${-model.origin.y})`}>
          {model.edges.map((edge) => (
            <path key={edge.d} className={styles.miniEdge} d={edge.d} />
          ))}
        </g>
        {model.separators.map((sep) => (
          <line key={sep.x} className={styles.miniSep} x1={sep.x} x2={sep.x} y1={0} y2={MINIMAP_H} />
        ))}
        {model.frames.map((frame) => (
          <rect
            key={frame.key}
            data-mark={frame.mark}
            className={MARK_CLASS[frame.mark]}
            x={frame.rect.x}
            y={frame.rect.y}
            width={Math.max(1, frame.rect.w)}
            height={Math.max(1, frame.rect.h)}
            rx={1}
          />
        ))}
        <rect
          data-viewport=""
          className={styles.miniViewport}
          x={model.viewport.x}
          y={model.viewport.y}
          width={Math.max(2, model.viewport.w)}
          height={Math.max(2, model.viewport.h)}
          onPointerDown={(event) => {
            event.stopPropagation();
            drag.current = { x: event.clientX, y: event.clientY };
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={(event) => {
            const from = drag.current;
            if (from === null) return;
            drag.current = { x: event.clientX, y: event.clientY };
            props.onPan((event.clientX - from.x) / model.scale, (event.clientY - from.y) / model.scale);
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
        />
      </svg>
      {model.strip === null ? null : (
        <svg className={styles.strip} width={MINIMAP_W} height={MINIMAP_STRIP_H}>
          <rect
            className={styles.stripBracket}
            x={model.strip.bracket[0]}
            y={0}
            width={Math.max(1, model.strip.bracket[1] - model.strip.bracket[0])}
            height={MINIMAP_STRIP_H}
          />
          {model.strip.critical.map((x) => (
            <rect key={x} className={styles.stripCritical} x={x - 0.5} y={0} width={1} height={MINIMAP_STRIP_H} />
          ))}
        </svg>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/canvas/chrome.test.tsx`
Expected: PASS, `Tests  5 passed (5)`.

- [ ] **Step 7: Typecheck, lint and root checks**

Run: `pnpm --filter @jevcode/trace-viewer typecheck && pnpm lint`, then the root checks. Expected: all exit 0.

- [ ] **Step 8: Commit**

```bash
git add packages/trace-viewer/src/ui/views/canvas/Minimap.tsx packages/trace-viewer/src/ui/views/canvas/Toolbar.tsx packages/trace-viewer/src/ui/views/canvas/chrome.module.css packages/trace-viewer/src/ui/views/canvas/chrome.test.tsx
git commit -m "feat(trace-viewer): canvas minimap and floating toolbar"
```

### Task C3-10: `CanvasView`: composition, ruler XMap, live follow, sticky layout across ticks, `ViewPort`

**Files:**
- Create: `packages/trace-viewer/src/test-support/canvas-view-harness.tsx`
- Create: `packages/trace-viewer/src/ui/views/canvas/canvas-port.ts`
- Create: `packages/trace-viewer/src/ui/views/canvas/canvas-port.test.ts`
- Create: `packages/trace-viewer/src/ui/views/canvas/CanvasRuler.tsx`
- Create: `packages/trace-viewer/src/ui/views/canvas/CanvasView.tsx`
- Create: `packages/trace-viewer/src/ui/views/canvas/CanvasView.module.css`
- Create: `packages/trace-viewer/src/ui/views/canvas/canvas-view.test.tsx`

**Interfaces:**
- Consumes: C1-6 `createViewportController<C extends Camera>(options: ViewportControllerOptions<C>): ViewportController<C>` (`get()`, `set(camera, { animate? }): Promise<void>`, `zoomBy(factor, anchor?)`, `panBy(dx, dy)`, `isGesturing()`, `destroy()`; options `element`, `initial`, `limits()`, `viewport()`, `content()`, `onFrame(camera, phase)`, `onGestureStart?(kind)`, `onGestureEnd?(camera)`, `isHandTool()`, `reducedMotion()`, `settleRoundK?`), `type FramePhase = "gesture" | "tween" | "settle"`; C1-11 `ViewState`, `ViewAction`, `CanvasCamera`, `initialViewState`, `selectNewCount(state, index)`, `selectEffectivePlayheadSeq(state, index)`; C1-12 `useView`, `useViewStore`, `createViewStore`, `ViewStoreContext`, `ZOOM_STEP`; C2-3 `SessionContext`, `useSessionView(): SessionView`, `ViewPortRegistryContext`, `createViewPortRegistry`, `useRegisterViewPort(kind, port)`, `ViewPort`, `ZoomPreset`; C2-14 `ViewProps`; C2-9 `Ruler` (props per deviation 16); C1-9 `buildTimeScale`, `timeScaleInputOf`; C1-10 `buildTraceIndex`, `emptyTraceIndex`; C3-2/C3-3 `layoutCanvas`, `homeFrameKey`, `RouteInput`; C3-5 rulings; C3-6 `buildFrameContext`, `frameSteps`, `frameStart`, `frameEnd`, `zoomBand`; C3-7 `World`, `Overlay`, `focusFrameElement`, `CullRange`; C3-8 `Minimap`, `Toolbar`; C3-9 camera rules and `createCameraStore`.
- Produces:

```ts
// ui/views/canvas/CanvasView.tsx
export function CanvasView(props: ViewProps): React.JSX.Element;

// ui/views/canvas/canvas-port.ts
export function routeInputOf(layout: CanvasLayout, session: TraceSession): RouteInput;
/** The frame holding a selection id: a member's frame, else a step's home frame; undefined when unknown. */
export function frameForSelection(layout: CanvasLayout, session: TraceSession, id: SelectionId): CanvasFrame | undefined;
/** The frame of the last step that has one (the Canvas "tail" for lastSeenSeq). */
export function tailFrame(layout: CanvasLayout, session: TraceSession): CanvasFrame | undefined;
/** layout.readingOrder with each expanded chapter frame's steps after it (j/k in Canvas). */
export function canvasReadingOrder(layout: CanvasLayout, session: TraceSession, expanded: ReadonlySet<string>): SelectionId[];
export const CANVAS_ZOOM_PRESETS: readonly ZoomPreset[];      // 50%, 100%, 200%
export function zoomLabel(k: number): string;                    // "83%"
export interface CanvasPortDeps {
  readingOrder(): readonly SelectionId[];
  reveal(id: SelectionId, animate: boolean): void;
  captureCamera(): CanvasCamera | null;
  focusSelected(): void;
  camera(): UniformCamera;
  zoomAround(factor: number): void;
  zoomTo(k: number): void;
  fitAll(): void;
  fitSelection(): void;
}
export function createCanvasPort(deps: CanvasPortDeps): ViewPort;

// ui/views/canvas/CanvasRuler.tsx
export interface CanvasRulerProps { layout: CanvasLayout; scale: TimeScale; cameraStore: CameraStore; widthPx: number; playheadT: number | null; band: readonly [number, number] | null; problemTs: readonly number[]; hatchFromT: number | null }
export function CanvasRuler(props: CanvasRulerProps): React.JSX.Element;

// test-support/canvas-view-harness.tsx (test-only)
export function sessionViewOf(session: TraceSession | null, sessionId?: string): SessionView;
export interface ViewerHarness { store: ViewStore; registry: ViewPortRegistry; result: RenderResult; setSession(session: TraceSession | null): void }
export function renderWithViewer(ui: ReactElement, options: { session: TraceSession | null; state?: Partial<ViewState> }): ViewerHarness;
export function stubElementBox(width: number, height: number): void;
export interface ResizeObserverStub { resize(width: number, height: number): void; count(): number }
export function stubResizeObserver(): ResizeObserverStub;
export interface FrameStub { flush(): void; calls(): number }
export function stubAnimationFrames(): FrameStub;
export function stubReducedMotion(reduce: boolean): void;
export function canvasViewport(): HTMLElement;
export function cameraVars(element: HTMLElement): { tx: string; ty: string; k: string };
```

- [ ] **Step 1: Check the C2 props this task binds to**

Run:

```bash
grep -n "export interface RulerProps" -A 16 packages/trace-viewer/src/ui/views/shared/Ruler.tsx
grep -nE "export interface ViewProps|export (interface|type) ViewPort\b|export function useRegisterViewPort" packages/trace-viewer/src/ui/views/registry.ts packages/trace-viewer/src/ui/views/view-port.ts
```

Expected: `RulerProps` lists `map: XMap`, `scale: TimeScale`, `widthPx: number`, `playheadT: number | null`, `band: readonly [number, number] | null`, `problemTs: readonly number[]` and `hatchFromT: number | null` (deviation 16), and the second command prints the three contract lines. If `RulerProps` names these values differently, change only the JSX in Step 7's `CanvasRuler.tsx` to pass the same values under the merged names, and say so in the commit message. If `RulerProps` lacks an equivalent for one of them, stop and escalate (the index gave C2-9 no props).

- [ ] **Step 2: Write the test harness**

Create `packages/trace-viewer/src/test-support/canvas-view-harness.tsx`:

```tsx
import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { vi } from "vitest";

import { buildTimeScale, timeScaleInputOf } from "../layout/time-scale.js";
import { buildTraceIndex, emptyTraceIndex } from "../layout/trace-index.js";
import type { TraceSession } from "../model/index.js";
import { SessionContext, type SessionView } from "../ui/shell/session-context.js";
import { ViewStoreContext, createViewStore, type ViewStore } from "../ui/state/store.js";
import { initialViewState, type ViewState } from "../ui/state/view-state.js";
import { ViewPortRegistryContext, createViewPortRegistry, type ViewPortRegistry } from "../ui/views/view-port.js";

// Providers and per-test stubs for Canvas view tests. Every stub is installed by the test that calls it
// and removed by that file's afterEach (vi.restoreAllMocks, vi.unstubAllGlobals); nothing here is global.

export function sessionViewOf(session: TraceSession | null, sessionId = session?.meta.sessionId ?? "sess-canvas"): SessionView {
  const index = session === null ? emptyTraceIndex(sessionId) : buildTraceIndex(session);
  const scale = buildTimeScale(session === null ? { originMs: 0, work: [], awaitingFrom: [] } : timeScaleInputOf(session));
  const lastT = session?.steps.at(-1)?.tMs ?? 0;
  return {
    summary: session?.meta ?? null,
    session,
    index,
    scale,
    status: session === null ? { kind: "loading" } : { kind: "ready" },
    loadedFraction: session === null ? 0 : 1,
    terminal: session !== null && !session.live,
    nowT: () => lastT,
    payloads: async () => [],
    retry: () => undefined,
  };
}

export interface ViewerHarness {
  store: ViewStore;
  registry: ViewPortRegistry;
  result: RenderResult;
  setSession(session: TraceSession | null): void;
}

export function renderWithViewer(
  ui: ReactElement,
  options: { session: TraceSession | null; state?: Partial<ViewState> },
): ViewerHarness {
  let view = sessionViewOf(options.session);
  const store = createViewStore(
    { ...initialViewState({ live: options.session?.live ?? false }), ...options.state },
    view.index,
  );
  const registry = createViewPortRegistry();
  const tree = (value: SessionView): ReactElement => (
    <ViewStoreContext.Provider value={store}>
      <ViewPortRegistryContext.Provider value={registry}>
        <SessionContext.Provider value={value}>{ui}</SessionContext.Provider>
      </ViewPortRegistryContext.Provider>
    </ViewStoreContext.Provider>
  );
  const result = render(tree(view));
  return {
    store,
    registry,
    result,
    setSession(session) {
      view = sessionViewOf(session);
      store.setIndex(view.index);
      result.rerender(tree(view));
    },
  };
}

export function stubElementBox(width: number, height: number): void {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    () =>
      ({ x: 0, y: 0, left: 0, top: 0, width, height, right: width, bottom: height, toJSON: () => ({}) }) as DOMRect,
  );
}

export interface ResizeObserverStub {
  resize(width: number, height: number): void;
  count(): number;
}

interface ObserverEntry {
  callback: ResizeObserverCallback;
  targets: Set<Element>;
  observer: ResizeObserver;
}

export function stubResizeObserver(): ResizeObserverStub {
  const live = new Set<ObserverEntry>();
  class FakeResizeObserver implements ResizeObserver {
    private readonly entry: ObserverEntry;

    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, targets: new Set(), observer: this };
    }

    observe(target: Element): void {
      this.entry.targets.add(target);
      live.add(this.entry);
    }

    unobserve(target: Element): void {
      this.entry.targets.delete(target);
    }

    disconnect(): void {
      this.entry.targets.clear();
      live.delete(this.entry);
    }
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  return {
    resize(width, height) {
      for (const entry of [...live]) {
        const records = [...entry.targets].map(
          (target) =>
            ({
              target,
              contentRect: { x: 0, y: 0, left: 0, top: 0, width, height, right: width, bottom: height, toJSON: () => ({}) },
              borderBoxSize: [],
              contentBoxSize: [],
              devicePixelContentBoxSize: [],
            }) as unknown as ResizeObserverEntry,
        );
        entry.callback(records, entry.observer);
      }
    },
    count: () => live.size,
  };
}

export interface FrameStub {
  /** Runs queued animation frames (and the frames they queue) until none remain. */
  flush(): void;
  /** requestAnimationFrame calls since the stub was installed. */
  calls(): number;
}

export function stubAnimationFrames(): FrameStub {
  const queue = new Map<number, FrameRequestCallback>();
  let next = 1;
  let calls = 0;
  let now = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback): number => {
    calls += 1;
    const id = next;
    next += 1;
    queue.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number): void => {
    queue.delete(id);
  });
  return {
    flush() {
      for (let round = 0; round < 60 && queue.size > 0; round += 1) {
        now += 16;
        const batch = [...queue.values()];
        queue.clear();
        for (const callback of batch) callback(now);
      }
    },
    calls: () => calls,
  };
}

export function stubReducedMotion(reduce: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

export function canvasViewport(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-tv-viewport="canvas"]');
  if (element === null) throw new Error("no canvas viewport in the document");
  return element;
}

export function cameraVars(element: HTMLElement): { tx: string; ty: string; k: string } {
  return {
    tx: element.style.getPropertyValue("--tv-tx"),
    ty: element.style.getPropertyValue("--tv-ty"),
    k: element.style.getPropertyValue("--tv-k"),
  };
}
```

- [ ] **Step 3: Write the failing port tests**

Create `packages/trace-viewer/src/ui/views/canvas/canvas-port.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { layoutCanvas, type CanvasFrame } from "../../../layout/canvas-layout.js";
import { buildTraceIndex } from "../../../layout/trace-index.js";
import { canvasScale, oauthCanvasSession } from "../../../test-support/canvas-arbitraries.js";
import { canvasReadingOrder, createCanvasPort, frameForSelection, tailFrame, type CanvasPortDeps } from "./canvas-port.js";

const session = oauthCanvasSession();
const layout = layoutCanvas(session, buildTraceIndex(session), canvasScale(session), "chapter");

function frame(predicate: (candidate: CanvasFrame) => boolean): CanvasFrame {
  const found = layout.frames.find(predicate);
  if (found === undefined) throw new Error("frame not found");
  return found;
}

const linkingTest = frame((candidate) => candidate.selId === "unit:oauth-linking-test-failure");

describe("canvasReadingOrder", () => {
  it("equals the layout's reading order when nothing is expanded", () => {
    expect(canvasReadingOrder(layout, session, new Set())).toEqual(layout.readingOrder);
  });

  it("puts an expanded chapter's steps right after it", () => {
    const chapter = session.chapters.find((candidate) => candidate.id === linkingTest.selId);
    if (chapter === undefined) throw new Error("no chapter");
    const order = canvasReadingOrder(layout, session, new Set([linkingTest.key]));
    const at = order.indexOf(linkingTest.selId);
    expect(order.slice(at + 1, at + 1 + chapter.stepIds.length)).toEqual(chapter.stepIds);
    expect(order.filter((id) => !(chapter.stepIds as readonly string[]).includes(id))).toEqual(layout.readingOrder);
  });
});

describe("frameForSelection and tailFrame", () => {
  it("maps a step to its home frame and a unit to its own frame", () => {
    const testStep = session.steps.find((step) => step.command?.command === "pnpm test");
    expect(testStep === undefined ? undefined : frameForSelection(layout, session, testStep.id)?.key).toBe(linkingTest.key);
    expect(frameForSelection(layout, session, linkingTest.selId)?.key).toBe(linkingTest.key);
    expect(frameForSelection(layout, session, "unit:missing")).toBeUndefined();
  });

  it("finds the tail frame from the last step that has one", () => {
    expect(tailFrame(layout, session)?.item).toBe("claim");
  });
});

describe("createCanvasPort", () => {
  it("delegates zoom presets, steps and reveals", () => {
    const deps: CanvasPortDeps = {
      readingOrder: vi.fn(() => []),
      reveal: vi.fn(),
      captureCamera: vi.fn(() => null),
      focusSelected: vi.fn(),
      camera: () => ({ mode: "uniform", tx: 0, ty: 0, k: 0.834 }),
      zoomAround: vi.fn(),
      zoomTo: vi.fn(),
      fitAll: vi.fn(),
      fitSelection: vi.fn(),
    };
    const port = createCanvasPort(deps);
    expect(port.zoom.label()).toBe("83%");
    expect(port.zoom.presets().map((preset) => preset.label)).toEqual(["50%", "100%", "200%"]);
    port.zoom.applyPreset("200");
    expect(deps.zoomTo).toHaveBeenLastCalledWith(2);
    port.zoom.zoomIn();
    expect(deps.zoomAround).toHaveBeenLastCalledWith(1.25);
    port.zoom.zoomOut();
    expect(deps.zoomAround).toHaveBeenLastCalledWith(0.8);
    port.zoom.resetToPreset();
    expect(deps.zoomTo).toHaveBeenLastCalledWith(1);
    port.zoom.fitAll();
    port.zoom.fitSelection();
    expect(deps.fitAll).toHaveBeenCalledTimes(1);
    expect(deps.fitSelection).toHaveBeenCalledTimes(1);
    port.reveal("step:3", { animate: true });
    expect(deps.reveal).toHaveBeenCalledWith("step:3", true);
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/canvas/canvas-port.test.ts`
Expected: FAIL with `Failed to load url ./canvas-port.js`.

- [ ] **Step 5: Write `canvas-port.ts`**

Create `packages/trace-viewer/src/ui/views/canvas/canvas-port.ts`:

```ts
import type { CanvasFrame, CanvasLayout } from "../../../layout/canvas-layout.js";
import { LEVEL_SPECS } from "../../../layout/canvas-levels.js";
import { homeFrameKey, type RouteInput } from "../../../layout/canvas-routes.js";
import type { SelectionId } from "../../../layout/trace-index.js";
import type { UniformCamera } from "../../../layout/viewport.js";
import type { StepId, TraceSession } from "../../../model/index.js";
import { ZOOM_STEP } from "../../state/keymap.js";
import type { CanvasCamera } from "../../state/view-state.js";
import type { ViewPort, ZoomPreset } from "../view-port.js";

export function routeInputOf(layout: CanvasLayout, session: TraceSession): RouteInput {
  return {
    session,
    frames: layout.frames,
    frameByKey: layout.frameByKey,
    columns: layout.columns,
    spec: LEVEL_SPECS[layout.level],
  };
}

export function frameForSelection(layout: CanvasLayout, session: TraceSession, id: SelectionId): CanvasFrame | undefined {
  for (const frame of layout.frames) if (frame.memberSelIds.includes(id)) return frame;
  if (!id.startsWith("step:")) return undefined;
  const key = homeFrameKey(id as StepId, routeInputOf(layout, session));
  return key === undefined ? undefined : layout.frameByKey.get(key);
}

export function tailFrame(layout: CanvasLayout, session: TraceSession): CanvasFrame | undefined {
  const bySel = new Map<string, CanvasFrame>();
  for (const frame of layout.frames) {
    for (const selId of frame.memberSelIds) if (!bySel.has(selId)) bySel.set(selId, frame);
  }
  for (let i = session.steps.length - 1; i >= 0; i -= 1) {
    const step = session.steps[i];
    if (step === undefined) continue;
    const direct = bySel.get(step.id);
    if (direct !== undefined) return direct;
    for (const chapterId of step.chapterIds) {
      const frame = bySel.get(chapterId);
      if (frame !== undefined) return frame;
    }
  }
  return undefined;
}

export function canvasReadingOrder(
  layout: CanvasLayout,
  session: TraceSession,
  expanded: ReadonlySet<string>,
): SelectionId[] {
  const chapterById = new Map(session.chapters.map((chapter) => [chapter.id, chapter]));
  const out: SelectionId[] = [];
  const seen = new Set<SelectionId>();
  const push = (id: SelectionId): void => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const frame of layout.frames) {
    for (const selId of frame.memberSelIds) push(selId);
    if (frame.kind === "chapter" && (expanded.has(frame.key) || expanded.has(frame.selId))) {
      for (const stepId of chapterById.get(frame.selId as `unit:${string}`)?.stepIds ?? []) push(stepId);
    }
  }
  return out;
}

export const CANVAS_ZOOM_PRESETS: readonly ZoomPreset[] = [
  { id: "50", label: "50%" },
  { id: "100", label: "100%" },
  { id: "200", label: "200%" },
];

export function zoomLabel(k: number): string {
  return `${Math.round(k * 100)}%`;
}

export interface CanvasPortDeps {
  readingOrder(): readonly SelectionId[];
  reveal(id: SelectionId, animate: boolean): void;
  captureCamera(): CanvasCamera | null;
  focusSelected(): void;
  camera(): UniformCamera;
  zoomAround(factor: number): void;
  zoomTo(k: number): void;
  fitAll(): void;
  fitSelection(): void;
}

/** The Canvas registration with the shell (UI index §2.4 ViewPort). */
export function createCanvasPort(deps: CanvasPortDeps): ViewPort {
  return {
    readingOrder: () => deps.readingOrder(),
    reveal: (id, options) => deps.reveal(id, options.animate),
    captureCamera: () => deps.captureCamera(),
    focusSelected: () => deps.focusSelected(),
    zoom: {
      label: () => zoomLabel(deps.camera().k),
      presets: () => CANVAS_ZOOM_PRESETS,
      applyPreset: (id) => {
        const k = Number(id) / 100;
        if (Number.isFinite(k) && k > 0) deps.zoomTo(k);
      },
      zoomIn: () => deps.zoomAround(ZOOM_STEP),
      zoomOut: () => deps.zoomAround(1 / ZOOM_STEP),
      resetToPreset: () => deps.zoomTo(1),
      fitAll: () => deps.fitAll(),
      fitSelection: () => deps.fitSelection(),
    },
  };
}
```

- [ ] **Step 6: Run the port tests to verify they pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/canvas/canvas-port.test.ts`
Expected: PASS, `Tests  5 passed (5)`.

- [ ] **Step 7: Write the ruler adapter and the view styles**

Create `packages/trace-viewer/src/ui/views/canvas/CanvasRuler.tsx`:

```tsx
import { useMemo, useSyncExternalStore } from "react";
import type React from "react";

import { canvasXMap, type CanvasLayout } from "../../../layout/canvas-layout.js";
import type { TimeScale } from "../../../layout/time-scale.js";
import { Ruler } from "../shared/Ruler.js";
import { screenXMap, type CameraStore } from "./canvas-camera.js";

export interface CanvasRulerProps {
  layout: CanvasLayout;
  scale: TimeScale;
  cameraStore: CameraStore;
  widthPx: number;
  playheadT: number | null;
  band: readonly [number, number] | null;
  problemTs: readonly number[];
  hatchFromT: number | null;
}

/** The shared Ruler over the canvas column map (spec §7.4); the only place this lane passes Ruler props. */
export function CanvasRuler(props: CanvasRulerProps): React.JSX.Element {
  const camera = useSyncExternalStore(props.cameraStore.subscribe, props.cameraStore.get);
  const world = useMemo(() => canvasXMap(props.layout, props.scale), [props.layout, props.scale]);
  const map = useMemo(() => screenXMap(world, camera), [world, camera]);
  return (
    <Ruler
      map={map}
      scale={props.scale}
      widthPx={props.widthPx}
      playheadT={props.playheadT}
      band={props.band}
      problemTs={props.problemTs}
      hatchFromT={props.hatchFromT}
    />
  );
}
```

Create `packages/trace-viewer/src/ui/views/canvas/CanvasView.module.css`:

```css
.root {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--tv-canvas);
}

.ruler {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 28px;
  z-index: 3;
  background: var(--tv-canvas);
}

.stage {
  position: absolute;
  left: 0;
  right: 0;
  top: 28px;
  bottom: 0;
}

.empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  margin: 0;
  font-size: 13px;
  color: var(--tv-ink-3);
  pointer-events: none;
}

.ahead {
  position: absolute;
  right: 16px;
  top: 50%;
  z-index: 4;
  height: 24px;
  padding: 0 10px;
  border: 0;
  border-radius: 12px;
  background: var(--tv-panel);
  box-shadow: var(--tv-shadow);
  font: inherit;
  font-size: 12px;
  color: var(--tv-ink);
  transform: translateY(-50%);
}
```

- [ ] **Step 8: Write the failing view tests**

Create `packages/trace-viewer/src/ui/views/canvas/canvas-view.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UniformCamera } from "../../../layout/viewport.js";
import { buildCanvasSession, type CanvasSeed } from "../../../test-support/canvas-arbitraries.js";
import {
  cameraVars,
  canvasViewport,
  renderWithViewer,
  stubAnimationFrames,
  stubElementBox,
  stubReducedMotion,
  stubResizeObserver,
} from "../../../test-support/canvas-view-harness.js";
import { initialViewState, type ViewAction, type ViewState } from "../../state/view-state.js";
import { CanvasView } from "./CanvasView.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Layout at Chapter level (spec §7.5 rules): intent col 0; plan opens col 1 (x 264) with chapters c3, c4;
// the decision opens col 2 (x 528) with chapter c6; a claim at 43 s opens col 3 (x 792, right edge 1016).
const BASE: CanvasSeed[] = [
  { atMs: 8_000, kind: "plan" },
  { atMs: 10_000, kind: "chapter" },
  { atMs: 15_000, kind: "chapter" },
  { atMs: 25_000, kind: "decision" },
  { atMs: 30_000, kind: "chapter" },
];
const s1 = buildCanvasSession(BASE, { live: true });
const s1WithWork = buildCanvasSession([...BASE, { atMs: 31_000, kind: "work" }], { live: true });
const s2 = buildCanvasSession([...BASE, { atMs: 31_000, kind: "work" }, { atMs: 43_000, kind: "claim" }], { live: true });

function saved(tx: number, ty: number, k: number): ViewState["cameras"] {
  return { canvas: { mode: "uniform", tx, ty, k, syncedRev: initialViewState({ live: true }).focusRev }, hybrid: null };
}

function setup(width = 600, height = 600) {
  stubElementBox(width, height);
  const observers = stubResizeObserver();
  const frames = stubAnimationFrames();
  stubReducedMotion(true);
  return { observers, frames };
}

function frameStyles(): Map<string, string> {
  return new Map(
    [...document.querySelectorAll<HTMLElement>('[role="group"][data-key]')].map((element) => [
      element.dataset.key ?? "",
      element.getAttribute("style") ?? "",
    ]),
  );
}

function numericCamera(): UniformCamera {
  const vars = cameraVars(canvasViewport());
  return { mode: "uniform", tx: parseFloat(vars.tx), ty: parseFloat(vars.ty), k: Number(vars.k) };
}

function screenOf(key: string): { x: number; y: number } {
  const element = [...document.querySelectorAll<HTMLElement>("[data-key]")].find((candidate) => candidate.dataset.key === key);
  if (element === undefined) throw new Error(`no frame ${key}`);
  const camera = numericCamera();
  return { x: parseFloat(element.style.left) * camera.k + camera.tx, y: parseFloat(element.style.top) * camera.k + camera.ty };
}

describe("CanvasView", () => {
  it("an append leaves every placed frame's rect unchanged", () => {
    const { frames } = setup();
    const harness = renderWithViewer(<CanvasView active />, { session: s1, state: { follow: false, cameras: saved(0, 0, 1) } });
    act(() => frames.flush());
    const before = frameStyles();
    act(() => harness.setSession(s2));
    act(() => frames.flush());
    const after = frameStyles();
    for (const [key, style] of before) expect(after.get(key), key).toBe(style);
    expect(after.size).toBe(before.size + 1);
    expect(document.activeElement).toBe(document.body);
  });

  it("in Live the camera pans x only when the frontier column leaves the view", () => {
    const { frames } = setup();
    const harness = renderWithViewer(<CanvasView active />, { session: s1, state: { follow: true, cameras: saved(-200, 0, 1) } });
    act(() => frames.flush());
    expect(cameraVars(canvasViewport())).toEqual({ tx: "-200px", ty: "0px", k: "1" });
    act(() => harness.setSession(s1WithWork));
    act(() => frames.flush());
    expect(cameraVars(canvasViewport())).toEqual({ tx: "-200px", ty: "0px", k: "1" });
    act(() => harness.setSession(s2));
    act(() => frames.flush());
    // Column 3's right edge (1016) lands at viewport width − 48 = 552: tx = 552 − 1016.
    expect(cameraVars(canvasViewport())).toEqual({ tx: "-464px", ty: "0px", k: "1" });
  });

  it("in Review it never moves and shows N frames → for frames past the right edge", () => {
    const { frames } = setup();
    const harness = renderWithViewer(<CanvasView active />, {
      session: s1,
      state: { follow: false, lastSeenSeq: s1.loadedThroughSeq, cameras: saved(-150, 0, 1) },
    });
    act(() => frames.flush());
    act(() => harness.setSession(s2));
    act(() => frames.flush());
    expect(cameraVars(canvasViewport())).toEqual({ tx: "-150px", ty: "0px", k: "1" });
    expect(screen.getByRole("button", { name: "1 frame →" })).toBeDefined();
  });

  it("registers a ViewPort whose reading order adds an expanded frame's steps", () => {
    setup();
    const harness = renderWithViewer(<CanvasView active />, { session: s1, state: { expanded: new Set(["ch:3"]) } });
    // Columns left → right, story cells then work rows (spec §7.5): intent, plan, c3 (+ its step), c4, decision, c6.
    expect(harness.registry.get("canvas")?.readingOrder()).toEqual([
      "step:1",
      "step:2",
      "unit:c3",
      "step:3",
      "unit:c4",
      "step:5",
      "unit:c6",
    ]);
  });

  it("a settled user pan writes brush/set and a programmatic move never does", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { frames } = setup();
    const harness = renderWithViewer(<CanvasView active />, { session: s2, state: { follow: false, cameras: saved(0, 0, 1) } });
    act(() => frames.flush());
    const dispatch = vi.spyOn(harness.store, "dispatch");
    const brushWrites = (): ViewAction[] =>
      dispatch.mock.calls.map(([action]) => action).filter((action) => action.type === "brush/set");
    act(() => harness.registry.get("canvas")?.zoom.fitAll());
    act(() => {
      frames.flush();
      vi.advanceTimersByTime(200);
      frames.flush();
    });
    expect(brushWrites()).toEqual([]);
    act(() => {
      fireEvent.wheel(canvasViewport(), { deltaX: 120, deltaY: 0 });
      frames.flush();
    });
    act(() => {
      vi.advanceTimersByTime(200);
      frames.flush();
    });
    expect(brushWrites()).toEqual([
      expect.objectContaining({ type: "brush/set", by: "canvas", brush: expect.objectContaining({ kind: "range" }) }),
    ]);
  });

  it("a level switch keeps the focus frame on the same screen point", () => {
    const { frames } = setup();
    const harness = renderWithViewer(<CanvasView active />, {
      session: s2,
      state: { follow: false, selection: "unit:c4", cameras: saved(-100, 20, 1) },
    });
    act(() => frames.flush());
    const before = screenOf("ch:4");
    act(() => harness.store.dispatch({ type: "level/set", level: "session", by: "shell" }));
    act(() => frames.flush());
    const after = screenOf("ch:4");
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("reveals a selection made outside the canvas and leaves canvas clicks alone", () => {
    const { frames } = setup();
    const harness = renderWithViewer(<CanvasView active />, { session: s2, state: { follow: false, cameras: saved(0, 0, 1) } });
    act(() => frames.flush());
    act(() => harness.store.dispatch({ type: "select", id: "step:8", by: "shell" }));
    act(() => frames.flush());
    // The claim card (792, 22, 224, 96) is centered at the same k: tx = 300 − 904, ty = 300 − 70.
    expect(cameraVars(canvasViewport())).toEqual({ tx: "-604px", ty: "230px", k: "1" });
    act(() => harness.store.dispatch({ type: "select", id: "unit:c3", by: "canvas" }));
    act(() => frames.flush());
    expect(cameraVars(canvasViewport())).toEqual({ tx: "-604px", ty: "230px", k: "1" });
  });
});
```

- [ ] **Step 9: Run it to verify it fails**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/canvas/canvas-view.test.tsx`
Expected: FAIL with `Failed to load url ./CanvasView.js`.

- [ ] **Step 10: Write `CanvasView.tsx`**

Create `packages/trace-viewer/src/ui/views/canvas/CanvasView.tsx`:

```tsx
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type React from "react";

import { layoutCanvas, type CanvasFrame, type CanvasLayout } from "../../../layout/canvas-layout.js";
import type { CanvasEdge } from "../../../layout/canvas-routes.js";
import type { TimeScale } from "../../../layout/time-scale.js";
import type { SelectionId, TraceIndex } from "../../../layout/trace-index.js";
import { screenToWorld, setCenter, worldToScreen, type Point, type Size, type UniformCamera } from "../../../layout/viewport.js";
import type { Level, TraceSession } from "../../../model/index.js";
import { useSessionView } from "../../shell/session-context.js";
import { useView, useViewStore } from "../../state/store.js";
import { selectEffectivePlayheadSeq, selectNewCount } from "../../state/view-state.js";
import { createViewportController, type FramePhase, type ViewportController } from "../../viewport/controller.js";
import type { ViewProps } from "../registry.js";
import { ViewPortRegistryContext, useRegisterViewPort } from "../view-port.js";
import { CanvasRuler } from "./CanvasRuler.js";
import styles from "./CanvasView.module.css";
import {
  DEFAULT_CAMERA,
  brushForWindow,
  createCameraStore,
  focusFrame,
  framesAhead,
  frontierFollowCamera,
  intersectsViewport,
  levelLimits,
  pinFrameCamera,
  planFit,
  revealCamera,
  showCamera,
  zoomToSelection,
} from "./canvas-camera.js";
import { canvasReadingOrder, createCanvasPort, frameForSelection, tailFrame } from "./canvas-port.js";
import { buildFrameContext, frameEnd, frameStart, frameSteps, zoomBand } from "./frame-label.js";
import { Minimap } from "./Minimap.js";
import { Overlay } from "./Overlay.js";
import { CANVAS_SETTLE_ROUND_K, CULL_FRAMES, INV_K_EVERY_FRAME } from "./spike-rulings.js";
import { Toolbar } from "./Toolbar.js";
import { World, focusFrameElement, type CullRange } from "./World.js";

interface Latest {
  layout: CanvasLayout | null;
  session: TraceSession | null;
  index: TraceIndex;
  scale: TimeScale;
  level: Level;
}

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** layoutCanvas chained through the last committed layout, so a placed frame never moves (spec §7.5). */
function useStickyLayout(
  session: TraceSession | null,
  index: TraceIndex,
  scale: TimeScale,
  level: Level,
  tidyRev: number,
): CanvasLayout | null {
  const prevRef = useRef<{ layout: CanvasLayout; tidyRev: number } | null>(null);
  const layout = useMemo(() => {
    if (session === null) return null;
    const prev = prevRef.current;
    return layoutCanvas(session, index, scale, level, prev !== null && prev.tidyRev === tidyRev ? prev.layout : undefined);
  }, [session, index, scale, level, tidyRev]);
  useLayoutEffect(() => {
    if (layout !== null) prevRef.current = { layout, tidyRev };
  }, [layout, tidyRev]);
  return layout;
}

/** Frames animate for --tv-dur after a level switch or Tidy; the pinned focus frame does not. */
function markRelayout(viewport: HTMLElement | null, pinnedKey: string): void {
  if (viewport === null) return;
  viewport.setAttribute("data-relayout", "");
  const pinned = [...viewport.querySelectorAll<HTMLElement>("[data-key]")].find((element) => element.dataset.key === pinnedKey);
  pinned?.setAttribute("data-pinned", "");
  window.setTimeout(() => {
    viewport.removeAttribute("data-relayout");
    pinned?.removeAttribute("data-pinned");
  }, 250);
}

export function CanvasView({ active }: ViewProps): React.JSX.Element {
  const view = useSessionView();
  const store = useViewStore();
  const registry = useContext(ViewPortRegistryContext);
  const level = useView((state) => state.level);
  const selection = useView((state) => state.selection);
  const expanded = useView((state) => state.expanded);
  const tool = useView((state) => state.tool);
  const follow = useView((state) => state.follow);
  const newCount = useView((state) => selectNewCount(state, view.index));
  const playheadSeq = useView((state) => selectEffectivePlayheadSeq(state, view.index));
  const [tidyRev, setTidyRev] = useState(0);
  const [gesturing, setGesturing] = useState(false);
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  const [settled, setSettled] = useState<UniformCamera | null>(null);
  const { session, index, scale } = view;
  const layout = useStickyLayout(session, index, scale, level, tidyRev);
  const ctx = useMemo(() => (session === null ? null : buildFrameContext(session)), [session]);
  const cameraStore = useMemo(() => createCameraStore(DEFAULT_CAMERA), []);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<ViewportController<UniformCamera> | null>(null);
  const sizeRef = useRef<Size>({ w: 0, h: 0 });
  const latest = useRef<Latest>({ layout, session, index, scale, level });
  const prevLayoutRef = useRef<CanvasLayout | null>(null);
  const lastSelectionRef = useRef<SelectionId | null>(selection);
  const pendingShowRef = useRef(false);
  const pendingFitRef = useRef(false);
  const relayoutRef = useRef(false);
  const userGestureRef = useRef(false);
  const syncedRevRef = useRef(-1);

  // First layout effect of every commit: callbacks below read the committed values through `latest`.
  useLayoutEffect(() => {
    latest.current = { layout, session, index, scale, level };
  });

  const writeCamera = useCallback(
    (camera: UniformCamera, phase: FramePhase) => {
      const element = viewportRef.current;
      if (element !== null) {
        element.style.setProperty("--tv-tx", `${camera.tx}px`);
        element.style.setProperty("--tv-ty", `${camera.ty}px`);
        element.style.setProperty("--tv-k", String(camera.k));
        if (INV_K_EVERY_FRAME || phase !== "gesture") element.style.setProperty("--tv-inv-k", String(1 / camera.k));
        const band = zoomBand(camera.k);
        if (element.dataset.zoomBand !== band) element.dataset.zoomBand = band;
      }
      cameraStore.set(camera);
    },
    [cameraStore],
  );

  const sync = useCallback(() => {
    const controller = controllerRef.current;
    if (controller === null) return;
    const camera = controller.get();
    syncedRevRef.current = store.get().focusRev;
    store.dispatch({ type: "camera/sync", view: "canvas", camera: { mode: "uniform", tx: camera.tx, ty: camera.ty, k: camera.k } });
    setSettled(camera);
    registry?.notify();
  }, [registry, store]);

  const moveTo = useCallback(
    (camera: UniformCamera, animate: boolean) => {
      const controller = controllerRef.current;
      if (controller === null) return;
      void controller.set(camera, { animate: animate && !reducedMotion() }).then(() => {
        if (controllerRef.current === controller) sync();
      });
    },
    [sync],
  );

  const leaveLive = useCallback(() => {
    if (store.get().follow) store.dispatch({ type: "follow/set", follow: false });
  }, [store]);

  const markSeen = useCallback(() => {
    const { layout: current, session: s, index: idx } = latest.current;
    const controller = controllerRef.current;
    if (current === null || s === null || controller === null) return;
    if (store.get().lastSeenSeq >= idx.loadedThroughSeq) return;
    const tail = tailFrame(current, s);
    if (tail !== undefined && intersectsViewport(controller.get(), tail.card, sizeRef.current)) {
      store.dispatch({ type: "seen", seq: idx.loadedThroughSeq });
    }
  }, [store]);

  const runPendingShow = useCallback(() => {
    if (!pendingShowRef.current) return;
    const { layout: current, session: s, index: idx, scale: sc } = latest.current;
    const controller = controllerRef.current;
    const viewport = sizeRef.current;
    // Never fits a 0 × 0 rect: wait for a ResizeObserver entry with a real size.
    if (controller === null || current === null || s === null || viewport.w <= 0 || viewport.h <= 0) return;
    pendingShowRef.current = false;
    const state = store.get();
    const selected = state.selection === null ? undefined : frameForSelection(current, s, state.selection);
    const target = showCamera({
      layout: current,
      scale: sc,
      session: s,
      index: idx,
      brush: state.brush,
      camera: controller.get(),
      viewport,
      selectionCard: selected?.card ?? null,
    });
    if (target === null) sync();
    else moveTo(target, true);
  }, [moveTo, store, sync]);

  const fitAll = useCallback(() => {
    const current = latest.current.layout;
    const controller = controllerRef.current;
    if (current === null || controller === null) return;
    const plan = planFit(current, sizeRef.current);
    if (plan === null) return;
    leaveLive();
    if (plan.kind === "switch") {
      pendingFitRef.current = true;
      store.dispatch({ type: "level/set", level: plan.level, by: "canvas" });
      return;
    }
    moveTo(plan.camera, true);
  }, [leaveLive, moveTo, store]);

  const fitSelection = useCallback(() => {
    const { layout: current, session: s } = latest.current;
    const selected = store.get().selection;
    if (current === null || s === null || selected === null) return;
    const frame = frameForSelection(current, s, selected);
    const target = frame === undefined ? null : zoomToSelection(current, frame.key, sizeRef.current);
    if (target === null) return;
    leaveLive();
    moveTo(target, true);
  }, [leaveLive, moveTo, store]);

  const zoomAround = useCallback(
    (factor: number) => {
      const controller = controllerRef.current;
      const viewport = sizeRef.current;
      if (controller === null || viewport.w <= 0 || viewport.h <= 0) return;
      const { layout: current, session: s } = latest.current;
      const selected = store.get().selection;
      const frame = current === null || s === null || selected === null ? undefined : frameForSelection(current, s, selected);
      const anchor: Point =
        frame === undefined
          ? { x: viewport.w / 2, y: viewport.h / 2 }
          : worldToScreen(controller.get(), { x: frame.card.x + frame.card.w / 2, y: frame.card.y + frame.card.h / 2 });
      leaveLive();
      controller.zoomBy(factor, anchor);
    },
    [leaveLive, store],
  );

  const zoomTo = useCallback(
    (k: number) => {
      const controller = controllerRef.current;
      if (controller !== null) zoomAround(k / controller.get().k);
    },
    [zoomAround],
  );

  const reveal = useCallback(
    (id: SelectionId, animate: boolean) => {
      const { layout: current, session: s } = latest.current;
      const controller = controllerRef.current;
      if (current === null || s === null || controller === null) return;
      const frame = frameForSelection(current, s, id);
      if (frame === undefined) return;
      const target = revealCamera(controller.get(), frame.card, sizeRef.current);
      if (target === null) sync();
      else moveTo(target, animate);
    },
    [moveTo, sync],
  );

  // Controller lifecycle: runs on mount and on every <Activity> show; its cleanup runs on hide.
  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (element === null) return undefined;
    const box = element.getBoundingClientRect();
    sizeRef.current = box.width > 0 && box.height > 0 ? { w: box.width, h: box.height } : { w: 0, h: 0 };
    const state = store.get();
    const saved = state.cameras.canvas;
    const exact = saved !== null && saved.syncedRev === state.focusRev;
    const initial: UniformCamera =
      saved === null ? cameraStore.get() : { mode: "uniform", tx: saved.tx, ty: saved.ty, k: saved.k };
    pendingShowRef.current = !exact;
    if (exact) syncedRevRef.current = saved.syncedRev;
    lastSelectionRef.current = state.selection;
    writeCamera(initial, "settle");
    const controller = createViewportController<UniformCamera>({
      element,
      initial,
      limits: () => levelLimits(latest.current.level),
      viewport: () => sizeRef.current,
      content: () => latest.current.layout?.bounds ?? { x: 0, y: 0, w: 0, h: 0 },
      onFrame: (camera, phase) => writeCamera(camera, phase),
      onGestureStart: (kind) => {
        userGestureRef.current = true;
        setGesturing(true);
        store.dispatch({ type: "gesture", gesture: kind });
        leaveLive();
      },
      onGestureEnd: (camera) => {
        setGesturing(false);
        writeCamera(camera, "settle");
        if (userGestureRef.current) {
          userGestureRef.current = false;
          store.dispatch({ type: "gesture", gesture: null });
          const { layout: current, session: s, scale: sc } = latest.current;
          if (current !== null && s !== null) {
            const brush = brushForWindow({ layout: current, scale: sc, session: s, camera, viewport: sizeRef.current });
            if (brush !== null) store.dispatch({ type: "brush/set", brush, by: "canvas" });
          }
        }
        sync();
        markSeen();
      },
      isHandTool: () => store.get().tool === "hand",
      reducedMotion,
      settleRoundK: CANVAS_SETTLE_ROUND_K,
    });
    controllerRef.current = controller;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect === undefined || rect.width <= 0 || rect.height <= 0) return; // width 0 under <Activity mode="hidden">
      sizeRef.current = { w: rect.width, h: rect.height };
      setSize(sizeRef.current);
      runPendingShow();
    });
    observer.observe(element);
    setSize(sizeRef.current);
    runPendingShow();
    return () => {
      observer.disconnect();
      const camera = controller.get();
      controller.destroy();
      controllerRef.current = null;
      store.dispatch({ type: "camera/sync", view: "canvas", camera: { mode: "uniform", tx: camera.tx, ty: camera.ty, k: camera.k } });
    };
  }, [cameraStore, leaveLive, markSeen, runPendingShow, store, sync, writeCamera]);

  // Layout changes: pin the focus frame across a level switch or Tidy; follow the frontier in Live.
  useLayoutEffect(() => {
    const prev = prevLayoutRef.current;
    prevLayoutRef.current = layout;
    const controller = controllerRef.current;
    if (layout === null || controller === null) return;
    const viewport = sizeRef.current;
    if (prev !== null && (prev.level !== layout.level || relayoutRef.current)) {
      relayoutRef.current = false;
      const s = latest.current.session;
      const selected = store.get().selection;
      const selectedBefore = s === null || selected === null ? undefined : frameForSelection(prev, s, selected);
      const focus = focusFrame(prev, controller.get(), viewport, selectedBefore);
      const next =
        focus === undefined
          ? undefined
          : (layout.frameByKey.get(focus.key) ?? layout.frames.find((candidate) => candidate.selId === focus.selId));
      if (focus !== undefined && next !== undefined) {
        const pinned = pinFrameCamera(controller.get(), focus.card, next.card, levelLimits(layout.level));
        writeCamera(pinned, "settle");
        void controller.set(pinned, { animate: false });
        markRelayout(viewportRef.current, next.key);
      }
      if (pendingFitRef.current) {
        pendingFitRef.current = false;
        fitAll();
      } else {
        sync();
      }
    } else if (prev !== null && store.get().follow) {
      const target = frontierFollowCamera(layout, controller.get(), viewport);
      if (target !== null) moveTo(target, true);
    }
    runPendingShow();
    markSeen();
  }, [fitAll, layout, markSeen, moveTo, runPendingShow, store, sync, writeCamera]);

  // Reveal (spec §7.5): a selection made outside the canvas (keys, Outline, n/N, a switch) comes into view.
  useEffect(() => {
    if (lastSelectionRef.current === selection) return;
    lastSelectionRef.current = selection;
    if (!active || selection === null) return;
    if (store.get().focusBy === "canvas") {
      sync();
      return;
    }
    reveal(selection, true);
  }, [active, reveal, selection, store, sync]);

  const port = useMemo(
    () =>
      createCanvasPort({
        readingOrder: () => {
          const { layout: current, session: s } = latest.current;
          return current === null || s === null ? [] : canvasReadingOrder(current, s, store.get().expanded);
        },
        reveal,
        captureCamera: () => {
          const camera = controllerRef.current?.get() ?? cameraStore.get();
          return { mode: "uniform", tx: camera.tx, ty: camera.ty, k: camera.k, syncedRev: syncedRevRef.current };
        },
        focusSelected: () => {
          const { layout: current, session: s } = latest.current;
          const selected = store.get().selection;
          const element = viewportRef.current;
          if (current === null || s === null || selected === null || element === null) return;
          const frame = frameForSelection(current, s, selected);
          if (frame !== undefined) focusFrameElement(element, frame.key);
        },
        camera: () => cameraStore.get(),
        zoomAround,
        zoomTo,
        fitAll,
        fitSelection,
      }),
    [cameraStore, fitAll, fitSelection, reveal, store, zoomAround, zoomTo],
  );
  useRegisterViewPort("canvas", port);

  const ahead = useSyncExternalStore(cameraStore.subscribe, () =>
    layout === null ? 0 : framesAhead(layout, cameraStore.get(), size),
  );

  const selectedFrame =
    layout !== null && session !== null && selection !== null ? frameForSelection(layout, session, selection) : undefined;
  const selectedKey = selectedFrame?.key ?? null;

  const criticalKeys = useMemo(() => {
    const keys = new Set<string>();
    if (layout === null || ctx === null) return keys;
    for (const frame of layout.frames) {
      const critical =
        frameSteps(frame, ctx).some((step) =>
          step.findingIds.some((id) => ctx.findingsById.get(id)?.severity === "critical"),
        ) ||
        frame.memberSelIds.some((selId) =>
          (ctx.chapterById.get(selId)?.findingIds ?? []).some((id) => ctx.findingsById.get(id)?.severity === "critical"),
        );
      if (critical) keys.add(frame.key);
    }
    return keys;
  }, [layout, ctx]);

  const problemTs = useMemo(() => {
    if (session === null) return [];
    const stepById = new Map(session.steps.map((step) => [step.id, step]));
    return session.findings
      .filter((finding) => finding.severity === "critical")
      .map((finding) => stepById.get(finding.anchorStepId)?.tMs)
      .filter((t): t is number => t !== undefined);
  }, [session]);

  const playheadT = session === null ? null : (session.steps[index.stepIndexAtOrBefore(playheadSeq)]?.tMs ?? null);
  const band: readonly [number, number] | null =
    selectedFrame === undefined || ctx === null ? null : [frameStart(selectedFrame, ctx), frameEnd(selectedFrame, ctx)];
  const hatchFromT = view.loadedFraction < 1 ? (session?.steps.at(-1)?.tMs ?? null) : null;
  const cullRange: CullRange | null =
    CULL_FRAMES && settled !== null && size.w > 0
      ? {
          x0: screenToWorld(settled, { x: -size.w, y: 0 }).x,
          x1: screenToWorld(settled, { x: 2 * size.w, y: 0 }).x,
        }
      : null;

  const onSelect = useCallback(
    (frame: CanvasFrame) => {
      if (store.get().tool === "hand") return;
      store.dispatch({ type: "select", id: frame.selId, by: "canvas" });
    },
    [store],
  );
  const onToggle = useCallback((frame: CanvasFrame) => store.dispatch({ type: "expand/toggle", key: frame.key }), [store]);
  const onSelectEdge = useCallback(
    (edge: CanvasEdge) => {
      const from = latest.current.layout?.frameByKey.get(edge.from);
      if (from !== undefined) store.dispatch({ type: "select", id: from.selId, by: "canvas" });
    },
    [store],
  );
  const onCenter = useCallback(
    (world: Point) => {
      const controller = controllerRef.current;
      if (controller === null) return;
      leaveLive();
      moveTo(setCenter(controller.get(), world, sizeRef.current), true);
    },
    [leaveLive, moveTo],
  );
  const onPan = useCallback(
    (dx: number, dy: number) => {
      const controller = controllerRef.current;
      if (controller === null) return;
      leaveLive();
      const camera = controller.get();
      void controller.set({ ...camera, tx: camera.tx - dx * camera.k, ty: camera.ty - dy * camera.k }, { animate: false });
    },
    [leaveLive],
  );

  const hiddenRows =
    session === null ? 0 : Object.values(session.hidden.byType).reduce<number>((sum, count) => sum + (count ?? 0), 0);
  const emptyText =
    session === null || layout === null || layout.frames.length > 0
      ? null
      : session.live
        ? "Waiting for the agent's first event"
        : hiddenRows > 0
          ? `${hiddenRows.toLocaleString("en-US")} events, none describe agent work`
          : "No steps in this session";

  return (
    <div className={styles.root}>
      <div className={styles.ruler}>
        {layout !== null && size.w > 0 ? (
          <CanvasRuler
            layout={layout}
            scale={scale}
            cameraStore={cameraStore}
            widthPx={size.w}
            playheadT={playheadT}
            band={band}
            problemTs={problemTs}
            hatchFromT={hatchFromT}
          />
        ) : null}
      </div>
      <div className={styles.stage}>
        <World
          layout={layout}
          ctx={ctx}
          level={level}
          selectedKey={selectedKey}
          expanded={expanded}
          gesturing={gesturing}
          tool={tool}
          cullRange={cullRange}
          viewportRef={viewportRef}
          worldRef={worldRef}
          overlay={
            layout !== null && ctx !== null ? (
              <Overlay layout={layout} ctx={ctx} level={level} selectedKey={selectedKey} onSelect={onSelect} />
            ) : null
          }
          onSelect={onSelect}
          onToggle={onToggle}
          onSelectEdge={onSelectEdge}
        />
        {emptyText === null ? null : <p className={styles.empty}>{emptyText}</p>}
        {!follow && newCount > 0 && ahead > 0 ? (
          <button type="button" tabIndex={-1} className={styles.ahead} onClick={() => store.dispatch({ type: "nav/last" })}>
            {ahead === 1 ? "1 frame →" : `${ahead} frames →`}
          </button>
        ) : null}
        {layout !== null ? (
          <Toolbar
            tool={tool}
            level={level}
            holes={layout.stats.holes}
            onTool={(next) => store.dispatch({ type: "tool/set", tool: next })}
            onLevel={(next) => store.dispatch({ type: "level/set", level: next, by: "canvas" })}
            onFit={fitAll}
            onTidy={() => {
              relayoutRef.current = true;
              setTidyRev((rev) => rev + 1);
            }}
          />
        ) : null}
        {layout !== null && size.w > 0 ? (
          <Minimap
            layout={layout}
            cameraStore={cameraStore}
            viewport={size}
            selectedKey={selectedKey}
            criticalKeys={criticalKeys}
            onCenter={onCenter}
            onPan={onPan}
          />
        ) : null}
      </div>
    </div>
  );
}
```

`CanvasView` writes the camera only to the viewport element's custom properties (`--tv-tx`, `--tv-ty`, `--tv-k`, `--tv-inv-k`), which the world layer and the overlay both read, so a camera frame costs one style write and no React render.

- [ ] **Step 11: Run the view tests to verify they pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/canvas/canvas-view.test.tsx src/ui/views/canvas/canvas-port.test.ts`
Expected: PASS, `Tests  12 passed (12)`. If the Live test ends at a different `tx`, print `cameraVars` after each step: a controller that clamps `set()` to content must still accept −464 (content right edge at 552 inside a 600 px viewport); a mismatch there is a C1-6 clamp bug to escalate.

- [ ] **Step 12: Typecheck, lint and root checks**

Run: `pnpm --filter @jevcode/trace-viewer typecheck && pnpm lint`, then the root checks. Expected: all exit 0.

- [ ] **Step 13: Commit**

```bash
git add packages/trace-viewer/src/test-support/canvas-view-harness.tsx packages/trace-viewer/src/ui/views/canvas/canvas-port.ts packages/trace-viewer/src/ui/views/canvas/canvas-port.test.ts packages/trace-viewer/src/ui/views/canvas/CanvasRuler.tsx packages/trace-viewer/src/ui/views/canvas/CanvasView.tsx packages/trace-viewer/src/ui/views/canvas/CanvasView.module.css packages/trace-viewer/src/ui/views/canvas/canvas-view.test.tsx
git commit -m "feat(trace-viewer): Canvas view with sticky layout, live follow and view port"
```

### Task C3-11: View switch: register Canvas, `<Activity>` restore rules, switch tests

**Files:**
- Modify: `packages/trace-viewer/src/ui/views/registry.ts`
- Create: `packages/trace-viewer/src/ui/views/view-switch.test.tsx`

**Interfaces:**
- Consumes: C2-14 `registry.ts` (`ViewProps`, `ViewDefinition { kind; label; icon; Component }`, `VIEWS`, `KEEP_HIDDEN_VIEWS_MOUNTED`); C3-10 `CanvasView`, harness; C2-3 `TraceViewer({ source, host?, location?, pollMs? })`, `ViewerHost.onLocation`; C1-15 `createStaticBundleSource(bundle, options?)`; C1-12 `useView`, `ViewerLocation`; C1-11 `ViewState`, `initialViewState`; C3-2 `oauthCanvasSession`, `oauthCanvasBundle`, `buildCanvasSession`.
- Produces: `VIEWS` in switch order Canvas | Hybrid (`{ kind: "canvas", label: "Canvas", icon: "view-canvas", Component: CanvasView }` first). No new exports.

- [ ] **Step 1: Write the failing switch tests**

Create `packages/trace-viewer/src/ui/views/view-switch.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Activity } from "react";
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LEVEL_SPECS } from "../../layout/canvas-levels.js";
import { createStaticBundleSource } from "../../sources/static-bundle.js";
import { buildCanvasSession, oauthCanvasBundle, oauthCanvasSession } from "../../test-support/canvas-arbitraries.js";
import {
  cameraVars,
  canvasViewport,
  renderWithViewer,
  stubAnimationFrames,
  stubElementBox,
  stubReducedMotion,
  stubResizeObserver,
} from "../../test-support/canvas-view-harness.js";
import { TraceViewer } from "../shell/TraceViewer.js";
import type { ViewerLocation } from "../state/location.js";
import { useView } from "../state/store.js";
import { initialViewState, type ViewState } from "../state/view-state.js";
import { KEEP_HIDDEN_VIEWS_MOUNTED, VIEWS } from "./registry.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The real Canvas from VIEWS beside an inert Hybrid stand-in, so listener and rAF counts belong to the Canvas. */
function Switcher(): React.JSX.Element {
  const view = useView((state) => state.view);
  const canvas = VIEWS.find((definition) => definition.kind === "canvas");
  if (canvas === undefined) throw new Error("Canvas is not registered");
  const Canvas = canvas.Component;
  const hybrid = <section aria-label="Hybrid stand-in" />;
  if (!KEEP_HIDDEN_VIEWS_MOUNTED) {
    return view === "canvas" ? <Canvas active /> : hybrid;
  }
  return (
    <>
      <Activity mode={view === "canvas" ? "visible" : "hidden"}>
        <Canvas active={view === "canvas"} />
      </Activity>
      <Activity mode={view === "hybrid" ? "visible" : "hidden"}>{hybrid}</Activity>
    </>
  );
}

function withoutCameras(state: ViewState): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...state };
  delete copy.cameras;
  return copy;
}

const SYNCED = initialViewState({ live: false }).focusRev;

describe("view registry", () => {
  it("registers Canvas before Hybrid", () => {
    expect(VIEWS.map((definition) => [definition.kind, definition.label, definition.icon])).toEqual([
      ["canvas", "Canvas", "view-canvas"],
      ["hybrid", "Hybrid", "view-hybrid"],
    ]);
  });
});

describe("switching views under <Activity>", () => {
  it("1, 2, 1 leaves every non-camera field unchanged and restores the canvas camera exactly", () => {
    stubElementBox(900, 600);
    stubResizeObserver();
    const frames = stubAnimationFrames();
    stubReducedMotion(true);
    const harness = renderWithViewer(<Switcher />, {
      session: oauthCanvasSession(),
      state: { view: "canvas", cameras: { canvas: { mode: "uniform", tx: -120, ty: 30, k: 0.8, syncedRev: SYNCED }, hybrid: null } },
    });
    act(() => frames.flush());
    const before = cameraVars(canvasViewport());
    expect(before).toEqual({ tx: "-120px", ty: "30px", k: "0.8" });
    const start = withoutCameras(harness.store.get());
    act(() => harness.store.dispatch({ type: "view/switch", view: "hybrid" }));
    act(() => harness.store.dispatch({ type: "view/switch", view: "canvas" }));
    act(() => frames.flush());
    expect(cameraVars(canvasViewport())).toEqual(before);
    expect(withoutCameras(harness.store.get())).toEqual(start);
  });

  it("refits the brush horizontally within [minZoom, 1.5] and keeps ty when focus changed while hidden", () => {
    stubElementBox(900, 600);
    stubResizeObserver();
    const frames = stubAnimationFrames();
    stubReducedMotion(true);
    const session = oauthCanvasSession();
    const harness = renderWithViewer(<Switcher />, {
      session,
      state: { view: "canvas", cameras: { canvas: { mode: "uniform", tx: -120, ty: 30, k: 0.8, syncedRev: SYNCED }, hybrid: null } },
    });
    act(() => frames.flush());
    act(() => harness.store.dispatch({ type: "view/switch", view: "hybrid" }));
    act(() => harness.store.dispatch({ type: "select", id: "unit:oauth-linking-test-failure", by: "shell" }));
    act(() => harness.store.dispatch({ type: "view/switch", view: "canvas" }));
    act(() => frames.flush());
    const after = cameraVars(canvasViewport());
    const k = Number(after.k);
    expect(k).toBeGreaterThanOrEqual(LEVEL_SPECS.chapter.minZoom);
    expect(k).toBeLessThanOrEqual(1.5);
    // Spec §7.8 item 3: the brush (whole session, 1016 px) fits horizontally: k = (900 − 2 · 48) / 1016.
    expect(k).toBeCloseTo((900 - 96) / 1016, 6);
    expect(after.ty).toBe("30px");
  });

  it("never fits a 0x0 rect", () => {
    const observers = stubResizeObserver();
    const frames = stubAnimationFrames();
    stubReducedMotion(true);
    renderWithViewer(<Switcher />, { session: oauthCanvasSession(), state: { view: "canvas" } });
    act(() => frames.flush());
    // jsdom lays nothing out: the viewport is 0 × 0, so the default camera stays and no fit runs.
    expect(cameraVars(canvasViewport())).toEqual({ tx: "48px", ty: "48px", k: "1" });
    act(() => observers.resize(0, 600));
    act(() => frames.flush());
    expect(cameraVars(canvasViewport())).toEqual({ tx: "48px", ty: "48px", k: "1" });
    act(() => observers.resize(900, 600));
    act(() => frames.flush());
    expect(Number(cameraVars(canvasViewport()).k)).toBeCloseTo((900 - 96) / 1016, 6);
  });

  it("a hidden view holds no listeners and schedules no animation frames", () => {
    stubElementBox(900, 600);
    const observers = stubResizeObserver();
    const frames = stubAnimationFrames();
    stubReducedMotion(true);
    const add = vi.spyOn(EventTarget.prototype, "addEventListener");
    const remove = vi.spyOn(EventTarget.prototype, "removeEventListener");
    const early = buildCanvasSession([{ atMs: 8_000, kind: "plan" }, { atMs: 10_000, kind: "chapter" }], { live: true });
    const later = buildCanvasSession(
      [{ atMs: 8_000, kind: "plan" }, { atMs: 10_000, kind: "chapter" }, { atMs: 25_000, kind: "decision" }],
      { live: true },
    );
    const harness = renderWithViewer(<Switcher />, { session: early, state: { view: "canvas" } });
    act(() => frames.flush());
    const viewport = canvasViewport();
    const net = (): number =>
      add.mock.calls.filter((call, i) => call[0] === "wheel" && add.mock.contexts[i] === viewport).length -
      remove.mock.calls.filter((call, i) => call[0] === "wheel" && remove.mock.contexts[i] === viewport).length;
    expect(net()).toBe(1);
    act(() => harness.store.dispatch({ type: "view/switch", view: "hybrid" }));
    expect(net()).toBe(0);
    expect(observers.count()).toBe(0);
    const callsWhileHidden = frames.calls();
    act(() => harness.setSession(later));
    act(() => frames.flush());
    expect(frames.calls()).toBe(callsWhileHidden);
  });
});

describe("switching views in TraceViewer", () => {
  it(
    "1, 2, 1 on the keyboard restores the canvas camera and carries the location",
    async () => {
      stubElementBox(1000, 700);
      stubResizeObserver();
      stubReducedMotion(true);
      const bundle = oauthCanvasBundle();
      const locations: ViewerLocation[] = [];
      render(
        <TraceViewer
          source={createStaticBundleSource(bundle)}
          host={{ onLocation: (location) => locations.push(location) }}
          location={{ v: 1, sessionId: bundle.session.sessionId, view: "hybrid", level: "chapter", brush: { kind: "session" } }}
          pollMs={60_000}
        />,
      );
      await waitFor(() => expect(locations.at(-1)?.selected).toBeDefined(), { timeout: 5_000 });
      const user = userEvent.setup();
      screen.getByRole("main").querySelector<HTMLElement>('[tabindex="0"]')?.focus();
      await user.keyboard("1");
      await screen.findByRole("group", { name: /^OAuth account-linking test failure/ });
      await waitFor(() => expect(canvasViewport().style.getPropertyValue("--tv-k")).not.toBe("1"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      const shown = cameraVars(canvasViewport());
      const canvasLocation = locations.at(-1);
      expect(canvasLocation?.view).toBe("canvas");
      await user.keyboard("2");
      await waitFor(() => expect(locations.at(-1)?.view).toBe("hybrid"));
      await user.keyboard("1");
      await waitFor(() => expect(locations.at(-1)?.view).toBe("canvas"));
      expect(cameraVars(canvasViewport())).toEqual(shown);
      expect(locations.at(-1)).toEqual(canvasLocation);
    },
    15_000,
  );
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/view-switch.test.tsx`
Expected: FAIL; "registers Canvas before Hybrid" reports `[["hybrid", "Hybrid", "view-hybrid"]]`, and the Switcher tests throw `Canvas is not registered`.

- [ ] **Step 3: Register the Canvas view**

In `packages/trace-viewer/src/ui/views/registry.ts` (C2-14), add next to the `HybridView` import:

```ts
import { CanvasView } from "./canvas/CanvasView.js";
```

and make the Canvas entry the first element of `VIEWS`. After the edit the array reads:

```ts
export const VIEWS: readonly ViewDefinition[] = [
  { kind: "canvas", label: "Canvas", icon: "view-canvas", Component: CanvasView },
  { kind: "hybrid", label: "Hybrid", icon: "view-hybrid", Component: HybridView },
];
```

Keep the Hybrid entry exactly as C2-14 wrote it (its label and icon come from UI index §2.4). Leave `KEEP_HIDDEN_VIEWS_MOUNTED` as C3-5 left it; the `Switcher` above honors both values, and the Shell's `ViewSlot` (C2-3) already reads it. The title bar's view switch appears now that `VIEWS.length > 1` (C2-4).

- [ ] **Step 4: Run the switch tests to verify they pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/view-switch.test.tsx`
Expected: PASS, `Tests  6 passed (6)`. If only the TraceViewer test fails, run it alone with `-t "on the keyboard"` and read which wait timed out: a missing `selected` means the initial-selection default (C2-3/C1-11) did not run; a missing canvas group means the KeyboardLayer (C2-8) did not dispatch `view/switch` for `Digit1` from focus in `main`; a camera difference after `1, 2, 1` is this lane's bug (hide must stamp `camera/sync`, show must restore when `syncedRev === focusRev`).

- [ ] **Step 5: Run the whole package suite**

Run: `pnpm --filter @jevcode/trace-viewer test`
Expected: exits 0; C2's Shell, TitleBar and keyboard suites still pass with two registered views (the view switch now renders).

- [ ] **Step 6: Typecheck, lint and root checks**

Run: `pnpm --filter @jevcode/trace-viewer typecheck && pnpm lint`, then the root checks. Expected: all exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/trace-viewer/src/ui/views/registry.ts packages/trace-viewer/src/ui/views/view-switch.test.tsx
git commit -m "feat(trace-viewer): register the Canvas view and pin the view-switch contract"
```

### Task C3-12: Canvas smoke and selftest; M4b exit

**Files:**
- Create: `apps/trace-viewer-dev/src/selftest-canvas.ts`
- Modify: `apps/trace-viewer-dev/src/selftest.ts` (C2-15)
- Modify: `apps/trace-viewer-dev/src/main.tsx` (C2-15; only the selftest mode gate, see Step 4)
- Modify: `apps/trace-viewer-dev/scripts/smoke.mjs` (C2-16)
- Modify: `docs/spikes/trace-viewer-spike.md` (append "M4b exit (C3-12)")

**Interfaces:**
- Consumes: C2-15 `SelftestResult { ready; view; selectedTitle; errors; cspViolations; maxDriftPx; rows }` and `<pre id="selftest">`; C2-16 `smoke.mjs [--views hybrid|hybrid,canvas] [--skip-build]` (screenshots `<view>-<w>.png`, per-view `?selftest=drip` checks, `SMOKE_OK <n> screenshots` / `SMOKE_FAIL: <reason>`); DOM hooks from this lane: `[data-tv-viewport="canvas"]`, `[role="group"][data-key]`, the camera custom properties.
- Produces:

```ts
// apps/trace-viewer-dev/src/selftest-canvas.ts
export function canvasViewport(): HTMLElement | null;
export interface CanvasDriftProbe { sample(): void; stop(): number }
/** Samples the frame nearest the viewport center every intervalMs; stop() returns the largest move in px. */
export function startCanvasDriftProbe(intervalMs?: number): CanvasDriftProbe;
export interface SwitchSelftestResult { switches: number; misses: number; details: string[] }
/** Spec §10 "View switch": presses 1/2 `count` times; each Canvas show must paint its saved camera, with a non-zero main rect. */
export function runSwitchSelftest(count?: number): Promise<SwitchSelftestResult>;
/** ?selftest=switch: waits for the Canvas, runs runSwitchSelftest and writes JSON into <pre id="selftest">. */
export function writeSwitchSelftest(timeoutMs?: number): Promise<void>;
```

- [ ] **Step 1: Read the three dev-host files this task edits**

Run:

```bash
grep -nE "selftest|maxDriftPx|SelftestResult|onDiagnostics|onReady|const finish" apps/trace-viewer-dev/src/selftest.ts apps/trace-viewer-dev/src/host.tsx apps/trace-viewer-dev/src/main.tsx
grep -nE "views|selftest|screenshot|SMOKE_OK|SMOKE_FAIL|function " apps/trace-viewer-dev/scripts/smoke.mjs
```

Expected (C2-15 and C2-16 as merged in W2): `selftest.ts` builds a `SelftestResult` with a `maxDriftPx` field inside `createSelftest`, sets `result.ready = true` in `onReady` and writes the result in `const finish`; `host.tsx` (not `main.tsx`) reads the `selftest` query parameter and mounts `<TraceViewer>`; `main.tsx` only renders `<DevHost search={window.location.search} hash={window.location.hash} />`; `smoke.mjs` has the helpers `chrome(profile, args)`, `locationHash(sessionId, view)` and `readSelftest(html)`, loops over the `--views` list and prints `SMOKE_OK`. Steps 3–5 quote the exact C2-15/C2-16 anchors; if one is missing, stop and escalate.

- [ ] **Step 2: Write the Canvas selftest helpers**

Create `apps/trace-viewer-dev/src/selftest-canvas.ts`:

```ts
// Canvas checks for the dev-host selftest (C3-12). They read only the DOM, so they run against the built viewer.

export function canvasViewport(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-tv-viewport="canvas"]');
}

function hasArea(element: Element): boolean {
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
}

export interface CanvasDriftProbe {
  sample(): void;
  stop(): number;
}

export function startCanvasDriftProbe(intervalMs = 50): CanvasDriftProbe {
  let anchor: { key: string; left: number; top: number } | null = null;
  let max = 0;
  const sample = (): void => {
    const viewport = canvasViewport();
    if (viewport === null || !hasArea(viewport)) {
      anchor = null;
      return;
    }
    const frames = [...viewport.querySelectorAll<HTMLElement>('[role="group"][data-key]')];
    if (anchor !== null) {
      const key = anchor.key;
      const same = frames.find((frame) => frame.dataset.key === key);
      if (same !== undefined) {
        const box = same.getBoundingClientRect();
        max = Math.max(max, Math.abs(box.left - anchor.left), Math.abs(box.top - anchor.top));
      }
    }
    const view = viewport.getBoundingClientRect();
    const cx = view.left + view.width / 2;
    const cy = view.top + view.height / 2;
    let best: { key: string; left: number; top: number } | null = null;
    let bestDistance = Infinity;
    for (const frame of frames) {
      const box = frame.getBoundingClientRect();
      const distance = Math.hypot(box.left + box.width / 2 - cx, box.top + box.height / 2 - cy);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { key: frame.dataset.key ?? "", left: box.left, top: box.top };
      }
    }
    anchor = best;
  };
  const timer = window.setInterval(sample, intervalMs);
  return {
    sample,
    stop: () => {
      window.clearInterval(timer);
      sample();
      return max;
    },
  };
}

export interface SwitchSelftestResult {
  switches: number;
  misses: number;
  details: string[];
}

/** Resolves after the next frame has been painted (spec §10 paint mark: rAF, then a MessageChannel post). */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve();
      channel.port2.postMessage(null);
    });
  });
}

function press(target: HTMLElement, digit: "1" | "2"): void {
  const init = { key: digit, code: `Digit${digit}`, bubbles: true, cancelable: true };
  target.dispatchEvent(new KeyboardEvent("keydown", init));
  target.dispatchEvent(new KeyboardEvent("keyup", init));
}

function cameraOf(viewport: HTMLElement): string {
  return ["--tv-tx", "--tv-ty", "--tv-k"].map((name) => viewport.style.getPropertyValue(name)).join(" ");
}

export async function runSwitchSelftest(count = 20): Promise<SwitchSelftestResult> {
  const main = document.querySelector<HTMLElement>("main");
  if (main === null) return { switches: 0, misses: 1, details: ["no main landmark"] };
  const details: string[] = [];
  let misses = 0;
  let saved: string | null = null;
  for (let i = 0; i < count; i += 1) {
    const toCanvas = i % 2 === 0;
    const active = document.activeElement;
    const target =
      active instanceof HTMLElement && main.contains(active) ? active : (main.querySelector<HTMLElement>('[tabindex="0"]') ?? main);
    if (!toCanvas) {
      const viewport = canvasViewport();
      saved = viewport === null ? null : cameraOf(viewport);
    }
    press(target, toCanvas ? "1" : "2");
    await nextPaint();
    if (!hasArea(main)) {
      misses += 1;
      details.push(`switch ${i + 1}: main is 0 x 0`);
      continue;
    }
    if (toCanvas && saved !== null) {
      const viewport = canvasViewport();
      const now = viewport === null ? "missing" : cameraOf(viewport);
      if (now !== saved) {
        misses += 1;
        details.push(`switch ${i + 1}: camera ${now} != ${saved}`);
      }
    }
  }
  return { switches: count, misses, details };
}

export async function writeSwitchSelftest(timeoutMs = 8_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (canvasViewport() === null || document.querySelector('main [tabindex="0"]') === null) {
    if (performance.now() > deadline) break;
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  const result = await runSwitchSelftest();
  let pre = document.querySelector<HTMLPreElement>("pre#selftest");
  if (pre === null) {
    pre = document.createElement("pre");
    pre.id = "selftest";
    pre.hidden = true;
    document.body.append(pre);
  }
  pre.textContent = JSON.stringify(result);
}
```

- [ ] **Step 3: Fold the Canvas drift into the drip selftest**

In `apps/trace-viewer-dev/src/selftest.ts` (C2-15), find:

```ts
import type { DripOptions, StaticBundleSource, ViewerHost } from "@jevcode/trace-viewer";
```

Replace with:

```ts
import type { DripOptions, StaticBundleSource, ViewerHost } from "@jevcode/trace-viewer";

import { startCanvasDriftProbe, type CanvasDriftProbe } from "./selftest-canvas.js";
```

Find:

```ts
  const originalError = console.error;
  let timer: ReturnType<typeof setInterval> | null = null;
  let written = false;
```

Replace with:

```ts
  const originalError = console.error;
  let timer: ReturnType<typeof setInterval> | null = null;
  let written = false;
  // C3-12: samples the Canvas frame nearest the viewport center; stays 0 while the Canvas is hidden.
  let canvasDrift: CanvasDriftProbe | null = null;
```

Find:

```ts
    result.rows = options.source.released();
    options.write({ ...result, errors: [...result.errors], cspViolations: [...result.cspViolations] });
```

Replace with:

```ts
    result.rows = options.source.released();
    if (canvasDrift !== null) {
      result.maxDriftPx = Math.max(result.maxDriftPx, canvasDrift.stop());
      canvasDrift = null;
    }
    options.write({ ...result, errors: [...result.errors], cspViolations: [...result.cspViolations] });
```

Find:

```ts
      onReady: () => {
        result.ready = true;
        requestAnimationFrame(scrollSpineToMiddle);
      },
```

Replace with:

```ts
      onReady: () => {
        result.ready = true;
        requestAnimationFrame(scrollSpineToMiddle);
        canvasDrift ??= startCanvasDriftProbe();
      },
```

Find (inside `stop()`):

```ts
      console.error = originalError;
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
```

Replace with:

```ts
      console.error = originalError;
      if (timer !== null) clearInterval(timer);
      timer = null;
      canvasDrift?.stop();
      canvasDrift = null;
    },
```

The probe returns 0 while the Canvas is hidden, so the Hybrid run is unchanged.

- [ ] **Step 4: Add the `switch` selftest mode**

`host.tsx` treats only `selftest=drip` as the drip selftest, so `?selftest=switch` mounts the viewer normally at the hash's view; the switch check runs beside it from the entry. Replace the whole of `apps/trace-viewer-dev/src/main.tsx` (C2-15's version renders `<DevHost search={window.location.search} hash={window.location.hash} />` and nothing else) with:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { DevHost } from "./host.js";
import { writeSwitchSelftest } from "./selftest-canvas.js";

const root = document.getElementById("root");
if (root === null) throw new Error("dev host: #root is missing");

createRoot(root).render(
  <StrictMode>
    <DevHost search={window.location.search} hash={window.location.hash} />
  </StrictMode>,
);

// C3-12 (spec §10 "View switch"): waits for the Canvas, presses 1/2 twenty times, writes <pre id="selftest">.
if (new URLSearchParams(window.location.search).get("selftest") === "switch") void writeSwitchSelftest();
```

Run: `pnpm --filter jevcode-trace-viewer-dev typecheck`
Expected: exit 0.

- [ ] **Step 5: Check the view switch in the smoke**

In `apps/trace-viewer-dev/scripts/smoke.mjs` (C2-16), find the end of the per-view loop:

```js
      console.log(`${view}: selftest ok (rows ${result.rows}, max drift ${result.maxDriftPx}px)`);
    }
    console.log(`SMOKE_OK ${shots} screenshots`);
```

Replace with:

```js
      console.log(`${view}: selftest ok (rows ${result.rows}, max drift ${result.maxDriftPx}px)`);
    }
    if (options.views.includes("canvas")) {
      // C3-12 (spec §10 "View switch"): 20 presses of 1/2 must restore the Canvas camera in the switch's frame.
      const html = chrome(profile, [
        "--window-size=1440,900",
        "--dump-dom",
        "--virtual-time-budget=10000",
        `${ORIGIN}/?bundle=oauth&selftest=switch${locationHash(sessionId, "canvas")}`,
      ]);
      const switchResult = readSelftest(html);
      if (switchResult.switches !== 20 || switchResult.misses !== 0) {
        throw new Error(
          `view switch missed ${switchResult.misses} of ${switchResult.switches}: ${switchResult.details.join("; ")}`,
        );
      }
      console.log(`view switch: ${switchResult.switches} switches, 0 misses`);
    }
    console.log(`SMOKE_OK ${shots} screenshots`);
```

A thrown error reaches the script's `main().catch`, which prints `SMOKE_FAIL: <reason>` and sets exit code 1. The loop's own per-view steps already produce `canvas-1440.png`, `canvas-1000.png` and the Canvas `?selftest=drip` check, because the hash carries the view name (UI index §2.5).

- [ ] **Step 6: Build and run both smokes**

Run:

```bash
pnpm -r build
pnpm --filter jevcode-desktop rebuild:node
node apps/trace-viewer-dev/scripts/smoke.mjs --views hybrid,canvas --skip-build
```

Expected: the last line is `SMOKE_OK 4 screenshots`, and `apps/trace-viewer-dev/.smoke/` holds `hybrid-1440.png`, `hybrid-1000.png`, `canvas-1440.png` and `canvas-1000.png`. On `SMOKE_FAIL`, the reason names the failing check (selected title, errors, CSP violations, drift, or view switch); fix the cause in this lane's code and rerun.

- [ ] **Step 7: Compare the Canvas screenshots with the approved mockup**

Open `apps/trace-viewer-dev/.smoke/canvas-1440.png` and `docs/superpowers/specs/2026-09-28-trace-viewer-mockups/canvas-1440.png` side by side (the Read tool shows PNGs). Expected, per spec §7.2 and §7.5: four columns (Intent; Plan over Dependency, Identity layer, Migration and `Noise ×2`; Decision over Linking policy and Linking test; Final claim), the trunk along y ≈ 124, the red `≠` connector with the word "contradicts" between Linking test and Final claim, the floating toolbar without a comment tool, the minimap at the bottom right, and "Claim contradicts tests" selected in the Inspector. The listed deviations (Plan beside Intent, the trunk comb instead of the fan, "expected null to be 7") are expected. Record anything else as a finding in Step 9's section.

- [ ] **Step 8: Measure the Canvas pinch budget (HUMAN CHECK: 60 Hz display)**

The controller asks the user to set the display to 60 Hz (ProMotion off) and to confirm, then runs the spike harness's risk 2 sweep exactly as the spike doc's "How to run" section (C1-7) records, from this worktree:

```bash
pnpm --filter jevcode-desktop run rebuild
pnpm --filter jevcode-trace-viewer-dev exec vite build --config vite.spike.config.ts
pnpm --filter jevcode-desktop exec electron ~/Projects/jevcode-tv-c3b/apps/trace-viewer-dev/scripts/spike-electron.cjs
pnpm --filter jevcode-desktop rebuild:node
```

Expected: the harness prints the risk 2 row (rounded rAF-interval p95 and the share of dropped frames during the 0.35 → 2 sweep at Step level); the budget passes at ≤ 5% dropped (spec §10). The last command prints `native modules restored to node ABI`.

- [ ] **Step 9: Append the M4b exit section**

Append to `docs/spikes/trace-viewer-spike.md`, filling each value from the step named in its Evidence cell:

```markdown
## M4b exit (C3-12)

Date: <YYYY-MM-DD>. Reference machine: as named in the M4a exit section.

| Criterion (spec §12 M4b) | Result | Evidence |
|---|---|---|
| Spike risks 2, 3, 6, 7 pass or ruled | <from "M4b gate (C3-5)"> | this doc, "M4b gate (C3-5)" |
| oauth in Canvas matches the spec §7.5 table | pass | `canvas-layout.test.ts` "matches the spec §7.5 table from a fresh layout" (C3-2) |
| Switch tests pass | pass | `view-switch.test.tsx` (C3-11) |
| Both smokes green | `SMOKE_OK 4 screenshots` | Step 6 |
| View switch restored in the toggle's frame; never a 0 × 0 fit | <switches> switches, <misses> misses | Step 6, `?selftest=switch` |
| Canvas pinch at Step level ≤ 5% frames dropped (Electron 33, 60 Hz) | <p95 interval>, <dropped %> | Step 8 |
| `layoutCanvas` fresh ≤ 2 ms / sticky ≤ 0.5 ms (benchmark, not a gate) | <fresh> / <sticky> | C3-4 commit message |
| Canvas anchor drift ≤ 1 px (smoke) | <maxDriftPx> | Step 6, Canvas `?selftest=drip` |

Screenshots: `apps/trace-viewer-dev/.smoke/canvas-1440.png`, `apps/trace-viewer-dev/.smoke/canvas-1000.png`. Mockup comparison: <Step 7 findings, or "matches, with the spec §7.2 deviations only">.
```

A missed milestone budget blocks the M4b exit (spec §10 "Method"): stop and escalate with the measured value instead of merging. A missed benchmark budget is recorded with a follow-up note and does not block.

- [ ] **Step 10: Root checks**

Run the root checks. Expected: each exits 0.

- [ ] **Step 11: Commit**

```bash
git add apps/trace-viewer-dev/src/selftest-canvas.ts apps/trace-viewer-dev/src/selftest.ts apps/trace-viewer-dev/src/main.tsx apps/trace-viewer-dev/scripts/smoke.mjs docs/spikes/trace-viewer-spike.md
git commit -m "chore(trace-viewer-dev): canvas smoke, view-switch selftest and the M4b exit"
```

### Part B completion (lane C3b)

- [ ] **Merge.** On `tv/c3b-canvas-view`, run `git rebase main` (or `git merge main`), then `pnpm install --frozen-lockfile && pnpm -r build`, then the root checks and `node apps/trace-viewer-dev/scripts/smoke.mjs --views hybrid,canvas`. Merge to `main` before Db (UI index §4, W3 order: C3b (M4b) → Db (M5)). Never `git stash`; commit WIP instead.
- [ ] **Exit criteria (spec §12 M4b), all recorded in the spike doc's "M4b exit" section:** spike risks 2, 3, 6, 7 pass or ruled (C3-5); oauth in Canvas matches the §7.5 table (C3-2); switch tests pass (C3-11); both smokes green (C3-12); M4b budgets met (pinch ≤ 5% dropped, view switch zero misses); `pnpm -r typecheck`, `pnpm -r test` and `pnpm lint` green.
