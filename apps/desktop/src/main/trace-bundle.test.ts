import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { TraceBundleSchema } from "@jevcode/contracts";
import { openDb, openTraceReader } from "@jevcode/storage";
import { afterEach, describe, expect, it } from "vitest";

import { buildTraceBundle, redactBundleValue, writeTraceBundle } from "./trace-bundle.js";
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
      version: 1,
      exportedAt: "2026-09-28T12:00:00.000Z",
      session: { sessionId: SESSION, lastEventSeq: 5, state: "starting" },
    });
    expect(TraceBundleSchema.safeParse(bundle).success).toBe(true);
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
