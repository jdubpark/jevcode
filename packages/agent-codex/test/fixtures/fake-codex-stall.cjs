#!/usr/bin/env node
// Emits the thread header, then goes silent forever (until killed).
// Used to exercise the adapter's PTY inactivity watchdog.
const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("codex-cli 0.155.1 (fake)\n");
  process.exit(0);
}

const threadId = args[1] === "resume" ? args[2] : "stall-thread-1";

process.stdout.write(
  JSON.stringify({ type: "thread.started", thread_id: threadId }) + "\n",
);
process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\n");

process.on("SIGINT", () => process.exit(1));

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  if (chunk.includes("\u0003")) {
    process.exit(1);
  }
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim() === "") continue;
    process.stdout.write(
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "stall_echo",
          type: "agent_message",
          text: `stall echo: ${line.trim()}`,
        },
      }) + "\n",
    );
  }
});

setTimeout(() => {
  process.stdout.write(
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "stall_burst",
        type: "agent_message",
        text: "stall second burst",
      },
    }) + "\n",
  );
}, 400);

setInterval(() => {}, 1000);
