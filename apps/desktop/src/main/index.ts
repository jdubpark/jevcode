import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

import { MainToRendererChannels } from "@jevcode/contracts";
import { app, BrowserWindow } from "electron";
import { openDb } from "@jevcode/storage";
import type { JevcodeDb } from "@jevcode/storage";

import {
  openDirectoryDialog,
  registerIpcHandlers,
  sendToRenderer,
  setMainWindow,
} from "./ipc.js";
import { InstructionRouter } from "./pipeline/instruction-router.js";
import { PipelineRuntime } from "./pipeline/pipeline-runtime.js";
import { RuntimeInstructionDeliverer } from "./pipeline/runtime-instruction-deliverer.js";
import type { TerminalSink } from "./pipeline/types.js";
import { sweepStaleSessions } from "./session-recovery.js";
import { createAppState } from "./state.js";
import { TerminalManager } from "./terminal-manager.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));

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

let mainWindow: BrowserWindow | null = null;
let terminals: TerminalManager | null = null;
let db: JevcodeDb | null = null;
let runtime: PipelineRuntime | null = null;
const state = createAppState();

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: "#14161a",
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      preload: path.join(dirname, "../preload/index.cjs"),
    },
  });
  window.once("ready-to-show", () => {
    window.show();
  });
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
      setMainWindow(null);
    }
  });
  void window.loadFile(path.join(dirname, "../renderer/src/renderer/index.html"));
  return window;
}

function runSmoke(window: BrowserWindow): void {
  const timeout = setTimeout(() => {
    console.error("SMOKE_FAIL: renderer did not finish loading within 15s");
    app.exit(1);
  }, 15_000);
  window.webContents.once("did-finish-load", () => {
    clearTimeout(timeout);
    console.log("SMOKE_OK");
    app.quit();
  });
}

app.whenReady().then(() => {
  db = openDb();
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

  runtime = new PipelineRuntime({
    db,
    emit: sendToRenderer,
    terminal: terminalSink,
    log: (message) => console.log(`[pipeline] ${message}`),
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

  registerIpcHandlers({
    db,
    state,
    terminals,
    runtime,
    instructionRouter,
    requestRepoPath: () => openDirectoryDialog(mainWindow),
    log: (message) => console.log(`[ipc] ${message}`),
  });

  if (SMOKE) {
    runSmoke(mainWindow);
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
  terminals?.disposeAll();
  terminals = null;
  db?.close();
  db = null;
  runtime = null;
});
