import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { EvidenceFact } from "@jevcode/contracts";
import {
  createTreeSitterBackend,
  type TreeSitterBackend,
} from "@jevcode/evidence-engine";

import { attentionInputFromChangeUnit } from "./state.js";
import type { SessionContext } from "./types.js";
import { makeUnit, SESSION_ID } from "./testing/inputs.js";

const API_SOURCE = `export function getUser(): string {
  return "u";
}
const internal = 1;
export { internal as LIMIT };
`;

const CONSUMER_SOURCE = `import { getUser } from "./api";
import { getUser as fetchUser } from "./api";
void getUser;
void fetchUser;
`;

describe("publicExports derivation against real tree-sitter parse output", () => {
  let backend: TreeSitterBackend | null = null;

  beforeAll(async () => {
    try {
      backend = await createTreeSitterBackend();
    } catch (error) {
      console.warn(
        `[jev-router] tree-sitter backend unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  afterAll(async () => {
    await backend?.dispose();
  });

  it("detects exported bindings imported (with alias) by another module", (ctx) => {
    if (!backend) {
      console.warn("[jev-router] skipping tree-sitter integration test: backend unavailable");
      ctx.skip();
      return;
    }
    const apiSymbols = backend.parse(API_SOURCE, "typescript");
    const consumerSymbols = backend.parse(CONSUMER_SOURCE, "typescript");
    expect(
      apiSymbols.some((s) => s.kind === "export" && s.name === "getUser"),
    ).toBe(true);
    expect(
      consumerSymbols.some(
        (s) => s.kind === "import" && s.name === "fetchUser",
      ),
    ).toBe(true);

    const facts: EvidenceFact[] = [
      {
        type: "symbol_delta",
        repoId: "repo-test",
        sessionId: SESSION_ID,
        ts: "2026-09-19T10:00:00.000Z",
        path: "src/api.ts",
        added: apiSymbols,
        removed: [],
        modified: [],
      },
      {
        type: "symbol_delta",
        repoId: "repo-test",
        sessionId: SESSION_ID,
        ts: "2026-09-19T10:00:01.000Z",
        path: "src/consumer.ts",
        added: consumerSymbols,
        removed: [],
        modified: [],
      },
    ];
    const sessionCtx: SessionContext = {
      sessionId: SESSION_ID,
      taskPrompt: "Refactor the api module",
      facts,
    };
    const input = attentionInputFromChangeUnit(
      makeUnit({ files: ["src/api.ts"] }),
      sessionCtx,
      1,
    );
    expect(input.hints.publicExports).toEqual(["getUser"]);
  });
});
