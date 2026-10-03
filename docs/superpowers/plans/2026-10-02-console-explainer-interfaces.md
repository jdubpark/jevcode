# Console-first workspace and codebase explainer — interfaces

Binding for every lane in `2026-10-02-console-explainer-*.md`. Spec: `docs/superpowers/specs/2026-10-02-console-and-explainer-design.md` ("the spec"). Each name below is created by exactly one owning task; every other task consumes it as written. When a name exists in code already, this file cites its current file. A lane that needs to change a name escalates to the orchestrator; it does not rename it locally.

## 1. Contracts (`packages/contracts`, lane 01)

### 1.1 Event types (`src/trace.ts`)

```ts
// EVENT_TYPES gains, appended at the end (order matters for nothing else):
"overview_snapshot", "explainer"
// TRACE_ROW_TYPES gains the same two, appended at the end.
export const TRACE_BUNDLE_VERSION = 2;                 // was 1
export const TRACE_BUNDLE_VERSIONS_SUPPORTED = [1, 2] as const;
```

The bundle parser (`parseTraceBundle`, trace-viewer `src/sources`) accepts both versions. A v1 bundle has no new rows. The error message "Trace format vN is not supported" stays for other versions.

### 1.2 Overview schemas (`src/overview.ts`, new; re-exported from `src/index.ts`)

```ts
export const ROLES = ["ui", "api", "agent", "domain", "storage", "tests", "tooling", "config"] as const;
export type Role = (typeof ROLES)[number];
export const RoleSchema = z.enum(ROLES);

export const CitationSchema = z.object({
  kind: z.enum(["component", "file", "decision", "fact", "step"]),
  id: z.string().min(1).max(512),
});
export type Citation = z.infer<typeof CitationSchema>;

export const NarrativeSentenceSchema = z.object({
  text: z.string().min(1).max(220),
  citations: z.array(CitationSchema).min(1).max(6),
});
export type NarrativeSentence = z.infer<typeof NarrativeSentenceSchema>;

export const ComponentSchema = z.object({
  id: z.string().regex(/^cmp_[0-9a-f]{12}$/),
  rootPath: z.string().min(1),          // repo-relative, "/" separators, no trailing slash; "." for a flat repo
  name: z.string().min(1).max(120),
  fileCount: z.number().int().nonnegative(),
  files: z.array(z.string()).max(400),  // repo-relative, sorted; capped (fileCount carries the true count)
  language: z.string().max(40).nullable(),          // main language by file count, e.g. "TypeScript"
  roleGuess: RoleSchema,
  role: RoleSchema,
  purpose: z.string().max(140).nullable(),
  provenance: z.enum(["rule", "model"]),
  contentHash: z.string().regex(/^[0-9a-f]{40}$/),
  externalDeps: z.array(z.object({ name: z.string(), count: z.number().int().positive() })).max(8),
  entryPoints: z.array(z.string()).max(8),
  importsAnalyzed: z.boolean(),         // false when no member file has a supported grammar
});
export type Component = z.infer<typeof ComponentSchema>;

export const ComponentEdgeSchema = z.object({
  from: z.string(), to: z.string(),     // component ids
  count: z.number().int().positive(),
  examples: z.array(z.string().max(300)).max(3),   // "a/b.ts → c/d.ts"
});
export type ComponentEdge = z.infer<typeof ComponentEdgeSchema>;

export const ExternalDepSchema = z.object({
  name: z.string().min(1).max(214),
  usedBy: z.array(z.object({ componentId: z.string(), count: z.number().int().positive() })).max(40),
});
export type ExternalDep = z.infer<typeof ExternalDepSchema>;

export const OverviewSnapshotSchema = z.object({
  sessionId: z.string(),                // the session the row belongs to (storage requires a match)
  repoRoot: z.string().min(1),
  scanId: z.string().min(1),
  partial: z.boolean(),                 // true when the 20,000-file cap was hit
  counts: z.object({ files: z.number().int().nonnegative(), components: z.number().int().nonnegative(),
    edges: z.number().int().nonnegative(), languages: z.array(z.string()).max(20) }),
  components: z.array(ComponentSchema).max(200),
  edges: z.array(ComponentEdgeSchema).max(1000),
  externals: z.array(ExternalDepSchema).max(120),
  narrative: z.object({ sentences: z.array(NarrativeSentenceSchema).max(8), provenance: z.literal("model") }).nullable(),
  generatedAt: z.string(),              // ISO
});
export type OverviewSnapshot = z.infer<typeof OverviewSnapshotSchema>;

export const ExplainerRecordSchema = z.discriminatedUnion("kind", [
  z.object({ sessionId: z.string(), kind: z.literal("story"), sentences: z.array(NarrativeSentenceSchema).min(1).max(6), basisSeq: z.number().int().nonnegative(), provenance: z.enum(["rule", "model"]).optional() }),
  z.object({ sessionId: z.string(), kind: z.literal("decision_why"), decisionId: z.string().min(1), sentence: NarrativeSentenceSchema }),
  z.object({ sessionId: z.string(), kind: z.literal("highlights"), basisSeq: z.number().int().nonnegative(),
    components: z.array(z.object({ id: z.string(), state: z.enum(["new", "changed", "decision", "failing"]), unitIds: z.array(z.string()).max(50) })).max(200) }),
]);
export type ExplainerRecord = z.infer<typeof ExplainerRecordSchema>;

export const OVERVIEW_SNAPSHOT_MAX_BYTES = 512 * 1024;
```

### 1.3 IPC (`src/ipc.ts` plus the desktop registry)

```ts
// main → renderer, one-way; payload validated like every other send
"trace:rowsAvailable": { sessionId: string; lastSeq: number }
// renderer → main (main window only; trace windows denied by the allowlist):
"overview:rescan": { repoRoot: string } → void      // Retry after a failed scan (spec §6.6)
// preferences gain:
explainWithModel: boolean   // default true (spec E15)
```

## 2. Storage (`packages/storage`, lane 01)

- `eventStoreSchemas` (`src/db.ts:59`) gains `overview_snapshot: OverviewSnapshotSchema` and `explainer: ExplainerRecordSchema`. `appendEvent` validates them unchanged.
- Migration **version 5** (`src/migrations.ts`, after version 4):

```sql
CREATE TABLE IF NOT EXISTS component_text_cache (
  repo_root TEXT NOT NULL, component_id TEXT NOT NULL, content_hash TEXT NOT NULL,
  purpose TEXT, role TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (repo_root, component_id, content_hash));
CREATE TABLE IF NOT EXISTS overview_state (
  repo_root TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL, narrative_inputs_hash TEXT, narrative_json TEXT,
  updated_at TEXT NOT NULL);
```

- `JevcodeDb` methods (new):

```ts
getComponentText(repoRoot: string, componentId: string, contentHash: string): { purpose: string | null; role: Role; model: string } | undefined;
putComponentText(repoRoot: string, componentId: string, contentHash: string, value: { purpose: string | null; role: Role; model: string }): void;
getOverviewState(repoRoot: string): { snapshot: OverviewSnapshot; narrativeInputsHash: string | null; narrative: OverviewSnapshot["narrative"] } | undefined;
putOverviewState(repoRoot: string, state: { snapshot: OverviewSnapshot; narrativeInputsHash: string | null; narrative: OverviewSnapshot["narrative"] }): void;
```

- Migration **version 6** (lane 07 PL-3) is the latest. It indexes the Jev debug panel's read of a session's newest decisions (`latestJevDecisions`, `WHERE sessionId = ? ORDER BY seq DESC LIMIT n`); a database without `jev_decisions` skips it:

```sql
CREATE INDEX IF NOT EXISTS idx_jev_decisions_session_seq ON jev_decisions (sessionId, seq);
```

- `TraceReader.rows(sessionId, afterSeq, limit, types)` takes the row types as a parameter; the desktop passes `TRACE_ROW_TYPES`, so the new row types come back through `trace:rows` and `trace:payloads` (this follows from §1.1). Export redaction covers them.

## 3. `packages/codebase-map` (new package `@jevcode/codebase-map`, lane 04)

The package is pure TypeScript with no Node built-ins in `src/core/**`. Node-only scanning lives in `src/node/**`, imported by desktop main only. It has its own package.json, tsconfig, vitest config, and a `build` script like other packages. ESLint bans `node:*` imports from `src/core/**`.

```ts
// src/core/types.ts
export interface ScannedFile { path: string; hash: string; size: number; language: string | null; }
export interface ImportEdge { from: string; to: string; }          // repo-relative file paths
export interface ExternalImport { from: string; packageName: string; }
export interface WorkspaceManifest { packageDirs: string[]; appDirs: string[]; packageNames: Record<string, string>; descriptions: Record<string, string>; entryPoints: Record<string, string[]>; }

// src/core/componentize.ts
export function componentize(files: readonly ScannedFile[], manifest: WorkspaceManifest): ComponentDraft[];
export interface ComponentDraft { id: string; rootPath: string; name: string; files: string[]; language: string | null; contentHash: string; entryPoints: string[]; }
export const SPLIT_THRESHOLD = 150;
export function componentIdFor(rootPath: string): string;           // "cmp_" + sha1(rootPath).slice(0,12)
export function componentOf(drafts: readonly ComponentDraft[]): (filePath: string) => string | undefined;

// src/core/edges.ts
export function aggregateEdges(edges: readonly ImportEdge[], componentOfFile: (p: string) => string | undefined): ComponentEdge[];   // capped 1,000 by count
export function aggregateExternals(imports: readonly ExternalImport[], componentOfFile: (p: string) => string | undefined): ExternalDep[]; // capped 120

// src/core/roles.ts
export function guessRole(draft: ComponentDraft, externals: readonly ExternalDep[]): Role;

// src/core/snapshot.ts
export function assembleSnapshot(input: { sessionId: string; repoRoot: string; scanId: string; partial: boolean; drafts: ComponentDraft[];
  edges: ComponentEdge[]; externals: ExternalDep[]; text: Map<string, { purpose: string | null; role: Role; provenance: "rule" | "model" }>;
  narrative: OverviewSnapshot["narrative"]; generatedAt: string }): OverviewSnapshot;   // applies the 200/1000/120 caps and the 512 KB bound

// src/node/scan.ts (Node only)
export interface ScanOptions { maxFiles?: number; maxFileBytes?: number; signal?: AbortSignal; onProgress?(done: number, total: number): void; }
export interface ScanResult { files: ScannedFile[]; manifest: WorkspaceManifest; partial: boolean; }
export function scanRepo(repoRoot: string, options?: ScanOptions): Promise<ScanResult>;   // git ls-files + skips + caps
```

Import extraction is provided by `packages/evidence-engine` (lane 04):

```ts
// packages/evidence-engine/src/imports.ts
export function extractImports(path: string, source: string, language: ParserLanguage): Promise<{ specifiers: string[] }>; // runs in the parse worker
export function resolveSpecifier(fromPath: string, specifier: string, ctx: ResolveContext): { kind: "file"; path: string } | { kind: "external"; packageName: string } | { kind: "unresolved" };
export interface ResolveContext { files: ReadonlySet<string>; tsPaths: Record<string, string[]>; baseUrl: string | null; workspacePackages: Record<string, string>; }
```

## 4. Narrator (`packages/jev-router`, lane 05)

```ts
// src/narrator/types.ts
export interface ComponentBrief { id: string; name: string; rootPath: string; roleGuess: Role; files: string[]; exports: string[];
  externalDeps: string[]; edgesIn: { name: string; count: number }[]; edgesOut: { name: string; count: number }[]; blurb: string | null; }
export interface DescribedComponent { id: string; purpose: string; role: Role; citations: Citation[]; }
export type SessionDecisionStatus = "open" | "answered" | "delegated" | "expired";
// Lane 07: `answer` is the chosen option's label (null while open); `tests.stepId` is the latest settled run (key t1).
export interface SessionStoryInput { prompt: string; recentSteps: { id: string; headline: string }[];
  decisions: { id: string; title: string; status: SessionDecisionStatus; answer: string | null }[];
  tests: { passed: number; failed: number; stepId: string } | null; touchedComponents: { id: string; name: string }[]; }
// Lane 07: `chosenBy` is "agent" for a delegated decision.
export interface DecisionWhyInput { decisionId: string; title: string; options: { id: string; label: string }[]; answer: string;
  chosenBy: "developer" | "agent"; nearby: { id: string; kind: "message" | "step"; text: string }[]; }
export interface NarratorClient {
  describeComponents(batch: ComponentBrief[]): Promise<JevResult<DescribedComponent[]>>;     // batch ≤ 20
  overviewNarrative(input: { components: { id: string; name: string; role: Role; purpose: string | null }[]; edges: { from: string; to: string; count: number }[] }): Promise<JevResult<NarrativeSentence[]>>;
  sessionStory(input: SessionStoryInput): Promise<JevResult<NarrativeSentence[]>>;           // phase C
  decisionWhy(input: DecisionWhyInput): Promise<JevResult<NarrativeSentence>>;               // phase C
}
export const NARRATOR_MODEL = "claude-haiku-4-5-20251001";
export const NARRATOR_TIMEOUT_MS = 10_000;

// src/narrator/guardrails.ts — pure
export interface CitationUniverse { components: ReadonlySet<string>; files: ReadonlySet<string>; decisions: ReadonlySet<string>; facts: ReadonlySet<string>; steps: ReadonlySet<string>; componentNames: ReadonlySet<string>; }
export interface GuardResult<T> { accepted: T; dropped: number; total: number; discarded: boolean; reasons: string[]; }
export function guardSentences(sentences: unknown, universe: CitationUniverse, opts: { max: number }): GuardResult<NarrativeSentence[]>;
export function guardComponents(described: unknown, universe: CitationUniverse, batchIds: readonly string[]): GuardResult<DescribedComponent[]>;
export const PLAIN_TEXT_REJECT = /https?:\/\/|```|<\/?[a-z][^>]*>|\*\*|__|^#{1,6}\s/im;

// src/narrator/client.ts
export interface NarratorClientOptions { model?: string; timeoutMs?: number; now?: () => number }
export function createNarratorClient(transport: NarratorTransport, options?: NarratorClientOptions): NarratorClient;
export function createFakeNarratorClient(script: Partial<Record<keyof NarratorClient, unknown[]>>): NarratorClient; // tests
```

`NarratorTransport` (`{ complete(request): Promise<NarratorTransportResponse> }`, `src/narrator/types.ts`) is the narrator's own provider seam; `TypeSafeTransport` is not used by the narrator.

Lane 07 (fix wave I-1): the desktop builds both inputs with every free-text field (prompt, headlines, titles, labels, answers, component names, nearby text) already passed through the Jev stage's `redactText`; ids are never redacted, so the guards check the ids the session holds.

## 5. Explainer stage (`apps/desktop/src/main/pipeline/explainer-stage.ts`, lanes 04, 05 and 07)

```ts
export interface ExplainerStageDeps {
  db: JevcodeDb; repoRoot: string; sessionId: () => string | null;
  narrator: NarratorClient | null;          // null when explainWithModel is false
  scan: typeof scanRepo; extract: typeof extractImports;
  emitRowsAvailable(sessionId: string, lastSeq: number): void;
  now(): number; schedule: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void };
  log(event: ExplainerLogEvent): void;
  explainWithModel?(): boolean;                          // preference; false writes narrator "off"; absent reads as on
  storyIntervalMs?: number;                              // min time between story narrations; default 20,000 ms
}
export interface ExplainerStage {
  onRepoOpened(): void;                                  // starts or refreshes the scan (lane 04)
  onSessionStarted(sessionId: string): void;             // writes the current snapshot row (lane 04)
  onFilesChanged(paths: readonly string[]): void;        // incremental rebuild (lane 04)
  onPipelineSync(sync: { sessionId: string; lastSeq: number; changeUnits: ChangeUnit[]; decisions: Decision[] }): void; // story/highlights triggers (lane 07)
  rescan(): void;                                        // overview:rescan (lane 04)
  dispose(): void;
}
export function createExplainerStage(deps: ExplainerStageDeps): ExplainerStage;
export type ExplainerLogEvent =
  | { kind: "scan"; files: number; partial: boolean; ms: number }
  | { kind: "narrator"; question: "describeComponents" | "overviewNarrative" | "sessionStory" | "decisionWhy"; ms: number; accepted: number; dropped: number; discarded: boolean; error?: string }
  | { kind: "snapshot"; components: number; edges: number; bytes: number };
```

Lane 04 creates the stage with the scan, snapshot and row-write paths and a `narrator` hook that is a no-op. Lane 05 implements `narrate*` helpers in `explainer-narration.ts`, which the stage calls. Lane 07 adds `onPipelineSync` handling. Each owning lane appends its part; files are split so the lanes do not edit the same function bodies.

## 6. Viewer (`packages/trace-viewer`, lanes 02, 06 and 07)

### 6.1 Source and controller (lane 02)

```ts
// src/source.ts — TraceSource gains an optional member:
onRowsAvailable?(listener: (lastSeq: number) => void): () => void;
// src/ui/shell/data-controller.ts: when source.onRowsAvailable exists, a hint with lastSeq > cursor
// triggers poll(generation) immediately and resets the poll timer; at most one poll in flight.
```

### 6.2 Views, host and chrome (lane 02)

```ts
// src/ui/state/view-state.ts
export type ViewKind = "console" | "canvas" | "hybrid" | "map" | (string & { readonly __host?: true });
// built-in kinds: "console" | "canvas" | "hybrid" | "map"; host views use their own string kind (e.g. "surfaces").

// src/ui/shell/TraceViewer.tsx — TraceViewerProps gains:
chrome?: "full" | "embedded";            // default "full"
hostViews?: readonly ViewDefinition[];   // appended after the built-in views
initialView?: ViewKind;                  // default: "console" when chrome === "embedded", else "hybrid" (unchanged)
renderSwitch?: (switcher: ReactNode) => void;  // embedded only: lets the host place the view switcher; see §6.4
// ViewerHost (src/ui/shell/host.ts) gains, all optional:
answerDecision?(request: { decisionId: string; optionId: string }): void | Promise<void>;
openTraceWindow?(): void;
rescanOverview?(): void;

// src/ui/views/registry.ts — VIEWS becomes:
[{ kind: "console", label: "Console", icon: "view-console", Component: ConsoleView },
 { kind: "canvas",  label: "Canvas",  icon: "view-canvas",  Component: CanvasView },
 { kind: "hybrid",  label: "Hybrid",  icon: "view-hybrid",  Component: HybridView },
 { kind: "map",     label: "Map",     icon: "view-map",     Component: MapView }]   // map added by lane 06
// keys: 0 console, 1 canvas, 2 hybrid, 3 map, 4.. host views in order (spec §3.7, §8.6)
```

### 6.3 Console (lane 02)

```ts
// src/layout/console-rows.ts — pure, React-free
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
  | { kind: "summary"; key: string; sentences: NarrativeSentence[]; provenance?: "rule" | "model" };     // phase C (lane 07)
export function buildConsoleRows(session: TraceSession, index: TraceIndex, prev?: ConsoleRowsState): ConsoleRowsState;
export interface ConsoleRowsState { rows: readonly ConsoleRow[]; byStep: ReadonlyMap<string, number>; }
// src/ui/views/console/ConsoleView.tsx — registered as kind "console"
```

### 6.4 Brief (lanes 02 → 06 → 07)

```ts
// src/layout/brief.ts — pure
export interface BriefModel {
  now: { kind: "rule"; runningStepId: string | null; latestUnitId: string | null; pendingDecisionId: string | null }
     | { kind: "story"; sentences: NarrativeSentence[]; basisSeq: number; provenance?: "rule" | "model" };  // story added by lane 07
  changes: { unitId: string; title: string; added: number; removed: number; tests: { passed: number; failed: number } | null; attention: boolean }[];
  architecture: { overviewSentences: NarrativeSentence[] | null; componentCount: number; touched: string[]; scanning: { done: number; total: number } | null } | null; // lane 06
}
export function buildBrief(session: TraceSession, index: TraceIndex): BriefModel;
// src/ui/inspector/Brief.tsx — rendered by the Inspector region when selection is null; Shift+B toggles; Esc from a selection returns to it
```

### 6.5 Model additions (lanes 06 and 07)

```ts
// src/model/types.ts — TraceSession gains:
overview: OverviewModel | null;       // lane 06; latest snapshot, components keep identity by id+contentHash
explainer: ExplainerModel;            // lane 07; { story: {sentences, basisSeq} | null; decisionWhy: ReadonlyMap<string, NarrativeSentence>; highlights: {basisSeq, byComponent: ReadonlyMap<string, {state, unitIds}>} | null }
export interface OverviewModel { snapshot: OverviewSnapshot; componentById: ReadonlyMap<string, Component>; seq: number; }
```

### 6.6 Map (lane 06)

```ts
// src/layout/map-layout.ts — pure, React-free
export const MAP_BAND_ORDER: readonly (Role | "side")[] = ["ui", "api", "agent", "domain", "storage", "side"]; // side = tests, tooling, config
export interface MapCard { id: string; band: Role | "side"; x: number; y: number; w: number; h: number; }
export interface MapEdgePath { from: string; to: string; count: number; width: 1 | 2 | 3; d: string; }
export interface MapLayout { cards: readonly MapCard[]; edges: readonly MapEdgePath[]; externals: readonly { name: string; x: number; y: number; nearComponent: string }[]; bounds: { w: number; h: number }; state: MapLayoutState; }
export interface MapLayoutState { orderByBand: ReadonlyMap<string, readonly string[]>; repoRoot: string; }
export type MapLevel = "chip" | "card" | "detail";
export function layoutMap(overview: OverviewModel, opts: { level: MapLevel }, prev?: MapLayoutState): MapLayout;
// src/ui/views/map/MapView.tsx — registered as kind "map"
```

## 7. Desktop renderer (lane 03)

```ts
// apps/desktop/src/renderer/trace/ipc-source.ts — createIpcTraceSource gains onRowsAvailable via bridge.trace.onRowsAvailable
// apps/desktop/src/renderer/workspace/EmbeddedWorkspace.tsx
export function EmbeddedWorkspace(props: { sessionId: string }): JSX.Element;   // <TraceViewer chrome="embedded" initialView="console" hostViews={[surfacesView]} host={mainHost}/>
// apps/desktop/src/renderer/workspace/PromptDock.tsx — the composer docked under every view (keeps the D-5 composerReducer)
// apps/desktop/src/renderer/workspace/surfaces-view.tsx — ViewDefinition { kind: "surfaces", label: "Surfaces", icon: "view-surfaces", Component }
// apps/desktop/src/shared/api.ts — bridge.trace.onRowsAvailable(listener: (p: { sessionId: string; lastSeq: number }) => void): () => void
```

## 8. Planning amendments (binding; they supersede §1–§7 where they conflict)

The lane files were drafted against the real code, and some names above had to change. Each lane file lists its own deviations at the top; this section records the ones that cross lanes. The orchestrator's rulings are R1–R6.

### 8.1 Contracts and storage (lane 01)

- R1. The storage class is `JevcodeDb`.
- The IPC channels are `MainToRendererChannels.traceRowsAvailable` (strict payload `{sessionId, lastSeq}`) and `RendererToMainChannels.overviewRescan`.
- The preference key is `"explainer.withModel"` in `AgentPreferences`, read through `readAgentPreferences`.
- R3. `OverviewSnapshotSchema` gains `status?: OverviewStatus` and `counts.totalFiles?`:

  ```ts
  OVERVIEW_SCAN_STATES = ["running", "done", "failed"]
  NARRATOR_STATES = ["off", "unavailable", "pending", "ready"]
  OverviewStatus = {
    scan: { state; scanned; total; error?: string /* ≤ 200 */ };
    narrator: NarratorState;
  }
  ```

  A row without `status` reads as scan done, with narrator `pending` if any purpose is null and `ready` otherwise.
- Snapshot size is counted in UTF-8 bytes of the JSON (`TextEncoder`).
- Lane 07 (S-5 fix round 1): a `highlights` entry is `{ id; state; states?; unitIds }`. `states?` lists 1 to 4 of `new | changed | decision | failing` and is written only when more than one applies; `state` stays the strongest. A row without `states` reads as `[state]`.
- K-2 string caps (`overview.ts`): paths (`rootPath`, `files[]`, `entryPoints[]`, `repoRoot`) 1–1,024; snapshot `sessionId` 0–256 (empty allowed); explainer `sessionId`, `scanId`, `decisionId`, `unitIds[]` 1–128; `languages[]` ≤ 40; `generatedAt` ≤ 64; `externalDeps[].name` 1–214; component ids, edge `from`/`to`, `usedBy[].componentId` and highlight ids match `cmp_` + 12 lowercase hex.

### 8.2 Narrator (lane 05)

- R2. The transport is `@anthropic-ai/sdk` with `ANTHROPIC_API_KEY` and `NARRATOR_MODEL`. With no key the narrator makes no calls and reports `unavailable`.
- Methods return `NarratorResult<T>`, which is `JevResult<T>` plus `model`, `ms` (latency), `usage` and `schemaValid`. They take an optional `AbortSignal` and reject with `NarratorUnavailableError`.
- `decisionWhy` returns `NarrativeSentence | null`.
- `CitationUniverse.componentNameById?` is added.
- `createFakeNarratorClient` records the calls it receives.
- Calls are logged to an in-memory ring behind `debug:listNarratorCalls`, with a Narrator tab in Inspect.
- Every caller (lane 05's overview calls, lane 07's session calls) builds its call record with `buildNarratorCallRecord(facts)` from `apps/desktop/src/main/pipeline/narrator-call-log.ts`. It caps `model` and `error` at `NARRATOR_RECORD_TEXT_MAX` and `reasons` at 40, and returns `null` for a record that still fails `NarratorCallRecordSchema`. The ring and `debug:listNarratorCalls` drop any record that fails the schema, one record at a time.

### 8.3 Explainer stage (lanes 04, 05, 07)

- R4. The stage has no `deps.narrator`. Narration plugs in through `narration?: (ctx: NarrationContext) => NarrationSeam`, which defaults to `NO_NARRATION`.
  - `NarrationSeam` is `{ textFor; narrative; onSnapshot; dispose; setNarrator?; narratorStatus? }`.
  - Lane 05 builds the seam with `createNarrationSeamFactory`.
  - Lane 05 adds `ExplainerStage.setNarrator`, `ExplainerStageDeps.initialNarrator?`, `briefSources?` and `recordNarratorCall?`.
  - Lane 07's session explainer reads `initialNarrator` and follows `setNarrator`.
- Lane 04 adds the deps `scanPaths` and `onStatus?` and the methods `status()` and `whenIdle()`. `ExplainerLogEvent` gains an `error` variant with a `where` field (lane 07 adds `"session"`).
- The explainer registry is `createExplainerRegistry`; `IpcDeps.explainer`; `PipelineRuntimeOptions.onRepoFilesChanged`. Lane 07 adds `onPipelineSync(sync)` on `ExplainerStage`; the registry has no such method, and `index.ts` routes `explainerRegistry.get(repoPath)?.onPipelineSync(sync)` from the pipeline's `onPipelineSync(repoPath, sync)` option.
- `extractImports` also returns `exports`. `ScanResult` gains `totalFiles` and `tsconfig`. `ComponentDraft.importsAnalyzed` is added.
- The `overview:rescan` handler (lane 04) rejects any repo root other than the open repo.
- Lane 07 fix wave I-2: the `session:switch` handler calls `ExplainerRegistry.sessionSwitched(repoRoot)` through `toExplainer`; the registry forwards it to the open repo's `ExplainerStage.onSessionSwitched()`, which forwards it to `SessionExplainer.onSessionSwitched()`. The session explainer keeps the latest unprocessed sync of each session (one entry per session) and processes the open session's entry, so a session that finished while another one was open gets its final story, whys and highlights.

### 8.4 Viewer (lanes 02, 06, 07)

- **Location and keys.** `ViewerLocation.view` is optional and accepts any lower-case kind; `InitialViewStateInput.view?` is added. R5: key `0` is Console, and zoom to preset moves to Shift+0. Shift+B toggles the Brief (`keymap.ts`; plain B brushes the chapter in Hybrid).
- **View state.** `ViewState.brief` with action `brief/toggle`. `ViewState.mapSelection` with action `map/select`; Esc on the Map clears the selection first. Lane 06 fix wave: selecting a step or unit (any `select`, `nav`, search or `nav/first`/`nav/last`) clears `mapSelection` (I-1); on the Map, `brief/toggle` pins the Brief over a selected component and `map/select` unpins it (minor 3).
- **Exports and icons.** The viewer exports `useView`, `useDispatch`, `useSessionView`, `ViewDefinition`, `ViewProps`, `ViewKind` and `IconName`. New icons: `view-console`, `view-map`, `view-surfaces` and `brief`.
- **Host and chrome.** `ViewPort.toggle?` and `ViewerHostContext` / `useViewerHost` are added. Embedded chrome also hides the Outline.
- **Push hints.** `HINT_COMMIT_GAP_MS = 50`, and hints are ignored while reconnecting. `StaticBundleSource.onRowsAvailable` is added.
- **Map and model.**
  - Lane 06 replaces lane 02's `MapPlaceholder` in `VIEWS`.
  - `MapLayout` gains `level` and `bands`. `MapBandColumn` is `{ band, x, w, count }`; `MapLevelSpec` is `{ w, h, rowGap, gutter, sideW, chips: 0 }` with one shared geometry for all three levels.
  - `MapEdgePath` gains `kind: "adjacent" | "long" | "same"` (`MapEdgeKind`); additive to §6.6.
  - `src/layout/map-layout.ts` also exports `mapHubIds(layoutEdges, componentCount): ReadonlySet<string>` (components with at least `max(6, ceil(n / 4))` distinct importers), `mapImporterCounts(layoutEdges): ReadonlyMap<string, number>`, `MAP_MARGIN` (16), `MAP_BAND_LABEL_H` (44), `MAP_LANE_PAD` (6, view only) and `MAP_SWEEPS`. `layoutMap` places no external chips (`externals` is always `[]`).
  - Zoom bands are `chip` < 0.7 ≤ `card` < 1.4 ≤ `detail` (`mapLevelForZoom`); `map-camera.ts` has `MAP_FIT_PADDING` (`{ x: 20, top: 20, bottom: 68 }`) and `MAP_ICON_ONLY_K` (0.48), and `planMapFit(overview, viewport, layouts?)` makes at most one layout.
  - Lane 06 fix wave I-2: `map-layout.ts` exports `MapLayoutCache` and `createMapLayoutCache()` (one card-level layout per overview object, chained per repo). Each viewer holds one cache through `MapLayoutCacheContext` / `useMapLayouts()` (`src/ui/views/map/map-layouts.ts`), shared by the Map, its Fit and the Brief thumbnail. `layoutMap` treats a `prev` with no placed cards as no `prev`.
  - `src/ui/views/map/MapEdges.tsx` exports `MAP_EDGE_STROKE` (1, 1.6, 2.4 px) and `hubStubPath`; `map-text.ts` exports `linkSentence`; `MapHeader` gains the optional props `selectedId` and `onHoverComponent`.
  - The `role-*` icons gain `fan-in` (the hub glyph). `src/layout/map-details.ts` exports `topPackages`, `fileBarPercent`, `listBarPx` and `LIST_BAR_MAX_PX`.
  - `buildOverviewModel` and `overviewStatusOf` are exported.
  - R6: lane 06's P-1 creates `src/model/component-path.ts` with `componentIdForPath`, and lane 07 consumes it. The rule: the component that lists the file, then the longest whole-segment root; an unclaimed root-level path (no `/`) goes to `"."` (else to `"(other)"`), an unclaimed nested path to `"(other)"` when the snapshot has one; otherwise null. `"."` holds root-level files only, so a nested path never resolves to it, and every caller tolerates null (lane 06 fix wave I-3).
  - Lane 07 fills the `mapOverlayOf` seam in `ui/views/map/overlay.ts`.
- **Lane 02b additions (fix wave, binding for lanes 03, 06 and 07).**
  - `ConsoleRow` gains `{ kind: "guardrails"; key: "guardrails:<first finding id>"; stepIds; findingIds; findingStepIds }`: consecutive warning guardrail-clamp flag lines fold into one "Jev review · n guardrails" row; a warning flag line is keyed `guardrails:<finding id>` from the start; critical findings never fold. `consoleRowStepIds(row)` covers every kind; read a row's anchor through it.
  - `consoleNewRowCount(state, index, afterSeq)` (`src/layout/console-rows.ts`): the Console's "N new" counts rows. `NewBadge` gains `noun?: "step" | "row"`. `ViewPort.newCount?(): number` gives the title bar the active view's count.
  - `ViewState.revealRev`: +1 when the Outline or the Brief picks the already-selected item; views reveal on it.
  - `ViewPort.goToTail?(): boolean`: in the Console, `G`, the "N new" pills and the title bar's Live go Live at the tail without selecting (the Brief stays; a selection is kept). Hybrid and Canvas keep `nav/last`.
  - `displayUntrusted` tokenizes `[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]` except a tab and, with `{ multiline: true }`, `\n`; emoji clusters and keycaps render as themselves.
  - `showsBrief(state)` (`src/ui/inspector/RightPanel.tsx`); the right panel's aside is labelled after its content; `HarnessOptions.host?: ViewerHost` in the test harness.
- **Lane 07 additions.**
  - Model and layout: `ExplainerModel.stories` and the story and highlight `seq` fields; `HighlightEntryModel.states` (always set, in `HIGHLIGHT_STATES` order); `BriefModel.decisions`; `ConsoleRowsState.base?` and `stories?`; `resolveCitation`; `truncateEnd(text, maxGraphemes)` (`src/model/format.ts`, cuts the end and calls `displayUntrusted`).
  - Map: `MapOverlay.cardState` is `ReadonlyMap<string, readonly MapCardState[]>` (every state of a card, in drawing order); `MapCardProps.states` (an array or null) replaces `state`; `MapHeaderProps.session?` (`{ counts, on, onToggle }`, the Session toggle and legend).
  - Brief: `BriefViewProps.onAnswer`, `answers?` (each decision's `AnswerState`) and `mapSession?` (`BriefMapSession`, `src/ui/inspector/BriefMapSession.tsx`: on the Map the last part lists "This session" and a row selects the component).
  - Answers: the shell's shared decision answer store in `src/ui/shell/decision-answers.ts`: `AnswerState`, `createDecisionAnswerStore()`, `DecisionAnswersContext` and `useDecisionAnswers()`. The Console's decision block and the Brief's cards share one store per viewer.
  - Summary blocks and decision cards are named groups (`role="group"`), not region landmarks (fix wave minor 3).
  - Desktop (PL-3): `createMainSlicer`, `MainSlicer` and `MAIN_SLICE_MS` (`apps/desktop/src/main/pipeline/main-slicer.ts`), passed as `slicer?` to `PipelineRuntimeOptions`, `ExplainerStageDeps` and `SessionExplainerDeps` (with `foldSliceMs?`); index.ts gives the three one instance.
  - Storage (PL-3): `JevcodeDb.projectionVersion(type)`, `listChangeUnitVersions(sessionId)`, and `listGraphNodes` / `listGraphEdges` in rowid order (`ORDER BY rowid`); `buildSessionState` takes an optional `changeUnitCount`.
  - Quit path: `PipelineRuntime.shutdown()` and `quitSteps(services)` (`apps/desktop/src/main/shutdown.ts`), which runs pipeline sessions, rows available, explainer, import extractor, terminals, trace reader and then the database; `PipelineCoordinator.dispose()` (semantic-core) cancels a debounced rebuild, and `shutdown()` calls it for every session (fix wave).
- **Fixtures** for the viewer live in `packages/trace-viewer/fixtures/`.

### 8.5 Desktop renderer (lane 03)

- `EmbeddedWorkspace` takes `{ sessionId, repoRoot, onRequestChanges(text) }`, where `repoRoot` is `string | null`.
- New files: `workspace/main-host.ts` and `workspace/session-surfaces.ts`.
- `JevcodeApi.overview.rescan(repoRoot)` is added.
- The main window answers a decision with `answer_decision` and `{decisionId, decision: {decision: optionId}}`, and main checks that `optionId` is one of the decision's options.
- Push delivery uses `TraceWindowRegistry.sendersForSession` and `isPushAllowed`, so trace windows also receive `trace:rowsAvailable`.
- R5: a session switch opens on Console, and there is no per-window view memory.
