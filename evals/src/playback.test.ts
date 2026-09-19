import { describe, expect, it } from "vitest";

import type { AttentionDecision, UIIntent } from "@jevcode/contracts";
import type { AttentionInput } from "@jevcode/jev-router";
import { PlaybackClient } from "./playback.js";

const attentionLabel: AttentionDecision = {
  shouldSurface: true,
  importance: 0.9,
  relevance: 0.8,
  interruption: 0.1,
  mentalModelChange: 0.6,
  semanticCategory: "implementation_change",
  scope: "module",
  humanDecision: "none",
  needsSystem2: false,
  confidence: 0.94,
  probabilities: { implementation_change: 0.9 },
};

const projectionLabel: UIIntent = {
  attention: "surface",
  subject: "code",
  representation: "summary",
  density: "normal",
  confidence: 0.94,
  showEvidence: true,
  showCode: false,
  secondaryViews: ["ChangeOverview"],
  renderMode: "autonomous",
};

function input(): AttentionInput {
  return {
    changeUnitId: "unit-1",
    decisionVersion: 1,
    sessionId: "sess-1",
    title: "t",
    status: "detected",
    files: ["src/app.ts"],
    symbols: [],
    taskPrompt: "",
    hints: {
      diffStats: { added: 0, removed: 0 },
      formattingOnly: false,
      lockfileOnly: false,
      configOnly: false,
      destructiveCommands: [],
      securityPaths: [],
      schemaPaths: [],
      publicExports: [],
      behaviorChange: false,
      interfacesChanged: 0,
      dependencyChanges: [],
      testResults: [],
      decisionIds: [],
      autoCollapsePassingTests: false,
    },
    createdAt: "2026-09-19T00:00:00.000Z",
  };
}

describe("PlaybackClient", () => {
  it("returns the labeled attention verbatim", async () => {
    const client = new PlaybackClient({
      attention: { "unit-1": attentionLabel },
      projection: {},
    });
    const [result] = await client.attention([input()]);
    expect(result?.value).toEqual(attentionLabel);
    expect(result?.confidence).toBe(attentionLabel.confidence);
    expect(result?.clientKind).toBe("playback");
  });

  it("returns the labeled projection verbatim", async () => {
    const client = new PlaybackClient({
      attention: { "unit-1": attentionLabel },
      projection: { "unit-1": projectionLabel },
    });
    const result = await client.project({ ...input(), attention: attentionLabel });
    expect(result.value).toEqual(projectionLabel);
  });

  it("throws when a unit has no label", async () => {
    const client = new PlaybackClient({ attention: {}, projection: {} });
    await expect(client.attention([input()])).rejects.toThrow(
      /no attention label/,
    );
    await expect(
      client.project({ ...input(), attention: attentionLabel }),
    ).rejects.toThrow(/no projection label/);
  });

  it("reports ok health", async () => {
    const client = new PlaybackClient({ attention: {}, projection: {} });
    await expect(client.health()).resolves.toBe("ok");
  });
});
