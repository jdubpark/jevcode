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

## Capture ingest at the M1b exit (2026-10-01, trace viewer spec §12 M1b)

Budget: the median `ingestMs` over 3 default soaks (`node scripts/soak.mjs`, 9,993 records) is at most 1.10 × the median over 3 soaks at the merge base `6b3e131`. The two sides alternate, so drift during the hour affects both.

| Run | Merge base `6b3e131` | Head | Ratio |
|---|---|---|---|
| A1 lane head `7a8eba3` (2026-10-01 09:15 to 10:40, load 5.5 to 15.6) | 645,711 / 639,013 / 644,800 ms, median 644,800, units 4,901 | 1,070,018 / 1,009,812 / 1,056,469 ms, median 1,056,469, units 4,901 | 1.638, FAIL |
| `main` + `tv/m1b-ingest` (2026-10-01 11:36 to 12:59, load 6.7 to 16.1) | 644,317 / 1,501,824 / 657,070 ms, median 657,070, units 4,901 | 659,404 / 659,808 / 664,473 ms, median 659,808, units 4,901 | 1.004, PASS |

The cause was in `attachAgentCallIds`, which A1 added to `packages/semantic-core/src/clustering.ts`. It checked `owners.includes(unit.id)` for every evidence entry of every unit. A soak burst lands in one idle bucket, so every validation fact belongs to every unit, and the check grows quadratically. The coordinator reruns `clusterSession` on every rebuild.

Profile at 5,000 events:

| Commit | Ingest | `attachAgentCallIds` self time | `clusterSession` |
|---|---|---|---|
| Base | 92.2 s | (not listed) | 23.4 s |
| A1 head | 155.9 s | 26.1 s | 65.6 s |

The fix (commit 113902b) compares only the last owner added, since one unit's entries are visited in one inner loop. The output is unchanged. `clustering.bench.ts` (vitest bench only) covers it: 4,496 ms before and 1,663 ms after at 200 bursts.

The base run at 1,501,824 ms coincided with a load spike from other sessions; the median absorbs it. A second, older quadratic exists at the base (`bucketUnits.includes(draft.id)` in the unit loop, about 15.8 s at 5,000 events) and is left for later.

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
| Live tick (poll apply + selectors + commit) | p95 ≤ 16 ms | M5 | Dev host, soak, headless Chrome (2026-10-01 08:28 to 08:55, load 3.4 to 5.2, "Canvas and signals from the previous commit" below; 3 runs of 98 samples per cell, 294 pooled): Hybrid median 27.1 ms, p95 33.3 ms (a6eaf99: 29.9 / 36.4; 5626b9a, incremental finalize only: 51.9 / 52.6, p95 63.6 / 68.0; main 9a8b89e: 178.2 / 173.9, p95 193.3 / 190.2); Canvas median 48.0 ms, p95 55.3 ms (a6eaf99: 64.6 / 73.3; 5626b9a: 83.1 / 81.4, p95 91.4 / 91.8). The run on the reference machine is recorded under "M5 exit checks" below (p95 36.3 ms, n 98) | MISS (about 2.1× in Hybrid, 3.5× in Canvas); accepted for v1 by the product owner on 2026-10-01 as a known limit (spec §10 "v1 decision") | dev host `?bundle=soak&perf=1&drip=20,1000,-2000`, plus the mock-adapter trace window (`JEVCODE_TRACE_PERF=1`) |
| Soak open in the Electron trace window, first paint (trace profile) | ≤ 500 ms | M5 | 276 ms, median of runs 1 to 5 (276, 285, 273, 277, 273; run 0 warm-up 275), after the C3b rebase (2026-10-01, load 8.58–10.01, Hybrid active, Canvas mounted hidden); 294 ms after the full-load fix and 218 ms at D-8 before it | PASS | `JEVCODE_SMOKE=1 JEVCODE_SMOKE_TRACE=1 JEVCODE_DB=<copy of the kept soak DB>` |
| Soak open in the Electron trace window, full load (trace profile) | ≤ 3,000 ms | M5 | 2,797 ms, median of runs 1 to 5 (2,854, 2,797, 2,749, 2,845, 2,792; run 0 warm-up 2,817), after the C3b rebase (2026-10-01, load 8.58–10.01, Hybrid active, Canvas mounted hidden); 2,858 ms after the full-load fix (load 5.8–7.2) and 4,571 ms at D-8 before it | PASS, thin margin (203 ms, 6.8 %; every run 2,749 to 2,854 ms); re-measure at H5 on an idle machine | same |
| Console append latency in the main window (row stored → line painted, push hint) | p95 ≤ 150 ms | Phase A | p95 60, 75, 58 ms (p50 15 ms; max 71, 80, 71 ms) over 1,052–1,053 rows with the turn-end pass committing each row as it is produced, in 20 ms slices (lane 03 PL-2, 2026-10-03, load 5.4 / 3.9 / 3.3 before the runs). The p95 is above D-6's 26 ms because the pass's ~480 rows now commit over about 110 ms instead of together after a 160–170 ms block, and spec §7's 50 ms hint window spaces their delivery; the max fell from 175–186 ms because no row waits out a block. D-6: p95 26 ms, p50 16 ms, max 186 ms over 1,049–1,128 rows; runs p95 26, 26, 26 ms (p50 16–17; max 175, 186, 185) with the turn-end sync in one transaction (lane 03 D-6, 2026-10-03, load 2.6 / 2.5 / 2.3 before the runs). Before it: p95 143, 145, 145 ms (load 12.2 / 4.2 / 3.3), the tail being the turn-end batch's rows, each committed alone while main stayed busy. The max is the agent_completed row, committed before the batch and served only after it. Evidence smoke of 80 steps (git_hunk and vitest test_result facts, 150 ms between entries; 1,052 trace rows after PL-1, was 7,379 and p95 192 ms before it); Console rows measured in rAF | PASS | `node apps/desktop/scripts/smoke-workspace.mjs` (`SMOKE_CONSOLE`) |
| Main-process block at a turn end (the longest synchronous stretch from agent_completed to the end of the turn-end pass; evidence smoke, 80 change units) | ≤ 50 ms (spec §6.1 max synchronous block; lane 03 PL-2) | Phase A | PL-2 (2026-10-03, temporary lag monitor, load 6.1 / 8.6 / 4.1): longest block 22.4, 24.4, 26.8 ms; the pass's work, 104–114 ms, now runs in five slices of 18–27 ms. Before PL-2 (82022bb, same spans): 172.6, 162.9, 161.7 ms in one block (load 4.1 / 2.6 / 2.0), of which 44–47 ms was 160 per-decision Jev debug reads and sends and 15–17 ms six snapshot reads. PL-2 also dropped D-6's transactions (D-6 review I-1), which costs about 22 ms of commits over the whole pass (storage replay of the batch with cached statements: 53–58 ms a commit per row, 32–34 ms in one transaction). D-6: 176.6 ms with each of the batch's ~490 writes committing alone; 170.5 / 170.8 ms with the batch in one transaction (the transaction itself 125.4 / 121.8 ms). A storage-only replay of the same 494 rows takes 61–72 ms with a commit per row vs 45–46 ms in one transaction, so most of the block is CPU in the Jev and surface stages, not commits (2026-10-03, load 1.9–2.1) | PASS (PL-2) | temporary instrumentation (setImmediate lag monitor from agent_completed; D-6: setImmediate probe), not committed |

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

### Canvas and signals from the previous commit (2026-10-01, `tv/incremental-finalize`, 6e72834 to 4e6cd2e)

The Canvas live tick re-derived every frame and every item on each commit. On the soak tail a 20-row tick changes about 32 steps and 20 chapters, no finding, and flips no step bad or running (scratch probe over 100 ticks), so almost everything can be kept by object identity (spec §6.4):

- **Frame marks** (`buildFrameMarks`, `frame-label.ts`). A frame keeps its tone, running flag and flag while its members resolve to the same Step and Chapter objects and no step they list flipped bad or running. A flip scans chapter step lists once to find the frames it reaches. Claim flags read findings directly and are always redone. `criticalFrameKeys`, the running check and the Overlay's flags read the marks. Node probe: 8.6 → 1.1 ms per tick.
- **Routing memo** (`canvas-routes.ts`). A step's home is the lowest-anchor placed chapter it lists; a shared run lists 4,861. The memo keeps each step's minimum, and for the same Step object checks only the placed chapters whose anchor, category or presence changed. It scans again when the kept minimum itself changed, or when more than 64 changed against a short list. Per frame, the distinct validation steps are kept while the frame validates from the same chapter objects.
- **Items memo** (`canvas-layout.ts`). Per current chapter the noise flag and item are kept. A kept chapter object keeps its flag unless it lists a step whose anchoring changed. Repeated item keys are grouped only when one repeats.
- **Signals** (`buildSignalScan`, `signals.ts`). Each rule visited all 7.9k steps and read several fields of megamorphic Step objects. The scan records per position what the rules test for (run with or without a target, non-duplicate edit, destructive command, severe guardrail). A position holding the same Step object keeps its category, so a commit categorizes only the steps it changed. The rules then visit only the runs, edits, claim steps, destructive commands and guardrails.
- **Graphic lookups** (`entityPositions`, `stepPositions`, `format.ts`). The Outline's chapter graphics mapped every entity and step per session. A Live session now copies the previous session's maps when the old paths or ids keep their positions, and adds the appended ones. The story rows resolve turn steps through the same index.

Every memo holds only its own commit's objects, never an earlier memo, so a Live chain keeps one generation (review I2 found `traceIndexChanges` holding every earlier index; fixed in 1c9c7fe).

A Live session ends with one full rebuild: the commit where the session turns terminal (`live` flips to false) is rebuilt in full instead of from the previous commit, about 200 ms on the soak (incremental-model review 1, M4). It happens once per session and is not part of the per-tick budget above.

Tests: incremental == fresh after every commit for the layout (through a copy of the previous layout that carries no memo) and the marks (`canvas-live-tick.equivalence.property.test.ts`: random rows, row by row, fixtures, soak-shaped rows, hand-edited chains including a new chapter-category edit, shared runs under edits, and targeted cases). The fold property checks the rules over a chained scan against the rules over every step after every batch (`fold.incremental.test.ts`). The lookups are checked against fresh lookups over list-edit chains (`graphics.test.ts`). Work gauges count what a drip re-derives, at two session sizes. RED: each keep rule was broken once and a suite failed. Three rules first survived the generators and got targeted cases: a claim flag whose finding moves while the claim step is kept, a kept noise chapter whose own step starts or stops anchoring a finding, and a chapter that does not list a widely shared run moving its anchor below the run's home. The mutants that still survive are equivalent: keeping an item whose anchor moved (its key carries the anchor) or whose turn moved (a placed item never reads it again), and letting the rules visit duplicate-poll edits or untargeted runs (they skip them).

Node probe per 20-row tick (fold all but the last 2,000 soak rows, then 60 ticks; chained index and layout; load 4.4 to 6.6): `layoutCanvas` 22.5 → 10.4 to 11.4 ms, frame passes 8.6 → 1.0 ms, `finalize` 2.3 → 1.5 ms, `buildOutlineRows` 2.6 → 1.7 ms.

Dev host HUD (`tv:live-tick`), `vite preview` of the minified build, headless Chrome 1440 × 900, `?bundle=soak&perf=1&drip=20,1000,-2000`, Chapter level, real time. The drip gives 98 samples per run, so each cell has three interleaved runs (294 samples pooled); 1-minute load 3.4 to 5.2 (`uptime` before each run). Before is a6eaf99 (the incremental indexes), after is 364d821 (4e6cd2e's map changes came later and are not in these runs):

| View | Before median / p95 per run (ms) | Before pooled | After median / p95 per run (ms) | After pooled |
|---|---|---|---|---|
| Hybrid | 30.0 / 36.3, 29.7 / 36.1, 30.5 / 38.2 | 29.9 / 36.4 | 26.9 / 34.4, 27.4 / 32.5, 27.1 / 32.3 | 27.1 / 33.3 |
| Canvas | 65.1 / 74.0, 65.8 / 74.0, 62.4 / 72.9 | 64.6 / 73.3 | 47.6 / 54.2, 48.6 / 55.3, 48.6 / 58.5 | 48.0 / 55.3 |

An earlier interleaved A/B of the Canvas cuts alone (9fdb2fa, 08:01 to 08:27, load 3.8 to 7.1, three runs per cell) read Canvas 63.9 / 73.2, 63.4 / 74.3 and 62.5 / 72.8 ms before and 49.5 / 58.8, 48.6 / 60.0 and 49.2 / 60.2 ms after, with Hybrid unchanged (29.4 / 35.7, 28.2 / 37.3, 30.5 / 37.8 before; 29.1 / 36.6, 29.7 / 36.6, 28.8 / 35.4 after).

Dev host open is unchanged: Hybrid first paint 186 to 192 ms before and 189 to 194 ms after, full load 965 to 981 ms before and 975 to 986 ms after; Canvas full load 994 to 1,003 ms before and 991 to 993 ms after.

Where the tick goes now (Chrome CPU profile of the unminified build, 40 ticks, per tick). Hybrid (the unminified HUD reads 25.4 / 32.8 ms): `finalize` 3.8 ms (signals 0.5 ms and the scan 0.3 ms, turn marks 0.75 ms; was 5.5 with signals 2.6), Outline 4.0 ms (rows 3.2; was 4.7), Spine 3.4 ms (rows 2.2), React commit 2.7 ms, Overview 2.6 ms (build 1.9), `buildTraceIndex` 1.7 ms, time scale 0.75 ms, GC 6.6 ms, and 11.6 ms of `(program)`, native time outside JavaScript (DOM, style and layout of the commit). Canvas (unminified 47.1 / 55.7 ms): `layoutCanvas` 11.3 ms (items 4.3, routing 3.9; was 16.5), frame marks 3.6 ms (was about 15 for tone, critical, flag and labels), `frameModel` for mounted frames 2.6 ms, `buildFrameContext` 1.1 ms, plus the shared work above (Outline and Spine also render under Canvas). The marks still re-derive the ~14 of 135 frames that hold a changed chapter each tick, and a noise stack walks its ~4,000 member links when it does.

Both views still miss 16 ms p95, Hybrid by about 2.1× and Canvas by about 3.5×. What is left is spread thin: no single stage above 4.5 ms in Hybrid, and GC plus native commit time make up about half of it. Next levers: fewer DOM changes per commit in the Outline and Spine (the `(program)` share), per-commit allocation (time-scale inputs, Spine rows), an incremental placed-chapter set for Canvas routing and items (still O(chapters) map reads per commit), and per-member tone counts for noise stacks.

### M5 exit checks

M5 exit checks (deferred by the person on 2026-09-30, run on 2026-10-02 by an agent driving Chrome and Electron over CDP; the steps below are what they followed). The automated preparation is done: the soak bundle is copied to `apps/trace-viewer-dev/public/bundles/soak.json` (git-ignored) and the dev host is built; the scratch repository exists at `$TMPDIR/jevcode-m5-repo`.

| Check | Status | Exact steps |
|---|---|---|
| Live tick p95 on the dev host | MISS, accepted for v1 (measured 2026-10-02, main e901b13) | Headed Chrome 154.0.8037.93, DPR 2, display at 120 Hz, window not focused (background-throttling flags off), Hybrid, `?bundle=soak&perf=1&drip=20,1000,-2000`, 6.5 min, 1-minute load average 12.65 before the run (5.51 after Part 1). `tv:live-tick` n 98, median 22.4 ms, p95 36.3 ms, max 248.7 ms against p95 ≤ 16 ms. The window yields about 100 samples, not 300: the drip releases only the last 2,000 rows at 20 per tick, so the session reads as ended after about 100 s and the Live control disappears; 6 minutes cannot reach 300 ticks with this setting. The shortfall is accepted for v1 by the product owner. |
| Manual live session on the mock adapter (items 1 to 7) | PASS (run 2, 2026-10-02, main e901b13) | All seven items passed on a fresh repository and database; the log check is below. Notes on how each was driven: (a) the mock script is two entries 1 ms apart and the session completes in about 12 ms, before **Trace** can be pressed, so the first window opened on a completed session (Review, Live shown as Completed and disabled) and items 1 to 3 ran on a resumed session (**Continue** put the DB state back to `running`; the window was reopened to get Live). (b) The repository was opened through the bridge (`window.jevcode.repo.open(<repo>)`, the RecentRepos call), not the native Open dialog; renderers were driven over CDP with trusted input events, because the cmux-cua tool was unavailable (macOS onboarding incomplete, no accessibility or screen-recording grant). (c) Run 2 started Electron with `--remote-debugging-port=9335 --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`; in run 1 the renderers went hidden whenever another app was frontmost and the trace window stalled (one `tv:live-tick` of 102,256 ms), which was background throttling and not a product defect. Item 1: steers visible 321 ms and 130 ms after their DB write, `tv:live-tick` 9.5 and 5.8 ms. Item 2: clicking an earlier row gave Review, one "Live follow paused", pill "1 new" then "2 new", selected row top fixed at 493 px, focus stayed on the row. Item 3: Shift+G and the pill both returned to Live with the pill gone. Item 4: second **Trace** raised the same window, also from minimized, 2 page targets throughout. Item 5: **Request changes** put the quoted reference at the end of the draft (caret at the end), focused the textarea and raised the main window; Steer now / Queue next unchanged, `instruction_inbox` 6 to 6, `agent_events` 9 to 9. Item 6: a window opened on a `starting` session showed "Waiting for the agent's first event", then went to Review with Completed (disabled) and "Session ended" about 1.0 s after `endedAt`. Item 7: closing the main window closed the trace window (0 page targets). `pnpm --filter jevcode-desktop test` after `rebuild:node`: 35 files, 308 tests passed. |
| Log check (step 4, run 2 log) | PASS | Trace-window `tv:live-tick` p95 12.4 ms over 7 samples (9.5, 5.8, 5.1, 4.0, 2.9, 6.1, 12.4 ms), against p95 ≤ 16 ms; too few samples for a p95 budget (300 required), so the count is recorded. `grep -c -e SMOKE_FAIL -e 'rejected:'` gave 0. Run 1 (hidden-window stall): 2 samples (4.5 and 102,256.4 ms), grep 0. |
| Resumed session, open trace window (finding, fixed in 3119321) | FIXED | A trace window opened on a completed session stopped polling at the terminal state, so after the session resumed (DB state `running`) it stayed on "Completed" with "Session ended" and showed no new rows until it was reopened. The DataController now keeps a 5 s terminal poll (`TERMINAL_POLL_MS`) and returns to the 1 s poll when the state leaves terminal or rows arrive (spec §7.11). Also fixed: a window opened before the first prompt showed "<repo> /" and "0 ms"; it now shows "Waiting for the first prompt" and no duration until the first event. |

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

## Codebase map (console-explainer lane 04, M-8)

Spec §11 budgets for the explainer stage. Bench: `pnpm --filter jevcode-desktop exec vitest bench --run src/main/pipeline/explainer-overview.bench.ts` (synthetic pnpm workspace, 1 KB TypeScript files with relative, workspace and package imports; a new worker pool per iteration). Soaks: `scripts/soak.mjs` with `JEVCODE_SOAK_EXPLAINER=1` (the stage on a generated repo, narrator off), alternating runs, `uptime` before each.

| Measure | Budget | Measured | Status | Source |
|---|---|---|---|---|
| Rule-based map visible after repo open, 5,000 files | ≤ 2 s | PENDING (quiet-machine run) | PENDING | bench, row 1 |
| Full scan and map, 20,000 files | ≤ 20 s | PENDING (quiet-machine run) | PENDING | bench, row 2 |
| Longest synchronous block of the stage, 20,000 files (spec §6.1): workspace layout (single-file edit, add, remove, full rebuild) and one 18,000-file app with entry-less packages (add in the app, add in a package, 500-file batch) | ≤ 50 ms | PENDING (quiet-machine run). Under load, 2026-10-02 fix round 2 (load average 19-22): workspace 40.8, 37.2, 25.7, 22.9 ms (medians 22-23 ms); big app 41.5, 21.4, 38.9 ms (medians 25.2, 20.1, 36.4 ms). Round 1 runs at load 10-21 had single-run spikes to 77 ms (add) and 143 ms (rescan) inside vitest; plain Node probes stayed at 19-23 ms (edits) and 14-17 ms (rescans) | PENDING | bench, stage rows |
| M1b soak ratio with the explainer on (5,000-file repo), against the W0 base | ≤ 1.10 | PENDING (3 + 3 alternating runs) | PENDING | guard A |
| Ingestion under a running 20,000-file scan (2,000 events, yield every 10, pause every 100 once the scan finished; base pauses on the same records); event loop delay medians: p99 ≤ 1.10 × base, max ≤ 1.25 × base | ≤ 1.10 | PENDING (3 + 3 runs) | PENDING | guard B |

Smoke run under load, not the budget measurement (2026-10-02, shared machine under heavy multi-lane load): the bench at 1,000 and 2,000 files (2 iterations each) averaged 304 ms and 417 ms; the soak with `JEVCODE_SOAK_EVENTS=300`, explainer on 500 files, finished without `SOAK_FAIL` at 238 ms ingest (explainer off: 237 ms; with `JEVCODE_SOAK_YIELD_EVERY=50`: 269 ms) and reported `explainer.rows` 1. These runs only show that the bench and the switches work.

The rule-based map row measures scan, import extraction, componentize and snapshot assembly; the row write and push hint add under 10 ms. The stage rows drive a real stage over an in-memory 20,000-file model (11 import specifiers per file) and print the longest gap between `setImmediate` heartbeats per row after the run: an edit, add or remove re-resolves only the changed files and the files whose cached lookups read an added or removed path, and recomputes only the touched components; a full rebuild (rescan, manifest change, or a watcher batch over 1,000 files) runs in 12 ms slices; the overview, the snapshot assembly, the row append and the `overview_state` save each run in a turn of their own.

Guard A's ingest loop is synchronous, so it measures the stage's cost on the ingest path (the `file_changed` hook); its rebuilds run after ingestion. With `JEVCODE_SOAK_EXPLAINER=1`, every `file_changed` fact rewrites one of 200 generated files (a new export each time, written asynchronously) and reports that path to the stage, so the stage's settle and incremental rebuild run on real changes. Guard B yields every 10 records (`JEVCODE_SOAK_YIELD_EVERY=10`) and pauses 600 ms, longer than the 500 ms settle, every 100 records (`JEVCODE_SOAK_PAUSE_EVERY=100`), so the scan's I/O, hashing and worker parsing and then the rebuilds run between records. With the explainer on, pauses start only once its first scan finished, so a pause never hides the scan from `ingestMs`; the JSON reports the first record that paused (`firstPauseAt`), and the base run (explainer off, same `JEVCODE_SOAK_EVENTS`, `JEVCODE_SOAK_YIELD_EVERY` and `JEVCODE_SOAK_PAUSE_EVERY`) passes it as `JEVCODE_SOAK_PAUSE_FROM`, so both runs pause on the same records. The pause pattern matters: the pipeline's sync timers fire during pauses, and in one 2,000-event run that paused from the start with the explainer off, ingestion took 43.7 s with 106 UI specs instead of 7.6 s with 16. `ingestMs` leaves the planned pauses out, so a late resume (a blocked loop) still counts. Every soak JSON carries `eventLoopDelayMs` (p50, p99, max, samples of `perf_hooks.monitorEventLoopDelay` over the ingest window; with a loop that never yields, the max is the whole loop) and, with the explainer on, `explainer.duringIngest` (forwarded changes, rewrites, scans finished, snapshots built, rows written and pauses skipped before the scan finished). Under load on 2026-10-02 the pipeline alone (explainer off) blocked the loop for up to 0.59 s at 600 events, 2.48 s at 2,000 events and 7.5 s at 4,000 events, so the event loop delay gates compare head with base instead of using an absolute value (head/base max 0.97-1.10, p99 1.03-1.05 in matched pairs). With ingestion saturating the loop, a 20,000-file scan (and a 5,000-file one) did not finish within 2,000 events (the 20,000-file scan not within 4,000 either), so guard B covers ingestion under a running scan; rebuild coverage comes from the bench's stage rows and from soaks on a repo whose scan finishes during ingestion (2,000 events on a 1,000-file repo: the scan finished before record 1,800, then 2 pauses, 3 snapshots and 4 rows while ingesting). Under saturated ingestion the scan reads about 110-120 files/s: each file's lstat and read callbacks need several loop turns, and each turn waits for a 10-record ingest chunk (loop delay p50 about 58 ms at 2,000 events).

## Console (console and explainer spec §11, phase A)

Dev host in headless Chrome: `node apps/trace-viewer-dev/scripts/smoke.mjs --views console --embedded --console-perf`.
Input: the `console-10k` bundle (`apps/trace-viewer-dev/scripts/console-bundle.mjs`: 2,100 units, 10,513 Console
steps), embedded chrome, drip of 1 row per 120 ms from `lastSeq − 600`. Append latency runs from the drip's
`tv:rows-released` mark (the dev host's "row stored") to the paint after the Console commit (`tv:console-append`),
from the oldest pending release. Scroll counts rAF intervals over a 3 s scripted reader scroll, rounded to the idle
refresh interval. Electron numbers come from the main-window smoke (lane 03 D-6).

| Budget | Target | Result (median of 3 runs) | Status | Measured by |
|---|---|---|---|---|
| Console append latency | p95 ≤ 150 ms | median 15.7 ms, p95 25.0 ms, n 300 per run (runs: p95 18.3, 25.0, 41.8) | PASS | `CONSOLE_PERF` line |
| Console scroll at 10k steps | ≤ 5% dropped frames | 0.00% dropped at 16.7 ms refresh, p95 1 frame (runs: 0.00%, 0.00%, 0.55% at a 33.3 ms refresh) | PASS | `CONSOLE_PERF` line |

Evidence-fact rows (about 20% of drip ticks in this bundle) release a mark and so count as append samples without adding
a Console row; the sample then measures a commit that paints no new line. Run 3 ran at a 33.3 ms refresh baseline (the
machine fell to a 30 Hz compositor under load), so its frame-based and paint-based numbers are inflated by up to one
33 ms frame against the 16.7 ms of runs 1 and 2.

Runs on 2026-10-03, a shared development Mac under multi-lane load, load average 9.5–17.4 (`uptime` before each run:
9.94, 9.52, 17.39 for the one-minute figure). The numbers are upper bounds for a quiet machine.

The Console's per-frame drift anchor (a `getBoundingClientRect` of the top row and the scroller on every scroll frame)
runs only when diagnostics are enabled, that is in the dev host's selftest. The runs above measured it; production
frames since the lane 02b fix wave (triage t1) do no layout read in the frame handler, so the scroll result is an upper
bound for them as well.

## Pipeline write volume (2026-10-03, PL-1)

Every pipeline store write appends an `events` row. Before PL-1 two things made the trace grow quadratically in a
working session. The validation, failure and decision stores wrote every record again on every rebuild, with no
unchanged-payload check (the change-unit and graph stores already had one). And a passing test run attached to every
unit with a file in its idle bucket; a bucket ends only after 120 s without facts, so an agent that keeps working
stays in one bucket, every unit collects every run, and each new run or hunk rewrites every unit. The D-6 smoke
database had 3,256 validation rows, 3,176 of them byte-identical, and 8.8 KB `change_unit` rows carrying 80 validation
ids each.

Fixes:

- Stores (5dc88c7, 123ee1b). The three stores write only when the payload differs from the row last written for that
  id (`apps/desktop/src/main/pipeline/storage-stores.ts`). The decision store compares with the database's current
  row through `getDecision`, in the form the projection keeps, because the runtime also writes decisions directly.
- Run attachment (SPEC §6.3, `packages/semantic-core/src/clustering.ts`). PL-1 (7482ef0) gave a passing run only the
  units changed since the previous run, compared by 500 ms batch window, and left failing runs bucket-wide. Fix round
  1 (102de80) keyed the previous run per command and added "a passing run also reaches units whose latest run
  failed". That brought the quadratic back for per-file test commands and for failing runs (table below). Fix round 2
  (3ee6e66) gives every run, passing or failing, only its range: the units changed since the previous run of any
  command, or, on a command's first run in the bucket, since the last run before the most recent change. It keeps
  the failed-latest rule for passing runs.

The five replay fixtures project byte-identical units, validations, failures, semantic events and graph rows on
`main` and on every fix (each has a single run after all its edits).

Probe: `apps/desktop/scripts/pipeline-scale-probe.mjs` (no network). It feeds a synthetic stream through the real
`PipelineCoordinator` with `createStorageStores` on a temporary SQLite file. Each step is a `git_hunk` on the next of N
files (round robin); every k-th step adds a `command_executed` and a `test_result` 300 and 450 ms later. Commands and
failures:

- `--commands per-file` (the default, and the shape of the original measurements) runs `pnpm test -- module-<n>` for
  the file just edited.
- `--commands single` runs `pnpm test` every time.
- `--fail-every 2` makes every second run fail on the edited file's test, which has no facts and so gets a unit of its
  own.

Traced rows are the session's `change_unit`, `validation`, `failure` and `decision` event rows after `flush()` (no fact
or agent rows: the probe feeds facts to the coordinator directly). Late ingest is the per-record `ingest()` time over
the last 10% of records; the record that closes a batch window pays its rebuild.

```
pnpm --filter @jevcode/semantic-core --filter @jevcode/storage build
pnpm --filter jevcode-desktop exec tsc -p tsconfig.build.json
node apps/desktop/scripts/pipeline-scale-probe.mjs scale            # or smoke; add --commands single, --fail-every 2
```

Scale: 200 files, 1,000 hunks 2 s apart, a run every 5 hunks (200 runs). Each cell gives traced rows / payload, then
late ingest p50 / max.

| Shape | Before (`main` 6755660) | Store dedupe only | PL-1 (7482ef0) | Fix round 1 (102de80) | Fix round 2 (3ee6e66) |
|---|---|---|---|---|---|
| Per-file commands, all pass | 136,600 / 344.9 MB; 236.1 / 400.1 ms | 37,100 / 328.7 MB; 211.6 / 368.9 ms | 2,195 / 1.9 MB; 19.1 / 29.8 ms | 37,100 / 289.4 MB; 200.4 / 355.5 ms | 2,195 / 1.9 MB; 22.2 / 94.8 ms |
| Single command, all pass | | | 2,195 / 1.9 MB; 19.3 / 26.7 ms | 2,195 / 1.9 MB; 19.5 / 35.0 ms | 2,195 / 1.9 MB; 19.7 / 28.5 ms |
| Single command, every 2nd run fails | | | 19,895 / 98.2 MB; 127.6 / 257.1 ms | 37,300 / 342.1 MB; 219.2 / 414.9 ms | 2,890 / 2.6 MB; 24.4 / 35.8 ms |
| Per-file commands, every 2nd run fails | | | 19,895 / 98.2 MB; 128.1 / 362.8 ms | 37,300 / 342.1 MB; 219.1 / 545.9 ms | 2,890 / 2.6 MB; 24.5 / 35.8 ms |

On the original shape (per-file, all pass), `main` wrote 36,900 + 99,700 `change_unit` + `validation` rows and 80,240
`graph_edge` rows; fix round 2 writes 1,995 + 200 and 2,240. Probe wall time on that shape: 142 s on `main`, 12 s at
7482ef0, 117 s at 102de80, 15 s at 3ee6e66; the other fix round 2 shapes take 13 to 16 s.

Smoke: 80 files, 80 hunks 0.9 s apart, a run after every hunk. Traced rows / payload.

| Shape | Before (`main` 6755660) | PL-1 (7482ef0) | Fix round 1 (102de80) | Fix round 2 (3ee6e66) |
|---|---|---|---|---|
| Per-file commands, all pass | 6,480 / 15.2 MB | 239 / 0.2 MB | 3,320 / 8.6 MB | 239 / 0.2 MB |
| Single command, all pass | | 239 / 0.2 MB | 239 / 0.2 MB | 239 / 0.2 MB |
| Single command, every 2nd run fails | | 1,879 / 4.6 MB | 3,400 / 15.1 MB | 358 / 0.2 MB |
| Per-file commands, every 2nd run fails | | 1,879 / 4.6 MB | 3,400 / 15.1 MB | 358 / 0.2 MB |

The store dedupe alone removes the repeated validation rows, but every unit still carries every run, so the
`change_unit` rows and the rebuild time stay quadratic. Scoping every run to its range removes that in all four shapes.
At fix round 2 a unit carries at most 5 runs (scale, all pass) or 10 (scale, failing runs), against 200 at 102de80.
The 94.8 ms late-ingest maximum on the per-file shape is a single sample in one run; its p50 matches the other shapes.

Runs on 2026-10-03 on a shared development Mac (load average about 4 to 4.6), one run per cell. The 7482ef0 and 102de80
cells that the earlier rounds did not measure were run from bundles of those commits' `clustering.ts` with the same
probe. The regression guard is `storage-stores.test.ts` ("one long bucket": 40 steps of a single passing command, a
per-file passing command, and a single command failing every second run). Each writes 40 validation rows and at most
120 `change_unit` rows; at 102de80 the second and third shapes wrote 820 and 840. The Console append latency in the
Electron main window (lane 03 D-6) was not re-measured here, and the soak and trace-read numbers above predate PL-1.

PL-2 (lane 03, 2026-10-03): a change unit that leaves the projection stays stored as superseded, and the coordinator
removes it again on every later rebuild. `StorageChangeUnitStore.remove` wrote it each time, past the dedupe, so a
session appended one identical `change_unit` row per rebuild per such unit (D-6 saw 80–82 per unit, which made the
evidence smoke's trace 1,049 to 1,128 rows). The store now skips a unit already stored as superseded (9aa0eb1). In the
Node replay of the evidence smoke, identical consecutive `change_unit` rows went from 101 (two units) to 0 in 3 runs.
The Electron evidence smoke had 0 such rows and 1,051–1,055 trace rows in the 3 PL-2 runs whose database was kept
(Console appends 1,052–1,053 in the 3 check (e) runs); the remaining spread is distinct updates to the first few units
(modules 2–7) whose timing follows the coordinator's real-time rebuilds. The
guard is `storage-stores.test.ts` ("a change unit that leaves the projection").
