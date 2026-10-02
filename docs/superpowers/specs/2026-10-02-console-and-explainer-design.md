# Console-first workspace, Brief, and codebase explainer — design

Status: approved for planning by the person on 2026-10-02 (sections 1–2 approved in chat; sections 3–6 delegated with "continue with best reasoning").
Builds on: `docs/superpowers/specs/2026-09-28-trace-viewer-design.md` (the trace viewer, "the viewer spec") and `docs/SPEC.md`.

## 1. Summary

When a person types a prompt into jevcode, the main window shows the agent's work as a **Console** by default: a terminal-style, keyboard-first stream of prompts, agent messages, commands with their output, edits, and test results, with the prompt line at the bottom. This is the familiar experience of running an agent in a terminal (cmux, Superset, a plain shell). From the Console the person can switch to the richer views jevcode already has (**Hybrid** and **Canvas**) and to a new **Map** view, which is a technical overview of the whole codebase showing its components and how they work together. A **Brief** panel is available in every view. It shows what is happening now, what changed so far, and where the changes sit in the architecture.

The graphics and the plain-language text come from an **explainer stage** in the desktop pipeline. Rule-based builders turn what jevcode actually observed into graphics: a repo scan, the import graph, change units, decisions and tests. A small model, Jev's narrator, writes short captions, a codebase overview, a session story, and the "why" of each decision. Every sentence cites evidence that exists, and nothing the model writes can add a component or trigger an action. Results are stored as trace rows. Every view therefore updates live, replays from the stored session, and exports in `trace.json`.

Three phases ship independently:

- **A. Console-first workspace.** The Console view, the main window embedding the viewer with a view switcher and a docked prompt line, push-triggered live updates, the light visual system in the main window, and a rule-based Brief.
- **B. Codebase overview.** The repo scan, the component model, `overview_snapshot` rows, narrator text for components and the overview, the Map view, and the Brief's architecture card.
- **C. Session explainer.** `explainer` rows holding the story, decision notes and component highlights, change highlights on the Map, decision cards, and summary blocks in the Console.

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| E1 | The main window's default view is a terminal-style **Console** rendered from structured events as DOM, not a raw PTY. | Codex runs as `exec --json`, so no agent TUI exists to mirror. A structured stream can still look and feel like a CLI (monospace, prompt line, scrolling log, keyboard-first) while staying safe (`displayUntrusted`), linkable (selection, Inspector, diffs) and replayable. |
| E2 | Console, Hybrid, Canvas and Map are all views of the existing `@jevcode/trace-viewer` package. The main window **embeds** `<TraceViewer>` for the active session. The trace window keeps working as a second, read-only window. | One data path, store, selection model and visual system. Selection, playhead and brush survive view switches (viewer spec §7.8). The trace window remains for side-by-side review. |
| E3 | The existing generative surfaces (Overview, Conversation and Decisions tabs) become one host-registered view, **Surfaces**, inside the embedded viewer. | They stay reachable without a second navigation system. Jev's decision cards keep working. |
| E4 | A **Brief** replaces the Inspector's empty state and is reachable from every view (Shift+B toggles it, Esc returns from a selection to the Brief). | One right-hand panel across views. When nothing is selected, the panel's best use is the summary. |
| E5 | Live updates are **push-triggered pulls**. Main sends a one-way `trace:rowsAvailable {sessionId, lastSeq}` to windows showing that session, and the data controller fetches at once. The 1 s poll stays as a fallback. | Keeps the viewer IPC-free and the read path single (`trace:rows`). Brings Console latency from up to 1 s down to tens of milliseconds. |
| E6 | The main window adopts the viewer's light token system (`--tv-*`). Light is the only theme in this spec. Tokens are named so a dark theme can be added later without renames. | The person's stated taste is light first, restrained color and few borders. It removes the dark/light clash created by embedding. |
| E7 | The person's interactive shell (`TerminalPanel`, `sh -i`) stays a separate pane. The pipeline stops writing agent one-liners into that PTY stream. | The Console is now the agent log. Mixing agent lines into the user's shell was confusing. |
| E8 | Components come from the repo's structure: workspace packages and `apps/*` first, otherwise top-level source directories; a component over 150 files is split one level deeper. Edges are imports collapsed to component pairs. Roles come from a closed list. | Approved in chat (section 1). The result is deterministic, explainable and stable across sessions. |
| E9 | The explainer stage runs in the desktop main process and stores `overview_snapshot` and `explainer` rows. The viewer never calls a model. | Approved (approach A). The viewer spec forbids network or model calls from the viewer (§1). |
| E10 | The narrator uses Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) through a narrator client in `jev-router` that calls the Anthropic SDK directly (Jev's TypeSafe transport cannot return free text), with a fixed output schema, required citations, length caps, plain text only, and a rule-based fallback. Its inputs are names, paths, exported symbols, component edges, manifest descriptions and redacted first README paragraphs, never whole files. | Approved (section 2). Cheap and fast. Grounded output limits the impact of prompt injection. |
| E11 | Narrator text is cached per repo by (component id, content hash), so unchanged components are never re-described. | Approved (section 2). Reopening a repo costs no model calls. |
| E12 | The Map is laid out by a pure, sticky layered layout. Roles become bands: UI, API/IPC, agent/integration, domain, storage. Tests, tooling and config sit at the side. Order within a band minimizes edge crossings and stays sticky across updates. | Readable as an architecture diagram, and stable while live (no jumping). It follows the Canvas layout's purity and stickiness rules (viewer spec §7.5). |
| E13 | The Map is rendered with the viewer's own camera controller, DOM cards and SVG edges, not React Flow. | The trace window bars `@xyflow` (R17), and the viewer has one rendering approach. |
| E14 | Import edges cover TypeScript, JavaScript and JSON in v1, the languages the parser supports. For other languages, the Map shows components and structure without edges and labels the gap. | Honest within the current parser. Adding languages later only adds grammars. |
| E15 | The narrator setting **Explain with a model** is on by default and can be turned off in Agent Settings. With it off, every surface still works from rule-based data. | The person controls what metadata leaves the machine. |
| E16 | Each UI phase starts with HTML mockups of its new screens. The person approves them before implementation. | Matches how the Hybrid and Canvas mockups were approved. Visual quality is a stated priority. |

## 3. Experience

### 3.1 The main window

The header, left sidebar (recent repos, sessions, agent settings) and status bar stay as they are, restyled to the light tokens. The center column becomes the **workspace**:

```
┌ view switcher: Console · Hybrid · Canvas · Map · Surfaces   [Brief ▸] ┐
│                                                                       │
│  active view (default Console)                     │ Brief / Inspector│
│                                                    │                  │
├───────────────────────────────────────────────────────────────────────┤
│ › prompt line (multi-line)            Steer ▾ · ⌘↵ send · status chip │
└───────────────────────────────────────────────────────────────────────┘
```

- **View switcher.** A segmented control with five views; number keys switch views when focus is not in a text field (§3.7; existing viewer keys `1` Canvas and `2` Hybrid keep their meaning). Every view keeps the same selection, playhead and brush (viewer spec §7.8). A window opens on the Console, and so does every session switch; the view is not remembered per window. (Ruled during planning: switching sessions is a fresh start on the live log.)
- **Prompt line.** The existing composer, docked under every view in a CLI style: a `›` prompt glyph, monospace input, Enter for a new line, Cmd+Enter to send. Steer and Queue modes, Continue on a finished session, and trace-note prefill keep their current behavior (`WorkspaceHost` reducer, D-5).
- **Before the first prompt.** The onboarding prompt (`TaskPrompt`) stays as the empty state of the Console.

### 3.2 Console view

A terminal-style log of the session, oldest at the top and newest at the bottom, auto-following the tail while the reader is at the bottom (viewer spec §7.10 Live rules, "N new" pill). Each step from the trace model renders as one block of lines:

| Step kind | Console rendering |
|---|---|
| instruction (user prompt or steer) | `›` plus the prompt text in ink-1, with a steer or queue tag. |
| agent message | Plain paragraph in ink-2, wrapped, through `displayUntrusted` (no Markdown). |
| reasoning | One dim line, "thinking · 2.3 s", expandable to the text. |
| tool call | `●` tool name and arguments, then a check or cross and a duration when done. |
| command | `$ command` in mono, the last 8 output lines (expandable to the full output via payloads), an exit chip, a duration bar while running. |
| file reads | Grouped: "read 3 files" with paths on expand. |
| edit | `✎ path` with a DiffBar and `+n −m`; click opens the diff in the Inspector. |
| test run | TestDots with `14/15` and the failing test names. Red only for failures. |
| approval / decision needed | A highlighted block with the question and option buttons. It uses the existing action dispatch (Decision surface actions) and is keyboard-reachable. |
| lifecycle (waiting, completed, failed, interrupted) | A one-line status rule. |
| finding (claim contradicted, failing tests, …) | An inline flag line under the step it is anchored to, using the anchor rule. |
| summary (phase C) | A `◆ Summary` block with the latest story sentences and a link to the Brief. At most one per story refresh, not repeated if unchanged. |

**Behavior:**

- **Virtualized:** the Console uses the viewer's virtualizer and stays smooth at 10,000 or more steps.
- **Keyboard:** `j`/`k` move the selected step, Enter expands it, `G` jumps to live, `/` searches.
- **Selection:** selecting a step opens it in the Inspector, as in Hybrid.
- **Untrusted text:** every agent string goes through `displayUntrusted`.

The visual style is a light terminal: `--tv-ink-*` on the panel color, mono type for commands, paths and output, sans type for prose, no boxes around steps (spacing and a thin gutter rule only), and color for state only.

### 3.3 Brief

The Brief is the right-hand panel whenever nothing is selected, in every view. Shift+B toggles it, and Esc from a selection returns to it. It has three stacked parts, each icon-led with mini graphics:

1. **Now.** What the agent is doing. In phases A and B this is rule-based: the current running step, the latest change unit and any pending decision. In phase C it becomes the narrator's story (3 to 6 sentences with citation chips).
2. **Changes so far.** Change units of this session, newest first: icon, short title, DiffBar, test state, and a "needs attention" flag by the anchor rule. Each opens in the active view.
3. **Architecture** (phase B and later). A thumbnail of the Map with this session's touched components highlighted, plus the one-paragraph codebase overview. Click opens the Map.

In the trace window the Brief is the same component, read-only, with no prompt line.

### 3.4 Map view (codebase overview)

- **Top.** A header with the rule-based headline ("12 components", languages beside it in muted ink; the narrator being off changes nothing here) and a row of quiet notes (partial map, imports not analyzed, scan progress, narrator state). Below it sits the short overview narrative (4 to 8 sentences: what the system is, its main flows, its tech stack) as plain sentences. Component names in a sentence are quiet links (ink with a faint underline); hovering a link behaves like hovering its card, and the selected component's link turns accent. The first two sentences show, followed by a quiet "More". An Overview toggle collapses all of it. There are no citation chips in this header.
- **Body.** Component cards placed in role bands, left to right. Each band is a full-height light lane with a header (role icon, label, muted count):
  - The main bands are UI → API/IPC → agent/integration → domain → storage.
  - Tests, tooling and config sit in a narrower side band labelled "Support".
  - External packages do not appear on the canvas as chips. The detail-level card shows its top two packages inside itself, and the Inspector lists all of them.
- **Card contents:** every card is the same size at every zoom level; only its content changes with the level.
  - the full name (two lines at most) and a footer with the role icon and a file-count bar (length is √(files ÷ the largest component's files))
  - at the card level the count joins the footer; at the detail level the footer reads "n files" and the card adds its one-line purpose (or root path), the top two packages, and, for a hub, a fan-in glyph with its importer count
  - the main language is in the Inspector, not on the card. Import weight is shown by edge width and by bars in the Inspector's lists
  - session state (phase C): new, changed, touched by a decision or failing test, as a mark in the footer in place of the count, using `--tv-accent` for selection and red only for failures
- **Edges.**
  - Smooth curves in the gutters and the gap rows between cards. Width follows the import count (1, 1.6 or 2.4 px buckets) in a light neutral ink.
  - At rest only band-to-band edges are drawn, and edges into a hub (a component imported by at least `max(6, ceil(n / 4))` others) are left out; a short three-line stub marks the hub's port. Same-band edges and a hub's edges appear when their card is selected or hovered.
  - Selecting or hovering a card draws all of its edges in accent on top and dims every other edge to 22% (as on the Canvas).
  - With the session overlay on (phase C), edges whose two ends the session touched are emphasized and always drawn.
- **Inspector for a component:**
  - purpose and role (with "rule-based" or "described by model" provenance)
  - files (middle-truncated, top 20, then "n more")
  - imports in and out, with counts and example imports
  - external dependencies
  - this session's changes and decisions touching it
  - citations
- **Zoom and pan.** Same controller and keys as the Canvas. Fit shows the whole map, centered on both axes and filling the stage (20 px at the sides and top, 68 px at the bottom for the zoom bar), at no more than 100%; it refits on a viewport resize while the camera is still where Fit left it. On the 1440 px layout Fit lands at the card level (about 77%); on the 1000 px layout at the chip level (about 52%) with every name still shown. Zoom bands: chip below 70%, card below 140%, detail from 140%; below 48% names hide and the tooltip carries them.
- **Without import edges.** For repos whose languages have no edges, the cards show structure only, with a quiet "imports not analyzed for Python" note.

### 3.5 Decisions (phase C)

Each decision (from `decision` rows) becomes a card in the Brief's "Now" while it is pending, and appears in the Inspector when selected from any view. A card shows:

- the question
- the options with their tradeoffs, as a fork glyph
- the choice and who chose it
- the narrator's one-sentence "why", citing the agent message or plan step it came from
- the components it affected, with links to the Map

### 3.6 Visual system

The viewer's tokens and rules apply (viewer spec §7.12): light only, color for state only, no decorative borders, icons and mini graphics over text, and a Figma-like finish. The main window's `styles.css` moves onto `--tv-*` tokens. New glyphs:

- a role icon set: UI, API, agent, domain, storage, tests, tooling, config, external
- a session-state dot for cards
- the `◆` summary marker
- the terminal prompt glyph `›`

Phase A, B and C UI tasks begin with HTML mockups (E16).

### 3.7 Keyboard

| Key | Action |
|---|---|
| `0` | Console |
| `1` | Canvas |
| `2` | Hybrid |
| `3` | Map |
| `4` | Surfaces |
| Shift+B | Toggle the Brief (lowercase `b` is the viewer's brush-chapter key in Hybrid, so the Brief takes Shift+B) |
| Esc | Go back from a selection to the Brief |
| Cmd+Enter | Send the prompt |
| Cmd+L | Focus the prompt line |

Existing viewer keys keep their meaning, except the viewer's old `0` (zoom to preset), which moves to Shift+0. Lowercase `b` keeps brushing the chapter in Hybrid. Keys never fire while typing in an input, textarea or contenteditable element (viewer spec §7.9).

## 4. Architecture

### 4.1 Data flow

```
agent adapter → pipeline (evidence, semantic-core, Jev) → events store (SQLite)
                         │
                         └→ explainer stage ─┬→ overview builder (rule-based, worker) ─┐
                                             └→ narrator (Jev client, debounced, cached) ┤
                                                                                         ↓
                                      overview_snapshot / explainer rows → events store
events store → TraceReader → trace:rows (pull) ──→ data controller (viewer) → model fold → views
            └→ trace:rowsAvailable (push hint) ──↗
```

### 4.2 Packages and ownership

| Package | Changes |
|---|---|
| `packages/contracts` | New event types `overview_snapshot` and `explainer`, added to `EVENT_TYPES` and `TRACE_ROW_TYPES`. Zod schemas `OverviewSnapshotSchema` and `ExplainerRecordSchema`. Bundle version 2, with the parser accepting 1 and 2. IPC push channel `trace:rowsAvailable`. |
| `packages/codebase-map` (new, pure TypeScript, no Node built-ins in its core) | `componentize(files, manifests)`, `aggregateEdges(importEdges, componentOf)`, `guessRole(component)`, `contentHash`, and snapshot assembly with caps. Unit and property tests. |
| `packages/evidence-engine` | A repo-scan entry point that reuses the parse worker to extract import specifiers per file and resolve them to repo paths (tsconfig paths and workspace package names). |
| `packages/jev-router` | A narrator question set: `describeComponents` (batch of 20) → `{id, purpose ≤ 140 chars, role ∈ Role, citations}`; `overviewNarrative` → `{sentences: {text ≤ 220, citations}[] ≤ 8}`; and in phase C `sessionStory` and `decisionWhy`. Guardrails validate citations, caps and roles. |
| `packages/storage` | Migration: `component_text_cache(repo_root, component_id, content_hash, purpose, role, model, created_at)` and `overview_state(repo_root, snapshot_json, updated_at)`. |
| `apps/desktop` main | The explainer stage (scan scheduling, rule-based builder, narrator calls, row writes, push hints), the setting, and the separation of the user shell from the agent log. |
| `packages/trace-viewer` | Model fold of the new rows, the Console view, the Map view and its pure layout, the Brief, a host-registered view API for Surfaces, an embedded-chrome mode, and the push-hint hook in the data controller. |
| `apps/desktop` renderer | Embedding `<TraceViewer>` with an IPC `TraceSource` and host, the view switcher and prompt dock, the Surfaces view wrapper, and the light restyle. |

### 4.3 Trust boundaries

- **Viewer stays model-free and IPC-free.** The embedded viewer still never imports Electron, `window.jevcode` or networking; the host injects the source and actions, and the existing lint boundaries hold.
- **Main-window privileges.** In the main window the host may offer actions the trace window cannot: send an instruction, answer a decision, and the existing Surfaces actions, through the existing allowlisted dispatch. The trace window's allowlist is unchanged. `trace:rowsAvailable` is a main → renderer send, so it adds no invoke channel.
- **Narrator text is untrusted.** It is rendered like agent text and can never trigger an action.

## 5. Component model (phase B)

### 5.1 Scan

- **Triggers:** a repo open, or the first session start in a repo without fresh overview state.
- **Input files:** files git tracks plus untracked files that are not ignored (`git ls-files --cached --others --exclude-standard`), so `.gitignore` is respected and new files the agent just wrote appear. Skipped: `node_modules`, `dist`, `build`, `out`, `.next`, `coverage`, `vendor`, binary and LFS files, and files over 1 MiB. Hard cap 20,000 files; past the cap, the map is flagged partial with the counts.
- **Imports:** extracted in the evidence-engine parse worker. Import specifiers are resolved to repo files using relative paths, `tsconfig` `paths`/`baseUrl` and workspace package names. Unresolved bare specifiers become external dependencies under their package name, with deep imports collapsed.
- **Incremental updates:** after the first scan, the file watcher's changes re-parse only the changed files. A component's content hash changes only when its member files change.

### 5.2 Components

Cut rules (E8):

1. Workspace packages from `pnpm-workspace.yaml`, `package.json` `workspaces` or yarn workspaces, plus `apps/*`.
2. Otherwise, top-level directories under `src/`, `lib/` or `packages/`. A flat `src/` is one component.
3. A component with more than 150 files splits by its next directory level, and the split repeats in any part still over 150 files. Files directly in a split directory stay in a `<name>/root` part.
4. Test files (`*.test.*`, `*.spec.*`, `__tests__/`, `test/`) join the component they test (the nearest component by path). Repo-root config and tooling files (`*.config.*`, `scripts/`, `.github/`) form `config` and `tooling` components.

**Ids.**

- `id = "cmp_" + sha1(rootPath).slice(0, 12)`, stable while the root path is unchanged.
- `contentHash = sha1(sorted(member path + ":" + file content hash))`.

**Fields:**

- id, rootPath, name (the package name or directory name), files[], fileCount and main language
- `roleGuess`: the rule-based role
- `role`: the confirmed role (equal to the guess until the narrator confirms it)
- `purpose`: the one-line purpose, or null
- `provenance`: "rule" or "model"
- `externalDeps` (the top 8 by import count) and `entryPoints` (package `main`/`exports`/`bin`, `apps/*` entry files)

### 5.3 Edges

`aggregateEdges` collapses file-level imports into component pairs `{from, to, count, examples: up to 3 "a.ts → b.ts"}`. Self-edges are dropped, edges are capped at 1,000 by count, and component-to-external edges are kept separately.

### 5.4 Roles

`Role = "ui" | "api" | "agent" | "domain" | "storage" | "tests" | "tooling" | "config"`, plus `external` for external packages. Rule-based guess, first match wins:

1. Path or name contains `renderer`, `ui`, `web`, `components` or `views`, or the component imports react, vue or svelte: **ui**.
2. Path or name contains `ipc`, `api`, `routes`, `server` or `handlers`, or the component imports express, fastify, hono or electron's ipcMain: **api**.
3. Name contains `agent`, `adapter`, `router` or `llm`, or the component imports an LLM SDK or node-pty: **agent**.
4. Name contains `storage`, `db` or `store`, or the component imports better-sqlite3, prisma, drizzle, pg or mongodb: **storage**.
5. Only test files: **tests**. Under `scripts/` or `tools/`: **tooling**. Config files: **config**.
6. Otherwise **domain**.

### 5.5 Snapshot

`OverviewSnapshot`:

```
{
  repoRoot, scanId, partial, counts: {files, totalFiles?, components, edges, languages},
  components[], edges[], externals[],
  narrative: {sentences[], provenance} | null,
  status?: {
    scan: {state: "running" | "done" | "failed", scanned, total, error?},
    narrator: "off" | "unavailable" | "pending" | "ready"
  },
  generatedAt
}
```

`totalFiles` is the repo's file count before the 20,000 cap, so a partial map can say "20,000 of 25,200 files". `status` carries what the Brief and Map show while work is in flight: scan progress ("Mapping codebase · 3,200 / 9,800 files"), a failed scan (with Retry), and the narrator state. Narrator `off` means the setting is off; `unavailable` means no API key or a failure backoff; `pending` means descriptions are being written; `ready` means narration for this snapshot finished. A scan longer than 2 s writes progress snapshots at most once per 2 s, carrying the previous components. A snapshot without `status` reads as scan done, narrator `pending` if any purpose is null, else `ready`.

Caps: 200 components (beyond that the smallest are grouped into "other"), 1,000 edges, 120 externals, and 512 KB serialized. One snapshot row is written per session at session start and again whenever the snapshot changes, debounced to at most one per 2 s. The viewer keeps only the latest snapshot.

## 6. Explainer stage

### 6.1 Placement and schedule

The stage runs in `apps/desktop/src/main/pipeline`, beside the UI stage. Its work runs in a worker or off the hot path, and it never blocks agent event ingestion.

| Work | When | Bound |
|---|---|---|
| Repo scan | Repo open, or first session start | Background worker. Progress is visible in the Brief ("Mapping codebase · 3,200 / 9,800 files"). |
| Snapshot rebuild | After watcher changes settle (500 ms) | Only dirty components are recomputed. |
| `describeComponents` | After a snapshot with uncached components | Batches of 20, at most 2 in flight. |
| `overviewNarrative` | After the first full description pass; then when the component set or role bands change, or more than 10% of components changed | One in flight. |
| `sessionStory` (phase C) | Meaningful events (change unit closed, decision answered, test result, agent completed), debounced to at least 20 s apart | One in flight. Skipped if nothing changed. |
| `decisionWhy` (phase C) | A decision is answered | One per decision. |

### 6.2 Narrator inputs

| Call | Inputs |
|---|---|
| `describeComponents` | Per component: name, rootPath, role guess, top 20 file paths, top 15 exported symbol names, external deps, in and out edges (names and counts), and the package.json `description` or the first README paragraph. The README paragraph is redacted with the A1 redaction rules and clipped to 600 characters. |
| `overviewNarrative` | The component list (name, role, purpose) and the top 40 edges. |
| `sessionStory` | The session prompt, the last 12 steps' headlines, open and answered decisions, test state, and the touched components. |
| `decisionWhy` | The decision, its options, the answer, and the 3 agent messages or plan steps nearest the answer. |

Whole files are never sent.

### 6.3 Guardrails (rule-based, after every call)

- **Schema:** the output must parse against the zod schema; otherwise it is dropped and the rule-based value is kept.
- **Citations:** every sentence must cite something that resolves: a component id, file path, decision id, fact id or step id. A sentence with no citation, or with a citation that doesn't resolve, is dropped. If more than half of a batch's sentences are dropped, the whole batch is discarded.
- **Roles and names:** `role` must be in `Role`. A purpose must not name a component other than the one it describes, checked by matching it against the component name set.
- **Plain text:** no URLs, Markdown, HTML or code fences (rejected). Purpose text is capped at 140 characters and sentences at 220.
- **Logging:** each narrator call is recorded with question, latency, model, accepted or dropped counts, and cost, in an in-memory log that Inspect shows in a Narrator tab (`debug:listNarratorCalls`). Calls are not written as `jev_decision` rows, which would appear as steps in the trace.

### 6.4 Cache

`component_text_cache` is keyed by `(repo_root, component_id, content_hash)`. On a hit, the cached purpose and role are used with no call. The overview narrative is stored in `overview_state` and reused while its inputs hash is unchanged.

### 6.5 Rows

- `overview_snapshot` rows carry `OverviewSnapshot` (§5.5).
- `explainer` rows (phase C) carry one of:
  - `{kind: "story", sentences[], basisSeq}`
  - `{kind: "decision_why", decisionId, sentence}`
  - `{kind: "highlights", components: {id, state: "new"|"changed"|"decision"|"failing", unitIds[]}[] }`

Rows are appended through the existing event store with a gapless seq, carry `ts`, and are redacted on export like other rows.

### 6.6 Failure

- **Model problems:** if the model is unavailable, rate-limited or slow (10 s timeout), the call is skipped and retried on the next trigger with backoff (30 s, 2 min, 10 min). The Brief shows "descriptions pending" in quiet ink, never an error banner.
- **Scan problems:** a scan failure is logged and surfaced as "Codebase map unavailable" with Retry. Agent work is never affected.

## 7. Contracts, storage and IPC

- **Contracts:**
  - `EVENT_TYPES` and `TRACE_ROW_TYPES` gain `overview_snapshot` and `explainer`.
  - New schemas: `OverviewSnapshotSchema`, `ComponentSchema`, `ComponentEdgeSchema`, `ExternalDepSchema`, `ExplainerRecordSchema`, `NarrativeSentenceSchema` (`{text, citations: Citation[]}`).
  - `Citation = {kind: "component"|"file"|"decision"|"fact"|"step", id}`.
  - `TRACE_BUNDLE_VERSION` becomes 2. The bundle parser accepts versions 1 and 2, and a v1 bundle simply has no new rows.
- **IPC:** `trace:rowsAvailable` (main → renderer) carries `{sessionId, lastSeq}`. It is sent at most every 50 ms per session, coalesced, to every window whose viewer shows that session (main window and trace windows). The renderer IPC source exposes it as `source.onRowsAvailable(listener)`.
- **Storage:**
  - The migration adds `component_text_cache` and `overview_state`.
  - The TraceReader includes the new row types in `trace:rows`.
  - The read-ahead (D-8 fix) and the payload rules apply unchanged.

## 8. Viewer additions

### 8.1 Model

- **Fold:** the fold keeps the latest `OverviewSnapshot` (replace semantics) and the explainer state:
  - the latest story
  - `decisionWhy` by decision id
  - the latest highlights
- **New types:** `TraceSession` gains `overview: OverviewModel | null` and `explainer: ExplainerModel`.
- **Incremental:** incremental finalize (viewer spec §6.4) treats these as append-local. A new snapshot row replaces the overview object, and unchanged components keep their identity through id plus content hash.
- **Equivalence:** the property tests' "incremental equals fresh" check extends to the new rows.

### 8.2 Console

- **Source:** rendered from `TraceSession.steps`. Step headlines, command output payloads, test details and finding anchors are reused.
- **Row builder:** `buildConsoleRows(session, index, opts)` is pure, lives in `src/layout`, and is incremental by step identity. It maps each step to a row group with expand state kept in the store.
- **Rendering:** virtualized with the spine's rules: the focused and selected rows stay mounted, there is no focus move on data rebuilds, and reveals are snapped.

### 8.3 Map layout

`layoutMap(overview, opts, prev?)` is pure and lives in `src/layout`:

- **Bands.** One band per role, in a fixed order.
- **Order within a band.** A barycenter heuristic over import edges, 4 sweeps, deterministic tie-break by name.
- **Card sizes.** One fixed geometry for every zoom level (140 × 76 world units; the side band is 104 wide; rows 16 apart; gutters 22; margin 16; band label 44), so a level change never moves a card. The level (`chip` < 0.7 ≤ `card` < 1.4 ≤ `detail`) only changes what a card shows.
- **Stickiness.** With `prev` for the same repo, existing components keep their order and only new ones are inserted at their barycenter position. Like Canvas P6, a live update never reorders placed cards.
- **Edges.** Smooth curves with constant screen width. A card has one port per side, at its vertical center. Edges between adjacent bands are one S-curve in the gutter. Edges between bands two or more apart leave through the gutter, run along the gap row between cards (every band shares one row pitch, so the gap row is free in every column) and return through the gutter before the target; edges leaving one card toward one side share that channel and read as one line. Same-band edges are a shallow bulge on the less loaded side. Each edge carries `kind` (`adjacent`, `long` or `same`), and `mapHubIds` names the hubs the view hides at rest.
- **Properties:**
  - no card overlap
  - edges never pass under a card other than their endpoints (curves included)
  - every edge starts and ends on side centers of its two cards
  - sticky under append, and an adjacent or long edge between two cards that keep their positions keeps its path
  - deterministic for equal input
  - Fit centers and fills (checked with the camera, lane 06 P-3)

### 8.4 Brief

`buildBrief(session, index, overview, explainer)` is pure. It returns the Now, Changes and Architecture parts with the rule-based fallbacks of §3.3. The Brief component renders in the Inspector region when there is no selection.

### 8.5 Host-registered views and embedded chrome

- **Host views:** `TraceViewer` gains `hostViews?: ViewDefinition[]`. These use the same registry as built-in views and render inside the shell with access to the store.
- **Embedded mode:** `TraceViewer` gains `chrome?: "full" | "embedded"`. Embedded mode hides the viewer's own title bar (the main window header shows repo, prompt and state) and exposes the view switcher for the host to place.
- **Lint boundary:** the existing boundaries still hold. The Surfaces view's code lives in `apps/desktop`, not in the viewer.

### 8.6 View keys

The embedded viewer maps Console to `0`, Canvas to `1`, Hybrid to `2`, Map to `3` and Surfaces to `4`. The trace window uses the same numbers, without Surfaces.

### 8.7 Data controller

The controller subscribes to `source.onRowsAvailable` when available. A hint for the controller's session with `lastSeq > cursor` triggers an immediate poll and resets the 1 s timer. Generation and stale guards are unchanged.

## 9. Main window changes

- **Center column:**
  - `WorkspaceHost`'s session view is replaced by the embedded viewer: `<TraceViewer source={ipcSource(activeSession)} host={mainHost} chrome="embedded" hostViews={[surfacesView]} initialView="console">`.
  - It is keyed by session id, with a stable host.
  - The prompt dock sits below it.
  - The pre-prompt state stays `TaskPrompt`.
- **`mainHost`** provides:
  - `requestChanges`: prefills the local composer and focuses it.
  - `answerDecision` and `invokeAction`: the existing action dispatch.
  - `openExternal`: none.
  - `openTraceWindow`: the Trace button.
- **Surfaces view:** wraps today's Overview, Conversation and Decisions content (SurfaceManager, json-render) as one view with its tab strip. The context rail's content moves into the Brief (Now and Changes) and the Instruction queue moves into the prompt dock (queued items listed above the prompt line, each cancellable).
- **Terminal pane:** `TerminalPanel` stays toggleable below the workspace as the person's own shell. `formatAgentEventForTerminal` writes are removed (E7).
- **Restyle:** `styles.css` moves to `--tv-*` tokens. The main window loads the viewer's token styles once at the root.

## 10. Security and privacy

- **Data sent to the model provider:** with the narrator on, Anthropic (Claude Haiku 4.5 through `@anthropic-ai/sdk`, keyed by `ANTHROPIC_API_KEY`) receives repo metadata (paths, symbol names, dependency names, redacted README first paragraphs, component edges) and session summaries (headlines, decisions). File contents and diffs are never sent. Turning the setting off, or having no `ANTHROPIC_API_KEY`, stops every narrator call; rule-based data still works. Jev's TypeSafe provider is not used for narration, because it only answers scoring, choice and yes/no questions.
- **Prompt injection:** repo text can try to steer the narrator. The fixed output schema, citation checks, caps, plain-text rendering and the absence of any action path bound the impact to wrong or missing captions. A dropped batch falls back to rule-based labels.
- **Untrusted text:** narrator text, component names (from paths) and README text render through `displayUntrusted` in every slot, with the full text in tooltips and accessible names, exactly as agent text is handled.
- **Allowlist and export:** the trace window allowlist is unchanged. `trace:rowsAvailable` carries no content. Export redaction covers the new rows, and bundles carry the snapshot (paths and names) the way they already carry paths.

## 11. Performance budgets

Measured on the reference machine (Apple M3 Max), as in the viewer spec §10.

| Measure | Budget |
|---|---|
| Console append latency (row stored → line painted, push hint) | p95 ≤ 150 ms |
| Console scroll with 10k steps | ≤ 5% dropped frames |
| Rule-based map visible after repo open (5k files) | ≤ 2 s |
| Full scan (20k files) | ≤ 20 s, in the background, ingestion unaffected |
| Narrator first purposes after scan (≤ 200 components) | ≤ 30 s |
| `layoutMap` for 200 components and 1,000 edges | fresh ≤ 8 ms, sticky ≤ 2 ms |
| Map pan and zoom | same as Canvas (≤ 5% dropped) |
| Snapshot row size | ≤ 512 KB |
| Ingest regression | M1b soak ratio ≤ 1.10 with the explainer stage on (narrator stubbed) |
| Model cost | reopen of an unchanged repo makes 0 calls; ≤ 1 call per 20 changed components; session story ≤ 1 call per 20 s |

## 12. Testing

- **`codebase-map`:**
  - unit tests for each cut rule, role rule, edge aggregation and cap
  - property tests: every file is in exactly one component; ids are stable under file additions outside a component; content hashes change only when member files change; snapshot caps hold
- **Scan:** fixture repos (a pnpm workspace, a flat `src`, a Python repo with no edges, a large generated repo for the cap) with expected snapshots.
- **Narrator:**
  - guardrail tests with a fake client: missing or unresolvable citations are dropped; over half dropped discards the batch; bad roles and Markdown are rejected
  - cache-hit and backoff tests
  - a recorded-response test per question
- **Viewer model:** fold of the new rows, incremental-equals-fresh with the new rows, and `buildConsoleRows` and `buildBrief` unit and property tests.
- **Map layout:** properties (no overlap, no card crossing, sticky, deterministic) and a fixture table test on this repo's own snapshot.
- **UI:**
  - Console, Brief and Map component tests (keyboard, focus stability on rebuild, the untrusted-text U+202E case, the decision block's actions)
  - main-window embed tests (view switching keeps selection; the prompt dock keeps the D-5 reducer behavior)
- **Electron smoke:** extended so the main window opens, the Console shows the mock session's steps within 150 ms of each row, and the view switcher reaches every view.
- **Visual:** headless screenshots of Console, Brief and Map at 1440, 1180 and 1000 px, compared against the approved mockups.
- **Perf:** HUD measures for Console append latency and scroll, `layoutMap` bench, and the scan bench.

## 13. Phases and exit criteria

| Phase | Contents | Exit |
|---|---|---|
| A. Console-first workspace | Mockups (Console, Brief v0, main window); contracts (`trace:rowsAvailable`, `hostViews`, `chrome`); push-hint IPC and controller hook; Console view; Brief v0 (rule-based Now and Changes); embed in the main window with the view switcher, prompt dock and Surfaces view; light restyle; terminal pane separation. | Mockups approved; smoke opens the main window on Console; append latency budget met; all views reachable with selection preserved; suites green. Product review by the person. |
| B. Codebase overview | Mockups (Map, Brief architecture card); contracts and storage (`overview_snapshot`, snapshot schemas, cache tables, bundle v2); `codebase-map` package; scan in evidence-engine; explainer stage overview builder; narrator `describeComponents` and `overviewNarrative` with guardrails and cache; viewer fold of snapshots; Map layout and view; Brief architecture card; setting to turn off the narrator; fix of ArchitectureDelta edge ids (the mismatch is in the desktop `ui-stage.ts`: surface ids `file:<path>` never match the semantic graph's `file_<hash>` ids). | Map of this repo matches the expected component table; budgets in §11 met for scan, layout and narrator; reopen costs 0 calls; ingest soak ratio ≤ 1.10; product review. |
| C. Session explainer | `explainer` rows; `sessionStory`, `decisionWhy`, highlights; Map overlay; decision cards in Brief and Inspector; Console summary blocks; budgets and smoke. | Story and highlights update during a mock live session within one debounce window; decisions show the "why" with a resolvable citation; product review. |

**Parallel lanes.**

- **Phase A:** contracts first, then two parallel lanes:
  - **A-viewer:** Console, Brief v0, `hostViews`/`chrome`, controller hook.
  - **A-desktop:** push IPC, embed, switcher, prompt dock, Surfaces view, restyle, terminal separation.
- **Phase B:** B-contracts/storage first, then three parallel lanes:
  - **B-map:** the `codebase-map` package, the scan, and the explainer stage's overview builder.
  - **B-narrator:** jev-router questions, guardrails, cache.
  - **B-viewer:** fold, Map layout and view, Brief card.
- **Phase C:** follows A and B.

## 14. Risks and open questions

- **Light-only main window.** Some people expect a dark terminal. Tokens are structured so a dark theme is a follow-up, but this spec ships light only (E6).
- **Embedding cost.** The main window renders the viewer for long sessions. The viewer's incremental model and virtualized views carry this, and Console scroll and append budgets gate it.
- **Narrator quality.** Purposes are short and cited, but can still be bland or wrong. The Inspector shows provenance, and the person can turn the narrator off. A later spec could let the person edit purposes, stored in the cache with provenance "person".
- **Monorepo cut rules.** Some repos are organized by feature, not by package. The 150-file split and the role bands give a usable first map. A per-repo override file (`.jevcode/components.json`) is a follow-up.
- **Codex output fidelity.** The Console shows normalized events, not Codex's exact TUI. If byte-exact output is wanted later, a raw PTY tab can be added as a host view.

## 15. Non-goals (this spec)

- a dark theme
- editing component purposes
- per-repo component overrides
- languages beyond TypeScript, JavaScript and JSON for import edges
- a raw agent TUI view
- multi-repo overviews
- sharing overviews outside the machine
- screen-reader (VoiceOver) verification, out of v1 per the 2026-10-02 decision; accessible names and keyboard support are still built
