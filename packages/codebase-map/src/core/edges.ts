import type { ComponentEdge, ExternalDep } from "@jevcode/contracts";

import { clipText, compareText } from "./paths.js";
import type { ExternalImport, ImportEdge } from "./types.js";

export const MAX_COMPONENT_EDGES = 1_000;
export const MAX_EDGE_EXAMPLES = 3;
export const MAX_EXAMPLE_LENGTH = 300;
export const MAX_EXTERNALS = 120;
export const MAX_USED_BY = 40;
export const MAX_PACKAGE_NAME_LENGTH = 214;

/** Heaviest first, then by component id, so equal input gives equal order. */
export function compareEdges(a: ComponentEdge, b: ComponentEdge): number {
  return b.count - a.count || compareText(a.from, b.from) || compareText(a.to, b.to);
}

/** Component edges after the 1,000 cap, and how many there were before it (`counts.edges`). */
export interface CappedEdges {
  edges: ComponentEdge[];
  total: number;
}

/** Heaviest first, capped at 1,000; `total` is the number of component pairs before the cap. */
export function capComponentEdges(edges: readonly ComponentEdge[]): CappedEdges {
  return { edges: [...edges].sort(compareEdges).slice(0, MAX_COMPONENT_EDGES), total: edges.length };
}

/**
 * Spec §5.3: file-level imports collapse into component pairs. `count` is the number of distinct
 * importing/imported file pairs; examples are the first three pairs in path order; self-edges
 * and files outside every component are dropped; the result is capped at 1,000 by count.
 */
export function aggregateEdges(
  edges: readonly ImportEdge[],
  componentOfFile: (path: string) => string | undefined,
): ComponentEdge[] {
  return aggregateComponentEdges(edges, componentOfFile).edges;
}

/** `aggregateEdges` plus the component pair count before the 1,000 cap. */
export function aggregateComponentEdges(
  edges: readonly ImportEdge[],
  componentOfFile: (path: string) => string | undefined,
): CappedEdges {
  const pairs = new Map<string, ImportEdge>();
  for (const edge of edges) pairs.set(`${edge.from}\u0000${edge.to}`, edge);
  const ordered = [...pairs.values()].sort((a, b) => compareText(a.from, b.from) || compareText(a.to, b.to));
  const byKey = new Map<string, ComponentEdge>();
  for (const edge of ordered) {
    const from = componentOfFile(edge.from);
    const to = componentOfFile(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    const key = `${from}\u0000${to}`;
    let entry = byKey.get(key);
    if (entry === undefined) {
      entry = { from, to, count: 0, examples: [] };
      byKey.set(key, entry);
    }
    entry.count += 1;
    if (entry.examples.length < MAX_EDGE_EXAMPLES) {
      entry.examples.push(clipText(`${edge.from} → ${edge.to}`, MAX_EXAMPLE_LENGTH));
    }
  }
  return capComponentEdges([...byKey.values()]);
}

/**
 * Component-to-package edges, kept apart from component edges (spec §5.3). A file importing a
 * package twice counts once. `usedBy` is capped at 40 and the list at 120, heaviest first.
 */
export function aggregateExternals(
  imports: readonly ExternalImport[],
  componentOfFile: (path: string) => string | undefined,
): ExternalDep[] {
  const seen = new Set<string>();
  const byName = new Map<string, Map<string, number>>();
  for (const entry of imports) {
    const name = entry.packageName;
    if (name.length === 0 || name.length > MAX_PACKAGE_NAME_LENGTH) continue;
    const key = `${entry.from}\u0000${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const componentId = componentOfFile(entry.from);
    if (componentId === undefined) continue;
    const users = byName.get(name) ?? new Map<string, number>();
    users.set(componentId, (users.get(componentId) ?? 0) + 1);
    byName.set(name, users);
  }
  return rankExternals(byName);
}

/**
 * The ranking and caps of `aggregateExternals` over counted users: package name → component id
 * → number of the component's files that import the package.
 */
export function rankExternals(byName: ReadonlyMap<string, ReadonlyMap<string, number>>): ExternalDep[] {
  const ranked = [...byName.entries()].map(([name, users]) => {
    const usedBy = [...users.entries()]
      .map(([componentId, count]) => ({ componentId, count }))
      .sort((a, b) => b.count - a.count || compareText(a.componentId, b.componentId));
    return { name, total: usedBy.reduce((sum, use) => sum + use.count, 0), usedBy: usedBy.slice(0, MAX_USED_BY) };
  });
  return ranked
    .sort((a, b) => b.total - a.total || compareText(a.name, b.name))
    .slice(0, MAX_EXTERNALS)
    .map(({ name, usedBy }) => ({ name, usedBy }));
}
