// Pure path, language and file-kind helpers shared by the cut rules, the role rules and the
// snapshot. Paths are repo-relative with "/" separators. Comparisons use UTF-16 code unit
// order (never localeCompare), so output is identical on every machine.

/**
 * Languages whose import statements the evidence-engine parser reads (spec E14). The parser
 * also accepts JSON, which has no imports, so a JSON-only component is not analyzed.
 */
export const IMPORT_LANGUAGES: ReadonlySet<string> = new Set(["TypeScript", "JavaScript"]);

/** Data and prose languages; a component's main language prefers code over these. */
const NON_CODE_LANGUAGES: ReadonlySet<string> = new Set(["Markdown", "JSON", "YAML", "TOML"]);

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript",
  ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
  ".json": "JSON", ".py": "Python", ".go": "Go", ".rs": "Rust", ".java": "Java",
  ".kt": "Kotlin", ".kts": "Kotlin", ".swift": "Swift", ".rb": "Ruby", ".c": "C", ".h": "C",
  ".cc": "C++", ".cpp": "C++", ".cxx": "C++", ".hpp": "C++", ".cs": "C#", ".php": "PHP",
  ".md": "Markdown", ".mdx": "Markdown", ".yaml": "YAML", ".yml": "YAML", ".toml": "TOML",
  ".css": "CSS", ".scss": "CSS", ".html": "HTML", ".sh": "Shell", ".bash": "Shell", ".zsh": "Shell",
  ".sql": "SQL", ".vue": "Vue", ".svelte": "Svelte",
};

const TEST_DIR_NAMES: ReadonlySet<string> = new Set(["test", "tests", "__tests__"]);
const CONFIG_FILE_NAMES: ReadonlySet<string> = new Set([
  "package.json", "pnpm-workspace.yaml", ".gitignore", ".gitattributes", ".editorconfig", ".nvmrc",
  ".node-version", "Makefile", "Dockerfile", "docker-compose.yml", "docker-compose.yaml",
]);

export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isUnder(path: string, dir: string): boolean {
  return path.startsWith(`${dir}/`);
}

export function dirnameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

export function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function languageOf(path: string): string | null {
  const base = basenameOf(path).toLowerCase();
  const dot = base.lastIndexOf(".");
  if (dot === -1) return null;
  return LANGUAGE_BY_EXTENSION[base.slice(dot)] ?? null;
}

/** `*.test.*`, `*.spec.*`, or any file under a `test/`, `tests/` or `__tests__/` directory (spec §5.2 rule 4). */
export function isTestPath(path: string): boolean {
  const segments = path.split("/");
  const base = segments[segments.length - 1] ?? "";
  if (/\.(test|spec)\.[^/]+$/.test(base)) return true;
  return segments.slice(0, -1).some((segment) => TEST_DIR_NAMES.has(segment));
}

/** Build, lint, editor and package configuration files (spec §5.4 rule 5). */
export function isConfigFile(path: string): boolean {
  const base = basenameOf(path);
  return (
    CONFIG_FILE_NAMES.has(base) ||
    /\.config\.[^/]+$/.test(base) ||
    /^tsconfig(\..+)?\.json$/.test(base) ||
    /^\.[a-z]+rc(\.(json|js|cjs|mjs|yaml|yml))?$/i.test(base)
  );
}

export function countLanguages(languages: readonly (string | null)[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const language of languages) {
    if (language !== null) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return counts;
}

/** Most frequent code language, else the most frequent language; ties go to the smaller name. */
export function mainLanguage(counts: ReadonlyMap<string, number>): string | null {
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]));
  const code = ranked.find(([language]) => !NON_CODE_LANGUAGES.has(language));
  return (code ?? ranked[0])?.[0] ?? null;
}

/** Cuts `text` to at most `max` UTF-16 units with a trailing ellipsis, never splitting a surrogate pair. */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max - 1);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", "dist", "build", "out", ".next", "coverage", "vendor", ".git"]);
const GENERATED_FILES: ReadonlySet<string> = new Set([
  "pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "bun.lockb",
  "Cargo.lock", "poetry.lock", "Gemfile.lock", "composer.lock", "go.sum",
]);
const GENERATED_SUFFIX = /\.(min\.js|min\.css|map|snap)$/i;
const BINARY_EXTENSION =
  /\.(png|jpe?g|gif|webp|bmp|ico|icns|tiff?|psd|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|wasm|node|so|dylib|dll|exe|bin|o|a|class|pyc|woff2?|ttf|otf|eot|mp3|mp4|m4a|mov|avi|wav|ogg|webm|flac|sqlite3?|db)$/i;
const SECRET_NAME =
  /^(\.env(\..+)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.envrc|\.npmrc|\.pypirc|\.netrc|\.htpasswd|\.git-credentials|credentials(\.json)?|service-account.*\.json|.+\.(pem|key|p8|p12|pfx|jks|keystore|asc|gpg|tfvars))$/i;
const SECRET_TEMPLATE = /^\.env\.(example|sample|template)$/i;

/** Interfaces §8.1 K-2: snapshot paths are 1–1,024 characters, so a longer path is never mapped. */
export const MAX_PATH_LENGTH = 1_024;

/**
 * Spec §5.1 and §10: dependency and build output directories, lockfiles and minified or
 * generated files, binaries by extension, and secret-like files are never read or mapped.
 * Paths over 1,024 characters are skipped too, so one cannot fail the whole snapshot row.
 */
export function isSkippedPath(path: string): boolean {
  if (path.length > MAX_PATH_LENGTH) return true;
  const segments = path.split("/");
  if (segments.slice(0, -1).some((segment) => SKIP_DIRS.has(segment))) return true;
  const base = segments[segments.length - 1] ?? "";
  if (GENERATED_FILES.has(base) || GENERATED_SUFFIX.test(base) || BINARY_EXTENSION.test(base)) return true;
  return SECRET_NAME.test(base) && !SECRET_TEMPLATE.test(base);
}

/** Resolves "." and ".." segments. Returns null for absolute paths and paths that leave the root; "" is the root. */
export function normalizePath(path: string): string | null {
  if (path.startsWith("/")) return null;
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}
