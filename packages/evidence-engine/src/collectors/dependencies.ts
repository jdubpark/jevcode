import type { EvidenceFact } from "@jevcode/contracts";

import { isKnownLockfileName } from "../hunks.js";
import {
  resolveCollectorConfig,
  sinkFacts,
  type CollectorContext,
  type CollectorOptions,
  type FactSink,
} from "../sink.js";

export interface DepEntry {
  name: string;
  version: string;
}

export interface ManifestDiff {
  added: DepEntry[];
  removed: DepEntry[];
}

interface ManifestShape {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export function parseManifest(text: string | null): ManifestShape | null {
  if (text === null || !text.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const manifest = parsed as ManifestShape;
    const shape: ManifestShape = {};
    for (const section of ["dependencies", "devDependencies"] as const) {
      const value = manifest[section];
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const entries: Record<string, string> = {};
        for (const [name, version] of Object.entries(value)) {
          if (typeof version === "string" && name.length > 0) {
            entries[name] = version.length > 0 ? version : "*";
          }
        }
        shape[section] = entries;
      }
    }
    return shape;
  } catch {
    return null;
  }
}

export function diffManifests(
  base: ManifestShape | null,
  current: ManifestShape | null,
): ManifestDiff {
  const baseEntries = collectEntries(base);
  const currentEntries = collectEntries(current);
  const added: DepEntry[] = [];
  const removed: DepEntry[] = [];
  for (const [name, version] of currentEntries) {
    const baseVersion = baseEntries.get(name);
    if (baseVersion === undefined) {
      added.push({ name, version });
    } else if (baseVersion !== version) {
      removed.push({ name, version: baseVersion });
      added.push({ name, version });
    }
  }
  for (const [name, version] of baseEntries) {
    if (!currentEntries.has(name)) {
      removed.push({ name, version });
    }
  }
  return { added, removed };
}

function collectEntries(manifest: ManifestShape | null): Map<string, string> {
  const entries = new Map<string, string>();
  if (!manifest) return entries;
  for (const section of [manifest.dependencies, manifest.devDependencies]) {
    for (const [name, version] of Object.entries(section ?? {})) {
      entries.set(name, version);
    }
  }
  return entries;
}

export function hasManifestDiff(diff: ManifestDiff): boolean {
  return diff.added.length > 0 || diff.removed.length > 0;
}

export interface DependencyCollectorOptions extends CollectorOptions {}

export interface DependencyCollector {
  readonly sink: FactSink;
  readonly facts: readonly EvidenceFact[];
  diffManifest(baseText: string | null, currentText: string | null): ManifestDiff;
  collectManifestChange(baseText: string | null, currentText: string | null): EvidenceFact | null;
  collectLockfileChange(lockfileName: string): EvidenceFact | null;
  collect(
    baseText: string | null,
    currentText: string | null,
    changedFiles?: readonly string[],
  ): EvidenceFact[];
}

export function createDependencyCollector(
  repoPath: string,
  opts: DependencyCollectorOptions = {},
): DependencyCollector {
  const cfg = resolveCollectorConfig(repoPath, opts);
  const ctx: CollectorContext = cfg.ctx;

  const emitManifestFact = (
    manifest: string,
    diff: ManifestDiff,
    force = false,
  ): EvidenceFact | null => {
    if (!force && !hasManifestDiff(diff)) return null;
    const fact: EvidenceFact = {
      type: "dependency_change",
      repoId: ctx.repoId,
      sessionId: ctx.sessionId,
      manifest,
      added: diff.added,
      removed: diff.removed,
      ts: cfg.now(),
    };
    cfg.sink.push(fact);
    return fact;
  };

  return {
    sink: cfg.sink,
    get facts(): readonly EvidenceFact[] {
      return sinkFacts(cfg.sink);
    },
    diffManifest(baseText: string | null, currentText: string | null): ManifestDiff {
      return diffManifests(parseManifest(baseText), parseManifest(currentText));
    },
    collectManifestChange(
      baseText: string | null,
      currentText: string | null,
    ): EvidenceFact | null {
      return emitManifestFact(
        "package.json",
        this.diffManifest(baseText, currentText),
      );
    },
    collectLockfileChange(lockfileName: string): EvidenceFact | null {
      if (!isKnownLockfileName(lockfileName)) return null;
      return emitManifestFact(lockfileName, { added: [], removed: [] }, true);
    },
    collect(
      baseText: string | null,
      currentText: string | null,
      changedFiles?: readonly string[],
    ): EvidenceFact[] {
      const facts: EvidenceFact[] = [];
      const manifestDiff = this.diffManifest(baseText, currentText);
      if (hasManifestDiff(manifestDiff)) {
        const fact = emitManifestFact("package.json", manifestDiff);
        if (fact) facts.push(fact);
        return facts;
      }
      const lockfile = (changedFiles ?? []).find(isKnownLockfileName);
      if (lockfile) {
        const fact = emitManifestFact(lockfile, { added: [], removed: [] }, true);
        if (fact) facts.push(fact);
      }
      return facts;
    },
  };
}
