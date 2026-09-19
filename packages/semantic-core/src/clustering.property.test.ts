import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { clusterSession, type SequencedFact } from "./clustering.js";
import { fileChanged, hunk, SESSION, symbolDelta, tsOf } from "./test-helpers.js";

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
