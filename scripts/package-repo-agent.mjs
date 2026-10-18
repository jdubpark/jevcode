#!/usr/bin/env node
// Build a relocatable headless installation, including parser workers and WASM assets.
import { spawnSync } from "node:child_process";
import { lstat, readdir, realpath, rm, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const destination = process.argv[2] && path.resolve(process.argv[2]);
if (!destination || process.argv.length !== 3) throw new Error("Usage: node scripts/package-repo-agent.mjs OUTPUT_DIRECTORY");
if (await lstat(destination).catch(() => null)) throw new Error("The output directory must not already exist.");
for (const args of [["--filter", "@jevcode/repo-agent...", "build"], ["--filter", "@jevcode/repo-agent", "deploy", "--prod", destination]]) {
  const result = spawnSync("pnpm", args, { cwd: repository, stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error("Headless package build failed.");
}
const root = await realpath(destination);
const selfLink = path.join(root, "node_modules/.pnpm/node_modules/@jevcode/repo-agent");
// pnpm 9 can leave the package's own workspace alias pointing to the build checkout.
if ((await lstat(selfLink).catch(() => null))?.isSymbolicLink()) {
  await unlink(selfLink);
  await symlink(path.relative(path.dirname(selfLink), root), selfLink, "dir");
}
async function validate(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await realpath(file);
      const relative = path.relative(root, target);
      if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("Package contains an external symlink.");
    } else if (entry.isDirectory()) await validate(file);
  }
}
await validate(root);
// Installer metadata records the build machine's store location; runtime resolution does not use it.
await rm(path.join(root, "node_modules/.modules.yaml"), { force: true });
const check = spawnSync(process.execPath, [path.join(root, "dist/cli.js"), "--help"], { stdio: "ignore" });
if (check.error || check.status !== 0) throw new Error("Packaged CLI failed its startup check.");
process.stdout.write("Headless package built and link containment verified.\n");
