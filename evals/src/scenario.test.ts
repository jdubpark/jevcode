import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { ChangeUnit, SymbolRef } from "@jevcode/contracts";
import {
  attentionInputFromChangeUnit,
  collectAttentionHints,
  type SessionContext,
} from "@jevcode/jev-router";

import {
  SCENARIOS,
  buildAttentionInputs,
  loadScenario,
  parseEventsJsonl,
} from "./scenario.js";

const fixturesDir = fileURLToPath(new URL("../../fixtures", import.meta.url));

describe("scenario loading", () => {
  it("parses every record type in the dep-change stream", () => {
    const data = loadScenario(path.join(fixturesDir, "dep-change"), "dep-change");
    expect(data.stream.agentEvents.length).toBeGreaterThan(0);
    expect(data.stream.facts.length).toBeGreaterThan(0);
    expect(data.expectedUnits.map((unit) => unit.id)).toEqual([
      "dep-zod-add",
      "dep-zod-impl",
      "dep-zod-lockfile",
      "dep-format-noise",
    ]);
    expect(data.attentionLabels["dep-format-noise"]?.shouldSurface).toBe(false);
    expect(data.projectionLabels["dep-format-noise"]).toBeUndefined();
  });

  it("parses semantic events and decisions in the oauth stream", () => {
    const data = loadScenario(path.join(fixturesDir, "oauth"), "oauth");
    expect(data.stream.semanticEvents.length).toBe(2);
    expect(data.stream.decisions.length).toBe(2);
    expect(data.stream.decisions.every((decision) => decision.id === "dec-oauth-0001")).toBe(true);
  });

  it("rejects streams with unknown record types", () => {
    const data = loadScenario(path.join(fixturesDir, "dep-change"), "dep-change");
    const text = `${JSON.stringify(data.stream.agentEvents[0])}\n{"type":"unknown_thing"}`;
    expect(() => parseEventsJsonl(text)).toThrow(/line 2/);
  });
});

describe("attention input construction", () => {
  it("marks the formatting-only unit as formatting and suppressed-capable", () => {
    const data = loadScenario(path.join(fixturesDir, "dep-change"), "dep-change");
    const inputs = buildAttentionInputs(data);
    const noise = inputs.find((input) => input.changeUnitId === "dep-format-noise");
    const zod = inputs.find((input) => input.changeUnitId === "dep-zod-add");
    expect(noise).toBeDefined();
    expect(zod).toBeDefined();
    expect(noise?.hints.formattingOnly).toBe(true);
    expect(noise?.hints.lockfileOnly).toBe(false);
    expect(zod?.hints.formattingOnly).toBe(false);
    expect(zod?.hints.lockfileOnly).toBe(false);
  });

  it("extracts dependency changes for the zod-add unit only", () => {
    const data = loadScenario(path.join(fixturesDir, "dep-change"), "dep-change");
    const inputs = buildAttentionInputs(data);
    const zod = inputs.find((input) => input.changeUnitId === "dep-zod-add");
    const noise = inputs.find((input) => input.changeUnitId === "dep-format-noise");
    expect(zod?.hints.dependencyChanges.map((item) => item.name).sort()).toEqual([
      "axios",
      "zod",
    ]);
    expect(noise?.hints.dependencyChanges).toEqual([]);
  });

  it("detects security paths on the oauth identity unit", () => {
    const data = loadScenario(path.join(fixturesDir, "oauth"), "oauth");
    const inputs = buildAttentionInputs(data);
    const identity = inputs.find(
      (input) => input.changeUnitId === "oauth-identity-layer",
    );
    expect(identity?.hints.securityPaths.length).toBeGreaterThan(0);
  });

  it("detects schema paths on the schema-change unit", () => {
    const data = loadScenario(path.join(fixturesDir, "schema-change"), "schema-change");
    const inputs = buildAttentionInputs(data);
    const migration = inputs.find(
      (input) => input.changeUnitId === "schema-users-migration",
    );
    expect(migration?.hints.schemaPaths).toContain("migrations/001_alter_users.sql");
  });

  it("marks units containing failing test files as failed", () => {
    const data = loadScenario(path.join(fixturesDir, "api-break"), "api-break");
    const inputs = buildAttentionInputs(data);
    expect(
      inputs.every((input) => input.status === "failed"),
    ).toBe(true);
  });

  it("links the rate-limit decision to the fail-open unit via evidence", () => {
    const data = loadScenario(path.join(fixturesDir, "rate-limit"), "rate-limit");
    const inputs = buildAttentionInputs(data);
    const failOpen = inputs.find(
      (input) => input.changeUnitId === "rate-limit-fail-open-decision",
    );
    const architecture = inputs.find(
      (input) => input.changeUnitId === "rate-limit-architecture",
    );
    expect(failOpen?.hints.decisionIds).toEqual(["dec-ratelimit-0001"]);
    expect(architecture?.hints.decisionIds).toEqual([]);
  });

  it("links the oauth decision to the account-linking unit via evidence", () => {
    const data = loadScenario(path.join(fixturesDir, "oauth"), "oauth");
    const inputs = buildAttentionInputs(data);
    const decision = inputs.find(
      (input) => input.changeUnitId === "oauth-account-linking-decision",
    );
    const identity = inputs.find(
      (input) => input.changeUnitId === "oauth-identity-layer",
    );
    expect(decision?.hints.decisionIds).toEqual(["dec-oauth-0001"]);
    expect(identity?.hints.decisionIds).toEqual([]);
  });

  it("attributes failing test results per unit", () => {
    const data = loadScenario(path.join(fixturesDir, "oauth"), "oauth");
    const inputs = buildAttentionInputs(data);
    const failure = inputs.find(
      (input) => input.changeUnitId === "oauth-linking-test-failure",
    );
    const identity = inputs.find(
      (input) => input.changeUnitId === "oauth-identity-layer",
    );
    expect(failure?.hints.testResults).toHaveLength(1);
    expect(failure?.hints.testResults[0]?.failureFiles).toEqual([
      "tests/auth/oauth.test.ts",
    ]);
    expect(identity?.hints.testResults).toHaveLength(0);
  });
});

describe("hint parity with the jev-router pipeline", () => {
  it("derives identical evidence hints for every fixture unit", () => {
    for (const name of SCENARIOS) {
      const data = loadScenario(path.join(fixturesDir, name), name);
      const evalsInputs = buildAttentionInputs(data);
      for (let index = 0; index < data.expectedUnits.length; index += 1) {
        const expected = data.expectedUnits[index];
        const input = evalsInputs[index];
        if (expected === undefined || input === undefined) {
          throw new Error(`missing input for scenario ${name} unit ${index}`);
        }
        const symbols: SymbolRef[] = expected.symbolNames.map((symbolName) => ({
          id: `sym-${symbolName}`,
          name: symbolName,
          path: expected.files[0] ?? "src/unknown.ts",
          kind: "function",
        }));
        const unit: ChangeUnit = {
          id: expected.id,
          sessionId: input.sessionId,
          title: expected.title,
          category: expected.category,
          status: input.status,
          files: [...expected.files],
          symbols,
          interfacesChanged: [],
          schemaChanges: [],
          dependencyChanges: [],
          relatedDecisions: [],
          validationResults: [],
          evidence: [],
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        };
        const sessionCtx: SessionContext = {
          sessionId: input.sessionId,
          taskPrompt: input.taskPrompt,
          facts: data.stream.facts,
        };
        const routed = attentionInputFromChangeUnit(unit, sessionCtx, 1);

        const shared = collectAttentionHints(expected.files, data.stream.facts);
        for (const key of Object.keys(shared) as (keyof typeof shared)[]) {
          expect(input.hints[key], `${name} ${expected.id} ${key} (evals)`).toEqual(
            shared[key],
          );
          expect(
            routed.hints[key],
            `${name} ${expected.id} ${key} (pipeline)`,
          ).toEqual(shared[key]);
        }

        expect(routed.hints, `${name} ${expected.id} full hints`).toEqual({
          ...input.hints,
          behaviorChange: routed.hints.behaviorChange,
          interfacesChanged: routed.hints.interfacesChanged,
          decisionIds: routed.hints.decisionIds,
        });
      }
    }
  });
});
