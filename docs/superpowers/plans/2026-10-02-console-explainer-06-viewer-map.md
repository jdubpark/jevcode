# Console and explainer, lane 06: viewer map (P-0 to P-5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Never run `git stash`, `git reset --hard` or `git clean`.

**Goal:** Fold `overview_snapshot` rows into `TraceSession.overview`, lay the snapshot out as a pure, sticky role-band map (`layoutMap`), render it as the **Map** view with the viewer's own camera controller and a component Inspector, add the Brief's architecture card, and ship a dev-host fixture of this repository with screenshots compared against approved mockups.

**Architecture:** `src/model/fold-overview.ts` keeps the latest snapshot row (replace semantics) and builds an `OverviewModel` in which an unchanged component keeps its object identity between `finalize` calls. `src/layout/map-layout.ts` is React-free and clock-free: role bands left to right (`MAP_BAND_ORDER`), barycenter order within a band (4 sweeps, tie-break by name then id), sticky order across snapshots of the same repo, one fixed card geometry for every zoom level, and smooth edges routed through band gutters and the gap rows between cards so no edge passes under a card. `src/ui/views/map/MapView.tsx` draws light band lanes, DOM cards and one SVG edge layer in a world layer moved by `createViewportController` (no React Flow), keeps its own component selection (`ViewState.mapSelection`), and hands it to `ComponentInspector`. The Brief's architecture part comes from `briefArchitecture(session)`, called by lane 02's `buildBrief`.

**Tech Stack:** TypeScript 5.9 (strict, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`), React 19.2, zod 3 via `@jevcode/contracts`, vitest 3 (`vitest bench` for budgets), fast-check 4.10.1, @testing-library/react 16 and user-event 14.6.7 on jsdom 30, Vite 5 for the dev host, headless Google Chrome for screenshots.

**Spec:** `docs/superpowers/specs/2026-10-02-console-and-explainer-design.md` (the spec) E12, E13, E14, E16, §3.3, §3.4, §3.6, §8.1, §8.3, §8.4, §11, §12. **Interfaces (binding):** `docs/superpowers/plans/2026-10-02-console-explainer-interfaces.md` §1.2, §6.4–§6.6. **Index:** `docs/superpowers/plans/2026-10-02-console-explainer-00-index.md` (task table §3, human gate H2 §8). **Context:** `docs/superpowers/specs/2026-09-28-trace-viewer-design.md` (the viewer spec) §6.4 (incremental finalize and identity), §7.5 (Canvas stickiness P6), §7.12 (visual system). On a conflict the spec wins, then the interfaces file, then this file; each departure is listed below.

## Interface deviations

Every name in interfaces §1.2 and §6.4–§6.6 is kept with its type. These additions and changes were needed against the real code:

1. **`MapLayout` gains two fields** (P-2): `level: MapLevel` (the level the layout was made for, so the view and the Brief thumbnail never re-derive it) and `bands: readonly MapBandColumn[]` (`{ band, x, w, count }` per non-empty band, for the band labels and for keyboard navigation between bands). `MapCard.band` and `MAP_BAND_ORDER` are typed with the alias `MapBand = Role | "side"`, which is the interfaces' `Role | "side"`.
2. **New exports from `src/layout/map-layout.ts`** (P-2): `MapBand`, `MapBandColumn`, `MapExternalChip` (the interfaces' inline external type; `layoutMap` never fills it), `MapEdgeKind`, `MapLevelSpec` (`sideW` replaces the plan's earlier `sideGutter`; `chips` is always 0), `MAP_LEVEL_SPECS` (one geometry for all three levels), `MAP_MARGIN`, `MAP_BAND_LABEL_H`, `MAP_LANE_PAD` (used by the view only), `MAP_SWEEPS`, `mapLevelForZoom(k)`, `mapEdgeWidth(count)`, `bandOf(role)`, `mapImporterCounts(edges)`, `mapHubIds(edges, n)`, `componentForPath(overview, path)`, and (fix wave I-2) `MapLayoutCache` and `createMapLayoutCache()`: one card-level layout per overview object, chained per repo, so a repo's next layout starts from its previous one. Each viewer holds one cache (`MapLayoutCacheContext` and `useMapLayouts()` in `src/ui/views/map/map-layouts.ts`, provided by `TraceViewer` and the test harnesses), shared by the Map, `planMapFit(overview, viewport, layouts?)` and the Brief thumbnail, so the thumbnail always shows the Map's arrangement. `layoutMap`'s signature is unchanged; a `prev` with no placed cards (a scan's first progress snapshot) counts as no `prev`. **`MapEdgePath` gains `kind: "adjacent" | "long" | "same"`**, an additive deviation from interfaces §6.6 (recorded in interfaces §8.4); `mapHubIds` is new beside it.
3. **`buildOverviewModel(snapshot, seq, previous?)`** is exported from `@jevcode/trace-viewer/model` (P-1). Test builders and the UI tests need an `OverviewModel` without folding rows; the fold uses the same function, so there is one way to make the model.
4. **`ViewState.mapSelection: string | null` and the action `{ type: "map/select"; componentId: string | null }`** (P-3). A component is not a step or a unit, so it cannot be a `SelectionId` without touching `trace-index`, `lookup`, `location` and every view. The Map keeps its own selection; the Inspector shows `ComponentInspector` while the view is `"map"` and `mapSelection` is set, and (after the 02b rebase, P-4 Step 1) lane 02's `RightPanel` shows that Inspector instead of the Brief in the same case; Esc on the Map clears `mapSelection` before anything else. The component selection is not written to the location hash.
5. **Session-overlay seam for lane 07** (P-3): `src/ui/views/map/overlay.ts` exports `type MapCardState = "new" | "changed" | "decision" | "failing"`, `interface MapOverlay { cardState: ReadonlyMap<string, MapCardState>; emphasizedEdges: ReadonlySet<string> }` (edge keys `"<from>><to>"`) and `mapOverlayOf(session: TraceSession): MapOverlay | null`, which returns `null` in phase B. `MapView` already renders a card's state mark (in the footer, in place of the file count) and emphasized edges (both ends touched) from it. Lane 07 (S-5) replaces only the body of `mapOverlayOf` (and adds an on/off toggle if its mockup has one); it does not edit `MapView`'s render.
6. **Role icons** (P-3): `ICON_NAMES` gains `role-ui`, `role-api`, `role-agent`, `role-domain`, `role-storage`, `role-tooling`, `role-config` and `fan-in` (the hub glyph); `kind-icons.ts` gains `ROLE_ICON: { readonly [K in Role]: IconName }` (tests → `test`) and `ROLE_LABEL`. External packages use the existing `pkg` icon. `view-map` is consumed from lane 02 (V-2).
7. **`src/layout/map-details.ts`** (P-3): `componentDetails(overview, componentId, session)`, `DETAIL_FILES_SHOWN`, `topPackages(component, n)`, `fileBarPercent(files, maxFiles)`, `listBarPx(count, max)` and `LIST_BAR_MAX_PX`, pure helpers for the component Inspector, the cards' file-count bar and the Inspector's list bars.
8. **`src/layout/brief-architecture.ts`** (P-4): `briefArchitecture(session): BriefArchitecture | null`, returning lane 02's `BriefArchitecture` (`NonNullable<BriefModel["architecture"]>`). `buildBrief(session, index)` keeps the interfaces signature and calls it; `scanning` is filled from a running scan (ruling R3, deviation 11). The Brief's look comes from lane 02's private `Architecture` part in `Brief.tsx`, which P-4 extends with an `overview` prop, a `MapThumbnail` (`src/ui/inspector/MapThumbnail.tsx`) and a `data-brief-architecture` hook; its strings ("<n> components · <k> touched", "Descriptions pending", "Open the map") stay lane 02's.
9. **`ViewerHost.rescanOverview` is reached through lane 02's `useViewerHost()`** (V-4, merged with 02b), so the Retry button lands in P-4, after the rebase; P-3's `MapHeader` takes an optional `onRetry` and shows no Retry until P-4 passes it.
10. **Fixtures outside `fixtures/`** (P-5): `packages/trace-viewer/fixtures/overview-jevcode.json` and `overview-jevcode-rule.json`, written by `packages/trace-viewer/scripts/overview-fixture.mjs`. `evals/src/runner.ts` `listScenarioNames` treats every directory under the root `fixtures/` as a scenario, so a new directory there would break the evals runner.
11. **Orchestrator ruling R3 (overview status), rendered by this lane.** Lane 01 adds `OverviewSnapshot.status?: { scan: { state: "running" | "done" | "failed"; scanned; total; error? }; narrator: "off" | "unavailable" | "pending" | "ready" }` and `counts.totalFiles?`. P-1 adds `overviewStatusOf(snapshot): OverviewStatus` (`src/model/overview-status.ts`, exported from the model barrel), which applies R3's default for rows without `status` (scan done; narrator pending while any purpose is null, else ready). P-3 renders the scan progress, a quiet "Codebase map unavailable", the narrator words ("Descriptions off", "Descriptions unavailable", "Descriptions pending") and "Partial map · 20,000 of 25,310 files"; P-4 fills `BriefModel.architecture.scanning` from a running scan and adds Retry (through lane 02's `useViewerHost().rescanOverview`) to the Brief and the Map header.
12. **Orchestrator ruling R6 (one path → component function).** P-1 adds `componentIdForPath(components: readonly Component[], path: string): string | null` in `src/model/component-path.ts` (exported from the model barrel; lane 07 consumes it and does not create it). A component that lists the file wins (spec §5.2 rule 4), then the longest root that is a whole-segment prefix. A path no component claims that way goes to a catch-all (fix wave I-3): a root-level path (no `/`) to the `"."` component, which holds root-level files only (lane 04 groups a nested file by its directory); a nested path to the `"(other)"` component (the groups past the 200-component cap; it lists at most 400 of their files) when the snapshot has one; a root-level path with no `"."` also to `"(other)"`, where lane 04 puts a `"."` that is past the cap; otherwise null. A nested path never resolves to `"."`, and callers tolerate null. P-2's `componentForPath(overview, path)` strips the repo root and `./`, then delegates to it.

## Spec alignment notes

Points where the spec's text and this lane's build differ. None blocks the lane; the spec owner should reconcile them.

1. **Scan progress and scan failure** (spec §3.3, §6.1 "Mapping codebase · 3,200 / 9,800 files", §6.6 "Codebase map unavailable with Retry") had no data path to the viewer in the spec's snapshot. Ruling R3 adds `status.scan` (deviation 11), and this lane renders it. Before the first snapshot row the Brief keeps lane 02's quiet "Appears here once this repository is scanned." and the Map shows "No codebase map yet".
2. **Narrator off versus pending** (Review Focus 5 asks for "descriptions pending" or "off") could not be told apart from `narrative: null` alone. Ruling R3 adds `status.narrator`; the Map header and the Brief say "Descriptions off", "Descriptions unavailable" or "Descriptions pending" in quiet ink, and nothing when it is `ready`.
3. **The rule-based header names no workspace kind** ("12 components · TypeScript · pnpm workspace", spec §3.4). The snapshot has no workspace field; the header reads "12 components" with "TypeScript · JSON" beside it in muted ink, from `counts.languages`.
4. **Edge routes.** Spec §8.3 said "straight or one-bend paths between band gutters" and also "edges never cross cards other than their endpoints"; the approved H2 Map mockup draws smooth curves instead. An edge between adjacent bands is one S-curve in the gutter. An edge between bands two or more apart leaves through the gutter next to the lower-column card, runs along the gap row between cards (all bands share one row pitch, so the gap rows line up and are free in every column) and returns through the gutter next to the other card; edges leaving one card toward one side share that channel exactly and read as one line. A same-band edge is a shallow bulge on the less loaded side. Each card has one port per side, at its vertical center; direction is not drawn (the Inspector carries imports in and out).
5. **No external chips on the canvas.** Spec §3.4 puts external dependencies in "small chips beside the components"; the approved mockup shows packages only inside detail-level cards (the top two, one row) and in the Inspector's full list. `layoutMap` therefore places no chips at any level (`externals: []`).
6. **Selection dims edges, not cards, to 22%** (spec §3.4 said 30%): the selected or hovered card gets the accent ring (selection only), all of its edges turn accent and draw on top, and every other edge drops to 22% opacity. Cards stay legible so the reader can pick the next one. At rest the Map draws band-to-band edges only; same-band edges and edges into a hub appear with their card's selection or hover (the spec §3.4 text needs this rule). Cards show a file-count bar, not an import-weight bar (spec §3.4 said "an import-weight bar"); import weight is shown by edge width and the Inspector's list bars. Cards no longer show the main language; the Inspector does.
7. **Fit centers and fills the stage.** `k = min((vw − 40) / W, (vh − 88) / H, 1)`, centered on both axes; the bottom 68 px clear the zoom bar. At 1440 px the map runs the full height at about k = 0.77 (the card level, about 104 px of side margin); at 1000 px it runs the full width at about k = 0.52 (the chip level, names at about 11 px). Zoom bands are chip below 0.7, card below 1.4, detail from 1.4 (spec §8.3 said 0.5 and 1.2); Fit never picks detail. Below `MAP_ICON_ONLY_K = 0.48` card names hide and only the footer icon and bar remain (names stay in the tooltip and the accessible name); neither approved width reaches it. `MAP_LEVEL_SPECS` and the thresholds live in P-2 and `map-camera.ts`, so a ruling is a constants-only change.
8. **Selection survives view switches (spec §3.1) for steps only.** The Map's component selection lives in `ViewState` and survives a switch away and back, but it is not part of the location hash and other views ignore it (deviation 4).

## Lane prerequisites

- **Wave:** W1, branch `ce/06-viewer-map`, worktree `/Users/jwpark/Projects/jevcode-ce-06`, created from `<w0>` (index §5). W0 (lanes 01 and 02a) must be merged into `main`.
- **Verify W0 is on `main`** (from anywhere):

```bash
git -C /Users/jwpark/Projects/jevcode show main:packages/contracts/src/overview.ts | grep -c "export const OverviewSnapshotSchema"
git -C /Users/jwpark/Projects/jevcode show main:packages/contracts/src/trace.ts | grep -c '"overview_snapshot"'
git -C /Users/jwpark/Projects/jevcode show main:packages/trace-viewer/src/model/registry.ts | grep -c 'overview_snapshot: "consume"'
git -C /Users/jwpark/Projects/jevcode show main:packages/trace-viewer/src/ui/views/registry.ts | grep -c 'kind: "map"'
git -C /Users/jwpark/Projects/jevcode show main:packages/trace-viewer/src/ui/state/location.ts | grep -c "ViewKindSchema"
git -C /Users/jwpark/Projects/jevcode show main:packages/trace-viewer/src/ui/icons/icon-names.ts | grep -c '"view-map"'
```

Expected: `1`, `2` (`EVENT_TYPES` and `TRACE_ROW_TYPES`), `1`, `1`, at least `1` (`location.ts` derives the view kinds from `ViewKindSchema`, which V-2 extends with `"map"`), `1`. If the third prints `0`, K-1 left `overview_snapshot` as `"hidden"`; P-1 Step 3 sets it to `"consume"` (the registry test requires every `TRACE_ROW_TYPES` entry to be consumed).

- **Lane 02's Map slot:** V-2 registers `{ kind: "map", label: "Map", icon: "view-map", Component: … }` with a placeholder. Find it with `grep -n 'kind: "map"' -A1 packages/trace-viewer/src/ui/views/registry.ts`; P-3 Step 12 points that entry at this lane's `MapView`.
- **Plan documents:** if `git -C /Users/jwpark/Projects/jevcode ls-files docs/superpowers` does not list this file, read it by absolute path and never commit plan files from this lane.
- **Setup** (once, index §5):

```bash
git -C /Users/jwpark/Projects/jevcode worktree add -b ce/06-viewer-map /Users/jwpark/Projects/jevcode-ce-06 <w0>
bash /Users/jwpark/Projects/jevcode/.superpowers/orchestration/setup-worktree.sh /Users/jwpark/Projects/jevcode-ce-06
```

Every later command runs from `/Users/jwpark/Projects/jevcode-ce-06`. If the shell does not keep the directory between calls, prefix each command with `cd /Users/jwpark/Projects/jevcode-ce-06 && `.

- **Baseline** (before P-1): the package suite in the background (`(perl -e 'alarm 590; exec @ARGV' pnpm --filter @jevcode/trace-viewer test > .superpowers/tv-suite.log 2>&1; echo "EXIT=$?" >> .superpowers/tv-suite.log) &`, then poll `tail -6 .superpowers/tv-suite.log` every 15 s until `EXIT=0` appears) exits 0; `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer typecheck` exits 0.

## Global Constraints

The index's Global Constraints apply in full (visual system, untrusted text, viewer purity, caps, budgets, commits, native modules, hang safety, zsh). Lane-specific additions:

- **No new dependency** and no `package.json` or `pnpm-lock.yaml` change in `packages/trace-viewer` or `apps/trace-viewer-dev`. React Flow (`@xyflow/*`) is never imported by the viewer (spec E13).
- **Purity:** `src/model/**` and `src/layout/**` stay React-free, DOM-free and clock-free. `src/layout/map-layout.ts` may cache per `OverviewModel` in a `WeakMap`; it never reads time or randomness.
- **DOM globals** in `src/ui/**` only through `element.ownerDocument` and `.defaultView`, with `typeof` guards (lessons-w2). No bare `window`, `document`, `ResizeObserver`, `requestAnimationFrame` or `performance`.
- **Focus** moves only after a user action (a pending-focus ref consumed once), never on a data rebuild or a new snapshot.
- **Untrusted text:** component names, root paths, file paths, language names, external package names, purposes and narrative sentences render through `displayUntrusted` (or `truncateMiddle`, which calls it) in every slot: card text, band labels, sentence links, tooltips (`title`) and accessible names. Narrator text (purposes, sentences) never fills a title, chip or badge slot; component names (from paths) may fill sentence links and labels.
- **Identity:** `finalize` never mutates a returned session; between calls with the same `live`, `session.overview` is the same object until a new snapshot row arrives, and an unchanged component is the same object across snapshots (viewer spec §6.4).
- **Budgets:** `layoutMap` fresh ≤ 8 ms and sticky ≤ 2 ms at 200 components and 1,000 edges (spec §11); a benchmark, not a CI gate. A miss is reported in the lane hand-off.
- **Commits:** one conventional commit per task listing its files in `git add`, as `git -c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com commit -m "…"`. No `Claude-Session:` and no `Co-Authored-By` trailers.

## Review Focus

The index assigns this lane three owning tests. Each lives in the task that owns the code.

1. **Review Focus 1 (UI part): an unsupported-language, huge or partial repo.** The Map shows its components with a quiet "Imports not analyzed for Python" note and no edges, or a "Partial map · 20,000 files mapped" note, and a 200-component, 1,000-edge partial snapshot renders every card. Tests: **P-3** `map-view.test.tsx` "a Python repo shows its components and a quiet imports-not-analyzed note, with no edges", "a partial map says so with its file count", "a 200-component partial snapshot renders every card".
2. **Review Focus 2 (render part): hostile narrator or repo text.** A purpose and a component name carrying U+202E, Markdown, a URL and an `<img onerror>` string render as visible plain text with `⟨U+202E⟩` tokens on the card (the name at every level, the purpose and packages on the detail level), in its tooltip and accessible name, in the overview narrative links and in the component Inspector; no `strong`, `em`, `a` or `img` element appears (narrative links are buttons). Tests: **P-3** `map-view.test.tsx` "Review Focus 2: hostile purpose, name and narrative render as plain text" and `map-card.test.tsx` "Review Focus 2: a hostile purpose, name and package render as plain text on the detail card".
3. **Review Focus 5 (Brief part): narrator off or offline.** With `narrative: null` the Brief's Architecture part renders from rule-based data (thumbnail, "3 components · 2 touched") with a quiet "Descriptions pending" note (or "Descriptions off" / "Descriptions unavailable" from `status.narrator`), no alert role and no error or Retry text; with no snapshot at all it keeps lane 02's quiet empty state, draws no thumbnail and raises no alert. Tests: **P-4** `architecture-card.test.tsx` "Review Focus 5: narrative null shows rule-based data and a quiet pending note", "Review Focus 5: narrator off or unavailable reads quietly" and "no snapshot: the quiet empty state, no thumbnail and no alert"; **P-3** `map-view.test.tsx` "Review Focus 5: the Map says the narrator is off, quietly".

## File structure

All paths are under `packages/trace-viewer/` unless a path starts with `apps/` or `docs/`.

| File | Responsibility | Task |
|---|---|---|
| `docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/map.html`, `brief-architecture.html`, `render-p0.sh`, `*.png`, `README.md` (P-0 section) | Mockups for gate H2 | P-0 |
| `src/model/types.ts` | `OverviewModel`; `TraceSession.overview` | P-1 |
| `src/model/fold-state.ts` | `FoldState.overview` (the latest parsed snapshot and its seq) | P-1 |
| `src/model/fold-overview.ts` | `foldOverviewSnapshot`, `sameComponent`, `COMPONENT_KEYS`, `overviewModelOf`, `buildOverviewModel` | P-1 |
| `src/model/component-path.ts`, `component-path.test.ts` | `componentIdForPath` (ruling R6) | P-1 |
| `src/model/overview-status.ts`, `overview-status.test.ts` | `overviewStatusOf` (ruling R3 default) | P-1 |
| `src/model/fold.ts`, `src/model/fold-finalize.ts`, `src/model/index.ts`, `src/model/registry.ts` (only if K-1 left it hidden) | Consume `overview_snapshot` rows; attach the model in `finalize`; export `buildOverviewModel` | P-1 |
| `src/test-support/overview-builder.ts`, `src/test-support/overview-arbitraries.ts` | Test-only snapshot builders, a synthetic generator, fast-check arbitraries | P-1 (P-2 adds the arbitraries) |
| `src/test-support/trace-builder.ts`, `row-arbitraries.ts`, `session-builder.ts`, `canvas-arbitraries.ts` | `TraceBuilder.overview`; overview rows in the random row sessions; `overview` in built sessions | P-1 |
| `src/model/fold-overview.test.ts`, `src/model/fold.incremental.test.ts` (appended block) | Fold, identity and incremental-equals-fresh tests | P-1 |
| `src/layout/map-layout.ts` | `layoutMap`, bands, barycenter order, stickiness, curve routing, `mapHubIds`, `componentForPath` | P-2 |
| `src/test-support/map-checks.ts` | Test-only overlap, port and crossing checks (curves sampled) shared by the property and fixture tests | P-2 |
| `src/layout/map-layout.test.ts`, `map-layout.property.test.ts`, `map-layout.bench.ts` | Unit, property and bench | P-2 |
| `src/layout/map-details.ts`, `map-details.test.ts` | Component Inspector data and the bar scales | P-3 |
| `src/ui/icons/icon-names.ts`, `paths.ts`, `kind-icons.ts`, `icons.test.tsx` | Role icons, `ROLE_ICON`, `ROLE_LABEL` | P-3 |
| `src/ui/state/view-state.ts`, `view-state.test.ts` | `mapSelection`, `map/select`, Esc | P-3 |
| `src/ui/views/map/MapView.tsx`, `MapCard.tsx`, `MapEdges.tsx`, `MapHeader.tsx`, `MapView.module.css` | The Map view | P-3 |
| `src/ui/views/map/map-camera.ts`, `map-nav.ts`, `map-text.ts`, `overlay.ts` | Fit and reveal, keyboard neighbors, header text and sentence links, lane 07 seam | P-3 |
| `src/ui/views/map/map-camera.test.ts`, `map-nav.test.ts`, `map-text.test.ts`, `map-card.test.tsx`, `map-view.test.tsx` | Tests (Review Focus 1 UI, Review Focus 2 render) | P-3 |
| `src/ui/inspector/ComponentInspector.tsx`, `ComponentInspector.module.css`, `component-inspector.test.tsx`, `Inspector.tsx` | Component Inspector and the Inspector switch | P-3 |
| `src/ui/views/registry.ts` | The `map` entry points at `MapView` | P-3 |
| `apps/trace-viewer-dev/src/overview-sample.ts`, `src/host.tsx`, `scripts/smoke.mjs` | `?overview=` and `?brief=1`; the `map`, `map-brief` and `map-rule` smoke screenshots | P-3 (P-4 and P-5 extend) |
| `src/layout/brief-architecture.ts`, `brief-architecture.test.ts`, `src/layout/brief.ts` | The Brief's architecture part | P-4 |
| `src/ui/inspector/MapThumbnail.tsx`, `MapThumbnail.module.css`, `architecture-card.test.tsx`; lane 02's `Brief.tsx` (`Architecture`) and `RightPanel.tsx` | The Brief's thumbnail, the Map branch of the right panel (Review Focus 5) | P-4 |
| `scripts/overview-fixture.mjs`, `fixtures/overview-jevcode.json`, `fixtures/overview-jevcode-rule.json` | This repo's snapshot fixture | P-5 |
| `src/test-support/overview-fixture.ts`, `src/ui/views/map/map-fixture.test.ts` | Fixture loader and the table test | P-5 |

Order: P-0 runs first and its gate H2 blocks P-3 and P-4 only. P-1 → P-2 run at W1 start without waiting for H2. P-3 needs P-2 and H2. P-4 needs P-1, H2 and lane 02b merged (rebase first). P-5 needs P-3 (and runs after P-4 when both are pending).

**Commands used by every task** (from `/Users/jwpark/Projects/jevcode-ce-06`):

- Targeted tests: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run <path relative to packages/trace-viewer>`.
- Package typecheck: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer typecheck` (covers tests, benches and `src/test-support`).
- Lint: `perl -e 'alarm 170; exec @ARGV' pnpm exec eslint packages/trace-viewer apps/trace-viewer-dev` (prints nothing when clean).
- Root checks (background, then poll the log): `bash /Users/jwpark/Projects/jevcode/.superpowers/orchestration/root-checks.sh /Users/jwpark/Projects/jevcode-ce-06`; the last line of `/Users/jwpark/Projects/jevcode-ce-06/.superpowers/root-checks.log` must read `ROOT_CHECKS_DONE fail=0`.
- If a storage or desktop test fails with `NODE_MODULE_VERSION`, run `pnpm --filter jevcode-desktop run rebuild:node` and restore node-pty's `build/Release/pty.node` and `spawn-helper` from `prebuilds/<platform>-<arch>/` (index Global Constraints).

---

### Task P-0: Mockups: Map and Brief architecture card (HUMAN H2)

**Files:**
- Create: `docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/map.html`, `brief-architecture.html`, `render-p0.sh`
- Create (rendered): `map-1440.png`, `map-1000.png`, `map-zoomed-1440.png`, `map-zoomed-1000.png`, `map-selected-1440.png`, `map-selected-1000.png`, `map-pending-1440.png`, `map-pending-1000.png`, `brief-architecture-1440.png`, `brief-architecture-1000.png` in the same folder
- Modify or create: `docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/README.md` (append the "Phase B" section only; lane 02's V-0 owns the rest of the file)

**Interfaces:**
- Consumes: the viewer's light tokens (`src/ui/tokens/tokens.ts` `LIGHT_TOKENS`), the Shell grid (`src/ui/shell/Shell.module.css`: 216 px Outline, 280 px Inspector, 200 px and 248 px under a 1180 px container), the icon family (`src/ui/icons/paths.ts`).
- Produces: the approved PNGs that P-3, P-4 and P-5 compare their screenshots with, and the numbers P-2 and P-3 encode (one geometry for every level: 140 × 76 cards, side band 104 wide, row gap 16, gutter 22, margin 16, band label 44, no package chips; smooth edges; zoom bands at 0.7 and 1.4; `MAP_ICON_ONLY_K = 0.48`; Fit padding 20, 20 and 68 px). A ruling at H2 that changes a number changes only these constants. The revised mockups (commit `20404f9` on `ce/mockups`, "revise the Map for fit, edges, names and mini graphics") are the reference; the HTML listing in Step 2 is the first draft and is superseded by that file.

The mockups draw what P-2 and P-3 build: role bands as columns (UI → API · IPC → Agents → Domain → Storage, then the side band), cards placed by the same constants, edges routed by the same rules (smooth curves through the gutters and the gap rows), Fit centered and filling the stage (the card level at 1440 px, the chip level at 1000 px), the detail level when zoomed, all of the selected card's edges in accent with the rest at 22%, the component Inspector, and the Brief with its architecture card. The data is this repository's curated component table (the one P-5's fixture uses).

- [ ] **Step 1: Read the visual references**

Read `/Users/jwpark/.claude/projects/-Users-jwpark-Projects-jevcode/memory/ui-visual-taste.md`, the viewer spec §7.12 (tokens, rules, type, icon family), and look at `docs/superpowers/specs/2026-09-28-trace-viewer-mockups/canvas-1440.png` (Read shows PNGs). The Map mockup must read as the same product: light, color for state only, one shadow for elevation, no decorative borders, icons and mini graphics over text, tabular numbers, 12 px minimum text at the default zoom of each state.

- [ ] **Step 2: Write `map.html`**

The listing below is the first draft of `map.html` (chip 220 × 48 cards, package chips, dot grid, orthogonal edges). The approved revision replaced it (commit `20404f9` on `ce/mockups`); P-2 and P-3 follow the revision, so read its `map.html` and `map-revision-report.md` rather than copying this listing.

Create `docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/map.html` (create the folder if V-0 has not):

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>Map mockup (P-0)</title>
<style>
:root{--canvas:#F4F5F7;--panel:#FFFFFF;--ink:#16181D;--ink-2:#5B616E;--ink-3:#676D78;--ink-4:#9AA0AB;
  --hair:rgb(16 24 40 / .07);--fill:rgb(16 24 40 / .04);--fill-2:rgb(16 24 40 / .07);
  --accent:#2F6BFF;--accent-soft:rgb(47 107 255 / .10);--accent-ink:#1F5EF0;--bad:#E5484D;--good:#2E9E6A;
  --shadow:0 1px 2px rgb(16 24 40 / .06),0 4px 12px rgb(16 24 40 / .05);
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;--mono:ui-monospace,"SF Mono",Menlo,monospace}
*{box-sizing:border-box;margin:0;padding:0}
body{padding:24px;background:#E9EBEF;color:var(--ink);font:400 13px/18px var(--sans);font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
button{font:inherit;color:inherit;background:none;border:0}
.ic{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.ic.s12{width:12px;height:12px}.ic.s14{width:14px;height:14px}
.frame{container-type:inline-size}
.app{display:grid;grid-template-columns:216px minmax(0,1fr) 280px;grid-template-rows:40px minmax(0,1fr);
  grid-template-areas:"title title title" "outline main inspector";height:900px;border-radius:12px;overflow:hidden;
  background:var(--panel);box-shadow:0 0 0 1px var(--hair),var(--shadow)}
@container (max-width:1179px){.app{grid-template-columns:200px minmax(0,1fr) 248px}}
.title{grid-area:title;display:flex;align-items:center;gap:16px;padding:0 12px 0 14px;box-shadow:inset 0 -1px 0 var(--hair);min-width:0}
.lights{display:flex;gap:8px}.lights i{width:12px;height:12px;border-radius:50%;background:var(--fill-2)}
.crumb{flex:1 1 auto;min-width:0;display:flex;gap:8px;white-space:nowrap;overflow:hidden}
.crumb .repo{color:var(--ink-3)}.crumb .t{font-weight:500;overflow:hidden;text-overflow:ellipsis}
.seg{display:flex;padding:2px;border-radius:8px;background:var(--fill)}
.seg span{display:flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:6px;font-size:12px;color:var(--ink-2)}
.seg .on{background:var(--panel);color:var(--ink);font-weight:500;box-shadow:var(--shadow)}
.meta{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--ink-2);white-space:nowrap}
.outline{grid-area:outline;box-shadow:inset -1px 0 0 var(--hair);padding:8px 0;overflow:hidden}
.orow{display:flex;align-items:center;gap:6px;height:28px;margin:0 8px;padding:0 8px;border-radius:6px;color:var(--ink-2);white-space:nowrap}
.orow .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}.orow .tm{font-size:12px;color:var(--ink-3)}
.orow.head{color:var(--ink);font-weight:600}
.main{grid-area:main;position:relative;display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--canvas);overflow:hidden}
.mhead{flex:none;padding:10px 16px 12px;background:var(--panel);box-shadow:inset 0 -1px 0 var(--hair)}
.hrow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-height:24px}
.hrow .hl{font-weight:600}
.note{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--ink-3)}
.tog{display:inline-flex;align-items:center;gap:4px;margin-left:auto;font-size:12px;color:var(--ink-2)}
.narr{margin-top:6px;max-width:78ch;color:var(--ink-2);font-size:13px;line-height:20px}
.cite{display:inline-flex;align-items:center;gap:3px;height:18px;padding:0 6px;margin:0 2px 0 4px;border-radius:9px;background:var(--fill-2);color:var(--ink-2);font-size:12px;vertical-align:1px}
.stage{position:relative;flex:1 1 auto;min-height:0}
.viewport{position:absolute;inset:0;overflow:hidden;background-color:var(--canvas);
  background-image:radial-gradient(circle,var(--ink-4) .6px,transparent 1.1px)}
.world{position:absolute;left:0;top:0;transform-origin:0 0}
.band{position:absolute;display:flex;align-items:center;gap:6px;color:var(--ink-3);font-weight:500;white-space:nowrap}
.band .n{color:var(--ink-3);font-weight:400}
.world[data-level="chip"] .band{font-size:22px;line-height:28px;gap:10px}.world[data-level="chip"] .band .ic{width:22px;height:22px}
.world[data-level="card"] .band{font-size:13px}
.edges{position:absolute;left:0;top:0;overflow:visible}
.edge{fill:none;stroke:var(--ink-4);stroke-linejoin:round;vector-effect:non-scaling-stroke}
.edge.lit{stroke:var(--accent)}.edge.dim{opacity:.3}
.card{position:absolute;display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:10px;background:var(--panel);box-shadow:var(--shadow);overflow:hidden}
.card.sel{box-shadow:0 0 0 2px var(--accent),var(--shadow)}
.ch{display:flex;align-items:center;gap:8px;min-width:0}
.tile{display:grid;place-items:center;flex:none;width:24px;height:24px;border-radius:6px;background:var(--fill-2);color:var(--ink-2)}
.card.sel .tile{background:var(--accent-soft);color:var(--accent)}
.cn{flex:1;min-width:0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pp{color:var(--ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pp.fb{font-family:var(--mono);font-size:12px;color:var(--ink-3)}
.cm{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--ink-3);white-space:nowrap}
.ib{display:inline-flex;align-items:center;gap:2px;margin-left:auto}
.ib i{display:block;height:8px;border-radius:1px}.ib .in{background:var(--ink-2)}.ib .out{box-shadow:inset 0 0 0 1.5px var(--ink-3)}
.world[data-level="chip"] .card{flex-direction:row;align-items:center;padding:0 12px;border-radius:12px}
.world[data-level="chip"] .tile{width:32px;height:32px;border-radius:8px}.world[data-level="chip"] .tile .ic{width:22px;height:22px}
.world[data-level="chip"] .cn{font-size:22px;line-height:28px;font-weight:500}
.viewport[data-zoom-band="icon"] .cn,.viewport[data-zoom-band="icon"] .band .t{visibility:hidden}
.ext{position:absolute;display:flex;align-items:center;gap:4px;height:18px;padding:0 6px;border-radius:9px;background:var(--fill-2);color:var(--ink-2);font-size:12px;line-height:18px;white-space:nowrap;overflow:hidden}
.ext .ic{width:12px;height:12px;flex:none}
.ext span{overflow:hidden;text-overflow:ellipsis}
.tools{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);display:flex;align-items:center;gap:2px;padding:4px;border-radius:10px;background:var(--panel);box-shadow:var(--shadow);font-size:12px;color:var(--ink-2)}
.tools span{display:flex;align-items:center;gap:6px;height:28px;padding:0 8px;border-radius:6px}.tools .on{background:var(--fill-2);color:var(--ink)}
.insp{grid-area:inspector;display:flex;flex-direction:column;min-width:0;box-shadow:inset 1px 0 0 var(--hair);overflow:hidden}
.ih{display:flex;gap:10px;padding:14px 16px 10px}
.ih .tile{width:32px;height:32px;border-radius:8px}
.ih h2{font-size:15px;line-height:20px;font-weight:600}
.ml{display:flex;gap:4px;font-size:12px;color:var(--ink-3)}
.ib2{flex:1;min-height:0;overflow:hidden;padding:0 16px 16px}
.sec{padding:10px 0;box-shadow:inset 0 -1px 0 var(--hair)}
.sec:last-child{box-shadow:none}
.sh{display:flex;align-items:center;gap:6px;margin-bottom:6px;font-size:12px;font-weight:600;color:var(--ink-2)}
.sh .d{font-weight:400;color:var(--ink-3)}
.quiet{color:var(--ink-3);font-size:12px}
.mono{font-family:var(--mono);font-size:12px;line-height:18px;color:var(--ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lrow{display:flex;align-items:center;gap:6px;height:24px;font-size:12px;color:var(--ink-2)}
.lrow .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink)}
.lrow .ct{color:var(--ink-3)}
.ex{margin:-2px 0 4px 18px}
.bar{display:inline-flex;gap:2px;align-items:center}.bar i{display:block;height:8px;border-radius:1px}
.bar .a{background:var(--ink-2)}.bar .r{box-shadow:inset 0 0 0 1.5px var(--ink-3)}
.dots{display:inline-flex;gap:2px}.dots i{width:5px;height:5px;border-radius:50%;background:var(--good)}.dots i.f{width:7px;height:7px;background:var(--bad)}
.now{display:flex;gap:8px;align-items:flex-start;font-size:13px;color:var(--ink)}
.pulse{width:8px;height:8px;margin-top:5px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.arch{display:block;width:100%;margin-top:2px;padding:8px;border-radius:10px;background:var(--canvas);text-align:left}
.arch svg{display:block;width:100%;height:112px}
.am{display:flex;justify-content:space-between;margin-top:6px;font-size:12px;color:var(--ink-3)}
.lnk{display:block;margin-top:6px;padding:0;color:var(--accent-ink);font-size:12px}
.prose{margin-top:8px;color:var(--ink-2);font-size:12px;line-height:18px;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.th rect{fill:var(--fill-2)}.th rect.t{fill:var(--accent-soft);stroke:var(--accent);stroke-width:6}
.th path{fill:none;stroke:var(--ink-4);stroke-width:4;opacity:.6}
</style>
</head>
<body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <defs>
    <symbol id="i-role-ui" viewBox="0 0 16 16"><path d="M3 2.75h10a1.25 1.25 0 0 1 1.25 1.25v8a1.25 1.25 0 0 1-1.25 1.25H3A1.25 1.25 0 0 1 1.75 12V4A1.25 1.25 0 0 1 3 2.75z"/><path d="M1.75 5.75h12.5M4.5 8.75h4M4.5 11h2.5"/></symbol>
    <symbol id="i-role-api" viewBox="0 0 16 16"><path d="M2.5 5.5h9M9 3l2.5 2.5L9 8M13.5 10.5h-9M7 8l-2.5 2.5L7 13"/></symbol>
    <symbol id="i-role-agent" viewBox="0 0 16 16"><path d="M5 4.75h6a.75.75 0 0 1 .75.75v5a.75.75 0 0 1-.75.75H5a.75.75 0 0 1-.75-.75v-5A.75.75 0 0 1 5 4.75z"/><path d="M6.5 2.25v2.5M9.5 2.25v2.5M6.5 11.25v2.5M9.5 11.25v2.5M1.75 6.5h2.5M1.75 9.5h2.5M11.75 6.5h2.5M11.75 9.5h2.5"/></symbol>
    <symbol id="i-role-domain" viewBox="0 0 16 16"><path d="M8 1.75l5.25 3v6.5L8 14.25l-5.25-3v-6.5z"/><path d="M6 8a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/></symbol>
    <symbol id="i-role-storage" viewBox="0 0 16 16"><path d="M2.75 4.25c0-1.1 2.35-2 5.25-2s5.25.9 5.25 2-2.35 2-5.25 2-5.25-.9-5.25-2z"/><path d="M2.75 4.25v7.5c0 1.1 2.35 2 5.25 2s5.25-.9 5.25-2v-7.5M2.75 8c0 1.1 2.35 2 5.25 2s5.25-.9 5.25-2"/></symbol>
    <symbol id="i-role-tooling" viewBox="0 0 16 16"><path d="M10.1 2.35a3.25 3.25 0 0 0-3.85 4.4L2.6 10.4a1.4 1.4 0 0 0 2 2l3.65-3.65a3.25 3.25 0 0 0 4.4-3.85l-1.9 1.9-1.75-.35-.35-1.75z"/></symbol>
    <symbol id="i-role-config" viewBox="0 0 16 16"><path d="M2.75 4.75h10.5M2.75 11.25h10.5"/><path d="M4.5 4.75a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0M8.5 11.25a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0"/></symbol>
    <symbol id="i-test" viewBox="0 0 16 16"><path d="M5.75 2.25h4.5M6.75 2.25v4.1L3.3 12.1a1.1 1.1 0 0 0 .95 1.65h7.5a1.1 1.1 0 0 0 .95-1.65L9.25 6.35v-4.1M4.9 9.75h6.2"/></symbol>
    <symbol id="i-pkg" viewBox="0 0 16 16"><path d="M8 1.75l5.5 3v6.5L8 14.25l-5.5-3v-6.5z"/><path d="M2.5 4.75 8 7.75l5.5-3M8 7.75v6.5M5.25 3.25l5.5 3"/></symbol>
    <symbol id="i-stack" viewBox="0 0 16 16"><path d="M8 2.25 13.75 5 8 7.75 2.25 5z"/><path d="M2.25 8 8 10.75 13.75 8M2.25 11 8 13.75 13.75 11"/></symbol>
    <symbol id="i-view-map" viewBox="0 0 16 16"><path d="M2 4l4-1.75 4 1.75 4-1.75v9.75l-4 1.75-4-1.75-4 1.75z"/><path d="M6 2.25v9.75M10 4v9.75"/></symbol>
    <symbol id="i-view-console" viewBox="0 0 16 16"><path d="M3 2.75h10a1.25 1.25 0 0 1 1.25 1.25v8a1.25 1.25 0 0 1-1.25 1.25H3A1.25 1.25 0 0 1 1.75 12V4A1.25 1.25 0 0 1 3 2.75z"/><path d="M4.75 6.25 6.5 8l-1.75 1.75M8.25 10h3"/></symbol>
    <symbol id="i-view-canvas" viewBox="0 0 16 16"><path d="M2.75 3.25h4.5v4h-4.5zM8.75 8.75h4.5v4h-4.5z"/><path d="M7.25 5.25h1.5a1.25 1.25 0 0 1 1.25 1.25v2.25"/></symbol>
    <symbol id="i-view-hybrid" viewBox="0 0 16 16"><path d="M2.25 3.25h11.5M2.25 6h11.5M2.25 9.5h3M7.25 9.5h6.5M2.25 12.5h3M7.25 12.5h6.5"/></symbol>
    <symbol id="i-edit" viewBox="0 0 16 16"><path d="M7.75 13.25H4.5A1.5 1.5 0 0 1 3 11.75v-8a1.5 1.5 0 0 1 1.5-1.5h4l3 3v1.5"/><path d="M12.4 8.1l1.5 1.5-4.4 4.4H8v-1.5z"/></symbol>
    <symbol id="i-file" viewBox="0 0 16 16"><path d="M4.5 1.75h4.75l3.25 3.25v8.5a.75.75 0 0 1-.75.75H4.5a.75.75 0 0 1-.75-.75v-11a.75.75 0 0 1 .75-.75z"/><path d="M9.25 1.75V5h3.25"/></symbol>
    <symbol id="i-clock" viewBox="0 0 16 16"><path d="M2 8a6 6 0 1 0 12 0a6 6 0 1 0 -12 0"/><path d="M8 4.75V8l2.25 1.5"/></symbol>
    <symbol id="i-chev-d" viewBox="0 0 16 16"><path d="M4.75 6.5 8 9.75l3.25-3.25"/></symbol>
    <symbol id="i-list" viewBox="0 0 16 16"><path d="M6.5 4.25h7M6.5 8h7M6.5 11.75h7"/></symbol>
    <symbol id="i-fit" viewBox="0 0 16 16"><path d="M2.75 6V3.5a.75.75 0 0 1 .75-.75H6M10 2.75h2.5a.75.75 0 0 1 .75.75V6M13.25 10v2.5a.75.75 0 0 1-.75.75H10M6 13.25H3.5a.75.75 0 0 1-.75-.75V10"/></symbol>
    <symbol id="i-hand" viewBox="0 0 16 16"><path d="M5.25 8.5V4a1 1 0 0 1 2 0v3.5M7.25 7V2.75a1 1 0 0 1 2 0V7.5M9.25 7.25V4a1 1 0 0 1 2 0v5a4.75 4.75 0 0 1-4.75 4.75h-.4a3.8 3.8 0 0 1-3.05-1.55L1.9 10.4a1 1 0 0 1 1.45-1.35l1.9 1.45"/></symbol>
    <symbol id="i-cursor" viewBox="0 0 16 16"><path d="M3.25 2.75 12.75 7l-4.1 1.35-1.4 4.4z"/></symbol>
  </defs>
</svg>
<div class="frame"><div class="app">
  <header class="title">
    <div class="lights"><i></i><i></i><i></i></div>
    <div class="crumb"><span class="repo">jevcode</span><span class="t">Add the codebase Map to the trace viewer</span></div>
    <div class="seg">
      <span><svg class="ic s14"><use href="#i-view-console"/></svg>Console</span>
      <span><svg class="ic s14"><use href="#i-view-canvas"/></svg>Canvas</span>
      <span><svg class="ic s14"><use href="#i-view-hybrid"/></svg>Hybrid</span>
      <span class="on"><svg class="ic s14"><use href="#i-view-map"/></svg>Map</span>
    </div>
    <div class="meta"><svg class="ic s12"><use href="#i-clock"/></svg>12 m 04 s · Running</div>
  </header>
  <nav class="outline">
    <div class="orow head"><span class="nm">Session</span><span class="tm">41 steps</span></div>
    <div class="orow"><svg class="ic s14"><use href="#i-edit"/></svg><span class="nm">Map layout</span><span class="tm">+3:12</span></div>
    <div class="orow"><svg class="ic s14"><use href="#i-edit"/></svg><span class="nm">Overview fold</span><span class="tm">+6:40</span></div>
    <div class="orow"><svg class="ic s14"><use href="#i-test"/></svg><span class="nm">Layout properties</span><span class="tm">+9:05</span></div>
    <div class="orow"><svg class="ic s14"><use href="#i-edit"/></svg><span class="nm">Explainer stage</span><span class="tm">+11:30</span></div>
  </nav>
  <main class="main">
    <div class="mhead" id="mhead"></div>
    <div class="stage">
      <div class="viewport" id="viewport"><div class="world" id="world"></div></div>
      <div class="tools"><span class="on"><svg class="ic s14"><use href="#i-cursor"/></svg></span><span><svg class="ic s14"><use href="#i-hand"/></svg></span><span><svg class="ic s14"><use href="#i-fit"/></svg>Fit</span><span id="zoom">49%</span></div>
    </div>
  </main>
  <aside class="insp" id="insp"></aside>
</div></div>
<script>
const STATE = new URLSearchParams(location.search).get("state") ?? "default";
const PENDING = STATE === "pending";
const LV = { chip: { w: 220, h: 48, rowGap: 20, gutter: 40, side: 64, chips: 0 }, card: { w: 224, h: 84, rowGap: 40, gutter: 72, side: 112, chips: 2 } };
const MARGIN = 48, LABEL = 32, ICON_ONLY = 0.375, CHIP = { w: 108, h: 18, gap: 4, top: 4 };
const BANDS = [["ui", "UI", "role-ui"], ["api", "API · IPC", "role-api"], ["agent", "Agents", "role-agent"], ["domain", "Domain", "role-domain"], ["storage", "Storage", "role-storage"], ["side", "Tests · tooling · config", "stack"]];
const ROLE_ICON = { ui: "role-ui", api: "role-api", agent: "role-agent", domain: "role-domain", storage: "role-storage", tests: "test", tooling: "role-tooling", config: "role-config" };
const C = (key, name, role, purpose, files, lang, ext = []) => ({ key, name, role, purpose, files, lang, ext });
const COMPONENTS = [
  C("renderer", "desktop renderer", "ui", "Main window: workspace, composer, surfaces and the embedded viewer.", 25, "TypeScript", ["react", "@xterm/xterm"]),
  C("tvdev", "trace-viewer-dev", "ui", "Dev host that loads trace bundles for smoke tests.", 24, "TypeScript", ["react"]),
  C("tvui", "trace-viewer ui", "ui", "Viewer views, Inspector, shell and keyboard layer.", 133, "TypeScript", ["react", "d3-zoom", "@tanstack/react-virtual"]),
  C("catalog", "ui-catalog", "ui", "Generative UI components rendered from json-render specs.", 36, "TypeScript", ["@xyflow/react", "diff2html"]),
  C("compiler", "ui-compiler", "ui", "Compiles surface decisions into json-render specs.", 10, "TypeScript"),
  C("main", "desktop main", "api", "Electron main process: IPC handlers, sessions and the event pipeline.", 61, "TypeScript", ["electron", "node-pty", "chokidar"]),
  C("shell", "desktop shell", "api", "Preload bridge, shared IPC types and the app build config.", 25, "TypeScript"),
  C("codex", "agent-codex", "agent", "Runs Codex as a child process and normalizes its JSON events.", 22, "TypeScript", ["node-pty"]),
  C("core", "agent-core", "agent", "Adapter interface and session lifecycle shared by agents.", 15, "TypeScript"),
  C("router", "jev-router", "agent", "Routes Jev questions to the model with typed guardrails.", 30, "TypeScript", ["@typesafe-ai/sdk"]),
  C("semantic", "semantic-core", "domain", "Groups evidence into change units, decisions and validations.", 23, "TypeScript"),
  C("evidence", "evidence-engine", "domain", "Watches the repo and parses files into evidence facts.", 37, "TypeScript", ["web-tree-sitter", "chokidar"]),
  C("contracts", "contracts", "domain", "Zod schemas for events, IPC and trace bundles.", 34, "TypeScript", ["zod"]),
  C("model", "trace-viewer model", "domain", "Folds trace rows into turns, steps, chapters and findings.", 38, "TypeScript"),
  C("layout", "trace-viewer layout", "domain", "Pure layouts for the Canvas, Hybrid spine and overview.", 37, "TypeScript"),
  C("tv", "trace-viewer", "domain", "Package entry, sources and test support for the viewer.", 28, "TypeScript"),
  C("telemetry", "telemetry", "domain", "Local timing and count metrics for the pipeline.", 11, "TypeScript", ["zod"]),
  C("storage", "storage", "storage", "SQLite event store, migrations and the trace reader.", 17, "TypeScript", ["better-sqlite3"]),
  C("evals", "evals", "tests", "Scenario playback and metrics for Jev decision quality.", 19, "TypeScript"),
  C("scripts", "scripts", "tooling", "Repository verification scripts.", 5, "JavaScript"),
  C("config", "config", "config", "Workspace, TypeScript, ESLint and editor configuration.", 8, "JSON"),
];
const ORDER = { ui: ["renderer", "tvdev", "tvui", "catalog", "compiler"], api: ["main", "shell"], agent: ["codex", "core", "router"],
  domain: ["semantic", "evidence", "contracts", "model", "layout", "tv", "telemetry"], storage: ["storage"], side: ["evals", "scripts", "config"] };
if (PENDING) { COMPONENTS.push(C("py", "py-tools", "tooling", null, 14, "Python")); ORDER.side.push("py"); for (const c of COMPONENTS) c.purpose = null; }
const EDGES = [["renderer", "tvui", 12], ["renderer", "catalog", 9], ["renderer", "shell", 6], ["renderer", "contracts", 14], ["tvdev", "tvui", 4],
  ["tvui", "layout", 40], ["tvui", "model", 38], ["tvui", "contracts", 6], ["catalog", "contracts", 5], ["compiler", "catalog", 3],
  ["main", "codex", 5], ["main", "core", 3], ["main", "router", 5], ["main", "semantic", 6], ["main", "evidence", 4], ["main", "contracts", 22],
  ["main", "storage", 9], ["main", "telemetry", 3], ["shell", "contracts", 8], ["codex", "core", 4], ["codex", "contracts", 6], ["core", "contracts", 3],
  ["router", "contracts", 7], ["router", "evidence", 2], ["semantic", "contracts", 9], ["evidence", "contracts", 5], ["model", "contracts", 11],
  ["layout", "model", 30], ["tv", "model", 6], ["storage", "contracts", 8], ["evals", "router", 3], ["evals", "contracts", 4]];
const TOUCHED = new Set(["tvui", "layout", "model", "main"]);
const byKey = new Map(COMPONENTS.map((c) => [c.key, c]));
const bandOf = (role) => (role === "tests" || role === "tooling" || role === "config" ? "side" : role);
const width = (n) => (n > 0 ? Math.min(56, Math.max(2, 8 * Math.log2(1 + n))) : 0);

function layout(levelName) {
  const s = LV[levelName];
  const pitch = s.h + s.rowGap, top = MARGIN + LABEL;
  const cols = [], cards = new Map();
  let x = MARGIN;
  for (const [band] of BANDS) {
    const ids = ORDER[band];
    if (ids.length === 0) continue;
    if (cols.length > 0) x += band === "side" ? s.side : s.gutter;
    cols.push({ band, x });
    ids.forEach((id, row) => cards.set(id, { id, band, col: cols.length - 1, row, x, y: top + row * pitch, w: s.w, h: s.h }));
    x += s.w;
  }
  const rows = Math.max(...Object.values(ORDER).map((l) => l.length));
  const gutterX = (g, lane) => {
    const left = g === 0 ? 0 : cols[g - 1].x + s.w, right = cols[g].x, half = Math.max(0, (right - left) / 2 - 8);
    const steps = Math.floor(half / 4), slots = 2 * steps + 1, i = lane % slots;
    return (left + right) / 2 + (i === 0 ? 0 : (i % 2 === 1 ? -1 : 1) * Math.ceil(i / 2) * 4);
  };
  const laneTop = s.chips > 0 ? CHIP.top + CHIP.h + 4 : 4, laneCount = Math.floor((s.rowGap - 2 - laneTop) / 4) + 1;
  const gapY = (row, lane) => top + row * pitch + s.h + laneTop + (lane % laneCount) * 4;
  const gutterUse = new Map(), gapUse = new Map(), take = (m, k) => { const n = m.get(k) ?? 0; m.set(k, n + 1); return n; };
  const ports = new Map(), portKey = (id, side) => `${id}|${side}`;
  const routes = EDGES.filter(([a, b]) => cards.has(a) && cards.has(b)).map(([a, b, count]) => {
    const A = cards.get(a), B = cards.get(b), d = B.col - A.col;
    const r = { a: A, b: B, count, key: `${a}>${b}`, kind: d === 0 ? "same" : Math.abs(d) === 1 ? "adjacent" : "long",
      aSide: d > 0 ? "R" : "L", bSide: d === 0 ? "L" : d > 0 ? "L" : "R",
      g1: d === 0 ? A.col : Math.abs(d) === 1 ? (d > 0 ? B.col : A.col) : d > 0 ? A.col + 1 : A.col, g2: d > 0 ? B.col : B.col + 1 };
    for (const [id, side, other] of [[a, r.aSide, B], [b, r.bSide, A]]) {
      const k = portKey(id, side); if (!ports.has(k)) ports.set(k, []); ports.get(k).push({ key: r.key, y: other.y });
    }
    return r;
  }).sort((p, q) => (p.key < q.key ? -1 : 1));
  const offset = new Map();
  for (const [k, list] of ports) {
    list.sort((p, q) => p.y - q.y || (p.key < q.key ? -1 : 1));
    list.forEach((p, i) => offset.set(`${k}|${p.key}`, Math.max(-(s.h / 2 - 6), Math.min(s.h / 2 - 6, (i - (list.length - 1) / 2) * 4))));
  }
  const edges = routes.map((r) => {
    const ax = r.aSide === "R" ? r.a.x + s.w : r.a.x, bx = r.bSide === "R" ? r.b.x + s.w : r.b.x;
    const ay = r.a.y + s.h / 2 + offset.get(`${portKey(r.a.id, r.aSide)}|${r.key}`), by = r.b.y + s.h / 2 + offset.get(`${portKey(r.b.id, r.bSide)}|${r.key}`);
    let d;
    if (r.kind === "same") d = `M${ax} ${ay}H${gutterX(r.g1, take(gutterUse, r.g1))}V${by}H${bx}`;
    else if (r.kind === "adjacent") d = ay === by ? `M${ax} ${ay}H${bx}` : `M${ax} ${ay}H${gutterX(r.g1, take(gutterUse, r.g1))}L${bx} ${by}`;
    else d = `M${ax} ${ay}H${gutterX(r.g1, take(gutterUse, r.g1))}V${gapY(r.a.row, take(gapUse, r.a.row))}H${gutterX(r.g2, take(gutterUse, r.g2))}V${by}H${bx}`;
    return { ...r, d, w: r.count <= 3 ? 1 : r.count <= 15 ? 2 : 3 };
  });
  return { s, cols, cards, edges, bounds: { w: cols.at(-1).x + s.w + MARGIN, h: top + rows * pitch + MARGIN } };
}
const icon = (name, cls = "ic") => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
const totals = new Map();
for (const [a, b, n] of EDGES) { totals.set(a, { in: (totals.get(a)?.in ?? 0), out: (totals.get(a)?.out ?? 0) + n }); totals.set(b, { in: (totals.get(b)?.in ?? 0) + n, out: totals.get(b)?.out ?? 0 }); }

function renderWorld(levelName, selected) {
  const L = layout(levelName), s = L.s, world = document.getElementById("world");
  world.dataset.level = levelName;
  world.style.width = `${L.bounds.w}px`; world.style.height = `${L.bounds.h}px`;
  const lit = (e) => selected !== null && (e.a.id === selected || e.b.id === selected);
  let html = L.cols.map((c) => { const [, label, ic] = BANDS.find(([b]) => b === c.band);
    return `<div class="band" style="left:${c.x}px;top:${MARGIN}px;width:${s.w}px">${icon(ic)}<span class="t">${label}</span><span class="n">${ORDER[c.band].length}</span></div>`; }).join("");
  html += `<svg class="edges" width="${L.bounds.w}" height="${L.bounds.h}">${L.edges.map((e) => `<path class="edge${lit(e) ? " lit" : selected !== null ? " dim" : ""}" stroke-width="${e.w}" d="${e.d}"/>`).join("")}</svg>`;
  for (const card of L.cards.values()) {
    const c = byKey.get(card.id), t = totals.get(card.id), sel = card.id === selected;
    const body = levelName === "chip" ? "" : `<div class="pp${c.purpose === null ? " fb" : ""}">${c.purpose ?? (c.key === "py" ? "tools/py" : `packages/${c.name}`)}</div>
      <div class="cm"><span>${c.files} files · ${c.lang}</span>${c.key === "py" || t === undefined ? "" : `<span class="ib"><i class="in" style="width:${width(t.in)}px"></i><i class="out" style="width:${width(t.out)}px"></i></span>`}</div>`;
    html += `<div class="card${sel ? " sel" : ""}" style="left:${card.x}px;top:${card.y}px;width:${s.w}px;height:${s.h}px"><div class="ch"><span class="tile">${icon(ROLE_ICON[c.role], "ic s14")}</span><span class="cn">${c.name}</span></div>${body}</div>`;
    if (s.chips > 0) c.ext.slice(0, s.chips).forEach((name, i) => {
      html += `<span class="ext" style="left:${card.x + i * (CHIP.w + CHIP.gap)}px;top:${card.y + s.h + CHIP.top}px;width:${CHIP.w}px">${icon("pkg")}<span>${name}</span></span>`;
    });
  }
  world.innerHTML = html;
  return L;
}

function camera(L, mode) {
  const vp = document.getElementById("viewport"), vw = vp.clientWidth, vh = vp.clientHeight;
  let k, tx, ty;
  if (mode === "fit") {
    k = Math.min(0.49, (vw - 96) / L.bounds.w, (vh - 96) / L.bounds.h);
    tx = (vw - L.bounds.w * k) / 2; ty = 24;
  } else {
    const focus = L.cards.get(mode); k = 0.92;
    tx = vw / 2 - (focus.x + focus.w / 2) * k; ty = 24 - (MARGIN - 8) * k;
  }
  document.getElementById("world").style.transform = `translate(${tx}px,${ty}px) scale(${k})`;
  const cell = 20 * k * (k < 0.5 ? 2 : 1);
  vp.style.backgroundSize = `${cell}px ${cell}px`; vp.style.backgroundPosition = `${tx}px ${ty}px`;
  vp.dataset.zoomBand = k < ICON_ONLY ? "icon" : "full";
  document.getElementById("zoom").textContent = `${Math.round(k * 100)}%`;
}

const SENTENCES = [
  ["jevcode is an Electron app that supervises a coding agent and explains its work.", ["main", "renderer"]],
  ["The main process runs Codex through agent-codex and feeds its events through evidence-engine and semantic-core.", ["main", "codex", "semantic"]],
  ["Every event lands in the SQLite store, and the trace viewer reads it back as rows.", ["storage", "model"]],
  ["Jev's questions go through jev-router with schema-checked answers.", ["router"]],
  ["contracts holds the shared schemas that every package imports.", ["contracts"]],
];
const chip = (key) => `<span class="cite">${icon(ROLE_ICON[byKey.get(key).role], "ic s12")}${byKey.get(key).name}</span>`;
document.getElementById("mhead").innerHTML = PENDING
  ? `<div class="hrow">${icon("view-map")}<span class="hl">22 components · TypeScript, JSON, Python</span>
     <span class="note">${icon("stack", "ic s12")}Partial map · 20,000 files mapped</span>
     <span class="note">Imports not analyzed for Python</span><span class="note">Descriptions pending</span></div>`
  : `<div class="hrow">${icon("view-map")}<span class="hl">21 components · TypeScript, JSON</span><button class="tog">${icon("chev-d", "ic s12")}Overview</button></div>
     <p class="narr">${SENTENCES.map(([t, keys]) => `${t}${keys.map(chip).join("")}`).join(" ")}</p>`;

const thumb = () => {
  const L = layout("chip");
  return `<svg class="th" viewBox="0 0 ${L.bounds.w} ${L.bounds.h}" preserveAspectRatio="xMidYMid meet">${L.edges.map((e) => `<path d="${e.d}"/>`).join("")}${[...L.cards.values()].map((c) => `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="12"${TOUCHED.has(c.id) ? ' class="t"' : ""}/>`).join("")}</svg>`;
};
const brief = () => `<div class="ih"><span class="tile">${icon("list")}</span><div><h2>Brief</h2><p class="ml">${icon("clock", "ic s12")}12 m 04 s · Running</p></div></div>
  <div class="ib2">
    <div class="sec"><div class="sh">Now</div><div class="now"><span class="pulse"></span><span>Editing <span class="mono">src/layout/map-layout.ts</span></span></div></div>
    <div class="sec"><div class="sh">Changes so far</div>
      <div class="lrow">${icon("edit", "ic s14")}<span class="nm">Map layout</span><span class="bar"><i class="a" style="width:40px"></i><i class="r" style="width:10px"></i></span></div>
      <div class="lrow">${icon("edit", "ic s14")}<span class="nm">Overview fold</span><span class="bar"><i class="a" style="width:30px"></i><i class="r" style="width:6px"></i></span></div>
      <div class="lrow">${icon("test", "ic s14")}<span class="nm">Layout properties</span><span class="dots"><i></i><i></i><i></i><i></i><i></i><i></i><i class="f"></i></span></div></div>
    <div class="sec"><div class="sh">${icon("view-map", "ic s12")}Architecture</div>
      <div class="arch">${thumb()}</div>
      <p class="am">${PENDING ? 22 : 21} components · 4 touched</p>
      ${PENDING ? `<p class="quiet" style="margin-top:6px">Descriptions pending</p>` : `<p class="prose">${SENTENCES.map(([t]) => t).join(" ")}</p>`}
      <button class="lnk">Open the map</button></div>
  </div>`;
const inspector = () => `<div class="ih"><span class="tile" style="background:var(--accent-soft);color:var(--accent)">${icon("role-api")}</span><div><h2>desktop main</h2><p class="ml">API · described by model</p></div></div>
  <div class="ib2">
    <div class="sec"><p>Electron main process: IPC handlers, sessions and the event pipeline.</p><p class="mono" style="margin-top:4px">apps/desktop/src/main</p></div>
    <div class="sec"><div class="sh">${icon("file", "ic s12")}Files · 61 <span class="d">TypeScript</span></div>
      ${["main/index.ts", "main/ipc.ts", "main/pipeline/coordinator.ts", "main/pipeline/explainer-stage.ts", "main/sessions.ts"].map((f) => `<div class="mono">apps/desktop/src/${f}</div>`).join("")}<p class="quiet">56 more</p></div>
    <div class="sec"><div class="sh">Imports out</div>
      ${[["contracts", "domain", 22, "main/ipc.ts → contracts/src/index.ts"], ["storage", "storage", 9, null], ["semantic-core", "domain", 6, null], ["jev-router", "agent", 5, null]].map(([n, r, c, ex]) => `<div class="lrow">${icon(ROLE_ICON[r], "ic s12")}<span class="nm">${n}</span><span class="ct">${c}</span></div>${ex ? `<div class="mono ex">${ex}</div>` : ""}`).join("")}
      <div class="sh" style="margin-top:6px">Imports in</div><div class="lrow">${icon("role-api", "ic s12")}<span class="nm">desktop shell</span><span class="ct">3</span></div></div>
    <div class="sec"><div class="sh">${icon("pkg", "ic s12")}External packages</div><div class="lrow"><span class="nm">electron</span><span class="ct">14</span></div><div class="lrow"><span class="nm">node-pty</span><span class="ct">3</span></div></div>
    <div class="sec"><div class="sh">This session</div><div class="lrow">${icon("edit", "ic s12")}<span class="nm mono">…/pipeline/explainer-stage.ts</span><span class="bar"><i class="a" style="width:48px"></i><i class="r" style="width:9px"></i></span></div></div>
  </div>`;
document.getElementById("insp").innerHTML = STATE === "selected" ? inspector() : brief();
const level = STATE === "zoomed" || STATE === "selected" ? "card" : "chip";
const L = renderWorld(level, STATE === "selected" ? "main" : null);
camera(L, level === "chip" ? "fit" : "main");
</script>
</body>
</html>
```

The states (revised): `default` (Fit centered, card level at 1440 px, chip level at 1000 px, Brief with narrative), `zoomed` (detail level at 150%, packages inside the cards, Brief), `selected` (`desktop main` selected, all of its edges accent and the rest at 22%, component Inspector), `pending` (Fit, rule-based header with the partial, imports-not-analyzed and descriptions-pending notes, a Python component, rule-based fallbacks, the Brief card's pending note).

- [ ] **Step 3: Write `brief-architecture.html`**

Create `docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/brief-architecture.html`. It shows the architecture card alone at the Inspector's two widths (280 px and 248 px) in three states: narrator text with touched components, narrator pending, and a fresh session with nothing touched.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>Brief architecture card (P-0)</title>
<style>
:root{--canvas:#F4F5F7;--panel:#FFFFFF;--ink:#16181D;--ink-2:#5B616E;--ink-3:#676D78;--ink-4:#9AA0AB;--hair:rgb(16 24 40 / .07);
  --fill-2:rgb(16 24 40 / .07);--accent:#2F6BFF;--accent-soft:rgb(47 107 255 / .10);--accent-ink:#1F5EF0;
  --shadow:0 1px 2px rgb(16 24 40 / .06),0 4px 12px rgb(16 24 40 / .05);--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
*{box-sizing:border-box;margin:0;padding:0}
body{padding:24px;background:#E9EBEF;color:var(--ink);font:400 13px/18px var(--sans);font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
button{font:inherit;color:inherit;background:none;border:0}
.ic{width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.row{display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start}
h1{margin:0 0 4px;font-size:12px;font-weight:500;color:var(--ink-3)}
.panel{padding:12px 16px 16px;border-radius:12px;background:var(--panel);box-shadow:0 0 0 1px var(--hair),var(--shadow)}
.w280{width:280px}.w248{width:248px}
.sh{display:flex;align-items:center;gap:6px;margin-bottom:6px;font-size:12px;font-weight:600;color:var(--ink-2)}
.arch{display:block;width:100%;padding:8px;border-radius:10px;background:var(--canvas);text-align:left}
.arch svg{display:block;width:100%;height:112px}
.am{display:flex;justify-content:space-between;gap:8px;margin-top:6px;font-size:12px;color:var(--ink-3)}
.lnk{display:block;margin-top:6px;padding:0;color:var(--accent-ink);font-size:12px}
.prose{margin-top:8px;color:var(--ink-2);font-size:12px;line-height:18px;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.quiet{margin-top:8px;font-size:12px;color:var(--ink-3)}
.th rect{fill:var(--fill-2)}.th rect.t{fill:var(--accent-soft);stroke:var(--accent);stroke-width:6}
</style>
</head>
<body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <symbol id="i-view-map" viewBox="0 0 16 16"><path d="M2 4l4-1.75 4 1.75 4-1.75v9.75l-4 1.75-4-1.75-4 1.75z"/><path d="M6 2.25v9.75M10 4v9.75"/></symbol>
</defs></svg>
<div class="row" id="row"></div>
<script>
const COUNTS = [5, 2, 3, 7, 1, 3];
const W = 220, H = 48, PITCH = 68, GAP = 40;
function thumb(touched) {
  let x = 48, rects = "";
  COUNTS.forEach((n, col) => {
    if (col > 0) x += col === 5 ? 64 : GAP;
    for (let row = 0; row < n; row += 1) rects += `<rect x="${x}" y="${80 + row * PITCH}" width="${W}" height="${H}" rx="12"${touched.has(`${col}:${row}`) ? ' class="t"' : ""}/>`;
    x += W;
  });
  return `<svg class="th" viewBox="0 0 ${x + 48} ${80 + 7 * PITCH + 48}" preserveAspectRatio="xMidYMid meet">${rects}</svg>`;
}
const PROSE = "jevcode is an Electron app that supervises a coding agent and explains its work. The main process runs Codex through agent-codex and feeds its events through evidence-engine and semantic-core. Every event lands in the SQLite store, and the trace viewer reads it back as rows.";
const card = (cls, title, touched, counts, note) => `<div><h1>${title}</h1><div class="panel ${cls}">
  <div class="sh"><svg class="ic"><use href="#i-view-map"/></svg>Architecture</div>
  <div class="arch">${thumb(touched)}</div>
  <p class="am">${counts}</p>
  ${note}
  <button class="lnk">Open the map</button></div></div>`;
const touched = new Set(["0:2", "1:0", "3:3", "3:4"]);
const states = [
  ["Narrator text, 4 touched", touched, "21 components · 4 touched", `<p class="prose">${PROSE}</p>`],
  ["Narrator pending or off", touched, "21 components · 4 touched", `<p class="quiet">Descriptions pending</p>`],
  ["Fresh session", new Set(), "21 components", `<p class="prose">${PROSE}</p>`],
];
document.getElementById("row").innerHTML = ["w280", "w248"].flatMap((cls) => states.map(([t, s, tt, n]) => card(cls, `${t} · ${cls.slice(1)} px`, s, tt, n))).join("");
</script>
</body>
</html>
```

- [ ] **Step 4: Write the render script and render every PNG**

Create `docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/render-p0.sh`:

```bash
#!/usr/bin/env bash
# Renders the P-0 mockups (gate H2) to PNG with headless Chrome. Usage: bash render-p0.sh
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
CHROME="${CHROME_PATH:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PROFILE="$(mktemp -d)"
trap 'rm -rf "$PROFILE"' EXIT
# Chrome writes the PNG within seconds but can linger afterwards (its updater), so wait for the file, then stop it.
shot() { # <png> <url> <width>
  rm -f "$1"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check \
    --user-data-dir="$PROFILE" --window-size="$3,948" --virtual-time-budget=2000 --screenshot="$1" "$2" >/dev/null 2>&1 &
  local pid=$!
  for _ in $(seq 1 120); do
    [ -s "$1" ] && break
    sleep 0.5
  done
  sleep 1
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  test -s "$1" || { echo "no screenshot: $1" >&2; exit 1; }
}
for width in 1440 1000; do
  for state in default zoomed selected pending; do
    name="map"
    [ "$state" = default ] || name="map-$state"
    shot "$DIR/$name-$width.png" "file://$DIR/map.html?state=$state" "$width"
  done
  shot "$DIR/brief-architecture-$width.png" "file://$DIR/brief-architecture.html" "$width"
done
echo "RENDER_OK $(ls "$DIR"/map*-1440.png "$DIR"/map*-1000.png "$DIR"/brief-architecture-*.png | wc -l | tr -d ' ') png"
```

Run: `perl -e 'alarm 170; exec @ARGV' bash docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/render-p0.sh`

Expected: the last line is `RENDER_OK 10 png` (about a minute).

- [ ] **Step 5: Inspect every PNG against the brief**

Open each PNG with the Read tool. Check, and fix the HTML and re-render until each holds:

- `map-1440.png`: six band lanes left to right with their icons, names and counts; the map is centered and runs the full stage height (k about 0.77); every name shows in full; every card has a footer with the role icon, a file-count bar and the count; edges are thin light curves in the gutters and gap rows, band-to-band only, and none passes under a card; the header shows the headline, the Overview toggle and two plain sentences with component links and "More"; the Brief on the right shows Now, Changes so far and the Architecture card with a thumbnail whose 4 touched cards are accent.
- `map-1000.png`: the narrower Shell (200 px Outline, 248 px Inspector); the fit runs the full width (k about 0.52, the chip level) with every name readable at about 11 px.
- `map-zoomed-*.png`: detail-level cards with the name, purpose, two packages, "n files" and the file-count bar; the hub glyph on `contracts`; 150% zoom label.
- `map-selected-*.png`: `desktop main` has the accent ring; its edges, including same-band and hub edges, are accent and drawn last; every other edge is at 22%; the component Inspector shows purpose, root path, files with "56 more", imports out and in with an example, external packages and This session.
- `map-pending-*.png`: the header shows "22 components" with "TypeScript · JSON · Python" in muted ink beside it, "Partial map · 20,000 files mapped", "Imports not analyzed for Python" and "Descriptions pending", all quiet ink with no red and no banner; cards fall back to their root paths at the card level; the Brief card says "Descriptions pending".
- `brief-architecture-*.png`: six cards (three states at 280 and 248 px) with legible 12 px text.

- [ ] **Step 6: Append the Phase B section to the mockups README**

If `docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/README.md` does not exist, create it with the single line `# Console and explainer mockups` followed by a blank line. Then append:

```markdown
## Phase B: Map and Brief architecture card (P-0, gate H2)

- `map.html` renders four states through `?state=`: `default` (Fit centered, Brief), `zoomed` (detail level at 150%), `selected` (`desktop main` selected, all of its edges in accent, the rest at 22%, component Inspector), `pending` (rule-based header with the partial, imports-not-analyzed and descriptions-pending notes).
- `brief-architecture.html` shows the Brief's architecture card at 280 px and 248 px: narrator text, narrator pending, fresh session.
- PNGs: `map-1440.png`, `map-1000.png`, `map-zoomed-*.png`, `map-selected-*.png`, `map-pending-*.png`, `brief-architecture-*.png`; re-render with `bash render-p0.sh`.
- Numbers the implementation encodes (`MAP_LEVEL_SPECS` in `packages/trace-viewer/src/layout/map-layout.ts`, `map-camera.ts`): one geometry for every level (140 × 76 cards, side band 104, row gap 16, gutter 22, margin 16, band label 44); zoom bands chip below 0.7, card below 1.4, detail from 1.4; Fit padding 20, 20 and 68 px; names hidden below 48% zoom; no package chips.

Decisions for the person:

1. Bands are columns, left to right: UI, API · IPC, Agents, Domain, Storage, then tests, tooling and config.
2. Fit centers the map and fills the stage: the card level at 1440 px, the chip level at 1000 px, with every name shown at both.
3. Packages appear only inside detail-level cards (the top two); the Inspector lists all of them.
4. At rest the Map draws band-to-band edges only; same-band and hub edges show when their card is selected or hovered. Selecting a card dims other edges, not other cards.
5. Narrator states read as quiet words, never banners: "Descriptions pending" (shown), "Descriptions off" and "Descriptions unavailable" (ruling R3); a failed scan reads "Codebase map unavailable" with a Retry text button.

H2 approval: PENDING
```

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/map.html \
  docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/brief-architecture.html \
  docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/render-p0.sh \
  docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/map-*.png \
  docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/map-1440.png \
  docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/map-1000.png \
  docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/brief-architecture-*.png \
  docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/README.md
git -c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com commit -m "docs(mockups): add Map and Brief architecture card mockups for gate H2"
```

- [ ] **Step 8: HUMAN GATE H2 (blocks P-3 and P-4 only)**

Stop the lane's UI tasks here. The controller shows the person the ten PNGs (or the HTML files, which the person can open in a browser and resize) and the five decisions in the README section. The person approves or asks for changes. On changes: edit the HTML, re-render (Step 4), re-check (Step 5), amend the README decisions, commit, and ask again. On approval, replace `H2 approval: PENDING` with `H2 approval: approved by the person on <YYYY-MM-DD>; <rulings, or "no changes">` and commit:

```bash
git add docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/README.md
git -c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com commit -m "docs(mockups): record H2 approval of the Map mockups"
```

Any ruling that changes a size, gutter or threshold is applied to `MAP_LEVEL_SPECS`, the zoom thresholds or `MAP_ICON_ONLY_K` in P-2 (if P-2 is done, as a P-3 pre-step, with the P-2 tests rerun). P-1 and P-2 do not wait for this gate.

### Task P-1: Fold `overview_snapshot` into `TraceSession.overview` (incremental equals fresh)

**Files:**
- Modify: `packages/trace-viewer/src/model/types.ts` (import list at the top; add `OverviewModel` before `TraceSession`; add the `overview` field after `hidden`)
- Modify: `packages/trace-viewer/src/model/fold-state.ts` (import list; one field in `class FoldState`)
- Create: `packages/trace-viewer/src/model/fold-overview.ts`, `packages/trace-viewer/src/model/component-path.ts` (ruling R6), `packages/trace-viewer/src/model/overview-status.ts` (ruling R3)
- Modify: `packages/trace-viewer/src/model/fold.ts` (import; one `case` in `accumulate`)
- Modify: `packages/trace-viewer/src/model/fold-finalize.ts` (import; one field in the `partial` literal of `Finalizer.run`)
- Modify: `packages/trace-viewer/src/model/index.ts` (append three lines)
- Modify (only if the prerequisite check printed `0`): `packages/trace-viewer/src/model/registry.ts` (`ENVELOPE_RULES.overview_snapshot`)
- Create: `packages/trace-viewer/src/test-support/overview-builder.ts`
- Modify: `packages/trace-viewer/src/test-support/trace-builder.ts` (one method), `row-arbitraries.ts` (overview rows in `opArb`), `session-builder.ts` (`SessionSeed.overview`, the `overview` field), `canvas-arbitraries.ts` (the `overview` field)
- Test: `packages/trace-viewer/src/model/fold-overview.test.ts`, `component-path.test.ts`, `overview-status.test.ts` (create), `packages/trace-viewer/src/model/fold.incremental.test.ts` (append one `describe`)

**Interfaces:**
- Consumes (lane 01, K-1 and K-2, merged in W0): from `@jevcode/contracts`: `OverviewSnapshotSchema`, `ComponentSchema`, `type OverviewSnapshot`, `type OverviewStatus` (ruling R3), `type Component`, `type ExternalDep`, `type Role`, `ROLES`; `"overview_snapshot"` in `EVENT_TYPES` and `TRACE_ROW_TYPES`. Existing model internals: `parseOrGap(state, row, schema)` and the `switch (type)` in `fold.ts`; `Finalizer.run()` and its `previous = d.session` in `fold-finalize.ts`; `FoldState` in `fold-state.ts`; `TraceBuilder`, `testMeta`, `SESSION_ID` in `src/test-support/trace-builder.ts`; `checkIncremental` and `NOW` inside `fold.incremental.test.ts`.
- Produces:
  - `src/model/types.ts`: `export interface OverviewModel { snapshot: OverviewSnapshot; componentById: ReadonlyMap<string, Component>; seq: number }` and `TraceSession.overview: OverviewModel | null` (interfaces §6.5).
  - `@jevcode/trace-viewer/model`: `buildOverviewModel(snapshot: OverviewSnapshot, seq: number, previous?: OverviewModel | null): OverviewModel` (deviation 3); `componentIdForPath(components: readonly Component[], path: string): string | null` (deviation 12; lane 07 consumes it); `overviewStatusOf(snapshot: OverviewSnapshot): OverviewStatus` (deviation 11).
  - Internal (not in the barrel): `foldOverviewSnapshot(state, snapshot, seq)`, `overviewModelOf(latest, previous)`, `sameComponent(a, b)`, `COMPONENT_KEYS`; `FoldState.overview: { snapshot: OverviewSnapshot; seq: number } | null`.
  - Test-only: `componentId(rootPath)`, `componentOf(seed)`, `overviewSnapshot(seed)` (with `totalFiles?` and `status?`), `syntheticOverview(options)`, `type ComponentSeed`, `type OverviewSeed` (`src/test-support/overview-builder.ts`); `TraceBuilder.overview(snapshot, ts?)`; `OVERVIEW_ROWS` (`row-arbitraries.ts`); `SessionSeed.overview?: OverviewSnapshot`.

Rules (spec §8.1, viewer spec §6.4): an `overview_snapshot` row is parsed with `OverviewSnapshotSchema`; a payload that fails it adds an `invalid_row` gap and keeps the earlier overview. A valid row replaces the overview (seqs only grow, so the latest row wins). The row makes no step, does not move the display clock, does not touch a turn and is not counted in `hidden`. `finalize` returns the previous `OverviewModel` object while no new snapshot row arrived; a new row gives a new model in which every component equal to the previous one with the same id (and the same content hash) is the previous object.

- [ ] **Step 1: Write the test builders**

Create `packages/trace-viewer/src/test-support/overview-builder.ts`:

```ts
// Test-only: overview snapshots for model, layout and view tests. Excluded from the build (tsconfig.build.json).
import { createHash } from "node:crypto";

import { OverviewSnapshotSchema, ROLES, type Component, type OverviewSnapshot, type Role } from "@jevcode/contracts";

import { SESSION_ID } from "./trace-builder.js";

export interface ComponentSeed {
  rootPath: string;
  /** Default: the last path segment. */
  name?: string;
  role?: Role;
  /** Default: role. */
  roleGuess?: Role;
  purpose?: string | null;
  provenance?: "rule" | "model";
  files?: string[];
  fileCount?: number;
  /** Default "TypeScript"; null is allowed. */
  language?: string | null;
  importsAnalyzed?: boolean;
  externalDeps?: { name: string; count: number }[];
  entryPoints?: string[];
  /** Two seeds with the same rootPath and version have the same contentHash. */
  version?: number;
}

export interface OverviewSeed {
  components: readonly ComponentSeed[];
  /** Endpoints by rootPath. */
  edges?: readonly { from: string; to: string; count: number; examples?: string[] }[];
  externals?: readonly { name: string; usedBy: readonly { rootPath: string; count: number }[] }[];
  partial?: boolean;
  /** counts.files; default: the sum of fileCount. */
  files?: number;
  languages?: string[];
  narrative?: OverviewSnapshot["narrative"];
  sessionId?: string;
  repoRoot?: string;
  scanId?: string;
}

const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");

/** "cmp_" + sha1(rootPath).slice(0, 12) (spec §5.2). */
export function componentId(rootPath: string): string {
  return `cmp_${sha1(rootPath).slice(0, 12)}`;
}

export function componentOf(seed: ComponentSeed): Component {
  const role = seed.role ?? "domain";
  const files = seed.files ?? [`${seed.rootPath}/index.ts`];
  return {
    id: componentId(seed.rootPath),
    rootPath: seed.rootPath,
    name: seed.name ?? seed.rootPath.split("/").at(-1) ?? seed.rootPath,
    fileCount: seed.fileCount ?? files.length,
    files,
    language: seed.language === undefined ? "TypeScript" : seed.language,
    roleGuess: seed.roleGuess ?? role,
    role,
    purpose: seed.purpose === undefined ? null : seed.purpose,
    provenance: seed.provenance ?? "rule",
    contentHash: sha1(`${seed.rootPath}:${seed.version ?? 0}`),
    externalDeps: seed.externalDeps ?? [],
    entryPoints: seed.entryPoints ?? [],
    importsAnalyzed: seed.importsAnalyzed ?? true,
  };
}

/** A schema-valid snapshot. It is parsed here, so a seed that breaks a cap or a regex throws in the test setup. */
export function overviewSnapshot(seed: OverviewSeed): OverviewSnapshot {
  const components = seed.components.map(componentOf);
  const edges = (seed.edges ?? []).map((edge) => ({
    from: componentId(edge.from),
    to: componentId(edge.to),
    count: edge.count,
    examples: edge.examples ?? [],
  }));
  const externals = (seed.externals ?? []).map((ext) => ({
    name: ext.name,
    usedBy: ext.usedBy.map((use) => ({ componentId: componentId(use.rootPath), count: use.count })),
  }));
  const languages =
    seed.languages ?? [...new Set(components.flatMap((component) => (component.language === null ? [] : [component.language])))];
  return OverviewSnapshotSchema.parse({
    sessionId: seed.sessionId ?? SESSION_ID,
    repoRoot: seed.repoRoot ?? "/repo",
    scanId: seed.scanId ?? "scan-1",
    partial: seed.partial ?? false,
    counts: {
      files: seed.files ?? components.reduce((sum, component) => sum + component.fileCount, 0),
      components: components.length,
      edges: edges.length,
      languages,
    },
    components,
    edges,
    externals,
    narrative: seed.narrative ?? null,
    generatedAt: "2026-10-02T09:00:00.000Z",
  });
}

/** mulberry32: a small deterministic generator for synthetic snapshots. */
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A deterministic large snapshot (bench and stress): components across every role, `edges` distinct pairs. */
export function syntheticOverview(options: { components: number; edges: number; seed?: number; partial?: boolean }): OverviewSnapshot {
  const next = generator(options.seed ?? 1);
  const pick = (n: number): number => Math.floor(next() * n);
  const seeds: ComponentSeed[] = Array.from({ length: options.components }, (_, index) => ({
    rootPath: `packages/p${String(index).padStart(3, "0")}`,
    name: `p${String(index).padStart(3, "0")}`,
    role: ROLES[index % ROLES.length] ?? "domain",
    fileCount: 5 + pick(140),
    purpose: index % 3 === 0 ? null : `Component ${index} of the synthetic repo.`,
    provenance: index % 3 === 0 ? "rule" : "model",
  }));
  const edges: { from: string; to: string; count: number }[] = [];
  const seen = new Set<string>();
  for (let attempt = 0; edges.length < options.edges && attempt < options.edges * 20; attempt += 1) {
    const from = seeds[pick(seeds.length)];
    const to = seeds[pick(seeds.length)];
    if (from === undefined || to === undefined || from.rootPath === to.rootPath) continue;
    const key = `${from.rootPath}>${to.rootPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from: from.rootPath, to: to.rootPath, count: 1 + pick(40) });
  }
  const externals = Array.from({ length: Math.min(120, Math.floor(options.components / 2)) }, (_, index) => ({
    name: `ext-${index}`,
    usedBy: [0, 1, 2].flatMap((k) => {
      const user = seeds[(index * 7 + k * 13) % Math.max(1, seeds.length)];
      return user === undefined ? [] : [{ rootPath: user.rootPath, count: 1 + ((index + k) % 9) }];
    }),
  }));
  return overviewSnapshot({ components: seeds, edges, externals, partial: options.partial ?? false });
}
```

Add to `packages/trace-viewer/src/test-support/trace-builder.ts`: extend the type import from `@jevcode/contracts` with `OverviewSnapshot`, and add this method to `class TraceBuilder` after `jev`:

```ts
  overview(snapshot: OverviewSnapshot, ts?: string): number {
    return this.raw("overview_snapshot", snapshot, this.nextTs(ts));
  }
```

- [ ] **Step 2: Write the failing tests**

Create `packages/trace-viewer/src/model/fold-overview.test.ts`:

```ts
import { ComponentSchema, type Component, type OverviewSnapshot } from "@jevcode/contracts";
import { describe, expect, it } from "vitest";

import { overviewSnapshot } from "../test-support/overview-builder.js";
import { SESSION_ID, TraceBuilder, testMeta } from "../test-support/trace-builder.js";
import { accumulateAll, createTraceState, finalize, foldRows } from "./fold.js";
import { COMPONENT_KEYS, sameComponent } from "./fold-overview.js";
import type { TraceSession } from "./types.js";

// Spec §8.1: the fold keeps the latest overview_snapshot row (replace semantics); unchanged components keep their
// identity through id plus content hash (viewer spec §6.4 identity rules).

const WEB = { rootPath: "apps/web", role: "ui" } as const;
const API = { rootPath: "packages/api", role: "api" } as const;
const DB = { rootPath: "packages/db", role: "storage" } as const;
const EDGES = [{ from: "apps/web", to: "packages/api", count: 3 }];
const A = overviewSnapshot({ components: [WEB, API, DB], edges: EDGES });
const B = overviewSnapshot({ components: [WEB, { ...API, purpose: "Serves the web app.", provenance: "model" }, DB], edges: EDGES });
const C = overviewSnapshot({ components: [WEB, API, { ...DB, version: 1 }, { rootPath: "packages/jobs", role: "agent" }], edges: EDGES });

function componentIn(session: TraceSession, snapshot: OverviewSnapshot, index: number): Component | undefined {
  const id = snapshot.components[index]?.id;
  return id === undefined ? undefined : session.overview?.componentById.get(id);
}

function started(): TraceBuilder {
  const b = new TraceBuilder();
  b.agent({ type: "agent_started", prompt: "Map the repo" });
  return b;
}

describe("overview_snapshot fold (spec §8.1)", () => {
  it("has no overview without a snapshot row", () => {
    const b = started();
    expect(foldRows(testMeta({ lastEventSeq: b.rows.length }), b.rows, { live: false }).overview).toBeNull();
  });

  it("keeps the latest snapshot row (replace semantics)", () => {
    const b = started();
    b.overview(A);
    b.agent({ type: "agent_message", role: "assistant", text: "Working" });
    const seqB = b.overview(B);
    const session = foldRows(testMeta({ lastEventSeq: b.rows.length }), b.rows, { live: false });
    expect(session.overview?.seq).toBe(seqB);
    expect(session.overview?.snapshot).toEqual(B);
    expect([...(session.overview?.componentById.keys() ?? [])]).toEqual(B.components.map((component) => component.id));
  });

  it("makes no step, moves no clock and counts nowhere in hidden", () => {
    const b = started();
    b.agent({ type: "agent_message", role: "assistant", text: "Working" });
    const without = foldRows(testMeta({ lastEventSeq: b.rows.length }), b.rows, { live: false });
    b.overview(A, TraceBuilder.at(3_600));
    const withRow = foldRows(testMeta({ lastEventSeq: b.rows.length }), b.rows, { live: false });
    expect(withRow.steps).toEqual(without.steps);
    expect(withRow.span).toEqual(without.span);
    expect(withRow.hidden.byType).toEqual({});
    expect(withRow.gaps).toEqual([]);
    expect(withRow.overview?.snapshot).toEqual(A);
  });

  it("an invalid snapshot row adds an invalid_row gap and keeps the earlier overview", () => {
    const b = started();
    b.overview(A);
    const bad = b.raw("overview_snapshot", { sessionId: SESSION_ID, repoRoot: "" });
    const session = foldRows(testMeta({ lastEventSeq: b.rows.length }), b.rows, { live: false });
    expect(session.overview?.snapshot).toEqual(A);
    expect(session.gaps).toEqual([expect.objectContaining({ kind: "invalid_row", atSeq: bad })]);
  });

  it("keeps the overview object while no snapshot row arrives", () => {
    const b = started();
    b.overview(A);
    const state = accumulateAll(createTraceState(testMeta()), b.rows);
    const first = finalize(state, { live: true });
    const cut = b.rows.length;
    b.agent({ type: "agent_message", role: "assistant", text: "Still working" });
    accumulateAll(state, b.rows.slice(cut));
    const second = finalize(state, { live: true });
    expect(second.overview).not.toBeNull();
    expect(second.overview).toBe(first.overview);
  });

  it("a new snapshot replaces the overview and keeps unchanged components by id and content hash", () => {
    const b = started();
    b.overview(A);
    const state = accumulateAll(createTraceState(testMeta()), b.rows);
    const first = finalize(state, { live: true });
    const cut = b.rows.length;
    b.overview(B);
    accumulateAll(state, b.rows.slice(cut));
    const second = finalize(state, { live: true });
    expect(second.overview).not.toBe(first.overview);
    expect(componentIn(second, B, 0)).toBe(componentIn(first, A, 0));
    expect(componentIn(second, B, 2)).toBe(componentIn(first, A, 2));
    expect(componentIn(second, B, 1)).not.toBe(componentIn(first, A, 1));
    expect(componentIn(second, B, 1)?.purpose).toBe("Serves the web app.");
    expect(second.overview?.snapshot.components[0]).toBe(componentIn(first, A, 0));

    const cut2 = b.rows.length;
    b.overview(C);
    accumulateAll(state, b.rows.slice(cut2));
    const third = finalize(state, { live: true });
    expect(componentIn(third, C, 0)).toBe(componentIn(second, B, 0));
    expect(componentIn(third, C, 2)).not.toBe(componentIn(second, B, 2));
    expect(componentIn(third, C, 3)?.rootPath).toBe("packages/jobs");
  });

  it("a live flip re-derives a deep-equal overview", () => {
    const b = started();
    b.overview(A);
    const state = accumulateAll(createTraceState(testMeta()), b.rows);
    const live = finalize(state, { live: true });
    const done = finalize(state, { live: false });
    expect(done.overview).toEqual(live.overview);
  });

  it("never changes an overview it returned", () => {
    const b = started();
    b.overview(A);
    const state = accumulateAll(createTraceState(testMeta()), b.rows);
    const first = finalize(state, { live: true });
    const copy = structuredClone(first.overview);
    const cut = b.rows.length;
    b.overview(C);
    accumulateAll(state, b.rows.slice(cut));
    finalize(state, { live: true });
    expect(first.overview).toStrictEqual(copy);
  });
});

function mutate(value: unknown): unknown {
  if (typeof value === "string") return `${value}x`;
  if (typeof value === "number") return value + 1;
  if (typeof value === "boolean") return !value;
  if (value === null) return "x";
  if (Array.isArray(value)) return [...value, "x"];
  throw new Error(`no mutation for ${String(value)}`);
}

describe("sameComponent", () => {
  it("compares every ComponentSchema field", () => {
    expect([...COMPONENT_KEYS].sort()).toEqual(Object.keys(ComponentSchema.shape).sort());
    const base = A.components[0];
    if (base === undefined) throw new Error("fixture has no component");
    expect(sameComponent(base, structuredClone(base))).toBe(true);
    for (const key of COMPONENT_KEYS) {
      const changed = { ...base, [key]: mutate(base[key]) } as Component;
      expect(sameComponent(base, changed), key).toBe(false);
    }
  });
});
```

Append to `packages/trace-viewer/src/model/fold.incremental.test.ts` (it already defines `checkIncremental`, `NOW` and imports `TraceBuilder` and `testMeta`; add `OVERVIEW_ROWS` to its import from `../test-support/row-arbitraries.js`):

```ts
describe("incremental finalize: overview snapshots (spec §8.1)", () => {
  it("every prefix of a session with snapshot rows finalizes to the fresh fold", () => {
    const b = new TraceBuilder();
    b.agent({ type: "agent_started", prompt: "Map the repo" });
    for (const snapshot of OVERVIEW_ROWS) {
      b.overview(snapshot);
      b.agent({ type: "agent_message", role: "assistant", text: "Working" });
    }
    b.raw("overview_snapshot", { sessionId: "sess-test", repoRoot: "" });
    const meta = testMeta({ lastEventSeq: b.rows.length });
    for (const live of [false, true]) {
      checkIncremental(meta, b.rows, b.rows.map((_, index) => index + 1), () => ({ live, nowMs: NOW }));
    }
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/model/fold-overview.test.ts src/model/fold.incremental.test.ts`

Expected: FAIL. `fold-overview.test.ts` fails to load with `Cannot find module './fold-overview.js'`; `fold.incremental.test.ts` fails to load with `"OVERVIEW_ROWS" is not exported` (or the TypeScript error `Module '"../test-support/row-arbitraries.js"' has no exported member 'OVERVIEW_ROWS'`).

If the prerequisite check printed `0` for `overview_snapshot: "consume"`, open `packages/trace-viewer/src/model/registry.ts` and set `overview_snapshot: "consume",` in `ENVELOPE_RULES` (keep `explainer` as K-1 left it; lane 07 owns it).

- [ ] **Step 4: Add the model types**

In `packages/trace-viewer/src/model/types.ts`, add `Component` and `OverviewSnapshot` to the existing `import type { … } from "@jevcode/contracts";` list, then add this block directly above `export interface TraceSession {`:

```ts
/**
 * The latest overview_snapshot row (spec §8.1, replace semantics). Between finalize calls with the same `live` the
 * model is the same object until a new snapshot row arrives; in a new model every component equal to the previous one
 * with the same id and content hash is the previous object.
 */
export interface OverviewModel {
  snapshot: OverviewSnapshot;
  componentById: ReadonlyMap<string, Component>;
  /** seq of the overview_snapshot row. */
  seq: number;
}
```

and add the field as the last member of `TraceSession` (after `hidden: Hidden;`):

```ts
  /** null until an overview_snapshot row arrives (spec §8.1). */
  overview: OverviewModel | null;
```

In `packages/trace-viewer/src/model/fold-state.ts`, add `OverviewSnapshot` to the `import type { … } from "@jevcode/contracts";` list, and add this field to `class FoldState` directly after `readonly touchedSteps: StepDraft[] = [];`:

```ts
  /** The latest valid overview_snapshot row and its seq (spec §8.1, replace semantics); null until one arrives. */
  overview: { snapshot: OverviewSnapshot; seq: number } | null = null;
```

- [ ] **Step 5: Write `fold-overview.ts`**

Create `packages/trace-viewer/src/model/fold-overview.ts`:

```ts
import type { Component, OverviewSnapshot } from "@jevcode/contracts";

import type { FoldState } from "./fold-state.js";
import type { OverviewModel } from "./types.js";

/** Replace semantics (spec §8.1): the latest snapshot row wins. accumulate skips lower seqs, so seqs only grow. */
export function foldOverviewSnapshot(state: FoldState, snapshot: OverviewSnapshot, seq: number): void {
  state.overview = { snapshot, seq };
}

/** Every ComponentSchema field, which sameComponent compares (fold-overview.test.ts pins the list to the schema). */
export const COMPONENT_KEYS = [
  "id",
  "rootPath",
  "name",
  "fileCount",
  "files",
  "language",
  "roleGuess",
  "role",
  "purpose",
  "provenance",
  "contentHash",
  "externalDeps",
  "entryPoints",
  "importsAnalyzed",
] as const;

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

/** Field-by-field equality of two parsed components; id and content hash first, since they settle most pairs. */
export function sameComponent(a: Component, b: Component): boolean {
  if (a === b) return true;
  if (a.id !== b.id || a.contentHash !== b.contentHash) return false;
  if (a.rootPath !== b.rootPath || a.name !== b.name || a.fileCount !== b.fileCount || a.language !== b.language) return false;
  if (a.roleGuess !== b.roleGuess || a.role !== b.role || a.purpose !== b.purpose || a.provenance !== b.provenance) return false;
  if (a.importsAnalyzed !== b.importsAnalyzed) return false;
  if (!sameStrings(a.files, b.files) || !sameStrings(a.entryPoints, b.entryPoints)) return false;
  if (a.externalDeps.length !== b.externalDeps.length) return false;
  return a.externalDeps.every((dep, index) => {
    const other = b.externalDeps[index];
    return other !== undefined && dep.name === other.name && dep.count === other.count;
  });
}

/** A model of `snapshot` in which every component equal to `previous`'s component with the same id is that object. */
export function buildOverviewModel(snapshot: OverviewSnapshot, seq: number, previous: OverviewModel | null = null): OverviewModel {
  const prior = previous?.componentById;
  const components = snapshot.components.map((component) => {
    const old = prior?.get(component.id);
    return old !== undefined && sameComponent(old, component) ? old : component;
  });
  const componentById = new Map<string, Component>();
  for (const component of components) if (!componentById.has(component.id)) componentById.set(component.id, component);
  return { snapshot: { ...snapshot, components }, componentById, seq };
}

/** finalize's overview: the previous model while the row is the same, else a new model that keeps unchanged components. */
export function overviewModelOf(latest: FoldState["overview"], previous: OverviewModel | null): OverviewModel | null {
  if (latest === null) return null;
  if (previous !== null && previous.seq === latest.seq) return previous;
  return buildOverviewModel(latest.snapshot, latest.seq, previous);
}
```

- [ ] **Step 6: Consume the rows and attach the model**

In `packages/trace-viewer/src/model/fold.ts`, add `OverviewSnapshotSchema` to the value import from `@jevcode/contracts`, add `import { foldOverviewSnapshot } from "./fold-overview.js";` after the `fold-finalize.js` import, and add this case to the `switch (type)` in `accumulate`, directly before `default:`:

```ts
    case "overview_snapshot": {
      // Replace semantics (spec §8.1): no step, no clock move, no turn; an invalid payload is an invalid_row gap.
      const snapshot = parseOrGap(s, row, OverviewSnapshotSchema);
      if (snapshot !== null) foldOverviewSnapshot(s, snapshot, row.seq);
      break;
    }
```

In `packages/trace-viewer/src/model/fold-finalize.ts`, add `import { overviewModelOf } from "./fold-overview.js";` after the `fold-evidence.js` import, and in `Finalizer.run()` add this member to the `partial` object literal, directly after its `hidden: keep(previous?.hidden, { … }),` entry:

```ts
      overview: overviewModelOf(s.overview, previous?.overview ?? null),
```

(`previous` is `d.session`, which is `null` on a full re-derive, so a `live` flip or a clock-origin change builds a new, deep-equal model.)

Append to `packages/trace-viewer/src/model/index.ts`:

```ts
export { buildOverviewModel } from "./fold-overview.js";
```

- [ ] **Step 7: Give built sessions and random row sessions an overview**

In `packages/trace-viewer/src/test-support/session-builder.ts`: add `import type { OverviewSnapshot } from "@jevcode/contracts";` (merge into an existing `@jevcode/contracts` type import if there is one), add `buildOverviewModel` to its import from `../model/index.js`, add this member to `interface SessionSeed` after `trailingHiddenRows?: number;`:

```ts
  /** An overview_snapshot to fold into session.overview (seq = loadedThroughSeq). */
  overview?: OverviewSnapshot;
```

and add this member to the object `buildSession` returns, after `hidden: { … },`:

```ts
    overview: seed.overview === undefined ? null : buildOverviewModel(seed.overview, Math.max(1, loadedThroughSeq)),
```

In `packages/trace-viewer/src/test-support/canvas-arbitraries.ts`, add `overview: null,` to the `TraceSession` literal that starts with `schemaVersion: 1,` (after its `hidden` member).

In `packages/trace-viewer/src/test-support/row-arbitraries.ts`, add `import { overviewSnapshot } from "./overview-builder.js";` after the `trace-builder.js` import, add this block directly above `const opArb`:

```ts
/** Three snapshots of one repo: a first scan, a description pass that changes one purpose, a rescan that changes one
 *  component's content and adds another. Shared with fold.incremental.test.ts. */
export const OVERVIEW_ROWS = [
  overviewSnapshot({
    components: [{ rootPath: "apps/web", role: "ui" }, { rootPath: "packages/api", role: "api" }, { rootPath: "packages/db", role: "storage" }],
    edges: [{ from: "apps/web", to: "packages/api", count: 3 }, { from: "packages/api", to: "packages/db", count: 7 }],
  }),
  overviewSnapshot({
    components: [
      { rootPath: "apps/web", role: "ui" },
      { rootPath: "packages/api", role: "api", purpose: "Serves the web app.", provenance: "model" },
      { rootPath: "packages/db", role: "storage" },
    ],
    edges: [{ from: "apps/web", to: "packages/api", count: 3 }, { from: "packages/api", to: "packages/db", count: 7 }],
  }),
  overviewSnapshot({
    components: [
      { rootPath: "apps/web", role: "ui" },
      { rootPath: "packages/api", role: "api" },
      { rootPath: "packages/db", role: "storage", version: 1 },
      { rootPath: "packages/jobs", role: "agent" },
    ],
    edges: [{ from: "apps/web", to: "packages/api", count: 3 }, { from: "packages/jobs", to: "packages/db", count: 2 }],
  }),
] as const;

const overviewOp: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: pick(OVERVIEW_ROWS).map((snapshot): Op => (b) => b.overview(snapshot)) },
  { weight: 1, arbitrary: fc.constant<Op>((b) => b.raw("overview_snapshot", { sessionId: "sess-test", repoRoot: "" })) },
);
```

and add `{ weight: 1, arbitrary: overviewOp },` as the last entry of `opArb`'s `fc.oneof(…)`. Every random-row property in `fold.incremental.test.ts` (random, dense and row-by-row) now folds snapshot rows too.

- [ ] **Step 8: Add `componentIdForPath` (ruling R6) and `overviewStatusOf` (ruling R3), failing tests first**

Create `packages/trace-viewer/src/model/component-path.test.ts` (the cases lane 07's plan wrote for this function, derived from spec §5.2):

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { componentId, componentOf } from "../test-support/overview-builder.js";
import { componentIdForPath } from "./component-path.js";

const server = componentOf({ rootPath: "src/server", files: ["src/server/app.ts", "src/server/index.ts"] });
const serverRoutes = componentOf({ rootPath: "src/server/routes", files: ["src/server/routes/limits.ts"] });
const tests = componentOf({ rootPath: "tests", files: ["tests/rate-limit.test.ts", "src/server/app.test.ts"], role: "tests" });
const root = componentOf({ rootPath: ".", files: ["package.json"], name: "config", role: "config" });
const lib = componentOf({ rootPath: "lib", files: ["lib/a.ts"] });

describe("componentIdForPath (spec §5.2, ruling R6)", () => {
  it("prefers the component that lists the file over a path prefix", () => {
    // Rule 4: a test file joins the component it tests, which may sit outside its directory.
    expect(componentIdForPath([server, tests], "src/server/app.test.ts")).toBe(tests.id);
  });

  it("picks the longest root that is a whole-segment prefix", () => {
    expect(componentIdForPath([server, serverRoutes], "src/server/routes/new.ts")).toBe(serverRoutes.id);
    expect(componentIdForPath([server, serverRoutes], "src/server/new.ts")).toBe(server.id);
    expect(componentIdForPath([server], "src/server2/x.ts")).toBeNull();
  });

  it("falls back to the repo-root component and returns null without one", () => {
    expect(componentIdForPath([server, root], "scripts/build.mjs")).toBe(root.id);
    expect(componentIdForPath([server], "scripts/build.mjs")).toBeNull();
    expect(componentIdForPath([], "src/server/app.ts")).toBeNull();
  });

  it("returns a component that lists the path or whose root contains it", () => {
    const pool = ["src/server/app.ts", "src/server/routes/limits.ts", "src/server/app.test.ts", "tests/x.test.ts", "lib/a.ts", "package.json"];
    const components = [server, serverRoutes, tests, root, lib];
    fc.assert(
      fc.property(fc.subarray(components, { minLength: 0 }), fc.constantFrom(...pool), (chosen, path) => {
        const id = componentIdForPath(chosen, path);
        const owns = (c: (typeof components)[number]): boolean => c.files.includes(path) || c.rootPath === "." || path.startsWith(`${c.rootPath}/`);
        expect(id === null).toBe(!chosen.some(owns));
        const component = chosen.find((c) => c.id === id);
        expect(id === null || component !== undefined).toBe(true);
        const listed = chosen.some((c) => c.files.includes(path));
        expect(component === undefined || (listed ? component.files.includes(path) : owns(component))).toBe(true);
      }),
    );
  });

  it("names components by the spec id formula", () => {
    expect(server.id).toBe(componentId("src/server"));
    expect(server.id).toMatch(/^cmp_[0-9a-f]{12}$/);
  });
});
```

Create `packages/trace-viewer/src/model/overview-status.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { overviewSnapshot } from "../test-support/overview-builder.js";
import { overviewStatusOf } from "./overview-status.js";

describe("overviewStatusOf (ruling R3)", () => {
  it("returns the row's status when it carries one", () => {
    const status = { scan: { state: "running" as const, scanned: 3_200, total: 9_800 }, narrator: "off" as const };
    expect(overviewStatusOf(overviewSnapshot({ components: [], status }))).toEqual(status);
  });

  it("reads a row without status as a finished scan, narrator pending while a purpose is missing", () => {
    const snapshot = overviewSnapshot({ components: [{ rootPath: "a", purpose: "Does a." }, { rootPath: "b" }], files: 12, totalFiles: 30 });
    expect(overviewStatusOf(snapshot)).toEqual({ scan: { state: "done", scanned: 12, total: 30 }, narrator: "pending" });
  });

  it("reads a row without status whose components all have a purpose as narrator ready", () => {
    const snapshot = overviewSnapshot({ components: [{ rootPath: "a", purpose: "Does a." }], files: 4 });
    expect(overviewStatusOf(snapshot)).toEqual({ scan: { state: "done", scanned: 4, total: 4 }, narrator: "ready" });
  });
});
```

Extend the test builder: in `packages/trace-viewer/src/test-support/overview-builder.ts`, add `type OverviewStatus` to its `@jevcode/contracts` import, add two members to `interface OverviewSeed` after `languages?: string[];`:

```ts
  /** counts.totalFiles (ruling R3): repo files before the 20,000-file cap. */
  totalFiles?: number;
  /** Ruling R3; absent by default, like rows written before the field. */
  status?: OverviewStatus;
```

and in `overviewSnapshot`, change the `counts` object to end with `languages, ...(seed.totalFiles === undefined ? {} : { totalFiles: seed.totalFiles }),` and add `...(seed.status === undefined ? {} : { status: seed.status }),` after `narrative: seed.narrative ?? null,`.

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/model/component-path.test.ts src/model/overview-status.test.ts` — expected: FAIL to load both (`Cannot find module './component-path.js'`, `'./overview-status.js'`).

Create `packages/trace-viewer/src/model/component-path.ts`:

```ts
import type { Component } from "@jevcode/contracts";

interface PathIndex {
  /** Listed file -> the component that lists it (longest root first, then id). */
  listed: ReadonlyMap<string, string>;
  /** Roots other than ".", longest first. */
  roots: readonly { root: string; id: string }[];
  /** The repo-root component, if any. */
  rootId: string | null;
}

const indexes = new WeakMap<readonly Component[], PathIndex>();

function indexOf(components: readonly Component[]): PathIndex {
  const cached = indexes.get(components);
  if (cached !== undefined) return cached;
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const ordered = [...components].sort((a, b) => b.rootPath.length - a.rootPath.length || cmp(a.rootPath, b.rootPath) || cmp(a.id, b.id));
  const listed = new Map<string, string>();
  for (const component of ordered) for (const file of component.files) if (!listed.has(file)) listed.set(file, component.id);
  const index: PathIndex = {
    listed,
    roots: ordered.filter((component) => component.rootPath !== ".").map((component) => ({ root: component.rootPath, id: component.id })),
    rootId: ordered.find((component) => component.rootPath === ".")?.id ?? null,
  };
  indexes.set(components, index);
  return index;
}

/**
 * The component a repo-relative path belongs to (spec §5.2; orchestrator ruling R6: the one path → component rule for
 * the Map, the Brief and the desktop stage). A component that lists the file wins (rule 4: a test joins the component
 * it tests), then the longest root that is a whole-segment prefix, then the repo-root component ("."), else null.
 */
export function componentIdForPath(components: readonly Component[], path: string): string | null {
  const index = indexOf(components);
  const listed = index.listed.get(path);
  if (listed !== undefined) return listed;
  for (const { root, id } of index.roots) if (path === root || path.startsWith(`${root}/`)) return id;
  return index.rootId;
}
```

Create `packages/trace-viewer/src/model/overview-status.ts`:

```ts
import type { OverviewSnapshot, OverviewStatus } from "@jevcode/contracts";

/**
 * Ruling R3: the snapshot's status, or the default for rows written without one: the scan is done, and the narrator is
 * pending while any component has no purpose, else ready.
 */
export function overviewStatusOf(snapshot: OverviewSnapshot): OverviewStatus {
  if (snapshot.status !== undefined) return snapshot.status;
  return {
    scan: { state: "done", scanned: snapshot.counts.files, total: snapshot.counts.totalFiles ?? snapshot.counts.files },
    narrator: snapshot.components.some((component) => component.purpose === null) ? "pending" : "ready",
  };
}
```

Append to `packages/trace-viewer/src/model/index.ts`:

```ts
export { componentIdForPath } from "./component-path.js";
export { overviewStatusOf } from "./overview-status.js";
```

Run the same command — expected: PASS, 8 tests.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/model/fold-overview.test.ts src/model/fold.incremental.test.ts src/model/registry.test.ts src/model/component-path.test.ts src/model/overview-status.test.ts`

Expected: PASS, every test in the five files.

Then prove the identity test catches a model rebuilt on every call: in `fold-overview.ts`, temporarily change `if (previous !== null && previous.seq === latest.seq) return previous;` to `if (previous !== null && previous.seq === latest.seq) return buildOverviewModel(latest.snapshot, latest.seq, null);` and rerun `fold-overview.test.ts`. Expected: FAIL in "keeps the overview object while no snapshot row arrives". Restore the line. Then change `return old !== undefined && sameComponent(old, component) ? old : component;` to `return component;` and rerun. Expected: FAIL in "a new snapshot replaces the overview and keeps unchanged components by id and content hash". Restore the line and rerun: PASS.

- [ ] **Step 10: Run the whole model suite, typecheck and lint**

Run: `perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/model src/layout`

Expected: PASS (the incremental properties now include snapshot rows; `INC_RUNS` keeps its default of 400).

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer typecheck`

Expected: exits 0. A `TraceSession` literal without `overview` is a type error; the two builders in Step 7 are the only ones in the repository (`grep -rn "unreceived:" packages/trace-viewer/src apps/*/src` lists `types.ts`, `fold-finalize.ts`, `session-builder.ts` and `canvas-arbitraries.ts`).

Run: `perl -e 'alarm 170; exec @ARGV' pnpm exec eslint packages/trace-viewer`

Expected: prints nothing.

- [ ] **Step 11: Commit**

```bash
git add packages/trace-viewer/src/model/types.ts packages/trace-viewer/src/model/fold-state.ts \
  packages/trace-viewer/src/model/fold-overview.ts packages/trace-viewer/src/model/fold.ts \
  packages/trace-viewer/src/model/component-path.ts packages/trace-viewer/src/model/component-path.test.ts \
  packages/trace-viewer/src/model/overview-status.ts packages/trace-viewer/src/model/overview-status.test.ts \
  packages/trace-viewer/src/model/fold-finalize.ts packages/trace-viewer/src/model/index.ts \
  packages/trace-viewer/src/model/fold-overview.test.ts packages/trace-viewer/src/model/fold.incremental.test.ts \
  packages/trace-viewer/src/test-support/overview-builder.ts packages/trace-viewer/src/test-support/trace-builder.ts \
  packages/trace-viewer/src/test-support/row-arbitraries.ts packages/trace-viewer/src/test-support/session-builder.ts \
  packages/trace-viewer/src/test-support/canvas-arbitraries.ts
git add packages/trace-viewer/src/model/registry.ts   # only if Step 3 changed it
git -c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com commit -m "feat(trace-viewer): fold overview_snapshot rows into TraceSession.overview"
```

### Task P-2: `layoutMap` (pure, sticky) with properties and bench

**Files:**
- Create: `packages/trace-viewer/src/layout/map-layout.ts`
- Create: `packages/trace-viewer/src/test-support/overview-arbitraries.ts`, `packages/trace-viewer/src/test-support/map-checks.ts`
- Test: `packages/trace-viewer/src/layout/map-layout.test.ts`, `packages/trace-viewer/src/layout/map-layout.property.test.ts`
- Bench: `packages/trace-viewer/src/layout/map-layout.bench.ts`

**Interfaces:**
- Consumes: P-1 `OverviewModel`, `buildOverviewModel`, `componentIdForPath`; `overviewSnapshot`, `syntheticOverview`, `componentId`, `type OverviewSeed`, `type ComponentSeed` (test-support); from `@jevcode/contracts`: `type Component`, `type ComponentEdge`, `type Role`, `ROLES`.
- Produces (`src/layout/map-layout.ts`; interfaces §6.6 plus deviations 1 and 2):

```ts
export type MapBand = Role | "side";
export const MAP_BAND_ORDER: readonly MapBand[];                 // ["ui", "api", "agent", "domain", "storage", "side"]
export type MapLevel = "chip" | "card" | "detail";
export interface MapLevelSpec { w: number; h: number; rowGap: number; gutter: number; sideW: number; chips: 0 }
export const MAP_LEVEL_SPECS: { readonly [K in MapLevel]: MapLevelSpec };   // chip = card = detail = { w: 140, h: 76, sideW: 104, rowGap: 16, gutter: 22, chips: 0 }
export const MAP_MARGIN: 16; MAP_BAND_LABEL_H: 44; MAP_LANE_PAD: 6 /* view only */; MAP_SWEEPS: 4;
export function mapLevelForZoom(k: number): MapLevel;            // chip < 0.7 ≤ card < 1.4 ≤ detail
export function mapEdgeWidth(count: number): 1 | 2 | 3;          // ≤ 3 → 1, ≤ 15 → 2, else 3 (px 1, 1.6, 2.4 in the view)
export function bandOf(role: Role): MapBand;                     // tests, tooling, config → "side"
export interface MapCard { id: string; band: MapBand; x: number; y: number; w: number; h: number }
export type MapEdgeKind = "adjacent" | "long" | "same";
export interface MapEdgePath { from: string; to: string; count: number; width: 1 | 2 | 3; d: string; kind: MapEdgeKind }
export interface MapExternalChip { name: string; x: number; y: number; nearComponent: string }   // type kept for interfaces §6.6; layoutMap never fills it
export interface MapBandColumn { band: MapBand; x: number; w: number; count: number }          // w = spec.w, or spec.sideW for "side"
export interface MapLayoutState { orderByBand: ReadonlyMap<string, readonly string[]>; repoRoot: string }
export interface MapLayout { level: MapLevel; cards: readonly MapCard[]; edges: readonly MapEdgePath[]; externals: readonly MapExternalChip[];   // externals is always []
  bands: readonly MapBandColumn[]; bounds: { w: number; h: number }; state: MapLayoutState }
export function layoutMap(overview: OverviewModel, opts: { level: MapLevel }, prev?: MapLayoutState): MapLayout;
export function mapImporterCounts(layoutEdges: readonly MapEdgePath[]): ReadonlyMap<string, number>;       // distinct importers per component (the hub glyph's number)
export function mapHubIds(layoutEdges: readonly MapEdgePath[], componentCount: number): ReadonlySet<string>;  // ≥ max(6, ceil(n / 4)) distinct importers
export function componentForPath(overview: OverviewModel, path: string): string | undefined;
```

- Test-only: `arbOverviewSeed(options?)`, `arbOverviewSuccessor(seed)` (`overview-arbitraries.ts`); `expectNoOverlaps(layout)`, `expectNoCardCrossings(layout)`, `pathPoints(d)` (`map-checks.ts`; it parses `M`, `H`, `V`, `L` and `C`, sampling each cubic at t = 0, 1/8, …, 1).

Rules (spec E12, §8.3; the approved H2 Map mockup), each pinned by a test below:

- **Bands.** One column per non-empty band in `MAP_BAND_ORDER`; empty bands take no space. Every gutter is `spec.gutter` wide, the side band included; the side band's column and cards are `spec.sideW` wide, all others `spec.w`.
- **Order within a band (fresh).** Start by name, then id; then 4 barycenter sweeps (left to right, right to left, …) over the bands with two or more cards. A card's barycenter is the count-weighted mean of its cross-band neighbors' normalized positions (index ÷ (band size − 1)); a card with no cross-band neighbor keeps its position; ties break by name, then id.
- **Stickiness.** With `prev` for the same `repoRoot`, each band starts as `prev`'s order filtered to the components still in that band, and only new components (and those whose role moved them) are inserted, in name-then-id order, at `round(barycenter × band size)` over already placed neighbors, else at the end. A placed card never changes its order relative to another placed card in its band. A different `repoRoot` lays out fresh.
- **One geometry for all levels.** `MAP_LEVEL_SPECS.chip`, `.card` and `.detail` are the same object shape and values (`w` 140, `h` 76, `sideW` 104, `rowGap` 16, `gutter` 22, `chips` 0), so a zoom-level change never moves a card; only the view's card content changes. Card `y = MAP_MARGIN + MAP_BAND_LABEL_H + row × (h + rowGap)`, so every band shares one row pitch and the gap rows line up across bands. `bounds.w = lastColumn.x + lastColumn.w + MAP_MARGIN`; `bounds.h = MAP_MARGIN + MAP_BAND_LABEL_H + rows × (h + rowGap) − rowGap + MAP_MARGIN` (`MAP_MARGIN + MAP_BAND_LABEL_H + MAP_MARGIN` with no cards).
- **Edge normalization and ports.** Self edges, edges to unknown components and duplicate pairs are dropped. For each kept edge `L` is the endpoint with the smaller column (for one column, the smaller row) and `R` the other. A card has one port per side, at the side's vertical center; ports do not spread and no gutter lane is assigned. `y1 = L.y + h/2`, `y2 = R.y + h/2`. Direction is not drawn (the Inspector carries imports in and out). Width is `mapEdgeWidth(count)`; `kind` is `"adjacent"`, `"long"` or `"same"`.
- **Adjacent bands.** `x1 = L.x + L.w`, `x2 = R.x`, `mx = (x1 + x2) / 2`: `M x1 y1 C mx y1 mx y2 x2 y2`, a smooth S-curve inside the gutter (straight when `y1 = y2`).
- **Bands two or more apart.** `b = clamp(y2 ≥ y1 ? L.row + 1 : L.row, 1, rows)` where `rows` is the largest band size; `yc = MAP_MARGIN + MAP_BAND_LABEL_H + b × (h + rowGap) − rowGap / 2` lies in a gap row and is free in every column. With `hh = gutter / 2`, `gx1 = x1 + gutter`, `gx2 = x2 − gutter`: `M x1 y1 C x1+hh y1 x1+hh yc gx1 yc H gx2 C gx2+hh yc gx2+hh y2 x2 y2`. Edges from one card toward the same side share `yc` exactly, which bundles them into one line.
- **Same band.** `load[col] = { left, right }` counts the cross-band edges whose `R` (left) or `L` (right) is in that column; the first column's left and the last column's right are margins with load 0. Use the right side when `load.right ≤ load.left`, else the left; `x0` is that side's x and `bulge = min(gutter / 2 − 2, 4 + 3 × (R.row − L.row))`, `bx = x0 ± bulge`: `M x0 y1 C bx y1 bx y2 x0 y2`.
- **Hubs.** `mapImporterCounts(edges)` counts the distinct importers (`from` ids) of each component; `mapHubIds(edges, n)` returns the components with at least `max(6, ceil(n / 4))` of them (`n` is the card count). The view hides edges into a hub at rest and shows the importer count in the hub glyph.
- **Externals.** `layoutMap` places no chips at any level (`externals: []`). A card shows its top two `externalDeps` at the detail level inside itself (a view concern), and the Inspector lists all of them.
- **Properties (property tests):** no card overlap; no edge crosses a card other than its endpoints (curves are sampled by `pathPoints`); every edge starts and ends on side centers of its two cards; every component appears exactly once; deterministic under shuffled components, edges and externals, with the same `d` and `kind` for every edge; sticky under drops, additions and role changes, and an edge between two cards that keep their positions keeps its adjacent or long path; an unchanged snapshot with `prev` reproduces `prev`'s cards and edges; the hub set is the importer-count rule, whatever the edge order.

- [ ] **Step 1: Write the arbitraries and the shared checks**

Create `packages/trace-viewer/src/test-support/overview-arbitraries.ts`:

```ts
// Test-only: random overview seeds for the Map layout properties. Excluded from the build.
import fc from "fast-check";

import { ROLES, type Role } from "@jevcode/contracts";

import type { ComponentSeed, OverviewSeed } from "./overview-builder.js";

const ROOTS = Array.from({ length: 40 }, (_, index) => `pkg/c${String(index).padStart(2, "0")}`);
/** Few names, so name ties are common and the id tie-break is exercised. */
const NAMES = ["alpha", "beta", "gamma", "delta"] as const;

interface RawComponent { rootPath: string; role: Role; version: number; externals: number; name: string }

const arbComponent: fc.Arbitrary<RawComponent> = fc.record({
  rootPath: fc.constantFrom(...ROOTS),
  role: fc.constantFrom(...ROLES),
  version: fc.nat(2),
  externals: fc.nat(4),
  name: fc.constantFrom(...NAMES),
});

function seedOf(components: readonly RawComponent[], raw: readonly { from: number; to: number; count: number }[]): OverviewSeed {
  const edges: { from: string; to: string; count: number }[] = [];
  const seen = new Set<string>();
  for (const edge of raw) {
    const from = components[edge.from];
    const to = components[edge.to];
    if (from === undefined || to === undefined || from.rootPath === to.rootPath) continue;
    const key = `${from.rootPath}>${to.rootPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from: from.rootPath, to: to.rootPath, count: edge.count });
  }
  const externals = components.flatMap((component, index) =>
    Array.from({ length: component.externals }, (_, k) => ({
      name: `ext-${(index * 7 + k) % 9}`,
      usedBy: [{ rootPath: component.rootPath, count: k + 1 }],
    })),
  );
  return {
    components: components.map(({ rootPath, role, version, name }) => ({ rootPath, role, version, name })),
    edges,
    externals,
  };
}

export function arbOverviewSeed(options: { maxComponents?: number } = {}): fc.Arbitrary<OverviewSeed> {
  const max = options.maxComponents ?? 24;
  return fc.uniqueArray(arbComponent, { maxLength: max, selector: (component) => component.rootPath }).chain((components) => {
    const n = components.length;
    const edges =
      n < 2
        ? fc.constant<{ from: number; to: number; count: number }[]>([])
        : fc.array(fc.record({ from: fc.nat(n - 1), to: fc.nat(n - 1), count: fc.integer({ min: 1, max: 60 }) }), { maxLength: 3 * n });
    return edges.map((raw) => seedOf(components, raw));
  });
}

/** A later snapshot of the same repo: some components dropped, some re-roled (and re-hashed), up to 4 added from unused roots. */
export function arbOverviewSuccessor(seed: OverviewSeed): fc.Arbitrary<OverviewSeed> {
  const used = new Set(seed.components.map((component) => component.rootPath));
  const free = ROOTS.filter((root) => !used.has(root));
  const n = seed.components.length;
  return fc
    .record({
      keep: fc.array(fc.boolean(), { minLength: n, maxLength: n }),
      reRole: fc.array(fc.option(fc.constantFrom(...ROLES), { nil: undefined, freq: 4 }), { minLength: n, maxLength: n }),
      added: fc.subarray(free, { maxLength: 4 }),
      addedRoles: fc.array(fc.constantFrom(...ROLES), { minLength: 4, maxLength: 4 }),
      count: fc.integer({ min: 1, max: 30 }),
    })
    .map(({ keep, reRole, added, addedRoles, count }) => {
      const components: ComponentSeed[] = [];
      seed.components.forEach((component, index) => {
        if (keep[index] === false) return;
        const role = reRole[index];
        components.push(role === undefined ? component : { ...component, role, version: (component.version ?? 0) + 1 });
      });
      added.forEach((rootPath, index) => components.push({ rootPath, role: addedRoles[index] ?? "domain", name: "zeta" }));
      const roots = new Set(components.map((component) => component.rootPath));
      const edges = (seed.edges ?? []).filter((edge) => roots.has(edge.from) && roots.has(edge.to)).map((edge) => ({ ...edge }));
      const anchor = components[0];
      for (const rootPath of added) {
        if (anchor !== undefined && anchor.rootPath !== rootPath) edges.push({ from: rootPath, to: anchor.rootPath, count });
      }
      const externals = (seed.externals ?? []).filter((ext) => ext.usedBy.every((use) => roots.has(use.rootPath)));
      return { ...seed, components, edges, externals };
    });
}
```

Create `packages/trace-viewer/src/test-support/map-checks.ts`:

```ts
// Test-only: geometric checks shared by the Map layout property and fixture tests. Excluded from the build.
import { expect } from "vitest";

import type { MapLayout } from "../layout/map-layout.js";

interface Box { label: string; x: number; y: number; w: number; h: number }

/**
 * The polyline of an edge path made of absolute M, H, V, L and C commands. Each cubic is sampled at t = 0, 1/8, …, 1,
 * so a curve is checked as eight chords; the layout keeps every curve inside a gutter or a gap row, far from a card edge.
 */
export function pathPoints(d: string): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  let x = 0;
  let y = 0;
  for (const match of d.matchAll(/([MHVLC])([^MHVLC]*)/g)) {
    const command = match[1];
    const values = (match[2] ?? "").trim().split(/[\s,]+/).filter((v) => v !== "").map(Number);
    if (command === "C") {
      const [c1x = x, c1y = y, c2x = x, c2y = y, ex = x, ey = y] = values;
      for (let i = 0; i <= 8; i += 1) {
        const t = i / 8;
        const u = 1 - t;
        points.push({
          x: u * u * u * x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ex,
          y: u * u * u * y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ey,
        });
      }
      x = ex;
      y = ey;
      continue;
    }
    if (command === "H") x = values[0] ?? x;
    else if (command === "V") y = values[0] ?? y;
    else {
      x = values[0] ?? x;
      y = values[1] ?? y;
    }
    points.push({ x, y });
  }
  return points;
}

/** True when segment a→b enters the open rectangle `box` shrunk by 0.5 px (Liang–Barsky). */
function segmentEnters(a: { x: number; y: number }, b: { x: number; y: number }, box: Box): boolean {
  const x0 = box.x + 0.5;
  const x1 = box.x + box.w - 0.5;
  const y0 = box.y + 0.5;
  const y1 = box.y + box.h - 0.5;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [[-dx, a.x - x0], [dx, x1 - a.x], [-dy, a.y - y0], [dy, y1 - a.y]] as const) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 > t1) return false;
  }
  return true;
}

export function expectNoOverlaps(layout: MapLayout): void {
  const boxes: Box[] = layout.cards.map((card) => ({ label: `card ${card.id}`, x: card.x, y: card.y, w: card.w, h: card.h }));
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      if (a === undefined || b === undefined) continue;
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      expect(apart, `${a.label} overlaps ${b.label}`).toBe(true);
    }
  }
}

/** No edge, curve or line, passes under a card other than its two endpoints (spec §8.3). */
export function expectNoCardCrossings(layout: MapLayout): void {
  for (const edge of layout.edges) {
    const points = pathPoints(edge.d);
    for (const card of layout.cards) {
      if (card.id === edge.from || card.id === edge.to) continue;
      for (let i = 1; i < points.length; i += 1) {
        const a = points[i - 1];
        const b = points[i];
        if (a === undefined || b === undefined) continue;
        expect(segmentEnters(a, b, { label: card.id, ...card }), `${edge.from}>${edge.to} crosses ${card.id}: ${edge.d}`).toBe(false);
      }
    }
  }
}

/** Every edge starts and ends at the vertical center of a side of its two cards (one port per side, no spreading). */
export function expectEdgesOnPorts(layout: MapLayout): void {
  for (const edge of layout.edges) {
    const ends = [edge.from, edge.to].map((id) => layout.cards.find((card) => card.id === id));
    const points = pathPoints(edge.d);
    for (const point of [points[0], points.at(-1)]) {
      const onPort = ends.some(
        (card) => card !== undefined && point !== undefined && (point.x === card.x || point.x === card.x + card.w) && point.y === card.y + card.h / 2,
      );
      expect(onPort, `${edge.from}>${edge.to} has an end off a port: ${edge.d}`).toBe(true);
    }
  }
}
```

- [ ] **Step 2: Write the failing unit tests**

Create `packages/trace-viewer/src/layout/map-layout.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { buildOverviewModel } from "../model/index.js";
import { componentId, overviewSnapshot, type OverviewSeed } from "../test-support/overview-builder.js";
import {
  MAP_BAND_LABEL_H,
  MAP_LEVEL_SPECS,
  MAP_MARGIN,
  componentForPath,
  layoutMap,
  mapEdgeWidth,
  mapHubIds,
  mapImporterCounts,
  mapLevelForZoom,
  type MapCard,
  type MapEdgePath,
  type MapLayout,
  type MapLayoutState,
} from "./map-layout.js";

// Spec E12 and §8.3 and the approved H2 Map mockup: role bands left to right, barycenter order within a band, sticky
// order, one geometry for every level, smooth edges through gutters and gap rows. The literal paths below are worked by
// hand from the geometry: top = 16 + 44 = 60, row pitch 92, column x = 16, 178, 340, 502, 664 (140 wide, 22 gutters).

const model = (seed: OverviewSeed) => buildOverviewModel(overviewSnapshot(seed), 1);

function card(layout: MapLayout, rootPath: string): MapCard {
  const found = layout.cards.find((item) => item.id === componentId(rootPath));
  if (found === undefined) throw new Error(`no card for ${rootPath}`);
  return found;
}

function edge(layout: MapLayout, from: string, to: string): MapEdgePath {
  const found = layout.edges.find((item) => item.from === componentId(from) && item.to === componentId(to));
  if (found === undefined) throw new Error(`no edge ${from} > ${to}`);
  return found;
}

const order = (layout: MapLayout, band: string): readonly string[] => layout.state.orderByBand.get(band) ?? [];

describe("mapLevelForZoom and mapEdgeWidth", () => {
  it("switches level at 0.7 and 1.4 (spec §8.3)", () => {
    expect([0.2, 0.69, 0.7, 1.39, 1.4, 2].map(mapLevelForZoom)).toEqual(["chip", "chip", "card", "card", "detail", "detail"]);
  });

  it("buckets import counts into 1 to 3 px (spec §3.4)", () => {
    expect([1, 3, 4, 15, 16, 400].map(mapEdgeWidth)).toEqual([1, 1, 2, 2, 3, 3]);
  });
});

describe("layoutMap bands and geometry", () => {
  const all = model({
    components: [
      { rootPath: "apps/web", role: "ui" },
      { rootPath: "srv/api", role: "api" },
      { rootPath: "pkg/agent", role: "agent" },
      { rootPath: "pkg/core", role: "domain" },
      { rootPath: "pkg/db", role: "storage" },
      { rootPath: "tests", role: "tests" },
      { rootPath: "scripts", role: "tooling" },
      { rootPath: ".", name: "config", role: "config" },
    ],
  });

  it("puts the role bands left to right and tests, tooling and config in the side band", () => {
    const layout = layoutMap(all, { level: "card" });
    expect(layout.bands.map((band) => band.band)).toEqual(["ui", "api", "agent", "domain", "storage", "side"]);
    expect(layout.bands.map((band) => band.count)).toEqual([1, 1, 1, 1, 1, 3]);
    const xs = layout.bands.map((band) => band.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    const spec = MAP_LEVEL_SPECS.card;
    const [storage, side] = layout.bands.slice(-2);
    // The side band follows the normal gutter and is narrower; its cards fill it.
    expect((side?.x ?? 0) - ((storage?.x ?? 0) + spec.w)).toBe(spec.gutter);
    expect(side?.w).toBe(spec.sideW);
    expect(card(layout, "tests")).toMatchObject({ band: "side", w: spec.sideW });
    expect(card(layout, "scripts").band).toBe("side");
  });

  it("skips empty bands", () => {
    const layout = layoutMap(model({ components: [{ rootPath: "apps/web", role: "ui" }, { rootPath: "pkg/db", role: "storage" }] }), { level: "card" });
    expect(layout.bands.map((band) => band.band)).toEqual(["ui", "storage"]);
    expect(card(layout, "pkg/db").x - (card(layout, "apps/web").x + MAP_LEVEL_SPECS.card.w)).toBe(MAP_LEVEL_SPECS.card.gutter);
  });

  it("uses one geometry for every level, so a zoom change never moves a card", () => {
    expect(MAP_LEVEL_SPECS.chip).toEqual({ w: 140, h: 76, sideW: 104, rowGap: 16, gutter: 22, chips: 0 });
    expect(MAP_LEVEL_SPECS.card).toEqual(MAP_LEVEL_SPECS.chip);
    expect(MAP_LEVEL_SPECS.detail).toEqual(MAP_LEVEL_SPECS.chip);
    const layouts = (["chip", "card", "detail"] as const).map((level) => layoutMap(all, { level }));
    for (const layout of layouts) {
      expect(layout.cards).toEqual(layouts[0]?.cards);
      expect(layout.bounds).toEqual(layouts[0]?.bounds);
    }
  });

  it("sizes and stacks cards with one row pitch for every band, and bounds that end at the last card", () => {
    for (const level of ["chip", "card", "detail"] as const) {
      const spec = MAP_LEVEL_SPECS[level];
      const layout = layoutMap(model({ components: [{ rootPath: "pkg/a", role: "domain" }, { rootPath: "pkg/b", role: "domain" }] }), { level });
      expect(layout.level).toBe(level);
      const [a, b] = layout.cards;
      expect(a).toMatchObject({ w: spec.w, h: spec.h, x: MAP_MARGIN, y: MAP_MARGIN + MAP_BAND_LABEL_H });
      expect((b?.y ?? 0) - (a?.y ?? 0)).toBe(spec.h + spec.rowGap);
      expect(layout.bounds).toEqual({
        w: MAP_MARGIN + spec.w + MAP_MARGIN,
        h: MAP_MARGIN + MAP_BAND_LABEL_H + 2 * (spec.h + spec.rowGap) - spec.rowGap + MAP_MARGIN,
      });
    }
  });

  it("lays out an empty snapshot as an empty map", () => {
    const layout = layoutMap(model({ components: [] }), { level: "card" });
    expect(layout.cards).toEqual([]);
    expect(layout.bands).toEqual([]);
    expect(layout.bounds).toEqual({ w: 2 * MAP_MARGIN, h: MAP_MARGIN + MAP_BAND_LABEL_H + MAP_MARGIN });
  });
});

describe("layoutMap order within a band", () => {
  it("breaks ties by name, then id", () => {
    const layout = layoutMap(
      model({ components: [{ rootPath: "pkg/c", role: "domain" }, { rootPath: "pkg/a", role: "domain" }, { rootPath: "pkg/b", role: "domain" }] }),
      { level: "card" },
    );
    expect(order(layout, "domain")).toEqual(["pkg/a", "pkg/b", "pkg/c"].map(componentId));
  });

  it("orders by barycenter so crossing edges uncross and run flat", () => {
    // By name: ui [a, b], domain [x, y]; edges a→y and b→x cross. The sweeps give ui [b, a] and domain [x, y].
    const layout = layoutMap(
      model({
        components: [{ rootPath: "apps/a", role: "ui" }, { rootPath: "apps/b", role: "ui" }, { rootPath: "pkg/x", role: "domain" }, { rootPath: "pkg/y", role: "domain" }],
        edges: [{ from: "apps/a", to: "pkg/y", count: 5 }, { from: "apps/b", to: "pkg/x", count: 5 }],
      }),
      { level: "card" },
    );
    expect(order(layout, "ui")).toEqual(["apps/b", "apps/a"].map(componentId));
    expect(order(layout, "domain")).toEqual(["pkg/x", "pkg/y"].map(componentId));
    expect(card(layout, "apps/a").y).toBe(card(layout, "pkg/y").y);
    // Equal port heights give a flat S-curve: M x y C mx y mx y x2 y.
    const flat = /^M[\d.]+ ([\d.]+)C[\d.]+ \1 [\d.]+ \1 [\d.]+ \1$/;
    expect(edge(layout, "apps/a", "pkg/y").d).toMatch(flat);
    expect(edge(layout, "apps/b", "pkg/x").d).toMatch(flat);
  });
});

describe("layoutMap edge routes", () => {
  const spec = MAP_LEVEL_SPECS.card;
  const FIVE = [
    { rootPath: "apps/web", role: "ui" },
    { rootPath: "srv/api", role: "api" },
    { rootPath: "pkg/agent", role: "agent" },
    { rootPath: "pkg/core", role: "domain" },
    { rootPath: "pkg/db", role: "storage" },
  ] as const;

  it("routes an adjacent-band edge as one smooth S-curve in the gutter", () => {
    const layout = layoutMap(
      model({
        components: [{ rootPath: "apps/web", role: "ui" }, { rootPath: "srv/a", role: "api" }, { rootPath: "srv/b", role: "api" }],
        edges: [{ from: "apps/web", to: "srv/b", count: 2 }],
      }),
      { level: "card" },
    );
    const route = edge(layout, "apps/web", "srv/b");
    // web: x 16..156, y 60..136 (port y 98); srv/b: x 178, row 1, y 152..228 (port y 190); mx = (156 + 178) / 2.
    expect(route.d).toBe("M156 98C167 98 167 190 178 190");
    expect(route.kind).toBe("adjacent");
    expect(route.width).toBe(1);
  });

  it("routes an edge between bands two or more apart through the gap row below its source", () => {
    const layout = layoutMap(model({ components: [...FIVE], edges: [{ from: "apps/web", to: "pkg/db", count: 20 }] }), { level: "card" });
    const web = card(layout, "apps/web");
    const route = edge(layout, "apps/web", "pkg/db");
    expect(route.kind).toBe("long");
    expect(route.width).toBe(3);
    // The gap row below row 0 is y 136..152; its center 144 = 60 + 92 − 16 / 2. gx1 = 156 + 22, gx2 = 664 − 22.
    expect(route.d).toBe("M156 98C167 98 167 144 178 144H642C653 144 653 98 664 98");
    expect(144).toBeGreaterThan(web.y + web.h);
    expect(144).toBeLessThan(web.y + web.h + spec.rowGap);
  });

  it("uses the gap row above the source when the target is higher", () => {
    const layout = layoutMap(
      model({
        components: [
          { rootPath: "apps/u1", role: "ui" },
          { rootPath: "apps/u2", role: "ui" },
          { rootPath: "srv/x", role: "api" },
          { rootPath: "pkg/s", role: "storage" },
          { rootPath: "pkg/t", role: "storage" },
        ],
        edges: [{ from: "apps/u2", to: "pkg/s", count: 5 }, { from: "apps/u2", to: "pkg/t", count: 5 }],
      }),
      { level: "card" },
    );
    // u2 is row 1 (port y 190). Toward s (row 0, port y 98) the channel is the gap above row 1: 60 + 92 − 8 = 144.
    // Toward t (row 1, port y 190) it is the gap below row 1: 60 + 2 × 92 − 8 = 236.
    expect(edge(layout, "apps/u2", "pkg/s").d).toBe("M156 190C167 190 167 144 178 144H318C329 144 329 98 340 98");
    expect(edge(layout, "apps/u2", "pkg/t").d).toBe("M156 190C167 190 167 236 178 236H318C329 236 329 190 340 190");
  });

  it("bundles the edges that leave one card toward the same side onto one channel", () => {
    const layout = layoutMap(
      model({
        components: [{ rootPath: "apps/u", role: "ui" }, { rootPath: "srv/x", role: "api" }, { rootPath: "pkg/s", role: "storage" }, { rootPath: "pkg/t", role: "storage" }],
        edges: [{ from: "apps/u", to: "pkg/s", count: 1 }, { from: "apps/u", to: "pkg/t", count: 1 }],
      }),
      { level: "card" },
    );
    // Both targets are at or below u's port, so both use the gap below row 0 (y 144) and overlap from gx1 to gx2.
    expect(edge(layout, "apps/u", "pkg/s").d).toBe("M156 98C167 98 167 144 178 144H318C329 144 329 98 340 98");
    expect(edge(layout, "apps/u", "pkg/t").d).toBe("M156 98C167 98 167 144 178 144H318C329 144 329 190 340 190");
  });

  it("routes a same-band edge as a shallow bulge on the less loaded side", () => {
    const layout = layoutMap(
      model({ components: [{ rootPath: "pkg/a", role: "domain" }, { rootPath: "pkg/b", role: "domain" }], edges: [{ from: "pkg/a", to: "pkg/b", count: 1 }] }),
      { level: "card" },
    );
    // No cross-band edges: the loads tie and the right side wins. bulge = min(11 − 2, 4 + 3 × 1) = 7.
    expect(edge(layout, "pkg/a", "pkg/b")).toMatchObject({ kind: "same", d: "M156 98C163 98 163 190 156 190" });
    const loaded = layoutMap(
      model({
        components: [{ rootPath: "pkg/a", role: "domain" }, { rootPath: "pkg/b", role: "domain" }, { rootPath: "pkg/db", role: "storage" }],
        edges: [{ from: "pkg/a", to: "pkg/b", count: 1 }, { from: "pkg/a", to: "pkg/db", count: 1 }],
      }),
      { level: "card" },
    );
    // The edge to storage already leaves a's right side, so the same-band edge takes the left (the margin).
    expect(edge(loaded, "pkg/a", "pkg/b").d).toBe("M16 98C9 98 9 190 16 190");
  });

  it("draws the same path whichever way the import points", () => {
    const forward = layoutMap(model({ components: [...FIVE], edges: [{ from: "apps/web", to: "pkg/db", count: 2 }] }), { level: "card" });
    const backward = layoutMap(model({ components: [...FIVE], edges: [{ from: "pkg/db", to: "apps/web", count: 2 }] }), { level: "card" });
    expect(edge(forward, "apps/web", "pkg/db").d).toBe(edge(backward, "pkg/db", "apps/web").d);
  });

  it("drops self edges, edges to unknown components and duplicate pairs", () => {
    const snapshot = overviewSnapshot({
      components: [{ rootPath: "apps/web", role: "ui" }, { rootPath: "pkg/db", role: "storage" }],
      edges: [{ from: "apps/web", to: "pkg/db", count: 4 }],
    });
    const noisy = {
      ...snapshot,
      edges: [
        ...snapshot.edges,
        { from: componentId("apps/web"), to: componentId("apps/web"), count: 9, examples: [] },
        { from: componentId("apps/web"), to: "cmp_000000000000", count: 9, examples: [] },
        { from: componentId("apps/web"), to: componentId("pkg/db"), count: 2, examples: [] },
      ],
    };
    const layout = layoutMap(buildOverviewModel(noisy, 1), { level: "card" });
    expect(layout.edges.map((item) => [item.from, item.to, item.count])).toEqual([[componentId("apps/web"), componentId("pkg/db"), 4]]);
  });
});

describe("mapHubIds (a hub is imported by at least max(6, ceil(n / 4)) components)", () => {
  const importers = (to: string, count: number): MapEdgePath[] =>
    Array.from({ length: count }, (_, i) => ({ from: `cmp_${String(i).padStart(12, "0")}`, to, count: 1, width: 1 as const, d: "", kind: "adjacent" as const }));

  it("uses the floor of 6 for a small map", () => {
    expect([...mapHubIds([...importers("hub", 6), ...importers("near", 5)], 21)]).toEqual(["hub"]);
  });

  it("grows with the component count", () => {
    // n = 40 needs 10 importers; n = 200 needs 50.
    expect(mapHubIds(importers("hub", 9), 40).size).toBe(0);
    expect(mapHubIds(importers("hub", 10), 40).size).toBe(1);
    expect(mapHubIds(importers("hub", 49), 200).size).toBe(0);
    expect(mapHubIds(importers("hub", 50), 200).size).toBe(1);
  });

  it("counts distinct importers, not edges", () => {
    expect(mapHubIds([...importers("hub", 5), ...importers("hub", 5)], 21).size).toBe(0);
    expect(mapImporterCounts([...importers("hub", 5), ...importers("hub", 5), ...importers("other", 2)])).toEqual(new Map([["hub", 5], ["other", 2]]));
  });
});

describe("layoutMap externals", () => {
  it("places no chips at any level; packages show inside detail cards and in the Inspector", () => {
    const seed: OverviewSeed = {
      components: [{ rootPath: "apps/web", role: "ui" }, { rootPath: "pkg/db", role: "storage" }],
      externals: [{ name: "react", usedBy: [{ rootPath: "apps/web", count: 12 }] }],
    };
    for (const level of ["chip", "card", "detail"] as const) expect(layoutMap(model(seed), { level }).externals).toEqual([]);
  });
});

describe("layoutMap stickiness (spec §8.3)", () => {
  const domain = (names: string[]) => names.map((name) => ({ rootPath: `pkg/${name}`, role: "domain" as const }));
  const prevOf = (repoRoot: string, bands: Record<string, string[]>): MapLayoutState => ({
    repoRoot,
    orderByBand: new Map(Object.entries(bands).map(([band, roots]) => [band, roots.map(componentId)])),
  });

  it("keeps the previous order and appends a new component with no placed neighbor", () => {
    const prev = prevOf("/repo", { domain: ["pkg/d3", "pkg/d1", "pkg/d2"] });
    const layout = layoutMap(model({ components: domain(["d0", "d1", "d2", "d3"]) }), { level: "card" }, prev);
    expect(order(layout, "domain")).toEqual(["pkg/d3", "pkg/d1", "pkg/d2", "pkg/d0"].map(componentId));
  });

  it("inserts a new component at its barycenter over placed neighbors", () => {
    const prev = prevOf("/repo", { ui: ["apps/u"], domain: ["pkg/d3", "pkg/d1", "pkg/d2"] });
    const layout = layoutMap(
      model({ components: [{ rootPath: "apps/u", role: "ui" }, ...domain(["d1", "d2", "d3", "d4"])], edges: [{ from: "apps/u", to: "pkg/d4", count: 2 }] }),
      { level: "card" },
      prev,
    );
    expect(order(layout, "domain")).toEqual(["pkg/d4", "pkg/d3", "pkg/d1", "pkg/d2"].map(componentId));
  });

  it("moves a re-roled component to its new band and keeps the others' order", () => {
    const prev = prevOf("/repo", { domain: ["pkg/d3", "pkg/d1", "pkg/d2"] });
    const layout = layoutMap(
      model({ components: [{ rootPath: "pkg/d1", role: "domain" }, { rootPath: "pkg/d2", role: "storage" }, { rootPath: "pkg/d3", role: "domain" }] }),
      { level: "card" },
      prev,
    );
    expect(order(layout, "domain")).toEqual(["pkg/d3", "pkg/d1"].map(componentId));
    expect(order(layout, "storage")).toEqual([componentId("pkg/d2")]);
  });

  it("lays out fresh for another repo", () => {
    const prev = prevOf("/other", { domain: ["pkg/d3", "pkg/d1", "pkg/d2"] });
    const layout = layoutMap(model({ components: domain(["d1", "d2", "d3"]) }), { level: "card" }, prev);
    expect(order(layout, "domain")).toEqual(["pkg/d1", "pkg/d2", "pkg/d3"].map(componentId));
    expect(layout.state.repoRoot).toBe("/repo");
  });
});

describe("componentForPath", () => {
  const overview = model({
    repoRoot: "/work/repo",
    components: [{ rootPath: "packages/viewer" }, { rootPath: "packages/viewer/src/ui" }, { rootPath: "." , name: "config" }],
  });

  it("picks the longest root, strips the repo root and './', and falls back to '.'", () => {
    expect(componentForPath(overview, "packages/viewer/src/ui/Map.tsx")).toBe(componentId("packages/viewer/src/ui"));
    expect(componentForPath(overview, "/work/repo/packages/viewer/src/model/fold.ts")).toBe(componentId("packages/viewer"));
    expect(componentForPath(overview, "./packages/viewer/package.json")).toBe(componentId("packages/viewer"));
    expect(componentForPath(overview, "tsconfig.json")).toBe(componentId("."));
    expect(componentForPath(model({ components: [{ rootPath: "packages/viewer" }] }), "docs/a.md")).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the unit tests to verify they fail**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/map-layout.test.ts`

Expected: FAIL to load with `Cannot find module './map-layout.js'` (`Tests  no tests`).

- [ ] **Step 4: Write `map-layout.ts`**

Create `packages/trace-viewer/src/layout/map-layout.ts`:

```ts
// Map layout (spec E12, §8.3): pure, React-free and clock-free. Role bands are columns left to right; a band's order
// comes from a barycenter heuristic (4 sweeps, tie-break by name then id) and stays sticky across snapshots of the same
// repo; cards have one fixed size for every zoom level; edges are smooth curves through band gutters and the gap rows
// between cards, so no edge crosses a card other than its endpoints.
import type { Component, ComponentEdge, Role } from "@jevcode/contracts";

import { componentIdForPath, type OverviewModel } from "../model/index.js";

export type MapBand = Role | "side";
export const MAP_BAND_ORDER: readonly MapBand[] = ["ui", "api", "agent", "domain", "storage", "side"];
const SIDE_ROLES: ReadonlySet<Role> = new Set<Role>(["tests", "tooling", "config"]);

export type MapLevel = "chip" | "card" | "detail";

export interface MapLevelSpec {
  w: number;
  h: number;
  /** Space between cards of a column; its center line is the channel long edges run along. */
  rowGap: number;
  /** Width of every gutter between bands, the side band's included. */
  gutter: number;
  /** Width of the side band (tests, tooling, config); it follows the normal gutter. */
  sideW: number;
  /** Package chips beside cards: none at any level (packages show inside detail-level cards). */
  chips: 0;
}

/**
 * World px (approved at gate H2, revised Map mockup). One geometry serves every level, so zooming never moves a card;
 * only the card's content changes with the level.
 */
const GEOMETRY: MapLevelSpec = { w: 140, h: 76, sideW: 104, rowGap: 16, gutter: 22, chips: 0 };
export const MAP_LEVEL_SPECS: { readonly [K in MapLevel]: MapLevelSpec } = { chip: GEOMETRY, card: GEOMETRY, detail: GEOMETRY };
export const MAP_MARGIN = 16;
export const MAP_BAND_LABEL_H = 44;
/** The lane background extends this far beyond a band's cards; used by the view only. */
export const MAP_LANE_PAD = 6;
export const MAP_SWEEPS = 4;

/** Spec §8.3 zoom bands: chip below 0.7, card from 0.7 to below 1.4, detail from 1.4. */
export function mapLevelForZoom(k: number): MapLevel {
  return k < 0.7 ? "chip" : k < 1.4 ? "card" : "detail";
}

/** Spec §3.4: edge width follows the import count in 1 to 3 px buckets. */
export function mapEdgeWidth(count: number): 1 | 2 | 3 {
  return count <= 3 ? 1 : count <= 15 ? 2 : 3;
}

export function bandOf(role: Role): MapBand {
  return SIDE_ROLES.has(role) ? "side" : role;
}

export interface MapCard { id: string; band: MapBand; x: number; y: number; w: number; h: number }
/** `adjacent`: neighboring bands; `long`: two or more bands apart (gap channel); `same`: one band. Additive to interfaces §6.6. */
export type MapEdgeKind = "adjacent" | "long" | "same";
export interface MapEdgePath { from: string; to: string; count: number; width: 1 | 2 | 3; d: string; kind: MapEdgeKind }
/** The interfaces' external type; layoutMap never fills it (spec alignment note 5). */
export interface MapExternalChip { name: string; x: number; y: number; nearComponent: string }
export interface MapBandColumn { band: MapBand; x: number; w: number; count: number }
export interface MapLayoutState { orderByBand: ReadonlyMap<string, readonly string[]>; repoRoot: string }
export interface MapLayout {
  level: MapLevel;
  /** Band order, then row. */
  cards: readonly MapCard[];
  /** Sorted by `from>to`. */
  edges: readonly MapEdgePath[];
  /** Always empty: packages show inside detail-level cards and in the Inspector. */
  externals: readonly MapExternalChip[];
  /** Non-empty bands, left to right. */
  bands: readonly MapBandColumn[];
  bounds: { w: number; h: number };
  state: MapLayoutState;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byNameThenId = (a: Component, b: Component): number => cmp(a.name, b.name) || cmp(a.id, b.id);

interface Neighbor { id: string; w: number }

interface Graph {
  comps: ReadonlyMap<string, Component>;
  band: ReadonlyMap<string, MapBand>;
  /** Cross-band neighbors with count weights, sorted by id (float sums stay deterministic). */
  neighbors: ReadonlyMap<string, readonly Neighbor[]>;
  /** Kept edges, sorted by key. */
  edges: readonly ComponentEdge[];
}

function buildGraph(overview: OverviewModel): Graph {
  const comps = new Map<string, Component>();
  const sorted = [...overview.snapshot.components].sort(
    (a, b) => cmp(a.id, b.id) || byNameThenId(a, b) || cmp(a.contentHash, b.contentHash),
  );
  for (const component of sorted) if (!comps.has(component.id)) comps.set(component.id, component);
  const band = new Map<string, MapBand>();
  for (const component of comps.values()) band.set(component.id, bandOf(component.role));
  const edges: ComponentEdge[] = [];
  const raw = [...overview.snapshot.edges].sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to) || b.count - a.count);
  for (const edge of raw) {
    if (edge.from === edge.to || !comps.has(edge.from) || !comps.has(edge.to)) continue;
    const last = edges.at(-1);
    if (last !== undefined && last.from === edge.from && last.to === edge.to) continue; // a duplicate pair keeps its largest count
    edges.push(edge);
  }
  const neighbors = new Map<string, Neighbor[]>();
  const add = (from: string, to: string, w: number): void => {
    const list = neighbors.get(from);
    if (list === undefined) neighbors.set(from, [{ id: to, w }]);
    else list.push({ id: to, w });
  };
  for (const edge of edges) {
    if (band.get(edge.from) === band.get(edge.to)) continue;
    add(edge.from, edge.to, edge.count);
    add(edge.to, edge.from, edge.count);
  }
  for (const list of neighbors.values()) list.sort((a, b) => cmp(a.id, b.id) || a.w - b.w);
  return { comps, band, neighbors, edges };
}

type Order = Map<MapBand, string[]>;

function emptyOrder(): Order {
  return new Map(MAP_BAND_ORDER.map((band) => [band, [] as string[]]));
}

function listOf(order: Order, band: MapBand): string[] {
  let list = order.get(band);
  if (list === undefined) {
    list = [];
    order.set(band, list);
  }
  return list;
}

function bandOfId(graph: Graph, id: string): MapBand {
  return graph.band.get(id) ?? "domain";
}

/** Normalized positions: index ÷ (size − 1), so bands of different sizes compare. */
function setPositions(list: readonly string[], pos: Map<string, number>): void {
  const span = Math.max(1, list.length - 1);
  list.forEach((id, index) => pos.set(id, index / span));
}

function barycenter(id: string, graph: Graph, pos: ReadonlyMap<string, number>): number | null {
  let sum = 0;
  let weight = 0;
  for (const neighbor of graph.neighbors.get(id) ?? []) {
    const p = pos.get(neighbor.id);
    if (p === undefined) continue;
    sum += p * neighbor.w;
    weight += neighbor.w;
  }
  return weight > 0 ? sum / weight : null;
}

function freshOrder(graph: Graph): Order {
  const order = emptyOrder();
  for (const component of [...graph.comps.values()].sort(byNameThenId)) listOf(order, bandOfId(graph, component.id)).push(component.id);
  const pos = new Map<string, number>();
  for (const list of order.values()) setPositions(list, pos);
  const bands = MAP_BAND_ORDER.filter((band) => listOf(order, band).length > 1);
  for (let sweep = 0; sweep < MAP_SWEEPS; sweep += 1) {
    const pass = sweep % 2 === 0 ? bands : [...bands].reverse();
    for (const band of pass) {
      const keyed = listOf(order, band).map((id) => ({ id, bc: barycenter(id, graph, pos) ?? pos.get(id) ?? 0, comp: graph.comps.get(id) }));
      keyed.sort((a, b) => a.bc - b.bc || (a.comp !== undefined && b.comp !== undefined ? byNameThenId(a.comp, b.comp) : cmp(a.id, b.id)));
      const next = keyed.map((item) => item.id);
      order.set(band, next);
      setPositions(next, pos);
    }
  }
  return order;
}

function stickyOrder(graph: Graph, prev: MapLayoutState): Order {
  const order = emptyOrder();
  const placed = new Set<string>();
  for (const band of MAP_BAND_ORDER) {
    const kept: string[] = [];
    for (const id of prev.orderByBand.get(band) ?? []) {
      if (graph.band.get(id) !== band || placed.has(id)) continue;
      kept.push(id);
      placed.add(id);
    }
    order.set(band, kept);
  }
  const pending = [...graph.comps.values()].filter((component) => !placed.has(component.id)).sort(byNameThenId);
  if (pending.length === 0) return order;
  const pos = new Map<string, number>();
  for (const list of order.values()) setPositions(list, pos);
  for (const component of pending) {
    const list = listOf(order, bandOfId(graph, component.id));
    const bc = barycenter(component.id, graph, pos);
    const at = bc === null ? list.length : Math.min(list.length, Math.max(0, Math.round(bc * list.length)));
    list.splice(at, 0, component.id);
    setPositions(list, pos);
  }
  return order;
}

interface Placed { card: MapCard; col: number; row: number }

/**
 * Smooth routes (revised Map mockup; spec §8.3). One port per card side, at its vertical center. Adjacent bands: one
 * S-curve in the gutter. Bands two or more apart: leave into the gutter, run along the gap row between cards (all bands
 * share one row pitch, so it is free in every column), come back through the gutter before the target. Same band: a
 * shallow bulge on the less loaded side. Edges leaving one card toward one side at one channel share it exactly.
 * No lane assignment, spreading or per-edge string keys: each edge is O(1) after one pass over the edges for loads.
 */
function routeEdges(graph: Graph, placed: ReadonlyMap<string, Placed>, bands: readonly MapBandColumn[], spec: MapLevelSpec, top: number, rows: number): MapEdgePath[] {
  // graph.edges is sorted by (from, to); component ids have one fixed length, so this is also edge-key order.
  interface Normalized { edge: ComponentEdge; l: Placed; r: Placed }
  const load = bands.map(() => ({ left: 0, right: 0 }));
  const normalized: Normalized[] = [];
  for (const edge of graph.edges) {
    const a = placed.get(edge.from);
    const b = placed.get(edge.to);
    if (a === undefined || b === undefined) continue;
    const swap = b.col < a.col || (b.col === a.col && b.row < a.row);
    const l = swap ? b : a;
    const r = swap ? a : b;
    normalized.push({ edge, l, r });
    if (l.col === r.col) continue;
    const right = load[l.col];
    const left = load[r.col];
    if (right !== undefined) right.right += 1;
    if (left !== undefined) left.left += 1;
  }
  const pitch = spec.h + spec.rowGap;
  const hh = spec.gutter / 2;
  return normalized.map(({ edge, l, r }) => {
    const y1 = l.card.y + l.card.h / 2;
    const y2 = r.card.y + r.card.h / 2;
    const kind: MapEdgeKind = l.col === r.col ? "same" : r.col - l.col === 1 ? "adjacent" : "long";
    let d: string;
    if (kind === "same") {
      const use = load[l.col];
      const right = use === undefined || use.right <= use.left;
      const x0 = right ? l.card.x + l.card.w : l.card.x;
      const bulge = Math.min(hh - 2, 4 + 3 * (r.row - l.row));
      const bx = right ? x0 + bulge : x0 - bulge;
      d = `M${x0} ${y1}C${bx} ${y1} ${bx} ${y2} ${x0} ${y2}`;
    } else {
      const x1 = l.card.x + l.card.w;
      const x2 = r.card.x;
      if (kind === "adjacent") {
        const mx = (x1 + x2) / 2;
        d = `M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
      } else {
        const b = Math.max(1, Math.min(rows, y2 >= y1 ? l.row + 1 : l.row));
        const yc = top + b * pitch - spec.rowGap / 2;
        const gx1 = x1 + spec.gutter;
        const gx2 = x2 - spec.gutter;
        d = `M${x1} ${y1}C${x1 + hh} ${y1} ${x1 + hh} ${yc} ${gx1} ${yc}H${gx2}C${gx2 + hh} ${yc} ${gx2 + hh} ${y2} ${x2} ${y2}`;
      }
    }
    return { from: edge.from, to: edge.to, count: edge.count, width: mapEdgeWidth(edge.count), d, kind };
  });
}

/** Distinct importers per component: `edge.from` imports `edge.to`. Layout edges are already de-duplicated, but a set keeps this safe for any list. */
export function mapImporterCounts(layoutEdges: readonly MapEdgePath[]): ReadonlyMap<string, number> {
  const importers = new Map<string, Set<string>>();
  for (const edge of layoutEdges) {
    const set = importers.get(edge.to);
    if (set === undefined) importers.set(edge.to, new Set([edge.from]));
    else set.add(edge.from);
  }
  return new Map([...importers].map(([id, set]) => [id, set.size] as const));
}

/** A hub (revised Map mockup) is imported by at least max(6, ceil(n / 4)) distinct components; the view hides edges into it at rest. */
export function mapHubIds(layoutEdges: readonly MapEdgePath[], componentCount: number): ReadonlySet<string> {
  const threshold = Math.max(6, Math.ceil(componentCount / 4));
  const hubs = new Set<string>();
  for (const [id, count] of mapImporterCounts(layoutEdges)) if (count >= threshold) hubs.add(id);
  return hubs;
}

export function layoutMap(overview: OverviewModel, opts: { level: MapLevel }, prev?: MapLayoutState): MapLayout {
  const spec = MAP_LEVEL_SPECS[opts.level];
  const graph = buildGraph(overview);
  const repoRoot = overview.snapshot.repoRoot;
  const order = prev !== undefined && prev.repoRoot === repoRoot ? stickyOrder(graph, prev) : freshOrder(graph);
  const top = MAP_MARGIN + MAP_BAND_LABEL_H;
  const pitch = spec.h + spec.rowGap;
  const bands: MapBandColumn[] = [];
  const cards: MapCard[] = [];
  const placed = new Map<string, Placed>();
  let x = MAP_MARGIN;
  let rows = 0;
  for (const band of MAP_BAND_ORDER) {
    const ids = listOf(order, band);
    if (ids.length === 0) continue;
    if (bands.length > 0) x += spec.gutter;
    const col = bands.length;
    const w = band === "side" ? spec.sideW : spec.w;
    bands.push({ band, x, w, count: ids.length });
    ids.forEach((id, row) => {
      const card: MapCard = { id, band, x, y: top + row * pitch, w, h: spec.h };
      cards.push(card);
      placed.set(id, { card, col, row });
    });
    rows = Math.max(rows, ids.length);
    x += w;
  }
  const last = bands.at(-1);
  return {
    level: opts.level,
    cards,
    edges: routeEdges(graph, placed, bands, spec, top, rows),
    externals: [],
    bands,
    bounds: { w: last === undefined ? 2 * MAP_MARGIN : last.x + last.w + MAP_MARGIN, h: top + Math.max(0, rows * pitch - spec.rowGap) + MAP_MARGIN },
    state: { orderByBand: new Map(MAP_BAND_ORDER.map((band) => [band, [...listOf(order, band)]] as const)), repoRoot },
  };
}

/**
 * The component a repo path belongs to: strips the repo root and "./", then applies the model's one path rule
 * (componentIdForPath, ruling R6: listed file, then longest root, then "."). Entity paths may be absolute.
 */
export function componentForPath(overview: OverviewModel, path: string): string | undefined {
  const repoPrefix = `${overview.snapshot.repoRoot.replace(/\/+$/, "")}/`;
  let relative = path.startsWith(repoPrefix) ? path.slice(repoPrefix.length) : path;
  while (relative.startsWith("./")) relative = relative.slice(2);
  return componentIdForPath(overview.snapshot.components, relative) ?? undefined;
}
```

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/map-layout.test.ts`

Expected: PASS, every test.

- [ ] **Step 6: Write the property tests**

Create `packages/trace-viewer/src/layout/map-layout.property.test.ts`:

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { OverviewSnapshot } from "@jevcode/contracts";

import { buildOverviewModel } from "../model/index.js";
import { expectEdgesOnPorts, expectNoCardCrossings, expectNoOverlaps, pathPoints as pathPointsOf } from "../test-support/map-checks.js";
import { arbOverviewSeed, arbOverviewSuccessor } from "../test-support/overview-arbitraries.js";
import { overviewSnapshot } from "../test-support/overview-builder.js";
import { MAP_BAND_ORDER, layoutMap, mapEdgeWidth, mapHubIds, mapLevelForZoom, type MapLevel } from "./map-layout.js";

// Spec §8.3 properties: no card overlap, edges never pass under a card other than their endpoints (curves included),
// sticky under append, deterministic for equal input (cards, paths and kinds), the zoom bands and the hub rule.

const LEVELS = fc.constantFrom<MapLevel>("chip", "card", "detail");
const LEVEL_RANK: Readonly<Record<MapLevel, number>> = { chip: 0, card: 1, detail: 2 };
const RUNS = { numRuns: 150 };

function shuffled<T>(items: readonly T[], salt: number): T[] {
  const out = [...items];
  let state = (salt >>> 0) || 1;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

const model = (snapshot: OverviewSnapshot) => buildOverviewModel(snapshot, 1);

describe("layoutMap properties", () => {
  it("is deterministic under shuffled components, edges and externals", () => {
    fc.assert(
      fc.property(arbOverviewSeed(), LEVELS, fc.nat(), (seed, level, salt) => {
        const snapshot = overviewSnapshot(seed);
        const reordered: OverviewSnapshot = {
          ...snapshot,
          components: shuffled(snapshot.components, salt),
          edges: shuffled(snapshot.edges, salt + 1),
          externals: shuffled(snapshot.externals, salt + 2),
        };
        expect(layoutMap(model(reordered), { level })).toEqual(layoutMap(model(snapshot), { level }));
      }),
      RUNS,
    );
  });

  it("places every component exactly once, with no card overlap, every edge on its ports and no edge under a card", () => {
    fc.assert(
      fc.property(arbOverviewSeed(), LEVELS, (seed, level) => {
        const snapshot = overviewSnapshot(seed);
        const layout = layoutMap(model(snapshot), { level });
        expect(layout.cards.map((card) => card.id).sort()).toEqual([...new Set(snapshot.components.map((component) => component.id))].sort());
        expect(layout.externals).toEqual([]);
        expectNoOverlaps(layout);
        expectEdgesOnPorts(layout);
        expectNoCardCrossings(layout);
        for (const edge of layout.edges) expect(edge.width).toBe(mapEdgeWidth(edge.count));
      }),
      RUNS,
    );
  });

  it("uses one geometry at every level: cards and bounds do not depend on the level", () => {
    fc.assert(
      fc.property(arbOverviewSeed(), (seed) => {
        const overview = model(overviewSnapshot(seed));
        const [chip, card, detail] = (["chip", "card", "detail"] as const).map((level) => layoutMap(overview, { level }));
        expect(card?.cards).toEqual(chip?.cards);
        expect(detail?.cards).toEqual(chip?.cards);
        expect(detail?.edges.map((edge) => edge.d)).toEqual(chip?.edges.map((edge) => edge.d));
        expect(detail?.bounds).toEqual(chip?.bounds);
      }),
      RUNS,
    );
  });

  it("classifies edges by band distance and keeps every curve inside the bounds", () => {
    fc.assert(
      fc.property(arbOverviewSeed(), LEVELS, (seed, level) => {
        const layout = layoutMap(model(overviewSnapshot(seed)), { level });
        const column = new Map(layout.cards.map((card) => [card.id, layout.bands.findIndex((band) => band.band === card.band)] as const));
        for (const edge of layout.edges) {
          const gap = Math.abs((column.get(edge.to) ?? 0) - (column.get(edge.from) ?? 0));
          expect(edge.kind).toBe(gap === 0 ? "same" : gap === 1 ? "adjacent" : "long");
          for (const point of pathPointsOf(edge.d)) {
            expect(point.x).toBeGreaterThanOrEqual(0);
            expect(point.x).toBeLessThanOrEqual(layout.bounds.w);
            expect(point.y).toBeGreaterThanOrEqual(0);
            expect(point.y).toBeLessThanOrEqual(layout.bounds.h);
          }
        }
      }),
      RUNS,
    );
  });

  it("the zoom bands are monotone: a higher zoom never picks a less detailed level", () => {
    fc.assert(
      fc.property(fc.double({ min: 0.05, max: 3, noNaN: true }), fc.double({ min: 0.05, max: 3, noNaN: true }), (a, b) => {
        const [low, high] = a <= b ? [a, b] : [b, a];
        expect(LEVEL_RANK[mapLevelForZoom(low)]).toBeLessThanOrEqual(LEVEL_RANK[mapLevelForZoom(high)]);
      }),
      RUNS,
    );
  });

  it("a hub is a component with at least max(6, ceil(n / 4)) distinct importers, whatever the edge order", () => {
    fc.assert(
      fc.property(arbOverviewSeed({ maxComponents: 30 }), fc.nat(), (seed, salt) => {
        const snapshot = overviewSnapshot(seed);
        const layout = layoutMap(model(snapshot), { level: "card" });
        const n = layout.cards.length;
        const importers = new Map<string, Set<string>>();
        for (const edge of layout.edges) importers.set(edge.to, (importers.get(edge.to) ?? new Set<string>()).add(edge.from));
        const expected = [...importers].filter(([, from]) => from.size >= Math.max(6, Math.ceil(n / 4))).map(([id]) => id).sort();
        expect([...mapHubIds(layout.edges, n)].sort()).toEqual(expected);
        expect([...mapHubIds(shuffled(layout.edges, salt), n)].sort()).toEqual(expected);
      }),
      RUNS,
    );
  });

  it("is sticky: placed components keep their relative order within a band", () => {
    fc.assert(
      fc.property(
        arbOverviewSeed().chain((seed) => fc.tuple(fc.constant(seed), arbOverviewSuccessor(seed))),
        LEVELS,
        ([before, after], level) => {
          const first = layoutMap(model(overviewSnapshot(before)), { level });
          const second = layoutMap(model(overviewSnapshot(after)), { level }, first.state);
          for (const band of MAP_BAND_ORDER) {
            const old = first.state.orderByBand.get(band) ?? [];
            const now = second.state.orderByBand.get(band) ?? [];
            const kept = now.filter((id) => old.includes(id));
            expect(kept).toEqual(old.filter((id) => kept.includes(id)));
          }
          expectNoOverlaps(second);
          expectNoCardCrossings(second);
          // Routing is a function of card positions, so an adjacent or long edge between two cards that kept their
          // positions keeps its path (same-band bulges depend on the loads and may switch sides).
          const at = (layout: typeof first, id: string) => layout.cards.find((card) => card.id === id);
          for (const edge of second.edges) {
            if (edge.kind === "same") continue;
            const old = first.edges.find((item) => item.from === edge.from && item.to === edge.to);
            if (old === undefined || old.kind === "same") continue;
            const keeps = [edge.from, edge.to].every((id) => {
              const a = at(first, id);
              const b = at(second, id);
              return a !== undefined && b !== undefined && a.x === b.x && a.y === b.y;
            });
            if (keeps) expect(edge.d).toBe(old.d);
          }
        },
      ),
      RUNS,
    );
  });

  it("an unchanged snapshot laid out with its own state reproduces its cards and edges", () => {
    fc.assert(
      fc.property(arbOverviewSeed(), LEVELS, (seed, level) => {
        const overview = model(overviewSnapshot(seed));
        const first = layoutMap(overview, { level });
        const again = layoutMap(overview, { level }, first.state);
        expect(again.cards).toEqual(first.cards);
        expect(again.edges).toEqual(first.edges);
      }),
      RUNS,
    );
  });
});
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/map-layout.property.test.ts`

Expected: PASS, 8 tests.

- [ ] **Step 7: Prove the crossing property detects a straight long edge, then restore**

In `map-layout.ts` `routeEdges`, temporarily replace the long branch's `d = \`M${x1} ${y1}C${x1 + hh} …\`;` (the assignment that ends `${x2} ${y2}\``) with `d = \`M${x1} ${y1}H${x2}\`;` and rerun the property file. Expected: FAIL in "places every component exactly once, with no card overlap, every edge on its ports and no edge under a card" with a message like `… crosses cmp_…` (and `has an end off a port`). Restore the line, rerun, expect PASS.

- [ ] **Step 8: Write and run the benchmark**

Create `packages/trace-viewer/src/layout/map-layout.bench.ts`:

```ts
import { bench, describe } from "vitest";

import { buildOverviewModel } from "../model/index.js";
import { syntheticOverview } from "../test-support/overview-builder.js";
import { layoutMap } from "./map-layout.js";

// Spec §11: layoutMap for 200 components and 1,000 edges, fresh ≤ 8 ms and sticky ≤ 2 ms (benchmark, not a CI gate).

const full = syntheticOverview({ components: 200, edges: 1_000, seed: 7 });
const lastId = full.components.at(-1)?.id;
const missingOne = {
  ...full,
  components: full.components.slice(0, -1),
  edges: full.edges.filter((edge) => edge.from !== lastId && edge.to !== lastId),
};
const overview = buildOverviewModel(full, 2);
const earlier = buildOverviewModel(missingOne, 1);
const settled = layoutMap(overview, { level: "card" });
const settledEarlier = layoutMap(earlier, { level: "card" });

describe("layoutMap, 200 components and 1,000 edges", () => {
  bench("fresh", () => {
    layoutMap(overview, { level: "card" });
  });

  bench("sticky, same components (a description pass)", () => {
    layoutMap(overview, { level: "card" }, settled.state);
  });

  bench("sticky, one new component", () => {
    layoutMap(overview, { level: "card" }, settledEarlier.state);
  });
});
```

Run: `perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest bench --run src/layout/map-layout.bench.ts`

Expected: a table with `fresh`, `sticky, same components (a description pass)` and `sticky, one new component`; read the `mean` column (ms). Budgets: fresh ≤ 8, both sticky rows ≤ 2. The earlier orthogonal router, which sorted ports per card side and assigned gutter and gap lanes, measured about 1.3 ms fresh and 0.9 ms sticky on the plan author's machine (Node 22, Apple silicon). The curve router does less per edge (one load count, one string template, no port sort, no lane maps), so it plausibly stays at or below those means and well inside the budgets; the plan author has not measured it, so Step 8's table is the evidence. `mapHubIds` adds one pass over the edges in the view, not in `layoutMap`. Keep `routeEdges` free of per-edge string keys. Record the three means for the commit message and the lane hand-off. A mean over budget is a finding to report, not a task failure (spec §11 benchmarks are not CI gates).

- [ ] **Step 9: Typecheck and lint**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer typecheck` — expected: exits 0.

Run: `perl -e 'alarm 170; exec @ARGV' pnpm exec eslint packages/trace-viewer` — expected: prints nothing (the `src/layout` block bans React, DOM globals, clocks and `src/ui` imports; `map-layout.ts` uses none).

- [ ] **Step 10: Commit**

```bash
git add packages/trace-viewer/src/layout/map-layout.ts packages/trace-viewer/src/layout/map-layout.test.ts \
  packages/trace-viewer/src/layout/map-layout.property.test.ts packages/trace-viewer/src/layout/map-layout.bench.ts \
  packages/trace-viewer/src/test-support/overview-arbitraries.ts packages/trace-viewer/src/test-support/map-checks.ts
git -c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com commit -m "feat(trace-viewer): add the pure sticky Map layout (bench fresh <fresh> ms, sticky <sticky> ms)"
```

Replace `<fresh>` and `<sticky>` with the means from Step 8 (the larger sticky mean).

### Task P-3: `MapView` and component Inspector

**Files:**
- Modify: `packages/trace-viewer/src/ui/icons/icon-names.ts`, `paths.ts`, `kind-icons.ts`; Test: `icons.test.tsx` (append one test)
- Modify: `packages/trace-viewer/src/ui/state/view-state.ts` (`ViewState`, `ViewAction`, `initialViewState`, the `reduce` switch); Test: `view-state.test.ts` (append one `describe`)
- Create: `packages/trace-viewer/src/layout/map-details.ts`; Test: `packages/trace-viewer/src/layout/map-details.test.ts`
- Create: `packages/trace-viewer/src/ui/views/map/overlay.ts`, `map-text.ts`, `map-nav.ts`, `map-camera.ts`, `MapCard.tsx`, `MapEdges.tsx`, `MapHeader.tsx`, `MapView.tsx`, `MapView.module.css`
- Test: `packages/trace-viewer/src/ui/views/map/map-nav.test.ts`, `map-camera.test.ts`, `map-text.test.ts`, `map-card.test.tsx`, `map-view.test.tsx`
- Create: `packages/trace-viewer/src/ui/inspector/ComponentInspector.tsx`, `ComponentInspector.module.css`; Test: `packages/trace-viewer/src/ui/inspector/component-inspector.test.tsx`
- Modify: `packages/trace-viewer/src/ui/inspector/Inspector.tsx` (the exported `Inspector` wrapper only, at the end of the file)
- Modify: `packages/trace-viewer/src/ui/views/registry.ts` (the `map` entry), `packages/trace-viewer/src/ui/views/placeholder/ViewPlaceholder.tsx` (remove V-2's `MapPlaceholder` once nothing imports it)
- Create: `apps/trace-viewer-dev/src/overview-sample.ts`; Modify: `apps/trace-viewer-dev/src/host.tsx` (`DevHost` load effect), `apps/trace-viewer-dev/scripts/smoke.mjs` (`parseArgs` and the per-view loop)

**Interfaces:**
- Consumes: P-1 `TraceSession.overview`, `OverviewModel`, `overviewStatusOf`; P-2 `layoutMap`, `MapLayout`, `MapLayoutState`, `MapLevel`, `MapBand`, `MapCard`, `MapEdgePath`, `MAP_MARGIN`, `MAP_BAND_LABEL_H`, `MAP_LANE_PAD`, `mapLevelForZoom`, `mapHubIds`, `mapImporterCounts`, `componentForPath`; lane 02 V-2 (W0): `ViewKind` with `"map"`, `ViewDefinition`, the registry's map slot, icon `view-map`, location view `"map"`, number key `3`. Existing viewer API: `createViewportController<UniformCamera>(options)` (`ui/viewport/controller.ts`), `fitBounds`, `isInsideInset`, `setCenter`, `screenToWorld`, `worldToScreen` (`layout/viewport.ts`), `useRegisterViewPort`, `useViewPortRegistry`, `ViewPort`, `ViewProps` (`ui/views/view-port.ts`), `useSessionView` (`ui/shell/session-context.ts`), `useView`, `useViewStore` (`ui/state/store.ts`), `ZOOM_STEP` (`ui/state/keymap.ts`), `DiffBar`, `Icon`, `displayUntrusted`, `truncateMiddle`; test helpers `renderWithViewer`, `stubResizeObserver`, `stubElementBox`, `stubAnimationFrames`, `stubReducedMotion` (`test-support/canvas-view-harness.tsx`), `buildSession`, `overviewSnapshot`, `syntheticOverview`, `componentId`.
- Produces:
  - `ViewState.mapSelection: string | null`; action `{ type: "map/select"; componentId: string | null }`; Esc on the Map clears `mapSelection` first (deviation 4).
  - `src/layout/map-details.ts`: `DETAIL_FILES_SHOWN = 20`, `interface MapLink { id; name; count; example: string | null }`, `interface ComponentChange { path; added; removed; stepId: StepId }`, `interface ComponentDetails { files: { shown; more }; importsOut; importsIn; externals; changes; citations }`, `componentDetails(overview, componentId, session): ComponentDetails | null`, `topPackages(component, n): readonly { name: string; count: number }[]` (a card's top packages), `fileBarPercent(files, maxFiles): number` (`max(8, round(100·√(files ÷ maxFiles)))`), `LIST_BAR_MAX_PX = 48` and `listBarPx(count, max): number` (deviation 7).
  - `src/ui/views/map/overlay.ts`: `MapCardState`, `MapOverlay`, `mapOverlayOf(session)` (deviation 5; lane 07 S-5 fills it).
  - `src/ui/views/map/map-text.ts`: `overviewHeadline(overview): { count: string; languages: string | null }`, `linkSentence(sentence, overview): SentencePart[]` (plain text and component links), `notAnalyzedNote(overview)`, `partialNote(overview)`, `narratorNote(overview)`, `scanNote(overview): ScanNote | null` (the Map header's text; ruling R3 states through `overviewStatusOf`). `MapHeader({ overview, onSelectComponent, onRetry?, selectedId?, onHoverComponent? })` (P-4 passes `onRetry`; the last two are optional, so lane 07's `MapHeader` call and `session` prop stay valid).
  - `src/ui/views/map/map-camera.ts`: `MAP_LIMITS`, `MAP_FIT_PADDING` (`{ x: 20, top: 20, bottom: 68 }`), `MAP_ICON_ONLY_K = 0.48`, `MAP_ZOOM_PRESETS`, `planMapFit`, `cardCenter`, `revealCamera`, `anchoredCamera`, `zoomedAtCenter`. `MAP_FIT_PADDING_PX`, `FIT_MAX_K` and `nearestCard` are gone (one geometry, so a level change never moves a card).
  - `src/ui/views/map/MapEdges.tsx`: `MapEdges`, `MAP_EDGE_STROKE` (`{ 1: 1, 2: 1.6, 3: 2.4 }` px) and `hubStubPath(x, y)`.
  - `src/ui/views/map/map-nav.ts`: `MapNavKey`, `isMapNavKey`, `mapNeighbor(layout, fromId, key)`.
  - `MapView` (kind `"map"`), `ComponentInspector({ componentId })`, `ROLE_ICON`, `ROLE_LABEL`, the seven `role-*` icon names and `fan-in` (deviation 6).
  - Dev host: `?overview=sample`; smoke view `map` (`.smoke/map-1440.png`, `.smoke/map-1000.png`).

Behavior (spec §3.4, E13, E14, §10 untrusted text; the approved H2 Map mockup, `map-1440.png`, `map-selected-1440.png`, `map-zoomed-1440.png`):

- **Canvas.** No dot grid. Each band is a full-height light lane (`rgb(16 24 40 / .024)`, radius 16, 10 at the detail level) from `col.x − 6` to `col.x + col.w + 6` and from `MAP_MARGIN − 4` to `bounds.h − MAP_MARGIN + 6`, with a header inside its top at `(col.x − 1, MAP_MARGIN + 2)`: role icon, label (weight 600, ink) and count (ink-4). The side band is labelled "Support".
- **Cards.** Every card is the same box at every level; only its content changes. The name shows in full, two lines at most, breaking at spaces and hyphens (`overflow-wrap: anywhere` as the last resort; the tooltip and accessible name carry it too). The footer holds the role icon, a file-count bar (`max(8, round(100·√(files ÷ largest)))` percent) and, by level: nothing at chip, the count at card, "n files" at detail. The detail level adds the purpose (two lines, or the root path), the top two packages in one row, and the hub glyph (fan-in icon and importer count) for a hub. No import-weight bar, no language, no package chips.
- **Edges.** Smooth curves in 1, 1.6 or 2.4 px non-scaling strokes by import count, light (`--tv-map-edge`, `#C4C9D1`). At rest only band-to-band edges that do not enter a hub are drawn, and each hub's left port carries a three-line stub. For the selected or hovered card all of its edges (same-band and hub edges included) turn accent and draw last; every other edge drops to 22%. An emphasized session edge (lane 07) always draws.
- **Camera.** Fit centers the map on both axes and fills the stage (`k = min((vw − 40) / W, (vh − 88) / H, 1)`), reruns on a real viewport resize while the camera is still where Fit left it, and picks the card level at k ≥ 0.7, else the chip level, never detail. Zoom bands: chip below 0.7, card below 1.4, detail from 1.4; the level follows the zoom at each settle and no card moves. Wheel, pinch and hand-tool pan go through the shared controller; zoom keys and Fit through the view port. Below `MAP_ICON_ONLY_K = 0.48` names hide.
- **Selection and keys.** Click or Enter selects a card (accent ring) and opens `ComponentInspector`; arrow keys move focus within and across bands, Home and End jump; Esc clears the map selection.
- **Header.** The rule-based headline ("21 components", languages beside it in muted ink), a row of quiet notes (partial, imports not analyzed, the ruling R3 scan note with progress or "Codebase map unavailable", narrator word "Descriptions off", "Descriptions unavailable" or "Descriptions pending"), and the collapsible narrative in plain sentences: component names are quiet links (hovering one behaves like hovering its card; the selected component's link is accent), the first two sentences show and a quiet "More" reveals the rest; the Overview toggle collapses all of it. A map with no cards shows the scan note (or "No components found") in the stage. Focus never moves on a data rebuild.

- [ ] **Step 1: Check gate H2 and apply its rulings**

Run: `grep -n "H2 approval" docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/README.md`

Expected: `H2 approval: approved by the person on …`. If it still reads `PENDING`, stop: this task is blocked. If the approval lists rulings that change sizes, gutters or thresholds, apply them now to `MAP_LEVEL_SPECS` and the zoom thresholds (`src/layout/map-layout.ts`) and note them for `MAP_FIT_PADDING` and `MAP_ICON_ONLY_K` (Step 6 below), rerun `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/map-layout.test.ts src/layout/map-layout.property.test.ts`, update any expectation in `map-layout.test.ts` that names the changed constant only through the constant (the tests read `MAP_LEVEL_SPECS`, so most need no edit), and commit as `fix(trace-viewer): apply the H2 Map rulings to the layout constants`.

Open `docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/map-1440.png`, `map-selected-1440.png`, `map-zoomed-1440.png` and `map-pending-1440.png` (Read shows PNGs) and keep them in view for this task. `map.html` in the same folder holds the exact CSS and geometry the constants below come from.

- [ ] **Step 2: Add the role icons**

In `packages/trace-viewer/src/ui/icons/icon-names.ts`, append to the `ICON_NAMES` array (after the view names, keeping V-2's `view-console` and `view-map`):

```ts
  "role-ui", "role-api", "role-agent", "role-domain", "role-storage", "role-tooling", "role-config", "fan-in",
```

In `packages/trace-viewer/src/ui/icons/paths.ts`, add these entries to `ICON_PATHS` (the `circle` helper is defined at the top of the file):

```ts
  "role-ui": ["M3 2.75h10a1.25 1.25 0 0 1 1.25 1.25v8a1.25 1.25 0 0 1-1.25 1.25H3A1.25 1.25 0 0 1 1.75 12V4A1.25 1.25 0 0 1 3 2.75z", "M1.75 5.75h12.5M4.5 8.75h4M4.5 11h2.5"],
  "role-api": ["M2.5 5.5h9M9 3l2.5 2.5L9 8", "M13.5 10.5h-9M7 8l-2.5 2.5L7 13"],
  "role-agent": ["M5 4.75h6a.75.75 0 0 1 .75.75v5a.75.75 0 0 1-.75.75H5a.75.75 0 0 1-.75-.75v-5A.75.75 0 0 1 5 4.75z", "M6.5 2.25v2.5M9.5 2.25v2.5M6.5 11.25v2.5M9.5 11.25v2.5M1.75 6.5h2.5M1.75 9.5h2.5M11.75 6.5h2.5M11.75 9.5h2.5"],
  "role-domain": ["M8 1.75l5.25 3v6.5L8 14.25l-5.25-3v-6.5z", circle(8, 8, 2)],
  "role-storage": ["M2.75 4.25c0-1.1 2.35-2 5.25-2s5.25.9 5.25 2-2.35 2-5.25 2-5.25-.9-5.25-2z", "M2.75 4.25v7.5c0 1.1 2.35 2 5.25 2s5.25-.9 5.25-2v-7.5M2.75 8c0 1.1 2.35 2 5.25 2s5.25-.9 5.25-2"],
  "role-tooling": ["M10.1 2.35a3.25 3.25 0 0 0-3.85 4.4L2.6 10.4a1.4 1.4 0 0 0 2 2l3.65-3.65a3.25 3.25 0 0 0 4.4-3.85l-1.9 1.9-1.75-.35-.35-1.75z"],
  "role-config": ["M2.75 4.75h10.5M2.75 11.25h10.5", circle(6, 4.75, 1.5), circle(10, 11.25, 1.5)],
  "fan-in": ["M2.25 3.25H6L9.5 8", "M2.25 8h7.25", "M2.25 12.75H6L9.5 8", "M9.5 8h4M11.75 6l2 2-2 2"],
```

In `packages/trace-viewer/src/ui/icons/kind-icons.ts`, add `import type { Role } from "@jevcode/contracts";` and append:

```ts
/** Map role icons (spec §3.6); tests reuse the test flask, external packages use `pkg`. */
export const ROLE_ICON: { readonly [K in Role]: IconName } = {
  ui: "role-ui",
  api: "role-api",
  agent: "role-agent",
  domain: "role-domain",
  storage: "role-storage",
  tests: "test",
  tooling: "role-tooling",
  config: "role-config",
};

export const ROLE_LABEL: { readonly [K in Role]: string } = {
  ui: "UI",
  api: "API",
  agent: "Agent",
  domain: "Domain",
  storage: "Storage",
  tests: "Tests",
  tooling: "Tooling",
  config: "Config",
};
```

(`IconName` is already imported in `kind-icons.ts`; if not, add `import type { IconName } from "./icon-names.js";`.)

Append to `packages/trace-viewer/src/ui/icons/icons.test.tsx` (add `ROLES` to an import from `@jevcode/contracts` and `ROLE_ICON`, `ROLE_LABEL` to the `./kind-icons.js` import):

```tsx
describe("role icons (spec §3.6)", () => {
  it("maps every role to a real icon and a label", () => {
    const names = new Set<string>(ICON_NAMES);
    for (const role of ROLES) {
      expect(names.has(ROLE_ICON[role]), role).toBe(true);
      expect(ROLE_LABEL[role].length, role).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 3: Add the map selection to the view state (failing test first)**

Append to `packages/trace-viewer/src/ui/state/view-state.test.ts` (add `emptyTraceIndex` from `../../layout/trace-index.js`, and `initialViewState`, `reduce` from `./view-state.js`, to its imports if they are not there):

```ts
describe("map selection (spec §3.4, lane 06 deviation 4)", () => {
  const index = emptyTraceIndex("sess-map");
  const onMap = { ...initialViewState({ live: false }), view: "map" as const };

  it("starts empty, and map/select sets and clears the component", () => {
    expect(initialViewState({ live: false }).mapSelection).toBeNull();
    const selected = reduce(onMap, { type: "map/select", componentId: "cmp_0123456789ab" }, index);
    expect(selected.mapSelection).toBe("cmp_0123456789ab");
    expect(reduce(selected, { type: "map/select", componentId: "cmp_0123456789ab" }, index)).toBe(selected);
    expect(reduce(selected, { type: "map/select", componentId: null }, index).mapSelection).toBeNull();
  });

  it("Esc on the Map clears the component before anything else; elsewhere it leaves it", () => {
    const selected = reduce(onMap, { type: "map/select", componentId: "cmp_0123456789ab" }, index);
    expect(reduce(selected, { type: "esc" }, index).mapSelection).toBeNull();
    const elsewhere = { ...selected, view: "hybrid" as const };
    expect(reduce(elsewhere, { type: "esc" }, index).mapSelection).toBe("cmp_0123456789ab");
  });
});
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/state/view-state.test.ts`

Expected: FAIL: `expected undefined to be null` and TypeScript reports `Type '"map/select"' is not assignable` in the editor (vitest still runs).

In `packages/trace-viewer/src/ui/state/view-state.ts`:
- add to `interface ViewState`, after `unitAnchors`:

```ts
  /** Map view (spec §3.4): the selected component id. Separate from `selection`; not in the location hash. */
  mapSelection: string | null;
```

- add to the `ViewAction` union, after `{ type: "seen"; seq: number }`:

```ts
  | { type: "map/select"; componentId: string | null }
```

- add `mapSelection: null,` to the object `initialViewState` returns, after `unitAnchors: {},`;
- in `reduce`, add this case before `case "seen":`:

```ts
    case "map/select":
      return action.componentId === state.mapSelection ? state : { ...state, mapSelection: action.componentId };
```

- in the `case "esc":` block, insert directly after `if (state.tool === "hand") return { ...state, tool: "select" };`:

```ts
      if (state.view === "map" && state.mapSelection !== null) return { ...state, mapSelection: null };
```

Run the same command. Expected: PASS.

- [ ] **Step 4: Write `map-details.ts` (failing test first)**

Create `packages/trace-viewer/src/layout/map-details.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { buildOverviewModel } from "../model/index.js";
import { componentId, overviewSnapshot } from "../test-support/overview-builder.js";
import { buildSession } from "../test-support/session-builder.js";
import { componentDetails } from "./map-details.js";

const MAIN = "apps/desktop/src/main";
const snapshot = overviewSnapshot({
  components: [
    {
      rootPath: MAIN,
      role: "api",
      files: Array.from({ length: 25 }, (_, i) => `${MAIN}/f${String(i).padStart(2, "0")}.ts`),
      fileCount: 61,
      externalDeps: [{ name: "node-pty", count: 2 }, { name: "electron", count: 9 }],
    },
    { rootPath: "packages/contracts", name: "contracts", role: "domain" },
    { rootPath: "apps/desktop/src/renderer", name: "renderer", role: "ui" },
    { rootPath: "tools/py", name: "py", role: "tooling", language: "Python", importsAnalyzed: false },
  ],
  edges: [
    { from: MAIN, to: "packages/contracts", count: 22, examples: [`${MAIN}/ipc.ts → packages/contracts/src/index.ts`] },
    { from: "apps/desktop/src/renderer", to: MAIN, count: 2 },
    { from: "apps/desktop/src/renderer", to: "packages/contracts", count: 5 },
  ],
  narrative: {
    provenance: "model",
    sentences: [
      { text: "Main feeds the pipeline.", citations: [{ kind: "component", id: componentId(MAIN) }] },
      { text: "A main file matters.", citations: [{ kind: "file", id: `${MAIN}/f03.ts` }] },
      { text: "Contracts holds the schemas.", citations: [{ kind: "component", id: componentId("packages/contracts") }] },
    ],
  },
});
const overview = buildOverviewModel(snapshot, 1);
const session = buildSession({
  steps: [
    { kind: "edit", tMs: 1_000, target: `${MAIN}/pipeline/explainer-stage.ts`, edit: { added: 120, removed: 4 } },
    { kind: "edit", tMs: 2_000, target: "packages/contracts/src/overview.ts", edit: { added: 40, removed: 0 } },
  ],
  overview: snapshot,
});

describe("componentDetails (spec §3.4 Inspector)", () => {
  it("lists the top 20 files and how many more, imports both ways by count, packages, session changes and citations", () => {
    const details = componentDetails(overview, componentId(MAIN), session);
    expect(details?.files.shown).toHaveLength(20);
    expect(details?.files.more).toBe(41);
    expect(details?.importsOut).toEqual([
      { id: componentId("packages/contracts"), name: "contracts", count: 22, example: `${MAIN}/ipc.ts → packages/contracts/src/index.ts` },
    ]);
    expect(details?.importsIn).toEqual([{ id: componentId("apps/desktop/src/renderer"), name: "renderer", count: 2, example: null }]);
    expect(details?.externals).toEqual([{ name: "electron", count: 9 }, { name: "node-pty", count: 2 }]);
    expect(details?.changes.map((change) => change.path)).toEqual([`${MAIN}/pipeline/explainer-stage.ts`]);
    expect(details?.changes[0]?.stepId).toBe(session.steps[0]?.id);
    expect(details?.citations.map((sentence) => sentence.text)).toEqual(["Main feeds the pipeline.", "A main file matters."]);
  });

  it("returns null for a component the snapshot does not have", () => {
    expect(componentDetails(overview, "cmp_000000000000", session)).toBeNull();
  });
});
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/map-details.test.ts` — expected: FAIL, `Cannot find module './map-details.js'`.

Create `packages/trace-viewer/src/layout/map-details.ts`:

```ts
// Component Inspector data and the bar scales of the Map (spec §3.4). Pure and React-free.
import type { Component, NarrativeSentence } from "@jevcode/contracts";

import type { OverviewModel, StepId, TraceSession } from "../model/index.js";
import { componentForPath } from "./map-layout.js";

/** Spec §3.4: files are listed top 20, then "n more". */
export const DETAIL_FILES_SHOWN = 20;

export interface MapLink { id: string; name: string; count: number; example: string | null }
export interface ComponentChange { path: string; added: number; removed: number; stepId: StepId }
export interface ComponentDetails {
  files: { shown: readonly string[]; more: number };
  importsOut: readonly MapLink[];
  importsIn: readonly MapLink[];
  externals: readonly { name: string; count: number }[];
  /** This session's edited files inside the component, by path. */
  changes: readonly ComponentChange[];
  /** Overview sentences citing the component or one of its listed files. */
  citations: readonly NarrativeSentence[];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byCount = (a: MapLink, b: MapLink): number => b.count - a.count || cmp(a.name, b.name) || cmp(a.id, b.id);

export function componentDetails(overview: OverviewModel, componentId: string, session: TraceSession): ComponentDetails | null {
  const component = overview.componentById.get(componentId);
  if (component === undefined) return null;
  const nameOf = (id: string): string => overview.componentById.get(id)?.name ?? id;
  const importsOut: MapLink[] = [];
  const importsIn: MapLink[] = [];
  for (const edge of overview.snapshot.edges) {
    if (edge.from === edge.to) continue;
    const example = edge.examples[0] ?? null;
    if (edge.from === componentId) importsOut.push({ id: edge.to, name: nameOf(edge.to), count: edge.count, example });
    else if (edge.to === componentId) importsIn.push({ id: edge.from, name: nameOf(edge.from), count: edge.count, example });
  }
  const changes: ComponentChange[] = [];
  for (const entity of session.entities) {
    const stepId = entity.stepIds.at(-1);
    if (stepId === undefined || componentForPath(overview, entity.path) !== componentId) continue;
    changes.push({ path: entity.path, added: entity.added, removed: entity.removed, stepId });
  }
  changes.sort((a, b) => cmp(a.path, b.path));
  const files = new Set(component.files);
  const citations = (overview.snapshot.narrative?.sentences ?? []).filter((sentence) =>
    sentence.citations.some((citation) => (citation.kind === "component" && citation.id === componentId) || (citation.kind === "file" && files.has(citation.id))),
  );
  return {
    files: {
      shown: component.files.slice(0, DETAIL_FILES_SHOWN),
      more: Math.max(0, component.fileCount - Math.min(DETAIL_FILES_SHOWN, component.files.length)),
    },
    importsOut: importsOut.sort(byCount),
    importsIn: importsIn.sort(byCount),
    externals: [...component.externalDeps].sort((a, b) => b.count - a.count || cmp(a.name, b.name)),
    changes,
    citations,
  };
}
```

Run the same command — expected: PASS.

- [ ] **Step 5: Write the bar scales (failing test first)**

The card's footer bar and the Inspector's list bars are plain boxes sized by two pure scales, so they need no graphic component and no new dependency.

Append to `packages/trace-viewer/src/layout/map-details.test.ts` (add `fileBarPercent`, `listBarPx`, `topPackages` and `LIST_BAR_MAX_PX` to its import from `./map-details.js`):

```ts
describe("bar scales (revised Map mockup)", () => {
  it("sizes the file-count bar by the square root of files over the largest count, at least 8%", () => {
    expect([fileBarPercent(61, 61), fileBarPercent(25, 100), fileBarPercent(64, 100), fileBarPercent(1, 61), fileBarPercent(0, 61), fileBarPercent(1, 10_000)]).toEqual([
      100, 50, 80, 13, 8, 8,
    ]);
    expect(fileBarPercent(5, 0)).toBe(8);
  });

  it("sizes a list bar by its share of the list's largest count, up to 48 px, at least 1 px for a nonzero count", () => {
    expect(LIST_BAR_MAX_PX).toBe(48);
    expect([listBarPx(22, 22), listBarPx(2, 9), listBarPx(1, 1_000), listBarPx(0, 5), listBarPx(5, 0)]).toEqual([48, 11, 1, 0, 0]);
  });

  it("picks a card's top packages by count, then name", () => {
    const component = overview.componentById.get(componentId(MAIN));
    if (component === undefined) throw new Error("no component");
    expect(topPackages(component, 1)).toEqual([{ name: "electron", count: 9 }]);
    expect(topPackages(component, 2).map((ext) => ext.name)).toEqual(["electron", "node-pty"]);
    expect(topPackages(component, 0)).toEqual([]);
  });
});
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/map-details.test.ts` — expected: FAIL (`fileBarPercent is not a function`).

Append to `packages/trace-viewer/src/layout/map-details.ts` (add `type Component` to its `@jevcode/contracts` import):

```ts
/** The longest list bar in the Inspector, in px (revised Map mockup). */
export const LIST_BAR_MAX_PX = 48;

/** Width of a card's file-count bar as a percent of its track: √(files ÷ largest), never below 8% so every card shows one. */
export function fileBarPercent(files: number, maxFiles: number): number {
  if (maxFiles <= 0) return 8;
  return Math.min(100, Math.max(8, Math.round(100 * Math.sqrt(Math.max(0, files) / maxFiles))));
}

/** Width in px of an Inspector list bar: the count's share of the list's largest, at least 1 px for a nonzero count. */
export function listBarPx(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  return Math.max(1, Math.round((LIST_BAR_MAX_PX * count) / max));
}

/** A component's top `n` external packages by count, then name; the detail-level card shows two. */
export function topPackages(component: Component, n: number): readonly { name: string; count: number }[] {
  return [...component.externalDeps].sort((a, b) => b.count - a.count || cmp(a.name, b.name)).slice(0, Math.max(0, n));
}
```

Run the same command — expected: PASS. (`cmp` is the module's existing string comparator; `componentDetails` sorts its `externals` the same way.)

- [ ] **Step 6: Write the pure view helpers (failing tests first)**

Create `packages/trace-viewer/src/ui/views/map/map-nav.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { layoutMap } from "../../../layout/map-layout.js";
import { buildOverviewModel } from "../../../model/index.js";
import { componentId, overviewSnapshot } from "../../../test-support/overview-builder.js";
import { isMapNavKey, mapNeighbor } from "./map-nav.js";

// Bands: ui [a, b], domain [x, y, z]; no edges, so each band is in name order.
const layout = layoutMap(
  buildOverviewModel(
    overviewSnapshot({
      components: [
        { rootPath: "ui/a", role: "ui" },
        { rootPath: "ui/b", role: "ui" },
        { rootPath: "d/x", role: "domain" },
        { rootPath: "d/y", role: "domain" },
        { rootPath: "d/z", role: "domain" },
      ],
    }),
    1,
  ),
  { level: "card" },
);
const id = componentId;

describe("mapNeighbor", () => {
  it("knows its keys", () => {
    expect(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].every(isMapNavKey)).toBe(true);
    expect(isMapNavKey("Enter")).toBe(false);
  });

  it("moves down and up within a band and stops at its ends", () => {
    expect(mapNeighbor(layout, id("ui/a"), "ArrowDown")).toBe(id("ui/b"));
    expect(mapNeighbor(layout, id("ui/b"), "ArrowDown")).toBeNull();
    expect(mapNeighbor(layout, id("d/y"), "ArrowUp")).toBe(id("d/x"));
    expect(mapNeighbor(layout, id("ui/a"), "ArrowUp")).toBeNull();
  });

  it("moves across bands to the card nearest in height, the upper one on a tie", () => {
    expect(mapNeighbor(layout, id("ui/b"), "ArrowRight")).toBe(id("d/y"));
    expect(mapNeighbor(layout, id("d/z"), "ArrowLeft")).toBe(id("ui/b"));
    expect(mapNeighbor(layout, id("d/x"), "ArrowRight")).toBeNull();
    expect(mapNeighbor(layout, id("ui/a"), "ArrowLeft")).toBeNull();
  });

  it("jumps with Home and End, and starts at the first card without a focus", () => {
    expect(mapNeighbor(layout, id("d/y"), "Home")).toBe(id("ui/a"));
    expect(mapNeighbor(layout, id("ui/a"), "End")).toBe(id("d/z"));
    expect(mapNeighbor(layout, null, "ArrowDown")).toBe(id("ui/a"));
    expect(mapNeighbor(layout, "cmp_000000000000", "ArrowRight")).toBe(id("ui/a"));
  });
});
```

Create `packages/trace-viewer/src/ui/views/map/map-camera.test.ts`:

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { layoutMap } from "../../../layout/map-layout.js";
import { worldToScreen } from "../../../layout/viewport.js";
import { buildOverviewModel } from "../../../model/index.js";
import { arbOverviewSeed } from "../../../test-support/overview-arbitraries.js";
import { overviewSnapshot, syntheticOverview } from "../../../test-support/overview-builder.js";
import { cardCenter, MAP_FIT_PADDING, MAP_ICON_ONLY_K, planMapFit, revealCamera } from "./map-camera.js";

const small = buildOverviewModel(
  overviewSnapshot({ components: [{ rootPath: "apps/web", role: "ui" }, { rootPath: "srv/api", role: "api" }, { rootPath: "pkg/db", role: "storage" }] }),
  1,
);
// One band of 20 cards: 172 wide, 1,900 tall (16 + 140 + 16; 60 + 20 × 92 − 16 + 16).
const tall = buildOverviewModel(
  overviewSnapshot({ components: Array.from({ length: 20 }, (_, i) => ({ rootPath: `pkg/c${String(i).padStart(2, "0")}`, role: "domain" as const })) }),
  1,
);
const large = buildOverviewModel(syntheticOverview({ components: 200, edges: 1_000, seed: 3 }), 1);
const VIEWPORT = { w: 944, h: 700 };

describe("planMapFit (spec §3.4: Fit centers the map and fills the stage)", () => {
  it("centers a small map at 100% with the padding of the zoom bar", () => {
    expect(MAP_FIT_PADDING).toEqual({ x: 20, top: 20, bottom: 68 });
    // The map is 496 × 152 (16 + 3 × 140 + 2 × 22 + 16 by 60 + 76 + 16). k = min(904 / 496, 612 / 152, 1) = 1.
    // tx = (944 − 496) / 2; ty = 20 + ((700 − 88) − 152) / 2.
    const plan = planMapFit(small, VIEWPORT);
    expect(plan?.camera).toEqual({ mode: "uniform", k: 1, tx: 224, ty: 250 });
    expect(plan?.level).toBe("card");
    expect(plan?.layout.level).toBe("card");
  });

  it("fills the height of a tall map, from the top padding to the bottom padding, at the chip level", () => {
    const plan = planMapFit(tall, VIEWPORT);
    const k = 612 / 1_900; // (700 − 20 − 68) / 1,900
    expect(plan?.camera.k).toBeCloseTo(k, 10);
    expect(plan?.camera.ty).toBeCloseTo(20, 8);
    expect(plan?.camera.tx).toBeCloseTo((944 - 172 * k) / 2, 8);
    expect(plan?.level).toBe("chip");
    expect(plan?.layout.level).toBe("chip");
  });

  it("fits a 200-component map at the chip level and shows all of it", () => {
    const plan = planMapFit(large, VIEWPORT);
    expect(plan?.level).toBe("chip");
    expect(plan?.camera.k).toBeLessThan(0.7);
    const { w, h } = plan?.layout.bounds ?? { w: 0, h: 0 };
    const k = plan?.camera.k ?? 0;
    expect(w * k).toBeLessThanOrEqual(VIEWPORT.w - 40 + 1e-6);
    expect(h * k).toBeLessThanOrEqual(VIEWPORT.h - 88 + 1e-6);
  });

  it("fits the two approved widths: the card level on a wide stage, the chip level with names on a narrow one", () => {
    // The mockup's 21 components are 946 wide (32 + 5 × 140 + 104 + 5 × 22) and about 796 tall.
    const mockup = buildOverviewModel(
      overviewSnapshot({
        components: [
          ...Array.from({ length: 8 }, (_, i) => ({ rootPath: `d/c${i}`, role: "domain" as const })),
          ...(["ui", "api", "agent", "storage", "tests"] as const).map((role) => ({ rootPath: `r/${role}`, role })),
        ],
      }),
      1,
    );
    const wide = planMapFit(mockup, { w: 944, h: 700 });
    expect(wide?.level).toBe("card");
    const narrow = planMapFit(mockup, { w: 552, h: 700 });
    expect(narrow?.level).toBe("chip");
    expect(narrow?.camera.k).toBeGreaterThanOrEqual(MAP_ICON_ONLY_K);
  });

  it("waits for a real size", () => {
    expect(planMapFit(small, { w: 0, h: 0 })).toBeNull();
    expect(planMapFit(small, { w: 30, h: 700 })).toBeNull();
  });

  it("property: Fit centers on both axes, stays inside the padded stage, fills one axis unless capped at 100%, and never picks detail", () => {
    fc.assert(
      fc.property(
        arbOverviewSeed({ maxComponents: 12 }),
        fc.record({ w: fc.integer({ min: 400, max: 2_400 }), h: fc.integer({ min: 500, max: 1_400 }) }),
        (seed, viewport) => {
          const plan = planMapFit(buildOverviewModel(overviewSnapshot(seed), 1), viewport);
          expect(plan).not.toBeNull();
          if (plan === null) return;
          const { w, h } = plan.layout.bounds;
          const { k, tx, ty } = plan.camera;
          const availW = viewport.w - 2 * MAP_FIT_PADDING.x;
          const availH = viewport.h - MAP_FIT_PADDING.top - MAP_FIT_PADDING.bottom;
          expect(k).toBeLessThanOrEqual(1 + 1e-9);
          expect(tx).toBeCloseTo((viewport.w - w * k) / 2, 6);
          expect(ty).toBeCloseTo(MAP_FIT_PADDING.top + (availH - h * k) / 2, 6);
          expect(tx).toBeGreaterThanOrEqual(MAP_FIT_PADDING.x - 1e-6);
          expect(ty).toBeGreaterThanOrEqual(MAP_FIT_PADDING.top - 1e-6);
          expect(ty + h * k).toBeLessThanOrEqual(viewport.h - MAP_FIT_PADDING.bottom + 1e-6);
          const fills = Math.abs(w * k - availW) < 1e-6 || Math.abs(h * k - availH) < 1e-6;
          expect(k === 1 || fills).toBe(true);
          expect(plan.level).toBe(k < 0.7 ? "chip" : "card");
          expect(plan.layout.level).toBe(plan.level);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("revealCamera", () => {
  const layout = layoutMap(small, { level: "card" });
  const camera = { mode: "uniform" as const, tx: 0, ty: 0, k: 1 };

  it("leaves a card that is already well inside the view", () => {
    const first = layout.cards[0];
    if (first === undefined) throw new Error("no card");
    expect(revealCamera(camera, first, { w: 2_000, h: 1_000 })).toBeNull();
  });

  it("centers a card that is outside the view", () => {
    const last = layout.cards.at(-1);
    if (last === undefined) throw new Error("no card");
    const viewport = { w: 300, h: 300 };
    const moved = revealCamera(camera, last, viewport);
    expect(moved).not.toBeNull();
    const center = worldToScreen(moved ?? camera, cardCenter(last));
    expect(center.x).toBeCloseTo(150, 5);
    expect(center.y).toBeCloseTo(150, 5);
  });
});
```

Create `packages/trace-viewer/src/ui/views/map/map-text.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { Citation } from "@jevcode/contracts";

import { buildOverviewModel } from "../../../model/index.js";
import { componentId, overviewSnapshot } from "../../../test-support/overview-builder.js";
import { linkSentence, overviewHeadline } from "./map-text.js";

const snapshot = overviewSnapshot({
  components: [
    { rootPath: "apps/web", name: "web", role: "ui" },
    { rootPath: "services/api", name: "api", role: "api" },
    { rootPath: "pkg/core-db", name: "core-db", role: "storage" },
    { rootPath: "pkg/evil", name: "evil\u202Ename", role: "domain" },
  ],
});
const overview = buildOverviewModel(snapshot, 1);
const cite = (rootPath: string): Citation => ({ kind: "component", id: componentId(rootPath) });
const link = (text: string, rootPath: string) => ({ text, componentId: componentId(rootPath) });

describe("overviewHeadline", () => {
  it("splits the count from up to three languages by file count", () => {
    const withLanguages = buildOverviewModel({ ...snapshot, counts: { ...snapshot.counts, languages: ["TypeScript", "JSON", "Python", "Go"] } }, 1);
    expect(overviewHeadline(withLanguages)).toEqual({ count: "4 components", languages: "TypeScript · JSON · Python" });
    expect(overviewHeadline(buildOverviewModel({ ...snapshot, counts: { ...snapshot.counts, languages: [] } }, 1)).languages).toBeNull();
    expect(overviewHeadline(buildOverviewModel(overviewSnapshot({ components: [{ rootPath: "src", role: "domain" }] }), 1)).count).toBe("1 component");
  });
});

describe("linkSentence (component names are quiet links)", () => {
  it("links each cited name where it appears, ignoring case and keeping the text between", () => {
    const parts = linkSentence(
      { text: "web calls the API through core-db.", citations: [cite("apps/web"), cite("services/api"), cite("pkg/core-db")] },
      overview,
    );
    expect(parts).toEqual([
      link("web", "apps/web"),
      { text: " calls the " },
      link("API", "services/api"),
      { text: " through " },
      link("core-db", "pkg/core-db"),
      { text: "." },
    ]);
  });

  it("appends a link after a sentence that does not spell the name out, and links a name once", () => {
    expect(linkSentence({ text: "Everything runs in one process.", citations: [cite("apps/web"), cite("apps/web")] }, overview)).toEqual([
      { text: "Everything runs in one process." },
      { text: " " },
      link("web", "apps/web"),
    ]);
  });

  it("matches whole words only, so a longer word does not become a link", () => {
    expect(linkSentence({ text: "The webapp serves pages.", citations: [cite("apps/web")] }, overview)).toEqual([
      { text: "The webapp serves pages." },
      { text: " " },
      link("web", "apps/web"),
    ]);
  });

  it("ignores file citations and components missing from the map", () => {
    const parts = linkSentence({ text: "Plain.", citations: [{ kind: "file", id: "src/a.ts" }, { kind: "component", id: "cmp_000000000000" }] }, overview);
    expect(parts).toEqual([{ text: "Plain." }]);
  });

  it("shows hostile text and names through displayUntrusted", () => {
    const parts = linkSentence({ text: "Run evil\u202Ename now **bold**", citations: [cite("pkg/evil")] }, overview);
    expect(parts).toEqual([{ text: "Run " }, link("evil⟨U+202E⟩name", "pkg/evil"), { text: " now **bold**" }]);
    expect(JSON.stringify(parts)).not.toContain("\u202E");
  });
});
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/map/map-nav.test.ts src/ui/views/map/map-camera.test.ts src/ui/views/map/map-text.test.ts` — expected: FAIL to load all three (`Cannot find module './map-nav.js'`, `'./map-camera.js'`, `'./map-text.js'`).

Create `packages/trace-viewer/src/ui/views/map/map-nav.ts`:

```ts
import type { MapCard, MapLayout } from "../../../layout/map-layout.js";

export type MapNavKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End";
const KEYS: ReadonlySet<string> = new Set<MapNavKey>(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);

export function isMapNavKey(key: string): key is MapNavKey {
  return KEYS.has(key);
}

/** The card a key moves focus to: within a band by row, across bands to the nearest card in height (upper on a tie). */
export function mapNeighbor(layout: MapLayout, fromId: string | null, key: MapNavKey): string | null {
  const cards = layout.cards;
  const first = cards[0];
  if (first === undefined) return null;
  if (key === "Home") return first.id;
  if (key === "End") return cards.at(-1)?.id ?? null;
  const from = fromId === null ? undefined : cards.find((card) => card.id === fromId);
  if (from === undefined) return first.id;
  if (key === "ArrowUp" || key === "ArrowDown") {
    const band = cards.filter((card) => card.band === from.band);
    const at = band.indexOf(from);
    return band[key === "ArrowUp" ? at - 1 : at + 1]?.id ?? null;
  }
  const column = layout.bands.findIndex((band) => band.band === from.band);
  const target = layout.bands[key === "ArrowLeft" ? column - 1 : column + 1];
  if (target === undefined) return null;
  const middle = from.y + from.h / 2;
  let best: MapCard | null = null;
  for (const card of cards) {
    if (card.band !== target.band) continue;
    if (best === null || Math.abs(card.y + card.h / 2 - middle) < Math.abs(best.y + best.h / 2 - middle)) best = card;
  }
  return best?.id ?? null;
}
```

Create `packages/trace-viewer/src/ui/views/map/map-camera.ts`:

```ts
import { layoutMap, mapLevelForZoom, type MapCard, type MapLayout, type MapLayoutState, type MapLevel } from "../../../layout/map-layout.js";
import { isInsideInset, screenToWorld, setCenter, type Point, type Size, type UniformCamera, type ZoomLimits } from "../../../layout/viewport.js";
import type { OverviewModel } from "../../../model/index.js";

export const MAP_LIMITS: ZoomLimits = { minK: 0.1, maxK: 2 };
/** Fit leaves 20 px at the sides and the top and 68 px at the bottom, which clears the zoom bar (revised Map mockup). */
export const MAP_FIT_PADDING = { x: 20, top: 20, bottom: 68 } as const;
export const MAP_REVEAL_INSET_PX = 48;
/** Below this zoom card names hide and only the footer icon and bar show (spec alignment note 7). */
export const MAP_ICON_ONLY_K = 0.48;
export const MAP_ZOOM_PRESETS = [
  { id: "fit", label: "Fit" },
  { id: "100", label: "100%" },
] as const;

export interface MapFitPlan { level: MapLevel; camera: UniformCamera; layout: MapLayout }

/**
 * Fit (spec §3.4): the whole map, centered on both axes, filling the stage up to 100%. The geometry is the same at
 * every level, so there is one layout; `level` is the zoom band the fit lands in. k stays at or below 1, so the level
 * is chip or card, never detail.
 */
export function planMapFit(overview: OverviewModel, viewport: Size, prev?: MapLayoutState): MapFitPlan | null {
  const availW = viewport.w - 2 * MAP_FIT_PADDING.x;
  const availH = viewport.h - MAP_FIT_PADDING.top - MAP_FIT_PADDING.bottom;
  if (availW <= 0 || availH <= 0) return null;
  const laid = layoutMap(overview, { level: "card" }, prev);
  const { w, h } = laid.bounds;
  if (w <= 0 || h <= 0) return null;
  const k = Math.max(MAP_LIMITS.minK, Math.min(availW / w, availH / h, 1));
  const level = mapLevelForZoom(k);
  return {
    level,
    layout: { ...laid, level },
    camera: { mode: "uniform", k, tx: (viewport.w - w * k) / 2, ty: MAP_FIT_PADDING.top + (availH - h * k) / 2 },
  };
}

export function cardCenter(card: MapCard): Point {
  return { x: card.x + card.w / 2, y: card.y + card.h / 2 };
}

/** null when the card is inside the view inset by MAP_REVEAL_INSET_PX; else the camera that centers it. */
export function revealCamera(camera: UniformCamera, card: MapCard, viewport: Size): UniformCamera | null {
  if (viewport.w <= 0 || viewport.h <= 0) return null;
  if (isInsideInset(camera, card, viewport, MAP_REVEAL_INSET_PX)) return null;
  return setCenter(camera, cardCenter(card), viewport);
}

/** The camera at zoom k that puts `world` at `screen`. */
export function anchoredCamera(k: number, world: Point, screen: Point): UniformCamera {
  return { mode: "uniform", k, tx: screen.x - world.x * k, ty: screen.y - world.y * k };
}

export function zoomedAtCenter(camera: UniformCamera, k: number, viewport: Size): UniformCamera {
  const center = { x: viewport.w / 2, y: viewport.h / 2 };
  return anchoredCamera(k, screenToWorld(camera, center), center);
}
```

Create `packages/trace-viewer/src/ui/views/map/overlay.ts`:

```ts
import type { TraceSession } from "../../../model/index.js";

/** Phase C session state of a card (spec §3.4); red only for "failing". */
export type MapCardState = "new" | "changed" | "decision" | "failing";

export interface MapOverlay {
  cardState: ReadonlyMap<string, MapCardState>;
  /** Edge keys "<from>><to>" the session touched. */
  emphasizedEdges: ReadonlySet<string>;
}

/** Phase B has no session overlay. Lane 07 (S-5) derives it from session.explainer.highlights. */
export function mapOverlayOf(session: TraceSession): MapOverlay | null {
  void session;
  return null;
}
```

Create `packages/trace-viewer/src/ui/views/map/map-text.ts`:

```ts
import type { Citation } from "@jevcode/contracts";

import { displayUntrusted, overviewStatusOf, type OverviewModel } from "../../../model/index.js";

/** Ruling R3 narrator states in quiet words (spec §6.6: never an error banner); "ready" says nothing. */
const NARRATOR_WORD = { off: "Descriptions off", unavailable: "Descriptions unavailable", pending: "Descriptions pending" } as const;

/** The rule-based header (spec §3.4): "12 components" with up to three languages by file count beside it in muted ink. */
export function overviewHeadline(overview: OverviewModel): { count: string; languages: string | null } {
  const snapshot = overview.snapshot;
  const n = snapshot.components.length;
  const languages = snapshot.counts.languages.slice(0, 3).map((language) => displayUntrusted(language));
  return {
    count: `${n.toLocaleString("en-US")} ${n === 1 ? "component" : "components"}`,
    languages: languages.length === 0 ? null : languages.join(" · "),
  };
}

export type SentencePart = { text: string } | { text: string; componentId: string };

const isWordChar = (char: string | undefined): boolean => char !== undefined && /[\p{L}\p{N}_]/u.test(char);

/** First whole-word, case-insensitive occurrence of `needle` in `haystack` (both lower-cased) that overlaps no taken span; -1 when none. */
function findWord(haystack: string, needle: string, taken: readonly { start: number; end: number }[]): number {
  if (needle === "") return -1;
  for (let from = 0; ; ) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return -1;
    const end = at + needle.length;
    const clear = !isWordChar(haystack[at - 1]) && !isWordChar(haystack[end]) && !taken.some((span) => at < span.end && end > span.start);
    if (clear) return at;
    from = at + 1;
  }
}

/**
 * A narrator sentence as plain text with its cited components as links (the approved Map header: "component names are
 * quiet links"). A cited name is linked where it first appears as a whole word, ignoring case; a name the sentence
 * does not spell out is appended as a link after it. File citations and components missing from the map are skipped
 * (the Map header no longer uses citation chips). The sentence and every name pass through displayUntrusted first.
 */
export function linkSentence(sentence: { text: string; citations: readonly Citation[] }, overview: OverviewModel): SentencePart[] {
  const text = displayUntrusted(sentence.text);
  const lower = text.toLowerCase();
  const aligned = lower.length === text.length; // a few characters change length when lower-cased; then nothing links inline
  const found: { start: number; end: number; id: string }[] = [];
  const trailing: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const citation of sentence.citations) {
    if (citation.kind !== "component" || seen.has(citation.id)) continue;
    seen.add(citation.id);
    const component = overview.componentById.get(citation.id);
    if (component === undefined) continue;
    const name = displayUntrusted(component.name);
    const at = aligned ? findWord(lower, name.toLowerCase(), found) : -1;
    if (at < 0) trailing.push({ id: component.id, name });
    else found.push({ start: at, end: at + name.length, id: component.id });
  }
  found.sort((a, b) => a.start - b.start);
  const parts: SentencePart[] = [];
  let cursor = 0;
  for (const hit of found) {
    if (hit.start > cursor) parts.push({ text: text.slice(cursor, hit.start) });
    parts.push({ text: text.slice(hit.start, hit.end), componentId: hit.id });
    cursor = hit.end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  for (const link of trailing) parts.push({ text: " " }, { text: link.name, componentId: link.id });
  return parts;
}

/** Spec §3.4 and E14: "Imports not analyzed for Python" when some components have no supported grammar. */
export function notAnalyzedNote(overview: OverviewModel): string | null {
  const languages = new Set<string>();
  let unnamed = false;
  for (const component of overview.snapshot.components) {
    if (component.importsAnalyzed) continue;
    if (component.language === null) unnamed = true;
    else languages.add(displayUntrusted(component.language));
  }
  const list = [...languages].sort();
  if (list.length === 0 && unnamed) list.push("some files");
  return list.length === 0 ? null : `Imports not analyzed for ${list.join(", ")}`;
}

/** Spec §5.1: past the 20,000-file cap the map is partial, with the counts (counts.totalFiles, ruling R3, when known). */
export function partialNote(overview: OverviewModel): string | null {
  const { partial, counts } = overview.snapshot;
  if (!partial) return null;
  const files = counts.files.toLocaleString("en-US");
  return counts.totalFiles === undefined
    ? `Partial map · ${files} files mapped`
    : `Partial map · ${files} of ${counts.totalFiles.toLocaleString("en-US")} files`;
}

/** Ruling R3 narrator state as a quiet note; null when the narrator is ready. */
export function narratorNote(overview: OverviewModel): string | null {
  const narrator = overviewStatusOf(overview.snapshot).narrator;
  return narrator === "ready" ? null : NARRATOR_WORD[narrator];
}

export interface ScanNote {
  state: "running" | "failed";
  text: string;
  /** The failure message, untrusted, for the tooltip only. */
  detail: string | null;
}

/** Ruling R3 scan state (spec §6.1 progress, §6.6 failure); null when the scan is done. */
export function scanNote(overview: OverviewModel): ScanNote | null {
  const scan = overviewStatusOf(overview.snapshot).scan;
  if (scan.state === "running") {
    return { state: "running", text: `Mapping codebase · ${scan.scanned.toLocaleString("en-US")} / ${scan.total.toLocaleString("en-US")} files`, detail: null };
  }
  if (scan.state === "failed") {
    return { state: "failed", text: "Codebase map unavailable", detail: scan.error === undefined ? null : displayUntrusted(scan.error) };
  }
  return null;
}
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/map/map-nav.test.ts src/ui/views/map/map-camera.test.ts src/ui/views/map/map-text.test.ts` — expected: PASS.

- [ ] **Step 7: Write the view tests (failing)**

Create `packages/trace-viewer/src/ui/views/map/map-view.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OverviewSnapshot } from "@jevcode/contracts";

import { layoutMap, mapHubIds } from "../../../layout/map-layout.js";
import { buildOverviewModel, type TraceSession } from "../../../model/index.js";
import {
  renderWithViewer,
  stubAnimationFrames,
  stubElementBox,
  stubReducedMotion,
  stubResizeObserver,
  type ResizeObserverStub,
} from "../../../test-support/canvas-view-harness.js";
import { componentId, overviewSnapshot, syntheticOverview } from "../../../test-support/overview-builder.js";
import { buildSession } from "../../../test-support/session-builder.js";
import { Inspector } from "../../inspector/Inspector.js";
import { planMapFit } from "./map-camera.js";
import { MapView } from "./MapView.js";

let resize: ResizeObserverStub;

beforeEach(() => {
  resize = stubResizeObserver();
  stubElementBox(1200, 800);
  stubAnimationFrames();
  stubReducedMotion(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function sessionWith(snapshot: OverviewSnapshot | null): TraceSession {
  return buildSession({
    steps: [{ kind: "instruction", tMs: 0, text: "Map the repo" }],
    ...(snapshot === null ? {} : { overview: snapshot }),
  });
}

function renderMap(snapshot: OverviewSnapshot | null) {
  const harness = renderWithViewer(
    <>
      <MapView active />
      <Inspector host={{}} />
    </>,
    { session: sessionWith(snapshot), state: { view: "map" } },
  );
  act(() => resize.resize(1200, 800));
  return harness;
}

function cardOf(rootPath: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-map-card="${componentId(rootPath)}"]`);
  if (element === null) throw new Error(`no card for ${rootPath}`);
  return element;
}

const edgeOf = (from: string, to: string): Element | null =>
  document.querySelector(`[data-map-edge="${componentId(from)}>${componentId(to)}"]`);

const WEB_API_DB = overviewSnapshot({
  components: [
    { rootPath: "apps/web", role: "ui", purpose: "Browser app.", provenance: "model" },
    { rootPath: "packages/api", role: "api" },
    { rootPath: "packages/db", role: "storage" },
    { rootPath: "scripts", role: "tooling" },
  ],
  edges: [
    { from: "apps/web", to: "packages/api", count: 3 },
    { from: "packages/api", to: "packages/db", count: 12 },
    { from: "apps/web", to: "packages/db", count: 1 },
  ],
});

describe("MapView (spec §3.4, E13)", () => {
  it("renders every component as a card in its role band, with its edges", () => {
    renderMap(WEB_API_DB);
    expect(document.querySelectorAll("[data-map-card]")).toHaveLength(4);
    expect([...document.querySelectorAll("[data-map-band]")].map((element) => element.getAttribute("data-map-band"))).toEqual([
      "ui",
      "api",
      "storage",
      "side",
    ]);
    expect(document.querySelectorAll("[data-map-lane]")).toHaveLength(4);
    expect(document.querySelector("[data-map-band='side']")?.textContent).toContain("Support");
    expect(document.querySelectorAll("[data-map-edge]")).toHaveLength(3);
    expect(screen.getByRole("group", { name: "Codebase map, 4 components" })).toBeTruthy();
    // The card face is name and footer; the purpose (or the root path) is in its accessible name and tooltip, and on the detail level.
    expect(cardOf("apps/web").getAttribute("aria-label")).toContain("Browser app.");
    expect(cardOf("packages/api").getAttribute("aria-label")).toContain("packages/api");
    expect(document.querySelector("[data-map-external]")).toBeNull();
  });

  it("Fit centers the map and refits when the viewport resizes", () => {
    renderMap(WEB_API_DB);
    const transform = (): string | undefined => document.querySelector<HTMLElement>("[data-tv-world]")?.style.transform;
    const expected = (w: number, h: number): string => {
      const plan = planMapFit(buildOverviewModel(WEB_API_DB, 1), { w, h });
      if (plan === null) throw new Error("no fit");
      return `translate(${plan.camera.tx}px, ${plan.camera.ty}px) scale(${plan.camera.k})`;
    };
    expect(transform()).toBe(expected(1200, 800));
    act(() => resize.resize(800, 600));
    expect(transform()).toBe(expected(800, 600));
  });

  it("shows a quiet empty state without a snapshot", () => {
    renderMap(null);
    expect(screen.getByText("No codebase map yet")).toBeTruthy();
    expect(document.querySelector("[role='alert']")).toBeNull();
  });

  it("selecting a card lights its one-hop edges, dims the rest and opens the component Inspector", async () => {
    const user = userEvent.setup();
    const { store } = renderMap(WEB_API_DB);
    await user.click(cardOf("packages/api"));
    expect(store.get().mapSelection).toBe(componentId("packages/api"));
    expect(cardOf("packages/api").getAttribute("aria-pressed")).toBe("true");
    expect(edgeOf("apps/web", "packages/api")?.hasAttribute("data-lit")).toBe(true);
    expect(edgeOf("packages/api", "packages/db")?.hasAttribute("data-lit")).toBe(true);
    expect(edgeOf("apps/web", "packages/db")?.hasAttribute("data-dim")).toBe(true);
    expect(document.querySelector(`[data-component-inspector="${componentId("packages/api")}"]`)).not.toBeNull();
  });

  it("hovering a card lights its edges like a selection, without selecting it", async () => {
    const user = userEvent.setup();
    const { store } = renderMap(WEB_API_DB);
    await user.hover(cardOf("packages/api"));
    expect(edgeOf("apps/web", "packages/api")?.hasAttribute("data-lit")).toBe(true);
    expect(edgeOf("apps/web", "packages/db")?.hasAttribute("data-dim")).toBe(true);
    expect(store.get().mapSelection).toBeNull();
    await user.unhover(cardOf("packages/api"));
    expect(document.querySelector("[data-lit], [data-dim]")).toBeNull();
  });

  it("at rest draws band-to-band edges that do not enter a hub; a hub shows a stub, and its edges and same-band edges join on selection", async () => {
    const user = userEvent.setup();
    const importers = ["apps/web", "srv/api", "pkg/agent", "pkg/store", "pkg/a", "pkg/b"];
    renderMap(
      overviewSnapshot({
        components: [
          { rootPath: "pkg/contracts", name: "contracts", role: "domain" },
          { rootPath: "apps/web", role: "ui" },
          { rootPath: "srv/api", role: "api" },
          { rootPath: "pkg/agent", role: "agent" },
          { rootPath: "pkg/store", role: "storage" },
          { rootPath: "pkg/a", role: "domain" },
          { rootPath: "pkg/b", role: "domain" },
        ],
        edges: [
          ...importers.map((from) => ({ from, to: "pkg/contracts", count: 2 })),
          { from: "apps/web", to: "srv/api", count: 3 },
          { from: "pkg/a", to: "pkg/b", count: 1 },
        ],
      }),
    );
    const stub = `[data-map-hub-stub="${componentId("pkg/contracts")}"]`;
    expect(document.querySelectorAll("[data-map-edge]")).toHaveLength(1);
    expect(edgeOf("apps/web", "srv/api")).not.toBeNull();
    expect(document.querySelector(stub)).not.toBeNull();
    await user.click(cardOf("pkg/contracts"));
    expect(document.querySelectorAll("[data-map-edge][data-lit]")).toHaveLength(6);
    expect(edgeOf("apps/web", "srv/api")?.hasAttribute("data-dim")).toBe(true);
    expect(document.querySelector(stub)).toBeNull();
    expect(edgeOf("pkg/a", "pkg/b")).toBeNull();
    await user.click(cardOf("pkg/a"));
    expect(edgeOf("pkg/a", "pkg/b")?.hasAttribute("data-lit")).toBe(true);
  });

  it("Esc and a background click clear the map selection; the Inspector leaves the component", async () => {
    const user = userEvent.setup();
    const { store } = renderMap(WEB_API_DB);
    await user.click(cardOf("packages/api"));
    act(() => store.dispatch({ type: "esc" }));
    expect(store.get().mapSelection).toBeNull();
    expect(document.querySelector("[data-component-inspector]")).toBeNull();
    expect(cardOf("packages/api").getAttribute("aria-pressed")).toBe("false");
    await user.click(cardOf("packages/db"));
    const viewport = document.querySelector<HTMLElement>("[data-tv-viewport='map']");
    if (viewport === null) throw new Error("no map viewport");
    await user.click(viewport);
    expect(store.get().mapSelection).toBeNull();
  });

  it("moves focus between cards with the arrow keys, Home and End, and selects with Enter", async () => {
    const user = userEvent.setup();
    const { store } = renderMap(WEB_API_DB);
    const web = cardOf("apps/web");
    expect(web.tabIndex).toBe(0);
    expect(cardOf("packages/api").tabIndex).toBe(-1);
    act(() => web.focus());
    fireEvent.keyDown(web, { key: "ArrowRight" });
    expect(document.activeElement).toBe(cardOf("packages/api"));
    expect(cardOf("packages/api").tabIndex).toBe(0);
    fireEvent.keyDown(cardOf("packages/api"), { key: "End" });
    expect(document.activeElement).toBe(cardOf("scripts"));
    fireEvent.keyDown(cardOf("scripts"), { key: "Home" });
    expect(document.activeElement).toBe(web);
    await user.keyboard("{Enter}");
    expect(store.get().mapSelection).toBe(componentId("apps/web"));
  });

  it("a new snapshot keeps focus, the selection and the placed order", async () => {
    const user = userEvent.setup();
    const harness = renderMap(WEB_API_DB);
    await user.click(cardOf("packages/api"));
    act(() => cardOf("packages/api").focus());
    const next = overviewSnapshot({
      components: [
        { rootPath: "apps/web", role: "ui", purpose: "Browser app and dashboard.", provenance: "model" },
        { rootPath: "packages/api", role: "api" },
        { rootPath: "packages/auth", role: "api" },
        { rootPath: "packages/db", role: "storage" },
        { rootPath: "scripts", role: "tooling" },
      ],
      edges: [{ from: "apps/web", to: "packages/api", count: 3 }, { from: "packages/api", to: "packages/db", count: 12 }],
    });
    act(() => harness.setSession(sessionWith(next)));
    expect(document.activeElement).toBe(cardOf("packages/api"));
    expect(harness.store.get().mapSelection).toBe(componentId("packages/api"));
    expect(Number.parseFloat(cardOf("packages/api").style.top)).toBeLessThan(Number.parseFloat(cardOf("packages/auth").style.top));
    expect(cardOf("apps/web").textContent).toContain("Browser app and dashboard.");
  });

  it("registers a map view port with a zoom label and no reading order", () => {
    const { registry } = renderMap(WEB_API_DB);
    const port = registry.get("map");
    expect(port).toBeDefined();
    expect(port?.zoom.label()).toMatch(/^\d+%$/);
    expect(port?.readingOrder()).toEqual([]);
    expect(port?.captureCamera()).toBeNull();
  });

  it("Review Focus 2: hostile purpose, name and narrative render as plain text", async () => {
    const hostile = "Ships builds‮txt.exe **now** [docs](https://evil.example) <img src=x onerror=alert(1)>";
    const shown = "Ships builds⟨U+202E⟩txt.exe **now** [docs](https://evil.example) <img src=x onerror=alert(1)>";
    const evil = componentId("packages/evil");
    const user = userEvent.setup();
    const { result } = renderMap(
      overviewSnapshot({
        components: [
          { rootPath: "packages/evil", name: "evil‮name", role: "domain", purpose: hostile, provenance: "model", language: "Type‮Script" },
        ],
        narrative: {
          provenance: "model",
          sentences: [{ text: "Overview ‮**bold** https://evil.example", citations: [{ kind: "component", id: evil }] }],
        },
      }),
    );
    const card = cardOf("packages/evil");
    // The purpose shows on the detail-level card (map-card.test.tsx); here it is in the tooltip and the accessible name.
    expect(card.textContent).toContain("evil⟨U+202E⟩name");
    for (const value of [card.getAttribute("aria-label"), card.getAttribute("title")]) {
      expect(value).toContain("⟨U+202E⟩");
      expect(value).toContain(shown);
      expect(value).not.toContain("‮");
    }
    expect(screen.getByText(/^Overview ⟨U\+202E⟩\*\*bold\*\* https:\/\/evil\.example$/)).toBeTruthy();
    expect(document.querySelector(`[data-map-cite="${evil}"]`)?.textContent).toBe("evil⟨U+202E⟩name");
    await user.click(card);
    const inspector = document.querySelector(`[data-component-inspector="${evil}"]`);
    expect(inspector?.textContent).toContain(shown);
    expect(inspector?.textContent).toContain("evil⟨U+202E⟩name");
    expect(inspector?.textContent).toContain("Type⟨U+202E⟩Script");
    expect(result.container.querySelectorAll("strong, em, a, img")).toHaveLength(0);
    expect(result.container.textContent).not.toContain("‮");
  });

  it("Review Focus 1: a Python repo shows its components and a quiet imports-not-analyzed note, with no edges", () => {
    renderMap(
      overviewSnapshot({
        components: [
          { rootPath: "app", role: "api", language: "Python", importsAnalyzed: false },
          { rootPath: "lib", role: "domain", language: "Python", importsAnalyzed: false },
          { rootPath: "tests", role: "tests", language: "Python", importsAnalyzed: false },
        ],
      }),
    );
    expect(document.querySelectorAll("[data-map-card]")).toHaveLength(3);
    expect(screen.getByText("Imports not analyzed for Python")).toBeTruthy();
    expect(document.querySelectorAll("[data-map-edge]")).toHaveLength(0);
    expect(document.querySelector("[role='alert']")).toBeNull();
  });

  it("Review Focus 1: a partial map says so with its file count", () => {
    renderMap(overviewSnapshot({ components: [{ rootPath: "src", role: "domain" }], partial: true, files: 20_000 }));
    expect(screen.getByText("Partial map · 20,000 files mapped")).toBeTruthy();
    expect(document.querySelectorAll("[data-map-card]")).toHaveLength(1);
  });

  it("Review Focus 1: a 200-component partial snapshot renders every card", () => {
    const snapshot = syntheticOverview({ components: 200, edges: 1_000, seed: 3, partial: true });
    renderMap(snapshot);
    // At rest only band-to-band edges that do not enter a hub are drawn.
    const layout = layoutMap(buildOverviewModel(snapshot, 1), { level: "card" });
    const hubs = mapHubIds(layout.edges, layout.cards.length);
    const atRest = layout.edges.filter((edge) => edge.kind !== "same" && !hubs.has(edge.to)).length;
    expect(document.querySelectorAll("[data-map-card]")).toHaveLength(200);
    expect(atRest).toBeGreaterThan(0);
    expect(document.querySelectorAll("[data-map-edge]")).toHaveLength(atRest);
    expect(screen.getByText(/^Partial map · /)).toBeTruthy();
  });

  it("Review Focus 1: a partial map with the repository's total says how much it mapped", () => {
    renderMap(overviewSnapshot({ components: [{ rootPath: "src", role: "domain" }], partial: true, files: 20_000, totalFiles: 25_310 }));
    expect(screen.getByText("Partial map · 20,000 of 25,310 files")).toBeTruthy();
  });

  it("Review Focus 5: the Map says the narrator is off, quietly", () => {
    renderMap(
      overviewSnapshot({ components: [{ rootPath: "src", role: "domain" }], status: { scan: { state: "done", scanned: 1, total: 1 }, narrator: "off" } }),
    );
    expect(screen.getByText("Descriptions off")).toBeTruthy();
    expect(screen.queryByText("Descriptions pending")).toBeNull();
    expect(document.querySelector("[role='alert']")).toBeNull();
  });

  it("shows the narrative as plain sentences with component links: two sentences, then More; a link hovers and selects like its card", async () => {
    const user = userEvent.setup();
    const web = { kind: "component" as const, id: componentId("apps/web") };
    const api = { kind: "component" as const, id: componentId("packages/api") };
    const db = { kind: "component" as const, id: componentId("packages/db") };
    const { store } = renderMap(
      overviewSnapshot({
        components: [
          { rootPath: "apps/web", name: "web", role: "ui" },
          { rootPath: "packages/api", name: "api", role: "api" },
          { rootPath: "packages/db", name: "db", role: "storage" },
        ],
        edges: [{ from: "apps/web", to: "packages/api", count: 3 }, { from: "packages/api", to: "packages/db", count: 12 }],
        narrative: {
          provenance: "model",
          sentences: [
            { text: "web talks to api.", citations: [web, api] },
            { text: "api stores data in db.", citations: [api, db] },
            { text: "A third sentence stays behind More.", citations: [] },
          ],
        },
      }),
    );
    expect(document.querySelectorAll("[data-map-narrative] [data-map-cite]")).toHaveLength(4);
    expect(screen.queryByText(/third sentence/)).toBeNull();
    const apiLink = document.querySelector<HTMLElement>(`[data-map-narrative] [data-map-cite="${api.id}"]`);
    if (apiLink === null) throw new Error("no api link");
    await user.hover(apiLink);
    expect(edgeOf("apps/web", "packages/api")?.hasAttribute("data-lit")).toBe(true);
    await user.unhover(apiLink);
    await user.click(apiLink);
    expect(store.get().mapSelection).toBe(api.id);
    expect(document.querySelector(`[data-map-narrative] [data-map-cite="${api.id}"]`)?.hasAttribute("data-selected")).toBe(true);
    await user.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByText(/third sentence/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Overview" }));
    expect(document.querySelector("[data-map-narrative]")).toBeNull();
  });

  it("a running scan shows its progress; a failed scan says the map is unavailable, quietly", () => {
    const harness = renderMap(
      overviewSnapshot({ components: [], status: { scan: { state: "running", scanned: 3_200, total: 9_800 }, narrator: "pending" } }),
    );
    expect(screen.getAllByText("Mapping codebase · 3,200 / 9,800 files")).toHaveLength(2);
    act(() =>
      harness.setSession(
        sessionWith(
          overviewSnapshot({
            components: [{ rootPath: "src", role: "domain" }],
            status: { scan: { state: "failed", scanned: 0, total: 0, error: "git ls-files \u202Efailed" }, narrator: "off" },
          }),
        ),
      ),
    );
    const note = document.querySelector("[data-map-note='scan-failed']");
    expect(note?.textContent).toBe("Codebase map unavailable");
    expect(note?.getAttribute("title")).toBe("git ls-files ⟨U+202E⟩failed");
    expect(document.querySelectorAll("[data-map-card]")).toHaveLength(1);
    expect(document.querySelector("[role='alert']")).toBeNull();
  });
});
```

Create `packages/trace-viewer/src/ui/views/map/map-card.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MapCard as MapCardBox, MapLevel } from "../../../layout/map-layout.js";
import { buildOverviewModel } from "../../../model/index.js";
import { componentId, overviewSnapshot } from "../../../test-support/overview-builder.js";
import { MapCard, type MapCardProps } from "./MapCard.js";

afterEach(() => cleanup());

// One component, 61 of 122 files at most: the file bar is round(100 · √(61 ÷ 122)) = 71%.
const MAIN = "apps/desktop/src/main";
const overview = buildOverviewModel(
  overviewSnapshot({
    components: [
      {
        rootPath: MAIN,
        name: "desktop main",
        role: "api",
        purpose: "Electron main process: IPC handlers and the event pipeline.",
        provenance: "model",
        fileCount: 61,
        externalDeps: [{ name: "node-pty", count: 2 }, { name: "electron", count: 9 }, { name: "zod", count: 1 }],
      },
      {
        rootPath: "packages/evil",
        name: "evil‮name",
        role: "domain",
        purpose: "Ships builds‮txt.exe **now** [docs](https://evil.example) <img src=x onerror=alert(1)>",
        provenance: "model",
        externalDeps: [{ name: "pkg‮x", count: 3 }],
      },
      { rootPath: "pkg/long-component-name-without-spaces", name: "long-component-name-without-spaces", role: "domain" },
    ],
  }),
  1,
);

function renderCard(level: MapLevel, rootPath = MAIN, overrides: Partial<MapCardProps> = {}) {
  const component = overview.componentById.get(componentId(rootPath));
  if (component === undefined) throw new Error("no component");
  const box: MapCardBox = { id: component.id, band: "api", x: 0, y: 0, w: 140, h: 76 };
  const props: MapCardProps = {
    box, component, level, selected: false, tabStop: true, maxFiles: 122, hubImporters: null, state: null, onSelect: () => undefined, onHover: () => undefined, ...overrides,
  };
  return render(<MapCard {...props} />);
}

const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);

describe("MapCard content by level (revised Map mockup)", () => {
  it("chip: the name and a footer of role icon and file bar, no count, purpose or packages", () => {
    renderCard("chip");
    expect(q("button")?.textContent).toContain("desktop main");
    expect(q("[data-map-bar]")?.style.width).toBe("71%");
    expect(q("[data-map-count]")).toBeNull();
    expect(q("[data-map-purpose]")).toBeNull();
    expect(q("[data-map-packages]")).toBeNull();
  });

  it("card: adds the right-aligned file count", () => {
    renderCard("card");
    expect(q("[data-map-count]")?.textContent).toBe("61");
    expect(q("[data-map-purpose]")).toBeNull();
    expect(q("[data-map-bar]")?.style.width).toBe("71%");
  });

  it("detail: the purpose, the top two packages, 'n files' and, for a hub, the glyph with its importer count", () => {
    renderCard("detail", MAIN, { hubImporters: 13 });
    expect(q("[data-map-purpose]")?.textContent).toBe("Electron main process: IPC handlers and the event pipeline.");
    expect(q("[data-map-packages]")?.textContent).toBe("electron · node-pty");
    expect(q("[data-map-count]")?.textContent).toBe("61 files");
    expect(q("[data-map-hub]")?.textContent).toBe("13");
    expect(q("[data-map-hub]")?.getAttribute("title")).toBe("Imported by 13 components");
  });

  it("shows the hub glyph on the detail level only, but names the hub in the accessible name at every level", () => {
    renderCard("card", MAIN, { hubImporters: 13 });
    expect(q("[data-map-hub]")).toBeNull();
    expect(q("button")?.getAttribute("aria-label")).toContain("imported by 13 components");
  });

  it("gives a name its full text and falls back to the root path as the purpose", () => {
    renderCard("detail", "pkg/long-component-name-without-spaces");
    expect(q("button")?.textContent).toContain("long-component-name-without-spaces");
    expect(q("[data-map-purpose][data-fallback]")?.textContent).toBe("pkg/long-component-name-without-spaces");
  });

  it("a session state mark takes the place of the count", () => {
    renderCard("card", MAIN, { state: "changed" });
    expect(q("[data-state='changed']")).not.toBeNull();
    expect(q("[data-map-count]")).toBeNull();
    expect(q("button")?.getAttribute("aria-label")).toContain("changed in this session");
  });

  it("Review Focus 2: a hostile purpose, name and package render as plain text on the detail card", () => {
    const { container } = renderCard("detail", "packages/evil");
    expect(q("[data-map-purpose]")?.textContent).toBe(
      "Ships builds⟨U+202E⟩txt.exe **now** [docs](https://evil.example) <img src=x onerror=alert(1)>",
    );
    expect(q("[data-map-packages]")?.textContent).toBe("pkg⟨U+202E⟩x");
    expect(container.querySelectorAll("strong, em, a, img")).toHaveLength(0);
    expect(container.textContent).not.toContain("‮");
  });

  it("reports hover and click by id, and is a tab stop only when told", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onHover = vi.fn();
    renderCard("card", MAIN, { onSelect, onHover, tabStop: false });
    const card = q("button");
    if (card === null) throw new Error("no card");
    expect(card.tabIndex).toBe(-1);
    await user.hover(card);
    await user.unhover(card);
    await user.click(card);
    expect(onHover.mock.calls).toEqual([[componentId(MAIN)], [null]]);
    expect(onSelect).toHaveBeenCalledWith(componentId(MAIN));
  });
});
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/map/map-card.test.tsx`

Expected: FAIL to load (`Cannot find module './MapCard.js'`).

Create `packages/trace-viewer/src/ui/inspector/component-inspector.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { renderWithViewer } from "../../test-support/canvas-view-harness.js";
import { componentId, overviewSnapshot } from "../../test-support/overview-builder.js";
import { buildSession } from "../../test-support/session-builder.js";
import type { ViewState } from "../state/view-state.js";
import { Inspector } from "./Inspector.js";

afterEach(() => cleanup());

const MAIN = "apps/desktop/src/main";
const snapshot = overviewSnapshot({
  components: [
    {
      rootPath: MAIN,
      name: "desktop main",
      role: "api",
      roleGuess: "ui",
      purpose: "Electron main process: IPC handlers and the event pipeline.",
      provenance: "model",
      files: Array.from({ length: 25 }, (_, i) => `${MAIN}/f${String(i).padStart(2, "0")}.ts`),
      fileCount: 61,
      externalDeps: [{ name: "node-pty", count: 2 }, { name: "electron", count: 9 }],
    },
    { rootPath: "packages/contracts", name: "contracts", role: "domain" },
    { rootPath: "apps/desktop/src/renderer", name: "desktop renderer", role: "ui" },
  ],
  edges: [
    { from: MAIN, to: "packages/contracts", count: 22, examples: [`${MAIN}/ipc.ts → packages/contracts/src/index.ts`] },
    { from: "apps/desktop/src/renderer", to: MAIN, count: 2 },
  ],
  narrative: {
    provenance: "model",
    sentences: [
      { text: "The main process feeds the pipeline.", citations: [{ kind: "component", id: componentId(MAIN) }] },
      { text: "Contracts holds the schemas.", citations: [{ kind: "component", id: componentId("packages/contracts") }] },
    ],
  },
});
const session = buildSession({
  steps: [
    { kind: "instruction", tMs: 0, text: "Add the explainer stage" },
    { kind: "edit", tMs: 1_000, target: `${MAIN}/pipeline/explainer-stage.ts`, edit: { added: 120, removed: 4 } },
    { kind: "edit", tMs: 2_000, target: "packages/contracts/src/overview.ts", edit: { added: 40, removed: 0 } },
  ],
  overview: snapshot,
});

function renderInspector(state: Partial<ViewState>) {
  return renderWithViewer(<Inspector host={{}} />, { session, state });
}

function panel(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-component-inspector="${id}"]`);
  if (element === null) throw new Error(`no component inspector for ${id}`);
  return element;
}

function part(root: HTMLElement, selector: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`no ${selector}`);
  return element;
}

describe("ComponentInspector (spec §3.4)", () => {
  it("shows role, provenance, purpose, files, imports, packages, session changes and citations", () => {
    renderInspector({ view: "map", mapSelection: componentId(MAIN) });
    const root = panel(componentId(MAIN));
    const inside = within(root);
    expect(inside.getByRole("heading", { level: 2, name: "desktop main" })).toBeTruthy();
    expect(inside.getByText("API · described by model")).toBeTruthy();
    expect(inside.getByText("· guessed UI")).toBeTruthy();
    expect(inside.getByText("Electron main process: IPC handlers and the event pipeline.")).toBeTruthy();
    expect(root.querySelectorAll("[data-component-file]")).toHaveLength(20);
    expect(inside.getByText("41 more")).toBeTruthy();
    const out = within(part(root, "[data-imports='out']"));
    expect(out.getByText("contracts")).toBeTruthy();
    expect(out.getByText("22")).toBeTruthy();
    expect(out.getByText(`${MAIN}/ipc.ts → packages/contracts/src/index.ts`)).toBeTruthy();
    const into = within(part(root, "[data-imports='in']"));
    expect(into.getByText("desktop renderer")).toBeTruthy();
    expect(into.getByText("2")).toBeTruthy();
    expect([...root.querySelectorAll("[data-component-package]")].map((row) => row.textContent)).toEqual(["electron9", "node-pty2"]);
    const changes = root.querySelectorAll("[data-component-change]");
    expect(changes).toHaveLength(1);
    expect(changes[0]?.textContent).toContain("explainer-stage.ts");
    expect(inside.getByText("The main process feeds the pipeline.")).toBeTruthy();
    expect(inside.queryByText("Contracts holds the schemas.")).toBeNull();
  });

  it("scales a 4 px bar by each row's share of the largest count in its list, up to 48 px", () => {
    renderInspector({ view: "map", mapSelection: componentId(MAIN) });
    const root = panel(componentId(MAIN));
    const widths = (selector: string): string[] => [...root.querySelectorAll<HTMLElement>(`${selector} [data-list-bar]`)].map((bar) => bar.style.width);
    expect(widths("[data-imports='out']")).toEqual(["48px"]);
    expect(widths("[data-imports='in']")).toEqual(["48px"]);
    // electron 9 is the largest, node-pty 2 is round(48 · 2 ÷ 9) = 11.
    expect(widths("[data-component-package]")).toEqual(["48px", "11px"]);
  });

  it("a session change opens its step and leaves the component", async () => {
    const user = userEvent.setup();
    const { store } = renderInspector({ view: "map", mapSelection: componentId(MAIN) });
    await user.click(part(panel(componentId(MAIN)), "[data-component-change]"));
    expect(store.get().mapSelection).toBeNull();
    expect(store.get().selection).toBe(session.steps.find((step) => step.edit?.path === `${MAIN}/pipeline/explainer-stage.ts`)?.id);
  });

  it("a rule-based component without a purpose says so quietly", () => {
    renderInspector({ view: "map", mapSelection: componentId("packages/contracts") });
    expect(screen.getByText("No description yet")).toBeTruthy();
    expect(screen.getByText("Domain · rule-based")).toBeTruthy();
  });

  it("ignores the map selection outside the Map view", () => {
    renderInspector({ view: "hybrid", mapSelection: componentId(MAIN) });
    expect(document.querySelector("[data-component-inspector]")).toBeNull();
  });

  it("a component missing from the latest snapshot shows a quiet note", () => {
    renderInspector({ view: "map", mapSelection: "cmp_000000000000" });
    expect(screen.getByText("This component is no longer in the map.")).toBeTruthy();
  });
});
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/map/map-view.test.tsx src/ui/inspector/component-inspector.test.tsx`

Expected: FAIL to load: `Cannot find module './MapView.js'` (map-view) and every component-inspector test fails (`no component inspector for cmp_…`), because the Inspector does not branch on `mapSelection` yet.

- [ ] **Step 8: Write the cards, edges and header**

Create `packages/trace-viewer/src/ui/views/map/MapCard.tsx`:

```tsx
import { memo } from "react";
import type React from "react";

import type { Component } from "@jevcode/contracts";

import { fileBarPercent, topPackages } from "../../../layout/map-details.js";
import type { MapCard as MapCardBox, MapLevel } from "../../../layout/map-layout.js";
import { displayUntrusted, truncateMiddle } from "../../../model/index.js";
import { Icon } from "../../icons/Icon.js";
import { ROLE_ICON, ROLE_LABEL } from "../../icons/kind-icons.js";
import type { MapCardState } from "./overlay.js";
import styles from "./MapView.module.css";

export interface MapCardProps {
  box: MapCardBox;
  component: Component;
  level: MapLevel;
  selected: boolean;
  tabStop: boolean;
  /** The file count of the largest component, for the footer bar. */
  maxFiles: number;
  /** Distinct importers when this component is a hub (the glyph shows on the detail level), else null. */
  hubImporters: number | null;
  state: MapCardState | null;
  onSelect(id: string): void;
  onHover(id: string | null): void;
}

const STATE_WORD: { readonly [K in MapCardState]: string } = {
  new: "new in this session",
  changed: "changed in this session",
  decision: "touched by a decision",
  failing: "failing test",
};

/**
 * One component (spec §3.4, revised Map mockup). Same box at every level; the content follows it. Chip: name and a footer
 * of role icon and file bar. Card: plus the count. Detail: plus the purpose, the top two packages, "n files" and the hub
 * glyph. A session state mark (lane 07) replaces the count in the footer.
 */
function MapCardView({ box, component, level, selected, tabStop, maxFiles, hubImporters, state, onSelect, onHover }: MapCardProps): React.JSX.Element {
  const name = displayUntrusted(component.name);
  const purpose = component.purpose === null ? null : displayUntrusted(component.purpose);
  const root = displayUntrusted(component.rootPath);
  const count = component.fileCount.toLocaleString("en-US");
  const files = `${count} ${component.fileCount === 1 ? "file" : "files"}`;
  const importers = hubImporters === null ? null : hubImporters.toLocaleString("en-US");
  const label = [
    name,
    ROLE_LABEL[component.role],
    purpose ?? root,
    files,
    importers === null ? null : `imported by ${importers} components`,
    state === null ? null : STATE_WORD[state],
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
  const packages = level === "detail" ? topPackages(component, 2) : [];
  return (
    <button
      type="button"
      className={styles.card}
      data-map-card={component.id}
      data-level={level}
      data-selected={selected ? "" : undefined}
      aria-pressed={selected}
      aria-label={label}
      title={purpose === null ? `${name}: ${root}` : `${name}: ${purpose}`}
      tabIndex={tabStop ? 0 : -1}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(component.id);
      }}
      onPointerEnter={() => onHover(component.id)}
      onPointerLeave={() => onHover(null)}
    >
      <span className={styles.top}>
        <span className={styles.name}>{name}</span>
        {importers === null || level !== "detail" ? null : (
          <span className={styles.hub} data-map-hub={component.id} title={`Imported by ${importers} components`}>
            <Icon name="fan-in" size={9} />
            <span>{importers}</span>
          </span>
        )}
      </span>
      {level === "detail" ? (
        <>
          {purpose === null ? (
            <span className={styles.purpose} data-map-purpose="" data-fallback="">
              {truncateMiddle(component.rootPath, 40)}
            </span>
          ) : (
            <span className={styles.purpose} data-map-purpose="">
              {purpose}
            </span>
          )}
          {packages.length === 0 ? null : (
            <span className={styles.packages} data-map-packages="">
              {packages.map((ext) => displayUntrusted(ext.name)).join(" · ")}
            </span>
          )}
        </>
      ) : null}
      <span className={styles.foot}>
        <Icon name={ROLE_ICON[component.role]} size={14} />
        <span className={styles.track} aria-hidden="true">
          <i data-map-bar="" style={{ width: `${fileBarPercent(component.fileCount, maxFiles)}%` }} />
        </span>
        {state !== null ? (
          <span className={styles.stateDot} data-state={state} aria-hidden="true" />
        ) : level === "chip" ? null : (
          <span className={styles.count} data-map-count="">
            {level === "detail" ? files : count}
          </span>
        )}
      </span>
    </button>
  );
}

export const MapCard = memo(MapCardView);
```

Create `packages/trace-viewer/src/ui/views/map/MapEdges.tsx`:

```tsx
import { memo, useMemo } from "react";
import type React from "react";

import type { MapEdgePath, MapLayout } from "../../../layout/map-layout.js";
import styles from "./MapView.module.css";

/** Stroke px by `MapEdgePath.width` bucket (revised Map mockup), non-scaling at any zoom. */
export const MAP_EDGE_STROKE: Readonly<Record<MapEdgePath["width"], number>> = { 1: 1, 2: 1.6, 3: 2.4 };

/** A hub's mark: three strokes, 11 long, converging on its left port at (x, y). */
export function hubStubPath(x: number, y: number): string {
  return `M${x - 11} ${y - 7}Q${x - 5} ${y - 7} ${x} ${y}M${x - 11} ${y}H${x}M${x - 11} ${y + 7}Q${x - 5} ${y + 7} ${x} ${y}`;
}

export interface MapEdgesProps {
  layout: MapLayout;
  /** Component ids that are hubs (mapHubIds). */
  hubs: ReadonlySet<string>;
  /** The hovered, else the selected, component: all of its edges show, in accent, on top. */
  activeId: string | null;
  /** Lane 07 overlay: edge keys "<from>><to>" with both ends touched; they always draw. */
  emphasized: ReadonlySet<string> | null;
}

/**
 * One SVG under the cards. At rest it draws band-to-band edges that do not enter a hub (and emphasized session edges);
 * the active card adds all of its own edges, same-band and hub edges included, in accent and drawn last, while every
 * other edge drops to 22% (revised Map mockup, spec §3.4).
 */
function MapEdgesView({ layout, hubs, activeId, emphasized }: MapEdgesProps): React.JSX.Element {
  const rest = useMemo(
    () => layout.edges.filter((edge) => (edge.kind !== "same" && !hubs.has(edge.to)) || emphasized?.has(`${edge.from}>${edge.to}`) === true),
    [layout.edges, hubs, emphasized],
  );
  const touches = (edge: MapEdgePath): boolean => activeId !== null && (edge.from === activeId || edge.to === activeId);
  const lit = activeId === null ? [] : layout.edges.filter(touches);
  const drawn = [...rest.filter((edge) => !touches(edge)), ...lit];
  return (
    <svg className={styles.edges} width={Math.max(1, layout.bounds.w)} height={Math.max(1, layout.bounds.h)} aria-hidden="true" focusable="false">
      {layout.cards
        .filter((card) => hubs.has(card.id) && card.id !== activeId)
        .map((card) => (
          <path key={card.id} d={hubStubPath(card.x, card.y + card.h / 2)} className={styles.stub} data-map-hub-stub={card.id} />
        ))}
      {drawn.map((edge) => {
        const key = `${edge.from}>${edge.to}`;
        const isLit = touches(edge);
        return (
          <path
            key={key}
            d={edge.d}
            className={styles.edge}
            strokeWidth={MAP_EDGE_STROKE[edge.width]}
            data-map-edge={key}
            data-kind={edge.kind}
            data-lit={isLit ? "" : undefined}
            data-dim={activeId !== null && !isLit ? "" : undefined}
            data-emphasized={emphasized?.has(key) === true ? "" : undefined}
          />
        );
      })}
    </svg>
  );
}

export const MapEdges = memo(MapEdgesView);
```

Create `packages/trace-viewer/src/ui/views/map/MapHeader.tsx`:

```tsx
import { useState } from "react";
import type React from "react";

import type { OverviewModel } from "../../../model/index.js";
import { Icon } from "../../icons/Icon.js";
import { linkSentence, narratorNote, notAnalyzedNote, overviewHeadline, partialNote, scanNote } from "./map-text.js";
import styles from "./MapView.module.css";

/** The narrative shows this many sentences; the rest sit behind a quiet "More". */
const NARRATIVE_VISIBLE = 2;

export interface MapHeaderProps {
  overview: OverviewModel;
  onSelectComponent(id: string): void;
  /** Rescan after a failed scan (ViewerHost.rescanOverview); the Retry button shows only when it is given. */
  onRetry?: () => void;
  /** The selected component: its link in the narrative uses accent ink. */
  selectedId?: string | null;
  /** Hovering a component link behaves like hovering its card. */
  onHoverComponent?: (id: string | null) => void;
}

/**
 * Headline, a row of quiet notes (partial, imports, scan, narrator), then the collapsible narrative (spec §3.4 "Top";
 * the approved Map header): plain sentences whose component names are links, two sentences, then "More".
 */
export function MapHeader({ overview, onSelectComponent, onRetry, selectedId = null, onHoverComponent }: MapHeaderProps): React.JSX.Element {
  const [open, setOpen] = useState(true);
  const [more, setMore] = useState(false);
  const sentences = overview.snapshot.narrative?.sentences ?? null;
  const headline = overviewHeadline(overview);
  const partial = partialNote(overview);
  const imports = notAnalyzedNote(overview);
  const scan = scanNote(overview);
  const narrator = narratorNote(overview);
  const shown = sentences === null ? [] : more ? sentences : sentences.slice(0, NARRATIVE_VISIBLE);
  const hasNotes = partial !== null || imports !== null || scan !== null || narrator !== null;
  return (
    <header className={styles.header} data-map-header="">
      <div className={styles.headRow}>
        <Icon name="view-map" size={16} />
        <span className={styles.headline}>{headline.count}</span>
        {headline.languages === null ? null : <span className={styles.languages}>{headline.languages}</span>}
        {sentences === null ? null : (
          <button type="button" className={styles.toggle} aria-expanded={open} aria-controls="tv-map-overview" onClick={() => setOpen((value) => !value)}>
            <span>Overview</span>
            <Icon name={open ? "chev-d" : "chev-r"} size={12} />
          </button>
        )}
      </div>
      {hasNotes ? (
        <div className={styles.notes}>
          {partial === null ? null : (
            <span className={styles.note} data-map-note="partial" title="The scan stopped at the 20,000-file cap">
              <Icon name="stack" size={12} />
              <span>{partial}</span>
            </span>
          )}
          {imports === null ? null : (
            <span className={styles.note} data-map-note="imports">
              {imports}
            </span>
          )}
          {scan === null ? null : (
            <span className={styles.note} data-map-note={`scan-${scan.state}`} title={scan.detail ?? undefined}>
              <Icon name={scan.state === "running" ? "clock" : "eyeoff"} size={12} />
              <span>{scan.text}</span>
              {scan.state === "failed" && onRetry !== undefined ? (
                <button type="button" className={styles.retry} onClick={onRetry}>
                  Retry
                </button>
              ) : null}
            </span>
          )}
          {narrator === null ? null : (
            <span className={styles.note} data-map-note="narrator">
              {narrator}
            </span>
          )}
        </div>
      ) : null}
      {sentences !== null && open ? (
        <p id="tv-map-overview" className={styles.narrative} data-map-narrative="">
          {shown.map((sentence, index) => (
            <span key={index} className={styles.sentence}>
              {linkSentence(sentence, overview).map((part, at) =>
                "componentId" in part ? (
                  <button
                    key={at}
                    type="button"
                    className={styles.ref}
                    data-map-cite={part.componentId}
                    data-selected={part.componentId === selectedId ? "" : undefined}
                    title={part.text}
                    onClick={() => onSelectComponent(part.componentId)}
                    onPointerEnter={() => onHoverComponent?.(part.componentId)}
                    onPointerLeave={() => onHoverComponent?.(null)}
                  >
                    {part.text}
                  </button>
                ) : (
                  part.text
                ),
              )}{" "}
            </span>
          ))}
          {sentences.length > NARRATIVE_VISIBLE && !more ? (
            <button type="button" className={styles.more} onClick={() => setMore(true)}>
              More
            </button>
          ) : null}
        </p>
      ) : null}
    </header>
  );
}
```

- [ ] **Step 9: Write `MapView.tsx` and its styles**

Create `packages/trace-viewer/src/ui/views/map/MapView.tsx`:

```tsx
import { useCallback, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type React from "react";

import {
  MAP_BAND_LABEL_H,
  MAP_LANE_PAD,
  MAP_MARGIN,
  layoutMap,
  mapHubIds,
  mapImporterCounts,
  mapLevelForZoom,
  type MapBand,
  type MapCard as MapCardBox,
  type MapLayoutState,
  type MapLevel,
} from "../../../layout/map-layout.js";
import type { Size, UniformCamera } from "../../../layout/viewport.js";
import type { OverviewModel } from "../../../model/index.js";
import type { IconName } from "../../icons/icon-names.js";
import { Icon } from "../../icons/Icon.js";
import { useSessionView } from "../../shell/session-context.js";
import { ZOOM_STEP } from "../../state/keymap.js";
import { useView, useViewStore } from "../../state/store.js";
import { createViewportController, type ViewportController } from "../../viewport/controller.js";
import { useRegisterViewPort, useViewPortRegistry, type ViewPort, type ViewProps } from "../view-port.js";
import { anchoredCamera, cardCenter, MAP_ICON_ONLY_K, MAP_LIMITS, MAP_ZOOM_PRESETS, planMapFit, revealCamera, zoomedAtCenter } from "./map-camera.js";
import { isMapNavKey, mapNeighbor } from "./map-nav.js";
import { scanNote } from "./map-text.js";
import { MapCard } from "./MapCard.js";
import { MapEdges } from "./MapEdges.js";
import { MapHeader } from "./MapHeader.js";
import styles from "./MapView.module.css";
import { mapOverlayOf } from "./overlay.js";

const BAND_LABEL: { readonly [K in MapBand]: string } = {
  ui: "UI",
  api: "API · IPC",
  agent: "Agents",
  domain: "Domain",
  storage: "Storage",
  side: "Support",
};
const BAND_ICON: { readonly [K in MapBand]: IconName } = {
  ui: "role-ui",
  api: "role-api",
  agent: "role-agent",
  domain: "role-domain",
  storage: "role-storage",
  side: "stack",
};
const START: UniformCamera = { mode: "uniform", tx: 0, ty: 0, k: 0.5 };
const NO_HUBS: ReadonlySet<string> = new Set();
const NO_COUNTS: ReadonlyMap<string, number> = new Map();

function prefersReducedMotion(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  return view !== null && typeof view.matchMedia === "function" && view.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface Latest {
  overview: OverviewModel | null;
  cards: readonly MapCardBox[] | null;
  bounds: { w: number; h: number } | null;
  level: MapLevel;
  active: boolean;
}

/** The codebase Map (spec §3.4, E13): light band lanes, DOM cards and one SVG edge layer in a world layer moved by the shared camera controller. */
export function MapView({ active }: ViewProps): React.JSX.Element {
  const view = useSessionView();
  const store = useViewStore();
  const registry = useViewPortRegistry();
  const selection = useView((state) => state.mapSelection);
  const tool = useView((state) => state.tool);
  const session = view.session;
  const overview = session?.overview ?? null;
  // The level only changes what a card shows (one geometry, so no card moves); it follows the zoom at each settle.
  const [level, setLevel] = useState<MapLevel>("card");
  const [focusId, setFocusId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const stickyRef = useRef<MapLayoutState | undefined>(undefined);
  // Sticky (spec §8.3): each layout starts from the last committed layout's band order.
  const layout = useMemo(() => (overview === null ? null : layoutMap(overview, { level: "card" }, stickyRef.current)), [overview]);
  const overlay = useMemo(() => (session === null ? null : mapOverlayOf(session)), [session]);
  const hubs = useMemo(() => (layout === null ? NO_HUBS : mapHubIds(layout.edges, layout.cards.length)), [layout]);
  const importers = useMemo(() => (layout === null ? NO_COUNTS : mapImporterCounts(layout.edges)), [layout]);
  const maxFiles = useMemo(() => overview?.snapshot.components.reduce((most, component) => Math.max(most, component.fileCount), 0) ?? 0, [overview]);
  const activeId = hoverId ?? selection;

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const worldRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<ViewportController<UniformCamera> | null>(null);
  const cameraRef = useRef<UniformCamera>(START);
  const sizeRef = useRef<Size>({ w: 0, h: 0 });
  const fittedRepoRef = useRef<string | null>(null);
  /** The camera the last Fit chose; a resize refits only while the camera is still there. */
  const lastFitRef = useRef<UniformCamera | null>(null);
  /** A user key or port call asked to focus this card; consumed once by the next commit (never on data rebuilds). */
  const pendingFocusRef = useRef<string | null>(null);
  const latest = useRef<Latest>({ overview, cards: layout?.cards ?? null, bounds: layout?.bounds ?? null, level, active });

  useLayoutEffect(() => {
    latest.current = { overview, cards: layout?.cards ?? null, bounds: layout?.bounds ?? null, level, active };
    if (layout !== null) stickyRef.current = layout.state;
  });

  /** One write per camera frame: the world transform and the zoom band (names hide below MAP_ICON_ONLY_K). */
  const writeCamera = useCallback((camera: UniformCamera) => {
    cameraRef.current = camera;
    const world = worldRef.current;
    if (world !== null) world.style.transform = `translate(${camera.tx}px, ${camera.ty}px) scale(${camera.k})`;
    const viewport = viewportRef.current;
    if (viewport !== null) {
      const band = camera.k < MAP_ICON_ONLY_K ? "icon" : "full";
      if (viewport.dataset.zoomBand !== band) viewport.dataset.zoomBand = band;
    }
  }, []);

  /** At rest the level follows the zoom (spec §8.3); cards keep their place, only their content changes. */
  const settle = useCallback(
    (camera: UniformCamera) => {
      const next = mapLevelForZoom(camera.k);
      if (next !== latest.current.level) setLevel(next);
      registry.notify();
    },
    [registry],
  );

  const moveTo = useCallback(
    (camera: UniformCamera, animate: boolean) => {
      const controller = controllerRef.current;
      const element = viewportRef.current;
      if (controller === null || element === null) return;
      void controller.set(camera, { animate: animate && !prefersReducedMotion(element) }).then(() => {
        if (controllerRef.current === controller) settle(controller.get());
      });
    },
    [settle],
  );

  const fit = useCallback(
    (animate: boolean): boolean => {
      const current = latest.current;
      if (current.overview === null || controllerRef.current === null) return false;
      const plan = planMapFit(current.overview, sizeRef.current, stickyRef.current);
      if (plan === null) return false;
      lastFitRef.current = plan.camera;
      if (plan.level !== current.level) setLevel(plan.level);
      moveTo(plan.camera, animate);
      return true;
    },
    [moveTo],
  );

  /** Fit once per repo, when the view is shown with a real size (spec §3.4 "Fit shows the whole map"). */
  const fitIfPending = useCallback(() => {
    const current = latest.current;
    const repo = current.overview?.snapshot.repoRoot ?? null;
    if (!current.active || repo === null || fittedRepoRef.current === repo) return;
    if (sizeRef.current.w <= 0 || sizeRef.current.h <= 0) return;
    if (fit(false)) fittedRepoRef.current = repo;
  }, [fit]);

  /** A viewport resize refits (centered, filling the stage) while the camera is still where the last Fit left it. */
  const refitIfStillFitted = useCallback((): boolean => {
    const controller = controllerRef.current;
    const last = lastFitRef.current;
    if (controller === null || last === null) return false;
    const now = controller.get();
    if (Math.abs(now.k - last.k) > 1e-6 || Math.abs(now.tx - last.tx) > 0.5 || Math.abs(now.ty - last.ty) > 0.5) return false;
    return fit(false);
  }, [fit]);

  const hasOverview = overview !== null;
  useLayoutEffect(() => {
    const element = viewportRef.current;
    const win = element?.ownerDocument.defaultView ?? null;
    if (element === null || win === null) return undefined;
    const controller = createViewportController<UniformCamera>({
      element,
      initial: cameraRef.current,
      limits: () => MAP_LIMITS,
      viewport: () => sizeRef.current,
      content: () => {
        const bounds = latest.current.bounds;
        return bounds === null ? { x: 0, y: 0, w: 0, h: 0 } : { x: 0, y: 0, w: bounds.w, h: bounds.h };
      },
      onFrame: (camera) => writeCamera(camera),
      onGestureEnd: (camera) => settle(camera),
      isHandTool: () => store.get().tool === "hand",
      reducedMotion: () => prefersReducedMotion(element),
      raf: (callback) => win.requestAnimationFrame(callback),
      cancelRaf: (handle) => win.cancelAnimationFrame(handle),
      setTimer: (callback, ms) => win.setTimeout(callback, ms),
      clearTimer: (handle) => win.clearTimeout(handle as number),
    });
    controllerRef.current = controller;
    writeCamera(cameraRef.current);
    const Observer = win.ResizeObserver;
    const observer =
      typeof Observer === "function"
        ? new Observer((entries) => {
            const rect = entries[0]?.contentRect;
            if (rect === undefined || rect.width <= 0 || rect.height <= 0) return; // 0 × 0 under <Activity mode="hidden">
            sizeRef.current = { w: rect.width, h: rect.height };
            if (!refitIfStillFitted()) fitIfPending();
          })
        : null;
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      controller.destroy();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [hasOverview, fitIfPending, refitIfStillFitted, settle, store, writeCamera]);

  useLayoutEffect(() => {
    fitIfPending();
  }, [overview, active, fitIfPending]);

  // Focus moves only for a pending user request (lessons-w2): never on a new snapshot.
  useLayoutEffect(() => {
    const id = pendingFocusRef.current;
    if (id === null) return;
    pendingFocusRef.current = null;
    const element = worldRef.current?.querySelector<HTMLElement>(`[data-map-card="${id}"]`) ?? null;
    if (element === null) return;
    element.focus({ preventScroll: true });
    const card = latest.current.cards?.find((item) => item.id === id);
    const controller = controllerRef.current;
    if (card === undefined || controller === null) return;
    const target = revealCamera(controller.get(), card, sizeRef.current);
    if (target !== null) moveTo(target, true);
  });

  const onSelectCard = useCallback(
    (id: string) => {
      if (store.get().tool === "hand" || controllerRef.current?.isGesturing() === true) return;
      setFocusId(id);
      store.dispatch({ type: "map/select", componentId: id });
    },
    [store],
  );

  const onBackgroundClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const state = store.get();
      if (state.tool === "hand" || state.mapSelection === null) return;
      if (event.target instanceof Element && event.target.closest("[data-map-card]") !== null) return;
      store.dispatch({ type: "map/select", componentId: null });
    },
    [store],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (layout === null || !isMapNavKey(event.key) || event.altKey || event.metaKey || event.ctrlKey) return;
      const from = event.target instanceof Element ? (event.target.closest<HTMLElement>("[data-map-card]")?.dataset.mapCard ?? null) : null;
      const next = mapNeighbor(layout, from, event.key);
      if (next === null) return;
      event.preventDefault();
      pendingFocusRef.current = next;
      setFocusId(next);
      bump();
    },
    [layout],
  );

  const zoomTo = useCallback(
    (k: number) => {
      const controller = controllerRef.current;
      if (controller !== null) moveTo(zoomedAtCenter(controller.get(), k, sizeRef.current), true);
    },
    [moveTo],
  );

  const fitSelection = useCallback(() => {
    const id = store.get().mapSelection;
    const card = id === null ? undefined : latest.current.cards?.find((item) => item.id === id);
    if (card === undefined) return;
    moveTo(anchoredCamera(1, cardCenter(card), { x: sizeRef.current.w / 2, y: sizeRef.current.h / 2 }), true);
  }, [moveTo, store]);

  const port = useMemo<ViewPort>(
    () => ({
      readingOrder: () => [],
      reveal: () => undefined,
      captureCamera: () => null,
      focusSelected: () => {
        const id = store.get().mapSelection ?? latest.current.cards?.[0]?.id ?? null;
        if (id === null) return;
        pendingFocusRef.current = id;
        setFocusId(id);
        bump();
      },
      zoom: {
        label: () => `${Math.round((controllerRef.current?.get().k ?? cameraRef.current.k) * 100)}%`,
        presets: () => MAP_ZOOM_PRESETS,
        applyPreset: (id) => {
          if (id === "fit") fit(true);
          else zoomTo(1);
        },
        zoomIn: () => controllerRef.current?.zoomBy(ZOOM_STEP),
        zoomOut: () => controllerRef.current?.zoomBy(1 / ZOOM_STEP),
        resetToPreset: () => zoomTo(1),
        fitAll: () => {
          fit(true);
        },
        fitSelection,
      },
    }),
    [fit, fitSelection, store, zoomTo],
  );
  useRegisterViewPort("map", port);

  const tabStop = useMemo(() => {
    if (layout === null) return null;
    const has = (id: string | null): id is string => id !== null && layout.cards.some((card) => card.id === id);
    return has(focusId) ? focusId : has(selection) ? selection : (layout.cards[0]?.id ?? null);
  }, [layout, focusId, selection]);

  if (overview === null || layout === null) {
    return (
      <div className={styles.root}>
        <div className={styles.empty} data-map-empty="">
          <Icon name="view-map" size={16} />
          <p>No codebase map yet</p>
        </div>
      </div>
    );
  }
  const laneTop = MAP_MARGIN - 4;
  const laneHeight = layout.bounds.h - 2 * MAP_MARGIN + 10; // down to bounds.h − MAP_MARGIN + 6
  return (
    <div className={styles.root}>
      <MapHeader overview={overview} onSelectComponent={onSelectCard} selectedId={selection} onHoverComponent={setHoverId} />
      <div className={styles.stage}>
        {layout.cards.length === 0 ? (
          <p className={styles.stageNote} data-map-empty="">
            {scanNote(overview)?.text ?? "No components found"}
          </p>
        ) : null}
        <div
          ref={viewportRef}
          className={styles.viewport}
          data-tv-viewport="map"
          data-pannable=""
          data-tool={tool}
          data-zoom-band="full"
          onClick={onBackgroundClick}
          onScroll={(event) => {
            // overflow: hidden still scrolls on focus; the camera is the only way to move.
            event.currentTarget.scrollLeft = 0;
            event.currentTarget.scrollTop = 0;
          }}
        >
          <div
            ref={worldRef}
            className={styles.world}
            data-tv-world=""
            data-level={level}
            role="group"
            aria-label={`Codebase map, ${layout.cards.length.toLocaleString("en-US")} components`}
            onKeyDown={onKeyDown}
            style={{ width: layout.bounds.w, height: layout.bounds.h }}
          >
            {layout.bands.map((band) => (
              <div
                key={`lane:${band.band}`}
                className={styles.lane}
                data-map-lane={band.band}
                aria-hidden="true"
                style={{ left: band.x - MAP_LANE_PAD, top: laneTop, width: band.w + 2 * MAP_LANE_PAD, height: laneHeight }}
              />
            ))}
            {layout.bands.map((band) => (
              <div
                key={band.band}
                className={styles.band}
                data-map-band={band.band}
                aria-hidden="true"
                style={{ left: band.x - 1, top: MAP_MARGIN + 2, height: MAP_BAND_LABEL_H - 14 }}
              >
                <Icon name={BAND_ICON[band.band]} size={14} />
                <span className={styles.bandName}>{BAND_LABEL[band.band]}</span>
                <span className={styles.bandCount}>{band.count.toLocaleString("en-US")}</span>
              </div>
            ))}
            <MapEdges layout={layout} hubs={hubs} activeId={activeId} emphasized={overlay?.emphasizedEdges ?? null} />
            {layout.cards.map((box) => {
              const component = overview.componentById.get(box.id);
              return component === undefined ? null : (
                <MapCard
                  key={box.id}
                  box={box}
                  component={component}
                  level={level}
                  selected={box.id === selection}
                  tabStop={box.id === tabStop}
                  maxFiles={maxFiles}
                  hubImporters={hubs.has(box.id) ? (importers.get(box.id) ?? 0) : null}
                  state={overlay?.cardState.get(box.id) ?? null}
                  onSelect={onSelectCard}
                  onHover={setHoverId}
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
```

Create `packages/trace-viewer/src/ui/views/map/MapView.module.css`:

```css
/* Map view (spec §3.4, §3.6; the approved H2 Map mockup, map.html): light, one elevation (shadow), color for state only,
   no decorative borders, no dot grid. Sizes inside the world are world units chosen to read 11 to 13 px at the zoom of
   the level, because the camera scales the world. The camera writes the world transform and data-zoom-band directly
   (MapView writeCamera). --tv-map-edge and --tv-map-lane are proposed tokens; move them to the token sheet with the others. */
.root {
  --tv-map-edge: #c4c9d1;
  --tv-map-lane: rgb(16 24 40 / 0.024);
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--tv-canvas);
}

.empty {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: auto;
  color: var(--tv-ink-3);
  font-size: 13px;
}

.empty p {
  margin: 0;
}

.header {
  flex: none;
  padding: 12px 16px 14px;
  background: var(--tv-panel);
  box-shadow: inset 0 -1px 0 var(--tv-hair);
  color: var(--tv-ink);
}

.headRow {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 22px;
  white-space: nowrap;
}

.headline {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.languages {
  color: var(--tv-ink-3);
}

.notes {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin-top: 6px;
}

.note {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--tv-ink-3);
  font-size: 12px;
  line-height: 16px;
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  margin-left: auto;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--tv-ink-3);
  font: inherit;
  font-size: 12px;
}

.toggle:hover {
  background: var(--tv-fill);
}

.toggle:focus-visible,
.ref:focus-visible,
.more:focus-visible,
.card:focus-visible {
  outline: 2px solid var(--tv-accent);
  outline-offset: 2px;
}

.retry {
  height: 20px;
  margin-left: 4px;
  padding: 0 6px;
  border: 0;
  border-radius: 6px;
  background: var(--tv-fill-2);
  color: var(--tv-ink-2);
  font: inherit;
  font-size: 12px;
}

.retry:focus-visible {
  outline: 2px solid var(--tv-accent);
  outline-offset: 1px;
}

.stageNote {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: grid;
  place-items: center;
  margin: 0;
  color: var(--tv-ink-3);
  font-size: 13px;
  pointer-events: none;
}

.narrative {
  max-width: 86ch;
  margin: 6px 0 0;
  color: var(--tv-ink-2);
  font-size: 13px;
  line-height: 20px;
}

/* A component name in the narrative: ink with a faint underline; the selected component's link turns accent. */
.ref {
  padding: 0;
  border: 0;
  background: none;
  color: var(--tv-ink);
  font: inherit;
  text-decoration: underline;
  text-decoration-color: rgb(16 24 40 / 0.2);
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
  cursor: pointer;
}

.ref[data-selected] {
  color: var(--tv-accent);
  text-decoration-color: var(--tv-accent);
}

.more {
  margin-left: 2px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--tv-ink-3);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.stage {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
}

.viewport {
  position: absolute;
  inset: 0;
  overflow: hidden;
  outline: none;
  touch-action: none;
  background: var(--tv-canvas);
}

.viewport[data-tool="hand"] {
  cursor: grab;
}

.world {
  position: absolute;
  left: 0;
  top: 0;
  transform-origin: 0 0;
}

/* Each band is a full-height light lane; its header sits inside the top. */
.lane {
  position: absolute;
  border-radius: 16px;
  background: var(--tv-map-lane);
  pointer-events: none;
}

.world[data-level="detail"] .lane {
  border-radius: 10px;
}

.band {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--tv-ink);
  font-weight: 600;
  white-space: nowrap;
  pointer-events: none;
}

.band svg {
  color: var(--tv-ink-3);
}

.bandCount {
  color: var(--tv-ink-4);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.world[data-level="chip"] .band {
  gap: 6px;
  font-size: 19px;
}

.world[data-level="chip"] .band svg {
  width: 18px;
  height: 18px;
}

.world[data-level="card"] .band {
  gap: 8px;
  font-size: 17px;
}

.world[data-level="card"] .band svg {
  width: 17px;
  height: 17px;
}

.world[data-level="detail"] .band {
  gap: 5px;
  font-size: 10.5px;
}

.world[data-level="detail"] .band svg {
  width: 11px;
  height: 11px;
}

.edges {
  position: absolute;
  left: 0;
  top: 0;
  overflow: visible;
  pointer-events: none;
}

.edge {
  fill: none;
  stroke: var(--tv-map-edge);
  stroke-linecap: round;
  vector-effect: non-scaling-stroke;
}

.stub {
  fill: none;
  stroke: var(--tv-map-edge);
  stroke-width: 1.25;
  stroke-linecap: round;
  vector-effect: non-scaling-stroke;
}

.edge[data-lit] {
  stroke: var(--tv-accent);
}

.edge[data-dim] {
  opacity: 0.22;
}

.edge[data-emphasized] {
  stroke: var(--tv-ink-3);
}

.card {
  position: absolute;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  border: 0;
  border-radius: 12px;
  background: var(--tv-panel);
  box-shadow: var(--tv-shadow);
  color: var(--tv-ink);
  font: inherit;
  text-align: left;
  overflow: hidden;
  cursor: default;
}

.card[data-selected] {
  box-shadow: 0 0 0 2px var(--tv-accent), var(--tv-shadow);
}

.top {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
}

.name {
  flex: 1 1 auto;
  min-width: 0;
  font-weight: 600;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}

.hub {
  display: inline-flex;
  align-items: center;
  flex: none;
  gap: 3px;
  color: var(--tv-ink-3);
  font-weight: 500;
}

.purpose {
  color: var(--tv-ink-2);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}

.purpose[data-fallback] {
  color: var(--tv-ink-3);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
}

.packages {
  color: var(--tv-ink-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.foot {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--tv-ink-3);
  white-space: nowrap;
}

.card[data-selected] .foot svg {
  color: var(--tv-accent);
}

.track {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
}

.track i {
  display: block;
  border-radius: 3px;
  background: var(--tv-ink-4);
  opacity: 0.65;
}

.count {
  font-variant-numeric: tabular-nums;
}

/* Session state mark (lane 07) in the footer's count slot: 11 px. */
.stateDot {
  flex: none;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--tv-ink-2);
}

.stateDot[data-state="failing"] {
  background: var(--tv-bad);
}

/* Level content. */
.world[data-level="chip"] .card {
  padding: 7px 8px 9px;
}

.world[data-level="chip"] .name {
  font-size: 20.5px;
  line-height: 23px;
}

.world[data-level="chip"] .foot svg {
  width: 17px;
  height: 17px;
}

.world[data-level="chip"] .track i {
  height: 6px;
}

.world[data-level="card"] .card {
  padding: 11px 12px;
}

.world[data-level="card"] .name {
  font-size: 17px;
  line-height: 20px;
}

.world[data-level="card"] .foot svg {
  width: 14px;
  height: 14px;
}

.world[data-level="card"] .track i {
  height: 4px;
}

.world[data-level="card"] .count {
  font-size: 13.5px;
}

.world[data-level="detail"] .card {
  padding: 7px 8px;
  border-radius: 9px;
}

.world[data-level="detail"] .top {
  gap: 4px;
}

.world[data-level="detail"] .name {
  font-size: 10.5px;
  line-height: 13px;
  -webkit-line-clamp: 1;
}

.world[data-level="detail"] .hub {
  gap: 2px;
  font-size: 8.5px;
}

.world[data-level="detail"] .hub svg {
  width: 9px;
  height: 9px;
}

.world[data-level="detail"] .purpose {
  margin-top: 2px;
  font-size: 8.75px;
  line-height: 11.5px;
}

.world[data-level="detail"] .packages {
  font-size: 8.25px;
  line-height: 11px;
}

.world[data-level="detail"] .foot {
  gap: 4px;
  font-size: 8.25px;
}

.world[data-level="detail"] .foot svg {
  width: 9px;
  height: 9px;
}

.world[data-level="detail"] .track {
  flex: 0 0 36px;
}

.world[data-level="detail"] .track i {
  height: 3px;
}

.world[data-level="detail"] .count {
  margin-left: auto;
}

/* Below MAP_ICON_ONLY_K names hide; the footer icon and bar remain, and the tooltip and accessible name carry the name. */
.viewport[data-zoom-band="icon"] .name,
.viewport[data-zoom-band="icon"] .bandName {
  visibility: hidden;
}
```

- [ ] **Step 10: Write `ComponentInspector` and route the Inspector to it**

Create `packages/trace-viewer/src/ui/inspector/ComponentInspector.tsx`:

```tsx
import { useMemo } from "react";
import type React from "react";

import { componentDetails, listBarPx, type MapLink } from "../../layout/map-details.js";
import { displayUntrusted, truncateMiddle } from "../../model/index.js";
import { DiffBar } from "../graphics/DiffBar.js";
import type { IconName } from "../icons/icon-names.js";
import { Icon } from "../icons/Icon.js";
import { ROLE_ICON, ROLE_LABEL } from "../icons/kind-icons.js";
import { useSessionView } from "../shell/session-context.js";
import { useViewStore } from "../state/store.js";
import styles from "./ComponentInspector.module.css";
import base from "./Inspector.module.css";

/** The Inspector for a Map component (spec §3.4): purpose with provenance, files, imports both ways, packages, this
 *  session's changes and the overview sentences that cite it. Every repo and narrator string goes through displayUntrusted. */
export function ComponentInspector({ componentId }: { componentId: string }): React.JSX.Element {
  const view = useSessionView();
  const store = useViewStore();
  const session = view.session;
  const overview = session?.overview ?? null;
  const component = overview?.componentById.get(componentId);
  const details = useMemo(
    () => (session === null || overview === null ? null : componentDetails(overview, componentId, session)),
    [session, overview, componentId],
  );
  if (overview === null || component === undefined || details === null) {
    return (
      <div className={base.inspector} data-component-inspector="">
        <p className={`${styles.quiet} ${styles.missing}`}>This component is no longer in the map.</p>
      </div>
    );
  }
  const name = displayUntrusted(component.name);
  const purpose = component.purpose === null ? null : displayUntrusted(component.purpose);
  const provenance = component.provenance === "model" ? "described by model" : "rule-based";
  const iconOf = (id: string): IconName => {
    const other = overview.componentById.get(id);
    return other === undefined ? "role-domain" : ROLE_ICON[other.role];
  };
  const largest = (counts: readonly number[]): number => counts.reduce((most, count) => Math.max(most, count), 0);
  const links = (kind: "in" | "out", list: readonly MapLink[]): React.JSX.Element => (
    <div data-imports={kind}>
      <h3 className={styles.heading}>{`${kind === "out" ? "Imports out" : "Imports in"} · ${list.length.toLocaleString("en-US")}`}</h3>
      {list.length === 0 ? (
        <p className={styles.quiet}>{component.importsAnalyzed ? "None" : "Not analyzed for this language"}</p>
      ) : (
        <ul className={styles.list}>
          {list.map((link) => (
            <li key={link.id}>
              <span className={styles.row}>
                <Icon name={iconOf(link.id)} size={12} />
                <span className={styles.rowName} title={displayUntrusted(link.name)}>
                  {displayUntrusted(link.name)}
                </span>
                <span className={styles.bar} data-list-bar="" aria-hidden="true" style={{ width: listBarPx(link.count, largest(list.map((item) => item.count))) }} />
                <span className={styles.count}>{link.count.toLocaleString("en-US")}</span>
              </span>
              {link.example === null ? null : (
                <p className={`${styles.mono} ${styles.example}`} title={displayUntrusted(link.example)}>
                  {displayUntrusted(link.example)}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
  return (
    <div className={base.inspector} data-component-inspector={component.id}>
      <div className={base.header}>
        <div className={base.tile}>
          <Icon name={ROLE_ICON[component.role]} size={16} />
        </div>
        <div className={base.headText}>
          <h2 className={base.title} data-slot="title" title={name}>
            {name}
          </h2>
          <p className={base.metaLine}>
            <span>{`${ROLE_LABEL[component.role]} · ${provenance}`}</span>
            {component.roleGuess === component.role ? null : <span>{`· guessed ${ROLE_LABEL[component.roleGuess]}`}</span>}
          </p>
        </div>
      </div>
      <div className={base.body}>
        <section className={styles.section} aria-label="Purpose">
          {purpose === null ? <p className={styles.quiet}>No description yet</p> : <p className={styles.purpose}>{purpose}</p>}
          <p className={styles.mono} title={displayUntrusted(component.rootPath)}>
            {truncateMiddle(component.rootPath, 48)}
          </p>
        </section>
        <section className={styles.section} aria-label="Files">
          <h3 className={styles.heading}>
            <Icon name="file" size={12} />
            <span>{`Files · ${component.fileCount.toLocaleString("en-US")}`}</span>
            {component.language === null ? null : <span className={styles.dim}>{displayUntrusted(component.language)}</span>}
          </h3>
          <ul className={styles.list}>
            {details.files.shown.map((file) => (
              <li key={file} className={styles.mono} data-component-file="" title={displayUntrusted(file)}>
                {truncateMiddle(file, 48)}
              </li>
            ))}
          </ul>
          {details.files.more > 0 ? <p className={styles.quiet}>{`${details.files.more.toLocaleString("en-US")} more`}</p> : null}
        </section>
        <section className={styles.section} aria-label="Imports">
          {links("out", details.importsOut)}
          {links("in", details.importsIn)}
        </section>
        {details.externals.length === 0 ? null : (
          <section className={styles.section} aria-label="External packages">
            <h3 className={styles.heading}>
              <Icon name="pkg" size={12} />
              <span>External packages</span>
            </h3>
            <ul className={styles.list}>
              {details.externals.map((ext) => (
                <li key={ext.name} className={styles.row} data-component-package="">
                  <span className={styles.rowName} title={displayUntrusted(ext.name)}>
                    {displayUntrusted(ext.name)}
                  </span>
                  <span className={styles.bar} data-list-bar="" aria-hidden="true" style={{ width: listBarPx(ext.count, largest(details.externals.map((item) => item.count))) }} />
                  <span className={styles.count}>{ext.count.toLocaleString("en-US")}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section className={styles.section} aria-label="This session">
          <h3 className={styles.heading}>
            <Icon name="edit" size={12} />
            <span>This session</span>
          </h3>
          {details.changes.length === 0 ? (
            <p className={styles.quiet}>No changes in this session</p>
          ) : (
            details.changes.map((change) => (
              <button
                key={change.path}
                type="button"
                className={styles.change}
                data-component-change=""
                title={displayUntrusted(change.path)}
                onClick={() => {
                  store.dispatch({ type: "map/select", componentId: null });
                  store.dispatch({ type: "select", id: change.stepId, by: "shell" });
                }}
              >
                <span className={styles.rowName}>{truncateMiddle(change.path, 36)}</span>
                <DiffBar size="xs" added={change.added} removed={change.removed} />
              </button>
            ))
          )}
        </section>
        {details.citations.length === 0 ? null : (
          <section className={styles.section} aria-label="Cited in the overview">
            <h3 className={styles.heading}>
              <Icon name="quote" size={12} />
              <span>Cited in the overview</span>
            </h3>
            {details.citations.map((sentence, index) => (
              <p key={index} className={styles.sentence}>
                {displayUntrusted(sentence.text)}
              </p>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
```

Create `packages/trace-viewer/src/ui/inspector/ComponentInspector.module.css`:

```css
.section {
  padding: 10px 0;
  box-shadow: inset 0 -1px 0 var(--tv-hair);
}

.section:last-child {
  box-shadow: none;
}

.heading {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 6px;
  color: var(--tv-ink-2);
  font-size: 12px;
  font-weight: 600;
  line-height: 16px;
}

.dim {
  color: var(--tv-ink-3);
  font-weight: 400;
}

.quiet {
  margin: 0;
  color: var(--tv-ink-3);
  font-size: 12px;
  line-height: 16px;
}

.missing {
  padding: 16px;
}

.purpose {
  margin: 0 0 4px;
  color: var(--tv-ink);
  font-size: 13px;
  line-height: 18px;
  overflow-wrap: anywhere;
}

.mono {
  margin: 0;
  color: var(--tv-ink-2);
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 24px;
  color: var(--tv-ink-2);
  font-size: 12px;
}

.rowName {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--tv-ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.count {
  color: var(--tv-ink-3);
  font-variant-numeric: tabular-nums;
}

/* A 4 px bar scaled to the largest count in its list, 48 px at most (revised Map mockup). */
.bar {
  flex: none;
  height: 4px;
  border-radius: 2px;
  background: var(--tv-ink-4);
  opacity: 0.65;
}

.example {
  margin: -2px 0 4px 18px;
}

.change {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 24px;
  padding: 0 4px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--tv-ink-2);
  font: inherit;
  font-size: 12px;
  text-align: left;
}

.change:hover {
  background: var(--tv-fill);
}

.change:focus-visible {
  outline: 2px solid var(--tv-accent);
  outline-offset: 1px;
}

.sentence {
  margin: 0 0 6px;
  color: var(--tv-ink-2);
  font-size: 12px;
  line-height: 18px;
}
```

In `packages/trace-viewer/src/ui/inspector/Inspector.tsx`, add `import { ComponentInspector } from "./ComponentInspector.js";` to the imports and replace the exported wrapper at the end of the file with:

```tsx
/** Wraps itself in its own boundary (lane ruling): the Shell does not wrap regions. On the Map, a selected component
 *  takes the Inspector (lane 06 deviation 4); every other case keeps the step, unit or empty-state body. */
export function Inspector(props: InspectorProps) {
  const mapComponent = useView((state) => (state.view === "map" ? state.mapSelection : null));
  return (
    <ErrorBoundary region="Inspector">
      {mapComponent !== null ? <ComponentInspector componentId={mapComponent} /> : <InspectorBody {...props} />}
    </ErrorBoundary>
  );
}
```

- [ ] **Step 11: Register the view**

In `packages/trace-viewer/src/ui/views/registry.ts`, add `import { MapView } from "./map/MapView.js";`, point the map entry at it (`{ kind: "map", label: "Map", icon: "view-map", Component: MapView }`) and drop `MapPlaceholder` from the registry's import of `./placeholder/ViewPlaceholder.js` (lane 02's V-2 plan puts `ConsolePlaceholder` and `MapPlaceholder` there). Then delete the `MapPlaceholder` function from `ViewPlaceholder.tsx` if `grep -rn "MapPlaceholder" packages/trace-viewer/src` lists no other user; keep the file and anything else in it (V-4 owns `ConsolePlaceholder`).

- [ ] **Step 12: Run the view tests, then the whole package**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/map src/ui/inspector/component-inspector.test.tsx src/ui/icons/icons.test.tsx src/ui/state/view-state.test.ts src/layout/map-details.test.ts`

Expected: PASS, every test in the listed files.

Prove the Review Focus 2 test guards the render: in `MapCard.tsx`, temporarily replace the detail-level purpose child `{purpose}` (inside the `data-map-purpose` span) with `{component.purpose}` and rerun `src/ui/views/map/map-card.test.tsx`. Expected: FAIL in "Review Focus 2: a hostile purpose, name and package render as plain text on the detail card" (`expected '…‮…' not to contain '‮'` or the `⟨U+202E⟩` assertion). Restore and rerun: PASS.

Run: the package suite in the background (`(perl -e 'alarm 590; exec @ARGV' pnpm --filter @jevcode/trace-viewer test > .superpowers/tv-suite.log 2>&1; echo "EXIT=$?" >> .superpowers/tv-suite.log) &`, then poll `tail -6 .superpowers/tv-suite.log` every 15 s until `EXIT=0` appears) — expected: exits 0 (`view-switch.test.tsx`, `shell.test.tsx` and `keyboard.test.tsx` still pass with the real Map view registered).

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer typecheck` and `perl -e 'alarm 170; exec @ARGV' pnpm exec eslint packages/trace-viewer` — expected: exit 0 and no output. The `src/ui` lint block allows React and bans networking, `window.jevcode` and Node built-ins; the map files use none.

- [ ] **Step 13: Dev host `?overview=sample` and the `map` smoke view**

Create `apps/trace-viewer-dev/src/overview-sample.ts`:

```ts
// Dev host only: an in-browser sample overview for the Map (P-3). P-5 adds this repository's fixture.
import { OverviewSnapshotSchema, type OverviewSnapshot, type Role, type TraceBundle } from "@jevcode/contracts";

interface SampleComponent { root: string; name: string; role: Role; purpose: string; files: number; deps?: readonly string[] }

const SAMPLE: readonly SampleComponent[] = [
  { root: "apps/web", name: "web", role: "ui", purpose: "Browser app: pages, forms and the session dashboard.", files: 64, deps: ["react", "react-dom"] },
  { root: "apps/admin", name: "admin", role: "ui", purpose: "Admin console for accounts and billing.", files: 31, deps: ["react"] },
  { root: "services/api", name: "api", role: "api", purpose: "HTTP API: routes, auth middleware and validation.", files: 48, deps: ["fastify", "zod"] },
  { root: "services/worker", name: "worker", role: "agent", purpose: "Background jobs that call the model provider.", files: 22, deps: ["@anthropic-ai/sdk"] },
  { root: "packages/core", name: "core", role: "domain", purpose: "Accounts, sessions and billing rules.", files: 57 },
  { root: "packages/auth", name: "auth", role: "domain", purpose: "OAuth providers and password login.", files: 18, deps: ["jose"] },
  { root: "packages/db", name: "db", role: "storage", purpose: "Postgres schema, migrations and queries.", files: 26, deps: ["pg", "drizzle-orm"] },
  { root: "e2e", name: "e2e", role: "tests", purpose: "Browser tests for sign-in and checkout.", files: 15, deps: ["playwright"] },
  { root: "scripts", name: "scripts", role: "tooling", purpose: "Release and seed scripts.", files: 6 },
  { root: ".", name: "config", role: "config", purpose: "Workspace, TypeScript and lint configuration.", files: 9 },
];

const EDGES: readonly (readonly [string, string, number])[] = [
  ["apps/web", "services/api", 14],
  ["apps/admin", "services/api", 6],
  ["apps/web", "packages/core", 4],
  ["services/api", "packages/core", 21],
  ["services/api", "packages/auth", 9],
  ["services/worker", "packages/core", 7],
  ["packages/auth", "packages/db", 5],
  ["packages/core", "packages/db", 17],
  ["e2e", "apps/web", 3],
  ["scripts", "packages/db", 2],
];

const hex = (n: number, width: number): string => n.toString(16).padStart(width, "0");

export function sampleOverview(sessionId: string): OverviewSnapshot {
  const ids = new Map(SAMPLE.map((component, index) => [component.root, `cmp_${hex(index + 1, 12)}`] as const));
  const id = (root: string): string => ids.get(root) ?? "cmp_000000000000";
  const users = new Map<string, { componentId: string; count: number }[]>();
  for (const component of SAMPLE) {
    (component.deps ?? []).forEach((name, k) => {
      const list = users.get(name) ?? [];
      list.push({ componentId: id(component.root), count: 6 - k });
      users.set(name, list);
    });
  }
  return OverviewSnapshotSchema.parse({
    sessionId,
    repoRoot: "/sample/acme",
    scanId: "sample-1",
    partial: false,
    counts: { files: SAMPLE.reduce((sum, component) => sum + component.files, 0), components: SAMPLE.length, edges: EDGES.length, languages: ["TypeScript", "JSON"] },
    components: SAMPLE.map((component, index) => ({
      id: id(component.root),
      rootPath: component.root,
      name: component.name,
      fileCount: component.files,
      files: [component.root === "." ? "package.json" : `${component.root}/package.json`],
      language: "TypeScript",
      roleGuess: component.role,
      role: component.role,
      purpose: component.purpose,
      provenance: "model",
      contentHash: hex(index + 1, 40),
      externalDeps: (component.deps ?? []).map((name, k) => ({ name, count: 6 - k })),
      entryPoints: [],
      importsAnalyzed: true,
    })),
    edges: EDGES.map(([from, to, count]) => ({ from: id(from), to: id(to), count, examples: [] })),
    externals: [...users].map(([name, usedBy]) => ({ name, usedBy })),
    narrative: {
      provenance: "model",
      sentences: [
        { text: "Acme is a web app with an admin console, both served by one HTTP API.", citations: [{ kind: "component", id: id("apps/web") }, { kind: "component", id: id("services/api") }] },
        { text: "The API keeps account and billing rules in core and stores them in Postgres through db.", citations: [{ kind: "component", id: id("packages/core") }, { kind: "component", id: id("packages/db") }] },
        { text: "A worker runs model calls in the background.", citations: [{ kind: "component", id: id("services/worker") }] },
      ],
    },
    generatedAt: "2026-10-02T09:00:00.000Z",
  });
}

/** Appends one overview_snapshot row after the bundle's last row (spec §8.1 replace semantics). */
export function withOverview(bundle: TraceBundle, snapshot: OverviewSnapshot): TraceBundle {
  const last = bundle.rows.at(-1);
  const seq = (last?.seq ?? 0) + 1;
  return {
    ...bundle,
    session: { ...bundle.session, lastEventSeq: Math.max(bundle.session.lastEventSeq, seq) },
    rows: [...bundle.rows, { seq, type: "overview_snapshot", ts: last?.ts ?? bundle.session.startedAt, payload: { ...snapshot, sessionId: bundle.session.sessionId } }],
  };
}

/** The overview a `?overview=<name>` asks for; null for an unknown name. */
export async function loadOverview(name: string, sessionId: string): Promise<OverviewSnapshot | null> {
  if (name === "sample") return sampleOverview(sessionId);
  return null;
}
```

In `apps/trace-viewer-dev/src/host.tsx`: add `import { loadOverview, withOverview } from "./overview-sample.js";` after the `perf-hud.js` import; add this function after `loadBundle`:

```ts
/** ?overview=<name>: appends one overview_snapshot row to the loaded bundle (dev host only). */
async function attachOverview(bundle: TraceBundle, name: string): Promise<Loaded> {
  const snapshot = await loadOverview(name, bundle.session.sessionId);
  return snapshot === null ? { kind: "error", message: `Unknown overview "${name}"` } : { kind: "ready", bundle: withOverview(bundle, snapshot) };
}
```

and in `DevHost`, add `const overviewName = params.get("overview");` after `const openProbe = …;`, then replace the bundle-loading `useEffect` with:

```ts
  useEffect(() => {
    const token = (requestToken.current += 1);
    void loadBundle(bundleName)
      .then((next) => (next.kind === "ready" && overviewName !== null ? attachOverview(next.bundle, overviewName) : next))
      .then((next) => {
        if (requestToken.current === token) setLoaded(next);
      });
    return () => {
      // A later token (a drop or a new bundle name) supersedes this fetch.
      if (requestToken.current === token) requestToken.current += 1;
    };
  }, [bundleName, overviewName]);
```

In `apps/trace-viewer-dev/scripts/smoke.mjs`:
- in `parseArgs`, accept `map` as a view name: replace the check `if (view !== "hybrid" && view !== "canvas") throw new Error(\`unknown view ${view}\`);` with a set that also holds `"map"` (keep any names lane 02 added, for example `const SMOKE_VIEWS = new Set(["hybrid", "canvas", "console", "map"]);` and `if (!SMOKE_VIEWS.has(view)) throw new Error(\`unknown view ${view}\`);`), and change the empty-list message to name the accepted views;
- add `const MAP_OVERVIEW = "sample";` after `const SMOKE_DIR = …;`;
- in the screenshot loop, build the URL as `` `${ORIGIN}/?bundle=oauth${view === "map" ? `&overview=${MAP_OVERVIEW}` : ""}${locationHash(sessionId, view)}` ``;
- directly after the `for (const width of WIDTHS) { … }` screenshot loop and before `if (view === "hybrid") {`, add `if (view === "map") continue; // screenshots only: the drip and open selftests measure step selection`.

- [ ] **Step 14: Screenshot the Map and compare it with the mockup**

Build and run the smoke for the Map in the background (each command can take minutes; poll its output and never wait in the foreground longer than about 3 minutes):

```bash
(
  perl -e 'alarm 590; exec @ARGV' pnpm -r build > /tmp/p3-build.log 2>&1; echo "BUILD_EXIT $?" >> /tmp/p3-build.log
  perl -e 'alarm 590; exec @ARGV' node apps/trace-viewer-dev/scripts/smoke.mjs --views map --skip-build --port 4186 > /tmp/p3-smoke.log 2>&1; echo "EXIT=$?" >> /tmp/p3-smoke.log
) &
```

Poll `tail -2 /tmp/p3-build.log /tmp/p3-smoke.log` every 15 s until `/tmp/p3-smoke.log` has an `EXIT=` line.

Expected: `/tmp/p3-build.log` ends with `BUILD_EXIT 0`; `/tmp/p3-smoke.log` ends with `SMOKE_OK 2 screenshots` and `EXIT=0`, and `apps/trace-viewer-dev/.smoke/map-1440.png` and `map-1000.png` exist. If the preview port is taken, pass another `--port`.

Open `apps/trace-viewer-dev/.smoke/map-1440.png` beside `docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/map-1440.png`, and `map-1000.png` beside its mockup. The data differs (the sample repo here; P-5 compares this repository's fixture). Check the same visual rules: light band lanes with icon, name and count in the lane's top; the map centered and filling the stage (the full height at 1440 px at about k 0.77 with side margins, the full width at 1000 px at about k 0.52); every name shown in full at both widths, two lines at most; a footer with role icon and file-count bar on every card (and the count at the card level); thin light curves in gutters and gap rows, band-to-band only, none under a card; the header with headline, Overview toggle, quiet notes and two plain sentences with underlined component links and "More"; light panel, one shadow per card, no borders, no dot grid, no red. Then, in a browser at 1440 px, hover and select a card and zoom to 150%: its edges turn accent and the rest drop to 22%, a hub shows its three-line stub at rest, and the detail level shows the purpose, packages and hub glyph (compare with `map-selected-1440.png` and `map-zoomed-1440.png`). Fix any difference in this task's CSS or layout, rebuild the viewer and dev host, rerun the smoke, and look again. Record the remaining, intended differences (for example "Inspector shows the pre-Brief empty state until P-4") for the commit message.

- [ ] **Step 15: Commit**

```bash
git add packages/trace-viewer/src/ui/icons/icon-names.ts packages/trace-viewer/src/ui/icons/paths.ts \
  packages/trace-viewer/src/ui/icons/kind-icons.ts packages/trace-viewer/src/ui/icons/icons.test.tsx \
  packages/trace-viewer/src/ui/state/view-state.ts packages/trace-viewer/src/ui/state/view-state.test.ts \
  packages/trace-viewer/src/layout/map-details.ts packages/trace-viewer/src/layout/map-details.test.ts \
  packages/trace-viewer/src/ui/views/map packages/trace-viewer/src/ui/views/registry.ts \
  packages/trace-viewer/src/ui/inspector/ComponentInspector.tsx packages/trace-viewer/src/ui/inspector/ComponentInspector.module.css \
  packages/trace-viewer/src/ui/inspector/component-inspector.test.tsx packages/trace-viewer/src/ui/inspector/Inspector.tsx \
  apps/trace-viewer-dev/src/overview-sample.ts apps/trace-viewer-dev/src/host.tsx apps/trace-viewer-dev/scripts/smoke.mjs
git -c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com commit -m "feat(trace-viewer): add the Map view and the component Inspector"
```

Add `packages/trace-viewer/src/ui/views/placeholder/ViewPlaceholder.tsx` too if Step 11 changed it.

### Task P-4: Brief architecture card (after rebasing on 02b)

**Files:**
- Create: `packages/trace-viewer/src/layout/brief-architecture.ts`; Test: `packages/trace-viewer/src/layout/brief-architecture.test.ts`
- Modify: `packages/trace-viewer/src/layout/brief.ts` (lane 02's `buildBrief`: its `architecture: null` only)
- Create: `packages/trace-viewer/src/ui/inspector/MapThumbnail.tsx`, `MapThumbnail.module.css`
- Modify: `packages/trace-viewer/src/ui/inspector/Brief.tsx` (lane 02's `Architecture` function and its one call site in `BriefView`)
- Modify: `packages/trace-viewer/src/ui/inspector/RightPanel.tsx` (lane 02's Brief/Inspector switch: a Map component selection takes the panel)
- Modify: `packages/trace-viewer/src/ui/views/map/MapView.tsx` (pass `onRetry` to `MapHeader` from the host context)
- Test: `packages/trace-viewer/src/ui/inspector/architecture-card.test.tsx`
- Modify: `apps/trace-viewer-dev/src/host.tsx` (`?brief=1`), `apps/trace-viewer-dev/scripts/smoke.mjs` (the `map-brief-*` screenshots)
- Rebase-resolved (Step 1, only if they conflict): `apps/trace-viewer-dev/src/host.tsx`, `apps/trace-viewer-dev/scripts/smoke.mjs`, the mockups `README.md`, `ui/views/placeholder/ViewPlaceholder.tsx` and its CSS module (deleted when both placeholders are unused)

**Interfaces:**
- Consumes: lane 02 (V-2 and V-5, merged with 02b), as its plan writes them: `BriefModel`, `type BriefArchitecture = NonNullable<BriefModel["architecture"]>` and `buildBrief(session, index)` (returns `architecture: null`) in `src/layout/brief.ts`; `Brief.tsx` with the connected `Brief()`, the presentational `BriefView(props: BriefViewProps)` (`props.session: TraceSession`) and its private `Architecture({ architecture, onOpenMap, mapAvailable })`, which already renders four states: null ("Appears here once this repository is scanned."), scanning, `overviewSentences: null` ("Descriptions pending") and sentences, with the counts line `"<n> components · <k> touched"` and an "Open the map" button; `RightPanel({ host })` (`src/ui/inspector/RightPanel.tsx`), which shows the Brief when `selection === null || state.brief`, else the Inspector; `ViewState.brief`; V-4's `useViewerHost(): ViewerHost` (`src/ui/shell/host-context.ts`) and V-2's `ViewerHost.rescanOverview?()`; the harness option `HarnessOptions.host` (`test-support/ui-harness.tsx`, V-4). P-1 `TraceSession.overview`, `overviewStatusOf`; P-2 `layoutMap`, `componentForPath`; P-3 `ViewState.mapSelection`, the Inspector's map branch, `ComponentInspector`, `narratorNote`, `MapHeader`'s `onRetry`. Test helpers `renderHarness` (`test-support/ui-harness.tsx`, with `views`), `buildSession`, `overviewSnapshot`, `componentId`.
- Produces: `briefArchitecture(session: TraceSession): BriefArchitecture | null` (deviation 8; `BriefArchitecture` is lane 02's type); `MapThumbnail({ overview, touched })`; `buildBrief(...).architecture` filled (null until a snapshot row arrives; `scanning` from a running scan, ruling R3); the Brief's Architecture part with a Map thumbnail, the ruling R3 narrator words, a quiet "Codebase map unavailable" with Retry after a failed scan, and a `data-brief-architecture` hook; Retry on the Map header; `RightPanel` shows the component Inspector while the view is the Map and `mapSelection` is set; dev host `?brief=1`.

Rules (spec §3.3 item 3, §8.4, §6.1, §6.6, ruling R3): the Architecture part shows a thumbnail of the Map at the chip level with this session's touched components highlighted (touched = the components of the session's edited files, in order of first edit, through `componentForPath`), lane 02's counts line, and the narrator's overview paragraph; when `narrative` is null it shows the narrator state in quiet ink ("Descriptions pending", "Descriptions off" or "Descriptions unavailable"; nothing when `ready`). A running scan fills `scanning`, which lane 02's part already draws as "Mapping codebase · 3,200 / 9,800 files". A failed scan adds a quiet "Codebase map unavailable" line (the untrusted error only in its tooltip) with a Retry button when the host has `rescanOverview`; the Map header gets the same Retry. Nothing here is an alert or a red banner. "Open the map" switches to the Map. With no snapshot the part keeps lane 02's quiet "Appears here once this repository is scanned." and draws no thumbnail.

- [ ] **Step 1: Rebase on main after lane 02b merged, check gate H2, and route the Map selection through `RightPanel`**

Run: `grep -n "H2 approval" docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/README.md` — expected: approved (else stop; this task is blocked).

Lane 02b must be merged into `main` (index §2: 02b merges before 06; 04 and 05 merge before 02b). Check, then rebase:

```bash
git -C /Users/jwpark/Projects/jevcode log --oneline --merges -20 main | grep -c "02b"
git status --short
git rebase main
pnpm install --frozen-lockfile
(perl -e 'alarm 590; exec @ARGV' pnpm -r build > /tmp/p4-build.log 2>&1; echo "BUILD_EXIT $?" >> /tmp/p4-build.log) &
```

Expected: the first command prints at least `1`; `git status --short` prints nothing before the rebase; poll `tail -2 /tmp/p4-build.log` every 15 s until it ends with `BUILD_EXIT 0`. Resolve conflicts by keeping both sides in every file lane 02b also changed:
- `ui/state/view-state.ts`: keep V-2's `brief` field and `brief/toggle` case beside this lane's `mapSelection` and `map/select`; inside `case "esc":` keep this lane's map line first.
- `ui/views/registry.ts`: the `map` entry points at `MapView` and the Console entry at V-4's `ConsoleView`.
- `apps/trace-viewer-dev/src/host.tsx`: keep V-6's `ViewerBody`, chrome and view handling and this lane's (P-3) overview effect.
- `apps/trace-viewer-dev/scripts/smoke.mjs`: keep V-6's `parseArgs` and its view loop beside this lane's map branch, and every accepted view name.
- `docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/README.md`: an add/add conflict; keep both sections (02b's Console/Brief record and this lane's Map record).
- `ui/views/placeholder/ViewPlaceholder.tsx` and `ViewPlaceholder.module.css`: if both `ConsolePlaceholder` and `MapPlaceholder` are now unused (`grep -rn "ConsolePlaceholder\|MapPlaceholder" packages/trace-viewer/src` lists only these files), delete both files, otherwise keep what is still imported; `noUnusedLocals` and lint must stay clean.
- `packages/trace-viewer/src/index.ts` and `src/model/index.ts` barrels: keep every export from both sides.
Never `git stash`; if you must set work aside, make a WIP commit.

Confirm lane 02's Brief API is the one this task extends:

```bash
grep -n "export function buildBrief\|architecture: null\|export type BriefArchitecture" packages/trace-viewer/src/layout/brief.ts
grep -n "function Architecture\|export function BriefView\|export function Brief()" packages/trace-viewer/src/ui/inspector/Brief.tsx
grep -n "export function RightPanel" packages/trace-viewer/src/ui/inspector/RightPanel.tsx
grep -n "RightPanel" packages/trace-viewer/src/ui/shell/Shell.tsx
```

Expected: each prints at least one line (the third also finds `export function showsBrief`). The Shell now renders `RightPanel`, which shows the Brief whenever no step is selected, so P-3's Inspector branch is never reached on the Map. Fix that now **without replacing `RightPanel`'s body**: lane 02b's version carries the focus handover (when the panel switches while focus is inside it, focus moves to the Brief root or to the active view's tab stop; lane 02 deviation 21) and the Shell names the aside "Brief" or "Inspector" from the same `showsBrief`. Both stay right only if the Map case goes through `showsBrief`. In `packages/trace-viewer/src/ui/inspector/RightPanel.tsx`:

1. Extend `showsBrief` so a selected Map component takes the panel:

```ts
export function showsBrief(state: ViewState): boolean {
  // On the Map a selected component takes the panel (lane 06 deviation 4).
  if (state.view === "map" && state.mapSelection !== null) return false;
  return state.selection === null || state.brief;
}
```

2. Keep the rest of `RightPanel` as it is. Its non-Brief branch renders `<Inspector host={host} />`, which routes a Map selection to the component Inspector (`ComponentInspector`, P-3); if that routing lives elsewhere by now, render the component Inspector in that branch instead. Leave the `display: contents` wrapper, the `focusin` bookkeeping and the switch effect untouched.

The aside label and the focus handover now follow the Map case too. Rerun this lane's tests and lane 02b's guards: `perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/model/fold-overview.test.ts src/layout/map-layout.test.ts src/layout/map-layout.property.test.ts src/ui/views/map src/ui/inspector/component-inspector.test.tsx src/ui/inspector/brief.test.tsx src/ui/shell/shell.test.tsx` — expected: PASS. In `brief.test.tsx`, the describe "focus when the panel switches under it (lane fix I-5)" must stay green unchanged; it fails if the body is replaced. In `shell.test.tsx`, so must the m3 test that the aside is named after its content. The `RightPanel` Map branch gets its own test in Step 2.

Open `docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/brief-architecture-1440.png` and `map-1440.png` (the Brief panel on the right).

- [ ] **Step 2: Write the failing tests**

Create `packages/trace-viewer/src/layout/brief-architecture.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { componentId, overviewSnapshot } from "../test-support/overview-builder.js";
import { buildSession, type StepSeed } from "../test-support/session-builder.js";
import { buildBrief } from "./brief.js";
import { briefArchitecture } from "./brief-architecture.js";
import { buildTraceIndex } from "./trace-index.js";

const snapshot = overviewSnapshot({
  components: [{ rootPath: "apps/web", role: "ui" }, { rootPath: "packages/api", role: "api" }, { rootPath: "packages/db", role: "storage" }],
});
const steps: StepSeed[] = [
  { kind: "instruction", tMs: 0, text: "Fix the login" },
  { kind: "edit", tMs: 1_000, target: "packages/db/src/users.ts", edit: { added: 3, removed: 1 } },
  { kind: "edit", tMs: 2_000, target: "apps/web/src/Login.tsx", edit: { added: 10, removed: 2 } },
  { kind: "edit", tMs: 3_000, target: "packages/db/src/sessions.ts", edit: { added: 5, removed: 0 } },
  { kind: "edit", tMs: 4_000, target: "docs/notes.md", edit: { added: 1, removed: 0 } },
];

describe("briefArchitecture (spec §3.3 item 3, §8.4)", () => {
  it("is null until a snapshot row arrives", () => {
    expect(briefArchitecture(buildSession({ steps }))).toBeNull();
  });

  it("Review Focus 5: works from rule-based data when the narrative is null", () => {
    expect(briefArchitecture(buildSession({ steps, overview: snapshot }))).toEqual({
      overviewSentences: null,
      componentCount: 3,
      touched: [componentId("packages/db"), componentId("apps/web")],
      scanning: null,
    });
  });

  it("carries the narrator's sentences when there are some", () => {
    const narrated = overviewSnapshot({
      components: [{ rootPath: "apps/web", role: "ui" }],
      narrative: { provenance: "model", sentences: [{ text: "A web app.", citations: [{ kind: "component", id: componentId("apps/web") }] }] },
    });
    expect(briefArchitecture(buildSession({ steps, overview: narrated }))?.overviewSentences?.map((sentence) => sentence.text)).toEqual(["A web app."]);
  });

  it("fills scanning while the scan runs (ruling R3)", () => {
    const running = overviewSnapshot({ components: [], status: { scan: { state: "running", scanned: 3_200, total: 9_800 }, narrator: "pending" } });
    expect(briefArchitecture(buildSession({ steps, overview: running }))?.scanning).toEqual({ done: 3_200, total: 9_800 });
  });

  it("is what buildBrief returns as its architecture part", () => {
    const session = buildSession({ steps, overview: snapshot });
    expect(buildBrief(session, buildTraceIndex(session)).architecture).toEqual(briefArchitecture(session));
    const without = buildSession({ steps });
    expect(buildBrief(without, buildTraceIndex(without)).architecture).toBeNull();
  });
});
```

Create `packages/trace-viewer/src/ui/inspector/architecture-card.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OverviewSnapshot } from "@jevcode/contracts";

import { componentId, overviewSnapshot } from "../../test-support/overview-builder.js";
import { buildSession, type StepSeed } from "../../test-support/session-builder.js";
import { renderHarness } from "../../test-support/ui-harness.js";
import type { ViewerHost } from "../shell/host.js";
import type { ViewState } from "../state/view-state.js";
import { MapView } from "../views/map/MapView.js";
import type { ViewDefinition } from "../views/view-port.js";
import { RightPanel } from "./RightPanel.js";

afterEach(() => cleanup());

const MAP_VIEW: ViewDefinition = { kind: "map", label: "Map", icon: "view-map", Component: () => null };
const steps: StepSeed[] = [
  { kind: "instruction", tMs: 0, text: "Fix the login" },
  { kind: "edit", tMs: 1_000, target: "packages/db/src/users.ts", edit: { added: 3, removed: 1 } },
  { kind: "edit", tMs: 2_000, target: "apps/web/src/Login.tsx", edit: { added: 10, removed: 2 } },
];
const RULE_ONLY = overviewSnapshot({
  components: [{ rootPath: "apps/web", role: "ui" }, { rootPath: "packages/api", role: "api" }, { rootPath: "packages/db", role: "storage" }],
  edges: [{ from: "apps/web", to: "packages/api", count: 4 }],
});

const FAILED = overviewSnapshot({
  components: [{ rootPath: "apps/web", role: "ui" }],
  status: { scan: { state: "failed", scanned: 0, total: 0, error: "git ls-files \u202Efailed" }, narrator: "off" },
});

/** The right panel with nothing selected shows the Brief (spec E4, §3.3). */
function renderPanel(snapshot: OverviewSnapshot | null, state: Partial<ViewState> = {}, host: ViewerHost = {}) {
  const session = buildSession({ steps, ...(snapshot === null ? {} : { overview: snapshot }) });
  return renderHarness(<RightPanel host={host} />, session, { views: [MAP_VIEW], host, state: { view: "console", selection: null, ...state } });
}

function part(): HTMLElement {
  const element = document.querySelector<HTMLElement>("[data-brief-architecture]");
  if (element === null) throw new Error("no architecture part");
  return element;
}

describe("Brief architecture part (spec §3.3 item 3)", () => {
  it("Review Focus 5: narrative null shows rule-based data and a quiet pending note", () => {
    renderPanel(RULE_ONLY);
    const text = part().textContent ?? "";
    expect(text).toContain("3 components · 2 touched");
    expect(text).toContain("Descriptions pending");
    expect(text).not.toMatch(/error|unavailable|retry|failed/i);
    expect(document.querySelector("[role='alert']")).toBeNull();
    expect(part().querySelectorAll("[data-map-thumbnail] rect[data-thumb-card]")).toHaveLength(3);
    expect(part().querySelectorAll("[data-map-thumbnail] rect[data-thumb-lane]").length).toBeGreaterThan(0);
    expect(part().querySelectorAll("[data-map-thumbnail] rect[data-touched]")).toHaveLength(2);
    expect(part().querySelector("[data-map-thumbnail] path")).toBeNull();
  });

  it("Review Focus 5: narrator off or unavailable reads quietly", () => {
    for (const narrator of ["off", "unavailable"] as const) {
      renderPanel(overviewSnapshot({ components: [{ rootPath: "apps/web", role: "ui" }], status: { scan: { state: "done", scanned: 3, total: 3 }, narrator } }));
      const text = part().textContent ?? "";
      expect(text).toContain(narrator === "off" ? "Descriptions off" : "Descriptions unavailable");
      expect(text).not.toContain("Descriptions pending");
      expect(text).not.toMatch(/error|failed|retry/i);
      expect(document.querySelector("[role='alert']")).toBeNull();
      cleanup();
    }
  });

  it("a failed scan says the map is unavailable and offers Retry, quietly", async () => {
    const user = userEvent.setup();
    const rescanOverview = vi.fn();
    renderPanel(FAILED, {}, { rescanOverview });
    const text = part().textContent ?? "";
    expect(text).toContain("Codebase map unavailable");
    expect(text).not.toContain("\u202E");
    await user.click(within(part()).getByRole("button", { name: "Retry" }));
    expect(rescanOverview).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[role='alert']")).toBeNull();
  });

  it("a failed scan without a host rescan offers no Retry", () => {
    renderPanel(FAILED);
    expect(within(part()).queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("the Map header offers the same Retry through the host", async () => {
    const user = userEvent.setup();
    const rescanOverview = vi.fn();
    renderHarness(<MapView active />, buildSession({ steps, overview: FAILED }), { host: { rescanOverview }, state: { view: "map" } });
    const note = document.querySelector<HTMLElement>("[data-map-note='scan-failed']");
    if (note === null) throw new Error("no scan note");
    await user.click(within(note).getByRole("button", { name: "Retry" }));
    expect(rescanOverview).toHaveBeenCalledTimes(1);
  });

  it("no snapshot: the quiet empty state, no thumbnail and no alert", () => {
    renderPanel(null);
    expect(screen.getByText("Appears here once this repository is scanned.")).toBeTruthy();
    expect(document.querySelector("[data-map-thumbnail]")).toBeNull();
    expect(document.querySelector("[role='alert']")).toBeNull();
  });

  it("shows the narrator's overview as plain text beside the thumbnail", () => {
    renderPanel(
      overviewSnapshot({
        components: [{ rootPath: "apps/web", role: "ui" }],
        narrative: {
          provenance: "model",
          sentences: [{ text: "A web ‮app **with** [a link](https://evil.example).", citations: [{ kind: "component", id: componentId("apps/web") }] }],
        },
      }),
    );
    const text = part().textContent ?? "";
    expect(text).toContain("A web ⟨U+202E⟩app **with** [a link](https://evil.example).");
    expect(text).not.toContain("‮");
    expect(text).not.toContain("Descriptions pending");
    expect(part().querySelectorAll("strong, em, a")).toHaveLength(0);
    expect(part().querySelector("[data-map-thumbnail]")).not.toBeNull();
  });

  it("opens the Map", async () => {
    const user = userEvent.setup();
    const { store } = renderPanel(RULE_ONLY);
    await user.click(screen.getByRole("button", { name: "Open the map" }));
    expect(store.get().view).toBe("map");
  });

  it("on the Map, a selected component takes the right panel; Esc gives it back to the Brief", () => {
    const { store } = renderPanel(RULE_ONLY, { view: "map", mapSelection: componentId("packages/api") });
    expect(document.querySelector(`[data-component-inspector="${componentId("packages/api")}"]`)).not.toBeNull();
    act(() => store.dispatch({ type: "esc" }));
    expect(document.querySelector("[data-component-inspector]")).toBeNull();
    expect(document.querySelector("[data-brief-architecture]")).not.toBeNull();
  });
});
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/brief-architecture.test.ts src/ui/inspector/architecture-card.test.tsx`

Expected: FAIL. `brief-architecture.test.ts` cannot find `./brief-architecture.js`. In `architecture-card.test.tsx`, the Review Focus 5 tests, "shows the narrator's overview …", the failed-scan tests and "opens the Map" fail with `no architecture part` or `Unable to find … "Open the map"` (lane 02's part shows its empty state, since `architecture` is still null); "the Map header offers the same Retry" fails with `Unable to find role="button" … "Retry"`; "no snapshot" passes; the `RightPanel` test passes (Step 1 added the branch).

- [ ] **Step 3: Write `briefArchitecture` and call it from `buildBrief`**

Create `packages/trace-viewer/src/layout/brief-architecture.ts`:

```ts
// The Brief's architecture part (spec §3.3 item 3, §8.4). Pure and React-free.
import { overviewStatusOf, type TraceSession } from "../model/index.js";
import type { BriefArchitecture } from "./brief.js";
import { componentForPath } from "./map-layout.js";

function firstSeq(stepIds: readonly string[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (const id of stepIds) {
    const seq = Number(id.slice("step:".length));
    if (seq < min) min = seq;
  }
  return min;
}

/**
 * null until an overview_snapshot row arrives (spec §8.1). `touched` lists the components of this session's edited
 * files in order of first edit; `scanning` is the progress of a running scan (ruling R3), else null.
 */
export function briefArchitecture(session: TraceSession): BriefArchitecture | null {
  const overview = session.overview;
  if (overview === null) return null;
  const entities = [...session.entities].sort(
    (a, b) => firstSeq(a.stepIds) - firstSeq(b.stepIds) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  const touched: string[] = [];
  const seen = new Set<string>();
  for (const entity of entities) {
    const id = componentForPath(overview, entity.path);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    touched.push(id);
  }
  const narrative = overview.snapshot.narrative;
  const scan = overviewStatusOf(overview.snapshot).scan;
  return {
    overviewSentences: narrative === null ? null : [...narrative.sentences],
    componentCount: overview.snapshot.components.length,
    touched,
    scanning: scan.state === "running" ? { done: scan.scanned, total: scan.total } : null,
  };
}
```

(`brief.ts` imports `briefArchitecture` at runtime and `brief-architecture.ts` imports only the type `BriefArchitecture` from `brief.ts`, so there is no runtime import cycle.)

In `packages/trace-viewer/src/layout/brief.ts`, add `import { briefArchitecture } from "./brief-architecture.js";` and, in the object `buildBrief` returns, replace `architecture: null,` with:

```ts
    architecture: briefArchitecture(session),
```

Also update `buildBrief`'s doc comment, which says `architecture` stays null until lane 06 fills it: it is now filled from the session's overview.

- [ ] **Step 4: Add the thumbnail to lane 02's Architecture part**

Create `packages/trace-viewer/src/ui/inspector/MapThumbnail.tsx`:

```tsx
import { memo, useMemo } from "react";
import type React from "react";

import { MAP_LANE_PAD, MAP_MARGIN, layoutMap } from "../../layout/map-layout.js";
import type { OverviewModel } from "../../model/index.js";
import styles from "./MapThumbnail.module.css";

/** The Map's lanes and cards scaled to the Brief (the approved thumbnail draws no edges); this session's touched components in accent (spec §3.3 item 3). */
function MapThumbnailView({ overview, touched }: { overview: OverviewModel; touched: readonly string[] }): React.JSX.Element {
  const layout = useMemo(() => layoutMap(overview, { level: "chip" }), [overview]);
  const lit = useMemo(() => new Set(touched), [touched]);
  return (
    <div className={styles.frame}>
      <svg
        className={styles.thumb}
        viewBox={`0 0 ${Math.max(1, layout.bounds.w)} ${Math.max(1, layout.bounds.h)}`}
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
        focusable="false"
        data-map-thumbnail=""
      >
        {layout.bands.map((band) => (
          <rect
            key={band.band}
            x={band.x - MAP_LANE_PAD}
            y={MAP_MARGIN - 4}
            width={band.w + 2 * MAP_LANE_PAD}
            height={layout.bounds.h - 2 * MAP_MARGIN + 10}
            rx={16}
            className={styles.lane}
            data-thumb-lane=""
          />
        ))}
        {layout.cards.map((card) => (
          <rect
            key={card.id}
            x={card.x}
            y={card.y}
            width={card.w}
            height={card.h}
            rx={12}
            className={styles.card}
            data-thumb-card=""
            data-touched={lit.has(card.id) ? "" : undefined}
          />
        ))}
      </svg>
    </div>
  );
}

export const MapThumbnail = memo(MapThumbnailView);
```

Create `packages/trace-viewer/src/ui/inspector/MapThumbnail.module.css`:

```css
.frame {
  padding: 8px;
  border-radius: 10px;
  background: var(--tv-canvas);
}

.thumb {
  display: block;
  width: 100%;
  height: 112px;
}

.lane {
  fill: rgb(16 24 40 / 0.024);
}

.card {
  fill: var(--tv-panel);
  stroke: var(--tv-hair);
  stroke-width: 2;
}

.card[data-touched] {
  fill: var(--tv-accent-soft);
  stroke: var(--tv-accent);
  stroke-width: 6;
}
```

In `packages/trace-viewer/src/ui/inspector/Brief.tsx`:
- add `import { MapThumbnail } from "./MapThumbnail.js";`, `import { useViewerHost } from "../shell/host-context.js";` and `import { narratorNote } from "../views/map/map-text.js";`, and add `overviewStatusOf` and `type OverviewModel` to the existing import from `../../model/index.js`;
- give `Architecture` an `overview` prop, read the host as its first statement (`const host = useViewerHost();`, before the null and scanning branches, so the hook order never changes), and draw the thumbnail, the failure line and the narrator word in its filled state; replace lane 02's signature line and the `return (` block that follows the `counts` line with:

```tsx
function Architecture({
  architecture,
  overview,
  onOpenMap,
  mapAvailable,
}: {
  architecture: BriefArchitecture | null;
  overview: OverviewModel | null;
  onOpenMap(): void;
  mapAvailable: boolean;
}) {
```

```tsx
  const scan = overview === null ? null : overviewStatusOf(overview.snapshot).scan;
  // Ruling R3 narrator words; a Brief built without an overview (lane 02's tests) keeps "Descriptions pending".
  const narrator = overview === null ? "Descriptions pending" : narratorNote(overview);
  return (
    <div className={styles.architecture} data-brief-architecture="">
      {overview === null ? null : <MapThumbnail overview={overview} touched={architecture.touched} />}
      <p className={styles.meta}>{counts}</p>
      {scan?.state === "failed" ? (
        <p className={styles.quiet} title={scan.error === undefined ? undefined : displayUntrusted(scan.error)}>
          Codebase map unavailable
          {host.rescanOverview === undefined ? null : (
            <>
              {" "}
              <button type="button" className={styles.link} onClick={() => host.rescanOverview?.()}>
                Retry
              </button>
            </>
          )}
        </p>
      ) : null}
      {architecture.overviewSentences === null ? (
        narrator === null ? null : <p className={styles.quiet}>{narrator}</p>
      ) : (
        <p className={styles.prose}>{architecture.overviewSentences.map((sentence) => displayUntrusted(sentence.text)).join(" ")}</p>
      )}
      {mapAvailable ? (
        <button type="button" className={styles.link} onClick={onOpenMap}>
          Open the map
        </button>
      ) : null}
    </div>
  );
```

  (the null and scanning branches above it stay as lane 02 wrote them);
- in `BriefView`, pass the overview at the one call site: `<Architecture architecture={model.architecture} overview={session.overview} onOpenMap={props.onOpenMap} mapAvailable={props.mapAvailable} />`.

If V-5 changed these lines from its plan, apply the same edits to its version: an `overview: OverviewModel | null` prop, `useViewerHost()` first, `data-brief-architecture=""` on the filled-state wrapper, `MapThumbnail` as that wrapper's first child, the failure line, and the narrator word in place of the fixed "Descriptions pending".

In `packages/trace-viewer/src/ui/views/map/MapView.tsx`, add `import { useViewerHost } from "../../shell/host-context.js";`, read `const host = useViewerHost();` beside the other hooks at the top of `MapView`, add

```tsx
  const onRetry = useMemo(() => (host.rescanOverview === undefined ? undefined : () => host.rescanOverview?.()), [host]);
```

after the `maxFiles` memo, and render `<MapHeader overview={overview} onSelectComponent={onSelectCard} selectedId={selection} onHoverComponent={setHoverId} onRetry={onRetry} />`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/layout/brief-architecture.test.ts src/ui/inspector/architecture-card.test.tsx src/ui/inspector/brief.test.tsx src/ui/views/map`

Expected: PASS, every test (lane 02's `brief.test.tsx` "shows quiet Architecture states and never an error banner" still passes: its sessions have no overview, so no thumbnail is drawn and the strings are unchanged; P-3's Map tests still pass, since `renderWithViewer` provides no host and `useViewerHost()` returns `{}`).

Prove the Review Focus 5 test catches an error-style fallback: in `Brief.tsx`'s `Architecture`, temporarily change `<p className={styles.quiet}>Descriptions pending</p>` to `<p role="alert" className={styles.quiet}>Descriptions unavailable</p>` and rerun `architecture-card.test.tsx`. Expected: FAIL in "Review Focus 5: narrative null shows rule-based data and a quiet pending note". Restore and rerun: PASS.

Run the whole package, typecheck and lint:

```bash
(perl -e 'alarm 590; exec @ARGV' pnpm --filter @jevcode/trace-viewer test > .superpowers/tv-suite.log 2>&1; echo "EXIT=$?" >> .superpowers/tv-suite.log) &   # poll `tail -6 .superpowers/tv-suite.log` every 15 s until the EXIT= line appears; expect EXIT=0
perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer typecheck
perl -e 'alarm 170; exec @ARGV' pnpm exec eslint packages/trace-viewer apps/trace-viewer-dev
```

Expected: exit 0, exit 0, no output.

- [ ] **Step 6: Dev host `?brief=1` and the Brief screenshot**

In `apps/trace-viewer-dev/src/host.tsx`, in `ViewerBody`, read the flag with `const showBrief = useMemo(() => new URLSearchParams(window.location.search).get("brief") === "1", []);` and extend the host object:

```ts
  const host = useMemo<ViewerHost>(
    () => ({
      onLocation: (next) => history.replaceState(null, "", locationToHash(next)),
      // ?brief=1 (screenshots only): Esc up to an empty selection, so the right panel shows the Brief (spec E4).
      ...(showBrief
        ? {
            onReady: () => {
              // After the open defaults select a step (spec §7.8): Esc collapses, goes to the parent, then clears.
              window.setTimeout(() => {
                for (let i = 0; i < 4; i += 1) window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
              }, 300);
            },
          }
        : {}),
      ...(test === null ? {} : test.host),
    }),
    [test, showBrief],
  );
```

In `apps/trace-viewer-dev/scripts/smoke.mjs`, inside the per-view loop and directly before the `if (view === "map") continue;` line, add the Brief screenshots:

```js
      if (view === "map") {
        for (const width of WIDTHS) {
          const file = path.join(SMOKE_DIR, `map-brief-${width}.png`);
          rmSync(file, { force: true });
          chrome(profile, [
            `--window-size=${width},900`,
            "--virtual-time-budget=3000",
            `--screenshot=${file}`,
            `${ORIGIN}/?bundle=oauth&overview=${MAP_OVERVIEW}&brief=1${locationHash(sessionId, "map")}`,
          ]);
          if (!existsSync(file)) throw new Error(`no screenshot at ${file}`);
          shots += 1;
        }
      }
```

Run in the background and poll `tail -2 /tmp/p4-build.log /tmp/p4-smoke.log` every 15 s until `/tmp/p4-smoke.log` has an `EXIT=` line:

```bash
(
  perl -e 'alarm 590; exec @ARGV' pnpm -r build > /tmp/p4-build.log 2>&1; echo "BUILD_EXIT $?" >> /tmp/p4-build.log
  perl -e 'alarm 590; exec @ARGV' node apps/trace-viewer-dev/scripts/smoke.mjs --views map --skip-build --port 4186 > /tmp/p4-smoke.log 2>&1; echo "EXIT=$?" >> /tmp/p4-smoke.log
) &
```

Expected: `BUILD_EXIT 0`; the smoke log ends with `SMOKE_OK 4 screenshots`, and `apps/trace-viewer-dev/.smoke/map-brief-1440.png` and `map-brief-1000.png` exist.

Open `apps/trace-viewer-dev/.smoke/map-brief-1440.png` beside the mockup `map-1440.png` (its right panel) and `brief-architecture-1440.png`. Check: the Brief fills the right panel; its Architecture part shows the Map thumbnail (light lanes with white cards and no edges, as in the mockup; the oauth bundle's edits touch none of the sample components, so no accent card and no "touched" count), "10 components" in 12 px ink-3, the narrator's paragraph clamped to four lines and the "Open the map" link; no border, no red, no banner. Then check `map-brief-1000.png` at the 248 px panel width. Fix any difference in `MapThumbnail.module.css` (the thumbnail) or, for spacing around it, in lane 02's `Brief.module.css` `.architecture` rule; rebuild the viewer and the dev host and rerun the smoke.

- [ ] **Step 7: Commit**

```bash
git add packages/trace-viewer/src/layout/brief-architecture.ts packages/trace-viewer/src/layout/brief-architecture.test.ts \
  packages/trace-viewer/src/layout/brief.ts packages/trace-viewer/src/ui/inspector/MapThumbnail.tsx \
  packages/trace-viewer/src/ui/inspector/MapThumbnail.module.css packages/trace-viewer/src/ui/inspector/Brief.tsx \
  packages/trace-viewer/src/ui/inspector/RightPanel.tsx packages/trace-viewer/src/ui/inspector/architecture-card.test.tsx \
  packages/trace-viewer/src/ui/views/map/MapView.tsx \
  apps/trace-viewer-dev/src/host.tsx apps/trace-viewer-dev/scripts/smoke.mjs
git add packages/trace-viewer/src/ui/inspector/Brief.module.css   # only if Step 6 changed it
git add -A packages/trace-viewer/src/ui/views/placeholder docs/superpowers/specs/2026-10-02-console-and-explainer-mockups/README.md   # only if Step 1's rebase touched them (deleted placeholders, merged README)
git -c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com commit -m "feat(trace-viewer): fill the Brief's architecture part with the Map thumbnail"
```

### Task P-5: Dev-host overview fixture and screenshots

**Files:**
- Create: `packages/trace-viewer/scripts/overview-fixture.mjs`
- Create (generated, committed): `packages/trace-viewer/fixtures/overview-jevcode.json`, `packages/trace-viewer/fixtures/overview-jevcode-rule.json`
- Create: `packages/trace-viewer/src/test-support/overview-fixture.ts`
- Test: `packages/trace-viewer/src/ui/views/map/map-fixture.test.ts`
- Modify: `apps/trace-viewer-dev/src/overview-sample.ts` (`loadOverview`), `apps/trace-viewer-dev/scripts/smoke.mjs` (`MAP_OVERVIEW` and the `map-rule` screenshots)

**Interfaces:**
- Consumes: P-1 `buildOverviewModel`; P-2 `layoutMap`, `MapBand`, `expectNoOverlaps`, `expectNoCardCrossings`; P-2 `mapHubIds`, `mapImporterCounts`; P-3 `planMapFit`, `MAP_ICON_ONLY_K`, `loadOverview`, the `map` smoke view; P-4 `?brief=1` and the `map-brief` screenshots; from `@jevcode/contracts`: `OverviewSnapshotSchema`, `OVERVIEW_SNAPSHOT_MAX_BYTES`.
- Produces: the two fixture files (deviation 10); test-only `loadOverviewFixture(name: "jevcode" | "jevcode-rule"): OverviewSnapshot` and `overviewFixturePath(name)`; dev host `?overview=jevcode` and `?overview=jevcode-rule`; smoke screenshots `map-1440.png`, `map-1000.png`, `map-brief-1440.png`, `map-brief-1000.png`, `map-rule-1440.png`, `map-rule-1000.png` in `apps/trace-viewer-dev/.smoke/`.

The fixture is a snapshot of this repository. Components come from a curated table (the one P-0's mockup uses), so the fixture is stable and shows every band; files, blob hashes, import edges (counted from import statements and resolved through relative paths and workspace package names) and external packages come from `git ls-files -s` and the files themselves. It is not lane 04's scanner output: lane 04 (M-5) owns this repository's expected component table under the spec's cut rules. `docs/`, the root `fixtures/` replay data and the generated fixture files themselves are left out (so regenerating on the same commit reproduces the same bytes). The rule variant has the same components with `purpose: null`, `provenance: "rule"`, `narrative: null` and `status.narrator: "off"` (ruling R3); the narrated variant has `status.narrator: "ready"`.

- [ ] **Step 1: Write the generator and generate the fixture**

Create `packages/trace-viewer/scripts/overview-fixture.mjs`:

```js
#!/usr/bin/env node
// Writes fixtures/overview-jevcode.json (with narrator text) and fixtures/overview-jevcode-rule.json (rule-based,
// narrative null): a snapshot of this repository for the dev host and the Map fixture test (lane 06, P-5).
// Components come from the curated table below rather than lane 04's cut rules, so the fixture is stable and shows
// every band; files, blob hashes, import edges and external packages come from `git ls-files -s` and the files.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(PKG, "../..");
const OUT = path.join(PKG, "fixtures");
const MAX_BYTES = 512 * 1024;
const sha1 = (text) => createHash("sha1").update(text).digest("hex");
const idOf = (rootPath) => `cmp_${sha1(rootPath).slice(0, 12)}`;

/** [rootPath, name, role, purpose (≤ 140 chars)]. The longest matching rootPath owns a file; "." owns repo-root files only. */
const COMPONENTS = [
  ["apps/desktop/src/renderer", "desktop renderer", "ui", "Main window: workspace, composer, surfaces and the embedded trace viewer."],
  ["apps/trace-viewer-dev", "trace-viewer-dev", "ui", "Dev host that loads trace bundles into the viewer for smoke tests."],
  ["packages/trace-viewer/src/ui", "trace-viewer ui", "ui", "Trace viewer views, Inspector, shell and keyboard layer."],
  ["packages/ui-catalog", "ui-catalog", "ui", "Generative UI components rendered from json-render specs."],
  ["packages/ui-compiler", "ui-compiler", "ui", "Compiles surface decisions into json-render UI specs."],
  ["apps/desktop/src/main", "desktop main", "api", "Electron main process: IPC handlers, sessions and the event pipeline."],
  ["apps/desktop", "desktop shell", "api", "Preload bridge, shared IPC types and the app build config."],
  ["packages/agent-codex", "agent-codex", "agent", "Runs Codex as a child process and normalizes its JSON events."],
  ["packages/agent-core", "agent-core", "agent", "Agent adapter interface and session lifecycle shared by adapters."],
  ["packages/jev-router", "jev-router", "agent", "Routes Jev questions to the model through a typed client with guardrails."],
  ["packages/contracts", "contracts", "domain", "Zod schemas and types for events, IPC and trace bundles."],
  ["packages/semantic-core", "semantic-core", "domain", "Groups evidence into change units, decisions and validations."],
  ["packages/evidence-engine", "evidence-engine", "domain", "Watches the repo and parses files into evidence facts."],
  ["packages/codebase-map", "codebase-map", "domain", "Cuts the repository into components, edges and roles for the Map."],
  ["packages/trace-viewer/src/model", "trace-viewer model", "domain", "Folds trace rows into turns, steps, chapters and findings."],
  ["packages/trace-viewer/src/layout", "trace-viewer layout", "domain", "Pure layouts for the Canvas, the Hybrid spine and the Map."],
  ["packages/trace-viewer", "trace-viewer", "domain", "Package entry, sources and test support for the trace viewer."],
  ["packages/telemetry", "telemetry", "domain", "Collects local timing and count metrics for the pipeline."],
  ["packages/storage", "storage", "storage", "SQLite event store, migrations and the trace reader."],
  ["evals", "evals", "tests", "Scenario playback and metrics for Jev decision quality."],
  ["scripts", "scripts", "tooling", "Repository maintenance and verification scripts."],
  [".", "config", "config", "Workspace, TypeScript, ESLint and editor configuration."],
];
/** [sentence (≤ 220 chars), cited rootPaths]. */
const NARRATIVE = [
  ["jevcode is an Electron app that supervises a coding agent and explains its work.", ["apps/desktop/src/main", "apps/desktop/src/renderer"]],
  ["The main process runs Codex through agent-codex and feeds its events through evidence-engine and semantic-core.", ["apps/desktop/src/main", "packages/agent-codex", "packages/semantic-core"]],
  ["Every event lands in the SQLite store, and the trace viewer reads it back as rows.", ["packages/storage", "packages/trace-viewer/src/model"]],
  ["Jev's questions go through jev-router with schema-checked answers.", ["packages/jev-router"]],
  ["contracts holds the shared schemas that every package imports.", ["packages/contracts"]],
  ["The stack is TypeScript with React 19, Vite and better-sqlite3 in a pnpm workspace.", ["."]],
];
const SKIP = /^(docs|fixtures|\.superpowers)\/|^packages\/trace-viewer\/fixtures\/|(^|\/)(node_modules|dist|build|out|\.next|coverage|vendor)\//;
const BINARY = /\.(png|jpe?g|gif|webp|ico|wasm|db|sqlite|pdf|zip|gz|woff2?|ttf)$/i;
const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;
const LANGUAGES = [
  [/\.(ts|tsx|mts|cts)$/, "TypeScript"],
  [/\.(js|mjs|cjs|jsx)$/, "JavaScript"],
  [/\.jsonc?$/, "JSON"],
  [/\.css$/, "CSS"],
  [/\.html$/, "HTML"],
  [/\.ya?ml$/, "YAML"],
  [/\.md$/, "Markdown"],
];
const BUILTINS = new Set(builtinModules);
const SPECIFIER = /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm;
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const git = (...args) => execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const languageOf = (file) => LANGUAGES.find(([pattern]) => pattern.test(file))?.[1] ?? null;

function ownerOf(file) {
  let best = null;
  for (const component of COMPONENTS) {
    const root = component[0];
    const fits = root === "." ? !file.includes("/") : file === root || file.startsWith(`${root}/`);
    if (fits && (best === null || root.length > best[0].length)) best = component;
  }
  return best;
}

function trackedFiles() {
  const files = [];
  for (const line of git("ls-files", "-s").split("\n")) {
    const match = /^\d+ ([0-9a-f]{40}) \d\t(.+)$/.exec(line);
    if (match === null) continue;
    const [, hash, file] = match;
    if (SKIP.test(file) || BINARY.test(file)) continue;
    if (statSync(path.join(REPO, file)).size > 1024 * 1024) continue;
    files.push({ path: file, hash });
  }
  return files.sort((a, b) => byText(a.path, b.path));
}

function workspacePackages() {
  const out = new Map();
  for (const file of git("ls-files", "packages/*/package.json", "apps/*/package.json", "evals/package.json").split("\n")) {
    if (file === "") continue;
    out.set(JSON.parse(readFileSync(path.join(REPO, file), "utf8")).name, path.posix.dirname(file));
  }
  return out;
}

function resolve(from, specifier, files, workspace) {
  const spec = specifier.split("?")[0];
  if (spec.startsWith(".")) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
    const stem = base.replace(/\.(js|mjs|cjs|jsx)$/, "");
    for (const candidate of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.mjs`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`]) {
      if (files.has(candidate)) return { kind: "file", path: candidate };
    }
    return { kind: "unresolved" };
  }
  if (spec.startsWith("node:") || BUILTINS.has(spec.split("/")[0])) return { kind: "builtin" };
  const parts = spec.split("/");
  const scoped = spec.startsWith("@");
  const name = scoped ? parts.slice(0, 2).join("/") : parts[0];
  const dir = workspace.get(name);
  if (dir === undefined) return { kind: "external", name };
  const sub = parts.slice(scoped ? 2 : 1).join("/");
  const candidates = sub === "" ? [`${dir}/src/index.ts`, `${dir}/src/index.tsx`] : [`${dir}/src/${sub}/index.ts`, `${dir}/src/${sub}.ts`, `${dir}/src/${sub}.tsx`];
  for (const candidate of candidates) if (files.has(candidate)) return { kind: "file", path: candidate };
  return { kind: "file", path: `${dir}/package.json` };
}

function build(narrated) {
  const tracked = trackedFiles();
  const fileSet = new Set(tracked.map((file) => file.path));
  const workspace = workspacePackages();
  const members = new Map(COMPONENTS.map(([root]) => [root, []]));
  let unowned = 0;
  for (const file of tracked) {
    const owner = ownerOf(file.path);
    if (owner === null) unowned += 1;
    else members.get(owner[0]).push(file);
  }
  const edges = new Map();
  const externals = new Map();
  const perComponent = new Map();
  for (const [root, list] of members) {
    for (const file of list) {
      if (!CODE.test(file.path)) continue;
      const source = readFileSync(path.join(REPO, file.path), "utf8");
      for (const match of source.matchAll(SPECIFIER)) {
        const specifier = match[1] ?? match[2] ?? match[3];
        if (specifier === undefined) continue;
        const target = resolve(file.path, specifier, fileSet, workspace);
        if (target.kind === "file") {
          const owner = ownerOf(target.path);
          if (owner === null || owner[0] === root) continue;
          const key = `${idOf(root)}>${idOf(owner[0])}`;
          const edge = edges.get(key) ?? { from: idOf(root), to: idOf(owner[0]), count: 0, examples: [] };
          edge.count += 1;
          if (edge.examples.length < 3) edge.examples.push(`${file.path} → ${target.path}`);
          edges.set(key, edge);
        } else if (target.kind === "external") {
          const users = externals.get(target.name) ?? new Map();
          users.set(idOf(root), (users.get(idOf(root)) ?? 0) + 1);
          externals.set(target.name, users);
          const mine = perComponent.get(root) ?? new Map();
          mine.set(target.name, (mine.get(target.name) ?? 0) + 1);
          perComponent.set(root, mine);
        }
      }
    }
  }
  const languageCounts = new Map();
  const components = [];
  for (const [root, name, role, purpose] of COMPONENTS) {
    const list = members.get(root);
    if (list.length === 0) continue;
    const counts = new Map();
    for (const file of list) {
      const language = languageOf(file.path);
      if (language === null) continue;
      counts.set(language, (counts.get(language) ?? 0) + 1);
      languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
    }
    components.push({
      id: idOf(root),
      rootPath: root,
      name,
      fileCount: list.length,
      files: list.map((file) => file.path).slice(0, 400),
      language: [...counts].sort((a, b) => b[1] - a[1] || byText(a[0], b[0]))[0]?.[0] ?? null,
      roleGuess: role,
      role,
      purpose: narrated ? purpose : null,
      provenance: narrated ? "model" : "rule",
      contentHash: sha1(list.map((file) => `${file.path}:${file.hash}`).sort().join("\n")),
      externalDeps: [...(perComponent.get(root) ?? new Map())]
        .sort((a, b) => b[1] - a[1] || byText(a[0], b[0]))
        .slice(0, 8)
        .map(([dep, count]) => ({ name: dep, count })),
      entryPoints: list.map((file) => file.path).filter((file) => /\/src\/(index|main)\.tsx?$/.test(file)).slice(0, 8),
      importsAnalyzed: list.some((file) => CODE.test(file.path) || file.path.endsWith(".json")),
    });
  }
  const present = new Set(components.map((component) => component.id));
  const edgeList = [...edges.values()]
    .filter((edge) => present.has(edge.from) && present.has(edge.to))
    .sort((a, b) => b.count - a.count || byText(a.from, b.from) || byText(a.to, b.to))
    .slice(0, 1000);
  const externalList = [...externals]
    .map(([name, users]) => ({
      name,
      total: [...users.values()].reduce((sum, n) => sum + n, 0),
      usedBy: [...users].sort((a, b) => b[1] - a[1] || byText(a[0], b[0])).slice(0, 40).map(([componentId, count]) => ({ componentId, count })),
    }))
    .sort((a, b) => b.total - a.total || byText(a.name, b.name))
    .slice(0, 120)
    .map(({ name, usedBy }) => ({ name, usedBy }));
  const snapshot = {
    sessionId: "fixture",
    repoRoot: "/fixture/jevcode",
    scanId: `fixture-${git("rev-parse", "--short", "HEAD").trim()}`,
    partial: false,
    counts: {
      files: components.reduce((sum, component) => sum + component.fileCount, 0),
      totalFiles: components.reduce((sum, component) => sum + component.fileCount, 0),
      components: components.length,
      edges: edgeList.length,
      languages: [...languageCounts].sort((a, b) => b[1] - a[1] || byText(a[0], b[0])).slice(0, 20).map(([language]) => language),
    },
    components,
    edges: edgeList,
    externals: externalList,
    narrative: narrated
      ? {
          provenance: "model",
          sentences: NARRATIVE.map(([text, roots]) => ({
            text,
            citations: roots.filter((root) => present.has(idOf(root))).map((root) => ({ kind: "component", id: idOf(root) })),
          })).filter((sentence) => sentence.citations.length > 0),
        }
      : null,
    // Ruling R3: a finished scan; the narrator is ready in the narrated variant and off in the rule variant.
    status: {
      scan: { state: "done", scanned: components.reduce((sum, c) => sum + c.fileCount, 0), total: components.reduce((sum, c) => sum + c.fileCount, 0) },
      narrator: narrated ? "ready" : "off",
    },
    generatedAt: git("log", "-1", "--format=%cI").trim(),
  };
  return { snapshot, unowned };
}

mkdirSync(OUT, { recursive: true });
for (const [file, narrated] of [["overview-jevcode.json", true], ["overview-jevcode-rule.json", false]]) {
  const { snapshot, unowned } = build(narrated);
  const bytes = Buffer.byteLength(JSON.stringify(snapshot));
  if (bytes > MAX_BYTES) throw new Error(`${file}: ${bytes} bytes exceeds the 512 KB snapshot cap`);
  writeFileSync(path.join(OUT, file), `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(
    `${file}: ${snapshot.counts.components} components, ${snapshot.counts.edges} edges, ${snapshot.externals.length} externals, ${bytes} bytes, ${unowned} files without a component`,
  );
}
```

Run: `perl -e 'alarm 120; exec @ARGV' node packages/trace-viewer/scripts/overview-fixture.mjs`

Expected: two lines, `overview-jevcode.json: 22 components, <n> edges, <m> externals, <bytes> bytes, 0 files without a component` and the same for `overview-jevcode-rule.json` (21 components if `packages/codebase-map` is not on this branch yet; a non-zero "without a component" count names files outside the table, for example a new top-level directory: add a row for it to `COMPONENTS` and rerun). `<bytes>` is below 524,288.

- [ ] **Step 2: Write the loader and the failing fixture test**

Create `packages/trace-viewer/src/test-support/overview-fixture.ts`:

```ts
// Test-only: this repository's overview fixture (lane 06, P-5), parsed with the contracts schema.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OverviewSnapshotSchema, type OverviewSnapshot } from "@jevcode/contracts";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures");

export type OverviewFixtureName = "jevcode" | "jevcode-rule";

export function overviewFixturePath(name: OverviewFixtureName): string {
  return path.join(FIXTURES, `overview-${name}.json`);
}

export function loadOverviewFixture(name: OverviewFixtureName): OverviewSnapshot {
  return OverviewSnapshotSchema.parse(JSON.parse(readFileSync(overviewFixturePath(name), "utf8")));
}
```

Create `packages/trace-viewer/src/ui/views/map/map-fixture.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { OVERVIEW_SNAPSHOT_MAX_BYTES } from "@jevcode/contracts";

import { layoutMap, mapHubIds, mapImporterCounts, type MapBand, type MapLevel } from "../../../layout/map-layout.js";
import { buildOverviewModel } from "../../../model/index.js";
import { expectNoCardCrossings, expectNoOverlaps } from "../../../test-support/map-checks.js";
import { loadOverviewFixture } from "../../../test-support/overview-fixture.js";
import { MAP_ICON_ONLY_K, planMapFit } from "./map-camera.js";

// Spec §12 "a fixture table test on this repo's own snapshot". Bands follow each component's role (spec E12); the
// viewports are the Shell's main column at 1440 px (216 + 280 px side panels) and 1000 px (200 + 248 px), less the
// title bar and the Map header.

const EXPECTED_BAND: Readonly<Record<string, MapBand>> = {
  "desktop renderer": "ui",
  "trace-viewer-dev": "ui",
  "trace-viewer ui": "ui",
  "ui-catalog": "ui",
  "ui-compiler": "ui",
  "desktop main": "api",
  "desktop shell": "api",
  "agent-codex": "agent",
  "agent-core": "agent",
  "jev-router": "agent",
  contracts: "domain",
  "semantic-core": "domain",
  "evidence-engine": "domain",
  "codebase-map": "domain",
  "trace-viewer model": "domain",
  "trace-viewer layout": "domain",
  "trace-viewer": "domain",
  telemetry: "domain",
  storage: "storage",
  evals: "side",
  scripts: "side",
  config: "side",
};
/** Present on every branch of this plan; codebase-map arrives with lane 04. */
const REQUIRED = Object.keys(EXPECTED_BAND).filter((name) => name !== "codebase-map");

const snapshot = loadOverviewFixture("jevcode");
const overview = buildOverviewModel(snapshot, 1);
const nameOf = (id: string): string => overview.componentById.get(id)?.name ?? id;

describe("Map layout of this repository (fixture overview-jevcode.json)", () => {
  it("places every component in its role band", () => {
    const layout = layoutMap(overview, { level: "card" });
    const names = layout.cards.map((card) => nameOf(card.id));
    expect(names).toEqual(expect.arrayContaining(REQUIRED));
    for (const card of layout.cards) expect(card.band, nameOf(card.id)).toBe(EXPECTED_BAND[nameOf(card.id)]);
  });

  it("orders the bands UI, API · IPC, agents, domain, storage, then the side band", () => {
    expect(layoutMap(overview, { level: "card" }).bands.map((band) => band.band)).toEqual(["ui", "api", "agent", "domain", "storage", "side"]);
  });

  it("has contracts as the most imported component, and as a hub", () => {
    const layout = layoutMap(overview, { level: "card" });
    const importers = [...mapImporterCounts(layout.edges)].sort((a, b) => b[1] - a[1]);
    expect(nameOf(importers[0]?.[0] ?? "")).toBe("contracts");
    // The mockup shows contracts imported by 13 of 21 components, so it is the one hub (threshold max(6, ceil(n / 4))).
    expect([...mapHubIds(layout.edges, layout.cards.length)].map(nameOf)).toContain("contracts");
  });

  it("lays out without overlaps or card crossings at every level", () => {
    for (const level of ["chip", "card", "detail"] as MapLevel[]) {
      const layout = layoutMap(overview, { level });
      expectNoOverlaps(layout);
      expectNoCardCrossings(layout);
    }
  });

  it("fits the 1440 px main column at the card level and the 1000 px column at the chip level, with names shown at both", () => {
    // The approved mockups: k about 0.77 on 944 px (full height) and about 0.52 on 552 px (full width).
    const wide = planMapFit(overview, { w: 944, h: 700 });
    expect(wide?.level).toBe("card");
    expect(wide?.camera.k).toBeGreaterThanOrEqual(0.7);
    const narrow = planMapFit(overview, { w: 552, h: 700 });
    expect(narrow?.level).toBe("chip");
    expect(narrow?.camera.k).toBeGreaterThanOrEqual(MAP_ICON_ONLY_K);
    expect(narrow?.camera.k).toBeLessThan(0.7);
  });

  it("has a rule-based twin with the same components, no purposes, no narrative and the narrator off", () => {
    const rule = loadOverviewFixture("jevcode-rule");
    expect(snapshot.status?.narrator).toBe("ready");
    expect(rule.status?.narrator).toBe("off");
    expect(rule.components.map((component) => [component.id, component.contentHash])).toEqual(
      snapshot.components.map((component) => [component.id, component.contentHash]),
    );
    expect(rule.components.every((component) => component.purpose === null && component.provenance === "rule")).toBe(true);
    expect(rule.narrative).toBeNull();
  });

  it("stays under the 512 KB snapshot cap", () => {
    for (const name of ["jevcode", "jevcode-rule"] as const) {
      expect(new TextEncoder().encode(JSON.stringify(loadOverviewFixture(name))).length).toBeLessThanOrEqual(OVERVIEW_SNAPSHOT_MAX_BYTES);
    }
  });
});
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/ui/views/map/map-fixture.test.ts`

Expected: PASS once Step 1 has written the fixtures (the test reads committed data, so there is no red phase for the data itself). Prove it guards the generator: temporarily change the `desktop main` row's role in `overview-fixture.mjs` to `"domain"`, rerun the generator and the test — expected: FAIL in "places every component in its role band" (`desktop main: expected 'domain' to be 'api'`). Before the mutation, copy the Step 1 output aside: `cp packages/trace-viewer/fixtures/overview-jevcode.json packages/trace-viewer/fixtures/overview-jevcode-rule.json /tmp/`. Restore the row, rerun the generator, rerun the test: PASS. Then `cmp /tmp/overview-jevcode.json packages/trace-viewer/fixtures/overview-jevcode.json && cmp /tmp/overview-jevcode-rule.json packages/trace-viewer/fixtures/overview-jevcode-rule.json` prints nothing (the generator is deterministic for one commit).

- [ ] **Step 3: Serve the fixture in the dev host**

In `apps/trace-viewer-dev/src/overview-sample.ts`, add these imports after the contracts import:

```ts
import jevcodeRuleUrl from "../../../packages/trace-viewer/fixtures/overview-jevcode-rule.json?url";
import jevcodeUrl from "../../../packages/trace-viewer/fixtures/overview-jevcode.json?url";
```

add this table after `hex`:

```ts
/** This repository's fixture (lane 06, P-5), served as build assets (vite `?url`; the Electron CSP allows same-origin fetch). */
const FIXTURES: Readonly<Record<string, string>> = { jevcode: jevcodeUrl, "jevcode-rule": jevcodeRuleUrl };
```

and replace `loadOverview` with:

```ts
/** The overview a `?overview=<name>` asks for; null for an unknown name or a fixture that fails the schema. */
export async function loadOverview(name: string, sessionId: string): Promise<OverviewSnapshot | null> {
  if (name === "sample") return sampleOverview(sessionId);
  const url = FIXTURES[name];
  if (url === undefined) return null;
  const response = await fetch(url);
  if (!response.ok) return null;
  const parsed = OverviewSnapshotSchema.safeParse(await response.json());
  return parsed.success ? { ...parsed.data, sessionId } : null;
}
```

(`src/vite-env.d.ts` already references `vite/client`, which declares `*?url` modules; Vite serves files outside the app root from the workspace root.)

In `apps/trace-viewer-dev/scripts/smoke.mjs`: change `const MAP_OVERVIEW = "sample";` to `const MAP_OVERVIEW = "jevcode";`, and inside the `if (view === "map") { for (const width of WIDTHS) { … } }` block added in P-4, after the `map-brief` screenshot, add the rule-based screenshot in the same loop body:

```js
          const ruleFile = path.join(SMOKE_DIR, `map-rule-${width}.png`);
          rmSync(ruleFile, { force: true });
          chrome(profile, [
            `--window-size=${width},900`,
            "--virtual-time-budget=3000",
            `--screenshot=${ruleFile}`,
            `${ORIGIN}/?bundle=oauth&overview=jevcode-rule${locationHash(sessionId, "map")}`,
          ]);
          if (!existsSync(ruleFile)) throw new Error(`no screenshot at ${ruleFile}`);
          shots += 1;
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-trace-viewer-dev typecheck` — expected: exits 0.

- [ ] **Step 4: Screenshots and the mockup comparison**

Run in the background and poll (never wait in the foreground longer than about 3 minutes):

```bash
(
  perl -e 'alarm 590; exec @ARGV' pnpm -r build > /tmp/p5-build.log 2>&1; echo "BUILD_EXIT $?" >> /tmp/p5-build.log
  perl -e 'alarm 590; exec @ARGV' node apps/trace-viewer-dev/scripts/smoke.mjs --views map --skip-build --port 4186 > /tmp/p5-smoke.log 2>&1; echo "EXIT=$?" >> /tmp/p5-smoke.log
) &
```

Poll `tail -2 /tmp/p5-build.log /tmp/p5-smoke.log` every 15 s until `/tmp/p5-smoke.log` has an `EXIT=` line.

Expected: `BUILD_EXIT 0`; the smoke log ends with `SMOKE_OK 6 screenshots`; `apps/trace-viewer-dev/.smoke/` holds `map-1440.png`, `map-1000.png`, `map-brief-1440.png`, `map-brief-1000.png`, `map-rule-1440.png` and `map-rule-1000.png`.

Compare each pair with the Read tool:

| Screenshot | Mockup | Must match |
|---|---|---|
| `map-1440.png` | `map-1440.png` | Six band lanes with icons, names and counts; the map centered, filling the stage height; card-level cards with the full name, role icon, file-count bar and count; light curves in gutters and gap rows, band-to-band only, none under a card; a hub stub on `contracts`; the header headline, Overview toggle and two plain sentences with links and "More" |
| `map-1000.png` | `map-1000.png` | The narrower Shell; chip-level cards, every name readable at about 11 px, filling the stage width; band icons and counts |
| `map-brief-1440.png` | `map-1440.png` (right panel), `brief-architecture-1440.png` | The Brief in the right panel with its Architecture part: the thumbnail first, then "21 components" (22 with lane 04's package; the oauth bundle touches no fixture component, so no "touched" count and no accent card), the overview paragraph clamped to four lines, and the "Open the map" link |
| `map-rule-1440.png`, `map-rule-1000.png` | `map-pending-1440.png`, `map-pending-1000.png` | "Descriptions off" (the rule variant's `status.narrator`) in quiet ink in the header where the mockup says "Descriptions pending"; no Overview toggle; no red, no banner (the fixture is not partial and has no Python component, so those two notes are absent here; P-3's tests cover them) |

Known, intended differences: real counts and edge sets differ from the mockup's hand-drawn ones; the Outline shows the oauth session. Fix anything else (spacing, type size, colors, borders, missing parts) in this lane's CSS or layout constants, rebuild, rerun the smoke, and compare again.

- [ ] **Step 5: Root checks**

Run `bash /Users/jwpark/Projects/jevcode/.superpowers/orchestration/root-checks.sh /Users/jwpark/Projects/jevcode-ce-06` in the background and poll `/Users/jwpark/Projects/jevcode-ce-06/.superpowers/root-checks.log`.

Expected: the log's last line is `ROOT_CHECKS_DONE fail=0`. The known flakes (`stall-watchdog.test.ts`, `codex-adapter.test.ts`, `file-watcher.test.ts`) count only if that package passes when run alone.

- [ ] **Step 6: Commit**

```bash
git add packages/trace-viewer/scripts/overview-fixture.mjs packages/trace-viewer/fixtures/overview-jevcode.json \
  packages/trace-viewer/fixtures/overview-jevcode-rule.json packages/trace-viewer/src/test-support/overview-fixture.ts \
  packages/trace-viewer/src/ui/views/map/map-fixture.test.ts apps/trace-viewer-dev/src/overview-sample.ts \
  apps/trace-viewer-dev/scripts/smoke.mjs
git -c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com commit -m "test(trace-viewer): add this repository's overview fixture and Map screenshots"
```

## Lane completion

1. **Whole-lane check** on `ce/06-viewer-map` after P-5: `ROOT_CHECKS_DONE fail=0` (P-5 Step 5), and `perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/trace-viewer exec vitest run src/model/fold-overview.test.ts src/model/fold.incremental.test.ts src/layout/map-layout.test.ts src/layout/map-layout.property.test.ts src/layout/map-details.test.ts src/layout/brief-architecture.test.ts src/ui/views/map src/ui/inspector/component-inspector.test.tsx src/ui/inspector/architecture-card.test.tsx` reports no failures.
2. **Done (index §9, lane 06):** `layoutMap` properties green (P-2), bench means recorded (P-2 Step 8; fresh ≤ 8 ms, sticky ≤ 2 ms, or a reported miss); the Map view and the Brief card match the approved mockups (P-3 Step 14, P-4 Step 6, P-5 Step 4); the partial and no-edges notes render (P-3 Review Focus 1 tests).
3. **Merge** follows index §7 after lanes 04, 05, 02b and 03 (W1 order): `git -C /Users/jwpark/Projects/jevcode-ce-06 rebase main`, rerun the root checks, then the controller merges. After the rebase, if lane 04 landed `packages/codebase-map` since P-5, rerun `node packages/trace-viewer/scripts/overview-fixture.mjs` and commit the refreshed fixtures (`test(trace-viewer): refresh the overview fixture`), so the dev host shows the new component.
4. **Hand-off notes** for the merge and for lane 07:
   - The three bench means from P-2 Step 8.
   - "Interface deviations" 1–10 and "Spec alignment notes" 1–8 above, in particular: the scan-progress and scan-failure gap (note 1), the off-versus-pending gap (note 2), the gap-row routing of long edges (note 4), and the narrow-width fit ruling at H2 (note 7).
   - **For lane 07 (S-3, S-5):** `TraceSession.overview` and `buildOverviewModel` are in place; S-3 adds `TraceSession.explainer` beside `overview` in the same `partial` literal of `Finalizer.run` and in `session-builder.ts`/`canvas-arbitraries.ts`. Per ruling R6, `componentIdForPath(components, path)` and its test already exist (`src/model/component-path.ts`, `component-path.test.ts`, P-1) and `componentForPath` already delegates to it, so S-3 consumes them and creates neither file. S-5 fills `mapOverlayOf(session)` in `src/ui/views/map/overlay.ts` (return `{ cardState, emphasizedEdges }` from `session.explainer.highlights`; edge keys are `"<from>><to>"`), and styles `[data-state]` dots and `[data-emphasized]` edges in `MapView.module.css` per its approved mockup. `MapView`, `MapCard` and `MapEdges` already read the overlay. `componentForPath(overview, path)` maps an edited path to its component.
   - **For lane 02's Brief:** `buildBrief` now returns `architecture` from `briefArchitecture(session)`; `Brief.tsx`'s `Architecture` takes `overview` and draws `MapThumbnail` first; `RightPanel` gives the panel to the component Inspector while the Map has a component selected.
   - **For lane 03 (main window):** the Map is view key `3` through V-2's registry; `mainHost.rescanOverview` drives the Retry that the Brief and the Map header show after a failed scan (ruling R3).
   - **For lanes 04 and 05 (status writers, ruling R3):** the viewer reads `status.scan` (running progress, failed with a short error shown only in a tooltip) and `status.narrator` through `overviewStatusOf`, and `counts.totalFiles` for the partial note; a row without `status` reads as scan done, narrator pending while any purpose is null.
