import { sha1Hex } from "./sha1.js";
import { IMPORT_LANGUAGES, basenameOf, compareText, countLanguages, isUnder, mainLanguage } from "./paths.js";
import type { ScannedFile, WorkspaceManifest } from "./types.js";

/** Spec §5.2 rule 3: a component with more files than this splits by its next branching level. */
export const SPLIT_THRESHOLD = 150;
/** Name of the repo-root files component when other components exist (spec §5.2 rule 4). */
export const CONFIG_COMPONENT_NAME = "config";
/** Name of the single component of a repo whose files all sit at the root, without a root package name. */
export const FLAT_COMPONENT_NAME = "root";
/** Top-level directories whose components are tooling (spec §5.2 rule 4, §5.4 rule 5). */
export const TOOLING_DIRS: readonly string[] = ["scripts", "tools", ".github"];
export const MAX_DRAFT_ENTRY_POINTS = 8;

const SOURCE_PARENTS: readonly string[] = ["src", "lib", "packages"];
const TEST_DIRS: ReadonlySet<string> = new Set(["test", "tests", "__tests__"]);

export interface ComponentDraft {
  id: string;
  rootPath: string;
  name: string;
  /** Every member path, sorted. The snapshot caps the list; `files.length` is the true count. */
  files: string[];
  language: string | null;
  contentHash: string;
  entryPoints: string[];
  /** True when at least one member file has a grammar the import parser reads (TS, JS, JSON). */
  importsAnalyzed: boolean;
}

/** `"cmp_" + sha1(rootPath).slice(0, 12)`: stable while the root path is unchanged (spec §5.2). */
export function componentIdFor(rootPath: string): string {
  return `cmp_${sha1Hex(rootPath).slice(0, 12)}`;
}

/** `sha1(sorted(path + ":" + file hash))`, lines joined with "\n" (spec §5.2). */
export function contentHash(members: readonly { path: string; hash: string }[]): string {
  return sha1Hex(members.map((member) => `${member.path}:${member.hash}`).sort(compareText).join("\n"));
}

function depth(path: string): number {
  return path.split("/").length;
}

function firstSegment(rest: string): string | null {
  const slash = rest.indexOf("/");
  return slash === -1 ? null : rest.slice(0, slash);
}

/** Cut rules 1 and 2: workspace packages and apps, else children of src/, lib/ and packages/. */
function chooseRoots(paths: readonly string[], manifest: WorkspaceManifest): Map<string, string> {
  const roots = new Map<string, string>();
  const workspace = [...manifest.packageDirs, ...manifest.appDirs].filter((dir) => dir !== "" && dir !== ".");
  if (workspace.length > 0) {
    for (const dir of workspace) roots.set(dir, manifest.packageNames[dir] ?? basenameOf(dir));
    return roots;
  }
  for (const parent of SOURCE_PARENTS) {
    const children = new Set<string>();
    let parentHoldsFiles = false;
    for (const path of paths) {
      if (!isUnder(path, parent)) continue;
      const child = firstSegment(path.slice(parent.length + 1));
      if (child === null || TEST_DIRS.has(child)) parentHoldsFiles = true;
      else children.add(child);
    }
    for (const child of children) roots.set(`${parent}/${child}`, child);
    if (parentHoldsFiles) roots.set(parent, parent);
  }
  return roots;
}

/** Deepest roots first, so a file joins its nearest component (rule 4). */
function orderRoots(roots: ReadonlyMap<string, string>): string[] {
  return [...roots.keys()]
    .filter((root) => root !== ".")
    .sort((a, b) => depth(b) - depth(a) || compareText(a, b));
}

interface Part {
  rootPath: string;
  name: string;
  files: ScannedFile[];
}

const SOURCE_WRAPPERS: ReadonlySet<string> = new Set(["src", "lib"]);

/** "@x/big" + "src/ui" → "@x/big/ui"; the original root's own files → "@x/big/root". */
function partName(name: string, rootPath: string, partRoot: string): string {
  if (partRoot === rootPath) return `${name}/root`;
  const rel = partRoot.slice(rootPath.length + 1);
  const shown = rel.split("/").filter((segment) => !SOURCE_WRAPPERS.has(segment)).join("/");
  return `${name}/${shown === "" ? rel : shown}`;
}

/**
 * Rule 3 for the files under `base`. Descends through a directory that holds every
 * subdirectory file, then splits by the first level with two or more directories. A part
 * that still has more than 150 files splits again. Test directories never become parts; they
 * and the files above the split level stay in the part rooted at `base`.
 */
function splitUnder(base: string, files: readonly ScannedFile[]): { rootPath: string; files: ScannedFile[] }[] {
  let level = base;
  for (;;) {
    const dirs = new Set<string>();
    for (const file of files) {
      if (!isUnder(file.path, level)) continue;
      const dir = firstSegment(file.path.slice(level.length + 1));
      if (dir !== null && !TEST_DIRS.has(dir)) dirs.add(dir);
    }
    if (dirs.size === 0) return [{ rootPath: base, files: [...files] }];
    if (dirs.size === 1) {
      level = `${level}/${[...dirs][0] as string}`;
      continue;
    }
    const groups = new Map<string, ScannedFile[]>();
    const rest: ScannedFile[] = [];
    for (const file of files) {
      const dir = isUnder(file.path, level) ? firstSegment(file.path.slice(level.length + 1)) : null;
      if (dir !== null && dirs.has(dir)) {
        const group = groups.get(dir) ?? [];
        group.push(file);
        groups.set(dir, group);
      } else {
        rest.push(file);
      }
    }
    const parts: { rootPath: string; files: ScannedFile[] }[] = [];
    for (const [dir, group] of [...groups.entries()].sort((a, b) => compareText(a[0], b[0]))) {
      const partRoot = `${level}/${dir}`;
      if (group.length > SPLIT_THRESHOLD) parts.push(...splitUnder(partRoot, group));
      else parts.push({ rootPath: partRoot, files: group });
    }
    if (rest.length > 0) parts.push({ rootPath: base, files: rest });
    return parts;
  }
}

function splitComponent(rootPath: string, name: string, files: readonly ScannedFile[]): Part[] {
  if (rootPath === "." || files.length <= SPLIT_THRESHOLD) return [{ rootPath, name, files: [...files] }];
  const parts = splitUnder(rootPath, files);
  if (parts.length === 1) return [{ rootPath, name, files: [...files] }];
  return parts.map((part) => ({ ...part, name: partName(name, rootPath, part.rootPath) }));
}

function entryPointsFor(part: Part, parts: readonly Part[], entries: readonly string[]): string[] {
  const nested = parts
    .map((other) => other.rootPath)
    .filter((other) => other !== part.rootPath && isUnder(other, part.rootPath));
  return entries
    .filter((entry) => isUnder(entry, part.rootPath) && !nested.some((other) => isUnder(entry, other)))
    .slice(0, MAX_DRAFT_ENTRY_POINTS);
}

function toDraft(part: Part, entryPoints: string[]): ComponentDraft {
  const files = [...part.files].sort((a, b) => compareText(a.path, b.path));
  return {
    id: componentIdFor(part.rootPath),
    rootPath: part.rootPath,
    name: part.name,
    files: files.map((file) => file.path),
    language: mainLanguage(countLanguages(files.map((file) => file.language))),
    contentHash: contentHash(files),
    entryPoints,
    importsAnalyzed: files.some((file) => file.language !== null && IMPORT_LANGUAGES.has(file.language)),
  };
}

/** Spec §5.2: every file lands in exactly one component. Output is sorted by root path. */
export function componentize(files: readonly ScannedFile[], manifest: WorkspaceManifest): ComponentDraft[] {
  const sorted = [...files].sort((a, b) => compareText(a.path, b.path));
  const roots = chooseRoots(sorted.map((file) => file.path), manifest);
  let order = orderRoots(roots);
  const members = new Map<string, ScannedFile[]>();
  for (const file of sorted) {
    let root = order.find((candidate) => isUnder(file.path, candidate));
    if (root === undefined) {
      root = firstSegment(file.path) ?? ".";
      if (!roots.has(root)) {
        roots.set(root, root === "." ? CONFIG_COMPONENT_NAME : root);
        if (root !== ".") order = orderRoots(roots);
      }
    }
    const group = members.get(root) ?? [];
    group.push(file);
    members.set(root, group);
  }
  if (members.size === 1 && members.has(".")) {
    roots.set(".", manifest.packageNames["."] ?? FLAT_COMPONENT_NAME);
  }
  const drafts: ComponentDraft[] = [];
  for (const [rootPath, group] of members) {
    const parts = splitComponent(rootPath, roots.get(rootPath) ?? rootPath, group);
    const entries = manifest.entryPoints[rootPath] ?? [];
    for (const part of parts) drafts.push(toDraft(part, entryPointsFor(part, parts, entries)));
  }
  return drafts.sort((a, b) => compareText(a.rootPath, b.rootPath));
}

/** Maps a member file path to its component id. */
export function componentOf(drafts: readonly ComponentDraft[]): (filePath: string) => string | undefined {
  const byPath = new Map<string, string>();
  for (const draft of drafts) {
    for (const file of draft.files) byPath.set(file, draft.id);
  }
  return (filePath) => byPath.get(filePath);
}
