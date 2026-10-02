/** A file the scan kept (spec §5.1). `hash` is the sha1 hex of the file's bytes. */
export interface ScannedFile {
  path: string;
  hash: string;
  size: number;
  language: string | null;
}

/** A file-level import that resolved to another repo file. Paths are repo-relative. */
export interface ImportEdge {
  from: string;
  to: string;
}

/** A file-level import of a package outside the repo, by package name. */
export interface ExternalImport {
  from: string;
  packageName: string;
}

/**
 * Workspace layout read from pnpm-workspace.yaml and package.json files. Keys of the records
 * are package directories; "." holds the root package.json name and description.
 */
export interface WorkspaceManifest {
  packageDirs: string[];
  appDirs: string[];
  packageNames: Record<string, string>;
  descriptions: Record<string, string>;
  entryPoints: Record<string, string[]>;
}

/** Root tsconfig `paths` and `baseUrl`; targets are relative to `baseUrl ?? "."`. */
export interface TsconfigPaths {
  paths: Record<string, string[]>;
  baseUrl: string | null;
}

export function emptyManifest(): WorkspaceManifest {
  return { packageDirs: [], appDirs: [], packageNames: {}, descriptions: {}, entryPoints: {} };
}
