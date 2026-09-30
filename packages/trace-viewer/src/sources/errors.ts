export type TraceChannel = "trace:listSessions" | "trace:rows" | "trace:payloads" | "bundle";
export type TraceSourceErrorCode = "UNKNOWN_SESSION" | "NOT_A_TRACE" | "UNSUPPORTED_VERSION" | "SOURCE_FAILED";

export class TraceSourceError extends Error {
  readonly channel: TraceChannel;
  readonly code: TraceSourceErrorCode;

  constructor(channel: TraceChannel, code: TraceSourceErrorCode, message: string) {
    super(message);
    this.name = "TraceSourceError";
    this.channel = channel;
    this.code = code;
  }
}
