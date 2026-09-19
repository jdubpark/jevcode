import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseReplayLine, PipelineCoordinator } from "./coordinator.js";
import type { ChangeUnit, EvidenceFact } from "@jevcode/contracts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HERE, "../../../fixtures");
const SCENARIOS = ["oauth", "rate-limit", "schema-change", "api-break", "dep-change"];

interface ExpectedUnit {
  id: string;
  title: string;
  category: string;
  files: string[];
  symbolNames: string[];
}

interface FixtureRun {
  scenario: string;
  units: ChangeUnit[];
  expected: ExpectedUnit[];
  facts: EvidenceFact[];
}

function runFixture(scenario: string): FixtureRun {
  const eventsPath = path.join(FIXTURES_DIR, scenario, "events.jsonl");
  const lines = readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
  const coordinator = new PipelineCoordinator();
  const facts: EvidenceFact[] = [];
  for (const line of lines) {
    const record = parseReplayLine(line);
    if (record === null) continue;
    if ("type" in record && "repoId" in record) facts.push(record as EvidenceFact);
    coordinator.ingest(record);
  }
  coordinator.flush();
  const units = coordinator.snapshot().units;
  const expected = JSON.parse(
    readFileSync(path.join(FIXTURES_DIR, scenario, "expected_units.json"), "utf8"),
  ) as ExpectedUnit[];
  return { scenario, units, expected, facts };
}

function sameFileSet(a: readonly string[], b: readonly string[]): boolean {
  const keyA = [...a].sort().join("|");
  const keyB = [...b].sort().join("|");
  return keyA === keyB;
}

function sameSymbolSet(a: readonly string[], b: readonly string[]): boolean {
  return [...a].sort().join("|") === [...b].sort().join("|");
}

function isFormattingOnlyFile(file: string, facts: readonly EvidenceFact[]): boolean {
  const hunks = facts.filter(
    (fact): fact is Extract<EvidenceFact, { type: "git_hunk" }> => fact.type === "git_hunk" && fact.file === file,
  );
  const hasSymbols = facts.some((fact) => fact.type === "symbol_delta" && fact.path === file);
  return hunks.length > 0 && hunks.every((hunk) => hunk.isFormattingOnly) && !hasSymbols;
}

describe("fixture replay through coordinator + clustering", () => {
  for (const scenario of SCENARIOS) {
    it(`groups ${scenario} facts into the expected ChangeUnits`, () => {
      const { units, expected, facts } = runFixture(scenario);
      const unmatched: ExpectedUnit[] = [];
      const consumedUnitIds = new Set<string>();
      const mappings: string[] = [];
      for (const expectedUnit of expected) {
        const match = units.find(
          (unit) =>
            !consumedUnitIds.has(unit.id) &&
            sameFileSet(unit.files, expectedUnit.files) &&
            unit.category === expectedUnit.category,
        );
        if (match === undefined) {
          unmatched.push(expectedUnit);
          continue;
        }
        consumedUnitIds.add(match.id);
        mappings.push(`${expectedUnit.id} -> ${match.id}`);
        const symbolMismatch = !sameSymbolSet(
          expectedUnit.symbolNames,
          match.symbols.map((symbol) => symbol.name),
        );
        expect(
          symbolMismatch,
          `${scenario}/${expectedUnit.id}: symbol mismatch: expected ${JSON.stringify(expectedUnit.symbolNames)} got ${JSON.stringify(match.symbols.map((s) => s.name))}`,
        ).toBe(false);
      }
      const extras = units.filter((unit) => !consumedUnitIds.has(unit.id));
      const unexpectedExtras = extras.filter(
        (unit) => !unit.files.every((file) => isFormattingOnlyFile(file, facts)),
      );
      expect(
        unmatched,
        `${scenario}: expected units not produced: ${unmatched.map((u) => `${u.id} (${u.category}: ${u.files.join(",")})`).join("; ")}`,
      ).toEqual([]);
      expect(
        unexpectedExtras,
        `${scenario}: unexpected non-formatting units produced: ${unexpectedExtras.map((u) => `${u.category}: ${u.files.join(",")}`).join("; ")}`,
      ).toEqual([]);
      const formattingExtras = extras.filter((unit) =>
        unit.files.every((file) => isFormattingOnlyFile(file, facts)),
      );
      console.log(
        `[fixtures] ${scenario}: ${expected.length} expected units, ${units.length} produced, matched=${mappings.length}, formatting-only extras=${formattingExtras.map((u) => u.files.join(",")).join(" ") || "none"}`,
      );
    });
  }
});
