# Jevcode PRD Review

Review of `jevcode_PRD.md` (draft, 62 sections) ahead of the MVP spec and implementation plan.

## Overall assessment

This is an unusually strong PRD. It states a falsifiable product claim: the MVP proves semantic generative UI beats a raw CLI stream for supervision. It separates product philosophy from implementation mechanics, and already contains a milestone ladder, acceptance criteria, an eval framework, and a failure-mode catalog. It is ready for the specification phase. The two documents that follow (`SPEC.md`, `IMPLEMENTATION-PLAN.md`) resolve its open questions and turn it into a parallelizable build plan.

The PRD's core ideas that survive into the spec unchanged:

- **Semantic Change Units** as the primary object, not messages or files.
- **Importance / relevance / interruption** modeled independently (§17).
- **Mental Model Delta** as the ranking primitive (§2.6).
- **Evidence over claims**: repository state is ground truth, agent narration is context (§11.2).
- **Generative selection, deterministic execution** (§6.7): Jev decides, a compiler emits a constrained `json-render` spec.
- **Confidence-aware UI policy** (§16): a distribution, not a top-1 answer, drives conservative rendering.

## Strengths

1. **The product tension is correctly framed** — understanding bandwidth vs. execution bandwidth (§2.4). Every feature can be checked against one question: "does this update the developer's mental model?"
2. **Concrete working examples throughout** — the OAuth and rate-limiter walkthroughs ground the abstractions in realistic sequences, and they convert directly into replay fixtures.
3. **Pre-built evaluation and calibration machinery**. §45–47 define metrics and calibration signals before the system exists. This is rare and correct: telemetry must be instrumented from day one to tune Jev later.
4. **The milestone ladder (§44) is a real dependency ladder**. M0 (fixture UI) before M1 (live agent) before M2 (evidence) prevents building intelligence on an untested interaction model.
5. **Security is treated as architecture, not checklist** (§31), including the critical constraint that `json-render` never executes arbitrary generated code.

## Gaps the spec must close

The PRD's own §60 lists open questions. The spec answers all of them. Additional gaps found in review:

1. **ChangeUnit formation is underspecified.** The PRD says "group low-level edits into a ChangeUnit" but defines no algorithm. This is the hardest deterministic piece of the system. The spec defines temporal-bucket + connectivity clustering (§6 of `SPEC.md`).
2. **Agent interruption mechanics are unverified.** The Decision loop (§8, M6) assumes the first agent can pause and accept structured input mid-run. Whether the Codex CLI supports this cleanly (SIGINT pause → stdin turn) must be confirmed by a dedicated spike before M6 is committed. The spec makes this an explicit gate with a fallback (turn-based resume via sub-instruction).
3. **Race between agent writes and evidence snapshots.** The agent mutates files while the evidence engine reads them. The spec requires snapshot consistency via Git (diff against session base commit) and per-file write-event debouncing.
4. **Event floods.** One `npm install` produces thousands of file events. The spec defines batching windows, same-file fact merging, and backpressure with drop semantics.
5. **"Behavior preserved" claims need verification machinery.** The completion surface claims "existing behavior preserved". V0 can only support this with evidence links (unchanged public symbols + passing pre-existing tests), not proof. The spec downgrades this to "evidence-backed claim" with visible confidence.
6. **No telemetry schema.** §45/§47 define what to measure but not how. The spec adds a local-only telemetry event table and an export path.
7. **json-render integration level is unspecified.** The spec locks the exact API (`defineCatalog`/`defineRegistry`/`Renderer`, flat spec format, `createSpecStreamCompiler` for streaming). It notes json-render's experimental Jev composition as a later exploration, not the v0 path.
8. **No language priority.** The spec commits to TypeScript/JavaScript repositories first (tree-sitter grammars, npm manifests, vitest/jest output), with a well-defined parser registry for later languages.

## Top risks and mitigations

| # | Risk | Severity | Mitigation (owned by spec section) |
|---|---|---|---|
| 1 | Codex CLI cannot be interrupted/resumed cleanly mid-task | High | T2 spike gate (day 3 of T2). Fallback: run agent in iterative `exec` turns. Degrade interruption to "stop at next natural boundary". |
| 2 | TypeSafe (Jev) SDK/API semantics don't match PRD assumptions (primitive shapes, probability/confidence, latency) | High | T5 spike against live docs. `JevClient` interface isolates the provider. `DegradeClient` is the guaranteed path. |
| 3 | ChangeUnit clustering produces noise (over/under-grouping) | High | Deterministic connectivity algorithm with strong unit tests + fixture replay. Jev only labels and ranks, never invents grouping. |
| 4 | Latency chain (evidence → Jev → UI) feels slow | Medium | Phase A skeleton ≤100ms. Batch Jev calls. SLOs in spec §13. Degrade to deterministic router offline. |
| 5 | Generative UI feels unstable | Medium | Stability engine (min surface lifetime, interaction lock, local patching, pinning) enforced by code, not guidelines. |
| 6 | Over/under-surfacing (PRD §48) | Medium | Deterministic guardrails override Jev for destructive/security/schema/API events. Eval harness with precision/recall targets from day one. |
| 7 | MVP scope creep (11 components + full pipeline) | Medium | Components prioritized P0/P1. P1 components ship only if M0–M4 hit their gates. See scope recommendations below. |

## Scope recommendations for MVP

- **Keep** the 11-component catalog (§42) but rank: P0 = `ChangeOverview`, `Decision`, `CodeDiff`, `Terminal`, `TestMatrix`, `FailureAnalysis`. P1 = `BehaviorDelta`, `ArchitectureDelta`, `SchemaDelta`, `DependencyDelta`, `ExecutionTimeline`.
- **Cut from MVP**: LSP integration, security scanners, coverage, CI/PR integration, and multi-agent. Also cut the Claude adapter (interface + stub only), personalization learning, policy engine, and semantic Git history UI.
- **Reduce** `ArchitectureDelta` from general diagrams to node/edge graphs over known node kinds (module, service, dependency, route, schema entity). No general-purpose diagram generation in v0.
- **Accept** low-confidence teaching surfaces (§24.1) as stretch. The hierarchy "conceptual model → why it matters → evidence → raw code" is the review hierarchy (§36) and is mandatory.

## Verdict

Proceed to specification. The PRD's architecture is coherent and its risk posture is honest. The main engineering risk is not product direction but three unverified external dependencies (Codex interrupt semantics, Jev SDK, json-render specifics). All three are covered by explicit spikes with fallbacks in the implementation plan.
