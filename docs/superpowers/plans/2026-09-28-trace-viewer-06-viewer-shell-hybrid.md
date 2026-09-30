# Trace Viewer Lane C2: Viewer Shell and Hybrid View (M4a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship milestone M4a: a usable, read-only trace viewer in the Vite dev host that opens oauth in the Hybrid view with the contradiction at +0:43 selected and expanded, loads progressively, follows a live drip, and passes the Hybrid visual smoke.

**Architecture:** `<TraceViewer>` creates one `DataController` (paging, ≤ 4 commits per second, 1 s poll, backoff, gesture hold) and one view store, then mounts the `Shell`: a 40 px title bar, the Outline (`nav`), a view slot (`main`) and the Inspector (`aside`), each inside its own error boundary. The Hybrid view composes a 288 px lane overview (one DPR-scaled Canvas2D painted by the pure `paint.ts`, plus at most 150 DOM nodes for labels, pins, brush and playhead sliders) over a virtualized reading spine (`@tanstack/react-virtual` with keyed end-anchoring). Every geometric decision comes from the pure `layout/*` modules built in W1 (C1b); this lane only renders them, wires input, and proves the whole path with jsdom tests and one headless-Chrome smoke.

**Tech Stack:** TypeScript 5.9 (NodeNext in the package, Bundler in the dev host, strict, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `noUnusedLocals`), React 19.2.3 (`<Activity>`, `useSyncExternalStore`, `startTransition`), CSS Modules, `@tanstack/react-virtual` 3.14.13 (virtual-core 3.17.11), `@jevcode/ui-catalog` `CodeDiff` (diff2html 3.4.56), vitest 3.2 + jsdom 30.1.0 + `@testing-library/react` 16.3.3 + `@testing-library/user-event` 14.6.7, Vite 5.4, headless Google Chrome for the smoke.

**Spec:** `docs/superpowers/specs/2026-09-28-trace-viewer-design.md` §7 (Viewer UI: 7.1 Shell, 7.2 Views, 7.3 Rendering, 7.6 Hybrid, 7.8 Store, 7.9 Keyboard, 7.10 Live, 7.11 States, 7.12 Visual system, 7.13 Accessibility), §8 only where the M4a code must already serve M5 (`ViewerHost`, `requestChanges`, CSP), §10 budgets, §11 tests, §12 M4a exit and §16 spike. Cross-lane contract: `docs/superpowers/plans/2026-09-28-trace-viewer-interfaces-ui.md` (C2 task table §3, names and types §2) and `docs/superpowers/plans/2026-09-28-trace-viewer-interfaces.md` (W0/B names, §5 gotchas). Binding record: `/private/tmp/claude-501/-Users-jwpark-Projects-jevcode/af01125e-e02e-4dbc-9196-45e1be6cf15a/scratchpad/decisions.md` (R13–R29). Visual target: `docs/superpowers/specs/2026-09-28-trace-viewer-mockups/hybrid.html` and `hybrid-1440.png`. On any conflict: decision record, then spec, then the base index, then the UI index, then this file.

## Required W0 amendments

None beyond the UI index. This lane adds no dependency and edits no `package.json`, `exports` map, `pnpm-lock.yaml` or `eslint.config.mjs`. It depends on these UI-index amendments having landed (the "Lane prerequisites" block verifies each one):

- UI index §1.1 (a) `@jevcode/trace-viewer` deps without `@xyflow/react`, with `@tanstack/react-virtual` 3.14.13 and the `./sources` export; (b) `@jevcode/ui-catalog` `"./components/*"` export; (c) `assetsInlineLimit: 0` in `apps/trace-viewer-dev/vite.config.ts`; (d) the `src/layout` ESLint block.
- UI index §1.2 (a) model type insertions (`LEVELS`, `CommandDetail.outputTail`, `DecisionDetail.answerSeq`, `Step.startMs`, `Turn.claimStepId`/`planStepId`, `Chapter.noise`/`current`/`validationStepIds`/`triad.clientKind`, `Finding.anchorStepId`/`claimStepId`/`evidenceStepIds`/`claimSpan`, `TraceSession.originMs`, amended `GraphicSpec`); (b) the session-bound `TraceSource` (`sessionId`, `summary()`, `rows(request?)`, `payloads(seqs)`, `now()`).
- UI index §1.4 B-1 (`normalizeCommand`, `exitLabel`, `displayUntrusted`), B-3 (`FinalizeOptions.nowMs`, `CommandDetail.outputTail`, `originMs`), B-5, B-6, B-7 (`compareFindings`, `FINDING_RULE_RANK`), B-10 (`pickGraphic`, `describeGraphic` in `format.ts`).

**Found while writing this lane (2026-09-28, for the amend step, not new asks):** the lane files as written today do not yet carry all of those amendments. `2026-09-28-trace-viewer-01-contracts-foundation.md` has no `LEVELS`, no `originMs` and still the three-method `TraceSource`. `2026-09-28-trace-viewer-04-trace-model.md` has no `originMs`, `outputTail`, `FinalizeOptions.nowMs`, `compareFindings`, `FINDING_RULE_RANK` or `displayUntrusted`; it says "Not in lane B: `exitLabel`" (UI index B-1 puts it in B); it names the claim matcher `successClaimSpan` (UI index B-6 says `matchSuccessClaim`; C2 does not call either); and its `GraphicSpec` `duration` member is still `{startMs, endMs, spanStartMs, spanEndMs, status}`. C2 cannot start until the amend step lands them; Task C2-0's gate re-checks.

## Interface deviations

Each item below differs from the UI index §2.4/§3 text. None renames or removes a contract name; items 2–6 add optional fields, exports or files.

1. **Lane file name.** The orchestrator asked for `docs/superpowers/plans/2026-09-28-trace-viewer-06-viewer-shell-hybrid.md`; UI index §0 lists `…-06-shell-hybrid.md`. The index row should point here.
2. **`ui/shell/Shell.tsx` is also edited by C2-4, C2-5, C2-6, C2-8 and C2-14**, `ui/shell/Shell.module.css` also by C2-8 (shortcut sheet styles), and `ui/inspector/Inspector.tsx` also by C2-7. The index lists each file under one task only, but the Shell must exist (C2-3) before the regions it mounts, and the Inspector before its Evidence and Raw tabs. Each later task changes one quoted anchor; the edits run in task order inside this lane, so no parallel conflict exists.
3. **New test-only file `packages/trace-viewer/src/test-support/ui-harness.tsx` (C2-3).** It holds the cached fixture folds, the per-test layout stubs (`getBoundingClientRect`, `offsetWidth`/`offsetHeight`, `ResizeObserver`, `scrollTo`, each installed inside one test and restored after it) and a provider wrapper. Every jsdom suite in this lane uses it instead of repeating 80 lines. It sits under `src/test-support/**`, which W0 already excludes from the build and the lint blocks.
4. **`ViewProps`, `ViewDefinition` and a new `ViewDefinitionsContext` live in `ui/views/view-port.ts` (C2-3)**; `ui/views/registry.ts` (C2-14) re-exports the two types, so `import type { ViewDefinition } from "../views/registry.js"` still works. The Shell, `ViewSlot` and `TitleBar` need the types seven tasks before the registry exists. `ViewPortRegistry` gains `version(): number` so the title bar re-renders when a view calls `notify()`.
5. **Additive fields and exports:** `DataSnapshot.rows` (rows received; feeds `ViewerHost.onReady`), `DataController.now()` (the source clock for `nowT()` and `liveTMs`), `isTerminalState`, `isLiveState` (data-controller.ts); `ShellProps.location?`, `ShellProps.initialFollow?` and `TraceViewerProps.initialFollow?` (the selftest must drip "in Review", spec §11, although a dripping source reports `running`); `DiagnosticsContext`, `LiveRegionContext`/`useAnnounce`, `useActiveViewPort`, `useViewPortRegistry`; `FindingBodyContext`/`FindingBodyProps`/`SpineApi` in `spine/Spine.tsx` (C2-13 builds the bodies after C2-12 builds the spine; C2-14 provides them, so C2-13 never edits a C2-12 file); `selectionTitle`/`topFindingOf` in `inspector/finding-copy.ts`; `OverviewApi` in `overview/Overview.tsx`; `PINS_PAINTED_ON_CANVAS` in `overview/Pins.tsx` (the spike risk 5 ruling switch). The root barrel also exports `PERF` and `markAfterPaint`: the dev host sets `tv:bundle-parsed` and reads measures for the HUD. `LIVE_TICK_START` (data-controller.ts) and `measureAfterPaint` (perf.ts) record the `PERF.liveTick` measure on every apply after the full load, unconditionally, because lane 08 D-8 reads `tv:live-tick` from the Electron trace window, which has no HUD (lane 08 Required amendment 3).
6. **Outline chapter rows always carry the full description** ("Linking test, 1 failed, 14 passed, +0:33") in their accessible name. UI index C2-5 applies it only under a failed spike risk 4; applying it unconditionally costs nothing and removes a conditional.
7. **Smoke replay paths are absolute.** UI index §2.5 writes `pnpm --filter jevcode-desktop replay fixtures/oauth <tmp>/oauth`, but pnpm runs the script in `apps/desktop`, where `fixtures/oauth` does not exist; `smoke.mjs` passes `<repo>/fixtures/oauth`.
8. **Selftest drip start.** `selftest.ts` starts the drip at the seq of oauth's claim row (found by content, "all checks pass"), falling back to `lastSeq − 20`, so the Review defaults on open select the contradiction while later rows still drip in (spec §10 "Anchor drift" wants appends with a finding above the anchored row). This assumes C1-15's `DripOptions.startAtSeq` releases every row with `seq ≤ startAtSeq` on the first `rows()` call; C2-15 Step 1 checks it.
9. **Dev host drip start and serve alias (C2-15).** `?drip=` takes an optional third part, `startAtSeq`; a negative value counts back from the bundle's last seq (`resolveDrip`, additive), because lane 08 D-8 measures the live tick with `?drip=20,1000,-2000`. The serve-only source alias is a plugin with `apply: "serve"`, not a callback config, so C1-7's `vite.spike.config.ts` can still `mergeConfig` the dev config (Vite 5.4 throws "Cannot merge config in form of callback").
10. **Spec §1 "found at once" (base index gap G1).** `perf.ts` (C2-3) also exports `INITIAL_SELECTION_PAINTED = "tv:initial-selection-painted"` and `markNextFrame(name)`. The Shell calls `markNextFrame(INITIAL_SELECTION_PAINTED)` right after the `session/applied` dispatch that moves the selection from `null` to the open default, so `performance.mark` runs in the first `requestAnimationFrame` after the commit that applies the initial selection (a store dispatch inside a layout effect re-renders synchronously before that frame). The root barrel re-exports the constant. It is not a `PERF` member: `PERF` names the spec §10 measures that the HUD reads and lane 08 greps. The dev host adds `?selftest=open` (C2-15: `selftest-open.ts` with `OpenProbeResult`, `createOpenProbe` and `claimStepIdOf`; `selftest.ts` exports `claimRowOf`, which `selftestDrip` now calls), and C2-16's smoke asserts its result for Hybrid at 1440 px. It is a separate mode because the drip selftest scrolls the spine to its middle in the first frame after `onReady`, which would move the claim row out of view. Lane 07 C3-12 quotes that `onReady` block verbatim, so the drip selftest stays as it is.

## Controller hand-offs from W1 (binding)

- **C1a lane fix (d1dde66):** `ClaimVsObserved` takes `observedTabIndex?: 0 | -1`. Inside the spine (a roving-tabindex region) `ClaimFinding` passes `observedTabIndex={-1}` so a critical claim that auto-expands adds no second tab stop in `main` (already in C2-13's code). The Inspector keeps the default.
- **C1a lane review M-1 (elapsedMs):** running `DurationBar`s only grow when the caller passes `elapsedMs`. Every spine row and Inspector render of a `duration` graphic whose step is running passes `elapsedMs = nowMs - step.startMs` (with `nowMs` from the source's `now()` on the live tick), to `Graphic`. Add a test: a running command row's hollow bar is wider after one drip tick.
- **C1a text sanitization:** the graphics (`DiffBar`, `FlowGlyph`, `TableGlyph`, `ClaimVsObserved`) now sanitize their own mono text with `displayUntrusted`; calling `displayUntrusted` again before passing text in is harmless (it is idempotent).

## Global Constraints

Copied from the UI index, the base index and the decision record; every task's requirements include this section.

- Everything in the base index's Global Constraints applies unchanged (Node ≥ 22, zod 3 in `@jevcode/trace-viewer`, no SQL migration, the viewer never writes, stable ids per R9, commits, worktrees, zsh `${var}:suffix`).
- R17: `packages/trace-viewer` takes **no** `@xyflow/react` dependency. Both views use one hand-rolled DOM viewport: `layout/viewport.ts` (pure math, `Camera = {mode: "uniform", tx, ty, k} | {mode: "xOnly", u0, k}`) and `ui/viewport/controller.ts` (native `wheel` listener with `{passive: false}`; Ctrl/Meta+wheel zooms at the cursor, factor `2^(−deltaY · 0.02)` clamped per event to [0.8, 1.25]; other wheel, Space-drag, hand tool and middle-drag pan; one rAF write per frame; settle 150 ms after the last input rounds `tx`/`ty` and writes `--tv-inv-k`; gesture-time `will-change` only).
- R19: `layout` imports `model`, never the reverse; `ui` imports `layout` and `model`; `layout` never imports `ui`, React, the DOM or timers (ESLint enforces it).
- R15/D8: CSS Modules consuming `var(--tv-*)` only; tokens are inline custom properties on the Shell root; light only; no global CSS except `:global(.d2h-*)` rules nested under one Inspector class; the trace window never loads `apps/desktop/src/renderer/styles.css`. System font stack `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`; mono `ui-monospace, "SF Mono", Menlo, monospace` for paths, commands and code only. 12 px minimum text; no ALL-CAPS and no eyebrow labels; `tabular-nums` on every number.
- D8 tokens (verbatim): "--canvas #F4F5F7; --panel #FFFFFF; --ink #16181D; --ink-2 #5B616E; --ink-3 #9AA0AB; --hair rgb(16 24 40 / .07); --fill rgb(16 24 40 / .04); --fill-2 rgb(16 24 40 / .07); --accent #2F6BFF; --accent-soft rgb(47 107 255 / .10); --bad #E5484D; --bad-soft rgb(229 72 77 / .09); --good #2E9E6A; frame shadow 0 1px 2px rgb(16 24 40 / .06), 0 4px 12px rgb(16 24 40 / .05). (Implementation prefixes them --tv-*.)" R24 overrides: "--tv-ink-3 #676D78 for text (>=4.5:1), --tv-ink-4 #9AA0AB decoration only, --tv-mark #7C828E marks (>=3:1), --tv-accent-ink #1F5EF0, --tv-bad-ink #CE2C31."
- D8/R24 color: accent `#2F6BFF` = selection, focus, playhead, brush, one primary action; `#E5484D` = real problems only (failed test or check, agent failure, critical finding, guardrail hit) and every red mark also differs in shape or carries a word; `#2E9E6A` = tiny pass marks only, never text; diffs neutral (added solid `--tv-ink-2`, removed hollow `--tv-ink-3`), never green or red; no per-kind colors; no dimming after the playhead or outside the brush in v1.
- `--tv-ink-4` (`#9AA0AB`) is decoration only; no CSS Module may use `var(--tv-ink-4)` in a `color` declaration (enforced by `tokens.test.ts`, C1-1, which reads every `src/**/*.module.css` this lane adds).
- "Request changes" is filled with `--tv-accent-ink` `#1F5EF0`, never `--tv-accent` (white on `#2F6BFF` is 4.499:1, spec §7.2).
- Agent-written text renders only as React text nodes. `dangerouslySetInnerHTML` appears only inside ui-catalog `CodeDiff`. Agent text never renders in the title bar, chips, badges or finding-title slots. Commands, paths and output tails pass through the model's `displayUntrusted`.
- Keys match `event.code`, are ignored while `event.isComposing`, in `input`, `textarea` and `[contenteditable]`, and with any modifier not listed in the keymap.
- Every region (Outline, `main`, Inspector) is one tab stop with a roving tabindex. `prefers-reduced-motion` sets every duration to 0.
- R16/R22 live rules: a running session (`starting`, `running`, `waiting_decision`) opens in Live, `paused` and terminal ones in Review; any camera gesture, drag, `,`/`.`, zoom key or non-tail selection switches to Review (announced once); applies wait for a gesture to end and the latest session wins; `terminal(state) = state === "completed" || state === "failed"`.
- The viewer reads only through `TraceSource` and writes nothing. `ViewerHost.requestChanges` is the only outbound call, and only the Electron host implements it. `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `process` and `Buffer` are banned in `packages/trace-viewer/src` (ESLint); only the dev host fetches bundles.
- No UI lane edits any `package.json` dependency block, any `exports` map, `pnpm-lock.yaml` or `eslint.config.mjs`. A task that finds a missing dependency stops and escalates.
- Tests: component tests start with `// @vitest-environment jsdom`, stub their own `getBoundingClientRect` and `ResizeObserver` per test (through `stubLayout()` from `ui-harness.tsx`, restored in `afterEach`), and install no global fakes; `paint.ts` runs against a recording 2D context. Expected values come from the spec's tables and the fixtures' known content (oauth's failed `pnpm test` 14/1/0, the claim at +0:43, rows located by content), never from the implementation.
- Budgets (spec §10, M4a gate): soak first paint ≤ 300 ms and full load ≤ 2 s; `j` to painted p95 ≤ 16.7 ms from keydown to the next painted frame (zero-work baseline beside it); overview layout + paint at Session level p95 ≤ 4 ms with ≤ 150 overlay nodes; anchor drift ≤ 1 px (smoke).
- Commits: one conventional commit per task (`feat(trace-viewer): …`, `test(trace-viewer): …`, `fix(ui-catalog): …`, `docs(trace-viewer): …`), listing the task's files explicitly in `git add`. Never add a `Claude-Session:` trailer. Never run `git stash`; set work aside with a WIP commit.

## Review Focus

Five inputs a supervisor will hit that no happy-path test exercises. Each line names the test that pins it and the task that owns it.

1. **A live append while the reader is scrolled away in Review and mid-gesture.** Expected: the newest session waits until the gesture ends and applies once (latest wins); the anchored spine row moves ≤ 1 px; DOM focus never moves; "↓ N new" rises; a collapsed critical finding stays collapsed. Tests: **C2-2** `data-controller.test.ts` "holds applies during a gesture and applies the latest once"; **C2-14** `hybrid-view.test.tsx` "a Review append raises N new and never moves focus"; **C2-16** smoke `?selftest=drip` `maxDriftPx <= 1`.
2. **Hostile agent text**: a message holding a ```` ``` ```` fence, `<img src=x onerror=alert(1)>`, a U+202E override inside a command, and the literal string "Claim contradicts tests". Expected: every string renders as text; the review note's fence is one backtick longer than the longest run inside it; the bidi character shows as `⟨U+202E⟩`; the Inspector title comes from `FINDING_TITLE`/`KIND_META`, never from agent text. Tests: **C2-1** `components.test.tsx` "renders a diff line that holds markup as text"; **C2-6** `review-note.test.ts` "fences quoted text longer than any backtick run inside it" and `inspector.test.tsx` "agent text never fills the title slot"; **C2-12** `spine.test.tsx` "renders a bidi override in a command as the escape token".
3. **A pre-M1 session**: no chapters, exit −1 on a command, `coverage.approximateJoins`, three gaps. Expected: the chips `≈ Approximate joins` and "3 gaps" show and are never red; the command reads "exit unknown" with no ✕; the Outline has no chapter rows and still lists the command. Tests: **C2-4** `title-bar.test.tsx` "data-quality chips are neutral"; **C2-5** `outline-rows.test.ts` "exit -1 reads exit unknown and carries no failure flag".
4. **Keyboard edge cases**: a Hangul input source (`key: "ㅓ"`, `code: "KeyJ"`), `isComposing: true`, Space with focus on a button in `main`, Cmd+C with a text selection. Expected: `ㅓ` moves like `j`; composing keys do nothing; Space pans and never clicks the button; Cmd+C with selected text leaves the clipboard to the browser. Tests: **C2-8** `keyboard.test.tsx`.
5. **The source fails mid-session and a stale response arrives late.** Expected: a rejected poll shows "Reconnecting (1)", backs off 1 → 2 → 4 → 10 → 10 s and keeps the loaded session on screen; a response from before a retry is dropped; a failed payload fetch shows an inline Retry in Evidence or Raw without touching the rest of the Inspector. Tests: **C2-2** "a rejected poll reconnects with backoff and keeps the session" and "drops a response that a retry superseded"; **C2-4** "shows Reconnecting with the attempt number"; **C2-7** `evidence-raw.test.tsx` "a payload failure shows an inline Retry".

---

## Lane prerequisites

C2 is wave W2. It starts only after W0 and all of W1 have merged to `main` in the order W0 → A1 → A2 → B → C1a → C1b, including the UI index §1 amendments and the spike (C1-7, plus C1-7F if spike risk 1 failed).

**Create the worktree** (from `/Users/jwpark/Projects/jevcode`, `<w1>` = the merge commit that closed W1):

```bash
git worktree add -b tv/c2-shell-hybrid /Users/jwpark/Projects/jevcode-tv-c2 <w1>
cd /Users/jwpark/Projects/jevcode-tv-c2
pnpm install --frozen-lockfile
NP=$(ls -d node_modules/.pnpm/node-pty@*/node_modules/node-pty | head -1) && mkdir -p "$NP/build/Release" && pnpm --filter jevcode-desktop rebuild:node && cp "$NP/prebuilds/$(node -p 'process.platform + "-" + process.arch')/spawn-helper" "$NP/build/Release/spawn-helper" && chmod +x "$NP/build/Release/spawn-helper"
pnpm -r build
```

Expected: every command exits 0. Tell every subagent in this worktree never to run `git stash` (the stash stack is shared by all worktrees); set work aside with a WIP commit instead.

**Verify what W0 and W1 left** (run from `/Users/jwpark/Projects/jevcode-tv-c2`):

```bash
grep -c '"./components/\*"' packages/ui-catalog/package.json
grep -c '"@tanstack/react-virtual": "3.14.13"' packages/trace-viewer/package.json
grep -c '@xyflow/react' packages/trace-viewer/package.json
grep -c 'assetsInlineLimit: 0' apps/trace-viewer-dev/vite.config.ts
grep -c "anchorTo?: ScrollAnchor\|followOnAppend?: FollowOnAppend\|scrollEndThreshold?: number" node_modules/.pnpm/@tanstack+virtual-core@3.17.11/node_modules/@tanstack/virtual-core/src/index.ts
grep -cE 'export const LEVELS|originMs: number;|outputTail\?: string;|anchorStepId: StepId;|claimSpan\?: \[number, number\];|answerSeq\?: number;|startMs: number;|end: "none" \| "bad_dot" \| "exit_x";' packages/trace-viewer/src/model/types.ts
grep -cE 'readonly sessionId: string;|summary\(\): Promise<TraceSessionSummary>;|now\(\): number;' packages/trace-viewer/src/source.ts
grep -c 'nowMs?: number' packages/trace-viewer/src/model/fold.ts
```

Expected, line by line: `1`, `1`, `0`, `1`, `3`, `8`, `3`, `1`.

```bash
node --input-type=module -e '
const m = await import("./packages/trace-viewer/dist/model/index.js");
const need = ["foldRows","createTraceState","accumulateAll","finalize","formatOffset","formatDuration","truncateMiddle","agentStateLabel","normalizeCommand","exitLabel","displayUntrusted","KIND_META","LANES","LEVELS","SIGNAL_IDS","signalMeta","clampMeta","compareFindings","buildSearchIndex","searchSteps","resolveStableId","pickGraphic","describeGraphic"];
const missing = need.filter((n) => !(n in m));
console.log(missing.length === 0 ? "MODEL_OK" : "MODEL_MISSING " + missing.join(","));
const s = await import("./packages/trace-viewer/dist/sources/index.js");
console.log(["createStaticBundleSource","parseTraceBundle","readAllTraceRows","TraceSourceError"].every((n) => n in s) ? "SOURCES_OK" : "SOURCES_MISSING");'
```

Expected: `MODEL_OK` and `SOURCES_OK`.

```bash
ls packages/trace-viewer/src/layout/{viewport,time-scale,ticks,trace-index,tone,overview-index,overview-layout,spine-rows}.ts \
   packages/trace-viewer/src/ui/viewport/controller.ts \
   packages/trace-viewer/src/ui/state/{view-state,store,location,keymap}.ts \
   packages/trace-viewer/src/ui/tokens/{tokens.ts,contrast.ts,base.module.css} \
   packages/trace-viewer/src/ui/icons/{Icon.tsx,IconSprite.tsx,kind-icons.ts} \
   packages/trace-viewer/src/ui/graphics/{Graphic.tsx,DiffBar.tsx,TestDots.tsx,DurationBar.tsx,ForkGlyph.tsx,ClaimVsObserved.tsx,scales.ts} \
   packages/trace-viewer/src/test-support/{fixture-rows.ts,trace-builder.ts,session-builder.ts,arbitraries.ts} \
   docs/spikes/trace-viewer-spike.md | wc -l
```

Expected: `31`.

**Baseline green** (gotcha 2): `pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint` exits 0. Record the trace-viewer test count from `pnpm --filter @jevcode/trace-viewer test` so each task can show it only grows.

If any expectation fails, stop: this lane does not start (Task C2-0 is the formal gate).

## Conventions every task follows

1. **Targeted tests** run from the worktree root: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/shell/data-controller.test.ts` (paths relative to the package).
2. **Root checks** end every task, in order: `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r --no-bail --workspace-concurrency=1 test`, `pnpm lint`. Each exits 0. Known flakes (`file-watcher.test.ts`, `stall-watchdog.test.ts`, `codex-adapter.test.ts`) are confirmed by rerunning that package alone.
3. **Rebuild before dependents.** `@jevcode/trace-viewer` and `@jevcode/ui-catalog` export only `dist`. Run `pnpm --filter "...@jevcode/ui-catalog" build` after C2-1 and `pnpm --filter @jevcode/trace-viewer build` before any dev-host build or the smoke. CSS Modules reach `dist` only through `scripts/copy-assets.mjs`, which the package `build` script runs.
4. **jsdom.** Component tests start with `// @vitest-environment jsdom`; call `stubLayout()` inside the test (or a `beforeEach` of that file) and `restore()` in `afterEach`; jsdom has no `setPointerCapture` (call it only when present) and `getContext("2d")` returns `null`. There is no jest-dom: assert with `getAttribute`, `textContent` and roles. Vitest returns stable proxy class names for `*.module.css`, so tests query by role, label, text or `data-*` attributes, never by class.
5. **`useSyncExternalStore` selectors** return primitives or references held in state; derive objects with `useMemo`.
6. **`<Activity>`** comes from `react`; a hidden subtree runs no effects, so rAF loops, observers and listeners start only in effects.
7. **Virtualizer options** act together: `followOnAppend` works only with `anchorTo: "end"`.
8. **Commits** list files explicitly; the message is the conventional line given in the step, with no trailer.

## File map

| File | Task | Responsibility |
|---|---|---|
| `docs/spikes/trace-viewer-spike.md` (mod) | C2-0, C2-16 | M4a gate section; M4a exit section |
| `packages/ui-catalog/src/components/CodeDiff.tsx` (mod) | C2-1 | Keep real `@@` hunk headers |
| `packages/ui-catalog/src/components.test.tsx` (mod) | C2-1 | Two-hunk and markup tests |
| `packages/trace-viewer/src/ui/shell/data-controller.ts` | C2-2 | Paging, commit throttle, poll, backoff, hold, visibility |
| `packages/trace-viewer/src/ui/shell/{host.ts, session-context.ts, perf.ts, LiveRegion.tsx, ErrorBoundary.tsx, ViewSlot.tsx, Shell.tsx, Shell.module.css, TraceViewer.tsx}` | C2-3 | Entry, grid, contexts, boundaries, perf marks |
| `packages/trace-viewer/src/ui/views/view-port.ts` | C2-3 | View registration API and view definitions context |
| `packages/trace-viewer/src/test-support/ui-harness.tsx` | C2-3 | Fixture folds, layout stubs, provider wrapper (test-only) |
| `packages/trace-viewer/src/ui/shell/{TitleBar.tsx, TitleBar.module.css}` | C2-4 | Title, chips, Review/Live, N new, duration, zoom menu, view switch |
| `packages/trace-viewer/src/ui/shell/Outline/{Outline.tsx, outline-rows.ts, Outline.module.css}` | C2-5 | Pure outline rows; virtualized tree; search |
| `packages/trace-viewer/src/ui/inspector/{Inspector.tsx, Summary.tsx, finding-copy.ts, review-note.ts, Inspector.module.css}` | C2-6 | Header, tabs, per-kind Summary, review note, footer |
| `packages/trace-viewer/src/ui/inspector/{Evidence.tsx, Raw.tsx}` | C2-7 | CodeDiff evidence, output, lazy Raw |
| `packages/trace-viewer/src/ui/shell/{KeyboardLayer.tsx, regions.ts, ShortcutSheet.tsx}` | C2-8 | One keyboard model, F6 regions, shortcut sheet |
| `packages/trace-viewer/src/ui/views/shared/{Ruler.tsx, LevelControl.tsx, NewBadge.tsx, shared.module.css}` | C2-9 | Parts both views use |
| `packages/trace-viewer/src/ui/views/hybrid/overview/{paint.ts, OverviewCanvas.tsx}`; `src/test-support/recording-context.ts` | C2-10 | Pure painter; DPR canvas surface |
| `packages/trace-viewer/src/ui/views/hybrid/overview/{Overview.tsx, Pins.tsx, Brush.tsx, Overview.module.css}` | C2-11 | Overview DOM, camera, pointer and keys |
| `packages/trace-viewer/src/ui/views/hybrid/spine/{Spine.tsx, scroll-sync.ts, rows/*.tsx, Spine.module.css}` | C2-12 | Virtualized feed, anchoring, playhead sync |
| `packages/trace-viewer/src/ui/views/hybrid/spine/findings/*.tsx` | C2-13 | `FINDING_BODY` per signal |
| `packages/trace-viewer/src/ui/views/hybrid/{HybridView.tsx, hybrid-port.ts, HybridView.module.css}`; `src/ui/views/registry.ts` | C2-14 | Composition, `ViewPort`, presets, live follow, registry |
| `apps/trace-viewer-dev/{vite.config.ts, .gitignore, src/main.tsx, src/host.tsx, src/host.module.css, src/selftest.ts, src/selftest-open.ts, src/perf-hud.tsx}` | C2-15 | Dev host; `?selftest=open` probe (deviation 10) |
| `apps/trace-viewer-dev/scripts/smoke.mjs` | C2-16 | Hybrid visual smoke, including the spec §1 open probe |

Every test file named in the tasks sits beside its module.

---
### Task C2-0: M4a spike gate (risks 1, 4, 5)

**Files:**
- Modify: `docs/spikes/trace-viewer-spike.md` (append an "M4a gate" section)

**Interfaces:**
- Consumes: the spike doc written by C1-7 (one row per risk with measured values, "pass" or "fail" against spec §16's pass column, and the ruling), and C1-7F's `packages/trace-viewer/src/ui/viewport/d3-controller.ts` when risk 1 failed.
- Produces: a recorded gate that later tasks read: the risk 4 ruling (C2-5 already applies it, deviation 6) and the risk 5 ruling, which sets `PINS_PAINTED_ON_CANVAS` in C2-11.

- [ ] **Step 1: Read the three gating rows**

Run: `grep -nE '^\| *(1|4|5) *\|' docs/spikes/trace-viewer-spike.md`
Expected: three table rows. Each row's result cell reads `pass`, or reads `fail` and names its ruling (risk 1 → "d3-zoom behind viewport.ts"; risk 4 → "frame description in the Outline row"; risk 5 → "paint pins on the canvas").

- [ ] **Step 2: Check the risk 1 fallback when risk 1 failed**

Run: `git log --oneline main -- packages/trace-viewer/src/ui/viewport/d3-controller.ts | head -1`
Expected: when row 1 reads `pass`, no output. When row 1 reads `fail`, one commit (C1-7F merged in W1). If row 1 failed and there is no commit, stop and escalate: M4a does not start.

- [ ] **Step 3: Re-run the model and source prerequisite checks**

Run the two `node --input-type=module` and `grep` blocks from "Lane prerequisites" again.
Expected: `MODEL_OK`, `SOURCES_OK` and the eight `grep` counts listed there. Any miss stops the lane.

- [ ] **Step 4: Append the gate section**

Append this section to `docs/spikes/trace-viewer-spike.md`, copying each result and ruling verbatim from the rows read in Step 1 (the text inside angle brackets is copied from the doc, never invented):

```markdown
## M4a gate (lane C2, 2026-09-28)

| Risk | Result (from the rows above) | Ruling applied in M4a | Owning task |
|---|---|---|---|
| 1 Gesture feel and Electron input | <row 1 result> | <"none" or "d3-zoom controller from C1-7F"> | C1-7F (W1) |
| 4 Keyboard and VoiceOver | <row 4 result> | Outline chapter rows always carry the full frame description in their accessible name | C2-5 |
| 5 Hybrid DOM/canvas alignment | <row 5 result> | <"none: DOM pins" or "pins painted on the canvas; DOM buttons stay as focus targets"> | C2-11 (`PINS_PAINTED_ON_CANVAS`) |

M4a proceeds: risks 1, 4 and 5 passed or have their ruling applied by the owning task.
```

- [ ] **Step 5: Commit**

```bash
git add docs/spikes/trace-viewer-spike.md
git commit -m "docs(trace-viewer): record the M4a spike gate"
```

---

### Task C2-1: ui-catalog `CodeDiff` keeps real `@@` headers; markup renders as text

**Files:**
- Modify: `packages/ui-catalog/src/components/CodeDiff.tsx:5-29` (`normalizeDiff`)
- Test: `packages/ui-catalog/src/components.test.tsx` (`describe("CodeDiff")` at :256)

**Interfaces:**
- Consumes: `CodeDiffProps` from `@jevcode/contracts` (`{ file: string; diff: string }`); `diff2html` 3.4.56 `html(diff, { drawFileList: false, outputFormat: "line-by-line" })`, which escapes line content (checked: `+<img src=x onerror=alert(1)>` becomes `&lt;img …`).
- Produces: `export function CodeDiff({ props }: { props: CodeDiffProps }): JSX.Element`, unchanged signature, now rendering real hunk headers and line numbers. C2-7 imports it as `@jevcode/ui-catalog/components/CodeDiff`.

Current anchor (`CodeDiff.tsx:5-12`):

```ts
function normalizeDiff(diff: string, file: string): string {
  const lines = diff.split("\n");
  const hasFileHeader = /^--- .+/.test(lines[0] ?? "") && /^\+\+\+ .+/.test(lines[1] ?? "");
  const bodyLines = hasFileHeader ? lines.slice(2) : lines;
  const body = bodyLines.filter((line) => !/^@@ /.test(line));
  if (body.length === 0) {
    return hasFileHeader ? diff : `--- ${file}\n+++ ${file}\n`;
  }
```

It drops every `@@` line and synthesizes `@@ -1,N +1,M @@`, so a two-hunk diff renders with line numbers 1..N instead of the real ones.

- [ ] **Step 1: Write the failing tests**

In `packages/ui-catalog/src/components.test.tsx`, add these two cases inside `describe("CodeDiff", () => {` after the existing `it("renders a headerless unified diff via diff2html", …)`:

```tsx
  it("keeps real @@ headers and line numbers in a two-hunk diff", () => {
    const diff = [
      "--- a/src/auth/service.ts",
      "+++ b/src/auth/service.ts",
      "@@ -10,3 +10,4 @@ export class AuthService {",
      "   const user = await this.users.find(email);",
      "-  return user;",
      "+  if (!user) return null;",
      "+  return this.identities.link(user);",
      "   }",
      "@@ -40,2 +41,2 @@ export function verify() {",
      "-  return false;",
      "+  return true;",
      " }",
      "",
    ].join("\n");
    render(<CodeDiff props={{ file: "src/auth/service.ts", diff }} />);
    const element = screen.getByTestId("code-diff");
    expect(element.textContent).toContain("@@ -10,3 +10,4 @@");
    expect(element.textContent).toContain("@@ -40,2 +41,2 @@");
    const newLineNumbers = Array.from(element.querySelectorAll(".line-num2")).map((node) =>
      (node.textContent ?? "").trim(),
    );
    expect(newLineNumbers).toContain("10");
    expect(newLineNumbers).toContain("41");
    expect(newLineNumbers).not.toContain("1");
  });

  it("renders a diff line that holds markup as text", () => {
    const diff = ["@@ -1,1 +1,2 @@", " const a = 1;", "+<img src=x onerror=alert(1)>", ""].join("\n");
    render(<CodeDiff props={{ file: "src/a.ts", diff }} />);
    const element = screen.getByTestId("code-diff");
    expect(element.querySelector("img")).toBeNull();
    expect(element.textContent).toContain("<img src=x onerror=alert(1)>");
  });
```

- [ ] **Step 2: Run the tests to see the first one fail**

Run: `pnpm --filter @jevcode/ui-catalog exec vitest run src/components.test.tsx -t CodeDiff`
Expected: FAIL in "keeps real @@ headers and line numbers in a two-hunk diff" (the text holds the synthesized `@@ -1,5 +1,6 @@` and the line numbers start at 1); "renders a diff line that holds markup as text" and the existing case PASS (diff2html already escapes; the new case pins it, Review Focus 2).

- [ ] **Step 3: Keep real hunk headers**

Replace `normalizeDiff` in `packages/ui-catalog/src/components/CodeDiff.tsx` with:

```ts
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

function normalizeDiff(diff: string, file: string): string {
  const lines = diff.split("\n");
  const hasFileHeader = /^--- .+/.test(lines[0] ?? "") && /^\+\+\+ .+/.test(lines[1] ?? "");
  const bodyLines = hasFileHeader ? lines.slice(2) : lines;
  const header = hasFileHeader ? `${lines[0]}\n${lines[1]}` : `--- ${file}\n+++ ${file}`;
  if (bodyLines.some((line) => HUNK_HEADER.test(line))) {
    // Real hunk headers carry the true line numbers (trace viewer spec §7.1 Evidence); keep them.
    return `${header}\n${bodyLines.join("\n")}`;
  }
  const body = bodyLines.filter((line) => !/^@@ /.test(line));
  if (body.length === 0) {
    return hasFileHeader ? diff : `--- ${file}\n+++ ${file}\n`;
  }
  let oldCount = 0;
  let newCount = 0;
  for (const line of body) {
    if (line.startsWith("+")) {
      newCount += 1;
    } else if (line.startsWith("-")) {
      oldCount += 1;
    } else if (line.startsWith(" ")) {
      oldCount += 1;
      newCount += 1;
    }
  }
  return `${header}\n@@ -1,${Math.max(oldCount, 1)} +1,${Math.max(newCount, 1)} @@\n${body.join("\n")}`;
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm --filter @jevcode/ui-catalog exec vitest run src/components.test.tsx -t CodeDiff`
Expected: PASS, 3 tests.

- [ ] **Step 5: Rebuild ui-catalog and its dependents, then run the root checks**

Run: `pnpm --filter "...@jevcode/ui-catalog" build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint`
Expected: exit 0; `ls packages/ui-catalog/dist/components/CodeDiff.js` prints the path.

- [ ] **Step 6: Commit**

```bash
git add packages/ui-catalog/src/components/CodeDiff.tsx packages/ui-catalog/src/components.test.tsx
git commit -m "fix(ui-catalog): keep real hunk headers in CodeDiff"
```

---

### Task C2-2: `DataController`: paging, ≤ 4 commits/s, poll, backoff, stale-response guard, gesture hold, visibility

**Files:**
- Create: `packages/trace-viewer/src/ui/shell/data-controller.ts`
- Test: `packages/trace-viewer/src/ui/shell/data-controller.test.ts`

**Interfaces:**
- Consumes (W0, B, C1b, verbatim):
  - `TraceSource { readonly sessionId: string; summary(): Promise<TraceSessionSummary>; rows(request?: TraceRowsRequest): Promise<TraceRowsPage>; payloads(seqs: readonly number[]): Promise<TraceRow[]>; now(): number }` and `cursorAfter(page: TraceRowsPage): number` from `../../source.js`.
  - `createTraceState(meta: TraceSessionSummary): TraceState`, `accumulateAll(state: TraceState, rows: readonly TraceRow[]): TraceState`, `finalize(state: TraceState, options: FinalizeOptions): TraceSession` with `FinalizeOptions { live: boolean; state?: AgentState; throughSeq?: number; nowMs?: number }` from `../../model/index.js`.
  - `TraceSourceError { channel: TraceChannel; code: TraceSourceErrorCode; message }`, `TraceChannel = "trace:listSessions" | "trace:rows" | "trace:payloads" | "bundle"`, `TraceSourceErrorCode = "UNKNOWN_SESSION" | "NOT_A_TRACE" | "UNSUPPORTED_VERSION" | "SOURCE_FAILED"` from `../../sources/errors.js`.
  - `TRACE_ROWS_PAGE_MAX = 5_000`, `AgentState` from `@jevcode/contracts`; test-only `TraceBuilder`, `testMeta` from `../../test-support/trace-builder.js`.
- Produces (UI index §2.4 plus deviation 5):

```ts
export type DataStatus =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "reconnecting"; attempt: number; retryInMs: number }
  | { kind: "error"; channel: TraceChannel; code: TraceSourceErrorCode; message: string };
export interface DataSnapshot {
  summary: TraceSessionSummary | null;
  session: TraceSession | null;
  status: DataStatus;
  loadedFraction: number;
  terminal: boolean;
  rows: number;
}
export interface Scheduler { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void; now(): number }
export interface DataControllerOptions {
  source: TraceSource;
  pollMs: number;
  pageSize?: number;
  maxCommitsPerSecond?: number;
  scheduler?: Scheduler;
  isHidden?(): boolean;
}
export const BACKOFF_MS: readonly number[];   // [1_000, 2_000, 4_000, 10_000]; repeats 10_000
export interface DataController {
  start(): void;
  stop(): void;
  retry(): void;
  hold(held: boolean): void;
  notifyVisible(): void;
  subscribe(listener: (snapshot: DataSnapshot) => void): () => void;
  get(): DataSnapshot;
  payloads(seqs: readonly number[]): Promise<TraceRow[]>;
  now(): number;
}
export function createDataController(options: DataControllerOptions): DataController;
export function isTerminalState(state: AgentState): boolean;
export function isLiveState(state: AgentState): boolean;
/** Spec §10 live tick start; C2-3's Shell measures PERF.liveTick from it (lane 08 D-8 reads the measure). */
export const LIVE_TICK_START: "tv:live-tick-start";
```

Behavior: `start()` calls `summary()`, publishes it, then pages `rows({afterSeq, limit: pageSize})` until `nextAfterSeq` is `null`, folding every page at once but publishing a new `TraceSession` at most once per `1000 / maxCommitsPerSecond` ms (a deferred commit publishes the latest fold). After catching up it polls every `pollMs` until `terminal(page.state)`, applies once more, then stops; a poll with no new rows and no state change publishes nothing. A failed first load publishes `status: error`; a failed poll after data exists publishes `reconnecting` with `BACKOFF_MS` and keeps `session`. Every request belongs to a generation; `retry()` and `stop()` start a new one, so older responses are dropped. `hold(true)` and a hidden document queue snapshots; release publishes only the latest. When a poll page with new rows arrives after the first full load (the previous snapshot has `loadedFraction` 1 and a session), the controller replaces the `performance` mark `LIVE_TICK_START`; the Shell (C2-3) measures `PERF.liveTick` from it to the next paint, which covers spec §10's "poll apply + selectors + commit". A snapshot held by a gesture measures the hold too; the budget runs (lane 08 D-8) do not gesture.

- [ ] **Step 1: Write the failing test**

Create `packages/trace-viewer/src/ui/shell/data-controller.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { AgentState, TraceRow, TraceRowsPage } from "@jevcode/contracts";

import type { TraceRowsRequest, TraceSource } from "../../source.js";
import { TraceSourceError } from "../../sources/errors.js";
import { TraceBuilder, testMeta } from "../../test-support/trace-builder.js";
import {
  BACKOFF_MS,
  createDataController,
  LIVE_TICK_START,
  type DataSnapshot,
  type Scheduler,
} from "./data-controller.js";

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

class FakeScheduler implements Scheduler {
  private t = 0;
  private seq = 0;
  private timers: Array<{ at: number; id: number; fn: () => void }> = [];

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    this.seq += 1;
    this.timers.push({ at: this.t + Math.max(0, ms), id: this.seq, fn });
    return this.seq;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  }

  /** Time spent inside a request. */
  spend(ms: number): void {
    this.t += ms;
  }

  pending(): number {
    return this.timers.length;
  }

  async run(ms: number): Promise<void> {
    const end = this.t + ms;
    await settle();
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (next === undefined || next.at > end) break;
      this.timers.shift();
      this.t = Math.max(this.t, next.at);
      next.fn();
      await settle();
    }
    this.t = Math.max(this.t, end);
  }
}

function messageRows(count: number): TraceRow[] {
  const b = new TraceBuilder();
  b.agent({ type: "agent_started", prompt: "p" });
  for (let i = 1; i < count; i += 1) b.agent({ type: "agent_message", role: "assistant", text: `m${i}` });
  return b.rows;
}

interface Deferred {
  request: TraceRowsRequest;
  resolve(page: TraceRowsPage): void;
}

function fakeSource(rows: TraceRow[], init: { state: AgentState; released?: number }) {
  const control = {
    state: init.state,
    released: init.released ?? rows.length,
    calls: [] as TraceRowsRequest[],
    failures: 0,
    deferNext: false,
    deferred: [] as Deferred[],
    onRows: (_request: TraceRowsRequest): void => undefined,
    summaryError: null as unknown,
  };
  const page = (request: TraceRowsRequest): TraceRowsPage => {
    const after = request.afterSeq ?? 0;
    const limit = request.limit ?? 2_000;
    const out = rows.slice(0, control.released).filter((row) => row.seq > after).slice(0, limit);
    return {
      rows: out,
      nextAfterSeq: out.length === limit ? (out.at(-1)?.seq ?? null) : null,
      lastSeq: rows[control.released - 1]?.seq ?? 0,
      state: control.state,
    };
  };
  const source: TraceSource = {
    sessionId: "sess-test",
    summary: async () => {
      if (control.summaryError !== null) {
        const error = control.summaryError;
        control.summaryError = null;
        throw error;
      }
      return testMeta({ state: control.state });
    },
    rows: (request = {}) => {
      control.calls.push(request);
      control.onRows(request);
      if (control.failures > 0) {
        control.failures -= 1;
        return Promise.reject(new Error("socket closed"));
      }
      if (control.deferNext) {
        control.deferNext = false;
        return new Promise<TraceRowsPage>((resolve) => control.deferred.push({ request, resolve }));
      }
      return Promise.resolve(page(request));
    },
    payloads: async () => [],
    now: () => 0,
  };
  return { source, control };
}

function record(controller: { subscribe(listener: (snapshot: DataSnapshot) => void): () => void }, scheduler: FakeScheduler) {
  const seen: Array<{ t: number; snapshot: DataSnapshot }> = [];
  controller.subscribe((snapshot) => seen.push({ t: scheduler.now(), snapshot }));
  return seen;
}

describe("createDataController", () => {
  it("pages until caught up with at most 4 commits per second", async () => {
    const scheduler = new FakeScheduler();
    const { source, control } = fakeSource(messageRows(30), { state: "completed" });
    control.onRows = () => scheduler.spend(60);
    const controller = createDataController({ source, pollMs: 1_000, pageSize: 3, scheduler, isHidden: () => false });
    const seen = record(controller, scheduler);
    controller.start();
    await scheduler.run(5_000);

    expect(control.calls.map((call) => call.afterSeq)).toEqual([0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30]);
    const commits = seen.filter((entry) => entry.snapshot.session !== null);
    expect(commits.length).toBeGreaterThanOrEqual(2);
    expect(commits[0]?.snapshot.loadedFraction).toBeLessThan(1);
    for (let i = 1; i < commits.length; i += 1) {
      expect((commits[i]?.t ?? 0) - (commits[i - 1]?.t ?? 0)).toBeGreaterThanOrEqual(250);
    }
    const last = controller.get();
    expect(last.loadedFraction).toBe(1);
    expect(last.session?.loadedThroughSeq).toBe(30);
    expect(last.terminal).toBe(true);
    expect(last.rows).toBe(30);
    expect(scheduler.pending()).toBe(0);
  });

  it("polls every pollMs until terminal, applies once more, then stops", async () => {
    const scheduler = new FakeScheduler();
    const { source, control } = fakeSource(messageRows(5), { state: "running", released: 3 });
    const controller = createDataController({ source, pollMs: 1_000, scheduler, isHidden: () => false });
    controller.start();
    await scheduler.run(100);
    expect(controller.get().session?.loadedThroughSeq).toBe(3);
    expect(controller.get().terminal).toBe(false);

    const before = controller.get();
    await scheduler.run(1_000);
    expect(control.calls.at(-1)?.afterSeq).toBe(3);
    expect(controller.get()).toBe(before);

    control.released = 5;
    await scheduler.run(1_000);
    expect(controller.get().session?.loadedThroughSeq).toBe(5);

    control.state = "completed";
    await scheduler.run(1_000);
    expect(controller.get().terminal).toBe(true);
    const calls = control.calls.length;
    await scheduler.run(5_000);
    expect(control.calls.length).toBe(calls);
  });

  it("keeps polling a paused session", async () => {
    const scheduler = new FakeScheduler();
    const { source, control } = fakeSource(messageRows(3), { state: "paused" });
    const controller = createDataController({ source, pollMs: 1_000, scheduler, isHidden: () => false });
    controller.start();
    await scheduler.run(100);
    const calls = control.calls.length;
    await scheduler.run(3_000);
    expect(control.calls.length).toBe(calls + 3);
    expect(controller.get().terminal).toBe(false);
  });

  it("a rejected poll reconnects with backoff and keeps the session", async () => {
    const scheduler = new FakeScheduler();
    const { source, control } = fakeSource(messageRows(3), { state: "running" });
    const controller = createDataController({ source, pollMs: 1_000, scheduler, isHidden: () => false });
    const seen = record(controller, scheduler);
    controller.start();
    await scheduler.run(100);
    const loaded = controller.get().session;
    expect(loaded).not.toBeNull();

    control.failures = 5;
    await scheduler.run(40_000);
    const reconnecting = seen
      .map((entry) => entry.snapshot)
      .filter((snapshot) => snapshot.status.kind === "reconnecting");
    expect(reconnecting.map((snapshot) => (snapshot.status.kind === "reconnecting" ? snapshot.status.retryInMs : 0))).toEqual([
      1_000, 2_000, 4_000, 10_000, 10_000,
    ]);
    expect(reconnecting.map((snapshot) => (snapshot.status.kind === "reconnecting" ? snapshot.status.attempt : 0))).toEqual([1, 2, 3, 4, 5]);
    for (const snapshot of reconnecting) expect(snapshot.session).toBe(loaded);
    expect(controller.get().status.kind).toBe("ready");
    expect(BACKOFF_MS).toEqual([1_000, 2_000, 4_000, 10_000]);
  });

  it("drops a response that a retry superseded", async () => {
    const scheduler = new FakeScheduler();
    const rows = messageRows(5);
    const { source, control } = fakeSource(rows, { state: "running", released: 3 });
    const controller = createDataController({ source, pollMs: 1_000, scheduler, isHidden: () => false });
    const seen = record(controller, scheduler);
    controller.start();
    await scheduler.run(100);

    control.deferNext = true;
    await scheduler.run(1_000);
    expect(control.deferred).toHaveLength(1);

    control.released = 5;
    controller.retry();
    await scheduler.run(10);
    expect(controller.get().session?.loadedThroughSeq).toBe(5);
    const count = seen.length;

    const stale = control.deferred[0];
    stale?.resolve({ rows: [], nextAfterSeq: null, lastSeq: 99, state: "failed" });
    await scheduler.run(10);
    expect(seen.length).toBe(count);
    expect(controller.get().terminal).toBe(false);
    expect(controller.get().session?.loadedThroughSeq).toBe(5);
  });

  it("holds applies during a gesture and applies the latest once", async () => {
    const scheduler = new FakeScheduler();
    const { source, control } = fakeSource(messageRows(5), { state: "running", released: 3 });
    const controller = createDataController({ source, pollMs: 1_000, scheduler, isHidden: () => false });
    const seen = record(controller, scheduler);
    controller.start();
    await scheduler.run(100);
    const count = seen.length;

    controller.hold(true);
    control.released = 4;
    await scheduler.run(1_000);
    control.released = 5;
    await scheduler.run(1_000);
    expect(seen.length).toBe(count);
    expect(controller.get().session?.loadedThroughSeq).toBe(3);

    controller.hold(false);
    expect(seen.length).toBe(count + 1);
    expect(seen.at(-1)?.snapshot.session?.loadedThroughSeq).toBe(5);
  });

  it("polls while hidden and emits once on notifyVisible", async () => {
    const scheduler = new FakeScheduler();
    let hidden = false;
    const { source, control } = fakeSource(messageRows(6), { state: "running", released: 3 });
    const controller = createDataController({ source, pollMs: 1_000, scheduler, isHidden: () => hidden });
    const seen = record(controller, scheduler);
    controller.start();
    await scheduler.run(100);
    const count = seen.length;
    const calls = control.calls.length;

    hidden = true;
    control.released = 5;
    await scheduler.run(1_000);
    control.released = 6;
    await scheduler.run(1_000);
    expect(control.calls.length).toBe(calls + 2);
    expect(seen.length).toBe(count);

    hidden = false;
    controller.notifyVisible();
    expect(seen.length).toBe(count + 1);
    expect(controller.get().session?.loadedThroughSeq).toBe(6);
  });

  it("reports a first-load failure with its channel and recovers on retry", async () => {
    const scheduler = new FakeScheduler();
    const { source, control } = fakeSource(messageRows(3), { state: "completed" });
    control.summaryError = new TraceSourceError("trace:listSessions", "UNKNOWN_SESSION", "no session sess-test");
    const controller = createDataController({ source, pollMs: 1_000, scheduler, isHidden: () => false });
    controller.start();
    await scheduler.run(100);
    expect(controller.get().status).toEqual({
      kind: "error",
      channel: "trace:listSessions",
      code: "UNKNOWN_SESSION",
      message: "no session sess-test",
    });

    controller.retry();
    await scheduler.run(100);
    expect(controller.get().status.kind).toBe("ready");
    expect(controller.get().session?.loadedThroughSeq).toBe(3);
  });

  it("marks the live-tick start only when a poll brings rows after the full load", async () => {
    performance.clearMarks(LIVE_TICK_START);
    const scheduler = new FakeScheduler();
    const { source, control } = fakeSource(messageRows(5), { state: "running", released: 3 });
    const controller = createDataController({ source, pollMs: 1_000, scheduler, isHidden: () => false });
    controller.start();
    await scheduler.run(100);
    expect(performance.getEntriesByName(LIVE_TICK_START, "mark")).toHaveLength(0);

    await scheduler.run(1_000);
    expect(performance.getEntriesByName(LIVE_TICK_START, "mark")).toHaveLength(0);

    control.released = 5;
    await scheduler.run(1_000);
    expect(controller.get().session?.loadedThroughSeq).toBe(5);
    expect(performance.getEntriesByName(LIVE_TICK_START, "mark")).toHaveLength(1);
    performance.clearMarks(LIVE_TICK_START);
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/shell/data-controller.test.ts`
Expected: FAIL with `Failed to resolve import "./data-controller.js"`.

- [ ] **Step 3: Implement the controller**

Create `packages/trace-viewer/src/ui/shell/data-controller.ts`:

```ts
import {
  TRACE_ROWS_PAGE_MAX,
  type AgentState,
  type TraceRow,
  type TraceRowsPage,
  type TraceSessionSummary,
} from "@jevcode/contracts";

import { accumulateAll, createTraceState, finalize, type TraceSession, type TraceState } from "../../model/index.js";
import { cursorAfter, type TraceSource } from "../../source.js";
import { TraceSourceError, type TraceChannel, type TraceSourceErrorCode } from "../../sources/errors.js";

export type DataStatus =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "reconnecting"; attempt: number; retryInMs: number }
  | { kind: "error"; channel: TraceChannel; code: TraceSourceErrorCode; message: string };

export interface DataSnapshot {
  summary: TraceSessionSummary | null;
  /** null until the first page folds. */
  session: TraceSession | null;
  status: DataStatus;
  /** nextAfterSeq / lastSeq while paging; 1 once caught up. */
  loadedFraction: number;
  terminal: boolean;
  /** Rows folded so far (TraceState.received); ViewerHost.onReady reports it. */
  rows: number;
}

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export interface DataControllerOptions {
  source: TraceSource;
  pollMs: number;
  /** Default TRACE_ROWS_PAGE_MAX. */
  pageSize?: number;
  /** Default 4 (spec §7.11 Progressive). */
  maxCommitsPerSecond?: number;
  scheduler?: Scheduler;
  /** Default document.visibilityState === "hidden". */
  isHidden?(): boolean;
}

export const BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 10_000];

export interface DataController {
  start(): void;
  stop(): void;
  retry(): void;
  /** While held, new snapshots queue and the latest applies on release (gesture hold). */
  hold(held: boolean): void;
  notifyVisible(): void;
  subscribe(listener: (snapshot: DataSnapshot) => void): () => void;
  get(): DataSnapshot;
  payloads(seqs: readonly number[]): Promise<TraceRow[]>;
  /** The source clock, epoch ms (TraceSource.now). */
  now(): number;
}

/** Spec §7.10: terminal(state) = completed or failed. */
export function isTerminalState(state: AgentState): boolean {
  return state === "completed" || state === "failed";
}

/** Spec §7.10: starting, running and waiting_decision open in Live. */
export function isLiveState(state: AgentState): boolean {
  return state === "starting" || state === "running" || state === "waiting_decision";
}

/** Spec §10 live tick start; C2-3's Shell measures PERF.liveTick from it (lane 08 D-8 reads the measure). */
export const LIVE_TICK_START = "tv:live-tick-start";

function markLiveTickStart(): void {
  if (typeof performance === "undefined" || typeof performance.mark !== "function") return;
  performance.clearMarks(LIVE_TICK_START);
  performance.mark(LIVE_TICK_START);
}

const EMPTY: DataSnapshot = {
  summary: null,
  session: null,
  status: { kind: "loading" },
  loadedFraction: 0,
  terminal: false,
  rows: 0,
};

function realScheduler(): Scheduler {
  return {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => performance.now(),
  };
}

function statusFromError(error: unknown, channel: TraceChannel): DataStatus {
  if (error instanceof TraceSourceError) {
    return { kind: "error", channel: error.channel, code: error.code, message: error.message };
  }
  return {
    kind: "error",
    channel,
    code: "SOURCE_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}

/** Folds with createTraceState/accumulateAll/finalize({live: !terminal, state, throughSeq: cursorAfter(page), nowMs: source.now()}); tags requests with a monotonic generation and drops stale responses. */
export function createDataController(options: DataControllerOptions): DataController {
  const { source, pollMs } = options;
  const pageSize = options.pageSize ?? TRACE_ROWS_PAGE_MAX;
  const minCommitGapMs = 1_000 / (options.maxCommitsPerSecond ?? 4);
  const scheduler = options.scheduler ?? realScheduler();
  const isHidden =
    options.isHidden ?? (() => typeof document !== "undefined" && document.visibilityState === "hidden");
  const listeners = new Set<(snapshot: DataSnapshot) => void>();

  let latest = EMPTY;
  let visible = EMPTY;
  let held = false;
  let running = false;
  let generation = 0;
  let fold: TraceState | null = null;
  let cursor = 0;
  let lastPage: TraceRowsPage | null = null;
  let lastCommitAt = Number.NEGATIVE_INFINITY;
  let commitTimer: unknown = null;
  let commitCaughtUp = false;
  let pollTimer: unknown = null;
  let failures = 0;

  function flush(): void {
    if (visible === latest) return;
    visible = latest;
    for (const listener of [...listeners]) listener(visible);
  }

  function emit(next: DataSnapshot): void {
    latest = next;
    if (!held && !isHidden()) flush();
  }

  function clearTimers(): void {
    if (commitTimer !== null) scheduler.clearTimeout(commitTimer);
    if (pollTimer !== null) scheduler.clearTimeout(pollTimer);
    commitTimer = null;
    pollTimer = null;
  }

  function commitNow(caughtUp: boolean): void {
    if (fold === null || lastPage === null) return;
    const page = lastPage;
    const session = finalize(fold, {
      live: !isTerminalState(page.state),
      state: page.state,
      throughSeq: cursor,
      nowMs: source.now(),
    });
    lastCommitAt = scheduler.now();
    failures = 0;
    emit({
      summary: latest.summary,
      session,
      status: { kind: "ready" },
      loadedFraction:
        caughtUp || page.lastSeq === 0 ? 1 : Math.min(1, (page.nextAfterSeq ?? page.lastSeq) / page.lastSeq),
      terminal: caughtUp && isTerminalState(page.state),
      rows: fold.received,
    });
  }

  function schedulePoll(gen: number, delayMs: number): void {
    if (pollTimer !== null) scheduler.clearTimeout(pollTimer);
    pollTimer = scheduler.setTimeout(() => {
      pollTimer = null;
      void poll(gen);
    }, delayMs);
  }

  function afterCommit(gen: number, caughtUp: boolean): void {
    if (gen !== generation || !caughtUp || lastPage === null) return;
    if (isTerminalState(lastPage.state)) return; // one final apply, then stop
    schedulePoll(gen, pollMs);
  }

  function requestCommit(gen: number, caughtUp: boolean): void {
    commitCaughtUp = caughtUp;
    if (commitTimer !== null) return; // the pending commit publishes the latest fold
    const wait = lastCommitAt + minCommitGapMs - scheduler.now();
    if (wait <= 0) {
      commitNow(caughtUp);
      afterCommit(gen, caughtUp);
      return;
    }
    commitTimer = scheduler.setTimeout(() => {
      commitTimer = null;
      if (gen !== generation) return;
      const done = commitCaughtUp;
      commitNow(done);
      afterCommit(gen, done);
    }, wait);
  }

  async function page(gen: number): Promise<void> {
    for (;;) {
      const next = await source.rows({ afterSeq: cursor, limit: pageSize });
      if (gen !== generation || fold === null) return;
      if (next.rows.length > 0 && latest.session !== null && latest.loadedFraction >= 1) markLiveTickStart();
      const changed =
        next.rows.length > 0 ||
        lastPage === null ||
        next.state !== lastPage.state ||
        next.lastSeq !== lastPage.lastSeq;
      accumulateAll(fold, next.rows);
      lastPage = next;
      cursor = cursorAfter(next);
      if (next.nextAfterSeq !== null) {
        requestCommit(gen, false);
        continue;
      }
      if (changed || latest.session === null || latest.status.kind !== "ready") {
        requestCommit(gen, true);
      } else {
        schedulePoll(gen, pollMs);
      }
      return;
    }
  }

  async function poll(gen: number): Promise<void> {
    try {
      await page(gen);
    } catch (error) {
      if (gen !== generation) return;
      if (latest.session === null) {
        emit({ ...latest, status: statusFromError(error, "trace:rows") });
        return;
      }
      failures += 1;
      const retryInMs = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1] ?? 10_000;
      emit({ ...latest, status: { kind: "reconnecting", attempt: failures, retryInMs } });
      schedulePoll(gen, retryInMs);
    }
  }

  async function load(gen: number): Promise<void> {
    let summary: TraceSessionSummary;
    try {
      summary = await source.summary();
    } catch (error) {
      if (gen === generation) emit({ ...latest, status: statusFromError(error, "trace:listSessions") });
      return;
    }
    if (gen !== generation) return;
    fold = createTraceState(summary);
    emit({ ...latest, summary });
    await poll(gen);
  }

  function reset(): void {
    clearTimers();
    generation += 1;
    fold = null;
    cursor = 0;
    lastPage = null;
    lastCommitAt = Number.NEGATIVE_INFINITY;
    commitCaughtUp = false;
    failures = 0;
  }

  return {
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
    retry() {
      if (!running) return;
      if (fold !== null && latest.session !== null) {
        clearTimers();
        generation += 1;
        void poll(generation);
        return;
      }
      reset();
      emit({ ...EMPTY, summary: latest.summary });
      void load(generation);
    },
    hold(next) {
      held = next;
      if (!held && !isHidden()) flush();
    },
    notifyVisible() {
      if (!held && !isHidden()) flush();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get: () => visible,
    payloads: (seqs) => source.payloads(seqs),
    now: () => source.now(),
  };
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/shell/data-controller.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Root checks**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/trace-viewer/src/ui/shell/data-controller.ts packages/trace-viewer/src/ui/shell/data-controller.test.ts
git commit -m "feat(trace-viewer): add the data controller with throttled paging, polling and backoff"
```

---
### Task C2-3: `TraceViewer`, `Shell` grid and landmarks, contexts, view registration API, `LiveRegion`, error boundaries, perf marks

**Files:**
- Create: `packages/trace-viewer/src/ui/shell/host.ts`
- Create: `packages/trace-viewer/src/ui/shell/session-context.ts`
- Create: `packages/trace-viewer/src/ui/shell/perf.ts`
- Create: `packages/trace-viewer/src/ui/shell/LiveRegion.tsx`
- Create: `packages/trace-viewer/src/ui/shell/ErrorBoundary.tsx`
- Create: `packages/trace-viewer/src/ui/shell/ViewSlot.tsx`
- Create: `packages/trace-viewer/src/ui/shell/Shell.tsx`
- Create: `packages/trace-viewer/src/ui/shell/Shell.module.css`
- Create: `packages/trace-viewer/src/ui/shell/TraceViewer.tsx`
- Create: `packages/trace-viewer/src/ui/views/view-port.ts`
- Create: `packages/trace-viewer/src/test-support/ui-harness.tsx` (deviation 3)
- Modify: `packages/trace-viewer/src/index.ts` (append four lines)
- Test: `packages/trace-viewer/src/ui/shell/shell.test.tsx`

**Interfaces:**
- Consumes:
  - C2-2: `createDataController`, `DataController`, `DataSnapshot`, `DataStatus`, `isLiveState`, `isTerminalState`.
  - C1b `layout/trace-index.ts`: `buildTraceIndex(session: TraceSession): TraceIndex`, `emptyTraceIndex(sessionId: string): TraceIndex`, `SelectionId`, `TraceIndex`.
  - C1b `layout/time-scale.ts`: `buildTimeScale(input: TimeScaleInput): TimeScale`, `timeScaleInputOf(session: TraceSession, liveTMs?: number): TimeScaleInput`.
  - C1b `layout/spine-rows.ts`: `buildSpineRows(session, index, scale, input: SpineRowsInput): SpineRow[]`.
  - C1b `ui/state/*`: `createViewStore(initial: ViewState, index: TraceIndex): ViewStore` (`get`, `subscribe`, `dispatch`, `setIndex`, `getIndex`), `ViewStoreContext`, `useViewStore()`, `useView(select, equal?)`, `useDispatch()`; `initialViewState({ live, location? }): ViewState`, `locationOf(state, sessionId): ViewerLocation`, `ViewKind`, `CanvasCamera`, `HybridCamera`; `ViewerLocation`. Actions used: `follow/set`, `session/applied`, `view/switch`.
  - C1a: `IconSprite(): JSX.Element`; `tokenStyle(tokens?: Tokens): Readonly<Record<\`--tv-${string}\`, string>>`; `base.module.css` `.root`; `IconName`.
  - B: `compareFindings(a: Finding, b: Finding): number`, `resolveStableId(session: TraceSession, id: StableId): ResolvedTarget | null`, `foldRows`, `StableId`, `TraceSession`; test-only `loadFixtureTrace(name: FixtureName): FixtureTrace`.
  - C1b `sources`: `createStaticBundleSource(bundle: TraceBundle, options?: { drip?: DripOptions }): StaticBundleSource`.
  - W0 contracts: `TRACE_LIVE_POLL_MS = 1_000`, `TRACE_BUNDLE_FORMAT`, `TRACE_BUNDLE_VERSION`, `TraceBundle`, `TraceRow`, `TraceSessionSummary`.
- Produces (UI index §2.4, plus deviations 4 and 5):

```ts
// ui/shell/host.ts
export interface RequestChangesRequest { sessionId: string; selected: SelectionId; text: string }
export interface ViewerReadyInfo { rows: number; loadedThroughSeq: number }
export interface ViewerDiagnostics { errors: string[]; maxAnchorDriftPx: number; selectedTitle: string | null }
export interface ViewerHost {
  requestChanges?(request: RequestChangesRequest): void | Promise<void>;
  onLocation?(location: ViewerLocation): void;
  onReady?(info: ViewerReadyInfo): void;
  onDiagnostics?(diagnostics: ViewerDiagnostics): void;
}
// ui/shell/TraceViewer.tsx
export interface TraceViewerProps { source: TraceSource; host?: ViewerHost; location?: ViewerLocation; pollMs?: number; initialFollow?: boolean }
export function TraceViewer(props: TraceViewerProps): React.JSX.Element;
// ui/shell/session-context.ts
export interface SessionView {
  summary: TraceSessionSummary | null; session: TraceSession | null; index: TraceIndex; scale: TimeScale;
  status: DataStatus; loadedFraction: number; terminal: boolean;
  nowT(): number; payloads(seqs: readonly number[]): Promise<TraceRow[]>; retry(): void;
}
export const SessionContext: React.Context<SessionView | null>;
export function useSessionView(): SessionView;
export interface DiagnosticsSink { readonly enabled: boolean; reportDrift(px: number): void; reportError(message: string): void; flush(): void }
export const DiagnosticsContext: React.Context<DiagnosticsSink>;
export function useDiagnostics(): DiagnosticsSink;
// ui/shell/Shell.tsx
export interface ShellProps { sessionId: string; host: ViewerHost; controller: DataController; location?: ViewerLocation; initialFollow?: boolean }
export function Shell(props: ShellProps): React.JSX.Element;
export function selectionFromStableId(session: TraceSession, id: StableId): SelectionId | null;
// ui/shell/LiveRegion.tsx
export interface AnnounceOptions { key?: string; minIntervalMs?: number }
export type Announce = (message: string, options?: AnnounceOptions) => void;
export const LiveRegionContext: React.Context<Announce>;
export function useAnnounce(): Announce;
export function LiveRegion(props: { children: React.ReactNode; onAnnounce?(message: string): void }): React.JSX.Element;
// ui/shell/ErrorBoundary.tsx
export interface ErrorBoundaryProps { region: string; children: React.ReactNode; action?: { label: string; onAction(): void }; onError?(error: Error): void }
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, { error: Error | null }>;
// ui/shell/ViewSlot.tsx
export interface ViewSlotProps { views: readonly ViewDefinition[]; keepHiddenMounted: boolean }
export function ViewSlot(props: ViewSlotProps): React.JSX.Element;
// ui/shell/perf.ts
export const PERF: { bundleParsed: "tv:bundle-parsed"; firstPaint: "tv:first-paint"; fullLoad: "tv:full-load"; keyToPaint: "tv:key-to-paint"; overviewPaint: "tv:overview-paint"; viewSwitch: "tv:view-switch"; liveTick: "tv:live-tick" };
export function markAfterPaint(name: string, startMark?: string): void;
export function measureAfterPaint(name: string, startMark: string): void;   // consumes startMark; no-op without one
export const INITIAL_SELECTION_PAINTED: "tv:initial-selection-painted";   // spec §1; not a PERF member (deviation 10)
export function markNextFrame(name: string): void;                        // performance.mark(name) in the next requestAnimationFrame callback
// ui/views/view-port.ts
export interface ZoomPreset { id: string; label: string }
export interface ZoomPort { label(): string; presets(): readonly ZoomPreset[]; applyPreset(id: string): void; zoomIn(): void; zoomOut(): void; resetToPreset(): void; fitAll(): void; fitSelection(): void }
export interface ViewPort { readingOrder(): readonly SelectionId[]; reveal(id: SelectionId, options: { animate: boolean }): void; captureCamera(): CanvasCamera | HybridCamera | null; focusSelected(): void; zoom: ZoomPort }
export interface ViewPortRegistry { register(kind: ViewKind, port: ViewPort): () => void; get(kind: ViewKind): ViewPort | undefined; notify(): void; subscribe(listener: () => void): () => void; version(): number }
export function createViewPortRegistry(): ViewPortRegistry;
export const ViewPortRegistryContext: React.Context<ViewPortRegistry | null>;
export function useViewPortRegistry(): ViewPortRegistry;
export function useRegisterViewPort(kind: ViewKind, port: ViewPort): void;
export function useActiveViewPort(): ViewPort | undefined;
export interface ViewProps { active: boolean }
export interface ViewDefinition { kind: ViewKind; label: string; icon: IconName; Component: React.ComponentType<ViewProps> }
export const ViewDefinitionsContext: React.Context<readonly ViewDefinition[]>;
// test-support/ui-harness.tsx (test-only)
export function fixtureTrace(name: FixtureName): FixtureTrace;
export function foldFixture(name: FixtureName): TraceSession;
export function fixtureBundle(name: FixtureName): TraceBundle;
export function payloadOf(row: TraceRow): Record<string, unknown>;
export interface LayoutStub { restore(): void; scrollCalls: Array<{ top?: number; left?: number }> }
export function stubLayout(options?: { width?: number; height?: number; rowHeight?: number }): LayoutStub;
export interface HarnessOptions { state?: Partial<ViewState>; status?: DataStatus; loadedFraction?: number; terminal?: boolean; nowT?: number; payloads?(seqs: readonly number[]): Promise<TraceRow[]>; views?: readonly ViewDefinition[]; diagnostics?: DiagnosticsSink }
export interface Harness { store: ViewStore; registry: ViewPortRegistry; view: SessionView; announcements: string[]; retries: { count: number }; wrap(node: React.ReactNode): React.ReactElement }
export function createHarness(session: TraceSession | null, options?: HarnessOptions): Harness;
export function renderHarness(node: React.ReactNode, session: TraceSession | null, options?: HarnessOptions): Harness & { result: RenderResult };
export function applyOpenDefaults(harness: Harness, session: TraceSession): void;
```

Region anchors in `Shell.tsx` that later tasks replace: `<header className={styles.title} data-region="title" />` (C2-4), `<nav className={styles.outline} aria-label="Outline" data-region="outline" />` (C2-5), `<aside className={styles.inspector} aria-label="Inspector" data-region="inspector" />` (C2-6), the `selectedTitleFor` body (C2-6), the root `<div … data-trace-viewer="">` (C2-8), and `const SHELL_VIEWS …` / `const KEEP_HIDDEN …` (C2-14).

- [ ] **Step 1: Write the test harness (test-only)**

Create `packages/trace-viewer/src/test-support/ui-harness.tsx`:

```tsx
// Test-only helpers for the lane C2 jsdom suites. Excluded from the build by tsconfig.build.json.
import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import {
  TRACE_BUNDLE_FORMAT,
  TRACE_BUNDLE_VERSION,
  type TraceBundle,
  type TraceRow,
} from "@jevcode/contracts";

import { buildTimeScale, timeScaleInputOf } from "../layout/time-scale.js";
import { buildTraceIndex, emptyTraceIndex } from "../layout/trace-index.js";
import { compareFindings, foldRows, type TraceSession } from "../model/index.js";
import { isTerminalState, type DataStatus } from "../ui/shell/data-controller.js";
import { LiveRegion } from "../ui/shell/LiveRegion.js";
import {
  DiagnosticsContext,
  SessionContext,
  type DiagnosticsSink,
  type SessionView,
} from "../ui/shell/session-context.js";
import { createViewStore, ViewStoreContext, type ViewStore } from "../ui/state/store.js";
import { initialViewState, type ViewState } from "../ui/state/view-state.js";
import {
  createViewPortRegistry,
  ViewDefinitionsContext,
  ViewPortRegistryContext,
  type ViewDefinition,
  type ViewPortRegistry,
} from "../ui/views/view-port.js";
import { loadFixtureTrace, type FixtureName, type FixtureTrace } from "./fixture-rows.js";

const traces = new Map<FixtureName, FixtureTrace>();
const folds = new Map<FixtureName, TraceSession>();

export function fixtureTrace(name: FixtureName): FixtureTrace {
  let trace = traces.get(name);
  if (trace === undefined) {
    trace = loadFixtureTrace(name);
    traces.set(name, trace);
  }
  return trace;
}

export function foldFixture(name: FixtureName): TraceSession {
  let session = folds.get(name);
  if (session === undefined) {
    const { meta, rows } = fixtureTrace(name);
    session = foldRows(meta, rows, { live: false });
    folds.set(name, session);
  }
  return session;
}

export function fixtureBundle(name: FixtureName): TraceBundle {
  const { meta, rows } = fixtureTrace(name);
  return {
    format: TRACE_BUNDLE_FORMAT,
    version: TRACE_BUNDLE_VERSION,
    exportedAt: "2026-09-28T00:00:00.000Z",
    redactionCount: 0,
    session: meta,
    rows,
  };
}

export function payloadOf(row: TraceRow): Record<string, unknown> {
  return row.payload !== null && typeof row.payload === "object" ? (row.payload as Record<string, unknown>) : {};
}

export interface LayoutStub {
  restore(): void;
  scrollCalls: Array<{ top?: number; left?: number }>;
}

/**
 * Per-test layout for jsdom (conventions 4): elements marked data-scroll-root or data-measure-root
 * measure width × height, every other element width × rowHeight. Call inside a test or beforeEach;
 * call restore() in afterEach. Installs nothing globally beyond that window.
 */
export function stubLayout(options: { width?: number; height?: number; rowHeight?: number } = {}): LayoutStub {
  const width = options.width ?? 1000;
  const height = options.height ?? 600;
  const rowHeight = options.rowHeight ?? 32;
  const sizeOf = (element: Element): { w: number; h: number } =>
    element.hasAttribute("data-scroll-root") || element.hasAttribute("data-measure-root")
      ? { w: width, h: height }
      : { w: width, h: rowHeight };

  const proto = Element.prototype;
  const originalRect = proto.getBoundingClientRect;
  const originalScrollTo = proto.scrollTo;
  const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  const originalObserver = globalThis.ResizeObserver;
  const scrollCalls: Array<{ top?: number; left?: number }> = [];

  proto.getBoundingClientRect = function getBoundingClientRect(this: Element): DOMRect {
    const { w, h } = sizeOf(this);
    return { x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h, toJSON: () => ({}) } as DOMRect;
  };
  proto.scrollTo = function scrollTo(this: Element, arg?: ScrollToOptions | number, y?: number): void {
    const target = typeof arg === "object" ? arg : { left: arg, top: y };
    scrollCalls.push({ top: target.top, left: target.left });
    if (target.top !== undefined) this.scrollTop = target.top;
  } as Element["scrollTo"];
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return sizeOf(this).w;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return sizeOf(this).h;
    },
  });
  class StubResizeObserver {
    private readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element): void {
      const { w, h } = sizeOf(target);
      const box = [{ inlineSize: w, blockSize: h }];
      const entry = {
        target,
        contentRect: target.getBoundingClientRect(),
        borderBoxSize: box,
        contentBoxSize: box,
        devicePixelContentBoxSize: box,
      } as unknown as ResizeObserverEntry;
      queueMicrotask(() => this.callback([entry], this as unknown as ResizeObserver));
    }
    unobserve(): void {
      return undefined;
    }
    disconnect(): void {
      return undefined;
    }
  }
  globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;

  return {
    scrollCalls,
    restore() {
      proto.getBoundingClientRect = originalRect;
      proto.scrollTo = originalScrollTo;
      if (offsetWidth !== undefined) Object.defineProperty(HTMLElement.prototype, "offsetWidth", offsetWidth);
      if (offsetHeight !== undefined) Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeight);
      globalThis.ResizeObserver = originalObserver;
    },
  };
}

export interface HarnessOptions {
  state?: Partial<ViewState>;
  status?: DataStatus;
  loadedFraction?: number;
  terminal?: boolean;
  nowT?: number;
  payloads?(seqs: readonly number[]): Promise<TraceRow[]>;
  views?: readonly ViewDefinition[];
  diagnostics?: DiagnosticsSink;
}

export interface Harness {
  store: ViewStore;
  registry: ViewPortRegistry;
  view: SessionView;
  announcements: string[];
  retries: { count: number };
  wrap(node: ReactNode): ReactElement;
}

const NO_DIAGNOSTICS: DiagnosticsSink = {
  enabled: false,
  reportDrift: () => undefined,
  reportError: () => undefined,
  flush: () => undefined,
};

export function createHarness(session: TraceSession | null, options: HarnessOptions = {}): Harness {
  const index = session === null ? emptyTraceIndex("sess-test") : buildTraceIndex(session);
  const scale = buildTimeScale(
    session === null ? { originMs: 0, work: [], awaitingFrom: [] } : timeScaleInputOf(session),
  );
  const store = createViewStore({ ...initialViewState({ live: false }), ...options.state }, index);
  const registry = createViewPortRegistry();
  const announcements: string[] = [];
  const retries = { count: 0 };
  const view: SessionView = {
    summary: session?.meta ?? null,
    session,
    index,
    scale,
    status: options.status ?? { kind: "ready" },
    loadedFraction: options.loadedFraction ?? 1,
    terminal: options.terminal ?? (session !== null && isTerminalState(session.meta.state)),
    nowT: () => options.nowT ?? 0,
    payloads: options.payloads ?? (async () => []),
    retry: () => {
      retries.count += 1;
    },
  };
  const wrap = (node: ReactNode): ReactElement => (
    <ViewStoreContext.Provider value={store}>
      <SessionContext.Provider value={view}>
        <DiagnosticsContext.Provider value={options.diagnostics ?? NO_DIAGNOSTICS}>
          <ViewPortRegistryContext.Provider value={registry}>
            <ViewDefinitionsContext.Provider value={options.views ?? []}>
              <LiveRegion onAnnounce={(message) => announcements.push(message)}>{node}</LiveRegion>
            </ViewDefinitionsContext.Provider>
          </ViewPortRegistryContext.Provider>
        </DiagnosticsContext.Provider>
      </SessionContext.Provider>
    </ViewStoreContext.Provider>
  );
  return { store, registry, view, announcements, retries, wrap };
}

export function renderHarness(
  node: ReactNode,
  session: TraceSession | null,
  options: HarnessOptions = {},
): Harness & { result: RenderResult } {
  const harness = createHarness(session, options);
  const result = render(harness.wrap(node));
  return { ...harness, result };
}

/** Dispatches the first complete session/applied the way the Shell does (spec §7.8 "Defaults on open"). */
export function applyOpenDefaults(harness: Harness, session: TraceSession): void {
  const top = [...session.findings].sort(compareFindings)[0];
  harness.store.dispatch({
    type: "session/applied",
    loadedThroughSeq: session.loadedThroughSeq,
    terminal: isTerminalState(session.meta.state),
    loadComplete: true,
    initialSelection: top?.anchorStepId ?? session.steps.at(-1)?.id ?? null,
    chapterSpineRows: 0,
  });
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/trace-viewer/src/ui/shell/shell.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStaticBundleSource } from "../../sources/static-bundle.js";
import {
  fixtureBundle,
  foldFixture,
  renderHarness,
  stubLayout,
  type LayoutStub,
} from "../../test-support/ui-harness.js";
import type { ViewerLocation } from "../state/location.js";
import type { ViewDefinition } from "../views/view-port.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { useAnnounce } from "./LiveRegion.js";
import { INITIAL_SELECTION_PAINTED } from "./perf.js";
import { TraceViewer } from "./TraceViewer.js";
import { ViewSlot } from "./ViewSlot.js";

let layout: LayoutStub;

beforeEach(() => {
  layout = stubLayout();
});

afterEach(() => {
  cleanup();
  layout.restore();
  vi.restoreAllMocks();
});

function Broken(): never {
  throw new Error("boom");
}

describe("Shell", () => {
  it("renders header, nav, main and aside landmarks with inline tokens", () => {
    const { container } = render(<TraceViewer source={createStaticBundleSource(fixtureBundle("oauth"))} />);
    expect(screen.getByRole("banner")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Outline" })).toBeTruthy();
    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Inspector" })).toBeTruthy();
    const root = container.querySelector<HTMLElement>("[data-trace-viewer]");
    expect(root?.style.getPropertyValue("--tv-accent")).toBe("#2F6BFF");
    expect(root?.style.getPropertyValue("--tv-ink-3")).toBe("#676D78");
  });

  it("calls onReady once with the row count after the first committed fold", async () => {
    const bundle = fixtureBundle("oauth");
    const onReady = vi.fn();
    render(<TraceViewer source={createStaticBundleSource(bundle)} host={{ onReady }} />);
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    expect(onReady).toHaveBeenCalledWith({ rows: bundle.rows.length, loadedThroughSeq: bundle.rows.at(-1)?.seq });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("resolves a decision: location to the decision step", async () => {
    const bundle = fixtureBundle("oauth");
    const decisionStep = foldFixture("oauth").steps.find((step) => step.kind === "decision");
    const decisionId = decisionStep?.decision?.decisionId;
    expect(decisionId).toBeDefined();
    const location: ViewerLocation = {
      v: 1,
      sessionId: bundle.session.sessionId,
      view: "hybrid",
      level: "chapter",
      brush: { kind: "session" },
      selected: `decision:${decisionId ?? ""}`,
    };
    const onLocation = vi.fn();
    render(<TraceViewer source={createStaticBundleSource(bundle)} location={location} host={{ onLocation }} />);
    await waitFor(() => expect(onLocation.mock.calls.at(-1)?.[0]?.selected).toBe(decisionStep?.id));
  });

  it("marks tv:initial-selection-painted in the first frame after the commit that applies the initial selection", async () => {
    performance.clearMarks(INITIAL_SELECTION_PAINTED);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => frames.push(callback));
    const runFrame = (): void => {
      for (const callback of frames.splice(0)) callback(performance.now());
    };
    // Spec §1: oauth opens with its claim step selected.
    const claim = foldFixture("oauth").steps.find((step) => step.text === "OAuth implementation complete; all checks pass.");
    expect(claim).toBeDefined();
    const onLocation = vi.fn();
    render(<TraceViewer source={createStaticBundleSource(fixtureBundle("oauth"))} host={{ onLocation }} />);
    await waitFor(() => expect(onLocation.mock.calls.at(-1)?.[0]?.selected).toBe(claim?.id));
    expect(performance.getEntriesByName(INITIAL_SELECTION_PAINTED, "mark")).toHaveLength(0);
    act(runFrame);
    expect(performance.getEntriesByName(INITIAL_SELECTION_PAINTED, "mark")).toHaveLength(1);
    act(runFrame);
    expect(performance.getEntriesByName(INITIAL_SELECTION_PAINTED, "mark")).toHaveLength(1);
  });

  it("sets no initial-selection mark when the session opens in Live", async () => {
    performance.clearMarks(INITIAL_SELECTION_PAINTED);
    const source = createStaticBundleSource(fixtureBundle("oauth"), {
      drip: { rowsPerTick: 5, intervalMs: 50, manual: true, startAtSeq: 30 },
    });
    const onReady = vi.fn();
    const onLocation = vi.fn();
    render(<TraceViewer source={source} pollMs={50} host={{ onReady, onLocation }} />);
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(onLocation.mock.calls.at(-1)?.[0]?.selected).toBeUndefined();
    expect(performance.getEntriesByName(INITIAL_SELECTION_PAINTED, "mark")).toHaveLength(0);
  });

  it("an Inspector render error shows the Inspector boundary and keeps the selection", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const session = foldFixture("oauth");
    const selected = session.steps[1]?.id ?? null;
    const h = renderHarness(
      <ErrorBoundary region="Inspector">
        <Broken />
      </ErrorBoundary>,
      session,
      { state: { selection: selected } },
    );
    expect(screen.getByRole("alert").textContent).toContain("Inspector failed to render");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(h.store.get().selection).toBe(selected);
  });

  it("a view boundary offers a switch to the other view", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const views: readonly ViewDefinition[] = [
      { kind: "canvas", label: "Canvas", icon: "view-canvas", Component: () => <p>canvas body</p> },
      { kind: "hybrid", label: "Hybrid", icon: "view-hybrid", Component: Broken },
    ];
    const h = renderHarness(<ViewSlot views={views} keepHiddenMounted={false} />, foldFixture("oauth"), {
      state: { view: "hybrid" },
    });
    expect(screen.getByRole("alert").textContent).toContain("Hybrid failed to render");
    fireEvent.click(screen.getByRole("button", { name: "Switch to Canvas" }));
    expect(h.store.get().view).toBe("canvas");
    expect(screen.getByText("canvas body")).toBeTruthy();
  });

  it("announces through one polite live region and throttles by key", () => {
    let announce: ReturnType<typeof useAnnounce> = () => undefined;
    function Grab(): null {
      announce = useAnnounce();
      return null;
    }
    const h = renderHarness(<Grab />, null);
    act(() => {
      announce("Live follow paused");
      announce("3 new steps", { key: "new", minIntervalMs: 10_000 });
      announce("4 new steps", { key: "new", minIntervalMs: 10_000 });
    });
    expect(h.announcements).toEqual(["Live follow paused", "3 new steps"]);
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
    expect(screen.getByRole("status").textContent).toBe("3 new steps");
  });
});
```

- [ ] **Step 3: Run the test to see it fail**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/shell/shell.test.tsx`
Expected: FAIL with `Failed to resolve import "../ui/shell/LiveRegion.js"` (from the harness).

- [ ] **Step 4: Write the host types, contexts, perf marks and live region**

Create `packages/trace-viewer/src/ui/shell/host.ts`:

```ts
import type { SelectionId } from "../../layout/trace-index.js";
import type { ViewerLocation } from "../state/location.js";

export interface RequestChangesRequest {
  sessionId: string;
  selected: SelectionId;
  text: string;
}

export interface ViewerReadyInfo {
  rows: number;
  loadedThroughSeq: number;
}

export interface ViewerDiagnostics {
  errors: string[];
  maxAnchorDriftPx: number;
  selectedTitle: string | null;
}

/** The viewer's only outbound surface. The viewer never writes; requestChanges focuses the main window's composer (M5). */
export interface ViewerHost {
  requestChanges?(request: RequestChangesRequest): void | Promise<void>;
  onLocation?(location: ViewerLocation): void;
  /** Once, after the first committed fold. */
  onReady?(info: ViewerReadyInfo): void;
  /** Dev-host selftest only; enables anchor-drift measurement. */
  onDiagnostics?(diagnostics: ViewerDiagnostics): void;
}
```

Create `packages/trace-viewer/src/ui/shell/session-context.ts`:

```ts
import { createContext, useContext } from "react";

import type { TraceRow, TraceSessionSummary } from "@jevcode/contracts";

import type { TimeScale } from "../../layout/time-scale.js";
import type { TraceIndex } from "../../layout/trace-index.js";
import type { TraceSession } from "../../model/index.js";
import type { DataStatus } from "./data-controller.js";

export interface SessionView {
  summary: TraceSessionSummary | null;
  session: TraceSession | null;
  index: TraceIndex;
  scale: TimeScale;
  status: DataStatus;
  loadedFraction: number;
  terminal: boolean;
  /** Display-clock now: source.now() − originMs. */
  nowT(): number;
  payloads(seqs: readonly number[]): Promise<TraceRow[]>;
  retry(): void;
}

export const SessionContext = createContext<SessionView | null>(null);

export function useSessionView(): SessionView {
  const view = useContext(SessionContext);
  if (view === null) throw new Error("useSessionView must be used inside the trace viewer Shell");
  return view;
}

/** Selftest diagnostics (spec §11 visual smoke). Disabled unless the host passes onDiagnostics. */
export interface DiagnosticsSink {
  readonly enabled: boolean;
  reportDrift(px: number): void;
  reportError(message: string): void;
  flush(): void;
}

export const DiagnosticsContext = createContext<DiagnosticsSink>({
  enabled: false,
  reportDrift: () => undefined,
  reportError: () => undefined,
  flush: () => undefined,
});

export function useDiagnostics(): DiagnosticsSink {
  return useContext(DiagnosticsContext);
}
```

Create `packages/trace-viewer/src/ui/shell/perf.ts`:

```ts
export const PERF = {
  bundleParsed: "tv:bundle-parsed",
  firstPaint: "tv:first-paint",
  fullLoad: "tv:full-load",
  keyToPaint: "tv:key-to-paint",
  overviewPaint: "tv:overview-paint",
  viewSwitch: "tv:view-switch",
  liveTick: "tv:live-tick",
} as const;

/**
 * Spec §10 paint mark: posts a MessageChannel message from the next requestAnimationFrame
 * callback and marks `name` when it arrives, which runs after that frame's style, layout and
 * paint. With `startMark`, also records performance.measure(name, startMark, name).
 */
export function markAfterPaint(name: string, startMark?: string): void {
  if (
    typeof performance === "undefined" ||
    typeof requestAnimationFrame === "undefined" ||
    typeof MessageChannel === "undefined"
  ) {
    return;
  }
  requestAnimationFrame(() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      performance.mark(name);
      if (startMark !== undefined && performance.getEntriesByName(startMark, "mark").length > 0) {
        performance.measure(name, startMark, name);
      }
    };
    channel.port2.postMessage(null);
  });
}

/**
 * Consumes the latest `startMark` (reads it, then clears it, so a later snapshot without a new
 * start never reuses it) and records performance.measure(name) from it to the paint after the
 * next frame. No-op without a pending start mark. The spec §10 live tick uses it with the
 * DataController's LIVE_TICK_START.
 */
export function measureAfterPaint(name: string, startMark: string): void {
  if (
    typeof performance === "undefined" ||
    typeof requestAnimationFrame === "undefined" ||
    typeof MessageChannel === "undefined"
  ) {
    return;
  }
  const start = performance.getEntriesByName(startMark, "mark").at(-1);
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

/**
 * Spec §1 "found at once": the Shell marks this in the first requestAnimationFrame after the commit
 * that applies the initial selection; smoke.mjs reads getEntriesByName(…)[0].startTime ≤ 5000.
 * Not a PERF member: PERF names the spec §10 measures (deviation 10).
 */
export const INITIAL_SELECTION_PAINTED = "tv:initial-selection-painted";

/** Marks `name` inside the next requestAnimationFrame callback. */
export function markNextFrame(name: string): void {
  if (typeof performance === "undefined" || typeof requestAnimationFrame === "undefined") return;
  requestAnimationFrame(() => {
    performance.mark(name);
  });
}
```

Create `packages/trace-viewer/src/ui/shell/LiveRegion.tsx`:

```tsx
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

import styles from "./Shell.module.css";

export interface AnnounceOptions {
  /** Throttle key: one announcement per key per minIntervalMs. */
  key?: string;
  minIntervalMs?: number;
}

export type Announce = (message: string, options?: AnnounceOptions) => void;

export const LiveRegionContext = createContext<Announce>(() => undefined);

export function useAnnounce(): Announce {
  return useContext(LiveRegionContext);
}

/** The one polite aria-live region (spec §7.13): view switches, live follow, new steps, findings, copies. */
export function LiveRegion({ children, onAnnounce }: { children: ReactNode; onAnnounce?(message: string): void }) {
  const [message, setMessage] = useState("");
  const lastByKey = useRef(new Map<string, number>());
  const announce = useCallback<Announce>(
    (text, options) => {
      if (options?.key !== undefined) {
        const now = Date.now();
        const last = lastByKey.current.get(options.key);
        if (last !== undefined && now - last < (options.minIntervalMs ?? 0)) return;
        lastByKey.current.set(options.key, now);
      }
      onAnnounce?.(text);
      // A trailing no-break space makes a repeated message a new text node, so it is read again.
      setMessage((previous) => (previous === text ? `${text}\u00a0` : text));
    },
    [onAnnounce],
  );
  return (
    <LiveRegionContext.Provider value={announce}>
      {children}
      <div role="status" aria-live="polite" className={styles.srOnly}>
        {message}
      </div>
    </LiveRegionContext.Provider>
  );
}
```

- [ ] **Step 5: Write the error boundary, the view registration API and the view slot**

Create `packages/trace-viewer/src/ui/shell/ErrorBoundary.tsx`:

```tsx
import { Component, type ReactNode } from "react";

import styles from "./Shell.module.css";

export interface ErrorBoundaryProps {
  /** Region name, shown as "<region> failed to render". */
  region: string;
  children: ReactNode;
  /** A second way out, e.g. "Switch to Canvas". */
  action?: { label: string; onAction(): void };
  onError?(error: Error): void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** Per-region boundary (spec §7.11 Errors). The store is outside it, so selection survives a crash. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error): void {
    this.props.onError?.(error);
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    const { action, region } = this.props;
    return (
      <div role="alert" className={styles.boundary}>
        <p className={styles.boundaryText}>{`${region} failed to render`}</p>
        <div className={styles.boundaryActions}>
          {action === undefined ? null : (
            <button type="button" className={styles.button} onClick={action.onAction}>
              {action.label}
            </button>
          )}
          <button type="button" className={styles.button} onClick={() => this.setState({ error: null })}>
            Retry
          </button>
        </div>
      </div>
    );
  }
}
```

Create `packages/trace-viewer/src/ui/views/view-port.ts`:

```ts
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useSyncExternalStore,
  type ComponentType,
} from "react";

import type { SelectionId } from "../../layout/trace-index.js";
import type { IconName } from "../icons/icon-names.js";
import { useView } from "../state/store.js";
import type { CanvasCamera, HybridCamera, ViewKind } from "../state/view-state.js";

export interface ZoomPreset {
  id: string;
  label: string;
}

export interface ZoomPort {
  label(): string;
  presets(): readonly ZoomPreset[];
  applyPreset(id: string): void;
  zoomIn(): void;
  zoomOut(): void;
  resetToPreset(): void;
  fitAll(): void;
  fitSelection(): void;
}

export interface ViewPort {
  /** j/k order; an unknown id falls back to its ancestor (step → unit). */
  readingOrder(): readonly SelectionId[];
  reveal(id: SelectionId, options: { animate: boolean }): void;
  captureCamera(): CanvasCamera | HybridCamera | null;
  focusSelected(): void;
  zoom: ZoomPort;
}

export interface ViewPortRegistry {
  register(kind: ViewKind, port: ViewPort): () => void;
  get(kind: ViewKind): ViewPort | undefined;
  /** Views call notify() when their zoom label changes. */
  notify(): void;
  subscribe(listener: () => void): () => void;
  /** Bumped by register, unregister and notify. */
  version(): number;
}

export function createViewPortRegistry(): ViewPortRegistry {
  const ports = new Map<ViewKind, ViewPort>();
  const listeners = new Set<() => void>();
  let version = 0;
  const notify = (): void => {
    version += 1;
    for (const listener of [...listeners]) listener();
  };
  return {
    register(kind, port) {
      ports.set(kind, port);
      notify();
      return () => {
        if (ports.get(kind) === port) {
          ports.delete(kind);
          notify();
        }
      };
    },
    get: (kind) => ports.get(kind),
    notify,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => version,
  };
}

export const ViewPortRegistryContext = createContext<ViewPortRegistry | null>(null);

export function useViewPortRegistry(): ViewPortRegistry {
  const registry = useContext(ViewPortRegistryContext);
  if (registry === null) throw new Error("useViewPortRegistry must be used inside the trace viewer Shell");
  return registry;
}

export function useRegisterViewPort(kind: ViewKind, port: ViewPort): void {
  const registry = useContext(ViewPortRegistryContext);
  useEffect(() => (registry === null ? undefined : registry.register(kind, port)), [registry, kind, port]);
}

/** The shown view's port; re-renders on register, unregister and notify. */
export function useActiveViewPort(): ViewPort | undefined {
  const registry = useViewPortRegistry();
  const view = useView((state) => state.view);
  const subscribe = useCallback((listener: () => void) => registry.subscribe(listener), [registry]);
  useSyncExternalStore(subscribe, registry.version, registry.version);
  return registry.get(view);
}

export interface ViewProps {
  active: boolean;
}

export interface ViewDefinition {
  kind: ViewKind;
  label: string;
  icon: IconName;
  Component: ComponentType<ViewProps>;
}

/** The views the Shell mounts, in switch order (Canvas | Hybrid). */
export const ViewDefinitionsContext = createContext<readonly ViewDefinition[]>([]);
```

Create `packages/trace-viewer/src/ui/shell/ViewSlot.tsx`:

```tsx
import { Activity } from "react";

import { useDispatch, useView } from "../state/store.js";
import type { ViewDefinition } from "../views/view-port.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { useDiagnostics } from "./session-context.js";
import styles from "./Shell.module.css";

export interface ViewSlotProps {
  views: readonly ViewDefinition[];
  /** true: hidden views stay mounted under <Activity mode="hidden"> (spec §7.8 item 4). */
  keepHiddenMounted: boolean;
}

export function ViewSlot({ views, keepHiddenMounted }: ViewSlotProps) {
  const current = useView((state) => state.view);
  const dispatch = useDispatch();
  const diagnostics = useDiagnostics();
  const shown = views.some((view) => view.kind === current) ? current : views[0]?.kind;
  if (views.length === 0) return <div className={styles.emptyView} />;
  return (
    <>
      {views.map((definition) => {
        const active = definition.kind === shown;
        if (!active && !keepHiddenMounted) return null;
        const other = views.find((view) => view.kind !== definition.kind);
        const body = (
          <div className={styles.view} data-view={definition.kind}>
            <ErrorBoundary
              region={definition.label}
              onError={(error) => diagnostics.reportError(`${definition.label}: ${error.message}`)}
              action={
                other === undefined
                  ? undefined
                  : { label: `Switch to ${other.label}`, onAction: () => dispatch({ type: "view/switch", view: other.kind }) }
              }
            >
              <definition.Component active={active} />
            </ErrorBoundary>
          </div>
        );
        return keepHiddenMounted ? (
          <Activity key={definition.kind} mode={active ? "visible" : "hidden"}>
            {body}
          </Activity>
        ) : (
          <div key={definition.kind} className={styles.view}>
            {body}
          </div>
        );
      })}
    </>
  );
}
```

- [ ] **Step 6: Write the Shell, its CSS and `TraceViewer`**

Create `packages/trace-viewer/src/ui/shell/Shell.module.css`:

```css
.root {
  container-type: inline-size;
  position: relative;
  height: 100%;
  min-height: 0;
}

.grid {
  display: grid;
  grid-template-columns: 216px minmax(0, 1fr) 280px;
  grid-template-rows: 40px minmax(0, 1fr);
  grid-template-areas:
    "title title title"
    "outline main inspector";
  height: 100%;
  min-height: 0;
  background: var(--tv-panel);
}

@container (max-width: 1179px) {
  .grid {
    grid-template-columns: 200px minmax(0, 1fr) 248px;
  }
}

.title {
  grid-area: title;
  min-width: 0;
  box-shadow: inset 0 -1px 0 var(--tv-hair);
}

.outline {
  grid-area: outline;
  min-height: 0;
  overflow: hidden;
  box-shadow: inset -1px 0 0 var(--tv-hair);
}

.main {
  grid-area: main;
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--tv-canvas);
  outline: none;
}

.inspector {
  grid-area: inspector;
  min-height: 0;
  overflow: hidden;
  box-shadow: inset 1px 0 0 var(--tv-hair);
}

.view {
  position: absolute;
  inset: 0;
}

.emptyView {
  height: 100%;
}

.boundary {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 16px;
}

.boundaryText {
  margin: 0;
  font-size: 13px;
  line-height: 18px;
  color: var(--tv-ink-2);
}

.boundaryActions {
  display: flex;
  gap: 8px;
}

.button {
  padding: 4px 10px;
  border: 0;
  border-radius: 6px;
  background: var(--tv-fill-2);
  color: var(--tv-ink);
  font: inherit;
  font-size: 12px;
  line-height: 16px;
  cursor: pointer;
}

.button:focus-visible {
  outline: 2px solid var(--tv-accent);
  outline-offset: 1px;
}

.srOnly {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
```

Create `packages/trace-viewer/src/ui/shell/Shell.tsx`:

```tsx
import {
  startTransition,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import { buildSpineRows } from "../../layout/spine-rows.js";
import { buildTimeScale, timeScaleInputOf, type TimeScale } from "../../layout/time-scale.js";
import {
  buildTraceIndex,
  emptyTraceIndex,
  type SelectionId,
  type TraceIndex,
} from "../../layout/trace-index.js";
import { compareFindings, resolveStableId, type StableId, type TraceSession } from "../../model/index.js";
import { IconSprite } from "../icons/IconSprite.js";
import type { ViewerLocation } from "../state/location.js";
import { useViewStore } from "../state/store.js";
import { locationOf } from "../state/view-state.js";
import base from "../tokens/base.module.css";
import { tokenStyle } from "../tokens/tokens.js";
import {
  createViewPortRegistry,
  ViewDefinitionsContext,
  ViewPortRegistryContext,
  type ViewDefinition,
} from "../views/view-port.js";
import { isLiveState, LIVE_TICK_START, type DataController, type DataSnapshot } from "./data-controller.js";
import type { ViewerHost } from "./host.js";
import { LiveRegion } from "./LiveRegion.js";
import { INITIAL_SELECTION_PAINTED, markAfterPaint, markNextFrame, measureAfterPaint, PERF } from "./perf.js";
import { DiagnosticsContext, SessionContext, type DiagnosticsSink, type SessionView } from "./session-context.js";
import styles from "./Shell.module.css";
import { ViewSlot } from "./ViewSlot.js";

export interface ShellProps {
  sessionId: string;
  host: ViewerHost;
  controller: DataController;
  location?: ViewerLocation;
  /** Overrides "running opens in Live" (the selftest drips in Review). */
  initialFollow?: boolean;
}

const EMPTY_SCALE_INPUT = { originMs: 0, work: [], awaitingFrom: [] } as const;

const SHELL_VIEWS: readonly ViewDefinition[] = [];
const KEEP_HIDDEN = true;

/** Maps a location's stable id to what the store selects: step and unit ids (spec §7.8). */
export function selectionFromStableId(session: TraceSession, id: StableId): SelectionId | null {
  const target = resolveStableId(session, id);
  if (target === null) return null;
  switch (target.kind) {
    case "step":
    case "decision":
      return target.step.id;
    case "unit":
      return target.chapter.id;
    case "file":
      return target.entity.stepIds.at(-1) ?? null;
    case "finding":
      return target.finding.anchorStepId;
  }
}

/** Spec §7.8 "Defaults on open": the location's selection, else the first finding under FINDING_ORDER, else the last step. */
function initialSelectionOf(session: TraceSession, location: ViewerLocation | undefined): SelectionId | null {
  if (location?.selected !== undefined) {
    const resolved = selectionFromStableId(session, location.selected as StableId);
    if (resolved !== null) return resolved;
  }
  const top = [...session.findings].sort(compareFindings)[0];
  if (top !== undefined) return top.anchorStepId;
  return session.steps.at(-1)?.id ?? null;
}

function chapterSpineRowCount(session: TraceSession, index: TraceIndex, scale: TimeScale, terminal: boolean): number {
  return buildSpineRows(session, index, scale, {
    brush: { kind: "session" },
    level: "chapter",
    playheadSeq: session.loadedThroughSeq,
    selection: null,
    expanded: new Set<string>(),
    collapsed: new Set<string>(),
    live: !terminal,
  }).length;
}

function originOf(session: TraceSession | null, snapshot: DataSnapshot): number {
  if (session !== null) return session.originMs;
  const started = snapshot.summary === null ? Number.NaN : Date.parse(snapshot.summary.startedAt);
  return Number.isFinite(started) ? started : 0;
}

function selectedTitleFor(
  _session: TraceSession | null,
  _index: TraceIndex,
  _selection: SelectionId | null,
): string | null {
  return null;
}

export function Shell({ sessionId, host, controller, location, initialFollow }: ShellProps) {
  const store = useViewStore();
  const [snapshot, setSnapshot] = useState<DataSnapshot>(() => controller.get());

  useEffect(() => {
    setSnapshot(controller.get());
    return controller.subscribe((next) => startTransition(() => setSnapshot(next)));
  }, [controller]);

  // Applies wait for a gesture to end (spec §7.10): a store gesture holds the controller.
  useEffect(() => {
    let held = false;
    const sync = (): void => {
      const next = store.get().gesture !== null;
      if (next !== held) {
        held = next;
        controller.hold(next);
      }
    };
    sync();
    return store.subscribe(sync);
  }, [store, controller]);

  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") controller.notifyVisible();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [controller]);

  const session = snapshot.session;
  const index = useMemo(
    () => (session === null ? emptyTraceIndex(sessionId) : buildTraceIndex(session)),
    [session, sessionId],
  );
  const scale = useMemo<TimeScale>(() => {
    if (session === null) return buildTimeScale(EMPTY_SCALE_INPUT);
    const lastT = session.steps.at(-1)?.tMs ?? 0;
    const liveTMs = session.live ? Math.max(lastT, controller.now() - session.originMs) : undefined;
    return buildTimeScale(timeScaleInputOf(session, liveTMs));
  }, [session, controller]);

  const sessionView = useMemo<SessionView>(() => {
    const origin = originOf(session, snapshot);
    return {
      summary: snapshot.summary,
      session,
      index,
      scale,
      status: snapshot.status,
      loadedFraction: snapshot.loadedFraction,
      terminal: snapshot.terminal,
      nowT: () => controller.now() - origin,
      payloads: (seqs) => controller.payloads(seqs),
      retry: () => controller.retry(),
    };
  }, [snapshot, session, index, scale, controller]);

  const registry = useMemo(() => createViewPortRegistry(), []);

  const current = useRef({ session, index });
  current.current = { session, index };
  const diagnosticsState = useRef({ errors: [] as string[], maxAnchorDriftPx: 0 });
  const diagnostics = useMemo<DiagnosticsSink>(() => {
    const flush = (): void => {
      if (host.onDiagnostics === undefined) return;
      const { session: s, index: i } = current.current;
      host.onDiagnostics({
        errors: [...diagnosticsState.current.errors],
        maxAnchorDriftPx: diagnosticsState.current.maxAnchorDriftPx,
        selectedTitle: selectedTitleFor(s, i, store.get().selection),
      });
    };
    return {
      enabled: host.onDiagnostics !== undefined,
      reportDrift(px) {
        diagnosticsState.current.maxAnchorDriftPx = Math.max(diagnosticsState.current.maxAnchorDriftPx, px);
        flush();
      },
      reportError(message) {
        diagnosticsState.current.errors.push(message);
        flush();
      },
      flush,
    };
  }, [host, store]);

  useEffect(() => (diagnostics.enabled ? store.subscribe(diagnostics.flush) : undefined), [diagnostics, store]);

  const opened = useRef({ follow: false, ready: false, fullLoad: false });
  useLayoutEffect(() => {
    const flags = opened.current;
    if (!flags.follow && snapshot.summary !== null) {
      flags.follow = true;
      store.dispatch({ type: "follow/set", follow: initialFollow ?? isLiveState(snapshot.summary.state) });
    }
    store.setIndex(index);
    if (session === null) return;
    const loadComplete = snapshot.loadedFraction >= 1;
    const needsDefaults = loadComplete && !store.get().loaded;
    const selectedBefore = store.get().selection;
    store.dispatch({
      type: "session/applied",
      loadedThroughSeq: session.loadedThroughSeq,
      terminal: snapshot.terminal,
      loadComplete,
      initialSelection: needsDefaults ? initialSelectionOf(session, location) : null,
      chapterSpineRows: needsDefaults ? chapterSpineRowCount(session, index, scale, snapshot.terminal) : 0,
    });
    // Spec §1: the dispatch re-renders the store's subscribers synchronously, before the next frame,
    // so the mark lands in the first rAF after the commit that applies the initial selection. A
    // session that opens in Live gets no initial selection and no mark.
    if (needsDefaults && selectedBefore === null && store.get().selection !== null) {
      markNextFrame(INITIAL_SELECTION_PAINTED);
    }
    if (!flags.ready) {
      flags.ready = true;
      host.onReady?.({ rows: snapshot.rows, loadedThroughSeq: session.loadedThroughSeq });
    }
    if (loadComplete && !flags.fullLoad) {
      flags.fullLoad = true;
      markAfterPaint(PERF.fullLoad, PERF.bundleParsed);
    } else if (flags.fullLoad) {
      // Spec §10 live tick (poll apply + selectors + commit), measured unconditionally: the
      // Electron trace window has no HUD and lane 08 D-8 reads tv:live-tick from it.
      measureAfterPaint(PERF.liveTick, LIVE_TICK_START);
    }
    diagnostics.flush();
  }, [snapshot, session, index, scale, store, host, location, initialFollow, diagnostics]);

  useEffect(() => {
    if (host.onLocation === undefined) return undefined;
    let last = "";
    const emit = (): void => {
      const next = locationOf(store.get(), sessionId);
      const key = JSON.stringify(next);
      if (key === last) return;
      last = key;
      host.onLocation?.(next);
    };
    emit();
    return store.subscribe(emit);
  }, [store, host, sessionId]);

  return (
    <div className={`${base.root} ${styles.root}`} style={tokenStyle() as CSSProperties} data-trace-viewer="">
      <IconSprite />
      <SessionContext.Provider value={sessionView}>
        <DiagnosticsContext.Provider value={diagnostics}>
          <ViewPortRegistryContext.Provider value={registry}>
            <ViewDefinitionsContext.Provider value={SHELL_VIEWS}>
              <LiveRegion>
                <div className={styles.grid}>
                  <header className={styles.title} data-region="title" />
                  <nav className={styles.outline} aria-label="Outline" data-region="outline" />
                  <main className={styles.main} data-region="main" tabIndex={-1}>
                    <ViewSlot views={SHELL_VIEWS} keepHiddenMounted={KEEP_HIDDEN} />
                  </main>
                  <aside className={styles.inspector} aria-label="Inspector" data-region="inspector" />
                </div>
              </LiveRegion>
            </ViewDefinitionsContext.Provider>
          </ViewPortRegistryContext.Provider>
        </DiagnosticsContext.Provider>
      </SessionContext.Provider>
    </div>
  );
}
```

Create `packages/trace-viewer/src/ui/shell/TraceViewer.tsx`:

```tsx
import { useEffect, useMemo, useState } from "react";

import { TRACE_LIVE_POLL_MS } from "@jevcode/contracts";

import { emptyTraceIndex } from "../../layout/trace-index.js";
import type { TraceSource } from "../../source.js";
import type { ViewerLocation } from "../state/location.js";
import { createViewStore, ViewStoreContext } from "../state/store.js";
import { initialViewState } from "../state/view-state.js";
import { createDataController } from "./data-controller.js";
import type { ViewerHost } from "./host.js";
import { Shell } from "./Shell.js";

export interface TraceViewerProps {
  source: TraceSource;
  host?: ViewerHost;
  location?: ViewerLocation;
  /** Poll interval while not terminal; default TRACE_LIVE_POLL_MS (1,000). */
  pollMs?: number;
  /** Overrides "running opens in Live"; the dev-host selftest passes false. */
  initialFollow?: boolean;
}

/** The viewer's only entry point. Reads through `source`; writes nothing. */
export function TraceViewer({ source, host, location, pollMs, initialFollow }: TraceViewerProps) {
  const [controller] = useState(() => createDataController({ source, pollMs: pollMs ?? TRACE_LIVE_POLL_MS }));
  const [store] = useState(() =>
    createViewStore(initialViewState({ live: false, location }), emptyTraceIndex(source.sessionId)),
  );
  const shellHost = useMemo<ViewerHost>(() => host ?? {}, [host]);

  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);

  return (
    <ViewStoreContext.Provider value={store}>
      <Shell
        sessionId={source.sessionId}
        host={shellHost}
        controller={controller}
        location={location}
        initialFollow={initialFollow}
      />
    </ViewStoreContext.Provider>
  );
}
```

Append to `packages/trace-viewer/src/index.ts`, after the line `export { ViewerLocationSchema, decodeLocation, locationFromHash, locationToHash, type ViewerLocation } from "./ui/state/location.js";`:

```ts
export { TraceViewer, type TraceViewerProps } from "./ui/shell/TraceViewer.js";
export type { ViewerHost, RequestChangesRequest, ViewerReadyInfo, ViewerDiagnostics } from "./ui/shell/host.js";
export type { SelectionId } from "./layout/trace-index.js";
export { INITIAL_SELECTION_PAINTED, PERF, markAfterPaint } from "./ui/shell/perf.js";
```

- [ ] **Step 7: Run the test to see it pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/shell/shell.test.tsx`
Expected: PASS, 8 tests.

- [ ] **Step 8: Root checks**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint`
Expected: exit 0. `ls packages/trace-viewer/dist/ui/shell/Shell.module.css` prints the path (copy-assets ran).

- [ ] **Step 9: Commit**

```bash
git add packages/trace-viewer/src/ui/shell/host.ts packages/trace-viewer/src/ui/shell/session-context.ts \
  packages/trace-viewer/src/ui/shell/perf.ts packages/trace-viewer/src/ui/shell/LiveRegion.tsx \
  packages/trace-viewer/src/ui/shell/ErrorBoundary.tsx packages/trace-viewer/src/ui/shell/ViewSlot.tsx \
  packages/trace-viewer/src/ui/shell/Shell.tsx packages/trace-viewer/src/ui/shell/Shell.module.css \
  packages/trace-viewer/src/ui/shell/TraceViewer.tsx packages/trace-viewer/src/ui/shell/shell.test.tsx \
  packages/trace-viewer/src/ui/views/view-port.ts packages/trace-viewer/src/test-support/ui-harness.tsx \
  packages/trace-viewer/src/index.ts
git commit -m "feat(trace-viewer): add TraceViewer, the shell grid, contexts and error boundaries"
```

---
### Task C2-4: `TitleBar`: title, chips, Review/Live, N new, duration, zoom menu, view switch slot

**Files:**
- Create: `packages/trace-viewer/src/ui/shell/TitleBar.tsx`
- Create: `packages/trace-viewer/src/ui/shell/TitleBar.module.css`
- Modify: `packages/trace-viewer/src/ui/shell/Shell.tsx` (deviation 2: mount the title bar)
- Test: `packages/trace-viewer/src/ui/shell/title-bar.test.tsx`

**Interfaces:**
- Consumes: C2-3 `useSessionView()`, `ViewDefinitionsContext`, `useActiveViewPort()`, `ErrorBoundary`; C2-2 `DataStatus`; C1b `useView`, `useDispatch`, `selectNewCount(state: ViewState, index: TraceIndex): number` and actions `follow/set`, `view/switch`, `select`, `nav/last`; C1a `Icon({ name, size })`; B `agentStateLabel(state: AgentState): string` ("Completed", "Working", …), `formatDuration(ms: number | null): string` (`45_000 → "45 s"`), `GapKind`, `TraceSession`.
- Produces:

```ts
export interface TitleBarProps { onRetry(): void }
export function TitleBar(props: TitleBarProps): React.JSX.Element;
/** Spec §7.1: max over steps of (tMs + (durationMs ?? 0)); never endedAt − startedAt. */
export function displaySpanMs(session: TraceSession): number;
```

- [ ] **Step 1: Write the failing test**

Create `packages/trace-viewer/src/ui/shell/title-bar.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TraceSession } from "../../model/index.js";
import { foldFixture, renderHarness, stubLayout, type LayoutStub } from "../../test-support/ui-harness.js";
import type { ViewDefinition } from "../views/view-port.js";
import { TitleBar } from "./TitleBar.js";

let layout: LayoutStub;
beforeEach(() => {
  layout = stubLayout();
});
afterEach(() => {
  cleanup();
  layout.restore();
});

const noop = (): void => undefined;
const hybrid: ViewDefinition = { kind: "hybrid", label: "Hybrid", icon: "view-hybrid", Component: () => null };
const canvas: ViewDefinition = { kind: "canvas", label: "Canvas", icon: "view-canvas", Component: () => null };

describe("TitleBar", () => {
  it("shows repoName / prompt with the full prompt in the tooltip", () => {
    const session = foldFixture("oauth");
    renderHarness(<TitleBar onRetry={noop} />, session);
    const title = screen.getByText(session.meta.repoName).closest("p");
    expect(title?.textContent).toBe(`${session.meta.repoName} / ${session.meta.prompt.split("\n")[0] ?? ""}`);
    expect(title?.getAttribute("title")).toBe(session.meta.prompt);
  });

  it("data-quality chips are neutral", () => {
    const base = foldFixture("oauth");
    const session: TraceSession = {
      ...base,
      coverage: { ...base.coverage, approximateJoins: true },
      gaps: [
        { kind: "invalid_row", atSeq: 5, message: "payload failed its schema" },
        { kind: "unpaired", atSeq: 9, message: "start without completion" },
        { kind: "missing_evidence", atSeq: 12, message: "claim without a repo fact" },
      ],
    };
    const h = renderHarness(<TitleBar onRetry={noop} />, session);
    const approx = screen.getByText("≈ Approximate joins");
    const gaps = screen.getByRole("button", { name: "3 gaps" });
    expect(approx.getAttribute("data-tone")).toBe("neutral");
    expect(gaps.getAttribute("data-tone")).toBe("neutral");

    fireEvent.click(gaps);
    fireEvent.click(screen.getByRole("button", { name: /^seq 9/ }));
    const expected = [...session.steps].reverse().find((step) => step.firstSeq <= 9)?.id;
    expect(h.store.get().selection).toBe(expected);
  });

  it("disables Live and labels it Completed on a terminal session", () => {
    renderHarness(<TitleBar onRetry={noop} />, foldFixture("oauth"));
    const live = screen.getByRole("button", { name: /Completed/ });
    expect(live.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: /Review/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("shows the N new pill with a red dot only when a new critical finding arrived", () => {
    const session = foldFixture("oauth");
    const critical = session.findings.filter((finding) => finding.severity === "critical").map((f) => f.anchorSeq);
    expect(critical.length).toBeGreaterThan(0);
    const lastStepSeq = session.steps.at(-1)?.firstSeq ?? 0;
    const seenAllCritical = Math.max(...critical);
    expect(seenAllCritical).toBeLessThan(lastStepSeq);

    renderHarness(<TitleBar onRetry={noop} />, session, { state: { follow: false, lastSeenSeq: seenAllCritical } });
    expect(screen.getByRole("button", { name: /new/ })).toBeTruthy();
    expect(screen.queryByTestId("new-critical-dot")).toBeNull();
    cleanup();

    renderHarness(<TitleBar onRetry={noop} />, session, { state: { follow: false, lastSeenSeq: Math.min(...critical) - 1 } });
    expect(screen.getByTestId("new-critical-dot")).toBeTruthy();
  });

  it("shows the display-clock span, never endedAt − startedAt", () => {
    const base = foldFixture("oauth");
    const session: TraceSession = {
      ...base,
      meta: { ...base.meta, endedAt: new Date(Date.parse(base.meta.startedAt) + 3_600_000).toISOString() },
    };
    renderHarness(<TitleBar onRetry={noop} />, session);
    expect(screen.getByText("45 s")).toBeTruthy();
    expect(screen.queryByText("1 h 00 m")).toBeNull();
  });

  it("shows Reconnecting with the attempt number", () => {
    renderHarness(<TitleBar onRetry={noop} />, foldFixture("oauth"), {
      status: { kind: "reconnecting", attempt: 2, retryInMs: 2_000 },
    });
    expect(screen.getByText("Reconnecting (2)")).toBeTruthy();
  });

  it("shows the channel, the message and Retry on a first-load error", () => {
    const onRetry = vi.fn();
    renderHarness(<TitleBar onRetry={onRetry} />, null, {
      status: { kind: "error", channel: "trace:rows", code: "SOURCE_FAILED", message: "socket closed" },
    });
    expect(screen.getByText("trace:rows: socket closed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders the view switch only when more than one view exists", () => {
    const session = foldFixture("oauth");
    renderHarness(<TitleBar onRetry={noop} />, session, { views: [hybrid] });
    expect(screen.queryByRole("radiogroup", { name: "View" })).toBeNull();
    cleanup();

    const h = renderHarness(<TitleBar onRetry={noop} />, session, { views: [canvas, hybrid] });
    expect(screen.getByRole("radiogroup", { name: "View" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Canvas/ }));
    expect(h.store.get().view).toBe("canvas");
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/shell/title-bar.test.tsx`
Expected: FAIL with `Failed to resolve import "./TitleBar.js"`.

- [ ] **Step 3: Implement the title bar**

Create `packages/trace-viewer/src/ui/shell/TitleBar.module.css`:

```css
.bar {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 40px;
  padding: 0 12px 0 16px;
  font-size: 13px;
  line-height: 18px;
}

.title {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.repo {
  color: var(--tv-ink-3);
}

.sep {
  color: var(--tv-ink-3);
}

.prompt {
  color: var(--tv-ink);
  font-weight: 500;
}

.chip {
  flex: none;
  padding: 2px 8px;
  border: 0;
  border-radius: 999px;
  background: var(--tv-fill-2);
  color: var(--tv-ink-2);
  font: inherit;
  font-size: 12px;
  line-height: 16px;
  white-space: nowrap;
}

button.chip {
  cursor: pointer;
}

.anchor {
  position: relative;
  flex: none;
}

.popover {
  position: absolute;
  top: 28px;
  left: 0;
  z-index: 10;
  min-width: 220px;
  margin: 0;
  padding: 4px;
  list-style: none;
  border-radius: 8px;
  background: var(--tv-panel);
  box-shadow: var(--tv-shadow);
}

.popoverItem {
  display: block;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--tv-ink);
  font: inherit;
  font-size: 12px;
  line-height: 16px;
  text-align: left;
  cursor: pointer;
}

.popoverItem:hover {
  background: var(--tv-fill);
}

.segmented {
  display: flex;
  flex: none;
  padding: 2px;
  border-radius: 8px;
  background: var(--tv-fill);
}

.segment {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--tv-ink-2);
  font: inherit;
  font-size: 12px;
  line-height: 16px;
  cursor: pointer;
}

.segment[aria-pressed="true"],
.segment[aria-checked="true"] {
  background: var(--tv-panel);
  color: var(--tv-ink);
  box-shadow: var(--tv-shadow);
}

.segment:disabled {
  cursor: default;
  color: var(--tv-ink-3);
}

.newPill {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  border: 0;
  border-radius: 999px;
  background: var(--tv-accent-soft);
  color: var(--tv-accent-ink);
  font: inherit;
  font-size: 12px;
  line-height: 16px;
  cursor: pointer;
}

.badDot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--tv-bad);
}

.meta {
  flex: none;
  color: var(--tv-ink-3);
  font-size: 12px;
  line-height: 16px;
  white-space: nowrap;
}

.duration {
  color: var(--tv-ink-2);
}

.retry,
.zoom {
  display: flex;
  flex: none;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 0;
  border-radius: 6px;
  background: var(--tv-fill);
  color: var(--tv-ink);
  font: inherit;
  font-size: 12px;
  line-height: 16px;
  cursor: pointer;
}

.menu {
  position: absolute;
  top: 28px;
  right: 0;
  z-index: 10;
  display: flex;
  flex-direction: column;
  min-width: 140px;
  padding: 4px;
  border-radius: 8px;
  background: var(--tv-panel);
  box-shadow: var(--tv-shadow);
}

.bar button:focus-visible {
  outline: 2px solid var(--tv-accent);
  outline-offset: 1px;
}
```

Create `packages/trace-viewer/src/ui/shell/TitleBar.tsx`:

```tsx
import { useContext, useEffect, useState } from "react";

import type { TraceSessionSummary } from "@jevcode/contracts";

import { agentStateLabel, formatDuration, type GapKind, type TraceSession } from "../../model/index.js";
import { Icon } from "../icons/Icon.js";
import { useDispatch, useView } from "../state/store.js";
import { selectNewCount } from "../state/view-state.js";
import { useActiveViewPort, ViewDefinitionsContext } from "../views/view-port.js";
import type { DataStatus } from "./data-controller.js";
import { useSessionView } from "./session-context.js";
import styles from "./TitleBar.module.css";

export interface TitleBarProps {
  onRetry(): void;
}

const GAP_LABEL: Record<GapKind, string> = {
  invalid_row: "row could not be read",
  unknown_row_type: "unknown row type",
  out_of_order: "row out of order",
  unpaired: "start without completion",
  missing_evidence: "missing evidence",
};

/** Spec §7.1: max over steps of (tMs + (durationMs ?? 0)); never endedAt − startedAt. */
export function displaySpanMs(session: TraceSession): number {
  let max = 0;
  for (const step of session.steps) max = Math.max(max, step.tMs + (step.durationMs ?? 0));
  return max;
}

function firstLine(text: string): string {
  const end = text.search(/\r?\n/);
  return end < 0 ? text : text.slice(0, end);
}

function statusText(status: DataStatus, loadedFraction: number, summary: TraceSessionSummary | null): string {
  switch (status.kind) {
    case "loading":
      return summary === null ? "Loading" : `Loading ${Math.floor(loadedFraction * 100)}%`;
    case "reconnecting":
      return `Reconnecting (${status.attempt})`;
    case "error":
      return `${status.channel}: ${status.message}`;
    case "ready":
      if (loadedFraction < 1) return `Loading ${Math.floor(loadedFraction * 100)}%`;
      return summary === null ? "" : agentStateLabel(summary.state);
  }
}

export function TitleBar({ onRetry }: TitleBarProps) {
  const { summary, session, index, status, loadedFraction, terminal, nowT } = useSessionView();
  const views = useContext(ViewDefinitionsContext);
  const dispatch = useDispatch();
  const view = useView((state) => state.view);
  const follow = useView((state) => state.follow);
  const lastSeenSeq = useView((state) => state.lastSeenSeq);
  const newCount = useView((state) => selectNewCount(state, index));
  const port = useActiveViewPort();
  const [gapsOpen, setGapsOpen] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const running = summary !== null && !terminal;
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(id);
  }, [running]);

  const spanMs = session === null ? 0 : displaySpanMs(session);
  const durationMs = running ? Math.max(spanMs, nowT()) : spanMs;
  const newProblems =
    session === null
      ? 0
      : session.findings.filter((finding) => finding.severity === "critical" && finding.anchorSeq > lastSeenSeq).length;
  const gaps = session?.gaps ?? [];
  const approximate = session?.coverage.approximateJoins ?? false;

  const jumpToSeq = (seq: number): void => {
    if (session === null) return;
    const step = session.steps[Math.max(0, index.stepIndexAtOrBefore(seq))];
    if (step !== undefined) dispatch({ type: "select", id: step.id, by: "shell" });
  };

  const goLive = (): void => {
    dispatch({ type: "nav/last" });
    if (running) dispatch({ type: "follow/set", follow: true });
  };

  return (
    <div className={styles.bar}>
      <p className={styles.title} title={summary?.prompt ?? ""}>
        {summary === null ? null : (
          <>
            <span className={styles.repo}>{summary.repoName}</span>
            <span className={styles.sep}> / </span>
            <span className={styles.prompt}>{firstLine(summary.prompt)}</span>
          </>
        )}
      </p>

      {approximate ? (
        <span
          className={styles.chip}
          data-tone="neutral"
          title="Some chapters were joined to steps by time window (session recorded before M1)"
        >
          ≈ Approximate joins
        </span>
      ) : null}

      {gaps.length > 0 ? (
        <span className={styles.anchor}>
          <button
            type="button"
            className={styles.chip}
            data-tone="neutral"
            aria-expanded={gapsOpen}
            onClick={() => setGapsOpen((open) => !open)}
          >
            {gaps.length === 1 ? "1 gap" : `${gaps.length} gaps`}
          </button>
          {gapsOpen ? (
            <ul className={styles.popover} aria-label="Gaps">
              {gaps.map((gap) => (
                <li key={`${gap.kind}:${gap.atSeq}`}>
                  <button
                    type="button"
                    className={styles.popoverItem}
                    onClick={() => {
                      jumpToSeq(gap.atSeq);
                      setGapsOpen(false);
                    }}
                  >
                    {`seq ${gap.atSeq} · ${GAP_LABEL[gap.kind]}`}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </span>
      ) : null}

      {views.length > 1 ? (
        <div role="radiogroup" aria-label="View" className={styles.segmented}>
          {views.map((definition, position) => (
            <button
              key={definition.kind}
              type="button"
              role="radio"
              aria-checked={definition.kind === view}
              className={styles.segment}
              title={`${definition.label} (${position + 1})`}
              onClick={() => dispatch({ type: "view/switch", view: definition.kind })}
            >
              <Icon name={definition.icon} size={14} />
              <span>{definition.label}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div role="group" aria-label="Follow" className={styles.segmented}>
        <button
          type="button"
          aria-pressed={!follow}
          className={styles.segment}
          onClick={() => dispatch({ type: "follow/set", follow: false })}
        >
          <Icon name="clock" size={14} />
          <span>Review</span>
        </button>
        <button
          type="button"
          aria-pressed={follow}
          className={styles.segment}
          disabled={!running}
          onClick={goLive}
        >
          <Icon name="live" size={14} />
          <span>{terminal && summary !== null ? agentStateLabel(summary.state) : "Live"}</span>
        </button>
      </div>

      {!follow && newCount > 0 ? (
        <button type="button" className={styles.newPill} onClick={goLive}>
          <span>{`${newCount} new`}</span>
          {newProblems > 0 ? (
            <span
              className={styles.badDot}
              role="img"
              aria-label="includes a critical finding"
              data-testid="new-critical-dot"
            />
          ) : null}
        </button>
      ) : null}

      <span className={styles.meta}>
        <span className={styles.duration}>{formatDuration(durationMs)}</span>
        <span aria-hidden="true"> · </span>
        <span>{statusText(status, loadedFraction, summary)}</span>
      </span>

      {status.kind === "error" ? (
        <button type="button" className={styles.retry} onClick={onRetry}>
          Retry
        </button>
      ) : null}

      {port === undefined ? null : (
        <span className={styles.anchor}>
          <button
            type="button"
            className={styles.zoom}
            aria-haspopup="menu"
            aria-expanded={zoomOpen}
            onClick={() => setZoomOpen((open) => !open)}
          >
            <span>{port.zoom.label()}</span>
            <Icon name="chev-d" size={12} />
          </button>
          {zoomOpen ? (
            <div role="menu" className={styles.menu}>
              {port.zoom.presets().map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  role="menuitem"
                  className={styles.popoverItem}
                  onClick={() => {
                    port.zoom.applyPreset(preset.id);
                    setZoomOpen(false);
                  }}
                >
                  {preset.label}
                </button>
              ))}
              <button type="button" role="menuitem" className={styles.popoverItem} onClick={() => port.zoom.zoomIn()}>
                Zoom in
              </button>
              <button type="button" role="menuitem" className={styles.popoverItem} onClick={() => port.zoom.zoomOut()}>
                Zoom out
              </button>
              <button type="button" role="menuitem" className={styles.popoverItem} onClick={() => port.zoom.fitAll()}>
                Fit all
              </button>
            </div>
          ) : null}
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Mount the title bar in the Shell**

In `packages/trace-viewer/src/ui/shell/Shell.tsx`, add two imports after `import { DiagnosticsContext, SessionContext, … } from "./session-context.js";`:

```tsx
import { ErrorBoundary } from "./ErrorBoundary.js";
import { TitleBar } from "./TitleBar.js";
```

and replace the anchor `<header className={styles.title} data-region="title" />` with:

```tsx
                  <header className={styles.title} data-region="title">
                    <ErrorBoundary region="Title bar">
                      <TitleBar onRetry={() => controller.retry()} />
                    </ErrorBoundary>
                  </header>
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/shell/title-bar.test.tsx src/ui/shell/shell.test.tsx`
Expected: PASS, 8 + 8 tests.

- [ ] **Step 6: Root checks**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint`
Expected: exit 0 (C1-1's `tokens.test.ts` also scans `TitleBar.module.css` for `color: var(--tv-ink-4)` and finds none).

- [ ] **Step 7: Commit**

```bash
git add packages/trace-viewer/src/ui/shell/TitleBar.tsx packages/trace-viewer/src/ui/shell/TitleBar.module.css \
  packages/trace-viewer/src/ui/shell/title-bar.test.tsx packages/trace-viewer/src/ui/shell/Shell.tsx
git commit -m "feat(trace-viewer): add the title bar with chips, follow toggle, new pill and zoom menu"
```

---

### Task C2-5: `Outline`: story tree, Files/Commands/Tests, search, virtualized tree

**Files:**
- Create: `packages/trace-viewer/src/ui/shell/Outline/outline-rows.ts`
- Create: `packages/trace-viewer/src/ui/shell/Outline/Outline.tsx`
- Create: `packages/trace-viewer/src/ui/shell/Outline/Outline.module.css`
- Modify: `packages/trace-viewer/src/ui/shell/Shell.tsx` (deviation 2: mount the Outline)
- Test: `packages/trace-viewer/src/ui/shell/Outline/outline-rows.test.ts`
- Test: `packages/trace-viewer/src/ui/shell/Outline/outline.test.tsx`

**Interfaces:**
- Consumes: B `formatOffset`, `normalizeCommand(command: string): string`, `exitLabel(exitCode: number | null): string` (`-1 → "exit unknown"`), `displayUntrusted(text: string, options?): string`, `pickGraphic(target: Step | Chapter, session): GraphicSpec | null`, `describeGraphic(spec: GraphicSpec): string` (`{kind: "tests", passed: 14, failed: 1, skipped: 0} → "14 passed, 1 failed"`), `buildSearchIndex(session): SearchIndex`, `searchSteps(index: SearchIndex, query: string): StepId[]`, types `Chapter`, `Finding`, `GraphicSpec`, `Step`, `TraceSession`, `UnitStableId`; C1a `Icon`, `Graphic({ spec, size, label? })`, `KIND_ICON`, `CATEGORY_ICON`, `IconName`; C1b `useView`, `useDispatch`, `selectEffectivePlayheadSeq(state, index): number`, `TraceIndex.chapterAtSeq(seq): Chapter | undefined`, `SelectionId`, actions `select`, `inspector/tab`, `search/set`, `search/next`, `esc`; C2-3 `useSessionView`, `ErrorBoundary`.
- Produces:

```ts
// ui/shell/Outline/outline-rows.ts
export type OutlineSection = "story" | "files" | "commands" | "tests";
export const SECTION_LABEL: Record<OutlineSection, string>;
export const FILES_COLLAPSE_ABOVE = 12;
export const DEFAULT_OPEN_SECTIONS: ReadonlySet<OutlineSection>;   // story, files, commands (Tests collapsed by default)
export type OutlineFlag = "shield" | "neq" | "x" | null;
export interface OutlineItemRow {
  t: "item"; key: string; section: OutlineSection; depth: 0 | 1; selId: SelectionId; icon: IconName;
  title: string; mono: boolean; tMs: number; flag: OutlineFlag; failed: boolean; muted: boolean;
  graphic: GraphicSpec | null; chapterId: UnitStableId | null; label: string; openEvidence: boolean;
}
export type OutlineRow =
  | { t: "section"; key: `section:${OutlineSection}`; section: OutlineSection; label: string; count: number; open: boolean }
  | { t: "turn"; key: `turn:${number}`; turn: number; label: string; tMs: number }
  | OutlineItemRow
  | { t: "more"; key: `more:${OutlineSection}`; section: OutlineSection; hidden: number };
export interface OutlineInput { open: ReadonlySet<OutlineSection>; showAll: ReadonlySet<OutlineSection> }
export function buildOutlineRows(session: TraceSession, input: OutlineInput): OutlineRow[];
/** Chapter titles and searchSteps matches; case-insensitive; every term required; chapters first. */
export function searchMatches(session: TraceSession, index: SearchIndex, query: string): SelectionId[];
// ui/shell/Outline/Outline.tsx
export interface OutlineProps { hiddenRows: number }
export function Outline(props: OutlineProps): React.JSX.Element;
```

Row rules (spec §7.1 Outline): Story holds Turn rows only when there is more than one turn ("Turn 2 · steer"); under each turn: Intent, current non-noise chapters and decisions in time order, one dim "Noise n" row, then the Final claim. Files: middle-truncated mono path, a shield when any of its chapters was clamped, `DiffBar xs`; more than 12 files collapse behind "Show n more". Commands: normalized command, ✕ plus the word "failed" for a failed run (never only a dot); exit −1 reads "exit unknown" and carries no flag. Tests: `TestDots xs`, collapsed by default. Story rows show offsets and one flag, no mini graphic; chapter rows carry the full description in their accessible name (deviation 6, spike risk 4).

- [ ] **Step 1: Write the failing pure test**

Create `packages/trace-viewer/src/ui/shell/Outline/outline-rows.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { buildSearchIndex, describeGraphic, foldRows, formatOffset, pickGraphic } from "../../../model/index.js";
import { TraceBuilder, testMeta } from "../../../test-support/trace-builder.js";
import { foldFixture } from "../../../test-support/ui-harness.js";
import {
  buildOutlineRows,
  DEFAULT_OPEN_SECTIONS,
  searchMatches,
  type OutlineItemRow,
  type OutlineRow,
  type OutlineSection,
} from "./outline-rows.js";

function itemsOf(rows: readonly OutlineRow[], section: OutlineSection): OutlineItemRow[] {
  return rows.filter((row): row is OutlineItemRow => row.t === "item" && row.section === section);
}

const ALL_OPEN = { open: new Set<OutlineSection>(["story", "files", "commands", "tests"]), showAll: new Set<OutlineSection>() };

describe("buildOutlineRows", () => {
  it("lists Intent, chapters and decisions in time order, one noise row, then the final claim", () => {
    const session = foldFixture("oauth");
    const rows = buildOutlineRows(session, { open: DEFAULT_OPEN_SECTIONS, showAll: new Set() });
    expect(rows.some((row) => row.t === "turn")).toBe(false);
    const story = itemsOf(rows, "story");
    expect(story[0]?.title).toBe("Intent");
    const ordered = story.filter((row) => !row.muted && row.title !== "Final claim").map((row) => row.tMs);
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
    expect(story.some((row) => row.icon === "fork")).toBe(true);
    expect(story.find((row) => row.muted)?.title).toBe("Noise 2");
    expect(story.at(-1)?.title).toBe("Final claim");
    expect(story.at(-1)?.flag).toBe("neq");
    expect(story.every((row) => row.graphic === null)).toBe(true);
  });

  it("adds turn rows only when there is more than one turn", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "First" });
    b.agent({ type: "agent_message", role: "assistant", text: "one" });
    b.agent({ type: "agent_completed" });
    b.agent({ type: "agent_started", prompt: "Second" });
    b.agent({ type: "agent_message", role: "assistant", text: "two" });
    b.agent({ type: "agent_completed" });
    const rows = buildOutlineRows(foldRows(testMeta(), b.rows, { live: false }), ALL_OPEN);
    const turns = rows.filter((row) => row.t === "turn");
    expect(turns.map((row) => (row.t === "turn" ? row.label : ""))).toEqual(["Turn 1 · initial", "Turn 2 · resume"]);
  });

  it("collapses Files above 12 and shows all on demand", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Touch files" });
    for (let i = 0; i < 13; i += 1) {
      b.fact({ type: "file_changed", path: `src/f${String(i).padStart(2, "0")}.ts`, kind: "modified" });
    }
    const session = foldRows(testMeta(), b.rows, { live: false });
    expect(session.entities).toHaveLength(13);
    const collapsed = buildOutlineRows(session, ALL_OPEN);
    expect(itemsOf(collapsed, "files")).toHaveLength(12);
    expect(collapsed.find((row) => row.t === "more")).toEqual({ t: "more", key: "more:files", section: "files", hidden: 1 });
    const all = buildOutlineRows(session, { ...ALL_OPEN, showAll: new Set<OutlineSection>(["files"]) });
    expect(itemsOf(all, "files")).toHaveLength(13);
    expect(itemsOf(all, "files").every((row) => row.mono && row.openEvidence)).toBe(true);
  });

  it("marks a failed command with ✕ and the word failed", () => {
    const rows = buildOutlineRows(foldFixture("oauth"), ALL_OPEN);
    const test = itemsOf(rows, "commands").find((row) => row.title === "pnpm test");
    expect(test?.flag).toBe("x");
    expect(test?.failed).toBe(true);
    expect(test?.label).toContain("failed");
    const install = itemsOf(rows, "commands").find((row) => row.title.startsWith("pnpm add"));
    expect(install?.flag).toBeNull();
  });

  it("exit -1 reads exit unknown and carries no failure flag", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Lint" });
    b.agent({ type: "command_started", command: "pnpm lint" });
    b.agent({ type: "command_completed", command: "pnpm lint", exitCode: -1, stdout: "", stderr: "" });
    b.agent({ type: "agent_completed" });
    const session = foldRows(testMeta(), b.rows, { live: false });
    expect(session.chapters).toHaveLength(0);
    const rows = buildOutlineRows(session, ALL_OPEN);
    const lint = itemsOf(rows, "commands")[0];
    expect(lint?.title).toBe("pnpm lint");
    expect(lint?.flag).toBeNull();
    expect(lint?.failed).toBe(false);
    expect(lint?.label).toContain("exit unknown");
    expect(itemsOf(rows, "story").some((row) => row.chapterId !== null)).toBe(false);
  });

  it("puts the full frame description in a chapter row's accessible name", () => {
    const session = foldFixture("oauth");
    const testsChapter = session.chapters.find((chapter) => chapter.category === "tests");
    expect(testsChapter).toBeDefined();
    const row = itemsOf(buildOutlineRows(session, ALL_OPEN), "story").find((item) => item.chapterId === testsChapter?.id);
    const graphic = testsChapter === undefined ? null : pickGraphic(testsChapter, session);
    expect(row?.label.startsWith(testsChapter?.title ?? "")).toBe(true);
    expect(row?.label).toContain(graphic === null ? "" : describeGraphic(graphic));
    expect(row?.label.endsWith(formatOffset(testsChapter?.tMs ?? 0))).toBe(true);
  });

  it("search matches chapter titles and step text with every term required", () => {
    const session = foldFixture("oauth");
    const index = buildSearchIndex(session);
    const matches = searchMatches(session, index, "PNPM test");
    const testStep = session.steps.find((step) => step.command?.command === "pnpm test");
    expect(matches).toContain(testStep?.id);
    expect(searchMatches(session, index, "pnpm zzzz-not-there")).toEqual([]);
    expect(searchMatches(session, index, "   ")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/shell/Outline/outline-rows.test.ts`
Expected: FAIL with `Failed to resolve import "./outline-rows.js"`.

- [ ] **Step 3: Implement the row builder**

Create `packages/trace-viewer/src/ui/shell/Outline/outline-rows.ts`:

```ts
import type { SelectionId } from "../../../layout/trace-index.js";
import {
  describeGraphic,
  displayUntrusted,
  exitLabel,
  formatOffset,
  normalizeCommand,
  pickGraphic,
  searchSteps,
  type Chapter,
  type Finding,
  type FindingId,
  type GraphicSpec,
  type SearchIndex,
  type Step,
  type StepId,
  type TraceSession,
  type UnitStableId,
} from "../../../model/index.js";
import type { IconName } from "../../icons/icon-names.js";
import { CATEGORY_ICON, KIND_ICON } from "../../icons/kind-icons.js";

export type OutlineSection = "story" | "files" | "commands" | "tests";

export const SECTION_LABEL: Record<OutlineSection, string> = {
  story: "Story",
  files: "Files",
  commands: "Commands",
  tests: "Tests",
};

export const FILES_COLLAPSE_ABOVE = 12;

export const DEFAULT_OPEN_SECTIONS: ReadonlySet<OutlineSection> = new Set<OutlineSection>(["story", "files", "commands"]);

export type OutlineFlag = "shield" | "neq" | "x" | null;

export interface OutlineItemRow {
  t: "item";
  key: string;
  section: OutlineSection;
  depth: 0 | 1;
  selId: SelectionId;
  icon: IconName;
  title: string;
  mono: boolean;
  tMs: number;
  flag: OutlineFlag;
  failed: boolean;
  muted: boolean;
  graphic: GraphicSpec | null;
  chapterId: UnitStableId | null;
  /** Accessible name. */
  label: string;
  /** Files rows open the Inspector's Evidence tab at the diff. */
  openEvidence: boolean;
}

export type OutlineRow =
  | { t: "section"; key: `section:${OutlineSection}`; section: OutlineSection; label: string; count: number; open: boolean }
  | { t: "turn"; key: `turn:${number}`; turn: number; label: string; tMs: number }
  | OutlineItemRow
  | { t: "more"; key: `more:${OutlineSection}`; section: OutlineSection; hidden: number };

export interface OutlineInput {
  open: ReadonlySet<OutlineSection>;
  showAll: ReadonlySet<OutlineSection>;
}

function isPresent<T>(value: T | undefined | null): value is T {
  return value !== undefined && value !== null;
}

function joinLabel(parts: ReadonlyArray<string | null | undefined | false>): string {
  return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(", ");
}

function chapterItem(
  chapter: Chapter,
  session: TraceSession,
  depth: 0 | 1,
  findingById: ReadonlyMap<FindingId, Finding>,
): OutlineItemRow {
  const findings = chapter.findingIds.map((id) => findingById.get(id)).filter(isPresent);
  const flag: OutlineFlag = findings.some((finding) => finding.ruleId === "claim_contradicted")
    ? "neq"
    : chapter.status === "failed"
      ? "x"
      : chapter.clampIds.length > 0
        ? "shield"
        : null;
  const graphic = pickGraphic(chapter, session);
  return {
    t: "item",
    key: chapter.id,
    section: "story",
    depth,
    selId: chapter.id,
    icon: CATEGORY_ICON[chapter.category],
    title: chapter.title,
    mono: false,
    tMs: chapter.tMs,
    flag,
    failed: flag === "x",
    muted: false,
    graphic: null,
    chapterId: chapter.id,
    label: joinLabel([chapter.title, graphic === null ? null : describeGraphic(graphic), formatOffset(chapter.tMs)]),
    openEvidence: false,
  };
}

function stepItem(
  step: Step,
  depth: 0 | 1,
  title: string,
  icon: IconName,
  flag: OutlineFlag,
  extra?: string,
): OutlineItemRow {
  return {
    t: "item",
    key: `story:${step.id}`,
    section: "story",
    depth,
    selId: step.id,
    icon,
    title,
    mono: false,
    tMs: step.tMs,
    flag,
    failed: false,
    muted: false,
    graphic: null,
    chapterId: null,
    label: joinLabel([title, extra, formatOffset(step.tMs)]),
    openEvidence: false,
  };
}

function storyRows(session: TraceSession): OutlineRow[] {
  const out: OutlineRow[] = [];
  const multi = session.turns.length > 1;
  const depth: 0 | 1 = multi ? 1 : 0;
  const stepById = new Map<StepId, Step>(session.steps.map((step) => [step.id, step]));
  const findingById = new Map<FindingId, Finding>(session.findings.map((finding) => [finding.id, finding]));
  for (const turn of session.turns) {
    const nextT = session.turns[turn.index + 1]?.tMs ?? Number.POSITIVE_INFINITY;
    const inTurn = (tMs: number): boolean => tMs >= turn.tMs && tMs < nextT;
    if (multi) {
      out.push({ t: "turn", key: `turn:${turn.index}`, turn: turn.index, label: `Turn ${turn.index + 1} · ${turn.trigger}`, tMs: turn.tMs });
    }
    const items: OutlineItemRow[] = [];
    const steps = turn.stepIds.map((id) => stepById.get(id)).filter(isPresent);
    const intent = steps.find((step) => step.kind === "instruction");
    if (intent !== undefined) items.push(stepItem(intent, depth, "Intent", "person", null));
    for (const chapter of session.chapters) {
      if (chapter.current && !chapter.noise && inTurn(chapter.tMs)) items.push(chapterItem(chapter, session, depth, findingById));
    }
    for (const step of steps) {
      if (step.kind === "decision") items.push(stepItem(step, depth, step.decision?.title ?? step.headline, "fork", null));
    }
    items.sort((a, b) => a.tMs - b.tMs || a.key.localeCompare(b.key));
    const noise = session.chapters.filter((chapter) => chapter.current && chapter.noise && inTurn(chapter.tMs));
    const firstNoise = noise[0];
    if (firstNoise !== undefined) {
      items.push({
        t: "item",
        key: `noise:${turn.index}`,
        section: "story",
        depth,
        selId: firstNoise.id,
        icon: "eyeoff",
        title: `Noise ${noise.length}`,
        mono: false,
        tMs: firstNoise.tMs,
        flag: null,
        failed: false,
        muted: true,
        graphic: null,
        chapterId: firstNoise.id,
        label: `Noise, ${noise.length} ${noise.length === 1 ? "chapter" : "chapters"}`,
        openEvidence: false,
      });
    }
    const claim = turn.claimStepId === undefined ? undefined : stepById.get(turn.claimStepId);
    if (claim !== undefined) {
      const contradicted = claim.findingIds.some((id) => findingById.get(id)?.ruleId === "claim_contradicted");
      items.push(stepItem(claim, depth, "Final claim", "quote", contradicted ? "neq" : null, contradicted ? "contradicts tests" : undefined));
    }
    out.push(...items);
  }
  return out;
}

function fileRows(session: TraceSession): OutlineItemRow[] {
  const clamped = new Set(session.chapters.filter((chapter) => chapter.clampIds.length > 0).map((chapter) => chapter.id));
  const stepById = new Map<StepId, Step>(session.steps.map((step) => [step.id, step]));
  const out: OutlineItemRow[] = [];
  for (const entity of session.entities) {
    const latest = entity.stepIds.at(-1);
    if (latest === undefined) continue;
    const graphic: GraphicSpec = { kind: "diff", added: entity.added, removed: entity.removed };
    out.push({
      t: "item",
      key: entity.id,
      section: "files",
      depth: 0,
      selId: latest,
      icon: "file",
      title: entity.label,
      mono: true,
      tMs: stepById.get(latest)?.tMs ?? 0,
      flag: entity.chapterIds.some((id) => clamped.has(id)) ? "shield" : null,
      failed: false,
      muted: false,
      graphic,
      chapterId: null,
      label: joinLabel([displayUntrusted(entity.path), describeGraphic(graphic)]),
      openEvidence: true,
    });
  }
  return out;
}

function commandTitle(step: Step): string {
  return displayUntrusted(normalizeCommand(step.command?.command ?? step.target ?? ""));
}

function commandRows(session: TraceSession): OutlineItemRow[] {
  return session.steps
    .filter((step) => step.command !== undefined && (step.kind === "command" || step.kind === "test" || step.kind === "check"))
    .map((step) => {
      const title = commandTitle(step);
      const failed = step.status === "failed";
      return {
        t: "item",
        key: `cmd:${step.id}`,
        section: "commands",
        depth: 0,
        selId: step.id,
        icon: KIND_ICON[step.kind],
        title,
        mono: true,
        tMs: step.tMs,
        flag: failed ? "x" : null,
        failed,
        muted: false,
        graphic: null,
        chapterId: null,
        label: joinLabel([title, failed ? "failed" : null, exitLabel(step.command?.exitCode ?? null), formatOffset(step.tMs)]),
        openEvidence: false,
      } satisfies OutlineItemRow;
    });
}

function testRows(session: TraceSession): OutlineItemRow[] {
  return session.steps
    .filter((step) => step.tests !== undefined)
    .map((step) => {
      const tests = step.tests ?? { passed: 0, failed: 0, skipped: 0 };
      const graphic: GraphicSpec = { kind: "tests", passed: tests.passed, failed: tests.failed, skipped: tests.skipped };
      const title = commandTitle(step);
      return {
        t: "item",
        key: `test:${step.id}`,
        section: "tests",
        depth: 0,
        selId: step.id,
        icon: KIND_ICON[step.kind],
        title,
        mono: true,
        tMs: step.tMs,
        flag: step.status === "failed" ? "x" : null,
        failed: step.status === "failed",
        muted: false,
        graphic,
        chapterId: null,
        label: joinLabel([title, describeGraphic(graphic), formatOffset(step.tMs)]),
        openEvidence: false,
      } satisfies OutlineItemRow;
    });
}

function pushSection(
  rows: OutlineRow[],
  section: OutlineSection,
  entries: readonly OutlineRow[],
  input: OutlineInput,
  cap?: number,
): void {
  const open = input.open.has(section);
  rows.push({
    t: "section",
    key: `section:${section}`,
    section,
    label: SECTION_LABEL[section],
    count: entries.filter((entry) => entry.t === "item").length,
    open,
  });
  if (!open) return;
  if (cap !== undefined && !input.showAll.has(section) && entries.length > cap) {
    rows.push(...entries.slice(0, cap));
    rows.push({ t: "more", key: `more:${section}`, section, hidden: entries.length - cap });
    return;
  }
  rows.push(...entries);
}

export function buildOutlineRows(session: TraceSession, input: OutlineInput): OutlineRow[] {
  const rows: OutlineRow[] = [];
  pushSection(rows, "story", storyRows(session), input);
  pushSection(rows, "files", fileRows(session), input, FILES_COLLAPSE_ABOVE);
  pushSection(rows, "commands", commandRows(session), input);
  pushSection(rows, "tests", testRows(session), input);
  return rows;
}

/** Chapter titles and searchSteps matches; case-insensitive; every term required; chapters first. */
export function searchMatches(session: TraceSession, index: SearchIndex, query: string): SelectionId[] {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 0);
  if (terms.length === 0) return [];
  const chapters = session.chapters
    .filter((chapter) => terms.every((term) => chapter.title.toLowerCase().includes(term)))
    .map((chapter) => chapter.id);
  return [...chapters, ...searchSteps(index, query)];
}
```

- [ ] **Step 4: Run the pure test to see it pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/shell/Outline/outline-rows.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the failing component test**

Create `packages/trace-viewer/src/ui/shell/Outline/outline.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTraceIndex } from "../../../layout/trace-index.js";
import { foldFixture, renderHarness, stubLayout, type LayoutStub } from "../../../test-support/ui-harness.js";
import { Outline } from "./Outline.js";

let layout: LayoutStub;
beforeEach(() => {
  layout = stubLayout({ height: 2_000, rowHeight: 28 });
});
afterEach(() => {
  cleanup();
  layout.restore();
});

describe("Outline", () => {
  it("selects a chapter row on click and marks it aria-selected", async () => {
    const session = foldFixture("oauth");
    const h = renderHarness(<Outline hiddenRows={2} />, session);
    await act(async () => undefined);
    const chapter = session.chapters.find((item) => item.current && !item.noise);
    const row = document.querySelector<HTMLElement>(`[data-key="${chapter?.id ?? ""}"]`);
    expect(row?.getAttribute("role")).toBe("treeitem");
    fireEvent.click(row as HTMLElement);
    expect(h.store.get().selection).toBe(chapter?.id);
    expect(document.querySelector(`[data-key="${chapter?.id ?? ""}"]`)?.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("2 pipeline rows hidden")).toBeTruthy();
  });

  it("marks the chapter under the playhead with aria-current", async () => {
    const session = foldFixture("oauth");
    const h = renderHarness(<Outline hiddenRows={0} />, session);
    const chapter = session.chapters.find((item) => item.current && !item.noise);
    const seq = session.steps.find((step) => step.id === chapter?.stepIds[0])?.firstSeq ?? 1;
    act(() => {
      h.store.dispatch({ type: "playhead/set", playhead: { kind: "free", seq }, origin: "program" });
    });
    await act(async () => undefined);
    const expected = buildTraceIndex(session).chapterAtSeq(seq)?.id;
    expect(document.querySelector(`[data-key="${expected ?? ""}"]`)?.getAttribute("aria-current")).toBe("true");
  });

  it("opens Evidence when a Files row is chosen", async () => {
    const session = foldFixture("oauth");
    const h = renderHarness(<Outline hiddenRows={0} />, session);
    await act(async () => undefined);
    const entity = session.entities[0];
    fireEvent.click(document.querySelector<HTMLElement>(`[data-key="${entity?.id ?? ""}"]`) as HTMLElement);
    expect(h.store.get().selection).toBe(entity?.stepIds.at(-1));
    expect(h.store.get().inspectorTab).toBe("evidence");
  });

  it("shows ✕ and the word failed on a failed command row", async () => {
    const session = foldFixture("oauth");
    renderHarness(<Outline hiddenRows={0} />, session);
    await act(async () => undefined);
    const testStep = session.steps.find((step) => step.command?.command === "pnpm test");
    const row = document.querySelector(`[data-key="cmd:${testStep?.id ?? ""}"]`);
    expect(row?.textContent).toContain("✕");
    expect(row?.textContent).toContain("failed");
  });

  it("marks search matches and hides nothing", async () => {
    const session = foldFixture("oauth");
    const h = renderHarness(<Outline hiddenRows={0} />, session);
    await act(async () => undefined);
    const before = screen.getAllByRole("treeitem").length;
    fireEvent.change(screen.getByRole("searchbox", { name: "Search steps" }), { target: { value: "pnpm test" } });
    await act(async () => undefined);
    expect(h.store.get().search?.matchIds.length ?? 0).toBeGreaterThan(0);
    expect(document.querySelectorAll("[data-match]").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("treeitem").length).toBe(before);
  });

  it("keeps exactly one row in the tab order", async () => {
    renderHarness(<Outline hiddenRows={0} />, foldFixture("oauth"));
    await act(async () => undefined);
    const tree = screen.getByRole("tree", { name: "Outline" });
    expect(tree.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  });
});
```

- [ ] **Step 6: Run it to see it fail**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/shell/Outline/outline.test.tsx`
Expected: FAIL with `Failed to resolve import "./Outline.js"`.

- [ ] **Step 7: Implement the Outline component and CSS**

Create `packages/trace-viewer/src/ui/shell/Outline/Outline.module.css`:

```css
.outline {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.header {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 12px 8px;
}

.heading {
  margin: 0;
  font-size: 13px;
  line-height: 18px;
  font-weight: 600;
  color: var(--tv-ink);
}

.search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--tv-fill);
  color: var(--tv-ink-3);
}

.search input {
  flex: 1;
  min-width: 0;
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
  padding: 0 12px 8px;
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-ink-3);
}

.clear {
  padding: 0;
  border: 0;
  background: none;
  color: var(--tv-accent-ink);
  font: inherit;
  cursor: pointer;
}

.scroll {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.row {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 12px;
  font-size: 13px;
  line-height: 18px;
  color: var(--tv-ink);
  cursor: pointer;
  outline: none;
}

.row[data-depth="1"] {
  padding-left: 24px;
}

.row:hover {
  background: var(--tv-fill);
}

.row[aria-selected="true"] {
  background: var(--tv-accent-soft);
  color: var(--tv-accent-ink);
}

.row[aria-current="true"] .icon {
  color: var(--tv-accent);
}

.row:focus-visible {
  box-shadow: inset 0 0 0 2px var(--tv-accent);
}

.row[data-match] .title {
  text-decoration: underline;
  text-decoration-color: var(--tv-accent);
  text-underline-offset: 3px;
}

.section {
  font-size: 12px;
  line-height: 16px;
  font-weight: 600;
  color: var(--tv-ink-2);
}

.count {
  margin-left: auto;
  color: var(--tv-ink-3);
  font-size: 12px;
}

.turn {
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-ink-3);
  cursor: default;
}

.icon {
  flex: none;
  color: var(--tv-ink-2);
}

.title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.mono {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12px;
}

.muted {
  color: var(--tv-ink-3);
}

.flagBad {
  flex: none;
  color: var(--tv-bad);
}

.flagIcon {
  flex: none;
  color: var(--tv-ink-2);
}

.failedWord {
  flex: none;
  font-size: 12px;
  color: var(--tv-bad-ink);
}

.offset {
  flex: none;
  font-size: 12px;
  color: var(--tv-ink-3);
}

.more {
  font-size: 12px;
  color: var(--tv-accent-ink);
}

.placeholder {
  height: 12px;
  margin: 10px 12px;
  border-radius: 4px;
  background: var(--tv-fill-2);
}

.footer {
  margin: 0;
  padding: 8px 12px;
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-ink-3);
  box-shadow: inset 0 1px 0 var(--tv-hair);
}
```

Create `packages/trace-viewer/src/ui/shell/Outline/Outline.tsx`:

```tsx
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { buildSearchIndex, formatOffset } from "../../../model/index.js";
import { Graphic } from "../../graphics/Graphic.js";
import { Icon } from "../../icons/Icon.js";
import { useDispatch, useView } from "../../state/store.js";
import { selectEffectivePlayheadSeq } from "../../state/view-state.js";
import { useSessionView } from "../session-context.js";
import {
  buildOutlineRows,
  DEFAULT_OPEN_SECTIONS,
  searchMatches,
  type OutlineRow,
  type OutlineSection,
} from "./outline-rows.js";
import styles from "./Outline.module.css";

export interface OutlineProps {
  hiddenRows: number;
}

const ROW_PX = 28;

function toggled<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function Outline({ hiddenRows }: OutlineProps) {
  const { session, index } = useSessionView();
  const dispatch = useDispatch();
  const selection = useView((state) => state.selection);
  const search = useView((state) => state.search);
  const playheadSeq = useView((state) => selectEffectivePlayheadSeq(state, index));
  const [open, setOpen] = useState<ReadonlySet<OutlineSection>>(DEFAULT_OPEN_SECTIONS);
  const [showAll, setShowAll] = useState<ReadonlySet<OutlineSection>>(new Set());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [query, setQuery] = useState(search?.query ?? "");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (search === null) setQuery("");
  }, [search]);

  const rows = useMemo<OutlineRow[]>(
    () => (session === null ? [] : buildOutlineRows(session, { open, showAll })),
    [session, open, showAll],
  );
  const searchIndex = useMemo(() => (session === null ? null : buildSearchIndex(session)), [session]);
  const matches = useMemo(() => new Set<string>(search?.matchIds ?? []), [search]);
  const currentChapter = session === null ? undefined : index.chapterAtSeq(playheadSeq)?.id;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_PX,
    getItemKey: (position) => rows[position]?.key ?? position,
    overscan: 8,
  });

  const selectedKey = rows.find((row) => row.t === "item" && row.selId === selection)?.key;
  const tabKey =
    focusKey !== null && rows.some((row) => row.key === focusKey) ? focusKey : (selectedKey ?? rows[0]?.key ?? null);

  useEffect(() => {
    if (focusKey === null) return;
    const position = rows.findIndex((row) => row.key === focusKey);
    if (position < 0) return;
    virtualizer.scrollToIndex(position, { align: "auto" });
    const frame = requestAnimationFrame(() => {
      const target = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>("[data-key]") ?? []).find(
        (element) => element.dataset.key === focusKey,
      );
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusKey, rows, virtualizer]);

  const activate = (row: OutlineRow): void => {
    if (row.t === "section") setOpen((current) => toggled(current, row.section));
    else if (row.t === "more") setShowAll((current) => toggled(current, row.section));
    else if (row.t === "item") {
      dispatch({ type: "select", id: row.selId, by: "shell" });
      if (row.openEvidence) dispatch({ type: "inspector/tab", tab: "evidence" });
    }
  };

  const onTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const position = rows.findIndex((row) => row.key === tabKey);
    const move = (to: number): void => {
      const row = rows[Math.max(0, Math.min(rows.length - 1, to))];
      if (row !== undefined) setFocusKey(row.key);
    };
    const row = rows[position];
    switch (event.key) {
      case "ArrowDown":
        move(position + 1);
        break;
      case "ArrowUp":
        move(position - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(rows.length - 1);
        break;
      case "ArrowRight":
        if (row?.t === "section" && !row.open) activate(row);
        break;
      case "ArrowLeft":
        if (row?.t === "section" && row.open) activate(row);
        break;
      case "Enter":
        if (row !== undefined) activate(row);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const onSearchChange = (value: string): void => {
    setQuery(value);
    if (session === null || searchIndex === null) return;
    dispatch({ type: "search/set", query: value, matchIds: searchMatches(session, searchIndex, value) });
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      dispatch({ type: "search/next", dir: event.shiftKey ? -1 : 1 });
    } else if (event.key === "Escape") {
      event.preventDefault();
      dispatch({ type: "esc" });
      const root = event.currentTarget.closest("[data-trace-viewer]");
      root
        ?.querySelector<HTMLElement>('[data-region="main"] [tabindex="0"], [data-region="main"]')
        ?.focus({ preventScroll: true });
    }
  };

  const noMatches = query.trim() !== "" && search !== null && search.matchIds.length === 0;

  return (
    <div className={styles.outline}>
      <div className={styles.header}>
        <h2 className={styles.heading}>Outline</h2>
        <label className={styles.search}>
          <Icon name="search" size={14} />
          <input
            data-outline-search=""
            type="search"
            aria-label="Search steps"
            placeholder="Search"
            value={query}
            onChange={(event) => onSearchChange(event.target.value)}
            onKeyDown={onSearchKeyDown}
          />
        </label>
      </div>
      {noMatches ? (
        <p className={styles.empty}>
          {`No steps match “${query}” · `}
          <button type="button" className={styles.clear} onClick={() => onSearchChange("")}>
            Clear
          </button>
        </p>
      ) : null}
      <div
        ref={scrollRef}
        className={styles.scroll}
        role="tree"
        aria-label="Outline"
        data-scroll-root=""
        onKeyDown={onTreeKeyDown}
      >
        {session === null ? (
          <div aria-hidden="true">
            {[0, 1, 2, 3, 4, 5].map((n) => (
              <div key={n} className={styles.placeholder} />
            ))}
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              if (row === undefined) return null;
              const common = {
                "data-key": row.key,
                "data-index": item.index,
                tabIndex: row.key === tabKey ? 0 : -1,
                style: { transform: `translateY(${item.start}px)` },
                onFocus: () => setFocusKey(row.key),
              };
              if (row.t === "section") {
                return (
                  <div
                    key={row.key}
                    {...common}
                    role="treeitem"
                    aria-level={1}
                    aria-expanded={row.open}
                    className={`${styles.row} ${styles.section}`}
                    onClick={() => activate(row)}
                  >
                    <Icon name={row.open ? "chev-d" : "chev-r"} size={12} />
                    <span className={styles.title}>{row.label}</span>
                    <span className={styles.count}>{row.count}</span>
                  </div>
                );
              }
              if (row.t === "turn") {
                return (
                  <div key={row.key} {...common} role="treeitem" aria-level={2} className={`${styles.row} ${styles.turn}`}>
                    <span className={styles.title}>{row.label}</span>
                    <span className={styles.offset}>{formatOffset(row.tMs)}</span>
                  </div>
                );
              }
              if (row.t === "more") {
                return (
                  <div
                    key={row.key}
                    {...common}
                    role="treeitem"
                    aria-level={2}
                    className={`${styles.row} ${styles.more}`}
                    onClick={() => activate(row)}
                  >
                    {`Show ${row.hidden} more`}
                  </div>
                );
              }
              return (
                <div
                  key={row.key}
                  {...common}
                  role="treeitem"
                  aria-level={row.depth + 2}
                  aria-label={row.label}
                  aria-selected={row.selId === selection}
                  aria-current={row.chapterId !== null && row.chapterId === currentChapter ? "true" : undefined}
                  data-depth={row.depth}
                  data-match={matches.has(row.selId) ? "" : undefined}
                  className={styles.row}
                  onClick={() => activate(row)}
                >
                  <span className={styles.icon}>
                    <Icon name={row.icon} size={14} />
                  </span>
                  <span className={`${styles.title} ${row.mono ? styles.mono : ""} ${row.muted ? styles.muted : ""}`}>
                    {row.title}
                  </span>
                  {row.flag === "x" ? (
                    <span className={styles.flagBad} aria-hidden="true">
                      ✕
                    </span>
                  ) : null}
                  {row.failed ? <span className={styles.failedWord}>failed</span> : null}
                  {row.flag === "neq" ? (
                    <span className={styles.flagBad}>
                      <Icon name="neq" size={12} />
                    </span>
                  ) : null}
                  {row.flag === "shield" ? (
                    <span className={styles.flagIcon}>
                      <Icon name="shield" size={12} />
                    </span>
                  ) : null}
                  {row.graphic === null ? null : <Graphic spec={row.graphic} size="xs" />}
                  {row.section === "story" ? <span className={styles.offset}>{formatOffset(row.tMs)}</span> : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {hiddenRows > 0 ? <p className={styles.footer}>{`${hiddenRows} pipeline rows hidden`}</p> : null}
    </div>
  );
}
```

- [ ] **Step 8: Mount the Outline in the Shell**

In `packages/trace-viewer/src/ui/shell/Shell.tsx`, add `import { Outline } from "./Outline/Outline.js";` after `import { LiveRegion } from "./LiveRegion.js";`, add this line directly above `return (` in `Shell`:

```tsx
  const hiddenRows =
    session === null
      ? 0
      : Object.values(session.hidden.byType).reduce<number>((sum, count) => sum + (count ?? 0), 0) +
        session.hidden.unreceived;
```

and replace the anchor `<nav className={styles.outline} aria-label="Outline" data-region="outline" />` with:

```tsx
                  <nav className={styles.outline} aria-label="Outline" data-region="outline">
                    <ErrorBoundary region="Outline">
                      <Outline hiddenRows={hiddenRows} />
                    </ErrorBoundary>
                  </nav>
```

- [ ] **Step 9: Run the tests to see them pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/shell/Outline src/ui/shell/shell.test.tsx`
Expected: PASS, 7 + 6 + 8 tests.

- [ ] **Step 10: Root checks**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint`
Expected: exit 0.

- [ ] **Step 11: Commit**

```bash
git add packages/trace-viewer/src/ui/shell/Outline/outline-rows.ts packages/trace-viewer/src/ui/shell/Outline/outline-rows.test.ts \
  packages/trace-viewer/src/ui/shell/Outline/Outline.tsx packages/trace-viewer/src/ui/shell/Outline/Outline.module.css \
  packages/trace-viewer/src/ui/shell/Outline/outline.test.tsx packages/trace-viewer/src/ui/shell/Shell.tsx
git commit -m "feat(trace-viewer): add the outline with story, files, commands, tests and search"
```

---
### Task C2-6: Inspector frame, Summary per kind, finding copy, review note, footer actions

**Files:**
- Create: `packages/trace-viewer/src/ui/inspector/finding-copy.ts`
- Create: `packages/trace-viewer/src/ui/inspector/review-note.ts`
- Create: `packages/trace-viewer/src/ui/inspector/Summary.tsx`
- Create: `packages/trace-viewer/src/ui/inspector/Inspector.tsx`
- Create: `packages/trace-viewer/src/ui/inspector/Inspector.module.css`
- Modify: `packages/trace-viewer/src/ui/shell/Shell.tsx` (deviation 2: mount the Inspector; real `selectedTitleFor`)
- Test: `packages/trace-viewer/src/ui/inspector/review-note.test.ts`
- Test: `packages/trace-viewer/src/ui/inspector/inspector.test.tsx`

**Interfaces:**
- Consumes: B `KIND_META[kind].label`, `compareFindings`, `clampMeta(id): { label; severity }`, `signalMeta(id): SignalMeta`, `agentStateLabel`, `formatDuration`, `formatOffset`, `normalizeCommand`, `exitLabel`, `displayUntrusted`, `pickGraphic`, `describeGraphic`, types `Finding` (with `anchorStepId`, `claim?: ClaimObservation`, `claimSpan?`, `evidenceStepIds?`, `evidenceSeqs`), `Step`, `Chapter`, `Severity`, `SignalId`, `TraceSession`; C1a `Icon`, `Graphic`, `DiffBar`, `TestDots`, `ForkGlyph`, `ClaimVsObserved({ size, claim: {text, span?, tMs}, observed: {passed, failed, command, tMs}, label?, onObservedClick? })`, `KIND_ICON`, `CATEGORY_ICON`, `SIGNAL_ICON`; C1b `TraceIndex.entry(id): IndexEntry | undefined` (`{ id, kind: "step" | "chapter", position, firstSeq, … }`), `useView`, `useDispatch`, actions `select`, `inspector/tab`; C2-3 `useSessionView`, `useAnnounce`, `ViewerHost`, `ErrorBoundary`; C2-4 `displaySpanMs`.
- Produces:

```ts
// ui/inspector/finding-copy.ts
export const FINDING_TITLE: {
  readonly claim_contradicted: "Claim contradicts tests"; readonly failing_tests: "Tests failed";
  readonly destructive_command: "Destructive command"; readonly guardrail_clamp: "Guardrail clamp";
  readonly recovery_arc: "Recovered after a failure";
};   // satisfies Record<SignalId, string>
export function findingsOf(session: TraceSession, step: Step): Finding[];        // sorted by compareFindings
export function topFindingOf(session: TraceSession, step: Step): Finding | null;
/** Finding-first title: FINDING_TITLE of the top finding, else the decision title, else KIND_META label; chapters use their title. Never agent text. */
export function selectionTitle(session: TraceSession, index: TraceIndex, id: SelectionId): string;
// ui/inspector/review-note.ts
export interface ReviewNote { markdown: string; firstLine: string }
export function buildReviewNote(session: TraceSession, index: TraceIndex, selection: SelectionId): ReviewNote;
export function fenceFor(text: string): string;
export function inlineCode(text: string): string;
// ui/inspector/Summary.tsx
export interface SummaryProps { session: TraceSession | null; index: TraceIndex; selection: SelectionId | null }
export function Summary(props: SummaryProps): React.JSX.Element;
// ui/inspector/Inspector.tsx
export interface InspectorProps { host: ViewerHost }
export function Inspector(props: InspectorProps): React.JSX.Element;
export function copyText(text: string): Promise<boolean>;
```

Note format (spec §7.1 "Review note"): line 1 `Re: trace <sessionId> <offset> "<title>" (seq <firstSeq>; evidence seq <seqs>)`, where evidence seqs are the top finding's `evidenceSeqs` (else the step's `evidenceSeqs`, else the chapter's `factSeqs`) minus the selection's own seqs; line 2 `Session: <repoName> / <first prompt line>`; `Claim:` plus the claim in a fence one backtick longer than its longest run (minimum 3); `Observed: <evidence headlines as inline code>`; `Paths: <paths as inline code>`. Lines with no data are omitted. `\r` and `\n` outside the fence show as `⏎`. `Request changes` sends line 1 only.

- [ ] **Step 1: Write the failing review-note test**

Create `packages/trace-viewer/src/ui/inspector/review-note.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { buildTraceIndex } from "../../layout/trace-index.js";
import type { TraceSession } from "../../model/index.js";
import { fixtureTrace, foldFixture, payloadOf } from "../../test-support/ui-harness.js";
import { buildReviewNote, fenceFor, inlineCode } from "./review-note.js";

describe("fenceFor and inlineCode", () => {
  it("fences with a run one longer than the longest inside, minimum 3", () => {
    expect(fenceFor("plain text")).toBe("```");
    expect(fenceFor("a ``` b")).toBe("````");
    expect(fenceFor("x ````` y")).toBe("``````");
  });

  it("delimits inline code with a longer run and shows newlines as ⏎", () => {
    expect(inlineCode("pnpm test")).toBe("`pnpm test`");
    expect(inlineCode("a`b")).toBe("``a`b``");
    expect(inlineCode("`x")).toBe("`` `x ``");
    expect(inlineCode("a\nb\r\nc")).toBe("`a⏎b⏎c`");
  });
});

describe("buildReviewNote", () => {
  it("names oauth's claim and its evidence seq, located by content", () => {
    const { rows } = fixtureTrace("oauth");
    const claimSeq = rows.find(
      (row) => row.type === "agent_event" && payloadOf(row).text === "OAuth implementation complete; all checks pass.",
    )?.seq;
    const evidenceSeq = rows.find((row) => row.type === "evidence_fact" && payloadOf(row).type === "test_result")?.seq;
    expect(claimSeq).toBeDefined();
    expect(evidenceSeq).toBeDefined();
    const session = foldFixture("oauth");
    const claimStep = session.steps.find((step) => step.seqs.includes(claimSeq ?? -1));
    const note = buildReviewNote(session, buildTraceIndex(session), claimStep?.id ?? "step:1");
    expect(note.firstLine).toBe(
      `Re: trace ${session.meta.sessionId} +0:43 "Claim contradicts tests" (seq ${claimSeq}; evidence seq ${evidenceSeq})`,
    );
    const lines = note.markdown.split("\n");
    expect(lines[0]).toBe(note.firstLine);
    expect(lines[1]).toBe(`Session: ${session.meta.repoName} / ${session.meta.prompt.split("\n")[0] ?? ""}`);
    expect(note.markdown).toContain("Claim:\n```\nOAuth implementation complete; all checks pass.\n```");
    expect(lines.some((line) => line.startsWith("Observed: `pnpm test"))).toBe(true);
    expect(lines.some((line) => line.startsWith("Paths: ") && line.includes("`tests/auth/oauth.test.ts`"))).toBe(true);
  });

  it("fences quoted text longer than any backtick run inside it", () => {
    const base = foldFixture("oauth");
    const hostile = "Done.\n```\n# Injected heading\n```\nall checks pass";
    const session: TraceSession = {
      ...base,
      findings: base.findings.map((finding) =>
        finding.ruleId === "claim_contradicted" && finding.claim !== undefined
          ? { ...finding, claim: { ...finding.claim, claim: { ...finding.claim.claim, text: hostile } } }
          : finding,
      ),
    };
    const claim = session.findings.find((finding) => finding.ruleId === "claim_contradicted");
    expect(claim).toBeDefined();
    const note = buildReviewNote(session, buildTraceIndex(session), claim?.anchorStepId ?? "step:1");
    const lines = note.markdown.split("\n");
    const open = lines.indexOf("Claim:") + 1;
    expect(lines[open]).toBe("````");
    const close = lines.indexOf("````", open + 1);
    expect(close).toBeGreaterThan(open);
    expect(lines.slice(open + 1, close)).toContain("# Injected heading");
  });

  it("shows a bidi override in a path as a visible token", () => {
    const base = foldFixture("oauth");
    const edit = base.steps.find((step) => step.edit !== undefined);
    expect(edit?.edit).toBeDefined();
    const session: TraceSession = {
      ...base,
      steps: base.steps.map((step) =>
        step.id === edit?.id && step.edit !== undefined ? { ...step, edit: { ...step.edit, path: "src/\u202Etxt.exe" } } : step,
      ),
    };
    const note = buildReviewNote(session, buildTraceIndex(session), edit?.id ?? "step:1");
    expect(note.markdown).toContain("⟨U+202E⟩");
    expect(note.markdown).not.toContain("\u202E");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/inspector/review-note.test.ts`
Expected: FAIL with `Failed to resolve import "./review-note.js"`.

- [ ] **Step 3: Implement finding copy and the review note**

Create `packages/trace-viewer/src/ui/inspector/finding-copy.ts`:

```ts
import type { SelectionId, TraceIndex } from "../../layout/trace-index.js";
import {
  compareFindings,
  KIND_META,
  type Finding,
  type FindingId,
  type SignalId,
  type Step,
  type TraceSession,
} from "../../model/index.js";

export const FINDING_TITLE = {
  claim_contradicted: "Claim contradicts tests",
  failing_tests: "Tests failed",
  destructive_command: "Destructive command",
  guardrail_clamp: "Guardrail clamp",
  recovery_arc: "Recovered after a failure",
} as const satisfies Record<SignalId, string>;

const byIdCache = new WeakMap<TraceSession, ReadonlyMap<FindingId, Finding>>();

function findingMap(session: TraceSession): ReadonlyMap<FindingId, Finding> {
  let map = byIdCache.get(session);
  if (map === undefined) {
    map = new Map(session.findings.map((finding) => [finding.id, finding]));
    byIdCache.set(session, map);
  }
  return map;
}

export function findingsOf(session: TraceSession, step: Step): Finding[] {
  const map = findingMap(session);
  return step.findingIds
    .map((id) => map.get(id))
    .filter((finding): finding is Finding => finding !== undefined)
    .sort(compareFindings);
}

export function topFindingOf(session: TraceSession, step: Step): Finding | null {
  return findingsOf(session, step)[0] ?? null;
}

/** Finding-first title (spec §7.1). Chapter titles and decision titles are pipeline text; agent text never fills this slot. */
export function selectionTitle(session: TraceSession, index: TraceIndex, id: SelectionId): string {
  const entry = index.entry(id);
  if (entry?.kind === "chapter") return session.chapters[entry.position]?.title ?? "Chapter";
  const step = entry === undefined ? undefined : session.steps[entry.position];
  if (step === undefined) return "Step";
  const finding = topFindingOf(session, step);
  if (finding !== null) return FINDING_TITLE[finding.ruleId];
  if (step.kind === "decision" && step.decision !== undefined) return step.decision.title;
  return KIND_META[step.kind].label;
}
```

Create `packages/trace-viewer/src/ui/inspector/review-note.ts`:

```ts
import type { SelectionId, TraceIndex } from "../../layout/trace-index.js";
import { displayUntrusted, formatOffset, type Step, type StepId, type TraceSession } from "../../model/index.js";
import { selectionTitle, topFindingOf } from "./finding-copy.js";

export interface ReviewNote {
  markdown: string;
  firstLine: string;
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return longest;
}

/** Backticks one longer than the longest run in text, minimum 3. */
export function fenceFor(text: string): string {
  return "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
}

function oneLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, "⏎");
}

/** Inline code delimited by a run longer than any inside; \r and \n show as ⏎. */
export function inlineCode(text: string): string {
  const flat = oneLine(text);
  const delimiter = "`".repeat(longestBacktickRun(flat) + 1);
  const pad = flat.startsWith("`") || flat.endsWith("`") ? " " : "";
  return `${delimiter}${pad}${flat}${pad}${delimiter}`;
}

function firstLineOf(text: string): string {
  const end = text.search(/\r?\n/);
  return end < 0 ? text : text.slice(0, end);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** Spec §7.1 "Review note". */
export function buildReviewNote(session: TraceSession, index: TraceIndex, selection: SelectionId): ReviewNote {
  const entry = index.entry(selection);
  const chapter = entry?.kind === "chapter" ? session.chapters[entry.position] : undefined;
  const step = entry?.kind === "step" ? session.steps[entry.position] : undefined;
  const stepById = new Map<StepId, Step>(session.steps.map((item) => [item.id, item]));
  const title = oneLine(selectionTitle(session, index, selection)).replace(/"/g, "'");
  const tMs = step?.tMs ?? chapter?.tMs ?? 0;
  const firstSeq = step?.firstSeq ?? chapter?.firstSeq ?? entry?.firstSeq ?? 0;
  const finding = step === undefined ? null : topFindingOf(session, step);
  const own = new Set(step?.seqs ?? []);
  const sourceSeqs = finding !== null ? finding.evidenceSeqs : step !== undefined ? step.evidenceSeqs : (chapter?.factSeqs ?? []);
  const evidenceSeqs = unique(sourceSeqs.filter((seq) => !own.has(seq))).sort((a, b) => a - b);

  const firstLine = `Re: trace ${session.meta.sessionId} ${formatOffset(tMs)} "${title}" (seq ${firstSeq}${
    evidenceSeqs.length > 0 ? `; evidence seq ${evidenceSeqs.join(", ")}` : ""
  })`;
  const lines = [firstLine, `Session: ${oneLine(session.meta.repoName)} / ${firstLineOf(session.meta.prompt)}`];

  const isClaimStep = step !== undefined && session.turns.some((turn) => turn.claimStepId === step.id);
  const claimText = finding?.claim?.claim.text ?? (isClaimStep ? step?.text : undefined);
  if (claimText !== undefined && claimText.length > 0) {
    const fence = fenceFor(claimText);
    lines.push("Claim:", fence, claimText, fence);
  }

  const evidenceSteps = (finding?.evidenceStepIds ?? [])
    .map((id) => stepById.get(id))
    .filter((item): item is Step => item !== undefined);
  if (evidenceSteps.length > 0) {
    lines.push(`Observed: ${evidenceSteps.map((item) => inlineCode(displayUntrusted(item.headline))).join("; ")}`);
  }

  const paths = unique([
    ...(step?.edit === undefined ? [] : [step.edit.path]),
    ...(chapter?.files ?? []),
    ...[step, ...evidenceSteps].flatMap((item) => item?.tests?.failures.map((failure) => failure.file) ?? []),
  ]);
  if (paths.length > 0) lines.push(`Paths: ${paths.map((path) => inlineCode(displayUntrusted(path))).join(", ")}`);

  return { markdown: lines.join("\n"), firstLine };
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/inspector/review-note.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing Inspector test**

Create `packages/trace-viewer/src/ui/inspector/inspector.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { foldRows, KIND_META } from "../../model/index.js";
import { TraceBuilder, testMeta } from "../../test-support/trace-builder.js";
import { foldFixture, renderHarness, stubLayout, type LayoutStub } from "../../test-support/ui-harness.js";
import { FINDING_TITLE } from "./finding-copy.js";
import { Inspector } from "./Inspector.js";

let layout: LayoutStub;
beforeEach(() => {
  layout = stubLayout();
});
afterEach(() => {
  cleanup();
  layout.restore();
  vi.restoreAllMocks();
});

function claimStepId(): string {
  const session = foldFixture("oauth");
  const claim = session.findings.find((finding) => finding.ruleId === "claim_contradicted");
  if (claim === undefined) throw new Error("oauth has no claim_contradicted finding");
  return claim.anchorStepId;
}

function titleSlot(): string {
  return document.querySelector('[data-slot="title"]')?.textContent ?? "";
}

function selectedTab(): string {
  return screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent ?? "";
}

describe("Inspector", () => {
  it("opens on Summary with the finding-first title", () => {
    renderHarness(<Inspector host={{}} />, foldFixture("oauth"), { state: { selection: claimStepId() as `step:${number}` } });
    expect(selectedTab()).toBe("Summary");
    expect(titleSlot()).toBe(FINDING_TITLE.claim_contradicted);
    expect(screen.getAllByText(/all checks pass/).length).toBeGreaterThan(0);
  });

  it("resets Raw to Summary on a new selection while Evidence persists", () => {
    const session = foldFixture("oauth");
    const [a, b, c] = session.steps;
    const h = renderHarness(<Inspector host={{}} />, session, { state: { selection: a?.id ?? null } });
    act(() => h.store.dispatch({ type: "inspector/tab", tab: "raw" }));
    expect(selectedTab()).toBe("Raw");
    act(() => h.store.dispatch({ type: "select", id: b?.id ?? null, by: "shell" }));
    expect(selectedTab()).toBe("Summary");
    act(() => h.store.dispatch({ type: "inspector/tab", tab: "evidence" }));
    act(() => h.store.dispatch({ type: "select", id: c?.id ?? null, by: "shell" }));
    expect(selectedTab()).toBe("Evidence");
  });

  it("shows Request changes only when the host provides it and disables it with no selection", async () => {
    const session = foldFixture("oauth");
    renderHarness(<Inspector host={{}} />, session);
    expect(screen.getByRole("button", { name: /Copy review note/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: /Request changes/ })).toBeNull();
    cleanup();

    const requestChanges = vi.fn();
    const h = renderHarness(<Inspector host={{ requestChanges }} />, session);
    const button = screen.getByRole("button", { name: /Request changes/ });
    expect(button.hasAttribute("disabled")).toBe(true);
    const selected = claimStepId() as `step:${number}`;
    act(() => h.store.dispatch({ type: "select", id: selected, by: "shell" }));
    fireEvent.click(screen.getByRole("button", { name: /Request changes/ }));
    await waitFor(() => expect(requestChanges).toHaveBeenCalledTimes(1));
    const request = requestChanges.mock.calls[0]?.[0] as { sessionId: string; selected: string; text: string };
    expect(request.sessionId).toBe(session.meta.sessionId);
    expect(request.selected).toBe(selected);
    expect(request.text.startsWith(`Re: trace ${session.meta.sessionId} +0:43 "Claim contradicts tests"`)).toBe(true);
    expect(request.text.includes("\n")).toBe(false);
  });

  it("copies the review note when the host has no requestChanges", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const h = renderHarness(<Inspector host={{}} />, foldFixture("oauth"), {
      state: { selection: claimStepId() as `step:${number}` },
    });
    fireEvent.click(screen.getByRole("button", { name: /Copy review note/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(String(writeText.mock.calls[0]?.[0]).startsWith("Re: trace ")).toBe(true);
    await waitFor(() => expect(h.announcements).toContain("Review note copied"));
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("agent text never fills the title slot", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Do the task" });
    b.agent({ type: "agent_message", role: "assistant", text: "Claim contradicts tests <img src=x onerror=alert(1)>" });
    b.agent({ type: "agent_completed" });
    const session = foldRows(testMeta(), b.rows, { live: false });
    const message = session.steps.find((step) => step.kind === "message");
    renderHarness(<Inspector host={{}} />, session, { state: { selection: message?.id ?? null } });
    expect(titleSlot()).toBe(KIND_META.message.label);
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("Claim contradicts tests <img src=x onerror=alert(1)>")).toBeTruthy();
  });

  it("summarizes the session when nothing is selected", () => {
    renderHarness(<Inspector host={{}} />, foldFixture("oauth"));
    expect(titleSlot()).toBe("Session");
    expect(screen.getByText(/of 5 signals active/)).toBeTruthy();
  });

  it("notes a regrouped selection", () => {
    const session = foldFixture("oauth");
    const chapter = session.chapters[0];
    renderHarness(<Inspector host={{}} />, session, {
      state: { selection: chapter?.id ?? null, selectionNote: { from: "unit:gone", to: chapter?.id ?? "unit:x" } },
    });
    expect(screen.getByText(`Regrouped into “${chapter?.title ?? ""}”`)).toBeTruthy();
  });
});
```

- [ ] **Step 6: Run it to see it fail**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/inspector/inspector.test.tsx`
Expected: FAIL with `Failed to resolve import "./Inspector.js"`.

- [ ] **Step 7: Implement Summary, the Inspector and its CSS**

Create `packages/trace-viewer/src/ui/inspector/Inspector.module.css`:

```css
.inspector {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.header {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 16px 16px 8px;
}

.tile {
  display: grid;
  flex: none;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--tv-fill-2);
  color: var(--tv-ink-2);
}

.tile[data-tone="bad"] {
  background: var(--tv-bad);
  color: var(--tv-panel);
}

.headText {
  min-width: 0;
}

.title {
  margin: 0;
  font-size: 15px;
  line-height: 20px;
  font-weight: 600;
  color: var(--tv-ink);
}

.meta {
  margin: 2px 0 0;
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-ink-3);
  overflow-wrap: anywhere;
}

.note {
  margin: 0 16px 8px;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--tv-accent-soft);
  color: var(--tv-accent-ink);
  font-size: 12px;
  line-height: 16px;
}

.tabs {
  display: flex;
  gap: 4px;
  padding: 0 16px 8px;
}

.tab {
  padding: 3px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--tv-ink-2);
  font: inherit;
  font-size: 12px;
  line-height: 16px;
  cursor: pointer;
}

.tab[aria-selected="true"] {
  background: var(--tv-fill-2);
  color: var(--tv-ink);
}

.tab:focus-visible,
.primary:focus-visible,
.secondary:focus-visible,
.related:focus-visible {
  outline: 2px solid var(--tv-accent);
  outline-offset: 1px;
}

.body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 16px 16px;
}

.section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 0;
}

.sectionTitle {
  margin: 0;
  font-size: 13px;
  line-height: 18px;
  font-weight: 600;
  color: var(--tv-ink);
}

.prose {
  margin: 0;
  font-size: 13px;
  line-height: 18px;
  color: var(--tv-ink);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.claimSpan {
  text-decoration: underline;
  text-decoration-color: var(--tv-bad);
  text-decoration-thickness: 2px;
  text-underline-offset: 3px;
}

.mono {
  margin: 0;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12px;
  line-height: 18px;
  color: var(--tv-ink);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.path {
  margin: 0;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12px;
  line-height: 18px;
  color: var(--tv-ink-2);
  overflow-wrap: anywhere;
}

.counts {
  display: flex;
  gap: 8px;
  margin: 0;
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-ink-2);
}

.badWord {
  color: var(--tv-bad-ink);
}

.failure {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--tv-fill);
}

.list {
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 13px;
  line-height: 18px;
  color: var(--tv-ink);
}

.chosen {
  font-weight: 600;
}

.bars {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr) 36px;
  align-items: center;
  gap: 4px 8px;
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-ink-2);
}

.bar {
  height: 4px;
  border-radius: 2px;
  background: var(--tv-fill-2);
}

.barFill {
  height: 4px;
  border-radius: 2px;
  background: var(--tv-mark);
}

.related {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 4px 0;
  border: 0;
  background: none;
  color: var(--tv-ink);
  font: inherit;
  font-size: 13px;
  line-height: 18px;
  text-align: left;
  cursor: pointer;
}

.relatedOffset {
  margin-left: auto;
  font-size: 12px;
  color: var(--tv-ink-3);
}

.muted {
  margin: 0;
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-ink-3);
}

.footer {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  box-shadow: inset 0 1px 0 var(--tv-hair);
}

.primary {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  border: 0;
  border-radius: 8px;
  background: var(--tv-accent-ink);
  color: var(--tv-panel);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}

.secondary {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: var(--tv-fill-2);
  color: var(--tv-ink);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.primary:disabled,
.secondary:disabled {
  cursor: default;
  background: var(--tv-fill-2);
  color: var(--tv-ink-3);
}
```

Create `packages/trace-viewer/src/ui/inspector/Summary.tsx`:

```tsx
import type { SelectionId, TraceIndex } from "../../layout/trace-index.js";
import {
  agentStateLabel,
  clampMeta,
  describeGraphic,
  displayUntrusted,
  exitLabel,
  formatDuration,
  formatOffset,
  KIND_META,
  normalizeCommand,
  pickGraphic,
  signalMeta,
  type Chapter,
  type Finding,
  type Severity,
  type Step,
  type StepId,
  type TraceSession,
} from "../../model/index.js";
import { ClaimVsObserved } from "../graphics/ClaimVsObserved.js";
import { DiffBar } from "../graphics/DiffBar.js";
import { ForkGlyph } from "../graphics/ForkGlyph.js";
import { Graphic } from "../graphics/Graphic.js";
import type { IconName } from "../icons/icon-names.js";
import { Icon } from "../icons/Icon.js";
import { CATEGORY_ICON, KIND_ICON } from "../icons/kind-icons.js";
import { displaySpanMs } from "../shell/TitleBar.js";
import { useDispatch } from "../state/store.js";
import { FINDING_TITLE, findingsOf } from "./finding-copy.js";
import styles from "./Inspector.module.css";

const SEVERITY_WORD: Record<Severity, string> = { critical: "Critical", warning: "Warning", info: "Info" };

export interface SummaryProps {
  session: TraceSession | null;
  index: TraceIndex;
  selection: SelectionId | null;
}

interface RelatedItem {
  id: SelectionId;
  icon: IconName;
  title: string;
  tMs: number;
}

function ClaimText({ text, span }: { text: string; span: readonly [number, number] | undefined }) {
  if (span === undefined) return <p className={styles.prose}>{text}</p>;
  return (
    <p className={styles.prose}>
      {text.slice(0, span[0])}
      <span className={styles.claimSpan}>{text.slice(span[0], span[1])}</span>
      {text.slice(span[1])}
    </p>
  );
}

function FindingBlock({ finding }: { finding: Finding }) {
  const claim = finding.claim;
  return (
    <section className={styles.section} aria-label={FINDING_TITLE[finding.ruleId]}>
      <h3 className={styles.sectionTitle}>
        <span className={finding.severity === "critical" ? styles.badWord : undefined}>{SEVERITY_WORD[finding.severity]}</span>
        {` · ${signalMeta(finding.ruleId).title}`}
      </h3>
      <p className={styles.prose}>{finding.reason}</p>
      {claim === undefined ? null : (
        <ClaimVsObserved
          size="md"
          claim={{ text: claim.claim.text, span: finding.claimSpan, tMs: claim.claim.tMs }}
          observed={{
            passed: claim.observed.passed,
            failed: claim.observed.failed,
            command: displayUntrusted(normalizeCommand(claim.observed.command)),
            tMs: claim.observed.tMs,
          }}
        />
      )}
    </section>
  );
}

function CommandFacts({ step }: { step: Step }) {
  if (step.command === undefined) return null;
  return (
    <p className={styles.meta}>
      <span className={styles.path}>{displayUntrusted(normalizeCommand(step.command.command))}</span>
      {` · ${formatDuration(step.durationMs)}`}
      {exitLabel(step.command.exitCode) === "" ? "" : ` · ${exitLabel(step.command.exitCode)}`}
    </p>
  );
}

function claimSpanOf(session: TraceSession, step: Step): readonly [number, number] | undefined {
  return findingsOf(session, step).find((finding) => finding.ruleId === "claim_contradicted")?.claimSpan;
}

function StepDetails({ step, session }: { step: Step; session: TraceSession }) {
  const graphic = pickGraphic(step, session);
  const graphicNode = graphic === null ? null : <Graphic spec={graphic} size="md" label={describeGraphic(graphic)} />;
  if (step.tests !== undefined) {
    const tests = step.tests;
    return (
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{step.status === "failed" ? "Failing test" : "Test run"}</h3>
        {graphicNode}
        <p className={styles.counts}>
          <span>{`${tests.passed} passed`}</span>
          {tests.failed > 0 ? <span className={styles.badWord}>{`${tests.failed} failed`}</span> : null}
          {tests.skipped > 0 ? <span>{`${tests.skipped} skipped`}</span> : null}
        </p>
        {tests.failures.slice(0, 3).map((failure, position) => (
          <div key={`${failure.file}:${position}`} className={styles.failure}>
            <p className={styles.prose}>{failure.testName}</p>
            <pre className={styles.mono}>{displayUntrusted(failure.message, { multiline: true })}</pre>
            <p className={styles.path}>{displayUntrusted(failure.file)}</p>
          </div>
        ))}
        {tests.failures.length > 3 ? <p className={styles.muted}>{`${tests.failures.length - 3} more`}</p> : null}
        <CommandFacts step={step} />
      </section>
    );
  }
  if (step.command !== undefined) {
    return (
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{KIND_META[step.kind].label}</h3>
        {graphicNode}
        <CommandFacts step={step} />
        {step.command.outputTail === undefined || step.command.outputTail === "" ? null : (
          <pre className={styles.mono}>{displayUntrusted(step.command.outputTail, { multiline: true })}</pre>
        )}
      </section>
    );
  }
  if (step.edit !== undefined) {
    const edit = step.edit;
    return (
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{KIND_META[step.kind].label}</h3>
        <p className={styles.path}>{displayUntrusted(edit.path)}</p>
        <DiffBar size="md" added={edit.added} removed={edit.removed} label={`+${edit.added} −${edit.removed}`} />
        <p className={styles.meta}>
          {`${edit.claimed ? "Agent reported" : "Not reported by the agent"} · ${
            edit.observed ? `Repo shows +${edit.added} −${edit.removed}` : "No repo change observed"
          }`}
        </p>
      </section>
    );
  }
  if (step.decision !== undefined) {
    const decision = step.decision;
    const chosen = decision.options.filter((option) => option.chosen).map((option) => option.label);
    return (
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Decision</h3>
        <ForkGlyph
          size="md"
          options={decision.options.map((option) => ({ label: option.label, chosen: option.chosen }))}
          decidedBy={decision.decidedBy ?? "open"}
        />
        <ul className={styles.list}>
          {decision.options.map((option) => (
            <li key={option.id} className={option.chosen ? styles.chosen : undefined}>
              {option.label}
            </li>
          ))}
        </ul>
        <p className={styles.meta}>
          {chosen.length > 0 ? `Answer: ${chosen.join(", ")}` : "No answer yet"}
          {step.durationMs === null ? "" : ` · waited ${formatDuration(step.durationMs)}`}
        </p>
      </section>
    );
  }
  if (step.guardrail !== undefined) {
    return (
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Guardrails</h3>
        <ul className={styles.list}>
          {step.guardrail.clampIds.map((id) => (
            <li key={id}>{clampMeta(id).label}</li>
          ))}
        </ul>
        <p className={styles.meta}>{`${step.guardrail.clientKind} · confidence ${step.guardrail.confidence.toFixed(2)}`}</p>
      </section>
    );
  }
  if (step.text !== undefined) {
    return (
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{step.kind === "reasoning" ? "Thinking" : KIND_META[step.kind].label}</h3>
        <ClaimText text={step.text} span={claimSpanOf(session, step)} />
      </section>
    );
  }
  return <p className={styles.meta}>{displayUntrusted(step.headline)}</p>;
}

function ChapterDetails({ chapter, session }: { chapter: Chapter; session: TraceSession }) {
  const graphic = pickGraphic(chapter, session);
  const { cited, resolved, approx } = chapter.evidenceLinks;
  const triad: ReadonlyArray<[string, number | undefined]> = [
    ["Importance", chapter.triad.importance],
    ["Relevance", chapter.triad.relevance],
    ["Interruption", chapter.triad.interruption],
  ];
  const hasTriad = triad.some(([, value]) => value !== undefined);
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>Chapter</h3>
      {graphic === null ? null : <Graphic spec={graphic} size="md" label={describeGraphic(graphic)} />}
      <ul className={styles.list}>
        {chapter.files.map((file) => (
          <li key={file} className={styles.path}>
            {displayUntrusted(file)}
          </li>
        ))}
      </ul>
      <p className={styles.meta}>
        {`${resolved} of ${cited} evidence links resolve${approx > 0 ? ` · ${approx} approximated` : ""}`}
      </p>
      {hasTriad ? (
        <>
          <h3 className={styles.sectionTitle}>{`Attention${chapter.triad.clientKind === undefined ? "" : ` · ${chapter.triad.clientKind}`}`}</h3>
          <div className={styles.bars}>
            {triad.map(([label, value]) => (
              <div key={label} style={{ display: "contents" }}>
                <span>{label}</span>
                <span className={styles.bar}>
                  <span className={styles.barFill} style={{ display: "block", width: `${Math.round((value ?? 0) * 100)}%` }} />
                </span>
                <span>{value === undefined ? "–" : value.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}
      {chapter.clampIds.length > 0 ? (
        <>
          <h3 className={styles.sectionTitle}>Guardrails</h3>
          <ul className={styles.list}>
            {chapter.clampIds.map((id) => (
              <li key={id}>{clampMeta(id).label}</li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function SessionSummary({ session }: { session: TraceSession }) {
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const finding of session.findings) counts[finding.severity] += 1;
  const signals = session.coverage.signals;
  const active = signals.filter((signal) => signal.active);
  const inactive = signals.filter((signal) => !signal.active);
  return (
    <section className={styles.section}>
      <p className={styles.prose}>{session.meta.prompt}</p>
      <p className={styles.meta}>{`${agentStateLabel(session.meta.state)} · ${formatDuration(displaySpanMs(session))}`}</p>
      {session.findings.length === 0 ? (
        <p className={styles.prose}>{`No problems found by ${active.length} signals`}</p>
      ) : (
        <p className={styles.prose}>
          {`${counts.critical} critical · ${counts.warning} warning · ${counts.info} info · n / N to step through`}
        </p>
      )}
      <p className={styles.meta}>{`${active.length} of ${signals.length} signals active`}</p>
      {inactive.length > 0 ? (
        <ul className={styles.list}>
          {inactive.map((signal) => (
            <li key={signal.id} className={styles.muted}>
              {`${signalMeta(signal.id).title}: needs ${signal.missing.join(", ")}`}
            </li>
          ))}
        </ul>
      ) : null}
      {session.coverage.approximateJoins ? (
        <p className={styles.muted}>Approximate joins: this session was recorded before M1, so chapters link by time window.</p>
      ) : null}
      {session.gaps.length > 0 ? (
        <p className={styles.muted}>{`${session.gaps.length} rows could not be read or paired`}</p>
      ) : null}
    </section>
  );
}

function Related({ items }: { items: readonly RelatedItem[] }) {
  const dispatch = useDispatch();
  if (items.length === 0) return null;
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>Related</h3>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={styles.related}
          onClick={() => dispatch({ type: "select", id: item.id, by: "shell" })}
        >
          <Icon name={item.icon} size={14} />
          <span>{item.title}</span>
          <span className={styles.relatedOffset}>{formatOffset(item.tMs)}</span>
        </button>
      ))}
    </section>
  );
}

function relatedForStep(session: TraceSession, step: Step): RelatedItem[] {
  const stepById = new Map<StepId, Step>(session.steps.map((item) => [item.id, item]));
  const items: RelatedItem[] = [];
  for (const finding of findingsOf(session, step)) {
    for (const id of finding.evidenceStepIds ?? []) {
      const evidence = stepById.get(id);
      if (evidence !== undefined) {
        items.push({ id: evidence.id, icon: KIND_ICON[evidence.kind], title: displayUntrusted(evidence.headline), tMs: evidence.tMs });
      }
    }
  }
  for (const chapterId of step.chapterIds) {
    const chapter = session.chapters.find((item) => item.id === chapterId);
    if (chapter !== undefined) items.push({ id: chapter.id, icon: CATEGORY_ICON[chapter.category], title: chapter.title, tMs: chapter.tMs });
  }
  return items;
}

function relatedForChapter(session: TraceSession, chapter: Chapter): RelatedItem[] {
  const items: RelatedItem[] = [];
  const decisionIds = new Set(chapter.decisionIds.map((id) => id.slice("decision:".length)));
  for (const step of session.steps) {
    const isDecision = step.decision !== undefined && decisionIds.has(step.decision.decisionId);
    if (isDecision || chapter.validationStepIds.includes(step.id)) {
      items.push({ id: step.id, icon: KIND_ICON[step.kind], title: displayUntrusted(step.headline), tMs: step.tMs });
    }
  }
  return items;
}

export function Summary({ session, index, selection }: SummaryProps) {
  if (session === null) return <p className={styles.muted}>Loading the session</p>;
  if (selection === null) return <SessionSummary session={session} />;
  const entry = index.entry(selection);
  if (entry?.kind === "chapter") {
    const chapter = session.chapters[entry.position];
    if (chapter === undefined) return <p className={styles.muted}>This chapter is not in the loaded range</p>;
    return (
      <>
        <ChapterDetails chapter={chapter} session={session} />
        <Related items={relatedForChapter(session, chapter)} />
      </>
    );
  }
  const step = entry === undefined ? undefined : session.steps[entry.position];
  if (step === undefined) return <p className={styles.muted}>This step is not in the loaded range</p>;
  return (
    <>
      {findingsOf(session, step).map((finding) => (
        <FindingBlock key={finding.id} finding={finding} />
      ))}
      <StepDetails step={step} session={session} />
      <Related items={relatedForStep(session, step)} />
    </>
  );
}
```

Create `packages/trace-viewer/src/ui/inspector/Inspector.tsx`:

```tsx
import type { KeyboardEvent } from "react";

import type { SelectionId, TraceIndex } from "../../layout/trace-index.js";
import {
  displayUntrusted,
  formatDuration,
  formatOffset,
  normalizeCommand,
  truncateMiddle,
  type Chapter,
  type Step,
  type TraceSession,
} from "../../model/index.js";
import type { IconName } from "../icons/icon-names.js";
import { Icon } from "../icons/Icon.js";
import { CATEGORY_ICON, KIND_ICON, SIGNAL_ICON } from "../icons/kind-icons.js";
import type { ViewerHost } from "../shell/host.js";
import { useAnnounce } from "../shell/LiveRegion.js";
import { useSessionView } from "../shell/session-context.js";
import { useDispatch, useView } from "../state/store.js";
import type { InspectorTab } from "../state/view-state.js";
import { selectionTitle, topFindingOf } from "./finding-copy.js";
import styles from "./Inspector.module.css";
import { buildReviewNote } from "./review-note.js";
import { Summary } from "./Summary.js";

export interface InspectorProps {
  host: ViewerHost;
}

const TABS: ReadonlyArray<{ id: InspectorTab; label: string }> = [
  { id: "summary", label: "Summary" },
  { id: "evidence", label: "Evidence" },
  { id: "raw", label: "Raw" },
];

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function metaLine(step: Step | undefined, chapter: Chapter | undefined): string {
  if (chapter !== undefined) return `${formatOffset(chapter.tMs)} · ${chapter.stepIds.length} steps`;
  if (step === undefined) return "";
  const parts = [formatOffset(step.tMs)];
  if (step.durationMs !== null) parts.push(formatDuration(step.durationMs));
  if (step.command !== undefined) parts.push(truncateMiddle(displayUntrusted(normalizeCommand(step.command.command)), 40));
  else if (step.edit !== undefined) parts.push(truncateMiddle(displayUntrusted(step.edit.path), 40));
  return parts.join(" · ");
}

function Header({
  session,
  index,
  selection,
  step,
  chapter,
}: {
  session: TraceSession | null;
  index: TraceIndex;
  selection: SelectionId | null;
  step: Step | undefined;
  chapter: Chapter | undefined;
}) {
  if (session === null || selection === null) {
    return (
      <div className={styles.header}>
        <div className={styles.tile}>
          <Icon name="list" size={16} />
        </div>
        <div className={styles.headText}>
          <h2 className={styles.title} data-slot="title">
            Session
          </h2>
        </div>
      </div>
    );
  }
  const finding = step === undefined ? null : topFindingOf(session, step);
  const icon: IconName =
    finding !== null
      ? SIGNAL_ICON[finding.ruleId]
      : step !== undefined
        ? KIND_ICON[step.kind]
        : chapter !== undefined
          ? CATEGORY_ICON[chapter.category]
          : "list";
  return (
    <div className={styles.header}>
      <div className={styles.tile} data-tone={finding?.severity === "critical" ? "bad" : "neutral"}>
        <Icon name={icon} size={16} />
      </div>
      <div className={styles.headText}>
        <h2 className={styles.title} data-slot="title">
          {selectionTitle(session, index, selection)}
        </h2>
        <p className={styles.meta}>{metaLine(step, chapter)}</p>
      </div>
    </div>
  );
}

function TabBody({
  tab,
  session,
  index,
  selection,
}: {
  tab: InspectorTab;
  session: TraceSession | null;
  index: TraceIndex;
  selection: SelectionId | null;
}) {
  if (tab === "summary") return <Summary session={session} index={index} selection={selection} />;
  return <p className={styles.muted}>No evidence for this item</p>;
}

export function Inspector({ host }: InspectorProps) {
  const { session, index } = useSessionView();
  const selection = useView((state) => state.selection);
  const tab = useView((state) => state.inspectorTab);
  const regrouped = useView((state) => state.selectionNote);
  const dispatch = useDispatch();
  const announce = useAnnounce();

  const entry = selection === null ? undefined : index.entry(selection);
  const step = session !== null && entry?.kind === "step" ? session.steps[entry.position] : undefined;
  const chapter = session !== null && entry?.kind === "chapter" ? session.chapters[entry.position] : undefined;
  const hasDiff = step?.edit?.diffSeq !== undefined || (chapter !== undefined && chapter.files.length > 0);
  const canRequest = host.requestChanges !== undefined;

  const onPrimary = async (): Promise<void> => {
    if (session === null || selection === null) return;
    const note = buildReviewNote(session, index, selection);
    if (host.requestChanges !== undefined) {
      await host.requestChanges({ sessionId: session.meta.sessionId, selected: selection, text: note.firstLine });
      announce("Sent to the composer");
      return;
    }
    announce((await copyText(note.markdown)) ? "Review note copied" : "Could not copy the review note");
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const position = TABS.findIndex((item) => item.id === tab);
    const next = TABS[(position + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    if (next === undefined) return;
    dispatch({ type: "inspector/tab", tab: next.id });
    event.currentTarget.querySelector<HTMLElement>(`#tv-tab-${next.id}`)?.focus();
  };

  const regroupedTitle =
    regrouped === null || session === null ? null : (session.chapters.find((item) => item.id === regrouped.to)?.title ?? null);

  return (
    <div className={styles.inspector}>
      <Header session={session} index={index} selection={selection} step={step} chapter={chapter} />
      {regroupedTitle === null ? null : <p className={styles.note}>{`Regrouped into “${regroupedTitle}”`}</p>}
      <div role="tablist" aria-label="Inspector tabs" className={styles.tabs} onKeyDown={onTabKeyDown}>
        {TABS.map((item) => (
          <button
            key={item.id}
            id={`tv-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            aria-controls="tv-inspector-panel"
            tabIndex={tab === item.id ? 0 : -1}
            className={styles.tab}
            onClick={() => dispatch({ type: "inspector/tab", tab: item.id })}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        key={selection ?? "none"}
        id="tv-inspector-panel"
        role="tabpanel"
        aria-labelledby={`tv-tab-${tab}`}
        className={styles.body}
      >
        <TabBody tab={tab} session={session} index={index} selection={selection} />
      </div>
      <div className={styles.footer}>
        <button
          type="button"
          className={styles.primary}
          disabled={selection === null || session === null}
          onClick={() => void onPrimary()}
        >
          <Icon name={canRequest ? "reply" : "copy"} size={14} />
          <span>{canRequest ? "Request changes" : "Copy review note"}</span>
        </button>
        {hasDiff ? (
          <button
            type="button"
            className={styles.secondary}
            disabled={selection === null}
            onClick={() => dispatch({ type: "inspector/tab", tab: "evidence" })}
          >
            <Icon name="diff" size={14} />
            <span>Diff</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Mount the Inspector and give diagnostics the real title**

In `packages/trace-viewer/src/ui/shell/Shell.tsx`:

1. Add after `import { IconSprite } from "../icons/IconSprite.js";`:

```tsx
import { selectionTitle } from "../inspector/finding-copy.js";
import { Inspector } from "../inspector/Inspector.js";
```

2. Replace the anchor

```tsx
function selectedTitleFor(
  _session: TraceSession | null,
  _index: TraceIndex,
  _selection: SelectionId | null,
): string | null {
  return null;
}
```

with

```tsx
function selectedTitleFor(
  session: TraceSession | null,
  index: TraceIndex,
  selection: SelectionId | null,
): string | null {
  return session === null || selection === null ? null : selectionTitle(session, index, selection);
}
```

3. Replace the anchor `<aside className={styles.inspector} aria-label="Inspector" data-region="inspector" />` with:

```tsx
                  <aside className={styles.inspector} aria-label="Inspector" data-region="inspector">
                    <ErrorBoundary region="Inspector">
                      <Inspector host={host} />
                    </ErrorBoundary>
                  </aside>
```

- [ ] **Step 9: Run the tests to see them pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/inspector src/ui/shell`
Expected: PASS (review-note 5, inspector 7, and the earlier shell, title-bar and outline suites).

- [ ] **Step 10: Root checks**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint`
Expected: exit 0.

- [ ] **Step 11: Commit**

```bash
git add packages/trace-viewer/src/ui/inspector/finding-copy.ts packages/trace-viewer/src/ui/inspector/review-note.ts \
  packages/trace-viewer/src/ui/inspector/review-note.test.ts packages/trace-viewer/src/ui/inspector/Summary.tsx \
  packages/trace-viewer/src/ui/inspector/Inspector.tsx packages/trace-viewer/src/ui/inspector/Inspector.module.css \
  packages/trace-viewer/src/ui/inspector/inspector.test.tsx packages/trace-viewer/src/ui/shell/Shell.tsx
git commit -m "feat(trace-viewer): add the inspector summary, finding titles and review note"
```

---

### Task C2-7: Inspector Evidence (CodeDiff, output, labels) and lazy Raw

**Files:**
- Create: `packages/trace-viewer/src/ui/inspector/Raw.tsx`
- Create: `packages/trace-viewer/src/ui/inspector/Evidence.tsx`
- Modify: `packages/trace-viewer/src/ui/inspector/Inspector.module.css` (append diff and raw rules)
- Modify: `packages/trace-viewer/src/ui/inspector/Inspector.tsx` (deviation 2: mount Evidence and Raw)
- Test: `packages/trace-viewer/src/ui/inspector/evidence-raw.test.tsx`

**Interfaces:**
- Consumes: C2-1 `CodeDiff({ props: { file, diff } })` from `@jevcode/ui-catalog/components/CodeDiff` (build ui-catalog first, conventions 3); W0 `TRACE_PAYLOADS_MAX = 50`, `TraceRow` (`clipped?: boolean`); the `git_hunk` payload `diff: { hash, bytes, text?, truncated, redactions, withheld? }`; `EditDetail.diff: "text" | "truncated" | "withheld_secret" | "not_captured" | "none"` and `diffSeq?`; C2-3 `useSessionView().payloads`.
- Produces:

```ts
// ui/inspector/Raw.tsx
export type PayloadState = { status: "loading" } | { status: "ready"; rows: TraceRow[] } | { status: "error"; message: string };
export function usePayloadRows(seqs: readonly number[]): { state: PayloadState; retry(): void };
export function selectionSeqs(session: TraceSession, index: TraceIndex, id: SelectionId): number[];
export function PayloadError(props: { message: string; onRetry(): void }): React.JSX.Element;
export function Raw(props: { selection: SelectionId | null }): React.JSX.Element;
// ui/inspector/Evidence.tsx
export function Evidence(props: { selection: SelectionId | null }): React.JSX.Element;
```

Labels (spec §7.1 Evidence and §7.11 Partial): "Diff withheld: secret path", "Not captured", "Truncated at hunk boundary · showing 32 KB of 410 KB", "2 secrets redacted", "Clipped to head + tail (16 KiB)", "No evidence for this item", and an inline "Retry" on a payload failure. Raw fetches only while its tab is shown, at most 50 seqs, then "N more"; JSON renders as text through `displayUntrusted(…, { multiline: true })`.

- [ ] **Step 1: Write the failing test**

Create `packages/trace-viewer/src/ui/inspector/evidence-raw.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TraceRow } from "@jevcode/contracts";

import type { Step, TraceSession } from "../../model/index.js";
import {
  fixtureTrace,
  foldFixture,
  payloadOf,
  renderHarness,
  stubLayout,
  type LayoutStub,
} from "../../test-support/ui-harness.js";
import { Evidence } from "./Evidence.js";
import { Raw } from "./Raw.js";

let layout: LayoutStub;
beforeEach(() => {
  layout = stubLayout();
});
afterEach(() => {
  cleanup();
  layout.restore();
});

function withStep(base: TraceSession, id: string, change: (step: Step) => Step): TraceSession {
  return { ...base, steps: base.steps.map((step) => (step.id === id ? change(step) : step)) };
}

function fixturePayloads(mark?: (row: TraceRow) => TraceRow) {
  const { rows } = fixtureTrace("oauth");
  return vi.fn(async (seqs: readonly number[]) =>
    rows.filter((row) => seqs.includes(row.seq)).map((row) => (mark === undefined ? row : mark(row))),
  );
}

describe("Evidence", () => {
  it("shows the withheld label and no CodeDiff for a secret path", () => {
    const base = foldFixture("oauth");
    const edit = base.steps.find((step) => step.edit !== undefined);
    const session = withStep(base, edit?.id ?? "", (step) =>
      step.edit === undefined ? step : { ...step, edit: { ...step.edit, diff: "withheld_secret" } },
    );
    renderHarness(<Evidence selection={edit?.id ?? null} />, session);
    expect(screen.getByText("Diff withheld: secret path")).toBeTruthy();
    expect(screen.queryByTestId("code-diff")).toBeNull();
  });

  it("renders a captured diff through CodeDiff with redaction and truncation labels", async () => {
    const base = foldFixture("oauth");
    const edit = base.steps.find((step) => step.edit !== undefined);
    const session = withStep(base, edit?.id ?? "", (step) =>
      step.edit === undefined ? step : { ...step, edit: { ...step.edit, diff: "truncated", diffSeq: 999 } },
    );
    const payloads = vi.fn(async () => [
      {
        seq: 999,
        type: "evidence_fact",
        ts: "2026-09-18T09:00:15.000Z",
        payload: {
          type: "git_hunk",
          file: edit?.edit?.path,
          diff: { hash: "0123456789abcdef", bytes: 420_000, text: "@@ -3,1 +3,2 @@\n a\n+b\n", truncated: true, redactions: 2 },
        },
      } satisfies TraceRow,
    ]);
    renderHarness(<Evidence selection={edit?.id ?? null} />, session, { payloads });
    await screen.findByTestId("code-diff");
    expect(payloads).toHaveBeenCalledWith([999]);
    expect(screen.getByText("2 secrets redacted")).toBeTruthy();
    expect(screen.getByText(/^Truncated at hunk boundary · showing 0 KB of 410 KB$/)).toBeTruthy();
  });

  it("shows the completion row's output with its clipping label", async () => {
    const session = foldFixture("oauth");
    const test = session.steps.find((step) => step.command?.command === "pnpm test");
    const payloads = fixturePayloads((row) =>
      row.type === "agent_event" && payloadOf(row).type === "command_completed" ? { ...row, clipped: true } : row,
    );
    renderHarness(<Evidence selection={test?.id ?? null} />, session, { payloads });
    await screen.findByText(/Tests\s+1 failed \| 14 passed \(15\)/);
    expect(screen.getByText("Clipped to head + tail (16 KiB)")).toBeTruthy();
  });

  it("a payload failure shows an inline Retry", async () => {
    const session = foldFixture("oauth");
    const test = session.steps.find((step) => step.command?.command === "pnpm test");
    const ok = fixturePayloads();
    const payloads = vi
      .fn(async (seqs: readonly number[]) => ok(seqs))
      .mockRejectedValueOnce(new Error("channel closed"));
    renderHarness(<Evidence selection={test?.id ?? null} />, session, { payloads });
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await screen.findByText(/Tests\s+1 failed \| 14 passed \(15\)/);
    expect(payloads).toHaveBeenCalledTimes(2);
  });

  it("says so when the item has no evidence", () => {
    const session = foldFixture("oauth");
    const message = session.steps.find((step) => step.kind === "message");
    renderHarness(<Evidence selection={message?.id ?? null} />, session);
    expect(screen.getByText("No evidence for this item")).toBeTruthy();
  });
});

describe("Raw", () => {
  it("fetches at most 50 seqs and shows N more", async () => {
    const base = foldFixture("oauth");
    const first = base.steps[0];
    const seqs = Array.from({ length: 60 }, (_, i) => i + 1);
    const session = withStep(base, first?.id ?? "", (step) => ({ ...step, seqs }));
    const payloads = fixturePayloads();
    renderHarness(<Raw selection={first?.id ?? null} />, session, { payloads });
    await waitFor(() => expect(payloads).toHaveBeenCalledTimes(1));
    expect(payloads.mock.calls[0]?.[0]).toEqual(seqs.slice(0, 50));
    expect(screen.getByText("10 more")).toBeTruthy();
  });

  it("labels a clipped row", async () => {
    const session = foldFixture("oauth");
    const first = session.steps[0];
    const payloads = fixturePayloads((row) => ({ ...row, clipped: true }));
    renderHarness(<Raw selection={first?.id ?? null} />, session, { payloads });
    expect((await screen.findAllByText(/Clipped to head \+ tail \(16 KiB\)/)).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @jevcode/ui-catalog build && pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/inspector/evidence-raw.test.tsx`
Expected: FAIL with `Failed to resolve import "./Evidence.js"`.

- [ ] **Step 3: Implement Raw**

Create `packages/trace-viewer/src/ui/inspector/Raw.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { TRACE_PAYLOADS_MAX, type TraceRow } from "@jevcode/contracts";

import type { SelectionId, TraceIndex } from "../../layout/trace-index.js";
import { displayUntrusted, type TraceSession } from "../../model/index.js";
import { useSessionView } from "../shell/session-context.js";
import styles from "./Inspector.module.css";

export type PayloadState =
  | { status: "loading" }
  | { status: "ready"; rows: TraceRow[] }
  | { status: "error"; message: string };

/** Fetches full rows through TraceSource.payloads; refetches only when the seq list changes or on retry. */
export function usePayloadRows(seqs: readonly number[]): { state: PayloadState; retry(): void } {
  const { payloads } = useSessionView();
  const fetchRows = useRef(payloads);
  fetchRows.current = payloads;
  const key = seqs.join(",");
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PayloadState>({ status: "loading" });
  useEffect(() => {
    if (key === "") {
      setState({ status: "ready", rows: [] });
      return undefined;
    }
    let cancelled = false;
    setState({ status: "loading" });
    fetchRows.current(key.split(",").map(Number)).then(
      (rows) => {
        if (!cancelled) setState({ status: "ready", rows });
      },
      (error: unknown) => {
        if (!cancelled) setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, retry };
}

export function selectionSeqs(session: TraceSession, index: TraceIndex, id: SelectionId): number[] {
  const entry = index.entry(id);
  if (entry?.kind === "chapter") {
    const chapter = session.chapters[entry.position];
    if (chapter === undefined) return [];
    return [...new Set([chapter.firstSeq, chapter.lastSeq, ...chapter.factSeqs])].sort((a, b) => a - b);
  }
  const step = entry === undefined ? undefined : session.steps[entry.position];
  return step === undefined ? [] : [...step.seqs];
}

export function PayloadError({ message, onRetry }: { message: string; onRetry(): void }) {
  return (
    <p className={styles.error}>
      <span>{`Could not load rows: ${message}`}</span>
      <button type="button" className={styles.inlineButton} onClick={onRetry}>
        Retry
      </button>
    </p>
  );
}

export function Raw({ selection }: { selection: SelectionId | null }) {
  const { session, index } = useSessionView();
  const all = useMemo(
    () => (session === null || selection === null ? [] : selectionSeqs(session, index, selection)),
    [session, index, selection],
  );
  const shown = useMemo(() => all.slice(0, TRACE_PAYLOADS_MAX), [all]);
  const { state, retry } = usePayloadRows(shown);
  if (selection === null) return <p className={styles.muted}>Select an item to see its rows</p>;
  return (
    <div className={styles.raw}>
      {state.status === "loading" ? <p className={styles.muted}>Loading rows</p> : null}
      {state.status === "error" ? <PayloadError message={state.message} onRetry={retry} /> : null}
      {state.status === "ready"
        ? state.rows.map((row) => (
            <figure key={row.seq} className={styles.rawRow}>
              <figcaption className={styles.muted}>
                {`seq ${row.seq} · ${row.type}`}
                {row.clipped === true ? " · Clipped to head + tail (16 KiB)" : ""}
              </figcaption>
              <pre className={styles.mono}>{displayUntrusted(JSON.stringify(row, null, 2), { multiline: true })}</pre>
            </figure>
          ))
        : null}
      {all.length > shown.length ? <p className={styles.muted}>{`${all.length - shown.length} more`}</p> : null}
    </div>
  );
}
```

- [ ] **Step 4: Implement Evidence**

Create `packages/trace-viewer/src/ui/inspector/Evidence.tsx`:

```tsx
import { CodeDiff } from "@jevcode/ui-catalog/components/CodeDiff";

import type { TraceRow } from "@jevcode/contracts";

import type { SelectionId } from "../../layout/trace-index.js";
import { displayUntrusted, exitLabel, type Chapter, type Step, type TraceSession } from "../../model/index.js";
import { useSessionView } from "../shell/session-context.js";
import styles from "./Inspector.module.css";
import { PayloadError, usePayloadRows } from "./Raw.js";

interface DiffPayload {
  text: string;
  bytes: number;
  truncated: boolean;
  redactions: number;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function diffOf(row: TraceRow | undefined): DiffPayload | null {
  const diff = record(record(row?.payload).diff);
  if (typeof diff.text !== "string") return null;
  return {
    text: diff.text,
    bytes: typeof diff.bytes === "number" ? diff.bytes : diff.text.length,
    truncated: diff.truncated === true,
    redactions: typeof diff.redactions === "number" ? diff.redactions : 0,
  };
}

function kb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

const CLIPPED = "Clipped to head + tail (16 KiB)";

function EditEvidence({ step }: { step: Step }) {
  const edit = step.edit;
  const fetchable = edit !== undefined && edit.diffSeq !== undefined && (edit.diff === "text" || edit.diff === "truncated");
  const { state, retry } = usePayloadRows(fetchable && edit.diffSeq !== undefined ? [edit.diffSeq] : []);
  if (edit === undefined) return null;
  const header = <p className={styles.path}>{displayUntrusted(edit.path)}</p>;
  if (edit.diff === "withheld_secret") {
    return (
      <section className={styles.section}>
        {header}
        <p className={styles.label}>Diff withheld: secret path</p>
      </section>
    );
  }
  if (edit.diff === "not_captured") {
    return (
      <section className={styles.section}>
        {header}
        <p className={styles.label}>Not captured</p>
      </section>
    );
  }
  if (!fetchable) {
    return (
      <section className={styles.section}>
        {header}
        <p className={styles.muted}>No diff recorded</p>
      </section>
    );
  }
  if (state.status === "error") {
    return (
      <section className={styles.section}>
        {header}
        <PayloadError message={state.message} onRetry={retry} />
      </section>
    );
  }
  if (state.status === "loading") {
    return (
      <section className={styles.section}>
        {header}
        <p className={styles.muted}>Loading diff</p>
      </section>
    );
  }
  const row = state.rows[0];
  const diff = diffOf(row);
  if (diff === null) {
    return (
      <section className={styles.section}>
        {header}
        <p className={styles.label}>Not captured</p>
      </section>
    );
  }
  return (
    <section className={styles.section}>
      {header}
      {diff.truncated ? (
        <p className={styles.label}>{`Truncated at hunk boundary · showing ${kb(diff.text.length)} of ${kb(diff.bytes)}`}</p>
      ) : null}
      {diff.redactions > 0 ? (
        <p className={styles.label}>{`${diff.redactions} ${diff.redactions === 1 ? "secret" : "secrets"} redacted`}</p>
      ) : null}
      {row?.clipped === true ? <p className={styles.label}>{CLIPPED}</p> : null}
      <div className={styles.diff}>
        <CodeDiff props={{ file: edit.path, diff: diff.text }} />
      </div>
    </section>
  );
}

function OutputEvidence({ step }: { step: Step }) {
  const { state, retry } = usePayloadRows(step.seqs);
  if (state.status === "error") return <PayloadError message={state.message} onRetry={retry} />;
  if (state.status === "loading") return <p className={styles.muted}>Loading output</p>;
  const completion = [...state.rows]
    .reverse()
    .find((row) => {
      const type = record(row.payload).type;
      return row.type === "agent_event" && (type === "command_completed" || type === "test_completed");
    });
  if (completion === undefined) return <p className={styles.muted}>No output recorded</p>;
  const payload = record(completion.payload);
  const stdout = typeof payload.stdout === "string" ? payload.stdout : "";
  const stderr = typeof payload.stderr === "string" ? payload.stderr : "";
  return (
    <section className={styles.section}>
      <p className={styles.meta}>{exitLabel(step.command?.exitCode ?? null)}</p>
      {completion.clipped === true ? <p className={styles.label}>{CLIPPED}</p> : null}
      {stdout === "" ? null : <pre className={styles.mono}>{displayUntrusted(stdout, { multiline: true })}</pre>}
      {stderr === "" ? null : <pre className={styles.mono}>{displayUntrusted(stderr, { multiline: true })}</pre>}
      {stdout === "" && stderr === "" ? <p className={styles.muted}>The command printed nothing</p> : null}
    </section>
  );
}

function DecisionEvidence({ step }: { step: Step }) {
  const { state, retry } = usePayloadRows(step.seqs);
  if (state.status === "error") return <PayloadError message={state.message} onRetry={retry} />;
  if (state.status === "loading") return <p className={styles.muted}>Loading the decision</p>;
  const latest = [...state.rows].reverse().find((row) => row.type === "decision");
  const options = Array.isArray(record(latest?.payload).options) ? (record(latest?.payload).options as unknown[]) : [];
  const chosen = new Set((step.decision?.options ?? []).filter((option) => option.chosen).map((option) => option.id));
  return (
    <section className={styles.section}>
      <ul className={styles.list}>
        {options.map((raw) => {
          const option = record(raw);
          const id = typeof option.id === "string" ? option.id : "";
          return (
            <li key={id} className={chosen.has(id) ? styles.chosen : undefined}>
              <span>{typeof option.label === "string" ? option.label : id}</span>
              {typeof option.description === "string" && option.description !== "" ? (
                <p className={styles.muted}>{option.description}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className={styles.meta}>
        {chosen.size > 0
          ? `Answer: ${(step.decision?.options ?? []).filter((option) => option.chosen).map((option) => option.label).join(", ")}`
          : "No answer yet"}
      </p>
    </section>
  );
}

function ChapterEvidence({ chapter, session }: { chapter: Chapter; session: TraceSession }) {
  const latestByPath = new Map<string, Step>();
  const members = new Set(chapter.stepIds);
  for (const step of session.steps) {
    if (members.has(step.id) && step.edit !== undefined) latestByPath.set(step.edit.path, step);
  }
  if (latestByPath.size === 0) return <p className={styles.muted}>No evidence for this item</p>;
  return (
    <>
      {[...latestByPath.values()].map((step) => (
        <EditEvidence key={step.id} step={step} />
      ))}
    </>
  );
}

export function Evidence({ selection }: { selection: SelectionId | null }) {
  const { session, index } = useSessionView();
  if (session === null || selection === null) return <p className={styles.muted}>No evidence for this item</p>;
  const entry = index.entry(selection);
  if (entry?.kind === "chapter") {
    const chapter = session.chapters[entry.position];
    return chapter === undefined ? <p className={styles.muted}>No evidence for this item</p> : <ChapterEvidence chapter={chapter} session={session} />;
  }
  const step = entry === undefined ? undefined : session.steps[entry.position];
  if (step?.edit !== undefined) return <EditEvidence step={step} />;
  if (step?.command !== undefined) return <OutputEvidence step={step} />;
  if (step?.decision !== undefined) return <DecisionEvidence step={step} />;
  return <p className={styles.muted}>No evidence for this item</p>;
}
```

- [ ] **Step 5: Append the diff and raw styles**

Append to `packages/trace-viewer/src/ui/inspector/Inspector.module.css`:

```css
.label {
  margin: 0;
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-ink-2);
}

.error {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-ink-2);
}

.inlineButton {
  padding: 2px 8px;
  border: 0;
  border-radius: 6px;
  background: var(--tv-fill-2);
  color: var(--tv-ink);
  font: inherit;
  cursor: pointer;
}

.raw {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.rawRow {
  margin: 0;
  padding: 8px;
  border-radius: 6px;
  background: var(--tv-fill);
}

.diff {
  overflow-x: auto;
  border-radius: 6px;
  background: var(--tv-panel);
  box-shadow: inset 0 0 0 1px var(--tv-hair);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12px;
  line-height: 18px;
}

.diff :global(.d2h-file-header),
.diff :global(.d2h-file-list-wrapper) {
  display: none;
}

.diff :global(.d2h-diff-table) {
  width: 100%;
  border-collapse: collapse;
}

.diff :global(.d2h-code-linenumber) {
  width: 1%;
  padding: 0 6px;
  color: var(--tv-ink-3);
  white-space: nowrap;
  vertical-align: top;
}

.diff :global(.d2h-code-line) {
  padding: 0 8px;
  color: var(--tv-ink);
  white-space: pre;
}

.diff :global(.d2h-code-line-prefix) {
  color: var(--tv-ink-3);
}

.diff :global(.d2h-ins) {
  background: var(--tv-fill-2);
}

.diff :global(.d2h-del) {
  background: var(--tv-panel);
}

.diff :global(.d2h-info) {
  background: var(--tv-fill);
  color: var(--tv-ink-3);
}

.diff :global(.d2h-code-line ins),
.diff :global(.d2h-code-line del) {
  background: transparent;
  text-decoration: none;
}
```

- [ ] **Step 6: Mount Evidence and Raw in the Inspector**

In `packages/trace-viewer/src/ui/inspector/Inspector.tsx`, add after `import { buildReviewNote } from "./review-note.js";`:

```tsx
import { Evidence } from "./Evidence.js";
import { Raw } from "./Raw.js";
```

and in `TabBody` replace the anchor line

```tsx
  return <p className={styles.muted}>No evidence for this item</p>;
```

with

```tsx
  if (tab === "evidence") return <Evidence selection={selection} />;
  return <Raw selection={selection} />;
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/inspector`
Expected: PASS (evidence-raw 7, inspector 7, review-note 5).

- [ ] **Step 8: Root checks**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint`
Expected: exit 0. `pnpm lint` accepts `@jevcode/ui-catalog/components/CodeDiff` (the only allowed ui-catalog form).

- [ ] **Step 9: Commit**

```bash
git add packages/trace-viewer/src/ui/inspector/Raw.tsx packages/trace-viewer/src/ui/inspector/Evidence.tsx \
  packages/trace-viewer/src/ui/inspector/Inspector.module.css packages/trace-viewer/src/ui/inspector/Inspector.tsx \
  packages/trace-viewer/src/ui/inspector/evidence-raw.test.tsx
git commit -m "feat(trace-viewer): add inspector evidence with CodeDiff and lazy raw rows"
```

---
### Task C2-8: Keyboard layer, regions and F6, roving tabindex, shortcut sheet

**Files:**
- Create: `packages/trace-viewer/src/ui/shell/regions.ts`
- Create: `packages/trace-viewer/src/ui/shell/KeyboardLayer.tsx`
- Create: `packages/trace-viewer/src/ui/shell/ShortcutSheet.tsx`
- Modify: `packages/trace-viewer/src/ui/shell/Shell.module.css` (append sheet styles, deviation 2)
- Modify: `packages/trace-viewer/src/ui/shell/Shell.tsx` (deviation 2: root ref and the keyboard layer)
- Test: `packages/trace-viewer/src/ui/shell/keyboard.test.tsx`

**Interfaces:**
- Consumes: C1b `resolveKey(input: KeyInput, context: KeyContext, phase: "down" | "up"): KeyCommand | null`, `KeyInput`, `KeyCommand` (commands `item`, `chapter`, `turn`, `finding`, `toggle`, `esc`, `view`, `level`, `playhead`, `first`, `last`, `zoom`, `fit`, `tool`, `space`, `brushEdge`, `brushChapter`, `search`, `help`, `region`, `copyNote`), `useViewStore`, reducer actions `select`, `nav`, `nav/first`, `nav/last`, `expand/toggle`, `esc`, `view/switch`, `level/set`, `playhead/step`, `follow/set`, `tool/set`, `brush/edge`, `brush/chapter`, `Tool`, `TraceIndex.entry(id)?.parent`, `SelectionId`; C2-3 `useSessionView`, `useAnnounce`, `useViewPortRegistry`, `ViewDefinitionsContext`, `ViewPort`, `markAfterPaint`, `PERF`; C2-6 `buildReviewNote`, `copyText`, `FINDING_TITLE`.
- Produces:

```ts
// ui/shell/regions.ts
export const REGIONS: readonly ["outline", "main", "inspector"];
export type Region = "outline" | "main" | "inspector";
export function regionOf(element: Element | null): Region | null;
export function nextRegion(current: Region | null, dir: 1 | -1): Region;
export function focusRegion(root: ParentNode, region: Region): void;
export function isEditableTarget(target: Element | null): boolean;
export function hasTextSelection(): boolean;
/** j/k over a view's reading order; an unknown id falls back to its parent (step → unit); nothing selected starts at an end; null at an end. */
export function nextInOrder(order: readonly SelectionId[], current: SelectionId | null, dir: 1 | -1, index: TraceIndex): SelectionId | null;
/** The adjacent session step beyond a view's reading order (Hybrid j past the brush edge slides the brush). */
export function adjacentStep(session: TraceSession, index: TraceIndex, current: SelectionId | null, dir: 1 | -1): SelectionId | null;
// ui/shell/KeyboardLayer.tsx
export interface KeyboardLayerProps { root: HTMLElement | null }
export function KeyboardLayer(props: KeyboardLayerProps): React.JSX.Element | null;
// ui/shell/ShortcutSheet.tsx
export const SHORTCUTS: ReadonlyArray<readonly [keys: string, action: string]>;
export function ShortcutSheet(props: { onClose(): void }): React.JSX.Element;
```

One window-level `keydown`/`keyup` listener serves the whole viewer (events whose target lies outside the viewer root, other than `body`, are ignored). `Space` is a command only over a pannable surface or with focus in `main`, and its `keydown` and `keyup` are both `preventDefault`ed, so a focused button in `main` is never clicked. `Esc` closes the shortcut sheet first, then dispatches the reducer's unwind (search → hand → collapse → parent → clear) and never calls the view port's reveal or zoom. A `follow` change from true to false is announced once ("Live follow paused"); reaching a terminal state announces "Session ended".

- [ ] **Step 1: Write the failing test**

Create `packages/trace-viewer/src/ui/shell/keyboard.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SelectionId } from "../../layout/trace-index.js";
import { createStaticBundleSource } from "../../sources/static-bundle.js";
import {
  fixtureBundle,
  foldFixture,
  renderHarness,
  stubLayout,
  type LayoutStub,
} from "../../test-support/ui-harness.js";
import type { ViewPort } from "../views/view-port.js";
import { KeyboardLayer } from "./KeyboardLayer.js";
import { regionOf } from "./regions.js";
import { TraceViewer } from "./TraceViewer.js";

let layout: LayoutStub;
beforeEach(() => {
  layout = stubLayout();
});
afterEach(() => {
  cleanup();
  layout.restore();
  vi.restoreAllMocks();
  window.getSelection()?.removeAllRanges();
});

function KeyHarness({ children }: { children?: ReactNode }) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setRoot}>
      <nav data-region="outline">
        <button type="button" tabIndex={0}>
          outline row
        </button>
      </nav>
      <main data-region="main" tabIndex={-1}>
        {children}
      </main>
      <aside data-region="inspector">
        <button type="button" tabIndex={0}>
          inspector tab
        </button>
      </aside>
      <KeyboardLayer root={root} />
    </div>
  );
}

function fakePort(order: readonly SelectionId[]): ViewPort & { calls: string[] } {
  const calls: string[] = [];
  const note = (name: string) => (): void => {
    calls.push(name);
  };
  return {
    calls,
    readingOrder: () => order,
    reveal: (id) => {
      calls.push(`reveal:${id}`);
    },
    captureCamera: () => null,
    focusSelected: note("focusSelected"),
    zoom: {
      label: () => "Chapter",
      presets: () => [],
      applyPreset: note("applyPreset"),
      zoomIn: note("zoomIn"),
      zoomOut: note("zoomOut"),
      resetToPreset: note("resetToPreset"),
      fitAll: note("fitAll"),
      fitSelection: note("fitSelection"),
    },
  };
}

describe("KeyboardLayer", () => {
  it("keeps exactly one tabindex=0 in the Outline and the Inspector", async () => {
    render(<TraceViewer source={createStaticBundleSource(fixtureBundle("oauth"))} />);
    await waitFor(() => expect(screen.getAllByRole("treeitem").length).toBeGreaterThan(0));
    const outline = screen.getByRole("navigation", { name: "Outline" });
    const inspector = screen.getByRole("complementary", { name: "Inspector" });
    expect(outline.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    expect(inspector.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  });

  it("F6 cycles Outline → main → Inspector", async () => {
    render(<TraceViewer source={createStaticBundleSource(fixtureBundle("oauth"))} />);
    await waitFor(() => expect(screen.getAllByRole("treeitem").length).toBeGreaterThan(0));
    const visited: Array<string | null> = [];
    for (let i = 0; i < 3; i += 1) {
      fireEvent.keyDown(document.activeElement ?? document.body, { code: "F6", key: "F6" });
      visited.push(regionOf(document.activeElement));
    }
    expect(visited).toEqual(["outline", "main", "inspector"]);
  });

  it("moves like j for a Hangul input source and ignores composing keys", () => {
    const session = foldFixture("oauth");
    const [a, b, c] = session.steps;
    const order = [a?.id, b?.id, c?.id].filter((id): id is `step:${number}` => id !== undefined);
    const h = renderHarness(<KeyHarness />, session, { state: { selection: order[0] ?? null } });
    act(() => {
      h.registry.register("hybrid", fakePort(order));
    });
    fireEvent.keyDown(document.body, { code: "KeyJ", key: "ㅓ" });
    expect(h.store.get().selection).toBe(order[1]);
    fireEvent.keyDown(document.body, { code: "KeyJ", key: "j", isComposing: true });
    expect(h.store.get().selection).toBe(order[1]);
  });

  it("Esc unwinds search → hand → collapse → parent → clear and never moves the camera", () => {
    const session = foldFixture("oauth");
    const step = session.steps.find((item) => item.chapterIds.length > 0);
    const h = renderHarness(<KeyHarness />, session, {
      state: {
        selection: step?.id ?? null,
        tool: "hand",
        search: { query: "pnpm", matchIds: [], cursor: 0 },
        expanded: new Set([step?.id ?? ""]),
      },
    });
    const port = fakePort([]);
    act(() => {
      h.registry.register("hybrid", port);
    });
    const press = (): void => {
      fireEvent.keyDown(document.body, { code: "Escape", key: "Escape" });
    };
    press();
    expect(h.store.get().search).toBeNull();
    press();
    expect(h.store.get().tool).toBe("select");
    press();
    expect(h.store.get().expanded.has(step?.id ?? "")).toBe(false);
    press();
    expect(h.store.get().selection?.startsWith("unit:")).toBe(true);
    press();
    expect(h.store.get().selection).toBeNull();
    expect(port.calls).toEqual([]);
  });

  it("Space with focus on a button in main pans and never clicks it", async () => {
    const onClick = vi.fn();
    const h = renderHarness(
      <KeyHarness>
        <button type="button" onClick={onClick}>
          row action
        </button>
      </KeyHarness>,
      foldFixture("oauth"),
    );
    const user = userEvent.setup();
    screen.getByRole("button", { name: "row action" }).focus();
    await user.keyboard("[Space>]");
    expect(h.store.get().tool).toBe("hand");
    await user.keyboard("[/Space]");
    expect(h.store.get().tool).toBe("select");
    expect(onClick).not.toHaveBeenCalled();
  });

  it("Cmd+C with a text selection leaves the clipboard to the browser", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const session = foldFixture("oauth");
    renderHarness(
      <KeyHarness>
        <p>selectable words</p>
      </KeyHarness>,
      session,
      { state: { selection: session.steps[0]?.id ?? null } },
    );
    window.getSelection()?.selectAllChildren(screen.getByText("selectable words"));
    fireEvent.keyDown(document.body, { code: "KeyC", key: "c", metaKey: true });
    await act(async () => undefined);
    expect(writeText).not.toHaveBeenCalled();

    window.getSelection()?.removeAllRanges();
    fireEvent.keyDown(document.body, { code: "KeyC", key: "c", metaKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(String(writeText.mock.calls[0]?.[0]).startsWith("Re: trace ")).toBe(true);
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("announces the finding position on n", () => {
    const session = foldFixture("oauth");
    const h = renderHarness(<KeyHarness />, session);
    act(() => {
      h.registry.register("hybrid", fakePort([]));
    });
    fireEvent.keyDown(document.body, { code: "KeyN", key: "n" });
    expect(h.announcements.some((message) => /^Finding \d+ of \d+: /.test(message))).toBe(true);
  });

  it("announces Live follow paused once when follow turns off", () => {
    const h = renderHarness(<KeyHarness />, foldFixture("oauth"), { state: { follow: true } });
    act(() => h.store.dispatch({ type: "follow/set", follow: false }));
    act(() => h.store.dispatch({ type: "follow/set", follow: false }));
    expect(h.announcements.filter((message) => message === "Live follow paused")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/shell/keyboard.test.tsx`
Expected: FAIL with `Failed to resolve import "./KeyboardLayer.js"`.

- [ ] **Step 3: Implement the region helpers**

Create `packages/trace-viewer/src/ui/shell/regions.ts`:

```ts
import type { SelectionId, TraceIndex } from "../../layout/trace-index.js";
import type { TraceSession } from "../../model/index.js";

export const REGIONS = ["outline", "main", "inspector"] as const;
export type Region = (typeof REGIONS)[number];

export function regionOf(element: Element | null): Region | null {
  const value = element?.closest("[data-region]")?.getAttribute("data-region") ?? null;
  return value === "outline" || value === "main" || value === "inspector" ? value : null;
}

export function nextRegion(current: Region | null, dir: 1 | -1): Region {
  if (current === null) return dir === 1 ? "outline" : "inspector";
  const position = REGIONS.indexOf(current);
  return REGIONS[(position + dir + REGIONS.length) % REGIONS.length] ?? "outline";
}

/** Focuses the region's roving tab stop, else the region element itself. */
export function focusRegion(root: ParentNode, region: Region): void {
  const container = root.querySelector<HTMLElement>(`[data-region="${region}"]`);
  const target = container?.querySelector<HTMLElement>('[tabindex="0"]') ?? container;
  target?.focus({ preventScroll: true });
}

export function isEditableTarget(target: Element | null): boolean {
  if (target === null) return false;
  if (target.closest("input, textarea, select") !== null) return true;
  const editable = target.closest("[contenteditable]");
  return editable !== null && editable.getAttribute("contenteditable") !== "false";
}

export function hasTextSelection(): boolean {
  if (typeof window === "undefined") return false;
  const selection = window.getSelection();
  return selection !== null && !selection.isCollapsed && selection.toString().length > 0;
}

export function nextInOrder(
  order: readonly SelectionId[],
  current: SelectionId | null,
  dir: 1 | -1,
  index: TraceIndex,
): SelectionId | null {
  if (order.length === 0) return null;
  let position = current === null ? -1 : order.indexOf(current);
  if (position < 0 && current !== null) {
    const parent = index.entry(current)?.parent ?? null;
    if (parent !== null) position = order.indexOf(parent);
  }
  if (position < 0) return dir === 1 ? (order[0] ?? null) : (order[order.length - 1] ?? null);
  return order[position + dir] ?? null;
}

export function adjacentStep(
  session: TraceSession,
  index: TraceIndex,
  current: SelectionId | null,
  dir: 1 | -1,
): SelectionId | null {
  if (current === null) return null;
  const entry = index.entry(current);
  if (entry === undefined || entry.kind !== "step") return null;
  return session.steps[entry.position + dir]?.id ?? null;
}
```

- [ ] **Step 4: Implement the shortcut sheet and its styles**

Create `packages/trace-viewer/src/ui/shell/ShortcutSheet.tsx`:

```tsx
import styles from "./Shell.module.css";

export const SHORTCUTS: ReadonlyArray<readonly [keys: string, action: string]> = [
  ["j / k", "Next or previous item"],
  ["J / K", "Next or previous chapter"],
  ["[ / ]", "Previous or next turn"],
  ["n / N", "Next or previous finding"],
  ["Enter / Esc", "Expand or collapse; Esc steps back"],
  ["1 / 2", "Canvas / Hybrid"],
  ["Alt+1 / 2 / 3", "Session / Chapter / Step"],
  [", / .", "Move the playhead one step"],
  ["g / G", "First item / last item; G follows a running session"],
  ["- / = / 0", "Zoom out / in / back to the level preset"],
  ["Shift+1 / Shift+2", "Fit all / zoom to the selection"],
  ["v / h / hold Space", "Select tool / hand tool / pan"],
  ["{ / } / b", "Brush start / end / chapter (Hybrid)"],
  ["/ / ?", "Search / this sheet"],
  ["F6", "Next region"],
  ["Cmd+C", "Copy a review note"],
];

export function ShortcutSheet({ onClose }: { onClose(): void }) {
  return (
    <div role="dialog" aria-modal="false" aria-label="Keyboard shortcuts" className={styles.sheet}>
      <div className={styles.sheetHeader}>
        <h2 className={styles.sheetTitle}>Keyboard shortcuts</h2>
        <button type="button" className={styles.button} onClick={onClose}>
          Close
        </button>
      </div>
      <dl className={styles.sheetList}>
        {SHORTCUTS.map(([keys, action]) => (
          <div key={keys} className={styles.sheetRow}>
            <dt className={styles.sheetKeys}>{keys}</dt>
            <dd className={styles.sheetAction}>{action}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
```

Append to `packages/trace-viewer/src/ui/shell/Shell.module.css`:

```css
.sheet {
  position: absolute;
  top: 48px;
  right: 296px;
  z-index: 20;
  width: 360px;
  max-height: calc(100% - 64px);
  overflow: auto;
  padding: 12px 16px;
  border-radius: 12px;
  background: var(--tv-panel);
  box-shadow: var(--tv-shadow);
}

.sheetHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.sheetTitle {
  margin: 0;
  font-size: 13px;
  line-height: 18px;
  font-weight: 600;
  color: var(--tv-ink);
}

.sheetList {
  margin: 0;
}

.sheetRow {
  display: grid;
  grid-template-columns: 132px minmax(0, 1fr);
  gap: 8px;
  padding: 3px 0;
  font-size: 12px;
  line-height: 16px;
}

.sheetKeys {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  color: var(--tv-ink);
}

.sheetAction {
  margin: 0;
  color: var(--tv-ink-2);
}
```

- [ ] **Step 5: Implement the keyboard layer**

Create `packages/trace-viewer/src/ui/shell/KeyboardLayer.tsx`:

```tsx
import { useContext, useEffect, useRef, useState } from "react";

import { FINDING_TITLE } from "../inspector/finding-copy.js";
import { copyText } from "../inspector/Inspector.js";
import { buildReviewNote } from "../inspector/review-note.js";
import { resolveKey, type KeyCommand, type KeyInput } from "../state/keymap.js";
import { useViewStore } from "../state/store.js";
import type { Tool } from "../state/view-state.js";
import { useViewPortRegistry, ViewDefinitionsContext } from "../views/view-port.js";
import { useAnnounce } from "./LiveRegion.js";
import { markAfterPaint, PERF } from "./perf.js";
import {
  adjacentStep,
  focusRegion,
  hasTextSelection,
  isEditableTarget,
  nextInOrder,
  nextRegion,
  regionOf,
} from "./regions.js";
import { useSessionView } from "./session-context.js";
import { ShortcutSheet } from "./ShortcutSheet.js";

export interface KeyboardLayerProps {
  root: HTMLElement | null;
}

function markKeyStart(timeStamp: number): void {
  try {
    performance.mark("tv:key-start", { startTime: timeStamp });
  } catch {
    // The HUD loses one sample; navigation is unaffected.
  }
}

/** One keyboard model for the whole viewer (spec §7.9). */
export function KeyboardLayer({ root }: KeyboardLayerProps) {
  const store = useViewStore();
  const registry = useViewPortRegistry();
  const sessionView = useSessionView();
  const views = useContext(ViewDefinitionsContext);
  const announce = useAnnounce();
  const [helpOpen, setHelpOpen] = useState(false);
  const latest = useRef({ sessionView, views, helpOpen, announce });
  latest.current = { sessionView, views, helpOpen, announce };

  useEffect(() => {
    let follow = store.get().follow;
    let terminal = store.get().terminal;
    return store.subscribe(() => {
      const state = store.get();
      if (follow && !state.follow && !state.terminal) latest.current.announce("Live follow paused");
      if (!terminal && state.terminal) latest.current.announce("Session ended");
      follow = state.follow;
      terminal = state.terminal;
    });
  }, [store]);

  useEffect(() => {
    if (root === null) return undefined;
    let pointerTarget: Element | null = null;
    let spaceHeld = false;
    let toolBeforeSpace: Tool = "select";

    const revealSelection = (): void => {
      const state = store.get();
      if (state.selection !== null) registry.get(state.view)?.reveal(state.selection, { animate: true });
    };

    const run = (command: KeyCommand, event: KeyboardEvent): void => {
      const { sessionView: view, views: definitions } = latest.current;
      const state = store.get();
      const port = registry.get(state.view);
      switch (command.cmd) {
        case "item": {
          let next = nextInOrder(port?.readingOrder() ?? [], state.selection, command.dir, view.index);
          if (next === null && view.session !== null) next = adjacentStep(view.session, view.index, state.selection, command.dir);
          if (next === null) return;
          markKeyStart(event.timeStamp);
          store.dispatch({ type: "select", id: next, by: "shell" });
          port?.reveal(next, { animate: false });
          markAfterPaint(PERF.keyToPaint, "tv:key-start");
          return;
        }
        case "chapter":
        case "turn":
          store.dispatch({ type: "nav", target: command.cmd, dir: command.dir });
          revealSelection();
          return;
        case "finding": {
          store.dispatch({ type: "nav", target: "finding", dir: command.dir });
          const selected = store.get().selection;
          const findings = view.index.findingsBySeq;
          const position = findings.findIndex((finding) => finding.anchorStepId === selected);
          const finding = findings[position];
          if (finding !== undefined) {
            latest.current.announce(`Finding ${position + 1} of ${findings.length}: ${FINDING_TITLE[finding.ruleId]}`);
          }
          revealSelection();
          return;
        }
        case "toggle":
          if (state.selection !== null) store.dispatch({ type: "expand/toggle", key: state.selection });
          return;
        case "esc":
          if (latest.current.helpOpen) {
            setHelpOpen(false);
            return;
          }
          store.dispatch({ type: "esc" });
          if (regionOf(document.activeElement) === "inspector") port?.focusSelected();
          return;
        case "view": {
          const definition = definitions.find((item) => item.kind === command.view);
          if (definition === undefined || state.view === command.view) return;
          store.dispatch({ type: "view/switch", view: command.view });
          latest.current.announce(`${definition.label} view`);
          return;
        }
        case "level":
          store.dispatch({ type: "level/set", level: command.level, by: "shell" });
          return;
        case "playhead":
          store.dispatch({ type: "playhead/step", dir: command.dir });
          return;
        case "first":
          store.dispatch({ type: "nav/first" });
          revealSelection();
          return;
        case "last":
          store.dispatch({ type: "nav/last" });
          if (view.summary !== null && !view.terminal) store.dispatch({ type: "follow/set", follow: true });
          revealSelection();
          return;
        case "zoom":
          if (command.op === "in") port?.zoom.zoomIn();
          else if (command.op === "out") port?.zoom.zoomOut();
          else port?.zoom.resetToPreset();
          return;
        case "fit":
          if (command.target === "all") port?.zoom.fitAll();
          else port?.zoom.fitSelection();
          return;
        case "tool":
          store.dispatch({ type: "tool/set", tool: command.tool });
          return;
        case "space":
          if (command.down && !spaceHeld) {
            spaceHeld = true;
            toolBeforeSpace = state.tool;
            store.dispatch({ type: "tool/set", tool: "hand" });
          } else if (!command.down && spaceHeld) {
            spaceHeld = false;
            store.dispatch({ type: "tool/set", tool: toolBeforeSpace });
          }
          return;
        case "brushEdge":
          store.dispatch({ type: "brush/edge", edge: command.edge });
          return;
        case "brushChapter":
          store.dispatch({ type: "brush/chapter" });
          return;
        case "search":
          root.querySelector<HTMLInputElement>("[data-outline-search]")?.focus();
          return;
        case "help":
          setHelpOpen((open) => !open);
          return;
        case "region":
          focusRegion(root, nextRegion(regionOf(document.activeElement), command.dir));
          return;
        case "copyNote": {
          if (view.session === null || state.selection === null) return;
          const note = buildReviewNote(view.session, view.index, state.selection);
          void copyText(note.markdown).then((ok) =>
            latest.current.announce(ok ? "Review note copied" : "Could not copy the review note"),
          );
          return;
        }
      }
    };

    const handle = (event: KeyboardEvent, phase: "down" | "up"): void => {
      const target = event.target instanceof Element ? event.target : null;
      const inside = target === null || target === document.body || target === document.documentElement || root.contains(target);
      if (!inside) return;
      const input: KeyInput = {
        code: event.code,
        key: event.key,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        isComposing: event.isComposing,
        editableTarget: isEditableTarget(target),
      };
      const pannable =
        regionOf(target) === "main" || (pointerTarget !== null && pointerTarget.closest("[data-pannable]") !== null);
      const command = resolveKey(
        input,
        { view: store.get().view, spaceOverPannable: pannable, hasTextSelection: hasTextSelection() },
        phase,
      );
      if (command === null) return;
      event.preventDefault();
      run(command, event);
    };

    const onKeyDown = (event: KeyboardEvent): void => handle(event, "down");
    const onKeyUp = (event: KeyboardEvent): void => handle(event, "up");
    const onPointerOver = (event: PointerEvent): void => {
      pointerTarget = event.target instanceof Element ? event.target : null;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    root.addEventListener("pointerover", onPointerOver);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      root.removeEventListener("pointerover", onPointerOver);
    };
  }, [root, store, registry]);

  return helpOpen ? <ShortcutSheet onClose={() => setHelpOpen(false)} /> : null;
}
```

- [ ] **Step 6: Mount the keyboard layer in the Shell**

In `packages/trace-viewer/src/ui/shell/Shell.tsx`:

1. Add `import { KeyboardLayer } from "./KeyboardLayer.js";` after `import { ErrorBoundary } from "./ErrorBoundary.js";`.
2. Add `const [root, setRoot] = useState<HTMLDivElement | null>(null);` as the second line of `Shell` (after `const store = useViewStore();`).
3. Replace the anchor `<div className={`${base.root} ${styles.root}`} style={tokenStyle() as CSSProperties} data-trace-viewer="">` with:

```tsx
    <div
      ref={setRoot}
      className={`${base.root} ${styles.root}`}
      style={tokenStyle() as CSSProperties}
      data-trace-viewer=""
    >
```

4. Insert `<KeyboardLayer root={root} />` directly after the closing `</div>` of `<div className={styles.grid}>` (still inside `<LiveRegion>`).

- [ ] **Step 7: Run the tests to see them pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/shell`
Expected: PASS, including keyboard.test.tsx (8 tests).

- [ ] **Step 8: Root checks**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add packages/trace-viewer/src/ui/shell/regions.ts packages/trace-viewer/src/ui/shell/KeyboardLayer.tsx \
  packages/trace-viewer/src/ui/shell/ShortcutSheet.tsx packages/trace-viewer/src/ui/shell/Shell.module.css \
  packages/trace-viewer/src/ui/shell/Shell.tsx packages/trace-viewer/src/ui/shell/keyboard.test.tsx
git commit -m "feat(trace-viewer): add the keyboard layer, F6 regions and shortcut sheet"
```

---

### Task C2-9: Shared view parts: `Ruler`, `LevelControl`, `NewBadge`

**Files:**
- Create: `packages/trace-viewer/src/ui/views/shared/Ruler.tsx`
- Create: `packages/trace-viewer/src/ui/views/shared/LevelControl.tsx`
- Create: `packages/trace-viewer/src/ui/views/shared/NewBadge.tsx`
- Create: `packages/trace-viewer/src/ui/views/shared/shared.module.css`
- Test: `packages/trace-viewer/src/ui/views/shared/shared.test.tsx`

**Interfaces:**
- Consumes: C1b `computeTicks(map: XMap, scale: TimeScale, range: { x0; x1 }): { ticks: Tick[]; breaks: BreakMark[] }`, `buildTimeScale`, `XMap`, `TimeScale`, `LEVELS`, `Level`, `FocusBy`, `useView`, `useDispatch`, action `level/set`; B `formatOffset`; C2-3 `useAnnounce`.
- Produces (C3b reuses all three):

```ts
// ui/views/shared/Ruler.tsx
export interface RulerProps { map: XMap; scale: TimeScale; widthPx: number; loadedThroughT: number | null; className?: string }
export function Ruler(props: RulerProps): React.JSX.Element;
/** "12s", "4m", "1h 02m" for break glyphs ("⫽ 4m idle"). */
export function idleLabel(ms: number): string;
// ui/views/shared/LevelControl.tsx
export const LEVEL_LABEL: Record<Level, string>;   // Session, Chapter, Step
export function LevelControl(props: { by: FocusBy }): React.JSX.Element;
// ui/views/shared/NewBadge.tsx
export interface NewBadgeProps { count: number; problems: number; afterRange: boolean; onActivate(): void }
export function NewBadge(props: NewBadgeProps): React.JSX.Element | null;
```

The ruler draws labeled ticks only (the view paints tick lines), each label `formatOffset(tMs)`, the break glyph "⫽ 4m idle", and a hatch past `loadedThroughT`. `LevelControl` is a radiogroup whose radios stay out of the tab order (`Alt+1/2/3` is the keyboard path, so `main` keeps one tab stop). `NewBadge` reads "↓ N new" or "↓ N new after range", shows a red dot only for new critical findings, and announces "N new steps[, k problems]" at most once per 10 s.

- [ ] **Step 1: Write the failing test**

Create `packages/trace-viewer/src/ui/views/shared/shared.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildTimeScale, type XMap } from "../../../layout/time-scale.js";
import { foldFixture, renderHarness, stubLayout, type LayoutStub } from "../../../test-support/ui-harness.js";
import { LevelControl } from "./LevelControl.js";
import { NewBadge } from "./NewBadge.js";
import { idleLabel, Ruler } from "./Ruler.js";

let layout: LayoutStub;
beforeEach(() => {
  layout = stubLayout();
});
afterEach(() => {
  cleanup();
  layout.restore();
  vi.useRealTimers();
});

describe("Ruler", () => {
  it("labels ticks at least 64 px apart with real offsets and hatches past the loaded seq", () => {
    const scale = buildTimeScale({ originMs: 0, work: [[0, 45_000]], awaitingFrom: [] });
    const map: XMap = { xOf: (t) => t / 100, tOf: (x) => x * 100 };
    renderHarness(<Ruler map={map} scale={scale} widthPx={450} loadedThroughT={30_000} />, null);
    const labels = Array.from(screen.getByTestId("ruler").querySelectorAll("[data-tick]")).map((node) => node.textContent);
    expect(labels).toEqual(["+0:00", "+0:10", "+0:20", "+0:30", "+0:40"]);
    const hatch = screen.getByTestId("ruler-hatch");
    expect(hatch.style.left).toBe("300px");
    expect(hatch.style.width).toBe("150px");
  });

  it("formats idle breaks", () => {
    expect(idleLabel(12_000)).toBe("12s");
    expect(idleLabel(4 * 60_000 + 5_000)).toBe("4m");
    expect(idleLabel(62 * 60_000)).toBe("1h 02m");
  });
});

describe("LevelControl", () => {
  it("is a radiogroup that writes the shared level", () => {
    const h = renderHarness(<LevelControl by="hybrid" />, foldFixture("oauth"));
    const group = screen.getByRole("radiogroup", { name: "Level" });
    expect(group.querySelectorAll('[role="radio"]')).toHaveLength(3);
    fireEvent.click(screen.getByRole("radio", { name: "Session" }));
    expect(h.store.get().level).toBe("session");
    expect(screen.getByRole("radio", { name: "Session" }).getAttribute("aria-checked")).toBe("true");
    expect(group.querySelectorAll('[tabindex="0"]')).toHaveLength(0);
  });
});

describe("NewBadge", () => {
  it("announces through the live region at most once per 10 s", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T10:00:00.000Z"));
    const onActivate = vi.fn();
    const h = renderHarness(<NewBadge count={3} problems={0} afterRange={false} onActivate={onActivate} />, null);
    h.result.rerender(h.wrap(<NewBadge count={5} problems={0} afterRange={false} onActivate={onActivate} />));
    expect(h.announcements).toEqual(["3 new steps"]);
    vi.setSystemTime(new Date("2026-09-28T10:00:11.000Z"));
    h.result.rerender(h.wrap(<NewBadge count={6} problems={1} afterRange={false} onActivate={onActivate} />));
    expect(h.announcements).toEqual(["3 new steps", "6 new steps, 1 problem"]);
    expect(screen.getByRole("button", { name: /↓ 6 new/ })).toBeTruthy();
    expect(screen.getByTestId("new-badge-dot")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /↓ 6 new/ }));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("reads after range and renders nothing at zero", () => {
    const h = renderHarness(<NewBadge count={2} problems={0} afterRange onActivate={() => undefined} />, null);
    expect(screen.getByRole("button").textContent).toBe("↓ 2 new after range");
    expect(screen.queryByTestId("new-badge-dot")).toBeNull();
    h.result.rerender(h.wrap(<NewBadge count={0} problems={0} afterRange={false} onActivate={() => undefined} />));
    expect(screen.queryByRole("button")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/shared/shared.test.tsx`
Expected: FAIL with `Failed to resolve import "./LevelControl.js"`.

- [ ] **Step 3: Implement the three parts and their CSS**

Create `packages/trace-viewer/src/ui/views/shared/shared.module.css`:

```css
.ruler {
  position: absolute;
  left: 0;
  right: 0;
  height: 16px;
  pointer-events: none;
}

.tick {
  position: absolute;
  top: 0;
  left: 0;
  padding-left: 3px;
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-ink-3);
  white-space: nowrap;
  box-shadow: inset 1px 0 0 var(--tv-hair);
}

.break {
  position: absolute;
  top: 0;
  overflow: hidden;
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-ink-3);
  text-align: center;
  white-space: nowrap;
}

.hatch {
  position: absolute;
  top: 0;
  height: 22px;
  background: repeating-linear-gradient(135deg, var(--tv-fill-2) 0 2px, transparent 2px 6px);
}

.segmented {
  display: flex;
  padding: 2px;
  border-radius: 8px;
  background: var(--tv-fill);
}

.segment {
  padding: 3px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--tv-ink-2);
  font: inherit;
  font-size: 12px;
  line-height: 16px;
  cursor: pointer;
}

.segment[aria-checked="true"] {
  background: var(--tv-panel);
  color: var(--tv-ink);
  box-shadow: var(--tv-shadow);
}

.segment:focus-visible {
  outline: 2px solid var(--tv-accent);
  outline-offset: 1px;
}

.newBadge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border: 0;
  border-radius: 999px;
  background: var(--tv-panel);
  color: var(--tv-accent-ink);
  box-shadow: var(--tv-shadow);
  font: inherit;
  font-size: 12px;
  line-height: 16px;
  cursor: pointer;
}

.badDot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--tv-bad);
}
```

Create `packages/trace-viewer/src/ui/views/shared/Ruler.tsx`:

```tsx
import { useMemo } from "react";

import { computeTicks } from "../../../layout/ticks.js";
import type { TimeScale, XMap } from "../../../layout/time-scale.js";
import { formatOffset } from "../../../model/index.js";
import styles from "./shared.module.css";

export interface RulerProps {
  map: XMap;
  scale: TimeScale;
  widthPx: number;
  /** Display time of loadedThroughSeq while loading; null once loaded. */
  loadedThroughT: number | null;
  className?: string;
}

export function idleLabel(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
  if (minutes >= 1) return `${minutes}m`;
  return `${Math.round(ms / 1_000)}s`;
}

/** One ruler for any XMap (spec §7.4): labels ≥ 64 px apart, none inside breaks, real offsets. */
export function Ruler({ map, scale, widthPx, loadedThroughT, className }: RulerProps) {
  const { ticks, breaks } = useMemo(() => computeTicks(map, scale, { x0: 0, x1: widthPx }), [map, scale, widthPx]);
  const hatchX = loadedThroughT === null ? null : Math.max(0, Math.min(widthPx, map.xOf(loadedThroughT)));
  return (
    <div className={`${styles.ruler} ${className ?? ""}`} aria-hidden="true" data-testid="ruler">
      {ticks
        .filter((tick) => tick.labeled)
        .map((tick) => (
          <span
            key={tick.tMs}
            data-tick=""
            className={styles.tick}
            style={{ transform: `translateX(${Math.round(tick.x)}px)` }}
          >
            {formatOffset(tick.tMs)}
          </span>
        ))}
      {breaks.map((mark) => (
        <span
          key={`break:${mark.x0}`}
          className={styles.break}
          style={{ left: mark.x0, width: Math.max(0, mark.x1 - mark.x0) }}
        >
          {`⫽ ${idleLabel(mark.ms)} idle`}
        </span>
      ))}
      {hatchX !== null && hatchX < widthPx ? (
        <span className={styles.hatch} data-testid="ruler-hatch" style={{ left: hatchX, width: widthPx - hatchX }} />
      ) : null}
    </div>
  );
}
```

Create `packages/trace-viewer/src/ui/views/shared/LevelControl.tsx`:

```tsx
import type { KeyboardEvent } from "react";

import { LEVELS, type Level } from "../../../model/index.js";
import { useDispatch, useView } from "../../state/store.js";
import type { FocusBy } from "../../state/view-state.js";
import styles from "./shared.module.css";

export const LEVEL_LABEL: Record<Level, string> = { session: "Session", chapter: "Chapter", step: "Step" };

export function LevelControl({ by }: { by: FocusBy }) {
  const level = useView((state) => state.level);
  const dispatch = useDispatch();
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const position = LEVELS.indexOf(level);
    const next = LEVELS[Math.max(0, Math.min(LEVELS.length - 1, position + (event.key === "ArrowRight" ? 1 : -1)))];
    if (next !== undefined) dispatch({ type: "level/set", level: next, by });
  };
  return (
    <div role="radiogroup" aria-label="Level" className={styles.segmented} onKeyDown={onKeyDown}>
      {LEVELS.map((item) => (
        <button
          key={item}
          type="button"
          role="radio"
          aria-checked={item === level}
          tabIndex={-1}
          className={styles.segment}
          onClick={() => dispatch({ type: "level/set", level: item, by })}
        >
          {LEVEL_LABEL[item]}
        </button>
      ))}
    </div>
  );
}
```

Create `packages/trace-viewer/src/ui/views/shared/NewBadge.tsx`:

```tsx
import { useEffect } from "react";

import { useAnnounce } from "../../shell/LiveRegion.js";
import styles from "./shared.module.css";

export interface NewBadgeProps {
  count: number;
  /** New critical findings among the new steps. */
  problems: number;
  /** The brush does not follow live: "N new after range". */
  afterRange: boolean;
  onActivate(): void;
}

export function NewBadge({ count, problems, afterRange, onActivate }: NewBadgeProps) {
  const announce = useAnnounce();
  useEffect(() => {
    if (count <= 0) return;
    const steps = `${count} new ${count === 1 ? "step" : "steps"}`;
    const extra = problems > 0 ? `, ${problems} ${problems === 1 ? "problem" : "problems"}` : "";
    announce(`${steps}${extra}`, { key: "new-steps", minIntervalMs: 10_000 });
  }, [count, problems, announce]);
  if (count <= 0) return null;
  return (
    <button type="button" className={styles.newBadge} onClick={onActivate}>
      {`↓ ${count} new${afterRange ? " after range" : ""}`}
      {problems > 0 ? <span className={styles.badDot} role="img" aria-label="includes a critical finding" data-testid="new-badge-dot" /> : null}
    </button>
  );
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/shared/shared.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Root checks**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/trace-viewer/src/ui/views/shared/Ruler.tsx packages/trace-viewer/src/ui/views/shared/LevelControl.tsx \
  packages/trace-viewer/src/ui/views/shared/NewBadge.tsx packages/trace-viewer/src/ui/views/shared/shared.module.css \
  packages/trace-viewer/src/ui/views/shared/shared.test.tsx
git commit -m "feat(trace-viewer): add the shared ruler, level control and new badge"
```

---

### Task C2-10: Overview painter (`paint.ts`) and DPR canvas surface

**Files:**
- Create: `packages/trace-viewer/src/ui/views/hybrid/overview/paint.ts`
- Create: `packages/trace-viewer/src/ui/views/hybrid/overview/OverviewCanvas.tsx`
- Create: `packages/trace-viewer/src/test-support/recording-context.ts`
- Test: `packages/trace-viewer/src/ui/views/hybrid/overview/paint.test.ts`

**Interfaces:**
- Consumes: C1b `OverviewLayout { marks: MarkOp[]; pins: PinPlacement[]; bands: BandPlacement[]; turnLines; links; strip: Float64Array }`, `MarkOp` (dot, ring, bar, heat, hist, wait, noise, problem), `OVERVIEW_H = 288`, `RULER_TOP = 36`, `LANES_TOP = 58`, `LANE_H = 28`, `STRIP_H = 6`, `K_MAX`, `layoutOverview`, `buildOverviewIndex`, `Tick { tMs; x; labeled }`, `Tone`, `fitRange`, `buildTraceIndex`, `buildTimeScale`, `timeScaleInputOf`; C1b test-only `oauthLikeSession(): TraceSession`; C1a `LIGHT_TOKENS`, `Tokens`; W0 `LANES`, `Lane`.
- Produces:

```ts
// ui/views/hybrid/overview/paint.ts
export interface PaintContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  fill(): void;
  stroke(): void;
}
export const LANES_BOTTOM: number;   // 226
export const STRIP_TOP: number;      // 52
export function laneTop(lane: Lane): number;
export function laneCenter(lane: Lane): number;
export interface StripOverlay { brush: { x0: number; x1: number } | null; playheadX: number | null; viewport: { x0: number; x1: number } | null }
export interface PaintInput {
  layout: OverviewLayout; ticks: readonly Tick[]; widthPx: number; dpr: number; tokens: Tokens;
  emphasizedBands: ReadonlySet<string>; strip: StripOverlay; paintPins: boolean;
}
export function paintOverview(ctx: PaintContext, input: PaintInput): void;
// ui/views/hybrid/overview/OverviewCanvas.tsx
export interface CanvasSurface { ctx: PaintContext; dpr: number; widthPx: number; heightPx: number }
export interface OverviewCanvasProps {
  widthPx: number; heightPx: number; className?: string;
  onSurface(surface: CanvasSurface | null): void;
  createContext?(canvas: HTMLCanvasElement): PaintContext | null;
}
export function OverviewCanvas(props: OverviewCanvasProps): React.JSX.Element;
// test-support/recording-context.ts (test-only)
export interface PaintOp { op: string; args: readonly number[]; fillStyle: string; strokeStyle: string; lineWidth: number }
export class RecordingContext implements PaintContext { readonly ops: PaintOp[]; fillRects(color: string): PaintOp[]; filledArcs(color: string): PaintOp[] }
```

Paint order (bottom to top): bands (`fill`, `fill-2` when emphasized) from their label tier to the lane bottom; lane center hairlines; turn hairlines and tick lines (`ink-4`, decoration); the 6 px session strip (density in `mark`, brush in `accent-soft`, viewport outline in `ink-4`, playhead 1 px `accent`); marks; every `problem` op last as a 2 × 10 px `bad` rect at its exact x, so no heat bar or cluster can cover it. The canvas carries no text and no icons (DOM does), except pins when the spike risk 5 ruling sets `paintPins`.

- [ ] **Step 1: Write the recording context (test-only)**

Create `packages/trace-viewer/src/test-support/recording-context.ts`:

```ts
// Test-only: records every paint call with the style in effect. Excluded from the build.
import type { PaintContext } from "../ui/views/hybrid/overview/paint.js";

export interface PaintOp {
  op: string;
  args: readonly number[];
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
}

export class RecordingContext implements PaintContext {
  fillStyle: string | CanvasGradient | CanvasPattern = "#000000";
  strokeStyle: string | CanvasGradient | CanvasPattern = "#000000";
  lineWidth = 1;
  readonly ops: PaintOp[] = [];

  private record(op: string, args: readonly number[]): void {
    this.ops.push({ op, args, fillStyle: String(this.fillStyle), strokeStyle: String(this.strokeStyle), lineWidth: this.lineWidth });
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.record("setTransform", [a, b, c, d, e, f]);
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    this.record("clearRect", [x, y, w, h]);
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.record("fillRect", [x, y, w, h]);
  }

  strokeRect(x: number, y: number, w: number, h: number): void {
    this.record("strokeRect", [x, y, w, h]);
  }

  beginPath(): void {
    this.record("beginPath", []);
  }

  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void {
    this.record("arc", [x, y, radius, startAngle, endAngle]);
  }

  fill(): void {
    this.record("fill", []);
  }

  stroke(): void {
    this.record("stroke", []);
  }

  fillRects(color: string): PaintOp[] {
    return this.ops.filter((op) => op.op === "fillRect" && op.fillStyle === color);
  }

  /** The arc that precedes each fill() painted with `color`. */
  filledArcs(color: string): PaintOp[] {
    const out: PaintOp[] = [];
    this.ops.forEach((op, position) => {
      if (op.op !== "fill" || op.fillStyle !== color) return;
      const arc = this.ops[position - 1];
      if (arc?.op === "arc") out.push(arc);
    });
    return out;
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/trace-viewer/src/ui/views/hybrid/overview/paint.test.ts`:

```ts
// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildOverviewIndex } from "../../../../layout/overview-index.js";
import { K_MAX, layoutOverview, type OverviewLayout } from "../../../../layout/overview-layout.js";
import { buildTimeScale, timeScaleInputOf } from "../../../../layout/time-scale.js";
import { buildTraceIndex } from "../../../../layout/trace-index.js";
import { fitRange } from "../../../../layout/viewport.js";
import { RecordingContext } from "../../../../test-support/recording-context.js";
import { oauthLikeSession } from "../../../../test-support/session-builder.js";
import { LIGHT_TOKENS } from "../../../tokens/tokens.js";
import { OverviewCanvas } from "./OverviewCanvas.js";
import { laneCenter, paintOverview, STRIP_TOP, type PaintInput } from "./paint.js";

afterEach(() => {
  cleanup();
});

function input(layout: OverviewLayout, overrides: Partial<PaintInput> = {}): PaintInput {
  return {
    layout,
    ticks: [],
    widthPx: 600,
    dpr: 2,
    tokens: LIGHT_TOKENS,
    emphasizedBands: new Set(),
    strip: { brush: null, playheadX: null, viewport: null },
    paintPins: false,
    ...overrides,
  };
}

function emptyLayout(marks: OverviewLayout["marks"]): OverviewLayout {
  return { marks, pins: [], bands: [], turnLines: [], links: [], strip: new Float64Array(600) };
}

describe("paintOverview", () => {
  it("scales by DPR, paints heat in the mark token and problems last in red", () => {
    const ctx = new RecordingContext();
    paintOverview(
      ctx,
      input(
        emptyLayout([
          { op: "problem", lane: "tests", x: 100 },
          { op: "heat", lane: "tests", x: 100, count: 12, h: 8 },
          { op: "dot", lane: "agent", x: 40, tone: "neutral" },
          { op: "dot", lane: "tests", x: 60, tone: "bad" },
        ]),
      ),
    );
    expect(ctx.ops[0]).toMatchObject({ op: "setTransform", args: [2, 0, 0, 2, 0, 0] });
    const heat = ctx.ops.findIndex((op) => op.op === "fillRect" && op.fillStyle === LIGHT_TOKENS.mark && op.args[3] === 8);
    const problem = ctx.ops.findIndex(
      (op) => op.op === "fillRect" && op.fillStyle === LIGHT_TOKENS.bad && op.args[2] === 2 && op.args[3] === 10,
    );
    expect(heat).toBeGreaterThanOrEqual(0);
    expect(problem).toBeGreaterThan(heat);
    expect(ctx.ops[problem]?.args).toEqual([99, laneCenter("tests") - 5, 2, 10]);
    expect(ctx.filledArcs(LIGHT_TOKENS.bad).map((arc) => arc.args[0])).toEqual([60]);
    expect(ctx.filledArcs(LIGHT_TOKENS.mark).map((arc) => arc.args[0])).toEqual([40]);
    expect(ctx.ops.some((op) => op.op === "fillRect" && op.fillStyle === LIGHT_TOKENS.ink4 && op.args[3] === 8)).toBe(false);
  });

  it("keeps every problem tick of a real Session-level layout", () => {
    const session = oauthLikeSession();
    const index = buildTraceIndex(session);
    const scale = buildTimeScale(timeScaleInputOf(session));
    const overview = buildOverviewIndex(session, index, scale);
    const camera = fitRange(0, scale.endU, 600, { padFraction: 0.04, limits: { minK: 1e-6, maxK: K_MAX } });
    const layout = layoutOverview({ overview, camera, widthPx: 600, level: "session" });
    const problems = layout.marks.filter((mark) => mark.op === "problem");
    expect(problems.length).toBeGreaterThan(0);
    const ctx = new RecordingContext();
    paintOverview(ctx, input(layout));
    const ticks = ctx.fillRects(LIGHT_TOKENS.bad).filter((op) => op.args[2] === 2 && op.args[3] === 10);
    expect(ticks).toHaveLength(problems.length);
  });

  it("paints the strip overlays and, under the risk 5 ruling, the pins", () => {
    const layout: OverviewLayout = {
      ...emptyLayout([]),
      pins: [
        { key: "p1", lane: "tests", x: 200, kind: "failed", critical: true, stepIndexes: [3], cluster: false, findingId: null },
        { key: "p2", lane: "agent", x: 260, kind: "instruction", critical: false, stepIndexes: [0], cluster: false, findingId: null },
      ],
    };
    const ctx = new RecordingContext();
    paintOverview(ctx, input(layout, { strip: { brush: { x0: 100, x1: 300 }, playheadX: 250, viewport: null }, paintPins: true }));
    expect(ctx.fillRects(LIGHT_TOKENS.accentSoft).some((op) => op.args[0] === 100 && op.args[1] === STRIP_TOP)).toBe(true);
    expect(ctx.fillRects(LIGHT_TOKENS.accent).some((op) => op.args[0] === 250 && op.args[2] === 1)).toBe(true);
    expect(ctx.ops.filter((op) => op.op === "arc" && op.args[2] === 11)).toHaveLength(2);
  });
});

describe("OverviewCanvas", () => {
  it("sizes the backing store at width × DPR, hides itself from assistive tech and hands out the context", () => {
    const original = window.devicePixelRatio;
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
    const recording = new RecordingContext();
    const onSurface = vi.fn();
    const { container } = render(
      createElement(OverviewCanvas, { widthPx: 600, heightPx: 288, onSurface, createContext: () => recording }),
    );
    const canvas = container.querySelector("canvas");
    expect(canvas?.getAttribute("aria-hidden")).toBe("true");
    expect(canvas?.getAttribute("width")).toBe("1200");
    expect(canvas?.getAttribute("height")).toBe("576");
    expect(onSurface).toHaveBeenLastCalledWith({ ctx: recording, dpr: 2, widthPx: 600, heightPx: 288 });
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: original });
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/hybrid/overview/paint.test.ts`
Expected: FAIL with `Failed to resolve import "./paint.js"`.

- [ ] **Step 4: Implement the painter and the canvas surface**

Create `packages/trace-viewer/src/ui/views/hybrid/overview/paint.ts`:

```ts
import {
  LANE_H,
  LANES_TOP,
  OVERVIEW_H,
  RULER_TOP,
  STRIP_H,
  type MarkOp,
  type OverviewLayout,
  type PinPlacement,
} from "../../../../layout/overview-layout.js";
import type { Tick } from "../../../../layout/ticks.js";
import type { Tone } from "../../../../layout/tone.js";
import { LANES, type Lane } from "../../../../model/index.js";
import type { Tokens } from "../../../tokens/tokens.js";

/** The subset of CanvasRenderingContext2D the painter uses; a recording context implements it in tests. */
export interface PaintContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  fill(): void;
  stroke(): void;
}

export const LANES_BOTTOM = LANES_TOP + LANES.length * LANE_H;
export const STRIP_TOP = LANES_TOP - STRIP_H;
const TIER_H = 18;
const FULL_TURN = Math.PI * 2;

export function laneTop(lane: Lane): number {
  return LANES_TOP + LANES.indexOf(lane) * LANE_H;
}

export function laneCenter(lane: Lane): number {
  return laneTop(lane) + LANE_H / 2;
}

export interface StripOverlay {
  brush: { x0: number; x1: number } | null;
  playheadX: number | null;
  viewport: { x0: number; x1: number } | null;
}

export interface PaintInput {
  layout: OverviewLayout;
  ticks: readonly Tick[];
  /** Lane area width in CSS px (the gutter is DOM). */
  widthPx: number;
  dpr: number;
  tokens: Tokens;
  /** Band keys drawn with fill-2 (hovered or selected). */
  emphasizedBands: ReadonlySet<string>;
  strip: StripOverlay;
  /** Spike risk 5 ruling: pins painted here; DOM buttons stay as focus targets. */
  paintPins: boolean;
}

function toneColor(tone: Tone, tokens: Tokens): string {
  if (tone === "bad") return tokens.bad;
  if (tone === "good") return tokens.good;
  return tokens.mark;
}

function dot(ctx: PaintContext, x: number, y: number, radius: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, FULL_TURN);
  ctx.fill();
}

function paintMark(ctx: PaintContext, mark: MarkOp, tokens: Tokens): void {
  const y = laneCenter(mark.lane);
  switch (mark.op) {
    case "dot":
      dot(ctx, mark.x, y, 3, toneColor(mark.tone, tokens));
      return;
    case "ring":
      ctx.strokeStyle = tokens.mark;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(mark.x, y, 3, 0, FULL_TURN);
      ctx.stroke();
      return;
    case "bar":
      ctx.fillStyle = toneColor(mark.tone, tokens);
      ctx.fillRect(mark.x0, y - 2, Math.max(1, mark.x1 - mark.x0), 4);
      if (mark.endTone !== undefined) dot(ctx, mark.x1, y, 2.5, toneColor(mark.endTone, tokens));
      return;
    case "heat":
      ctx.fillStyle = tokens.mark;
      ctx.fillRect(mark.x - 2, y + 4 - mark.h, 4, mark.h);
      return;
    case "hist":
      if (mark.upPx > 0) {
        ctx.fillStyle = tokens.ink2;
        ctx.fillRect(mark.x - 1.5, y - mark.upPx, 3, mark.upPx);
      }
      if (mark.downPx > 0) {
        ctx.strokeStyle = tokens.ink3;
        ctx.lineWidth = 1;
        ctx.strokeRect(mark.x - 1, y + 0.5, 2, Math.max(0.5, mark.downPx - 0.5));
      }
      return;
    case "wait":
      ctx.strokeStyle = tokens.mark;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(mark.x0, y - 3, Math.max(1, mark.x1 - mark.x0), 6);
      return;
    case "noise":
      ctx.strokeStyle = tokens.ink4;
      ctx.lineWidth = 1;
      ctx.strokeRect(mark.x0, y - 1, Math.max(1, mark.x1 - mark.x0), 2);
      return;
    case "problem":
      return;
  }
}

function paintStrip(ctx: PaintContext, input: PaintInput): void {
  const { layout, tokens, widthPx, strip } = input;
  ctx.fillStyle = tokens.fill;
  ctx.fillRect(0, STRIP_TOP, widthPx, STRIP_H);
  if (strip.brush !== null) {
    ctx.fillStyle = tokens.accentSoft;
    ctx.fillRect(strip.brush.x0, STRIP_TOP, Math.max(1, strip.brush.x1 - strip.brush.x0), STRIP_H);
  }
  let max = 0;
  for (const value of layout.strip) max = Math.max(max, value);
  if (max > 0) {
    ctx.fillStyle = tokens.mark;
    const bins = Math.min(layout.strip.length, Math.ceil(widthPx));
    for (let x = 0; x < bins; x += 1) {
      const value = layout.strip[x] ?? 0;
      if (value <= 0) continue;
      const h = Math.max(1, Math.round((value / max) * STRIP_H));
      ctx.fillRect(x, STRIP_TOP + STRIP_H - h, 1, h);
    }
  }
  if (strip.viewport !== null) {
    ctx.strokeStyle = tokens.ink4;
    ctx.lineWidth = 1;
    ctx.strokeRect(strip.viewport.x0 + 0.5, STRIP_TOP + 0.5, Math.max(1, strip.viewport.x1 - strip.viewport.x0 - 1), STRIP_H - 1);
  }
  if (strip.playheadX !== null) {
    ctx.fillStyle = tokens.accent;
    ctx.fillRect(Math.round(strip.playheadX), STRIP_TOP, 1, STRIP_H);
  }
}

function paintPins(ctx: PaintContext, pins: readonly PinPlacement[], tokens: Tokens): void {
  for (const pin of pins) {
    ctx.fillStyle = pin.critical ? tokens.bad : tokens.panel;
    ctx.strokeStyle = pin.critical ? tokens.bad : tokens.hair;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(pin.x, laneCenter(pin.lane), 11, 0, FULL_TURN);
    ctx.fill();
    ctx.stroke();
  }
}

/** Pure painter over a PaintContext (spec §7.3 Hybrid overview). Text and icons stay in the DOM. */
export function paintOverview(ctx: PaintContext, input: PaintInput): void {
  const { layout, tokens, widthPx, dpr } = input;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, widthPx, OVERVIEW_H);

  for (const band of layout.bands) {
    ctx.fillStyle = input.emphasizedBands.has(band.key) ? tokens.fill2 : tokens.fill;
    const top = band.tier === 1 ? TIER_H : 0;
    ctx.fillRect(band.x0, top, Math.max(1, band.x1 - band.x0), LANES_BOTTOM - top);
  }

  ctx.fillStyle = tokens.hair;
  for (const lane of LANES) ctx.fillRect(0, Math.round(laneCenter(lane)), widthPx, 1);

  ctx.fillStyle = tokens.ink4;
  for (const line of layout.turnLines) ctx.fillRect(Math.round(line.x), RULER_TOP, 1, LANES_BOTTOM - RULER_TOP);
  for (const tick of input.ticks) {
    const h = tick.labeled ? 6 : 3;
    ctx.fillRect(Math.round(tick.x), STRIP_TOP - h, 1, h);
  }

  paintStrip(ctx, input);

  const problems: Array<Extract<MarkOp, { op: "problem" }>> = [];
  for (const mark of layout.marks) {
    if (mark.op === "problem") problems.push(mark);
    else paintMark(ctx, mark, tokens);
  }
  ctx.fillStyle = tokens.bad;
  for (const mark of problems) ctx.fillRect(mark.x - 1, laneCenter(mark.lane) - 5, 2, 10);

  if (input.paintPins) paintPins(ctx, layout.pins, tokens);
}
```

Create `packages/trace-viewer/src/ui/views/hybrid/overview/OverviewCanvas.tsx`:

```tsx
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { PaintContext } from "./paint.js";

export interface CanvasSurface {
  ctx: PaintContext;
  dpr: number;
  widthPx: number;
  heightPx: number;
}

export interface OverviewCanvasProps {
  widthPx: number;
  heightPx: number;
  className?: string;
  onSurface(surface: CanvasSurface | null): void;
  /** Test seam: jsdom has no 2D context. */
  createContext?(canvas: HTMLCanvasElement): PaintContext | null;
}

function currentDpr(): number {
  return typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
}

/** One DPR-scaled, aria-hidden canvas; a DPR change (window dragged between displays) re-creates the surface. */
export function OverviewCanvas({ widthPx, heightPx, className, onSurface, createContext }: OverviewCanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [dpr, setDpr] = useState(currentDpr);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = (): void => setDpr(currentDpr());
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [dpr]);

  useLayoutEffect(() => {
    const canvas = ref.current;
    if (canvas === null || widthPx <= 0) {
      onSurface(null);
      return undefined;
    }
    const ctx = createContext !== undefined ? createContext(canvas) : (canvas.getContext("2d") as PaintContext | null);
    onSurface(ctx === null ? null : { ctx, dpr, widthPx, heightPx });
    return () => onSurface(null);
  }, [widthPx, heightPx, dpr, createContext, onSurface]);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className={className}
      width={Math.max(0, Math.round(widthPx * dpr))}
      height={Math.round(heightPx * dpr)}
      style={{ width: widthPx, height: heightPx }}
    />
  );
}
```

- [ ] **Step 5: Run the test to see it pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/hybrid/overview/paint.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Root checks**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/trace-viewer/src/ui/views/hybrid/overview/paint.ts packages/trace-viewer/src/ui/views/hybrid/overview/OverviewCanvas.tsx \
  packages/trace-viewer/src/ui/views/hybrid/overview/paint.test.ts packages/trace-viewer/src/test-support/recording-context.ts
git commit -m "feat(trace-viewer): add the overview painter and DPR canvas surface"
```

---
### Task C2-11: Overview DOM: pins, brush and playhead sliders, pointer and keyboard interactions

**Files:**
- Create: `packages/trace-viewer/src/ui/views/hybrid/overview/Brush.tsx`
- Create: `packages/trace-viewer/src/ui/views/hybrid/overview/Pins.tsx`
- Create: `packages/trace-viewer/src/ui/views/hybrid/overview/Overview.tsx`
- Create: `packages/trace-viewer/src/ui/views/hybrid/overview/Overview.module.css`
- Test: `packages/trace-viewer/src/ui/views/hybrid/overview/overview.test.tsx`

**Interfaces:**
- Consumes:
  - C1b `layout/overview-index.ts`: `buildOverviewIndex(session, index, scale): OverviewIndex`, `PinKind`; `layout/overview-layout.ts`: `layoutOverview(input: { overview; camera: XOnlyCamera; widthPx; level }): OverviewLayout`, `overviewPreset(input: OverviewPresetInput): { camera: XOnlyCamera; brush: Brush }`, `PinPlacement`, `BandPlacement`, `OVERVIEW_H`, `RULER_TOP`, `LANES_TOP`, `LANE_H`, `GUTTER_W` (112), `GUTTER_W_NARROW` (40), `NARROW_CONTAINER_PX` (1180), `PIN_PX` (22), `K_MAX` (0.4), `MAX_OVERLAY_NODES` (150); `layout/viewport.ts`: `XOnlyCamera`, `ZoomLimits`, `uToScreenX`, `screenXToU`, `fitRange`; `layout/time-scale.ts`: `xOnlyXMap(scale, camera): XMap`, `TimeScale`; `layout/ticks.ts` `computeTicks`; `layout/trace-index.ts`: `brushSeqRange(brush, index)`, `Brush`, `TraceIndex` (`stepIndexAtOrBefore`, `stepIndexAtOrAfter`, `chapterKey`), `SelectionId`.
  - C1b `ui/viewport/controller.ts`: `createViewportController<C>(options): ViewportController<C>` (`get`, `set(camera, {animate})`, `zoomBy`, `panBy`, `isGesturing`, `destroy`), options `element`, `initial`, `limits()`, `viewport()`, `content()`, `onFrame(camera, phase)`, `onGestureStart?(kind)`, `onGestureEnd?(camera)`, `isHandTool()`, `reducedMotion()`.
  - C1b store: `useView`, `useDispatch`, `useViewStore`, `selectEffectivePlayheadSeq`, `Gesture`, `PlayheadOrigin`, `Tool`; actions `playhead/set`, `playhead/step`, `brush/set`, `select`, `gesture`, `follow/set`, `tool/set`, `level/set`.
  - C1a `Icon`, `LANE_ICON`, `LANE_LABEL`, `KIND_ICON`, `SIGNAL_ICON`, `CATEGORY_ICON`, `LIGHT_TOKENS`; B `formatOffset`, `LANES`; C2-3 `useSessionView`, `PERF`; C2-6 `selectionTitle`; C2-9 `Ruler`, `LevelControl`; C2-10 `OverviewCanvas`, `paintOverview`, `laneTop`, `laneCenter`, `PaintContext`, `CanvasSurface`.
- Produces:

```ts
// ui/views/hybrid/overview/Brush.tsx
export function stepX(session: TraceSession, scale: TimeScale, camera: XOnlyCamera, stepIndex: number): number;
export function stepIndexAtX(session: TraceSession, scale: TimeScale, camera: XOnlyCamera, x: number, mode?: "nearest" | "after"): number;
export interface BrushProps {
  session: TraceSession; index: TraceIndex; scale: TimeScale; camera: XOnlyCamera; level: Level;
  brush: BrushState; playheadSeq: number; pins: readonly PinPlacement[]; bands: readonly BandPlacement[]; tool: Tool;
  onPlayhead(seq: number): void; onStep(dir: 1 | -1): void; onBrush(brush: BrushState): void; onGesture(gesture: Gesture): void;
}
export function Brush(props: BrushProps): React.JSX.Element;
// ui/views/hybrid/overview/Pins.tsx
export const PINS_PAINTED_ON_CANVAS: boolean;   // false; C2-0's risk 5 ruling sets true
export function pinIcon(pin: PinPlacement, session: TraceSession): IconName;
export function pinLabel(pin: PinPlacement, session: TraceSession, index: TraceIndex): string;
export interface PinsProps { pins: readonly PinPlacement[]; session: TraceSession; index: TraceIndex; selection: SelectionId | null; onSelect(stepIndex: number): void; onZoomTo(stepIndexes: readonly number[]): void }
export function Pins(props: PinsProps): React.JSX.Element;
// ui/views/hybrid/overview/Overview.tsx
export interface OverviewApi {
  controller(): ViewportController<XOnlyCamera> | null;
  camera(): XOnlyCamera | null;
  widthPx(): number;
  overview(): OverviewIndex | null;
  limits(): ZoomLimits;
  /** Programmatic move (never writes the brush); animate uses TWEEN_MS, 0 under reduced motion. */
  moveTo(camera: XOnlyCamera, animate: boolean): void;
}
export interface OverviewProps {
  active: boolean;
  apiRef: { current: OverviewApi | null };
  spineWindow: { t0: number; t1: number } | null;
  onSettle(camera: XOnlyCamera): void;
  createContext?(canvas: HTMLCanvasElement): PaintContext | null;
}
export function Overview(props: OverviewProps): React.JSX.Element;
export function overviewLimits(endU: number, widthPx: number): ZoomLimits;   // minK = 0.9 × fit k, maxK = max(K_MAX, fit k)
export function zoomPercent(camera: XOnlyCamera, presetK: number): string;
```

Interactions (spec §7.6.2): a pointer moving less than 4 px is a click; a click on the empty track moves the playhead (`free`, origin `overview`) and leaves the selection; a drag on the track draws a `range` brush snapped to bands at Session level (Alt disables snapping); dragging the brush body or an edge moves or resizes it; dragging the playhead handle scrubs; double-clicking a band label brushes that chapter at the Chapter preset. On the focused playhead slider `←`/`→` move one step, with `Alt` one pin, with `Shift` one band start. `{`, `}` and `b` come from the keyboard layer (C2-8). A camera gesture (wheel, pinch, hand drag) switches Live to Review and holds data applies until it settles (`gesture` in the store). Pure pans move the DOM overlay with one `translateX`; zooms and data changes re-render the at most 150 overlay nodes. The spike risk 5 ruling flips `PINS_PAINTED_ON_CANVAS` to `true` in `Pins.tsx`: the canvas paints pins and the DOM buttons become transparent focus targets.

- [ ] **Step 1: Apply the spike risk 5 ruling**

Run: `grep -nE '^\| 5 ' docs/spikes/trace-viewer-spike.md`
Expected: the risk 5 row. When its result is `fail`, write `true` instead of `false` in Step 5's `export const PINS_PAINTED_ON_CANVAS = false;` line; otherwise keep `false`. The C2-0 gate section already names this task as the owner.

- [ ] **Step 2: Write the failing test**

Create `packages/trace-viewer/src/ui/views/hybrid/overview/overview.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAX_OVERLAY_NODES } from "../../../../layout/overview-layout.js";
import { RecordingContext } from "../../../../test-support/recording-context.js";
import {
  foldFixture,
  renderHarness,
  stubLayout,
  type HarnessOptions,
  type LayoutStub,
} from "../../../../test-support/ui-harness.js";
import { KeyboardLayer } from "../../../shell/KeyboardLayer.js";
import { Overview, type OverviewApi } from "./Overview.js";

let layout: LayoutStub;
beforeEach(() => {
  layout = stubLayout({ width: 1400, height: 600 });
});
afterEach(() => {
  cleanup();
  layout.restore();
});

function WithKeys({ children }: { children: ReactNode }) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setRoot}>
      <main data-region="main">{children}</main>
      <KeyboardLayer root={root} />
    </div>
  );
}

async function renderOverview(options: HarnessOptions = {}) {
  const session = foldFixture("oauth");
  const apiRef: { current: OverviewApi | null } = { current: null };
  const h = renderHarness(
    <WithKeys>
      <Overview
        active
        apiRef={apiRef}
        spineWindow={null}
        onSettle={() => undefined}
        createContext={() => new RecordingContext()}
      />
    </WithKeys>,
    session,
    options,
  );
  await act(async () => undefined);
  await act(async () => undefined);
  return { h, session, apiRef };
}

function slider(): HTMLElement {
  return screen.getByRole("slider", { name: "Playhead" });
}

function claimStep(): `step:${number}` {
  const claim = foldFixture("oauth").findings.find((finding) => finding.ruleId === "claim_contradicted");
  if (claim === undefined) throw new Error("oauth has no claim_contradicted finding");
  return claim.anchorStepId;
}

describe("Overview", () => {
  it("moves the playhead on a click on the empty track and keeps the selection", async () => {
    const selected = claimStep();
    const { h } = await renderOverview({ state: { selection: selected } });
    const track = screen.getByTestId("overview-track");
    fireEvent.pointerDown(track, { clientX: 300, button: 0, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 300, pointerId: 1 });
    expect(h.store.get().playhead.kind).toBe("free");
    expect(h.store.get().selection).toBe(selected);
  });

  it("treats a drag under 4 px as a click", async () => {
    const { h } = await renderOverview();
    const track = screen.getByTestId("overview-track");
    fireEvent.pointerDown(track, { clientX: 300, button: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 302, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 302, pointerId: 1 });
    expect(h.store.get().playhead.kind).toBe("free");
    expect(h.store.get().brush).toEqual({ kind: "session" });
  });

  it("draws a range brush on a longer drag", async () => {
    const { h } = await renderOverview();
    const track = screen.getByTestId("overview-track");
    fireEvent.pointerDown(track, { clientX: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 700, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 700, pointerId: 1 });
    const brush = h.store.get().brush;
    expect(brush.kind).toBe("range");
    if (brush.kind === "range") expect(brush.toSeq === "live" || brush.fromSeq < brush.toSeq).toBe(true);
    expect(h.store.get().gesture).toBeNull();
  });

  it("names the playhead slider with offset, title and position", async () => {
    const session = foldFixture("oauth");
    const selected = claimStep();
    await renderOverview({ state: { selection: selected } });
    const position = session.steps.findIndex((step) => step.id === selected) + 1;
    expect(slider().getAttribute("aria-valuetext")).toBe(
      `+0:43, Claim contradicts tests, step ${position} of ${session.steps.length}`,
    );
    expect(slider().getAttribute("aria-valuenow")).toBe(String(position));
  });

  it("moves one step, one pin or one band start with the arrow keys", async () => {
    const session = foldFixture("oauth");
    await renderOverview({ state: { selection: session.steps[0]?.id ?? null } });
    const now = (): number => Number(slider().getAttribute("aria-valuenow"));
    const start = now();
    fireEvent.keyDown(slider(), { key: "ArrowRight" });
    expect(now()).toBe(start + 1);

    const pinned = new Set(
      Array.from(document.querySelectorAll<HTMLElement>("[data-steps]")).flatMap((pin) =>
        (pin.dataset.steps ?? "").split(",").map((value) => Number(value) + 1),
      ),
    );
    fireEvent.keyDown(slider(), { key: "ArrowRight", altKey: true });
    expect(pinned.has(now())).toBe(true);

    const beforeShift = now();
    fireEvent.keyDown(slider(), { key: "ArrowRight", shiftKey: true });
    expect(now()).toBeGreaterThan(beforeShift);
  });

  it("sets the brush from the playhead with {, } and b", async () => {
    const session = foldFixture("oauth");
    const { h } = await renderOverview();
    const seq = session.steps[5]?.firstSeq ?? 1;
    act(() => h.store.dispatch({ type: "playhead/set", playhead: { kind: "free", seq }, origin: "program" }));
    fireEvent.keyDown(document.body, { code: "BracketLeft", key: "{", shiftKey: true });
    const afterFrom = h.store.get().brush;
    expect(afterFrom.kind).toBe("range");
    if (afterFrom.kind === "range") expect(afterFrom.fromSeq).toBe(seq);
    fireEvent.keyDown(document.body, { code: "KeyB", key: "b" });
    expect(h.store.get().brush.kind).toBe("chapter");
  });

  it("keeps the overlay within 150 nodes at Session level and names every pin", async () => {
    const { h } = await renderOverview();
    act(() => h.store.dispatch({ type: "level/set", level: "session", by: "hybrid" }));
    await act(async () => undefined);
    expect(document.querySelectorAll("[data-overlay-node]").length).toBeLessThanOrEqual(MAX_OVERLAY_NODES);
    const pins = Array.from(document.querySelectorAll<HTMLElement>("[data-steps]"));
    expect(pins.length).toBeGreaterThan(0);
    for (const pin of pins) expect((pin.getAttribute("aria-label") ?? "").length).toBeGreaterThan(0);
  });

  it("shows the claim pin at Chapter level", async () => {
    await renderOverview({ state: { selection: claimStep() } });
    const labels = Array.from(document.querySelectorAll<HTMLElement>("[data-steps]")).map((pin) => pin.getAttribute("aria-label") ?? "");
    expect(labels.some((label) => label.startsWith("Claim contradicts tests"))).toBe(true);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/hybrid/overview/overview.test.tsx`
Expected: FAIL with `Failed to resolve import "./Overview.js"`.

- [ ] **Step 4: Write the CSS**

Create `packages/trace-viewer/src/ui/views/hybrid/overview/Overview.module.css`:

```css
.overview {
  position: relative;
  flex: none;
  overflow: hidden;
  background-color: var(--tv-canvas);
  background-image: radial-gradient(var(--tv-fill-2) 1px, transparent 1px);
  background-size: 12px 12px;
  box-shadow: inset 0 -1px 0 var(--tv-hair);
}

.gutter {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
}

.laneLabel {
  position: absolute;
  left: 0;
  right: 8px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  color: var(--tv-ink-2);
}

.laneName {
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-ink-3);
}

.lanes {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  overflow: hidden;
  touch-action: none;
}

.lanes[data-tool="hand"] {
  cursor: grab;
}

.canvas {
  position: absolute;
  top: 0;
  left: 0;
}

.overlay {
  position: absolute;
  inset: 0;
}

.ruler {
  top: 36px;
}

.underline {
  position: absolute;
  top: 50px;
  height: 2px;
  background: var(--tv-ink-4);
  pointer-events: none;
}

.track {
  position: absolute;
  top: 36px;
  left: 0;
  right: 0;
  height: 190px;
  z-index: 1;
}

.brushBody {
  position: absolute;
  top: 52px;
  height: 174px;
  z-index: 2;
  background: var(--tv-accent-soft);
  cursor: grab;
}

.edge {
  position: absolute;
  top: 52px;
  width: 8px;
  height: 174px;
  z-index: 4;
  cursor: ew-resize;
}

.edge::after {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: 2.5px;
  width: 3px;
  border-radius: 2px;
  background: var(--tv-accent);
}

.playheadLine {
  position: absolute;
  top: 36px;
  width: 1px;
  height: 190px;
  z-index: 5;
  background: var(--tv-accent);
  pointer-events: none;
}

.playheadHandle {
  position: absolute;
  top: 30px;
  width: 13px;
  height: 14px;
  z-index: 5;
  border-radius: 3px 3px 7px 7px;
  background: var(--tv-accent);
  cursor: ew-resize;
}

.edge:focus-visible,
.playheadHandle:focus-visible,
.pin:focus-visible,
.bandLabel:focus-visible,
.tool:focus-visible {
  outline: 2px solid var(--tv-accent);
  outline-offset: 2px;
}

.pin {
  position: absolute;
  z-index: 3;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--tv-panel);
  color: var(--tv-ink-2);
  box-shadow: var(--tv-shadow);
  cursor: pointer;
}

.pin[data-critical] {
  background: var(--tv-bad);
  color: var(--tv-panel);
}

.pin[aria-pressed="true"] {
  box-shadow: 0 0 0 2px var(--tv-accent);
}

.pin[data-painted] {
  background: transparent;
  box-shadow: none;
  color: transparent;
}

.pinCount {
  font-size: 12px;
  line-height: 16px;
  font-weight: 600;
}

.links {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 2;
  pointer-events: none;
}

.link {
  fill: none;
  stroke: var(--tv-bad);
  stroke-width: 1.5px;
}

.neq {
  position: absolute;
  z-index: 3;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--tv-bad);
  color: var(--tv-panel);
  pointer-events: none;
}

.bandLabel {
  position: absolute;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 18px;
  padding: 0 4px;
  overflow: hidden;
  border: 0;
  background: transparent;
  color: var(--tv-ink-2);
  font: inherit;
  font-size: 12px;
  line-height: 16px;
  white-space: nowrap;
  cursor: default;
}

.bandTitle {
  overflow: hidden;
  text-overflow: ellipsis;
}

.toolbar {
  position: absolute;
  bottom: 12px;
  left: 50%;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px;
  border-radius: 10px;
  background: var(--tv-panel);
  box-shadow: var(--tv-shadow);
  transform: translateX(-50%);
}

.tool {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--tv-ink-2);
  cursor: pointer;
}

.tool[aria-pressed="true"] {
  background: var(--tv-fill-2);
  color: var(--tv-ink);
}

.zoom {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-ink-2);
}
```

- [ ] **Step 5: Implement pins and the brush layer**

Create `packages/trace-viewer/src/ui/views/hybrid/overview/Pins.tsx`:

```tsx
import { LANE_H, PIN_PX, type PinPlacement } from "../../../../layout/overview-layout.js";
import type { SelectionId, TraceIndex } from "../../../../layout/trace-index.js";
import { formatOffset, type Step, type TraceSession } from "../../../../model/index.js";
import { selectionTitle } from "../../../inspector/finding-copy.js";
import type { IconName } from "../../../icons/icon-names.js";
import { Icon } from "../../../icons/Icon.js";
import { KIND_ICON, SIGNAL_ICON } from "../../../icons/kind-icons.js";
import styles from "./Overview.module.css";
import { laneTop } from "./paint.js";

/** Spike risk 5 ruling (C2-0): true paints pins on the canvas and keeps these buttons as focus targets. */
export const PINS_PAINTED_ON_CANVAS = false;

export function pinIcon(pin: PinPlacement, session: TraceSession): IconName {
  const finding = pin.findingId === null ? undefined : session.findings.find((item) => item.id === pin.findingId);
  if (finding !== undefined) return finding.ruleId === "claim_contradicted" ? "quote" : SIGNAL_ICON[finding.ruleId];
  switch (pin.kind) {
    case "decision":
      return "fork";
    case "approval":
      return "key";
    case "instruction":
      return "person";
    case "guardrail":
      return "shield";
    default: {
      const step = session.steps[pin.stepIndexes[0] ?? -1];
      return step === undefined ? "flag" : KIND_ICON[step.kind];
    }
  }
}

export function pinLabel(pin: PinPlacement, session: TraceSession, index: TraceIndex): string {
  const steps = pin.stepIndexes.map((position) => session.steps[position]).filter((step): step is Step => step !== undefined);
  if (pin.cluster) {
    const problems = steps.filter((step) => step.problems.length > 0 || step.findingIds.length > 0).length;
    const range = `${formatOffset(steps[0]?.tMs ?? 0)} to ${formatOffset(steps.at(-1)?.tMs ?? 0)}`;
    return `${steps.length} events, ${range}${problems > 0 ? `, ${problems} ${problems === 1 ? "problem" : "problems"}` : ""}`;
  }
  const step = steps[0];
  return step === undefined ? "Pin" : `${selectionTitle(session, index, step.id)}, ${formatOffset(step.tMs)}`;
}

export interface PinsProps {
  pins: readonly PinPlacement[];
  session: TraceSession;
  index: TraceIndex;
  selection: SelectionId | null;
  onSelect(stepIndex: number): void;
  onZoomTo(stepIndexes: readonly number[]): void;
}

export function Pins({ pins, session, index, selection, onSelect, onZoomTo }: PinsProps) {
  return (
    <>
      {pins.map((pin) => {
        const selected = pin.stepIndexes.some((position) => session.steps[position]?.id === selection);
        return (
          <button
            key={pin.key}
            type="button"
            tabIndex={-1}
            data-overlay-node=""
            data-steps={pin.stepIndexes.join(",")}
            data-critical={pin.critical ? "" : undefined}
            data-painted={PINS_PAINTED_ON_CANVAS ? "" : undefined}
            aria-pressed={selected}
            aria-label={pinLabel(pin, session, index)}
            className={styles.pin}
            style={{ left: pin.x - PIN_PX / 2, top: laneTop(pin.lane) + (LANE_H - PIN_PX) / 2 }}
            onClick={() => {
              if (pin.cluster) onZoomTo(pin.stepIndexes);
              else if (pin.stepIndexes[0] !== undefined) onSelect(pin.stepIndexes[0]);
            }}
          >
            {pin.cluster ? (
              <span className={styles.pinCount}>{pin.stepIndexes.length}</span>
            ) : (
              <Icon name={pinIcon(pin, session)} size={14} />
            )}
          </button>
        );
      })}
    </>
  );
}
```

Create `packages/trace-viewer/src/ui/views/hybrid/overview/Brush.tsx`:

```tsx
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

import type { BandPlacement, PinPlacement } from "../../../../layout/overview-layout.js";
import type { TimeScale } from "../../../../layout/time-scale.js";
import { brushSeqRange, type Brush as BrushState, type TraceIndex } from "../../../../layout/trace-index.js";
import { screenXToU, uToScreenX, type XOnlyCamera } from "../../../../layout/viewport.js";
import { formatOffset, type Level, type TraceSession } from "../../../../model/index.js";
import { selectionTitle } from "../../../inspector/finding-copy.js";
import type { Gesture, Tool } from "../../../state/view-state.js";
import styles from "./Overview.module.css";

export function stepX(session: TraceSession, scale: TimeScale, camera: XOnlyCamera, stepIndex: number): number {
  const step = session.steps[stepIndex];
  return step === undefined ? 0 : uToScreenX(camera, scale.toU(step.tMs));
}

function stepEndX(session: TraceSession, scale: TimeScale, camera: XOnlyCamera, stepIndex: number): number {
  const step = session.steps[stepIndex];
  return step === undefined ? 0 : uToScreenX(camera, scale.toU(step.tMs + (step.durationMs ?? 0)));
}

/** Step nearest to screen x ("after": the first step at or after x). Step.tMs never decreases with seq. */
export function stepIndexAtX(
  session: TraceSession,
  scale: TimeScale,
  camera: XOnlyCamera,
  x: number,
  mode: "nearest" | "after" = "nearest",
): number {
  const steps = session.steps;
  if (steps.length === 0) return -1;
  const t = scale.toT(screenXToU(camera, x));
  let lo = 0;
  let hi = steps.length - 1;
  let first = steps.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((steps[mid]?.tMs ?? 0) >= t) {
      first = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (first >= steps.length) return steps.length - 1;
  if (mode === "after" || first === 0) return first;
  const before = first - 1;
  return t - (steps[before]?.tMs ?? 0) <= (steps[first]?.tMs ?? 0) - t ? before : first;
}

export interface BrushProps {
  session: TraceSession;
  index: TraceIndex;
  scale: TimeScale;
  camera: XOnlyCamera;
  level: Level;
  brush: BrushState;
  playheadSeq: number;
  pins: readonly PinPlacement[];
  bands: readonly BandPlacement[];
  tool: Tool;
  onPlayhead(seq: number): void;
  onStep(dir: 1 | -1): void;
  onBrush(brush: BrushState): void;
  onGesture(gesture: Gesture): void;
}

function lanesLeft(element: Element): number {
  return element.closest("[data-overview-lanes]")?.getBoundingClientRect().left ?? 0;
}

export function Brush(props: BrushProps) {
  const { session, index, scale, camera, level, brush, playheadSeq, pins, bands, tool } = props;
  const steps = session.steps;
  const range = brushSeqRange(brush, index);
  const fromIndex = Math.min(steps.length - 1, Math.max(0, index.stepIndexAtOrAfter(range.fromSeq)));
  const toIndex = Math.max(0, index.stepIndexAtOrBefore(range.toSeq));
  const x0 = stepX(session, scale, camera, fromIndex);
  const x1 = Math.max(x0 + 2, stepEndX(session, scale, camera, toIndex));
  const playIndex = Math.max(0, index.stepIndexAtOrBefore(playheadSeq));
  const playStep = steps[playIndex];
  const px = stepX(session, scale, camera, playIndex);

  const seqAt = (x: number): number => steps[Math.max(0, stepIndexAtX(session, scale, camera, x))]?.firstSeq ?? 1;

  const rangeFor = (a: number, b: number, snap: boolean): BrushState => {
    let lo = Math.min(a, b);
    let hi = Math.max(a, b);
    if (snap && level === "session") {
      const start = bands.find((band) => band.x0 <= lo && lo <= band.x1);
      const end = bands.find((band) => band.x0 <= hi && hi <= band.x1);
      if (start !== undefined) lo = start.x0;
      if (end !== undefined) hi = end.x1;
    }
    const from = seqAt(lo);
    const to = seqAt(hi);
    return { kind: "range", fromSeq: Math.min(from, to), toSeq: Math.max(from, to) };
  };

  const beginDrag = (
    event: ReactPointerEvent<HTMLElement>,
    gesture: Gesture,
    onMove: (startX: number, x: number, alt: boolean) => void,
    onClick: ((x: number) => void) | null,
  ): void => {
    if (event.button !== 0 || tool === "hand") return;
    const element = event.currentTarget;
    const origin = lanesLeft(element);
    const startX = event.clientX - origin;
    let dragging = false;
    if (typeof element.setPointerCapture === "function") element.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent): void => {
      const x = e.clientX - origin;
      if (!dragging && Math.abs(x - startX) >= 4) {
        dragging = true;
        props.onGesture(gesture);
      }
      if (dragging) onMove(startX, x, e.altKey);
    };
    const up = (e: PointerEvent): void => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", up);
      if (dragging) {
        onMove(startX, e.clientX - origin, e.altKey);
        props.onGesture(null);
      } else if (onClick !== null) {
        onClick(startX);
      }
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", up);
  };

  const onPlayheadKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const dir: 1 | -1 = event.key === "ArrowRight" ? 1 : -1;
    const pick = (xs: number[]): number | undefined =>
      dir === 1 ? xs.find((x) => x > px + 0.5) : [...xs].reverse().find((x) => x < px - 0.5);
    if (event.altKey) {
      const target = pick(pins.map((pin) => pin.x).sort((a, b) => a - b));
      const pin = pins.find((item) => item.x === target);
      const step = pin?.stepIndexes[0] === undefined ? undefined : steps[pin.stepIndexes[0]];
      if (step !== undefined) props.onPlayhead(step.firstSeq);
      return;
    }
    if (event.shiftKey) {
      const target = pick(bands.map((band) => band.x0).sort((a, b) => a - b));
      if (target === undefined) return;
      const step = steps[stepIndexAtX(session, scale, camera, target + 0.5, "after")];
      if (step !== undefined) props.onPlayhead(step.firstSeq);
      return;
    }
    props.onStep(dir);
  };

  const onEdgeKeyDown = (edge: "from" | "to") => (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const dir = event.key === "ArrowRight" ? 1 : -1;
    const from = steps[Math.max(0, Math.min(steps.length - 1, fromIndex + (edge === "from" ? dir : 0)))]?.firstSeq ?? 1;
    const to = steps[Math.max(0, Math.min(steps.length - 1, toIndex + (edge === "to" ? dir : 0)))]?.firstSeq ?? from;
    props.onBrush({ kind: "range", fromSeq: Math.min(from, to), toSeq: Math.max(from, to) });
  };

  const valueText = (stepIndex: number): string => formatOffset(steps[stepIndex]?.tMs ?? 0);

  return (
    <>
      <div
        className={styles.track}
        data-testid="overview-track"
        data-pannable=""
        onPointerDown={(event) =>
          beginDrag(
            event,
            "brush",
            (startX, x, alt) => props.onBrush(rangeFor(startX, x, !alt)),
            (x) => props.onPlayhead(seqAt(x)),
          )
        }
      />
      {brush.kind === "session" ? null : (
        <>
          <div
            className={styles.brushBody}
            data-overlay-node=""
            style={{ left: x0, width: x1 - x0 }}
            onPointerDown={(event) =>
              beginDrag(event, "brush", (startX, x) => props.onBrush(rangeFor(x0 + x - startX, x1 + x - startX, false)), null)
            }
          />
          <div
            role="slider"
            tabIndex={-1}
            aria-label="Range start"
            aria-valuemin={1}
            aria-valuemax={steps.length}
            aria-valuenow={fromIndex + 1}
            aria-valuetext={valueText(fromIndex)}
            data-overlay-node=""
            className={styles.edge}
            style={{ left: x0 - 4 }}
            onKeyDown={onEdgeKeyDown("from")}
            onPointerDown={(event) =>
              beginDrag(event, "brush", (startX, x) => props.onBrush(rangeFor(x0 + x - startX, x1, false)), null)
            }
          />
          <div
            role="slider"
            tabIndex={-1}
            aria-label="Range end"
            aria-valuemin={1}
            aria-valuemax={steps.length}
            aria-valuenow={toIndex + 1}
            aria-valuetext={valueText(toIndex)}
            data-overlay-node=""
            className={styles.edge}
            style={{ left: x1 - 4 }}
            onKeyDown={onEdgeKeyDown("to")}
            onPointerDown={(event) =>
              beginDrag(event, "brush", (startX, x) => props.onBrush(rangeFor(x0, x1 + x - startX, false)), null)
            }
          />
        </>
      )}
      <div className={styles.playheadLine} data-overlay-node="" style={{ left: Math.round(px) }} />
      {playStep === undefined ? null : (
        <div
          role="slider"
          tabIndex={-1}
          aria-label="Playhead"
          aria-orientation="horizontal"
          aria-valuemin={1}
          aria-valuemax={steps.length}
          aria-valuenow={playIndex + 1}
          aria-valuetext={`${formatOffset(playStep.tMs)}, ${selectionTitle(session, index, playStep.id)}, step ${playIndex + 1} of ${steps.length}`}
          data-overlay-node=""
          className={styles.playheadHandle}
          style={{ left: Math.round(px) - 6 }}
          onKeyDown={onPlayheadKeyDown}
          onPointerDown={(event) => beginDrag(event, "playhead", (_startX, x) => props.onPlayhead(seqAt(x)), null)}
        />
      )}
    </>
  );
}
```

- [ ] **Step 6: Implement the Overview**

Create `packages/trace-viewer/src/ui/views/hybrid/overview/Overview.tsx`:

```tsx
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { buildOverviewIndex, type OverviewIndex } from "../../../../layout/overview-index.js";
import {
  GUTTER_W,
  GUTTER_W_NARROW,
  K_MAX,
  LANE_H,
  LANES_TOP,
  NARROW_CONTAINER_PX,
  OVERVIEW_H,
  layoutOverview,
  overviewPreset,
  type BandPlacement,
  type OverviewLayout,
} from "../../../../layout/overview-layout.js";
import { computeTicks } from "../../../../layout/ticks.js";
import { xOnlyXMap } from "../../../../layout/time-scale.js";
import { brushSeqRange, type TraceIndex } from "../../../../layout/trace-index.js";
import { fitRange, uToScreenX, type XOnlyCamera, type ZoomLimits } from "../../../../layout/viewport.js";
import { LANES, type Level, type TraceSession } from "../../../../model/index.js";
import { Icon } from "../../../icons/Icon.js";
import { CATEGORY_ICON, LANE_ICON, LANE_LABEL } from "../../../icons/kind-icons.js";
import { PERF } from "../../../shell/perf.js";
import { useSessionView } from "../../../shell/session-context.js";
import { useDispatch, useView, useViewStore } from "../../../state/store.js";
import { selectEffectivePlayheadSeq } from "../../../state/view-state.js";
import { LIGHT_TOKENS } from "../../../tokens/tokens.js";
import { createViewportController, type ViewportController } from "../../../viewport/controller.js";
import { LevelControl } from "../../shared/LevelControl.js";
import { Ruler } from "../../shared/Ruler.js";
import { Brush, stepIndexAtX } from "./Brush.js";
import styles from "./Overview.module.css";
import { OverviewCanvas, type CanvasSurface } from "./OverviewCanvas.js";
import { laneCenter, paintOverview, type PaintContext } from "./paint.js";
import { Pins, PINS_PAINTED_ON_CANVAS } from "./Pins.js";

export interface OverviewApi {
  controller(): ViewportController<XOnlyCamera> | null;
  camera(): XOnlyCamera | null;
  widthPx(): number;
  overview(): OverviewIndex | null;
  limits(): ZoomLimits;
  moveTo(camera: XOnlyCamera, animate: boolean): void;
}

export interface OverviewProps {
  active: boolean;
  apiRef: { current: OverviewApi | null };
  spineWindow: { t0: number; t1: number } | null;
  onSettle(camera: XOnlyCamera): void;
  createContext?(canvas: HTMLCanvasElement): PaintContext | null;
}

export function overviewLimits(endU: number, widthPx: number): ZoomLimits {
  const fitK = widthPx / Math.max(endU, 1);
  return { minK: fitK * 0.9, maxK: Math.max(K_MAX, fitK) };
}

export function zoomPercent(camera: XOnlyCamera, presetK: number): string {
  return `${Math.round((camera.k / presetK) * 100)}%`;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function stepTAtSeq(session: TraceSession, index: TraceIndex, seq: number): number {
  return session.steps[Math.max(0, index.stepIndexAtOrBefore(seq))]?.tMs ?? 0;
}

let paintSamples = 0;
function measurePaint(started: number): void {
  try {
    performance.measure(PERF.overviewPaint, { start: started, end: performance.now() });
    paintSamples += 1;
    if (paintSamples > 2_000) {
      performance.clearMeasures(PERF.overviewPaint);
      paintSamples = 0;
    }
  } catch {
    // Timing is diagnostic only.
  }
}

export function Overview({ active, apiRef, spineWindow, onSettle, createContext }: OverviewProps) {
  const { session, index, scale, loadedFraction } = useSessionView();
  const store = useViewStore();
  const dispatch = useDispatch();
  const level = useView((state) => state.level);
  const brush = useView((state) => state.brush);
  const selection = useView((state) => state.selection);
  const tool = useView((state) => state.tool);
  const follow = useView((state) => state.follow);
  const playheadSeq = useView((state) => selectEffectivePlayheadSeq(state, index));

  const containerRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(0);
  const narrow = containerW > 0 && containerW < NARROW_CONTAINER_PX;
  const gutterW = narrow ? GUTTER_W_NARROW : GUTTER_W;
  const widthPx = Math.max(0, containerW - gutterW);

  const overview = useMemo(
    () => (session === null ? null : buildOverviewIndex(session, index, scale)),
    [session, index, scale],
  );
  const limits = useMemo(() => overviewLimits(scale.endU, widthPx), [scale, widthPx]);

  const [camera, setCamera] = useState<XOnlyCamera | null>(null);
  const cameraRef = useRef<XOnlyCamera | null>(null);
  const renderedRef = useRef<XOnlyCamera | null>(null);
  const controllerRef = useRef<ViewportController<XOnlyCamera> | null>(null);
  const surfaceRef = useRef<CanvasSurface | null>(null);
  const live = useRef({ overview, scale, level, widthPx, limits, onSettle, brush, playheadSeq, session, index });
  live.current = { overview, scale, level, widthPx, limits, onSettle, brush, playheadSeq, session, index };

  useEffect(() => {
    const element = containerRef.current;
    if (element === null) return undefined;
    const apply = (width: number): void => {
      if (width > 0) setContainerW(Math.round(width));
    };
    apply(element.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      apply(entry?.contentBoxSize?.[0]?.inlineSize ?? entry?.contentRect.width ?? 0);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const presetCamera = useCallback(
    (forLevel: Level): XOnlyCamera | null => {
      const { overview: current, scale: currentScale, widthPx: width, index: currentIndex } = live.current;
      if (current === null || width <= 0) return null;
      const state = store.get();
      return overviewPreset({
        level: forLevel,
        overview: current,
        index: currentIndex,
        scale: currentScale,
        widthPx: width,
        playheadSeq: selectEffectivePlayheadSeq(state, currentIndex),
        live: state.follow,
      }).camera;
    },
    [store],
  );

  const paintNow = useCallback((): void => {
    const surface = surfaceRef.current;
    const current = cameraRef.current;
    const { overview: model, scale: currentScale, level: currentLevel, brush: currentBrush, playheadSeq: seq, session: s, index: ix } =
      live.current;
    if (surface === null || current === null || model === null || s === null) return;
    const started = performance.now();
    const frame = layoutOverview({ overview: model, camera: current, widthPx: surface.widthPx, level: currentLevel });
    const ticks = computeTicks(xOnlyXMap(currentScale, current), currentScale, { x0: 0, x1: surface.widthPx }).ticks;
    const toStrip = (u: number): number => (u / Math.max(currentScale.endU, 1)) * surface.widthPx;
    const range = brushSeqRange(currentBrush, ix);
    const selected = store.get().selection;
    const selectedChapter = selected === null ? null : selected.startsWith("unit:") ? selected : (ix.entry(selected)?.parent ?? null);
    paintOverview(surface.ctx, {
      layout: frame,
      ticks,
      widthPx: surface.widthPx,
      dpr: surface.dpr,
      tokens: LIGHT_TOKENS,
      emphasizedBands: new Set(frame.bands.filter((band) => band.id !== null && band.id === selectedChapter).map((band) => band.key)),
      strip: {
        brush:
          currentBrush.kind === "session"
            ? null
            : {
                x0: toStrip(currentScale.toU(stepTAtSeq(s, ix, range.fromSeq))),
                x1: toStrip(currentScale.toU(stepTAtSeq(s, ix, range.toSeq))),
              },
        playheadX: toStrip(currentScale.toU(stepTAtSeq(s, ix, seq))),
        viewport: { x0: toStrip(current.u0), x1: toStrip(current.u0 + surface.widthPx / current.k) },
      },
      paintPins: PINS_PAINTED_ON_CANVAS,
    });
    measurePaint(started);
  }, [store]);

  const moveOverlay = useCallback((next: XOnlyCamera): void => {
    const rendered = renderedRef.current;
    const overlay = overlayRef.current;
    if (rendered === null || overlay === null || rendered.k !== next.k) {
      setCamera(next);
      return;
    }
    overlay.style.transform = `translateX(${(rendered.u0 - next.u0) * next.k}px)`;
  }, []);

  const moveTo = useCallback(
    (next: XOnlyCamera, animate: boolean): void => {
      const controller = controllerRef.current;
      if (controller === null) {
        cameraRef.current = next;
        setCamera(next);
        return;
      }
      void controller.set(next, { animate: animate && !prefersReducedMotion() }).then(() => {
        const settled = controller.get();
        cameraRef.current = settled;
        setCamera(settled);
      });
    },
    [],
  );

  // Initial camera: the stored one while in sync with focus, else the level preset (spec §7.8 item 3).
  useLayoutEffect(() => {
    if (cameraRef.current !== null || widthPx <= 0 || overview === null) return;
    const state = store.get();
    const saved = state.cameras.hybrid;
    const initial: XOnlyCamera | null =
      saved !== null && saved.syncedRev === state.focusRev ? { mode: "xOnly", u0: saved.u0, k: saved.k } : presetCamera(state.level);
    if (initial === null) return;
    cameraRef.current = initial;
    setCamera(initial);
  }, [widthPx, overview, store, presetCamera]);

  const cameraReady = camera !== null;
  useEffect(() => {
    const element = lanesRef.current;
    const initial = cameraRef.current;
    if (!active || element === null || initial === null) return undefined;
    const controller = createViewportController<XOnlyCamera>({
      element,
      initial,
      limits: () => live.current.limits,
      viewport: () => ({ w: live.current.widthPx, h: OVERVIEW_H }),
      content: () => ({ x: 0, y: 0, w: Math.max(live.current.scale.endU, 1), h: 0 }),
      onFrame: (next) => {
        cameraRef.current = next;
        paintNow();
        moveOverlay(next);
      },
      onGestureStart: (kind) => {
        if (store.get().follow) store.dispatch({ type: "follow/set", follow: false });
        store.dispatch({ type: "gesture", gesture: kind });
      },
      onGestureEnd: (settled) => {
        cameraRef.current = settled;
        setCamera(settled);
        store.dispatch({ type: "gesture", gesture: null });
        live.current.onSettle(settled);
      },
      isHandTool: () => store.get().tool === "hand",
      reducedMotion: prefersReducedMotion,
    });
    controllerRef.current = controller;
    return () => {
      controller.destroy();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [active, cameraReady, store, paintNow, moveOverlay]);

  // Live: keep the tail in view (spec §7.10 Hybrid overview).
  useEffect(() => {
    const current = cameraRef.current;
    if (!follow || current === null || session === null || widthPx <= 0) return;
    const tailX = uToScreenX(current, scale.endU);
    if (tailX <= widthPx * 0.8 && tailX >= 0) return;
    if (level === "session") {
      moveTo(fitRange(0, Math.max(1, scale.endU * 1.5), widthPx, { padFraction: 0, limits }), false);
    } else {
      moveTo({ mode: "xOnly", u0: scale.endU - (widthPx * 0.6) / current.k, k: current.k }, false);
    }
  }, [session, follow, level, widthPx, scale, limits, moveTo]);

  useLayoutEffect(() => {
    apiRef.current = {
      controller: () => controllerRef.current,
      camera: () => cameraRef.current,
      widthPx: () => live.current.widthPx,
      overview: () => live.current.overview,
      limits: () => live.current.limits,
      moveTo,
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, moveTo]);

  // After every render: the overlay sits at the rendered camera and the canvas repaints.
  useLayoutEffect(() => {
    renderedRef.current = camera;
    if (overlayRef.current !== null) overlayRef.current.style.transform = "";
    paintNow();
  });

  const onSurface = useCallback(
    (surface: CanvasSurface | null): void => {
      surfaceRef.current = surface;
      paintNow();
    },
    [paintNow],
  );

  const renderLayout = useMemo<OverviewLayout | null>(
    () => (overview === null || camera === null || widthPx <= 0 ? null : layoutOverview({ overview, camera, widthPx, level })),
    [overview, camera, widthPx, level],
  );
  const presetK = useMemo(() => presetCamera(level)?.k ?? null, [presetCamera, level, overview, widthPx]);
  const xMap = useMemo(() => (camera === null ? null : xOnlyXMap(scale, camera)), [scale, camera]);
  const loadedThroughT = loadedFraction < 1 && session !== null ? (session.steps.at(-1)?.tMs ?? 0) : null;

  const focusBand = (band: BandPlacement): void => {
    if (session === null || camera === null) return;
    const step = session.steps[stepIndexAtX(session, scale, camera, band.x0 + 0.5, "after")];
    if (step === undefined) return;
    dispatch({ type: "playhead/set", playhead: { kind: "free", seq: step.firstSeq }, origin: "overview" });
    const key = band.id === null ? undefined : index.chapterKey(band.id);
    if (key !== undefined) dispatch({ type: "brush/set", brush: { kind: "chapter", anchorSeq: Number(key.slice(3)) }, by: "hybrid" });
    dispatch({ type: "level/set", level: "chapter", by: "hybrid" });
  };

  const zoomToSteps = (stepIndexes: readonly number[]): void => {
    if (session === null || widthPx <= 0) return;
    const first = session.steps[stepIndexes[0] ?? 0];
    const last = session.steps[stepIndexes.at(-1) ?? 0];
    if (first === undefined || last === undefined) return;
    moveTo(
      fitRange(scale.toU(first.tMs), scale.toU(last.tMs + (last.durationMs ?? 0)) + 1, widthPx, { padFraction: 0.2, limits }),
      true,
    );
  };

  const pinByKey = new Map((renderLayout?.pins ?? []).map((pin) => [pin.key, pin]));

  return (
    <div ref={containerRef} className={styles.overview} data-measure-root="" data-pannable="" style={{ height: OVERVIEW_H }}>
      <div className={styles.gutter} style={{ width: gutterW }}>
        {LANES.map((lane, position) => (
          <div key={lane} className={styles.laneLabel} style={{ top: LANES_TOP + position * LANE_H, height: LANE_H }}>
            {narrow ? null : <span className={styles.laneName}>{LANE_LABEL[lane]}</span>}
            <Icon name={LANE_ICON[lane]} size={14} title={narrow ? LANE_LABEL[lane] : undefined} />
          </div>
        ))}
      </div>
      <div ref={lanesRef} className={styles.lanes} style={{ left: gutterW }} data-overview-lanes="" data-tool={tool}>
        <OverviewCanvas
          widthPx={widthPx}
          heightPx={OVERVIEW_H}
          className={styles.canvas}
          onSurface={onSurface}
          createContext={createContext}
        />
        <div ref={overlayRef} className={styles.overlay}>
          {xMap === null ? null : (
            <Ruler map={xMap} scale={scale} widthPx={widthPx} loadedThroughT={loadedThroughT} className={styles.ruler} />
          )}
          {spineWindow === null || xMap === null ? null : (
            <span
              className={styles.underline}
              style={{ left: xMap.xOf(spineWindow.t0), width: Math.max(2, xMap.xOf(spineWindow.t1) - xMap.xOf(spineWindow.t0)) }}
            />
          )}
          {renderLayout === null || session === null || camera === null ? null : (
            <>
              {renderLayout.bands
                .filter((band) => band.tier !== null)
                .map((band) => {
                  const chapter = band.id === null ? undefined : session.chapters.find((item) => item.id === band.id);
                  return (
                    <button
                      key={band.key}
                      type="button"
                      tabIndex={-1}
                      data-overlay-node=""
                      className={styles.bandLabel}
                      style={{ left: band.x0, top: band.tier === 1 ? 18 : 0, maxWidth: Math.max(20, band.x1 - band.x0) }}
                      title={band.title}
                      aria-label={band.title}
                      onDoubleClick={() => focusBand(band)}
                    >
                      <Icon name={chapter === undefined ? "flag" : CATEGORY_ICON[chapter.category]} size={12} />
                      {band.iconOnly ? null : <span className={styles.bandTitle}>{band.title}</span>}
                    </button>
                  );
                })}
              <Brush
                session={session}
                index={index}
                scale={scale}
                camera={camera}
                level={level}
                brush={brush}
                playheadSeq={playheadSeq}
                pins={renderLayout.pins}
                bands={renderLayout.bands}
                tool={tool}
                onPlayhead={(seq) =>
                  dispatch({ type: "playhead/set", playhead: { kind: "free", seq }, origin: "overview" })
                }
                onStep={(dir) => dispatch({ type: "playhead/step", dir })}
                onBrush={(next) => dispatch({ type: "brush/set", brush: next, by: "hybrid" })}
                onGesture={(gesture) => dispatch({ type: "gesture", gesture })}
              />
              <Pins
                pins={renderLayout.pins}
                session={session}
                index={index}
                selection={selection}
                onSelect={(stepIndex) => {
                  const step = session.steps[stepIndex];
                  if (step !== undefined) dispatch({ type: "select", id: step.id, by: "hybrid" });
                }}
                onZoomTo={zoomToSteps}
              />
              <svg className={styles.links} aria-hidden="true" width={widthPx} height={OVERVIEW_H}>
                {renderLayout.links.map((link) => {
                  const a = pinByKey.get(link.fromPin);
                  const b = pinByKey.get(link.toPin);
                  if (a === undefined || b === undefined) return null;
                  const ay = laneCenter(a.lane);
                  const by = laneCenter(b.lane);
                  const mx = (a.x + b.x) / 2;
                  return <path key={link.findingId} className={styles.link} d={`M ${a.x} ${ay} C ${mx} ${ay}, ${mx} ${by}, ${b.x} ${by}`} />;
                })}
              </svg>
              {renderLayout.links.map((link) => {
                const a = pinByKey.get(link.fromPin);
                const b = pinByKey.get(link.toPin);
                if (a === undefined || b === undefined) return null;
                return (
                  <span
                    key={`neq:${link.findingId}`}
                    className={styles.neq}
                    data-overlay-node=""
                    style={{ left: (a.x + b.x) / 2 - 9, top: (laneCenter(a.lane) + laneCenter(b.lane)) / 2 - 9 }}
                  >
                    <Icon name="neq" size={12} />
                  </span>
                );
              })}
            </>
          )}
        </div>
        <div className={styles.toolbar} role="toolbar" aria-label="Overview tools">
          <button
            type="button"
            tabIndex={-1}
            aria-label="Select"
            aria-pressed={tool === "select"}
            className={styles.tool}
            onClick={() => dispatch({ type: "tool/set", tool: "select" })}
          >
            <Icon name="cursor" size={16} />
          </button>
          <button
            type="button"
            tabIndex={-1}
            aria-label="Hand"
            aria-pressed={tool === "hand"}
            className={styles.tool}
            onClick={() => dispatch({ type: "tool/set", tool: "hand" })}
          >
            <Icon name="hand" size={16} />
          </button>
          <LevelControl by="hybrid" />
          <span className={styles.zoom}>
            <Icon name="zoom" size={14} />
            {camera === null || presetK === null ? "100%" : zoomPercent(camera, presetK)}
          </span>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Run the test to see it pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/hybrid/overview`
Expected: PASS (overview 8, paint 4).

- [ ] **Step 8: Root checks**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add packages/trace-viewer/src/ui/views/hybrid/overview/Brush.tsx packages/trace-viewer/src/ui/views/hybrid/overview/Pins.tsx \
  packages/trace-viewer/src/ui/views/hybrid/overview/Overview.tsx packages/trace-viewer/src/ui/views/hybrid/overview/Overview.module.css \
  packages/trace-viewer/src/ui/views/hybrid/overview/overview.test.tsx
git commit -m "feat(trace-viewer): add the overview DOM with pins, brush and playhead sliders"
```

---
### Task C2-12: Spine: virtualizer, row components, scroll ↔ playhead sync

**Files:**
- Create: `packages/trace-viewer/src/ui/views/hybrid/spine/scroll-sync.ts`
- Create: `packages/trace-viewer/src/ui/views/hybrid/spine/rows/StepRow.tsx`
- Create: `packages/trace-viewer/src/ui/views/hybrid/spine/rows/SeparatorRows.tsx`
- Create: `packages/trace-viewer/src/ui/views/hybrid/spine/rows/GroupRows.tsx`
- Create: `packages/trace-viewer/src/ui/views/hybrid/spine/Spine.tsx`
- Create: `packages/trace-viewer/src/ui/views/hybrid/spine/Spine.module.css`
- Test: `packages/trace-viewer/src/ui/views/hybrid/spine/scroll-sync.test.ts`
- Test: `packages/trace-viewer/src/ui/views/hybrid/spine/spine.test.tsx`

**Interfaces:**
- Consumes:
  - C1b `layout/spine-rows.ts`: `SpineRow` (`step` with `expanded`, `chapter`, `noise` with `label`, `elided` with `byLane` and `spanMs`, `turn`, `idle` with `ms` and `reason`, `gap`), `buildSpineRows(session, index, scale, input: SpineRowsInput): SpineRow[]`, `estimateSpineRowSize(row, session): number`, `spineRowIndexForSeq(rows, session, seq): number`, `SPINE_ROW_PX = 32`; `layout/tone.ts` `stepTone(step, findingsById): Tone`; `layout/trace-index.ts` `brushSeqRange`, `SelectionId`.
  - C1b store: `useView`, `useDispatch`, `useViewStore`, `selectEffectivePlayheadSeq`, `selectNewCount`, `playheadOrigin`, `focusRev`; actions `select`, `playhead/set`, `expand/set`, `expand/toggle`, `nav/last`, `follow/set`. **Assumption pinned by C1-11's contract text**: `expand/set` with a `finding:` key and `expanded: false` puts that id in `collapsed`, and `buildSpineRows` expands a step row when its key is in `expanded`, or when its top finding is critical and not in `collapsed`.
  - `@tanstack/react-virtual` 3.14.13: `useVirtualizer`, `defaultRangeExtractor`, `Range`, virtualizer `measureElement`, `measurementsCache`, `scrollToIndex(index, { align, behavior })`, `getVirtualItems()`, `getTotalSize()`, `isScrolling`, options `anchorTo`, `followOnAppend`, `scrollEndThreshold`, `overscan`, `rangeExtractor`, `onChange`, `getItemKey`.
  - B `formatOffset`, `formatDuration`, `displayUntrusted`, `normalizeCommand`, `exitLabel`, `truncateMiddle`, `pickGraphic`, `describeGraphic`, `KIND_META`; C1a `Icon`, `Graphic`, `KIND_ICON`, `CATEGORY_ICON`, `LANE_LABEL`, `SIGNAL_ICON`; C2-3 `useSessionView`, `useDiagnostics`, `markAfterPaint`, `PERF`; C2-6 `topFindingOf`, `FINDING_TITLE`; C2-9 `NewBadge`.
- Produces:

```ts
// spine/scroll-sync.ts
export const COMFORT_INSET_PX = 32;
export interface Span { start: number; end: number }
export interface ScrollWindow { offset: number; height: number }
export function comfortBand(win: ScrollWindow): Span;
/** "none" inside the comfort band; "center" when the row lies more than one viewport outside; else "auto". */
export function revealAlign(row: Span, win: ScrollWindow): "none" | "auto" | "center";
export interface PushCandidate { index: number; start: number; end: number; target: boolean }
/** After a user scroll: the first (playhead above) or last (below) target row inside the band, else null. */
export function pushTarget(playhead: Span | null, candidates: readonly PushCandidate[], win: ScrollWindow): number | null;
export function spineVirtualOptions(follow: boolean): { anchorTo: "end"; followOnAppend: "auto" | false; scrollEndThreshold: 24; overscan: 10 };
export function extendRange(base: readonly number[], extra: readonly number[], count: number): number[];
// spine/Spine.tsx
export interface FindingBodyProps { finding: Finding; step: Step; session: TraceSession; onJump(stepId: StepId): void }
export const FindingBodyContext: React.Context<React.ComponentType<FindingBodyProps> | null>;
export interface SpineApi {
  rows(): readonly SpineRow[];
  revealSeq(seq: number, align: "auto" | "center"): void;
  focusRow(key: string): void;
}
export interface SpineProps {
  active: boolean;
  apiRef: { current: SpineApi | null };
  onWindow?(window: { t0: number; t1: number } | null): void;
  onAnchor?(anchor: { key: string; offsetPx: number } | null): void;
}
export function Spine(props: SpineProps): React.JSX.Element;
// spine/rows/*.tsx
export function StepRow(props: StepRowProps): React.JSX.Element;
export function SeparatorRow(props: { row: Extract<SpineRow, { t: "turn" | "idle" | "gap" }>; session: TraceSession }): React.JSX.Element;
export function GroupRow(props: { row: Extract<SpineRow, { t: "chapter" | "noise" | "elided" }>; session: TraceSession; onActivate(): void }): React.JSX.Element;
```

Row anatomy (spec §7.6.3): grid `52px 24px 120px minmax(0,1fr) auto`, 12 px gap, 32 px minimum, separators 24 px; the playhead row's time is an accent pill; the node is a 24 px circle on a continuous 2 px spine line (`bad` tone: bad-soft fill and red icon; critical finding: solid red with a panel-colored icon; a nonzero command exit: neutral node with a ✕); a finding row's line is `FINDING_TITLE`, never agent text; agent messages render `--tv-ink-2`, reasoning is prefixed "Thinking"; commands and paths pass through `displayUntrusted` in mono. Scroll sync follows the pseudo-code in spec §7.6.3: one writer per direction, writes with origin `"spine"` never scroll, programmatic scrolls are instant, pushes pause while a programmatic scroll settles, a click on a visible row never scrolls (the spine skips the reveal for its own `focusRev`), and a brush or level change reveals the playhead row centered. Only expanded rows are measured; their virtualizer key is `row.key + "+x"` while the React key stays `row.key`. The live footer and the "↓ N new" pill sit outside the list. The finding-body classes below (`findingBody`, `chain`, …) live here so C2-13 needs no CSS file.

- [ ] **Step 1: Write the failing pure test**

Create `packages/trace-viewer/src/ui/views/hybrid/spine/scroll-sync.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { comfortBand, extendRange, pushTarget, revealAlign, spineVirtualOptions, type PushCandidate } from "./scroll-sync.js";

const win = { offset: 1_000, height: 600 };

function rows(from: number, to: number, nonTargets: readonly number[] = []): PushCandidate[] {
  const out: PushCandidate[] = [];
  for (let index = from; index <= to; index += 1) {
    const start = 1_000 + (index - from) * 32;
    out.push({ index, start, end: start + 32, target: !nonTargets.includes(index) });
  }
  return out;
}

describe("scroll-sync", () => {
  it("insets the comfort band by 32 px", () => {
    expect(comfortBand(win)).toEqual({ start: 1_032, end: 1_568 });
  });

  it("leaves a row inside the band, scrolls the minimum just outside, centers a far row", () => {
    expect(revealAlign({ start: 1_100, end: 1_132 }, win)).toBe("none");
    expect(revealAlign({ start: 1_590, end: 1_622 }, win)).toBe("auto");
    expect(revealAlign({ start: 1_010, end: 1_042 }, win)).toBe("auto");
    expect(revealAlign({ start: 2_700, end: 2_732 }, win)).toBe("center");
    expect(revealAlign({ start: 100, end: 132 }, win)).toBe("center");
  });

  it("moves the playhead the minimum distance into the comfort band", () => {
    const candidates = rows(10, 28);
    expect(pushTarget({ start: 900, end: 932 }, candidates, win)).toBe(11);
    expect(pushTarget({ start: 1_700, end: 1_732 }, candidates, win)).toBe(26);
    expect(pushTarget({ start: 1_200, end: 1_232 }, candidates, win)).toBeNull();
    expect(pushTarget(null, candidates, win)).toBeNull();
  });

  it("skips separator rows when pushing", () => {
    expect(pushTarget({ start: 900, end: 932 }, rows(10, 28, [11, 12]), win)).toBe(13);
  });

  it("anchors to the end and follows appends only while following", () => {
    expect(spineVirtualOptions(true)).toEqual({ anchorTo: "end", followOnAppend: "auto", scrollEndThreshold: 24, overscan: 10 });
    expect(spineVirtualOptions(false)).toEqual({ anchorTo: "end", followOnAppend: false, scrollEndThreshold: 24, overscan: 10 });
  });

  it("keeps the playhead and focused rows mounted", () => {
    expect(extendRange([3, 4, 5], [9, -1, 4, 40], 20)).toEqual([3, 4, 5, 9]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/hybrid/spine/scroll-sync.test.ts`
Expected: FAIL with `Failed to resolve import "./scroll-sync.js"`.

- [ ] **Step 3: Implement scroll-sync**

Create `packages/trace-viewer/src/ui/views/hybrid/spine/scroll-sync.ts`:

```ts
export const COMFORT_INSET_PX = 32;

export interface Span {
  start: number;
  end: number;
}

export interface ScrollWindow {
  offset: number;
  height: number;
}

export function comfortBand(win: ScrollWindow): Span {
  return { start: win.offset + COMFORT_INSET_PX, end: win.offset + win.height - COMFORT_INSET_PX };
}

export function revealAlign(row: Span, win: ScrollWindow): "none" | "auto" | "center" {
  const band = comfortBand(win);
  if (row.start >= band.start && row.end <= band.end) return "none";
  const far = row.start < win.offset - win.height || row.start > win.offset + 2 * win.height;
  return far ? "center" : "auto";
}

export interface PushCandidate {
  index: number;
  start: number;
  end: number;
  /** Rows the playhead may land on (steps, chapters, groups); separators are not targets. */
  target: boolean;
}

export function pushTarget(playhead: Span | null, candidates: readonly PushCandidate[], win: ScrollWindow): number | null {
  if (playhead === null) return null;
  const band = comfortBand(win);
  const inside = candidates.filter((row) => row.target && row.start >= band.start && row.end <= band.end);
  if (inside.length === 0) return null;
  if (playhead.start < band.start) return inside[0]?.index ?? null;
  if (playhead.end > band.end) return inside[inside.length - 1]?.index ?? null;
  return null;
}

export function spineVirtualOptions(follow: boolean): {
  anchorTo: "end";
  followOnAppend: "auto" | false;
  scrollEndThreshold: 24;
  overscan: 10;
} {
  return { anchorTo: "end", followOnAppend: follow ? "auto" : false, scrollEndThreshold: 24, overscan: 10 };
}

export function extendRange(base: readonly number[], extra: readonly number[], count: number): number[] {
  const set = new Set(base);
  for (const value of extra) if (value >= 0 && value < count) set.add(value);
  return [...set].sort((a, b) => a - b);
}
```

- [ ] **Step 4: Run the pure test to see it pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/hybrid/spine/scroll-sync.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the failing component test**

Create `packages/trace-viewer/src/ui/views/hybrid/spine/spine.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { foldRows } from "../../../../model/index.js";
import { TraceBuilder, testMeta } from "../../../../test-support/trace-builder.js";
import {
  applyOpenDefaults,
  foldFixture,
  renderHarness,
  stubLayout,
  type LayoutStub,
} from "../../../../test-support/ui-harness.js";
import { FindingBodyContext, Spine, type SpineApi } from "./Spine.js";

let layout: LayoutStub | null = null;
afterEach(() => {
  cleanup();
  layout?.restore();
  layout = null;
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

function renderSpine(session = foldFixture("oauth"), options: Parameters<typeof renderHarness>[2] = {}) {
  const apiRef: { current: SpineApi | null } = { current: null };
  const h = renderHarness(
    <FindingBodyContext.Provider value={() => <p>finding body</p>}>
      <Spine active apiRef={apiRef} />
    </FindingBodyContext.Provider>,
    session,
    options,
  );
  return { h, apiRef, session };
}

function article(key: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[role="feed"] article[data-key="${key}"]`);
}

describe("Spine", () => {
  it("renders a feed of positioned articles", async () => {
    layout = stubLayout({ height: 2_000 });
    const { apiRef } = renderSpine();
    await settle();
    const feed = screen.getByRole("feed", { name: "Reading spine" });
    const articles = Array.from(feed.querySelectorAll("article"));
    expect(articles.length).toBe(apiRef.current?.rows().length);
    expect(articles[0]?.getAttribute("aria-posinset")).toBe("1");
    expect(articles[0]?.getAttribute("aria-setsize")).toBe(String(articles.length));
  });

  it("shows oauth's test row with TestDots and 14/15, and the expanded claim at +0:43", async () => {
    layout = stubLayout({ height: 2_000 });
    const session = foldFixture("oauth");
    const { h } = renderSpine(session);
    act(() => applyOpenDefaults(h, session));
    await settle();
    const test = session.steps.find((step) => step.command?.command === "pnpm test");
    expect(article(test?.id ?? "")?.textContent).toContain("14/15");
    const claim = session.findings.find((finding) => finding.ruleId === "claim_contradicted");
    const row = article(claim?.anchorStepId ?? "");
    expect(row?.textContent).toContain("+0:43");
    expect(row?.textContent).toContain("Claim contradicts tests");
    expect(row?.querySelector("[data-expanded]")).not.toBeNull();
    expect(row?.textContent).toContain("finding body");
  });

  it("never scrolls for a spine-origin playhead write and reveals for an overview write", async () => {
    const stub = stubLayout({ height: 200 });
    layout = stub;
    const session = foldFixture("oauth");
    const { h } = renderSpine(session);
    await settle();
    stub.scrollCalls.length = 0;
    const last = session.steps.at(-1)?.firstSeq ?? 1;
    act(() => h.store.dispatch({ type: "playhead/set", playhead: { kind: "free", seq: last }, origin: "spine" }));
    await settle();
    expect(stub.scrollCalls).toHaveLength(0);
    act(() => h.store.dispatch({ type: "playhead/set", playhead: { kind: "free", seq: last }, origin: "overview" }));
    await settle();
    expect(stub.scrollCalls.length).toBeGreaterThan(0);
  });

  it("selects a clicked row without scrolling", async () => {
    const stub = stubLayout({ height: 2_000 });
    layout = stub;
    const session = foldFixture("oauth");
    const { h } = renderSpine(session);
    await settle();
    stub.scrollCalls.length = 0;
    const target = session.steps.find((step) => step.kind === "edit");
    fireEvent.click(article(target?.id ?? "")?.firstElementChild as HTMLElement);
    await settle();
    expect(h.store.get().selection).toBe(target?.id);
    expect(stub.scrollCalls).toHaveLength(0);
  });

  it("keeps the live footer outside the list", async () => {
    layout = stubLayout({ height: 2_000 });
    const session = foldFixture("oauth");
    renderSpine({ ...session, live: true }, { terminal: false, nowT: 49_000 });
    await settle();
    const footer = screen.getByText(/^Agent running · last event/);
    expect(screen.getByRole("feed").contains(footer)).toBe(false);
  });

  it("renders a bidi override in a command as the escape token", async () => {
    layout = stubLayout({ height: 2_000 });
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Clean up" });
    b.agent({ type: "command_started", command: "echo \u202Etxt.exe" });
    b.agent({ type: "command_completed", command: "echo \u202Etxt.exe", exitCode: 0, stdout: "", stderr: "" });
    b.agent({ type: "agent_completed" });
    renderSpine(foldRows(testMeta(), b.rows, { live: false }));
    await settle();
    const feed = screen.getByRole("feed");
    expect(feed.textContent).toContain("⟨U+202E⟩");
    expect(feed.textContent).not.toContain("\u202E");
  });

  it("reads exit -1 as unknown on a neutral node", async () => {
    layout = stubLayout({ height: 2_000 });
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Lint" });
    b.agent({ type: "command_started", command: "pnpm lint" });
    b.agent({ type: "command_completed", command: "pnpm lint", exitCode: -1, stdout: "", stderr: "" });
    b.agent({ type: "agent_completed" });
    const session = foldRows(testMeta(), b.rows, { live: false });
    renderSpine(session);
    await settle();
    const command = session.steps.find((step) => step.kind === "command");
    const row = article(command?.id ?? "");
    expect(row?.textContent).toContain("exit unknown");
    expect(row?.querySelector('[data-tone="bad"], [data-tone="critical"]')).toBeNull();
  });
});
```

- [ ] **Step 6: Run it to see it fail**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/hybrid/spine/spine.test.tsx`
Expected: FAIL with `Failed to resolve import "./Spine.js"`.

- [ ] **Step 7: Write the CSS**

Create `packages/trace-viewer/src/ui/views/hybrid/spine/Spine.module.css`:

```css
.spine {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  background: var(--tv-panel);
}

.chip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 24px 4px;
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-ink-2);
}

.chipBar {
  width: 24px;
  height: 4px;
  border-radius: 2px;
  background: var(--tv-accent);
}

.scroll {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: auto;
  outline: none;
}

.sizer {
  position: relative;
  width: 100%;
}

.slot {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  outline: none;
}

.slot:focus-visible .row,
.slot:focus-visible .group {
  box-shadow: inset 0 0 0 2px var(--tv-accent);
}

.row {
  display: grid;
  grid-template-columns: 52px 24px 120px minmax(0, 1fr) auto;
  align-items: center;
  column-gap: 12px;
  min-height: 32px;
  padding: 0 24px 0 16px;
  font-size: 13px;
  line-height: 18px;
  color: var(--tv-ink);
  cursor: default;
}

.row[data-hour] {
  grid-template-columns: 60px 24px 120px minmax(0, 1fr) auto;
}

.row[data-selected] {
  background: var(--tv-accent-soft);
}

.row[data-match] .line {
  text-decoration: underline;
  text-decoration-color: var(--tv-accent);
  text-underline-offset: 3px;
}

.time {
  justify-self: end;
  padding: 0 4px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-ink-3);
}

.time[data-playhead] {
  background: var(--tv-accent-ink);
  color: var(--tv-panel);
}

.node {
  position: relative;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--tv-panel);
  color: var(--tv-ink-2);
  box-shadow: inset 0 0 0 1px var(--tv-hair);
}

.node::before {
  content: "";
  position: absolute;
  top: -8px;
  bottom: -8px;
  left: 11px;
  z-index: -1;
  width: 2px;
  background: var(--tv-fill-2);
}

.node[data-tone="bad"] {
  background: var(--tv-bad-soft);
  color: var(--tv-bad);
}

.node[data-tone="critical"] {
  background: var(--tv-bad);
  color: var(--tv-panel);
  box-shadow: none;
}

.nodeX {
  position: absolute;
  right: -4px;
  bottom: -4px;
  font-size: 12px;
  line-height: 12px;
  color: var(--tv-ink);
}

.graphic {
  display: flex;
  align-items: center;
  min-width: 0;
  overflow: hidden;
}

.line {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.message {
  color: var(--tv-ink-2);
}

.thinking {
  color: var(--tv-ink-3);
}

.findingTitle {
  font-size: 15px;
  line-height: 20px;
  font-weight: 600;
}

.mono {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12px;
}

.metric {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-ink-3);
  white-space: nowrap;
}

.metric[data-tone="bad"] {
  color: var(--tv-bad-ink);
}

.chevron {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--tv-ink-2);
  cursor: pointer;
}

.body {
  padding: 4px 24px 12px 164px;
}

.separator {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 24px;
  padding: 0 24px 0 80px;
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-ink-3);
}

.group {
  display: grid;
  grid-template-columns: 52px 24px 120px minmax(0, 1fr) auto;
  align-items: center;
  column-gap: 12px;
  min-height: 32px;
  padding: 0 24px 0 16px;
  font-size: 13px;
  line-height: 18px;
  color: var(--tv-ink-3);
  cursor: pointer;
}

.laneBar {
  display: flex;
  width: 120px;
  height: 6px;
  overflow: hidden;
  border-radius: 3px;
  background: var(--tv-fill);
}

.laneSegment {
  height: 6px;
  background: var(--tv-mark);
  box-shadow: inset -1px 0 0 var(--tv-panel);
}

.empty {
  margin: 0;
  padding: 24px;
  font-size: 13px;
  line-height: 18px;
  color: var(--tv-ink-3);
}

.placeholder {
  height: 12px;
  margin: 10px 24px 10px 92px;
  border-radius: 4px;
  background: var(--tv-fill-2);
}

.badge {
  position: absolute;
  bottom: 40px;
  left: 50%;
  z-index: 2;
  transform: translateX(-50%);
}

.footer {
  margin: 0;
  padding: 8px 24px;
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-ink-3);
  box-shadow: inset 0 1px 0 var(--tv-hair);
}

.findingBody {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.findingText {
  margin: 0;
  font-size: 13px;
  line-height: 18px;
  color: var(--tv-ink);
}

.chain {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-ink-3);
}

.chainIconBad {
  color: var(--tv-bad);
}

.chainLine {
  width: 48px;
  height: 1px;
  background: var(--tv-ink-4);
}

.failures {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.failure {
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--tv-fill);
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-ink);
}

.why {
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-ink-2);
}

.steps {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  line-height: 16px;
  color: var(--tv-ink-2);
}
```

- [ ] **Step 8: Implement the row components**

Create `packages/trace-viewer/src/ui/views/hybrid/spine/rows/SeparatorRows.tsx`:

```tsx
import type { SpineRow } from "../../../../../layout/spine-rows.js";
import { formatDuration, formatOffset, type TraceSession } from "../../../../../model/index.js";
import styles from "../Spine.module.css";

const GAP_TEXT: Record<string, string> = {
  invalid_row: "could not be read",
  unknown_row_type: "has an unknown type",
  out_of_order: "arrived out of order",
  unpaired: "has no completion",
  missing_evidence: "has no evidence",
};

export function SeparatorRow({ row, session }: { row: Extract<SpineRow, { t: "turn" | "idle" | "gap" }>; session: TraceSession }) {
  if (row.t === "turn") {
    const turn = session.turns[row.turn];
    return (
      <div className={styles.separator}>
        {turn === undefined ? "Turn" : `Turn ${turn.index + 1} · ${turn.trigger} · ${formatOffset(turn.tMs)}`}
      </div>
    );
  }
  if (row.t === "idle") {
    return (
      <div className={styles.separator}>
        {`⋯ ${formatDuration(row.ms)} · ${row.reason === "awaiting_supervisor" ? "waiting for supervisor" : "agent quiet"}`}
      </div>
    );
  }
  const gap = session.gaps[row.gap];
  return (
    <div className={styles.separator}>
      {gap === undefined ? "A row is missing" : `1 row ${GAP_TEXT[gap.kind] ?? "is missing"} · seq ${gap.atSeq}`}
    </div>
  );
}
```

Create `packages/trace-viewer/src/ui/views/hybrid/spine/rows/GroupRows.tsx`:

```tsx
import type { SpineRow } from "../../../../../layout/spine-rows.js";
import { describeGraphic, formatDuration, formatOffset, LANES, pickGraphic, type TraceSession } from "../../../../../model/index.js";
import { Graphic } from "../../../../graphics/Graphic.js";
import { Icon } from "../../../../icons/Icon.js";
import { CATEGORY_ICON, LANE_LABEL } from "../../../../icons/kind-icons.js";
import styles from "../Spine.module.css";

export function GroupRow({
  row,
  session,
  onActivate,
}: {
  row: Extract<SpineRow, { t: "chapter" | "noise" | "elided" }>;
  session: TraceSession;
  onActivate(): void;
}) {
  if (row.t === "chapter") {
    const chapter = session.chapters[row.chapter];
    if (chapter === undefined) return <div className={styles.group} />;
    const graphic = pickGraphic(chapter, session);
    return (
      <div className={styles.group} onClick={onActivate}>
        <span className={styles.time}>{formatOffset(chapter.tMs)}</span>
        <span className={styles.node}>
          <Icon name={CATEGORY_ICON[chapter.category]} size={14} />
        </span>
        <span className={styles.graphic}>
          {graphic === null ? null : <Graphic spec={graphic} size="xs" label={describeGraphic(graphic)} />}
        </span>
        <span className={styles.line}>{chapter.title}</span>
        <span className={styles.metric}>
          {`${formatDuration(chapter.endTMs - chapter.tMs)} · ${chapter.stepIds.length} steps`}
          {chapter.findingIds.length > 0 ? <Icon name="flag" size={12} title={`${chapter.findingIds.length} findings`} /> : null}
        </span>
      </div>
    );
  }
  const first = session.steps[row.steps[0] ?? -1];
  if (row.t === "noise") {
    return (
      <div className={styles.group} onClick={onActivate} data-noise="">
        <span className={styles.time}>{first === undefined ? "" : formatOffset(first.tMs)}</span>
        <span className={styles.node}>
          <Icon name="eyeoff" size={14} />
        </span>
        <span className={styles.graphic} />
        <span className={styles.line}>{row.label}</span>
        <span className={styles.metric}>
          <Icon name="chev-r" size={12} />
        </span>
      </div>
    );
  }
  const total = row.steps.length;
  const parts = [`${total} steps`];
  if (row.byLane.edits > 0) parts.push(`${row.byLane.edits} edits`);
  if (row.byLane.commands > 0) parts.push(`${row.byLane.commands} commands`);
  parts.push(formatDuration(row.spanMs));
  return (
    <div className={styles.group} onClick={onActivate} data-elided="">
      <span className={styles.time}>{first === undefined ? "" : formatOffset(first.tMs)}</span>
      <span className={styles.node}>
        <Icon name="stack" size={14} />
      </span>
      <span className={styles.laneBar} aria-hidden="true">
        {LANES.map((lane) =>
          row.byLane[lane] > 0 ? (
            <span
              key={lane}
              className={styles.laneSegment}
              title={LANE_LABEL[lane]}
              style={{ width: `${(row.byLane[lane] / Math.max(1, total)) * 100}%` }}
            />
          ) : null,
        )}
      </span>
      <span className={styles.line}>{parts.join(" · ")}</span>
      <span className={styles.metric}>
        <Icon name="chev-r" size={12} />
      </span>
    </div>
  );
}
```

Create `packages/trace-viewer/src/ui/views/hybrid/spine/rows/StepRow.tsx`:

```tsx
import type { ComponentType } from "react";

import type { TraceIndex } from "../../../../../layout/trace-index.js";
import { stepTone } from "../../../../../layout/tone.js";
import {
  describeGraphic,
  displayUntrusted,
  exitLabel,
  formatDuration,
  formatOffset,
  normalizeCommand,
  pickGraphic,
  truncateMiddle,
  type Finding,
  type FindingId,
  type GraphicSpec,
  type Step,
  type StepId,
  type StepKind,
  type TraceSession,
} from "../../../../../model/index.js";
import { FINDING_TITLE, topFindingOf } from "../../../../inspector/finding-copy.js";
import { Graphic } from "../../../../graphics/Graphic.js";
import { Icon } from "../../../../icons/Icon.js";
import { KIND_ICON, SIGNAL_ICON } from "../../../../icons/kind-icons.js";
import type { FindingBodyProps } from "../Spine.js";
import styles from "../Spine.module.css";

/** Spec §7.6.3 ROW_GRAPHIC: which kinds show a graphic in the 120 px slot. */
const ROW_GRAPHIC: { readonly [K in StepKind]: GraphicSpec["kind"] | null } = {
  instruction: null,
  message: null,
  reasoning: null,
  lifecycle: null,
  read: null,
  approval: null,
  guardrail: null,
  attention: null,
  command: "duration",
  tool: "duration",
  check: "duration",
  test: "tests",
  edit: "diff",
  dependency: "diff",
  revert: "diff",
  decision: "fork",
};

export interface StepRowProps {
  step: Step;
  session: TraceSession;
  index: TraceIndex;
  findingsById: ReadonlyMap<FindingId, Finding>;
  expanded: boolean;
  selected: boolean;
  playhead: boolean;
  matched: boolean;
  hourGutter: boolean;
  FindingBody: ComponentType<FindingBodyProps> | null;
  onSelect(): void;
  onToggle(): void;
  onJump(stepId: StepId): void;
}

function lineOf(step: Step): { text: string; mono: boolean; className?: string } {
  if (step.command !== undefined) return { text: displayUntrusted(normalizeCommand(step.command.command)), mono: true };
  if (step.edit !== undefined) return { text: truncateMiddle(displayUntrusted(step.edit.path), 64), mono: true };
  if (step.decision !== undefined) return { text: step.decision.title, mono: false };
  if (step.kind === "reasoning") return { text: `Thinking ${(step.text ?? "").split("\n")[0] ?? ""}`, mono: false, className: "thinking" };
  if (step.kind === "message") return { text: (step.text ?? step.headline).split("\n")[0] ?? "", mono: false, className: "message" };
  if (step.kind === "instruction") return { text: (step.text ?? step.headline).split("\n")[0] ?? "", mono: false };
  return { text: displayUntrusted(step.headline), mono: false };
}

function metricOf(step: Step): string {
  if (step.tests !== undefined) {
    const total = step.tests.passed + step.tests.failed + step.tests.skipped;
    return `${step.tests.passed}/${total}${step.durationMs === null ? "" : ` · ${formatDuration(step.durationMs)}`}`;
  }
  if (step.edit !== undefined) return `+${step.edit.added} −${step.edit.removed}`;
  if (step.command !== undefined) {
    const exit = step.command.exitCode;
    if (exit !== null && exit !== 0) return exitLabel(exit);
    return formatDuration(step.durationMs);
  }
  if (step.guardrail !== undefined) return step.guardrail.clampIds.join(", ");
  return "";
}

export function StepRow(props: StepRowProps) {
  const { step, session, findingsById, expanded, selected, playhead, matched, hourGutter, FindingBody } = props;
  const finding = topFindingOf(session, step);
  const critical = finding?.severity === "critical";
  const tone = stepTone(step, findingsById);
  const graphicKind = ROW_GRAPHIC[step.kind];
  const picked = graphicKind === null ? null : pickGraphic(step, session);
  const graphic = picked !== null && picked.kind === graphicKind ? picked : null;
  const exitX = step.command !== undefined && step.command.exitCode !== null && step.command.exitCode > 0 && step.kind === "command";
  const line = lineOf(step);
  return (
    <>
      <div
        className={styles.row}
        data-selected={selected ? "" : undefined}
        data-match={matched ? "" : undefined}
        data-hour={hourGutter ? "" : undefined}
        data-expanded={expanded ? "" : undefined}
        onClick={props.onSelect}
      >
        <span className={styles.time} data-playhead={playhead ? "" : undefined}>
          {formatOffset(step.tMs)}
        </span>
        <span className={styles.node} data-tone={critical ? "critical" : tone === "bad" ? "bad" : "neutral"}>
          <Icon name={KIND_ICON[step.kind]} size={14} />
          {exitX ? (
            <span className={styles.nodeX} aria-hidden="true">
              ✕
            </span>
          ) : null}
        </span>
        <span className={styles.graphic}>
          {graphic === null ? null : <Graphic spec={graphic} size="xs" label={describeGraphic(graphic)} />}
        </span>
        {finding === null ? (
          <span className={`${styles.line} ${line.mono ? styles.mono : ""} ${line.className === undefined ? "" : styles[line.className] ?? ""}`}>
            {line.text}
          </span>
        ) : (
          <span className={`${styles.line} ${critical ? styles.findingTitle : ""}`}>{FINDING_TITLE[finding.ruleId]}</span>
        )}
        <span className={styles.metric} data-tone={tone === "bad" ? "bad" : "neutral"}>
          {metricOf(step)}
          {finding !== null && !critical ? <Icon name={SIGNAL_ICON[finding.ruleId]} size={12} title={FINDING_TITLE[finding.ruleId]} /> : null}
          {finding === null ? null : (
            <button
              type="button"
              tabIndex={-1}
              className={styles.chevron}
              aria-expanded={expanded}
              aria-label={expanded ? "Collapse finding" : "Expand finding"}
              onClick={(event) => {
                event.stopPropagation();
                props.onToggle();
              }}
            >
              <Icon name={expanded ? "chev-d" : "chev-r"} size={12} />
            </button>
          )}
        </span>
      </div>
      {expanded && finding !== null && FindingBody !== null ? (
        <div className={styles.body}>
          <FindingBody finding={finding} step={step} session={session} onJump={props.onJump} />
        </div>
      ) : null}
    </>
  );
}
```

- [ ] **Step 9: Implement the Spine**

Create `packages/trace-viewer/src/ui/views/hybrid/spine/Spine.tsx`:

```tsx
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, type ComponentType } from "react";

import {
  buildSpineRows,
  estimateSpineRowSize,
  SPINE_ROW_PX,
  spineRowIndexForSeq,
  type SpineRow,
} from "../../../../layout/spine-rows.js";
import { brushSeqRange } from "../../../../layout/trace-index.js";
import {
  formatDuration,
  formatOffset,
  type Finding,
  type FindingId,
  type Step,
  type StepId,
  type TraceSession,
} from "../../../../model/index.js";
import { topFindingOf } from "../../../inspector/finding-copy.js";
import { markAfterPaint, PERF } from "../../../shell/perf.js";
import { useDiagnostics, useSessionView } from "../../../shell/session-context.js";
import { useDispatch, useView, useViewStore } from "../../../state/store.js";
import { selectEffectivePlayheadSeq, selectNewCount } from "../../../state/view-state.js";
import { NewBadge } from "../../shared/NewBadge.js";
import { GroupRow } from "./rows/GroupRows.js";
import { SeparatorRow } from "./rows/SeparatorRows.js";
import { StepRow } from "./rows/StepRow.js";
import { extendRange, pushTarget, revealAlign, spineVirtualOptions, type PushCandidate } from "./scroll-sync.js";
import styles from "./Spine.module.css";

export interface FindingBodyProps {
  finding: Finding;
  step: Step;
  session: TraceSession;
  onJump(stepId: StepId): void;
}

export const FindingBodyContext = createContext<ComponentType<FindingBodyProps> | null>(null);

export interface SpineApi {
  rows(): readonly SpineRow[];
  revealSeq(seq: number, align: "auto" | "center"): void;
  focusRow(key: string): void;
}

export interface SpineProps {
  active: boolean;
  apiRef: { current: SpineApi | null };
  onWindow?(window: { t0: number; t1: number } | null): void;
  onAnchor?(anchor: { key: string; offsetPx: number } | null): void;
}

function virtualKey(row: SpineRow | undefined, position: number): string | number {
  if (row === undefined) return position;
  return row.t === "step" && row.expanded ? `${row.key}+x` : row.key;
}

function rowT(row: SpineRow | undefined, session: TraceSession): number | null {
  if (row === undefined) return null;
  switch (row.t) {
    case "step":
      return session.steps[row.step]?.tMs ?? null;
    case "chapter":
      return session.chapters[row.chapter]?.tMs ?? null;
    case "noise":
    case "elided":
      return session.steps[row.steps[0] ?? -1]?.tMs ?? null;
    case "turn":
      return session.turns[row.turn]?.tMs ?? null;
    default:
      return null;
  }
}

function rowSeq(row: SpineRow | undefined, session: TraceSession): number | null {
  if (row === undefined) return null;
  switch (row.t) {
    case "step":
      return session.steps[row.step]?.firstSeq ?? null;
    case "chapter": {
      const chapter = session.chapters[row.chapter];
      const first = chapter?.stepIds[0];
      return session.steps.find((step) => step.id === first)?.firstSeq ?? chapter?.firstSeq ?? null;
    }
    case "noise":
    case "elided":
      return session.steps[row.steps[0] ?? -1]?.firstSeq ?? null;
    default:
      return null;
  }
}

export function Spine({ active, apiRef, onWindow, onAnchor }: SpineProps) {
  const { session, index, scale, terminal, loadedFraction, nowT } = useSessionView();
  const store = useViewStore();
  const dispatch = useDispatch();
  const diagnostics = useDiagnostics();
  const FindingBody = useContext(FindingBodyContext);
  const brush = useView((state) => state.brush);
  const level = useView((state) => state.level);
  const selection = useView((state) => state.selection);
  const expanded = useView((state) => state.expanded);
  const collapsed = useView((state) => state.collapsed);
  const search = useView((state) => state.search);
  const follow = useView((state) => state.follow);
  const focusRev = useView((state) => state.focusRev);
  const origin = useView((state) => state.playheadOrigin);
  const lastSeenSeq = useView((state) => state.lastSeenSeq);
  const playheadSeq = useView((state) => selectEffectivePlayheadSeq(state, index));
  const newCount = useView((state) => selectNewCount(state, index));

  const matches = useMemo(() => (search === null ? undefined : new Set<string>(search.matchIds)), [search]);
  const rows = useMemo<SpineRow[]>(
    () =>
      session === null
        ? []
        : buildSpineRows(session, index, scale, {
            brush,
            level,
            playheadSeq,
            selection,
            expanded,
            collapsed,
            matches,
            live: !terminal,
          }),
    [session, index, scale, brush, level, playheadSeq, selection, expanded, collapsed, matches, terminal],
  );
  const findingsById = useMemo(
    () => new Map<FindingId, Finding>((session?.findings ?? []).map((finding) => [finding.id, finding])),
    [session],
  );
  const playheadIndex = useMemo(
    () => (session === null ? -1 : spineRowIndexForSeq(rows, session, playheadSeq)),
    [rows, session, playheadSeq],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const focusKey = useRef<string | null>(null);
  const extras = useRef<number[]>([]);
  extras.current = [playheadIndex, rows.findIndex((row) => row.key === focusKey.current)];
  const suppressPush = useRef(false);
  const ownRev = useRef(-1);
  const frame = useRef<number | null>(null);
  const anchor = useRef<{ key: string; top: number } | null>(null);
  const handlers = useRef({ onWindow, onAnchor });
  handlers.current = { onWindow, onAnchor };

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (position) => {
      const row = rowsRef.current[position];
      return row === undefined || session === null ? SPINE_ROW_PX : estimateSpineRowSize(row, session);
    },
    getItemKey: (position) => virtualKey(rowsRef.current[position], position),
    rangeExtractor: (range) => extendRange(defaultRangeExtractor(range), extras.current, range.count),
    onChange: (instance) => {
      if (frame.current !== null) return;
      const scrolling = instance.isScrolling;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        onScrollFrame(scrolling);
      });
    },
    ...spineVirtualOptions(follow),
  });

  function onScrollFrame(userScrolling: boolean): void {
    const element = scrollRef.current;
    if (element === null || session === null) return;
    const win = { offset: element.scrollTop, height: element.clientHeight };
    const items = virtualizer.getVirtualItems();
    const visible = items.filter((item) => item.end > win.offset && item.start < win.offset + win.height);
    const first = visible[0];
    const last = visible[visible.length - 1];
    const t0 = rowT(rowsRef.current[first?.index ?? -1], session);
    const t1 = rowT(rowsRef.current[last?.index ?? -1], session);
    handlers.current.onWindow?.(t0 === null || t1 === null ? null : { t0, t1 });
    const firstRow = rowsRef.current[first?.index ?? -1];
    if (first !== undefined && firstRow !== undefined) {
      anchor.current = { key: firstRow.key, top: first.start - win.offset };
      handlers.current.onAnchor?.({ key: firstRow.key, offsetPx: first.start - win.offset });
    }
    if (suppressPush.current) {
      if (!userScrolling) suppressPush.current = false;
      return;
    }
    if (!userScrolling) return;
    const playItem = items.find((item) => item.index === playheadIndex);
    const candidates: PushCandidate[] = visible.map((item) => ({
      index: item.index,
      start: item.start,
      end: item.end,
      target: rowSeq(rowsRef.current[item.index], session) !== null,
    }));
    const target = pushTarget(playItem === undefined ? null : { start: playItem.start, end: playItem.end }, candidates, win);
    const seq = target === null ? null : rowSeq(rowsRef.current[target], session);
    if (seq !== null) dispatch({ type: "playhead/set", playhead: { kind: "free", seq }, origin: "spine" });
  }

  const revealIndex = (position: number, align: "auto" | "center"): void => {
    const element = scrollRef.current;
    const item = virtualizer.measurementsCache[position];
    if (element === null || item === undefined) return;
    const decided = align === "center" ? "center" : revealAlign({ start: item.start, end: item.end }, { offset: element.scrollTop, height: element.clientHeight });
    if (decided === "none") return;
    suppressPush.current = true;
    virtualizer.scrollToIndex(position, { align: decided, behavior: "auto" });
  };

  // External playhead writes reveal the playhead row; the spine's own clicks and pushes never scroll.
  useLayoutEffect(() => {
    if (!active || playheadIndex < 0 || origin === "spine" || focusRev === ownRev.current) return;
    revealIndex(playheadIndex, "auto");
  }, [playheadIndex, origin, focusRev, active]);

  // A brush or level change replaces the row set: reveal the playhead row centered.
  const setKey = `${level}|${brush.kind}|${brush.kind === "chapter" ? brush.anchorSeq : brush.kind === "range" ? `${brush.fromSeq}-${brush.toSeq}` : ""}`;
  const lastSetKey = useRef(setKey);
  useLayoutEffect(() => {
    if (lastSetKey.current === setKey) return;
    lastSetKey.current = setKey;
    if (active && playheadIndex >= 0) revealIndex(playheadIndex, "center");
  }, [setKey, active, playheadIndex]);

  // Restore the saved spine anchor when the view is shown again in sync (spec §7.8 item 4).
  useLayoutEffect(() => {
    if (!active) return;
    const state = store.get();
    const saved = state.cameras.hybrid;
    if (saved?.spineAnchor == null || saved.syncedRev !== state.focusRev) return;
    const position = rowsRef.current.findIndex((row) => row.key === saved.spineAnchor?.key);
    const item = virtualizer.measurementsCache[position];
    if (item === undefined) return;
    suppressPush.current = true;
    virtualizer.scrollToOffset(Math.max(0, item.start - saved.spineAnchor.offsetPx), { behavior: "auto" });
  }, [active]);

  // Selftest: anchored-row drift after each applied row set (spec §10 "Anchor drift").
  useLayoutEffect(() => {
    if (!diagnostics.enabled) return undefined;
    const before = anchor.current;
    const element = scrollRef.current;
    if (before === null || element === null) return undefined;
    const id = requestAnimationFrame(() => {
      const node = Array.from(element.querySelectorAll<HTMLElement>("[data-key]")).find((item) => item.dataset.key === before.key);
      if (node === undefined) return;
      const top = node.getBoundingClientRect().top - element.getBoundingClientRect().top;
      diagnostics.reportDrift(Math.abs(top - before.top));
      anchor.current = { key: before.key, top };
    });
    return () => cancelAnimationFrame(id);
  }, [rows, diagnostics]);

  const painted = useRef(false);
  useEffect(() => {
    if (painted.current || rows.length === 0) return;
    painted.current = true;
    markAfterPaint(PERF.firstPaint, PERF.bundleParsed);
  }, [rows.length]);

  useLayoutEffect(() => {
    apiRef.current = {
      rows: () => rowsRef.current,
      revealSeq: (seq, align) => {
        if (session === null) return;
        const position = spineRowIndexForSeq(rowsRef.current, session, seq);
        if (position >= 0) revealIndex(position, align);
      },
      focusRow: (key) => {
        focusKey.current = key;
        const node = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>("article[data-key]") ?? []).find(
          (item) => item.dataset.key === key,
        );
        node?.focus({ preventScroll: true });
      },
    };
    return () => {
      apiRef.current = null;
    };
  });

  const selectRow = (id: string): void => {
    dispatch({ type: "select", id: id as StepId, by: "hybrid" });
    ownRev.current = store.get().focusRev;
  };

  const toggleFinding = (step: Step, isExpanded: boolean): void => {
    if (session === null) return;
    const finding = topFindingOf(session, step);
    if (isExpanded) {
      dispatch({ type: "expand/set", key: step.id, expanded: false });
      if (finding !== null) dispatch({ type: "expand/set", key: finding.id, expanded: false });
    } else {
      dispatch({ type: "expand/set", key: step.id, expanded: true });
    }
  };

  const jump = (stepId: StepId): void => {
    const step = session?.steps.find((item) => item.id === stepId);
    if (step !== undefined) dispatch({ type: "playhead/set", playhead: { kind: "free", seq: step.firstSeq }, origin: "finding" });
  };

  if (session === null) {
    return (
      <div className={styles.spine}>
        <div aria-hidden="true">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((n) => (
            <div key={n} className={styles.placeholder} />
          ))}
        </div>
      </div>
    );
  }

  const range = brushSeqRange(brush, index);
  const rangeFrom = session.steps[Math.max(0, index.stepIndexAtOrAfter(range.fromSeq))]?.tMs ?? 0;
  const rangeTo = session.steps[Math.max(0, index.stepIndexAtOrBefore(range.toSeq))]?.tMs ?? rangeFrom;
  const hourGutter = (session.steps.at(-1)?.tMs ?? 0) >= 3_600_000;
  const tabKey =
    rows.find((row) => row.key === selection)?.key ?? rows[playheadIndex]?.key ?? rows[0]?.key ?? null;
  const newProblems = session.findings.filter((finding) => finding.severity === "critical" && finding.anchorSeq > lastSeenSeq).length;
  const afterRange = brush.kind !== "session" && !(brush.kind === "range" && brush.toSeq === "live");
  const lastEventT = session.steps.at(-1)?.tMs ?? 0;

  let empty: string | null = null;
  if (rows.length === 0) {
    if (session.steps.length === 0 && session.loadedThroughSeq === 0) empty = "Waiting for the agent's first event";
    else if (session.steps.length === 0) empty = `${session.loadedThroughSeq.toLocaleString("en-US")} events, none describe agent work`;
    else empty = `Nothing between ${formatOffset(rangeFrom)} and ${formatOffset(rangeTo)}`;
  }

  return (
    <div className={styles.spine}>
      <div className={styles.chip}>
        <span className={styles.chipBar} aria-hidden="true" />
        <span>{`${formatOffset(rangeFrom)} – ${formatOffset(rangeTo)}`}</span>
      </div>
      {empty === null ? null : <p className={styles.empty}>{empty}</p>}
      <div
        ref={scrollRef}
        className={styles.scroll}
        data-scroll-root=""
        role="feed"
        aria-label="Reading spine"
        aria-busy={loadedFraction < 1}
      >
        <div className={styles.sizer} style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (row === undefined) return null;
            const measured = row.t === "step" && row.expanded;
            return (
              <article
                key={row.key}
                ref={measured ? virtualizer.measureElement : undefined}
                data-index={item.index}
                data-key={row.key}
                data-playhead={item.index === playheadIndex ? "" : undefined}
                aria-posinset={item.index + 1}
                aria-setsize={rows.length}
                tabIndex={row.key === tabKey ? 0 : -1}
                className={styles.slot}
                style={{ transform: `translateY(${item.start}px)`, height: measured ? undefined : item.size }}
                onFocus={() => {
                  focusKey.current = row.key;
                }}
              >
                {row.t === "step" ? (
                  (() => {
                    const step = session.steps[row.step];
                    if (step === undefined) return null;
                    return (
                      <StepRow
                        step={step}
                        session={session}
                        index={index}
                        findingsById={findingsById}
                        expanded={row.expanded}
                        selected={step.id === selection}
                        playhead={item.index === playheadIndex}
                        matched={matches?.has(step.id) ?? false}
                        hourGutter={hourGutter}
                        FindingBody={FindingBody}
                        onSelect={() => selectRow(step.id)}
                        onToggle={() => toggleFinding(step, row.expanded)}
                        onJump={jump}
                      />
                    );
                  })()
                ) : row.t === "turn" || row.t === "idle" || row.t === "gap" ? (
                  <SeparatorRow row={row} session={session} />
                ) : (
                  <GroupRow
                    row={row}
                    session={session}
                    onActivate={() => {
                      if (row.t === "chapter") {
                        const chapter = session.chapters[row.chapter];
                        if (chapter !== undefined) selectRow(chapter.id);
                      } else {
                        dispatch({ type: "expand/toggle", key: row.key });
                      }
                    }}
                  />
                )}
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
            afterRange={afterRange}
            onActivate={() => {
              dispatch({ type: "nav/last" });
              if (!terminal) dispatch({ type: "follow/set", follow: true });
            }}
          />
        )}
      </div>
      {terminal ? null : (
        <p className={styles.footer}>{`Agent running · last event ${formatDuration(Math.max(0, nowT() - lastEventT))} ago`}</p>
      )}
    </div>
  );
}
```

- [ ] **Step 10: Run the tests to see them pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/hybrid/spine`
Expected: PASS (scroll-sync 6, spine 7).

- [ ] **Step 11: Root checks**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint`
Expected: exit 0.

- [ ] **Step 12: Commit**

```bash
git add packages/trace-viewer/src/ui/views/hybrid/spine/scroll-sync.ts packages/trace-viewer/src/ui/views/hybrid/spine/scroll-sync.test.ts \
  packages/trace-viewer/src/ui/views/hybrid/spine/rows/StepRow.tsx packages/trace-viewer/src/ui/views/hybrid/spine/rows/SeparatorRows.tsx \
  packages/trace-viewer/src/ui/views/hybrid/spine/rows/GroupRows.tsx packages/trace-viewer/src/ui/views/hybrid/spine/Spine.tsx \
  packages/trace-viewer/src/ui/views/hybrid/spine/Spine.module.css packages/trace-viewer/src/ui/views/hybrid/spine/spine.test.tsx
git commit -m "feat(trace-viewer): add the virtualized reading spine with playhead sync"
```

---

### Task C2-13: Spine finding bodies (`FINDING_BODY`)

**Files:**
- Create: `packages/trace-viewer/src/ui/views/hybrid/spine/findings/FindingBody.tsx`
- Create: `packages/trace-viewer/src/ui/views/hybrid/spine/findings/ClaimFinding.tsx`
- Create: `packages/trace-viewer/src/ui/views/hybrid/spine/findings/TestsFinding.tsx`
- Create: `packages/trace-viewer/src/ui/views/hybrid/spine/findings/DestructiveFinding.tsx`
- Create: `packages/trace-viewer/src/ui/views/hybrid/spine/findings/GuardrailFinding.tsx`
- Create: `packages/trace-viewer/src/ui/views/hybrid/spine/findings/RecoveryFinding.tsx`
- Test: `packages/trace-viewer/src/ui/views/hybrid/spine/findings/findings.test.tsx`

**Interfaces:**
- Consumes: C2-12 `FindingBodyProps { finding; step; session; onJump(stepId) }` and the finding classes in `Spine.module.css` (`findingBody`, `findingText`, `chain`, `chainIconBad`, `chainLine`, `failures`, `failure`, `why`, `steps`, `mono`); C1a `ClaimVsObserved`, `Icon`, `KIND_ICON`; B `formatDuration`, `formatOffset`, `displayUntrusted`, `normalizeCommand`, `signalMeta(id): SignalMeta` (`rationale`, `knownFalsePositives`), `clampMeta(id)`, `SIGNAL_IDS`, `Finding` (`claim?: ClaimObservation`, `claimSpan?`, `evidenceStepIds?`, `matchedPattern?`, `clampId?`).
- Produces:

```ts
export const FINDING_BODY: { readonly [K in SignalId]: React.ComponentType<FindingBodyProps> };
export function FindingBody(props: FindingBodyProps): React.JSX.Element;
export function ClaimFinding(props: FindingBodyProps): React.JSX.Element;
export function TestsFinding(props: FindingBodyProps): React.JSX.Element;
export function DestructiveFinding(props: FindingBodyProps): React.JSX.Element;
export function GuardrailFinding(props: FindingBodyProps): React.JSX.Element;
export function RecoveryFinding(props: FindingBodyProps): React.JSX.Element;
```

Bodies (spec §7.6.3): `claim_contradicted` shows the chain `[test] —— [quote] 3.0 s` (claim `tMs` − (evidence `tMs` + `durationMs`)) and `ClaimVsObserved` with the span underlined; clicking the observed card calls `onJump(evidence step)`, which C2-12 turns into a `free` playhead with origin `finding`. `failing_tests` lists up to three failures and "N more"; `destructive_command` shows the command with the matched rule and a "Why flagged?" disclosure with the rule's known false positives; `guardrail_clamp` shows the clamp label and the reason; `recovery_arc` shows the fail → edit → pass chain with offsets.

- [ ] **Step 1: Write the failing test**

Create `packages/trace-viewer/src/ui/views/hybrid/spine/findings/findings.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { foldRows, SIGNAL_IDS, type Finding, type TraceSession } from "../../../../../model/index.js";
import { TraceBuilder, testMeta } from "../../../../../test-support/trace-builder.js";
import { foldFixture } from "../../../../../test-support/ui-harness.js";
import { FINDING_BODY, FindingBody } from "./FindingBody.js";

afterEach(() => {
  cleanup();
});

function stepOf(session: TraceSession, finding: Finding) {
  const step = session.steps.find((item) => item.id === finding.anchorStepId);
  if (step === undefined) throw new Error("finding has no anchor step");
  return step;
}

function synthetic(session: TraceSession, overrides: Partial<Finding> & Pick<Finding, "ruleId">): Finding {
  const step = session.steps[1] ?? session.steps[0];
  if (step === undefined) throw new Error("empty session");
  return {
    id: `finding:${overrides.ruleId}@1:${step.firstSeq}`,
    ruleVersion: 1,
    severity: "warning",
    anchorSeq: step.firstSeq,
    headline: "synthetic",
    reason: "Synthetic reason for the test.",
    stepIds: [step.id],
    chapterIds: [],
    evidenceSeqs: [],
    anchorStepId: step.id,
    ...overrides,
  };
}

describe("FINDING_BODY", () => {
  it("covers every signal", () => {
    expect(Object.keys(FINDING_BODY).sort()).toEqual([...SIGNAL_IDS].sort());
  });

  it("shows oauth's claim chain, the underlined span, and jumps to the evidence", () => {
    const session = foldFixture("oauth");
    const finding = session.findings.find((item) => item.ruleId === "claim_contradicted");
    expect(finding).toBeDefined();
    if (finding === undefined) return;
    const onJump = vi.fn();
    render(<FindingBody finding={finding} step={stepOf(session, finding)} session={session} onJump={onJump} />);
    expect(screen.getByText("3.0 s")).toBeTruthy();
    expect(screen.getAllByText("all checks pass").length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByText(/1 failed/)[0] as HTMLElement);
    const evidence = session.steps.find((step) => step.command?.command === "pnpm test");
    expect(onJump).toHaveBeenCalledWith(evidence?.id);
  });

  it("lists failing tests with their names", () => {
    const session = foldFixture("oauth");
    const finding = session.findings.find((item) => item.ruleId === "failing_tests");
    expect(finding).toBeDefined();
    if (finding === undefined) return;
    const failure = session.steps.find((step) => step.tests !== undefined)?.tests?.failures[0];
    render(<FindingBody finding={finding} step={stepOf(session, finding)} session={session} onJump={() => undefined} />);
    expect(screen.getByText(failure?.testName ?? "missing")).toBeTruthy();
  });

  it("explains a destructive command", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Clean" });
    b.agent({ type: "command_started", command: "rm -rf build" });
    b.agent({ type: "command_completed", command: "rm -rf build", exitCode: 0, stdout: "", stderr: "" });
    const session = foldRows(testMeta(), b.rows, { live: false });
    const step = session.steps.find((item) => item.kind === "command");
    const finding = synthetic(session, {
      ruleId: "destructive_command",
      severity: "critical",
      matchedPattern: "rm_rf",
      anchorStepId: step?.id ?? "step:1",
      stepIds: [step?.id ?? "step:1"],
    });
    render(<FindingBody finding={finding} step={step ?? session.steps[0]!} session={session} onJump={() => undefined} />);
    expect(screen.getByText("rm -rf build")).toBeTruthy();
    expect(screen.getByText("Matched rule: rm_rf")).toBeTruthy();
    expect(screen.getByText("Why flagged?")).toBeTruthy();
  });

  it("names the clamp of a guardrail finding and the steps of a recovery", () => {
    const session = foldFixture("oauth");
    const guard = synthetic(session, { ruleId: "guardrail_clamp", clampId: "destructive_command" });
    render(<FindingBody finding={guard} step={session.steps[1]!} session={session} onJump={() => undefined} />);
    expect(screen.getByText("Synthetic reason for the test.")).toBeTruthy();
    cleanup();

    const ids = session.steps.slice(0, 3).map((step) => step.id);
    const recovery = synthetic(session, { ruleId: "recovery_arc", severity: "info", stepIds: ids });
    render(<FindingBody finding={recovery} step={session.steps[0]!} session={session} onJump={() => undefined} />);
    expect(document.querySelectorAll("[data-recovery-step]")).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/hybrid/spine/findings/findings.test.tsx`
Expected: FAIL with `Failed to resolve import "./FindingBody.js"`.

- [ ] **Step 3: Implement the bodies**

Create `packages/trace-viewer/src/ui/views/hybrid/spine/findings/ClaimFinding.tsx`:

```tsx
import { displayUntrusted, formatDuration, normalizeCommand } from "../../../../../model/index.js";
import { ClaimVsObserved } from "../../../../graphics/ClaimVsObserved.js";
import { Icon } from "../../../../icons/Icon.js";
import type { FindingBodyProps } from "../Spine.js";
import styles from "../Spine.module.css";

export function ClaimFinding({ finding, session, onJump }: FindingBodyProps) {
  const claim = finding.claim;
  if (claim === undefined) return <p className={styles.findingText}>{finding.reason}</p>;
  const evidenceId = finding.evidenceStepIds?.[0] ?? claim.observed.stepId;
  const evidence = session.steps.find((step) => step.id === evidenceId);
  const gapMs = Math.max(0, claim.claim.tMs - ((evidence?.tMs ?? claim.observed.tMs) + (evidence?.durationMs ?? 0)));
  const gap = formatDuration(gapMs);
  return (
    <div className={styles.findingBody}>
      <p className={styles.chain} aria-label={`Claim made ${gap} after the failing run`}>
        <span className={styles.chainIconBad}>
          <Icon name="test" size={14} />
        </span>
        <span className={styles.chainLine} aria-hidden="true" />
        <Icon name="quote" size={14} />
        <span>{gap}</span>
      </p>
      <ClaimVsObserved
        size="sm"
        claim={{ text: claim.claim.text, span: finding.claimSpan, tMs: claim.claim.tMs }}
        observed={{
          passed: claim.observed.passed,
          failed: claim.observed.failed,
          command: displayUntrusted(normalizeCommand(claim.observed.command)),
          tMs: claim.observed.tMs,
        }}
        onObservedClick={() => onJump(evidenceId)}
        observedTabIndex={-1}
      />
    </div>
  );
}
```

Create `packages/trace-viewer/src/ui/views/hybrid/spine/findings/TestsFinding.tsx`:

```tsx
import { displayUntrusted } from "../../../../../model/index.js";
import type { FindingBodyProps } from "../Spine.js";
import styles from "../Spine.module.css";

export function TestsFinding({ finding, session }: FindingBodyProps) {
  const members = new Set<string>(finding.stepIds);
  const failures = session.steps.filter((step) => members.has(step.id)).flatMap((step) => step.tests?.failures ?? []);
  return (
    <div className={styles.findingBody}>
      <p className={styles.findingText}>{finding.reason}</p>
      <ul className={styles.failures}>
        {failures.slice(0, 3).map((failure, position) => (
          <li key={`${failure.file}:${position}`} className={styles.failure}>
            <div>{failure.testName}</div>
            <div className={styles.mono}>{displayUntrusted(failure.message.split("\n")[0] ?? "")}</div>
            <div className={styles.mono}>{displayUntrusted(failure.file)}</div>
          </li>
        ))}
      </ul>
      {failures.length > 3 ? <p className={styles.why}>{`${failures.length - 3} more`}</p> : null}
    </div>
  );
}
```

Create `packages/trace-viewer/src/ui/views/hybrid/spine/findings/DestructiveFinding.tsx`:

```tsx
import { displayUntrusted, normalizeCommand, signalMeta } from "../../../../../model/index.js";
import type { FindingBodyProps } from "../Spine.js";
import styles from "../Spine.module.css";

export function DestructiveFinding({ finding, step }: FindingBodyProps) {
  const meta = signalMeta(finding.ruleId);
  const command = step.command === undefined ? displayUntrusted(step.headline) : displayUntrusted(normalizeCommand(step.command.command));
  return (
    <div className={styles.findingBody}>
      <p className={`${styles.findingText} ${styles.mono}`}>{command}</p>
      {finding.matchedPattern === undefined ? null : <p className={styles.why}>{`Matched rule: ${finding.matchedPattern}`}</p>}
      <details className={styles.why}>
        <summary>Why flagged?</summary>
        <p>{meta.rationale}</p>
        {meta.knownFalsePositives.length > 0 ? (
          <ul>
            {meta.knownFalsePositives.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        ) : null}
      </details>
    </div>
  );
}
```

Create `packages/trace-viewer/src/ui/views/hybrid/spine/findings/GuardrailFinding.tsx`:

```tsx
import { clampMeta } from "../../../../../model/index.js";
import { Icon } from "../../../../icons/Icon.js";
import type { FindingBodyProps } from "../Spine.js";
import styles from "../Spine.module.css";

export function GuardrailFinding({ finding }: FindingBodyProps) {
  return (
    <div className={styles.findingBody}>
      {finding.clampId === undefined ? null : (
        <p className={styles.chain}>
          <Icon name="shield" size={14} />
          <span>{clampMeta(finding.clampId).label}</span>
        </p>
      )}
      <p className={styles.findingText}>{finding.reason}</p>
    </div>
  );
}
```

Create `packages/trace-viewer/src/ui/views/hybrid/spine/findings/RecoveryFinding.tsx`:

```tsx
import { formatOffset, type Step } from "../../../../../model/index.js";
import { Icon } from "../../../../icons/Icon.js";
import { KIND_ICON } from "../../../../icons/kind-icons.js";
import type { FindingBodyProps } from "../Spine.js";
import styles from "../Spine.module.css";

export function RecoveryFinding({ finding, session, onJump }: FindingBodyProps) {
  const steps = finding.stepIds
    .map((id) => session.steps.find((step) => step.id === id))
    .filter((step): step is Step => step !== undefined);
  return (
    <div className={styles.findingBody}>
      <p className={styles.findingText}>{finding.reason}</p>
      <div className={styles.steps}>
        {steps.map((step, position) => (
          <span key={step.id} data-recovery-step="" className={styles.steps}>
            {position > 0 ? <span className={styles.chainLine} aria-hidden="true" /> : null}
            <button type="button" tabIndex={-1} className={styles.chevron} onClick={() => onJump(step.id)} aria-label={formatOffset(step.tMs)}>
              <Icon name={KIND_ICON[step.kind]} size={14} />
            </button>
            <span>{formatOffset(step.tMs)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
```

Create `packages/trace-viewer/src/ui/views/hybrid/spine/findings/FindingBody.tsx`:

```tsx
import type { ComponentType } from "react";

import type { SignalId } from "../../../../../model/index.js";
import type { FindingBodyProps } from "../Spine.js";
import { ClaimFinding } from "./ClaimFinding.js";
import { DestructiveFinding } from "./DestructiveFinding.js";
import { GuardrailFinding } from "./GuardrailFinding.js";
import { RecoveryFinding } from "./RecoveryFinding.js";
import { TestsFinding } from "./TestsFinding.js";

/** A new signal fails typecheck until it has a body (spec §7.6.3). */
export const FINDING_BODY = {
  claim_contradicted: ClaimFinding,
  failing_tests: TestsFinding,
  destructive_command: DestructiveFinding,
  guardrail_clamp: GuardrailFinding,
  recovery_arc: RecoveryFinding,
} as const satisfies { readonly [K in SignalId]: ComponentType<FindingBodyProps> };

export function FindingBody(props: FindingBodyProps) {
  const Body = FINDING_BODY[props.finding.ruleId];
  return <Body {...props} />;
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/hybrid/spine/findings/findings.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Root checks**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/trace-viewer/src/ui/views/hybrid/spine/findings/FindingBody.tsx \
  packages/trace-viewer/src/ui/views/hybrid/spine/findings/ClaimFinding.tsx \
  packages/trace-viewer/src/ui/views/hybrid/spine/findings/TestsFinding.tsx \
  packages/trace-viewer/src/ui/views/hybrid/spine/findings/DestructiveFinding.tsx \
  packages/trace-viewer/src/ui/views/hybrid/spine/findings/GuardrailFinding.tsx \
  packages/trace-viewer/src/ui/views/hybrid/spine/findings/RecoveryFinding.tsx \
  packages/trace-viewer/src/ui/views/hybrid/spine/findings/findings.test.tsx
git commit -m "feat(trace-viewer): add spine finding bodies for the five v1 signals"
```

---
### Task C2-14: `HybridView`: composition, `ViewPort`, presets, live follow, "N new", view registry

**Files:**
- Create: `packages/trace-viewer/src/ui/views/hybrid/hybrid-port.ts`
- Create: `packages/trace-viewer/src/ui/views/hybrid/HybridView.tsx`
- Create: `packages/trace-viewer/src/ui/views/hybrid/HybridView.module.css`
- Create: `packages/trace-viewer/src/ui/views/registry.ts`
- Modify: `packages/trace-viewer/src/ui/shell/Shell.tsx` (deviation 2: mount the registered views)
- Test: `packages/trace-viewer/src/ui/views/hybrid/hybrid-port.test.ts`
- Test: `packages/trace-viewer/src/ui/views/hybrid/hybrid-view.test.tsx`

**Interfaces:**
- Consumes: C2-11 `Overview`, `OverviewApi` (`controller()`, `camera()`, `widthPx()`, `overview()`, `limits()`, `moveTo(camera, animate)`); C2-12 `Spine`, `SpineApi` (`rows()`, `revealSeq(seq, align)`, `focusRow(key)`), `FindingBodyContext`; C2-13 `FindingBody`; C2-9 `LEVEL_LABEL`; C2-3 `ViewPort`, `ViewProps`, `ViewDefinition`, `ZoomPreset`, `useRegisterViewPort`, `useViewPortRegistry`, `useSessionView`; C1b `overviewPreset`, `fitRange`, `uToScreenX`, `XOnlyCamera`, `SpineRow`, `buildSpineRows`, `ZOOM_STEP` (1.25), `selectEffectivePlayheadSeq`, `useViewStore`, `useDispatch`, `useView`, actions `level/set`, `brush/set`, `camera/sync`, `follow/set`; W0 `LEVELS`, `Level`.
- Produces:

```ts
// ui/views/hybrid/hybrid-port.ts
export const HYBRID_PRESETS: readonly ZoomPreset[];   // Session, Chapter, Step (ids = LEVELS)
export function isLevel(id: string): id is Level;
/** The spine's step keys in order; Session-level chapter rows contribute their unit id. */
export function hybridReadingOrder(rows: readonly SpineRow[], session: TraceSession): SelectionId[];
/** The level name at its preset k (±0.5%), else "150%" etc. */
export function zoomReadout(camera: XOnlyCamera | null, presetK: number | null, level: Level): string;
// ui/views/hybrid/HybridView.tsx
export function HybridView(props: ViewProps): React.JSX.Element;
// ui/views/registry.ts
export type { ViewDefinition, ViewProps } from "./view-port.js";
export const VIEWS: readonly ViewDefinition[];          // [hybrid]; C3-11 adds canvas first
export const KEEP_HIDDEN_VIEWS_MOUNTED: boolean;         // true; spike risk 6 ruling (C3-5) sets false
```

The Hybrid `ViewPort`: `readingOrder()` is the spine's order; `reveal()` scrolls the spine to the row and pans the overview only when the step lies off screen (never zooms); `captureCamera()` returns `{mode: "xOnly", u0, k, spineAnchor, syncedRev: focusRev}`; `focusSelected()` focuses the selected spine row; `zoom` applies level presets (`level/set`), zooms by `ZOOM_STEP` around the playhead, resets to the level preset, fits all and fits the selection. A zoom key in Live switches to Review. A level change applies the level's preset camera and preset brush (spec §7.6.1); a settled camera writes `camera/sync` and notifies the registry so the title bar's zoom label updates.

- [ ] **Step 1: Write the failing pure test**

Create `packages/trace-viewer/src/ui/views/hybrid/hybrid-port.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { buildSpineRows } from "../../../layout/spine-rows.js";
import { buildTimeScale, timeScaleInputOf } from "../../../layout/time-scale.js";
import { buildTraceIndex } from "../../../layout/trace-index.js";
import { LEVELS } from "../../../model/index.js";
import { foldFixture } from "../../../test-support/ui-harness.js";
import { HYBRID_PRESETS, hybridReadingOrder, isLevel, zoomReadout } from "./hybrid-port.js";

describe("hybrid-port", () => {
  it("reads in spine order: step keys at Chapter level", () => {
    const session = foldFixture("oauth");
    const index = buildTraceIndex(session);
    const rows = buildSpineRows(session, index, buildTimeScale(timeScaleInputOf(session)), {
      brush: { kind: "session" },
      level: "chapter",
      playheadSeq: session.loadedThroughSeq,
      selection: null,
      expanded: new Set(),
      collapsed: new Set(),
      live: false,
    });
    const steps = rows.filter((row) => row.t === "step").map((row) => row.key);
    expect(hybridReadingOrder(rows, session)).toEqual(steps);
  });

  it("reads chapter rows as their unit ids at Session level", () => {
    const session = foldFixture("oauth");
    const index = buildTraceIndex(session);
    const rows = buildSpineRows(session, index, buildTimeScale(timeScaleInputOf(session)), {
      brush: { kind: "session" },
      level: "session",
      playheadSeq: session.loadedThroughSeq,
      selection: null,
      expanded: new Set(),
      collapsed: new Set(),
      live: false,
    });
    const order = hybridReadingOrder(rows, session);
    expect(order.some((id) => id.startsWith("unit:"))).toBe(true);
  });

  it("reads the zoom as the level at its preset and as a percentage otherwise", () => {
    expect(zoomReadout({ mode: "xOnly", u0: 0, k: 0.02 }, 0.02, "chapter")).toBe("Chapter");
    expect(zoomReadout({ mode: "xOnly", u0: 0, k: 0.03 }, 0.02, "chapter")).toBe("150%");
    expect(zoomReadout(null, null, "session")).toBe("Session");
  });

  it("offers one preset per level", () => {
    expect(HYBRID_PRESETS.map((preset) => preset.id)).toEqual([...LEVELS]);
    expect(isLevel("step")).toBe(true);
    expect(isLevel("frame")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/hybrid/hybrid-port.test.ts`
Expected: FAIL with `Failed to resolve import "./hybrid-port.js"`.

- [ ] **Step 3: Implement hybrid-port**

Create `packages/trace-viewer/src/ui/views/hybrid/hybrid-port.ts`:

```ts
import type { SpineRow } from "../../../layout/spine-rows.js";
import type { SelectionId } from "../../../layout/trace-index.js";
import type { XOnlyCamera } from "../../../layout/viewport.js";
import { LEVELS, type Level, type TraceSession } from "../../../model/index.js";
import { LEVEL_LABEL } from "../shared/LevelControl.js";
import type { ZoomPreset } from "../view-port.js";

export const HYBRID_PRESETS: readonly ZoomPreset[] = LEVELS.map((level) => ({ id: level, label: LEVEL_LABEL[level] }));

export function isLevel(id: string): id is Level {
  return (LEVELS as readonly string[]).includes(id);
}

export function hybridReadingOrder(rows: readonly SpineRow[], session: TraceSession): SelectionId[] {
  const order: SelectionId[] = [];
  for (const row of rows) {
    if (row.t === "step") order.push(row.key);
    else if (row.t === "chapter") {
      const chapter = session.chapters[row.chapter];
      if (chapter !== undefined) order.push(chapter.id);
    }
  }
  return order;
}

export function zoomReadout(camera: XOnlyCamera | null, presetK: number | null, level: Level): string {
  if (camera === null || presetK === null || presetK <= 0) return LEVEL_LABEL[level];
  const ratio = camera.k / presetK;
  return Math.abs(ratio - 1) < 0.005 ? LEVEL_LABEL[level] : `${Math.round(ratio * 100)}%`;
}
```

- [ ] **Step 4: Run the pure test to see it pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/hybrid/hybrid-port.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing view test**

Create `packages/trace-viewer/src/ui/views/hybrid/hybrid-view.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStaticBundleSource } from "../../../sources/static-bundle.js";
import {
  applyOpenDefaults,
  fixtureBundle,
  foldFixture,
  renderHarness,
  stubLayout,
  type LayoutStub,
} from "../../../test-support/ui-harness.js";
import { KeyboardLayer } from "../../shell/KeyboardLayer.js";
import { TraceViewer } from "../../shell/TraceViewer.js";
import { HybridView } from "./HybridView.js";

let layout: LayoutStub;
beforeEach(() => {
  layout = stubLayout({ width: 1400, height: 2_000 });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  layout.restore();
  vi.restoreAllMocks();
});

function WithKeys({ children }: { children: ReactNode }) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setRoot}>
      <main data-region="main">{children}</main>
      <KeyboardLayer root={root} />
    </div>
  );
}

function spineKeys(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="feed"] article')).map((node) => node.dataset.key ?? "");
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

describe("HybridView", () => {
  it("opens oauth in Review with the contradiction selected and expanded at +0:43", async () => {
    render(<TraceViewer source={createStaticBundleSource(fixtureBundle("oauth"))} />);
    await waitFor(() =>
      expect(document.querySelector('[data-slot="title"]')?.textContent).toBe("Claim contradicts tests"),
    );
    await settle();
    const claim = foldFixture("oauth").findings.find((finding) => finding.ruleId === "claim_contradicted");
    const row = document.querySelector<HTMLElement>(`[role="feed"] article[data-key="${claim?.anchorStepId ?? ""}"]`);
    expect(row?.textContent).toContain("+0:43");
    expect(row?.querySelector("[data-expanded]")).not.toBeNull();
    expect(screen.getByRole("button", { name: /Review/ }).getAttribute("aria-pressed")).toBe("true");
    const main = screen.getByRole("main");
    expect(main.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  });

  it("registers a port whose reading order equals the spine's step keys", async () => {
    const session = foldFixture("oauth");
    const h = renderHarness(<HybridView active />, session);
    act(() => applyOpenDefaults(h, session));
    await settle();
    const order = h.registry.get("hybrid")?.readingOrder() ?? [];
    expect(order).toEqual(spineKeys().filter((key) => key.startsWith("step:")));
  });

  it("slides the brush past its edge on j", async () => {
    const session = foldFixture("oauth");
    const [a, , c] = session.steps.filter((step) => step.noise === null);
    const h = renderHarness(
      <WithKeys>
        <HybridView active />
      </WithKeys>,
      session,
    );
    act(() => applyOpenDefaults(h, session));
    act(() => h.store.dispatch({ type: "brush/set", brush: { kind: "range", fromSeq: a?.firstSeq ?? 1, toSeq: c?.firstSeq ?? 1 }, by: "hybrid" }));
    act(() => h.store.dispatch({ type: "select", id: c?.id ?? null, by: "shell" }));
    await settle();
    fireEvent.keyDown(document.body, { code: "KeyJ", key: "j" });
    await settle();
    const selected = session.steps.find((step) => step.id === h.store.get().selection);
    const brush = h.store.get().brush;
    expect(selected?.firstSeq ?? 0).toBeGreaterThan(c?.firstSeq ?? 0);
    expect(brush.kind).toBe("range");
    if (brush.kind === "range" && brush.toSeq !== "live") expect(brush.toSeq).toBeGreaterThanOrEqual(selected?.firstSeq ?? 0);
  });

  it("applies the level presets on Alt+1, Alt+2 and Alt+3", async () => {
    const session = foldFixture("oauth");
    const h = renderHarness(
      <WithKeys>
        <HybridView active />
      </WithKeys>,
      session,
    );
    act(() => applyOpenDefaults(h, session));
    await settle();
    fireEvent.keyDown(document.body, { code: "Digit1", key: "1", altKey: true });
    await settle();
    expect(h.store.get().level).toBe("session");
    expect(h.store.get().brush).toEqual({ kind: "session" });
    fireEvent.keyDown(document.body, { code: "Digit3", key: "3", altKey: true });
    await settle();
    expect(h.store.get().level).toBe("step");
    expect(h.store.get().brush.kind).toBe("range");
    fireEvent.keyDown(document.body, { code: "Digit2", key: "2", altKey: true });
    await settle();
    expect(h.store.get().level).toBe("chapter");
    expect(h.store.get().brush.kind).toBe("chapter");
    await waitFor(() => expect(h.registry.get("hybrid")?.zoom.label()).toBe("Chapter"));
  });

  it("keeps the playhead at the live edge while following", async () => {
    const bundle = fixtureBundle("oauth");
    const source = createStaticBundleSource(bundle, { drip: { rowsPerTick: 5, intervalMs: 50, manual: true, startAtSeq: 30 } });
    render(<TraceViewer source={source} pollMs={50} />);
    await waitFor(() => expect(spineKeys().length).toBeGreaterThan(0));
    expect(screen.getByRole("button", { name: /Live/ }).getAttribute("aria-pressed")).toBe("true");
    const before = spineKeys().join("|");
    act(() => source.tick());
    await waitFor(() => expect(spineKeys().join("|")).not.toBe(before));
    const articles = Array.from(document.querySelectorAll<HTMLElement>('[role="feed"] article'));
    expect(articles.at(-1)?.hasAttribute("data-playhead")).toBe(true);
  });

  it("a Review append raises N new and never moves focus", async () => {
    const bundle = fixtureBundle("oauth");
    const source = createStaticBundleSource(bundle, { drip: { rowsPerTick: 5, intervalMs: 50, manual: true, startAtSeq: 30 } });
    render(<TraceViewer source={source} pollMs={50} />);
    await waitFor(() => expect(spineKeys().length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: /Review/ }));
    const focused = document.querySelector<HTMLElement>('[role="feed"] article');
    focused?.focus();
    expect(document.activeElement).toBe(focused);
    act(() => source.tick());
    await waitFor(() => expect(screen.getByRole("button", { name: /↓ \d+ new/ })).toBeTruthy());
    expect(document.activeElement).toBe(focused);
  });
});
```

- [ ] **Step 6: Run it to see it fail**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/hybrid/hybrid-view.test.tsx`
Expected: FAIL with `Failed to resolve import "./HybridView.js"`.

- [ ] **Step 7: Implement the view, its CSS and the registry**

Create `packages/trace-viewer/src/ui/views/hybrid/HybridView.module.css`:

```css
.hybrid {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--tv-panel);
}
```

Create `packages/trace-viewer/src/ui/views/hybrid/HybridView.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { overviewPreset } from "../../../layout/overview-layout.js";
import type { SelectionId } from "../../../layout/trace-index.js";
import { fitRange, uToScreenX, type XOnlyCamera } from "../../../layout/viewport.js";
import type { Level } from "../../../model/index.js";
import { useSessionView } from "../../shell/session-context.js";
import { ZOOM_STEP } from "../../state/keymap.js";
import { useDispatch, useView, useViewStore } from "../../state/store.js";
import { selectEffectivePlayheadSeq } from "../../state/view-state.js";
import { useRegisterViewPort, useViewPortRegistry, type ViewPort, type ViewProps } from "../view-port.js";
import { HYBRID_PRESETS, hybridReadingOrder, isLevel, zoomReadout } from "./hybrid-port.js";
import styles from "./HybridView.module.css";
import { Overview, type OverviewApi } from "./overview/Overview.js";
import { FindingBody } from "./spine/findings/FindingBody.js";
import { FindingBodyContext, Spine, type SpineApi } from "./spine/Spine.js";

export function HybridView({ active }: ViewProps) {
  const store = useViewStore();
  const dispatch = useDispatch();
  const registry = useViewPortRegistry();
  const { session, index, scale } = useSessionView();
  const level = useView((state) => state.level);
  const overviewApi = useRef<OverviewApi | null>(null);
  const spineApi = useRef<SpineApi | null>(null);
  const anchor = useRef<{ key: string; offsetPx: number } | null>(null);
  const [spineWindow, setSpineWindow] = useState<{ t0: number; t1: number } | null>(null);
  const live = useRef({ session, index, scale });
  live.current = { session, index, scale };

  const presetFor = useCallback(
    (forLevel: Level) => {
      const api = overviewApi.current;
      const model = api?.overview() ?? null;
      const { session: current, index: currentIndex, scale: currentScale } = live.current;
      if (api === null || model === null || current === null || api.widthPx() <= 0) return null;
      const state = store.get();
      return overviewPreset({
        level: forLevel,
        overview: model,
        index: currentIndex,
        scale: currentScale,
        widthPx: api.widthPx(),
        playheadSeq: selectEffectivePlayheadSeq(state, currentIndex),
        live: state.follow,
      });
    },
    [store],
  );

  const leaveLive = useCallback((): void => {
    if (store.get().follow) dispatch({ type: "follow/set", follow: false });
  }, [store, dispatch]);

  const zoomAroundPlayhead = useCallback(
    (factor: number): void => {
      const api = overviewApi.current;
      const controller = api?.controller() ?? null;
      const camera = api?.camera() ?? null;
      const { session: current, index: currentIndex, scale: currentScale } = live.current;
      if (controller === null || camera === null || current === null) return;
      leaveLive();
      const step = current.steps[Math.max(0, currentIndex.stepIndexAtOrBefore(selectEffectivePlayheadSeq(store.get(), currentIndex)))];
      const x = step === undefined ? 0 : uToScreenX(camera, currentScale.toU(step.tMs));
      controller.zoomBy(factor, { x, y: 0 });
    },
    [store, leaveLive],
  );

  const port = useMemo<ViewPort>(
    () => ({
      readingOrder: () => {
        const current = live.current.session;
        return current === null ? [] : hybridReadingOrder(spineApi.current?.rows() ?? [], current);
      },
      reveal: (id: SelectionId) => {
        const entry = live.current.index.entry(id);
        if (entry === undefined) return;
        spineApi.current?.revealSeq(entry.firstSeq, "auto");
        const api = overviewApi.current;
        const camera = api?.camera() ?? null;
        if (api === null || camera === null) return;
        const x = uToScreenX(camera, live.current.scale.toU(entry.t0));
        if (x < 0 || x > api.widthPx()) {
          api.moveTo({ mode: "xOnly", u0: live.current.scale.toU(entry.t0) - api.widthPx() / 2 / camera.k, k: camera.k }, true);
        }
      },
      captureCamera: () => {
        const camera = overviewApi.current?.camera() ?? null;
        return camera === null
          ? null
          : { mode: "xOnly", u0: camera.u0, k: camera.k, spineAnchor: anchor.current, syncedRev: store.get().focusRev };
      },
      focusSelected: () => {
        const selection = store.get().selection;
        if (selection !== null) spineApi.current?.focusRow(selection);
      },
      zoom: {
        label: () => zoomReadout(overviewApi.current?.camera() ?? null, presetFor(store.get().level)?.camera.k ?? null, store.get().level),
        presets: () => HYBRID_PRESETS,
        applyPreset: (id: string) => {
          if (isLevel(id)) dispatch({ type: "level/set", level: id, by: "hybrid" });
        },
        zoomIn: () => zoomAroundPlayhead(ZOOM_STEP),
        zoomOut: () => zoomAroundPlayhead(1 / ZOOM_STEP),
        resetToPreset: () => {
          const preset = presetFor(store.get().level);
          if (preset === null) return;
          leaveLive();
          overviewApi.current?.moveTo(preset.camera, true);
        },
        fitAll: () => {
          const api = overviewApi.current;
          if (api === null) return;
          leaveLive();
          api.moveTo(fitRange(0, Math.max(1, live.current.scale.endU), api.widthPx(), { padFraction: 0.04, limits: api.limits() }), true);
        },
        fitSelection: () => {
          const api = overviewApi.current;
          const selection = store.get().selection;
          const entry = selection === null ? undefined : live.current.index.entry(selection);
          if (api === null || entry === undefined) return;
          leaveLive();
          const u0 = live.current.scale.toU(entry.t0);
          const u1 = Math.max(u0 + 1, live.current.scale.toU(entry.t1));
          api.moveTo(fitRange(u0, u1, api.widthPx(), { padFraction: 0.2, limits: api.limits() }), true);
        },
      },
    }),
    [store, dispatch, presetFor, zoomAroundPlayhead, leaveLive],
  );
  useRegisterViewPort("hybrid", port);

  // Picking a level applies its preset camera and brush (spec §7.6.1); continuous zoom leaves the level alone.
  const previousLevel = useRef(level);
  useEffect(() => {
    if (previousLevel.current === level) return;
    previousLevel.current = level;
    if (!active) return;
    const preset = presetFor(level);
    if (preset === null) return;
    overviewApi.current?.moveTo(preset.camera, true);
    dispatch({ type: "brush/set", brush: preset.brush, by: "hybrid" });
    registry.notify();
  }, [level, active, presetFor, dispatch, registry]);

  const onSettle = useCallback(
    (camera: XOnlyCamera): void => {
      dispatch({ type: "camera/sync", view: "hybrid", camera: { mode: "xOnly", u0: camera.u0, k: camera.k, spineAnchor: anchor.current } });
      registry.notify();
    },
    [dispatch, registry],
  );

  return (
    <div className={styles.hybrid}>
      <Overview active={active} apiRef={overviewApi} spineWindow={spineWindow} onSettle={onSettle} />
      <FindingBodyContext.Provider value={FindingBody}>
        <Spine
          active={active}
          apiRef={spineApi}
          onWindow={setSpineWindow}
          onAnchor={(next) => {
            anchor.current = next;
          }}
        />
      </FindingBodyContext.Provider>
    </div>
  );
}
```

Create `packages/trace-viewer/src/ui/views/registry.ts`:

```ts
import { HybridView } from "./hybrid/HybridView.js";
import type { ViewDefinition } from "./view-port.js";

export type { ViewDefinition, ViewProps } from "./view-port.js";

/** Switch order: Canvas | Hybrid. The title bar shows the switch only when VIEWS.length > 1 (C3-11 adds Canvas first). */
export const VIEWS: readonly ViewDefinition[] = [
  { kind: "hybrid", label: "Hybrid", icon: "view-hybrid", Component: HybridView },
];

/** true: hidden views stay mounted under <Activity mode="hidden">; the spike risk 6 ruling sets false (unmount). */
export const KEEP_HIDDEN_VIEWS_MOUNTED = true;
```

- [ ] **Step 8: Mount the registered views in the Shell**

In `packages/trace-viewer/src/ui/shell/Shell.tsx`, add `import { KEEP_HIDDEN_VIEWS_MOUNTED, VIEWS } from "../views/registry.js";` after `import { tokenStyle } from "../tokens/tokens.js";`, and replace the anchor lines

```tsx
const SHELL_VIEWS: readonly ViewDefinition[] = [];
const KEEP_HIDDEN = true;
```

with

```tsx
const SHELL_VIEWS: readonly ViewDefinition[] = VIEWS;
const KEEP_HIDDEN = KEEP_HIDDEN_VIEWS_MOUNTED;
```

- [ ] **Step 9: Run the tests to see them pass**

Run: `pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/hybrid src/ui/shell`
Expected: PASS, including hybrid-port (4) and hybrid-view (6). The keyboard suite's "F6 cycles" still lands on `main`, now on the spine's tab stop.

- [ ] **Step 10: Root checks**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint`
Expected: exit 0.

- [ ] **Step 11: Commit**

```bash
git add packages/trace-viewer/src/ui/views/hybrid/hybrid-port.ts packages/trace-viewer/src/ui/views/hybrid/hybrid-port.test.ts \
  packages/trace-viewer/src/ui/views/hybrid/HybridView.tsx packages/trace-viewer/src/ui/views/hybrid/HybridView.module.css \
  packages/trace-viewer/src/ui/views/hybrid/hybrid-view.test.tsx packages/trace-viewer/src/ui/views/registry.ts \
  packages/trace-viewer/src/ui/shell/Shell.tsx
git commit -m "feat(trace-viewer): compose the Hybrid view and register it with the shell"
```

---
### Task C2-15: Dev host: bundle loading, drop, drip, hash location, selftest, perf HUD, serve-only source alias

**Files:**
- Modify: `apps/trace-viewer-dev/vite.config.ts` (whole file)
- Modify: `apps/trace-viewer-dev/.gitignore` (append two lines)
- Modify: `apps/trace-viewer-dev/src/main.tsx` (whole file)
- Create: `apps/trace-viewer-dev/src/host.tsx`
- Create: `apps/trace-viewer-dev/src/host.module.css`
- Create: `apps/trace-viewer-dev/src/selftest.ts`
- Create: `apps/trace-viewer-dev/src/selftest-open.ts` (deviation 10)
- Create: `apps/trace-viewer-dev/src/perf-hud.tsx`

**Interfaces:**
- Consumes (root barrel `@jevcode/trace-viewer`, dist): `TraceViewer`, `ViewerHost`, `createStaticBundleSource(bundle, { drip? })`, `StaticBundleSource` (`released()`, `tick()`, `dispose()`), `DripOptions { rowsPerTick; intervalMs; manual?; startAtSeq? }`, `parseTraceBundle(json): ParsedBundle` ("Not a jevcode trace", "Trace format v2 is not supported"), `locationFromHash(hash, sessionId)`, `locationToHash(location)`, `PERF`, `INITIAL_SELECTION_PAINTED` (C2-3); `TraceBundle` from `@jevcode/contracts`. The dev host's `src/vite-env.d.ts` (C1-7) types CSS Modules. The open probe reads these DOM hooks: `[data-view="hybrid"]` (C2-3 `ViewSlot`), `[data-overview-lanes]` and the pin buttons' `data-steps` and `aria-pressed` (C2-11), and `[role="feed"] article[data-key]` (C2-12).
- Produces (UI index §2.5):

```ts
// apps/trace-viewer-dev/src/host.tsx
export type Loaded = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; bundle: TraceBundle };
export function parseDrip(value: string | null): DripOptions | undefined;     // "5,100" → { rowsPerTick: 5, intervalMs: 100 }; "20,1000,-2000" adds startAtSeq: -2000
export function resolveDrip(drip: DripOptions, bundle: TraceBundle): DripOptions; // a negative startAtSeq counts back from the bundle's last seq (lane 08 D-8)
export function parseBundleText(text: string): Loaded;                         // marks tv:bundle-parsed right after JSON.parse
export function DevHost(props: { search: string; hash: string }): React.JSX.Element;
// apps/trace-viewer-dev/src/selftest.ts
export interface SelftestResult { ready: boolean; view: "hybrid" | "canvas"; selectedTitle: string | null; errors: string[]; cspViolations: string[]; maxDriftPx: number; rows: number }
export function claimRowOf(bundle: TraceBundle): TraceBundle["rows"][number] | undefined;   // oauth's claim row, by content (deviation 10)
export function selftestDrip(bundle: TraceBundle): DripOptions;
export interface Selftest { host: Pick<ViewerHost, "onReady" | "onDiagnostics">; start(): void; stop(): void }
export function createSelftest(options: { source: StaticBundleSource; total: number; view?: "hybrid" | "canvas"; write(result: SelftestResult): void; settleMs?: number; timeoutMs?: number }): Selftest;
// apps/trace-viewer-dev/src/selftest-open.ts (deviation 10)
export interface OpenProbeResult { selected: string | null; claimStepId: string | null; claimRowInSpine: boolean; claimPinInOverview: boolean; paintedAtMs: number | null }
export function claimStepIdOf(bundle: TraceBundle): string | null;   // `step:<seq of the claim row>` (R9)
export interface OpenProbe { start(): void; stop(): void }
export function createOpenProbe(options: { sessionId: string; claimStepId: string | null; write(result: OpenProbeResult): void; deadlineMs?: number }): OpenProbe;
// apps/trace-viewer-dev/src/perf-hud.tsx
export function PerfHud(props: { autorun: boolean }): React.JSX.Element;
```

Query parameters: `?bundle=<name>` (default `oauth`, fetched from `bundles/<name>.json`, same origin under the CSP), `?drip=<rowsPerTick>,<intervalMs>[,<startAtSeq>]` (a negative `startAtSeq` means `lastSeq + startAtSeq`; lane 08 D-8 measures the live tick with `?drip=20,1000,-2000`, spec §10 "starting at `lastSeq − 2000`"), `?perf=1` (HUD), `?perf=1&perfrun=1` (the HUD runs the scripted `j`/`k` presses and the overview sweep, then writes JSON into `<pre id="perf-result">`), `?selftest=drip` (Review drip from oauth's claim row; JSON into `<pre id="selftest">`), `?selftest=open` (spec §1: the whole bundle with no drip and no input; after `tv:initial-selection-painted` and three frames of unchanged geometry, `OpenProbeResult` JSON into `<pre id="selftest">`). The URL hash holds the location (`locationFromHash`; `onLocation` writes it with `history.replaceState`). A dropped `.json` file is validated the same way.

- [ ] **Step 1: Check the drip start semantics**

Run: `grep -n "startAtSeq" packages/trace-viewer/src/sources/static-bundle.ts packages/trace-viewer/src/sources/static-bundle.test.ts`
Expected: the source releases every row with `seq <= startAtSeq` on its first `rows()` call (deviation 8). If it releases `seq < startAtSeq` instead, change Step 5's `startAtSeq: claim?.seq` to `startAtSeq: (claim?.seq ?? 0) + 1` and keep the fallback as written.

- [ ] **Step 2: Replace the Vite config (serve-only alias)**

Current anchor (W0-1 with UI index §1.1 c) ends with:

```ts
export default defineConfig({
  base: "./",
  plugins: [react(), forbidNodeBuiltins(), electronCsp()],
  build: { outDir: "dist", emptyOutDir: true, assetsInlineLimit: 0 },
});
```

Replace the whole of `apps/trace-viewer-dev/vite.config.ts` with:

```ts
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Same policy as apps/desktop/src/renderer/index.html.
const ELECTRON_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'";
const NODE_BUILTINS = new Set(builtinModules);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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

// Serve only: HMR over the viewer's source. Build and every test use the package's dist.
// A plugin with apply "serve", not a callback config: the default export stays an object, so
// C1-7's vite.spike.config.ts can keep calling mergeConfig(base, …) (Vite 5 throws
// "Cannot merge config in form of callback" on a function config).
function serveViewerSource(): Plugin {
  return {
    name: "jevcode-serve-viewer-source",
    apply: "serve",
    config() {
      return {
        resolve: {
          alias: [
            {
              find: /^@jevcode\/trace-viewer$/,
              replacement: path.join(REPO_ROOT, "packages/trace-viewer/src/index.ts"),
            },
          ],
        },
      };
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), forbidNodeBuiltins(), electronCsp(), serveViewerSource()],
  build: { outDir: "dist", emptyOutDir: true, assetsInlineLimit: 0 },
});
```

Run: `pnpm --filter jevcode-trace-viewer-dev exec vite build --config vite.spike.config.ts`
Expected: exit 0 (the spike config still merges this file; C3-12 Step 8 rebuilds the spike harness with it).

Append to `apps/trace-viewer-dev/.gitignore`:

```gitignore
public/bundles/
.smoke/
```

- [ ] **Step 3: Write the host and its styles**

Create `apps/trace-viewer-dev/src/host.module.css`:

```css
.host {
  position: fixed;
  inset: 0;
  background: #ffffff;
}

.message {
  margin: 0;
  padding: 24px;
  font: 13px/18px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #16181d;
}

.result {
  display: none;
}

.hud {
  position: fixed;
  right: 12px;
  bottom: 12px;
  z-index: 100;
  width: 340px;
  padding: 10px 12px;
  border-radius: 10px;
  background: #ffffff;
  box-shadow: 0 1px 2px rgb(16 24 40 / 0.06), 0 4px 12px rgb(16 24 40 / 0.05);
  font: 12px/16px ui-monospace, "SF Mono", Menlo, monospace;
  color: #16181d;
}

.hudRow {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.hudActions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}

.hudButton {
  padding: 3px 8px;
  border: 0;
  border-radius: 6px;
  background: rgb(16 24 40 / 0.07);
  color: #16181d;
  font: inherit;
  cursor: pointer;
}
```

Create `apps/trace-viewer-dev/src/host.tsx`:

```tsx
import { useEffect, useMemo, useState, type DragEvent } from "react";

import type { TraceBundle } from "@jevcode/contracts";
import {
  createStaticBundleSource,
  locationFromHash,
  locationToHash,
  parseTraceBundle,
  PERF,
  TraceViewer,
  type DripOptions,
  type StaticBundleSource,
  type ViewerHost,
} from "@jevcode/trace-viewer";

import styles from "./host.module.css";
import { PerfHud } from "./perf-hud.js";
import { createSelftest, selftestDrip, type SelftestResult } from "./selftest.js";
import { claimStepIdOf, createOpenProbe, type OpenProbeResult } from "./selftest-open.js";

export type Loaded = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; bundle: TraceBundle };

/** "<rowsPerTick>,<intervalMs>[,<startAtSeq>]"; a negative startAtSeq is resolved against the bundle by resolveDrip. */
export function parseDrip(value: string | null): DripOptions | undefined {
  if (value === null) return undefined;
  const parts = value.split(",");
  if (parts.length < 2 || parts.length > 3) return undefined;
  const [rows, interval, start] = parts.map((part) => Number(part));
  if (rows === undefined || interval === undefined) return undefined;
  if (!Number.isInteger(rows) || rows <= 0 || !Number.isInteger(interval) || interval <= 0) return undefined;
  if (start === undefined) return { rowsPerTick: rows, intervalMs: interval };
  if (!Number.isInteger(start)) return undefined;
  return { rowsPerTick: rows, intervalMs: interval, startAtSeq: start };
}

/** Spec §10 live tick run: "starting at lastSeq − 2000" is `?drip=20,1000,-2000`. */
export function resolveDrip(drip: DripOptions, bundle: TraceBundle): DripOptions {
  if (drip.startAtSeq === undefined || drip.startAtSeq >= 0) return drip;
  const lastSeq = bundle.rows.at(-1)?.seq ?? 0;
  return { ...drip, startAtSeq: Math.max(0, lastSeq + drip.startAtSeq) };
}

/** Spec §10: tv:bundle-parsed is marked right after JSON.parse and before schema validation. */
export function parseBundleText(text: string): Loaded {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: "error", message: "Not a jevcode trace" };
  }
  performance.mark(PERF.bundleParsed);
  const parsed = parseTraceBundle(json);
  return parsed.ok ? { kind: "ready", bundle: parsed.bundle } : { kind: "error", message: parsed.message };
}

async function loadBundle(name: string): Promise<Loaded> {
  const url = `bundles/${encodeURIComponent(name)}.json`;
  try {
    const response = await fetch(url);
    if (!response.ok) return { kind: "error", message: `Could not load ${url} (HTTP ${response.status})` };
    return parseBundleText(await response.text());
  } catch (error) {
    return { kind: "error", message: `Could not load ${url}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function Viewer({
  bundle,
  drip,
  hash,
  selftest,
  openProbe,
}: {
  bundle: TraceBundle;
  drip: DripOptions | undefined;
  hash: string;
  selftest: boolean;
  openProbe: boolean;
}) {
  const [source] = useState<StaticBundleSource>(() =>
    createStaticBundleSource(
      bundle,
      selftest ? { drip: selftestDrip(bundle) } : drip === undefined ? undefined : { drip: resolveDrip(drip, bundle) },
    ),
  );
  const [result, setResult] = useState<SelftestResult | null>(null);
  const [test] = useState(() =>
    selftest ? createSelftest({ source, total: bundle.rows.length, write: setResult }) : null,
  );
  useEffect(() => {
    if (test === null) return undefined;
    test.start();
    return () => test.stop();
  }, [test]);
  const [opened, setOpened] = useState<OpenProbeResult | null>(null);
  const [probe] = useState(() =>
    openProbe
      ? createOpenProbe({ sessionId: bundle.session.sessionId, claimStepId: claimStepIdOf(bundle), write: setOpened })
      : null,
  );
  useEffect(() => {
    if (probe === null) return undefined;
    probe.start();
    return () => probe.stop();
  }, [probe]);
  const location = useMemo(() => locationFromHash(hash, bundle.session.sessionId), [hash, bundle]);
  const host = useMemo<ViewerHost>(
    () => ({
      onLocation: (next) => history.replaceState(null, "", locationToHash(next)),
      ...(test === null ? {} : test.host),
    }),
    [test],
  );
  return (
    <>
      <TraceViewer
        source={source}
        host={host}
        location={location}
        pollMs={selftest ? 100 : (drip?.intervalMs ?? 1_000)}
        initialFollow={selftest ? false : undefined}
      />
      {selftest ? (
        <pre id="selftest" className={styles.result}>
          {result === null ? "" : JSON.stringify(result)}
        </pre>
      ) : null}
      {openProbe ? (
        <pre id="selftest" className={styles.result}>
          {opened === null ? "" : JSON.stringify(opened)}
        </pre>
      ) : null}
    </>
  );
}

export function DevHost({ search, hash }: { search: string; hash: string }) {
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const bundleName = params.get("bundle") ?? "oauth";
  const drip = parseDrip(params.get("drip"));
  const perf = params.get("perf") === "1";
  const selftest = params.get("selftest") === "drip";
  const openProbe = params.get("selftest") === "open";
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void loadBundle(bundleName).then((next) => {
      if (!cancelled) setLoaded(next);
    });
    return () => {
      cancelled = true;
    };
  }, [bundleName]);

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file === undefined) return;
    void file.text().then((text) => setLoaded(parseBundleText(text)));
  };

  return (
    <div className={styles.host} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
      {loaded.kind === "loading" ? <p className={styles.message}>{`Loading ${bundleName}`}</p> : null}
      {loaded.kind === "error" ? (
        <p className={styles.message} role="alert">
          {loaded.message}
        </p>
      ) : null}
      {loaded.kind === "ready" ? (
        <Viewer
          key={`${loaded.bundle.session.sessionId}:${loaded.bundle.exportedAt}`}
          bundle={loaded.bundle}
          drip={drip}
          hash={hash}
          selftest={selftest}
          openProbe={openProbe}
        />
      ) : null}
      {perf ? <PerfHud autorun={params.get("perfrun") === "1"} /> : null}
    </div>
  );
}
```

- [ ] **Step 4: Replace the entry**

Replace the whole of `apps/trace-viewer-dev/src/main.tsx` (W0-6's placeholder that renders "Trace viewer dev host") with:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { DevHost } from "./host.js";

const root = document.getElementById("root");
if (root === null) throw new Error("dev host: #root is missing");

createRoot(root).render(
  <StrictMode>
    <DevHost search={window.location.search} hash={window.location.hash} />
  </StrictMode>,
);
```

- [ ] **Step 5: Write the drip selftest and the open probe**

Create `apps/trace-viewer-dev/src/selftest.ts`:

```ts
import type { TraceBundle } from "@jevcode/contracts";
import type { DripOptions, StaticBundleSource, ViewerHost } from "@jevcode/trace-viewer";

export interface SelftestResult {
  ready: boolean;
  view: "hybrid" | "canvas";
  selectedTitle: string | null;
  errors: string[];
  cspViolations: string[];
  maxDriftPx: number;
  rows: number;
}

function textOf(payload: unknown): string {
  if (payload === null || typeof payload !== "object") return "";
  const text = (payload as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

/** oauth's claim row, found by content; the drip start (deviation 8) and the open probe (deviation 10) share it. */
export function claimRowOf(bundle: TraceBundle): TraceBundle["rows"][number] | undefined {
  return bundle.rows.find((row) => row.type === "agent_event" && /all checks pass/i.test(textOf(row.payload)));
}

/** Review drip starting at oauth's claim row (found by content), so later rows still arrive (deviation 8). */
export function selftestDrip(bundle: TraceBundle): DripOptions {
  const lastSeq = bundle.rows.at(-1)?.seq ?? 0;
  const claim = claimRowOf(bundle);
  return { rowsPerTick: 5, intervalMs: 100, startAtSeq: claim?.seq ?? Math.max(1, lastSeq - 20) };
}

export interface Selftest {
  host: Pick<ViewerHost, "onReady" | "onDiagnostics">;
  start(): void;
  stop(): void;
}

function scrollSpineToMiddle(): void {
  const feed = document.querySelector<HTMLElement>('[role="feed"]');
  if (feed !== null) feed.scrollTop = Math.max(0, (feed.scrollHeight - feed.clientHeight) / 2);
}

export function createSelftest(options: {
  source: StaticBundleSource;
  total: number;
  view?: "hybrid" | "canvas";
  write(result: SelftestResult): void;
  settleMs?: number;
  timeoutMs?: number;
}): Selftest {
  const result: SelftestResult = {
    ready: false,
    view: options.view ?? "hybrid",
    selectedTitle: null,
    errors: [],
    cspViolations: [],
    maxDriftPx: 0,
    rows: 0,
  };
  const originalError = console.error;
  let timer: ReturnType<typeof setInterval> | null = null;
  let written = false;

  const onError = (event: ErrorEvent): void => {
    result.errors.push(event.message);
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    result.errors.push(String(event.reason));
  };
  const onViolation = (event: SecurityPolicyViolationEvent): void => {
    result.cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`);
  };
  const finish = (): void => {
    if (written) return;
    written = true;
    result.rows = options.source.released();
    options.write({ ...result, errors: [...result.errors], cspViolations: [...result.cspViolations] });
  };

  return {
    host: {
      onReady: () => {
        result.ready = true;
        requestAnimationFrame(scrollSpineToMiddle);
      },
      onDiagnostics: (diagnostics) => {
        result.selectedTitle = diagnostics.selectedTitle;
        result.maxDriftPx = Math.max(result.maxDriftPx, diagnostics.maxAnchorDriftPx);
        for (const error of diagnostics.errors) if (!result.errors.includes(error)) result.errors.push(error);
      },
    },
    start() {
      window.addEventListener("error", onError);
      window.addEventListener("unhandledrejection", onRejection);
      document.addEventListener("securitypolicyviolation", onViolation);
      console.error = (...args: unknown[]) => {
        result.errors.push(args.map((arg) => String(arg)).join(" "));
        originalError.apply(console, args);
      };
      const started = Date.now();
      let doneAt: number | null = null;
      timer = setInterval(() => {
        if (doneAt === null && options.source.released() >= options.total) doneAt = Date.now();
        const settled = doneAt !== null && Date.now() - doneAt >= (options.settleMs ?? 800);
        if (settled || Date.now() - started >= (options.timeoutMs ?? 4_000)) {
          finish();
          if (timer !== null) clearInterval(timer);
          timer = null;
        }
      }, 100);
    },
    stop() {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      document.removeEventListener("securitypolicyviolation", onViolation);
      console.error = originalError;
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
```

Create `apps/trace-viewer-dev/src/selftest-open.ts` (deviation 10):

```ts
// Spec §1 "found at once" (?selftest=open): what a reader sees after opening oauth in Hybrid with no input.
// Reads only the DOM, the URL hash the viewer writes through onLocation, and the Shell's performance mark.
import type { TraceBundle } from "@jevcode/contracts";
import { INITIAL_SELECTION_PAINTED, locationFromHash } from "@jevcode/trace-viewer";

import { claimRowOf } from "./selftest.js";

export interface OpenProbeResult {
  /** The selection the viewer last reported through ViewerHost.onLocation (read back from the URL hash). */
  selected: string | null;
  /** oauth's claim step, `step:<seq of the claim row>` (stable ids, R9). */
  claimStepId: string | null;
  /** The claim's spine row lies inside the reading spine's viewport. */
  claimRowInSpine: boolean;
  /** The overview pin that holds the selection lies inside the overview's lane viewport. */
  claimPinInOverview: boolean;
  /** performance.getEntriesByName("tv:initial-selection-painted")[0].startTime; null when the mark never came. */
  paintedAtMs: number | null;
}

export interface OpenProbe {
  start(): void;
  stop(): void;
}

interface Box {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface Sample {
  row: Box | null;
  feed: Box | null;
  pin: Box | null;
  lanes: Box | null;
}

export function claimStepIdOf(bundle: TraceBundle): string | null {
  const claim = claimRowOf(bundle);
  return claim === undefined ? null : `step:${claim.seq}`;
}

function boxOf(element: Element | null | undefined): Box | null {
  if (element === null || element === undefined) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
}

/** `inner` lies inside `outer`, allowing 1 px for subpixel rounding. */
function inside(inner: Box | null, outer: Box | null): boolean {
  return (
    inner !== null &&
    outer !== null &&
    inner.top >= outer.top - 1 &&
    inner.bottom <= outer.bottom + 1 &&
    inner.left >= outer.left - 1 &&
    inner.right <= outer.right + 1
  );
}

function sample(claimStepId: string | null): Sample {
  const view = document.querySelector('[data-view="hybrid"]');
  const feed = view?.querySelector('[role="feed"]') ?? null;
  const row =
    claimStepId === null || feed === null
      ? undefined
      : Array.from(feed.querySelectorAll<HTMLElement>("article[data-key]")).find((node) => node.dataset.key === claimStepId);
  const lanes = view?.querySelector("[data-overview-lanes]") ?? null;
  const pin = lanes?.querySelector('button[data-steps][aria-pressed="true"]') ?? null;
  return { row: boxOf(row), feed: boxOf(feed), pin: boxOf(pin), lanes: boxOf(lanes) };
}

/**
 * Waits for the Shell's tv:initial-selection-painted mark, then for three frames with the same
 * geometry (the spine's reveal and the virtualizer's measurements settle), and writes what it sees.
 * Writes at `deadlineMs` after navigation start at the latest, with paintedAtMs null when the mark
 * never came.
 */
export function createOpenProbe(options: {
  sessionId: string;
  claimStepId: string | null;
  write(result: OpenProbeResult): void;
  deadlineMs?: number;
}): OpenProbe {
  let frame: number | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  let reported = false;
  let previous = "";
  let stillFrames = 0;

  const cancel = (): void => {
    if (frame !== null) cancelAnimationFrame(frame);
    if (deadline !== null) clearTimeout(deadline);
    frame = null;
    deadline = null;
  };

  const report = (): void => {
    if (reported) return;
    reported = true;
    cancel();
    const seen = sample(options.claimStepId);
    const mark = performance.getEntriesByName(INITIAL_SELECTION_PAINTED, "mark")[0];
    options.write({
      selected: locationFromHash(window.location.hash, options.sessionId).selected ?? null,
      claimStepId: options.claimStepId,
      claimRowInSpine: inside(seen.row, seen.feed),
      claimPinInOverview: inside(seen.pin, seen.lanes),
      paintedAtMs: mark === undefined ? null : mark.startTime,
    });
  };

  const onFrame = (): void => {
    frame = null;
    if (performance.getEntriesByName(INITIAL_SELECTION_PAINTED, "mark").length > 0) {
      const key = JSON.stringify(sample(options.claimStepId));
      stillFrames = key === previous ? stillFrames + 1 : 0;
      previous = key;
      if (stillFrames >= 2) {
        report();
        return;
      }
    }
    frame = requestAnimationFrame(onFrame);
  };

  return {
    start() {
      if (reported) return;
      frame = requestAnimationFrame(onFrame);
      deadline = setTimeout(report, Math.max(0, (options.deadlineMs ?? 4_800) - performance.now()));
    },
    stop: cancel,
  };
}
```

The probe measures after the layout holds still, not in the mark's own frame: the spine's reveal (`scrollToIndex`) and the expanded claim row's measurement can take a frame or two to settle, and nothing moves the view afterwards without input. Only `tv:initial-selection-painted`'s `startTime` is timed (spec §1). The 4,800 ms deadline leaves the dump under the smoke's `--virtual-time-budget=5000` room to include the result.

- [ ] **Step 6: Write the perf HUD**

Create `apps/trace-viewer-dev/src/perf-hud.tsx`:

```tsx
import { useEffect, useState } from "react";

import { PERF } from "@jevcode/trace-viewer";

import styles from "./host.module.css";

interface Stat {
  name: string;
  count: number;
  median: number | null;
  p95: number | null;
}

function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? null;
}

function readStats(): Stat[] {
  return Object.values(PERF).map((name) => {
    const durations = performance
      .getEntriesByName(name, "measure")
      .map((entry) => entry.duration)
      .sort((a, b) => a - b);
    return { name, count: durations.length, median: quantile(durations, 0.5), p95: quantile(durations, 0.95) };
  });
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function press(code: string, key: string, init: KeyboardEventInit = {}): void {
  document.body.dispatchEvent(new KeyboardEvent("keydown", { code, key, bubbles: true, cancelable: true, ...init }));
}

/** Spec §10 "j to painted": 300 presses at Chapter level, alternating runs of j and k. */
async function runKeys(): Promise<void> {
  performance.clearMeasures(PERF.keyToPaint);
  press("Digit2", "2", { altKey: true });
  await nextFrame();
  for (let i = 0; i < 300; i += 1) {
    const forward = i % 100 < 50;
    press(forward ? "KeyJ" : "KeyK", forward ? "j" : "k");
    await nextFrame();
    await nextFrame();
  }
}

/** Spec §10 "Overview layout + paint": a scripted pan and zoom sweep at Session level. */
async function runSweep(): Promise<void> {
  const lanes = document.querySelector<HTMLElement>("[data-overview-lanes]");
  if (lanes === null) return;
  press("Digit1", "1", { altKey: true });
  await nextFrame();
  await nextFrame();
  performance.clearMeasures(PERF.overviewPaint);
  const rect = lanes.getBoundingClientRect();
  for (let i = 0; i < 180; i += 1) {
    lanes.dispatchEvent(new WheelEvent("wheel", { deltaX: i % 60 < 30 ? 40 : -40, bubbles: true, cancelable: true }));
    await nextFrame();
  }
  for (let i = 0; i < 180; i += 1) {
    lanes.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: i % 60 < 30 ? -12 : 12,
        ctrlKey: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + 100,
        bubbles: true,
        cancelable: true,
      }),
    );
    await nextFrame();
  }
}

function overlayNodes(): number {
  return document.querySelectorAll("[data-overlay-node]").length;
}

export function PerfHud({ autorun }: { autorun: boolean }) {
  const [stats, setStats] = useState<Stat[]>(readStats);
  const [nodes, setNodes] = useState({ overlay: 0, total: 0, maxOverlay: 0 });
  const [result, setResult] = useState<string>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const id = setInterval(() => {
      setStats(readStats());
      setNodes((current) => {
        const overlay = overlayNodes();
        return { overlay, total: document.getElementsByTagName("*").length, maxOverlay: Math.max(current.maxOverlay, overlay) };
      });
    }, 500);
    return () => clearInterval(id);
  }, []);

  const run = async (task: () => Promise<void>): Promise<void> => {
    setBusy(true);
    await task();
    setBusy(false);
  };

  useEffect(() => {
    if (!autorun) return undefined;
    let cancelled = false;
    const id = setTimeout(() => {
      void (async () => {
        await runKeys();
        let maxOverlay = 0;
        const sampler = setInterval(() => {
          maxOverlay = Math.max(maxOverlay, overlayNodes());
        }, 50);
        await runSweep();
        clearInterval(sampler);
        if (!cancelled) setResult(JSON.stringify({ stats: readStats(), maxOverlayNodes: maxOverlay }));
      })();
    }, 2_500);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [autorun]);

  return (
    <aside className={styles.hud} aria-label="Performance HUD">
      {stats.map((stat) => (
        <div key={stat.name} className={styles.hudRow}>
          <span>{stat.name}</span>
          <span>
            {stat.count === 0
              ? "–"
              : `n ${stat.count} · med ${stat.median?.toFixed(1) ?? "–"} · p95 ${stat.p95?.toFixed(1) ?? "–"} ms`}
          </span>
        </div>
      ))}
      <div className={styles.hudRow}>
        <span>overlay nodes</span>
        <span>{`${nodes.overlay} (max ${nodes.maxOverlay}) · DOM ${nodes.total}`}</span>
      </div>
      <div className={styles.hudActions}>
        <button type="button" className={styles.hudButton} disabled={busy} onClick={() => void run(runKeys)}>
          300 × j/k
        </button>
        <button type="button" className={styles.hudButton} disabled={busy} onClick={() => void run(runSweep)}>
          Overview sweep
        </button>
        <button
          type="button"
          className={styles.hudButton}
          onClick={() => {
            for (const name of Object.values(PERF)) performance.clearMeasures(name);
            setStats(readStats());
          }}
        >
          Clear
        </button>
      </div>
      <pre id="perf-result" className={styles.result}>
        {result}
      </pre>
    </aside>
  );
}
```

- [ ] **Step 7: Typecheck and build the dev host (the browser-safety proof)**

Run: `pnpm --filter @jevcode/trace-viewer build && pnpm --filter jevcode-trace-viewer-dev typecheck && pnpm --filter jevcode-trace-viewer-dev build`
Expected: exit 0; no "browser bundle imports" error.

Run: `grep -c 'http-equiv="Content-Security-Policy"' apps/trace-viewer-dev/dist/index.html && grep -c 'url(data:' apps/trace-viewer-dev/dist/assets/*.css`
Expected: `1`, then `0` for every CSS file.

- [ ] **Step 8: Check the dev server once**

Run: `pnpm --filter jevcode-desktop rebuild:node && pnpm build && pnpm --filter jevcode-desktop replay "$PWD/fixtures/oauth" "$PWD/apps/trace-viewer-dev/.smoke/replay-oauth" && mkdir -p apps/trace-viewer-dev/public/bundles && cp apps/trace-viewer-dev/.smoke/replay-oauth/trace.json apps/trace-viewer-dev/public/bundles/oauth.json`
Expected: exit 0 and `apps/trace-viewer-dev/public/bundles/oauth.json` exists (both directories are git-ignored).

Run: `pnpm --filter jevcode-trace-viewer-dev exec vite build && pnpm --filter jevcode-trace-viewer-dev exec vite preview --port 4179 --strictPort` in the background, then `curl -s http://localhost:4179/ | grep -c 'Content-Security-Policy'` and stop the preview.
Expected: `1`.

- [ ] **Step 9: Root checks**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint`
Expected: exit 0 (`git status --short` shows no files under `public/bundles/` or `.smoke/`).

- [ ] **Step 10: Commit**

```bash
git add apps/trace-viewer-dev/vite.config.ts apps/trace-viewer-dev/.gitignore apps/trace-viewer-dev/src/main.tsx \
  apps/trace-viewer-dev/src/host.tsx apps/trace-viewer-dev/src/host.module.css apps/trace-viewer-dev/src/selftest.ts \
  apps/trace-viewer-dev/src/selftest-open.ts apps/trace-viewer-dev/src/perf-hud.tsx
git commit -m "feat(trace-viewer-dev): load bundles with drip, selftest and perf HUD"
```

---

### Task C2-16: Visual smoke (Hybrid) and the M4a exit

**Files:**
- Create: `apps/trace-viewer-dev/scripts/smoke.mjs`
- Modify: `docs/spikes/trace-viewer-spike.md` (append the "M4a exit" section, with the spec §1 open probe and the VoiceOver check)

**Interfaces:**
- Consumes: C2-15's `?selftest=drip` (`<pre id="selftest">` holding `SelftestResult`), `?selftest=open` (`<pre id="selftest">` holding `OpenProbeResult`, deviation 10) and `?perf=1&perfrun=1` (`<pre id="perf-result">`); A2's `pnpm --filter jevcode-desktop replay <fixtureDir> <outDir>` writing `<outDir>/trace.json`; A2-7's `JEVCODE_SOAK_EXPORT=<file> node scripts/soak.mjs`; Google Chrome (gotcha 10).
- Produces: `node apps/trace-viewer-dev/scripts/smoke.mjs [--views hybrid|hybrid,canvas] [--skip-build]`, printing `SMOKE_OK <n> screenshots` (exit 0) or `SMOKE_FAIL: <reason>` (exit 1); screenshots `apps/trace-viewer-dev/.smoke/<view>-<width>.png` for widths 1440 and 1000. For Hybrid it also asserts spec §1 at 1440 px through `?selftest=open` (the selection equals the oauth claim step's id, the claim row lies inside the spine viewport, its pin inside the overview viewport, `tv:initial-selection-painted` `startTime` ≤ 5000) and prints `hybrid: opened with <id> selected and in view, painted at <ms> ms`. C3-12 extends the same script for Canvas. `scripts/**` is outside ESLint and outside `pnpm -r test`.

- [ ] **Step 1: Write the smoke script**

Create `apps/trace-viewer-dev/scripts/smoke.mjs`:

```js
#!/usr/bin/env node
// Visual smoke for the trace viewer dev host (design spec §11 "Visual smoke").
// Runs outside `pnpm -r test`; needs Google Chrome (CHROME_PATH overrides the default path).
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(APP, "../..");
const PORT = 4179;
const ORIGIN = `http://localhost:${PORT}`;
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const WIDTHS = [1440, 1000];
const SMOKE_DIR = path.join(APP, ".smoke");

function parseArgs(argv) {
  const options = { views: ["hybrid"], skipBuild: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--skip-build") options.skipBuild = true;
    else if (arg === "--views") {
      options.views = String(argv[i + 1] ?? "")
        .split(",")
        .filter((view) => view !== "");
      i += 1;
    } else throw new Error(`unknown argument ${arg}`);
  }
  if (options.views.length === 0) throw new Error("--views needs hybrid, canvas or both");
  for (const view of options.views) {
    if (view !== "hybrid" && view !== "canvas") throw new Error(`unknown view ${view}`);
  }
  return options;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: REPO, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
}

function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const retry = () => {
      if (Date.now() > deadline) reject(new Error(`vite preview did not answer at ${url}`));
      else setTimeout(attempt, 250);
    };
    const attempt = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode === 200) resolve();
        else retry();
      });
      request.on("error", retry);
    };
    attempt();
  });
}

function chrome(profile, args) {
  const result = spawnSync(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profile}`,
      ...args,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 90_000 },
  );
  if (result.status !== 0) throw new Error(`chrome exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}

function locationHash(sessionId, view) {
  return `#${encodeURIComponent(JSON.stringify({ v: 1, sessionId, view, level: "chapter", brush: { kind: "session" } }))}`;
}

function decodeHtml(text) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function readSelftest(html) {
  const match = /<pre id="selftest"[^>]*>([\s\S]*?)<\/pre>/.exec(html);
  if (match === null || match[1].trim() === "") throw new Error("the selftest wrote no result");
  return JSON.parse(decodeHtml(match[1]));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}; set CHROME_PATH`);
  if (!options.skipBuild) run("pnpm", ["-r", "build"]);
  const tmp = mkdtempSync(path.join(os.tmpdir(), "tv-smoke-"));
  const profile = path.join(tmp, "chrome-profile");
  let preview;
  try {
    run("pnpm", ["--filter", "jevcode-desktop", "replay", path.join(REPO, "fixtures", "oauth"), path.join(tmp, "oauth")]);
    const bundles = path.join(APP, "public", "bundles");
    mkdirSync(bundles, { recursive: true });
    copyFileSync(path.join(tmp, "oauth", "trace.json"), path.join(bundles, "oauth.json"));
    const sessionId = JSON.parse(readFileSync(path.join(bundles, "oauth.json"), "utf8")).session.sessionId;
    run("pnpm", ["--filter", "jevcode-trace-viewer-dev", "build"]);
    preview = spawn(
      "pnpm",
      ["--filter", "jevcode-trace-viewer-dev", "exec", "vite", "preview", "--port", String(PORT), "--strictPort"],
      { cwd: REPO, stdio: "ignore", detached: true },
    );
    await waitForServer(`${ORIGIN}/`, 30_000);
    mkdirSync(SMOKE_DIR, { recursive: true });
    let shots = 0;
    for (const view of options.views) {
      for (const width of WIDTHS) {
        const file = path.join(SMOKE_DIR, `${view}-${width}.png`);
        rmSync(file, { force: true });
        chrome(profile, [
          `--window-size=${width},900`,
          "--virtual-time-budget=3000",
          `--screenshot=${file}`,
          `${ORIGIN}/?bundle=oauth${locationHash(sessionId, view)}`,
        ]);
        if (!existsSync(file)) throw new Error(`no screenshot at ${file}`);
        shots += 1;
      }
      if (view === "hybrid") {
        // Spec §1 "found at once": oauth opened in Hybrid at 1440 px with no input (?selftest=open).
        const opened = readSelftest(
          chrome(profile, [
            "--window-size=1440,900",
            "--dump-dom",
            "--virtual-time-budget=5000",
            `${ORIGIN}/?bundle=oauth&selftest=open${locationHash(sessionId, view)}`,
          ]),
        );
        const misses = [];
        if (opened.claimStepId === null) misses.push("no claim row in the bundle");
        if (opened.selected !== opened.claimStepId) {
          misses.push(`selected ${JSON.stringify(opened.selected)}, claim step ${JSON.stringify(opened.claimStepId)}`);
        }
        if (opened.claimRowInSpine !== true) misses.push("the claim row lies outside the spine viewport");
        if (opened.claimPinInOverview !== true) misses.push("the claim pin lies outside the overview viewport");
        if (typeof opened.paintedAtMs !== "number" || opened.paintedAtMs > 5000) {
          misses.push(`tv:initial-selection-painted startTime ${JSON.stringify(opened.paintedAtMs)}`);
        }
        if (misses.length > 0) throw new Error(`hybrid open: ${misses.join("; ")}`);
        console.log(
          `hybrid: opened with ${opened.selected} selected and in view, painted at ${Math.round(opened.paintedAtMs)} ms`,
        );
      }
      const html = chrome(profile, [
        "--window-size=1440,900",
        "--dump-dom",
        "--virtual-time-budget=5000",
        `${ORIGIN}/?bundle=oauth&selftest=drip${locationHash(sessionId, view)}`,
      ]);
      const result = readSelftest(html);
      const problems = [];
      if (result.ready !== true) problems.push("not ready");
      if (result.selectedTitle !== "Claim contradicts tests") problems.push(`selected ${JSON.stringify(result.selectedTitle)}`);
      if (result.errors.length !== 0) problems.push(`errors ${JSON.stringify(result.errors)}`);
      if (result.cspViolations.length !== 0) problems.push(`csp ${JSON.stringify(result.cspViolations)}`);
      if (!(result.maxDriftPx <= 1)) problems.push(`drift ${result.maxDriftPx}px`);
      if (problems.length > 0) throw new Error(`${view} selftest: ${problems.join("; ")}`);
      console.log(`${view}: selftest ok (rows ${result.rows}, max drift ${result.maxDriftPx}px)`);
    }
    console.log(`SMOKE_OK ${shots} screenshots`);
  } finally {
    if (preview?.pid !== undefined) {
      try {
        process.kill(-preview.pid, "SIGTERM");
      } catch {
        // The preview server already exited.
      }
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`SMOKE_FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Run the smoke**

Run: `pnpm --filter jevcode-desktop rebuild:node && lsof -ti tcp:4179 | wc -l && node apps/trace-viewer-dev/scripts/smoke.mjs --views hybrid`
Expected: `0` (port free), then `hybrid: opened with step:<n> selected and in view, painted at <ms> ms` (`<n>` is the seq of oauth's "OAuth implementation complete; all checks pass." row in the replayed bundle; `<ms>` ≤ 5000, or the script fails with `hybrid open: …`), then `hybrid: selftest ok (rows 57, max drift 0px)` (the row count is the oauth bundle's, whatever the replay wrote; drift ≤ 1) and `SMOKE_OK 2 screenshots`. If Chrome's virtual time never runs the selftest's timers (`the selftest wrote no result`), rerun once; if it fails again, the fallback in spec §11 applies (read `<pre id="selftest">` over `--remote-debugging-pipe`) and the controller escalates before changing the script. A `hybrid open:` failure names what missed: the selection (the Shell's initial selection, C2-3), the claim row outside the spine viewport (the spine's reveal, C2-12), the pin outside the overview viewport (the overview camera, C2-11), or the mark (C2-3); fix the owning task, never the probe's expectations.

- [ ] **Step 3: Look at the screenshots**

Open `apps/trace-viewer-dev/.smoke/hybrid-1440.png` and `apps/trace-viewer-dev/.smoke/hybrid-1000.png` with the Read tool beside `docs/superpowers/specs/2026-09-28-trace-viewer-mockups/hybrid-1440.png`.
Expected, at 1440: title bar `oauth / Add Google OAuth login …` with Review pressed; the Outline with Story, Files and Commands; six labeled lanes with chapter bands; the spine with the red claim node at `+0:43`, "Claim contradicts tests" and the claim-versus-observed card expanded; the Inspector titled "Claim contradicts tests" with "Copy review note". At 1000 the side panels are 200 and 248 px and the lane gutter shows icons only. The documented deviations (spec §7.2) are expected, not defects. Any other mismatch is a bug in the owning task, fixed before the commit.

- [ ] **Step 4: Measure the M4a budgets (HUMAN CHECK: the controller asks the user, or runs a real non-headless Chrome itself)**

Run: `grep -c "JEVCODE_SOAK_PROFILE" scripts/soak.mjs`
Expected: `1` or more. Spec §10 "Reference inputs" measures on the trace-profile soak bundle (spec §5.6 `JEVCODE_SOAK_PROFILE=trace`, owned by A2-7). `0` means A2-7 has not implemented the profile (lane file 03 as written today carries only `JEVCODE_SOAK_EXPORT`; lane file 08 lists the same amendment): stop and escalate instead of measuring on the default profile, whose records are about 40 times smaller.

Run: `JEVCODE_SOAK_PROFILE=trace JEVCODE_SOAK_EXPORT="$PWD/apps/trace-viewer-dev/public/bundles/soak.json" node scripts/soak.mjs | grep "soak: wrote" && pnpm --filter jevcode-trace-viewer-dev build && pnpm --filter jevcode-trace-viewer-dev exec vite preview --port 4179 --strictPort`
Expected: `soak: wrote <n> trace rows to …/soak.json`, then the preview serving.

In desktop Chrome on the reference machine (spec §10 "Method"; ProMotion set to 60 Hz), open `http://localhost:4179/?bundle=soak&perf=1` in 6 fresh incognito windows (discard the first) and read `tv:first-paint` and `tv:full-load` from the HUD; then open `http://localhost:4179/?bundle=soak&perf=1&perfrun=1`, wait for `<pre id="perf-result">` to fill (about 30 s), and copy its JSON.
Expected: first paint median ≤ 300 ms; full load median ≤ 2,000 ms; `tv:key-to-paint` p95 ≤ 16.7 ms; `tv:overview-paint` p95 ≤ 4 ms with `maxOverlayNodes` ≤ 150. A miss blocks M4a (spec §12): record it and return the owning task to iteration.

- [ ] **Step 5: Hold the product review gate (HUMAN CHECK)**

The controller asks the user to review oauth, api-break and the soak bundle in the dev host against spec §1 and §12 M4a (the product review-gate session, docs/IMPLEMENTATION-PLAN.md:153), and records the verdict and the reviewer's notes. A failed gate returns the UI to iteration before W3 starts.

- [ ] **Step 6: Check VoiceOver on the Hybrid view (HUMAN CHECK: the controller asks the user)**

Spec §11 leaves VoiceOver output to a hand check "in the spike and at M4a exit" (base index gap G3); spec §7.13 fixes what it must read. This is the M4a-exit half, run with index H3's procedure on the Hybrid Outline, spine and overview sliders.

Run: `ls apps/trace-viewer-dev/public/bundles/oauth.json && pnpm --filter jevcode-trace-viewer-dev build && pnpm --filter jevcode-trace-viewer-dev exec vite preview --port 4179 --strictPort`
Expected: the path prints (Step 2's smoke wrote it; if `ls` fails, rerun Step 2), the build exits 0, and the preview serves `http://localhost:4179/`.

The person, in desktop Chrome on macOS with the window at least 1440 px wide:

1. Opens `http://localhost:4179/?bundle=oauth` and waits until the Inspector title reads "Claim contradicts tests".
2. Turns VoiceOver on (Cmd+F5).
3. Clicks the address bar, presses Tab until focus leaves the title bar, then keeps pressing Tab. Pass: focus enters the Outline (one stop), then the reading spine in `main` (one stop), then the Inspector, in that order; Shift+Tab walks back Inspector → main → Outline.
4. On the spine stop, listens. Pass: VoiceOver reads the selected row with "+0:43" (spoken as "plus 0 colon 43") and "Claim contradicts tests".
5. Opens the rotor (Control+Option+U), picks Form Controls and chooses "Playhead" (or moves the VoiceOver cursor with Control+Option+Right Arrow from the Outline into the overview until it reaches "Playhead"). Pass: VoiceOver reads "Playhead", "slider" and the value "+0:43, Claim contradicts tests, step <n> of <m>".
6. Presses Escape to close the rotor, clicks the claim row in the spine, presses Option+3 (Step level, which sets a range brush) and opens the rotor's Form Controls again. Pass: it lists "Range start" and "Range end", and each reads a "+m:ss" value such as "+0:39".
7. Turns VoiceOver off (Cmd+F5) and reports pass or fail for items 3–6, what VoiceOver said for each, and the macOS and Chrome versions.

A fail blocks the M4a exit and C2's merge: item 3 returns C2-8 (regions and roving tab stops) to iteration, item 4 returns C2-12 (spine rows), and items 5 and 6 return C2-11 (sliders). The controller copies the answer into Step 7's record before the commit.

- [ ] **Step 7: Record the M4a exit**

Append to `docs/spikes/trace-viewer-spike.md`, filling each value from Steps 2–6 (numbers copied from the smoke output and the HUD JSON, never estimated):

```markdown
## M4a exit (lane C2, 2026-09-28)

Reference machine: <model, CPU, memory, OS, Node, Chrome version, display refresh rate>.

| Budget (spec §10) | Target | Measured | Pass |
|---|---|---|---|
| Soak first paint (median of 5 cold loads) | ≤ 300 ms | <ms> | <yes/no> |
| Soak full load (median of 5 cold loads) | ≤ 2 s | <ms> | <yes/no> |
| `j` to painted, 300 presses at Chapter level | p95 ≤ 16.7 ms | <ms> | <yes/no> |
| Overview layout + paint, Session-level sweep | p95 ≤ 4 ms | <ms> | <yes/no> |
| Overlay nodes during the sweep | ≤ 150 | <n> | <yes/no> |
| Anchor drift (`?selftest=drip`, oauth) | ≤ 1 px | <px> | <yes/no> |

Smoke: `node apps/trace-viewer-dev/scripts/smoke.mjs --views hybrid` printed `SMOKE_OK 2 screenshots`; screenshots `apps/trace-viewer-dev/.smoke/hybrid-1440.png` and `hybrid-1000.png` (git-ignored; regenerate with the command).

Found at once (spec §1; `?selftest=open`, Hybrid, 1440 px): the smoke printed `hybrid: opened with <step id> selected and in view, painted at <ms> ms`. The selection equals oauth's claim step, the claim row lies inside the spine viewport, its pin lies inside the overview viewport, and `tv:initial-selection-painted` `startTime` is <ms> ms (≤ 5000).

Product review gate: <date>, <reviewer role>, <verdict>, <notes>.

VoiceOver (Hybrid, oauth; spec §7.13, §11; C2-16 Step 6): <date>, macOS <version>, Chrome <version>.

| Check | Pass | VoiceOver said |
|---|---|---|
| Tab order Outline → main → Inspector, and back with Shift+Tab | <yes/no> | <regions announced> |
| Selected spine row | <yes/no> | "<text>" |
| Playhead slider | <yes/no> | "<text>" |
| Range start and Range end sliders (after Option+3) | <yes/no> | "<text>"; "<text>" |
```

- [ ] **Step 8: Root checks**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r --no-bail --workspace-concurrency=1 test && pnpm lint`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add apps/trace-viewer-dev/scripts/smoke.mjs docs/spikes/trace-viewer-spike.md
git commit -m "test(trace-viewer-dev): add the Hybrid visual smoke and record the M4a exit"
```

---

## M4a exit criteria (lane C2 done)

All of these hold on the lane branch before it merges (spec §12 M4a, decision R28):

1. Spike risks 1, 4 and 5 passed or have their ruling applied (C2-0 gate section; C2-11 `PINS_PAINTED_ON_CANVAS` matches the risk 5 ruling).
2. oauth opens in Hybrid, in Review, with "Claim contradicts tests" selected and expanded at +0:43 (C2-14 test and the smoke's `selectedTitle`), and spec §1 "found at once" holds at 1440 px: the smoke's `?selftest=open` probe finds the selection equal to the claim step's id, the claim row inside the spine viewport, its pin inside the overview viewport and `tv:initial-selection-painted` at ≤ 5,000 ms (C2-3 mark, C2-16).
3. `pnpm --filter jevcode-trace-viewer-dev build` passes with the Electron CSP injected and no Node built-in in the graph (C2-15).
4. `node apps/trace-viewer-dev/scripts/smoke.mjs --views hybrid` prints `SMOKE_OK 2 screenshots` with zero errors, zero CSP violations and drift ≤ 1 px (C2-16).
5. The M4a budgets in the spike doc's "M4a exit" table all pass.
6. The product review gate is held and recorded.
7. The VoiceOver check (C2-16 Step 6) passed on all four rows and is recorded in the spike doc's "M4a exit" section.
7. `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r --no-bail --workspace-concurrency=1 test` and `pnpm lint` exit 0.

**Merge.** Rebase on `main` (`git rebase main`), rerun `pnpm install --frozen-lockfile && pnpm -r build` and the root checks, then merge C2 first in W2 (C2 → C3a → Da). Never `git stash`.

## Self-review notes

- **Spec coverage.** §1 "found at once" (C2-3 `tv:initial-selection-painted` mark and its jsdom test; C2-15 `?selftest=open`; C2-16 smoke assertion; base index gap G1); §7.1 Shell (C2-3 grid, landmarks, boundaries), title bar (C2-4), Outline (C2-5), Inspector and review note (C2-6, C2-7); §7.2 Hybrid anatomy (C2-10, C2-11, C2-12, C2-14); §7.3 overview rendering (C2-10, C2-11) and lists (C2-5, C2-12); §7.6.1 lanes, density, bands, semantic zoom (C1-13 layout rendered by C2-10/C2-11; presets C2-14); §7.6.2 interactions (C2-11); §7.6.3 spine rows, finding rows, virtualization, scroll sync (C2-12, C2-13); §7.8 store use, defaults on open, regroup note, location (C2-3, C2-6); §7.9 keyboard (C2-8; overview arrows C2-11); §7.10 live follow (C2-2 hold, C2-4 pill, C2-11 camera, C2-12 follow, C2-14 tests); §7.11 states (C2-2, C2-4, C2-5, C2-7, C2-12); §7.12 tokens and graphics use (all CSS Modules; C1-1's scan covers them); §7.13 accessibility (roles and tab stops in C2-5, C2-8, C2-11, C2-12; VoiceOver by hand at the M4a exit, C2-16 Step 6, base index gap G3); §8 only `ViewerHost` (C2-3, C2-6); §10 marks and HUD (C2-3, C2-8, C2-11, C2-12, C2-15, C2-16); §11 jsdom and smoke (every task, C2-16); §12 M4a exit (above). Canvas, the `<Activity>` switch tests and M5 are other lanes.
- **Known limits carried as risks, not gaps.** The overview's sliders and pins are reachable by pointer and by the playhead's own arrow keys once focused, but `main` keeps a single tab stop on the spine, so a keyboard-only reader moves the playhead with `,`/`.` and the brush with `{`/`}`/`b`, and a VoiceOver reader reaches the sliders through the rotor (C2-16 Step 6 checks it). The Inspector footer buttons are native tab stops beside the tab list's roving stop.
