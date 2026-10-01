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

## M4a gate (lane C2, 2026-09-28)

| Risk | Result (from the rows above) | Ruling applied in M4a | Owning task |
|---|---|---|---|
| 1 Gesture feel and Electron input | Provisional pass pending the human check before the M4a exit. Automated part passed at DPR 2 and DPR 1: anchor drift 0 px over 60 events, `visualViewport.scale` 1, scroll offsets 0. | none | C1-7F (W1) |
| 4 Keyboard and VoiceOver | Provisional pass pending the human check before the M4a exit. Automated part passed at both DPRs: 20 j presses, 0 focus or inset failures, 0 scroll resets. | Outline chapter rows always carry the full frame description in their accessible name | C2-5 |
| 5 Hybrid DOM/canvas alignment | Pass (initial redraw only; display-move/DPR-change path untested on a single-display machine). Pin vs mark drift 0 px over 241 frames at both DPRs. | none: DOM pins | C2-11 (`PINS_PAINTED_ON_CANVAS`) |

M4a proceeds: risks 1, 4 and 5 passed or have their ruling applied by the owning task.

## M4a exit (lane C2, 2026-09-30)

Reference machine: Mac15,11 (Apple M3 Max, 36 GiB), macOS 27.0.1, Node 22.23.1, Google Chrome 154.0.8037.92. The automated rows below ran in headless Chrome (`--headless=new`, real time, no throttling flags) on a shared machine with load average about 4 (1-minute), so they are provisional. The desktop-Chrome measurement on a 60 Hz display (H5) is PENDING.

Input: `JEVCODE_SOAK_PROFILE=trace JEVCODE_SOAK_EXPORT=… node scripts/soak.mjs` wrote 110,962 trace rows (208 MiB) after 1,053 s; `traceReadMs` median 1,027 ms (runs 827, 1,061, 935, 1,027, 1,492), page p95 12.3 ms at 2,000 rows per page.

| Budget (spec §10) | Target | First measurement (lane C2 head 32c0b0a) | After the C2 fix wave (integration, 2026-09-30) | Pass now |
|---|---|---|---|---|
| Soak first paint (median of 5 cold loads after 1 discarded) | ≤ 300 ms | 1,670 ms (runs 1,665, 1,670, 1,670, 1,697, 1,674) | 183 ms (runs 181, 183, 184, 173, 183) | yes |
| Soak full load (same runs) | ≤ 2 s | 1,670 ms (same runs) | 965 ms (runs 965, 958, 967, 969, 962) | yes |
| `j` to painted, 300 presses at Chapter level (`?perfrun=1`) | p95 ≤ 16.7 ms | p95 318.7 ms, median 114.7 ms, n 300 (measured inside a rAF callback) | p95 18.8 / 18.9 ms, median 8.8 / 8.2 ms, n 300 (two runs); zero-work baseline p95 10.6 / 11.0 ms, median 2.9 / 3.7 ms | no (by 2 ms; see below); provisional pending H5 |
| Overview layout + paint, Session-level sweep | p95 ≤ 4 ms | p95 8.0 ms, median 5.5 ms, n 510 | p95 0.5 ms, median 0.2 ms, n 512 (both runs) | yes |
| Overlay nodes during the sweep | ≤ 150 | 10 | 7 / 9 | yes |
| Anchor drift (`?selftest=drip`, oauth) | ≤ 1 px | 0 px (`SMOKE_OK`, rows 74) | 0 px (`SMOKE_OK`, rows 76) | yes |

The second column was taken after the four fix branches (M, A1, A2, B) and the integration commits were merged into `tv/c2-shell-hybrid`, on the same machine, in headless Chrome driven over CDP (`--headless=new`, real time, DPR 1, 1440 × 900), with a 1-minute load average of 6 to 8. First-paint and full-load values are the `tv:first-paint` and `tv:full-load` measures, which start at `tv:bundle-parsed` (about 1.15 s after navigation for the 208 MiB file).

What changed since the first measurement:

- First paint is now progressive. The data controller yields to the browser between pages (A2), so the viewer paints the first page instead of painting once after the last one. The fold got cheaper too (M part 2): a conservative exact guard skips zod for `change_unit` rows that zod would accept unchanged (fold 791 → 236 ms in Node), and a quadratic pass over shared validations that M part 1 had introduced in `buildChapters` (finalize 14.1 s in Node) is linear again (253 ms). A soak-shaped timing test (`model/fold.soak-shape.test.ts`) now guards that shape.
- `j` to painted: A1 moved the harness to real input (keydown `timeStamp` to the next frame's paint, pressed from a macrotask at a random frame phase, per the orchestrator ruling), which removes the full frame the old rAF-dispatched presses added by construction, and it records a zero-work baseline (an unbound key). A1 also made each `j` do one spine reveal with no forced layout; M cut Chapter-level `buildSpineRows` on soak from 115 ms to 3 ms (noise labels once per run) and Session level from 88 ms to 2 ms. The viewer's own share (median `j` minus median baseline) is about 5 ms. The p95 misses the 16.7 ms budget by about 2 ms while the baseline p95 alone is 11 ms on this loaded machine, so the miss is not yet attributable to the viewer; H5 on a quiet desktop decides it. Orchestrator ruling (2026-09-30): the 18.8 ms result is provisional pending H5; it does not block the C2 merge and blocks only the M4a exit if H5 confirms the miss.
- Overview paint: M replaced the per-frame band merge with cached, pre-merged band chains and a binary search to the viewport (`layoutOverview` on the pre-M6 160k-piece shape 32–44 ms → 0.6 ms), and B made the overview lay out once per camera change instead of once per render.

The `?perf=1&perfrun=1` autorun completes in real time (about 60 s). It never completes under `--virtual-time-budget`.

Smoke: `node apps/trace-viewer-dev/scripts/smoke.mjs --views hybrid` printed `SMOKE_OK 2 screenshots` (371 s); screenshots `apps/trace-viewer-dev/.smoke/hybrid-1440.png` and `hybrid-1000.png` (git-ignored; regenerate with the command). Two defects surfaced while making it pass: the drip selftest reported 214 px of "drift" because a scroll landing between anchor refreshes was counted (fixed in `Spine.tsx`: drift is now the movement the scroll offset and the anchor compensation do not explain), and the open probe or the screenshot Chrome occasionally wrote no result (one rerun passed; see the report).

Smoke after the fix wave: `node apps/trace-viewer-dev/scripts/smoke.mjs --views hybrid --port 4195` printed `hybrid: opened with step:92 selected and in view, painted at 62 ms`, `hybrid: selftest ok (rows 76, max drift 0px)` and `SMOKE_OK 2 screenshots`. In its `--screenshot` capture (virtual time) the top spine row still sits half under the range chip at Chapter level; in real time the spine start-aligns it about 300 ms after open (integration item 5).

Found at once (spec §1; `?selftest=open`, Hybrid, 1440 px): the smoke printed `hybrid: opened with step:92 selected and in view, painted at 74 ms`. The selection equals oauth's claim step, the claim row lies inside the spine viewport, its pin lies inside the overview viewport, and `tv:initial-selection-painted` `startTime` is 74 ms (≤ 5000).

Screenshot observation (not a human sign-off): in `hybrid-1440.png` the Inspector's claim-versus-observed graphic wraps the claim text into a narrow column and the observed pill runs past the panel's right edge. After the fix wave (not a human sign-off either): the Inspector leads with the failing test, an Evidence list with mini graphics and short Related rows; the claim-versus-observed card lives in the spine row and matches the mockup's layout; the top spine row no longer sits half under the range chip; headless screenshots of oauth at 1440, 1180 and 1000 px, each level, with and without a selection, are listed in `.superpowers/sdd/2026-09-28-trace-viewer-06-viewer-shell-hybrid/fix-wave-integration.md`.

PENDING human rows (all deferred by the person on 2026-09-30):

| Check | Status | Exact steps |
|---|---|---|
| H5 M4a budgets in desktop Chrome | PENDING — deferred by the person on 2026-09-30; revisit before the M4a exit | With the soak bundle in `apps/trace-viewer-dev/public/bundles/soak.json` (regenerate: `JEVCODE_SOAK_PROFILE=trace JEVCODE_SOAK_EXPORT="$PWD/apps/trace-viewer-dev/public/bundles/soak.json" node scripts/soak.mjs`, about 18 min), run `pnpm --filter jevcode-trace-viewer-dev build && pnpm --filter jevcode-trace-viewer-dev exec vite preview --port 4179 --strictPort`. In desktop Chrome on a 60 Hz display, open `http://localhost:4179/?bundle=soak&perf=1` in 6 fresh incognito windows (discard the first) and read `tv:first-paint` and `tv:full-load` from the HUD; then open `…&perf=1&perfrun=1`, wait about 60 s for `<pre id="perf-result">` and copy its JSON. Targets: first paint median ≤ 300 ms, full load median ≤ 2,000 ms, `tv:key-to-paint` p95 ≤ 16.7 ms, `tv:overview-paint` p95 ≤ 4 ms, `maxOverlayNodes` ≤ 150. |
| H6 product review gate | PENDING — deferred by the person on 2026-09-30; revisit before the M4a exit | The person reviews oauth, api-break and the soak bundle in the dev host against spec §1 and §12 M4a (docs/IMPLEMENTATION-PLAN.md:153) and records the verdict and notes here. |
| VoiceOver, Hybrid, oauth (gap G3; spec §7.13, §11) | PENDING — deferred by the person on 2026-09-30; revisit before the M4a exit | Serve `?bundle=oauth` as above (window at least 1440 px). 1) Open `http://localhost:4179/?bundle=oauth`, wait for the Inspector title "Claim contradicts tests". 2) Cmd+F5 (VoiceOver on). 3) Click the address bar, Tab out of the title bar, keep pressing Tab: focus enters the Outline, then the reading spine in `main`, then the Inspector, one stop each; Shift+Tab walks back. 4) On the spine stop VoiceOver reads the selected row with "+0:43" and "Claim contradicts tests". 5) Rotor (Control+Option+U), Form Controls, "Playhead": reads "Playhead", "slider", "+0:43, Claim contradicts tests, step <n> of <m>". 6) Escape, click the claim row, Option+3, rotor Form Controls: "Range start" and "Range end", each with a "+m:ss" value. 7) Cmd+F5, then record pass or fail for 3–6, what VoiceOver said, and the macOS and Chrome versions. A fail returns C2-8 (item 3), C2-12 (item 4) or C2-11 (items 5, 6). |

## M4b gate (C3-5)

Date: 2026-10-01. Lane C3b (`tv/c3b-canvas-view`). Source rows: the risk table above, plus the orchestrator's C3-5 gate rulings.

| Risk | Verdict | Ruling applied | Where |
|---|---|---|---|
| 2 DOM raster cost during pinch at Step level | Provisional pass at 120 Hz; 60 Hz rerun PENDING (needs a human to set the display to 60 Hz) | Spec §16 fallback applied pre-emptively | `CULL_FRAMES = true` in `packages/trace-viewer/src/ui/views/canvas/spike-rulings.ts` |
| 3 Text crispness at rest | Phase-aligned re-measure: pass at k 0.5 and 1, FAIL at k 2 (see below) | Fallback applied | `CANVAS_SETTLE_ROUND_K = 64` (same file) |
| 6 View switch under `<Activity>` | pass | none | `KEEP_HIDDEN_VIEWS_MOUNTED = true` in `packages/trace-viewer/src/ui/views/registry.ts` |
| 7 Edge hairlines and ruler sync | pass | none | `INV_K_EVERY_FRAME = false` (same file as risk 2) |

M4b may start: every gating risk passed or has its spec §16 fallback applied above.

### Risk 3 re-measure (phase-aligned crop)

Method: `SPIKE_ONLY3=1 [SPIKE_ROUNDK=64]` driver runs of `apps/trace-viewer-dev/scripts/spike-electron.cjs` (dist-spike build, Electron 33.4.11; DPR 1 via `--force-device-scale-factor=1`). The harness pins the reference title to the transformed title's exact fractional origin (`alignReference`), then captures the title (reference hidden) and the reference (world `visibility: hidden`) with one identical device-pixel crop rect (floor of the origin, ceil of the far edge). Threshold: 1% of pixels with any channel differing by more than 16.

| DPR | roundK | k 0.5 | k 1 | k 2 |
|---|---|---|---|---|
| 2 | null | 0.817% of 68x18 px | 0.134% of 124x36 px | 1.512% of 248x72 px |
| 2 | 64 | 0.817% | 0.134% | 1.512% |
| 1 | null | 0.98% of 34x9 px | 0% of 62x18 px | 1.411% of 124x36 px |
| 1 | 64 | 0.98% | 0% | 1.411% |

Reading: the old 17% to 40% failure was crop misalignment, as suspected. Aligned, k 0.5 and k 1 pass. k 2 fails narrowly (1.5% at DPR 2, 1.4% at DPR 1). At k 2 the transformed title measures 123.05 CSS px against 115.15 for the same text laid out at 26 px (k 0.5: 30.76 against 33.25): text laid out at 13 px and scaled has different advance widths than text laid out at `13 × k`, so the metric measures glyph layout, not blur. The 1/64 grid leaves k = 0.5, 1 and 2 unchanged (they are on the grid), so the `roundK=64` rows equal the null rows; the rounding cannot change these three points and the fallback is applied per the ruling (rounding matters only for off-grid k, which the aligned probe did not sample). Risk 3 stays open for a human look at off-grid zoom (PENDING, revisit before the M4b exit).

### C3-10 camera perf (fix round 1, 2026-10-01)

The first Canvas view wrote the camera as inherited custom properties on the viewport, so every frame restyled the whole world subtree. That was not the C1-7 path that passed risk 2. Fix round 1 restores the spike's approach. Each frame now writes the world's `transform` directly, the dot grid's `background-position` and `background-size` on the viewport, and `--tv-tx`, `--tv-ty` and `--tv-k` on the overlay root only. `--tv-inv-k` goes on the world at settle and at a tween's end (risk 7 ruling), and `will-change: transform` is set only during gestures and tweens. The controller measures its element once per gesture. The minimap and the ruler do no React render on a pan frame. Edges, separators and junction dots are culled with frames (x-extent of each path), and the mounted range follows long pans (throttled to 100 ms).

Probe: headless Chrome 1440×900 (software compositing), Vite dev server, soak bundle at Step level, camera (0, 0, 0.2), 121 frames mounted. One wheel event per animation frame for 180 frames: a pan of 8 px per frame, then a ctrl-wheel zoom of ±4 per frame that reverses every 30 frames. "Flush" is a forced style and layout flush after each camera write. Before: two runs on 3201de4. After: three runs.

| Metric | Before | After |
|---|---|---|
| Pan frame interval median / p95 | 16.7 / 33.4 ms | 16.7 / 16.8 ms |
| Pan frames over 1.5× median | 35–38 of 180 | 1–2 of 180 |
| Pan flush median | 2.4 ms | 0.9 ms |
| Zoom frame interval median / p95 | 50.0 / 83.4 ms | 16.7 / 33.4 ms |
| Zoom frames over 20 ms | 140–142 of 180 | 58–59 of 180 |
| Zoom flush median | 16.2 ms | 3.3 ms |
| Elements under the viewport | 11,895 (26 paths, 20 separators) | 11,769 (1 path, 0 separators in range) |

The remaining zoom long frames are mostly Chrome `Layerize` work (about 16 ms per long task in a trace). Hiding the overlay halves them (58 → 30), because its labels re-layout on every change of k (their `max-width` scales with k). This is headless software compositing. C3-12's Electron pinch measurement is the gate (Step pinch ≤ 5% dropped).

## M4b exit (C3-12)

Date: 2026-10-01. Lane C3b (`tv/c3b-canvas-view`). Reference machine: as named in the M4a exit section (Mac15,11, Apple M3 Max, 36 GiB, macOS 27.0.1, Node 22.23.1, Google Chrome 154.0.8037.92, Electron 33.4.11). The built-in panel ran at 120 Hz (idle rAF median 8.3 ms), DPR 2. Load average (1-minute) was 7 to 8 during every measurement below, on a shared machine.

| Criterion (spec §12 M4b) | Result | Evidence |
|---|---|---|
| Spike risks 2, 3, 6, 7 pass or ruled | Risk 2 provisional pass with the fallback applied (`CULL_FRAMES = true`), 60 Hz rerun PENDING. Risk 3 fallback applied (`CANVAS_SETTLE_ROUND_K = 64`), off-grid look PENDING. Risks 6 and 7 pass. The spike harness rerun today gave the same rows (risk 3 k 2: 1.512%, risk 6 and 7 pass). | this doc, "M4b gate (C3-5)" |
| oauth in Canvas matches the spec §7.5 table | pass on the test session at C3-12; FAIL on the replayed bundle's shape until the lane-review fix round, pass after it | The C3-12 row covered only `oauthCanvasSession()`, whose units come from `expected_units.json` and cite no validation (C3-2 test "matches the spec §7.5 table from a fresh layout"). The replayed bundle the smoke screenshots has one failed `pnpm test` run in all seven chapters, validation-only in six; it promoted both noise chapters to full frames (lane review I-3). Since c006b6e, `oauthReplaySession()` (fixtures/oauth folded with the clusterer's own units, the same shape) lays out the same table with `Noise ×2` at (264, 600): "places the replay shape … noise stacked". |
| Switch tests pass | pass | `view-switch.test.tsx` (C3-11, plus the C3-12 pre-step cases for a level change and a Live append while hidden) |
| Both smokes green | `SMOKE_OK 4 screenshots` | `node apps/trace-viewer-dev/scripts/smoke.mjs --views hybrid,canvas --skip-build --port 4183` |
| View switch restored in the toggle's frame; never a 0 × 0 fit | 20 switches, 0 misses | same smoke, `?selftest=switch` |
| Canvas pinch at Step level ≤ 5% frames dropped (Electron 33, 60 Hz) | Provisional pass at the spec's 60 Hz arithmetic; FAIL for the spike scene when rescored at the panel's measured 120 Hz (see the budget table). 60 Hz rerun PENDING. | spike harness `spike-electron.cjs`; scratch rescoring and real-Canvas drivers (below) |
| `layoutCanvas` fresh ≤ 2 ms / sticky ≤ 0.5 ms (benchmark, not a gate) | 0.361 ms / 0.356 ms (means; C3-4 recorded 0.413 / 0.426) | `vitest bench --run src/layout/canvas-layout.bench.ts`, 2026-10-01 |
| Canvas anchor drift ≤ 1 px (smoke) | 0.000016 px | same smoke, Canvas `?selftest=drip` |

### M4b budgets, measured against target

| Budget (spec §10) | Target | Measured | Pass |
|---|---|---|---|
| Canvas pinch at Step level, spike scene (60 chapters at Step level, 300 edges), sweep 0.35 → 2 over 3 s, spec arithmetic (60 Hz intervals) | ≤ 5% dropped, p95 ≤ 1 interval | without `will-change`: 0%, p95 1, 330 frames; with gesture-time `will-change`: 3.468%, p95 1 | yes (provisional: panel at 120 Hz) |
| Same sweep rescored at the measured 8.33 ms interval (3 runs) | ≤ 5% dropped, p95 ≤ 1 | without `will-change`: 35.73 to 37.29%, p95 2 (226 to 231 frames); with gesture-time `will-change`: 6.65 to 7.50%, p95 1 (332 to 336 frames) | no |
| Canvas pinch at Step level, the real Canvas view on the soak bundle (105 frames and 9,928 elements mounted at k 0.34), ctrl-wheel sweep 0.35 ↔ 2 over 3 s, 3 runs each way | ≤ 5% dropped, p95 ≤ 1 | 60 Hz arithmetic: 0 to 0.86%; at the measured 8.33 ms interval: 0 to 4.17% (0.35 → 2) and 0% (2 → 0.35); p95 1 in all six runs; raw interval median 8.3 ms, p95 9.5 to 10.0 ms | yes |
| View switch: restore painted in the toggle's frame, never a 0 × 0 fit | 0 misses in 20 switches | 20 switches, 0 misses (`?selftest=switch`, real time over the DevTools protocol) | yes |
| Anchor drift, Canvas `?selftest=drip` on oauth | ≤ 1 px | 0.000016 px (world coordinates) | yes |

Methods and caveats:

- The spike rows come from `pnpm --filter jevcode-desktop exec electron apps/trace-viewer-dev/scripts/spike-electron.cjs` after `vite build --config vite.spike.config.ts`. The rescored rows come from a scratch driver (not committed) that records rAF stamps during `window.__spikeRun.sweep(false|true)` in the same page and rounds them at the measured interval. The spike harness loads a static page, so no native-module ABI switch was needed.
- The real-Canvas rows come from a scratch Electron driver (not committed) against `vite preview` of the dev host with `?bundle=soak`, view Canvas, level Step. It dispatches one ctrl `WheelEvent` per animation frame on the viewport center, sized so k follows 0.35 × (2 / 0.35)^(t / 3 s), and records rAF stamps. Synthetic wheel events skip the browser's input pipeline, so a trackpad pinch adds input latency this does not measure.
- The spike scene rescored at 120 Hz misses even with `will-change`; the real Canvas view (compositor-only camera frames, C3-10; culling, `CULL_FRAMES`) passes at 120 Hz. The spec budget is defined at 60 Hz, where both pass. If the 60 Hz rerun misses, the next remedy is to hide frame labels during a pinch below the readable zoom band (C3-10 re-review), before any other change.
- Live tick with Canvas active on soak (lane review minor 2, a known M5 risk, not an M4b gate): 131 ms median per data commit at Chapter level (7 runs, max 148 ms) and 132 ms at Step level (max 134 ms). Of that, the sticky `layoutCanvas` takes 120 ms and 122 ms, and `buildFrameContext` plus `criticalFrameKeys` take the other 11 ms. The spec §10 M5 budget is a live-tick p95 ≤ 16 ms, so Canvas as the active view misses it by about 8×. Method: a scratch vitest probe (Node 22, not committed) folds `soak.json` (110,962 rows, 9,874 steps, 4,861 chapters) without and with its last 20 rows and lays out the second fold with the first fold's layout as `prev`. After I-3 the layout has 135 frames (40 noise stacks hold 4,800 chapters; 2 critical), against 4,895 frames before, and a fresh layout costs about the same (122 to 123 ms), so the cost is per chapter and item, not per frame. Next lever: incremental sticky placement over the appended items only. The `canvas-layout.bench.ts` scene (60 chapters) does not represent this. A hidden Canvas no longer pays this per commit (60ba693, lane review I-5).
  - Follow-up, 2026-10-01 (`tv/canvas-live-tick`): the cost was per chapter-step link, not per chapter. Each soak chapter links about 33 steps (31 shared test runs), about 160k links in all. `collectItems` re-derived each chapter's anchor and ran `stepOf` plus `anchoredFindings` on every link (54 ms). Routing walked each shared run's 4,861 chapters with several lookups per link and built 150k `validates` specs before deduplicating them (about 45 ms). `criticalFrameKeys` and the running check listed every stack's linked steps. Fixes: ee192c5 reuses `TraceIndex.chapterAnchor`, uses a set of finding-anchoring steps, keeps one placed-chapter map and deduplicates pairs as it meets them; 15c101b tests tone and running against per-context step sets. Layout output is unchanged (deep-equal on soak prefixes at every level, fresh and sticky, and on 1,500 fast-check sessions). The Node probe on soak (load 4.9) now gives sticky `layoutCanvas` 15.7 ms (was 120 ms), fresh 18.7 ms, and `criticalFrameKeys` about 3 ms (was 8.6 ms). `canvas-layout.soak-shape.test.ts` guards the shape on 5,000 units × 31 shared runs by counting `chapterAnchor` and `stepOf` calls (per chapter, not per link) with a loose 1 s sanity bound; `canvas-live-tick.equivalence.property.test.ts` compares the optimized tone, running, flagged and `validates` routing with reference implementations. The sticky layout runs about 12 ms and the old code took 71 to 87 ms. All timings in this entry are from an Apple M3 Max.
  - The spec §10 HUD live tick (`tv:live-tick`, poll apply to paint), measured on the minified dev host (`vite preview`, headless Chrome 1440 × 900, `?bundle=soak&perf=1&drip=20,1000,-2000`, Chapter level). Three interleaved runs per cell, 87 samples per run, 1-minute load 3.6 to 4.7. Before (4cec922): Hybrid median 175 to 177 ms, p95 192 to 193 ms; Canvas median 286 to 290 ms, p95 306 to 314 ms. After (15c101b): Hybrid median 176 to 178 ms, p95 190 to 193 ms (no regression); Canvas median 198 to 202 ms, p95 215 to 217 ms. Fresh open (`tv:full-load`) with Canvas active went from 1,055 to 1,081 ms to 947 to 959 ms; Hybrid stayed at 926 to 946 ms. Canvas now costs about 23 ms per tick more than Hybrid, down from about 112 ms. Both views still miss the 16 ms budget by about 11×. The shared cost is the full-session model `finalize` on every commit, about 100 to 120 ms per tick in the Chrome profile (`buildChapters` 70 to 80 ms), plus `buildTraceIndex` and the Outline rows. Spec §10's remedy, incremental appends in the selectors before a worker fold, applies to the model first. A strictly O(appended rows) Canvas layout also needs that remedy. The fold rebuilds every Step and Chapter object on each commit, so the layout cannot tell which chapters are unchanged. With identity-stable fold output, per-chapter work could be cached.
  - Follow-up, 2026-10-01 (`tv/incremental-finalize`): `finalize` is now incremental and its output identity-stable (spec §6.4): an unchanged step, chapter, entity, turn or finding is the same object across commits. The soak Node probe went from 189 ms to 2.1 ms median per 20-row tick (p95 234 to 3.3 ms), and the Outline rows are cached per object. Dev host HUD live tick (same method as above, load 3.6 to 5.2): Hybrid median 173.9 to 178.2 ms before, 52.9 to 53.7 ms after (p95 190.2 to 193.3 before, 66.0 to 66.8 after); Canvas median 201.4 to 202.5 ms before, 79.4 to 82.4 ms after (p95 215.6 to 217.2 before, 89.2 to 91.7 after). Both views still miss the 16 ms budget by about 4× and 5×. The rest of a Hybrid tick is `buildTraceIndex` (15.5 ms) and `buildOverviewIndex` (9.2 ms), both O(chapter-step links) per commit, then `finalize` (6.3 ms), the Outline (6.3 ms), Spine, React commit and GC (`docs/perf.md`, "Live tick after incremental finalize"). The Canvas layout can now cache per chapter object as well.
  - Follow-up, 2026-10-01 (`tv/incremental-finalize`, 6752d62 to 5bf6c07): `TraceIndex` and the overview index are now built from the previous commit's, so neither is O(chapter-step links) per commit. The soak Node probe went from 16.1 to about 1 ms (`buildTraceIndex`) and from 10.4 to about 2 ms (`buildOverviewIndex`) per 20-row tick. The Outline builds only the rows it shows. Dev host HUD live tick (same method, 98 samples per run, load 4.1 to 6.4) against 5626b9a: Hybrid median 51.9 and 52.6 ms before, 28.9 and 28.8 ms after (p95 63.6 and 68.0 before, 35.7 and 37.0 after); Canvas median 83.1 and 81.4 ms before, 62.5 ms twice after (p95 91.4 and 91.8 before, 74.0 and 73.7 after). Both still miss the 16 ms p95, by about 2.3× in Hybrid and 4.6× in Canvas. The Hybrid rest is O(steps) per commit: signals, Outline story rows, Spine rows and GC. Canvas adds about 34 ms: the sticky `layoutCanvas` (16.5 ms) and per-frame tone, flag and critical passes that walk every member's steps (about 15 ms; `docs/perf.md`, "Incremental indexes"). This M5 risk stays open.
  - Follow-up, 2026-10-01 (`tv/incremental-finalize`, 6e72834 to 4e6cd2e): the Canvas per-frame passes and most of the sticky layout now start from the previous commit. A frame keeps its tone, running flag and flag while its members resolve to the same objects and no listed step flipped bad or running; routing keeps each step's home and each frame's validation sources; items keep each chapter's noise flag. The signal rules visit only the steps they read, and the Outline's graphic lookups derive from the previous session's. Each path equals a fresh build after every commit in property tests. Soak Node probe per 20-row tick: `layoutCanvas` 22.5 to about 11 ms, frame passes 8.6 to 1.0 ms, `finalize` 2.3 to 1.5 ms. Dev host HUD live tick (same method; three interleaved runs of 98 samples per cell, 294 pooled; load 3.4 to 5.2) against a6eaf99: Hybrid 29.9 / 36.4 to 27.1 / 33.3 ms (median / p95), Canvas 64.6 / 73.3 to 48.0 / 55.3 ms; open unchanged. Both still miss the 16 ms p95, by about 2.1× in Hybrid and 3.5× in Canvas. The rest is spread thin: GC about 6.5 ms and native commit time about 11.5 ms per tick (unminified), Outline and Spine rows, `layoutCanvas`'s O(chapters) map reads, and frame marks for the ~14 frames per tick that hold a changed chapter (`docs/perf.md`, "Canvas and signals from the previous commit"). This M5 risk stays open.
- The drip probe measures the anchored frame's move in world coordinates, scaled by k. A camera move is not drift, as the spine probe does not count a scroll it can explain. Review keeping the camera still under appends is asserted in `canvas-view.test.tsx`.

Screenshots: `apps/trace-viewer-dev/.smoke/canvas-1440.png`, `apps/trace-viewer-dev/.smoke/canvas-1000.png` (git-ignored; regenerate with the smoke). Mockup comparison (Step 7, not a human sign-off): at 1440 px the four columns match the mockup's order (Intent; Plan over Package, Auth architecture, Migration · identities and Lockfile; Account-linking policy over Code · users, a second Account-linking policy chapter and Tests · oauth; Final claim), the trunk runs along the top row, the red `≠` connector with the word "contradicts" joins Tests · oauth and Final claim, the floating toolbar has no comment tool, the minimap sits at the bottom right, and "Claim contradicts tests" is selected in the Inspector. Findings beyond the listed deviations:

1. Before the two C3-12 camera fixes (b68fe4a, 30e434d) oauth opened at k 1 with the claim centered and the Intent column off screen; it now opens at the brush fit.
2. The title bar zoom label reads 100% in both screenshots while the fit is below 1. It is a capture artifact: `--screenshot` runs in virtual time and catches the show tween before it ends. Read in real time over the DevTools protocol 3 s after open, the label is 83% at k 0.8346 (1440 px, viewport 944 px) and 45% at k 0.4488 (1000 px, viewport 552 px), both equal to (width − 96) / 1016.
3. The minimap outlines seven frames in red, while the main view shows red only on Tests · oauth and Final claim. Cause (corrected by the lane review, I-1): the anchor rule held, since the failing_tests finding is anchored at the shared `pnpm test` run. What was missing is the validation-only exclusion: `criticalKeys` read every step in each chapter's `stepIds`, including that run, which is in all seven chapters and validation-only in six. On soak the same rule marked 4,862 of 4,895 frames. Fixed in 383c168: the critical set is the frames whose `frameTone` is bad.
4. The "contradicts" word overlaps the second Account-linking policy chapter's label at both widths ("Account-linking pc" at 1440 px). Fixed by I-3 (the layout no longer puts the badge in a label row) and by dd5c325 (labels and the selection's time chip are obstacles for the word).
5. The noise pair renders as a "Lockfile · +0:21" frame in the Plan column rather than the mockup's "Noise ×2" stack label. Fixed in c006b6e (lane review I-3).
6. At 1000 px the Final claim card is clipped by the Inspector edge in the capture, which is the same mid-tween frame as item 2; at the settled 45% fit the content spans the viewport width.

Lane-review fix round (2026-10-01, c006b6e..88e8d6d): the smoke reran green (`SMOKE_OK 4 screenshots`, canvas drift 0.000025 px, 20 switches with 0 misses). At 1440 px only Tests · oauth and Final claim are red in the main view and the minimap, Lockfile and Code · users stack as one `Noise ×2` frame at (264, 600), "contradicts" sits right of its mark with no label or chip under it, the claim's chip reads "+0:43", and no card but Tests · oauth lists the shared `pnpm test` run, also at Step level (a scratch capture at level Step, not committed).

### PENDING human checks (deferred by the person on 2026-09-30; revisit before the M4b exit)

| Check | Status | Steps |
|---|---|---|
| Risk 2 rerun at 60 Hz | PENDING — deferred by the person on 2026-09-30; revisit before the M4b exit | Set the display to 60 Hz: System Settings, Displays, Refresh rate "60 Hertz" (ProMotion off). Run block A below from the repo root. Read the row "2 (dpr2)". Pass: dropped ≤ 5% and p95 1, both without and with `will-change`. Record the numbers in this section, then restore ProMotion. |
| Risk 3 off-grid text look | PENDING — deferred by the person on 2026-09-30; revisit before the M4b exit | Run block B, open `http://localhost:4179/?bundle=oauth` in desktop Chrome, press `1` for Canvas. Ctrl+scroll (or pinch) to an off-grid zoom such as 83% or 137% (title bar label), stop, wait 1 s. Compare the frame titles with the same titles at 100% (the title bar's zoom menu). Pass: titles look as sharp as at 100%, with no blur or shimmer after the settle. Record pass or fail and the zooms tried. |
| VoiceOver, Canvas, oauth | PENDING — deferred by the person on 2026-09-30; revisit before the M4b exit | With block B serving, open the oauth URL above at 1440 px or wider and press `1`. Cmd+F5 (VoiceOver on). Tab from the address bar: the title bar's View radio group is one stop and reads Canvas as the selected radio button of two; Right arrow switches to Hybrid and Left back. Tab on: Outline, then one stop in `main` on the selected frame, then the Inspector. In `main`, VoiceOver reads the selected frame's name, "Final claim, Claim contradicts tests, +0:43"; `j` and `k` move to the next and previous frame and each is read; Enter expands and collapses a chapter frame. Cmd+F5 off. Record pass or fail per item with what VoiceOver said. |
| M4b product review (Canvas) | PENDING — deferred by the person on 2026-09-30; revisit before the M4b exit | With block B serving, the person reviews oauth, api-break and `?bundle=soak` in Canvas at Session, Chapter and Step levels against spec §1, §7.5 and `docs/superpowers/specs/2026-09-28-trace-viewer-mockups/canvas-1440.png`, including findings 3 to 5 above, and records the verdict and notes here. |

Block A (risk 2 at 60 Hz):

```bash
pnpm --filter jevcode-trace-viewer-dev exec vite build --config vite.spike.config.ts
pnpm --filter jevcode-desktop exec electron "$PWD/apps/trace-viewer-dev/scripts/spike-electron.cjs"
```

Block B (serve the dev host with the oauth and soak bundles):

```bash
node apps/trace-viewer-dev/scripts/smoke.mjs --views canvas
pnpm --filter jevcode-trace-viewer-dev exec vite preview --port 4179 --strictPort
```

The smoke writes `public/bundles/oauth.json`; the soak bundle must be present at `apps/trace-viewer-dev/public/bundles/soak.json` (regenerate as in the M4a exit H5 row), and `pnpm --filter jevcode-trace-viewer-dev build` must run after copying it.
