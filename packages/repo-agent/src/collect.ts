import { realpath } from "node:fs/promises";
import path from "node:path";
import { aggregateComponentEdges, componentize, componentOf, isTestPath } from "@jevcode/codebase-map";
import { scanRepo } from "@jevcode/codebase-map/node";
import { createImportExtractor, languageForPath, resolveSpecifier } from "@jevcode/evidence-engine";
import { prepareDiffForStorage } from "@jevcode/evidence-engine/redactor";
import { readActivity, readActivityText, type ActivityLog } from "./activity.js";
import { clean, eligible, git, hash, readSource } from "./io.js";

export interface CollectOptions {
  repo: string;
  base?: string;
  logs?: string[];
  activityText?: string;
  focus?: string[];
}
export interface RepoContext {
  version: 1;
  repo: string;
  generatedAt: string;
  head: string | null;
  base: string | null;
  files: Record<string, { hash: string; lines: number }>;
  components: { id: string; path: string; name: string; files: number; examples: string[]; entryPoints: string[]; incoming: number; outgoing: number; changed: number }[];
  edges: { from: string; to: string; count: number; examples: string[] }[];
  changed: string[];
  patches: { source: string; path: string; text: string; truncated: boolean }[];
  documents: { path: string; text: string }[];
  activity: ActivityLog[];
  focus: string[];
  limitations: string[];
}

export async function collectRepository(options: CollectOptions): Promise<RepoContext> {
  const requested = await realpath(path.resolve(options.repo));
  const repo = await realpath((await git(requested, ["rev-parse", "--show-toplevel"])).trim());
  const head = await git(repo, ["rev-parse", "--verify", "HEAD"]).then((value) => value.trim(), () => null);
  const base = options.base === undefined ? head : (await git(repo, ["rev-parse", "--verify", "--end-of-options", `${options.base}^{commit}`])).trim();
  const focus = (options.focus ?? []).map((entry) => entry.replace(/\/$/, ""));
  if (focus.some((entry) => !eligible(entry) || entry === "")) throw new Error("Focus paths must be repository-relative source paths.");
  if ((options.logs?.length ?? 0) + Number(options.activityText !== undefined) > 5) throw new Error("At most five activity logs can be supplied per brief.");
  const limitations = [
    "Component boundaries are inferred from repository layout; they are not an approved architecture.",
    "Static import edges cover JavaScript/TypeScript only and do not prove runtime flows or complete dependency coverage.",
    "No tests or builds are run. Supplied activity is historical evidence, not proof that the current checkout passes.",
  ];
  const files: RepoContext["files"] = Object.create(null) as RepoContext["files"];
  const imports = new Map<string, string[]>();
  const documents: RepoContext["documents"] = [];
  const extractor = createImportExtractor({ size: 2 });
  let parseFailures = 0;
  let excluded = 0;
  const scan = await scanRepo(repo, {
    async visit(file, source) {
      if (!eligible(file.path) || await realpath(path.join(repo, file.path)).catch(() => "") !== path.join(repo, file.path)) { excluded += 1; return; }
      files[file.path] = { hash: file.hash, lines: source.split("\n").length };
      if (/(^|\/)(README\.md|AGENTS\.md|ARCHITECTURE\.md)$/.test(file.path) || /^docs\/(architecture|design)\.md$/i.test(file.path)) {
        documents.push({ path: file.path, text: clean(source).slice(0, 3000) });
      }
      const language = languageForPath(file.path);
      if (language === null || language === "json" || isTestPath(file.path)) return;
      try { imports.set(file.path, (await extractor.extract(file.path, source, language)).specifiers); }
      catch { parseFailures += 1; }
    },
  }).finally(() => extractor.dispose());
  const scanned = scan.files.filter((file) => files[file.path] !== undefined);
  const drafts = componentize(scanned, scan.manifest);
  const owner = componentOf(drafts);
  const resolution = {
    files: new Set(Object.keys(files)), tsPaths: scan.tsconfig.paths, baseUrl: scan.tsconfig.baseUrl,
    workspacePackages: Object.fromEntries(Object.entries(scan.manifest.packageNames).map(([dir, name]) => [name, dir])),
  };
  const links: { from: string; to: string }[] = [];
  for (const [from, specifiers] of imports) {
    for (const specifier of specifiers) {
      const result = resolveSpecifier(from, specifier, resolution);
      if (result.kind === "file") links.push({ from, to: result.path });
    }
  }
  const graph = aggregateComponentEdges(links, owner);
  const tracked = base === null ? await git(repo, ["ls-files", "-z"]) : await git(repo, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", base, "--"]);
  const untracked = await git(repo, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const allChanged = [...new Set((tracked + untracked).split("\0").filter(Boolean))].sort();
  const changed = allChanged.filter(eligible);
  const selected = [...changed].sort((a, b) => Number(focus.some((p) => b === p || b.startsWith(p + "/"))) - Number(focus.some((p) => a === p || a.startsWith(p + "/"))));
  const untrackedSet = new Set(untracked.split("\0").filter(Boolean));
  const patches: RepoContext["patches"] = [];
  let remaining = 48_000;
  for (const file of selected.slice(0, 30)) {
    if (remaining <= 0) break;
    let raw: string;
    if (base === null || untrackedSet.has(file)) {
      const text = await readSource(repo, file);
      if (text === null) continue;
      raw = `New file: ${file}\n${text}`;
    } else {
      raw = await git(repo, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=3", base, "--", `:(literal)${file}`]);
    }
    const prepared = prepareDiffForStorage(file, raw);
    const text = clean(prepared.text ?? "").slice(0, Math.min(12_000, remaining));
    remaining -= text.length;
    patches.push({ source: `patch:${patches.length + 1}`, path: file, text, truncated: prepared.truncated || text.length < (prepared.text?.length ?? 0) });
  }
  if (scan.partial) limitations.push("Repository scan reached the 20,000 candidate file limit; architecture coverage is partial.");
  if (parseFailures) limitations.push(`Import parsing failed for ${parseFailures} files.`);
  if (excluded) limitations.push(`${excluded} secret or symlinked files were excluded.`);
  if (allChanged.length !== changed.length) limitations.push(`${allChanged.length - changed.length} changed paths were excluded by secret/generated/binary rules.`);
  if (patches.length < changed.length || patches.some((patch) => patch.truncated)) limitations.push("Change excerpts are partial. Inspect relevant source before drawing conclusions; deleted content may require the base revision.");
  if (graph.total > graph.edges.length) limitations.push("The component edge list was capped.");
  const activity = await Promise.all((options.logs ?? []).map((file, index) => readActivity(path.resolve(file), `activity:${index + 1}`)));
  if (options.activityText !== undefined) activity.push(await readActivityText(options.activityText, `activity:${activity.length + 1}`));
  for (const log of activity) if (log.omitted || log.truncated) limitations.push(`${log.source}: ${log.omitted} unique or unsupported records omitted; byte limit reached: ${log.truncated}.`);
  if (activity.length === 0) limitations.push("No agent activity supplied. Intent, authorship, decisions and test outcomes cannot be recovered from Git alone.");
  const counts = new Map<string, number>();
  for (const file of changed) { const id = owner(file); if (id) counts.set(id, (counts.get(id) ?? 0) + 1); }
  const components = drafts.map((draft) => ({
    id: draft.id, path: draft.rootPath, name: draft.name, files: draft.files.length,
    examples: draft.files.filter((file) => !isTestPath(file)).slice(0, 8), entryPoints: draft.entryPoints,
    incoming: graph.edges.filter((edge) => edge.to === draft.id).length,
    outgoing: graph.edges.filter((edge) => edge.from === draft.id).length,
    changed: counts.get(draft.id) ?? 0,
  })).sort((a, b) => b.changed - a.changed || b.incoming - a.incoming || a.path.localeCompare(b.path));
  const latestHead = await git(repo, ["rev-parse", "--verify", "HEAD"]).then((value) => value.trim(), () => null);
  if (latestHead !== head) throw new Error("HEAD changed during collection. Retry against a stable checkout.");
  return {
    version: 1, repo, generatedAt: new Date().toISOString(), head, base, files, components,
    edges: graph.edges, changed, patches, documents: documents.sort((a, b) => a.path.length - b.path.length).slice(0, 6), activity, focus, limitations,
  };
}

/** A deterministic identity for the collected source state; includes uncommitted files. */
export function contextFingerprint(context: RepoContext): string {
  return hash(JSON.stringify([context.head, Object.entries(context.files).sort(([a], [b]) => a.localeCompare(b))]));
}

/** Recheck the whole collected source scope, including uncited changes and deleted-file patches. */
export async function assertContextUnchanged(context: RepoContext): Promise<void> {
  const head = await git(context.repo, ["rev-parse", "--verify", "HEAD"]).then((value) => value.trim(), () => null);
  if (head !== context.head) throw new Error("HEAD changed during review. Run the brief again; no checkpoint was saved.");
  const files: { path: string; hash: string }[] = [];
  await scanRepo(context.repo, { async visit(file) {
    if (eligible(file.path) && await realpath(path.join(context.repo, file.path)).catch(() => "") === path.join(context.repo, file.path)) files.push(file);
  } });
  if (files.length !== Object.keys(context.files).length || files.some((file) => context.files[file.path]?.hash !== file.hash)) {
    throw new Error("Source changed during review. Run the brief again; no checkpoint was saved.");
  }
}
