import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { SemanticEventKind, UIIntent } from "@jevcode/contracts";
import {
  REPRESENTATIONS,
  SEMANTIC_KINDS,
} from "@jevcode/jev-router";

export type AlternativesConfig = Readonly<Record<string, readonly string[]>>;

const DEFAULT_CONFIG_URL = new URL("../config/alternatives.json", import.meta.url);

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("alternatives config must be a JSON object");
  }
}

export function loadAlternatives(configUrl: URL = DEFAULT_CONFIG_URL): AlternativesConfig {
  const text = readFileSync(fileURLToPath(configUrl), "utf8");
  const raw: unknown = JSON.parse(text);
  assertRecord(raw);
  const config: Record<string, readonly string[]> = {};
  for (const [category, values] of Object.entries(raw)) {
    if (!SEMANTIC_KINDS.includes(category as SemanticEventKind)) {
      throw new Error(
        `alternatives config: unknown semantic category "${category}"`,
      );
    }
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error(
        `alternatives config: "${category}" must be a non-empty array`,
      );
    }
    const seen = new Set<string>();
    for (const value of values) {
      if (typeof value !== "string") {
        throw new Error(
          `alternatives config: "${category}" entries must be strings`,
        );
      }
      if (!REPRESENTATIONS.includes(value as UIIntent["representation"])) {
        throw new Error(
          `alternatives config: "${value}" is not a valid representation`,
        );
      }
      if (seen.has(value)) {
        throw new Error(
          `alternatives config: duplicate alternative "${value}" for "${category}"`,
        );
      }
      seen.add(value);
    }
    config[category] = [...values];
  }
  return config;
}

export function acceptableRepresentations(
  config: AlternativesConfig,
  category: SemanticEventKind,
  canonical: UIIntent["representation"],
): Set<string> {
  const acceptable = new Set<string>([canonical]);
  for (const alternative of config[category] ?? []) {
    acceptable.add(alternative);
  }
  return acceptable;
}
