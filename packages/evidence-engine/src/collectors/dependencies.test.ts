import type { EvidenceFact } from "@jevcode/contracts";
import { describe, expect, it } from "vitest";

import {
  createDependencyCollector,
  diffManifests,
  parseManifest,
} from "./dependencies.js";

type DependencyFact = Extract<EvidenceFact, { type: "dependency_change" }>;

const BASE_MANIFEST = JSON.stringify({
  name: "demo",
  dependencies: { express: "^4.19.2", axios: "^1.7.0" },
  devDependencies: { vitest: "^3.0.5" },
});

const CURRENT_MANIFEST = JSON.stringify({
  name: "demo",
  dependencies: { express: "^4.19.2", zod: "^3.24.1" },
  devDependencies: { vitest: "^3.0.5" },
});

describe("parseManifest", () => {
  it("parses dependency sections", () => {
    const manifest = parseManifest(BASE_MANIFEST);
    expect(manifest?.dependencies).toEqual({
      express: "^4.19.2",
      axios: "^1.7.0",
    });
    expect(manifest?.devDependencies).toEqual({ vitest: "^3.0.5" });
  });

  it("returns null for invalid JSON", () => {
    expect(parseManifest("{ not json")).toBeNull();
  });

  it("returns null for null input", () => {
    expect(parseManifest(null)).toBeNull();
  });

  it("normalizes empty versions to wildcard", () => {
    const manifest = parseManifest('{"dependencies": {"local-pkg": ""}}');
    expect(manifest?.dependencies?.["local-pkg"]).toBe("*");
  });
});

describe("diffManifests", () => {
  it("detects added and removed dependencies", () => {
    const diff = diffManifests(
      parseManifest(BASE_MANIFEST),
      parseManifest(CURRENT_MANIFEST),
    );
    expect(diff.added).toEqual([{ name: "zod", version: "^3.24.1" }]);
    expect(diff.removed).toEqual([{ name: "axios", version: "^1.7.0" }]);
  });

  it("treats a version bump as remove+add", () => {
    const diff = diffManifests(
      { dependencies: { pkg: "^1.0.0" } },
      { dependencies: { pkg: "^2.0.0" } },
    );
    expect(diff.removed).toEqual([{ name: "pkg", version: "^1.0.0" }]);
    expect(diff.added).toEqual([{ name: "pkg", version: "^2.0.0" }]);
  });

  it("merges dependencies and devDependencies sections", () => {
    const diff = diffManifests(
      { dependencies: { a: "1" }, devDependencies: { b: "2" } },
      { dependencies: { a: "1" }, devDependencies: { c: "3" } },
    );
    expect(diff.removed).toEqual([{ name: "b", version: "2" }]);
    expect(diff.added).toEqual([{ name: "c", version: "3" }]);
  });

  it("is empty for identical manifests", () => {
    expect(diffManifests(parseManifest(BASE_MANIFEST), parseManifest(BASE_MANIFEST))).toEqual({
      added: [],
      removed: [],
    });
  });
});

describe("createDependencyCollector", () => {
  const baseOpts = {
    repoId: "repo-1",
    sessionId: "sess-1",
    now: () => "2026-01-01T00:00:00.000Z",
  };

  it("emits a manifest dependency_change fact", () => {
    const collector = createDependencyCollector("/repo", baseOpts);
    const fact = collector.collectManifestChange(BASE_MANIFEST, CURRENT_MANIFEST);
    expect(fact).toMatchObject({
      type: "dependency_change",
      manifest: "package.json",
      added: [{ name: "zod", version: "^3.24.1" }],
      removed: [{ name: "axios", version: "^1.7.0" }],
    });
    expect(collector.facts).toHaveLength(1);
  });

  it("emits nothing when the manifest is unchanged", () => {
    const collector = createDependencyCollector("/repo", baseOpts);
    expect(collector.collectManifestChange(BASE_MANIFEST, BASE_MANIFEST)).toBeNull();
    expect(collector.facts).toHaveLength(0);
  });

  it("emits a lockfile-only fact when only the lockfile changed", () => {
    const collector = createDependencyCollector("/repo", baseOpts);
    const facts = collector.collect(BASE_MANIFEST, BASE_MANIFEST, [
      "pnpm-lock.yaml",
      "src/index.ts",
    ]);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      type: "dependency_change",
      manifest: "pnpm-lock.yaml",
      added: [],
      removed: [],
    });
  });

  it("prefers the manifest diff over lockfile-only when both changed", () => {
    const collector = createDependencyCollector("/repo", baseOpts);
    const facts = collector.collect(BASE_MANIFEST, CURRENT_MANIFEST, [
      "package.json",
      "pnpm-lock.yaml",
    ]) as DependencyFact[];
    expect(facts).toHaveLength(1);
    expect(facts[0]?.manifest).toBe("package.json");
    expect(facts[0]?.added).toHaveLength(1);
  });

  it("emits nothing for lockfile-only with no known lockfile", () => {
    const collector = createDependencyCollector("/repo", baseOpts);
    expect(collector.collect(BASE_MANIFEST, BASE_MANIFEST, ["src/index.ts"])).toEqual([]);
    expect(collector.collectLockfileChange("notes.md")).toBeNull();
  });

  it("emits a lockfile fact via collectLockfileChange", () => {
    const collector = createDependencyCollector("/repo", baseOpts);
    const fact = collector.collectLockfileChange("yarn.lock");
    expect(fact).toMatchObject({ manifest: "yarn.lock", added: [], removed: [] });
  });
});
