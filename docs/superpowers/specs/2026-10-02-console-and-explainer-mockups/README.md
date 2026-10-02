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

- `map.html` renders four states through `?state=`: `default` (Fit, centered, at the card level on 1440 and the chip level on 1000), `zoomed` (detail level at 150%: purpose, packages, file count), `selected` (`desktop main` selected: its edges in accent, including same-band and hub edges, the rest at 22%; component Inspector; the narrative link for the component in accent), `pending` (rule-based header with the partial, imports-not-analyzed and descriptions-pending notes).
- `brief-architecture.html` shows the Brief's architecture card at 280 px and 248 px: narrator text, narrator pending, fresh session. The thumbnail draws the Map's own lanes and cards; touched cards are accent.
- `brief-architecture.html` also shows the overview status states (interfaces §8 R3): scanning ("Mapping codebase · 3,200 / 9,800 files" with a progress bar), scan failed ("Codebase map unavailable" with Retry), and "Descriptions off", "Descriptions unavailable", "Descriptions pending", each as the Map header strip plus the Brief card.
- The shell (header, sidebar, view switcher, Brief column, prompt dock, status bar) matches the Phase A PNGs; the Brief column is 300 px, 264 px under 1180 px.
- PNGs: `map-1440.png`, `map-1000.png`, `map-zoomed-*.png`, `map-selected-*.png`, `map-pending-*.png`, `brief-architecture-*.png`; re-render with `bash render-p0.sh`.
- Numbers the implementation encodes (one geometry for every level; levels change card content, never positions): card 140 × 76, side band 104 wide, row gap 16, gutter 22, margin 16, band label 44, lane padding 6. Levels by zoom: chip < 0.7 ≤ card < 1.4 ≤ detail; names hide below 0.48. Fit centers on both axes with padding 20 (sides), 20 (top) and 68 (bottom, for the zoom bar), at most 100%.
- Card at the card level: name (17 world px, up to two lines, breaking at spaces and hyphens), then a footer with the role icon, a file-count bar (length ∝ √(files ÷ largest)) and the count. Chip level: name at 20.5 world px, icon and bar. Detail level: name, purpose, two packages, bar and "n files".
- Edges at rest: band-to-band only, thin (1, 1.6, 2.4 px by import count) and light (`#C4C9D1`), as gutter curves; long edges run in the gap row next to their left card, so edges that share a source share a line. Same-band edges and edges into a hub (imported by at least max(6, components ÷ 4) others; `contracts` here) appear when their card is selected or hovered; a short stub marks the hub's port.

Decisions for the person:

1. Bands are columns on light lanes, left to right: UI, API · IPC, Agents, Domain, Storage, then a narrow Support band (tests, tooling, config).
2. Fit fills the stage: card level at 1440 (names about 13 px), chip level at 1000 (names about 11 px, all 21 names in full).
3. At rest the Map draws band-to-band edges only; same-band and hub edges show on selection or hover.
4. Packages show inside the card at the detail level only; the Inspector lists all of them.
5. Selecting a card dims other edges, not other cards. Its name in the narrative turns accent.
6. Narrator states read as quiet words, never banners: "Descriptions pending" (shown), "Descriptions off" and "Descriptions unavailable" (ruling R3); a failed scan reads "Codebase map unavailable" with a Retry text button.

| Gate | Date | Person | Decision | Notes |
|---|---|---|---|---|
| H2 | PENDING | | | |

## Phase C (S-0, gate H3)

| Screen | File | PNGs |
|---|---|---|
| Brief story and pending decision card (Console summary marked rule-based) | `c-brief-story.html` | `c-brief-story-1440.png`, `c-brief-story-1000.png` |
| Console summary blocks, decided card with its why, decided card with no why (Descriptions pending) | `c-console-summary.html` | `c-console-summary-1440.png`, `c-console-summary-1000.png` |
| Decision in the Inspector (tradeoffs, why, components) | `c-decision-inspector.html` | `c-decision-inspector-1440.png`, `c-decision-inspector-1000.png` |
| Map session overlay, legend and toggle | `c-map-overlay.html` | `c-map-overlay-1440.png`, `c-map-overlay-1000.png` |

- Shell, Brief column and Map card style match Phase A and B. Shared CSS is `phase-c.css`; re-render with `bash render-c.sh`.
- Story citations are quiet chips; an icon shows the kind (component, decision, file, test run, narrative quote).
- A rule-based story (ruling F1) carries a quiet "rule-based" label next to "Summary", no color. Narrator stories carry no label.
- A decided card without a why (ruling R3) shows the narrator state in quiet ink ("Descriptions pending"; "Descriptions off" and "Descriptions unavailable" use the same slot).
- Decision cards: pending is the accent tint, decided is neutral. The small fork graphic shows the open branches dashed and the chosen branch solid.
- Session overlay marks sit in the card's footer, in place of the file count: ring = new, dot = changed, diamond = decided, red dot = failing. Untouched components fade, and edges between touched components are darker.

| Gate | Status | Notes |
|---|---|---|
| H3 | PENDING | Awaiting the person's review. S-4 and S-5 start after this row says "approved <date>". |
