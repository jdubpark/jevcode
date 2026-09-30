const { app, BrowserWindow, screen } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, ".spike");
const BENCH = process.env.SPIKE_BENCH ?? "60x300";
// Note: appendSwitch is ignored on this machine (DPR stays 2); pass --force-device-scale-factor=1 on the Electron command line for the DPR 1 run.
if (process.env.SPIKE_DPR) app.commandLine.appendSwitch("force-device-scale-factor", process.env.SPIKE_DPR);

const js = (win, code) => win.webContents.executeJavaScript(code, true);
const twoFrames = (win) => js(win, "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function open(win, harness) {
  await win.loadFile(path.join(ROOT, "dist-spike", "spike.html"), { query: { bench: BENCH, harness } });
  await twoFrames(win);
}

function toRect(r) {
  return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.max(1, Math.ceil(r.width)), height: Math.max(1, Math.ceil(r.height)) };
}

function diffImages(a, b) {
  const sa = a.getSize();
  const sb = b.getSize();
  const w = Math.min(sa.width, sb.width);
  const h = Math.min(sa.height, sb.height);
  const ba = a.toBitmap();
  const bb = b.toBitmap();
  let differing = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const ia = (y * sa.width + x) * 4;
      const ib = (y * sb.width + x) * 4;
      if (Math.abs(ba[ia] - bb[ib]) > 16 || Math.abs(ba[ia + 1] - bb[ib + 1]) > 16 || Math.abs(ba[ia + 2] - bb[ib + 2]) > 16) differing += 1;
    }
  }
  const fraction = w * h === 0 ? 1 : differing / (w * h);
  return { width: w, height: h, differing, fraction, pass: fraction <= 0.01 };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const consoleErrors = [];
  const win = new BrowserWindow({
    width: 1440, height: 900, show: false, backgroundColor: "#FFFFFF",
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
  });
  win.webContents.on("console-message", (_event, level, message) => { if (level >= 3) consoleErrors.push(message); });
  const csp = [];

  await open(win, "canvas");
  win.show();
  await wait(500);
  const dpr = await js(win, "window.devicePixelRatio");
  const tag = `dpr${dpr}`;

  const [w, h] = win.getContentSize();
  const x = Math.round(w / 2);
  const y = Math.round(h / 2);
  for (let i = 0; i < 40; i += 1) {
    win.webContents.sendInputEvent({ type: "mouseWheel", x, y, deltaX: 0, deltaY: i < 20 ? 4 : -4, modifiers: ["control"], canScroll: true, hasPreciseScrollingDeltas: true });
    await twoFrames(win);
  }
  for (let i = 0; i < 20; i += 1) {
    win.webContents.sendInputEvent({ type: "mouseWheel", x, y, deltaX: -6, deltaY: -6, canScroll: true, hasPreciseScrollingDeltas: true });
    await twoFrames(win);
  }
  await wait(400);
  const risk1 = await js(win, "window.__spike.risk1");

  const risk2 = [];
  for (const willChange of [false, true]) risk2.push(await js(win, `window.__spikeRun.sweep(${willChange})`));

  const risk3 = [];
  for (const k of [0.5, 1, 2]) {
    const rects = await js(win, `window.__spikeRun.settleAt(${k})`);
    const a = await win.webContents.capturePage(toRect(rects.frame));
    const b = await win.webContents.capturePage(toRect(rects.reference));
    fs.writeFileSync(path.join(OUT, `risk3-k${k}-${tag}-frame.png`), a.toPNG());
    fs.writeFileSync(path.join(OUT, `risk3-k${k}-${tag}-reference.png`), b.toPNG());
    risk3.push({ k: rects.k, ...diffImages(a, b) });
  }
  await js(win, "window.__spikeRun.hideReference()");

  const risk7 = { stroke: await js(win, "window.__spikeRun.strokeCheck()"), ...(await js(win, "window.__spikeRun.rulerSync()")) };
  const risk4 = await js(win, "window.__spikeRun.keyboardWalk(20)");
  csp.push(...(await js(win, "window.__spike.csp")));

  await open(win, "overview");
  const risk5 = await js(win, "window.__spikeRun.overviewDrift()");
  const displays = screen.getAllDisplays();
  if (displays.length > 1) {
    const current = screen.getDisplayMatching(win.getBounds());
    const other = displays.find((d) => d.id !== current.id);
    win.setBounds({ x: other.workArea.x + 40, y: other.workArea.y + 40, width: 1440, height: 900 });
    await wait(1_000);
    Object.assign(risk5, await js(win, "window.__spike.risk5"), { movedDisplays: true });
  } else {
    risk5.movedDisplays = false;
  }
  csp.push(...(await js(win, "window.__spike.csp")));

  await open(win, "switch");
  const risk6 = await js(win, "window.__spikeRun.switchCheck()");
  csp.push(...(await js(win, "window.__spike.csp")));

  const pass = {
    1: risk1.maxAnchorDriftPx <= 1 && risk1.maxVisualScale === 1 && risk1.maxScroll === 0,
    2: risk2[0].pass,
    "2 (will-change)": risk2[1].pass,
    3: risk3.every((row) => row.pass),
    4: risk4.failures === 0 && risk4.scrollResets === 0,
    5: risk5.maxDriftPx <= 1,
    6: risk6.storeEqual && risk6.maxCenterDriftPx <= 1 && risk6.hiddenRafCallbacks === 0 && risk6.zeroFits === 0,
    7: risk7.stroke.every((row) => Math.abs(row.renderedPx - 1.5) <= 0.05) && risk7.maxTickDriftPx <= 1,
    csp: csp.length === 0 && consoleErrors.length === 0,
  };
  const result = { bench: BENCH, dpr, risk1, risk2, risk3, risk4, risk5, risk6, risk7, csp, consoleErrors, pass };
  fs.writeFileSync(path.join(OUT, `results-${tag}.json`), `${JSON.stringify(result, null, 2)}\n`);
  const f = (n) => (typeof n === "number" ? Number(n.toFixed(3)) : n);
  const lines = [
    `| 1 (${tag}) | anchor drift max ${f(risk1.maxAnchorDriftPx)} px over ${risk1.events} events; visualViewport.scale max ${f(risk1.maxVisualScale)}; scroll max ${f(risk1.maxScroll)} | ${pass[1] ? "pass (automated part)" : "FAIL"} |`,
    `| 2 (${tag}) | without will-change: dropped ${f(risk2[0].droppedFraction * 100)}%, p95 ${risk2[0].p95Rounded} intervals over ${risk2[0].frames} frames; with: dropped ${f(risk2[1].droppedFraction * 100)}%, p95 ${risk2[1].p95Rounded} | ${pass[2] ? "pass" : pass["2 (will-change)"] ? "pass only with gesture-time will-change" : "FAIL"} |`,
    `| 3 (${tag}) | ${risk3.map((r) => `k ${f(r.k)}: ${f(r.fraction * 100)}% of ${r.width}x${r.height} px differ`).join("; ")} | ${pass[3] ? "pass" : "FAIL"} |`,
    `| 4 (${tag}) | ${risk4.presses} j presses, ${risk4.failures} focus/inset failures, ${risk4.scrollResets} scroll resets | ${pass[4] ? "pass (automated part)" : "FAIL"} |`,
    `| 5 (${tag}) | pin vs mark drift max ${f(risk5.maxDriftPx)} px over ${risk5.frames} frames; ${risk5.redraws} redraws, ${risk5.dprChanges} DPR changes, moved displays: ${risk5.movedDisplays} | ${pass[5] ? "pass" : "FAIL"} |`,
    `| 6 (${tag}) | ${risk6.toggles} toggles: store equal ${risk6.storeEqual}; center drift max ${f(risk6.maxCenterDriftPx)} px; hidden rAF callbacks ${risk6.hiddenRafCallbacks}; 0x0 fits ${risk6.zeroFits} | ${pass[6] ? "pass" : "FAIL"} |`,
    `| 7 (${tag}) | stroke ${risk7.stroke.map((r) => `k ${f(r.k)}: ${f(r.renderedPx)} px`).join(", ")}; ruler tick drift max ${f(risk7.maxTickDriftPx)} px | ${pass[7] ? "pass" : "FAIL"} |`,
    `| CSP (${tag}) | ${csp.length} violations, ${consoleErrors.length} console errors | ${pass.csp ? "pass" : "FAIL"} |`,
  ];
  fs.writeFileSync(path.join(OUT, `summary-${tag}.md`), `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
  console.log(`SPIKE_DONE ${tag}`);
}

app.whenReady().then(main).then(() => app.quit(), (error) => {
  console.error(error);
  app.exit(1);
});
