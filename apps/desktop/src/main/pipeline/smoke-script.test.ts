import { NormalizedAgentEventSchema } from "@jevcode/contracts";
import { describe, expect, it } from "vitest";

import { SMOKE_SCRIPT_DEFAULTS, smokeMockScript } from "./smoke-script.js";

const INPUT = { sessionId: "sess_smoke", repoId: "repo_1", repoPath: "/tmp/repo", prompt: "Smoke" };

describe("smokeMockScript", () => {
  it("emits four schema-valid events per step, spaced evenly, then completes", () => {
    const script = smokeMockScript(INPUT, { steps: 3, spacingMs: 150 });
    expect(script.entries).toHaveLength(3 * 4 + 1);
    for (const entry of script.entries) {
      expect(entry.kind).toBe("agent");
      expect(entry.delayMs).toBe(150);
      if (entry.kind === "agent") {
        expect(NormalizedAgentEventSchema.safeParse(entry.event).success).toBe(true);
        expect(entry.event.sessionId).toBe("sess_smoke");
      }
    }
    const last = script.entries.at(-1);
    expect(last?.kind === "agent" ? last.event.type : null).toBe("agent_completed");
    expect(script.prompt).toBe("Smoke");
  });

  it("defaults to a short run for screenshots", () => {
    expect(SMOKE_SCRIPT_DEFAULTS).toEqual({ steps: 6, spacingMs: 150 });
    expect(smokeMockScript(INPUT).entries).toHaveLength(6 * 4 + 1);
  });
});
