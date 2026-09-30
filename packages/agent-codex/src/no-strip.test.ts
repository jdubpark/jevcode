import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { canonicalJson, NormalizedAgentEventSchema } from "@jevcode/contracts";
import { defaultNormalizerContext } from "@jevcode/agent-core";

import { mapCodexJsonlEvent } from "./jsonl.js";

const FIXTURES_DIR = fileURLToPath(new URL("../test/fixtures/", import.meta.url));
const JSONL_FIXTURES = readdirSync(FIXTURES_DIR).filter((name) => name.endsWith(".jsonl"));

describe("mapped Codex events survive NormalizedAgentEventSchema unchanged", () => {
  for (const name of JSONL_FIXTURES) {
    it(`keeps every field mapped from ${name}`, () => {
      const ctx = { ...defaultNormalizerContext("s1"), turnId: "turn_guard" };
      const events = readFileSync(`${FIXTURES_DIR}${name}`, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .flatMap((line) => mapCodexJsonlEvent(JSON.parse(line), ctx));
      for (const event of events) {
        expect(canonicalJson(NormalizedAgentEventSchema.parse(event))).toBe(canonicalJson(event));
      }
    });
  }
});
