export type NarratorFailureReason =
  | "timeout"
  | "rate_limited"
  | "offline"
  | "auth"
  | "unavailable"
  | "aborted";

/** Thrown for every call that did not produce an answer; callers back off on it (spec §6.6). */
export class NarratorUnavailableError extends Error {
  readonly reason: NarratorFailureReason;

  constructor(reason: NarratorFailureReason, message: string) {
    super(message);
    this.name = "NarratorUnavailableError";
    this.reason = reason;
  }
}

export function toNarratorError(error: unknown): NarratorUnavailableError {
  if (error instanceof NarratorUnavailableError) return error;
  return new NarratorUnavailableError("unavailable", error instanceof Error ? error.message : String(error));
}
