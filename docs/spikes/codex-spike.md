# Spike T2-1: Codex CLI semantics for the Jevcode adapter

Status: complete
Date: 2026-09-19
Binary under test: `codex` 0.155.1 at `~/.local/bin/codex`
(symlink to `~/.codex/packages/standalone/current/bin/codex`)

Auth status on this machine: `codex login status` reports "Logged in using
ChatGPT" and exits 0. The workspace is out of credits, so a full turn could not
run live. Findings marked *recorded* come from real invocations on this
machine; findings marked *source* come from the codex 0.155.x Rust source
(`codex-rs/exec/`); findings marked *docs* come from the official
non-interactive-mode documentation.

All live runs used a throwaway git repo in the temp dir; nothing was run
against a real repository.

## 1. Structured output availability

`codex exec --json` (alias `--experimental-json`) prints newline-delimited JSON
events to stdout; all other output goes to stderr. Confirmed in `codex exec
--help` ("Print events to stdout as JSONL") and in the source
(`exec/src/cli.rs`, `json: bool`).

Related flags:

| Flag | Effect |
|---|---|
| `--json` | JSONL event stream on stdout |
| `-o, --output-last-message <FILE>` | write the final agent message to a file |
| `--output-schema <FILE>` | constrain the final response to a JSON Schema |
| `--color <always\|never\|auto>` | ANSI control (default auto; use `never` in a PTY) |
| `--ephemeral` | do not persist session rollout files |
| `-C, --cd <DIR>` | working root for the agent |
| `--skip-git-repo-check` | allow running outside a git repo |
| `--sandbox <read-only\|workspace-write\|danger-full-access>` | sandbox policy |
| `--dangerously-bypass-approvals-and-sandbox` | no sandbox, no approval prompts |
| `--approve-for-me` | route approval requests through automatic review |
| `-c key=value` | config override, e.g. `-c approval_policy=on-failure` |

`codex exec resume <SESSION_ID> | --last` continues a previous non-interactive
session; `codex exec fork <SESSION_ID>` forks one. There is no
`--approval-policy` flag in this version; approval policy is controlled through
`-c approval_policy=<never|on-failure|on-request>`.

Note: there is no interactive input channel during an `exec` run. Stdin is only
consumed before the run to build the initial prompt (see section 4).

## 2. JSONL event stream shape

Top-level event types (recorded + source `exec/src/exec_events.rs`):

`thread.started`, `turn.started`, `turn.completed`, `turn.failed`,
`item.started`, `item.updated`, `item.completed`, `error`.

Item payloads are tagged by `item.type` (snake_case): `agent_message`,
`reasoning`, `command_execution`, `file_change`, `mcp_tool_call`,
`collab_tool_call`, `web_search`, `todo_list`, `error`.

Recorded live samples (committed as parser fixtures):

- `packages/agent-codex/test/fixtures/recorded-credits-error.jsonl` — real run
  of `codex exec --json --color never --dangerously-bypass-approvals-and-sandbox
  "<prompt>"` on this machine (4 lines):
  `thread.started` → `turn.started` → `error {message: "Your workspace is out
  of credits..."}` → `turn.failed {error: {message: ...}}`. Exit code 1.
- `packages/agent-codex/test/fixtures/recorded-unauthorized.jsonl` — real run
  with an empty `CODEX_HOME` (no credentials). `thread.started` and
  `turn.started` are still emitted, then a long series of `error` events
  `Reconnecting... N/5 (unexpected status 401 Unauthorized...)` and an
  `item.completed` error item. The process did not exit on its own within 60s
  (killed externally). See section 5.

Synthetic fixtures built from the official documented sample and the source
schema (named `documented-*` to distinguish them from recordings):
`documented-happy-path.jsonl`, `documented-tool-rich.jsonl`.

Observed emission semantics (source `exec/event_processor_with_jsonl_output.rs`):

- `agent_message` and `reasoning` items are emitted only as `item.completed`.
- `command_execution` items are emitted as `item.started` (status
  `in_progress`) and again as `item.completed` (status `completed`, `failed`,
  or `declined`) carrying `command`, `aggregated_output`, `exit_code`.
- `file_change` is emitted only as `item.completed` with `changes[]`
  (`{path, kind: add|delete|update}`) and `status`.
- `todo_list` items stream as started/updated/completed.
- On success the stream ends with `turn.completed {usage}` and exit code 0.
- On failure the stream ends with `turn.failed {error}` and exit code 1.
- On SIGINT the turn completes with status `Interrupted`: no `turn.failed`
  event is emitted and the process exits 1 (source `exec/src/lib.rs`).

## 3. Mapping table (codex JSONL → NormalizedAgentEvent)

Implemented in `packages/agent-codex/src/jsonl.ts` (`mapCodexJsonlEvent`).

| codex `--json` event | NormalizedAgentEvent |
|---|---|
| `thread.started` | none (thread id captured internally; exposed via `CodingAgentAdapter.getThreadId()` and surfaced on the desktop session state as `agentThreadId`) |
| `turn.started` | none |
| `item.started` `command_execution` | `command_started {command}` |
| `item.completed` `command_execution` (completed/failed) | `command_completed {command, exitCode: exit_code ?? -1, stdout: aggregated_output, stderr: ""}` |
| `item.completed` `command_execution` (declined) | `approval_requested {command, rationale: output or "declined by codex approval policy"}` |
| `item.started` `mcp_tool_call` | `tool_started {tool: server.tool, input: JSON(arguments)}` |
| `item.completed` `mcp_tool_call` | `tool_completed {tool: server.tool, output: JSON(result \| error)}` |
| `item.completed` `agent_message` | `agent_message {role: "assistant", text}` |
| `item.completed` `reasoning` | `agent_message {role: "assistant", text}` |
| `item.completed` `file_change` (completed) | one `file_changed {path}` per entry in `changes[]` |
| `item.*` `todo_list`, `web_search`, `collab_tool_call`, item `error` | none in v0 (forward-compatible skip) |
| `error` with auth/credit pattern | `agent_failed {error}` |
| `error` otherwise | none (codex uses it for retry chatter) |
| `turn.completed` | `agent_completed` |
| `turn.failed` | `agent_failed {error: error.message}` |
| process exit without a terminal event | `agent_failed {error: "codex exited with code N"}` (adapter) |

## 4. Interrupt / resume findings (gated decision from SPEC §3.1)

Finding: **SIGINT does not pause-and-wait in `codex exec`. The SPEC §3.1
interrupt/resume model does not apply to exec mode; the fallback ("restart-free
next natural boundary") also has no anchor, because exec runs exactly one turn
and never reads stdin mid-run.**

Evidence:

- Source `codex-rs/exec/src/lib.rs`: `codex exec` spawns
  `tokio::signal::ctrl_c()`; on SIGINT it sends a `TurnInterrupt` request to the
  in-process app server, the turn completes with `TurnStatus::Interrupted`,
  `error_seen` is set, and the process exits 1. No stdin read is registered
  after the initial prompt is resolved.
- Stdin semantics (source `StdinPromptBehavior` + help text): stdin is read
  only to build the initial prompt — `RequiredIfPiped` (read piped stdin when
  no positional prompt), `Forced` (`-` sentinel), `OptionalAppend` (piped stdin
  appended as a `<stdin>` block when a prompt argument is present). With a PTY,
  stdin is a TTY, so it is not treated as piped: the positional prompt is the
  whole prompt and mid-run stdin writes are ignored. A real run logged
  "Reading additional input from stdin..." to stderr when stdin was a pipe.
- Consequence for the adapter: `interrupt()` writes `\u0003` to the PTY
  (SIGINT) which terminates the current turn; the session then ends with exit
  code 1 and the adapter emits `agent_failed`. `resume()`,
  `sendInstruction()`, and `sendDecision()` write to PTY stdin per the
  interface contract, but codex ignores them until a new exec process is
  started. The working continuation mechanism in this codex version is
  `codex exec resume <thread_id> "<prompt>"` (a new process), which the
  desktop AgentController can use in a later milestone. This is documented in
  `codex-adapter.ts`.
- PTY race note: input written to the PTY before the child has initialized its
  terminal session is dropped by the line discipline. The adapter therefore
  queues writes until the first output chunk arrives (`writeQueue`).

## 5. Approval flow findings

- `codex exec` is headless: the source hardcodes `approval_policy:
  Some(AskForApproval::Never)` ("Default to never ask for approvals in headless
  mode"), and rebuilds only when `approvals_reviewer` resolves to AutoReview.
  There is no interactive approval prompt in exec mode; a command the policy
  declines surfaces as `item.completed` `command_execution` with `status:
  "declined"` (the `CommandExecutionStatus::Declined` variant exists for this).
  The adapter maps `declined` to `approval_requested`, so the Jevcode Decision
  surface still has an event to anchor on.
- `--approve-for-me` routes approval requests through automatic review;
  `--dangerously-bypass-approvals-and-sandbox` skips prompts entirely.
- Adapter default: spawn with `--dangerously-bypass-approvals-and-sandbox` (SPEC
  §3.7: v0 runs the agent as the user's own account, no sandboxing; the default
  exec sandbox is read-only and would block file edits). Overridable via
  `CodexAdapterOptions.sandboxArgs`.
- `StartSessionInput.approvalMode` mapping: `default` → no flag (headless
  Never), `never` → `-c approval_policy=never`, `on-failure` → `-c
  approval_policy=on-failure`.

## 6. Auth / credit error detection

- `codex login status` exits 0 when credentials are present (documented as
  "exits with 0 when credentials are present, which is helpful in automation
  scripts") — usable as a preflight check.
- Recorded not-authenticated run (empty `CODEX_HOME`): codex still emits
  `thread.started`/`turn.started`, then `error` events containing
  `401 Unauthorized` / `Missing bearer or basic authentication` with a
  `Reconnecting... N/5` prefix, then an `item.completed` error item
  ("Falling back from WebSockets to HTTPS transport..."). The process kept
  retrying past 60s (killed externally). Detection: match `401 Unauthorized` /
  `Missing bearer` in `error` events or stderr lines.
- Recorded out-of-credits run: `error {message: "Your workspace is out of
  credits. Ask your workspace owner to refill in order to continue."}` followed
  by `turn.failed` with the same message; exit code 1. Detection: match
  "out of credits".
- Unauthenticated-vs-hang: with no credentials the process can hang for minutes
  in retries, so the adapter emits `agent_failed` on the first matching
  `error` event instead of waiting for exit.
- False-positive guard: codex logs unrelated MCP OAuth noise to stderr (e.g.
  `codex_rmcp_client::oauth::refresh_transaction ... invalid_grant`). The
  detector must not classify that as a codex auth failure; the committed unit
  test covers this exact line.

Patterns live in `packages/agent-codex/src/auth.ts` (`detectAuthFailure`) with
kinds `not_signed_in`, `unauthorized`, `out_of_credits`.

## 7. Open questions / follow-ups

- Live happy-path recording still needed: a run with credits (or an
  `CODEX_API_KEY` project) to verify the documented event shapes end to end and
  to capture a real approval/declined item.
- `codex exec resume` integration: the desktop AgentController can restart
  sessions with `resume <thread_id>` once multi-turn flows are needed.
- Item-level delta events (`agent_message.delta` etc.) do not exist in exec
  `--json` output; only completed items are emitted for messages.

## Live verification (2026-09-19)

- `codex exec -m gpt-5.6-luna -c model_reasoning_effort="xhigh"` runs successfully (logged in via ChatGPT).
- Default sandbox is read-only: file writes are rejected (`patch rejected: writing is blocked by read-only sandbox`). Use `-s workspace-write` for the standard case; the Jevcode adapter's `--dangerously-bypass-approvals-and-sandbox` default remains overridable via `JEVCODE_CODEX_SANDBOX_ARGS`.
- Live run through `CodexAdapter` (model + xhigh effort + JSONL): state machine completed, 18 normalized events captured, `getThreadId()` returns the thread id post-run (enables `codex exec resume <thread_id>`).
- `thread.started` JSONL shape confirmed as `{"type":"thread.started","thread_id":"..."}` matching the parser.
