import { buildManifest } from "@jevcode/codebase-map";
import type { Component, OverviewSnapshot } from "@jevcode/contracts";
import { OverviewSnapshotSchema } from "@jevcode/contracts";
import { createFakeNarratorClient, NARRATOR_MODEL } from "@jevcode/jev-router";
import type { ComponentBrief, OverviewNarrativeInput } from "@jevcode/jev-router";
import { openDb } from "@jevcode/storage";
import type { JevcodeDb } from "@jevcode/storage";
import { afterEach, describe, expect, it } from "vitest";

import type { NarratorAvailability } from "../../shared/narrator-log.js";
import { createNarrationSeamFactory, viewBriefSources } from "./explainer-narration-seam.js";
import type { NarrationContext, NarrationSeam, OverviewView } from "./explainer-stage.js";

const REPO = "/work/seam-fixture";
const hex = (n: number, width: number): string => n.toString(16).padStart(width, "0");
const seams: NarrationSeam[] = [];
const dbs: JevcodeDb[] = [];

afterEach(() => {
  for (const seam of seams.splice(0)) seam.dispose();
  for (const db of dbs.splice(0)) db.close();
});

function component(index: number): Component {
  return {
    id: `cmp_${hex(index + 1, 12)}`,
    rootPath: `packages/p${index}`,
    name: `alpha-${index}`,
    fileCount: 1,
    files: [`packages/p${index}/src/index.ts`],
    language: "TypeScript",
    roleGuess: "domain",
    role: "domain",
    purpose: null,
    provenance: "rule",
    contentHash: hex(index + 1, 40),
    externalDeps: [],
    entryPoints: [`packages/p${index}/src/index.ts`],
    importsAnalyzed: true,
  };
}

function snapshotOf(components: Component[]): OverviewSnapshot {
  return OverviewSnapshotSchema.parse({
    sessionId: "sess_seam",
    repoRoot: REPO,
    scanId: "scan_1",
    partial: false,
    counts: { files: components.length, components: components.length, edges: 0, languages: ["TypeScript"] },
    components,
    edges: [],
    externals: [],
    narrative: null,
    generatedAt: "2026-10-02T00:00:00.000Z",
  });
}

function viewOf(components: Component[]): OverviewView {
  return {
    repoRoot: REPO,
    drafts: components.map((entry) => ({
      id: entry.id,
      rootPath: entry.rootPath,
      name: entry.name,
      files: entry.files,
      language: entry.language,
      contentHash: entry.contentHash,
      entryPoints: entry.entryPoints,
      importsAnalyzed: true,
    })),
    roleGuess: new Map(components.map((entry) => [entry.id, entry.roleGuess] as const)),
    edges: [],
    externals: [],
    manifest: {
      packageDirs: components.map((entry) => entry.rootPath),
      appDirs: [],
      packageNames: {},
      descriptions: { "packages/p0": "Token vault. key=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      entryPoints: {},
    },
    exportsOf: (componentId) => (componentId === components[0]!.id ? ["openVault", "LIMIT"] : []),
  };
}

function contextOf(): { ctx: NarrationContext; refreshes: () => number } {
  let refreshes = 0;
  const db = openDb({ dbPath: ":memory:" });
  dbs.push(db);
  const ctx: NarrationContext = {
    repoRoot: REPO,
    db,
    now: () => Date.now(),
    schedule: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    log: () => undefined,
    refresh: () => {
      refreshes += 1;
    },
  };
  return { ctx, refreshes: () => refreshes };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const echoDescribe = (input: unknown): unknown =>
  (input as ComponentBrief[]).map((brief) => ({
    id: brief.id,
    purpose: `Handles the ${brief.rootPath} package.`,
    role: brief.roleGuess,
    citations: [{ kind: "component", id: brief.id }],
  }));

const echoNarrative = (input: unknown): unknown => {
  const { components } = input as OverviewNarrativeInput;
  return [{ text: `The system has ${components.length} components.`, citations: [{ kind: "component", id: components[0]!.id }] }];
};

describe("createNarrationSeamFactory (R4)", () => {
  it("briefs from the OverviewView, serves textFor and narrative, refreshes the stage and reports ready", async () => {
    const components = [component(0), component(1)];
    const view = viewOf(components);
    const narrator = createFakeNarratorClient({ describeComponents: [echoDescribe], overviewNarrative: [echoNarrative] });
    const { ctx, refreshes } = contextOf();
    const seam = createNarrationSeamFactory({ initialNarrator: narrator, narratorAvailability: () => "on" })(ctx);
    seams.push(seam);
    expect(seam.narratorStatus?.()).toBe("pending");
    expect(seam.textFor(view).size).toBe(0);

    seam.onSnapshot(snapshotOf(components), view);
    await expect.poll(() => seam.narratorStatus?.(), { timeout: 5_000, interval: 10 }).toBe("ready");

    const briefs = narrator.calls[0]!.input as ComponentBrief[];
    expect(briefs[0]!.exports).toEqual(["openVault", "LIMIT"]);
    expect(briefs[0]!.blurb).toContain("[REDACTED:provider_key]");
    expect(briefs[0]!.blurb?.startsWith("Token vault.")).toBe(true);
    expect(briefs[1]!.blurb).toBeNull();
    expect([...seam.textFor(view).values()]).toEqual([
      { purpose: "Handles the packages/p0 package.", role: "domain", provenance: "model" },
      { purpose: "Handles the packages/p1 package.", role: "domain", provenance: "model" },
    ]);
    const assembled = { ...snapshotOf(components), components: components.map((entry) => ({ ...entry, role: "domain" as const })) };
    expect(seam.narrative(assembled, view)?.sentences[0]?.text).toBe("The system has 2 components.");
    expect(refreshes()).toBeGreaterThanOrEqual(2);
    expect(ctx.db.getComponentText(REPO, components[0]!.id, components[0]!.contentHash)?.model).toBe(NARRATOR_MODEL);
  });

  it.each([
    ["off_setting", "off"],
    ["off_env", "off"],
    ["off_no_key", "unavailable"],
  ] as const)("with no narrator and availability %s reports %s and makes no calls", async (availability: NarratorAvailability, expected) => {
    const components = [component(0)];
    const { ctx } = contextOf();
    const seam = createNarrationSeamFactory({ initialNarrator: null, narratorAvailability: () => availability })(ctx);
    seams.push(seam);
    seam.onSnapshot(snapshotOf(components), viewOf(components));
    await flush();
    expect(seam.narratorStatus?.()).toBe(expected);
    expect(seam.textFor(viewOf(components)).size).toBe(0);
  });

  it("setNarrator turns narration on and off", async () => {
    const components = [component(0)];
    const view = viewOf(components);
    const { ctx } = contextOf();
    const seam = createNarrationSeamFactory({ initialNarrator: null, narratorAvailability: () => "off_setting" })(ctx);
    seams.push(seam);
    seam.onSnapshot(snapshotOf(components), view);
    const narrator = createFakeNarratorClient({ describeComponents: [echoDescribe], overviewNarrative: [echoNarrative] });
    seam.setNarrator?.(narrator);
    await expect.poll(() => seam.narratorStatus?.(), { timeout: 5_000, interval: 10 }).toBe("ready");
    expect(narrator.calls.map((call) => call.method)).toEqual(["describeComponents", "overviewNarrative"]);
    seam.setNarrator?.(null);
    expect(seam.narratorStatus?.()).toBe("off");
  });

  it("viewBriefSources: manifest description first, then the README; exports from the view", async () => {
    const components = [component(0)];
    const view = viewOf(components);
    const sources = viewBriefSources(view, { blurb: async () => "From the README.", exports: async () => ["ignored"] });
    expect(await sources.blurb(components[0]!)).toMatch(/^Token vault\./);
    expect(await sources.exports(components[0]!)).toEqual(["openVault", "LIMIT"]);
    const other = { ...component(1) };
    expect(await sources.blurb(other)).toBe("From the README.");
  });

  it("redacts a package description before its 600-character clip, so a key straddling character 600 never leaks (spec §6.2)", async () => {
    // The key starts at character 581 and runs past 600; a clip first would leave "sk-ant-api03-AAAAAA" unredacted.
    const description = `${"d".repeat(580)} sk-ant-api03-${"A".repeat(30)} ${"e".repeat(1_000)}`;
    const manifest = buildManifest(["package.json"], new Map([["package.json", JSON.stringify({ name: "root", description })]]));
    const root = { ...component(0), rootPath: "." };
    const sources = viewBriefSources({ ...viewOf([root]), manifest }, { blurb: async () => null, exports: async () => [] });
    const blurb = await sources.blurb(root);
    expect(blurb).not.toContain("sk-ant");
    expect(blurb).not.toContain("AAAA");
    expect(Array.from(blurb ?? "")).toHaveLength(600);
  });
});
