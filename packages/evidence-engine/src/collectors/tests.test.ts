import { describe, expect, it } from "vitest";

import {
  createTestCollector,
  detectTestRunner,
  parseTestOutput,
} from "./tests.js";

const VITEST_OUTPUT = `
 RUN  v3.0.5 /srv/repo/rate-limit

 ✓ src/ok.test.ts (2 tests) 3ms
 ❯ src/bad.test.ts (2 tests | 1 failed) 5ms
   × sums two numbers 2ms

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯

FAIL  src/bad.test.ts > sums two numbers
AssertionError: expected 2 to be 3
 ❯ src/bad.test.ts:4:15
    2|   const result = sum(1, 1)

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 2 passed (3)
   Start at  09:15:00
   Duration  412ms
`;

const VITEST_ALL_GREEN = `
 Test Files  2 passed (2)
      Tests  4 passed (4)
`;

const JEST_OUTPUT = `
PASS  src/ok.test.ts
  ✓ adds positive numbers

FAIL  src/bad.test.ts
  ● adds positive numbers
    expect(received).toBe(expected)

    Expected: 3
    Received: 2

  ● divides
    division by zero is undefined

Test Suites: 1 failed, 1 passed, 2 total
Tests:       2 failed, 3 passed, 1 skipped, 6 total
Snapshots:   0 total
Time:        1.2s
`;

const PYTEST_OUTPUT = `
============================= test session starts =============================
platform darwin -- Python 3.12.0, pytest-8.0.0
collected 5 items

tests/test_math.py::test_add PASSED                                    [ 20%]
tests/test_math.py::test_sub PASSED                                    [ 40%]
tests/test_math.py::test_bad FAILED                                    [ 60%]
tests/test_math.py::test_skip SKIPPED (reason)                         [ 80%]
tests/test_math.py::test_mul PASSED                                    [100%]

=================================== FAILURES ===================================
___________________________________ test_bad ___________________________________

    def test_bad():
        assert 2 == 3
>       assert 2 == 3
E       assert 2 == 3

tests/test_math.py:10: AssertionError
=========================== short test summary info ============================
FAILED tests/test_math.py::test_bad - assert 2 == 3
========================= 3 passed, 1 failed, 1 skipped in 1.05s ==========================
`;

describe("detectTestRunner", () => {
  it("detects vitest", () => {
    expect(detectTestRunner(VITEST_OUTPUT)).toBe("vitest");
  });
  it("detects jest", () => {
    expect(detectTestRunner(JEST_OUTPUT)).toBe("jest");
  });
  it("detects pytest", () => {
    expect(detectTestRunner(PYTEST_OUTPUT)).toBe("pytest");
  });
  it("returns null for unrelated text", () => {
    expect(detectTestRunner("some random build output")).toBeNull();
  });
});

describe("parseTestOutput - vitest", () => {
  it("parses counts and failures", () => {
    const parsed = parseTestOutput(VITEST_OUTPUT);
    expect(parsed).not.toBeNull();
    expect(parsed?.runner).toBe("vitest");
    expect(parsed?.passed).toBe(2);
    expect(parsed?.failed).toBe(1);
    expect(parsed?.skipped).toBe(0);
    expect(parsed?.failures).toEqual([
      {
        file: "src/bad.test.ts",
        testName: "sums two numbers",
        message: expect.stringContaining("expected 2 to be 3"),
      },
    ]);
  });

  it("parses all-green output", () => {
    const parsed = parseTestOutput(VITEST_ALL_GREEN);
    expect(parsed?.runner).toBe("vitest");
    expect(parsed?.passed).toBe(4);
    expect(parsed?.failed).toBe(0);
    expect(parsed?.skipped).toBe(0);
    expect(parsed?.failures).toEqual([]);
  });
});

describe("parseTestOutput - jest", () => {
  it("parses counts and failures", () => {
    const parsed = parseTestOutput(JEST_OUTPUT);
    expect(parsed?.runner).toBe("jest");
    expect(parsed?.passed).toBe(3);
    expect(parsed?.failed).toBe(2);
    expect(parsed?.skipped).toBe(1);
    expect(parsed?.failures).toEqual([
      {
        file: "src/bad.test.ts",
        testName: "adds positive numbers",
        message: expect.stringContaining("Expected: 3"),
      },
      {
        file: "src/bad.test.ts",
        testName: "divides",
        message: expect.stringContaining("division by zero"),
      },
    ]);
  });
});

describe("parseTestOutput - pytest", () => {
  it("parses counts and failures", () => {
    const parsed = parseTestOutput(PYTEST_OUTPUT);
    expect(parsed?.runner).toBe("pytest");
    expect(parsed?.passed).toBe(3);
    expect(parsed?.failed).toBe(1);
    expect(parsed?.skipped).toBe(1);
    expect(parsed?.failures).toEqual([
      {
        file: "tests/test_math.py",
        testName: "test_bad",
        message: "assert 2 == 3",
      },
    ]);
  });
});

describe("parseTestOutput - forced runner", () => {
  it("uses the forced runner parser", () => {
    const parsed = parseTestOutput("Tests:       0 failed, 1 passed, 0 total", "jest");
    expect(parsed?.runner).toBe("jest");
    expect(parsed?.passed).toBe(1);
  });
});

describe("createTestCollector", () => {
  it("emits a test_result fact", () => {
    const collector = createTestCollector("/repo", {
      repoId: "repo-1",
      sessionId: "sess-1",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    const fact = collector.collect(JEST_OUTPUT, "pnpm test");
    expect(fact).toMatchObject({
      type: "test_result",
      repoId: "repo-1",
      sessionId: "sess-1",
      runner: "jest",
      command: "pnpm test",
      passed: 3,
      failed: 2,
      skipped: 1,
    });
    expect(collector.facts).toHaveLength(1);
  });

  it("does not emit for unparseable output", () => {
    const collector = createTestCollector("/repo", {
      repoId: "repo-1",
      sessionId: "sess-1",
    });
    expect(collector.collect("random text", "pnpm test")).toBeNull();
    expect(collector.facts).toHaveLength(0);
  });
});
