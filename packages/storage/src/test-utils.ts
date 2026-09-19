import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach } from "vitest";

import { JevcodeDb, openDb } from "./index.js";

const tempDirs: string[] = [];

export function tempDbPath(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jevcode-storage-"));
  tempDirs.push(dir);
  return path.join(dir, "test.db");
}

export function openTempDb(): JevcodeDb {
  return openDb({ dbPath: tempDbPath() });
}

export function openSessionDb(sessionId = "sess_fixture"): JevcodeDb {
  const db = openTempDb();
  db.upsertRepository({
    id: "repo_fixture",
    path: "/work/fixture",
    gitRoot: "/work/fixture",
  });
  db.createSession({ id: sessionId, repoId: "repo_fixture" });
  return db;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});
