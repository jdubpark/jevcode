import type { Component } from "@jevcode/contracts";

interface PathIndex {
  /** Listed file -> the component that lists it (longest root first, then id). */
  listed: ReadonlyMap<string, string>;
  /** Roots other than ".", longest first. */
  roots: readonly { root: string; id: string }[];
  /** The repo-root component, if any. */
  rootId: string | null;
}

const indexes = new WeakMap<readonly Component[], PathIndex>();

function indexOf(components: readonly Component[]): PathIndex {
  const cached = indexes.get(components);
  if (cached !== undefined) return cached;
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const ordered = [...components].sort((a, b) => b.rootPath.length - a.rootPath.length || cmp(a.rootPath, b.rootPath) || cmp(a.id, b.id));
  const listed = new Map<string, string>();
  for (const component of ordered) for (const file of component.files) if (!listed.has(file)) listed.set(file, component.id);
  const index: PathIndex = {
    listed,
    roots: ordered.filter((component) => component.rootPath !== ".").map((component) => ({ root: component.rootPath, id: component.id })),
    rootId: ordered.find((component) => component.rootPath === ".")?.id ?? null,
  };
  indexes.set(components, index);
  return index;
}

/**
 * The component a repo-relative path belongs to (spec §5.2; orchestrator ruling R6: the one path → component rule for
 * the Map, the Brief and the desktop stage). A component that lists the file wins (rule 4: a test joins the component
 * it tests), then the longest root that is a whole-segment prefix, then the repo-root component ("."), else null.
 */
export function componentIdForPath(components: readonly Component[], path: string): string | null {
  const index = indexOf(components);
  const listed = index.listed.get(path);
  if (listed !== undefined) return listed;
  for (const { root, id } of index.roots) if (path === root || path.startsWith(`${root}/`)) return id;
  return index.rootId;
}
