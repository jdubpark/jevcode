import { OVERVIEW_SNAPSHOT_MAX_BYTES } from "@jevcode/contracts";
import type { Component, ComponentEdge, ExternalDep, OverviewSnapshot, Role } from "@jevcode/contracts";

import { componentIdFor, type ComponentDraft } from "./componentize.js";
import { MAX_COMPONENT_EDGES, MAX_EDGE_EXAMPLES, MAX_EXAMPLE_LENGTH, MAX_EXTERNALS, MAX_USED_BY, compareEdges } from "./edges.js";
import { clipText, compareText, mainLanguage } from "./paths.js";
import { guessRole } from "./roles.js";
import { sha1Hex, utf8ByteLength } from "./sha1.js";

export const MAX_COMPONENTS = 200;
export const MAX_COMPONENT_FILES = 400;
export const MAX_COMPONENT_EXTERNALS = 8;
export const MAX_ENTRY_POINTS = 8;
export const MAX_LANGUAGES = 20;
/** Root path and name of the group that holds the smallest components past the 200 cap (spec §5.5). */
export const OTHER_ROOT_PATH = "(other)";
export const OTHER_COMPONENT_NAME = "other";
const MAX_NAME = 120;
const MAX_PURPOSE = 140;
const MAX_LANGUAGE = 40;
const FILE_LIST_STEPS = [200, 100, 50, 20, 0] as const;
const USED_BY_STEP = 10;
/**
 * The stage stamps `status` (about 1 KB at most: scan counters plus a 200-character error) and the
 * real `sessionId` (assembly runs with "") after assembly, so the trimmer budgets for both.
 */
const STAMP_HEADROOM_BYTES = 2_048;
const SNAPSHOT_BUDGET_BYTES = OVERVIEW_SNAPSHOT_MAX_BYTES - STAMP_HEADROOM_BYTES;

/** Purpose and confirmed role for one component; missing ids use the rule-based guess. */
export interface ComponentText {
  purpose: string | null;
  role: Role;
  provenance: "rule" | "model";
}

export interface AssembleSnapshotInput {
  sessionId: string;
  repoRoot: string;
  scanId: string;
  partial: boolean;
  drafts: ComponentDraft[];
  /** Repo files before the 20,000-file cap (ruling R3); defaults to the mapped file count. */
  totalFiles?: number;
  edges: ComponentEdge[];
  /** Component edges before the 1,000-edge cap (`CappedEdges.total`); defaults to `edges.length`. */
  totalEdges?: number;
  externals: ExternalDep[];
  text: Map<string, ComponentText>;
  narrative: OverviewSnapshot["narrative"];
  generatedAt: string;
}

interface Capped {
  kept: ComponentDraft[];
  otherId: string | null;
  otherOf: ReadonlyMap<string, string>;
}

function weightedLanguage(drafts: readonly ComponentDraft[]): string | null {
  const counts = new Map<string, number>();
  for (const draft of drafts) {
    if (draft.language !== null) counts.set(draft.language, (counts.get(draft.language) ?? 0) + draft.files.length);
  }
  return mainLanguage(counts);
}

/** Keeps the 199 largest components and groups the rest into "other" (spec §5.5). */
function capComponents(drafts: readonly ComponentDraft[]): Capped {
  if (drafts.length <= MAX_COMPONENTS) return { kept: [...drafts], otherId: null, otherOf: new Map() };
  const ranked = [...drafts].sort((a, b) => b.files.length - a.files.length || compareText(a.rootPath, b.rootPath));
  const keep = ranked.slice(0, MAX_COMPONENTS - 1);
  const grouped = ranked.slice(MAX_COMPONENTS - 1);
  const otherId = componentIdFor(OTHER_ROOT_PATH);
  const other: ComponentDraft = {
    id: otherId,
    rootPath: OTHER_ROOT_PATH,
    name: OTHER_COMPONENT_NAME,
    files: grouped.flatMap((draft) => draft.files).sort(compareText),
    language: weightedLanguage(grouped),
    contentHash: sha1Hex(grouped.map((draft) => draft.contentHash).sort(compareText).join("\n")),
    entryPoints: [],
    importsAnalyzed: grouped.some((draft) => draft.importsAnalyzed),
  };
  return {
    kept: [...keep, other].sort((a, b) => compareText(a.rootPath, b.rootPath)),
    otherId,
    otherOf: new Map(grouped.map((draft) => [draft.id, otherId])),
  };
}

function mergeEdges(edges: readonly ComponentEdge[], remap: (id: string) => string, valid: ReadonlySet<string>): ComponentEdge[] {
  const byKey = new Map<string, ComponentEdge>();
  for (const edge of [...edges].sort(compareEdges)) {
    const from = remap(edge.from);
    const to = remap(edge.to);
    if (from === to || !valid.has(from) || !valid.has(to)) continue;
    const key = `${from}\u0000${to}`;
    let entry = byKey.get(key);
    if (entry === undefined) {
      entry = { from, to, count: 0, examples: [] };
      byKey.set(key, entry);
    }
    entry.count += edge.count;
    for (const example of edge.examples) {
      const clipped = clipText(example, MAX_EXAMPLE_LENGTH);
      if (entry.examples.length < MAX_EDGE_EXAMPLES && !entry.examples.includes(clipped)) entry.examples.push(clipped);
    }
  }
  return [...byKey.values()].sort(compareEdges).slice(0, MAX_COMPONENT_EDGES);
}

function mergeExternals(externals: readonly ExternalDep[], remap: (id: string) => string, valid: ReadonlySet<string>): ExternalDep[] {
  const ranked = externals.map((dep) => {
    const users = new Map<string, number>();
    for (const use of dep.usedBy) {
      const id = remap(use.componentId);
      if (valid.has(id)) users.set(id, (users.get(id) ?? 0) + use.count);
    }
    const usedBy = [...users.entries()]
      .map(([componentId, count]) => ({ componentId, count }))
      .sort((a, b) => b.count - a.count || compareText(a.componentId, b.componentId));
    return { name: dep.name, total: usedBy.reduce((sum, use) => sum + use.count, 0), usedBy: usedBy.slice(0, MAX_USED_BY) };
  });
  return ranked
    .filter((dep) => dep.usedBy.length > 0)
    .sort((a, b) => b.total - a.total || compareText(a.name, b.name))
    .slice(0, MAX_EXTERNALS)
    .map(({ name, usedBy }) => ({ name, usedBy }));
}

function externalDepsByComponent(externals: readonly ExternalDep[]): Map<string, { name: string; count: number }[]> {
  const byComponent = new Map<string, { name: string; count: number }[]>();
  for (const dep of externals) {
    for (const use of dep.usedBy) {
      const list = byComponent.get(use.componentId) ?? [];
      list.push({ name: dep.name, count: use.count });
      byComponent.set(use.componentId, list);
    }
  }
  for (const [id, list] of byComponent) {
    byComponent.set(id, list.sort((a, b) => b.count - a.count || compareText(a.name, b.name)).slice(0, MAX_COMPONENT_EXTERNALS));
  }
  return byComponent;
}

function sizeOf(snapshot: OverviewSnapshot): number {
  return utf8ByteLength(JSON.stringify(snapshot));
}

/** Trims in a fixed order until the row fits in 512 KB minus the stage's stamp headroom (spec §5.5, §11). */
function fitSize(snapshot: OverviewSnapshot): OverviewSnapshot {
  const fits = (candidate: OverviewSnapshot): boolean => sizeOf(candidate) <= SNAPSHOT_BUDGET_BYTES;
  let next = snapshot;
  if (fits(next)) return next;
  for (const limit of FILE_LIST_STEPS) {
    next = { ...next, components: next.components.map((component) => ({ ...component, files: component.files.slice(0, limit) })) };
    if (fits(next)) return next;
  }
  next = { ...next, edges: next.edges.map((edge) => ({ ...edge, examples: [] })) };
  if (fits(next)) return next;
  next = { ...next, externals: next.externals.map((dep) => ({ ...dep, usedBy: dep.usedBy.slice(0, USED_BY_STEP) })) };
  if (fits(next)) return next;
  while (next.edges.length > 0) {
    next = { ...next, edges: next.edges.slice(0, Math.floor(next.edges.length / 2)) };
    if (fits(next)) return next;
  }
  next = { ...next, externals: [] };
  if (fits(next)) return next;
  next = { ...next, components: next.components.map((component) => ({ ...component, entryPoints: [], externalDeps: [] })) };
  if (fits(next)) return next;
  throw new RangeError(`overview snapshot exceeds ${SNAPSHOT_BUDGET_BYTES} bytes after trimming`);
}

/**
 * Spec §5.5. Pure: equal input gives an equal snapshot. Applies the 200-component cap (the
 * smallest components group into "other" and their edges follow), the 1,000-edge and
 * 120-external caps, 400 listed files per component, and the 512 KB bound (less 2 KB of headroom
 * for the `status` and `sessionId` the stage stamps afterwards). `counts` hold the
 * totals before the caps; `counts.totalFiles` is the repo's file count before the scan cap and
 * `counts.edges` the component edge count before the 1,000-edge cap (`totalEdges`).
 * The stage adds `status` (ruling R3) after assembly.
 */
export function assembleSnapshot(input: AssembleSnapshotInput): OverviewSnapshot {
  const drafts = [...input.drafts].sort((a, b) => compareText(a.rootPath, b.rootPath));
  const capped = capComponents(drafts);
  const valid = new Set(capped.kept.map((draft) => draft.id));
  const remap = (id: string): string => capped.otherOf.get(id) ?? id;
  const edges = mergeEdges(input.edges, remap, valid);
  const externals = mergeExternals(input.externals, remap, valid);
  const depsById = externalDepsByComponent(externals);

  const components: Component[] = capped.kept.map((draft) => {
    const roleGuess: Role = draft.id === capped.otherId ? "domain" : guessRole(draft, input.externals);
    const text = input.text.get(draft.id);
    return {
      id: draft.id,
      rootPath: draft.rootPath,
      name: clipText(draft.name, MAX_NAME),
      fileCount: draft.files.length,
      files: draft.files.slice(0, MAX_COMPONENT_FILES),
      language: draft.language === null ? null : clipText(draft.language, MAX_LANGUAGE),
      roleGuess,
      role: text?.role ?? roleGuess,
      purpose: text?.purpose == null ? null : clipText(text.purpose, MAX_PURPOSE),
      provenance: text?.provenance ?? "rule",
      contentHash: draft.contentHash,
      externalDeps: depsById.get(draft.id) ?? [],
      entryPoints: draft.entryPoints.slice(0, MAX_ENTRY_POINTS),
      importsAnalyzed: draft.importsAnalyzed,
    };
  });

  const languageFiles = new Map<string, number>();
  for (const draft of drafts) {
    if (draft.language !== null) languageFiles.set(draft.language, (languageFiles.get(draft.language) ?? 0) + draft.files.length);
  }
  const languages = [...languageFiles.entries()]
    .sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))
    .slice(0, MAX_LANGUAGES)
    .map(([language]) => clipText(language, MAX_LANGUAGE));

  const files = drafts.reduce((sum, draft) => sum + draft.files.length, 0);
  return fitSize({
    sessionId: input.sessionId,
    repoRoot: input.repoRoot,
    scanId: input.scanId,
    partial: input.partial,
    counts: {
      files,
      components: drafts.length,
      edges: Math.max(input.edges.length, input.totalEdges ?? input.edges.length),
      languages,
      totalFiles: Math.max(files, input.totalFiles ?? files),
    },
    components,
    edges,
    externals,
    narrative: input.narrative,
    generatedAt: input.generatedAt,
  });
}
