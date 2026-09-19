import { writeFileSync, existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

import { reportToJson, reportToTable } from "./report.js";
import { runEval, type EvalClientKind } from "./runner.js";

const DEFAULT_FIXTURES_DIR = fileURLToPath(
  new URL("../../fixtures", import.meta.url),
);

function loadEnvFileFromRepo(): void {
  const repoRoot = fileURLToPath(new URL("../../.env", import.meta.url));
  try {
    if (existsSync(repoRoot)) loadEnvFile(repoRoot);
  } catch {
    // env loading is best-effort
  }
}

interface CliArgs {
  client: EvalClientKind;
  fixturesDir: string;
  jsonPath: string | null;
  table: boolean;
  help: boolean;
}

function usage(): string {
  return [
    "usage: node dist/cli.js [options]",
    "",
    "options:",
    "  --client <degrade|playback|typesafe>   client under test (default: degrade)",
    "  --fixtures <dir>              fixtures directory (default: repo fixtures/)",
    "  --json <path>                 write the machine-readable report to <path>",
    "  --no-table                    suppress the human-readable table",
    "  --help                        show this help",
  ].join("\n");
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    client: "degrade",
    fixturesDir: DEFAULT_FIXTURES_DIR,
    jsonPath: null,
    table: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    switch (arg) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--client": {
        const value = argv[i + 1];
        if (value !== "degrade" && value !== "playback" && value !== "typesafe") {
          throw new Error(`invalid --client value: ${value ?? "(missing)"}`);
        }
        args.client = value;
        i += 1;
        break;
      }
      case "--fixtures": {
        const value = argv[i + 1];
        if (value === undefined) throw new Error("--fixtures requires a path");
        args.fixturesDir = value;
        i += 1;
        break;
      }
      case "--json": {
        const value = argv[i + 1];
        if (value === undefined) throw new Error("--json requires a path");
        args.jsonPath = value;
        i += 1;
        break;
      }
      case "--no-table":
        args.table = false;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  loadEnvFileFromRepo();
  const report = await runEval({
    client: args.client,
    fixturesDir: args.fixturesDir,
  });
  if (args.table) {
    console.log(reportToTable(report));
  }
  if (args.jsonPath !== null) {
    writeFileSync(args.jsonPath, reportToJson(report));
  }
  process.exitCode = report.allTargetsPass ? 0 : 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`evals error: ${message}`);
  process.exitCode = 2;
});
