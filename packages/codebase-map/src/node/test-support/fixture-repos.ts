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
