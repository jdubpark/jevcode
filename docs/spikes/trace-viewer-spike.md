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
| `j` to painted, 300 presses at Chapter level (`?perfrun=1`) | p95 ≤ 16.7 ms | p95 318.7 ms, median 114.7 ms, n 300 (measured inside a rAF callback) | p95 18.8 / 18.9 ms, median 8.8 / 8.2 ms, n 300 (two runs); zero-work baseline p95 10.6 / 11.0 ms, median 2.9 / 3.7 ms | no (by 2 ms; see below) |
| Overview layout + paint, Session-level sweep | p95 ≤ 4 ms | p95 8.0 ms, median 5.5 ms, n 510 | p95 0.5 ms, median 0.2 ms, n 512 (both runs) | yes |
| Overlay nodes during the sweep | ≤ 150 | 10 | 7 / 9 | yes |
| Anchor drift (`?selftest=drip`, oauth) | ≤ 1 px | 0 px (`SMOKE_OK`, rows 74) | 0 px (`SMOKE_OK`, rows 76) | yes |

The second column was taken after the four fix branches (M, A1, A2, B) and the integration commits were merged into `tv/c2-shell-hybrid`, on the same machine, in headless Chrome driven over CDP (`--headless=new`, real time, DPR 1, 1440 × 900), with a 1-minute load average of 6 to 8. First-paint and full-load values are the `tv:first-paint` and `tv:full-load` measures, which start at `tv:bundle-parsed` (about 1.15 s after navigation for the 208 MiB file).

What changed since the first measurement:

- First paint is now progressive. The data controller yields to the browser between pages (A2), so the viewer paints the first page instead of painting once after the last one. The fold got cheaper too (M part 2): a conservative exact guard skips zod for `change_unit` rows that zod would accept unchanged (fold 791 → 236 ms in Node), and a quadratic pass over shared validations that M part 1 had introduced in `buildChapters` (finalize 14.1 s in Node) is linear again (253 ms). A soak-shaped timing test (`model/fold.soak-shape.test.ts`) now guards that shape.
- `j` to painted: A1 moved the harness to real input (keydown `timeStamp` to the next frame's paint, pressed from a macrotask at a random frame phase, per the orchestrator ruling), which removes the full frame the old rAF-dispatched presses added by construction, and it records a zero-work baseline (an unbound key). A1 also made each `j` do one spine reveal with no forced layout; M cut Chapter-level `buildSpineRows` on soak from 115 ms to 3 ms (noise labels once per run) and Session level from 88 ms to 2 ms. The viewer's own share (median `j` minus median baseline) is about 5 ms. The p95 misses the 16.7 ms budget by about 2 ms while the baseline p95 alone is 11 ms on this loaded machine, so the miss is not yet attributable to the viewer; H5 on a quiet desktop decides it.
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
