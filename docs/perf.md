# Performance vs SPEC §13 SLOs

Measured 2026-09-19 (macOS dev machine, storage-backed SQLite) with `scripts/perf.mjs`
(fixture replays) and `scripts/soak.mjs` (10k-event soak). The soak figures
are from a 2026-09-30 rerun.

## SLO table

| SLO (SPEC §13) | Target | Measured | Status |
|---|---|---|---|
| File write → evidence fact persisted | ≤2s p50, ≤5s p95 | 0ms p50, 1ms p95, 2ms max (77 samples, all 5 fixture replays) | PASS |
| Fact batch → semantic projection applied | ≤5s | first `ui:spec` 15–63ms after first ingest per fixture replay | PASS |
| Jev Pass A batch (≤8 units) | ≤3s p95 | not separately measured (no keyed environment. The degrade path is synchronous, sub-ms per unit) | PASS (degrade path). Unmeasured for live TypeSafe (typesafe-spike §4) |
| Jev Pass B (single) | ≤2s p95 | sub-ms on degrade path | PASS (degrade path). Unmeasured for live TypeSafe |
| Phase A skeleton after surface decision | ≤100ms | `compileSkeleton` 0ms p50/p95 (5000 runs) | PASS |
| Full surface after Jev result | ≤1s | change-unit summary compile 0ms p50/p95, completion surface 0ms p50/p95 (500 runs each) | PASS |
| Initial repo index (10k files) | ≤60s background | not applicable in replay mode (evidence disabled). The tree-sitter index path is not exercised by the soak | NOT MEASURED |
| Per-file incremental parse | ≤300ms | not measured in this pass (worker tests cover correctness, not latency) | NOT MEASURED |
| Renderer main-thread blocked | never (analysis in worker) | parsing runs in `worker_threads` (`evidence-engine/src/worker`) | PASS by construction |
| Event store growth cap | 1M events/session, then archive | soak stored 454,874 events for 9,993 records on 2026-09-30 (45.5x amplification: facts + projections + jev logs + snapshots; the 2026-09-19 build stored 75,181). The cap is enforced by schema/bound checks | PASS |

## Soak (SPEC §16 acceptance criterion, T9-2)

`node scripts/soak.mjs` replays 9,993 generated records (formatting/file-noise
bursts + periodic real changes + tests + decisions) through the real pipeline
(degrade router, storage-backed, SQLite in tmpdir). The 2026-09-30 run:

- No crash. The session reached `completed` and emitted the completion surface.
- Event store: 454,874 events < 1M cap. The 2026-09-19 build stored 75,181
  events for the same records.
- SurfaceManager (headless, real API): no full swaps under the interaction lock
  (0 violations), pinned surface never replaced, generative surfaces bounded.
- Timings: total 638s, ingest 611s, final projection flush 27s, coordinator
  throughput ~712 events/s end-to-end (ingest includes per-record zod
  validation and SQLite appends). The 2026-09-19 run took 165s in total.
- `compileSkeleton` under 0.001ms average (1,000 calls in under 1 ms).

The soak exposed and fixed two quadratic paths:

1. `PipelineCoordinator.rebuild()` had an O(units²) signature-cleanup loop
   (`[...unitSignatures].some(unit => ...)` per signature). It was replaced
   with a Set lookup (`packages/semantic-core/src/coordinator.ts`).
2. Storage-backed stores re-wrote every change unit and graph node/edge on
   every rebuild. Unchanged-payload caching skips redundant SQLite upserts
   (`apps/desktop/src/main/pipeline/storage-stores.ts`).

## Rebuild-path scaling probe (2026-09-19, semantic-core)

Quick probe (distinct non-formatting files, two facts each (`file_changed` +
`git_hunk`), replayed through the real coordinator. Graph projection measured
in isolation with one unit per file):

| Probe | 250 files | 500 files | 1000 files |
|---|---|---|---|
| Coordinator trickle ingest + flush — before | 223.5ms (207 rebuilds) | 841.2ms (412 rebuilds) | 3920.6ms (824 rebuilds) |
| Coordinator trickle ingest + flush — after | 11.7ms (2 rebuilds) | 13.4ms (2 rebuilds) | 20.8ms (2 rebuilds) |
| `projectGraph` (1 unit/file, import edge per file) — before | 12.7ms | 14.5ms | 41.7ms |
| `projectGraph` (1 unit/file, import edge per file) — after | 5.3ms | 7.2ms | 9.7ms |

Fixes behind the numbers:

- Trailing-edge rebuild debounce in `PipelineCoordinator`: at most one full
  rebuild per flush burst. The debounce is 25ms trailing idle, and `flush()`
  still rebuilds synchronously. Trickle bursts collapse from one rebuild per
  500ms window to one per burst.
- `projectGraph`: O(F²) fact→unit ownership scans replaced with a fact-reference
  Map index, per-import-edge O(E·F) symbol rescans replaced with a per-file
  cache, and per-fact `units.find` replaced with a unit-id Map.
- 500ms-batch ids are assigned from the drain's 500ms window, so cap-forced
  drains of the same window share a batch id, and same-batch edges are
  unconditional (SPEC §6.1.2).

Remaining known cost: a rebuild still re-clusters the full session. The
debounce bounds this to one rebuild per burst instead of one per batch window.
Full incremental clustering is out of scope (documented in SPEC §19).

## Trace read (trace viewer, spec §10 M2 budgets)

Measured 2026-09-30 on both soak profiles.
`JEVCODE_SOAK_PROFILE=trace node scripts/soak.mjs` is the full soak on the
spec §10 reference input: command stdout of 0.2 to 64 KiB, assistant notes of
0.2 to 4 KiB, `callId` pairs, agent `file_changed` claims and a steer every 500
records. `node scripts/soak.mjs` is the default profile, the 2026-09-19 stream:
empty command stdout and one-line assistant notes. Before it stops the session,
the soak reads the whole session through the viewer's own path: a second
`query_only` connection (`openTraceReader`), `createTraceService` (fact ids,
and strings over 16 KiB clipped to a 4 KiB head and a 12 KiB tail) and
`readAllRows`. Only the six
`TRACE_ROW_TYPES` are read; graph, telemetry, snapshot and failure rows are
skipped. The full read runs 6 times in pages of up to 5,000 rows, and a page
also ends after the row that takes its stored payload past 2 MiB; the first
read is a discarded warm-up and the budget uses the median of the other 5. The
`trace:rows` budget times single calls at the viewer's page size of 2,000 rows
(or 2 MiB of payload) over repeated full reads.

| Budget | Target | Measured | Status |
|---|---|---|---|
| Full soak-session trace read in main (trace profile) | ≤1.5s | 998 ms, median of 5 (917, 994, 1300, 1824, 998 ms), for 110,957 trace rows of 452,361 stored | PASS |
| `trace:rows` call in main (trace profile) | p95 ≤50ms | 13.7 ms p95 over 340 calls (p50 9.1 ms, max 27.8 ms) | PASS |
| Full soak-session trace read in main (default profile) | ≤1.5s | 761 ms, median of 5 (661, 926, 692, 761, 772 ms), for 110,917 trace rows of 454,874 stored | PASS |
| `trace:rows` call in main (default profile) | p95 ≤50ms | 12.5 ms p95 over 340 calls (p50 7.7 ms, max 156.6 ms) | PASS |

The trace-profile soak stored 452,361 events for 10,013 records in 687,528 ms.
The default-profile soak stored 454,874 events for 9,993 records in 638,439 ms.

## How to reproduce

```
pnpm build
node scripts/perf.mjs    # fixture replays: persist latency, first-surface latency, compile times
node scripts/soak.mjs    # 10k-event soak with SurfaceManager invariants and the trace read budgets
JEVCODE_SOAK_EVENTS=2000 node scripts/soak.mjs  # smaller soak for quick checks
JEVCODE_SOAK_PROFILE=trace node scripts/soak.mjs  # the trace viewer's reference input (spec §10)
JEVCODE_SOAK_EXPORT=/tmp/jevcode-soak-trace.json node scripts/soak.mjs  # also writes a trace.json bundle
JEVCODE_SOAK_KEEP_DB=/tmp/jevcode-soak-trace.db node scripts/soak.mjs  # also keeps the database (mode 0600)
```

The full soak takes about 11 minutes; run it in the background.

## Trace viewer (spec §10, R26), recorded at the M5 exit

Reference machine: Mac15,11, Apple M3 Max, 36 GiB (38,654,705,664 bytes), macOS 27.0.1, Node v22.23.1, Electron 33.4.11, display at 60 Hz. Single-run budgets: median of 5 runs after 1 discarded warm-up. p95 budgets: at least 300 samples. M4a values are copied from `docs/spikes/trace-viewer-spike.md` ("M4a exit"; headless Chrome on a machine with load average 4 to 8, so provisional pending H5). M4b exit: PENDING (lane C3b); the orchestrator refreshes the M4b rows at merge. The M5 soak-open runs below ran with 1-minute load averages of 4.9 to 6.6 (`uptime` before and after each run) on a shared machine.

| Budget | Target | Gate | Measured | Status | Measured by |
|---|---|---|---|---|---|
| Full soak-session read in main | ≤ 1.5 s | M2 | 998 ms, median of 5 (trace profile; "Trace read" section above) | PASS | soak.mjs trace phase |
| `trace:rows` call in main (trace profile) | p95 ≤ 50 ms | M2 | 13.7 ms p95 over 340 calls ("Trace read" section above) | PASS | soak.mjs trace phase, per page |
| Fold of 75k rows / one appended row | ≤ 500 ms / ≤ 2 ms | Benchmark | 346.87 ms mean (min 339.12, max 370.31, 5 samples) / 0.0045 ms mean (max 0.7197 ms, 1,000 samples), 2026-10-01 | PASS | `pnpm --filter @jevcode/trace-viewer bench` (`fold.bench.ts`) |
| Soak first paint / full load (dev host) | ≤ 300 ms / ≤ 2 s | M4a | 183 ms / 965 ms, median of 5 (after the C2 fix wave) | PASS (provisional, H5 pending) | HUD, spike doc "M4a exit" |
| `j` to painted | p95 ≤ 16.7 ms, keydown to next painted frame (zero-work baseline beside it) | M4a | p95 18.8 / 18.9 ms over 300 presses (two runs); baseline p95 10.6 / 11.0 ms | MISS (by about 2 ms; provisional, H5 on a quiet desktop decides; orchestrator ruling 2026-09-30) | HUD, spike doc "M4a exit" |
| Overview layout + paint, Session level | p95 ≤ 4 ms; ≤ 150 overlay nodes | M4a | p95 0.5 ms, n 512; 7 / 9 overlay nodes | PASS (provisional) | HUD, spike doc "M4a exit" |
| Anchor drift (spine and canvas) | ≤ 1 px | Smoke | 0 px (`?selftest=drip`, oauth, spine; canvas: not recorded at M4a) | PASS for the spine; canvas PENDING (lane C3b) | `?selftest=drip`, spike doc |
| `layoutCanvas` fresh / sticky | ≤ 2 ms / ≤ 0.5 ms | Benchmark | 0.3554 ms mean (p99 0.7180) / 0.3692 ms mean (p99 0.6915), 60 chapters and 5,000 steps, 2026-10-01 | PASS (mean; p99 of both is above 0.5 ms) | `canvas-layout.bench.ts` |
| Canvas pinch at Step level | ≤ 5% frames dropped | M4b | M4b exit: PENDING (lane C3b) | PENDING | spike harness, spike doc "M4b exit" |
| View switch | restored in the toggle's frame; never a 0 × 0 fit | M4b | M4b exit: PENDING (lane C3b) | PENDING | HUD, spike doc "M4b exit" |
| Live tick (poll apply + selectors + commit) | p95 ≤ 16 ms | M5 | PENDING — deferred by the person on 2026-09-30; revisit before the M5 exit (steps below) | PENDING | dev host `?bundle=soak&perf=1&drip=20,1000,-2000`, plus the mock-adapter trace window (`JEVCODE_TRACE_PERF=1`) |
| Soak open in the Electron trace window, first paint (trace profile) | ≤ 500 ms | M5 | 218 ms, median of runs 1 to 5 (231, 216, 218, 220, 217; run 0 warm-up 234) | PASS | `JEVCODE_SMOKE=1 JEVCODE_SMOKE_TRACE=1 JEVCODE_DB=<copy of the kept soak DB>` |
| Soak open in the Electron trace window, full load (trace profile) | ≤ 3,000 ms | M5 | 4,571 ms, median of runs 1 to 5 (4,618, 4,571, 4,579, 4,232, 4,268; run 0 warm-up 4,242) | FAIL (1,571 ms over budget; every run 4,232 to 4,618 ms) | same |

Soak bundle: `traceRows` 110,962, `consumedRows` 110,962 (the export holds 110,962 rows; the soak's own JSON line was lost to the brief's `| tail -1`, which kept only the "kept the database" line, so `traceRows` is the exported bundle's row count and `consumedRows` equals it by `scripts/soak.mjs`). The kept database is 674,414,592 bytes and the bundle 217,837,514 bytes. Soak run: 2026-10-01, 00:35 to 00:53.

Soak-open runs (each an Electron boot on a fresh copy of the kept database):

```
run 0: SMOKE_TRACE session=sess-soak-0001 rows=3905 first_paint_ms=234 full_load_ms=4242
run 1: SMOKE_TRACE session=sess-soak-0001 rows=3905 first_paint_ms=231 full_load_ms=4618
run 2: SMOKE_TRACE session=sess-soak-0001 rows=3905 first_paint_ms=216 full_load_ms=4571
run 3: SMOKE_TRACE session=sess-soak-0001 rows=3905 first_paint_ms=218 full_load_ms=4579
run 4: SMOKE_TRACE session=sess-soak-0001 rows=3905 first_paint_ms=220 full_load_ms=4232
run 5: SMOKE_TRACE session=sess-soak-0001 rows=3905 first_paint_ms=217 full_load_ms=4268
```

Every run ended with `SMOKE_OK` and no `SMOKE_FAIL`. `rows` is the count folded at `TRACE_READY` (the first committed page), not the session total. The full-load miss blocks the M5 exit (spec §10 "Gate"); it is escalated with this record. Spec §10's first remedy is incremental appends in the selectors. The desktop path pays the IPC page round trips and structured clones for 110,962 rows on top of the dev host's 965 ms bundle parse and fold (the dev host's clock starts at `tv:bundle-parsed`); the Electron `tv:full-load` mark starts at navigation.

PENDING human checks for the M5 exit (all deferred by the person on 2026-09-30; revisit before the M5 exit). The automated preparation is done: the soak bundle is copied to `apps/trace-viewer-dev/public/bundles/soak.json` (git-ignored) and the dev host is built; the scratch repository exists at `$TMPDIR/jevcode-m5-repo`.

| Check | Status | Exact steps |
|---|---|---|
| Live tick p95 on the dev host | PENDING — deferred by the person on 2026-09-30; revisit before the M5 exit | From the repository root: `pnpm --filter jevcode-trace-viewer-dev build && pnpm --filter jevcode-trace-viewer-dev exec vite preview --port 4179 --strictPort`. In Chrome on the reference machine open `http://localhost:4179/?bundle=soak&perf=1&drip=20,1000,-2000`, stay in Live for at least 6 minutes (300 ticks or more) and read the HUD's `tv:live-tick` p95 and sample count. Budget: p95 ≤ 16 ms. Stop `vite preview` afterwards. To regenerate the bundle: `JEVCODE_SOAK_PROFILE=trace JEVCODE_SOAK_EXPORT="$PWD/apps/trace-viewer-dev/public/bundles/soak.json" node scripts/soak.mjs` (about 18 minutes). |
| Manual live session on the mock adapter (items 1 to 7) | PENDING — deferred by the person on 2026-09-30; revisit before the M5 exit | Prepare: `REPO="${TMPDIR:-/tmp}/jevcode-m5-repo"; rm -rf "$REPO" && cp -R fixtures/rate-limit/repo "$REPO"; git -C "$REPO" init -q && git -C "$REPO" add -A && git -C "$REPO" -c user.name=m5 -c user.email=m5@example.invalid commit -qm seed; rm -f "${TMPDIR:-/tmp}/jevcode-m5-live.db"*; pnpm --filter jevcode-desktop build && pnpm --filter jevcode-desktop run rebuild`. Start: `JEVC_AGENT=mock JEVCODE_TRACE_PERF=1 JEVCODE_DB="${TMPDIR:-/tmp}/jevcode-m5-live.db" pnpm --filter jevcode-desktop start 2>&1 \| tee "${TMPDIR:-/tmp}/jevcode-m5-live.log"`. Open `$REPO`, start the task "Add a Redis-backed rate limiter to the API server and make it fail open when Redis is unavailable.", press **Trace** while it runs, and confirm: (1) the trace window opens light with no dark flash, at least 1000 px wide, in Live, and new steps appear within about a second; (2) selecting an earlier row switches to Review ("Live follow paused" once), later appends raise "N new", the selected row stays in place and keyboard focus never moves; (3) `G` or the "N new" pill returns to the live edge and Live resumes; (4) pressing **Trace** again focuses the same trace window, also when minimized, and no second window opens; (5) **Request changes** on a step focuses the main window, the composer holds the prior draft plus the note on a new line with the caret at the end and the Steer/Queue choice unchanged, and nothing is sent until the button is pressed; (6) when the agent completes, the trace window shows the session as ended and Live is disabled; (7) closing the main window closes the trace window. Quit the app, then: `node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").split("\n");const t=l.filter(x=>x.startsWith("TRACE_PERF tv:live-tick ")).map(x=>Number(x.split(" ")[2])).sort((a,b)=>a-b);console.log("trace window live tick p95",t.length===0?NaN:t[Math.max(0,Math.ceil(t.length*0.95)-1)],"ms over",t.length,"samples")' "${TMPDIR:-/tmp}/jevcode-m5-live.log"`, then `grep -c "SMOKE_FAIL\|rejected:" "${TMPDIR:-/tmp}/jevcode-m5-live.log"` (expect `0`), then `pnpm --filter jevcode-desktop rebuild:node` (expect `native modules restored to node ABI`; restore node-pty's `build/Release/pty.node` and `spawn-helper` from its prebuilds if missing). A short mock session gives fewer than 300 samples; record the count. |
