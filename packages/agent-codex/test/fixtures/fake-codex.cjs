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
// FAKE_CODEX_COMPLETE_ON_INTERRUPT=1: the first (non-resume) process starts a
// command and holds it open; ^C answers with turn.completed then turn.failed,
// the way a real exec reports TurnStatus::Interrupted, then exits 1.
const holdForInterrupt =
  process.env.FAKE_CODEX_COMPLETE_ON_INTERRUPT === "1" && args[1] !== "resume";

let interrupted = false;
function onInterrupt() {
  if (interrupted) return;
  interrupted = true;
  if (holdForInterrupt) {
    emit({
      type: "turn.completed",
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
    });
    emit({ type: "turn.failed", error: { message: "turn interrupted" } });
  } else {
    emit({ type: "error", message: "turn interrupted" });
  }
  process.exit(1);
}

process.on("SIGINT", onInterrupt);

emit({ type: "thread.started", thread_id: threadId });
emit({ type: "turn.started" });
if (holdForInterrupt) {
  emit({
    type: "item.started",
    item: { id: "item_cmd", type: "command_execution", command: "bash -lc pnpm test", status: "in_progress" },
  });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  if (chunk.includes("\u0003")) {
    onInterrupt();
    return;
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
  if (holdForInterrupt) return;
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

setTimeout(() => process.exit(0), holdForInterrupt ? 5000 : 900);
