import { describe, expect, it } from "vitest";

import { toMainChannelNames } from "../shared/ipc-registry.js";
import { TRACE_WINDOW_CHANNELS, isChannelAllowed } from "./trace-allowlist.js";

// Spec §8.6, written out independently of the implementation.
const TRACE_READS = ["trace:listSessions", "trace:payloads", "trace:rows"];
const TRACE_WINDOW_ONLY = "trace:requestChanges";

describe("trace window channel allowlist", () => {
  it("a trace window reaches only the three reads and trace:requestChanges", () => {
    expect([...TRACE_WINDOW_CHANNELS].sort()).toEqual([...TRACE_READS, TRACE_WINDOW_ONLY].sort());
    const names = toMainChannelNames();
    for (const required of ["telemetry:flush", "agent:sendInstruction", "session:switch", "trace:open"]) {
      expect(names).toContain(required);
    }
    for (const channel of names) {
      const expected = TRACE_READS.includes(channel) || channel === TRACE_WINDOW_ONLY;
      expect(isChannelAllowed(channel, "trace"), channel).toBe(expected);
    }
  });

  it("the main window cannot hand a note to itself", () => {
    for (const channel of toMainChannelNames()) {
      expect(isChannelAllowed(channel, "main"), channel).toBe(channel !== TRACE_WINDOW_ONLY);
    }
  });

  it("an unrecognized sender reaches nothing", () => {
    for (const channel of toMainChannelNames()) {
      expect(isChannelAllowed(channel, "other"), channel).toBe(false);
    }
  });

  it("a channel name outside the registry is refused for a trace window", () => {
    expect(isChannelAllowed("trace:export", "trace")).toBe(false);
    expect(isChannelAllowed("", "trace")).toBe(false);
  });
});
