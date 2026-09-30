import { describe, expect, it } from "vitest";

import { traceOpenErrorMessage } from "./trace-open-error.js";

describe("traceOpenErrorMessage", () => {
  it("names the failure and includes an Error's message", () => {
    expect(traceOpenErrorMessage(new Error("no session with id s1"))).toBe(
      "Could not open the trace: no session with id s1",
    );
  });

  it("stringifies a non-Error rejection", () => {
    expect(traceOpenErrorMessage("boom")).toBe("Could not open the trace: boom");
  });
});
