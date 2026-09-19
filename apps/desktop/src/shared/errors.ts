export type IpcErrorCode =
  | "UNKNOWN_CHANNEL"
  | "INVALID_PAYLOAD"
  | "NOT_IMPLEMENTED"
  | "UNTRUSTED_SENDER"
  | "NO_ACTIVE_SESSION"
  | "NOT_A_GIT_REPO"
  | "UNKNOWN_ACTION"
  | "INVALID_ACTION_PARAMS"
  | "UNKNOWN_DECISION"
  | "NO_AGENT_AVAILABLE"
  | "SESSION_NOT_RUNNING"
  | "UNKNOWN_SESSION";

export class IpcError extends Error {
  readonly code: IpcErrorCode;

  constructor(code: IpcErrorCode, message: string) {
    super(message);
    this.name = "IpcError";
    this.code = code;
  }
}
