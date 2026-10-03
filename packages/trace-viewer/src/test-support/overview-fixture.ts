// Test-only: this repository's overview fixture (lane 06, P-5), parsed with the contracts schema.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OverviewSnapshotSchema, type OverviewSnapshot } from "@jevcode/contracts";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures");

export type OverviewFixtureName = "jevcode" | "jevcode-rule";

export function overviewFixturePath(name: OverviewFixtureName): string {
  return path.join(FIXTURES, `overview-${name}.json`);
}

export function loadOverviewFixture(name: OverviewFixtureName): OverviewSnapshot {
  return OverviewSnapshotSchema.parse(JSON.parse(readFileSync(overviewFixturePath(name), "utf8")));
}
