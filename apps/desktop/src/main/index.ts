import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

import { MainToRendererChannels } from "@jevcode/contracts";
import { app, BrowserWindow } from "electron";
import { scanPaths, scanRepo } from "@jevcode/codebase-map/node";
import { createImportExtractor, type ImportExtractor } from "@jevcode/evidence-engine";
import { openDb, openTraceReader } from "@jevcode/storage";
import type { JevcodeDb, TraceReader } from "@jevcode/storage";

import {
  openDirectoryDialog,
  registerIpcHandlers,
  sendToRenderer,
  setMainWindow,
} from "./ipc.js";
import { EXPLAIN_WITH_MODEL_PREF_KEY, normalizeExplainWithModel } from "../shared/prefs.js";
import { createExplainerRegistry, createExplainerStage, type ExplainerRegistry } from "./pipeline/explainer-stage.js";
import { InstructionRouter } from "./pipeline/instruction-router.js";
import { PipelineRuntime } from "./pipeline/pipeline-runtime.js";
import { RuntimeInstructionDeliverer } from "./pipeline/runtime-instruction-deliverer.js";
import type { TerminalSink } from "./pipeline/types.js";
import { sweepStaleSessions } from "./session-recovery.js";
import { runShutdown } from "./shutdown.js";
import { createAppState } from "./state.js";
import { connectNarratorSwitch, createNarrationSeamFactory } from "./pipeline/explainer-narration-seam.js";
import { createNarratorCallLog } from "./pipeline/narrator-call-log.js";
import { createNarratorSwitch } from "./pipeline/narrator-switch.js";
import { readAgentPreferences } from "../shared/prefs.js";
import type { NarratorCallRecord } from "../shared/narrator-log.js";
import { TerminalManager } from "./terminal-manager.js";
import { createTraceService } from "./trace-service.js";
import { forwardTracePerf, runSmoke } from "./smoke.js";
import { createTraceWindowRegistry, sharedWebPreferences } from "./trace-window.js";
import type { TraceWindowRegistry } from "./trace-window.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD_PATH = path.join(dirname, "../preload/index.cjs");
const TRACE_HTML_PATH = path.join(dirname, "../renderer/src/renderer/trace.html");

function loadEnvFileFromRepo(): void {
  for (const candidate of [
    path.resolve(".env"),
    path.resolve("..", ".env"),
    path.resolve("..", "..", ".env"),
    path.resolve("..", "..", "..", ".env"),
  ]) {
    try {
      if (existsSync(candidate)) {
        loadEnvFile(candidate);
        return;
      }
    } catch {
      // env loading is best-effort
    }
  }
}
loadEnvFileFromRepo();

const SMOKE = process.env["JEVCODE_SMOKE"] === "1";
/** Prints trace windows' TRACE_PERF lines (docs/perf.md live-tick samples). */
const TRACE_PERF = process.env["JEVCODE_TRACE_PERF"] === "1";

let mainWindow: BrowserWindow | null = null;
let terminals: TerminalManager | null = null;
let db: JevcodeDb | null = null;
let traceReader: TraceReader | null = null;
let traceWindows: TraceWindowRegistry | null = null;
let runtime: PipelineRuntime | null = null;
let explainer: ExplainerRegistry | null = null;
let importExtractor: ImportExtractor | null = null;
const state = createAppState();

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: "#14161a",
    show: false,
    webPreferences: sharedWebPreferences(PRELOAD_PATH),
  });
  window.once("ready-to-show", () => {
    window.show();
  });
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
      setMainWindow(null);
      // A trace window never outlives the main window (spec §8.1).
      traceWindows?.closeAll();
    }
  });
  void window.loadFile(path.join(dirname, "../renderer/src/renderer/index.html"));
  return window;
}

app.whenReady().then(() => {
  db = openDb();
  const openedDb = db;
  const narratorSwitch = createNarratorSwitch({
    enabled: readAgentPreferences((key) => openedDb.getPreference(key)).explainWithModel,
    env: process.env,
  });
  const narratorCalls = createNarratorCallLog();
  // A second, query_only connection for the trace viewer (R5): trace:*
  // handlers read through it and can never write.
  const reader = openTraceReader(db.dbPath);
  traceReader = reader;
  const rebuild = db.rebuildOnBoot({ sinceDays: 30 });
  console.log(
    `rebuildOnBoot: ${rebuild.length} session(s), ${rebuild.reduce((sum, entry) => sum + entry.replayed, 0)} events`,
  );

  // Crash recovery: any session left running/paused by a dead process is
  // either failed now or kept only while its execution claim is fresh.
  const swept = sweepStaleSessions(db, new Date());
  if (swept.length > 0) {
    console.log(
      `crash recovery: ${swept.length} stale session(s) marked failed: ${swept
        .map((entry) => `${entry.sessionId} (${entry.fromState}, ${entry.reason})`)
        .join(", ")}`,
    );
  }

  terminals = new TerminalManager((sessionId, data) => {
    sendToRenderer(MainToRendererChannels.terminalData, { sessionId, data });
  });

  const terminalSink: TerminalSink = {
    data: (sessionId, data) => {
      sendToRenderer(MainToRendererChannels.terminalData, { sessionId, data });
      terminals?.scrollback(sessionId).push(data);
    },
    ensure: (sessionId, cwd) => {
      terminals?.ensure(sessionId, { cwd });
    },
  };

  // Console-explainer spec §6: one explainer stage for the open repo. Import extraction runs in
  // its own worker pool, which stops after 30 s idle, so scans never queue behind evidence parses.
  const eventsDb = db;
  const extractor = createImportExtractor();
  importExtractor = extractor;
  const explainerRegistry = createExplainerRegistry((repoRoot) => {
    // Lane 05 (R4): the narration seam starts from the switch's current client; the subscription
    // below forwards every later change to the open repo's stage.
    const narratorOptions = {
      initialNarrator: narratorSwitch.current(),
      narratorAvailability: () => narratorSwitch.availability(),
      recordNarratorCall: (record: NarratorCallRecord) => narratorCalls.record(record),
    };
    return createExplainerStage({
      db: eventsDb,
      repoRoot,
      sessionId: () => (state.repo?.gitRoot === repoRoot ? (state.session?.id ?? null) : null),
      scan: scanRepo,
      scanPaths,
      extract: extractor.extract,
      // Lane 03 D-6 Step 1 replaces this direct send with a no-op: D-1's observeTraceAppends already
      // hints every committed trace row through the coalesced emitter, which also reaches trace windows.
      emitRowsAvailable: (sessionId, lastSeq) =>
        sendToRenderer(MainToRendererChannels.traceRowsAvailable, { sessionId, lastSeq }),
      now: () => Date.now(),
      schedule: {
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      log: (event) => console.log(`[explainer] ${JSON.stringify(event)}`),
      // Ruling R3: narrator status "off" when the setting is off; otherwise the seam's state.
      explainWithModel: () => normalizeExplainWithModel(eventsDb.getPreference(EXPLAIN_WITH_MODEL_PREF_KEY)),
      narration: createNarrationSeamFactory(narratorOptions),
      initialNarrator: narratorOptions.initialNarrator,
      recordNarratorCall: narratorOptions.recordNarratorCall,
    });
  }, (message) => console.error(`[explainer] ${message}`));
  explainer = explainerRegistry;
  connectNarratorSwitch(narratorSwitch, explainerRegistry, () => state.repo?.gitRoot);

  runtime = new PipelineRuntime({
    db,
    emit: sendToRenderer,
    terminal: terminalSink,
    log: (message) => console.log(`[pipeline] ${message}`),
    onRepoFilesChanged: (repoPath, paths) => explainerRegistry.filesChanged(repoPath, paths),
  });

  const instructionRouter = new InstructionRouter({
    db,
    deliverer: new RuntimeInstructionDeliverer(runtime, (message) =>
      console.log(`[instructions] ${message}`),
    ),
    emit: sendToRenderer,
    log: (message) => console.log(`[instructions] ${message}`),
  });

  // Boot-time inbox reconciliation: pending instructions for sessions that
  // survived the sweep are durable; re-offer them and push their state.
  const keptStates = ["running", "paused", "waiting_decision"] as const;
  for (const session of db.listSessionsByStates([...keptStates])) {
    void instructionRouter.reloadPending(session.id);
  }

  mainWindow = createWindow();
  setMainWindow(mainWindow);

  const traceService = createTraceService(reader);
  const windows = createTraceWindowRegistry({
    create: (options) => {
      const window = new BrowserWindow(options);
      if (TRACE_PERF) forwardTracePerf(window, (line) => console.log(line));
      return window;
    },
    preloadPath: PRELOAD_PATH,
    traceHtmlPath: TRACE_HTML_PATH,
  });
  traceWindows = windows;

  registerIpcHandlers({
    db,
    state,
    terminals,
    runtime,
    instructionRouter,
    trace: traceService,
    senderKind: (webContentsId) => {
      const main = mainWindow;
      if (main !== null && !main.isDestroyed() && main.webContents.id === webContentsId) {
        return "main";
      }
      return windows.isTraceSender(webContentsId) ? "trace" : "other";
    },
    traceWindows: {
      windows,
      sessionExists: (sessionId) => traceService.listSessions({ sessionId, limit: 1 }).length > 0,
      focusMainWindow: () => {
        const main = mainWindow;
        if (main === null || main.isDestroyed()) return;
        if (main.isMinimized()) main.restore();
        main.show();
        main.focus();
      },
      sendToRenderer,
    },
    narrator: narratorSwitch,
    narratorCalls,
    requestRepoPath: () => openDirectoryDialog(mainWindow),
    explainer: explainerRegistry,
    log: (message) => console.log(`[ipc] ${message}`),
  });

  if (SMOKE) {
    runSmoke({
      mainWindow,
      env: process.env,
      newestSessionId: () => traceService.listSessions({ limit: 1 })[0]?.sessionId ?? null,
      openTraceWindow: (sessionId) => windows.openTraceWindow(sessionId),
      now: () => performance.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      log: (line) => console.log(line),
      error: (line) => console.error(line),
      succeed: () => app.quit(),
      fail: () => app.exit(1),
    });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
      setMainWindow(mainWindow);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || SMOKE) {
    app.quit();
  }
});

app.on("will-quit", () => {
  const stopping = { explainer, importExtractor, terminals, traceReader, db };
  explainer = null;
  importExtractor = null;
  terminals = null;
  traceReader = null;
  db = null;
  runtime = null;
  // The stage writes rows and overview_state, so it stops before the database closes. A step
  // that throws is logged and the rest still run.
  runShutdown(
    [
      { name: "explainer", run: () => stopping.explainer?.dispose() },
      { name: "import extractor", run: () => stopping.importExtractor?.dispose() },
      { name: "terminals", run: () => stopping.terminals?.disposeAll() },
      { name: "trace reader", run: () => stopping.traceReader?.close() },
      { name: "database", run: () => stopping.db?.close() },
    ],
    (message) => console.error(`[quit] ${message}`),
  );
});
