// Dev host only: in-browser overviews for the Map (P-3): a small sample repo and a 200-component synthetic map for
// pan and zoom profiling. P-5 adds this repository's fixture.
import { OverviewSnapshotSchema, ROLES, type OverviewSnapshot, type Role, type TraceBundle } from "@jevcode/contracts";

interface SampleComponent { root: string; name: string; role: Role; purpose: string; files: number; deps?: readonly string[] }

const SAMPLE: readonly SampleComponent[] = [
  { root: "apps/web", name: "web", role: "ui", purpose: "Browser app: pages, forms and the session dashboard.", files: 64, deps: ["react", "react-dom"] },
  { root: "apps/admin", name: "admin", role: "ui", purpose: "Admin console for accounts and billing.", files: 31, deps: ["react"] },
  { root: "services/api", name: "api", role: "api", purpose: "HTTP API: routes, auth middleware and validation.", files: 48, deps: ["fastify", "zod"] },
  { root: "services/worker", name: "worker", role: "agent", purpose: "Background jobs that call the model provider.", files: 22, deps: ["@anthropic-ai/sdk"] },
  { root: "packages/core", name: "core", role: "domain", purpose: "Accounts, sessions and billing rules.", files: 57 },
  { root: "packages/auth", name: "auth", role: "domain", purpose: "OAuth providers and password login.", files: 18, deps: ["jose"] },
  { root: "packages/db", name: "db", role: "storage", purpose: "Postgres schema, migrations and queries.", files: 26, deps: ["pg", "drizzle-orm"] },
  { root: "e2e", name: "e2e", role: "tests", purpose: "Browser tests for sign-in and checkout.", files: 15, deps: ["playwright"] },
  { root: "scripts", name: "scripts", role: "tooling", purpose: "Release and seed scripts.", files: 6 },
  { root: ".", name: "config", role: "config", purpose: "Workspace, TypeScript and lint configuration.", files: 9 },
];

const EDGES: readonly (readonly [string, string, number])[] = [
  ["apps/web", "services/api", 14],
  ["apps/admin", "services/api", 6],
  ["apps/web", "packages/core", 4],
  ["services/api", "packages/core", 21],
  ["services/api", "packages/auth", 9],
  ["services/worker", "packages/core", 7],
  ["packages/auth", "packages/db", 5],
  ["packages/core", "packages/db", 17],
  ["e2e", "apps/web", 3],
  ["scripts", "packages/db", 2],
];

const hex = (n: number, width: number): string => n.toString(16).padStart(width, "0");

export function sampleOverview(sessionId: string): OverviewSnapshot {
  const ids = new Map(SAMPLE.map((component, index) => [component.root, `cmp_${hex(index + 1, 12)}`] as const));
  const id = (root: string): string => ids.get(root) ?? "cmp_000000000000";
  const users = new Map<string, { componentId: string; count: number }[]>();
  for (const component of SAMPLE) {
    (component.deps ?? []).forEach((name, k) => {
      const list = users.get(name) ?? [];
      list.push({ componentId: id(component.root), count: 6 - k });
      users.set(name, list);
    });
  }
  return OverviewSnapshotSchema.parse({
    sessionId,
    repoRoot: "/sample/acme",
    scanId: "sample-1",
    partial: false,
    counts: { files: SAMPLE.reduce((sum, component) => sum + component.files, 0), components: SAMPLE.length, edges: EDGES.length, languages: ["TypeScript", "JSON"] },
    components: SAMPLE.map((component, index) => ({
      id: id(component.root),
      rootPath: component.root,
      name: component.name,
      fileCount: component.files,
      files: [component.root === "." ? "package.json" : `${component.root}/package.json`],
      language: "TypeScript",
      roleGuess: component.role,
      role: component.role,
      purpose: component.purpose,
      provenance: "model",
      contentHash: hex(index + 1, 40),
      externalDeps: (component.deps ?? []).map((name, k) => ({ name, count: 6 - k })),
      entryPoints: [],
      importsAnalyzed: true,
    })),
    edges: EDGES.map(([from, to, count]) => ({ from: id(from), to: id(to), count, examples: [] })),
    externals: [...users].map(([name, usedBy]) => ({ name, usedBy })),
    narrative: {
      provenance: "model",
      sentences: [
        { text: "Acme is a web app with an admin console, both served by one HTTP API.", citations: [{ kind: "component", id: id("apps/web") }, { kind: "component", id: id("services/api") }] },
        { text: "The API keeps account and billing rules in core and stores them in Postgres through db.", citations: [{ kind: "component", id: id("packages/core") }, { kind: "component", id: id("packages/db") }] },
        { text: "A worker runs model calls in the background.", citations: [{ kind: "component", id: id("services/worker") }] },
      ],
    },
    generatedAt: "2026-10-02T09:00:00.000Z",
  });
}

/** mulberry32, as in the viewer's test-support `syntheticOverview` (which needs node:crypto, so the dev host ports it). */
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The viewer's synthetic stress map in the browser (spec §11 "Map pan and zoom", 200 components and 1,000 edges):
 * components across every role, `edges` distinct pairs, the same draws as test-support `syntheticOverview`.
 */
export function syntheticSampleOverview(sessionId: string, options = { components: 200, edges: 1_000, seed: 3 }): OverviewSnapshot {
  const next = generator(options.seed);
  const pick = (n: number): number => Math.floor(next() * n);
  const components = Array.from({ length: options.components }, (_, index) => {
    const role: Role = ROLES[index % ROLES.length] ?? "domain";
    const name = `p${String(index).padStart(3, "0")}`;
    return {
      id: `cmp_${hex(index + 1, 12)}`,
      rootPath: `packages/${name}`,
      name,
      fileCount: 5 + pick(140),
      files: [`packages/${name}/index.ts`],
      language: "TypeScript",
      roleGuess: role,
      role,
      purpose: index % 3 === 0 ? null : `Component ${index} of the synthetic repo.`,
      provenance: index % 3 === 0 ? ("rule" as const) : ("model" as const),
      contentHash: hex(index + 1, 40),
      externalDeps: [],
      entryPoints: [],
      importsAnalyzed: true,
    };
  });
  const edges: { from: string; to: string; count: number; examples: string[] }[] = [];
  const seen = new Set<string>();
  for (let attempt = 0; edges.length < options.edges && attempt < options.edges * 20; attempt += 1) {
    const from = components[pick(components.length)];
    const to = components[pick(components.length)];
    if (from === undefined || to === undefined || from.id === to.id) continue;
    const key = `${from.id}>${to.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from: from.id, to: to.id, count: 1 + pick(40), examples: [] });
  }
  return OverviewSnapshotSchema.parse({
    sessionId,
    repoRoot: "/sample/synthetic",
    scanId: "synthetic-1",
    partial: false,
    counts: { files: components.reduce((sum, component) => sum + component.fileCount, 0), components: components.length, edges: edges.length, languages: ["TypeScript"] },
    components,
    edges,
    externals: [],
    narrative: null,
    generatedAt: "2026-10-02T09:00:00.000Z",
  });
}

/** Appends one overview_snapshot row after the bundle's last row (spec §8.1 replace semantics). */
export function withOverview(bundle: TraceBundle, snapshot: OverviewSnapshot): TraceBundle {
  const last = bundle.rows.at(-1);
  const seq = (last?.seq ?? 0) + 1;
  return {
    ...bundle,
    session: { ...bundle.session, lastEventSeq: Math.max(bundle.session.lastEventSeq, seq) },
    rows: [...bundle.rows, { seq, type: "overview_snapshot", ts: last?.ts ?? bundle.session.startedAt, payload: { ...snapshot, sessionId: bundle.session.sessionId } }],
  };
}

/** The overview a `?overview=<name>` asks for; null for an unknown name. */
export async function loadOverview(name: string, sessionId: string): Promise<OverviewSnapshot | null> {
  if (name === "sample") return sampleOverview(sessionId);
  if (name === "synthetic") return syntheticSampleOverview(sessionId);
  return null;
}
