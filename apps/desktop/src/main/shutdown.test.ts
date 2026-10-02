import { describe, expect, it } from "vitest";

import { runShutdown } from "./shutdown.js";

describe("runShutdown (will-quit)", () => {
  it("runs every step in order and logs a step that throws or rejects", async () => {
    const ran: string[] = [];
    const logs: string[] = [];
    runShutdown(
      [
        {
          name: "explainer",
          run: () => {
            ran.push("explainer");
            throw new Error("seam stuck");
          },
        },
        {
          name: "import extractor",
          run: async () => {
            ran.push("import extractor");
            throw new Error("worker gone");
          },
        },
        { name: "terminals", run: () => void ran.push("terminals") },
        { name: "database", run: () => void ran.push("database") },
      ],
      (message) => logs.push(message),
    );
    expect(ran).toEqual(["explainer", "import extractor", "terminals", "database"]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(logs).toEqual(["explainer failed to stop: seam stuck", "import extractor failed to stop: worker gone"]);
  });
});
