# Trace Viewer in Electron, Live Follow and M5 Exit (Lanes Da and Db) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open the trace viewer for a jevcode session in its own light-mode Electron window that reads only through `trace:*` IPC, follows a running session with the 1 s poll, hands a review note to the main window's composer without sending it, and closes milestone M5 with a smoke, a parity test and recorded budgets.

**Architecture:** Main process (Part Da, wave W2): `trace-window.ts` keeps one `BrowserWindow` per session and records each trace window's `webContents.id` before `loadFile`; `trace-allowlist.ts` classifies every IPC sender as main, trace or other and the existing `handle` wrapper rejects any channel the sender may not use; `trace-window-ipc.ts` serves `trace:open` and `trace:requestChanges` (focus the main window, push `composer:prefill`). Renderer (Part Db, wave W3): `trace.html` is a second Vite input whose entry mounts `<TraceViewer>` over `createIpcTraceSource` (a stateless adapter; the shell's DataController polls every 1 s with 1-2-4-10 s backoff and stops on a terminal state); the Header gets a Trace button, WorkspaceHost applies the prefill; `smoke.ts` extends `runSmoke` to the trace window and fails on console errors and CSP violations; `trace-parity.test.ts` proves the IPC path and the exported bundle fold to the same `TraceSession`.

**Tech Stack:** Electron 33.4.11 (main, preload, sandboxed renderer), TypeScript 5.9 (NodeNext for main, Bundler for renderer and preload, `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), React 19.2.3, Vite 5.4 + `@vitejs/plugin-react`, zod 3.25 (desktop, contracts, trace-viewer) and zod 4.3.6 (ui-catalog only), vitest 3.2 (node environment in `apps/desktop`), better-sqlite3 11.10, pnpm 9.15, Node ≥ 22.

**Spec:** `docs/superpowers/specs/2026-09-28-trace-viewer-design.md` §8 (Electron integration), plus §5.4 (M5 channels), §5.5 (live polling), §7.10 (live follow), §7.11 (states), §9 (security), §10 (budgets), §11 (M5 tests) and §12 (M5 exit). Interface contracts: `docs/superpowers/plans/2026-09-28-trace-viewer-interfaces-ui.md` (§2.4 host API and sources, §2.6 Electron, §3 Da and Db, §4 waves and ownership, §5 gotchas) and `docs/superpowers/plans/2026-09-28-trace-viewer-interfaces.md` (§2.1 `trace.ts`, §2.5 A2 read path, §5 gotchas). Binding decision record: `local decision scratchpad (not committed)` (R29 is this lane; R16, R20, R22, R23 and R26 constrain it). On any conflict the decision record wins, then the spec, then the base index, then the UI index, then this file.

## Interface deviations

Each item changes or sharpens the UI index §2.6 or §3. Every other name and signature in §2.6 is used verbatim.

1. **One plan file holds both D lanes.** The UI index §0 names two lane files (`…-08a-electron-main.md`, `…-08b-trace-window.md`); the orchestrator asked for this single file. It has two parts that run as two lanes: **Part Da** (tasks D-1, D-2; wave W2; branch `tv/da-electron-main`; worktree `~/Projects/jevcode-tv-da`) and **Part Db** (tasks D-3 to D-8; wave W3; branch `tv/db-trace-window`; worktree `~/Projects/jevcode-tv-db`). A controller runs only its own part.
2. **`trace-window.ts` also exports `sharedWebPreferences(preloadPath): WebPreferences`** (additive). `index.ts` `createWindow` and `traceWindowOptions` both call it, so the trace window's `webPreferences` cannot drift from the main window's (R29 "same preload/webPreferences").
3. **zod jitless moves into a first-imported module.** UI index D-6 and spec §8.7 put `z4.config({ jitless: true })` in the body of `packages/ui-catalog/src/catalog.ts`. That is too late: ESM evaluates `catalog.ts`'s imports first, and `@json-render/core` builds zod-4 object schemas at module load, which run the `new Function("")` probe during construction (`node_modules/.pnpm/zod@4.3.6/node_modules/zod/v4/core/schemas.js:901-903`). Verified on 2026-09-28 with the probe test below: config in the body leaves one probe; a side-effect module imported first leaves none. D-6 therefore adds `packages/ui-catalog/src/zod-jitless.ts` and `packages/ui-catalog/src/zod-jitless.test.ts`, and `catalog.ts` gains only `import "./zod-jitless.js";` as its first line.
4. **`renderer/trace/host.ts` gains two pure helpers**: `sessionIdFromSearch(search)` and `traceConsoleLine(entry)`. `trace/main.tsx` logs `CSP_VIOLATION …` on `securitypolicyviolation`, and turns the viewer's perf entries into `TRACE_LOADED <ms>` (mark `tv:full-load`) and `TRACE_PERF <name> <ms>` (measures named `tv:*`). The names are C2-3's `PERF` values (`tv:full-load`, and the `tv:*` measures including C2-2/C2-3's `tv:live-tick`), matched as literals so `host.ts` and its unit test stay free of the viewer's React barrel; the root barrel does export `PERF` (C2-3), and the host adds no exports to `packages/trace-viewer/src/index.ts`.
5. **`main/smoke.ts` API** (the UI index names the file only): `runSmoke(deps: SmokeDeps)`, `isConsoleFailure`, `parseTraceLine`, `forwardTracePerf`, three timeouts. `JEVCODE_SMOKE_TRACE=1` without `JEVCODE_DB` fails instead of skipping silently. `JEVCODE_TRACE_PERF=1` makes main print each trace window's `TRACE_PERF` lines (D-8 live-tick samples in the trace window).
6. **The static `trace.html` CSP test lives in `smoke.test.ts` (D-6)**, not in a renderer or shared test: `tsconfig.web.json` has `types: []`, so a renderer or shared test cannot import `node:fs`.
7. **The allowlist rejection logs one line** (`ipc <channel> rejected: <kind> sender`) through `deps.log` before throwing `UNTRUSTED_SENDER`, so a misclassified sender is visible in the main-process log.
8. **`createIpcTraceSource`:** `payloads([])` resolves `[]` without an IPC call (the schema requires 1–50 seqs); an error maps to `UNKNOWN_SESSION` by its `code` **or** its message, because `contextBridge` copies only an error's message into the page.
9. **Composer prefill:** a note for another session is held as a pending note. The notice reads "Trace note for another session · Switch" plus a "Dismiss" button; after the user's own Switch, the held note applies to that session's composer. `appendPrefill("\n\n", "x")` returns `"x"` (a draft of only newlines counts as empty).
10. **`api.test.ts`:** A2-4's test "is structurally a TraceSource" is replaced by "the trace namespace holds three reads, open and requestChanges" (W0-6 made `TraceSource` session-bound, and D-3 adds two methods).
11. **`TraceWindowIpcDeps.sendToRenderer`** keeps the index type `typeof import("./ipc.js").sendToRenderer`; the returned `BrowserWindow` from `openTraceWindow` is never returned from the IPC handler (it cannot be serialized).

## Required amendments to other lanes

No UI lane edits dependencies. **Required W0 amendments: none** (`apps/desktop` gains `"@jevcode/trace-viewer": "workspace:^"` in W0-1 already; the desktop needs no new dependency). The M5 budgets need three things other lanes own. Each is verified in Lane prerequisites; a missing one stops D-8 (not D-3 to D-7) and is escalated.

1. **A2-7 (`scripts/soak.mjs`)** must implement spec §5.6: `JEVCODE_SOAK_PROFILE=trace` (payload sizes and `callId` pairs as §5.6 lists) and `JEVCODE_SOAK_KEEP_DB=<path>` (copy the DB before the `rmSync`). Lane file 03 implements only `JEVCODE_SOAK_EXPORT`. D-8 opens the kept DB in the trace window (spec §10 "Soak open in the Electron trace window").
2. **C2-15 (`apps/trace-viewer-dev/src/host.tsx`)** must accept a start seq on the drip parameter: `?drip=<rowsPerTick>,<intervalMs>[,<startAtSeq>]`, where a negative `startAtSeq` means `lastSeq + startAtSeq`, mapped to `DripOptions.startAtSeq`. D-8 measures the live tick with `?drip=20,1000,-2000` (spec §10 "starting at `lastSeq − 2000`"). Lane file 06 now carries it (`parseDrip` takes the third part, `resolveDrip` resolves a negative one against the bundle); the dev host reads query parameters in `host.tsx`, not `main.tsx`.
3. **C2-3 (`ui/shell`)** must set the `PERF.firstPaint` and `PERF.fullLoad` marks and the `PERF.liveTick` measure unconditionally (not only under the dev host's `?perf=1`), with those exact names. The trace window has no HUD; D-6's smoke waits for `tv:full-load`, and D-8 reads `tv:live-tick`. Lane file 06 now carries it: C2-2's DataController marks `LIVE_TICK_START` (`tv:live-tick-start`) when a poll page with new rows arrives after the full load, and C2-3's Shell calls `measureAfterPaint(PERF.liveTick, LIVE_TICK_START)` on every later apply.

## Global Constraints

From the decision record (verbatim) and the spec, as they bind this lane:

- D9: "Viewer opens in a SEPARATE Electron BrowserWindow (trace.html), not an in-app mode." … "The Inspector's primary action "Request changes" FOCUSES THE MAIN WINDOW'S COMPOSER prefilled with a reference to the selected step; the viewer itself never writes."
- R29: "M5: openTraceWindow(sessionId) minWidth 1000, backgroundColor #FFFFFF, same preload/webPreferences; trace.html second Vite input (apps/desktop/vite.config.ts:12-13); trace:open invoke and a "Trace" button beside Inspect (Header.tsx:80) that never calls switchTo; createIpcTraceSource with 1 s poll; ViewerHost.requestChanges focuses the main window composer (WorkspaceHost.tsx:833) with a prefilled reference; no telemetry writes from the trace window; runSmoke (apps/desktop/src/main/index.ts:81-91) extended to load the trace window and fail on console errors/CSP violations; trace-parity test (IPC source and bundle give the same TraceSession for the 5 fixtures)."
- R5: "Live follow = poll trace:rows {afterSeq} every 1 s until the session state is terminal." Spec §5.5: `paused` and `waiting_decision` are not terminal and keep polling; a failed poll keeps the data, shows "Reconnecting (n)" and retries after 1, 2, 4, then every 10 s. The DataController (C2-2) owns the loop; `createIpcTraceSource` only maps calls to channels.
- R16/R22: "follow the tail only at the live edge; otherwise hold the reader's place and show an "N new" pill." "M4 drives live via the drip source; M5 swaps in the 1 s trace:rows poll."
- R15: "CSS Modules + light --tv-* tokens; scoped (the trace window never loads apps/desktop/src/renderer/styles.css). Local fonts only (system stack). CSP-compatible."
- R17: `packages/trace-viewer` takes **no** `@xyflow/react` dependency.
- D8: "LIGHT MODE FIRST (dark later)." "Color encodes STATE only: accent #2F6BFF = selection/focus/playhead/one primary action; #E5484D = real problems only (failed test, contradiction, guardrail hit); tiny #2E9E6A pass marks only." "12px minimum text. System font stack; mono only for paths/commands/code." Tokens: `--canvas #F4F5F7; --panel #FFFFFF; --ink #16181D; --ink-2 #5B616E; --ink-3 #9AA0AB; --hair rgb(16 24 40 / .07); --fill rgb(16 24 40 / .04); --fill-2 rgb(16 24 40 / .07); --accent #2F6BFF; --accent-soft rgb(47 107 255 / .10); --bad #E5484D; --bad-soft rgb(229 72 77 / .09); --good #2E9E6A` (implementation prefixes them `--tv-*`). This lane adds no viewer CSS; `trace.html` sets only `html, body, #root` height, margin and `#FFFFFF` background inline.
- Spec §8.2 CSP, copied from `apps/desktop/src/renderer/index.html` and identical in `trace.html`: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'`. `default-src 'self'` blocks `data:` URIs, so `apps/desktop/vite.config.ts` sets `build.assetsInlineLimit: 0`.
- Spec §8.6: "The `handle` wrapper accepts non-`trace:*` channels and `trace:open` only when `event.sender.id` equals the current main window's `webContents.id`; `trace:listSessions`, `trace:rows` and `trace:payloads` from the main window or a recorded trace window; and `trace:requestChanges` only from a recorded trace window. Every other sender gets `UNTRUSTED_SENDER`."
- Spec §5.4 payloads: `trace:open {sessionId: z.string().min(1)}`; `trace:requestChanges {sessionId: z.string().min(1), selected: StableIdSchema, text: z.string().min(1).max(8000)}`; `composer:prefill {sessionId, text}` in `MainToRendererLocalChannels`.
- Spec §8.5: WorkspaceHost "appends the text to the composer draft … on a new line, leaves the instruction mode unchanged, focuses the textarea with the caret at the end, and never sends. For another session it shows an inline notice "Trace note for another session · Switch", whose button is the user's explicit `switchTo`."
- UI index: "The viewer reads only through `TraceSource` and writes nothing. `ViewerHost.requestChanges` is the only outbound call, and only the Electron host implements it."
- UI index: "No UI lane edits any `package.json` dependency block, any `exports` map, `pnpm-lock.yaml` or `eslint.config.mjs`."
- Budgets (spec §10, M5 gate): live tick (poll apply + selectors + commit) p95 ≤ 16 ms; soak open in the Electron trace window first paint ≤ 500 ms, full load ≤ 3 s. Single-run budgets report the median of 5 runs after 1 discarded warm-up; p95 budgets use at least 300 samples; results go to `docs/perf.md` and SPEC §13.
- Commits: one conventional commit per task, files listed explicitly in `git add`, the repository's configured identity, **no `Claude-Session:` trailer**. Never `git stash`; set work aside with a WIP commit. Worktrees: `git worktree add -b <branch> <path> <base>`, never `-f`. zsh: write `${var}:suffix` when a colon follows a variable.

## Review Focus

Five inputs a supervisor will meet that the spec implies but a happy-path test misses, most likely first. Each names the test that pins it and the task that owns it.

1. **A trace window invokes a channel it must not reach** (`telemetry:flush`, `agent:sendInstruction`, `session:switch`, or `trace:open` itself), or the main window invokes `trace:requestChanges`. Expected: `UNTRUSTED_SENDER` before zod parsing or any handler runs; the trace window makes no telemetry write. Tests: **D-2** `trace-allowlist.test.ts` "a trace window reaches only the three reads and trace:requestChanges" and "the main window cannot hand a note to itself".
2. **"Request changes" while the main window shows another session, holds an unsent draft, or gets a malformed note** (8,001 characters, `selected: "file:src/a.ts"`). Expected: the draft is kept and the note appended on a new line, nothing is sent; another session gets the notice and the note waits for the user's Switch; a malformed note is rejected with `INVALID_PAYLOAD` and no `composer:prefill` is pushed. Tests: **D-5** `composer-prefill.test.ts` "keeps the draft and appends on a new line" and "a note for another session becomes a notice"; **D-2** `trace-window-ipc.test.ts` "an oversized or malformed note sends nothing".
3. **Trace pressed twice, pressed while the trace window is minimized, or the main window closed first.** Expected: one window per session, restored and focused, never a second load; closing the main window closes every trace window; a closed window's `webContents.id` stops being a trace sender. Tests: **D-1** `trace-window.test.ts` "a second open restores and focuses the same window" and "a closed window stops being a trace sender and can be reopened".
4. **Main-process failures reaching the trace window**: a session that does not exist (or was deleted), and an IPC rejection whose `code` was dropped by `contextBridge`. Expected: a `TraceSourceError` naming the channel; `UNKNOWN_SESSION` for a missing session (the shell shows an error with Retry, never an endless "Loading"); other failures `SOURCE_FAILED`, so a poll failure becomes "Reconnecting". Tests: **D-3** `ipc-source.test.ts` "summary() rejects UNKNOWN_SESSION when main lists nothing" and "maps a bridge error without a code by its message".
5. **A console error or CSP violation in either window**, including zod 4's `new Function("")` probe under `script-src 'self'` and a violation that arrives after the last page loads. Expected: the smoke prints `SMOKE_FAIL: console error in <main|trace> window: …` and exits 1. Tests: **D-6** `smoke.test.ts` "fails on a CSP violation in the main window" and "a late CSP violation during the settle window still fails"; `packages/ui-catalog/src/zod-jitless.test.ts` "loading ui-catalog never probes new Function".

---

## Lane prerequisites

### Part Da (wave W2)

- W0 and all of W1 (A1, A2 with UI index §1.3, B, C1a, C1b) are merged into `main`.
- Create the worktree from `~/Projects/jevcode`:

  Run: `git worktree add -b tv/da-electron-main ~/Projects/jevcode-tv-da main`

- Verify from `~/Projects/jevcode-tv-da`. Any other output means a prerequisite is missing: stop and escalate.

  | Run | Expected |
  |---|---|
  | `grep -c "registerTraceHandlers(handle, deps.trace);" apps/desktop/src/main/ipc.ts` | `1` |
  | `grep -c "export type IpcHandle" apps/desktop/src/main/trace-ipc.ts` | `1` |
  | `grep -c "trace: createTraceService(reader)," apps/desktop/src/main/index.ts` | `1` |
  | `grep -A3 "export const TraceListSessionsPayloadSchema" apps/desktop/src/shared/local-channels.ts \| grep -c sessionId` | `1` |
  | `grep -c "sessionId?: string" apps/desktop/src/main/trace-service.ts` | `1` or more |
  | `grep -c '"@jevcode/trace-viewer"' apps/desktop/package.json` | `1` |

### Part Db (wave W3)

- W2 (C2 = M4a, C3a, Da) is merged into `main`. C3b runs beside this lane and touches none of its files.
- Create the worktree from `~/Projects/jevcode`:

  Run: `git worktree add -b tv/db-trace-window ~/Projects/jevcode-tv-db main`

- Verify from `~/Projects/jevcode-tv-db`:

  | Run | Expected | Needed by |
  |---|---|---|
  | `grep -c "export function createTraceWindowRegistry" apps/desktop/src/main/trace-window.ts` | `1` | D-3 |
  | `grep -c 'composerPrefill: "composer:prefill"' apps/desktop/src/shared/local-channels.ts` | `1` | D-3 |
  | `grep -c "export { TraceViewer" packages/trace-viewer/src/index.ts` | `1` | D-3 |
  | `grep -c '"./sources"' packages/trace-viewer/package.json` | `1` | D-3, D-7 |
  | `grep -c '"./components/\*"' packages/ui-catalog/package.json` | `1` | D-3 |
  | `grep -c "export function readAllTraceRows" packages/trace-viewer/src/sources/read-all.ts` | `1` | D-7 |
  | `grep -c "export function foldRows" packages/trace-viewer/src/model/fold.ts` | `1` | D-7 |
  | `grep -c "export function redactBundleValue" apps/desktop/src/main/trace-bundle.ts` | `1` | D-7 |
  | `grep -c "bundlePath" apps/desktop/src/main/replay/cli-entry.ts` | `1` or more | D-7 |
  | `grep -c 'fullLoad: "tv:full-load"' packages/trace-viewer/src/ui/shell/perf.ts` | `1` | D-6 |
  | `grep -rl "PERF.fullLoad" packages/trace-viewer/src/ui \| wc -l` | `1` or more | D-6 |
  | `grep -rl "PERF.liveTick" packages/trace-viewer/src/ui \| wc -l` | `1` or more | D-8 |
  | `grep -c "JEVCODE_SOAK_KEEP_DB" scripts/soak.mjs` | `1` or more | D-8 |
  | `grep -c "JEVCODE_SOAK_PROFILE" scripts/soak.mjs` | `1` or more | D-8 |
  | `grep -c "startAtSeq" apps/trace-viewer-dev/src/host.tsx` | `1` or more | D-8 |

  If `PERF.fullLoad` is marked only under `?perf=1` (read the call site), D-6's trace phase times out: escalate Required amendment 3 before D-6.

### Setup (both parts, once per worktree)

A fresh worktree has no better-sqlite3 binary. Run from the worktree root:

```bash
pnpm install --frozen-lockfile
NP=$(ls -d node_modules/.pnpm/node-pty@*/node_modules/node-pty | head -1) && mkdir -p "$NP/build/Release" && pnpm --filter jevcode-desktop rebuild:node && cp "$NP/prebuilds/$(node -p 'process.platform + "-" + process.arch')/spawn-helper" "$NP/build/Release/spawn-helper" && chmod +x "$NP/build/Release/spawn-helper"
pnpm -r build
```

Expected: each command exits 0; the second prints `native modules restored to node ABI` as its last line.

Baseline: `pnpm --filter jevcode-desktop test` exits 0.

## File map

| File | Task | Responsibility |
|---|---|---|
| `apps/desktop/src/main/trace-window.ts` (new) | D-1 | `sharedWebPreferences`, `traceWindowOptions`, the per-session window registry |
| `apps/desktop/src/main/trace-window.test.ts` (new) | D-1 | one window per session, sender recorded before load, navigation blocked, close |
| `apps/desktop/src/shared/local-channels.ts` (mod) | D-2 | `trace:open`, `trace:requestChanges`, `composer:prefill` names and schemas |
| `apps/desktop/src/shared/ipc-registry.test.ts` (mod) | D-2 | schema bounds for the three channels |
| `apps/desktop/src/main/trace-allowlist.ts` (new) | D-2 | `SenderKind`, `TRACE_WINDOW_CHANNELS`, `isChannelAllowed` |
| `apps/desktop/src/main/trace-allowlist.test.ts` (new) | D-2 | every registered channel against every sender kind |
| `apps/desktop/src/main/trace-window-ipc.ts` (new) | D-2 | `registerTraceWindowHandlers` |
| `apps/desktop/src/main/trace-window-ipc.test.ts` (new) | D-2 | open, handoff, unknown sessions, malformed notes |
| `apps/desktop/src/main/ipc.ts` (mod) | D-2 | allowlist check in `handle`; `IpcDeps.senderKind`, `IpcDeps.traceWindows` |
| `apps/desktop/src/main/index.ts` (mod) | D-2, D-6 | registry wiring, shared webPreferences, close-all, smoke wiring |
| `apps/desktop/src/shared/api.ts` (mod) | D-3 | `trace.open`, `trace.requestChanges`, `onComposerPrefill` |
| `apps/desktop/src/shared/api.test.ts` (mod) | D-3 | the new API surface |
| `apps/desktop/src/renderer/trace.html` (new) | D-3 | second Vite input, same CSP |
| `apps/desktop/src/renderer/trace/main.tsx` (new) | D-3 | mounts `<TraceViewer>`; CSP and perf console lines |
| `apps/desktop/src/renderer/trace/ipc-source.ts` (new) | D-3 | `createIpcTraceSource` |
| `apps/desktop/src/renderer/trace/ipc-source.test.ts` (new) | D-3 | channel mapping and error codes |
| `apps/desktop/src/renderer/trace/host.ts` (new) | D-3 | `createDesktopViewerHost`, `sessionIdFromSearch`, `traceConsoleLine` |
| `apps/desktop/src/renderer/trace/host.test.ts` (new) | D-3 | `TRACE_READY`, handoff, query and perf lines |
| `apps/desktop/vite.config.ts` (mod) | D-3 | two inputs, `assetsInlineLimit: 0` |
| `apps/desktop/src/renderer/components/Header.tsx` (mod) | D-4 | Trace button |
| `apps/desktop/src/renderer/App.tsx` (mod) | D-4 | `onOpenTrace` → `bridge.trace.open` |
| `apps/desktop/src/renderer/components/composer-prefill.ts` (new) | D-5 | `appendPrefill`, `decidePrefill` |
| `apps/desktop/src/renderer/components/composer-prefill.test.ts` (new) | D-5 | draft rules |
| `apps/desktop/src/renderer/components/WorkspaceHost.tsx` (mod) | D-5 | prefill listener, focus, pending note and notice |
| `apps/desktop/src/main/smoke.ts` (new) | D-6 | `runSmoke` for both windows |
| `apps/desktop/src/main/smoke.test.ts` (new) | D-6 | failure and success paths with fakes; `trace.html` CSP |
| `packages/ui-catalog/src/zod-jitless.ts` (new) | D-6 | zod 4 jitless before any schema exists |
| `packages/ui-catalog/src/zod-jitless.test.ts` (new) | D-6 | no `new Function("")` probe on load |
| `packages/ui-catalog/src/catalog.ts` (mod) | D-6 | first import |
| `apps/desktop/src/main/trace-parity.test.ts` (new) | D-7 | IPC fold equals bundle fold for five fixtures |
| `docs/perf.md` (mod) | D-8 | every trace viewer budget and its measurement |
| `docs/SPEC.md` (mod, §13 only) | D-8 | budget targets |
| `docs/security.md` (mod) | D-8 | row 8: trace-window channel allowlist |

## Rules for every task

- Run every command from the part's worktree root (`~/Projects/jevcode-tv-da` for D-1 and D-2, `~/Projects/jevcode-tv-db` for D-3 to D-8).
- Anchors are quoted text, not line numbers: earlier waves moved the lines. Each quoted anchor occurs exactly once in its file; if it does not, stop and escalate.
- Workspace packages export only `dist`, and desktop tests have no pretest build. After a change under `packages/`, run `pnpm --filter "...<package>" build` before desktop tests. Before any desktop test or build that imports the viewer: `pnpm --filter @jevcode/trace-viewer build`.
- Targeted tests: `pnpm --filter jevcode-desktop exec vitest run <path relative to apps/desktop>`; ui-catalog: `pnpm --filter @jevcode/ui-catalog exec vitest run <path>`.
- better-sqlite3 ABI: vitest needs the Node ABI (`pnpm --filter jevcode-desktop rebuild:node`), `electron .` needs the Electron ABI (`pnpm --filter jevcode-desktop run rebuild`). Every step that starts Electron ends by switching back with `rebuild:node`. A test failing with `NODE_MODULE_VERSION` means the ABI is wrong.
- `pnpm --filter jevcode-desktop <script>` runs in `apps/desktop`, so pass absolute paths to `replay` and `start` (a relative `fixtures/oauth` resolves under `apps/desktop`).
- Electron runs set `JEVCODE_DB` to a temporary database, never the user's `~/.jevcode/jevcode.db`. Boot runs `rebuildOnBoot` and `sweepStaleSessions`, which write, so copy a kept database before each run.
- Root checks at the end of every task, in order: `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r --no-bail --workspace-concurrency=1 test`, `pnpm lint`. Each must exit 0. Known flakes (`packages/agent-codex/src/stall-watchdog.test.ts`, `packages/agent-codex/src/codex-adapter.test.ts`, `packages/evidence-engine/src/collectors/file-watcher.test.ts`) are confirmed by rerunning that package alone once; name the flake in the task report.
- **HUMAN CHECK** steps (D-8) cannot be done by a subagent: the implementer runs the automated parts and prepares the commands; the controller asks the user to perform and confirm the check before the task's commit.
- One commit per task, files named in `git add`. No `Claude-Session:` trailer. No `git stash`.

---

## Part Da: Electron main process (lane 08a, wave W2)

Da's channels are inert until Db adds `trace.html` and the renderer API; merging them before M4b changes no user-visible behavior.

### Task D-1: Trace window registry and `openTraceWindow`

**Files:**
- Create: `apps/desktop/src/main/trace-window.ts`
- Test: `apps/desktop/src/main/trace-window.test.ts`

**Interfaces:**
- Consumes: `electron` types only (`BrowserWindow`, `BrowserWindowConstructorOptions`, `WebPreferences`); the file has no runtime `electron` import, so vitest loads it.
- Produces (UI index §2.6, plus deviation 2):
  ```ts
  export const TRACE_WINDOW_MIN_WIDTH = 1000;
  export const TRACE_WINDOW_BACKGROUND = "#FFFFFF";
  export function sharedWebPreferences(preloadPath: string): WebPreferences;
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
    openTraceWindow(sessionId: string): TraceWindowHandle;
    isTraceSender(webContentsId: number): boolean;
    closeAll(): void;
    count(): number;
  }
  export function createTraceWindowRegistry(deps: TraceWindowRegistryDeps): TraceWindowRegistry;
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/trace-window.test.ts`:

```ts
import type { BrowserWindowConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  TRACE_WINDOW_BACKGROUND,
  TRACE_WINDOW_MIN_WIDTH,
  createTraceWindowRegistry,
  sharedWebPreferences,
  traceWindowOptions,
} from "./trace-window.js";
import type { TraceWindowHandle, TraceWindowRegistry } from "./trace-window.js";

const PRELOAD = "/app/dist/preload/index.cjs";
const TRACE_HTML = "/app/dist/renderer/src/renderer/trace.html";

type Listener = (...args: unknown[]) => void;

class FakeEmitter {
  private readonly listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  once(event: string, listener: Listener): this {
    const wrapped: Listener = (...args) => {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((entry) => entry !== wrapped),
      );
      listener(...args);
    };
    return this.on(event, wrapped);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }
}

class FakeWebContents extends FakeEmitter {
  openHandler: ((details: unknown) => { action: string }) | null = null;

  constructor(readonly id: number) {
    super();
  }

  setWindowOpenHandler(handler: (details: unknown) => { action: string }): void {
    this.openHandler = handler;
  }
}

class FakeWindow extends FakeEmitter {
  readonly calls: string[] = [];
  readonly webContents: FakeWebContents;
  minimized = false;
  destroyed = false;
  loaded: { file: string; options: unknown; senderRecorded: boolean } | null = null;

  constructor(
    id: number,
    private readonly registry: () => TraceWindowRegistry,
  ) {
    super();
    this.webContents = new FakeWebContents(id);
  }

  async loadFile(file: string, options?: unknown): Promise<void> {
    this.calls.push("loadFile");
    this.loaded = {
      file,
      options,
      senderRecorded: this.registry().isTraceSender(this.webContents.id),
    };
  }

  show(): void {
    this.calls.push("show");
  }

  focus(): void {
    this.calls.push("focus");
  }

  restore(): void {
    this.calls.push("restore");
    this.minimized = false;
  }

  isMinimized(): boolean {
    return this.minimized;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  close(): void {
    this.calls.push("close");
    this.destroyed = true;
    this.emit("closed");
  }
}

function setup(): {
  registry: TraceWindowRegistry;
  created: FakeWindow[];
  options: BrowserWindowConstructorOptions[];
} {
  const created: FakeWindow[] = [];
  const options: BrowserWindowConstructorOptions[] = [];
  let nextId = 100;
  let registry: TraceWindowRegistry | undefined;
  const current = (): TraceWindowRegistry => {
    if (registry === undefined) throw new Error("registry not ready");
    return registry;
  };
  registry = createTraceWindowRegistry({
    create: (windowOptions) => {
      options.push(windowOptions);
      const window = new FakeWindow(nextId, current);
      nextId += 1;
      created.push(window);
      return window as unknown as TraceWindowHandle;
    },
    preloadPath: PRELOAD,
    traceHtmlPath: TRACE_HTML,
  });
  return { registry, created, options };
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`missing item ${index}`);
  return item;
}

describe("trace window registry", () => {
  it("builds a light, sandboxed trace window with the main window's webPreferences", () => {
    expect(TRACE_WINDOW_MIN_WIDTH).toBe(1000);
    expect(TRACE_WINDOW_BACKGROUND).toBe("#FFFFFF");
    expect(sharedWebPreferences(PRELOAD)).toEqual({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      preload: PRELOAD,
    });
    expect(traceWindowOptions(PRELOAD)).toEqual({
      width: 1440,
      height: 900,
      minWidth: 1000,
      backgroundColor: "#FFFFFF",
      show: false,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        preload: PRELOAD,
      },
    });
  });

  it("records the sender before loading trace.html with the session query", () => {
    const { registry, created, options } = setup();
    registry.openTraceWindow("sess_1");
    expect(created).toHaveLength(1);
    expect(at(options, 0)).toEqual(traceWindowOptions(PRELOAD));
    expect(at(created, 0).loaded).toEqual({
      file: TRACE_HTML,
      options: { query: { session: "sess_1" } },
      senderRecorded: true,
    });
    expect(registry.isTraceSender(100)).toBe(true);
    expect(registry.isTraceSender(1)).toBe(false);
  });

  it("shows the window only when it is ready to show", () => {
    const { registry, created } = setup();
    registry.openTraceWindow("sess_1");
    const window = at(created, 0);
    expect(window.calls).toEqual(["loadFile"]);
    window.emit("ready-to-show");
    expect(window.calls).toEqual(["loadFile", "show"]);
  });

  it("a second open restores and focuses the same window", () => {
    const { registry, created } = setup();
    const first = registry.openTraceWindow("sess_1");
    const window = at(created, 0);
    window.minimized = true;
    const second = registry.openTraceWindow("sess_1");
    expect(second).toBe(first);
    expect(created).toHaveLength(1);
    expect(window.calls).toEqual(["loadFile", "restore", "show", "focus"]);
    expect(registry.count()).toBe(1);
  });

  it("keeps one window per session", () => {
    const { registry, created } = setup();
    registry.openTraceWindow("sess_1");
    registry.openTraceWindow("sess_2");
    expect(created).toHaveLength(2);
    expect(registry.count()).toBe(2);
    expect(registry.isTraceSender(100)).toBe(true);
    expect(registry.isTraceSender(101)).toBe(true);
  });

  it("blocks navigation and denies window.open", () => {
    const { registry, created } = setup();
    registry.openTraceWindow("sess_1");
    const window = at(created, 0);
    const preventDefault = vi.fn();
    window.webContents.emit("will-navigate", { preventDefault }, "https://example.com/");
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(window.webContents.openHandler?.({ url: "https://example.com/" })).toEqual({
      action: "deny",
    });
  });

  it("a closed window stops being a trace sender and can be reopened", () => {
    const { registry, created } = setup();
    registry.openTraceWindow("sess_1");
    at(created, 0).close();
    expect(registry.count()).toBe(0);
    expect(registry.isTraceSender(100)).toBe(false);
    registry.openTraceWindow("sess_1");
    expect(created).toHaveLength(2);
    expect(registry.isTraceSender(101)).toBe(true);
  });

  it("closeAll closes every open trace window", () => {
    const { registry, created } = setup();
    registry.openTraceWindow("sess_1");
    registry.openTraceWindow("sess_2");
    registry.closeAll();
    expect(created.map((window) => window.calls.includes("close"))).toEqual([true, true]);
    expect(registry.count()).toBe(0);
    expect(registry.isTraceSender(100)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter jevcode-desktop exec vitest run src/main/trace-window.test.ts`
Expected: FAIL with `Error: Cannot find module './trace-window.js'` (or `Failed to load url ./trace-window.js`).

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/main/trace-window.ts`:

```ts
import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  WebPreferences,
} from "electron";

export const TRACE_WINDOW_MIN_WIDTH = 1000;
export const TRACE_WINDOW_BACKGROUND = "#FFFFFF";

/**
 * Renderer isolation shared by the main window and every trace window
 * (docs/security.md row 1). index.ts createWindow calls this too, so the two
 * windows cannot drift apart.
 */
export function sharedWebPreferences(preloadPath: string): WebPreferences {
  return {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    preload: preloadPath,
  };
}

/** width 1440, height 900, minWidth 1000, backgroundColor #FFFFFF, show false, the main window's webPreferences with this preload. */
export function traceWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 1440,
    height: 900,
    minWidth: TRACE_WINDOW_MIN_WIDTH,
    // The main window's #14161a would flash through the light viewer (spec §8.1).
    backgroundColor: TRACE_WINDOW_BACKGROUND,
    show: false,
    webPreferences: sharedWebPreferences(preloadPath),
  };
}

export type TraceWindowHandle = Pick<
  BrowserWindow,
  "loadFile" | "once" | "on" | "show" | "focus" | "restore" | "isMinimized" | "isDestroyed" | "close"
> & {
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
  closeAll(): void;
  count(): number;
}

export function createTraceWindowRegistry(deps: TraceWindowRegistryDeps): TraceWindowRegistry {
  const bySession = new Map<string, TraceWindowHandle>();
  const senders = new Set<number>();

  function bringToFront(window: TraceWindowHandle): void {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  return {
    openTraceWindow(sessionId) {
      const existing = bySession.get(sessionId);
      if (existing !== undefined && !existing.isDestroyed()) {
        bringToFront(existing);
        return existing;
      }
      const window = deps.create(traceWindowOptions(deps.preloadPath));
      // The IPC allowlist (spec §8.6) must know this sender before any page
      // script can run, so the id is recorded before loadFile.
      const webContentsId = window.webContents.id;
      senders.add(webContentsId);
      bySession.set(sessionId, window);
      window.webContents.on("will-navigate", (event) => {
        event.preventDefault();
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.once("ready-to-show", () => {
        window.show();
      });
      window.on("closed", () => {
        senders.delete(webContentsId);
        if (bySession.get(sessionId) === window) bySession.delete(sessionId);
      });
      window
        .loadFile(deps.traceHtmlPath, { query: { session: sessionId } })
        .catch((error: unknown) => {
          console.error(
            `[trace] failed to load the trace window for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      return window;
    },
    isTraceSender(webContentsId) {
      return senders.has(webContentsId);
    },
    closeAll() {
      for (const window of [...bySession.values()]) {
        if (!window.isDestroyed()) window.close();
      }
    },
    count() {
      return bySession.size;
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter jevcode-desktop exec vitest run src/main/trace-window.test.ts`
Expected: PASS, `Tests  8 passed (8)`.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter jevcode-desktop typecheck`
Expected: exit 0 (the fake-free `Pick` types in `TraceWindowHandle` accept `new BrowserWindow(...)`; D-2 relies on that).

- [ ] **Step 6: Run the root checks**

Run, in order: `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r --no-bail --workspace-concurrency=1 test`, `pnpm lint`
Expected: each exits 0.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/trace-window.ts apps/desktop/src/main/trace-window.test.ts
git commit -m "feat(desktop): add the per-session trace window registry"
```

---

### Task D-2: `trace:open`, `trace:requestChanges`, `composer:prefill`; sender allowlist; wiring

**Files:**
- Modify: `apps/desktop/src/shared/local-channels.ts`
- Modify: `apps/desktop/src/shared/ipc-registry.test.ts` (append at end of file)
- Create: `apps/desktop/src/main/trace-allowlist.ts`
- Test: `apps/desktop/src/main/trace-allowlist.test.ts`
- Create: `apps/desktop/src/main/trace-window-ipc.ts`
- Test: `apps/desktop/src/main/trace-window-ipc.test.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/main/index.ts`

**Interfaces:**
- Consumes:
  - D-1: `createTraceWindowRegistry`, `sharedWebPreferences`, `TraceWindowRegistry`.
  - A2-3: `type IpcHandle = <C extends ToMainChannelName>(channel: C, fn: (payload: ToMainPayload<C>) => unknown | Promise<unknown>) => void` from `apps/desktop/src/main/trace-ipc.ts`; `RendererToMainLocalChannels.traceListSessions | traceRows | tracePayloads`; `IpcDeps.trace: TraceService`; `registerTraceHandlers(handle, deps.trace)`.
  - A2-2 + UI index §1.3: `TraceService.listSessions(request: { repoId?: string; sessionId?: string; limit?: number }): TraceSessionSummary[]`.
  - Existing: `IpcError` (`apps/desktop/src/shared/errors.ts`, codes include `UNTRUSTED_SENDER`, `UNKNOWN_SESSION`, `INVALID_PAYLOAD`), `parseToMain`, `parseFromMain`, `toMainChannelNames()` (`apps/desktop/src/shared/ipc-registry.ts`), `sendToRenderer<C extends FromMainChannelName>(channel: C, payload: FromMainPayload<C>): void` (`ipc.ts`).
- Produces (UI index §2.6):
  ```ts
  // local-channels.ts
  RendererToMainLocalChannels.traceOpen === "trace:open";
  RendererToMainLocalChannels.traceRequestChanges === "trace:requestChanges";
  MainToRendererLocalChannels.composerPrefill === "composer:prefill";
  export const TRACE_NOTE_MAX_CHARS = 8_000;
  export const TraceStableIdSchema = z.string().regex(/^(step:\d+|unit:.+|decision:.+)$/s);
  export const TraceOpenPayloadSchema;            // { sessionId: string (min 1) }
  export const TraceRequestChangesPayloadSchema;  // { sessionId: string (min 1); selected: TraceStableId; text: string (1..8000) }
  export const ComposerPrefillPayloadSchema;      // { sessionId: string (min 1); text: string (1..8000) }
  export type TraceRequestChangesPayload; export type ComposerPrefillPayload;
  // trace-allowlist.ts
  export type SenderKind = "main" | "trace" | "other";
  export const TRACE_WINDOW_CHANNELS: readonly string[];
  export function isChannelAllowed(channel: string, sender: SenderKind): boolean;
  // trace-window-ipc.ts
  export interface TraceWindowIpcDeps {
    windows: TraceWindowRegistry;
    sessionExists(sessionId: string): boolean;
    focusMainWindow(): void;
    sendToRenderer: typeof import("./ipc.js").sendToRenderer;
  }
  export function registerTraceWindowHandlers(handle: IpcHandle, deps: TraceWindowIpcDeps): void;
  // ipc.ts: IpcDeps gains senderKind(webContentsId: number): SenderKind and traceWindows: TraceWindowIpcDeps
  ```

- [ ] **Step 1: Write the failing registry test**

Append to the end of `apps/desktop/src/shared/ipc-registry.test.ts` (after the last `});`; the file already imports `IpcError`, `parseFromMain` and `parseToMain`):

```ts

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof IpcError ? error.code : "not an IpcError";
  }
  return undefined;
}

describe("trace window channels", () => {
  it("accepts trace:open, trace:requestChanges and composer:prefill", () => {
    expect(parseToMain("trace:open", { sessionId: "s1" })).toEqual({ sessionId: "s1" });
    for (const selected of ["step:48", "unit:u1", "decision:dec-oauth-0001"]) {
      expect(
        parseToMain("trace:requestChanges", { sessionId: "s1", selected, text: "Re: trace s1" }),
      ).toEqual({ sessionId: "s1", selected, text: "Re: trace s1" });
    }
    expect(
      parseToMain("trace:requestChanges", {
        sessionId: "s1",
        selected: "step:1",
        text: "a".repeat(8_000),
      }),
    ).toMatchObject({ selected: "step:1" });
    expect(parseFromMain("composer:prefill", { sessionId: "s1", text: "note" })).toEqual({
      sessionId: "s1",
      text: "note",
    });
  });

  it("rejects empty, oversized and non-step trace window payloads", () => {
    const rejected: Array<[string, unknown]> = [
      ["trace:open", {}],
      ["trace:open", { sessionId: "" }],
      ["trace:requestChanges", { sessionId: "s1", selected: "step:48", text: "" }],
      ["trace:requestChanges", { sessionId: "s1", selected: "step:48", text: "a".repeat(8_001) }],
      ["trace:requestChanges", { sessionId: "s1", selected: "file:src/a.ts", text: "x" }],
      ["trace:requestChanges", { sessionId: "s1", selected: "step:abc", text: "x" }],
      ["trace:requestChanges", { sessionId: "", selected: "step:48", text: "x" }],
    ];
    for (const [channel, payload] of rejected) {
      expect(codeOf(() => parseToMain(channel, payload)), `${channel} ${JSON.stringify(payload).slice(0, 60)}`).toBe(
        "INVALID_PAYLOAD",
      );
    }
    expect(
      codeOf(() => parseFromMain("composer:prefill", { sessionId: "s1", text: "a".repeat(8_001) })),
    ).toBe("INVALID_PAYLOAD");
  });
});
```

- [ ] **Step 2: Write the failing allowlist test**

Create `apps/desktop/src/main/trace-allowlist.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { toMainChannelNames } from "../shared/ipc-registry.js";
import { TRACE_WINDOW_CHANNELS, isChannelAllowed } from "./trace-allowlist.js";

// Spec §8.6, written out independently of the implementation.
const TRACE_READS = ["trace:listSessions", "trace:payloads", "trace:rows"];
const TRACE_WINDOW_ONLY = "trace:requestChanges";

describe("trace window channel allowlist", () => {
  it("a trace window reaches only the three reads and trace:requestChanges", () => {
    expect([...TRACE_WINDOW_CHANNELS].sort()).toEqual([...TRACE_READS, TRACE_WINDOW_ONLY].sort());
    const names = toMainChannelNames();
    for (const required of ["telemetry:flush", "agent:sendInstruction", "session:switch", "trace:open"]) {
      expect(names).toContain(required);
    }
    for (const channel of names) {
      const expected = TRACE_READS.includes(channel) || channel === TRACE_WINDOW_ONLY;
      expect(isChannelAllowed(channel, "trace"), channel).toBe(expected);
    }
  });

  it("the main window cannot hand a note to itself", () => {
    for (const channel of toMainChannelNames()) {
      expect(isChannelAllowed(channel, "main"), channel).toBe(channel !== TRACE_WINDOW_ONLY);
    }
  });

  it("an unrecognized sender reaches nothing", () => {
    for (const channel of toMainChannelNames()) {
      expect(isChannelAllowed(channel, "other"), channel).toBe(false);
    }
  });

  it("a channel name outside the registry is refused for a trace window", () => {
    expect(isChannelAllowed("trace:export", "trace")).toBe(false);
    expect(isChannelAllowed("", "trace")).toBe(false);
  });
});
```

- [ ] **Step 3: Write the failing handler test**

Create `apps/desktop/src/main/trace-window-ipc.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { parseToMain } from "../shared/ipc-registry.js";
import type { IpcHandle } from "./trace-ipc.js";
import { registerTraceWindowHandlers } from "./trace-window-ipc.js";
import type { TraceWindowIpcDeps } from "./trace-window-ipc.js";
import type { TraceWindowHandle, TraceWindowRegistry } from "./trace-window.js";

/** Mirrors the ipc.ts handle wrapper after its sender checks: zod-parse, then call the handler. */
function harness(): {
  handle: IpcHandle;
  channels: () => string[];
  invoke: (channel: string, raw: unknown) => Promise<unknown>;
} {
  const handlers = new Map<string, (raw: unknown) => unknown>();
  const handle: IpcHandle = (channel, fn) => {
    handlers.set(channel, (raw) => fn(parseToMain(channel, raw)));
  };
  return {
    handle,
    channels: () => [...handlers.keys()].sort(),
    invoke: async (channel, raw) => {
      const handler = handlers.get(channel);
      if (handler === undefined) throw new Error(`no handler for ${channel}`);
      return await handler(raw);
    },
  };
}

function setup() {
  const openTraceWindow = vi.fn<(sessionId: string) => TraceWindowHandle>(
    () => ({}) as TraceWindowHandle,
  );
  const windows: TraceWindowRegistry = {
    openTraceWindow,
    isTraceSender: () => false,
    closeAll: () => undefined,
    count: () => 0,
  };
  const focusMainWindow = vi.fn<() => void>();
  const sent: Array<[string, unknown]> = [];
  const sendToRenderer: TraceWindowIpcDeps["sendToRenderer"] = (channel, payload) => {
    sent.push([channel, payload]);
  };
  const ipc = harness();
  registerTraceWindowHandlers(ipc.handle, {
    windows,
    sessionExists: (sessionId) => sessionId === "sess_1",
    focusMainWindow,
    sendToRenderer,
  });
  return { ipc, openTraceWindow, focusMainWindow, sent };
}

describe("trace window IPC handlers", () => {
  it("registers exactly trace:open and trace:requestChanges", () => {
    const { ipc } = setup();
    expect(ipc.channels()).toEqual(["trace:open", "trace:requestChanges"]);
  });

  it("opens a trace window for an existing session and returns nothing", async () => {
    const { ipc, openTraceWindow, sent } = setup();
    await expect(ipc.invoke("trace:open", { sessionId: "sess_1" })).resolves.toBeUndefined();
    expect(openTraceWindow).toHaveBeenCalledTimes(1);
    expect(openTraceWindow).toHaveBeenCalledWith("sess_1");
    expect(sent).toEqual([]);
  });

  it("refuses to open a window for an unknown session", async () => {
    const { ipc, openTraceWindow } = setup();
    await expect(ipc.invoke("trace:open", { sessionId: "sess_missing" })).rejects.toMatchObject({
      code: "UNKNOWN_SESSION",
    });
    expect(openTraceWindow).not.toHaveBeenCalled();
  });

  it("hands a note to the main window: one focus, one composer:prefill, nothing else", async () => {
    const { ipc, openTraceWindow, focusMainWindow, sent } = setup();
    const text = 'Re: trace sess_1 +0:43 "Claim contradicts tests" (seq 48; evidence seq 46)';
    await expect(
      ipc.invoke("trace:requestChanges", { sessionId: "sess_1", selected: "step:48", text }),
    ).resolves.toBeUndefined();
    expect(focusMainWindow).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([["composer:prefill", { sessionId: "sess_1", text }]]);
    expect(openTraceWindow).not.toHaveBeenCalled();
  });

  it("sends nothing for an unknown session", async () => {
    const { ipc, focusMainWindow, sent } = setup();
    await expect(
      ipc.invoke("trace:requestChanges", { sessionId: "sess_missing", selected: "step:1", text: "x" }),
    ).rejects.toMatchObject({ code: "UNKNOWN_SESSION" });
    expect(focusMainWindow).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("an oversized or malformed note sends nothing", async () => {
    const { ipc, focusMainWindow, sent } = setup();
    const bad: unknown[] = [
      { sessionId: "sess_1", selected: "step:48", text: "a".repeat(8_001) },
      { sessionId: "sess_1", selected: "file:src/a.ts", text: "x" },
      { sessionId: "sess_1", selected: "step:48", text: "" },
    ];
    for (const payload of bad) {
      await expect(ipc.invoke("trace:requestChanges", payload)).rejects.toMatchObject({
        code: "INVALID_PAYLOAD",
      });
    }
    expect(focusMainWindow).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });
});
```

- [ ] **Step 4: Run the three tests to verify they fail**

Run: `pnpm --filter jevcode-desktop exec vitest run src/shared/ipc-registry.test.ts src/main/trace-allowlist.test.ts src/main/trace-window-ipc.test.ts`
Expected: FAIL. In `trace window channels`, the first test fails with `IpcError: toMain channel not registered: trace:open` and the second with `expected 'UNKNOWN_CHANNEL' to be 'INVALID_PAYLOAD'`; the other two files fail with `Cannot find module './trace-allowlist.js'` and `Cannot find module './trace-window-ipc.js'`. The existing registry tests pass.

- [ ] **Step 5: Add the channel names and schemas**

In `apps/desktop/src/shared/local-channels.ts`, make five replacements.

Find:

```ts
  traceListSessions: "trace:listSessions",
  traceRows: "trace:rows",
  tracePayloads: "trace:payloads",
} as const;
```

Replace with:

```ts
  traceListSessions: "trace:listSessions",
  traceRows: "trace:rows",
  tracePayloads: "trace:payloads",
  traceOpen: "trace:open",
  traceRequestChanges: "trace:requestChanges",
} as const;
```

Find:

```ts
  preferencesUpdated: "preferences:updated",
} as const;
```

Replace with:

```ts
  preferencesUpdated: "preferences:updated",
  composerPrefill: "composer:prefill",
} as const;
```

Find:

```ts
export const TracePayloadsPayloadSchema = z.object({
  sessionId: z.string().min(1),
  seqs: z.array(z.number().int().positive()).min(1).max(TRACE_PAYLOADS_MAX),
});
```

Replace with:

```ts
export const TracePayloadsPayloadSchema = z.object({
  sessionId: z.string().min(1),
  seqs: z.array(z.number().int().positive()).min(1).max(TRACE_PAYLOADS_MAX),
});

// Trace window (spec §5.4, M5). trace:open is main-window only; trace:requestChanges
// is trace-window only (main/trace-allowlist.ts). Both respond with nothing.
export const TRACE_NOTE_MAX_CHARS = 8_000;

/** Spec §7.8 stable-id pattern for the selected step, unit or decision. */
export const TraceStableIdSchema = z.string().regex(/^(step:\d+|unit:.+|decision:.+)$/s);

export const TraceOpenPayloadSchema = z.object({ sessionId: z.string().min(1) });

export const TraceRequestChangesPayloadSchema = z.object({
  sessionId: z.string().min(1),
  selected: TraceStableIdSchema,
  text: z.string().min(1).max(TRACE_NOTE_MAX_CHARS),
});

export type TraceRequestChangesPayload = z.infer<typeof TraceRequestChangesPayloadSchema>;

/** main → main renderer: append to the composer draft; never sent as an instruction (spec §8.5). */
export const ComposerPrefillPayloadSchema = z.object({
  sessionId: z.string().min(1),
  text: z.string().min(1).max(TRACE_NOTE_MAX_CHARS),
});

export type ComposerPrefillPayload = z.infer<typeof ComposerPrefillPayloadSchema>;
```

Find:

```ts
  [RendererToMainLocalChannels.tracePayloads]: TracePayloadsPayloadSchema,
} as const;
```

Replace with:

```ts
  [RendererToMainLocalChannels.tracePayloads]: TracePayloadsPayloadSchema,
  [RendererToMainLocalChannels.traceOpen]: TraceOpenPayloadSchema,
  [RendererToMainLocalChannels.traceRequestChanges]: TraceRequestChangesPayloadSchema,
} as const;
```

Find:

```ts
  [MainToRendererLocalChannels.preferencesUpdated]:
    PreferencesUpdatedPayloadSchema,
} as const;
```

Replace with:

```ts
  [MainToRendererLocalChannels.preferencesUpdated]:
    PreferencesUpdatedPayloadSchema,
  [MainToRendererLocalChannels.composerPrefill]: ComposerPrefillPayloadSchema,
} as const;
```

- [ ] **Step 6: Write the allowlist**

Create `apps/desktop/src/main/trace-allowlist.ts`:

```ts
import { RendererToMainLocalChannels } from "../shared/local-channels.js";

/** How the ipc.ts handle wrapper classifies event.sender.id. */
export type SenderKind = "main" | "trace" | "other";

/** Everything a trace window may invoke: the three reads and the review-note handoff (spec §8.6). */
export const TRACE_WINDOW_CHANNELS: readonly string[] = [
  RendererToMainLocalChannels.traceListSessions,
  RendererToMainLocalChannels.traceRows,
  RendererToMainLocalChannels.tracePayloads,
  RendererToMainLocalChannels.traceRequestChanges,
];

/**
 * Spec §8.6: main → every channel except trace:requestChanges; trace →
 * TRACE_WINDOW_CHANNELS only; other → none. A trace window shares the preload,
 * so this check is what keeps it away from agent, decision, session, repo and
 * telemetry channels.
 */
export function isChannelAllowed(channel: string, sender: SenderKind): boolean {
  switch (sender) {
    case "main":
      return channel !== RendererToMainLocalChannels.traceRequestChanges;
    case "trace":
      return TRACE_WINDOW_CHANNELS.includes(channel);
    case "other":
      return false;
  }
}
```

- [ ] **Step 7: Write the handlers**

Create `apps/desktop/src/main/trace-window-ipc.ts`:

```ts
import { IpcError } from "../shared/errors.js";
import {
  MainToRendererLocalChannels,
  RendererToMainLocalChannels,
} from "../shared/local-channels.js";
import type { IpcHandle } from "./trace-ipc.js";
import type { TraceWindowRegistry } from "./trace-window.js";

export interface TraceWindowIpcDeps {
  windows: TraceWindowRegistry;
  /** listSessions({ sessionId, limit: 1 }) through the TraceReader (A2 + UI index §1.3). */
  sessionExists(sessionId: string): boolean;
  focusMainWindow(): void;
  sendToRenderer: typeof import("./ipc.js").sendToRenderer;
}

function unknownSession(sessionId: string): IpcError {
  return new IpcError("UNKNOWN_SESSION", `no session with id ${sessionId}`);
}

/**
 * trace:open → openTraceWindow (UNKNOWN_SESSION when absent);
 * trace:requestChanges → focusMainWindow + composer:prefill. The handlers
 * reach only the reader-backed sessionExists, the window registry and
 * sendToRenderer: never the runtime, the instruction router or the writer,
 * so a review note is never sent as an instruction (spec §8.5).
 */
export function registerTraceWindowHandlers(handle: IpcHandle, deps: TraceWindowIpcDeps): void {
  handle(RendererToMainLocalChannels.traceOpen, ({ sessionId }) => {
    if (!deps.sessionExists(sessionId)) throw unknownSession(sessionId);
    // The BrowserWindow is not serializable; the invoke resolves with nothing.
    deps.windows.openTraceWindow(sessionId);
  });

  handle(RendererToMainLocalChannels.traceRequestChanges, ({ sessionId, text }) => {
    if (!deps.sessionExists(sessionId)) throw unknownSession(sessionId);
    deps.focusMainWindow();
    deps.sendToRenderer(MainToRendererLocalChannels.composerPrefill, { sessionId, text });
  });
}
```

- [ ] **Step 8: Run the three tests to verify they pass**

Run: `pnpm --filter jevcode-desktop exec vitest run src/shared/ipc-registry.test.ts src/main/trace-allowlist.test.ts src/main/trace-window-ipc.test.ts`
Expected: PASS; `trace-allowlist.test.ts` 4 tests, `trace-window-ipc.test.ts` 6 tests, and the registry file's existing tests plus 2 new ones.

- [ ] **Step 9: Check senders in the `handle` wrapper and register the handlers**

In `apps/desktop/src/main/ipc.ts`, make four replacements.

Find:

```ts
import type { TraceService } from "./trace-service.js";
```

Replace with:

```ts
import type { TraceService } from "./trace-service.js";
import { isChannelAllowed } from "./trace-allowlist.js";
import type { SenderKind } from "./trace-allowlist.js";
import { registerTraceWindowHandlers } from "./trace-window-ipc.js";
import type { TraceWindowIpcDeps } from "./trace-window-ipc.js";
```

Find:

```ts
  /** Read-only trace access over a query_only reader (trace-ipc.ts). */
  trace: TraceService;
}
```

Replace with:

```ts
  /** Read-only trace access over a query_only reader (trace-ipc.ts). */
  trace: TraceService;
  /** Classifies an IPC sender by webContents id for the channel allowlist (trace-allowlist.ts). */
  senderKind(webContentsId: number): SenderKind;
  /** trace:open and trace:requestChanges (trace-window-ipc.ts). */
  traceWindows: TraceWindowIpcDeps;
}
```

Find:

```ts
    ipcMain.handle(channel, async (event, raw) => {
      assertTrustedSender(event);
      const payload = parseToMain(channel, raw);
```

Replace with:

```ts
    ipcMain.handle(channel, async (event, raw) => {
      assertTrustedSender(event);
      // Spec §8.6: trace windows share the preload, so each sender may use
      // only the channels its kind allows. Checked before zod parsing.
      const sender = deps.senderKind(event.sender.id);
      if (!isChannelAllowed(channel, sender)) {
        deps.log(`ipc ${channel} rejected: ${sender} sender`);
        throw new IpcError("UNTRUSTED_SENDER", `${channel} is not allowed from a ${sender} sender`);
      }
      const payload = parseToMain(channel, raw);
```

Find:

```ts
  registerTraceHandlers(handle, deps.trace);
}
```

Replace with:

```ts
  registerTraceHandlers(handle, deps.trace);
  registerTraceWindowHandlers(handle, deps.traceWindows);
}
```

- [ ] **Step 10: Wire the registry in `index.ts`**

In `apps/desktop/src/main/index.ts`, make six replacements.

Find:

```ts
import { createTraceService } from "./trace-service.js";
```

Replace with:

```ts
import { createTraceService } from "./trace-service.js";
import { createTraceWindowRegistry, sharedWebPreferences } from "./trace-window.js";
import type { TraceWindowRegistry } from "./trace-window.js";
```

Find:

```ts
const dirname = path.dirname(fileURLToPath(import.meta.url));
```

Replace with:

```ts
const dirname = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD_PATH = path.join(dirname, "../preload/index.cjs");
const TRACE_HTML_PATH = path.join(dirname, "../renderer/src/renderer/trace.html");
```

Find:

```ts
let traceReader: TraceReader | null = null;
```

Replace with:

```ts
let traceReader: TraceReader | null = null;
let traceWindows: TraceWindowRegistry | null = null;
```

Find:

```ts
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      preload: path.join(dirname, "../preload/index.cjs"),
    },
```

Replace with:

```ts
    webPreferences: sharedWebPreferences(PRELOAD_PATH),
```

Find:

```ts
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
      setMainWindow(null);
    }
  });
```

Replace with:

```ts
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
      setMainWindow(null);
      // A trace window never outlives the main window (spec §8.1).
      traceWindows?.closeAll();
    }
  });
```

Find:

```ts
  mainWindow = createWindow();
  setMainWindow(mainWindow);

  registerIpcHandlers({
    db,
    state,
    terminals,
    runtime,
    instructionRouter,
    trace: createTraceService(reader),
    requestRepoPath: () => openDirectoryDialog(mainWindow),
```

Replace with:

```ts
  mainWindow = createWindow();
  setMainWindow(mainWindow);

  const traceService = createTraceService(reader);
  const windows = createTraceWindowRegistry({
    create: (options) => new BrowserWindow(options),
    preloadPath: PRELOAD_PATH,
    traceHtmlPath: TRACE_HTML_PATH,
  });
  traceWindows = windows;

  registerIpcHandlers({
    db,
    state,
    terminals,
    runtime,
    instructionRouter,
    trace: traceService,
    senderKind: (webContentsId) => {
      const main = mainWindow;
      if (main !== null && !main.isDestroyed() && main.webContents.id === webContentsId) {
        return "main";
      }
      return windows.isTraceSender(webContentsId) ? "trace" : "other";
    },
    traceWindows: {
      windows,
      sessionExists: (sessionId) => traceService.listSessions({ sessionId, limit: 1 }).length > 0,
      focusMainWindow: () => {
        const main = mainWindow;
        if (main === null || main.isDestroyed()) return;
        if (main.isMinimized()) main.restore();
        main.show();
        main.focus();
      },
      sendToRenderer,
    },
    requestRepoPath: () => openDirectoryDialog(mainWindow),
```

- [ ] **Step 11: Typecheck, build and confirm the wiring**

`ipc.ts` and `index.ts` import `electron` at run time, so vitest cannot load them; the typecheck, the built output and one Electron boot verify them.

Run: `pnpm --filter jevcode-desktop typecheck`
Expected: exit 0.

Run: `pnpm --filter jevcode-desktop build`
Expected: exit 0.

Run: `grep -c "isChannelAllowed(channel, sender)" apps/desktop/dist/main/ipc.js`
Expected: `1`

Run: `grep -c "registerTraceWindowHandlers(handle, deps.traceWindows)" apps/desktop/dist/main/ipc.js`
Expected: `1`

Run: `grep -c "createTraceWindowRegistry" apps/desktop/dist/main/index.js`
Expected: `2`

Run (Electron boot with a throwaway database; the main renderer's own startup calls must pass the allowlist as `main`):

```bash
pnpm --filter jevcode-desktop run rebuild
rm -f "${TMPDIR:-/tmp}/jevcode-da-smoke.db"*
JEVCODE_SMOKE=1 JEVCODE_DB="${TMPDIR:-/tmp}/jevcode-da-smoke.db" pnpm --filter jevcode-desktop start 2>&1 | tee "${TMPDIR:-/tmp}/jevcode-da-smoke.log"
grep -c "rejected:" "${TMPDIR:-/tmp}/jevcode-da-smoke.log"
pnpm --filter jevcode-desktop rebuild:node
```

Expected: the log contains `SMOKE_OK`; the `grep -c` prints `0`; the last command prints `native modules restored to node ABI`.

- [ ] **Step 12: Run the root checks**

Run, in order: `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r --no-bail --workspace-concurrency=1 test`, `pnpm lint`
Expected: each exits 0.

- [ ] **Step 13: Commit**

```bash
git add apps/desktop/src/shared/local-channels.ts apps/desktop/src/shared/ipc-registry.test.ts apps/desktop/src/main/trace-allowlist.ts apps/desktop/src/main/trace-allowlist.test.ts apps/desktop/src/main/trace-window-ipc.ts apps/desktop/src/main/trace-window-ipc.test.ts apps/desktop/src/main/ipc.ts apps/desktop/src/main/index.ts
git commit -m "feat(desktop): add trace window channels and a per-sender IPC allowlist"
```

**Part Da exit:** `pnpm --filter jevcode-desktop typecheck` and `test` pass; the four root checks pass; `trace:open` and `trace:requestChanges` exist but nothing in the renderer calls them yet. Merge to `main` after C2 and C3a (UI index §4).

### Hand-offs from Da (lane review)

The Da lane review (2026-09-30) found no blocking issue. Part Db must know four contract points:

1. **`trace:requestChanges` is bound to the sender window's own session.** `createDesktopViewerHost` must send the same `sessionId` as the `?session=` query that opened the window. A mismatch is rejected inside the handler, is serialized, and arrives as `jevcode.ipc.UNTRUSTED_SENDER: …`.
2. **Allowlist rejections cross the bridge without a code.** The `handle` wrapper throws a raw `IpcError` outside its `try`, like the existing `assertTrustedSender` and `parseToMain` paths, so the renderer sees no `jevcode.ipc.<CODE>` prefix. The ipc-source maps unknown errors to `SOURCE_FAILED`; Db must not depend on the code for these errors.
3. **`IpcHandle` changed.** `fn` takes a second `context: IpcHandleContext` argument (`{ senderId }`). One-parameter handlers still typecheck; a test harness that calls `fn` directly must pass `{ senderId }`. D-7's `bridgeOver` calls the service directly and is not affected.
4. **`TraceWindowRegistry` gained `sessionForSender(webContentsId)`.** A hand-written fake registry in Db tests must implement it. The Db plan has none today.

### Hand-offs from C2 (fix wave)

Source: the C2 lane review ("Hand-offs W3 must know"), its fix-wave re-review ("W3 hand-offs") and the C2 ledger (`.superpowers/sdd/2026-09-28-trace-viewer-06-viewer-shell-hybrid/`). Binding for D-3..D-8.

1. **Commits are progressive.** The DataController yields one macrotask between pages. `onReady` still fires once, after the first committed fold, and its `rows` is the count folded so far (one page of a large session, not the total). Wait for the `tv:full-load` mark for "loaded".
2. **Key the viewer by session id.** `TraceViewer` captures `source`, `pollMs` and the store in `useState`, so a new `source` prop does nothing. Key it by `sessionId` (or keep one window per session) and pass a stable `host` object: the Shell's `onLocation` and diagnostics effects re-run when `host` identity changes.
3. **Mark `tv:bundle-parsed` in `trace/main.tsx`.** `markAfterPaint(PERF.fullLoad, PERF.bundleParsed)` always records the `tv:full-load` mark, but the measure exists only when something marked `tv:bundle-parsed`. `tv:live-tick` is measured after the full load either way.
4. **Final state.** The title bar reads the final state from `session.meta.state`, the latest page's state, so a live window whose session ends shows the terminal state. The lane review's "shows Running" caveat is closed.
5. **Review note.** `requestChanges` receives `{ sessionId: session.meta.sessionId, selected, text: note.firstLine }`; `text` escapes bidi characters in chapter and decision titles. `sessionId` must equal the `?session=` id (Da hand-off 1).
6. **Visibility.** The DataController does not emit while the document is hidden and flushes the latest snapshot on show; the poll keeps running while hidden.

---

## Part Db: trace window, live follow, parity and M5 exit (lane 08b, wave W3)

### Task D-3: API namespace, `trace.html`, trace entry, `createIpcTraceSource`, desktop host

**Files:**
- Modify: `apps/desktop/src/shared/api.ts`
- Modify: `apps/desktop/src/shared/api.test.ts`
- Create: `apps/desktop/src/renderer/trace.html`
- Create: `apps/desktop/src/renderer/trace/main.tsx`
- Create: `apps/desktop/src/renderer/trace/ipc-source.ts`
- Test: `apps/desktop/src/renderer/trace/ipc-source.test.ts`
- Create: `apps/desktop/src/renderer/trace/host.ts`
- Test: `apps/desktop/src/renderer/trace/host.test.ts`
- Modify: `apps/desktop/vite.config.ts`

**Interfaces:**
- Consumes:
  - D-2: channels `trace:open`, `trace:requestChanges`, `composer:prefill`; `type ComposerPrefillPayload = { sessionId: string; text: string }` from `apps/desktop/src/shared/local-channels.ts`.
  - A2-4 + UI index §1.3: `JevcodeApi.trace.listSessions(request?: { repoId?: string; sessionId?: string; limit?: number }): Promise<TraceSessionSummary[]>`, `rows(request: { sessionId: string; afterSeq?: number; limit?: number }): Promise<TraceRowsPage>`, `payloads(request: { sessionId: string; seqs: readonly number[] }): Promise<TraceRow[]>`.
  - W0-6: `interface TraceSource { readonly sessionId: string; summary(): Promise<TraceSessionSummary>; rows(request?: TraceRowsRequest): Promise<TraceRowsPage>; payloads(seqs: readonly number[]): Promise<TraceRow[]>; now(): number }`, `interface TraceRowsRequest { afterSeq?: number; limit?: number }` (root barrel `@jevcode/trace-viewer`, type-only).
  - C1-15: `class TraceSourceError extends Error { readonly channel: TraceChannel; readonly code: TraceSourceErrorCode; constructor(channel, code, message) }`, `type TraceChannel = "trace:listSessions" | "trace:rows" | "trace:payloads" | "bundle"`, `type TraceSourceErrorCode = "UNKNOWN_SESSION" | "NOT_A_TRACE" | "UNSUPPORTED_VERSION" | "SOURCE_FAILED"` from `@jevcode/trace-viewer/sources`.
  - C2-3: `TraceViewer(props: { source: TraceSource; host?: ViewerHost; location?: ViewerLocation; pollMs?: number })`; `interface ViewerHost { requestChanges?(request: RequestChangesRequest): void | Promise<void>; onLocation?(l): void; onReady?(info: ViewerReadyInfo): void; onDiagnostics?(d): void }`; `RequestChangesRequest { sessionId: string; selected: SelectionId; text: string }`; `ViewerReadyInfo { rows: number; loadedThroughSeq: number }`; the DataController polls every `pollMs` until `terminal(page.state)`, with `BACKOFF_MS = [1_000, 2_000, 4_000, 10_000]`.
  - W0-5: `TRACE_LIVE_POLL_MS = 1_000` from `@jevcode/contracts`.
- Produces:
  ```ts
  // shared/api.ts — JevcodeApi additions
  trace.open(sessionId: string): Promise<void>;
  trace.requestChanges(request: { sessionId: string; selected: string; text: string }): Promise<void>;
  onComposerPrefill(listener: (payload: { sessionId: string; text: string }) => void): () => void;
  // renderer/trace/ipc-source.ts
  export function createIpcTraceSource(bridge: JevcodeApi["trace"], sessionId: string): TraceSource;
  // renderer/trace/host.ts
  export function createDesktopViewerHost(bridge: Pick<JevcodeApi, "trace">, log: (line: string) => void): ViewerHost;
  export function sessionIdFromSearch(search: string): string | null;
  export interface PerfEntryLike { name: string; entryType: string; startTime: number; duration: number }
  export function traceConsoleLine(entry: PerfEntryLike): string | null;
  // console lines from the trace window: TRACE_READY <rows>, TRACE_LOADED <ms>, TRACE_PERF <name> <ms>, CSP_VIOLATION <directive> <uri>
  ```

- [ ] **Step 1: Write the failing API tests**

In `apps/desktop/src/shared/api.test.ts`, first replace A2-4's shape test. Find:

```ts
  it("is structurally a TraceSource", () => {
    const source: TraceSource = createJevcodeApi(makeDeps()).trace;
    expect(Object.keys(source).sort()).toEqual(["listSessions", "payloads", "rows"]);
  });
```

Replace with:

```ts
  it("the trace namespace holds three reads, open and requestChanges", () => {
    const trace = createJevcodeApi(makeDeps()).trace;
    expect(Object.keys(trace).sort()).toEqual([
      "listSessions",
      "open",
      "payloads",
      "requestChanges",
      "rows",
    ]);
  });
```

If that `it("is structurally a TraceSource"` block is absent (A2 already changed it), add the replacement test at the end of the `describe("createJevcodeApi"` block instead. Then delete the now-unused import line (and the blank line after it) if present:

```ts
import type { TraceSource } from "@jevcode/trace-viewer";
```

Append to the end of the file:

```ts

describe("trace window API", () => {
  it("opens a trace window and hands a review note to main", async () => {
    const deps = makeDeps();
    const api = createJevcodeApi(deps);
    await api.trace.open("sess_1");
    expect(deps.invoke).toHaveBeenCalledWith("trace:open", { sessionId: "sess_1" });
    await api.trace.requestChanges({ sessionId: "sess_1", selected: "step:48", text: "Re: trace" });
    expect(deps.invoke).toHaveBeenCalledWith("trace:requestChanges", {
      sessionId: "sess_1",
      selected: "step:48",
      text: "Re: trace",
    });
  });

  it("rejects malformed trace window requests before they reach main", async () => {
    const deps = makeDeps();
    const api = createJevcodeApi(deps);
    await expect(api.trace.open("")).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    await expect(
      api.trace.requestChanges({ sessionId: "sess_1", selected: "file:a.ts", text: "x" }),
    ).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    await expect(
      api.trace.requestChanges({ sessionId: "sess_1", selected: "step:1", text: "a".repeat(8_001) }),
    ).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    expect(deps.invoke).not.toHaveBeenCalled();
  });

  it("delivers composer:prefill payloads and drops invalid ones", () => {
    const deps = makeDeps();
    const captured = new Map<string, (payload: unknown) => void>();
    deps.on.mockImplementation((channel, listener) => {
      captured.set(channel, listener);
      return () => undefined;
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const listener = vi.fn();
    createJevcodeApi(deps).onComposerPrefill(listener);
    const push = captured.get("composer:prefill");
    expect(push).toBeDefined();
    push?.({ sessionId: "sess_1", text: "note" });
    push?.({ sessionId: "", text: "note" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ sessionId: "sess_1", text: "note" });
    quiet.mockRestore();
  });
});
```

- [ ] **Step 2: Write the failing source and host tests**

Create `apps/desktop/src/renderer/trace/ipc-source.test.ts`:

```ts
import type { TraceRowsPage, TraceSessionSummary } from "@jevcode/contracts";
import { TraceSourceError } from "@jevcode/trace-viewer/sources";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { JevcodeApi } from "../../shared/api.js";
import { createIpcTraceSource } from "./ipc-source.js";

type Bridge = JevcodeApi["trace"];

const SUMMARY: TraceSessionSummary = {
  sessionId: "s",
  repoId: "repo_1",
  repoName: "api",
  prompt: "Add Google OAuth",
  state: "running",
  startedAt: "2026-09-28T10:00:00.000Z",
  endedAt: null,
  lastEventSeq: 3,
};

const PAGE: TraceRowsPage = {
  rows: [{ seq: 1, type: "agent_event", ts: "2026-09-28T10:00:00.000Z", payload: {} }],
  nextAfterSeq: null,
  lastSeq: 3,
  state: "running",
};

function fakeBridge() {
  return {
    listSessions: vi.fn<Bridge["listSessions"]>(async () => [SUMMARY]),
    rows: vi.fn<Bridge["rows"]>(async () => PAGE),
    payloads: vi.fn<Bridge["payloads"]>(async () => PAGE.rows),
    open: vi.fn<Bridge["open"]>(async () => undefined),
    requestChanges: vi.fn<Bridge["requestChanges"]>(async () => undefined),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createIpcTraceSource", () => {
  it("is bound to one session", () => {
    expect(createIpcTraceSource(fakeBridge(), "s").sessionId).toBe("s");
  });

  it("summary() asks main for exactly this session", async () => {
    const bridge = fakeBridge();
    await expect(createIpcTraceSource(bridge, "s").summary()).resolves.toEqual(SUMMARY);
    expect(bridge.listSessions).toHaveBeenCalledWith({ sessionId: "s", limit: 1 });
  });

  it("summary() rejects UNKNOWN_SESSION when main lists nothing", async () => {
    const bridge = fakeBridge();
    bridge.listSessions.mockResolvedValue([]);
    const failure = createIpcTraceSource(bridge, "s").summary();
    await expect(failure).rejects.toBeInstanceOf(TraceSourceError);
    await expect(failure).rejects.toMatchObject({
      channel: "trace:listSessions",
      code: "UNKNOWN_SESSION",
    });
  });

  it("summary() ignores a different session in the reply", async () => {
    const bridge = fakeBridge();
    bridge.listSessions.mockResolvedValue([{ ...SUMMARY, sessionId: "other" }]);
    await expect(createIpcTraceSource(bridge, "s").summary()).rejects.toMatchObject({
      code: "UNKNOWN_SESSION",
    });
  });

  it("rows() binds the session and forwards only the fields given", async () => {
    const bridge = fakeBridge();
    const source = createIpcTraceSource(bridge, "s");
    await expect(source.rows()).resolves.toEqual(PAGE);
    await source.rows({ afterSeq: 5, limit: 7 });
    expect(bridge.rows.mock.calls.map(([request]) => request)).toEqual([
      { sessionId: "s" },
      { sessionId: "s", afterSeq: 5, limit: 7 },
    ]);
  });

  it("payloads() passes a plain array and skips an empty request", async () => {
    const bridge = fakeBridge();
    const source = createIpcTraceSource(bridge, "s");
    await source.payloads(Object.freeze([1, 2]));
    const sent = bridge.payloads.mock.calls[0]?.[0];
    expect(sent).toEqual({ sessionId: "s", seqs: [1, 2] });
    expect(sent !== undefined && Object.isFrozen(sent.seqs)).toBe(false);
    await expect(source.payloads([])).resolves.toEqual([]);
    expect(bridge.payloads).toHaveBeenCalledTimes(1);
  });

  it("an IPC rejection becomes a TraceSourceError naming the channel", async () => {
    const bridge = fakeBridge();
    bridge.rows.mockRejectedValue(new Error("Error invoking remote method 'trace:rows': boom"));
    const failure = createIpcTraceSource(bridge, "s").rows({ afterSeq: 3 });
    await expect(failure).rejects.toBeInstanceOf(TraceSourceError);
    await expect(failure).rejects.toMatchObject({ channel: "trace:rows", code: "SOURCE_FAILED" });
    await expect(failure).rejects.toThrow(/boom/);
  });

  it("maps a bridge error without a code by its message", async () => {
    const bridge = fakeBridge();
    // contextBridge copies only the message of an IpcError into the page.
    bridge.payloads.mockRejectedValue(new Error("no session with id s"));
    await expect(createIpcTraceSource(bridge, "s").payloads([1])).rejects.toMatchObject({
      channel: "trace:payloads",
      code: "UNKNOWN_SESSION",
    });
    bridge.rows.mockRejectedValue({ code: "UNKNOWN_SESSION", message: "gone" });
    await expect(createIpcTraceSource(bridge, "s").rows()).rejects.toMatchObject({
      channel: "trace:rows",
      code: "UNKNOWN_SESSION",
    });
  });

  it("now() is the wall clock", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_234);
    expect(createIpcTraceSource(fakeBridge(), "s").now()).toBe(1_234);
  });
});
```

Create `apps/desktop/src/renderer/trace/host.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import type { JevcodeApi } from "../../shared/api.js";
import { createDesktopViewerHost, sessionIdFromSearch, traceConsoleLine } from "./host.js";

type Bridge = JevcodeApi["trace"];

function fakeBridge(): Pick<JevcodeApi, "trace"> & {
  requestChanges: ReturnType<typeof vi.fn<Bridge["requestChanges"]>>;
} {
  const requestChanges = vi.fn<Bridge["requestChanges"]>(async () => undefined);
  return {
    requestChanges,
    trace: {
      listSessions: vi.fn<Bridge["listSessions"]>(async () => []),
      rows: vi.fn<Bridge["rows"]>(async () => ({ rows: [], nextAfterSeq: null, lastSeq: 0, state: "running" })),
      payloads: vi.fn<Bridge["payloads"]>(async () => []),
      open: vi.fn<Bridge["open"]>(async () => undefined),
      requestChanges,
    },
  };
}

describe("createDesktopViewerHost", () => {
  it("logs TRACE_READY with the row count once", () => {
    const lines: string[] = [];
    const host = createDesktopViewerHost(fakeBridge(), (line) => lines.push(line));
    host.onReady?.({ rows: 12, loadedThroughSeq: 40 });
    host.onReady?.({ rows: 30, loadedThroughSeq: 80 });
    expect(lines).toEqual(["TRACE_READY 12"]);
  });

  it("hands the review note to main unchanged and surfaces a failure", async () => {
    const bridge = fakeBridge();
    const host = createDesktopViewerHost(bridge, () => undefined);
    const request = {
      sessionId: "sess_1",
      selected: "step:48" as const,
      text: 'Re: trace sess_1 +0:43 "Claim contradicts tests" (seq 48; evidence seq 46)',
    };
    await host.requestChanges?.(request);
    expect(bridge.requestChanges).toHaveBeenCalledWith(request);
    bridge.requestChanges.mockRejectedValueOnce(new Error("no session with id sess_1"));
    await expect(host.requestChanges?.(request)).rejects.toThrow(/no session/);
  });

  it("keeps the location in memory (no onLocation sink)", () => {
    expect(createDesktopViewerHost(fakeBridge(), () => undefined).onLocation).toBeUndefined();
  });
});

describe("sessionIdFromSearch", () => {
  it("reads the session query that openTraceWindow sets", () => {
    expect(sessionIdFromSearch("?session=sess_1")).toBe("sess_1");
    expect(sessionIdFromSearch("?session=a%26b")).toBe("a&b");
    expect(sessionIdFromSearch("?session=%20")).toBeNull();
    expect(sessionIdFromSearch("")).toBeNull();
    expect(sessionIdFromSearch("?other=1")).toBeNull();
  });
});

describe("traceConsoleLine", () => {
  it("reports the full-load mark and tv: measures only", () => {
    expect(traceConsoleLine({ name: "tv:full-load", entryType: "mark", startTime: 812.4, duration: 0 })).toBe(
      "TRACE_LOADED 812",
    );
    expect(traceConsoleLine({ name: "tv:live-tick", entryType: "measure", startTime: 5, duration: 3.456 })).toBe(
      "TRACE_PERF tv:live-tick 3.46",
    );
    expect(traceConsoleLine({ name: "tv:first-paint", entryType: "mark", startTime: 90, duration: 0 })).toBeNull();
    expect(traceConsoleLine({ name: "react-render", entryType: "measure", startTime: 1, duration: 2 })).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @jevcode/trace-viewer build`
Expected: exit 0 (desktop tests import its `dist`).

Run: `pnpm --filter jevcode-desktop exec vitest run src/shared/api.test.ts src/renderer/trace/ipc-source.test.ts src/renderer/trace/host.test.ts`
Expected: FAIL. `api.test.ts` fails the namespace-keys test and the three "trace window API" tests (`api.trace.open is not a function`, `createJevcodeApi(...).onComposerPrefill is not a function`); the other two files fail with `Cannot find module './ipc-source.js'` and `'./host.js'`.

- [ ] **Step 4: Extend the API**

In `apps/desktop/src/shared/api.ts`, make five replacements.

Find:

```ts
import type {
  DebugEventsPayload,
```

Replace with:

```ts
import type {
  ComposerPrefillPayload,
  DebugEventsPayload,
```

Find:

```ts
    payloads(request: { sessionId: string; seqs: readonly number[] }): Promise<TraceRow[]>;
  };
```

Replace with:

```ts
    payloads(request: { sessionId: string; seqs: readonly number[] }): Promise<TraceRow[]>;
    /** Opens (or focuses) the session's trace window. Main window only (main/trace-allowlist.ts). */
    open(sessionId: string): Promise<void>;
    /** Hands a review note to the main window's composer. Trace windows only; never sends an instruction. */
    requestChanges(request: { sessionId: string; selected: string; text: string }): Promise<void>;
  };
```

Find:

```ts
  onPrefsUpdated(listener: (payload: AgentPreferences) => void): () => void;
}
```

Replace with:

```ts
  onPrefsUpdated(listener: (payload: AgentPreferences) => void): () => void;
  /** A trace window's "Request changes" note for the composer (spec §8.5). */
  onComposerPrefill(listener: (payload: ComposerPrefillPayload) => void): () => void;
}
```

Find:

```ts
        })) as { rows: TraceRow[] };
        return result.rows;
      },
    },
    on,
```

Replace with:

```ts
        })) as { rows: TraceRow[] };
        return result.rows;
      },
      open: async (sessionId) => {
        await invoke("trace:open", { sessionId });
      },
      requestChanges: async (request) => {
        await invoke("trace:requestChanges", {
          sessionId: request.sessionId,
          selected: request.selected,
          text: request.text,
        });
      },
    },
    on,
```

Find:

```ts
    onPrefsUpdated: (listener) =>
      on(MainToRendererLocalChannels.preferencesUpdated, listener),
  };
}
```

Replace with:

```ts
    onPrefsUpdated: (listener) =>
      on(MainToRendererLocalChannels.preferencesUpdated, listener),
    onComposerPrefill: (listener) =>
      on(MainToRendererLocalChannels.composerPrefill, listener),
  };
}
```

- [ ] **Step 5: Write the IPC source**

Create `apps/desktop/src/renderer/trace/ipc-source.ts`:

```ts
import type { TraceRowsPage } from "@jevcode/contracts";
import type { TraceRowsRequest, TraceSource } from "@jevcode/trace-viewer";
import { TraceSourceError } from "@jevcode/trace-viewer/sources";
import type { TraceChannel } from "@jevcode/trace-viewer/sources";

import type { JevcodeApi } from "../../shared/api.js";

// The service's IpcError text (main/trace-service.ts) and the code name itself.
const UNKNOWN_SESSION_MESSAGE = /UNKNOWN_SESSION|no session with id|unknown session/i;

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

function codeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code: unknown }).code
    : undefined;
}

/** contextBridge copies only an error's message into the page, so the code is also read from the text. */
function toSourceError(channel: TraceChannel, error: unknown): TraceSourceError {
  if (error instanceof TraceSourceError) return error;
  const message = messageOf(error);
  const unknownSession = codeOf(error) === "UNKNOWN_SESSION" || UNKNOWN_SESSION_MESSAGE.test(message);
  return new TraceSourceError(channel, unknownSession ? "UNKNOWN_SESSION" : "SOURCE_FAILED", message);
}

async function call<T>(channel: TraceChannel, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw toSourceError(channel, error);
  }
}

/**
 * summary() → trace.listSessions({sessionId, limit: 1}) (TraceSourceError
 * UNKNOWN_SESSION when empty); rows → trace.rows; payloads → trace.payloads;
 * now() → Date.now(). Stateless: the viewer's DataController owns paging, the
 * 1 s live poll, backoff and the terminal-state stop (spec §5.5, §8.3).
 */
export function createIpcTraceSource(bridge: JevcodeApi["trace"], sessionId: string): TraceSource {
  return {
    sessionId,
    summary: () =>
      call("trace:listSessions", async () => {
        const sessions = await bridge.listSessions({ sessionId, limit: 1 });
        const found = sessions.find((session) => session.sessionId === sessionId);
        if (found === undefined) {
          throw new TraceSourceError("trace:listSessions", "UNKNOWN_SESSION", `no session with id ${sessionId}`);
        }
        return found;
      }),
    rows: (request: TraceRowsRequest = {}) =>
      call("trace:rows", async (): Promise<TraceRowsPage> => {
        const query: { sessionId: string; afterSeq?: number; limit?: number } = { sessionId };
        if (request.afterSeq !== undefined) query.afterSeq = request.afterSeq;
        if (request.limit !== undefined) query.limit = request.limit;
        return await bridge.rows(query);
      }),
    payloads: (seqs) => {
      if (seqs.length === 0) return Promise.resolve([]);
      return call("trace:payloads", () => bridge.payloads({ sessionId, seqs: [...seqs] }));
    },
    now: () => Date.now(),
  };
}
```

- [ ] **Step 6: Write the desktop host**

Create `apps/desktop/src/renderer/trace/host.ts`:

```ts
import type { ViewerHost } from "@jevcode/trace-viewer";

import type { JevcodeApi } from "../../shared/api.js";

// C2-3 PERF names (spec §10). PERF is not exported from the package root, so
// the host matches the literal values.
const FULL_LOAD_MARK = "tv:full-load";
const VIEWER_MEASURE_PREFIX = "tv:";

/** The session id from trace.html's query; openTraceWindow loads it with {query: {session}}. */
export function sessionIdFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get("session");
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export interface PerfEntryLike {
  name: string;
  entryType: string;
  startTime: number;
  duration: number;
}

/**
 * One console line per viewer perf entry, read by main/smoke.ts and by
 * JEVCODE_TRACE_PERF=1: "TRACE_LOADED <ms>" for the full-load mark,
 * "TRACE_PERF <name> <ms>" for every tv:* measure, null for anything else.
 */
export function traceConsoleLine(entry: PerfEntryLike): string | null {
  if (entry.entryType === "mark" && entry.name === FULL_LOAD_MARK) {
    return `TRACE_LOADED ${Math.round(entry.startTime)}`;
  }
  if (entry.entryType === "measure" && entry.name.startsWith(VIEWER_MEASURE_PREFIX)) {
    return `TRACE_PERF ${entry.name} ${entry.duration.toFixed(2)}`;
  }
  return null;
}

/**
 * requestChanges → bridge.trace.requestChanges (a rejection reaches the
 * Inspector); onReady → log(`TRACE_READY ${rows}`) once, even under
 * StrictMode. No onLocation: Electron keeps the location in memory (R20).
 */
export function createDesktopViewerHost(
  bridge: Pick<JevcodeApi, "trace">,
  log: (line: string) => void,
): ViewerHost {
  let ready = false;
  return {
    requestChanges: (request) =>
      bridge.trace.requestChanges({
        sessionId: request.sessionId,
        selected: request.selected,
        text: request.text,
      }),
    onReady: (info) => {
      if (ready) return;
      ready = true;
      log(`TRACE_READY ${info.rows}`);
    },
  };
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter jevcode-desktop exec vitest run src/shared/api.test.ts src/renderer/trace/ipc-source.test.ts src/renderer/trace/host.test.ts`
Expected: PASS; `ipc-source.test.ts` 9 tests, `host.test.ts` 5 tests, and `api.test.ts` all tests including the 3 new "trace window API" tests.

- [ ] **Step 8: Add the trace page, its entry and the second Vite input**

Create `apps/desktop/src/renderer/trace.html` (the CSP meta is index.html's, character for character):

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'"
    />
    <title>Trace</title>
    <style>
      html,
      body,
      #root {
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: #ffffff;
      }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./trace/main.tsx"></script>
  </body>
</html>
```

Create `apps/desktop/src/renderer/trace/main.tsx` (it never imports `../styles.css`; the viewer brings its own CSS Modules):

```tsx
import { TRACE_LIVE_POLL_MS } from "@jevcode/contracts";
import { TraceViewer } from "@jevcode/trace-viewer";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { getBridge } from "../bridge.js";
import { createDesktopViewerHost, sessionIdFromSearch, traceConsoleLine } from "./host.js";
import { createIpcTraceSource } from "./ipc-source.js";

// Chromium logs CSP violations itself; this line also names the directive, and
// main/smoke.ts fails the run on either (spec §8.7).
document.addEventListener("securitypolicyviolation", (event) => {
  console.error(`CSP_VIOLATION ${event.violatedDirective} ${event.blockedURI}`);
});

// The viewer's paint and live-tick entries reach main as console lines
// (TRACE_LOADED for the smoke, TRACE_PERF for docs/perf.md).
if (typeof PerformanceObserver !== "undefined") {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const line = traceConsoleLine(entry);
      if (line !== null) console.log(line);
    }
  }).observe({ entryTypes: ["mark", "measure"] });
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("missing #root element");
}

const root = createRoot(container);
const sessionId = sessionIdFromSearch(window.location.search);

if (sessionId === null) {
  root.render(<p>No session was given to this trace window.</p>);
} else {
  const bridge = getBridge();
  const source = createIpcTraceSource(bridge.trace, sessionId);
  const host = createDesktopViewerHost(bridge, (line) => console.log(line));
  root.render(
    <StrictMode>
      <TraceViewer source={source} host={host} pollMs={TRACE_LIVE_POLL_MS} />
    </StrictMode>,
  );
}
```

In `apps/desktop/vite.config.ts`, find:

```ts
  build: {
    outDir: "dist/renderer",
    emptyOutDir: false,
    rollupOptions: {
      input: "src/renderer/index.html",
    },
  },
```

Replace with:

```ts
  build: {
    outDir: "dist/renderer",
    emptyOutDir: false,
    // default-src 'self' blocks data: URIs, so no asset may be inlined (spec §8.2).
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        main: "src/renderer/index.html",
        trace: "src/renderer/trace.html",
      },
    },
  },
```

- [ ] **Step 9: Typecheck, build and inspect the output**

Run: `pnpm --filter jevcode-desktop typecheck`
Expected: exit 0 (`tsconfig.web.json` checks `trace/main.tsx`, `ipc-source.ts` and `host.ts`).

Run: `pnpm --filter jevcode-desktop build`
Expected: exit 0.

Run: `ls apps/desktop/dist/renderer/src/renderer/`
Expected: `index.html` and `trace.html` (the path `index.ts` loads with `TRACE_HTML_PATH`).

Run: `grep -c "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'" apps/desktop/dist/renderer/src/renderer/trace.html`
Expected: `1`

Run (the trace page links no stylesheet that index.html links, so `styles.css` never reaches it, and no CSS uses a `data:` URL):

```bash
node -e '
const fs = require("fs");
const dir = "apps/desktop/dist/renderer/src/renderer/";
const css = (file) => new Set((fs.readFileSync(dir + file, "utf8").match(/assets\/[^"]+\.css/g) || []));
const main = css("index.html"); const trace = css("trace.html");
const shared = [...trace].filter((f) => main.has(f));
const dataUrls = fs.readdirSync("apps/desktop/dist/renderer/assets").filter((f) => f.endsWith(".css") && fs.readFileSync("apps/desktop/dist/renderer/assets/" + f, "utf8").includes("url(data:"));
console.log(`trace css ${trace.size}, shared with main ${shared.length}, data urls ${dataUrls.length}`);
process.exit(shared.length === 0 && dataUrls.length === 0 && trace.size > 0 ? 0 : 1);
'
```

Expected: `trace css 1, shared with main 0, data urls 0` (the trace stylesheet count may be 2 if Vite splits CSS; `shared with main` and `data urls` must be `0`), exit 0.

- [ ] **Step 10: Run the root checks**

Run, in order: `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r --no-bail --workspace-concurrency=1 test`, `pnpm lint`
Expected: each exits 0.

- [ ] **Step 11: Commit**

```bash
git add apps/desktop/src/shared/api.ts apps/desktop/src/shared/api.test.ts apps/desktop/src/renderer/trace.html apps/desktop/src/renderer/trace/main.tsx apps/desktop/src/renderer/trace/ipc-source.ts apps/desktop/src/renderer/trace/ipc-source.test.ts apps/desktop/src/renderer/trace/host.ts apps/desktop/src/renderer/trace/host.test.ts apps/desktop/vite.config.ts
git commit -m "feat(desktop): mount the trace viewer in trace.html over trace IPC"
```

---

### Task D-4: "Trace" button beside Inspect

**Files:**
- Modify: `apps/desktop/src/renderer/components/Header.tsx`
- Modify: `apps/desktop/src/renderer/App.tsx`

**Interfaces:**
- Consumes: D-3 `JevcodeApi.trace.open(sessionId: string): Promise<void>`; existing `SessionStatePayload.sessionId`.
- Produces: `HeaderProps.onOpenTrace: () => void`. The button is disabled without an active session and never calls `session.switchTo` (whose handler runs `reloadPending`, ipc.ts).

The desktop package has no DOM test environment (vitest `include: ["src/**/*.test.ts"]`, no jsdom), and adding one is a dependency change this lane may not make. The typecheck, the built bundle and D-8's human check verify this task.

- [ ] **Step 1: Add the prop and the button**

In `apps/desktop/src/renderer/components/Header.tsx`, find:

```ts
  onToggleDebug: () => void;
  onCloseRepo: () => void;
}
```

Replace with:

```ts
  onToggleDebug: () => void;
  onCloseRepo: () => void;
  /** Opens the active session's trace window (trace:open). Never switches sessions. */
  onOpenTrace: () => void;
}
```

Find:

```tsx
          onClick={props.onToggleDebug}
        >
          Inspect
        </button>
```

Replace with:

```tsx
          onClick={props.onToggleDebug}
        >
          Inspect
        </button>
        <button
          type="button"
          onClick={props.onOpenTrace}
          disabled={!sessionState}
          title={
            sessionState
              ? "Open this session's trace in a new window"
              : "Open a session to see its trace"
          }
        >
          Trace
        </button>
```

- [ ] **Step 2: Wire it in `App.tsx`**

In `apps/desktop/src/renderer/App.tsx`, find:

```tsx
  const handleCloseRepo = useCallback(() => {
```

Replace with:

```tsx
  const handleOpenTrace = useCallback(() => {
    const sessionId = sessionState?.sessionId;
    if (!sessionId) return;
    // trace:open only opens or focuses a window; it never calls session.switchTo.
    void bridge.trace.open(sessionId).catch((error: unknown) => {
      console.warn(
        `[jevcode] could not open the trace: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }, [bridge, sessionState?.sessionId]);

  const handleCloseRepo = useCallback(() => {
```

Find:

```tsx
        onCloseRepo={handleCloseRepo}
      />
```

Replace with:

```tsx
        onCloseRepo={handleCloseRepo}
        onOpenTrace={handleOpenTrace}
      />
```

- [ ] **Step 3: Typecheck, build and check the invariants**

Run: `pnpm --filter jevcode-desktop typecheck`
Expected: exit 0.

Run: `pnpm --filter jevcode-desktop build`
Expected: exit 0.

Run: `grep -c "switchTo" apps/desktop/src/renderer/components/Header.tsx`
Expected: `0`

Run: `grep -c "bridge.trace.open(sessionId)" apps/desktop/src/renderer/App.tsx`
Expected: `1`

- [ ] **Step 4: Run the root checks**

Run, in order: `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r --no-bail --workspace-concurrency=1 test`, `pnpm lint`
Expected: each exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/components/Header.tsx apps/desktop/src/renderer/App.tsx
git commit -m "feat(desktop): add a Trace button beside Inspect"
```

---

### Task D-5: Composer prefill in WorkspaceHost

**Files:**
- Create: `apps/desktop/src/renderer/components/composer-prefill.ts`
- Test: `apps/desktop/src/renderer/components/composer-prefill.test.ts`
- Modify: `apps/desktop/src/renderer/components/WorkspaceHost.tsx`

**Interfaces:**
- Consumes: D-3 `JevcodeApi.onComposerPrefill(listener: (payload: { sessionId: string; text: string }) => void): () => void`; existing `JevcodeApi.session.switchTo(sessionId: string): Promise<void>`.
- Produces (UI index §2.6):
  ```ts
  export interface ComposerPrefill { sessionId: string; text: string }
  /** "" → text; else the draft without trailing newlines + "\n" + text. */
  export function appendPrefill(draft: string, text: string): string;
  export type PrefillDecision = { kind: "apply"; draft: string } | { kind: "notice"; sessionId: string };
  export function decidePrefill(activeSessionId: string | null, payload: { sessionId: string; text: string }, draft: string): PrefillDecision;
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/components/composer-prefill.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { appendPrefill, decidePrefill } from "./composer-prefill.js";

const NOTE = 'Re: trace s1 +0:43 "Claim contradicts tests" (seq 48; evidence seq 46)\n> all checks pass';

describe("appendPrefill", () => {
  it("uses the note as the whole draft when the composer is empty", () => {
    expect(appendPrefill("", "x")).toBe("x");
    expect(appendPrefill("\n\n", "x")).toBe("x");
  });

  it("keeps the draft and appends on a new line", () => {
    expect(appendPrefill("a\n\n", "x")).toBe("a\nx");
    expect(appendPrefill("Please also add a test", NOTE)).toBe(`Please also add a test\n${NOTE}`);
    expect(appendPrefill("  indented draft  ", "x")).toBe("  indented draft  \nx");
  });
});

describe("decidePrefill", () => {
  it("applies a note for the active session to the draft", () => {
    expect(decidePrefill("s1", { sessionId: "s1", text: NOTE }, "draft")).toEqual({
      kind: "apply",
      draft: `draft\n${NOTE}`,
    });
  });

  it("a note for another session becomes a notice and leaves the draft alone", () => {
    expect(decidePrefill("s1", { sessionId: "s2", text: NOTE }, "draft")).toEqual({
      kind: "notice",
      sessionId: "s2",
    });
    expect(decidePrefill(null, { sessionId: "s2", text: NOTE }, "")).toEqual({
      kind: "notice",
      sessionId: "s2",
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter jevcode-desktop exec vitest run src/renderer/components/composer-prefill.test.ts`
Expected: FAIL with `Cannot find module './composer-prefill.js'`.

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/renderer/components/composer-prefill.ts`:

```ts
/** A trace window's review note (composer:prefill, spec §8.5). */
export interface ComposerPrefill {
  sessionId: string;
  text: string;
}

export type PrefillDecision =
  | { kind: "apply"; draft: string }
  | { kind: "notice"; sessionId: string };

/** "" → text; else the draft without trailing newlines + "\n" + text. A draft of only newlines counts as empty. */
export function appendPrefill(draft: string, text: string): string {
  const head = draft.replace(/\n+$/, "");
  return head.length === 0 ? text : `${head}\n${text}`;
}

/**
 * The note joins the composer only when the main window shows its session.
 * Otherwise the workspace shows "Trace note for another session · Switch";
 * switching stays the user's explicit action.
 */
export function decidePrefill(
  activeSessionId: string | null,
  payload: ComposerPrefill,
  draft: string,
): PrefillDecision {
  if (activeSessionId !== null && activeSessionId === payload.sessionId) {
    return { kind: "apply", draft: appendPrefill(draft, payload.text) };
  }
  return { kind: "notice", sessionId: payload.sessionId };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter jevcode-desktop exec vitest run src/renderer/components/composer-prefill.test.ts`
Expected: PASS, `Tests  4 passed (4)`.

- [ ] **Step 5: Wire the listener, focus and notice into WorkspaceHost**

In `apps/desktop/src/renderer/components/WorkspaceHost.tsx`, make six replacements. Every new hook sits above the component's early `return` for the empty-prompt case, as React requires.

Find:

```ts
import { TaskPrompt } from "./TaskPrompt.js";
```

Replace with:

```ts
import { appendPrefill, decidePrefill } from "./composer-prefill.js";
import type { ComposerPrefill } from "./composer-prefill.js";
import { TaskPrompt } from "./TaskPrompt.js";
```

Find:

```ts
  const [instruction, setInstruction] = useState("");
  const [sending, setSending] = useState(false);
```

Replace with:

```ts
  const [instruction, setInstruction] = useState("");
  const instructionRef = useRef(instruction);
  instructionRef.current = instruction;
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const [traceNote, setTraceNote] = useState<ComposerPrefill | null>(null);
  const [sending, setSending] = useState(false);
```

Find:

```ts
    setFilter("overview");
    setInstruction("");
    setActionError(null);
  }, [sessionId]);
```

Replace with:

```ts
    setFilter("overview");
    setInstruction("");
    setActionError(null);
  }, [sessionId]);

  // Trace window "Request changes" (spec §8.5): append to the draft, keep the
  // instruction mode, focus with the caret at the end, never send.
  useEffect(() => {
    return bridge.onComposerPrefill((payload) => {
      const decision = decidePrefill(
        sessionRef.current?.sessionId ?? null,
        payload,
        instructionRef.current,
      );
      if (decision.kind === "apply") {
        setInstruction(decision.draft);
        setFocusRequest((count) => count + 1);
      } else {
        setTraceNote(payload);
      }
    });
  }, [bridge]);

  // A note held for another session applies after the user's own Switch. This
  // effect runs after the reset above, so the note lands in the new draft.
  useEffect(() => {
    if (traceNote === null || traceNote.sessionId !== sessionId) return;
    setInstruction((draft) => appendPrefill(draft, traceNote.text));
    setTraceNote(null);
    setFocusRequest((count) => count + 1);
  }, [sessionId, traceNote]);

  useEffect(() => {
    if (focusRequest === 0) return;
    const composer = composerRef.current;
    if (composer === null || composer.disabled) return;
    composer.focus();
    const end = composer.value.length;
    composer.setSelectionRange(end, end);
    composer.scrollTop = composer.scrollHeight;
  }, [focusRequest]);
```

Find:

```ts
  const toggleAgent = async () => {
```

Replace with:

```ts
  const switchToTraceNote = () => {
    const note = traceNote;
    if (note === null) return;
    setActionError(null);
    void bridge.session.switchTo(note.sessionId).catch((error: unknown) => {
      setActionError(error instanceof Error ? error.message : String(error));
    });
  };

  const toggleAgent = async () => {
```

Find:

```tsx
        <div className="session-composer">
          <textarea
            aria-label="Guide the agent"
```

Replace with:

```tsx
        <div className="session-composer">
          {traceNote !== null ? (
            <p className="composer-hint" role="status">
              Trace note for another session ·{" "}
              <button type="button" onClick={switchToTraceNote}>
                Switch
              </button>{" "}
              <button type="button" onClick={() => setTraceNote(null)}>
                Dismiss
              </button>
            </p>
          ) : null}
          <textarea
            ref={composerRef}
            aria-label="Guide the agent"
```

(The listener effect is registered once per `bridge`; it reads the active session and draft through `sessionRef` and `instructionRef`, so it never holds a stale session. `sendInstruction` is untouched: the note is sent only when the user presses Steer, Queue or Continue.)

- [ ] **Step 6: Typecheck, build and check the invariants**

Run: `pnpm --filter jevcode-desktop typecheck`
Expected: exit 0.

Run: `pnpm --filter jevcode-desktop build`
Expected: exit 0.

Run: `grep -n "onComposerPrefill" apps/desktop/src/renderer/components/WorkspaceHost.tsx`
Expected: one line, inside a `useEffect` above `if (props.activePrompt.trim().length === 0)`.

Run: `awk '/onComposerPrefill/,/\}, \[bridge\]\);/' apps/desktop/src/renderer/components/WorkspaceHost.tsx | grep -c "sendInstruction\|agent\.\|setInstructionMode"`
Expected: `0` (the listener never sends and never changes the mode).

- [ ] **Step 7: Run the root checks**

Run, in order: `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r --no-bail --workspace-concurrency=1 test`, `pnpm lint`
Expected: each exits 0.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/renderer/components/composer-prefill.ts apps/desktop/src/renderer/components/composer-prefill.test.ts apps/desktop/src/renderer/components/WorkspaceHost.tsx
git commit -m "feat(desktop): prefill the composer from a trace review note"
```

---

### Task D-6: Extended `runSmoke` for the trace window; zod jitless in ui-catalog

**Files:**
- Create: `apps/desktop/src/main/smoke.ts`
- Test: `apps/desktop/src/main/smoke.test.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Create: `packages/ui-catalog/src/zod-jitless.ts`
- Test: `packages/ui-catalog/src/zod-jitless.test.ts`
- Modify: `packages/ui-catalog/src/catalog.ts` (first line only)

**Interfaces:**
- Consumes: D-1 `TraceWindowRegistry.openTraceWindow`; D-2 `traceService` and `windows` in `index.ts`; D-3 console lines `TRACE_READY <rows>`, `TRACE_LOADED <ms>`, `TRACE_PERF <name> <ms>`, `CSP_VIOLATION …`; A2-2 `TraceService.listSessions({ limit: 1 })` (newest first, spec §5.2 `ORDER BY startedAt DESC, id`).
- Produces:
  ```ts
  export interface SmokeWebContents {
    on(event: "console-message", listener: (event: unknown, level: number, message: string) => void): unknown;
    on(event: "did-fail-load", listener: (event: unknown, errorCode: number, errorDescription: string) => void): unknown;
    on(event: "render-process-gone", listener: (event: unknown, details: { reason: string }) => void): unknown;
  }
  export interface SmokeMainWebContents extends SmokeWebContents { once(event: "did-finish-load", listener: () => void): unknown }
  export interface SmokeDeps {
    mainWindow: { webContents: SmokeMainWebContents };
    env: Readonly<Record<string, string | undefined>>;
    newestSessionId(): string | null;
    openTraceWindow(sessionId: string): { webContents: SmokeWebContents };
    now(): number;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
    log(line: string): void;
    error(line: string): void;
    succeed(): void;
    fail(): void;
  }
  export const SMOKE_MAIN_TIMEOUT_MS = 15_000;
  export const SMOKE_TRACE_TIMEOUT_MS = 30_000;
  export const SMOKE_SETTLE_MS = 500;
  export function isConsoleFailure(level: number, message: string): boolean;
  export type TraceLine = { kind: "ready"; rows: number } | { kind: "loaded" } | { kind: "perf"; name: string; ms: number };
  export function parseTraceLine(message: string): TraceLine | null;
  export function forwardTracePerf(window: { webContents: SmokeWebContents }, log: (line: string) => void): void;
  export function runSmoke(deps: SmokeDeps): void;
  // Output: SMOKE_OK; SMOKE_TRACE session=<id> rows=<n> first_paint_ms=<ms> full_load_ms=<ms>; SMOKE_FAIL: <reason>
  ```
  Environment: `JEVCODE_SMOKE=1` (existing), `JEVCODE_SMOKE_TRACE=1` with `JEVCODE_DB=<replay or soak db>` (trace phase), `JEVCODE_TRACE_PERF=1` (print trace windows' `TRACE_PERF` lines).

- [ ] **Step 1: Write the failing smoke test**

Create `apps/desktop/src/main/smoke.test.ts`:

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SMOKE_MAIN_TIMEOUT_MS,
  SMOKE_SETTLE_MS,
  SMOKE_TRACE_TIMEOUT_MS,
  forwardTracePerf,
  isConsoleFailure,
  parseTraceLine,
  runSmoke,
} from "./smoke.js";
import type { SmokeDeps } from "./smoke.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'";
const EVAL_VIOLATION =
  "Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive: \"script-src 'self'\".";

type Listener = (...args: unknown[]) => void;

class FakeWebContents {
  private readonly listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  once(event: string, listener: Listener): this {
    const wrapped: Listener = (...args) => {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((entry) => entry !== wrapped),
      );
      listener(...args);
    };
    return this.on(event, wrapped);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  console(level: number, message: string): void {
    this.emit("console-message", {}, level, message, 1, "file:///app/trace.js");
  }
}

class FakeScheduler {
  private time = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  readonly now = (): number => this.time;

  readonly setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { at: this.time + ms, fn });
    return id;
  };

  readonly clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  advance(ms: number): void {
    const until = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.time = due[1].at;
      due[1].fn();
    }
    this.time = until;
  }
}

function harness(env: Record<string, string | undefined>, newest: string | null = "sess_new") {
  const scheduler = new FakeScheduler();
  const main = new FakeWebContents();
  const trace = new FakeWebContents();
  const out: string[] = [];
  const err: string[] = [];
  const opened: string[] = [];
  const result = { succeeded: 0, failed: 0 };
  const deps: SmokeDeps = {
    mainWindow: { webContents: main },
    env,
    newestSessionId: () => newest,
    openTraceWindow: (sessionId) => {
      opened.push(sessionId);
      return { webContents: trace };
    },
    now: scheduler.now,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    log: (line) => out.push(line),
    error: (line) => err.push(line),
    succeed: () => {
      result.succeeded += 1;
    },
    fail: () => {
      result.failed += 1;
    },
  };
  runSmoke(deps);
  return { scheduler, main, trace, out, err, opened, result };
}

const TRACE_ENV = { JEVCODE_SMOKE_TRACE: "1", JEVCODE_DB: "/tmp/replay.db" };

describe("runSmoke, main phase", () => {
  it("passes when the main window loads and the trace phase is off", () => {
    const run = harness({});
    run.main.emit("did-finish-load");
    expect(run.out).toEqual(["SMOKE_OK"]);
    expect(run.result).toEqual({ succeeded: 1, failed: 0 });
    expect(run.opened).toEqual([]);
  });

  it("fails on a CSP violation in the main window", () => {
    const run = harness({});
    run.main.console(3, EVAL_VIOLATION);
    run.main.emit("did-finish-load");
    expect(run.err).toHaveLength(1);
    expect(run.err[0]).toMatch(/^SMOKE_FAIL: console error in main window: Refused to evaluate/);
    expect(run.result).toEqual({ succeeded: 0, failed: 1 });
  });

  it("times out when the main window never loads", () => {
    const run = harness({});
    run.scheduler.advance(SMOKE_MAIN_TIMEOUT_MS);
    expect(run.err).toEqual(["SMOKE_FAIL: renderer did not finish loading within 15s"]);
    expect(run.result.failed).toBe(1);
  });

  it("JEVCODE_SMOKE_TRACE=1 without JEVCODE_DB fails instead of skipping", () => {
    const run = harness({ JEVCODE_SMOKE_TRACE: "1" });
    run.main.emit("did-finish-load");
    expect(run.err[0]).toMatch(/^SMOKE_FAIL: JEVCODE_SMOKE_TRACE=1 needs JEVCODE_DB/);
    expect(run.opened).toEqual([]);
  });

  it("fails when the database holds no session", () => {
    const run = harness(TRACE_ENV, null);
    run.main.emit("did-finish-load");
    expect(run.err).toEqual(["SMOKE_FAIL: no session in /tmp/replay.db"]);
  });
});

describe("runSmoke, trace phase", () => {
  it("opens the newest session and passes on TRACE_READY then TRACE_LOADED", () => {
    const run = harness(TRACE_ENV);
    run.main.emit("did-finish-load");
    expect(run.opened).toEqual(["sess_new"]);
    run.scheduler.advance(120);
    run.trace.console(1, "TRACE_READY 48");
    run.scheduler.advance(300);
    run.trace.console(1, "TRACE_LOADED 402");
    expect(run.result.succeeded).toBe(0);
    run.scheduler.advance(SMOKE_SETTLE_MS);
    expect(run.out).toEqual([
      "SMOKE_TRACE session=sess_new rows=48 first_paint_ms=120 full_load_ms=420",
      "SMOKE_OK",
    ]);
    expect(run.result).toEqual({ succeeded: 1, failed: 0 });
  });

  it("fails on a console error in the trace window", () => {
    const run = harness(TRACE_ENV);
    run.main.emit("did-finish-load");
    run.trace.console(3, "Uncaught TypeError: Cannot read properties of undefined");
    expect(run.err[0]).toMatch(/^SMOKE_FAIL: console error in trace window: Uncaught TypeError/);
    expect(run.result.failed).toBe(1);
  });

  it("a late CSP violation during the settle window still fails", () => {
    const run = harness(TRACE_ENV);
    run.main.emit("did-finish-load");
    run.trace.console(1, "TRACE_READY 48");
    run.trace.console(1, "TRACE_LOADED 402");
    run.trace.console(3, "CSP_VIOLATION img-src data:");
    run.scheduler.advance(SMOKE_SETTLE_MS);
    expect(run.err[0]).toMatch(/^SMOKE_FAIL: console error in trace window: CSP_VIOLATION/);
    expect(run.result).toEqual({ succeeded: 0, failed: 1 });
  });

  it("fails when the trace window never reports TRACE_LOADED", () => {
    const run = harness(TRACE_ENV);
    run.main.emit("did-finish-load");
    run.trace.console(1, "TRACE_READY 48");
    run.scheduler.advance(SMOKE_TRACE_TIMEOUT_MS);
    expect(run.err).toEqual(["SMOKE_FAIL: trace window did not report TRACE_LOADED within 30s"]);
  });

  it("fails when TRACE_LOADED arrives before TRACE_READY", () => {
    const run = harness(TRACE_ENV);
    run.main.emit("did-finish-load");
    run.trace.console(1, "TRACE_LOADED 402");
    expect(run.err).toEqual(["SMOKE_FAIL: TRACE_LOADED arrived before TRACE_READY"]);
  });

  it("fails when the trace renderer is gone or the page fails to load", () => {
    const gone = harness(TRACE_ENV);
    gone.main.emit("did-finish-load");
    gone.trace.emit("render-process-gone", {}, { reason: "crashed" });
    expect(gone.err).toEqual(["SMOKE_FAIL: trace renderer gone (crashed)"]);
    const missing = harness(TRACE_ENV);
    missing.main.emit("did-finish-load");
    missing.trace.emit("did-fail-load", {}, -6, "ERR_FILE_NOT_FOUND");
    expect(missing.err).toEqual(["SMOKE_FAIL: trace window failed to load (-6 ERR_FILE_NOT_FOUND)"]);
  });
});

describe("smoke helpers", () => {
  it("counts errors and CSP reports, not warnings", () => {
    expect(isConsoleFailure(3, "anything")).toBe(true);
    expect(isConsoleFailure(2, "Download the React DevTools for a better development experience")).toBe(false);
    expect(isConsoleFailure(1, "CSP_VIOLATION script-src blob:")).toBe(true);
    expect(isConsoleFailure(2, "[Report Only] Refused to load … Content Security Policy directive")).toBe(true);
  });

  it("parses the trace window's console lines", () => {
    expect(parseTraceLine("TRACE_READY 48")).toEqual({ kind: "ready", rows: 48 });
    expect(parseTraceLine("TRACE_LOADED 402")).toEqual({ kind: "loaded" });
    expect(parseTraceLine("TRACE_PERF tv:live-tick 3.46")).toEqual({ kind: "perf", name: "tv:live-tick", ms: 3.46 });
    expect(parseTraceLine("TRACE_READY")).toBeNull();
    expect(parseTraceLine("[pipeline] TRACE_READY 1")).toBeNull();
  });

  it("forwardTracePerf prints only TRACE_PERF lines", () => {
    const contents = new FakeWebContents();
    const lines: string[] = [];
    forwardTracePerf({ webContents: contents }, (line) => lines.push(line));
    contents.console(1, "TRACE_READY 48");
    contents.console(1, "TRACE_PERF tv:live-tick 3.46");
    expect(lines).toEqual(["TRACE_PERF tv:live-tick 3.46"]);
  });
});

describe("trace.html", () => {
  it("carries index.html's CSP and loads only its own entry", () => {
    const cspOf = (html: string): string | undefined =>
      /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1];
    const index = readFileSync(path.join(dirname, "../renderer/index.html"), "utf8");
    const trace = readFileSync(path.join(dirname, "../renderer/trace.html"), "utf8");
    expect(cspOf(index)).toBe(CSP);
    expect(cspOf(trace)).toBe(CSP);
    expect(trace).toContain('<script type="module" src="./trace/main.tsx"></script>');
    const entry = readFileSync(path.join(dirname, "../renderer/trace/main.tsx"), "utf8");
    expect(entry).not.toMatch(/styles\.css/);
    expect(entry).not.toMatch(/dangerouslySetInnerHTML/);
  });
});
```

- [ ] **Step 2: Write the failing ui-catalog probe test**

Create `packages/ui-catalog/src/zod-jitless.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";

const RealFunction = globalThis.Function;

afterEach(() => {
  globalThis.Function = RealFunction;
});

describe("zod jitless mode", () => {
  it("loading ui-catalog never probes new Function (CSP script-src 'self')", async () => {
    const probes: unknown[][] = [];
    globalThis.Function = new Proxy(RealFunction, {
      construct(target, args, newTarget) {
        probes.push(args);
        return Reflect.construct(target, args, newTarget) as object;
      },
    });
    const catalog = await import("./index.js");
    expect(catalog.jevcodeCatalog).toBeDefined();
    // zod 4 probes eval support with `new Function("")` (zod/v4/core/util.js allowsEval).
    expect(probes.filter((args) => args.length === 1 && args[0] === "")).toEqual([]);
  });
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `pnpm --filter jevcode-desktop exec vitest run src/main/smoke.test.ts`
Expected: FAIL with `Cannot find module './smoke.js'`.

Run: `pnpm --filter @jevcode/ui-catalog exec vitest run src/zod-jitless.test.ts`
Expected: FAIL; the diff shows `+ [ [ "" ] ]` against `- []` (the probe ran while `@json-render/core` built its schemas).

- [ ] **Step 4: Write `smoke.ts`**

Create `apps/desktop/src/main/smoke.ts`:

```ts
/**
 * JEVCODE_SMOKE=1 boot check (docs/demo.md). Main phase: the main window
 * loads. Trace phase (JEVCODE_SMOKE_TRACE=1 with JEVCODE_DB): the newest
 * session opens in a trace window, which must log TRACE_READY and then
 * TRACE_LOADED. A console error or CSP violation in either window fails the
 * run (spec §8.7). Electron is reached only through SmokeDeps, so vitest
 * drives every path with fakes.
 */

export interface SmokeWebContents {
  on(
    event: "console-message",
    listener: (event: unknown, level: number, message: string) => void,
  ): unknown;
  on(
    event: "did-fail-load",
    listener: (event: unknown, errorCode: number, errorDescription: string) => void,
  ): unknown;
  on(
    event: "render-process-gone",
    listener: (event: unknown, details: { reason: string }) => void,
  ): unknown;
}

export interface SmokeMainWebContents extends SmokeWebContents {
  once(event: "did-finish-load", listener: () => void): unknown;
}

export interface SmokeDeps {
  mainWindow: { webContents: SmokeMainWebContents };
  env: Readonly<Record<string, string | undefined>>;
  /** traceService.listSessions({ limit: 1 })[0]?.sessionId: newest first. */
  newestSessionId(): string | null;
  openTraceWindow(sessionId: string): { webContents: SmokeWebContents };
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  log(line: string): void;
  error(line: string): void;
  /** app.quit() */
  succeed(): void;
  /** app.exit(1) */
  fail(): void;
}

export const SMOKE_MAIN_TIMEOUT_MS = 15_000;
export const SMOKE_TRACE_TIMEOUT_MS = 30_000;
/** Errors that arrive just after the last page (a late chunk, a CSP report) still fail the run. */
export const SMOKE_SETTLE_MS = 500;

const CONSOLE_ERROR_LEVEL = 3;
const CSP_PATTERN = /Content[- ]Security[- ]Policy|CSP_VIOLATION/i;

/** Electron 33 console levels: 0 verbose, 1 info, 2 warning, 3 error. */
export function isConsoleFailure(level: number, message: string): boolean {
  return level >= CONSOLE_ERROR_LEVEL || CSP_PATTERN.test(message);
}

export type TraceLine =
  | { kind: "ready"; rows: number }
  | { kind: "loaded" }
  | { kind: "perf"; name: string; ms: number };

export function parseTraceLine(message: string): TraceLine | null {
  const ready = /^TRACE_READY (\d+)$/.exec(message);
  if (ready !== null) return { kind: "ready", rows: Number(ready[1]) };
  if (/^TRACE_LOADED \d+$/.test(message)) return { kind: "loaded" };
  const perf = /^TRACE_PERF (\S+) (\d+(?:\.\d+)?)$/.exec(message);
  if (perf !== null) return { kind: "perf", name: perf[1] ?? "", ms: Number(perf[2]) };
  return null;
}

/** JEVCODE_TRACE_PERF=1: print a trace window's TRACE_PERF lines to the main-process log (docs/perf.md). */
export function forwardTracePerf(
  window: { webContents: SmokeWebContents },
  log: (line: string) => void,
): void {
  window.webContents.on("console-message", (_event, _level, message) => {
    if (parseTraceLine(message)?.kind === "perf") log(message);
  });
}

export function runSmoke(deps: SmokeDeps): void {
  let finished = false;
  let timer: unknown = null;

  function schedule(ms: number, fn: () => void): void {
    if (timer !== null) deps.clearTimeout(timer);
    timer = deps.setTimeout(fn, ms);
  }

  function finish(): void {
    finished = true;
    if (timer !== null) {
      deps.clearTimeout(timer);
      timer = null;
    }
  }

  function fail(reason: string): void {
    if (finished) return;
    finish();
    deps.error(`SMOKE_FAIL: ${reason}`);
    deps.fail();
  }

  function succeed(): void {
    if (finished) return;
    finish();
    deps.log("SMOKE_OK");
    deps.succeed();
  }

  function watch(window: { webContents: SmokeWebContents }, name: "main" | "trace"): void {
    window.webContents.on("console-message", (_event, level, message) => {
      if (isConsoleFailure(level, message)) fail(`console error in ${name} window: ${message}`);
    });
    window.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
      fail(`${name} window failed to load (${errorCode} ${errorDescription})`);
    });
    window.webContents.on("render-process-gone", (_event, details) => {
      fail(`${name} renderer gone (${details.reason})`);
    });
  }

  function startTracePhase(dbPath: string): void {
    const sessionId = deps.newestSessionId();
    if (sessionId === null) {
      fail(`no session in ${dbPath}`);
      return;
    }
    const openedAt = deps.now();
    let firstPaintMs: number | null = null;
    let rows = 0;
    schedule(SMOKE_TRACE_TIMEOUT_MS, () => {
      fail("trace window did not report TRACE_LOADED within 30s");
    });
    const window = deps.openTraceWindow(sessionId);
    watch(window, "trace");
    window.webContents.on("console-message", (_event, _level, message) => {
      if (finished) return;
      const line = parseTraceLine(message);
      if (line === null || line.kind === "perf") return;
      if (line.kind === "ready") {
        if (firstPaintMs === null) {
          firstPaintMs = deps.now() - openedAt;
          rows = line.rows;
        }
        return;
      }
      if (firstPaintMs === null) {
        fail("TRACE_LOADED arrived before TRACE_READY");
        return;
      }
      const fullLoadMs = deps.now() - openedAt;
      deps.log(
        `SMOKE_TRACE session=${sessionId} rows=${rows} first_paint_ms=${Math.round(firstPaintMs)} full_load_ms=${Math.round(fullLoadMs)}`,
      );
      schedule(SMOKE_SETTLE_MS, succeed);
    });
  }

  const traceRequested = deps.env["JEVCODE_SMOKE_TRACE"] === "1";
  const dbPath = deps.env["JEVCODE_DB"] ?? "";

  watch(deps.mainWindow, "main");
  schedule(SMOKE_MAIN_TIMEOUT_MS, () => {
    fail("renderer did not finish loading within 15s");
  });
  deps.mainWindow.webContents.once("did-finish-load", () => {
    if (finished) return;
    if (!traceRequested) {
      succeed();
      return;
    }
    if (dbPath.length === 0) {
      fail("JEVCODE_SMOKE_TRACE=1 needs JEVCODE_DB (a replay or soak database)");
      return;
    }
    startTracePhase(dbPath);
  });
}
```

- [ ] **Step 5: Write the zod jitless module and import it first**

Create `packages/ui-catalog/src/zod-jitless.ts`:

```ts
import { config } from "zod";

// zod 4 compiles object parsers with `new Function` and probes for it when an
// object schema is constructed (zod/v4/core/schemas.js:901-903). Under the
// renderer CSP `script-src 'self'` Chromium logs that probe as a CSP violation
// even though zod catches it, and the extended smoke fails on it (spec §8.7).
// catalog.ts imports this module first, so jitless mode is set before
// @json-render/core builds its module-level schemas.
config({ jitless: true });
```

In `packages/ui-catalog/src/catalog.ts`, find:

```ts
import { defineCatalog, defineSchema } from "@json-render/core";
```

Replace with:

```ts
import "./zod-jitless.js";
import { defineCatalog, defineSchema } from "@json-render/core";
```

- [ ] **Step 6: Run both tests to verify they pass**

Run: `pnpm --filter jevcode-desktop exec vitest run src/main/smoke.test.ts`
Expected: PASS, `Tests  15 passed (15)`.

Run: `pnpm --filter @jevcode/ui-catalog test`
Expected: PASS, every ui-catalog test including `zod-jitless.test.ts` (jitless mode changes only how zod parses, not what it accepts).

- [ ] **Step 7: Use `smoke.ts` from `index.ts`**

In `apps/desktop/src/main/index.ts`, make five replacements.

Find:

```ts
import { createTraceWindowRegistry, sharedWebPreferences } from "./trace-window.js";
```

Replace with:

```ts
import { forwardTracePerf, runSmoke } from "./smoke.js";
import { createTraceWindowRegistry, sharedWebPreferences } from "./trace-window.js";
```

Find:

```ts
const SMOKE = process.env["JEVCODE_SMOKE"] === "1";
```

Replace with:

```ts
const SMOKE = process.env["JEVCODE_SMOKE"] === "1";
/** Prints trace windows' TRACE_PERF lines (docs/perf.md live-tick samples). */
const TRACE_PERF = process.env["JEVCODE_TRACE_PERF"] === "1";
```

Find and delete the old function (keep the blank line before `app.whenReady()`):

```ts
function runSmoke(window: BrowserWindow): void {
  const timeout = setTimeout(() => {
    console.error("SMOKE_FAIL: renderer did not finish loading within 15s");
    app.exit(1);
  }, 15_000);
  window.webContents.once("did-finish-load", () => {
    clearTimeout(timeout);
    console.log("SMOKE_OK");
    app.quit();
  });
}

```

Find:

```ts
    create: (options) => new BrowserWindow(options),
```

Replace with:

```ts
    create: (options) => {
      const window = new BrowserWindow(options);
      if (TRACE_PERF) forwardTracePerf(window, (line) => console.log(line));
      return window;
    },
```

Find:

```ts
  if (SMOKE) {
    runSmoke(mainWindow);
  }
```

Replace with:

```ts
  if (SMOKE) {
    runSmoke({
      mainWindow,
      env: process.env,
      newestSessionId: () => traceService.listSessions({ limit: 1 })[0]?.sessionId ?? null,
      openTraceWindow: (sessionId) => windows.openTraceWindow(sessionId),
      now: () => performance.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      log: (line) => console.log(line),
      error: (line) => console.error(line),
      succeed: () => app.quit(),
      fail: () => app.exit(1),
    });
  }
```

- [ ] **Step 8: Typecheck and build**

Run: `pnpm --filter "...@jevcode/ui-catalog" build`
Expected: exit 0 (rebuilds ui-catalog, the viewer and the desktop).

Run: `pnpm --filter jevcode-desktop typecheck`
Expected: exit 0.

- [ ] **Step 9: Run the extended smoke against an oauth replay**

From `~/Projects/jevcode-tv-db` (absolute fixture path; `replay` runs on the Node ABI, `start` on the Electron ABI):

```bash
rm -rf "${TMPDIR:-/tmp}/jevcode-d6-oauth"
pnpm --filter jevcode-desktop replay ~/Projects/jevcode-tv-db/fixtures/oauth "${TMPDIR:-/tmp}/jevcode-d6-oauth"
cp "${TMPDIR:-/tmp}/jevcode-d6-oauth/replay.db" "${TMPDIR:-/tmp}/jevcode-d6-run.db"
pnpm --filter jevcode-desktop run rebuild
JEVCODE_SMOKE=1 JEVCODE_SMOKE_TRACE=1 JEVCODE_DB="${TMPDIR:-/tmp}/jevcode-d6-run.db" pnpm --filter jevcode-desktop start 2>&1 | grep -E "SMOKE_(OK|TRACE|FAIL)"
JEVCODE_SMOKE=1 JEVCODE_DB="${TMPDIR:-/tmp}/jevcode-d6-run.db" pnpm --filter jevcode-desktop start 2>&1 | grep -E "SMOKE_(OK|FAIL)"
pnpm --filter jevcode-desktop rebuild:node
```

Expected: the first `start` prints `SMOKE_TRACE session=<id> rows=<n> first_paint_ms=<ms> full_load_ms=<ms>` with `rows` above 0, then `SMOKE_OK`; the second prints `SMOKE_OK`; the last command prints `native modules restored to node ABI`. A `SMOKE_FAIL: console error in main window: Refused to evaluate…` means the zod probe still runs: check that `import "./zod-jitless.js";` is the first line of `catalog.ts` and that `packages/ui-catalog/dist/catalog.js` starts with it.

- [ ] **Step 10: Run the root checks**

Run, in order: `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r --no-bail --workspace-concurrency=1 test`, `pnpm lint`
Expected: each exits 0.

- [ ] **Step 11: Commit**

```bash
git add apps/desktop/src/main/smoke.ts apps/desktop/src/main/smoke.test.ts apps/desktop/src/main/index.ts packages/ui-catalog/src/zod-jitless.ts packages/ui-catalog/src/zod-jitless.test.ts packages/ui-catalog/src/catalog.ts
git commit -m "feat(desktop): smoke the trace window and fail on console or CSP errors"
```

---

### Task D-7: `trace-parity.test.ts`: IPC source and bundle fold to the same `TraceSession`

**Files:**
- Test: `apps/desktop/src/main/trace-parity.test.ts`

**Interfaces:**
- Consumes:
  - A2-5: `runReplay(fixtureDir: string, outDir: string, log?): Promise<ReplayResult>` with `ReplayResult.sessionId` and `ReplayResult.bundlePath` (`<outDir>/trace.json`); the replay DB at `<outDir>/replay.db`; `redactBundleValue(value: unknown, homeDir: string): { value: unknown; count: number }` (the bundle's redaction: `buildTraceBundle` applies it to the restamped session summary and to every row `payload`, never to the envelope).
  - A2-1/A2-2: `openTraceReader(dbPath): TraceReader` from `@jevcode/storage`; `createTraceService(reader): TraceService`.
  - D-3: `createIpcTraceSource(bridge: JevcodeApi["trace"], sessionId: string): TraceSource`.
  - C1-15 (`@jevcode/trace-viewer/sources`): `parseTraceBundle(json: unknown): ParsedBundle`, `createStaticBundleSource(bundle, options?)`, `readAllTraceRows(source, options?: { pageSize?: number }): Promise<LoadedTrace>` with `LoadedTrace { summary; rows; lastPage }`.
  - B (`@jevcode/trace-viewer/model`): `foldRows(meta: TraceSessionSummary, rows: readonly TraceRow[], options: { live: boolean; state?: AgentState; throughSeq?: number }): TraceSession`; `TraceSession.steps`, `TraceSession.findings[].ruleId`.
- Produces: the M5 parity gate (spec §8.7, §11 M5). Imports from the viewer come only from `/sources` and `/model` (the root barrel loads React and CSS Modules, which Node cannot import).

- [ ] **Step 1: Write the test**

Create `apps/desktop/src/main/trace-parity.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { TraceRow, TraceRowsPage, TraceSessionSummary } from "@jevcode/contracts";
import { openTraceReader } from "@jevcode/storage";
import { foldRows } from "@jevcode/trace-viewer/model";
import type { TraceSession } from "@jevcode/trace-viewer/model";
import {
  createStaticBundleSource,
  parseTraceBundle,
  readAllTraceRows,
} from "@jevcode/trace-viewer/sources";
import type { LoadedTrace } from "@jevcode/trace-viewer/sources";
import { afterEach, describe, expect, it } from "vitest";

import { createIpcTraceSource } from "../renderer/trace/ipc-source.js";
import type { JevcodeApi } from "../shared/api.js";
import { parseToMain } from "../shared/ipc-registry.js";
import { runReplay } from "./replay/cli-entry.js";
import { redactBundleValue } from "./trace-bundle.js";
import { createTraceService } from "./trace-service.js";
import type { TraceService } from "./trace-service.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../");
const FIXTURES = ["api-break", "dep-change", "oauth", "rate-limit", "schema-change"] as const;
/** Small pages force many trace:rows round trips through cursorAfter. */
const IPC_PAGE_SIZE = 7;
/** Spec §6.7: claim_contradicted is the top finding on these two fixtures. */
const CLAIM_FIXTURES = new Set(["oauth", "api-break"]);

const tempDirs: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  while (closers.length > 0) closers.pop()?.();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jevcode-trace-parity-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * The trace window's view of main: requests pass the toMain zod schemas (as the
 * ipc.ts handle wrapper does), replies are structured-cloned (as IPC does), and
 * the session summary and every row payload pass the bundle's redaction, so both
 * folds see identical strings (spec §8.7).
 */
function bridgeOver(
  service: TraceService,
  homeDir: string,
): { bridge: JevcodeApi["trace"]; redactions: () => number } {
  let redactions = 0;
  const redact = <T>(value: T): T => {
    const result = redactBundleValue(value, homeDir);
    redactions += result.count;
    return result.value as T;
  };
  const redactRow = (row: TraceRow): TraceRow =>
    "payload" in row ? { ...row, payload: redact(row.payload) } : row;
  return {
    bridge: {
      listSessions: async (request = {}) =>
        structuredClone(
          service
            .listSessions(parseToMain("trace:listSessions", request))
            .map((summary): TraceSessionSummary => redact(summary)),
        ),
      rows: async (request) => {
        const page: TraceRowsPage = service.rows(parseToMain("trace:rows", request));
        return structuredClone({ ...page, rows: page.rows.map(redactRow) });
      },
      payloads: async (request) =>
        structuredClone(
          service
            .payloads(parseToMain("trace:payloads", { sessionId: request.sessionId, seqs: [...request.seqs] }))
            .map(redactRow),
        ),
      open: async () => {
        throw new Error("trace:open is a main-window channel");
      },
      requestChanges: async () => {
        throw new Error("the parity test never hands off a note");
      },
    },
    redactions: () => redactions,
  };
}

/** The DataController's final fold for a finished read (UI index §2.4). */
function foldLoaded(loaded: LoadedTrace): TraceSession {
  const page = loaded.lastPage;
  return foldRows(loaded.summary, loaded.rows, {
    live: false,
    state: page.state,
    throughSeq: page.nextAfterSeq ?? page.lastSeq,
  });
}

describe("trace parity: IPC source versus exported trace.json", () => {
  for (const fixture of FIXTURES) {
    it(
      `${fixture}: both paths fold to the same TraceSession`,
      async () => {
        const outDir = tempDir();
        const result = await runReplay(path.join(repoRoot, "fixtures", fixture), outDir);

        const reader = openTraceReader(path.join(outDir, "replay.db"));
        closers.push(() => reader.close());
        const { bridge, redactions } = bridgeOver(createTraceService(reader), os.homedir());
        const viaIpc = await readAllTraceRows(createIpcTraceSource(bridge, result.sessionId), {
          pageSize: IPC_PAGE_SIZE,
        });

        const parsed = parseTraceBundle(JSON.parse(readFileSync(result.bundlePath, "utf8")));
        if (!parsed.ok) throw new Error(`${fixture}: ${parsed.message}`);
        const viaBundle = await readAllTraceRows(createStaticBundleSource(parsed.bundle));

        expect(viaIpc.summary).toEqual(viaBundle.summary);
        expect(viaIpc.rows.map((row) => row.seq)).toEqual(viaBundle.rows.map((row) => row.seq));
        expect(viaIpc.rows).toEqual(viaBundle.rows);
        expect(redactions()).toBe(parsed.bundle.redactionCount);

        const ipcSession = foldLoaded(viaIpc);
        expect(ipcSession.steps.length).toBeGreaterThan(0);
        expect(ipcSession).toEqual(foldLoaded(viaBundle));
        if (CLAIM_FIXTURES.has(fixture)) {
          expect(ipcSession.findings.map((finding) => finding.ruleId)).toContain("claim_contradicted");
        }
      },
      120_000,
    );
  }
});
```

- [ ] **Step 2: Run the test**

The code under test (D-3's source, A2's service and bundle, C1-15's sources, B's fold) already exists, so this regression test passes on first run; Step 3 proves it can fail.

Run: `pnpm --filter "...@jevcode/trace-viewer" build`
Expected: exit 0.

Run: `pnpm --filter jevcode-desktop exec vitest run src/main/trace-parity.test.ts`
Expected: PASS, `Tests  5 passed (5)`. If a fixture fails on `summary` or `rows`, the IPC path and the bundle disagree before any fold: report the first differing field (for example `lastEventSeq` or a `payload` string) and escalate to the owner of that field (A2 for the service and bundle, C1-15 for the static source); never loosen the assertion.

- [ ] **Step 3: Confirm the test detects a paging defect**

Temporarily break the IPC source's paging to prove the test is not vacuous. In `apps/desktop/src/renderer/trace/ipc-source.ts`, change `return await bridge.rows(query);` to:

```ts
        const page = await bridge.rows(query);
        return { ...page, rows: page.rows.slice(0, -1) };
```

(every full page now loses its last row while `nextAfterSeq` still moves past it; oauth has more than 7 trace rows, so at least one page is full).

Run: `pnpm --filter jevcode-desktop exec vitest run src/main/trace-parity.test.ts -t oauth`
Expected: FAIL at `expect(viaIpc.rows.map((row) => row.seq))` (seqs missing at page boundaries).

Revert the change:

Run: `git checkout -- apps/desktop/src/renderer/trace/ipc-source.ts && git diff --stat -- apps/desktop/src/renderer/trace/ipc-source.ts`
Expected: no output from `git diff --stat` (the file matches D-3's commit).

- [ ] **Step 4: Run the root checks**

Run, in order: `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r --no-bail --workspace-concurrency=1 test`, `pnpm lint`
Expected: each exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/trace-parity.test.ts
git commit -m "test(desktop): trace parity between the IPC source and exported bundles"
```

---

### Task D-8: M5 exit: live-tick and soak-open budgets, manual live session, docs

**Files:**
- Modify: `docs/perf.md` (append a section)
- Modify: `docs/SPEC.md` (§13 table only)
- Modify: `docs/security.md` (row 8)

**Interfaces:**
- Consumes: D-6 `SMOKE_TRACE … first_paint_ms=<ms> full_load_ms=<ms>` and `JEVCODE_TRACE_PERF=1`; D-3 `TRACE_PERF tv:live-tick <ms>`; `docs/spikes/trace-viewer-spike.md` sections "M4a exit" (C2-16) and "M4b exit" (C3-12); `docs/perf.md` "Trace read" section (A2-7); Required amendments 1–3.
- Produces: the M5 exit record (spec §12 M5: "Parity, allowlist and smoke green; manual mock-adapter live session; live-tick and soak-open budgets; budgets recorded in SPEC §13 and docs/perf.md").

Measured numbers come from the commands below; write each as measured (for example `412 ms (median of 5)`), never rounded toward the target.

- [ ] **Step 1: Measure the soak open in the trace window (automated)**

From `~/Projects/jevcode-tv-db`. The soak runs on the Node ABI; each Electron run gets a fresh copy because boot writes to the database; run 0 is the discarded warm-up.

```bash
KEEP="${TMPDIR:-/tmp}/jevcode-soak-trace.db"
RUN="${TMPDIR:-/tmp}/jevcode-soak-run.db"
rm -f "$KEEP"*
JEVCODE_SOAK_PROFILE=trace JEVCODE_SOAK_KEEP_DB="$KEEP" JEVCODE_SOAK_EXPORT="${TMPDIR:-/tmp}/jevcode-soak-trace.json" node scripts/soak.mjs | tail -1
pnpm --filter jevcode-desktop run rebuild
for i in 0 1 2 3 4 5; do
  rm -f "$RUN"*
  cp "$KEEP" "$RUN"
  JEVCODE_SMOKE=1 JEVCODE_SMOKE_TRACE=1 JEVCODE_DB="$RUN" pnpm --filter jevcode-desktop start 2>&1 | grep -E "SMOKE_(TRACE|FAIL)" | sed "s/^/run ${i}: /"
done
pnpm --filter jevcode-desktop rebuild:node
```

Expected: the soak prints its JSON line (record `traceRows` and `consumedRows` from it); six `run <i>: SMOKE_TRACE …` lines and no `SMOKE_FAIL`. Take the medians of `first_paint_ms` and `full_load_ms` over runs 1–5. Budget: first paint ≤ 500 ms, full load ≤ 3,000 ms. A miss blocks the M5 exit (spec §10 "Gate"): record it and escalate; per spec §10 the first remedy is incremental appends in the selectors.

- [ ] **Step 2: Prepare the dev-host live-tick run (automated) and hand it to the user (HUMAN CHECK)**

```bash
cp "${TMPDIR:-/tmp}/jevcode-soak-trace.json" apps/trace-viewer-dev/public/bundles/soak.json
pnpm --filter jevcode-trace-viewer-dev build
pnpm --filter jevcode-trace-viewer-dev exec vite preview --port 4179 --strictPort
```

Expected: `vite preview` serves on `http://localhost:4179/`. **HUMAN CHECK** (the controller asks the user): open `http://localhost:4179/?bundle=soak&perf=1&drip=20,1000,-2000` in Chrome on the reference machine, stay in Live for at least 6 minutes (≥ 300 ticks), and read the HUD's `tv:live-tick` p95 and sample count. Budget: p95 ≤ 16 ms. Stop `vite preview` afterwards.

- [ ] **Step 3: Manual live session on the mock adapter (HUMAN CHECK)**

The implementer prepares a scratch repository and starts the app; the user drives it.

```bash
REPO="${TMPDIR:-/tmp}/jevcode-m5-repo"
rm -rf "$REPO" && cp -R fixtures/rate-limit/repo "$REPO"
git -C "$REPO" init -q && git -C "$REPO" add -A && git -C "$REPO" -c user.name=m5 -c user.email=m5@example.invalid commit -qm seed
rm -f "${TMPDIR:-/tmp}/jevcode-m5-live.db"*
pnpm --filter jevcode-desktop run rebuild
JEVC_AGENT=mock JEVCODE_TRACE_PERF=1 JEVCODE_DB="${TMPDIR:-/tmp}/jevcode-m5-live.db" pnpm --filter jevcode-desktop start 2>&1 | tee "${TMPDIR:-/tmp}/jevcode-m5-live.log"
```

The controller asks the user to: open `$REPO`; start the task "Add a Redis-backed rate limiter to the API server and make it fail open when Redis is unavailable."; while it runs, press **Trace**; then confirm each item and report any that fails:

1. The trace window opens light (no dark flash), at least 1000 px wide, in **Live**, and new steps appear within about a second.
2. Selecting an earlier row switches to **Review** ("Live follow paused" once); later appends raise "N new"; the selected row stays in place and keyboard focus never moves.
3. `G` (or the "N new" pill) returns to the live edge and Live resumes.
4. Pressing **Trace** again in the main window focuses the same trace window (also when it is minimized); no second window opens.
5. **Request changes** on a step focuses the main window; the composer holds the prior draft plus the note on a new line, the caret at the end, the Steer/Queue choice unchanged; nothing is sent until the user presses the button.
6. When the agent completes, the trace window shows the session as ended and Live is disabled.
7. Closing the main window closes the trace window.

After the user quits the app:

```bash
node -e '
const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n");
const ticks = lines.filter((l) => l.startsWith("TRACE_PERF tv:live-tick ")).map((l) => Number(l.split(" ")[2])).sort((a, b) => a - b);
const p95 = ticks.length === 0 ? NaN : ticks[Math.max(0, Math.ceil(ticks.length * 0.95) - 1)];
console.log(`trace window live tick p95 ${p95} ms over ${ticks.length} samples`);
' "${TMPDIR:-/tmp}/jevcode-m5-live.log"
grep -c "SMOKE_FAIL\|rejected:" "${TMPDIR:-/tmp}/jevcode-m5-live.log"
pnpm --filter jevcode-desktop rebuild:node
```

Expected: one `trace window live tick p95 … over <n> samples` line (a short mock session gives fewer than 300 samples; record `n`, and the dev-host run of Step 2 carries the p95 gate); `grep -c` prints `0` (no allowlist rejection during normal use); the last command prints `native modules restored to node ABI`. All seven items confirmed by the user.

- [ ] **Step 4: Record the budgets in `docs/perf.md`**

Append to the end of `docs/perf.md`:

```markdown

## Trace viewer (spec §10, R26), recorded at the M5 exit

Reference machine: <model>, <CPU>, <memory>, macOS <version>, Node <version>, Electron 33.4.11, display at 60 Hz. Single-run budgets: median of 5 runs after 1 discarded warm-up. p95 budgets: at least 300 samples. M4a and M4b values are copied from `docs/spikes/trace-viewer-spike.md` ("M4a exit", "M4b exit").

| Budget | Target | Gate | Measured | Status | Measured by |
|---|---|---|---|---|---|
| Full soak-session read in main | ≤ 1.5 s | M2 | (value from the "Trace read" section above) | | soak.mjs trace phase |
| `trace:rows` call in main (trace profile) | p95 ≤ 50 ms | M2 | | | soak.mjs trace phase, per page |
| Fold of 75k rows / one appended row | ≤ 500 ms / ≤ 2 ms | Benchmark | | | `pnpm --filter @jevcode/trace-viewer bench` |
| Soak first paint / full load (dev host) | ≤ 300 ms / ≤ 2 s | M4a | | | HUD, spike doc "M4a exit" |
| `j` to painted | p95 ≤ 16.7 ms, keydown to next painted frame (zero-work baseline beside it) | M4a | | | HUD, spike doc "M4a exit" |
| Overview layout + paint, Session level | p95 ≤ 4 ms; ≤ 150 overlay nodes | M4a | | | HUD, spike doc "M4a exit" |
| Anchor drift (spine and canvas) | ≤ 1 px | Smoke | | | `?selftest=drip`, spike doc |
| `layoutCanvas` fresh / sticky | ≤ 2 ms / ≤ 0.5 ms | Benchmark | | | `canvas-layout.bench.ts` |
| Canvas pinch at Step level | ≤ 5% frames dropped | M4b | | | spike harness, spike doc "M4b exit" |
| View switch | restored in the toggle's frame; never a 0 × 0 fit | M4b | | | HUD, spike doc "M4b exit" |
| Live tick (poll apply + selectors + commit) | p95 ≤ 16 ms | M5 | | | dev host `?bundle=soak&perf=1&drip=20,1000,-2000` (Step 2), plus the mock-adapter trace window (Step 3, `JEVCODE_TRACE_PERF=1`) |
| Soak open in the Electron trace window (trace profile) | first paint ≤ 500 ms / full load ≤ 3 s | M5 | | | `JEVCODE_SMOKE=1 JEVCODE_SMOKE_TRACE=1 JEVCODE_DB=<JEVCODE_SOAK_KEEP_DB copy>` (Step 1) |

Soak bundle: `traceRows` <n>, `consumedRows` <n> (from the Step 1 soak JSON).
```

Then fill it in, in the file: replace each `<…>` in the "Reference machine" and "Soak bundle" lines with the machine's values (`sysctl -n hw.model machdep.cpu.brand_string hw.memsize`, `sw_vers -productVersion`, `node -v`) and the soak JSON values; put every measured value in its row's Measured cell and `PASS` or `MISS` in Status. A row whose source section is absent from the spike doc gets `not recorded at M4a/M4b` in Measured and `MISS` in Status, and the task report names it.

- [ ] **Step 5: Add the targets to SPEC §13**

Run: `grep -n "Trace" docs/SPEC.md | sed -n '1,40p'`
Expected: lines outside the §13 table only (if W0/A1 already added a §13 trace-read row, keep it and skip that row below).

In `docs/SPEC.md`, find:

```markdown
| Event store growth cap | 1M events/session, then archive |
```

Replace with:

```markdown
| Event store growth cap | 1M events/session, then archive |
| Trace read: full soak session in main / one `trace:rows` call | ≤1.5s / ≤50ms p95 |
| Trace model: fold of 75k rows / one appended row (benchmark) | ≤500ms / ≤2ms |
| Trace viewer (dev host): soak first paint / full load | ≤300ms / ≤2s |
| Trace viewer: `j` to painted | ≤16.7ms p95 of work |
| Trace viewer: overview layout + paint at Session level | ≤4ms p95, ≤150 overlay nodes |
| Trace viewer: anchor drift on append | ≤1px |
| Trace viewer: canvas layout fresh / sticky (benchmark) | ≤2ms / ≤0.5ms |
| Trace viewer: canvas pinch at Step level (Electron 33) | ≤5% frames dropped |
| Trace viewer: view switch | restored in the toggle's frame |
| Trace viewer: live tick (poll apply + selectors + commit) | ≤16ms p95 |
| Trace window: soak open, first paint / full load | ≤500ms / ≤3s |
```

(Measured values live in `docs/perf.md` "Trace viewer"; SPEC §13 holds targets, like its other rows.)

- [ ] **Step 6: Record the allowlist in `docs/security.md`**

Run: `grep -n "^| 7 |" docs/security.md`
Expected: one line (A2-6's trace viewer read-only row).

Insert this row directly after that line:

```markdown
| 8 | Trace window cannot reach write, agent, session, repo or telemetry channels | PASS | `apps/desktop/src/main/trace-allowlist.ts` (`isChannelAllowed`): the ipc.ts `handle` wrapper classifies `event.sender.id` as main, trace (recorded by `trace-window.ts` before `loadFile`) or other before zod parsing. A trace window may invoke only `trace:listSessions`, `trace:rows`, `trace:payloads` and `trace:requestChanges`; `trace:open` and every non-trace channel need the main window; `trace:requestChanges` needs a trace window; anything else gets `UNTRUSTED_SENDER`. Trace windows share the main window's `webPreferences` (`sharedWebPreferences`), block `will-navigate`, deny `window.open` and load `trace.html` under the same CSP. `trace:requestChanges` only focuses the main window and pushes `composer:prefill`; it never sends an instruction. Covered by `trace-allowlist.test.ts`, `trace-window.test.ts`, `trace-window-ipc.test.ts`, `smoke.test.ts` and the extended smoke | `assertTrustedSender` still accepts any `file:` URL (separate PR, spec §14) |
```

- [ ] **Step 7: Check the M5 exit criteria**

| Criterion (spec §12 M5) | Evidence | Expected |
|---|---|---|
| Parity green | `pnpm --filter jevcode-desktop exec vitest run src/main/trace-parity.test.ts` | `Tests  5 passed (5)` |
| Allowlist green | `pnpm --filter jevcode-desktop exec vitest run src/main/trace-allowlist.test.ts src/main/trace-window-ipc.test.ts src/main/trace-window.test.ts` | all pass |
| Smoke green | D-6 Step 9 output | `SMOKE_TRACE …` then `SMOKE_OK` |
| Manual mock-adapter live session | Step 3 | the user confirmed items 1–7 |
| Live-tick budget | Step 2 (and Step 3's sample) | p95 ≤ 16 ms, ≥ 300 samples |
| Soak-open budget | Step 1 | medians ≤ 500 ms and ≤ 3,000 ms |
| Budgets recorded | `docs/perf.md` "Trace viewer", SPEC §13 | every row filled |
| Typecheck, test, lint | root checks below | exit 0 |

- [ ] **Step 8: Run the root checks**

Run, in order: `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r --no-bail --workspace-concurrency=1 test`, `pnpm lint`
Expected: each exits 0.

- [ ] **Step 9: Commit**

```bash
git add docs/perf.md docs/SPEC.md docs/security.md
git commit -m "docs: record M5 trace viewer budgets and the trace window allowlist"
```

**Part Db exit (M5 exit):** every row of Step 7 holds. Rebase on `main` after C3b merges (UI index §4: C3b → Db), rerun `pnpm install --frozen-lockfile && pnpm -r build`, the root checks and D-6 Step 9, then merge.
