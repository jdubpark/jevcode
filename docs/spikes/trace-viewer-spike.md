# Trace viewer rendering spike (R28)

Date: 2026-09-30. Scene: `spike.html?bench=60x300`: 60 chapters at Step level (nine-row lists) plus 40 story frames (about 4k DOM nodes), 300 edges, 5k lane marks. Harness: `apps/trace-viewer-dev/src/spike/*`, driver `apps/trace-viewer-dev/scripts/spike-electron.cjs`, Electron 33 hidden-then-shown window under the Electron CSP (`vite.spike.config.ts`).

## Machine

| Item | Value |
|---|---|
| Model, CPU, memory | MacBook Pro (Mac15,11), Apple M3 Max, 36 GB |
| OS | macOS 27.0.1 (build 26A434) |
| Electron / Chromium | Electron 33.4.11 / Chromium 130.0.6723.191 |
| Displays | One built-in Liquid Retina XDR panel (3456 x 2234), DPR 2. The DPR 1 run passes `--force-device-scale-factor=1` on the Electron command line (see the note below the results). |
| Refresh rate | 120 Hz (ProMotion, adaptive; idle rAF median 8.3 ms). Not the 60 Hz the spec assumes. |

## Pass criteria (spec §16, verbatim)

| # | Risk | Pass |
|---|---|---|
| 1 | Gesture feel and Electron input | `visualViewport.scale` stays 1 and the viewport's `scrollLeft`/`scrollTop` stay 0 throughout; during a pinch the world point under the cursor moves ≤ 1 px per event; in 10 blind trials (5 per controller, order randomized by a second person) the tester identifies the hand-rolled controller at most 7 times |
| 2 | DOM raster cost during pinch at Step level | ≤ 5% of frames dropped (rounded intervals, 60 Hz, §10) on Chromium 130 without `will-change`; if only with it, keep it gesture-only |
| 3 | Text crispness at rest | After settle at each zoom and DPR, a `capturePage` crop of a frame title differs from the same title rendered without a transform at `font-size × k` in ≤ 1% of pixels (any channel differing by > 16) |
| 4 | Keyboard and VoiceOver | VoiceOver reads the frame's `aria-label` ("Linking test, 1 failed, 14 passed, +0:33"); after every j/k, `document.activeElement` is the target frame and its rect lies inside the viewport inset by 48 px |
| 5 | Hybrid DOM/canvas alignment | ≤ 1 px drift; redraw on `devicePixelContentBoxSize` change |
| 6 | View switch under `<Activity>` | Selection, playhead and brush deep-equal before and after; the time at the viewport center maps to within 1 px on the shown view's x map; the hidden view runs zero rAF callbacks; no 0 × 0 fit |
| 7 | Edge hairlines and ruler sync | 1.5 CSS px after settle; ticks within 1 px |

## Automated results

| # | Measured | Result |
|---|---|---|
| 1 (dpr2) | anchor drift max 0 px over 60 events; visualViewport.scale max 1; scroll max 0 | pass (automated part) |
| 2 (dpr2) | without will-change: dropped 0%, p95 1 intervals over 332 frames; with: dropped 3.17%, p95 1 | pass |
| 3 (dpr2) | k 0.5: 35.215% of 62x18 px differ; k 1: 17.003% of 124x36 px differ; k 2: 18.786% of 232x72 px differ | FAIL |
| 4 (dpr2) | 20 j presses, 0 focus/inset failures, 0 scroll resets | pass (automated part) |
| 5 (dpr2) | pin vs mark drift max 0 px over 241 frames; 1 redraws, 0 DPR changes, moved displays: false | pass |
| 6 (dpr2) | 10 toggles: store equal true; center drift max 0 px; hidden rAF callbacks 0; 0x0 fits 0 | pass |
| 7 (dpr2) | stroke k 0.5: 1.5 px, k 0.75: 1.5 px, k 1: 1.5 px, k 1.5: 1.5 px, k 2: 1.5 px; ruler tick drift max 0 px | pass |
| CSP (dpr2) | 0 violations, 0 console errors | pass |
| 1 (dpr1) | anchor drift max 0 px over 60 events; visualViewport.scale max 1; scroll max 0 | pass (automated part) |
| 2 (dpr1) | without will-change: dropped 0%, p95 1 intervals over 352 frames; with: dropped 2.586%, p95 1 | pass |
| 3 (dpr1) | k 0.5: 40.502% of 31x9 px differ; k 1: 25% of 62x18 px differ; k 2: 23.587% of 116x36 px differ | FAIL |
| 4 (dpr1) | 20 j presses, 0 focus/inset failures, 0 scroll resets | pass (automated part) |
| 5 (dpr1) | pin vs mark drift max 0 px over 241 frames; 1 redraws, 0 DPR changes, moved displays: false | pass |
| 6 (dpr1) | 10 toggles: store equal true; center drift max 0 px; hidden rAF callbacks 0; 0x0 fits 0 | pass |
| 7 (dpr1) | stroke k 0.5: 1.5 px, k 0.75: 1.5 px, k 1: 1.5 px, k 1.5: 1.5 px, k 2: 1.5 px; ruler tick drift max 0 px | pass |
| CSP (dpr1) | 0 violations, 0 console errors | pass |

Run notes:

- The driver's `SPIKE_DPR` switch is set with `app.commandLine.appendSwitch`, which Electron 33 on this machine ignores (a `SPIKE_DPR=1` run still reported DPR 2). The DPR 1 rows come from `SPIKE_DPR=1 pnpm --filter jevcode-desktop exec electron --force-device-scale-factor=1 <driver>`; the flag on the command line does force DPR 1.
- Risk 2 rows above use the driver's fixed 60 Hz interval, but this panel runs at 120 Hz: a 120 Hz frame (8.3 ms) rounds to one 60 Hz interval, so a dropped frame at 120 Hz is invisible to that arithmetic. A scratch probe (not committed) recorded rAF stamps during the same sweep and rescored them at the measured 8.3 ms interval:

| Risk 2 rescored | Frames | Dropped at 60 Hz interval | Dropped at measured 120 Hz interval | p95 (120 Hz) |
|---|---|---|---|---|
| without `will-change` | 302 | 0.33% | 30.1% | 2 intervals |
| with gesture-time `will-change` | 409 | 2.39% | 5.3% | 1 interval |

- Risk 3 was rerun once with `?roundK=64` (scratch driver, DPR 2): the differing fractions were identical (35.215%, 17.003%, 18.786%). The saved crops show the frame title clipped one glyph short of the reference at k = 1, so the crop window (`floor`/`ceil` of a fractional rect) and sub-pixel phase probably dominate the metric.
- Risk 5's display move did not run (one display), so the DPR-change redraw path is untested here; the initial `devicePixelContentBoxSize` redraw ran once.

## Human checks

| # | Check | Answer | Result |
|---|---|---|---|
| 1 | Blind A/B, 10 trials | PENDING — deferred by the person on 2026-09-30; revisit before the M4a exit | PENDING |
| 4 | VoiceOver reads each frame label; Tab order | PENDING — deferred by the person on 2026-09-30; revisit before the M4a exit | PENDING |

## Rulings

| # | Result | Ruling applied | Owner |
|---|---|---|---|
| 1 | Provisional pass pending the human check before the M4a exit. Automated part passed at DPR 2 and DPR 1: anchor drift 0 px over 60 events, `visualViewport.scale` 1, scroll offsets 0. | None now. If the blind A/B fails (identified more than 7 of 10): d3-zoom behind the controller API | C1-7F (this lane, before the M4a exit) |
| 2 | Provisional. Passes the spec's 60 Hz arithmetic (0% dropped without `will-change`, 3.17% with, p95 1). This machine runs 120 Hz; rescored at the measured interval it reads 30.1% (p95 2) without and 5.3% (p95 1) with gesture-time `will-change`. The number is not comparable to the spec's 60 Hz budget until rerun at 60 Hz. | Keep gesture-time `will-change` (it costs nothing and helped at 120 Hz). Rerun with the display fixed at 60 Hz before M4b; if it then fails, x0 binary-search culling and capped Step lists | C3-5 / C3-7 |
| 3 | Measured FAIL, but the failure is not yet established. 17.0% to 40.5% of title pixels differ at every k and DPR (limit 1%). A 25% difference at k = 1, DPR 1 (no transform scaling involved) points to crop or origin misalignment, not blur. Suspects: the driver's `floor`/`ceil` rect crop, and the `position: fixed` reference sitting at a different sub-pixel origin than the title. A rerun with `?roundK=64` (uncommitted scratch driver) gave identical numbers. | `settleRoundK: 64` at the Canvas call site is the spec's default remedy, not a proven fix. C3-5 must re-measure with a phase-aligned crop before trusting either the failure or the remedy | C3-5 |
| 4 | Provisional pass pending the human check before the M4a exit. Automated part passed at both DPRs: 20 j presses, 0 focus or inset failures, 0 scroll resets. | None now. If VoiceOver fails: each frame's full description in its Outline row | C2-5 |
| 5 | Pass (initial redraw only; display-move/DPR-change path untested on a single-display machine). Pin vs mark drift 0 px over 241 frames at both DPRs. | None | C2-11 |
| 6 | Pass. 10 toggles: store equal, center drift 0 px, 0 hidden rAF callbacks, 0 zero-size fits. | None | C3-5 |
| 7 | Pass. Edge stroke 1.5 px at k 0.5 to 2; ruler tick drift 0 px. | None | C3-5 |
