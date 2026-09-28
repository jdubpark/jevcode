import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TraceBundleSchema, isTraceRowType } from "@jevcode/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { runReplay } from "./cli-entry.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../");

const tempDirs: string[] = [];

afterEach(() => {
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
