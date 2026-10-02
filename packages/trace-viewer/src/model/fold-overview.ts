import type { Component, OverviewSnapshot } from "@jevcode/contracts";

import type { FoldState } from "./fold-state.js";
import type { OverviewModel } from "./types.js";

/** Replace semantics (spec §8.1): the latest snapshot row wins. accumulate skips lower seqs, so seqs only grow. */
export function foldOverviewSnapshot(state: FoldState, snapshot: OverviewSnapshot, seq: number): void {
  state.overview = { snapshot, seq };
}

/** Every ComponentSchema field, which sameComponent compares (fold-overview.test.ts pins the list to the schema). */
export const COMPONENT_KEYS = [
  "id",
  "rootPath",
  "name",
  "fileCount",
  "files",
  "language",
  "roleGuess",
  "role",
  "purpose",
  "provenance",
  "contentHash",
  "externalDeps",
  "entryPoints",
  "importsAnalyzed",
] as const;

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

/** Field-by-field equality of two parsed components; id and content hash first, since they settle most pairs. */
export function sameComponent(a: Component, b: Component): boolean {
  if (a === b) return true;
  if (a.id !== b.id || a.contentHash !== b.contentHash) return false;
  if (a.rootPath !== b.rootPath || a.name !== b.name || a.fileCount !== b.fileCount || a.language !== b.language) return false;
  if (a.roleGuess !== b.roleGuess || a.role !== b.role || a.purpose !== b.purpose || a.provenance !== b.provenance) return false;
  if (a.importsAnalyzed !== b.importsAnalyzed) return false;
  if (!sameStrings(a.files, b.files) || !sameStrings(a.entryPoints, b.entryPoints)) return false;
  if (a.externalDeps.length !== b.externalDeps.length) return false;
  return a.externalDeps.every((dep, index) => {
    const other = b.externalDeps[index];
    return other !== undefined && dep.name === other.name && dep.count === other.count;
  });
}

/** A model of `snapshot` in which every component equal to `previous`'s component with the same id is that object. */
export function buildOverviewModel(snapshot: OverviewSnapshot, seq: number, previous: OverviewModel | null = null): OverviewModel {
  const prior = previous?.componentById;
  const components = snapshot.components.map((component) => {
    const old = prior?.get(component.id);
    return old !== undefined && sameComponent(old, component) ? old : component;
  });
  const componentById = new Map<string, Component>();
  for (const component of components) if (!componentById.has(component.id)) componentById.set(component.id, component);
  return { snapshot: { ...snapshot, components }, componentById, seq };
}

/** finalize's overview: the previous model while the row is the same, else a new model that keeps unchanged components. */
export function overviewModelOf(latest: FoldState["overview"], previous: OverviewModel | null): OverviewModel | null {
  if (latest === null) return null;
  if (previous !== null && previous.seq === latest.seq) return previous;
  return buildOverviewModel(latest.snapshot, latest.seq, previous);
}
