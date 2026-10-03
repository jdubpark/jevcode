import type { Component } from "@jevcode/contracts";

interface PathIndex {
  /** Listed file -> the component that lists it (longest root first, then id). */
  listed: ReadonlyMap<string, string>;
  /** Roots other than ".", longest first. */
  roots: readonly { root: string; id: string }[];
  /** The repo-root component ("."), if any: it holds root-level files only (lane 04 groups a nested file by its directory). */
  rootId: string | null;
  /** The "(other)" catch-all component, if any. */
  otherId: string | null;
}

/** The catch-all bucket's pseudo root (lane 04's OTHER_ROOT_PATH): not a directory, so it never matches by prefix. */
const OTHER_ROOT = "(other)";

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
    roots: ordered.filter((component) => component.rootPath !== "." && component.rootPath !== OTHER_ROOT).map((component) => ({ root: component.rootPath, id: component.id })),
    rootId: ordered.find((component) => component.rootPath === ".")?.id ?? null,
    otherId: ordered.find((component) => component.rootPath === OTHER_ROOT)?.id ?? null,
  };
  indexes.set(components, index);
  return index;
}

/**
 * The component a repo-relative path belongs to (spec §5.2; orchestrator ruling R6: the one path → component rule for
 * the Map, the Brief and the desktop stage). A component that lists the file wins (rule 4: a test joins the component
 * it tests), then the longest root that is a whole-segment prefix. A path no component claims that way goes to a
 * catch-all (lane 06 fix I-3): a root-level path (no "/") to the repo-root component ("."), which holds root-level files
 * only; a nested path to the "(other)" component, which holds the groups past the component cap and lists at most 400
 * of their files; else null. A root-level path with no "." component also goes to "(other)", where lane 04 puts "."
 * when it is past the cap.
 *
 * `path` must be repo-relative with no "./" prefix: an absolute or "./"-prefixed path is not normalized here (callers
 * strip the repo root first). An empty, absolute or "../" path resolves to null, never to a catch-all. The "(other)" bucket has a pseudo root, so it never matches by prefix.
 */
export function componentIdForPath(components: readonly Component[], path: string): string | null {
  // Not repo-relative (empty, absolute or outside the repo): no catch-all may claim it.
  if (path === "" || path.startsWith("/") || path === ".." || path.startsWith("../")) return null;
  const index = indexOf(components);
  const listed = index.listed.get(path);
  if (listed !== undefined) return listed;
  for (const { root, id } of index.roots) if (path === root || path.startsWith(`${root}/`)) return id;
  if (!path.includes("/")) return index.rootId ?? index.otherId;
  return index.otherId;
}
