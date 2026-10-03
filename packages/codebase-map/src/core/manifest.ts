import { compareText, dirnameOf, normalizePath } from "./paths.js";
import type { TsconfigPaths, WorkspaceManifest } from "./types.js";

/**
 * Raw cap on a package.json description. The narrator redacts the whole text first and only then
 * clips it to 600 characters (spec §6.2), so a secret straddling character 600 is still caught.
 */
export const MAX_DESCRIPTION_CHARS = 4_000;
const MAX_ENTRY_POINTS = 8;
const MAX_EXPORT_DEPTH = 4;
const BUILT_OUTPUT = /^(.*?)\/(?:dist|build|out)\/(.+?)\.(?:c|m)?js$/;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js"];
const PROBE_EXTENSIONS = [".ts", ".tsx", ".js", "/index.ts", "/index.js"];
const APP_ENTRY_CANDIDATES = [
  "src/main.ts", "src/main.tsx", "src/index.ts", "src/index.tsx", "src/main/index.ts", "index.ts", "index.js", "main.ts", "main.js",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unquote(value: string): string {
  return value.trim().replace(/^(['"])(.*)\1$/, "$2");
}

/** JSON with // and /* comments and trailing commas, as tsconfig files allow. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    const next = text.charAt(i + 1);
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next;
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text.charAt(i) !== "\n") i += 1;
      out += "\n";
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** The `packages:` list of pnpm-workspace.yaml (block or flow style). */
export function parsePnpmWorkspace(text: string): string[] {
  const globs: string[] = [];
  let inPackages = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const header = /^packages\s*:\s*(.*)$/.exec(line);
    if (header !== null) {
      const inline = (header[1] ?? "").trim();
      inPackages = inline === "";
      if (inline.startsWith("[")) globs.push(...inline.replace(/^\[|\]$/g, "").split(",").map(unquote));
      continue;
    }
    if (/^\S/.test(line) && !line.startsWith("-")) {
      inPackages = false;
      continue;
    }
    const item = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (inPackages && item !== null) globs.push(unquote(item[1] ?? ""));
  }
  return globs.filter((glob) => glob !== "");
}

/** `workspaces` of a root package.json: an array, or `{ packages: [...] }` (yarn). */
export function workspaceGlobs(rootPackageJson: unknown): string[] {
  if (!isRecord(rootPackageJson)) return [];
  const field = rootPackageJson["workspaces"];
  const list = Array.isArray(field) ? field : isRecord(field) && Array.isArray(field["packages"]) ? field["packages"] : [];
  return list.filter((entry): entry is string => typeof entry === "string" && entry !== "");
}

/** `*` matches one path segment, `**` any number (a trailing `/**` also matches the directory itself), `?` one character. */
export function globToRegExp(glob: string): RegExp {
  const clean = glob.replace(/^\.\//, "").replace(/\/+$/, "");
  let source = "";
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean.charAt(i);
    if (ch === "/" && clean.slice(i) === "/**") {
      source += "(?:/.*)?";
      break;
    }
    if (ch === "*" && clean.charAt(i + 1) === "*") {
      const slash = clean.charAt(i + 2) === "/";
      source += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (ch === "*") {
      source += "[^/]*";
    } else if (ch === "?") {
      source += "[^/]";
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function readJson(texts: ReadonlyMap<string, string>, path: string): unknown {
  const text = texts.get(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function stringLeaves(value: unknown, depth: number, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (depth < MAX_EXPORT_DEPTH && Array.isArray(value)) for (const item of value) stringLeaves(item, depth + 1, out);
  else if (depth < MAX_EXPORT_DEPTH && isRecord(value)) for (const item of Object.values(value)) stringLeaves(item, depth + 1, out);
}

function resolveEntry(dir: string, value: string, files: ReadonlySet<string>): string | null {
  const rel = normalizePath(`${dir}/${value}`);
  if (rel === null || rel === "") return null;
  if (files.has(rel)) return rel;
  const built = BUILT_OUTPUT.exec(rel);
  if (built !== null) {
    for (const extension of SOURCE_EXTENSIONS) {
      const candidate = `${built[1] ?? ""}/src/${built[2] ?? ""}${extension}`;
      if (files.has(candidate)) return candidate;
    }
  }
  for (const extension of PROBE_EXTENSIONS) {
    if (files.has(`${rel}${extension}`)) return `${rel}${extension}`;
  }
  return null;
}

/** Package `main`, `exports` and `bin`, mapped to tracked files; `dist/x.js` maps to `src/x.ts`. */
function entryPointsFor(dir: string, json: unknown, files: ReadonlySet<string>, isApp: boolean): string[] {
  const raw: string[] = [];
  if (isRecord(json)) {
    stringLeaves(json["main"], MAX_EXPORT_DEPTH, raw);
    stringLeaves(json["exports"], 0, raw);
    stringLeaves(json["bin"], MAX_EXPORT_DEPTH - 1, raw);
  }
  const out: string[] = [];
  for (const value of raw) {
    const resolved = resolveEntry(dir, value, files);
    if (resolved !== null && !out.includes(resolved)) out.push(resolved);
    if (out.length >= MAX_ENTRY_POINTS) break;
  }
  if (out.length === 0 && isApp) {
    const candidate = APP_ENTRY_CANDIDATES.map((entry) => `${dir}/${entry}`).find((entry) => files.has(entry));
    if (candidate !== undefined) out.push(candidate);
  }
  return out;
}

/**
 * Spec §5.2 rule 1. `paths` are the scanned files; `texts` holds the contents of every
 * package.json and of pnpm-workspace.yaml. Workspace packages are directories with a
 * package.json that matches a workspace glob; app directories are `apps/*` with any file.
 */
export function buildManifest(paths: readonly string[], texts: ReadonlyMap<string, string>): WorkspaceManifest {
  const files = new Set(paths);
  const workspaceText = texts.get("pnpm-workspace.yaml");
  const globs = [
    ...(workspaceText === undefined ? [] : parsePnpmWorkspace(workspaceText)),
    ...workspaceGlobs(readJson(texts, "package.json")),
  ];
  const include = globs.filter((glob) => !glob.startsWith("!")).map(globToRegExp);
  const exclude = globs.filter((glob) => glob.startsWith("!")).map((glob) => globToRegExp(glob.slice(1)));
  const appDirs = [
    ...new Set(paths.filter((path) => path.startsWith("apps/") && path.split("/").length >= 3).map((path) => path.split("/").slice(0, 2).join("/"))),
  ].sort(compareText);
  const apps = new Set(appDirs);
  const packageDirs = [
    ...new Set(paths.filter((path) => path.endsWith("/package.json")).map((path) => dirnameOf(path))),
  ]
    .filter((dir) => !apps.has(dir) && include.some((glob) => glob.test(dir)) && !exclude.some((glob) => glob.test(dir)))
    .sort(compareText);

  const packageNames: Record<string, string> = {};
  const descriptions: Record<string, string> = {};
  const entryPoints: Record<string, string[]> = {};
  for (const dir of [".", ...packageDirs, ...appDirs]) {
    const json = readJson(texts, dir === "." ? "package.json" : `${dir}/package.json`);
    if (isRecord(json)) {
      const name = json["name"];
      const description = json["description"];
      if (typeof name === "string" && name.trim() !== "") packageNames[dir] = name.trim();
      if (typeof description === "string" && description.trim() !== "") descriptions[dir] = description.trim().slice(0, MAX_DESCRIPTION_CHARS);
    }
    if (dir === ".") continue;
    const entries = entryPointsFor(dir, json, files, apps.has(dir));
    if (entries.length > 0) entryPoints[dir] = entries;
  }
  return { packageDirs, appDirs, packageNames, descriptions, entryPoints };
}

/**
 * Root tsconfig `paths` and `baseUrl`, following relative `extends` between root-level files.
 * The nearer file wins. Targets stay relative to `baseUrl` (or the repo root when it is unset).
 */
export function tsconfigFromTexts(texts: ReadonlyMap<string, string>): TsconfigPaths {
  let paths: Record<string, string[]> | null = null;
  let baseUrl: string | null | undefined;
  const seen = new Set<string>();
  let file: string | null = "tsconfig.json";
  while (file !== null && !seen.has(file) && seen.size < 5) {
    seen.add(file);
    const text = texts.get(file);
    if (text === undefined) break;
    let json: unknown;
    try {
      json = parseJsonc(text);
    } catch {
      break;
    }
    if (!isRecord(json)) break;
    const options = isRecord(json["compilerOptions"]) ? json["compilerOptions"] : {};
    const dir = dirnameOf(file);
    const base = options["baseUrl"];
    if (baseUrl === undefined && typeof base === "string") {
      const resolved = normalizePath(dir === "" ? base : `${dir}/${base}`);
      baseUrl = resolved === null ? null : resolved === "" ? "." : resolved;
    }
    const mapping = options["paths"];
    if (paths === null && isRecord(mapping)) {
      paths = {};
      for (const [pattern, targets] of Object.entries(mapping)) {
        if (Array.isArray(targets)) paths[pattern] = targets.filter((target): target is string => typeof target === "string");
      }
    }
    const parent = json["extends"];
    if (typeof parent === "string" && parent.startsWith(".")) {
      const target = parent.endsWith(".json") ? parent : `${parent}.json`;
      file = normalizePath(dir === "" ? target : `${dir}/${target}`);
    } else {
      file = null;
    }
  }
  return { paths: paths ?? {}, baseUrl: baseUrl ?? null };
}
