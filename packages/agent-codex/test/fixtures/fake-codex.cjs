#!/usr/bin/env node
const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("codex-cli 0.155.1 (fake)\n");
  process.exit(0);
}

const emit = (event) => {
  process.stdout.write(JSON.stringify(event) + "\n");
};

const threadId = args[1] === "resume" ? args[2] : "fake-thread-123";
const prompt = args[args.length - 1];

process.on("SIGINT", () => {
  emit({ type: "error", message: "turn interrupted" });
  process.exit(1);
});

emit({ type: "thread.started", thread_id: threadId });
emit({ type: "turn.started" });

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  if (chunk.includes("\u0003")) {
    emit({ type: "error", message: "turn interrupted" });
    process.exit(1);
  }
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim() === "") continue;
    emit({
      type: "item.completed",
      item: {
        id: "item_user",
        type: "agent_message",
        text: `echoed user input: ${line.trim()}`,
      },
    });
  }
});

setTimeout(() => {
  if (args[1] === "resume") {
    emit({
      type: "item.completed",
      item: {
        id: "item_resume",
        type: "agent_message",
        text: `resumed thread ${threadId} with prompt: ${prompt}`,
      },
    });
  }
  emit({
    type: "item.completed",
    item: {
      id: "item_1",
      type: "agent_message",
      text: "Fake codex run complete.",
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
}, 300);

setTimeout(() => process.exit(0), 900);
