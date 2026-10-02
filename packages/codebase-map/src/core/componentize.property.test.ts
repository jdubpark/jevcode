import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { ComponentIndex, componentIdFor, componentize, type ComponentDraft } from "./componentize.js";
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

/** A package one or two files from the 150-file split threshold, so batches move files between parts. */
const nearSplitArb = fc
  .uniqueArray(
    fc.tuple(fc.constantFrom("x", "y", "z/deep", "test"), fc.nat({ max: 400 })).map(([dir, n]) => `packages/big/src/${dir}/f${n}.ts`),
    { minLength: 148, maxLength: 152 },
  )
  .map((paths) => paths.map(toFile));

/** One batch of watcher changes: new paths, re-hashed members and removed members. */
const batchArb = fc.array(
  fc.record({ kind: fc.constantFrom("add", "edit", "remove"), path: fc.oneof(pathArb, fc.nat({ max: 500 }).map((n) => `packages/big/src/x/n${n}.ts`)), pick: fc.nat() }),
  { minLength: 1, maxLength: 4 },
);

describe("ComponentIndex (spec §6.1: only dirty components are recomputed)", () => {
  it("equals a fresh componentize after any sequence of adds, edits and removes, and reports every changed draft", () => {
    fc.assert(
      fc.property(fc.oneof(filesArb, bigPackageArb, nearSplitArb), fc.boolean(), fc.array(batchArb, { minLength: 1, maxLength: 12 }), (start, workspace, batches) => {
        const layout = layoutFor(start, workspace);
        const current = new Map(start.map((f) => [f.path, f]));
        let index = ComponentIndex.build(start, layout);
        for (const batch of batches) {
          const upserts = new Map<string, ScannedFile>();
          const removed = new Set<string>();
          for (const op of batch) {
            const members = [...current.keys()].filter((path) => !removed.has(path) && !upserts.has(path));
            if (op.kind === "add" && !current.has(op.path) && !upserts.has(op.path)) upserts.set(op.path, toFile(op.path));
            if (op.kind !== "add" && members.length > 0) {
              const path = members[op.pick % members.length] as string;
              if (op.kind === "edit") upserts.set(path, { ...(current.get(path) as ScannedFile), hash: sha1Hex(`${path}!${op.pick}`) });
              else removed.add(path);
            }
          }
          const before = byId(index.drafts());
          const plan = index.plan([...upserts.values()], [...removed]);
          const change = index.apply([...upserts.values()], [...removed]);
          expect(plan === null).toBe(change === null);
          for (const path of removed) current.delete(path);
          for (const file of upserts.values()) current.set(file.path, file);
          if (change === null) {
            index = ComponentIndex.build([...current.values()], layout);
            continue;
          }
          const fresh = componentize([...current.values()], layout);
          expect(index.drafts()).toEqual(fresh);
          const after = byId(fresh);
          for (const id of new Set([...before.keys(), ...after.keys()])) {
            if (JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id))) expect(change.changed.has(id)).toBe(true);
            if (!after.has(id)) expect(change.removed.has(id)).toBe(true);
          }
          for (const draft of fresh) {
            for (const path of draft.files) {
              expect(index.componentOf(path)).toBe(draft.id);
              const was = [...before.values()].find((old) => old.files.includes(path));
              if (was !== undefined && was.id !== draft.id) expect(change.movedFrom.has(was.id)).toBe(true);
            }
          }
          for (const path of removed) expect(index.componentOf(path)).toBeUndefined();
        }
      }),
      { numRuns: 150 },
    );
  });

  it("keeps the drafts of untouched parts when a split group gains a file, and plans the cost", () => {
    const paths = ["x", "y", "z"].flatMap((dir) => Array.from({ length: 100 }, (_, n) => `src/app/${dir}/f${n}.ts`));
    const index = ComponentIndex.build(paths.map(toFile), emptyManifest());
    const before = byId(index.drafts());
    expect([...before.values()].map((d) => d.rootPath)).toEqual(["src/app/x", "src/app/y", "src/app/z"]);
    const extra = toFile("src/app/y/extra.ts");
    expect(index.plan([extra], [])).toEqual({ files: 301 });
    const change = index.apply([extra], []);
    const after = byId(index.drafts());
    expect(change?.changed).toEqual(new Set([componentIdFor("src/app/y")]));
    expect(after.get(componentIdFor("src/app/x"))).toBe(before.get(componentIdFor("src/app/x")));
    expect(after.get(componentIdFor("src/app/y"))?.files).toHaveLength(101);
    expect(index.plan([{ ...extra, hash: "edited" }], [])).toEqual({ files: 101 });
  });

  it("moves members between parts when a group crosses the 150-file split threshold", () => {
    const paths: string[] = [...Array.from({ length: 75 }, (_, n) => `src/app/x/f${n}.ts`), ...Array.from({ length: 75 }, (_, n) => `src/app/y/f${n}.ts`)];
    const index = ComponentIndex.build(paths.map(toFile), emptyManifest());
    expect(index.drafts().map((d) => d.rootPath)).toEqual(["src/app"]);
    const whole = index.componentOf("src/app/x/f0.ts") as string;

    const split = index.apply([toFile("src/app/x/extra.ts")], []);
    expect(index.drafts().map((d) => d.rootPath)).toEqual(["src/app/x", "src/app/y"]);
    expect(split?.movedFrom).toEqual(new Set([whole]));
    expect(split?.removed).toEqual(new Set([whole]));

    const merged = index.apply([], ["src/app/x/extra.ts"]);
    expect(index.drafts().map((d) => d.rootPath)).toEqual(["src/app"]);
    expect(merged?.movedFrom).toEqual(new Set([componentIdFor("src/app/x"), componentIdFor("src/app/y")]));
  });
});
