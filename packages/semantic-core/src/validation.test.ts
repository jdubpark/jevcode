import { describe, expect, it } from "vitest";

import { testResult, tsOf, SESSION } from "./test-helpers.js";
import { extractTestResult } from "./validation.js";

describe("validation extraction", () => {
  it("keys validations by runner+command+ts", () => {
    const fact = testResult(tsOf(0), { passed: 3, failed: 1, failures: [{ file: "tests/a.test.ts", testName: "t", message: "m" }] });
    const first = extractTestResult(fact, SESSION);
    const second = extractTestResult(fact, SESSION);
    expect(first.validation.id).toBe(second.validation.id);
  });

  it("uses a distinct key per runner, command, and timestamp", () => {
    const base = testResult(tsOf(0), {});
    const otherRunner = testResult(tsOf(0), { runner: "jest" });
    const otherCommand = testResult(tsOf(0), { command: "pnpm test:unit" });
    const otherTs = testResult(tsOf(0, 1), {});
    const ids = new Set([
      extractTestResult(base, SESSION).validation.id,
      extractTestResult(otherRunner, SESSION).validation.id,
      extractTestResult(otherCommand, SESSION).validation.id,
      extractTestResult(otherTs, SESSION).validation.id,
    ]);
    expect(ids.size).toBe(4);
  });

  it("marks status failed when any test fails", () => {
    const passed = extractTestResult(testResult(tsOf(0), { passed: 5 }), SESSION);
    const failed = extractTestResult(testResult(tsOf(0), { passed: 5, failed: 1, failures: [{ file: "f", testName: "t", message: "m" }] }), SESSION);
    expect(passed.validation.status).toBe("passed");
    expect(failed.validation.status).toBe("failed");
  });

  it("extracts one failure row per failing test", () => {
    const fact = testResult(tsOf(0), {
      failed: 2,
      failures: [
        { file: "tests/a.test.ts", testName: "one", message: "m1" },
        { file: "tests/b.test.ts", testName: "two", message: "m2" },
      ],
    });
    const result = extractTestResult(fact, SESSION);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]?.validationId).toBe(result.validation.id);
    expect(result.failures[0]?.file).toBe("tests/a.test.ts");
  });
});
