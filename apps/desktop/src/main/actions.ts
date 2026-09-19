import { IpcError } from "../shared/errors.js";

export const ACTION_ALLOWLIST = [
  "answer_decision",
  "delegate_decision",
  "restore_previous_api_semantics",
  "inspect_call_sites",
  "show_exact_diff",
  "accept_changes",
  "request_changes",
  "continue_task",
  "open_terminal",
  "interrupt_agent",
  "pin_surface",
  "dismiss_surface",
] as const;

export type AllowedAction = (typeof ACTION_ALLOWLIST)[number];

export function isAllowedAction(name: string): name is AllowedAction {
  return (ACTION_ALLOWLIST as readonly string[]).includes(name);
}

export function validateAction(name: string): AllowedAction {
  if (!isAllowedAction(name)) {
    throw new IpcError("UNKNOWN_ACTION", `action not allowlisted: ${name}`);
  }
  return name;
}
