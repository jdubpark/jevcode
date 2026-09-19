import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(dirname, "..");
const repoRoot = path.resolve(desktopDir, "..", "..");
const require = createRequire(import.meta.url);

function findModuleDir(name) {
  const store = path.join(repoRoot, "node_modules", ".pnpm");
  const entries = readdirSync(store).filter(
    (entry) => entry.startsWith(`${name}@`) && !entry.includes("+"),
  );
  for (const entry of entries) {
    const candidate = path.join(store, entry, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
  }
  throw new Error(`could not locate ${name} in the pnpm store`);
}

function findPrebuildCache(pattern) {
  const cache = path.join(process.env["HOME"] ?? "", ".npm", "_prebuilds");
  if (!existsSync(cache)) return null;
  for (const entry of readdirSync(cache)) {
    if (entry.includes(pattern)) return path.join(cache, entry);
  }
  return null;
}

function extractTar(tarPath, outDir) {
  mkdirSync(outDir, { recursive: true });
  execFileSync("tar", ["-xzf", tarPath, "-C", outDir], { stdio: "inherit" });
}

function verifyNodeLoadable(name, dir) {
  execFileSync(
    process.execPath,
    [
      "-e",
      `const p = require(${JSON.stringify(path.join(dir, "package.json"))}); console.log(p.name + " loads under node ok");`,
    ],
    { stdio: "inherit", cwd: desktopDir },
  );
}

const mode = process.argv[2];
if (mode === "electron") {
  execFileSync(
    "npx",
    ["electron-rebuild", "-f", "-w", "better-sqlite3,node-pty"],
    { cwd: desktopDir, stdio: "inherit" },
  );
  console.log("native modules rebuilt for Electron ABI");
} else if (mode === "node") {
  const bs3Dir = findModuleDir("better-sqlite3");
  const bs3Pkg = require(path.join(bs3Dir, "package.json"));
  const modules = process.versions.modules;
  const cachePattern = `better-sqlite3-v${bs3Pkg.version}-node-v${modules}-${process.platform}-${process.arch}`;
  const cached = findPrebuildCache(cachePattern);
  if (cached === null) {
    throw new Error(
      `no cached node prebuild for ${cachePattern}; run "npx prebuild-install --runtime=node" in ${bs3Dir} with network access`,
    );
  }
  extractTar(cached, bs3Dir);
  verifyNodeLoadable("better-sqlite3", bs3Dir);

  const ptyDir = findModuleDir("node-pty");
  const prebuild = path.join(
    ptyDir,
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "pty.node",
  );
  if (!existsSync(prebuild)) {
    throw new Error(`node-pty prebuild missing: ${prebuild}`);
  }
  execFileSync("cp", [prebuild, path.join(ptyDir, "build", "Release", "pty.node")]);
  verifyNodeLoadable("node-pty", ptyDir);
  console.log("native modules restored to node ABI");
} else {
  console.error("usage: native-abi.mjs <electron|node>");
  process.exit(1);
}
