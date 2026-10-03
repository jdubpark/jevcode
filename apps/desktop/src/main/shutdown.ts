/** One named step of the app's will-quit sequence. `run` may return a promise; it is not awaited. */
export interface ShutdownStep {
  name: string;
  run(): unknown;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs every step in order. A step that throws, or whose promise rejects, is logged and the
 * sequence goes on, so one failing service never keeps the terminals or the database open.
 */
export function runShutdown(steps: readonly ShutdownStep[], log: (message: string) => void): void {
  for (const step of steps) {
    try {
      const result = step.run();
      if (result instanceof Promise) {
        result.catch((error: unknown) => log(`${step.name} failed to stop: ${messageOf(error)}`));
      }
    } catch (error) {
      log(`${step.name} failed to stop: ${messageOf(error)}`);
    }
  }
}

/** The services will-quit stops; null when the app never started one. */
export interface QuitServices {
  runtime: { shutdown(): void } | null;
  rowsAvailable: { dispose(): unknown } | null;
  explainer: { dispose(): unknown } | null;
  importExtractor: { dispose(): unknown } | null;
  terminals: { disposeAll(): unknown } | null;
  traceReader: { close(): unknown } | null;
  db: { close(): unknown } | null;
}

/**
 * index.ts's will-quit sequence. The pipeline's sessions stop first: a pass parked at a slicer yield would otherwise
 * wake against the closed database (lane 07 PL-3 review). The stage writes rows and overview_state, so it stops
 * before the database closes too. runShutdown runs every step even when one throws, so the database always closes.
 */
export function quitSteps(services: QuitServices): ShutdownStep[] {
  return [
    { name: "pipeline sessions", run: () => services.runtime?.shutdown() },
    { name: "rows available", run: () => services.rowsAvailable?.dispose() },
    { name: "explainer", run: () => services.explainer?.dispose() },
    { name: "import extractor", run: () => services.importExtractor?.dispose() },
    { name: "terminals", run: () => services.terminals?.disposeAll() },
    { name: "trace reader", run: () => services.traceReader?.close() },
    { name: "database", run: () => services.db?.close() },
  ];
}
