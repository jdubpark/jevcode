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

`brief` writes with Muse Spark 1.3 Contributor (`meta/muse-spark-1.3-contributor`,
variant `high`) through an installed, authenticated OpenCode CLI. If OpenCode
fails, or Muse's answer still fails validation after one repair, DeepSeek V4.1
Flash (`deepseek/deepseek-flash`) writes instead. `--runner deepseek` uses
DeepSeek alone; `--runner codex` keeps the original Codex runner (`exec`,
`--ignore-user-config`, `--ephemeral`, `--sandbox read-only`, `--output-schema`).
`--model` and `--variant` override the selected runner's model. The model time
limit is 600 seconds, configurable with `--timeout`; schema repairs, fallback
writers and evidence repairs share that budget. Cancellation and timeout
terminate the process group. Raw agent transcripts are not printed.

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

## Jev judgments

Jev, TypeSafe's System One model, answers small calibrated questions; it never
writes the brief. Jevcode reads `JEV_API_KEY` or `TYPESAFE_API_KEY` and uses Jev
twice:

- **Refresh gate.** One batched request asks whether a refresh would correct
  what a reader of the previous brief believes (Noul), how much to regenerate
  (Choice: skip, update or full), and whether each section is stale (one Noul
  per section).
- **Claim support.** After validation, one batched request asks, for every
  cited entry, whether the excerpts around its citations support it. Entries
  below the support threshold that the writer produced in this run go back
  to it once, listed with their text and citations. Weak entries carried
  forward from the previous brief are removed in place, since rewriting a
  carried section would contradict the update instructions. Entries still
  unsupported are removed, and the removal is added to the brief's open
  questions for this run only.

Without a key, the gate uses a disclosed heuristic (changed-file count,
high-fan-in components, removed files and new activity) and claims are not
checked; the coverage section says so.

## Diagrams

Each brief may carry up to two Mermaid diagrams: a `system` flowchart of the
major components and one key flow, and a `change` flowchart of what changed and
what it affects. Diagrams cite their sources like other entries and are
rendered in fenced `mermaid` blocks. Only `flowchart`, `graph` and
`sequenceDiagram` are accepted. A diagram that contains a URL, HTML, an image
shape, `click`, `link`/`links`, `style`, `classDef`, `class`, `linkStyle` or
`%%{init}%%` is dropped and noted in the coverage section; the rest of the
brief is kept. The check runs again when a stored brief is rendered.

## Automatic briefs

`jevcode auto` decides whether a checkout's brief is due and refreshes it only
when it is. Claude Code and Codex Stop hooks run it after every agent turn:

```sh
node /path/to/jevcode/scripts/jevcode.mjs auto --hook claude   # or --hook codex
```

The hook reads the agent's Stop payload from stdin (working directory, session
id and transcript path), starts a detached run, and exits at once; output goes
to `auto.log` in the state directory. Each run takes the cheapest exit
available:

1. Skip with no model call when HEAD, `git status` and the size and mtime of
   dirty paths match the last check, and the session transcript grew by less
   than 2 KiB since then. Small turns add up across checks.
2. Skip with no model call when the source matches the last brief, the last
   brief is younger than the debounce window and the change is small, or the
   previous automatic run failed within that window. A run that failed because
   the checkout moved under it is retried on the immediate re-check and once
   more; after two such failures in a row it backs off like a provider failure. Timing skips leave the change unseen, so the
   next agent stop re-evaluates it. The gate weighs file changes and
   transcript growth accumulated since the last brief.
3. Ask the Jev gate (or the heuristic). Skip when it chooses `skip` or the
   worth probability is below the gate threshold.
4. Run a full brief, or an incremental update. An update sends a smaller
   packet (changed components, their edges, patches for paths changed since
   the last brief, no documentation excerpts) and asks only for the stale
   sections. A section is also revised when any of its entries cites a patch
   or activity excerpt (those name the previous run's excerpts) or a file
   changed since the brief (its lines may have moved). Previous entries reach
   the writer without patch or activity ids, which are renumbered every run;
   the excerpt they used to cite comes along as text. Other sections are
   carried forward verbatim, fresh open questions join the carried ones, and
   the claim check covers the merged brief. The checkout is polled every 15
   seconds while the writer runs, and the writer is stopped as soon as it
   moves, since its brief would fail the freshness check anyway.

One run per checkout holds a lock. The lock file is linked into place fully
written and records its owner's PID and the owner's own expiry, refreshed at
each pass (the writer timeout plus five minutes); a lock whose owner is gone,
that expired, or that is unreadable is reclaimed, since PIDs are reused after a
crash or reboot. A trigger that arrives meanwhile leaves a marker, and the
active run re-checks once before it exits, without the debounce. A marker left
during that re-check stays for the next run. A missing transcript counts as no
activity. Writer processes run
with `JEVCODE_BRIEFING=1`; `auto` and the hook do nothing when it is set, so a
briefing run never starts another.

Settings live in `$XDG_CONFIG_HOME/jevcode/auto.json` (default
`~/.config/jevcode/auto.json`). Every field is optional:

```json
{
  "enabled": true,
  "include": ["*"],
  "exclude": ["/path/to/private/checkouts"],
  "writer": { "model": "meta/muse-spark-1.3-contributor", "variant": "high" },
  "fallback": { "model": "deepseek/deepseek-flash", "variant": "high" },
  "base": "merge-base",
  "timeoutSeconds": 600
}
```

`include` and `exclude` are checkout path prefixes; exclusions win. `base`
is `merge-base` (the merge base with the upstream default branch, or HEAD on
the default branch itself), `head` (uncommitted work only), or a revision.
`jevcode show` prints the latest brief and `jevcode status` prints settings,
tuning and recent decisions; neither calls a model. Both read the session
transcript's tail, not its beginning, so a long live session contributes its
recent activity.

## Self-correction

Every automatic decision, every run (automatic or manual) and every piece of
feedback is appended to a per-checkout ledger with its signals, Jev
probabilities, writer, token usage, repairs, churn and removed claims. Churn
is the share of revised sections whose wording materially changed; an update
is measured only over the sections it was asked to revise.

After each run, Jevcode re-evaluates four tuning values from the outcomes
since its last adjustment:

| Outcome | Evidence | Adjustment |
|---|---|---|
| noise | an automatic run with churn below 0.15, or `feedback noise` | raise the gate threshold by 0.05, multiply the debounce by 1.5, require one more changed file |
| late | a judged skip followed within an hour by a manual brief, or by a run with churn of at least 0.5 when the skip already held at least 70% of that run's changed files; at most one skip per run; or `feedback late` | the reverse steps |
| wrong | a run whose first draft had a claim below the fixed default support of 0.35, or `feedback wrong` | raise the claim-support threshold by 0.05 |

Explicit feedback counts twice. Nothing moves until five weighted samples
accumulate, each evaluation moves one step, the evidence window restarts only
when a value changes, and every value stays within bounds (gate 0.25 to 0.85,
debounce 2 to 120 minutes, 1 to 10 files, support 0.2 to 0.6). The "wrong"
signal is measured at the fixed default, so the tuned threshold cannot drive
itself upward, and inferred evidence moves it at most one step above its
default; only `feedback wrong` raises it further. The claim threshold relaxes toward its default when fewer than
10% of at least ten samples were wrong. These are heuristics, not statistical
guarantees.
Record a human verdict with:

```sh
node /path/to/jevcode/scripts/jevcode.mjs feedback noise --repo /path/to/project
node /path/to/jevcode/scripts/jevcode.mjs feedback wrong --section review
```

## Data use

Muse Spark 1.3 Contributor is the contributor data-use variant of the model.
Check the provider's terms for how submitted content may be retained or used.
The writer receives the prompt packet (source excerpts, diffs, component map,
redacted agent activity and the previous brief) and can read any file in the
checkout whose name Jevcode does not treat as secret (`.env*`, `*.pem`,
`*.key`, private SSH keys, keystores, `.npmrc`, `.netrc`, `.pgpass`,
`.pypirc`, `credentials`). Secrets inside other files are not filtered from
what the writer reads. Jev receives the gate state (changed paths, component
counts, recent activity excerpts and the previous brief's headlines) and the
claim excerpts. Redaction is pattern-based. Exclude checkouts whose content
must not leave the machine under those terms.

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

## OpenCode isolation

The OpenCode writer runs with only the configuration Jevcode supplies.
`OPENCODE_CONFIG_CONTENT` alone is merged over the user's global and project
configuration, so each run also gets a private `XDG_CONFIG_HOME` and session
database (`OPENCODE_DB`), plus `OPENCODE_PURE`, `OPENCODE_DISABLE_PROJECT_CONFIG`,
`OPENCODE_DISABLE_CLAUDE_CODE`, `OPENCODE_DISABLE_EXTERNAL_SKILLS`,
`OPENCODE_DISABLE_AUTOUPDATE` and `OPENCODE_DISABLE_LSP_DOWNLOAD`. Both
directories are deleted after the run. Provider credentials stay under
`XDG_DATA_HOME`, which is not changed. The single agent denies every
permission, then allows `read` and `glob`. Read rules deny the same secret
file names that evidence collection excludes (`isSecretPath`). `grep` is
denied: OpenCode checks it against the search pattern rather than the file
and searches hidden files, so it could return lines from secret files.
Denied tools are never offered to the model, and an MCP-free config means no
external tools exist. The full assignment is piped on stdin, never placed on
the command line or written to disk.

OpenCode 1.18 still injects nested `AGENTS.md`, `CLAUDE.md` and `CONTEXT.md`
files into read results, and no setting disables that. The assignment treats
repository text as evidence, not instructions, but this channel exists. OpenCode must be authenticated for the configured models; `opencode models`
lists what is available.

## State and source boundaries

Successful briefs save source hashes, the generated report and cited activity/diff excerpts under
`~/.local/state/jevcode/repo-agent/`, keyed by the real checkout path. Beside
each checkpoint are the rendered brief (`.md`), the outcome ledger
(`.ledger.jsonl`), tuning (`.tuning.json`) and automatic-run state
(`.auto.json`, `.auto.lock`); detached hook runs log to `auto.log`. Worktrees
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
