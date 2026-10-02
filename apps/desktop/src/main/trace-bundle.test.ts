import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ExplainerRecordSchema, OverviewSnapshotSchema, TraceBundleSchema } from "@jevcode/contracts";
import { openDb, openTraceReader } from "@jevcode/storage";
import { parseTraceBundle } from "@jevcode/trace-viewer/sources";
import { afterEach, describe, expect, it } from "vitest";

import { buildTraceBundle, capRedactedRow, redactBundleValue, writeTraceBundle } from "./trace-bundle.js";
import { createTraceService, readAllRows } from "./trace-service.js";
import type { TraceService } from "./trace-service.js";

const SESSION = "sess_bundle";
const REPO = "repo_bundle";
const TS = "2026-09-28T10:00:00.000Z";
const HOME = "/Users/tester";

const tempDirs: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  while (closers.length > 0) closers.pop()?.();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jevcode-trace-bundle-"));
  tempDirs.push(dir);
  return dir;
}

/** seq 1 agent_started, 2 agent_message (token), 3 command_completed (env line), 4 command_executed fact, 5 file_read. */
function seeded(): TraceService {
  const db = openDb({ dbPath: path.join(tempDir(), "trace.db") });
  db.upsertRepository({ id: REPO, path: "/work/bundle", gitRoot: "/work/bundle" });
  db.createSession({ id: SESSION, repoId: REPO, prompt: `Fix ${HOME}/repo/src/a.ts` });
  db.appendAgentEvent(SESSION, {
    type: "agent_started",
    sessionId: SESSION,
    prompt: `Fix ${HOME}/repo/src/a.ts`,
    ts: TS,
  });
  db.appendAgentEvent(SESSION, {
    type: "agent_message",
    sessionId: SESSION,
    role: "assistant",
    text: "export token=abc123secret",
    ts: TS,
  });
  db.appendAgentEvent(SESSION, {
    type: "command_completed",
    sessionId: SESSION,
    command: "cat .env",
    exitCode: 0,
    stdout: "STRIPE_SECRET_KEY=sk_live_1234\n",
    stderr: "",
    ts: TS,
  });
  db.appendEvidenceFact(SESSION, {
    type: "command_executed",
    repoId: REPO,
    sessionId: SESSION,
    command: `ls ${HOME}/repo`,
    exitCode: 0,
    isDestructive: false,
    ts: TS,
  });
  db.appendAgentEvent(SESSION, {
    type: "file_read",
    sessionId: SESSION,
    path: "/Users/tester2/notes.md",
    ts: TS,
  });
  const reader = openTraceReader(db.dbPath);
  closers.push(() => {
    reader.close();
    db.close();
  });
  return createTraceService(reader);
}

describe("trace bundle", () => {
  it("redacts tokens and maps home", () => {
    const service = seeded();
    const before = readAllRows(service, SESSION).rows;
    const bundle = buildTraceBundle(service, SESSION, {
      homeDir: HOME,
      now: () => "2026-09-28T12:00:00.000Z",
    });
    const text = JSON.stringify(bundle);
    expect(text).not.toContain("abc123secret");
    expect(text).not.toContain("sk_live_1234");
    expect(text).not.toContain(`${HOME}/`);
    expect(text).toContain("token=[REDACTED:token]");
    expect(text).toContain("STRIPE_SECRET_KEY=[REDACTED:env_value]");
    expect(bundle.redactionCount).toBe(2);
    expect(bundle.session.prompt).toBe("Fix ~/repo/src/a.ts");
    expect(bundle.rows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);
    expect((bundle.rows[3]?.payload as { command: string }).command).toBe("ls ~/repo");
    expect((bundle.rows[4]?.payload as { path: string }).path).toBe("/Users/tester2/notes.md");
    expect(bundle.rows[3]?.factId).toBe(before[3]?.factId);
    expect(bundle.rows[3]?.factId).toMatch(/^fact_[0-9a-f]{16}$/);
    expect(bundle).toMatchObject({
      format: "jevcode.trace",
      version: 2,
      exportedAt: "2026-09-28T12:00:00.000Z",
      session: { sessionId: SESSION, lastEventSeq: 5, state: "starting" },
    });
    expect(TraceBundleSchema.safeParse(bundle).success).toBe(true);
  });

  it("exports overview and explainer rows in a redacted v2 bundle that the viewer parser accepts; v1 still parses", () => {
    const db = openDb({ dbPath: path.join(tempDir(), "explainer.db") });
    db.upsertRepository({ id: REPO, path: "/work/bundle", gitRoot: "/work/bundle" });
    db.createSession({ id: SESSION, repoId: REPO, prompt: "Map it" });
    db.appendAgentEvent(SESSION, { type: "agent_started", sessionId: SESSION, prompt: "Map it", ts: TS });
    const componentId = "cmp_0123456789ab";
    db.appendEvent(SESSION, "overview_snapshot", {
      sessionId: SESSION,
      repoRoot: `${HOME}/repo`,
      scanId: "scan_1",
      partial: false,
      counts: { files: 1, components: 1, edges: 0, languages: ["TypeScript"] },
      components: [
        {
          id: componentId,
          rootPath: "src",
          name: "src",
          fileCount: 1,
          files: ["src/a.ts"],
          language: "TypeScript",
          roleGuess: "domain",
          role: "domain",
          purpose: "Reads token=abc123secret from env.",
          provenance: "model",
          contentHash: "0".repeat(40),
          externalDeps: [],
          entryPoints: [],
          importsAnalyzed: true,
        },
      ],
      edges: [],
      externals: [],
      narrative: null,
      generatedAt: TS,
    });
    db.appendEvent(SESSION, "explainer", {
      sessionId: SESSION,
      kind: "story",
      sentences: [{ text: "The agent mapped the repo.", citations: [{ kind: "file", id: `${HOME}/repo/src/a.ts` }] }],
      basisSeq: 2,
    });
    const reader = openTraceReader(db.dbPath);
    closers.push(() => {
      reader.close();
      db.close();
    });

    const bundle = buildTraceBundle(createTraceService(reader), SESSION, {
      homeDir: HOME,
      now: () => "2026-10-02T12:00:00.000Z",
    });
    expect(bundle.version).toBe(2);
    expect(bundle.rows.map((row) => row.type)).toEqual(["agent_event", "overview_snapshot", "explainer"]);
    const text = JSON.stringify(bundle);
    expect(text).not.toContain("abc123secret");
    expect(text).not.toContain(`${HOME}/`);
    expect(bundle.redactionCount).toBe(1);
    // Redacted rows still satisfy their contracts, so the viewer's fold can read them.
    const snapshot = OverviewSnapshotSchema.parse(bundle.rows[1]?.payload);
    expect(snapshot.repoRoot).toBe("~/repo");
    expect(snapshot.components[0]?.purpose).toBe("Reads token=[REDACTED:token] from env.");
    expect(ExplainerRecordSchema.parse(bundle.rows[2]?.payload)).toMatchObject({
      kind: "story",
      sentences: [{ citations: [{ kind: "file", id: "~/repo/src/a.ts" }] }],
    });

    expect(parseTraceBundle(JSON.parse(JSON.stringify(bundle)))).toMatchObject({ ok: true, bundle: { version: 2 } });
    const v1 = { ...bundle, version: 1, rows: bundle.rows.filter((row) => row.type === "agent_event") };
    expect(parseTraceBundle(JSON.parse(JSON.stringify(v1)))).toMatchObject({ ok: true, bundle: { version: 1 } });
    expect(parseTraceBundle({ ...v1, version: 3 })).toMatchObject({ ok: false, code: "UNSUPPORTED_VERSION" });
  });

  it("keeps redacted strings inside the schema caps (a short secret grows into a marker)", () => {
    const db = openDb({ dbPath: path.join(tempDir(), "caps.db") });
    db.upsertRepository({ id: REPO, path: "/work/bundle", gitRoot: "/work/bundle" });
    db.createSession({ id: SESSION, repoId: REPO, prompt: "Map it" });
    db.appendAgentEvent(SESSION, { type: "agent_started", sessionId: SESSION, prompt: "Map it", ts: TS });
    // Each string is under its cap before redaction and over it after: "token=ab" (8 characters) becomes
    // "token=[REDACTED:token]" (22 characters).
    const near = (cap: number): string => `${"p".repeat(cap - 21)} token=ab`; // cap - 12 characters before, cap + 2 after
    const componentId = "cmp_0123456789ab";
    const sentence = { text: near(220), citations: [{ kind: "component" as const, id: near(512) }] };
    db.appendEvent(SESSION, "overview_snapshot", {
      sessionId: SESSION,
      repoRoot: near(1024),
      scanId: near(128),
      partial: false,
      counts: { files: 1, components: 1, edges: 1, languages: [near(40)] },
      status: { scan: { state: "failed", scanned: 0, total: 1, error: near(200) }, narrator: "off" },
      components: [
        {
          id: componentId,
          rootPath: near(1024),
          name: near(120),
          fileCount: 1,
          files: [near(1024)],
          language: near(40),
          roleGuess: "domain",
          role: "domain",
          purpose: near(140),
          provenance: "model",
          contentHash: "0".repeat(40),
          externalDeps: [{ name: near(214), count: 1 }],
          entryPoints: [near(1024)],
          importsAnalyzed: true,
        },
      ],
      edges: [{ from: componentId, to: componentId, count: 1, examples: [near(300)] }],
      externals: [{ name: near(214), usedBy: [{ componentId, count: 1 }] }],
      narrative: { sentences: [sentence], provenance: "model" },
      generatedAt: near(64),
    });
    db.appendEvent(SESSION, "explainer", { sessionId: SESSION, kind: "story", sentences: [sentence], basisSeq: 1 });
    db.appendEvent(SESSION, "explainer", { sessionId: SESSION, kind: "decision_why", decisionId: near(128), sentence });
    db.appendEvent(SESSION, "explainer", {
      sessionId: SESSION,
      kind: "highlights",
      basisSeq: 1,
      components: [{ id: componentId, state: "changed", unitIds: [near(128)] }],
    });
    const reader = openTraceReader(db.dbPath);
    closers.push(() => {
      reader.close();
      db.close();
    });

    const bundle = buildTraceBundle(createTraceService(reader), SESSION, { homeDir: HOME, now: () => TS });
    const snapshot = OverviewSnapshotSchema.parse(bundle.rows[1]?.payload);
    const component = snapshot.components[0];
    expect(snapshot.repoRoot).toHaveLength(1024);
    expect(snapshot.scanId).toHaveLength(128);
    expect(snapshot.counts.languages[0]).toHaveLength(40);
    expect(snapshot.status?.scan.error).toHaveLength(200);
    expect(component?.rootPath).toHaveLength(1024);
    expect(component?.name).toHaveLength(120);
    expect(component?.files[0]).toHaveLength(1024);
    expect(component?.language).toHaveLength(40);
    expect(component?.purpose).toHaveLength(140);
    expect(component?.externalDeps[0]?.name).toHaveLength(214);
    expect(component?.entryPoints[0]).toHaveLength(1024);
    expect(snapshot.edges[0]?.examples[0]).toHaveLength(300);
    expect(snapshot.externals[0]?.name).toHaveLength(214);
    expect(snapshot.narrative?.sentences[0]?.text).toHaveLength(220);
    expect(snapshot.narrative?.sentences[0]?.citations[0]?.id).toHaveLength(512);
    expect(snapshot.generatedAt).toHaveLength(64);
    const story = ExplainerRecordSchema.parse(bundle.rows[2]?.payload);
    expect(story.kind === "story" ? story.sentences[0]?.text : undefined).toHaveLength(220);
    const why = ExplainerRecordSchema.parse(bundle.rows[3]?.payload);
    expect(why.kind === "decision_why" ? [why.decisionId.length, why.sentence.text.length] : []).toEqual([128, 220]);
    const highlights = ExplainerRecordSchema.parse(bundle.rows[4]?.payload);
    expect(highlights.kind === "highlights" ? highlights.components[0]?.unitIds[0] : undefined).toHaveLength(128);
    expect(JSON.stringify(bundle)).not.toContain("token=ab");
    expect(bundle.redactionCount).toBeGreaterThan(0);
    // The viewer's own parser accepts every capped row.
    expect(parseTraceBundle(JSON.parse(JSON.stringify(bundle)))).toMatchObject({ ok: true });
  });

  it("re-caps payload sessionIds, which a stored row may carry past redaction, and passes other rows through", () => {
    const long = `${"s".repeat(119)} token=ab`; // 128 characters, 142 after redaction
    const redacted = redactBundleValue(long, HOME).value as string;
    expect(redacted.length).toBeGreaterThan(128);
    const story = { sessionId: redacted, kind: "story", sentences: [], basisSeq: 1 };
    expect((capRedactedRow("explainer", story) as { sessionId: string }).sessionId).toBe(redacted.slice(0, 128));
    // A snapshot sessionId may be up to 256 characters (lane 04 stamps "" and restamps later).
    const snapshot = { sessionId: redacted, components: [], edges: [], externals: [], narrative: null };
    expect((capRedactedRow("overview_snapshot", snapshot) as { sessionId: string }).sessionId).toBe(redacted);
    const longSnapshot = { ...snapshot, sessionId: "s".repeat(300) };
    expect((capRedactedRow("overview_snapshot", longSnapshot) as { sessionId: string }).sessionId).toHaveLength(256);

    const other = { text: "x".repeat(5000) };
    expect(capRedactedRow("agent_event", other)).toBe(other);
    expect(capRedactedRow("explainer", "not an object")).toBe("not an object");
    // A cut never leaves half a surrogate pair.
    const emoji = { sessionId: SESSION, kind: "story", sentences: [{ text: `${"a".repeat(219)}😀`, citations: [] }], basisSeq: 1 };
    expect((capRedactedRow("explainer", emoji) as { sentences: { text: string }[] }).sentences[0]?.text).toBe("a".repeat(219));
  });

  it("redacts a private key that straddles the 4 KiB head cut, then clips", () => {
    const db = openDb({ dbPath: path.join(tempDir(), "pem.db") });
    db.upsertRepository({ id: REPO, path: "/work/bundle", gitRoot: "/work/bundle" });
    db.createSession({ id: SESSION, repoId: REPO, prompt: "Deploy" });
    const logHead = "build log line\n".repeat(240);
    const keyLines = Array.from(
      { length: 24 },
      (_, i) => `MIIE${String(i).padStart(2, "0")}${"q".repeat(58)}`,
    );
    const pem = ["-----BEGIN RSA PRIVATE KEY-----", ...keyLines, "-----END RSA PRIVATE KEY-----"].join(
      "\n",
    );
    // The block spans bytes 3,600 to 5,221 of a 40 KiB stdout.
    const stdout = `${logHead}${pem}\n`.padEnd(40 * 1024, "test log line\n");
    db.appendAgentEvent(SESSION, {
      type: "command_completed",
      sessionId: SESSION,
      command: "./deploy.sh",
      exitCode: 0,
      stdout,
      stderr: "",
      ts: TS,
    });
    const reader = openTraceReader(db.dbPath);
    closers.push(() => {
      reader.close();
      db.close();
    });
    const service = createTraceService(reader);
    // The precondition: the service's 4 KiB head cut falls inside the block,
    // so a clipped head holds the BEGIN line and key lines but no END line.
    const clipped = (readAllRows(service, SESSION).rows[0]?.payload as { stdout: string }).stdout;
    expect(clipped).toContain("-----BEGIN RSA PRIVATE KEY-----\nMIIE00");
    expect(clipped).not.toContain("-----END RSA PRIVATE KEY-----");
    const bundle = buildTraceBundle(service, SESSION, { homeDir: HOME });
    const [row] = bundle.rows;
    expect(JSON.stringify(bundle)).not.toMatch(/MIIE\d\d/);
    expect((row?.payload as { stdout: string }).stdout.startsWith(
      `${logHead}[REDACTED:private_key]\ntest log line\n`,
    )).toBe(true);
    expect(row?.clipped).toBe(true);
    expect(bundle.redactionCount).toBe(1);
  });

  it("maps home only at a path boundary and does not recount redacted markers", () => {
    expect(redactBundleValue({ a: "token=[REDACTED:token]" }, HOME)).toEqual({
      value: { a: "token=[REDACTED:token]" },
      count: 0,
    });
    expect(redactBundleValue(["password=hunter2", 7, null, true], HOME)).toEqual({
      value: ["password=[REDACTED:password]", 7, null, true],
      count: 1,
    });
    expect(redactBundleValue(`${HOME}`, `${HOME}/`)).toEqual({ value: "~", count: 0 });
    expect(redactBundleValue(`${HOME}.bak and ${HOME}-old and ${HOME}2`, HOME)).toEqual({
      value: `${HOME}.bak and ${HOME}-old and ${HOME}2`,
      count: 0,
    });
    expect(redactBundleValue(`"${HOME}" ${HOME}/a`, HOME)).toEqual({ value: '"~" ~/a', count: 0 });
    expect(redactBundleValue("/a/b", "/")).toEqual({ value: "/a/b", count: 0 });
  });

  it("writes exactly JSON.stringify(bundle) plus a newline", () => {
    const service = seeded();
    const bundle = buildTraceBundle(service, SESSION, { homeDir: HOME });
    const file = path.join(tempDir(), "nested", "trace.json");
    writeTraceBundle(file, bundle);
    expect(readFileSync(file, "utf8")).toBe(`${JSON.stringify(bundle)}\n`);
    const empty = { ...bundle, rows: [] };
    writeTraceBundle(file, empty);
    expect(readFileSync(file, "utf8")).toBe(`${JSON.stringify(empty)}\n`);
    expect(TraceBundleSchema.parse(JSON.parse(readFileSync(file, "utf8")))).toEqual(empty);
  });

  it.skipIf(process.platform === "win32")("writes mode 0600 even over an existing 0644 file", () => {
    const service = seeded();
    const file = path.join(tempDir(), "out", "trace.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "old", { mode: 0o644 });
    writeTraceBundle(file, buildTraceBundle(service, SESSION, { homeDir: HOME }));
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
