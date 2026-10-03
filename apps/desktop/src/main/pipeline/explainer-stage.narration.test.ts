import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { OverviewSnapshotSchema, type OverviewSnapshot } from "@jevcode/contracts";
import { languageOf, type ScannedFile, type WorkspaceManifest } from "@jevcode/codebase-map";
import type { ScanOptions, scanRepo } from "@jevcode/codebase-map/node";
import type { extractImports } from "@jevcode/evidence-engine";
import { createFakeNarratorClient, NarratorUnavailableError } from "@jevcode/jev-router";
import type { ComponentBrief, FakeNarratorClient, NarratorCallOptions, NarratorClient, OverviewNarrativeInput } from "@jevcode/jev-router";
import { openDb } from "@jevcode/storage";
import type { JevcodeDb } from "@jevcode/storage";
import { afterEach, describe, expect, it } from "vitest";

import type { NarratorAvailability, NarratorCallRecord } from "../../shared/narrator-log.js";
import { connectNarratorSwitch, createNarrationSeamFactory } from "./explainer-narration-seam.js";
import type { BriefSources } from "./explainer-narration.js";
import { SNAPSHOT_WRITE_INTERVAL_MS, createExplainerRegistry, createExplainerStage } from "./explainer-stage.js";
import type { ExplainerStage, ExplainerStageDeps } from "./explainer-stage.js";
import { createNarratorSwitch } from "./narrator-switch.js";

const REPO_ID = "repo_n5";
/** Not on disk: README reads find nothing, so blurbs come from the manifest only. */
const REPO_ROOT = "/work/n5-fixture";
const SESSION = "sess_n5";
const PACKAGES = ["alpha", "beta", "gamma"] as const;

const SOURCES: Readonly<Record<string, string>> = Object.fromEntries(
  PACKAGES.flatMap((name) => [
    [`packages/${name}/package.json`, JSON.stringify({ name: `@demo/${name}` })],
    [`packages/${name}/src/index.ts`, `export const ${name}Value = 1;\n`],
  ]),
);
const MANIFEST: WorkspaceManifest = {
  packageDirs: PACKAGES.map((name) => `packages/${name}`),
  appDirs: [],
  packageNames: Object.fromEntries(PACKAGES.map((name) => [`packages/${name}`, `@demo/${name}`])),
  descriptions: { "packages/alpha": "Alpha helpers for the demo." },
  entryPoints: {},
};

const dirs: string[] = [];
const stages: { dispose(): void }[] = [];
afterEach(() => {
  for (const stage of stages.splice(0)) stage.dispose();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function openStore(): JevcodeDb {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jevcode-n5-"));
  dirs.push(dir);
  const db = openDb({ dbPath: path.join(dir, "n5.db") });
  db.upsertRepository({ id: REPO_ID, path: REPO_ROOT, gitRoot: REPO_ROOT });
  db.createSession({ id: SESSION, repoId: REPO_ID });
  return db;
}

function scanned(filePath: string, text: string): ScannedFile {
  return { path: filePath, hash: createHash("sha1").update(text).digest("hex"), size: text.length, language: languageOf(filePath) };
}

/** Lane 04's injected clock: the 2 s row writer and the narration's timers run when `advance` says so. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    schedule: {
      setTimeout: (fn: () => void, ms: number): unknown => {
        const id = nextId++;
        timers.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimeout: (handle: unknown): void => {
        timers.delete(handle as number);
      },
    },
    advance(ms: number): void {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}
type Clock = ReturnType<typeof fakeClock>;

const scan: typeof scanRepo = async (_root, options: ScanOptions = {}) => {
  const entries = Object.entries(SOURCES).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const files = entries.map(([filePath, text]) => scanned(filePath, text));
  for (const [index, file] of files.entries()) {
    await options.visit?.(file, entries[index]?.[1] ?? "");
    options.onProgress?.(index + 1, files.length);
  }
  return { files, manifest: MANIFEST, partial: false, tsconfig: { paths: {}, baseUrl: null }, totalFiles: files.length };
};

/** Lane 04's parse pass: the exports reach the narration through OverviewView.exportsOf. */
const extract: typeof extractImports = async (_filePath, source) => ({
  specifiers: [],
  exports: [...source.matchAll(/export const (\w+)/g)].map((match) => match[1] ?? ""),
});

interface NarrationOptions {
  narrator: NarratorClient | null;
  availability?: () => NarratorAvailability;
  briefSources?: BriefSources;
  records?: NarratorCallRecord[];
}

function stageDeps(db: JevcodeDb, clock: Clock, options: NarrationOptions): ExplainerStageDeps {
  const narration = {
    initialNarrator: options.narrator,
    narratorAvailability: options.availability ?? (() => "on" as const),
    recordNarratorCall: (record: NarratorCallRecord) => options.records?.push(record),
    ...(options.briefSources === undefined ? {} : { briefSources: options.briefSources }),
  };
  return {
    db,
    repoRoot: REPO_ROOT,
    sessionId: () => SESSION,
    scan,
    scanPaths: async () => {
      throw new Error("scanPaths is not used by these tests");
    },
    extract,
    emitRowsAvailable: () => undefined,
    now: clock.now,
    schedule: clock.schedule,
    log: () => undefined,
    narration: createNarrationSeamFactory(narration),
    initialNarrator: narration.initialNarrator,
    recordNarratorCall: narration.recordNarratorCall,
    ...(options.briefSources === undefined ? {} : { briefSources: options.briefSources }),
  };
}

function start(db: JevcodeDb, clock: Clock, options: NarrationOptions): ExplainerStage {
  const stage = createExplainerStage(stageDeps(db, clock, options));
  stages.push(stage);
  stage.onRepoOpened();
  stage.onSessionStarted(SESSION);
  return stage;
}

function snapshotRows(db: JevcodeDb): OverviewSnapshot[] {
  return db
    .listEvents(SESSION, { limit: 1000 })
    .filter((event) => event.type === "overview_snapshot")
    .map((event) => OverviewSnapshotSchema.parse(JSON.parse(event.payloadJson)));
}

/** Real event-loop turns: the fake narrator's answers and the stage's sliced rebuilds land here. */
async function turns(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Runs the stage (whenIdle, real turns) and the injected clock (the 2 s writer) until `done`. */
async function settle(stage: Pick<ExplainerStage, "whenIdle">, clock: Clock, done: () => boolean): Promise<void> {
  for (let round = 0; round < 30; round += 1) {
    await stage.whenIdle();
    await turns();
    if (done()) return;
    clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);
  }
  expect(done()).toBe(true);
}

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

const echoClient = (): FakeNarratorClient =>
  createFakeNarratorClient({ describeComponents: [echoDescribe, echoDescribe], overviewNarrative: [echoNarrative, echoNarrative] });

/** A describe call that answers only when its signal aborts (spec E15: switching off aborts it). */
const hangUntilAborted = (_input: unknown, options?: NarratorCallOptions): Promise<unknown> =>
  new Promise((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(new NarratorUnavailableError("aborted", "call aborted")));
  });

const narrated = (row: OverviewSnapshot | undefined): boolean =>
  row !== undefined &&
  row.narrative !== null &&
  row.components.length > 0 &&
  row.components.every((entry) => entry.provenance === "model" && entry.purpose !== null);

const ruleBased = (row: OverviewSnapshot): boolean => row.components.every((entry) => entry.provenance === "rule");

describe("explainer stage narration through the seam (N-5, R4)", () => {
  it("writes a rule-based row, then a narrated row with purposes, the narrative and narrator ready", async () => {
    const db = openStore();
    const clock = fakeClock();
    const narrator = echoClient();
    const records: NarratorCallRecord[] = [];
    const stage = start(db, clock, { narrator, records });
    await settle(stage, clock, () => narrated(snapshotRows(db).at(-1)) && snapshotRows(db).at(-1)?.status?.narrator === "ready");

    const rows = snapshotRows(db);
    expect(ruleBased(rows[0]!)).toBe(true);
    expect(rows[0]!.status?.narrator).toBe("pending");
    expect(rows.at(-1)!.sessionId).toBe(SESSION);
    expect(rows.at(-1)!.narrative?.sentences[0]?.text).toBe("The system has 3 components.");
    expect(narrator.calls.map((call) => call.method)).toEqual(["describeComponents", "overviewNarrative"]);
    // The default brief sources read lane 04's OverviewView: manifest description and parsed exports.
    const briefs = narrator.calls[0]!.input as ComponentBrief[];
    const alpha = briefs.find((brief) => brief.rootPath === "packages/alpha");
    expect(alpha?.blurb).toBe("Alpha helpers for the demo.");
    expect(alpha?.exports).toEqual(["alphaValue"]);
    expect(records.map((record) => [record.question, record.error])).toEqual([
      ["describeComponents", null],
      ["overviewNarrative", null],
    ]);
  });

  it("reopening the unchanged repo makes 0 narrator calls and its first row already carries the text (spec §11)", async () => {
    const db = openStore();
    const clock = fakeClock();
    const first = start(db, clock, { narrator: echoClient() });
    await settle(first, clock, () => snapshotRows(db).at(-1)?.status?.narrator === "ready");
    expect(narrated(snapshotRows(db).at(-1))).toBe(true);
    first.dispose();
    const before = snapshotRows(db).length;

    const silent = createFakeNarratorClient({});
    const second = start(db, clock, { narrator: silent });
    await settle(second, clock, () => snapshotRows(db).length > before);
    clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);
    await settle(second, clock, () => true);
    const reopened = snapshotRows(db).slice(before);
    expect(reopened.length).toBeGreaterThan(0);
    expect(reopened.every(narrated)).toBe(true);
    expect(reopened.at(-1)!.status?.narrator).toBe("ready");
    expect(silent.calls).toEqual([]);
  });

  it("with no API key writes rule-based rows with narrator unavailable and makes no calls (R2)", async () => {
    const db = openStore();
    const clock = fakeClock();
    const records: NarratorCallRecord[] = [];
    const stage = start(db, clock, { narrator: null, availability: () => "off_no_key", records });
    await settle(stage, clock, () => snapshotRows(db).length > 0);
    const rows = snapshotRows(db);
    expect(rows.every(ruleBased)).toBe(true);
    expect(rows.every((row) => row.status?.narrator === "unavailable")).toBe(true);
    expect(records).toEqual([]);
  });

  it("stays rule-based with the setting off and narrates once setNarrator turns it on (spec E15)", async () => {
    const db = openStore();
    const clock = fakeClock();
    const stage = start(db, clock, { narrator: null, availability: () => "off_setting" });
    await settle(stage, clock, () => snapshotRows(db).at(-1)?.status?.narrator === "off");
    expect(snapshotRows(db).every(ruleBased)).toBe(true);

    const narrator = echoClient();
    stage.setNarrator(narrator);
    await settle(stage, clock, () => narrated(snapshotRows(db).at(-1)) && snapshotRows(db).at(-1)?.status?.narrator === "ready");
    expect(narrator.calls.map((call) => call.method)).toEqual(["describeComponents", "overviewNarrative"]);
  });

  it("ignores setNarrator after dispose", async () => {
    const db = openStore();
    const clock = fakeClock();
    const stage = start(db, clock, { narrator: null, availability: () => "off_setting" });
    await settle(stage, clock, () => snapshotRows(db).length > 0);
    stage.dispose();
    const narrator = echoClient();
    stage.setNarrator(narrator);
    await turns();
    expect(narrator.calls).toEqual([]);
  });
});

describe("the narrator switch reaches the open repo's stage (index.ts wiring, spec E15)", () => {
  function wire(env: Record<string, string>, client: NarratorClient | null, records: NarratorCallRecord[] = []) {
    const db = openStore();
    const clock = fakeClock();
    const narratorSwitch = createNarratorSwitch({
      enabled: true,
      env,
      createClient: () => {
        if (client === null) throw new Error("no client expected");
        return client;
      },
    });
    const registry = createExplainerRegistry((repoRoot) =>
      createExplainerStage({
        ...stageDeps(db, clock, {
          narrator: narratorSwitch.current(),
          availability: () => narratorSwitch.availability(),
          records,
        }),
        repoRoot,
      }),
    );
    stages.push(registry);
    const unsubscribe = connectNarratorSwitch(narratorSwitch, registry, () => REPO_ROOT);
    stages.push({ dispose: unsubscribe });
    registry.repoOpened(REPO_ROOT);
    registry.sessionStarted(REPO_ROOT, SESSION);
    const stage = registry.get(REPO_ROOT)!;
    return { db, clock, narratorSwitch, stage };
  }

  it("switching the setting off aborts the in-flight call and stops calls; switching it on narrates", async () => {
    const records: NarratorCallRecord[] = [];
    const client = createFakeNarratorClient({
      describeComponents: [hangUntilAborted, echoDescribe],
      overviewNarrative: [echoNarrative],
    });
    const { db, clock, narratorSwitch, stage } = wire({ ANTHROPIC_API_KEY: "sk-test" }, client, records);
    await settle(stage, clock, () => client.calls.length === 1 && snapshotRows(db).length > 0);
    const inFlight = client.calls[0]!.signal;
    expect(inFlight?.aborted).toBe(false);

    narratorSwitch.setEnabled(false);
    expect(inFlight?.aborted).toBe(true);
    await settle(stage, clock, () => snapshotRows(db).at(-1)?.status?.narrator === "off");
    expect(records.map((record) => [record.question, record.error])).toEqual([["describeComponents", "aborted"]]);
    stage.rescan();
    await settle(stage, clock, () => true);
    clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);
    await settle(stage, clock, () => true);
    expect(client.calls).toHaveLength(1);
    expect(snapshotRows(db).every(ruleBased)).toBe(true);

    narratorSwitch.setEnabled(true);
    await settle(stage, clock, () => narrated(snapshotRows(db).at(-1)) && snapshotRows(db).at(-1)?.status?.narrator === "ready");
    expect(client.calls.map((call) => call.method)).toEqual(["describeComponents", "describeComponents", "overviewNarrative"]);
  });

  it("without a key the row reads unavailable with the setting on and off with it off (R2, R3)", async () => {
    const { db, clock, narratorSwitch, stage } = wire({}, null);
    await settle(stage, clock, () => snapshotRows(db).at(-1)?.status?.narrator === "unavailable");
    narratorSwitch.setEnabled(false);
    await settle(stage, clock, () => snapshotRows(db).at(-1)?.status?.narrator === "off");
    narratorSwitch.setEnabled(true);
    await settle(stage, clock, () => snapshotRows(db).at(-1)?.status?.narrator === "unavailable");
    expect(snapshotRows(db).every(ruleBased)).toBe(true);
  });
});
