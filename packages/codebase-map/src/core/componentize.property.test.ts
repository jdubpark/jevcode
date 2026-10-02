import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { componentize, type ComponentDraft } from "./componentize.js";
import { languageOf } from "./paths.js";
import { sha1Hex } from "./sha1.js";
import { emptyManifest, type ScannedFile, type WorkspaceManifest } from "./types.js";

const SEGMENTS = ["src", "lib", "packages", "apps", "docs", "scripts", "a", "b", "c", "test", "__tests__", "ui"];
const NAMES = ["index.ts", "a.ts", "b.tsx", "c.test.ts", "d.py", "e.json", "README.md", "f.config.ts"];

const pathArb = fc
  .tuple(fc.array(fc.constantFrom(...SEGMENTS), { maxLength: 4 }), fc.constantFrom(...NAMES), fc.nat({ max: 60 }))
  .map(([dirs, name, n]) => [...dirs, `${n}-${name}`].join("/"));
const toFile = (path: string): ScannedFile => ({ path, hash: sha1Hex(path), size: 1, language: languageOf(path) });
const filesArb = fc.uniqueArray(pathArb, { minLength: 1, maxLength: 300 }).map((paths) => paths.map(toFile));
/** Many files under one package, so the split rule runs. */
const bigPackageArb = fc
  .uniqueArray(
    fc.tuple(fc.constantFrom("x", "y", "z", "test"), fc.nat({ max: 400 })).map(([dir, n]) => `packages/big/src/${dir}/f${n}.ts`),
    { minLength: 151, maxLength: 320 },
  )
  .map((paths) => paths.map(toFile));

/** Workspace mode when requested: every packages/<x> directory that holds files is a package. */
function layoutFor(files: readonly ScannedFile[], workspace: boolean): WorkspaceManifest {
  if (!workspace) return emptyManifest();
  const dirs = new Set(
    files.filter((f) => f.path.startsWith("packages/") && f.path.split("/").length > 2).map((f) => f.path.split("/").slice(0, 2).join("/")),
  );
  return { ...emptyManifest(), packageDirs: [...dirs].sort() };
}

function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

const byId = (drafts: readonly ComponentDraft[]): Map<string, ComponentDraft> => new Map(drafts.map((d) => [d.id, d]));

describe("componentize properties (spec §12)", () => {
  it("puts every file in exactly one component", () => {
    fc.assert(
      fc.property(fc.oneof(filesArb, bigPackageArb), fc.boolean(), (files, workspace) => {
        const drafts = componentize(files, layoutFor(files, workspace));
        const members = drafts.flatMap((draft) => draft.files);
        expect(members).toHaveLength(files.length);
        expect(new Set(members)).toEqual(new Set(files.map((f) => f.path)));
        expect(new Set(drafts.map((d) => d.id)).size).toBe(drafts.length);
      }),
      { numRuns: 200 },
    );
  });

  it("is deterministic for any input order", () => {
    fc.assert(
      fc.property(filesArb, fc.boolean(), fc.integer(), (files, workspace, seed) => {
        const layout = layoutFor(files, workspace);
        expect(componentize(seededShuffle(files, seed), layout)).toEqual(componentize(files, layout));
      }),
      { numRuns: 100 },
    );
  });

  it("keeps ids, members and content hashes when files are added outside a component", () => {
    fc.assert(
      fc.property(filesArb, fc.uniqueArray(pathArb, { minLength: 1, maxLength: 40 }), (files, extra) => {
        const before = componentize(files, emptyManifest());
        const after = byId(componentize([...files, ...extra.map((p) => toFile(`zz-extra/${p}`))], emptyManifest()));
        for (const draft of before) {
          const same = after.get(draft.id);
          expect(same?.rootPath).toBe(draft.rootPath);
          expect(same?.files).toEqual(draft.files);
          expect(same?.contentHash).toBe(draft.contentHash);
        }
      }),
      { numRuns: 150 },
    );
  });

  it("changes a content hash only for the component whose member file changed", () => {
    fc.assert(
      fc.property(fc.oneof(filesArb, bigPackageArb), fc.nat(), (files, pick) => {
        const index = pick % files.length;
        const target = files[index] as ScannedFile;
        const edited = files.map((f, i) => (i === index ? { ...f, hash: sha1Hex(`${f.hash}!`) } : f));
        const before = componentize(files, emptyManifest());
        const after = byId(componentize(edited, emptyManifest()));
        for (const draft of before) {
          const same = after.get(draft.id) as ComponentDraft;
          if (draft.files.includes(target.path)) expect(same.contentHash).not.toBe(draft.contentHash);
          else expect(same.contentHash).toBe(draft.contentHash);
        }
      }),
      { numRuns: 150 },
    );
  });
});
