import { bench, describe } from "vitest";

import { clusterSession, type SequencedFact } from "./clustering.js";
import { hunk, SESSION, testResult } from "./test-helpers.js";

// The coordinator reruns clusterSession on every rebuild, so its cost on the
// soak's shape bounds the soak `ingestMs` (spec §12 M1b exit). This input
// follows scripts/soak.mjs: bursts 6 s apart (one idle bucket) of 20
// formatting-only hunks on new files, and every 8th burst a test_result that
// the bucket's units all host. A per-host scan of the validation fact's
// owners made attachAgentCallIds quadratic here. `vitest run` includes only
// src/**/*.test.ts, so `pnpm -r test` never runs this; run it with
// `pnpm --filter @jevcode/semantic-core exec vitest bench --run`.

const BASE_MS = Date.UTC(2026, 8, 19, 9, 0, 0);

function soakShapedFacts(bursts: number): SequencedFact[] {
  const facts: SequencedFact[] = [];
  let seq = 0;
  const push = (fact: SequencedFact["fact"], batchId: number): void => {
    seq += 1;
    facts.push({ fact, factId: `fact_${seq}`, seq, batchId });
  };
  let noise = 0;
  for (let burst = 1; burst <= bursts; burst += 1) {
    const burstMs = BASE_MS + burst * 6000;
    for (let index = 0; index < 20; index += 1) {
      noise += 1;
      const ts = new Date(burstMs + index * 10).toISOString();
      push(hunk(`src/noise/format-${noise}.ts`, ts, { isFormattingOnly: true }), burst);
    }
    if (burst % 8 === 0) {
      const ts = new Date(burstMs + 500).toISOString();
      push(testResult(ts, { command: `pnpm test ${burst}`, passed: 42 }), burst);
    }
  }
  return facts;
}

describe("clusterSession on the soak shape", () => {
  for (const bursts of [100, 200]) {
    const facts = soakShapedFacts(bursts);
    bench(`${bursts} bursts (${facts.length} facts)`, () => {
      clusterSession({ sessionId: SESSION, facts, agentEvents: [], semanticEvents: [], decisions: [] });
    });
  }
});
