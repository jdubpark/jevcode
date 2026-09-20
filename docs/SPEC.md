# Jevcode MVP Engineering Specification

Status: v1 — ready for implementation
Audience: implementation agents, reviewers
Source: `jevcode_PRD.md`; resolves all of PRD §60 "Open Questions for the Specification Phase".

---

## 1. Scope

The MVP proves one claim (PRD §41):

> A developer can supervise a non-trivial coding-agent task more effectively through semantic generative UI than through the agent's raw CLI stream.

In scope: one coding agent (Codex), one repo at a time, TypeScript/JavaScript-first analysis, 11-component catalog, Jev attention + projection passes with deterministic guardrails, Decision interrupt/resume loop, semantic review at completion, terminal + raw diff escape hatches, local-only telemetry.

Out of scope: Claude adapter (interface only), multi-agent, LSP, coverage/profiling/security scanners, CI/PR integration, personalization learning, policy engine, sandboxed execution, semantic Git history UI, replay UI polish.

## 2. Architecture

### 2.1 Process model

```
Jevcode Desktop (Electron)
│
├── Main process
│   ├── AgentController          — spawn/manage Codex, PTY, interrupt/resume
│   ├── GitService               — status, diffs, session base commit
│   ├── FileWatcher              — chokidar, debounced, repo-scoped
│   ├── Storage                  — SQLite (WAL), event store + projections
│   ├── JevService               — model calls (typesafe Jev SDK), queue, degrade mode
│   ├── Pipeline                 — orchestration of evidence→semantic→Jev→UI
│   ├── ActionDispatcher         — allowlisted structured actions → agent/IPC
│   └── IPC                      — zod-validated channels to renderer
│
├── Analysis worker (worker_threads, 1+)
│   ├── Tree-sitter parsing      — changed files → symbol facts
│   ├── Diff analysis            — hunk classification (code/formatting/config)
│   ├── Dependency extraction    — package manifests, import edges
│   └── Test/build output parsing
│
└── Renderer (React, sandboxed)
    ├── App shell (stable chrome)
    ├── json-render Renderer + Jevcode registry
    ├── Component catalog (11 semantic components)
    ├── SurfaceManager (stability engine)
    └── xterm.js Terminal, diff2html CodeDiff, React Flow diagrams
```

### 2.2 Package layout (pnpm monorepo)

```
jevcode/
├── apps/desktop/                 Electron main / preload / renderer
├── packages/
│   ├── contracts/                ALL shared TS types + zod schemas + IPC channel defs
│   ├── agent-core/               adapter interface, event normalizer, lifecycle
│   ├── agent-codex/              Codex CLI adapter
│   ├── evidence-engine/          collectors (git, fs, tree-sitter, deps, tests, commands)
│   ├── semantic-core/            ChangeUnit clustering, semantic graph, events
│   ├── jev-router/               Jev harness, guardrails, confidence policy, degrade router
│   ├── ui-compiler/              UIIntent → json-render spec compiler (pure, node+neutral)
│   ├── ui-catalog/               json-render catalog + React registry + 11 components
│   ├── storage/                  SQLite schema, event store, projections, queries
│   └── telemetry/                local event schema + export
├── evals/                        labeled fixtures + jev eval runner
├── fixtures/                     replay scenarios (oauth, rate-limit, schema, api-break, dep)
└── docs/
```

`contracts` is the parallelization keystone: UI, semantic, and Jev tracks all build against it from day one.

### 2.3 Contract-first rule

No package may depend on another package's internals; all cross-package communication goes through `contracts` types. IPC payloads, pipeline messages, fixture formats, and `json-render` prop schemas all live in `contracts` as zod schemas with derived TypeScript types. A breaking contract change is a PR-wide change.

## 3. Decision Register (answers PRD §60)

### 3.1 Agent integration

| Question | Decision |
|---|---|
| Which agent ships first? | **Codex** (`@openai/codex` CLI, ≥ 0.155). Claude adapter = interface + stub only. |
| What protocol? | Spawn `codex exec` (configurable subcommand) in a PTY, capture stdout/stderr, parse **structured JSONL events** when `--json`/`--output-format json` is available (verify in spike T2-1). Fallback: normalize from the human-readable transcript + evidence engine. |
| Which events are directly available? | Determined by T2-1 spike. Expected: turn start/end, message deltas, tool calls (read/write/exec), approval requests, agent finish. Mapping table is an artifact of the spike. |
| Which must be inferred? | Anything not in the structured stream: exact file edits (from git diff), test outcomes (from output parsing), dependency intent (from manifests + import edges). |
| How are approvals mapped? | **Verified by spike:** headless `codex exec` runs with approval_policy=Never — no interactive approval prompts exist; declined commands surface as `command_execution` `status:"declined"` → mapped to `ApprovalRequested` events. The Decision flow covers cases the agent itself asks about plus declined-command surfacing. |
| Interrupt/resume? | **Verified by T2-1 spike (codex 0.155.1):** SIGINT does not pause-and-wait; it ends the current turn and the process exits 1 with no resume channel; mid-run stdin is ignored. v0 mechanism: interrupt() ends the turn; queued instructions/decisions are applied by relaunching `codex exec resume <thread_id>` as a new process and writing the structured text as its prompt. This is the "next natural boundary" fallback the spec anticipated, now the shipped path. The thread id (from `thread.started`) is exposed via `CodingAgentAdapter.getThreadId()` and surfaced on the desktop session state as `agentThreadId`. |
| Structured decision response format | A fixed markdown/YAML block appended as a user message (PRD §8 format): `decision:`, `evidence:`, `instruction:`. Deterministic serialization from `StructuredDecision` contract. Two deny semantics (OpenCode v2 pattern): `instruction` present = correction-with-feedback (model-visible); absent = plain decline (serializer emits an explicit decline line). |

### 3.1a Durable instruction admission (OpenCode v2 pattern)

Agent instructions and decision answers are **admitted through a durable inbox**, not fire-and-forget stdin writes. Design borrowed from OpenCode v2's inbox/admission model (`session.inbox`):

- `AgentInstruction` carries `id` (admission id) and `mode`: `"steer"` = deliver immediately (for codex: end the turn and relaunch `codex exec resume <thread_id> "<text>"`); `"queue"` = hold and deliver one instruction per `resume()` or one auto-relay per `agent_completed` (cap 1 per completion to prevent loops).
- Admission is idempotent by instruction id — re-offering the same id is a no-op (safe reload).
- `sendInstruction` returns `"delivered" | "queued" | "declined"`; the desktop `InstructionRouter` persists every instruction to the `instruction_inbox` storage projection first, then offers it to the adapter; the inbox row is marked delivered/cancelled from the confirmed outcome. Pending instructions survive app restarts (`reloadPending` on boot and on session activation).
- The renderer gets `agent:instructionState` (pending list) and can cancel via `agent:cancelInstruction`.
- Per-session admission mutex (`SerialQueue`): sendInstruction/sendDecision/interrupt/resume/stop never interleave.

### 3.1b Execution claim, boot recovery, resume budget (OpenCode v2 pattern)

- `sessions.execution_claim_ts` is set at session start and released on terminal agent exit (write-ahead claim, OpenCode's `time_suspended`).
- Boot sweep: any session still `running` (and stale `paused`/`waiting_decision` with claim older than 24h) is marked `failed` — the codex thread id stays on the session row for later resumption.
- Resume budget: `resume_attempts` increments per resume; ≥3 → session failed with "resume budget exhausted" (prevents crash-loops; OpenCode's resume counter).
- PTY stall watchdog: `JEVCODE_AGENT_STALL_MS` (default 0 = off) emits an `agent_waiting` event when the agent produces no output while running.

### 3.1c Model & reasoning configuration (auto-selection policy)

In-app agent settings (persisted via storage preferences): `agent.model` (`"auto"` or a concrete model id from the catalog), `agent.reasoningEffort` (`"auto" | "low" | "medium" | "high" | "xhigh"`), `agent.usageBudgetFraction` (0..1, or unknown). Env overrides: `JEVCODE_CODEX_MODEL`, `JEVCODE_CODEX_REASONING_EFFORT`, `JEVCODE_USAGE_BUDGET`.

Precedence at session start: explicit session input → env override → auto policy. The auto policy (TypeSafe composite-scoring pattern — Jev scores dimensions, deterministic code combines):

- Jev Scores (one batched request, 3 Score questions): `prompt_complexity`, `topic_risk` (docs/tests < feature < bugfix/refactor < perf/concurrency < auth/security/migrations/infra), `work_complexity` (single file < small feature < large feature < architecture/repository-wide).
- Deterministic `combinePolicy`: `complexity = 0.4·work + 0.35·topic + 0.25·prompt`; budget `< 0.2` → economy; `0.2–0.6` → premium iff complexity ≥ 0.7 else standard; `≥ 0.6` → premium iff complexity ≥ 0.5 else standard; unknown budget treated as 0.4 (conservative). Large expected context (≥32k tokens estimate from `⌊prompt/4⌋ + fileCount×300`) forces premium for prompt-caching benefit.
- Effort from tier + complexity: economy→low (medium ≥0.6), standard→medium (high ≥0.6), premium→high (xhigh ≥0.75 or top topic-risk level).
- Degrade fallback (no key/offline): keyword + prompt-length + file-count heuristics, confidence 0.6, flagged `[heuristic]`.
- Result persisted as `model_selected` telemetry (modelId, tier, effort, confidence, rationale, context estimate) and shown in the session log line. Catalog: `DEFAULT_MODEL_CATALOG` = economy `gpt-5.6-mini`, standard `gpt-5.6-sol`, premium `gpt-5.6-luna` (overridable).

### 3.2 Repository intelligence

| Question | Decision |
|---|---|
| Tree-sitter only or LSP from v0? | **Tree-sitter only.** Grammars: `typescript`, `tsx`, `javascript` (+ `json` for manifests) in v0. Parser registry makes adding Python/Go later a config change. |
| Symbol identity across edits? | `SymbolId = relativePath + "#" + name + "(" + kind + ")@" + sha1(signatureText)`. Same name+kind with changed hash ⇒ "modified"; present in base parse but absent in new ⇒ "removed"; inverse ⇒ "added". |
| How are semantic changes grouped? | Deterministic clustering (see §6). Jev labels/ranks clusters but never creates or splits them. |
| Re-index frequency? | Incremental on file-write events (300ms debounce per file). Full re-index of repo on open (background, ≤60s for 10k files) and on session start against base commit. |

### 3.3 Jev

| Question | Decision |
|---|---|
| Runtime | **TypeSafe API** (System One models — Jev) via the official JS SDK (`typesafe` npm package) or HTTP API. All Jev passes decompose into `Choice` / `Noul` / `Score` primitives asked over the same state in one batched request per pass. The model's calibrated probabilities ARE the `probabilities`/`confidence` in `JevResult`. `JevClient` isolates the provider; the degrade router is the no-key/offline path. |
| Exact question schemas | Defined in §8. Two passes only: Attention (Pass A), Projection (Pass B). No ad-hoc questions in v0. |
| Single or parallel calls? | One batched call per Pass A flush (≤8 candidate units). Pass B: one call per surfaced unit, ≤4 in flight. |
| Deterministic overrides | Guardrail rules in §8.3 are evaluated **before and after** Jev; they clamp or replace Jev outputs. They cannot be overridden by the model. |
| Confidence thresholds | `≥0.90` autonomous render; `≥0.70` conservative render (more evidence, lower density); `≥0.50` generic semantic summary + System-2 request; `<0.50` suppress/defer. Per-category overrides allowed. |
| Retry behavior | One retry on schema/validation failure, then deterministic defaults. No retries on policy outputs. |
| Offline/degraded | Degrade router (deterministic heuristic maps evidence types → category/importance/representation) with `confidence=0.6` flagged as "heuristic" in the UI and in `jev_decisions`. This is also the fixture/demo path. |

### 3.4 UI

| Question | Decision |
|---|---|
| Exact initial catalog | 11 components (§9). P0: `ChangeOverview`, `Decision`, `CodeDiff`, `Terminal`, `TestMatrix`, `FailureAnalysis`. P1: `BehaviorDelta`, `ArchitectureDelta`, `SchemaDelta`, `DependencyDelta`, `ExecutionTimeline`. |
| Diagram library | **React Flow** (`@xyflow/react`) for `ArchitectureDelta` and `DependencyDelta` node/edge graphs. Custom table layout for `SchemaDelta`. No general diagram generation. |
| Diff library | **diff2html** (`diff2html`/`diff2html-ui`) for `CodeDiff`; xterm.js for `Terminal`. |
| Layout stability | Enforced by `SurfaceManager` (§9.6): minimum surface lifetime 8s, interaction lock, patch-streaming updates, pinning, expansion-state preservation, no auto-hide of user-opened raw views. |
| Nested views | Single generative workspace + drilldown as inline expansion (progressive disclosure per PRD §6.6). No nested modal stacks in v0. |

### 3.5 State

| Question | Decision |
|---|---|
| Event-sourced graph? | **Yes.** All pipeline facts and mutations append to a `events` table; semantic graph and UI state are projections rebuilt on boot. Enables replay (§PRD 38) and audit without extra machinery. |
| UI snapshots | Every emitted `json-render` spec is persisted with its `UIIntent` and Jev decisions (`ui_snapshots`), keyed by session and semantic event. |
| Task replay | Replay = re-feed stored events through the pipeline with Jev in playback mode (fixtures/replay runner). v0 ships replay as internal tooling, not polished UI. |

### 3.6 Performance

| Question | Decision |
|---|---|
| File edit → semantic surface | SLOs in §13: evidence ≤2s p50, semantic flush ≤5s, Phase A skeleton ≤100ms, full surface ≤1s after Jev. |
| Indexing overhead | Analysis worker only; renderer never blocks; target ≤10% sustained CPU during indexing. |
| Burst batching | 500ms window, cap 25 facts/batch; same-file facts merge (latest wins); agent events never merged, ring-buffered (100k) into terminal scrollback. |

### 3.7 Security

| Question | Decision |
|---|---|
| Agent process permissions | Runs as the user's own account, cwd pinned to the opened repo root. No sandboxing in v0 (explicit non-goal). |
| Shell approval model | Agent-initiated destructive commands (see §8.3.1) trigger a required Decision before execution is confirmed to the agent, only when the agent asks for approval. Jevcode does not intercept arbitrary PTY commands in v0. |
| Renderer sandboxing | `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`; preload exposes only `window.jevcode` with the allowlisted API. |
| Secrets handling | Redaction pipeline before any repo content reaches Jev/System-2 context (pattern set + .env exclusion). Terminal output is never sent to model context unless explicitly invoked by an action. |
| Model-context redaction | Same pipeline; redacted spans replaced with `[REDACTED:<kind>]`, counts logged to telemetry. |

## 4. Shared Contracts (`packages/contracts`)

All types below are zod schemas with derived TS types. Field names are wire-stable within MVP.

### 4.1 Normalized agent events (PRD §12, extended)

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

### 4.2 Evidence facts

```ts
type EvidenceFact =
  | { type: "git_hunk"; repoId: string; sessionId: string; file: string; added: number; removed: number;
      isFormattingOnly: boolean; isConfigOnly: boolean; isLockfile: boolean; ts: string }
  | { type: "file_changed"; repoId: string; sessionId: string; path: string; kind: "added" | "modified" | "deleted"; ts: string }
  | { type: "symbol_delta"; repoId: string; sessionId: string; path: string;
      added: SymbolInfo[]; removed: SymbolInfo[]; modified: SymbolInfo[]; ts: string }
  | { type: "dependency_change"; repoId: string; sessionId: string; manifest: string;
      added: { name: string; version: string }[]; removed: { name: string; version: string }[]; ts: string }
  | { type: "test_result"; repoId: string; sessionId: string; runner: string; command: string;
      passed: number; failed: number; skipped: number; failures: TestFailure[]; ts: string }
  | { type: "command_executed"; repoId: string; sessionId: string; command: string; exitCode: number;
      isDestructive: boolean; ts: string }
  | { type: "revert_detected"; repoId: string; sessionId: string; files: string[]; ts: string };

type SymbolInfo = { name: string; kind: "function" | "class" | "method" | "interface" | "type" | "variable" | "import" | "export";
  signature: string; startLine: number; endLine: number };
type TestFailure = { file: string; testName: string; message: string };
```

### 4.3 Semantic objects (PRD §9, §55)

```ts
type SemanticEventKind =
  | "behavior_change" | "architecture_change" | "api_change" | "schema_change"
  | "dependency_change" | "security_change" | "test_result" | "failure"
  | "decision_candidate" | "implementation_change";

interface SemanticEvent {
  id: string; sessionId: string; kind: SemanticEventKind;
  summary: string;                        // deterministic or Jev-written
  changeUnitId?: string;                  // may be unassigned briefly
  evidence: EvidenceRef[]; files: string[]; symbols: string[];
  createdAt: string;
}

interface ChangeUnit {
  id: string; sessionId: string;
  title: string; intent?: string;
  category: ChangeCategory;               // PRD §9 union
  status: "detected" | "in_progress" | "validated" | "failed" | "reverted" | "superseded";
  behaviorBefore?: string; behaviorAfter?: string;
  files: string[]; symbols: SymbolRef[];
  interfacesChanged: InterfaceChange[]; schemaChanges: SchemaChange[]; dependencyChanges: DependencyChange[];
  relatedDecisions: string[]; validationResults: string[];
  blastRadius?: { affectedFiles: number; affectedSymbols: number; affectedTests: number; scope: "local" | "module" | "subsystem" | "repository" };
  importance?: number; relevance?: number; interruption?: number; uncertainty?: number; mentalModelChange?: number;
  evidence: string[];                     // evidence fact ids
  createdAt: string; updatedAt: string;
}

interface Decision {
  id: string; sessionId: string; title: string; context: string;
  severity: "optional" | "recommended" | "required";
  options: DecisionOption[];
  affectedChangeUnits: string[]; evidence: string[];
  status: "open" | "answered" | "delegated" | "expired";
  answer?: StructuredDecision;
}

interface StructuredDecision {
  decisionId: string;
  decision: Record<string, string>;       // key = decision key, value = chosen option id
  evidence: string[];                     // evidence refs
  instruction: string;                    // serialized for agent consumption
}
```

### 4.4 Jev results (PRD §14, §15, §55)

```ts
interface AttentionDecision {
  shouldSurface: boolean;
  importance: number; relevance: number; interruption: number;      // 0..1
  mentalModelChange: number;                                        // 0..1
  semanticCategory: SemanticEventKind;
  scope: "local" | "module" | "subsystem" | "repository";
  humanDecision: "none" | "optional" | "recommended" | "required";
  needsSystem2: boolean;
  confidence: number;                                               // 0..1
  probabilities: Record<string, number>;                            // calibrated dist over categories
}

interface UIIntent {
  attention: "background" | "surface" | "highlight" | "interrupt";
  subject: "behavior" | "architecture" | "code" | "schema" | "api" | "dependency" | "tests" | "decision" | "security" | "performance";
  representation: "summary" | "before_after" | "diff" | "diagram" | "table" | "graph" | "decision" | "failure" | "timeline";
  density: "compact" | "normal" | "detailed" | "expert";
  confidence: number;
  showEvidence: boolean; showCode: boolean;
  secondaryViews: string[];              // component names, e.g. ["CodeDiff", "ExecutionTimeline"]
  renderMode: "autonomous" | "conservative" | "generic" | "suppressed";
}
```

### 4.5 IPC channels (main ↔ renderer)

```
→ main: repo:open, repo:close, session:start, session:stop,
        agent:interrupt, agent:resume, agent:sendInstruction,
        agent:cancelInstruction, action:invoke (whitelisted action payloads),
        terminal:input, terminal:resize, surface:pin, surface:dismiss,
        telemetry:flush
← renderer: repo:opened, session:state, agent:event, agent:state,
        agent:instructionState, semantic:update, changeunit:upsert,
        decision:open, decision:resolved, validation:update, ui:spec (full),
        ui:specPatch (streamed), terminal:data, terminal:scrollback,
        jev:debug, telemetry:ack
```

Every payload zod-validated in both directions; unknown channels rejected.

## 5. Event Pipeline (PRD §33, concretized)

```
Agent events ─┐
File watcher ─┤
Git service ──┼─→ Normalize → EvidenceFacts (append to event store)
Test parsing ─┤
                              │ debounce+batch (500ms, ≤25, same-file merge)
                              ▼
                        Semantic Engine
                        ├── attach facts to existing ChangeUnits (connectivity)
                        ├── cluster unattached facts into candidate units
                        └── update graph + semantic events
                              │
                              ▼
                        Jev Pass A (batched, ≤8 units)
                        ├── guardrail pre-clamps (destructive/security/schema/API)
                        ├── suppress → log only
                        └── surface →
                              ▼
                        Jev Pass B (per unit)
                              │
                              ▼
                        UI Compiler → json-render spec
                              │
                              ▼
                        Renderer (Phase A skeleton → Phase B full → Phase C stream)
```

Ordering and idempotency guarantees:

- Every fact carries a `sessionId` and a monotonically increasing sequence; projections tolerate duplicates (idempotent upsert by `factId`).
- Facts referencing a `path` are applied in sequence order; concurrent edits to one file collapse to the latest within a batch.
- Semantic projection is a pure function of (base parse, ordered facts) — replayable.
- Jev calls are async and unordered-safe: results apply by `changeUnitId` + `decisionVersion`; stale results (older version) are discarded.

## 6. Semantic Engine (`packages/semantic-core`)

### 6.1 ChangeUnit clustering (deterministic)

Input: ordered `EvidenceFact`s for a session. Output: `ChangeUnit` upserts.

1. **Idle split.** Facts with >120s gap between consecutive facts begin a new temporal bucket.
2. **Connectivity graph.** Within a bucket, build a graph over files:
   - edge (a,b) if a and b appear in the same `git_hunk` batch (diff snapshot) — weight 1;
   - edge (a,b) if a symbol in a is imported/exported by b — weight 0.8;
   - edge (a,b) if a and b changed within the same 500ms batch window — weight 0.5.
3. **Components.** Connected components = candidate ChangeUnits (min size: 1 file or 1 non-trivial fact).
4. **Attachment.** A new fact attaches to the most-connected existing unit (≥1 edge); otherwise starts a new candidate.
5. **Merge/supersede.** If a later bucket's component is >50% connected to an existing unit, merge. `revert_detected` facts set units to `reverted`; git-reset detection sets `superseded`.
6. **Deterministic summary.** Title = "Changed N files: <top-3 files>" (placeholder). Jev Pass A replaces title/category/intent; on Jev failure the placeholder stands.

Rationale: clustering is pure structure; Jev supplies semantics. Property tests: clustering is invariant to fact reordering within a bucket and to bucket-level shuffling.

### 6.2 Semantic graph

Node types: `Task`, `ChangeUnit`, `File`, `Symbol`, `Dependency`, `Decision`, `Validation`, `Failure`, `Command`, `AgentEvent`. Edge types per PRD §10. Stored as projection tables (`graph_nodes`, `graph_edges`) rebuilt from events on boot. The graph is the query substrate for `BlastRadius` and drilldown; v0 ships no interactive graph UI beyond `ArchitectureDelta`.

### 6.3 Validation / Failure extraction

- `test_result` facts → `Validation` rows keyed by `runner+command+ts`, plus `Failure` rows per failing test.
- Failing tests attach to ChangeUnits via: (a) failing test file in unit's file set; (b) test name mentioning a unit symbol.
- Build/lint output parsed with the same pattern (`build_result` facts) for typecheck/lint rows in `TestMatrix`.

## 7. Evidence Engine (`packages/evidence-engine`)

| Collector | Input | Output facts | Notes |
|---|---|---|---|
| GitCollector | `git status/diff` against session base commit | `git_hunk` (per file, classified formatting-only/config/lockfile) | Classifier: whitespace-only hunk detection + path heuristics (`*.lock`, `package-lock.json`, `.prettierrc`, etc.) |
| FileWatcher | chokidar on repo root | `file_changed` | 300ms debounce; ignores `.git`; drop policy merges same-file |
| SymbolCollector (worker) | tree-sitter parse of changed files | `symbol_delta` | vs. base parse snapshot; signature hash identity |
| DependencyCollector | `package.json` (+ `pnpm-lock.yaml`/`yarn.lock`/`package-lock.json` for resolution) | `dependency_change` | lockfile-only changes → still emit, guardrail suppresses UI |
| TestCollector | PTY + command log parsing (vitest/jest/pytest formats) | `test_result` | regex suite v0; runner registry for extension |
| CommandCollector | PTY log | `command_executed` | destructive classifier (§8.3.1) |
| RevertDetector | git status/reset observation | `revert_detected` | |

All collectors emit into the event store; none talk to the renderer directly.

## 8. Jev Harness (`packages/jev-router`)

### 8.1 Client interface

```ts
interface JevClient {
  attention(batch: AttentionInput[]): Promise<JevResult<AttentionDecision>[]>;
  project(input: ProjectionInput): Promise<JevResult<UIIntent>>;
  health(): Promise<"ok" | "degraded">;
}
```

Implementations: `TypeSafeClient` (official JS SDK; batched `Choice`/`Noul`/`Score` questions; per-answer probabilities → `probabilities`; distribution concentration → `confidence`; key via `TYPESAFE_API_KEY` env), `DegradeClient` (heuristic, always `confidence=0.6`, flagged). Selection: env config; auto-degrade on failure/offline/missing key.

### 8.2 Question decomposition (exact, TypeSafe primitives)

All questions use TypeSafe primitives per the TypeSafe skill guidance: `Choice` (one of a defined set), `Noul` (probability of a condition holding), `Score` (degree on described levels). All Pass A questions for a batch are sent as **one request over the same state**; TypeSafe evaluates them in parallel.

Pass A, per candidate unit (state = unit summary + evidence hints):

- `should_surface` — Noul: "This change deserves a developer-visible surface."
- `semantic_category` — Choice over the 11 `SemanticEventKind` values.
- `importance` — Score over described levels (negligible / minor / moderate / major / critical): "How consequential is this change to the software?"
- `relevance` — Score: "How useful is it for the developer to see this change at the current moment?"
- `interruption` — Score: "Should the agent stop and request human judgment?"
- `mental_model_change` — Score: "How much must a competent developer's conceptual model of the system change because of this?"
- `scope` — Choice: local / module / subsystem / repository.
- `human_decision` — Choice: none / optional / recommended / required.
- `needs_system2` — Noul: "Deeper System-2 analysis is worthwhile here."

Pass B, per surfaced unit: `representation` (Choice over the 9 representations), `attention` (Choice), `density` (Choice), `show_evidence` (Noul), `show_code` (Noul), `secondary_views` (one Noul per catalog component, ≤3 true).

Input state per unit (identical across passes): title placeholder, category hints from evidence types, file set (≤40 paths), symbol names (≤60), dependency deltas, diff stats (added/removed lines, isFormattingOnly), affected test outcomes, related decision presence, task prompt (truncated 4k chars).

Prompt policy: system prompt states the Jevcode catalog, the triad (importance/relevance/interruption) definitions from PRD §17, the mental-model-delta definition (PRD §2.6), and examples from PRD §34 verbatim as few-shot context in the state.

Mapping to `JevResult`: `Score` level position maps linearly to 0..1 (levels evenly spaced); `Choice` answer distribution → `probabilities`; concentration of the chosen answer → `confidence`; `Noul` probability → boolean (≥0.5) plus its probability as `confidence`.

### 8.3 Deterministic guardrails (evaluated pre- and post-Jev; cannot be overridden)

1. **Destructive**: `command_executed.isDestructive` (pattern list: `rm -rf`, `git push --force`, `git reset --hard`, `DROP TABLE`, `TRUNCATE`, `DELETE FROM`, `db:reset`, migration down) → `shouldSurface=true`, `humanDecision="required"`, `interruption≥0.9`.
2. **Security**: files matching auth/permission path patterns (`auth/`, `session/`, `token`, `oauth`, `.env`, `permissions`, `access control`) → `shouldSurface=true`, `semanticCategory="security_change"`.
3. **Schema**: migration/schema files (`migrations/`, `prisma/`, `schema.sql`, `*.prisma`) → surface floor.
4. **API**: changed files exporting symbols that are imported outside their module (public export heuristic) → surface floor, `api_change` candidate.
5. **Suppress**: formatting-only diffs; lockfile-only changes; test_result with `failed=0` when user setting `auto_collapse_passing_tests` is on.
5a. **Noise triad cap** (extension, live-calibrated): for suppressed formatting/lockfile units, cap importance ≤0.05, relevance ≤0.05, interruption ≤0.02, mental_model_change ≤0.05 (Jev batched calls otherwise over-rate noise units that carry `formatting_only`/`lockfile_only` flags).
6. **Interrupt floor**: any decision with `humanDecision="required"` gets `interruption = max(interruption, 0.8)`.
6a. **Decision presence floor** (extension, live-calibrated): units with pending `decisionIds` get importance ≥0.85, relevance ≥0.85, interruption ≥0.6 — a pending human decision is important regardless of model scoring.
7. **Relevant-now floor**: units with status `failed` are always relevant (never background).

### 8.4 Confidence policy (pure function)

`renderPolicy(jev: JevResult<UIIntent>): RenderMode` per PRD §16 thresholds, plus: `attention === "interrupt"` always renders; `renderMode="conservative"` sets `density−1` level and forces `showEvidence=true`.

### 8.5 Jev decision logging

Every call result is stored (`jev_decisions`: inputs hash, outputs, confidence, probabilities, latency, client kind, guardrail clamps applied). Debug panel (`Cmd/Ctrl+Shift+J` overlay) shows the last 50 per session. This satisfies PRD §59.17 and enables calibration (§14).

## 9. UI Compiler and Component Catalog (`packages/ui-compiler`, `packages/ui-catalog`)

### 9.1 Compiler

`compileUI(intent: UIIntent, payload: CompilePayload): JsonRenderSpec` — a **pure function** (unit-testable, no network, no React import). Maps `intent.representation` to a root component; binds payload data into props; emits secondary views as sibling surfaces. Uses json-render flat spec format: `{ root, elements: { id: { type, props, children } } }`.

`CompilePayload` = ChangeUnit | Decision | Validation matrix | Failure set | timeline slice — one per surface.

Streaming: full specs for Phase B; Phase C (System-2 text) streams in via `createSpecStreamCompiler` patches into the existing surface.

### 9.2 Catalog definition (json-render)

```ts
const catalog = defineCatalog(schema, {
  components: {
    ChangeOverview:   { props: ChangeOverviewPropsSchema,   description: "One semantic change: title, category, status, scope, confidence, drilldown" },
    BehaviorDelta:    { props: ..., description: "Before/after behavior of a public behavior change" },
    ArchitectureDelta:{ props: ..., description: "Node/edge graph of module/service/flow changes" },
    SchemaDelta:      { props: ..., description: "Table/type/model additions, removals, column/field changes" },
    CodeDiff:         { props: ..., description: "Raw unified diff for one or more files" },
    Decision:         { props: ..., description: "Human decision with options and structured answer actions" },
    TestMatrix:       { props: ..., description: "Validation status rows: tests, typecheck, lint, build" },
    FailureAnalysis:  { props: ..., description: "Failed test/build with linked change units and next actions" },
    ExecutionTimeline:{ props: ..., description: "Meaningful milestones, not every command" },
    Terminal:         { props: ..., description: "PTY output with scrollback" },
    DependencyDelta:  { props: ..., description: "Added/removed packages with reason and usage" },
  },
  actions: {
    answer_decision:     { description: "Submit structured decision answer" },
    delegate_decision:   { description: "Let the agent choose and continue" },
    restore_previous_api_semantics: { description: "Instruct agent to restore previous API behavior" },
    inspect_call_sites:  { description: "Show call sites of a symbol" },
    show_exact_diff:     { description: "Open raw diff for the change" },
    accept_changes:      { description: "Mark semantic review as accepted" },
    request_changes:     { description: "Send structured review feedback to the agent" },
    continue_task:       { description: "Resume the agent" },
    open_terminal:       { description: "Open terminal panel" },
    interrupt_agent:     { description: "Pause the agent" },
    pin_surface:         { description: "Pin surface against auto-replacement" },
    dismiss_surface:     { description: "Dismiss surface and log telemetry" },
  },
});
```

### 9.3 Component prop contracts (high level)

Every component receives only plain serializable data (ids, strings, numbers, arrays). Components render evidence chips (`evidence_count`, `confidence`) linking to `CodeEvidence` drilldown. `Decision` renders options with `tradeoffs` table and actions `answer_decision`/`delegate_decision`. `ArchitectureDelta` renders `nodes`/`edges` (bounded ≤50 nodes) via React Flow. `Terminal` is persistent (mounted once per session, survives surface swaps).

### 9.4 Action allowlist and dispatch

Renderer emits `action:invoke` with zod-validated params. Main's `ActionDispatcher` maps action name → handler; handler performs the side effect (agent instruction, decision answer, terminal open, pin state). Unknown actions and schema-invalid params are rejected and logged. No action string from the model ever reaches an unlisted handler.

### 9.5 Progressive disclosure

Drilldown chain is enforced by compiler output, not by user navigation: `ChangeOverview` → expand → `CodeEvidence` (file/symbol list) → expand → `CodeDiff` → `Terminal` toggle. The raw view is never the default.

### 9.6 SurfaceManager (stability engine)

- Surfaces have ids = `changeunit:<id>` | `decision:<id>` | `validation:<ts>` | `timeline` | `terminal` | `completion` (the completion summary surface emitted when the agent finishes).
- Rules: min lifetime 8s; no replacement while pointer is inside the workspace or within 2s of last interaction; pinned surfaces exempt from replacement; low-importance updates apply as patches (spec patch stream) not full swaps; expansion state and scroll position keyed by surface id; user-opened raw views are never auto-hidden.
- Replaces PRD §22's ten rules as executable logic with unit tests.

## 10. Agent Adapter (`packages/agent-core`, `packages/agent-codex`)

```ts
interface CodingAgentAdapter {
  readonly id: "codex";
  detect(): Promise<AgentDetection>;                          // binary present, version
  startSession(input: StartSessionInput): Promise<AgentSession>;  // spawn PTY, base commit
  sendInstruction(input: AgentInstruction): Promise<void>;    // stdin turn
  sendDecision(input: StructuredDecision): Promise<void>;     // serialized per §3.1
  interrupt(): Promise<void>;                                 // SIGINT
  resume(): Promise<void>;                                    // continue stdin flow
  stop(): Promise<void>;
  onEvent(handler: (e: NormalizedAgentEvent) => void): Unsubscribe;
  onExit(handler: (code: number) => void): Unsubscribe;
}

interface StartSessionInput {
  repoPath: string; cwd: string; prompt: string;
  model?: string; approvalMode?: "default" | "never" | "on-failure";
  env: Record<string, string>;
}
```

Codex adapter responsibilities: PTY lifecycle, JSONL parse (or transcript normalization fallback), event mapping (spike artifact), approval flow, interrupt/resume, exit handling, auth error surfacing (missing login → surface actionable FailureAnalysis instead of silent hang).

## 11. Storage (`packages/storage`)

SQLite, WAL mode, single file under `~/.jevcode/jevcode.db` (dev: repo-local `./.jevcode/`). better-sqlite3, synchronous for simplicity in main; worker never writes.

Tables: `repositories`, `sessions`, `events` (event store: `id, sessionId, seq, type, payloadJson, ts`), projections: `agent_events`, `evidence_facts`, `change_units`, `change_unit_files`, `change_unit_symbols`, `decisions`, `decision_options`, `validations`, `failures`, `semantic_events`, `jev_decisions`, `ui_intents`, `ui_snapshots`, `graph_nodes`, `graph_edges`, `commands`, `telemetry_events`, `preferences`.

`semantic_event` is an event-store type: semantic events are appended to `events` and projected into `semantic_events`, so they survive rebuilds without re-derivation (replayed by `rebuildOnBoot`).

Rebuild-on-boot: projections derived from `events`; boot replays incrementally from last checkpoint seq. Snapshot checkpointing is a stretch; v0 replays full session history (bounded: sessions archive after 30 days or 1M events).

## 12. Security Model (v0 implementation)

1. Renderer sandbox per §3.7; preload exposes only `window.jevcode` (open repo, session control, action dispatch, terminal I/O, telemetry).
2. All `ipcMain.handle` entries zod-validate payloads and verify `senderFrame` origin.
3. Repo boundary: FileWatcher and GitService accept only paths inside the opened repo; path-traversal attempts rejected.
4. Model context redaction: `Redactor` (pattern set: AWS keys, JWT, private keys, `password=`, `token=`, `.env` values) runs on any repo content and agent transcript before Jev/System-2 calls; redaction events counted in telemetry.
5. Command logging: every PTY command line stored in `commands` (already a PRD §31 requirement) with `isDestructive` flag.
6. `json-render` specs validated against the catalog zod before render; catalog is closed (no dynamic component registration from model output).

## 13. Performance SLOs

| SLO | Target |
|---|---|
| File write → evidence fact persisted | ≤2s p50, ≤5s p95 |
| Fact batch → semantic projection applied | ≤5s |
| Jev Pass A batch (≤8 units) | ≤3s p95 |
| Jev Pass B (single) | ≤2s p95 |
| Phase A skeleton after surface decision | ≤100ms |
| Full surface after Jev result | ≤1s |
| Initial repo index (10k files) | ≤60s background |
| Per-file incremental parse | ≤300ms |
| Renderer main-thread blocked | never (analysis in worker) |
| Event store growth cap | 1M events/session, then archive |

## 14. Telemetry & Calibration (`packages/telemetry`)

Local-only append table `telemetry_events`: `surface_shown {specHash, confidence, renderMode}`, `view_switched {from,to}`, `evidence_expanded`, `diff_opened`, `terminal_opened`, `decision_answered/overridden/delegated`, `surface_dismissed`, `surface_pinned`, `agent_event_count`, `fact_count`. Exported via debug panel as JSON. Feeds PRD §45/§47 calibration; no network upload in v0.

## 15. Fixtures & Replay (`fixtures/`, `evals/`)

Five scenarios, each a folder with: `events.jsonl` (ordered agent events + evidence facts), `expected_units.json` (the ChangeUnits the pipeline should produce), `labels/attention.json` and `labels/projection.json` (labeled Pass A/B outputs for evals, keyed by unit slug), `golden_specs/*.json` (compiler outputs for snapshot tests), `repo/` (minimal seed repository, TypeScript):

1. `oauth` — Google OAuth + identity layer (architecture, schema, decision, one failing test).
2. `rate-limit` — Redis dependency + fail-open decision + validation matrix (the §58 demo).
3. `schema-change` — migration with column add/remove + compatibility note.
4. `api-break` — GET endpoint 404→200+null behavior change.
5. `dep-change` — added + removed packages with lockfile noise (guardrail suppression case).

Replay runner: feeds `events.jsonl` through the real pipeline with Jev in `PlaybackMode` (deterministic stub returning labeled outputs) or `DegradeMode`. Used by M0 UI development, integration tests, and Jev evals.

## 16. Testing Strategy

| Level | Scope | Tool |
|---|---|---|
| Contract | zod schemas, guardrails, confidence policy, clustering, compiler pure functions, stability rules | vitest (unit) |
| Property | clustering order-invariance, event idempotency, compiler never emits unknown component/action | fast-check |
| Integration | fixture replay through pipeline (no model), SQLite projection rebuild, IPC round-trips | vitest + electron main harness |
| E2E | scripted demo scenario: open repo → rate-limit task (mocked agent) → decision → answer → completion | Playwright (Electron) |
| Evals | Jev Pass A/B against labeled fixtures; targets: `should_surface` precision ≥0.9/recall ≥0.85; representation set-accuracy ≥0.75; score MAE ≤0.15 | evals runner |

No test file is created merely to mirror a source file; suites follow the packages' existing conventions once established.

## 17. Acceptance Criteria Mapping (PRD §59)

| # | Criterion | Proven by |
|---|---|---|
| 1 | Open local repository | T1 + E2E |
| 2 | Supported agent runs inside Jevcode | T2 + E2E (live or mocked-agent mode) |
| 3 | Structured/normalized agent events | T2 unit tests over recorded JSONL fixtures |
| 4 | Independent observation of repo changes | T3 collectors + fixture replay assertions |
| 5 | Git/file/test evidence stored | storage integration tests |
| 6 | Edits grouped into ChangeUnits | T4 clustering tests on all five fixtures |
| 7 | Jev suppresses obvious low-value events | guardrail + evals (formatting/lockfile cases) |
| 8 | Jev selects among multiple UI representations | projection evals + golden specs |
| 9 | json-render renders constrained surfaces | compiler snapshot tests + renderer smoke |
| 10 | Decision can interrupt agent | T2 interrupt spike + M6 E2E |
| 11 | Developer responds through generated UI | Decision component → `answer_decision` E2E |
| 12 | Structured response resumes agent | T2 resume + M6 E2E |
| 13 | Test failures appear independent of narration | TestCollector fixture with agent claiming success |
| 14 | Completion summary reflects repository evidence | M7 golden completion spec + fixture test |
| 15 | Terminal + raw diff always available | shell chrome + E2E |
| 16 | UI stable during continuous execution | SurfaceManager unit tests + soak (10k events replay) |
| 17 | Jev decisions inspectable in debug mode | debug panel + `jev_decisions` queries |

## 18. Deferred (explicit non-goals, revisited post-MVP)

LSP; call/type graphs; embeddings; coverage/profiling; security scanners; CI/GitHub PR integration; Claude adapter implementation; multi-agent; personalization; policy engine; sandboxing/containers; semantic Git history productization; replay UI; team features; Windows/Linux packaging (build config only in v0, target macOS dev first).

## 19. Build status (stabilization pass, 2026-09-19)

All 17 acceptance criteria evidenced (see `docs/acceptance.md`). Security checklist green
(see `docs/security.md`). Performance vs SLOs recorded in `docs/perf.md`; demo runbook in
`docs/demo.md`. Deviations from this document made during stabilization:

- §8.3.2 security guardrail keeps the surface floor but no longer forces the
  `security_change` category for test-only units (a failing test in `tests/auth/…`
  surfaces as `failure`) or for units with an attached decision.
- §8.3.7 failed-unit relevance floor is applied post-model as a floor, not a
  forced value in the pre-clamp.
- §8.3.5 passing-tests suppression additionally requires the unit to have no
  diff line changes at all (`diffStats.added === 0 && diffStats.removed === 0`);
  a unit that both edits code and runs green tests still surfaces.
- Full incremental clustering remains out of scope (§6.1): a rebuild still
  re-clusters the whole session, but rebuilds are debounced to at most one per
  flush burst (25ms trailing idle), and graph-projection fact-ownership /
  import-symbol lookups are Map-indexed (no O(F²)/O(E·F) rescans).
