# Running the PRD §58 Demo

The demo is the rate-limit scenario: the agent adds a Redis-backed rate
limiter, the pipeline surfaces the architecture change, an open decision
interrupts the agent (Redis unavailability policy), the developer answers
"fail open", the agent resumes, the validation matrix renders, and a
completion review appears, including the observed failure when the agent's
narration claims success.

## Headless E2E (accepted form, no Electron)

```
pnpm build
pnpm --filter jevcode-desktop exec vitest run src/main/pipeline/demo-e2e.test.ts
```

This runs the full sequence through the real `PipelineRuntime` with the mock
agent adapter and playback Jev client, asserting the ordered surface flow:

architecture surface → `decision:open` → `answer_decision` (fail_open) →
agent resume → validation `TestMatrix` → completion review surface.

The same sequence is exercised by `PipelineRuntime with MockAgentAdapter over
fixtures` in `src/main/pipeline/pipeline-runtime.test.ts`.

## Fixture replay (offline UI demo)

```
pnpm build
rm -rf /tmp/jevcode-replay && node apps/desktop/scripts/replay.mjs fixtures/rate-limit /tmp/jevcode-replay
```

Emits the UI specs to `/tmp/jevcode-replay/ui-specs/` and session state to
`semantic-state.json`. Replays every fixture with Jev in playback mode
(deterministic labeled outputs). It also writes `/tmp/jevcode-replay/trace.json`,
a `jevcode.trace` v1 bundle of the session's trace rows for the trace viewer's
dev host.

## Trace export (viewer bundle)

Export any stored session, from the app database or a `replay.db`, to a
`trace.json` bundle. Run it from the repo root after a build:

```
pnpm build
sqlite3 ~/.jevcode/jevcode.db "SELECT id, startedAt, prompt FROM sessions ORDER BY startedAt DESC LIMIT 10"
node apps/desktop/scripts/replay.mjs export --db ~/.jevcode/jevcode.db --session <session id> --out /tmp/jevcode-trace.json
```

The export opens the database on a second, `query_only` connection and never
writes to it. Every string in the bundle passes the redactor before strings
over 16 KiB are clipped to their first 4 KiB and last 12 KiB, your home
directory becomes `~`, and the file is written with mode 0600. On success it
prints `{"out", "rows", "redactionCount"}` and exits 0; a missing flag, a
missing database, an unknown session or an `--out` that names the database or
its `-wal`/`-shm` files exits 1 and writes nothing.
`pnpm --filter jevcode-desktop replay export …` also works, but pnpm runs the
script from `apps/desktop`, so pass absolute paths. Bundles stay on this
machine; sharing them is out of scope for v1.

## Live demo (Electron, real agent)

Requirements: `codex` ≥ 0.155 on PATH (`codex login status` exits 0), Node ≥ 22,
pnpm.

```
pnpm install
pnpm --filter jevcode-desktop build
JEVC_AGENT=codex pnpm --filter jevcode-desktop start
```

Then: open the `fixtures/rate-limit/repo` directory, enter the task prompt
("Add a Redis-backed rate limiter to the API server and make it fail open when
Redis is unavailable."), and supervise. With no Codex credentials or binary,
set `JEVC_AGENT=mock` for the scripted mock agent.

Electron smoke boot (no interaction): `JEVCODE_SMOKE=1 pnpm --filter
jevcode-desktop start` prints `SMOKE_OK` and exits.

## Expected demo behavior

- An `ArchitectureDelta` surface appears for the rate-limiter change, then a
  `Decision` surface interrupts the agent (`agent:state` → `waiting_decision`).
- Answering "fail open" resumes the agent (`agent:state` → `running`). The
  structured decision is serialized in the PRD §8 format and delivered to the
  agent (real Codex: `codex exec resume <thread_id>` with the decision as the
  prompt. The thread id is visible on the session state as `agentThreadId`).
- A `TestMatrix` validation surface renders after the test run.
- On completion the `completion` surface summarizes change units, validation
  rows, open decisions, and failures from repository evidence. The oauth
  fixture demonstrates the PRD §48 case: the agent's final message claims
  "all checks pass" while the completion surface shows the failing test.
