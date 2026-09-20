import { promises as fsp } from "node:fs";
import path from "node:path";

export interface RepoContext {
  fileCount: number;
  totalBytes: number;
  languages: string[];
}

const SKIPPED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  ".venv",
  "vendor",
  "__pycache__",
]);

const MAX_FILES = 20_000;
const MAX_BYTES = 512 * 1024 * 1024;

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".rb": "ruby",
  ".php": "php",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".swift": "swift",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".scala": "scala",
  ".sh": "shell",
  ".bash": "shell",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".md": "markdown",
  ".css": "css",
  ".scss": "css",
  ".html": "html",
  ".vue": "vue",
  ".sql": "sql",
  ".proto": "protobuf",
  ".graphql": "graphql",
  ".zig": "zig",
};

/**
 * Cheap repo shape derivation for model selection: walks the tree skipping
 * vendored/build dirs, counts files, sums sizes, and tallies languages from
 * extensions. Capped at MAX_FILES/MAX_BYTES so huge repos stay bounded.
 */
export async function deriveRepoContext(repoPath: string): Promise<RepoContext> {
  let fileCount = 0;
  let totalBytes = 0;
  const languageCounts = new Map<string, number>();
  const pending: string[] = [repoPath];

  while (pending.length > 0 && fileCount < MAX_FILES && totalBytes < MAX_BYTES) {
    const dir = pending.pop();
    if (dir === undefined) break;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) pending.push(full);
      } else if (entry.isFile()) {
        fileCount += 1;
        try {
          const stat = await fsp.stat(full);
          totalBytes += stat.size;
        } catch {
          // unreadable files are skipped for the size tally only
        }
        const language = LANGUAGE_BY_EXT[path.extname(entry.name).toLowerCase()];
        if (language !== undefined) {
          languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
        }
      }
    }
  }

  const languages = [...languageCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);
  return { fileCount, totalBytes, languages };
}
