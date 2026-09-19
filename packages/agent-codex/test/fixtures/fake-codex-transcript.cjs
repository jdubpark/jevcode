#!/usr/bin/env node
// Emits a transcript-format codex session (non-JSON mode) for adapter tests.
const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("codex-cli 0.155.1 (fake)\n");
  process.exit(0);
}

process.on("SIGINT", () => {
  process.exit(1);
});

setTimeout(() => {
  process.stdout.write("❯ pnpm test\n");
  process.stdout.write("Running tests...\n");
  process.stdout.write("✓ 5 passed\n");
  process.stdout.write("exit code: 0\n");
  process.stdout.write("The util module now exports add() and multiply().\n");
}, 100);

setTimeout(() => process.exit(0), 500);
