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
