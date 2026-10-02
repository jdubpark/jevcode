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
  /** True when at least one member is a TS, TSX or JS file, whose imports the parser reads. */
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

function firstSegment(rest: string): string | null {
  const slash = rest.indexOf("/");
  return slash === -1 ? null : rest.slice(0, slash);
}

/** Rule 2 outside a workspace: the src/, lib/ or packages/ root a file keeps chosen, and its name. */
function sourceRootOf(path: string): [root: string, name: string] | null {
  for (const parent of SOURCE_PARENTS) {
    if (!isUnder(path, parent)) continue;
    const child = firstSegment(path.slice(parent.length + 1));
    return child === null || TEST_DIRS.has(child) ? [parent, parent] : [`${parent}/${child}`, child];
  }
  return null;
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

/** What one `ComponentIndex.apply` changed, for callers that keep per-component caches. */
export interface ComponentIndexChange {
  /** Ids of drafts that were rebuilt, added or removed. */
  changed: Set<string>;
  /** Ids that no longer exist. */
  removed: Set<string>;
  /** Old ids that lost a member file to another component (a split moved; added files excluded). */
  movedFrom: Set<string>;
}

/** Runs a step generator to the end on the calling thread. */
export function drainSteps<T>(steps: Generator<void, T>): T {
  for (;;) {
    const next = steps.next();
    if (next.done === true) return next.value;
  }
}

/**
 * The spec §5.2 components of a file set, kept up to date file by file (spec §6.1: only dirty
 * components are recomputed). `drafts()` always equals `componentize` of the current files.
 * A file joins the deepest chosen root above it (rules 1 and 2), else its top-level directory,
 * else the repo-root "." group, so a change touches only its own group. `apply` returns null
 * when the change alters the chosen roots or a flat repo's naming; the caller then rebuilds.
 */
export class ComponentIndex {
  private readonly files = new Map<string, ScannedFile>();
  private readonly chosen = new Map<string, string>();
  /** Outside a workspace: how many files keep each rule-2 root chosen. */
  private readonly sourceRoots = new Map<string, { name: string; files: number }>();
  private readonly groups = new Map<string, Map<string, ScannedFile>>();
  private readonly groupOf = new Map<string, string>();
  private readonly draftsOf = new Map<string, ComponentDraft[]>();
  private readonly draftById = new Map<string, ComponentDraft>();
  private readonly idOf = new Map<string, string>();
  private readonly workspace: boolean;

  private constructor(private readonly manifest: WorkspaceManifest) {
    const dirs = [...manifest.packageDirs, ...manifest.appDirs].filter((dir) => dir !== "" && dir !== ".");
    this.workspace = dirs.length > 0;
    for (const dir of dirs) this.chosen.set(dir, manifest.packageNames[dir] ?? basenameOf(dir));
  }

  static build(files: readonly ScannedFile[], manifest: WorkspaceManifest): ComponentIndex {
    return drainSteps(ComponentIndex.steps(files, manifest));
  }

  /** The build as steps: it yields every `every` files and after each group, so a caller can pause. */
  static *steps(files: readonly ScannedFile[], manifest: WorkspaceManifest, every = 2_000): Generator<void, ComponentIndex> {
    const index = new ComponentIndex(manifest);
    let count = 0;
    for (const file of files) {
      index.files.set(file.path, file);
      if (!index.workspace) index.countSourceRoot(file.path, 1);
      if ((count += 1) % every === 0) yield;
    }
    if (!index.workspace) {
      for (const [root, entry] of index.sourceRoots) index.chosen.set(root, entry.name);
    }
    for (const file of index.files.values()) {
      index.join(file);
      if ((count += 1) % every === 0) yield;
    }
    for (const root of index.groups.keys()) {
      index.rebuildGroup(root, new Set());
      yield;
    }
    return index;
  }

  /** Every draft, sorted by root path. */
  drafts(): ComponentDraft[] {
    return [...this.draftsOf.values()].flat().sort((a, b) => compareText(a.rootPath, b.rootPath));
  }

  draft(id: string): ComponentDraft | undefined {
    return this.draftById.get(id);
  }

  componentOf(path: string): string | undefined {
    return this.idOf.get(path);
  }

  /**
   * Adds or replaces `upserts` and removes `removed` (paths that are not members are ignored).
   * Returns null, and changes nothing, when the change alters the chosen roots or the naming of
   * a flat repo: the caller then builds a new index.
   */
  apply(upserts: readonly ScannedFile[], removed: readonly string[]): ComponentIndexChange | null {
    const added = upserts.filter((file) => !this.files.has(file.path));
    const edited = upserts.filter((file) => this.files.has(file.path));
    const gone = removed.filter((path) => this.files.has(path) && !upserts.some((file) => file.path === path));
    if (this.altersStructure(added, gone)) return null;

    const touched = new Map<string, Set<string>>();
    const touch = (root: string, path: string | null): void => {
      const paths = touched.get(root) ?? new Set<string>();
      if (path !== null) paths.add(path);
      touched.set(root, paths);
    };
    const reshaped = new Set<string>();
    for (const path of gone) {
      const root = this.groupOf.get(path) as string;
      this.files.delete(path);
      this.groupOf.delete(path);
      this.groups.get(root)?.delete(path);
      if (!this.workspace) this.countSourceRoot(path, -1);
      reshaped.add(root);
      touch(root, null);
    }
    for (const file of added) {
      this.files.set(file.path, file);
      if (!this.workspace) this.countSourceRoot(file.path, 1);
      reshaped.add(this.join(file));
    }
    for (const file of edited) {
      this.files.set(file.path, file);
      const root = this.groupOf.get(file.path) as string;
      this.groups.get(root)?.set(file.path, file);
      touch(root, file.path);
    }

    const change: ComponentIndexChange = { changed: new Set(), removed: new Set(), movedFrom: new Set() };
    for (const path of gone) this.idOf.delete(path);
    for (const root of reshaped) {
      for (const draft of this.draftsOf.get(root) ?? []) change.changed.add(draft.id);
      for (const draft of this.rebuildGroup(root, change.movedFrom)) change.changed.add(draft.id);
    }
    for (const [root, paths] of touched) {
      if (reshaped.has(root)) continue;
      // Same members: only the drafts holding an edited file get a new content hash.
      const ids = new Set([...paths].map((path) => this.idOf.get(path) as string));
      const drafts = (this.draftsOf.get(root) ?? []).map((draft) => {
        if (!ids.has(draft.id)) return draft;
        change.changed.add(draft.id);
        return { ...draft, contentHash: contentHash(draft.files.map((path) => this.files.get(path) as ScannedFile)) };
      });
      this.setDrafts(root, drafts);
    }
    for (const id of change.changed) {
      if (!this.draftById.has(id)) change.removed.add(id);
    }
    return change;
  }

  private countSourceRoot(path: string, delta: 1 | -1): void {
    const root = sourceRootOf(path);
    if (root === null) return;
    const entry = this.sourceRoots.get(root[0]) ?? { name: root[1], files: 0 };
    entry.files += delta;
    if (entry.files === 0) this.sourceRoots.delete(root[0]);
    else this.sourceRoots.set(root[0], entry);
  }

  /** True when adding `added` and removing `gone` changes the rule-2 roots or a flat repo's name. */
  private altersStructure(added: readonly ScannedFile[], gone: readonly string[]): boolean {
    if (added.length === 0 && gone.length === 0) return false;
    if (!this.workspace) {
      const delta = new Map<string, number>();
      for (const [paths, step] of [
        [added.map((file) => file.path), 1],
        [gone, -1],
      ] as const) {
        for (const path of paths) {
          const root = sourceRootOf(path);
          if (root !== null) delta.set(root[0], (delta.get(root[0]) ?? 0) + step);
        }
      }
      for (const [root, step] of delta) {
        const before = this.sourceRoots.get(root)?.files ?? 0;
        if ((before === 0) !== (before + step === 0)) return true;
      }
    }
    const sizes = new Map<string, number>([...this.groups].map(([root, members]) => [root, members.size]));
    const flatBefore = sizes.size === 1 && sizes.has(".");
    for (const file of added) {
      const root = this.rootOf(file.path);
      sizes.set(root, (sizes.get(root) ?? 0) + 1);
    }
    for (const path of gone) {
      const root = this.groupOf.get(path) as string;
      const left = (sizes.get(root) ?? 0) - 1;
      if (left === 0) sizes.delete(root);
      else sizes.set(root, left);
    }
    const flatAfter = sizes.size === 1 && sizes.has(".");
    return flatBefore || flatAfter;
  }

  /** The deepest chosen root above `path`, else its top-level directory, else ".". */
  private rootOf(path: string): string {
    for (let slash = path.lastIndexOf("/"); slash > 0; slash = path.lastIndexOf("/", slash - 1)) {
      const dir = path.slice(0, slash);
      if (this.chosen.has(dir)) return dir;
    }
    return firstSegment(path) ?? ".";
  }

  private join(file: ScannedFile): string {
    const root = this.rootOf(file.path);
    let members = this.groups.get(root);
    if (members === undefined) {
      members = new Map();
      this.groups.set(root, members);
    }
    members.set(file.path, file);
    this.groupOf.set(file.path, root);
    return root;
  }

  private nameOf(root: string): string {
    if (root === "." && this.groups.size === 1) return this.manifest.packageNames["."] ?? FLAT_COMPONENT_NAME;
    return this.chosen.get(root) ?? (root === "." ? CONFIG_COMPONENT_NAME : root);
  }

  private setDrafts(root: string, drafts: ComponentDraft[]): void {
    for (const draft of this.draftsOf.get(root) ?? []) this.draftById.delete(draft.id);
    if (drafts.length === 0) this.draftsOf.delete(root);
    else this.draftsOf.set(root, drafts);
    for (const draft of drafts) this.draftById.set(draft.id, draft);
  }

  /** Splits one group again (rule 3); records ids that lost an existing member to another id. */
  private rebuildGroup(root: string, movedFrom: Set<string>): ComponentDraft[] {
    const members = this.groups.get(root);
    if (members === undefined || members.size === 0) {
      this.groups.delete(root);
      this.setDrafts(root, []);
      return [];
    }
    const parts = splitComponent(root, this.nameOf(root), [...members.values()]);
    const entries = this.manifest.entryPoints[root] ?? [];
    const drafts = parts.map((part) => toDraft(part, entryPointsFor(part, parts, entries)));
    for (const draft of drafts) {
      for (const path of draft.files) {
        const before = this.idOf.get(path);
        if (before !== undefined && before !== draft.id) movedFrom.add(before);
        this.idOf.set(path, draft.id);
      }
    }
    this.setDrafts(root, drafts);
    return drafts;
  }
}

/** Spec §5.2: every file lands in exactly one component. Output is sorted by root path. */
export function componentize(files: readonly ScannedFile[], manifest: WorkspaceManifest): ComponentDraft[] {
  return ComponentIndex.build(files, manifest).drafts();
}

/** Maps a member file path to its component id. */
export function componentOf(drafts: readonly ComponentDraft[]): (filePath: string) => string | undefined {
  const byPath = new Map<string, string>();
  for (const draft of drafts) {
    for (const file of draft.files) byPath.set(file, draft.id);
  }
  return (filePath) => byPath.get(filePath);
}
