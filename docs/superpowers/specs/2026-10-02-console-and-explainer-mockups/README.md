# Console and explainer mockups

Static HTML rendered headlessly at 1440 and 1000 px. Tokens and icons follow the trace viewer (viewer spec §7.12).
Each phase's UI tasks compare their headless screenshots against the approved PNGs here.

## Phase A (lane 02 V-0): main window on the Console, Brief v0

| File | Shows |
|---|---|
| `console-main.html`, `console-main-1440.png`, `console-main-1000.png` | The main window: header, sidebar, view switcher (keys 0–4; key `0` opens the Console and a session switch opens on the Console, interfaces §8 R5), the Console with every Phase A row kind, Brief v0 (Now, Changes so far, Architecture empty state), the prompt dock with a queued item |
| `console-states.html`, `console-states-1440.png`, `console-states-1000.png` | The Console scrolled back while Live with the "↓ 3 new" pill; Brief for a finished session; Brief before the first event with the scan progress state |

### H1 approval

| Date | Person | Decision | Notes |
|---|---|---|---|
| PENDING | | | |

## Phase B: Map and Brief architecture card (P-0, gate H2)

- `map.html` renders four states through `?state=`: `default` (Fit at the chip level, Brief), `zoomed` (card level at 92%, external chips), `selected` (`desktop main` selected, one-hop edges in accent, the rest at 30%, component Inspector), `pending` (rule-based header with the partial, imports-not-analyzed and descriptions-pending notes).
- `brief-architecture.html` shows the Brief's architecture card at 280 px and 248 px: narrator text, narrator pending, fresh session.
- `brief-architecture.html` also shows the overview status states (interfaces §8 R3): scanning ("Mapping codebase · 3,200 / 9,800 files" with a progress bar), scan failed ("Codebase map unavailable" with Retry), and "Descriptions off", "Descriptions unavailable", "Descriptions pending", each as the Map header strip plus the Brief card.
- The shell (header, sidebar, view switcher, Brief column, prompt dock, status bar) matches the Phase A PNGs; the Brief column is 300 px, 264 px under 1180 px.
- PNGs: `map-1440.png`, `map-1000.png`, `map-zoomed-*.png`, `map-selected-*.png`, `map-pending-*.png`, `brief-architecture-*.png`; re-render with `bash render-p0.sh`.
- Numbers the implementation encodes (`MAP_LEVEL_SPECS` in `packages/trace-viewer/src/layout/map-layout.ts`): chip 220 × 48, row gap 20, gutter 40, side gutter 64; card 224 × 84, row gap 40, gutter 72, side gutter 112; detail 280 × 124; two 108 × 18 package chips under a card; names hidden below 37.5% zoom.

Decisions for the person:

1. Bands are columns, left to right: UI, API · IPC, Agents, Domain, Storage, then tests, tooling and config.
2. Fit at 1440 px uses the chip level (names about 12 px); at 1000 px names hide below 37.5% and only role tiles show.
3. Package chips sit under their card, two at most (108 px, so names stay readable); the Inspector lists all of them.
4. Selecting a card dims other edges, not other cards.
5. Narrator states read as quiet words, never banners: "Descriptions pending" (shown), "Descriptions off" and "Descriptions unavailable" (ruling R3); a failed scan reads "Codebase map unavailable" with a Retry text button.

| Gate | Date | Person | Decision | Notes |
|---|---|---|---|---|
| H2 | PENDING | | | |
