import { describe, expect, it, vi } from "vitest";

vi.mock("@jevcode/evidence-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@jevcode/evidence-engine")>();
  return {
    ...actual,
    createTestCollector: vi.fn(() => ({
      sink: { push: () => {} },
      facts: [],
      collect: vi.fn(() => null),
    })),
  };
});

import { createTestCollector } from "@jevcode/evidence-engine";

import { createEvidenceSession } from "./evidence-runtime.js";

describe("createEvidenceSession", () => {
  it("hoists one TestCollector per evidence session", () => {
    const createTestCollectorMock = vi.mocked(createTestCollector);
    const session = createEvidenceSession({
      repoId: "repo-1",
      sessionId: "sess-1",
      repoPath: "/tmp/jevcode-evidence-test",
      sink: { push: () => {} },
    });
    session.observeTestOutput("pnpm test", "Tests  1 passed (1)\n");
    session.observeTestOutput("pnpm test", "Tests  2 passed (2)\n");
    expect(createTestCollectorMock).toHaveBeenCalledTimes(1);
  });
});
