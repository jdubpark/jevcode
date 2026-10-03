#!/usr/bin/env node
// Writes fixtures/overview-jevcode.json (with narrator text) and fixtures/overview-jevcode-rule.json (rule-based,
// narrative null): a snapshot of this repository for the dev host and the Map fixture test (lane 06, P-5).
// Components come from the curated table below rather than lane 04's cut rules, so the fixture is stable and shows
// every band; run with --check to verify the committed fixtures; files, blob hashes, import edges and external packages come from `git ls-files -s` and the files.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(PKG, "../..");
const OUT = path.join(PKG, "fixtures");
const MAX_BYTES = 512 * 1024;
/** A constant, so regenerating on the same tree is byte-identical across commits, machines and time zones. */
const GENERATED_AT = "2026-10-02T00:00:00.000Z";
const sha1 = (text) => createHash("sha1").update(text).digest("hex");
const idOf = (rootPath) => `cmp_${sha1(rootPath).slice(0, 12)}`;

/** [rootPath, name, role, purpose (≤ 140 chars)]. The longest matching rootPath owns a file; "." owns repo-root files only. */
const COMPONENTS = [
  ["apps/desktop/src/renderer", "desktop renderer", "ui", "Main window: workspace, composer, surfaces and the embedded trace viewer."],
  ["apps/trace-viewer-dev", "trace-viewer-dev", "ui", "Dev host that loads trace bundles into the viewer for smoke tests."],
  ["packages/trace-viewer/src/ui", "trace-viewer ui", "ui", "Trace viewer views, Inspector, shell and keyboard layer."],
  ["packages/ui-catalog", "ui-catalog", "ui", "Generative UI components rendered from json-render specs."],
  ["packages/ui-compiler", "ui-compiler", "ui", "Compiles surface decisions into json-render UI specs."],
  ["apps/desktop/src/main", "desktop main", "api", "Electron main process: IPC handlers, sessions and the event pipeline."],
  ["apps/desktop", "desktop shell", "api", "Preload bridge, shared IPC types and the app build config."],
  ["packages/agent-codex", "agent-codex", "agent", "Runs Codex as a child process and normalizes its JSON events."],
  ["packages/agent-core", "agent-core", "agent", "Agent adapter interface and session lifecycle shared by adapters."],
  ["packages/jev-router", "jev-router", "agent", "Routes Jev questions to the model through a typed client with guardrails."],
  ["packages/contracts", "contracts", "domain", "Zod schemas and types for events, IPC and trace bundles."],
  ["packages/semantic-core", "semantic-core", "domain", "Groups evidence into change units, decisions and validations."],
  ["packages/evidence-engine", "evidence-engine", "domain", "Watches the repo and parses files into evidence facts."],
  ["packages/codebase-map", "codebase-map", "domain", "Cuts the repository into components, edges and roles for the Map."],
  ["packages/trace-viewer/src/model", "trace-viewer model", "domain", "Folds trace rows into turns, steps, chapters and findings."],
  ["packages/trace-viewer/src/layout", "trace-viewer layout", "domain", "Pure layouts for the Canvas, the Hybrid spine and the Map."],
  ["packages/trace-viewer", "trace-viewer", "domain", "Package entry, sources and test support for the trace viewer."],
  ["packages/telemetry", "telemetry", "domain", "Collects local timing and count metrics for the pipeline."],
  ["packages/storage", "storage", "storage", "SQLite event store, migrations and the trace reader."],
  ["evals", "evals", "tests", "Scenario playback and metrics for Jev decision quality."],
  ["scripts", "scripts", "tooling", "Repository maintenance and verification scripts."],
  [".", "config", "config", "Workspace, TypeScript, ESLint and editor configuration."],
];
/** [sentence (≤ 220 chars), cited rootPaths]. */
const NARRATIVE = [
  ["jevcode is an Electron app: desktop main and desktop renderer supervise a coding agent and explain its work.", ["apps/desktop/src/main", "apps/desktop/src/renderer"]],
  ["desktop main runs Codex through agent-codex and feeds its events to evidence-engine and semantic-core.", ["apps/desktop/src/main", "packages/agent-codex", "packages/evidence-engine", "packages/semantic-core"]],
  ["Every event lands in storage, and trace-viewer model reads it back as rows.", ["packages/storage", "packages/trace-viewer/src/model"]],
  ["jev-router sends Jev's questions to the model and checks the answers against a schema.", ["packages/jev-router"]],
  ["contracts holds the shared schemas that every package imports.", ["packages/contracts"]],
  ["config holds the TypeScript, ESLint and pnpm workspace setup.", ["."]],
];
const SKIP = /^(docs|fixtures|\.superpowers)\/|^packages\/trace-viewer\/fixtures\/|(^|\/)(node_modules|dist|build|out|\.next|coverage|vendor)\//;
const BINARY = /\.(png|jpe?g|gif|webp|ico|wasm|db|sqlite|pdf|zip|gz|woff2?|ttf)$/i;
const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;
const LANGUAGES = [
  [/\.(ts|tsx|mts|cts)$/, "TypeScript"],
  [/\.(js|mjs|cjs|jsx)$/, "JavaScript"],
  [/\.jsonc?$/, "JSON"],
  [/\.css$/, "CSS"],
  [/\.html$/, "HTML"],
  [/\.ya?ml$/, "YAML"],
  [/\.md$/, "Markdown"],
];
const BUILTINS = new Set(builtinModules);
const SPECIFIER = /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm;
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const git = (...args) => execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const languageOf = (file) => LANGUAGES.find(([pattern]) => pattern.test(file))?.[1] ?? null;

function ownerOf(file) {
  let best = null;
  for (const component of COMPONENTS) {
    const root = component[0];
    const fits = root === "." ? !file.includes("/") : file === root || file.startsWith(`${root}/`);
    if (fits && (best === null || root.length > best[0].length)) best = component;
  }
  return best;
}

function trackedFiles() {
  const files = [];
  for (const line of git("ls-files", "-s").split("\n")) {
    const match = /^\d+ ([0-9a-f]{40}) \d\t(.+)$/.exec(line);
    if (match === null) continue;
    const [, hash, file] = match;
    if (SKIP.test(file) || BINARY.test(file)) continue;
    if (statSync(path.join(REPO, file)).size > 1024 * 1024) continue;
    files.push({ path: file, hash });
  }
  return files.sort((a, b) => byText(a.path, b.path));
}

function workspacePackages() {
  const out = new Map();
  for (const file of git("ls-files", "packages/*/package.json", "apps/*/package.json", "evals/package.json").split("\n")) {
    if (file === "") continue;
    out.set(JSON.parse(readFileSync(path.join(REPO, file), "utf8")).name, path.posix.dirname(file));
  }
  return out;
}

function resolve(from, specifier, files, workspace) {
  const spec = specifier.split("?")[0];
  if (spec.startsWith(".")) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
    const stem = base.replace(/\.(js|mjs|cjs|jsx)$/, "");
    for (const candidate of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.mjs`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`]) {
      if (files.has(candidate)) return { kind: "file", path: candidate };
    }
    return { kind: "unresolved" };
  }
  if (spec.startsWith("node:") || BUILTINS.has(spec.split("/")[0])) return { kind: "builtin" };
  const parts = spec.split("/");
  const scoped = spec.startsWith("@");
  const name = scoped ? parts.slice(0, 2).join("/") : parts[0];
  const dir = workspace.get(name);
  if (dir === undefined) return { kind: "external", name };
  const sub = parts.slice(scoped ? 2 : 1).join("/");
  const candidates = sub === "" ? [`${dir}/src/index.ts`, `${dir}/src/index.tsx`] : [`${dir}/src/${sub}/index.ts`, `${dir}/src/${sub}.ts`, `${dir}/src/${sub}.tsx`];
  for (const candidate of candidates) if (files.has(candidate)) return { kind: "file", path: candidate };
  return { kind: "file", path: `${dir}/package.json` };
}

function build(narrated) {
  const tracked = trackedFiles();
  const fileSet = new Set(tracked.map((file) => file.path));
  const workspace = workspacePackages();
  const members = new Map(COMPONENTS.map(([root]) => [root, []]));
  let unowned = 0;
  for (const file of tracked) {
    const owner = ownerOf(file.path);
    if (owner === null) unowned += 1;
    else members.get(owner[0]).push(file);
  }
  const edges = new Map();
  const externals = new Map();
  const perComponent = new Map();
  for (const [root, list] of members) {
    for (const file of list) {
      if (!CODE.test(file.path)) continue;
      const source = readFileSync(path.join(REPO, file.path), "utf8");
      for (const match of source.matchAll(SPECIFIER)) {
        const specifier = match[1] ?? match[2] ?? match[3];
        if (specifier === undefined) continue;
        const target = resolve(file.path, specifier, fileSet, workspace);
        if (target.kind === "file") {
          const owner = ownerOf(target.path);
          if (owner === null || owner[0] === root) continue;
          const key = `${idOf(root)}>${idOf(owner[0])}`;
          const edge = edges.get(key) ?? { from: idOf(root), to: idOf(owner[0]), count: 0, examples: [] };
          edge.count += 1;
          if (edge.examples.length < 3) edge.examples.push(`${file.path} → ${target.path}`);
          edges.set(key, edge);
        } else if (target.kind === "external") {
          const users = externals.get(target.name) ?? new Map();
          users.set(idOf(root), (users.get(idOf(root)) ?? 0) + 1);
          externals.set(target.name, users);
          const mine = perComponent.get(root) ?? new Map();
          mine.set(target.name, (mine.get(target.name) ?? 0) + 1);
          perComponent.set(root, mine);
        }
      }
    }
  }
  const languageCounts = new Map();
  const components = [];
  for (const [root, name, role, purpose] of COMPONENTS) {
    const list = members.get(root);
    if (list.length === 0) continue;
    const counts = new Map();
    for (const file of list) {
      const language = languageOf(file.path);
      if (language === null) continue;
      counts.set(language, (counts.get(language) ?? 0) + 1);
      languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
    }
    components.push({
      id: idOf(root),
      rootPath: root,
      name,
      fileCount: list.length,
      files: list.map((file) => file.path).slice(0, 400),
      language: [...counts].sort((a, b) => b[1] - a[1] || byText(a[0], b[0]))[0]?.[0] ?? null,
      roleGuess: role,
      role,
      purpose: narrated ? purpose : null,
      provenance: narrated ? "model" : "rule",
      contentHash: sha1(list.map((file) => `${file.path}:${file.hash}`).sort().join("\n")),
      externalDeps: [...(perComponent.get(root) ?? new Map())]
        .sort((a, b) => b[1] - a[1] || byText(a[0], b[0]))
        .slice(0, 8)
        .map(([dep, count]) => ({ name: dep, count })),
      entryPoints: list.map((file) => file.path).filter((file) => /\/src\/(index|main)\.tsx?$/.test(file)).slice(0, 8),
      importsAnalyzed: list.some((file) => CODE.test(file.path) || file.path.endsWith(".json")),
    });
  }
  const present = new Set(components.map((component) => component.id));
  const edgeList = [...edges.values()]
    .filter((edge) => present.has(edge.from) && present.has(edge.to))
    .sort((a, b) => b.count - a.count || byText(a.from, b.from) || byText(a.to, b.to))
    .slice(0, 1000);
  const externalList = [...externals]
    .map(([name, users]) => ({
      name,
      total: [...users.values()].reduce((sum, n) => sum + n, 0),
      usedBy: [...users].sort((a, b) => b[1] - a[1] || byText(a[0], b[0])).slice(0, 40).map(([componentId, count]) => ({ componentId, count })),
    }))
    .sort((a, b) => b.total - a.total || byText(a.name, b.name))
    .slice(0, 120)
    .map(({ name, usedBy }) => ({ name, usedBy }));
  const snapshot = {
    sessionId: "fixture",
    repoRoot: "/fixture/jevcode",
    scanId: "fixture",
    partial: false,
    counts: {
      files: components.reduce((sum, component) => sum + component.fileCount, 0),
      totalFiles: components.reduce((sum, component) => sum + component.fileCount, 0),
      components: components.length,
      edges: edgeList.length,
      languages: [...languageCounts].sort((a, b) => b[1] - a[1] || byText(a[0], b[0])).slice(0, 20).map(([language]) => language),
    },
    components,
    edges: edgeList,
    externals: externalList,
    narrative: narrated
      ? {
          provenance: "model",
          sentences: NARRATIVE.map(([text, roots]) => ({
            text,
            citations: roots.filter((root) => present.has(idOf(root))).map((root) => ({ kind: "component", id: idOf(root) })),
          })).filter((sentence) => sentence.citations.length > 0),
        }
      : null,
    // Ruling R3: a finished scan; the narrator is ready in the narrated variant and off in the rule variant.
    status: {
      scan: { state: "done", scanned: components.reduce((sum, c) => sum + c.fileCount, 0), total: components.reduce((sum, c) => sum + c.fileCount, 0) },
      narrator: narrated ? "ready" : "off",
    },
    generatedAt: GENERATED_AT,
  };
  return { snapshot, unowned };
}

const CHECK = process.argv.includes("--check");
if (!CHECK) mkdirSync(OUT, { recursive: true });
let stale = 0;
for (const [file, narrated] of [["overview-jevcode.json", true], ["overview-jevcode-rule.json", false]]) {
  const { snapshot, unowned } = build(narrated);
  const bytes = Buffer.byteLength(JSON.stringify(snapshot));
  if (bytes > MAX_BYTES) throw new Error(`${file}: ${bytes} bytes exceeds the 512 KB snapshot cap`);
  const text = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (CHECK) {
    let committed = null;
    try {
      committed = readFileSync(path.join(OUT, file), "utf8");
    } catch {
      // missing counts as stale
    }
    if (committed !== text) {
      stale += 1;
      console.error(`${file}: differs from regenerated output; run node packages/trace-viewer/scripts/overview-fixture.mjs`);
    }
    continue;
  }
  writeFileSync(path.join(OUT, file), text);
  console.log(
    `${file}: ${snapshot.counts.components} components, ${snapshot.counts.edges} edges, ${snapshot.externals.length} externals, ${bytes} bytes, ${unowned} files without a component`,
  );
}
if (CHECK) {
  if (stale > 0) process.exit(1);
  console.log("overview fixtures are up to date");
}
