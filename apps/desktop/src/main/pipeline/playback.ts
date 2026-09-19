import { readFileSync } from "node:fs";
import path from "node:path";

import {
  AttentionDecisionSchema,
  UIIntentSchema,
  type AttentionDecision,
  type JevResult,
  type UIIntent,
} from "@jevcode/contracts";
import { DegradeClient } from "@jevcode/jev-router";
import type {
  AttentionInput,
  JevClient,
  JevHealth,
  ProjectionInput,
} from "@jevcode/jev-router";

export interface PlaybackFixtureLabels {
  attention: Readonly<Record<string, AttentionDecision>>;
  projection: Readonly<Record<string, UIIntent>>;
}

export interface ExpectedUnit {
  id: string;
  files: string[];
  symbolNames: string[];
}

function parseLabelMap<T>(
  raw: unknown,
  schema: { safeParse(input: unknown): { success: boolean; data?: T; error?: { message: string } } },
  label: string,
): Record<string, T> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${label} must be a JSON object keyed by unit slug`);
  }
  const out: Record<string, T> = {};
  for (const [slug, value] of Object.entries(raw)) {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new Error(`invalid ${label} entry "${slug}": ${result.error?.message}`);
    }
    out[slug] = result.data as T;
  }
  return out;
}

export interface LoadedPlaybackFixture {
  labels: PlaybackFixtureLabels;
  expectedUnits: ExpectedUnit[];
}

export function loadPlaybackFixture(fixtureDir: string): LoadedPlaybackFixture {
  const rawUnits: unknown = JSON.parse(
    readFileSync(path.join(fixtureDir, "expected_units.json"), "utf8"),
  );
  if (!Array.isArray(rawUnits)) {
    throw new Error("expected_units.json must be an array");
  }
  const expectedUnits: ExpectedUnit[] = rawUnits.map((item, index) => {
    const record = item as Record<string, unknown>;
    const id = record["id"];
    const files = record["files"];
    const symbolNames = record["symbolNames"];
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`expected unit ${index}: missing id`);
    }
    if (!Array.isArray(files) || !Array.isArray(symbolNames)) {
      throw new Error(`expected unit ${index} (${String(id)}): bad file/symbol lists`);
    }
    return {
      id,
      files: files.filter((f): f is string => typeof f === "string"),
      symbolNames: symbolNames.filter((s): s is string => typeof s === "string"),
    };
  });

  const attentionLabels = parseLabelMap(
    JSON.parse(readFileSync(path.join(fixtureDir, "labels", "attention.json"), "utf8")),
    AttentionDecisionSchema,
    "attention label",
  );
  const projectionLabels = parseLabelMap(
    JSON.parse(readFileSync(path.join(fixtureDir, "labels", "projection.json"), "utf8")),
    UIIntentSchema,
    "projection label",
  );

  return { labels: { attention: attentionLabels, projection: projectionLabels }, expectedUnits };
}

function sameFileSet(a: readonly string[], b: readonly string[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const file of setA) {
    if (!setB.has(file)) return false;
  }
  return true;
}

export class PlaybackLabels {
  readonly matchedSlugs = new Set<string>();

  private readonly bySlug = new Map<string, ExpectedUnit>();

  constructor(
    private readonly labels: PlaybackFixtureLabels,
    expectedUnits: readonly ExpectedUnit[],
  ) {
    for (const unit of expectedUnits) {
      this.bySlug.set(unit.id, unit);
    }
  }

  match(files: readonly string[], symbols: readonly string[]): string | undefined {
    for (const unit of this.bySlug.values()) {
      if (sameFileSet(unit.files, files)) {
        this.matchedSlugs.add(unit.id);
        return unit.id;
      }
    }
    let best: string | undefined;
    let bestScore = 0;
    for (const unit of this.bySlug.values()) {
      if (unit.files.length === 0 || files.length === 0) continue;
      const overlap = unit.files.filter((file) => files.includes(file)).length;
      if (overlap === 0) continue;
      const score = (overlap * overlap) / (unit.files.length * files.length);
      if (score >= 0.5 && score > bestScore) {
        best = unit.id;
        bestScore = score;
      }
    }
    if (best !== undefined && symbols.length === 0 && bestScore < 1) {
      const symbolless = this.bySlug.get(best);
      if (symbolless !== undefined && symbolless.symbolNames.length > 0) {
        best = undefined;
      }
    }
    if (best !== undefined) {
      this.matchedSlugs.add(best);
    }
    return best;
  }

  attentionFor(slug: string): AttentionDecision | undefined {
    return this.labels.attention[slug];
  }

  projectionFor(slug: string): UIIntent | undefined {
    return this.labels.projection[slug];
  }
}

export class PlaybackClient implements JevClient {
  private readonly fallback: JevClient;

  constructor(
    private readonly labels: PlaybackLabels,
    fallback?: JevClient,
  ) {
    this.fallback = fallback ?? new DegradeClient();
  }

  async attention(
    batch: AttentionInput[],
  ): Promise<JevResult<AttentionDecision>[]> {
    const results: JevResult<AttentionDecision>[] = [];
    for (const input of batch) {
      const slug = this.labels.match(input.files, input.symbols);
      const label = slug !== undefined ? this.labels.attentionFor(slug) : undefined;
      if (label === undefined) {
        const degraded = await this.fallback.attention([input]);
        results.push(...degraded);
      } else {
        results.push({
          value: label,
          confidence: label.confidence,
          probabilities: label.probabilities,
          clientKind: "playback",
          heuristic: false,
        });
      }
    }
    return results;
  }

  async project(input: ProjectionInput): Promise<JevResult<UIIntent>> {
    const slug = this.labels.match(input.files, input.symbols);
    const label = slug !== undefined ? this.labels.projectionFor(slug) : undefined;
    if (label === undefined) {
      return this.fallback.project(input);
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
