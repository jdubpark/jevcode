// Test-only: overview snapshots for model, layout and view tests. Excluded from the build (tsconfig.build.json).
import { createHash } from "node:crypto";

import { OverviewSnapshotSchema, ROLES, type Component, type OverviewSnapshot, type OverviewStatus, type Role } from "@jevcode/contracts";

import { SESSION_ID } from "./trace-builder.js";

export interface ComponentSeed {
  rootPath: string;
  /** Default: the last path segment. */
  name?: string;
  role?: Role;
  /** Default: role. */
  roleGuess?: Role;
  purpose?: string | null;
  provenance?: "rule" | "model";
  files?: string[];
  fileCount?: number;
  /** Default "TypeScript"; null is allowed. */
  language?: string | null;
  importsAnalyzed?: boolean;
  externalDeps?: { name: string; count: number }[];
  entryPoints?: string[];
  /** Two seeds with the same rootPath and version have the same contentHash. */
  version?: number;
}

export interface OverviewSeed {
  components: readonly ComponentSeed[];
  /** Endpoints by rootPath. */
  edges?: readonly { from: string; to: string; count: number; examples?: string[] }[];
  externals?: readonly { name: string; usedBy: readonly { rootPath: string; count: number }[] }[];
  partial?: boolean;
  /** counts.files; default: the sum of fileCount. */
  files?: number;
  languages?: string[];
  /** counts.totalFiles (ruling R3): repo files before the 20,000-file cap. */
  totalFiles?: number;
  /** Ruling R3; absent by default, like rows written before the field. */
  status?: OverviewStatus;
  narrative?: OverviewSnapshot["narrative"];
  sessionId?: string;
  repoRoot?: string;
  scanId?: string;
}

const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");

/** "cmp_" + sha1(rootPath).slice(0, 12) (spec §5.2). */
export function componentId(rootPath: string): string {
  return `cmp_${sha1(rootPath).slice(0, 12)}`;
}

export function componentOf(seed: ComponentSeed): Component {
  const role = seed.role ?? "domain";
  const files = seed.files ?? [`${seed.rootPath}/index.ts`];
  return {
    id: componentId(seed.rootPath),
    rootPath: seed.rootPath,
    name: seed.name ?? seed.rootPath.split("/").at(-1) ?? seed.rootPath,
    fileCount: seed.fileCount ?? files.length,
    files,
    language: seed.language === undefined ? "TypeScript" : seed.language,
    roleGuess: seed.roleGuess ?? role,
    role,
    purpose: seed.purpose === undefined ? null : seed.purpose,
    provenance: seed.provenance ?? "rule",
    contentHash: sha1(`${seed.rootPath}:${seed.version ?? 0}`),
    externalDeps: seed.externalDeps ?? [],
    entryPoints: seed.entryPoints ?? [],
    importsAnalyzed: seed.importsAnalyzed ?? true,
  };
}

/** A schema-valid snapshot. It is parsed here, so a seed that breaks a cap or a regex throws in the test setup. */
export function overviewSnapshot(seed: OverviewSeed): OverviewSnapshot {
  const components = seed.components.map(componentOf);
  const edges = (seed.edges ?? []).map((edge) => ({
    from: componentId(edge.from),
    to: componentId(edge.to),
    count: edge.count,
    examples: edge.examples ?? [],
  }));
  const externals = (seed.externals ?? []).map((ext) => ({
    name: ext.name,
    usedBy: ext.usedBy.map((use) => ({ componentId: componentId(use.rootPath), count: use.count })),
  }));
  const languages =
    seed.languages ?? [...new Set(components.flatMap((component) => (component.language === null ? [] : [component.language])))];
  return OverviewSnapshotSchema.parse({
    sessionId: seed.sessionId ?? SESSION_ID,
    repoRoot: seed.repoRoot ?? "/repo",
    scanId: seed.scanId ?? "scan-1",
    partial: seed.partial ?? false,
    counts: {
      files: seed.files ?? components.reduce((sum, component) => sum + component.fileCount, 0),
      components: components.length,
      edges: edges.length,
      languages,
      ...(seed.totalFiles === undefined ? {} : { totalFiles: seed.totalFiles }),
    },
    components,
    edges,
    externals,
    narrative: seed.narrative ?? null,
    ...(seed.status === undefined ? {} : { status: seed.status }),
    generatedAt: "2026-10-02T09:00:00.000Z",
  });
}

/** mulberry32: a small deterministic generator for synthetic snapshots. */
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A deterministic large snapshot (bench and stress): components across every role, `edges` distinct pairs. */
export function syntheticOverview(options: { components: number; edges: number; seed?: number; partial?: boolean }): OverviewSnapshot {
  const next = generator(options.seed ?? 1);
  const pick = (n: number): number => Math.floor(next() * n);
  const seeds: ComponentSeed[] = Array.from({ length: options.components }, (_, index) => ({
    rootPath: `packages/p${String(index).padStart(3, "0")}`,
    name: `p${String(index).padStart(3, "0")}`,
    role: ROLES[index % ROLES.length] ?? "domain",
    fileCount: 5 + pick(140),
    purpose: index % 3 === 0 ? null : `Component ${index} of the synthetic repo.`,
    provenance: index % 3 === 0 ? "rule" : "model",
  }));
  const edges: { from: string; to: string; count: number }[] = [];
  const seen = new Set<string>();
  for (let attempt = 0; edges.length < options.edges && attempt < options.edges * 20; attempt += 1) {
    const from = seeds[pick(seeds.length)];
    const to = seeds[pick(seeds.length)];
    if (from === undefined || to === undefined || from.rootPath === to.rootPath) continue;
    const key = `${from.rootPath}>${to.rootPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from: from.rootPath, to: to.rootPath, count: 1 + pick(40) });
  }
  const externals = Array.from({ length: Math.min(120, Math.floor(options.components / 2)) }, (_, index) => ({
    name: `ext-${index}`,
    usedBy: [0, 1, 2].flatMap((k) => {
      const user = seeds[(index * 7 + k * 13) % Math.max(1, seeds.length)];
      return user === undefined ? [] : [{ rootPath: user.rootPath, count: 1 + ((index + k) % 9) }];
    }),
  }));
  return overviewSnapshot({ components: seeds, edges, externals, partial: options.partial ?? false });
}
