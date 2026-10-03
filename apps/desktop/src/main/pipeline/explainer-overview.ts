import type { ComponentEdge, ExternalDep, Role } from "@jevcode/contracts";
import {
  ComponentIndex,
  type ComponentIndexChange,
  MAX_EDGE_EXAMPLES,
  MAX_EXAMPLE_LENGTH,
  MAX_PACKAGE_NAME_LENGTH,
  aggregateComponentEdges,
  aggregateExternals,
  capComponentEdges,
  clipText,
  compareText,
  componentOf,
  componentize,
  drainSteps,
  guessRole,
  guessRoles,
  rankExternals,
  type CappedEdges,
  type ComponentDraft,
  type ExternalImport,
  type ImportEdge,
  type ScannedFile,
  type TsconfigPaths,
  type WorkspaceManifest,
} from "@jevcode/codebase-map";
import type { ScanOptions, scanPaths, scanRepo } from "@jevcode/codebase-map/node";
import {
  languageForPath,
  probeCandidatesFor,
  probeFile,
  resolveSpecifier,
  type ExtractedImports,
  type ResolveContext,
  type extractImports,
} from "@jevcode/evidence-engine";

/** Spec §6.2: the narrator sees at most this many exported names per component. */
export const MAX_EXPORTS_PER_COMPONENT = 15;
/**
 * Work units of an incremental update, about a microsecond each: re-splitting a component group
 * costs WORK_PER_REGROUPED_FILE per member, re-resolving a file WORK_PER_SPECIFIER per import.
 * Above MAX_INCREMENTAL_WORK (a branch switch, a formatter run, an entry file every package
 * importer resolves to) the update is declined and the stage rebuilds in slices instead.
 */
export const WORK_PER_REGROUPED_FILE = 1;
export const WORK_PER_SPECIFIER = 3;
export const MAX_INCREMENTAL_WORK = 20_000;

/** Everything one scan learned, kept so a file change re-parses only that file (spec §5.1). */
export interface RepoModel {
  files: Map<string, ScannedFile>;
  /** Import scans of the files the parser reads (TS, TSX, JS, JSON). */
  imports: Map<string, ExtractedImports>;
  manifest: WorkspaceManifest;
  tsconfig: TsconfigPaths;
  partial: boolean;
  /** Repo files before the scan cap (ruling R3); only meaningful while `partial`. */
  totalFiles: number;
}

/** The rule-based overview: components, edges, externals, role guesses and exported names. */
export interface BuiltOverview {
  drafts: ComponentDraft[];
  roleGuess: ReadonlyMap<string, Role>;
  edges: ComponentEdge[];
  /** Component edges before the 1,000-edge cap (`counts.edges`). */
  totalEdges: number;
  externals: ExternalDep[];
  exportsByComponent: ReadonlyMap<string, readonly string[]>;
}

export interface ModelScanDeps {
  scan: typeof scanRepo;
  extract: typeof extractImports;
}

export interface ModelUpdateDeps {
  scanPaths: typeof scanPaths;
  extract: typeof extractImports;
}

function importVisitor(
  imports: Map<string, ExtractedImports>,
  extract: typeof extractImports,
): NonNullable<ScanOptions["visit"]> {
  return async (file, source) => {
    const language = languageForPath(file.path);
    if (language === null) {
      imports.delete(file.path);
      return;
    }
    try {
      imports.set(file.path, await extract(file.path, source, language));
    } catch {
      // A file the parser rejects contributes no edges; the scan goes on.
      imports.delete(file.path);
    }
  };
}

export async function scanRepoModel(
  repoRoot: string,
  deps: ModelScanDeps,
  options: Pick<ScanOptions, "signal" | "onProgress"> = {},
): Promise<RepoModel> {
  const imports = new Map<string, ExtractedImports>();
  const result = await deps.scan(repoRoot, { ...options, visit: importVisitor(imports, deps.extract) });
  return {
    files: new Map(result.files.map((file) => [file.path, file])),
    imports,
    manifest: result.manifest,
    tsconfig: result.tsconfig,
    partial: result.partial,
    totalFiles: result.totalFiles,
  };
}

/** Repo-relative paths one `applyFileChanges` added, removed or changed (content hash). */
export interface FileChanges {
  added: string[];
  removed: string[];
  edited: string[];
}

export function hasFileChanges(changes: FileChanges): boolean {
  return changes.added.length > 0 || changes.removed.length > 0 || changes.edited.length > 0;
}

/**
 * Re-reads and re-parses only `paths` and updates the model in place. Returns what changed:
 * files added, removed, or whose content hash changed. A partial model never grows past its cap.
 */
export async function applyFileChanges(
  repoRoot: string,
  model: RepoModel,
  paths: readonly string[],
  deps: ModelUpdateDeps,
): Promise<FileChanges> {
  const result = await deps.scanPaths(repoRoot, paths, { visit: importVisitor(model.imports, deps.extract) });
  const changes: FileChanges = { added: [], removed: [], edited: [] };
  for (const gone of result.gone) {
    if (model.files.delete(gone)) changes.removed.push(gone);
    model.imports.delete(gone);
  }
  for (const file of result.files) {
    const before = model.files.get(file.path);
    if (before === undefined && model.partial) {
      model.imports.delete(file.path);
      continue;
    }
    if (before === undefined) changes.added.push(file.path);
    else if (before.hash !== file.hash) changes.edited.push(file.path);
    model.files.set(file.path, file);
  }
  return changes;
}

/** Workspace package name → directory, for resolving `import "@scope/pkg"` to a repo file. */
export function workspacePackagesOf(manifest: WorkspaceManifest): Record<string, string> {
  const packages: Record<string, string> = {};
  for (const dir of [...manifest.packageDirs, ...manifest.appDirs]) {
    const name = manifest.packageNames[dir];
    if (name !== undefined) packages[name] = dir;
  }
  return packages;
}

export function buildOverview(model: RepoModel): BuiltOverview {
  const drafts = componentize([...model.files.values()], model.manifest);
  const ofFile = componentOf(drafts);
  const ctx: ResolveContext = {
    files: new Set(model.files.keys()),
    tsPaths: model.tsconfig.paths,
    baseUrl: model.tsconfig.baseUrl,
    workspacePackages: workspacePackagesOf(model.manifest),
  };
  const importEdges: ImportEdge[] = [];
  const externalImports: ExternalImport[] = [];
  const exportNames = new Map<string, Set<string>>();
  for (const [from, scan] of model.imports) {
    if (!model.files.has(from)) continue;
    for (const specifier of scan.specifiers) {
      const resolved = resolveSpecifier(from, specifier, ctx);
      if (resolved.kind === "file" && resolved.path !== from) importEdges.push({ from, to: resolved.path });
      else if (resolved.kind === "external") externalImports.push({ from, packageName: resolved.packageName });
    }
    const componentId = ofFile(from);
    if (componentId === undefined || scan.exports.length === 0) continue;
    const names = exportNames.get(componentId) ?? new Set<string>();
    for (const name of scan.exports) names.add(name);
    exportNames.set(componentId, names);
  }
  const externals = aggregateExternals(externalImports, ofFile);
  const edges = aggregateComponentEdges(importEdges, ofFile);
  return {
    drafts,
    roleGuess: new Map(drafts.map((draft) => [draft.id, guessRole(draft, externals)])),
    edges: edges.edges,
    totalEdges: edges.total,
    externals,
    exportsByComponent: new Map(
      [...exportNames.entries()].map(([id, names]) => [id, [...names].sort(compareText).slice(0, MAX_EXPORTS_PER_COMPONENT)]),
    ),
  };
}

/** What one file's imports resolved to, and which lookups decided it (evidence-engine `ResolveTrace`). */
interface FileLinks {
  /** Distinct repo files it imports, sorted, without itself. */
  targets: string[];
  /** Distinct external package names it imports. */
  packages: string[];
  probes: string[];
  under: string[];
}

/** One component's share of the overview: edges out by target component, package users, exports. */
interface ComponentLinks {
  out: Map<string, { count: number; examples: string[] }>;
  packages: Map<string, number>;
  exports: string[];
}

/** The answers of every traced lookup: the same for every file that made it, while the files do not change. */
interface LookupAnswers {
  probe: Map<string, string | null>;
  under: Map<string, string | null>;
}

function linksOf(from: string, scan: ExtractedImports, ctx: ResolveContext, answers: LookupAnswers): FileLinks {
  const probes = new Set<string>();
  const under = new Set<string>();
  const trace = {
    probe: (candidate: string, hit: string | null) => {
      probes.add(candidate);
      answers.probe.set(candidate, hit);
    },
    under: (dir: string, first: string | null) => {
      under.add(dir);
      answers.under.set(dir, first);
    },
  };
  const targets = new Set<string>();
  const packages = new Set<string>();
  for (const specifier of scan.specifiers) {
    const resolved = resolveSpecifier(from, specifier, ctx, trace);
    if (resolved.kind === "file" && resolved.path !== from) targets.add(resolved.path);
    else if (resolved.kind === "external") packages.add(resolved.packageName);
  }
  return { targets: [...targets].sort(compareText), packages: [...packages], probes: [...probes], under: [...under] };
}

function sameOut(a: ComponentLinks, b: ComponentLinks): boolean {
  if (a.out.size !== b.out.size) return false;
  for (const [to, edge] of a.out) {
    const other = b.out.get(to);
    if (other === undefined || other.count !== edge.count || other.examples.join("\n") !== edge.examples.join("\n")) return false;
  }
  return true;
}

function sameCounts(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, count] of a) {
    if (b.get(key) !== count) return false;
  }
  return true;
}

function addTo(index: Map<string, Set<string>>, keys: readonly string[], value: string): void {
  for (const key of keys) {
    const values = index.get(key);
    if (values === undefined) index.set(key, new Set([value]));
    else values.add(value);
  }
}

function removeFrom(index: Map<string, Set<string>>, keys: readonly string[], value: string, answers: Map<string, unknown>): void {
  for (const key of keys) {
    const values = index.get(key);
    if (values === undefined) continue;
    values.delete(value);
    if (values.size > 0) continue;
    index.delete(key);
    answers.delete(key);
  }
}

/**
 * `buildOverview` kept up to date file by file (spec §5.1, §6.1). Every file's resolved imports
 * are cached with the lookups that decided them and those lookups' answers; a change re-resolves
 * the changed files and the files whose lookups now answer differently (a probe that finds
 * another file, a package whose first member file changed), and recomputes the links of the
 * components those files belong to. `overview()` always equals `buildOverview(model)`.
 */
export class OverviewIndex {
  private readonly paths: Set<string>;
  private readonly workspacePackages: Record<string, string>;
  private readonly fileLinks = new Map<string, FileLinks>();
  /** Probe candidate → files whose resolution looked it up. */
  private readonly probeIndex = new Map<string, Set<string>>();
  /** Directory → files whose resolution took the first file under it. */
  private readonly underIndex = new Map<string, Set<string>>();
  private readonly answers: LookupAnswers = { probe: new Map(), under: new Map() };
  private readonly componentLinks = new Map<string, ComponentLinks>();
  /** The last `overview()` parts; update() marks what a change made stale. */
  private edges: CappedEdges | null = null;
  private externals: ExternalDep[] | null = null;
  private readonly roles = new Map<string, Role>();
  private staleRoles = new Set<string>();

  private constructor(
    readonly model: RepoModel,
    private components: ComponentIndex,
  ) {
    this.paths = new Set(model.files.keys());
    this.workspacePackages = workspacePackagesOf(model.manifest);
  }

  static build(model: RepoModel): OverviewIndex {
    return drainSteps(OverviewIndex.steps(model));
  }

  /** The full build as steps of a few milliseconds each, for `runSliced`. */
  static *steps(model: RepoModel, every = 200): Generator<void, OverviewIndex> {
    const components = yield* ComponentIndex.steps([...model.files.values()], model.manifest);
    const index = new OverviewIndex(model, components);
    const ctx = index.context();
    let count = 0;
    for (const [from, scan] of model.imports) {
      if (!model.files.has(from)) continue;
      index.link(from, linksOf(from, scan, ctx, index.answers));
      if ((count += 1) % every === 0) yield;
    }
    for (const draft of components.drafts()) {
      index.componentLinks.set(draft.id, index.linksOfComponent(draft));
      if ((count += 1) % 20 === 0) yield;
    }
    return index;
  }

  /**
   * Applies changes `applyFileChanges` already made to the model. Returns false, changing
   * nothing, when they alter the component structure (chosen roots, a flat repo's name) or their
   * work exceeds MAX_INCREMENTAL_WORK: the caller then builds a new index in slices.
   */
  update(changes: FileChanges): boolean {
    const upserts = [...changes.added, ...changes.edited]
      .map((path) => this.model.files.get(path))
      .filter((file): file is ScannedFile => file !== undefined);
    const plan = this.components.plan(upserts, changes.removed);
    if (plan === null) return false;
    for (const path of changes.removed) this.paths.delete(path);
    for (const path of changes.added) this.paths.add(path);

    const added = new Set(changes.added);
    const redo = new Set([...changes.added, ...changes.edited]);
    const asked = new Set<string>();
    for (const path of [...changes.added, ...changes.removed]) {
      for (const candidate of probeCandidatesFor(path)) {
        const dependents = this.probeIndex.get(candidate);
        if (dependents === undefined || asked.has(candidate)) continue;
        asked.add(candidate);
        if (probeFile(candidate, this.paths) !== this.answers.probe.get(candidate)) {
          for (const from of dependents) redo.add(from);
        }
      }
      for (let slash = path.lastIndexOf("/"); slash > 0; slash = path.lastIndexOf("/", slash - 1)) {
        const dir = path.slice(0, slash);
        const dependents = this.underIndex.get(dir);
        if (dependents === undefined) continue;
        // The smallest path under `dir` changes only when an added path sorts before it or it is removed.
        const first = this.answers.under.get(dir) ?? null;
        if (added.has(path) ? first === null || path < first : path === first) {
          for (const from of dependents) redo.add(from);
        }
      }
    }
    for (const path of changes.removed) redo.delete(path);
    let work = plan.files * WORK_PER_REGROUPED_FILE;
    for (const from of redo) work += (this.model.imports.get(from)?.specifiers.length ?? 0) * WORK_PER_SPECIFIER;
    if (work > MAX_INCREMENTAL_WORK) {
      for (const path of changes.added) this.paths.delete(path);
      for (const path of changes.removed) this.paths.add(path);
      return false;
    }

    const change = this.components.apply(upserts, changes.removed) as ComponentIndexChange;
    for (const path of changes.removed) this.unlink(path);
    const dirty = new Set(change.changed);
    const ctx = this.context();
    for (const from of redo) {
      this.unlink(from);
      const scan = this.model.imports.get(from);
      if (this.model.files.has(from) && scan !== undefined) this.link(from, linksOf(from, scan, ctx, this.answers));
      const id = this.components.componentOf(from);
      if (id !== undefined) dirty.add(id);
    }
    // Files that moved to another component: every component with an edge into their old one.
    const stale = new Set([...change.movedFrom, ...change.removed]);
    if (stale.size > 0) {
      for (const [id, links] of this.componentLinks) {
        if ([...links.out.keys()].some((target) => stale.has(target))) dirty.add(id);
      }
    }
    for (const id of dirty) {
      const before = this.componentLinks.get(id);
      const draft = this.components.draft(id);
      const after = draft === undefined ? undefined : this.linksOfComponent(draft);
      if (after === undefined) {
        this.componentLinks.delete(id);
        this.roles.delete(id);
      } else {
        this.componentLinks.set(id, after);
        this.staleRoles.add(id);
      }
      if (before === undefined || after === undefined || !sameOut(before, after)) this.edges = null;
      if (before === undefined || after === undefined || !sameCounts(before.packages, after.packages)) this.externals = null;
    }
    return true;
  }

  /** The overview of the current model; recomputes only the parts the last updates made stale. */
  overview(): BuiltOverview {
    const drafts = this.components.drafts();
    if (this.edges === null) {
      const edges: ComponentEdge[] = [];
      for (const [from, links] of this.componentLinks) {
        for (const [to, edge] of links.out) edges.push({ from, to, count: edge.count, examples: [...edge.examples] });
      }
      this.edges = capComponentEdges(edges);
    }
    if (this.externals === null) {
      const byName = new Map<string, Map<string, number>>();
      for (const [id, links] of this.componentLinks) {
        for (const [name, count] of links.packages) {
          const users = byName.get(name);
          if (users === undefined) byName.set(name, new Map([[id, count]]));
          else users.set(id, count);
        }
      }
      this.externals = rankExternals(byName);
      // Roles read the externals list, so every role is stale.
      this.roles.clear();
      for (const [id, role] of guessRoles(drafts, this.externals)) this.roles.set(id, role);
      this.staleRoles.clear();
    }
    for (const id of this.staleRoles) {
      const draft = this.components.draft(id);
      if (draft !== undefined) this.roles.set(id, guessRole(draft, this.externals));
    }
    this.staleRoles = new Set();
    const exportsByComponent = new Map<string, readonly string[]>();
    for (const [id, links] of this.componentLinks) {
      if (links.exports.length > 0) exportsByComponent.set(id, links.exports);
    }
    return {
      drafts,
      roleGuess: new Map(drafts.map((draft) => [draft.id, this.roles.get(draft.id) as Role])),
      edges: this.edges.edges,
      totalEdges: this.edges.total,
      externals: this.externals,
      exportsByComponent,
    };
  }

  /** A new context per build or update: evidence-engine caches first-file lookups per context. */
  private context(): ResolveContext {
    return {
      files: this.paths,
      tsPaths: this.model.tsconfig.paths,
      baseUrl: this.model.tsconfig.baseUrl,
      workspacePackages: this.workspacePackages,
    };
  }

  private link(from: string, links: FileLinks): void {
    this.fileLinks.set(from, links);
    addTo(this.probeIndex, links.probes, from);
    addTo(this.underIndex, links.under, from);
  }

  private unlink(from: string): void {
    const links = this.fileLinks.get(from);
    if (links === undefined) return;
    this.fileLinks.delete(from);
    removeFrom(this.probeIndex, links.probes, from, this.answers.probe);
    removeFrom(this.underIndex, links.under, from, this.answers.under);
  }

  /** `aggregateEdges`, `aggregateExternals` and the export list restricted to one component. */
  private linksOfComponent(draft: ComponentDraft): ComponentLinks {
    const out = new Map<string, { count: number; examples: string[] }>();
    const packages = new Map<string, number>();
    const names = new Set<string>();
    for (const from of draft.files) {
      const links = this.fileLinks.get(from);
      if (links === undefined) continue;
      for (const target of links.targets) {
        const to = this.components.componentOf(target);
        if (to === undefined || to === draft.id) continue;
        let edge = out.get(to);
        if (edge === undefined) {
          edge = { count: 0, examples: [] };
          out.set(to, edge);
        }
        edge.count += 1;
        if (edge.examples.length < MAX_EDGE_EXAMPLES) edge.examples.push(clipText(`${from} → ${target}`, MAX_EXAMPLE_LENGTH));
      }
      for (const name of links.packages) {
        if (name.length === 0 || name.length > MAX_PACKAGE_NAME_LENGTH) continue;
        packages.set(name, (packages.get(name) ?? 0) + 1);
      }
      for (const name of this.model.imports.get(from)?.exports ?? []) names.add(name);
    }
    return { out, packages, exports: [...names].sort(compareText).slice(0, MAX_EXPORTS_PER_COMPONENT) };
  }
}

/** Lets queued callbacks (agent events, I/O) run before the stage goes on (spec §6.1). */
export function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Runs `steps` on the main thread in slices: after a step that ends a slice of `sliceMs`, it
 * yields to the event loop (setImmediate), so agent events queued meanwhile are ingested
 * (spec §6.1). Returns null, without finishing, once `cancelled()` is true after a yield.
 */
export async function runSliced<T>(
  steps: Generator<void, T>,
  options: { sliceMs: number; cancelled?: () => boolean; now?: () => number },
): Promise<{ value: T; yielded: boolean } | null> {
  const now = options.now ?? (() => performance.now());
  let started = now();
  let yielded = false;
  for (;;) {
    const next = steps.next();
    if (next.done === true) return { value: next.value, yielded };
    if (now() - started < options.sliceMs) continue;
    await nextTurn();
    yielded = true;
    if (options.cancelled?.() === true) {
      steps.return(undefined as never);
      return null;
    }
    started = now();
  }
}

