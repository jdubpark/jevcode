#!/usr/bin/env node
// Phase C screenshot bundles (lane 07 S-4; S-5 adds the Map overlay shot): the rate-limit replay plus an overview
// snapshot and explainer rows, written to public/bundles for the dev host. `smoke.mjs --explainer` runs it after the
// replay; run it alone as `node explainer-bundle.mjs <replayed trace.json>` after `pnpm -r build` (it folds with the
// viewer's model dist and validates with the contracts' dist).
//
//   rate-limit-explainer.json  the whole session, live: two narrator stories, the decision's why, highlights
//   rate-limit-pending.json    cut at the open decision: a rule-based story, then a narrator story
//
// Explainer rows take free seqs between the replay's rows, so each ◆ Summary lands where it would arrive live.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TraceBundleSchema } from "@jevcode/contracts";
import { foldRows } from "@jevcode/trace-viewer/model";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(APP, "public", "bundles");

const sha1 = (text) => createHash("sha1").update(text).digest("hex");

function component(rootPath, name, role, files) {
  return {
    id: `cmp_${sha1(rootPath).slice(0, 12)}`, rootPath, name, fileCount: files.length, files: [...files].sort(),
    language: "TypeScript", roleGuess: role, role, purpose: null, provenance: "rule", contentHash: sha1(files.join("\n")),
    externalDeps: [], entryPoints: [], importsAnalyzed: true,
  };
}

/** The first seq after `after` that no row uses (the replay leaves gaps). */
function freeSeq(rows, after) {
  const used = new Set(rows.map((row) => row.seq));
  for (let seq = after + 1; ; seq += 1) if (!used.has(seq)) return seq;
}

function insert(rows, row) {
  const at = rows.findIndex((candidate) => candidate.seq > row.seq);
  if (at < 0) rows.push(row);
  else rows.splice(at, 0, row);
}

/** A live bundle (both are open sessions, as the H3 mockups show): endedAt null, lastEventSeq at its last row. */
function bundleOf(base, rows, state) {
  return TraceBundleSchema.parse({ ...base, session: { ...base.session, state, endedAt: null, lastEventSeq: rows.at(-1).seq }, rows });
}

export function buildExplainerBundles(file) {
  const base = JSON.parse(readFileSync(file, "utf8"));
  const sessionId = base.session.sessionId;
  // Explainer and overview rows make no steps, so the replay's step ids hold in both bundles.
  const session = foldRows(base.session, base.rows, { live: false });
  const decisionStep = session.steps.find((step) => step.decision !== undefined);
  const edits = session.steps.filter((step) => step.edit !== undefined);
  const messages = session.steps.filter((step) => step.kind === "message");
  const testRun = session.steps.find((step) => step.tests !== undefined);
  if (decisionStep === undefined || edits.length < 2 || messages.length < 3 || testRun === undefined) {
    throw new Error("the rate-limit replay lacks a decision, edits, messages or a test run");
  }
  const decisionId = decisionStep.decision.decisionId;
  const firstDecisionSeq = decisionStep.firstSeq;
  const answerSeq = base.rows.find((row) => row.type === "decision" && row.payload.id === decisionId && row.payload.status !== "open").seq;
  // The agent's message that raises the failure policy, just before the decision.
  const policyNote = [...messages].reverse().find((step) => step.firstSeq < firstDecisionSeq);
  const fileStep = (suffix) => edits.find((step) => step.edit.path.endsWith(suffix)) ?? edits[0];

  const server = component("src/server", "server", "api", ["src/server/app.ts", "src/server/index.ts"]);
  const middleware = component("src/middleware", "middleware", "domain", ["src/middleware/rate-limiter.ts"]);
  const redis = component("src/redis", "redis", "storage", ["src/redis/client.ts"]);
  const tests = component("tests", "tests", "tests", ["tests/rate-limit.test.ts", "tests/redis-unavailable.test.ts"]);
  const config = component(".", "config", "config", ["package.json", "tsconfig.json"]);
  const components = [server, middleware, redis, tests, config];
  const edges = [
    { from: server.id, to: middleware.id, count: 3, examples: ["src/server/app.ts → src/middleware/rate-limiter.ts"] },
    { from: middleware.id, to: redis.id, count: 2, examples: ["src/middleware/rate-limiter.ts → src/redis/client.ts"] },
    { from: tests.id, to: middleware.id, count: 2, examples: ["tests/rate-limit.test.ts → src/middleware/rate-limiter.ts"] },
  ];
  const ts = base.rows[0].ts;
  const overview = {
    seq: freeSeq(base.rows, 0), type: "overview_snapshot", ts,
    payload: {
      sessionId, repoRoot: "/work/rate-limit", scanId: "scan_shots", partial: false,
      counts: { files: 10, components: components.length, edges: edges.length, languages: ["TypeScript"] },
      components, edges, externals: [], narrative: null, generatedAt: ts,
      status: { scan: { state: "done", scanned: 10, total: 10 }, narrator: "ready" },
    },
  };
  const explainer = (after, record) => {
    const seq = freeSeq(base.rows, after);
    return { seq, type: "explainer", ts: base.rows.find((row) => row.seq > seq)?.ts ?? base.rows.at(-1).ts, payload: { sessionId, ...record } };
  };
  const lastEdit = edits.filter((step) => step.firstSeq < firstDecisionSeq).at(-1) ?? edits[0];
  // The test command's own completion row: the step's lastSeq also takes the later validation row.
  const testDone =
    base.rows.find((row) => row.type === "agent_event" && row.payload.type === "command_completed" && row.seq > testRun.firstSeq)?.seq ??
    testRun.lastSeq;

  // Whole session: a story after the first edits, the why after the answer, a story after the test run, highlights.
  const full = [...base.rows];
  insert(full, overview);
  insert(full, explainer(lastEdit.lastSeq, {
    kind: "story", basisSeq: lastEdit.lastSeq,
    sentences: [
      { text: "The agent added a Redis client and a rate-limiter middleware for the public API.", citations: [{ kind: "component", id: middleware.id }, { kind: "component", id: redis.id }] },
    ],
  }));
  insert(full, explainer(answerSeq, {
    kind: "decision_why", decisionId,
    sentence: {
      text: "Failing open keeps the public API available during a Redis outage, which the agent flagged as a single point of failure.",
      citations: [{ kind: "step", id: policyNote.id }, { kind: "decision", id: decisionId }],
    },
  }));
  insert(full, explainer(testDone, {
    kind: "story", basisSeq: testDone,
    sentences: [
      { text: "You chose to fail open, so requests keep flowing when Redis is down.", citations: [{ kind: "decision", id: decisionId }] },
      { text: "The agent wired the limiter into the server and added an outage test.", citations: [{ kind: "file", id: fileStep("app.ts").edit.path }, { kind: "step", id: testRun.id }] },
    ],
  }));
  const unitIds = session.chapters.map((chapter) => chapter.changeUnitId);
  full.push({
    seq: full.at(-1).seq + 1, type: "explainer", ts: full.at(-1).ts,
    payload: {
      sessionId, kind: "highlights", basisSeq: full.at(-1).seq,
      components: [
        { id: server.id, state: "changed", unitIds: unitIds.slice(0, 1) },
        // As the H3 Map mockup: cards carry several marks (new and decided; new and failing).
        { id: middleware.id, state: "decision", states: ["new", "decision"], unitIds: unitIds.slice(0, 2) },
        { id: redis.id, state: "decision", states: ["new", "decision"], unitIds: unitIds.slice(1, 2) },
        { id: tests.id, state: "failing", states: ["new", "failing"], unitIds: [] },
      ],
    },
  });

  // Cut at the open decision: a rule-based story after the edits, then a narrator story just before the question.
  const pending = base.rows.filter((row) => row.seq <= firstDecisionSeq);
  insert(pending, overview);
  insert(pending, explainer(lastEdit.lastSeq, {
    kind: "story", provenance: "rule", basisSeq: lastEdit.lastSeq,
    sentences: [
      {
        text: `Edited ${edits.filter((step) => step.firstSeq < firstDecisionSeq).length} files: the Redis client, the rate limiter and package.json.`,
        citations: [{ kind: "file", id: fileStep("client.ts").edit.path }, { kind: "file", id: fileStep("rate-limiter.ts").edit.path }],
      },
    ],
  }));
  insert(pending, explainer(policyNote.lastSeq, {
    kind: "story", basisSeq: policyNote.lastSeq,
    sentences: [
      { text: "The agent added a Redis-backed limiter as new middleware for the public API.", citations: [{ kind: "component", id: middleware.id }, { kind: "component", id: redis.id }] },
      { text: "It stopped to ask what the API should do when Redis is down.", citations: [{ kind: "step", id: policyNote.id }] },
    ],
  }));

  return {
    explainer: bundleOf(base, full, "running"),
    pending: bundleOf(base, pending, "waiting_decision"),
    decisionStepId: decisionStep.id,
  };
}

function main() {
  const file = process.argv[2];
  if (file === undefined) throw new Error("usage: explainer-bundle.mjs <replayed rate-limit trace.json>");
  const { explainer, pending, decisionStepId } = buildExplainerBundles(file);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, "rate-limit-explainer.json"), JSON.stringify(explainer), { mode: 0o600 });
  writeFileSync(path.join(OUT, "rate-limit-pending.json"), JSON.stringify(pending), { mode: 0o600 });
  console.log(`EXPLAINER_BUNDLES ${JSON.stringify({ sessionId: explainer.session.sessionId, decisionStepId })}`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
