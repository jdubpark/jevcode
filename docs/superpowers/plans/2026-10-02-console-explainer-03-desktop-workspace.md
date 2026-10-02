# Console-first workspace, Lane 03: Desktop workspace (D-1 to D-6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The main window opens the active session on the Console. It embeds `<TraceViewer chrome="embedded">` with Hybrid, Canvas, Map and a host-registered Surfaces view, and docks the existing composer under every view as a CLI prompt line. New rows reach the Console within tens of milliseconds through a coalesced `trace:rowsAvailable` push hint. The window is restyled onto the viewer's light `--tv-*` tokens, and the person's `sh -i` shell no longer carries agent one-liners.

**Architecture:** Main observes every committed trace-row append on the writer connection (`observeTraceAppends`). It feeds a per-session coalescing emitter (`createRowsAvailableEmitter`, at most one hint per 50 ms) that sends `{sessionId, lastSeq}` only to the main window when it shows that session and to trace windows opened on it, under a push allowlist. The renderer's IPC `TraceSource` exposes the hint as `onRowsAvailable`, and the viewer's DataController (lane 02a, V-1) polls at once. `WorkspaceHost` stays the main window's composition root. It renders `TaskPrompt` before the first prompt, and afterwards `EmbeddedWorkspace` (keyed by session id, with a stable `mainHost`) above `PromptDock`. Surfaces state lives in `useSessionSurfaces` and reaches the host view through `SurfacesContext`, because a `ViewDefinition.Component` receives only `{active}`. An Electron smoke drives the real window through the real IPC path: it opens a git repo, starts a scripted mock session, measures append latency from main's append clock to the renderer's `tv:live-tick` paint, walks all views and checks the selection, then captures screenshots.

**Tech Stack:** TypeScript 5.7 (NodeNext for main, Bundler for renderer and preload; strict, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`), Electron 33, React 19.2, Vite 5, zod 3, vitest 3 (jsdom 30.1.0 and @testing-library/react 16 added to `jevcode-desktop` in D-2), fast-check 4.10.1 (added in D-1), @xterm/xterm 5, pnpm 9.15.

**Spec:** `docs/superpowers/specs/2026-10-02-console-and-explainer-design.md` (the spec) §3.1, §3.6, §3.7, §4.3, §7, §9, §10, §11, §12. **Interfaces (binding):** `docs/superpowers/plans/2026-10-02-console-explainer-interfaces.md` §1.3, §6.2, §7. **Index:** `docs/superpowers/plans/2026-10-02-console-explainer-00-index.md` (Global Constraints, Review Focus 4, task table §3, gates §8). On a conflict, the interfaces file wins over this file and the spec wins over both, except for the deviations listed below.

**Execution order:** D-1 → D-2 → D-5 → D-4 → D-3 → D-6. D-4 runs before D-3 so that the prompt dock is written against `--tv-*` tokens that already exist on `:root`, and so that D-4's dead-rule test makes D-3 delete the context rail's CSS together with its markup. D-3 and D-4 wait for human gate H1. D-6 waits for 02b to be merged and this branch to be rebased on it.

## Interface deviations

Each item is needed against the real code. The orchestrator should record it in `lane-context.md`.

1. **`EmbeddedWorkspace` props** are `{ sessionId: string; repoRoot: string | null; onRequestChanges(text: string): void }`, not `{ sessionId }` (interfaces §7). Spec §9 says `mainHost.requestChanges` "prefills the local composer and focuses it". That composer's reducer lives in `WorkspaceHost`, and `rescanOverview` needs the open repo's root.
2. **The Surfaces view is created in D-2, not D-3.** D-2 removes the WorkspaceHost tab strip (index §3: "replacing the session view"). The Overview, Conversation and Decisions content therefore moves into `workspace/surfaces-view.tsx` in the same task, unchanged, or the main window would lose it. D-3 restyles it and adds its tests. Two files are new beyond interfaces §7. `workspace/session-surfaces.ts` holds `useSessionSurfaces` and `SurfacesContext`, because `ViewDefinition.Component` gets only `{active}`. `workspace/main-host.ts` holds `createMainHost`.
3. **`overview:rescan` renderer side.** D-2 adds `JevcodeApi.overview.rescan(repoRoot): Promise<void>` (`shared/api.ts`), which interfaces §7 does not list. `mainHost.rescanOverview` needs it. Lanes 01 (K-3) and 04 (M-6) both place the main-process handler in M-6, so this lane registers no `overview:rescan` handler. M-6's handler should reject a `repoRoot` that is not the open repo's `gitRoot` (spec §10); this lane's tests do not cover that check.
4. **`mainHost.answerDecision({decisionId, optionId})`** invokes `action:invoke` with `answer_decision` params `{ decisionId, decision: { decision: optionId } }`. `"decision"` is the key `ui-catalog`'s `Decision.tsx` uses when there is no suggested answer. The dispatcher gains one check: when the decision exists in the active session, every answer value must be one of its option ids (`INVALID_ACTION_PARAMS` otherwise). Unknown decisions still reach the runtime's `UNKNOWN_DECISION`.
5. **Token exports (D-4).** D-4 appends one export line to `packages/trace-viewer/src/index.ts`: `LIGHT_TOKENS`, `TOKEN_VARS`, `tokenStyle`, `FONT_SANS`, `FONT_MONO` and the `Tokens` and `TokenName` types. Without this, the main window cannot load "the viewer's token styles once at the root" (spec §9) without copying values. The change is additive. If lane 02a/02b/06 also append to that file, keep both sides.
6. **New main-process names (D-1, D-2, D-5):** `main/rows-available.ts` (`ROWS_AVAILABLE_CHANNEL`, `ROWS_AVAILABLE_MIN_INTERVAL_MS`, `createRowsAvailableEmitter`, `rowsAvailableTargets`, `observeTraceAppends`); `TRACE_WINDOW_PUSH_CHANNELS` and `isPushAllowed` in `main/trace-allowlist.ts`; `TraceWindowRegistry.sendersForSession`; `PipelineRuntimeOptions.mockScriptFor`; `main/pipeline/smoke-script.ts`; `main/smoke-workspace.ts`. `TerminalSink` loses `data` (D-5).
7. **Desktop test tooling (D-1, D-2):** `jevcode-desktop` gains the devDependencies `fast-check@4.10.1`, `jsdom@30.1.0`, `@testing-library/react@^16.3.3` and `@testing-library/dom@^10.4.2`. These are the versions `packages/trace-viewer` already locks. `vitest.config.ts` gains `src/**/*.test.tsx`. Renderer component tests opt in with `// @vitest-environment jsdom`.
8. **Smoke contract (D-2, D-6).** Env: `JEVCODE_SMOKE_WORKSPACE=1`, `JEVCODE_SMOKE_REPO`, `JEVCODE_SMOKE_SHOTS`, `JEVCODE_SMOKE_STEPS`, `JEVCODE_SMOKE_MIN_SAMPLES`. Main-window console lines: `WORKSPACE_READY <rows>` (always), plus `WORKSPACE_LOCATION <json>` and `CONSOLE_PAINT <sessionId> <throughSeq> <epochMs>` (only when the window is loaded with `?smoke=1`). Smoke output: `SMOKE_WORKSPACE`, `SMOKE_CONSOLE`, `SMOKE_VIEWS`, `SMOKE_SHOT`, then `SMOKE_OK`.

**Assumed W0 names (checked in "Lane prerequisites"; escalate if any differs, do not rename locally):**

- K-3: `"trace:rowsAvailable"` is in the desktop `fromMainRegistry` with payload `{ sessionId: string (min 1), lastSeq: int ≥ 0 }`. `"overview:rescan"` is in `toMainRegistry` with `{ repoRoot: string }`. This file uses the channel literals, so it does not depend on the constant names.
- V-1: `TraceSource.onRowsAvailable?(listener: (lastSeq: number) => void): () => void`. The DataController subscribes in `start()` and unsubscribes in `stop()`.
- V-2: `TraceViewerProps` has `chrome`, `hostViews`, `initialView` and `renderSwitch`. `ViewerHost` has `answerDecision`, `openTraceWindow` and `rescanOverview`. `ViewDefinition` and `ViewProps` are exported from the package root, and `IconName` includes `"view-surfaces"`. The viewer calls `renderSwitch` only when the switcher's inputs change (calling it on every render would loop through the host's state). `ViewerLocation.view` carries the active `ViewKind`, including `"console"`, `"map"` and host kinds, and `host.onLocation` keeps firing on every view and selection change.

## Spec alignment notes

- **Last view per window vs. Console on switch.** Spec §3.1 says "the last view used is remembered per window", while index Review Focus 4 says that switching sessions "opens on Console". This lane follows Review Focus 4: `EmbeddedWorkspace` is keyed by session id and always passes `initialView="console"`, and no per-window memory is built. The spec owner should drop or narrow the §3.1 sentence.
- **Commit cap vs. append budget.** Today's DataController caps commits at 4 per second, a 250 ms gap (`requestCommit`), which on its own would break "p95 ≤ 150 ms" (spec §11). Lane 02a's V-1 adds `HINT_COMMIT_GAP_MS = 50` for hint-started polls. This lane depends on it and does not work around it. D-6's smoke spaces agent events 150 ms apart, which is wider than the 50 ms hint window plus the 50 ms commit gap, so each append is measured on its own. Appends closer than 50 ms are coalesced by design, and they share one paint.
- **Sample count.** `docs/perf.md` requires at least 300 samples for a p95 budget. D-6's smoke defaults to 80 steps (321 agent rows) and fails below `JEVCODE_SMOKE_MIN_SAMPLES` (default 300).
- **Who receives the hint in the main window.** Spec §7 says "every window whose viewer shows that session". For the main window, main uses its own record of the active session (`AppState.session`, set by `repo:open`, `repo:browse` and `session:switch`). For trace windows, it uses the registry's session per sender. The renderer also filters by `sessionId`, so a stale recipient costs one ignored message and never fetches the wrong session.
- **`mainHost.openExternal: none`** (spec §9) has no counterpart in `ViewerHost`, so nothing is built.
- **Context rail → Brief.** The Brief (V-5, lane 02b) is built from trace data and already covers "Now" and "Changes". D-3 deletes the rail, its "Session map" counts and its "Files in play" list, and moves only the Instruction queue into the dock. Until 02b is merged, the lane branch has no Brief. That is acceptable because the lane merges after 02b.
- **`.jevcode-*` surface styles** (ui-catalog components) live in `apps/desktop/src/renderer/styles.css`, so D-4 restyles them with the rest of the window.

## Lane prerequisites

- **Wave W1.** W0 (lanes 01 and 02a) is merged into `main` as `<w0>`. 02b must be merged before D-6 (index §2).
- **Worktree** (once, from the index §5 recipe):

```bash
git -C /Users/jwpark/Projects/jevcode worktree add -b ce/03-desktop /Users/jwpark/Projects/jevcode-ce-03 <w0>
bash /Users/jwpark/Projects/jevcode/.superpowers/orchestration/setup-worktree.sh /Users/jwpark/Projects/jevcode-ce-03
```

Expected: the last line reads `/Users/jwpark/Projects/jevcode-ce-03: setup ok at <sha>`. Every later command runs from `/Users/jwpark/Projects/jevcode-ce-03`.

- **Verify the W0 names this lane consumes** (each must print a number ≥ 1):

```bash
cd /Users/jwpark/Projects/jevcode-ce-03
grep -rc '"trace:rowsAvailable"' packages/contracts/src/ipc.ts apps/desktop/src/shared/local-channels.ts | awk -F: '{s+=$2} END {print s}'
grep -rc '"overview:rescan"' packages/contracts/src/ipc.ts apps/desktop/src/shared/local-channels.ts | awk -F: '{s+=$2} END {print s}'
grep -c "onRowsAvailable" packages/trace-viewer/src/source.ts
grep -c "onRowsAvailable" packages/trace-viewer/src/ui/shell/data-controller.ts
grep -cE "chrome\?:|hostViews\?:|initialView\?:|renderSwitch\?:" packages/trace-viewer/src/ui/shell/TraceViewer.tsx
grep -cE "answerDecision\?|openTraceWindow\?|rescanOverview\?" packages/trace-viewer/src/ui/shell/host.ts
grep -c "ViewDefinition" packages/trace-viewer/src/index.ts
grep -c '"view-surfaces"' packages/trace-viewer/src/ui/icons/icon-names.ts
```

Expected: `≥1`, `≥1`, `≥1`, `≥1`, `4`, `3`, `≥1`, `1`. If any check prints `0`, stop and escalate to the orchestrator: W0 must provide the name. Do not add it in this lane.

- **Read the K-3 payload schema** once: `grep -n -A4 "rowsAvailable" packages/contracts/src/ipc.ts apps/desktop/src/shared/local-channels.ts`. If `lastSeq` is not `z.number().int().nonnegative()` or `sessionId` is not `z.string().min(1)`, record that in `progress.md`. The D-1 api test uses only a non-number `lastSeq` as its invalid case, so it stays valid either way.
- **Mockups (D-3, D-4, D-6).** After H1, `docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/README.md` names the approved main-window mockup. This lane calls its renders `main-window-console-1440.png` and `main-window-console-1000.png`. If V-0 used other file names, use the names the README lists as approved for "main window on Console".
- **Baseline:** `perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop test` passes, and `perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop typecheck` exits 0.

## Global Constraints (lane-specific additions)

The index Global Constraints apply in full (visual system, untrusted text, viewer purity, commits, native modules, hang safety, zsh). In addition:

- **IPC trust.** Lane 03 adds one main → renderer push (`trace:rowsAvailable`) and no new invoke channel beyond K-3's `overview:rescan`. Every push goes through `parseFromMain` before `send`. A trace window receives only the channels in `TRACE_WINDOW_PUSH_CHANNELS`, and its invoke allowlist (`TRACE_WINDOW_CHANNELS`) is unchanged (spec §4.3, §10).
- **The viewer stays IPC-free.** `apps/desktop` adapts `window.jevcode` into `TraceSource` and `ViewerHost`. Nothing in `packages/trace-viewer` changes in this lane except D-4's export line.
- **Review notes are never sent.** In the main window, `mainHost.requestChanges` only prefills the local composer. It never calls `trace:requestChanges`, which stays denied for the main window, and never `agent:sendInstruction`.
- **The user shell is the user's.** After D-5, nothing but the PTY writes to `terminal:data` or to a session's scrollback.
- **Composer behavior is preserved.** The per-session draft, the held note for another session with Switch and Dismiss, Cmd+Enter, Steer/Queue, Continue on a finished session, and `composer:prefill` keep the `composerReducer` rules (`renderer/components/composer-prefill.ts`, unchanged in this lane).
- **Electron runs.** Build first (`pnpm -r build`). Switch to the Electron ABI with `pnpm --filter jevcode-desktop run rebuild`, and afterwards switch back with `pnpm --filter jevcode-desktop run rebuild:node` and restore node-pty (command in D-6 Step 9). Run Electron in the background with a hard timeout and kill it if it outlives the timeout.
- **No Electron or Node import in renderer files.** Renderer files import neither `electron` nor `node:*`, except tests and `test-support`, which run under vitest.
- **Commands** (from the worktree):
  - targeted tests: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run <path under apps/desktop>`
  - typecheck: `perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop typecheck` (main, preload and renderer projects)
  - lint: `perl -e 'alarm 170; exec @ARGV' pnpm lint` (prints nothing after `> pnpm exec eslint .`)
  - a desktop test that fails with `NODE_MODULE_VERSION`: run `pnpm --filter jevcode-desktop run rebuild:node` and restore node-pty (D-6 Step 9), then rerun.
- **Commits:** `git -c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com commit -m "<message>"`, one commit per task, with no trailers. Never `git stash`.

## Review Focus (lane slice)

1. **Index Review Focus 4: switching sessions in the main window while live.** The old controller must stop, so no stale rows arrive and the old session's hint subscription is gone. The new session must open on Console in embedded chrome, and the prompt draft must follow the composer rules: the draft resets, and a held note for the new session becomes its draft. Test: **D-2** `workspace-host.test.tsx`, "switching sessions while live stops the old viewer, opens the new one on Console and resets the draft", plus "a review note for another session is held, then becomes the draft on switching to it".
2. **A hint must never reach a window that does not show its session.** A trace window must receive no push other than `trace:rowsAvailable`. Tests: **D-1** `rows-available.test.ts`, "sends only to the windows showing that session" and "drops a destroyed window and keeps sending to the rest"; `trace-allowlist.test.ts`, "a trace window receives only the row hint".
3. **Coalescing must not lose the tail.** Under any append timing, consecutive hints are at least 50 ms apart, each hint carries a strictly higher `lastSeq`, the last hint carries the highest seq, and every append is covered within 50 ms. Test: **D-1** fast-check property "never sends faster than 50 ms per session and never drops the tail".
4. **Agent lines in the user's shell.** Test: **D-5** `pipeline-runtime.test.ts`, "agent events never reach the user's shell". It fails on the pre-D-5 code.
5. **Host actions that main must refuse:** an answer naming an option the decision does not offer, and a trace window reaching `action:invoke`. Tests: **D-2** `action-dispatcher.test.ts` and `ipc.test.ts`. The existing allowlist loop in `trace-allowlist.test.ts` covers `overview:rescan` from a trace window once K-3 registers it. The open-repo check is M-6's.
6. **A failed send must not eat the draft.** Test: **D-3** `prompt-dock.test.tsx`, "a failed send keeps the draft and shows the error".

## File structure

All paths are under `apps/desktop/` unless they start with `packages/` or `docs/`.

| File | Responsibility | Task |
|---|---|---|
| `src/main/rows-available.ts` | Append observer, per-session coalescing emitter, recipient selection | D-1 |
| `src/main/trace-allowlist.ts` | `TRACE_WINDOW_PUSH_CHANNELS`, `isPushAllowed` | D-1 |
| `src/main/trace-window.ts` | `sendersForSession` (D-1); `MAIN_WINDOW_BACKGROUND` (D-4) | D-1, D-4 |
| `src/main/index.ts` | Wiring: observer, emitter, smoke deps, mock script, window background | D-1, D-2, D-4, D-6 |
| `src/shared/api.ts` | `trace.onRowsAvailable` (D-1), `overview.rescan` (D-2) | D-1, D-2 |
| `src/renderer/trace/ipc-source.ts` | `onRowsAvailable` filtered to the source's session | D-1 |
| `src/main/ipc.ts` | Terminal sink without `data` | D-5 |
| `src/main/pipeline/action-dispatcher.ts` | Answer options must belong to the decision | D-2, D-5 |
| `src/main/pipeline/types.ts`, `pipeline-runtime.ts` | `mockScriptFor` (D-2); no agent lines in the PTY stream (D-5) | D-2, D-5 |
| `src/main/pipeline/smoke-script.ts` | Deterministic mock agent script for the smoke | D-2 |
| `src/main/smoke-workspace.ts` | Workspace smoke phase (ready and shots in D-2; latency and views in D-6) | D-2, D-6 |
| `src/main/smoke.ts` | Starts the workspace phase | D-2, D-6 |
| `scripts/smoke-workspace.mjs` | Temp git repo, temp DB, Electron run, verdict | D-2, D-6 |
| `src/renderer/workspace/main-host.ts` | `createMainHost` (`ViewerHost` for the main window) | D-2, D-6 |
| `src/renderer/workspace/EmbeddedWorkspace.tsx` | Viewer for one session, switcher bar | D-2, D-6 |
| `src/renderer/workspace/session-surfaces.ts` | `useSessionSurfaces`, `SurfacesContext`, surface helpers moved from WorkspaceHost | D-2 |
| `src/renderer/workspace/surfaces-view.tsx` | `SurfacesView`, `surfacesView` host view | D-2, D-3 |
| `src/renderer/workspace/PromptDock.tsx` | CLI prompt line, queue, held note, Pause/Resume | D-3 |
| `src/renderer/workspace/paint-probe.ts` | Smoke-only `CONSOLE_PAINT` lines from `tv:live-tick` | D-6 |
| `src/renderer/components/WorkspaceHost.tsx` | Composition root: TaskPrompt or EmbeddedWorkspace + dock | D-2, D-3 |
| `src/renderer/test-support/fake-bridge.ts` | `window.jevcode` fake for jsdom tests | D-2 |
| `src/renderer/theme.ts` | `applyViewerTokens`, `XTERM_LIGHT_THEME` | D-4 |
| `src/renderer/main.tsx` | Tokens on `:root` (D-4); perf mark and paint probe (D-6) | D-4, D-6 |
| `src/renderer/styles.css` | Light restyle; dock, bar and Surfaces rules | D-2, D-3, D-4 |
| `src/renderer/components/TerminalPanel.tsx` | Light xterm theme | D-4 |
| `packages/trace-viewer/src/index.ts` | Token exports (deviation 5) | D-4 |
| `docs/perf.md` | Console append latency row | D-6 |

Tests: `src/main/rows-available.test.ts` (new), `src/main/trace-allowlist.test.ts`, `src/main/trace-window.test.ts`, `src/shared/api.test.ts`, `src/renderer/trace/ipc-source.test.ts`, `src/renderer/trace/host.test.ts` (fake update) in D-1. In D-2: `src/renderer/workspace/main-host.test.ts` (new), `src/renderer/components/workspace-host.test.tsx` (new), `src/main/ipc.test.ts`, `src/main/pipeline/action-dispatcher.test.ts`, `src/main/pipeline/smoke-script.test.ts` (new), `src/main/pipeline/pipeline-runtime.test.ts`, `src/main/smoke-workspace.test.ts` (new), `src/main/smoke.test.ts`. In D-5: `pipeline-runtime.test.ts`, `resume-budget.test.ts`, `action-dispatcher.test.ts`. In D-4: `src/renderer/styles-tokens.test.ts` (new). In D-3: `src/renderer/workspace/prompt-dock.test.tsx` and `src/renderer/workspace/surfaces-view.test.tsx` (new), plus `workspace-host.test.tsx`. In D-6: `src/renderer/workspace/paint-probe.test.ts` (new), `smoke-workspace.test.ts`, `main-host.test.ts`.

---

### Task D-1: Main: coalesced `trace:rowsAvailable` emitter; preload; IPC source hook

**Files:**
- Create: `apps/desktop/src/main/rows-available.ts`
- Modify: `apps/desktop/src/main/trace-allowlist.ts` (append the push allowlist)
- Modify: `apps/desktop/src/main/trace-window.ts` (`TraceWindowRegistry.sendersForSession`)
- Modify: `apps/desktop/src/main/index.ts` (observer and emitter wiring; `will-quit` dispose)
- Modify: `apps/desktop/src/shared/api.ts` (`trace.onRowsAvailable`)
- Modify: `apps/desktop/src/renderer/trace/ipc-source.ts` (`onRowsAvailable`)
- Modify: `apps/desktop/package.json` (devDependency `fast-check`), `pnpm-lock.yaml`
- Test: `apps/desktop/src/main/rows-available.test.ts` (new), `apps/desktop/src/main/trace-allowlist.test.ts`, `apps/desktop/src/main/trace-window.test.ts`, `apps/desktop/src/shared/api.test.ts`, `apps/desktop/src/renderer/trace/ipc-source.test.ts`, `apps/desktop/src/renderer/trace/host.test.ts` (fake only)

**Interfaces:**
- Consumes (K-3): the `"trace:rowsAvailable"` entry of `fromMainRegistry` (payload `{ sessionId: string; lastSeq: number }`); `isTraceRowType(value: string)` from `@jevcode/contracts` (`src/trace.ts:39`), which after K-1 also accepts `overview_snapshot` and `explainer`; `JevcodeDb.appendEvent(sessionId, type, payload): StoredEvent` (`packages/storage/src/db.ts:239`), through which every typed helper appends.
- Consumes (V-1): `TraceSource.onRowsAvailable?(listener: (lastSeq: number) => void): () => void`.
- Produces:
  - `ROWS_AVAILABLE_CHANNEL = "trace:rowsAvailable"` and `ROWS_AVAILABLE_MIN_INTERVAL_MS = 50`.
  - `createRowsAvailableEmitter(deps: RowsAvailableDeps): RowsAvailableEmitter`, where `RowsAvailableEmitter` is `{ notify(sessionId: string, lastSeq: number): void; dispose(): void }`. Lane 04 (M-6) passes `emitter.notify` as `ExplainerStageDeps.emitRowsAvailable`. Calling it is harmless but redundant, because the observer already reports the stage's appends.
  - `rowsAvailableTargets(sessionId, windows): RowsAvailableTarget[]`.
  - `observeTraceAppends(db, onAppend: (event: { sessionId: string; seq: number; type: string }) => void): () => void`. D-6 also uses it for the smoke's append clock.
  - `TRACE_WINDOW_PUSH_CHANNELS` and `isPushAllowed(channel: string, receiver: SenderKind): boolean`.
  - `TraceWindowRegistry.sendersForSession(sessionId: string): number[]`.
  - `JevcodeApi.trace.onRowsAvailable(listener: (payload: { sessionId: string; lastSeq: number }) => void): () => void` (interfaces §7).
  - `createIpcTraceSource(...).onRowsAvailable(listener: (lastSeq: number) => void): () => void`.

- [ ] **Step 1: Confirm the K-3 channel and add fast-check**

Run:

```bash
grep -n -B1 -A4 'rowsAvailable' packages/contracts/src/ipc.ts apps/desktop/src/shared/local-channels.ts
pnpm --filter jevcode-desktop add -D fast-check@4.10.1
NP=$(ls -d node_modules/.pnpm/node-pty@*/node_modules/node-pty | head -1); ls "$NP/build/Release/pty.node" "$NP/build/Release/spawn-helper"
```

Expected: the grep shows one schema entry with `sessionId` and `lastSeq`. `pnpm add` exits 0. Both node-pty files are listed. If either is missing, restore them with `PB="$NP/prebuilds/$(node -p 'process.platform + "-" + process.arch')"; mkdir -p "$NP/build/Release"; cp "$PB/spawn-helper" "$PB/pty.node" "$NP/build/Release/" && chmod +x "$NP/build/Release/spawn-helper"`.

- [ ] **Step 2: Write the failing emitter tests**

Create `apps/desktop/src/main/rows-available.test.ts`:

```ts
import { openDb } from "@jevcode/storage";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  ROWS_AVAILABLE_CHANNEL,
  ROWS_AVAILABLE_MIN_INTERVAL_MS,
  createRowsAvailableEmitter,
  observeTraceAppends,
  rowsAvailableTargets,
} from "./rows-available.js";
import type { PushContents, RowsAvailableTarget } from "./rows-available.js";

class VirtualClock {
  time = 0;
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

  advanceTo(target: number): void {
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.time = Math.max(this.time, due[1].at);
      due[1].fn();
    }
    this.time = Math.max(this.time, target);
  }

  pending(): number {
    return this.timers.size;
  }
}

interface Sent {
  at: number;
  channel: string;
  payload: { sessionId: string; lastSeq: number };
}

type FakeContents = PushContents & { sent: Sent[]; destroyed: boolean; throws: boolean };

function fakeContents(clock: VirtualClock, id: number): FakeContents {
  const contents: FakeContents = {
    id,
    sent: [],
    destroyed: false,
    throws: false,
    send(channel, payload) {
      if (contents.throws) throw new Error("render frame disposed");
      contents.sent.push({ at: clock.now(), channel, payload });
    },
    isDestroyed: () => contents.destroyed,
  };
  return contents;
}

function setup(targets?: (clock: VirtualClock) => (sessionId: string) => readonly RowsAvailableTarget[]) {
  const clock = new VirtualClock();
  const main = fakeContents(clock, 1);
  const emitter = createRowsAvailableEmitter({
    targets: targets?.(clock) ?? (() => [{ kind: "main", contents: main }]),
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  return { clock, main, emitter };
}

describe("createRowsAvailableEmitter", () => {
  it("uses the spec's channel and 50 ms per-session bound (spec §7)", () => {
    expect(ROWS_AVAILABLE_CHANNEL).toBe("trace:rowsAvailable");
    expect(ROWS_AVAILABLE_MIN_INTERVAL_MS).toBe(50);
  });

  it("sends the first append at once with its seq", () => {
    const { main, emitter } = setup();
    emitter.notify("sess_a", 7);
    expect(main.sent).toEqual([{ at: 0, channel: "trace:rowsAvailable", payload: { sessionId: "sess_a", lastSeq: 7 } }]);
  });

  it("coalesces a burst into one trailing hint that carries the latest seq", () => {
    const { clock, main, emitter } = setup();
    for (const [at, seq] of [[0, 1], [10, 2], [20, 3], [30, 4], [40, 5]] as const) {
      clock.advanceTo(at);
      emitter.notify("sess_a", seq);
    }
    clock.advanceTo(200);
    expect(main.sent.map((entry) => [entry.at, entry.payload.lastSeq])).toEqual([
      [0, 1],
      [50, 5],
    ]);
  });

  it("keeps sessions independent", () => {
    const { main, emitter } = setup();
    emitter.notify("sess_a", 1);
    emitter.notify("sess_b", 1);
    expect(main.sent.map((entry) => entry.payload)).toEqual([
      { sessionId: "sess_a", lastSeq: 1 },
      { sessionId: "sess_b", lastSeq: 1 },
    ]);
  });

  it("ignores a seq it has already announced and malformed input", () => {
    const { clock, main, emitter } = setup();
    emitter.notify("sess_a", 4);
    clock.advanceTo(100);
    emitter.notify("sess_a", 4);
    emitter.notify("sess_a", 3);
    emitter.notify("", 9);
    emitter.notify("sess_a", 0);
    emitter.notify("sess_a", 1.5);
    clock.advanceTo(300);
    expect(main.sent).toHaveLength(1);
  });

  it("sends only to the windows showing that session", () => {
    const traceA = { current: null as FakeContents | null };
    const traceB = { current: null as FakeContents | null };
    const { clock, main, emitter } = setup((clock) => {
      traceA.current = fakeContents(clock, 100);
      traceB.current = fakeContents(clock, 101);
      return (sessionId) =>
        sessionId === "sess_a"
          ? [{ kind: "trace", contents: traceA.current as FakeContents }]
          : [{ kind: "trace", contents: traceB.current as FakeContents }];
    });
    emitter.notify("sess_a", 3);
    clock.advanceTo(100);
    expect(traceA.current?.sent.map((entry) => entry.payload)).toEqual([{ sessionId: "sess_a", lastSeq: 3 }]);
    expect(traceB.current?.sent).toEqual([]);
    expect(main.sent).toEqual([]);
  });

  it("drops a destroyed window and keeps sending to the rest when one send throws", () => {
    const windows = { gone: null as FakeContents | null, broken: null as FakeContents | null, ok: null as FakeContents | null };
    const { emitter } = setup((clock) => {
      windows.gone = fakeContents(clock, 100);
      windows.broken = fakeContents(clock, 101);
      windows.ok = fakeContents(clock, 102);
      windows.gone.destroyed = true;
      windows.broken.throws = true;
      return () => [
        { kind: "trace", contents: windows.gone as FakeContents },
        { kind: "trace", contents: windows.broken as FakeContents },
        { kind: "trace", contents: windows.ok as FakeContents },
      ];
    });
    emitter.notify("sess_a", 2);
    expect(windows.gone?.sent).toEqual([]);
    expect(windows.ok?.sent.map((entry) => entry.payload.lastSeq)).toEqual([2]);
  });

  it("dispose cancels a pending trailing hint", () => {
    const { clock, main, emitter } = setup();
    emitter.notify("sess_a", 1);
    clock.advanceTo(10);
    emitter.notify("sess_a", 2);
    expect(clock.pending()).toBe(1);
    emitter.dispose();
    clock.advanceTo(500);
    expect(main.sent.map((entry) => entry.payload.lastSeq)).toEqual([1]);
    emitter.notify("sess_a", 3);
    expect(main.sent).toHaveLength(1);
  });

  it("never sends faster than 50 ms per session and never drops the tail", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ dt: fc.integer({ min: 0, max: 120 }), session: fc.constantFrom("sess_a", "sess_b") }),
          { minLength: 1, maxLength: 60 },
        ),
        (events) => {
          const { clock, main, emitter } = setup();
          const seqs: Record<string, number> = { sess_a: 0, sess_b: 0 };
          const appends: Array<{ session: string; seq: number; at: number }> = [];
          let t = 0;
          for (const event of events) {
            t += event.dt;
            clock.advanceTo(t);
            seqs[event.session] = (seqs[event.session] ?? 0) + 1;
            const seq = seqs[event.session] ?? 0;
            appends.push({ session: event.session, seq, at: t });
            emitter.notify(event.session, seq);
          }
          clock.advanceTo(t + 1_000);
          for (const session of ["sess_a", "sess_b"]) {
            const sends = main.sent.filter((entry) => entry.payload.sessionId === session);
            for (let i = 1; i < sends.length; i += 1) {
              const previous = sends[i - 1];
              const current = sends[i];
              if (previous === undefined || current === undefined) continue;
              expect(current.at - previous.at).toBeGreaterThanOrEqual(50);
              expect(current.payload.lastSeq).toBeGreaterThan(previous.payload.lastSeq);
            }
            const max = seqs[session] ?? 0;
            if (max > 0) expect(sends.at(-1)?.payload.lastSeq).toBe(max);
            for (const append of appends.filter((entry) => entry.session === session)) {
              const covering = sends.find((entry) => entry.payload.lastSeq >= append.seq && entry.at >= append.at);
              expect(covering).toBeDefined();
              expect((covering?.at ?? Infinity) - append.at).toBeLessThanOrEqual(50);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("rowsAvailableTargets", () => {
  const contents = (id: number): PushContents => ({ id, send: () => undefined, isDestroyed: () => false });

  it("includes the main window only while it shows the session, and every trace window on it", () => {
    const main = contents(1);
    const byId = new Map<number, PushContents>([[100, contents(100)], [101, contents(101)]]);
    const windows = { main, traceSenderIds: [100, 101], fromId: (id: number) => byId.get(id) ?? null };
    expect(
      rowsAvailableTargets("sess_a", { ...windows, mainSessionId: "sess_a" }).map((t) => [t.kind, t.contents.id]),
    ).toEqual([["main", 1], ["trace", 100], ["trace", 101]]);
    expect(
      rowsAvailableTargets("sess_a", { ...windows, mainSessionId: "sess_b" }).map((t) => [t.kind, t.contents.id]),
    ).toEqual([["trace", 100], ["trace", 101]]);
    expect(rowsAvailableTargets("sess_a", { main: null, mainSessionId: "sess_a", traceSenderIds: [7], fromId: () => null })).toEqual([]);
  });
});

describe("observeTraceAppends", () => {
  function seeded() {
    const db = openDb({ dbPath: ":memory:" });
    db.upsertRepository({ id: "repo_a", path: "/a", gitRoot: "/a" });
    db.createSession({ id: "sess_a", repoId: "repo_a", prompt: "demo" });
    return db;
  }
  const message = (text: string) => ({
    type: "agent_message" as const,
    sessionId: "sess_a",
    role: "assistant" as const,
    text,
    ts: "2026-10-02T10:00:00.000Z",
  });

  it("reports every committed trace-row append with its seq, including the typed helpers", () => {
    const db = seeded();
    const seen: Array<{ sessionId: string; seq: number; type: string }> = [];
    observeTraceAppends(db, (event) => seen.push(event));
    db.appendAgentEvent("sess_a", message("one"));
    db.appendAgentEvent("sess_a", message("two"));
    expect(seen).toEqual([
      { sessionId: "sess_a", seq: 1, type: "agent_event" },
      { sessionId: "sess_a", seq: 2, type: "agent_event" },
    ]);
    db.close();
  });

  it("ignores rows the trace never reads and appends that fail", () => {
    const db = seeded();
    const seen: unknown[] = [];
    observeTraceAppends(db, (event) => seen.push(event));
    db.appendTelemetry("agent_event_count", {}, "sess_a");
    expect(() => db.appendAgentEvent("sess_missing", { ...message("x"), sessionId: "sess_missing" })).toThrow();
    expect(seen).toEqual([]);
    db.close();
  });

  it("never fails a write when the listener throws", () => {
    const db = seeded();
    observeTraceAppends(db, () => {
      throw new Error("listener bug");
    });
    expect(db.appendAgentEvent("sess_a", message("kept")).seq).toBe(1);
    expect(db.listEvents("sess_a")).toHaveLength(1);
    db.close();
  });

  it("stops reporting after dispose", () => {
    const db = seeded();
    const seen: unknown[] = [];
    const dispose = observeTraceAppends(db, (event) => seen.push(event));
    dispose();
    db.appendAgentEvent("sess_a", message("after"));
    expect(seen).toEqual([]);
    db.close();
  });
});
```

- [ ] **Step 3: Add the allowlist, registry, api and source tests**

Append to `apps/desktop/src/main/trace-allowlist.test.ts`. First extend its import to `import { TRACE_WINDOW_CHANNELS, TRACE_WINDOW_PUSH_CHANNELS, isChannelAllowed, isPushAllowed } from "./trace-allowlist.js";`, then append:

```ts
describe("main → renderer pushes (spec §4.3, §7)", () => {
  it("a trace window receives only the row hint", () => {
    expect([...TRACE_WINDOW_PUSH_CHANNELS]).toEqual(["trace:rowsAvailable"]);
    expect(isPushAllowed("trace:rowsAvailable", "trace")).toBe(true);
    for (const channel of ["agent:event", "composer:prefill", "terminal:data", "ui:spec", "session:state"]) {
      expect(isPushAllowed(channel, "trace"), channel).toBe(false);
    }
  });

  it("the main window receives every push, an unknown sender none", () => {
    expect(isPushAllowed("trace:rowsAvailable", "main")).toBe(true);
    expect(isPushAllowed("agent:event", "main")).toBe(true);
    expect(isPushAllowed("trace:rowsAvailable", "other")).toBe(false);
  });
});
```

Append inside the existing top-level `describe` of `apps/desktop/src/main/trace-window.test.ts` (it uses that file's `setup()` and `at()`):

```ts
  it("lists the trace windows showing a session and forgets closed ones", () => {
    const { registry, created } = setup();
    registry.openTraceWindow("sess_1");
    registry.openTraceWindow("sess_2");
    expect(registry.sendersForSession("sess_1")).toEqual([100]);
    expect(registry.sendersForSession("sess_2")).toEqual([101]);
    expect(registry.sendersForSession("sess_3")).toEqual([]);
    at(created, 0).close();
    expect(registry.sendersForSession("sess_1")).toEqual([]);
  });
```

Append to `apps/desktop/src/shared/api.test.ts` (same pattern as the existing `onComposerPrefill` test at the end of the file):

```ts
describe("trace.onRowsAvailable", () => {
  it("subscribes to trace:rowsAvailable and drops malformed hints", () => {
    const captured = new Map<string, (payload: unknown) => void>();
    const deps = {
      invoke: vi.fn(async () => undefined),
      on: vi.fn((channel: string, listener: (payload: unknown) => void) => {
        captured.set(channel, listener);
        return () => undefined;
      }),
      platform: "test",
    };
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const listener = vi.fn();
    createJevcodeApi(deps).trace.onRowsAvailable(listener);
    const push = captured.get("trace:rowsAvailable");
    expect(push).toBeDefined();
    push?.({ sessionId: "sess_1", lastSeq: 12 });
    push?.({ sessionId: "sess_1", lastSeq: "12" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ sessionId: "sess_1", lastSeq: 12 });
    quiet.mockRestore();
  });
});
```

In `apps/desktop/src/renderer/trace/ipc-source.test.ts`, change `fakeBridge()` so that hints can be pushed:

```ts
function fakeBridge() {
  const hintListeners = new Set<(payload: { sessionId: string; lastSeq: number }) => void>();
  return {
    listSessions: vi.fn<Bridge["listSessions"]>(async () => [SUMMARY]),
    rows: vi.fn<Bridge["rows"]>(async () => PAGE),
    payloads: vi.fn<Bridge["payloads"]>(async () => PAGE.rows),
    open: vi.fn<Bridge["open"]>(async () => undefined),
    requestChanges: vi.fn<Bridge["requestChanges"]>(async () => undefined),
    onRowsAvailable: vi.fn<Bridge["onRowsAvailable"]>((listener) => {
      hintListeners.add(listener);
      return () => {
        hintListeners.delete(listener);
      };
    }),
    hint(payload: { sessionId: string; lastSeq: number }) {
      for (const listener of [...hintListeners]) listener(payload);
    },
    hintListenerCount: () => hintListeners.size,
  };
}
```

and append:

```ts
describe("createIpcTraceSource push hints (spec §7, E5)", () => {
  it("passes only its own session's lastSeq to the listener", () => {
    const bridge = fakeBridge();
    const source = createIpcTraceSource(bridge, "s");
    const seen: number[] = [];
    source.onRowsAvailable?.((lastSeq) => seen.push(lastSeq));
    bridge.hint({ sessionId: "other", lastSeq: 40 });
    bridge.hint({ sessionId: "s", lastSeq: 41 });
    expect(seen).toEqual([41]);
  });

  it("unsubscribes through the bridge", () => {
    const bridge = fakeBridge();
    const off = createIpcTraceSource(bridge, "s").onRowsAvailable?.(() => undefined);
    expect(bridge.hintListenerCount()).toBe(1);
    off?.();
    expect(bridge.hintListenerCount()).toBe(0);
  });
});
```

In `apps/desktop/src/renderer/trace/host.test.ts`, add `onRowsAvailable: vi.fn<Bridge["onRowsAvailable"]>(() => () => undefined),` to the `trace` object in `fakeBridge()`.

- [ ] **Step 4: Run the tests to see them fail**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/main/rows-available.test.ts src/main/trace-allowlist.test.ts src/main/trace-window.test.ts src/shared/api.test.ts src/renderer/trace/ipc-source.test.ts`

Expected: FAIL. `rows-available.test.ts` fails with "Failed to resolve import "./rows-available.js"". The allowlist file fails because `isPushAllowed` is not a function, `trace-window.test.ts` with "registry.sendersForSession is not a function", `api.test.ts` with "Cannot read properties of undefined (reading 'onRowsAvailable')" or a TypeError, and `ipc-source.test.ts` because `source.onRowsAvailable` is undefined (`seen` stays `[]`).

- [ ] **Step 5: Implement `rows-available.ts`**

Create `apps/desktop/src/main/rows-available.ts`:

```ts
import { isTraceRowType } from "@jevcode/contracts";
import type { EventStoreType, JevcodeDb, StoredEvent } from "@jevcode/storage";

import { parseFromMain } from "../shared/ipc-registry.js";
import { isPushAllowed } from "./trace-allowlist.js";
import type { SenderKind } from "./trace-allowlist.js";

export const ROWS_AVAILABLE_CHANNEL = "trace:rowsAvailable" as const;
/** Spec §7: at most one hint per session every 50 ms, coalesced. */
export const ROWS_AVAILABLE_MIN_INTERVAL_MS = 50;

export interface RowsAvailablePayload {
  sessionId: string;
  lastSeq: number;
}

/** The part of an Electron WebContents the emitter uses. */
export interface PushContents {
  readonly id: number;
  send(channel: string, payload: RowsAvailablePayload): void;
  isDestroyed(): boolean;
}

export interface RowsAvailableTarget {
  kind: Exclude<SenderKind, "other">;
  contents: PushContents;
}

export interface RowsAvailableDeps {
  /** The windows that show sessionId right now (rowsAvailableTargets). */
  targets(sessionId: string): readonly RowsAvailableTarget[];
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  intervalMs?: number;
  log?(message: string): void;
}

export interface RowsAvailableEmitter {
  /** A row with this seq is committed for sessionId. */
  notify(sessionId: string, lastSeq: number): void;
  dispose(): void;
}

interface SessionSlot {
  pendingSeq: number;
  lastSentAt: number;
  timer: unknown | null;
}

/**
 * Spec E5 and §7: a one-way, content-free hint so a viewer pulls at once
 * instead of waiting for its 1 s poll. Leading edge: the first append after a
 * quiet 50 ms is sent immediately. Inside the window, later appends only raise
 * the pending seq, and one trailing hint carries the highest seq. A
 * destroyed or failing window never stops the others.
 */
export function createRowsAvailableEmitter(deps: RowsAvailableDeps): RowsAvailableEmitter {
  const interval = deps.intervalMs ?? ROWS_AVAILABLE_MIN_INTERVAL_MS;
  const slots = new Map<string, SessionSlot>();
  let disposed = false;

  function send(sessionId: string, slot: SessionSlot): void {
    slot.timer = null;
    const payload = parseFromMain(ROWS_AVAILABLE_CHANNEL, {
      sessionId,
      lastSeq: slot.pendingSeq,
    }) as RowsAvailablePayload;
    slot.lastSentAt = deps.now();
    for (const target of deps.targets(sessionId)) {
      if (!isPushAllowed(ROWS_AVAILABLE_CHANNEL, target.kind)) continue;
      if (target.contents.isDestroyed()) continue;
      try {
        target.contents.send(ROWS_AVAILABLE_CHANNEL, payload);
      } catch (error) {
        deps.log?.(
          `${ROWS_AVAILABLE_CHANNEL} to ${target.kind} window ${target.contents.id} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  return {
    notify(sessionId, lastSeq) {
      if (disposed || sessionId.length === 0 || !Number.isInteger(lastSeq) || lastSeq <= 0) return;
      let slot = slots.get(sessionId);
      if (slot === undefined) {
        slot = { pendingSeq: 0, lastSentAt: Number.NEGATIVE_INFINITY, timer: null };
        slots.set(sessionId, slot);
      }
      if (lastSeq <= slot.pendingSeq) return;
      slot.pendingSeq = lastSeq;
      if (slot.timer !== null) return;
      const wait = slot.lastSentAt + interval - deps.now();
      if (wait <= 0) {
        send(sessionId, slot);
        return;
      }
      const due = slot;
      due.timer = deps.setTimeout(() => {
        if (!disposed) send(sessionId, due);
      }, wait);
    },
    dispose() {
      disposed = true;
      for (const slot of slots.values()) {
        if (slot.timer !== null) deps.clearTimeout(slot.timer);
      }
      slots.clear();
    },
  };
}

export interface RowsAvailableWindows {
  main: PushContents | null;
  /** AppState.session?.id: the session the main window shows. */
  mainSessionId: string | null;
  /** TraceWindowRegistry.sendersForSession(sessionId). */
  traceSenderIds: readonly number[];
  fromId(id: number): PushContents | null;
}

/** The main window while it shows sessionId, plus every trace window opened on it. */
export function rowsAvailableTargets(sessionId: string, windows: RowsAvailableWindows): RowsAvailableTarget[] {
  const targets: RowsAvailableTarget[] = [];
  if (windows.main !== null && windows.mainSessionId === sessionId) {
    targets.push({ kind: "main", contents: windows.main });
  }
  for (const id of windows.traceSenderIds) {
    const contents = windows.fromId(id);
    if (contents !== null) targets.push({ kind: "trace", contents });
  }
  return targets;
}

export interface ObservedAppend {
  sessionId: string;
  seq: number;
  type: string;
}

/**
 * Wraps db.appendEvent on this instance. Every typed helper (appendAgentEvent,
 * upsertDecision, …) calls this.appendEvent, so all trace rows pass here after
 * their transaction commits. Telemetry and other non-trace rows are not
 * reported, and a throwing listener never fails the write.
 */
export function observeTraceAppends(
  db: Pick<JevcodeDb, "appendEvent">,
  onAppend: (event: ObservedAppend) => void,
): () => void {
  const target = db as { appendEvent: JevcodeDb["appendEvent"] };
  const prior = target.appendEvent;
  const bound = prior.bind(db);
  const observed = (sessionId: string, type: EventStoreType, payload: unknown): StoredEvent => {
    const stored = bound(sessionId, type, payload);
    if (stored.sessionId.length > 0 && isTraceRowType(stored.type)) {
      try {
        onAppend({ sessionId: stored.sessionId, seq: stored.seq, type: stored.type });
      } catch {
        // A hint is advisory; the 1 s poll still delivers the row.
      }
    }
    return stored;
  };
  target.appendEvent = observed;
  return () => {
    if (target.appendEvent === observed) target.appendEvent = prior;
  };
}
```

- [ ] **Step 6: Implement the allowlist, the registry method, the bridge and the source hook**

Append to `apps/desktop/src/main/trace-allowlist.ts`:

```ts
/** main → renderer pushes a trace window may receive (spec §7). Everything else goes to the main window only. */
export const TRACE_WINDOW_PUSH_CHANNELS: readonly string[] = ["trace:rowsAvailable"];

export function isPushAllowed(channel: string, receiver: SenderKind): boolean {
  switch (receiver) {
    case "main":
      return true;
    case "trace":
      return TRACE_WINDOW_PUSH_CHANNELS.includes(channel);
    case "other":
      return false;
  }
}
```

In `apps/desktop/src/main/trace-window.ts`, add to `interface TraceWindowRegistry`, after `sessionForSender`:

```ts
  /** webContents ids of the open trace windows that show sessionId (trace:rowsAvailable recipients). */
  sendersForSession(sessionId: string): number[];
```

and add to the returned object, after `sessionForSender(webContentsId) { … },`:

```ts
    sendersForSession(sessionId) {
      const ids: number[] = [];
      for (const [webContentsId, shown] of senders) {
        if (shown === sessionId) ids.push(webContentsId);
      }
      return ids;
    },
```

In `apps/desktop/src/shared/api.ts`, add to `JevcodeApi.trace`, after `requestChanges(...)`:

```ts
    /** One-way hint: rows up to lastSeq are stored for sessionId (spec §7). Carries no content. */
    onRowsAvailable(listener: (payload: { sessionId: string; lastSeq: number }) => void): () => void;
```

and to the `trace:` object returned by `createJevcodeApi`, after `requestChanges: async (request) => { … },`:

```ts
      onRowsAvailable: (listener) => on("trace:rowsAvailable", listener),
```

In `apps/desktop/src/renderer/trace/ipc-source.ts`, add to the object returned by `createIpcTraceSource`, after `now: () => Date.now(),`:

```ts
    // Spec E5: main's push hint, narrowed to this source's session. The
    // DataController polls at once when lastSeq is past its cursor.
    onRowsAvailable: (listener) =>
      bridge.onRowsAvailable((payload) => {
        if (payload.sessionId === sessionId) listener(payload.lastSeq);
      }),
```

and extend the doc comment's first line to read `summary() → …; rows → trace.rows; payloads → trace.payloads; onRowsAvailable → trace.onRowsAvailable for this session; now() → Date.now().`

- [ ] **Step 7: Wire the observer and emitter in main**

In `apps/desktop/src/main/index.ts`:

1. Change the Electron import to `import { app, BrowserWindow, webContents } from "electron";`.
2. Add the import `import { createRowsAvailableEmitter, observeTraceAppends, rowsAvailableTargets } from "./rows-available.js";` and the type import `import type { RowsAvailableEmitter } from "./rows-available.js";`.
3. Next to `let runtime: PipelineRuntime | null = null;`, add `let rowsAvailable: RowsAvailableEmitter | null = null;`.
4. In `app.whenReady().then(() => {`, right after the `rebuildOnBoot` log and before `sweepStaleSessions`, insert:

```ts
  // Spec E5 and §7: push-triggered pulls. Every trace row the writer commits
  // raises a coalesced hint to the windows that show its session.
  const emitter = createRowsAvailableEmitter({
    targets: (sessionId) => {
      const main = mainWindow;
      return rowsAvailableTargets(sessionId, {
        main: main !== null && !main.isDestroyed() ? main.webContents : null,
        mainSessionId: state.session?.id ?? null,
        traceSenderIds: traceWindows?.sendersForSession(sessionId) ?? [],
        fromId: (id) => webContents.fromId(id) ?? null,
      });
    },
    now: () => performance.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    log: (message) => console.log(`[rows] ${message}`),
  });
  rowsAvailable = emitter;
  observeTraceAppends(db, (event) => emitter.notify(event.sessionId, event.seq));
```

5. In `app.on("will-quit", …)`, add `rowsAvailable?.dispose();` and `rowsAvailable = null;` before `terminals?.disposeAll();`.

- [ ] **Step 8: Run the tests to see them pass**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/main/rows-available.test.ts src/main/trace-allowlist.test.ts src/main/trace-window.test.ts src/shared/api.test.ts src/renderer/trace/ipc-source.test.ts src/renderer/trace/host.test.ts`

Expected: PASS, including the 300-run property.

- [ ] **Step 9: Package checks**

Run: `perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop test`, then `perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop typecheck`, then `perl -e 'alarm 170; exec @ARGV' pnpm lint`.

Expected: all exit 0. `pnpm lint` prints nothing after `> pnpm exec eslint .`. If `webContents.fromId` is typed `WebContents | undefined`, the `?? null` already narrows it. `main.webContents` satisfies `PushContents` structurally (`id`, `send`, `isDestroyed`).

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/package.json pnpm-lock.yaml apps/desktop/src/main/rows-available.ts apps/desktop/src/main/rows-available.test.ts apps/desktop/src/main/trace-allowlist.ts apps/desktop/src/main/trace-allowlist.test.ts apps/desktop/src/main/trace-window.ts apps/desktop/src/main/trace-window.test.ts apps/desktop/src/main/index.ts apps/desktop/src/shared/api.ts apps/desktop/src/shared/api.test.ts apps/desktop/src/renderer/trace/ipc-source.ts apps/desktop/src/renderer/trace/ipc-source.test.ts apps/desktop/src/renderer/trace/host.test.ts
git -c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com commit -m "feat(desktop): push trace:rowsAvailable hints to the windows showing a session"
```

---

### Task D-2: `EmbeddedWorkspace` and `mainHost` replacing the session view

The main window's tab strip and session scroll are replaced by the embedded viewer, keyed by session id and opening on Console. The Overview, Conversation and Decisions content moves unchanged into the `surfaces` host view (deviation 2). The composer and context rail stay in place until D-3. Main checks every host action. The task also adds the workspace phase of the Electron smoke, which D-3, D-4 and D-6 use for screenshots.

**Files:**
- Create: `apps/desktop/src/renderer/workspace/main-host.ts`, `EmbeddedWorkspace.tsx`, `session-surfaces.ts`, `surfaces-view.tsx`
- Create: `apps/desktop/src/renderer/test-support/fake-bridge.ts`
- Create: `apps/desktop/src/main/pipeline/smoke-script.ts`, `apps/desktop/src/main/smoke-workspace.ts`, `apps/desktop/scripts/smoke-workspace.mjs`
- Modify: `apps/desktop/src/renderer/components/WorkspaceHost.tsx` (whole file replaced)
- Modify: `apps/desktop/src/renderer/styles.css` (append the embed layout rules)
- Modify: `apps/desktop/src/shared/api.ts` (`overview.rescan`)
- Modify: `apps/desktop/src/main/pipeline/action-dispatcher.ts` (`answer_decision` option check)
- Modify: `apps/desktop/src/main/pipeline/types.ts` and `pipeline-runtime.ts` (`mockScriptFor`)
- Modify: `apps/desktop/src/main/smoke.ts` (workspace phase), `apps/desktop/src/main/index.ts` (smoke deps, mock script)
- Modify: `apps/desktop/package.json` (devDependencies), `pnpm-lock.yaml`, `apps/desktop/vitest.config.ts`
- Test: `apps/desktop/src/renderer/components/workspace-host.test.tsx` (new), `apps/desktop/src/renderer/workspace/main-host.test.ts` (new), `apps/desktop/src/main/ipc.test.ts`, `apps/desktop/src/main/pipeline/action-dispatcher.test.ts`, `apps/desktop/src/main/pipeline/smoke-script.test.ts` (new), `apps/desktop/src/main/pipeline/pipeline-runtime.test.ts`, `apps/desktop/src/main/smoke-workspace.test.ts` (new), `apps/desktop/src/main/smoke.test.ts`

**Interfaces:**
- Consumes (V-2): `TraceViewer` props `chrome`, `hostViews`, `initialView` and `renderSwitch`; `ViewerHost.answerDecision`, `openTraceWindow` and `rescanOverview`; the `ViewDefinition` and `ViewProps` types from `@jevcode/trace-viewer`. Consumes (D-1): `createIpcTraceSource(bridge.trace, sessionId)` with `onRowsAvailable`. Consumes (K-3): `"overview:rescan"` `{ repoRoot: string }` in `toMainRegistry` (invoked by the bridge; the main handler is M-6's). Also: `createDataController` from `@jevcode/trace-viewer/data-controller` (test only), `composerReducer` (`renderer/components/composer-prefill.ts`), and the ui-catalog `SurfaceManager` API.
- Produces:
  - `createMainHost(deps: MainHostDeps): ViewerHost` and `DECISION_ANSWER_KEY = "decision"`.
  - `EmbeddedWorkspace(props: { sessionId: string; repoRoot: string | null; onRequestChanges(text: string): void }): JSX.Element` and `HOST_VIEWS: readonly ViewDefinition[]`.
  - `useSessionSurfaces(bridge: JevcodeApi, sessionState: SessionStatePayload | null): SessionSurfaces` and `SurfacesContext`.
  - `surfacesView: ViewDefinition` with kind `"surfaces"`, label `"Surfaces"` and icon `"view-surfaces"`.
  - `JevcodeApi.overview.rescan(repoRoot: string): Promise<void>` (the handler is lane 04's).
  - `PipelineRuntimeOptions.mockScriptFor?: (input: SessionStartOptions) => MockAgentScript`.
  - `smokeMockScript(input, options?)` and `SMOKE_SCRIPT_DEFAULTS`.
  - `runWorkspaceSmoke(deps, options)` and `WorkspaceSmokeDeps`.
  - `installFakeBridge()` (renderer tests).

- [ ] **Step 1: Add the jsdom test tooling**

Run:

```bash
pnpm --filter jevcode-desktop add -D jsdom@30.1.0 @testing-library/react@^16.3.3 @testing-library/dom@^10.4.2
NP=$(ls -d node_modules/.pnpm/node-pty@*/node_modules/node-pty | head -1); ls "$NP/build/Release/pty.node" "$NP/build/Release/spawn-helper"
```

Expected: exits 0, and both node-pty files are listed (restore them as in D-1 Step 1 if not).

Replace `apps/desktop/vitest.config.ts` with:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Renderer component tests are .tsx and opt in with // @vitest-environment jsdom.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
```

- [ ] **Step 2: Write the shared renderer test fake**

Create `apps/desktop/src/renderer/test-support/fake-bridge.ts`:

```ts
import type { TraceRowsPage, TraceSessionSummary } from "@jevcode/contracts";
import { vi } from "vitest";

import type { AgentInstructionStatePayload, JevcodeApi } from "../../shared/api.js";
import type { ComposerPrefillPayload } from "../../shared/local-channels.js";

type Listener<T> = (payload: T) => void;
type RowsHint = { sessionId: string; lastSeq: number };

export function summaryFor(sessionId: string): TraceSessionSummary {
  return {
    sessionId,
    repoId: "repo_1",
    repoName: "api",
    prompt: `prompt for ${sessionId}`,
    state: "running",
    startedAt: "2026-10-02T10:00:00.000Z",
    endedAt: null,
    lastEventSeq: 0,
  };
}

const EMPTY_PAGE: TraceRowsPage = { rows: [], nextAfterSeq: null, lastSeq: 0, state: "running" };

/** A window.jevcode for jsdom tests: every invoke is a vi.fn, every push can be fired by hand. */
export function installFakeBridge() {
  const channel = new Map<string, Set<Listener<unknown>>>();
  const hints = new Set<Listener<RowsHint>>();
  const prefills = new Set<Listener<ComposerPrefillPayload>>();
  const instructions = new Set<Listener<AgentInstructionStatePayload>>();
  const rowsBySession = new Map<string, number>();
  const subscribe = <T>(set: Set<Listener<T>>, listener: Listener<T>): (() => void) => {
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  };
  const channelSet = (name: string): Set<Listener<unknown>> => {
    let set = channel.get(name);
    if (set === undefined) {
      set = new Set();
      channel.set(name, set);
    }
    return set;
  };

  const calls = {
    actionInvoke: vi.fn(async (_action: string, _params: Record<string, unknown>) => undefined),
    sendInstruction: vi.fn(async (_sessionId: string, _text: string, _mode?: "queue" | "steer") => undefined),
    resume: vi.fn(async (_sessionId: string) => undefined),
    interrupt: vi.fn(async (_sessionId: string) => undefined),
    cancelInstruction: vi.fn(async (_sessionId: string, _instructionId: string) => undefined),
    switchTo: vi.fn(async (_sessionId: string) => undefined),
    traceOpen: vi.fn(async (_sessionId: string) => undefined),
    traceRequestChanges: vi.fn(async (_request: unknown) => undefined),
    rescan: vi.fn(async (_repoRoot: string) => undefined),
    pin: vi.fn(async (_surfaceId: string, _pinned: boolean) => undefined),
    dismiss: vi.fn(async (_surfaceId: string) => undefined),
  };

  const api = {
    platform: "test",
    repo: {
      browse: vi.fn(async () => undefined),
      open: vi.fn(async () => undefined),
      listRecent: vi.fn(async () => []),
      listSessions: vi.fn(async () => []),
      close: vi.fn(async () => undefined),
    },
    session: { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), switchTo: calls.switchTo },
    agent: {
      interrupt: calls.interrupt,
      resume: calls.resume,
      sendInstruction: calls.sendInstruction,
      cancelInstruction: calls.cancelInstruction,
    },
    action: { invoke: calls.actionInvoke },
    terminal: {
      input: vi.fn(async () => undefined),
      resize: vi.fn(async () => undefined),
      getScrollback: vi.fn(async () => []),
    },
    surface: { pin: calls.pin, dismiss: calls.dismiss },
    telemetry: { flush: vi.fn(async () => ({ count: 0 })) },
    prefs: { get: vi.fn(async () => ({})), set: vi.fn(async () => ({})) },
    debug: {
      listTelemetry: vi.fn(async () => []),
      listEvents: vi.fn(async () => []),
      listJevDecisions: vi.fn(async () => []),
    },
    trace: {
      listSessions: vi.fn(async (request?: { sessionId?: string }) =>
        request?.sessionId === undefined ? [] : [summaryFor(request.sessionId)],
      ),
      rows: vi.fn(async (request: { sessionId: string }) => {
        rowsBySession.set(request.sessionId, (rowsBySession.get(request.sessionId) ?? 0) + 1);
        return EMPTY_PAGE;
      }),
      payloads: vi.fn(async () => []),
      open: calls.traceOpen,
      requestChanges: calls.traceRequestChanges,
      onRowsAvailable: (listener: Listener<RowsHint>) => subscribe(hints, listener),
    },
    overview: { rescan: calls.rescan },
    on: (name: string, listener: Listener<unknown>) => subscribe(channelSet(name), listener),
    onInstructionState: (listener: Listener<AgentInstructionStatePayload>) => subscribe(instructions, listener),
    onPrefsUpdated: () => () => undefined,
    onComposerPrefill: (listener: Listener<ComposerPrefillPayload>) => subscribe(prefills, listener),
  };

  window.jevcode = api as unknown as JevcodeApi;

  return {
    api: api as unknown as JevcodeApi,
    calls,
    rowsCalls: (sessionId: string): number => rowsBySession.get(sessionId) ?? 0,
    rowsListenerCount: (): number => hints.size,
    emitRowsAvailable: (payload: RowsHint): void => {
      for (const listener of [...hints]) listener(payload);
    },
    emitComposerPrefill: (payload: ComposerPrefillPayload): void => {
      for (const listener of [...prefills]) listener(payload);
    },
    emitInstructionState: (payload: AgentInstructionStatePayload): void => {
      for (const listener of [...instructions]) listener(payload);
    },
    emit: (name: string, payload: unknown): void => {
      for (const listener of [...channelSet(name)]) listener(payload);
    },
  };
}

export type FakeBridge = ReturnType<typeof installFakeBridge>;
```

- [ ] **Step 3: Write the failing renderer tests (Review Focus 4 lives here)**

Create `apps/desktop/src/renderer/workspace/main-host.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import type { JevcodeApi } from "../../shared/api.js";
import { DECISION_ANSWER_KEY, createMainHost } from "./main-host.js";

function deps(repoRoot: string | null = "/work/api") {
  const bridge = {
    action: { invoke: vi.fn(async () => undefined) },
    trace: { open: vi.fn(async () => undefined), requestChanges: vi.fn(async () => undefined) },
    overview: { rescan: vi.fn(async () => undefined) },
  };
  const prefill = vi.fn();
  const lines: string[] = [];
  const host = createMainHost({
    bridge: bridge as unknown as Pick<JevcodeApi, "action" | "trace" | "overview">,
    sessionId: "s1",
    repoRoot: () => repoRoot,
    prefill,
    log: (line) => lines.push(line),
  });
  return { bridge, prefill, lines, host };
}

describe("createMainHost (spec §9)", () => {
  it("hands a review note to the local composer and never over IPC", async () => {
    const { bridge, prefill, host } = deps();
    await host.requestChanges?.({ sessionId: "s1", selected: "step:3", text: "Re: step 3" });
    await host.requestChanges?.({ sessionId: "s2", selected: "step:3", text: "for another session" });
    expect(prefill).toHaveBeenCalledTimes(1);
    expect(prefill).toHaveBeenCalledWith("Re: step 3");
    expect(bridge.trace.requestChanges).not.toHaveBeenCalled();
  });

  it("answers a decision through the allowlisted action dispatch", async () => {
    const { bridge, host } = deps();
    await host.answerDecision?.({ decisionId: "dec_1", optionId: "fail_open" });
    expect(DECISION_ANSWER_KEY).toBe("decision");
    expect(bridge.action.invoke).toHaveBeenCalledWith("answer_decision", {
      decisionId: "dec_1",
      decision: { decision: "fail_open" },
    });
  });

  it("opens the trace window for its own session", () => {
    const { bridge, host } = deps();
    host.openTraceWindow?.();
    expect(bridge.trace.open).toHaveBeenCalledWith("s1");
  });

  it("asks main to rescan only the open repo", () => {
    const open = deps("/work/api");
    open.host.rescanOverview?.();
    expect(open.bridge.overview.rescan).toHaveBeenCalledWith("/work/api");
    const closed = deps(null);
    closed.host.rescanOverview?.();
    expect(closed.bridge.overview.rescan).not.toHaveBeenCalled();
  });

  it("logs WORKSPACE_READY once for the smoke", () => {
    const { lines, host } = deps();
    host.onReady?.({ rows: 4, loadedThroughSeq: 4 });
    host.onReady?.({ rows: 9, loadedThroughSeq: 9 });
    expect(lines).toEqual(["WORKSPACE_READY 4"]);
  });
});
```

Create `apps/desktop/src/renderer/components/workspace-host.test.tsx`:

```tsx
// @vitest-environment jsdom
import type { TraceSource, ViewerHost } from "@jevcode/trace-viewer";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RepoOpenedPayload, SessionStatePayload } from "../payload-types.js";
import { installFakeBridge, type FakeBridge } from "../test-support/fake-bridge.js";
import { WorkspaceHost } from "./WorkspaceHost.js";

const viewerLog = vi.hoisted(() => ({
  mounts: [] as Array<{ sessionId: string; chrome: string | undefined; initialView: string | undefined; hostViews: string[] }>,
  unmounts: [] as string[],
  hosts: [] as ViewerHost[],
}));

// The viewer itself is lane 02's and has its own tests. This stand-in keeps
// the part this lane owns observable: one real DataController per mount,
// started on mount and stopped on unmount, exactly as TraceViewer does.
vi.mock("@jevcode/trace-viewer", async () => {
  const React = await import("react");
  const { createDataController } = await import("@jevcode/trace-viewer/data-controller");
  interface FakeProps {
    source: TraceSource;
    host?: ViewerHost;
    chrome?: string;
    initialView?: string;
    hostViews?: readonly { kind: string }[];
    pollMs?: number;
  }
  function TraceViewer(props: FakeProps) {
    const [controller] = React.useState(() =>
      createDataController({ source: props.source, pollMs: props.pollMs ?? 1_000 }),
    );
    React.useEffect(() => {
      viewerLog.mounts.push({
        sessionId: props.source.sessionId,
        chrome: props.chrome,
        initialView: props.initialView,
        hostViews: (props.hostViews ?? []).map((view) => view.kind),
      });
      if (props.host !== undefined) viewerLog.hosts.push(props.host);
      controller.start();
      return () => {
        controller.stop();
        viewerLog.unmounts.push(props.source.sessionId);
      };
    }, [controller]);
    return React.createElement("div", { "data-testid": "viewer", "data-session": props.source.sessionId });
  }
  return { TraceViewer };
});

const REPO: RepoOpenedPayload = {
  repoId: "repo_1",
  path: "/work/api",
  gitRoot: "/work/api",
  branch: "main",
  baseCommit: "abc123",
};

function stateFor(sessionId: string): SessionStatePayload {
  return { sessionId, state: "running", changeUnitCount: 0, decisionCount: 0, ts: "2026-10-02T10:00:00.000Z" };
}

function host(sessionId: string) {
  return (
    <WorkspaceHost
      repo={REPO}
      sessionState={stateFor(sessionId)}
      activePrompt="Add Google OAuth"
      agentLine="Codex"
      onStart={() => undefined}
    />
  );
}

const prompt = (): HTMLTextAreaElement => screen.getByLabelText("Guide the agent") as HTMLTextAreaElement;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let bridge: FakeBridge;

beforeEach(() => {
  viewerLog.mounts.length = 0;
  viewerLog.unmounts.length = 0;
  viewerLog.hosts.length = 0;
  bridge = installFakeBridge();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("WorkspaceHost embeds the trace viewer (spec §9, E2)", () => {
  it("opens the active session on Console in embedded chrome with the Surfaces view", async () => {
    render(host("s1"));
    await waitFor(() => expect(bridge.rowsCalls("s1")).toBeGreaterThan(0));
    expect(viewerLog.mounts).toEqual([
      { sessionId: "s1", chrome: "embedded", initialView: "console", hostViews: ["surfaces"] },
    ]);
  });

  it("a push hint for the shown session fetches at once, without waiting for the 1 s poll", async () => {
    render(host("s1"));
    await waitFor(() => expect(bridge.rowsCalls("s1")).toBe(1));
    await act(async () => {
      await sleep(50);
    });
    const before = bridge.rowsCalls("s1");
    act(() => bridge.emitRowsAvailable({ sessionId: "s1", lastSeq: 7 }));
    await waitFor(() => expect(bridge.rowsCalls("s1")).toBe(before + 1), { timeout: 400 });
  });

  // Index Review Focus 4.
  it("switching sessions while live stops the old viewer, opens the new one on Console and resets the draft", async () => {
    const { rerender } = render(host("s1"));
    await waitFor(() => expect(bridge.rowsCalls("s1")).toBeGreaterThan(0));
    fireEvent.change(prompt(), { target: { value: "draft for s1" } });
    expect(prompt().value).toBe("draft for s1");

    rerender(host("s2"));
    await waitFor(() => expect(bridge.rowsCalls("s2")).toBeGreaterThan(0));

    expect(viewerLog.unmounts).toEqual(["s1"]);
    expect(viewerLog.mounts.map((mount) => [mount.sessionId, mount.initialView, mount.chrome])).toEqual([
      ["s1", "console", "embedded"],
      ["s2", "console", "embedded"],
    ]);
    expect(screen.getAllByTestId("viewer").map((element) => element.getAttribute("data-session"))).toEqual(["s2"]);
    expect(prompt().value).toBe("");

    // No stale rows: the stopped controller neither follows s1's hints nor polls.
    const s1Calls = bridge.rowsCalls("s1");
    act(() => bridge.emitRowsAvailable({ sessionId: "s1", lastSeq: 99 }));
    await act(async () => {
      await sleep(1_200);
    });
    expect(bridge.rowsCalls("s1")).toBe(s1Calls);
    expect(bridge.rowsListenerCount()).toBeLessThanOrEqual(1);
  });

  it("a review note for another session is held, then becomes the draft on switching to it", async () => {
    const { rerender } = render(host("s2"));
    act(() => bridge.emitComposerPrefill({ sessionId: "s1", text: "Re: step 3" }));
    expect(await screen.findByText(/Trace note for another session/)).toBeTruthy();
    expect(prompt().value).toBe("");
    rerender(host("s1"));
    await waitFor(() => expect(prompt().value).toBe("Re: step 3"));
    expect(bridge.calls.sendInstruction).not.toHaveBeenCalled();
  });

  it("Request changes in the embedded viewer prefills the local composer and sends nothing", async () => {
    render(host("s1"));
    await waitFor(() => expect(viewerLog.hosts).toHaveLength(1));
    await act(async () => {
      await viewerLog.hosts[0]?.requestChanges?.({ sessionId: "s1", selected: "step:3", text: "Re: step 3" });
    });
    await waitFor(() => expect(prompt().value).toBe("Re: step 3"));
    expect(bridge.calls.sendInstruction).not.toHaveBeenCalled();
    expect(bridge.calls.traceRequestChanges).not.toHaveBeenCalled();
  });

  it("shows the onboarding prompt before the first task", () => {
    render(
      <WorkspaceHost repo={REPO} sessionState={null} activePrompt="" agentLine="Codex" onStart={() => undefined} />,
    );
    expect(screen.getByText("What are we building?")).toBeTruthy();
    expect(viewerLog.mounts).toEqual([]);
  });
});
```

- [ ] **Step 4: Write the failing main-side tests**

Append to `apps/desktop/src/main/pipeline/action-dispatcher.test.ts`:

```ts
describe("answer_decision must name one of the decision's options (spec §4.3)", () => {
  const DECISION = {
    id: "dec_cache",
    sessionId: "sess-active",
    title: "Cache policy",
    context: "Redis is optional",
    severity: "required" as const,
    options: [
      { id: "fail_open", label: "Fail open", description: "Serve without the limiter" },
      { id: "fail_closed", label: "Fail closed", description: "Reject requests" },
    ],
    affectedChangeUnits: [],
    evidence: [],
    status: "open" as const,
  };

  function seeded(): JevcodeDb {
    const memory = openDb({ dbPath: ":memory:" });
    memory.upsertRepository({ id: "repo_o", path: "/o", gitRoot: "/o" });
    memory.createSession({ id: "sess-active", repoId: "repo_o", prompt: "demo" });
    memory.upsertDecision(DECISION);
    return memory;
  }

  it("rejects an option the decision does not offer before the runtime runs", async () => {
    const memory = seeded();
    const { runtime, calls } = stubRuntime();
    await expect(
      dispatchAction(makeDeps(memory, runtime), "answer_decision", {
        decisionId: "dec_cache",
        decision: { decision: "drop_the_database" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ACTION_PARAMS" } satisfies Partial<IpcError>);
    expect(calls).toEqual([]);
    memory.close();
  });

  it("passes a real option through", async () => {
    const memory = seeded();
    const { runtime, calls } = stubRuntime();
    await dispatchAction(makeDeps(memory, runtime), "answer_decision", {
      decisionId: "dec_cache",
      decision: { decision: "fail_open" },
    });
    expect(calls.map((call) => call.method)).toEqual(["answerDecision"]);
    memory.close();
  });

  it("leaves an unknown decision to the runtime's UNKNOWN_DECISION check", async () => {
    const memory = seeded();
    const { runtime, calls } = stubRuntime();
    await dispatchAction(makeDeps(memory, runtime), "answer_decision", {
      decisionId: "dec_missing",
      decision: { decision: "anything" },
    });
    expect(calls.map((call) => call.method)).toEqual(["answerDecision"]);
    memory.close();
  });
});
```

Append to `apps/desktop/src/main/ipc.test.ts`:

```ts
describe("main-window host actions are checked in main (spec §4.3, §10)", () => {
  it("a trace window cannot answer a decision", async () => {
    const { db, state } = seedRepoAndSession();
    const { runtime, calls } = stubRuntime();
    const handlers = registerAndCapture(makeDeps(db, runtime, state, () => "trace"));
    await expect(
      handlers.get(RendererToMainChannels.actionInvoke)!(TRUSTED_EVENT, {
        action: "answer_decision",
        params: { decisionId: "dec_1", decision: { decision: "x" } },
      }),
    ).rejects.toMatchObject({ code: "UNTRUSTED_SENDER" });
    expect(calls).toEqual([]);
    db.close();
  });
});
```

Create `apps/desktop/src/main/pipeline/smoke-script.test.ts`:

```ts
import { NormalizedAgentEventSchema } from "@jevcode/contracts";
import { describe, expect, it } from "vitest";

import { SMOKE_SCRIPT_DEFAULTS, smokeMockScript } from "./smoke-script.js";

const INPUT = { sessionId: "sess_smoke", repoId: "repo_1", repoPath: "/tmp/repo", prompt: "Smoke" };

describe("smokeMockScript", () => {
  it("emits four schema-valid events per step, spaced evenly, then completes", () => {
    const script = smokeMockScript(INPUT, { steps: 3, spacingMs: 150 });
    expect(script.entries).toHaveLength(3 * 4 + 1);
    for (const entry of script.entries) {
      expect(entry.kind).toBe("agent");
      expect(entry.delayMs).toBe(150);
      if (entry.kind === "agent") {
        expect(NormalizedAgentEventSchema.safeParse(entry.event).success).toBe(true);
        expect(entry.event.sessionId).toBe("sess_smoke");
      }
    }
    const last = script.entries.at(-1);
    expect(last?.kind === "agent" ? last.event.type : null).toBe("agent_completed");
    expect(script.prompt).toBe("Smoke");
  });

  it("defaults to a short run for screenshots", () => {
    expect(SMOKE_SCRIPT_DEFAULTS).toEqual({ steps: 6, spacingMs: 150 });
    expect(smokeMockScript(INPUT).entries).toHaveLength(6 * 4 + 1);
  });
});
```

Append to `apps/desktop/src/main/pipeline/pipeline-runtime.test.ts`, inside the existing `describe("PipelineRuntime honest lifecycle (D10)", …)` block (it uses that block's `createTempDb`, `collectEmit` and `waitFor`):

```ts
  it("starts a mock session from mockScriptFor when the input has no script", async () => {
    const dir = path.join(repoRoot, "apps/desktop/.test-tmp/mock-script-for");
    rmSync(dir, { recursive: true, force: true });
    const db = createTempDb(dir);
    const sessionId = "sess-mock-script-for";
    db.upsertRepository({ id: "repo-msf", path: dir, gitRoot: dir, branch: "test", baseCommit: "test" });
    db.createSession({ id: sessionId, repoId: "repo-msf", prompt: "demo" });
    const { emit } = collectEmit();
    const mockScriptFor = vi.fn((input: { sessionId: string; repoPath: string; prompt: string }) => ({
      sessionId: input.sessionId,
      repoPath: input.repoPath,
      cwd: input.repoPath,
      prompt: input.prompt,
      entries: [
        {
          kind: "agent" as const,
          event: { type: "agent_message" as const, sessionId: input.sessionId, role: "assistant" as const, text: "from mockScriptFor", ts: new Date().toISOString() },
        },
      ],
    }));
    const runtime = new PipelineRuntime({ db, emit, evidence: false, jevClient: new DegradeClient(), log: () => {}, mockScriptFor });
    try {
      await runtime.startSession({ sessionId, repoId: "repo-msf", repoPath: dir, prompt: "demo", agentMode: "mock" });
      await waitFor(
        () => db.listAgentEvents(sessionId).some((event) => event.type === "agent_message" && event.text === "from mockScriptFor"),
        8000,
        "scripted message stored",
      );
      expect(mockScriptFor).toHaveBeenCalledTimes(1);
      await runtime.syncAll();
      await runtime.stopSession(sessionId);
    } finally {
      db.close();
    }
  }, 30_000);
```

Create `apps/desktop/src/main/smoke-workspace.test.ts`:

```ts
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  SHOT_HEIGHT,
  SHOT_WIDTHS,
  SMOKE_PROMPT,
  openRepoScript,
  parseWorkspaceReady,
  runWorkspaceSmoke,
  startSessionScript,
} from "./smoke-workspace.js";
import type { WorkspaceSmokeDeps } from "./smoke-workspace.js";

function fake() {
  const listeners = new Set<(message: string) => void>();
  const execs: string[] = [];
  const files = new Map<string, Uint8Array>();
  const captures: Array<[number, number]> = [];
  const lines: string[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const deps: WorkspaceSmokeDeps = {
    exec: async (script) => {
      execs.push(script);
      return null;
    },
    onConsole: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    capture: async (width, height) => {
      captures.push([width, height]);
      return new Uint8Array([1, 2, 3]);
    },
    writeFile: (file, data) => {
      files.set(file, data);
    },
    setTimeout: (fn) => {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, fn);
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    log: (line) => lines.push(line),
  };
  return {
    deps,
    execs,
    files,
    captures,
    lines,
    console: (message: string) => {
      for (const listener of [...listeners]) listener(message);
    },
    fireTimers: () => {
      for (const [id, fn] of [...timers]) {
        timers.delete(id);
        fn();
      }
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("runWorkspaceSmoke", () => {
  it("opens the repo, starts the session, waits for the embedded viewer and captures 1440 and 1000", async () => {
    const run = fake();
    const done = runWorkspaceSmoke(run.deps, { repoPath: "/tmp/smoke-repo", shotsDir: "/tmp/shots" });
    await flush();
    expect(run.execs).toEqual([openRepoScript("/tmp/smoke-repo"), startSessionScript(SMOKE_PROMPT)]);
    run.console("TRACE_PERF tv:first-paint 12.00");
    run.console("WORKSPACE_READY 3");
    await done;
    expect(run.captures).toEqual(SHOT_WIDTHS.map((width) => [width, SHOT_HEIGHT]));
    expect([...run.files.keys()]).toEqual([
      path.join("/tmp/shots", "main-console-1440.png"),
      path.join("/tmp/shots", "main-console-1000.png"),
    ]);
    expect(run.lines[0]).toBe("SMOKE_WORKSPACE ready rows=3");
  });

  it("fails when the embedded viewer never reports ready", async () => {
    const run = fake();
    const done = runWorkspaceSmoke(run.deps, { repoPath: "/tmp/smoke-repo", shotsDir: null });
    await flush();
    run.fireTimers();
    await expect(done).rejects.toThrow(/WORKSPACE_READY not seen/);
  });

  it("JSON-encodes the repo path so a quote cannot break out of the script", () => {
    const script = openRepoScript('/tmp/a"b');
    expect(script).toContain(JSON.stringify('/tmp/a"b'));
    expect(script.startsWith("window.jevcode.repo.open(")).toBe(true);
  });

  it("parses only exact WORKSPACE_READY lines", () => {
    expect(parseWorkspaceReady("WORKSPACE_READY 12")).toBe(12);
    expect(parseWorkspaceReady("WORKSPACE_READY")).toBeNull();
    expect(parseWorkspaceReady("x WORKSPACE_READY 1")).toBeNull();
  });
});
```

Append to `apps/desktop/src/main/smoke.test.ts`:

```ts
describe("runSmoke, workspace phase", () => {
  it("JEVCODE_SMOKE_WORKSPACE=1 without JEVCODE_SMOKE_REPO fails instead of skipping", () => {
    const run = harness({ JEVCODE_SMOKE_WORKSPACE: "1" });
    run.main.emit("did-finish-load");
    expect(run.err[0]).toMatch(/^SMOKE_FAIL: JEVCODE_SMOKE_WORKSPACE=1 needs JEVCODE_SMOKE_REPO/);
    expect(run.result).toEqual({ succeeded: 0, failed: 1 });
  });
});
```

- [ ] **Step 5: Run the tests to see them fail**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/renderer/workspace/main-host.test.ts src/renderer/components/workspace-host.test.tsx src/main/pipeline/action-dispatcher.test.ts src/main/ipc.test.ts src/main/pipeline/smoke-script.test.ts src/main/smoke-workspace.test.ts src/main/smoke.test.ts`

Expected: FAIL. The new modules (`./main-host.js`, `./smoke-script.js`, `./smoke-workspace.js`) fail to resolve. `workspace-host.test.tsx` finds no `viewer` mount, because the old WorkspaceHost renders no TraceViewer. The dispatcher's option test resolves instead of rejecting. The new `ipc.test.ts` case already passes, because the allowlist predates this lane, and it stays as the guard. `smoke.test.ts` prints `SMOKE_OK` instead of failing. Run `pipeline-runtime.test.ts` separately (it takes about 30 s): the new test fails with a timeout on "scripted message stored".

- [ ] **Step 6: Implement the answer check, the bridge rescan call and `mockScriptFor`**

In `apps/desktop/src/main/pipeline/action-dispatcher.ts`, add `type AnswerDecisionParams` to the existing `@jevcode/contracts` import (it is already imported), and replace the `answer_decision` handler with:

```ts
  async answer_decision(deps, sessionId, params) {
    const answer = params as unknown as AnswerDecisionParams;
    assertOfferedOptions(deps.db, sessionId, answer);
    await deps.runtime.answerDecision(sessionId, answer);
  },
```

and add after the `handlers` object:

```ts
/**
 * Spec §4.3: the main window's embedded viewer answers decisions through this
 * dispatch, so an answer must name one of the decision's own options. A
 * decision that is not in the active session falls through to the runtime,
 * whose UNKNOWN_DECISION check owns that case.
 */
function assertOfferedOptions(db: JevcodeDb, sessionId: string, answer: AnswerDecisionParams): void {
  const decision = db.getDecision(answer.decisionId);
  if (decision === undefined || decision.sessionId !== sessionId || decision.options.length === 0) return;
  const offered = new Set(decision.options.map((option) => option.id));
  for (const value of Object.values(answer.decision)) {
    if (!offered.has(value)) {
      throw new IpcError(
        "INVALID_ACTION_PARAMS",
        `answer_decision: "${value}" is not an option of ${answer.decisionId}`,
      );
    }
  }
}
```

In `apps/desktop/src/shared/api.ts`, add to `interface JevcodeApi`, after `trace: { … };`:

```ts
  overview: {
    /** "Codebase map unavailable · Retry" (spec §6.6). Main window only; lane 04 (M-6) registers the handler. */
    rescan(repoRoot: string): Promise<void>;
  };
```

and to the returned object, after the `trace: { … },` block:

```ts
    overview: {
      rescan: async (repoRoot) => {
        await invoke("overview:rescan", { repoRoot });
      },
    },
```

In `apps/desktop/src/main/pipeline/types.ts`, add the import `import type { MockAgentScript } from "./mock-agent-adapter.js";` if it is not already imported. The file imports `type MockAgentScript` today, so check before adding a duplicate. Then add to `PipelineRuntimeOptions`, after `modelSelector?`:

```ts
  /** Script for a mock session started without input.mockScript (the Electron workspace smoke). */
  mockScriptFor?: (input: SessionStartOptions) => MockAgentScript;
```

In `apps/desktop/src/main/pipeline/pipeline-runtime.ts`, replace both occurrences of

```ts
const script = input.mockScript ?? defaultMockScript(input);
```

with

```ts
const script = input.mockScript ?? this.opts.mockScriptFor?.(input) ?? defaultMockScript(input);
```

Create `apps/desktop/src/main/pipeline/smoke-script.ts`:

```ts
import type { NormalizedAgentEvent } from "@jevcode/contracts";

import type { MockAgentScript, MockScriptEntry } from "./mock-agent-adapter.js";
import type { SessionStartOptions } from "./types.js";

export interface SmokeScriptOptions {
  /** Each step is a message, an edit claim, a command start and its completion. */
  steps: number;
  /** Gap before every entry; wider than the 50 ms hint window plus V-1's 50 ms hinted-commit gap, so each append is measured on its own. */
  spacingMs: number;
}

export const SMOKE_SCRIPT_DEFAULTS: SmokeScriptOptions = { steps: 6, spacingMs: 150 };

/** A deterministic mock agent run for the Electron workspace smoke (D-2 screenshots, D-6 append latency). */
export function smokeMockScript(
  input: Pick<SessionStartOptions, "sessionId" | "repoPath" | "prompt">,
  options: SmokeScriptOptions = SMOKE_SCRIPT_DEFAULTS,
): MockAgentScript {
  const sessionId = input.sessionId;
  const base = Date.now();
  let tick = 0;
  const ts = (): string => {
    tick += options.spacingMs;
    return new Date(base + tick).toISOString();
  };
  const agent = (event: NormalizedAgentEvent): MockScriptEntry => ({ kind: "agent", event, delayMs: options.spacingMs });
  const entries: MockScriptEntry[] = [];
  for (let step = 1; step <= options.steps; step += 1) {
    const file = `src/module-${step}.ts`;
    const command = `pnpm test -- module-${step}`;
    entries.push(
      agent({ type: "agent_message", sessionId, role: "assistant", text: `Step ${step}: updating ${file} and checking it.`, ts: ts() }),
      agent({ type: "file_changed", sessionId, path: file, ts: ts() }),
      agent({ type: "command_started", sessionId, command, ts: ts() }),
      agent({
        type: "command_completed",
        sessionId,
        command,
        exitCode: 0,
        stdout: `✓ module-${step} (3 tests)\n`,
        stderr: "",
        ts: ts(),
      }),
    );
  }
  entries.push(agent({ type: "agent_completed", sessionId, ts: ts() }));
  return { sessionId, repoPath: input.repoPath, cwd: input.repoPath, prompt: input.prompt, entries };
}
```

- [ ] **Step 7: Implement the renderer workspace**

Create `apps/desktop/src/renderer/workspace/main-host.ts`:

```ts
import type { ViewerHost } from "@jevcode/trace-viewer";

import type { JevcodeApi } from "../../shared/api.js";

/** ui-catalog Decision.tsx answers with this key when no suggested answer names one. */
export const DECISION_ANSWER_KEY = "decision";

export interface MainHostDeps {
  bridge: Pick<JevcodeApi, "action" | "trace" | "overview">;
  sessionId: string;
  repoRoot(): string | null;
  /** Appends a review note to this session's composer draft and focuses it (composerReducer "prefill"). */
  prefill(text: string): void;
  log(line: string): void;
}

/**
 * The main window's ViewerHost (spec §9). Each action goes through a channel
 * main already allowlists and validates: answers through action:invoke
 * (dispatchAction checks the option), the trace window through trace:open
 * (main checks the session), and rescans through overview:rescan (lane 04
 * registers and checks it). A review note stays local and is never sent.
 */
export function createMainHost(deps: MainHostDeps): ViewerHost {
  let ready = false;
  const report = (what: string) => (error: unknown) => {
    deps.log(`[workspace] ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
  };
  return {
    requestChanges: (request) => {
      if (request.sessionId !== deps.sessionId) return;
      deps.prefill(request.text);
    },
    answerDecision: ({ decisionId, optionId }) =>
      deps.bridge.action.invoke("answer_decision", {
        decisionId,
        decision: { [DECISION_ANSWER_KEY]: optionId },
      }),
    openTraceWindow: () => {
      void deps.bridge.trace.open(deps.sessionId).catch(report("trace:open"));
    },
    rescanOverview: () => {
      const repoRoot = deps.repoRoot();
      if (repoRoot === null) return;
      void deps.bridge.overview.rescan(repoRoot).catch(report("overview:rescan"));
    },
    onReady: (info) => {
      if (ready) return;
      ready = true;
      deps.log(`WORKSPACE_READY ${info.rows}`);
    },
  };
}
```

Create `apps/desktop/src/renderer/workspace/session-surfaces.ts`. Its body is the surfaces state moved out of the old `WorkspaceHost.tsx` (`slotForSurfaceId`, `eventKey`, `mergeEvents`, `isConversationEvent`, `surfaceMeta`, the restore effect, the push listeners, `togglePin`, `dismiss` and `entries`), with the same behavior:

```ts
import { NormalizedAgentEventSchema, type NormalizedAgentEvent } from "@jevcode/contracts";
import {
  SurfaceManager,
  useSurfaceManager,
  validateIncomingPatch,
  validateIncomingSpec,
} from "@jevcode/ui-catalog";
import type { SurfaceRecord } from "@jevcode/ui-catalog";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import type { JevcodeApi } from "../../shared/api.js";
import type { SessionStatePayload, UiSpecPatchPayload, UiSpecPayload } from "../payload-types.js";

export type SurfaceGroup = "change" | "decision" | "verification" | "detail";

export interface SurfaceMeta {
  group: SurfaceGroup;
  label: string;
  title: string;
}

export interface SurfaceEntry {
  surface: SurfaceRecord;
  meta: SurfaceMeta;
  updatedAt: number;
}

export const TERMINAL_SURFACE_ID = "terminal";

function slotForSurfaceId(surfaceId: string): "generative" | "raw" | "terminal" {
  if (surfaceId === TERMINAL_SURFACE_ID) return "terminal";
  if (surfaceId.startsWith("diff:") || surfaceId.startsWith("callsites:")) return "raw";
  return "generative";
}

export function eventKey(event: NormalizedAgentEvent): string {
  const detail =
    event.type === "agent_message"
      ? `${event.role}:${event.text}`
      : event.type === "command_started" || event.type === "command_completed"
        ? event.command
        : event.type === "tool_started" || event.type === "tool_completed"
          ? event.tool
          : event.type === "file_read" || event.type === "file_changed"
            ? event.path
            : event.type === "test_started" || event.type === "test_completed"
              ? event.command
              : event.type === "agent_failed"
                ? event.error
                : event.type;
  return `${event.ts}:${event.type}:${detail}`;
}

function mergeEvents(
  current: readonly NormalizedAgentEvent[],
  incoming: readonly NormalizedAgentEvent[],
): NormalizedAgentEvent[] {
  const byKey = new Map<string, NormalizedAgentEvent>();
  for (const event of [...current, ...incoming]) byKey.set(eventKey(event), event);
  return [...byKey.values()].sort((a, b) => a.ts.localeCompare(b.ts)).slice(-160);
}

export function isConversationEvent(event: NormalizedAgentEvent): boolean {
  return (
    event.type === "agent_started" ||
    event.type === "agent_message" ||
    event.type === "agent_waiting" ||
    event.type === "agent_completed" ||
    event.type === "agent_failed"
  );
}

export function surfaceMeta(surface: SurfaceRecord): SurfaceMeta {
  const elements = Object.values(surface.spec.elements) as Array<{ type: string; props?: Record<string, unknown> }>;
  const root = surface.spec.elements[surface.spec.root] as { type: string; props?: Record<string, unknown> } | undefined;
  const hasType = (type: string) => elements.some((element) => element.type === type);
  const titleCandidate =
    root?.props?.["title"] ?? elements.find((element) => typeof element.props?.["title"] === "string")?.props?.["title"];
  const title = typeof titleCandidate === "string" ? titleCandidate : "Session detail";
  if (surface.id === "completion") return { group: "verification", label: "Completed", title };
  if (hasType("Decision") || surface.id.startsWith("decision:")) return { group: "decision", label: "Decision", title };
  if (hasType("FailureAnalysis")) return { group: "verification", label: "Needs attention", title };
  if (hasType("TestMatrix") || surface.id.startsWith("validation:")) return { group: "verification", label: "Verification", title };
  if (hasType("CodeDiff") || surface.id.startsWith("diff:")) return { group: "detail", label: "Code detail", title };
  return { group: "change", label: "Change", title };
}

export interface SessionSurfaces {
  sessionId: string | null;
  sessionState: SessionStatePayload | null;
  manager: SurfaceManager;
  entries: readonly SurfaceEntry[];
  events: readonly NormalizedAgentEvent[];
  recordedFiles: readonly string[];
  togglePin(surfaceId: string): void;
  dismiss(surfaceId: string): void;
}

/** The generative surfaces and agent activity of the shown session, restored from storage and kept live by pushes. */
export function useSessionSurfaces(bridge: JevcodeApi, sessionState: SessionStatePayload | null): SessionSurfaces {
  const sessionId = sessionState?.sessionId ?? null;
  const [manager, setManager] = useState(() => new SurfaceManager());
  const surfacesApi = useSurfaceManager(manager);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const [events, setEvents] = useState<NormalizedAgentEvent[]>([]);
  const [recordedFiles, setRecordedFiles] = useState<string[]>([]);

  useEffect(() => {
    setManager(new SurfaceManager());
    setEvents([]);
    setRecordedFiles([]);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return undefined;
    let cancelled = false;
    void bridge.debug
      .listEvents(sessionId, 2000)
      .then((stored) => {
        if (cancelled) return;
        const restored = stored.flatMap((record) => {
          if (record.type !== "agent_event") return [];
          const parsed = NormalizedAgentEventSchema.safeParse(record.payload);
          return parsed.success ? [parsed.data] : [];
        });
        setEvents((current) => mergeEvents(restored, current));
        setRecordedFiles([
          ...new Set(
            stored.flatMap((record) => {
              if (record.type !== "change_unit") return [];
              const files = record.payload["files"];
              return Array.isArray(files) ? files.filter((file): file is string => typeof file === "string") : [];
            }),
          ),
        ]);
        const decisionStatuses = new Map<string, string>();
        for (const record of stored) {
          if (record.type !== "decision") continue;
          const id = record.payload["id"];
          const status = record.payload["status"];
          if (typeof id === "string" && typeof status === "string") decisionStatuses.set(id, status);
        }
        const snapshots = new Map<string, { surfaceId: string; spec: UiSpecPayload["spec"]; seq: number }>();
        for (const record of stored) {
          if (record.type !== "ui_snapshot") continue;
          const surfaceId = record.payload["surfaceId"];
          if (typeof surfaceId !== "string") continue;
          const validated = validateIncomingSpec(record.payload["spec"]);
          if (!validated.ok) continue;
          snapshots.set(surfaceId, { surfaceId, spec: validated.spec, seq: record.seq });
        }
        const eligible = [...snapshots.values()]
          .filter(
            (snapshot) =>
              !snapshot.surfaceId.startsWith("decision:") ||
              decisionStatuses.get(snapshot.surfaceId.slice("decision:".length)) === "open",
          )
          .sort((a, b) => a.seq - b.seq);
        const snapshot =
          [...eligible].reverse().find((candidate) => candidate.surfaceId !== "completion") ??
          eligible.find((candidate) => candidate.surfaceId === "completion");
        if (snapshot !== undefined) {
          manager.propose({ id: snapshot.surfaceId, spec: snapshot.spec, slot: slotForSurfaceId(snapshot.surfaceId) });
        }
      })
      .catch((error: unknown) => {
        console.error("failed to restore session activity", error);
      });
    const offEvent = bridge.on("agent:event", (event) => {
      if (event.sessionId === sessionId) setEvents((current) => mergeEvents(current, [event]));
    });
    const offChangeUnit = bridge.on("changeunit:upsert", (payload) => {
      if (payload.sessionId !== sessionId) return;
      setRecordedFiles((current) => [...new Set([...current, ...payload.changeUnit.files])]);
    });
    const offDecisionResolved = bridge.on("decision:resolved", (payload) => {
      if (payload.sessionId === sessionId) manager.dismiss(`decision:${payload.decisionId}`);
    });
    return () => {
      cancelled = true;
      offEvent();
      offChangeUnit();
      offDecisionResolved();
    };
  }, [bridge, manager, sessionId]);

  useEffect(() => {
    const accepts = (payloadSessionId: string) =>
      sessionIdRef.current === null || payloadSessionId === sessionIdRef.current;
    const offSpec = bridge.on("ui:spec", (payload: UiSpecPayload) => {
      if (!accepts(payload.sessionId)) return;
      const validated = validateIncomingSpec(payload.spec);
      if (!validated.ok) {
        console.error(`dropping invalid ui:spec for ${payload.surfaceId}: ${validated.error}`);
        return;
      }
      manager.propose({ id: payload.surfaceId, spec: validated.spec, slot: slotForSurfaceId(payload.surfaceId) });
    });
    const offPatch = bridge.on("ui:specPatch", (payload: UiSpecPatchPayload) => {
      if (!accepts(payload.sessionId)) return;
      const validated = validateIncomingPatch(payload.patch);
      if (!validated.ok) {
        console.error(`dropping invalid ui:specPatch for ${payload.surfaceId}: ${validated.error}`);
        return;
      }
      manager.applyPatch(payload.surfaceId, validated.patch);
    });
    return () => {
      offSpec();
      offPatch();
    };
  }, [bridge, manager]);

  const togglePin = useCallback(
    (surfaceId: string) => {
      const record =
        surfacesApi.generative.find((surface) => surface.id === surfaceId) ??
        surfacesApi.raws.find((surface) => surface.id === surfaceId);
      const pinned = record?.pinned ?? false;
      void bridge.surface.pin(surfaceId, !pinned);
      if (pinned) manager.unpin(surfaceId);
      else manager.pin(surfaceId);
    },
    [bridge, manager, surfacesApi.generative, surfacesApi.raws],
  );

  const dismiss = useCallback(
    (surfaceId: string) => {
      void bridge.surface.dismiss(surfaceId);
      manager.dismiss(surfaceId);
    },
    [bridge, manager],
  );

  const entries = useMemo(
    () =>
      [...surfacesApi.generative, ...surfacesApi.raws]
        .map((surface) => ({ surface, meta: surfaceMeta(surface), updatedAt: surface.createdAt }))
        .sort((a, b) => a.updatedAt - b.updatedAt),
    [surfacesApi.generative, surfacesApi.raws],
  );

  return useMemo(
    () => ({ sessionId, sessionState, manager, entries, events, recordedFiles, togglePin, dismiss }),
    [sessionId, sessionState, manager, entries, events, recordedFiles, togglePin, dismiss],
  );
}

export const SurfacesContext = createContext<SessionSurfaces | null>(null);

export function useSurfacesContext(): SessionSurfaces {
  const surfaces = useContext(SurfacesContext);
  if (surfaces === null) throw new Error("SurfacesView must render inside SurfacesContext");
  return surfaces;
}
```

Create `apps/desktop/src/renderer/workspace/surfaces-view.tsx`. Its body is the old tab strip and session scroll, moved as they are. `ActivityMark`, `MessageText`, `ActivityEvent` and `SessionOverview` are copied verbatim from the old `WorkspaceHost.tsx` lines 139-324, with the `entries` parameter typed `readonly SurfaceEntry[]`:

```tsx
import type { Spec } from "@json-render/core";
import { JSONUIProvider, Renderer } from "@json-render/react";
import type { NormalizedAgentEvent } from "@jevcode/contracts";
import type { ViewDefinition, ViewProps } from "@jevcode/trace-viewer";
import { agentEventLabel, formatClock } from "@jevcode/trace-viewer/model";
import { registry } from "@jevcode/ui-catalog";
import { useEffect, useMemo, useState } from "react";

import type { SessionStatePayload } from "../payload-types.js";
import { eventKey, isConversationEvent, useSurfacesContext, type SurfaceEntry } from "./session-surfaces.js";

type SurfacesFilter = "overview" | "conversation" | "decisions";
const MAX_VISIBLE_EVENTS = 80;

/* ActivityMark, MessageText, ActivityEvent: verbatim from the old WorkspaceHost.tsx (lines 139-244). */

/* SessionOverview: verbatim from the old WorkspaceHost.tsx (lines 247-324), with
   `entries: readonly SurfaceEntry[]` and `events: readonly NormalizedAgentEvent[]`. */

/** Spec E3: today's Overview, Conversation and Decisions content as one host-registered view. */
export function SurfacesView({ active }: ViewProps) {
  const surfaces = useSurfacesContext();
  const { manager, entries, events, sessionState } = surfaces;
  const [filter, setFilter] = useState<SurfacesFilter>("overview");
  const [root, setRoot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setFilter("overview");
  }, [surfaces.sessionId]);

  // The SurfaceManager defers swaps while the reader is pointing at or using the surfaces.
  useEffect(() => {
    if (root === null) return undefined;
    const onPointerEnter = () => manager.setPointerInside(true);
    const onPointerLeave = () => manager.setPointerInside(false);
    const onInteract = () => manager.notifyInteraction();
    root.addEventListener("pointerenter", onPointerEnter);
    root.addEventListener("pointerleave", onPointerLeave);
    root.addEventListener("pointerdown", onInteract);
    root.addEventListener("wheel", onInteract);
    root.addEventListener("keydown", onInteract);
    return () => {
      root.removeEventListener("pointerenter", onPointerEnter);
      root.removeEventListener("pointerleave", onPointerLeave);
      root.removeEventListener("pointerdown", onInteract);
      root.removeEventListener("wheel", onInteract);
      root.removeEventListener("keydown", onInteract);
    };
  }, [manager, root]);

  const visibleEntries = useMemo(() => {
    if (filter === "decisions") return entries.filter((entry) => entry.meta.group === "decision");
    return filter === "overview" ? entries : [];
  }, [entries, filter]);

  const visibleEvents = useMemo(
    () => events.filter((event) => filter === "conversation" && isConversationEvent(event)).slice(-MAX_VISIBLE_EVENTS),
    [events, filter],
  );
  const openDecisions = entries.filter((entry) => entry.meta.group === "decision").length;

  return (
    <section className="surfaces-view" ref={setRoot} data-active={active ? "true" : "false"} aria-label="Surfaces">
      <nav className="workspace-tabs" aria-label="Surfaces views">
        <button type="button" aria-pressed={filter === "overview"} onClick={() => setFilter("overview")}>
          Overview
        </button>
        <button type="button" aria-pressed={filter === "conversation"} onClick={() => setFilter("conversation")}>
          Conversation <span>{events.filter(isConversationEvent).length}</span>
        </button>
        <button type="button" aria-pressed={filter === "decisions"} onClick={() => setFilter("decisions")}>
          Decisions <span>{openDecisions}</span>
        </button>
      </nav>
      <div className="session-scroll">
        {filter === "overview" && sessionState ? (
          <SessionOverview sessionState={sessionState} events={events} entries={entries} openDecisions={openDecisions} />
        ) : null}
        {visibleEvents.length === 0 && visibleEntries.length === 0 ? (
          <div className="activity-empty">
            <span className="activity-pulse" />
            <h2>{filter === "conversation" ? "No conversation yet" : "No decisions yet"}</h2>
            <p>
              {filter === "conversation"
                ? "Meaningful agent updates will appear here without tool or command noise."
                : "Jev will place decisions here when your input is needed."}
            </p>
          </div>
        ) : null}
        {visibleEvents.length > 0 ? (
          <div className="activity-feed" aria-live="polite">
            {visibleEvents.map((event) => (
              <ActivityEvent key={eventKey(event)} event={event} />
            ))}
          </div>
        ) : null}
        {visibleEntries.length > 0 ? (
          <div className="work-products">
            <div className="work-products-heading">
              <h2>{filter === "decisions" ? "Decisions to make" : "Generative views"}</h2>
              <span className="jev-view-label">Jev · {visibleEntries.length}</span>
            </div>
            {visibleEntries.map(({ surface, meta }) => (
              <article
                key={surface.id}
                className={`surface surface-${meta.group}`}
                data-surface-id={surface.id}
                data-pinned={surface.pinned ? "true" : "false"}
              >
                <div className="surface-chrome">
                  <div className="surface-heading">
                    <span className={`surface-kind surface-kind-${meta.group}`}>{meta.label}</span>
                    <span className="surface-title">{meta.title}</span>
                  </div>
                  <span className="surface-actions">
                    <button
                      type="button"
                      className={surface.pinned ? "active" : ""}
                      aria-pressed={surface.pinned}
                      onClick={() => surfaces.togglePin(surface.id)}
                    >
                      {surface.pinned ? "Kept" : "Keep"}
                    </button>
                    <button type="button" onClick={() => surfaces.dismiss(surface.id)}>
                      Dismiss
                    </button>
                  </span>
                </div>
                <div className="surface-content">
                  <JSONUIProvider registry={registry}>
                    <Renderer spec={surface.spec as unknown as Spec} registry={registry} />
                  </JSONUIProvider>
                </div>
              </article>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

export const surfacesView: ViewDefinition = {
  kind: "surfaces",
  label: "Surfaces",
  icon: "view-surfaces",
  Component: SurfacesView,
};
```

Paste the four helper components where the two comments stand, taken from `git show HEAD:apps/desktop/src/renderer/components/WorkspaceHost.tsx | sed -n '139,324p'` (HEAD is the pre-D-2 file). The only edits are the `entries` and `events` parameter types in `SessionOverview`. Keep `NormalizedAgentEvent` and `SessionStatePayload` imported, because those components use them.

Create `apps/desktop/src/renderer/workspace/EmbeddedWorkspace.tsx`:

```tsx
import { TRACE_LIVE_POLL_MS } from "@jevcode/contracts";
import { TraceViewer } from "@jevcode/trace-viewer";
import type { ViewDefinition } from "@jevcode/trace-viewer";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";

import { getBridge } from "../bridge.js";
import { createIpcTraceSource } from "../trace/ipc-source.js";
import { createMainHost } from "./main-host.js";
import { surfacesView } from "./surfaces-view.js";

/** Host views after the built-in four; key 4 is Surfaces (spec §3.7, §8.6). */
export const HOST_VIEWS: readonly ViewDefinition[] = [surfacesView];

export interface EmbeddedWorkspaceProps {
  sessionId: string;
  repoRoot: string | null;
  onRequestChanges(text: string): void;
}

/**
 * The main window's center column (spec §9, E2): the trace viewer for one
 * session, Console first, in embedded chrome. The parent keys this component
 * by session id, so a switch unmounts the viewer (its DataController stops and
 * drops its push subscription) and mounts a fresh one on Console. Source and
 * host are created once per session.
 */
export function EmbeddedWorkspace(props: EmbeddedWorkspaceProps) {
  const bridge = getBridge();
  const latest = useRef(props);
  latest.current = props;
  const [switcher, setSwitcher] = useState<ReactNode>(null);
  const placeSwitch = useCallback((node: ReactNode) => setSwitcher(() => node), []);

  const source = useMemo(() => createIpcTraceSource(bridge.trace, props.sessionId), [bridge, props.sessionId]);
  const host = useMemo(
    () =>
      createMainHost({
        bridge,
        sessionId: props.sessionId,
        repoRoot: () => latest.current.repoRoot,
        prefill: (text) => latest.current.onRequestChanges(text),
        log: (line) => console.log(line),
      }),
    [bridge, props.sessionId],
  );

  return (
    <div className="embedded-workspace">
      <div className="workspace-bar">{switcher}</div>
      <div className="workspace-viewer">
        <TraceViewer
          key={props.sessionId}
          source={source}
          host={host}
          chrome="embedded"
          initialView="console"
          hostViews={HOST_VIEWS}
          renderSwitch={placeSwitch}
          pollMs={TRACE_LIVE_POLL_MS}
        />
      </div>
    </div>
  );
}
```

Replace `apps/desktop/src/renderer/components/WorkspaceHost.tsx` with the following. The composer, the trace-note notice and the context rail are the old file's code, unchanged except that they read from `surfaces`. D-3 replaces them.

```tsx
import { agentEventLabel, agentStateLabel, truncateMiddle } from "@jevcode/trace-viewer/model";
import { setActionDispatcher } from "@jevcode/ui-catalog";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import type { AgentInstructionStatePayload } from "../../shared/api.js";
import { getBridge } from "../bridge.js";
import type { RepoOpenedPayload, SessionStatePayload } from "../payload-types.js";
import { EmbeddedWorkspace } from "../workspace/EmbeddedWorkspace.js";
import { SurfacesContext, useSessionSurfaces } from "../workspace/session-surfaces.js";
import { composerReducer, initialComposer, traceNoteTarget } from "./composer-prefill.js";
import { TaskPrompt } from "./TaskPrompt.js";

interface WorkspaceHostProps {
  repo: RepoOpenedPayload | null;
  sessionState: SessionStatePayload | null;
  activePrompt: string;
  agentLine: string;
  onStart: (prompt: string) => void | Promise<void>;
}

type InstructionMode = "steer" | "queue";

export function WorkspaceHost(props: WorkspaceHostProps) {
  const bridge = getBridge();
  const sessionId = props.sessionState?.sessionId ?? null;
  const surfaces = useSessionSurfaces(bridge, props.sessionState);
  const { entries, events, recordedFiles } = surfaces;
  const [pending, setPending] = useState<AgentInstructionStatePayload["pending"]>([]);
  const [instructionMode, setInstructionMode] = useState<InstructionMode>("steer");
  const [composer, dispatchComposer] = useReducer(composerReducer, sessionId, initialComposer);
  const instruction = composer.draft;
  const traceNote = composer.held;
  const focusPending = composer.focusPending;
  const noteSessionId = traceNote?.note.sessionId ?? null;
  const repoId = props.repo?.repoId ?? null;
  const [noteTarget, setNoteTarget] = useState<{ sessionId: string; prompt: string | undefined } | null>(null);
  const setInstruction = (draft: string) => dispatchComposer({ type: "edit", draft });
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setActionDispatcher((action, params) => {
      void bridge.action.invoke(action, params);
    });
    return () => {
      setActionDispatcher(undefined);
    };
  }, [bridge]);

  useEffect(() => {
    setPending([]);
    setActionError(null);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return undefined;
    return bridge.onInstructionState((instructionState) => {
      if (instructionState.sessionId === sessionId) setPending(instructionState.pending);
    });
  }, [bridge, sessionId]);

  useEffect(() => {
    if (noteSessionId === null || repoId === null) return undefined;
    let cancelled = false;
    void bridge.repo
      .listSessions(repoId)
      .then((sessions) => {
        if (cancelled) return;
        setNoteTarget({ sessionId: noteSessionId, prompt: sessions.find((s) => s.sessionId === noteSessionId)?.prompt });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bridge, repoId, noteSessionId]);

  // The draft belongs to a session: a switch resets it, then applies a note
  // held for the new session (composerReducer, spec §8.5 of the viewer spec).
  useEffect(() => {
    dispatchComposer({ type: "sessionChanged", sessionId });
  }, [sessionId]);

  useEffect(() => {
    return bridge.onComposerPrefill((payload) => {
      dispatchComposer({ type: "prefill", payload });
    });
  }, [bridge]);

  useEffect(() => {
    if (!focusPending) return;
    const element = composerRef.current;
    if (element === null || element.disabled) return;
    element.focus();
    const end = element.value.length;
    element.setSelectionRange(end, end);
    element.scrollTop = element.scrollHeight;
    dispatchComposer({ type: "focusDone" });
  }, [focusPending, sending, sessionId]);

  // The embedded viewer's "Request changes": the same path as a trace window's note, kept local.
  const onRequestChanges = useCallback(
    (text: string) => {
      if (sessionId !== null) dispatchComposer({ type: "prefill", payload: { sessionId, text } });
    },
    [sessionId],
  );

  const changedFiles = useMemo(() => {
    const files = new Set<string>(recordedFiles);
    for (const event of events) {
      if (event.type === "file_changed") files.add(event.path);
    }
    for (const entry of entries) {
      for (const element of Object.values(entry.surface.spec.elements) as Array<{ props?: Record<string, unknown> }>) {
        const file = element.props?.["file"];
        if (typeof file === "string") files.add(file);
        const elementFiles = element.props?.["files"];
        if (Array.isArray(elementFiles)) {
          for (const item of elementFiles) if (typeof item === "string") files.add(item);
        }
      }
    }
    return [...files];
  }, [entries, events, recordedFiles]);

  const latestAssistant = [...events].reverse().find((event) => event.type === "agent_message" && event.role === "assistant");
  const latestEvent = [...events]
    .reverse()
    .find(
      (event) =>
        event.type === "agent_message" ||
        event.type === "file_changed" ||
        event.type === "test_completed" ||
        event.type === "agent_waiting" ||
        event.type === "agent_completed" ||
        event.type === "agent_failed",
    );
  const state = props.sessionState?.state;

  const sendInstruction = async () => {
    const text = instruction.trim();
    if (!sessionId || text.length === 0 || sending) return;
    const sentDraft = instruction;
    setSending(true);
    setActionError(null);
    try {
      const shouldResume = state === "completed" || state === "paused" || state === "failed";
      await bridge.agent.sendInstruction(sessionId, text, shouldResume ? "queue" : instructionMode);
      if (shouldResume) await bridge.agent.resume(sessionId);
      dispatchComposer({ type: "sent", text: sentDraft });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  const switchToTraceNote = () => {
    const note = traceNote?.note;
    if (note === undefined) return;
    setActionError(null);
    void bridge.session.switchTo(note.sessionId).catch((error: unknown) => {
      setActionError(error instanceof Error ? error.message : String(error));
    });
  };

  const toggleAgent = async () => {
    if (!sessionId || !state) return;
    setActionError(null);
    try {
      if (state === "running" || state === "starting") await bridge.agent.interrupt(sessionId);
      else if (state === "paused") await bridge.agent.resume(sessionId);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  if (props.activePrompt.trim().length === 0 || sessionId === null) {
    return (
      <section className="workspace workspace-onboarding">
        <TaskPrompt repo={props.repo} agentLine={props.agentLine} onSubmit={props.onStart} />
      </section>
    );
  }

  return (
    <section className="workspace workspace-session">
      <div className="session-main">
        {/* session-heading: verbatim from the old file (lines 712-730) */}
        <SurfacesContext.Provider value={surfaces}>
          <EmbeddedWorkspace
            key={sessionId}
            sessionId={sessionId}
            repoRoot={props.repo?.gitRoot ?? null}
            onRequestChanges={onRequestChanges}
          />
        </SurfacesContext.Provider>
        {/* session-composer: verbatim from the old file (lines 831-918) */}
      </div>
      {/* context-rail: verbatim from the old file (lines 921-997), minus the
          "View session overview" button (the tab filter now lives in SurfacesView) */}
    </section>
  );
}
```

Replace the three JSX comments with the cited blocks of the old file, which are still in git: `git show HEAD:apps/desktop/src/renderer/components/WorkspaceHost.tsx | sed -n '712,730p;831,918p;921,997p'`. The blocks reference only names declared above (`state`, `toggleAgent`, `traceNote`, `noteTarget`, `noteSessionId`, `switchToTraceNote`, `dispatchComposer`, `composerRef`, `instruction`, `sending`, `setInstruction`, `sendInstruction`, `instructionMode`, `setInstructionMode`, `actionError`, `latestEvent`, `latestAssistant`, `changedFiles`, `pending`, `bridge`, `sessionId`, `agentStateLabel`, `agentEventLabel`, `truncateMiddle`, `traceNoteTarget`). Delete the rail's `{changedFiles.length > 8 ? (<button … onClick={() => setFilter("overview")}>View session overview</button>) : null}`.

Append to `apps/desktop/src/renderer/styles.css`:

```css
/* Embedded viewer (spec §3.1): the switcher bar above, the viewer filling the rest. */
.embedded-workspace {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.workspace-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  padding: 0 12px;
}

.workspace-viewer {
  position: relative;
  flex: 1;
  min-height: 0;
}

.surfaces-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
```

- [ ] **Step 8: Implement the workspace smoke phase**

Create `apps/desktop/src/main/smoke-workspace.ts`:

```ts
import path from "node:path";

/**
 * JEVCODE_SMOKE_WORKSPACE=1: drives the real main window through the real IPC
 * path. It opens a git repo, starts a mock session, waits for the embedded
 * viewer's WORKSPACE_READY and captures the window at 1440 and 1000 px. D-6
 * adds append latency and the view walk. Electron is reached only through
 * WorkspaceSmokeDeps, so vitest drives every path with fakes.
 */

export const WORKSPACE_READY_TIMEOUT_MS = 30_000;
export const SHOT_WIDTHS = [1440, 1000] as const;
export const SHOT_HEIGHT = 900;
export const SMOKE_PROMPT = "Smoke: show the Console while the mock agent works";

export interface WorkspaceSmokeDeps {
  /** mainWindow.webContents.executeJavaScript(script, true). */
  exec(script: string): Promise<unknown>;
  /** Every main-window console line; returns the unsubscribe. */
  onConsole(listener: (message: string) => void): () => void;
  /** Resizes the window's content to width × height, lets it settle, returns a PNG. */
  capture(width: number, height: number): Promise<Uint8Array>;
  writeFile(filePath: string, data: Uint8Array): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  log(line: string): void;
}

export interface WorkspaceSmokeOptions {
  repoPath: string;
  shotsDir: string | null;
}

export function parseWorkspaceReady(message: string): number | null {
  const match = /^WORKSPACE_READY (\d+)$/.exec(message);
  return match === null ? null : Number(match[1]);
}

export function openRepoScript(repoPath: string): string {
  return `window.jevcode.repo.open(${JSON.stringify(repoPath)})`;
}

export function startSessionScript(prompt: string): string {
  return `(async () => {
    const [repo] = await window.jevcode.repo.listRecent(1);
    if (repo === undefined) throw new Error("no recent repo after repo:open");
    await window.jevcode.session.start(repo.repoId, ${JSON.stringify(prompt)});
    return repo.repoId;
  })()`;
}

export function waitForLine<T>(
  deps: Pick<WorkspaceSmokeDeps, "onConsole" | "setTimeout" | "clearTimeout">,
  parse: (message: string) => T | null,
  timeoutMs: number,
  what: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: unknown = null;
    const off = deps.onConsole((message) => {
      const value = parse(message);
      if (value === null) return;
      if (timer !== null) deps.clearTimeout(timer);
      off();
      resolve(value);
    });
    timer = deps.setTimeout(() => {
      off();
      reject(new Error(`${what} not seen within ${timeoutMs / 1000}s`));
    }, timeoutMs);
  });
}

export async function captureShots(
  deps: Pick<WorkspaceSmokeDeps, "capture" | "writeFile" | "log">,
  shotsDir: string | null,
): Promise<void> {
  if (shotsDir === null) return;
  for (const width of SHOT_WIDTHS) {
    const png = await deps.capture(width, SHOT_HEIGHT);
    const file = path.join(shotsDir, `main-console-${width}.png`);
    deps.writeFile(file, png);
    deps.log(`SMOKE_SHOT ${file}`);
  }
}

export async function runWorkspaceSmoke(deps: WorkspaceSmokeDeps, options: WorkspaceSmokeOptions): Promise<void> {
  const ready = waitForLine(deps, parseWorkspaceReady, WORKSPACE_READY_TIMEOUT_MS, "WORKSPACE_READY");
  ready.catch(() => undefined);
  await deps.exec(openRepoScript(options.repoPath));
  await deps.exec(startSessionScript(SMOKE_PROMPT));
  const rows = await ready;
  deps.log(`SMOKE_WORKSPACE ready rows=${rows}`);
  await captureShots(deps, options.shotsDir);
}
```

In `apps/desktop/src/main/smoke.ts`:

1. Add `import { runWorkspaceSmoke } from "./smoke-workspace.js";` and `import type { WorkspaceSmokeDeps } from "./smoke-workspace.js";`.
2. Add to `SmokeDeps`, after `fail(): void;`: `/** Present when JEVCODE_SMOKE_WORKSPACE=1 (index.ts). */ workspace?: WorkspaceSmokeDeps;`.
3. Add `export const SMOKE_WORKSPACE_TIMEOUT_MS = 60_000;` after `SMOKE_TRACE_TIMEOUT_MS`.
4. Add inside `runSmoke`, after `startTracePhase`:

```ts
  function startWorkspacePhase(): void {
    const repoPath = deps.env["JEVCODE_SMOKE_REPO"] ?? "";
    if (repoPath.length === 0 || deps.workspace === undefined) {
      fail("JEVCODE_SMOKE_WORKSPACE=1 needs JEVCODE_SMOKE_REPO (a git repository)");
      return;
    }
    schedule(SMOKE_WORKSPACE_TIMEOUT_MS, () => {
      fail(`workspace phase did not finish within ${SMOKE_WORKSPACE_TIMEOUT_MS / 1000}s`);
    });
    const shots = deps.env["JEVCODE_SMOKE_SHOTS"] ?? "";
    runWorkspaceSmoke(deps.workspace, { repoPath, shotsDir: shots.length > 0 ? shots : null }).then(
      () => {
        if (!finished) schedule(SMOKE_SETTLE_MS, succeed);
      },
      (error: unknown) => {
        fail(`workspace phase: ${error instanceof Error ? error.message : String(error)}`);
      },
    );
  }
```

5. Add `const workspaceRequested = deps.env["JEVCODE_SMOKE_WORKSPACE"] === "1";` next to `traceRequested`, and in the `did-finish-load` callback, right after `if (finished) return;`, add `if (workspaceRequested) { startWorkspacePhase(); return; }`.

In `apps/desktop/src/main/index.ts`:

1. Change `import { existsSync } from "node:fs";` to `import { existsSync, mkdirSync, writeFileSync } from "node:fs";`.
2. Add the imports `import { SMOKE_SCRIPT_DEFAULTS, smokeMockScript } from "./pipeline/smoke-script.js";` and `import type { WorkspaceSmokeDeps } from "./smoke-workspace.js";`.
3. After `const TRACE_PERF = …;`, add:

```ts
/** JEVCODE_SMOKE_WORKSPACE=1: the smoke drives the main window through a scripted mock session (smoke-workspace.ts). */
const SMOKE_WORKSPACE = SMOKE && process.env["JEVCODE_SMOKE_WORKSPACE"] === "1";
const SMOKE_STEPS = Number.parseInt(process.env["JEVCODE_SMOKE_STEPS"] ?? "", 10) || SMOKE_SCRIPT_DEFAULTS.steps;

function workspaceSmokeDeps(window: BrowserWindow): WorkspaceSmokeDeps {
  return {
    exec: (script) => window.webContents.executeJavaScript(script, true) as Promise<unknown>,
    onConsole: (listener) => {
      const handler = (_event: unknown, _level: number, message: string): void => listener(message);
      window.webContents.on("console-message", handler);
      return () => {
        window.webContents.off("console-message", handler);
      };
    },
    capture: async (width, height) => {
      window.setContentSize(width, height);
      await new Promise((resolve) => setTimeout(resolve, 800));
      const image = await window.webContents.capturePage();
      return image.toPNG();
    },
    writeFile: (filePath, data) => {
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, data);
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    log: (line) => console.log(line),
  };
}
```

4. In `new PipelineRuntime({ … })`, add the option:

```ts
    mockScriptFor: SMOKE_WORKSPACE
      ? (input) => smokeMockScript(input, { steps: SMOKE_STEPS, spacingMs: SMOKE_SCRIPT_DEFAULTS.spacingMs })
      : undefined,
```

5. In `runSmoke({ … })`, add `workspace: SMOKE_WORKSPACE ? workspaceSmokeDeps(mainWindow) : undefined,`.

Create `apps/desktop/scripts/smoke-workspace.mjs`:

```js
#!/usr/bin/env node
// Electron workspace smoke (plan lane 03, D-2 and D-6). Needs a built app
// (pnpm -r build) and the Electron ABI (pnpm --filter jevcode-desktop run rebuild).
// Usage: node apps/desktop/scripts/smoke-workspace.mjs [shotsDir]
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(APP, "../..");
const shots = path.resolve(process.argv[2] ?? path.join(REPO_ROOT, ".superpowers", "shots"));
const KILL_AFTER_MS = Number(process.env.JEVCODE_SMOKE_KILL_MS ?? 200_000);

const tmp = mkdtempSync(path.join(os.tmpdir(), "jevcode-ws-smoke-"));
const repo = path.join(tmp, "repo");
mkdirSync(repo);
writeFileSync(path.join(repo, "README.md"), "# smoke\n");
const git = (...args) => execFileSync("git", ["-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", ...args], { cwd: repo });
git("init", "-q", "-b", "main");
git("add", "README.md");
git("commit", "-q", "-m", "init");
mkdirSync(shots, { recursive: true });

const electron = path.join(APP, "node_modules", ".bin", "electron");
const child = spawn(electron, ["."], {
  cwd: APP,
  env: {
    ...process.env,
    JEVCODE_SMOKE: "1",
    JEVCODE_SMOKE_WORKSPACE: "1",
    JEVCODE_SMOKE_REPO: repo,
    JEVCODE_SMOKE_SHOTS: shots,
    JEVCODE_DB: path.join(tmp, "smoke.db"),
    JEVC_AGENT: "mock",
    JEVC_JEV_CLIENT: "degrade",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
child.stdout.on("data", (chunk) => {
  out += chunk;
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
const killer = setTimeout(() => {
  console.error(`WORKSPACE_SMOKE_FAIL killed after ${KILL_AFTER_MS / 1000}s`);
  child.kill("SIGKILL");
}, KILL_AFTER_MS);
child.on("exit", (code) => {
  clearTimeout(killer);
  rmSync(tmp, { recursive: true, force: true });
  const ok = code === 0 && /^SMOKE_OK$/m.test(out);
  console.log(ok ? "WORKSPACE_SMOKE_PASS" : `WORKSPACE_SMOKE_FAIL exit=${code}`);
  process.exit(ok ? 0 : 1);
});
```

- [ ] **Step 9: Run the tests to see them pass**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/renderer/workspace/main-host.test.ts src/renderer/components/workspace-host.test.tsx src/main/pipeline/action-dispatcher.test.ts src/main/ipc.test.ts src/main/pipeline/smoke-script.test.ts src/main/smoke-workspace.test.ts src/main/smoke.test.ts`, then `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/main/pipeline/pipeline-runtime.test.ts`

Expected: PASS. In `workspace-host.test.tsx`, the Review Focus 4 test takes about 1.3 s.

- [ ] **Step 10: Package checks**

Run: `perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop test`, `perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop typecheck`, `perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop build`, and `perl -e 'alarm 170; exec @ARGV' pnpm lint`.

Expected: all exit 0. The renderer bundle now includes the viewer root (`dist/renderer/assets/main-*.js` grows), and the main and trace entries both build.

- [ ] **Step 11: Electron smoke (screenshot baseline for D-3 and D-4)**

Run:

```bash
pnpm --filter jevcode-desktop run rebuild
(perl -e 'alarm 240; exec @ARGV' node apps/desktop/scripts/smoke-workspace.mjs .superpowers/shots/d2 > .superpowers/smoke-d2.log 2>&1; echo "EXIT=$?" >> .superpowers/smoke-d2.log) &
```

Wait until `grep -E "^EXIT=" .superpowers/smoke-d2.log` prints a line (poll every 15 s). Then run `grep -E "SMOKE_WORKSPACE|SMOKE_SHOT|SMOKE_OK|SMOKE_FAIL|WORKSPACE_SMOKE" .superpowers/smoke-d2.log`, and restore the Node ABI as in D-6 Step 9.

Expected: `SMOKE_WORKSPACE ready rows=<n>`, two `SMOKE_SHOT` lines, `SMOKE_OK`, `WORKSPACE_SMOKE_PASS`, `EXIT=0`. Open `.superpowers/shots/d2/main-console-1440.png` with the Read tool. It should show the embedded viewer under the session heading with the composer and context rail still present (dark until D-4). The Console view is lane 02b's, so before the 02b merge the Console slot may be V-2's placeholder.

- [ ] **Step 12: Commit**

```bash
git add apps/desktop/package.json pnpm-lock.yaml apps/desktop/vitest.config.ts apps/desktop/src/renderer/workspace apps/desktop/src/renderer/test-support apps/desktop/src/renderer/components/WorkspaceHost.tsx apps/desktop/src/renderer/components/workspace-host.test.tsx apps/desktop/src/renderer/styles.css apps/desktop/src/shared/api.ts apps/desktop/src/main/ipc.test.ts apps/desktop/src/main/pipeline/action-dispatcher.ts apps/desktop/src/main/pipeline/action-dispatcher.test.ts apps/desktop/src/main/pipeline/types.ts apps/desktop/src/main/pipeline/pipeline-runtime.ts apps/desktop/src/main/pipeline/pipeline-runtime.test.ts apps/desktop/src/main/pipeline/smoke-script.ts apps/desktop/src/main/pipeline/smoke-script.test.ts apps/desktop/src/main/smoke-workspace.ts apps/desktop/src/main/smoke-workspace.test.ts apps/desktop/src/main/smoke.ts apps/desktop/src/main/smoke.test.ts apps/desktop/src/main/index.ts apps/desktop/scripts/smoke-workspace.mjs
git -c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com commit -m "feat(desktop): embed the trace viewer in the main window, Console first"
```

---

### Task D-5: Separate the user shell from the agent log

`TerminalPanel` shows the person's own `sh -i`. Today the pipeline also writes agent one-liners into the same `terminal:data` stream and scrollback: `formatAgentEventForTerminal`, the mock adapter's `terminal` entries, and the resume-budget failure line. Spec E7 removes them. The Console is the agent log now.

**Files:**
- Modify: `apps/desktop/src/main/pipeline/types.ts` (`TerminalSink` without `data`)
- Modify: `apps/desktop/src/main/pipeline/pipeline-runtime.ts` (delete `formatAgentEventForTerminal` and its call; mock hooks without `onTerminal`; no resume-budget terminal line)
- Modify: `apps/desktop/src/main/index.ts` (`terminalSink` without `data`)
- Modify: `apps/desktop/src/main/ipc.ts` (`action:invoke` terminal deps)
- Test: `apps/desktop/src/main/pipeline/pipeline-runtime.test.ts`, `apps/desktop/src/main/pipeline/resume-budget.test.ts`, `apps/desktop/src/main/pipeline/action-dispatcher.test.ts`

**Interfaces:**
- Consumes: `PipelineRuntime`, `MockAgentAdapter` hooks (`onTerminal` stays optional in `mock-agent-adapter.ts`, and the runtime no longer passes it), `TerminalManager` (unchanged).
- Produces: `TerminalSink { ensure(sessionId: string, cwd: string): void }`. Nothing else in the repo writes agent text to `terminal:data`.

- [ ] **Step 1: Write the failing regression test**

In `apps/desktop/src/main/pipeline/pipeline-runtime.test.ts`, inside `describe("PipelineRuntime honest lifecycle (D10)", …)`, change `startScripted` so that it accepts a sink and reports `terminal:data` emits.

1. Change its signature to `async function startScripted(name: string, entries: MockScriptEntry[], sink: { ensure(sessionId: string, cwd: string): void } = { ensure: () => {} })`, and its return type field `terminal: string[]` to `channels: Map<string, unknown[]>`.
2. Replace `const terminal: string[] = [];` and `const { emit } = collectEmit();` with `const { emit, collected } = collectEmit();`.
3. Replace the `terminal: { data: …, ensure: () => {} },` option with `terminal: sink,`.
4. Return `{ db, runtime, sessionId, channels: collected.channels }`.

In the first test, replace `const { db, runtime, sessionId, terminal } = await startScripted("stop-pauses", []);` with `const { db, runtime, sessionId } = await startScripted("stop-pauses", []);`, and delete the line `expect(terminal).toContain("[agent] stopped");`. Then add this test to the same `describe`:

```ts
  it("agent events never reach the user's shell (spec E7)", async () => {
    const now = () => new Date().toISOString();
    const writes: string[] = [];
    // A sink that still has data(): before D-5 the runtime wrote agent one-liners through it.
    const sink = {
      ensure: () => {},
      data: (_sessionId: string, data: string) => {
        writes.push(data);
      },
    };
    const sessionId = "sess-shell-separation";
    const { db, runtime, channels } = await startScripted(
      "shell-separation",
      [
        { kind: "agent", event: { type: "agent_message", sessionId, role: "assistant", text: "Reading the router", ts: now() } },
        { kind: "agent", event: { type: "command_started", sessionId, command: "pnpm test", ts: now() } },
        { kind: "agent", event: { type: "command_completed", sessionId, command: "pnpm test", exitCode: 1, stdout: "", stderr: "1 failed", ts: now() } },
        { kind: "terminal", data: "$ pnpm test\r\n" },
        { kind: "agent", event: { type: "file_changed", sessionId, path: "src/router.ts", ts: now() } },
      ],
      sink,
    );
    try {
      await waitFor(
        () => db.listAgentEvents(sessionId).some((event) => event.type === "file_changed"),
        8000,
        "scripted events stored",
      );
      await runtime.syncAll();
      await runtime.stopSession(sessionId);
      expect(writes).toEqual([]);
      expect(channels.get("terminal:data") ?? []).toEqual([]);
      // The Console still has every event: they are trace rows.
      expect(db.listAgentEvents(sessionId).map((event) => event.type)).toEqual(
        expect.arrayContaining(["agent_message", "command_started", "command_completed", "file_changed", "agent_interrupted"]),
      );
    } finally {
      db.close();
    }
  }, 30_000);
```

`startScripted` derives the session id from its name as `sess-${name}`. The test passes `"shell-separation"`, so the script's `sessionId` must equal `"sess-shell-separation"`, which is the literal above.

In `apps/desktop/src/main/pipeline/resume-budget.test.ts`:

1. Replace the `terminal: { data: …, ensure: () => {} },` option with `terminal: sink,`, after declaring `const sink = { ensure: () => {}, data: (_sessionId: string, data: string) => { collected.terminal.push(data); } };` above the runtime.
2. Replace

```ts
    expect(collected.terminal).toContain(
      "[agent] failed: resume budget exhausted",
    );
```

with

```ts
    // The failure is a trace row and an agent:event; the user's shell stays untouched (spec E7).
    expect(collected.terminal).toEqual([]);
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/main/pipeline/pipeline-runtime.test.ts src/main/pipeline/resume-budget.test.ts -t "shell|resume_attempts"`

Expected: FAIL. "agent events never reach the user's shell" fails with `expected [ '[agent] Reading the router', '$ pnpm test', …(4) ] to deeply equal []`. The resume-budget test fails with `expected [ '[agent] failed: resume budget exhausted' ] to deeply equal []`.

- [ ] **Step 3: Remove the agent writes**

In `apps/desktop/src/main/pipeline/types.ts`, replace

```ts
export interface TerminalSink {
  data(sessionId: string, data: string): void;
  ensure(sessionId: string, cwd: string): void;
}
```

with

```ts
/** The person's own shell (TerminalPanel's sh -i). The pipeline may start it, never write to it (spec E7). */
export interface TerminalSink {
  ensure(sessionId: string, cwd: string): void;
}
```

In `apps/desktop/src/main/pipeline/pipeline-runtime.ts`:

1. In both `new MockAgentAdapter(script, { … hooks: { … } })` blocks, delete the `onTerminal: (data) => { this.opts.terminal?.data(sessionId, data); },` member, so that each `hooks` object holds only `onRecord`.
2. In `ingestRecordUnsafe`, delete

```ts
      const terminalLine = formatAgentEventForTerminal(event);
      if (terminalLine !== null) {
        this.opts.terminal?.data(sessionId, terminalLine);
      }
```

3. In the resume-budget branch, delete

```ts
      this.opts.terminal?.data(
        sessionId,
        "[agent] failed: resume budget exhausted",
      );
```

4. Delete the whole `function formatAgentEventForTerminal(event: NormalizedAgentEvent): string | null { … }`.

In `apps/desktop/src/main/index.ts`, replace the `terminalSink` constant with:

```ts
  // The person's shell only: the pipeline may start it, never write agent text into it (spec E7).
  const terminalSink: TerminalSink = {
    ensure: (sessionId, cwd) => {
      terminals?.ensure(sessionId, { cwd });
    },
  };
```

In `apps/desktop/src/main/ipc.ts`, in the `action:invoke` handler, replace

```ts
        terminals: {
          ensure: (sessionId, cwd) => {
            deps.terminals.ensure(sessionId, { cwd });
          },
          data: (_sessionId, _data) => {},
        },
```

with

```ts
        terminals: {
          ensure: (sessionId, cwd) => {
            deps.terminals.ensure(sessionId, { cwd });
          },
        },
```

In `apps/desktop/src/main/pipeline/action-dispatcher.test.ts`, change `terminals: { ensure: () => {}, data: () => {} },` to `terminals: { ensure: () => {} },`.

Run: `grep -rn "terminal?.data\|formatAgentEventForTerminal\|onTerminal: (" apps/desktop/src/main`

Expected: no output.

- [ ] **Step 4: Run the tests to see them pass**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/main/pipeline/pipeline-runtime.test.ts src/main/pipeline/resume-budget.test.ts src/main/pipeline/action-dispatcher.test.ts src/main/pipeline/mock-agent-adapter.test.ts`

Expected: PASS.

- [ ] **Step 5: Package checks**

Run: `perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop test`, `perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop typecheck`, `perl -e 'alarm 170; exec @ARGV' pnpm lint`, and `grep -n "terminal" scripts/soak.mjs | head`.

Expected: all three commands exit 0. The soak script passes no `terminal` option, or passes one whose extra `data` member is ignored. If it relies on `data` being called, record that in `progress.md` (the soak measures ingest, not terminal output).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/pipeline/types.ts apps/desktop/src/main/pipeline/pipeline-runtime.ts apps/desktop/src/main/pipeline/pipeline-runtime.test.ts apps/desktop/src/main/pipeline/resume-budget.test.ts apps/desktop/src/main/pipeline/action-dispatcher.test.ts apps/desktop/src/main/index.ts apps/desktop/src/main/ipc.ts
git -c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com commit -m "fix(desktop): keep agent one-liners out of the user's shell"
```

---

### Task D-4: Light restyle of the main window onto `--tv-*`

**Gate:** H1 approved (mockups README). This task does not start before the approval is recorded.

**Files:**
- Modify: `packages/trace-viewer/src/index.ts` (append the token export line; deviation 5)
- Create: `apps/desktop/src/renderer/theme.ts`
- Modify: `apps/desktop/src/renderer/main.tsx` (tokens on `:root`)
- Modify: `apps/desktop/src/renderer/styles.css` (whole-file token pass, dead rules removed)
- Modify: `apps/desktop/src/renderer/components/TerminalPanel.tsx` (light xterm theme)
- Modify: `apps/desktop/src/main/trace-window.ts` (`MAIN_WINDOW_BACKGROUND`), `apps/desktop/src/main/index.ts` (use it)
- Test: `apps/desktop/src/renderer/styles-tokens.test.ts` (new)

**Interfaces:**
- Consumes: `LIGHT_TOKENS`, `TOKEN_VARS`, `tokenStyle()` and `FONT_MONO` (`packages/trace-viewer/src/ui/tokens/tokens.ts`), exported by this task.
- Produces: `applyViewerTokens(root: HTMLElement): void`, `XTERM_LIGHT_THEME: ITheme` and `MAIN_WINDOW_BACKGROUND = "#F4F5F7"`. Every color in `styles.css` is a `--tv-*` token, which D-3 relies on.

- [ ] **Step 1: Open the approved mockup**

Read `docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/README.md`, then open `main-window-console-1440.png` and `main-window-console-1000.png` with the Read tool. Note the header, sidebar, status bar, switcher bar and dock treatment: surfaces, ink levels, where hairlines appear, and which elements carry color. The window chrome must match these colors and weights.

- [ ] **Step 2: Write the failing style test**

Create `apps/desktop/src/renderer/styles-tokens.test.ts`:

```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LIGHT_TOKENS, TOKEN_VARS } from "@jevcode/trace-viewer";
import { describe, expect, it } from "vitest";

import { XTERM_LIGHT_THEME } from "./theme.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(path.join(dirname, "styles.css"), "utf8");
// Read as text: the renderer project does not compile main-process files.
const MAIN_WINDOW_BACKGROUND = /MAIN_WINDOW_BACKGROUND = "(#[0-9A-Fa-f]{6})"/.exec(
  readFileSync(path.join(dirname, "../main/trace-window.ts"), "utf8"),
)?.[1];
const UI_CATALOG_SRC = path.resolve(dirname, "../../../../packages/ui-catalog/src");

function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules" && entry !== "test-support") files.push(...sourceFiles(full));
      continue;
    }
    if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) files.push(full);
  }
  return files;
}

const CORPUS = [...sourceFiles(dirname), ...sourceFiles(UI_CATALOG_SRC)]
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");
/** Classes built at run time, e.g. `surface-kind-${meta.group}` → "surface-kind-". */
const DYNAMIC_PREFIXES = [...CORPUS.matchAll(/([a-z][\w-]*-)\$\{/g)].map((match) => match[1] ?? "");
/** Markup that diff2html, xterm and React Flow own. */
const FOREIGN_PREFIXES = ["d2h-", "xterm", "react-flow"];

function classNames(css: string): string[] {
  const names = new Set<string>();
  for (const rule of withoutComments(css).matchAll(/([^{}]+)\{/g)) {
    const selector = rule[1]?.trim() ?? "";
    if (selector.startsWith("@") || /^(from|to|\d+%)/.test(selector)) continue;
    for (const match of selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) names.add(match[1] ?? "");
  }
  return [...names];
}

describe("main window styles use the viewer's light tokens (spec E6, §3.6, §9)", () => {
  it("is a light stylesheet", () => {
    expect(CSS).not.toMatch(/color-scheme:\s*dark/);
    expect(CSS).toMatch(/color-scheme:\s*light/);
  });

  it("has no color literals: every color is a --tv-* token", () => {
    const literals = withoutComments(CSS).match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g) ?? [];
    expect(literals).toEqual([]);
  });

  it("references only real tokens or variables it defines itself", () => {
    const css = withoutComments(CSS);
    const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1] ?? ""));
    const known = new Set<string>([...Object.values(TOKEN_VARS), "--tv-dur", "--tv-dur-fast"]);
    const used = [...new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1] ?? ""))];
    expect(used.filter((name) => !known.has(name) && !defined.has(name))).toEqual([]);
  });

  it("keeps no rule for a class nothing renders", () => {
    const dead = classNames(CSS).filter(
      (name) =>
        !FOREIGN_PREFIXES.some((prefix) => name.startsWith(prefix)) &&
        !CORPUS.includes(name) &&
        !DYNAMIC_PREFIXES.some((prefix) => name.startsWith(prefix)),
    );
    expect(dead).toEqual([]);
  });

  it("paints the native window, the page and the shell from the same light tokens", () => {
    expect(MAIN_WINDOW_BACKGROUND).toBe(LIGHT_TOKENS.canvas);
    expect(XTERM_LIGHT_THEME.background).toBe(LIGHT_TOKENS.panel);
    expect(XTERM_LIGHT_THEME.foreground).toBe(LIGHT_TOKENS.ink);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/renderer/styles-tokens.test.ts`

Expected: FAIL to load with `"LIGHT_TOKENS" is not exported by "@jevcode/trace-viewer"` (or `undefined` under vitest), and `Failed to resolve import "./theme.js"`.

- [ ] **Step 4: Export the tokens and set them on `:root`**

Append to `packages/trace-viewer/src/index.ts`:

```ts
export { FONT_MONO, FONT_SANS, LIGHT_TOKENS, TOKEN_VARS, tokenStyle, type TokenName, type Tokens } from "./ui/tokens/tokens.js";
```

Run: `perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/trace-viewer build && perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/lint-boundaries.test.ts`

Expected: both exit 0.

Create `apps/desktop/src/renderer/theme.ts`:

```ts
import { LIGHT_TOKENS, tokenStyle } from "@jevcode/trace-viewer";
import type { ITheme } from "@xterm/xterm";

/** Spec §9: the main window loads the viewer's tokens once, at the root, so header, sidebar, dock and viewer share one palette. */
export function applyViewerTokens(root: HTMLElement): void {
  for (const [name, value] of Object.entries(tokenStyle())) root.style.setProperty(name, value);
}

/** The person's shell on the light panel (spec E6: light only). */
export const XTERM_LIGHT_THEME: ITheme = {
  background: LIGHT_TOKENS.panel,
  foreground: LIGHT_TOKENS.ink,
  cursor: LIGHT_TOKENS.ink,
  cursorAccent: LIGHT_TOKENS.panel,
  selectionBackground: LIGHT_TOKENS.accentSoft,
};
```

In `apps/desktop/src/renderer/main.tsx`, add `import { applyViewerTokens } from "./theme.js";` and call `applyViewerTokens(document.documentElement);` right before `const container = document.getElementById("root");`.

In `apps/desktop/src/renderer/components/TerminalPanel.tsx`, add `import { XTERM_LIGHT_THEME } from "../theme.js";` and add `theme: XTERM_LIGHT_THEME,` to the `new Terminal({ … })` options.

In `apps/desktop/src/main/trace-window.ts`, add after `TRACE_WINDOW_BACKGROUND`:

```ts
/** The main window's native background: LIGHT_TOKENS.canvas, so no dark flash before the page paints (spec E6). */
export const MAIN_WINDOW_BACKGROUND = "#F4F5F7";
```

In `apps/desktop/src/main/index.ts`, import `MAIN_WINDOW_BACKGROUND` from `./trace-window.js` (extend the existing import) and change `backgroundColor: "#14161a",` to `backgroundColor: MAIN_WINDOW_BACKGROUND,`.

- [ ] **Step 5: Move `styles.css` onto the tokens**

Write this one-off script to the scratchpad. It is not committed:

```bash
cat > "${TMPDIR:-/tmp}/restyle-tokens.mjs" <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";
const file = "apps/desktop/src/renderer/styles.css";
let css = readFileSync(file, "utf8");
css = css.replace(/:root\s*\{[\s\S]*?\n\}/, `:root {
  color-scheme: light;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, monospace;
}`);
const VARS = {
  "--bg": "--tv-canvas", "--panel": "--tv-panel", "--panel-raised": "--tv-panel", "--panel-hover": "--tv-fill",
  "--line": "--tv-hair", "--line-strong": "--tv-fill-2", "--text": "--tv-ink", "--text-soft": "--tv-ink-2",
  "--muted": "--tv-ink-3", "--faint": "--tv-ink-4", "--accent": "--tv-accent", "--accent-soft": "--tv-accent-soft",
  "--accent-text": "--tv-accent-ink", "--blue": "--tv-accent", "--green": "--tv-good", "--green-soft": "--tv-fill",
  "--amber": "--tv-accent-ink", "--amber-soft": "--tv-accent-soft", "--red": "--tv-bad", "--red-soft": "--tv-bad-soft",
};
for (const [from, to] of Object.entries(VARS)) css = css.replaceAll(`var(${from})`, `var(${to})`);
css = css.replace(/box-shadow:[^;]*rgba\(0, 0, 0,[^;]*;/g, "box-shadow: var(--tv-shadow);");
const LITERALS = {
  "rgba(139, 124, 246, 0.35)": "var(--tv-accent-soft)", "rgba(139, 124, 246, 0.4)": "var(--tv-accent-soft)",
  "rgba(139, 124, 246, 0.1)": "var(--tv-accent-soft)", "rgba(139, 124, 246, 0.08)": "var(--tv-accent-soft)",
  "rgba(80, 66, 179, 0.28)": "var(--tv-accent-soft)", "rgba(229, 182, 93, 0.1)": "var(--tv-accent-soft)",
  "rgba(99, 201, 142, 0.1)": "var(--tv-fill)", "rgba(99, 201, 142, 0.08)": "var(--tv-fill)",
  "rgba(99, 201, 142, 0)": "transparent", "rgba(255, 255, 255, 0.015)": "transparent",
  "#14241b": "color-mix(in srgb, var(--tv-good) 10%, transparent)", "#28161c": "var(--tv-bad-soft)",
  "#343a49": "var(--tv-fill-2)", "#4a5264": "var(--tv-mark)", "#555f75": "var(--tv-mark)",
  "#665dbc": "var(--tv-accent)", "#7769df": "var(--tv-accent)", "#7469d4": "var(--tv-accent)",
  "#655ab8": "var(--tv-accent)", "#51499a": "var(--tv-accent)", "#3f3b71": "var(--tv-accent)",
  "#9a7b39": "var(--tv-accent)", "#66512a": "var(--tv-accent)", "#a398ff": "var(--tv-accent-ink)",
  "#9c90ff": "var(--tv-accent)", "#100e1e": "var(--tv-panel)", "#0e0c1a": "var(--tv-panel)",
  "#11141a": "var(--tv-panel)", "#111319": "var(--tv-panel)", "#12120f": "var(--tv-panel)", "#17150f": "var(--tv-panel)",
  "#0a0c10": "var(--tv-fill)", "#0b0d11": "var(--tv-fill)", "#0c0e12": "var(--tv-fill)", "#090b0e": "var(--tv-fill)",
  "#181725": "var(--tv-fill)", "#182231": "var(--tv-accent-soft)", "#211c11": "var(--tv-accent-soft)",
  "#5e4f28": "var(--tv-accent-soft)", "#343052": "var(--tv-hair)", "#3c392d": "var(--tv-hair)",
  "#2d5f44": "var(--tv-good)", "#285c41": "var(--tv-good)", "#294737": "var(--tv-good)", "#28543c": "var(--tv-good)",
  "#3f8c61": "var(--tv-good)", "#8fddb0": "var(--tv-good)", "#6d3540": "var(--tv-bad)", "#54303a": "var(--tv-bad)",
  "#f19aa4": "var(--tv-bad-ink)", "#f2a0aa": "var(--tv-bad-ink)", "#f0a5ae": "var(--tv-bad-ink)",
  "#edca84": "var(--tv-accent-ink)", "#a9cbed": "var(--tv-accent-ink)", "#9bc8f1": "var(--tv-accent-ink)",
  "#aeb5c2": "var(--tv-ink-2)", "#737b8c": "var(--tv-ink-4)", "#fff": "var(--tv-ink)",
};
for (const [from, to] of Object.entries(LITERALS).sort((a, b) => b[0].length - a[0].length)) css = css.split(from).join(to);
css = css.replace(/font-family: "Avenir Next",[^;]*;/, "font-family: var(--sans);");
writeFileSync(file, css);
EOF
node "${TMPDIR:-/tmp}/restyle-tokens.mjs"
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/renderer/styles-tokens.test.ts`

Expected: the literal, light and token tests pass. "keeps no rule for a class nothing renders" lists dead classes: rules whose markup D-2 moved or that were already unused. Delete each listed rule (the whole rule, including any `@keyframes` that only it used) and rerun until it passes. If the literal test lists a leftover, replace it with the nearest token by role. Surfaces and wells take `--tv-panel` or `--tv-fill`, hairlines `--tv-hair`, secondary text `--tv-ink-2`/`-3`, selection and focus `--tv-accent`/`--tv-accent-soft`, failures `--tv-bad*`, and passes `--tv-good`.

- [ ] **Step 6: Run the checks**

Run: `perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop test`, `perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop typecheck`, `perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop build`, `perl -e 'alarm 170; exec @ARGV' pnpm lint`.

Expected: all exit 0.

- [ ] **Step 7: Screenshot and compare with the mockup**

Run the smoke as in D-2 Step 11 with the shots directory `.superpowers/shots/d4` and the log `.superpowers/smoke-d4.log`, and restore the Node ABI afterwards (D-6 Step 9). Open `.superpowers/shots/d4/main-console-1440.png` and `main-console-1000.png` next to the mockup PNGs. Check these points:

- the header, sidebar and status bar are light
- no dark panel remains
- text uses the ink levels of the mockup
- color appears only on state (running dot, failures, the accent on selection and primary actions)
- borders are hairlines only where the mockup shows separation
- nothing overflows horizontally at 1000 px

Adjust `styles.css` only through tokens until the screenshots match. Rerun the test file after each change.

- [ ] **Step 8: Commit**

```bash
git add packages/trace-viewer/src/index.ts apps/desktop/src/renderer/theme.ts apps/desktop/src/renderer/main.tsx apps/desktop/src/renderer/styles.css apps/desktop/src/renderer/styles-tokens.test.ts apps/desktop/src/renderer/components/TerminalPanel.tsx apps/desktop/src/main/trace-window.ts apps/desktop/src/main/index.ts
git -c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com commit -m "feat(desktop): move the main window onto the viewer's light tokens"
```

---

### Task D-3: `PromptDock`, Surfaces view, context rail moved into the Brief

**Gate:** H1 approved. D-4 is committed.

**Files:**
- Create: `apps/desktop/src/renderer/workspace/PromptDock.tsx`
- Modify: `apps/desktop/src/renderer/components/WorkspaceHost.tsx` (whole file replaced: no heading, no composer, no context rail)
- Modify: `apps/desktop/src/renderer/workspace/surfaces-view.tsx` (layout classes only, if the mockup changes the tab strip)
- Modify: `apps/desktop/src/renderer/styles.css` (dock and bar rules; dead rules removed)
- Test: `apps/desktop/src/renderer/workspace/prompt-dock.test.tsx` (new), `apps/desktop/src/renderer/workspace/surfaces-view.test.tsx` (new), `apps/desktop/src/renderer/components/workspace-host.test.tsx`

**Interfaces:**
- Consumes: `composerReducer`, `ComposerState`, `ComposerEvent` and `traceNoteTarget` (`renderer/components/composer-prefill.ts`); `agentStateLabel` (`@jevcode/trace-viewer/model`); `SurfacesContext` and `SessionSurfaces` (D-2); `JevcodeApi.agent` and `.session`.
- Produces: `PromptDock(props: PromptDockProps)`, `continuesSession(state): boolean` and `InstructionMode`. The textarea keeps the accessible name "Guide the agent", which D-2's tests and D-6's smoke rely on.

- [ ] **Step 1: Open the approved mockup**

Open `main-window-console-1440.png` and `-1000.png` again, this time for the dock: the `›` glyph, the monospace input, the "Steer ▾ · ⌘↵ send · status chip" footer, queued items above the line, and the switcher bar (spec §3.1).

- [ ] **Step 2: Write the failing dock and Surfaces tests**

Create `apps/desktop/src/renderer/workspace/prompt-dock.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useReducer } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { composerReducer, initialComposer } from "../components/composer-prefill.js";
import type { SessionStatePayload } from "../payload-types.js";
import { PromptDock, continuesSession, type PromptDockProps } from "./PromptDock.js";

function fakeBridge() {
  return {
    agent: {
      sendInstruction: vi.fn(async (_sessionId: string, _text: string, _mode?: "queue" | "steer") => undefined),
      resume: vi.fn(async (_sessionId: string) => undefined),
      interrupt: vi.fn(async (_sessionId: string) => undefined),
      cancelInstruction: vi.fn(async (_sessionId: string, _instructionId: string) => undefined),
    },
    session: { switchTo: vi.fn(async (_sessionId: string) => undefined) },
  };
}

function Harness(props: {
  bridge: ReturnType<typeof fakeBridge>;
  state: SessionStatePayload["state"] | null;
  pending?: PromptDockProps["pending"];
}) {
  const [composer, dispatch] = useReducer(composerReducer, "s1", initialComposer);
  return (
    <PromptDock
      bridge={props.bridge as unknown as PromptDockProps["bridge"]}
      sessionId="s1"
      state={props.state}
      composer={composer}
      dispatch={dispatch}
      pending={props.pending ?? []}
      noteTargetPrompt={undefined}
    />
  );
}

const input = (): HTMLTextAreaElement => screen.getByLabelText("Guide the agent") as HTMLTextAreaElement;

afterEach(() => {
  cleanup();
});

describe("PromptDock (spec §3.1, §3.7)", () => {
  it("Cmd+Enter steers the running agent with the trimmed text and clears the draft", async () => {
    const bridge = fakeBridge();
    render(<Harness bridge={bridge} state="running" />);
    fireEvent.change(input(), { target: { value: "  add a test for the 429 path  " } });
    fireEvent.keyDown(input(), { key: "Enter", metaKey: true });
    await waitFor(() => expect(bridge.agent.sendInstruction).toHaveBeenCalledWith("s1", "add a test for the 429 path", "steer"));
    await waitFor(() => expect(input().value).toBe(""));
  });

  it("Enter alone keeps typing: nothing is sent", () => {
    const bridge = fakeBridge();
    render(<Harness bridge={bridge} state="running" />);
    fireEvent.change(input(), { target: { value: "line one" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(bridge.agent.sendInstruction).not.toHaveBeenCalled();
    expect(input().value).toBe("line one");
  });

  it("the timing toggle queues instead of steering", async () => {
    const bridge = fakeBridge();
    render(<Harness bridge={bridge} state="running" />);
    fireEvent.click(screen.getByRole("button", { name: "Instruction timing" }));
    expect(screen.getByRole("button", { name: "Instruction timing" }).textContent).toContain("Queue");
    fireEvent.change(input(), { target: { value: "then update the docs" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    await waitFor(() => expect(bridge.agent.sendInstruction).toHaveBeenCalledWith("s1", "then update the docs", "queue"));
  });

  it("a finished session continues: the text is queued, then the agent resumes", async () => {
    expect(["completed", "paused", "failed"].map((state) => continuesSession(state as SessionStatePayload["state"]))).toEqual([true, true, true]);
    expect(continuesSession("running")).toBe(false);
    const bridge = fakeBridge();
    render(<Harness bridge={bridge} state="completed" />);
    fireEvent.change(input(), { target: { value: "also handle Retry-After" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(bridge.agent.resume).toHaveBeenCalledWith("s1"));
    expect(bridge.agent.sendInstruction).toHaveBeenCalledWith("s1", "also handle Retry-After", "queue");
    expect(bridge.agent.sendInstruction.mock.invocationCallOrder[0]).toBeLessThan(bridge.agent.resume.mock.invocationCallOrder[0] ?? 0);
  });

  it("lists queued instructions above the prompt line, each cancellable", () => {
    const bridge = fakeBridge();
    render(
      <Harness
        bridge={bridge}
        state="running"
        pending={[
          { id: "i1", mode: "queue", text: "then update the docs" },
          { id: "i2", mode: "steer", text: "stop touching the cache" },
        ] as PromptDockProps["pending"]}
      />,
    );
    const queue = screen.getByRole("list", { name: "Queued instructions" });
    expect(queue.textContent).toContain("then update the docs");
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel queued instruction" })[1]!);
    expect(bridge.agent.cancelInstruction).toHaveBeenCalledWith("s1", "i2");
  });

  it("Cmd+L focuses the prompt line from anywhere", () => {
    const bridge = fakeBridge();
    render(<Harness bridge={bridge} state="running" />);
    expect(document.activeElement).not.toBe(input());
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "l", metaKey: true, bubbles: true }));
    });
    expect(document.activeElement).toBe(input());
  });

  it("a failed send keeps the draft and shows the error", async () => {
    const bridge = fakeBridge();
    bridge.agent.sendInstruction.mockRejectedValueOnce(new Error("session s1 is not running"));
    render(<Harness bridge={bridge} state="running" />);
    fireEvent.change(input(), { target: { value: "keep me" } });
    fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("session s1 is not running");
    expect(input().value).toBe("keep me");
  });

  it("Pause interrupts a running agent and Resume resumes a paused one", async () => {
    const bridge = fakeBridge();
    const { rerender } = render(<Harness bridge={bridge} state="running" />);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(bridge.agent.interrupt).toHaveBeenCalledWith("s1"));
    rerender(<Harness bridge={bridge} state="paused" />);
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(bridge.agent.resume).toHaveBeenCalledWith("s1"));
  });
});
```

Create `apps/desktop/src/renderer/workspace/surfaces-view.test.tsx`:

```tsx
// @vitest-environment jsdom
import { SurfaceManager } from "@jevcode/ui-catalog";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SurfacesContext, type SessionSurfaces } from "./session-surfaces.js";
import { SurfacesView, surfacesView } from "./surfaces-view.js";

function surfaces(overrides: Partial<SessionSurfaces> = {}): SessionSurfaces {
  return {
    sessionId: "s1",
    sessionState: { sessionId: "s1", state: "running", changeUnitCount: 2, decisionCount: 0, ts: "2026-10-02T10:00:00.000Z" },
    manager: new SurfaceManager(),
    entries: [],
    events: [],
    recordedFiles: [],
    togglePin: vi.fn(),
    dismiss: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("Surfaces host view (spec E3)", () => {
  it("is registered as kind surfaces with its own icon", () => {
    expect([surfacesView.kind, surfacesView.label, surfacesView.icon]).toEqual(["surfaces", "Surfaces", "view-surfaces"]);
  });

  it("keeps the Overview, Conversation and Decisions tabs, with conversation-only events under Conversation", () => {
    const ts = "2026-10-02T10:00:01.000Z";
    render(
      <SurfacesContext.Provider
        value={surfaces({
          events: [
            { type: "agent_message", sessionId: "s1", role: "assistant", text: "Reading the router \u202Eevil", ts },
            { type: "command_started", sessionId: "s1", command: "pnpm test", ts },
          ],
        })}
      >
        <SurfacesView active />
      </SurfacesContext.Provider>,
    );
    expect(screen.getByRole("button", { name: /Conversation/ }).textContent).toContain("1");
    fireEvent.click(screen.getByRole("button", { name: /Conversation/ }));
    const feed = screen.getByText(/Reading the router/);
    // Plain text, never markup: the bidi override stays a character in a text node.
    expect(feed.tagName).toBe("P");
    expect(document.body.innerHTML).not.toContain("<script");
    expect(screen.queryByText("pnpm test")).toBeNull();
  });

  it("shows the decisions empty state when nothing waits", () => {
    render(
      <SurfacesContext.Provider value={surfaces()}>
        <SurfacesView active />
      </SurfacesContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Decisions/ }));
    expect(screen.getByText("No decisions yet")).toBeTruthy();
  });
});
```

Append to `apps/desktop/src/renderer/components/workspace-host.test.tsx`:

```tsx
describe("WorkspaceHost after the dock move (spec §9)", () => {
  it("has no context rail: Now and Changes live in the Brief", async () => {
    render(host("s1"));
    await waitFor(() => expect(bridge.rowsCalls("s1")).toBeGreaterThan(0));
    expect(screen.queryByLabelText("Live session context")).toBeNull();
    expect(screen.getByRole("region", { name: "Prompt" })).toBeTruthy();
  });

  it("shows this session's queued instructions in the dock", async () => {
    render(host("s1"));
    act(() =>
      bridge.emitInstructionState({
        sessionId: "s1",
        pending: [{ id: "i1", mode: "queue", text: "then update the docs" }],
      } as Parameters<FakeBridge["emitInstructionState"]>[0]),
    );
    expect((await screen.findByRole("list", { name: "Queued instructions" })).textContent).toContain("then update the docs");
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/renderer/workspace/prompt-dock.test.tsx src/renderer/workspace/surfaces-view.test.tsx src/renderer/components/workspace-host.test.tsx`

Expected: `prompt-dock.test.tsx` fails to resolve `./PromptDock.js`. The new WorkspaceHost tests fail: the "Live session context" landmark is still present, and there is no "Prompt" region. `surfaces-view.test.tsx` passes, because D-2 moved that code, and stays as the restyle's guard.

- [ ] **Step 4: Implement `PromptDock`**

Create `apps/desktop/src/renderer/workspace/PromptDock.tsx`:

```tsx
import { agentStateLabel } from "@jevcode/trace-viewer/model";
import { useEffect, useRef, useState, type Dispatch } from "react";

import type { AgentInstructionStatePayload, JevcodeApi } from "../../shared/api.js";
import { traceNoteTarget, type ComposerEvent, type ComposerState } from "../components/composer-prefill.js";
import type { SessionStatePayload } from "../payload-types.js";

export type InstructionMode = "steer" | "queue";
type AgentState = SessionStatePayload["state"];

/** A finished or paused session continues: the text is queued, then the agent resumes. */
export function continuesSession(state: AgentState | null): boolean {
  return state === "completed" || state === "paused" || state === "failed";
}

export interface PromptDockProps {
  bridge: Pick<JevcodeApi, "agent" | "session">;
  sessionId: string;
  state: AgentState | null;
  composer: ComposerState;
  dispatch: Dispatch<ComposerEvent>;
  pending: AgentInstructionStatePayload["pending"];
  /** The held note's session prompt, once known (WorkspaceHost asks repo:listSessions). */
  noteTargetPrompt: string | undefined;
}

/**
 * The prompt line docked under every view (spec §3.1). It is today's composer
 * in a CLI shape: a › glyph, monospace input, Enter for a new line, Cmd+Enter
 * to send, Steer or Queue, Continue on a finished session, queued items above
 * the line, and the held-note notice. Draft rules stay in composerReducer.
 */
export function PromptDock(props: PromptDockProps) {
  const { bridge, sessionId, state, composer, dispatch, pending } = props;
  const [mode, setMode] = useState<InstructionMode>("steer");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const continuing = continuesSession(state);
  const note = composer.held;

  useEffect(() => {
    setError(null);
  }, [sessionId]);

  // Spec §3.7: Cmd+L focuses the prompt line from anywhere in the window.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "l") {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A note that arrived during a send takes focus once the input is enabled again.
  useEffect(() => {
    if (!composer.focusPending) return;
    const element = inputRef.current;
    if (element === null || element.disabled) return;
    element.focus();
    const end = element.value.length;
    element.setSelectionRange(end, end);
    element.scrollTop = element.scrollHeight;
    dispatch({ type: "focusDone" });
  }, [composer.focusPending, sending, sessionId, dispatch]);

  const send = async (): Promise<void> => {
    const text = composer.draft.trim();
    if (text.length === 0 || sending) return;
    const sentDraft = composer.draft;
    setSending(true);
    setError(null);
    try {
      await bridge.agent.sendInstruction(sessionId, text, continuing ? "queue" : mode);
      if (continuing) await bridge.agent.resume(sessionId);
      dispatch({ type: "sent", text: sentDraft });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };

  const toggleAgent = async (): Promise<void> => {
    setError(null);
    try {
      if (state === "running" || state === "starting") await bridge.agent.interrupt(sessionId);
      else if (state === "paused") await bridge.agent.resume(sessionId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const switchToNote = (): void => {
    if (note === null) return;
    setError(null);
    void bridge.session.switchTo(note.note.sessionId).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };

  const canPause = state === "running" || state === "starting";
  return (
    <section className="prompt-dock" aria-label="Prompt">
      {note !== null ? (
        <p className="dock-note" role="status">
          {note.replaced ? "Newer trace note for another session replaced the earlier one" : "Trace note for another session"}{" "}
          <span className="dock-note-target">({traceNoteTarget(props.noteTargetPrompt, note.note.sessionId)})</span>{" "}
          <button type="button" className="dock-link" onClick={switchToNote}>
            Switch
          </button>{" "}
          <button type="button" className="dock-link dock-link-muted" onClick={() => dispatch({ type: "dismiss" })}>
            Dismiss
          </button>
        </p>
      ) : null}
      {pending.length > 0 ? (
        <ul className="dock-queue" aria-label="Queued instructions">
          {pending.map((item) => (
            <li key={item.id}>
              <span className="dock-queue-mode">{item.mode === "steer" ? "steer" : "next"}</span>
              <span className="dock-queue-text" title={item.text}>
                {item.text}
              </span>
              <button
                type="button"
                className="dock-queue-cancel"
                aria-label="Cancel queued instruction"
                onClick={() => void bridge.agent.cancelInstruction(sessionId, item.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="dock-line">
        <span className="dock-glyph" aria-hidden="true">
          ›
        </span>
        <textarea
          ref={inputRef}
          className="dock-input"
          aria-label="Guide the agent"
          rows={1}
          placeholder={continuing ? "Ask for a follow-up or revision…" : "Redirect, add a constraint, or ask what the agent is doing…"}
          value={composer.draft}
          disabled={sending}
          onChange={(event) => dispatch({ type: "edit", draft: event.target.value })}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void send();
            }
          }}
        />
      </div>
      <div className="dock-footer">
        {continuing ? (
          <span className="dock-hint">Continues the session</span>
        ) : (
          <button
            type="button"
            className="dock-mode"
            aria-label="Instruction timing"
            onClick={() => setMode((current) => (current === "steer" ? "queue" : "steer"))}
          >
            {mode === "steer" ? "Steer" : "Queue"} ▾
          </button>
        )}
        <span className="dock-shortcut">⌘↵ send</span>
        {state !== null ? (
          <span className={`dock-status dock-status-${state}`}>
            <span className="dock-status-dot" aria-hidden="true" />
            {agentStateLabel(state)}
          </span>
        ) : null}
        {canPause || state === "paused" ? (
          <button type="button" className="dock-pause" onClick={() => void toggleAgent()}>
            {state === "paused" ? "Resume" : "Pause"}
          </button>
        ) : null}
        <button
          type="button"
          className="dock-send"
          disabled={composer.draft.trim().length === 0 || sending}
          onClick={() => void send()}
        >
          {sending ? "Sending…" : continuing ? "Continue" : mode === "steer" ? "Steer agent" : "Add to queue"}
        </button>
      </div>
      {error !== null ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
```

- [ ] **Step 5: Replace `WorkspaceHost` with the composition root**

Replace `apps/desktop/src/renderer/components/WorkspaceHost.tsx` with:

```tsx
import { setActionDispatcher } from "@jevcode/ui-catalog";
import { useCallback, useEffect, useReducer, useState } from "react";

import type { AgentInstructionStatePayload } from "../../shared/api.js";
import { getBridge } from "../bridge.js";
import type { RepoOpenedPayload, SessionStatePayload } from "../payload-types.js";
import { EmbeddedWorkspace } from "../workspace/EmbeddedWorkspace.js";
import { PromptDock } from "../workspace/PromptDock.js";
import { SurfacesContext, useSessionSurfaces } from "../workspace/session-surfaces.js";
import { composerReducer, initialComposer } from "./composer-prefill.js";
import { TaskPrompt } from "./TaskPrompt.js";

interface WorkspaceHostProps {
  repo: RepoOpenedPayload | null;
  sessionState: SessionStatePayload | null;
  activePrompt: string;
  agentLine: string;
  onStart: (prompt: string) => void | Promise<void>;
}

/**
 * The main window's center column (spec §3.1, §9): TaskPrompt before the first
 * prompt, then the embedded viewer for the active session above the prompt
 * dock. The composer's draft lives here so that both the dock and the viewer's
 * "Request changes" (mainHost) feed the same composerReducer.
 */
export function WorkspaceHost(props: WorkspaceHostProps) {
  const bridge = getBridge();
  const sessionId = props.sessionState?.sessionId ?? null;
  const surfaces = useSessionSurfaces(bridge, props.sessionState);
  const [pending, setPending] = useState<AgentInstructionStatePayload["pending"]>([]);
  const [composer, dispatchComposer] = useReducer(composerReducer, sessionId, initialComposer);
  const noteSessionId = composer.held?.note.sessionId ?? null;
  const repoId = props.repo?.repoId ?? null;
  const [noteTarget, setNoteTarget] = useState<{ sessionId: string; prompt: string | undefined } | null>(null);

  useEffect(() => {
    setActionDispatcher((action, params) => {
      void bridge.action.invoke(action, params);
    });
    return () => {
      setActionDispatcher(undefined);
    };
  }, [bridge]);

  useEffect(() => {
    setPending([]);
    if (!sessionId) return undefined;
    return bridge.onInstructionState((instructionState) => {
      if (instructionState.sessionId === sessionId) setPending(instructionState.pending);
    });
  }, [bridge, sessionId]);

  useEffect(() => {
    if (noteSessionId === null || repoId === null) return undefined;
    let cancelled = false;
    void bridge.repo
      .listSessions(repoId)
      .then((sessions) => {
        if (cancelled) return;
        setNoteTarget({ sessionId: noteSessionId, prompt: sessions.find((s) => s.sessionId === noteSessionId)?.prompt });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bridge, repoId, noteSessionId]);

  useEffect(() => {
    dispatchComposer({ type: "sessionChanged", sessionId });
  }, [sessionId]);

  useEffect(() => {
    return bridge.onComposerPrefill((payload) => {
      dispatchComposer({ type: "prefill", payload });
    });
  }, [bridge]);

  const onRequestChanges = useCallback(
    (text: string) => {
      if (sessionId !== null) dispatchComposer({ type: "prefill", payload: { sessionId, text } });
    },
    [sessionId],
  );

  if (props.activePrompt.trim().length === 0 || sessionId === null) {
    return (
      <section className="workspace workspace-onboarding">
        <TaskPrompt repo={props.repo} agentLine={props.agentLine} onSubmit={props.onStart} />
      </section>
    );
  }

  return (
    <section className="workspace workspace-session">
      <SurfacesContext.Provider value={surfaces}>
        <EmbeddedWorkspace
          key={sessionId}
          sessionId={sessionId}
          repoRoot={props.repo?.gitRoot ?? null}
          onRequestChanges={onRequestChanges}
        />
      </SurfacesContext.Provider>
      <PromptDock
        bridge={bridge}
        sessionId={sessionId}
        state={props.sessionState?.state ?? null}
        composer={composer}
        dispatch={dispatchComposer}
        pending={pending}
        noteTargetPrompt={noteTarget?.sessionId === noteSessionId ? noteTarget?.prompt : undefined}
      />
    </section>
  );
}
```

- [ ] **Step 6: Style the dock and the bar, and drop the dead rules**

Append to `apps/desktop/src/renderer/styles.css`:

```css
/* Workspace column (spec §3.1): viewer above, prompt dock below. */
.workspace-session {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--tv-panel);
}

.prompt-dock {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 16px 10px;
  background: var(--tv-panel);
  box-shadow: 0 -1px 0 var(--tv-hair);
}

.dock-line {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.dock-glyph {
  color: var(--tv-accent);
  font-family: var(--mono);
  font-size: 14px;
  line-height: 20px;
}

.dock-input {
  flex: 1;
  min-height: 20px;
  max-height: 160px;
  padding: 0;
  border: 0;
  outline: none;
  resize: none;
  background: transparent;
  color: var(--tv-ink);
  font-family: var(--mono);
  font-size: 13px;
  line-height: 20px;
  field-sizing: content;
}

.dock-input::placeholder {
  color: var(--tv-ink-4);
}

.dock-footer {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--tv-ink-3);
  font-size: 12px;
}

.dock-mode,
.dock-pause {
  padding: 2px 8px;
  border: 0;
  border-radius: 6px;
  background: var(--tv-fill);
  color: var(--tv-ink-2);
  font-size: 12px;
  cursor: pointer;
}

.dock-mode:hover,
.dock-pause:hover {
  background: var(--tv-fill-2);
}

.dock-shortcut {
  color: var(--tv-ink-4);
  font-family: var(--mono);
}

.dock-hint {
  color: var(--tv-ink-3);
}

.dock-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}

.dock-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--tv-mark);
}

.dock-status-running .dock-status-dot,
.dock-status-starting .dock-status-dot,
.dock-status-waiting_decision .dock-status-dot {
  background: var(--tv-accent);
}

.dock-status-failed .dock-status-dot {
  background: var(--tv-bad);
}

.dock-status-completed .dock-status-dot {
  background: var(--tv-good);
}

.dock-send {
  padding: 4px 10px;
  border: 0;
  border-radius: 6px;
  background: var(--tv-accent);
  color: var(--tv-panel);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.dock-send:disabled {
  background: var(--tv-fill-2);
  color: var(--tv-ink-4);
  cursor: default;
}

.dock-queue {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.dock-queue li {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--tv-ink-2);
  font-size: 12px;
}

.dock-queue-mode {
  color: var(--tv-ink-4);
  font-family: var(--mono);
}

.dock-queue-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dock-queue-cancel {
  border: 0;
  background: transparent;
  color: var(--tv-ink-4);
  cursor: pointer;
}

.dock-note {
  margin: 0;
  color: var(--tv-ink-2);
  font-size: 12px;
}

.dock-link {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--tv-accent-ink);
  font-size: 12px;
  cursor: pointer;
}

.dock-link-muted {
  color: var(--tv-ink-3);
}
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/renderer/styles-tokens.test.ts`

Expected: "keeps no rule for a class nothing renders" lists the old composer, heading and rail classes (`session-composer`, `session-heading`, `context-rail`, `context-now`, `instruction-queue`, `instruction-modes` and so on). Delete those rules and rerun until the file passes.

- [ ] **Step 7: Run the tests to see them pass**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/renderer/workspace/prompt-dock.test.tsx src/renderer/workspace/surfaces-view.test.tsx src/renderer/components/workspace-host.test.tsx src/renderer/styles-tokens.test.ts`

Expected: PASS, including the D-2 Review Focus 4 test, which still finds "Guide the agent" and "Trace note for another session".

- [ ] **Step 8: Package checks**

Run: `perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop test`, `perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop typecheck`, `perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop build`, `perl -e 'alarm 170; exec @ARGV' pnpm lint`.

Expected: all exit 0.

- [ ] **Step 9: Screenshot and compare with the mockup**

Run the smoke as in D-2 Step 11 with `.superpowers/shots/d3` and `.superpowers/smoke-d3.log`, and restore the Node ABI (D-6 Step 9). Compare `main-console-1440.png` and `-1000.png` with the mockup:

- the switcher bar sits at the top
- the dock at the bottom has the `›` glyph and its one-line footer
- the queue (if any) sits above the line
- no right-hand rail sits outside the viewer
- the Brief occupies the viewer's right panel. It is absent until 02b is merged, which is expected on this branch.

Adjust spacing and type through tokens only, then rerun the dock tests.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src/renderer/workspace/PromptDock.tsx apps/desktop/src/renderer/workspace/prompt-dock.test.tsx apps/desktop/src/renderer/workspace/surfaces-view.tsx apps/desktop/src/renderer/workspace/surfaces-view.test.tsx apps/desktop/src/renderer/components/WorkspaceHost.tsx apps/desktop/src/renderer/components/workspace-host.test.tsx apps/desktop/src/renderer/styles.css
git -c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com commit -m "feat(desktop): dock the prompt line under every view and retire the context rail"
```

---

### Task D-6: Electron smoke for the main window, append latency, screenshots

**Depends on:** D-1 to D-5, and 02b merged with this branch rebased on it.

**Files:**
- Create: `apps/desktop/src/renderer/workspace/paint-probe.ts`
- Modify: `apps/desktop/src/main/smoke-workspace.ts` (whole file replaced: latency and view walk), `apps/desktop/src/main/smoke.ts` (timeout, options), `apps/desktop/src/main/index.ts` (append log, `?smoke=1`)
- Modify: `apps/desktop/src/renderer/main.tsx` (perf mark, probe), `apps/desktop/src/renderer/workspace/EmbeddedWorkspace.tsx` (wrap the source), `apps/desktop/src/renderer/workspace/main-host.ts` (`WORKSPACE_LOCATION`)
- Modify: `apps/desktop/scripts/smoke-workspace.mjs` (env for the latency run)
- Modify: `docs/perf.md` (one row)
- Test: `apps/desktop/src/renderer/workspace/paint-probe.test.ts` (new), `apps/desktop/src/main/smoke-workspace.test.ts`, `apps/desktop/src/renderer/workspace/main-host.test.ts`

**Interfaces:**
- Consumes: `PERF.liveTick` (`"tv:live-tick"`) and the Shell's per-commit `measureAfterPaint(PERF.liveTick, LIVE_TICK_START)` (`packages/trace-viewer/src/ui/shell/Shell.tsx`); `ViewerHost.onLocation` (`ViewerLocation.view`, `.selected`); `observeTraceAppends` (D-1); and the viewer keys `0` to `4` (V-2), `j` and Console selection (V-4).
- Produces:
  - `createPaintProbe`, `installPaintProbe`, `paintProbe`, `SeqLedger` and `consolePaintLine`.
  - `createAppendLog`, `appendLatencies`, `percentile`, `parseConsolePaint`, `parseWorkspaceLocation`, `pressKeyScript`, `VIEW_KEYS` and `CONSOLE_APPEND_P95_BUDGET_MS = 150`.
  - `MainHostDeps.logLocations?: boolean`.

- [ ] **Step 1: Rebase on 02b**

```bash
git -C /Users/jwpark/Projects/jevcode-ce-03 rebase main
pnpm install --frozen-lockfile
perl -e 'alarm 170; exec @ARGV' pnpm -r build
perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop test
```

Expected: the rebase succeeds. Resolve conflicts only in this lane's files, and keep both sides of `packages/trace-viewer/src/index.ts`. All desktop tests pass. `grep -c '"console"' packages/trace-viewer/src/ui/views/registry.ts` prints at least `1`, so the Console view is present.

- [ ] **Step 2: Write the failing probe and smoke tests**

Create `apps/desktop/src/renderer/workspace/paint-probe.test.ts`:

```ts
import type { TraceRowsPage, TraceSessionSummary } from "@jevcode/contracts";
import type { TraceSource } from "@jevcode/trace-viewer";
import { describe, expect, it } from "vitest";

import { SeqLedger, consolePaintLine, createPaintProbe } from "./paint-probe.js";

function page(seqs: number[]): TraceRowsPage {
  return {
    rows: seqs.map((seq) => ({ seq, type: "agent_event", ts: "2026-10-02T10:00:00.000Z", payload: {} })),
    nextAfterSeq: null,
    lastSeq: seqs.at(-1) ?? 0,
    state: "running",
  };
}

function source(pages: TraceRowsPage[]): TraceSource {
  let index = 0;
  return {
    sessionId: "s1",
    summary: async () => ({ sessionId: "s1" }) as TraceSessionSummary,
    rows: async () => pages[Math.min(index++, pages.length - 1)] ?? page([]),
    payloads: async () => [],
    now: () => 0,
  };
}

describe("SeqLedger", () => {
  it("answers the highest seq that had arrived by a time", () => {
    const ledger = new SeqLedger();
    ledger.record(10, 3);
    ledger.record(20, 5);
    ledger.record(25, 4);
    expect([ledger.throughAt(5), ledger.throughAt(10), ledger.throughAt(19), ledger.throughAt(30)]).toEqual([0, 3, 3, 5]);
  });
});

describe("createPaintProbe", () => {
  it("logs one CONSOLE_PAINT per live-tick measure that paints new rows, in epoch ms", async () => {
    let now = 100;
    const lines: string[] = [];
    const probe = createPaintProbe({ now: () => now, timeOrigin: 1_000_000, log: (line) => lines.push(line) });
    const wrapped = probe.wrap(source([page([1, 2]), page([3])]));
    await wrapped.rows();
    now = 200;
    await wrapped.rows();
    probe.onEntry({ name: "tv:live-tick", entryType: "measure", startTime: 150, duration: 12 });
    probe.onEntry({ name: "tv:live-tick", entryType: "measure", startTime: 160, duration: 5 });
    probe.onEntry({ name: "tv:first-paint", entryType: "measure", startTime: 300, duration: 5 });
    probe.onEntry({ name: "tv:live-tick", entryType: "measure", startTime: 210, duration: 8 });
    expect(lines).toEqual([consolePaintLine("s1", 2, 1_000_162), consolePaintLine("s1", 3, 1_000_218)]);
    expect(lines[0]).toBe("CONSOLE_PAINT s1 2 1000162");
  });

  it("keeps the wrapped source's other members", () => {
    const probe = createPaintProbe({ now: () => 0, timeOrigin: 0, log: () => undefined });
    const base = { ...source([page([])]), onRowsAvailable: () => () => undefined };
    const wrapped = probe.wrap(base);
    expect(wrapped.sessionId).toBe("s1");
    expect(wrapped.onRowsAvailable).toBe(base.onRowsAvailable);
  });
});
```

Replace `apps/desktop/src/main/smoke-workspace.test.ts` with the D-2 tests, adapted to the new options, plus the latency and view tests:

```ts
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONSOLE_APPEND_P95_BUDGET_MS,
  SHOT_HEIGHT,
  SHOT_WIDTHS,
  SMOKE_PROMPT,
  VIEW_KEYS,
  appendLatencies,
  createAppendLog,
  openRepoScript,
  parseConsolePaint,
  parseWorkspaceLocation,
  parseWorkspaceReady,
  percentile,
  pressKeyScript,
  runWorkspaceSmoke,
  startSessionScript,
} from "./smoke-workspace.js";
import type { WorkspaceSmokeDeps } from "./smoke-workspace.js";

interface FakeOptions {
  /** Selection reported after each view key; default: unchanged. */
  selectedFor?: (view: string) => string;
  /** Latency in ms between each stored row and its paint. */
  paintDelayMs?: number;
  rows?: number;
}

function fake(options: FakeOptions = {}) {
  const listeners = new Set<(message: string) => void>();
  const execs: string[] = [];
  const files = new Map<string, Uint8Array>();
  const lines: string[] = [];
  let wall = 10_000;
  const appends = createAppendLog(() => wall);
  const emit = (message: string) => {
    for (const listener of [...listeners]) listener(message);
  };
  const deps: WorkspaceSmokeDeps = {
    exec: async (script) => {
      execs.push(script);
      if (script.includes("listSessions")) return "s1";
      if (script.includes("session.start")) {
        queueMicrotask(() => emit("WORKSPACE_READY 2"));
        // The mock agent, one macrotask later (after the smoke has read readyAt):
        // rows stored after ready, each painted paintDelayMs later, then quiet.
        setTimeout(() => {
          const count = options.rows ?? 5;
          for (let seq = 3; seq < 3 + count; seq += 1) {
            wall += 300;
            appends.record("s1", seq);
            emit(`CONSOLE_PAINT s1 ${seq} ${wall + (options.paintDelayMs ?? 40)}`);
          }
          wall += 10_000;
        }, 5);
        return "repo_1";
      }
      const key = VIEW_KEYS.find((entry) => script.includes(`"${entry.code}"`));
      if (script.includes('"KeyJ"')) queueMicrotask(() => emit('WORKSPACE_LOCATION {"view":"console","selected":"step:3"}'));
      if (key !== undefined) {
        const selected = options.selectedFor?.(key.view) ?? "step:3";
        queueMicrotask(() => emit(`WORKSPACE_LOCATION ${JSON.stringify({ view: key.view, selected })}`));
      }
      return true;
    },
    onConsole: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    capture: async () => new Uint8Array([1]),
    writeFile: (file, data) => {
      files.set(file, data);
    },
    appends,
    wallNow: () => wall,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 1)),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    log: (line) => lines.push(line),
  };
  return { deps, execs, files, lines };
}

describe("smoke-workspace parsing", () => {
  it("parses only exact smoke lines", () => {
    expect(parseWorkspaceReady("WORKSPACE_READY 12")).toBe(12);
    expect(parseWorkspaceReady("x WORKSPACE_READY 1")).toBeNull();
    expect(parseConsolePaint("CONSOLE_PAINT s1 41 1700000000123")).toEqual({ sessionId: "s1", throughSeq: 41, atMs: 1700000000123 });
    expect(parseConsolePaint("CONSOLE_PAINT s1 41")).toBeNull();
    expect(parseWorkspaceLocation('WORKSPACE_LOCATION {"view":"map","selected":"step:9"}')).toEqual({ view: "map", selected: "step:9" });
    expect(parseWorkspaceLocation('WORKSPACE_LOCATION {"view":"map"}')).toEqual({ view: "map", selected: null });
    expect(parseWorkspaceLocation("WORKSPACE_LOCATION {")).toBeNull();
  });

  it("JSON-encodes values that reach executeJavaScript", () => {
    expect(openRepoScript('/tmp/a"b')).toContain(JSON.stringify('/tmp/a"b'));
    expect(startSessionScript(SMOKE_PROMPT)).toContain(JSON.stringify(SMOKE_PROMPT));
    expect(pressKeyScript("Digit3", "3")).toContain('"Digit3"');
  });
});

describe("append latency (spec §11)", () => {
  it("uses the spec budget", () => {
    expect(CONSOLE_APPEND_P95_BUDGET_MS).toBe(150);
  });

  it("measures each stored row to the first paint covering its seq", () => {
    const { latencies, unpainted } = appendLatencies(
      [
        { seq: 4, atMs: 1_000 },
        { seq: 5, atMs: 1_010 },
        { seq: 6, atMs: 1_500 },
        { seq: 7, atMs: 2_000 },
      ],
      [
        { sessionId: "s1", throughSeq: 5, atMs: 1_060 },
        { sessionId: "s1", throughSeq: 6, atMs: 1_530 },
      ],
    );
    expect(latencies).toEqual([60, 50, 30]);
    expect(unpainted).toEqual([7]);
  });

  it("takes the nearest-rank percentile", () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentile(values, 0.95)).toBe(95);
    expect(percentile(values, 0.5)).toBe(50);
    expect(percentile([7], 0.95)).toBe(7);
    expect(Number.isNaN(percentile([], 0.95))).toBe(true);
  });
});

describe("runWorkspaceSmoke", () => {
  it("measures appends, walks every view with the selection kept, then captures 1440 and 1000", async () => {
    const run = fake({ rows: 5, paintDelayMs: 40 });
    await runWorkspaceSmoke(run.deps, { repoPath: "/tmp/repo", shotsDir: "/tmp/shots", minSamples: 5 });
    expect(run.execs.slice(0, 2)).toEqual([openRepoScript("/tmp/repo"), startSessionScript(SMOKE_PROMPT)]);
    expect(run.lines).toContain("SMOKE_CONSOLE appends=5 p50_ms=40 p95_ms=40 max_ms=40");
    expect(run.lines).toContain("SMOKE_VIEWS selected=step:3 views=canvas,hybrid,map,surfaces,console");
    expect([...run.files.keys()]).toEqual(SHOT_WIDTHS.map((width) => path.join("/tmp/shots", `main-console-${width}.png`)));
    expect(SHOT_HEIGHT).toBe(900);
  });

  it("fails over the p95 budget", async () => {
    const run = fake({ rows: 5, paintDelayMs: 400 });
    await expect(runWorkspaceSmoke(run.deps, { repoPath: "/tmp/repo", shotsDir: null, minSamples: 5 })).rejects.toThrow(
      /p95 400 ms is over the 150 ms budget/,
    );
  });

  it("fails with too few samples for a p95", async () => {
    const run = fake({ rows: 5 });
    await expect(runWorkspaceSmoke(run.deps, { repoPath: "/tmp/repo", shotsDir: null, minSamples: 300 })).rejects.toThrow(
      /only 5 append samples \(need 300\)/,
    );
  });

  it("fails when a view switch loses the selection", async () => {
    const run = fake({ selectedFor: (view) => (view === "hybrid" ? "step:9" : "step:3") });
    await expect(runWorkspaceSmoke(run.deps, { repoPath: "/tmp/repo", shotsDir: null, minSamples: 5 })).rejects.toThrow(
      /selection changed on hybrid: step:3 → step:9/,
    );
  });
});
```

Append to `apps/desktop/src/renderer/workspace/main-host.test.ts`:

```ts
describe("createMainHost smoke locations", () => {
  it("logs WORKSPACE_LOCATION only when asked", () => {
    const lines: string[] = [];
    const base = {
      bridge: {} as Pick<JevcodeApi, "action" | "trace" | "overview">,
      sessionId: "s1",
      repoRoot: () => null,
      prefill: () => undefined,
      log: (line: string) => lines.push(line),
    };
    const location = { v: 1, sessionId: "s1", view: "map", level: "chapter", selected: "step:3", brush: { kind: "session" } };
    createMainHost(base).onLocation?.(location as never);
    expect(lines).toEqual([]);
    createMainHost({ ...base, logLocations: true }).onLocation?.(location as never);
    expect(lines).toEqual(['WORKSPACE_LOCATION {"view":"map","selected":"step:3"}']);
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/renderer/workspace/paint-probe.test.ts src/main/smoke-workspace.test.ts src/renderer/workspace/main-host.test.ts`

Expected: FAIL. `./paint-probe.js` does not resolve. The smoke file fails on the missing exports (`appendLatencies is not a function`, etc.). The new main-host test fails with `expected [] to deeply equal [ 'WORKSPACE_LOCATION …' ]`.

- [ ] **Step 4: Implement the paint probe and its wiring**

Create `apps/desktop/src/renderer/workspace/paint-probe.ts`:

```ts
import { PERF } from "@jevcode/trace-viewer";
import type { TraceSource } from "@jevcode/trace-viewer";

export interface PerfEntryLike {
  name: string;
  entryType: string;
  startTime: number;
  duration: number;
}

/** "CONSOLE_PAINT <sessionId> <throughSeq> <epochMs>": rows up to throughSeq were on screen at epochMs. */
export function consolePaintLine(sessionId: string, throughSeq: number, epochMs: number): string {
  return `CONSOLE_PAINT ${sessionId} ${throughSeq} ${Math.round(epochMs)}`;
}

/** Row arrivals in renderer time; throughAt(t) is the highest seq that had arrived by t. */
export class SeqLedger {
  private readonly arrivals: Array<{ at: number; seq: number }> = [];

  record(at: number, seq: number): void {
    const last = this.arrivals.at(-1);
    if (last !== undefined && seq <= last.seq) return;
    this.arrivals.push({ at, seq });
  }

  throughAt(at: number): number {
    let through = 0;
    for (const arrival of this.arrivals) {
      if (arrival.at > at) break;
      through = arrival.seq;
    }
    return through;
  }
}

export interface PaintProbe {
  wrap(source: TraceSource): TraceSource;
  onEntry(entry: PerfEntryLike): void;
}

/**
 * Smoke-only (?smoke=1). Spec §11 measures Console append latency as "row
 * stored → line painted". The Shell records tv:live-tick from the page that
 * carried new rows to the paint after its commit. A row counts as painted at
 * that measure's end when it had arrived by the measure's start. Rows that
 * arrive later in the same commit are credited to the next tick, so the
 * estimate errs high.
 */
export function createPaintProbe(deps: { now(): number; timeOrigin: number; log(line: string): void }): PaintProbe {
  let current: { sessionId: string; ledger: SeqLedger } | null = null;
  let lastLogged = 0;
  return {
    wrap(source) {
      const ledger = new SeqLedger();
      current = { sessionId: source.sessionId, ledger };
      lastLogged = 0;
      return {
        ...source,
        rows: async (request) => {
          const page = await source.rows(request);
          const last = page.rows.at(-1);
          if (last !== undefined) ledger.record(deps.now(), last.seq);
          return page;
        },
      };
    },
    onEntry(entry) {
      if (current === null || entry.entryType !== "measure" || entry.name !== PERF.liveTick) return;
      const through = current.ledger.throughAt(entry.startTime);
      if (through <= lastLogged) return;
      lastLogged = through;
      deps.log(consolePaintLine(current.sessionId, through, deps.timeOrigin + entry.startTime + entry.duration));
    },
  };
}

let active: PaintProbe | null = null;

export function installPaintProbe(probe: PaintProbe | null): void {
  active = probe;
}

export function paintProbe(): PaintProbe | null {
  return active;
}
```

In `apps/desktop/src/renderer/main.tsx`, add the imports `import { PERF } from "@jevcode/trace-viewer";` and `import { createPaintProbe, installPaintProbe } from "./workspace/paint-probe.js";`, and before `applyViewerTokens(…)` insert:

```ts
// The embedded viewer measures first paint, full load and live ticks from this mark (as trace/main.tsx does).
performance.mark(PERF.bundleParsed);

// Smoke only: main loads the window with ?smoke=1 for JEVCODE_SMOKE_WORKSPACE (D-6).
if (new URLSearchParams(window.location.search).get("smoke") === "1" && typeof PerformanceObserver !== "undefined") {
  const probe = createPaintProbe({
    now: () => performance.now(),
    timeOrigin: performance.timeOrigin,
    log: (line) => console.log(line),
  });
  installPaintProbe(probe);
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) probe.onEntry(entry);
  }).observe({ entryTypes: ["measure"] });
}
```

In `apps/desktop/src/renderer/workspace/EmbeddedWorkspace.tsx`, import `paintProbe` from `./paint-probe.js` and change the two `useMemo`s to:

```tsx
  const source = useMemo(() => {
    const base = createIpcTraceSource(bridge.trace, props.sessionId);
    return paintProbe()?.wrap(base) ?? base;
  }, [bridge, props.sessionId]);
  const host = useMemo(
    () =>
      createMainHost({
        bridge,
        sessionId: props.sessionId,
        repoRoot: () => latest.current.repoRoot,
        prefill: (text) => latest.current.onRequestChanges(text),
        log: (line) => console.log(line),
        logLocations: paintProbe() !== null,
      }),
    [bridge, props.sessionId],
  );
```

In `apps/desktop/src/renderer/workspace/main-host.ts`, add to `MainHostDeps`: `/** Smoke only: log every view and selection change as WORKSPACE_LOCATION. */ logLocations?: boolean;`. Add to the returned host:

```ts
    onLocation: deps.logLocations
      ? (location) => {
          deps.log(`WORKSPACE_LOCATION ${JSON.stringify({ view: location.view, selected: location.selected ?? null })}`);
        }
      : undefined,
```

- [ ] **Step 5: Implement the latency and view phases**

Replace `apps/desktop/src/main/smoke-workspace.ts` with:

```ts
import path from "node:path";

/**
 * JEVCODE_SMOKE_WORKSPACE=1 (spec §12 "Electron smoke"). The phase drives the
 * real main window through the real IPC path:
 * 1. open a git repo, start a scripted mock session, wait for WORKSPACE_READY
 * 2. measure Console append latency, from main's append clock to the
 *    renderer's CONSOLE_PAINT lines (p95 ≤ 150 ms over ≥ minSamples rows)
 * 3. select a step and walk every view by key, checking the selection survives
 * 4. capture the window at 1440 and 1000 px
 * Electron is reached only through WorkspaceSmokeDeps.
 */

export const WORKSPACE_READY_TIMEOUT_MS = 30_000;
export const SHOT_WIDTHS = [1440, 1000] as const;
export const SHOT_HEIGHT = 900;
export const SMOKE_PROMPT = "Smoke: show the Console while the mock agent works";
/** Spec §11: Console append latency, row stored → line painted, with the push hint. */
export const CONSOLE_APPEND_P95_BUDGET_MS = 150;
/** docs/perf.md: a p95 budget needs at least 300 samples. */
export const DEFAULT_MIN_SAMPLES = 300;
/** The mock run is over once no row has been stored for this long. */
export const APPEND_QUIET_MS = 3_000;
export const APPEND_PHASE_TIMEOUT_MS = 180_000;
export const VIEW_STEP_TIMEOUT_MS = 5_000;
/** Spec §3.7 and §8.6 keys, ending back on Console. */
export const VIEW_KEYS = [
  { code: "Digit1", key: "1", view: "canvas" },
  { code: "Digit2", key: "2", view: "hybrid" },
  { code: "Digit3", key: "3", view: "map" },
  { code: "Digit4", key: "4", view: "surfaces" },
  { code: "Digit0", key: "0", view: "console" },
] as const;

export interface AppendRecord {
  seq: number;
  atMs: number;
}

export interface AppendLog {
  record(sessionId: string, seq: number): void;
  entries(sessionId: string): readonly AppendRecord[];
}

/** Main's wall clock at each committed trace-row append (fed by observeTraceAppends). */
export function createAppendLog(now: () => number): AppendLog {
  const bySession = new Map<string, AppendRecord[]>();
  return {
    record(sessionId, seq) {
      const list = bySession.get(sessionId) ?? [];
      list.push({ seq, atMs: now() });
      bySession.set(sessionId, list);
    },
    entries: (sessionId) => bySession.get(sessionId) ?? [],
  };
}

export interface ConsolePaint {
  sessionId: string;
  throughSeq: number;
  atMs: number;
}

export interface WorkspaceLocation {
  view: string;
  selected: string | null;
}

export interface WorkspaceSmokeDeps {
  /** mainWindow.webContents.executeJavaScript(script, true). */
  exec(script: string): Promise<unknown>;
  /** Every main-window console line; returns the unsubscribe. */
  onConsole(listener: (message: string) => void): () => void;
  /** Resizes the window's content to width × height, lets it settle, returns a PNG. */
  capture(width: number, height: number): Promise<Uint8Array>;
  writeFile(filePath: string, data: Uint8Array): void;
  appends: AppendLog;
  /** Date.now(): the clock both the append log and CONSOLE_PAINT use. */
  wallNow(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  log(line: string): void;
}

export interface WorkspaceSmokeOptions {
  repoPath: string;
  shotsDir: string | null;
  minSamples: number;
}

export function parseWorkspaceReady(message: string): number | null {
  const match = /^WORKSPACE_READY (\d+)$/.exec(message);
  return match === null ? null : Number(match[1]);
}

export function parseConsolePaint(message: string): ConsolePaint | null {
  const match = /^CONSOLE_PAINT (\S+) (\d+) (\d+)$/.exec(message);
  if (match === null) return null;
  return { sessionId: match[1] ?? "", throughSeq: Number(match[2]), atMs: Number(match[3]) };
}

export function parseWorkspaceLocation(message: string): WorkspaceLocation | null {
  const prefix = "WORKSPACE_LOCATION ";
  if (!message.startsWith(prefix)) return null;
  try {
    const value: unknown = JSON.parse(message.slice(prefix.length));
    if (typeof value !== "object" || value === null) return null;
    const { view, selected } = value as { view?: unknown; selected?: unknown };
    if (typeof view !== "string") return null;
    return { view, selected: typeof selected === "string" ? selected : null };
  } catch {
    return null;
  }
}

/** For each stored row, the time until the first paint whose throughSeq covers it; rows no paint covers are unpainted. */
export function appendLatencies(
  appends: readonly AppendRecord[],
  paints: readonly ConsolePaint[],
): { latencies: number[]; unpainted: number[] } {
  const ordered = [...paints].sort((a, b) => a.atMs - b.atMs);
  const latencies: number[] = [];
  const unpainted: number[] = [];
  for (const append of appends) {
    const paint = ordered.find((candidate) => candidate.throughSeq >= append.seq);
    if (paint === undefined) unpainted.push(append.seq);
    else latencies.push(Math.max(0, paint.atMs - append.atMs));
  }
  return { latencies, unpainted };
}

/** Nearest-rank percentile; NaN for no values. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return sorted[rank - 1] ?? Number.NaN;
}

export function openRepoScript(repoPath: string): string {
  return `window.jevcode.repo.open(${JSON.stringify(repoPath)})`;
}

export function startSessionScript(prompt: string): string {
  return `(async () => {
    const [repo] = await window.jevcode.repo.listRecent(1);
    if (repo === undefined) throw new Error("no recent repo after repo:open");
    await window.jevcode.session.start(repo.repoId, ${JSON.stringify(prompt)});
    return repo.repoId;
  })()`;
}

/** The newest session is the one repo:open created and session:start ran. */
export const NEWEST_SESSION_SCRIPT =
  "window.jevcode.trace.listSessions({ limit: 1 }).then((sessions) => sessions[0]?.sessionId ?? null)";

/** A key press as the viewer's KeyboardLayer sees it, never inside a text field (viewer spec §7.9). */
export function pressKeyScript(code: string, key: string): string {
  return `(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    const init = { key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)}, bubbles: true, cancelable: true };
    document.body.dispatchEvent(new KeyboardEvent("keydown", init));
    document.body.dispatchEvent(new KeyboardEvent("keyup", init));
    return true;
  })()`;
}

export function waitForLine<T>(
  deps: Pick<WorkspaceSmokeDeps, "onConsole" | "setTimeout" | "clearTimeout">,
  parse: (message: string) => T | null,
  timeoutMs: number,
  what: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: unknown = null;
    const off = deps.onConsole((message) => {
      const value = parse(message);
      if (value === null) return;
      if (timer !== null) deps.clearTimeout(timer);
      off();
      resolve(value);
    });
    timer = deps.setTimeout(() => {
      off();
      reject(new Error(`${what} not seen within ${timeoutMs / 1000}s`));
    }, timeoutMs);
  });
}

function waitUntil(
  deps: Pick<WorkspaceSmokeDeps, "setTimeout">,
  condition: () => boolean,
  timeoutMs: number,
  what: string,
  intervalMs = 250,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let waited = 0;
    const check = (): void => {
      if (condition()) {
        resolve();
        return;
      }
      if (waited >= timeoutMs) {
        reject(new Error(`${what} not reached within ${timeoutMs / 1000}s`));
        return;
      }
      waited += intervalMs;
      deps.setTimeout(check, intervalMs);
    };
    check();
  });
}

async function measureAppends(
  deps: WorkspaceSmokeDeps,
  options: WorkspaceSmokeOptions,
  sessionId: string,
  readyAt: number,
  paints: readonly ConsolePaint[],
): Promise<void> {
  const settled = (): boolean => {
    const last = deps.appends.entries(sessionId).at(-1);
    if (last === undefined || deps.wallNow() - last.atMs < APPEND_QUIET_MS) return false;
    return paints.some((paint) => paint.sessionId === sessionId && paint.throughSeq >= last.seq);
  };
  await waitUntil(deps, settled, APPEND_PHASE_TIMEOUT_MS, "the session's last row painted in the Console");
  const appends = deps.appends.entries(sessionId).filter((entry) => entry.atMs >= readyAt);
  const { latencies, unpainted } = appendLatencies(
    appends,
    paints.filter((paint) => paint.sessionId === sessionId),
  );
  if (unpainted.length > 0) throw new Error(`rows never painted: ${unpainted.slice(0, 10).join(", ")}`);
  if (latencies.length < options.minSamples) {
    throw new Error(`only ${latencies.length} append samples (need ${options.minSamples})`);
  }
  const p50 = percentile(latencies, 0.5);
  const p95 = percentile(latencies, 0.95);
  const max = Math.max(...latencies);
  deps.log(
    `SMOKE_CONSOLE appends=${latencies.length} p50_ms=${Math.round(p50)} p95_ms=${Math.round(p95)} max_ms=${Math.round(max)}`,
  );
  if (p95 > CONSOLE_APPEND_P95_BUDGET_MS) {
    throw new Error(`Console append p95 ${Math.round(p95)} ms is over the ${CONSOLE_APPEND_P95_BUDGET_MS} ms budget`);
  }
}

async function walkViews(deps: WorkspaceSmokeDeps): Promise<void> {
  const firstSelection = waitForLine(
    deps,
    (message) => {
      const location = parseWorkspaceLocation(message);
      return location !== null && location.selected !== null ? location : null;
    },
    VIEW_STEP_TIMEOUT_MS,
    "a selection after j",
  );
  firstSelection.catch(() => undefined);
  await deps.exec(pressKeyScript("KeyJ", "j"));
  const selected = (await firstSelection).selected;
  for (const step of VIEW_KEYS) {
    const seen = waitForLine(
      deps,
      (message) => {
        const location = parseWorkspaceLocation(message);
        return location !== null && location.view === step.view ? location : null;
      },
      VIEW_STEP_TIMEOUT_MS,
      `view ${step.view} after key ${step.key}`,
    );
    seen.catch(() => undefined);
    await deps.exec(pressKeyScript(step.code, step.key));
    const location = await seen;
    if (location.selected !== selected) {
      throw new Error(`selection changed on ${step.view}: ${selected} → ${location.selected}`);
    }
  }
  deps.log(`SMOKE_VIEWS selected=${selected} views=${VIEW_KEYS.map((step) => step.view).join(",")}`);
}

export async function captureShots(
  deps: Pick<WorkspaceSmokeDeps, "capture" | "writeFile" | "log">,
  shotsDir: string | null,
): Promise<void> {
  if (shotsDir === null) return;
  for (const width of SHOT_WIDTHS) {
    const png = await deps.capture(width, SHOT_HEIGHT);
    const file = path.join(shotsDir, `main-console-${width}.png`);
    deps.writeFile(file, png);
    deps.log(`SMOKE_SHOT ${file}`);
  }
}

export async function runWorkspaceSmoke(deps: WorkspaceSmokeDeps, options: WorkspaceSmokeOptions): Promise<void> {
  const paints: ConsolePaint[] = [];
  const offPaints = deps.onConsole((message) => {
    const paint = parseConsolePaint(message);
    if (paint !== null) paints.push(paint);
  });
  try {
    const ready = waitForLine(deps, parseWorkspaceReady, WORKSPACE_READY_TIMEOUT_MS, "WORKSPACE_READY");
    ready.catch(() => undefined);
    await deps.exec(openRepoScript(options.repoPath));
    await deps.exec(startSessionScript(SMOKE_PROMPT));
    const rows = await ready;
    const readyAt = deps.wallNow();
    const sessionId = await deps.exec(NEWEST_SESSION_SCRIPT);
    if (typeof sessionId !== "string") throw new Error("could not read the smoke session id");
    deps.log(`SMOKE_WORKSPACE session=${sessionId} ready_rows=${rows}`);
    await measureAppends(deps, options, sessionId, readyAt, paints);
    await walkViews(deps);
    await captureShots(deps, options.shotsDir);
  } finally {
    offPaints();
  }
}
```

In `apps/desktop/src/main/smoke.ts`, change `SMOKE_WORKSPACE_TIMEOUT_MS` to `240_000` and the call to:

```ts
    const minSamples = Number.parseInt(deps.env["JEVCODE_SMOKE_MIN_SAMPLES"] ?? "", 10);
    runWorkspaceSmoke(deps.workspace, {
      repoPath,
      shotsDir: shots.length > 0 ? shots : null,
      minSamples: Number.isInteger(minSamples) && minSamples > 0 ? minSamples : DEFAULT_MIN_SAMPLES,
    }).then(
```

importing `DEFAULT_MIN_SAMPLES` from `./smoke-workspace.js`.

In `apps/desktop/src/main/index.ts`:

1. Import `createAppendLog` from `./smoke-workspace.js` (next to the type import).
2. After `SMOKE_STEPS`, add `const smokeAppends = SMOKE_WORKSPACE ? createAppendLog(() => Date.now()) : null;`.
3. Change the D-1 observer line to `observeTraceAppends(db, (event) => { emitter.notify(event.sessionId, event.seq); smokeAppends?.record(event.sessionId, event.seq); });`.
4. In `workspaceSmokeDeps`, add `appends: smokeAppends ?? createAppendLog(() => Date.now()),` and `wallNow: () => Date.now(),`.
5. In `createWindow`, change the `loadFile` call to:

```ts
  void window.loadFile(
    path.join(dirname, "../renderer/src/renderer/index.html"),
    SMOKE_WORKSPACE ? { query: { smoke: "1" } } : undefined,
  );
```

In `apps/desktop/scripts/smoke-workspace.mjs`, add `JEVCODE_SMOKE_STEPS: process.env.JEVCODE_SMOKE_STEPS ?? "80",` to the child env.

- [ ] **Step 6: Run the tests to see them pass**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/renderer/workspace/paint-probe.test.ts src/main/smoke-workspace.test.ts src/renderer/workspace/main-host.test.ts src/main/smoke.test.ts`

Expected: PASS.

- [ ] **Step 7: Package checks**

Run: `perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop test`, `perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop typecheck`, `perl -e 'alarm 170; exec @ARGV' pnpm -r build`, `perl -e 'alarm 170; exec @ARGV' pnpm lint`.

Expected: all exit 0.

- [ ] **Step 8: Run the Electron smoke**

```bash
pnpm --filter jevcode-desktop run rebuild
(perl -e 'alarm 240; exec @ARGV' node apps/desktop/scripts/smoke-workspace.mjs .superpowers/shots/d6 > .superpowers/smoke-d6.log 2>&1; echo "EXIT=$?" >> .superpowers/smoke-d6.log) &
```

Poll every 15 s until `grep -E "^EXIT=" .superpowers/smoke-d6.log` prints a line (the run takes about a minute: 321 agent events 150 ms apart, plus boot and the view walk). Then run `grep -E "SMOKE_|WORKSPACE_SMOKE|EXIT=" .superpowers/smoke-d6.log`. If a stray Electron outlives the run, `pkill -f "jevcode-ws-smoke"` and `pkill -f "apps/desktop/node_modules/electron"` stop it.

Expected:

```
SMOKE_WORKSPACE session=<id> ready_rows=<n>
SMOKE_CONSOLE appends=<≥300> p50_ms=<…> p95_ms=<≤150> max_ms=<…>
SMOKE_VIEWS selected=step:<n> views=canvas,hybrid,map,surfaces,console
SMOKE_SHOT …/main-console-1440.png
SMOKE_SHOT …/main-console-1000.png
SMOKE_OK
WORKSPACE_SMOKE_PASS
EXIT=0
```

If p95 is over budget, do not raise the budget. Record the numbers and stop for the orchestrator (see "Commit cap vs. append budget"). If `SMOKE_VIEWS` fails on `map` because lane 06 has not merged, record which key and view `WORKSPACE_LOCATION` reported and escalate. V-2 owns the Map slot.

- [ ] **Step 9: Restore the Node ABI**

```bash
pnpm --filter jevcode-desktop run rebuild:node
NP=$(ls -d node_modules/.pnpm/node-pty@*/node_modules/node-pty | head -1)
PB="$NP/prebuilds/$(node -p 'process.platform + "-" + process.arch')"
mkdir -p "$NP/build/Release"
[ -f "$NP/build/Release/pty.node" ] || cp "$PB/pty.node" "$NP/build/Release/"
[ -f "$NP/build/Release/spawn-helper" ] || cp "$PB/spawn-helper" "$NP/build/Release/"
chmod +x "$NP/build/Release/spawn-helper"
perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/main/rows-available.test.ts
```

Expected: `native modules restored to node ABI`, and the test passes (better-sqlite3 loads under Node).

- [ ] **Step 10: Compare the screenshots with the mockups**

Open `.superpowers/shots/d6/main-console-1440.png`, `main-console-1000.png` and the two mockup PNGs. Confirm these points:

- the window opens on Console
- the Console shows the mock session's steps as terminal-style lines on the light panel
- the switcher bar shows the five views
- the Brief is on the right with Now and Changes
- the dock is at the bottom
- nothing overflows at 1000 px

Fix differences in `styles.css` through tokens. Rerun Step 8 (and Step 9) if anything changed.

- [ ] **Step 11: Record the budget**

Add one row to the table in `docs/perf.md` under "## Trace viewer (spec §10, R26), recorded at the M5 exit", after the "Soak open in the Electron trace window, full load" row. Use the numbers from Step 8:

```markdown
| Console append latency in the main window (row stored → line painted, push hint) | p95 ≤ 150 ms | Phase A | p95 <p95> ms, p50 <p50> ms, max <max> ms over <n> rows; mock session, 150 ms between agent events (2026-10-0X, load <uptime load>) | <PASS or MISS> | `node apps/desktop/scripts/smoke-workspace.mjs` (`SMOKE_CONSOLE`) |
```

Fill in `<…>` from the log and `uptime`.

- [ ] **Step 12: Commit**

```bash
git add apps/desktop/src/renderer/workspace/paint-probe.ts apps/desktop/src/renderer/workspace/paint-probe.test.ts apps/desktop/src/renderer/workspace/EmbeddedWorkspace.tsx apps/desktop/src/renderer/workspace/main-host.ts apps/desktop/src/renderer/workspace/main-host.test.ts apps/desktop/src/renderer/main.tsx apps/desktop/src/main/smoke-workspace.ts apps/desktop/src/main/smoke-workspace.test.ts apps/desktop/src/main/smoke.ts apps/desktop/src/main/index.ts apps/desktop/scripts/smoke-workspace.mjs docs/perf.md
git -c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com commit -m "test(desktop): smoke the Console-first main window with append latency and view walk"
```

---

## Lane completion

1. **Whole-lane check** on `ce/03-desktop` after D-6: `/Users/jwpark/Projects/jevcode/.superpowers/orchestration/root-checks.sh /Users/jwpark/Projects/jevcode-ce-03` prints `ROOT_CHECKS_DONE fail=0`. The worktree is on the Node ABI (D-6 Step 9).
2. **Index "Done" for lane 03** holds:
   - the main window opens on the Console (D-6 screenshots)
   - all views are reachable with the selection preserved (`SMOKE_VIEWS`)
   - the prompt dock keeps the composer rules (D-2 and D-3 tests)
   - the user shell carries no agent lines (D-5 test)
   - the smoke prints `SMOKE_OK` with `SMOKE_CONSOLE … p95_ms ≤ 150`
3. **Hand-off notes** for the merge (index §7) and for H4:
   - Lane 04 (M-6): pass `rowsAvailable.notify` from `main/index.ts` as `ExplainerStageDeps.emitRowsAvailable`. The call is optional, because `observeTraceAppends` already reports every committed `overview_snapshot` and `explainer` row. M-6's `overview:rescan` handler must reject a `repoRoot` that is not the open repo. The renderer calls it through `bridge.overview.rescan` (deviation 3).
   - Lane 02a owner: the 250 ms commit gap and the 150 ms append budget (spec alignment note). The measured p95 is in `docs/perf.md`.
   - Lane 06: the Surfaces host view is key 4, and the smoke expects key 3 to report `view: "map"`.
   - The spec owner: §3.1's "last view remembered per window" was not built (spec alignment note).
   - The interface deviations above, for the interfaces file's next revision.
