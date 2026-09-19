import { describe, expect, it } from "vitest";

import { IpcError } from "../shared/errors.js";
import { isAllowedAction, validateAction } from "./actions.js";

describe("action allowlist", () => {
  it("accepts every catalog action from SPEC section 9.2", () => {
    const catalog = [
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
    ];
    for (const action of catalog) {
      expect(isAllowedAction(action)).toBe(true);
      expect(validateAction(action)).toBe(action);
    }
  });

  it("rejects unknown actions with a typed error", () => {
    expect(isAllowedAction("run_shell")).toBe(false);
    expect(() => validateAction("run_shell")).toThrowError(IpcError);
    try {
      validateAction("exec_command");
    } catch (error) {
      expect(error).toMatchObject({ code: "UNKNOWN_ACTION" });
    }
  });
});
