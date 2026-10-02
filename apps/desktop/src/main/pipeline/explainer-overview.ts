import type { ComponentEdge, ExternalDep, Role } from "@jevcode/contracts";
import {
  aggregateComponentEdges,
  aggregateExternals,
  compareText,
  componentOf,
  componentize,
  guessRole,
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
  resolveSpecifier,
  type ExtractedImports,
  type ResolveContext,
  type extractImports,
} from "@jevcode/evidence-engine";

/** Spec §6.2: the narrator sees at most this many exported names per component. */
export const MAX_EXPORTS_PER_COMPONENT = 15;

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

/**
 * Re-reads and re-parses only `paths` and updates the model in place. Returns false when no
 * file was added, removed or changed its content hash. A partial model never grows past its cap.
 */
export async function applyFileChanges(
  repoRoot: string,
  model: RepoModel,
  paths: readonly string[],
  deps: ModelUpdateDeps,
): Promise<boolean> {
  const result = await deps.scanPaths(repoRoot, paths, { visit: importVisitor(model.imports, deps.extract) });
  let changed = false;
  for (const gone of result.gone) {
    if (model.files.delete(gone)) changed = true;
    model.imports.delete(gone);
  }
  for (const file of result.files) {
    const before = model.files.get(file.path);
    if (before === undefined && model.partial) {
      model.imports.delete(file.path);
      continue;
    }
    if (before === undefined || before.hash !== file.hash) changed = true;
    model.files.set(file.path, file);
  }
  return changed;
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
