/** The visible message when the trace window fails to open. */
export function traceOpenErrorMessage(error: unknown): string {
  return `Could not open the trace: ${error instanceof Error ? error.message : String(error)}`;
}
