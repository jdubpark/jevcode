import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TraceBundleSchema, isTraceRowType } from "@jevcode/contracts";
import { openDb } from "@jevcode/storage";
import { afterEach, describe, expect, it, vi } from "vitest";

import { exportMain, replayMain, runReplay } from "./cli-entry.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../");
const TS = "2026-09-28T10:00:00.000Z";
const USAGE = "usage: jevcode-replay export --db <path> --session <id> --out <file>";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jevcode-replay-cli-"));
  tempDirs.push(dir);
  return dir;
}

/** A closed database file holding sess_export: seq 1 agent_started, 2 agent_message with a planted token. */
function seededDbPath(dir: string): string {
  const db = openDb({ dbPath: path.join(dir, "export.db") });
  db.upsertRepository({ id: "repo_export", path: "/work/export", gitRoot: "/work/export" });
  db.createSession({ id: "sess_export", repoId: "repo_export", prompt: "Export me" });
  db.appendAgentEvent("sess_export", {
    type: "agent_started",
    sessionId: "sess_export",
    prompt: "Export me",
    ts: TS,
  });
  db.appendAgentEvent("sess_export", {
    type: "agent_message",
    sessionId: "sess_export",
    role: "assistant",
    text: "export token=tok_4f9a2c1e",
    ts: TS,
  });
  const dbPath = db.dbPath;
  db.close();
  return dbPath;
}

describe("runReplay trace bundle", () => {
  it("writes trace.json whose unit evidence ids resolve to row factIds", async () => {
    const outDir = path.join(tempDir(), "replay-oauth");
    const result = await runReplay(path.join(repoRoot, "fixtures", "oauth"), outDir);
    expect(result.errors).toEqual([]);
    expect(result.bundlePath).toBe(path.join(outDir, "trace.json"));
    const bundle = TraceBundleSchema.parse(JSON.parse(readFileSync(result.bundlePath, "utf8")));
    expect(bundle.session.sessionId).toBe(result.sessionId);
    expect(bundle.rows.length).toBeGreaterThan(0);
    expect(bundle.rows.every((row) => isTraceRowType(row.type))).toBe(true);
    const seqs = bundle.rows.map((row) => row.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(Math.max(...seqs)).toBeLessThanOrEqual(bundle.session.lastEventSeq);
    const factIds = new Set(
      bundle.rows.flatMap((row) => (row.factId === undefined ? [] : [row.factId])),
    );
    const latestUnits = new Map<string, { evidence: string[] }>();
    for (const row of bundle.rows) {
      if (row.type !== "change_unit") continue;
      const unit = row.payload as { id: string; evidence: string[] };
      latestUnits.set(unit.id, unit);
    }
    const cited = [...latestUnits.values()].flatMap((unit) =>
      unit.evidence.filter((id) => id.startsWith("fact_")),
    );
    expect(cited.length).toBeGreaterThan(0);
    expect(cited.filter((id) => !factIds.has(id))).toEqual([]);
    if (process.platform !== "win32") {
      expect(statSync(result.bundlePath).mode & 0o777).toBe(0o600);
    }
  }, 60_000);
});

describe("replay export", () => {
  it("exports a stored session to a 0600 bundle and prints a summary", async () => {
    const dir = tempDir();
    const dbPath = seededDbPath(dir);
    const out = path.join(dir, "out", "trace.json");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await exportMain(["--db", dbPath, "--session", "sess_export", "--out", out])).toBe(0);
    const bundle = TraceBundleSchema.parse(JSON.parse(readFileSync(out, "utf8")));
    expect(bundle.rows.map((row) => row.seq)).toEqual([1, 2]);
    expect(JSON.stringify(bundle)).not.toContain("tok_4f9a2c1e");
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({ out, rows: 2, redactionCount: 1 });
    if (process.platform !== "win32") {
      expect(statSync(out).mode & 0o777).toBe(0o600);
    }
  });

  it("replayMain dispatches the export subcommand", async () => {
    const dir = tempDir();
    const dbPath = seededDbPath(dir);
    const out = path.join(dir, "dispatched.json");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await replayMain([
      "node",
      "replay.mjs",
      "export",
      "--db",
      dbPath,
      "--session",
      "sess_export",
      "--out",
      out,
    ]);
    expect(code).toBe(0);
    expect(TraceBundleSchema.parse(JSON.parse(readFileSync(out, "utf8"))).session.sessionId).toBe(
      "sess_export",
    );
  });

  it("returns 1 with usage and writes nothing when a flag is missing or malformed", async () => {
    const dir = tempDir();
    const dbPath = seededDbPath(dir);
    const out = path.join(dir, "trace.json");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await exportMain(["--db", dbPath, "--out", out])).toBe(1);
    expect(await exportMain(["--db", dbPath, "--session", "--out", out])).toBe(1);
    expect(
      await exportMain(["--db", dbPath, "--session", "sess_export", "--out", out, "--force", "yes"]),
    ).toBe(1);
    expect(error).toHaveBeenCalledWith(USAGE);
    expect(existsSync(out)).toBe(false);
  });

  it("returns 1 and writes nothing for an unknown session or a missing database", async () => {
    const dir = tempDir();
    const dbPath = seededDbPath(dir);
    const out = path.join(dir, "trace.json");
    const missingDb = path.join(dir, "missing.db");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await exportMain(["--db", dbPath, "--session", "sess_missing", "--out", out])).toBe(1);
    expect(await exportMain(["--db", missingDb, "--session", "sess_export", "--out", out])).toBe(1);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(missingDb)).toBe(false);
    const messages = error.mock.calls.map((call) => String(call[0])).join("\n");
    expect(messages).toContain("export: no session sess_missing");
    expect(messages).toContain(`export: cannot open ${missingDb}`);
  });

  it("returns 1 and leaves the database intact when --out names the database or its -wal/-shm files", async () => {
    const dir = tempDir();
    const dbPath = seededDbPath(dir);
    const before = readFileSync(dbPath);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const outs = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, path.relative(process.cwd(), dbPath)];
    if (process.platform !== "win32") {
      const symlink = path.join(dir, "symlink.db");
      symlinkSync(dbPath, symlink);
      const hardLink = path.join(dir, "hardlink.db");
      linkSync(dbPath, hardLink);
      outs.push(symlink, hardLink);
    }
    // A case-insensitive filesystem (the macOS default) resolves this to the database too.
    const otherCase = path.join(dir, "EXPORT.db");
    if (existsSync(otherCase)) outs.push(otherCase);
    for (const out of outs) {
      expect(await exportMain(["--db", dbPath, "--session", "sess_export", "--out", out])).toBe(1);
    }
    expect(error.mock.calls.map((call) => String(call[0]))).toEqual(
      outs.map(() => "export: --out must not be the database or its -wal/-shm files"),
    );
    expect(readFileSync(dbPath).equals(before)).toBe(true);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    const db = openDb({ dbPath });
    try {
      expect(db.getSession("sess_export")?.prompt).toBe("Export me");
    } finally {
      db.close();
    }
  });
});
