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

Reference machine: Mac15,11, Apple M3 Max, 36 GiB (38,654,705,664 bytes), macOS 27.0.1, Node v22.23.1, Electron 33.4.11, display at 60 Hz. Single-run budgets: median of 5 runs after 1 discarded warm-up. p95 budgets: at least 300 samples. M4a values are copied from `docs/spikes/trace-viewer-spike.md` ("M4a exit"; headless Chrome on a machine with load average 4 to 8, so provisional pending H5). M4b values are copied from the spike doc's "M4b exit" (lane C3b, merged at 4cec922; Electron 33 and Chrome at 120 Hz, DPR 2, load average 7 to 8, so provisional pending H5 and the PENDING human checks recorded there). The M5 soak-open runs below ran on a shared machine: the D-8 runs at 1-minute load averages of 4.9 to 6.6, the runs after the full-load fix at 5.80 to 7.21 (`uptime` before each run; 6.43 after the last), and the rerun after the C3b rebase at 8.58 to 11.58 (8.35 after the last).

| Budget | Target | Gate | Measured | Status | Measured by |
|---|---|---|---|---|---|
| Full soak-session read in main | ≤ 1.5 s | M2 | 998 ms, median of 5 (trace profile; "Trace read" section above) | PASS | soak.mjs trace phase |
| `trace:rows` call in main (trace profile) | p95 ≤ 50 ms | M2 | 13.7 ms p95 over 340 calls ("Trace read" section above) | PASS | soak.mjs trace phase, per page |
| Fold of 75k rows / one appended row | ≤ 500 ms / ≤ 2 ms | Benchmark | 346.87 ms mean (min 339.12, max 370.31, 5 samples) / 0.0045 ms mean (max 0.7197 ms, 1,000 samples), 2026-10-01 | PASS | `pnpm --filter @jevcode/trace-viewer bench` (`fold.bench.ts`) |
| Soak first paint / full load (dev host) | ≤ 300 ms / ≤ 2 s | M4a | 183 ms / 965 ms, median of 5 (after the C2 fix wave) | PASS (provisional, H5 pending) | HUD, spike doc "M4a exit" |
| `j` to painted | p95 ≤ 16.7 ms, keydown to next painted frame (zero-work baseline beside it) | M4a | p95 18.8 / 18.9 ms over 300 presses (two runs); baseline p95 10.6 / 11.0 ms | MISS (by about 2 ms; provisional, H5 on a quiet desktop decides; orchestrator ruling 2026-09-30) | HUD, spike doc "M4a exit" |
| Overview layout + paint, Session level | p95 ≤ 4 ms; ≤ 150 overlay nodes | M4a | p95 0.5 ms, n 512; 7 / 9 overlay nodes | PASS (provisional) | HUD, spike doc "M4a exit" |
| Anchor drift (spine and canvas) | ≤ 1 px | Smoke | 0 px (`?selftest=drip`, oauth, spine; canvas: not recorded at M4a); canvas 0.000016 px at the M4b exit (0.000025 px after the lane-review fix round) | PASS (spine M4a; canvas M4b exit) | `?selftest=drip`, spike doc "M4b exit" |
| `layoutCanvas` fresh / sticky | ≤ 2 ms / ≤ 0.5 ms | Benchmark | 0.3554 ms mean (p99 0.7180) / 0.3692 ms mean (p99 0.6915), 60 chapters and 5,000 steps, 2026-10-01 | PASS (mean; p99 of both is above 0.5 ms) | `canvas-layout.bench.ts` |
| Canvas pinch at Step level | ≤ 5% frames dropped | M4b | Spike scene (60 chapters, 300 edges) at the spec's 60 Hz arithmetic: 0% dropped without `will-change`, 3.468% with, p95 1; rescored at the panel's measured 120 Hz: 35.73 to 37.29% without, 6.65 to 7.50% with (miss). Real Canvas on the soak bundle: 0 to 0.86% at 60 Hz arithmetic, 0 to 4.17% at 120 Hz, p95 1 in all six runs | M4b exit: provisional pass (spec budget is at 60 Hz; panel ran at 120 Hz). Risk 2 rerun at 60 Hz: PENDING (human, deferred 2026-09-30) | spike harness, spike doc "M4b exit" |
| View switch | restored in the toggle's frame; never a 0 × 0 fit | M4b | 20 switches, 0 misses (`?selftest=switch`, real time over the DevTools protocol; rerun green after the lane-review fix round) | PASS (M4b exit) | dev-host smoke `--views hybrid,canvas`, spike doc "M4b exit" |
| Live tick (poll apply + selectors + commit) | p95 ≤ 16 ms | M5 | Dev host, soak, headless Chrome (2026-10-01 07:18 to 07:30, load 4.1 to 6.4, "Incremental indexes" below): Hybrid median 28.9 / 28.8 ms, p95 35.7 / 37.0 ms (5626b9a, incremental finalize only: 51.9 / 52.6, p95 63.6 / 68.0; main 9a8b89e: 178.2 / 173.9, p95 193.3 / 190.2); Canvas median 62.5 / 62.5 ms, p95 74.0 / 73.7 ms (5626b9a: 83.1 / 81.4, p95 91.4 / 91.8). The human run on the reference machine (steps below) is still PENDING — deferred by the person on 2026-09-30 | MISS (about 2.3× in Hybrid, 4.6× in Canvas) | dev host `?bundle=soak&perf=1&drip=20,1000,-2000`, plus the mock-adapter trace window (`JEVCODE_TRACE_PERF=1`) |
| Soak open in the Electron trace window, first paint (trace profile) | ≤ 500 ms | M5 | 276 ms, median of runs 1 to 5 (276, 285, 273, 277, 273; run 0 warm-up 275), after the C3b rebase (2026-10-01, load 8.58–10.01, Hybrid active, Canvas mounted hidden); 294 ms after the full-load fix and 218 ms at D-8 before it | PASS | `JEVCODE_SMOKE=1 JEVCODE_SMOKE_TRACE=1 JEVCODE_DB=<copy of the kept soak DB>` |
| Soak open in the Electron trace window, full load (trace profile) | ≤ 3,000 ms | M5 | 2,797 ms, median of runs 1 to 5 (2,854, 2,797, 2,749, 2,845, 2,792; run 0 warm-up 2,817), after the C3b rebase (2026-10-01, load 8.58–10.01, Hybrid active, Canvas mounted hidden); 2,858 ms after the full-load fix (load 5.8–7.2) and 4,571 ms at D-8 before it | PASS, thin margin (203 ms, 6.8 %; every run 2,749 to 2,854 ms); re-measure at H5 on an idle machine | same |

Soak bundle: `traceRows` 110,962, `consumedRows` 110,962 (the export holds 110,962 rows; the soak's own JSON line was lost to the brief's `| tail -1`, which kept only the "kept the database" line, so `traceRows` is the exported bundle's row count and `consumedRows` equals it by `scripts/soak.mjs`). The kept database is 674,414,592 bytes and the bundle 217,837,514 bytes. Soak run: 2026-10-01, 00:35 to 00:53.

Soak-open runs (each an Electron boot on a fresh copy of the kept database). D-8, before the full-load fix:

```
run 0: SMOKE_TRACE session=sess-soak-0001 rows=3905 first_paint_ms=234 full_load_ms=4242
run 1: SMOKE_TRACE session=sess-soak-0001 rows=3905 first_paint_ms=231 full_load_ms=4618
run 2: SMOKE_TRACE session=sess-soak-0001 rows=3905 first_paint_ms=216 full_load_ms=4571
run 3: SMOKE_TRACE session=sess-soak-0001 rows=3905 first_paint_ms=218 full_load_ms=4579
run 4: SMOKE_TRACE session=sess-soak-0001 rows=3905 first_paint_ms=220 full_load_ms=4232
run 5: SMOKE_TRACE session=sess-soak-0001 rows=3905 first_paint_ms=217 full_load_ms=4268
```

After the full-load fix (2026-10-01, 01:21 to 01:23; 1-minute load average before each run 6.85, 6.42, 6.29, 5.80, 6.44, 7.21, and 6.43 after the last):

```
run 0: SMOKE_TRACE session=sess-soak-0001 rows=3905 first_paint_ms=289 full_load_ms=2681
run 1: SMOKE_TRACE session=sess-soak-0001 rows=3905 first_paint_ms=294 full_load_ms=2860
run 2: SMOKE_TRACE session=sess-soak-0001 rows=3905 first_paint_ms=288 full_load_ms=2840
run 3: SMOKE_TRACE session=sess-soak-0001 rows=3905 first_paint_ms=280 full_load_ms=2858
run 4: SMOKE_TRACE session=sess-soak-0001 rows=3905 first_paint_ms=294 full_load_ms=2729
run 5: SMOKE_TRACE session=sess-soak-0001 rows=3905 first_paint_ms=294 full_load_ms=2875
```

Every run ended with `SMOKE_OK` and no `SMOKE_FAIL`. `rows` is the count folded at `TRACE_READY` (the first committed page), not the session total. The Electron `tv:full-load` mark starts at navigation; the dev host's clock starts at `tv:bundle-parsed`.

Why the trace window was slower than the dev host, measured with temporary timers and a Chromium trace (details in the lane's `full-load-investigation.md`):

- **Page count.** The reader's 2 MiB payload bound, not the 5,000-row limit, sets the page size: the soak session arrives in 100 pages (632 to 4,652 rows each), about 210 MB after clipping. The dev host's static source has no byte bound and serves 23 pages.
- **Serial round trips.** Each page cost about 21 ms: about 10 ms in main (reader 5, `toTraceRow` 3, serialize 2), then about 9 ms in the renderer before the next request could go out (structured-clone deserialize about 2.5 ms, contextBridge copy about 5 to 6 ms). Main and renderer each sat idle while the other worked: 100 pages x 21 ms is about 2.1 s. The renderer waited 3.1 to 3.3 s in total on `trace:rows` although main needed only about 1.0 s.
- **Re-deriving per commit.** Each commit runs `finalize` over the whole fold (about 185 ms at 110,962 rows), then the Shell's index, overview and outline rows and React render. At 4 commits per second over a 4 s load that was 10 to 12 commits and about 1.4 s. Commits scale with rows x load time, not rows x pages. Without progressive commits (one experiment) the old path still took 3.0 s.
- `tv:full-load` is marked at the right point (the paint after the commit with `loadedFraction` 1), and the last commit is capped at the 250 ms throttle wait (`full-load-investigation.md`; the actual wait was not measured).

The fix, in three parts: the DataController requests the next page as soon as a page arrives, before it folds, commits and yields (one request ahead; generation checks and the untrusted-row guards unchanged); main's `trace:rows` handler reads the page after a full page once the reply is posted and serves it to the matching request within one poll period (`createRowsReadAhead`, 99 of 99 hits on the soak); and while catching up a progressive commit waits at least 4 times the previous `finalize` (still at most 4 per second), while the caught-up commit waits only the 250 ms cap and replaces a pending progressive one. Commits fell to 6. First paint rose from 218 to 294 ms (the next page now arrives while the first commit renders) and stays under its 500 ms budget.

Db exit checklist for the full-load budget (orchestrator ruling 2026-10-01): after the C3b rebase, rerun the D-6 smoke and the 5-run soak open (6 boots, discard run 0, the D-8 command) and record load averages; C3b's canvas adds per-commit render work that this load pays about 6 times, and session-to-session variance in the investigation (2,971 to 3,269 ms at load 5.5 to 5.7) exceeds the 142 ms margin. Done 2026-10-01 after the rebase onto 4cec922: D-6 smoke `SMOKE_TRACE session=sess-oauth-0001 rows=74 first_paint_ms=148 full_load_ms=169`, `SMOKE_OK`; soak open first paint 276 ms, full load 2,797 ms (table above). The trace window opens in Hybrid, and the hidden Canvas lays out nothing per commit (C3b lane review I-5), so the rebase added no measurable full-load cost. Canvas as the active view during a load is not measured here. Repeat at H5 on an idle machine. If a rerun misses, the next lever is a string transport for `trace:rows`; incremental finalize (below) did not move this load.

### Live tick after incremental finalize (2026-10-01, `tv/incremental-finalize`)

`finalize` re-derived the whole session on every commit: on soak (110,962 rows, 7,898 steps, 4,861 chapters, about 160k chapter-step links through 31 shared test runs) it took 189 ms median per 20-row tick in Node (p95 234 ms; `buildChapters` about 130 ms, chapter short titles about 30 ms). It is now incremental (spec §6.4, `model/fold-finalize.ts`): 2.1 ms median, p95 3.3 ms, in the same Node probe (fold all but the last 2,000 rows, then 100 ticks of `accumulateAll` of 20 rows and `finalize({live: true})`; load 5.0). The Outline rows are cached per step and entity object on top of that (17 ms to about 4 ms per tick).

Dev host HUD (`tv:live-tick`), `vite preview` of the minified build, headless Chrome 1440 × 900, `?bundle=soak&perf=1&drip=20,1000,-2000`, Chapter level, 87 to 98 samples per run, runs interleaved. Before is main at 9a8b89e (the Canvas live-tick fixes, old model and Outline), after is this branch:

| View | Before median / p95 (ms) | After median / p95 (ms) | 1-minute load |
|---|---|---|---|
| Hybrid | 178.2 / 193.3, 173.9 / 190.2 | 52.9 / 66.0, 53.7 / 66.8 | 4.0 to 4.7 |
| Canvas | 201.4 / 217.2, 202.5 / 215.6 | 82.4 / 91.7, 79.4 / 89.2 | 3.6 to 5.2 |

Dev host open (Hybrid): first paint 185 and 189 ms before, 190 and 194 ms after; full load 937 and 939 ms before, 955 and 960 ms after (cheaper finalizes let the data controller commit more often while catching up, since the gap is 4 × the last finalize, at least 250 ms).

Where the remaining Hybrid tick goes (Chrome CPU profile of the unminified build over 40 ticks, per tick): `buildTraceIndex` 15.5 ms, `buildOverviewIndex` 9.2 ms, `finalize` 6.3 ms (signals 2.9 ms of it), Outline 6.3 ms (rows 4.3 ms), Spine 2.8 ms, React commit 2.8 ms, GC 4.2 ms. Both indexes are O(chapter-step links) per commit: `buildTraceIndex` maps every chapter's `stepIds` and scans every step's `chapterIds` (the shared runs list 4,861 chapters each), and `buildOverviewIndex` re-derives every step mark and chapter band against a time scale that moves each tick. Next levers, in order: build `TraceIndex` from the previous index and the identity-stable session (only changed steps and chapters), then overview marks in scale-free units with the scale applied at paint.

### Incremental indexes (2026-10-01, `tv/incremental-finalize`, 6752d62 to 5bf6c07)

`buildTraceIndex(session, previous)` and `buildOverviewIndex(session, index, scale, previous)` start from the previous commit's result (spec §6.4). The index keeps the entry of every unchanged Step and Chapter object and recomputes only what changed objects reach: a step whose seqs moved reaches the chapters that list it, and a chapter whose anchor moved reaches the steps that list it. It keeps its own reverse joins and does not trust the fold's joins to agree. The overview keeps a step's marks while the step object, its position, its findings and the time scale up to its end are unchanged. `stableBeforeT` is the first time where two scales map t to u differently; a live scale only grows its last gap. The overview also keeps a chapter's band pieces while no footprint entry or key changed; each index build reports the ids it changed. The marks stay in u, as before. The old plan to store them scale-free and apply the scale at paint would have added a toU per visible mark per frame and a float round trip at the visible-range edges, so the overview keeps what the moved scale does not reach instead. Both builds equal a fresh build after every commit (`trace-index.incremental.property.test.ts`, `overview-index.incremental.property.test.ts`: random rows, fixtures, soak-shaped rows, hand-edited sessions whose joins disagree, arbitrary scale changes, skipped overviews). The Outline builds only the Files rows it shows, indexes chapter-graphic lookups on first use and builds the search index on the first keystroke; `chapterAtSeq` is memoized per index.

One trap on the soak: its last ~3,000 steps share the final tMs, which is the scale's end. A first cut stopped the stable range at the end of an unchanged scale. That re-derived all of those marks and chapters on every commit: 2 ms per tick in the Node probe, but 10 ms in Chrome, where the live end did not move. Fixed in 1ab5df7.

Node probe per 20-row tick (fold all but the last 2,000 soak rows, then 100 ticks; load 4.2 to 10.5): `buildTraceIndex` 16.1 ms median (p95 18.9) → 0.7 to 1.0 ms (p95 1.4 to 2.3); `buildOverviewIndex` 10.4 ms (p95 13.1) → 1.5 to 1.9 ms (p95 2.4 to 3.0); `buildOutlineRows` 5.4 ms → 2.6 ms. The first incremental build after a fresh one builds the reverse joins once, about 25 ms.

Dev host HUD (`tv:live-tick`), `vite preview` of the minified build, headless Chrome 1440 × 900, `?bundle=soak&perf=1&drip=20,1000,-2000`, Chapter level, 98 samples per run, runs interleaved, 1-minute load 4.1 to 6.4 (`uptime` before each run). Before is 5626b9a (incremental finalize and Outline caching), after is 5bf6c07:

| View | Before median / p95 (ms) | After median / p95 (ms) |
|---|---|---|
| Hybrid | 51.9 / 63.6, 52.6 / 68.0 | 28.9 / 35.7, 28.8 / 37.0 |
| Canvas | 83.1 / 91.4, 81.4 / 91.8 | 62.5 / 74.0, 62.5 / 73.7 |

Dev host open (Hybrid): first paint 188.8 and 192.4 ms before, 170.2 and 188.5 ms after. Full load 954.2 and 959.6 ms before, 980.4 and 974.5 ms after. The extra ~20 ms is the one-time reverse joins and the incremental builds during the catch-up commits. Canvas full load: 972.8 and 988.3 ms before, 1,008.5 and 982.4 ms after.

Where the Hybrid tick goes now (Chrome CPU profile of the unminified build, 40 ticks, per tick; the unminified HUD reads 26.7 / 39.8 ms): `finalize` 5.5 ms (signals 2.6 ms), Outline 4.7 ms (rows 4.0 ms), Spine 3.5 ms (rows 2.0 ms), React commit 2.8 ms, Overview 2.6 ms (`buildOverviewIndex` 1.9 ms), `buildTraceIndex` 1.6 ms, time scale 0.6 ms, GC 6.9 ms. Nothing left is O(chapter-step links). The rest is O(steps) per commit: signals over all steps, the Outline story rows, and Spine rows over the brushed range. To reach 16 ms these need append-only paths too, and GC needs fewer per-commit allocations.

The Canvas tick adds about 34 ms (unminified profile, before the Outline cuts): the sticky `layoutCanvas` 16.5 ms (`collectItems` 8.0, its `finalize` 6.7, `routeEdges` 6.0), `frameTone` through `hasOwnStepIn` 7.7 ms, `criticalFrameKeys` 3.7 ms, `frameFlag` 3.4 ms and `labelModels` 3.6 ms. Per-frame tone and flag walk every member's steps (a soak noise stack links ~4,000) on each commit, even for frames whose members did not change. The next levers: key frame tone, flag and critical state on member identity through `traceIndexChanges`, then make the sticky layout skip unchanged chapters.

Soak open in the Electron trace window, the D-8 command, 6 boots per block, runs 1 to 5 (2026-10-01 06:15 to 06:20, load 4.0 to 10.5): after 275 ms first paint and 2,741 ms full load (medians); before (old model built into the same app) 277 ms and 2,853 ms; after again 282 ms and 2,853 ms. No measurable change: this load is paced by `trace:rows` paging over IPC (100 pages), not by `finalize`.

PENDING human checks for the M5 exit (all deferred by the person on 2026-09-30; revisit before the M5 exit). The automated preparation is done: the soak bundle is copied to `apps/trace-viewer-dev/public/bundles/soak.json` (git-ignored) and the dev host is built; the scratch repository exists at `$TMPDIR/jevcode-m5-repo`.

| Check | Status | Exact steps |
|---|---|---|
| Live tick p95 on the dev host | PENDING — deferred by the person on 2026-09-30; revisit before the M5 exit | From the repository root: `pnpm --filter jevcode-trace-viewer-dev build && pnpm --filter jevcode-trace-viewer-dev exec vite preview --port 4179 --strictPort`. In Chrome on the reference machine open `http://localhost:4179/?bundle=soak&perf=1&drip=20,1000,-2000`, stay in Live for at least 6 minutes (300 ticks or more) and read the HUD's `tv:live-tick` p95 and sample count. Budget: p95 ≤ 16 ms. Stop `vite preview` afterwards. To regenerate the bundle: `JEVCODE_SOAK_PROFILE=trace JEVCODE_SOAK_EXPORT="$PWD/apps/trace-viewer-dev/public/bundles/soak.json" node scripts/soak.mjs` (about 18 minutes). |
| Manual live session on the mock adapter (items 1 to 7) | PENDING — deferred by the person on 2026-09-30; revisit before the M5 exit | Steps 1 to 4 below the table (prepare, start, confirm items 1 to 7, check the log and restore the Node ABI). A short mock session gives fewer than 300 samples; record the count. |

Manual live session steps (run each block in the repository root; `LOG` must be set in the shell that runs blocks 2 and 4):

1. Prepare:

```sh
REPO="${TMPDIR:-/tmp}/jevcode-m5-repo"
rm -rf "$REPO" && cp -R fixtures/rate-limit/repo "$REPO"
git -C "$REPO" init -q && git -C "$REPO" add -A
git -C "$REPO" -c user.name=m5 -c user.email=m5@example.invalid commit -qm seed
rm -f "${TMPDIR:-/tmp}/jevcode-m5-live.db"*
pnpm --filter jevcode-desktop build && pnpm --filter jevcode-desktop run rebuild
```

2. Start (output goes to the log file, not the terminal):

```sh
LOG="${TMPDIR:-/tmp}/jevcode-m5-live.log"
JEVC_AGENT=mock JEVCODE_TRACE_PERF=1 JEVCODE_DB="${TMPDIR:-/tmp}/jevcode-m5-live.db" pnpm --filter jevcode-desktop start > "$LOG" 2>&1
```

3. Open `$REPO`, start the task "Add a Redis-backed rate limiter to the API server and make it fail open when Redis is unavailable.", press **Trace** while it runs, and confirm: (1) the trace window opens light with no dark flash, at least 1000 px wide, in Live, and new steps appear within about a second; (2) selecting an earlier row switches to Review ("Live follow paused" once), later appends raise "N new", the selected row stays in place and keyboard focus never moves; (3) `G` or the "N new" pill returns to the live edge and Live resumes; (4) pressing **Trace** again focuses the same trace window, also when minimized, and no second window opens; (5) **Request changes** on a step focuses the main window, the composer holds the prior draft plus the note on a new line with the caret at the end and the Steer/Queue choice unchanged, and nothing is sent until the button is pressed; (6) when the agent completes, the trace window shows the session as ended and Live is disabled; (7) closing the main window closes the trace window.

4. Quit the app, then:

```sh
LOG="${TMPDIR:-/tmp}/jevcode-m5-live.log"
node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").split("\n");const t=l.filter(x=>x.startsWith("TRACE_PERF tv:live-tick ")).map(x=>Number(x.split(" ")[2])).sort((a,b)=>a-b);console.log("trace window live tick p95",t.length===0?NaN:t[Math.max(0,Math.ceil(t.length*0.95)-1)],"ms over",t.length,"samples")' "$LOG"
grep -c -e SMOKE_FAIL -e 'rejected:' "$LOG"   # expect 0
pnpm --filter jevcode-desktop rebuild:node    # expect: native modules restored to node ABI
```

If `rebuild:node` leaves node-pty without `build/Release/pty.node` and `spawn-helper`, restore both from its prebuilds.
