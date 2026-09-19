import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

for (const p of [path.resolve(".env"), path.resolve("..", ".env"), path.resolve("..", "..", ".env")]) {
  try {
    if (existsSync(p)) {
      loadEnvFile(p);
      break;
    }
  } catch {
    // env loading is best-effort
  }
}

const dirname = path.dirname(fileURLToPath(import.meta.url));

const cliEntry = path.join(dirname, "../dist/main/replay/cli-entry.js");

async function main() {
  const fixtureDir = process.argv[2];
  const outDir = process.argv[3];
  if (!fixtureDir || !outDir) {
    console.error("usage: node scripts/replay.mjs <fixtureDir> <outDir>");
    process.exit(1);
  }
  let mod;
  try {
    mod = await import(cliEntry);
  } catch (error) {
    console.error(
      `replay entry not found at ${cliEntry}. Run "pnpm --filter jevcode-desktop build" first.`,
    );
    console.error(String(error));
    process.exit(1);
  }
  const code = await mod.replayMain(process.argv);
  process.exit(code);
}

void main();
