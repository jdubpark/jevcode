import {
  ChangeUnitSchema,
  DecisionSchema,
  EvidenceFactSchema,
  JevDecisionLogSchema,
  NormalizedAgentEventSchema,
  ValidationResultSchema,
} from "@jevcode/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { FIXTURE_NAMES, loadFixtureTrace } from "../test-support/fixture-rows.js";
import { syntheticRows } from "../test-support/synthetic-rows.js";
import { exactGuard } from "./exact-guard.js";

const SCHEMAS: Record<string, z.ZodTypeAny> = {
  agent_event: NormalizedAgentEventSchema,
  evidence_fact: EvidenceFactSchema,
  validation: ValidationResultSchema,
  change_unit: ChangeUnitSchema,
  decision: DecisionSchema,
  jev_decision: JevDecisionLogSchema,
};

const samples: { type: string; payload: unknown }[] = [
  ...FIXTURE_NAMES.flatMap((name) => loadFixtureTrace(name).rows),
  ...syntheticRows(3_000),
].filter((row) => SCHEMAS[row.type] !== undefined).map((row) => ({ type: row.type, payload: row.payload }));

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const DELETE = Symbol("delete");
const VALUES: readonly (Json | typeof DELETE)[] = [
  DELETE, "", "x", 0, -1, 1.5, 2, 1e21, null, true, [], {}, [""], ["x"], { a: 1 }, [{}], "added", "function",
];

/** Every container path in a JSON value, root first. */
function paths(value: unknown, at: (string | number)[] = []): (string | number)[][] {
  if (value === null || typeof value !== "object") return [at];
  const children = Array.isArray(value)
    ? value.flatMap((item, i) => paths(item, [...at, i]))
    : Object.entries(value).flatMap(([key, item]) => paths(item, [...at, key]));
  return [at, ...children];
}

function mutate(value: unknown, path: readonly (string | number)[], replacement: Json | typeof DELETE, addKey: boolean): unknown {
  if (path.length === 0 || value === undefined) return replacement === DELETE ? undefined : replacement;
  const copy = JSON.parse(JSON.stringify(value)) as unknown;
  let parent = copy as Record<string | number, unknown>;
  for (const step of path.slice(0, -1)) parent = parent[step] as Record<string | number, unknown>;
  const last = path[path.length - 1] as string | number;
  if (replacement === DELETE) {
    if (Array.isArray(parent)) parent.splice(Number(last), 1);
    else delete parent[last];
  } else {
    parent[last] = replacement;
  }
  if (addKey && !Array.isArray(parent)) Object.assign(parent, JSON.parse('{"__proto__": 1, "zz": 2}') as object);
  return copy;
}

describe("exactGuard: a fast path that never accepts what zod would reject or reshape", () => {
  it("accepts every fixture and synthetic change_unit payload, so the fast path is taken", () => {
    const guard = exactGuard(ChangeUnitSchema);
    const units = samples.filter((sample) => sample.type === "change_unit");
    expect(units.length).toBeGreaterThan(50);
    for (const unit of units) expect(guard(unit.payload)).toBe(true);
  });

  it("guard(x) implies zod accepts x and parses it to a deep-equal copy, for mutated payloads of every row type", () => {
    let accepted = 0;
    fc.assert(
      fc.property(
        fc.nat({ max: samples.length - 1 }),
        fc.array(fc.tuple(fc.nat(), fc.nat({ max: VALUES.length - 1 }), fc.boolean()), { minLength: 0, maxLength: 3 }),
        (sampleIndex, mutations) => {
          const sample = samples[sampleIndex];
          const schema = sample === undefined ? undefined : SCHEMAS[sample.type];
          if (sample === undefined || schema === undefined) return;
          let value = sample.payload;
          for (const [pathIndex, valueIndex, addKey] of mutations) {
            const all = paths(value);
            value = mutate(value, all[pathIndex % all.length] ?? [], VALUES[valueIndex] ?? null, addKey);
          }
          if (!exactGuard(schema)(value)) return;
          accepted += 1;
          const parsed = schema.safeParse(value);
          expect(parsed.success).toBe(true);
          expect(parsed.data).toStrictEqual(value);
        },
      ),
      { numRuns: 3_000 },
    );
    // Not vacuous: unmutated and harmlessly mutated payloads take the fast path.
    expect(accepted).toBeGreaterThan(300);
  });

  it("refuses schemas it cannot mirror exactly (effects, defaults, unions), so zod decides", () => {
    expect(exactGuard(z.string().transform((s) => s.length))("x")).toBe(false);
    expect(exactGuard(z.object({ a: z.string().default("d") }))({ a: "x" })).toBe(false);
    expect(exactGuard(z.union([z.string(), z.number()]))("x")).toBe(false);
    expect(exactGuard(z.string().email())("a@b.c")).toBe(false);
    expect(exactGuard(z.object({ a: z.string() }).passthrough())({ a: "x" })).toBe(false);
  });

  it("mirrors string, number, array, enum, optional and record checks", () => {
    const schema = z.object({
      s: z.string().min(1).max(3),
      n: z.number().int().nonnegative(),
      f: z.number().min(0).max(1).optional(),
      e: z.enum(["a", "b"]),
      l: z.array(z.string()).max(2),
      r: z.record(z.string(), z.string()),
    });
    const guard = exactGuard(schema);
    const ok = { s: "ab", n: 3, e: "a", l: ["x"], r: { k: "v" } };
    expect(guard(ok)).toBe(true);
    for (const bad of [
      { ...ok, s: "" }, { ...ok, s: "abcd" }, { ...ok, n: 1.5 }, { ...ok, n: -1 }, { ...ok, n: Number.NaN }, { ...ok, f: 1.5 },
      { ...ok, e: "c" }, { ...ok, l: ["x", "y", "z"] }, { ...ok, r: { k: 1 } }, { ...ok, extra: 1 }, { s: "ab" },
      Object.assign(Object.create({ inherited: 1 }) as object, ok), null, [ok],
    ]) {
      expect(guard(bad)).toBe(false);
    }
    expect(guard({ ...ok, f: 0.5 })).toBe(true);
  });

  it("keeps every array bound when .length(n) is combined with .min() or .max()", () => {
    expect(exactGuard(z.array(z.string()).min(1).length(3))(["a", "b"])).toBe(false);
    expect(exactGuard(z.array(z.string()).max(5).length(3))(["a", "b", "c", "d"])).toBe(false);
    expect(exactGuard(z.array(z.string()).min(1).length(3))(["a", "b", "c"])).toBe(true);
  });

  it("agrees with zod on string arrays around any mix of min, max and length bounds", () => {
    const bound = fc.option(fc.nat({ max: 5 }), { nil: undefined });
    fc.assert(
      fc.property(bound, bound, bound, fc.array(fc.constantFrom("a", "b"), { maxLength: 7 }), (min, max, length, value) => {
        let schema = z.array(z.string());
        if (min !== undefined) schema = schema.min(min);
        if (max !== undefined) schema = schema.max(max);
        if (length !== undefined) schema = schema.length(length);
        expect(exactGuard(schema)(value)).toBe(schema.safeParse(value).success);
      }),
      { numRuns: 2_000 },
    );
  });
});
