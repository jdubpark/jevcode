import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { EvidenceFact } from "@jevcode/contracts";

import { clusterSession, type SequencedFact } from "./clustering.js";
import {
  agentEvent,
  commandExecuted,
  fileChanged,
  hunk,
  SESSION,
  symbolDelta,
  testResult,
  tsOf,
} from "./test-helpers.js";

interface FactSpec {
  file: string;
  kind: "file" | "hunk" | "symbol";
  batch: number;
}

const FILE_ALPHABET = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "tests/a.test.ts", "src/utils/fmt.ts"];

function factFor(spec: FactSpec, ts: string): ReturnType<typeof fileChanged> | ReturnType<typeof hunk> | ReturnType<typeof symbolDelta> {
  if (spec.kind === "file") return fileChanged(spec.file, "modified", ts);
  if (spec.kind === "hunk") {
    return hunk(spec.file, ts, {
      isFormattingOnly: spec.file === "src/utils/fmt.ts",
    });
  }
  return symbolDelta(spec.file, ts, { added: [], removed: [], modified: [] });
}

// Timestamps and seq are assigned from the array position, so the order the
// specs are fed in is the order the projection actually processes them; a
// genuinely order-dependent clustering would fail these properties.
function specsToFacts(specs: readonly FactSpec[]): SequencedFact[] {
  return specs.map((spec, index) => ({
    fact: factFor(spec, tsOf(0, index)),
    factId: `f${index}`,
    seq: index + 1,
    batchId: spec.batch,
  }));
}

function groupingKey(result: ReturnType<typeof clusterSession>): string[] {
  return result.units
    .map((unit) => `${unit.category}:${[...unit.files].sort().join("|")}:${unit.status}`)
    .sort();
}

const bucketSpecArb = fc.array(
  fc.record<FactSpec>({
    file: fc.constantFrom(...FILE_ALPHABET),
    kind: fc.constantFrom<FactSpec["kind"]>("file", "hunk", "symbol"),
    batch: fc.integer({ min: 0, max: 3 }),
  }),
  { minLength: 2, maxLength: 20 },
);

const orderedAndShuffledArb = bucketSpecArb.chain((specs) =>
  fc.record({
    forward: fc.constant(specs),
    shuffled: fc.shuffledSubarray(specs, { minLength: specs.length, maxLength: specs.length }),
  }),
);

describe("clustering property tests", () => {
  it("is invariant to fact reordering within a bucket", () => {
    fc.assert(
      fc.property(orderedAndShuffledArb, ({ forward, shuffled }) => {
        const forwardResult = clusterSession({
          sessionId: SESSION,
          facts: specsToFacts(forward),
          agentEvents: [],
          semanticEvents: [],
          decisions: [],
        });
        const shuffledResult = clusterSession({
          sessionId: SESSION,
          facts: specsToFacts(shuffled),
          agentEvents: [],
          semanticEvents: [],
          decisions: [],
        });
        expect(groupingKey(forwardResult)).toEqual(groupingKey(shuffledResult));
      }),
      { numRuns: 200 },
    );
  });

  it("attaches passing runs the same way whatever the fact order within a bucket", () => {
    // Runs mixed among the file facts. Shuffling moves every fact's ts and seq but keeps
    // its batch window. Each run has its own command, so it can be recognized after its
    // ts (and so its validation id) changes.
    type Spec = FactSpec | { run: number; batch: number };
    const specArb = fc
      .tuple(
        bucketSpecArb,
        fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 1, maxLength: 4 }),
      )
      .chain(([files, runBatches]) => {
        const specs: Spec[] = [...files, ...runBatches.map((batch, run) => ({ run, batch }))];
        return fc.record({
          forward: fc.constant(specs),
          shuffled: fc.shuffledSubarray(specs, { minLength: specs.length, maxLength: specs.length }),
        });
      });
    const project = (specs: readonly Spec[]): string[] => {
      const facts: SequencedFact[] = specs.map((spec, index) => ({
        fact:
          "run" in spec
            ? testResult(tsOf(0, index), { passed: 1, command: `pnpm test -- run-${spec.run}` })
            : factFor(spec, tsOf(0, index)),
        factId: `f${index}`,
        seq: index + 1,
        batchId: spec.batch,
      }));
      const result = clusterSession({
        sessionId: SESSION,
        facts,
        agentEvents: [],
        semanticEvents: [],
        decisions: [],
      });
      const commandById = new Map(result.validations.map((validation) => [validation.id, validation.command]));
      return result.units
        .map((unit) => {
          const runs = unit.validationResults.map((id) => commandById.get(id) ?? id).sort();
          return `${[...unit.files].sort().join("|")}:${unit.status}:${runs.join(",")}`;
        })
        .sort();
    };
    fc.assert(
      fc.property(specArb, ({ forward, shuffled }) => {
        expect(project(shuffled)).toEqual(project(forward));
      }),
      { numRuns: 200 },
    );
  });

  it("is invariant to bucket-level shuffling for disjoint file sets", () => {
    const twoBucketArb = fc.tuple(
      fc.array(
        fc.record<FactSpec>({
          file: fc.constantFrom("src/a.ts", "src/b.ts", "src/c.ts"),
          kind: fc.constantFrom<FactSpec["kind"]>("file", "hunk"),
          batch: fc.integer({ min: 0, max: 1 }),
        }),
        { minLength: 2, maxLength: 10 },
      ),
      fc.array(
        fc.record<FactSpec>({
          file: fc.constantFrom("src/x.ts", "src/y.ts", "src/z.ts"),
          kind: fc.constantFrom<FactSpec["kind"]>("file", "hunk"),
          batch: fc.integer({ min: 2, max: 3 }),
        }),
        { minLength: 2, maxLength: 10 },
      ),
    );
    // Waves get their timestamps from position: the first wave lands in minute 0,
    // the second in minute 5. Swapping the waves genuinely reorders the timeline
    // (a later-bucket implementation bias would fail).
    const factsForWaves = (waves: readonly (readonly FactSpec[])[]): SequencedFact[] => {
      const out: SequencedFact[] = [];
      let index = 0;
      for (const [waveIndex, specs] of waves.entries()) {
        for (const spec of specs) {
          out.push({
            fact: factFor(spec, tsOf(waveIndex === 0 ? 0 : 5, index)),
            factId: `f${index}`,
            seq: index + 1,
            batchId: spec.batch,
          });
          index += 1;
        }
      }
      return out;
    };
    fc.assert(
      fc.property(twoBucketArb, ([bucketA, bucketB]) => {
        const forward = clusterSession({
          sessionId: SESSION,
          facts: factsForWaves([bucketA, bucketB]),
          agentEvents: [],
          semanticEvents: [],
          decisions: [],
        });
        const swapped = clusterSession({
          sessionId: SESSION,
          facts: factsForWaves([bucketB, bucketA]),
          agentEvents: [],
          semanticEvents: [],
          decisions: [],
        });
        expect(groupingKey(forward)).toEqual(groupingKey(swapped));
      }),
      { numRuns: 100 },
    );
  });

  it("idempotent re-attachment: re-feeding the same facts produces the same grouping", () => {
    fc.assert(
      fc.property(bucketSpecArb, (specs) => {
        const facts = specsToFacts(specs);
        const once = clusterSession({
          sessionId: SESSION,
          facts,
          agentEvents: [],
          semanticEvents: [],
          decisions: [],
        });
        const twice = clusterSession({
          sessionId: SESSION,
          facts: [...facts, ...facts.map((entry) => ({ ...entry, factId: `${entry.factId}-dup` }))],
          agentEvents: [],
          semanticEvents: [],
          decisions: [],
        });
        expect(groupingKey(twice)).toEqual(groupingKey(once));
      }),
      { numRuns: 200 },
    );
  });

  it("agentCallIds covers every sourceCallId on a unit's facts, sorted and unique", () => {
    const CALL_IDS = ["turn_1:item_1", "turn_1:item_2", "turn_2:item_1"];
    const provenanceArb = fc.record({
      files: bucketSpecArb,
      calls: fc.array(
        fc.record({
          kind: fc.constantFrom("cmd", "test"),
          callId: fc.option(fc.constantFrom(...CALL_IDS), { nil: undefined }),
          at: fc.integer({ min: 0, max: 19 }),
        }),
        { maxLength: 6 },
      ),
      edits: fc.array(
        fc.record({
          file: fc.constantFrom(...FILE_ALPHABET),
          callId: fc.constantFrom(...CALL_IDS),
          at: fc.integer({ min: 0, max: 19 }),
        }),
        { maxLength: 4 },
      ),
    });
    fc.assert(
      fc.property(provenanceArb, ({ files, calls, edits }) => {
        const facts = specsToFacts(files);
        for (const [index, call] of calls.entries()) {
          const ts = tsOf(0, call.at);
          const base: EvidenceFact =
            call.kind === "cmd" ? commandExecuted(ts) : testResult(ts, { passed: 1 });
          const fact = (
            call.callId === undefined ? base : { ...base, sourceCallId: call.callId }
          ) as EvidenceFact;
          facts.push({ fact, factId: `c${index}`, seq: facts.length + 1, batchId: 0 });
        }
        const result = clusterSession({
          sessionId: SESSION,
          facts,
          agentEvents: edits.map((edit) =>
            agentEvent("file_changed", tsOf(0, edit.at), { path: edit.file, callId: edit.callId }),
          ),
          semanticEvents: [],
          decisions: [],
        });
        for (const unit of result.units) {
          const ids = unit.agentCallIds ?? [];
          expect(ids).toEqual([...new Set(ids)].sort());
          if (unit.agentCallIds !== undefined) expect(ids.length).toBeGreaterThan(0);
          for (const entry of result.unitEvidenceFacts.get(unit.id) ?? []) {
            const fact = entry.fact;
            if (
              (fact.type === "command_executed" || fact.type === "test_result") &&
              fact.sourceCallId !== undefined
            ) {
              expect(ids).toContain(fact.sourceCallId);
            }
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("units always have non-empty files and a valid category", () => {
    fc.assert(
      fc.property(bucketSpecArb, (specs) => {
        const result = clusterSession({
          sessionId: SESSION,
          facts: specsToFacts(specs),
          agentEvents: [],
          semanticEvents: [],
          decisions: [],
        });
        for (const unit of result.units) {
          expect(unit.files.length).toBeGreaterThan(0);
          expect(["behavior", "architecture", "api", "schema", "dependency", "security", "configuration", "performance", "implementation", "tests", "documentation"]).toContain(unit.category);
          expect(unit.title.startsWith("Changed ")).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });
});
