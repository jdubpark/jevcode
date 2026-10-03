import { describe, expect, it } from "vitest";

import { quitSteps, runShutdown } from "./shutdown.js";

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

  it("stops the pipeline's sessions first and closes the database last, even when stopping them throws (PL-3 review)", () => {
    const ran: string[] = [];
    const logs: string[] = [];
    const service = (name: string) => ({
      dispose: () => void ran.push(name),
      disposeAll: () => void ran.push(name),
      close: () => void ran.push(name),
    });
    runShutdown(
      quitSteps({
        runtime: {
          shutdown: () => {
            ran.push("pipeline sessions");
            throw new Error("adapter gone");
          },
        },
        rowsAvailable: service("rows available"),
        explainer: service("explainer"),
        importExtractor: service("import extractor"),
        terminals: service("terminals"),
        traceReader: service("trace reader"),
        db: service("database"),
      }),
      (message) => logs.push(message),
    );
    expect(ran).toEqual(["pipeline sessions", "rows available", "explainer", "import extractor", "terminals", "trace reader", "database"]);
    expect(logs).toEqual(["pipeline sessions failed to stop: adapter gone"]);
  });
});
