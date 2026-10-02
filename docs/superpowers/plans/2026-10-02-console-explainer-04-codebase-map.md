# Console explainer Lane 04: Codebase map — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a repo into a deterministic, capped component map. A new pure package `@jevcode/codebase-map` cuts files into components, collapses imports into component edges, guesses roles and assembles an `OverviewSnapshot`. `@jevcode/evidence-engine` extracts and resolves import specifiers with tree-sitter. A desktop explainer stage scans in the background, rebuilds after file changes, and writes `overview_snapshot` rows, `overview_state` and push hints. The lane also fixes the ArchitectureDelta edge ids and adds the scan bench and the ingest soak guard.

**Architecture:** `packages/codebase-map/src/core/**` is pure TypeScript (no Node built-ins, enforced by ESLint and a lint-boundary test). It hashes with its own pure SHA-1 (`core/sha1.ts`), because the repo's only SHA-1 helpers use `node:crypto` (`semantic-core/src/ids.ts`, `contracts/src/node.ts`) and `crypto.subtle` is async while `componentIdFor` is sync. `src/node/scan.ts` lists files with `git ls-files`, applies the skips and the 20,000-file cap, hashes each file once and hands the decoded text to a `visit` callback. The desktop stage's visitor calls `extract` (a worker-pool import extractor from evidence-engine) on that text, so each file is read once. `apps/desktop/src/main/pipeline/explainer-overview.ts` turns the scan into a `RepoModel` and a `BuiltOverview`; `explainer-stage.ts` owns scheduling, rows, state, push hints, progress, failure and the narration seam that lane 05 plugs into.

**Tech Stack:** TypeScript 5.9 (NodeNext, strict, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`), zod 3 (via `@jevcode/contracts`), web-tree-sitter 0.22 with `tree-sitter-wasms`, vitest 3 (`vitest bench --run` for budgets), fast-check 4.10.1, better-sqlite3 through `@jevcode/storage`, pnpm 9.15 workspaces, Node 22.

**Spec:** `docs/superpowers/specs/2026-10-02-console-and-explainer-design.md` §5, §6.1, §6.5, §6.6, §10, §11 (the spec). **Interfaces (binding):** `docs/superpowers/plans/2026-10-02-console-explainer-interfaces.md` §3 and §5. **Index:** `docs/superpowers/plans/2026-10-02-console-explainer-00-index.md` (task ids, waves, Review Focus 1, budgets). On a conflict the spec wins, then the interfaces file, then this file; every departure is listed below.

## Interface deviations

Every name in interfaces §3 and §5 is kept. These additions and changes follow the real code; each is additive unless stated.

1. **`ExplainerStageDeps.db: JevcodeDb`**, not `Db`. `@jevcode/storage` exports the class `JevcodeDb` (`packages/storage/src/index.ts`); there is no `Db` type.
2. **`ExplainerStageDeps.narrator` is not added by lane 04.** `NarratorClient` is created by lane 05 (N-1/N-2), which merges after lane 04, so lane 04 cannot import its type. Lane 04 adds `narration?: (ctx: NarrationContext) => NarrationSeam` instead, with `NO_NARRATION` as the default. Lane 05 N-5 builds the seam from its narrator client and passes it in `apps/desktop/src/main/index.ts`; no lane-04 function body changes. `NarrationSeam`, `NarrationContext` and `OverviewView` are exported from `explainer-stage.ts`.
3. **`ExplainerStageDeps.scanPaths: typeof scanPaths`** (new). Incremental rebuilds re-read only the changed files; `scanPaths` is exported from `@jevcode/codebase-map/node` beside `scanRepo`.
4. **`ExplainerStageDeps.onStatus?(status: ExplainerStatus): void`**, **`ExplainerStage.status(): ExplainerStatus`** and **`ExplainerStage.whenIdle(): Promise<void>`** (new). In-process views of scan progress and failure; the viewer reads them from `status` on the rows (ruling R3, item 14). `whenIdle` lets tests, the bench and the soak wait for the background scan.
5. **`ExplainerLogEvent` gains `{ kind: "error"; where: "scan" | "rebuild" | "write" | "state"; message: string }`.** Spec §6.6 says a scan failure is logged; the union had no error variant.
6. **`ScanOptions.visit?(file: ScannedFile, source: string): Promise<void> | void`** and **`ScanResult.tsconfig: TsconfigPaths`** (new; `TsconfigPaths { paths: Record<string, string[]>; baseUrl: string | null }` in `core/types.ts`). The visitor lets the stage extract imports from the text the scan already read; `tsconfig` carries `paths`/`baseUrl` to `ResolveContext`.
7. **`extractImports` returns `{ specifiers: string[]; exports: string[] }`** (`exports` added). Lane 05's `ComponentBrief.exports` (interfaces §4) needs the top 15 exported names per component, and only this parse pass sees them. The type is exported as `ExtractedImports`.
8. **`ComponentDraft.importsAnalyzed: boolean`** (new). `Component.importsAnalyzed` (interfaces §1.2) needs per-file grammar knowledge that the draft alone did not carry.
9. **New evidence-engine exports:** `createImportExtractor(options?): ImportExtractor` (`{ extract: typeof extractImports; dispose(): Promise<void> }`, a lazily started `AnalysisPool` that stops after 30 s idle), `AnalysisPool.extractImports(filePath, source)`, `TreeSitterBackend.imports(source, language)`, `packageNameOf(specifier)`. The desktop passes `extractor.extract` as the stage's `extract`; the module-level `extractImports` runs inline (tests, fallback).
10. **`WorkspaceManifest.packageNames["."]` and `descriptions["."]`** hold the root `package.json` name and description. The type is unchanged.
11. **New `@jevcode/codebase-map` core exports:** `contentHash(members)`, `sha1Hex`, `utf8ByteLength`, `CONFIG_COMPONENT_NAME`, `TOOLING_DIRS`, `ComponentText`, `AssembleSnapshotInput`, `OTHER_ROOT_PATH`, `buildManifest`, `tsconfigFromTexts`, path helpers (`languageOf`, `isTestPath`, `isConfigFile`, `isSkippedPath`, `compareText`, `clipText`). `assembleSnapshot` takes `AssembleSnapshotInput`, the same shape as the interface's inline type.
12. **Desktop wiring names (new):** `PipelineRuntimeOptions.onRepoFilesChanged?(repoPath, paths)`, `IpcDeps.explainer?: ExplainerRegistry`, `createExplainerRegistry(factory)`. One stage exists per open repo; the registry routes repo-open, session-start, file-change and rescan calls to it.
13. **`ExplainerStage.onPipelineSync` is a documented no-op** in lane 04. Lane 07 S-2 owns its body.
14. **Rulings R3 and R4 (orchestrator, 2026-10-02).** `ScanResult.totalFiles` and `AssembleSnapshotInput.totalFiles?` fill `counts.totalFiles`. Every snapshot row carries `status` (`OverviewStatus`): progress rows for scans over 2 s (`SCAN_PROGRESS_AFTER_MS`), a failed row on scan failure, `done` otherwise. `ExplainerStageDeps.explainWithModel?(): boolean` feeds narrator "off". `NarrationSeam` gains the optional `setNarrator?(narrator: unknown)` and `narratorStatus?(): NarratorState`; `ExplainerStage.setNarrator` belongs to lane 05 N-5, not lane 04.

## Spec alignment notes

- **Untracked files are mapped.** The scan runs `git ls-files --cached --others --exclude-standard`, so `.gitignore` is respected (spec §5.1) and files the agent creates before a commit appear on the map. Spec §5.1 says "files git tracks".
- **Splitting descends and repeats** (spec §5.2 rule 3). "Splits by its next directory level" is read as the next level that branches: when every subdirectory file sits under one directory, the split descends into it. A part that still has more than 150 files splits again by the same rule, and part names drop `src`/`lib` segments. Test directories (`test/`, `tests/`, `__tests__/`) never become parts; they stay with the files above the split level. On this repo, `packages/trace-viewer` (236 files: `src/**` plus one `scripts/` file) becomes `@jevcode/trace-viewer/root` (4 package files), `/scripts`, `/src` (5 files directly in `src`), `/layout`, `/model`, `/sources`, `/test-support` and `/ui` (133). A single split level would have left one 231-file `src` part.
- **The repo-root component.** Files directly at the repo root form one component, `rootPath "."`, named `config` (role `config`), when any other component exists. When every file sits at the root, that single component is named after the root package (`packageNames["."]`) or `root`, and its role follows the normal rules.
- **Top-level leftovers.** In workspace mode, files outside every package and app (`docs/`, `fixtures/`, `scripts/`) become one component per top-level directory. `scripts/`, `tools/` and `.github/` each form a `tooling` component (spec rule 4 names one tooling component; one per directory keeps `rootPath` a real path).
- **Node built-ins are not external dependencies.** `node:fs`, `fs/promises` and other built-ins resolve to `unresolved` and never become dependency chips. Spec §5.1 is silent.
- **Role rule tokens.** "Path or name contains `ui`" is matched on word tokens (split on `/`, `-`, `_`, `.`, `@`), so `packages/guide` is not `ui`. Rules 3 and 4 check the name only, as the spec says.
- **Incremental rebuild recomputes the component set from the file map** after re-parsing only the changed files. Spec §6.1 says "only dirty components are recomputed"; the observable contract (content hashes change only for components whose member files changed, and incremental equals fresh) is tested directly. Componentizing 20,000 paths is pure and takes milliseconds; parsing is the cost spec §6.1 bounds.
- **Manifest edits trigger a full rescan.** A change to any `package.json`, `pnpm-workspace.yaml`, root `tsconfig*.json` or `.gitignore` reruns the scan, because it can move component boundaries or resolution.
- **Snapshot counts are true totals.** `counts.components` and `counts.edges` hold the values before the 200 and 1,000 caps, so the Map can say "200 of 340 components". `counts.files` is the number of files mapped (at most 20,000).
- **"Fresh overview state"** (spec §5.1 and §6.1) means a scan completed in this app run. A repo open always scans; a session start scans only when no scan has completed or is running.
- **Rows for the repo-open session.** The app creates an idle session when a repo opens (`openRepoByPath`). The stage writes the first snapshot row to it, so the Map is visible before the first prompt (spec §11, "≤ 2 s after repo open"). That session is the one the first prompt starts, so it gets no duplicate row.

## Spec gaps (for the orchestrator)

1. **Resolved by ruling R3:** scan progress and failure reach the viewer as `status` on `overview_snapshot` rows (M-6). `ExplainerStage.status()` and `onStatus` stay as in-process views of the same state.
2. **Resolved by ruling R3:** `counts.totalFiles` carries the repo total for partial maps (M-3, M-5).
3. **M-7's id mismatch is not in ui-catalog.** `buildArchitectureData` (`apps/desktop/src/main/pipeline/ui-stage.ts:402`) names nodes `file:<path>`, `sym:<symbol.id>` and `dep:<name>`, while `ctx.graphEdges` come from `projectGraph` (`packages/semantic-core/src/graph.ts`) with hashed ids such as `file_21f275da5646ed5c`. The filter `nodeIds.has(edge.from)` therefore drops every edge, and every ArchitectureDelta surface is drawn without edges (confirmed with a probe on a two-file unit). M-7 fixes the producer and also makes the ui-catalog component ignore dangling edges so `data-edge-count` counts drawn edges.
4. **Trace session lists will include idle repo-open sessions** that hold only an `overview_snapshot` row. Lane 06 or the trace window may want to hide sessions without agent rows.

## Lane prerequisites

- **Wave:** W1. W0 (lanes 01 and 02a) is merged into `main`. Lane 04 merges first in W1, before lane 05.
- **Verify W0 on `main`:**

```bash
git -C ~/Projects/jevcode show main:packages/contracts/src/overview.ts | grep -cE "export const (OverviewSnapshotSchema|ROLES|OVERVIEW_SNAPSHOT_MAX_BYTES)"
git -C ~/Projects/jevcode show main:packages/contracts/src/trace.ts | grep -c '"overview_snapshot"'
git -C ~/Projects/jevcode show main:packages/storage/src/db.ts | grep -cE "getOverviewState|putOverviewState"
git -C ~/Projects/jevcode grep -n '"trace:rowsAvailable"\|"overview:rescan"' main -- packages/contracts/src apps/desktop/src/shared apps/desktop/src/main
```

Expected: `3`, at least `2`, at least `2`, and lines naming the K-3 constants for `trace:rowsAvailable` and `overview:rescan`. This plan writes them as `MainToRendererChannels.traceRowsAvailable` and `RendererToMainChannels.overviewRescan`; if K-3 named them differently (for example in `RendererToMainLocalChannels`), use K-3's names everywhere this plan uses these two. If K-3 already registered an `overview:rescan` handler in `apps/desktop/src/main/ipc.ts`, M-6 replaces that handler's body instead of adding a second one.

- **Worktree** (once):

```bash
git -C ~/Projects/jevcode worktree add -b ce/04-map ~/Projects/jevcode-ce-04 <w0>
bash ~/Projects/jevcode/.superpowers/orchestration/setup-worktree.sh ~/Projects/jevcode-ce-04
```

Every later command runs from `~/Projects/jevcode-ce-04` (prefix `cd ~/Projects/jevcode-ce-04 && ` if the shell does not keep the directory).

- **Baseline:** `perl -e 'alarm 170; exec @ARGV' pnpm -r typecheck` exits 0 and `perl -e 'alarm 170; exec @ARGV' pnpm lint` prints nothing after `> pnpm exec eslint .`.
- **Plan documents:** if `git ls-files docs/superpowers` prints nothing in the worktree, read the spec, index and interfaces by absolute path from `~/Projects/jevcode` and never commit them from this lane.

## Global Constraints

The index's Global Constraints apply. Lane additions:

- `packages/codebase-map/src/core/**` imports no Node built-in, no `electron`, nothing from `src/node`, and uses no Node global (`process`, `Buffer`, `require`, `__dirname`, …). ESLint enforces it (M-1) and `src/core/lint-boundary.test.ts` pins it.
- No new npm dependency. `packages/codebase-map` uses only versions already in `pnpm-lock.yaml` (`fast-check 4.10.1`, `eslint 9.39.5`, `vitest ^3.0.5`, `typescript ^5.7.3`, `@types/node ^22.13.0`). New workspace links (`@jevcode/codebase-map` in `apps/desktop`) update the lockfile with `pnpm install`.
- Caps: 20,000 files per scan, 1 MiB per file, components split above 150 files, at most 200 components, 1,000 edges, 120 externals and 512 KB per snapshot row (spec §5).
- The scan never follows symlinks (it uses `lstat`), never reads a path that escapes the repo root, and skips secret-like files before reading them (spec §10). No file content leaves the scan except to the in-process import extractor.
- Scan and rebuild failures are logged and shown as status; they never throw into the pipeline, IPC handlers or ingestion (spec §6.6). The stage catches every error at its boundary.
- Only files listed in a task's **Files** block change. `fixtures/**` and `docs/SPEC.md` are out of bounds.
- Hang safety: wrap every vitest run as `perl -e 'alarm 150; exec @ARGV' pnpm --filter <pkg> exec vitest run <file>`. Benches and soaks run in the background with hard timeouts; kill what you start.
- Desktop tests import workspace packages from `dist`: run `perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/codebase-map build && perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/evidence-engine build` before desktop tests whenever those packages changed.
- Commits: one conventional commit per task, listing its files in `git add`. Use `git -c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com commit`. No `Claude-Session:` and no `Co-Authored-By` trailers. Never `git stash`, `git reset --hard` or `git clean`.

## Review Focus (lane slice)

1. **A repo in an unsupported language, or a huge or partial repo** (index Review Focus 1). Expected: a Python repo yields components with `importsAnalyzed: false`, no edges and a schema-valid snapshot; a 25,200-file repo yields `partial: true`, exactly 20,000 mapped files, 200 components with an `other` group, true counts and a row under 512 KB. Tests: **M-5** `scan.test.ts` "maps a Python repo …" and "flags a 25,200-file repo as partial …".
2. **Incremental equals fresh.** After file changes settle, the incrementally rebuilt snapshot equals a fresh scan of the same files, only changed files are re-parsed, and untouched components keep their content hash. Tests: **M-6** `explainer-stage.test.ts` "re-parses only changed files …" and **M-1** `componentize.property.test.ts`.
3. **Hostile repo contents.** Symlinks out of the repo, `../` paths from the watcher, secrets-like files, LFS pointers, binaries and >1 MiB files are never read or mapped. Tests: **M-5** `skip.test.ts` (`isSkippedPath`, `normalizePath` tables), `scan.test.ts` "lists tracked and untracked files, skips …" (with a symlink to `/etc/hosts`) and "re-reads changed files and reports … escaping paths as gone".
4. **Scan failure never touches agent work.** A failing scan logs, writes one `failed` status row (previous components or none, error clipped to 200 characters), never touches `overview_state` and throws nothing; Retry rescans; a failing file hook never drops an ingested record. Tests: **M-6** stage failure test and `pipeline-runtime.test.ts` hook test.
5. **ArchitectureDelta edges.** A change unit whose files import each other renders its edges. Test: **M-7** `ui-stage.test.ts`.

## File structure

| File | Responsibility | Task |
|---|---|---|
| `packages/codebase-map/package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts` | Package scaffold; exports `.` (core) and `./node` | M-1 |
| `eslint.config.mjs` | Core purity block | M-1 |
| `packages/codebase-map/src/core/types.ts` | `ScannedFile`, `ImportEdge`, `ExternalImport`, `WorkspaceManifest`, `TsconfigPaths` | M-1 |
| `packages/codebase-map/src/core/sha1.ts` | Pure SHA-1 and UTF-8 helpers | M-1 |
| `packages/codebase-map/src/core/paths.ts` | Path, language, test, config helpers (M-5 adds `isSkippedPath`, `normalizePath`) | M-1, M-5 |
| `packages/codebase-map/src/core/componentize.ts` | Cut rules, ids, content hash, `componentOf` | M-1 |
| `packages/codebase-map/src/core/lint-boundary.test.ts` | Pins the purity ban | M-1 |
| `packages/codebase-map/src/core/edges.ts` | `aggregateEdges`, `aggregateExternals` | M-2 |
| `packages/codebase-map/src/core/roles.ts` | `guessRole` | M-2 |
| `packages/codebase-map/src/core/snapshot.ts` | `assembleSnapshot`, caps, size bound | M-3 |
| `packages/codebase-map/src/core/manifest.ts` | Workspace globs, manifest, JSONC, tsconfig paths | M-5 |
| `packages/codebase-map/src/core/index.ts` | Core barrel (each task appends) | M-1, M-2, M-3, M-5 |
| `packages/codebase-map/src/node/scan.ts`, `index.ts` | `scanRepo`, `scanPaths` | M-5 |
| `packages/codebase-map/src/node/test-support/fixture-repos.ts` | Test-only fixture repos | M-5 |
| `packages/evidence-engine/src/worker/tree-sitter.ts` | `extractImportSpecifiers`, `ImportScan` | M-4 |
| `packages/evidence-engine/src/worker/parser.ts` | `TreeSitterBackend.imports` | M-4 |
| `packages/evidence-engine/src/worker/parse-worker.ts`, `parse-service.ts` | `op: "imports"`, `AnalysisPool.extractImports` | M-4 |
| `packages/evidence-engine/src/imports.ts` | `extractImports`, `createImportExtractor`, `resolveSpecifier` | M-4 |
| `apps/desktop/src/main/pipeline/explainer-overview.ts` | `RepoModel`, `scanRepoModel`, `applyFileChanges`, `buildOverview` | M-6 |
| `apps/desktop/src/main/pipeline/explainer-stage.ts` | Stage, registry, narration seam | M-6 |
| `apps/desktop/src/main/pipeline/types.ts`, `pipeline-runtime.ts` | `onRepoFilesChanged` hook | M-6 |
| `apps/desktop/src/main/ipc.ts`, `index.ts` | Registry wiring, `overview:rescan` | M-6 |
| `apps/desktop/src/main/pipeline/ui-stage.ts`, `ui-stage.test.ts` | ArchitectureDelta edge ids | M-7 |
| `packages/ui-catalog/src/components/ArchitectureDelta.tsx`, `p1.test.tsx` | Dangling-edge guard | M-7 |
| `apps/desktop/src/main/pipeline/explainer-overview.bench.ts` | Scan and map budgets | M-8 |
| `scripts/soak.mjs`, `docs/perf.md` | Explainer soak switch, recorded results | M-8 |

Order: M-1 → M-2 → M-3 → M-4 → M-5 → M-6 → M-8. M-7 is independent and may run at any point. One controller runs them on `ce/04-map`.

**Commands used by every task** (from `~/Projects/jevcode-ce-04`):

- Targeted test: `perl -e 'alarm 150; exec @ARGV' pnpm --filter <pkg> exec vitest run <path relative to the package>`.
- Package typecheck: `perl -e 'alarm 170; exec @ARGV' pnpm --filter <pkg> typecheck`. Lint: `perl -e 'alarm 170; exec @ARGV' pnpm lint` (prints nothing after `> pnpm exec eslint .`).
- Package names: `@jevcode/codebase-map`, `@jevcode/evidence-engine`, `@jevcode/ui-catalog`, `jevcode-desktop`.
- If a storage or desktop test fails with `NODE_MODULE_VERSION`, run `pnpm --filter jevcode-desktop run rebuild:node` (last line `native modules restored to node ABI`), restore node-pty per the index, and rerun.

---

### Task M-1: `@jevcode/codebase-map`: `componentize`, ids, content hash

**Files:**
- Create: `packages/codebase-map/package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`
- Create: `packages/codebase-map/src/core/types.ts`, `sha1.ts`, `paths.ts`, `componentize.ts`, `index.ts`
- Modify: `eslint.config.mjs` (append one block at the end of the config array), `pnpm-lock.yaml` (via `pnpm install`)
- Test: `packages/codebase-map/src/core/sha1.test.ts`, `paths.test.ts`, `componentize.test.ts`, `componentize.property.test.ts`, `lint-boundary.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (M-1 has no dependency in index §3).
- Produces (exported from `@jevcode/codebase-map`):
  - `interface ScannedFile { path: string; hash: string; size: number; language: string | null }`, `interface ImportEdge { from: string; to: string }`, `interface ExternalImport { from: string; packageName: string }`, `interface WorkspaceManifest { packageDirs: string[]; appDirs: string[]; packageNames: Record<string, string>; descriptions: Record<string, string>; entryPoints: Record<string, string[]> }`, `interface TsconfigPaths { paths: Record<string, string[]>; baseUrl: string | null }`, `emptyManifest(): WorkspaceManifest`
  - `sha1Hex(text: string): string`, `utf8Bytes(text: string): Uint8Array`, `utf8ByteLength(text: string): number`
  - `IMPORT_LANGUAGES`, `compareText`, `isUnder`, `dirnameOf`, `basenameOf`, `languageOf`, `isTestPath`, `isConfigFile`, `countLanguages`, `mainLanguage`, `clipText`
  - `SPLIT_THRESHOLD = 150`, `CONFIG_COMPONENT_NAME = "config"`, `FLAT_COMPONENT_NAME = "root"`, `TOOLING_DIRS`, `MAX_DRAFT_ENTRY_POINTS = 8`
  - `interface ComponentDraft { id: string; rootPath: string; name: string; files: string[]; language: string | null; contentHash: string; entryPoints: string[]; importsAnalyzed: boolean }`
  - `componentIdFor(rootPath: string): string`, `contentHash(members: readonly { path: string; hash: string }[]): string`, `componentize(files: readonly ScannedFile[], manifest: WorkspaceManifest): ComponentDraft[]`, `componentOf(drafts: readonly ComponentDraft[]): (filePath: string) => string | undefined`

**Hashing choice.** No pure SHA-1 exists in the repo: `semantic-core/src/ids.ts`, `contracts/src/node.ts`, `storage/src/db.ts` and `ui-stage.ts` all use `node:crypto`, which `src/core` may not import, and `crypto.subtle.digest` is async. `src/core/sha1.ts` is a small synchronous FIPS 180-4 SHA-1 over UTF-8; its tests compare it with `node:crypto` on test vectors, block boundaries and 300 random strings including lone surrogates. It hashes 1.2 MB in about 30 ms.

- [ ] **Step 1: Scaffold the package**

Create `packages/codebase-map/package.json`:

```json
{
  "name": "@jevcode/codebase-map",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/core/index.js",
  "types": "dist/core/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/core/index.d.ts",
      "import": "./dist/core/index.js"
    },
    "./node": {
      "types": "./dist/node/index.d.ts",
      "import": "./dist/node/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@jevcode/contracts": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^22.13.0",
    "eslint": "9.39.5",
    "fast-check": "4.10.1",
    "typescript": "^5.7.3",
    "vitest": "^3.0.5"
  }
}
```

Create `packages/codebase-map/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"]
}
```

Create `packages/codebase-map/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["src/**/*.test.ts", "src/**/*.bench.ts", "src/**/test-support/**"]
}
```

Create `packages/codebase-map/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
```

Run: `pnpm install`

Expected: exits 0; `git diff --stat pnpm-lock.yaml` shows only the new `packages/codebase-map` importer block. No new tarball is downloaded (every version is already locked).

- [ ] **Step 2: Write the failing lint-boundary test**

Create `packages/codebase-map/src/core/lint-boundary.test.ts`:

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// Pins the core purity ban in eslint.config.mjs (spec §4.2). The probe files never exist on
// disk: ESLint lints the code as if it lived at filePath, so the path decides which blocks apply.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

let eslint: ESLint | undefined;

async function ruleIds(filePath: string, code: string): Promise<string[]> {
  eslint ??= new ESLint({ cwd: REPO_ROOT });
  const [result] = await eslint.lintText(code, { filePath: path.join(REPO_ROOT, filePath) });
  if (result === undefined) throw new Error(`ESLint returned no result for ${filePath}`);
  return result.messages.map((message) => message.ruleId ?? `fatal: ${message.message}`);
}

const CASES: { filePath: string; code: string; expected: string[] }[] = [
  {
    filePath: "packages/codebase-map/src/core/probe.ts",
    code: 'import { readFileSync } from "node:fs"; export const x = readFileSync;',
    expected: ["no-restricted-imports"],
  },
  {
    filePath: "packages/codebase-map/src/core/probe.ts",
    code: 'import path from "path"; export const x = path;',
    expected: ["no-restricted-imports"],
  },
  {
    filePath: "packages/codebase-map/src/core/probe.ts",
    code: 'import { scanRepo } from "../node/scan.js"; export const x = scanRepo;',
    expected: ["no-restricted-imports"],
  },
  {
    filePath: "packages/codebase-map/src/core/probe.ts",
    code: 'export const x = () => Buffer.from("a");',
    expected: ["no-restricted-globals"],
  },
  {
    filePath: "packages/codebase-map/src/core/probe.ts",
    code: 'export const x = () => import("node:fs");',
    expected: ["no-restricted-syntax"],
  },
  {
    filePath: "packages/codebase-map/src/core/probe.test.ts",
    code: 'import { readFileSync } from "node:fs"; export const x = readFileSync;',
    expected: [],
  },
  {
    filePath: "packages/codebase-map/src/node/probe.ts",
    code: 'import { readFileSync } from "node:fs"; export const x = readFileSync;',
    expected: [],
  },
];

describe("codebase-map core purity (spec §4.2)", () => {
  it.each(CASES)("$filePath: $code", async ({ filePath, code, expected }) => {
    expect(await ruleIds(filePath, code)).toEqual(expected);
  });
});
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/codebase-map exec vitest run src/core/lint-boundary.test.ts`

Expected: FAIL. The five `src/core/probe.ts` cases report `[]` instead of the expected rule ids (no block covers the package yet); the two last cases pass.

- [ ] **Step 3: Add the ESLint block**

In `eslint.config.mjs`, find the end of the config array:

```js
      "no-restricted-globals": ["error", ...NO_NETWORK_GLOBALS, ...NO_NODE_GLOBALS, ...LAYOUT_PURE_GLOBALS],
      "no-restricted-properties": ["error", ...NO_RESTRICTED_WINDOW_GLOBAL_PROPERTIES],
      "no-restricted-syntax": ["error", ...NODE_BUILTIN_DYNAMIC_IMPORT_BANS],
    },
  },
);
```

Replace it with:

```js
      "no-restricted-globals": ["error", ...NO_NETWORK_GLOBALS, ...NO_NODE_GLOBALS, ...LAYOUT_PURE_GLOBALS],
      "no-restricted-properties": ["error", ...NO_RESTRICTED_WINDOW_GLOBAL_PROPERTIES],
      "no-restricted-syntax": ["error", ...NODE_BUILTIN_DYNAMIC_IMPORT_BANS],
    },
  },
  {
    // Spec §4.2: the codebase-map core is pure TypeScript with no Node built-ins. Node-only
    // scanning lives in src/node, which only desktop main imports.
    files: ["packages/codebase-map/src/core/**/*.ts"],
    ignores: ["packages/codebase-map/src/core/**/*.test.ts", "packages/codebase-map/src/core/**/*.bench.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { regex: "^node:", message: "codebase-map core is pure: no Node built-ins (spec §4.2)." },
          { regex: NODE_BUILTIN_REGEX, message: "codebase-map core is pure: no Node built-ins (spec §4.2)." },
          { regex: "^electron(/.*)?$", message: "codebase-map core is pure (spec §4.2)." },
          { regex: "(^|/)node(/|$)", message: "src/core never imports src/node or Node-only entry points." },
        ],
      }],
      "no-restricted-globals": ["error", ...NO_NODE_GLOBALS],
      "no-restricted-syntax": ["error", ...NODE_BUILTIN_DYNAMIC_IMPORT_BANS],
    },
  },
);
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/codebase-map exec vitest run src/core/lint-boundary.test.ts`

Expected: PASS, `Tests  7 passed (7)`.

- [ ] **Step 4: Write the failing SHA-1 test**

Create `packages/codebase-map/src/core/sha1.test.ts`:

```ts
import { createHash } from "node:crypto";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { sha1Hex, utf8ByteLength, utf8Bytes } from "./sha1.js";

const nodeSha1 = (text: string): string => createHash("sha1").update(text, "utf8").digest("hex");

describe("sha1Hex", () => {
  it("matches the FIPS 180 test vectors", () => {
    expect(sha1Hex("")).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
    expect(sha1Hex("abc")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
    expect(sha1Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "84983e441c3bd26ebaae4aa1f95129e5e54670f1",
    );
  });

  it("matches node:crypto across the 64-byte block boundaries", () => {
    for (const length of [55, 56, 63, 64, 65, 119, 120, 128, 1_000, 100_000]) {
      const text = "a".repeat(length);
      expect(sha1Hex(text)).toBe(nodeSha1(text));
    }
  });

  it("matches node:crypto for any string, including astral characters and lone surrogates", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 300 }), (text) => {
        expect(sha1Hex(text)).toBe(nodeSha1(text));
      }),
      { numRuns: 300 },
    );
  });
});

describe("utf8Bytes and utf8ByteLength", () => {
  it("encode like Buffer, writing a lone surrogate as U+FFFD", () => {
    expect(Array.from(utf8Bytes("a\ud800"))).toEqual([0x61, 0xef, 0xbf, 0xbd]);
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 200 }), (text) => {
        const expected = Buffer.from(text, "utf8");
        expect(Array.from(utf8Bytes(text))).toEqual(Array.from(expected));
        expect(utf8ByteLength(text)).toBe(expected.length);
      }),
      { numRuns: 300 },
    );
  });
});
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/codebase-map exec vitest run src/core/sha1.test.ts`

Expected: FAIL with `Failed to resolve import "./sha1.js"`.

- [ ] **Step 5: Implement `types.ts` and `sha1.ts`**

Create `packages/codebase-map/src/core/types.ts`:

```ts
/** A file the scan kept (spec §5.1). `hash` is the sha1 hex of the file's bytes. */
export interface ScannedFile {
  path: string;
  hash: string;
  size: number;
  language: string | null;
}

/** A file-level import that resolved to another repo file. Paths are repo-relative. */
export interface ImportEdge {
  from: string;
  to: string;
}

/** A file-level import of a package outside the repo, by package name. */
export interface ExternalImport {
  from: string;
  packageName: string;
}

/**
 * Workspace layout read from pnpm-workspace.yaml and package.json files. Keys of the records
 * are package directories; "." holds the root package.json name and description.
 */
export interface WorkspaceManifest {
  packageDirs: string[];
  appDirs: string[];
  packageNames: Record<string, string>;
  descriptions: Record<string, string>;
  entryPoints: Record<string, string[]>;
}

/** Root tsconfig `paths` and `baseUrl`; targets are relative to `baseUrl ?? "."`. */
export interface TsconfigPaths {
  paths: Record<string, string[]>;
  baseUrl: string | null;
}

export function emptyManifest(): WorkspaceManifest {
  return { packageDirs: [], appDirs: [], packageNames: {}, descriptions: {}, entryPoints: {} };
}
```

Create `packages/codebase-map/src/core/sha1.ts`:

```ts
// Pure SHA-1 (FIPS 180-4) over UTF-8. src/core may not import node:crypto (spec §4.2), and
// Web Crypto's digest is async while componentIdFor and contentHash are synchronous. Lone
// surrogates encode as U+FFFD, exactly like Buffer.from(text, "utf8") and TextEncoder.

const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && isLowSurrogate(text.charCodeAt(i + 1))) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

export function utf8Bytes(text: string): Uint8Array {
  const out = new Uint8Array(utf8ByteLength(text));
  let at = 0;
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && isLowSurrogate(text.charCodeAt(i + 1))) {
      code = 0x10000 + ((code - 0xd800) << 10) + (text.charCodeAt(i + 1) - 0xdc00);
      i += 1;
    } else if (code >= 0xd800 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) {
      out[at++] = code;
    } else if (code < 0x800) {
      out[at++] = 0xc0 | (code >> 6);
      out[at++] = 0x80 | (code & 0x3f);
    } else if (code < 0x10000) {
      out[at++] = 0xe0 | (code >> 12);
      out[at++] = 0x80 | ((code >> 6) & 0x3f);
      out[at++] = 0x80 | (code & 0x3f);
    } else {
      out[at++] = 0xf0 | (code >> 18);
      out[at++] = 0x80 | ((code >> 12) & 0x3f);
      out[at++] = 0x80 | ((code >> 6) & 0x3f);
      out[at++] = 0x80 | (code & 0x3f);
    }
  }
  return out;
}

const rotl = (value: number, bits: number): number => (value << bits) | (value >>> (32 - bits));

export function sha1Hex(text: string): string {
  const bytes = utf8Bytes(text);
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = bytes.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bits / 0x1_0000_0000));
  view.setUint32(padded.length - 4, bits >>> 0);
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let t = 0; t < 16; t += 1) w[t] = view.getUint32(offset + t * 4);
    for (let t = 16; t < 80; t += 1) {
      w[t] = rotl((w[t - 3] as number) ^ (w[t - 8] as number) ^ (w[t - 14] as number) ^ (w[t - 16] as number), 1);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let t = 0; t < 80; t += 1) {
      const f = t < 20 ? (b & c) | (~b & d) : t < 40 ? b ^ c ^ d : t < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = t < 20 ? 0x5a827999 : t < 40 ? 0x6ed9eba1 : t < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const next = (rotl(a, 5) + f + e + k + (w[t] as number)) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30) >>> 0;
      b = a;
      a = next;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((word) => word.toString(16).padStart(8, "0")).join("");
}
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/codebase-map exec vitest run src/core/sha1.test.ts`

Expected: PASS, `Tests  4 passed (4)`.

- [ ] **Step 6: Write the failing path-helper test**

Create `packages/codebase-map/src/core/paths.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { clipText, countLanguages, isConfigFile, isTestPath, languageOf, mainLanguage } from "./paths.js";

describe("languageOf", () => {
  it.each([
    ["src/a.ts", "TypeScript"],
    ["src/App.tsx", "TypeScript"],
    ["types/global.d.ts", "TypeScript"],
    ["lib/x.mjs", "JavaScript"],
    ["package.json", "JSON"],
    ["app/server.py", "Python"],
    ["README.md", "Markdown"],
    ["Dockerfile", null],
    [".gitignore", null],
  ])("maps %s to %s", (path, language) => {
    expect(languageOf(path)).toBe(language);
  });
});

describe("isTestPath", () => {
  it.each([
    ["src/a.test.ts", true],
    ["src/a.spec.tsx", true],
    ["src/__tests__/a.ts", true],
    ["tests/test_server.py", true],
    ["packages/x/test/helpers.ts", true],
    ["src/attest.ts", false],
    ["src/testing/a.ts", false],
  ])("%s → %s", (path, expected) => {
    expect(isTestPath(path)).toBe(expected);
  });
});

describe("isConfigFile", () => {
  it.each([
    ["vite.config.ts", true],
    ["configs/eslint.config.mjs", true],
    ["tsconfig.base.json", true],
    ["package.json", true],
    [".prettierrc", true],
    [".eslintrc.json", true],
    ["src/config.ts", false],
    ["README.md", false],
  ])("%s → %s", (path, expected) => {
    expect(isConfigFile(path)).toBe(expected);
  });
});

describe("mainLanguage", () => {
  it("prefers a code language over more numerous docs and data", () => {
    expect(mainLanguage(countLanguages(["Markdown", "Markdown", "JSON", "TypeScript", null]))).toBe("TypeScript");
  });

  it("falls back to the most frequent language, ties to the smaller name", () => {
    expect(mainLanguage(countLanguages(["TOML", "Markdown"]))).toBe("Markdown");
    expect(mainLanguage(countLanguages([null]))).toBeNull();
  });
});

describe("clipText", () => {
  it("keeps short text and cuts long text to the limit with an ellipsis", () => {
    expect(clipText("abc", 3)).toBe("abc");
    expect(clipText("abcdef", 4)).toBe("abc…");
  });

  it("never leaves half of a surrogate pair at the cut", () => {
    const clipped = clipText("ab😀cd", 4);
    expect(clipped).toBe("ab…");
    expect(clipped.length).toBeLessThanOrEqual(4);
  });
});
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/codebase-map exec vitest run src/core/paths.test.ts`

Expected: FAIL with `Failed to resolve import "./paths.js"`.

- [ ] **Step 7: Implement `paths.ts`**

Create `packages/codebase-map/src/core/paths.ts`:

```ts
// Pure path, language and file-kind helpers shared by the cut rules, the role rules and the
// snapshot. Paths are repo-relative with "/" separators. Comparisons use UTF-16 code unit
// order (never localeCompare), so output is identical on every machine.

/** Languages whose imports the evidence-engine parser reads (spec E14). */
export const IMPORT_LANGUAGES: ReadonlySet<string> = new Set(["TypeScript", "JavaScript", "JSON"]);

/** Data and prose languages; a component's main language prefers code over these. */
const NON_CODE_LANGUAGES: ReadonlySet<string> = new Set(["Markdown", "JSON", "YAML", "TOML"]);

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript",
  ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
  ".json": "JSON", ".py": "Python", ".go": "Go", ".rs": "Rust", ".java": "Java",
  ".kt": "Kotlin", ".kts": "Kotlin", ".swift": "Swift", ".rb": "Ruby", ".c": "C", ".h": "C",
  ".cc": "C++", ".cpp": "C++", ".cxx": "C++", ".hpp": "C++", ".cs": "C#", ".php": "PHP",
  ".md": "Markdown", ".mdx": "Markdown", ".yaml": "YAML", ".yml": "YAML", ".toml": "TOML",
  ".css": "CSS", ".scss": "CSS", ".html": "HTML", ".sh": "Shell", ".bash": "Shell", ".zsh": "Shell",
  ".sql": "SQL", ".vue": "Vue", ".svelte": "Svelte",
};

const TEST_DIR_NAMES: ReadonlySet<string> = new Set(["test", "tests", "__tests__"]);
const CONFIG_FILE_NAMES: ReadonlySet<string> = new Set([
  "package.json", "pnpm-workspace.yaml", ".gitignore", ".gitattributes", ".editorconfig", ".nvmrc",
  ".node-version", "Makefile", "Dockerfile", "docker-compose.yml", "docker-compose.yaml",
]);

export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isUnder(path: string, dir: string): boolean {
  return path.startsWith(`${dir}/`);
}

export function dirnameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

export function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function languageOf(path: string): string | null {
  const base = basenameOf(path).toLowerCase();
  const dot = base.lastIndexOf(".");
  if (dot === -1) return null;
  return LANGUAGE_BY_EXTENSION[base.slice(dot)] ?? null;
}

/** `*.test.*`, `*.spec.*`, or any file under a `test/`, `tests/` or `__tests__/` directory (spec §5.2 rule 4). */
export function isTestPath(path: string): boolean {
  const segments = path.split("/");
  const base = segments[segments.length - 1] ?? "";
  if (/\.(test|spec)\.[^/]+$/.test(base)) return true;
  return segments.slice(0, -1).some((segment) => TEST_DIR_NAMES.has(segment));
}

/** Build, lint, editor and package configuration files (spec §5.4 rule 5). */
export function isConfigFile(path: string): boolean {
  const base = basenameOf(path);
  return (
    CONFIG_FILE_NAMES.has(base) ||
    /\.config\.[^/]+$/.test(base) ||
    /^tsconfig(\..+)?\.json$/.test(base) ||
    /^\.[a-z]+rc(\.(json|js|cjs|mjs|yaml|yml))?$/i.test(base)
  );
}

export function countLanguages(languages: readonly (string | null)[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const language of languages) {
    if (language !== null) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return counts;
}

/** Most frequent code language, else the most frequent language; ties go to the smaller name. */
export function mainLanguage(counts: ReadonlyMap<string, number>): string | null {
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]));
  const code = ranked.find(([language]) => !NON_CODE_LANGUAGES.has(language));
  return (code ?? ranked[0])?.[0] ?? null;
}

/** Cuts `text` to at most `max` UTF-16 units with a trailing ellipsis, never splitting a surrogate pair. */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max - 1);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/codebase-map exec vitest run src/core/paths.test.ts`

Expected: PASS, `Tests  28 passed (28)`.

- [ ] **Step 8: Write the failing cut-rule tests and property tests**

Create `packages/codebase-map/src/core/componentize.test.ts`:

```ts
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  SPLIT_THRESHOLD,
  componentIdFor,
  componentOf,
  componentize,
  contentHash,
  type ComponentDraft,
} from "./componentize.js";
import { languageOf } from "./paths.js";
import type { ScannedFile, WorkspaceManifest } from "./types.js";

const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");
const file = (path: string, hash = sha1(path)): ScannedFile => ({ path, hash, size: 10, language: languageOf(path) });
const files = (...paths: string[]): ScannedFile[] => paths.map((path) => file(path));
const manifest = (partial: Partial<WorkspaceManifest> = {}): WorkspaceManifest => ({
  packageDirs: [],
  appDirs: [],
  packageNames: {},
  descriptions: {},
  entryPoints: {},
  ...partial,
});
const table = (drafts: readonly ComponentDraft[]): [string, string, number][] =>
  drafts.map((draft) => [draft.rootPath, draft.name, draft.files.length]);
const range = (count: number, make: (index: number) => string): string[] =>
  Array.from({ length: count }, (_, index) => make(index));
const pad = (index: number): string => String(index).padStart(3, "0");

describe("componentize cut rules (spec §5.2)", () => {
  it("rule 1: workspace packages and apps, then top-level leftovers and the repo-root config component", () => {
    const drafts = componentize(
      files(
        "packages/a/package.json",
        "packages/a/src/index.ts",
        "packages/a/src/index.test.ts",
        "packages/b/src/main.ts",
        "apps/web/package.json",
        "apps/web/src/App.tsx",
        "docs/guide.md",
        "scripts/release.mjs",
        "package.json",
        "README.md",
        "pnpm-workspace.yaml",
      ),
      manifest({
        packageDirs: ["packages/a", "packages/b"],
        appDirs: ["apps/web"],
        packageNames: { "packages/a": "@x/a", "apps/web": "@x/web" },
      }),
    );
    expect(table(drafts)).toEqual([
      [".", "config", 3],
      ["apps/web", "@x/web", 2],
      ["docs", "docs", 1],
      ["packages/a", "@x/a", 3],
      ["packages/b", "b", 1],
      ["scripts", "scripts", 1],
    ]);
  });

  it("rule 2: top-level directories under src/ and lib/; files directly in src/ and src/__tests__ stay in src", () => {
    const drafts = componentize(
      files(
        "src/ui/Button.tsx",
        "src/ui/Menu.tsx",
        "src/db/client.ts",
        "src/index.ts",
        "src/__tests__/db.test.ts",
        "lib/util/x.js",
        "README.md",
      ),
      manifest(),
    );
    expect(table(drafts)).toEqual([
      [".", "config", 1],
      ["lib/util", "util", 1],
      ["src", "src", 2],
      ["src/db", "db", 1],
      ["src/ui", "ui", 2],
    ]);
  });

  it("rule 2: a flat src/ is one component", () => {
    expect(table(componentize(files("src/a.ts", "src/b.ts", "package.json"), manifest()))).toEqual([
      [".", "config", 1],
      ["src", "src", 2],
    ]);
  });

  it("names a repo whose files all sit at the root after its root package, else root", () => {
    expect(table(componentize(files("main.py", "util.py"), manifest({ packageNames: { ".": "tool" } })))).toEqual([
      [".", "tool", 2],
    ]);
    expect(table(componentize(files("main.py", "util.py"), manifest()))).toEqual([[".", "root", 2]]);
  });

  it("rule 3: splits above 150 files by the next branching level and keeps the rest in <name>/root", () => {
    const big = files(
      ...range(100, (i) => `packages/big/src/alpha/f${pad(i)}.ts`),
      ...range(50, (i) => `packages/big/src/beta/f${pad(i)}.ts`),
      "packages/big/package.json",
    );
    const layout = manifest({ packageDirs: ["packages/big"], packageNames: { "packages/big": "@x/big" } });
    expect(big).toHaveLength(SPLIT_THRESHOLD + 1);
    expect(table(componentize(big, layout))).toEqual([
      ["packages/big", "@x/big/root", 1],
      ["packages/big/src/alpha", "@x/big/alpha", 100],
      ["packages/big/src/beta", "@x/big/beta", 50],
    ]);
    expect(table(componentize(big.slice(0, SPLIT_THRESHOLD), layout))).toEqual([["packages/big", "@x/big", 150]]);
  });

  it("rule 3: a part that still has more than 150 files splits again; names drop src/", () => {
    const drafts = componentize(
      files(
        ...range(90, (i) => `packages/big/src/ui/a/f${pad(i)}.ts`),
        ...range(70, (i) => `packages/big/src/ui/b/f${pad(i)}.ts`),
        ...range(20, (i) => `packages/big/src/model/f${pad(i)}.ts`),
        "packages/big/scripts/run.mjs",
        "packages/big/package.json",
      ),
      manifest({ packageDirs: ["packages/big"], packageNames: { "packages/big": "@x/big" } }),
    );
    expect(table(drafts)).toEqual([
      ["packages/big", "@x/big/root", 1],
      ["packages/big/scripts", "@x/big/scripts", 1],
      ["packages/big/src/model", "@x/big/model", 20],
      ["packages/big/src/ui/a", "@x/big/ui/a", 90],
      ["packages/big/src/ui/b", "@x/big/ui/b", 70],
    ]);
  });

  it("rule 3: test directories never become parts; they stay in the root part", () => {
    const drafts = componentize(
      files(
        ...range(100, (i) => `packages/big/src/alpha/f${pad(i)}.ts`),
        ...range(40, (i) => `packages/big/src/beta/f${pad(i)}.ts`),
        ...range(10, (i) => `packages/big/test/t${pad(i)}.test.ts`),
        "packages/big/package.json",
      ),
      manifest({ packageDirs: ["packages/big"], packageNames: { "packages/big": "@x/big" } }),
    );
    expect(table(drafts)).toEqual([
      ["packages/big", "@x/big/root", 11],
      ["packages/big/src/alpha", "@x/big/alpha", 100],
      ["packages/big/src/beta", "@x/big/beta", 40],
    ]);
  });

  it("rule 4: test files join the nearest component", () => {
    const drafts = componentize(
      files("packages/a/src/x.ts", "packages/a/src/x.test.ts", "packages/a/__tests__/y.ts"),
      manifest({ packageDirs: ["packages/a"] }),
    );
    expect(table(drafts)).toEqual([["packages/a", "a", 3]]);
  });

  it("gives split parts the entry points that sit inside them", () => {
    const drafts = componentize(
      files(
        ...range(100, (i) => `packages/big/src/alpha/f${pad(i)}.ts`),
        ...range(50, (i) => `packages/big/src/beta/f${pad(i)}.ts`),
        "packages/big/package.json",
      ),
      manifest({
        packageDirs: ["packages/big"],
        entryPoints: {
          "packages/big": ["packages/big/src/alpha/f000.ts", "packages/big/src/beta/f001.ts", "packages/big/index.ts"],
        },
      }),
    );
    expect(drafts.map((draft) => [draft.rootPath, draft.entryPoints])).toEqual([
      ["packages/big", ["packages/big/index.ts"]],
      ["packages/big/src/alpha", ["packages/big/src/alpha/f000.ts"]],
      ["packages/big/src/beta", ["packages/big/src/beta/f001.ts"]],
    ]);
  });
});

describe("ids, content hashes and languages", () => {
  it("derives the id from the root path: cmp_ + the first 12 hex of sha1(rootPath)", () => {
    expect(componentIdFor("packages/storage")).toBe(`cmp_${sha1("packages/storage").slice(0, 12)}`);
    for (const draft of componentize(files("src/a/x.ts", "src/b/y.ts"), manifest())) {
      expect(draft.id).toBe(componentIdFor(draft.rootPath));
      expect(draft.id).toMatch(/^cmp_[0-9a-f]{12}$/);
    }
  });

  it("hashes the sorted path:hash lines of the members", () => {
    expect(contentHash([{ path: "b.ts", hash: "2" }, { path: "a.ts", hash: "1" }])).toBe(sha1("a.ts:1\nb.ts:2"));
    const [draft] = componentize([file("src/b.ts", "2"), file("src/a.ts", "1")], manifest());
    expect(draft?.contentHash).toBe(sha1("src/a.ts:1\nsrc/b.ts:2"));
  });

  it("records the main language and whether the parser reads any member", () => {
    const drafts = componentize(
      files("docs/a.md", "docs/b.md", "docs/c.ts", "svc/app.py", "svc/b.py", "cfg/a.json"),
      manifest(),
    );
    expect(drafts.map((draft) => [draft.rootPath, draft.language, draft.importsAnalyzed])).toEqual([
      ["cfg", "JSON", true],
      ["docs", "TypeScript", true],
      ["svc", "Python", false],
    ]);
  });

  it("componentOf maps every member to its component id and nothing else", () => {
    const drafts = componentize(files("src/a/x.ts", "src/b/y.ts"), manifest());
    const of = componentOf(drafts);
    expect(of("src/a/x.ts")).toBe(componentIdFor("src/a"));
    expect(of("src/b/y.ts")).toBe(componentIdFor("src/b"));
    expect(of("src/c/z.ts")).toBeUndefined();
  });
});
```

Create `packages/codebase-map/src/core/componentize.property.test.ts`:

```ts
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
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/codebase-map exec vitest run src/core/componentize.test.ts src/core/componentize.property.test.ts`

Expected: FAIL with `Failed to resolve import "./componentize.js"` in both files.

- [ ] **Step 9: Implement `componentize.ts`**

Create `packages/codebase-map/src/core/componentize.ts`:

```ts
import { sha1Hex } from "./sha1.js";
import { IMPORT_LANGUAGES, basenameOf, compareText, countLanguages, isUnder, mainLanguage } from "./paths.js";
import type { ScannedFile, WorkspaceManifest } from "./types.js";

/** Spec §5.2 rule 3: a component with more files than this splits by its next branching level. */
export const SPLIT_THRESHOLD = 150;
/** Name of the repo-root files component when other components exist (spec §5.2 rule 4). */
export const CONFIG_COMPONENT_NAME = "config";
/** Name of the single component of a repo whose files all sit at the root, without a root package name. */
export const FLAT_COMPONENT_NAME = "root";
/** Top-level directories whose components are tooling (spec §5.2 rule 4, §5.4 rule 5). */
export const TOOLING_DIRS: readonly string[] = ["scripts", "tools", ".github"];
export const MAX_DRAFT_ENTRY_POINTS = 8;

const SOURCE_PARENTS: readonly string[] = ["src", "lib", "packages"];
const TEST_DIRS: ReadonlySet<string> = new Set(["test", "tests", "__tests__"]);

export interface ComponentDraft {
  id: string;
  rootPath: string;
  name: string;
  /** Every member path, sorted. The snapshot caps the list; `files.length` is the true count. */
  files: string[];
  language: string | null;
  contentHash: string;
  entryPoints: string[];
  /** True when at least one member file has a grammar the import parser reads (TS, JS, JSON). */
  importsAnalyzed: boolean;
}

/** `"cmp_" + sha1(rootPath).slice(0, 12)`: stable while the root path is unchanged (spec §5.2). */
export function componentIdFor(rootPath: string): string {
  return `cmp_${sha1Hex(rootPath).slice(0, 12)}`;
}

/** `sha1(sorted(path + ":" + file hash))`, lines joined with "\n" (spec §5.2). */
export function contentHash(members: readonly { path: string; hash: string }[]): string {
  return sha1Hex(members.map((member) => `${member.path}:${member.hash}`).sort(compareText).join("\n"));
}

function depth(path: string): number {
  return path.split("/").length;
}

function firstSegment(rest: string): string | null {
  const slash = rest.indexOf("/");
  return slash === -1 ? null : rest.slice(0, slash);
}

/** Cut rules 1 and 2: workspace packages and apps, else children of src/, lib/ and packages/. */
function chooseRoots(paths: readonly string[], manifest: WorkspaceManifest): Map<string, string> {
  const roots = new Map<string, string>();
  const workspace = [...manifest.packageDirs, ...manifest.appDirs].filter((dir) => dir !== "" && dir !== ".");
  if (workspace.length > 0) {
    for (const dir of workspace) roots.set(dir, manifest.packageNames[dir] ?? basenameOf(dir));
    return roots;
  }
  for (const parent of SOURCE_PARENTS) {
    const children = new Set<string>();
    let parentHoldsFiles = false;
    for (const path of paths) {
      if (!isUnder(path, parent)) continue;
      const child = firstSegment(path.slice(parent.length + 1));
      if (child === null || TEST_DIRS.has(child)) parentHoldsFiles = true;
      else children.add(child);
    }
    for (const child of children) roots.set(`${parent}/${child}`, child);
    if (parentHoldsFiles) roots.set(parent, parent);
  }
  return roots;
}

/** Deepest roots first, so a file joins its nearest component (rule 4). */
function orderRoots(roots: ReadonlyMap<string, string>): string[] {
  return [...roots.keys()]
    .filter((root) => root !== ".")
    .sort((a, b) => depth(b) - depth(a) || compareText(a, b));
}

interface Part {
  rootPath: string;
  name: string;
  files: ScannedFile[];
}

const SOURCE_WRAPPERS: ReadonlySet<string> = new Set(["src", "lib"]);

/** "@x/big" + "src/ui" → "@x/big/ui"; the original root's own files → "@x/big/root". */
function partName(name: string, rootPath: string, partRoot: string): string {
  if (partRoot === rootPath) return `${name}/root`;
  const rel = partRoot.slice(rootPath.length + 1);
  const shown = rel.split("/").filter((segment) => !SOURCE_WRAPPERS.has(segment)).join("/");
  return `${name}/${shown === "" ? rel : shown}`;
}

/**
 * Rule 3 for the files under `base`. Descends through a directory that holds every
 * subdirectory file, then splits by the first level with two or more directories. A part
 * that still has more than 150 files splits again. Test directories never become parts; they
 * and the files above the split level stay in the part rooted at `base`.
 */
function splitUnder(base: string, files: readonly ScannedFile[]): { rootPath: string; files: ScannedFile[] }[] {
  let level = base;
  for (;;) {
    const dirs = new Set<string>();
    for (const file of files) {
      if (!isUnder(file.path, level)) continue;
      const dir = firstSegment(file.path.slice(level.length + 1));
      if (dir !== null && !TEST_DIRS.has(dir)) dirs.add(dir);
    }
    if (dirs.size === 0) return [{ rootPath: base, files: [...files] }];
    if (dirs.size === 1) {
      level = `${level}/${[...dirs][0] as string}`;
      continue;
    }
    const groups = new Map<string, ScannedFile[]>();
    const rest: ScannedFile[] = [];
    for (const file of files) {
      const dir = isUnder(file.path, level) ? firstSegment(file.path.slice(level.length + 1)) : null;
      if (dir !== null && dirs.has(dir)) {
        const group = groups.get(dir) ?? [];
        group.push(file);
        groups.set(dir, group);
      } else {
        rest.push(file);
      }
    }
    const parts: { rootPath: string; files: ScannedFile[] }[] = [];
    for (const [dir, group] of [...groups.entries()].sort((a, b) => compareText(a[0], b[0]))) {
      const partRoot = `${level}/${dir}`;
      if (group.length > SPLIT_THRESHOLD) parts.push(...splitUnder(partRoot, group));
      else parts.push({ rootPath: partRoot, files: group });
    }
    if (rest.length > 0) parts.push({ rootPath: base, files: rest });
    return parts;
  }
}

function splitComponent(rootPath: string, name: string, files: readonly ScannedFile[]): Part[] {
  if (rootPath === "." || files.length <= SPLIT_THRESHOLD) return [{ rootPath, name, files: [...files] }];
  const parts = splitUnder(rootPath, files);
  if (parts.length === 1) return [{ rootPath, name, files: [...files] }];
  return parts.map((part) => ({ ...part, name: partName(name, rootPath, part.rootPath) }));
}

function entryPointsFor(part: Part, parts: readonly Part[], entries: readonly string[]): string[] {
  const nested = parts
    .map((other) => other.rootPath)
    .filter((other) => other !== part.rootPath && isUnder(other, part.rootPath));
  return entries
    .filter((entry) => isUnder(entry, part.rootPath) && !nested.some((other) => isUnder(entry, other)))
    .slice(0, MAX_DRAFT_ENTRY_POINTS);
}

function toDraft(part: Part, entryPoints: string[]): ComponentDraft {
  const files = [...part.files].sort((a, b) => compareText(a.path, b.path));
  return {
    id: componentIdFor(part.rootPath),
    rootPath: part.rootPath,
    name: part.name,
    files: files.map((file) => file.path),
    language: mainLanguage(countLanguages(files.map((file) => file.language))),
    contentHash: contentHash(files),
    entryPoints,
    importsAnalyzed: files.some((file) => file.language !== null && IMPORT_LANGUAGES.has(file.language)),
  };
}

/** Spec §5.2: every file lands in exactly one component. Output is sorted by root path. */
export function componentize(files: readonly ScannedFile[], manifest: WorkspaceManifest): ComponentDraft[] {
  const sorted = [...files].sort((a, b) => compareText(a.path, b.path));
  const roots = chooseRoots(sorted.map((file) => file.path), manifest);
  let order = orderRoots(roots);
  const members = new Map<string, ScannedFile[]>();
  for (const file of sorted) {
    let root = order.find((candidate) => isUnder(file.path, candidate));
    if (root === undefined) {
      root = firstSegment(file.path) ?? ".";
      if (!roots.has(root)) {
        roots.set(root, root === "." ? CONFIG_COMPONENT_NAME : root);
        if (root !== ".") order = orderRoots(roots);
      }
    }
    const group = members.get(root) ?? [];
    group.push(file);
    members.set(root, group);
  }
  if (members.size === 1 && members.has(".")) {
    roots.set(".", manifest.packageNames["."] ?? FLAT_COMPONENT_NAME);
  }
  const drafts: ComponentDraft[] = [];
  for (const [rootPath, group] of members) {
    const parts = splitComponent(rootPath, roots.get(rootPath) ?? rootPath, group);
    const entries = manifest.entryPoints[rootPath] ?? [];
    for (const part of parts) drafts.push(toDraft(part, entryPointsFor(part, parts, entries)));
  }
  return drafts.sort((a, b) => compareText(a.rootPath, b.rootPath));
}

/** Maps a member file path to its component id. */
export function componentOf(drafts: readonly ComponentDraft[]): (filePath: string) => string | undefined {
  const byPath = new Map<string, string>();
  for (const draft of drafts) {
    for (const file of draft.files) byPath.set(file, draft.id);
  }
  return (filePath) => byPath.get(filePath);
}
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/codebase-map exec vitest run src/core/componentize.test.ts src/core/componentize.property.test.ts`

Expected: PASS, `Tests  17 passed (17)` (13 unit, 4 properties).

- [ ] **Step 10: Barrel, checks**

Create `packages/codebase-map/src/core/index.ts`:

```ts
export * from "./types.js";
export * from "./sha1.js";
export * from "./paths.js";
export * from "./componentize.js";
```

Run, in order:

```bash
perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/codebase-map typecheck
perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/codebase-map build
perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/codebase-map test
perl -e 'alarm 170; exec @ARGV' pnpm lint
```

Expected: typecheck and build exit 0 (`dist/core/index.js` exists); `Test Files  5 passed (5)`; `perl -e 'alarm 170; exec @ARGV' pnpm lint` prints nothing after `> pnpm exec eslint .`.

- [ ] **Step 11: Commit**

```bash
git add eslint.config.mjs pnpm-lock.yaml packages/codebase-map/package.json packages/codebase-map/tsconfig.json \
  packages/codebase-map/tsconfig.build.json packages/codebase-map/vitest.config.ts packages/codebase-map/src/core
git -c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com commit -m "feat(codebase-map): add the package with component cut rules, ids and content hashes"
```


### Task M-2: Edges, externals, role guess

**Files:**
- Create: `packages/codebase-map/src/core/edges.ts`, `packages/codebase-map/src/core/roles.ts`
- Modify: `packages/codebase-map/src/core/index.ts` (append two lines)
- Test: `packages/codebase-map/src/core/edges.test.ts`, `packages/codebase-map/src/core/roles.test.ts`

**Interfaces:**
- Consumes: M-1 `ComponentDraft`, `componentIdFor`, `CONFIG_COMPONENT_NAME`, `TOOLING_DIRS`, `ImportEdge`, `ExternalImport`, `clipText`, `compareText`, `isTestPath`, `isConfigFile`; K-2 `ComponentEdge`, `ExternalDep`, `Role` from `@jevcode/contracts`.
- Produces:
  - `aggregateEdges(edges: readonly ImportEdge[], componentOfFile: (path: string) => string | undefined): ComponentEdge[]` (interfaces §3)
  - `aggregateExternals(imports: readonly ExternalImport[], componentOfFile: (path: string) => string | undefined): ExternalDep[]` (interfaces §3)
  - `guessRole(draft: ComponentDraft, externals: readonly ExternalDep[]): Role` (interfaces §3)
  - `compareEdges`, `MAX_COMPONENT_EDGES = 1000`, `MAX_EDGE_EXAMPLES = 3`, `MAX_EXAMPLE_LENGTH = 300`, `MAX_EXTERNALS = 120`, `MAX_USED_BY = 40`, `MAX_PACKAGE_NAME_LENGTH = 214`

- [ ] **Step 1: Write the failing edge tests**

Create `packages/codebase-map/src/core/edges.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { MAX_COMPONENT_EDGES, MAX_EXTERNALS, MAX_USED_BY, aggregateEdges, aggregateExternals } from "./edges.js";

const OWNER: Readonly<Record<string, string>> = {
  "a/x.ts": "cmp_a",
  "a/y.ts": "cmp_a",
  "b/z.ts": "cmp_b",
  "b/w.ts": "cmp_b",
  "c/v.ts": "cmp_c",
};
const ownerOf = (path: string): string | undefined => OWNER[path];

describe("aggregateEdges (spec §5.3)", () => {
  it("collapses file imports into component pairs counted by distinct file pairs", () => {
    const edges = aggregateEdges(
      [
        { from: "a/y.ts", to: "b/z.ts" },
        { from: "a/x.ts", to: "b/z.ts" },
        { from: "a/x.ts", to: "b/z.ts" },
        { from: "a/x.ts", to: "b/w.ts" },
        { from: "b/z.ts", to: "c/v.ts" },
      ],
      ownerOf,
    );
    expect(edges).toEqual([
      { from: "cmp_a", to: "cmp_b", count: 3, examples: ["a/x.ts → b/w.ts", "a/x.ts → b/z.ts", "a/y.ts → b/z.ts"] },
      { from: "cmp_b", to: "cmp_c", count: 1, examples: ["b/z.ts → c/v.ts"] },
    ]);
  });

  it("drops self-edges and files outside every component", () => {
    expect(
      aggregateEdges(
        [
          { from: "a/x.ts", to: "a/y.ts" },
          { from: "a/x.ts", to: "gone/q.ts" },
          { from: "gone/q.ts", to: "b/z.ts" },
        ],
        ownerOf,
      ),
    ).toEqual([]);
  });

  it("keeps at most three examples and clips each to 300 characters", () => {
    const long = `a/${"d/".repeat(200)}x.ts`;
    const edges = aggregateEdges(
      [long, "a/1.ts", "a/2.ts", "a/3.ts"].map((from) => ({ from, to: "b/z.ts" })),
      (path) => (path.startsWith("a/") ? "cmp_a" : "cmp_b"),
    );
    expect(edges[0]?.count).toBe(4);
    expect(edges[0]?.examples).toHaveLength(3);
    for (const example of edges[0]?.examples ?? []) expect(example.length).toBeLessThanOrEqual(300);
  });

  it("caps the list at 1,000 edges, heaviest first", () => {
    const imports = [];
    for (let i = 0; i < 1_100; i += 1) {
      for (let k = 0; k <= i % 3; k += 1) imports.push({ from: `m${i}/f${k}.ts`, to: `t${i}/g.ts` });
    }
    const edges = aggregateEdges(imports, (path) => `cmp_${path.split("/")[0] ?? ""}`);
    expect(edges).toHaveLength(MAX_COMPONENT_EDGES);
    expect(edges[0]?.count).toBe(3);
    expect(edges[edges.length - 1]?.count).toBe(1);
    for (let i = 1; i < edges.length; i += 1) {
      expect((edges[i - 1]?.count ?? 0) >= (edges[i]?.count ?? 0)).toBe(true);
    }
  });
});

describe("aggregateExternals (spec §5.3)", () => {
  it("counts importing files per component and package, heaviest first", () => {
    expect(
      aggregateExternals(
        [
          { from: "a/x.ts", packageName: "react" },
          { from: "a/x.ts", packageName: "react" },
          { from: "a/y.ts", packageName: "react" },
          { from: "b/z.ts", packageName: "react" },
          { from: "b/z.ts", packageName: "zod" },
          { from: "gone/q.ts", packageName: "zod" },
          { from: "a/x.ts", packageName: "" },
          { from: "a/x.ts", packageName: "x".repeat(215) },
        ],
        ownerOf,
      ),
    ).toEqual([
      { name: "react", usedBy: [{ componentId: "cmp_a", count: 2 }, { componentId: "cmp_b", count: 1 }] },
      { name: "zod", usedBy: [{ componentId: "cmp_b", count: 1 }] },
    ]);
  });

  it("caps users at 40 per package and packages at 120", () => {
    const imports = [];
    for (let p = 0; p < 130; p += 1) {
      for (let c = 0; c < 45; c += 1) imports.push({ from: `c${c}/f.ts`, packageName: `pkg-${String(p).padStart(3, "0")}` });
    }
    const externals = aggregateExternals(imports, (path) => `cmp_${path.split("/")[0] ?? ""}`);
    expect(externals).toHaveLength(MAX_EXTERNALS);
    expect(externals[0]?.name).toBe("pkg-000");
    for (const dep of externals) expect(dep.usedBy).toHaveLength(MAX_USED_BY);
  });
});
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/codebase-map exec vitest run src/core/edges.test.ts`

Expected: FAIL with `Failed to resolve import "./edges.js"`.

- [ ] **Step 2: Implement `edges.ts`**

Create `packages/codebase-map/src/core/edges.ts`:

```ts
import type { ComponentEdge, ExternalDep } from "@jevcode/contracts";

import { clipText, compareText } from "./paths.js";
import type { ExternalImport, ImportEdge } from "./types.js";

export const MAX_COMPONENT_EDGES = 1_000;
export const MAX_EDGE_EXAMPLES = 3;
export const MAX_EXAMPLE_LENGTH = 300;
export const MAX_EXTERNALS = 120;
export const MAX_USED_BY = 40;
export const MAX_PACKAGE_NAME_LENGTH = 214;

/** Heaviest first, then by component id, so equal input gives equal order. */
export function compareEdges(a: ComponentEdge, b: ComponentEdge): number {
  return b.count - a.count || compareText(a.from, b.from) || compareText(a.to, b.to);
}

/**
 * Spec §5.3: file-level imports collapse into component pairs. `count` is the number of distinct
 * importing/imported file pairs; examples are the first three pairs in path order; self-edges
 * and files outside every component are dropped; the result is capped at 1,000 by count.
 */
export function aggregateEdges(
  edges: readonly ImportEdge[],
  componentOfFile: (path: string) => string | undefined,
): ComponentEdge[] {
  const pairs = new Map<string, ImportEdge>();
  for (const edge of edges) pairs.set(`${edge.from}\u0000${edge.to}`, edge);
  const ordered = [...pairs.values()].sort((a, b) => compareText(a.from, b.from) || compareText(a.to, b.to));
  const byKey = new Map<string, ComponentEdge>();
  for (const edge of ordered) {
    const from = componentOfFile(edge.from);
    const to = componentOfFile(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    const key = `${from}\u0000${to}`;
    let entry = byKey.get(key);
    if (entry === undefined) {
      entry = { from, to, count: 0, examples: [] };
      byKey.set(key, entry);
    }
    entry.count += 1;
    if (entry.examples.length < MAX_EDGE_EXAMPLES) {
      entry.examples.push(clipText(`${edge.from} → ${edge.to}`, MAX_EXAMPLE_LENGTH));
    }
  }
  return [...byKey.values()].sort(compareEdges).slice(0, MAX_COMPONENT_EDGES);
}

/**
 * Component-to-package edges, kept apart from component edges (spec §5.3). A file importing a
 * package twice counts once. `usedBy` is capped at 40 and the list at 120, heaviest first.
 */
export function aggregateExternals(
  imports: readonly ExternalImport[],
  componentOfFile: (path: string) => string | undefined,
): ExternalDep[] {
  const seen = new Set<string>();
  const byName = new Map<string, Map<string, number>>();
  for (const entry of imports) {
    const name = entry.packageName;
    if (name.length === 0 || name.length > MAX_PACKAGE_NAME_LENGTH) continue;
    const key = `${entry.from}\u0000${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const componentId = componentOfFile(entry.from);
    if (componentId === undefined) continue;
    const users = byName.get(name) ?? new Map<string, number>();
    users.set(componentId, (users.get(componentId) ?? 0) + 1);
    byName.set(name, users);
  }
  const ranked = [...byName.entries()].map(([name, users]) => {
    const usedBy = [...users.entries()]
      .map(([componentId, count]) => ({ componentId, count }))
      .sort((a, b) => b.count - a.count || compareText(a.componentId, b.componentId));
    return { name, total: usedBy.reduce((sum, use) => sum + use.count, 0), usedBy: usedBy.slice(0, MAX_USED_BY) };
  });
  return ranked
    .sort((a, b) => b.total - a.total || compareText(a.name, b.name))
    .slice(0, MAX_EXTERNALS)
    .map(({ name, usedBy }) => ({ name, usedBy }));
}
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/codebase-map exec vitest run src/core/edges.test.ts`

Expected: PASS, `Tests  6 passed (6)`.

- [ ] **Step 3: Write the failing role table test**

Every row derives from spec §5.4 (first match wins; rules 3 and 4 read the name only). Create `packages/codebase-map/src/core/roles.test.ts`:

```ts
import type { ExternalDep, Role } from "@jevcode/contracts";
import { describe, expect, it } from "vitest";

import { componentIdFor, type ComponentDraft } from "./componentize.js";
import { guessRole } from "./roles.js";

function draft(rootPath: string, name: string, files: string[] = [`${rootPath}/index.ts`]): ComponentDraft {
  return {
    id: componentIdFor(rootPath),
    rootPath,
    name,
    files,
    language: "TypeScript",
    contentHash: "0".repeat(40),
    entryPoints: [],
    importsAnalyzed: true,
  };
}

const uses = (target: ComponentDraft, names: readonly string[]): ExternalDep[] =>
  names.map((name) => ({ name, usedBy: [{ componentId: target.id, count: 1 }] }));

const CASES: [string, ComponentDraft, readonly string[], Role][] = [
  ["a ui token in the path", draft("packages/ui-kit", "@x/ui-kit"), [], "ui"],
  ["no match inside a longer word", draft("packages/guide", "guide"), [], "domain"],
  ["react imports", draft("packages/screens", "screens"), ["react"], "ui"],
  ["vue imports", draft("packages/screens", "screens"), ["vue"], "ui"],
  ["an api token in the path", draft("src/routes", "routes"), [], "api"],
  ["electron imports", draft("apps/desktop/src/main", "desktop/main"), ["electron"], "api"],
  ["express imports", draft("packages/gateway", "gateway"), ["express"], "api"],
  ["an agent token in the name", draft("packages/agent-codex", "@x/agent-codex"), [], "agent"],
  ["router in the name", draft("packages/jev-router", "@x/jev-router"), [], "agent"],
  ["an LLM SDK import", draft("packages/brain", "brain"), ["@anthropic-ai/sdk"], "agent"],
  ["an LLM SDK by scope", draft("packages/brain", "brain"), ["@ai-sdk/openai"], "agent"],
  ["node-pty imports", draft("packages/term", "term"), ["node-pty"], "agent"],
  ["a storage token in the name", draft("packages/storage", "@x/storage"), [], "storage"],
  ["db in the name", draft("packages/db", "@x/db"), [], "storage"],
  ["better-sqlite3 imports", draft("packages/persist", "persist"), ["better-sqlite3"], "storage"],
  ["only test files", draft("tests", "tests", ["tests/test_a.py", "tests/b.test.ts"]), [], "tests"],
  ["scripts", draft("scripts", "scripts", ["scripts/release.mjs"]), [], "tooling"],
  [".github", draft(".github", ".github", [".github/workflows/ci.yml"]), [], "tooling"],
  ["the repo-root config component", draft(".", "config", ["package.json", "README.md"]), [], "config"],
  ["config files only", draft("configs", "configs", ["configs/vite.config.ts", "configs/tsconfig.base.json"]), [], "config"],
  ["first match wins: ui before agent", draft("packages/agent-ui", "@x/agent-ui"), [], "ui"],
  ["first match wins: api before storage", draft("packages/db-server", "@x/db-server"), [], "api"],
  ["agent words count only in the name", draft("agent/core", "core"), [], "domain"],
  ["anything else", draft("packages/model", "@x/model"), ["zod"], "domain"],
];

describe("guessRole (spec §5.4)", () => {
  it.each(CASES)("%s", (_label, target, imports, expected) => {
    expect(guessRole(target, uses(target, imports))).toBe(expected);
  });

  it("ignores packages that only other components import", () => {
    const target = draft("packages/model", "@x/model");
    const other = draft("packages/web", "@x/web");
    expect(guessRole(target, uses(other, ["react", "better-sqlite3"]))).toBe("domain");
  });
});
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/codebase-map exec vitest run src/core/roles.test.ts`

Expected: FAIL with `Failed to resolve import "./roles.js"`.

- [ ] **Step 4: Implement `roles.ts`**

Create `packages/codebase-map/src/core/roles.ts`:

```ts
import type { ExternalDep, Role } from "@jevcode/contracts";

import { CONFIG_COMPONENT_NAME, TOOLING_DIRS, type ComponentDraft } from "./componentize.js";
import { isConfigFile, isTestPath } from "./paths.js";

// Spec §5.4, first match wins. Words match whole tokens of the root path or name (split on
// anything that is not a letter or digit), so "packages/guide" never reads as "ui".
const UI_WORDS = ["renderer", "ui", "web", "components", "views"];
const UI_IMPORTS = ["react", "react-dom", "vue", "svelte"];
const API_WORDS = ["ipc", "api", "routes", "server", "handlers"];
const API_IMPORTS = ["express", "fastify", "hono", "electron"];
const AGENT_WORDS = ["agent", "adapter", "router", "llm"];
const AGENT_IMPORTS = ["@anthropic-ai/sdk", "openai", "ai", "cohere-ai", "ollama", "langchain", "node-pty"];
const AGENT_IMPORT_PREFIXES = ["@anthropic-ai/", "@ai-sdk/", "@langchain/", "@mistralai/", "@google/generative-ai"];
const STORAGE_WORDS = ["storage", "db", "store"];
const STORAGE_IMPORTS = ["better-sqlite3", "prisma", "@prisma/client", "drizzle-orm", "pg", "mongodb"];

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token !== ""));
}

function hasAny(set: ReadonlySet<string>, words: readonly string[]): boolean {
  return words.some((word) => set.has(word));
}

export function guessRole(draft: ComponentDraft, externals: readonly ExternalDep[]): Role {
  const imported = new Set(
    externals.filter((dep) => dep.usedBy.some((use) => use.componentId === draft.id)).map((dep) => dep.name),
  );
  const name = tokens(draft.name);
  const pathOrName = new Set([...tokens(draft.rootPath), ...name]);
  const imports = (names: readonly string[]): boolean => names.some((pkg) => imported.has(pkg));

  if (hasAny(pathOrName, UI_WORDS) || imports(UI_IMPORTS)) return "ui";
  if (hasAny(pathOrName, API_WORDS) || imports(API_IMPORTS)) return "api";
  if (
    hasAny(name, AGENT_WORDS) ||
    imports(AGENT_IMPORTS) ||
    [...imported].some((pkg) => AGENT_IMPORT_PREFIXES.some((prefix) => pkg.startsWith(prefix)))
  ) {
    return "agent";
  }
  if (hasAny(name, STORAGE_WORDS) || imports(STORAGE_IMPORTS)) return "storage";
  if (draft.files.length > 0 && draft.files.every(isTestPath)) return "tests";
  if (TOOLING_DIRS.includes(draft.rootPath.split("/")[0] ?? "")) return "tooling";
  if (
    (draft.rootPath === "." && draft.name === CONFIG_COMPONENT_NAME) ||
    (draft.files.length > 0 && draft.files.every(isConfigFile))
  ) {
    return "config";
  }
  return "domain";
}
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/codebase-map exec vitest run src/core/roles.test.ts`

Expected: PASS, `Tests  25 passed (25)`.

- [ ] **Step 5: Barrel, checks**

Append to `packages/codebase-map/src/core/index.ts`:

```ts
export * from "./edges.js";
export * from "./roles.js";
```

Run `perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/codebase-map typecheck`, `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/codebase-map test` and `perl -e 'alarm 170; exec @ARGV' pnpm lint`.

Expected: exit 0; `Test Files  7 passed (7)`; lint prints nothing.

- [ ] **Step 6: Commit**

```bash
git add packages/codebase-map/src/core/edges.ts packages/codebase-map/src/core/edges.test.ts \
  packages/codebase-map/src/core/roles.ts packages/codebase-map/src/core/roles.test.ts packages/codebase-map/src/core/index.ts
git -c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com commit -m "feat(codebase-map): aggregate component edges and externals, guess roles"
```


### Task M-3: `assembleSnapshot` with caps

**Files:**
- Create: `packages/codebase-map/src/core/snapshot.ts`
- Modify: `packages/codebase-map/src/core/index.ts` (append one line)
- Test: `packages/codebase-map/src/core/snapshot.test.ts`, `packages/codebase-map/src/core/snapshot.property.test.ts`

**Interfaces:**
- Consumes: M-1 `componentize`, `componentIdFor`, `ComponentDraft`, `clipText`, `compareText`, `mainLanguage`, `sha1Hex`, `utf8ByteLength`; M-2 `aggregateEdges`, `aggregateExternals`, `guessRole`, `compareEdges` and the cap constants; K-2 `OverviewSnapshot`, `Component`, `ComponentEdge`, `ExternalDep`, `Role`, `OverviewSnapshotSchema`, `OVERVIEW_SNAPSHOT_MAX_BYTES`.
- Produces:
  - `assembleSnapshot(input: AssembleSnapshotInput): OverviewSnapshot` (interfaces §3; the input type is the interface's inline type, named, plus `totalFiles?: number`, ruling R3). It fills `counts.totalFiles` (the repo's file count before the 20,000-file cap; the mapped count when omitted) and leaves `status` unset: the stage adds it (M-6).
  - `interface ComponentText { purpose: string | null; role: Role; provenance: "rule" | "model" }` (the value type of `AssembleSnapshotInput.text`; lane 05 returns it from `NarrationSeam.textFor`)
  - `MAX_COMPONENTS = 200`, `MAX_COMPONENT_FILES = 400`, `MAX_COMPONENT_EXTERNALS = 8`, `MAX_ENTRY_POINTS = 8`, `MAX_LANGUAGES = 20`, `OTHER_ROOT_PATH = "(other)"`, `OTHER_COMPONENT_NAME = "other"`
- Snapshot semantics lane 06 relies on: components sorted by `rootPath`; edges heaviest first; `counts.components` and `counts.edges` are totals before the caps; the "other" group has `rootPath "(other)"`, `name "other"`, `roleGuess "domain"`; `partial` is only the file cap; `counts.totalFiles ≥ counts.files`.

- [ ] **Step 1: Write the failing snapshot tests**

Create `packages/codebase-map/src/core/snapshot.test.ts`:

```ts
import { OVERVIEW_SNAPSHOT_MAX_BYTES, OverviewSnapshotSchema } from "@jevcode/contracts";
import { describe, expect, it } from "vitest";

import { componentIdFor, componentOf, componentize } from "./componentize.js";
import { aggregateEdges, aggregateExternals } from "./edges.js";
import { languageOf } from "./paths.js";
import { sha1Hex, utf8ByteLength } from "./sha1.js";
import { MAX_COMPONENT_FILES, OTHER_ROOT_PATH, assembleSnapshot, type AssembleSnapshotInput } from "./snapshot.js";
import { emptyManifest, type ScannedFile } from "./types.js";

const file = (path: string): ScannedFile => ({ path, hash: sha1Hex(path), size: 1, language: languageOf(path) });
const pad = (index: number): string => String(index).padStart(3, "0");

function input(overrides: Partial<AssembleSnapshotInput>): AssembleSnapshotInput {
  return {
    sessionId: "sess_1",
    repoRoot: "/repo",
    scanId: "scan_1",
    partial: false,
    drafts: [],
    edges: [],
    externals: [],
    text: new Map(),
    narrative: null,
    generatedAt: "2026-10-02T00:00:00.000Z",
    ...overrides,
  };
}

function smallRepo(): Pick<AssembleSnapshotInput, "drafts" | "edges" | "externals"> {
  const drafts = componentize(
    ["src/ui/App.tsx", "src/ui/Menu.tsx", "src/db/client.ts", "src/db/schema.ts", "README.md"].map(file),
    emptyManifest(),
  );
  const of = componentOf(drafts);
  return {
    drafts,
    edges: aggregateEdges([{ from: "src/ui/App.tsx", to: "src/db/client.ts" }], of),
    externals: aggregateExternals(
      [
        { from: "src/ui/App.tsx", packageName: "react" },
        { from: "src/db/client.ts", packageName: "better-sqlite3" },
      ],
      of,
    ),
  };
}

describe("assembleSnapshot (spec §5.5)", () => {
  it("builds a schema-valid snapshot with rule-based text, true counts and per-component dependencies", () => {
    const snapshot = assembleSnapshot(input(smallRepo()));
    expect(OverviewSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(
      snapshot.components.map((c) => [c.rootPath, c.name, c.roleGuess, c.role, c.provenance, c.purpose, c.fileCount, c.externalDeps]),
    ).toEqual([
      [".", "config", "config", "config", "rule", null, 1, []],
      ["src/db", "db", "storage", "storage", "rule", null, 2, [{ name: "better-sqlite3", count: 1 }]],
      ["src/ui", "ui", "ui", "ui", "rule", null, 2, [{ name: "react", count: 1 }]],
    ]);
    expect(snapshot.edges).toEqual([
      { from: componentIdFor("src/ui"), to: componentIdFor("src/db"), count: 1, examples: ["src/ui/App.tsx → src/db/client.ts"] },
    ]);
    expect(snapshot.counts).toEqual({ files: 5, components: 3, edges: 1, languages: ["TypeScript", "Markdown"], totalFiles: 5 });
    expect(snapshot.status).toBeUndefined();
    expect(snapshot).toMatchObject({ sessionId: "sess_1", repoRoot: "/repo", scanId: "scan_1", partial: false, narrative: null });
  });

  it("uses confirmed text from the text map, clipped to 140 characters", () => {
    const repo = smallRepo();
    const db = componentIdFor("src/db");
    const snapshot = assembleSnapshot(
      input({ ...repo, text: new Map([[db, { purpose: "p".repeat(200), role: "domain", provenance: "model" }]]) }),
    );
    const component = snapshot.components.find((c) => c.id === db);
    expect(component).toMatchObject({ roleGuess: "storage", role: "domain", provenance: "model" });
    expect(component?.purpose).toHaveLength(140);
    expect(component?.purpose?.endsWith("…")).toBe(true);
  });

  it("lists at most 400 files per component and keeps the true count", () => {
    const drafts = componentize(Array.from({ length: 450 }, (_, i) => file(`src/f${pad(i)}.ts`)), emptyManifest());
    const [component] = assembleSnapshot(input({ drafts })).components;
    expect(component?.files).toHaveLength(MAX_COMPONENT_FILES);
    expect(component?.fileCount).toBe(450);
  });

  it("groups the smallest components past 200 into other and re-points their edges and dependencies", () => {
    const paths = [
      ...Array.from({ length: 199 }, (_, i) => [0, 1, 2].map((k) => `src/m${pad(i)}/f${k}.ts`)).flat(),
      ...Array.from({ length: 31 }, (_, i) => `src/m${pad(199 + i)}/f0.ts`),
    ];
    const drafts = componentize(paths.map(file), emptyManifest());
    expect(drafts).toHaveLength(230);
    const id = (index: number): string => componentIdFor(`src/m${pad(index)}`);
    const snapshot = assembleSnapshot(
      input({
        drafts,
        edges: [
          { from: id(0), to: id(200), count: 2, examples: ["src/m000/f0.ts → src/m200/f0.ts"] },
          { from: id(201), to: id(202), count: 5, examples: [] },
          { from: id(203), to: id(0), count: 1, examples: [] },
          { from: id(204), to: id(1), count: 4, examples: [] },
        ],
        externals: [{ name: "react", usedBy: [{ componentId: id(200), count: 1 }, { componentId: id(201), count: 1 }] }],
      }),
    );
    expect(OverviewSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.components).toHaveLength(200);
    expect(snapshot.counts.components).toBe(230);
    const other = snapshot.components.find((c) => c.rootPath === OTHER_ROOT_PATH);
    expect(other).toMatchObject({ id: componentIdFor(OTHER_ROOT_PATH), name: "other", fileCount: 31, roleGuess: "domain" });
    expect(snapshot.edges.map((e) => [e.from, e.to, e.count])).toEqual([
      [other?.id, id(1), 4],
      [id(0), other?.id, 2],
      [other?.id, id(0), 1],
    ]);
    expect(snapshot.externals).toEqual([{ name: "react", usedBy: [{ componentId: other?.id, count: 2 }] }]);
  });

  it("trims file lists until the serialized row fits in 512 KB", () => {
    const deep = "d".repeat(180);
    const paths = Array.from({ length: 200 }, (_, i) =>
      Array.from({ length: 300 }, (_, k) => `src/m${pad(i)}/${deep}/f${pad(k)}.ts`),
    ).flat();
    const snapshot = assembleSnapshot(input({ drafts: componentize(paths.map(file), emptyManifest()) }));
    expect(OverviewSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(utf8ByteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(OVERVIEW_SNAPSHOT_MAX_BYTES);
    expect(snapshot.components.every((c) => c.fileCount === 300 && c.files.length < 300)).toBe(true);
  });

  it("records the repo's file total before the scan cap (ruling R3)", () => {
    expect(assembleSnapshot(input({ ...smallRepo(), partial: true, totalFiles: 25_200 })).counts).toMatchObject({
      files: 5,
      totalFiles: 25_200,
    });
  });

  it("passes the narrative through", () => {
    const narrative = {
      sentences: [{ text: "The UI reads the database.", citations: [{ kind: "component" as const, id: componentIdFor("src/ui") }] }],
      provenance: "model" as const,
    };
    expect(assembleSnapshot(input({ ...smallRepo(), narrative })).narrative).toEqual(narrative);
  });
});
```

Create `packages/codebase-map/src/core/snapshot.property.test.ts`:

```ts
import { OVERVIEW_SNAPSHOT_MAX_BYTES, OverviewSnapshotSchema } from "@jevcode/contracts";
import type { ComponentEdge, ExternalDep } from "@jevcode/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { componentIdFor, type ComponentDraft } from "./componentize.js";
import { sha1Hex, utf8ByteLength } from "./sha1.js";
import { assembleSnapshot, type AssembleSnapshotInput } from "./snapshot.js";

interface Shape {
  components: number;
  files: number;
  pad: number;
  edges: number;
  externals: number;
}

function synthetic(shape: Shape): AssembleSnapshotInput {
  const drafts: ComponentDraft[] = [];
  for (let i = 0; i < shape.components; i += 1) {
    const rootPath = `pkg-${i}/${"d".repeat(shape.pad)}`;
    const files = Array.from({ length: 1 + ((i * 7) % shape.files) }, (_, k) => `${rootPath}/f${k}.ts`);
    drafts.push({
      id: componentIdFor(rootPath),
      rootPath,
      name: `pkg-${i}`,
      files,
      language: "TypeScript",
      contentHash: sha1Hex(rootPath),
      entryPoints: [],
      importsAnalyzed: true,
    });
  }
  const at = (index: number): ComponentDraft => drafts[index % drafts.length] as ComponentDraft;
  const edges: ComponentEdge[] = Array.from({ length: shape.edges }, (_, k) => ({
    from: at(k).id,
    to: at(k * 13 + 1).id,
    count: 1 + (k % 5),
    examples: [`${at(k).files[0] ?? ""} → ${at(k * 13 + 1).files[0] ?? ""}`],
  }));
  const externals: ExternalDep[] = Array.from({ length: shape.externals }, (_, k) => ({
    name: `ext-${k}`,
    usedBy: [{ componentId: at(k).id, count: 1 + (k % 3) }],
  }));
  return {
    sessionId: "sess_p",
    repoRoot: "/repo",
    scanId: "scan_p",
    partial: false,
    drafts,
    edges,
    externals,
    text: new Map(),
    narrative: null,
    generatedAt: "2026-10-02T00:00:00.000Z",
  };
}

const shapeArb = fc.record({
  components: fc.integer({ min: 1, max: 450 }),
  files: fc.integer({ min: 1, max: 40 }),
  pad: fc.integer({ min: 0, max: 160 }),
  edges: fc.integer({ min: 0, max: 2_500 }),
  externals: fc.integer({ min: 0, max: 200 }),
});

describe("assembleSnapshot caps (spec §5.5, §12)", () => {
  it("always holds the component, edge, external and byte caps, and only references kept components", () => {
    fc.assert(
      fc.property(shapeArb, (shape) => {
        const snapshot = assembleSnapshot(synthetic(shape));
        expect(OverviewSnapshotSchema.safeParse(snapshot).success).toBe(true);
        expect(snapshot.components).toHaveLength(Math.min(shape.components, 200));
        expect(snapshot.edges.length).toBeLessThanOrEqual(1_000);
        expect(snapshot.externals.length).toBeLessThanOrEqual(120);
        expect(utf8ByteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(OVERVIEW_SNAPSHOT_MAX_BYTES);
        expect(snapshot.counts.components).toBe(shape.components);
        const ids = new Set(snapshot.components.map((c) => c.id));
        for (const edge of snapshot.edges) {
          expect(ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to).toBe(true);
        }
        for (const dep of snapshot.externals) {
          for (const use of dep.usedBy) expect(ids.has(use.componentId)).toBe(true);
        }
      }),
      { numRuns: 40 },
    );
  });

  it("is deterministic for equal input", () => {
    fc.assert(
      fc.property(shapeArb, (shape) => {
        expect(assembleSnapshot(synthetic(shape))).toEqual(assembleSnapshot(synthetic(shape)));
      }),
      { numRuns: 15 },
    );
  });

  it("leaves room for the status and the real sessionId the stage stamps after assembly", () => {
    const stamp = (snapshot: ReturnType<typeof assembleSnapshot>) => ({
      ...snapshot,
      sessionId: "s".repeat(256),
      status: {
        scan: { state: "failed" as const, scanned: 20_000, total: 20_000, error: "e".repeat(200) },
        narrator: "unavailable" as const,
      },
    });
    const heaviest = { components: 450, files: 40, pad: 160, edges: 2_500, externals: 200 };
    const check = (shape: typeof heaviest): void => {
      const stamped = stamp(assembleSnapshot(synthetic(shape)));
      expect(OverviewSnapshotSchema.safeParse(stamped).success).toBe(true);
      expect(utf8ByteLength(JSON.stringify(stamped))).toBeLessThanOrEqual(OVERVIEW_SNAPSHOT_MAX_BYTES);
    };
    check(heaviest);
    fc.assert(fc.property(shapeArb, check), { numRuns: 25 });
  });
});
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/codebase-map exec vitest run src/core/snapshot.test.ts src/core/snapshot.property.test.ts`

Expected: FAIL with `Failed to resolve import "./snapshot.js"` in both files.

- [ ] **Step 2: Implement `snapshot.ts`**

Create `packages/codebase-map/src/core/snapshot.ts`:

```ts
import { OVERVIEW_SNAPSHOT_MAX_BYTES } from "@jevcode/contracts";
import type { Component, ComponentEdge, ExternalDep, OverviewSnapshot, Role } from "@jevcode/contracts";

import { componentIdFor, type ComponentDraft } from "./componentize.js";
import { MAX_COMPONENT_EDGES, MAX_EDGE_EXAMPLES, MAX_EXAMPLE_LENGTH, MAX_EXTERNALS, MAX_USED_BY, compareEdges } from "./edges.js";
import { clipText, compareText, mainLanguage } from "./paths.js";
import { guessRole } from "./roles.js";
import { sha1Hex, utf8ByteLength } from "./sha1.js";

export const MAX_COMPONENTS = 200;
export const MAX_COMPONENT_FILES = 400;
export const MAX_COMPONENT_EXTERNALS = 8;
export const MAX_ENTRY_POINTS = 8;
export const MAX_LANGUAGES = 20;
/** Root path and name of the group that holds the smallest components past the 200 cap (spec §5.5). */
export const OTHER_ROOT_PATH = "(other)";
export const OTHER_COMPONENT_NAME = "other";
const MAX_NAME = 120;
const MAX_PURPOSE = 140;
const MAX_LANGUAGE = 40;
const FILE_LIST_STEPS = [200, 100, 50, 20, 0] as const;
const USED_BY_STEP = 10;
/**
 * The stage stamps `status` (about 1 KB at most: scan counters plus a 200-character error) and the
 * real `sessionId` (assembly runs with "") after assembly, so the trimmer budgets for both.
 */
const STAMP_HEADROOM_BYTES = 2_048;
const SNAPSHOT_BUDGET_BYTES = OVERVIEW_SNAPSHOT_MAX_BYTES - STAMP_HEADROOM_BYTES;

/** Purpose and confirmed role for one component; missing ids use the rule-based guess. */
export interface ComponentText {
  purpose: string | null;
  role: Role;
  provenance: "rule" | "model";
}

export interface AssembleSnapshotInput {
  sessionId: string;
  repoRoot: string;
  scanId: string;
  partial: boolean;
  drafts: ComponentDraft[];
  /** Repo files before the 20,000-file cap (ruling R3); defaults to the mapped file count. */
  totalFiles?: number;
  edges: ComponentEdge[];
  externals: ExternalDep[];
  text: Map<string, ComponentText>;
  narrative: OverviewSnapshot["narrative"];
  generatedAt: string;
}

interface Capped {
  kept: ComponentDraft[];
  otherId: string | null;
  otherOf: ReadonlyMap<string, string>;
}

function weightedLanguage(drafts: readonly ComponentDraft[]): string | null {
  const counts = new Map<string, number>();
  for (const draft of drafts) {
    if (draft.language !== null) counts.set(draft.language, (counts.get(draft.language) ?? 0) + draft.files.length);
  }
  return mainLanguage(counts);
}

/** Keeps the 199 largest components and groups the rest into "other" (spec §5.5). */
function capComponents(drafts: readonly ComponentDraft[]): Capped {
  if (drafts.length <= MAX_COMPONENTS) return { kept: [...drafts], otherId: null, otherOf: new Map() };
  const ranked = [...drafts].sort((a, b) => b.files.length - a.files.length || compareText(a.rootPath, b.rootPath));
  const keep = ranked.slice(0, MAX_COMPONENTS - 1);
  const grouped = ranked.slice(MAX_COMPONENTS - 1);
  const otherId = componentIdFor(OTHER_ROOT_PATH);
  const other: ComponentDraft = {
    id: otherId,
    rootPath: OTHER_ROOT_PATH,
    name: OTHER_COMPONENT_NAME,
    files: grouped.flatMap((draft) => draft.files).sort(compareText),
    language: weightedLanguage(grouped),
    contentHash: sha1Hex(grouped.map((draft) => draft.contentHash).sort(compareText).join("\n")),
    entryPoints: [],
    importsAnalyzed: grouped.some((draft) => draft.importsAnalyzed),
  };
  return {
    kept: [...keep, other].sort((a, b) => compareText(a.rootPath, b.rootPath)),
    otherId,
    otherOf: new Map(grouped.map((draft) => [draft.id, otherId])),
  };
}

function mergeEdges(edges: readonly ComponentEdge[], remap: (id: string) => string, valid: ReadonlySet<string>): ComponentEdge[] {
  const byKey = new Map<string, ComponentEdge>();
  for (const edge of [...edges].sort(compareEdges)) {
    const from = remap(edge.from);
    const to = remap(edge.to);
    if (from === to || !valid.has(from) || !valid.has(to)) continue;
    const key = `${from}\u0000${to}`;
    let entry = byKey.get(key);
    if (entry === undefined) {
      entry = { from, to, count: 0, examples: [] };
      byKey.set(key, entry);
    }
    entry.count += edge.count;
    for (const example of edge.examples) {
      const clipped = clipText(example, MAX_EXAMPLE_LENGTH);
      if (entry.examples.length < MAX_EDGE_EXAMPLES && !entry.examples.includes(clipped)) entry.examples.push(clipped);
    }
  }
  return [...byKey.values()].sort(compareEdges).slice(0, MAX_COMPONENT_EDGES);
}

function mergeExternals(externals: readonly ExternalDep[], remap: (id: string) => string, valid: ReadonlySet<string>): ExternalDep[] {
  const ranked = externals.map((dep) => {
    const users = new Map<string, number>();
    for (const use of dep.usedBy) {
      const id = remap(use.componentId);
      if (valid.has(id)) users.set(id, (users.get(id) ?? 0) + use.count);
    }
    const usedBy = [...users.entries()]
      .map(([componentId, count]) => ({ componentId, count }))
      .sort((a, b) => b.count - a.count || compareText(a.componentId, b.componentId));
    return { name: dep.name, total: usedBy.reduce((sum, use) => sum + use.count, 0), usedBy: usedBy.slice(0, MAX_USED_BY) };
  });
  return ranked
    .filter((dep) => dep.usedBy.length > 0)
    .sort((a, b) => b.total - a.total || compareText(a.name, b.name))
    .slice(0, MAX_EXTERNALS)
    .map(({ name, usedBy }) => ({ name, usedBy }));
}

function externalDepsByComponent(externals: readonly ExternalDep[]): Map<string, { name: string; count: number }[]> {
  const byComponent = new Map<string, { name: string; count: number }[]>();
  for (const dep of externals) {
    for (const use of dep.usedBy) {
      const list = byComponent.get(use.componentId) ?? [];
      list.push({ name: dep.name, count: use.count });
      byComponent.set(use.componentId, list);
    }
  }
  for (const [id, list] of byComponent) {
    byComponent.set(id, list.sort((a, b) => b.count - a.count || compareText(a.name, b.name)).slice(0, MAX_COMPONENT_EXTERNALS));
  }
  return byComponent;
}

function sizeOf(snapshot: OverviewSnapshot): number {
  return utf8ByteLength(JSON.stringify(snapshot));
}

/** Trims in a fixed order until the row fits in 512 KB minus the stage's stamp headroom (spec §5.5, §11). */
function fitSize(snapshot: OverviewSnapshot): OverviewSnapshot {
  const fits = (candidate: OverviewSnapshot): boolean => sizeOf(candidate) <= SNAPSHOT_BUDGET_BYTES;
  let next = snapshot;
  if (fits(next)) return next;
  for (const limit of FILE_LIST_STEPS) {
    next = { ...next, components: next.components.map((component) => ({ ...component, files: component.files.slice(0, limit) })) };
    if (fits(next)) return next;
  }
  next = { ...next, edges: next.edges.map((edge) => ({ ...edge, examples: [] })) };
  if (fits(next)) return next;
  next = { ...next, externals: next.externals.map((dep) => ({ ...dep, usedBy: dep.usedBy.slice(0, USED_BY_STEP) })) };
  if (fits(next)) return next;
  while (next.edges.length > 0) {
    next = { ...next, edges: next.edges.slice(0, Math.floor(next.edges.length / 2)) };
    if (fits(next)) return next;
  }
  next = { ...next, externals: [] };
  if (fits(next)) return next;
  next = { ...next, components: next.components.map((component) => ({ ...component, entryPoints: [], externalDeps: [] })) };
  if (fits(next)) return next;
  throw new RangeError(`overview snapshot exceeds ${SNAPSHOT_BUDGET_BYTES} bytes after trimming`);
}

/**
 * Spec §5.5. Pure: equal input gives an equal snapshot. Applies the 200-component cap (the
 * smallest components group into "other" and their edges follow), the 1,000-edge and
 * 120-external caps, 400 listed files per component, and the 512 KB bound (less 2 KB of headroom
 * for the `status` and `sessionId` the stage stamps afterwards). `counts` hold the
 * totals before the caps; `counts.totalFiles` is the repo's file count before the scan cap.
 * The stage adds `status` (ruling R3) after assembly.
 */
export function assembleSnapshot(input: AssembleSnapshotInput): OverviewSnapshot {
  const drafts = [...input.drafts].sort((a, b) => compareText(a.rootPath, b.rootPath));
  const capped = capComponents(drafts);
  const valid = new Set(capped.kept.map((draft) => draft.id));
  const remap = (id: string): string => capped.otherOf.get(id) ?? id;
  const edges = mergeEdges(input.edges, remap, valid);
  const externals = mergeExternals(input.externals, remap, valid);
  const depsById = externalDepsByComponent(externals);

  const components: Component[] = capped.kept.map((draft) => {
    const roleGuess: Role = draft.id === capped.otherId ? "domain" : guessRole(draft, input.externals);
    const text = input.text.get(draft.id);
    return {
      id: draft.id,
      rootPath: draft.rootPath,
      name: clipText(draft.name, MAX_NAME),
      fileCount: draft.files.length,
      files: draft.files.slice(0, MAX_COMPONENT_FILES),
      language: draft.language === null ? null : clipText(draft.language, MAX_LANGUAGE),
      roleGuess,
      role: text?.role ?? roleGuess,
      purpose: text?.purpose == null ? null : clipText(text.purpose, MAX_PURPOSE),
      provenance: text?.provenance ?? "rule",
      contentHash: draft.contentHash,
      externalDeps: depsById.get(draft.id) ?? [],
      entryPoints: draft.entryPoints.slice(0, MAX_ENTRY_POINTS),
      importsAnalyzed: draft.importsAnalyzed,
    };
  });

  const languageFiles = new Map<string, number>();
  for (const draft of drafts) {
    if (draft.language !== null) languageFiles.set(draft.language, (languageFiles.get(draft.language) ?? 0) + draft.files.length);
  }
  const languages = [...languageFiles.entries()]
    .sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))
    .slice(0, MAX_LANGUAGES)
    .map(([language]) => clipText(language, MAX_LANGUAGE));

  const files = drafts.reduce((sum, draft) => sum + draft.files.length, 0);
  return fitSize({
    sessionId: input.sessionId,
    repoRoot: input.repoRoot,
    scanId: input.scanId,
    partial: input.partial,
    counts: {
      files,
      components: drafts.length,
      edges: input.edges.length,
      languages,
      totalFiles: Math.max(files, input.totalFiles ?? files),
    },
    components,
    edges,
    externals,
    narrative: input.narrative,
    generatedAt: input.generatedAt,
  });
}
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/codebase-map exec vitest run src/core/snapshot.test.ts src/core/snapshot.property.test.ts`

Expected: PASS, `Tests  10 passed (10)`. The 512 KB trimming test takes about 2 s (200 × 300 long paths).

- [ ] **Step 3: Barrel, checks**

Append to `packages/codebase-map/src/core/index.ts`:

```ts
export * from "./snapshot.js";
```

Run `perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/codebase-map typecheck`, `perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/codebase-map build`, `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/codebase-map test` and `perl -e 'alarm 170; exec @ARGV' pnpm lint`.

Expected: exit 0; `Test Files  9 passed (9)`; lint prints nothing.

- [ ] **Step 4: Commit**

```bash
git add packages/codebase-map/src/core/snapshot.ts packages/codebase-map/src/core/snapshot.test.ts \
  packages/codebase-map/src/core/snapshot.property.test.ts packages/codebase-map/src/core/index.ts
git -c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com commit -m "feat(codebase-map): assemble overview snapshots within the component, edge and size caps"
```


### Task M-4: evidence-engine `extractImports` and `resolveSpecifier`

**Files:**
- Modify: `packages/evidence-engine/src/worker/tree-sitter.ts` (`ParseNode` gains `descendantsOfType?`; append the import walker)
- Modify: `packages/evidence-engine/src/worker/parser.ts` (full replacement below: `TreeSitterBackend.imports`)
- Modify: `packages/evidence-engine/src/worker/parse-worker.ts` (full replacement: `op: "imports"`)
- Modify: `packages/evidence-engine/src/worker/parse-service.ts` (full replacement: tasks keyed by operation, `AnalysisPool.extractImports`)
- Create: `packages/evidence-engine/src/imports.ts`
- Modify: `packages/evidence-engine/src/index.ts` (append one line)
- Test: `packages/evidence-engine/src/imports.test.ts`, `packages/evidence-engine/src/worker/parse-service.test.ts` (append one `describe`)

**Interfaces:**
- Consumes: the existing `ParserLanguage = "typescript" | "tsx" | "javascript" | "json"`, `languageForPath`, `createTreeSitterBackend`, `AnalysisPool` (`src/worker/parser.ts`, `src/worker/parse-service.ts`).
- Produces (exported from `@jevcode/evidence-engine`):
  - `extractImports(path: string, source: string, language: ParserLanguage): Promise<ExtractedImports>` with `type ExtractedImports = { specifiers: string[]; exports: string[] }` (interfaces §3, plus `exports`; deviation 7)
  - `resolveSpecifier(fromPath: string, specifier: string, ctx: ResolveContext): ResolvedSpecifier`; `interface ResolveContext { files: ReadonlySet<string>; tsPaths: Record<string, string[]>; baseUrl: string | null; workspacePackages: Record<string, string> }`; `type ResolvedSpecifier = { kind: "file"; path: string } | { kind: "external"; packageName: string } | { kind: "unresolved" }` (interfaces §3)
  - `createImportExtractor(options?: { size?: number; workerUrl?: URL; idleMs?: number }): ImportExtractor` with `interface ImportExtractor { extract: typeof extractImports; dispose(): Promise<void> }`; `IMPORT_POOL_IDLE_MS = 30_000`
  - `packageNameOf(specifier: string): string | null`
  - `AnalysisPool.extractImports(filePath: string, source: string): Promise<ImportScan>`; `TreeSitterBackend.imports(source, language): ImportScan`

**Behavior pinned by the tests:** static imports, `import x = require()`, `export … from`, and `require()`/`import()` calls with a string literal (anywhere in the file; the tree is searched only when the text contains `require(` or `import(`) become specifiers. Resolution order: relative paths (with NodeNext `.js` → `.ts`/`.tsx` mapping and index files), tsconfig `paths` (longest prefix; exact keys win), workspace package names (subpaths; a package whose entry is built output resolves to its first file, which is enough to place the component edge), `baseUrl`; then Node built-ins are unresolved and other bare specifiers are externals under their package name (deep imports collapse). JSON is never parsed.

- [ ] **Step 1: Write the failing import tests**

Create `packages/evidence-engine/src/imports.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  createImportExtractor,
  extractImports,
  packageNameOf,
  resolveSpecifier,
  type ResolveContext,
  type ResolvedSpecifier,
} from "./imports.js";

const TS_SOURCE = `import a from "./a.js";
import type { T } from "@scope/pkg/deep";
import "side-effect";
import x = require("old-style");
export * from "./re";
export { y as z } from "./y";
export const one = 1, two = 2;
export function f() {}
export class C {}
export interface I {}
export type U = string;
export enum E { A }
export default 42;
const w = require("cjs-dep");
async function g() { await import("./lazy"); const t = "x"; await import(t); }
const local = 1;
export { local, local as aliased };
`;

describe("extractImports (spec §5.1, E14)", () => {
  it("reads every static, re-export, require and dynamic import form in TypeScript", async () => {
    expect(await extractImports("src/a.ts", TS_SOURCE, "typescript")).toEqual({
      specifiers: ["./a.js", "./lazy", "./re", "./y", "@scope/pkg/deep", "cjs-dep", "old-style", "side-effect"],
      exports: ["C", "E", "I", "U", "aliased", "default", "f", "local", "one", "two", "z"],
    });
  });

  it("reads TSX and JavaScript", async () => {
    expect(
      await extractImports(
        "src/App.tsx",
        'import { useState } from "react";\nimport { App } from "./App.js";\nexport function Root() { return <App/>; }\nexport default function Page() { return null; }\n',
        "tsx",
      ),
    ).toEqual({ specifiers: ["./App.js", "react"], exports: ["Page", "Root"] });
    expect(
      await extractImports(
        "lib/x.js",
        'const fs = require("node:fs");\nimport lib from "lib";\nexport default class Foo {}\nexport { lib };\n',
        "javascript",
      ),
    ).toEqual({ specifiers: ["lib", "node:fs"], exports: ["Foo", "lib"] });
  });

  it("returns nothing for JSON without parsing it", async () => {
    expect(await extractImports("package.json", "{ not json", "json")).toEqual({ specifiers: [], exports: [] });
  });
});

const CTX: ResolveContext = {
  files: new Set([
    "src/a.ts",
    "src/b/index.ts",
    "src/c.tsx",
    "src/util.ts",
    "src/data.json",
    "lib/x.js",
    "packages/core/src/index.ts",
    "packages/core/src/node.ts",
    "packages/ui/lib/main.js",
    "types/global.d.ts",
  ]),
  tsPaths: { "@app/*": ["src/*"], "~config": ["src/util.ts"] },
  baseUrl: ".",
  workspacePackages: { "@fx/core": "packages/core", "@fx/ui": "packages/ui" },
};

const file = (path: string): ResolvedSpecifier => ({ kind: "file", path });
const external = (packageName: string): ResolvedSpecifier => ({ kind: "external", packageName });
const UNRESOLVED: ResolvedSpecifier = { kind: "unresolved" };

describe("resolveSpecifier (spec §5.1)", () => {
  it.each([
    ["./util.js", file("src/util.ts")],
    ["./b", file("src/b/index.ts")],
    ["./c.js", file("src/c.tsx")],
    ["./data.json", file("src/data.json")],
    ["./util.ts?raw", file("src/util.ts")],
    ["../types/global", file("types/global.d.ts")],
    ["../../outside", UNRESOLVED],
    ["./missing", UNRESOLVED],
    ["@app/util", file("src/util.ts")],
    ["~config", file("src/util.ts")],
    ["@fx/core", file("packages/core/src/index.ts")],
    ["@fx/core/node", file("packages/core/src/node.ts")],
    ["@fx/ui", file("packages/ui/lib/main.js")],
    ["lib/x", file("lib/x.js")],
    ["node:fs", UNRESOLVED],
    ["path", UNRESOLVED],
    ["fs/promises", UNRESOLVED],
    ["react", external("react")],
    ["react-dom/client", external("react-dom")],
    ["@scope/pkg/deep/x", external("@scope/pkg")],
    ["lodash/fp", external("lodash")],
    ["virtual:pwa", UNRESOLVED],
    ["$app/stores", UNRESOLVED],
    ["/abs/path", UNRESOLVED],
  ])("src/a.ts imports %s", (specifier, expected) => {
    expect(resolveSpecifier("src/a.ts", specifier, CTX)).toEqual(expected);
  });

  it("resolves relative paths from the importing file's directory", () => {
    expect(resolveSpecifier("src/b/index.ts", "../util", CTX)).toEqual(file("src/util.ts"));
  });

  it("reads bare specifiers as packages when there is no baseUrl", () => {
    expect(resolveSpecifier("src/a.ts", "lib/x", { ...CTX, baseUrl: null })).toEqual(external("lib"));
  });
});

describe("packageNameOf", () => {
  it.each([
    ["react", "react"],
    ["@scope/pkg/deep", "@scope/pkg"],
    ["@scope", null],
    ["virtual:x", null],
  ])("%s → %s", (specifier, expected) => {
    expect(packageNameOf(specifier)).toBe(expected);
  });
});

const OP_WORKER = `
import { parentPort } from "node:worker_threads";
parentPort.on("message", (msg) => {
  if (msg.op === "imports") {
    parentPort.postMessage({ id: msg.id, filePath: msg.filePath, imports: { specifiers: [msg.source], exports: [] } });
  } else {
    parentPort.postMessage({ id: msg.id, filePath: msg.filePath, symbols: [] });
  }
});
`;
const opWorkerUrl = (): URL => new URL(`data:text/javascript;base64,${Buffer.from(OP_WORKER, "utf8").toString("base64")}`);

describe("createImportExtractor", () => {
  it("extracts in a worker pool, restarts the pool after it idles out, and refuses work after dispose", async () => {
    const extractor = createImportExtractor({ size: 1, workerUrl: opWorkerUrl(), idleMs: 20 });
    try {
      expect(await extractor.extract("a.ts", "./one", "typescript")).toEqual({ specifiers: ["./one"], exports: [] });
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(await extractor.extract("b.ts", "./two", "typescript")).toEqual({ specifiers: ["./two"], exports: [] });
      expect(await extractor.extract("c.json", "{}", "json")).toEqual({ specifiers: [], exports: [] });
    } finally {
      await extractor.dispose();
    }
    await expect(extractor.extract("d.ts", "x", "typescript")).rejects.toThrow(/disposed/);
  });
});
```

Append to `packages/evidence-engine/src/worker/parse-service.test.ts`:

```ts
describe("AnalysisPool import extraction", () => {
  const OP_WORKER = `
import { parentPort } from "node:worker_threads";
parentPort.on("message", (msg) => {
  setTimeout(() => {
    if (msg.op === "imports") {
      parentPort.postMessage({ id: msg.id, filePath: msg.filePath, imports: { specifiers: [msg.source], exports: [] } });
    } else {
      parentPort.postMessage({
        id: msg.id,
        filePath: msg.filePath,
        symbols: [{ name: msg.source, kind: "function", signature: "op", startLine: 1, endLine: 1 }],
      });
    }
  }, 20);
});
`;
  const opWorkerUrl = (): URL => new URL(`data:text/javascript;base64,${Buffer.from(OP_WORKER, "utf8").toString("base64")}`);

  it("routes import scans and symbol parses of the same queued file separately", async () => {
    const pool = new AnalysisPool({ size: 1, workerUrl: opWorkerUrl() });
    try {
      const busy = pool.parseFile("busy.ts", "busy");
      const symbols = pool.parseFile("a.ts", "sym");
      const imports = pool.extractImports("a.ts", "./dep");
      expect(imports).not.toBe(symbols);
      expect((await symbols)[0]?.name).toBe("sym");
      expect(await imports).toEqual({ specifiers: ["./dep"], exports: [] });
      await busy;
    } finally {
      await pool.dispose();
    }
  });
});
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/evidence-engine exec vitest run src/imports.test.ts src/worker/parse-service.test.ts`

Expected: `imports.test.ts` fails with `Failed to resolve import "./imports.js"`; the new `parse-service.test.ts` case fails with `TypeError: pool.extractImports is not a function`; the six existing pool tests pass.

- [ ] **Step 2: Add the import walker to `tree-sitter.ts`**

In `packages/evidence-engine/src/worker/tree-sitter.ts`, find:

```ts
  children: readonly ParseNode[];
  childForFieldName(fieldName: string): ParseNode | null;
}
```

Replace it with:

```ts
  children: readonly ParseNode[];
  childForFieldName(fieldName: string): ParseNode | null;
  /** web-tree-sitter and node-tree-sitter both provide it; extractImportSpecifiers falls back to a walk. */
  descendantsOfType?(types: string | string[]): ParseNode[];
}
```

Append to the end of the file:

```ts
/** Import specifiers and top-level exported names of one file (spec §5.1). */
export interface ImportScan {
  specifiers: string[];
  exports: string[];
}

const EXPORT_DECLARATION_TYPES = new Set([
  ...DECLARATION_NODE_TYPES,
  "generator_function_declaration",
  "abstract_class_declaration",
  "enum_declaration",
]);

// require( and import( can sit anywhere in a file; static imports and exports are top-level.
const DYNAMIC_IMPORT_HINT = /\brequire\s*\(|\bimport\s*\(/;

function stringLiteral(node: ParseNode | null | undefined, source: string): string | null {
  if (!node || node.type !== "string") return null;
  const raw = source.slice(node.startIndex, node.endIndex);
  return raw.length >= 2 ? raw.slice(1, -1) : null;
}

function moduleSource(node: ParseNode): ParseNode | null {
  return node.childForFieldName("source") ?? node.children.find((child) => child.type === "string") ?? null;
}

function exportedNames(node: ParseNode, source: string): string[] {
  const names: string[] = [];
  const declaration = node.children.find((child) => EXPORT_DECLARATION_TYPES.has(child.type));
  if (declaration) {
    if (declaration.type === "lexical_declaration" || declaration.type === "variable_declaration") {
      for (const child of declaration.children) {
        if (child.type !== "variable_declarator") continue;
        const name = child.childForFieldName("name");
        if (name && name.type === "identifier") names.push(textOf(name, source));
      }
    } else {
      const name = declaration.childForFieldName("name");
      if (name) names.push(textOf(name, source));
    }
  }
  for (const child of node.children) {
    if (child.type !== "export_clause") continue;
    for (const spec of child.children) {
      if (spec.type !== "export_specifier") continue;
      const binding = spec.childForFieldName("alias") ?? spec.childForFieldName("name");
      if (binding) names.push(textOf(binding, source));
    }
  }
  if (names.length === 0 && node.children.some((child) => child.type === "default")) names.push("default");
  return names;
}

function descendantsOfType(root: ParseNode, type: string): readonly ParseNode[] {
  if (root.descendantsOfType) return root.descendantsOfType(type);
  const out: ParseNode[] = [];
  const stack: ParseNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as ParseNode;
    if (node.type === type) out.push(node);
    for (const child of node.children) stack.push(child);
  }
  return out;
}

/**
 * Static imports and re-exports (`import … from`, `import "x"`, `import x = require("x")`,
 * `export … from`), plus `require("x")` and `import("x")` calls with a string literal anywhere
 * in the file. Template literals and computed specifiers are ignored. Both lists are sorted
 * and unique.
 */
export function extractImportSpecifiers(root: ParseNode, source: string): ImportScan {
  const specifiers = new Set<string>();
  const exports = new Set<string>();
  const add = (value: string | null): void => {
    if (value !== null && value !== "") specifiers.add(value);
  };
  for (const node of root.children) {
    if (node.type === "import_statement") {
      const requireClause = node.children.find((child) => child.type === "import_require_clause");
      add(stringLiteral(moduleSource(requireClause ?? node), source));
    } else if (node.type === "export_statement") {
      add(stringLiteral(node.childForFieldName("source"), source));
      for (const name of exportedNames(node, source)) exports.add(name);
    }
  }
  if (DYNAMIC_IMPORT_HINT.test(source)) {
    for (const call of descendantsOfType(root, "call_expression")) {
      const callee = call.childForFieldName("function");
      if (!callee) continue;
      const isRequire = callee.type === "identifier" && source.slice(callee.startIndex, callee.endIndex) === "require";
      if (!isRequire && callee.type !== "import") continue;
      const args = call.childForFieldName("arguments");
      const first = args?.children.find((child) => child.type !== "(" && child.type !== ")" && child.type !== ",");
      add(stringLiteral(first, source));
    }
  }
  return { specifiers: [...specifiers].sort(), exports: [...exports].sort() };
}
```

- [ ] **Step 3: Replace `parser.ts`, `parse-worker.ts` and `parse-service.ts`**

Replace the whole of `packages/evidence-engine/src/worker/parser.ts` with:

```ts
import { createRequire } from "node:module";
import path from "node:path";

import type { SymbolInfo } from "@jevcode/contracts";

import { extractImportSpecifiers, extractSymbols, type ImportScan, type ParseNode } from "./tree-sitter.js";

export type ParserLanguage = "typescript" | "tsx" | "javascript" | "json";

const EXTENSION_LANGUAGES: Readonly<Record<string, ParserLanguage>> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".json": "json",
};

export function languageForPath(filePath: string): ParserLanguage | null {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_LANGUAGES[ext] ?? null;
}

const GRAMMAR_FILES: Readonly<Record<ParserLanguage, string>> = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  json: "tree-sitter-json.wasm",
};

export interface TreeSitterBackend {
  parse(source: string, language: ParserLanguage): SymbolInfo[];
  /** Import specifiers and exported names; JSON has none and is not parsed. */
  imports(source: string, language: ParserLanguage): ImportScan;
  dispose(): Promise<void>;
}

interface ReusableParser {
  setLanguage(language: unknown): void;
  parse(source: string): { rootNode: ParseNode; delete?(): void };
  delete?(): void;
}

interface WebTreeSitterModule {
  init(): Promise<void>;
  Language: { load(wasmPath: string): Promise<unknown> };
  new (): unknown;
}

type AnyWebModule = Record<string, unknown> & { default?: unknown };

function resolveGrammarPath(language: ParserLanguage): string {
  const require = createRequire(import.meta.url);
  const grammarFile = GRAMMAR_FILES[language];
  try {
    return require.resolve(`tree-sitter-wasms/out/${grammarFile}`);
  } catch {
    const packageDir = path.dirname(
      require.resolve("tree-sitter-wasms/package.json"),
    );
    return path.join(packageDir, "out", grammarFile);
  }
}

export async function createTreeSitterBackend(): Promise<TreeSitterBackend> {
  let webError: unknown;
  try {
    return await createWebTreeSitterBackend();
  } catch (error) {
    webError = error;
  }
  try {
    const native = await import("node-tree-sitter");
    return createNativeTreeSitterBackend(native);
  } catch {
    const message =
      webError instanceof Error ? webError.message : String(webError);
    throw new Error(
      `tree-sitter backend initialization failed (web-tree-sitter unavailable: ${message}; node-tree-sitter not installed)`,
    );
  }
}

async function createWebTreeSitterBackend(): Promise<TreeSitterBackend> {
  const module = (await import("web-tree-sitter")) as AnyWebModule;
  const root = (module.default ?? module) as AnyWebModule;
  const Parser = (root.Parser ?? root) as unknown as WebTreeSitterModule;
  if (typeof Parser.init !== "function") {
    throw new Error("web-tree-sitter module surface does not match expectations");
  }
  await Parser.init();
  // Language is attached to the Parser class only after init() resolves
  const Language = (root.Language ??
    Parser.Language) as unknown as WebTreeSitterModule["Language"];
  if (typeof Language?.load !== "function") {
    throw new Error("web-tree-sitter Language loader unavailable after init");
  }
  const languages = new Map<ParserLanguage, unknown>();
  for (const language of Object.keys(GRAMMAR_FILES) as ParserLanguage[]) {
    languages.set(language, await Language.load(resolveGrammarPath(language)));
  }
  // One parser per language for import scans: a scan parses thousands of files in a row.
  const importParsers = new Map<ParserLanguage, ReusableParser>();
  return {
    imports(source: string, language: ParserLanguage): ImportScan {
      if (language === "json") return { specifiers: [], exports: [] };
      let parser = importParsers.get(language);
      if (parser === undefined) {
        const grammarLanguage = languages.get(language);
        if (!grammarLanguage) {
          throw new Error(`grammar not loaded for language: ${language}`);
        }
        parser = new Parser() as unknown as ReusableParser;
        parser.setLanguage(grammarLanguage);
        importParsers.set(language, parser);
      }
      const tree = parser.parse(source);
      try {
        return extractImportSpecifiers(tree.rootNode, source);
      } finally {
        tree.delete?.();
      }
    },
    parse(source: string, language: ParserLanguage): SymbolInfo[] {
      const grammarLanguage = languages.get(language);
      if (!grammarLanguage) {
        throw new Error(`grammar not loaded for language: ${language}`);
      }
      const parser = new Parser() as unknown as {
        setLanguage(language: unknown): void;
        parse(source: string): { rootNode: ParseNode };
        delete(): void;
      };
      try {
        parser.setLanguage(grammarLanguage);
        const tree = parser.parse(source);
        return extractSymbols(tree.rootNode, source);
      } finally {
        parser.delete();
      }
    },
    async dispose(): Promise<void> {
      for (const parser of importParsers.values()) parser.delete?.();
      importParsers.clear();
      languages.clear();
    },
  };
}

function createNativeTreeSitterBackend(module: unknown): TreeSitterBackend {
  const root = module as AnyWebModule;
  const Parser = root.Parser as unknown as WebTreeSitterModule;
  const Language = root.Language as unknown as WebTreeSitterModule["Language"];
  return {
    parse(source: string, language: ParserLanguage): SymbolInfo[] {
      const require = createRequire(import.meta.url);
      const grammarPackage =
        language === "tsx" ? "tree-sitter-tsx" : `tree-sitter-${language}`;
      const grammarLanguage = Language.load(require.resolve(grammarPackage));
      const parser = new Parser() as unknown as {
        setLanguage(language: unknown): void;
        parse(source: string): { rootNode: ParseNode };
      };
      parser.setLanguage(grammarLanguage);
      return extractSymbols(parser.parse(source).rootNode, source);
    },
    imports(source: string, language: ParserLanguage): ImportScan {
      if (language === "json") return { specifiers: [], exports: [] };
      const require = createRequire(import.meta.url);
      const grammarPackage =
        language === "tsx" ? "tree-sitter-tsx" : `tree-sitter-${language}`;
      const parser = new Parser() as unknown as ReusableParser;
      parser.setLanguage(Language.load(require.resolve(grammarPackage)));
      return extractImportSpecifiers(parser.parse(source).rootNode, source);
    },
    async dispose(): Promise<void> {},
  };
}
```

Replace the whole of `packages/evidence-engine/src/worker/parse-worker.ts` with:

```ts
import { parentPort } from "node:worker_threads";

import {
  createTreeSitterBackend,
  languageForPath,
} from "./parser.js";
import type { ImportScan } from "./tree-sitter.js";

interface ParseRequest {
  id: number;
  /** "imports" extracts import specifiers (codebase map); absent means symbols. */
  op?: "symbols" | "imports";
  filePath: string;
  source: string;
}

interface ParseResponse {
  id: number;
  filePath: string;
  symbols?: unknown[];
  imports?: ImportScan;
  error?: string;
}

if (!parentPort) {
  throw new Error("parse-worker must run inside a worker thread");
}

const port = parentPort;
const backend = await createTreeSitterBackend();

port.on("message", (request: ParseRequest) => {
  const response: ParseResponse = { id: request.id, filePath: request.filePath };
  try {
    const language = languageForPath(request.filePath);
    if (request.op === "imports") {
      response.imports = language ? backend.imports(request.source, language) : { specifiers: [], exports: [] };
    } else {
      response.symbols = language ? backend.parse(request.source, language) : [];
    }
  } catch (error) {
    response.error = error instanceof Error ? error.message : String(error);
  }
  port.postMessage(response);
});
```

Replace the whole of `packages/evidence-engine/src/worker/parse-service.ts` with:

```ts
import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";

import type { SymbolInfo } from "@jevcode/contracts";

import {
  createTreeSitterBackend,
  languageForPath,
  type TreeSitterBackend,
} from "./parser.js";
import type { ImportScan } from "./tree-sitter.js";

export interface ParseService {
  parseFile(filePath: string, source: string): Promise<SymbolInfo[]>;
  dispose(): Promise<void>;
}

export function createInlineParseService(): ParseService {
  let backendPromise: Promise<TreeSitterBackend> | null = null;
  let disposed = false;
  const backend = (): Promise<TreeSitterBackend> => {
    backendPromise ??= createTreeSitterBackend();
    return backendPromise;
  };
  return {
    async parseFile(filePath: string, source: string): Promise<SymbolInfo[]> {
      if (disposed) throw new Error("parse service disposed");
      if (languageForPath(filePath) === null) return [];
      return (await backend()).parse(source, languageForPath(filePath)!);
    },
    async dispose(): Promise<void> {
      disposed = true;
      if (backendPromise) {
        await (await backendPromise).dispose();
      }
    },
  };
}

type TaskOp = "symbols" | "imports";

interface TaskItem {
  id: number;
  op: TaskOp;
  filePath: string;
  source: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  promise: Promise<unknown>;
}

interface WorkerResponse {
  id: number;
  filePath: string;
  symbols?: SymbolInfo[];
  imports?: ImportScan;
  error?: string;
}

/** Same-file merging applies per operation: an import scan never merges into a symbol parse. */
function taskKey(op: TaskOp, filePath: string): string {
  return `${op}\u0000${filePath}`;
}

export interface AnalysisPoolOptions {
  size?: number;
  workerUrl?: URL;
  maxQueueSize?: number;
}

const DEFAULT_MAX_QUEUE_SIZE = 100;

export class AnalysisPool implements ParseService {
  private readonly workerUrl: URL;
  private readonly maxQueueSize: number;
  private readonly workers: Worker[] = [];
  private readonly busy = new Set<Worker>();
  private readonly queue: number[] = [];
  private readonly tasks = new Map<number, TaskItem>();
  private readonly runningByWorker = new Map<Worker, number>();
  private readonly taskWorker = new Map<number, Worker>();
  private readonly inflightByFile = new Map<string, number>();
  private nextId = 1;
  private disposed = false;

  constructor(options: AnalysisPoolOptions = {}) {
    const size = Math.max(
      1,
      options.size ?? Math.max(1, availableParallelism() - 1),
    );
    this.workerUrl = options.workerUrl ?? new URL("./parse-worker.js", import.meta.url);
    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    for (let i = 0; i < size; i++) {
      this.spawnWorker(this.workerUrl);
    }
  }

  get queueDepth(): number {
    return this.queue.length;
  }

  private spawnWorker(workerUrl: URL): void {
    const worker = new Worker(workerUrl, { type: "module" });
    worker.on("message", (response: WorkerResponse) => {
      this.busy.delete(worker);
      this.runningByWorker.delete(worker);
      const task = this.tasks.get(response.id);
      if (!task) {
        this.dispatch();
        return;
      }
      this.tasks.delete(response.id);
      this.taskWorker.delete(response.id);
      const key = taskKey(task.op, task.filePath);
      if (this.inflightByFile.get(key) === response.id) {
        this.inflightByFile.delete(key);
      }
      if (response.error !== undefined) {
        task.reject(new Error(response.error));
      } else if (task.op === "imports") {
        task.resolve(response.imports ?? { specifiers: [], exports: [] });
      } else {
        task.resolve(response.symbols ?? []);
      }
      this.dispatch();
    });
    worker.on("error", (error: Error) => {
      this.dropWorker(worker, new Error(`analysis worker error: ${error.message}`));
    });
    worker.on("exit", (code: number) => {
      if (!this.disposed) {
        this.dropWorker(
          worker,
          new Error(`analysis worker exited unexpectedly (code ${code})`),
        );
      }
    });
    this.workers.push(worker);
  }

  private dropWorker(worker: Worker, error: Error): void {
    const index = this.workers.indexOf(worker);
    if (index === -1) return;
    this.workers.splice(index, 1);
    this.busy.delete(worker);
    const runningId = this.runningByWorker.get(worker);
    this.runningByWorker.delete(worker);
    if (runningId !== undefined) {
      this.taskWorker.delete(runningId);
      const task = this.tasks.get(runningId);
      this.tasks.delete(runningId);
      if (task !== undefined) {
        const key = taskKey(task.op, task.filePath);
        if (this.inflightByFile.get(key) === runningId) {
          this.inflightByFile.delete(key);
        }
        task.reject(error);
      }
    }
    void worker.terminate();
    if (!this.disposed) {
      this.spawnWorker(this.workerUrl);
    }
    this.dispatch();
  }

  private dispatch(): void {
    while (this.queue.length > 0) {
      const idle = this.workers.find((worker) => !this.busy.has(worker));
      if (!idle) return;
      const id = this.queue.shift();
      if (id === undefined) return;
      const item = this.tasks.get(id);
      if (item === undefined) continue;
      this.busy.add(idle);
      this.runningByWorker.set(idle, id);
      this.taskWorker.set(id, idle);
      idle.postMessage({
        id: item.id,
        op: item.op,
        filePath: item.filePath,
        source: item.source,
      });
    }
  }

  parseFile(filePath: string, source: string): Promise<SymbolInfo[]> {
    return this.enqueue("symbols", filePath, source) as Promise<SymbolInfo[]>;
  }

  /** Import specifiers and exported names of one file, parsed in a worker (codebase map, spec §5.1). */
  extractImports(filePath: string, source: string): Promise<ImportScan> {
    return this.enqueue("imports", filePath, source) as Promise<ImportScan>;
  }

  private enqueue(op: TaskOp, filePath: string, source: string): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error("analysis pool disposed"));
    if (this.workers.length === 0) {
      return Promise.reject(new Error("no analysis workers available"));
    }
    const key = taskKey(op, filePath);
    const inflightId = this.inflightByFile.get(key);
    if (inflightId !== undefined && this.queue.includes(inflightId)) {
      const item = this.tasks.get(inflightId);
      if (item !== undefined) {
        item.source = source;
        return item.promise;
      }
    }
    if (this.queue.length >= this.maxQueueSize) {
      return Promise.reject(
        new Error(`analysis pool queue full (${this.maxQueueSize} pending parses)`),
      );
    }
    const id = this.nextId++;
    const item: TaskItem = {
      id,
      op,
      filePath,
      source,
      resolve: () => {},
      reject: () => {},
      promise: Promise.resolve(undefined),
    };
    item.promise = new Promise<unknown>((resolve, reject) => {
      item.resolve = resolve;
      item.reject = reject;
    });
    this.tasks.set(id, item);
    this.queue.push(id);
    this.inflightByFile.set(key, id);
    this.dispatch();
    return item.promise;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const worker of this.workers) {
      await worker.terminate();
    }
    this.workers.length = 0;
    for (const [, task] of this.tasks) {
      task.reject(new Error("analysis pool disposed"));
    }
    this.tasks.clear();
    this.queue.length = 0;
    this.inflightByFile.clear();
    this.taskWorker.clear();
    this.runningByWorker.clear();
    this.busy.clear();
  }
}
```

The changes against the current files: the web backend keeps one parser per language for import scans and deletes each tree after reading it; the native backend gains the same `imports`; the worker answers `op: "imports"` with `imports`; the pool's tasks carry `op`, same-file merging is keyed by `op` and path (an import scan never merges into a queued symbol parse), and `extractImports` enqueues an `imports` task. `parseFile` behaves exactly as before.

- [ ] **Step 4: Create `imports.ts` and export it**

Create `packages/evidence-engine/src/imports.ts`:

```ts
import { builtinModules } from "node:module";
import { availableParallelism } from "node:os";

import { AnalysisPool } from "./worker/parse-service.js";
import { createTreeSitterBackend, type ParserLanguage, type TreeSitterBackend } from "./worker/parser.js";
import type { ImportScan } from "./worker/tree-sitter.js";

/** Import specifiers and top-level exported names of one file. */
export type ExtractedImports = ImportScan;

/** Resolution inputs for one repo. `tsPaths` targets are relative to `baseUrl ?? "."`. */
export interface ResolveContext {
  files: ReadonlySet<string>;
  tsPaths: Record<string, string[]>;
  baseUrl: string | null;
  /** Workspace package name → package directory, e.g. "@jevcode/contracts" → "packages/contracts". */
  workspacePackages: Record<string, string>;
}

export type ResolvedSpecifier =
  | { kind: "file"; path: string }
  | { kind: "external"; packageName: string }
  | { kind: "unresolved" };

export interface ImportExtractor {
  extract: typeof extractImports;
  dispose(): Promise<void>;
}

export interface ImportExtractorOptions {
  size?: number;
  workerUrl?: URL;
  idleMs?: number;
}

/** A pool with no work for this long stops its workers; the next call starts a new pool. */
export const IMPORT_POOL_IDLE_MS = 30_000;
const IMPORT_POOL_QUEUE = 256;
const MAX_PACKAGE_NAME_LENGTH = 214;
const PACKAGE_NAME = /^(?:@[a-z0-9~][\w.~-]*\/)?[a-z0-9~][\w.~-]*$/i;
const BUILTINS: ReadonlySet<string> = new Set(
  builtinModules.map((name) => name.replace(/^node:/, "").split("/")[0] ?? name),
);
const PROBE_SUFFIXES = [
  "", ".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json",
  "/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/index.mjs", "/index.cjs",
];
// NodeNext sources import "./x.js" for "./x.ts".
const JS_TO_TS: readonly [string, readonly string[]][] = [
  [".js", [".ts", ".tsx"]],
  [".jsx", [".tsx"]],
  [".mjs", [".mts"]],
  [".cjs", [".cts"]],
];

const emptyScan = (): ExtractedImports => ({ specifiers: [], exports: [] });

let inlineBackend: Promise<TreeSitterBackend> | null = null;

/**
 * Parses one file on the calling thread (tests and small inputs). The desktop scan uses
 * `createImportExtractor().extract`, which runs the same parse in worker threads.
 */
export async function extractImports(
  _path: string,
  source: string,
  language: ParserLanguage,
): Promise<ExtractedImports> {
  if (language === "json") return emptyScan();
  inlineBackend ??= createTreeSitterBackend().catch((error: unknown) => {
    inlineBackend = null;
    throw error;
  });
  return (await inlineBackend).imports(source, language);
}

/** A lazily started worker pool for scans (spec §6.1: scans run off the main thread). */
export function createImportExtractor(options: ImportExtractorOptions = {}): ImportExtractor {
  const size = options.size ?? Math.max(1, Math.min(6, availableParallelism() - 2));
  const idleMs = options.idleMs ?? IMPORT_POOL_IDLE_MS;
  let pool: AnalysisPool | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let inflight = 0;
  let disposed = false;

  const stopIdlePool = (): void => {
    idleTimer = null;
    if (inflight > 0 || pool === null) return;
    const idlePool = pool;
    pool = null;
    void idlePool.dispose();
  };

  return {
    async extract(path, source, language) {
      if (disposed) throw new Error("import extractor disposed");
      if (language === "json") return emptyScan();
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      pool ??= new AnalysisPool({ size, workerUrl: options.workerUrl, maxQueueSize: IMPORT_POOL_QUEUE });
      inflight += 1;
      try {
        return await pool.extractImports(path, source);
      } finally {
        inflight -= 1;
        if (inflight === 0 && !disposed) {
          idleTimer = setTimeout(stopIdlePool, idleMs);
          idleTimer.unref();
        }
      }
    },
    async dispose() {
      disposed = true;
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = null;
      const current = pool;
      pool = null;
      if (current !== null) await current.dispose();
    },
  };
}

/** "react-dom/client" → "react-dom"; "@scope/pkg/deep" → "@scope/pkg". */
export function packageNameOf(specifier: string): string | null {
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? (parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null) : (parts[0] ?? null);
  if (name === null || name.length > MAX_PACKAGE_NAME_LENGTH || !PACKAGE_NAME.test(name)) return null;
  return name;
}

function normalize(path: string): string | null {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

function joinBase(base: string | null, rest: string): string | null {
  return normalize(base === null || base === "" || base === "." ? rest : `${base}/${rest}`);
}

function probeFile(candidate: string | null, files: ReadonlySet<string>): string | null {
  if (candidate === null || candidate === "") return null;
  for (const suffix of PROBE_SUFFIXES) {
    if (files.has(`${candidate}${suffix}`)) return `${candidate}${suffix}`;
  }
  for (const [extension, alternatives] of JS_TO_TS) {
    if (!candidate.endsWith(extension)) continue;
    const stem = candidate.slice(0, -extension.length);
    for (const alternative of alternatives) {
      if (files.has(`${stem}${alternative}`)) return `${stem}${alternative}`;
    }
  }
  return null;
}

function resolveTsPath(specifier: string, ctx: ResolveContext): string | null {
  let best: { score: number; targets: readonly string[]; wildcard: string } | null = null;
  for (const [pattern, targets] of Object.entries(ctx.tsPaths)) {
    const star = pattern.indexOf("*");
    if (star === -1) {
      if (pattern === specifier) best = { score: Number.MAX_SAFE_INTEGER, targets, wildcard: "" };
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (
      specifier.length >= prefix.length + suffix.length &&
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix) &&
      (best === null || prefix.length > best.score)
    ) {
      best = { score: prefix.length, targets, wildcard: specifier.slice(prefix.length, specifier.length - suffix.length) };
    }
  }
  if (best === null) return null;
  for (const target of best.targets) {
    const hit = probeFile(joinBase(ctx.baseUrl, target.replace("*", best.wildcard)), ctx.files);
    if (hit !== null) return hit;
  }
  return null;
}

const firstFileCache = new WeakMap<ResolveContext, Map<string, string | null>>();

function firstFileUnder(dir: string, ctx: ResolveContext): string | null {
  let cache = firstFileCache.get(ctx);
  if (cache === undefined) {
    cache = new Map();
    firstFileCache.set(ctx, cache);
  }
  if (!cache.has(dir)) {
    let first: string | null = null;
    for (const file of ctx.files) {
      if (file.startsWith(`${dir}/`) && (first === null || file < first)) first = file;
    }
    cache.set(dir, first);
  }
  return cache.get(dir) ?? null;
}

function resolveWorkspace(specifier: string, ctx: ResolveContext): string | null {
  const names = Object.keys(ctx.workspacePackages).sort((a, b) => b.length - a.length);
  for (const name of names) {
    if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
    const dir = ctx.workspacePackages[name] as string;
    const sub = specifier === name ? "" : specifier.slice(name.length + 1);
    const candidates = sub === "" ? [`${dir}/src/index`, `${dir}/index`, `${dir}/src/main`, `${dir}/main`] : [`${dir}/${sub}`, `${dir}/src/${sub}`];
    for (const candidate of candidates) {
      const hit = probeFile(normalize(candidate), ctx.files);
      if (hit !== null) return hit;
    }
    // The package lives in the repo even when its entry is built output: any member file
    // places the edge on the right component.
    return firstFileUnder(dir, ctx);
  }
  return null;
}

/**
 * Spec §5.1: relative paths, then tsconfig `paths`, then workspace package names, then
 * `baseUrl`. Node built-ins and non-package specifiers ("virtual:x", "$app/x") are
 * unresolved; other bare specifiers are external under their package name.
 */
export function resolveSpecifier(fromPath: string, specifier: string, ctx: ResolveContext): ResolvedSpecifier {
  const spec = specifier.replace(/[?#].*$/, "");
  if (spec === "" || spec.startsWith("/")) return { kind: "unresolved" };
  if (spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../")) {
    const slash = fromPath.lastIndexOf("/");
    const dir = slash === -1 ? "" : fromPath.slice(0, slash);
    const hit = probeFile(normalize(dir === "" ? spec : `${dir}/${spec}`), ctx.files);
    return hit === null ? { kind: "unresolved" } : { kind: "file", path: hit };
  }
  const viaPaths = resolveTsPath(spec, ctx);
  if (viaPaths !== null) return { kind: "file", path: viaPaths };
  const viaWorkspace = resolveWorkspace(spec, ctx);
  if (viaWorkspace !== null) return { kind: "file", path: viaWorkspace };
  if (ctx.baseUrl !== null) {
    const hit = probeFile(joinBase(ctx.baseUrl, spec), ctx.files);
    if (hit !== null) return { kind: "file", path: hit };
  }
  if (spec.startsWith("node:") || BUILTINS.has(spec.split("/")[0] ?? "")) return { kind: "unresolved" };
  const packageName = packageNameOf(spec);
  return packageName === null ? { kind: "unresolved" } : { kind: "external", packageName };
}
```

Append to `packages/evidence-engine/src/index.ts`:

```ts
export * from "./imports.js";
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/evidence-engine exec vitest run src/imports.test.ts src/worker/parse-service.test.ts src/worker/parser.test.ts`

Expected: PASS, `Tests  55 passed (55)` (34 import, 7 pool, 14 parser).

- [ ] **Step 5: Checks**

Run, in order:

```bash
perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/evidence-engine typecheck
perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/evidence-engine build
perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/evidence-engine test
perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/jev-router exec vitest run src/state.parser.test.ts
perl -e 'alarm 170; exec @ARGV' pnpm lint
```

Expected: typecheck and build exit 0 (`dist/worker/parse-worker.js` and `dist/imports.js` exist); `Test Files  15 passed (15)`, `Tests  219 passed (219)` (184 before plus 35); the jev-router parser test (a `TreeSitterBackend` consumer) passes; lint prints nothing. `file-watcher.test.ts` is a known flake (index §7); rerun the package alone if it fails.

- [ ] **Step 6: Commit**

```bash
git add packages/evidence-engine/src/worker/tree-sitter.ts packages/evidence-engine/src/worker/parser.ts \
  packages/evidence-engine/src/worker/parse-worker.ts packages/evidence-engine/src/worker/parse-service.ts \
  packages/evidence-engine/src/worker/parse-service.test.ts packages/evidence-engine/src/imports.ts \
  packages/evidence-engine/src/imports.test.ts packages/evidence-engine/src/index.ts
git -c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com commit -m "feat(evidence-engine): extract and resolve import specifiers for the codebase map"
```


### Task M-5: `scanRepo` (git ls-files, skips, caps, manifests, tsconfig) with fixture repos

**Files:**
- Modify: `packages/codebase-map/src/core/paths.ts` (append `isSkippedPath`, `normalizePath`)
- Create: `packages/codebase-map/src/core/manifest.ts`
- Modify: `packages/codebase-map/src/core/index.ts` (append one line)
- Create: `packages/codebase-map/src/node/scan.ts`, `packages/codebase-map/src/node/index.ts`
- Create: `packages/codebase-map/src/node/test-support/fixture-repos.ts` (test-only; excluded from the build)
- Test: `packages/codebase-map/src/core/skip.test.ts`, `packages/codebase-map/src/core/manifest.test.ts`, `packages/codebase-map/src/node/scan.test.ts`

**Interfaces:**
- Consumes: M-1 `componentize`, `languageOf`, `compareText`, `dirnameOf`, `ScannedFile`, `WorkspaceManifest`, `TsconfigPaths`; M-3 `assembleSnapshot` and `utf8ByteLength` (tests); K-2 `OverviewSnapshotSchema`, `OVERVIEW_SNAPSHOT_MAX_BYTES` (tests).
- Produces:
  - `@jevcode/codebase-map/node`: `scanRepo(repoRoot: string, options?: ScanOptions): Promise<ScanResult>`, `scanPaths(repoRoot: string, paths: readonly string[], options?: Pick<ScanOptions, "maxFileBytes" | "signal" | "visit">): Promise<ScanPathsResult>`, `listRepoFiles`, `looksBinary`, `isLfsPointer`, `MAX_SCAN_FILES = 20_000`, `MAX_FILE_BYTES = 1_048_576`
  - `interface ScanOptions { maxFiles?; maxFileBytes?; signal?; onProgress?(done, total); visit?(file: ScannedFile, source: string): Promise<void> | void }`; `interface ScanResult { files: ScannedFile[]; manifest: WorkspaceManifest; partial: boolean; tsconfig: TsconfigPaths; totalFiles: number }` (`totalFiles`: files that pass the path skips before the cap when partial, else `files.length`; ruling R3); `interface ScanPathsResult { files: ScannedFile[]; gone: string[] }` (deviations 3 and 6)
  - `@jevcode/codebase-map`: `isSkippedPath`, `normalizePath`, `buildManifest(paths, texts)`, `tsconfigFromTexts(texts)`, `parseJsonc`, `parsePnpmWorkspace`, `workspaceGlobs`, `globToRegExp`

**Scan rules pinned by the tests** (spec §5.1, §10): files come from `git ls-files -z --cached --others --exclude-standard`; directories `node_modules`, `dist`, `build`, `out`, `.next`, `coverage`, `vendor` are skipped anywhere in the path; lockfiles, minified files, source maps and snapshots are generated and skipped; binary extensions, files with a NUL byte in the first 8,000 bytes, Git LFS pointers and files over 1 MiB are skipped; `.env*` (except `.env.example`, `.sample`, `.template`), private keys and credential files are skipped by name before any read; symlinks are never followed (`lstat`); at most 20,000 files (in path order) are read, and `partial` is true past that. `scanPaths` normalizes watcher paths, drops absolute and `../` paths, and treats gitignored paths as gone.

- [ ] **Step 1: Write the failing skip and manifest tests**

Create `packages/codebase-map/src/core/skip.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { isSkippedPath, normalizePath } from "./paths.js";

describe("isSkippedPath (spec §5.1, §10)", () => {
  it.each([
    ["node_modules/x/index.js", true],
    ["packages/a/dist/index.js", true],
    ["build/out.js", true],
    [".next/cache/a.js", true],
    ["coverage/lcov.info", true],
    ["vendor/lib.js", true],
    ["pnpm-lock.yaml", true],
    ["web/app.min.js", true],
    ["web/app.js.map", true],
    ["assets/logo.png", true],
    ["fonts/a.woff2", true],
    [".env", true],
    [".env.local", true],
    ["certs/server.pem", true],
    ["keys/id_rsa", true],
    ["config/api.key", true],
    [".npmrc", true],
    [".env.example", false],
    ["src/env.ts", false],
    ["src/build.ts", false],
    ["src/keyboard.ts", false],
    ["docs/dist.md", false],
  ])("%s → %s", (path, expected) => {
    expect(isSkippedPath(path)).toBe(expected);
  });
});

describe("normalizePath", () => {
  it.each([
    ["./a/b", "a/b"],
    ["a/../b", "b"],
    ["a/./b/", "a/b"],
    [".", ""],
    ["../x", null],
    ["/etc/hosts", null],
  ])("%s → %s", (input, expected) => {
    expect(normalizePath(input)).toBe(expected);
  });
});
```

Create `packages/codebase-map/src/core/manifest.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { buildManifest, globToRegExp, parseJsonc, parsePnpmWorkspace, tsconfigFromTexts, workspaceGlobs } from "./manifest.js";

describe("parsePnpmWorkspace", () => {
  it("reads block lists with quotes, comments and column-zero items, and flow lists", () => {
    expect(parsePnpmWorkspace("packages:\n  - 'packages/*'\n  - apps/* # apps\n  - \"!**/test/**\"\nonlyBuilt: []\n")).toEqual([
      "packages/*",
      "apps/*",
      "!**/test/**",
    ]);
    expect(parsePnpmWorkspace("packages:\n- packages/*\n- evals\n")).toEqual(["packages/*", "evals"]);
    expect(parsePnpmWorkspace("packages: [packages/*, 'tools/*']\n")).toEqual(["packages/*", "tools/*"]);
  });
});

describe("workspaceGlobs", () => {
  it("reads npm and yarn workspaces fields", () => {
    expect(workspaceGlobs({ workspaces: ["packages/*"] })).toEqual(["packages/*"]);
    expect(workspaceGlobs({ workspaces: { packages: ["libs/*"] } })).toEqual(["libs/*"]);
    expect(workspaceGlobs({ name: "x" })).toEqual([]);
  });
});

describe("globToRegExp", () => {
  it.each([
    ["packages/*", "packages/core", true],
    ["packages/*", "packages/core/sub", false],
    ["packages/**", "packages/core/sub", true],
    ["**/test/**", "packages/a/test/x", true],
    ["./apps/*/", "apps/web", true],
    ["evals", "evals", true],
    ["**/test/**", "packages/skip/test", true],
  ])("%s matches %s: %s", (glob, dir, expected) => {
    expect(globToRegExp(glob).test(dir)).toBe(expected);
  });
});

describe("parseJsonc", () => {
  it("strips comments outside strings and trailing commas", () => {
    expect(parseJsonc('{\n  // note\n  "a": "x//y", /* block */ "b": ["@app/*",],\n}')).toEqual({ a: "x//y", b: ["@app/*"] });
  });
});

describe("buildManifest", () => {
  it("finds packages and apps, names, descriptions and entry points", () => {
    const paths = [
      "package.json",
      "pnpm-workspace.yaml",
      "packages/core/package.json",
      "packages/core/src/index.ts",
      "packages/cli/package.json",
      "packages/cli/bin/run.js",
      "packages/skip/test/package.json",
      "apps/web/src/main.tsx",
      "apps/web/package.json",
      "docs/package.json",
    ];
    const texts = new Map([
      ["package.json", '{"name":"root-pkg","description":"The whole repo."}'],
      ["pnpm-workspace.yaml", "packages:\n  - packages/**\n  - '!**/test/**'\n  - apps/*\n"],
      ["packages/core/package.json", '{"name":"@x/core","description":"Core.","main":"dist/index.js","exports":{".":{"import":"./dist/index.js"}}}'],
      ["packages/cli/package.json", '{"name":"@x/cli","bin":{"run":"bin/run.js"}}'],
      ["packages/skip/test/package.json", '{"name":"fixture"}'],
      ["apps/web/package.json", '{"name":"@x/web"}'],
      ["docs/package.json", '{"name":"docs-site"}'],
    ]);
    expect(buildManifest(paths, texts)).toEqual({
      packageDirs: ["packages/cli", "packages/core"],
      appDirs: ["apps/web"],
      packageNames: { ".": "root-pkg", "packages/cli": "@x/cli", "packages/core": "@x/core", "apps/web": "@x/web" },
      descriptions: { ".": "The whole repo.", "packages/core": "Core." },
      entryPoints: {
        "packages/cli": ["packages/cli/bin/run.js"],
        "packages/core": ["packages/core/src/index.ts"],
        "apps/web": ["apps/web/src/main.tsx"],
      },
    });
  });

  it("returns no packages without workspace globs", () => {
    expect(buildManifest(["package.json", "src/a.ts"], new Map([["package.json", "{}"]])).packageDirs).toEqual([]);
  });
});

describe("tsconfigFromTexts", () => {
  it("reads paths and baseUrl through relative extends, nearest file first", () => {
    const texts = new Map([
      ["tsconfig.json", '{ "extends": "./tsconfig.base", // base\n "compilerOptions": { "paths": { "@app/*": ["src/*"] } } }'],
      ["tsconfig.base.json", '{ "compilerOptions": { "baseUrl": ".", "paths": { "@ignored/*": ["x/*"] } } }'],
    ]);
    expect(tsconfigFromTexts(texts)).toEqual({ paths: { "@app/*": ["src/*"] }, baseUrl: "." });
  });

  it("returns empty paths and a null baseUrl without a root tsconfig.json", () => {
    expect(tsconfigFromTexts(new Map([["tsconfig.base.json", "{}"]]))).toEqual({ paths: {}, baseUrl: null });
  });
});
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/codebase-map exec vitest run src/core/skip.test.ts src/core/manifest.test.ts`

Expected: FAIL. `skip.test.ts`: `isSkippedPath is not a function`; `manifest.test.ts`: `Failed to resolve import "./manifest.js"`.

- [ ] **Step 2: Append the skip and normalize helpers to `paths.ts`**

Append to `packages/codebase-map/src/core/paths.ts`:

```ts

const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", "dist", "build", "out", ".next", "coverage", "vendor", ".git"]);
const GENERATED_FILES: ReadonlySet<string> = new Set([
  "pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "bun.lockb",
  "Cargo.lock", "poetry.lock", "Gemfile.lock", "composer.lock", "go.sum",
]);
const GENERATED_SUFFIX = /\.(min\.js|min\.css|map|snap)$/i;
const BINARY_EXTENSION =
  /\.(png|jpe?g|gif|webp|bmp|ico|icns|tiff?|psd|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|wasm|node|so|dylib|dll|exe|bin|o|a|class|pyc|woff2?|ttf|otf|eot|mp3|mp4|m4a|mov|avi|wav|ogg|webm|flac|sqlite3?|db)$/i;
const SECRET_NAME =
  /^(\.env(\..+)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.pypirc|\.netrc|credentials(\.json)?|.+\.(pem|key|p12|pfx|jks|keystore|asc|gpg))$/i;
const SECRET_TEMPLATE = /^\.env\.(example|sample|template)$/i;

/**
 * Spec §5.1 and §10: dependency and build output directories, lockfiles and minified or
 * generated files, binaries by extension, and secret-like files are never read or mapped.
 */
export function isSkippedPath(path: string): boolean {
  const segments = path.split("/");
  if (segments.slice(0, -1).some((segment) => SKIP_DIRS.has(segment))) return true;
  const base = segments[segments.length - 1] ?? "";
  if (GENERATED_FILES.has(base) || GENERATED_SUFFIX.test(base) || BINARY_EXTENSION.test(base)) return true;
  return SECRET_NAME.test(base) && !SECRET_TEMPLATE.test(base);
}

/** Resolves "." and ".." segments. Returns null for absolute paths and paths that leave the root; "" is the root. */
export function normalizePath(path: string): string | null {
  if (path.startsWith("/")) return null;
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}
```

- [ ] **Step 3: Implement `manifest.ts`**

Create `packages/codebase-map/src/core/manifest.ts`:

```ts
import { compareText, dirnameOf, normalizePath } from "./paths.js";
import type { TsconfigPaths, WorkspaceManifest } from "./types.js";

const MAX_DESCRIPTION = 600;
const MAX_ENTRY_POINTS = 8;
const MAX_EXPORT_DEPTH = 4;
const BUILT_OUTPUT = /^(.*?)\/(?:dist|build|out)\/(.+?)\.(?:c|m)?js$/;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js"];
const PROBE_EXTENSIONS = [".ts", ".tsx", ".js", "/index.ts", "/index.js"];
const APP_ENTRY_CANDIDATES = [
  "src/main.ts", "src/main.tsx", "src/index.ts", "src/index.tsx", "src/main/index.ts", "index.ts", "index.js", "main.ts", "main.js",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unquote(value: string): string {
  return value.trim().replace(/^(['"])(.*)\1$/, "$2");
}

/** JSON with // and /* comments and trailing commas, as tsconfig files allow. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    const next = text.charAt(i + 1);
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next;
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text.charAt(i) !== "\n") i += 1;
      out += "\n";
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** The `packages:` list of pnpm-workspace.yaml (block or flow style). */
export function parsePnpmWorkspace(text: string): string[] {
  const globs: string[] = [];
  let inPackages = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const header = /^packages\s*:\s*(.*)$/.exec(line);
    if (header !== null) {
      const inline = (header[1] ?? "").trim();
      inPackages = inline === "";
      if (inline.startsWith("[")) globs.push(...inline.replace(/^\[|\]$/g, "").split(",").map(unquote));
      continue;
    }
    if (/^\S/.test(line) && !line.startsWith("-")) {
      inPackages = false;
      continue;
    }
    const item = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (inPackages && item !== null) globs.push(unquote(item[1] ?? ""));
  }
  return globs.filter((glob) => glob !== "");
}

/** `workspaces` of a root package.json: an array, or `{ packages: [...] }` (yarn). */
export function workspaceGlobs(rootPackageJson: unknown): string[] {
  if (!isRecord(rootPackageJson)) return [];
  const field = rootPackageJson["workspaces"];
  const list = Array.isArray(field) ? field : isRecord(field) && Array.isArray(field["packages"]) ? field["packages"] : [];
  return list.filter((entry): entry is string => typeof entry === "string" && entry !== "");
}

/** `*` matches one path segment, `**` any number (a trailing `/**` also matches the directory itself), `?` one character. */
export function globToRegExp(glob: string): RegExp {
  const clean = glob.replace(/^\.\//, "").replace(/\/+$/, "");
  let source = "";
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean.charAt(i);
    if (ch === "/" && clean.slice(i) === "/**") {
      source += "(?:/.*)?";
      break;
    }
    if (ch === "*" && clean.charAt(i + 1) === "*") {
      const slash = clean.charAt(i + 2) === "/";
      source += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (ch === "*") {
      source += "[^/]*";
    } else if (ch === "?") {
      source += "[^/]";
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function readJson(texts: ReadonlyMap<string, string>, path: string): unknown {
  const text = texts.get(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function stringLeaves(value: unknown, depth: number, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (depth < MAX_EXPORT_DEPTH && Array.isArray(value)) for (const item of value) stringLeaves(item, depth + 1, out);
  else if (depth < MAX_EXPORT_DEPTH && isRecord(value)) for (const item of Object.values(value)) stringLeaves(item, depth + 1, out);
}

function resolveEntry(dir: string, value: string, files: ReadonlySet<string>): string | null {
  const rel = normalizePath(`${dir}/${value}`);
  if (rel === null || rel === "") return null;
  if (files.has(rel)) return rel;
  const built = BUILT_OUTPUT.exec(rel);
  if (built !== null) {
    for (const extension of SOURCE_EXTENSIONS) {
      const candidate = `${built[1] ?? ""}/src/${built[2] ?? ""}${extension}`;
      if (files.has(candidate)) return candidate;
    }
  }
  for (const extension of PROBE_EXTENSIONS) {
    if (files.has(`${rel}${extension}`)) return `${rel}${extension}`;
  }
  return null;
}

/** Package `main`, `exports` and `bin`, mapped to tracked files; `dist/x.js` maps to `src/x.ts`. */
function entryPointsFor(dir: string, json: unknown, files: ReadonlySet<string>, isApp: boolean): string[] {
  const raw: string[] = [];
  if (isRecord(json)) {
    stringLeaves(json["main"], MAX_EXPORT_DEPTH, raw);
    stringLeaves(json["exports"], 0, raw);
    stringLeaves(json["bin"], MAX_EXPORT_DEPTH - 1, raw);
  }
  const out: string[] = [];
  for (const value of raw) {
    const resolved = resolveEntry(dir, value, files);
    if (resolved !== null && !out.includes(resolved)) out.push(resolved);
    if (out.length >= MAX_ENTRY_POINTS) break;
  }
  if (out.length === 0 && isApp) {
    const candidate = APP_ENTRY_CANDIDATES.map((entry) => `${dir}/${entry}`).find((entry) => files.has(entry));
    if (candidate !== undefined) out.push(candidate);
  }
  return out;
}

/**
 * Spec §5.2 rule 1. `paths` are the scanned files; `texts` holds the contents of every
 * package.json and of pnpm-workspace.yaml. Workspace packages are directories with a
 * package.json that matches a workspace glob; app directories are `apps/*` with any file.
 */
export function buildManifest(paths: readonly string[], texts: ReadonlyMap<string, string>): WorkspaceManifest {
  const files = new Set(paths);
  const workspaceText = texts.get("pnpm-workspace.yaml");
  const globs = [
    ...(workspaceText === undefined ? [] : parsePnpmWorkspace(workspaceText)),
    ...workspaceGlobs(readJson(texts, "package.json")),
  ];
  const include = globs.filter((glob) => !glob.startsWith("!")).map(globToRegExp);
  const exclude = globs.filter((glob) => glob.startsWith("!")).map((glob) => globToRegExp(glob.slice(1)));
  const appDirs = [
    ...new Set(paths.filter((path) => path.startsWith("apps/") && path.split("/").length >= 3).map((path) => path.split("/").slice(0, 2).join("/"))),
  ].sort(compareText);
  const apps = new Set(appDirs);
  const packageDirs = [
    ...new Set(paths.filter((path) => path.endsWith("/package.json")).map((path) => dirnameOf(path))),
  ]
    .filter((dir) => !apps.has(dir) && include.some((glob) => glob.test(dir)) && !exclude.some((glob) => glob.test(dir)))
    .sort(compareText);

  const packageNames: Record<string, string> = {};
  const descriptions: Record<string, string> = {};
  const entryPoints: Record<string, string[]> = {};
  for (const dir of [".", ...packageDirs, ...appDirs]) {
    const json = readJson(texts, dir === "." ? "package.json" : `${dir}/package.json`);
    if (isRecord(json)) {
      const name = json["name"];
      const description = json["description"];
      if (typeof name === "string" && name.trim() !== "") packageNames[dir] = name.trim();
      if (typeof description === "string" && description.trim() !== "") descriptions[dir] = description.trim().slice(0, MAX_DESCRIPTION);
    }
    if (dir === ".") continue;
    const entries = entryPointsFor(dir, json, files, apps.has(dir));
    if (entries.length > 0) entryPoints[dir] = entries;
  }
  return { packageDirs, appDirs, packageNames, descriptions, entryPoints };
}

/**
 * Root tsconfig `paths` and `baseUrl`, following relative `extends` between root-level files.
 * The nearer file wins. Targets stay relative to `baseUrl` (or the repo root when it is unset).
 */
export function tsconfigFromTexts(texts: ReadonlyMap<string, string>): TsconfigPaths {
  let paths: Record<string, string[]> | null = null;
  let baseUrl: string | null | undefined;
  const seen = new Set<string>();
  let file: string | null = "tsconfig.json";
  while (file !== null && !seen.has(file) && seen.size < 5) {
    seen.add(file);
    const text = texts.get(file);
    if (text === undefined) break;
    let json: unknown;
    try {
      json = parseJsonc(text);
    } catch {
      break;
    }
    if (!isRecord(json)) break;
    const options = isRecord(json["compilerOptions"]) ? json["compilerOptions"] : {};
    const dir = dirnameOf(file);
    const base = options["baseUrl"];
    if (baseUrl === undefined && typeof base === "string") {
      const resolved = normalizePath(dir === "" ? base : `${dir}/${base}`);
      baseUrl = resolved === null ? null : resolved === "" ? "." : resolved;
    }
    const mapping = options["paths"];
    if (paths === null && isRecord(mapping)) {
      paths = {};
      for (const [pattern, targets] of Object.entries(mapping)) {
        if (Array.isArray(targets)) paths[pattern] = targets.filter((target): target is string => typeof target === "string");
      }
    }
    const parent = json["extends"];
    if (typeof parent === "string" && parent.startsWith(".")) {
      const target = parent.endsWith(".json") ? parent : `${parent}.json`;
      file = normalizePath(dir === "" ? target : `${dir}/${target}`);
    } else {
      file = null;
    }
  }
  return { paths: paths ?? {}, baseUrl: baseUrl ?? null };
}
```

Append to `packages/codebase-map/src/core/index.ts`:

```ts
export * from "./manifest.js";
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/codebase-map exec vitest run src/core/skip.test.ts src/core/manifest.test.ts`

Expected: PASS, `Tests  42 passed (42)` (28 skip and normalize, 14 manifest).

- [ ] **Step 4: Write the fixture repos and the failing scan tests**

Create `packages/codebase-map/src/node/test-support/fixture-repos.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface FixtureRepo {
  root: string;
  cleanup(): void;
}

export type FixtureFiles = Record<string, string | Uint8Array>;

/** Writes the files into a fresh `git init` directory. Nothing is committed: the scan lists untracked files too. */
export function makeRepo(files: FixtureFiles, options: { symlinks?: Record<string, string> } = {}): FixtureRepo {
  const root = mkdtempSync(path.join(os.tmpdir(), "jevcode-map-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  for (const [rel, target] of Object.entries(options.symlinks ?? {})) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    symlinkSync(target, path.join(root, rel));
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A pnpm workspace with every skip case of spec §5.1 and §10 beside the real sources. */
export const PNPM_WORKSPACE_REPO: FixtureFiles = {
  ".gitignore": "node_modules/\n*.log\n",
  "package.json": '{"name":"fixture-root","private":true}',
  "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n  - apps/*\n",
  "tsconfig.json": '{\n  // root paths\n  "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["apps/web/src/*"] } }\n}\n',
  "packages/core/package.json": '{"name":"@fx/core","description":"Domain model.","main":"dist/index.js"}',
  "packages/core/src/index.ts": 'export * from "./user.js";\n',
  "packages/core/src/user.ts": "export interface User { id: string }\nexport function makeUser(id: string): User { return { id }; }\n",
  "packages/core/src/user.test.ts": 'import { makeUser } from "./user.js";\nmakeUser("a");\n',
  "packages/db/package.json": '{"name":"@fx/db","main":"dist/index.js"}',
  "packages/db/src/index.ts":
    'import Database from "better-sqlite3";\nimport type { User } from "@fx/core";\nexport function open(): Database.Database { return new Database(":memory:"); }\nexport type Row = User;\n',
  "apps/web/package.json": '{"name":"@fx/web","main":"src/main.tsx"}',
  "apps/web/src/main.tsx": 'import { createRoot } from "react-dom/client";\nimport { App } from "./App.js";\ncreateRoot(document.body).render(<App />);\n',
  "apps/web/src/App.tsx":
    'import { useState } from "react";\nimport { makeUser } from "@fx/core";\nimport { loadUsers } from "@app/api.js";\nexport function App() { const [u] = useState(makeUser("a")); void loadUsers; return <p>{u.id}</p>; }\n',
  "apps/web/src/api.ts": 'import { open } from "@fx/db";\nexport async function loadUsers() { return open(); }\n',
  "scripts/release.mjs": 'import { execSync } from "node:child_process";\nexecSync("echo release");\n',
  "docs/guide.md": "# Guide\n",
  // Skipped: dependency and build output, ignored, binary, oversized, LFS, generated, secrets.
  "node_modules/left-pad/index.js": "module.exports = 1;\n",
  "dist/bundle.js": "console.log(1);\n",
  "build.log": "ignored by .gitignore\n",
  "assets/logo.png": Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]),
  "data/raw.dat": Uint8Array.from([0x61, 0x00, 0x62]),
  "data/huge.json": `"${"x".repeat(1024 * 1024)}"`,
  "data/large.csv": "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 123\n",
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "apps/web/src/vendor.min.js": "var a=1;\n",
  ".env": "TOKEN=secret\n",
  ".env.example": "TOKEN=\n",
  "certs/server.pem": "-----BEGIN PRIVATE KEY-----\n",
};

/** The kept files of PNPM_WORKSPACE_REPO, in scan order. */
export const PNPM_WORKSPACE_KEPT = [
  ".env.example",
  ".gitignore",
  "apps/web/package.json",
  "apps/web/src/App.tsx",
  "apps/web/src/api.ts",
  "apps/web/src/main.tsx",
  "docs/guide.md",
  "package.json",
  "packages/core/package.json",
  "packages/core/src/index.ts",
  "packages/core/src/user.test.ts",
  "packages/core/src/user.ts",
  "packages/db/package.json",
  "packages/db/src/index.ts",
  "pnpm-workspace.yaml",
  "scripts/release.mjs",
  "tsconfig.json",
];

/** No src/, lib/ or packages/ and no TS, JS or JSON: imports are not analyzed (spec E14). */
export const PYTHON_REPO: FixtureFiles = {
  "pyproject.toml": '[project]\nname = "svc"\n',
  "README.md": "# svc\n",
  "app/__init__.py": "",
  "app/server.py": "from app.models.user import User\n",
  "app/models/user.py": "class User: pass\n",
  "tests/test_server.py": "import app.server\n",
  "scripts/seed.py": "print('seed')\n",
};

/** `modules` directories of `filesPerModule` small TS files under src/. Names sort in creation order. */
export function generatedRepoFiles(modules: number, filesPerModule: number): FixtureFiles {
  const files: FixtureFiles = {};
  for (let m = 0; m < modules; m += 1) {
    const dir = `src/mod-${String(m).padStart(3, "0")}`;
    for (let f = 0; f < filesPerModule; f += 1) {
      files[`${dir}/file-${String(f).padStart(3, "0")}.ts`] = `export const v${m}_${f} = ${f};\n`;
    }
  }
  return files;
}
```

Create `packages/codebase-map/src/node/scan.test.ts`. The two Review Focus 1 cases are the Python repo and the 25,200-file repo: 300 modules × 84 files sort as `src/mod-000/file-000.ts` … `src/mod-299/file-083.ts`, so the first 20,000 files are modules 000–237 in full plus 8 files of module 238, which is 239 components; the 40 smallest (modules 199–238, 39 × 84 + 8 = 3,284 files) group into "other".

```ts
import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { OVERVIEW_SNAPSHOT_MAX_BYTES, OverviewSnapshotSchema } from "@jevcode/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { componentize } from "../core/componentize.js";
import { utf8ByteLength } from "../core/sha1.js";
import { assembleSnapshot } from "../core/snapshot.js";
import type { ScannedFile } from "../core/types.js";
import { scanPaths, scanRepo } from "./scan.js";
import {
  PNPM_WORKSPACE_KEPT,
  PNPM_WORKSPACE_REPO,
  PYTHON_REPO,
  generatedRepoFiles,
  makeRepo,
  type FixtureRepo,
} from "./test-support/fixture-repos.js";

const repos: FixtureRepo[] = [];
function repo(...args: Parameters<typeof makeRepo>): FixtureRepo {
  const made = makeRepo(...args);
  repos.push(made);
  return made;
}
afterEach(() => {
  while (repos.length > 0) repos.pop()?.cleanup();
});

const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");

function snapshotOf(root: string, scan: Awaited<ReturnType<typeof scanRepo>>) {
  return assembleSnapshot({
    sessionId: "sess_scan",
    repoRoot: root,
    scanId: "scan_test",
    partial: scan.partial,
    drafts: componentize(scan.files, scan.manifest),
    totalFiles: scan.totalFiles,
    edges: [],
    externals: [],
    text: new Map(),
    narrative: null,
    generatedAt: "2026-10-02T00:00:00.000Z",
  });
}

describe("scanRepo (spec §5.1, §10)", () => {
  it("lists tracked and untracked files, skips ignored, generated, binary, LFS, oversized and secret files", async () => {
    const fixture = repo(PNPM_WORKSPACE_REPO, { symlinks: { "linked/outside.ts": "/etc/hosts" } });
    const scan = await scanRepo(fixture.root);
    expect(scan.files.map((f) => f.path)).toEqual(PNPM_WORKSPACE_KEPT);
    expect(scan.partial).toBe(false);
    expect(scan.totalFiles).toBe(PNPM_WORKSPACE_KEPT.length);
    const user = scan.files.find((f) => f.path === "packages/core/src/user.ts");
    expect(user).toEqual({
      path: "packages/core/src/user.ts",
      hash: sha1(PNPM_WORKSPACE_REPO["packages/core/src/user.ts"] as string),
      size: (PNPM_WORKSPACE_REPO["packages/core/src/user.ts"] as string).length,
      language: "TypeScript",
    });
  });

  it("reads the workspace manifest and root tsconfig paths", async () => {
    const scan = await scanRepo(repo(PNPM_WORKSPACE_REPO).root);
    expect(scan.manifest).toEqual({
      packageDirs: ["packages/core", "packages/db"],
      appDirs: ["apps/web"],
      packageNames: { ".": "fixture-root", "packages/core": "@fx/core", "packages/db": "@fx/db", "apps/web": "@fx/web" },
      descriptions: { "packages/core": "Domain model." },
      entryPoints: {
        "packages/core": ["packages/core/src/index.ts"],
        "packages/db": ["packages/db/src/index.ts"],
        "apps/web": ["apps/web/src/main.tsx"],
      },
    });
    expect(scan.tsconfig).toEqual({ paths: { "@app/*": ["apps/web/src/*"] }, baseUrl: "." });
    expect(componentize(scan.files, scan.manifest).map((d) => [d.rootPath, d.name])).toEqual([
      [".", "config"],
      ["apps/web", "@fx/web"],
      ["docs", "docs"],
      ["packages/core", "@fx/core"],
      ["packages/db", "@fx/db"],
      ["scripts", "scripts"],
    ]);
  });

  it("hands every kept file's text to visit and reports progress up to the total", async () => {
    const seen: string[] = [];
    const progress: [number, number][] = [];
    const scan = await scanRepo(repo(PNPM_WORKSPACE_REPO).root, {
      visit: (file, source) => {
        seen.push(file.path);
        expect(sha1(source)).toBe(file.hash);
      },
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(seen.sort()).toEqual(scan.files.map((f) => f.path).sort());
    expect(progress[0]?.[0]).toBe(0);
    const last = progress[progress.length - 1];
    expect(last?.[0]).toBe(last?.[1]);
  });

  it("stops with an AbortError when the signal aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(scanRepo(repo(PNPM_WORKSPACE_REPO).root, { signal: controller.signal })).rejects.toThrow(/abort/i);
  });

  it("maps a Python repo to components with imports not analyzed (Review Focus 1)", async () => {
    const fixture = repo(PYTHON_REPO);
    const scan = await scanRepo(fixture.root);
    const snapshot = snapshotOf(fixture.root, scan);
    expect(OverviewSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.components.map((c) => [c.rootPath, c.language, c.roleGuess, c.importsAnalyzed])).toEqual([
      [".", "Markdown", "config", false],
      ["app", "Python", "domain", false],
      ["scripts", "Python", "tooling", false],
      ["tests", "Python", "tests", false],
    ]);
    expect(snapshot.edges).toEqual([]);
    expect(snapshot.partial).toBe(false);
    expect(snapshot.counts).toMatchObject({ files: 7, components: 4, edges: 0 });
  });

  it(
    "flags a 25,200-file repo as partial and maps exactly 20,000 files into 200 components (Review Focus 1)",
    async () => {
      const fixture = repo(generatedRepoFiles(300, 84));
      const scan = await scanRepo(fixture.root);
      expect(scan.partial).toBe(true);
      expect(scan.files).toHaveLength(20_000);
      expect(scan.totalFiles).toBe(25_200);
      expect(scan.files[scan.files.length - 1]?.path).toBe("src/mod-238/file-007.ts");
      const snapshot = snapshotOf(fixture.root, scan);
      expect(OverviewSnapshotSchema.safeParse(snapshot).success).toBe(true);
      expect(snapshot.partial).toBe(true);
      expect(snapshot.counts).toMatchObject({ files: 20_000, components: 239, totalFiles: 25_200 });
      expect(snapshot.components).toHaveLength(200);
      expect(snapshot.components.find((c) => c.name === "other")?.fileCount).toBe(40 * 84 - 76);
      expect(utf8ByteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(OVERVIEW_SNAPSHOT_MAX_BYTES);
    },
    120_000,
  );
});

describe("scanPaths (spec §5.1 incremental updates)", () => {
  it("re-reads changed files and reports deleted, ignored, skipped and escaping paths as gone", async () => {
    const fixture = repo(PNPM_WORKSPACE_REPO);
    writeFileSync(path.join(fixture.root, "packages/core/src/user.ts"), "export const changed = 1;\n");
    writeFileSync(path.join(fixture.root, "packages/core/src/new.ts"), "export const added = 1;\n");
    rmSync(path.join(fixture.root, "docs/guide.md"));
    const visited: string[] = [];
    const result = await scanPaths(
      fixture.root,
      [
        "packages/core/src/user.ts",
        "./packages/core/src/new.ts",
        "docs/guide.md",
        "build.log",
        ".env",
        "../outside.ts",
        "/etc/hosts",
      ],
      { visit: (file) => void visited.push(file.path) },
    );
    expect(result.files.map((f: ScannedFile) => [f.path, f.hash])).toEqual([
      ["packages/core/src/new.ts", sha1("export const added = 1;\n")],
      ["packages/core/src/user.ts", sha1("export const changed = 1;\n")],
    ]);
    expect(result.gone).toEqual([".env", "build.log", "docs/guide.md"]);
    expect(visited.sort()).toEqual(["packages/core/src/new.ts", "packages/core/src/user.ts"]);
  });
});
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/codebase-map exec vitest run src/node/scan.test.ts`

Expected: FAIL with `Failed to resolve import "./scan.js"`.

- [ ] **Step 5: Implement `scan.ts`**

Create `packages/codebase-map/src/node/scan.ts`:

```ts
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { buildManifest, tsconfigFromTexts } from "../core/manifest.js";
import { compareText, isSkippedPath, languageOf, normalizePath } from "../core/paths.js";
import type { ScannedFile, TsconfigPaths, WorkspaceManifest } from "../core/types.js";

const execFileAsync = promisify(execFile);

/** Spec §5.1: hard cap on mapped files; past it the map is partial. */
export const MAX_SCAN_FILES = 20_000;
/** Spec §5.1: larger files are skipped. */
export const MAX_FILE_BYTES = 1024 * 1024;
const READ_CONCURRENCY = 32;
const PROGRESS_EVERY = 200;
const SNIFF_BYTES = 8_000;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const PATHSPEC_CHUNK = 500;
const LFS_POINTER_HEADER = "version https://git-lfs.github.com/spec/v1";

export interface ScanOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  signal?: AbortSignal;
  onProgress?(done: number, total: number): void;
  /** Called once per kept file with its UTF-8 text; the scan awaits it inside its read pool. */
  visit?(file: ScannedFile, source: string): Promise<void> | void;
}

export interface ScanResult {
  files: ScannedFile[];
  manifest: WorkspaceManifest;
  partial: boolean;
  tsconfig: TsconfigPaths;
  /** Ruling R3: repo files that pass the path skips, before the cap; `files.length` when not partial. */
  totalFiles: number;
}

export interface ScanPathsResult {
  /** Changed files that exist and pass every skip rule, sorted. */
  files: ScannedFile[];
  /** Normalized paths that are deleted, ignored, skipped or unreadable, sorted. */
  gone: string[];
}

interface ReadResult {
  file: ScannedFile;
  buffer: Buffer;
}

function isManifestText(rel: string): boolean {
  return rel === "pnpm-workspace.yaml" || rel === "package.json" || rel.endsWith("/package.json") || /^tsconfig[^/]*\.json$/.test(rel);
}

export function looksBinary(buffer: Uint8Array): boolean {
  const end = Math.min(buffer.length, SNIFF_BYTES);
  for (let i = 0; i < end; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

export function isLfsPointer(buffer: Buffer): boolean {
  return buffer.length < 1024 && buffer.subarray(0, LFS_POINTER_HEADER.length).toString("utf8") === LFS_POINTER_HEADER;
}

async function readCandidate(repoRoot: string, rel: string, maxBytes: number): Promise<ReadResult | null> {
  const abs = path.join(repoRoot, rel);
  try {
    // lstat: a symlink is never followed, so a link out of the repo is never read.
    const info = await lstat(abs);
    if (!info.isFile() || info.size > maxBytes) return null;
    const buffer = await readFile(abs);
    if (buffer.length > maxBytes || looksBinary(buffer) || isLfsPointer(buffer)) return null;
    return {
      file: { path: rel, hash: createHash("sha1").update(buffer).digest("hex"), size: buffer.length, language: languageOf(rel) },
      buffer,
    };
  } catch {
    return null;
  }
}

async function gitListFiles(repoRoot: string, pathspecs: readonly string[], signal?: AbortSignal): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", repoRoot, "ls-files", "-z", "--cached", "--others", "--exclude-standard", ...(pathspecs.length > 0 ? ["--", ...pathspecs] : [])],
    { maxBuffer: GIT_MAX_BUFFER, signal, encoding: "utf8" },
  );
  return stdout.split("\0").filter((entry) => entry !== "");
}

/** Tracked files plus untracked files that .gitignore does not exclude, sorted and unique. */
export async function listRepoFiles(repoRoot: string, signal?: AbortSignal): Promise<string[]> {
  return [...new Set(await gitListFiles(repoRoot, [], signal))].sort(compareText);
}

async function readAll(
  repoRoot: string,
  rels: readonly string[],
  options: Pick<ScanOptions, "maxFileBytes" | "signal" | "onProgress">,
  onFile: (result: ReadResult | null, rel: string) => Promise<void>,
): Promise<void> {
  const maxBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      options.signal?.throwIfAborted();
      const index = next;
      next += 1;
      if (index >= rels.length) return;
      const rel = rels[index] as string;
      await onFile(await readCandidate(repoRoot, rel, maxBytes), rel);
      done += 1;
      if (done % PROGRESS_EVERY === 0 || done === rels.length) options.onProgress?.(done, rels.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(READ_CONCURRENCY, rels.length)) }, worker));
}

/** Spec §5.1: git ls-files, skips, the 20,000-file cap, workspace manifest and root tsconfig paths. */
export async function scanRepo(repoRoot: string, options: ScanOptions = {}): Promise<ScanResult> {
  const maxFiles = options.maxFiles ?? MAX_SCAN_FILES;
  const candidates = (await listRepoFiles(repoRoot, options.signal)).filter((rel) => !isSkippedPath(rel));
  const partial = candidates.length > maxFiles;
  const selected = partial ? candidates.slice(0, maxFiles) : candidates;
  const files: ScannedFile[] = [];
  const texts = new Map<string, string>();
  options.onProgress?.(0, selected.length);
  await readAll(repoRoot, selected, options, async (result) => {
    if (result === null) return;
    files.push(result.file);
    const manifestText = isManifestText(result.file.path);
    if (!manifestText && options.visit === undefined) return;
    const source = result.buffer.toString("utf8");
    if (manifestText) texts.set(result.file.path, source);
    await options.visit?.(result.file, source);
  });
  options.signal?.throwIfAborted();
  files.sort((a, b) => compareText(a.path, b.path));
  return {
    files,
    manifest: buildManifest(files.map((file) => file.path), texts),
    partial,
    tsconfig: tsconfigFromTexts(texts),
    totalFiles: partial ? candidates.length : files.length,
  };
}

/**
 * Re-reads changed paths after the first scan (spec §5.1 incremental updates). Paths that
 * leave the repo root are dropped; deleted, gitignored, skipped or unreadable paths are `gone`.
 */
export async function scanPaths(
  repoRoot: string,
  paths: readonly string[],
  options: Pick<ScanOptions, "maxFileBytes" | "signal" | "visit"> = {},
): Promise<ScanPathsResult> {
  const rels = [
    ...new Set(paths.map((entry) => normalizePath(entry.replaceAll("\\", "/"))).filter((entry): entry is string => entry !== null && entry !== "")),
  ].sort(compareText);
  const gone: string[] = [];
  const eligible = rels.filter((rel) => {
    if (!isSkippedPath(rel)) return true;
    gone.push(rel);
    return false;
  });
  const listed = new Set<string>();
  for (let i = 0; i < eligible.length; i += PATHSPEC_CHUNK) {
    const chunk = eligible.slice(i, i + PATHSPEC_CHUNK).map((rel) => `:(literal)${rel}`);
    for (const rel of await gitListFiles(repoRoot, chunk, options.signal)) listed.add(rel);
  }
  const files: ScannedFile[] = [];
  const readable = eligible.filter((rel) => {
    if (listed.has(rel)) return true;
    gone.push(rel);
    return false;
  });
  await readAll(repoRoot, readable, options, async (result, rel) => {
    if (result === null) {
      gone.push(rel);
      return;
    }
    files.push(result.file);
    await options.visit?.(result.file, result.buffer.toString("utf8"));
  });
  files.sort((a, b) => compareText(a.path, b.path));
  return { files, gone: gone.sort(compareText) };
}
```

Create `packages/codebase-map/src/node/index.ts`:

```ts
export * from "./scan.js";
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/codebase-map exec vitest run src/node/scan.test.ts`

Expected: PASS, `Tests  7 passed (7)`. The 25,200-file case takes 5–10 s (it writes the files, then scans).

- [ ] **Step 6: Checks**

Run, in order:

```bash
perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/codebase-map typecheck
perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/codebase-map build
perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/codebase-map test
perl -e 'alarm 170; exec @ARGV' pnpm lint
```

Expected: exit 0; `dist/node/index.js` exists and `dist/node/test-support` does not; `Test Files  12 passed (12)`; lint prints nothing (the core purity block does not cover `src/node`).

- [ ] **Step 7: Commit**

```bash
git add packages/codebase-map/src/core/paths.ts packages/codebase-map/src/core/skip.test.ts \
  packages/codebase-map/src/core/manifest.ts packages/codebase-map/src/core/manifest.test.ts \
  packages/codebase-map/src/core/index.ts packages/codebase-map/src/node
git -c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com commit -m "feat(codebase-map): scan repos with skips, caps, workspace manifests and tsconfig paths"
```


### Task M-6: Explainer stage: scan scheduling, snapshot rows, `overview_state`, push, rescan, progress, failure

**Files:**
- Modify: `apps/desktop/package.json` (dependency `@jevcode/codebase-map`), `pnpm-lock.yaml`
- Create: `apps/desktop/src/main/pipeline/explainer-overview.ts`, `apps/desktop/src/main/pipeline/explainer-stage.ts`
- Modify: `apps/desktop/src/main/pipeline/types.ts` (`PipelineRuntimeOptions.onRepoFilesChanged`)
- Modify: `apps/desktop/src/main/pipeline/pipeline-runtime.ts` (forward `file_changed` facts)
- Modify: `apps/desktop/src/main/ipc.ts` (`IpcDeps.explainer`; repo open/close, session start, `overview:rescan`)
- Modify: `apps/desktop/src/main/index.ts` (registry, extractor, hook, quit)
- Test: `apps/desktop/src/main/pipeline/explainer-overview.test.ts`, `apps/desktop/src/main/pipeline/explainer-stage.test.ts`; append to `apps/desktop/src/main/pipeline/pipeline-runtime.test.ts` and `apps/desktop/src/main/ipc.test.ts`

**Interfaces:**
- Consumes: M-1..M-3 and M-5 from `@jevcode/codebase-map` and `@jevcode/codebase-map/node`; M-4 `extractImports`, `createImportExtractor`, `resolveSpecifier`, `languageForPath`, `ExtractedImports`, `ResolveContext`; K-2 `OverviewSnapshot`, `OverviewSnapshotSchema`, `canonicalJson` (existing); K-4 `JevcodeDb.appendEvent(sessionId, "overview_snapshot", payload): StoredEvent`, `getOverviewState(repoRoot)`, `putOverviewState(repoRoot, state)`; K-3 `MainToRendererChannels.traceRowsAvailable` (`{ sessionId, lastSeq }`) and `RendererToMainChannels.overviewRescan` (`{ repoRoot }`); lane 03 D-1 is consumed only through the injected `emitRowsAvailable(sessionId, lastSeq)` dep (no lane-03 import).
- Consumes (K-3): `EXPLAIN_WITH_MODEL_PREF_KEY` and `normalizeExplainWithModel(value: unknown): boolean` from `apps/desktop/src/shared/prefs.ts`; K-2 (ruling R3): `OverviewStatus`, `OverviewSnapshot.status?`, `counts.totalFiles?`.
- Produces (interfaces §5, with deviations 1–5, 12, 13 and rulings R3, R4):
  - `createExplainerStage(deps: ExplainerStageDeps): ExplainerStage`; `ExplainerStage { onRepoOpened(); onSessionStarted(sessionId); onFilesChanged(paths); onPipelineSync(sync); rescan(); status(): ExplainerStatus; whenIdle(): Promise<void>; dispose() }`
  - `ExplainerStageDeps { db: JevcodeDb; repoRoot; sessionId(): string | null; scan: typeof scanRepo; scanPaths: typeof scanPaths; extract: typeof extractImports; emitRowsAvailable(sessionId, lastSeq); now(); schedule; log(event: ExplainerLogEvent); narration?: (ctx: NarrationContext) => NarrationSeam; explainWithModel?(): boolean; onStatus?(status: ExplainerStatus) }`
  - `ExplainerLogEvent` (interfaces §5 plus `{ kind: "error"; where; message }`), `ExplainerStatus { phase: "idle" | "scanning" | "ready" | "failed"; done; total; error }`
  - `SCAN_PROGRESS_AFTER_MS = 2_000`, `SCAN_ERROR_MAX = 200`; `NarratorState` is imported from `@jevcode/contracts` (K-2), not declared here
  - The narration seam (ruling R4, canonical): `NarrationSeam { textFor(view): ReadonlyMap<string, ComponentText>; narrative(snapshot, view): OverviewSnapshot["narrative"]; onSnapshot(snapshot, view): void; setNarrator?(narrator: unknown): void; narratorStatus?(): NarratorState; dispose(): void }`. `setNarrator?` takes lane 05's `NarratorClient | null` (method parameters are bivariant, so lane 05's narrower signature is assignable); lane 04 never calls it, and `ExplainerStage.setNarrator` is lane 05's (N-5), `NarrationContext { repoRoot; db; now(); schedule; log(event); refresh() }`, `OverviewView { repoRoot; drafts; roleGuess; edges; externals; manifest; exportsOf(componentId) }`, `NO_NARRATION`, `snapshotKey(snapshot)`
  - `createExplainerRegistry(factory): ExplainerRegistry` (`repoOpened`, `repoClosed`, `sessionStarted`, `filesChanged`, `rescan`, `get`, `dispose`)
  - `explainer-overview.ts`: `RepoModel`, `BuiltOverview`, `scanRepoModel`, `applyFileChanges`, `buildOverview`, `workspacePackagesOf`, `MAX_EXPORTS_PER_COMPONENT = 15`
  - `PipelineRuntimeOptions.onRepoFilesChanged?(repoPath: string, paths: readonly string[]): void`; `IpcDeps.explainer?: ExplainerRegistry`

**Schedule (spec §5.5, §6.1, §6.6) pinned by the stage tests:**
- Repo open: the stored `overview_state` snapshot is written to the current session at once (first row for that session), then a background scan starts unless one is running.
- Session start: writes the current snapshot for that session unless that session already holds the same content; scans only when no scan has completed or is running.
- File changes: paths queue; 500 ms after the last change the changed files are re-read and re-parsed (`scanPaths`), the overview is rebuilt, and a changed snapshot is written. Changes during a scan apply after it. A manifest edit reruns the full scan.
- Rows: at most one per session per 2 s; a pending write carries the latest snapshot; content is compared by `snapshotKey` (everything except `sessionId`, `scanId`, `generatedAt`; `status` is included). Every row is followed by `emitRowsAvailable(sessionId, row.seq)`, and every changed full snapshot updates `overview_state` (keeping lane 05's `narrativeInputsHash`, and the stored narrative when the new snapshot has none). Progress and failure rows never reach `overview_state`.
- Status (ruling R3): every row carries `status`. A full snapshot has `scan: { state: "done", scanned: <mapped files>, total: <totalFiles> }`. Once a scan has run for 2 s, each progress callback becomes a progress snapshot: the previous full snapshot's components (or none, before the first scan) with `scan: { state: "running", scanned, total }`; the 2 s writer passes at most one per 2 s. A failed scan writes the previous components (or none) with `scan: { state: "failed", scanned, total, error }`, the error clipped to 200 characters (lane 06 renders it through `displayUntrusted`). `status.narrator` is "off" when `explainWithModel()` returns false, else the seam's `narratorStatus?()`, else "unavailable" (`NO_NARRATION`). All rows go through one writer (`writeNow`).
- Failure: a scan, rebuild, state or write error is logged as `{ kind: "error" }`, never thrown; a failed scan sets `status().phase = "failed"` with the message and writes the failed status row; `rescan()` aborts any running scan and starts a new one; `dispose()` aborts and drops late results.

- [ ] **Step 1: Add the workspace dependency and rebuild the inputs**

In `apps/desktop/package.json`, find:

```json
    "@jevcode/agent-core": "workspace:^",
    "@jevcode/contracts": "workspace:*",
```

Replace it with:

```json
    "@jevcode/agent-core": "workspace:^",
    "@jevcode/codebase-map": "workspace:^",
    "@jevcode/contracts": "workspace:*",
```

Run:

```bash
pnpm install
perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/codebase-map build && perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/evidence-engine build
```

Expected: exit 0; the lockfile adds the link under the `apps/desktop` importer only.

- [ ] **Step 2: Write the failing overview tests**

Create `apps/desktop/src/main/pipeline/explainer-overview.test.ts`. The fixture's expected edges follow from its sources: `App.tsx` imports `@fx/core` (workspace name → `packages/core/src/index.ts`), `api.ts` imports `@fx/db`, `packages/db` imports `@fx/core`; `main.tsx → App.tsx`, `App.tsx → @app/api.js` (tsconfig paths) and `index.ts → user.js` stay inside one component and are dropped; `node:child_process` is a built-in. The second test is the index §9 "this repo's snapshot matches its expected component table" check; it lists rows whose names and roles follow from spec §5.4 and do not depend on other lanes' file counts.

```ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OverviewSnapshotSchema, type OverviewSnapshot } from "@jevcode/contracts";
import { assembleSnapshot, componentIdFor } from "@jevcode/codebase-map";
import { scanRepo } from "@jevcode/codebase-map/node";
import { extractImports } from "@jevcode/evidence-engine";
import { afterEach, describe, expect, it } from "vitest";

import { buildOverview, scanRepoModel, workspacePackagesOf } from "./explainer-overview.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../");

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function gitRepo(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "jevcode-overview-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

const WORKSPACE: Record<string, string> = {
  "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
  "package.json": '{"name":"fx-root","private":true}',
  "tsconfig.json": '{"compilerOptions":{"baseUrl":".","paths":{"@app/*":["apps/web/src/*"]}}}',
  "packages/core/package.json": '{"name":"@fx/core","main":"dist/index.js"}',
  "packages/core/src/index.ts": 'export * from "./user.js";\n',
  "packages/core/src/user.ts": "export interface User { id: string }\nexport function makeUser(id: string): User { return { id }; }\n",
  "packages/db/package.json": '{"name":"@fx/db","main":"dist/index.js"}',
  "packages/db/src/index.ts":
    'import Database from "better-sqlite3";\nimport type { User } from "@fx/core";\nexport function open(): Database.Database { return new Database(":memory:"); }\nexport type Row = User;\n',
  "apps/web/package.json": '{"name":"@fx/web","main":"src/main.tsx"}',
  "apps/web/src/main.tsx": 'import { createRoot } from "react-dom/client";\nimport { App } from "./App.js";\ncreateRoot(document.body).render(<App />);\n',
  "apps/web/src/App.tsx":
    'import { useState } from "react";\nimport { makeUser } from "@fx/core";\nimport { loadUsers } from "@app/api.js";\nexport function App() { const [u] = useState(makeUser("a")); void loadUsers; return <p>{u.id}</p>; }\n',
  "apps/web/src/api.ts": 'import { open } from "@fx/db";\nexport async function loadUsers() { return open(); }\n',
  "scripts/release.mjs": 'import { execSync } from "node:child_process";\nexecSync("echo release");\n',
};

function snapshotOf(repoRoot: string, built: ReturnType<typeof buildOverview>, partial: boolean): OverviewSnapshot {
  return assembleSnapshot({
    sessionId: "sess_overview",
    repoRoot,
    scanId: "scan_overview",
    partial,
    drafts: built.drafts,
    edges: built.edges,
    externals: built.externals,
    text: new Map(),
    narrative: null,
    generatedAt: "2026-10-02T00:00:00.000Z",
  });
}

describe("buildOverview on a pnpm workspace fixture (spec §5, §12)", () => {
  it("maps components, roles, import edges, externals and exported names", async () => {
    const root = gitRepo(WORKSPACE);
    const model = await scanRepoModel(root, { scan: scanRepo, extract: extractImports });
    expect(workspacePackagesOf(model.manifest)).toEqual({ "@fx/core": "packages/core", "@fx/db": "packages/db", "@fx/web": "apps/web" });
    const built = buildOverview(model);
    const snapshot = snapshotOf(root, built, model.partial);
    expect(OverviewSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.components.map((c) => [c.rootPath, c.name, c.roleGuess, c.importsAnalyzed])).toEqual([
      [".", "config", "config", true],
      ["apps/web", "@fx/web", "ui", true],
      ["packages/core", "@fx/core", "domain", true],
      ["packages/db", "@fx/db", "storage", true],
      ["scripts", "scripts", "tooling", true],
    ]);
    const rootOf = new Map(snapshot.components.map((c) => [c.id, c.rootPath]));
    expect(
      snapshot.edges.map((e) => [rootOf.get(e.from), rootOf.get(e.to), e.count, e.examples]).sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual([
      ["apps/web", "packages/core", 1, ["apps/web/src/App.tsx → packages/core/src/index.ts"]],
      ["apps/web", "packages/db", 1, ["apps/web/src/api.ts → packages/db/src/index.ts"]],
      ["packages/db", "packages/core", 1, ["packages/db/src/index.ts → packages/core/src/index.ts"]],
    ]);
    expect(snapshot.externals.map((d) => [d.name, d.usedBy.map((u) => [rootOf.get(u.componentId), u.count])])).toEqual([
      ["better-sqlite3", [["packages/db", 1]]],
      ["react", [["apps/web", 1]]],
      ["react-dom", [["apps/web", 1]]],
    ]);
    expect(built.exportsByComponent.get(componentIdFor("packages/core"))).toEqual(["User", "makeUser"]);
  });
});

describe("buildOverview on this repo (index §9 lane 04 done)", () => {
  it(
    "matches the expected component table rows and edges",
    async () => {
      const model = await scanRepoModel(REPO_ROOT, { scan: scanRepo, extract: extractImports });
      const snapshot = snapshotOf(REPO_ROOT, buildOverview(model), model.partial);
      expect(OverviewSnapshotSchema.safeParse(snapshot).success).toBe(true);
      expect(snapshot.partial).toBe(false);
      const row = (rootPath: string) => {
        const component = snapshot.components.find((c) => c.rootPath === rootPath);
        return component === undefined ? undefined : [component.name, component.roleGuess];
      };
      expect(row(".")).toEqual(["config", "config"]);
      expect(row("packages/contracts")).toEqual(["@jevcode/contracts", "domain"]);
      expect(row("packages/storage")).toEqual(["@jevcode/storage", "storage"]);
      expect(row("packages/ui-catalog")).toEqual(["@jevcode/ui-catalog", "ui"]);
      expect(row("packages/agent-codex")).toEqual(["@jevcode/agent-codex", "agent"]);
      expect(row("packages/jev-router")).toEqual(["@jevcode/jev-router", "agent"]);
      expect(row("packages/trace-viewer/src/ui")).toEqual(["@jevcode/trace-viewer/ui", "ui"]);
      expect(row("scripts")).toEqual(["scripts", "tooling"]);
      const storageToContracts = snapshot.edges.find(
        (e) => e.from === componentIdFor("packages/storage") && e.to === componentIdFor("packages/contracts"),
      );
      expect(storageToContracts?.count).toBeGreaterThan(0);
    },
    60_000,
  );
});
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/main/pipeline/explainer-overview.test.ts`

Expected: FAIL with `Failed to resolve import "./explainer-overview.js"`.

- [ ] **Step 3: Implement `explainer-overview.ts`**

Create `apps/desktop/src/main/pipeline/explainer-overview.ts`:

```ts
import type { ComponentEdge, ExternalDep, Role } from "@jevcode/contracts";
import {
  aggregateEdges,
  aggregateExternals,
  compareText,
  componentOf,
  componentize,
  guessRole,
  type ComponentDraft,
  type ExternalImport,
  type ImportEdge,
  type ScannedFile,
  type TsconfigPaths,
  type WorkspaceManifest,
} from "@jevcode/codebase-map";
import type { ScanOptions, scanPaths, scanRepo } from "@jevcode/codebase-map/node";
import {
  languageForPath,
  resolveSpecifier,
  type ExtractedImports,
  type ResolveContext,
  type extractImports,
} from "@jevcode/evidence-engine";

/** Spec §6.2: the narrator sees at most this many exported names per component. */
export const MAX_EXPORTS_PER_COMPONENT = 15;

/** Everything one scan learned, kept so a file change re-parses only that file (spec §5.1). */
export interface RepoModel {
  files: Map<string, ScannedFile>;
  /** Import scans of the files the parser reads (TS, TSX, JS, JSON). */
  imports: Map<string, ExtractedImports>;
  manifest: WorkspaceManifest;
  tsconfig: TsconfigPaths;
  partial: boolean;
  /** Repo files before the scan cap (ruling R3); only meaningful while `partial`. */
  totalFiles: number;
}

/** The rule-based overview: components, edges, externals, role guesses and exported names. */
export interface BuiltOverview {
  drafts: ComponentDraft[];
  roleGuess: ReadonlyMap<string, Role>;
  edges: ComponentEdge[];
  externals: ExternalDep[];
  exportsByComponent: ReadonlyMap<string, readonly string[]>;
}

export interface ModelScanDeps {
  scan: typeof scanRepo;
  extract: typeof extractImports;
}

export interface ModelUpdateDeps {
  scanPaths: typeof scanPaths;
  extract: typeof extractImports;
}

function importVisitor(
  imports: Map<string, ExtractedImports>,
  extract: typeof extractImports,
): NonNullable<ScanOptions["visit"]> {
  return async (file, source) => {
    const language = languageForPath(file.path);
    if (language === null) {
      imports.delete(file.path);
      return;
    }
    try {
      imports.set(file.path, await extract(file.path, source, language));
    } catch {
      // A file the parser rejects contributes no edges; the scan goes on.
      imports.delete(file.path);
    }
  };
}

export async function scanRepoModel(
  repoRoot: string,
  deps: ModelScanDeps,
  options: Pick<ScanOptions, "signal" | "onProgress"> = {},
): Promise<RepoModel> {
  const imports = new Map<string, ExtractedImports>();
  const result = await deps.scan(repoRoot, { ...options, visit: importVisitor(imports, deps.extract) });
  return {
    files: new Map(result.files.map((file) => [file.path, file])),
    imports,
    manifest: result.manifest,
    tsconfig: result.tsconfig,
    partial: result.partial,
    totalFiles: result.totalFiles,
  };
}

/**
 * Re-reads and re-parses only `paths` and updates the model in place. Returns false when no
 * file was added, removed or changed its content hash. A partial model never grows past its cap.
 */
export async function applyFileChanges(
  repoRoot: string,
  model: RepoModel,
  paths: readonly string[],
  deps: ModelUpdateDeps,
): Promise<boolean> {
  const result = await deps.scanPaths(repoRoot, paths, { visit: importVisitor(model.imports, deps.extract) });
  let changed = false;
  for (const gone of result.gone) {
    if (model.files.delete(gone)) changed = true;
    model.imports.delete(gone);
  }
  for (const file of result.files) {
    const before = model.files.get(file.path);
    if (before === undefined && model.partial) {
      model.imports.delete(file.path);
      continue;
    }
    if (before === undefined || before.hash !== file.hash) changed = true;
    model.files.set(file.path, file);
  }
  return changed;
}

/** Workspace package name → directory, for resolving `import "@scope/pkg"` to a repo file. */
export function workspacePackagesOf(manifest: WorkspaceManifest): Record<string, string> {
  const packages: Record<string, string> = {};
  for (const dir of [...manifest.packageDirs, ...manifest.appDirs]) {
    const name = manifest.packageNames[dir];
    if (name !== undefined) packages[name] = dir;
  }
  return packages;
}

export function buildOverview(model: RepoModel): BuiltOverview {
  const drafts = componentize([...model.files.values()], model.manifest);
  const ofFile = componentOf(drafts);
  const ctx: ResolveContext = {
    files: new Set(model.files.keys()),
    tsPaths: model.tsconfig.paths,
    baseUrl: model.tsconfig.baseUrl,
    workspacePackages: workspacePackagesOf(model.manifest),
  };
  const importEdges: ImportEdge[] = [];
  const externalImports: ExternalImport[] = [];
  const exportNames = new Map<string, Set<string>>();
  for (const [from, scan] of model.imports) {
    if (!model.files.has(from)) continue;
    for (const specifier of scan.specifiers) {
      const resolved = resolveSpecifier(from, specifier, ctx);
      if (resolved.kind === "file" && resolved.path !== from) importEdges.push({ from, to: resolved.path });
      else if (resolved.kind === "external") externalImports.push({ from, packageName: resolved.packageName });
    }
    const componentId = ofFile(from);
    if (componentId === undefined || scan.exports.length === 0) continue;
    const names = exportNames.get(componentId) ?? new Set<string>();
    for (const name of scan.exports) names.add(name);
    exportNames.set(componentId, names);
  }
  const externals = aggregateExternals(externalImports, ofFile);
  return {
    drafts,
    roleGuess: new Map(drafts.map((draft) => [draft.id, guessRole(draft, externals)])),
    edges: aggregateEdges(importEdges, ofFile),
    externals,
    exportsByComponent: new Map(
      [...exportNames.entries()].map(([id, names]) => [id, [...names].sort(compareText).slice(0, MAX_EXPORTS_PER_COMPONENT)]),
    ),
  };
}
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/main/pipeline/explainer-overview.test.ts`

Expected: PASS, `Tests  2 passed (2)`. The repo test parses about 800 files on one thread (about 1–2 s).

- [ ] **Step 4: Write the failing stage tests**

Create `apps/desktop/src/main/pipeline/explainer-stage.test.ts`. The scan is a pure fake over an in-memory source table, so timing, failures and content are controlled (`afterProgress` advances the fake clock between progress callbacks); the database is real. The incremental test compares the rebuilt snapshot with a fresh scan of the same sources (Review Focus 2). The progress test's expected rows follow from ruling R3 and the 2 s writer: with 700 ms per file, progress 4 (2,100 ms) is the first row, the writer's next slot (4,100 ms) carries 6/6, and the done row waits until 6,100 ms.

```ts
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { OverviewSnapshotSchema, type OverviewSnapshot } from "@jevcode/contracts";
import { componentIdFor, languageOf, type ScannedFile, type WorkspaceManifest } from "@jevcode/codebase-map";
import type { ScanOptions, scanPaths, scanRepo } from "@jevcode/codebase-map/node";
import type { extractImports } from "@jevcode/evidence-engine";
import { openDb } from "@jevcode/storage";
import type { JevcodeDb } from "@jevcode/storage";
import { afterEach, describe, expect, it } from "vitest";

import {
  FILES_SETTLE_MS,
  SCAN_PROGRESS_AFTER_MS,
  SNAPSHOT_WRITE_INTERVAL_MS,
  createExplainerRegistry,
  createExplainerStage,
  type ExplainerLogEvent,
  type ExplainerStage,
  type ExplainerStageDeps,
  type ExplainerStatus,
  type NarrationContext,
  type NarrationSeam,
} from "./explainer-stage.js";

const REPO_ID = "repo_explainer";
const REPO_ROOT = "/work/fx";
const SESSION = "sess_explainer_1";
const SESSION_2 = "sess_explainer_2";

const BASE_SOURCES: Readonly<Record<string, string>> = {
  "package.json": '{"name":"fx"}',
  "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
  "packages/core/package.json": '{"name":"@fx/core"}',
  "packages/core/src/index.ts": "export const user = 1;\n",
  "packages/db/package.json": '{"name":"@fx/db"}',
  "packages/db/src/index.ts": 'import { user } from "@fx/core";\nimport Database from "better-sqlite3";\nexport const db = user;\n',
};
const MANIFEST: WorkspaceManifest = {
  packageDirs: ["packages/core", "packages/db"],
  appDirs: [],
  packageNames: { ".": "fx", "packages/core": "@fx/core", "packages/db": "@fx/db" },
  descriptions: {},
  entryPoints: {},
};
const CORE = componentIdFor("packages/core");
const DB = componentIdFor("packages/db");

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function createDb(): JevcodeDb {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jevcode-explainer-"));
  dirs.push(dir);
  const db = openDb({ dbPath: path.join(dir, "explainer.db") });
  db.upsertRepository({ id: REPO_ID, path: REPO_ROOT, gitRoot: REPO_ROOT });
  db.createSession({ id: SESSION, repoId: REPO_ID });
  db.createSession({ id: SESSION_2, repoId: REPO_ID });
  return db;
}

function snapshotRows(db: JevcodeDb, sessionId: string): { seq: number; snapshot: OverviewSnapshot }[] {
  return db
    .listEvents(sessionId)
    .filter((event) => event.type === "overview_snapshot")
    .map((event) => ({ seq: event.seq, snapshot: OverviewSnapshotSchema.parse(JSON.parse(event.payloadJson)) }));
}

function scanned(filePath: string, text: string): ScannedFile {
  return { path: filePath, hash: createHash("sha1").update(text).digest("hex"), size: text.length, language: languageOf(filePath) };
}

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

interface Harness {
  db: JevcodeDb;
  clock: ReturnType<typeof fakeClock>;
  sources: Record<string, string>;
  calls: { scan: number; scanPaths: string[][]; extract: string[] };
  hints: [string, number][];
  logs: ExplainerLogEvent[];
  statuses: ExplainerStatus[];
  control: { gate: Promise<void> | null; fail: Error | null; afterProgress: ((index: number) => void) | null };
  deps: ExplainerStageDeps;
}

/** A pure fake scan over `sources`, so stage tests control timing, failures and content. */
function harness(overrides: Partial<ExplainerStageDeps> = {}, db: JevcodeDb = createDb()): Harness {
  const clock = fakeClock();
  const sources: Record<string, string> = { ...BASE_SOURCES };
  const calls = { scan: 0, scanPaths: [] as string[][], extract: [] as string[] };
  const hints: [string, number][] = [];
  const logs: ExplainerLogEvent[] = [];
  const statuses: ExplainerStatus[] = [];
  const control: Harness["control"] = { gate: null, fail: null, afterProgress: null };
  const scan: typeof scanRepo = async (_root, options: ScanOptions = {}) => {
    calls.scan += 1;
    if (control.gate !== null) await control.gate;
    options.signal?.throwIfAborted();
    if (control.fail !== null) throw control.fail;
    const entries = Object.entries(sources).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const files = entries.map(([filePath, text]) => scanned(filePath, text));
    for (const [index, file] of files.entries()) {
      await options.visit?.(file, entries[index]?.[1] ?? "");
      options.onProgress?.(index + 1, files.length);
      control.afterProgress?.(index);
    }
    return { files, manifest: MANIFEST, partial: false, tsconfig: { paths: {}, baseUrl: null }, totalFiles: files.length };
  };
  const scanPathsFake: typeof scanPaths = async (_root, paths, options = {}) => {
    calls.scanPaths.push([...paths]);
    const files: ScannedFile[] = [];
    const gone: string[] = [];
    for (const filePath of paths) {
      const text = sources[filePath];
      if (text === undefined) {
        gone.push(filePath);
        continue;
      }
      const file = scanned(filePath, text);
      files.push(file);
      await options.visit?.(file, text);
    }
    return { files, gone };
  };
  const extract: typeof extractImports = async (filePath, source) => {
    calls.extract.push(filePath);
    return { specifiers: [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1] ?? ""), exports: [] };
  };
  const deps: ExplainerStageDeps = {
    db,
    repoRoot: REPO_ROOT,
    sessionId: () => SESSION,
    scan,
    scanPaths: scanPathsFake,
    extract,
    emitRowsAvailable: (sessionId, lastSeq) => hints.push([sessionId, lastSeq]),
    now: clock.now,
    schedule: clock.schedule,
    log: (event) => logs.push(event),
    onStatus: (status) => statuses.push(status),
    ...overrides,
  };
  return { db, clock, sources, calls, hints, logs, statuses, control, deps };
}

const stages: ExplainerStage[] = [];
function start(h: Harness): ExplainerStage {
  const stage = createExplainerStage(h.deps);
  stages.push(stage);
  return stage;
}
afterEach(() => {
  while (stages.length > 0) stages.pop()?.dispose();
});

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ExplainerStage scan and rows (spec §6.1, §6.5)", () => {
  it("scans on repo open, writes a schema-valid row with a push hint and stores overview_state", async () => {
    const h = harness();
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    const rows = snapshotRows(h.db, SESSION);
    expect(rows).toHaveLength(1);
    const snapshot = rows[0]?.snapshot as OverviewSnapshot;
    expect(snapshot.sessionId).toBe(SESSION);
    expect(snapshot.repoRoot).toBe(REPO_ROOT);
    expect(snapshot.components.map((c) => [c.rootPath, c.roleGuess])).toEqual([
      [".", "config"],
      ["packages/core", "domain"],
      ["packages/db", "storage"],
    ]);
    expect(snapshot.edges.map((e) => [e.from, e.to, e.count])).toEqual([[DB, CORE, 1]]);
    expect(snapshot.externals).toEqual([{ name: "better-sqlite3", usedBy: [{ componentId: DB, count: 1 }] }]);
    expect(snapshot.status).toEqual({ scan: { state: "done", scanned: 6, total: 6 }, narrator: "unavailable" });
    expect(snapshot.counts.totalFiles).toBe(6);
    expect(h.hints).toEqual([[SESSION, rows[0]?.seq]]);
    expect(h.db.getOverviewState(REPO_ROOT)?.snapshot.components).toEqual(snapshot.components);
    expect(stage.status()).toEqual({ phase: "ready", done: 6, total: 6, error: null });
    expect(h.logs.some((event) => event.kind === "scan" && event.files === 6 && !event.partial)).toBe(true);
  });

  it("reports scan progress through onStatus", async () => {
    const h = harness();
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    expect(h.statuses[0]).toEqual({ phase: "scanning", done: 0, total: 0, error: null });
    expect(h.statuses).toContainEqual({ phase: "scanning", done: 3, total: 6, error: null });
    expect(h.statuses[h.statuses.length - 1]?.phase).toBe("ready");
  });

  it("shows the stored map at once on reopen and writes no second row when the scan agrees", async () => {
    const db = createDb();
    const first = start(harness({}, db));
    first.onRepoOpened();
    await first.whenIdle();
    first.dispose();

    const h = harness({ sessionId: () => SESSION_2 }, db);
    const gate = deferred();
    h.control.gate = gate.promise;
    const stage = start(h);
    stage.onRepoOpened();
    expect(snapshotRows(db, SESSION_2)).toHaveLength(1);
    gate.resolve();
    await stage.whenIdle();
    expect(snapshotRows(db, SESSION_2)).toHaveLength(1);
    expect(h.hints).toHaveLength(1);
  });

  it("writes one row per session at session start and never repeats an unchanged snapshot", async () => {
    const h = harness();
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    stage.onSessionStarted(SESSION);
    stage.onSessionStarted(SESSION_2);
    expect(snapshotRows(h.db, SESSION)).toHaveLength(1);
    const second = snapshotRows(h.db, SESSION_2);
    expect(second).toHaveLength(1);
    expect(second[0]?.snapshot.sessionId).toBe(SESSION_2);
    expect(h.calls.scan).toBe(1);
  });

  it("scans on the first session start when the repo-open scan never ran", async () => {
    const h = harness();
    const stage = start(h);
    stage.onSessionStarted(SESSION);
    await stage.whenIdle();
    expect(h.calls.scan).toBe(1);
    expect(snapshotRows(h.db, SESSION)).toHaveLength(1);
  });
});

describe("ExplainerStage scan progress rows (ruling R3)", () => {
  it("writes progress only after 2 s of scanning, at most one row per 2 s, then the done row", async () => {
    const h = harness();
    h.control.afterProgress = () => h.clock.advance(700);
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    // Progress 1..3 lands at 0, 700 and 1,400 ms (under 2 s): no row. Progress 4 at 2,100 ms is
    // the session's first row; 5 (2,800 ms) and 6 (3,500 ms) wait for the writer, which writes
    // 6/6 at 4,100 ms. The done snapshot then waits until 6,100 ms.
    const progress = snapshotRows(h.db, SESSION).map((row) => [row.snapshot.status?.scan, row.snapshot.components.length]);
    expect(progress).toEqual([
      [{ state: "running", scanned: 4, total: 6 }, 0],
      [{ state: "running", scanned: 6, total: 6 }, 0],
    ]);
    expect(h.clock.now()).toBe(4_200);
    h.clock.advance(1_899);
    expect(snapshotRows(h.db, SESSION)).toHaveLength(2);
    h.clock.advance(1);
    const rows = snapshotRows(h.db, SESSION);
    expect(rows).toHaveLength(3);
    expect(rows[2]?.snapshot.status?.scan).toEqual({ state: "done", scanned: 6, total: 6 });
    expect(rows[2]?.snapshot.components).toHaveLength(3);
  });

  it("writes no progress row for a scan under 2 s", async () => {
    const h = harness();
    h.control.afterProgress = () => h.clock.advance((SCAN_PROGRESS_AFTER_MS - 1) / 6);
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    const rows = snapshotRows(h.db, SESSION);
    expect(rows.map((row) => row.snapshot.status?.scan.state)).toEqual(["done"]);
  });

  it("carries the previous snapshot's components in progress rows of a rescan", async () => {
    const h = harness();
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    h.clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);
    h.control.afterProgress = () => h.clock.advance(SCAN_PROGRESS_AFTER_MS);
    stage.rescan();
    await stage.whenIdle();
    const running = snapshotRows(h.db, SESSION).filter((row) => row.snapshot.status?.scan.state === "running");
    expect(running.length).toBeGreaterThan(0);
    for (const row of running) expect(row.snapshot.components).toHaveLength(3);
  });
});

describe("ExplainerStage narrator status (ruling R3, R4)", () => {
  async function narratorOf(overrides: Partial<ExplainerStageDeps>): Promise<string | undefined> {
    const h = harness(overrides);
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    return snapshotRows(h.db, SESSION)[0]?.snapshot.status?.narrator;
  }
  const seam = (narratorStatus?: () => "pending" | "ready"): NarrationSeam => ({
    textFor: () => new Map(),
    narrative: () => null,
    onSnapshot: () => {},
    dispose: () => {},
    ...(narratorStatus === undefined ? {} : { narratorStatus }),
  });

  it("is unavailable under NO_NARRATION", async () => {
    expect(await narratorOf({})).toBe("unavailable");
  });

  it("is off when the explainWithModel preference is off, whatever the seam says", async () => {
    expect(await narratorOf({ explainWithModel: () => false })).toBe("off");
    expect(await narratorOf({ explainWithModel: () => false, narration: () => seam(() => "ready") })).toBe("off");
  });

  it("is the seam's narratorStatus when it has one, else unavailable", async () => {
    expect(await narratorOf({ explainWithModel: () => true, narration: () => seam(() => "pending") })).toBe("pending");
    expect(await narratorOf({ narration: () => seam() })).toBe("unavailable");
  });
});

describe("ExplainerStage incremental rebuilds (spec §5.1, §6.1)", () => {
  it("re-parses only changed files, keeps untouched content hashes, and equals a fresh scan", async () => {
    const h = harness();
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    const before = snapshotRows(h.db, SESSION)[0]?.snapshot as OverviewSnapshot;
    const extractsBefore = h.calls.extract.length;

    h.sources["packages/core/src/index.ts"] = "export const user = 2;\n";
    stage.onFilesChanged(["packages/core/src/index.ts"]);
    h.clock.advance(FILES_SETTLE_MS);
    await stage.whenIdle();
    h.clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);

    expect(h.calls.scan).toBe(1);
    expect(h.calls.scanPaths).toEqual([["packages/core/src/index.ts"]]);
    expect(h.calls.extract.slice(extractsBefore)).toEqual(["packages/core/src/index.ts"]);
    const rows = snapshotRows(h.db, SESSION);
    expect(rows).toHaveLength(2);
    const after = rows[1]?.snapshot as OverviewSnapshot;
    const hash = (snapshot: OverviewSnapshot, id: string) => snapshot.components.find((c) => c.id === id)?.contentHash;
    expect(hash(after, CORE)).not.toBe(hash(before, CORE));
    expect(hash(after, DB)).toBe(hash(before, DB));

    const fresh = harness({ sessionId: () => SESSION_2 });
    Object.assign(fresh.sources, h.sources);
    const freshStage = start(fresh);
    freshStage.onRepoOpened();
    await freshStage.whenIdle();
    const freshSnapshot = snapshotRows(fresh.db, SESSION_2)[0]?.snapshot as OverviewSnapshot;
    expect(after.components).toEqual(freshSnapshot.components);
    expect(after.edges).toEqual(freshSnapshot.edges);
    expect(after.externals).toEqual(freshSnapshot.externals);
  });

  it("waits for changes to settle and writes a changed snapshot at most once per 2 s", async () => {
    const h = harness();
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    expect(snapshotRows(h.db, SESSION)).toHaveLength(1);

    h.sources["packages/core/src/index.ts"] = "export const user = 2;\n";
    stage.onFilesChanged(["packages/core/src/index.ts"]);
    h.clock.advance(FILES_SETTLE_MS - 1);
    await stage.whenIdle();
    expect(h.calls.scanPaths).toHaveLength(0);
    h.clock.advance(1);
    await stage.whenIdle();
    expect(snapshotRows(h.db, SESSION)).toHaveLength(1);

    h.sources["packages/core/src/index.ts"] = "export const user = 3;\n";
    stage.onFilesChanged(["packages/core/src/index.ts"]);
    h.clock.advance(FILES_SETTLE_MS);
    await stage.whenIdle();
    expect(snapshotRows(h.db, SESSION)).toHaveLength(1);

    h.clock.advance(SNAPSHOT_WRITE_INTERVAL_MS - 2 * FILES_SETTLE_MS - 1);
    expect(snapshotRows(h.db, SESSION)).toHaveLength(1);
    h.clock.advance(1);
    const rows = snapshotRows(h.db, SESSION);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.snapshot.components.find((c) => c.id === CORE)?.contentHash).toBe(
      createHash("sha1")
        .update(
          [
            `packages/core/package.json:${scanned("x", BASE_SOURCES["packages/core/package.json"] as string).hash}`,
            `packages/core/src/index.ts:${scanned("x", "export const user = 3;\n").hash}`,
          ].join("\n"),
        )
        .digest("hex"),
    );
  });

  it("reruns the full scan when a manifest changes", async () => {
    const h = harness();
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    stage.onFilesChanged(["packages/db/package.json"]);
    h.clock.advance(FILES_SETTLE_MS);
    await stage.whenIdle();
    expect(h.calls.scan).toBe(2);
    expect(h.calls.scanPaths).toEqual([]);
  });

  it("applies changes that arrive during a scan once the scan finishes", async () => {
    const h = harness();
    const gate = deferred();
    h.control.gate = gate.promise;
    const stage = start(h);
    stage.onRepoOpened();
    stage.onFilesChanged(["packages/db/src/index.ts"]);
    gate.resolve();
    await stage.whenIdle();
    h.clock.advance(FILES_SETTLE_MS);
    await stage.whenIdle();
    expect(h.calls.scanPaths).toEqual([["packages/db/src/index.ts"]]);
  });
});

describe("ExplainerStage failure and lifecycle (spec §6.6)", () => {
  it("logs a failed scan, writes a failed status row with no components, and recovers on rescan", async () => {
    const h = harness();
    h.control.fail = new Error("git ls-files failed");
    const stage = start(h);
    expect(() => stage.onRepoOpened()).not.toThrow();
    await stage.whenIdle();
    expect(stage.status()).toEqual({ phase: "failed", done: 0, total: 0, error: "git ls-files failed" });
    expect(h.logs).toContainEqual({ kind: "error", where: "scan", message: "git ls-files failed" });
    const failed = snapshotRows(h.db, SESSION);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.snapshot.components).toEqual([]);
    expect(failed[0]?.snapshot.status).toEqual({
      scan: { state: "failed", scanned: 0, total: 0, error: "git ls-files failed" },
      narrator: "unavailable",
    });
    expect(h.db.getOverviewState(REPO_ROOT)).toBeUndefined();

    h.control.fail = null;
    stage.rescan();
    await stage.whenIdle();
    h.clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);
    expect(stage.status().phase).toBe("ready");
    const rows = snapshotRows(h.db, SESSION);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.snapshot.status?.scan.state).toBe("done");
  });

  it("keeps the previous components in a failed row and clips the error to 200 characters", async () => {
    const h = harness();
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    const before = snapshotRows(h.db, SESSION)[0]?.snapshot as OverviewSnapshot;
    h.control.fail = new Error("x".repeat(500));
    stage.rescan();
    await stage.whenIdle();
    h.clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);
    const failed = snapshotRows(h.db, SESSION)[1]?.snapshot as OverviewSnapshot;
    expect(failed.components).toEqual(before.components);
    expect(failed.status?.scan.state).toBe("failed");
    expect(failed.status?.scan.error).toHaveLength(200);
    expect(h.db.getOverviewState(REPO_ROOT)?.snapshot.status?.scan.state).toBe("done");
  });

  it("logs a failed row write and keeps running", async () => {
    const h = harness({ sessionId: () => "sess_missing" });
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    expect(h.logs.some((event) => event.kind === "error" && event.where === "write")).toBe(true);
    expect(stage.status().phase).toBe("ready");
  });

  it("writes nothing after dispose, even when an in-flight scan finishes", async () => {
    const h = harness();
    const gate = deferred();
    h.control.gate = gate.promise;
    const stage = start(h);
    stage.onRepoOpened();
    stage.dispose();
    gate.resolve();
    await stage.whenIdle();
    expect(snapshotRows(h.db, SESSION)).toHaveLength(0);
    expect(h.hints).toEqual([]);
  });

  it("aborts a running scan on rescan and keeps only the newer result", async () => {
    const h = harness();
    const gate = deferred();
    h.control.gate = gate.promise;
    const stage = start(h);
    stage.onRepoOpened();
    h.control.gate = null;
    stage.rescan();
    gate.resolve();
    await stage.whenIdle();
    expect(h.calls.scan).toBe(2);
    expect(snapshotRows(h.db, SESSION)).toHaveLength(1);
  });
});

describe("ExplainerStage narration seam (interfaces §5, lane 05)", () => {
  it("uses text from the seam, calls onSnapshot, re-publishes on refresh and disposes the seam", async () => {
    let purpose = "Holds the domain types.";
    let context: NarrationContext | null = null;
    const seen: OverviewSnapshot[] = [];
    let disposed = false;
    const narration = (ctx: NarrationContext): NarrationSeam => {
      context = ctx;
      return {
        textFor: () => new Map([[CORE, { purpose, role: "domain" as const, provenance: "model" as const }]]),
        narrative: () => null,
        onSnapshot: (snapshot) => void seen.push(snapshot),
        dispose: () => {
          disposed = true;
        },
      };
    };
    const h = harness({ narration });
    const stage = start(h);
    stage.onRepoOpened();
    await stage.whenIdle();
    const first = snapshotRows(h.db, SESSION)[0]?.snapshot.components.find((c) => c.id === CORE);
    expect(first).toMatchObject({ purpose: "Holds the domain types.", provenance: "model", roleGuess: "domain" });
    expect(seen).toHaveLength(1);

    purpose = "Defines users.";
    (context as unknown as NarrationContext).refresh();
    h.clock.advance(SNAPSHOT_WRITE_INTERVAL_MS);
    const rows = snapshotRows(h.db, SESSION);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.snapshot.components.find((c) => c.id === CORE)?.purpose).toBe("Defines users.");
    stage.dispose();
    expect(disposed).toBe(true);
  });
});

describe("createExplainerRegistry", () => {
  it("keeps one stage for the open repo and ignores calls for other repos", () => {
    const made: string[] = [];
    const calls: string[] = [];
    const registry = createExplainerRegistry((repoRoot) => {
      made.push(repoRoot);
      return {
        onRepoOpened: () => void calls.push(`open ${repoRoot}`),
        onSessionStarted: (sessionId) => void calls.push(`session ${repoRoot} ${sessionId}`),
        onFilesChanged: (paths) => void calls.push(`files ${repoRoot} ${paths.join(",")}`),
        onPipelineSync: () => {},
        rescan: () => void calls.push(`rescan ${repoRoot}`),
        status: () => ({ phase: "idle", done: 0, total: 0, error: null }),
        whenIdle: async () => {},
        dispose: () => void calls.push(`dispose ${repoRoot}`),
      };
    });
    registry.repoOpened("/a");
    registry.sessionStarted("/a", "s1");
    registry.filesChanged("/b", ["x.ts"]);
    registry.rescan("/b");
    registry.filesChanged("/a", ["x.ts"]);
    registry.repoOpened("/b");
    registry.rescan("/b");
    registry.repoClosed("/a");
    registry.dispose();
    expect(made).toEqual(["/a", "/b"]);
    expect(calls).toEqual([
      "open /a",
      "session /a s1",
      "files /a x.ts",
      "dispose /a",
      "open /b",
      "rescan /b",
      "dispose /b",
    ]);
  });
});
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/main/pipeline/explainer-stage.test.ts`

Expected: FAIL with `Failed to resolve import "./explainer-stage.js"`.

- [ ] **Step 5: Implement `explainer-stage.ts`**

Create `apps/desktop/src/main/pipeline/explainer-stage.ts`:

```ts
import { createHash } from "node:crypto";

import { canonicalJson } from "@jevcode/contracts";
import type {
  ChangeUnit,
  ComponentEdge,
  Decision,
  ExternalDep,
  NarratorState,
  OverviewSnapshot,
  OverviewStatus,
  Role,
} from "@jevcode/contracts";
import { assembleSnapshot, clipText, type ComponentDraft, type ComponentText, type WorkspaceManifest } from "@jevcode/codebase-map";
import type { scanPaths, scanRepo } from "@jevcode/codebase-map/node";
import type { extractImports } from "@jevcode/evidence-engine";
import type { JevcodeDb } from "@jevcode/storage";

import { applyFileChanges, buildOverview, scanRepoModel, type BuiltOverview, type RepoModel } from "./explainer-overview.js";

/** Spec §5.5: at most one snapshot row per session every 2 s. */
export const SNAPSHOT_WRITE_INTERVAL_MS = 2_000;
/** Spec §6.1: a rebuild waits until watcher changes have settled for 500 ms. */
export const FILES_SETTLE_MS = 500;
/** Ruling R3: a scan that runs longer than this writes progress snapshots (through the 2 s writer). */
export const SCAN_PROGRESS_AFTER_MS = 2_000;
/** Ruling R3: `status.scan.error` is at most this long. */
export const SCAN_ERROR_MAX = 200;
/** Edits that can move component boundaries or import resolution rerun the full scan. */
const MANIFEST_CHANGE = /(^|\/)(package\.json|pnpm-workspace\.yaml|tsconfig[^/]*\.json|\.gitignore)$/;

export type ExplainerLogEvent =
  | { kind: "scan"; files: number; partial: boolean; ms: number }
  | {
      kind: "narrator";
      question: "describeComponents" | "overviewNarrative" | "sessionStory" | "decisionWhy";
      ms: number;
      accepted: number;
      dropped: number;
      discarded: boolean;
      error?: string;
    }
  | { kind: "snapshot"; components: number; edges: number; bytes: number }
  | { kind: "error"; where: "scan" | "rebuild" | "write" | "state"; message: string };

/** Scan progress and failure for the Brief (spec §6.1, §6.6); see the lane's spec gap 1. */
export interface ExplainerStatus {
  phase: "idle" | "scanning" | "ready" | "failed";
  done: number;
  total: number;
  error: string | null;
}

/** What lane 05's narration reads: the rule-based overview of the current snapshot. */
export interface OverviewView {
  repoRoot: string;
  drafts: readonly ComponentDraft[];
  roleGuess: ReadonlyMap<string, Role>;
  edges: readonly ComponentEdge[];
  externals: readonly ExternalDep[];
  manifest: WorkspaceManifest;
  exportsOf(componentId: string): readonly string[];
}

export interface NarrationContext {
  repoRoot: string;
  db: JevcodeDb;
  now(): number;
  schedule: ExplainerStageDeps["schedule"];
  log(event: ExplainerLogEvent): void;
  /** Re-assembles the snapshot from the current overview (no rescan); call it when new text lands. */
  refresh(): void;
}

/**
 * The seam lane 05 (N-5) fills (interfaces §5, ruling R4). Lane 04 ships NO_NARRATION: every
 * purpose is null, every role is the rule-based guess, the narrative is null and the narrator
 * status is "unavailable" ("off" when the explainWithModel preference is off).
 */
export interface NarrationSeam {
  /** Purposes and confirmed roles by component id (lane 05 reads component_text_cache). */
  textFor(view: OverviewView): ReadonlyMap<string, ComponentText>;
  /** The overview narrative to embed, or null. */
  narrative(snapshot: OverviewSnapshot, view: OverviewView): OverviewSnapshot["narrative"];
  /** Called after every rebuild; lane 05 schedules describeComponents and overviewNarrative here. */
  onSnapshot(snapshot: OverviewSnapshot, view: OverviewView): void;
  /** Ruling R4: lane 05's `ExplainerStage.setNarrator` forwards a `NarratorClient | null` here. */
  setNarrator?(narrator: unknown): void;
  /** Ruling R4: the narrator state written to `status.narrator`; absent means "unavailable". */
  narratorStatus?(): NarratorState;
  dispose(): void;
}

export const NO_NARRATION: NarrationSeam = {
  textFor: () => new Map(),
  narrative: () => null,
  onSnapshot: () => {},
  dispose: () => {},
};

export interface ExplainerStageDeps {
  db: JevcodeDb;
  repoRoot: string;
  /** The session whose viewer shows this repo, or null; snapshot rows go there. */
  sessionId: () => string | null;
  scan: typeof scanRepo;
  scanPaths: typeof scanPaths;
  extract: typeof extractImports;
  /** Lane 03 D-1's push hint (trace:rowsAvailable). */
  emitRowsAvailable(sessionId: string, lastSeq: number): void;
  now(): number;
  schedule: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
  log(event: ExplainerLogEvent): void;
  narration?: (ctx: NarrationContext) => NarrationSeam;
  /** The explainWithModel preference (spec E15); false writes narrator "off". Absent reads as on. */
  explainWithModel?(): boolean;
  onStatus?(status: ExplainerStatus): void;
}

export interface ExplainerStage {
  /** Shows the stored map at once, then starts (or keeps) a background scan. */
  onRepoOpened(): void;
  /** Writes the current snapshot row for the session; scans when no scan has run. */
  onSessionStarted(sessionId: string): void;
  /** Queues changed repo-relative paths; the rebuild runs 500 ms after the last change. */
  onFilesChanged(paths: readonly string[]): void;
  /** Lane 07 (S-2) owns this body: story and highlight triggers. */
  onPipelineSync(sync: { sessionId: string; lastSeq: number; changeUnits: ChangeUnit[]; decisions: Decision[] }): void;
  /** overview:rescan (spec §6.6 Retry): aborts a running scan and starts a new one. */
  rescan(): void;
  status(): ExplainerStatus;
  /** Resolves when no scan or rebuild is in flight. Timers are not awaited. */
  whenIdle(): Promise<void>;
  dispose(): void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Identity of a snapshot's content: everything except the session, the scan id and the time. */
export function snapshotKey(snapshot: OverviewSnapshot): string {
  return createHash("sha1")
    .update(canonicalJson({ ...snapshot, sessionId: "", scanId: "", generatedAt: "" }))
    .digest("hex");
}

export function createExplainerStage(deps: ExplainerStageDeps): ExplainerStage {
  let disposed = false;
  let model: RepoModel | null = null;
  let built: BuiltOverview | null = null;
  /** The last full snapshot: persisted to overview_state and the base of progress and failure rows. */
  let content: { snapshot: OverviewSnapshot; key: string } | null = null;
  /** What the single row writer writes next: a full snapshot, or a progress or failure snapshot. */
  let latest: { snapshot: OverviewSnapshot; key: string } | null = null;
  let scanning: AbortController | null = null;
  let generation = 0;
  let scanCount = 0;
  let scanPromise: Promise<void> = Promise.resolve();
  let rebuildChain: Promise<void> = Promise.resolve();
  let settleTimer: unknown = null;
  let status: ExplainerStatus = { phase: "idle", done: 0, total: 0, error: null };
  const dirty = new Set<string>();
  const written = new Map<string, { key: string; at: number }>();
  const writeTimers = new Map<string, unknown>();

  const narration = (deps.narration ?? (() => NO_NARRATION))({
    repoRoot: deps.repoRoot,
    db: deps.db,
    now: () => deps.now(),
    schedule: deps.schedule,
    log: (event) => deps.log(event),
    refresh: () => {
      if (!disposed && built !== null && model !== null) publish(built, model);
    },
  });

  function setStatus(next: ExplainerStatus): void {
    status = next;
    deps.onStatus?.({ ...next });
  }

  /** Ruling R3: "off" when the preference is off, else the seam's state, else "unavailable". */
  function narratorState(): NarratorState {
    if (deps.explainWithModel?.() === false) return "off";
    return narration.narratorStatus?.() ?? "unavailable";
  }

  function nextScanId(): string {
    return `scan_${deps.now().toString(36)}_${(scanCount += 1)}`;
  }

  function viewOf(overview: BuiltOverview, repo: RepoModel): OverviewView {
    return {
      repoRoot: deps.repoRoot,
      drafts: overview.drafts,
      roleGuess: overview.roleGuess,
      edges: overview.edges,
      externals: overview.externals,
      manifest: repo.manifest,
      exportsOf: (componentId) => overview.exportsByComponent.get(componentId) ?? [],
    };
  }

  function loadStored(): void {
    if (content !== null) return;
    try {
      const stored = deps.db.getOverviewState(deps.repoRoot);
      if (stored !== undefined) {
        content = { snapshot: stored.snapshot, key: snapshotKey(stored.snapshot) };
        latest ??= content;
      }
    } catch (error) {
      deps.log({ kind: "error", where: "state", message: messageOf(error) });
    }
  }

  function persist(snapshot: OverviewSnapshot): void {
    try {
      const previous = deps.db.getOverviewState(deps.repoRoot);
      // Lane 05 owns narrativeInputsHash and the stored narrative; a rule-only snapshot
      // (narrator off) must not erase them.
      deps.db.putOverviewState(deps.repoRoot, {
        snapshot,
        narrativeInputsHash: previous?.narrativeInputsHash ?? null,
        narrative: snapshot.narrative ?? previous?.narrative ?? null,
      });
    } catch (error) {
      deps.log({ kind: "error", where: "state", message: messageOf(error) });
    }
  }

  /** The single row writer: every overview_snapshot row of this stage is appended here. */
  function writeNow(sessionId: string): void {
    if (disposed || latest === null) return;
    const last = written.get(sessionId);
    if (last !== undefined && last.key === latest.key) return;
    try {
      const row = deps.db.appendEvent(sessionId, "overview_snapshot", { ...latest.snapshot, sessionId });
      written.set(sessionId, { key: latest.key, at: deps.now() });
      deps.emitRowsAvailable(sessionId, row.seq);
    } catch (error) {
      deps.log({ kind: "error", where: "write", message: messageOf(error) });
    }
  }

  /** One row per session at start, then on change, at most every 2 s (spec §5.5). */
  function requestWrite(sessionId: string): void {
    if (disposed || latest === null) return;
    const last = written.get(sessionId);
    if (last !== undefined && last.key === latest.key) return;
    if (writeTimers.has(sessionId)) return;
    const wait = last === undefined ? 0 : Math.max(0, last.at + SNAPSHOT_WRITE_INTERVAL_MS - deps.now());
    if (wait === 0) {
      writeNow(sessionId);
      return;
    }
    writeTimers.set(
      sessionId,
      deps.schedule.setTimeout(() => {
        writeTimers.delete(sessionId);
        writeNow(sessionId);
      }, wait),
    );
  }

  function requestWriteForCurrentSession(): void {
    const sessionId = deps.sessionId();
    if (sessionId !== null) requestWrite(sessionId);
  }

  /** A snapshot with no components: the base of progress and failure rows before any scan finished. */
  function emptySnapshot(): OverviewSnapshot {
    return assembleSnapshot({
      sessionId: "",
      repoRoot: deps.repoRoot,
      scanId: nextScanId(),
      partial: false,
      drafts: [],
      edges: [],
      externals: [],
      text: new Map(),
      narrative: null,
      generatedAt: new Date(deps.now()).toISOString(),
    });
  }

  /**
   * Ruling R3: progress and failure rows carry the previous full snapshot's components (or
   * none) with a new `status.scan`. Their keys are unique per scan step, so the progress path
   * hashes nothing; the 2 s writer decides which of them reach the store.
   */
  function publishScanStatus(scan: OverviewStatus["scan"], key: string): void {
    const base = content?.snapshot ?? emptySnapshot();
    latest = {
      snapshot: {
        ...base,
        scanId: nextScanId(),
        generatedAt: new Date(deps.now()).toISOString(),
        status: { scan, narrator: narratorState() },
      },
      key,
    };
    requestWriteForCurrentSession();
  }

  function publish(overview: BuiltOverview, repo: RepoModel): void {
    const view = viewOf(overview, repo);
    const scanned = repo.files.size;
    const input = {
      sessionId: "",
      repoRoot: deps.repoRoot,
      scanId: nextScanId(),
      partial: repo.partial,
      drafts: overview.drafts,
      totalFiles: repo.partial ? repo.totalFiles : scanned,
      edges: overview.edges,
      externals: overview.externals,
      text: new Map(narration.textFor(view)),
      narrative: null,
      generatedAt: new Date(deps.now()).toISOString(),
    };
    const ruleOnly = assembleSnapshot(input);
    const narrative = narration.narrative(ruleOnly, view);
    const assembled = narrative === null ? ruleOnly : assembleSnapshot({ ...input, narrative });
    const snapshot: OverviewSnapshot = {
      ...assembled,
      status: {
        scan: { state: "done", scanned, total: input.totalFiles },
        narrator: narratorState(),
      },
    };
    const key = snapshotKey(snapshot);
    if (content === null || content.key !== key) {
      content = { snapshot, key };
      persist(snapshot);
      deps.log({
        kind: "snapshot",
        components: snapshot.components.length,
        edges: snapshot.edges.length,
        bytes: Buffer.byteLength(JSON.stringify(snapshot)),
      });
    }
    latest = content;
    narration.onSnapshot(content.snapshot, view);
    requestWriteForCurrentSession();
  }

  function rebuild(): void {
    if (disposed || model === null) return;
    try {
      built = buildOverview(model);
      publish(built, model);
    } catch (error) {
      deps.log({ kind: "error", where: "rebuild", message: messageOf(error) });
    }
  }

  function startScan(): void {
    if (disposed) return;
    scanning?.abort();
    const controller = new AbortController();
    scanning = controller;
    const scanGeneration = (generation += 1);
    const started = deps.now();
    let progress = { done: 0, total: 0 };
    setStatus({ phase: "scanning", done: 0, total: 0, error: null });
    scanPromise = scanRepoModel(
      deps.repoRoot,
      { scan: deps.scan, extract: deps.extract },
      {
        signal: controller.signal,
        onProgress: (done, total) => {
          if (disposed || scanGeneration !== generation) return;
          progress = { done, total };
          setStatus({ phase: "scanning", done, total, error: null });
          if (deps.now() - started >= SCAN_PROGRESS_AFTER_MS) {
            publishScanStatus({ state: "running", scanned: done, total }, `running:${scanGeneration}:${done}:${total}`);
          }
        },
      },
    ).then(
      (next) => {
        if (disposed || scanGeneration !== generation) return;
        scanning = null;
        model = next;
        deps.log({ kind: "scan", files: next.files.size, partial: next.partial, ms: deps.now() - started });
        setStatus({ phase: "ready", done: next.files.size, total: next.files.size, error: null });
        rebuild();
        if (dirty.size > 0) scheduleSettle();
      },
      (error: unknown) => {
        if (disposed || scanGeneration !== generation) return;
        scanning = null;
        const message = messageOf(error);
        deps.log({ kind: "error", where: "scan", message });
        setStatus({ phase: "failed", done: 0, total: 0, error: message });
        publishScanStatus(
          { state: "failed", scanned: progress.done, total: progress.total, error: clipText(message, SCAN_ERROR_MAX) },
          `failed:${scanGeneration}`,
        );
      },
    );
  }

  function applyDirty(): void {
    settleTimer = null;
    if (disposed || dirty.size === 0 || model === null || scanning !== null) return;
    const paths = [...dirty];
    dirty.clear();
    if (paths.some((path) => MANIFEST_CHANGE.test(path))) {
      startScan();
      return;
    }
    const target = model;
    const targetGeneration = generation;
    rebuildChain = rebuildChain.then(async () => {
      try {
        const changed = await applyFileChanges(deps.repoRoot, target, paths, {
          scanPaths: deps.scanPaths,
          extract: deps.extract,
        });
        if (disposed || targetGeneration !== generation || model !== target) return;
        if (changed) rebuild();
      } catch (error) {
        deps.log({ kind: "error", where: "rebuild", message: messageOf(error) });
      }
    });
  }

  function scheduleSettle(): void {
    if (settleTimer !== null) deps.schedule.clearTimeout(settleTimer);
    settleTimer = deps.schedule.setTimeout(applyDirty, FILES_SETTLE_MS);
  }

  return {
    onRepoOpened() {
      if (disposed) return;
      loadStored();
      requestWriteForCurrentSession();
      if (scanning === null) startScan();
    },
    onSessionStarted(sessionId) {
      if (disposed) return;
      loadStored();
      requestWrite(sessionId);
      if (model === null && scanning === null) startScan();
    },
    onFilesChanged(paths) {
      if (disposed) return;
      for (const path of paths) {
        if (path !== "") dirty.add(path);
      }
      if (model !== null && scanning === null && dirty.size > 0) scheduleSettle();
    },
    onPipelineSync(_sync) {
      // Lane 07 (S-2): story and highlight triggers.
    },
    rescan() {
      startScan();
    },
    status() {
      return { ...status };
    },
    async whenIdle() {
      for (;;) {
        const scan = scanPromise;
        const chain = rebuildChain;
        await Promise.allSettled([scan, chain]);
        if (scan === scanPromise && chain === rebuildChain) return;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      scanning?.abort();
      scanning = null;
      if (settleTimer !== null) deps.schedule.clearTimeout(settleTimer);
      settleTimer = null;
      for (const handle of writeTimers.values()) deps.schedule.clearTimeout(handle);
      writeTimers.clear();
      narration.dispose();
    },
  };
}

export interface ExplainerRegistry {
  repoOpened(repoRoot: string): void;
  repoClosed(repoRoot: string): void;
  sessionStarted(repoRoot: string, sessionId: string): void;
  filesChanged(repoRoot: string, paths: readonly string[]): void;
  /** Ignored unless `repoRoot` is the open repo, so a renderer cannot start a scan elsewhere. */
  rescan(repoRoot: string): void;
  get(repoRoot: string): ExplainerStage | undefined;
  dispose(): void;
}

/** One stage for the open repo; opening another repo disposes the previous stage. */
export function createExplainerRegistry(factory: (repoRoot: string) => ExplainerStage): ExplainerRegistry {
  let active: { repoRoot: string; stage: ExplainerStage } | null = null;
  const ensure = (repoRoot: string): ExplainerStage => {
    if (active !== null && active.repoRoot === repoRoot) return active.stage;
    active?.stage.dispose();
    active = { repoRoot, stage: factory(repoRoot) };
    return active.stage;
  };
  const existing = (repoRoot: string): ExplainerStage | undefined =>
    active !== null && active.repoRoot === repoRoot ? active.stage : undefined;
  return {
    repoOpened: (repoRoot) => ensure(repoRoot).onRepoOpened(),
    repoClosed(repoRoot) {
      if (active === null || active.repoRoot !== repoRoot) return;
      active.stage.dispose();
      active = null;
    },
    sessionStarted: (repoRoot, sessionId) => ensure(repoRoot).onSessionStarted(sessionId),
    filesChanged: (repoRoot, paths) => existing(repoRoot)?.onFilesChanged(paths),
    rescan: (repoRoot) => existing(repoRoot)?.rescan(),
    get: existing,
    dispose() {
      active?.stage.dispose();
      active = null;
    },
  };
}
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/main/pipeline/explainer-stage.test.ts`

Expected: PASS, `Tests  22 passed (22)`.

- [ ] **Step 6: Write the failing runtime hook tests**

Append to `apps/desktop/src/main/pipeline/pipeline-runtime.test.ts`:

```ts
describe("PipelineRuntime repo file hook (console-explainer M-6)", () => {
  async function startWithHook(name: string, hook: (repoPath: string, paths: readonly string[]) => void) {
    const dir = path.join(repoRoot, `apps/desktop/.test-tmp/${name}`);
    rmSync(dir, { recursive: true, force: true });
    const db = createTempDb(dir);
    const sessionId = `sess-${name}`;
    const repoId = `repo-${name}`;
    db.upsertRepository({ id: repoId, path: dir, gitRoot: dir, branch: "test", baseCommit: "test" });
    db.createSession({ id: sessionId, repoId, prompt: "demo" });
    const runtime = new PipelineRuntime({
      db,
      emit: collectEmit().emit,
      evidence: false,
      jevClient: new DegradeClient(),
      log: () => {},
      onRepoFilesChanged: hook,
    });
    await runtime.startSession({ sessionId, repoId, repoPath: dir, prompt: "demo", agentMode: "replay" });
    const ts = "2026-10-02T10:00:00.000Z";
    runtime.ingestRecord(sessionId, { type: "file_changed", repoId, sessionId, path: "src/a.ts", kind: "modified", ts });
    runtime.ingestRecord(sessionId, {
      type: "git_hunk",
      repoId,
      sessionId,
      file: "src/b.ts",
      added: 1,
      removed: 0,
      isFormattingOnly: false,
      isConfigOnly: false,
      isLockfile: false,
      ts,
    });
    return { db, runtime, sessionId, dir };
  }

  it("forwards file_changed facts with the session's repo path", async () => {
    const calls: [string, string[]][] = [];
    const { db, runtime, sessionId, dir } = await startWithHook("explainer-hook", (repoPath, paths) => {
      calls.push([repoPath, [...paths]]);
    });
    try {
      expect(calls).toEqual([[dir, ["src/a.ts"]]]);
    } finally {
      await runtime.stopSession(sessionId);
      db.close();
    }
  });

  it("keeps ingesting when the hook throws", async () => {
    const { db, runtime, sessionId } = await startWithHook("explainer-hook-throws", () => {
      throw new Error("boom");
    });
    try {
      expect(db.listEvents(sessionId).filter((event) => event.type === "evidence_fact")).toHaveLength(2);
      expect(runtime.getIngestFailures(sessionId)).toBe(0);
    } finally {
      await runtime.stopSession(sessionId);
      db.close();
    }
  });
});
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/main/pipeline/pipeline-runtime.test.ts -t "repo file hook"`

Expected: FAIL. The first test receives `[]` (no hook is called); the second passes already (it pins the isolation once the hook exists).

- [ ] **Step 7: Add the runtime hook**

In `apps/desktop/src/main/pipeline/types.ts`, find:

```ts
  log?: (message: string) => void;
  modelSelector?: ModelSelector;
}
```

Replace it with:

```ts
  log?: (message: string) => void;
  modelSelector?: ModelSelector;
  /**
   * Repo files the watcher saw change (file_changed facts), for the explainer stage's
   * incremental rebuild (console-explainer spec §5.1). Errors are logged, never thrown.
   */
  onRepoFilesChanged?: (repoPath: string, paths: readonly string[]) => void;
}
```

In `apps/desktop/src/main/pipeline/pipeline-runtime.ts`, find:

```ts
      session.facts.push(fact);
      session.coordinator.ingest(fact);
      this.scheduleSync(session);
      return;
    }
```

Replace it with:

```ts
      session.facts.push(fact);
      session.coordinator.ingest(fact);
      if (fact.type === "file_changed") this.notifyRepoFilesChanged(session, fact.path);
      this.scheduleSync(session);
      return;
    }
```

Find the end of the class:

```ts
  private log(message: string): void {
    this.opts.log?.(message);
  }
}
```

Replace it with:

```ts
  private log(message: string): void {
    this.opts.log?.(message);
  }

  /** Forwards a repo file change to the explainer stage; its failures never reach ingestion. */
  private notifyRepoFilesChanged(session: ActiveSession, filePath: string): void {
    const hook = this.opts.onRepoFilesChanged;
    if (hook === undefined) return;
    try {
      hook(session.repoPath, [filePath]);
    } catch (error) {
      this.log(`session ${session.sessionId}: explainer file hook failed: ${String(error)}`);
    }
  }
}
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/main/pipeline/pipeline-runtime.test.ts -t "repo file hook"`

Expected: PASS, 2 tests.

- [ ] **Step 8: Write the failing IPC wiring tests**

In `apps/desktop/src/main/ipc.test.ts`, find:

```ts
import { registerIpcHandlers } from "./ipc.js";
import type { IpcDeps } from "./ipc.js";
```

Replace it with:

```ts
import { registerIpcHandlers } from "./ipc.js";
import type { IpcDeps } from "./ipc.js";
import type { ExplainerRegistry } from "./pipeline/explainer-stage.js";
```

Append to the end of the file:

```ts
describe("explainer wiring (console-explainer M-6)", () => {
  function explainerSpy(): { registry: ExplainerRegistry; calls: string[] } {
    const calls: string[] = [];
    const registry: ExplainerRegistry = {
      repoOpened: (repoRoot) => void calls.push(`open ${repoRoot}`),
      repoClosed: (repoRoot) => void calls.push(`close ${repoRoot}`),
      sessionStarted: (repoRoot, sessionId) => void calls.push(`session ${repoRoot} ${sessionId}`),
      filesChanged: () => {},
      rescan: (repoRoot) => void calls.push(`rescan ${repoRoot}`),
      get: () => undefined,
      dispose: () => {},
    };
    return { registry, calls };
  }

  it("repo:close closes the open repo's explainer stage", async () => {
    const { db, state } = seedRepoAndSession();
    const { runtime } = stubRuntime();
    const { registry, calls } = explainerSpy();
    const handlers = registerAndCapture({ ...makeDeps(db, runtime, state), explainer: registry });
    await handlers.get(RendererToMainChannels.repoClose)!(TRUSTED_EVENT, { repoId: "repo_a" });
    expect(calls).toEqual(["close /a"]);
    db.close();
  });

  it("session:start tells the explainer which session started in which repo", async () => {
    const { db, state } = seedRepoAndSession();
    state.info = { gitRoot: "/a", branch: "main", baseCommit: "abc" };
    const { runtime } = stubRuntime();
    const { registry, calls } = explainerSpy();
    const handlers = registerAndCapture({ ...makeDeps(db, runtime, state), explainer: registry });
    await handlers.get(RendererToMainChannels.sessionStart)!(TRUSTED_EVENT, { repoId: "repo_a", prompt: "go" });
    expect(calls).toEqual(["session /a sess_a"]);
    db.close();
  });

  it("overview:rescan forwards the root from the main window and is denied to trace windows", async () => {
    const { db, state } = seedRepoAndSession();
    const { runtime } = stubRuntime();
    const main = explainerSpy();
    const mainHandlers = registerAndCapture({ ...makeDeps(db, runtime, state), explainer: main.registry });
    await mainHandlers.get(RendererToMainChannels.overviewRescan)!(TRUSTED_EVENT, { repoRoot: "/a" });
    expect(main.calls).toEqual(["rescan /a"]);

    const trace = explainerSpy();
    const traceHandlers = registerAndCapture({ ...makeDeps(db, runtime, state, () => "trace"), explainer: trace.registry });
    await expect(
      traceHandlers.get(RendererToMainChannels.overviewRescan)!(TRUSTED_EVENT, { repoRoot: "/a" }),
    ).rejects.toMatchObject({ code: "UNTRUSTED_SENDER" });
    expect(trace.calls).toEqual([]);
    db.close();
  });
});
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/main/ipc.test.ts -t "explainer wiring"`

Expected: FAIL. `repo:close` and `session:start` record no calls; `handlers.get(…overviewRescan)` is undefined (`TypeError: … is not a function`).

- [ ] **Step 9: Wire the registry into `ipc.ts`**

In `apps/desktop/src/main/ipc.ts`, find:

```ts
import { openRepoByPath } from "./repo-service.js";
```

Replace it with:

```ts
import { openRepoByPath } from "./repo-service.js";
import type { ExplainerRegistry } from "./pipeline/explainer-stage.js";
```

Find:

```ts
  /** trace:open and trace:requestChanges (trace-window-ipc.ts). */
  traceWindows: TraceWindowIpcDeps;
}
```

Replace it with:

```ts
  /** trace:open and trace:requestChanges (trace-window-ipc.ts). */
  traceWindows: TraceWindowIpcDeps;
  /** The codebase-map explainer stage for the open repo (console-explainer spec §6). */
  explainer?: ExplainerRegistry;
}
```

Find (in the `repoBrowse` handler):

```ts
    const { repo, session, info } = await openRepoByPath(deps.db, requestedPath);
    deps.state.repo = repo;
    deps.state.info = info;
    deps.state.session = session;
```

Replace it with:

```ts
    const { repo, session, info } = await openRepoByPath(deps.db, requestedPath);
    deps.state.repo = repo;
    deps.state.info = info;
    deps.state.session = session;
    deps.explainer?.repoOpened(repo.gitRoot);
```

Find (in the `repoOpen` handler):

```ts
    const { repo, session, info } = await openRepoByPath(deps.db, path);
    deps.state.repo = repo;
    deps.state.info = info;
    deps.state.session = session;
```

Replace it with:

```ts
    const { repo, session, info } = await openRepoByPath(deps.db, path);
    deps.state.repo = repo;
    deps.state.info = info;
    deps.state.session = session;
    deps.explainer?.repoOpened(repo.gitRoot);
```

Find (in the `repoClose` handler):

```ts
      await deps.runtime.stopSession(activeSessionId);
    }
    deps.state.repo = null;
```

Replace it with:

```ts
      await deps.runtime.stopSession(activeSessionId);
    }
    if (deps.state.repo) deps.explainer?.repoClosed(deps.state.repo.gitRoot);
    deps.state.repo = null;
```

Find (in the `sessionStart` handler):

```ts
      approvalMode,
    });
    deps.state.session = deps.db.getSession(active.id) ?? null;
```

Replace it with:

```ts
      approvalMode,
    });
    deps.explainer?.sessionStarted(info.gitRoot, active.id);
    deps.state.session = deps.db.getSession(active.id) ?? null;
```

Find:

```ts
  handle(RendererToMainLocalChannels.repoListRecent, ({ limit }) => {
```

Replace it with:

```ts
  // overview:rescan (spec §6.6 Retry). The registry ignores every root but the open repo's,
  // so a renderer cannot start a scan of another directory.
  handle(RendererToMainChannels.overviewRescan, ({ repoRoot }) => {
    deps.explainer?.rescan(repoRoot);
    return null;
  });

  handle(RendererToMainLocalChannels.repoListRecent, ({ limit }) => {
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/main/ipc.test.ts src/main/trace-allowlist.test.ts`

Expected: PASS; the three new tests and every existing IPC and allowlist test pass (`overview:rescan` is not in `TRACE_WINDOW_CHANNELS`, so trace windows are denied by the existing rule).

- [ ] **Step 10: Wire the stage into the app (`index.ts`)**

In `apps/desktop/src/main/index.ts`, find:

```ts
import { openDb, openTraceReader } from "@jevcode/storage";
```

Replace it with:

```ts
import { scanPaths, scanRepo } from "@jevcode/codebase-map/node";
import { createImportExtractor, type ImportExtractor } from "@jevcode/evidence-engine";
import { openDb, openTraceReader } from "@jevcode/storage";
```

Find:

```ts
import { InstructionRouter } from "./pipeline/instruction-router.js";
```

Replace it with:

```ts
import { EXPLAIN_WITH_MODEL_PREF_KEY, normalizeExplainWithModel } from "../shared/prefs.js";
import { createExplainerRegistry, createExplainerStage, type ExplainerRegistry } from "./pipeline/explainer-stage.js";
import { InstructionRouter } from "./pipeline/instruction-router.js";
```

Find:

```ts
let runtime: PipelineRuntime | null = null;
```

Replace it with:

```ts
let runtime: PipelineRuntime | null = null;
let explainer: ExplainerRegistry | null = null;
let importExtractor: ImportExtractor | null = null;
```

Find:

```ts
  runtime = new PipelineRuntime({
    db,
    emit: sendToRenderer,
    terminal: terminalSink,
    log: (message) => console.log(`[pipeline] ${message}`),
  });
```

Replace it with:

```ts
  // Console-explainer spec §6: one explainer stage for the open repo. Import extraction runs in
  // its own worker pool, which stops after 30 s idle, so scans never queue behind evidence parses.
  const eventsDb = db;
  const extractor = createImportExtractor();
  importExtractor = extractor;
  const explainerRegistry = createExplainerRegistry((repoRoot) =>
    createExplainerStage({
      db: eventsDb,
      repoRoot,
      sessionId: () => (state.repo?.gitRoot === repoRoot ? (state.session?.id ?? null) : null),
      scan: scanRepo,
      scanPaths,
      extract: extractor.extract,
      // Lane 03 D-6 Step 1 replaces this direct send with a no-op: D-1's observeTraceAppends already
      // hints every committed trace row through the coalesced emitter, which also reaches trace windows.
      emitRowsAvailable: (sessionId, lastSeq) =>
        sendToRenderer(MainToRendererChannels.traceRowsAvailable, { sessionId, lastSeq }),
      now: () => Date.now(),
      schedule: {
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      log: (event) => console.log(`[explainer] ${JSON.stringify(event)}`),
      // Ruling R3: narrator status "off" when the setting is off. Lane 05 N-5 adds `narration`.
      explainWithModel: () => normalizeExplainWithModel(eventsDb.getPreference(EXPLAIN_WITH_MODEL_PREF_KEY)),
    }),
  );
  explainer = explainerRegistry;

  runtime = new PipelineRuntime({
    db,
    emit: sendToRenderer,
    terminal: terminalSink,
    log: (message) => console.log(`[pipeline] ${message}`),
    onRepoFilesChanged: (repoPath, paths) => explainerRegistry.filesChanged(repoPath, paths),
  });
```

Find:

```ts
    requestRepoPath: () => openDirectoryDialog(mainWindow),
```

Replace it with:

```ts
    requestRepoPath: () => openDirectoryDialog(mainWindow),
    explainer: explainerRegistry,
```

Find:

```ts
app.on("window-all-closed", () => {
```

Replace it with:

```ts
app.on("will-quit", () => {
  explainer?.dispose();
  void importExtractor?.dispose();
});

app.on("window-all-closed", () => {
```

- [ ] **Step 11: Checks**

Run, in order:

```bash
perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop typecheck
perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/main/pipeline/explainer-overview.test.ts src/main/pipeline/explainer-stage.test.ts src/main/ipc.test.ts
(perl -e 'alarm 590; exec @ARGV' pnpm --filter jevcode-desktop test > .superpowers/desktop-suite.log 2>&1; echo "EXIT=$?" >> .superpowers/desktop-suite.log) &   # poll `tail -6 .superpowers/desktop-suite.log` every 15 s until the EXIT= line appears
perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop build
perl -e 'alarm 170; exec @ARGV' pnpm lint
```

Expected: typecheck exits 0 for all three desktop tsconfigs; the targeted files pass; the full desktop suite (in the background) ends with `EXIT=0` (the known flakes in index §7 count only if the package passes alone); the build exits 0; lint prints nothing.

- [ ] **Step 12: Commit**

```bash
git add apps/desktop/package.json pnpm-lock.yaml apps/desktop/src/main/pipeline/explainer-overview.ts \
  apps/desktop/src/main/pipeline/explainer-overview.test.ts apps/desktop/src/main/pipeline/explainer-stage.ts \
  apps/desktop/src/main/pipeline/explainer-stage.test.ts apps/desktop/src/main/pipeline/types.ts \
  apps/desktop/src/main/pipeline/pipeline-runtime.ts apps/desktop/src/main/pipeline/pipeline-runtime.test.ts \
  apps/desktop/src/main/ipc.ts apps/desktop/src/main/ipc.test.ts apps/desktop/src/main/index.ts
git -c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com commit -m "feat(desktop): explainer stage writes codebase overview snapshots"
```


### Task M-7: ArchitectureDelta edge-id fix

**The mismatch.** `buildArchitectureData` (`apps/desktop/src/main/pipeline/ui-stage.ts:402`) names its nodes `file:<path>`, `sym:<symbol.id>` and `dep:<name>`, then keeps a graph edge only when `nodeIds.has(edge.from) && nodeIds.has(edge.to)`. `ctx.graphEdges` come from `projectGraph` (`packages/semantic-core/src/graph.ts`), whose ids are hashes: `hashId("file", sessionId, path)` = `file_21f275da5646ed5c`, `hashId("sym", sessionId, name)`, `hashId("dep", sessionId, name[@version])`. No graph id ever equals a surface id, so every ArchitectureDelta surface ships `edges: []` and React Flow draws none. A probe on a unit with `src/a.ts` importing `./b` shows the graph edge `file_21f275da5646ed5c → file_f6fd1ef254fbb907` (DEPENDS_ON) and an empty `props.edges`. The ui-catalog component itself draws edges whose endpoints exist (its `p1.test.tsx` case draws four); it also passes dangling edges to React Flow, which drops them silently while `data-edge-count` still counts them.

**Files:**
- Modify: `apps/desktop/src/main/pipeline/ui-stage.ts` (`buildArchitectureData`, new helper `architectureIdsByGraphId`)
- Create: `apps/desktop/src/main/pipeline/ui-stage.test.ts`
- Modify: `packages/ui-catalog/src/components/ArchitectureDelta.tsx` (drop dangling and self edges)
- Test: `packages/ui-catalog/src/components/p1.test.tsx` (append one case)

**Interfaces:**
- Consumes: `compileChangeUnitSurface(unit, intent, ctx)`, `UiStageContext` (`ui-stage.ts`), `PipelineCoordinator` (`@jevcode/semantic-core`), `GraphNode { id; type; label; data? }`.
- Produces: no new exports. ArchitectureDelta props now carry the unit's file-to-file, symbol and dependency edges, deduplicated by (from, to, type), at most 50.

- [ ] **Step 1: Write the failing producer regression test**

Create `apps/desktop/src/main/pipeline/ui-stage.test.ts`:

```ts
import type { EvidenceFact, UIIntent } from "@jevcode/contracts";
import { PipelineCoordinator } from "@jevcode/semantic-core";
import { describe, expect, it } from "vitest";

import { compileChangeUnitSurface, type UiStageContext } from "./ui-stage.js";

const SESSION = "sess_arch";
const REPO = "repo_arch";
const TS = "2026-10-02T10:00:00.000Z";

const hunk = (file: string): EvidenceFact => ({
  type: "git_hunk",
  repoId: REPO,
  sessionId: SESSION,
  file,
  added: 5,
  removed: 1,
  isFormattingOnly: false,
  isConfigOnly: false,
  isLockfile: false,
  ts: TS,
});

const DIAGRAM: UIIntent = {
  attention: "surface",
  subject: "architecture",
  representation: "diagram",
  density: "normal",
  confidence: 0.9,
  showEvidence: true,
  showCode: false,
  secondaryViews: [],
  renderMode: "autonomous",
};

describe("ArchitectureDelta edges (console-explainer M-7)", () => {
  it("keeps the import edge between two files of a change unit", () => {
    const coordinator = new PipelineCoordinator();
    coordinator.ingest(hunk("src/a.ts"));
    coordinator.ingest(hunk("src/b.ts"));
    coordinator.ingest({
      type: "symbol_delta",
      repoId: REPO,
      sessionId: SESSION,
      path: "src/a.ts",
      ts: TS,
      added: [
        { name: "b", kind: "import", signature: 'import { b } from "./b";', startLine: 1, endLine: 1 },
        { name: "run", kind: "function", signature: "function run()", startLine: 3, endLine: 5 },
      ],
      removed: [],
      modified: [],
    });
    coordinator.ingest({
      type: "symbol_delta",
      repoId: REPO,
      sessionId: SESSION,
      path: "src/b.ts",
      ts: TS,
      added: [{ name: "b", kind: "function", signature: "export function b()", startLine: 1, endLine: 2 }],
      removed: [],
      modified: [],
    });
    coordinator.flush();
    const snapshot = coordinator.snapshot();
    const unit = snapshot.units.find((u) => u.files.includes("src/a.ts") && u.files.includes("src/b.ts"));
    expect(unit).toBeDefined();
    // Precondition: the semantic graph holds the dependency under its own hashed ids.
    expect(
      snapshot.graphEdges.some((e) => e.type === "DEPENDS_ON" && e.from.startsWith("file_") && e.to.startsWith("file_")),
    ).toBe(true);

    const ctx: UiStageContext = {
      sessionId: SESSION,
      facts: [],
      validations: snapshot.validations,
      failures: snapshot.failures,
      decisions: snapshot.decisions,
      semanticEvents: snapshot.events,
      graphNodes: snapshot.graphNodes,
      graphEdges: snapshot.graphEdges,
      agentEvents: [],
      units: snapshot.units,
    };
    const spec = compileChangeUnitSurface(unit!, DIAGRAM, ctx);
    const element = Object.values(spec.elements).find((entry) => entry.type === "ArchitectureDelta");
    const props = element?.props as { nodes: { id: string }[]; edges: { from: string; to: string; label?: string }[] };
    expect(props.edges).toEqual([{ from: "file:src/a.ts", to: "file:src/b.ts", label: "DEPENDS_ON" }]);
    const ids = new Set(props.nodes.map((node) => node.id));
    for (const edge of props.edges) {
      expect(ids.has(edge.from) && ids.has(edge.to)).toBe(true);
    }
  });
});
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/main/pipeline/ui-stage.test.ts`

Expected: FAIL. The precondition holds; `props.edges` is `[]`, not the one DEPENDS_ON edge. This is the defect.

- [ ] **Step 2: Map graph ids to surface ids**

In `apps/desktop/src/main/pipeline/ui-stage.ts`, find:

```ts
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges: ArchitectureEdge[] = [];
  for (const edge of ctx.graphEdges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    if (edges.length >= 50) break;
    edges.push({ from: edge.from, to: edge.to, label: edge.type });
  }
```

Replace it with:

```ts
  const idByGraphId = architectureIdsByGraphId(ctx.graphNodes, nodes);
  const edges: ArchitectureEdge[] = [];
  const seen = new Set<string>();
  for (const edge of ctx.graphEdges) {
    const from = idByGraphId.get(edge.from);
    const to = idByGraphId.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    const key = `${from}\u0000${to}\u0000${edge.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (edges.length >= 50) break;
    edges.push({ from, to, label: edge.type });
  }
```

Find:

```ts
function buildArchitectureData(
```

Replace it with:

```ts
/**
 * The semantic graph names nodes by hashed ids (`file_…`, `sym_…`, `dep_…`; semantic-core
 * graph.ts), while this surface names them `file:<path>`, `sym:<symbol id>` and `dep:<name>`.
 * Maps each graph node to the surface node it stands for, so graph edges survive. A symbol
 * name shared by two surface symbols is ambiguous and maps to neither.
 */
function architectureIdsByGraphId(
  graphNodes: readonly GraphNode[],
  nodes: readonly ArchitectureNode[],
): Map<string, string> {
  const surfaceIds = new Set(nodes.map((node) => node.id));
  const symbolIdsByName = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.id.startsWith("sym:")) continue;
    symbolIdsByName.set(node.label, [...(symbolIdsByName.get(node.label) ?? []), node.id]);
  }
  const byGraphId = new Map<string, string>();
  for (const graphNode of graphNodes) {
    let id: string | undefined;
    if (graphNode.type === "File") {
      const filePath = graphNode.data?.["path"];
      id = `file:${typeof filePath === "string" ? filePath : graphNode.label}`;
    } else if (graphNode.type === "Symbol") {
      const candidates = symbolIdsByName.get(graphNode.label) ?? [];
      id = candidates.length === 1 ? candidates[0] : undefined;
    } else if (graphNode.type === "Dependency") {
      const at = graphNode.label.lastIndexOf("@");
      id = `dep:${at > 0 ? graphNode.label.slice(0, at) : graphNode.label}`;
    }
    if (id !== undefined && surfaceIds.has(id)) byGraphId.set(graphNode.id, id);
  }
  return byGraphId;
}

function buildArchitectureData(
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter jevcode-desktop exec vitest run src/main/pipeline/ui-stage.test.ts src/main/pipeline/demo-e2e.test.ts`

Expected: PASS; the demo end-to-end test (which asserts an ArchitectureDelta surface) still passes.

- [ ] **Step 3: Write the failing ui-catalog guard test**

In `packages/ui-catalog/src/components/p1.test.tsx`, find:

```tsx
  it("shows node labels and paths", async () => {
```

Replace it with:

```tsx
  it("draws and counts only edges whose endpoints are nodes", async () => {
    const dangling: ArchitectureDeltaProps = {
      ...props,
      edges: [...props.edges, { from: "n-client", to: "n-missing" }, { from: "n-app", to: "n-app" }],
    };
    const { container } = render(
      <JSONUIProvider registry={registry} handlers={{}}>
        <ArchitectureDelta props={dangling} />
      </JSONUIProvider>,
    );
    await waitFor(() => {
      expect(container.querySelectorAll("svg").length).toBeGreaterThan(0);
    });
    expect(screen.getByTestId("arch-graph").getAttribute("data-edge-count")).toBe("4");
    expect(container.querySelectorAll('[aria-label^="edge "]')).toHaveLength(4);
  });

  it("shows node labels and paths", async () => {
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/ui-catalog exec vitest run src/components/p1.test.tsx -t "ArchitectureDelta"`

Expected: FAIL: `data-edge-count` is `"6"`, not `"4"`.

- [ ] **Step 4: Drop dangling edges in the component**

In `packages/ui-catalog/src/components/ArchitectureDelta.tsx`, find:

```tsx
    const edges: Edge[] = props.edges.map((edge, index) => ({
```

Replace it with:

```tsx
    // React Flow silently skips an edge whose endpoint is not a node; drop it here so the
    // count below matches what is drawn.
    const nodeIds = new Set(positioned.map((node) => node.id));
    const edges: Edge[] = props.edges
      .filter((edge) => edge.from !== edge.to && nodeIds.has(edge.from) && nodeIds.has(edge.to))
      .map((edge, index) => ({
```

Run: `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/ui-catalog exec vitest run src/components/p1.test.tsx`

Expected: PASS for every case in the file.

- [ ] **Step 5: Checks**

Run `perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/ui-catalog typecheck`, `perl -e 'alarm 150; exec @ARGV' pnpm --filter @jevcode/ui-catalog test`, `perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop typecheck` and `perl -e 'alarm 170; exec @ARGV' pnpm lint`.

Expected: exit 0 and lint prints nothing.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/pipeline/ui-stage.ts apps/desktop/src/main/pipeline/ui-stage.test.ts \
  packages/ui-catalog/src/components/ArchitectureDelta.tsx packages/ui-catalog/src/components/p1.test.tsx
git -c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com commit -m "fix(desktop): map semantic graph ids so ArchitectureDelta draws its edges"
```


### Task M-8: Scan bench and ingest soak guard

**Files:**
- Create: `apps/desktop/src/main/pipeline/explainer-overview.bench.ts`
- Modify: `scripts/soak.mjs` (explainer switch, optional yield)
- Modify: `docs/perf.md` (append a section with the measured results)

**Interfaces:**
- Consumes: M-6 `scanRepoModel`, `buildOverview`, `createExplainerStage` (from `apps/desktop/dist`); M-4 `createImportExtractor`; M-5 `scanRepo`, `scanPaths`; M-3 `assembleSnapshot`.
- Produces: no code interfaces. Environment switches for `scripts/soak.mjs`: `JEVCODE_SOAK_EXPLAINER=1` (run the stage beside the pipeline on a generated repo, narrator off), `JEVCODE_SOAK_EXPLAINER_FILES` (default 5,000), `JEVCODE_SOAK_YIELD_EVERY=N` (yield to the event loop every N records; unset keeps the loop byte-for-byte as before). The soak's JSON output gains `explainer: { files, rows, yieldEvery } | null`.

**Budgets (spec §11, reference machine Apple M3 Max):** full scan of 20,000 files ≤ 20 s; rule-based map ≤ 2 s after repo open for 5,000 files; M1b soak ratio ≤ 1.10 with the explainer stage on. The soak's ingest loop is synchronous, so guard A (the spec's M1b ratio against the W0 base) measures the stage's cost on the ingest path; guard B runs the same build with yields so a 20,000-file scan really competes with ingestion ("ingestion unaffected", spec §11 row 4).

- [ ] **Step 1: Write the bench**

Create `apps/desktop/src/main/pipeline/explainer-overview.bench.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assembleSnapshot } from "@jevcode/codebase-map";
import { scanRepo } from "@jevcode/codebase-map/node";
import { createImportExtractor } from "@jevcode/evidence-engine";
import { afterAll, bench, describe } from "vitest";

import { buildOverview, scanRepoModel } from "./explainer-overview.js";

// Spec §11 on the reference machine: a full scan of 20,000 files takes <= 20 s, and the
// rule-based map of a 5,000-file repo is ready <= 2 s after repo open. Each iteration starts a
// new worker pool, so worker start-up and grammar loading are inside the timing. Read the
// "mean" column (ms). Not part of `vitest run`.

const pad = (value: number, width: number): string => String(value).padStart(width, "0");

/** `files / 1000` workspace packages of 10 modules x 100 files, each file ~1 KB of real imports. */
function makeSyntheticRepo(fileCount: number): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "jevcode-map-bench-"));
  const packages = Math.max(1, Math.round(fileCount / 1_000));
  const write = (rel: string, text: string): void => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };
  write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  write("package.json", '{"name":"bench-root","private":true}');
  for (let pkg = 0; pkg < packages; pkg += 1) {
    const dir = `packages/pkg-${pad(pkg, 2)}`;
    write(`${dir}/package.json`, `{"name":"@bench/pkg-${pad(pkg, 2)}","main":"src/index.ts"}`);
    write(`${dir}/src/index.ts`, 'export const entry = { name: "entry" };\n');
    for (let mod = 0; mod < 10; mod += 1) {
      for (let index = 0; index < 100; index += 1) {
        const next = (index + 1) % 100;
        const lines = [
          'import { z } from "zod";',
          `import { helper${next} } from "./file-${pad(next, 3)}.js";`,
          `import { entry } from "@bench/pkg-${pad((pkg + 1) % packages, 2)}";`,
          "",
          `export const helper${index} = { name: "p${pkg}m${mod}f${index}" };`,
        ];
        for (let k = 0; k < 8; k += 1) {
          lines.push(
            `export function run${index}_${k}(input: string): string {`,
            `  const schema = z.string().min(${k});`,
            `  return schema.parse(input) + helper${next}.name + entry.name;`,
            "}",
          );
        }
        write(`${dir}/src/mod-${pad(mod, 2)}/file-${pad(index, 3)}.ts`, `${lines.join("\n")}\n`);
      }
    }
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

const REPO_5K = makeSyntheticRepo(5_000);
const REPO_20K = makeSyntheticRepo(20_000);

afterAll(() => {
  rmSync(REPO_5K, { recursive: true, force: true });
  rmSync(REPO_20K, { recursive: true, force: true });
});

async function mapRepo(repoRoot: string): Promise<void> {
  const extractor = createImportExtractor();
  try {
    const model = await scanRepoModel(repoRoot, { scan: scanRepo, extract: extractor.extract });
    const built = buildOverview(model);
    assembleSnapshot({
      sessionId: "bench",
      repoRoot,
      scanId: "bench",
      partial: model.partial,
      drafts: built.drafts,
      edges: built.edges,
      externals: built.externals,
      text: new Map(),
      narrative: null,
      generatedAt: "2026-10-02T00:00:00.000Z",
    });
  } finally {
    await extractor.dispose();
  }
}

describe("codebase map (spec §11)", () => {
  bench("rule-based map, 5,000 files (budget 2,000 ms)", () => mapRepo(REPO_5K), {
    iterations: 5,
    warmupIterations: 1,
    time: 0,
    warmupTime: 0,
  });
  bench("full scan and map, 20,000 files (budget 20,000 ms)", () => mapRepo(REPO_20K), {
    iterations: 3,
    warmupIterations: 0,
    time: 0,
    warmupTime: 0,
  });
});
```

- [ ] **Step 2: Run the bench in the background**

```bash
perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/codebase-map build && perl -e 'alarm 170; exec @ARGV' pnpm --filter @jevcode/evidence-engine build
mkdir -p .superpowers/ce-04 && uptime > .superpowers/ce-04/bench-load.txt
perl -e 'alarm 900; exec @ARGV' pnpm --filter jevcode-desktop exec vitest bench --run src/main/pipeline/explainer-overview.bench.ts > .superpowers/ce-04/bench.log 2>&1
```

Run the last command in the background (Bash `run_in_background`, timeout 900000 ms) and wait for it to exit.

Expected: `.superpowers/ce-04/bench.log` shows both rows. On the reference machine the 5,000-file mean is ≤ 2,000 ms and the 20,000-file mean is ≤ 20,000 ms. If either misses, profile before changing budgets: `node --cpu-prof` on a script that calls `mapRepo` once; the expected hot spots are tree-sitter parsing (in workers) and `readFile` (I/O). Raise `createImportExtractor`'s default pool size only if CPU-bound parsing dominates, and rerun guard B after any change.

- [ ] **Step 3: Add the explainer switch to the soak**

In `scripts/soak.mjs`, find:

```js
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
```

Replace it with:

```js
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
```

Find:

```js
import { createTraceService, readAllRows } from "../apps/desktop/dist/main/trace-service.js";
```

Replace it with:

```js
import { createTraceService, readAllRows } from "../apps/desktop/dist/main/trace-service.js";
import { createExplainerStage } from "../apps/desktop/dist/main/pipeline/explainer-stage.js";
import { scanPaths, scanRepo } from "../packages/codebase-map/dist/node/index.js";
import { createImportExtractor } from "../packages/evidence-engine/dist/index.js";
```

Find:

```js
const REPO_ID = "repo-soak";
```

Replace it with:

```js
const REPO_ID = "repo-soak";
// Console-explainer M-8 (spec §11 ingest guard). JEVCODE_SOAK_EXPLAINER=1 runs the explainer
// stage beside the pipeline on a generated repo (narrator off) and forwards file_changed facts
// to it. JEVCODE_SOAK_YIELD_EVERY=N yields to the event loop every N records, so a background
// scan competes with ingestion; unset, the ingest loop is unchanged.
const EXPLAINER = process.env["JEVCODE_SOAK_EXPLAINER"] === "1";
const EXPLAINER_FILES = Number(process.env["JEVCODE_SOAK_EXPLAINER_FILES"] ?? 5_000);
const YIELD_EVERY = Number(process.env["JEVCODE_SOAK_YIELD_EVERY"] ?? 0);

/** `fileCount` small TS files in modules of 100 under src/, in a fresh `git init` directory. */
function makeExplainerRepo(fileCount) {
  const root = mkdtempSync(path.join(tmpdir(), "jevcode-soak-map-"));
  for (let index = 0; index < fileCount; index += 1) {
    const dir = path.join(root, "src", `mod-${String(Math.floor(index / 100)).padStart(3, "0")}`);
    mkdirSync(dir, { recursive: true });
    const next = String((index + 1) % 100).padStart(3, "0");
    writeFileSync(
      path.join(dir, `file-${String(index % 100).padStart(3, "0")}.ts`),
      `import { z } from "zod";\nimport { value } from "./file-${next}.js";\nexport const v${index} = z.string().parse(value);\n`,
    );
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}
```

Find:

```js
  const runtime = new PipelineRuntime({
```

Replace it with:

```js
  let explainer = null;
  let extractor = null;
  let explainerRepo = null;
  let explainerRows = 0;
  if (EXPLAINER) {
    explainerRepo = makeExplainerRepo(EXPLAINER_FILES);
    extractor = createImportExtractor();
  }

  const runtime = new PipelineRuntime({
```

Find:

```js
    agentMode: "replay",
    jevClient: new DegradeClient(),
    evidence: false,
    log: () => {},
  });
```

Replace it with:

```js
    agentMode: "replay",
    jevClient: new DegradeClient(),
    evidence: false,
    log: () => {},
    onRepoFilesChanged: EXPLAINER ? (_repoPath, paths) => explainer?.onFilesChanged(paths) : undefined,
  });
```

Find:

```js
    prompt: "Soak task: touch everything.",
    agentMode: "replay",
  });
```

Replace it with:

```js
    prompt: "Soak task: touch everything.",
    agentMode: "replay",
  });

  if (EXPLAINER) {
    explainer = createExplainerStage({
      db,
      repoRoot: explainerRepo,
      sessionId: () => SESSION_ID,
      scan: scanRepo,
      scanPaths,
      extract: extractor.extract,
      emitRowsAvailable: () => {
        explainerRows += 1;
      },
      now: () => Date.now(),
      schedule: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (handle) => clearTimeout(handle) },
      log: () => {},
    });
    explainer.onRepoOpened();
    explainer.onSessionStarted(SESSION_ID);
  }
```

Find:

```js
  for (const record of records) {
    if (burstIndex % 400 === 0) {
```

Replace it with:

```js
  for (const record of records) {
    if (YIELD_EVERY > 0 && burstIndex > 0 && burstIndex % YIELD_EVERY === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (burstIndex % 400 === 0) {
```

Find:

```js
  const syncMs = Date.now() - syncStarted;
```

Replace it with:

```js
  const syncMs = Date.now() - syncStarted;
  if (explainer !== null) {
    await explainer.whenIdle();
    explainer.dispose();
    await extractor.dispose();
    rmSync(explainerRepo, { recursive: true, force: true });
  }
```

Find:

```js
        profile: PROFILE,
```

Replace it with:

```js
        profile: PROFILE,
        explainer: EXPLAINER ? { files: EXPLAINER_FILES, rows: explainerRows, yieldEvery: YIELD_EVERY } : null,
```

- [ ] **Step 4: Smoke the switch**

```bash
perl -e 'alarm 170; exec @ARGV' pnpm -r build
JEVCODE_SOAK_EVENTS=1000 JEVCODE_SOAK_EXPLAINER=1 perl -e 'alarm 170; exec @ARGV' node scripts/soak.mjs | tail -40
```

Expected: the run ends without `SOAK_FAIL`; the JSON shows `"explainer": { "files": 5000, "rows": 1, "yieldEvery": 0 }` or more rows (one at session start, more after the soak's `file_changed` facts settle, at most one per 2 s); `JEVCODE_SOAK_EVENTS=1000 perl -e 'alarm 170; exec @ARGV' node scripts/soak.mjs | grep '"explainer"'` prints `"explainer": null`.

- [ ] **Step 5: Guard A, the spec's M1b ratio (3 + 3, alternating, background)**

Base is the W0 merge `<w0>` (index §2) in a detached worktree; head is this lane's worktree. Each full soak takes about 11 minutes; run at an idle point.

```bash
git -C ~/Projects/jevcode worktree add --detach ~/Projects/jevcode-ce-04-base <w0>
bash ~/Projects/jevcode/.superpowers/orchestration/setup-worktree.sh ~/Projects/jevcode-ce-04-base
mkdir -p ~/Projects/jevcode-ce-04/.superpowers/ce-04/soak-a
cat > ~/Projects/jevcode-ce-04/.superpowers/ce-04/soak-a.sh <<'EOF'
#!/bin/zsh
OUT=~/Projects/jevcode-ce-04/.superpowers/ce-04/soak-a
uptime > $OUT/load.txt
for i in 1 2 3; do
  (cd ~/Projects/jevcode-ce-04-base && perl -e 'alarm 1800; exec @ARGV' node scripts/soak.mjs > $OUT/base-$i.log 2>&1) || echo "base $i exited $?" >> $OUT/errors.txt
  uptime >> $OUT/load.txt
  (cd ~/Projects/jevcode-ce-04 && JEVCODE_SOAK_EXPLAINER=1 perl -e 'alarm 1800; exec @ARGV' node scripts/soak.mjs > $OUT/head-$i.log 2>&1) || echo "head $i exited $?" >> $OUT/errors.txt
  uptime >> $OUT/load.txt
done
echo CE04_SOAK_A_DONE >> $OUT/load.txt
EOF
nohup zsh ~/Projects/jevcode-ce-04/.superpowers/ce-04/soak-a.sh > /dev/null 2>&1 &
```

Wait (Monitor until `load.txt` contains `CE04_SOAK_A_DONE`, about 70 minutes), then compute the medians:

```bash
node -e 'const fs=require("fs");const d=process.argv[1];const get=(w,k)=>[1,2,3].map(i=>Number(new RegExp(`"${k}": (\\d+)`).exec(fs.readFileSync(`${d}/${w}-${i}.log`,"utf8"))[1]));const med=a=>[...a].sort((x,y)=>x-y)[1];const b=get("base","ingestMs"),h=get("head","ingestMs");console.log(JSON.stringify({base:b,head:h,baseMedian:med(b),headMedian:med(h),ratio:(med(h)/med(b)).toFixed(3)}))' ~/Projects/jevcode-ce-04/.superpowers/ce-04/soak-a
```

Expected: `ratio` ≤ `1.100`, `errors.txt` absent, and every head log shows `"explainer": { "files": 5000, "rows": ≥ 1, … }`. Remove the base worktree afterwards: `git -C ~/Projects/jevcode worktree remove ~/Projects/jevcode-ce-04-base`.

- [ ] **Step 6: Guard B, ingestion under a running 20,000-file scan (3 + 3, same build)**

```bash
mkdir -p ~/Projects/jevcode-ce-04/.superpowers/ce-04/soak-b
cat > ~/Projects/jevcode-ce-04/.superpowers/ce-04/soak-b.sh <<'EOF'
#!/bin/zsh
OUT=~/Projects/jevcode-ce-04/.superpowers/ce-04/soak-b
cd ~/Projects/jevcode-ce-04
uptime > $OUT/load.txt
for i in 1 2 3; do
  JEVCODE_SOAK_EVENTS=2000 JEVCODE_SOAK_YIELD_EVERY=10 JEVCODE_SOAK_PAUSE_EVERY=100 perl -e 'alarm 900; exec @ARGV' node scripts/soak.mjs > $OUT/base-$i.log 2>&1 || echo "base $i exited $?" >> $OUT/errors.txt
  JEVCODE_SOAK_EVENTS=2000 JEVCODE_SOAK_YIELD_EVERY=10 JEVCODE_SOAK_PAUSE_EVERY=100 JEVCODE_SOAK_EXPLAINER=1 JEVCODE_SOAK_EXPLAINER_FILES=20000 perl -e 'alarm 900; exec @ARGV' node scripts/soak.mjs > $OUT/head-$i.log 2>&1 || echo "head $i exited $?" >> $OUT/errors.txt
  uptime >> $OUT/load.txt
done
echo CE04_SOAK_B_DONE >> $OUT/load.txt
EOF
nohup zsh ~/Projects/jevcode-ce-04/.superpowers/ce-04/soak-b.sh > /dev/null 2>&1 &
```

Wait for `CE04_SOAK_B_DONE`, then run the Step 5 median command with `soak-b` in place of `soak-a`.

Expected: `ratio` ≤ `1.100`; every head log shows `explainer.duringIngest.scansDone` 1 and `snapshots` ≥ 1 (the scan finished and rebuilds ran while ingesting), and head `eventLoopDelayMs` p99 and max stay near base. A miss means the scan competes with ingestion on the main thread: profile a head run with `node --cpu-prof scripts/soak.mjs` and look for main-thread time in `scanRepo` (hashing, UTF-8 decode) or `buildOverview`; lowering `READ_CONCURRENCY` or yielding between read batches are the first levers.

- [ ] **Step 7: Record the results in `docs/perf.md`**

Append to `docs/perf.md`, replacing every `<…>` with the measured value and the date:

```markdown
## Codebase map (console-explainer lane 04, M-8)

Spec §11 budgets for the explainer stage. Bench: `pnpm --filter jevcode-desktop exec vitest bench --run src/main/pipeline/explainer-overview.bench.ts` (synthetic pnpm workspace, 1 KB TypeScript files with relative, workspace and package imports; a new worker pool per iteration). Soaks: `scripts/soak.mjs` with `JEVCODE_SOAK_EXPLAINER=1` (the stage on a generated repo, narrator off), alternating runs, `uptime` before each.

| Measure | Budget | Measured | Status | Source |
|---|---|---|---|---|
| Rule-based map visible after repo open, 5,000 files | ≤ 2 s | <mean> ms mean of 5 (min <min>, max <max>), <date>, load <load> | <PASS or FAIL> | bench, row 1 |
| Full scan and map, 20,000 files | ≤ 20 s | <mean> ms mean of 3 (min <min>, max <max>), <date> | <PASS or FAIL> | bench, row 2 |
| M1b soak ratio with the explainer on (5,000-file repo), against `<w0>` | ≤ 1.10 | base <b1>/<b2>/<b3> ms, median <bm>; head <h1>/<h2>/<h3> ms, median <hm>; ratio <ratio> | <PASS or FAIL> | guard A |
| Ingestion under a running 20,000-file scan and its rebuilds (2,000 events, yield every 10, pause every 100) | ≤ 1.10 | off <o1>/<o2>/<o3> ms, median <om>; on <n1>/<n2>/<n3> ms, median <nm>; ratio <ratio> | <PASS or FAIL> | guard B |

The rule-based map row measures scan, import extraction, componentize and snapshot assembly; the row write and push hint add under 10 ms. Guard A's ingest loop is synchronous, so it measures the stage's cost on the ingest path (the `file_changed` hook); guard B yields every 200 records so the scan's I/O, hashing and worker parsing overlap ingestion.
```

- [ ] **Step 8: Checks and commit**

Run `perl -e 'alarm 170; exec @ARGV' pnpm --filter jevcode-desktop typecheck` and `perl -e 'alarm 170; exec @ARGV' pnpm lint` (`scripts/**` is outside ESLint; `node --check scripts/soak.mjs` must exit 0).

```bash
node --check scripts/soak.mjs
git add apps/desktop/src/main/pipeline/explainer-overview.bench.ts scripts/soak.mjs docs/perf.md
git -c user.name='Jongwon Park' -c user.email=contact@parkjongwon.com commit -m "perf(desktop): bench the codebase scan and guard ingest with the explainer stage on"
```

## Lane completion

1. **Whole-lane check** on `ce/04-map` after M-8: `~/Projects/jevcode/.superpowers/orchestration/root-checks.sh ~/Projects/jevcode-ce-04` prints `ROOT_CHECKS_DONE fail=0` (the index §7 flakes count only if their package passes alone), and `git log main..HEAD --format=%B | grep -c -E "Claude-Session|Co-Authored-By"` prints `0`.
2. **Done (index §9, lane 04):** `codebase-map` property tests green (M-1, M-3); fixture repos match their expected snapshots (M-5, M-6 workspace fixture); this repo's snapshot matches its component rows (M-6 `explainer-overview.test.ts`); the stage writes snapshot rows and push hints (M-6); the scan and ingest budgets hold and are recorded in `docs/perf.md` (M-8).
3. **Merge order:** lane 04 merges first in W1 (index §2). Rebase on `main` if lane 01 or 02a changed after the worktree was cut, rerun `pnpm install --frozen-lockfile && perl -e 'alarm 170; exec @ARGV' pnpm -r build` and the root checks.
4. **Hand-off notes for the merge PR** (copy into the lane `progress.md` and `lane-context.md`):
   - **Lane 05 (N-5):** plug narration in through `ExplainerStageDeps.narration` in `apps/desktop/src/main/index.ts`'s stage factory (ruling R4). The seam's optional `narratorStatus?()` sets `status.narrator` (the stage writes "off" first when `explainWithModel()` is false); `setNarrator?` is the target of lane 05's own `ExplainerStage.setNarrator`. The seam gives `OverviewView` (drafts with `roleGuess`, edges, externals, manifest descriptions, `exportsOf(componentId)` with up to 15 names) and `NarrationContext.refresh()`; `textFor` returns `ComponentText` from `@jevcode/codebase-map`. `ExplainerStageDeps.narrator` does not exist; keep the narrator client inside the narration factory. `overview_state.narrativeInputsHash` and the stored narrative are preserved by the stage on every snapshot change (lane 05 requirement (c)). Snapshots are assembled only in `publish` (requirement (a)), rows are appended only in `writeNow` (b), and `assembleSnapshot` applies the 512 KB bound, less 2 KB of headroom for the `status` and `sessionId` the stage stamps afterwards, after purposes and the narrative are in (d).
   - **Lane 03 (D-6 Step 1):** replace the direct `sendToRenderer(MainToRendererChannels.traceRowsAvailable, …)` in the explainer factory in `index.ts` with `emitRowsAvailable: () => {}`; `observeTraceAppends` (D-1) already hints every committed stage row through the coalesced emitter. `mainHost.rescanOverview` should invoke `overview:rescan` with the open repo's `gitRoot`; the handler ignores other roots. Lane 04 runs the import worker pool only under Node (tests, bench, soak); D-6's Electron smoke should open a repo and expect a `[explainer] {"kind":"scan"` and a `{"kind":"snapshot"` log line, which proves the pool and the row path inside Electron main.
   - **Lane 06 (P-1, P-3, P-4):** snapshot semantics are in M-3's Interfaces block. Every lane-04 row carries `status` (ruling R3): progress rows (`running`, previous components or none) arrive at most every 2 s during scans over 2 s; a `failed` row carries the previous components and a clipped error (render through `displayUntrusted`); `counts.totalFiles` gives "n of m files" for partial maps; "imports not analyzed" comes from `component.importsAnalyzed`.
   - **Lane 07 (S-2):** owns the body of `ExplainerStage.onPipelineSync`.
   - **Orchestrator:** rule on Spec gaps 1 and 2; the interface deviations at the top of this file update interfaces §3 and §5.
