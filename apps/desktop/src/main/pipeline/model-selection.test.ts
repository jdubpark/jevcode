import { DegradeClient } from "@jevcode/jev-router";
import type { JevClient } from "@jevcode/jev-router";
import { describe, expect, it, vi } from "vitest";

import { createModelSelector } from "./model-selection.js";
import type { ModelSelectionRequest } from "./model-selection.js";

const REQUEST: ModelSelectionRequest = {
  prompt: "rename the config loader",
  repoContext: { fileCount: 12, totalBytes: 40_000, languages: ["typescript"] },
};

/** A Jev client whose complexity scores are fixed, so the selection shows which client scored it. */
function scoringClient(score: number): JevClient {
  const offline = new DegradeClient();
  return {
    attention: (batch) => offline.attention(batch),
    project: (input) => offline.project(input),
    health: async () => "ok",
    scoreModelComplexity: async () => ({ value: { prompt: score, topic: score, work: score }, confidence: 0.9, clientKind: "typesafe" }),
  };
}

describe("createModelSelector", () => {
  it("scores every request with a client built for it, so a key or client change reaches the next session", async () => {
    const clients = [scoringClient(0.2), scoringClient(0.7)];
    const createClient = vi.fn(() => clients.shift()!);
    const select = createModelSelector(createClient);

    const first = await select(REQUEST);
    const second = await select(REQUEST);

    expect(createClient).toHaveBeenCalledTimes(2);
    expect(first.complexity).toEqual({ prompt: 0.2, topic: 0.2, work: 0.2 });
    expect(second.complexity).toEqual({ prompt: 0.7, topic: 0.7, work: 0.7 });
    expect(second.confidence).toBe(0.9);
  });
});
