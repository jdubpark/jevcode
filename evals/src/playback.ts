import type {
  AttentionDecision,
  JevResult,
  UIIntent,
} from "@jevcode/contracts";
import type {
  AttentionInput,
  JevClient,
  JevHealth,
  ProjectionInput,
} from "@jevcode/jev-router";

export interface PlaybackLabels {
  attention: Readonly<Record<string, AttentionDecision>>;
  projection: Readonly<Record<string, UIIntent>>;
}

export class PlaybackClient implements JevClient {
  private readonly labels: PlaybackLabels;

  constructor(labels: PlaybackLabels) {
    this.labels = labels;
  }

  async attention(
    batch: AttentionInput[],
  ): Promise<JevResult<AttentionDecision>[]> {
    return batch.map((input) => {
      const label = this.labels.attention[input.changeUnitId];
      if (label === undefined) {
        throw new Error(`no attention label for unit "${input.changeUnitId}"`);
      }
      return {
        value: label,
        confidence: label.confidence,
        probabilities: label.probabilities,
        clientKind: "playback",
        heuristic: false,
      };
    });
  }

  async project(input: ProjectionInput): Promise<JevResult<UIIntent>> {
    const label = this.labels.projection[input.changeUnitId];
    if (label === undefined) {
      throw new Error(`no projection label for unit "${input.changeUnitId}"`);
    }
    return {
      value: label,
      confidence: label.confidence,
      clientKind: "playback",
      heuristic: false,
    };
  }

  async health(): Promise<JevHealth> {
    return "ok";
  }
}
