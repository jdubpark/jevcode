# Trace Viewer UI: Interfaces, File Map and Lane Index (C1a, C1b, C2, C3a, C3b, Da, Db) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This index holds no steps. Each UI lane file (section 0) holds the TDD steps for its tasks and copies the interfaces below verbatim.

**Goal:** Fix every cross-lane contract for the trace viewer UI (M4a Hybrid, M4b Canvas, M5 Electron), so seven subagent-driven controllers can build it in parallel git worktrees without editing each other's files, and list the exact amendments the UI needs from W0, A2 and B.

**Architecture:** The viewer lives in `packages/trace-viewer/src/{layout, ui, sources}` beside the model (`src/model`, lane B). `layout` is pure and React-free; `ui` is React 19.2 with CSS Modules and `--tv-*` tokens; `sources` adapts a `TraceBundle` into the session-bound `TraceSource` port. Hosts are the Vite dev host (`apps/trace-viewer-dev`, M4a) and a separate Electron `BrowserWindow` (`trace.html`, M5). Lanes C1a and C1b build the visual primitives and the pure core in W1 beside A1, A2 and B; C2 (shell + Hybrid = M4a), C3a (pure canvas layout) and Da (Electron main process) run in W2; C3b (Canvas view + view switch = M4b) and Db (trace window, live, parity = M5) run in W3.

**Tech Stack:** TypeScript 5.9 (NodeNext for packages, Bundler for the two hosts, strict, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`), React 19.2.3 (`<Activity>`, `useSyncExternalStore`, `startTransition`), `@tanstack/react-virtual` 3.14.13 (resolves `@tanstack/virtual-core` 3.17.11), zod 3.25, Vite 5.4.21 + `@vitejs/plugin-react` 4.7.0, vitest 3.2 + jsdom 30.1.0 + `@testing-library/react` 16.3.3 + `@testing-library/user-event` 14.6.7, fast-check 4.10.1, Electron 33, ESLint 9.39 flat config.

**Spec:** `docs/superpowers/specs/2026-09-28-trace-viewer-design.md` §7 (Viewer UI) and §8 (Electron), plus §6 where the UI reads model fields, §10 budgets, §11 tests, §12 exits and §16 spike. Binding record: `/private/tmp/claude-501/-Users-jwpark-Projects-jevcode/af01125e-e02e-4dbc-9196-45e1be6cf15a/scratchpad/decisions.md` (R13–R29 are the UI decisions). Base index: `docs/superpowers/plans/2026-09-28-trace-viewer-interfaces.md` (W0, A1, A2, B); this file reuses its names, package names (`@jevcode/trace-viewer`, `jevcode-trace-viewer-dev`), worktree rules and section 5 gotchas. Visual target: `docs/superpowers/specs/2026-09-28-trace-viewer-mockups/{hybrid.html, hybrid-1440.png, canvas.html, canvas-1440.png}`. On any conflict the decision record wins, then the spec, then the base index, then this file, then a lane file. Section 1.6 lists every place this file deliberately differs from the spec, with the reason.

## Global Constraints

- Everything in the base index's Global Constraints applies unchanged (Node ≥ 22, zod 3 in `@jevcode/trace-viewer`, no SQL migration, the viewer never writes, stable ids per R9, commits, worktrees, zsh `${var}:suffix`).
- R17: `packages/trace-viewer` takes **no** `@xyflow/react` dependency. Both views use one hand-rolled DOM viewport: `layout/viewport.ts` (pure math, `Camera = {mode: "uniform", tx, ty, k} | {mode: "xOnly", u0, k}`) and `ui/viewport/controller.ts` (native `wheel` listener with `{passive: false}`; Ctrl/Meta+wheel zooms at the cursor, factor `2^(−deltaY · 0.02)` clamped per event to [0.8, 1.25]; other wheel, Space-drag, hand tool and middle-drag pan; one rAF write per frame; settle 150 ms after the last input rounds `tx`/`ty` and writes `--tv-inv-k`; gesture-time `will-change` only). Fallback on spike risk 1 failure: `d3-zoom` 3.0.0 behind the same controller API. Canvas camera writes (C3-10 review I-1, C3-11): the world layer `[data-tv-world]` gets a direct `transform`; `--tv-tx`, `--tv-ty` and `--tv-k` are written only on the overlay root `[data-tv-overlay]` (labels, handles, time chip, badges); `--tv-inv-k` only on `[data-tv-world]`, at settle and at a tween's end (`INV_K_EVERY_FRAME = false`); `--tv-kw`, the label width scale, on the overlay at settle only. Nothing inherited is written above the world, so a camera frame restyles no card or edge, and probes read the camera from the overlay.
- R19: `layout` imports `model`, never the reverse; `ui` imports `layout` and `model`; `layout` never imports `ui`, React, the DOM or timers (ESLint enforces it, section 1.1).
- R15/D8: CSS Modules consuming `var(--tv-*)` only; tokens are inline custom properties on the Shell root; light only; no global CSS except `:global(.d2h-*)` rules nested under one Inspector class; the trace window never loads `apps/desktop/src/renderer/styles.css`. System font stack `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`; mono `ui-monospace, "SF Mono", Menlo, monospace` for paths, commands and code only. 12 px minimum text; no ALL-CAPS and no eyebrow labels; `tabular-nums` on every number.
- D8/R24 color: accent `#2F6BFF` = selection, focus, playhead, brush, one primary action; `#E5484D` = real problems only (failed test or check, agent failure, critical finding, guardrail hit) and every red mark also differs in shape or carries a word; `#2E9E6A` = tiny pass marks only, never text; diffs neutral (added solid `--tv-ink-2`, removed hollow `--tv-ink-3`), never green or red; no per-kind colors; no dimming after the playhead or outside the brush in v1.
- `--tv-ink-4` (`#9AA0AB`) is decoration only; no CSS Module may use `var(--tv-ink-4)` in a `color` declaration (enforced by `tokens.test.ts`, C1-1).
- Agent-written text renders only as React text nodes. `dangerouslySetInnerHTML` appears only inside ui-catalog `CodeDiff`. Agent text never renders in the title bar, chips, badges or finding-title slots. Commands, paths and output tails pass through the model's `displayUntrusted` (section 1.4, B-1 amendment).
- Keys match `event.code`, are ignored while `event.isComposing`, in `input`, `textarea` and `[contenteditable]`, and with any modifier not listed in the keymap (section 2.4).
- Every region (Outline, `main`, Inspector) is one tab stop with a roving tabindex. `prefers-reduced-motion` sets every duration to 0, including view-switch and level-switch animations.
- R16/R22 live rules: a running session (`starting`, `running`, `waiting_decision`) opens in Live, `paused` and terminal ones in Review; any camera gesture, drag, `,`/`.`, zoom key or non-tail selection switches to Review (announced once); applies wait for a gesture to end and the latest session wins; `terminal(state) = state === "completed" || state === "failed"`.
- The viewer reads only through `TraceSource` and writes nothing. `ViewerHost.requestChanges` is the only outbound call, and only the Electron host implements it.
- No UI lane edits any `package.json` dependency block, any `exports` map, `pnpm-lock.yaml` or `eslint.config.mjs`. Every such need is in section 1 and lands in W0. A UI task that finds another missing dependency stops and escalates.
- Tests: `layout/*.property.test.ts` and `ui/state/*.property.test.ts` use fast-check; component tests start with `// @vitest-environment jsdom`, stub their own `getBoundingClientRect` and `ResizeObserver` per test, and install no global fakes; `paint.ts` runs against a recording 2D context. Expected values come from the spec's tables and the fixtures' known content (oauth's failed `pnpm test` 14/1/0, the claim at +0:43), never from the implementation.
- Budgets (spec §10, R26), measured per spec §10 "Method": soak first paint ≤ 300 ms and full load ≤ 2 s (M4a); `j` to painted p95 ≤ 16.7 ms from the keydown's `timeStamp` to the next painted frame, presses from a macrotask at a random frame phase, with the zero-work baseline `tv:key-to-paint-baseline` (dev host only) reported beside it (M4a); overview layout + paint at Session level p95 ≤ 4 ms with ≤ 150 overlay nodes (M4a); anchor drift ≤ 1 px (smoke); `layoutCanvas` fresh ≤ 2 ms and sticky ≤ 0.5 ms (benchmark); canvas pinch at Step level ≤ 5% frames dropped in Electron 33 (M4b); view switch restored in the toggle's frame, never a 0 × 0 fit (M4b); live tick p95 ≤ 16 ms and soak open in the trace window first paint ≤ 500 ms, full load ≤ 3 s (M5).
- Commits: one conventional commit per task (`feat(trace-viewer): …`, `test(trace-viewer): …`, `feat(desktop): …`, `fix(ui-catalog): …`), listing the task's files explicitly in `git add`. Never add a `Claude-Session:` trailer. Never run `git stash`; set work aside with a WIP commit.

## Review Focus

Six inputs no happy-path test exercises. The owning task adds the named test (section 3 repeats it).

1. **A live append while the reader is scrolled away in Review and mid-gesture.** Expected: the newest session is held until the gesture ends and applied once (latest wins); the anchored spine row and the anchored canvas frame move ≤ 1 px; DOM focus never moves; "N new" rises; a collapsed critical finding stays collapsed. Tests: **C2-2** `data-controller.test.ts` "holds applies during a gesture and applies the latest once"; **C1-11** `view-state.property.test.ts` "a collapsed critical finding stays collapsed across session/applied"; **C2-16** smoke `?selftest=drip` drift ≤ 1 px; **C3-10** `canvas-view.test.tsx` "an append leaves every placed frame's rect unchanged".
2. **A re-cluster renames the selected unit** (`unit:u1` becomes `unit:u2` with the same anchor seq). Expected: selection, `expanded`, `collapsed` and a `chapter` brush follow through `ch:<anchorSeq>`; the Inspector shows "Regrouped into '<title>'"; the canvas frame keeps its rect. Tests: **C1-11** "regrouped selection follows the anchor seq"; **C3-2** "a unit whose id changes keeps its key, rect and selection".
3. **A pre-M1 session**: no chapters at all, exit −1 on a command, an unpaired start, `coverage.approximateJoins`. Expected: Hybrid bands, presets and brush snapping use turns wherever the spec says chapter; the command reads "exit unknown" with status `unknown`, never red; the `≈ Approximate joins` and "N gaps" chips show and are never red. Tests: **C1-13** `overview-layout.test.ts` "turns stand in for chapters"; **C1-14** `spine-rows.test.ts` "exit -1 is unknown, never failed"; **C2-4** `title-bar.test.tsx` "data-quality chips are neutral".
4. **Hostile agent text**: an assistant message holding a ```` ``` ```` fence, `<img src=x onerror=alert(1)>`, a U+202E override inside a command, and the literal string "Claim contradicts tests". Expected: every string renders as text; the review note's fence is one backtick longer than the longest run inside it; the bidi character shows as `⟨U+202E⟩`; the Inspector title comes from `FINDING_TITLE`, never from agent text. Tests: **C2-6** `review-note.test.ts` "fences quoted text longer than any backtick run inside it" and `inspector.test.tsx` "agent text never fills the title slot"; **C2-1** `components.test.tsx` "a diff line with markup renders as text".
5. **Keyboard edge cases**: a Hangul input source (`key: "ㅓ"`, `code: "KeyJ"`), `isComposing: true`, Space with focus in `main`, Cmd+C with a text selection. Expected: `ㅓ` moves like `j`; composing keys do nothing; Space pans and never activates a button in `main`; Cmd+C with selected text copies the text, not the review note. Tests: **C1-12** `keymap.test.ts`; **C2-8** `keyboard.test.tsx`.
6. **A view hidden under `<Activity>` at width 0.** Expected: `ResizeObserver` entries with width 0 are ignored; switching back restores the saved camera exactly when `syncedRev === focusRev`; no fit ever runs against a 0 × 0 rect; the hidden view runs no rAF callbacks. Tests: **C3-11** `view-switch.test.tsx` "never fits a 0x0 rect" and "a hidden view holds no listeners".

---

## 0. How to use this index

**Lane files.** Each lane file is a full writing-plans document (header, Global Constraints copied from above, its Review Focus lines, then tasks with Files / Interfaces (Consumes, Produces) / checkbox TDD steps with complete code and exact commands).

Three lane files hold two lanes each, one per part. Each part runs under its own controller in its own worktree and executes only its own tasks. The master index is `docs/superpowers/plans/2026-09-28-trace-viewer-00-index.md`.

| Lane | Wave | Milestone | File and part | Tasks | Branch | Worktree |
|---|---|---|---|---|---|---|
| C1a visual primitives | W1 | M4a | `docs/superpowers/plans/2026-09-28-trace-viewer-05-viewer-foundation.md`, Part A | C1-1 to C1-4 | `tv/c1a-visual-primitives` | `/Users/jwpark/Projects/jevcode-tv-c1a` |
| C1b viewer core + spike | W1 | M4a | `docs/superpowers/plans/2026-09-28-trace-viewer-05-viewer-foundation.md`, Part B | C1-5 to C1-15, C1-7F (conditional) | `tv/c1b-viewer-core` | `/Users/jwpark/Projects/jevcode-tv-c1b` |
| C2 shell + Hybrid | W2 | M4a | `docs/superpowers/plans/2026-09-28-trace-viewer-06-viewer-shell-hybrid.md` (whole file) | C2-0 to C2-16 | `tv/c2-shell-hybrid` | `/Users/jwpark/Projects/jevcode-tv-c2` |
| C3a canvas layout (pure) | W2 | M4b | `docs/superpowers/plans/2026-09-28-trace-viewer-07-canvas-view.md`, Part A | C3-1 to C3-4 | `tv/c3a-canvas-layout` | `/Users/jwpark/Projects/jevcode-tv-c3a` |
| Da Electron main process | W2 | M5 | `docs/superpowers/plans/2026-09-28-trace-viewer-08-electron-live.md`, Part Da | D-1, D-2 | `tv/da-electron-main` | `/Users/jwpark/Projects/jevcode-tv-da` |
| C3b Canvas view + switch | W3 | M4b | `docs/superpowers/plans/2026-09-28-trace-viewer-07-canvas-view.md`, Part B | C3-5, C3-9, C3-6, C3-7, C3-8, C3-10, C3-11, C3-12 (file order) | `tv/c3b-canvas-view` | `/Users/jwpark/Projects/jevcode-tv-c3b` |
| Db trace window + live | W3 | M5 | `docs/superpowers/plans/2026-09-28-trace-viewer-08-electron-live.md`, Part Db | D-3 to D-8 | `tv/db-trace-window` | `/Users/jwpark/Projects/jevcode-tv-db` |

**Rules for lane-file writers.**
- A task may touch only the files listed for it in section 3. Adding a file needs an edit to this index first.
- Sections 1 and 2 are the only source of cross-lane names and types. Copy signatures verbatim into each task's Interfaces block. A lane may add private helpers and optional fields; renaming or removing anything in section 2 needs an edit here.
- Every task ends green on its targeted tests plus the root checks in section 5, and ends with one commit.
- Read the real file before writing a step that modifies it, and quote the current snippet as the anchor.

---

## 1. Required amendments to W0, A2 and B

These are exact texts a later amend step pastes into the base index (section and task named on each) and into the lane files 01 (W0), 03 (A2) and 04 (B, not yet written). Everything else the UI needs is already in the base index; section 1.5 lists what was checked and found present.

### 1.1 W0-1: dependencies, exports, dev-host config, ESLint

**(a) `packages/trace-viewer/package.json`** (base index §2.2 manifest table, the package.json block, and lane 01 W0-1 "Dependencies"). Replace the `dependencies` block and add two dev dependencies and one export:

```json
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
  "dependencies": {
    "@jevcode/contracts": "workspace:*",
    "@jevcode/ui-catalog": "workspace:^",
    "@tanstack/react-virtual": "3.14.13",
    "d3-selection": "3.0.0",
    "d3-zoom": "3.0.0",
    "zod": "^3.24.1"
  },
```

and in `devDependencies` add `"@types/d3-selection": "3.0.12"` and `"@types/d3-zoom": "3.0.8"`.

Why: R17 removes `@xyflow/react` from the viewer (it stays locked through ui-catalog, so the single-version grep output is unchanged). `d3-zoom` 3.0.0 is the R17 fallback for spike risk 1 (C1-7F), and no UI lane may add it later; `d3-selection` 3.0.0 is its required peer for `select(el).call(zoom)`. All four versions are already in `pnpm-lock.yaml` (`d3-zoom@3.0.0` :1348, `d3-selection@3.0.0` :1334, `@types/d3-zoom@3.0.8` :961, `@types/d3-selection@3.0.12` in the store), so no new tarball appears. `./sources` lets `apps/desktop` tests import `createStaticBundleSource` and `readAllTraceRows` without loading the React barrel and its `.module.css` imports (D-7). Lane 01 W0-1's lockfile numstat expectation (`125 0 pnpm-lock.yaml`) must be re-measured after this edit; the "only new tarballs" sentence stays true.

Ruling (2026-10-01, lane Db review I-1): the exports map also carries `@jevcode/trace-viewer/data-controller` → `createDataController` (`./dist/ui/shell/data-controller.js`). Its only consumer is the desktop `trace-parity` test, which runs in Node and cannot import the root barrel (React, CSS Modules). Additive: no dependency or lockfile change.

Add one verification step to W0-1 after `pnpm install`:

```bash
grep -c "anchorTo?: ScrollAnchor\|followOnAppend?: FollowOnAppend\|scrollEndThreshold?: number" node_modules/.pnpm/@tanstack+virtual-core@3.17.11/node_modules/@tanstack/virtual-core/src/index.ts
```

Expected: `3` (verified on the 3.17.11 tarball on 2026-09-28, lines 369-371; `isAtEnd` is at :1856). If the resolved virtual-core is not 3.17.11 or the count is not 3, W0-1 stops and escalates (spec §16 risk 7).

**(b) `packages/ui-catalog/package.json`** (new W0-1 edit; the base index §1 file map line "`apps/desktop/package.json` mod" gains a sibling line). Add to `exports`:

```json
    "./components/*": {
      "types": "./dist/components/*.d.ts",
      "import": "./dist/components/*.js"
    }
```

Why: the Inspector's Evidence tab imports `@jevcode/ui-catalog/components/CodeDiff` (spec §7.1), the only form W0's lint allows (`TRACE_VIEWER_PATHS`). `tsc -p packages/ui-catalog/tsconfig.json` already emits `dist/components/CodeDiff.{js,d.ts}`.

**(c) `apps/trace-viewer-dev/vite.config.ts`** (base index §2.2 dev host block). Replace the `build` line:

```ts
  build: { outDir: "dist", emptyOutDir: true, assetsInlineLimit: 0 },
```

Why: spec §8.2. `default-src 'self'` blocks `data:` URIs, so no asset may be inlined.

**(d) `eslint.config.mjs`** (base index §2.2 "ESLint boundaries"). Add one constant above `export default`:

```js
const LAYOUT_PURE_GLOBALS = [
  "window", "document", "navigator", "requestAnimationFrame", "cancelAnimationFrame",
  "ResizeObserver", "MutationObserver", "getComputedStyle", "localStorage", "sessionStorage",
  "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date",
].map((name) => ({
  name,
  message: "src/layout is pure: no DOM, timers or clocks; take time as numbers (R19).",
}));
```

In the existing `packages/trace-viewer/src/model/**/*.ts` block, append one pattern to its `patterns` list:

```js
          { regex: "(^|/)layout(/|$)", message: "src/model never imports src/layout (R19)." },
```

Append this block after the model block:

```js
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
```

(`NO_NODE_GLOBALS` is lane 01's deviation 2 constant; if the amend step finds it absent, drop that spread.) Add these rows to the `lint-boundaries.test.ts` table:

| filePath (repo-relative) | code | expected ruleIds |
|---|---|---|
| `packages/trace-viewer/src/layout/probe.ts` | `import { useState } from "react"; export const x = useState;` | `["no-restricted-imports"]` |
| `packages/trace-viewer/src/layout/probe.ts` | `import { Shell } from "../ui/shell/Shell.js"; export const x = Shell;` | `["no-restricted-imports"]` |
| `packages/trace-viewer/src/layout/probe.ts` | `export const x = () => document.body;` | `["no-restricted-globals"]` |
| `packages/trace-viewer/src/layout/probe.ts` | `export const x = () => Date.now();` | `["no-restricted-globals"]` |
| `packages/trace-viewer/src/layout/probe.ts` | `import { LANES } from "../model/index.js"; export const x = LANES;` | `[]` |
| `packages/trace-viewer/src/layout/probe.test.ts` | `export const x = () => document.body;` | `[]` |
| `packages/trace-viewer/src/model/probe.ts` | `import { buildTimeScale } from "../layout/time-scale.js"; export const x = buildTimeScale;` | `["no-restricted-imports"]` |

### 1.2 W0-6: model types and `TraceSource`

**(a) `packages/trace-viewer/src/model/types.ts`** (base index §2.3). Six insertions, one replacement:

After `export type Lane = (typeof LANES)[number];` insert:

```ts
/** Semantic zoom levels shared by both views (R20). */
export const LEVELS = ["session", "chapter", "step"] as const;
export type Level = (typeof LEVELS)[number];
```

In `interface CommandDetail`, after `destructivePattern?: string;` insert:

```ts
  /** Last 20 lines of stdout then stderr, at most 2,048 UTF-16 code units; command, test and check steps (spec §6.2). */
  outputTail?: string;
```

In `interface DecisionDetail`, after `decidedBy?: "supervisor" | "delegated";` insert:

```ts
  /** seq of the supervisor's answer message absorbed into this step (R25, spec §6.6 "Decision answers"). */
  answerSeq?: number;
```

In `interface Step`, after `endTs: string | null;` insert:

```ts
  /** Epoch ms of the first row's source time, unclamped; originMs + tMs for a step opened by a non-clock row (spec §6.5). */
  startMs: number;
```

In `interface Turn`, after `stepIds: StepId[];` insert:

```ts
  /** The turn's last assistant message with a non-negated success-lexicon match (R25, spec §6.6). */
  claimStepId?: StepId;
  /** The first assistant message before the turn's first edit that matches the plan rule (spec §6.6). */
  planStepId?: StepId;
```

In `interface Chapter`, replace `triad: { importance?: number; relevance?: number; interruption?: number };` with the lines below, which also add the three canvas fields:

```ts
  triad: { importance?: number; relevance?: number; interruption?: number; clientKind?: JevClientKind };
  /** Every file edit is formatting-only or a lockfile, or the latest Pass A row has shouldSurface: false (R25). */
  noise: boolean;
  /** False when the latest version's status is "superseded" (R25). */
  current: boolean;
  /** Steps that the unit's validationResults attached to, ascending by firstSeq (R25). */
  validationStepIds: StepId[];
```

In `interface Finding`, after `evidenceSeqs: number[];` insert:

```ts
  /** The step holding anchorSeq: the row, frame and pin that carry the finding (R25). */
  anchorStepId: StepId;
  /** claim_contradicted only: the claim step (equals anchorStepId). */
  claimStepId?: StepId;
  /** claim_contradicted only: the latest failed test or check step before the claim in its turn. */
  evidenceStepIds?: StepId[];
  /** claim_contradicted only: [start, end) UTF-16 offsets of the first non-negated lexicon match in the claim step's text; omitted when the match ends past the 2,000-grapheme text cut. */
  claimSpan?: [number, number];
```

In `interface TraceSession`, after `loadedThroughSeq: number;` insert:

```ts
  /** Epoch ms of display-clock zero: the first clock row's source time, else Date.parse(meta.startedAt) (spec §6.5). */
  originMs: number;
```

In `type GraphicSpec`, replace the `diff`, `duration` and `claim` members with:

```ts
  | {
      kind: "diff";
      added: number;
      removed: number;
      /** Chapters: per file, ordered by lines changed, at most 4 (spec §7.5 "DiffBar shows the top 4 files and +k"). */
      files?: { path: string; added: number; removed: number }[];
      moreFiles?: number;
    }
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
      kind: "claim";
      claim: { text: string; span?: [number, number]; tMs: number };
      observed: { passed: number; failed: number; command: string; tMs: number };
    };
```

and replace the `table` member with the spec §6.2 shape (clustering emits `schemaChanges: []`, and v1 has no foreign keys):

```ts
  | { kind: "table"; tables: { name: string; role: "new" | "altered"; columns: number }[] }
```

`JevClientKind` is already in the file's `@jevcode/contracts` type import. `types.test.ts` gains: `LEVELS` equals `["session", "chapter", "step"]`.

**(b) `packages/trace-viewer/src/source.ts`** (base index §2.3). Replace the whole file with the spec §7.7 session-bound port:

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

Why: spec §7.7 and §8.3 define the port as session-bound with `summary()` and `now()`; the viewer needs both (title while loading, `liveTMs = max(last step tMs, source.now() − originMs)`). `TraceListSessionsRequest`, the old `TraceRowsRequest` and `TracePayloadsRequest` are deleted; nothing outside W0-6 imports them. `source.test.ts` keeps its three behaviors against the new shape: `cursorAfter` returns `nextAfterSeq` when set and `lastSeq` when `null`; an object literal with `sessionId` and the four methods type-checks as `TraceSource`; the Review Focus 5 reader (lane 01) calls `rows({ afterSeq })` without a session id.

### 1.3 A2: `sessionId` lookup on `trace:listSessions`

Spec §5.4 lists `trace:listSessions {repoId?, sessionId?, limit ≤ 500}` and §11 M2 requires "a zero-event session is readable by exact id"; the base index omits `sessionId`. `createIpcTraceSource.summary()` (D-3) and the `trace:requestChanges` handler (D-2) depend on it.

- **A2-1** `packages/storage/src/trace-reader.ts`: `ListTraceSessionsOptions` becomes `{ repoId?: string; sessionId?: string; limit: number }`. With `sessionId`, the query adds `AND s.id = ?`, returns at most that one session, and does **not** hide it when `lastEventSeq = 0`. Test: "lists a zero-event session by exact id" (`listSessions({ sessionId, limit: 1 })` returns it with `lastEventSeq: 0`; `listSessions({ limit: 10 })` still hides it).
- **A2-2** `apps/desktop/src/main/trace-service.ts`: `TraceService.listSessions(request: { repoId?: string; sessionId?: string; limit?: number })` passes `sessionId` through.
- **A2-3** `apps/desktop/src/shared/local-channels.ts`: `TraceListSessionsPayloadSchema` gains `sessionId: z.string().min(1).optional(),`. Test in `ipc-registry.test.ts`: `parseToMain("trace:listSessions", { sessionId: "" })` throws `INVALID_PAYLOAD`.
- **A2-4** `apps/desktop/src/shared/api.ts`: `trace.listSessions(request?: { repoId?: string; sessionId?: string; limit?: number })`. Delete the sentence "structurally a `TraceSource`, so the M5 lane can pass `window.jevcode.trace` directly"; M5 adapts it with `createIpcTraceSource(bridge.trace, sessionId)`.

### 1.4 B: model fields, derivations and helpers the UI reads

Lane file 04 is not written yet; its writer folds these into the named tasks. Each line names the test that pins it.

- **B-1** `model/format.ts` adds three exports from spec §6.8:

```ts
/** Trim, unwrap one `bash -lc '…'` or `zsh -lc '…'`, collapse runs of whitespace to one space. */
export function normalizeCommand(command: string): string;
/** "exit 0", "exit 1", "exit unknown" for -1, "" for null. */
export function exitLabel(exitCode: number | null): string;
/** Replaces U+202A–U+202E, U+2066–U+2069, U+200E, U+200F and C0 controls (except \t, and \n when multiline) with a visible ⟨U+XXXX⟩ token. */
export function displayUntrusted(text: string, options?: { multiline?: boolean }): string;
```

  `stepHeadline` and `truncateMiddle` call `displayUntrusted`. Tests: `normalizeCommand("bash -lc 'pnpm  test'")` is `"pnpm test"`; `exitLabel(-1)` is `"exit unknown"`; `displayUntrusted("rm ‮fdp.exe")` is `"rm ⟨U+202E⟩fdp.exe"`.
- **B-2** `model/registry.ts` pins `KIND_META[kind].lane` over `LANES`: instruction, approval, decision → `supervisor`; message, reasoning, tool, lifecycle → `agent`; command → `commands`; edit, read, dependency, revert → `edits`; test, check → `tests`; guardrail, attention → `jev`. `registry.test.ts` asserts this table literally.
- **B-3** fold core: `Step.startMs` and `TraceSession.originMs` per spec §6.5; `CommandDetail.outputTail` from `command_completed` stdout then stderr (last 20 lines, ≤ 2,048 code units); `FinalizeOptions` gains `nowMs?: number` (epoch ms from `source.now()`), and an open step while `live` gets `durationMs = nowMs − startMs` (spec §6.5). Tests: on oauth, the first step's `startMs` equals `Date.parse` of the first agent_event payload `ts` and `originMs` equals it; for every step `tMs === Math.max(startMs − originMs, previous tMs, 0)`; a live open command with `nowMs = startMs + 4_000` has `durationMs` 4000.
- **B-5** chapters and decisions: decision steps set `target = decisionId`; a `role: "user"` `agent_message` is absorbed into decision D per spec §6.6 "Decision answers" (its seq joins D's step, `decision.answerSeq` = that seq, the provisional instruction step is removed); `Chapter.noise`, `Chapter.current`, `Chapter.validationStepIds` and `triad.clientKind` per spec §6.6 "Chapters". Tests: on oauth exactly one `decision` step holds the seq of the user message between decision rows 37 and 39 and no `instruction` step has that message's text; a unit whose latest version is `superseded` has `current: false`; a unit whose only edits are the lockfile has `noise: true`.
- **B-6** `model/classify.ts` exports `matchSuccessClaim(text: string): [number, number] | null` (spec §6.6 "Claim versus evidence" lexicon, negation window and `\b…\b` wrapping) and sets `Turn.claimStepId` and `Turn.planStepId` (spec §6.6 "Plan and claim"). Tests: `matchSuccessClaim("OAuth implementation complete; all checks pass.")` returns the range of `"all checks pass"`; `"not all tests pass"`, `"tests passing"`, `"unverified"` and `"isn't passing"` return `null`; on oauth `turns[0].planStepId` is the step of line 8 (`Plan:`) and `turns[0].claimStepId` is the claim step at +0:43.
- **B-7** `FindingDraft` gains `anchorStepId: StepId; claimStepId?: StepId; evidenceStepIds?: StepId[]; claimSpan?: [number, number];`, copied to `Finding`. `model/signals.ts` exports:

```ts
/** Rule rank inside a severity (spec §6.7 FINDING_ORDER). */
export const FINDING_RULE_RANK: { readonly [K in SignalId]: number };   // claim_contradicted 0, destructive_command 1, failing_tests 2, guardrail_clamp 3, recovery_arc 4
/** Severity (critical > warning > info), then FINDING_RULE_RANK, then anchorSeq ascending, then id. */
export function compareFindings(a: Finding, b: Finding): number;
```

  Tests: every finding's `anchorStepId` names the step whose `seqs` include `anchorSeq`; on oauth the `claim_contradicted` finding has `claimStepId === anchorStepId`, `evidenceStepIds` = [the `pnpm test` step], and `text.slice(...claimSpan)` is `"all checks pass"`; `[...findings].sort(compareFindings)[0].ruleId` is `claim_contradicted` on oauth and api-break.
- **B-10** `pickGraphic` and `describeGraphic` live in `model/format.ts` (R25), not `model/graphics.ts`; B-10's file list becomes `{search.ts, search.test.ts, lookup.ts, lookup.test.ts, format.ts, format.test.ts, index.ts}`. They produce and describe the amended `GraphicSpec` (section 1.2). `pickGraphic` for a chapter follows spec §7.12 `CHAPTER_GRAPHIC` order (schema → table; architecture, api → flow; tests → tests; answered decision → fork; else diff). Tests: `describeGraphic({ kind: "tests", passed: 14, failed: 1, skipped: 0 })` is `"14 passed, 1 failed"`; `describeGraphic({ kind: "diff", added: 17, removed: 3 })` is `"+17 −3"`; `describeGraphic({ kind: "duration", durationMs: 5_000, running: false, status: "failed", end: "bad_dot" })` is `"5.0 s, failed"`; `pickGraphic` of oauth's `pnpm test` step is `{ kind: "tests", passed: 14, failed: 1, skipped: 0 }`.

### 1.5 Checked and already present (no amendment)

- `Step.tMs` (monotone display clock), `Step.lane`, `Step.endTMs`, `Chapter.evidenceLinks {cited, resolved, approx}`, `Chapter.tMs`/`endTMs`, `EditDetail.diffSeq` and `DiffState`, `Coverage.approximateJoins`, `Hidden.unreceived`: base index §2.3.
- `KIND_META` with a `lane` per kind: base index §2.6 B-2 (the lane table is pinned in section 1.4).
- `@tanstack/react-virtual` 3.14.13 (exact) resolving `@tanstack/virtual-core` 3.17.11 (`npm view @tanstack/react-virtual@3.14.13 dependencies` prints `{ '@tanstack/virtual-core': '3.17.11' }`), jsdom 30.1.0, `@testing-library/react` ^16.3.3, `@testing-library/user-event` 14.6.7, fast-check 4.10.1, `src/css-modules.d.ts`, `scripts/copy-assets.mjs`, the dev host's Electron CSP and node-builtin guard: base index §2.2.
- `tsconfig.build.json` already excludes `src/test-support/**`, `*.test.ts(x)` and `*.bench.ts`; the ESLint trace-viewer blocks already ignore `src/test-support/**`. UI test helpers therefore live in `src/test-support/`.
- `React.Activity` exists in react 19.2.3 and `@types/react` 19.3.0 (`export const Activity: ExoticComponent<ActivityProps>`, index.d.ts:2022).
- Vitest returns stable proxy class names for `*.module.css` when CSS processing is off (its default), so component tests query by role and label, never by class.

### 1.6 Deliberate differences from the spec

| Spec says | This plan | Why |
|---|---|---|
| §6.2 model shape (`Step.turn`, `entityKeys`, `noise: {reason}`, kind `jev`, decision step id `decision:<id>`, `TraceMeta`) | The base index's W0 shape (`turnIndex`, `entityIds`, `noise: NoiseReason \| null`, kinds `guardrail` and `attention`, decision steps keep `step:<firstSeq>` and `decision:<id>` resolves to them) plus section 1.2 | The base index is what W0 and B implement. The UI's selection holds `step:` and `unit:` ids only (`SelectionId`); a `decision:` id from a location resolves through `resolveStableId` |
| §6.8 `toneOf` in `model/format.ts` | `layout/tone.ts` (C1-10) | W1's overview index and spine rows need it before B merges; it reads only W0 fields. One definition, used by every view |
| §6.2 `KIND_META.icon`, `IconName` and `CATEGORY_META` in `model/kinds.ts` | `IconName`, `KIND_ICON`, `LANE_ICON`, `CATEGORY_ICON` in `ui/icons` | Base index §2.3: "Icons are not part of the model"; `satisfies Record<StepKind, IconName>` still fails typecheck on a new kind |
| §7.7 `src/testing/` | `src/test-support/` | W0's `tsconfig.build.json` and ESLint ignores already cover `src/test-support/**` |
| §7.7 root `vite.workspace-src.ts` aliasing contracts and ui-catalog to `src` | No alias for contracts or ui-catalog; the dev host aliases `@jevcode/trace-viewer` to its `src` for `vite` serve only (C2-15) | W0 made every package dist-only and every vitest config a plain include list (base index §5.1); aliasing contracts in trace-viewer tests would load two copies beside semantic-core's dist copy. Serve-only aliasing gives HMR without touching build, preview or tests |
| §12 wave table (viewer foundation incl. shell, Outline, Inspector in W1; Hybrid and Canvas views in W2) | Shell, Outline and Inspector in W2 with Hybrid (C2) | They call B's runtime (`formatOffset`, `pickGraphic`, `describeGraphic`, `searchSteps`, `compareFindings`, the fold), which does not exist until B merges |
| §7.8 `ViewState.selection: StableId` | `SelectionId = StepId \| UnitStableId` | See the first row |
| §7.8 `TraceViewer({source, host?, location?})` | Adds `pollMs?` | The DataController polls every 1 s over IPC and every `drip.intervalMs` for a drip source (spec §5.5); the host knows which |
| §10 budget results "go to docs/perf.md" | M4a and M4b record results in `docs/spikes/trace-viewer-spike.md`; D-8 copies every UI budget to `docs/perf.md` and SPEC §13 | `docs/perf.md` is edited by A2-7 in W1 and by Db in W3; no W2 lane may touch it |

---

## 2. UI interface contract

Every path below is under `packages/trace-viewer/src/` unless it starts with `apps/`. Imports use `.js` specifiers (NodeNext). Model names come from `../model/index.js` (W0 types plus B's runtime exports).

### 2.1 Shared layout primitives (C1b)

#### `layout/viewport.ts` (C1-5)

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

/** screen = world · k + t */
export function worldToScreen(camera: UniformCamera, world: Point): Point;
export function screenToWorld(camera: UniformCamera, screen: Point): Point;
/** x = (u − u0) · k */
export function uToScreenX(camera: XOnlyCamera, u: number): number;
export function screenXToU(camera: XOnlyCamera, x: number): number;
/** Keeps the world point (uniform) or u (xOnly) under `anchor` fixed; k clamped to limits. */
export function zoomAt<C extends Camera>(camera: C, anchor: Point, factor: number, limits: ZoomLimits): C;
/** xOnly ignores dy. */
export function panBy<C extends Camera>(camera: C, dx: number, dy: number): C;
export function fitBounds(bounds: Rect, viewport: Size, options: { padding: number; limits: ZoomLimits }): UniformCamera;
export function fitRange(u0: number, u1: number, widthPx: number, options: { padFraction: number; limits: ZoomLimits }): XOnlyCamera;
/** Centers `world` at the current k. */
export function setCenter(camera: UniformCamera, world: Point, viewport: Size): UniformCamera;
/** Clamps k to limits and translation so `content` stays reachable (xOnly: u within [−pad, content.x + content.w + pad]). */
export function clampCamera<C extends Camera>(camera: C, content: Rect, viewport: Size, limits: ZoomLimits): C;
/** True when `rect` (world) lies inside the viewport inset by `inset` px. */
export function isInsideInset(camera: UniformCamera, rect: Rect, viewport: Size, inset: number): boolean;
export function easeOutCubic(t: number): number;
/** t ∈ [0, 1]; translation linear in eased t, k geometric. */
export function tweenCamera<C extends Camera>(from: C, to: C, t: number): C;
/** 2^(−deltaY · 0.02), line mode ×16, page mode ×viewportHeight, clamped to [0.8, 1.25]. */
export function wheelZoomFactor(deltaY: number, deltaMode: 0 | 1 | 2, pageHeight: number): number;
```

#### `ui/viewport/controller.ts` (C1-6; C1-7F swaps its internals to d3-zoom only if spike risk 1 fails)

```ts
import type { Camera, Point, Rect, Size, ZoomLimits } from "../../layout/viewport.js";

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

export function createViewportController<C extends Camera>(options: ViewportControllerOptions<C>): ViewportController<C>;
```

Wheel origin (C3-10 review I-2, C3-11 N-1): the controller measures its element's `getBoundingClientRect` once per gesture for the zoom anchor, not per wheel event, and clears the cached origin at settle, in `finishGesture`, on a wheel that changes nothing (a zoom at its limit) and on a `ResizeObserver` entry. Each controller owns one `ResizeObserver` on its element and disconnects it in `destroy()`, so the Hybrid overview's controller has one too.

#### `layout/time-scale.ts` and `layout/ticks.ts` (C1-9)

```ts
// layout/time-scale.ts — every time is display-clock ms (Step.tMs space)
export const IDLE_KNEE_MS = 10_000;
export const IDLE_LOG_MS = 5_000;
export const BREAK_MIN_MS = 60_000;
export const SESSION_BREAK_MIN_MS = 300_000;
/** g ≤ 10 s: g; else 10 s + 5 s · log2(g / 10 s). 20 s → 15 s, 60 s → 22.9 s, 5 min → 34.5 s, 1 h → 52.4 s. */
export function displayGapMs(gapMs: number): number;
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
export function buildTimeScale(input: TimeScaleInput): TimeScale;
export function timeScaleInputOf(session: TraceSession, liveTMs?: number): TimeScaleInput;
/** Monotone map between display time and screen x. */
export interface XMap { xOf(tMs: number): number; tOf(x: number): number }
/** Hybrid: x = (toU(t) − u0) · k. */
export function xOnlyXMap(scale: TimeScale, camera: XOnlyCamera): XMap;

// layout/ticks.ts
export const TICK_STEPS_MS: readonly number[];   // 1e3, 2e3, 5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5
export const MIN_TICK_LABEL_GAP_PX = 64;
export interface Tick { tMs: number; x: number; labeled: boolean }
export interface BreakMark { x0: number; x1: number; ms: number }
export interface TickOptions {
  /** Minimum px between labeled ticks (default MIN_TICK_LABEL_GAP_PX); it also picks the label step. */
  labelGapPx?: number;
  /** Unlabeled minor ticks at the finest step ≥ this many px apart that divides the label step. */
  minorGapPx?: number;
}
/** Ticks inside [x0, x1]; none inside breaks. A tick is labeled only on a multiple of the label step and ≥ labelGapPx
 *  after the previous label; a label replaces a minor tick that would crowd it across a break. */
export function computeTicks(map: XMap, scale: TimeScale, range: { x0: number; x1: number }, options?: TickOptions): { ticks: Tick[]; breaks: BreakMark[] };
```

The shared `Ruler` (C2-9, `ui/views/shared/Ruler.tsx`) keeps `RulerProps = { map, scale, widthPx, loadedThroughT, className? }` and gets its ticks from `rulerTicks` (`ruler-ticks.ts`), which is `computeTicks(…, { labelGapPx: RULER_LABEL_GAP_PX /* 120 */, minorGapPx: RULER_MINOR_GAP_PX /* 8 */ })`. `rulerLabel(tMs)` is `formatOffset` without the plus sign ("0:15"). C3b's `CanvasRuler` wraps this Ruler and draws `playheadT`, the band and `problemTs` itself in its own overlay (orchestrator ruling, W3 Ruler); the Ruler gains no props for them.

#### `layout/trace-index.ts` and `layout/tone.ts` (C1-10)

```ts
// layout/trace-index.ts
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
}
export function buildTraceIndex(session: TraceSession): TraceIndex;
export function emptyTraceIndex(sessionId: string): TraceIndex;
/** Inclusive seq range; "live" → loadedThroughSeq; a chapter brush with no chapter falls back to its turn. */
export function brushSeqRange(brush: Brush, index: TraceIndex): { fromSeq: number; toSeq: number };
export function effectivePlayheadSeq(playhead: Playhead, selection: SelectionId | null, index: TraceIndex): number;

// layout/tone.ts (spec §6.8 toneOf, placed here per section 1.6)
export type Tone = "neutral" | "bad" | "good";
/** The anchor rule (spec §7.1, §7.6.3), one implementation: step.findingIds holds findings anchored at the step and
 *  findings that only cite it. Only anchored ones title, tone, fill or open the step's surfaces; citing ones show as
 *  Related or evidence. Both lists in FINDING_ORDER. */
export function anchoredFindings(step: Step, findingsById: ReadonlyMap<FindingId, Finding>): Finding[];
export function citingFindings(step: Step, findingsById: ReadonlyMap<FindingId, Finding>): Finding[];
/** bad: failed test/check, agent_failed, a guardrail problem (critical clamp only), or anchoring a critical finding;
 *  good: passed test/check; a command with exit > 0 and a warning or info clamp stay neutral. Anchored findings only. */
export function stepTone(step: Step, findingsById: ReadonlyMap<FindingId, Finding>): Tone;
/** critical → bad, else neutral. */
export function findingTone(finding: Finding): Tone;
/** Worst severity of the findings anchored at the step; a finding that only cites it does not count. */
export function worstSeverity(step: Step, findingsById: ReadonlyMap<FindingId, Finding>): Severity | null;

// layout/trace-index.ts (C2 fix wave, A1 ruling)
/** The step's anchored critical findings that open its row by themselves; none while another critical finding cites
 *  the step (that finding's card already shows it: a claim over its failing test run). View-state collapse uses the same set. */
export function autoExpandingFindings(step: Step, findingsById: ReadonlyMap<FindingId, Finding>): Finding[];
```

#### `layout/overview-index.ts` and `layout/overview-layout.ts` (C1-13)

```ts
// layout/overview-index.ts
export type Glyph = "dot" | "ring" | "bar" | "hist" | "wait";
export type PinRule = "always" | "finding" | "never";
/** C2 fix wave: guardrail pins only with a finding (pin: "finding"); attention never pins (pin: "never"). */
export const PLACEMENT: { readonly [K in StepKind]: { glyph: Glyph; pin: PinRule; echo?: Lane } };
export const GLYPH_CODE: { readonly [G in Glyph]: number };
export const TONE_CODE: { readonly [T in Tone]: number };
export type PinKind = "critical_finding" | "failed" | "decision" | "approval" | "instruction" | "guardrail" | "finding" | "other";
/** Higher wins a cluster's icon: critical finding > failed > decision/approval > instruction > guardrail > other. */
export const PIN_PRIORITY: { readonly [K in PinKind]: number };

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
export function buildOverviewIndex(session: TraceSession, index: TraceIndex, scale: TimeScale): OverviewIndex;
/** One band key's pieces, sorted by u0, overlapping or touching pieces merged; a merged piece keeps its first id and title. */
export interface BandGroup {
  readonly key: BandSpan["key"];
  readonly id: readonly (UnitStableId | null)[];
  readonly title: readonly string[];
  readonly u0: Float64Array;
  readonly u1: Float64Array;
}
/** The camera-independent half of band placement, cached per OverviewIndex (WeakMap). */
export function bandGroupsOf(overview: OverviewIndex): readonly BandGroup[];

// layout/overview-layout.ts
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
export interface BandPlacement {
  key: string; id: UnitStableId | null; x0: number; x1: number;
  /** Where the placed label starts: the labeled piece's visible left edge, max(x0, 0). */
  labelX: number;
  title: string; tier: 0 | 1 | null; iconOnly: boolean;
}
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
export function layoutOverview(input: OverviewLayoutInput): OverviewLayout;
export interface OverviewPresetInput {
  level: Level; overview: OverviewIndex; index: TraceIndex; scale: TimeScale;
  widthPx: number; playheadSeq: number; live: boolean;
}
/** Spec §7.6.1 semantic-zoom table: preset camera and preset brush per level. */
export function overviewPreset(input: OverviewPresetInput): { camera: XOnlyCamera; brush: Brush };
```

#### `layout/spine-rows.ts` (C1-14)

```ts
export type SpineRow =
  | { t: "step"; key: StepId; step: number; expanded: boolean }
  | { t: "chapter"; key: `ch:${number}`; chapter: number }
  | {
      t: "noise"; key: `noise:${number}`; steps: number[]; label: string;
      /** Chapter level only: consecutive Jev-lane rows folded into one "Jev review" row. A renderer that ignores it
       *  shows a noise row with its label. */
      jev?: JevGroup;
    }
  | { t: "elided"; key: `elided:${number}`; steps: number[]; byLane: Record<Lane, number>; spanMs: number }
  | { t: "turn"; key: `turn:${number}`; turn: number }
  | { t: "idle"; key: `idle:${number}`; ms: number; reason: IdleReason }
  | { t: "gap"; key: `gap:${number}`; gap: number };
export interface JevGroup {
  /** Guardrail rows with a warning guardrail_clamp finding ("Jev review · 3 guardrails"). */
  guardrails: number;
  /** Worst member stepTone. */
  tone: Tone;
  /** Worst member finding severity; never critical (a critical finding keeps its own row). */
  severity: Severity | null;
}
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
/** Binary-searches steps by firstSeq for the brushed range; keys survive refolds, churn and live ticks (spec §7.6.3). */
export function buildSpineRows(session: TraceSession, index: TraceIndex, scale: TimeScale, input: SpineRowsInput): SpineRow[];
/** 32 for step/chapter/noise/elided, 24 for separators, per signal for expanded finding rows: claim_contradicted 104,
 *  failing_tests 134, destructive_command 96, guardrail_clamp 88, recovery_arc 96 (the measured cards); 96 otherwise. */
export function estimateSpineRowSize(row: SpineRow, session: TraceSession): number;
/** Index of the row holding seq, or −1. */
export function spineRowIndexForSeq(rows: readonly SpineRow[], session: TraceSession, seq: number): number;
```

#### `layout/canvas-*.ts` (C3a)

```ts
// layout/canvas-levels.ts (C3-1)
export type CanvasItemKind = "intent" | "instruction" | "plan" | "decision" | "claim" | "chapter" | "noise" | "loose";
export interface LevelSpec {
  level: Level;
  w: number;
  h: { story: number; chapter: number; noise: number; loose: number };
  /** 22 at Chapter and Step, 0 at Session (chips). */
  labelH: number;
  storyCap: number; rMax: number;
  colGap: number; turnGap: number; breakGap: number; rowGap: number;
  channelH: number; channelLanes: number; railLanes: number;
  pps: number; slack: number; breakMinMs: number;
  minZoom: number; maxZoom: number;
  /** Derived: w + colGap; storyCap·(h.story + rowGap) − rowGap; storyBand + channelH. */
  pitch: number; storyBand: number; workTop: number;
}
export const LEVEL_SPECS: { readonly [L in Level]: LevelSpec };   // values: spec §7.5 table
export function frameSize(level: Level, kind: CanvasItemKind): { w: number; h: number };

// layout/canvas-layout.ts (C3-1 collectItems; C3-2 placement; C3-3 calls routeEdges)
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
// Noise (spec §7.5, lane C3b review I-3): a noise chapter's item stays kind "noise" unless a finding names the chapter
// or one of its own steps (stepIds less validationOnlyStepIds) anchors a finding; a shared failed run it joins only
// through a validation, or a finding that only cites its step, does not promote it.
export function collectItems(session: TraceSession, index: TraceIndex, stepOf?: (id: string) => Step | undefined): CanvasItem[];
export interface CanvasFrame {
  key: string;
  selId: SelectionId;
  kind: "story" | "chapter" | "noise" | "loose";
  item: CanvasItemKind;
  col: number; row: number;
  slot: Rect; card: Rect; label: Rect | null;
  /** Noise stack members (keys); [key] otherwise. */
  members: readonly string[];
  /** Selection ids of `members`, same order (lane 07 deviation 2). */
  memberSelIds: readonly SelectionId[];
  late: boolean;
}
export interface CanvasColumn { key: string; index: number; x: number; t0: number; turn: number }
export interface CanvasSeparator { kind: "turn" | "break"; x: number; t: number; turn: number; label: string }
export interface TimeBreakpoint { t: number; xIn: number; xOut: number }
export interface CanvasLayoutStats { late: number; rMaxExceeded: number; holes: number; hiddenEdges: number }
declare const layoutStateBrand: unique symbol;
export interface CanvasLayoutState { readonly [layoutStateBrand]: true }
export interface CanvasLayout {
  level: Level;
  sessionId: string;
  frames: readonly CanvasFrame[];
  frameByKey: ReadonlyMap<string, CanvasFrame>;
  holes: readonly Rect[];
  columns: readonly CanvasColumn[];
  separators: readonly CanvasSeparator[];
  edges: readonly CanvasEdge[];
  /** Trunk junction points from `routeEdges` (lane 07 deviation 3). */
  junctions: readonly Point[];
  time: { bps: readonly TimeBreakpoint[]; pps: number };
  bounds: Rect;
  /** Columns left → right; story cells, then work rows top → bottom. */
  readingOrder: readonly SelectionId[];
  stats: CanvasLayoutStats;
  state: CanvasLayoutState;
}
/** Pure, deterministic and sticky (spec §7.5; P1–P10). */
export function layoutCanvas(session: TraceSession, index: TraceIndex, scale: TimeScale, level: Level, prev?: CanvasLayout): CanvasLayout;
/** World x ↔ display time over the breakpoints, linear in toU between them, pps past the last. */
export function canvasXMap(layout: CanvasLayout, scale: TimeScale): XMap;

// layout/canvas-routes.ts (C3-3)
export type EdgeKind = "trunk" | "contradicts" | "decides" | "validates";
export type EdgeShape = "comb" | "stacked" | "adjacent" | "rail" | "channel" | "direct";
export interface CanvasEdge {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  shape: EdgeShape;
  lane: number | null;
  /** SVG path in world px; null when a decides/validates edge has no free lane (drawn only for the selection via directPath). A contradicts edge with no free lane is `shape: "direct"` with `d = directPath(...)` (lane 07 deviation 17). */
  d: string | null;
  rest: boolean;
  tone: "bad" | "neutral";
  /** contradicts: ≠ badge position. */
  badge: Point | null;
  findingId: FindingId | null;
}
export interface RouteInput { session: TraceSession; frames: readonly CanvasFrame[]; frameByKey: ReadonlyMap<string, CanvasFrame>; columns: readonly CanvasColumn[]; spec: LevelSpec;
  /** Frame key → placement order; defaults to (col, row) frame order. layoutCanvas passes sticky slot order (lane review). */
  order?: ReadonlyMap<string, number>;
  /** Step lookup shared with the caller; built from session.steps when omitted. */
  stepOf?: (id: string) => Step | undefined }
export function routeEdges(input: RouteInput): { edges: CanvasEdge[]; junctions: Point[]; hiddenEdges: number };
/** Loose frame, else story frame, else tests chapter for a test/check, else lowest-anchor chapter. */
export function homeFrameKey(stepId: StepId, input: RouteInput): string | undefined;
/** Cubic bezier between card edges; used for the selection's lane-less edges with a 3 px panel halo. */
export function directPath(a: Rect, b: Rect): string;

// layout/canvas-minimap.ts (C3-4)
export const MINIMAP_W = 140;
export const MINIMAP_H = 84;
export const MINIMAP_STRIP_H = 3;
export const MINIMAP_MIN_SCALE = 0.03;
/** Lane 07 deviation 5: wider than CanvasLayout, so every CanvasLayout still type-checks. */
export type MinimapSource = Pick<CanvasLayout, "bounds" | "frames" | "edges" | "separators">;
export interface MinimapModel {
  scale: number;
  /** World point shown at the minimap's (0, 0) (lane 07 deviation 4). */
  origin: Point;
  /** World x-window shown when s · bounds.w > 140; null when the whole session fits. */
  window: { x0: number; x1: number } | null;
  frames: readonly { key: string; rect: Rect; mark: "frame" | "selected" | "critical" | "noise" }[];
  edges: readonly { d: string }[];
  separators: readonly { x: number }[];
  viewport: Rect;
  strip: { bracket: readonly [number, number]; critical: readonly number[] } | null;
}
/** criticalKeys: the frames the main view paints red, frameTone "bad" (ui/views/canvas/frame-label.ts criticalFrameKeys). */
export function buildMinimap(layout: MinimapSource, input: { viewportWorld: Rect; selectedKey: string | null; criticalKeys: ReadonlySet<string> }): MinimapModel;
export function minimapToWorld(model: MinimapModel, point: Point): Point;
```

### 2.2 Visual primitives (C1a)

#### `ui/tokens/tokens.ts` and `ui/tokens/contrast.ts` (C1-1)

```ts
// ui/tokens/tokens.ts
export const TOKEN_NAMES = [
  "canvas", "panel", "ink", "ink2", "ink3", "ink4", "mark", "hair", "fill", "fill2",
  "accent", "accentSoft", "accentInk", "bad", "badSoft", "badInk", "good", "shadow",
] as const;
export type TokenName = (typeof TOKEN_NAMES)[number];
export type Tokens = { readonly [K in TokenName]: string };
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
export function tokenStyle(tokens?: Tokens): Readonly<Record<`--tv-${string}`, string>>;
export const FONT_SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
export const FONT_MONO = 'ui-monospace, "SF Mono", Menlo, monospace';
export const TYPE = {
  meta: { size: 12, line: 16 }, base: { size: 13, line: 18 }, prose: { size: 15, line: 20 },
  numeral: { size: 20, line: 24 }, mono: { size: 12, line: 18 },
} as const;

// ui/tokens/contrast.ts
/** "#RRGGBB" or "rgb(r g b / a)". */
export function parseColor(value: string): { r: number; g: number; b: number; a: number };
/** Alpha-composites fg over an opaque bg; returns "#RRGGBB". */
export function composite(fg: string, bg: string): string;
/** WCAG 2.x ratio; translucent fg is composited over bg first. */
export function contrastRatio(fg: string, bg: string): number;
```

`ui/tokens/base.module.css` declares `.root` (font stack, 13/18 base, `color: var(--tv-ink)`, `background: var(--tv-panel)`, `font-variant-numeric: tabular-nums`, `--tv-dur-fast: 120ms`, `--tv-dur: 180ms`, both `0ms` under `@media (prefers-reduced-motion: reduce)`) and `.mono`. The Shell applies both `base.root` and `tokenStyle()`.

#### `ui/icons/*` (C1-2)

```ts
// ui/icons/icon-names.ts
export const ICON_NAMES = [
  "person", "bubble", "thought", "plug", "term", "test", "gauge", "edit", "eye", "key", "fork", "pkg", "undo", "flag", "jev",
  "neq", "quote", "shield", "table", "route", "list", "stack", "eyeoff",
  "cursor", "hand", "fit", "zoom", "search", "clock", "check", "chev-d", "chev-r", "live", "copy", "reply", "diff", "file",
  "view-canvas", "view-hybrid",
] as const;
export type IconName = (typeof ICON_NAMES)[number];

// ui/icons/paths.ts — 16×16 viewBox, stroke-only path data, 1.5 px, round caps and joins
export const ICON_PATHS: { readonly [K in IconName]: readonly string[] };

// ui/icons/IconSprite.tsx
/** Renders every <symbol id="tv-i-<name>"> once, inside a hidden aria-hidden <svg>; mounted by the Shell. */
export function IconSprite(): React.JSX.Element;

// ui/icons/Icon.tsx
export interface IconProps { name: IconName; size?: 12 | 14 | 16; title?: string; className?: string }
/** <svg><use href="#tv-i-<name>"/></svg>; aria-hidden unless title is set. */
export function Icon(props: IconProps): React.JSX.Element;

// ui/icons/kind-icons.ts
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

#### `ui/graphics/*` (C1-3, C1-4)

```ts
// ui/graphics/scales.ts
export const DIFF_SIDE_MAX_PX = 56;
/** 0 when lines = 0, else clamp(2, 56, 8 · log2(1 + lines)). */
export function diffSidePx(lines: number): number;
/** Exact below 1,000; one decimal with k from 1,000 ("1.2k"). */
export function compactCount(n: number): string;
export const TEST_DOTS_MAX = 15;
export function testDotsMode(total: number): "dots" | "bar";
/** clamp(4, 120, 20 + 40 · log10(seconds)); 1 s = 20, 10 s = 60, 100 s = 100. */
export function durationPx(ms: number): number;

// shared props
export type GraphicSize = "xs" | "sm" | "md";
export interface GraphicBaseProps {
  size: GraphicSize;
  /** Accessible name (describeGraphic); omitted → aria-hidden. */
  label?: string;
}
// ui/graphics/DiffBar.tsx
export interface DiffBarProps extends GraphicBaseProps {
  added: number; removed: number;
  files?: readonly { path: string; added: number; removed: number }[];
  moreFiles?: number;
}
export const DiffBar: React.NamedExoticComponent<DiffBarProps>;
// ui/graphics/TestDots.tsx
export interface TestDotsProps extends GraphicBaseProps { passed: number; failed: number; skipped: number }
export const TestDots: React.NamedExoticComponent<TestDotsProps>;
// ui/graphics/DurationBar.tsx
export interface DurationBarProps extends GraphicBaseProps {
  durationMs: number | null;
  running: boolean;
  /** Running: elapsed so far, drawn as the hollow extension to now. */
  elapsedMs?: number;
  end: "none" | "bad_dot" | "exit_x";
}
export const DurationBar: React.NamedExoticComponent<DurationBarProps>;
// ui/graphics/ForkGlyph.tsx
export interface ForkGlyphProps extends GraphicBaseProps {
  options: readonly { label: string; chosen: boolean }[];
  decidedBy: "supervisor" | "delegated" | "open";
}
export const ForkGlyph: React.NamedExoticComponent<ForkGlyphProps>;
// ui/graphics/FlowGlyph.tsx
export interface FlowGlyphProps extends GraphicBaseProps { nodes: readonly string[]; focus: number }
export const FlowGlyph: React.NamedExoticComponent<FlowGlyphProps>;
// ui/graphics/TableGlyph.tsx
export interface TableGlyphProps extends GraphicBaseProps { tables: readonly { name: string; role: "new" | "altered"; columns: number }[] }
export const TableGlyph: React.NamedExoticComponent<TableGlyphProps>;
// ui/graphics/ClaimVsObserved.tsx
export interface ClaimVsObservedProps extends GraphicBaseProps {
  claim: { text: string; span?: readonly [number, number]; tMs: number };
  observed: { passed: number; failed: number; command: string; tMs: number };
  onObservedClick?(): void;
  /** Added by the C1a lane fix (d1dde66): a roving-tabindex region passes -1 so the observed button is not a second tab stop. Default 0. */
  observedTabIndex?: 0 | -1;
}
export const ClaimVsObserved: React.NamedExoticComponent<ClaimVsObservedProps>;
// ui/graphics/Graphic.tsx
export const GRAPHIC_COMPONENTS: { readonly [K in GraphicSpec["kind"]]: React.ComponentType<{ spec: Extract<GraphicSpec, { kind: K }>; size: GraphicSize; label?: string }> };
export function Graphic(props: { spec: GraphicSpec; size: GraphicSize; label?: string; elapsedMs?: number }): React.JSX.Element;
```

### 2.3 View state (C1b)

#### `ui/state/view-state.ts` (C1-11)

```ts
import type { FindingId, Level, StepId, UnitStableId } from "../../model/index.js";
import type { Brush, Playhead, SelectionId, TraceIndex } from "../../layout/trace-index.js";
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
}

export type ViewAction =
  | { type: "session/applied"; loadedThroughSeq: number; terminal: boolean; loadComplete: boolean; initialSelection: SelectionId | null; chapterSpineRows: number }
  | { type: "select"; id: SelectionId | null; by: FocusBy }
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
export function initialViewState(input: InitialViewStateInput): ViewState;
/** Pure. Returns the same object when nothing changes. */
export function reduce(state: ViewState, action: ViewAction, index: TraceIndex): ViewState;
export function selectNewCount(state: ViewState, index: TraceIndex): number;
export function selectEffectivePlayheadSeq(state: ViewState, index: TraceIndex): number;
export function selectStepIsTail(id: SelectionId, index: TraceIndex): boolean;
export function locationOf(state: ViewState, sessionId: string): ViewerLocation;
```

`reduce` guarantees, each pinned by `view-state.property.test.ts` over random action sequences on `arbTraceSession()`:
- The selection's span intersects the brush's seq range; when a write breaks it, the brush slides and keeps its width.
- `selectEffectivePlayheadSeq` lies inside the brush's seq range.
- `view/switch` to the other view and back leaves the state deep-equal to the state before the first switch, excluding `cameras` (spec §7.8 item 6).
- `select` with a different id sets `inspectorTab` to `"summary"` when it was `"raw"`; `"evidence"` persists.
- `lastSeenSeq` never decreases; `camera/sync` never changes `focusRev`.
- `session/applied` remaps a missing `unit:` selection, `expanded` and `collapsed` ids through `ch:<anchorSeq>` and sets `selectionNote`; it never removes an id from `collapsed`.
- While `follow` is true, any `playhead/set` with origin other than `live`, any `playhead/step`, any `level/set` from a gesture, `brush/set` and a `select` of a non-tail id set `follow` to false.
- `esc` unwinds: `search` → `tool` hand → collapse the selected expanded key → select the parent (step → unit) → clear.
- `session/applied` with `loadComplete` and `!loaded` applies spec §7.8 "Defaults on open" (Review: `initialSelection` from `compareFindings`, brush `session` when `chapterSpineRows ≤ 150` else the chapter holding the selection; Live: no selection, playhead `live`).

#### `ui/state/store.ts`, `ui/state/location.ts`, `ui/state/keymap.ts` (C1-12)

```ts
// ui/state/store.ts
export interface ViewStore {
  get(): ViewState;
  /** Stable identity for useSyncExternalStore. */
  subscribe(listener: () => void): () => void;
  dispatch(action: ViewAction): void;
  setIndex(index: TraceIndex): void;
  getIndex(): TraceIndex;
}
export function createViewStore(initial: ViewState, index: TraceIndex): ViewStore;
export const ViewStoreContext: React.Context<ViewStore | null>;
export function useViewStore(): ViewStore;
/** Selector read; `equal` defaults to Object.is. Selectors return primitives or references held in state. */
export function useView<T>(select: (state: ViewState) => T, equal?: (a: T, b: T) => boolean): T;
export function useDispatch(): (action: ViewAction) => void;

// ui/state/location.ts
export const PlayheadSchema: z.ZodType<Playhead>;
export const BrushSchema: z.ZodType<Brush>;
export const ViewerLocationSchema = z.object({
  v: z.literal(1),
  sessionId: z.string().min(1),
  view: z.enum(["canvas", "hybrid"]).default("hybrid"),
  level: z.enum(LEVELS).default("chapter"),
  selected: StableIdSchema.optional(),       // W0 StableIdSchema; resolved to a SelectionId on load (C2-3)
  playhead: PlayheadSchema.optional(),
  brush: BrushSchema.default({ kind: "session" }),
});
export type ViewerLocation = z.infer<typeof ViewerLocationSchema>;
/** Never throws; any failure or a different sessionId yields the defaults for sessionId. */
export function decodeLocation(raw: unknown, sessionId: string): ViewerLocation;
/** "#" + encodeURIComponent(JSON.stringify(location)). */
export function locationToHash(location: ViewerLocation): string;
export function locationFromHash(hash: string, sessionId: string): ViewerLocation;

// ui/state/keymap.ts
export interface KeyInput {
  code: string; key: string;
  shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean;
  isComposing: boolean;
  /** input, textarea or [contenteditable] target. */
  editableTarget: boolean;
}
export interface KeyContext { view: ViewKind; spaceOverPannable: boolean; hasTextSelection: boolean }
export type KeyCommand =
  | { cmd: "item"; dir: 1 | -1 }            // j / k
  | { cmd: "chapter"; dir: 1 | -1 }         // J / K
  | { cmd: "turn"; dir: 1 | -1 }            // [ / ]
  | { cmd: "finding"; dir: 1 | -1 }         // n / N
  | { cmd: "toggle" }                       // Enter
  | { cmd: "esc" }                          // Escape
  | { cmd: "view"; view: ViewKind }         // 1 / 2
  | { cmd: "level"; level: Level }          // Alt+1/2/3
  | { cmd: "playhead"; dir: 1 | -1 }        // , / .
  | { cmd: "first" }                        // g
  | { cmd: "last" }                         // G
  | { cmd: "zoom"; op: "out" | "in" | "preset" }   // - / = / 0
  | { cmd: "fit"; target: "all" | "selection" }    // Shift+1 / Shift+2
  | { cmd: "tool"; tool: Tool }             // v / h
  | { cmd: "space"; down: boolean }         // hold Space (only when spaceOverPannable)
  | { cmd: "brushEdge"; edge: "from" | "to" }      // { / } (Hybrid)
  | { cmd: "brushChapter" }                 // b (Hybrid)
  | { cmd: "search" }                       // /
  | { cmd: "help" }                         // ?
  | { cmd: "region"; dir: 1 | -1 }          // F6 / Shift+F6
  | { cmd: "copyNote" };                    // Cmd/Ctrl+C with no text selection
export const ZOOM_STEP = 1.25;
/** Pure; null when the key is not a viewer command in this context. Matches on event.code. */
export function resolveKey(input: KeyInput, context: KeyContext, phase: "down" | "up"): KeyCommand | null;
```

### 2.4 Shell, host API and sources

#### `sources/*` (C1-15)

```ts
// sources/errors.ts
export type TraceChannel = "trace:listSessions" | "trace:rows" | "trace:payloads" | "bundle";
export type TraceSourceErrorCode = "UNKNOWN_SESSION" | "NOT_A_TRACE" | "UNSUPPORTED_VERSION" | "SOURCE_FAILED";
export class TraceSourceError extends Error {
  readonly channel: TraceChannel;
  readonly code: TraceSourceErrorCode;
  constructor(channel: TraceChannel, code: TraceSourceErrorCode, message: string);
}

// sources/static-bundle.ts
export type ParsedBundle =
  | { ok: true; bundle: TraceBundle }
  | { ok: false; code: "NOT_A_TRACE" | "UNSUPPORTED_VERSION"; message: string };   // "Not a jevcode trace" / "Trace format v2 is not supported"
export function parseTraceBundle(json: unknown): ParsedBundle;
export interface DripOptions { rowsPerTick: number; intervalMs: number; manual?: boolean; startAtSeq?: number }
export interface StaticBundleSource extends TraceSource {
  /** Rows released so far (all rows without drip). */
  released(): number;
  /** Releases rowsPerTick more rows now (manual drip and tests). */
  tick(): void;
  dispose(): void;
}
/** rows() returns only released rows; lastSeq = last released seq; state "running" until the last row, then bundle.session.state; now() = the last released row's source time. */
export function createStaticBundleSource(bundle: TraceBundle, options?: { drip?: DripOptions }): StaticBundleSource;

// sources/read-all.ts
export interface LoadedTrace { summary: TraceSessionSummary; rows: TraceRow[]; lastPage: TraceRowsPage }
/** summary(), then rows() from afterSeq 0 until nextAfterSeq is null. */
export function readAllTraceRows(source: TraceSource, options?: { pageSize?: number }): Promise<LoadedTrace>;

// sources/index.ts (exported as "@jevcode/trace-viewer/sources"; imports no React and no CSS)
export * from "./errors.js";
export * from "./static-bundle.js";
export * from "./read-all.js";
```

`TraceSource` and `cursorAfter` stay in the root barrel only (W0-6's `export * from "./source.js";`), so no binding is exported twice. Node-side consumers (D-7) import runtime values from `@jevcode/trace-viewer/sources` and `@jevcode/trace-viewer/model`, and `TraceSource` with `import type` from `@jevcode/trace-viewer` (erased at runtime). `apps/desktop/src/renderer/trace/ipc-source.ts` imports `TraceSourceError` from `@jevcode/trace-viewer/sources` for the same reason.

#### `ui/shell/*` and `ui/views/*` (C2)

```ts
// ui/shell/host.ts (C2-3)
export interface RequestChangesRequest { sessionId: string; selected: SelectionId; text: string }
export interface ViewerReadyInfo { rows: number; loadedThroughSeq: number }
export interface ViewerDiagnostics { errors: string[]; maxAnchorDriftPx: number; selectedTitle: string | null }
export interface ViewerHost {
  requestChanges?(request: RequestChangesRequest): void | Promise<void>;
  onLocation?(location: ViewerLocation): void;
  /** Once, after the first committed fold. */
  onReady?(info: ViewerReadyInfo): void;
  /** Dev-host selftest only; enables anchor-drift measurement. */
  onDiagnostics?(diagnostics: ViewerDiagnostics): void;
}

// ui/shell/TraceViewer.tsx (C2-3)
export interface TraceViewerProps {
  source: TraceSource;
  host?: ViewerHost;
  location?: ViewerLocation;
  /** Poll interval while not terminal; default TRACE_LIVE_POLL_MS (1,000). */
  pollMs?: number;
}
export function TraceViewer(props: TraceViewerProps): React.JSX.Element;

// ui/shell/data-controller.ts (C2-2)
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
}
export interface Scheduler { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void; now(): number }
export interface DataControllerOptions {
  source: TraceSource;
  pollMs: number;
  pageSize?: number;                 // default TRACE_ROWS_PAGE_MAX
  maxCommitsPerSecond?: number;      // default 4 while paging
  scheduler?: Scheduler;
  isHidden?(): boolean;              // default document.visibilityState === "hidden"
}
export const BACKOFF_MS: readonly number[];   // [1_000, 2_000, 4_000, 10_000]; repeats 10_000
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
}
/** Folds with createTraceState/accumulateAll/finalize({live: !terminal, state, throughSeq: cursorAfter(page), nowMs: source.now()}); tags requests with a monotonic token and drops stale responses.
 *  Yields one macrotask (scheduler.setTimeout(0)) between pages, so commits are progressive and the first page paints
 *  before the last one loads; host.onReady still fires after the first fold and tv:full-load marks "loaded". */
export function createDataController(options: DataControllerOptions): DataController;

// ui/shell/session-context.ts (C2-3)
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
export const SessionContext: React.Context<SessionView | null>;
export function useSessionView(): SessionView;

// ui/shell/Shell.tsx (C2-3)
export interface ShellProps { sessionId: string; host: ViewerHost; controller: DataController }
export function Shell(props: ShellProps): React.JSX.Element;

// ui/shell/TitleBar.tsx (C2-4) — reads store, registry and SessionContext
export interface TitleBarProps { onRetry(): void }
export function TitleBar(props: TitleBarProps): React.JSX.Element;

// ui/shell/Outline/Outline.tsx (C2-5)
export interface OutlineProps { hiddenRows: number }
export function Outline(props: OutlineProps): React.JSX.Element;

// ui/inspector/Inspector.tsx (C2-6)
export interface InspectorProps { host: ViewerHost }
export function Inspector(props: InspectorProps): React.JSX.Element;
// ui/inspector/finding-copy.ts (C2-6)
export const FINDING_TITLE = {
  claim_contradicted: "Claim contradicts tests", failing_tests: "Tests failed", destructive_command: "Destructive command",
  guardrail_clamp: "Guardrail clamp", recovery_arc: "Recovered after a failure",
} as const satisfies Record<SignalId, string>;
/** Anchored findings (tone.ts anchoredFindings); citing ones for Related. topFindingOf is the first anchored one. */
export function findingsOf(session: TraceSession, step: Step): Finding[];
export function citingFindingsOf(session: TraceSession, step: Step): Finding[];
export function topFindingOf(session: TraceSession, step: Step): Finding | null;
/** The finding a spine row shows: its top anchored finding; titled when it is one of autoExpandingFindings (it takes
 *  the title slot and node), else a badge; null when none is anchored. */
export interface RowFinding { finding: Finding; titled: boolean }
export function rowFindingOf(session: TraceSession, step: Step, findingsById: ReadonlyMap<FindingId, Finding>): RowFinding | null;
/** Inspector header, review-note line 1, Brush aria-valuetext, diagnostics title; sanitized with displayUntrusted. */
export function selectionTitle(session: TraceSession, index: TraceIndex, id: SelectionId): string;
// ui/views/hybrid/spine/Spine.tsx: the finding body a view injects through FindingBodyContext
export interface FindingBodyProps {
  finding: Finding; step: Step; session: TraceSession; onJump(stepId: StepId): void;
  /** "header": the signal's inline header extras next to the row title; default "body". A Canvas frame that reuses FindingBody passes it. */
  part?: "header" | "body";
}
// ui/inspector/review-note.ts (C2-6)
export interface ReviewNote { markdown: string; firstLine: string }
/** Spec §7.1 "Review note" format; null when nothing is selected. */
export function buildReviewNote(session: TraceSession, index: TraceIndex, selection: SelectionId): ReviewNote;
/** Backticks one longer than the longest run in text, minimum 3. */
export function fenceFor(text: string): string;
export function inlineCode(text: string): string;

// ui/shell/perf.ts (C2-3)
export const PERF = {
  bundleParsed: "tv:bundle-parsed", firstPaint: "tv:first-paint", fullLoad: "tv:full-load",
  keyToPaint: "tv:key-to-paint", overviewPaint: "tv:overview-paint", viewSwitch: "tv:view-switch", liveTick: "tv:live-tick",
} as const;
/** Posts a MessageChannel message from the next rAF and marks `name` when it arrives (spec §10 paint mark). */
export function markAfterPaint(name: string, startMark?: string): void;

// ui/views/view-port.ts (C2-3): the view registration API
export interface ZoomPreset { id: string; label: string }
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
}
export function createViewPortRegistry(): ViewPortRegistry;
export const ViewPortRegistryContext: React.Context<ViewPortRegistry | null>;
export function useRegisterViewPort(kind: ViewKind, port: ViewPort): void;
// Hybrid port behavior (C2 fix wave): zoom.label() divides the camera k by the level's preset k, cached per
// (level, overview model, width) and not per playhead, so moving the selection is not a zoom; HybridView calls
// registry.notify() once a remounted overview has a camera. reveal() is queued to the next commit and dropped when
// the playhead effect already revealed that row in the same commit, so one j press scrolls the spine at most once.

// ui/views/registry.ts (C2-14 creates with [hybrid]; C3-11 adds canvas: VIEWS = [canvas, hybrid])
// The title bar's View switch (TitleBar.tsx, C3-12) is a radiogroup with one tab stop: a roving tabindex on the checked
// view; arrows (wrapping), Home and End check and focus a view. LevelSegmented below has no tab stop at all.
export interface ViewProps { active: boolean }
export interface ViewDefinition { kind: ViewKind; label: string; icon: IconName; Component: React.ComponentType<ViewProps> }
/** Switch order: Canvas | Hybrid. The title bar shows the switch only when VIEWS.length > 1. */
export const VIEWS: readonly ViewDefinition[];
/** true: hidden views stay mounted under <Activity mode="hidden">; spike risk 6 ruling sets false (unmount). */
export const KEEP_HIDDEN_VIEWS_MOUNTED: boolean;

// ui/views/shared/LevelControl.tsx (C2-9; C3-8 ruling: the Canvas toolbar takes the controlled group, not the store-bound one)
export const LEVEL_LABEL: Record<Level, string>;
export interface LevelSegmentedProps { level: Level; onLevel(level: Level): void }
/** Controlled Session | Chapter | Step radiogroup: radios tabIndex -1 (Alt+1/2/3 is the keyboard path), arrows wrap and move focus. */
export function LevelSegmented(props: LevelSegmentedProps): React.JSX.Element;
/** Thin wrapper: LevelSegmented bound to the store, dispatching level/set with `by`. Hybrid uses it. */
export function LevelControl(props: { by: FocusBy }): React.JSX.Element;

// ui/views/canvas/spike-rulings.ts (C3-5): the M4b spike rulings, read at the Canvas call sites. They replace the
// "settleRoundK: 64 at the Canvas call site" and "INV_K_EVERY_FRAME in World.tsx" wording of C1-7 and C3-5 (section 3).
export const CANVAS_SETTLE_ROUND_K: number | null; // 64: risk 3 fallback, k rounds to a 1/64 grid at settle
export const INV_K_EVERY_FRAME: boolean;           // false: risk 7 passed, --tv-inv-k at settle and tween end only
export const CULL_FRAMES: boolean;                 // true: risk 2 fallback, x0 culling and capped Step lists

// ui/views/canvas/canvas-port.ts (C3-10)
export function routeInputOf(layout: CanvasLayout, session: TraceSession): RouteInput;
/** The frame whose members hold `id`, else a step's home frame (homeFrameKey). */
export function frameForSelection(layout: CanvasLayout, session: TraceSession, id: SelectionId): CanvasFrame | undefined;
/** The newest step's frame: Live follow and "seen". */
export function tailFrame(layout: CanvasLayout, session: TraceSession): CanvasFrame | undefined;
/** j/k order: frame members in layout order, an expanded chapter's steps right after it. */
export function canvasReadingOrder(layout: CanvasLayout, session: TraceSession, expanded: ReadonlySet<string>): SelectionId[];
export const CANVAS_ZOOM_PRESETS: readonly ZoomPreset[]; // 50%, 100%, 200%
export function zoomLabel(k: number): string;           // "83%"
export function createCanvasPort(deps: CanvasPortDeps): ViewPort;
// Canvas port behavior: zoom.label() is the camera k as a percentage (Hybrid's is relative to its level preset);
// presets and zoomIn/zoomOut zoom around the selection's card center, else the viewport center; resetToPreset is k 1.
// reveal() is queued to the next commit and dropped when the selection effect already revealed that frame in the same
// commit. During a programmatic move (the open show tween) a reveal starts from the move's target camera and lets that
// move stamp the camera (30e434d).

// ui/views/canvas/frame-label.ts (C3-6; lane C3b review fix round)
/** frameSteps less the members' validationOnlyStepIds: the Step list, footer count, fill rows, chip and ruler band end,
 *  frameRunning and frameTone. Fill rows also skip noise steps and rank problems by the anchor rule. */
export function ownSteps(frame: CanvasFrame, ctx: FrameContext): Step[];
/** The minimap's critical outlines and strip ticks: the frames whose frameTone is "bad"; memoized per (layout, ctx). */
export function criticalFrameKeys(layout: { readonly frames: readonly CanvasFrame[] }, ctx: FrameContext): Set<string>;
/** The selection chip: formatOffsetRange (model/format.ts), shared with Hybrid's spine chip. */
export function timeChip(start: number, end: number): string;

// ui/views/canvas/Overlay.tsx (C3-7; lane C3b review I-4)
export type BadgeSide = "left" | "right" | "mark";
/** The contradicts word goes left of the ≠ mark, else right, else only the mark shows (word in its tooltip). Obstacles:
 *  cards, label rows and the selection's time chip, sized at the mounted camera's k (overlay items keep screen size). */
export function badgeSide(layout: Pick<CanvasLayout, "frames">, point: Point, options?: { k?: number; chip?: Rect | null; frames?: readonly CanvasFrame[] }): BadgeSide;
export function timeChipRect(frame: CanvasFrame, text: string, k?: number): Rect;

// CanvasView (C3-10; lane C3b review I-5): the sticky layout runs only while `active`. Hidden, the view returns the last
// committed layout with the session, index and scale it came from and derives nothing new; the show lays out once, with
// prev = that layout when level, session and Tidy generation match (P6 makes the skipped appends equivalent).
```

Root barrel `packages/trace-viewer/src/index.ts` after C2 (C1b appends lines 2-5, C2 appends the rest):

```ts
export * from "./source.js";
export * from "./sources/index.js";
export * from "./layout/viewport.js";
export { createViewportController, SETTLE_MS, type ViewportController, type ViewportControllerOptions, type FramePhase } from "./ui/viewport/controller.js";
export { ViewerLocationSchema, decodeLocation, locationFromHash, locationToHash, type ViewerLocation } from "./ui/state/location.js";
export { TraceViewer, type TraceViewerProps } from "./ui/shell/TraceViewer.js";
export type { ViewerHost, RequestChangesRequest, ViewerReadyInfo, ViewerDiagnostics } from "./ui/shell/host.js";
export type { SelectionId } from "./layout/trace-index.js";
```

### 2.5 Dev host and smoke (C1b, C2, C3b)

- `apps/trace-viewer-dev/src/main.tsx` (C2-15): `?bundle=<name>` fetches `bundles/<name>.json` (default `oauth`; same origin, allowed by `default-src 'self'`), validates with `parseTraceBundle`, and on a dropped file does the same; `?drip=<rowsPerTick>,<intervalMs>`; `?perf=1` mounts `PerfHud`; `?selftest=drip` mounts the selftest; `location.hash` feeds `locationFromHash` and `host.onLocation` writes `history.replaceState(null, "", locationToHash(l))`. Mounts `<TraceViewer source={createStaticBundleSource(bundle, { drip })} pollMs={drip?.intervalMs ?? 1000} location host />`.
- `apps/trace-viewer-dev/src/selftest.ts` (C2-15; C3-12 extends): `export interface SelftestResult { ready: boolean; view: "hybrid" | "canvas"; selectedTitle: string | null; errors: string[]; cspViolations: string[]; maxDriftPx: number; rows: number }`; collects `window.onerror`, `unhandledrejection`, `console.error` and `securitypolicyviolation`, runs a Review drip (`rowsPerTick: 5`, `intervalMs: 100`), and writes `JSON.stringify(result)` into `<pre id="selftest">` when the drip ends.
- `apps/trace-viewer-dev/scripts/smoke.mjs` (C2-16; C3-12 extends): `node apps/trace-viewer-dev/scripts/smoke.mjs [--views hybrid|hybrid,canvas] [--skip-build]`. Steps: `pnpm -r build` (unless `--skip-build`); `pnpm --filter jevcode-desktop replay fixtures/oauth <tmp>/oauth`; copy `<tmp>/oauth/trace.json` to `apps/trace-viewer-dev/public/bundles/oauth.json`; `pnpm --filter jevcode-trace-viewer-dev build`; spawn `pnpm --filter jevcode-trace-viewer-dev exec vite preview --port 4179 --strictPort` and poll until HTTP 200; for each view and width 1440 and 1000: `"$CHROME" --headless=new --disable-gpu --hide-scrollbars --window-size=<w>,900 --screenshot=apps/trace-viewer-dev/.smoke/<view>-<w>.png "http://localhost:4179/?bundle=oauth#<location with view>"`; then `--dump-dom --virtual-time-budget=5000 "…?bundle=oauth&selftest=drip#…"` per view, parse `<pre id="selftest">`, and assert `ready`, `selectedTitle === "Claim contradicts tests"`, `errors.length === 0`, `cspViolations.length === 0`, `maxDriftPx <= 1`. `CHROME` is `process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`. Exit 0 prints `SMOKE_OK <n> screenshots`; failure prints `SMOKE_FAIL: <reason>` and exits 1. It is outside `pnpm -r test` and runs at the M4a and M4b exits.
- Spike harness (C1-7): `apps/trace-viewer-dev/spike.html`, `apps/trace-viewer-dev/vite.spike.config.ts` (input `spike.html`, `outDir: "dist-spike"`, the same CSP injection and node-builtin guard, `assetsInlineLimit: 0`), `apps/trace-viewer-dev/src/spike/*`, and `apps/trace-viewer-dev/scripts/spike-electron.cjs`, run with `pnpm --filter jevcode-desktop exec electron /Users/jwpark/Projects/jevcode-tv-c1b/apps/trace-viewer-dev/scripts/spike-electron.cjs` (Electron 33 from the desktop's devDependencies; no new dependency).

### 2.6 Electron (Da, Db)

```ts
// apps/desktop/src/shared/local-channels.ts (D-2) — additions
// in RendererToMainLocalChannels:
  traceOpen: "trace:open",
  traceRequestChanges: "trace:requestChanges",
// in MainToRendererLocalChannels:
  composerPrefill: "composer:prefill",

export const TRACE_NOTE_MAX_CHARS = 8_000;
/** Spec §7.8 pattern. */
export const TraceStableIdSchema = z.string().regex(/^(step:\d+|unit:.+|decision:.+)$/s);
export const TraceOpenPayloadSchema = z.object({ sessionId: z.string().min(1) });
export const TraceRequestChangesPayloadSchema = z.object({
  sessionId: z.string().min(1),
  selected: TraceStableIdSchema,
  text: z.string().min(1).max(TRACE_NOTE_MAX_CHARS),
});
export const ComposerPrefillPayloadSchema = z.object({
  sessionId: z.string().min(1),
  text: z.string().min(1).max(TRACE_NOTE_MAX_CHARS),
});
// localToMain gains the two request schemas; localFromMain gains composer:prefill.

// apps/desktop/src/main/trace-window.ts (D-1)
import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";
export const TRACE_WINDOW_MIN_WIDTH = 1000;
export const TRACE_WINDOW_BACKGROUND = "#FFFFFF";
/** width 1440, height 900, minWidth 1000, backgroundColor #FFFFFF, show false, the main window's webPreferences with this preload. */
export function traceWindowOptions(preloadPath: string): BrowserWindowConstructorOptions;
export type TraceWindowHandle = Pick<BrowserWindow, "loadFile" | "once" | "on" | "show" | "focus" | "restore" | "isMinimized" | "isDestroyed" | "close"> & {
  webContents: Pick<BrowserWindow["webContents"], "id" | "on" | "setWindowOpenHandler">;
};
export interface TraceWindowRegistryDeps {
  create(options: BrowserWindowConstructorOptions): TraceWindowHandle;
  preloadPath: string;
  /** dist/renderer/src/renderer/trace.html */
  traceHtmlPath: string;
}
export interface TraceWindowRegistry {
  /** Focuses the existing window for sessionId; else creates one, records webContents.id before loadFile(traceHtmlPath, {query: {session}}), blocks will-navigate and denies window.open. */
  openTraceWindow(sessionId: string): TraceWindowHandle;
  isTraceSender(webContentsId: number): boolean;
  /** The session the trace window with this webContents.id shows; undefined for any other sender (lane Da review). */
  sessionForSender(webContentsId: number): string | undefined;
  closeAll(): void;
  count(): number;
}
export function createTraceWindowRegistry(deps: TraceWindowRegistryDeps): TraceWindowRegistry;

// apps/desktop/src/main/trace-allowlist.ts (D-2)
export type SenderKind = "main" | "trace" | "other";
export const TRACE_WINDOW_CHANNELS: readonly string[];   // trace:listSessions, trace:rows, trace:payloads, trace:requestChanges
/** Spec §8.6: main → every channel except trace:requestChanges; trace → TRACE_WINDOW_CHANNELS only; other → none. */
export function isChannelAllowed(channel: string, sender: SenderKind): boolean;

// apps/desktop/src/main/trace-window-ipc.ts (D-2)
export interface TraceWindowIpcDeps {
  windows: TraceWindowRegistry;
  /** listSessions({ sessionId, limit: 1 }) through the TraceReader (A2 + section 1.3). */
  sessionExists(sessionId: string): boolean;
  focusMainWindow(): void;
  sendToRenderer: typeof import("./ipc.js").sendToRenderer;
}
/** trace:open → openTraceWindow (UNKNOWN_SESSION when absent); trace:requestChanges → UNTRUSTED_SENDER unless windows.sessionForSender(context.senderId) === sessionId, then focusMainWindow + composer:prefill. Never sends an instruction. */
export function registerTraceWindowHandlers(handle: IpcHandle, deps: TraceWindowIpcDeps): void;

// apps/desktop/src/shared/api.ts (D-3) — JevcodeApi additions
//   trace.open(sessionId: string): Promise<void>;
//   trace.requestChanges(request: { sessionId: string; selected: string; text: string }): Promise<void>;
//   onComposerPrefill(listener: (payload: { sessionId: string; text: string }) => void): () => void;

// apps/desktop/src/renderer/trace/ipc-source.ts (D-3)
import type { TraceSource } from "@jevcode/trace-viewer";
import type { JevcodeApi } from "../../shared/api.js";
/** summary() → trace.listSessions({sessionId, limit: 1}) (TraceSourceError UNKNOWN_SESSION when empty); rows → trace.rows; payloads → trace.payloads; now() → Date.now(). IPC errors become TraceSourceError with the channel name. */
export function createIpcTraceSource(bridge: JevcodeApi["trace"], sessionId: string): TraceSource;

// apps/desktop/src/renderer/trace/host.ts (D-3)
import type { ViewerHost } from "@jevcode/trace-viewer";
/** requestChanges → bridge.trace.requestChanges; onReady → log(`TRACE_READY ${rows}`). */
export function createDesktopViewerHost(bridge: Pick<JevcodeApi, "trace">, log: (line: string) => void): ViewerHost;

// apps/desktop/src/renderer/components/composer-prefill.ts (D-5)
/** "" → text; else the draft without trailing newlines + "\n" + text. */
export function appendPrefill(draft: string, text: string): string;
export type PrefillDecision = { kind: "apply"; draft: string } | { kind: "notice"; sessionId: string };
export function decidePrefill(activeSessionId: string | null, payload: { sessionId: string; text: string }, draft: string): PrefillDecision;
```

`IpcHandle` is the type A2-3 exports from `apps/desktop/src/main/trace-ipc.ts`. `apps/desktop/src/main/ipc.ts` (D-2): `IpcDeps` gains `senderKind(webContentsId: number): SenderKind` and `traceWindows: TraceWindowIpcDeps`; the `handle` wrapper (current lines 129-143, `ipcMain.handle(channel, async (event, raw) => { assertTrustedSender(event); const payload = parseToMain(channel, raw); …`) calls `if (!isChannelAllowed(channel, deps.senderKind(event.sender.id))) throw new IpcError("UNTRUSTED_SENDER", …)` right after `assertTrustedSender(event);`; the last statement of `registerIpcHandlers` after A2's `registerTraceHandlers(handle, deps.trace);` is `registerTraceWindowHandlers(handle, deps.traceWindows);`, so the new channels pass the allowlist and zod parsing like every other channel (spec §5.4 keeps them out of `registerTraceHandlers`, which holds only the reader). `apps/desktop/src/main/index.ts` (D-2): creates the registry after `mainWindow = createWindow();`, passes `senderKind: (id) => id === mainWindow?.webContents.id ? "main" : registry.isTraceSender(id) ? "trace" : "other"` and `traceWindows` in the `registerIpcHandlers` call, and closes all trace windows when the main window closes.

---

## 3. Task list

Size: S ≈ one module and one test file; M ≈ 2–4 files; L ≈ 5+ files or a dense algorithm. Every task ends with one conventional commit and passes section 5.

### C1a: visual primitives (lane 05a, wave W1)

| ID | Title | Files | Depends on | Size |
|---|---|---|---|---|
| C1-1 | Typed tokens, contrast math, base CSS, `--tv-ink-4` color guard | `packages/trace-viewer/src/ui/tokens/{tokens.ts, contrast.ts, base.module.css, tokens.test.ts}` | W0 | M |
| C1-2 | Icon family: names, paths, `IconSprite`, `Icon`, kind/lane/category/signal maps | `packages/trace-viewer/src/ui/icons/{icon-names.ts, paths.ts, IconSprite.tsx, Icon.tsx, kind-icons.ts, icons.test.tsx}` | W0 | M |
| C1-3 | Graphic scales and bar graphics (`DiffBar`, `TestDots`, `DurationBar`) | `packages/trace-viewer/src/ui/graphics/{scales.ts, scales.test.ts, DiffBar.tsx, TestDots.tsx, DurationBar.tsx, graphics.module.css, bars.test.tsx}` | C1-1 | M |
| C1-4 | Glyph graphics (`ForkGlyph`, `FlowGlyph`, `TableGlyph`, `ClaimVsObserved`) and the `Graphic` map | `packages/trace-viewer/src/ui/graphics/{ForkGlyph.tsx, FlowGlyph.tsx, TableGlyph.tsx, ClaimVsObserved.tsx, Graphic.tsx, graphics.module.css, glyphs.test.tsx}` | C1-2, C1-3 | M |

- **C1-1** Tests: every text token (`ink`, `ink2`, `ink3`, `accentInk`, `badInk`) ≥ 4.5:1 on panel, canvas and `composite(fill2, panel)`; `accentInk` ≥ 4.5:1 on `composite(accentSoft, panel)`, `badInk` on `composite(badSoft, panel)`, white on `accentInk`; marks (`mark`, `bad`, `accent`) ≥ 3:1 on the same three and `mark` on `composite(fill, canvas)` and `composite(fill2, canvas)`; `good` ≥ 3:1 on panel and canvas; `contrastRatio("#676D78", "#FFFFFF")` rounds to 5.20 and `contrastRatio("#FFFFFF", "#2F6BFF")` is below 4.5; the CSS guard reads every `src/**/*.module.css` at run time and fails on any declaration whose property is `color` and whose value holds `var(--tv-ink-4)` (spec §7.13 "lint rule").
- **C1-2** Tests: `ICON_PATHS` has non-empty data for every `IconName`; `IconSprite` renders one `<symbol>` per name with `id="tv-i-<name>"`; `<Icon name="neq" title="contradicts"/>` has `role="img"` and an accessible name, and without `title` is `aria-hidden`.
- **C1-3** Tests: `diffSidePx(0) === 0`, `diffSidePx(1) === 8`, `diffSidePx(127) === 56`, `diffSidePx(10_000) === 56`; `compactCount(999) === "999"`, `compactCount(1_234) === "1.2k"`; `durationPx(1_000) === 20`, `durationPx(10_000) === 60`, `durationPx(100_000) === 100`, `durationPx(100) === 4`; `TestDots` renders 15 dots for 14/1/0 with the failed dot larger and a bar plus count for 16 tests; `DurationBar` with `end: "exit_x"` draws an ✕ and no red fill.
- **C1-4** Tests: `ForkGlyph` with 4 options draws 3 branches and `+1`, the chosen branch solid and others dashed; `ClaimVsObserved` underlines exactly `text.slice(span[0], span[1])` and renders the claim as text; `GRAPHIC_COMPONENTS` has an entry for every `GraphicSpec["kind"]` (typecheck plus a runtime key check).

### C1b: viewer core and spike (lane 05b, wave W1)

| ID | Title | Files | Depends on | Size |
|---|---|---|---|---|
| C1-5 | Pure viewport math (`uniform` and `xOnly`) with properties | `packages/trace-viewer/src/layout/{viewport.ts, viewport.test.ts, viewport.property.test.ts}`; `packages/trace-viewer/src/index.ts` | W0 | M |
| C1-6 | Viewport controller: native wheel, pointer pan, rAF writes, settle, tween | `packages/trace-viewer/src/ui/viewport/{controller.ts, controller.test.ts}`; `packages/trace-viewer/src/index.ts` | C1-5 | L |
| C1-7 | **SPIKE (R28), one day:** synthetic harness, all 7 risks measured, rulings recorded | `apps/trace-viewer-dev/{spike.html, vite.spike.config.ts, .gitignore, src/vite-env.d.ts, src/spike/main.tsx, src/spike/synthetic.ts, src/spike/CanvasHarness.tsx, src/spike/OverviewHarness.tsx, src/spike/SwitchHarness.tsx, src/spike/measure.ts, src/spike/spike.module.css, scripts/spike-electron.cjs}`; `docs/spikes/trace-viewer-spike.md` | C1-6 | L |
| C1-7F | **Conditional, only if spike risk 1 fails:** d3-zoom behind the controller API | `packages/trace-viewer/src/ui/viewport/{d3-controller.ts, controller.ts, controller.test.ts}`; `docs/spikes/trace-viewer-spike.md` | C1-7 | M |
| C1-8 | Session builders and fast-check arbitraries (test-only) | `packages/trace-viewer/src/test-support/{session-builder.ts, session-builder.test.ts, arbitraries.ts}` | W0 | M |
| C1-9 | `TimeScale` (idle compression, breaks, live edge) and ticks | `packages/trace-viewer/src/layout/{time-scale.ts, time-scale.test.ts, time-scale.property.test.ts, ticks.ts, ticks.test.ts}` | C1-5, C1-8 | L |
| C1-10 | `TraceIndex`, brush and playhead resolution, tone | `packages/trace-viewer/src/layout/{trace-index.ts, trace-index.test.ts, tone.ts, tone.test.ts}` | C1-8 | M |
| C1-11 | `ViewState`, `ViewAction`, pure `reduce` with invariants | `packages/trace-viewer/src/ui/state/{view-state.ts, view-state.test.ts, view-state.property.test.ts}` | C1-10 | L |
| C1-12 | Selector store, location codec, pure keymap | `packages/trace-viewer/src/ui/state/{store.ts, store.test.tsx, location.ts, location.test.ts, keymap.ts, keymap.test.ts}`; `packages/trace-viewer/src/index.ts` | C1-11 | M |
| C1-13 | Overview index and layout (density, pins, bands, presets) | `packages/trace-viewer/src/layout/{overview-index.ts, overview-layout.ts, overview-layout.test.ts, overview-layout.property.test.ts, overview-layout.bench.ts}` | C1-9, C1-10 | L |
| C1-14 | Spine rows (brush slice, noise, elision, beats, separators) | `packages/trace-viewer/src/layout/{spine-rows.ts, spine-rows.test.ts, spine-rows.property.test.ts}` | C1-9, C1-10 | L |
| C1-15 | Sources: `createStaticBundleSource` with drip, `parseTraceBundle`, `readAllTraceRows`, errors, barrels | `packages/trace-viewer/src/sources/{errors.ts, static-bundle.ts, static-bundle.test.ts, read-all.ts, read-all.test.ts, index.ts}`; `packages/trace-viewer/src/index.ts` | W0 | M |

- **C1-5** Properties: `zoomAt` keeps the anchor fixed (world point for uniform, u for xOnly) within 1e-9; `screenToWorld(worldToScreen(p)) ≈ p`; `fitBounds` output contains the box with its padding; `tweenCamera(a, b, 0)` equals `a` and `(…, 1)` equals `b`; `wheelZoomFactor` stays in [0.8, 1.25].
- **C1-6** jsdom tests with fake `raf`/timers: a Ctrl+wheel dispatches `preventDefault` and changes k once per frame; a plain wheel pans; two wheel events in one frame produce one `onFrame`; settle fires once 150 ms after the last event with whole-pixel `tx`/`ty`; `set(camera, {animate: true})` under `reducedMotion() === true` arrives in one frame; `destroy()` removes the wheel listener (spy on `removeEventListener`).
- **C1-7** Deliverable: `docs/spikes/trace-viewer-spike.md` with one row per risk: measured values, pass or fail against spec §16's pass column verbatim, and the ruling applied. The harness builds 60 chapters plus 40 story frames at Step level (~4k DOM nodes), 300 edges and 5k lane marks with the real `createViewportController`. Automated: risk 1 (`visualViewport.scale === 1`, scroll 0, anchor ≤ 1 px per event), risk 2 (rounded rAF intervals, ≤ 5% dropped at 60 Hz over a 3 s sweep 0.35 → 2, with and without `will-change`), risk 3 (`capturePage` crops at k 0.5/1/2, DPR 1 and 2, ≤ 1% pixels differ by > 16), risk 5 (pin DOM x vs painted mark x ≤ 1 px during pan and pinch; redraw on `devicePixelContentBoxSize`), risk 6 (two dummy views under `<Activity>` toggled mid-gesture and during a 1 Hz drip: store deep-equal, center time within 1 px, zero hidden rAF callbacks, no 0 × 0 fit), risk 7 (edge stroke 1.5 CSS px after settle at k 0.5–2; ruler ticks within 1 px during a pinch); CSP console errors = 0 under `vite.spike.config.ts`. **HUMAN CHECK** (the controller asks the user and records the answer): risk 1 blind A/B (10 trials, hand-rolled identified ≤ 7 times) and risk 4 VoiceOver reading "Linking test, 1 failed, 14 passed, +0:33" plus Tab order. Rulings on failure: 1 → run C1-7F in this lane before merge; 4 → C2-5 adds each frame's full description to its Outline row; 5 → C2-11 paints pins on the canvas and keeps DOM buttons only as focus targets; 2 → C3-5 adds x0 binary-search culling and caps Step lists; 3 → C3-5 sets `settleRoundK: 64`; 6 → C3-5 sets `KEEP_HIDDEN_VIEWS_MOUNTED = false`; 7 → C3-5 sets `INV_K_EVERY_FRAME = true` (as built, all three constants live in `views/canvas/spike-rulings.ts`, section 2.4).
- **C1-7F** Test: the C1-6 suite passes unchanged against the d3-zoom implementation (the API is the contract); `controller.ts` re-exports `createViewportController` from `d3-controller.ts`. Skipped (no commit) when risk 1 passes; the spike doc says so.
- **C1-8** `buildSession(seed: SessionSeed): TraceSession` assigns seqs 1..n in order, `step:<firstSeq>` ids, lanes from a local copy of the section 1.4 B-2 table, `startMs`/`originMs`, and sorts every list by (seq, id); `oauthLikeSession()` mirrors oauth (intent, plan, 3 chapters, `Noise ×2`, decision, 2 linking chapters, failed `pnpm test` 14/1/0, claim at +0:43 with `claimSpan` over "all checks pass" and a critical `claim_contradicted`); `arbTraceSession({maxSteps, maxChapters, maxTurns})` covers multi-turn, no-chapter, gaps and running sessions. Test: `buildSession` output satisfies the W0 invariants (`tMs` monotone, ids unique, `noise` null wherever `problems` or `findingIds` is non-empty).
- **C1-9** Properties: `toU` monotone; `toT(toU(t)) === t` on work segments; appending work after T leaves `toU(t)` unchanged for t ≤ T; the live edge is continuous as `liveTMs` grows; identity (`toU(t) === t`) when no gap exceeds 10 s. Examples: `displayGapMs(20_000) ≈ 15_000`, `(60_000) ≈ 22_925`, `(300_000) ≈ 34_534`, `(3_600_000) ≈ 52_430`; a decision wait of 10 min produces one `awaiting_supervisor` segment and one break; ticks are ≥ 64 px apart and none falls inside a break.
- **C1-10** Tests: `brushSeqRange({kind: "range", fromSeq: 5, toSeq: "live"})` ends at `loadedThroughSeq`; a chapter brush resolves by `anchorSeq` after the unit id changes; `stepTone` is `neutral` for a command with exit 1 and `bad` for a failed test; `worstSeverity` picks critical over warning.
- **C1-11** Property tests listed under section 2.3, plus **Review Focus 1** "a collapsed critical finding stays collapsed across session/applied" and **Review Focus 2** "regrouped selection follows the anchor seq".
- **C1-12** Tests: `useView` re-renders only when its selected slice changes (render counter); `decodeLocation("garbage", "s")` returns defaults; `locationFromHash(locationToHash(l), l.sessionId)` round-trips (fast-check); **Review Focus 5**: `resolveKey({code: "KeyJ", key: "ㅓ", …})` is `{cmd: "item", dir: 1}`, any key with `isComposing` is `null`, `Shift+Digit1` is fit-all while `Digit1` is the Canvas view, `Alt+Digit2` is level chapter, `KeyC` with Meta and `hasTextSelection` is `null`, `Space` without `spaceOverPannable` is `null`.
- **C1-13** Properties: a pan changes only x offsets (same bins, marks, pins shifted by −dx); every problem tick survives at every k in [fit, K_MAX]; pins never overlap (centers ≥ 26 px); overlay node count ≤ 150 at Session level on a 5k-step arbitrary. Examples: on `oauthLikeSession()` at Chapter level the pins are instruction, decision fork, claim quote, failed test and one link. **Review Focus 3** "turns stand in for chapters" (a session with no chapters has bands keyed `turn:<n>`). Bench `overview-layout.bench.ts`: layout at Session level on the 60-chapter/5k-step arbitrary (reported; the p95 ≤ 4 ms gate is measured in the HUD at C2-16).
- **C1-14** Properties: the playhead row and every pinned row are never elided; keys from a prefix fold stay in the full fold except the open tail. Examples on `oauthLikeSession()`: one test row (14/1/0) and an expanded claim row at +0:43; a 412-row unpinned segment renders 3 + band + 5; **Review Focus 3** "exit -1 is unknown, never failed".
- **C1-15** Tests: a `version: 2` bundle yields `UNSUPPORTED_VERSION`; `{}` yields `NOT_A_TRACE`; with `drip: {rowsPerTick: 2, intervalMs: 100, manual: true}`, `rows()` returns 2 rows and state `running` until enough `tick()` calls release all rows, then the bundle's state; `now()` equals the last released row's source time; `readAllTraceRows` with `pageSize: 3` returns every row once.

### C2: shell and Hybrid, M4a (lane 06, wave W2)

| ID | Title | Files | Depends on | Size |
|---|---|---|---|---|
| C2-0 | M4a spike gate: risks 1, 4, 5 passed or ruled | `docs/spikes/trace-viewer-spike.md` | W1 | S |
| C2-1 | ui-catalog `CodeDiff` keeps real `@@` headers; markup renders as text | `packages/ui-catalog/src/components/CodeDiff.tsx`; `packages/ui-catalog/src/components.test.tsx` | W1 | S |
| C2-2 | `DataController`: paging, ≤ 4 commits/s, poll, backoff, stale-response guard, gesture hold, visibility | `packages/trace-viewer/src/ui/shell/{data-controller.ts, data-controller.test.ts}` | W1 | L |
| C2-3 | `TraceViewer`, `Shell` grid and landmarks, contexts, view registration API, `LiveRegion`, error boundaries, perf marks | `packages/trace-viewer/src/ui/shell/{TraceViewer.tsx, Shell.tsx, Shell.module.css, ViewSlot.tsx, session-context.ts, host.ts, LiveRegion.tsx, ErrorBoundary.tsx, perf.ts, shell.test.tsx}`; `packages/trace-viewer/src/ui/views/view-port.ts`; `packages/trace-viewer/src/index.ts` | C2-2 | L |
| C2-4 | `TitleBar`: title, chips, Review/Live, N new, duration, zoom menu, view switch slot | `packages/trace-viewer/src/ui/shell/{TitleBar.tsx, TitleBar.module.css, title-bar.test.tsx}` | C2-3 | M |
| C2-5 | `Outline`: story tree, Files/Commands/Tests, search, virtualized tree | `packages/trace-viewer/src/ui/shell/Outline/{Outline.tsx, outline-rows.ts, outline-rows.test.ts, Outline.module.css, outline.test.tsx}` | C2-3 | L |
| C2-6 | Inspector frame, Summary per kind, finding copy, review note, footer actions | `packages/trace-viewer/src/ui/inspector/{Inspector.tsx, Summary.tsx, finding-copy.ts, review-note.ts, review-note.test.ts, Inspector.module.css, inspector.test.tsx}` | C2-3 | L |
| C2-7 | Inspector Evidence (CodeDiff, output, labels) and lazy Raw | `packages/trace-viewer/src/ui/inspector/{Evidence.tsx, Raw.tsx, Inspector.module.css, evidence-raw.test.tsx}` | C2-1, C2-6 | M |
| C2-8 | Keyboard layer, regions and F6, roving tabindex, shortcut sheet | `packages/trace-viewer/src/ui/shell/{KeyboardLayer.tsx, regions.ts, ShortcutSheet.tsx, keyboard.test.tsx}` | C2-4, C2-5, C2-6 | M |
| C2-9 | Shared view parts: `Ruler`, `LevelControl`, `NewBadge` | `packages/trace-viewer/src/ui/views/shared/{Ruler.tsx, LevelControl.tsx, NewBadge.tsx, shared.module.css, shared.test.tsx}` | C2-3 | M |
| C2-10 | Overview painter (`paint.ts`) and DPR canvas surface | `packages/trace-viewer/src/ui/views/hybrid/overview/{paint.ts, paint.test.ts, OverviewCanvas.tsx}`; `packages/trace-viewer/src/test-support/recording-context.ts` | C2-3 | M |
| C2-11 | Overview DOM: pins, brush and playhead sliders, pointer and keyboard interactions | `packages/trace-viewer/src/ui/views/hybrid/overview/{Overview.tsx, Pins.tsx, Brush.tsx, Overview.module.css, overview.test.tsx}` | C2-9, C2-10 | L |
| C2-12 | Spine: virtualizer, row components, scroll ↔ playhead sync | `packages/trace-viewer/src/ui/views/hybrid/spine/{Spine.tsx, scroll-sync.ts, scroll-sync.test.ts, rows/StepRow.tsx, rows/SeparatorRows.tsx, rows/GroupRows.tsx, Spine.module.css, spine.test.tsx}` | C2-3 | L |
| C2-13 | Spine finding bodies (`FINDING_BODY`) | `packages/trace-viewer/src/ui/views/hybrid/spine/findings/{FindingBody.tsx, ClaimFinding.tsx, TestsFinding.tsx, DestructiveFinding.tsx, GuardrailFinding.tsx, RecoveryFinding.tsx, findings.test.tsx}` | C2-12 | M |
| C2-14 | `HybridView`: composition, `ViewPort`, presets, live follow, "N new", view registry | `packages/trace-viewer/src/ui/views/hybrid/{HybridView.tsx, hybrid-port.ts, hybrid-port.test.ts, HybridView.module.css, hybrid-view.test.tsx}`; `packages/trace-viewer/src/ui/views/registry.ts` | C2-11, C2-13, C2-8 | L |
| C2-15 | Dev host: bundle loading, drop, drip, hash location, selftest, perf HUD, serve-only source alias | `apps/trace-viewer-dev/{vite.config.ts, .gitignore, src/main.tsx, src/host.tsx, src/host.module.css, src/selftest.ts, src/perf-hud.tsx}` | C2-14 | M |
| C2-16 | Visual smoke (Hybrid) and the M4a exit | `apps/trace-viewer-dev/scripts/smoke.mjs`; `docs/spikes/trace-viewer-spike.md` | C2-15 | M |

- **C2-0** Reads the spike doc. Pass: risks 1, 4, 5 are "pass" or have their ruling recorded with the owning task named (risk 1 → C1-7F merged in W1). Otherwise stop and escalate: M4a does not start.
- **C2-1** Tests (extend `components.test.tsx` `describe("CodeDiff")` at :256): a two-hunk diff keeps both `@@ -10,3 +10,4 @@` style headers and real line numbers; a diff line `+<img src=x onerror=alert(1)>` renders as text (no `img` element) — **Review Focus 4**. Anchor: `normalizeDiff` currently filters every `@@` line (`const body = bodyLines.filter((line) => !/^@@ /.test(line));`) and synthesizes `@@ -1,N +1,M @@`; synthesize only when the body has no `@@` header.
- **C2-2** Tests with a fake `Scheduler` and a scripted source: pages until `nextAfterSeq` is null with ≤ 4 commits per second; polls every `pollMs` until `terminal(page.state)`, applies once more, then stops; `paused` keeps polling; a rejected poll yields `reconnecting` with 1, 2, 4, 10, 10 s and keeps `session`; a slow response older than a newer one is dropped; **Review Focus 1** "holds applies during a gesture and applies the latest once"; while hidden it polls but emits once on `notifyVisible()`.
- **C2-3** Tests: the Shell renders `header`, `nav`, `main`, `aside` landmarks; tokens are inline `--tv-*` properties on the root; an Inspector render error shows the Inspector boundary and keeps the selection; `host.onReady` fires once with the row count after the first committed fold; `selected: "decision:dec-oauth-0001"` in the location resolves to the decision step (via `resolveStableId`).
- **C2-4** Tests: title is `repoName / prompt` with the full prompt in `title`; **Review Focus 3** "data-quality chips are neutral" (`≈ Approximate joins` and "3 gaps" carry no bad class); Live is disabled and labelled "Completed" on a terminal session; the "N new" pill shows a red dot only when a new critical finding arrived; the duration is the display-clock span, never `endedAt − startedAt`; the view switch renders only when `VIEWS.length > 1`.
- **C2-5** Tests: Turn rows only when there is more than one turn; Files collapse above 12; a failed command row shows ✕ and the word "failed"; search marks matches and hides nothing; `aria-selected` and `aria-current` track selection and playhead chapter; risk 4 ruling (if recorded) puts the frame description in the row's accessible name.
- **C2-6** Tests: Summary is the default tab; a new selection resets Raw to Summary while Evidence persists; "Request changes" renders only when `host.requestChanges` exists (else "Copy review note") and both are disabled with no selection; **Review Focus 4** "agent text never fills the title slot" and `review-note.test.ts` "fences quoted text longer than any backtick run inside it"; oauth's note line 1 is `Re: trace <sessionId> +0:43 "Claim contradicts tests" (seq 48; evidence seq 46)` with seqs located by content.
- **C2-7** Tests: an edit with `diff: "withheld_secret"` shows "Diff withheld: secret path" and no CodeDiff; Raw calls `payloads` with at most 50 seqs and shows "N more"; a `clipped` row shows "Clipped to head + tail (16 KiB)"; a payload failure shows inline Retry.
- **C2-8** Tests (**Review Focus 5**): exactly one `tabindex="0"` per region; F6 cycles Outline → main → Inspector; Esc unwinds search → hand → collapse → parent → clear and never moves the camera; Space with focus in `main` does not click the focused button; Cmd+C with a text selection does not copy the note.
- **C2-9** Tests: the `Ruler` draws ticks from `computeTicks` with `formatOffset` labels and hatches past `loadedThroughSeq`; `LevelControl` is a radiogroup; `NewBadge` announces through the live region at most once per 10 s.
- **C2-10** Tests against `recording-context.ts`: red problem ticks survive binning at Session level; heat bars use `LIGHT_TOKENS.mark`; the canvas is sized at `widthPx × DPR` and `aria-hidden`.
- **C2-11** Tests: a click on an empty track moves the playhead (`free`) and leaves the selection; a drag under 4 px is a click; the playhead handle is `role="slider"` with `aria-valuetext` like "+0:43, Claim contradicts tests, step 38 of 412"; `←`/`→` move one step, `Alt` one pin, `Shift` one chapter; `{`, `}` and `b` set the brush; risk 5 ruling (if recorded) paints pins on the canvas.
- **C2-12** Tests with stubbed `getBoundingClientRect`/`ResizeObserver`: the virtualizer gets `anchorTo: "end"`, `followOnAppend: "auto"` only while following, `scrollEndThreshold: 24`, `overscan: 10`; `rangeExtractor` keeps the playhead and focused indexes; a playhead write with origin `"spine"` never calls `scrollToIndex`; `scroll-sync.ts` moves the playhead the minimum distance into the comfort band; the live footer is outside the list; the feed has `role="feed"` with `aria-posinset`/`aria-setsize`.
- **C2-13** Tests: `FINDING_BODY` covers every `SignalId`; the claim body shows `[test] —— [quote] 3.0 s` where 3.0 s = claim `tMs` − (evidence `tMs` + `durationMs`), `ClaimVsObserved` with the span underlined, and clicking the observed card moves the playhead to the evidence step.
- **C2-14** Tests: oauth (a real fold via `loadFixtureTrace("oauth")` + `foldRows`) opens in Review with "Claim contradicts tests" selected and expanded at +0:43; `j` slides the brush past its edge; Alt+1/2/3 apply presets; in Live an append keeps the playhead at the edge; in Review it raises "↓ N new" and never moves focus; `readingOrder()` equals the spine's step keys.
- **C2-15** Deliverable: `pnpm --filter jevcode-trace-viewer-dev build` passes (the browser-safety proof); `vite.config.ts` gains `resolve.alias` `{ "@jevcode/trace-viewer": "<repo>/packages/trace-viewer/src/index.ts" }` only when `command === "serve"`; `.gitignore` gains `public/bundles/` and `.smoke/`.
- **C2-16** Deliverable: `node apps/trace-viewer-dev/scripts/smoke.mjs --views hybrid` prints `SMOKE_OK`; the spike doc gains an "M4a exit" section with the HUD numbers (first paint, full load, `j` to painted, overview p95 and node count, per spec §10 "Method"), the Hybrid screenshots' paths and the product review-gate session (spec §12 M4a; **HUMAN CHECK**: the controller asks the user to hold and record it; a failed gate returns the UI to iteration before W3).

### C3a: canvas layout, pure (lane 07a, wave W2)

| ID | Title | Files | Depends on | Size |
|---|---|---|---|---|
| C3-1 | Level constants and `collectItems` | `packages/trace-viewer/src/layout/{canvas-levels.ts, canvas-levels.test.ts, canvas-layout.ts, canvas-items.test.ts}` | W1 | M |
| C3-2 | Placement, sticky state, column time map, `canvasXMap`; P1–P8, P10 | `packages/trace-viewer/src/layout/{canvas-layout.ts, canvas-layout.test.ts, canvas-layout.property.test.ts}`; `packages/trace-viewer/src/test-support/canvas-arbitraries.ts` | C3-1 | L |
| C3-3 | Edge routing (trunk comb, contradicts, decides, validates, lanes); P9 | `packages/trace-viewer/src/layout/{canvas-routes.ts, canvas-routes.test.ts, canvas-layout.ts, canvas-layout.property.test.ts}` | C3-2 | L |
| C3-4 | Minimap model and the layout benchmark | `packages/trace-viewer/src/layout/{canvas-minimap.ts, canvas-minimap.test.ts, canvas-layout.bench.ts}` | C3-3 | M |

- **C3-1** Tests: `LEVEL_SPECS.chapter` gives `pitch 264`, `storyBand 118`, `workTop 150`; a resume turn whose prompt is "Continue the task." adds no story item; a flagged noise chapter is `chapter`, not `noise`; a warning finding step with no chapter becomes `loose`.
- **C3-2** Tests: the spec §7.5 oauth table (slot origins (0,0), (264,0), (264,150), (264,300), (264,450), (264,600) `Noise ×2`, (528,0), (528,150), (528,300), (792,0); bounds 1016 × 658) on a fold of oauth rows whose `change_unit` rows are replaced by units built from `fixtures/oauth/expected_units.json` (so clusterer drift cannot move the table), fresh and under a one-row drip where every placed key keeps its rect; **Review Focus 2** "a unit whose id changes keeps its key, rect and selection"; chapter ↔ noise flips; a steer after 14 idle minutes yields one separator labelled with turn and idle time; a 5-minute test command alone makes no break. Properties P1–P8 and P10 over `arbCanvasSession()`.
- **C3-3** Tests: on oauth the trunk runs at y ≈ 124 from col 0 to col 3; Decision → Linking policy is `stacked`; Identity → Decision is `adjacent` in gutter 488–528; Claim ≠ Linking test is a red `adjacent` S-curve in gutter 752–792 with the badge at (772, 224). Property P9.
- **C3-4** Tests: `buildMinimap` scale `s = max(min(140/B.w, 84/B.h), 0.03)`; a 8000 × 750 layout shows a window plus a strip with red ticks for critical frames; `minimapToWorld` inverts the scale. Bench: fresh ≤ 2 ms and sticky ≤ 0.5 ms on the 60-chapter/5k-step session (benchmark, recorded, never a CI gate).

### C3b: Canvas view and view switch, M4b (lane 07b, wave W3)

| ID | Title | Files | Depends on | Size |
|---|---|---|---|---|
| C3-5 | M4b spike gate: risks 2, 3, 6, 7 passed or ruled; apply rulings | `docs/spikes/trace-viewer-spike.md`; `packages/trace-viewer/src/ui/viewport/controller.ts` (risk 3 only); `packages/trace-viewer/src/ui/views/registry.ts` (risk 6 only) | W2 | S |
| C3-6 | Frame components per kind and level, labels, roving focus | `packages/trace-viewer/src/ui/views/canvas/{Frame.tsx, frame-content.tsx, frame-label.ts, frame-label.test.ts, Frame.module.css, frame.test.tsx}` | C3-5 | L |
| C3-7 | World layer, edge SVG, screen-space overlay | `packages/trace-viewer/src/ui/views/canvas/{World.tsx, EdgeLayer.tsx, Overlay.tsx, World.module.css, world.test.tsx}` | C3-6 | L |
| C3-8 | Minimap panel and floating toolbar (select, hand, fit, level, Tidy) | `packages/trace-viewer/src/ui/views/canvas/{Minimap.tsx, Toolbar.tsx, chrome.module.css, chrome.test.tsx}` | C3-7 | M |
| C3-9 | Canvas camera rules: fit, zoom to selection, reveal, level switch pinning, brush write on settle | `packages/trace-viewer/src/ui/views/canvas/{canvas-camera.ts, canvas-camera.test.ts}` | C3-5 | M |
| C3-10 | `CanvasView`: composition, ruler XMap, live follow, sticky layout across ticks, `ViewPort` | `packages/trace-viewer/src/ui/views/canvas/{CanvasView.tsx, canvas-port.ts, canvas-port.test.ts, CanvasView.module.css, canvas-view.test.tsx}` | C3-8, C3-9 | L |
| C3-11 | View switch: register Canvas, `<Activity>` restore rules, switch tests | `packages/trace-viewer/src/ui/views/{registry.ts, view-switch.test.tsx}` | C3-10 | M |
| C3-12 | Canvas smoke and selftest; M4b exit | `apps/trace-viewer-dev/{scripts/smoke.mjs, src/selftest.ts}`; `docs/spikes/trace-viewer-spike.md` | C3-11 | M |

- **C3-5** Pass: risks 2, 3, 6, 7 are "pass" or their ruling is applied here (risk 2's culling is added to C3-7's scope and recorded; risk 3 sets `settleRoundK: 64` at the Canvas call site; risk 6 sets `KEEP_HIDDEN_VIEWS_MOUNTED = false`; risk 7 is applied in C3-7 as `INV_K_EVERY_FRAME = true`). As built: the constants live in `ui/views/canvas/spike-rulings.ts` (`CANVAS_SETTLE_ROUND_K = 64`, `INV_K_EVERY_FRAME = false` since risk 7 passed, `CULL_FRAMES = true`), and risk 6 passed, so `KEEP_HIDDEN_VIEWS_MOUNTED` stays true (section 2.4).
- **C3-6** Tests: `frameLabel` builds "Linking test, 1 failed, 14 passed, +0:33" for oauth's linking-test chapter; frames are `role="group"` in DOM time order with one `tabindex="0"`; below k 0.5 the graphic hides and below 0.35 only icon and state fill show; Step level shows a nine-row list whose wheel scrolls unless Ctrl/Meta is held.
- **C3-7** Tests: edges draw under frames with stroke `calc(1.5px * var(--tv-inv-k))`; the `contradicts` path has an 8 px transparent hit twin and the ≠ badge; `will-change` is set only during a gesture; focusing a frame uses `preventScroll` and the viewport's `onScroll` guard resets any browser scroll.
- **C3-8** Tests: minimap click centers at the current zoom; dragging the viewport outline pans; Tidy appears only when `stats.holes > 0`; the toolbar has no comment tool.
- **C3-9** Tests: Fit at Chapter with fit k < 0.35 switches the shared level to Session first; zoom to selection caps at 1.5; reveal does nothing when the card is inside the 48 px inset and never zooms; a settled user pan writes `brush/set` with the steps inside the window and an empty window writes nothing; a programmatic move never writes the brush.
- **C3-10** Tests (**Review Focus 1**): "an append leaves every placed frame's rect unchanged" (sticky `prev` across ticks); in Live the camera pans x only when the frontier column leaves the view; in Review it never moves and an "N frames →" badge appears; `readingOrder()` equals `layout.readingOrder` plus expanded frames' steps.
- **C3-11** Tests (**Review Focus 6**): `1` then `2` then `1` leaves the store deep-equal except `cameras`; with `syncedRev === focusRev` the Canvas camera restores exactly; otherwise it fits the brush horizontally with k in [minZoom(level), 1.5]; "never fits a 0x0 rect" (ResizeObserver width 0 ignored); "a hidden view holds no listeners" (no wheel listener and no rAF while `mode="hidden"`).
- **C3-12** Deliverable: `node apps/trace-viewer-dev/scripts/smoke.mjs --views hybrid,canvas` prints `SMOKE_OK`; the spike doc gains an "M4b exit" section with the pinch frame-drop and view-switch HUD results and the Canvas screenshots, and states that the oauth Canvas matches the spec §7.5 table (C3-2).

### Da: Electron main process, M5 (lane 08a, wave W2)

| ID | Title | Files | Depends on | Size |
|---|---|---|---|---|
| D-1 | Trace window registry and `openTraceWindow` | `apps/desktop/src/main/{trace-window.ts, trace-window.test.ts}` | W1 | M |
| D-2 | `trace:open`, `trace:requestChanges`, `composer:prefill`; sender allowlist in `handle`; wiring | `apps/desktop/src/shared/{local-channels.ts, ipc-registry.test.ts}`; `apps/desktop/src/main/{trace-allowlist.ts, trace-allowlist.test.ts, trace-window-ipc.ts, trace-window-ipc.test.ts, ipc.ts, index.ts}` | D-1 | L |

- **D-1** Tests with fake handles: a second `openTraceWindow` for the same id focuses and restores the existing window and creates none; `webContents.id` is recorded before `loadFile` and `loadFile` gets `{query: {session}}`; `will-navigate` is prevented and `setWindowOpenHandler` returns `{action: "deny"}`; closing removes the entry; `traceWindowOptions` has `minWidth: 1000`, `backgroundColor: "#FFFFFF"`, `show: false`, `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`.
- **D-2** Tests: for every channel value in `RendererToMainLocalChannels` and the contracts `RendererToMainChannels` outside the four trace-window channels, `isChannelAllowed(channel, "trace")` is false; `trace:open` from `"trace"` and `trace:requestChanges` from `"main"` are false; every channel from `"other"` is false; `trace:requestChanges` with 8,001 characters fails `INVALID_PAYLOAD`; the handler for an existing session calls `focusMainWindow` and sends exactly one `composer:prefill` and nothing else; for an unknown session it throws `UNKNOWN_SESSION` and sends nothing. Anchor: `handle` in `registerIpcHandlers` (ipc.ts:129-143). Deliverable: `pnpm --filter jevcode-desktop typecheck` and `test` pass; the channels are inert until Db wires the renderer.

### Db: trace window, live and parity, M5 (lane 08b, wave W3)

| ID | Title | Files | Depends on | Size |
|---|---|---|---|---|
| D-3 | API namespace; `trace.html` second Vite input; trace entry; `createIpcTraceSource`; desktop host | `apps/desktop/src/shared/{api.ts, api.test.ts}`; `apps/desktop/src/renderer/{trace.html, trace/main.tsx, trace/ipc-source.ts, trace/ipc-source.test.ts, trace/host.ts, trace/host.test.ts}`; `apps/desktop/vite.config.ts` | W2 | L |
| D-4 | "Trace" button beside Inspect | `apps/desktop/src/renderer/components/Header.tsx`; `apps/desktop/src/renderer/App.tsx` | D-3 | S |
| D-5 | Composer prefill in WorkspaceHost | `apps/desktop/src/renderer/components/{WorkspaceHost.tsx, composer-prefill.ts, composer-prefill.test.ts}` | D-3 | M |
| D-6 | Extended `runSmoke`: trace window, `TRACE_READY`, console and CSP errors; ui-catalog `jitless` | `apps/desktop/src/main/{index.ts, smoke.ts, smoke.test.ts}`; `packages/ui-catalog/src/catalog.ts` | D-3 | M |
| D-7 | `trace-parity.test.ts`: IPC source and bundle fold deep-equal for five fixtures | `apps/desktop/src/main/trace-parity.test.ts` | D-3 | M |
| D-8 | M5 exit: live-tick and soak-open budgets, docs | `docs/perf.md`; `docs/SPEC.md` (§13); `docs/security.md` | D-4, D-5, D-6, D-7 | S |

(Lane Da holds D-1 and D-2; lane Db holds D-3 to D-8, so every D-* id is unique across the two D lanes.)

- **D-3** Tests: `createIpcTraceSource(fakeBridge, "s").summary()` calls `listSessions({ sessionId: "s", limit: 1 })` and rejects with `TraceSourceError` code `UNKNOWN_SESSION` on `[]`; `payloads([1, 2])` passes a plain array; an IPC rejection becomes a `TraceSourceError` naming the channel; `createDesktopViewerHost(...).onReady({rows: 12, …})` logs `TRACE_READY 12`. Anchors: `apps/desktop/vite.config.ts` `rollupOptions: { input: "src/renderer/index.html" }` becomes `input: { main: "src/renderer/index.html", trace: "src/renderer/trace.html" }` and `build` gains `assetsInlineLimit: 0`; `trace.html` copies index.html's CSP meta and loads `./trace/main.tsx`, which never imports `styles.css`.
- **D-4** Anchor: Header.tsx's Inspect button (`onClick={props.onToggleDebug}` … `Inspect`); the new button calls `props.onOpenTrace`, is disabled without an active session, and never calls `session.switchTo`. Check: `pnpm --filter jevcode-desktop typecheck`.
- **D-5** Tests: `appendPrefill("", "x") === "x"`, `appendPrefill("a\n\n", "x") === "a\nx"`; `decidePrefill("s1", {sessionId: "s2", …}, d)` is a notice. Anchor: the composer `<textarea aria-label="Guide the agent" … value={instruction}` (WorkspaceHost.tsx ~:833) and `const [instruction, setInstruction] = useState("");` (:402); the listener appends, focuses with the caret at the end, keeps `instructionMode` and never sends; another session's note shows "Trace note for another session · Switch".
- **D-6** Tests on `smoke.ts` with fake windows: a console `error` or a `securitypolicyviolation` message in either window fails the smoke; `TRACE_READY <rows>` passes it; the trace phase runs only when `JEVCODE_SMOKE_TRACE=1` and `JEVCODE_DB` are set. `catalog.ts` gains `z4.config({ jitless: true })` at module load (spec §8.7). Deliverable: `JEVCODE_SMOKE=1 JEVCODE_SMOKE_TRACE=1 JEVCODE_DB=<replay.db> pnpm --filter jevcode-desktop start` prints `SMOKE_OK`.
- **D-7** Test: for each of the five fixtures, `runReplay` into a temp dir, then fold `readAllTraceRows(createIpcTraceSource(bridgeOver(createTraceService(openTraceReader(replayDb))), id))` after passing its rows through A2's `redactBundleValue` (the bundle's redaction), and fold `readAllTraceRows(createStaticBundleSource(parseTraceBundle(trace.json).bundle))`; the two `TraceSession`s are deep-equal. Imports come from `@jevcode/trace-viewer/sources` and `@jevcode/trace-viewer/model` only.
- **D-8** Deliverable: `docs/perf.md` records every UI budget from the spike doc's M4a/M4b sections plus the M5 live tick (dev host drip on the soak bundle, `rowsPerTick: 20`, `intervalMs: 1000`, from `lastSeq − 2000`, and one manual mock-adapter session in the trace window, **HUMAN CHECK**) and the soak open in the trace window; SPEC §13 gains the same rows; `docs/security.md` records the trace-window channel allowlist.

---

## 4. Waves, ownership and merge order

| Wave | Lanes (parallel) | Base | Merge order |
|---|---|---|---|
| W0 | W0 (with section 1.1 and 1.2 amendments) | `main` at `144c7fb` | W0 |
| W1 | A1, A2 (with section 1.3), B (with section 1.4), **C1a**, **C1b** | `main` after W0 | A1 → A2 → B → C1a → C1b |
| W2 | **C2**, **C3a**, **Da** | `main` after W1 | C2 (M4a) → C3a → Da |
| W3 | **C3b**, **Db** | `main` after W2 | C3b (M4b) → Db (M5) |

**Why each lane sits where it does.**
- **C1a, C1b in W1.** They consume only W0 names: model types (with section 1.2), `TraceSource`, contracts, tokens they define themselves. They never import B's runtime (`format.ts`, `fold.ts`, `signals.ts`, `lookup.ts`, `search.ts`), which does not exist until B merges; their tests use `src/test-support/session-builder.ts`. C1a and C1b share no file (C1a exports nothing through `src/index.ts`), so they run as two lanes, which keeps W1's critical path near A1's and B's length (C1b has 11 tasks plus the conditional C1-7F).
- **The spike is C1-7**, the third C1b task, after the viewport math and controller it measures; it is the first work of the UI milestone M4a. Its ruling for risk 1 (C1-7F) lands inside C1b before W1 merges; rulings for 4 and 5 are carried by C2 tasks; rulings for 2, 3, 6 and 7 by C3-5.
- **C2 in W2.** It needs B (fold, format, `pickGraphic`, `describeGraphic`, `searchSteps`, `resolveStableId`, `compareFindings`) and both C1 lanes.
- **C3a in W2, beside C2.** Canvas layout is pure: it needs model types, B's fold for the oauth example tests (merged in W1) and C1b's `time-scale.ts` and `trace-index.ts`. Its files are `layout/canvas-*.ts`, their tests and `test-support/canvas-arbitraries.ts`; C2 touches none of them, and C3a touches no C2 file. This moves four of the riskiest algorithm tasks (spec §7.5, P1–P10) off the W3 critical path.
- **Da in W2, beside C2.** The trace window registry, the two new channels and the allowlist need only A2 (merged in W1) and W0; they touch `apps/desktop/src/{main,shared}` files that no W2 lane touches. They are inert until Db adds `trace.html`, so merging them before M4b does not change behavior (D9 order is about user-visible behavior).
- **C3b and Db in W3.** C3b needs C2's shell, registry and Ruler and C3a's layout; Db needs C2's `TraceViewer` and Da's channels. Their files are disjoint.

**Files touched by more than one lane, and how they are sequenced.**

| File | Owners | Sequencing |
|---|---|---|
| `packages/trace-viewer/src/index.ts` | W0-1, W0-6; C1-5, C1-6, C1-12, C1-15 (C1b); C2-3 | Different waves; inside C1b tasks run in order and each appends lines. C1a and C3a never edit it |
| `packages/trace-viewer/src/source.ts` | W0-6 (section 1.2 version) | W0 only; UI lanes consume it |
| `packages/trace-viewer/src/model/*` | W0-6, B | UI lanes never edit `src/model` |
| `packages/trace-viewer/src/test-support/` | B-2 (`fixture-rows.ts`), C1-8 (`session-builder.ts`, `arbitraries.ts`), C2-10 (`recording-context.ts`), C3-2 (`canvas-arbitraries.ts`) | Disjoint files; B and C1b share W1 but not a file |
| `packages/trace-viewer/src/ui/viewport/controller.ts` | C1-6, C1-7F (C1b, W1); C3-5 (risk 3 ruling only, W3) | Different waves |
| `packages/trace-viewer/src/ui/views/registry.ts` | C2-14 (W2); C3-5 (risk 6 only), C3-11 (W3) | Different waves; inside C3b in task order |
| `packages/trace-viewer/src/ui/graphics/graphics.module.css` | C1-3, C1-4 | Same lane, task order |
| `packages/trace-viewer/src/ui/inspector/Inspector.module.css` | C2-6, C2-7 | Same lane, task order |
| `packages/trace-viewer/src/layout/canvas-layout.ts`, `canvas-layout.property.test.ts` | C3-1, C3-2, C3-3 | Same lane, task order |
| `packages/ui-catalog/package.json` | W0-1 (section 1.1 b) | W0 only |
| `packages/ui-catalog/src/components/CodeDiff.tsx`, `components.test.tsx` | C2-1 | W2 only |
| `packages/ui-catalog/src/catalog.ts` | D-6 | W3 only |
| `apps/trace-viewer-dev/vite.config.ts` | W0-1 (section 1.1 c); C2-15 | Different waves |
| `apps/trace-viewer-dev/src/main.tsx` | W0-1, W0-2, W0-6; C2-15 | Different waves; the spike uses `spike.html`, never `main.tsx` |
| `apps/trace-viewer-dev/.gitignore` | C1-7 (`dist-spike/`, `.spike/`); C2-15 (`public/bundles/`, `.smoke/`) | Different waves |
| `apps/trace-viewer-dev/scripts/smoke.mjs`, `src/selftest.ts` | C2-15/C2-16; C3-12 | Different waves |
| `docs/spikes/trace-viewer-spike.md` | C1-7, C1-7F (W1); C2-0, C2-16 (W2); C3-5, C3-12 (W3) | Different waves; each appends a section |
| `apps/desktop/src/shared/local-channels.ts`, `ipc-registry.test.ts` | A2-3 (W1); D-2 (W2) | Different waves |
| `apps/desktop/src/shared/api.ts`, `api.test.ts` | A2-4 (W1); D-3 (W3) | Different waves |
| `apps/desktop/src/main/ipc.ts`, `apps/desktop/src/main/index.ts` | A2-3 (W1); D-2 (W2); D-6 (W3, `index.ts` only) | Different waves |
| `apps/desktop/src/renderer/components/WorkspaceHost.tsx` | W0-4; B-11 (W1); D-5 (W3) | Different waves |
| `apps/desktop/vite.config.ts`, `Header.tsx`, `App.tsx` | D-3, D-4 | W3 only |
| `docs/perf.md` | A2-7 (W1); D-8 (W3) | Different waves |
| `docs/SPEC.md` | W0, A1 (W1); D-8 (W3, §13 only) | Different waves |
| `eslint.config.mjs`, `pnpm-lock.yaml`, every `package.json` | W0 only | No UI task edits them |

**Merge procedure per lane.** On the lane branch, `git rebase main` (or `git merge main`), resolve conflicts, rebuild (`pnpm install --frozen-lockfile && pnpm -r build`), run section 5's root checks, then merge. After B merges in W1, C1a and C1b rebase and rerun their suites before merging; a C1 test that breaks on B's real exports is a C1 bug. Never `git stash`; commit WIP instead.

**Worktree creation** (from `/Users/jwpark/Projects/jevcode`; `<w0>`, `<w1>`, `<w2>` are the merge commits that close each wave):

```bash
git worktree add -b tv/c1a-visual-primitives /Users/jwpark/Projects/jevcode-tv-c1a <w0>
git worktree add -b tv/c1b-viewer-core /Users/jwpark/Projects/jevcode-tv-c1b <w0>
git worktree add -b tv/c2-shell-hybrid /Users/jwpark/Projects/jevcode-tv-c2 <w1>
git worktree add -b tv/c3a-canvas-layout /Users/jwpark/Projects/jevcode-tv-c3a <w1>
git worktree add -b tv/da-electron-main /Users/jwpark/Projects/jevcode-tv-da <w1>
git worktree add -b tv/c3b-canvas-view /Users/jwpark/Projects/jevcode-tv-c3b <w2>
git worktree add -b tv/db-trace-window /Users/jwpark/Projects/jevcode-tv-db <w2>
```

---

## 5. Gotchas every UI lane file copies into its steps

1. **Base index section 5 applies**, with lane 01's corrections: fresh-worktree setup is `pnpm install --frozen-lockfile`, then the node-pty `spawn-helper` recipe from lane 01 "Setup", then `pnpm -r build`; the root test command is `pnpm -r --no-bail --workspace-concurrency=1 test`; known flakes (`file-watcher.test.ts`, `stall-watchdog.test.ts`, `codex-adapter.test.ts`) are confirmed by rerunning that package alone.
2. **Root checks** at the end of every task, in order: `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r --no-bail --workspace-concurrency=1 test`, `pnpm lint`. Each must exit 0.
3. **Targeted tests**: `pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/time-scale.test.ts` (paths relative to the package). Benches: `pnpm --filter @jevcode/trace-viewer bench`.
4. **Rebuild before dependents.** `@jevcode/trace-viewer` exports only `dist`. Run `pnpm --filter @jevcode/trace-viewer build` before `pnpm --filter jevcode-trace-viewer-dev build`, before any desktop test that imports the package, and before the smoke. `pnpm --filter "...@jevcode/trace-viewer" build` rebuilds it and its dependents. CSS Modules reach `dist` only through `scripts/copy-assets.mjs`, which the package `build` script runs.
5. **jsdom**: start the file with `// @vitest-environment jsdom`; stub `getBoundingClientRect` and `ResizeObserver` inside each test (restore in `afterEach`); jsdom has no `setPointerCapture` (call it only when present) and `getContext("2d")` returns `null` (pass `recording-context.ts` to `paint.ts`). Use `render` and `act` from `@testing-library/react` and `userEvent.setup()`; there is no jest-dom, so assert with `getAttribute`, `textContent` and roles.
6. **W1 boundary**: C1a and C1b import from `../model/index.js` only W0 names (types, `LANES`, `LEVELS`, `STEP_KINDS`, `SIGNAL_IDS`, stable-id helpers, `StableIdSchema`, `TRACE_SCHEMA_VERSION`). B's runtime exports appear only after B merges.
7. **`useSyncExternalStore`** selectors must return primitives or references held in state; a selector that builds a new object on every call loops. Derive objects with `useMemo` over primitive selections.
8. **`<Activity>`** comes from `react` (`import { Activity } from "react"`); a hidden subtree keeps DOM and state but runs no effects, so views start rAF loops and observers only in effects.
9. **Virtualizer options** exist in virtual-core 3.17.11 only when set together: `followOnAppend` acts only with `anchorTo: "end"` (virtual-core src/index.ts:624).
10. **Smoke prerequisites**: Google Chrome at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` or `CHROME_PATH`; better-sqlite3 on the Node ABI (`pnpm --filter jevcode-desktop rebuild:node`) for the replay step; port 4179 free. Electron runs (spike, D-6) switch to the Electron ABI with `pnpm --filter jevcode-desktop run rebuild` and back with `rebuild:node` before tests.
11. **HUMAN CHECK steps** (spike risks 1 and 4, the M4a review gate, the M5 mock-adapter live session) cannot be done by a subagent: the implementer runs the automated parts, writes the results table, and the controller asks the user to perform and confirm the check before the task's commit.
12. **Commits**: one conventional commit per task, files listed explicitly in `git add`; no `Claude-Session:` trailer; no `git stash`; zsh `${var}:suffix`.
