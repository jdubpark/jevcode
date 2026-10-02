# Console and explainer Lane 01: Contracts and storage — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every later lane the data contracts it builds on: two new event types (`overview_snapshot`, `explainer`) carried through storage, `trace:rows` and `trace.json` (bundle v2, v1 still readable); the overview and explainer zod schemas; the `trace:rowsAvailable` push hint, the `overview:rescan` request and the `explainWithModel` preference; and SQLite migration v5 with the narrator cache and overview state.

**Architecture:** `packages/contracts` owns the names and schemas (`src/trace.ts`, new `src/overview.ts`, `src/ipc.ts`). `packages/storage` validates the new rows in `appendEvent` through `eventStoreSchemas`, enforces the 512 KB snapshot cap at append, and adds `component_text_cache` and `overview_state` with four `JevcodeDb` methods. `TraceReader` and the bundle export need no code change: they follow `TRACE_ROW_TYPES` and `TRACE_BUNDLE_VERSION`. The viewer's bundle parser (`parseTraceBundle`) accepts v1 and v2. The desktop preference lives with the existing agent preferences (`apps/desktop/src/shared/prefs.ts`).

**Tech Stack:** TypeScript 5.7 (NodeNext, strict, `noUncheckedIndexedAccess`, `noUnusedLocals`, `verbatimModuleSyntax`), zod 3, better-sqlite3 11, vitest 3, fast-check 4.10.1 (contracts only), pnpm 9.15 workspaces.

**Spec:** `docs/superpowers/specs/2026-10-02-console-and-explainer-design.md` §7 (contracts, storage, IPC), §5.5 (snapshot caps), §6.4 (cache), §6.5 (rows), §10 (export redaction), E15 (setting). **Interfaces (binding):** `docs/superpowers/plans/2026-10-02-console-explainer-interfaces.md` §1 and §2. **Index:** `docs/superpowers/plans/2026-10-02-console-explainer-00-index.md` (tasks K-1 to K-4, wave W0).

## Interface deviations

Every name in interfaces §1 and §2 is kept. These points follow the real code; each must be read by the consuming lane.

1. **`Db` is `JevcodeDb`.** Interfaces §2 says "`Db` methods" and §5 types `ExplainerStageDeps.db: Db`. The storage class is `JevcodeDb` (`packages/storage/src/db.ts:226`, exported from `@jevcode/storage`). The four methods are added to `JevcodeDb`; lane 04 types `db: JevcodeDb`.
2. **Channel keys and placement (K-3).** Both channels go in `packages/contracts/src/ipc.ts`, so the desktop registry (`apps/desktop/src/shared/ipc-registry.ts`, which spreads the contract maps) picks them up without an edit:
   - `MainToRendererChannels.traceRowsAvailable = "trace:rowsAvailable"`, payload `TraceRowsAvailablePayloadSchema` (`{ sessionId: string; lastSeq: number }`, `.strict()`).
   - `RendererToMainChannels.overviewRescan = "overview:rescan"`, payload `OverviewRescanPayloadSchema` (`{ repoRoot: string }`).
   - `.strict()` on the hint: `sendToRenderer` (`apps/desktop/src/main/ipc.ts:93`) validates and then sends the caller's original object, so zod's key stripping would not stop extra keys from leaving main. Strict parsing makes "carries no content" (spec §10) enforceable.
   - Trace windows are denied `overview:rescan` by the existing rule in `apps/desktop/src/main/trace-allowlist.ts` (only `TRACE_WINDOW_CHANNELS` pass); no allowlist edit is needed.
   - K-3 registers no main-process handler for `overview:rescan` (lane 04 M-6) and no emitter or preload member for the hint (lane 03 D-1).
3. **The preference lives in the desktop app, not in contracts.** No preference contract exists in `packages/contracts`. K-3 extends `AgentPreferences` (`apps/desktop/src/shared/prefs.ts`) with `explainWithModel: boolean` (default `true`), stored under the new key `EXPLAIN_WITH_MODEL_PREF_KEY = "explainer.withModel"`, and extends `AgentPreferencesSchema` and `PreferencesSetPayloadSchema` (`apps/desktop/src/shared/local-channels.ts`). It also persists the field in the existing `preferences:set` handler (`apps/desktop/src/main/ipc.ts:236-245`); without that line the setting would not survive a round trip. The settings UI stays in lane 05 N-4.
4. **K-1 touches two exhaustive maps outside contracts.** `eventStoreSchemas` (`packages/storage/src/db.ts:59-74`) and `ENVELOPE_RULES` (`packages/trace-viewer/src/model/registry.ts:38-53`) are typed over every `EventStoreType`, so adding the event types breaks both typechecks. K-1 therefore:
   - maps both types to a `z.never()` placeholder in storage (storage refuses both rows until K-4 swaps in the real schemas);
   - marks both types `"consume"` in the viewer. `accumulate` (`packages/trace-viewer/src/model/fold.ts:110-139`) sends consumed types without a `case` to its `default` branch, which counts them in `hidden`. Lane 06 P-1 and lane 07 S-3 add the `case`s.
5. **Additive exports:** `OVERVIEW_SCAN_STATES`, `NARRATOR_STATES`, `NarratorState`, `OverviewStatusSchema`, `OverviewStatus`, the optional `OverviewSnapshot.status` and `counts.totalFiles` (orchestrator ruling R3, K-2); `TRACE_BUNDLE_VERSIONS_SUPPORTED` (interfaces §1.1, listed); `TraceRowsAvailablePayload`, `OverviewRescanPayloadSchema`, `OverviewRescanPayload` (contracts); `EXPLAIN_WITH_MODEL_PREF_KEY`, `normalizeExplainWithModel` (desktop `shared/prefs.ts`); the types `ComponentTextValue` and `OverviewStateValue` (storage, the inline types of interfaces §2 given names).
6. **Cache method behavior** (interfaces §2 gives only signatures):
   - `put*` validate their input with the contract schemas and throw `TypeError` on invalid values.
   - `putOverviewState` also throws when `state.snapshot.repoRoot !== repoRoot`.
   - `get*` return `undefined` for a stored row this build cannot parse (corrupt JSON, a role outside `ROLES`). These tables are caches, so an unreadable row reads as a miss.
7. **Snapshot byte cap basis.** `OVERVIEW_SNAPSHOT_MAX_BYTES` (524,288) is compared with the UTF-8 byte length of `JSON.stringify(parsed payload)`, which is exactly what `appendEvent` stores in `events.payloadJson`. Lane 04's `assembleSnapshot` must measure the same way. In `src/core` it has no `Buffer`, so it uses `new TextEncoder().encode(JSON.stringify(snapshot)).length`, which gives the same count, including U+FFFD for lone surrogates.

   The optional `status` (ruling R3) counts toward the cap. Its fixed keys, two numbers and an `error` of at most 200 characters (at most 800 UTF-8 bytes) add under 1 KB. Scan-progress snapshots carry the previous components, so they are measured and capped like every other snapshot. `assembleSnapshot` budgets `status` and `counts.totalFiles` before it trims components.
8. **`trace:payloads` does not filter by type.** Interfaces §2 says TraceReader "filters on `TRACE_ROW_TYPES`". Only `rows()` filters; `payloads()` returns rows of any type for the requested seqs (`packages/storage/src/trace-reader.ts:38-39`). Both return the new rows, so nothing changes.

## Spec alignment notes

- **`overview_state` columns.** Spec §4.2/§7 lists `overview_state(repo_root, snapshot_json, updated_at)`. This lane follows interfaces §2, which adds `narrative_inputs_hash` and `narrative_json` (spec §6.4 says the narrative is stored there and reused while its inputs hash is unchanged).
- **Redaction can lengthen capped strings (ruling F16: K-4 owns the fix).** Bundle export runs `redactText` over every string (`apps/desktop/src/main/trace-bundle.ts`). A short secret becomes `[REDACTED:token]`, so a 129-character purpose such as `… token=ab` grows past the 140-character `ComponentSchema.purpose` cap, and a sentence near 220 characters, an edge example near 300 or a long name can overflow the same way. A row over a cap would fail the viewer's schema parse and become an `invalid_row` gap. K-4 re-caps the redacted strings of `overview_snapshot` and `explainer` rows in `buildTraceBundle` to the K-2 schema limits (truncating, so the secret stays redacted), with a regression test.
- **v1 bundles with new row types.** Spec §7 says "a v1 bundle simply has no new rows". `TraceRowSchema.type` is any non-empty string (forward compatibility), so a v1 bundle that does carry such a row still parses. No rule is added.
- **Push-hint audience.** Spec §7 sends `trace:rowsAvailable` "to every window whose viewer shows that session (main window and trace windows)". The current `sendToRenderer` reaches only the main window. Lane 03 D-1 must add delivery to trace windows.
- **Snapshot `sessionId` in `overview_state`.** The cached snapshot keeps the `sessionId` of the session that built it. A writer that appends it for another session must restamp `sessionId` first, or `appendEvent` rejects it (payload `sessionId` must match).
- **`docs/SPEC.md` §4.5** lists the contract channels; `packages/contracts/src/ipc.test.ts` pins that list. K-3 adds the two channels to the test with a comment that cites this spec. `docs/SPEC.md` is not edited by this lane.

## Lane prerequisites

- **Wave:** W0, from `main`. Lane 02a runs beside this lane. It edits `packages/trace-viewer/src/source.ts`, `src/ui/**` and `src/ui/state/**`, none of the files below except `packages/trace-viewer/src/sources/static-bundle.ts` (K-1 changes `parseTraceBundle`; V-1 changes `StaticBundleSource`). W0 merges 01 first, then 02a, whose rebase step keeps both edits.
- **Plan documents:** if `git -C /Users/jwpark/Projects/jevcode ls-files docs/superpowers/plans/2026-10-02-console-explainer-00-index.md` prints nothing, the plan files are untracked in the main checkout. Read them by absolute path and never commit them from this lane.
- **Worktree** (once):

```bash
git -C /Users/jwpark/Projects/jevcode worktree add -b ce/01-contracts /Users/jwpark/Projects/jevcode-ce-01 main
bash /Users/jwpark/Projects/jevcode/.superpowers/orchestration/setup-worktree.sh /Users/jwpark/Projects/jevcode-ce-01
```

Expected: the second command prints `/Users/jwpark/Projects/jevcode-ce-01: setup ok at <sha>`. Every later command runs from `/Users/jwpark/Projects/jevcode-ce-01`. Prefix each command with `cd /Users/jwpark/Projects/jevcode-ce-01 && ` if your shell does not keep the directory.

- **Baseline** (before K-1), one package per call:
  - `pnpm --filter @jevcode/contracts test`
  - `pnpm --filter @jevcode/storage test`
  - `pnpm --filter @jevcode/trace-viewer test`
  - `pnpm --filter jevcode-desktop test`
  
  Each exits 0. `stall-watchdog.test.ts`, `codex-adapter.test.ts` and `file-watcher.test.ts` are the known flakes; they must pass when rerun alone.

## Global Constraints

The index Global Constraints apply. Lane-specific additions:

- **Package names and scripts** (from each `package.json`):
  - `@jevcode/contracts`, `@jevcode/storage`, `@jevcode/trace-viewer`: `build`, `typecheck`, `test`.
  - `jevcode-desktop`: `build`, `typecheck` (main, preload and web tsconfigs), `test`, `run rebuild:node`.
  - Root: `perl -e 'alarm 170; exec @ARGV' pnpm lint` runs `pnpm exec eslint .`.
- **Every package imports workspace packages from `dist`.**
  - After any change under `packages/contracts/src`, run `perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/contracts build` before testing storage, the viewer or desktop.
  - After a storage change, run `perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/storage build` before testing desktop.
  - After a viewer `src/sources` change, run `perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/trace-viewer build` before testing desktop.
- **Native ABI.** If a storage or desktop test fails with `NODE_MODULE_VERSION`, run `pnpm --filter jevcode-desktop run rebuild:node`, then rerun. Never run `pnpm --filter jevcode-desktop rebuild`: the pnpm builtin wipes node-pty.
- **No new dependency** and no `package.json` or `pnpm-lock.yaml` change. fast-check is available in `packages/contracts` only, so storage tests use explicit boundary values.
- **Only files listed in a task's Files block may change.** `docs/SPEC.md`, `eslint.config.mjs` and `fixtures/**` are out of bounds.
- **Hang safety.** Every vitest call is `perl -e 'alarm 150; exec @ARGV' pnpm --filter <pkg> exec vitest run <file>`. Run root checks one package per call.
- **Commits.**
  - One conventional commit per task, listing its files in `git add`.
  - Identity `Jongwon Park <contact@parkjongwon.com>`; add `-c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com` to `git commit` if the worktree config differs.
  - No `Claude-Session:` or `Co-Authored-By` trailers.
  - Never `git stash`, `git reset --hard` or `git clean`.

## Review Focus

The index assigns none of its five Review Focus items to lane 01. These lane-local failure modes are the ones a happy-path test would miss; each has an owning test.

1. **An existing user database at schema v4.** The upgrade must add the two tables without touching existing rows, and appends must continue the session's seq. Test: **K-4** `db.test.ts` "upgrades a v4 database built by migrations 1-4 to v5 without touching its rows".
2. **An oversized snapshot.** A snapshot over 512 KB, or one that crosses the cap only because of multi-byte text, must be refused without consuming a seq. Test: **K-4** `explainer-store.test.ts` "enforces the 512 KB snapshot cap at append, counting UTF-8 bytes".
3. **A `trace.json` written by an older or newer build.** v1 and v2 must parse, v3 and other versions must report "not supported", and an exported v2 bundle must redact the new rows. Tests: **K-1** `static-bundle.test.ts`, `trace.test.ts`; **K-4** `trace-bundle.test.ts` "exports overview and explainer rows in a redacted v2 bundle".
4. **The push hint used to carry content.** Extra keys on `trace:rowsAvailable` must be refused. Tests: **K-3** `ipc.test.ts` (contracts) and `ipc-registry.test.ts` (desktop).
5. **Narrator setting lost or defaulted wrongly.** Missing or invalid stored values must read as on (E15), and an off switch must persist across `preferences:set`. Tests: **K-3** `prefs.test.ts`, `prefs-ipc.test.ts`, `ipc.test.ts` (main).

## File structure

| File | Responsibility | Task |
|---|---|---|
| `packages/contracts/src/trace.ts` | `EVENT_TYPES`, `TRACE_ROW_TYPES` gain two types; `TRACE_BUNDLE_VERSION = 2`; `TRACE_BUNDLE_VERSIONS_SUPPORTED`; bundle schema accepts 1 and 2 | K-1 |
| `packages/trace-viewer/src/sources/static-bundle.ts` | `parseTraceBundle` accepts the supported versions | K-1 |
| `packages/trace-viewer/src/model/registry.ts` | `ENVELOPE_RULES` marks both types `consume` | K-1 |
| `packages/storage/src/db.ts` | K-1 placeholder; K-4 schemas, cap, cache and state methods, projection no-op | K-1, K-4 |
| `apps/desktop/src/main/replay/cli-entry.ts` | Doc comment says v2 | K-1 |
| `packages/contracts/src/overview.ts` | Roles, citations, sentences, component, edge, external, overview status (R3), snapshot, explainer schemas, byte cap | K-2 |
| `packages/contracts/src/index.ts` | Re-exports `overview.js` | K-2 |
| `packages/contracts/src/ipc.ts` | `trace:rowsAvailable`, `overview:rescan` channels and schemas | K-3 |
| `apps/desktop/src/shared/prefs.ts`, `local-channels.ts` | `explainWithModel` preference and its IPC schemas | K-3 |
| `apps/desktop/src/main/ipc.ts` | `preferences:set` persists `explainWithModel` | K-3 |
| `packages/storage/src/migrations.ts` | Migration v5 | K-4 |
| `packages/storage/src/index.ts`, `fixtures.ts` | Type exports; snapshot and story fixtures | K-4 |

Tests: `packages/contracts/src/{trace,overview,ipc,browser-safety}.test.ts`, `packages/trace-viewer/src/sources/static-bundle.test.ts`, `packages/storage/src/{db,explainer-store,trace-reader}.test.ts`, `apps/desktop/src/main/{trace-bundle,ipc,trace-allowlist}.test.ts`, `apps/desktop/src/shared/{prefs,prefs-ipc,ipc-registry}.test.ts`.

Order: K-1 → K-2 → K-3 → K-4 on one branch (K-3 needs only K-1 but runs third).

---

### Task K-1: Event types `overview_snapshot` and `explainer`; bundle v2 parser

**Files:**
- Modify: `packages/contracts/src/trace.ts` (lines 6-21, 28-35, 93-103)
- Modify: `packages/trace-viewer/src/sources/static-bundle.ts` (lines 1-4, 15-24)
- Modify: `packages/trace-viewer/src/model/registry.ts` (lines 38-53)
- Modify: `packages/storage/src/db.ts` (line 8, lines 59-74)
- Modify: `apps/desktop/src/main/replay/cli-entry.ts` (line 30, comment only)
- Test: `packages/contracts/src/trace.test.ts`, `packages/trace-viewer/src/sources/static-bundle.test.ts`, `apps/desktop/src/main/trace-bundle.test.ts` (line 108)

**Interfaces:**
- Consumes: nothing new.
- Produces (from `@jevcode/contracts`):
  - `EVENT_TYPES`: the 14 existing types, then `"overview_snapshot"`, `"explainer"`.
  - `TRACE_ROW_TYPES`: the 6 existing types, then `"overview_snapshot"`, `"explainer"`.
  - `TRACE_BUNDLE_VERSION = 2`.
  - `TRACE_BUNDLE_VERSIONS_SUPPORTED = [1, 2] as const`.
  - `TraceBundleSchema.version`: `1 | 2`.
- Produces (from `@jevcode/trace-viewer/sources`): `parseTraceBundle(json)`. It accepts v1 and v2. Any other version returns `{ ok: false, code: "UNSUPPORTED_VERSION", message: "Trace format v<N> is not supported" }`.

- [ ] **Step 1: Write the failing tests**

In `packages/contracts/src/trace.test.ts`, replace the import block (lines 3-21) with:

```ts
import {
  EVENT_TYPES,
  EventStoreTypeSchema,
  TRACE_BUNDLE_FORMAT,
  TRACE_BUNDLE_VERSION,
  TRACE_BUNDLE_VERSIONS_SUPPORTED,
  TRACE_CLIP_CHARS,
  TRACE_LIST_SESSIONS_DEFAULT,
  TRACE_LIST_SESSIONS_MAX,
  TRACE_LIVE_POLL_MS,
  TRACE_PAYLOADS_MAX,
  TRACE_ROW_TYPES,
  TRACE_ROWS_PAGE_DEFAULT,
  TRACE_ROWS_PAGE_MAX,
  TraceBundleSchema,
  TraceRowSchema,
  TraceRowsPageSchema,
  TraceSessionSummarySchema,
  isTraceRowType,
} from "./trace.js";
```

Replace the tests "lists the fourteen event-log envelope types in storage order" and "serves exactly the six envelope types the fold consumes" (lines 42-75) with:

```ts
  it("lists the sixteen event-log envelope types in storage order", () => {
    expect(EVENT_TYPES).toEqual([
      "agent_event",
      "evidence_fact",
      "change_unit",
      "decision",
      "validation",
      "failure",
      "jev_decision",
      "ui_intent",
      "ui_snapshot",
      "graph_node",
      "graph_edge",
      "command",
      "semantic_event",
      "telemetry",
      "overview_snapshot",
      "explainer",
    ]);
    expect(EventStoreTypeSchema.safeParse("telemetry").success).toBe(true);
    expect(EventStoreTypeSchema.safeParse("overview_snapshot").success).toBe(true);
    expect(EventStoreTypeSchema.safeParse("explainer").success).toBe(true);
    expect(EventStoreTypeSchema.safeParse("future_row").success).toBe(false);
  });

  it("serves the eight envelope types the fold consumes, overview and explainer rows included", () => {
    expect(TRACE_ROW_TYPES).toEqual([
      "agent_event",
      "evidence_fact",
      "change_unit",
      "decision",
      "validation",
      "jev_decision",
      "overview_snapshot",
      "explainer",
    ]);
    expect(isTraceRowType("agent_event")).toBe(true);
    expect(isTraceRowType("overview_snapshot")).toBe(true);
    expect(isTraceRowType("explainer")).toBe(true);
    expect(isTraceRowType("telemetry")).toBe(false);
    expect(isTraceRowType("graph_node")).toBe(false);
  });
```

Replace the test "accepts a v1 jevcode.trace bundle and rejects other versions and formats" (lines 109-121) with:

```ts
  it("writes v2, accepts v1 and v2 jevcode.trace bundles and rejects other versions and formats", () => {
    expect(TRACE_BUNDLE_VERSION).toBe(2);
    expect(TRACE_BUNDLE_VERSIONS_SUPPORTED).toEqual([1, 2]);
    expect(TRACE_BUNDLE_VERSIONS_SUPPORTED).toContain(TRACE_BUNDLE_VERSION);
    const v1 = {
      format: TRACE_BUNDLE_FORMAT,
      version: 1,
      exportedAt: "2026-09-28T11:00:00.000Z",
      redactionCount: 2,
      session: summary,
      rows: [row],
    };
    expect(TraceBundleSchema.parse(v1)).toEqual(v1);
    const v2 = {
      ...v1,
      version: 2,
      rows: [
        row,
        { seq: 2, type: "overview_snapshot", ts: "2026-09-28T10:00:01.000Z", payload: { repoRoot: "/work/demo" } },
        { seq: 3, type: "explainer", ts: "2026-09-28T10:00:02.000Z", payload: { kind: "story" } },
      ],
    };
    expect(TraceBundleSchema.parse(v2)).toEqual(v2);
    for (const version of [0, 3, "2", null, 1.5]) {
      expect(TraceBundleSchema.safeParse({ ...v1, version }).success, String(version)).toBe(false);
    }
    expect(TraceBundleSchema.safeParse({ ...v1, format: "jevcode.replay" }).success).toBe(false);
  });
```

In `packages/trace-viewer/src/sources/static-bundle.test.ts`, replace the `describe("parseTraceBundle", …)` block (lines 31-43) with:

```ts
describe("parseTraceBundle", () => {
  it("accepts a v1 bundle", () => {
    const parsed = parseTraceBundle(JSON.parse(JSON.stringify(bundle())));
    expect(parsed).toMatchObject({ ok: true, bundle: { version: 1 } });
  });

  it("accepts a v2 bundle with overview_snapshot and explainer rows", () => {
    const v2 = {
      ...bundle(),
      version: 2,
      rows: [
        ...bundle().rows,
        { seq: 8, type: "overview_snapshot", ts: iso(8_000), payload: { repoRoot: "/work/acme" } },
        { seq: 9, type: "explainer", ts: iso(9_000), payload: { kind: "story" } },
      ],
    };
    const parsed = parseTraceBundle(JSON.parse(JSON.stringify(v2)));
    expect(parsed).toMatchObject({ ok: true, bundle: { version: 2 } });
    expect(parsed.ok && parsed.bundle.rows.map((r) => r.type).slice(-2)).toEqual(["overview_snapshot", "explainer"]);
  });

  it("names a wrong file and an unsupported version", () => {
    expect(parseTraceBundle({})).toEqual({ ok: false, code: "NOT_A_TRACE", message: "Not a jevcode trace" });
    expect(parseTraceBundle("garbage")).toEqual({ ok: false, code: "NOT_A_TRACE", message: "Not a jevcode trace" });
    expect(parseTraceBundle({ ...bundle(), version: 3 })).toEqual({ ok: false, code: "UNSUPPORTED_VERSION", message: "Trace format v3 is not supported" });
    expect(parseTraceBundle({ ...bundle(), version: 0 })).toEqual({ ok: false, code: "UNSUPPORTED_VERSION", message: "Trace format v0 is not supported" });
    // The version must be the number, not its string.
    expect(parseTraceBundle({ ...bundle(), version: "2" })).toMatchObject({ ok: false, code: "UNSUPPORTED_VERSION" });
    expect(parseTraceBundle({ ...bundle(), rows: "nope" })).toMatchObject({ ok: false, code: "NOT_A_TRACE" });
  });
});
```

In `apps/desktop/src/main/trace-bundle.test.ts`, in the test "redacts tokens and maps home", change line 108 from `      version: 1,` to:

```ts
      version: 2,
```

- [ ] **Step 2: Run the contracts test to verify it fails**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/contracts exec vitest run src/trace.test.ts`

Expected: FAIL in two tests:
- "lists the sixteen event-log envelope types in storage order": `expected [ …(14) ] to deeply equal [ …(16) ]`.
- "writes v2, accepts v1 and v2 …": `expected 1 to be 2`.

"serves the eight envelope types …" also fails with an array diff.

- [ ] **Step 3: Implement the contracts change**

In `packages/contracts/src/trace.ts`, replace lines 5-21 (the `EVENT_TYPES` block) with:

```ts
/**
 * Every envelope type in the events log. Moved from packages/storage/src/db.ts:53-68.
 * overview_snapshot and explainer are the console-explainer spec §6.5 rows.
 */
export const EVENT_TYPES = [
  "agent_event",
  "evidence_fact",
  "change_unit",
  "decision",
  "validation",
  "failure",
  "jev_decision",
  "ui_intent",
  "ui_snapshot",
  "graph_node",
  "graph_edge",
  "command",
  "semantic_event",
  "telemetry",
  "overview_snapshot",
  "explainer",
] as const;
```

Replace lines 27-35 (the `TRACE_ROW_TYPES` block) with:

```ts
/** The envelope types the trace fold consumes. trace:rows and trace.json carry only these. */
export const TRACE_ROW_TYPES = [
  "agent_event",
  "evidence_fact",
  "change_unit",
  "decision",
  "validation",
  "jev_decision",
  "overview_snapshot",
  "explainer",
] as const satisfies readonly EventStoreType[];
```

Replace lines 93-103 (from `export const TRACE_BUNDLE_FORMAT` to the end of `TraceBundleSchema`) with:

```ts
export const TRACE_BUNDLE_FORMAT = "jevcode.trace";
/** Written by export. v2 adds overview_snapshot and explainer rows; v1 bundles have none. */
export const TRACE_BUNDLE_VERSION = 2;
/** Versions the parser reads (console-explainer spec §7). */
export const TRACE_BUNDLE_VERSIONS_SUPPORTED = [1, 2] as const;

export const TraceBundleSchema = z.object({
  format: z.literal(TRACE_BUNDLE_FORMAT),
  version: z.union([z.literal(1), z.literal(2)]),
  exportedAt: z.string(),
  redactionCount: z.number().int().nonnegative(),
  session: TraceSessionSummarySchema,
  rows: z.array(TraceRowSchema),
});
```

- [ ] **Step 4: Run the contracts test and typecheck**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/contracts exec vitest run src/trace.test.ts`
Expected: PASS, 8 tests.

Run: `perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/contracts typecheck && perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/contracts build`
Expected: both exit 0.

- [ ] **Step 5: Run the viewer tests to verify they fail on the rebuilt contracts**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/sources/static-bundle.test.ts src/model/registry.test.ts`

Expected: FAIL.
- "accepts a v2 bundle with overview_snapshot and explainer rows": `{ ok: false, code: "UNSUPPORTED_VERSION", … }` does not match `{ ok: true }`.
- "maps every envelope type and consumes exactly TRACE_ROW_TYPES": the key list lacks `explainer` and `overview_snapshot`.

- [ ] **Step 6: Implement the parser, the viewer rule and the storage placeholder**

In `packages/trace-viewer/src/sources/static-bundle.ts`, replace lines 1-4 with:

```ts
import {
  TRACE_BUNDLE_FORMAT, TRACE_BUNDLE_VERSIONS_SUPPORTED, TRACE_PAYLOADS_MAX, TRACE_ROWS_PAGE_DEFAULT, TraceBundleSchema,
  type TraceBundle, type TraceRow, type TraceRowsPage, type TraceSessionSummary,
} from "@jevcode/contracts";
```

Replace lines 15-24 (`parseTraceBundle`) with:

```ts
const SUPPORTED_VERSIONS: readonly unknown[] = TRACE_BUNDLE_VERSIONS_SUPPORTED;

/** v1 and v2 parse (a v1 bundle has no overview_snapshot or explainer rows); any other version is named in the message. */
export function parseTraceBundle(json: unknown): ParsedBundle {
  if (json === null || typeof json !== "object") return NOT_A_TRACE;
  const record = json as { format?: unknown; version?: unknown };
  if (record.format !== TRACE_BUNDLE_FORMAT) return NOT_A_TRACE;
  if (!SUPPORTED_VERSIONS.includes(record.version)) {
    return { ok: false, code: "UNSUPPORTED_VERSION", message: `Trace format v${String(record.version)} is not supported` };
  }
  const parsed = TraceBundleSchema.safeParse(json);
  return parsed.success ? { ok: true, bundle: parsed.data } : NOT_A_TRACE;
}
```

In `packages/trace-viewer/src/model/registry.ts`, replace lines 37-53 (the `ENVELOPE_RULES` block) with:

```ts
/**
 * consume = TRACE_ROW_TYPES; everything else is only counted in TraceSession.hidden.
 * overview_snapshot (lane 06 P-1) and explainer (lane 07 S-3) are consumed, but until those
 * tasks add their `case` to accumulate (fold.ts) the default branch counts them in hidden.
 */
export const ENVELOPE_RULES: { readonly [K in EventStoreType]: RowDisposition } = {
  agent_event: "consume",
  evidence_fact: "consume",
  change_unit: "consume",
  decision: "consume",
  validation: "consume",
  failure: "hidden",
  jev_decision: "consume",
  ui_intent: "hidden",
  ui_snapshot: "hidden",
  graph_node: "hidden",
  graph_edge: "hidden",
  command: "hidden",
  semantic_event: "hidden",
  telemetry: "hidden",
  overview_snapshot: "consume",
  explainer: "consume",
};
```

In `packages/storage/src/db.ts`, change line 8 from `import type { z } from "zod";` to:

```ts
import { z } from "zod";
```

Replace lines 59-74 (the `eventStoreSchemas` block) with:

```ts
// K-1 placeholder (console-explainer lane 01): the overview_snapshot and explainer
// schemas land in K-2 and replace this in K-4. Until then storage refuses both types.
const NOT_WRITABLE_YET = z.never();

const eventStoreSchemas = {
  agent_event: NormalizedAgentEventSchema,
  evidence_fact: EvidenceFactSchema,
  change_unit: ChangeUnitSchema,
  decision: DecisionSchema,
  validation: ValidationResultSchema,
  failure: FailureRecordSchema,
  jev_decision: JevDecisionLogSchema,
  ui_intent: UiIntentRecordSchema,
  ui_snapshot: UiSnapshotSchema,
  graph_node: GraphNodeRecordSchema,
  graph_edge: GraphEdgeRecordSchema,
  command: CommandRecordSchema,
  semantic_event: SemanticEventRecordSchema,
  telemetry: TelemetryEventSchema,
  overview_snapshot: NOT_WRITABLE_YET,
  explainer: NOT_WRITABLE_YET,
} as const satisfies Record<EventStoreType, z.ZodTypeAny>;
```

In `apps/desktop/src/main/replay/cli-entry.ts`, change line 30 from `  /** <outDir>/trace.json: a TraceBundle (format jevcode.trace v1) of the replayed session. */` to:

```ts
  /** <outDir>/trace.json: a TraceBundle (format jevcode.trace, TRACE_BUNDLE_VERSION) of the replayed session. */
```

- [ ] **Step 7: Run the tests and typechecks**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/sources/static-bundle.test.ts src/model/registry.test.ts`
Expected: PASS.

Run: `perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/trace-viewer typecheck && perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/storage typecheck`
Expected: both exit 0.

Run: `perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/storage build && perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/trace-viewer build`
Expected: both exit 0.

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/main/trace-bundle.test.ts src/main/replay/cli-entry.test.ts`
Expected: PASS. `cli-entry.test.ts` parses the replayed bundle with `TraceBundleSchema`, which now reads `version: 2`.

Run: `perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop typecheck`
Expected: exits 0.

- [ ] **Step 8: Package suites and lint**

Run each command separately, each under the hang-safety wrapper (`perl -e 'alarm 150; exec @ARGV' …`):
- `pnpm --filter @jevcode/contracts test`
- `pnpm --filter @jevcode/storage test`
- `pnpm --filter @jevcode/trace-viewer test`
- `pnpm --filter jevcode-desktop test`
- `perl -e 'alarm 170; exec @ARGV' pnpm lint`

Expected: each exits 0. `perl -e 'alarm 170; exec @ARGV' pnpm lint` prints nothing after `> pnpm exec eslint .`. A flake from the known list passes when rerun alone.

- [ ] **Step 9: Commit**

```bash
git add packages/contracts/src/trace.ts packages/contracts/src/trace.test.ts \
  packages/trace-viewer/src/sources/static-bundle.ts packages/trace-viewer/src/sources/static-bundle.test.ts \
  packages/trace-viewer/src/model/registry.ts packages/storage/src/db.ts \
  apps/desktop/src/main/replay/cli-entry.ts apps/desktop/src/main/trace-bundle.test.ts
git commit -m "feat(contracts): add overview_snapshot and explainer row types and trace bundle v2"
```

---

### Task K-2: Overview and explainer zod schemas (`src/overview.ts`)

**Files:**
- Create: `packages/contracts/src/overview.ts`
- Modify: `packages/contracts/src/index.ts` (add one line)
- Test: `packages/contracts/src/overview.test.ts` (create), `packages/contracts/src/browser-safety.test.ts` (line 49)

**Interfaces:**
- Consumes: `zod`.
- Produces (from `@jevcode/contracts`, exactly as interfaces §1.2):
  - `ROLES`, `type Role`, `RoleSchema`
  - `CitationSchema`, `type Citation` (`{ kind: "component" | "file" | "decision" | "fact" | "step"; id: string }`, id 1-512 chars)
  - `NarrativeSentenceSchema`, `type NarrativeSentence` (text 1-220, citations 1-6)
  - `ComponentSchema`, `type Component`
  - `ComponentEdgeSchema`, `type ComponentEdge`
  - `ExternalDepSchema`, `type ExternalDep`
  - `OverviewSnapshotSchema`, `type OverviewSnapshot`
  - `ExplainerRecordSchema`, `type ExplainerRecord` (discriminated on `kind`: `story`, `decision_why`, `highlights`)
  - `OVERVIEW_SNAPSHOT_MAX_BYTES = 524288`
  - Orchestrator ruling R3:
    - `OVERVIEW_SCAN_STATES = ["running", "done", "failed"] as const`
    - `NARRATOR_STATES = ["off", "unavailable", "pending", "ready"] as const`
    - `type NarratorState = (typeof NARRATOR_STATES)[number]` (lanes 04 and 05 import it from `@jevcode/contracts`; neither declares its own)
    - `OverviewStatusSchema` (strict at both levels): `{ scan: { state, scanned, total, error?: string ≤ 200 }, narrator }`
    - `type OverviewStatus`
    - `OverviewSnapshotSchema.status?: OverviewStatus`
    - `OverviewSnapshotSchema.counts.totalFiles?: number`: repo files before the 20,000-file cap.

    Both new fields are optional. A row written without `status` reads as scan `done`, with narrator `pending` if any purpose is null, else `ready`; lane 06 applies that default.

  Consumers:
  - lane 04 (M-3, M-6): writes `status.scan`, and `status.narrator` as `off` or `unavailable` by default;
  - lane 05 (N-1, and N-5 through the seam): writes `status.narrator`;
  - lane 06 (P-1, P-3, P-4): renders;
  - lane 07 (S-1, S-3).

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/overview.test.ts`:

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  CitationSchema,
  ComponentEdgeSchema,
  ComponentSchema,
  ExplainerRecordSchema,
  ExternalDepSchema,
  NARRATOR_STATES,
  NarrativeSentenceSchema,
  OVERVIEW_SCAN_STATES,
  OVERVIEW_SNAPSHOT_MAX_BYTES,
  OverviewSnapshotSchema,
  OverviewStatusSchema,
  ROLES,
  RoleSchema,
} from "./overview.js";
import type { Component, ComponentEdge, ExternalDep, NarratorState, OverviewSnapshot, OverviewStatus } from "./overview.js";

const HASH = "0123456789abcdef0123456789abcdef01234567";

const cmpId = (i: number): string => `cmp_${i.toString(16).padStart(12, "0")}`;

function component(i: number, overrides: Partial<Component> = {}): Component {
  return {
    id: cmpId(i),
    rootPath: `packages/p${i}`,
    name: `@acme/p${i}`,
    fileCount: 3,
    files: [`packages/p${i}/src/a.ts`, `packages/p${i}/src/b.ts`, `packages/p${i}/src/index.ts`],
    language: "TypeScript",
    roleGuess: "domain",
    role: "domain",
    purpose: null,
    provenance: "rule",
    contentHash: HASH,
    externalDeps: [{ name: "zod", count: 2 }],
    entryPoints: [`packages/p${i}/src/index.ts`],
    importsAnalyzed: true,
    ...overrides,
  };
}

function edge(i: number): ComponentEdge {
  return { from: cmpId(i), to: cmpId(i + 1), count: 1 + (i % 5), examples: [`packages/p${i}/src/a.ts → packages/p${i + 1}/src/b.ts`] };
}

function external(i: number): ExternalDep {
  return { name: `dep-${i}`, usedBy: [{ componentId: cmpId(i), count: 1 }] };
}

function snapshot(overrides: Partial<OverviewSnapshot> = {}): OverviewSnapshot {
  return {
    sessionId: "sess_1",
    repoRoot: "/work/acme",
    scanId: "scan_1",
    partial: false,
    counts: { files: 6, components: 2, edges: 1, languages: ["TypeScript"] },
    components: [component(1), component(2, { roleGuess: "storage", role: "storage" })],
    edges: [edge(1)],
    externals: [external(1)],
    narrative: null,
    generatedAt: "2026-10-02T10:00:00.000Z",
    ...overrides,
  };
}

const sentence = (text: string) => ({ text, citations: [{ kind: "component" as const, id: cmpId(1) }] });

describe("roles and limits", () => {
  it("pins the closed role list; external is a dependency chip, not a role", () => {
    expect(ROLES).toEqual(["ui", "api", "agent", "domain", "storage", "tests", "tooling", "config"]);
    for (const role of ROLES) expect(RoleSchema.safeParse(role).success).toBe(true);
    for (const role of ["external", "UI", "frontend", ""]) expect(RoleSchema.safeParse(role).success).toBe(false);
  });

  it("pins the snapshot byte cap at 512 KB", () => {
    expect(OVERVIEW_SNAPSHOT_MAX_BYTES).toBe(524_288);
  });
});

describe("CitationSchema and NarrativeSentenceSchema", () => {
  it("accepts the five citation kinds and nothing else", () => {
    for (const kind of ["component", "file", "decision", "fact", "step"]) {
      expect(CitationSchema.safeParse({ kind, id: "x" }).success, kind).toBe(true);
    }
    expect(CitationSchema.safeParse({ kind: "url", id: "https://example.com" }).success).toBe(false);
    expect(CitationSchema.safeParse({ kind: "file", id: "" }).success).toBe(false);
    expect(CitationSchema.safeParse({ kind: "file", id: "f".repeat(513) }).success).toBe(false);
    expect(CitationSchema.safeParse({ kind: "file", id: "f".repeat(512) }).success).toBe(true);
  });

  it("accepts a sentence iff its text has 1 to 220 characters and it has 1 to 6 citations (property)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 260 }), fc.integer({ min: 0, max: 8 }), (text, n) => {
        const value = { text, citations: Array.from({ length: n }, (_, i) => ({ kind: "file", id: `src/f${i}.ts` })) };
        const expected = text.length >= 1 && text.length <= 220 && n >= 1 && n <= 6;
        expect(NarrativeSentenceSchema.safeParse(value).success).toBe(expected);
      }),
      { numRuns: 200, examples: [["x".repeat(220), 6], ["x".repeat(221), 1], ["", 1], ["x", 0], ["x", 7]] },
    );
  });
});

describe("ComponentSchema", () => {
  it("accepts the boundary values", () => {
    const value = component(1, {
      rootPath: ".",
      purpose: "p".repeat(140),
      language: null,
      files: Array.from({ length: 400 }, (_, i) => `src/f${i}.ts`),
      externalDeps: Array.from({ length: 8 }, (_, i) => ({ name: `d${i}`, count: 1 })),
      entryPoints: Array.from({ length: 8 }, (_, i) => `src/e${i}.ts`),
      fileCount: 0,
      provenance: "model",
    });
    expect(ComponentSchema.parse(value)).toEqual(value);
  });

  it.each<[string, Record<string, unknown>]>([
    ["an id with uppercase hex", { id: "cmp_ABCDEF012345" }],
    ["an id with 11 hex digits", { id: "cmp_0123456789a" }],
    ["an id without the cmp_ prefix", { id: "0123456789ab" }],
    ["a content hash of 39 hex digits", { contentHash: HASH.slice(1) }],
    ["a purpose over 140 characters", { purpose: "p".repeat(141) }],
    ["more than 400 listed files", { files: Array.from({ length: 401 }, (_, i) => `f${i}.ts`) }],
    ["more than 8 external deps", { externalDeps: Array.from({ length: 9 }, (_, i) => ({ name: `d${i}`, count: 1 })) }],
    ["an external dep count of 0", { externalDeps: [{ name: "zod", count: 0 }] }],
    ["more than 8 entry points", { entryPoints: Array.from({ length: 9 }, (_, i) => `e${i}.ts`) }],
    ["a role outside the closed list", { role: "external" }],
    ["a role guess outside the closed list", { roleGuess: "frontend" }],
    ["an empty name", { name: "" }],
    ["a name over 120 characters", { name: "n".repeat(121) }],
    ["a language over 40 characters", { language: "l".repeat(41) }],
    ["a person provenance", { provenance: "person" }],
    ["a negative file count", { fileCount: -1 }],
    ["an empty root path", { rootPath: "" }],
    ["a missing importsAnalyzed flag", { importsAnalyzed: undefined }],
  ])("rejects a component with %s", (_label, override) => {
    expect(ComponentSchema.safeParse({ ...component(1), ...override }).success).toBe(false);
  });

  it("keeps bidi controls in text as data; renderers apply displayUntrusted", () => {
    const value = component(1, { name: "pkg‮gnp.exe", purpose: "Stores ‮sessions" });
    expect(ComponentSchema.parse(value)).toEqual(value);
  });
});

describe("ComponentEdgeSchema and ExternalDepSchema", () => {
  it("accepts an edge with up to 3 examples of up to 300 characters", () => {
    const value = { ...edge(1), examples: ["a".repeat(300), "b", "c"] };
    expect(ComponentEdgeSchema.parse(value)).toEqual(value);
  });

  it("rejects a zero count, a fourth example and an example over 300 characters", () => {
    expect(ComponentEdgeSchema.safeParse({ ...edge(1), count: 0 }).success).toBe(false);
    expect(ComponentEdgeSchema.safeParse({ ...edge(1), examples: ["a", "b", "c", "d"] }).success).toBe(false);
    expect(ComponentEdgeSchema.safeParse({ ...edge(1), examples: ["a".repeat(301)] }).success).toBe(false);
  });

  it("bounds externals by name length and users", () => {
    expect(ExternalDepSchema.safeParse({ ...external(1), name: "n".repeat(214) }).success).toBe(true);
    expect(ExternalDepSchema.safeParse({ ...external(1), name: "n".repeat(215) }).success).toBe(false);
    expect(ExternalDepSchema.safeParse({ ...external(1), name: "" }).success).toBe(false);
    const users = (n: number) => Array.from({ length: n }, (_, i) => ({ componentId: cmpId(i), count: 1 }));
    expect(ExternalDepSchema.safeParse({ name: "zod", usedBy: users(40) }).success).toBe(true);
    expect(ExternalDepSchema.safeParse({ name: "zod", usedBy: users(41) }).success).toBe(false);
    expect(ExternalDepSchema.safeParse({ name: "zod", usedBy: [{ componentId: cmpId(1), count: 0 }] }).success).toBe(false);
  });
});

describe("OverviewSnapshotSchema", () => {
  it("parses a snapshot and keeps it equal through a JSON round trip", () => {
    const value = snapshot();
    expect(OverviewSnapshotSchema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
  });

  it("accepts a model narrative of up to 8 sentences and rejects other provenances", () => {
    const narrative = { sentences: Array.from({ length: 8 }, (_, i) => sentence(`Sentence ${i}.`)), provenance: "model" as const };
    expect(OverviewSnapshotSchema.parse(snapshot({ narrative })).narrative).toEqual(narrative);
    expect(OverviewSnapshotSchema.safeParse(snapshot({ narrative: { ...narrative, sentences: [...narrative.sentences, sentence("Nine.")] } })).success).toBe(false);
    expect(OverviewSnapshotSchema.safeParse({ ...snapshot(), narrative: { sentences: [], provenance: "rule" } }).success).toBe(false);
  });

  it.each<[string, Record<string, unknown>]>([
    ["a missing sessionId", { sessionId: undefined }],
    ["an empty repoRoot", { repoRoot: "" }],
    ["an empty scanId", { scanId: "" }],
    ["a non-boolean partial flag", { partial: "yes" }],
    ["21 languages", { counts: { files: 1, components: 1, edges: 0, languages: Array.from({ length: 21 }, (_, i) => `L${i}`) } }],
    ["a negative file count", { counts: { files: -1, components: 1, edges: 0, languages: [] } }],
  ])("rejects a snapshot with %s", (_label, override) => {
    expect(OverviewSnapshotSchema.safeParse({ ...snapshot(), ...override }).success).toBe(false);
  });

  it("accepts counts.totalFiles as optional and rejects a negative or fractional value", () => {
    const counts = { files: 20_000, components: 2, edges: 1, languages: ["TypeScript"] };
    expect(OverviewSnapshotSchema.parse(snapshot({ partial: true, counts: { ...counts, totalFiles: 25_000 } })).counts.totalFiles).toBe(25_000);
    expect(OverviewSnapshotSchema.parse(snapshot({ counts })).counts.totalFiles).toBeUndefined();
    expect(OverviewSnapshotSchema.safeParse({ ...snapshot(), counts: { ...counts, totalFiles: -1 } }).success).toBe(false);
    expect(OverviewSnapshotSchema.safeParse({ ...snapshot(), counts: { ...counts, totalFiles: 1.5 } }).success).toBe(false);
  });

  it("accepts a snapshot iff it holds at most 200 components, 1,000 edges and 120 externals (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 230 }),
        fc.integer({ min: 0, max: 1_030 }),
        fc.integer({ min: 0, max: 140 }),
        (components, edges, externals) => {
          const value = snapshot({
            components: Array.from({ length: components }, (_, i) => component(i)),
            edges: Array.from({ length: edges }, (_, i) => edge(i)),
            externals: Array.from({ length: externals }, (_, i) => external(i)),
          });
          const expected = components <= 200 && edges <= 1_000 && externals <= 120;
          expect(OverviewSnapshotSchema.safeParse(value).success).toBe(expected);
        },
      ),
      { numRuns: 60, examples: [[200, 1_000, 120], [201, 0, 0], [0, 1_001, 0], [0, 0, 121]] },
    );
  });
});

describe("OverviewStatusSchema (ruling R3)", () => {
  const status = (overrides: Partial<OverviewStatus> = {}): OverviewStatus => ({
    scan: { state: "done", scanned: 9_800, total: 9_800 },
    narrator: "pending",
    ...overrides,
  });

  it("pins the scan and narrator state lists", () => {
    expect(OVERVIEW_SCAN_STATES).toEqual(["running", "done", "failed"]);
    expect(NARRATOR_STATES).toEqual(["off", "unavailable", "pending", "ready"]);
    const states: NarratorState[] = [...NARRATOR_STATES];
    expect(states).toHaveLength(4);
  });

  it("parses a snapshot with and without status; a pre-status row keeps no status", () => {
    const withStatus = snapshot({ status: status({ scan: { state: "running", scanned: 3_200, total: 9_800 }, narrator: "off" }) });
    expect(OverviewSnapshotSchema.parse(withStatus)).toEqual(withStatus);
    const without = snapshot();
    expect("status" in without).toBe(false);
    expect(OverviewSnapshotSchema.parse(without).status).toBeUndefined();
    for (const narrator of NARRATOR_STATES) {
      expect(OverviewStatusSchema.safeParse(status({ narrator })).success, narrator).toBe(true);
    }
    for (const state of OVERVIEW_SCAN_STATES) {
      expect(OverviewStatusSchema.safeParse(status({ scan: { state, scanned: 0, total: 0 } })).success, state).toBe(true);
    }
  });

  it("accepts a failed scan with a short error and rejects an error longer than 200 characters", () => {
    const failed = status({ scan: { state: "failed", scanned: 10, total: 9_800, error: "e".repeat(200) } });
    expect(OverviewStatusSchema.parse(failed)).toEqual(failed);
    expect(OverviewStatusSchema.safeParse(status({ scan: { state: "failed", scanned: 10, total: 9_800, error: "e".repeat(201) } })).success).toBe(false);
    expect(OverviewSnapshotSchema.safeParse({ ...snapshot(), status: { scan: { state: "failed", scanned: 0, total: 0, error: "e".repeat(201) } }, narrator: "off" } }).success).toBe(false);
  });

  it.each<[string, unknown]>([
    ["an unknown narrator state", { scan: { state: "done", scanned: 1, total: 1 }, narrator: "error" }],
    ["an unknown scan state", { scan: { state: "queued", scanned: 0, total: 1 }, narrator: "off" }],
    ["a negative scanned count", { scan: { state: "running", scanned: -1, total: 1 }, narrator: "off" }],
    ["a fractional total", { scan: { state: "running", scanned: 0, total: 1.5 }, narrator: "off" }],
    ["an extra key on status", { scan: { state: "done", scanned: 1, total: 1 }, narrator: "ready", message: "hi" }],
    ["an extra key on scan", { scan: { state: "done", scanned: 1, total: 1, detail: "stack trace" }, narrator: "ready" }],
    ["a missing narrator", { scan: { state: "done", scanned: 1, total: 1 } }],
  ])("rejects a status with %s", (_label, value) => {
    expect(OverviewStatusSchema.safeParse(value).success).toBe(false);
    expect(OverviewSnapshotSchema.safeParse({ ...snapshot(), status: value }).success).toBe(false);
  });
});

describe("ExplainerRecordSchema", () => {
  const s = sentence("The agent added an OAuth callback route.");

  it("parses the three record kinds", () => {
    const records = [
      { sessionId: "sess_1", kind: "story", sentences: [s], basisSeq: 40 },
      { sessionId: "sess_1", kind: "story", sentences: [s], basisSeq: 41, provenance: "rule" },
      { sessionId: "sess_1", kind: "decision_why", decisionId: "dec_1", sentence: s },
      {
        sessionId: "sess_1",
        kind: "highlights",
        basisSeq: 41,
        components: [
          { id: cmpId(1), state: "new", unitIds: [] },
          { id: cmpId(2), state: "changed", unitIds: ["unit_1"] },
          { id: cmpId(3), state: "decision", unitIds: [] },
          { id: cmpId(4), state: "failing", unitIds: ["unit_2"] },
        ],
      },
    ];
    for (const record of records) expect(ExplainerRecordSchema.parse(record)).toEqual(record);
  });

  it.each<[string, Record<string, unknown>]>([
    ["a story with no sentences", { sessionId: "sess_1", kind: "story", sentences: [], basisSeq: 1 }],
    ["a story with 7 sentences", { sessionId: "sess_1", kind: "story", sentences: Array.from({ length: 7 }, () => s), basisSeq: 1 }],
    ["a negative basisSeq", { sessionId: "sess_1", kind: "story", sentences: [s], basisSeq: -1 }],
    ["a story with an unknown provenance", { sessionId: "sess_1", kind: "story", sentences: [s], basisSeq: 1, provenance: "guess" }],
    ["a decision_why with an empty decisionId", { sessionId: "sess_1", kind: "decision_why", decisionId: "", sentence: s }],
    ["a decision_why with an uncited sentence", { sessionId: "sess_1", kind: "decision_why", decisionId: "dec_1", sentence: { text: "Why.", citations: [] } }],
    ["an unknown highlight state", { sessionId: "sess_1", kind: "highlights", basisSeq: 1, components: [{ id: cmpId(1), state: "removed", unitIds: [] }] }],
    ["a highlight with 51 unit ids", { sessionId: "sess_1", kind: "highlights", basisSeq: 1, components: [{ id: cmpId(1), state: "changed", unitIds: Array.from({ length: 51 }, (_, i) => `u${i}`) }] }],
    ["highlights for 201 components", { sessionId: "sess_1", kind: "highlights", basisSeq: 1, components: Array.from({ length: 201 }, (_, i) => ({ id: cmpId(i), state: "changed", unitIds: [] })) }],
    ["an unknown kind", { sessionId: "sess_1", kind: "summary", sentences: [s] }],
    ["no sessionId", { kind: "story", sentences: [s], basisSeq: 1 }],
  ])("rejects %s", (_label, record) => {
    expect(ExplainerRecordSchema.safeParse(record).success).toBe(false);
  });
});
```

In `packages/contracts/src/browser-safety.test.ts`, change line 49 from

```ts
      expect.arrayContaining(["agent-events.ts", "evidence.ts", "id.ts", "semantic.ts", "ui/components.ts"]),
```

to

```ts
      expect.arrayContaining(["agent-events.ts", "evidence.ts", "id.ts", "overview.ts", "semantic.ts", "ui/components.ts"]),
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/contracts exec vitest run src/overview.test.ts src/browser-safety.test.ts`

Expected: FAIL.
- `overview.test.ts` fails to load: `Failed to load url ./overview.js` (or `Cannot find module './overview.js'`).
- `browser-safety.test.ts` "reaches the whole barrel" fails because `overview.ts` is missing from `visited`.

- [ ] **Step 3: Write the implementation**

Create `packages/contracts/src/overview.ts`:

```ts
import { z } from "zod";

// Codebase overview and session explainer contracts (console-explainer spec §5, §6.5, §7).
// Browser-safe: no Node built-ins. Text fields are untrusted data; renderers apply displayUntrusted.

/** Spec §5.4. "external" is used only for dependency chips and is not a Role. */
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
  /** Repo-relative, "/" separators, no trailing slash; "." for a flat repo. */
  rootPath: z.string().min(1),
  name: z.string().min(1).max(120),
  fileCount: z.number().int().nonnegative(),
  /** Repo-relative, sorted; capped (fileCount carries the true count). */
  files: z.array(z.string()).max(400),
  /** Main language by file count, e.g. "TypeScript". */
  language: z.string().max(40).nullable(),
  roleGuess: RoleSchema,
  role: RoleSchema,
  purpose: z.string().max(140).nullable(),
  provenance: z.enum(["rule", "model"]),
  contentHash: z.string().regex(/^[0-9a-f]{40}$/),
  externalDeps: z.array(z.object({ name: z.string(), count: z.number().int().positive() })).max(8),
  entryPoints: z.array(z.string()).max(8),
  /** False when no member file has a supported grammar (spec E14). */
  importsAnalyzed: z.boolean(),
});
export type Component = z.infer<typeof ComponentSchema>;

export const ComponentEdgeSchema = z.object({
  /** Component ids. */
  from: z.string(),
  to: z.string(),
  count: z.number().int().positive(),
  /** "a/b.ts → c/d.ts" */
  examples: z.array(z.string().max(300)).max(3),
});
export type ComponentEdge = z.infer<typeof ComponentEdgeSchema>;

export const ExternalDepSchema = z.object({
  name: z.string().min(1).max(214),
  usedBy: z.array(z.object({ componentId: z.string(), count: z.number().int().positive() })).max(40),
});
export type ExternalDep = z.infer<typeof ExternalDepSchema>;

/** Orchestrator ruling R3. Lane 04 writes scan state; lane 05 writes narrator state; lane 06 renders. */
export const OVERVIEW_SCAN_STATES = ["running", "done", "failed"] as const;
/**
 * off = setting off; unavailable = no API key, or in failure backoff; pending = descriptions
 * being written; ready = narration for this snapshot finished (some purposes may still be null).
 */
export const NARRATOR_STATES = ["off", "unavailable", "pending", "ready"] as const;
export type NarratorState = (typeof NARRATOR_STATES)[number];

/**
 * Strict at both levels: a status carries only these fields. `error` is a short, untrusted
 * message (rendered through displayUntrusted).
 */
export const OverviewStatusSchema = z
  .object({
    scan: z
      .object({
        state: z.enum(OVERVIEW_SCAN_STATES),
        scanned: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
        error: z.string().max(200).optional(),
      })
      .strict(),
    narrator: z.enum(NARRATOR_STATES),
  })
  .strict();
export type OverviewStatus = z.infer<typeof OverviewStatusSchema>;

export const OverviewSnapshotSchema = z.object({
  /** The session the row belongs to; storage requires it to match the event's session. */
  sessionId: z.string(),
  repoRoot: z.string().min(1),
  scanId: z.string().min(1),
  /** True when the 20,000-file scan cap was hit. */
  partial: z.boolean(),
  counts: z.object({
    files: z.number().int().nonnegative(),
    /** Repo files before the 20,000-file cap (ruling R3); absent on rows written before it. */
    totalFiles: z.number().int().nonnegative().optional(),
    components: z.number().int().nonnegative(),
    edges: z.number().int().nonnegative(),
    languages: z.array(z.string()).max(20),
  }),
  /**
   * Ruling R3. Absent on rows written before the field: read as scan "done", and narrator
   * "pending" if any component purpose is null, else "ready".
   */
  status: OverviewStatusSchema.optional(),
  components: z.array(ComponentSchema).max(200),
  edges: z.array(ComponentEdgeSchema).max(1000),
  externals: z.array(ExternalDepSchema).max(120),
  narrative: z
    .object({ sentences: z.array(NarrativeSentenceSchema).max(8), provenance: z.literal("model") })
    .nullable(),
  /** ISO time. */
  generatedAt: z.string(),
});
export type OverviewSnapshot = z.infer<typeof OverviewSnapshotSchema>;

export const ExplainerRecordSchema = z.discriminatedUnion("kind", [
  z.object({
    sessionId: z.string(),
    kind: z.literal("story"),
    sentences: z.array(NarrativeSentenceSchema).min(1).max(6),
    basisSeq: z.number().int().nonnegative(),
    // Who wrote the story; absent reads as "model" (ruling R3, lane 07 S-4 shows a rule-based story differently).
    provenance: z.enum(["rule", "model"]).optional(),
  }),
  z.object({
    sessionId: z.string(),
    kind: z.literal("decision_why"),
    decisionId: z.string().min(1),
    sentence: NarrativeSentenceSchema,
  }),
  z.object({
    sessionId: z.string(),
    kind: z.literal("highlights"),
    basisSeq: z.number().int().nonnegative(),
    components: z
      .array(
        z.object({
          id: z.string(),
          state: z.enum(["new", "changed", "decision", "failing"]),
          unitIds: z.array(z.string()).max(50),
        }),
      )
      .max(200),
  }),
]);
export type ExplainerRecord = z.infer<typeof ExplainerRecordSchema>;

/** Spec §5.5: an overview_snapshot row's payload, as UTF-8 bytes of its stored JSON, never exceeds this. */
export const OVERVIEW_SNAPSHOT_MAX_BYTES = 512 * 1024;
```

In `packages/contracts/src/index.ts`, after the line `export * from "./model.js";` add:

```ts
export * from "./overview.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/contracts exec vitest run src/overview.test.ts src/browser-safety.test.ts`
Expected: PASS (all `overview.test.ts` tests; 3 browser-safety tests).

- [ ] **Step 5: Typecheck, build, package suite, lint**

Run, one per call:
- `perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/contracts typecheck`
- `perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/contracts build`
- `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/contracts test`
- `perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/storage typecheck`
- `perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/trace-viewer typecheck`
- `perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop typecheck`
- `perl -e 'alarm 170; exec @ARGV' pnpm lint`

Expected: each exits 0. The three downstream typechecks prove the new barrel names collide with nothing.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/overview.ts packages/contracts/src/overview.test.ts \
  packages/contracts/src/index.ts packages/contracts/src/browser-safety.test.ts
git commit -m "feat(contracts): add overview snapshot and explainer record schemas"
```

---

### Task K-3: IPC `trace:rowsAvailable`, `overview:rescan`, preference `explainWithModel`

**Files:**
- Modify: `packages/contracts/src/ipc.ts` (channel maps at lines 24-58, schemas after line 212, payload maps at lines 214-248)
- Modify: `apps/desktop/src/shared/prefs.ts` (lines 20-41, 98-121)
- Modify: `apps/desktop/src/shared/local-channels.ts` (lines 187-209)
- Modify: `apps/desktop/src/main/ipc.ts` (lines 25-31, 236-246)
- Test: `packages/contracts/src/ipc.test.ts`, `apps/desktop/src/shared/ipc-registry.test.ts`, `apps/desktop/src/main/trace-allowlist.test.ts`, `apps/desktop/src/shared/prefs.test.ts`, `apps/desktop/src/shared/prefs-ipc.test.ts`, `apps/desktop/src/main/ipc.test.ts`

**Interfaces:**
- Consumes (K-1): nothing beyond the existing contracts barrel.
- Produces (from `@jevcode/contracts`):
  - `MainToRendererChannels.traceRowsAvailable` (`"trace:rowsAvailable"`), payload `TraceRowsAvailablePayloadSchema`, a strict `{ sessionId: string (min 1); lastSeq: number (int ≥ 0) }`. Type `TraceRowsAvailablePayload`. Consumed by lane 03 D-1, whose emitter calls `sendToRenderer(MainToRendererChannels.traceRowsAvailable, { sessionId, lastSeq })`.
  - `RendererToMainChannels.overviewRescan` (`"overview:rescan"`), payload `OverviewRescanPayloadSchema` (`{ repoRoot: string (min 1) }`, response `void`). Type `OverviewRescanPayload`. Consumed by lane 04 M-6, whose handler is registered in `apps/desktop/src/main/ipc.ts`. The channel is main-window only (trace windows are refused by `isChannelAllowed`).
- Produces (desktop `apps/desktop/src/shared/prefs.ts`):
  - `EXPLAIN_WITH_MODEL_PREF_KEY = "explainer.withModel"`
  - `AgentPreferences.explainWithModel: boolean` (default `true`) and `AgentPreferencesPatch.explainWithModel?: boolean`
  - `normalizeExplainWithModel(value: unknown): boolean`: a stored boolean is returned unchanged; any other value reads as `true`.
  - `readAgentPreferences` and `applyPreferencesPatch` carry the field.
  
  Consumed by lane 05 N-4 (settings UI, stage wiring) and N-5 (`narrator: null` when `false`).

- [ ] **Step 1: Write the failing tests**

In `packages/contracts/src/ipc.test.ts`:

- In the test "covers every SPEC section 4.5 renderer-to-main channel", replace `      "telemetry:flush",\n    ];` with:

```ts
      "telemetry:flush",
      // console-explainer spec §6.6 (Retry after a failed scan); not in docs/SPEC.md §4.5.
      "overview:rescan",
    ];
```

- In "covers every SPEC section 4.5 main-to-renderer channel", replace `      "telemetry:ack",\n    ];` with:

```ts
      "telemetry:ack",
      // console-explainer spec §7 push hint; not in docs/SPEC.md §4.5.
      "trace:rowsAvailable",
    ];
```

- Replace the `describe("allChannelNames", …)` block (lines 195-201) with:

```ts
describe("allChannelNames", () => {
  it("returns 32 unique channel names", () => {
    const names = allChannelNames();
    expect(new Set(names).size).toBe(32);
    expect(names.length).toBe(32);
  });
});

describe("console-explainer channels", () => {
  it("validates the trace:rowsAvailable hint and refuses any content beyond sessionId and lastSeq", () => {
    expect(validatePayload("fromMain", "trace:rowsAvailable", { sessionId: "sess_1", lastSeq: 0 })).toEqual({
      ok: true,
      value: { sessionId: "sess_1", lastSeq: 0 },
    });
    const bad: unknown[] = [
      { sessionId: "", lastSeq: 1 },
      { sessionId: "sess_1", lastSeq: -1 },
      { sessionId: "sess_1", lastSeq: 1.5 },
      { sessionId: "sess_1" },
      { sessionId: "sess_1", lastSeq: 3, rows: [{ seq: 3 }] },
      { sessionId: "sess_1", lastSeq: 3, text: "agent output" },
    ];
    for (const payload of bad) {
      expect(validatePayload("fromMain", "trace:rowsAvailable", payload).ok, JSON.stringify(payload)).toBe(false);
    }
  });

  it("validates overview:rescan", () => {
    expect(validatePayload("toMain", "overview:rescan", { repoRoot: "/work/acme" })).toEqual({
      ok: true,
      value: { repoRoot: "/work/acme" },
    });
    expect(validatePayload("toMain", "overview:rescan", { repoRoot: "" }).ok).toBe(false);
    expect(validatePayload("toMain", "overview:rescan", {}).ok).toBe(false);
  });
});
```

In `apps/desktop/src/shared/ipc-registry.test.ts`, add inside `describe("ipc channel registry", …)`, after the test "bounds the read-only trace channels":

```ts
  it("registers the trace:rowsAvailable hint and the overview:rescan request from the contracts", () => {
    expect(parseFromMain("trace:rowsAvailable", { sessionId: "s1", lastSeq: 12 })).toEqual({
      sessionId: "s1",
      lastSeq: 12,
    });
    expect(() =>
      parseFromMain("trace:rowsAvailable", { sessionId: "s1", lastSeq: 12, rows: [] }),
    ).toThrowError(IpcError);
    expect(parseToMain("overview:rescan", { repoRoot: "/work/repo" })).toEqual({ repoRoot: "/work/repo" });
    expect(() => parseToMain("overview:rescan", {})).toThrowError(IpcError);
  });
```

In `apps/desktop/src/main/trace-allowlist.test.ts`, add inside the `describe`, after "a channel name outside the registry is refused for a trace window":

```ts
  it("keeps overview:rescan to the main window", () => {
    expect(toMainChannelNames()).toContain("overview:rescan");
    expect(isChannelAllowed("overview:rescan", "main")).toBe(true);
    expect(isChannelAllowed("overview:rescan", "trace")).toBe(false);
    expect(isChannelAllowed("overview:rescan", "other")).toBe(false);
  });
```

In `apps/desktop/src/shared/prefs.test.ts`:

- In the import list, add `normalizeExplainWithModel,` after `normalizeBudgetFraction,`.
- Replace the test "reads defaults when storage has nothing" with:

```ts
  it("reads defaults when storage has nothing; explaining with a model is on by default (E15)", () => {
    expect(readAgentPreferences(() => undefined)).toEqual(
      DEFAULT_AGENT_PREFERENCES,
    );
    expect(DEFAULT_AGENT_PREFERENCES).toEqual({
      model: "auto",
      reasoningEffort: "auto",
      usageBudgetFraction: null,
      explainWithModel: true,
    });
  });
```

- Replace the test "reads stored values and falls back on invalid ones" with:

```ts
  it("reads stored values and falls back on invalid ones", () => {
    const store = new Map<string, unknown>([
      ["agent.model", "gpt-5.6-luna"],
      ["agent.reasoningEffort", "xhigh"],
      ["agent.usageBudgetFraction", "0.25"],
      ["explainer.withModel", false],
    ]);
    expect(readAgentPreferences((key) => store.get(key))).toEqual({
      model: "gpt-5.6-luna",
      reasoningEffort: "xhigh",
      usageBudgetFraction: "0.25",
      explainWithModel: false,
    });

    const invalid = new Map<string, unknown>([
      ["agent.model", "gpt-9"],
      ["agent.reasoningEffort", "extreme"],
      ["agent.usageBudgetFraction", "2.0"],
      ["explainer.withModel", "no"],
    ]);
    expect(readAgentPreferences((key) => invalid.get(key))).toEqual(
      DEFAULT_AGENT_PREFERENCES,
    );
  });

  it("reads only a stored boolean as the explain setting", () => {
    expect(normalizeExplainWithModel(false)).toBe(false);
    expect(normalizeExplainWithModel(true)).toBe(true);
    for (const value of [undefined, null, 0, "false", "off", {}]) {
      expect(normalizeExplainWithModel(value), String(value)).toBe(true);
    }
  });
```

- Replace the test "applies patches and preserves untouched fields" with:

```ts
  it("applies patches and preserves untouched fields", () => {
    const current = {
      model: "auto" as const,
      reasoningEffort: "medium" as const,
      usageBudgetFraction: "0.50",
      explainWithModel: true,
    };
    expect(applyPreferencesPatch(current, { model: "gpt-5.6-sol" })).toEqual({
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
      usageBudgetFraction: "0.50",
      explainWithModel: true,
    });
    expect(
      applyPreferencesPatch(current, { usageBudgetFraction: null }),
    ).toEqual({
      model: "auto",
      reasoningEffort: "medium",
      usageBudgetFraction: null,
      explainWithModel: true,
    });
    expect(applyPreferencesPatch(current, { explainWithModel: false })).toEqual({
      ...current,
      explainWithModel: false,
    });
    expect(applyPreferencesPatch(current, {})).toEqual(current);
  });
```

In `apps/desktop/src/shared/prefs-ipc.test.ts`:

- Replace `SAMPLE_PREFS` (lines 6-10) with:

```ts
const SAMPLE_PREFS = {
  model: "gpt-5.6-luna",
  reasoningEffort: "xhigh",
  usageBudgetFraction: "0.25",
  explainWithModel: true,
};
```

- In "validates preferences:set patches", before `expect(() => parseToMain("preferences:set", {})).toThrowError();` add:

```ts
    expect(parseToMain("preferences:set", { explainWithModel: false })).toEqual({
      explainWithModel: false,
    });
    expect(() =>
      parseToMain("preferences:set", { explainWithModel: "no" }),
    ).toThrowError();
```

- In "validates preferences:updated snapshots", after the existing `toThrowError()` expectation add:

```ts
    expect(() =>
      parseFromMain("preferences:updated", {
        model: "gpt-5.6-luna",
        reasoningEffort: "xhigh",
        usageBudgetFraction: "0.25",
      }),
    ).toThrowError();
```

In `apps/desktop/src/main/ipc.test.ts`, append at the end of the file:

```ts
describe("explainWithModel preference (spec E15)", () => {
  it("defaults to on, persists an off switch and keeps it through other patches", async () => {
    const { db, state } = seedRepoAndSession();
    const { runtime } = stubRuntime();
    const handlers = registerAndCapture(makeDeps(db, runtime, state));
    const get = handlers.get("preferences:get")!;
    const set = handlers.get("preferences:set")!;

    await expect(get(TRUSTED_EVENT, {})).resolves.toMatchObject({ explainWithModel: true });
    await expect(set(TRUSTED_EVENT, { explainWithModel: false })).resolves.toMatchObject({
      model: "auto",
      explainWithModel: false,
    });
    expect(db.getPreference("explainer.withModel")).toBe(false);
    await expect(get(TRUSTED_EVENT, {})).resolves.toMatchObject({ explainWithModel: false });
    await expect(set(TRUSTED_EVENT, { model: "gpt-5.6-sol" })).resolves.toMatchObject({
      model: "gpt-5.6-sol",
      explainWithModel: false,
    });
    db.close();
  });
});
```

- [ ] **Step 2: Run the contracts test to verify it fails**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/contracts exec vitest run src/ipc.test.ts`

Expected: FAIL.
- The two "covers every SPEC section 4.5 …" tests fail with array diffs (the new channel is missing).
- "returns 32 unique channel names" fails with `expected 30 to be 32`.
- The `trace:rowsAvailable` and `overview:rescan` tests fail: `unknown channel`, so `ok` is `false`.

- [ ] **Step 3: Implement the contract channels**

In `packages/contracts/src/ipc.ts`:

- In `RendererToMainChannels`, after `  telemetryFlush: "telemetry:flush",` add:

```ts
  overviewRescan: "overview:rescan",
```

- In `MainToRendererChannels`, after `  telemetryAck: "telemetry:ack",` add:

```ts
  traceRowsAvailable: "trace:rowsAvailable",
```

- After `TelemetryAckPayloadSchema` (ends line 212) add:

```ts
/**
 * Console-explainer spec §7: main tells a window that rows up to lastSeq are stored, and
 * the window pulls them through trace:rows. Strict, because the hint carries no content
 * (spec §10) and sendToRenderer sends the caller's object after validating it.
 */
export const TraceRowsAvailablePayloadSchema = z
  .object({
    sessionId: z.string().min(1),
    lastSeq: z.number().int().nonnegative(),
  })
  .strict();

export type TraceRowsAvailablePayload = z.infer<typeof TraceRowsAvailablePayloadSchema>;

/** Console-explainer spec §6.6: Retry after a failed repo scan. Main window only (desktop trace-allowlist.ts). */
export const OverviewRescanPayloadSchema = z.object({
  repoRoot: z.string().min(1),
});

export type OverviewRescanPayload = z.infer<typeof OverviewRescanPayloadSchema>;
```

- In `rendererToMainPayloads`, after `  [RendererToMainChannels.telemetryFlush]: TelemetryFlushPayloadSchema,` add:

```ts
  [RendererToMainChannels.overviewRescan]: OverviewRescanPayloadSchema,
```

- In `mainToRendererPayloads`, after `  [MainToRendererChannels.telemetryAck]: TelemetryAckPayloadSchema,` add:

```ts
  [MainToRendererChannels.traceRowsAvailable]: TraceRowsAvailablePayloadSchema,
```

- [ ] **Step 4: Run the contracts test, typecheck and build**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/contracts exec vitest run src/ipc.test.ts`
Expected: PASS.

Run: `perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/contracts typecheck && perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/contracts build`
Expected: both exit 0.

- [ ] **Step 5: Run the desktop tests to verify they fail**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/shared/ipc-registry.test.ts src/main/trace-allowlist.test.ts src/shared/prefs.test.ts src/shared/prefs-ipc.test.ts src/main/ipc.test.ts`

Expected:
- `ipc-registry.test.ts` and `trace-allowlist.test.ts` PASS, because the rebuilt contracts already carry both channels. Their RED was the contracts failure in Step 2.
- `prefs.test.ts` FAILS: the default object lacks `explainWithModel`, and `normalizeExplainWithModel is not a function`.
- `prefs-ipc.test.ts` FAILS: `preferences:set { explainWithModel: false }` throws "at least one preference must be set".
- `ipc.test.ts` "explainWithModel preference" FAILS: `preferences:get` resolves without `explainWithModel`.

- [ ] **Step 6: Implement the preference**

In `apps/desktop/src/shared/prefs.ts`, replace lines 20-41 (from `export const AGENT_MODEL_PREF_KEY` to the end of `DEFAULT_AGENT_PREFERENCES`) with:

```ts
export const AGENT_MODEL_PREF_KEY = "agent.model";
export const REASONING_EFFORT_PREF_KEY = "agent.reasoningEffort";
export const USAGE_BUDGET_PREF_KEY = "agent.usageBudgetFraction";
/** Console-explainer spec E15: "Explain with a model". Off stops every narrator call. */
export const EXPLAIN_WITH_MODEL_PREF_KEY = "explainer.withModel";

export interface AgentPreferences {
  model: AgentModelOption;
  reasoningEffort: ReasoningEffortOption;
  /** Fraction of the usage budget in [0, 1] as a decimal string, or null when unknown. */
  usageBudgetFraction: string | null;
  /** On by default (spec E15). False: rule-based explainer data only, no model calls. */
  explainWithModel: boolean;
}

export interface AgentPreferencesPatch {
  model?: AgentModelOption;
  reasoningEffort?: ReasoningEffortOption;
  usageBudgetFraction?: string | null;
  explainWithModel?: boolean;
}

export const DEFAULT_AGENT_PREFERENCES: AgentPreferences = {
  model: "auto",
  reasoningEffort: "auto",
  usageBudgetFraction: null,
  explainWithModel: true,
};
```

Replace lines 98-121 (`readAgentPreferences` and `applyPreferencesPatch`) with:

```ts
/** Only a stored boolean counts; anything else (missing, corrupt) reads as the default, on. */
export function normalizeExplainWithModel(value: unknown): boolean {
  return typeof value === "boolean" ? value : true;
}

/** Reads the agent preferences through a storage getter, applying defaults. */
export function readAgentPreferences(
  get: (key: string) => unknown,
): AgentPreferences {
  return {
    model: normalizeModel(get(AGENT_MODEL_PREF_KEY)),
    reasoningEffort: normalizeReasoningEffort(get(REASONING_EFFORT_PREF_KEY)),
    usageBudgetFraction: normalizeBudgetFraction(get(USAGE_BUDGET_PREF_KEY)),
    explainWithModel: normalizeExplainWithModel(get(EXPLAIN_WITH_MODEL_PREF_KEY)),
  };
}

export function applyPreferencesPatch(
  current: AgentPreferences,
  patch: AgentPreferencesPatch,
): AgentPreferences {
  return {
    model: patch.model ?? current.model,
    reasoningEffort: patch.reasoningEffort ?? current.reasoningEffort,
    usageBudgetFraction:
      patch.usageBudgetFraction !== undefined
        ? patch.usageBudgetFraction
        : current.usageBudgetFraction,
    explainWithModel: patch.explainWithModel ?? current.explainWithModel,
  };
}
```

In `apps/desktop/src/shared/local-channels.ts`, replace lines 187-209 (`AgentPreferencesSchema` through the end of `PreferencesSetPayloadSchema`) with:

```ts
export const AgentPreferencesSchema = z.object({
  model: AGENT_MODEL_ENUM,
  reasoningEffort: REASONING_EFFORT_ENUM,
  usageBudgetFraction: z.union([BUDGET_FRACTION, z.null()]),
  explainWithModel: z.boolean(),
});

export type AgentPreferencesPayload = z.infer<typeof AgentPreferencesSchema>;

export const PreferencesGetPayloadSchema = z.object({});

export const PreferencesSetPayloadSchema = z
  .object({
    model: AGENT_MODEL_ENUM.optional(),
    reasoningEffort: REASONING_EFFORT_ENUM.optional(),
    usageBudgetFraction: z.union([BUDGET_FRACTION, z.null()]).optional(),
    explainWithModel: z.boolean().optional(),
  })
  .refine(
    (patch) =>
      patch.model !== undefined ||
      patch.reasoningEffort !== undefined ||
      patch.usageBudgetFraction !== undefined ||
      patch.explainWithModel !== undefined,
    { message: "at least one preference must be set" },
  );
```

In `apps/desktop/src/main/ipc.ts`, replace lines 25-31 (the `../shared/prefs.js` import) with:

```ts
import {
  AGENT_MODEL_PREF_KEY,
  EXPLAIN_WITH_MODEL_PREF_KEY,
  REASONING_EFFORT_PREF_KEY,
  USAGE_BUDGET_PREF_KEY,
  applyPreferencesPatch,
  readAgentPreferences,
} from "../shared/prefs.js";
```

In the `preferencesSet` handler, replace

```ts
    // null marks the "unknown" state; storage has no deletePreference.
    deps.db.setPreference(USAGE_BUDGET_PREF_KEY, next.usageBudgetFraction);
```

with

```ts
    // null marks the "unknown" state; storage has no deletePreference.
    deps.db.setPreference(USAGE_BUDGET_PREF_KEY, next.usageBudgetFraction);
    deps.db.setPreference(EXPLAIN_WITH_MODEL_PREF_KEY, next.explainWithModel);
```

- [ ] **Step 7: Run the desktop tests and typecheck**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/shared/ipc-registry.test.ts src/main/trace-allowlist.test.ts src/shared/prefs.test.ts src/shared/prefs-ipc.test.ts src/main/ipc.test.ts`
Expected: PASS.

Run: `perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop typecheck`
Expected: exits 0, including `tsconfig.web.json`, which type-checks `App.tsx` and `AgentSettings.tsx` against the widened `AgentPreferences`.

- [ ] **Step 8: Package suites and lint**

Run, one per call, each under the wrapper:
- `pnpm --filter @jevcode/contracts test`
- `pnpm --filter jevcode-desktop test`
- `perl -e 'alarm 170; exec @ARGV' pnpm lint`

Expected: each exits 0.

- [ ] **Step 9: Commit**

```bash
git add packages/contracts/src/ipc.ts packages/contracts/src/ipc.test.ts \
  apps/desktop/src/shared/prefs.ts apps/desktop/src/shared/prefs.test.ts \
  apps/desktop/src/shared/local-channels.ts apps/desktop/src/shared/prefs-ipc.test.ts \
  apps/desktop/src/shared/ipc-registry.test.ts apps/desktop/src/main/trace-allowlist.test.ts \
  apps/desktop/src/main/ipc.ts apps/desktop/src/main/ipc.test.ts
git commit -m "feat(contracts): add trace:rowsAvailable, overview:rescan and the explainWithModel preference"
```

---

### Task K-4: Storage: schemas in `eventStoreSchemas`, migration v5, cache and state methods, TraceReader and export

**Files:**
- Modify: `packages/storage/src/db.ts` (imports at lines 8-18 and 19-28; `eventStoreSchemas` from K-1; `appendEvent` lines 264-271; new methods before the `// Preferences` banner, line 943; `applyProjection` switch, lines 998-1043)
- Modify: `packages/storage/src/migrations.ts` (after line 312; line 314)
- Modify: `packages/storage/src/index.ts` (type exports)
- Modify: `packages/storage/src/fixtures.ts` (append fixtures)
- Modify: `apps/desktop/src/main/trace-bundle.ts` (`buildTraceBundle` re-caps redacted strings of `overview_snapshot` and `explainer` rows to the K-2 schema limits; ruling F16)
- Test: `packages/storage/src/db.test.ts`, `packages/storage/src/explainer-store.test.ts` (create), `packages/storage/src/trace-reader.test.ts`, `apps/desktop/src/main/trace-bundle.test.ts`

**Interfaces:**
- Consumes:
  - K-1: `EVENT_TYPES`, `TRACE_ROW_TYPES`, `TRACE_BUNDLE_VERSION`, `parseTraceBundle`.
  - K-2: `OverviewSnapshotSchema`, `ExplainerRecordSchema`, `ComponentSchema`, `RoleSchema`, `OVERVIEW_SNAPSHOT_MAX_BYTES`, `type OverviewSnapshot`, `type Role`.
- Produces (on `JevcodeDb`, from `@jevcode/storage`):
  - `appendEvent(sessionId, "overview_snapshot", snapshot)` and `appendEvent(sessionId, "explainer", record)`. Both validate against the K-2 schemas. A snapshot over `OVERVIEW_SNAPSHOT_MAX_BYTES` UTF-8 bytes of stored JSON throws `TypeError` and uses no seq.
  - `getComponentText(repoRoot: string, componentId: string, contentHash: string): ComponentTextValue | undefined`
  - `putComponentText(repoRoot: string, componentId: string, contentHash: string, value: ComponentTextValue): void`
  - `getOverviewState(repoRoot: string): OverviewStateValue | undefined`
  - `putOverviewState(repoRoot: string, state: OverviewStateValue): void`
  - `type ComponentTextValue = { purpose: string | null; role: Role; model: string }`
  - `type OverviewStateValue = { snapshot: OverviewSnapshot; narrativeInputsHash: string | null; narrative: OverviewSnapshot["narrative"] }`
  - `LATEST_SCHEMA_VERSION = 5`

  Consumers: lane 04 M-6 (rows, overview state), lane 05 N-3 (component text cache, narrative hash).
- Produces (behavior):
  - `TraceReader.rows(…, TRACE_ROW_TYPES)` and `payloads()` return the new rows (no code change in the reader or `trace-service.ts`).
  - `buildTraceBundle` writes v2 bundles that include and redact them, and re-caps the redacted strings of `overview_snapshot` and `explainer` rows to the K-2 limits: `purpose` 140, `name` 120, `language` 40, a sentence's `text` 220, a citation `id` 512, an edge example 300, an external's `name` 214 and `status.scan.error` 200 (ruling F16). `export function capRedactedRow(type: string, payload: unknown): unknown` in `trace-bundle.ts` is the pure helper.

- [ ] **Step 1: Write the failing tests**

Append to `packages/storage/src/fixtures.ts`. Extend its type import (lines 1-7) with `ExplainerRecord` and `OverviewSnapshot`:

```ts
import type {
  ChangeUnit,
  Decision,
  EvidenceFact,
  ExplainerRecord,
  JevDecisionLog,
  NormalizedAgentEvent,
  OverviewSnapshot,
} from "@jevcode/contracts";
```

and at the end of the file:

```ts
export const COMPONENT_ID = "cmp_0123456789ab";

export function makeOverviewSnapshot(overrides: Partial<OverviewSnapshot> = {}): OverviewSnapshot {
  return {
    sessionId: SESSION,
    repoRoot: "/work/fixture",
    scanId: "scan_1",
    partial: false,
    counts: { files: 2, components: 1, edges: 0, languages: ["TypeScript"] },
    components: [
      {
        id: COMPONENT_ID,
        rootPath: "packages/core",
        name: "@fixture/core",
        fileCount: 2,
        files: ["packages/core/src/a.ts", "packages/core/src/b.ts"],
        language: "TypeScript",
        roleGuess: "domain",
        role: "domain",
        purpose: null,
        provenance: "rule",
        contentHash: "0".repeat(40),
        externalDeps: [],
        entryPoints: ["packages/core/src/a.ts"],
        importsAnalyzed: true,
      },
    ],
    edges: [],
    externals: [],
    narrative: null,
    generatedAt: TS,
    ...overrides,
  };
}

export function makeExplainerStory(overrides: { sessionId?: string; basisSeq?: number } = {}): ExplainerRecord {
  return {
    sessionId: overrides.sessionId ?? SESSION,
    kind: "story",
    sentences: [{ text: "The agent added a session cache.", citations: [{ kind: "component", id: COMPONENT_ID }] }],
    basisSeq: overrides.basisSeq ?? 1,
  };
}
```

In `packages/storage/src/db.test.ts`, change the import from `./index.js` (lines 16-21) to:

```ts
import {
  EVENT_TYPES,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  defaultDbPath,
  openDb,
} from "./index.js";
import { makeOverviewSnapshot } from "./fixtures.js";
```

and add inside `describe("openDb", …)`, after "upgrades an existing v2 database in place":

```ts
  it("upgrades a v4 database built by migrations 1-4 to v5 without touching its rows", () => {
    const dbPath = tempDbPath();
    const TS0 = "2026-09-01T00:00:00.000Z";
    const v4 = new Database(dbPath);
    v4.exec("CREATE TABLE schema_version (version INTEGER NOT NULL, appliedAt TEXT NOT NULL)");
    for (const migration of MIGRATIONS) {
      if (migration.version > 4) continue;
      v4.transaction(() => {
        migration.up(v4);
        v4.prepare("INSERT INTO schema_version (version, appliedAt) VALUES (?, ?)").run(migration.version, TS0);
      })();
    }
    v4.prepare(
      "INSERT INTO repositories (id, path, gitRoot, name, lastOpenedAt, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("repo_v4", "/work/v4", "/work/v4", "v4", TS0, TS0);
    v4.prepare(
      "INSERT INTO sessions (id, repoId, prompt, lastEventSeq, startedAt, createdAt) VALUES (?, ?, ?, 1, ?, ?)",
    ).run("sess_v4", "repo_v4", "old prompt", TS0, TS0);
    v4.prepare(
      "INSERT INTO events (id, sessionId, seq, type, payloadJson, ts) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "evt_v4",
      "sess_v4",
      1,
      "agent_event",
      JSON.stringify({ type: "agent_started", sessionId: "sess_v4", prompt: "old prompt", ts: TS0 }),
      TS0,
    );
    expect(v4.prepare("SELECT MAX(version) AS v FROM schema_version").get()).toEqual({ v: 4 });
    expect(
      v4
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('component_text_cache', 'overview_state')")
        .all(),
    ).toEqual([]);
    v4.close();

    const db = openDb({ dbPath });
    expect(LATEST_SCHEMA_VERSION).toBe(5);
    expect(db.schemaVersion()).toBe(5);

    const raw = new Database(dbPath);
    const columns = (table: string) =>
      (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string; pk: number; notnull: number }[]).map(
        (column) => [column.name, column.pk, column.notnull],
      );
    expect(columns("component_text_cache")).toEqual([
      ["repo_root", 1, 1],
      ["component_id", 2, 1],
      ["content_hash", 3, 1],
      ["purpose", 0, 0],
      ["role", 0, 1],
      ["model", 0, 1],
      ["created_at", 0, 1],
    ]);
    expect(columns("overview_state")).toEqual([
      ["repo_root", 1, 0],
      ["snapshot_json", 0, 1],
      ["narrative_inputs_hash", 0, 0],
      ["narrative_json", 0, 0],
      ["updated_at", 0, 1],
    ]);
    expect(raw.prepare("SELECT version FROM schema_version ORDER BY version").all()).toEqual(
      [1, 2, 3, 4, 5].map((version) => ({ version })),
    );
    raw.close();

    // Rows written at v4 are untouched and the session's seq continues gaplessly.
    expect(db.listEvents("sess_v4").map((event) => [event.seq, event.type])).toEqual([[1, "agent_event"]]);
    const appended = db.appendEvent(
      "sess_v4",
      "overview_snapshot",
      makeOverviewSnapshot({ sessionId: "sess_v4", repoRoot: "/work/v4" }),
    );
    expect(appended.seq).toBe(2);
    expect(db.getSession("sess_v4")?.lastEventSeq).toBe(2);
    db.putComponentText("/work/v4", "cmp_0123456789ab", "1".repeat(40), { purpose: "Core logic.", role: "domain", model: "m" });
    db.close();

    const reopened = openDb({ dbPath });
    expect(reopened.schemaVersion()).toBe(5);
    expect(reopened.getComponentText("/work/v4", "cmp_0123456789ab", "1".repeat(40))?.purpose).toBe("Core logic.");
    reopened.close();
  });
```

Create `packages/storage/src/explainer-store.test.ts`:

```ts
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { OVERVIEW_SNAPSHOT_MAX_BYTES } from "@jevcode/contracts";
import type { OverviewSnapshot } from "@jevcode/contracts";

import { COMPONENT_ID, SESSION, TS, makeExplainerStory, makeOverviewSnapshot } from "./fixtures.js";
import { openDb } from "./index.js";
import { openSessionDb, openTempDb, tempDbPath } from "./test-utils.js";

const H1 = "1".repeat(40);
const H2 = "2".repeat(40);
const MODEL = "claude-haiku-4-5-20251001";
const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

describe("overview_snapshot and explainer rows", () => {
  it("appends all four record shapes with gapless seqs and returns the stored payload", () => {
    const db = openSessionDb();
    db.appendAgentEvent(SESSION, { type: "agent_started", sessionId: SESSION, prompt: "go", ts: TS });
    const snapshot = db.appendEvent(SESSION, "overview_snapshot", makeOverviewSnapshot());
    const story = db.appendEvent(SESSION, "explainer", makeExplainerStory());
    const why = db.appendEvent(SESSION, "explainer", {
      sessionId: SESSION,
      kind: "decision_why",
      decisionId: "dec_1",
      sentence: { text: "Chosen to keep reads off the hot path.", citations: [{ kind: "decision", id: "dec_1" }] },
    });
    const highlights = db.appendEvent(SESSION, "explainer", {
      sessionId: SESSION,
      kind: "highlights",
      basisSeq: 3,
      components: [{ id: COMPONENT_ID, state: "changed", unitIds: ["unit_1"] }],
    });
    expect([snapshot, story, why, highlights].map((event) => [event.seq, event.type])).toEqual([
      [2, "overview_snapshot"],
      [3, "explainer"],
      [4, "explainer"],
      [5, "explainer"],
    ]);
    expect(db.getSession(SESSION)?.lastEventSeq).toBe(5);
    expect(JSON.parse(snapshot.payloadJson)).toEqual(makeOverviewSnapshot());
    expect(JSON.parse(story.payloadJson)).toEqual(makeExplainerStory());
    db.close();
  });

  it("rejects invalid payloads, a foreign sessionId and an unknown session without using a seq", () => {
    const db = openSessionDb();
    const component = makeOverviewSnapshot().components[0];
    const cases: Array<[string, "overview_snapshot" | "explainer", unknown]> = [
      [SESSION, "overview_snapshot", { ...makeOverviewSnapshot(), partial: "no" }],
      [SESSION, "overview_snapshot", { ...makeOverviewSnapshot(), components: [{ ...component, role: "external" }] }],
      [SESSION, "overview_snapshot", { ...makeOverviewSnapshot(), narrative: { sentences: [], provenance: "rule" } }],
      [SESSION, "overview_snapshot", makeOverviewSnapshot({ sessionId: "sess_other" })],
      [SESSION, "explainer", { sessionId: SESSION, kind: "story", sentences: [], basisSeq: 1 }],
      [SESSION, "explainer", { sessionId: SESSION, kind: "summary", sentences: [] }],
      [SESSION, "explainer", makeExplainerStory({ sessionId: "sess_other" })],
      ["sess_missing", "explainer", makeExplainerStory({ sessionId: "sess_missing" })],
    ];
    for (const [sessionId, type, payload] of cases) {
      expect(() => db.appendEvent(sessionId, type, payload), `${type} ${JSON.stringify(payload).slice(0, 80)}`).toThrow(TypeError);
    }
    expect(db.getEventCount(SESSION)).toBe(0);
    expect(db.getSession(SESSION)?.lastEventSeq).toBe(0);
    db.close();
  });

  it("enforces the 512 KB snapshot cap at append, counting UTF-8 bytes of the stored JSON", () => {
    const db = openSessionDb();
    const base = makeOverviewSnapshot();
    const room = OVERVIEW_SNAPSHOT_MAX_BYTES - byteLength(base);
    const padded = (extra: string): OverviewSnapshot => makeOverviewSnapshot({ scanId: `${base.scanId}${extra}` });

    const atCap = padded("x".repeat(room));
    expect(byteLength(atCap)).toBe(OVERVIEW_SNAPSHOT_MAX_BYTES);
    expect(db.appendEvent(SESSION, "overview_snapshot", atCap).seq).toBe(1);

    expect(() => db.appendEvent(SESSION, "overview_snapshot", padded("x".repeat(room + 1)))).toThrow(
      /over the 524288-byte cap/,
    );

    // "é" is 2 UTF-8 bytes: this payload has fewer characters than the cap but more bytes.
    const multiByte = padded("é".repeat(Math.ceil((room + 1) / 2)));
    expect(JSON.stringify(multiByte).length).toBeLessThan(OVERVIEW_SNAPSHOT_MAX_BYTES);
    expect(byteLength(multiByte)).toBeGreaterThan(OVERVIEW_SNAPSHOT_MAX_BYTES);
    expect(() => db.appendEvent(SESSION, "overview_snapshot", multiByte)).toThrow(TypeError);

    expect(db.getSession(SESSION)?.lastEventSeq).toBe(1);
    expect(db.getEventCount(SESSION)).toBe(1);
    db.close();
  });
});

describe("component_text_cache", () => {
  it("round-trips by (repo root, component id, content hash) and misses on any other key", () => {
    const db = openTempDb();
    expect(db.getComponentText("/work/a", COMPONENT_ID, H1)).toBeUndefined();
    const value = { purpose: "Stores sessions and events in SQLite.", role: "storage" as const, model: MODEL };
    db.putComponentText("/work/a", COMPONENT_ID, H1, value);
    expect(db.getComponentText("/work/a", COMPONENT_ID, H1)).toEqual(value);
    expect(db.getComponentText("/work/a", COMPONENT_ID, H2)).toBeUndefined();
    expect(db.getComponentText("/work/b", COMPONENT_ID, H1)).toBeUndefined();
    expect(db.getComponentText("/work/a", "cmp_ffffffffffff", H1)).toBeUndefined();

    // A new content hash adds an entry and keeps the old one; the same key replaces.
    db.putComponentText("/work/a", COMPONENT_ID, H2, { purpose: null, role: "domain", model: MODEL });
    expect(db.getComponentText("/work/a", COMPONENT_ID, H1)).toEqual(value);
    expect(db.getComponentText("/work/a", COMPONENT_ID, H2)).toEqual({ purpose: null, role: "domain", model: MODEL });
    db.putComponentText("/work/a", COMPONENT_ID, H1, { purpose: "Persists the event log.", role: "storage", model: "m2" });
    expect(db.getComponentText("/work/a", COMPONENT_ID, H1)).toEqual({
      purpose: "Persists the event log.",
      role: "storage",
      model: "m2",
    });
    db.close();
  });

  it("refuses values outside the contract and survives a reopen", () => {
    const dbPath = tempDbPath();
    const db = openDb({ dbPath });
    const bad: unknown[] = [
      { purpose: "p".repeat(141), role: "storage", model: MODEL },
      { purpose: "ok", role: "external", model: MODEL },
      { purpose: "ok", role: "storage", model: "" },
    ];
    for (const value of bad) {
      expect(() => db.putComponentText("/w", COMPONENT_ID, H1, value as never), JSON.stringify(value)).toThrow(TypeError);
    }
    expect(db.getComponentText("/w", COMPONENT_ID, H1)).toBeUndefined();
    db.putComponentText("/w", COMPONENT_ID, H1, { purpose: "p".repeat(140), role: "ui", model: MODEL });
    db.close();

    const reopened = openDb({ dbPath });
    expect(reopened.getComponentText("/w", COMPONENT_ID, H1)).toEqual({ purpose: "p".repeat(140), role: "ui", model: MODEL });
    reopened.close();
  });

  it("reads a stored row whose role this build does not know as a miss", () => {
    const dbPath = tempDbPath();
    const db = openDb({ dbPath });
    db.putComponentText("/w", COMPONENT_ID, H1, { purpose: "ok", role: "ui", model: MODEL });
    db.close();
    const raw = new Database(dbPath);
    raw.prepare("UPDATE component_text_cache SET role = 'external'").run();
    raw.close();
    const reopened = openDb({ dbPath });
    expect(reopened.getComponentText("/w", COMPONENT_ID, H1)).toBeUndefined();
    reopened.close();
  });
});

describe("overview_state", () => {
  const narrative: OverviewSnapshot["narrative"] = {
    sentences: [{ text: "Fixture is a one-package workspace.", citations: [{ kind: "component", id: COMPONENT_ID }] }],
    provenance: "model",
  };

  it("round-trips the latest snapshot, narrative and inputs hash per repo root", () => {
    const db = openTempDb();
    expect(db.getOverviewState("/work/fixture")).toBeUndefined();
    db.putOverviewState("/work/fixture", { snapshot: makeOverviewSnapshot(), narrativeInputsHash: "inputs_1", narrative });
    expect(db.getOverviewState("/work/fixture")).toEqual({
      snapshot: makeOverviewSnapshot(),
      narrativeInputsHash: "inputs_1",
      narrative,
    });
    const next = makeOverviewSnapshot({ scanId: "scan_2" });
    db.putOverviewState("/work/fixture", { snapshot: next, narrativeInputsHash: null, narrative: null });
    expect(db.getOverviewState("/work/fixture")).toEqual({ snapshot: next, narrativeInputsHash: null, narrative: null });
    expect(db.getOverviewState("/work/other")).toBeUndefined();
    db.close();
  });

  it("refuses an invalid snapshot, an invalid narrative and a snapshot of another repo root", () => {
    const db = openTempDb();
    expect(() =>
      db.putOverviewState("/work/fixture", {
        snapshot: { ...makeOverviewSnapshot(), scanId: "" },
        narrativeInputsHash: null,
        narrative: null,
      }),
    ).toThrow(TypeError);
    expect(() =>
      db.putOverviewState("/work/fixture", {
        snapshot: makeOverviewSnapshot(),
        narrativeInputsHash: null,
        narrative: { sentences: [{ text: "Uncited.", citations: [] }], provenance: "model" },
      }),
    ).toThrow(TypeError);
    expect(() =>
      db.putOverviewState("/work/elsewhere", { snapshot: makeOverviewSnapshot(), narrativeInputsHash: null, narrative: null }),
    ).toThrow(/repoRoot/);
    expect(db.getOverviewState("/work/fixture")).toBeUndefined();
    expect(db.getOverviewState("/work/elsewhere")).toBeUndefined();
    db.close();
  });

  it("reads corrupt or out-of-contract stored state as a miss", () => {
    const dbPath = tempDbPath();
    const db = openDb({ dbPath });
    db.putOverviewState("/a", { snapshot: makeOverviewSnapshot({ repoRoot: "/a" }), narrativeInputsHash: null, narrative });
    db.putOverviewState("/b", { snapshot: makeOverviewSnapshot({ repoRoot: "/b" }), narrativeInputsHash: null, narrative });
    db.close();
    const raw = new Database(dbPath);
    raw.prepare("UPDATE overview_state SET snapshot_json = '{' WHERE repo_root = '/a'").run();
    raw.prepare(`UPDATE overview_state SET narrative_json = '{"sentences":[],"provenance":"rule"}' WHERE repo_root = '/b'`).run();
    raw.close();
    const reopened = openDb({ dbPath });
    expect(reopened.getOverviewState("/a")).toBeUndefined();
    expect(reopened.getOverviewState("/b")).toBeUndefined();
    reopened.close();
  });
});
```

In `packages/storage/src/trace-reader.test.ts`:

- Change the `./fixtures.js` import (lines 6-15) to:

```ts
import {
  REPO,
  SESSION,
  TS,
  makeAgentEvent,
  makeChangeUnit,
  makeDecision,
  makeExplainerStory,
  makeFact,
  makeJevLog,
  makeOverviewSnapshot,
} from "./fixtures.js";
```

- Add inside `describe("openTraceReader", …)`, after "pages trace-type rows exactly once and never returns hidden types":

```ts
  it("serves overview_snapshot and explainer rows through rows() and payloads()", () => {
    const db = openSessionDb();
    db.appendAgentEvent(SESSION, { type: "agent_started", sessionId: SESSION, prompt: "Seed", ts: TS });
    db.appendEvent(SESSION, "overview_snapshot", makeOverviewSnapshot());
    db.appendTelemetry("agent_event_count", {}, SESSION);
    db.appendEvent(SESSION, "explainer", makeExplainerStory());
    const reader = openTraceReader(db.dbPath);
    const page = reader.rows(SESSION, 0, 50, TRACE_ROW_TYPES);
    expect(page.rows.map((row) => [row.seq, row.type])).toEqual([
      [1, "agent_event"],
      [2, "overview_snapshot"],
      [4, "explainer"],
    ]);
    expect(page.lastSeq).toBe(4);
    expect(JSON.parse(page.rows[1]?.payloadJson ?? "null")).toEqual(makeOverviewSnapshot());
    expect(reader.payloads(SESSION, [2, 4]).map((row) => row.type)).toEqual(["overview_snapshot", "explainer"]);
    reader.close();
    db.close();
  });
```

In `apps/desktop/src/main/trace-bundle.test.ts`:

- Replace line 5 (`import { TraceBundleSchema } from "@jevcode/contracts";`) with:

```ts
import { ExplainerRecordSchema, OverviewSnapshotSchema, TraceBundleSchema } from "@jevcode/contracts";
```

- After line 6 (`import { openDb, openTraceReader } from "@jevcode/storage";`) add:

```ts
import { parseTraceBundle } from "@jevcode/trace-viewer/sources";
```

- Add inside `describe("trace bundle", …)`, after "redacts tokens and maps home":

```ts
  it("exports overview and explainer rows in a redacted v2 bundle that the viewer parser accepts; v1 still parses", () => {
    const db = openDb({ dbPath: path.join(tempDir(), "explainer.db") });
    db.upsertRepository({ id: REPO, path: "/work/bundle", gitRoot: "/work/bundle" });
    db.createSession({ id: SESSION, repoId: REPO, prompt: "Map it" });
    db.appendAgentEvent(SESSION, { type: "agent_started", sessionId: SESSION, prompt: "Map it", ts: TS });
    const componentId = "cmp_0123456789ab";
    db.appendEvent(SESSION, "overview_snapshot", {
      sessionId: SESSION,
      repoRoot: `${HOME}/repo`,
      scanId: "scan_1",
      partial: false,
      counts: { files: 1, components: 1, edges: 0, languages: ["TypeScript"] },
      components: [
        {
          id: componentId,
          rootPath: "src",
          name: "src",
          fileCount: 1,
          files: ["src/a.ts"],
          language: "TypeScript",
          roleGuess: "domain",
          role: "domain",
          purpose: "Reads token=abc123secret from env.",
          provenance: "model",
          contentHash: "0".repeat(40),
          externalDeps: [],
          entryPoints: [],
          importsAnalyzed: true,
        },
      ],
      edges: [],
      externals: [],
      narrative: null,
      generatedAt: TS,
    });
    db.appendEvent(SESSION, "explainer", {
      sessionId: SESSION,
      kind: "story",
      sentences: [{ text: "The agent mapped the repo.", citations: [{ kind: "file", id: `${HOME}/repo/src/a.ts` }] }],
      basisSeq: 2,
    });
    const reader = openTraceReader(db.dbPath);
    closers.push(() => {
      reader.close();
      db.close();
    });

    const bundle = buildTraceBundle(createTraceService(reader), SESSION, {
      homeDir: HOME,
      now: () => "2026-10-02T12:00:00.000Z",
    });
    expect(bundle.version).toBe(2);
    expect(bundle.rows.map((row) => row.type)).toEqual(["agent_event", "overview_snapshot", "explainer"]);
    const text = JSON.stringify(bundle);
    expect(text).not.toContain("abc123secret");
    expect(text).not.toContain(`${HOME}/`);
    expect(bundle.redactionCount).toBe(1);
    // Redacted rows still satisfy their contracts, so the viewer's fold can read them.
    const snapshot = OverviewSnapshotSchema.parse(bundle.rows[1]?.payload);
    expect(snapshot.repoRoot).toBe("~/repo");
    expect(snapshot.components[0]?.purpose).toBe("Reads token=[REDACTED:token] from env.");
    expect(ExplainerRecordSchema.parse(bundle.rows[2]?.payload)).toMatchObject({
      kind: "story",
      sentences: [{ citations: [{ kind: "file", id: "~/repo/src/a.ts" }] }],
    });

    expect(parseTraceBundle(JSON.parse(JSON.stringify(bundle)))).toMatchObject({ ok: true, bundle: { version: 2 } });
    const v1 = { ...bundle, version: 1, rows: bundle.rows.filter((row) => row.type === "agent_event") };
    expect(parseTraceBundle(JSON.parse(JSON.stringify(v1)))).toMatchObject({ ok: true, bundle: { version: 1 } });
    expect(parseTraceBundle({ ...v1, version: 3 })).toMatchObject({ ok: false, code: "UNSUPPORTED_VERSION" });
  });
```

- [ ] **Step 2: Run the storage tests to verify they fail**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/storage exec vitest run src/db.test.ts src/explainer-store.test.ts src/trace-reader.test.ts`

Expected: FAIL.
- `db.test.ts` "upgrades a v4 database …": `expected 4 to be 5` at `LATEST_SCHEMA_VERSION`.
- `explainer-store.test.ts`: every `appendEvent` of the new types throws `appendEvent(overview_snapshot): invalid payload` (the K-1 `z.never()` placeholder), and `db.getComponentText is not a function`.
- `trace-reader.test.ts` "serves overview_snapshot and explainer rows …" throws on the first `appendEvent` of a new type.

- [ ] **Step 3: Write the migration**

In `packages/storage/src/migrations.ts`, after the `v4` migration (ends line 312) add:

```ts
// Console-explainer spec §6.4: narrator text cache and the latest overview per repo.
const v5: Migration = {
  version: 5,
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS component_text_cache (
        repo_root TEXT NOT NULL,
        component_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        purpose TEXT,
        role TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (repo_root, component_id, content_hash)
      );

      CREATE TABLE IF NOT EXISTS overview_state (
        repo_root TEXT PRIMARY KEY,
        snapshot_json TEXT NOT NULL,
        narrative_inputs_hash TEXT,
        narrative_json TEXT,
        updated_at TEXT NOT NULL
      );
    `);
  },
};
```

Change line 314 to:

```ts
export const MIGRATIONS: Migration[] = [v1, v2, v3, v4, v5];
```

- [ ] **Step 4: Write the storage implementation**

In `packages/storage/src/db.ts`, replace the `@jevcode/contracts` value import and type import (lines 10-28) with:

```ts
import {
  ChangeUnitSchema,
  ComponentSchema,
  DecisionSchema,
  EVENT_TYPES,
  EvidenceFactSchema,
  ExplainerRecordSchema,
  JevDecisionLogSchema,
  NormalizedAgentEventSchema,
  OVERVIEW_SNAPSHOT_MAX_BYTES,
  OverviewSnapshotSchema,
  RoleSchema,
  ValidationResultSchema,
} from "@jevcode/contracts";
import type {
  AgentState,
  ChangeUnit,
  Decision,
  EventStoreType,
  EvidenceFact,
  JevDecisionLog,
  NormalizedAgentEvent,
  OverviewSnapshot,
  Role,
  ValidationResult,
} from "@jevcode/contracts";
```

Replace the K-1 block (from the comment `// K-1 placeholder (console-explainer lane 01): …` through the end of `eventStoreSchemas`) with:

```ts
const eventStoreSchemas = {
  agent_event: NormalizedAgentEventSchema,
  evidence_fact: EvidenceFactSchema,
  change_unit: ChangeUnitSchema,
  decision: DecisionSchema,
  validation: ValidationResultSchema,
  failure: FailureRecordSchema,
  jev_decision: JevDecisionLogSchema,
  ui_intent: UiIntentRecordSchema,
  ui_snapshot: UiSnapshotSchema,
  graph_node: GraphNodeRecordSchema,
  graph_edge: GraphEdgeRecordSchema,
  command: CommandRecordSchema,
  semantic_event: SemanticEventRecordSchema,
  telemetry: TelemetryEventSchema,
  overview_snapshot: OverviewSnapshotSchema,
  explainer: ExplainerRecordSchema,
} as const satisfies Record<EventStoreType, z.ZodTypeAny>;

/** A cached narrator description (console-explainer spec §6.4), keyed by (repo root, component id, content hash). */
export interface ComponentTextValue {
  purpose: string | null;
  role: Role;
  model: string;
}

/** The latest overview of a repo and its cached narrative (spec §6.4). */
export interface OverviewStateValue {
  snapshot: OverviewSnapshot;
  narrativeInputsHash: string | null;
  narrative: OverviewSnapshot["narrative"];
}

const ComponentTextValueSchema = z.object({
  purpose: ComponentSchema.shape.purpose,
  role: RoleSchema,
  model: z.string().min(1),
}) satisfies z.ZodType<ComponentTextValue>;

const OverviewStateValueSchema = z.object({
  snapshot: OverviewSnapshotSchema,
  narrativeInputsHash: z.string().min(1).nullable(),
  narrative: OverviewSnapshotSchema.shape.narrative,
}) satisfies z.ZodType<OverviewStateValue>;
```

In `appendEvent`, replace lines 264-271:

```ts
    const event: EventRow = {
      id: newId("evt"),
      sessionId,
      seq: 0,
      type,
      payloadJson: JSON.stringify(value),
      ts: nowIso(),
    };
```

with:

```ts
    const payloadJson = JSON.stringify(value);
    if (type === "overview_snapshot") {
      // Spec §5.5: measured on exactly what is stored, before a seq is taken.
      const bytes = Buffer.byteLength(payloadJson, "utf8");
      if (bytes > OVERVIEW_SNAPSHOT_MAX_BYTES) {
        throw new TypeError(
          `appendEvent(overview_snapshot): payload is ${bytes} bytes, over the ${OVERVIEW_SNAPSHOT_MAX_BYTES}-byte cap`,
        );
      }
    }
    const event: EventRow = {
      id: newId("evt"),
      sessionId,
      seq: 0,
      type,
      payloadJson,
      ts: nowIso(),
    };
```

Before the `// Preferences` banner (the three lines starting at line 943 with `// ------------------------------------------------------------------`), insert:

```ts
  // ------------------------------------------------------------------
  // Explainer cache (console-explainer spec §6.4). Caches only: a row this
  // build cannot parse reads as a miss, and puts validate before writing.
  // ------------------------------------------------------------------

  getComponentText(
    repoRoot: string,
    componentId: string,
    contentHash: string,
  ): ComponentTextValue | undefined {
    const row = this.db
      .prepare(
        "SELECT purpose, role, model FROM component_text_cache WHERE repo_root = ? AND component_id = ? AND content_hash = ?",
      )
      .get(repoRoot, componentId, contentHash) as unknown;
    if (row === undefined) return undefined;
    const parsed = ComponentTextValueSchema.safeParse(row);
    return parsed.success ? parsed.data : undefined;
  }

  putComponentText(
    repoRoot: string,
    componentId: string,
    contentHash: string,
    value: ComponentTextValue,
  ): void {
    const parsed = ComponentTextValueSchema.safeParse(value);
    if (!parsed.success) {
      throw new TypeError(`putComponentText(${componentId}): invalid value: ${parsed.error.message}`);
    }
    this.db
      .prepare(
        "INSERT INTO component_text_cache (repo_root, component_id, content_hash, purpose, role, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(repo_root, component_id, content_hash) DO UPDATE SET purpose = excluded.purpose, role = excluded.role, model = excluded.model, created_at = excluded.created_at",
      )
      .run(repoRoot, componentId, contentHash, parsed.data.purpose, parsed.data.role, parsed.data.model, nowIso());
  }

  getOverviewState(repoRoot: string): OverviewStateValue | undefined {
    const row = this.db
      .prepare(
        "SELECT snapshot_json, narrative_inputs_hash, narrative_json FROM overview_state WHERE repo_root = ?",
      )
      .get(repoRoot) as
      | { snapshot_json: string; narrative_inputs_hash: string | null; narrative_json: string | null }
      | undefined;
    if (row === undefined) return undefined;
    let raw: unknown;
    try {
      raw = {
        snapshot: JSON.parse(row.snapshot_json) as unknown,
        narrativeInputsHash: row.narrative_inputs_hash,
        narrative: row.narrative_json === null ? null : (JSON.parse(row.narrative_json) as unknown),
      };
    } catch {
      return undefined;
    }
    const parsed = OverviewStateValueSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  }

  putOverviewState(repoRoot: string, state: OverviewStateValue): void {
    const parsed = OverviewStateValueSchema.safeParse(state);
    if (!parsed.success) {
      throw new TypeError(`putOverviewState(${repoRoot}): invalid state: ${parsed.error.message}`);
    }
    const { snapshot, narrativeInputsHash, narrative } = parsed.data;
    if (snapshot.repoRoot !== repoRoot) {
      throw new TypeError(
        `putOverviewState(${repoRoot}): snapshot repoRoot ${snapshot.repoRoot} does not match`,
      );
    }
    this.db
      .prepare(
        "INSERT INTO overview_state (repo_root, snapshot_json, narrative_inputs_hash, narrative_json, updated_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(repo_root) DO UPDATE SET snapshot_json = excluded.snapshot_json, narrative_inputs_hash = excluded.narrative_inputs_hash, narrative_json = excluded.narrative_json, updated_at = excluded.updated_at",
      )
      .run(
        repoRoot,
        JSON.stringify(snapshot),
        narrativeInputsHash,
        narrative === null ? null : JSON.stringify(narrative),
        nowIso(),
      );
  }

```

In `applyProjection`, after the `case "telemetry":` arm (`this.applyTelemetry(event); break;`) and before the closing `}` of the switch, add:

```ts
      case "overview_snapshot":
      case "explainer":
        // No projection table: the viewer reads these rows through TraceReader.
        break;
```

In `packages/storage/src/index.ts`, extend the `./db.js` type export list (lines 8-21) with `ComponentTextValue` and `OverviewStateValue`:

```ts
export type {
  ComponentTextValue,
  CreateSessionInput,
  EventStoreType,
  InstructionInboxRecord,
  InstructionMode,
  InstructionStatus,
  OpenDbOptions,
  OverviewStateValue,
  RebuildStats,
  RepositoryRecord,
  SessionRecord,
  StoredEvent,
  UpsertInstructionInput,
  UpsertRepositoryInput,
} from "./db.js";
```

`import { z } from "zod";` (K-1, line 8) stays a value import: `ComponentTextValueSchema` and `OverviewStateValueSchema` use it at runtime.

- [ ] **Step 5: Run the storage tests to verify they pass**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/storage exec vitest run src/db.test.ts src/explainer-store.test.ts src/trace-reader.test.ts`
Expected: PASS. If it fails with `NODE_MODULE_VERSION`, run `pnpm --filter jevcode-desktop run rebuild:node` and rerun.

Run: `perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/storage typecheck && perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/storage build`
Expected: both exit 0.

- [ ] **Step 6: Run the export test, then re-cap redacted strings (ruling F16), test first**

Run: `perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/trace-viewer build`
Expected: exits 0. The desktop test imports `parseTraceBundle` from `dist`.

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/main/trace-bundle.test.ts src/main/trace-service.test.ts src/main/trace-parity.test.ts`

Expected: PASS. `trace-bundle.test.ts` "exports overview and explainer rows in a redacted v2 bundle …" passes without any change to the read path (`trace-service.ts`, the reader): it follows `TRACE_ROW_TYPES` and `TRACE_BUNDLE_VERSION`. If that test fails, the defect is in K-1 or in this task's storage code. Do not special-case the new types in the reader or the service.

Now the cap overflow. Add this test to `apps/desktop/src/main/trace-bundle.test.ts`, right after the export test above:

```ts
  it("keeps redacted strings inside the schema caps (a short secret grows into a marker)", () => {
    const db = openDb({ dbPath: path.join(tempDir(), "caps.db") });
    db.upsertRepository({ id: REPO, path: "/work/bundle", gitRoot: "/work/bundle" });
    db.createSession({ id: SESSION, repoId: REPO, prompt: "Map it" });
    db.appendAgentEvent(SESSION, { type: "agent_started", sessionId: SESSION, prompt: "Map it", ts: TS });
    // Each string is under its cap before redaction and over it after: "token=ab" (8 characters) becomes
    // "token=[REDACTED:token]" (22 characters).
    const near = (cap: number): string => `${"p".repeat(cap - 21)} token=ab`; // cap - 12 characters before, cap + 2 after
    const componentId = "cmp_0123456789ab";
    const sentence = { text: near(220), citations: [{ kind: "component" as const, id: componentId }] };
    db.appendEvent(SESSION, "overview_snapshot", {
      sessionId: SESSION,
      repoRoot: "/work/bundle",
      scanId: "scan_1",
      partial: false,
      counts: { files: 1, components: 1, edges: 1, languages: ["TypeScript"] },
      components: [
        {
          id: componentId,
          rootPath: "src",
          name: near(120),
          fileCount: 1,
          files: ["src/a.ts"],
          language: "TypeScript",
          roleGuess: "domain",
          role: "domain",
          purpose: near(140),
          provenance: "model",
          contentHash: "0".repeat(40),
          externalDeps: [],
          entryPoints: [],
          importsAnalyzed: true,
        },
      ],
      edges: [{ from: componentId, to: componentId, count: 1, examples: [near(300)] }],
      externals: [],
      narrative: { sentences: [sentence], provenance: "model" },
      generatedAt: TS,
    });
    db.appendEvent(SESSION, "explainer", { sessionId: SESSION, kind: "story", sentences: [sentence], basisSeq: 1 });
    const reader = openTraceReader(db.dbPath);
    closers.push(() => {
      reader.close();
      db.close();
    });

    const bundle = buildTraceBundle(createTraceService(reader), SESSION, { homeDir: HOME, now: () => TS });
    const snapshot = OverviewSnapshotSchema.parse(bundle.rows[1]?.payload);
    expect(snapshot.components[0]?.purpose).toHaveLength(140);
    expect(snapshot.components[0]?.name).toHaveLength(120);
    expect(snapshot.edges[0]?.examples[0]).toHaveLength(300);
    expect(snapshot.narrative?.sentences[0]?.text).toHaveLength(220);
    expect(ExplainerRecordSchema.parse(bundle.rows[2]?.payload)).toMatchObject({ kind: "story" });
    expect(JSON.stringify(bundle)).not.toContain("token=ab");
    expect(bundle.redactionCount).toBeGreaterThan(0);
  });
```

Run the same vitest command. Expected: FAIL in this test with a ZodError (`Too big: expected string to have <=140 characters`) from `OverviewSnapshotSchema.parse`.

In `apps/desktop/src/main/trace-bundle.ts`, add after `redactBundleValue`:

```ts
type JsonObject = Record<string, unknown>;

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Truncates to `max` UTF-16 code units (the unit zod's `.max` counts) without leaving half a surrogate pair. */
function clipChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = text.charCodeAt(max - 1) >= 0xd800 && text.charCodeAt(max - 1) <= 0xdbff ? max - 1 : max;
  return text.slice(0, end);
}

function capFields(value: unknown, caps: Record<string, number>): unknown {
  if (!isJsonObject(value)) return value;
  const out: JsonObject = { ...value };
  for (const [key, max] of Object.entries(caps)) {
    const field = out[key];
    if (typeof field === "string") out[key] = clipChars(field, max);
  }
  return out;
}

const mapArray = (value: unknown, fn: (item: unknown) => unknown): unknown => (Array.isArray(value) ? value.map(fn) : value);

function capSentence(value: unknown): unknown {
  if (!isJsonObject(value)) return value;
  const capped = capFields(value, { text: 220 }) as JsonObject;
  return { ...capped, citations: mapArray(value["citations"], (citation) => capFields(citation, { id: 512 })) };
}

/**
 * Redaction can lengthen a string ("token=ab" becomes "token=[REDACTED:token]"), which would push a capped
 * string of an overview_snapshot or explainer row over its K-2 schema limit and turn the row into an
 * `invalid_row` gap in the viewer. This truncates those strings back to the limits (ruling F16). Truncating
 * keeps the secret redacted. Other row types pass through.
 */
export function capRedactedRow(type: string, payload: unknown): unknown {
  if (!isJsonObject(payload)) return payload;
  if (type === "explainer") {
    // A record carries `sentences` (story) or `sentence` (decision_why), never both; leave absent keys absent.
    const out: JsonObject = { ...payload };
    if ("sentences" in payload) out["sentences"] = mapArray(payload["sentences"], capSentence);
    if ("sentence" in payload) out["sentence"] = capSentence(payload["sentence"]);
    return out;
  }
  if (type !== "overview_snapshot") return payload;
  const narrative = payload["narrative"];
  const status = payload["status"];
  const out: JsonObject = {
    ...payload,
    components: mapArray(payload["components"], (component) => capFields(component, { name: 120, language: 40, purpose: 140 })),
    edges: mapArray(payload["edges"], (edge) =>
      isJsonObject(edge) ? { ...edge, examples: mapArray(edge["examples"], (example) => (typeof example === "string" ? clipChars(example, 300) : example)) } : edge,
    ),
    externals: mapArray(payload["externals"], (dep) => capFields(dep, { name: 214 })),
  };
  if (isJsonObject(narrative)) out["narrative"] = { ...narrative, sentences: mapArray(narrative["sentences"], capSentence) };
  if (isJsonObject(status) && isJsonObject(status["scan"])) out["status"] = { ...status, scan: capFields(status["scan"], { error: 200 }) };
  return out;
}
```

In `buildTraceBundle`, change the per-row push so it re-caps after redaction and before the clip:

```ts
      const payload = redactBundleValue(row.payload, homeDir);
      redactionCount += payload.count;
      rows.push(clipTraceRow({ ...row, payload: capRedactedRow(row.type, payload.value) }));
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/main/trace-bundle.test.ts src/main/trace-service.test.ts src/main/trace-parity.test.ts`
Expected: PASS, including the new test (the original export test still passes: its strings are inside the caps, so the re-cap changes nothing).

Run: `perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop typecheck`
Expected: exits 0.

- [ ] **Step 7: Package suites and lint**

Run, one per call, each under the wrapper:
- `pnpm --filter @jevcode/storage test`
- `pnpm --filter @jevcode/trace-viewer test`
- `pnpm --filter jevcode-desktop test`
- `perl -e 'alarm 170; exec @ARGV' pnpm lint`

Expected: each exits 0. A flake from the known list passes when rerun alone.

- [ ] **Step 8: Commit**

```bash
git add packages/storage/src/db.ts packages/storage/src/migrations.ts packages/storage/src/index.ts \
  packages/storage/src/fixtures.ts packages/storage/src/db.test.ts packages/storage/src/explainer-store.test.ts \
  packages/storage/src/trace-reader.test.ts apps/desktop/src/main/trace-bundle.ts apps/desktop/src/main/trace-bundle.test.ts
git commit -m "feat(storage): store overview and explainer rows, add migration v5 with narrator cache and overview state"
```

---

## Lane completion

1. **Whole-lane check** on `ce/01-contracts` after K-4:
   - `/Users/jwpark/Projects/jevcode/.superpowers/orchestration/root-checks.sh /Users/jwpark/Projects/jevcode-ce-01` prints `ROOT_CHECKS_DONE fail=0` in `.superpowers/root-checks.log`.
   - `git log main..HEAD --format=%B | grep -c -E "Claude-Session|Co-Authored-By"` prints `0`.
   - Index §9 "Done" for lane 01 holds:
     - contracts and storage tests are green;
     - bundles v1 and v2 both parse (K-1 `static-bundle.test.ts`, K-4 `trace-bundle.test.ts`);
     - migration v5 applies on a v4 database (K-4 `db.test.ts`).
2. **Merge order.** W0 merges this lane first, then 02a. 02a rebases on it; the two lanes share no file.
3. **Hand-off notes** for the merge (copy into `lane-context.md` of every W1 lane):
   - **Lane 03 D-1.** Emit with `sendToRenderer(MainToRendererChannels.traceRowsAvailable, { sessionId, lastSeq })`. The schema is strict, so pass no other keys. `sendToRenderer` reaches only the main window today; trace-window delivery is D-1's job. The preload member `bridge.trace.onRowsAvailable` is also D-1's.
   - **Lane 04 M-3.** `assembleSnapshot` measures with `new TextEncoder().encode(JSON.stringify(snapshot)).length` against `OVERVIEW_SNAPSHOT_MAX_BYTES`, the same count storage enforces. The measurement includes `status` and `counts.totalFiles`.
   - **Ruling R3, `status`.**
     - Lane 04 writes `status.scan` (`running` progress rows, `done`, or `failed` with an `error` of at most 200 characters) and `counts.totalFiles`.
     - Lane 05 writes `status.narrator` through the seam.
     - Lane 06 treats an absent `status` as scan `done`, with narrator `pending` if any purpose is null, else `ready`.
     - `OverviewStatusSchema` is strict: extra keys fail the row.
   - **Lane 04 M-6.**
     - Type the dependency as `db: JevcodeDb` (there is no `Db`).
     - Write rows with `db.appendEvent(sessionId, "overview_snapshot", snapshot)`. An over-cap snapshot throws `TypeError`.
     - `putOverviewState(repoRoot, …)` requires `snapshot.repoRoot === repoRoot`.
     - A cached snapshot reused for another session needs its `sessionId` restamped before `appendEvent`.
     - Register the `RendererToMainChannels.overviewRescan` handler in `apps/desktop/src/main/ipc.ts`; the allowlist already keeps it to the main window.
   - **Lane 05.**
     - N-3: use `getComponentText` and `putComponentText`; `getOverviewState().narrativeInputsHash` is the reuse key.
     - N-4 and N-5: read `readAgentPreferences(...).explainWithModel` (key `explainer.withModel`). `preferences:set { explainWithModel }` already persists it and broadcasts `preferences:updated`.
   - **Lanes 06 P-1 and 07 S-3.** `ENVELOPE_RULES` already marks both types `consume`. Add `case "overview_snapshot"` and `case "explainer"` to `accumulate` in `packages/trace-viewer/src/model/fold.ts`; until then the `default` branch counts them in `hidden`.
   - **Spec owner.** See "Spec alignment notes": redaction can push capped strings over their schema limits in exported bundles, and `docs/SPEC.md` §4.5 does not list the two new channels.
