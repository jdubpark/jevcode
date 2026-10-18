# Repository briefing agent

Jevcode can investigate any local Git checkout without opening the desktop app.
It explains the system's shape, identifies critical code for human review, and
turns supplied agent activity into a concise account of meaningful changes.

## Run

From the jevcode checkout, install dependencies and build once:

```sh
pnpm install
pnpm --filter @jevcode/repo-agent... build
pnpm repo-agent --help
pnpm repo-agent brief --repo /path/to/project
```

From any directory, use the absolute path to jevcode's launcher. The caller's
working directory is preserved when `--repo` is omitted:

```sh
node /path/to/jevcode/scripts/jevcode.mjs brief
node /path/to/jevcode/scripts/jevcode.mjs brief --repo /path/to/project \
  --base main --focus src/auth --focus src/storage --log /path/to/session.jsonl
```

`brief` uses an installed, authenticated Codex CLI with `exec`,
`--ignore-user-config`, `--ephemeral`, `--sandbox read-only`, and
`--output-schema` support. Run `codex login` first. `--model` chooses a model;
otherwise Codex uses its built-in default. The model timeout is 300 seconds,
configurable with `--timeout`. One invalid schema/citation answer may be repaired
within that same total model time budget. Cancellation and timeout terminate the process
group. Raw agent transcripts are not printed.

`--base` is an exact commit-to-working-tree comparison. Resolve a merge base
yourself if that is the desired scope. The default is HEAD: only uncommitted
changes, including staged and untracked source. The architectural review also
covers important unchanged code. An unborn Git repository is supported.

## Brief contract

The brief contains system shape, at most five ranked review areas, meaningful
changes, available check evidence, documented or proposed guidance for coding
agents, open questions, and collection limits. Each review area explains a
consequence and asks a concrete question with source references. High edit
volume and import fan-in help navigation; they do not establish criticality.

The agent reads representative implementations and callers to understand
boundaries and flows. It distinguishes agent-reported intent from source
evidence and architectural inference. It executes no tests or builds. Test
results in supplied logs are historical; they do not certify the current tree.
Generated summaries and guidance are never human approval or a release gate.

`--log` accepts up to five explicitly selected plaintext or JSONL transcripts.
`--activity-stdin` accepts one of those inputs over a pipe (at most 8 MiB),
so a host can supply the selected session without writing a shared log file.
Codex exec events, Codex rollout messages/results, and Claude text/tool-result
content are recognized. Unknown structured events and reasoning records are
omitted. Logs are deduplicated and bounded, retaining early failures/decisions
and recent outcomes. Missing records, unknown formats, byte limits and missing
activity are disclosed. Log membership in this repository is supplied by the
caller; no global session-history discovery is performed.

## Reuse with another agent

```sh
node /path/to/jevcode/scripts/jevcode.mjs context --repo /path/to/project
node /path/to/jevcode/scripts/jevcode.mjs prompt --repo /path/to/project --no-state
node /path/to/jevcode/scripts/jevcode.mjs brief --repo /path/to/project --format json
```

`context` produces evidence without calling a model or writing state. `prompt`
prints the reusable review instructions and bounded evidence. Supply the
exported `BRIEF_JSON_SCHEMA` when using a structured-output runner of your own,
then validate its answer with `validateBrief`. The `@jevcode/repo-agent` package
exports collection, prompt, schema, validation, rendering and Codex execution
independently. None imports Electron, React, the trace viewer or desktop services.

## Remote installation

After installing dependencies, create a standalone directory with Node 22+ and
the repository's pinned pnpm version:

```sh
node scripts/package-repo-agent.mjs /path/to/new-output-directory
```

The script builds the four headless packages, includes production dependencies,
parser workers and WASM grammars, and checks that symlinks stay within the
installation. Transfer the entire directory to the execution host and run
`node /path/to/installation/dist/cli.js --help`. Qualify `context` and `brief`
against a disposable Git checkout under the execution identity before activation.
The host needs Git and an authenticated compatible Codex CLI on PATH. Keep the
installation administrator-owned and use the agent execution identity, which
must have access to the selected checkout. No desktop application is required.

JSON briefs include `fingerprint`, `head`, `base`, and `generatedAt` for the
collected source snapshot. A stored report describes that snapshot, not a promise
that the checkout still matches it when another client reads the report.

## State and source boundaries

Successful briefs save source hashes, the generated report and cited activity/diff excerpts under
`~/.local/state/jevcode/repo-agent/`, keyed by the real checkout path. Worktrees
remain separate. The next run receives changed/removed paths and unresolved
questions from that brief. This is a comparison with the last generated brief,
not the last human review; it does not advance the Git diff base or retain old
source text. `--no-state` disables reads and writes. `--state-dir` overrides the
directory and must be outside the target repository. Delete that repository's
checkpoint to reset its history. Atomic writes and a per-checkout lock prevent
partially written or older reports replacing newer state. A stale `.lock` after
a machine crash must be removed after confirming no run is active.

The collector reuses `codebase-map` and `evidence-engine` for layout, import
resolution and redaction. JavaScript/TypeScript have static import edges;
other languages still have components and source-based agent investigation.
Generated, binary, secret and symlinked source are excluded from the packet.
The scan caps candidates at 20,000; change and activity excerpts also have caps.
These limits are reported rather than treated as complete coverage.

The Codex runner can read source directly in the selected checkout. Packet and
output redaction are pattern-based, not a guarantee that arbitrary source
contains no secrets. The prompt excludes secret paths and repository writes;
Codex's read-only sandbox enforces filesystem mutation restrictions. User
configuration is not loaded. The runner disables hooks, apps, delegation and
browser/local-automation integrations, overrides MCP servers, and limits shell
environment inheritance to core variables. Repository content is treated as
evidence, not permission to act. Source selection and the prohibition on running
tests or other executable project code also depend on the agent following the
review assignment; the CLI is not a general-purpose hostile-code sandbox.

The final report is schema-checked. Source references must resolve to collected
files and actual lines, retained activity records, or supplied patch excerpts.
The collected source hashes and HEAD are rechecked before output, including
uncited files and deletions within the scan scope. This validates provenance and
snapshot freshness; it does not prove that every natural language assertion
follows from its citation or cover files excluded by collection limits.
Failed, timed-out or invalid reports do not
advance the checkpoint.
