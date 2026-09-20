# Performance vs SPEC §13 SLOs

Measured 2026-09-19 (macOS dev machine, storage-backed SQLite) with `scripts/perf.mjs`
(fixture replays) and `scripts/soak.mjs` (10k-event soak).

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
| Event store growth cap | 1M events/session, then archive | soak stored 75,181 events for 9,993 records (7.5x amplification: facts + projections + jev logs + snapshots). The cap is enforced by schema/bound checks | PASS |

## Soak (SPEC §16 acceptance criterion, T9-2)

`node scripts/soak.mjs` replays 9,993 generated records (formatting/file-noise
bursts + periodic real changes + tests + decisions) through the real pipeline
(degrade router, storage-backed, SQLite in tmpdir):

- No crash. The session reached `completed` and emitted the completion surface.
- Event store: 75,181 events < 1M cap.
- SurfaceManager (headless, real API): no full swaps under the interaction lock
  (0 violations), pinned surface never replaced, generative surfaces bounded.
- Timings: total 165s, ingest 127s, final projection flush 38s, coordinator
  throughput ~455 events/s end-to-end (ingest includes per-record zod
  validation and SQLite appends).
- `compileSkeleton` 0.001ms average.

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

## How to reproduce

```
pnpm build
node scripts/perf.mjs    # fixture replays: persist latency, first-surface latency, compile times
node scripts/soak.mjs    # 10k-event soak with SurfaceManager invariants
JEVCODE_SOAK_EVENTS=2000 node scripts/soak.mjs  # smaller soak for quick checks
```
