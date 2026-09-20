#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("codex-cli 0.155.1 (fake)\n");
  process.exit(0);
}

const emit = (event) => {
  process.stdout.write(JSON.stringify(event) + "\n");
};

const cwdIndex = args.indexOf("-C");
const cwd = cwdIndex >= 0 ? args[cwdIndex + 1] : process.cwd();

let model = null;
const modelIndex = args.indexOf("--model");
if (modelIndex >= 0) {
  model = args[modelIndex + 1];
}

let reasoningEffort = null;
const effortArg = args.find((arg) => arg.startsWith("model_reasoning_effort="));
if (effortArg !== undefined) {
  reasoningEffort = effortArg.slice("model_reasoning_effort=".length).replace(/^"|"$/g, "");
}

try {
  fs.writeFileSync(
    path.join(cwd, "fake-codex-args.json"),
    JSON.stringify({ argv: args, model, reasoningEffort }, null, 2),
  );
} catch {
  // best effort; the test only reads this on success paths
}

const prompt = args[args.length - 1];

process.on("SIGINT", () => {
  emit({ type: "error", message: "turn interrupted" });
  process.exit(1);
});

emit({ type: "thread.started", thread_id: "fake-thread-model-test" });
emit({ type: "turn.started" });

setTimeout(() => {
  emit({
    type: "item.completed",
    item: {
      id: "item_1",
      type: "agent_message",
      text: `fake codex ran model=${model} effort=${reasoningEffort} prompt=${prompt}`,
    },
  });
  emit({
    type: "turn.completed",
    usage: {
      input_tokens: 10,
      cached_input_tokens: 0,
      output_tokens: 5,
      reasoning_output_tokens: 0,
    },
  });
}, 200);

setTimeout(() => process.exit(0), 700);
