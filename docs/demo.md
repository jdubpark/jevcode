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
(deterministic labeled outputs).

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
